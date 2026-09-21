const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const Bridge = require('../../src/voice/realtime-audio-bridge');

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough();
  child.kill = () => { child.killed = true; };
  const requests = [];
  child.stdin.on('data', line => requests.push(JSON.parse(line)));
  const bridge = new Bridge({ spawn: () => child });
  bridge.status.deviceName = 'CABLE Input (VB-Audio Virtual Cable)';
  bridge.listCaptureDevices = async () => [{ id: 'answers', name: 'Independent answer device' }];
  const faults = [];
  bridge.on('fault', error => faults.push(error.message));
  return { bridge, child, requests, faults };
}

test('slow WASAPI initialization remains pending beyond 10 seconds and requires a real reply', async t => {
  const { bridge, child, requests } = setup(t);
  const pending = bridge.startCapture('answers', 'microphone');
  await Promise.resolve();
  t.mock.timers.tick(15000);
  assert.equal(bridge.capture.active, false);
  assert.notEqual(child.killed, true);
  child.stdout.write(JSON.stringify({ id: requests[0].id, ok: true, result: { captureId: 'capture-1' } }) + '\n');
  await pending;
  assert.equal(bridge.capture.active, true);
  assert.equal(bridge.capture.captureId, 'capture-1');
  await bridge.dispose();
});

test('a hung capture is bounded, kills the helper and reports the audio-device stage', async t => {
  const { bridge, child, requests, faults } = setup(t);
  const rejected = assert.rejects(bridge.startCapture('answers', 'microphone'), /回答音频设备初始化超时/);
  await Promise.resolve();
  t.mock.timers.tick(30000);
  await rejected;
  assert.equal(child.killed, true);
  assert.equal(bridge.capture.active, false);
  assert.match(faults[0], /30 秒/);
  child.stdout.write(JSON.stringify({ id: requests[0].id, ok: true, result: { captureId: 'too-late' } }) + '\n');
  assert.equal(bridge.capture.active, false);
});

test('VB-CABLE standard and 16-channel aliases cannot form separate audio directions', async () => {
  const bridge = new Bridge();
  bridge.status.deviceName = 'CABLE Input (VB-Audio Virtual Cable)';
  bridge.listCaptureDevices = async () => [{ id: 'other-endpoint-id', name: 'CABLE In 16ch (VB-Audio Virtual Cable)' }];
  bridge.request = async () => { throw new Error('must not initialize the conflicting endpoint'); };
  await assert.rejects(bridge.startCapture('other-endpoint-id', 'microphone'), /同一条虚拟线/);
  assert.equal(Bridge.sameCableRoute('CABLE Input (VB-Audio Virtual Cable)', 'CABLE-A Input (VB-Audio Cable A)'), false);
  assert.equal(Bridge.sameCableRoute('CABLE Input (VB-Audio Virtual Cable)', 'Speakers (Independent Virtual Audio)'), false);
});

test('capture and microphone use distinct helpers and both are disposed', async () => {
  const children = [];
  const bridge = new Bridge({ spawn: () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; };
    child.operations = [];
    child.stdin.on('data', line => {
      const request = JSON.parse(line); child.operations.push(request.op);
      const result = request.op === 'capture_start' ? { captureId: 'capture-1' } : {};
      child.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
    });
    children.push(child); return child;
  } });
  bridge.listCaptureDevices = async () => [{ id: 'answers', name: 'Independent answer device' }];
  bridge.list = async () => [{ id: 'microphone', name: 'CABLE Input (VB-Audio Virtual Cable)' }];
  await bridge.startCapture('answers', 'microphone');
  await bridge.start('microphone');
  assert.equal(children.length, 2);
  assert.notEqual(bridge.child, bridge.captureHelper.child);
  assert.deepEqual(children.map(child => child.operations), [['capture_start'], ['start']]);
  const packets = []; bridge.on('audio', packet => packets.push(packet));
  bridge.captureHelper.child.stdout.write(JSON.stringify({ event: 'capture_audio', captureId: 'capture-1', packet: 'AQID', sequence: 1, sampleRate: 16000, frameDuration: 20 }) + '\n');
  assert.equal(packets.length, 1);
  await bridge.dispose();
  assert.equal(children.every(child => child.killed), true);
});
