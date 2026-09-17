const { EventEmitter } = require('node:events');
const { createHash, createHmac, randomBytes } = require('node:crypto');

const MAX_TASKS = 32;
const MAX_INTERACTIONS = 32;
const MAX_NOTIFICATIONS = 512;
const MAX_REQUESTS = 256;
const MAX_DEVICE_STATE_BYTES = 448 * 1024;
const DEVICE_OPTION_BYTES = 512;
const DEVICE_TITLE_BYTES = 512;
const DEVICE_BODY_BYTES = 8192;
const DEVICE_QUESTION_BYTES = 4096;
const DEVICE_HEADER_BYTES = 512;
const DEVICE_DESCRIPTION_BYTES = 1024;
const DEVICE_RESPONSE_BYTES = 4096;
const DEVICE_ERROR_BYTES = 1024;
const ID = /^[\w.:-]{1,256}$/;
const RESPONSE_ID = /^[\w.:-]{1,128}$/;
const TERMINAL = new Set(['resolved', 'expired']);
const ACTIVE = new Set(['pending', 'submitting', 'error']);
const STATUSES = new Set(['pending', 'submitting', 'error', 'resolved', 'expired']);

const identity = (host, thread) => `${host}\0${thread}`;
const validId = value => typeof value === 'string' && ID.test(value);
const validResponseId = value => typeof value === 'string' && RESPONSE_ID.test(value);
function clip(value, maximum = DEVICE_QUESTION_BYTES) {
  if (typeof value !== 'string' || maximum <= 0) return '';
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximum) return value;
  let end = maximum;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}
const exceeds = (value, maximum) => typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum;
const clone = value => JSON.parse(JSON.stringify(value));
const notificationId = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const safeStatus = value => STATUSES.has(value) ? value : 'pending';

function safeOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap(option => validId(option?.id) && !exceeds(option.label, DEVICE_OPTION_BYTES) && option.label
    ? [{ id: option.id, label: option.label, ...(clip(option.description, DEVICE_DESCRIPTION_BYTES) ? { description: clip(option.description, DEVICE_DESCRIPTION_BYTES) } : {}) }] : []);
}
function safeQuestionOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap(option => !exceeds(option?.label, DEVICE_OPTION_BYTES) && option.label
    ? [{ label: option.label, ...(clip(option.description, DEVICE_DESCRIPTION_BYTES) ? { description: clip(option.description, DEVICE_DESCRIPTION_BYTES) } : {}) }] : []);
}
function hasOversizedForm(value, options) {
  if (Array.isArray(options) && (options.length > 16 || options.some(option => !validId(option?.id) || exceeds(option?.label, DEVICE_OPTION_BYTES) || !option.label))) return true;
  if (!Array.isArray(value)) return false;
  if (value.length > 8) return true;
  return value.some(question => {
    if (typeof question?.question === 'string' && exceeds(question.question, DEVICE_QUESTION_BYTES)) return true;
    if (!Array.isArray(question?.options)) return false;
    return question.options.length > 16 || question.options.some(option => exceeds(option?.label, DEVICE_OPTION_BYTES) || !option.label);
  });
}
function safeQuestions(value, opaqueIds = false) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((question, index) => {
    const id = opaqueIds ? `q${index}` : validId(question?.id) ? question.id : `question-${index + 1}`;
    const text = typeof question?.question === 'string' && !exceeds(question.question, DEVICE_QUESTION_BYTES) ? question.question : '';
    return text ? [{ id, header: clip(question.header, DEVICE_HEADER_BYTES) || null, question: text, options: safeQuestionOptions(question.options),
      allowFreeText: question.allowFreeText === true, multiple: question.multiple === true, isSecret: question.isSecret === true }] : [];
  });
}
function interactionProjection(source, id, existing) {
  const sourceStatus = safeStatus(source?.status);
  const status = existing && (TERMINAL.has(existing.status) || existing.status === 'submitting' || existing.status === 'error') ? existing.status : sourceStatus;
  const asyncTool = source?.nativeKind === 'asyncTool';
  const oversized = hasOversizedForm(source?.questions, source?.options);
  const questions = oversized ? [] : safeQuestions(source?.questions, asyncTool);
  const wireQuestions = questions.map((question, index) => ({ id: question.id, sourceId: validId(source?.questions?.[index]?.id) ? source.questions[index].id : null }));
  return { id, kind: source?.kind === 'approval' ? 'approval' : 'question', title: clip(source?.title, DEVICE_TITLE_BYTES) || '需要你的确认',
    body: oversized ? '此问题内容超过设备支持范围，请在电脑端回答。' : clip(source?.body, DEVICE_BODY_BYTES), status, options: oversized ? [] : safeOptions(source?.options), questions,
    canRespond: !oversized && source?.canRespond !== false, allowFreeText: source?.allowFreeText === true, multiple: source?.multiple === true, blockedBySize: oversized, wireQuestions,
    ...(validId(source?.turnId) ? { turnId: source.turnId } : {}), ...(validId(existing?.afterMessageId) ? { afterMessageId: existing.afterMessageId } : {}) };
}

