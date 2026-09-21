import COpus
import Foundation

final class AudioSession {
    static let maxPacketBytes = 4_096
    static let maxFrameSamples = 5_760
    static let outputTailGuardMilliseconds = 350

    let device: VirtualAudioDevice
    private var decoder: OpaquePointer?
    private let output: VirtualAudioOutput
    private(set) var packets: Int64 = 0
    private var closed = false
    var onFault: ((String) -> Void)? {
        get { output.onFault }
        set { output.onFault = newValue }
    }

    init(device: VirtualAudioDevice) throws {
        self.device = device
        output = try VirtualAudioOutput(device: device)
        do { decoder = try Self.makeDecoder() }
        catch { output.close(); throw error }
    }

    var bufferedMilliseconds: Int { output.bufferedMilliseconds }

    func append(packet: Data) throws -> [String: Any] {
        guard !closed, let decoder else { throw AudioBridgeError("Audio session is not active.") }
        guard !packet.isEmpty, packet.count <= Self.maxPacketBytes else {
            throw AudioBridgeError("Opus packet must contain 1..4096 bytes.")
        }
        var pcm = Array(repeating: Int16(0), count: Self.maxFrameSamples)
        let decoded: Int32 = packet.withUnsafeBytes { packetBytes in
            pcm.withUnsafeMutableBufferPointer { pcmBytes in
                opus_decode(
                    decoder,
                    packetBytes.bindMemory(to: UInt8.self).baseAddress,
                    Int32(packet.count),
                    pcmBytes.baseAddress,
                    Int32(Self.maxFrameSamples),
                    0
                )
            }
        }
        guard decoded > 0, Int(decoded) <= Self.maxFrameSamples else {
            throw AudioBridgeError("Invalid Opus packet.")
        }
        let sampleCount = Int(decoded)
        do { try output.append(samples: pcm, count: sampleCount) }
        catch { close(); throw error }
        let peak = pcm.prefix(sampleCount).reduce(0) { current, sample in
            max(current, abs(Int(sample)))
        }
        packets += 1
        return [
            "packets": packets,
            "samples": sampleCount,
            "peak": Double(peak) / 32_768.0,
            "bufferedMs": bufferedMilliseconds
        ]
    }

    func stopAfterDrain(shouldCancel: () -> Bool = { false }) throws -> [String: Any] {
        guard !closed else { throw AudioBridgeError("Audio session is not active.") }
        let initialBuffered = bufferedMilliseconds
        guard output.waitUntilDrained(timeoutMilliseconds: VirtualAudioOutput.maxBufferedMilliseconds + 350, shouldCancel: shouldCancel) else {
            close()
            throw AudioBridgeError("Timed out while draining the PCM buffer; the session was cancelled.")
        }
        let deadline = ProcessInfo.processInfo.systemUptime + Double(Self.outputTailGuardMilliseconds) / 1_000.0
        while ProcessInfo.processInfo.systemUptime < deadline {
            if shouldCancel() { close(); throw AudioBridgeError("Audio input closed during drain.") }
            do { try output.validateRoute() }
            catch { close(); throw error }
            Thread.sleep(forTimeInterval: 0.01)
        }
        close()
        return ["drained": true, "initialBufferedMs": initialBuffered]
    }

    func discard() throws -> [String: Any] {
        guard !closed else { throw AudioBridgeError("Audio session is not active.") }
        try output.discardAndKeepReady()
        if let decoder { opus_decoder_destroy(decoder) }
        decoder = nil
        decoder = try Self.makeDecoder()
        packets = 0
        return [
            "discarded": true, "ready": true, "active": false,
            "packets": 0, "samples": 0, "peak": 0, "bufferedMs": 0
        ]
    }

    func close() {
        guard !closed else { return }
        closed = true
        output.close()
        if let decoder { opus_decoder_destroy(decoder) }
        decoder = nil
    }

    private static func makeDecoder() throws -> OpaquePointer {
        var error: Int32 = 0
        guard let decoder = opus_decoder_create(
            Int32(VirtualAudioOutput.sampleRate), Int32(VirtualAudioOutput.channels), &error
        ), error == 0 else {
            let description = String(cString: opus_strerror(error))
            throw AudioBridgeError("Unable to create Opus decoder: \(description)")
        }
        return decoder
    }

    deinit { close() }
}
