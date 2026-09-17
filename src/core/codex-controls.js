const { EventEmitter } = require('events');

const ACTIONS = new Set(['select_task', 'new_task', 'set_model', 'set_effort', 'set_fast', 'refresh_draft_settings']);
const CONTROL_KEYS = new Set(['ACT06', 'ACT07', 'ACT08', 'ACT09', 'ACT12']);
const KEYCAP_COMMANDS = Object.freeze({
  FAST: 'composer.toggleFastMode', 'MIND+': 'composer.increaseReasoningEffort',
  'MIND-': 'composer.decreaseReasoningEffort', APPR: 'approval.approve',
  REJ: 'approval.decline', SPLIT: 'forkThread', NEW: 'newTask', CODEX: 'composer.submit'
});

function commandKey(config, command) {
  const slots = config?.layout?.slots || {};
  for (const [key, slot] of Object.entries(slots)) {
    if (!CONTROL_KEYS.has(key) || !slot) continue;
    const actual = slot.action
      ? (slot.action.type === 'command' ? slot.action.commandId : null)
      : slot.commandId || KEYCAP_COMMANDS[slot.keycapId];
    if (actual === command || (command === 'newTask' && actual === 'newThread')) return key;
  }
  if (config?.layout?.encoderMode === 'reasoning') {
    if (command === 'composer.increaseReasoningEffort') return 'ENC_CC';
    if (command === 'composer.decreaseReasoningEffort') return 'ENC_CW';
  }
  return null;
}

function validateAction(message) {
  if (!message || message.type !== 'codex_action' || !ACTIONS.has(message.action)) throw new Error('不支持的 Codex 操作。');
  if (typeof message.request_id !== 'string' || !/^[\w.:-]{1,128}$/.test(message.request_id)) throw new Error('无效的操作编号。');
  const draft = message.draft_id !== undefined;
  if (draft && (!['set_model', 'set_effort', 'set_fast', 'refresh_draft_settings'].includes(message.action) ||
      typeof message.draft_id !== 'string' || !/^[\w.:-]{1,128}$/.test(message.draft_id) ||
      typeof message.stream_id !== 'string' || !/^[\w.:-]{1,128}$/.test(message.stream_id) ||
      message.host_id !== 'local' || message.slot !== undefined || message.thread_id)) throw new Error('无效的新任务草稿身份。');
  if (message.action === 'refresh_draft_settings' && !draft) throw new Error('草稿身份缺失。');
  const active = !draft && message.slot === -1 && ['set_model', 'set_effort', 'set_fast'].includes(message.action);
  if (active && (typeof message.stream_id !== 'string' || !/^[\w.:-]{1,128}$/.test(message.stream_id))) throw new Error('当前任务连接身份缺失。');
  if (!draft && !active && message.action !== 'new_task' && (!Number.isInteger(message.slot) || message.slot < 0 || message.slot > 5)) throw new Error('无效的任务槽位。');
  if (!draft && message.action !== 'new_task' && (typeof message.thread_id !== 'string' || !/^[\w-]{1,128}$/.test(message.thread_id) || message.host_id !== 'local')) throw new Error('任务身份尚未同步。');
  if (message.action === 'set_fast' && typeof message.fast !== 'boolean') throw new Error('无效的 Fast 设置。');
  for (const field of ['model', 'effort']) {
    if (message.action === `set_${field}` && (typeof message[field] !== 'string' || !/^[\w.:-]{1,100}$/.test(message[field]))) throw new Error(`无效的 ${field} 设置。`);
  }
  return { type: 'codex_action', request_id: message.request_id, action: message.action,
    ...(draft ? { draft_id: message.draft_id, stream_id: message.stream_id, host_id: 'local' } :
      message.action === 'new_task' ? {} : { slot: message.slot, thread_id: message.thread_id, host_id: message.host_id, ...(active ? { stream_id: message.stream_id } : {}) }),
    ...(message.action === 'set_model' ? { model: message.model } : {}),
    ...(message.action === 'set_effort' ? { effort: message.effort } : {}),
    ...(message.action === 'set_fast' ? { fast: message.fast } : {}) };
}

