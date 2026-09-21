const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { nativeVoiceRenderer, startNativeVoice } = require('../../src/platform/codex-native-voice');
const RealtimeSession = require('../../src/voice/realtime-session');
const CodexRealtimeRuntime = require('../../src/platform/codex-realtime-runtime');

const target = { taskId: 'task-1', hostId: 'local' };
const route = { inputCaptureName: 'ESP32 microphone', outputDeviceName: 'Codex answers' };
function surface(options = {}) {
  const phases = new Map([['phase', 'inactive'], ['microphoneMuted', false], ['activity', 'listening']]);
  const scope = { get: key => phases.get(key), watch() {} };
  let muteValue = new WeakMap(), inputDevice = options.inputDevice || 'input-1';
  class Media {
    constructor() { this.srcObject = null; this.sinkId = ''; }
    get muted() { return muteValue.get(this) || false; }
    set muted(value) { muteValue.set(this, value); }
    async setSinkId(id) { if (options.sinkFailure) throw new Error('sink rejected'); this.sinkId = id; }
  }
  const document = { getElementById: () => null, createElement: tag => tag === 'audio' ? new Media() : {}, button: { click() {} } };
  const media = { enumerateDevices: async () => [
    { kind: 'audioinput', label: route.inputCaptureName, deviceId: 'input-1' },
    { kind: 'audiooutput', label: route.outputDeviceName, deviceId: 'output-1' }
  ], async getUserMedia(constraints) { media.constraints = constraints; return {}; } };
  const originalCreate = document.createElement, originalGet = media.getUserMedia;
  const service = {
    currentAttempt: null, startRequestId: 1, microphonePreference: { selectedDeviceId: 'previous' }, stops: 0, cancels: 0,
    async start(callScope, settings) {
      this.startPreference = this.microphonePreference;
      const outputStream = {};
      const runtime = {
        options: { realtimeSessionId: 'native-session', onNotification: event => { service.lastNotification = event; } },
        getInputStream: () => ({ getAudioTracks: () => [{ getSettings: () => ({ deviceId: inputDevice }) }] }),
        getOutputStream: () => outputStream,
        async refreshMicrophoneInput(preference) { if (!options.inputFailure) inputDevice = preference.selectedDeviceId; }
      };
      this.currentAttempt = { locator: { conversationId: settings.conversationId, hostId: settings.hostId }, scope: callScope, runtime };
      phases.set('phase', options.starting ? 'starting' : 'active');
      this.audio = document.createElement('audio');
      this.audio.srcObject = outputStream;
      this.audio.muted = false;
      await media.getUserMedia({ audio: true });
    },
    cancelStart() { this.cancels++; this.currentAttempt = null; phases.set('phase', 'inactive'); },
    async stop() { this.stops++; this.currentAttempt = null; phases.set('phase', 'inactive'); },
    applyRealtimeMicrophoneMuteState(_scope, muted) { phases.set('microphoneMuted', muted); }
  };
  const originalStart = service.start;
  const module = { cr: service, fr: 'phase', ur: 'microphoneMuted', mr: 'activity', Lk: 'launch' };
  const timers = new Map(); let timerId = 0;
  const context = vm.createContext({ document, navigator: { mediaDevices: media }, HTMLMediaElement: Media,
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id) });
  const serialized = vm.runInContext(`(${nativeVoiceRenderer.toString()})`, context);
  return { context, phases, scope, service, document, media, timers,
    async call(op, extra = {}) { return serialized({ op, target, routeToken: 'route-1', ...extra }, doc => [doc.button], async () => module); },
    launch: () => service.start(scope, { conversationId: target.taskId, hostId: target.hostId }),
    assertRestored() { assert.equal(document.createElement, originalCreate); assert.equal(media.getUserMedia, originalGet); assert.equal(service.start, originalStart); assert.equal(timers.size, 0); }
  };
}
function setup(options = {}) {
  const main = surface(), overlay = surface(options);
  main.document.button.click = () => { if (!options.noLaunch) void overlay.launch(); };
  let tick = 0;
  const run = extra => startNativeVoice({ surfaces: [main, overlay], taskWindow: main, target, routeToken: 'route-1', route,
    call: (window, op, payload) => window.call(op, payload), selectTask: async () => target,
    now: () => tick, timeoutMs: 300, wait: async ms => { tick += ms; options.onWait?.(overlay); }, ...extra });
  return { main, overlay, run };
}

