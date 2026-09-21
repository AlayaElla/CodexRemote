'use strict';
// Start Codex with a loopback inspector and verify the process identity.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const INSPECT_ARGUMENT = '--inspect=127.0.0.1:9229';
const runNative = promisify(execFile);

// Keep this launcher independent of the repository and npm dependencies.
function parseMacCodexProcesses(stdout) {
  return String(stdout || '').split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.+?\/(Codex|ChatGPT)\.app\/Contents\/MacOS\/(Codex|ChatGPT))(?:\s|$)/);
    return match && match[3] === match[4] && !/(?:^|\s)--type=/.test(line)
      ? [{ pid: Number(match[1]), executable: match[2] }] : [];
  });
}

async function connectInspector({ port = 9229, timeoutMs = 1500 } = {}) {
  if (typeof WebSocket !== 'function') throw new Error('启动器需要 Node.js 22 或更新版本。');
  const targets = await new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/json/list`, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('error', reject);
      response.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > 16384) request.destroy(new Error('调试端点响应过大。'));
      });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('调试端点未就绪。');
          resolve(JSON.parse(body));
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('调试端点连接超时。')), timeoutMs);
    request.once('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
  const nodes = Array.isArray(targets) ? targets.filter(target => target?.type === 'node') : [];
  const url = nodes.length === 1 ? nodes[0].webSocketDebuggerUrl : null;
  if (typeof url !== 'string' || !new RegExp(`^ws://127\\.0\\.0\\.1:${port}/[\\w-]+$`).test(url)) {
    throw new Error('本地调试端点无效。');
  }
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      if (error) { socket.close(); reject(error); } else resolve();
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error('调试 WebSocket 连接失败。'));
    const onClose = () => finish(new Error('调试 WebSocket 已关闭。'));
    const timer = setTimeout(() => finish(new Error('调试 WebSocket 连接超时。')), timeoutMs);
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
  let sequence = 0;
  return {
    close: () => socket.close(),
    evaluate(expression) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const finish = (error, value) => {
          clearTimeout(timer);
          socket.removeEventListener('message', onMessage);
          socket.removeEventListener('close', onClose);
          socket.removeEventListener('error', onClose);
          error ? reject(error) : resolve(value);
        };
        const onClose = () => finish(new Error('调试连接已断开。'));
        const onMessage = event => {
          try {
            if (typeof event.data !== 'string' || event.data.length > 16384) throw new Error('调试返回数据无效。');
            const message = JSON.parse(event.data);
            if (message.id !== id) return;
            if (message.error || message.result?.exceptionDetails) throw new Error('读取 Codex 进程身份失败。');
            finish(null, message.result?.result?.value);
          } catch (error) { finish(error); }
        };
        const timer = setTimeout(() => finish(new Error('读取 Codex 进程身份超时。')), timeoutMs);
        socket.addEventListener('message', onMessage);
        socket.addEventListener('close', onClose);
        socket.addEventListener('error', onClose);
        try { socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); }
        catch (error) { finish(error); }
      });
    }
  };
}

function parseListeners(output) {
  let pid = null;
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    if (line.startsWith('n')) rows.push({ pid, address: line.slice(1) });
  }
  return rows;
}

