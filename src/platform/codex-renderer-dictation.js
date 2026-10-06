'use strict';

const { randomUUID } = require('node:crypto');
const { createRendererConnection } = require('./codex-renderer-connection');
const buildProfile = require('./codex-dictation-renderer-profile');

function selectedTask(target = null) {
  const root = document.getElementById('root');
  const container = root?.[Object.keys(root).find(key => key.startsWith('__reactContainer'))];
  const queue = [container?.stateNode?.current || container], seen = new Set(), composerTargets = new Map(), activeTargets = new Map(), drafts = new Map();
  while (queue.length && seen.size < 30000) {
    const fiber = queue.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    queue.push(fiber.sibling);
    // A detached composer can remain in the main React tree through a portal.
    // Its selected task cannot establish the main document's current task.
    const portalContainer = fiber.tag === 4 ? fiber.stateNode?.containerInfo : null;
    const portalDocument = portalContainer?.nodeType === 9 ? portalContainer : portalContainer?.ownerDocument;
    if ((portalDocument && portalDocument !== document) ||
        (fiber.tag === 22 && fiber.memoizedProps?.mode === 'hidden')) continue;
    const props = fiber.memoizedProps;
    if (props?.isActive === true && typeof props.conversationId === 'string' && typeof props.hostId === 'string')
      activeTargets.set(`${props.hostId}:${props.conversationId}`, { taskId: props.conversationId, hostId: props.hostId });
    if (props && Object.prototype.hasOwnProperty.call(props, 'onRealtimeStart')) {
      let hostId = props.executionTargetHostId || props.hostId, taskId = null;
      // Owl keeps the original draft key after it binds a real conversation.
      // The nearest conversation owner takes precedence over that outer key.
      for (let parent = fiber, depth = 0; parent && depth < 100; parent = parent.return, depth++) {
        const owner = parent.memoizedProps;
        taskId ||= typeof owner?.conversationId === 'string' ? owner.conversationId : null;
        hostId ||= owner?.executionTargetHostId || owner?.hostId;
        if (typeof taskId === 'string' && typeof hostId === 'string') {
          composerTargets.set(`${hostId}:${taskId}`, { taskId, hostId });
          break;
        }
        const key = typeof parent.key === 'string' ? parent.key : '';
        if (!taskId && key.startsWith('client-new-thread:') && /^[0-9a-f-]{36}$/i.test(key.slice('client-new-thread:'.length))) {
          const draftId = key.slice('client-new-thread:'.length);
          drafts.set(draftId, { taskId: null, hostId: 'local', draftId });
          break;
        }
      }
    }
    queue.push(fiber.child);
  }
  if (target?.taskId != null) return composerTargets.get(`${target.hostId}:${target.taskId}`) || activeTargets.get(`${target.hostId}:${target.taskId}`) || null;
  if (target && drafts.size === 1) return [...drafts.values()][0];
  return composerTargets.size === 1 ? [...composerTargets.values()][0] : drafts.size === 1 ? [...drafts.values()][0]
    : activeTargets.size === 1 ? [...activeTargets.values()][0] : null;
}