class CodexControls extends EventEmitter {
  constructor(options) {
    super();
    this.state = options.state;
    this.getController = options.getController || (() => null);
    this.isVoiceBusy = options.isVoiceBusy || (() => false);
    this.resolveDraft = options.resolveDraft || null;
    this.draftTimer = null;
    this.draftPollMs = options.draftPollMs ?? 500;
    this.draftBindTimeoutMs = options.draftBindTimeoutMs ?? 30000;
    this.nativeDraftPollMs = options.nativeDraftPollMs ?? 2500;
    this.pendingNewTask = null;
    this.confirmTimeoutMs = options.confirmTimeoutMs || 7000;
    this.targetSettleMs = options.targetSettleMs ?? 350;
    this.queue = Promise.resolve();
    this.requests = new Map();
    this.generation = 0;
    this.pending = 0;
    this.closed = false;
  }

  isBusy() { return this.pending > 0 || this.draftResolving === true; }
  invalidate() { this.generation++; clearTimeout(this.draftTimer); this.draftTimer = null; this.pendingNewTask = null; this.emit('cancel'); }
  stop() { this.closed = true; this.invalidate(); }

  _publishDraft(draft = this.pendingNewTask) {
    if (draft && this.pendingNewTask !== draft) return;
    // Draft state has its own lifecycle, independent of thread-stream updates.
    // Advance the shared revision so a delayed action response cannot roll a
    // newer settings/binding update back on the device.
    this.state.advanceRevision?.();
    this.emit('state', this.getSnapshot());
  }

  _diagnose(draft, stage, error = null) {
    this.emit('diagnostic', { requestId: draft.requestId, stage,
      elapsedMs: Date.now() - draft.createdAt, error });
  }

  noteNativeSubmission(draftToken) {
    const pending = this.pendingNewTask;
    if (!pending || pending.requestId !== draftToken) return;
    pending.submitted = true;
    pending.submittedAt = Date.now();
    pending.status = 'binding';
    pending.error = null;
    pending.lastNativePollAt = 0;
    this.state.selectSlot(null);
    void this.state.refreshTaskList?.();
    this._diagnose(pending, 'submitted');
    this._publishDraft(pending);
    this._scheduleDraftResolution(pending, 0);
  }

  _scheduleDraftResolution(draft, delay = this.draftPollMs) {
    clearTimeout(this.draftTimer);
    if (this.closed || this.pendingNewTask !== draft || !this.resolveDraft || draft.status === 'error') return;
    this.draftTimer = setTimeout(() => { this.draftTimer = null; void this._resolveSubmittedDraft(draft); }, delay);
    this.draftTimer.unref?.();
  }

  async _resolveSubmittedDraft(draft) {
    if (this.closed || this.pendingNewTask !== draft || draft.status === 'error') return;
    if (!draft.submitted) return;
    if (this.pending || this.isVoiceBusy()) return this._scheduleDraftResolution(draft);
    this.draftResolving = true;
    try {
      await this.state.refreshTaskList?.();
      if (this.closed || this.pendingNewTask !== draft) return;
      const bindings = this.state.getThreadBindings?.() || {};
      const candidates = [...new Set(Object.entries(bindings).filter(([client, thread]) =>
        !draft.bindings[client] && !Object.values(draft.bindings).includes(thread)).map(([, thread]) => thread))];
      if (candidates.length && (!draft.lastNativePollAt || Date.now() - draft.lastNativePollAt >= this.nativeDraftPollMs)) {
        // Native current-page identity chooses the task; recency and the order
        // of unrelated thread-created events never choose it.
        draft.lastNativePollAt = Date.now();
        const result = await this.resolveDraft({ draftToken: draft.requestId, candidates });
        if (this.closed || this.pendingNewTask !== draft) return;
        if (result?.threadId && candidates.includes(result.threadId) && this.state.getSnapshot().connected) {
          this.pendingNewTask = null;
          this.state.selectThread(result.threadId, 'local');
          this._diagnose(draft, 'bound');
          this._publishDraft();
          void this.state.refreshTaskList?.();
          return;
        }
      }
    } catch (error) { draft.error = error.message; }
    finally { this.draftResolving = false; }
    if (this.closed || this.pendingNewTask !== draft) return;
    if (draft.submitted && Date.now() - draft.submittedAt > this.draftBindTimeoutMs) {
      draft.status = 'error';
      draft.error = `消息已发送，任务同步失败。${draft.error || ''}可重试同步，或从菜单选择刚创建的任务。`;
      this._diagnose(draft, 'binding_error', draft.error);
      this._publishDraft(draft);
      return;
    }
    this._scheduleDraftResolution(draft);
  }

