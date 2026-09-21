const assert = require('node:assert/strict');
const { test } = require('node:test');
const MacController = require('../../src/voice/macos-controller');
const MacShimController = require('../../src/voice/macos-shim-controller');
const VirtualMicroProvider = require('../../src/voice/providers/virtual-micro-provider');
const { controlDelivered } = require('../../src/voice/control-delivery');
const { codexHome, desktopIpcPath, validateDesktopSocket } = require('../../src/platform/codex-paths');
const { buildMacRendererProfile } = require('../../src/platform/macos-renderer-profile');
const { parseMacCodexProcesses } = require('../../src/core/codex-micro-slots');

function fixture(options = {}) {
  const snapshot = { selectedThreadKey: 'local:a', route: 'app://-/index.html#/threads/a',
    composerReady: true, voiceState: 'idle', slots: [{ threadId: 'a', hostId: 'local' }, { threadId: 'b', hostId: 'local' }] };
  const calls = [];
  const runtime = {
    read: async () => ({ ...snapshot }),
    request: async (type, args) => {
      calls.push({ type, ...args });
      assert.equal(args.expectedThreadKey, snapshot.selectedThreadKey, 'target must be pinned');
      assert.equal(args.expectedRoute, snapshot.route, 'draft route must be pinned');
      if (type === 'ptt') snapshot.voiceState = args.down ? 'recording' : 'idle';
      if (type === 'command' && args.command === 'newTask') {
        snapshot.selectedThreadKey = null; snapshot.route = 'app://-/index.html#/new/1';
      }
      if (type === 'command' && args.command === 'composer.submit') snapshot.voiceState = 'processing';
      if (type === 'escape') snapshot.voiceState = 'idle';
      return { delivery: 'desktop_runtime', outcome: type === 'command' ? 'requested' : 'confirmed',
        voiceReleased: type === 'command' && args.command === 'composer.submit' };
    }
  };
  const controller = new MacController({}, { runtime, confirmTimeoutMs: 60,
    getTarget: () => ({ taskId: 'a' }),
    getMicroLayout: () => ({ layout: { slots: { ACT09: { commandId: 'newTask' }, ACT10: { keycapId: 'CODEX' } } } }),
    execFile: (file, args, opts, callback) => {
      assert.equal(file, '/usr/bin/open'); assert.deepEqual(args, ['codex://threads/b']);
      snapshot.selectedThreadKey = 'local:b'; snapshot.route = 'app://-/index.html#/threads/b'; callback(null);
    }, ...options });
  return { controller, runtime, calls, snapshot };
}

test('platform paths preserve Windows and honor explicit Mac CODEX_HOME', () => {
  assert.equal(desktopIpcPath({ platform: 'win32' }), '\\\\.\\pipe\\codex-ipc');
  assert.equal(codexHome({ platform: 'darwin', homeDirectory: '/Users/person', env: {} }), '/Users/person/.codex');
  assert.equal(desktopIpcPath({ platform: 'darwin', env: { CODEX_HOME: '/private/codex' } }), '/private/codex/ipc/ipc.sock');
  assert.throws(() => desktopIpcPath({ platform: 'linux' }), /not available/);
});

