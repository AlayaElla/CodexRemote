// All process discovery, inspector and pipe operations are mocked.
// Never launch or connect to the user's Codex application in these tests.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { CodexMicroSlots } = require('../../src/core/codex-micro-slots');
const { MACOS_INSPECTOR_REQUIRED, WINDOWS_INSPECTOR_REQUIRED } = require('../../src/platform/codex-inspector-policy');

const target = { pid: 42, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' };

function fixture(overrides = {}) {
  const expressions = [], requests = [];
  let closed = 0;
  const inspector = {
    evaluate: async expression => {
      expressions.push(expression);
      return { ...target, ...overrides.identity };
    },
    close: () => closed++
  };
  const runtime = new CodexMicroSlots({
    platform: 'darwin', findProcess: async () => target,
    connectInspector: async () => inspector,
    readPipe: async (...args) => { requests.push(args); return { success: true }; },
    ...overrides
  });
  return { runtime, expressions, requests, closed: () => closed };
}

test('Mac startup reads, retries and controls never signal Codex when inspector is unavailable', async t => {
  const activation = t.mock.method(process, '_debugProcess', () => {});
  let attempts = 0;
  const { runtime, requests } = fixture({ connectInspector: async () => {
    attempts++;
    throw new Error('ECONNREFUSED');
  } });
  await assert.rejects(runtime.read(), { message: MACOS_INSPECTOR_REQUIRED });
  await assert.rejects(runtime.read(), { message: MACOS_INSPECTOR_REQUIRED });
  assert.equal(attempts, 1, 'failed reads retain their retry backoff');
  runtime.nextAttemptAt = 0;
  await assert.rejects(runtime.read(), { message: MACOS_INSPECTOR_REQUIRED });
  await assert.rejects(runtime.request('ptt', { down: true }), { message: MACOS_INSPECTOR_REQUIRED });
  assert.equal(activation.mock.callCount(), 0);
  assert.equal(requests.length, 0);
  assert.equal(runtime.pipePath, null);
});

test('Mac can reuse a verified existing inspector without shutting it down', async t => {
  const activation = t.mock.method(process, '_debugProcess', () => {});
  const f = fixture();
  try {
    assert.deepEqual(await f.runtime.request('read'), { success: true });
    assert.equal(f.expressions.length, 2, 'verify identity before installing the runtime');
    assert.match(f.expressions[0], /process\.execPath/);
    assert.match(f.expressions[1], /installMacRuntime/);
    assert.equal(f.closed(), 1, 'disconnect this inspector client');
    assert.equal(activation.mock.callCount(), 0);
    assert.equal(f.requests[0][2], 'read');
  } finally { f.runtime.stop(); }
});

test('Mac rejects another inspector process before installing a runtime or sending controls', async () => {
  for (const identity of [{ pid: 99 }, { executable: '/other/app' }]) {
    const f = fixture({ identity });
    await assert.rejects(f.runtime.request('ptt', { down: true }), /身份不匹配/);
    assert.equal(f.expressions.length, 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.closed(), 1);
    assert.equal(f.runtime.pipePath, null);
  }
});

test('Windows Micro still leaves inspector activation to its lifecycle service', async t => {
  const activation = t.mock.method(process, '_debugProcess', () => {});
  const { runtime } = fixture({ platform: 'win32', connectInspector: async () => { throw new Error('unavailable'); } });
  await assert.rejects(runtime.read(), { message: WINDOWS_INSPECTOR_REQUIRED });
  assert.equal(activation.mock.callCount(), 0);
});

test('stale Micro polling and cleanup cannot bootstrap a new runtime after stop', async () => {
  const f = fixture();
  f.runtime.stop();
  await assert.rejects(f.runtime.request('micro-poll'), /connection was lost/);
  assert.deepEqual(await f.runtime.request('micro-close'), { closed: true });
  assert.equal(f.expressions.length, 0);
  assert.equal(f.requests.length, 0);
});