  getSnapshot() {
    const snapshot = this.state.getSnapshot();
    if (this.pendingNewTask?.status === 'preparing') {
      snapshot.selectedSlot = null;
      delete snapshot.activeTask;
      snapshot.conversation = null;
    }
    const micro = this.getController()?.getStatus?.();
    const microReady = Boolean(micro?.connected && micro?.microConnected);
    const selected = snapshot.slots[snapshot.selectedSlot] || snapshot.activeTask;
    const selectedReady = Boolean(selected?.synced && selected.hostId === 'local');
    const available = Boolean(snapshot.connected &&
      !['preparing', 'binding', 'error'].includes(this.pendingNewTask?.status));
    const modelReady = available && selectedReady;
    const effortReady = modelReady;
    const fastReady = modelReady && typeof selected?.fast === 'boolean';
    return { ...snapshot, draftRequestId: this.pendingNewTask?.requestId || null,
      draftStatus: this.pendingNewTask?.status || (this.pendingNewTask?.submitted ? 'binding' : this.pendingNewTask ? 'editing' : null),
      draftSubmitted: Boolean(this.pendingNewTask?.submitted),
      draftSettingsLoading: false,
      draftError: this.pendingNewTask?.error || null,
      draftSettings: null, capabilities: {
      selectTask: snapshot.connected && microReady,
      newTask: snapshot.connected && !this.pendingNewTask && microReady && Boolean(commandKey(this.state.getMicroLayout(), 'newTask')),
      setModel: modelReady, setEffort: effortReady, setFast: fastReady
    } };
  }

  handle(input) {
    let action;
    try { action = validateAction(input); } catch (error) {
      return Promise.resolve({ type: 'codex_action_result', request_id: typeof input?.request_id === 'string' ? input.request_id.slice(0, 128) : '', action: input?.action, success: false, error: error.message });
    }
    const signature = JSON.stringify(action);
    const previous = this.requests.get(action.request_id);
    if (previous) {
      if (previous.signature === signature) return previous.promise;
      return Promise.resolve({ type: 'codex_action_result', request_id: action.request_id, action: action.action, success: false, error: '操作编号已用于其他请求。' });
    }
    if (this.pending >= 12) return Promise.resolve({ type: 'codex_action_result', request_id: action.request_id, action: action.action, success: false, error: '请等待当前操作完成。' });
    const generation = this.generation;
    this.pending++;
    const promise = this.queue.catch(() => {}).then(async () => {
      try {
        this._guard(generation);
        const result = await this._execute(action, generation);
        this._guard(generation);
        return { type: 'codex_action_result', request_id: action.request_id, action: action.action, success: true, ...result, state: this.getSnapshot() };
      } catch (error) {
        return { type: 'codex_action_result', request_id: action.request_id, action: action.action, success: false, error: error.message, state: this.getSnapshot() };
      } finally { this.pending--; }
    });
    this.requests.set(action.request_id, { signature, promise });
    this.queue = promise;
    // Keep in-flight entries and a bounded recent history across Wi-Fi reconnects.
    if (this.requests.size > 256) this.requests.delete(this.requests.keys().next().value);
    return promise;
  }

  _guard(generation) {
    if (this.closed || this.generation !== generation) throw new Error('连接已变化，请重新操作。');
    if (!this.state.getSnapshot().connected) throw new Error('Codex 已断开，请等待重新连接。');
    if (this.isVoiceBusy()) throw new Error('请先结束语音输入。');
    if (this.draftResolving) throw new Error('正在同步新任务，请稍候。');
  }

  _target(slot, requireSync = false) {
    const snapshot = this.state.getSnapshot();
    const target = slot === -1 ? snapshot.activeTask : snapshot.slots[slot];
    if (!target?.threadId) throw new Error('任务尚未同步，请稍后重试。');
    if (target.hostId !== 'local') throw new Error('当前仅支持本机 Codex 任务。');
    if (requireSync && (!snapshot.connected || !target.synced)) throw new Error('任务状态尚未同步，请先打开该任务。');
    return target;
  }

  _controller() {
    const controller = this.getController();
    const status = controller?.getStatus?.();
    if (!status?.connected || !status?.microConnected) throw new Error('Codex Micro 尚未连接。');
    return controller;
  }

