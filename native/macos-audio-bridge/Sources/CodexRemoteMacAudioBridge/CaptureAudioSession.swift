import AudioToolbox
import AVFoundation
import COpus
import Foundation

// A dedicated BlackHole input receives only the answer render route. Never use
// the default microphone, or share this device with ESP32 microphone injection.
final class CaptureAudioSession {
    let device: VirtualAudioDevice
    let id = UUID().uuidString
    var onAudio: ((Data, Int64) -> Void)?
    var onFault: ((String) -> Void)?
    private let engine = AVAudioEngine()
    private let work = DispatchQueue(label: "codexremote.capture.encode")
    private let capacity = DispatchSemaphore(value: 8)
    private let state = NSLock()
    private var closed = false
    private var tapInstalled = false
    private var observer: NSObjectProtocol?
    private var encoder: OpaquePointer?
    private var converter: AVAudioConverter?
    private var samples: [Float] = []
    private var sequence: Int64 = 0
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!

    init(device: VirtualAudioDevice) throws {
        self.device = device
        var error: Int32 = 0
        encoder = opus_encoder_create(16_000, 1, OPUS_APPLICATION_VOIP, &error)
        guard error == OPUS_OK, encoder != nil else { throw AudioBridgeError("Unable to create answer Opus encoder.") }
    }

    func start() throws {
        let input = engine.inputNode
        guard let unit = input.audioUnit else { throw AudioBridgeError("CoreAudio input unit is unavailable.") }
        var selected = device.audioDeviceID
        let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global, 0, &selected, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard status == noErr else { throw AudioBridgeError("Unable to select answer device (CoreAudio \(status)).") }
        let source = input.outputFormat(forBus: 0)
        guard source.sampleRate > 0, source.channelCount > 0,
              let conversion = AVAudioConverter(from: source, to: format) else {
            throw AudioBridgeError("Answer device has an unsupported PCM format.")
        }
        converter = conversion
        input.installTap(onBus: 0, bufferSize: 1024, format: source) { [weak self] buffer, _ in
            guard let self, self.capacity.wait(timeout: .now()) == .success else { return }
            // AVAudioEngine owns the incoming buffer; copy before leaving its callback.
            guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else {
                self.capacity.signal(); return
            }
            copy.frameLength = buffer.frameLength
            let src = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
            let dst = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
            for index in 0..<src.count {
                if let from = src[index].mData, let to = dst[index].mData {
                    memcpy(to, from, Int(src[index].mDataByteSize))
                }
            }
            self.work.async {
                defer { self.capacity.signal() }
                self.state.lock(); let stopped = self.closed; self.state.unlock()
                if stopped { return }
                do { try self.validateRoute(); try self.encode(copy) }
                catch { self.onFault?(error.localizedDescription) }
            }
        }
        tapInstalled = true
        engine.prepare()
        try engine.start()
        try validateRoute()
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            guard let self else { return }
            self.work.async { [weak self] in
                guard let self else { return }
                self.state.lock(); let stopped = self.closed; self.state.unlock()
                if stopped { return }
                do {
                    try self.validateRoute()
                    guard self.engine.isRunning, let source = self.converter?.inputFormat,
                          self.engine.inputNode.outputFormat(forBus: 0).isEqual(source) else {
                        throw AudioBridgeError("Answer audio device configuration changed; reconnect the call.")
                    }
                } catch { self.onFault?(error.localizedDescription) }
            }
        }
    }

    private func validateRoute() throws {
        guard CoreAudioDevices.isAlive(device.audioDeviceID), let unit = engine.inputNode.audioUnit else {
            throw AudioBridgeError("Answer audio device is unavailable.")
        }
        var current: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &current, &size)
        guard status == noErr, current == device.audioDeviceID else { throw AudioBridgeError("Answer audio route changed.") }
    }

    private func encode(_ buffer: AVAudioPCMBuffer) throws {
        guard let converter, let encoder else { return }
        let size = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16_000 / buffer.format.sampleRate) + 64)
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: size) else { throw AudioBridgeError("Unable to allocate answer PCM.") }
        var supplied = false
        var error: NSError?
        let result = converter.convert(to: output, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return buffer
        }
        guard result != .error, error == nil else { throw AudioBridgeError("Answer resampling failed.") }
        if let pcm = output.floatChannelData?.pointee {
            samples.append(contentsOf: UnsafeBufferPointer(start: pcm, count: Int(output.frameLength)))
        }
        var offset = 0
        while samples.count - offset >= 320 {
            var packet = [UInt8](repeating: 0, count: 4096)
            let count = samples.withUnsafeBufferPointer { pcm in
                packet.withUnsafeMutableBufferPointer { bytes in
                    opus_encode_float(encoder, pcm.baseAddress!.advanced(by: offset), 320, bytes.baseAddress!, 4096)
                }
            }
            guard count > 0 else { throw AudioBridgeError("Answer Opus encoding failed.") }
            sequence += 1
            onAudio?(Data(packet.prefix(Int(count))), sequence)
            offset += 320
        }
        if offset > 0 { samples.removeFirst(offset) }
    }

    func close() {
        state.lock()
        if closed { state.unlock(); return }
        closed = true; state.unlock()
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        engine.stop()
        work.sync {
            if let encoder { opus_encoder_destroy(encoder) }
            encoder = nil; converter = nil; samples.removeAll()
        }
    }
    deinit { close() }
}
