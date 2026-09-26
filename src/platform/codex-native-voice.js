// Adapter for Codex's native task voice service. This function is
// serialized into each renderer; it must not close over Node/module variables.
async function nativeVoiceRenderer(request, findControls, profile, loadModule = path => import(path)) {
  if (!profile || !/^app-initial-[\w-]+\.js$/.test(profile.initialName))
    throw new Error('当前 Codex 原生语音接口结构无法识别。');
  const module = await loadModule(`app://-/assets/${profile.initialName}`);
  const key = '__codexRemoteNativeVoiceV1';
  const serviceKey = '__codexRemoteNativeVoiceServiceV1';
  const isService = value => value && typeof value === 'object' && 'currentAttempt' in value
    && typeof value.start === 'function' && typeof value.cancelStart === 'function'
    && typeof value.stop === 'function' && typeof value.applyRealtimeMicrophoneMuteState === 'function';
  let service = globalThis[serviceKey]?.initialName === profile.initialName ? globalThis[serviceKey].service : null;
  if (!isService(service)) {
    const matches = Object.values(module).filter(isService);
    if (matches.length !== 1) throw new Error('当前 Codex 原生语音服务不可用。');
    service = matches[0];
    globalThis[serviceKey] = { initialName: profile.initialName, service };
  }
  if (!module[profile.phase] || !module[profile.microphoneMuted] || !module[profile.activity])
    throw new Error('当前 Codex 原生语音接口结构无法识别。');
  const matching = attempt => attempt?.locator?.conversationId === request.target?.taskId && attempt?.locator?.hostId === request.target?.hostId;
  const owned = () => globalThis[key]?.token === request.routeToken ? globalThis[key] : null;
  const inputId = runtime => runtime?.getInputStream()?.getAudioTracks()[0]?.getSettings()?.deviceId || null;
  const snapshot = () => {
    const route = owned(), attempt = service.currentAttempt;
    const phase = attempt ? attempt.scope.get(module[profile.phase]) : 'inactive';
    const active = Boolean(attempt), runtime = attempt?.runtime;
    const ours = Boolean(attempt && route?.attempt === attempt);
    const output = ours && route.audio.find(item => item.node.srcObject != null && item.node.srcObject === runtime?.getOutputStream());
    const inputDeviceId = inputId(runtime), outputDeviceId = output?.node?.sinkId || null;
    const routed = Boolean(ours && route.ready && inputDeviceId === route.inputId && outputDeviceId === route.outputId);
    const microphoneMuted = attempt ? attempt.scope.get(module[profile.microphoneMuted]) : null;
    const activity = attempt ? attempt.scope.get(module[profile.activity]) : 'idle';
    if (ours && activity === 'speaking') route.awaitingReply = false;
    const thinking = activity === 'thinking' || (ours && (route.awaitingReply || route.runningTurns.size > 0));
    const error = route?.error || null;
    return { active, owned: ours, nativeConnected: phase === 'active', connected: phase === 'active' && routed,
      state: !active ? 'ended' : phase === 'stopping' || (ours && route.ready && !routed) ? 'disconnected' : phase !== 'active' ? 'connecting' : microphoneMuted ? 'muted' : activity === 'speaking' ? 'speaking' : thinking ? 'thinking' : 'listening',
      connectionState: phase, microphoneMuted, conversationId: attempt?.locator.conversationId || null,
      hostId: attempt?.locator.hostId || null, voiceSessionId: ours ? route.sessionId : active ? `external:${runtime?.options?.realtimeSessionId || service.startRequestId}` : null,
      inputDeviceId, outputDeviceId, error,
      ...(routed ? { transcript: { sequence: route.captionSequence,
        entries: route.captions.map(entry => ({ ...entry })) } } : {}) };
  };
  const restoreProperty = (object, name, descriptor, installed) => {
    if (object[name] !== installed) return;
    if (descriptor) Object.defineProperty(object, name, descriptor); else delete object[name];
  };
  const restoreHooks = route => {
    if (route.hooksRestored) return;
    route.hooksRestored = true;
    clearTimeout(route.timer);
    for (const restore of route.restore.reverse()) restore();
  };
  const releaseActivity = route => {
    route.restoreActivity?.();
    route.restoreActivity = null;
    route.awaitingReply = false;
    route.runningTurns.clear();
    route.captions.length = 0;
    route.captionSequence = 0;
  };
  const observeTranscript = (route, event) => {
    const done = event.method === 'thread/realtime/transcript/done';
    if (!done && event.method !== 'thread/realtime/transcript/delta') return;
    const { role } = event.params;
    const value = done ? event.params.text : event.params.delta;
    if (!['user', 'assistant'].includes(role) || typeof value !== 'string') return;
    const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (!clean && !done) return;
    const previous = route.captions.findLast(entry => entry.role === role);
    if (done && previous?.final && previous.role === role && previous.text === Array.from(clean).slice(-512).join('')) return;
    let entry = previous;
    if (!entry || entry.role !== role || entry.final) {
      if (!clean.trim()) return;
      entry = { role, text: '', final: false };
      route.captions.push(entry);
      if (route.captions.length > 2) route.captions.shift();
    }
    // Complete snapshots recover dropped polls and correct provisional text.
    entry.text = Array.from(done ? clean : entry.text + clean).slice(-512).join('');
    entry.final = done;
    route.captionSequence++;
  };
  const observeActivity = route => {
    const attempt = route.attempt, options = attempt?.runtime?.options;
    if (!options || typeof options.onNotification !== 'function' || route.restoreActivity) return;
    const descriptor = Object.getOwnPropertyDescriptor(options, 'onNotification');
    const original = options.onNotification;
    const observer = function (event) {
      // Observe only this native attempt; captions are bounded, in-memory display data.
      if (service.currentAttempt === attempt && event?.params?.threadId === attempt.locator.conversationId) {
        const params = event.params;
        observeTranscript(route, event);
        if (event.method === 'turn/started' && params.turn?.id) route.runningTurns.add(params.turn.id);
        if (event.method === 'turn/completed' && params.turn?.id) route.runningTurns.delete(params.turn.id);
        if (event.method === 'thread/realtime/transcript/done') {
          if (params.role === 'user') route.awaitingReply = true;
          if (params.role === 'assistant') route.awaitingReply = false;
        }
      }
      return original.apply(this, arguments);
    };
    Object.defineProperty(options, 'onNotification', { configurable: true, writable: true, value: observer });
    route.restoreActivity = () => restoreProperty(options, 'onNotification', descriptor, observer);
  };
  const releaseAudio = (route, successful) => {
    for (const item of route.audio) {
      delete item.node.muted;
      // On failure keep the owned stream silent until Codex disposes it.
      item.muted.set.call(item.node, !successful && item.node.srcObject === route.attempt?.runtime?.getOutputStream() ? true : item.desiredMuted);
    }
  };
  const stopOwned = async route => {
    if (route.attempt && service.currentAttempt === route.attempt) {
      // cancelStart also handles attempts still preparing, before conversationId
      // and the active phase are installed. Stop must await server cleanup.
      if (route.attempt.scope.get(module[profile.phase]) !== 'active') service.cancelStart(route.attempt.scope);
      else await service.stop(route.attempt.scope, route.attempt.locator.conversationId);
      if (service.currentAttempt === route.attempt) throw new Error('Codex 未确认语音已结束，请在电脑端检查。');
    }
  };
  if (request.op === 'read') return snapshot();
  if (request.op === 'prepare') {
    if (service.currentAttempt || globalThis[key]) throw new Error('Codex 已有语音会话或正在连接，请先结束后重试。');
    const devices = await navigator.mediaDevices.enumerateDevices();
    const device = (kind, name) => {
      const matches = devices.filter(item => item.kind === kind && item.label === name?.trim());
      if (matches.length !== 1 || !matches[0].deviceId) throw new Error(`Codex 无法唯一匹配${kind === 'audioinput' ? '麦克风' : '回答音频'}设备：${name || '未选择'}。`);
      return matches[0].deviceId;
    };
    const route = { token: request.routeToken, sessionId: request.routeToken, inputId: device('audioinput', request.inputCaptureName), outputId: device('audiooutput', request.outputDeviceName),
      attempt: null, ready: false, audio: [], restore: [], error: null,
      awaitingReply: false, runningTurns: new Set(), restoreActivity: null,
      captions: [], captionSequence: 0 };
    globalThis[key] = route;
    try {
      const media = navigator.mediaDevices, descriptor = Object.getOwnPropertyDescriptor(media, 'getUserMedia'), original = media.getUserMedia;
      const getUserMedia = function (constraints) {
        return original.call(this, constraints?.audio ? { ...constraints, audio: { ...(constraints.audio === true ? {} : constraints.audio), deviceId: { exact: route.inputId } } } : constraints);
      };
      Object.defineProperty(media, 'getUserMedia', { configurable: true, writable: true, value: getUserMedia });
      route.restore.push(() => restoreProperty(media, 'getUserMedia', descriptor, getUserMedia));
      const createDescriptor = Object.getOwnPropertyDescriptor(document, 'createElement'), create = document.createElement;
      const createElement = function (tag, ...args) {
        const node = create.call(this, tag, ...args);
        if (String(tag).toLowerCase() === 'audio') {
          const muted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
          const item = { node, muted, desiredMuted: node.muted };
          route.audio.push(item);
          Object.defineProperty(node, 'muted', { configurable: true, get: () => muted.get.call(node), set: value => { item.desiredMuted = Boolean(value); muted.set.call(node, true); } });
          muted.set.call(node, true);
        }
        return node;
      };
      Object.defineProperty(document, 'createElement', { configurable: true, writable: true, value: createElement });
      route.restore.push(() => restoreProperty(document, 'createElement', createDescriptor, createElement));
      const startDescriptor = Object.getOwnPropertyDescriptor(service, 'start'), start = service.start;
      const wrappedStart = function (scope, options) {
        const match = options?.conversationId === request.target.taskId && options?.hostId === request.target.hostId;
        // The UI may prepare the microphone before calling start; getUserMedia
        // above covers that path. The preference covers native refreshes too.
        const previousPreference = this.microphonePreference;
        if (match) this.microphonePreference = { selectedDeviceId: route.inputId };
        let result;
        try { result = start.call(this, scope, options); }
        finally { if (match) this.microphonePreference = previousPreference; }
        if (match && matching(this.currentAttempt)) {
          route.attempt = this.currentAttempt;
          observeActivity(route);
        }
        Promise.resolve(result).catch(error => { if (match) route.error = String(error.message || error); });
        return result;
      };
      Object.defineProperty(service, 'start', { configurable: true, writable: true, value: wrappedStart });
      route.restore.push(() => restoreProperty(service, 'start', startDescriptor, wrappedStart));
      route.timer = setTimeout(() => {
        // A lost bridge must not leave global microphone/audio hooks installed.
        restoreHooks(route);
        releaseActivity(route);
        void stopOwned(route).catch(() => {}).finally(() => { releaseAudio(route, false); if (globalThis[key] === route) delete globalThis[key]; });
      }, 22000);
      return snapshot();
    } catch (error) {
      restoreHooks(route); releaseActivity(route); releaseAudio(route, false); delete globalThis[key]; throw error;
    }
  }
  const route = owned();
  if (!route) throw new Error('Codex 语音控制权已失效，请重新连接。');
  if (request.op === 'click') {
    const buttons = findControls(document, 'Start voice chat');
    if (buttons.length !== 1) throw new Error('当前任务没有唯一可用的“开启语音聊天”按钮。');
    buttons[0].click(); return snapshot();
  }
  if (request.op === 'cleanup') {
    restoreHooks(route);
    releaseActivity(route);
    try { if (request.stop === true) await stopOwned(route); }
    finally { releaseAudio(route, false); if (globalThis[key] === route) delete globalThis[key]; }
    return snapshot();
  }
  if (!route.attempt || service.currentAttempt !== route.attempt || !matching(route.attempt)) throw new Error('Codex 语音会话已变化，已停止控制。');
  if (request.op === 'route') {
    const runtime = route.attempt.runtime;
    if (route.attempt.scope.get(module[profile.phase]) !== 'active') return snapshot();
    if (inputId(runtime) !== route.inputId) {
      await runtime.refreshMicrophoneInput({ selectedDeviceId: route.inputId });
      if (inputId(runtime) !== route.inputId) throw new Error('Codex 未确认 ESP32 麦克风输入设备。');
    }
    const output = route.audio.filter(item => item.node.srcObject != null && item.node.srcObject === runtime.getOutputStream());
    if (!output.length) return snapshot(); // ontrack may follow the active event.
    if (output.length !== 1 || typeof output[0].node.setSinkId !== 'function') throw new Error('Codex 回答音频路由不可用。');
    await output[0].node.setSinkId(route.outputId);
    if (service.currentAttempt !== route.attempt || output[0].node.sinkId !== route.outputId) throw new Error('Codex 未确认回答音频输出设备。');
    route.ready = true; restoreHooks(route); releaseAudio(route, true); return snapshot();
  }
  if (request.op === 'mute') {
    service.applyRealtimeMicrophoneMuteState(route.attempt.scope, request.muted === true); return snapshot();
  }
  if (request.op === 'stop') {
    if (request.voiceSessionId !== route.sessionId) throw new Error('Refusing to end a different Codex voice session.');
    await stopOwned(route); releaseActivity(route); return snapshot();
  }
  throw new Error('Unsupported native voice operation.');
}

