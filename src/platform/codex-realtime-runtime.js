const { EventEmitter } = require('node:events');
const { randomBytes, randomUUID } = require('node:crypto');
const { findCodexProcess, runtimeSocketPath } = require('../core/codex-micro-slots');
const WebSocket = require('ws');
const net = require('node:net');
const findRealtimeControls = require('./codex-realtime-controls');
const installRealtimeRuntime = require('./codex-native-voice-host');
const { nativeVoiceRenderer, startNativeVoice } = require('./codex-native-voice');

// This adapter is deliberately tied to the inspected 26.915.4065.0 renderer.
// It uses semantic aria names and native task voice runtime checks; neither is
// an OpenAI public control API.  A changed renderer fails closed.
const APP_PRIMARY = 'app-primary-355549b35da9.js';

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function connectInspector() {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const request = http.get('http://127.0.0.1:9229/json/list', { timeout: 500 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 16384) request.destroy(new Error('Inspector response is too large.')); });
      response.on('end', () => {
        try {
          const target = JSON.parse(body).find(value => value.type === 'node');
          if (!target || !/^ws:\/\/127\.0\.0\.1:9229\/[\w-]+$/.test(target.webSocketDebuggerUrl || '')) throw new Error('Codex local inspector is unavailable.');
          const socket = new WebSocket(target.webSocketDebuggerUrl);
          const timer = setTimeout(() => { socket.terminate(); reject(new Error('Codex local inspector timed out.')); }, 1500);
          socket.once('open', () => { clearTimeout(timer); resolve(makeInspector(socket)); });
          socket.once('error', error => { clearTimeout(timer); reject(error); });
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Codex local inspector is unavailable.')));
    request.on('error', reject);
  });
}

function makeInspector(socket) {
  let nextId = 0;
  return {
    close: () => socket.close(),
    evaluate(expression) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const finish = (error, value) => { clearTimeout(timer); socket.off('message', onMessage); socket.off('close', onClose); error ? reject(error) : resolve(value); };
        const onClose = () => finish(new Error('Codex local inspector disconnected.'));
        const onMessage = raw => {
          const message = JSON.parse(raw);
          if (message.id !== id) return;
          if (message.error || message.result?.exceptionDetails) finish(new Error(message.result?.exceptionDetails?.exception?.description || 'Codex runtime evaluation failed.'));
          else finish(null, message.result?.result?.value);
        };
        const timer = setTimeout(() => finish(new Error('Codex runtime evaluation timed out.')), 8000);
        socket.on('message', onMessage); socket.once('close', onClose);
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      });
    }
  };
}

function readPipe(pipePath, token, type, payload = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath); socket.setEncoding('utf8'); let body = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Codex realtime runtime timed out.')); }, 25000);
    socket.on('connect', () => socket.write(JSON.stringify({ token, type, ...payload }) + '\n'));
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 65536) { socket.destroy(); clearTimeout(timer); reject(new Error('Codex realtime response is too large.')); } });
    socket.on('end', () => {
      clearTimeout(timer);
      try { const result = JSON.parse(body); if (result.error) throw new Error(result.error); resolve(result.snapshot); }
      catch (error) { reject(error); }
    });
  });
}

