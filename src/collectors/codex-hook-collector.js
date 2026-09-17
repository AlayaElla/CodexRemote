const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const AgentEventCollector = require('./agent-event-collector');

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_APPROVAL_TIMEOUT_MS = 9 * 60 * 1000;
const DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS = 100;
const TRANSCRIPT_READ_CHUNK_BYTES = 256 * 1024;
const MAX_TOOL_DESCRIPTION_LENGTH = 180;

function compactText(value, maxLength = MAX_TOOL_DESCRIPTION_LENGTH) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function getInputValue(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.length > 0) return value.join(', ');
  }
  return '';
}

function describeToolCall(toolName, input) {
  const name = compactText(toolName || 'unknown', 60);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return `调用 ${name}`;
  }

  const explicitDescription = getInputValue(input, ['description', 'justification']);
  if (explicitDescription) return compactText(explicitDescription);

  const normalizedName = name.toLowerCase();
  const command = getInputValue(input, ['command', 'cmd', 'script']);
  if (command) return compactText(`运行命令：${command}`);

  const filePath = getInputValue(input, ['file_path', 'path', 'filename']);
  if (filePath) {
    let action = '访问文件';
    if (/read|view|open/.test(normalizedName)) action = '读取文件';
    else if (/write|edit|patch|update|create/.test(normalizedName)) action = '修改文件';
    else if (/delete|remove/.test(normalizedName)) action = '删除文件';
    return compactText(`${action}：${filePath}`);
  }

  const query = getInputValue(input, ['query', 'pattern', 'search']);
  if (query) return compactText(`搜索：${query}`);

  const url = getInputValue(input, ['url', 'uri']);
  if (url) return compactText(`访问地址：${url}`);

  const patch = getInputValue(input, ['patch']);
  if (patch) {
    const files = [...patch.matchAll(/^(?:\*{3} )?(?:Add|Update|Delete) File:\s*(.+)$/gmi)]
      .map((match) => match[1].trim())
      .filter(Boolean);
    return files.length > 0
      ? compactText(`修改文件：${files.join(', ')}`)
      : '应用代码修改';
  }

  const prompt = getInputValue(input, ['prompt', 'text']);
  if (prompt) return compactText(`处理内容：${prompt}`);

  const freeformInput = getInputValue(input, ['input']);
  if (freeformInput) return compactText(`执行内容：${freeformInput}`);

  const visibleParameters = Object.entries(input)
    .filter(([key]) => !/(?:token|secret|password|api.?key|authorization|cookie)/i.test(key))
    .map(([key, value]) => {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return `${key}=${compactText(value, 60)}`;
      }
      if (Array.isArray(value) && value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
        return `${key}=${compactText(value.join(', '), 60)}`;
      }
      return key;
    })
    .slice(0, 3);
  if (visibleParameters.length > 0) {
    return compactText(`调用 ${name}（${visibleParameters.join('；')}）`);
  }
  return `调用 ${name}`;
}

class CodexHookCollector extends AgentEventCollector {
  constructor(options = {}) {
    super('codex-hooks');
    this.port = Number(options.hookPort || process.env.CODEX_REMOTE_HOOK_PORT || 7777);
    this.approvalMode = ['intercept', 'off'].includes(options.approvalMode)
      ? options.approvalMode
      : 'intercept';
    this.approvalTimeoutMs = Number(options.approvalTimeoutMs || DEFAULT_APPROVAL_TIMEOUT_MS);
    this.transcriptPollIntervalMs = Number(
      options.transcriptPollIntervalMs || DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS
    );
    this.server = null;
    this.pendingApprovals = new Map();
    this.sessionAllowedTools = new Set();
    this.transcriptWatches = new Map();
    this.running = false;
  }

