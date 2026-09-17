const net = require('node:net');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { installMicroRuntime } = require('../platform/codex-micro-runtime');

function normalizeMicroSnapshot(value) {
  if (value?.version !== 1 || value.nativeMicroMapping !== true || !['recent', 'pinned', 'priority', 'custom'].includes(value.source)
    || !Array.isArray(value.slots) || value.slots.length !== 6) throw new Error('Codex Micro 槽位数据无效');
  const slots = value.slots.map((slot, index) => {
    if (slot?.id !== index || (slot.title != null && (typeof slot.title !== 'string' || slot.title.length > 4096))) throw new Error('Codex Micro 槽位顺序无效');
    const key = slot.threadKey;
    if (key == null) return { slot: index, hostId: null, threadId: null, title: slot.title ?? null, nativeStatus: slot.status };
    if (typeof key !== 'string' || !/^(local|remote):[\w-]{1,128}$/.test(key)
      || typeof slot.hostId !== 'string' || !/^[\w-]{1,128}$/.test(slot.hostId)) throw new Error('Codex Micro 任务标识无效');
    return { slot: index, hostId: slot.hostId, threadId: key.slice(key.indexOf(':') + 1), title: slot.title ?? null, nativeStatus: slot.status };
  });
  const raw = value.lighting;
  const lighting = raw && Number.isInteger(raw.brightnessPercent) && raw.brightnessPercent >= 0 && raw.brightnessPercent <= 100
    && (raw.autoDimMs === null || [30000, 60000, 180000, 600000, 1800000, 3600000].includes(raw.autoDimMs))
    ? { brightnessPercent: raw.brightnessPercent, autoDimMs: raw.autoDimMs,
      activityKey: JSON.stringify(value.slots.map(slot => [slot.threadKey ?? null, slot.status ?? null, slot.selected === true])
        .concat([[typeof raw.voiceState === 'string' ? raw.voiceState.slice(0, 32) : null]])) } : null;
  const threadBindings = Object.fromEntries(Object.entries(value.threadBindings || {}).filter(([client, thread]) =>
    /^client-new-thread:[\w-]+$/.test(client) && typeof thread === 'string' && /^[\w-]{1,128}$/.test(thread)));
  return { ...value, slots, lighting, threadBindings };
}

function findCodexProcess() {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('ChatGPT.exe','Codex.exe') -and $_.ExecutablePath -match '[\\\\/]OpenAI[.]Codex_[^\\\\/]+[\\\\/]app[\\\\/]' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress";
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, encoding: 'utf8', timeout: 8000, maxBuffer: 8192 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const result = JSON.parse(stdout), processes = Array.isArray(result) ? result : [result];
        if (processes.length !== 1 || !Number.isInteger(processes[0].ProcessId)) throw new Error('无法确定 Codex 主进程');
        resolve({ pid: processes[0].ProcessId, executable: processes[0].ExecutablePath });
      } catch (_) { reject(new Error('未找到可同步的 Codex 客户端')); }
    }));
}

function inspectorTargets() {
  return new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:9229/json/list', { timeout: 500 }, response => {
      let body = '';
      response.on('data', data => { body += data; if (body.length > 16384) request.destroy(new Error('inspector response too large')); });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('timeout', () => request.destroy(new Error('inspector unavailable')));
    request.on('error', reject);
  });
}

async function connectInspector() {
  const targets = await inspectorTargets();
  const url = targets.find(target => target.type === 'node')?.webSocketDebuggerUrl;
  if (typeof url !== 'string' || !/^ws:\/\/127\.0\.0\.1:9229\/[\w-]+$/.test(url)) throw new Error('Codex 本地连接不可用');
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Codex 本地连接超时')); }, 1500);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
  let sequence = 0;
  return {
    close: () => socket.close(),
    evaluate(expression) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const finish = (error, value) => { clearTimeout(timer); socket.off('message', onMessage); socket.off('close', onClose); error ? reject(error) : resolve(value); };
        const onClose = () => finish(new Error('Codex 本地连接已断开'));
        const onMessage = data => {
          const message = JSON.parse(data);
          if (message.id !== id) return;
          if (message.error || message.result?.exceptionDetails) finish(new Error(message.result?.exceptionDetails?.exception?.description || 'Codex Micro 运行时读取失败'));
          else finish(null, message.result?.result?.value);
        };
        const timer = setTimeout(() => finish(new Error('Codex Micro 运行时读取超时')), 8000);
        socket.on('message', onMessage); socket.once('close', onClose);
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      });
    }
  };
}

