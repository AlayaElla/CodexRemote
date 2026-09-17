const { EventEmitter } = require('node:events');
const fsNative = require('node:fs');
const path = require('node:path');
const TOML = require('@iarna/toml');
const { randomUUID } = require('node:crypto');
const { CodexDesktopIpc } = require('./codex-desktop-ipc');
const { deviceModelCatalog } = require('./codex-model-catalog');
const { selectAutomaticTasks } = require('./codex-task-list');
const { CodexMicroSlots } = require('./codex-micro-slots');
const AUTOMATIC_SOURCES = new Set(['recent', 'pinned', 'priority']);

const SLOT_COUNT = 6;
const EMPTY_SLOT = slot => ({ slot, hostId: null, threadId: null, title: null, state: 'unbound', synced: false, model: null, effort: null, fast: null, serviceTier: null, updatedAt: null });

function readJson(fs, file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
function readText(fs, file) { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; } }
const DEFAULT_MICRO_LAYOUT = Object.freeze({
  encoderMode: 'composer-navigation',
  slots: Object.freeze({
    ACT06: Object.freeze({ keycapId: 'FAST' }), ACT07: Object.freeze({ keycapId: 'APPR' }),
    ACT08: Object.freeze({ keycapId: 'REJ' }), ACT09: Object.freeze({ keycapId: 'SPLIT' }),
    ACT10: Object.freeze({ keycapId: 'MIC1' }), ACT11: Object.freeze({ keycapId: 'EMPT1' }),
    ACT10_ACT11: Object.freeze({ keycapId: 'MIC' }), ACT12: Object.freeze({ keycapId: 'CODEX' })
  })
});
const KNOWN_SLOTS = new Set(Object.keys(DEFAULT_MICRO_LAYOUT.slots));
const KNOWN_KEYCAPS = new Set(['FAST', 'APPR', 'REJ', 'SPLIT', 'NEW', 'MIC', 'MIC1', 'CODEX', 'EMPT1', 'MIND+', 'MIND-']);
const KNOWN_ACTION_TYPES = new Set(['command', 'composer-text', 'custom-shortcut', 'external-url', 'named', 'skill']);
function cloneDefaultLayout() { return { encoderMode: DEFAULT_MICRO_LAYOUT.encoderMode, slots: Object.fromEntries(Object.entries(DEFAULT_MICRO_LAYOUT.slots).map(([key, value]) => [key, { ...value }])) }; }
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function validAction(action) { return action === undefined || (isPlainObject(action) && (action.type === undefined || KNOWN_ACTION_TYPES.has(action.type))); }
function mergeMicroLayout(value) {
  if (value === undefined) return cloneDefaultLayout();
  if (!isPlainObject(value) || (value.encoderMode !== undefined && !['composer-navigation', 'reasoning', 'conversation-scroll', 'custom'].includes(value.encoderMode)) || (value.slots !== undefined && !isPlainObject(value.slots))) return null;
  const layout = { ...cloneDefaultLayout(), ...value, slots: cloneDefaultLayout().slots };
  for (const [slot, override] of Object.entries(value.slots || {})) {
    if (!KNOWN_SLOTS.has(slot) || !isPlainObject(override) || (override.keycapId !== undefined && !KNOWN_KEYCAPS.has(override.keycapId)) || !validAction(override.action)) return null;
    layout.slots[slot] = { ...layout.slots[slot], ...override };
  }
  return layout;
}
function parseDesktopMicroConfig(text, atoms) {
  let document;
  try { document = TOML.parse(text || ''); } catch (_) { return { valid: false, source: 'invalid', layout: null, singleTap: null }; }
  const desktop = isPlainObject(document.desktop) ? document.desktop : {};
  const source = typeof desktop['codex-micro-agent-source'] === 'string' ? desktop['codex-micro-agent-source'] : atoms['codex-micro-agent-source'] || 'recent';
  const layout = mergeMicroLayout(desktop['codex-micro-layout'] ?? atoms['codex-micro-layout']);
  if (!layout) return { valid: false, source, layout: null, singleTap: null };
  const configuredSingleTap = desktop['codex-micro-single-tap-agent-keys'];
  const persistedSingleTap = atoms['codex-micro-single-tap-agent-keys'];
  const singleTap = typeof configuredSingleTap === 'boolean' ? configuredSingleTap : typeof persistedSingleTap === 'boolean' ? persistedSingleTap : false;
  const followUpQueueMode = desktop.followUpQueueMode ?? 'queue';
  const composerEnterBehavior = desktop.composerEnterBehavior ?? 'enter';
  return { valid: true, source, layout, singleTap,
    followUpQueueMode: followUpQueueMode === 'interrupt' ? 'steer' : followUpQueueMode,
    composerEnterBehavior };
}
function metadataSignature(fs, home) {
  return ['config.toml', '.codex-global-state.json', 'models_cache.json'].map(name => {
    const file = path.join(home, name);
    if (typeof fs.statSync !== 'function') return readText(fs, file);
    try { const stat = fs.statSync(file); return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; } catch (_) { return ''; }
  }).join('\u0000');
}
function runtimeState(value) {
  if (value && typeof value === 'object') {
    if (value.activeFlags?.includes('waitingOnApproval') || value.activeFlags?.includes('waitingOnUserInput')) return 'waiting';
    value = value.type || value.state || value.status;
  }
  if (value === 'active' || value === 'working' || value === 'running') return 'working';
  if (value === 'idle' || value === 'completed') return 'idle';
  if (value === 'waiting' || value === 'paused') return 'waiting';
  if (value === 'error' || value === 'failed') return 'error';
  return 'unknown';
}

