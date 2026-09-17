// Projects only the user-actionable subset of Codex Desktop pending requests.
// The IPC source owns the raw request objects; this module never returns them.
const TEXT_LIMIT = 4096;
const ID_LIMIT = 256;
const MAX_INTERACTIONS = 32;
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 16;
const EXEC_DECISIONS = new Set(['accept', 'acceptForSession', 'decline']);
const FILE_DECISIONS = new Set(['accept', 'acceptForSession', 'decline']);
const PERMISSION_DECISIONS = new Set(['accept', 'acceptForSession', 'decline']);
const TURN_STATUSES = new Map([
  ['inProgress', 'inProgress'],
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['interrupted', 'interrupted']
]);

function text(value, limit = TEXT_LIMIT) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}
function id(value) { return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value, ID_LIMIT); }
function requestIdentity(value) {
  if (typeof value === 'string') {
    const display = id(value);
    return display ? { id: display, nativeRequestId: value } : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return { id: `number:${value}`, nativeRequestId: value };
  return null;
}
function option(value) {
  const label = text(value?.label);
  return label ? { id: id(value?.id) || label, label, ...(text(value?.description) ? { description: text(value.description) } : {}) } : null;
}
function question(value, index) {
  const questionText = text(value?.question);
  if (!questionText) return null;
  const options = Array.isArray(value.options) ? value.options.slice(0, MAX_OPTIONS).map(option).filter(Boolean)
    .map(({ label, description }) => ({ label, ...(description ? { description } : {}) })) : [];
  return {
    id: id(value.id) || `question-${index + 1}`,
    header: text(value.header),
    question: questionText,
    options,
    allowFreeText: value.allowFreeText === true || value.isOther === true,
    multiple: value.allowMultiple === true || value.multiple === true,
    isSecret: value.isSecret === true
  };
}

function permissionTemplate(value) {
  // Desktop's native permission response uses only these two top-level keys.
  // Keep a plain JSON subset so prototype keys and executable values never cross
  // the renderer boundary. Nested permission declarations are consumed by the
  // native owner, which already validates their semantic shape.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const key of ['network', 'fileSystem']) {
    const entry = value[key];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) out[key] = JSON.parse(JSON.stringify(entry));
  }
  return out;
}

function detail(label, value) {
  const safe = text(value);
  return safe ? { label, value: safe } : null;
}
function detailText(details) { return details.map(item => `${item.label}: ${item.value}`).join('\n'); }
function sourceItems(state) {
  const result = new Map();
  const addTurn = turn => {
    for (const item of turn?.items || []) {
      const itemId = id(item?.id);
      if (itemId && !result.has(itemId)) result.set(itemId, item);
    }
  };
  for (const turn of state?.turns || []) addTurn(turn);
  const canonical = state?.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  for (const entity of Object.values(canonical?.entitiesByKey || {})) addTurn(entity);
  return result;
}
function commandDetails(params, source) {
  const item = source.get(id(params.itemId));
  const cmd = Array.isArray(item?.cmd) ? item.cmd.filter(value => typeof value === 'string').join(' ') : text(item?.command) || text(params.command);
  const cwd = text(item?.cwd) || text(params.cwd);
  return [detail('命令', cmd), detail('目录', cwd)].filter(Boolean);
}
function fileDetails(params, source) {
  const item = source.get(id(params.itemId));
  const changes = item?.changes && typeof item.changes === 'object' ? item.changes : params.changes;
  const paths = changes && typeof changes === 'object' ? Object.keys(changes).filter(path => text(path)).slice(0, MAX_OPTIONS) : [];
  return paths.map(path => ({ label: '文件', value: path.slice(0, TEXT_LIMIT) }));
}
function permissionDetails(params) {
  const permissions = params.permissions && typeof params.permissions === 'object' ? params.permissions : {};
  const network = permissions.network;
  const fileSystem = permissions.fileSystem;
  const values = [];
  if (network?.enabled === true) values.push({ label: '网络', value: text(network.host) || text(network.url) || '已请求' });
  if (Array.isArray(fileSystem?.paths)) for (const path of fileSystem.paths.slice(0, MAX_OPTIONS)) {
    const safe = text(path); if (safe) values.push({ label: '文件路径', value: safe });
  }
  return values;
}

