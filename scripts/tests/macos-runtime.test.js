// Exercise the serialized main-process bridge on an isolated local socket.
// No real Codex process, inspector or renderer is accessed.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { installMacRuntime } = require('../../src/platform/macos-runtime');

async function fixture() {
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\crm-test-${randomUUID()}` : path.join(os.tmpdir(), `crm-${randomUUID()}.sock`);
  const state = { selectedThreadKey: 'local:a', route: 'app://-/index.html#/a', voiceState: 'idle' };
  const input = [], mutations = [];
  let blocked = false, resume, entered, locked = false, windowId = 1;
  const window = { id: 1, isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {},
    webContents: { getURL: () => 'app://-/index.html', sendInputEvent: event => input.push(event),
      executeJavaScript: async expression => vm.runInNewContext(expression, { fakeRenderer: async (_, request) => {
        if (request.op === 'read') return { ...state };
        mutations.push(request);
        if (blocked) { entered?.(); await new Promise(resolve => { resume = resolve; }); }
        if (request.op === 'ptt') state.voiceState = request.down ? 'recording' : 'idle';
        return { delivery: 'desktop_runtime', outcome: 'confirmed' };
      } }) } };
  const fs = { readdirSync: () => ['codex-micro-slot-signals-test.js', 'codex-micro-bridge-test.js'],
    readFileSync: () => 'from"./app-initial-test.js"', chmodSync: (_, mode) => assert.equal(mode, 0o600) };
  const electron = { app: { getAppPath: () => '/Codex.app', getVersion: () => 'test' },
    BrowserWindow: { getAllWindows: () => [{ ...window, id: windowId }], fromId: id => id === 1 ? window : null },
    powerMonitor: { getSystemIdleState: () => locked ? 'locked' : 'active' } };
  const install = vm.runInNewContext(`(${installMacRuntime.toString()})`, { Buffer, setTimeout, clearTimeout,
    process: { pid: 123, mainModule: { require: name => ({ electron, fs, path, net })[name] } } });
  await install({ pipePath, token: 'test-token' }, () => ({}), function renderer(profile, request) { return fakeRenderer(profile, request); });
  const request = (type, payload = {}, token = 'test-token') => new Promise((resolve, reject) => {
    const socket = net.connect(pipePath); let data = '';
    socket.setEncoding('utf8'); socket.setTimeout(1500, () => socket.destroy(new Error('test request timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ type, token, ...payload }) + '\n'));
    socket.on('data', chunk => data += chunk);
    socket.on('end', () => resolve(data ? JSON.parse(data) : null));
  });
  // Keep sockets writable until response (the bridge intentionally disallows
  // half-closed writers), as the production client does.
  const context = () => ({ expectedThreadKey: state.selectedThreadKey, expectedRoute: state.route });
  return { state, input, mutations, request, context, close: () => request('close').catch(() => {}),
    setLocked: value => locked = value, changeWindow: () => windowId++,
    block: () => { blocked = true; return new Promise(resolve => entered = resolve); },
    resume: () => { blocked = false; resume(); } };
}

test('runtime authenticates, pins target, rejects locks and changed windows', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.request('read', {}, 'wrong'), null);
    assert.equal((await f.request('read')).snapshot.processId, 123);
    assert.match((await f.request('ptt', { ...f.context(), expectedThreadKey: 'local:other', down: true })).error, /target changed/);
    f.setLocked(true);
    assert.match((await f.request('command', { ...f.context(), command: 'newTask' })).error, /locked/);
    f.setLocked(false);
    assert.equal(f.mutations.length, 0);
    f.changeWindow();
    assert.match((await f.request('read')).error, /window changed/);
  } finally { await f.close(); }
});

test('runtime serializes mutations while keeping read confirmations available', async () => {
  const f = await fixture();
  try {
    const entered = f.block();
    const first = f.request('ptt', { ...f.context(), down: true });
    await entered;
    assert.equal((await f.request('read')).snapshot.voiceState, 'idle');
    assert.match((await f.request('ptt', { ...f.context(), down: true })).error, /busy/);
    f.resume();
    assert.equal((await first).snapshot.outcome, 'confirmed');
    await f.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.input.map(event => event.keyCode), ['Escape', 'Escape']);
    assert.equal(f.mutations.length, 1, 'emergency cleanup must not insert partial dictation with PTT-stop');
  } finally { await f.close(); }
});

test('runtime emergency cleanup never sends input into a different task', async () => {
  const f = await fixture();
  try {
    await f.request('ptt', { ...f.context(), down: true });
    f.state.selectedThreadKey = 'local:b';
    await f.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.input.length, 0);
  } finally { await f.close(); }
});

test('closing during PTT dispatch cancels only after the in-flight operation settles', async () => {
  const f = await fixture();
  try {
    const entered = f.block();
    const pending = f.request('ptt', { ...f.context(), down: true });
    await entered;
    await f.close();
    assert.equal(f.input.length, 0);
    f.resume();
    await pending;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.input.length, 2);
    assert.equal(f.mutations.length, 1);
  } finally { await f.close(); }
});
