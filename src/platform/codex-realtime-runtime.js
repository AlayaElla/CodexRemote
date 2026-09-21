const { EventEmitter } = require('node:events');
const { randomBytes, randomUUID } = require('node:crypto');
const { findCodexProcess, runtimeSocketPath } = require('../core/codex-micro-slots');
const WebSocket = require('ws');
const net = require('node:net');

// This adapter is deliberately tied to the inspected 26.915.4065.0 renderer.
// It uses semantic aria names and a runtime VoiceStore shape check; neither is
// an OpenAI public control API.  A changed renderer fails closed.
const APP_PRIMARY = 'app-primary-355549b35da9.js';
const START_LABEL = 'Start voice chat';
const MUTE_LABEL = 'Mute microphone';
const UNMUTE_LABEL = 'Unmute microphone';
const STOP_LABEL = 'Stop voice chat';
const CANCEL_LABEL = 'Cancel voice chat';

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

// Serialized into the verified Codex main process.  Do not add Node APIs to
// rendererCode: it executes in the unprivileged webview.
function installRealtimeRuntime({ pipePath, token }) {
  const requireNative = process.mainModule.require.bind(process.mainModule);
  const { app, BrowserWindow } = requireNative('electron');
  const fs = requireNative('fs'), path = requireNative('path'), net = requireNative('net');
  const expectedPrimary = 'app-primary-355549b35da9.js';
  const assets = path.join(app.getAppPath(), 'webview', 'assets');
  if (!fs.existsSync(path.join(assets, expectedPrimary))) throw new Error('Codex realtime renderer version is unsupported.');
  function selectedWindowTask() {
    const root = document.getElementById('root'), container = root?.[Object.keys(root).find(key => key.startsWith('__reactContainer'))], queue = [container?.stateNode?.current || container], seen = new Set(), composerTargets = new Map(), activeTargets = new Map();
    while (queue.length && seen.size < 30000) {
      const fiber = queue.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
      const props = fiber.memoizedProps;
      if (props?.isActive === true && typeof props.conversationId === 'string' && typeof props.hostId === 'string')
        activeTargets.set(`${props.hostId}:${props.conversationId}`, { taskId: props.conversationId, hostId: props.hostId });
      if (props && Object.prototype.hasOwnProperty.call(props, 'onRealtimeStart') && typeof props.conversationId === 'string' && typeof props.executionTargetHostId === 'string') {
        composerTargets.set(`${props.executionTargetHostId}:${props.conversationId}`, { taskId: props.conversationId, hostId: props.executionTargetHostId });
      }
      queue.push(fiber.sibling, fiber.child);
    }
    return composerTargets.size === 1 ? [...composerTargets.values()][0] : activeTargets.size === 1 ? [...activeTargets.values()][0] : null;
  }
  const locatorCode = `(${selectedWindowTask.toString()})()`;
  let busy = false, closed = false, owner = null, idleTimer;
  const windowForRequest = async target => {
    if (owner != null) {
      const pinned = BrowserWindow.fromId(owner);
      if (!pinned || pinned.isDestroyed()) throw new Error('Codex voice window closed.');
      return pinned;
    }
    const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()
      && /^app:\/\/-\/(?:index|detached-window)\.html(?:\?|$)/.test(window.webContents.getURL())
      && !/avatar-overlay|global-dictation/.test(window.webContents.getURL()));
    if (!target || typeof target.taskId !== 'string' || typeof target.hostId !== 'string') throw new Error('A Codex task context is required.');
    const matches = [];
    for (const window of windows) { const selected = await window.webContents.executeJavaScript(locatorCode); if (selected?.taskId === target.taskId && selected.hostId === target.hostId) matches.push(window); }
    if (matches.length !== 1) throw new Error('A unique Codex window for the selected task is required.');
    if (owner != null && owner !== matches[0].id) throw new Error('Codex task window changed; reconnect required.');
    owner = matches[0].id;
    return matches[0];
  };
  const diagnoseWindows = async () => {
    const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()
      && /^app:\/\/\-\/(?:index|detached-window)\.html(?:\?|$)/.test(window.webContents.getURL())
      && !/avatar-overlay|global-dictation/.test(window.webContents.getURL()));
    const result = [];
    for (const window of windows) {
      try {
        const selected = await window.webContents.executeJavaScript(locatorCode);
        const voice = await window.webContents.executeJavaScript(`(${renderer.toString()})(${JSON.stringify({ op: 'read' })})`);
        result.push({ taskId: selected?.taskId || null, hostId: selected?.hostId || null, hasVoiceStore: true, active: voice.active === true, connectionState: voice.connectionState || null });
      } catch (error) { result.push({ taskId: null, hostId: null, hasVoiceStore: false, active: false, connectionState: null, error: String(error.message).slice(0, 256) }); }
    }
    return { windows: result, surfaces: BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).map(window => {
      const url = new URL(window.webContents.getURL() || 'about:blank');
      return { protocol: url.protocol, hostname: url.hostname, pathname: url.pathname, hashRoute: url.hash.split('?')[0] };
    }) };
  };
  const renderer = async request => {
    const primaryModule = await import('app://-/assets/app-primary-355549b35da9.js');
    const root = document.getElementById('root');
    const container = root?.[Object.keys(root).find(key => key.startsWith('__reactContainer'))];
    const queue = [container?.stateNode?.current || container], seen = new Set(), candidates = new Set(), sessions = [];
    const scanValue = (value, depth = 0, valuesSeen = new Set()) => {
      if (!value || (typeof value !== 'object' && typeof value !== 'function') || valuesSeen.has(value) || depth > 3) return;
      valuesSeen.add(value);
      if (typeof value.get === 'function' && typeof value.watch === 'function') {
        try { const store = primaryModule.ns(value); if (typeof store?.getState === 'function' && typeof store.getState().isVoiceModeActive === 'boolean') candidates.add(store); } catch (_) {}
      }
      if (typeof value.switchActiveDevice === 'function' && typeof value.getActiveDevice === 'function' && typeof value.disconnect === 'function') sessions.push(value);
      if (value.nodeType || ArrayBuffer.isView(value)) return;
      try { for (const child of Object.values(value)) scanValue(child, depth + 1, valuesSeen); } catch (_) {}
    };
    while (queue.length && seen.size < 30000) {
      const fiber = queue.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
      for (let hook = fiber.memoizedState, count = 0; hook && count++ < 100; hook = hook.next) {
        for (const value of [hook.memoizedState, hook.memoizedState?.current]) {
          if (!value || typeof value.getState !== 'function' || typeof value.subscribe !== 'function') continue;
          try {
            const state = value.getState();
            if (typeof state?.isVoiceModeActive === 'boolean' && state.server && typeof state.server === 'object') candidates.add(value);
          } catch (_) {}
        }
      }
      scanValue(fiber.memoizedProps); scanValue(fiber.memoizedState); scanValue(fiber.stateNode);
      queue.push(fiber.sibling, fiber.child);
    }
    if (candidates.size !== 1) throw new Error(`Codex VoiceStore schema is unavailable (root=${Boolean(root)}, fibers=${seen.size}, candidates=${candidates.size}).`);
    const voiceStore = [...candidates][0], voice = () => voiceStore.getState();
    const discoverSessions = () => {
      sessions.length = 0;
      const fibers = [container?.stateNode?.current || container], visited = new Set();
      while (fibers.length && visited.size < 30000) {
        const fiber = fibers.pop(); if (!fiber || visited.has(fiber)) continue; visited.add(fiber);
        scanValue(fiber.memoizedProps); scanValue(fiber.memoizedState); scanValue(fiber.stateNode);
        fibers.push(fiber.sibling, fiber.child);
      }
      return [...new Set(sessions)];
    };
    const voiceSession = () => {
      const unique = discoverSessions();
      if (unique.length !== 1) throw new Error('Codex voice device session is unavailable.');
      return unique[0];
    };
    const button = label => [...document.querySelectorAll('button[aria-label]')].filter(node => node.getAttribute('aria-label') === label && !node.disabled);
    const one = label => { const result = button(label); if (result.length !== 1) throw new Error(`Codex realtime control is unavailable: ${label}.`); return result[0]; };
    const snapshot = () => {
      const state = voice(); const microphone = button('Mute microphone').length === 1 ? false : button('Unmute microphone').length === 1 ? true : null;
      const active = state.isVoiceModeActive === true;
      const connection = typeof state.server?.connectionState === 'string' ? state.server.connectionState : null;
      let inputDeviceId = null, outputDeviceId = null;
      if (active) { try { const session = voiceSession(); inputDeviceId = session.getActiveDevice('audioinput') || null; outputDeviceId = session.getActiveDevice('audiooutput') || null; } catch (_) {} }
      return { active, connected: active && connection === 'connected', state: !active ? 'ended' : connection && connection !== 'connected' ? 'disconnected' : microphone ? 'muted' : state.isAssistantSpeaking === true ? 'speaking' : 'listening', microphoneMuted: microphone,
        connectionState: connection, conversationId: typeof state.conversationId === 'string' ? state.conversationId : null,
        voiceSessionId: typeof state.voiceSessionId === 'string' ? state.voiceSessionId : null, inputDeviceId, outputDeviceId };
    };
    const waitFor = async predicate => { const deadline = performance.now() + 10000; do { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } while (performance.now() < deadline); throw new Error('Codex did not confirm the requested realtime state.'); };
    if (request.op === 'read') return snapshot();
    const deviceIdFor = async (kind, name) => {
      if (typeof name !== 'string' || !name.trim()) throw new Error(`A Codex ${kind} device name is required.`);
      const found = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === kind && device.label === name.trim());
      if (found.length !== 1 || !found[0].deviceId) throw new Error(`Codex cannot uniquely map the selected ${kind} device.`);
      return found[0].deviceId;
    };
    const forceInitialMicrophone = deviceId => {
      const media = navigator.mediaDevices, ownDescriptor = Object.getOwnPropertyDescriptor(media, 'getUserMedia'), original = media.getUserMedia.bind(media); let used = false;
      Object.defineProperty(media, 'getUserMedia', { configurable: true, writable: true, value: constraints => {
        if (!used && constraints?.audio) { used = true; const audio = constraints.audio === true ? {} : constraints.audio; return original({ ...constraints, audio: { ...audio, deviceId: { exact: deviceId } } }); }
        return original(constraints);
      }});
      return () => ownDescriptor ? Object.defineProperty(media, 'getUserMedia', ownDescriptor) : delete media.getUserMedia;
    };
    const suppressInitialOutput = () => {
      const ownDescriptor = Object.getOwnPropertyDescriptor(document, 'createElement'), original = document.createElement.bind(document), muted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted'); let voiceAudio = null;
      Object.defineProperty(document, 'createElement', { configurable: true, writable: true, value: (name, ...args) => {
        const node = original(name, ...args);
        if (voiceAudio == null && String(name).toLowerCase() === 'audio') {
          voiceAudio = node;
          Object.defineProperty(node, 'muted', { configurable: true, get: () => muted.get.call(node), set: () => muted.set.call(node, true) });
          muted.set.call(node, true);
        }
        return node;
      }});
      return () => {
        if (ownDescriptor) Object.defineProperty(document, 'createElement', ownDescriptor); else delete document.createElement;
        if (voiceAudio) { delete voiceAudio.muted; muted.set.call(voiceAudio, false); }
      };
    };
    if (request.op === 'start') {
      const before = snapshot(); if (before.active) throw new Error('Codex voice chat is already active.');
      const inputDeviceId = await deviceIdFor('audioinput', request.inputCaptureName), outputDeviceId = await deviceIdFor('audiooutput', request.outputDeviceName);
      const restoreMicrophone = forceInitialMicrophone(inputDeviceId), restoreOutput = suppressInitialOutput();
      try {
        one('Start voice chat').click(); await waitFor(() => snapshot().connected);
        const session = voiceSession();
        if (session.getActiveDevice('audioinput') !== inputDeviceId && !await session.switchActiveDevice('audioinput', inputDeviceId)) throw new Error('Codex rejected the selected ESP32 microphone route.');
        if (session.getActiveDevice('audioinput') !== inputDeviceId) throw new Error('Codex did not confirm the selected ESP32 microphone route.');
        if (!await session.switchActiveDevice('audiooutput', outputDeviceId) || session.getActiveDevice('audiooutput') !== outputDeviceId) throw new Error('Codex rejected the selected realtime output route.');
        return snapshot();
      } catch (error) {
        const controls = button('Stop voice chat'); if (controls.length === 1) controls[0].click(); else { const cancel = button('Cancel voice chat'); if (cancel.length === 1) cancel[0].click(); }
        throw error;
      } finally { restoreMicrophone(); restoreOutput(); }
    }
    if (request.op === 'stop') { const state = snapshot(); if (!state.active) return state; if (request.voiceSessionId && state.voiceSessionId !== request.voiceSessionId) throw new Error('Refusing to end a different Codex voice session.'); const controls = button('Stop voice chat'); (controls.length === 1 ? controls[0] : one('Cancel voice chat')).click(); await waitFor(() => !snapshot().active); return snapshot(); }
    if (request.op === 'mute') { const state = snapshot(); if (!state.active) throw new Error('Codex voice chat is not active.'); if (state.microphoneMuted !== request.muted) one(request.muted ? 'Mute microphone' : 'Unmute microphone').click(); await waitFor(() => snapshot().microphoneMuted === request.muted); return snapshot(); }
    throw new Error('Unsupported Codex realtime operation.');
  };
  const close = server => { if (closed) return; closed = true; clearTimeout(idleTimer); server.close(); };
  const renewIdle = server => { clearTimeout(idleTimer); idleTimer = setTimeout(() => close(server), 30 * 60 * 1000); idleTimer.unref(); };
  const server = net.createServer(socket => {
    socket.setTimeout(25000, () => socket.destroy()); let input = ''; let handled = false;
    socket.on('error', () => {}); socket.on('data', data => {
      if (handled) return; input += data.toString('utf8'); if (input.length > 4096 || !input.includes('\n')) { if (input.length > 4096) socket.destroy(); return; }
      handled = true; void (async () => {
        let ownsLock = false;
        try {
          const request = JSON.parse(input); if (closed || request.token !== token || !['read', 'start', 'stop', 'mute', 'diagnose', 'close'].includes(request.type)) throw new Error('Invalid realtime runtime request.');
          renewIdle(server);
          if (request.type === 'close') { socket.end('{}\n'); close(server); return; }
          if (request.type === 'diagnose') { socket.end(JSON.stringify({ snapshot: await diagnoseWindows() }) + '\n'); return; }
          if (busy && request.type !== 'read') throw new Error('Codex realtime control is busy.');
          if (request.type !== 'read') { busy = true; ownsLock = true; }
          const window = await windowForRequest(request.target);
          const result = await window.webContents.executeJavaScript(`(${renderer.toString()})(${JSON.stringify({ op: request.type, muted: request.muted === true, inputCaptureName: request.inputCaptureName, outputDeviceName: request.outputDeviceName, voiceSessionId: request.voiceSessionId })})`);
          socket.end(JSON.stringify({ snapshot: result }) + '\n');
        } catch (error) { socket.end(JSON.stringify({ error: String(error.message || error).slice(0, 512) }) + '\n'); }
        finally { if (ownsLock) busy = false; }
      })();
    });
  });
  server.on('error', () => close(server)); server.on('close', () => clearTimeout(idleTimer));
  return new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(pipePath, () => { renewIdle(server); resolve({ processId: process.pid, appVersion: app.getVersion() }); });
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
        await inspector.evaluate(`(${installRealtimeRuntime.toString()})(${JSON.stringify({ pipePath, token })})`);
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
