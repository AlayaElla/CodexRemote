const fsNative = require('node:fs');
const path = require('node:path');

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_OPTIONS = 16;
// Keep original question text and identity for the native IPC reply; only the
// device projection may truncate display text. observe() bounds the file size.
function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function questionItemId(callId, index) { return JSON.stringify(['request_user_input_async', callId, index]); }
function safeRolloutPath(value, threadId, home = process.env.USERPROFILE || process.env.HOME || '') {
  if (typeof value !== 'string' || typeof threadId !== 'string' || !threadId) return null;
  const root = path.resolve(home, '.codex', 'sessions');
  const candidate = path.resolve(value);
  if (!candidate.startsWith(root + path.sep) || !candidate.endsWith(`-${threadId}.jsonl`)) return null;
  return candidate;
}
function responseAnswers(payload) {
  if (payload?.type !== 'message' || payload?.role !== 'user') return [];
  const result = [];
  for (const item of payload.content || []) {
    const content = text(item?.text); if (!content || !content.includes('<send_user_message_question_reply>')) continue;
    const match = content.match(/<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/);
    if (!match) continue;
    try { for (const answer of JSON.parse(match[1])) if (text(answer?.questionItemId) && typeof answer.answer === 'string') result.push(answer); } catch (_) { /* malformed prior message cannot resolve a request */ }
  }
  return result;
}
function scanRollout(textValue, threadId) {
  const calls = new Map(), answered = new Set(), answerValues = new Map(), accepted = new Set();
  let currentTurnId = null, currentTurnStatus = null;
  for (const line of String(textValue || '').split(/\r?\n/)) {
    if (!line) continue;
    let event; try { event = JSON.parse(line); } catch (_) { continue; }
    for (const answer of responseAnswers(event.payload)) { answered.add(answer.questionItemId); answerValues.set(answer.questionItemId, answer.answer); }
    const payload = event.payload;
    if (event.type === 'event_msg' && payload?.type === 'task_started' && text(payload.turn_id)) {
      currentTurnId = payload.turn_id; currentTurnStatus = 'inProgress';
    } else if (event.type === 'turn_context' && text(payload?.turn_id) && payload.turn_id !== currentTurnId) {
      currentTurnId = payload.turn_id; currentTurnStatus = 'inProgress';
    } else if (event.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(payload?.type)
      && (!payload.turn_id || payload.turn_id === currentTurnId)) {
      currentTurnStatus = 'completed';
    }
    if (payload?.type === 'function_call_output' && typeof payload.call_id === 'string') {
      try { if (JSON.parse(payload.output)?.accepted === true) accepted.add(payload.call_id); } catch (_) { /* only accepted tool requests become pending UI questions */ }
    }
    if (payload?.type !== 'function_call' || payload?.name !== 'request_user_input_async') continue;
    let input = payload.arguments;
    if (typeof input === 'string') try { input = JSON.parse(input); } catch (_) { continue; }
    if (!input || typeof input !== 'object' || typeof payload.call_id !== 'string') continue;
    const questions = Array.isArray(input.questions) ? input.questions : [];
    questions.forEach((source, index) => {
      const question = text(source?.title || source?.question);
      const options = Array.isArray(source?.options) ? source.options.map(text) : [];
      if (!question || options.some(option => !option) || new Set(options).size !== options.length) return;
      const itemId = questionItemId(payload.call_id, index);
      const withinUiLimits = options.length <= MAX_OPTIONS;
      calls.set(itemId, { id: `async-tool:${payload.call_id}:${index}`, callId: payload.call_id, sourceQuestionId: itemId, sourceTurnId: currentTurnId, threadId,
        kind: 'question', nativeKind: 'asyncTool', presentation: 'desktop', canRespond: withinUiLimits, title: '需要你的回答', body: question,
        status: withinUiLimits ? 'pending' : 'error', options: [], error: withinUiLimits ? undefined : '问题选项超过设备可安全匹配的上限。',
        // Each interaction represents one native question, so q0 is the
        // compact device-facing id.  sourceQuestionId above remains the
        // original opaque JSONL key used for submission confirmation.
        questions: [{ id: 'q0', header: null, question, options: options.map(label => ({ label })), allowFreeText: true, multiple: false, isSecret: false }] });
    });
  }
  return { pending: [...calls.entries()].filter(([id, value]) => accepted.has(value.callId) && !answered.has(id)).map(([, value]) => value), answered, answerValues, currentTurnId, currentTurnStatus };
}
function parseRollout(textValue, threadId) { return scanRollout(textValue, threadId).pending; }
class CodexAsyncQuestions {
  constructor(options = {}) { this.fs = options.fs || fsNative; this.home = options.home || process.env.USERPROFILE || process.env.HOME || ''; this.maxFileBytes = options.maxFileBytes || MAX_FILE_BYTES; this.cache = new Map(); }
  observe({ threadId, rolloutPath }) {
    const file = safeRolloutPath(rolloutPath, threadId, this.home);
    if (!file) return { ok: false, pending: [], answered: new Set() };
    let stat, value; try { stat = this.fs.statSync(file); if (!stat.isFile() || stat.size > this.maxFileBytes) return { ok: false, pending: [], answered: new Set() }; const cached = this.cache.get(file); if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value; value = this.fs.readFileSync(file, 'utf8'); } catch (_) { return { ok: false, pending: [], answered: new Set() }; }
    const observed = { ok: true, ...scanRollout(value, threadId) }; this.cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value: observed }); return observed;
  }
  pending(input) { return this.observe(input).pending; }
  answerStatus({ threadId, rolloutPath, sourceQuestionId, expectedAnswer }) {
    const value = this.observe({ threadId, rolloutPath });
    return { ok: value.ok, answered: value.ok && value.answered.has(sourceQuestionId)
      && (expectedAnswer === undefined || value.answerValues.get(sourceQuestionId) === expectedAnswer) };
  }
}
module.exports = CodexAsyncQuestions;
module.exports.parseRollout = parseRollout;
module.exports.scanRollout = scanRollout;
module.exports.questionItemId = questionItemId;
module.exports.safeRolloutPath = safeRolloutPath;
