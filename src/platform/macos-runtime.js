const { buildMacRendererProfile } = require('./macos-renderer-profile');
const { macRenderer } = require('./macos-renderer');

// Runs in Codex's verified main process; all dependencies travel with the source.
async function installMacRuntime({ pipePath, token }, buildProfile, renderer) {
  const requireNative = process.mainModule.require.bind(process.mainModule);
  const { app, BrowserWindow, powerMonitor } = requireNative('electron');
  const fs = requireNative('fs'), path = requireNative('path'), net = requireNative('net');
  const assets = path.join(app.getAppPath(), 'webview', 'assets');
  const names = fs.readdirSync(assets);
  const unique = prefix => {
    const matches = names.filter(name => name.startsWith(prefix) && name.endsWith('.js'));
    if (matches.length !== 1) throw new Error(`Codex module is unavailable: ${prefix}`);
    return matches[0];
  };
  const signalsName = unique('codex-micro-slot-signals-');
  const signalsText = fs.readFileSync(path.join(assets, signalsName), 'utf8');
  const initialName = signalsText.match(/from["']\.\/(app-initial-[\w-]+\.js)["']/)?.[1];
  if (!initialName) throw new Error('Codex initial module is unavailable.');
  const profile = buildProfile({ signalsName, signalsText,
    initialText: fs.readFileSync(path.join(assets, initialName), 'utf8'),
    bridgeText: fs.readFileSync(path.join(assets, unique('codex-micro-bridge-')), 'utf8') });
  const sockets = new Set();
  let owner = null, closed = false, busy = false, idleTimer, held = null;
  const windowForRequest = () => {
    const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()
      && /^app:\/\/-\/index\.html(?:\?|$)/.test(window.webContents.getURL()));
    if (windows.length !== 1) throw new Error('A unique Codex primary window is required.');
    if (owner !== null && owner !== windows[0].id) throw new Error('Codex primary window changed; reconnect required.');
    owner = windows[0].id;
    return windows[0];
  };
  const evaluate = (window, request) => window.webContents.executeJavaScript(
    `(${renderer.toString()})(${JSON.stringify(profile)},${JSON.stringify(request)})`);
  const read = async window => ({ ...await evaluate(window, { op: 'read' }), version: 1,
    nativeMicroMapping: true, processId: process.pid, appVersion: app.getVersion(), windowId: window.id });
  const release = async () => {
    if (!held) return;
    const target = held;
    held = null;
    try {
      const window = BrowserWindow.fromId(owner);
      if (!window || window.isDestroyed()) return;
      const current = await read(window);
      // A lost connection cancels dictation; releasing PTT would insert partial
      // text. Never send an emergency key into a different task or draft.
      if (current.selectedThreadKey !== target.expectedThreadKey || current.route !== target.expectedRoute
          || current.voiceState !== 'recording') return;
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    } catch (_) {}
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    if (!busy) void release();
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  const renew = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(close, 10000);
    idleTimer.unref();
  };
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    let input = Buffer.alloc(0), handled = false;
    socket.on('data', data => {
      if (handled) return;
      input = Buffer.concat([input, data]);
      if (input.length > 256 * 1024) { socket.destroy(); return; }
      if (!input.includes(10)) return;
      handled = true;
      void (async () => {
        let request;
        try { request = JSON.parse(input.toString('utf8')); } catch (_) { socket.destroy(); return; }
        if (!request || request.token !== token || closed) { socket.destroy(); return; }
        renew();
        if (request.type === 'close') { socket.end('{}\n'); close(); return; }
        const mutation = request.type !== 'read';
        if (busy && mutation) { socket.end(JSON.stringify({ error: 'Codex control is busy.' }) + '\n'); return; }
        if (mutation) busy = true;
        try {
          if (!['read', 'ptt', 'command', 'paste', 'escape'].includes(request.type)) throw new Error('Unsupported runtime operation.');
          if (mutation && powerMonitor.getSystemIdleState(1) === 'locked') throw new Error('macOS session is locked.');
          const window = windowForRequest();
          if (mutation) {
            const before = await read(window);
            if (request.expectedThreadKey !== before.selectedThreadKey || request.expectedRoute !== before.route)
              throw new Error('Codex target changed before control dispatch.');
            if (window.isMinimized()) window.restore();
            window.show(); window.focus();
          }
          let result;
          if (closed) throw new Error('Codex control connection closed.');
          if (request.type === 'read') result = await read(window);
          else if (request.type === 'escape') {
            for (let index = 0; index < (request.stop === true ? 2 : 1); index++) {
              window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
              window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
              if (index === 0 && request.stop === true) await new Promise(resolve => setTimeout(resolve, 100));
            }
            result = { success: true, delivery: 'submitted_to_keyboard', outcome: 'requested' };
          } else {
            if (request.type === 'ptt' && request.down === true) held = {
              expectedThreadKey: request.expectedThreadKey, expectedRoute: request.expectedRoute };
            result = await evaluate(window, { ...request, op: request.type });
            if (request.type === 'ptt' && request.down === false) held = null;
            if (request.type === 'command' && request.command === 'composer.submit' && result.voiceReleased === true) held = null;
          }
          if (!closed) socket.end(JSON.stringify({ snapshot: result }) + '\n');
        } catch (error) {
          socket.end(JSON.stringify({ error: String(error.message).slice(0, 512) }) + '\n');
        } finally {
          if (mutation) { busy = false; if (closed) void release(); }
        }
      })();
    });
  });
  server.on('error', close);
  server.on('close', () => clearTimeout(idleTimer));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, () => {
      try { fs.chmodSync(pipePath, 0o600); renew(); resolve(); }
      catch (error) { close(); reject(error); }
    });
  });
  return { processId: process.pid, appVersion: app.getVersion() };
}

function macRuntimeExpression(options) {
  return `(${installMacRuntime.toString()})(${JSON.stringify(options)},${buildMacRendererProfile.toString()},${macRenderer.toString()})`;
}
module.exports = { macRuntimeExpression, installMacRuntime };