// Runs in the selected task renderer. It owns only the dictation stream whose
// getUserMedia request is intercepted by this request token.
async function dictationRenderer(request) {
  const key = '__codexRemoteDictationRouteV1';
  const cancelledKey = '__codexRemoteDictationCancelledV1';
  const cancelledRoutes = globalThis[cancelledKey] ||= new Map();
  const markCancelled = token => { cancelledRoutes.set(token, Date.now() + 30000); const timer = setTimeout(() => { if (cancelledRoutes.get(token) <= Date.now()) cancelledRoutes.delete(token); }, 30000); timer.unref?.(); };
  const isCancelled = token => (cancelledRoutes.get(token) || 0) > Date.now();
  const route = globalThis[key];
  const matchingTask = () => {
    const task = (() => {
      const root = document.getElementById('root');
      const container = root?.[Object.keys(root).find(name => name.startsWith('__reactContainer'))];
      const queue = [container?.stateNode?.current || container], seen = new Set(), composer = new Map(), active = new Map(), drafts = new Map();
      while (queue.length && seen.size < 30000) {
        const fiber = queue.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
        const props = fiber.memoizedProps;
        if (props?.isActive === true && typeof props.conversationId === 'string' && typeof props.hostId === 'string') active.set(`${props.hostId}:${props.conversationId}`, { taskId: props.conversationId, hostId: props.hostId });
        if (props && Object.prototype.hasOwnProperty.call(props, 'onRealtimeStart') && typeof props.conversationId === 'string' && typeof props.executionTargetHostId === 'string') composer.set(`${props.executionTargetHostId}:${props.conversationId}`, { taskId: props.conversationId, hostId: props.executionTargetHostId });
        if (props && Object.prototype.hasOwnProperty.call(props, 'onRealtimeStart') && props.conversationId == null) {
          for (let parent = fiber.return, depth = 0; parent && depth < 10; parent = parent.return, depth++) {
            const key = typeof parent.key === 'string' ? parent.key : '';
            if (key.startsWith('client-new-thread:') && /^[0-9a-f-]{36}$/i.test(key.slice('client-new-thread:'.length))) {
              const draftId = key.slice('client-new-thread:'.length);
              drafts.set(draftId, { taskId: null, hostId: 'local', draftId });
              break;
            }
          }
        }
        queue.push(fiber.sibling, fiber.child);
      }
      if (request.target.taskId != null) return composer.get(`${request.target.hostId}:${request.target.taskId}`)
        || active.get(`${request.target.hostId}:${request.target.taskId}`) || null;
      return drafts.size === 1 ? [...drafts.values()][0] : null;
    })();
    return task?.taskId === request.target.taskId && task?.hostId === request.target.hostId
      && (request.target.taskId != null || Boolean(request.draftId && task.draftId === request.draftId));
  };
  const owned = () => globalThis[key]?.token === request.routeToken && globalThis[key]?.requestId === request.requestId ? globalThis[key] : null;
  const dictationControllers = () => {
    const root = document.getElementById('root');
    const container = root?.[Object.keys(root).find(name => name.startsWith('__reactContainer'))];
    const queue = [container?.stateNode?.current || container], seen = new Set(), matches = [];
    while (queue.length && seen.size < 30000) {
      const fiber = queue.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
      const props = fiber.memoizedProps;
      if (props && typeof props.stopDictation === 'function'
        && (typeof props.isDictating === 'boolean' || props.waveformCanvasRef != null)) matches.push({ fiber, props });
      queue.push(fiber.sibling, fiber.child);
    }
    return matches;
  };
  const nodeDocument = node => {
    if (!node) return null;
    if (node.nodeType === 9) return node;
    if (node.ownerDocument) return node.ownerDocument;
    if (node.host?.ownerDocument) return node.host.ownerDocument;
    return null;
  };
  const ownerDocumentForFiber = fiber => {
    let portalDocument = null, hostDocument = null, rootDocument = null;
    for (let current = fiber; current; current = current.return) {
      // HostPortal fibers retain the actual container, which is more reliable
      // than a parent host node when a subtree is rendered into another doc.
      if (current.tag === 4 && !portalDocument) portalDocument = nodeDocument(current.stateNode?.containerInfo);
      if ([5, 6, 26, 27].includes(current.tag) && !hostDocument) hostDocument = nodeDocument(current.stateNode);
      if (current.tag === 3 && !rootDocument) rootDocument = nodeDocument(current.stateNode?.containerInfo);
    }
    return portalDocument || hostDocument || rootDocument;
  };
  const sameDocumentControllers = () => dictationControllers().filter(owner => ownerDocumentForFiber(owner.fiber) === document);
  // Owl keeps dictation controllers mounted for hidden composers as well. The
  // hidden MRc returns null, but its props still contain stopDictation. Route
  // only through the single controller whose composer is actually visible.
  const visibleDictationControllers = () => sameDocumentControllers().filter(owner => owner.props.isVisible === true && typeof owner.props.isDictating === 'boolean');
  const isSameDictationOwner = (route, owner) => {
    if (!owner || !route) return false;
    const routeFibers = new Set([route.ownerFiber, route.ownerAlternate].filter(Boolean));
    return routeFibers.has(owner.fiber) || Boolean(owner.fiber.alternate && routeFibers.has(owner.fiber.alternate));
  };
  const findOwnedDictation = route => {
    const local = sameDocumentControllers();
    const pinned = local.filter(owner => isSameDictationOwner(route, owner));
    if (pinned.length === 1) return pinned[0].props;
    // The idle microphone button unmounts when Owl shows its voice footer.
    // The native stop callback remains stable across this UI replacement;
    // the idle button does not receive the footer's waveform ref. A different
    // composer or child-window callback must never take over the recording.
    const footer = local.filter(({ props }) => route?.stopDictation
      && props.stopDictation === route.stopDictation && props.waveformCanvasRef != null);
    return footer.length === 1 ? footer[0].props : null;
  };
  const isRecording = (r, dictation) => Boolean(dictation && (dictation.isDictating === true
    || (dictation.isDictating === undefined && !dictation.isTranscribing && r?.captureReady
      && r.stream?.getAudioTracks?.()[0]?.readyState === 'live')));
  const snapshot = () => {
    const r = owned(), track = r?.stream?.getAudioTracks?.()[0], dictation = findOwnedDictation(r);
    const settings = track?.getSettings?.() || {};
    const rawOwners = dictationControllers(), localOwners = sameDocumentControllers(), visibleOwners = localOwners.filter(owner => owner.props.isVisible === true);
    return { installed: Boolean(r), captureReady: Boolean(r?.captureReady), trackReadyState: track?.readyState || null,
      inputDeviceMatches: Boolean(r?.inputId && settings.deviceId === r.inputId),
      recordingConfirmed: Boolean(r?.captureReady && track?.readyState === 'live' && settings.deviceId === r.inputId && isRecording(r, dictation)),
      isDictating: isRecording(r, dictation), isTranscribing: Boolean(dictation?.isTranscribing),
      ownerAvailable: Boolean(dictation && typeof dictation.stopDictation === 'function'), ownerVisible: Boolean(dictation?.isVisible === true),
      rawControllerCount: rawOwners.length, sameDocumentControllerCount: localOwners.length,
      visibleControllerCount: visibleOwners.length, hiddenControllerCount: localOwners.filter(owner => owner.props.isVisible === false).length,
      unknownVisibilityCount: localOwners.filter(owner => typeof owner.props.isVisible !== 'boolean').length,
      visibleBusyCount: visibleOwners.filter(owner => owner.props.isDictating || owner.props.isTranscribing).length,
      taskMatches: matchingTask() };
  };
  const restore = r => {
    if (!r || r.restored) return;
    r.restored = true; clearTimeout(r.timer);
    if (r.mediaDevices?.getUserMedia === r.wrapper) {
      if (r.descriptor) Object.defineProperty(r.mediaDevices, 'getUserMedia', r.descriptor);
      else delete r.mediaDevices.getUserMedia;
    }
    // The acquired stream is owned by Codex after start; do not stop it here.
  };
  if (request.op === 'prepare') {
    if (isCancelled(request.routeToken)) throw new Error('本次 Codex 听写已取消。');
    if (!matchingTask()) throw new Error('Codex 当前任务已变化，拒绝路由听写音频。');
    if (owned()) throw new Error('本次 Codex 听写路由已准备。');
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (isCancelled(request.routeToken)) throw new Error('本次 Codex 听写已取消。');
    if (!matchingTask()) throw new Error('Codex 当前任务已变化，拒绝路由听写音频。');
    const requestedCapture = String(request.inputCaptureName || '').trim().toLowerCase();
    const captures = devices.filter(device => device.kind === 'audioinput' && device.label.trim().toLowerCase() === requestedCapture && device.deviceId);
    if (captures.length !== 1) throw new Error('找不到唯一匹配的 ESP32 虚拟麦克风输入。');
    const mediaDevices = navigator.mediaDevices, descriptor = Object.getOwnPropertyDescriptor(mediaDevices, 'getUserMedia');
    const original = mediaDevices.getUserMedia;
    if (typeof original !== 'function') throw new Error('Codex 听写麦克风接口不可用。');
    const owners = dictationControllers(), localOwners = sameDocumentControllers();
    const visibleOwners = localOwners.filter(owner => owner.props.isVisible === true);
    if (visibleOwners.length !== 1) return { installed: false, reason: 'owner', rawControllerCount: owners.length,
      sameDocumentControllerCount: localOwners.length, visibleControllerCount: visibleOwners.length,
      hiddenControllerCount: localOwners.filter(owner => owner.props.isVisible === false).length,
      unknownVisibilityCount: localOwners.filter(owner => typeof owner.props.isVisible !== 'boolean').length,
      visibleBusyCount: visibleOwners.filter(owner => owner.props.isDictating || owner.props.isTranscribing).length };
    const owner = visibleOwners[0], dictation = owner.props;
    if (dictation.isDictating || dictation.isTranscribing) return { installed: false, reason: 'busy', rawControllerCount: owners.length,
      sameDocumentControllerCount: localOwners.length, visibleControllerCount: visibleOwners.length,
      hiddenControllerCount: localOwners.filter(candidate => candidate.props.isVisible === false).length,
      unknownVisibilityCount: localOwners.filter(candidate => typeof candidate.props.isVisible !== 'boolean').length,
      visibleBusyCount: 1 };
    const r = { token: request.routeToken, requestId: request.requestId, inputId: captures[0].deviceId, mediaDevices, descriptor,
      ownerFiber: owner.fiber, ownerAlternate: owner.fiber.alternate || null,
      stopDictation: dictation.stopDictation,
      stream: null, captureReady: false, restored: false, abandoned: false };
    const wrapper = function (constraints = {}) {
      if (isCancelled(request.routeToken)) return Promise.reject(new Error('本次 Codex 听写已取消。'));
      if (!matchingTask()) return Promise.reject(new Error('Codex 任务已变化，拒绝回退到其他麦克风。'));
      if (!constraints?.audio) return original.call(this, constraints);
      if (r.restored || r.captureReady) return Promise.reject(new Error('本次 Codex 听写麦克风请求已结束。'));
      const audio = constraints.audio === true ? {} : { ...constraints.audio };
      audio.deviceId = { exact: r.inputId };
      return Promise.resolve(original.call(this, { ...constraints, audio })).then(stream => {
        if (r.abandoned || owned() !== r || !matchingTask()) {
          stream.getTracks?.().forEach(item => item.stop());
          throw new Error('本次 Codex 听写已取消或任务已变化。');
        }
        const track = stream.getAudioTracks?.()[0], actualId = track?.getSettings?.().deviceId;
        if (!track || !actualId || actualId !== r.inputId) {
          stream.getTracks?.().forEach(item => item.stop());
          throw new Error('Codex 未确认使用 ESP32 虚拟麦克风。');
        }
        r.stream = stream; r.captureReady = true; restore(r);
        return stream;
      });
    };
    r.wrapper = wrapper;
    Object.defineProperty(mediaDevices, 'getUserMedia', { configurable: true, writable: true, value: wrapper });
    globalThis[key] = r;
    r.timer = setTimeout(() => { r.abandoned = true; restore(r); if (globalThis[key] === r) delete globalThis[key]; }, 12000);
    return { installed: true, inputCaptureName: captures[0].label, rawControllerCount: owners.length,
      sameDocumentControllerCount: localOwners.length, visibleControllerCount: visibleOwners.length,
      hiddenControllerCount: localOwners.filter(candidate => candidate.props.isVisible === false).length,
      unknownVisibilityCount: localOwners.filter(candidate => typeof candidate.props.isVisible !== 'boolean').length };
  }
  if (request.op === 'read') return snapshot();
  if (request.op === 'diagnose') {
    const candidates = dictationControllers().map(({ fiber, props }) => ({
      hasStopDictation: true,
      sameDocument: ownerDocumentForFiber(fiber) === document,
      isVisibleType: typeof props.isVisible,
      isVisible: typeof props.isVisible === 'boolean' ? props.isVisible : null,
      isDictating: props.isDictating,
      isTranscribingType: typeof props.isTranscribing,
      isTranscribing: Boolean(props.isTranscribing),
      busy: Boolean(props.isDictating || props.isTranscribing),
      keys: Object.keys(props).filter(key => /dictat|record|transcrib|microphone|visible/i.test(key)).slice(0, 24)
    }));
    const devices = await navigator.mediaDevices.enumerateDevices();
    const captureLabels = devices.filter(device => device.kind === 'audioinput' && device.label).map(device => device.label).slice(0, 20);
    const visibleCount = candidates.filter(candidate => candidate.sameDocument && candidate.isVisible === true).length;
    return { taskMatches: matchingTask(), routeInstalled: false, rawControllerCount: candidates.length,
      sameDocumentControllerCount: candidates.filter(candidate => candidate.sameDocument).length,
      visibleControllerCount: visibleCount, hiddenControllerCount: candidates.filter(candidate => candidate.sameDocument && candidate.isVisible === false).length,
      unknownVisibilityCount: candidates.filter(candidate => candidate.sameDocument && candidate.isVisibleType !== 'boolean').length,
      visibleBusyCount: candidates.filter(candidate => candidate.sameDocument && candidate.isVisible === true && candidate.busy).length,
      candidates: candidates.slice(0, 8), captureLabels };
  }
  if (request.op === 'submit' || request.op === 'cancel') {
    if (!matchingTask()) throw new Error('Codex 当前任务已变化，拒绝操作听写。');
    const r = owned(), state = snapshot(), dictation = findOwnedDictation(r);
    if (!r || !state.recordingConfirmed || !dictation)
      throw new Error('没有找到由本次 ESP32 音频路由拥有的活动听写录音。');
    await dictation.stopDictation(request.op === 'submit' ? 'send' : 'abort');
    restore(r);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const current = snapshot();
      if (!current.isDictating && (request.op === 'cancel' || current.isTranscribing || !r.stream?.getAudioTracks?.()[0] || r.stream.getAudioTracks()[0].readyState !== 'live'))
        return { recordingStopped: true, isTranscribing: current.isTranscribing };
    }
    throw new Error('Codex 未确认听写录音已停止。');
  }
  if (request.op === 'cleanup') {
    markCancelled(request.routeToken);
    const r = owned();
    let discarded = false;
    let failure = null;
    try {
      if (r && request.cancel && r.captureReady && matchingTask()) {
        const state = snapshot(), dictation = findOwnedDictation(r);
        if (state.recordingConfirmed && dictation) {
          await dictation.stopDictation('abort');
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
            if (!isRecording(r, findOwnedDictation(r))) { discarded = true; break; }
          }
          if (!discarded) throw new Error('Codex 未确认取消听写录音。');
        }
      }
    } catch (error) { failure = error; }
    finally {
      if (r && request.cancel) {
        r.abandoned = true;
        for (const track of r.stream?.getTracks?.() || []) { try { track.stop(); } catch (_) {} }
      }
      restore(r);
    }
    if (r) delete globalThis[key];
    if (failure) throw failure;
    return { cleaned: true, discarded };
  }
  throw new Error('Unsupported Codex dictation renderer operation.');
}

