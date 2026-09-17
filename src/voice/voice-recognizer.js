const fs = require('fs');
const path = require('path');
const CloudTranscriptionProvider = require('./providers/cloud-transcription-provider');
const VirtualMicroProvider = require('./providers/virtual-micro-provider');
const Esp32AudioBridge = require('./esp32-audio-bridge');
const { EventEmitter } = require('events');

const MODES = new Set(['api', 'virtual_micro']);
const INPUT_FORMATS = new Set(['opus', 'ogg', 'wav', 'webm', 'pcm16']);
const MAX_QUEUED_AUDIO_BYTES = 512 * 1024;
const MAX_QUEUED_AUDIO_FRAMES = 64;

function audioByteLength(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  return 0;
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (MODES.has(mode)) return mode;
  throw new Error(`Unsupported voice recognition mode: ${value}`);
}

function defaultConfig() {
  let mode = 'virtual_micro';
  try {
    mode = normalizeMode(process.env.CODEX_REMOTE_VOICE_MODE || 'virtual_micro');
  } catch (error) {}

  return {
    mode,
    api: {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe',
      language: 'zh',
      inputFormat: 'opus',
      sampleRate: 16000,
      channels: 1,
      opusFrameSamples: 2880
    },
    virtualMicro: {
      profile: 'codex-micro-v1',
      audioSource: 'esp32',
      audioDeviceId: ''
    }
  };
}

function normalizeConfig(input, fallback = defaultConfig()) {
  const source = input && typeof input === 'object' ? input : {};
  const mode = normalizeMode(source.mode || fallback.mode);

  const apiSource = source.api && typeof source.api === 'object'
    ? source.api : {};
  const api = { ...fallback.api, ...apiSource };
  api.apiKey = String(api.apiKey || '').trim();
  api.baseUrl = String(api.baseUrl || '').trim();
  api.model = String(api.model || '').trim();
  api.language = String(api.language || '').trim();
  api.inputFormat = String(api.inputFormat || 'opus').trim().toLowerCase();
  api.sampleRate = Number(api.sampleRate);
  api.channels = Number(api.channels);
  api.opusFrameSamples = Number(api.opusFrameSamples);

  if (!api.baseUrl) throw new Error('API transcription Base URL is required.');
  if (!api.model) throw new Error('API transcription model is required.');
  if (!INPUT_FORMATS.has(api.inputFormat)) {
    throw new Error(`Unsupported API audio format: ${api.inputFormat}`);
  }
  const apiUrl = new URL(api.baseUrl);
  if (!['http:', 'https:'].includes(apiUrl.protocol)) {
    throw new Error('API transcription Base URL must use HTTP or HTTPS.');
  }
  if (!Number.isInteger(api.sampleRate) || api.sampleRate < 8000 || api.sampleRate > 192000) {
    throw new Error('API audio sample rate must be between 8000 and 192000 Hz.');
  }
  if (!Number.isInteger(api.channels) || api.channels < 1 || api.channels > 2) {
    throw new Error('API audio channels must be 1 or 2.');
  }
  if (!Number.isInteger(api.opusFrameSamples) || api.opusFrameSamples <= 0) {
    throw new Error('API Opus frame sample count must be a positive integer.');
  }
  const virtualSource = source.virtualMicro && typeof source.virtualMicro === 'object'
    ? source.virtualMicro : {};
  const virtualMicro = {
    profile: String(virtualSource.profile ?? fallback.virtualMicro.profile ?? '').trim(),
    audioSource: String(virtualSource.audioSource ?? fallback.virtualMicro.audioSource ?? 'esp32').trim().toLowerCase(),
    audioDeviceId: virtualSource.audioDeviceId === undefined
      ? String(fallback.virtualMicro.audioDeviceId || '').trim()
      : typeof virtualSource.audioDeviceId === 'string' ? virtualSource.audioDeviceId.trim() : null
  };
  if (virtualMicro.profile !== 'codex-micro-v1') {
    throw new Error(`Unsupported Virtual Micro profile: ${virtualMicro.profile}`);
  }
  if (!['esp32', 'computer'].includes(virtualMicro.audioSource)) {
    throw new Error(`Unsupported Virtual Micro audio source: ${virtualMicro.audioSource}`);
  }
  if (virtualMicro.audioDeviceId === null) throw new Error('Virtual Micro audio device id must be a string.');

  return {
    mode,
    api,
    virtualMicro
  };
}

