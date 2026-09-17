const crypto = require('node:crypto');
const dnsNative = require('node:dns');
const fsNative = require('node:fs');
const httpsNative = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { clipText } = require('./codex-conversation-history');

const MAX_REFERENCES_PER_TASK = 128;
const MAX_TASKS = 32;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const RECENT_MESSAGE_LIMIT = 30;
const MAX_PARTS_PER_MESSAGE = 8;
const MAX_TEXT_PART_BYTES = 1024;
const MAX_MESSAGE_TEXT_BYTES = 1024;
const MAX_PREPARED_TEXT_BYTES = 64 * 1024;
const MAX_PREPARED_BYTES = 192 * 1024;
const VARIANTS = Object.freeze({
  thumbnail: Object.freeze({ maxDimension: 256, maxBytes: 128 * 1024 }),
  full: Object.freeze({ maxDimension: 640, maxBytes: 820 * 1024 })
});
const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i;
const BARE_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function safeId(value, maximum = 192) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0') ? value : null;
}

function safeDimension(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 16384 ? value : null;
}

function safeAlt(value) {
  return clipUtf8(clipText(value), 256) || null;
}

function clipUtf8(value, maximum) {
  if (typeof value !== 'string' || maximum <= 0) return '';
  const bytes = Buffer.from(value);
  if (bytes.length <= maximum) return value;
  let end = maximum;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function isPublicIp(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    return mapped == null ? true : isPublicIp(mapped[1]);
  }
  return false;
}

function isSafeRemoteReference(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return false;
  let url;
  try { url = new URL(value); } catch (_) { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.hostname.length > 253) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  return net.isIP(host) === 0 || isPublicIp(host);
}

function dataUrlByteLength(value) {
  const match = DATA_IMAGE.exec(value);
  if (match == null) return null;
  const encoded = match[2];
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.floor(encoded.length * 3 / 4) - padding;
}

function normalizeReference(ref) {
  if (!ref || typeof ref !== 'object' || typeof ref.source !== 'string') return null;
  let source = ref.source;
  if (ref.kind === 'generatedResult' && !source.startsWith('data:') && BARE_BASE64.test(source)) source = `data:image/png;base64,${source}`;
  const dataBytes = dataUrlByteLength(source);
  if (dataBytes !== null) return dataBytes <= MAX_SOURCE_BYTES ? { type: 'data', source } : null;
  if (isSafeRemoteReference(source)) return { type: 'remote', source };
  let localPath = null;
  try {
    // Codex Markdown renders Windows absolute paths as /D:/..., while the
    // filesystem APIs require D:/.... Keep ordinary POSIX/UNC paths intact.
    if (/^\/[A-Za-z]:[\\/]/.test(source)) source = source.slice(1);
    localPath = source.startsWith('file:') ? fileURLToPath(source) : (path.isAbsolute(source) || path.win32.isAbsolute(source) ? source : null);
  } catch (_) { localPath = null; }
  return localPath == null || localPath.length > 32768 || localPath.includes('\0') ? null : { type: 'local', source: localPath };
}

function referenceKey(reference) {
  return `${reference.type}\0${reference.source}`;
}

function loadNativeImage() {
  try { return require('electron').nativeImage; } catch (_) { return null; }
}

function rgb565LittleEndian(image, variant) {
  if (!image || typeof image.getSize !== 'function' || typeof image.resize !== 'function' || typeof image.toBitmap !== 'function' || (typeof image.isEmpty === 'function' && image.isEmpty())) return null;
  const sourceSize = image.getSize();
  if (!safeDimension(sourceSize?.width) || !safeDimension(sourceSize?.height) || sourceSize.width * sourceSize.height > MAX_SOURCE_PIXELS) return null;
  const scale = Math.min(1, variant.maxDimension / Math.max(sourceSize.width, sourceSize.height));
  const width = Math.max(1, Math.round(sourceSize.width * scale));
  const height = Math.max(1, Math.round(sourceSize.height * scale));
  if (width * height * 2 > variant.maxBytes) return null;
  const resized = image.resize({ width, height, quality: 'good' });
  const bitmap = resized.toBitmap();
  if (!Buffer.isBuffer(bitmap) || bitmap.length < width * height * 4) return null;
  const data = Buffer.allocUnsafe(width * height * 2);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const input = pixel * 4;
    const alpha = bitmap[input + 3] / 255;
    const blue = Math.round(bitmap[input] * alpha);
    const green = Math.round(bitmap[input + 1] * alpha);
    const red = Math.round(bitmap[input + 2] * alpha);
    const packed = ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3);
    data[pixel * 2] = packed & 0xff;
    data[pixel * 2 + 1] = packed >> 8;
  }
  return { data, width, height, format: 'rgb565le' };
}

