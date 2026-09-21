const assert = require('node:assert/strict');
const { test } = require('node:test');
const { launch, parseListeners, connectInspector, INSPECT_ARGUMENT } = require('../start-codex-with-inspector-macos');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { renderLauncher } = require('../build-macos-inspector-launcher');

const app = '/Applications/ChatGPT.app';
const executable = `${app}/Contents/MacOS/ChatGPT`;
function fixture(overrides = {}) {
  let started = false, connections = 0, closed = 0;
  const calls = [], evaluations = [];
  const options = {
    platform: 'darwin', appPath: app, exists: () => true, attempts: 2, delay: async () => {},
    run: async (file, args) => {
      calls.push({ file, args });
      if (file === '/usr/bin/plutil') return { stdout: JSON.stringify({ CFBundleIdentifier: overrides.bundleId || 'com.openai.codex',
        CFBundleExecutable: 'ChatGPT', CFBundleShortVersionString: 'test' }) };
      if (file === '/bin/ps') return { stdout: started ? `42 ${executable}\n` : overrides.before || '' };
      if (file === '/usr/sbin/lsof') {
        if (overrides.lsofFailure) throw new Error('permission denied');
        const rows = started ? overrides.afterPort ?? 'p42\nn127.0.0.1:9229\n' : overrides.beforePort || '';
        if (!rows) throw Object.assign(new Error('no matches'), { code: 1, stdout: '', stderr: '' });
        return { stdout: rows };
      }
      if (file === '/usr/bin/open') { started = true; return { stdout: '' }; }
      throw new Error(`Unexpected executable: ${file}`);
    },
    connectInspector: async () => {
      connections++;
      return { evaluate: async expression => { evaluations.push(expression); return overrides.identity || { pid: 42, executable }; },
        close: () => closed++ };
    }
  };
  return { options, calls, evaluations, started: () => started, connections: () => connections, closed: () => closed };
}

test('check-only reports state without starting, signalling, or connecting', async t => {
  const signal = t.mock.method(process, '_debugProcess', () => { throw new Error('must not signal'); });
  const f = fixture({ before: `42 ${executable}` });
  const result = await launch({ ...f.options, checkOnly: true });
  assert.equal(result.running, 1);
  assert.deepEqual(result.arguments, [INSPECT_ARGUMENT]);
  assert.equal(f.started(), false);
  assert.equal(f.connections(), 0);
  assert.equal(signal.mock.callCount(), 0);
});

test('running Codex, old bridge, occupied port, and wrong app reject before launch', async () => {
  for (const [overrides, message] of [
    [{ before: `42 ${executable}` }, /完全退出 Codex/],
    [{ before: '43 /Applications/Codex Remote.app/Contents/MacOS/Codex Remote' }, /先退出 Codex Remote/],
    [{ beforePort: 'p99\nn127.0.0.1:9229\n' }, /端口已被占用/],
    [{ bundleId: 'com.unrelated.app' }, /不是 Codex/],
    [{ lsofFailure: true }, /permission denied/]
  ]) {
    const f = fixture(overrides);
    await assert.rejects(launch(f.options), message);
    assert.equal(f.started(), false);
    assert.equal(f.connections(), 0);
  }
});

test('cold start passes only loopback inspect argument and verifies identity', async t => {
  const signal = t.mock.method(process, '_debugProcess', () => { throw new Error('must not signal'); });
  const f = fixture();
  const result = await launch(f.options);
  assert.equal(result.ready, true);
  assert.equal(result.pid, 42);
  assert.deepEqual(f.calls.find(call => call.file === '/usr/bin/open').args, ['-a', app, '--args', '--inspect=127.0.0.1:9229']);
  assert.deepEqual(f.evaluations, ['({pid:process.pid,executable:process.execPath})']);
  assert.equal(f.closed(), 1);
  assert.equal(signal.mock.callCount(), 0);
});

test('foreign or exposed listener is rejected before connecting', async () => {
  for (const afterPort of ['p99\nn127.0.0.1:9229\n', 'p42\nn*:9229\n', 'p42\nn0.0.0.0:9229\n']) {
    const f = fixture({ afterPort });
    await assert.rejects(launch(f.options), /归属或监听地址不匹配/);
    assert.equal(f.connections(), 0);
  }
});

test('mismatched inspector identity closes only the client connection', async () => {
  const f = fixture({ identity: { pid: 99, executable } });
  await assert.rejects(launch(f.options), /身份不匹配/);
  assert.equal(f.closed(), 1);
  assert.equal(f.evaluations.length, 1);
});

test('unavailable startup inspector never falls back to a signal', async t => {
  const signal = t.mock.method(process, '_debugProcess', () => { throw new Error('must not signal'); });
  const f = fixture({ afterPort: '' });
  await assert.rejects(launch(f.options), /未提供启动时调试接口/);
  assert.equal(signal.mock.callCount(), 0);
  assert.equal(f.connections(), 0);
});

test('listener parser keeps every listener and its owner', () => {
  assert.deepEqual(parseListeners('p42\nf10\nn127.0.0.1:9229\np99\nn*:9229\n'), [
    { pid: 42, address: '127.0.0.1:9229' }, { pid: 99, address: '*:9229' }
  ]);
});

test('standalone command runs after moving away from the repository without sibling JS or modules', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Codex launcher moved '));
  try {
    const source = fs.readFileSync(path.join(__dirname, '../start-codex-with-inspector-macos.js'), 'utf8');
    const generated = fs.readFileSync(path.join(__dirname, '../启动Codex.command'), 'utf8');
    assert.equal(generated, renderLauncher(source), 'generated artifact must match tested source');
    const moved = path.join(directory, 'Start Codex.command');
    fs.writeFileSync(moved, generated, { mode: 0o755 });
    const result = spawnSync('/bin/zsh', [moved, '--check-only', `--app=${directory}/Missing.app`], {
      cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` }
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /未找到 Codex 应用/);
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
    assert.deepEqual(fs.readdirSync(directory), ['Start Codex.command']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// An isolated ephemeral port, never the real Codex endpoint.
test('standalone native WebSocket verifies identity and rejects invalid endpoint responses', async () => {
  let mode = 'valid', port;
  const calls = [];
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/json/list');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([{ type: 'node', webSocketDebuggerUrl:
      mode === 'foreign' ? `ws://192.0.2.1:${port}/test` : `ws://127.0.0.1:${port}/test` }]));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data.toString());
    calls.push(request);
    socket.send(mode === 'malformed' ? 'invalid-json' : JSON.stringify({ id: request.id,
      result: { result: { value: { pid: 42, executable } } } }));
  }));
  let client;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
    client = await connectInspector({ port });
    assert.deepEqual(await client.evaluate('({pid:process.pid,executable:process.execPath})'), { pid: 42, executable });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'Runtime.evaluate');
    client.close(); client = null;
    mode = 'foreign';
    await assert.rejects(connectInspector({ port }), /本地调试端点无效/);
    mode = 'malformed';
    client = await connectInspector({ port });
    await assert.rejects(client.evaluate('({pid:process.pid,executable:process.execPath})'));
  } finally {
    client?.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});
