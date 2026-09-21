// Serialized into the identity-verified Codex main process.
function installRealtimeRuntime({ pipePath, token, controlLocatorSource, rendererSource, coordinatorSource }) {
  const requireNative = process.mainModule.require.bind(process.mainModule);
  const { app, BrowserWindow } = requireNative('electron');
  const fs = requireNative('fs'), path = requireNative('path'), net = requireNative('net');
  const assets = path.join(app.getAppPath(), 'webview', 'assets');
  const modules = process.platform === 'darwin'
    ? ['app-primary-426732871368.js', 'app-initial-a498f911edeb.js']
    : ['app-primary-355549b35da9.js', 'app-initial-6c4523b43a11.js'];
  for (const file of modules) {
    if (!fs.existsSync(path.join(assets, file))) throw new Error('Codex realtime renderer version is unsupported.');
  }
  const startNativeVoice = new Function(`return (${coordinatorSource})`)();
  function selectedWindowTask() {
    const root = document.getElementById('root'), container = root?.[Object.keys(root).find(key => key.startsWith('__reactContainer'))];
    const queue = [container?.stateNode?.current || container], seen = new Set(), composerTargets = new Map(), activeTargets = new Map();
    while (queue.length && seen.size < 30000) {
      const fiber = queue.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
      const props = fiber.memoizedProps;
      if (props?.isActive === true && typeof props.conversationId === 'string' && typeof props.hostId === 'string')
        activeTargets.set(`${props.hostId}:${props.conversationId}`, { taskId: props.conversationId, hostId: props.hostId });
      if (props && Object.prototype.hasOwnProperty.call(props, 'onRealtimeStart') && typeof props.conversationId === 'string' && typeof props.executionTargetHostId === 'string')
        composerTargets.set(`${props.executionTargetHostId}:${props.conversationId}`, { taskId: props.conversationId, hostId: props.executionTargetHostId });
      queue.push(fiber.sibling, fiber.child);
    }
    return composerTargets.size === 1 ? [...composerTargets.values()][0] : activeTargets.size === 1 ? [...activeTargets.values()][0] : null;
  }
  const selectTask = window => window.webContents.executeJavaScript(`(${selectedWindowTask.toString()})()`);
  const eligible = () => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()
    && /^app:\/\/-\/(?:index|detached-window)\.html(?:\?|$)/.test(window.webContents.getURL())
    && !/global-dictation/.test(window.webContents.getURL()));
  let busy = false, closed = false, owner = null, context = null, routeToken = null, idleTimer;
  const call = async (window, op, extra = {}) => {
    if (!window || window.isDestroyed()) throw new Error('Codex 语音窗口已关闭。');
    return window.webContents.executeJavaScript(`(${rendererSource})(${JSON.stringify({ op, target: context, routeToken, initialModule: modules[1], audioPlatform: process.platform, ...extra })}, (${controlLocatorSource}))`);
  };
  const diagnose = async () => {
    const windows = [];
    for (const window of eligible()) {
      try { windows.push({ windowId: window.id, task: await selectTask(window), ...await call(window, 'read') }); }
      catch (error) { windows.push({ windowId: window.id, error: String(error.message).slice(0, 256) }); }
    }
    return { windows };
  };
  const dispatch = async request => {
    if (request.type === 'diagnose') return diagnose();
    if (request.type === 'start') {
      if (owner) throw new Error('Codex voice chat is already active.');
      const target = request.target;
      if (!target || typeof target.taskId !== 'string' || typeof target.hostId !== 'string') throw new Error('A Codex task context is required.');
      context = target;
      routeToken = requireNative('crypto').randomUUID();
      const surfaces = [], taskWindows = [];
      for (const window of eligible()) {
        // Empty detached shells have not initialized the version-pinned service.
        // Only skip that known empty shell; real surfaces must all be inspected.
        if (window.webContents.getURL().includes('initialRoute=%2Fdetached-window')) continue;
        surfaces.push(window);
        if (!window.webContents.getURL().includes('avatar-overlay')) {
          const selected = await selectTask(window);
          if (selected?.taskId === target.taskId && selected.hostId === target.hostId) taskWindows.push(window);
        }
      }
      if (taskWindows.length !== 1) throw new Error('A unique Codex window for the selected task is required.');
      const result = await startNativeVoice({ surfaces, taskWindow: taskWindows[0], target, routeToken,
        route: { inputCaptureName: request.inputCaptureName, outputDeviceName: request.outputDeviceName },
        call, selectTask, wait: ms => new Promise(resolve => setTimeout(resolve, ms)) });
      if (closed) { await call(result.window, 'cleanup', { stop: true }); throw new Error('Codex 语音连接已取消。'); }
      owner = result.window;
      return result.snapshot;
    }
    if (!owner) return { active: false, connected: false, state: 'ended' };
    if (request.target && (request.target.taskId !== context.taskId || request.target.hostId !== context.hostId)) throw new Error('Codex voice target changed.');
    return call(owner, request.type, { muted: request.muted, voiceSessionId: request.voiceSessionId });
  };
  const close = server => {
    if (closed) return; closed = true; clearTimeout(idleTimer); server.close();
    if (owner && !owner.isDestroyed()) void call(owner, 'cleanup', { stop: true }).catch(() => {});
  };
  const renewIdle = server => { clearTimeout(idleTimer); idleTimer = setTimeout(() => close(server), 30 * 60 * 1000); idleTimer.unref(); };
  const server = net.createServer(socket => {
    socket.setTimeout(25000, () => socket.destroy()); let input = '', handled = false;
    socket.on('error', () => {});
    socket.on('data', data => {
      if (handled) return; input += data.toString('utf8');
      if (input.length > 4096) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      void (async () => {
        let ownsLock = false;
        try {
          const request = JSON.parse(input);
          if (closed || request.token !== token || !['read', 'start', 'stop', 'mute', 'diagnose', 'close'].includes(request.type)) throw new Error('Invalid realtime runtime request.');
          renewIdle(server);
          if (request.type === 'close') { socket.end('{}\n'); close(server); return; }
          if (busy && request.type !== 'read') throw new Error('Codex realtime control is busy.');
          if (request.type !== 'read') { busy = true; ownsLock = true; }
          socket.end(JSON.stringify({ snapshot: await dispatch(request) }) + '\n');
        } catch (error) { socket.end(JSON.stringify({ error: String(error.message || error).slice(0, 512) }) + '\n'); }
        finally { if (ownsLock) busy = false; }
      })();
    });
  });
  server.on('error', () => close(server)); server.on('close', () => clearTimeout(idleTimer));
  return new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(pipePath, () => {
      try {
        if (process.platform === 'darwin') fs.chmodSync(pipePath, 0o600);
        renewIdle(server); resolve({ processId: process.pid, appVersion: app.getVersion() });
      } catch (error) { close(server); reject(error); }
    });
  });
}

module.exports = installRealtimeRuntime;
