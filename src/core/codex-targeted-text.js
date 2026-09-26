const REQUEST_ID = /^[\w.:-]{1,128}$/;
const THREAD_ID = /^[\w-]{1,128}$/;

function textError(message, requestId = '') {
  return { type: 'codex_text_result', request_id: requestId, success: false, error: message };
}

function validateTargetedText(message) {
  const requestId = message?.request_id || message?.requestId;
  if (!message || message.type !== 'text_input' || typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
    throw new Error('无效的文字发送请求编号。');
  }
  if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 32768) {
    throw new Error('文字为空或超过发送上限。');
  }
  if (message.host_id !== 'local' || !REQUEST_ID.test(message.stream_id || '')) {
    throw new Error('文字发送缺少当前连接身份。');
  }
  const hasThread = typeof message.thread_id === 'string' && message.thread_id.length > 0;
  const hasDraft = typeof message.draft_id === 'string' && message.draft_id.length > 0;
  if (hasThread === hasDraft) throw new Error('请明确选择一个任务或新任务草稿。');
  if (hasThread && !THREAD_ID.test(message.thread_id)) throw new Error('无效的目标任务身份。');
  if (hasDraft && !REQUEST_ID.test(message.draft_id)) throw new Error('无效的新任务草稿身份。');
  return {
    type: 'text_input', request_id: requestId, text: message.text,
    host_id: 'local', stream_id: message.stream_id,
    ...(hasThread ? { thread_id: message.thread_id } : { draft_id: message.draft_id })
  };
}

function targetFields(message) {
  return { request_id: message.request_id, host_id: message.host_id, stream_id: message.stream_id,
    ...(message.thread_id ? { thread_id: message.thread_id } : { draft_id: message.draft_id }) };
}

class TargetedTextRequests {
  constructor({ maxRequests = 256 } = {}) { this.requests = new Map(); this.maxRequests = maxRequests; }

  handle(message, submit) {
    let request;
    try { request = validateTargetedText(message); }
    catch (error) { return Promise.resolve(textError(error.message, String(message?.request_id || message?.requestId || '').slice(0, 128))); }
    const signature = JSON.stringify(request);
    const previous = this.requests.get(request.request_id);
    if (previous) {
      if (previous.signature === signature) return previous.promise;
      return Promise.resolve({ ...textError('请求编号已用于其他文字发送。', request.request_id), ...targetFields(request) });
    }
    // Never evict an in-flight request: a retry must not send a second message.
    while (this.requests.size >= this.maxRequests) {
      const completed = [...this.requests].find(([, entry]) => entry.settled);
      if (!completed) return Promise.resolve({ ...textError('文字发送队列已满，请稍后重试。', request.request_id), ...targetFields(request) });
      this.requests.delete(completed[0]);
    }
    const entry = { signature, promise: null, settled: false };
    const promise = Promise.resolve().then(() => submit(request)).then(result => ({
      type: 'codex_text_result', ...targetFields(request), success: Boolean(result?.success),
      delivery: result?.delivery, outcome: result?.outcome, submissionConfirmed: Boolean(result?.submissionConfirmed),
      error: result?.error || null
    })).catch(error => ({ ...textError(error.message, request.request_id), ...targetFields(request) }))
      .finally(() => { entry.settled = true; });
    entry.promise = promise;
    this.requests.set(request.request_id, entry);
    return promise;
  }
}

module.exports = { TargetedTextRequests, validateTargetedText };
