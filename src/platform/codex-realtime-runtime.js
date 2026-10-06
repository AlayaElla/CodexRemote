const { EventEmitter } = require('node:events');
const { randomBytes, randomUUID } = require('node:crypto');
const { findCodexProcess, runtimeSocketPath } = require('../core/codex-micro-slots');
const WebSocket = require('ws');
const net = require('node:net');
const findRealtimeControls = require('./codex-realtime-controls');
const installRealtimeRuntime = require('./codex-native-voice-host');
const buildNativeVoiceProfile = require('./codex-native-voice-profile');
const { nativeVoiceRenderer, startNativeVoice } = require('./codex-native-voice');
const CodexRendererRealtime = require('./codex-renderer-realtime');

// This adapter resolves only inspected native voice bindings. A changed
// renderer fails closed when those bindings cannot be confirmed.

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
    this.rendererFactory = Object.prototype.hasOwnProperty.call(options, 'rendererFactory') ? options.rendererFactory :
      Object.prototype.hasOwnProperty.call(options, 'connectInspector') ? null : (() => new CodexRendererRealtime());
    this.renderer = null; this.generation = 0;
    this.getContext = options.getContext || (() => null); this.activateTask = options.activateTask || (async () => {}); this.pipePath = null; this.token = null; this.owner = null; this.ownerContext = null; this.connecting = null; this.queue = Promise.resolve(); this.lastState = null; this.pollTimer = null; this.voiceSessionId = null; this.voiceConversationId = null;
  }
  on(...args) { return super.on(...args); }
  enqueue(task) { const next = this.queue.catch(() => {}).then(task); this.queue = next; return next; }
  async ensure() {
    if (this.platform !== 'win32') throw new Error('Codex realtime runtime currently supports Windows only.');
    if (this.pipePath || this.renderer) return; if (this.connecting) return this.connecting;
    const generation = this.generation;
    this.connecting = (async () => {
      const target = await this.findProcess(); let inspector;
      try {
        try { inspector = await this.connectInspector(); }
        catch (error) {
          if (!this.rendererFactory) throw new Error(require('./codex-inspector-policy').WINDOWS_INSPECTOR_REQUIRED);
          const renderer = this.rendererFactory();
          try {
            await renderer.connect(target);
            if (generation !== this.generation) { await renderer.dispose(); throw new Error('Codex realtime connection was cancelled.'); }
            this.renderer = renderer; this.owner = target; return;
          } catch (rendererError) {
            try { await renderer.dispose(); } catch (_) {}
            throw rendererError;
          }
        }
        if (!inspector) throw new Error('Unable to establish the Codex desktop runtime.');
        const identity = await inspector.evaluate('({pid:process.pid,executable:process.execPath})');
        if (identity?.pid !== target.pid || String(identity.executable || '').toLowerCase() !== String(target.executable || '').toLowerCase()) throw new Error('Codex process identity mismatch.');
        const pipePath = runtimeSocketPath('win32', target.pid, randomUUID()); const token = randomBytes(32).toString('hex');
        await inspector.evaluate(`(${installRealtimeRuntime.toString()})(${JSON.stringify({ pipePath, token, controlLocatorSource: findRealtimeControls.toString(), rendererSource: nativeVoiceRenderer.toString(), coordinatorSource: startNativeVoice.toString() })}, (${buildNativeVoiceProfile.toString()}))`);
        if (generation !== this.generation) throw new Error('Codex realtime connection was cancelled.');
        this.pipePath = pipePath; this.token = token; this.owner = target;
      } finally { inspector?.close(); }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async request(type, payload = {}) {
    try {
      const request = payload.target ? payload : { ...payload, target: this.ownerContext };
      if (this.requestImpl) { const result = await this.requestImpl(type, request); this.note(result); return result; }
      await this.ensure();
      const result = this.renderer ? await this.renderer.request(type, request) : await this.readPipe(this.pipePath, this.token, type, request);
      this.note(result); return result;
    } catch (error) { throw error; }
  }
  note(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const { transcript, ...state } = snapshot;
    const changed = JSON.stringify(state) !== JSON.stringify(this.lastState);
    this.lastState = state;
    if (changed) this.emit('state', state);
    if (!this.voiceSessionId || !this.owns(state) || state.hostId !== this.ownerContext?.hostId || !state.connected) return;
    if (!Number.isSafeInteger(transcript?.sequence) || transcript.sequence <= (this.lastTranscript?.sequence || 0)) return;
    this.lastTranscript = { ...transcript, voiceSessionId: state.voiceSessionId,
      conversationId: state.conversationId, hostId: state.hostId };
    this.emit('transcript', this.lastTranscript);
  }
  getTranscript() { return this.lastTranscript || null; }
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
    }, 100); // Keep live captions responsive; pending prevents overlapping reads.
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
      this.lastTranscript = null;
      this.note(state);
      this.armPoll();
      return { confirmed: true, state };
    });
  }
  async stop(context) {
    return this.enqueue(async () => {
      clearInterval(this.pollTimer); this.pollTimer = null;
      if (!this.voiceSessionId) { await this.dispose(); return; }
      const state = await this.request('read');
      if (state.active) {
        if (!this.owns(state)) throw new Error('Refusing to end a different Codex voice session.');
        await this.request('stop', { voiceSessionId: this.voiceSessionId });
      }
      await this.dispose();
    });
  }
  async setMuted(muted) { return this.enqueue(async () => { if (typeof muted !== 'boolean') throw new Error('Invalid microphone mute state.'); const before = await this.request('read'); if (!this.owns(before)) throw new Error('Refusing to mute a different Codex voice session.'); const state = await this.request('mute', { muted }); if (!this.owns(state) || state.microphoneMuted !== muted) throw new Error('Codex did not confirm microphone mute state.'); return state; }); }
  async interrupt() { throw new Error('The current Codex renderer exposes no verified native assistant-interrupt control.'); }
  async diagnoseWindows() { return this.enqueue(() => this.request('diagnose', { target: null })); }
  async readState(context) { return this.enqueue(() => this.request('read', context ? { target: context } : {})); }
  dispose() { this.generation++; clearInterval(this.pollTimer); this.pollTimer = null; const pipePath = this.pipePath, token = this.token, renderer = this.renderer; this.pipePath = null; this.token = null; this.renderer = null; this.owner = null; this.lastState = null; this.lastTranscript = null; this.ownerContext = null; this.voiceSessionId = null; this.voiceConversationId = null; if (pipePath) void this.readPipe(pipePath, token, 'close').catch(() => {}); return renderer ? Promise.resolve().then(() => renderer.dispose()).catch(() => {}) : Promise.resolve(); }
}

module.exports = CodexRealtimeRuntime;
module.exports.installRealtimeRuntime = installRealtimeRuntime;
