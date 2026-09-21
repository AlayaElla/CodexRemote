import AudioToolbox
import AVFoundation
import Foundation

final class VirtualAudioOutput {
    static let sampleRate = 16_000
    static let channels = 1
    static let maxBufferedMilliseconds = 2_000

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let sourceFormat: AVAudioFormat
    private let state = NSLock()
    private var queuedFrames = 0
    private var generation: UInt64 = 0
    private var stopped = false
    private let deviceID: AudioDeviceID
    private var configurationObserver: NSObjectProtocol?
    private var routeError: String?
    private var faultHandler: ((String) -> Void)?
    var onFault: ((String) -> Void)? {
        get { state.lock(); defer { state.unlock() }; return faultHandler }
        set { state.lock(); faultHandler = newValue; state.unlock() }
    }

    init(device: VirtualAudioDevice) throws {
        deviceID = device.audioDeviceID
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(Self.sampleRate),
            channels: AVAudioChannelCount(Self.channels),
            interleaved: false
        ) else {
            throw AudioBridgeError("Unable to create the 16 kHz mono PCM format.")
        }
        sourceFormat = format
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: sourceFormat)

        guard let audioUnit = engine.outputNode.audioUnit else {
            throw AudioBridgeError("CoreAudio output unit is unavailable.")
        }
        var selected = device.audioDeviceID
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &selected,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        guard status == noErr else {
            throw AudioBridgeError("Unable to select \(device.name) (CoreAudio \(status)).")
        }

        engine.prepare()
        do {
            try engine.start()
            try validateRoute()
            player.play()
        } catch {
            player.stop()
            engine.stop()
            engine.detach(player)
            throw AudioBridgeError("Unable to start CoreAudio output: \(error.localizedDescription)")
        }
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            self.state.lock()
            let notify = !self.stopped && self.routeError == nil
            self.routeError = "CoreAudio configuration changed; reconnect the selected BlackHole device."
            let message = self.routeError!
            self.state.unlock()
            if notify { self.onFault?(message) }
        }
    }

    var bufferedMilliseconds: Int {
        state.lock()
        defer { state.unlock() }
        return min(Self.maxBufferedMilliseconds, queuedFrames * 1_000 / Self.sampleRate)
    }

    func append(samples: [Int16], count: Int) throws {
        try validateRoute()
        guard count > 0, count <= samples.count else {
            throw AudioBridgeError("Decoded PCM frame is invalid.")
        }
        state.lock()
        let nextFrames = queuedFrames + count
        if stopped || nextFrames * 1_000 > Self.sampleRate * Self.maxBufferedMilliseconds {
            state.unlock()
            throw AudioBridgeError(stopped
                ? "Audio output is closed."
                : "PCM buffer is full; the audio session was cancelled.")
        }
        queuedFrames = nextFrames
        let scheduledGeneration = generation
        state.unlock()

        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: sourceFormat,
            frameCapacity: AVAudioFrameCount(count)
        ), let destination = buffer.floatChannelData?.pointee else {
            decrementQueuedFrames(count, generation: scheduledGeneration)
            throw AudioBridgeError("Unable to allocate a PCM buffer.")
        }
        buffer.frameLength = AVAudioFrameCount(count)
        for index in 0..<count { destination[index] = Float(samples[index]) / 32_768.0 }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            self?.decrementQueuedFrames(count, generation: scheduledGeneration)
        }
    }

    func waitUntilDrained(timeoutMilliseconds: Int, shouldCancel: () -> Bool) -> Bool {
        let deadline = ProcessInfo.processInfo.systemUptime + Double(timeoutMilliseconds) / 1_000.0
        while ProcessInfo.processInfo.systemUptime < deadline {
            if shouldCancel() || !engine.isRunning { return false }
            do { try validateRoute() } catch { return false }
            if isDrained { return true }
            Thread.sleep(forTimeInterval: 0.01)
        }
        return !shouldCancel() && engine.isRunning && isDrained
    }

    // Do not restart or fall back to the system output if BlackHole disappears.
    func validateRoute() throws {
        state.lock()
        let failure = routeError
        let closed = stopped
        state.unlock()
        if let failure { throw AudioBridgeError(failure) }
        guard !closed, CoreAudioDevices.isAlive(deviceID), let audioUnit = engine.outputNode.audioUnit else {
            throw AudioBridgeError("The selected BlackHole output is unavailable.")
        }
        var current = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioUnitGetProperty(audioUnit, kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global, 0, &current, &size)
        guard status == noErr && current == deviceID else {
            throw AudioBridgeError("CoreAudio output no longer matches the selected BlackHole device.")
        }
    }

    private var isDrained: Bool {
        state.lock()
        defer { state.unlock() }
        return queuedFrames == 0 && !stopped
    }

    func discardAndKeepReady() throws {
        try validateRoute()
        resetQueue(closed: false)
        player.stop()
        player.reset()
        Thread.sleep(forTimeInterval: 0.35)
        try validateRoute()
        guard engine.isRunning else {
            throw AudioBridgeError("CoreAudio output stopped while discarding audio.")
        }
        player.play()
    }

    func close() {
        state.lock()
        guard !stopped else { state.unlock(); return }
        stopped = true
        generation &+= 1
        queuedFrames = 0
        state.unlock()
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
        configurationObserver = nil
        player.stop()
        player.reset()
        engine.stop()
        engine.detach(player)
    }

    private func decrementQueuedFrames(_ count: Int, generation completedGeneration: UInt64) {
        state.lock()
        defer { state.unlock() }
        guard completedGeneration == generation else { return }
        queuedFrames = max(0, queuedFrames - count)
    }

    private func resetQueue(closed: Bool) {
        state.lock()
        generation &+= 1
        queuedFrames = 0
        stopped = closed
        state.unlock()
    }

    deinit { close() }
}
