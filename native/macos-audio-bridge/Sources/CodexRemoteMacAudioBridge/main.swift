import Foundation

struct AudioBridgeError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

final class BoundedLineReader {
    private static let maximumBytes = 16 * 1_024
    private let input = FileHandle.standardInput
    private var buffer = Data()

    func next() throws -> String? {
        while true {
            if let newline = buffer.firstIndex(of: 0x0A) {
                var line = Data(buffer[..<newline])
                buffer.removeSubrange(...newline)
                if line.last == 0x0D { line.removeLast() }
                guard line.count <= Self.maximumBytes else {
                    throw AudioBridgeError("JSONL command exceeds 16384 UTF-8 bytes.")
                }
                guard let value = String(data: line, encoding: .utf8) else {
                    throw AudioBridgeError("JSONL command is not valid UTF-8.")
                }
                return value
            }
            guard buffer.count <= Self.maximumBytes else {
                throw AudioBridgeError("JSONL command exceeds 16384 UTF-8 bytes.")
            }
            guard let chunk = try input.read(upToCount: 4_096), !chunk.isEmpty else {
                if buffer.isEmpty { return nil }
                throw AudioBridgeError("stdin ended in a partial JSONL command.")
            }
            buffer.append(chunk)
        }
    }
}

final class AudioBridgeServer {
    private var session: AudioSession?
    private let commands = DispatchQueue(label: "codexremote.audio.commands")
    private let capacity = DispatchSemaphore(value: 128)
    private let termination = NSLock()
    private var terminated = false
    private var stopping: Bool {
        termination.lock()
        defer { termination.unlock() }
        return terminated
    }

    func run() {
        let reader = BoundedLineReader()
        do {
            // Read independently of playback drain, with bounded pending work.
            // EOF interrupts drain even when the writer dies during stop.
            while let line = try reader.next() {
                capacity.wait()
                commands.async {
                    defer { self.capacity.signal() }
                    self.dispatch(line)
                }
            }
        } catch {
            let message = safeError(error)
            commands.async { self.fault(message) }
        }
        termination.lock()
        terminated = true
        termination.unlock()
        commands.sync {
            session?.close()
            session = nil
        }
    }

    private func dispatch(_ line: String) {
        var requestID: String?
        do {
            guard let data = line.data(using: .utf8),
                  let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = root["id"] as? String,
                  !id.isEmpty, id.count <= 128,
                  let operation = root["op"] as? String,
                  !operation.isEmpty, operation.count <= 32 else {
                throw AudioBridgeError("id and op must be bounded strings in a JSON object.")
            }
            requestID = id
            switch operation {
            case "list":
                reply(id: id, ok: true, extra: ["devices": try CoreAudioDevices.virtualCables().map(\.wireValue)])
            case "start": try start(id: id, root: root)
            case "append": try append(id: id, root: root)
            case "stop": try stop(id: id)
            case "cancel": try cancel(id: id)
            case "discard": try discard(id: id)
            default: throw AudioBridgeError("Unsupported audio bridge operation.")
            }
        } catch {
            reply(id: requestID, ok: false, error: safeError(error))
        }
    }

    private func start(id: String, root: [String: Any]) throws {
        guard session == nil else { throw AudioBridgeError("An audio session is already active.") }
        if let value = root["deviceId"], !(value is NSNull), !(value is String) {
            throw AudioBridgeError("deviceId must be a string.")
        }
        let requestedID = (root["deviceId"] as? String) ?? ""
        guard requestedID.count <= 8_192 else { throw AudioBridgeError("deviceId is too long.") }
        let devices = try CoreAudioDevices.virtualCables()
        let selected: VirtualAudioDevice
        if requestedID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guard devices.count == 1 else {
                throw AudioBridgeError(devices.isEmpty
                    ? "No active BlackHole input/output device was found."
                    : "Multiple BlackHole devices found; deviceId is required.")
            }
            selected = devices[0]
        } else {
            guard let device = devices.first(where: { $0.id == requestedID }) else {
                throw AudioBridgeError("Requested deviceId is not an active BlackHole input/output device.")
            }
            selected = device
        }
        guard !stopping else { throw AudioBridgeError("Audio input has closed.") }
        let active = try AudioSession(device: selected)
        session = active
        active.onFault = { [weak self, weak active] error in
            guard let self else { return }
            self.commands.async {
                guard let active, self.session === active else { return }
                active.close()
                self.session = nil
                self.fault(error)
            }
        }
        reply(id: id, ok: true, result: [
            "deviceId": selected.id,
            "name": selected.name,
            "captureName": selected.name,
            "sampleRate": VirtualAudioOutput.sampleRate,
            "channels": VirtualAudioOutput.channels,
            "maxBufferedMs": VirtualAudioOutput.maxBufferedMilliseconds
        ])
    }

    private func append(id: String, root: [String: Any]) throws {
        guard let session else { throw AudioBridgeError("Start an audio session before appending packets.") }
        guard let encoded = root["packet"] as? String, !encoded.isEmpty,
              let packet = Data(base64Encoded: encoded) else {
            throw AudioBridgeError("packet must be valid base64.")
        }
        do {
            let result = try session.append(packet: packet)
            reply(id: id, ok: true, result: result)
        } catch {
            session.close()
            self.session = nil
            throw error
        }
    }

    private func stop(id: String) throws {
        guard let active = session else { throw AudioBridgeError("No active audio session.") }
        defer { session = nil }
        reply(id: id, ok: true, result: try active.stopAfterDrain(shouldCancel: { self.stopping }))
    }

    private func cancel(id: String) throws {
        guard let active = session else { throw AudioBridgeError("No active audio session.") }
        session = nil
        active.close()
        reply(id: id, ok: true, result: ["cancelled": true])
    }

    private func discard(id: String) throws {
        guard let active = session else { throw AudioBridgeError("No reusable audio session.") }
        do { reply(id: id, ok: true, result: try active.discard()) }
        catch {
            active.close()
            session = nil
            throw error
        }
    }

    private func reply(
        id: String?, ok: Bool, result: [String: Any]? = nil,
        error: String? = nil, extra: [String: Any] = [:]
    ) {
        var value: [String: Any] = ["ok": ok]
        if let id { value["id"] = id } else { value["id"] = NSNull() }
        if let result { value["result"] = result }
        if let error { value["error"] = error }
        for (key, item) in extra { value[key] = item }
        write(value)
    }

    private func fault(_ error: String) { write(["event": "fault", "error": error]) }

    private func write(_ value: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              data.count <= 16 * 1_024 else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }

    private func safeError(_ error: Error) -> String {
        let value = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        if value.isEmpty { return "Audio bridge request failed." }
        return String(value.prefix(512))
    }
}

AudioBridgeServer().run()
