'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') throw new Error('The HID probe requires macOS.');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'macos-virtual-micro', 'CodexRemoteMacHIDProbe');
fs.mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra',
  '-Werror', '-mmacosx-version-min=13.0', '-framework', 'Foundation', '-framework', 'IOKit',
  path.join(root, 'native', 'macos-virtual-micro', 'probe.m'), '-o', output], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(output);
console.log('Build only. Run with --probe to test device creation; no entitlement is fabricated or signed here.');