// Main-process coordinator. A task composer launches voice in another renderer
// (normally avatar-overlay). Keep the task window and actual voice owner distinct.
async function startNativeVoice({ surfaces, taskWindow, target, routeToken, route, call, selectTask, wait, now = Date.now, timeoutMs = 18000 }) {
  const prepared = [];
  let voiceWindow = null, last = null;
  try {
    for (const window of surfaces) {
      const state = await call(window, 'read');
      if (state.active) throw new Error('Codex 已有语音会话，请先结束后重试。');
    }
    for (const window of surfaces) {
      await call(window, 'prepare', { ...route, target, routeToken }); prepared.push(window);
    }
    const selected = await selectTask(taskWindow);
    if (selected?.taskId !== target.taskId || selected.hostId !== target.hostId) throw new Error('Codex 当前任务已变化，请重新连接。');
    await call(taskWindow, 'click');
    const deadline = now() + timeoutMs;
    do {
      for (const window of prepared) {
        const state = await call(window, 'read');
        if (state.error) throw new Error(`Codex 语音启动失败：${state.error}`);
        if (!state.active) continue;
        if (!state.owned || state.conversationId !== target.taskId || state.hostId !== target.hostId) throw new Error('Codex 启动了不同的语音会话，请重新选择任务。');
        if (voiceWindow && voiceWindow !== window) throw new Error('Codex 语音会话窗口不唯一。');
        voiceWindow = window; last = state;
        if (state.nativeConnected) {
          const routed = await call(window, 'route');
          if (routed.connected) {
            for (const other of prepared) if (other !== voiceWindow) await call(other, 'cleanup');
            return { window: voiceWindow, snapshot: routed };
          }
        }
      }
      await wait(100);
    } while (now() < deadline);
    throw new Error(last?.nativeConnected ? 'Codex 语音已连接，但尚未确认 ESP32 音频输入/输出路由。' : last ? 'Codex 语音界面已打开，但服务尚未确认连接，请检查电脑端提示。' : 'Codex 未建立所选任务的原生语音会话，请检查电脑端提示。');
  } catch (error) {
    const cleanup = await Promise.allSettled(prepared.map(window => call(window, 'cleanup', { stop: true })));
    if (cleanup.some(result => result.status === 'rejected')) error.message += '；部分清理未完成，请在电脑端结束语音。';
    throw error;
  }
}

module.exports = { nativeVoiceRenderer, startNativeVoice };