class CodexRealtimeRuntime extends EventEmitter {
  constructor(options = {}) {
    super(); this.platform = options.platform || process.platform; this.findProcess = options.findProcess || (() => findCodexProcess({ platform: this.platform }));
    this.connectInspector = options.connectInspector || connectInspector; this.readPipe = options.readPipe || readPipe; this.requestImpl = options.request || null;
    this.getContext = options.getContext || (() => null); this.activateTask = options.activateTask || (async () => {}); this.pipePath = null; this.token = null; this.owner = null; this.ownerContext = null; this.connecting = null; this.queue = Promise.resolve(); this.lastState = null; this.pollTimer = null; this.voiceSessionId = null; this.voiceConversationId = null;
  }
  on(...args) { return super.on(...args); }
  enqueue(task) { const next = this.queue.catch(() => {}).then(task); this.queue = next; return next; }
  async ensure() {
    if (this.platform !== 'win32') throw new Error('Codex realtime runtime currently supports Windows only.');
    if (this.pipePath) return; if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const target = await this.findProcess(); let inspector;
      try {
        try { inspector = await this.connectInspector(); }
        catch (_) { throw new Error(require('./codex-inspector-policy').WINDOWS_INSPECTOR_REQUIRED); }
        if (!inspector) throw new Error('Unable to establish the Codex desktop runtime.');
        const identity = await inspector.evaluate('({pid:process.pid,executable:process.execPath})');
        if (identity?.pid !== target.pid || String(identity.executable || '').toLowerCase() !== String(target.executable || '').toLowerCase()) throw new Error('Codex process identity mismatch.');
        const pipePath = runtimeSocketPath('win32', target.pid, randomUUID()); const token = randomBytes(32).toString('hex');
        await inspector.evaluate(`(${installRealtimeRuntime.toString()})(${JSON.stringify({ pipePath, token, controlLocatorSource: findRealtimeControls.toString(), rendererSource: nativeVoiceRenderer.toString(), coordinatorSource: startNativeVoice.toString() })})`);
        this.pipePath = pipePath; this.token = token; this.owner = target;
      } finally { inspector?.close(); }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async request(type, payload = {}) {
    try {
      const request = payload.target ? payload : { ...payload, target: this.ownerContext };
      if (this.requestImpl) { const result = await this.requestImpl(type, request); this.note(result); return result; }
      await this.ensure(); const result = await this.readPipe(this.pipePath, this.token, type, request); this.note(result); return result;
    } catch (error) { throw error; }
  }
  note(state) { if (!state || typeof state !== 'object') return; const changed = JSON.stringify(state) !== JSON.stringify(this.lastState); this.lastState = state; if (changed) this.emit('state', state); }
  sameContext(context) { const current = this.getContext(); return current && context && current.taskId === context.taskId && current.hostId === context.hostId && current.streamId === context.streamId && current.generation === context.generation; }
  owns(state) { return state?.voiceSessionId === this.voiceSessionId && state?.conversationId === this.voiceConversationId; }
  armPoll() {
    clearInterval(this.pollTimer);
    let pending = false;
    this.pollTimer = setInterval(() => {
      if (pending) return;
      pending = true;
      void this.request('read').then(state => { if (state.active && this.voiceSessionId && !this.owns(state)) this.emit('fault', new Error('Codex voice session ownership changed.')); })
        .catch(error => this.emit('fault', error)).finally(() => { pending = false; });
    }, 500);
    this.pollTimer.unref?.();
  }
  async start(context, route = {}) {
    return this.enqueue(async () => {
      if (!this.sameContext(context)) throw new Error('Codex task changed before starting voice chat.');
      await this.activateTask(context);
      if (!this.sameContext(context)) throw new Error('Codex task changed while selecting voice chat target.');
      this.ownerContext = context;
      const state = await this.request('start', { inputCaptureName: route.inputCaptureName, outputDeviceName: route.outputDeviceName, target: context });
      this.voiceSessionId = state.voiceSessionId;
      this.voiceConversationId = state.conversationId;
      if (!state.connected || state.conversationId !== context.taskId || !state.voiceSessionId)
        throw new Error('Codex voice chat did not confirm a connected session for the selected task.');
      this.armPoll();
      return { confirmed: true, state };
    });
  }
  async stop(context) {
    return this.enqueue(async () => {
      clearInterval(this.pollTimer); this.pollTimer = null;
      if (!this.voiceSessionId) { this.dispose(); return; }
      const state = await this.request('read');
      if (state.active) {
        if (!this.owns(state)) throw new Error('Refusing to end a different Codex voice session.');
        await this.request('stop', { voiceSessionId: this.voiceSessionId });
      }
      this.dispose();
    });
  }
  async setMuted(muted) { return this.enqueue(async () => { if (typeof muted !== 'boolean') throw new Error('Invalid microphone mute state.'); const before = await this.request('read'); if (!this.owns(before)) throw new Error('Refusing to mute a different Codex voice session.'); const state = await this.request('mute', { muted }); if (!this.owns(state) || state.microphoneMuted !== muted) throw new Error('Codex did not confirm microphone mute state.'); return state; }); }
  async interrupt() { throw new Error('The current Codex renderer exposes no verified native assistant-interrupt control.'); }
  async diagnoseWindows() { return this.enqueue(() => this.request('diagnose', { target: null })); }
  async readState(context) { return this.enqueue(() => this.request('read', context ? { target: context } : {})); }
  dispose() { clearInterval(this.pollTimer); this.pollTimer = null; const pipePath = this.pipePath, token = this.token; this.pipePath = null; this.token = null; this.owner = null; this.lastState = null; this.ownerContext = null; this.voiceSessionId = null; this.voiceConversationId = null; if (pipePath) void this.readPipe(pipePath, token, 'close').catch(() => {}); }
}

module.exports = CodexRealtimeRuntime;
module.exports.installRealtimeRuntime = installRealtimeRuntime;
module.exports.APP_PRIMARY = APP_PRIMARY;
