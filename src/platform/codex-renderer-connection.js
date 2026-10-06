'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const WebSocket = require('ws');

const APP_PAGE = /^app:\/\/-\/(?:index|detached-window)\.html(?:\?|$)/;

function portListeners(port = 9229) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error('Invalid debug port'));
  const script = `$rows = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq ${port} } | Select-Object LocalAddress,OwningProcess); ConvertTo-Json -InputObject $rows -Compress`;
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, encoding: 'utf8', timeout: 8000 }, (error, stdout) => {
      if (error) return reject(new Error('无法检查 Codex 调试端口归属。'));
      try { const rows = JSON.parse(stdout || '[]'); resolve(Array.isArray(rows) ? rows : [rows]); }
      catch { reject(new Error('Codex 调试端口信息无效。')); }
    }));
}

function requestJson(port, resource) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: resource, timeout: 1500 }, response => {
      let body = '';
      response.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > 1024 * 1024) req.destroy(new Error('Codex 调试响应过大。'));
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error('Codex 页面调试接口不可用。'));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Codex 调试响应无效。')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Codex 调试连接超时。')));
    req.on('error', reject);
  });
}

function validPageTarget(target, port) {
  if (target?.type !== 'page' || !APP_PAGE.test(target.url || '') || !/^[\w-]+$/.test(target.id || '')) return false;
  try {
    const url = new URL(target.webSocketDebuggerUrl);
    return url.protocol === 'ws:' && url.hostname === '127.0.0.1' && url.port === String(port)
      && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === `/devtools/page/${target.id}`;
  } catch { return false; }
}

class CdpSession {
  constructor(socket, timeoutMs = 25000) {
    this.socket = socket; this.timeoutMs = timeoutMs; this.pending = new Map(); this.nextId = 0; this.closed = false;
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw); } catch { this.close(new Error('Codex 调试消息无效。')); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error || message.result?.exceptionDetails) {
        pending.reject(new Error(message.result?.exceptionDetails?.exception?.description || message.error?.message || 'Codex 页面运行失败。'));
      } else pending.resolve(message.result);
    });
    socket.on('error', error => this.close(error));
    socket.on('close', () => this.close(new Error('Codex 页面调试连接已关闭。')));
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('Codex 页面调试连接已关闭。'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex 页面操作超时，操作结果未知。'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  async evaluate(expression, sessionId) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    return result?.result?.value;
  }
  close(error = new Error('Codex 页面调试连接已关闭。')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.socket.terminate();
  }
}

function rendererEndpoints(appData = process.env.APPDATA, fileSystem = fs) {
  if (!appData) return [];
  const endpoints = [];
  for (const relative of ['Codex/web/Codex/DevToolsActivePort', 'Codex/DevToolsActivePort']) {
    try {
      const text = fileSystem.readFileSync(path.join(appData, relative), 'utf8');
      if (text.length > 4096) continue;
      const [portText, browserPath] = text.trim().split(/\r?\n/);
      const port = Number(portText);
      if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535
        || !/^\/devtools\/browser\/[\w-]+$/.test(browserPath || '')) continue;
      endpoints.push({ port, browserPath });
    } catch { /* No user-approved debugging endpoint has been created yet. */ }
  }
  return endpoints;
}

