import AudioToolbox
import CoreAudio
import Foundation

struct VirtualAudioDevice {
    let audioDeviceID: AudioDeviceID
    let id: String
    let name: String
    let inputChannels: Int
    let outputChannels: Int

    var wireValue: [String: Any] {
        ["id": id, "name": name, "captureName": name]
    }
}

enum CoreAudioDevices {
    static func virtualCables() throws -> [VirtualAudioDevice] {
        try allDevices()
            .filter { device in
                device.inputChannels > 0 && device.outputChannels > 0
                    && device.name.localizedCaseInsensitiveContains("BlackHole")
            }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    static func find(id: String) throws -> VirtualAudioDevice? {
        try virtualCables().first { $0.id == id }
    }

    private static func allDevices() throws -> [VirtualAudioDevice] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var byteCount: UInt32 = 0
        try check(AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &byteCount
        ), "Unable to enumerate CoreAudio devices")

        let count = Int(byteCount) / MemoryLayout<AudioDeviceID>.stride
        var identifiers = Array(repeating: AudioDeviceID(0), count: count)
        try identifiers.withUnsafeMutableBytes { bytes in
            var size = byteCount
            try check(AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, bytes.baseAddress
            ), "Unable to read CoreAudio devices")
        }

        return identifiers.compactMap { audioDeviceID in
            guard let name = stringProperty(audioDeviceID, selector: kAudioObjectPropertyName),
                  let uid = stringProperty(audioDeviceID, selector: kAudioDevicePropertyDeviceUID),
                  isAlive(audioDeviceID) else {
                return nil
            }
            return VirtualAudioDevice(
                audioDeviceID: audioDeviceID,
                id: uid,
                name: name,
                inputChannels: channelCount(audioDeviceID, scope: kAudioDevicePropertyScopeInput),
                outputChannels: channelCount(audioDeviceID, scope: kAudioDevicePropertyScopeOutput)
            )
        }
    }

    static func isAlive(_ device: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var alive: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(device, &address, 0, nil, &size, &alive) == noErr && alive != 0
    }

    private static func stringProperty(_ objectID: AudioObjectID, selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var value: CFString = "" as CFString
        var size = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &value) { pointer in
            AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, pointer)
        }
        return status == noErr ? value as String : nil
    }

    private static func channelCount(_ objectID: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(objectID, &address, 0, nil, &size) == noErr, size > 0 else {
            return 0
        }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, raw) == noErr else {
            return 0
        }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        return UnsafeMutableAudioBufferListPointer(list).reduce(0) { total, buffer in
            total + Int(buffer.mNumberChannels)
        }
    }

    private static func check(_ status: OSStatus, _ message: String) throws {
        guard status == noErr else {
            throw AudioBridgeError("\(message) (CoreAudio \(status)).")
        }
    }
}