class VoiceRecognizer {
  constructor(options = {}) {
    this.configFile = options.configFile || null;
    this.providerOptions = options.providerOptions || {};
    this.operation = Promise.resolve();
    this.audioQueueBytes = 0;
    this.audioQueueFrames = 0;
    this.audioGeneration = 0;
    this.events = new EventEmitter();
    this.config = this.loadConfig();
    this.provider = this.createProvider();
    this.bindProvider(this.provider);
  }

  loadConfig() {
    const defaults = defaultConfig();
    if (!this.configFile || !fs.existsSync(this.configFile)) return defaults;
    try {
      const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      return normalizeConfig(saved, defaults);
    } catch (error) {
      console.warn('[Voice] Failed to load voice configuration:', error.message);
      return defaults;
    }
  }

  createProviderFor(config) {
    if (config.mode === 'api') {
      return new CloudTranscriptionProvider(config.api, this.providerOptions.api);
    }
    return new VirtualMicroProvider(config.virtualMicro, this.providerOptions.virtualMicro || {});
  }

  createProvider() { return this.createProviderFor(this.config); }

  bindProvider(provider) {
    if (this.unbindProvider) this.unbindProvider();
    this.unbindProvider = null;
    if (!provider || typeof provider.on !== 'function') return;
    const onFault = (fault) => {
      if (this.provider !== provider) return;
      this.discardQueuedAudio();
      this.events.emit('fault', {
        mode: this.config.mode,
        ...(fault && typeof fault === 'object' ? fault : { message: String(fault || 'Voice provider fault.') })
      });
    };
    const onStatus = () => {
      if (this.provider === provider) this.events.emit('status', this.getStatus());
    };
    provider.on('fault', onFault);
    provider.on('status', onStatus);
    this.unbindProvider = () => {
      if (typeof provider.removeListener !== 'function') return;
      provider.removeListener('fault', onFault);
      provider.removeListener('status', onStatus);
    };
  }

  sharesController(first, second) {
    return Boolean(first && second && first.controller && first.controller === second.controller);
  }

  canReuseVirtualMicroProvider(nextConfig) {
    return this.config.mode === 'virtual_micro'
      && nextConfig.mode === 'virtual_micro'
      && this.config.virtualMicro.profile === nextConfig.virtualMicro.profile;
  }

  detachSharedProvider(provider) {
    if (!provider || !provider.controller || typeof provider.controller.removeListener !== 'function') return;
    if (provider.onControllerStatus) provider.controller.removeListener('status', provider.onControllerStatus);
    if (provider.onControllerFault) provider.controller.removeListener('fault', provider.onControllerFault);
  }

  on(...args) { this.events.on(...args); return this; }
  removeListener(...args) { this.events.removeListener(...args); return this; }

  getConfig() {
    return JSON.parse(JSON.stringify(this.config));
  }

  getStatus() {
    return { mode: this.config.mode, ...this.provider.getStatus() };
  }

  getMicroController() {
    return this.config.mode === 'virtual_micro' ? this.provider.controller : null;
  }

  enqueue(operation) {
    const result = this.operation.catch(() => {}).then(operation);
    this.operation = result;
    return result;
  }

  start(options) {
    return this.enqueue(() => this.provider.start(options));
  }

  connect() {
    return this.enqueue(async () => {
      if (this.config.mode !== 'virtual_micro') return this.getStatus();
      return this.provider.connect();
    });
  }

  appendAudio(chunk) {
    const bytes = audioByteLength(chunk);
    if (bytes > MAX_QUEUED_AUDIO_BYTES || this.audioQueueFrames >= MAX_QUEUED_AUDIO_FRAMES
      || this.audioQueueBytes + bytes > MAX_QUEUED_AUDIO_BYTES) {
      const error = new Error('Voice audio queue is full.');
      this.discardQueuedAudio();
      return this.enqueue(async () => {
        if (this.provider && this.provider.active && typeof this.provider.cancel === 'function') {
          await this.provider.cancel();
        }
        throw error;
      });
    }
    const generation = this.audioGeneration;
    this.audioQueueBytes += bytes;
    this.audioQueueFrames += 1;
    return this.enqueue(async () => {
      try {
        if (generation !== this.audioGeneration || !this.provider || !this.provider.active
          || !this.provider.getStatus().acceptsAudio) return this.getStatus();
        return await this.provider.appendAudio(chunk);
      } finally {
        this.audioQueueBytes -= bytes;
        this.audioQueueFrames -= 1;
      }
    });
  }

