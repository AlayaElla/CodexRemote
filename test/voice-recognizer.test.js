const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const VoiceRecognizer = require('../src/voice/voice-recognizer');

function createVirtualController() {
  return Object.assign(new EventEmitter(), {
    active: false,
    getStatus() { return { supported: true, connected: this.active, microConnected: this.active, driverAvailable: true, hidEnumerated: true }; },
    async connect() { this.active = true; },
    async setPtt(value) { this.active = Boolean(value); return { delivery: 'submitted_to_hid', outcome: 'unknown' }; },
    async releaseAll() { this.releaseCount = (this.releaseCount || 0) + 1; this.active = false; return { delivery: 'submitted_to_hid', outcome: 'unknown' }; },
    async close() { this.closeCount = (this.closeCount || 0) + 1; this.closed = true; }
  });
}

function createAudioBridge() {
  return {
    getStatus() { return { ready: false, active: false, packets: 0, samples: 0, peak: 0, bufferedMs: 0, lastError: null, deviceName: null, captureName: null }; },
    async dispose() {}, async cancel() {}, async start() {}, async append() {}, async stop() {}, async list() { return []; }
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-voice-test-'));
  const configFile = path.join(tempDir, 'voice-config.json');
  try {
    const micro = new VoiceRecognizer({ configFile });
    assert.equal(micro.getConfig().mode, 'virtual_micro');
    assert.equal(micro.getStatus().provider, 'virtual_micro');
    assert.equal(micro.getStatus().acceptsAudio, true);
    assert.deepEqual(micro.getConfig().virtualMicro, { profile: 'codex-micro-v1', audioSource: 'esp32', audioDeviceId: '' });

    const saved = await micro.saveConfig({
      mode: 'api',
      api: {
        apiKey: 'test-secret',
        baseUrl: 'https://example.test/v1',
        model: 'custom-transcription-model',
        language: 'en',
        inputFormat: 'pcm16',
        sampleRate: 16000,
        channels: 1,
        opusFrameSamples: 2880
      }
    });
    assert.equal(saved.mode, 'api');
    assert.equal(saved.api.model, 'custom-transcription-model');
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
    assert.match(requestDetails.body.toString('utf8'), /custom-transcription-model/);
    assert.match(requestDetails.body.toString('utf8'), /name="language"/);

    await api.start();
    await api.appendAudio(Buffer.from([4, 5, 6]));
    const canceled = await api.cancel();
    assert.equal(canceled.active, false);
    assert.equal(api.provider.chunks.length, 0);
    assert.equal(api.provider.totalBytes, 0);
    await api.stop();

    for (const mode of ['native', 'cloud', 'local']) {
      assert.throws(() => VoiceRecognizer.normalizeConfig({ mode }), /Unsupported voice recognition mode/);
    }
    assert.throws(() => VoiceRecognizer.normalizeConfig({ virtualMicro: { profile: 'other' } }), /Unsupported Virtual Micro profile/);

    const controller = createVirtualController();
    const virtual = new VoiceRecognizer({ providerOptions: { virtualMicro: { controller } } });
    assert.equal(controller.active, false, 'loading settings does not connect');
    await virtual.saveConfig({
      mode: 'virtual_micro', api: virtual.getConfig().api,
      virtualMicro: { profile: 'codex-micro-v1', audioSource: 'computer', audioDeviceId: '' }
    });
    assert.equal(virtual.getStatus().mode, 'virtual_micro');
    assert.equal(virtual.getStatus().acceptsAudio, false);
    await virtual.connect();
    const connectedProvider = virtual.provider;
    await virtual.saveConfig({
      mode: 'virtual_micro',
      api: { ...virtual.getConfig().api, language: 'en' },
      virtualMicro: { profile: 'codex-micro-v1', audioSource: 'computer', audioDeviceId: '' }
    });
    assert.strictEqual(virtual.provider, connectedProvider, 'saving the same Micro profile must retain its provider');
    assert.equal(controller.active, true, 'saving unrelated settings must retain the existing Micro connection');
    assert.equal(controller.releaseCount || 0, 0, 'saving the same Micro profile must not release its connection');
    assert.equal(controller.closeCount || 0, 0, 'saving the same Micro profile must not close its controller');
    const blockedSameProfileFile = path.join(tempDir, 'blocked-same-profile-config');
    fs.mkdirSync(blockedSameProfileFile);
    virtual.configFile = blockedSameProfileFile;
    await assert.rejects(() => virtual.saveConfig({
      mode: 'virtual_micro', api: virtual.getConfig().api,
      virtualMicro: { profile: 'codex-micro-v1', audioSource: 'computer', audioDeviceId: '' }
    }));
    assert.strictEqual(virtual.provider, connectedProvider, 'a failed same-profile save retains the connected provider');
    assert.equal(controller.active, true, 'a failed same-profile save retains the Micro connection');
    assert.equal(controller.releaseCount || 0, 0, 'a failed same-profile save does not release the controller');
    assert.equal(controller.closeCount || 0, 0, 'a failed same-profile save does not close the controller');
    await virtual.start();
    assert.equal(virtual.getStatus().active, true);
    await virtual.appendAudio(Buffer.from([1, 2]));
    await virtual.stop();
    await virtual.start();
    const virtualCanceled = await virtual.cancel();
    assert.equal(virtualCanceled.delivery, 'submitted_to_hid');
    assert.equal(virtualCanceled.outcome, 'unknown');
    await virtual.dispose();
    assert.equal(controller.closed, true);

    const audioSwitchController = createVirtualController();
    const audioSwitch = new VoiceRecognizer({
      configFile: path.join(tempDir, 'audio-switch.json'),
      providerOptions: { virtualMicro: { controller: audioSwitchController, audioBridgeFactory: createAudioBridge } }
    });
    await audioSwitch.saveConfig({ mode: 'virtual_micro', virtualMicro: { profile: 'codex-micro-v1', audioSource: 'computer', audioDeviceId: '' } });
    await audioSwitch.connect();
    const retainedProvider = audioSwitch.provider;
    await audioSwitch.saveConfig({ mode: 'virtual_micro', virtualMicro: { profile: 'codex-micro-v1', audioSource: 'esp32', audioDeviceId: 'cable-output' } });
    assert.strictEqual(audioSwitch.provider, retainedProvider, 'source switches retain the connected HID provider');
    assert.equal(audioSwitchController.active, true, 'source switches do not reconnect HID');
    assert.equal(audioSwitch.getStatus().audioSource, 'esp32');
    audioSwitch.configFile = path.join(tempDir, 'audio-switch-blocked');
    fs.mkdirSync(audioSwitch.configFile);
    await assert.rejects(() => audioSwitch.saveConfig({ mode: 'virtual_micro', virtualMicro: { profile: 'codex-micro-v1', audioSource: 'computer', audioDeviceId: '' } }));
    assert.equal(audioSwitch.getStatus().audioSource, 'esp32', 'failed persistence keeps the current audio source');
    await audioSwitch.dispose();

    const brokenController = createVirtualController();
    brokenController.releaseAll = async () => { throw new Error('cannot release'); };
    const switchGuard = new VoiceRecognizer({ providerOptions: {
      virtualMicro: { controller: brokenController }
    } });
    await assert.rejects(() => switchGuard.saveConfig({
      mode: 'api', api: switchGuard.getConfig().api,
      virtualMicro: switchGuard.getConfig().virtualMicro
    }), /cannot release/);
    assert.equal(switchGuard.getConfig().mode, 'virtual_micro');

    const persistentController = createVirtualController();
    const persistenceGuard = new VoiceRecognizer({ providerOptions: {
      virtualMicro: { controller: persistentController, audioBridgeFactory: createAudioBridge }
    } });
    await persistenceGuard.saveConfig({ mode: 'virtual_micro', virtualMicro: { profile: 'codex-micro-v1' } });
    const previousProvider = persistenceGuard.provider;
    // A directory cannot be replaced by a configuration file. The old provider
    // must retain its event wiring and the original directory must survive.
    const blockedFile = path.join(tempDir, 'blocked-config');
    fs.mkdirSync(blockedFile);
    persistenceGuard.configFile = blockedFile;
    await assert.rejects(() => persistenceGuard.saveConfig({ mode: 'api' }));
    assert.equal(persistenceGuard.provider, previousProvider);
    assert.equal(persistenceGuard.getConfig().mode, 'virtual_micro');
    assert.equal(persistentController.closed, undefined);
    assert(fs.statSync(blockedFile).isDirectory());
    assert.equal(fs.readdirSync(tempDir).filter(name => name.endsWith('.tmp')).length, 0);
    let preservedFault;
    persistenceGuard.on('fault', event => { preservedFault = event; });
    persistentController.emit('fault', new Error('still wired'));
    assert.match(preservedFault.message, /still wired/);
    await persistenceGuard.dispose();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('voice recognizer tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
