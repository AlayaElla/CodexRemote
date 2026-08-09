const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  console.log('windows UIA layout test skipped on non-Windows');
} else {
  const helperPath = path.join(__dirname, '..', 'src', 'platform', 'windows-uia.ps1');
  function runHelper(request) {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', helperPath
    ], {
      input: JSON.stringify(request),
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || 'PowerShell helper exited unsuccessfully.');
    const output = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
    assert.ok(output, 'PowerShell helper returned no JSON result.');
    return JSON.parse(output);
  }

  const shortcut = runHelper({ operation: 'shortcut-self-test' });
  const expectedSize = process.arch === 'ia32' ? 28 : 40;
  assert.equal(shortcut.success, true, shortcut.error || 'Win32 INPUT layout self-test failed.');
  assert.equal(shortcut.inputSize, expectedSize);
  assert.equal(shortcut.expectedInputSize, expectedSize);

  const selector = runHelper({ operation: 'editor-selector-self-test' });
  assert.equal(selector.success, true, selector.error || 'Windows UIA editor selector self-test failed.');
  assert.ok(selector.testCount >= 5);
  assert.equal(selector.failedCount, 0);
  assert.ok(Array.isArray(selector.selectorTests));
  assert.ok(selector.selectorTests.every((test) => test.Passed === true));

  const source = fs.readFileSync(helperPath, 'utf8');
  assert.match(source, /EnumerateTopLevelWindows/);
  assert.match(source, /ControlType\.Edit/);
  assert.match(source, /ProseMirror/);
  assert.match(source, /editor-selector-self-test/);
  assert.match(source, /operation -eq 'input-state'/);
  assert.match(source, /operation -eq 'wait-for-input'/);
  assert.match(source, /hasText = \$metrics\.HasText/);
  assert.match(source, /nonWhitespaceLength/);
  assert.match(source, /Get-ContentSignature/);
  assert.match(source, /ContentSignature/);
  assert.doesNotMatch(source, /editorToken/);
  assert.doesNotMatch(source, /26\.\d/);
}

console.log('windows UIA layout test passed');