  discardQueuedAudio() { this.audioGeneration += 1; }

  cancel(options) {
    this.discardQueuedAudio();
    return this.enqueue(async () => {
      if (this.provider && typeof this.provider.cancel === 'function') {
        const result = await this.provider.cancel(options);
        return { ...this.getStatus(), ...result };
      } else if (this.provider) {
        this.provider.active = false;
      }
      return this.getStatus();
    });
  }

  stop(options) {
    return this.enqueue(() => this.provider.stop(options));
  }

  saveConfig(input) {
    return this.enqueue(async () => {
      if (this.provider && (this.provider.active || this.provider.releaseUncertain)) {
        throw new Error('Stop voice input before changing its configuration.');
      }
      const nextConfig = normalizeConfig(input, this.config);
      const previousProvider = this.provider;
      const reuseVirtualMicroProvider = this.canReuseVirtualMicroProvider(nextConfig);
      const preparedVirtualConfig = reuseVirtualMicroProvider && previousProvider
        && typeof previousProvider.prepareConfig === 'function'
        ? previousProvider.prepareConfig(nextConfig.virtualMicro) : null;
      // Construct before touching the current provider or persisted config: a
      // missing broker/controller must not leave a partially applied selection.
      const nextProvider = reuseVirtualMicroProvider ? previousProvider : this.createProviderFor(nextConfig);
      let temporaryFile;
      try {
        // A same-profile Virtual Micro remains connected while unrelated voice
        // settings are saved. Mode or Micro-profile changes still release the
        // old provider before the new selection takes effect.
        if (!reuseVirtualMicroProvider && previousProvider && typeof previousProvider.cancel === 'function') {
          await previousProvider.cancel();
        }
        if (this.configFile) {
          fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
          const candidate = `${this.configFile}.${require('crypto').randomUUID()}.tmp`;
          const descriptor = fs.openSync(candidate, 'wx');
          temporaryFile = candidate;
          try { fs.writeFileSync(descriptor, JSON.stringify(nextConfig, null, 2), 'utf8'); }
          finally { fs.closeSync(descriptor); }
          fs.renameSync(temporaryFile, this.configFile);
          temporaryFile = null;
        }
      } catch (error) {
        if (temporaryFile) {
          try { fs.unlinkSync(temporaryFile); } catch {}
        }
        if (!reuseVirtualMicroProvider && nextProvider && typeof nextProvider.dispose === 'function') {
          if (this.sharesController(previousProvider, nextProvider)) this.detachSharedProvider(nextProvider);
          else try { await nextProvider.dispose(); } catch (disposeError) {}
        }
        throw error;
      }
      this.config = nextConfig;
      this.provider = nextProvider;
      if (preparedVirtualConfig && typeof this.provider.applyPreparedConfig === 'function') {
        await this.provider.applyPreparedConfig(preparedVirtualConfig);
      }
      if (!reuseVirtualMicroProvider) this.bindProvider(this.provider);
      if (!reuseVirtualMicroProvider && previousProvider && typeof previousProvider.dispose === 'function') {
        try {
          if (this.sharesController(previousProvider, this.provider)) this.detachSharedProvider(previousProvider);
          else await previousProvider.dispose();
        }
        catch (error) { console.warn('[Voice] Previous provider cleanup:', error.message); }
      }
      return this.getConfig();
    });
  }

  dispose() {
    this.discardQueuedAudio();
    return this.enqueue(async () => {
      if (this.provider && typeof this.provider.dispose === 'function') await this.provider.dispose();
      else if (this.provider && typeof this.provider.cancel === 'function') await this.provider.cancel();
      return this.getStatus();
    });
  }

  async listAudioDevices() {
    return VoiceRecognizer.listAudioDevices(this.providerOptions.virtualMicro || {});
  }

  static async listAudioDevices(options = {}) {
    const bridge = options.audioBridgeFactory
      ? options.audioBridgeFactory(options.audioBridgeOptions || {})
      : new Esp32AudioBridge(options.audioBridgeOptions || {});
    try {
      if (!bridge || typeof bridge.list !== 'function') return [];
      return await bridge.list();
    } finally {
      try { if (bridge && typeof bridge.dispose === 'function') await bridge.dispose(); } catch (error) {}
    }
  }
}

module.exports = VoiceRecognizer;
module.exports.defaultConfig = defaultConfig;
module.exports.normalizeConfig = normalizeConfig;
module.exports.normalizeMode = normalizeMode;
module.exports.audioByteLength = audioByteLength;
