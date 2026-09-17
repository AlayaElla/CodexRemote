const { spawn } = require('node:child_process');

// Persistent Win32 keyboard worker. Requests are never automatically replayed.
class CodexKeyboardWorker {
  constructor(scriptPath, options = {}) {
    this.scriptPath = scriptPath;
    this.spawn = options.spawn || spawn;
    this.timeoutMs = options.timeoutMs || 10000;
    this.runtime = null;
    this.nextId = 0;
    this.disposed = false;
  }

  warmup() {
    if (this.disposed) return Promise.reject(new Error('Keyboard helper is closed.'));
    if (this.runtime) return this.runtime.ready;
    const runtime = { pending: new Map(), buffer: '', child: null };
    runtime.ready = new Promise((resolve, reject) => { runtime.resolve = resolve; runtime.reject = reject; });
    this.runtime = runtime;
    runtime.timer = setTimeout(() => this.fail(runtime, new Error('Keyboard helper startup timed out.')), this.timeoutMs);
    runtime.timer.unref?.();
    try {
      const child = runtime.child = this.spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', this.scriptPath, '-Server'
      ], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      child.once('error', error => this.fail(runtime, error));
      child.once('exit', () => this.fail(runtime, new Error('Keyboard helper exited.')));
      child.stdin.on('error', error => this.fail(runtime, error));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => this.receive(runtime, chunk));
      child.stderr.on('data', () => {});
    } catch (error) { this.fail(runtime, error); }
    return runtime.ready;
  }

  receive(runtime, chunk) {
    if (this.runtime !== runtime) return;
    runtime.buffer += chunk;
    if (Buffer.byteLength(runtime.buffer) > 65536) return this.fail(runtime, new Error('Keyboard helper output is too large.'));
    let end;
    while ((end = runtime.buffer.indexOf('\n')) >= 0) {
      const line = runtime.buffer.slice(0, end).trim();
      runtime.buffer = runtime.buffer.slice(end + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); }
      catch (_) { return this.fail(runtime, new Error('Invalid keyboard helper response.')); }
      if (response.ready === true) {
        clearTimeout(runtime.timer);
        runtime.resolve();
      } else {
        const pending = runtime.pending.get(response.id);
        if (!pending) continue;
        runtime.pending.delete(response.id);
        clearTimeout(pending.timer);
        pending.resolve(response.result);
      }
    }
  }

  async run(action, context = {}) {
    if (!['EscapeCancel', 'EscapeStop', 'ReadTaskLink', 'PasteText'].includes(action)) throw new Error('Unsupported keyboard action.');
    const data = action === 'ReadTaskLink' ? { candidates: context.candidates }
      : action === 'PasteText' ? { text: context.text, taskId: context.taskId, draftToken: context.draftToken } : {};
    const target = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
    return this.request({ action, target });
  }

  async request(payload) {
    if (!payload.target || payload.target.length > 262144) throw new Error('Target request is too large or missing.');
    const ready = this.warmup();
    const runtime = this.runtime;
    await ready;
    if (!runtime || this.runtime !== runtime || this.disposed) throw new Error('Keyboard helper is unavailable.');
    if (runtime.pending.size >= 16) throw new Error('Keyboard helper queue is full.');
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(runtime, new Error('Keyboard operation timed out.')), this.timeoutMs);
      runtime.pending.set(id, { resolve, reject, timer });
      try { runtime.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`); }
      catch (error) { this.fail(runtime, error); }
    });
  }

  fail(runtime, error) {
    if (this.runtime !== runtime) return;
    this.runtime = null;
    clearTimeout(runtime.timer);
    runtime.reject(error);
    for (const pending of runtime.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    runtime.pending.clear();
    if (runtime.child && !runtime.child.killed) { try { runtime.child.kill(); } catch (_) {} }
  }

  dispose() {
    this.disposed = true;
    if (this.runtime) this.fail(this.runtime, new Error('Keyboard helper is closed.'));
  }
}
module.exports = CodexKeyboardWorker;
