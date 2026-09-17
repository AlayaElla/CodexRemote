const ID = /^[\w.:-]{1,192}$/;
const REQUEST_ID = /^[\w.:-]{1,128}$/;
const CHUNK_BYTES = 8192;
const MAX_QUEUE = 12;
const VOICE_WAIT_MS = 15000;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sent = result => result === true || result?.success === true;
const keyFor = input => `${input.host_id}\0${input.thread_id}\0${input.request_id}\0${input.media_id}\0${input.variant}`;

class CodexMediaTransfer {
  constructor({ media, send, getTarget, isVoiceBusy = () => false }) {
    this.media = media; this.send = send; this.getTarget = getTarget; this.isVoiceBusy = isVoiceBusy;
    this.queue = []; this.jobs = new Map(); this.completed = new Set(); this.active = false; this.generation = 0;
  }

  // Call whenever the device session or selected task changes. In-flight work
  // observes the generation before every send and cannot cross to a new task.
  cancel() { this.generation += 1; this.queue = []; }

  enqueue(input) {
    if (!input || input.host_id !== 'local' || !REQUEST_ID.test(input.request_id || '') || !ID.test(input.thread_id || '') ||
        !ID.test(input.media_id || '') || !['thumb', 'full'].includes(input.variant)) return false;
    const key = keyFor(input); const previous = this.jobs.get(key);
    if (previous) return true;
    if (this.completed.has(key)) return true;
    if (this.queue.length >= MAX_QUEUE) return false;
    const job = { input: { host_id: input.host_id, thread_id: input.thread_id, request_id: input.request_id, media_id: input.media_id, variant: input.variant }, generation: this.generation, key };
    this.jobs.set(key, job); this.queue.push(job); void this.pump(); return true;
  }

  valid(job) {
    const target = this.getTarget?.();
    return job.generation === this.generation && target?.hostId === job.input.host_id && target?.threadId === job.input.thread_id;
  }

  voiceBusy() {
    try { return this.isVoiceBusy() === true; } catch (_) { return true; }
  }

  async sendMessage(message) {
    try { return sent(await this.send(message)); } catch (_) { return false; }
  }

  rememberCompleted(key) {
    this.completed.add(key);
    if (this.completed.size > 128) this.completed.delete(this.completed.values().next().value);
  }

  async pump() {
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift(); const input = job.input;
        if (!this.valid(job)) { this.jobs.delete(job.key); continue; }
        const base = { request_id: input.request_id, host_id: input.host_id, thread_id: input.thread_id, media_id: input.media_id, variant: input.variant };
        try {
          const image = await this.media.resolveForTask(input.thread_id, input.media_id, input.variant === 'thumb' ? 'thumbnail' : 'full');
          if (!this.valid(job)) continue;
          if (!image || !Buffer.isBuffer(image.data) || image.data.length === 0 || !ID.test(image.format || '') || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)) throw new Error('图片无法加载');
          let delivered = true;
          for (let offset = 0; offset < image.data.length; offset += CHUNK_BYTES) {
            if (!this.valid(job)) { delivered = false; break; }
            const busySince = Date.now();
            while (this.voiceBusy() && this.valid(job) && Date.now() - busySince < VOICE_WAIT_MS) await sleep(50);
            if (!this.valid(job) || this.voiceBusy()) throw new Error('语音期间暂停图片加载');
            const chunk = image.data.subarray(offset, offset + CHUNK_BYTES);
            if (!await this.sendMessage({ ...base, type: 'codex_media_chunk', format: image.format, width: image.width, height: image.height,
              total_bytes: image.data.length, offset, data: chunk.toString('base64'), done: offset + chunk.length === image.data.length })) { delivered = false; break; }
            await sleep(0);
          }
          if (delivered && this.valid(job)) this.rememberCompleted(job.key);
        } catch (_) {
          if (this.valid(job)) await this.sendMessage({ ...base, type: 'codex_media_error', error: '图片加载失败，可重试' });
        } finally { this.jobs.delete(job.key); }
      }
    } finally {
      this.active = false;
      // enqueue() can run while the previous job is unwinding after cancel().
      if (this.queue.length) void this.pump();
    }
  }
}

module.exports = CodexMediaTransfer;
