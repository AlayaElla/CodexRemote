const { spawn: spawnNative } = require('node:child_process');
const path = require('node:path');

const TASK_SOURCES = new Set(['recent', 'pinned', 'priority']);
const SLOT_COUNT = 6;
const MAX_ROWS = 256;
const MAX_TITLE_LENGTH = 160;
const MAX_OUTPUT_BYTES = 256 * 1024;
const HELPER_TIMEOUT_MS = 10_000;

const CODEX_HOME = () => path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');

function unpackedScriptPath(scriptPath) {
  return scriptPath.replace(/([\\/])app\.asar([\\/])/i, '$1app.asar.unpacked$2');
}

function unsupported(message) {
  const error = new Error(message);
  error.code = 'CODEX_TASK_LIST_UNSUPPORTED';
  return error;
}

function isSafeString(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
}

function normalizeRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isSafeString(value.id, 128)) return null;
  if (value.title !== null && value.title !== undefined && (typeof value.title !== 'string' || value.title.length > MAX_TITLE_LENGTH)) return null;
  if (!Number.isSafeInteger(value.recency_at_ms) || value.recency_at_ms < 0) return null;
  if (value.updated_at_ms != null && (!Number.isSafeInteger(value.updated_at_ms) || value.updated_at_ms < 0)) return null;
  if (![0, 1].includes(value.is_pinned) || ![0, 1].includes(value.archived)) return null;
  if (value.position !== null && value.position !== undefined && !Number.isSafeInteger(value.position)) return null;
  if (value.projectId !== null && value.projectId !== undefined && (typeof value.projectId !== 'string' || value.projectId.length > 128)) return null;
  return {
    id: value.id,
    title: typeof value.title === 'string' ? value.title : null,
    recencyAt: value.recency_at_ms,
    updatedAt: value.updated_at_ms ?? value.recency_at_ms,
    pinned: value.is_pinned === 1,
    archived: value.archived === 1,
    position: Number.isSafeInteger(value.position) ? value.position : null,
    projectId: typeof value.projectId === 'string' && value.projectId ? value.projectId : null
  };
}

function hintsToMap(value) {
  if (value instanceof Map) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return new Map(Object.entries(value));
  return new Map();
}

function taskState(row, hints) {
  const hint = hints.get(row.threadId || row.id);
  if (!hint || typeof hint !== 'object') return 'idle';
  const state = typeof hint.state === 'string' ? hint.state : typeof hint.runtimeState === 'string' ? hint.runtimeState : typeof hint.status === 'string' ? hint.status : '';
  if (state === 'waiting' || state === 'waitingOnApproval' || state === 'waitingOnUserInput') return 'waiting';
  if (hint.unread === true || hint.hasUnreadTurn === true) return 'unread';
  if (state === 'active' || state === 'working' || state === 'running') return 'working';
  return 'idle';
}

function priorityRank(state) {
  return ({ waiting: 0, unread: 1, working: 2, idle: 3 })[state] ?? 3;
}

function taskComparator(source) {
  if (source === 'pinned') {
    return (left, right) => (left.pinnedPosition ?? Number.MAX_SAFE_INTEGER) - (right.pinnedPosition ?? Number.MAX_SAFE_INTEGER)
      || right.recencyAt - left.recencyAt
      || left.threadId.localeCompare(right.threadId);
  }
  if (source === 'priority') {
    return (left, right) => priorityRank(left.state) - priorityRank(right.state)
      || right.recencyAt - left.recencyAt
      || left.threadId.localeCompare(right.threadId);
  }
  return (left, right) => right.updatedAt - left.updatedAt || left.threadId.localeCompare(right.threadId);
}

function rowsToTasks(rows) {
  return rows.map(normalizeRow).filter(Boolean).filter(row => !row.archived).map(row => ({
    threadId: row.id,
    title: row.title,
    recencyAt: row.recencyAt,
    updatedAt: row.updatedAt,
    pinned: row.pinned,
    pinnedPosition: row.position,
    projectId: row.projectId
  }));
}

function normalizeTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isSafeString(value.threadId, 128) || !Number.isSafeInteger(value.recencyAt) || value.recencyAt < 0) return null;
  if (value.updatedAt != null && (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0)) return null;
  if (value.title !== null && value.title !== undefined && (typeof value.title !== 'string' || value.title.length > MAX_TITLE_LENGTH)) return null;
  if (typeof value.pinned !== 'boolean') return null;
  if (value.pinnedPosition !== null && value.pinnedPosition !== undefined && !Number.isSafeInteger(value.pinnedPosition)) return null;
  if (value.projectId !== null && value.projectId !== undefined && (typeof value.projectId !== 'string' || value.projectId.length > 128)) return null;
  return {
    threadId: value.threadId,
    title: typeof value.title === 'string' ? value.title : null,
    recencyAt: value.recencyAt,
    updatedAt: value.updatedAt ?? value.recencyAt,
    pinned: value.pinned,
    pinnedPosition: Number.isSafeInteger(value.pinnedPosition) ? value.pinnedPosition : null,
    projectId: typeof value.projectId === 'string' && value.projectId ? value.projectId : null
  };
}

function selectAutomaticTasks(source, tasks, runtimeHints) {
  if (!TASK_SOURCES.has(source)) throw new Error('unsupported Codex task-list source');
  const hints = hintsToMap(runtimeHints);
  return tasks.map(normalizeTask).filter(Boolean)
    .filter(task => source !== 'pinned' || task.pinned)
    .map(task => ({ ...task, state: taskState(task, hints) }))
    .sort(taskComparator(source))
    .slice(0, SLOT_COUNT);
}

function selectTaskSlots(source, tasks, runtimeHints) {
  return selectAutomaticTasks(source, tasks, runtimeHints).map((task, slot) => ({
    slot,
    threadId: task.threadId,
    title: task.title,
    state: task.state,
    recencyAt: task.recencyAt,
    updatedAt: task.updatedAt,
    pinned: task.pinned,
    pinnedPosition: task.pinnedPosition,
    projectId: task.projectId
  }));
}

function selectTasks(rows, { source = 'recent', runtimeHints } = {}) {
  return selectTaskSlots(source, rowsToTasks(rows), runtimeHints);
}

class CodexTaskList {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.codexHome = options.codexHome || CODEX_HOME();
    this.spawn = options.spawn || spawnNative;
    this.scriptPath = options.scriptPath || path.join(__dirname, '..', 'platform', 'codex-task-list.ps1');
    this.timers = options.timers || global;
    this.timeoutMs = options.timeoutMs || HELPER_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes || MAX_OUTPUT_BYTES;
  }

  async read() {
    if (this.platform !== 'win32') throw unsupported('Codex task-list reading is only supported on Windows.');
    const response = await this._run();
    if (!response || response.schemaVersion !== 1 || !Array.isArray(response.rows) || response.rows.length > MAX_ROWS) {
      throw new Error('Codex task-list helper returned an invalid response.');
    }
    return {
      type: 'codex_task_list',
      version: 1,
      mapping: 'semantic-local',
      nativeMicroMapping: false,
      tasks: rowsToTasks(response.rows)
    };
  }

  _run() {
    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let timer = null;
      let stdout = '';
      let stderr = '';
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) this.timers.clearTimeout(timer);
        callback(value);
      };
      const append = (current, chunk) => {
        const next = current + String(chunk);
        if (Buffer.byteLength(next, 'utf8') > this.maxOutputBytes) {
          child.kill?.();
          finish(reject, new Error('Codex task-list helper returned excessive output.'));
          return null;
        }
        return next;
      };
      try {
        child = this.spawn('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', unpackedScriptPath(this.scriptPath), '-CodexHome', this.codexHome
        ], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { finish(reject, error); return; }
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', chunk => { const next = append(stdout, chunk); if (next !== null) stdout = next; });
      child.stderr?.on('data', chunk => { const next = append(stderr, chunk); if (next !== null) stderr = next; });
      child.once('error', error => finish(reject, error));
      child.once('close', code => {
        let response;
        try { response = JSON.parse(stdout.trim()); } catch (_) {
          finish(reject, new Error(code === 0 ? 'Codex task-list helper returned invalid JSON.' : (stderr.trim() || 'Codex task-list helper failed.')));
          return;
        }
        if (code !== 0) {
          finish(reject, new Error(typeof response?.error === 'string' ? response.error : 'Codex task-list helper failed.'));
          return;
        }
        finish(resolve, response);
      });
      timer = this.timers.setTimeout(() => {
        child.kill?.();
        finish(reject, new Error('Codex task-list helper timed out.'));
      }, this.timeoutMs);
    });
  }
}

module.exports = {
  CodexTaskList,
  TASK_SOURCES,
  normalizeRow,
  selectAutomaticTasks,
  selectTaskSlots,
  selectTasks,
  taskState,
  unpackedScriptPath
};