  async _select(slot, generation) {
    const target = this._target(slot);
    const identity = `${target.hostId}:${target.threadId}`;
    await this.activateMicroTask(target.threadId, target.hostId, () => this._guard(generation));
    this.pendingNewTask = null;
    const current = this.state.getSnapshot().slots.find(item => item.hostId + ':' + item.threadId === identity);
    if (!current) throw new Error('任务绑定已变化，请重新选择。');
    this.state.selectSlot(current.slot);
    return { delivery: 'submitted_to_hid', outcome: 'requested' };
  }

  async activateMicroTask(threadId, hostId = 'local', guard = () => {}) {
    guard();
    const snapshot = this.state.getSnapshot();
    if (!snapshot.connected) throw new Error('Codex 已断开。');
    const target = snapshot.slots.find(item => item.threadId === threadId && item.hostId === hostId);
    if (!target) throw new Error('当前任务不在 Micro 的六个槽位中，请先在设备任务菜单选择任务。');
    const config = this.state.getMicroLayout();
    if (typeof config.singleTap !== 'boolean') throw new Error('Micro 任务按键配置尚未同步。');
    const key = `AG${String(target.slot).padStart(2, '0')}`;
    const taps = config.singleTap ? 1 : 2;
    for (let i = 0; i < taps; i++) {
      guard();
      const current = this.state.getSnapshot().slots[target.slot];
      if (current?.threadId !== threadId || current?.hostId !== hostId || this.state.getMicroLayout().source !== config.source) {
        throw new Error('Micro 槽位已变化，请重新选择。');
      }
      const result = await this._controller().tapKey(key);
      if (result?.delivery !== 'submitted_to_hid') throw new Error('Micro 按键投递未确认。');
    }
    if (this.targetSettleMs) await new Promise(resolve => setTimeout(resolve, this.targetSettleMs));
    guard();
    const current = this.state.getSnapshot().slots[target.slot];
    if (current?.threadId !== threadId || current?.hostId !== hostId) throw new Error('Micro 槽位已变化，请重新选择。');
    return { delivery: 'submitted_to_hid', outcome: 'requested' };
  }

