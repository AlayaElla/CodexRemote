const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const RealtimeAudioBridge = require('../src/voice/realtime-audio-bridge');

function createHelper() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
  const requests = [];
  child.stdin.on('data', line => {
    const request = JSON.parse(line.toString('utf8'));
    requests.push(request);
    let result = {};
    if (request.op === 'capture_list') result = { devices: [{ id: 'speakers', name: 'Codex Voice Speakers' }] };
    if (request.op === 'capture_start') result = { result: { deviceId: request.deviceId, name: 'Codex Voice Speakers', captureId: 'capture-1', sampleRate: 16000, frameDuration: 20 } };
    if (request.op === 'capture_stop') result = { result: { stopped: true } };
    child.stdout.write(`${JSON.stringify({ id: request.id, ok: true, ...result })}\n`);
  });
  return { child, requests };
}

async function main() {
  const helper = createHelper();
  const bridge = new RealtimeAudioBridge({ spawn: () => helper.child, executablePath: 'Esp32AudioBridge.exe' });
  assert.deepEqual(await bridge.listCaptureDevices(), [{ id: 'speakers', name: 'Codex Voice Speakers' }]);
  await assert.rejects(() => bridge.startCapture(''), /outputDeviceId/);
  const start = await bridge.startCapture('speakers', 'cable-input');
  assert.equal(start.captureId, 'capture-1');
  assert.deepEqual(helper.requests.map(request => request.op), ['capture_list', 'capture_start']);
  assert.equal(helper.requests[1].inputDeviceId, 'cable-input');

  const audio = new Promise(resolve => bridge.once('audio', resolve));
  helper.child.stdout.write(`${JSON.stringify({ event: 'capture_audio', captureId: 'capture-1', packet: 'AQI=', sampleRate: 16000, frameDuration: 20, sequence: 7 })}\n`);
  assert.deepEqual(await audio, { packet: 'AQI=', sampleRate: 16000, frameDuration: 20, sequence: 7 });

  let faults = 0;
  bridge.on('fault', () => { faults++; });
  helper.child.stdout.write(`${JSON.stringify({ event: 'capture_fault', captureId: 'wrong', error: 'old capture' })}\n`);
  assert.equal(faults, 0, 'old capture events cannot affect the new capture session');
  const stopped = await bridge.stopCapture();
  assert.equal(stopped.stopped, true);
  helper.child.stdout.write(`${JSON.stringify({ event: 'capture_audio', captureId: 'capture-1', packet: 'AQI=', sampleRate: 16000, frameDuration: 20, sequence: 8 })}\n`);
  assert.equal(faults, 0);
  await bridge.dispose();
  console.log('realtime audio bridge tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
