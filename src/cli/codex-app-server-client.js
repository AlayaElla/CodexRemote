'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

function parseArgs(value) {
  if (!value) return ['app-server'];
  return String(value).trim().split(/\s+/).filter(Boolean);
}

class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.command || process.env.CODEX_COMMAND || 'codex';
    this.args = options.args || parseArgs(process.env.CODEX_APP_SERVER_ARGS);
    this.cwd = options.cwd || process.cwd();
    this.child = null;
    this.buffer = '';
    this.nextId = 0;
    this.pending = new Map();
    this.threadId = null;
    this.started = false;
    this.closed = false;
  }

  start() {
    if (this.child) return Promise.resolve();
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this._onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => this.emit('stderr', chunk));
    this.child.on('error', error => this._fail(error));
    this.child.on('exit', (code, signal) => {
      if (!this.closed && code !== 0) this._fail(new Error(`Codex app-server exited (${code ?? signal}).`));
      this.child = null;
    });
    return new Promise((resolve, reject) => {
      const onError = error => { cleanup(); reject(error); };
      const onReady = () => { cleanup(); resolve(); };
      const cleanup = () => { this.removeListener('error', onError); this.removeListener('ready', onReady); };
      this.once('error', onError);
      this.once('ready', onReady);
      this._request('initialize', {
        clientInfo: { name: 'codex-remote-voice', title: 'Codex Remote Voice', version: '0.2.3' },
        capabilities: { experimentalApi: false }
      }).then(() => {
        this._notify('initialized', {});
        this.emit('ready');
      }).catch(onError);
    });
  }

  async ensureThread() {
    if (!this.child) await this.start();
    if (this.threadId) return this.threadId;
    const result = await this._request('thread/start', {
      cwd: this.cwd,
      approvalPolicy: 'never',
      sandbox: 'workspace-write'
    });
    const thread = result?.thread;
    if (!thread?.id) throw new Error('Codex app-server did not return a thread id.');
    this.threadId = thread.id;
    this.emit('thread', this.threadId);
    return this.threadId;
  }

  async sendText(text) {
    const value = String(text || '').trim();
    if (!value) return null;
    const threadId = await this.ensureThread();
    const result = await this._request('turn/start', {
      threadId,
      clientUserMessageId: `voice-${Date.now()}-${++this.nextId}`,
      input: [{ type: 'text', text: value, textElements: [] }],
      turnTrigger: 'voice'
    });
    const turnId = result?.turn?.id;
    if (!turnId) throw new Error('Codex app-server did not return a turn id.');
    return new Promise((resolve, reject) => {
      const onCompleted = event => {
        if (event?.threadId !== threadId || event?.turn?.id !== turnId) return;
        cleanup();
        if (event.turn?.status === 'failed') reject(new Error(event.turn.error?.message || 'Codex turn failed.'));
        else resolve(event.turn || event);
      };
      const onError = error => { cleanup(); reject(error); };
      const cleanup = () => {
        this.removeListener('turn-completed', onCompleted);
        this.removeListener('error', onError);
      };
      this.on('turn-completed', onCompleted);
      this.on('error', onError);
    });
  }

  close() {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error('Codex app-server closed.'));
    this.pending.clear();
    if (this.child) this.child.kill('SIGTERM');
    this.child = null;
  }

  _request(method, params) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error('Codex app-server is not running.'));
    const id = ++this.nextId;
    this._write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  _notify(method, params) { this._write({ jsonrpc: '2.0', method, params }); }

  _write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      this._handle(message);
    }
  }

  _handle(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex app-server request failed.'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      const delta = message.params?.delta || '';
      if (delta) { process.stdout.write(delta); this.emit('delta', delta); }
    } else if (message.method === 'turn/completed') {
      process.stdout.write('\n');
      this.emit('turn-completed', message.params);
    } else if (message.method?.includes('requestApproval')) {
      this.emit('approval-request', message);
    } else {
      this.emit('notification', message);
    }
  }

  _fail(error) {
    if (this.closed) return;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit('error', error);
  }
}

module.exports = CodexAppServerClient;
module.exports.parseArgs = parseArgs;
