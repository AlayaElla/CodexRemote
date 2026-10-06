const { randomUUID } = require('node:crypto');
const { createRendererConnection } = require('./codex-renderer-connection');
const findRealtimeControls = require('./codex-realtime-controls');
const buildNativeVoiceProfile = require('./codex-native-voice-profile');
const { nativeVoiceRenderer, startNativeVoice } = require('./codex-native-voice');

// This adapter drives only the task renderer selected by the same host/task
// identifiers used by the realtime session. The debugger connection is opened
// only after the caller explicitly requests a realtime operation.
function selectedWindowTask() {
  const root = document.getElementById('root'), container = root?.[Object.keys(root).find(key => key.startsWith('__reactContainer'))];
  const queue = [container?.stateNode?.current || container], seen = new Set(), composerTargets = new Map(), activeTargets = new Map();
  while (queue.length && seen.size < 30000) {
    const fiber = queue.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    const props = fiber.memoizedProps;
    if (props?.isActive === true && typeof props.conversationId === 'string' && typeof props.hostId === 'string')
      activeTargets.set(`${props.hostId}:${props.conversationId}`, { taskId: props.conversationId, hostId: props.hostId });
    if (props && Object.prototype.hasOwnProperty.call(props, 'onRealtimeStart') && typeof props.conversationId === 'string' && typeof props.executionTargetHostId === 'string')
      composerTargets.set(`${props.executionTargetHostId}:${props.conversationId}`, { taskId: props.conversationId, hostId: props.executionTargetHostId });
    queue.push(fiber.sibling, fiber.child);
  }
  return composerTargets.size === 1 ? [...composerTargets.values()][0] : activeTargets.size === 1 ? [...activeTargets.values()][0] : null;
}

const eligibleUrl = url => /^app:\/\/-\/(?:index|detached-window)\.html(?:\?|$)/.test(url || '') && !/global-dictation/.test(url || '');
const inactive = () => ({ active: false, connected: false, state: 'ended' });

class CodexRendererRealtime {
  constructor(options = {}) {
    this.connectionFactory = options.connectionFactory || (() => createRendererConnection());
    this.connection = null;
    this.windows = [];
    this.profile = null;
    this.target = null;
    this.context = null;
    this.routeToken = null;
    this.ownerWindow = null;
    this.snapshot = null;
    this.connecting = null;
    this.connectingTarget = null;
    this.starting = null;
    this.generation = 0;
    this.closed = false;
    this.queue = Promise.resolve();
  }

  enqueue(task) {
    const next = this.queue.catch(() => {}).then(task);
    this.queue = next;
    return next;
  }

  async connect(target) {
    if (!target || !Number.isSafeInteger(target.pid) || typeof target.executable !== 'string')
      throw new Error('Codex process identity is required for renderer realtime.');
    if (this.connection) {
      if (target.pid !== this.target.pid || target.executable.toLowerCase() !== this.target.executable.toLowerCase())
        throw new Error('Codex process identity changed while connecting realtime.');
      return this;
    }
    if (this.connecting) {
      if (target.pid !== this.connectingTarget?.pid || target.executable.toLowerCase() !== this.connectingTarget?.executable.toLowerCase())
        throw new Error('Codex process identity changed while connecting realtime.');
      return this.connecting;
    }
    const generation = this.generation;
    const verifiedTarget = { pid: target.pid, executable: target.executable };
    this.closed = false;
    this.connectingTarget = verifiedTarget;
    this.connecting = (async () => {
      const connection = this.connectionFactory();
      try {
        await connection.open(verifiedTarget);
        if (generation !== this.generation || this.closed) throw new Error('Codex renderer connection was cancelled.');
        const assets = connection.assets();
        const initial = assets.names.filter(name => /^app-initial-[\w-]+\.js$/.test(name));
        if (initial.length !== 1) throw new Error('Codex 原生語音資源結構已變更，無法安全啟動即時語音。');
        this.profile = buildNativeVoiceProfile({ initialName: initial[0], initialText: assets.read(initial[0]) });
        this.windows = (await connection.windows()).filter(window => eligibleUrl(window.webContents.getURL()));
        if (generation !== this.generation || this.closed) throw new Error('Codex renderer connection was cancelled.');
        this.connection = connection;
        this.target = verifiedTarget;
        return this;
      } catch (error) {
        try { await connection.close(); } catch (_) {}
        throw error;
      }
    })().finally(() => { this.connecting = null; this.connectingTarget = null; });
    return this.connecting;
  }

  assertOpen() {
    if (!this.connection || this.closed) throw new Error('Codex renderer realtime is not connected.');
  }

  async call(window, op, extra = {}) {
    if (this.closed && op !== 'cleanup') throw new Error('Codex renderer realtime was cancelled.');
    if (!window || window.isDestroyed()) throw new Error('Codex 語音窗口已關閉。');
    if (extra.target && this.context && (extra.target.taskId !== this.context.taskId || extra.target.hostId !== this.context.hostId))
      throw new Error('Codex voice target changed.');
    if (extra.routeToken && extra.routeToken !== this.routeToken) throw new Error('Codex voice route ownership changed.');
    const request = { op, target: this.context, routeToken: this.routeToken, ...extra };
    // These values are security boundaries, so do not permit extra values to
    // substitute another task, host, or route token.
    request.target = this.context;
    request.routeToken = this.routeToken;
    const expression = `(${nativeVoiceRenderer.toString()})(${JSON.stringify(request)}, (${findRealtimeControls.toString()}), ${JSON.stringify(this.profile)})`;
    return window.webContents.executeJavaScript(expression);
  }

