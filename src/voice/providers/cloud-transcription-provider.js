const http = require('http');
const https = require('https');
const crypto = require('crypto');
const VoiceProvider = require('./voice-provider');
const { normalizeAudioChunk } = require('../audio-formats');
const { createAudioFile } = require('../audio-recording');

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

function resolveTranscriptionUrl(baseUrl) {
  const normalized = String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = normalized.endsWith('/audio/transcriptions')
    ? normalized
    : `${normalized}/audio/transcriptions`;
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('API transcription URL must use HTTP or HTTPS');
  }
  return parsed;
}

function appendMultipartPart(parts, boundary, name, value) {
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  ));
}

function createMultipartBody({ fields, file }) {
  const boundary = `----CodexRemote${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') {
      appendMultipartPart(parts, boundary, name, value);
    }
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
  ));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

function sendHttpRequest({ url, headers, body, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'http:' ? http : https;
    const request = transport.request(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': body.length }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let detail = responseBody;
          try {
            const parsed = JSON.parse(responseBody);
            detail = parsed.error && parsed.error.message ? parsed.error.message : responseBody;
          } catch (error) {}
          reject(new Error(`API transcription failed (${response.statusCode}): ${detail || response.statusMessage}`));
          return;
        }
        resolve(responseBody);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('API transcription timed out')));
    request.once('error', reject);
    request.end(body);
  });
}

function redactApiKey(message, apiKey) {
  const text = String(message || 'API transcription failed.');
  return apiKey ? text.split(apiKey).join('[redacted]') : text;
}

class CloudTranscriptionProvider extends VoiceProvider {
  constructor(config = {}, options = {}) {
    super('api');
    this.config = {
      apiKey: config.apiKey || '',
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
      model: config.model || 'gpt-4o-transcribe',
      language: config.language || 'zh',
      inputFormat: config.inputFormat || 'opus',
      sampleRate: Number(config.sampleRate) || 16000,
      channels: Number(config.channels) || 1,
      opusFrameSamples: Number(config.opusFrameSamples) || 2880
    };
    this.request = options.request || sendHttpRequest;
    this.chunks = [];
    this.totalBytes = 0;
    this.processing = false;
  }

  getStatus() {
    return {
      ...super.getStatus(),
      configured: Boolean(this.config.apiKey),
      acceptsAudio: true,
      processing: this.processing,
      model: this.config.model,
      inputFormat: this.config.inputFormat
    };
  }

  async start() {
    if (!this.config.apiKey) throw new Error('API speech recognition requires an API key.');
    if (this.processing) throw new Error('API speech recognition is still processing the previous recording.');
    if (this.active) return this.getStatus();
    this.chunks = [];
    this.totalBytes = 0;
    this.active = true;
    return this.getStatus();
  }

  async appendAudio(chunk) {
    if (!this.active) return this.getStatus();
    const normalized = normalizeAudioChunk(chunk);
    if (this.totalBytes + normalized.length > MAX_AUDIO_BYTES) {
      throw new Error('Recording is too large for API transcription.');
    }
    this.chunks.push(Buffer.from(normalized));
    this.totalBytes += normalized.length;
    return this.getStatus();
  }

  async cancel() {
    this.chunks = [];
    this.totalBytes = 0;
    this.active = false;
    this.processing = false;
    return this.getStatus();
  }

  createAudioFile() {
    return createAudioFile(this.chunks, this.config);
  }

  async stop() {
    if (!this.active) return this.getStatus();
    this.active = false;
    this.processing = true;

    let transcriptionText;
    try {
      const file = this.createAudioFile();
      const url = resolveTranscriptionUrl(this.config.baseUrl);
      const { boundary, body } = createMultipartBody({
        fields: {
          model: this.config.model,
          language: this.config.language,
          response_format: 'json'
        },
        file
      });
      const responseBody = await this.request({
        url,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body
      });
      let response = responseBody;
      if (typeof responseBody === 'string') {
        try { response = JSON.parse(responseBody); } catch (error) {}
      }
      transcriptionText = String(response && response.text !== undefined ? response.text : response || '').trim();
      if (!transcriptionText) throw new Error('API transcription returned no text.');
    } catch (error) {
      throw new Error(redactApiKey(error && error.message, this.config.apiKey));
    } finally {
      this.chunks = [];
      this.totalBytes = 0;
      this.processing = false;
    }
    return { ...this.getStatus(), text: transcriptionText };
  }
}

module.exports = CloudTranscriptionProvider;
module.exports.createMultipartBody = createMultipartBody;
module.exports.resolveTranscriptionUrl = resolveTranscriptionUrl;
module.exports.redactApiKey = redactApiKey;
