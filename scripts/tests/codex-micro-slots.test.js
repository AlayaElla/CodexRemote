const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMicroSnapshot, parseLinuxCodexProcesses, runtimeSocketPath } = require('../../src/core/codex-micro-slots');

const provisional = 'client-new-thread:11111111-2222-3333-4444-555555555555';
const resolved = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function snapshot(binding = resolved) {
  return {
    version: 1, nativeMicroMapping: true, source: 'recent',
    threadBindings: binding ? { [provisional]: binding } : {},
    slots: Array.from({ length: 6 }, (_, id) => ({ id, threadKey: id === 0 ? `local:${provisional}` :
      `local:${String(id).repeat(8)}-1111-2222-3333-444444444444`, hostId: 'local',
      title: `Task ${id}`, status: 'idle' }))
  };
}

test('resolves a native provisional Micro slot using its persisted thread binding', () => {
  const result = normalizeMicroSnapshot(snapshot());
  assert.equal(result.slots.length, 6);
  assert.equal(result.slots[0].threadId, resolved);
  assert.equal(result.slots[0].hostId, 'local');
  assert.equal(result.slots[0].title, 'Task 0');
  assert.equal(result.slots[1].threadId, '11111111-1111-2222-3333-444444444444');
});

test('an unbound provisional slot keeps the remaining native task list available', () => {
  const result = normalizeMicroSnapshot(snapshot(null));
  assert.equal(result.slots[0].threadId, null);
  assert.equal(result.slots[0].hostId, null);
  assert.equal(result.slots[0].title, 'Task 0');
  assert.equal(result.slots[1].threadId, '11111111-1111-2222-3333-444444444444');
});

test('rejects malformed provisional identifiers instead of routing to a guessed task', () => {
  const input = snapshot();
  input.slots[0].threadKey += ':extra';
  assert.throws(() => normalizeMicroSnapshot(input), /任务标识无效/);
});

test('finds the Linux Codex main process and ignores Electron helpers', () => {
  const processes = parseLinuxCodexProcesses([
    '  42 /opt/Codex/Codex --no-sandbox',
    '  43 /opt/Codex/Codex --type=renderer',
    '  44 /usr/bin/other-app'
  ].join('\n'));
  assert.deepEqual(processes, [{ pid: 42, executable: '/opt/Codex/Codex' }]);
});

test('uses a short Unix socket path on Linux', () => {
  const path = runtimeSocketPath('linux', 42, 'test', '/tmp');
  assert.equal(path, '/tmp/crm-test.sock');
});
