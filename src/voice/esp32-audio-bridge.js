const { EventEmitter } = require('events');
const { spawn: defaultSpawn } = require('child_process');
const path = require('path');

const MAX_LINE_BYTES = 16 * 1024;
const MAX_PACKET_BYTES = 4096;
const MAX_PENDING_BYTES = 512 * 1024;
const MAX_PENDING_REQUESTS = 64;

function helperPath(options = {}) {
  if (options.executablePath) return options.executablePath;
  if (options.resourcesPath) return path.join(options.resourcesPath, 'esp32-audio', 'Esp32AudioBridge.exe');
  return path.join(__dirname, '..', '..', 'native', 'esp32-audio-bridge', 'bin', 'Release', 'net9.0-windows', 'win-x64', 'publish', 'Esp32AudioBridge.exe');
}

function bridgeStatus(source = {}) {
  return {
    ready: Boolean(source.ready), active: Boolean(source.active), packets: Number(source.packets) || 0,
    samples: Number(source.samples) || 0, peak: Number(source.peak) || 0,
    bufferedMs: Number(source.bufferedMs) || 0, lastError: source.lastError || null,
    deviceName: source.deviceName || null, captureName: source.captureName || null
  };
}

class Esp32AudioBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.spawn = options.spawn || defaultSpawn;
    this.executablePath = helperPath(options);
    this.child = null;
    this.runtime = null;
    this.pending = new Map();
    this.pendingBytes = 0;
    this.nextId = 1;
    this.status = bridgeStatus();
    this.preparedDeviceId = null;
    this.preparation = null;
    this.preparationDeviceId = null;
    this.generation = 0;
  }

  getStatus() { return { ...this.status }; }

  updateStatus(result = {}) {
    this.status = bridgeStatus({ ...this.status, ...result });
    this.emit('status', this.getStatus());
    return this.getStatus();
  }

  ensureProcess() {
    if (this.child && !this.child.killed) return this.child;
    let child;
    try {
      child = this.spawn(this.executablePath, [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      this.processFault(error);
      throw error;
    }
    if (!child || !child.stdin || !child.stdout) {
      const error = new Error('ESP32 audio bridge did not provide standard I/O.');
      try { if (child && !child.killed) child.kill(); } catch (killError) {}
      this.processFault(error);
      throw error;
    }
    const runtime = { child, buffer: Buffer.alloc(0) };
    runtime.onData = chunk => this.handleStdout(chunk, runtime);
    runtime.onError = error => { if (this.runtime === runtime) this.processFault(error, runtime); };
    runtime.onExit = (code, signal) => {
      if (this.runtime === runtime) this.processFault(new Error(`ESP32 audio bridge exited (${code === null ? signal || 'unknown' : code}).`), runtime);
    };
    this.child = child;
    this.runtime = runtime;
    child.stdout.on('data', runtime.onData);
    child.once('error', runtime.onError);
    child.once('exit', runtime.onExit);
    child.stdin.once('error', runtime.onError);
    return child;
  }

  detachProcess(runtime, kill = true) {
    if (!runtime) return;
    const { child } = runtime;
    if (child && child.stdout && runtime.onData) child.stdout.removeListener('data', runtime.onData);
    if (child && child.removeListener) {
      child.removeListener('exit', runtime.onExit);
    }
    // Keep the guarded error listeners until the old process/pipe is collected.
    // Killing a helper with a queued write can emit EPIPE asynchronously; the
    // runtime identity check makes that late error harmless to a replacement.
    if (kill && child && !child.killed) {
      try { child.kill(); } catch (error) {}
    }
  }

  rejectPending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    this.pendingBytes = 0;
  }

  processFault(error, runtime = this.runtime) {
    const message = error && error.message ? error.message : String(error || 'ESP32 audio bridge failed.');
    if (runtime && this.runtime && runtime !== this.runtime) return;
    const currentRuntime = runtime || this.runtime;
    this.invalidatePreparation();
    this.child = null;
    this.runtime = null;
    this.detachProcess(currentRuntime, true);
    this.rejectPending(message);
    this.updateStatus({ ready: false, active: false, bufferedMs: 0, lastError: message });
    this.emit('fault', new Error(message));
  }

  handleStdout(chunk, runtime) {
    if (this.runtime !== runtime) return;
    let remaining = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (remaining.length) {
      const newline = remaining.indexOf(0x0a);
      if (newline < 0) {
        if (runtime.buffer.length + remaining.length > MAX_LINE_BYTES) {
          this.processFault(new Error('ESP32 audio bridge returned an oversized JSONL message.'), runtime);
          return;
        }
        runtime.buffer = runtime.buffer.length ? Buffer.concat([runtime.buffer, remaining]) : Buffer.from(remaining);
        return;
      }
      if (runtime.buffer.length + newline > MAX_LINE_BYTES) {
        this.processFault(new Error('ESP32 audio bridge returned an oversized JSONL message.'), runtime);
        return;
      }
      const line = runtime.buffer.length
        ? Buffer.concat([runtime.buffer, remaining.subarray(0, newline)])
        : remaining.subarray(0, newline);
      runtime.buffer = Buffer.alloc(0);
      remaining = remaining.subarray(newline + 1);
      this.handleLine(line.toString('utf8').replace(/\r$/, ''), runtime);
      if (this.runtime !== runtime) return;
    }
  }

  handleLine(line, runtime = this.runtime) {
    if (this.runtime !== runtime) return;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      this.processFault(new Error('ESP32 audio bridge returned an oversized JSONL message.'));
      return;
    }
    let response;
    try { response = JSON.parse(line); } catch (error) {
      this.processFault(new Error('ESP32 audio bridge returned invalid JSONL.'), runtime);
      return;
    }
    if (response && response.event === 'fault') {
      this.processFault(new Error(response.error || 'ESP32 audio bridge fault.'), runtime);
      return;
    }
    const pending = this.pending.get(response && response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    this.pendingBytes -= pending.bytes;
    clearTimeout(pending.timeout);
    if (!response.ok) {
      const error = new Error(response.error || `ESP32 audio bridge ${pending.op} failed.`);
      this.updateStatus({ lastError: error.message });
      pending.reject(error);
      return;
    }
    const details = response.result && typeof response.result === 'object' ? response.result : response;
    this.updateStatus(details);
    pending.resolve({ ...response, ...details });
  }

  request(op, payload = {}, timeoutMs) {
    if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error('ESP32 audio bridge request queue is full.'));
    const id = String(this.nextId++);
    const request = { id, op, ...payload };
    const line = JSON.stringify(request);
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_LINE_BYTES) return Promise.reject(new Error('ESP32 audio bridge request exceeds the JSONL size limit.'));
    if (this.pendingBytes + bytes > MAX_PENDING_BYTES) return Promise.reject(new Error('ESP32 audio bridge audio queue is full.'));
    let child;
    try { child = this.ensureProcess(); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return;
        const error = new Error(`ESP32 audio bridge ${op} timed out.`);
        this.processFault(error);
      }, timeoutMs);
      this.pending.set(id, { op, bytes, timeout, resolve, reject });
      this.pendingBytes += bytes;
      try {
        const wrote = child.stdin.write(`${line}\n`, 'utf8');
        if (!wrote) child.stdin.once('drain', () => {});
      } catch (error) { this.processFault(error); }
    });
  }

  async list() {
    const result = await this.request('list', {}, 10000);
    return Array.isArray(result.devices) ? result.devices : [];
  }

  invalidatePreparation() {
    this.generation += 1;
    this.preparedDeviceId = null;
    this.preparation = null;
    this.preparationDeviceId = null;
  }

  prepare(deviceId = '') {
    if (this.status.active) return Promise.reject(new Error('ESP32 audio bridge is already active.'));
    if (this.preparedDeviceId === deviceId && this.child && !this.child.killed && this.status.ready) {
      return Promise.resolve(this.getStatus());
    }
    if (this.preparation && this.preparationDeviceId === deviceId) return this.preparation;
    if (this.preparation || this.preparedDeviceId !== null) this.closeProcess();
    const generation = this.generation;
    const operation = (async () => {
      try {
        // Open the decoder and silent render endpoint before PTT. No ESP32
        // capture is requested and append() remains gated by active.
        const result = await this.request('start', deviceId ? { deviceId } : {}, 10000);
        if (generation !== this.generation || !this.child || this.child.killed) {
          throw new Error('ESP32 audio preparation was cancelled.');
        }
        this.preparedDeviceId = deviceId;
        return this.updateStatus({
          ...result,
          deviceName: result.deviceName || result.name || this.status.deviceName,
          captureName: result.captureName || this.status.captureName,
          ready: true, active: false, bufferedMs: 0, lastError: null
        });
      } catch (error) {
        if (generation === this.generation) {
          this.closeProcess();
          this.updateStatus({ ready: false, active: false, lastError: error.message });
        }
        throw error;
      } finally {
        if (this.preparation === operation) {
          this.preparation = null;
          this.preparationDeviceId = null;
        }
      }
    })();
    this.preparation = operation;
    this.preparationDeviceId = deviceId;
    return operation;
  }

  async start(deviceId = '') {
    await this.prepare(deviceId);
    if (this.preparedDeviceId !== deviceId || !this.child || this.child.killed || !this.status.ready) {
      throw new Error('ESP32 audio preparation was cancelled before recording.');
    }
    return this.updateStatus({
      ready: true, active: true, packets: 0, samples: 0, peak: 0, bufferedMs: 0, lastError: null
    });
  }

  async append(packet) {
    const data = Buffer.isBuffer(packet) ? packet
      : packet instanceof Uint8Array ? Buffer.from(packet)
        : packet instanceof ArrayBuffer ? Buffer.from(packet) : null;
    if (!data || data.length === 0) throw new Error('ESP32 audio packet must not be empty.');
    if (data.length > MAX_PACKET_BYTES) throw new Error(`ESP32 audio packet exceeds ${MAX_PACKET_BYTES} bytes.`);
    if (!this.status.active) throw new Error('ESP32 audio bridge is not active.');
    await this.request('append', { packet: data.toString('base64') }, 3000);
    return this.getStatus();
  }

  async stop() {
    try {
      const result = await this.request('stop', {}, 5000);
      this.preparedDeviceId = null;
      // Native stop releases this recording's decoder and WASAPI session.
      // Keep only the process so the next preparation avoids another CLR start.
      return this.updateStatus({ ...result, ready: false, active: false, bufferedMs: 0 });
    } catch (error) {
      this.closeProcess();
      this.updateStatus({ ready: false, active: false, bufferedMs: 0, lastError: error.message });
      throw error;
    }
  }

  async cancel() {
    const child = this.child;
    if (child && child.stdin && !child.killed) {
      try { child.stdin.write(`${JSON.stringify({ id: String(this.nextId++), op: 'cancel' })}\n`, 'utf8'); } catch (error) {}
    }
    this.closeProcess();
    return this.updateStatus({ active: false, ready: false, bufferedMs: 0 });
  }

  async discard() {
    if (this.preparedDeviceId === null || !this.child || this.child.killed || !this.status.ready) {
      return this.cancel();
    }
    const generation = this.generation;
    this.updateStatus({ active: false });
    try {
      const result = await this.request('discard', {}, 3000);
      if (result.discarded !== true || generation !== this.generation || !this.child || this.child.killed) {
        throw new Error('Audio discard did not retain the prepared endpoint.');
      }
      return this.updateStatus({ ready: true, active: false, packets: 0, samples: 0, peak: 0, bufferedMs: 0 });
    } catch (error) {
      if (generation === this.generation) await this.cancel();
      throw error;
    }
  }

  closeProcess() {
    this.invalidatePreparation();
    const runtime = this.runtime;
    this.child = null;
    this.runtime = null;
    this.detachProcess(runtime, true);
    this.rejectPending('ESP32 audio bridge was closed.');
  }

  async dispose() { return this.cancel(); }
}

module.exports = Esp32AudioBridge;
module.exports.helperPath = helperPath;
module.exports.bridgeStatus = bridgeStatus;
module.exports.MAX_LINE_BYTES = MAX_LINE_BYTES;
module.exports.MAX_PACKET_BYTES = MAX_PACKET_BYTES;