test('Mac process discovery accepts current ChatGPT and legacy Codex app names only', () => {
  const processes = parseMacCodexProcesses([
    ' 101 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    ' 102 /Applications/Codex.app/Contents/MacOS/Codex',
    ' 103 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --type=renderer',
    ' 104 /Applications/ChatGPT.app/Contents/MacOS/Codex',
    ' 105 /tmp/ChatGPT.app/Contents/MacOS/Other'
  ].join('\n'));
  assert.deepEqual(processes, [
    { pid: 101, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' },
    { pid: 102, executable: '/Applications/Codex.app/Contents/MacOS/Codex' }
  ]);
});

test('Unix IPC rejects foreign ownership, writable parent, and symlinks', () => {
  const directory = { uid: 501, mode: 0o700, isDirectory: () => true };
  const socket = { uid: 501, isSocket: () => true };
  const options = { platform: 'darwin', uid: 501, fs: { lstatSync: value => value.endsWith('.sock') ? socket : directory } };
  assert.doesNotThrow(() => validateDesktopSocket('/Users/person/.codex/ipc/ipc.sock', options));
  for (const change of [() => directory.mode = 0o770, () => directory.uid = 502, () => socket.uid = 502,
    () => socket.isSocket = () => false, () => directory.isDirectory = () => false]) {
    change();
    assert.throws(() => validateDesktopSocket('/Users/person/.codex/ipc/ipc.sock', options), /owned/);
    Object.assign(directory, { uid: 501, mode: 0o700, isDirectory: () => true });
    Object.assign(socket, { uid: 501, isSocket: () => true });
  }
});

test('renderer bindings follow minified aliases and reject unknown source shape', () => {
  const input = {
    signalsName: 'codex-micro-slot-signals-test.js',
    signalsText: 'import{Scope as s,Get as g,Host as h,Select as q}from"./app-initial-test.js";import{Config as c}from"./app-shared-test.js";Z=atom(s,{});g(x,c.agentSource);({hostId:x.get(h,id),selectedThreadKey:x(q)});export{Z as n}',
    bridgeText: 'import{Bus as b}from"./app-shared-test.js";import{Command as cmd}from"./app-initial-test.js";b.dispatchHostMessage({type:"ptt"});function f(t,n){return t===`manageTasks`?!1:cmd(t,n)}',
    initialText: 'function read(){let a=readStore(key,{});if(a)return a}const key=`client-thread-bindings-v1`;export{readStore as Bindings}'
  };
  const profile = buildMacRendererProfile(input);
  assert.deepEqual(profile.command, { file: 'app-initial-test.js', name: 'Command' });
  assert.equal(profile.scope.name, 'Scope'); assert.equal(profile.bindings.name, 'Bindings');
  assert.throws(() => buildMacRendererProfile({ ...input, bridgeText: '' }), /Unsupported/);
  assert.throws(() => buildMacRendererProfile({ ...input, signalsText: input.signalsText.replace('hostId:', 'renamed:') }), /host/);
});

test('Mac PTT confirms recording, submits and releases in order', async () => {
  const { controller, calls } = fixture();
  try {
    assert.equal((await controller.connect()).transport, 'desktop_runtime');
    assert.equal((await controller.setPtt(true)).outcome, 'confirmed');
    assert.equal((await controller.tapKey('ACT10')).outcome, 'requested');
    await controller.releaseAll();
    assert.deepEqual(calls.map(call => call.type), ['ptt', 'command']);
    assert.equal(controller.pttTarget, null);
  } finally { await controller.close(); }
});

test('task selection verifies slot identity and confirmed navigation', async () => {
  const { controller, snapshot } = fixture();
  try {
    await assert.rejects(controller.selectTask('b', 'other-host'), /Invalid/);
    await assert.rejects(controller.selectTask('missing'), /槽位/);
    assert.equal((await controller.selectTask('b')).outcome, 'confirmed');
    assert.equal(snapshot.selectedThreadKey, 'local:b');
  } finally { await controller.close(); }
});

test('new draft can be created while target resolver is preparing it', async () => {
  const { controller, snapshot } = fixture({ getTarget: () => { throw new Error('draft preparing'); } });
  try {
    assert.equal((await controller.tapKey('ACT09')).outcome, 'confirmed');
    assert.equal(snapshot.selectedThreadKey, null);
  } finally { await controller.close(); }
});

test('unknown PTT outcome is never retried or reported as ready', async () => {
  const { controller, runtime } = fixture();
  let attempts = 0;
  runtime.request = async () => { attempts++; throw new Error('connection lost'); };
  await assert.rejects(controller.setPtt(true), /connection lost/);
  assert.equal(attempts, 1);
  assert.equal(controller.getStatus().connected, false);
  await assert.rejects(controller.connect(), /uncertain/);
  await assert.rejects(controller.close(), /connection lost/);
});

test('Mac target changes reject input before dispatch', async () => {
  const { controller, calls, snapshot } = fixture();
  try {
    snapshot.selectedThreadKey = 'local:b';
    await assert.rejects(controller.pasteText('text', { taskId: 'a' }), /不一致/);
    await assert.rejects(controller.setPtt(true), /不一致/);
    await assert.rejects(controller.pasteText('text', { draftToken: 'draft' }), /草稿/);
    assert.equal(calls.length, 0);
  } finally { await controller.close(); }
});

test('Mac cancellation resolves a client draft binding but guards the raw renderer identity', async () => {
  const { controller, calls, snapshot } = fixture();
  snapshot.selectedThreadKey = 'local:client-new-thread:draft-a';
  snapshot.threadBindings = { 'client-new-thread:draft-a': 'a' };
  try {
    await controller.escape({ discard: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'escape');
    assert.equal(calls[0].discard, true);
    assert.equal(calls[0].expectedThreadKey, 'local:client-new-thread:draft-a');
    assert.deepEqual(await controller.resolveMicroDraft({ candidates: ['a'] }), { threadId: 'a' });
    assert.equal((await controller.selectTask('a')).outcome, 'confirmed');
    snapshot.threadBindings['client-new-thread:draft-a'] = 'b';
    await assert.rejects(controller.escape({ discard: true }), /不一致/);
    delete snapshot.threadBindings['client-new-thread:draft-a'];
    await assert.rejects(controller.escape({ discard: true }), /不一致/);
    assert.equal(calls.length, 1, 'different or unbound drafts must never be cancelled');
  } finally { await controller.close(); }
});

test('provider chooses Mac controller and preserves its transport status', async () => {
  const { runtime } = fixture();
  const provider = new VirtualMicroProvider({ audioSource: 'computer' }, { controllerOptions: { platform: 'darwin', runtime } });
  try {
    assert.ok(provider.controller instanceof MacShimController);
    assert.equal(provider.getStatus().transport, 'codex_hid_shim');
    assert.equal(provider.getStatus().microConnected, false);
    assert.equal(provider.getStatus().driverAvailable, false);
  } finally { await provider.dispose(); }
});

test('delivery receipt distinguishes acknowledged controls from failures', () => {
  assert.ok(controlDelivered({ delivery: 'submitted_to_hid' }));
  assert.ok(controlDelivered({ delivery: 'desktop_runtime', outcome: 'requested' }));
  assert.ok(controlDelivered({ delivery: 'desktop_runtime', outcome: 'confirmed' }));
  assert.equal(controlDelivered({ delivery: 'desktop_runtime', outcome: 'failed' }), false);
  assert.equal(Boolean(controlDelivered(null)), false);
});