class CodexMedia {
  constructor(options = {}) {
    this.nativeImage = options.nativeImage || loadNativeImage();
    this.fs = options.fs || fsNative;
    this.dnsLookup = options.dnsLookup || dnsNative.promises.lookup;
    this.httpsRequest = options.httpsRequest || httpsNative.request;
    this.maxCacheBytes = Number.isSafeInteger(options.maxCacheBytes) && options.maxCacheBytes > 0 ? options.maxCacheBytes : MAX_CACHE_BYTES;
    this.maxReferencesPerTask = Number.isSafeInteger(options.maxReferencesPerTask) && options.maxReferencesPerTask > 0 ? options.maxReferencesPerTask : MAX_REFERENCES_PER_TASK;
    this.maxTasks = Number.isSafeInteger(options.maxTasks) && options.maxTasks > 0 ? options.maxTasks : MAX_TASKS;
    this.onMediaRegistered = typeof options.onMediaRegistered === 'function' ? options.onMediaRegistered : null;
    this.referencesByTask = new Map();
    this.idsByReference = new Map();
    this.cache = new Map();
    this.cacheBytes = 0;
    this.inflight = new Map();
    this.taskTouched = new Map();
    this.touchCounter = 0;
  }

  prepareMessages(threadId, messages) {
    const taskId = safeId(threadId);
    if (taskId == null || !Array.isArray(messages)) return [];
    const recent = this._recentMessages(messages);
    this._retainTaskReferences(taskId, this._recentReferenceKeys(recent));
    const prepared = []; let textBytes = 0; let serializedBytes = 2;
    // Allocate limited media IDs from newest to oldest. A busy task can have
    // more than 128 images in 30 messages, so recent images win deterministically.
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const message = this._prepareMessage(taskId, recent[index], () => textBytes, value => { textBytes += Buffer.byteLength(value); });
      if (message == null) continue;
      const size = Buffer.byteLength(JSON.stringify(message)) + 1;
      if (serializedBytes + size > MAX_PREPARED_BYTES && prepared.length > 0) continue;
      serializedBytes += size;
      prepared.push(message);
    }
    return prepared.reverse();
  }

  async resolveForTask(threadId, mediaId, variant) {
    const taskId = safeId(threadId); const id = safeId(mediaId); const rules = VARIANTS[variant];
    if (taskId == null || id == null || rules == null) return null;
    const entry = this.referencesByTask.get(taskId)?.get(id);
    if (entry == null) return null;
    const cacheKey = `${taskId}\0${id}\0${variant}`;
    const cached = this._getCache(cacheKey);
    if (cached != null) return { ...cached, data: Buffer.from(cached.data) };
    const pending = this.inflight.get(cacheKey);
    if (pending != null) return pending;
    const request = this._resolve(entry, rules).then(result => {
      // A later snapshot may have evicted this opaque ID while decoding. Do
      // not reinsert its bitmap after that snapshot has reclaimed the media.
      if (result != null && this.referencesByTask.get(taskId)?.get(id) === entry) this._putCache(cacheKey, result);
      return result == null ? null : { ...result, data: Buffer.from(result.data) };
    }).finally(() => { this.inflight.delete(cacheKey); });
    this.inflight.set(cacheKey, request);
    return request;
  }

  _register(threadId, ref) {
    const normalized = normalizeReference(ref);
    if (normalized == null) return null;
    const { entries, ids } = this._ensureTask(threadId);
    const normalizedKey = referenceKey(normalized);
    const existing = ids.get(normalizedKey);
    if (existing != null) return existing;
    if (entries.size >= this.maxReferencesPerTask) return null;
    const mediaId = `media_${crypto.randomUUID().replace(/-/g, '')}`;
    entries.set(mediaId, normalized); ids.set(normalizedKey, mediaId);
    try { this.onMediaRegistered?.({ threadId, mediaId }); } catch (_) {}
    return mediaId;
  }

  _recentMessages(messages) {
    const recent = []; const seen = new Set();
    for (let index = messages.length - 1; index >= 0 && recent.length < RECENT_MESSAGE_LIMIT; index -= 1) {
      const value = messages[index];
      const id = safeId(value?.id);
      const role = value?.role === 'user' || value?.role === 'codex' ? value.role : null;
      if (id == null || role == null || seen.has(id)) continue;
      seen.add(id); recent.push(value);
    }
    return recent.reverse();
  }

  _recentReferenceKeys(messages) {
    const keys = new Set();
    for (let messageIndex = messages.length - 1; messageIndex >= 0 && keys.size < this.maxReferencesPerTask; messageIndex -= 1) {
      const parts = Array.isArray(messages[messageIndex]?.content) ? messages[messageIndex].content.slice(0, MAX_PARTS_PER_MESSAGE) : [];
      for (let partIndex = parts.length - 1; partIndex >= 0 && keys.size < this.maxReferencesPerTask; partIndex -= 1) {
        if (parts[partIndex]?.type !== 'image') continue;
        const normalized = normalizeReference(parts[partIndex].mediaRef);
        if (normalized != null) keys.add(referenceKey(normalized));
      }
    }
    return keys;
  }

  _prepareMessage(taskId, message, getTextBytes, addTextBytes) {
    const id = safeId(message?.id);
    const role = message?.role === 'user' || message?.role === 'codex' ? message.role : null;
    if (id == null || role == null) return null;
    const content = []; let hasImage = false;
    const appendText = value => {
      const remaining = Math.max(0, MAX_PREPARED_TEXT_BYTES - getTextBytes());
      const text = clipUtf8(clipText(value), Math.min(MAX_TEXT_PART_BYTES, remaining));
      if (!text) return false;
      content.push({ type: 'text', text }); addTextBytes(text); return true;
    };
    const parts = Array.isArray(message.content) ? message.content.slice(0, MAX_PARTS_PER_MESSAGE) : [];
    for (const part of parts) {
      if (content.length >= MAX_PARTS_PER_MESSAGE) break;
      if (part?.type === 'text') { appendText(part.text); continue; }
      if (part?.type !== 'image') continue;
      hasImage = true;
      const mediaId = this._register(taskId, part.mediaRef);
      if (mediaId != null) content.push({ type: 'image', mediaId, width: safeDimension(part.width), height: safeDimension(part.height), alt: safeAlt(part.alt) });
    }
    // Raw message.text can include an image URL/path. It is only a fallback
    // for a message without structured image parts, never for an image row.
    if (content.length === 0 && !hasImage) appendText(message.text);
    if (content.length === 0 && hasImage) {
      const alt = parts.find(part => part?.type === 'image')?.alt;
      const placeholder = safeAlt(alt) ? `图片：${safeAlt(alt)}` : '图片不可用';
      const before = getTextBytes();
      if (!appendText(placeholder)) content.push({ type: 'text', text: '图片' });
      else if (getTextBytes() === before) content.push({ type: 'text', text: '图片' });
    }
    if (content.length === 0) return null;
    const contentText = content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const remaining = Math.max(0, MAX_PREPARED_TEXT_BYTES - getTextBytes());
    const text = clipUtf8(contentText, Math.min(MAX_MESSAGE_TEXT_BYTES, remaining));
    if (text) addTextBytes(text);
    return { id, role, text, content, turnId: safeId(message.turnId) };
  }

  _ensureTask(taskId) {
    let entries = this.referencesByTask.get(taskId);
    let ids = this.idsByReference.get(taskId);
    if (entries == null || ids == null) {
      while (this.referencesByTask.size >= this.maxTasks) {
        const oldest = this.taskTouched.keys().next().value;
        if (oldest == null) break;
        this._dropTask(oldest);
      }
      entries = new Map(); ids = new Map();
      this.referencesByTask.set(taskId, entries); this.idsByReference.set(taskId, ids);
    }
    this._touchTask(taskId);
    return { entries, ids };
  }

  _touchTask(taskId) {
    this.taskTouched.delete(taskId);
    this.taskTouched.set(taskId, ++this.touchCounter);
  }

  _retainTaskReferences(taskId, retainedKeys) {
    const entries = this.referencesByTask.get(taskId); const ids = this.idsByReference.get(taskId);
    if (entries == null || ids == null) return;
    for (const [key, mediaId] of ids) {
      if (retainedKeys.has(key)) continue;
      ids.delete(key); entries.delete(mediaId); this._dropMediaCache(taskId, mediaId);
    }
    if (entries.size === 0) { this.referencesByTask.delete(taskId); this.idsByReference.delete(taskId); this.taskTouched.delete(taskId); }
    else this._touchTask(taskId);
  }

  _dropTask(taskId) {
    const entries = this.referencesByTask.get(taskId);
    for (const mediaId of entries?.keys() || []) this._dropMediaCache(taskId, mediaId);
    this.referencesByTask.delete(taskId); this.idsByReference.delete(taskId); this.taskTouched.delete(taskId);
  }

  _dropMediaCache(taskId, mediaId) {
    const prefix = `${taskId}\0${mediaId}\0`;
    for (const key of this.cache.keys()) {
      if (!key.startsWith(prefix)) continue;
      const value = this.cache.get(key); this.cache.delete(key); this.cacheBytes -= value.data.length;
    }
  }

  async _resolve(entry, rules) {
    if (this.nativeImage == null) return null;
    let image;
    try {
      if (entry.type === 'data') image = this.nativeImage.createFromDataURL(entry.source);
      else if (entry.type === 'local') image = await this._readLocal(entry.source);
      else if (entry.type === 'remote') image = this.nativeImage.createFromBuffer(await this._readRemote(entry.source));
      else return null;
    } catch (_) { return null; }
    return rgb565LittleEndian(image, rules);
  }

  async _readLocal(source) {
    const realPath = await this.fs.promises.realpath(source);
    const stat = await this.fs.promises.stat(realPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SOURCE_BYTES) throw new Error('local image is unavailable');
    return this.nativeImage.createFromPath(realPath);
  }

  _readRemote(source, redirects = 0) {
    if (!isSafeRemoteReference(source)) return Promise.reject(new Error('unsafe remote image'));
    const url = new URL(source);
    const lookup = (hostname, options, callback) => {
      Promise.resolve(this.dnsLookup(hostname, { all: true, verbatim: true })).then(result => {
        const addresses = Array.isArray(result) ? result : [result];
        const safe = addresses.find(address => address && isPublicIp(address.address));
        if (safe == null) throw new Error('remote image resolved to a private address');
        callback(null, safe.address, safe.family);
      }).catch(error => callback(error));
    };
    return new Promise((resolve, reject) => {
      const request = this.httpsRequest(url, { method: 'GET', headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' }, lookup, agent: false }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (redirects >= 3 || typeof response.headers?.location !== 'string') {
            reject(new Error('remote image redirect limit exceeded')); return;
          }
          let next;
          try { next = new URL(response.headers.location, url).href; }
          catch (_) { reject(new Error('invalid remote image redirect')); return; }
          // Each hop repeats URL and DNS validation; redirects cannot bypass
          // the existing private-network and HTTPS restrictions.
          this._readRemote(next, redirects + 1).then(resolve, reject);
          return;
        }
        const contentType = String(response.headers?.['content-type'] || '').split(';', 1)[0].toLowerCase();
        const length = Number(response.headers?.['content-length']);
        if (response.statusCode !== 200 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType) || (Number.isFinite(length) && length > MAX_SOURCE_BYTES)) {
          response.resume(); reject(new Error('remote image was rejected')); return;
        }
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_SOURCE_BYTES) { request.destroy(new Error('remote image is too large')); return; }
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => resolve(Buffer.concat(chunks, bytes)));
      });
      request.setTimeout(5000, () => request.destroy(new Error('remote image timed out')));
      request.once('error', reject);
      request.end();
    });
  }

  _getCache(key) {
    const value = this.cache.get(key);
    if (value == null) return null;
    this.cache.delete(key); this.cache.set(key, value);
    return value;
  }

  _putCache(key, value) {
    if (!Buffer.isBuffer(value.data) || value.data.length > this.maxCacheBytes) return;
    const existing = this.cache.get(key);
    if (existing != null) { this.cache.delete(key); this.cacheBytes -= existing.data.length; }
    while (this.cache.size > 0 && this.cacheBytes + value.data.length > this.maxCacheBytes) {
      const oldestKey = this.cache.keys().next().value;
      const oldest = this.cache.get(oldestKey);
      this.cache.delete(oldestKey); this.cacheBytes -= oldest.data.length;
    }
    this.cache.set(key, { ...value, data: Buffer.from(value.data) }); this.cacheBytes += value.data.length;
  }
}

module.exports = { CodexMedia, VARIANTS, isPublicIp, isSafeRemoteReference, normalizeReference, rgb565LittleEndian };