test('native session in overlay confirms independently of an inactive legacy VoiceStore', async () => {
  const { main, overlay, run } = setup();
  main.context.legacyVoiceStore = { isVoiceModeActive: false };
  const result = await run();
  assert.equal(result.window, overlay);
  assert.equal(result.snapshot.connected, true);
  assert.equal(result.snapshot.conversationId, target.taskId);
  assert.equal(result.snapshot.hostId, target.hostId);
  assert.equal(result.snapshot.inputDeviceId, 'input-1');
  assert.equal(result.snapshot.outputDeviceId, 'output-1');
  assert.equal(overlay.service.audio.muted, false);
  assert.equal(overlay.media.constraints.audio.deviceId.exact, 'input-1');
  assert.equal(overlay.service.startPreference.selectedDeviceId, 'input-1');
  assert.equal(overlay.service.microphonePreference.selectedDeviceId, 'previous');
  main.assertRestored(); overlay.assertRestored();
  assert.equal(main.context.__codexRemoteNativeVoiceV1, undefined);
  assert.equal((await overlay.call('mute', { muted: true })).microphoneMuted, true);
  await overlay.call('stop', { voiceSessionId: result.snapshot.voiceSessionId });
  assert.equal(overlay.service.stops, 1);
  assert.equal((await overlay.call('read')).active, false);
  await overlay.call('cleanup');
});

test('opening the voice interface is insufficient until the native phase is active', async () => {
  const { overlay, run } = setup({ starting: true, onWait: owner => {
    assert.equal(owner.service.audio.muted, true, 'output stays suppressed during startup');
    owner.phases.set('phase', 'active');
  } });
  assert.equal((await run()).snapshot.connected, true);
  await overlay.call('cleanup', { stop: true });
});

test('existing call is rejected without clicking or modifying devices', async () => {
  const { main, overlay, run } = setup();
  await overlay.launch();
  let clicks = 0; main.document.button.click = () => clicks++;
  await assert.rejects(run(), /已有语音/);
  assert.equal(clicks, 0); assert.equal(overlay.service.stops, 0);
  main.assertRestored(); overlay.assertRestored();
});

test('routing failure stops only our call and restores all renderer hooks', async () => {
  const { main, overlay, run } = setup({ sinkFailure: true });
  await assert.rejects(run(), /sink rejected/);
  main.assertRestored(); overlay.assertRestored();
  assert.equal(overlay.service.stops, 1);
  assert.equal(overlay.service.audio.muted, true);
  assert.equal(overlay.context.__codexRemoteNativeVoiceV1, undefined);
});

test('unconfirmed microphone route never produces connected', async () => {
  const { main, overlay, run } = setup({ inputDevice: 'wrong-input', inputFailure: true });
  await assert.rejects(run(), /未确认 ESP32 麦克风/);
  main.assertRestored(); overlay.assertRestored();
  assert.equal(overlay.service.stops, 1);
});

test('native startup timeout cancels preparing session and reports its stage', async () => {
  const { main, overlay, run } = setup({ starting: true });
  await assert.rejects(run(), /界面已打开.*尚未确认连接/);
  assert.equal(overlay.service.cancels, 1);
  main.assertRestored(); overlay.assertRestored();
});

test('no native attempt reports a different timeout stage and releases hooks', async () => {
  const { main, overlay, run } = setup({ noLaunch: true });
  await assert.rejects(run(), /未建立.*原生语音会话/);
  main.assertRestored(); overlay.assertRestored();
});

test('task change before click aborts without starting voice', async () => {
  const { main, overlay, run } = setup();
  await assert.rejects(run({ selectTask: async () => ({ ...target, taskId: 'different' }) }), /当前任务已变化/);
  assert.equal(overlay.service.currentAttempt, null);
  main.assertRestored(); overlay.assertRestored();
});

