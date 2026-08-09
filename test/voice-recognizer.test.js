const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const VoiceRecognizer = require('../src/voice/voice-recognizer');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-voice-test-'));
  const configFile = path.join(tempDir, 'voice-config.json');
  try {
    const native = new VoiceRecognizer({ configFile, nativeShortcut: 'Alt+F5' });
    assert.equal(native.getConfig().mode, 'native');
    assert.equal(native.getConfig().native.shortcut, 'Alt+F5');
    assert.equal(native.getStatus().provider, 'native');
    assert.equal(native.getStatus().acceptsAudio, false);

    const saved = await native.saveConfig({
      mode: 'api',
      native: { shortcut: 'Ctrl+Shift+R' },
      api: {
        apiKey: 'test-secret',
        baseUrl: 'https://example.test/v1',
        model: 'legacy-transcription-model',
        language: 'en',
        inputFormat: 'pcm16',
        sampleRate: 16000,
        channels: 1,
        opusFrameSamples: 2880
      }
    });
    assert.equal(saved.mode, 'api');
    assert.equal(saved.api.model, 'legacy-transcription-model');
    assert(fs.existsSync(configFile));

    let requestDetails;
    const api = new VoiceRecognizer({
      configFile,
      providerOptions: {
        api: {
          async request(details) {
            requestDetails = details;
            return JSON.stringify({ text: 'hello from api' });
          }
        }
      }
    });
    assert.equal(api.getStatus().mode, 'api');
    assert.equal(api.getStatus().configured, true);
    assert.equal(Object.prototype.hasOwnProperty.call(api.getStatus(), 'apiKey'), false);
    await api.start();
    await api.appendAudio(Buffer.from([0, 1, 2, 3]));
    const result = await api.stop();
    assert.equal(result.text, 'hello from api');
    assert.equal(requestDetails.url.pathname, '/v1/audio/transcriptions');
    assert.equal(requestDetails.headers.Authorization, 'Bearer test-secret');
    assert.match(requestDetails.body.toString('utf8'), /legacy-transcription-model/);
    assert.match(requestDetails.body.toString('utf8'), /name="language"/);

    await api.start();
    await api.appendAudio(Buffer.from([4, 5, 6]));
    const canceled = await api.cancel();
    assert.equal(canceled.active, false);
    assert.equal(api.provider.chunks.length, 0);
    assert.equal(api.provider.totalBytes, 0);
    await api.stop();

    const legacy = VoiceRecognizer.normalizeConfig({
      mode: 'cloud',
      native: { shortcut: 'Ctrl+Shift+R' },
      cloud: {
        apiKey: 'legacy-secret',
        baseUrl: 'https://legacy.example/v1',
        model: 'legacy-model',
        language: 'zh',
        inputFormat: 'opus',
        sampleRate: 16000,
        channels: 1,
        opusFrameSamples: 2880
      }
    });
    assert.equal(legacy.mode, 'api');
    assert.equal(legacy.api.model, 'legacy-model');
    assert.throws(() => VoiceRecognizer.normalizeConfig({ mode: 'local' }), /Unsupported voice recognition mode/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('voice recognizer tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