class CodexDesktopState extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexHome = options.codexHome || path.join(process.env.USERPROFILE || '', '.codex');
    this.fs = options.fs || fsNative;
    this.timers = options.timers || global;
    this.ipc = options.ipc || new CodexDesktopIpc({ ipcFactory: options.ipcFactory, timers: this.timers });
    this.taskList = options.taskList === undefined ? (options.fs ? null : new CodexMicroSlots()) : options.taskList;
    this.nativeMicroMapping = this.taskList?.nativeMicroMapping === true;
    this.nativeSnapshot = null;
    this.automaticTasks = []; this.runtimeHints = new Map();
    this.taskListRequest = null; this.taskListTimer = null; this.taskListPollMs = options.taskListPollMs || (this.nativeMicroMapping ? 1000 : 5000);
    this.taskListGeneration = 0; this.lastTaskListReadAt = 0;
    this.revision = 0; this.selectedSlot = null; this.activeTask = null; this.connected = false; this.error = null; this.ipcError = null; this.taskListError = null;
    this.streamId = randomUUID();
    this.source = 'unloaded'; this.slots = Array.from({ length: SLOT_COUNT }, (_, slot) => EMPTY_SLOT(slot)); this.models = [];
    this.running = false;
    this.metadataPollMs = options.metadataPollMs || 1000; this.metadataTimer = null; this.metadataFingerprint = ''; this.retryTimers = new Map(); this.retryDelays = new Map();
    this._onState = event => this._applyState(event);
    this._onAttention = event => this.observeTaskSignal(event.threadId, { unread: event.unread });
    this._onReady = () => { this.connected = true; this.ipcError = null; this._refreshError(); this._emit(); };
    this._onUnavailable = event => this._markUnavailable(event);
    this._onDisconnect = error => this._markDisconnected(error);
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.taskListGeneration += 1;
    this.taskList?.stop?.();
    this.nativeSnapshot = null;
    this.lastTaskListReadAt = 0;
    this._loadMetadata();
    this.ipc.on('state', this._onState); this.ipc.on('ready', this._onReady); this.ipc.on('unavailable', this._onUnavailable); this.ipc.on('disconnect', this._onDisconnect);
    this.ipc.on('attention', this._onAttention);
    this.ipc.start();
    for (const slot of this._trackedTasks()) if (slot.threadId) this.ipc.subscribe({ hostId: slot.hostId, threadId: slot.threadId }).catch(error => this._markUnavailable({ ...slot, error: error.message }));
    this.metadataTimer = this.timers.setInterval(() => this._refreshMetadata(), this.metadataPollMs);
    if (this.taskList) {
      void this.refreshTaskList();
      this.taskListTimer = this.timers.setInterval(() => { void this.refreshTaskList(); }, this.taskListPollMs);
    }
    this._emit(); return this;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.taskListGeneration += 1;
    this.taskListRequest = null;
    this.lastTaskListReadAt = 0;
    if (this.taskListTimer) this.timers.clearInterval(this.taskListTimer);
    this.taskListTimer = null;
    if (this.metadataTimer) this.timers.clearInterval(this.metadataTimer);
    this.metadataTimer = null;
    for (const retry of this.retryTimers.values()) this.timers.clearTimeout(retry.timer);
    this.retryTimers.clear(); this.retryDelays.clear();
    this.connected = false;
    this.ipcError = null;
    this._refreshError();
    for (const slot of this._trackedTasks()) if (slot.threadId) Object.assign(slot, { state: 'unknown', synced: false });
    this._emit();
    this.ipc.off('state', this._onState); this.ipc.off('attention', this._onAttention); this.ipc.off('ready', this._onReady); this.ipc.off('unavailable', this._onUnavailable); this.ipc.off('disconnect', this._onDisconnect);
    this.ipc.stop();
  }

  getSnapshot() {
    const snapshot = { type: 'codex_state', version: 1, revision: this.revision, connected: this.connected, source: this.source, selectedSlot: this.selectedSlot,
      slots: this.slots.map(({ recentMessages, ...slot }) => ({ ...slot })),
      models: this.models.map(({ nativeEfforts, ...model }) => ({ ...model, efforts: model.efforts.map(effort => ({ ...effort })) })) };
    const target = this.slots[this.selectedSlot] || this.activeTask;
    if (this.activeTask) {
      const { recentMessages, ...task } = this.activeTask;
      snapshot.activeTask = { ...task };
    }
    snapshot.streamId = this.streamId;
    snapshot.microDisplay = this.connected && this.microDisplay ? { ...this.microDisplay } : null;
    snapshot.conversation = target?.threadId ? { hostId: target.hostId, threadId: target.threadId,
      ready: Array.isArray(target.recentMessages), messages: (target.recentMessages || []).map(message => ({ ...message })) } : null;
    if (this.error) snapshot.error = this.error;
    return snapshot;
  }

  getMicroLayout() {
    return {
      source: this.source,
      agentKeys: this.agentKeys,
      followUpQueueMode: this.followUpQueueMode,
      composerEnterBehavior: this.composerEnterBehavior,
      singleTap: this.singleTapAgentKeys,
      layout: this.microLayout
    };
  }

  selectSlot(slot) {
    if (slot === null) { this._clearActiveTask(); this.selectedSlot = null; this._emit(); return this.getSnapshot(); }
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) throw new Error('invalid Micro slot');
    const target = this.slots[slot];
    if (!target.threadId) throw new Error('Micro slot is unbound');
    this._clearActiveTask();
    this.selectedSlot = slot; this._emit(); return this.getSnapshot();
  }

  async requestSettingsUpdate(threadId, patch, options = {}) {
    const hostId = options.hostId || 'local';
    if (!this._trackedTasks().some(slot => slot.threadId === threadId && slot.hostId === hostId)) throw new Error('thread is not selected or bound to a Micro slot');
    await this.ipc.requestSettingsUpdate(threadId, patch, { hostId });
    return { applied: true };
  }

  getThreadBindings() {
    const persisted = readJson(this.fs, path.join(this.codexHome, '.codex-global-state.json'), {});
    const bindings = { ...persisted['electron-persisted-atom-state']?.['client-thread-bindings-v1'],
      ...this.nativeSnapshot?.threadBindings };
    return Object.fromEntries(Object.entries(bindings)
      .filter(([client, thread]) => /^client-new-thread:[\w-]+$/.test(client) && typeof thread === 'string' && /^[\w-]{1,128}$/.test(thread)));
  }

  selectThread(threadId, hostId = 'local') {
    if (hostId !== 'local' || typeof threadId !== 'string' || !/^[\w-]{1,128}$/.test(threadId)) throw new Error('invalid task identity');
    const slot = this.slots.find(item => item.hostId === hostId && item.threadId === threadId);
    if (slot) return this.selectSlot(slot.slot);
    this._clearActiveTask();
    this.selectedSlot = null;
    this.activeTask = { ...EMPTY_SLOT(-1), hostId, threadId, title: '新任务', state: 'unknown' };
    this.ipc.subscribe({ hostId, threadId }).catch(error => this._markUnavailable({ hostId, threadId, error: error.message }));
    this._emit(); return this.getSnapshot();
  }

  _trackedTasks() { return this.activeTask ? [...this.slots, this.activeTask] : this.slots; }
  _clearActiveTask() {
    const previous = this.activeTask;
    this.activeTask = null;
    if (previous && !this.slots.some(slot => slot.threadId === previous.threadId && slot.hostId === previous.hostId)) {
      this._cancelRetry(previous.hostId, previous.threadId);
      this.ipc.unsubscribe(previous.threadId, previous.hostId);
    }
  }

  _loadMetadata() {
    this.microDisplay = this.nativeSnapshot?.lighting || null;
    const config = readText(this.fs, path.join(this.codexHome, 'config.toml'));
    const persisted = readJson(this.fs, path.join(this.codexHome, '.codex-global-state.json'), {});
    const atoms = persisted['electron-persisted-atom-state'] || {};
    const micro = parseDesktopMicroConfig(config, atoms);
    this.source = micro.source;
    this.microLayout = micro.layout;
    this.singleTapAgentKeys = micro.singleTap;
    this.followUpQueueMode = micro.followUpQueueMode;
    this.composerEnterBehavior = micro.composerEnterBehavior;
    const assignments = micro.valid && this.source === 'custom' ? atoms['codex-micro-custom-agent-assignments'] || {} : {};
    this.agentKeys = Array.from({ length: SLOT_COUNT }, (_, slot) => {
      const assignment = assignments[`AG${String(slot).padStart(2, '0')}`];
      return { kind: assignment == null ? 'unbound' : typeof assignment.threadKey === 'string' ? 'thread' : 'action' };
    });
    this.slots = Array.from({ length: SLOT_COUNT }, (_, slot) => {
      const assignment = assignments[`AG${String(slot).padStart(2, '0')}`];
      if (!assignment || typeof assignment.threadKey !== 'string') return EMPTY_SLOT(slot);
      const [hostId, threadId] = assignment.threadKey.split(':', 2);
      if (!hostId || !threadId) return EMPTY_SLOT(slot);
      return { ...EMPTY_SLOT(slot), hostId: assignment.hostId || hostId, threadId, title: typeof assignment.title === 'string' ? assignment.title : null, state: 'unknown' };
    });
    if (this.nativeMicroMapping) {
      this.source = this.nativeSnapshot?.source || micro.source;
      this.slots = Array.from({ length: SLOT_COUNT }, (_, slot) => {
        const { nativeStatus, ...binding } = this.nativeSnapshot?.slots[slot] || {};
        return { ...EMPTY_SLOT(slot), ...binding, state: binding.threadId ? 'unknown' : 'unbound' };
      });
      this.agentKeys = this.slots.map(slot => ({ kind: slot.threadId ? 'thread' : slot.title ? 'action' : 'unbound' }));
    } else if (micro.valid && AUTOMATIC_SOURCES.has(this.source)) {
      const tasks = selectAutomaticTasks(this.source, this.automaticTasks, this.runtimeHints);
      this.slots = Array.from({ length: SLOT_COUNT }, (_, slot) => tasks[slot]
        ? { ...EMPTY_SLOT(slot), hostId: 'local', threadId: tasks[slot].threadId, title: tasks[slot].title, state: 'unknown' }
        : EMPTY_SLOT(slot));
    }
    const cache = readJson(this.fs, path.join(this.codexHome, 'models_cache.json'), {});
    this.models = deviceModelCatalog(cache);
    this.metadataFingerprint = metadataSignature(this.fs, this.codexHome);
  }

  _refreshMetadata(force = false) {
    const nextFingerprint = metadataSignature(this.fs, this.codexHome);
    if (!force && nextFingerprint === this.metadataFingerprint) return;
    const beforeMetadata = this._metadataView();
    const previous = this.slots;
    const previousActive = this.activeTask;
    const previousSource = this.source; const previousLayout = this.microLayout; const previousSingleTap = this.singleTapAgentKeys; const previousModels = this.models;
    const selectedBinding = this.selectedSlot === null ? null : previous[this.selectedSlot]?.threadId ? `${previous[this.selectedSlot].hostId}:${previous[this.selectedSlot].threadId}` : null;
    this._loadMetadata();
    if (JSON.stringify(beforeMetadata) === JSON.stringify(this._metadataView())) {
      this.source = previousSource; this.microLayout = previousLayout; this.singleTapAgentKeys = previousSingleTap; this.models = previousModels; this.slots = previous;
      this.metadataFingerprint = nextFingerprint;
      return false;
    }
    const currentKeys = new Set(this.slots.filter(slot => slot.threadId).map(slot => `${slot.hostId}:${slot.threadId}`));
    // A selected task remains followed when recent/priority ordering moves it
    // out of the six visible shortcuts.
    if (selectedBinding && !currentKeys.has(selectedBinding)) {
      this.activeTask = { ...previous[this.selectedSlot], slot: -1 };
    }
    if (this.activeTask) currentKeys.add(`${this.activeTask.hostId}:${this.activeTask.threadId}`);
    for (const oldSlot of previous) {
      if (oldSlot.threadId && !currentKeys.has(`${oldSlot.hostId}:${oldSlot.threadId}`)) { this._cancelRetry(oldSlot.hostId, oldSlot.threadId); this.ipc.unsubscribe(oldSlot.threadId, oldSlot.hostId); }
    }
    for (const slot of this.slots) {
      const prior = [...previous, ...(previousActive ? [previousActive] : [])].find(oldSlot => oldSlot.hostId === slot.hostId && oldSlot.threadId === slot.threadId);
      if (prior?.recentMessages) slot.recentMessages = prior.recentMessages;
      if (prior?.synced) {
        const model = this.models.find(item => item.id === prior.model);
        Object.assign(slot, { state: prior.state, synced: true, model: prior.model, effort: prior.effort, fast: model && prior.serviceTier ? model.fastSupported && prior.serviceTier === model.fastTier : null, serviceTier: prior.serviceTier, updatedAt: prior.updatedAt, title: this.nativeMicroMapping ? slot.title : slot.title || prior.title });
      }
      else if (slot.threadId) this.ipc.subscribe({ hostId: slot.hostId, threadId: slot.threadId }).catch(error => this._markUnavailable({ ...slot, error: error.message }));
    }
    if (this.selectedSlot !== null) {
      const next = this.slots.findIndex(slot => slot.threadId && `${slot.hostId}:${slot.threadId}` === selectedBinding);
      this.selectedSlot = next >= 0 ? next : null;
    }
    if (this.activeTask) {
      const index = this.slots.findIndex(slot => slot.threadId === this.activeTask.threadId && slot.hostId === this.activeTask.hostId);
      if (index >= 0) { this.selectedSlot = index; this.activeTask = null; }
    }
    if (this.source !== previousSource && AUTOMATIC_SOURCES.has(this.source)) void this.refreshTaskList();
    this._emit();
    return true;
  }

  async refreshTaskList() {
    if (!this.taskList || !this.running || (!this.nativeMicroMapping && !AUTOMATIC_SOURCES.has(this.source))) return;
    if (this.taskListRequest) return this.taskListRequest;
    if (Date.now() - this.lastTaskListReadAt < 1000) return;
    const generation = this.taskListGeneration;
    let request;
    request = (async () => {
      try {
        const snapshot = await this.taskList.read();
        if (!this.running || generation !== this.taskListGeneration) return;
        if (this.nativeMicroMapping) {
          if (snapshot?.nativeMicroMapping !== true || !Array.isArray(snapshot.slots) || snapshot.slots.length !== SLOT_COUNT) throw new Error('Micro 槽位返回无效数据');
          this.nativeSnapshot = snapshot;
        } else {
          if (!snapshot || !Array.isArray(snapshot.tasks)) throw new Error('任务列表返回无效数据');
          this.automaticTasks = snapshot.tasks;
        }
        this.lastTaskListReadAt = Date.now();
        const hadTaskListError = this.taskListError !== null;
        this.taskListError = null;
        const errorChanged = this._refreshError();
        const metadataChanged = this._refreshMetadata(true);
        if (hadTaskListError && errorChanged && !metadataChanged) this._emit();
      } catch (error) {
        if (!this.running || generation !== this.taskListGeneration) return;
        if (this.nativeMicroMapping) { this.nativeSnapshot = null; this._refreshMetadata(true); }
        this.taskListError = `任务列表读取失败：${error.message}`;
        if (this._refreshError()) this._emit();
      } finally { if (this.taskListRequest === request) this.taskListRequest = null; }
    })();
    this.taskListRequest = request;
    return request;
  }

  getControlModel(id) { return this.models.find(model => model.id === id); }

  observeTaskSignal(threadId, hint) {
    if (typeof threadId !== 'string' || !/^[\w-]{1,128}$/.test(threadId)) return;
    const previous = this.runtimeHints.get(threadId) || {};
    const next = { ...previous, ...hint };
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    this.runtimeHints.set(threadId, next);
    if (this.runtimeHints.size > 512) this.runtimeHints.delete(this.runtimeHints.keys().next().value);
    if (this.running && this.source === 'priority') this._refreshMetadata(true);
  }

  _metadataView() {
    return {
      source: this.source,
      microDisplay: this.microDisplay,
      slots: this.slots.map(slot => ({ slot: slot.slot, hostId: slot.hostId, threadId: slot.threadId, title: slot.title })),
      models: this.models,
      layout: this.microLayout,
      singleTap: this.singleTapAgentKeys,
      agentKeys: this.agentKeys,
      followUpQueueMode: this.followUpQueueMode,
      composerEnterBehavior: this.composerEnterBehavior,
    };
  }

  _refreshError() {
    const next = [this.taskListError, this.ipcError].filter(Boolean).join('；') || null;
    if (next === this.error) return false;
    this.error = next;
    return true;
  }

  _applyState(event) {
    if (event.hostId === 'local') this.runtimeHints.set(event.threadId, { ...this.runtimeHints.get(event.threadId), state: runtimeState(event.state.threadRuntimeStatus) });
    const changedSlots = [];
    const wasConnected = this.connected;
    this.connected = true; this.ipcError = null;
    const errorChanged = this._refreshError();
    for (const slot of this._trackedTasks()) {
      if (slot.threadId !== event.threadId || slot.hostId !== event.hostId) continue;
      this._cancelRetry(slot.hostId, slot.threadId);
      const settings = event.state.latestThreadSettings || {};
      const model = settings.model || event.state.latestModel || null;
      const effort = settings.effort || event.state.latestReasoningEffort || null;
      const serviceTier = settings.serviceTier || null;
      const knownModel = this.models.find(item => item.id === model);
      const tier = knownModel && serviceTier ? knownModel.fastSupported && serviceTier === knownModel.fastTier : null;
      const next = { title: this.nativeMicroMapping && slot.slot >= 0 ? slot.title : event.state.title || slot.title, state: runtimeState(event.state.threadRuntimeStatus), synced: true, model, effort, serviceTier, fast: tier };
      if (Array.isArray(event.state.recentMessages)) next.recentMessages = event.state.recentMessages;
      if (Object.entries(next).some(([key, value]) => JSON.stringify(slot[key]) !== JSON.stringify(value))) changedSlots.push([slot, next]);
    }
    for (const [slot, next] of changedSlots) Object.assign(slot, next, { updatedAt: new Date().toISOString() });
    if (this.running && this.source === 'priority') this._refreshMetadata(true);
    if (changedSlots.length || !wasConnected || errorChanged) this._emit();
  }

  _markUnavailable(event) {
    if (!this.running) return;
    let changed = false;
    for (const slot of this._trackedTasks()) if (slot.threadId === event.threadId && slot.hostId === event.hostId) {
      if (slot.state !== 'unknown' || slot.synced) { Object.assign(slot, { state: 'unknown', synced: false, updatedAt: new Date().toISOString() }); changed = true; }
      if (event.error === 'no-client-found') this._scheduleRetry(slot.hostId, slot.threadId);
    }
    this.ipcError = event.error || 'no-client-found';
    if (this._refreshError()) changed = true;
    if (changed) this._emit();
  }

  _scheduleRetry(hostId, threadId) {
    if (!this.running || hostId !== 'local') return;
    const key = `${hostId}:${threadId}`;
    if (this.retryTimers.has(key)) return;
    const delay = this.retryDelays.get(key) || 3000;
    this.retryDelays.set(key, Math.min(delay * 2, 15000));
    const timer = this.timers.setTimeout(() => { this.retryTimers.delete(key); this.ipc.subscribe({ hostId, threadId }).catch(error => this._markUnavailable({ hostId, threadId, error: error.message })); }, delay);
    this.retryTimers.set(key, { timer });
  }

  _cancelRetry(hostId, threadId) {
    const key = `${hostId}:${threadId}`; const retry = this.retryTimers.get(key);
    if (retry) { this.timers.clearTimeout(retry.timer); this.retryTimers.delete(key); }
    this.retryDelays.delete(key);
  }

  _markDisconnected(error) {
    this.connected = false; this.ipcError = error?.message || 'IPC disconnected'; this._refreshError();
    for (const slot of this._trackedTasks()) if (slot.threadId) Object.assign(slot, { state: 'unknown', synced: false });
    this._emit();
  }

  // Controls add draft fields to this snapshot and share its ordering clock.
  advanceRevision() { return ++this.revision; }
  _emit() { this.advanceRevision(); this.emit('state', this.getSnapshot()); }
}

module.exports = { CodexDesktopState, runtimeState, parseDesktopMicroConfig, DEFAULT_MICRO_LAYOUT };