test('replaced session cannot be muted or stopped even on the same task', async () => {
  const { overlay, run } = setup();
  const { snapshot } = await run();
  await overlay.launch(); // New attempt object, same task and native session label.
  const state = await overlay.call('read');
  assert.equal(state.owned, false); assert.equal(state.connected, false);
  assert.notEqual(state.voiceSessionId, snapshot.voiceSessionId);
  await assert.rejects(overlay.call('mute', { muted: true }), /会话已变化/);
  await assert.rejects(overlay.call('stop', { voiceSessionId: snapshot.voiceSessionId }), /会话已变化/);
  await overlay.call('cleanup', { stop: true });
  assert.equal(overlay.service.stops, 0);
});

test('lost bridge watchdog restores interception and cancels its pending attempt', async () => {
  const owner = surface({ starting: true });
  await owner.call('prepare', route); await owner.launch();
  [...owner.timers.values()][0]();
  await new Promise(resolve => setImmediate(resolve));
  owner.assertRestored(); assert.equal(owner.service.cancels, 1);
  assert.equal(owner.context.__codexRemoteNativeVoiceV1, undefined);
});

test('partial hook installation failure rolls back its earlier changes', async () => {
  const owner = surface();
  Object.defineProperty(owner.document, 'createElement', { configurable: false });
  await assert.rejects(owner.call('prepare', route), /redefine/);
  owner.assertRestored(); assert.equal(owner.context.__codexRemoteNativeVoiceV1, undefined);
});

test('a changed output device during a call closes the audio acceptance gate', async () => {
  const { overlay, run } = setup();
  await run();
  overlay.service.audio.sinkId = 'different-speakers';
  const snapshot = await overlay.call('read');
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.state, 'disconnected');
  await overlay.call('cleanup', { stop: true });
});

test('owned voice follows user completion, native speech and task work back to listening', async () => {
  const { overlay, run } = setup();
  await run();
  const notify = (method, params = {}) => overlay.service.currentAttempt.runtime.options.onNotification({
    method, params: { threadId: target.taskId, ...params }
  });
  const state = async () => (await overlay.call('read')).state;
  assert.equal(await state(), 'listening');
  notify('thread/realtime/transcript/done', { role: 'user', text: 'private words' });
  assert.equal(await state(), 'thinking');
  assert.equal(overlay.service.lastNotification.params.text, 'private words', 'original native handler still receives its notification');
  const { transcript, ...status } = await overlay.call('read');
  assert.equal(JSON.stringify(status).includes('private words'), false);
  assert.equal(transcript.entries[0].text, 'private words');
  overlay.phases.set('activity', 'speaking');
  assert.equal(await state(), 'speaking');
  overlay.phases.set('activity', 'listening');
  assert.equal(await state(), 'listening');
  notify('turn/started', { turn: { id: 'turn-1' } });
  notify('turn/started', { turn: { id: 'turn-2' } });
  notify('turn/completed', { turn: { id: 'turn-1' } });
  assert.equal(await state(), 'thinking', 'another active turn is still running');
  overlay.phases.set('activity', 'speaking');
  assert.equal(await state(), 'speaking', 'audible answer takes precedence over background work');
  overlay.phases.set('activity', 'listening');
  assert.equal(await state(), 'thinking');
  notify('turn/completed', { turn: { id: 'turn-2' } });
  assert.equal(await state(), 'listening');
  overlay.phases.set('activity', 'thinking');
  assert.equal(await state(), 'thinking', 'native thinking is preserved if available');
  assert.equal((await overlay.call('mute', { muted: true })).state, 'muted');
  await overlay.call('cleanup', { stop: true });
});

test('assistant completion clears pending reply even when speech occurred between polls', async () => {
  const { overlay, run } = setup();
  await run();
  const options = overlay.service.currentAttempt.runtime.options;
  for (const role of ['user', 'assistant']) options.onNotification({
    method: 'thread/realtime/transcript/done', params: { threadId: target.taskId, role }
  });
  assert.equal((await overlay.call('read')).state, 'listening');
  await overlay.call('cleanup', { stop: true });
});

