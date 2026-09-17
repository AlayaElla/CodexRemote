// Runs in the verified Codex main process. Keep this function self-contained:
// the bridge transports its source once, then reads through a local named pipe.
function installMicroRuntime({ pipePath, token }) {
  const requireNative = process.mainModule.require.bind(process.mainModule);
  const { app, BrowserWindow } = requireNative('electron');
  const fs = requireNative('fs');
  const path = requireNative('path');
  const net = requireNative('net');
  const assets = path.join(app.getAppPath(), 'webview', 'assets');
  const names = fs.readdirSync(assets);
  const signalsName = names.find(name => /^codex-micro-slot-signals-[\w-]+\.js$/.test(name));
  if (!signalsName) throw new Error('Codex Micro slot module is unavailable');
  const moduleText = fs.readFileSync(path.join(assets, signalsName), 'utf8');
  const initialName = moduleText.match(/from"\.\/(app-initial-[\w-]+\.js)"/)?.[1];
  const primaryName = moduleText.match(/from"\.\/(app-primary-[\w-]+\.js)"/)?.[1];
  if (!initialName || !primaryName) throw new Error('Codex Micro module dependencies are unavailable');

  async function readRenderer({ signalsName, initialName, primaryName }) {
    const [signals, initial, primary] = await Promise.all([
      import(`app://-/assets/${signalsName}`), import(`app://-/assets/${initialName}`), import(`app://-/assets/${primaryName}`)
    ]);
    const root = document.getElementById('root');
    if (!root) return null;
    const container = root[Object.keys(root).find(key => key.startsWith('__reactContainer'))];
    const queue = [container?.stateNode?.current || container], seen = new Set();
    while (queue.length && seen.size < 30000) {
      const fiber = queue.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      for (let hook = fiber.memoizedState, count = 0; hook && count++ < 100; hook = hook.next) {
        const store = hook.memoizedState?.current;
        if (!store || typeof store.get !== 'function' || typeof store.watch !== 'function' || store.scope !== initial.Een) continue;
        if (store.get(primary.im) !== true) return null;
        const slots = store.get(signals.n);
        if (!Array.isArray(slots) || slots.length !== 6) throw new Error('Codex Micro slot schema changed');
        const assignments = store.get(signals.u) || {};
        // Read the configured lighting model, not transient RGB off/effect RPCs.
        // Keep a changed lighting schema from breaking task synchronization.
        let lighting = null;
        try {
          const model = store.get(signals.t);
          if (model && Number.isFinite(model.brightness) && model.brightness >= 0 && model.brightness <= 1
            && (model.inactivityTimeoutMs === null || (Number.isInteger(model.inactivityTimeoutMs)
              && model.inactivityTimeoutMs >= 30000 && model.inactivityTimeoutMs <= 3600000))) {
            lighting = { brightnessPercent: Math.round(model.brightness * 100), autoDimMs: model.inactivityTimeoutMs,
              voiceState: model.voiceState };
          }
        } catch (_) {}
        return {
          lighting,
          // Read the renderer's persisted-atom cache before its asynchronous
          // disk flush. A new thread is bound here at first submission.
          threadBindings: Object.fromEntries(Object.entries(typeof initial.b9t === 'function'
            ? initial.b9t('client-thread-bindings-v1', {}) || {} : {}).filter(([client, thread]) =>
              /^client-new-thread:[\w-]{1,128}$/.test(client) && typeof thread === 'string' &&
              /^[\w-]{1,128}$/.test(thread)).slice(-128)),
          source: initial.$Zt(store.get, initial.Qtn.agentSource),
          slots: slots.map(slot => {
            const key = slot.threadKey;
            const id = typeof key === 'string' && key.startsWith('local:') ? key.slice(6) : null;
            const assignment = assignments[`AG${String(slot.id).padStart(2, '0')}`];
            const hostId = key == null ? null : id == null ? 'cloud' :
              store.get(initial.Njt, id) || (assignment?.threadKey === key ? assignment.hostId : null) || 'local';
            return { id: slot.id, threadKey: key, hostId, title: slot.title, status: slot.status, selected: slot.selected };
          })
        };
      }
      queue.push(fiber.sibling, fiber.child);
    }
    return null;
  }

  const rendererCode = `(${readRenderer.toString()})(${JSON.stringify({ signalsName, initialName, primaryName })})`;
  let pendingRead = null;
  const read = () => pendingRead ||= (async () => {
    const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()
      && /^app:\/\/-\/(?:index|detached-window)\.html(?:\?|$)/.test(window.webContents.getURL())
      && !/avatar-overlay|global-dictation/.test(window.webContents.getURL()));
    const snapshots = [];
    for (const window of windows) {
      const snapshot = await window.webContents.executeJavaScript(rendererCode);
      if (snapshot) snapshots.push({ ...snapshot, windowId: window.id });
    }
    if (snapshots.length !== 1) throw new Error('Codex Micro owner window is unavailable');
    return { ...snapshots[0], version: 1, nativeMicroMapping: true, processId: process.pid, appVersion: app.getVersion() };
  })().finally(() => { pendingRead = null; });
  const sockets = new Set();
  let idleTimer;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
    let input = '', handled = false;
    socket.on('data', data => {
      if (handled) return;
      input += data.toString('utf8');
      if (input.length > 1024) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      let request;
      try { request = JSON.parse(input); } catch (_) { socket.destroy(); return; }
      if (request.token !== token || !['read', 'close'].includes(request.type)) { socket.destroy(); return; }
      clearTimeout(idleTimer);
      if (request.type === 'close') { socket.end('{}\n'); server.close(); return; }
      idleTimer = setTimeout(() => { for (const socket of sockets) socket.destroy(); server.close(); }, 30000);
      idleTimer.unref();
      read().then(snapshot => socket.end(JSON.stringify({ snapshot }) + '\n'), error => socket.end(JSON.stringify({ error: error.message }) + '\n'));
    });
  });
  server.on('error', () => { for (const socket of sockets) socket.destroy(); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, () => {
      idleTimer = setTimeout(() => server.close(), 30000); idleTimer.unref();
      resolve({ processId: process.pid, appVersion: app.getVersion() });
    });
  });
}

module.exports = { installMicroRuntime };
