'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const http = require('node:http');
const { findCodexProcess, connectInspector } = require('../core/codex-micro-slots');
const { readCodexRuntime } = require('./codex-runtime-info');
const { CodexRendererConnection, rendererEndpoints } = require('./codex-renderer-connection');

function listeners() {
  const script = '$rows = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 9229 } | Select-Object LocalAddress,OwningProcess); ConvertTo-Json -InputObject $rows -Compress';
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, encoding: 'utf8', timeout: 8000 }, (error, stdout) => {
      if (error) return reject(new Error('无法检查调试端口占用情况。'));
      try { const rows = stdout.trim() ? JSON.parse(stdout) : []; resolve(Array.isArray(rows) ? rows : [rows]); }
      catch (error) { reject(error); }
    }));
}

function probeInspector() {
  return new Promise(resolve => {
    const request = http.get('http://127.0.0.1:9229/json/list', { timeout: 1000 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 16384) request.destroy(); });
      response.on('error', () => resolve(false));
      response.on('end', () => {
        try { resolve(JSON.parse(body).some(target => target.type === 'node' && /^ws:\/\/127\.0\.0\.1:9229\/[\w-]+$/.test(target.webSocketDebuggerUrl))); }
        catch { resolve(false); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

// One lifecycle owner initializes and monitors the Windows inspector.
class CodexDebugActivation {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.findProcess = options.findProcess || findCodexProcess;
    this.readRuntime = options.readRuntime || readCodexRuntime;
    this.rendererFactory = options.rendererFactory || (() => new CodexRendererConnection());
    this.rendererEndpoints = options.rendererEndpoints || rendererEndpoints;
    this.renderer = null;
    this.openingRenderer = null;
    this.rendererAttempt = null;
    this.listeners = options.listeners || listeners;
    this.connect = options.connectInspector || connectInspector;
    this.activate = options.activate || (pid => process._debugProcess(pid));
    this.isAlive = options.isAlive || (pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    this.delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.onProgress = options.onProgress || (() => {});
    this.statusFile = options.statusFile;
    this.attempted = new Set();
    this.failures = new Map();
    this.pending = null;
    this.probe = options.probe || probeInspector;
    this.timers = options.timers || global;
    this.intervalMs = options.intervalMs || 5000;
    this.running = false;
    this.generation = 0;
    this.timer = null;
    this.connected = null;
    this.state = { stage: 'waiting', message: '等待 Codex 启动' };
  }
  progress(stage, message) {
    if (this.state.stage === stage && this.state.message === message) return;
    const status = { stage, message, time: new Date().toISOString() };
    this.state = status;
    if (this.statusFile) {
      fs.mkdirSync(path.dirname(this.statusFile), { recursive: true });
      fs.writeFileSync(this.statusFile, JSON.stringify(status));
    }
    this.onProgress(status);
  }
  validateListeners(rows, target) {
    if (rows.some(row => row.OwningProcess !== target.pid || row.LocalAddress !== '127.0.0.1')) {
      throw new Error('9229 端口被其他进程占用，或监听地址不符合要求。');
    }
  }
  async verify(target) {
    const rows = await this.listeners();
    this.validateListeners(rows, target);
    if (!rows.length) throw new Error('调试端口尚未就绪。');
    const inspector = await this.connect();
    try {
      const identity = await inspector.evaluate('({pid:process.pid,executable:process.execPath})');
      if (identity?.pid !== target.pid || identity.executable?.toLowerCase() !== target.executable.toLowerCase()) {
        throw new Error('调试连接的 Codex 进程身份不匹配。');
      }
    } finally { inspector.close(); }
  }
  start() {
    if (this.running || this.platform !== 'win32') return;
    this.running = true;
    const generation = ++this.generation;
    const tick = async () => {
      if (!this.running || generation !== this.generation) return;
      try {
        let healthy = false;
        if (this.connected && this.isAlive(this.connected.processId)) {
          try { healthy = this.renderer ? (await this.renderer.windows()).length > 0 : await this.probe(); } catch { }
        }
        if (!healthy && this.running && generation === this.generation) {
          this.renderer?.close(); this.renderer = null;
          this.connected = null;
          await this.enable(() => !this.running || generation !== this.generation);
        }
      } catch (error) {
        if (this.running && generation === this.generation) this.progress('error', error.message);
      }
      if (this.running && generation === this.generation) {
        this.timer = this.timers.setTimeout(() => { void tick(); }, this.intervalMs);
        this.timer.unref?.();
      }
    };
    void tick();
  }
  stop() {
    this.running = false;
    this.generation++;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.openingRenderer?.close();
    this.renderer?.close();
    this.renderer = null; this.connected = null;
  }
  async getRendererConnection(target) {
    if (!this.renderer) await this.enable();
    const current = this.renderer?.target;
    if (!current || current.pid !== target.pid || current.executable.toLowerCase() !== target.executable.toLowerCase())
      throw new Error(this.state.message || 'Codex 页面调试连接尚未就绪。');
    return this.renderer;
  }
  retry() {
    this.rendererAttempt = null;
    return this.enable();
  }
  async enableRenderer(target, rows, isCancelled) {
    const endpoints = this.rendererEndpoints();
    const available = endpoints.length || rows.some(row => row.OwningProcess === target.pid && row.LocalAddress === '127.0.0.1');
    const setup = '连接需要重新启动 Codex。请先保存工作，再点击“启动或重启 Codex 并连接”。';
    if (!available) {
      this.rendererAttempt = null;
      this.progress('setup', setup);
      return { success: false, needsSetup: true, error: setup };
    }
    const signature = JSON.stringify([target.pid, target.executable, endpoints, rows]);
    if (this.renderer && this.connected?.processId === target.pid) return this.connected;
    if (signature === this.rendererAttempt) return { success: false, needsSetup: true, error: this.state.message };
    this.rendererAttempt = signature;
    const connection = this.rendererFactory();
    this.openingRenderer = connection;
    this.progress('checking', '正在验证 Codex 调试连接…');
    try {
      await connection.open(target);
      if (isCancelled()) { connection.close(); return { success: false, cancelled: true }; }
      this.renderer = connection;
      this.connected = { success: true, processId: target.pid, port: connection.port, transport: 'renderer' };
      this.progress('ready', '已连接新版 Codex 的调试接口');
      return this.connected;
    } catch (error) {
      connection.close();
      if (isCancelled()) return { success: false, cancelled: true };
      const message = `连接未完成：${error.message} 请点击“重试连接”；若仍无法连接，请保存工作后通过下方按钮重启 Codex。`;
      this.progress('setup', message);
      return { success: false, needsSetup: true, error: message };
    } finally { this.openingRenderer = null; }
  }
  enable(isCancelled = () => false) {
    if (this.pending) return this.pending;
    const generation = this.generation;
    const callerCancelled = isCancelled;
    isCancelled = () => generation !== this.generation || callerCancelled();
    let activationPid;
    this.pending = Promise.resolve().then(async () => {
      if (isCancelled()) return { success: false, cancelled: true };
      if (this.platform !== 'win32') throw new Error('自动调试目前支持 Windows。');
      // Keep the actionable result visible while background monitoring continues.
      if (!['error', 'setup', 'ready'].includes(this.state.stage)) {
        this.progress('locating', '正在检查运行中的 Codex 和调试端口…');
      }
      let target;
      try { target = await this.findProcess(); }
      catch (error) {
        if (!isCancelled()) this.progress('waiting', `等待 Codex 启动：${error.message}`);
        return { success: false, error: error.message };
      }
      const rows = await this.listeners();
      if (isCancelled()) return { success: false, cancelled: true };
      const runtime = await this.readRuntime(target);
      if (isCancelled()) return { success: false, cancelled: true };
      if (runtime.name === 'owl') {
        // A legacy Node inspector can still be reused if explicitly available.
        // Otherwise the native, user-approved renderer endpoint owns this link.
        if (!rows.length || !(await this.probe())) return this.enableRenderer(target, rows, isCancelled);
      }
      this.validateListeners(rows, target);
      if (!rows.length) {
        if (this.attempted.has(target.pid)) {
          throw new Error(this.failures.get(target.pid) || 'Codex 调试端口已关闭，请重启 Codex 后再试。');
        }
        this.attempted.add(target.pid);
        activationPid = target.pid;
        this.progress('activating', `正在为运行中的 Codex 开启调试（PID ${target.pid}）…`);
        await this.activate(target.pid);
        let ready = false;
        for (let attempt = 0; attempt < 12; attempt++) {
          await this.delay(500);
          if (isCancelled()) return { success: false, cancelled: true };
          if (!this.isAlive(target.pid)) throw new Error('Codex 在开启调试时退出了，请重新打开 Codex。');
          const current = await this.listeners();
          this.validateListeners(current, target);
          if (current.length) { ready = true; break; }
        }
        if (!ready) throw new Error('已尝试开启调试，但 9229 端口尚未就绪。请重启 Codex 后再试。');
      }
      this.progress('checking', '正在验证 Codex 调试连接…');
      await this.verify(target);
      if (isCancelled()) return { success: false, cancelled: true };
      this.progress('ready', `调试已开启 · 127.0.0.1:9229 · PID ${target.pid}`);
      this.failures.delete(target.pid);
      this.connected = { success: true, processId: target.pid, port: 9229 };
      return this.connected;
    }).catch(error => {
      if (activationPid !== undefined) this.failures.set(activationPid, error.message);
      try { if (!isCancelled()) this.progress('error', error.message); } catch { }
      return { success: false, error: error.message };
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
module.exports = CodexDebugActivation;
