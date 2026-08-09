const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureCodexHooks, EVENT_ROUTES } = require('../src/collectors/codex-hook-installer');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-installer-'));
}

function main() {
  const root = makeTempDir();
  const codexHome = path.join(root, '.codex');
  const sourceHookPath = path.join(root, 'codex-hook.js');
  fs.writeFileSync(sourceHookPath, '#!/usr/bin/env node\nconsole.log("hook");\n', 'utf8');

  try {
    const first = ensureCodexHooks({ codexHome, sourceHookPath, hookPort: 7788 });
    assert.equal(first.state, 'installed');
    assert.equal(first.needsTrustReview, true);
    assert.deepEqual(first.events, Object.keys(EVENT_ROUTES));

    const configPath = path.join(codexHome, 'hooks.json');
    const configBytes = fs.readFileSync(configPath);
    assert.notEqual(configBytes.subarray(0, 3).toString('hex'), 'efbbbf');
    const config = JSON.parse(configBytes.toString('utf8'));
    assert.equal(config.hooks.PreToolUse[0].hooks[0].command.includes('--port 7788'), true);

    config.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] });
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    const second = ensureCodexHooks({ codexHome, sourceHookPath, hookPort: 7788 });
    const merged = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, 'user-hook');
    assert.equal(second.ok, true);

    fs.writeFileSync(configPath, `\uFEFF${JSON.stringify(merged)}`, 'utf8');
    const repaired = ensureCodexHooks({ codexHome, sourceHookPath, hookPort: 7788 });
    assert.equal(repaired.ok, true);
    assert.notEqual(fs.readFileSync(configPath).subarray(0, 3).toString('hex'), 'efbbbf');
    assert(repaired.backupPath);

    fs.writeFileSync(configPath, '{ broken json', 'utf8');
    const invalid = ensureCodexHooks({ codexHome, sourceHookPath, hookPort: 7788 });
    assert.equal(invalid.state, 'repaired');
    assert(invalid.backupPath);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('codex hook installer test passed');
}

main();