  async selectedTask(window) {
    if (!window || window.isDestroyed()) return null;
    return window.webContents.executeJavaScript(`(${selectedWindowTask.toString()})()`);
  }

  async request(type, payload = {}) {
    return this.enqueue(async () => {
      this.assertOpen();
      if (type === 'diagnose') return this.diagnose();
      if (type === 'start') return this.start(payload);
      if (!this.ownerWindow) return inactive();
      const requested = payload.target;
      if (requested && (requested.taskId !== this.context?.taskId || requested.hostId !== this.context?.hostId))
        throw new Error('Codex voice target changed.');
      if (type === 'read') return this.call(this.ownerWindow, 'read');
      if (type === 'mute') return this.call(this.ownerWindow, 'mute', { muted: payload.muted });
      if (type === 'stop') {
        const state = await this.call(this.ownerWindow, 'read');
        if (state.active && (state.voiceSessionId !== this.snapshot?.voiceSessionId || state.conversationId !== this.context.taskId || state.hostId !== this.context.hostId))
          throw new Error('Refusing to end a different Codex voice session.');
        return this.call(this.ownerWindow, 'stop', { voiceSessionId: payload.voiceSessionId });
      }
      throw new Error('Unsupported Codex renderer realtime operation.');
    });
  }

  async diagnose() {
    const windows = [];
    for (const window of this.windows) {
      try { windows.push({ windowId: window.id, task: await this.selectedTask(window), ...await this.call(window, 'read') }); }
      catch (error) { windows.push({ windowId: window.id, error: String(error.message || error).slice(0, 256) }); }
    }
    return { windows };
  }

  async start(payload) {
    if (this.ownerWindow) throw new Error('Codex voice chat is already active.');
    const target = payload.target;
    if (!target || typeof target.taskId !== 'string' || typeof target.hostId !== 'string')
      throw new Error('A Codex task context is required.');
    this.context = { taskId: target.taskId, hostId: target.hostId };
    this.routeToken = randomUUID();
    const generation = this.generation;
    try {
      // The task composer may live in a window distinct from the voice owner.
      // Require exactly one eligible window to resolve the requested task.
      const matches = [];
      for (const window of this.windows) {
        if (window.webContents.getURL().includes('avatar-overlay')) continue;
        const selected = await this.selectedTask(window);
        if (selected?.taskId === this.context.taskId && selected.hostId === this.context.hostId) matches.push(window);
      }
      if (matches.length !== 1) throw new Error('A unique Codex window for the selected task is required.');
      if (generation !== this.generation || this.closed) throw new Error('Codex 語音連接已取消。');
      const operation = startNativeVoice({
        surfaces: this.windows,
        taskWindow: matches[0],
        target: this.context,
        routeToken: this.routeToken,
        route: { inputCaptureName: payload.inputCaptureName, outputDeviceName: payload.outputDeviceName },
        call: (window, op, extra) => this.call(window, op, extra),
        selectTask: window => this.selectedTask(window),
        wait: ms => new Promise(resolve => setTimeout(resolve, ms))
      });
      this.starting = operation;
      const result = await operation;
      if (generation !== this.generation || this.closed) {
        try { await this.call(result.window, 'cleanup', { stop: true }); } catch (_) {}
        throw new Error('Codex 語音連接已取消。');
      }
      this.ownerWindow = result.window;
      this.snapshot = result.snapshot;
      return result.snapshot;
    } catch (error) {
      this.context = null; this.routeToken = null;
      throw error;
    } finally { this.starting = null; }
  }

  async stop() {
    const owner = this.ownerWindow;
    const connection = this.connection;
    try {
      if (owner && !owner.isDestroyed()) await this.call(owner, 'cleanup', { stop: true });
    } finally {
      this.ownerWindow = null; this.snapshot = null; this.context = null; this.routeToken = null;
      this.connection = null; this.windows = []; this.profile = null; this.target = null;
      if (connection) try { await connection.close(); } catch (_) {}
    }
  }

  async dispose() {
    this.generation++;
    this.closed = true;
    const connection = this.connection;
    try {
      if (this.starting) await this.starting.catch(() => {});
      if (this.ownerWindow) await this.stop();
      else if (this.context && this.routeToken) {
        await Promise.allSettled(this.windows.map(window => this.call(window, 'cleanup', { stop: true })));
        this.context = null; this.routeToken = null;
      }
      if (this.starting) await this.starting.catch(() => {});
    } finally {
      const stillOwnedConnection = this.connection === connection ? connection : null;
      this.connection = null; this.windows = []; this.profile = null; this.target = null;
      this.ownerWindow = null; this.snapshot = null; this.context = null; this.routeToken = null;
      if (stillOwnedConnection) try { await stillOwnedConnection.close(); } catch (_) {}
    }
  }
}

module.exports = CodexRendererRealtime;