  async _execute(action, generation) {
    if (action.draft_id) return this._executeDraft(action, generation);
    if (action.slot === -1 && action.stream_id !== this.state.getSnapshot().streamId) throw new Error('当前任务连接已变化。');
    if (action.slot !== -1 && this.state.getSnapshot().source !== 'custom' && action.action !== 'new_task') {
      await this.state.refreshTaskList?.();
      this._guard(generation);
      const current = this.state.getSnapshot().slots.find(slot => slot.threadId === action.thread_id && slot.hostId === action.host_id);
      if (!current) throw new Error('任务列表已更新，请重新选择。');
      action = { ...action, slot: current.slot };
    }
    if (action.action !== 'new_task') {
      const bound = this._target(action.slot);
      if (bound.threadId !== action.thread_id || bound.hostId !== action.host_id) throw new Error('任务绑定已变化，请重新选择。');
    }
    if (action.action === 'select_task') return this._select(action.slot, generation);
    if (action.action === 'new_task') {
      if (this.pendingNewTask) throw new Error('新任务已打开，请先输入内容或选择另一个任务。');
      await this.state.refreshTaskList?.();
      this._guard(generation);
      const newTaskKey = commandKey(this.state.getMicroLayout(), 'newTask');
      if (!newTaskKey) throw new Error('请在 Codex 设置 → Codex Micro 中，将一个命令键绑定为“新建任务”（NEW）。');
      const snapshot = this.state.getSnapshot();
      const selected = snapshot.slots[snapshot.selectedSlot] || snapshot.activeTask;
      const foregroundTarget = snapshot.slots.find(slot => slot.hostId === 'local' && slot.threadId &&
        slot.threadId === selected?.threadId && slot.hostId === selected?.hostId) ||
        snapshot.slots.find(slot => slot.hostId === 'local' && slot.threadId);
      if (!foregroundTarget) throw new Error('没有可用于唤起 Codex 的本机 Micro 任务槽位，请先绑定一个任务。');
      const draft = { requestId: action.request_id, bindings: this.state.getThreadBindings?.() || {},
        createdAt: Date.now(), status: 'preparing' };
      this.pendingNewTask = draft;
      this._diagnose(draft, 'preparing');
      this._publishDraft(draft);
      try {
        // Agent keys bring Codex forward. Do this before NEW so they cannot
        // navigate away from the newly opened draft.
        await this.activateMicroTask(foregroundTarget.threadId, foregroundTarget.hostId, () => this._guard(generation));
        if (commandKey(this.state.getMicroLayout(), 'newTask') !== newTaskKey) throw new Error('Micro 新建任务按键配置已变化，请重试。');
        const result = await this._controller().tapKey(newTaskKey);
        this._guard(generation);
        if (result?.delivery !== 'submitted_to_hid') throw new Error('新建任务按键未投递。');
        if (this.pendingNewTask !== draft) throw new Error('新任务草稿已变化。');
        draft.status = 'editing';
        this._guard(generation);
        this.state.selectSlot(null);
        this._diagnose(draft, 'editing');
        this._publishDraft(draft);
        return { delivery: result.delivery, outcome: 'requested' };
      } catch (error) {
        if (this.pendingNewTask === draft) {
          this.pendingNewTask = null;
          this._diagnose(draft, 'prepare_error', error.message);
          this._publishDraft();
        }
        throw error;
      }
    }

    const target = this._target(action.slot, true);
    if ((this.state.getSnapshot().selectedSlot ?? -1) !== action.slot) throw new Error('请先选择要调整的任务。');
    const models = this.state.getSnapshot().models;
    const currentModel = this.state.getControlModel?.(target.model) || models.find(model => model.id === target.model);
    const patch = {};
    if (action.action === 'set_model') {
      const model = models.find(item => item.id === action.model);
      if (!model) throw new Error('当前客户端不支持此模型。');
      patch.model = model.id;
      if (!model.efforts.some(item => item.id === target.effort) && model.efforts.length) patch.effort = model.defaultEffort || model.efforts[0].id;
      if (target.fast && !model.fastSupported) patch.serviceTier = 'default';
    } else if (action.action === 'set_effort') {
      const efforts = currentModel?.efforts || [];
      if (!efforts.some(item => item.id === action.effort)) throw new Error('当前模型不支持此推理强度。');
      patch.effort = action.effort;
    } else {
      if (!currentModel?.fastSupported) throw new Error('当前模型不支持 Fast。');
      if (target.fast === null) throw new Error('Fast 状态尚未同步。');
      patch.serviceTier = action.fast ? (currentModel.fastTier || 'priority') : 'default';
    }
    const matches = slot => Object.entries(patch).every(([field, value]) => slot?.[field] === value);
    if (matches(target)) return { delivery: 'unchanged', outcome: 'confirmed' };
    this._guard(generation);
    await this.state.requestSettingsUpdate(target.threadId, patch, { hostId: target.hostId });
    await this._confirm(action.slot, target, matches, generation);
    return { delivery: 'desktop_ipc', outcome: 'confirmed' };
  }

  async _executeDraft(action, generation) {
    const draft = this.pendingNewTask;
    if (draft?.submitted && action.action === 'refresh_draft_settings' && draft.requestId === action.draft_id &&
        action.stream_id === this.state.getSnapshot().streamId) {
      this._guard(generation);
      draft.submittedAt = Date.now(); draft.error = null; draft.status = 'binding'; draft.lastNativePollAt = 0;
      this._publishDraft(draft);
      this._scheduleDraftResolution(draft, 0);
      return { outcome: 'binding' };
    }
    throw new Error('新任务使用 Codex 当前默认参数；发送首条消息后可调整模型、推理强度和 Fast。');
  }

  _confirm(slot, target, matches, generation) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.state.off('state', check); this.off('cancel', cancel); };
      const cancel = () => { cleanup(); reject(new Error('连接已变化，操作结果尚未确认。')); };
      const check = () => {
        try {
          this._guard(generation);
          const snapshot = this.state.getSnapshot();
          const current = [...snapshot.slots, snapshot.activeTask].find(item => item?.threadId === target.threadId && item.hostId === target.hostId);
          if (!current?.synced || !snapshot.connected) throw new Error('任务状态尚未同步。');
          if (current.threadId !== target.threadId || current.hostId !== target.hostId) throw new Error('任务绑定已变化。');
          if (matches(current)) { cleanup(); resolve(); }
        } catch (error) { cleanup(); reject(error); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('尚未收到 Codex 的设置确认，请检查电脑端后重试。')); }, this.confirmTimeoutMs);
      this.state.on('state', check); this.once('cancel', cancel); check();
    });
  }
}

module.exports = { CodexControls, validateAction, commandKey };
