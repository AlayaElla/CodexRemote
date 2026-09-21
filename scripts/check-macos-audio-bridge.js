// Protocol checks do not open an audio endpoint or change system defaults.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runHelper(executable, input) {
  const result = spawnSync(executable, [], {
    input, encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function check(executable) {
  const requests = [
    { id: 'list', op: 'list' },
    { id: 'capture-list', op: 'capture_list' },
    { id: 'capture-missing', op: 'capture_start' },
    { id: 'capture-invalid', op: 'capture_start', deviceId: 'missing-device' },
    { id: 'append', op: 'append', packet: 'AQ==' },
    { id: 'stop', op: 'stop' },
    { id: 'cancel', op: 'cancel' },
    { id: 'discard', op: 'discard' },
    { id: 'unknown', op: 'unknown' },
    { id: 'invalid-id', op: 42 }
  ];
  const replies = runHelper(executable, requests.map(value => JSON.stringify(value)).join('\n') + '\n');
  assert.equal(replies.length, requests.length);
  assert.equal(replies[0].ok, true);
  assert(Array.isArray(replies[0].devices));
  for (const device of replies[0].devices) {
    assert.equal(typeof device.id, 'string');
    assert.match(device.name, /BlackHole/i);
    assert.equal(device.captureName, device.name);
  }
  assert.equal(replies[1].ok, true);
  assert.deepEqual(replies[1].devices, replies[0].devices);
  for (let index = 2; index < requests.length; index++) {
    assert.equal(replies[index].ok, false);
    assert.equal(typeof replies[index].error, 'string');
  }
  for (const input of ['x'.repeat(16385), '{"id":"partial"}', Buffer.from([0xff, 0x0a])]) {
    const values = runHelper(executable, input);
    assert.equal(values.length, 1);
    assert.equal(values[0].event, 'fault');
  }
  const recovered = runHelper(executable, 'invalid-json\n{"id":"retry","op":"list"}\r\n');
  assert.equal(recovered[0].ok, false);
  assert.equal(recovered[1].id, 'retry');
  assert.equal(recovered[1].ok, true);
  console.log('macOS audio helper protocol checks passed (no audio playback)');
}

if (require.main === module) {
  if (process.platform !== 'darwin') throw new Error('Run this native helper check on macOS.');
  check(process.argv[2] || path.resolve(__dirname,
    '../native/macos-audio-bridge/.build/release/CodexRemoteMacAudioBridge'));
}
module.exports = { check };
