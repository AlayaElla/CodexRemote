const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const MicroProfile = require('./micro-profile');
const { assertReport, encodeHid, BUTTON_KEYS, ENCODER_KEYS } = require('./report-codec');

const MAX_FRAME_BYTES = 65536;
const MAX_PENDING = 64;

class Controller extends EventEmitter {
  constructor(config = {}, options = {}) {
    super();
    this.config = { profile: config.profile || 'codex-micro-v1' };
    this.options = options;
    this.profile = new MicroProfile(this.config.profile, { getBatteryStatus: options.getBatteryStatus });
    this.child = null;
    this.generation = 0;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.ptt = false;
    this.connecting = null;
    this.heartbeat = null;
    this.holdTimer = null;
    this.handshakeWaiter = null;
    this.replyQueue = Promise.resolve();
    this.replyBacklog = 0;
    this.keyQueue = Promise.resolve();
    this.heldControlKeys = new Set();
    this.state = {
      supported: (options.platform || process.platform) === 'win32',
      configured: true,
      connected: false, driverAvailable: false, hidEnumerated: false,
      microConnected: false, profile: this.config.profile, lastError: null,
      handshakeDiagnostics: null
    };
  }

  getStatus() {
    return {
      ...this.state,
      handshakeDiagnostics: this.state.handshakeDiagnostics && { ...this.state.handshakeDiagnostics },
      microConnected: this.state.microConnected && this.profile.isFresh(this.options.freshnessMs || MicroProfile.defaultFreshnessMs)
    };
  }

  brokerPath() {
    if (this.options.brokerPath) return this.options.brokerPath;
    if (this.options.resourcesPath) {
      return path.join(this.options.resourcesPath, 'virtual-micro', 'VirtualMicroBroker.exe');
    }
    return path.resolve(__dirname, '..', '..', '..', 'native', 'virtual-micro-broker',
      'bin', 'Release', 'net9.0-windows', 'win-x64', 'publish', 'VirtualMicroBroker.exe');
  }

  _publish() { this.emit('status', this.getStatus()); }

  _beginDiagnostics() {
    this.state.driverAvailable = false;
    this.state.hidEnumerated = false;
    this.state.connected = false;
    this.state.microConnected = false;
    this.acceptedResponses = 0;
    this.expectedResponses = 0;
    this.state.handshakeDiagnostics = this._diagnostics('starting');
  }

  _diagnostics(phase, failurePhase = null) {
    return {
      driverAvailable: this.state.driverAvailable === true,
      hidEnumerated: this.state.hidEnumerated === true,
      acceptedResponses: this.acceptedResponses || 0,
      phase,
      failurePhase,
      ...this.profile.getHandshakeDiagnostics()
    };
  }

  _updateDiagnostics(phase, failurePhase = null) {
    this.state.handshakeDiagnostics = this._diagnostics(phase, failurePhase);
  }

  _handshakePhase() {
    const info = this.profile.getHandshakeDiagnostics();
    if (!info.hostReports) return 'awaiting_host_reports';
    if (!info.rpcRequests) return 'awaiting_rpc_message';
    if (!info.handshakeComplete) return 'awaiting_required_rpc';
    if (this.acceptedResponses < this.expectedResponses) return 'awaiting_response_acceptance';
    return 'ready';
  }

  _refreshHandshake() {
    const phase = this._handshakePhase();
    this.state.microConnected = this.state.connected && phase === 'ready'
      && this.profile.isFresh(this.options.freshnessMs || MicroProfile.defaultFreshnessMs);
    this._updateDiagnostics(phase);
    if (this.state.microConnected && this.handshakeWaiter) this.handshakeWaiter.resolve();
  }

  _handshakeTimeoutError() {
    const info = this.state.handshakeDiagnostics || this._diagnostics(this._handshakePhase());
    const counts = `收到${info.hostReports}报告，完整 RPC ${info.rpcRequests}，已识别 ${info.knownRequests}，已接受${info.acceptedResponses}响应`;
    if (!info.hostReports) {
      return new Error(`虚拟 Micro 握手超时：未收到主机报告（${counts}）；请核查客户端是否识别到 Codex Micro 设备。`);
    }
    if (!info.rpcRequests) {
      return new Error(`虚拟 Micro 握手超时：已收到报告但未解析出完整 RPC（${counts}）；请核查报文格式。`);
    }
    if (!info.handshakeComplete) {
      return new Error(`虚拟 Micro 握手超时：所需 RPC 未齐，等待设备状态 device.status（${counts}）；可点击重试。`);
    }
    return new Error(`虚拟 Micro 握手超时：RPC 响应尚未确认（${counts}）；请核查客户端设备识别。`);
  }

