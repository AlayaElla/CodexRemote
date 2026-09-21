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

Homebrew is only required for a direct helper build. `npm run package:mac`
builds a pinned, checksum-verified libopus under `build/macos-deps/` for a
reproducible deployment target.

The helper deliberately lists only devices whose name contains `BlackHole`
and which expose both input and output channels. Codex must use that same
BlackHole device as its microphone. `start`, `append`, `stop`, `cancel`, and
`discard` have the same bounds and response fields as the Windows helper.

This source compiles and links against the system/Homebrew libopus. The macOS
packaging script copies the linked libopus beside the helper, rewrites its load
path, and signs both native files before electron-builder creates the app.

The GitHub Actions workflow `macOS audio bridge checks` builds the helper and
runs JSONL validation without opening an audio device. It does not validate
BlackHole playback, Codex recording, or Intel/Apple Silicon release packaging.

The decoder produces PCM16; the player receives normalized Float32 at 16 kHz.
Output failure closes the session, and closing an output multiple times is safe.
Drain completion checks the exact queued frame count rather than rounded
milliseconds. Stop/drain currently runs synchronously: EOF during that operation
is processed after its bounded drain, not immediately.
