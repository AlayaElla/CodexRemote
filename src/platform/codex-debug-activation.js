'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const http = require('node:http');
const { findCodexProcess, connectInspector } = require('../core/codex-micro-slots');

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
    this.listeners = options.listeners || listeners;
    this.connect = options.connectInspector || connectInspector;
    this.activate = options.activate || (pid => process._debugProcess(pid));
    this.isAlive = options.isAlive || (pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    this.delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.onProgress = options.onProgress || (() => {});
    this.statusFile = options.statusFile;
    this.attempted = new Set();
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
        const healthy = this.connected && this.isAlive(this.connected.processId) && await this.probe();
        if (!healthy && this.running && generation === this.generation) {
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
  }
  enable(isCancelled = () => false) {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(async () => {
      if (this.platform !== 'win32') throw new Error('自动调试目前支持 Windows。');
      this.progress('locating', '正在检查运行中的 Codex 和调试端口…');
      let target;
      try { target = await this.findProcess(); }
      catch (error) {
        if (!isCancelled()) this.progress('waiting', `等待 Codex 启动：${error.message}`);
        return { success: false, error: error.message };
      }
      const rows = await this.listeners();
      if (isCancelled()) return { success: false, cancelled: true };
      this.validateListeners(rows, target);
      if (!rows.length) {
        if (this.attempted.has(target.pid)) throw new Error('此 Codex 进程已尝试开启调试。请查看上次结果，重新启动 Codex 后再试。');
        this.attempted.add(target.pid);
        this.progress('activating', `正在为运行中的 Codex 开启调试（PID ${target.pid}）…`);
        this.activate(target.pid);
        let ready = false;
        for (let attempt = 0; attempt < 12; attempt++) {
          await this.delay(500);
          if (isCancelled()) return { success: false, cancelled: true };
          if (!this.isAlive(target.pid)) throw new Error('Codex 在开启调试时退出了，请重新打开 Codex。');
          const current = await this.listeners();
          this.validateListeners(current, target);
          if (current.length) { ready = true; break; }
        }
        if (!ready) throw new Error('已尝试开启调试，但 9229 端口尚未就绪。');
      }
      this.progress('checking', '正在验证 Codex 调试连接…');
      await this.verify(target);
      if (isCancelled()) return { success: false, cancelled: true };
      this.progress('ready', `调试已开启 · 127.0.0.1:9229 · PID ${target.pid}`);
      this.connected = { success: true, processId: target.pid, port: 9229 };
      return this.connected;
    }).catch(error => {
      try { if (!isCancelled()) this.progress('error', error.message); } catch { }
      return { success: false, error: error.message };
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
module.exports = CodexDebugActivation;
