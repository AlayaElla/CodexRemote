const { EventEmitter } = require('node:events');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { projectHistory, applyHistoryPatches, recentMessages } = require('./codex-conversation-history');
const { projectRequest, projectAsyncWidgets, findInteraction, nativeResponse, projectCompletion, turnSlots, applyCompletionPatch } = require('./codex-desktop-interactions');
const CodexAsyncQuestions = require('./codex-async-questions');

const PIPE_PATH = '\\\\.\\pipe\\codex-ipc';
const STREAM_METHOD = 'thread-stream-state-changed';
const FOLLOW_METHOD = 'thread-stream-following-changed';
const STATE_VERSION = 11;
// Long-lived tasks can include multi-megabyte snapshots. The metadata filter
// below keeps only device-visible chat text and task metadata after parsing.
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const ALLOWED_ROOTS = new Set(['id', 'title', 'threadRuntimeStatus', 'latestModel', 'latestReasoningEffort', 'latestThreadSettings']);
const subscriptionKey = (hostId, threadId) => `${hostId}:${threadId}`;
const ACTIVE_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);
// Preserve positions so an Immer array-index patch still addresses the same
// flag after unrelated runtime flags have been stripped from the payload.
const sanitizeFlags = flags => flags.slice(0, 64).map(flag => ACTIVE_FLAGS.has(flag) ? flag : null);

function allowedSettings(value) {
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  for (const key of ['model', 'effort', 'serviceTier']) {
    if (typeof value[key] === 'string' && value[key]) out[key] = value[key];
  }
  return out;
}

function sanitizeState(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const key of ALLOWED_ROOTS) {
    if (key === 'latestThreadSettings') {
      const settings = allowedSettings(value[key]);
      if (settings) out[key] = settings;
    } else if (key === 'threadRuntimeStatus' && value[key] && typeof value[key] === 'object') {
      const runtime = {};
      for (const field of ['type', 'state', 'status']) if (typeof value[key][field] === 'string') runtime[field] = value[key][field];
      if (Array.isArray(value[key].activeFlags)) runtime.activeFlags = sanitizeFlags(value[key].activeFlags);
      out[key] = runtime;
    } else if (Object.hasOwn(value, key) && (typeof value[key] === 'string' || value[key] === null)) {
      out[key] = value[key];
    }
  }
  return out;
}

function patchPath(path) {
  if (Array.isArray(path)) return path;
  return typeof path === 'string' ? path.split('/').slice(1) : [];
}