  async start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.removeListener('listening', onListening);
        this.server = null;
        reject(error);
      };
      const onListening = () => {
        this.server.removeListener('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, '127.0.0.1');
    });

    this.running = true;
    console.log(`[Codex] Hook collector listening on 127.0.0.1:${this.port}`);
  }

  isRunning() {
    return this.running;
  }

  handleRequest(req, res) {
    if (req.method === 'GET' && req.url === '/health') {
      return this.sendJson(res, 200, { ok: true, collector: this.type, port: this.port });
    }
    if (req.method !== 'POST' || req.url !== '/events') {
      return this.sendJson(res, 404, { ok: false, error: 'not_found' });
    }

    this.readJson(req).then(async (body) => {
      const eventName = body?.event_name || body?.payload?.hook_event_name;
      const payload = body?.payload;
      if (typeof eventName !== 'string' || !payload || typeof payload !== 'object') {
        return this.sendJson(res, 400, { ok: false, error: 'event_name_and_payload_required' });
      }

      if (eventName === 'PermissionRequest') {
        try {
          await this.observeTranscript(payload);
        } catch (error) {
          console.warn(`[Codex] Failed to read transcript updates: ${error.message}`);
        }
        return this.handleApprovalRequest(req, res, payload);
      }

      const message = this.toAgentMessage(eventName, payload);
      // Do not make the user's own message wait for transcript file I/O. This
      // is the event that should reach the device as soon as Submit is pressed.
      if (eventName === 'UserPromptSubmit' && message) this.emit('message', message);

      try {
        await this.observeTranscript(payload);
      } catch (error) {
        console.warn(`[Codex] Failed to read transcript updates: ${error.message}`);
      }

      if (eventName !== 'UserPromptSubmit' && message) this.emit('message', message);
      if (eventName === 'Stop') this.releaseTranscript(payload.transcript_path);
      this.sendJson(res, 200, { ok: true });
    }).catch((error) => {
      if (!res.headersSent) this.sendJson(res, 400, { ok: false, error: error.message });
    });
  }

  // Lifecycle hooks expose the final assistant text through Stop, but they do
  // not emit assistant commentary. Follow the hook-provided transcript path
  // read-only so progress messages can use the same chat protocol as the final
  // answer. Codex currently writes duplicate event_msg/response_item records;
  // consumeTranscriptLine deduplicates those adjacent copies.
  async observeTranscript(payload) {
    const transcriptPath = typeof payload.transcript_path === 'string'
      ? payload.transcript_path.trim()
      : '';
    if (!transcriptPath) return;

    const existing = this.transcriptWatches.get(transcriptPath);
    if (existing) {
      existing.sessionId = payload.session_id || existing.sessionId;
      existing.turnId = payload.turn_id || existing.turnId;
      await this.drainTranscript(existing);
      return;
    }

    let stats;
    try {
      stats = await fs.promises.stat(transcriptPath);
    } catch {
      return;
    }
    if (!stats.isFile()) return;

    const state = {
      path: transcriptPath,
      offset: stats.size,
      remainder: '',
      decoder: new StringDecoder('utf8'),
      sessionId: payload.session_id || null,
      turnId: payload.turn_id || null,
      lastCandidate: null,
      disposed: false,
      pending: false,
      drainPromise: null,
      listener: null
    };
    state.listener = (current, previous) => {
      if (state.disposed) return;
      if (current.size === previous.size && current.mtimeMs === previous.mtimeMs) return;
      this.drainTranscript(state).catch((error) => {
        console.warn(`[Codex] Failed to read transcript updates: ${error.message}`);
      });
    };
    this.transcriptWatches.set(transcriptPath, state);
    fs.watchFile(transcriptPath, {
      persistent: false,
      interval: this.transcriptPollIntervalMs
    }, state.listener);
  }

  drainTranscript(state) {
    if (!state || state.disposed) return Promise.resolve();
    state.pending = true;
    if (state.drainPromise) return state.drainPromise;

    state.drainPromise = (async () => {
      while (state.pending && !state.disposed) {
        state.pending = false;
        await this.readTranscriptGrowth(state);
      }
    })().finally(() => {
      state.drainPromise = null;
    });
    return state.drainPromise;
  }

  async readTranscriptGrowth(state) {
    let stats;
    try {
      stats = await fs.promises.stat(state.path);
    } catch {
      this.releaseTranscript(state.path);
      return;
    }

    if (stats.size < state.offset) {
      state.offset = 0;
      state.remainder = '';
      state.decoder = new StringDecoder('utf8');
      state.lastCandidate = null;
    }
    if (stats.size === state.offset) return;

    const handle = await fs.promises.open(state.path, 'r');
    try {
      while (!state.disposed && state.offset < stats.size) {
        const length = Math.min(TRANSCRIPT_READ_CHUNK_BYTES, stats.size - state.offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
        if (bytesRead <= 0) break;
        state.offset += bytesRead;
        this.consumeTranscriptText(state, state.decoder.write(buffer.subarray(0, bytesRead)));
      }
    } finally {
      await handle.close();
    }
  }

  consumeTranscriptText(state, text) {
    const lines = `${state.remainder}${text}`.split('\n');
    state.remainder = lines.pop() || '';
    for (const line of lines) {
      this.consumeTranscriptLine(state, line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  }

  consumeTranscriptLine(state, line) {
    if (!line) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }

    const candidate = this.getCommentaryCandidate(record);
    if (!candidate) return;

    const timestampMs = Date.parse(record.timestamp || '');
    const previous = state.lastCandidate;
    if (previous
      && previous.text === candidate.text
      && previous.phase === candidate.phase
      && Number.isFinite(timestampMs)
      && Number.isFinite(previous.timestampMs)
      && Math.abs(timestampMs - previous.timestampMs) <= 100) {
      return;
    }
    state.lastCandidate = { ...candidate, timestampMs };

    this.emit('message', {
      type: 'chat',
      role: 'codex',
      text: candidate.text,
      phase: candidate.phase,
      source: this.type,
      session_id: state.sessionId,
      turn_id: candidate.turnId || state.turnId,
      timestamp: Number.isFinite(timestampMs) ? timestampMs : Date.now()
    });
  }

  getCommentaryCandidate(record) {
    const payload = record && record.payload;
    if (!payload || typeof payload !== 'object') return null;

    if (record.type === 'event_msg'
      && payload.type === 'agent_message'
      && payload.phase === 'commentary'
      && typeof payload.message === 'string'
      && payload.message.trim()) {
      return { text: payload.message, phase: 'commentary', turnId: null };
    }

    if (record.type !== 'response_item'
      || payload.type !== 'message'
      || payload.role !== 'assistant'
      || payload.phase !== 'commentary'
      || !Array.isArray(payload.content)) {
      return null;
    }
    const text = payload.content
      .filter((part) => part && part.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    if (!text.trim()) return null;
    return {
      text,
      phase: 'commentary',
      turnId: payload.internal_chat_message_metadata_passthrough?.turn_id || null
    };
  }

  releaseTranscript(transcriptPath) {
    if (typeof transcriptPath !== 'string' || !transcriptPath) return;
    const state = this.transcriptWatches.get(transcriptPath);
    if (!state) return;
    state.disposed = true;
    fs.unwatchFile(transcriptPath, state.listener);
    this.transcriptWatches.delete(transcriptPath);
  }

  handleApprovalRequest(req, res, payload) {
    if (this.approvalMode === 'off') {
      return this.sendJson(res, 200, { ok: true, hook_output: {} });
    }
    const approvalKey = this.approvalKey(payload);
    if (this.sessionAllowedTools.has(approvalKey)) {
      return this.sendJson(res, 200, {
        ok: true,
        hook_output: this.buildHookOutput('allow')
      });
    }
    return this.holdApprovalRequest(req, res, payload);
  }

  approvalKey(payload) {
    return String(payload.tool_name || 'unknown');
  }

  buildApprovalMessage(payload, blocking = true) {
    const toolInput = payload.tool_input ?? null;
    const description = toolInput && typeof toolInput === 'object'
      ? toolInput.description || toolInput.justification
      : null;
    const toolName = payload.tool_name || 'unknown';
    const question = typeof description === 'string' && description.trim()
      ? description.trim()
      : `是否允许 Codex 调用 ${toolName}？`;
    return {
      type: 'approval_request',
      id: blocking ? crypto.randomUUID() : null,
      blocking,
      question,
      tool_name: toolName,
      input: toolInput,
      options: blocking ? [
        { id: 'allow', label: '允许本次' },
        { id: 'allow_session', label: '本次运行始终允许此工具' },
        { id: 'deny', label: '拒绝' }
      ] : [],
      source: this.type,
      session_id: payload.session_id || null,
      turn_id: payload.turn_id || null,
      timestamp: Date.now()
    };
  }

  toAgentMessage(eventName, payload) {
    const common = {
      source: this.type,
      session_id: payload.session_id || null,
      turn_id: payload.turn_id || null,
      timestamp: Date.now()
    };

    switch (eventName) {
      case 'UserPromptSubmit':
        return {
          ...common,
          type: 'chat',
          role: 'user',
          text: typeof payload.prompt === 'string' ? payload.prompt : ''
        };

      case 'PreToolUse':
        return {
          ...common,
          type: 'tool_call',
          status: 'started',
          id: payload.tool_use_id || null,
          tool_name: payload.tool_name || 'unknown',
          description: describeToolCall(payload.tool_name, payload.tool_input),
          input: payload.tool_input ?? null
        };

      case 'PostToolUse':
        return {
          ...common,
          type: 'tool_result',
          status: 'completed',
          id: payload.tool_use_id || null,
          tool_name: payload.tool_name || 'unknown',
          description: describeToolCall(payload.tool_name, payload.tool_input),
          input: payload.tool_input ?? null,
          output: payload.tool_response ?? null
        };

      case 'Stop':
        return {
          ...common,
          type: 'stop',
          role: 'codex',
          text: typeof payload.last_assistant_message === 'string'
            ? payload.last_assistant_message
            : '',
          stop_hook_active: Boolean(payload.stop_hook_active)
        };

      default:
        return null;
    }
  }

  holdApprovalRequest(req, res, payload) {
    const message = this.buildApprovalMessage(payload, true);
    const { id } = message;

    const timer = setTimeout(() => {
      this.finishApproval(id, null, 'approval_timeout');
    }, this.approvalTimeoutMs);

    this.pendingApprovals.set(id, {
      req,
      res,
      timer,
      approvalKey: this.approvalKey(payload)
    });
    req.once('aborted', () => this.discardApproval(id));
    res.once('close', () => {
      if (!res.writableEnded) this.discardApproval(id);
    });

    this.emit('message', message);
  }

  resolveApproval(id, decision) {
    if (!['allow', 'allow_session', 'deny'].includes(decision)) return false;
    const pending = this.pendingApprovals.get(String(id));
    const delivered = this.finishApproval(id, decision === 'allow_session' ? 'allow' : decision, null);
    if (decision === 'allow_session' && pending && delivered) {
      this.sessionAllowedTools.add(pending.approvalKey);
    }
    return delivered;
  }

  buildHookOutput(decision) {
    if (decision === 'allow') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' }
        }
      };
    }
    if (decision === 'deny') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'Denied from Codex Remote' }
        }
      };
    }
    return {};
  }

  finishApproval(id, decision, fallbackReason) {
    const pending = this.pendingApprovals.get(String(id));
    if (!pending) return false;
    this.pendingApprovals.delete(String(id));
    clearTimeout(pending.timer);

    const hookOutput = this.buildHookOutput(decision);

    const delivered = !pending.res.headersSent && !pending.res.destroyed && !pending.res.writableEnded;
    if (delivered) {
      this.sendJson(pending.res, 200, {
        ok: true,
        hook_output: hookOutput,
        fallback_reason: fallbackReason || null
      });
    }
    this.emit('message', { type: 'approval_resolved', id: String(id), decision: delivered ? decision || null : null,
      reason: delivered ? fallbackReason || null : 'disconnected' });
    return delivered;
  }

  discardApproval(id) {
    const pending = this.pendingApprovals.get(String(id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(String(id));
    this.emit('message', { type: 'approval_resolved', id: String(id), decision: null, reason: 'disconnected' });
  }

  readJson(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      let rejected = false;
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        if (rejected) return;
        body += chunk;
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
          rejected = true;
          reject(new Error('request_too_large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (rejected) return;
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error('invalid_json'));
        }
      });
      req.on('error', reject);
    });
  }

  sendJson(res, status, payload) {
    if (res.headersSent || res.destroyed) return;
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text)
    });
    res.end(text);
  }

  async stop() {
    for (const id of [...this.pendingApprovals.keys()]) {
      this.finishApproval(id, null, 'collector_stopped');
    }
    for (const transcriptPath of [...this.transcriptWatches.keys()]) {
      this.releaseTranscript(transcriptPath);
    }

    const server = this.server;
    this.server = null;
    this.running = false;
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = CodexHookCollector;
module.exports.describeToolCall = describeToolCall;