function deviceInteraction(request, compact = false) {
  const base = {
    id: request.id,
    kind: request.kind === 'approval' ? 'approval' : 'question',
    title: clip(request.title, DEVICE_TITLE_BYTES) || '需要你的确认',
    status: safeStatus(request.status),
    body: compact ? '此表单内容过大，请在电脑端查看。' : clip(request.body, DEVICE_BODY_BYTES),
    options: compact ? [] : safeOptions(request.options),
    questions: compact ? [] : safeQuestions(request.questions),
    canRespond: !compact && request.canRespond === true,
    allowFreeText: !compact && request.allowFreeText === true,
    multiple: !compact && request.multiple === true,
    ...(request.turnId ? { turnId: request.turnId } : {}),
    ...(request.afterMessageId ? { afterMessageId: request.afterMessageId } : {}),
    ...(request.responseText ? { responseText: clip(request.responseText, DEVICE_RESPONSE_BYTES) } : {}),
    ...(request.error ? { error: clip(request.error, DEVICE_ERROR_BYTES) } : {})
  };
  return base;
}

function jsonBytes(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function isPureImageMessage(message) {
  return !message?.text && Array.isArray(message?.content) && message.content.length > 0 && message.content.every(part => part?.type === 'image');
}
function compactStateMetadata(result) {
  if (jsonBytes(result) <= MAX_DEVICE_STATE_BYTES) return;
  if (typeof result.error === 'string') result.error = clip(result.error, DEVICE_ERROR_BYTES);
  if (Array.isArray(result.slots)) result.slots = result.slots.slice(0, 6).map(slot => ({
    slot: slot?.slot, hostId: clip(slot?.hostId, 192) || null, threadId: clip(slot?.threadId, 192) || null,
    title: clip(slot?.title, DEVICE_TITLE_BYTES) || null, state: clip(slot?.state, 64) || 'unknown', synced: slot?.synced === true,
    model: clip(slot?.model, 192) || null, effort: clip(slot?.effort, 64) || null, fast: typeof slot?.fast === 'boolean' ? slot.fast : null,
    serviceTier: clip(slot?.serviceTier, 128) || null, updatedAt: clip(slot?.updatedAt, 128) || null
  }));
  if (Array.isArray(result.models)) result.models = result.models.map(model => ({
    id: clip(model?.id, 192), label: clip(model?.label, DEVICE_TITLE_BYTES),
    efforts: Array.isArray(model?.efforts) ? model.efforts.slice(0, 8).map(effort => ({ id: clip(effort?.id, 64), label: clip(effort?.label, 64) })) : [],
    defaultEffort: clip(model?.defaultEffort, 64) || null, fastSupported: model?.fastSupported === true, fastTier: clip(model?.fastTier, 128) || null
  }));
  while (jsonBytes(result) > MAX_DEVICE_STATE_BYTES && Array.isArray(result.models) && result.models.length) result.models.pop();
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function responseFingerprint(key, input, request) {
  // The runtime-only HMAC distinguishes changed answers without retaining their
  // plaintext or a reusable digest of a secret answer.
  const payload = request.kind === 'approval' ? { decision: input.decision } : { answers: input.answers };
  return createHmac('sha256', key).update(stableJson({ hostId: input.host_id, threadId: input.thread_id, interactionId: input.id, kind: request.kind, payload })).digest('base64url');
}

class CodexConversationStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.media = options.media;
    this.respondNative = typeof options.respondNative === 'function' ? options.respondNative : null;
    this.respondDesktop = typeof options.respondDesktop === 'function' ? options.respondDesktop : null;
    this.respondHook = typeof options.respondHook === 'function' ? options.respondHook : null;
    this.tasks = new Map();
    this.requests = new Map();
    this.notified = new Set();
    this.requestKey = randomBytes(32);
  }

  task(hostId, threadId) {
    const key = identity(hostId, threadId);
    let task = this.tasks.get(key);
    if (!task) {
      task = { hostId, threadId, initialized: false, messages: [], interactions: new Map(), completion: null, stoppedTurn: null };
      this.tasks.set(key, task);
      if (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value);
    }
    return task;
  }

  notify(task, kind, eventId, historical) {
    const id = notificationId(`${task.hostId}:${task.threadId}:${kind}:${eventId}`);
    if (this.notified.has(id)) return;
    this.notified.add(id);
    if (this.notified.size > MAX_NOTIFICATIONS) this.notified.delete(this.notified.values().next().value);
    if (!historical) this.emit('notification', { type: 'codex_notification', id, kind, host_id: task.hostId, thread_id: task.threadId, historical: false });
  }

  observe(event) {
    if (!event || event.hostId !== 'local' || !validId(event.threadId) || !event.state || typeof event.state !== 'object') return false;
    const task = this.task(event.hostId, event.threadId);
    const historical = !task.initialized || event.kind === 'snapshot';
    if (Array.isArray(event.state.recentMessages)) {
      task.messages = this.media ? this.media.prepareMessages(event.threadId, event.state.recentMessages) : clone(event.state.recentMessages);
    }
    if (Array.isArray(event.state.interactions)) {
      const pending = new Set();
      for (const source of event.state.interactions) {
        if (!validId(source?.id)) continue;
        const key = `native:${source.id}`;
        const existing = task.interactions.get(key);
        const current = interactionProjection(source, key, existing);
        pending.add(key);
        const next = { ...current, origin: 'native', nativeId: source.id, nativeKind: typeof source.nativeKind === 'string' ? source.nativeKind : '',
          // This object may carry desktop-only correlation fields. decorate() has
          // an allowlist and never serializes it to a device.
          desktopRequest: { ...clone(source), wireQuestions: current.wireQuestions },
          afterMessageId: existing?.afterMessageId ?? task.messages.at(-1)?.id ?? '' };
        const request = existing ? Object.assign(existing, next) : next;
        if (!existing) task.interactions.set(key, request);
        if (!existing && current.status === 'pending' && current.canRespond) this.notify(task, 'attention', key, historical);
      }
      for (const [key, request] of task.interactions) {
        if (request.origin !== 'native' || pending.has(key) || !ACTIVE.has(request.status)) continue;
        // A missing request may have been answered elsewhere or expired. It is not
        // evidence that this device's response was applied. A submission already
        // in flight retains its object until that transport returns a result.
        if (request.status === 'submitting') continue;
        request.status = 'expired'; request.responseText = '请求已过期或在电脑端处理'; request.error = '';
      }
    }
    const completion = event.state.completion;
    if (validId(completion?.turnId) && typeof completion.status === 'string') {
      if (completion.status === 'completed' && task.stoppedTurn !== completion.turnId) {
        this.notify(task, 'success', completion.turnId, historical || task.completion?.turnId !== completion.turnId || task.completion?.status !== 'inProgress');
      }
      task.completion = clone(completion);
    }
    task.initialized = true;
    this.trim(task); this.emit('change'); return true;
  }

  trim(task) {
    if (task.interactions.size <= MAX_INTERACTIONS) return;
    for (const [id, request] of task.interactions) {
      if (!ACTIVE.has(request.status)) task.interactions.delete(id);
      if (task.interactions.size <= MAX_INTERACTIONS) break;
    }
  }

  addHook(message) {
    const threadId = message?.session_id || message?.thread_id;
    const hostId = message?.host_id || 'local';
    if (hostId !== 'local' || !validId(threadId) || !validId(String(message?.id || '')) || message.blocking === false) return false;
    const task = this.task(hostId, threadId); const id = `hook:${message.id}`;
    if (task.interactions.has(id)) return false;
    const blockedBySize = hasOversizedForm([], message.options);
    const options = blockedBySize ? [] : safeOptions(message.options).filter(option => ['allow', 'allow_session', 'deny'].includes(option.id));
    task.interactions.set(id, { id, origin: 'hook', nativeId: String(message.id), kind: 'approval', title: '需要你的确认',
      body: blockedBySize ? '此审批内容超过设备支持范围，请在电脑端处理。' : clip([message.question, message.tool_name].filter(Boolean).join('\n\n'), DEVICE_BODY_BYTES), status: 'pending', options, questions: [], canRespond: !blockedBySize, blockedBySize,
      afterMessageId: task.messages.at(-1)?.id || '' });
    if (!blockedBySize) this.notify(task, 'attention', id, false); this.trim(task); this.emit('change'); return true;
  }

  resolveHook(message) {
    if (!message || !validId(String(message.id || ''))) return false;
    let changed = false;
    for (const task of this.tasks.values()) {
      const request = task.interactions.get(`hook:${message.id}`);
      if (!request || !ACTIVE.has(request.status)) continue;
      const applied = ['allow', 'deny'].includes(message.decision);
      request.status = applied ? 'resolved' : 'expired';
      request.responseText = message.decision === 'allow' ? '已允许' : message.decision === 'deny' ? '已拒绝' : '请求已过期';
      request.error = ''; changed = true;
    }
    if (changed) this.emit('change');
    return changed;
  }

  confirmNativeResponse(input) {
    const hostId = input?.hostId || input?.host_id;
    const threadId = input?.threadId || input?.thread_id;
    if (hostId !== 'local' || !validId(threadId) || !validId(input?.id)) return false;
    const request = this.tasks.get(identity(hostId, threadId))?.interactions.get(input.id);
    if (!request || request.origin !== 'native' || request.status !== 'submitting') return false;
    request.status = 'resolved'; request.error = ''; request.responseText = this.responseText(request, input.answers);
    for (const record of this.requests.values()) {
      if (record.hostId === hostId && record.threadId === threadId && record.interactionId === input.id) {
        record.result = { type: 'codex_interaction_result', request_id: record.requestId, id: input.id, host_id: hostId, thread_id: threadId, success: true, status: 'resolved' };
      }
    }
    this.emit('change'); return true;
  }

  failNativeResponse(input) {
    const hostId = input?.hostId || input?.host_id;
    const threadId = input?.threadId || input?.thread_id;
    if (hostId !== 'local' || !validId(threadId) || !validId(input?.id)) return false;
    const request = this.tasks.get(identity(hostId, threadId))?.interactions.get(input.id);
    if (!request || request.origin !== 'native' || request.status !== 'submitting') return false;
    request.status = 'error'; request.responseText = ''; request.error = clip(input?.error, DEVICE_ERROR_BYTES) || '电脑端未确认回答';
    for (const record of this.requests.values()) {
      if (record.hostId === hostId && record.threadId === threadId && record.interactionId === input.id) {
        record.result = { type: 'codex_interaction_result', request_id: record.requestId, id: input.id, host_id: hostId, thread_id: threadId, success: false, error: request.error };
      }
    }
    this.emit('change'); return true;
  }

  markStopped(hostId, threadId) {
    const task = this.tasks.get(identity(hostId, threadId));
    if (task) task.stoppedTurn = task.completion?.turnId || null;
  }

  decorate(snapshot) {
    const result = { ...snapshot };
    if (!snapshot?.conversation) { compactStateMetadata(result); return result; }
    const source = snapshot.conversation;
    const task = this.tasks.get(identity(source.hostId, source.threadId));
    const messages = task?.initialized ? task.messages : this.media
      ? this.media.prepareMessages(source.threadId, source.messages || []) : source.messages || [];
    const entries = task ? [...task.interactions.values()].map(request => ({ request, value: deviceInteraction(request) })) : [];
    const conversation = { ...source, messages: clone(messages.slice(-10)), interactions: entries.map(entry => entry.value) };
    result.conversation = conversation;
    const refreshInteractions = () => { conversation.interactions = entries.map(entry => entry.value); };

    // Terminal requests are historical context. Drop the oldest of those first,
    // while all pending/submitting/error IDs remain visible to the device.
    for (let index = 0; jsonBytes(result) > MAX_DEVICE_STATE_BYTES && index < entries.length;) {
      if (ACTIVE.has(entries[index].value.status)) { index += 1; continue; }
      entries.splice(index, 1); refreshInteractions();
    }
    // A valid but very large active form becomes an explicit desktop-only card;
    // its stable ID and status remain so the device cannot mistake it as gone.
    const active = entries.filter(entry => ACTIVE.has(entry.value.status)).sort((left, right) =>
      jsonBytes(right.value) - jsonBytes(left.value));
    for (const entry of active) {
      if (jsonBytes(result) <= MAX_DEVICE_STATE_BYTES) break;
      entry.value = deviceInteraction(entry.request, true); refreshInteractions();
    }
    // Media has already bounded its recent projection. This is an emergency
    // guard for a caller without that media projector: remove oldest textual
    // history only, never a legitimate pure-image row.
    while (jsonBytes(result) > MAX_DEVICE_STATE_BYTES) {
      const index = conversation.messages.findIndex(message => !isPureImageMessage(message));
      if (index < 0) break;
      conversation.messages.splice(index, 1);
    }
    compactStateMetadata(result);
    return result;
  }

  responseText(request, answers) {
    if (request.kind === 'approval') return /deny|decline/.test(request.decision || '') ? '已拒绝' : /Session|session/.test(request.decision || '') ? '已允许本次会话' : '已允许';
    return (request.questions || []).map(question => `${question.header || question.question}\n${question.isSecret ? '已提交' : (answers?.[question.id] || []).join('；')}`).join('\n\n');
  }

  async respond(input) {
    const base = { type: 'codex_interaction_result', request_id: validResponseId(input?.request_id) ? input.request_id : undefined,
      id: validId(input?.id) ? input.id : undefined, host_id: input?.host_id, thread_id: input?.thread_id };
    try {
      if (!validResponseId(input?.request_id) || input.host_id !== 'local' || !validId(input.thread_id) || !validId(input.id)) throw new Error('无效的请求身份。');
      const task = this.tasks.get(identity(input.host_id, input.thread_id));
      const request = task?.interactions.get(input.id);
      const desktopResponse = request?.origin === 'native' && request.nativeKind === 'asyncTool';
      if (!request) throw new Error('请求已处理或过期，请刷新后查看。');
      const fingerprint = responseFingerprint(this.requestKey, input, request);
      const previous = this.requests.get(input.request_id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('操作编号已用于其他回答。');
        return previous.result || previous.promise;
      }
      if (!['pending', 'error'].includes(request.status) || request.canRespond !== true) throw new Error(request.blockedBySize ? '问题内容超过设备支持范围，请在电脑端回答。' : '请求已处理或过期，请刷新后查看。');
      if (request.kind === 'approval' && !request.options.some(option => option.id === input.decision)) throw new Error('不支持此审批选项。');
      request.status = 'submitting'; request.error = ''; request.decision = input.decision; this.emit('change');
      const record = { fingerprint, requestId: input.request_id, hostId: input.host_id, threadId: input.thread_id, interactionId: input.id, result: null, promise: null };
      const promise = (async () => {
        try {
          if (request.origin === 'hook') {
            if (!this.respondHook || !await this.respondHook(request.nativeId, input.decision)) throw new Error('审批已过期或在电脑端处理。');
          } else if (desktopResponse) {
            if (!this.respondDesktop) throw new Error('电脑端交互不可用。');
            const response = await this.respondDesktop(input.thread_id, request.desktopRequest, input.answers, { hostId: input.host_id });
            if (response?.applied !== true) throw new Error('尚未确认回答已被接收。');
          } else {
            if (!this.respondNative) throw new Error('电脑端交互不可用。');
            const response = await this.respondNative(input.thread_id, request.nativeId,
              request.kind === 'approval' ? { decision: input.decision } : { answers: input.answers }, { hostId: input.host_id });
            if (response?.pending === true) {
              request.responseText = '正在等待电脑端确认'; this.emit('change');
              return { ...base, success: true, status: 'submitting', pending: true };
            }
            if (response?.applied !== true) throw new Error('尚未确认回答已被接收。');
          }
          request.status = 'resolved'; request.error = ''; request.responseText = this.responseText(request, input.answers);
          this.emit('change'); return { ...base, success: true, status: 'resolved' };
        } catch (error) {
          if (request.status === 'submitting') request.status = 'error';
          request.error = clip(error?.message, DEVICE_ERROR_BYTES) || '提交失败'; this.emit('change');
          return { ...base, success: false, error: request.error };
        }
      })();
      record.promise = promise;
      this.requests.set(input.request_id, record);
      if (this.requests.size > MAX_REQUESTS) this.requests.delete(this.requests.keys().next().value);
      record.result = await promise;
      return record.result;
    } catch (error) { return { ...base, success: false, error: clip(error?.message, DEVICE_ERROR_BYTES) || '提交失败' }; }
  }
}

module.exports = CodexConversationStore;