async function launch(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') throw new Error('此启动器仅适用于 macOS。');
  const run = options.run || ((file, args) => runNative(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }));
  const exists = options.exists || fs.existsSync;
  const connect = options.connectInspector || connectInspector;
  const delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const app = options.appPath || ['/Applications/ChatGPT.app', '/Applications/Codex.app'].find(exists);
  if (!app || !path.isAbsolute(app) || !exists(app)) throw new Error('未找到 Codex 应用。可通过 --app=/完整路径/Codex.app 指定。');
  const plist = path.join(app, 'Contents', 'Info.plist');
  const metadata = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])).stdout);
  if (metadata.CFBundleIdentifier !== 'com.openai.codex' || !['ChatGPT', 'Codex'].includes(metadata.CFBundleExecutable)) {
    throw new Error('所选应用不是 Codex 桌面客户端。');
  }
  const executable = path.join(app, 'Contents', 'MacOS', metadata.CFBundleExecutable);
  const processes = async () => parseMacCodexProcesses((await run('/bin/ps', ['-axo', 'pid=,command='])).stdout);
  const listeners = async () => {
    try {
      return parseListeners((await run('/usr/sbin/lsof', ['-nP', '-iTCP:9229', '-sTCP:LISTEN', '-Fpn'])).stdout);
    } catch (error) {
      // lsof exits 1 with no output when there is no matching listener.
      if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return [];
      throw error;
    }
  };
  const before = (await run('/bin/ps', ['-axo', 'pid=,command='])).stdout;
  const running = parseMacCodexProcesses(before);
  const bridgeRunning = before.split(/\r?\n/).some(line => /^\s*\d+\s+.*\/Codex Remote\.app\/Contents\/MacOS\/Codex Remote(?:\s|$)/.test(line));
  const occupied = await listeners();
  const plan = { app, version: metadata.CFBundleShortVersionString, executable,
    arguments: [INSPECT_ARGUMENT], running: running.length, bridgeRunning, portInUse: occupied.length > 0 };
  if (options.checkOnly) return plan;
  if (running.length) throw new Error('请先保存工作并完全退出 Codex，再运行启动器。没有停止任何进程。');
  if (bridgeRunning) throw new Error('请先退出 Codex Remote，再运行启动器。');
  if (occupied.length) throw new Error('9229 端口已被占用；没有启动应用。');

  await run('/usr/bin/open', ['-a', app, '--args', INSPECT_ARGUMENT]);
  for (let attempt = 0; attempt < (options.attempts || 20); attempt++) {
    await delay(500);
    const current = await processes();
    const rows = await listeners();
    const target = current.find(value => value.executable === executable);
    if (rows.length && (!target || current.length !== 1 || rows.some(row => row.pid !== target.pid || row.address !== '127.0.0.1:9229'))) {
      throw new Error('调试端口归属或监听地址不匹配；已停止检查，未连接该端口。');
    }
    if (!target || !rows.length) continue;
    let inspector;
    try { inspector = await connect(); } catch (_) { continue; }
    try {
      const identity = await inspector.evaluate('({pid:process.pid,executable:process.execPath})');
      if (identity?.pid !== target.pid || identity?.executable !== executable) throw new Error('调试连接身份不匹配。');
      return { ...plan, ready: true, pid: target.pid };
    } finally { inspector.close(); }
  }
  throw new Error('Codex 未提供启动时调试接口。请检查应用版本与启动参数。');
}

const HELP = `Codex macOS 调试启动器

用法：node scripts/start-codex-with-inspector-macos.js [参数]
独立 .command 文件支持相同参数。

--app=/完整路径/Codex.app  指定 Codex 应用
--check-only             仅显示应用、进程和端口状态
--help, -h               显示帮助

需要 Node.js 22 或更新版本。启动前请退出 Codex 和 Codex Remote。
调试地址：127.0.0.1:9229。接口验证后可打开 Codex Remote。`;

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  try {
    const unknown = args.find(arg => arg !== '--check-only' && !arg.startsWith('--app='));
    if (unknown) throw new Error(`不支持的参数：${unknown}。使用 --help 查看用法。`);
    const applications = args.filter(arg => arg.startsWith('--app='));
    if (applications.length > 1) throw new Error('--app 只能指定一次。');
    if (applications.length && !applications[0].slice(6)) throw new Error('--app 需要应用的完整路径。');
    if (Number(process.versions.node.split('.')[0]) < 22 || typeof WebSocket !== 'function') {
      throw new Error('启动器需要 Node.js 22 或更新版本。');
    }
    const result = await launch({ checkOnly: args.includes('--check-only'), appPath: applications[0]?.slice(6) });
    if (!result.ready) console.log(JSON.stringify(result, null, 2));
    else console.log(`Codex ${result.version} 的本地调试接口已验证（PID ${result.pid}）。\n请打开 Codex Remote 连接 Micro 并同步任务。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = { launch, main, parseListeners, parseMacCodexProcesses, connectInspector, INSPECT_ARGUMENT };