function projectRequest(value, state) {
  const request = requestIdentity(value?.id);
  if (!request || !value?.params || typeof value.params !== 'object') return null;
  const { id: requestId, nativeRequestId } = request;
  const params = value.params;
  const turnId = id(params.turnId);
  if (value.method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(params.questions) ? params.questions.slice(0, MAX_QUESTIONS).map(question).filter(Boolean) : [];
    if (!questions.length) return null;
    return { id: requestId, nativeRequestId, kind: 'question', nativeKind: 'userInput', presentation: 'native', canRespond: true, title: '需要你的回答', body: questions[0].question,
      status: 'pending', questions, options: [], ...(turnId ? { turnId } : {}) };
  }
  if (value.method === 'item/tool/requestOptionPicker') {
    const options = Array.isArray(params.options) ? params.options.slice(0, MAX_OPTIONS).map(option).filter(Boolean) : [];
    const body = text(params.question);
    if (!body) return null;
    return { id: requestId, nativeRequestId, kind: 'question', nativeKind: 'optionPicker', presentation: 'native', canRespond: false, title: '需要你的选择', body,
      status: 'pending', options, questions: [], allowFreeText: params.showFreeform !== false,
      multiple: params.allowMultiple === true, ...(turnId ? { turnId } : {}) };
  }
  const approval = value.method === 'item/commandExecution/requestApproval' ? 'command'
    : value.method === 'item/fileChange/requestApproval' ? 'file'
      : value.method === 'item/permissions/requestApproval' ? 'permissions' : null;
  if (!approval) return null;
  const options = approval === 'permissions'
    ? ['accept', 'acceptForSession', 'decline']
    : ['accept', 'acceptForSession', 'decline'];
  const source = sourceItems(state);
  const details = approval === 'command' ? commandDetails(params, source) : approval === 'file' ? fileDetails(params, source) : permissionDetails(params);
  const reason = text(params.reason);
  return { id: requestId, nativeRequestId, kind: 'approval', nativeKind: approval, presentation: 'native', canRespond: true, title: approval === 'command' ? '命令执行请求' : approval === 'file' ? '文件修改请求' : '权限请求',
    body: [reason, detailText(details)].filter(Boolean).join('\n') || null, details, status: 'pending', options: options.map(label => ({ id: label, label: ({ accept: '允许一次', acceptForSession: '本次会话允许', decline: '拒绝' })[label] })), questions: [],
    ...(turnId ? { turnId } : {}), ...(approval === 'permissions' ? { permissions: permissionTemplate(params.permissions) } : {}) };
}

function projectInteractions(requests, state) {
  if (!Array.isArray(requests)) return [];
  const seen = new Set();
  const result = [];
  for (const request of requests) {
    const interaction = projectRequest(request, state);
    if (!interaction || seen.has(interaction.id)) continue;
    seen.add(interaction.id); result.push(interaction);
    if (result.length >= MAX_INTERACTIONS) break;
  }
  for (const widget of projectAsyncWidgets(state)) {
    if (!seen.has(widget.id) && result.length < MAX_INTERACTIONS) { seen.add(widget.id); result.push(widget); }
  }
  return result;
}

function projectAsyncWidgets(value) {
  const result = [], seen = new Set(), objects = new Set();
  function walk(current) {
    if (!current || typeof current !== 'object' || objects.has(current) || result.length >= MAX_INTERACTIONS) return;
    objects.add(current);
    const widget = current.client_defined_widget || current;
    const data = widget?.data;
    if (['ask_user_input', 'ask_user_input_v2'].includes(widget?.category) && data && typeof data === 'object') {
      const metadata = data.codex_request_user_input;
      const rawId = metadata?.request_id;
      const displayId = typeof rawId === 'number' || typeof rawId === 'string' ? `async:${typeof rawId}:${rawId}` : null;
      const sourceQuestions = Array.isArray(data.questions) ? data.questions.slice(0, MAX_QUESTIONS) : [];
      const ids = Array.isArray(metadata?.question_ids) ? metadata.question_ids : [];
      const questions = sourceQuestions.map((item, index) => {
        const prompt = text(item?.question); if (!prompt) return null;
        return { id: id(ids[index]) || `question-${index + 1}`, header: null, question: prompt,
          options: Array.isArray(item.options) ? item.options.slice(0, MAX_OPTIONS).map(option => text(option)).filter(Boolean).map(label => ({ label })) : [],
          allowFreeText: true, multiple: item.type === 'multi_select', isSecret: false };
      }).filter(Boolean);
      if (displayId && questions.length && metadata?.status === 'pending' && !seen.has(displayId)) {
        seen.add(displayId); result.push({ id: displayId, kind: 'question', nativeKind: 'asyncWidget', presentation: 'desktop', canRespond: false,
          title: '需要你的回答', body: questions[0].question, status: 'pending', options: [], questions });
      }
    }
    for (const child of Object.values(current)) walk(child);
  }
  walk(value); return result;
}

function findInteraction(interactions, interactionId) {
  const safeId = id(interactionId);
  return safeId ? (interactions || []).find(item => item.id === safeId && item.status === 'pending') || null : null;
}