const eligibleUrl = url => /^app:\/\/-\/(?:index|detached-window)\.html(?:\?|$)/.test(url || '') && !/global-dictation/.test(url || '');

function visibleDictationTask() {
  const root = document.getElementById('root');
  const container = root?.[Object.keys(root).find(key => key.startsWith('__reactContainer'))];
  const queue = [container?.stateNode?.current || container], seen = new Set(), owners = [];
  while (queue.length && seen.size < 30000) {
    const fiber = queue.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    const props = fiber.memoizedProps;
    if (props?.isVisible === true && props.isDictating === false && typeof props.stopDictation === 'function') {
      let taskId = null, hostId = null, draftId = null, ownerDocument = null, foreign = false;
      for (let parent = fiber, depth = 0; parent && depth < 100; parent = parent.return, depth++) {
        const node = parent.stateNode, p = parent.memoizedProps;
        if (!ownerDocument && node?.nodeType === 1) ownerDocument = node.ownerDocument;
        if (parent.tag === 4) {
          const portal = node?.containerInfo;
          const portalDocument = portal?.nodeType === 9 ? portal : portal?.ownerDocument;
          if (portalDocument && portalDocument !== document) foreign = true;
        }
        hostId ||= p?.executionTargetHostId || p?.hostId;
        if (!taskId && !draftId) {
          if (typeof p?.conversationId === 'string') taskId = p.conversationId;
          else if (typeof parent.key === 'string' && /^client-new-thread:[0-9a-f-]{36}$/i.test(parent.key))
            draftId = parent.key.slice('client-new-thread:'.length);
        }
      }
      if (!foreign && ownerDocument === document) owners.push({ taskId, hostId, draftId });
    }
    queue.push(fiber.child, fiber.sibling);
  }
  return owners.length === 1 ? owners[0] : null;
}

