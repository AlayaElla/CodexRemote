const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const RealtimeSession = require('../../src/voice/realtime-session');
const RealtimeAudioBridge = require('../../src/voice/realtime-audio-bridge');

function harness(overrides = {}) {
  const sent = [], native = new EventEmitter(), audio = new EventEmitter();
  const calls = { stop: 0, dispose: 0, append: 0 };
  Object.assign(native, { start: async () => ({ confirmed: true }), stop: async () => { calls.stop++; }, setMuted: async () => {}, interrupt: async () => {} });
  Object.assign(audio, { start: async () => {}, startCapture: async () => {}, discard: async () => {},
    append: async () => { calls.append++; }, dispose: async () => { calls.dispose++; } });
  const session = new RealtimeSession({ send: async m => { sent.push(m); return true; },
    getTarget: () => ({ hostId: 'local', taskId: 'task1', streamId: 'stream1', generation: 1 }),
    assertTarget: async () => {}, getConfig: () => ({ virtualMicro: { audioSource: 'esp32', audioDeviceId: 'input' }, realtime: { outputDeviceId: 'output' } }),
    isOtherVoiceBusy: () => false, nativeFactory: () => native, audioFactory: () => audio, ...overrides });
  const start = { type: 'realtime_start', requestId: 'call1', host_id: 'local', thread_id: 'task1', stream_id: 'stream1' };
  const packet = { type: 'realtime_audio_input', requestId: 'call1', generation: 1, sequence: 1, codec: 'opus', data: 'AQID' };
  return { session, sent, native, audio, calls, start, packet };
}
const answerPacket = index => ({ packet: Buffer.from([index]).toString('base64'), sampleRate: 16000, frameDuration: 20 });
const tick = () => new Promise(setImmediate);

test('coalesced helper stdout sends all 32 answer frames without ending the call', async t => {
  const h = harness();
  t.after(() => h.session.dispose());
  await h.session.handle(h.start);
  const bridge = new RealtimeAudioBridge({ executablePath: 'unused' });
  bridge.capture = { active: true, captureId: 'capture1' };
  const runtime = { buffer: Buffer.alloc(0) };
  bridge.captureHelper.runtime = runtime;
  bridge.on('audio', packet => h.audio.emit('audio', packet));
  const lines = Array.from({ length: 32 }, (_, index) => JSON.stringify({
    event: 'capture_audio', captureId: 'capture1', sequence: index + 1, ...answerPacket(index)
  })).join('\n') + '\n';
  bridge.captureHelper.handleStdout(Buffer.from(lines), runtime);
  await tick();
  assert.equal(h.session.busy, true);
  assert.equal(h.sent.some(message => message.state === 'error'), false);
  const frames = h.sent.filter(message => message.type === 'realtime_audio');
  assert.deepEqual(frames.map(message => message.data), Array.from({ length: 32 }, (_, index) => answerPacket(index).packet));
  assert.deepEqual(frames.map(message => message.sequence), Array.from({ length: 32 }, (_, index) => index + 1));
});

function blockAnswerSends(h) {
  const originalSend = h.session.send;
  const releases = [];
  h.session.send = message => {
    const sent = originalSend(message);
    return message.type === 'realtime_audio' ? new Promise(resolve => releases.push(resolve)) : sent;
  };
  return releases;
}

test('slow output sends are serialized and excess backlog retains recent audio', async t => {
  const h = harness();
  t.after(() => h.session.dispose());
  await h.session.handle(h.start);
  const releases = blockAnswerSends(h);
  for (let index = 0; index < 100; index++) h.audio.emit('audio', answerPacket(index));
  await tick();
  assert.equal(h.session.busy, true);
  assert.equal(releases.length, 1, 'only one send may be in flight');
  assert.equal(h.session.active.outputQueue.length, 32);
  assert.equal(h.session.active.droppedOutput, 67);
  for (let index = 0; index < 33; index++) {
    assert.equal(releases.length, 1);
    releases.shift()(true);
    await tick();
  }
  assert.equal(releases.length, 0);
  const frames = h.sent.filter(message => message.type === 'realtime_audio');
  assert.deepEqual(frames.map(message => Buffer.from(message.data, 'base64')[0]), [0, ...Array.from({ length: 32 }, (_, index) => index + 68)]);
  assert.equal(h.session.busy, true);
});

test('interrupt discards queued old audio before sending the next generation', async t => {
  const h = harness();
  t.after(() => h.session.dispose());
  await h.session.handle(h.start);
  h.native.supportsInterrupt = true;
  const releases = blockAnswerSends(h);
  for (let index = 0; index < 4; index++) h.audio.emit('audio', answerPacket(index));
  await h.session.handle({ type: 'realtime_interrupt', requestId: 'call1' });
  h.audio.emit('audio', answerPacket(99));
  releases.shift()(true);
  await tick();
  assert.equal(releases.length, 1);
  releases.shift()(true);
  await tick();
  const frames = h.sent.filter(message => message.type === 'realtime_audio');
  assert.deepEqual(frames.map(message => [message.generation, message.data]), [[1, answerPacket(0).packet], [2, answerPacket(99).packet]]);
});

test('ending a call discards queued frames even if an earlier send completes late', async () => {
  const h = harness();
  await h.session.handle(h.start);
  const releases = blockAnswerSends(h);
  for (let index = 0; index < 4; index++) h.audio.emit('audio', answerPacket(index));
  await h.session.stop();
  const count = h.sent.length;
  for (const release of releases) release(true);
  await tick();
  assert.equal(h.sent.length, count);
  assert.equal(h.sent.filter(message => message.type === 'realtime_audio').length, 1);
  assert.equal(h.sent.at(-1).state, 'ended');
});

test('a real output send failure still stops capture and native voice', async () => {
  const h = harness();
  await h.session.handle(h.start);
  const releases = blockAnswerSends(h);
  for (let index = 0; index < 4; index++) h.audio.emit('audio', answerPacket(index));
  releases.shift()(false);
  await tick();
  assert.equal(h.session.busy, false);
  assert.equal(h.sent.at(-1).state, 'error');
  assert.match(h.sent.at(-1).message, /回答音频发送失败/);
  assert.equal(h.calls.stop, 1);
  assert.equal(h.calls.dispose, 1);
  for (const release of releases) release(true);
});
