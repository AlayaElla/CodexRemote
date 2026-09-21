const assert = require('node:assert/strict');
const Activation = require('../../src/platform/codex-debug-activation');
const target = { pid: 42, executable: 'C:/Codex/ChatGPT.exe' };
const owned = [{ OwningProcess: 42, LocalAddress: '127.0.0.1' }];
function setup(overrides = {}) {
  const state = { active: false, activations: 0, closes: 0 };
  const service = new Activation({ platform: 'win32', findProcess: async () => target,
    listeners: async () => state.active ? owned : [],
    activate: () => { state.activations++; state.active = true; },
    isAlive: () => true, delay: async () => {},
    connectInspector: async () => ({ evaluate: async () => ({ pid: target.pid, executable: target.executable }), close: () => state.closes++ }),
    ...overrides });
  return { service, state };
}
(async () => {
  const { service, state } = setup();
  const pending = service.enable();
  assert.equal(service.enable(), pending, 'concurrent requests share one activation');
  assert.equal((await pending).success, true);
  assert.equal(state.activations, 1);
  assert.equal(state.closes, 1);
  assert.equal((await service.enable()).success, true);
  assert.equal(state.activations, 1, 'an existing verified inspector is reused');

  const occupied = setup({ listeners: async () => [{ OwningProcess: 999, LocalAddress: '127.0.0.1' }] });
  assert.equal((await occupied.service.enable()).success, false);
  assert.equal(occupied.state.activations, 0);
  const exposed = setup({ listeners: async () => [{ OwningProcess: 42, LocalAddress: '0.0.0.0' }] });
  assert.equal((await exposed.service.enable()).success, false);
  assert.equal(exposed.state.activations, 0);

  let attempts = 0;
  const timeout = setup({ activate: () => attempts++ });
  assert.match((await timeout.service.enable()).error, /尚未就绪/);
  assert.match((await timeout.service.enable()).error, /已尝试/);
  assert.equal(attempts, 1, 'never repeat a failed activation on the same process');
  const crashed = setup({ isAlive: () => false });
  assert.match((await crashed.service.enable()).error, /退出/);
  const identity = setup({ listeners: async () => owned,
    connectInspector: async () => ({ evaluate: async () => ({ pid: 999, executable: target.executable }), close() {} }) });
  assert.match((await identity.service.enable()).error, /身份不匹配/);
  const unsupported = setup({ platform: 'darwin' });
  assert.equal((await unsupported.service.enable()).success, false);
  assert.equal(unsupported.state.activations, 0);
  let scheduled = null, runningTarget = null, portOpen = false;
  const activated = [];
  const monitor = new Activation({ platform: 'win32',
    findProcess: async () => { if (!runningTarget) throw new Error('not running'); return runningTarget; },
    listeners: async () => portOpen ? [{ OwningProcess: runningTarget.pid, LocalAddress: '127.0.0.1' }] : [],
    activate: pid => { activated.push(pid); portOpen = true; },
    isAlive: pid => runningTarget?.pid === pid, probe: async () => portOpen,
    delay: async () => {},
    connectInspector: async () => ({ evaluate: async () => ({ pid: runningTarget.pid, executable: runningTarget.executable }), close() {} }),
    timers: { setTimeout(fn) { scheduled = fn; return 1; }, clearTimeout() { scheduled = null; } }
  });
  const settled = async () => { for (let n = 0; n < 50 && !scheduled; n++) await new Promise(resolve => setImmediate(resolve)); assert(scheduled, 'monitor schedules its next check'); };
  const tick = async () => { const next = scheduled; scheduled = null; next(); await settled(); };
  monitor.start(); await settled();
  assert.equal(monitor.state.stage, 'waiting');
  runningTarget = target;
  await tick();
  assert.equal(monitor.state.stage, 'ready');
  assert.deepEqual(activated, [42], 'Codex launched after bridge is activated automatically');
  await tick();
  assert.deepEqual(activated, [42], 'healthy checks reuse the inspector');
  portOpen = false;
  await tick();
  assert.equal(monitor.state.stage, 'error', 'closed inspector must not remain ready');
  assert.deepEqual(activated, [42], 'failed process is not repeatedly signalled');
  runningTarget = { ...target, pid: 43 };
  await tick();
  assert.equal(monitor.state.stage, 'ready');
  assert.deepEqual(activated, [42,43], 'a new Codex process is initialized');
  runningTarget = null; portOpen = false;
  await tick();
  assert.equal(monitor.state.stage, 'waiting');
  monitor.stop();
  assert.equal(scheduled, null);

  let releaseFind;
  const cancelled = setup({ findProcess: () => new Promise(resolve => releaseFind = resolve) });
  cancelled.service.start();
  await new Promise(resolve => setImmediate(resolve));
  cancelled.service.stop();
  releaseFind(target);
  await cancelled.service.pending;
  assert.equal(cancelled.state.activations, 0, 'shutdown cancels pending initialization');
  console.log('Automatic runtime debug lifecycle checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