async function isTaskSelected(connection, target) {
  if (!target?.taskId || target.hostId !== 'local' || !connection || connection.closed) return false;
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const windows = (await connection.windows()).filter(window => !window.isDestroyed()
          && /^app:\/\/-\/index\.html(?:\?|$)/.test(window.webContents.getURL())
          && !/avatar-overlay|global-dictation/.test(window.webContents.getURL()));
        if (windows.length !== 1) return false;
        const selected = await windows[0].webContents.executeJavaScript(
          `document.visibilityState === 'visible' ? (${visibleDictationTask.toString()})() : null`);
        return selected?.taskId === target.taskId && selected.hostId === target.hostId;
      })(),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 200); })
    ]);
  } catch (_) { return false; }
  finally { clearTimeout(timer); }
}

class CodexRendererDictation {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.connectionFactory = options.connectionFactory || (() => createRendererConnection());
    this.findProcess = options.findProcess || (() => require('../core/codex-micro-slots').findCodexProcess());
    this.readRuntime = options.readRuntime || (target => require('./codex-runtime-info').readCodexRuntime(target));
    this.getContext = options.getContext || (() => null);
    this.connection = null; this.windows = []; this.profile = null; this.target = null;
    this.context = null; this.requestId = null; this.routeToken = null; this.ownerWindow = null; this.rendererDraftId = null;
    this.generation = 0; this.cancelled = false; this.preparePromise = null; this.closed = false;
    this.signal = null; this.abortHandler = null; this.abortError = null; this.lastState = null;
  }

  rememberState(stage, state = {}) {
    const keys = ['installed', 'captureReady', 'trackReadyState', 'inputDeviceMatches', 'recordingConfirmed', 'isDictating', 'isTranscribing',
      'ownerAvailable', 'ownerVisible', 'rawControllerCount', 'sameDocumentControllerCount', 'visibleControllerCount',
      'hiddenControllerCount', 'unknownVisibilityCount', 'visibleBusyCount', 'taskMatches', 'aborted', 'readFailed'];
    const safe = { stage };
    for (const key of keys) if (state[key] !== undefined) safe[key] = state[key];
    this.lastState = safe;
    return safe;
  }

  contextMatches() {
    const current = this.getContext();
    return Boolean(current && this.context && current.taskId === this.context.taskId && current.hostId === this.context.hostId
      && current.streamId === this.context.streamId && current.generation === this.context.generation
      && current.draftToken === this.context.draftToken);
  }

  async call(window, op, cancel = true) {
    if (this.closed || !window || window.isDestroyed()) throw new Error('Codex 听写窗口已关闭。');
    if (op !== 'cleanup' && !this.contextMatches()) throw new Error('Codex 听写任务或草稿已变化。');
    const request = { op, target: { taskId: this.context.taskId, hostId: this.context.hostId }, draftId: this.rendererDraftId,
      routeToken: this.routeToken, requestId: this.requestId,
      inputCaptureName: this.inputCaptureName, cancel: Boolean(cancel) };
    return window.webContents.executeJavaScript(`(${dictationRenderer.toString()})(${JSON.stringify(request)})`);
  }

  async prepare({ target, requestId, inputCaptureName, signal } = {}) {
    if (this.platform !== 'win32') return { supported: false };
    if (!requestId || !inputCaptureName) throw new Error('Codex 听写请求或 ESP32 capture 名称无效。');
    if (signal?.aborted) throw new Error('本次 Codex 听写已取消。');
    this.cancelled = false; this.closed = false;
    this.lastState = null;
    this.signal = signal || null;
    if (signal) {
      this.abortError = null;
      this.abortHandler = () => { void this.cancel().catch(error => { this.abortError = error; }); };
      signal.addEventListener('abort', this.abortHandler, { once: true });
    }
    const generation = this.generation;
    this.preparePromise = (async () => {
      const processTarget = await this.findProcess();
      if (generation !== this.generation || this.cancelled || signal?.aborted) throw new Error('本次 Codex 听写已取消。');
      const runtime = await this.readRuntime(processTarget);
      if (generation !== this.generation || this.cancelled || signal?.aborted) throw new Error('本次 Codex 听写已取消。');
      if (runtime?.name !== 'owl') { this.reset(); return { supported: false }; }
      if (!target || typeof target.hostId !== 'string' || (target.taskId == null && !target.draftToken)) throw new Error('请先在 Codex 建立会话后再使用 ESP32 听写。');
      if (target.taskId != null && typeof target.taskId !== 'string') throw new Error('当前 Codex 听写任务标识无效。');
      this.context = { ...target }; this.requestId = requestId; this.inputCaptureName = inputCaptureName;
      const connection = this.connectionFactory();
      this.connection = connection;
      await connection.open(processTarget);
      if (generation !== this.generation || this.cancelled) { await connection.close(); if (this.connection === connection) this.connection = null; throw new Error('本次 Codex 听写已取消。'); }
      const assets = connection.assets();
      const names = assets.names.filter(name => /^app-initial-[\w-]+\.js$/.test(name));
      if (names.length !== 1) throw new Error('当前 Codex 听写资源结构无法识别。');
      this.profile = buildProfile({ initialName: names[0], initialText: assets.read(names[0]) });
      this.windows = (await connection.windows()).filter(window => eligibleUrl(window.webContents.getURL()));
      if (generation !== this.generation || this.cancelled || signal?.aborted) throw new Error('本次 Codex 听写已取消。');
      const matches = [];
      for (const window of this.windows) {
        if (window.webContents.getURL().includes('avatar-overlay')) continue;
        const selected = await window.webContents.executeJavaScript(`(${selectedTask.toString()})(${JSON.stringify({ taskId: target.taskId ?? null, hostId: target.hostId })})`);
        if (generation !== this.generation || this.cancelled || signal?.aborted) throw new Error('本次 Codex 听写已取消。');
      if (selected?.taskId === (target.taskId ?? null) && selected.hostId === target.hostId
          && (target.taskId != null || typeof selected.draftId === 'string')) matches.push({ window, selected });
      }
      if (generation !== this.generation || this.cancelled) throw new Error('本次 Codex 听写已取消。');
      if (matches.length !== 1) throw new Error(target.taskId == null
        ? '请先在 Codex 建立会话后再使用 ESP32 听写。'
        : '无法唯一匹配本次 Codex 听写任务窗口。');
      this.ownerWindow = matches[0].window; this.rendererDraftId = matches[0].selected.draftId || null;
      this.target = { pid: processTarget.pid, executable: processTarget.executable };
      this.routeToken = randomUUID();
      const prepared = await this.call(this.ownerWindow, 'prepare');
      this.rememberState('prepare', prepared);
      if (!prepared?.installed) throw new Error(prepared?.reason === 'busy'
        ? 'Codex 听写可见任务控制器正忙。'
        : 'Codex 听写没有唯一的同窗口可见任务控制器。');
      if (generation !== this.generation || this.cancelled || signal?.aborted) { await this.cleanupRenderer(true); throw new Error('本次 Codex 听写已取消。'); }
      return { supported: true };
    })().catch(async error => {
      const connection = this.connection;
      let cleanupError = null;
      if (this.ownerWindow && this.routeToken) try { await this.cleanupRenderer(true); } catch (failure) { cleanupError = failure; }
      this.connection = null; this.ownerWindow = null; this.windows = []; this.profile = null;
      this.target = null; this.routeToken = null;
      this.rendererDraftId = null;
      if (connection) try { await connection.close(); } catch (_) {}
      throw cleanupError || this.abortError || error;
    }).finally(() => { this.preparePromise = null; });
    return this.preparePromise;
  }

  async begun() {
    if (!this.ownerWindow) throw new Error('Codex 听写路由尚未准备。');
    const generation = this.generation, deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (generation !== this.generation || this.cancelled || this.signal?.aborted || this.abortError || !this.contextMatches()) {
        this.rememberState('begun_aborted', { ...(this.lastState || {}), aborted: true });
        throw this.abortError || new Error('本次 Codex 听写已取消或任务已变化。');
      }
      let state;
      try { state = await this.call(this.ownerWindow, 'read'); }
      catch (error) { this.rememberState('begun_error', { ...(this.lastState || {}), readFailed: true }); throw error; }
      this.rememberState('begun_waiting', state);
      if (state.recordingConfirmed && state.taskMatches)
        return { recordingConfirmed: true, inputDeviceId: state.inputDeviceId, captureName: this.inputCaptureName };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.rememberState('begun_timeout', this.lastState || {});
    throw new Error('Codex 未确认从 ESP32 虚拟麦克风开始录音。');
  }

  async submit() {
    if (!this.ownerWindow) throw new Error('本次 Codex 听写没有活动路由。');
    const result = await this.call(this.ownerWindow, 'submit');
    return { delivery: 'desktop_runtime', outcome: result.isTranscribing ? 'confirmed' : 'requested', recordingStopped: result.recordingStopped };
  }

  async diagnose() {
    if (this.platform !== 'win32') return { supported: false, reason: 'platform' };
    const processTarget = await this.findProcess();
    const runtime = await this.readRuntime(processTarget);
    if (runtime?.name !== 'owl') return { supported: false, reason: 'runtime' };
    const connection = this.connectionFactory();
    try {
      await connection.open(processTarget);
      const assets = connection.assets();
      const names = assets.names.filter(name => /^app-initial-[\w-]+\.js$/.test(name));
      if (names.length !== 1) throw new Error('当前 Codex 听写资源结构无法识别。');
      const profile = buildProfile({ initialName: names[0], initialText: assets.read(names[0]) });
      const windows = (await connection.windows()).filter(window => eligibleUrl(window.webContents.getURL()));
      const result = [];
      for (const window of windows) {
        if (window.webContents.getURL().includes('avatar-overlay')) continue;
        const selected = await window.webContents.executeJavaScript(`(${selectedTask.toString()})()`);
        if (selected) {
          const state = await window.webContents.executeJavaScript(`(${dictationRenderer.toString()})(${JSON.stringify({ op: 'diagnose', target: selected })})`);
          result.push({ windowId: window.id, task: selected, ...state });
        }
      }
      return { supported: true, profile: { initialName: profile.initialName, sendAction: profile.sendAction }, windows: result };
    } finally { await connection.close(); }
  }

  async cancel() {
    this.cancelled = true; this.generation++;
    const connection = this.connection;
    let result = { discarded: false }, failure = null;
    try {
      if (connection && this.ownerWindow) { this.closed = false; result = await this.cleanupRenderer(true); }
    } catch (error) { failure = error; }
    finally {
      if (connection) try { await connection.close(); } catch (error) { failure ||= error; }
      if (this.connection === connection) this.connection = null;
      this.reset();
    }
    if (failure) throw failure;
    return result || { discarded: false };
  }

  async cleanupRenderer(cancel) {
    if (!this.ownerWindow || !this.routeToken) return;
    return this.call(this.ownerWindow, 'cleanup', cancel);
  }

  reset() {
    const connection = this.connection;
    if (this.signal && this.abortHandler) this.signal.removeEventListener('abort', this.abortHandler);
    this.signal = null; this.abortHandler = null; this.abortError = null;
    this.connection = null; this.windows = []; this.profile = null; this.target = null; this.context = null;
    this.requestId = null; this.routeToken = null; this.ownerWindow = null; this.rendererDraftId = null; this.inputCaptureName = null; this.closed = true;
    if (connection) Promise.resolve(connection.close()).catch(() => {});
  }

  async dispose({ cancel = true } = {}) {
    if (cancel) { await this.cancel(); return; }
    this.generation++; this.cancelled = true;
    try { await this.cleanupRenderer(false); } finally { this.reset(); }
  }
}

module.exports = CodexRendererDictation;
module.exports.dictationRenderer = dictationRenderer;
module.exports.selectedTask = selectedTask;
module.exports.isTaskSelected = isTaskSelected;
module.exports.visibleDictationTask = visibleDictationTask;
module.exports.buildProfile = buildProfile;
