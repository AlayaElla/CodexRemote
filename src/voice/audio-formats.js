const OGG_CRC_POLYNOMIAL = 0x04C11DB7;

function createOggCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 0x80000000
        ? ((value << 1) ^ OGG_CRC_POLYNOMIAL) >>> 0
        : (value << 1) >>> 0;
    }
    table[index] = value;
  }
  return table;
}

const OGG_CRC_TABLE = createOggCrcTable();

function normalizeAudioChunk(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'base64');
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  throw new Error('Audio chunk must be a Buffer, ArrayBuffer, typed array, or base64 string');
}

function createWav(pcmData, { sampleRate = 16000, bitsPerSample = 16, channels = 1 } = {}) {
  const audioData = normalizeAudioChunk(pcmData);
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + audioData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(audioData.length, 40);

  return Buffer.concat([header, audioData]);
}

function packetSegments(length) {
  const segments = [];
  let remaining = length;
  while (remaining >= 255) {
    segments.push(255);
    remaining -= 255;
  }
  segments.push(remaining);
  return segments;
}

function calculateOggCrc(page) {
  let crc = 0;
  for (const byte of page) {
    const lookup = ((crc >>> 24) ^ byte) & 0xFF;
    crc = ((crc << 8) ^ OGG_CRC_TABLE[lookup]) >>> 0;
  }
  return crc;
}

function createOggPage(packet, { headerType, granulePosition, serial, sequence }) {
  const segments = packetSegments(packet.length);
  if (segments.length > 255) throw new Error('Opus packet is too large for one Ogg page');

  const header = Buffer.alloc(27 + segments.length);
  header.write('OggS', 0);
  header[4] = 0;
  header[5] = headerType;
  header.writeBigUInt64LE(BigInt(granulePosition), 6);
  header.writeUInt32LE(serial >>> 0, 14);
  header.writeUInt32LE(sequence >>> 0, 18);
  header.writeUInt32LE(0, 22);
  header[26] = segments.length;
  segments.forEach((value, index) => { header[27 + index] = value; });

  const page = Buffer.concat([header, packet]);
  page.writeUInt32LE(calculateOggCrc(page), 22);
  return page;
}

function createOpusHead({ channels, sampleRate }) {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0);
  head[8] = 1;
  head[9] = channels;
  head.writeUInt16LE(0, 10);
  head.writeUInt32LE(sampleRate, 12);
  head.writeInt16LE(0, 16);
  head[18] = 0;
  return head;
}

function createOpusTags() {
  const vendor = Buffer.from('Codex Remote');
  const tags = Buffer.alloc(16 + vendor.length);
  tags.write('OpusTags', 0);
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);
  return tags;
}

function wrapOpusPacketsInOgg(packets, options = {}) {
  const normalized = packets.map(normalizeAudioChunk).filter((packet) => packet.length > 0);
  if (normalized.length === 0) throw new Error('No Opus audio frames were received');

  const channels = options.channels || 1;
  const sampleRate = options.sampleRate || 16000;
  const frameSamples = options.frameSamples || 2880;
  const serial = options.serial === undefined ? (Date.now() & 0xFFFFFFFF) : options.serial;
  const pages = [
    createOggPage(createOpusHead({ channels, sampleRate }), {
      headerType: 0x02, granulePosition: 0, serial, sequence: 0
    }),
    createOggPage(createOpusTags(), {
      headerType: 0, granulePosition: 0, serial, sequence: 1
    })
  ];

  let granulePosition = 0;
  normalized.forEach((packet, index) => {
    granulePosition += frameSamples;
    pages.push(createOggPage(packet, {
      headerType: index === normalized.length - 1 ? 0x04 : 0,
      granulePosition,
      serial,
      sequence: index + 2
    }));
  });
  return Buffer.concat(pages);
}

module.exports = {
  createWav,
  normalizeAudioChunk,
  wrapOpusPacketsInOgg
};
