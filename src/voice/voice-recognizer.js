const fs = require('fs');
const path = require('path');
const { DEFAULT_VOICE_SHORTCUT, parseShortcut } = require('../core/keyboard-shortcut');
const CloudTranscriptionProvider = require('./providers/cloud-transcription-provider');

const MODES = new Set(['native', 'api']);
const INPUT_FORMATS = new Set(['opus', 'ogg', 'wav', 'webm', 'pcm16']);

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'cloud') return 'api';
  if (MODES.has(mode)) return mode;
  throw new Error(`Unsupported voice recognition mode: ${value}`);
}

function readShortcut(value, fallback) {
  try {
    return parseShortcut(String(value || fallback || DEFAULT_VOICE_SHORTCUT)).shortcut;
  } catch (error) {
    if (fallback && value !== fallback) return parseShortcut(fallback).shortcut;
    throw error;
  }
}

function defaultConfig(options = {}) {
  let mode = 'native';
  try {
    mode = normalizeMode(process.env.CODEX_REMOTE_VOICE_MODE || 'native');
  } catch (error) {}

  const nativeShortcut = readShortcut(
    options.nativeShortcut || process.env.CODEX_REMOTE_VOICE_SHORTCUT,
    DEFAULT_VOICE_SHORTCUT
  );
  return {
    mode,
    native: {
      shortcut: nativeShortcut
    },
    api: {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe',
      language: 'zh',
      inputFormat: 'opus',
      sampleRate: 16000,
      channels: 1,
      opusFrameSamples: 2880
    }
  };
}

function normalizeConfig(input, fallback = defaultConfig()) {
  const source = input && typeof input === 'object' ? input : {};
  const mode = normalizeMode(source.mode || fallback.mode);
  const nativeSource = source.native && typeof source.native === 'object' ? source.native : {};
  const nativeShortcut = readShortcut(
    nativeSource.shortcut || source.voiceShortcut || fallback.native.shortcut,
    fallback.native.shortcut
  );

  // `cloud` is the persisted name used by earlier PC releases. Keep reading it
  // while writing the neutral `api` shape for new settings.
  const apiSource = source.api && typeof source.api === 'object'
    ? source.api
    : (source.cloud && typeof source.cloud === 'object' ? source.cloud : {});
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

  return {
    mode,
    native: { shortcut: nativeShortcut },
    api
  };
}

class VoiceRecognizer {
  constructor(options = {}) {
    this.configFile = options.configFile || null;
    this.defaultConfigOptions = { nativeShortcut: options.nativeShortcut };
    this.providerOptions = options.providerOptions || {};
    this.operation = Promise.resolve();
    this.config = this.loadConfig();
    this.nativeActive = false;
    this.provider = this.createProvider();
  }

  loadConfig() {
    const defaults = defaultConfig(this.defaultConfigOptions);
    if (!this.configFile || !fs.existsSync(this.configFile)) return defaults;
    try {
      const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      return normalizeConfig(saved, defaults);
    } catch (error) {
      console.warn('[Voice] Failed to load voice configuration:', error.message);
      return defaults;
    }
  }

  createProvider() {
    if (this.config.mode !== 'api') return null;
    return new CloudTranscriptionProvider(this.config.api, this.providerOptions.api || this.providerOptions.cloud);
  }

  getConfig() {
    return JSON.parse(JSON.stringify(this.config));
  }

  getStatus() {
    if (this.config.mode === 'native') {
      return {
        mode: 'native',
        provider: 'native',
        supported: true,
        configured: true,
        active: this.nativeActive,
        acceptsAudio: false,
        shortcut: this.config.native.shortcut
      };
    }
    return {
      mode: 'api',
      shortcut: this.config.native.shortcut,
      ...this.provider.getStatus()
    };
  }

  enqueue(operation) {
    const result = this.operation.catch(() => {}).then(operation);
    this.operation = result;
    return result;
  }

  start() {
    return this.enqueue(async () => {
      if (this.config.mode === 'native') {
        if (this.nativeActive) throw new Error('Native voice recording is already active.');
        this.nativeActive = true;
        return this.getStatus();
      }
      return this.provider.start();
    });
  }

  appendAudio(chunk) {
    return this.enqueue(() => {
      if (this.config.mode !== 'api') return this.getStatus();
      return this.provider.appendAudio(chunk);
    });
  }

  cancel() {
    return this.enqueue(async () => {
      if (this.config.mode === 'native') {
        this.nativeActive = false;
        return this.getStatus();
      }
      if (this.provider && typeof this.provider.cancel === 'function') {
        await this.provider.cancel();
      } else if (this.provider) {
        this.provider.active = false;
      }
      return this.getStatus();
    });
  }

  stop() {
    return this.enqueue(async () => {
      if (this.config.mode === 'native') {
        this.nativeActive = false;
        return this.getStatus();
      }
      return this.provider.stop();
    });
  }

  saveConfig(input) {
    return this.enqueue(async () => {
      if (this.nativeActive || (this.provider && this.provider.active)) {
        throw new Error('Stop voice input before changing its configuration.');
      }
      const nextConfig = normalizeConfig(input, this.config);
      if (this.configFile) {
        fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
        fs.writeFileSync(this.configFile, JSON.stringify(nextConfig, null, 2), 'utf8');
      }
      this.config = nextConfig;
      this.provider = this.createProvider();
      return this.getConfig();
    });
  }
}

module.exports = VoiceRecognizer;
module.exports.defaultConfig = defaultConfig;
module.exports.normalizeConfig = normalizeConfig;
module.exports.normalizeMode = normalizeMode;
