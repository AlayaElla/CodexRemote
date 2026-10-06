'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readCodexRuntime(target) {
  const metadataPath = path.join(path.dirname(target.executable), 'resources', 'owl-electron-app.json');
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { name: 'electron' };
    throw new Error(`无法读取 Codex 运行时信息：${error.message}`);
  }
  return {
    name: metadata.runtimeName,
    version: target.executable.match(/[\\/]OpenAI\.Codex_([\d.]+)_/i)?.[1] || null
  };
}

module.exports = { readCodexRuntime };
