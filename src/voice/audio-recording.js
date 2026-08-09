const { createWav, normalizeAudioChunk, wrapOpusPacketsInOgg } = require('./audio-formats');

function createAudioFile(chunks, config = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error('No audio data was received.');
  }

  const format = config.inputFormat || 'opus';
  const normalized = chunks.map(normalizeAudioChunk).filter((chunk) => chunk.length > 0);
  if (normalized.length === 0) throw new Error('No audio data was received.');

  if (format === 'opus') {
    return {
      name: 'recording.ogg',
      contentType: 'audio/ogg',
      data: wrapOpusPacketsInOgg(normalized, {
        channels: config.channels || 1,
        sampleRate: config.sampleRate || 16000,
        frameSamples: config.opusFrameSamples || 2880
      })
    };
  }

  if (format === 'pcm16') {
    return {
      name: 'recording.wav',
      contentType: 'audio/wav',
      data: createWav(Buffer.concat(normalized), {
        channels: config.channels || 1,
        sampleRate: config.sampleRate || 16000,
        bitsPerSample: 16
      })
    };
  }

  const metadata = {
    ogg: ['recording.ogg', 'audio/ogg'],
    wav: ['recording.wav', 'audio/wav'],
    webm: ['recording.webm', 'audio/webm']
  }[format];
  if (!metadata) throw new Error(`Unsupported audio format: ${format}`);
  return { name: metadata[0], contentType: metadata[1], data: Buffer.concat(normalized) };
}

module.exports = { createAudioFile };