test('activity observer ignores other tasks and replaced attempts and is restored on cleanup', async () => {
  const { overlay, run } = setup();
  await run();
  const options = overlay.service.currentAttempt.runtime.options, wrapped = options.onNotification;
  options.onNotification({ method: 'turn/started', params: { threadId: 'other-task', turn: { id: 'other' } } });
  assert.equal((await overlay.call('read')).state, 'listening');
  await overlay.launch();
  options.onNotification({ method: 'turn/started', params: { threadId: target.taskId, turn: { id: 'old' } } });
  assert.equal(overlay.context.__codexRemoteNativeVoiceV1.runningTurns.size, 0);
  await overlay.call('cleanup', { stop: true });
  assert.notEqual(options.onNotification, wrapped);
  assert.equal(overlay.service.stops, 0);
});

test('native activity reaches the device with call identity and phase-appropriate capture', async t => {
  const { overlay, run } = setup(), sent = [];
  const native = Object.assign(new EventEmitter(), {
    start: async () => ({ confirmed: true, state: (await run()).snapshot }),
    stop: async () => overlay.call('cleanup', { stop: true })
  });
  const audio = Object.assign(new EventEmitter(), {
    startCapture: async () => ({}), start: async () => {}, dispose: async () => {}
  });
  const session = new RealtimeSession({
    send: async message => { sent.push(message); return true; },
    getTarget: async () => ({ ...target, streamId: 'stream-1', generation: 1 }),
    assertTarget: async () => {}, isOtherVoiceBusy: () => false,
    getConfig: () => ({ virtualMicro: { audioSource: 'esp32' }, realtime: { outputDeviceId: 'output-1' } }),
    nativeFactory: () => native, audioFactory: () => audio
  });
  t.after(() => session.dispose());
  await session.handle({ type: 'realtime_start', requestId: 'call-1' });
  const notify = overlay.service.currentAttempt.runtime.options.onNotification;
  const expectState = async (state, acceptsAudio) => {
    native.emit('state', await overlay.call('read'));
    await new Promise(setImmediate);
    const message = sent.at(-1);
    assert.equal(message.type, 'realtime_status');
    assert.equal(message.state, state);
    assert.equal(message.acceptsAudio, acceptsAudio);
    assert.equal(message.requestId, 'call-1');
    assert.equal(message.host_id, target.hostId);
    assert.equal(message.thread_id, target.taskId);
    assert.equal(message.stream_id, 'stream-1');
  };
  notify({ method: 'thread/realtime/transcript/done', params: { threadId: target.taskId, role: 'user' } });
  await expectState('thinking', true);
  overlay.phases.set('activity', 'speaking');
  await expectState('speaking', false);
  overlay.phases.set('activity', 'listening');
  await expectState('listening', true);
  await overlay.call('mute', { muted: true });
  await expectState('muted', false);
  await session.dispose();
  const count = sent.length;
  native.emit('state', { state: 'thinking' });
  assert.equal(sent.length, count, 'ended calls cannot repaint the device');
});

test('a swallowed native stop failure cannot be reported as an ended call', async () => {
  const { overlay, run } = setup();
  const { snapshot } = await run();
  overlay.service.stop = async () => {};
  await assert.rejects(overlay.call('stop', { voiceSessionId: snapshot.voiceSessionId }), /未确认语音已结束/);
  assert.equal((await overlay.call('read')).active, true);
});

test('captions assemble deltas, correct final text and keep interleaved speakers in order', async () => {
  const { overlay, run } = setup();
  await run();
  const notify = (suffix, role, value) => overlay.service.currentAttempt.runtime.options.onNotification({
    method: `thread/realtime/transcript/${suffix}`,
    params: { threadId: target.taskId, role, [suffix === 'done' ? 'text' : 'delta']: value }
  });
  notify('delta', 'user', '打开');
  notify('delta', 'user', '设至');
  notify('delta', 'assistant', '正在');
  notify('done', 'user', '打开设置');
  notify('delta', 'assistant', '打开');
  let snapshot = await overlay.call('read');
  assert.deepEqual(Array.from(snapshot.transcript.entries, e => [e.role, e.text, e.final]),
    [['user', '打开设置', true], ['assistant', '正在打开', false]]);
  notify('done', 'assistant', '已经打开。');
  const finalRevision = (await overlay.call('read')).transcript.sequence;
  notify('done', 'assistant', '已经打开。');
  assert.equal((await overlay.call('read')).transcript.sequence, finalRevision, 'duplicate final is not a new utterance');
  notify('done', 'user', '谢谢');
  snapshot = await overlay.call('read');
  assert.deepEqual(Array.from(snapshot.transcript.entries, e => e.text), ['已经打开。', '谢谢']);
  await overlay.call('cleanup', { stop: true });
  assert.equal((await overlay.call('read')).transcript, undefined);
});