function stringAnswers(value, validLabels = null) {
  if (!Array.isArray(value) || value.length > MAX_OPTIONS) throw new Error('invalid answer list');
  const out = [];
  for (const item of value) {
    const answer = text(item);
    if (!answer || (validLabels && !validLabels.has(answer)) || out.includes(answer)) throw new Error('invalid answer');
    out.push(answer);
  }
  return out;
}

function nativeResponse(interaction, payload) {
  if (!interaction || typeof payload !== 'object' || !payload) throw new Error('interaction response is required');
  if (interaction.nativeKind === 'userInput') {
    if (!payload.answers || typeof payload.answers !== 'object' || Array.isArray(payload.answers)) throw new Error('answers are required');
    const response = {};
    for (const item of interaction.questions) {
      if (!Object.hasOwn(payload.answers, item.id)) continue;
      const valid = item.allowFreeText ? null : new Set(item.options.map(option => option.label));
      const answers = stringAnswers(payload.answers[item.id], valid?.size ? valid : null);
      if (!item.multiple && answers.length > 1) throw new Error('multiple answers are not allowed');
      if (answers.length) response[item.id] = { answers };
    }
    for (const key of Object.keys(payload.answers)) if (!interaction.questions.some(item => item.id === key)) throw new Error('unknown question id');
    return { method: 'thread-follower-submit-user-input', version: 1, response: { answers: response } };
  }
  if (interaction.canRespond === false || interaction.nativeKind === 'optionPicker') {
    throw new Error('option picker has no follower response method');
  }
  const decision = payload.decision;
  const allowed = interaction.nativeKind === 'command' ? EXEC_DECISIONS
    : interaction.nativeKind === 'file' ? FILE_DECISIONS : PERMISSION_DECISIONS;
  if (!allowed.has(decision)) throw new Error('invalid approval decision');
  if (interaction.nativeKind === 'command') return { method: 'thread-follower-command-approval-decision', version: 1, response: { decision } };
  if (interaction.nativeKind === 'file') return { method: 'thread-follower-file-approval-decision', version: 1, response: { decision } };
  const permissions = decision === 'decline' ? {} : interaction.permissions || {};
  return { method: 'thread-follower-permissions-request-approval-response', version: 1,
    response: { response: { permissions, scope: decision === 'acceptForSession' ? 'session' : 'turn' } } };
}

function latestTurn(state) {
  if (!state || typeof state !== 'object') return null;
  const canonical = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  if (canonical?.entitiesByKey && Array.isArray(canonical.islands)) {
    const lastIsland = canonical.islands.at(-1);
    const key = lastIsland?.entries?.at(-1)?.value;
    const found = key ? canonical.entitiesByKey[key] : null;
    if (found) return found;
  }
  return Array.isArray(state.turns) ? state.turns.at(-1) : null;
}
function projectCompletion(state) {
  const turn = latestTurn(state);
  const turnId = id(turn?.turnId);
  const status = TURN_STATUSES.get(turn?.status);
  return turnId && status ? { turnId, status } : null;
}

function turnSlots(state) {
  const legacy = Array.isArray(state?.turns) ? state.turns.map(turn => ({ turnId: id(turn?.turnId), status: typeof turn?.status === 'string' ? turn.status : null })) : [];
  const canonical = state?.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  const canonicalSlots = [];
  for (const island of canonical?.islands || []) for (const entry of island?.entries || []) {
    const key = id(entry?.value);
    const turn = key ? canonical?.entitiesByKey?.[key] : null;
    canonicalSlots.push({ key, turnId: id(turn?.turnId), status: typeof turn?.status === 'string' ? turn.status : null });
  }
  return { legacy, canonical: canonicalSlots };
}
function completionFromSlots(slots) {
  const selected = slots?.canonical?.length ? slots.canonical.at(-1) : slots?.legacy?.at(-1);
  const status = TURN_STATUSES.get(selected?.status);
  return selected?.turnId && status ? { turnId: selected.turnId, status } : null;
}
function applyCompletionPatch(slots, path, patch) {
  if (!slots || !Array.isArray(path) || typeof patch?.value !== 'string' || path.at(-1) !== 'status') return completionFromSlots(slots);
  if (path.length === 3 && path[0] === 'turns' && /^\d+$/.test(String(path[1]))) {
    const entry = slots.legacy[Number(path[1])]; if (entry) entry.status = patch.value;
  }
  if (path.length === 5 && path[0] === 'turnHistory' && path[1] === 'history' && path[2] === 'entitiesByKey') {
    const entry = slots.canonical.find(item => item.key === String(path[3])); if (entry) entry.status = patch.value;
  }
  return completionFromSlots(slots);
}

module.exports = { projectRequest, projectInteractions, projectAsyncWidgets, findInteraction, nativeResponse, projectCompletion, turnSlots, completionFromSlots, applyCompletionPatch };
