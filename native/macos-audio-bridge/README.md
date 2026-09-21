# macOS ESP32 audio bridge

This Swift helper implements the same private JSONL contract as the Windows
`Esp32AudioBridge.exe`. It accepts 16 kHz mono Opus packets, decodes them with
libopus, and sends PCM only to an explicitly selected BlackHole device through
CoreAudio. It does not change the macOS default input or output device.

Build prerequisites on a real Mac:

```sh
brew install opus pkg-config
swift build --package-path native/macos-audio-bridge -c release
node scripts/check-macos-audio-bridge.js
```

The product is
`native/macos-audio-bridge/.build/release/CodexRemoteMacAudioBridge`.

The helper deliberately lists only devices whose name contains `BlackHole`
and which expose both input and output channels. Codex must use that same
BlackHole device as its microphone. `start`, `append`, `stop`, `cancel`, and
`discard` have the same bounds and response fields as the Windows helper.

This source compiles and links against the system/Homebrew libopus during the
bring-up phase. Release packaging must bundle and sign a compatible libopus,
then pass the macOS real-device gate before the app advertises support.

The GitHub Actions workflow `macOS audio bridge checks` builds the helper and
runs JSONL validation without opening an audio device. It does not validate
BlackHole playback, Codex recording, or Intel/Apple Silicon release packaging.
The workflow must actually run before its build can be reported as passing.

The decoder produces PCM16; the player receives normalized Float32 at 16 kHz.
Output failure closes the session, and closing an output multiple times is safe.
Drain completion checks the exact queued frame count rather than rounded
milliseconds. Stop/drain currently runs synchronously: EOF during that operation
is processed after its bounded drain, not immediately. Real-device acceptance
must cover parent termination and the remaining device-disconnect cases.