function readPipe(pipePath, token, type = 'read') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    socket.setEncoding('utf8');
    let body = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Codex Micro 同步超时')); }, 5000);
    socket.on('connect', () => socket.write(JSON.stringify({ token, type }) + '\n'));
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('data', data => {
      body += data.toString('utf8');
      if (Buffer.byteLength(body) > 65536) { socket.destroy(); clearTimeout(timer); reject(new Error('Codex Micro 数据过大')); }
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(body);
        if (response.error) throw new Error(response.error);
        resolve(response.snapshot);
      } catch (error) { reject(error); }
    });
  });
}

class CodexMicroSlots {
  constructor(options = {}) {
    this.nativeMicroMapping = true;
    this.findProcess = options.findProcess || findCodexProcess;
    this.connectInspector = options.connectInspector || connectInspector;
    this.readPipe = options.readPipe || readPipe;
    this.activate = options.activate || (pid => process._debugProcess(pid));
    this.pipePath = null; this.token = null; this.connecting = null; this.generation = 0;
    this.nextAttemptAt = 0;
  }
  async read() {
    if (Date.now() < this.nextAttemptAt) throw new Error('正在重新连接 Codex Micro');
    try {
      if (!this.pipePath) await this._connect();
      return normalizeMicroSnapshot(await this.readPipe(this.pipePath, this.token));
    }
    catch (error) { this.stop(); this.nextAttemptAt = Date.now() + 5000; throw error; }
  }
  _connect() {
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    const promise = this._bootstrap(generation).finally(() => { if (this.connecting === promise) this.connecting = null; });
    this.connecting = promise;
    return promise;
  }
  async _bootstrap(generation) {
    const target = await this.findProcess();
    let inspector, activated = false, verified = false;
    try {
      try { inspector = await this.connectInspector(); } catch (_) {
        this.activate(target.pid); activated = true;
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          try { inspector = await this.connectInspector(); break; } catch (_) {}
        }
      }
      if (!inspector) throw new Error('无法建立 Codex Micro 本地同步连接');
      const identity = await inspector.evaluate('({pid:process.pid,executable:process.execPath})');
      if (identity?.pid !== target.pid || identity.executable?.toLowerCase() !== target.executable.toLowerCase()) throw new Error('Codex 进程身份不匹配');
      verified = true;
      if (generation !== this.generation) throw new Error('Codex Micro 同步已取消');
      const pipePath = `\\\\.\\pipe\\codex-remote-micro-${target.pid}-${randomUUID()}`;
      const token = randomBytes(32).toString('hex');
      await inspector.evaluate(`(${installMicroRuntime.toString()})(${JSON.stringify({ pipePath, token })})`);
      if (generation !== this.generation) { void this.readPipe(pipePath, token, 'close').catch(() => {}); throw new Error('Codex Micro 同步已取消'); }
      this.pipePath = pipePath; this.token = token;
    } finally {
      // The inspector is needed only to establish the narrowly scoped pipe.
      if (activated && verified && inspector) await inspector.evaluate("setTimeout(() => process.mainModule.require('inspector').close(), 50); true").catch(() => {});
      inspector?.close();
    }
  }
  stop() {
    this.generation += 1;
    this.nextAttemptAt = 0;
    if (this.pipePath) void this.readPipe(this.pipePath, this.token, 'close').catch(() => {});
    this.pipePath = null; this.token = null; this.connecting = null;
  }
}

module.exports = { CodexMicroSlots, normalizeMicroSnapshot, findCodexProcess };
