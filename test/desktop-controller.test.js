const assert = require('assert');
const DesktopController = require('../src/core/desktop-controller');

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const setTimeoutFn = (callback, delay) => {
    const id = nextId++;
    timers.set(id, { callback, at: now + Math.max(0, Number(delay) || 0) });
    return id;
  };
  const clearTimeoutFn = (id) => timers.delete(id);
  const advance = async (duration) => {
    const target = now + duration;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, first], [, second]) => first.at - second.at)[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      now = timer.at;
      timer.callback();
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    }
    now = target;
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
  };
  return {
    now: () => now,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    advance,
    pending: () => timers.size
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

async function testUnsupportedPlatform() {
  const controller = new DesktopController({ platform: 'linux', runner: () => { throw new Error('must not run'); } });
  const result = await controller.sendText('hello');
  assert.equal(result.success, false);
  assert.match(result.error, /only supported on Windows/);
}

async function testDesktopOperations() {
  const calls = [];
  let waitRunnerOptions;
  const controller = new DesktopController({
    platform: 'win32',
    runner: async (request, options) => {
      calls.push(request);
      if (request.operation === 'wait-for-input') waitRunnerOptions = options;
      return request.operation === 'probe'
        ? { success: true, window: 'ChatGPT' }
        : { success: true, action: request.operation }
    }
  });

  assert.deepEqual(await controller.probe(), { success: true, window: 'ChatGPT' });
  assert.deepEqual(await controller.focusInput(), { success: true, action: 'focus-input' });
  assert.deepEqual(await controller.getInputState(), { success: true, action: 'input-state' });
  assert.deepEqual(await controller.submitInput(), { success: true, action: 'submit-input' });
  assert.deepEqual(await controller.waitForInput({ timeoutMs: 25, pollMs: 10, stableMs: 0 }), {
    success: true,
    action: 'wait-for-input'
  });
  assert.ok(waitRunnerOptions && waitRunnerOptions.timeoutMs >= 25000);
  assert.deepEqual(await controller.sendText('  hello  '), { success: true, action: 'send' });
  assert.deepEqual(await controller.stopTurn(), { success: true, action: 'stop' });
  assert.deepEqual(await controller.newTask(), { success: true, action: 'new-task' });
  assert.deepEqual(await controller.sendShortcut('control+shift+r'), { success: true, action: 'shortcut' });
  assert.deepEqual(calls, [
    { operation: 'probe' },
    { operation: 'focus-input' },
    { operation: 'input-state' },
    { operation: 'submit-input' },
    { operation: 'wait-for-input', timeoutMs: 25, pollMs: 10, stableMs: 0 },
    { operation: 'send', text: 'hello' },
    { operation: 'stop' },
    { operation: 'new-task' },
    { operation: 'shortcut', shortcut: 'Ctrl+Shift+R', modifiers: ['Ctrl', 'Shift'], key: 'R' }
  ]);
  assert.equal(controller.getState().available, true);
}

async function testValidationAndFailure() {
  const controller = new DesktopController({ platform: 'win32', runner: async () => ({ success: false, error: 'editor missing' }) });
  assert.match((await controller.sendText('')).error, /required/);
  assert.match((await controller.sendShortcut('Shift+Shift+R')).error, /Duplicate/);
  const failed = await controller.sendText('hello');
  assert.deepEqual(failed, { success: false, error: 'editor missing' });
  assert.equal(controller.getState().error, 'editor missing');
}

async function testAutoDiscoveryStopsAfterTimeout() {
  const clock = createFakeTimers();
  let probeCount = 0;
  const updates = [];
  const controller = new DesktopController({
    platform: 'win32',
    runner: async () => {
      probeCount += 1;
      return { success: false, error: 'window missing' };
    }
  });

  controller.startAutoDiscovery({
    intervalMs: 2,
    timeoutMs: 6,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onUpdate: (state) => updates.push(state)
  });
  await flushMicrotasks();
  assert.equal(probeCount, 1);
  await clock.advance(6);

  const state = controller.getState();
  assert.equal(probeCount, 3);
  assert.equal(state.available, false);
  assert.equal(state.discovery.state, 'timeout');
  assert.equal(state.discovery.active, false);
  assert.match(state.error, /30 秒内未检测到/);
  assert.equal(state.discovery.error, state.error);
  assert.equal(clock.pending(), 0);
  assert.ok(updates.some((item) => item.discovery.state === 'timeout'));
}

async function testAutoDiscoveryStopsWhenFound() {
  const clock = createFakeTimers();
  let probeCount = 0;
  const controller = new DesktopController({
    platform: 'win32',
    runner: async () => {
      probeCount += 1;
      return probeCount === 1
        ? { success: false, error: 'window missing' }
        : { success: true, window: 'ChatGPT' };
    }
  });

  controller.startAutoDiscovery({
    intervalMs: 2,
    timeoutMs: 30,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  await flushMicrotasks();
  await clock.advance(2);

  const state = controller.getState();
  assert.equal(probeCount, 2);
  assert.equal(state.available, true);
  assert.equal(state.discovery.state, 'found');
  assert.equal(state.discovery.active, false);
  assert.equal(clock.pending(), 0);
}

async function testAutoDiscoveryCancelsAndIgnoresStaleProbe() {
  const clock = createFakeTimers();
  const resolvers = [];
  const controller = new DesktopController({
    platform: 'win32',
    runner: () => new Promise((resolve) => resolvers.push(resolve))
  });

  controller.startAutoDiscovery({
    intervalMs: 2,
    timeoutMs: 30,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  assert.equal(resolvers.length, 1);
  controller.stopAutoDiscovery();
  controller.startAutoDiscovery({
    intervalMs: 2,
    timeoutMs: 30,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  assert.equal(resolvers.length, 2);
  assert.equal(controller.getState().discovery.state, 'searching');
  assert.equal(controller.getState().discovery.attempts, 1);

  resolvers[0]({ success: true, window: 'stale' });
  await flushMicrotasks();
  assert.equal(controller.getState().available, false);
  assert.equal(controller.getState().discovery.state, 'searching');

  resolvers[1]({ success: true, window: 'ChatGPT' });
  await flushMicrotasks();
  assert.equal(controller.getState().available, true);
  assert.equal(controller.getState().discovery.state, 'found');
  controller.stopAutoDiscovery();
  assert.equal(clock.pending(), 0);
}

Promise.all([
  testUnsupportedPlatform(),
  testDesktopOperations(),
  testValidationAndFailure(),
  testAutoDiscoveryStopsAfterTimeout(),
  testAutoDiscoveryStopsWhenFound(),
  testAutoDiscoveryCancelsAndIgnoresStaleProbe()
])
  .then(() => console.log('desktop controller tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