class CodexRendererConnection {
  constructor(options = {}) {
    this.port = options.port || 9229;
    this.explicitPort = options.port;
    this.browserPath = options.browserPath;
    this.endpoints = options.endpoints || (() => rendererEndpoints());
    this.listeners = options.listeners || (() => portListeners(this.port));
    this.findProcess = options.findProcess || (() => require('../core/codex-micro-slots').findCodexProcess());
    this.requestJson = options.requestJson || (resource => requestJson(this.port, resource));
    this.socketTimeoutMs = options.socketTimeoutMs || 60000;
    this.createSocket = options.createSocket || (url => new WebSocket(url, { handshakeTimeout: this.socketTimeoutMs, maxPayload: 1024 * 1024 }));
    this.isAlive = options.isAlive || (pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    this.fs = options.fs || fs;
    this.target = null; this.closed = false; this.sessions = new Map(); this.pendingSessions = new Map(); this.pendingSockets = new Set(); this.assetCache = null; this.browser = null;
  }
  async verifyOwner(target = this.target) {
    if (!target || !Number.isSafeInteger(target.pid) || target.pid <= 0 || typeof target.executable !== 'string') throw new Error('Codex 进程信息无效。');
    const current = await this.findProcess();
    if (current.pid !== target.pid || current.executable.toLowerCase() !== target.executable.toLowerCase()) throw new Error('Codex 调试进程已变化。');
    const rows = await this.listeners();
    if (!rows.length) throw new Error('Codex 页面调试端口尚未开启。');
    if (rows.some(row => row.OwningProcess !== target.pid || row.LocalAddress !== '127.0.0.1')) throw new Error('Codex 页面调试端口归属或监听地址不匹配。');
  }
  async open(target) {
    if (this.closed) throw new Error('Codex 页面调试连接已关闭。');
    const endpoints = this.explicitPort ? [{ port: this.port, browserPath: this.browserPath }]
      : [...this.endpoints(), { port: 9229 }];
    let lastError, connectionError;
    for (const endpoint of endpoints) {
      if (this.closed) throw new Error('Codex 页面调试连接已取消。');
      this.port = endpoint.port;
      let ownerVerified = false;
      try {
        await this.verifyOwner(target);
        ownerVerified = true;
        this.target = target;
        if (endpoint.browserPath) {
          if (!/^\/devtools\/browser\/[\w-]+$/.test(endpoint.browserPath)) throw new Error('Codex 浏览器调试地址无效。');
          this.browser = await this.connectSocket(`ws://127.0.0.1:${this.port}${endpoint.browserPath}`);
          await this.verifyOwner(target);
        }
        await this.windows();
        return this;
      } catch (error) {
        this.browser?.close(); this.browser = null;
        lastError = error;
        if (ownerVerified) connectionError = error;
      }
    }
    throw connectionError || lastError || new Error('Codex 页面调试端口尚未开启。');
  }
  async windows() {
    if (this.closed || !this.target || !this.isAlive(this.target.pid)) throw new Error('Codex 页面调试连接已断开。');
    const targets = this.browser
      ? (await this.browser.send('Target.getTargets'))?.targetInfos?.map(info => ({ ...info, id: info.targetId,
        webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/page/${info.targetId}` }))
      : await this.requestJson('/json/list');
    if (!Array.isArray(targets)) throw new Error('Codex 页面调试目标无效。');
    const pages = targets.filter(target => validPageTarget(target, this.port));
    if (!pages.length) throw new Error('Codex 主窗口尚未就绪。');
    const ids = new Set(pages.map(page => page.id));
    for (const [id, session] of this.sessions) if (!ids.has(id)) { session.close(); this.sessions.delete(id); }
    return pages.map(page => ({
      id: page.id,
      isDestroyed: () => this.closed || !this.isAlive(this.target.pid),
      webContents: { getURL: () => page.url, executeJavaScript: expression => this.evaluate(page, expression) }
    }));
  }
  async connectSocket(url) {
    if (this.closed) throw new Error('Codex 页面调试连接已取消。');
    const socket = this.createSocket(url);
    this.pendingSockets.add(socket);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('请在 Codex 中允许调试连接后重试。')); }, this.socketTimeoutMs);
        const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
        socket.once('open', () => finish());
        socket.once('error', finish);
        socket.once('close', () => finish(new Error('Codex 页面调试连接已关闭。')));
      });
      if (this.closed) throw new Error('Codex 页面调试连接已取消。');
      return new CdpSession(socket);
    } catch (error) { socket.terminate(); throw error; }
    finally { this.pendingSockets.delete(socket); }
  }
  async session(page) {
    if (this.closed) throw new Error('Codex 页面调试连接已关闭。');
    const existing = this.sessions.get(page.id);
    if (existing && !existing.closed) return existing;
    if (this.pendingSessions.has(page.id)) return this.pendingSessions.get(page.id);
    const pending = (async () => {
      await this.verifyOwner();
      if (!validPageTarget(page, this.port)) throw new Error('Codex 页面调试目标无效。');
      let session;
      if (this.browser) {
        const browser = this.browser;
        const { sessionId } = await browser.send('Target.attachToTarget', { targetId: page.id, flatten: true });
        if (typeof sessionId !== 'string' || !sessionId) throw new Error('Codex 页面调试会话无效。');
        let closed = false;
        session = { get closed() { return closed || browser.closed; },
          evaluate: expression => closed ? Promise.reject(new Error('Codex 页面调试连接已关闭。')) : browser.evaluate(expression, sessionId),
          close() { if (closed) return; closed = true; void browser.send('Target.detachFromTarget', { sessionId }).catch(() => {}); } };
      } else session = await this.connectSocket(page.webSocketDebuggerUrl);
      try {
        await this.verifyOwner();
        if (this.closed) throw new Error('Codex 页面调试连接已取消。');
        const location = await session.evaluate('location.href');
        if (!APP_PAGE.test(location || '')) throw new Error('Codex 调试窗口身份不匹配。');
        this.sessions.set(page.id, session);
        return session;
      } catch (error) { session.close(); throw error; }
    })().finally(() => this.pendingSessions.delete(page.id));
    this.pendingSessions.set(page.id, pending);
    return pending;
  }
  async evaluate(page, expression) {
    const guarded = `(() => { if (!${APP_PAGE.toString()}.test(location.href)) throw new Error('Codex window navigated away'); return (${expression}); })()`;
    return (await this.session(page)).evaluate(guarded);
  }
  assets() {
    if (this.closed || !this.target) throw new Error('Codex 页面调试连接已关闭。');
    if (this.assetCache) return this.assetCache;
    const root = path.join(path.dirname(this.target.executable), 'resources', 'app.asar');
    const assets = path.join(root, 'webview', 'assets');
    const names = this.fs.readdirSync(assets);
    const version = JSON.parse(this.fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    return this.assetCache = { names, version, read: name => {
      if (typeof name !== 'string' || !/^[\w.-]+\.js$/.test(name) || !names.includes(name)) throw new Error('Codex 资源名称无效。');
      return this.fs.readFileSync(path.join(assets, name), 'utf8');
    } };
  }
  close() {
    this.closed = true;
    for (const socket of this.pendingSockets) socket.terminate();
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.browser?.close(); this.browser = null;
  }
}

let connectionProvider = null;
function setRendererConnectionProvider(provider) { connectionProvider = provider; }
function createRendererConnection(options) {
  if (!connectionProvider || options) return new CodexRendererConnection(options);
  let connection = null, closed = false;
  const check = () => {
    if (closed || !connection) throw new Error('Codex 页面调试连接已关闭。');
    return connection;
  };
  return {
    get target() { return connection?.target; },
    get port() { return connection?.port; },
    async open(target) {
      if (closed) throw new Error('Codex 页面调试连接已关闭。');
      connection = await connectionProvider(target);
      check();
      return this;
    },
    windows: () => check().windows(), assets: () => check().assets(), close: () => { closed = true; connection = null; }
  };
}

module.exports = { CodexRendererConnection, createRendererConnection, setRendererConnectionProvider,
  portListeners, requestJson, validPageTarget, CdpSession, rendererEndpoints };
