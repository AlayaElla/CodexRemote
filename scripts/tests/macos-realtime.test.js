const test = require('node:test');
const assert = require('node:assert/strict');
const Runtime = require('../../src/platform/codex-realtime-runtime');
const Bridge = require('../../src/voice/realtime-audio-bridge');

test('Mac realtime reuses a verified inspector and installs a Unix socket runtime', async () => {
  const calls = [];
  let closed = false;
  const runtime = new Runtime({ platform: 'darwin', findProcess: async () => ({ pid: 123, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' }),
    connectInspector: async () => ({ close() { closed = true; }, async evaluate(source) {
      calls.push(source);
      if (calls.length === 1) return { pid: 123, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' };
    } }), readPipe: async () => ({}) });
  await runtime.ensure();
  assert.match(runtime.pipePath, /crm-.*\.sock$/);
  assert.match(calls[1], /app-initial-a498f911edeb/);
  assert.match(calls[1], /chmodSync\(pipePath, 0o600\)/);
  assert.equal(closed, true);
  runtime.dispose();
});

test('Mac realtime never installs into an unverified process or signals a missing inspector', async () => {
  for (const missing of [false, true]) {
    let installs = 0;
    const runtime = new Runtime({ platform: 'darwin', findProcess: async () => ({ pid: 123, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' }),
      connectInspector: async () => {
        if (missing) throw new Error('offline');
        return { close() {}, async evaluate(source) { if (source.includes('installRealtimeRuntime')) installs++; return { pid: 456, executable: 'foreign' }; } };
      } });
    await assert.rejects(runtime.ensure(), missing ? /启动|调试/ : /identity mismatch/);
    assert.equal(installs, 0);
    assert.equal(runtime.pipePath, null);
  }
});

test('Mac requires explicit separate BlackHole routes before capture starts', async () => {
  const bridge = new Bridge({ platform: 'darwin' });
  bridge.listCaptureDevices = async () => [{ id: 'blackhole', name: 'BlackHole 16ch' }];
  bridge.captureHelper.request = async () => { throw new Error('must not start capture'); };
  await assert.rejects(bridge.startCapture('blackhole'), /明确选择/);
  await assert.rejects(bridge.startCapture('blackhole', 'blackhole'), /同一条虚拟线/);
  await bridge.dispose();
});