test('captions bound Unicode text and reject other task or unsupported role events', async () => {
  const { overlay, run } = setup();
  await run();
  const notify = overlay.service.currentAttempt.runtime.options.onNotification;
  const send = (role, text, threadId = target.taskId) => notify({
    method: 'thread/realtime/transcript/done', params: { threadId, role, text }
  });
  send('system', 'hidden'); send('user', 'another task', 'other');
  assert.equal((await overlay.call('read')).transcript.sequence, 0);
  send('user', '长'.repeat(600) + '😀\u0000\u0001结尾');
  const entry = (await overlay.call('read')).transcript.entries[0];
  assert.equal(Array.from(entry.text).length, 512);
  assert.ok(entry.text.endsWith('😀结尾'));
  assert.equal(entry.text.includes('\u0000'), false);
  assert.ok(Buffer.byteLength(entry.text) <= 2048);
  await overlay.call('cleanup', { stop: true });
});

test('renderer captions pass through runtime and session without republishing voice state', async t => {
  const { overlay, run } = setup(), sent = [];
  const context = { ...target, streamId: 'stream-1', generation: 1 };
  const native = new CodexRealtimeRuntime({ getContext: () => context, request: async (type, payload) => {
    if (type === 'start') return (await run()).snapshot;
    return overlay.call(type, payload);
  } });
  const audio = Object.assign(new EventEmitter(), {
    startCapture: async () => ({}), start: async () => {}, dispose: async () => {}
  });
  const session = new RealtimeSession({
    send: async message => { sent.push(message); return true; }, getTarget: async () => context,
    assertTarget: async () => {}, isOtherVoiceBusy: () => false,
    getConfig: () => ({ virtualMicro: { audioSource: 'esp32' }, realtime: { outputDeviceId: 'output-1' } }),
    nativeFactory: () => native, audioFactory: () => audio
  });
  t.after(async () => { await session.dispose(); await overlay.call('cleanup'); });
  await session.handle({ type: 'realtime_start', requestId: 'caption-call' });
  const notify = overlay.service.currentAttempt.runtime.options.onNotification;
  const statusCount = () => sent.filter(m => m.type === 'realtime_status').length;
  const before = statusCount();
  for (const delta of ['测试', '字幕']) {
    notify({ method: 'thread/realtime/transcript/delta', params: { threadId: target.taskId, role: 'user', delta } });
    await native.readState();
    await new Promise(setImmediate);
  }
  const captions = sent.filter(m => m.type === 'realtime_transcript');
  assert.equal(captions.length, 2);
  assert.equal(captions[1].entries[0].text, '测试字幕');
  assert.equal(captions[1].requestId, 'caption-call');
  assert.equal(captions[1].host_id, target.hostId);
  assert.equal(captions[1].thread_id, target.taskId);
  assert.equal(captions[1].stream_id, context.streamId);
  assert.equal(statusCount(), before, 'caption updates do not reset the voice visual or microphone gate');
  const snapshot = await overlay.call('read');
  native.note({ ...snapshot, transcript: { ...snapshot.transcript, sequence: 99 }, voiceSessionId: 'other' });
  assert.equal(sent.filter(m => m.type === 'realtime_transcript').length, 2);
  native.note({ ...snapshot, transcript: { ...snapshot.transcript, sequence: 1 } });
  assert.equal(sent.filter(m => m.type === 'realtime_transcript').length, 2);
  await session.dispose();
  assert.equal(native.getTranscript(), null);
  const count = sent.length;
  native.emit('transcript', { sequence: 100, entries: [{ role: 'user', text: 'late', final: true }] });
  assert.equal(sent.length, count);
});