  _spawn() {
    const child = (this.options.spawn || spawn)(this.brokerPath(), [], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false
    });
    this.child = child;
    const generation = ++this.generation;
    this.buffer = Buffer.alloc(0);
    this.profile.reset();
    this._beginDiagnostics();
    this.replyQueue = Promise.resolve();
    this.replyBacklog = 0;
    const current = () => this.child === child && this.generation === generation;
    child.once('error', error => { if (current()) this._disconnect(`HID broker unavailable: ${error.message}`); });
    child.once('exit', () => { if (current()) this._disconnect('HID broker exited; check ChatGPT recording state.'); });
    child.stdin.on('error', error => { if (current()) this._disconnect(`HID broker input failed: ${error.message}`); });
    child.stdout.on('data', chunk => { if (current()) this._receive(Buffer.from(chunk)); });
    child.stdout.on('error', error => { if (current()) this._disconnect(`HID broker output failed: ${error.message}`); });
    // Drain diagnostics continuously; protocol state comes only from stdout.
    if (child.stderr) child.stderr.on('data', () => {});
  }

  _receive(chunk) {
    let offset = 0;
    while (offset < chunk.length && this.child) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (this.buffer.length + end - offset > MAX_FRAME_BYTES) {
        this._disconnect('HID broker emitted an oversized frame.');
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)]);
      if (newline < 0) return;
      const line = this.buffer.toString('utf8');
      this.buffer = Buffer.alloc(0);
      offset = newline + 1;
      if (line.trim()) this._line(line);
    }
  }

  _line(line) {
    let message;
    try {
      message = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
    } catch {
      this._disconnect('HID broker emitted invalid JSON.');
      return;
    }
    if (message.event === 'fault') {
      this._disconnect(typeof message.message === 'string' ? message.message.slice(0, 1024) : 'HID transport fault.');
      return;
    }
    if (message.event === 'report') {
      const generation = this.generation;
      try {
        if (typeof message.data !== 'string' || message.data.length !== 88
          || !/^[A-Za-z0-9+/]{86}==$/.test(message.data)) throw new Error('Invalid base64 report.');
        const report = assertReport(Buffer.from(message.data, 'base64'));
        const observed = this.profile.observe([report]);
        for (const feedback of observed.feedback) this.emit('feedback', feedback);
        this.expectedResponses += observed.responses.length;
        this._updateDiagnostics(this._handshakePhase());
        if (++this.replyBacklog > MAX_PENDING) throw new Error('Host RPC queue exceeded limit.');
        this.replyQueue = this.replyQueue.then(async () => {
          if (generation !== this.generation || !this.child) return;
          for (const reports of observed.responses) {
            await this._submit(reports);
            // A submission may settle just as the transport disconnects. Do
            // not let that old continuation alter a newly spawned attempt.
            if (generation !== this.generation || !this.child) return;
            this.acceptedResponses = Math.min(Number.MAX_SAFE_INTEGER, this.acceptedResponses + 1);
          }
          if (generation !== this.generation || !this.child) return;
          this._refreshHandshake();
          this._publish();
        }).catch(error => {
          if (generation === this.generation) this._disconnect(`Micro RPC response failed: ${error.message}`);
        }).finally(() => {
          if (generation === this.generation) --this.replyBacklog;
        });
      } catch (error) {
        this._disconnect(`Invalid Micro host report: ${error.message}`);
      }
      return;
    }
    if (typeof message.id !== 'string') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.op === 'connect' && message.result && typeof message.result === 'object' && !Array.isArray(message.result)) {
      // The broker can enumerate the device and then fail transport setup.
      // Preserve those checks before a following fault freezes diagnostics.
      this.state.driverAvailable = message.result.driverAvailable === true;
      this.state.hidEnumerated = message.result.hidEnumerated === true;
      this._updateDiagnostics(message.ok === true ? 'awaiting_host_reports' : 'opening_transport');
    }
    if (message.ok === true && message.result && typeof message.result === 'object') {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(typeof message.error === 'string' ? message.error : 'HID broker rejected request.'));
    }
  }

  _request(op, extra = {}, timeoutMs = this.options.requestTimeoutMs || 4000) {
    const child = this.child;
    if (!child || !child.stdin.writable) return Promise.reject(new Error('HID broker is not running.'));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error('Too many pending HID requests.'));
    const id = `${this.generation}:${++this.nextId}`;
    const frame = JSON.stringify({ id, op, ...extra }) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return Promise.reject(new Error('HID request exceeds frame limit.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`HID ${op} timed out; outcome unknown.`));
      }, timeoutMs);
      this.pending.set(id, {
        op,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      try {
        child.stdin.write(frame, error => {
          if (!error) return;
          const request = this.pending.get(id);
          this.pending.delete(id);
          if (request) request.reject(error);
        });
      } catch (error) {
        const request = this.pending.get(id);
        this.pending.delete(id);
        if (request) request.reject(error);
      }
    });
  }

  _disconnect(reason, fault = true) {
    const child = this.child;
    // A completed attempt has already frozen its diagnostics and released its
    // profile. In particular, close() after a failed connect must not replace
    // that evidence with a reset-profile snapshot.
    if (!child) return;
    this.child = null;
    ++this.generation;
    clearInterval(this.heartbeat);
    clearTimeout(this.holdTimer);
    this.heartbeat = this.holdTimer = null;
    // Preserve the evidence from this attempt before current connection flags reset.
    const phase = this.state.handshakeDiagnostics && this.state.handshakeDiagnostics.phase;
    this._updateDiagnostics(reason ? 'failed' : this._handshakePhase(), reason ? (phase || this._handshakePhase()) : null);
    this.state.connected = false;
    this.state.microConnected = false;
    this.state.hidEnumerated = false;
    this.state.lastError = reason || null;
    this.ptt = false;
    this.heldControlKeys.clear();
    this.buffer = Buffer.alloc(0);
    this.profile.reset();
    const error = new Error(reason || 'HID connection closed.');
    if (this.handshakeWaiter) this.handshakeWaiter.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (child) {
      // EOF gives the broker time to release cached neutral reports.
      try { child.stdin.end(); } catch {}
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, this.options.killTimeoutMs || 1000);
      if (timer.unref) timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
    this._publish();
    if (fault && reason) this.emit('fault', new Error(reason));
  }

  async connect() {
    if (!this.state.supported) throw new Error('Virtual Codex Micro requires Windows.');
    if (this.child && this.getStatus().microConnected && this.state.connected) return this.getStatus();
    if (this.connecting) return this.connecting;
    const operation = this._connect();
    this.connecting = operation;
    try { return await operation; }
    finally { if (this.connecting === operation) this.connecting = null; }
  }

  async _connect() {
    if (this.child) await this.close();
    try {
      this.state.connected = false;
      this.state.driverAvailable = false;
      this.state.hidEnumerated = false;
      this.state.microConnected = false;
      this.state.lastError = null;
      this._spawn();
      this._updateDiagnostics('opening_transport');
      const info = await this._request('connect', {
        releaseReports: this.profile.ptt(false).map(report => report.toString('base64')),
        leaseMs: 5000
      });
      this.state.driverAvailable = info.driverAvailable === true;
      this.state.hidEnumerated = info.hidEnumerated === true;
      this.state.connected = info.connected === true && this.state.driverAvailable && this.state.hidEnumerated;
      if (this.state.connected) this._refreshHandshake();
      else this._updateDiagnostics('driver_or_hid_unavailable');
      if (!this.state.connected) throw new Error(info.lastError || info.error || 'Virtual Micro driver is not ready.');
      const generation = this.generation;
      let heartbeatPending = false;
      this.heartbeat = setInterval(async () => {
        if (heartbeatPending || generation !== this.generation) return;
        heartbeatPending = true;
        try {
          await this._request('heartbeat');
          if (generation !== this.generation) return;
          if (this.state.microConnected && !this.profile.isFresh(this.options.freshnessMs || MicroProfile.defaultFreshnessMs)) {
            throw new Error('Micro host status expired; reconnect and check ChatGPT recording state.');
          }
          this._publish();
        } catch (error) {
          if (generation === this.generation) this._disconnect(error.message);
        } finally { heartbeatPending = false; }
      }, this.options.heartbeatMs || 1000);
      if (this.heartbeat.unref) this.heartbeat.unref();
      this._publish();
      await this._waitForHandshake();
      this.state.lastError = null;
      this._publish();
      return this.getStatus();
    } catch (error) {
      if (this.child) this._disconnect(error.message);
      else { this.state.lastError = error.message; this._publish(); }
      throw error;
    }
  }

  _waitForHandshake() {
    if (this.state.microConnected && this.profile.isFresh(this.options.freshnessMs || MicroProfile.defaultFreshnessMs)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(this._handshakeTimeoutError()),
        this.options.handshakeTimeoutMs || MicroProfile.defaultHandshakeTimeoutMs);
      const finish = error => {
        clearTimeout(timer);
        this.handshakeWaiter = null;
        error ? reject(error) : resolve();
      };
      this.handshakeWaiter = { resolve: () => finish(), reject: finish };
    });
  }

  async _submit(reports) {
    if (!reports.length || reports.length > 64) throw new Error('Invalid HID report batch size.');
    const result = await this._request('submit', { reports: reports.map(report => assertReport(report).toString('base64')) });
    if (result.disposition !== 'Accepted' || result.acceptedReportCount !== reports.length) {
      throw new Error(`HID submission ${result.disposition || 'outcome unknown'} or incomplete batch.`);
    }
    return { delivery: 'submitted_to_hid', outcome: 'unknown' };
  }

  async setPtt(down) {
    if (typeof down !== 'boolean') throw new Error('PTT state must be boolean.');
    if (down && (!this.state.connected || !this.getStatus().microConnected)) {
      throw new Error('Micro handshake is missing or stale.');
    }
    try {
      const result = await this._submit(this.profile.ptt(down));
      this.ptt = down;
      clearTimeout(this.holdTimer);
      if (down) {
        this.holdTimer = setTimeout(async () => {
          try { await this.releaseAll(); } catch {}
          finally { if (this.child) this._disconnect('PTT maximum hold time reached; check ChatGPT recording state.'); }
        }, this.options.maxHoldMs || 120000);
      }
      return result;
    } catch (error) {
      this._disconnect(`PTT outcome unknown: ${error.message}`);
      throw error;
    }
  }

  _assertControlKey(key, kind) {
    if (typeof key !== 'string' || (!BUTTON_KEYS.has(key) && !ENCODER_KEYS.has(key))) {
      throw new Error('Unsupported Micro control key.');
    }
    if (kind !== 'turn' && !BUTTON_KEYS.has(key)) throw new Error('Encoder controls use tapKey or a turn sequence.');
    if (kind === 'turn' && !ENCODER_KEYS.has(key)) throw new Error('Only encoder controls accept turn actions.');
  }

  _ensureControlReady() {
    if (!this.state.connected || !this.getStatus().microConnected) {
      throw new Error('Micro handshake is missing or stale.');
    }
  }

  _queueControl(operation) {
    const queued = this.keyQueue.then(operation);
    // Keep later explicit user actions usable after a failed request. A failed
    // action still disconnects, so callers must reconnect; nothing is replayed.
    this.keyQueue = queued.catch(() => {});
    return queued;
  }

  async _sendControl(key, action, heldState) {
    this._ensureControlReady();
    try {
      const result = await this._submit(encodeHid(key, action));
      if (heldState === true) this.heldControlKeys.add(key);
      if (heldState === false) this.heldControlKeys.delete(key);
      return result;
    } catch (error) {
      this._disconnect(`Micro control outcome unknown: ${error.message}`);
      throw error;
    }
  }

  keyDown(key) {
    this._assertControlKey(key, 'down');
    return this._queueControl(() => this._sendControl(key, 1, true));
  }

  keyUp(key) {
    this._assertControlKey(key, 'up');
    return this._queueControl(() => this._sendControl(key, 0, false));
  }

  tapKey(key) {
    if (ENCODER_KEYS.has(key)) {
      return this._queueControl(() => this._sendControl(key, 2, null));
    }
    this._assertControlKey(key, 'tap');
    return this._queueControl(async () => {
      await this._sendControl(key, 1, true);
      return this._sendControl(key, 0, false);
    });
  }

  executeKeySequence(sequence) {
    if (!Array.isArray(sequence) || !sequence.length || sequence.length > 32) {
      throw new Error('Micro key sequence must contain 1..32 explicit steps.');
    }
    return this._queueControl(async () => {
      let result;
      for (const step of sequence) {
        if (!step || typeof step !== 'object' || typeof step.key !== 'string') throw new Error('Invalid Micro key sequence step.');
        const action = step.action || 'tap';
        if (action === 'down') result = await this._sendControl(step.key, 1, true);
        else if (action === 'up') result = await this._sendControl(step.key, 0, false);
        else if (action === 'tap') {
          if (ENCODER_KEYS.has(step.key)) result = await this._sendControl(step.key, 2, null);
          else {
            this._assertControlKey(step.key, 'tap');
            await this._sendControl(step.key, 1, true);
            result = await this._sendControl(step.key, 0, false);
          }
        } else if (action === 'turn') {
          this._assertControlKey(step.key, 'turn');
          result = await this._sendControl(step.key, 2, null);
        } else throw new Error('Unsupported Micro key sequence action.');
      }
      return result;
    });
  }

  async releaseAll() {
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (!this.child) return { delivery: 'not_sent', outcome: 'unknown' };
    try {
      const result = await this._request('releaseAll', {
        releaseReports: this.profile.ptt(false).map(report => report.toString('base64'))
      });
      if (result.disposition !== 'Accepted' || result.acceptedReportCount !== this.profile.ptt(false).length) {
        throw new Error('HID release outcome was not accepted.');
      }
      this.ptt = false;
      this.heldControlKeys.clear();
      return { delivery: 'submitted_to_hid', outcome: 'unknown' };
    } catch (error) {
      this._disconnect(`PTT release outcome unknown: ${error.message}`);
      throw error;
    }
  }

  async close() {
    try {
      if (this.child) {
        await this.releaseAll();
        if (this.child) await this._request('close', {}, 1000);
      }
    } finally { this._disconnect(null, false); }
  }
}

module.exports = Controller;