class CodexDesktopIpc extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pipePath = options.pipePath || PIPE_PATH;
    this.ipcFactory = options.ipcFactory || (path => net.connect(path));
    this.timers = options.timers || global;
    this.maxFrameBytes = options.maxFrameBytes || MAX_FRAME_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs || 7000;
    this.reconnectDelayMs = options.reconnectDelayMs || 1500;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.clientId = 'initializing-client';
    this.pending = new Map();
    this.subscriptions = new Map();
    this.subscribing = new Map();
    this.following = new Map();
    this.states = new Map();
    this.histories = new Map();
    this.interactionSlots = new Map();
    this.asyncInteractions = new Map();
    this.asyncResponses = new Set();
    this.rolloutPaths = new Map();
    this.asyncQuestionSource = options.asyncQuestionSource || new CodexAsyncQuestions(options.asyncQuestionSourceOptions);
    this.asyncRefreshMs = options.asyncRefreshMs || 1000;
    this.asyncRefreshTimers = new Map();
    this.turnSlots = new Map();
    this.started = false;
    this.connected = false;
    this.stopping = false;
    this.reconnectTimer = null;
    this.connectionGeneration = 0;
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.stopping = false;
    this._open();
    return this;
  }

  _open() {
    if (!this.started || this.stopping) return;
    const generation = ++this.connectionGeneration;
    const socket = this.ipcFactory(this.pipePath);
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on('connect', () => {
      if (this._isCurrentSocket(socket, generation)) this._initialize(socket, generation);
    });
    socket.on('data', chunk => {
      if (this._isCurrentSocket(socket, generation)) this._onData(chunk, socket, generation);
    });
    socket.on('error', error => this._disconnect(error, socket, generation));
    socket.on('close', () => this._disconnect(undefined, socket, generation));
  }

  _isCurrentSocket(socket, generation) {
    return !this.stopping && this.socket === socket && this.connectionGeneration === generation;
  }

  stop() {
    this.stopping = true;
    if (this.reconnectTimer) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const record of this.following.values()) this._follow(record, false);
    this.following.clear();
    this.subscriptions.clear();
    this.subscribing.clear();
    this.histories.clear();
    this.interactionSlots.clear();
    this.asyncInteractions.clear();
    this.rolloutPaths.clear();
    for (const timer of this.asyncRefreshTimers.values()) this.timers.clearTimeout(timer);
    this.asyncRefreshTimers.clear();
    this.turnSlots.clear();
    this._disconnect();
    if (this.socket) {
      try { this.socket.end(); } catch (_) { /* already closed */ }
      try { this.socket.destroy(); } catch (_) { /* already closed */ }
    }
    this.socket = null;
    this.started = false;
  }

  subscribe({ hostId = 'local', threadId }) {
    if (!threadId) throw new Error('threadId is required');
    if (hostId !== 'local') { this.emit('unavailable', { hostId, threadId, error: 'remote hosts are unsupported' }); return Promise.resolve(false); }
    const key = subscriptionKey(hostId, threadId);
    const record = this.subscriptions.get(key) || { hostId, threadId };
    this.subscriptions.set(key, record);
    if (this.following.has(key)) return Promise.resolve(true);
    const inFlight = this.subscribing.get(key);
    if (inFlight) return inFlight;
    const request = this._subscribe(record).finally(() => {
      if (this.subscribing.get(key) === request) this.subscribing.delete(key);
    });
    this.subscribing.set(key, request);
    return request;
  }

  async _subscribe(record) {
    const { hostId, threadId } = record;
    const key = subscriptionKey(hostId, threadId);
    if (!this.started) this.start();
    await this._waitForReady();
    const socket = this.socket;
    const generation = this.connectionGeneration;
    if (!this._isCurrentSubscription(record, socket, generation)) return false;
    const existing = this.following.get(key);
    if (existing) return true;
    const response = await this._request('thread-owner-discovery', { hostId, conversationId: threadId }, 1);
    if (!this._isCurrentSubscription(record, socket, generation)) return false;
    if (response.resultType !== 'success' || !response.handledByClientId) {
      this.emit('unavailable', { hostId, threadId, error: response.error || 'no-client-found' });
      return false;
    }
    const activeRecord = { hostId, threadId, owner: response.handledByClientId };
    this.following.set(key, activeRecord);
    this._follow(activeRecord, true);
    return true;
  }

  unsubscribe(threadId, hostId = 'local') {
    const key = subscriptionKey(hostId, threadId);
    const record = this.following.get(key);
    const subscribed = this.subscriptions.delete(key);
    if (!record && !subscribed) return false;
    if (record) this._follow(record, false);
    this.subscribing.delete(key);
    this.following.delete(key);
    this.states.delete(key);
    this.histories.delete(key);
    this.interactionSlots.delete(key);
    this.asyncInteractions.delete(key);
    this.rolloutPaths.delete(key);
    this._stopAsyncRefresh(key);
    this.turnSlots.delete(key);
    return true;
  }

  _isCurrentSubscription(record, socket, generation) {
    return this._isCurrentSocket(socket, generation)
      && this.subscriptions.get(subscriptionKey(record.hostId, record.threadId)) === record;
  }

  async requestSettingsUpdate(threadId, settings, { hostId = 'local' } = {}) {
    if (hostId !== 'local') throw new Error('remote hosts are unsupported');
    const record = this.following.get(subscriptionKey(hostId, threadId));
    if (!record) throw new Error('thread is not subscribed');
    const clean = allowedSettings(settings);
    if (!clean || !Object.keys(clean).length || Object.keys(settings || {}).some(key => !['model', 'effort', 'serviceTier'].includes(key))) {
      throw new Error('invalid thread settings');
    }
    const response = await this._request('thread-follower-update-thread-settings', {
      hostId: record.hostId,
      conversationId: threadId,
      threadSettings: clean
    }, 2, { toClientId: record.owner });
    if (response.resultType !== 'success' || response.result?.applied !== true) throw new Error(response.error || 'settings update was rejected');
    await this._waitForSettings(threadId, clean, hostId);
    return clean;
  }

  async respondInteraction(threadId, interactionId, payload, { hostId = 'local' } = {}) {
    if (hostId !== 'local') throw new Error('remote hosts are unsupported');
    const key = subscriptionKey(hostId, threadId);
    const record = this.following.get(key);
    if (!record) throw new Error('thread is not subscribed');
    const interaction = findInteraction(this.states.get(key)?.state?.interactions, interactionId);
    if (!interaction) throw new Error('interaction is not pending');
    const native = nativeResponse(interaction, payload);
    const params = { conversationId: threadId, requestId: interaction.nativeRequestId };
    if (native.response.decision) params.decision = native.response.decision;
    else params.response = native.response.response || native.response;
    const response = await this._request(native.method, params, native.version, { toClientId: record.owner });
    if (response.resultType !== 'success' || response.result?.ok !== true) throw new Error(response.error || 'interaction response was rejected');
    await this._waitForInteractionApplied(threadId, interaction.id, hostId);
    return { id: interaction.id, applied: true };
  }

  refreshAsyncQuestions(threadId, { hostId = 'local' } = {}) {
    const key = subscriptionKey(hostId, threadId);
    const current = this.states.get(key);
    if (!current || hostId !== 'local') return [];
    const taskTitle = typeof current.state.title === 'string' ? current.state.title : null;
    const nextAsync = this.asyncQuestionSource.pending({ threadId, rolloutPath: this.rolloutPaths.get(key) }).map(item => ({ ...item, taskTitle }));
    if (JSON.stringify(nextAsync) === JSON.stringify(this.asyncInteractions.get(key) || [])) return nextAsync;
    this.asyncInteractions.set(key, nextAsync);
    const state = { ...current.state, interactions: [...(this.interactionSlots.get(key) || []).filter(Boolean), ...nextAsync] };
    this.states.set(key, { ...current, state });
    this.emit('state', { hostId, threadId, revision: current.revision, state, kind: 'async-questions' });
    return nextAsync;
  }

  async respondAsyncQuestion(threadId, interactionId, answer, { hostId = 'local', assertCurrent = () => {} } = {}) {
    if (hostId !== 'local') throw new Error('remote hosts are unsupported');
    const key = subscriptionKey(hostId, threadId);
    const record = this.following.get(key);
    if (!record || !this.connected) throw new Error('thread is not subscribed');
    const socket = this.socket, generation = this.connectionGeneration;
    const guard = () => {
      assertCurrent();
      if (!this._isCurrentSocket(socket, generation) || !this.connected || this.following.get(key) !== record || !this.states.has(key))
        throw new Error('连接或目标任务已变化，请重新提交。');
    };
    guard();
    const interaction = findInteraction(this.refreshAsyncQuestions(threadId, { hostId }), interactionId);
    if (interaction?.nativeKind !== 'asyncTool' || interaction.canRespond !== true || !interaction.sourceQuestionId || interaction.questions?.length !== 1)
      throw new Error('问题已在电脑端回答或过期。');
    const question = interaction.questions[0];
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 32768
      || (!question.allowFreeText && !question.options?.some(option => option.label === answer.trim())))
      throw new Error('请填写或选择一个有效答案。');
    const observed = this.asyncQuestionSource.observe({ threadId, rolloutPath: this.rolloutPaths.get(key) });
    const completion = this.states.get(key)?.state?.completion;
    if (!observed.ok || (interaction.sourceTurnId
      ? observed.currentTurnId !== interaction.sourceTurnId || observed.currentTurnStatus !== 'inProgress'
      : completion?.status !== 'inProgress')) throw new Error('问题所属轮次已结束或无法确认，请在电脑端处理。');
    const responseKey = `${key}:${interaction.sourceQuestionId}`;
    if (this.asyncResponses.has(responseKey)) throw new Error('此问题的回答正在提交。');
    this.asyncResponses.add(responseKey);
    try {
      const expectedAnswer = answer.trim();
      const replies = [{ questionItemId: interaction.sourceQuestionId, question: question.question, answer: expectedAnswer }];
      const text = `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`;
      guard();
      // Codex 26.911: the card calls steerTurn with this envelope. The owner
      // supplies cwd/settings; restoreMessage is required for steering recovery.
      const response = await this._request('thread-follower-steer-turn', {
        conversationId: threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        clientUserMessageId: randomUUID(),
        restoreMessage: { cwd: null, context: { prompt: text, turnTrigger: 'send_user_message_async_question',
          addedFiles: [], fileAttachments: [], imageAttachments: [], ideContext: null } },
        attachments: []
      }, 1, { toClientId: record.owner });
      guard();
      if (response.resultType !== 'success' || response.handledByClientId !== record.owner)
        throw new Error(response.error || '问答 IPC 提交未被目标任务接收。');
      // Capture the identity before sending: the rollout can already contain the
      // answer, and periodic refresh can remove the pending card before the ACK.
      return await this.waitForAsyncInteractionResolved(threadId, interactionId, {
        hostId, timeoutMs: 10000, sourceQuestionId: interaction.sourceQuestionId, expectedAnswer, assertCurrent: guard
      });
    } finally { this.asyncResponses.delete(responseKey); }
  }

  _stopAsyncRefresh(key) {
    const timer = this.asyncRefreshTimers.get(key);
    if (timer) this.timers.clearTimeout(timer);
    this.asyncRefreshTimers.delete(key);
  }

  _scheduleAsyncRefresh(record) {
    const key = subscriptionKey(record.hostId, record.threadId);
    this._stopAsyncRefresh(key);
    if (!this.rolloutPaths.get(key) || !this.following.has(key) || !this.started) return;
    const tick = () => {
      this.asyncRefreshTimers.delete(key);
      if (!this.started || !this.following.has(key)) return;
      this.refreshAsyncQuestions(record.threadId, { hostId: record.hostId });
      this._scheduleAsyncRefresh(record);
    };
    this.asyncRefreshTimers.set(key, this.timers.setTimeout(tick, this.asyncRefreshMs));
  }

  waitForAsyncInteractionResolved(threadId, interactionId, { hostId = 'local', timeoutMs = this.requestTimeoutMs,
    sourceQuestionId: submittedQuestionId, expectedAnswer, assertCurrent = () => {} } = {}) {
    const key = subscriptionKey(hostId, threadId);
    const timeout = Number.isSafeInteger(timeoutMs) ? Math.max(250, Math.min(timeoutMs, 30_000)) : this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const initial = findInteraction(this.states.get(key)?.state?.interactions, interactionId);
      // Keep the source identity before refreshing.  A refresh may correctly
      // remove the interaction as soon as the JSONL reply appears; removal by
      // itself is never evidence that a response was applied.
      if (!submittedQuestionId && (!initial || initial.nativeKind !== 'asyncTool' || !initial.sourceQuestionId)) { reject(new Error('async interaction is not pending')); return; }
      const sourceQuestionId = submittedQuestionId || initial.sourceQuestionId;
      const deadline = Date.now() + timeout;
      const check = () => {
        try { assertCurrent(); } catch (error) { reject(error); return; }
        if (!this.states.has(key)) { reject(new Error('thread is not subscribed')); return; }
        this.refreshAsyncQuestions(threadId, { hostId });
        const answer = this.asyncQuestionSource.answerStatus({ threadId, rolloutPath: this.rolloutPaths.get(key), sourceQuestionId, expectedAnswer });
        if (answer.ok && answer.answered) { resolve({ id: interactionId, applied: true }); return; }
        if (Date.now() >= deadline) { reject(new Error('desktop question response was not confirmed by rollout')); return; }
        this.timers.setTimeout(check, 250);
      };
      if (!this.states.has(key)) { reject(new Error('thread is not subscribed')); return; }
      check();
    });
  }

  _initialize(socket, generation) {
    this._request('initialize', { clientType: 'codex-remote-state-reader' }, 0)
      .then(response => {
        if (!this._isCurrentSocket(socket, generation)) return;
        if (response.resultType !== 'success' || !response.result?.clientId) throw new Error(response.error || 'IPC initialization failed');
        this.clientId = response.result.clientId;
        this.connected = true;
        this.emit('ready');
        const restore = [...this.subscriptions.values()];
        this.following.clear();
        for (const record of restore) this.subscribe({ hostId: record.hostId, threadId: record.threadId }).catch(error => this.emit('unavailable', { ...record, error: error.message }));
      })
      .catch(error => this._disconnect(error, socket, generation));
  }

  _waitForReady() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = this.timers.setTimeout(() => { cleanup(); reject(new Error('IPC initialization timeout')); }, this.requestTimeoutMs);
      const ready = () => { cleanup(); resolve(); };
      const failed = error => { cleanup(); reject(error || new Error('IPC disconnected')); };
      const cleanup = () => { this.timers.clearTimeout(timeout); this.off('ready', ready); this.off('disconnect', failed); };
      this.once('ready', ready); this.once('disconnect', failed);
    });
  }

  _request(method, params, version, { toClientId } = {}) {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timeout = this.timers.setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${method} timeout`)); }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        this._send({ type: 'request', requestId, sourceClientId: this.clientId, method, params, version, timeoutMs: this.requestTimeoutMs - 1000, ...(toClientId ? { targetClientId: toClientId } : {}) });
      } catch (error) {
        this.timers.clearTimeout(timeout); this.pending.delete(requestId); reject(error);
      }
    });
  }

  _waitForSettings(threadId, expected, hostId) {
    const current = this.states.get(subscriptionKey(hostId, threadId))?.state?.latestThreadSettings || {};
    if (Object.entries(expected).every(([key, value]) => current[key] === value)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = this.timers.setTimeout(() => { cleanup(); reject(new Error('settings update was not confirmed by task stream')); }, this.requestTimeoutMs);
      const onState = event => {
        if (event.threadId !== threadId || event.hostId !== hostId) return;
        const observed = event.state.latestThreadSettings || {};
        if (Object.entries(expected).every(([key, value]) => observed[key] === value)) { cleanup(); resolve(); }
      };
      const onDisconnect = () => { cleanup(); reject(new Error('settings update cancelled by IPC disconnect')); };
      const cleanup = () => { this.timers.clearTimeout(timeout); this.off('state', onState); this.off('disconnect', onDisconnect); };
      this.on('state', onState); this.once('disconnect', onDisconnect);
    });
  }

  _waitForInteractionApplied(threadId, interactionId, hostId) {
    const pending = () => findInteraction(this.states.get(subscriptionKey(hostId, threadId))?.state?.interactions, interactionId);
    if (!pending()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = this.timers.setTimeout(() => { cleanup(); reject(new Error('interaction response was not applied by task stream')); }, this.requestTimeoutMs);
      const onState = event => {
        if (event.threadId === threadId && event.hostId === hostId && !pending()) { cleanup(); resolve(); }
      };
      const onDisconnect = () => { cleanup(); reject(new Error('interaction response cancelled by IPC disconnect')); };
      const cleanup = () => { this.timers.clearTimeout(timeout); this.off('state', onState); this.off('disconnect', onDisconnect); };
      this.on('state', onState); this.once('disconnect', onDisconnect);
    });
  }

  _follow(record, following) {
    if (!this.socket || !this.socket.writable) return;
    this._send({ type: 'broadcast', method: FOLLOW_METHOD, version: 1, sourceClientId: this.clientId, targetClientIds: [record.owner], params: { hostId: record.hostId, conversationId: record.threadId, following } });
  }

  _send(message) {
    if (!this.socket || !this.socket.writable) throw new Error('IPC socket is unavailable');
    const body = Buffer.from(JSON.stringify(message));
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32LE(body.length, 0); body.copy(frame, 4);
    this.socket.write(frame);
  }

  _onData(chunk, socket = this.socket, generation = this.connectionGeneration) {
    if (!this._isCurrentSocket(socket, generation)) return;
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (!size || size > this.maxFrameBytes) throw new Error('unexpected IPC frame size');
        if (this.buffer.length < size + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'));
        this.buffer = this.buffer.subarray(size + 4);
        this._receive(message);
      }
    } catch (error) { this._disconnect(error, socket, generation); }
  }

  _receive(message) {
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (pending) { this.timers.clearTimeout(pending.timeout); this.pending.delete(message.requestId); pending.resolve(message); }
      return;
    }
    if (message.type === 'client-discovery-request') {
      this._send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.type === 'broadcast' && message.method === 'thread-read-state-changed' && message.version === 3) {
      const value = message.params;
      if (value?.hostId === 'local' && typeof value.conversationId === 'string' && typeof value.hasUnreadTurn === 'boolean') {
        this.emit('attention', { hostId: 'local', threadId: value.conversationId, unread: value.hasUnreadTurn });
      }
      return;
    }
    if (message.type !== 'broadcast' || message.method !== STREAM_METHOD || message.version !== STATE_VERSION) return;
    const threadId = message.params?.conversationId;
    const hostId = message.params?.hostId || 'local';
    const record = this.following.get(subscriptionKey(hostId, threadId));
    if (!record || record.owner !== message.sourceClientId || (message.params?.hostId && message.params.hostId !== record.hostId)) return;
    const change = message.params.change;
    if (change?.type === 'snapshot') {
      const state = sanitizeState(change.conversationState);
      const key = subscriptionKey(record.hostId, threadId);
      const slots = Array.isArray(change.conversationState?.requests) ? change.conversationState.requests.map(request => projectRequest(request, change.conversationState)) : [];
      this.interactionSlots.set(key, slots);
      const rolloutPath = typeof change.conversationState?.rolloutPath === 'string' ? change.conversationState.rolloutPath : null;
      this.rolloutPaths.set(key, rolloutPath);
      const taskTitle = typeof change.conversationState?.title === 'string' && change.conversationState.title.trim().length <= 4096 ? change.conversationState.title.trim() : null;
      this.asyncInteractions.set(key, [...this.asyncQuestionSource.pending({ threadId, rolloutPath }).map(item => ({ ...item, taskTitle })), ...projectAsyncWidgets(change.conversationState)]);
      state.interactions = [...slots.filter(Boolean), ...(this.asyncInteractions.get(key) || [])];
      const completion = projectCompletion(change.conversationState);
      if (completion) state.completion = completion;
      this.turnSlots.set(key, turnSlots(change.conversationState));
      const history = projectHistory(change.conversationState);
      this.histories.set(key, history);
      if ('turns' in history || 'turnHistory' in history) state.recentMessages = recentMessages(history);
      this.states.set(key, { revision: change.revision, state });
      this._scheduleAsyncRefresh(record);
      this.emit('state', { hostId: record.hostId, threadId, revision: change.revision, state, kind: 'snapshot' });
      return;
    }
    if (change?.type !== 'patches') return;
    const current = this.states.get(subscriptionKey(record.hostId, threadId));
    if (!current || current.revision !== change.baseRevision) {
      this.emit('resync-needed', { hostId: record.hostId, threadId, error: 'stream revision gap' });
      this.emit('unavailable', { hostId: record.hostId, threadId, error: 'stream revision gap' });
      this.unsubscribe(threadId, record.hostId);
      this.subscribe({ hostId: record.hostId, threadId }).catch(error => this.emit('unavailable', { hostId: record.hostId, threadId, error: error.message }));
      return;
    }
    const key = subscriptionKey(record.hostId, threadId);
    const next = { ...current.state, latestThreadSettings: current.state.latestThreadSettings && { ...current.state.latestThreadSettings } };
    let changed = false;
    const history = this.histories.get(subscriptionKey(record.hostId, threadId));
    if (history) {
      applyHistoryPatches(history, change.patches || []);
      if ('turns' in history || 'turnHistory' in history) {
        const messages = recentMessages(history);
        if (JSON.stringify(messages) !== JSON.stringify(next.recentMessages)) { next.recentMessages = messages; changed = true; }
      }
    }
    for (const patch of change.patches || []) {
      const path = patchPath(patch.path);
      if (path[0] === 'requests') {
        const slots = this.interactionSlots.get(key) || [];
        if (path.length === 1 && (patch.op === 'add' || patch.op === 'replace')) {
          this.interactionSlots.set(key, Array.isArray(patch.value) ? patch.value.map(projectRequest) : []);
        } else if (path.length === 1 && patch.op === 'remove') {
          this.interactionSlots.set(key, []);
        } else if (path.length === 2 && /^\d+$/.test(String(path[1]))) {
          const index = Number(path[1]);
          if (index <= 256) {
            if (patch.op === 'remove' && index < slots.length) slots.splice(index, 1);
            else if (patch.op === 'add') slots.splice(index, 0, projectRequest(patch.value));
            else if (patch.op === 'replace') slots[index] = projectRequest(patch.value);
            this.interactionSlots.set(key, slots);
          }
        }
        const interactions = [...(this.interactionSlots.get(key) || []).filter(Boolean), ...(this.asyncInteractions.get(key) || [])];
        if (JSON.stringify(next.interactions || []) !== JSON.stringify(interactions)) { next.interactions = interactions; changed = true; }
        continue;
      }
      if ((path[0] === 'turns' || path[0] === 'turnHistory') && path.at(-1) === 'status') {
        const completion = applyCompletionPatch(this.turnSlots.get(key), path, patch);
        if (completion && JSON.stringify(next.completion) !== JSON.stringify(completion)) { next.completion = completion; changed = true; }
        continue;
      }
      if (!ALLOWED_ROOTS.has(path[0])) continue;
      if (path.length === 1) {
        if (patch.op === 'remove' && Object.hasOwn(next, path[0])) { delete next[path[0]]; changed = true; }
        else if (patch.op === 'add' || patch.op === 'replace') {
          const value = sanitizeState({ [path[0]]: patch.value });
          if (JSON.stringify(value[path[0]]) !== JSON.stringify(next[path[0]])) { Object.assign(next, value); changed = true; }
        }
      } else if (path[0] === 'latestThreadSettings' && path.length === 2 && ['model', 'effort', 'serviceTier'].includes(path[1])) {
        next.latestThreadSettings ||= {};
        if (patch.op === 'remove' && Object.hasOwn(next.latestThreadSettings, path[1])) { delete next.latestThreadSettings[path[1]]; changed = true; }
        else if (typeof patch.value === 'string' && next.latestThreadSettings[path[1]] !== patch.value) { next.latestThreadSettings[path[1]] = patch.value; changed = true; }
      } else if (path[0] === 'threadRuntimeStatus' && path.length >= 2) {
        next.threadRuntimeStatus ||= {};
        if (path.length === 2 && ['type', 'state', 'status'].includes(path[1])) {
          if (patch.op === 'remove' && Object.hasOwn(next.threadRuntimeStatus, path[1])) { delete next.threadRuntimeStatus[path[1]]; changed = true; }
          else if (typeof patch.value === 'string' && next.threadRuntimeStatus[path[1]] !== patch.value) { next.threadRuntimeStatus[path[1]] = patch.value; changed = true; }
        } else if (path.length === 2 && path[1] === 'activeFlags' && Array.isArray(patch.value)) {
          const flags = sanitizeFlags(patch.value);
          if (JSON.stringify(next.threadRuntimeStatus.activeFlags || []) !== JSON.stringify(flags)) { next.threadRuntimeStatus.activeFlags = flags; changed = true; }
        } else if (path.length === 3 && path[1] === 'activeFlags') {
          const flags = [...(next.threadRuntimeStatus.activeFlags || [])];
          const index = Number(path[2]);
          if (!Number.isInteger(index) || index < 0 || index >= 64) continue;
          if (patch.op === 'remove' && index < flags.length) { flags.splice(index, 1); next.threadRuntimeStatus.activeFlags = flags; changed = true; }
          else if (patch.op === 'add' || patch.op === 'replace') {
            const value = ACTIVE_FLAGS.has(patch.value) ? patch.value : null;
            if (patch.op === 'add') flags.splice(index, 0, value);
            else flags[index] = value;
            next.threadRuntimeStatus.activeFlags = sanitizeFlags(flags); changed = true;
          }
        }
      }
    }
    this.states.set(key, { revision: change.revision, state: next });
    if (changed) this.emit('state', { hostId: record.hostId, threadId, revision: change.revision, state: next, kind: 'patches' });
  }

  _invalidateStreamCaches() {
    this.states.clear();
    this.histories.clear();
    this.interactionSlots.clear();
    this.asyncInteractions.clear();
    this.rolloutPaths.clear();
    this.turnSlots.clear();
    this.following.clear();
    this.subscribing.clear();
    for (const timer of this.asyncRefreshTimers.values()) this.timers.clearTimeout(timer);
    this.asyncRefreshTimers.clear();
  }

  _disconnect(error, socket = this.socket, generation = this.connectionGeneration) {
    if (socket && (this.socket !== socket || this.connectionGeneration !== generation)) return false;
    if (!this.started && !this.connected && !this.pending.size) return false;
    const oldSocket = this.socket;
    this.connected = false;
    this.clientId = 'initializing-client';
    this.buffer = Buffer.alloc(0);
    this._invalidateStreamCaches();
    for (const pending of this.pending.values()) { this.timers.clearTimeout(pending.timeout); pending.reject(error || new Error('IPC disconnected')); }
    this.pending.clear();
    if (!this.stopping && oldSocket) {
      this.socket = null;
      try { oldSocket.destroy(); } catch (_) { /* already closed */ }
    }
    if (this.started) this.emit('disconnect', error || new Error(this.stopping ? 'IPC stopped' : 'IPC disconnected'));
    if (this.started && !this.stopping && !this.reconnectTimer) {
      this.reconnectTimer = this.timers.setTimeout(() => { this.reconnectTimer = null; if (this.started && !this.stopping) this._open(); }, this.reconnectDelayMs);
    }
    return true;
  }
}

module.exports = { CodexDesktopIpc, PIPE_PATH, sanitizeState, allowedSettings, subscriptionKey };
