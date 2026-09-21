'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELP = `Codex Remote 应用打包

用法：npm run package -- [--arch=arm64|x64]

Windows：构建 x64 便携版，输出 build/pc/。
macOS：构建当前架构的 DMG 和 ZIP，输出 build/mac/。
--arch 仅用于 macOS，必须与当前机器架构一致。
--help 显示帮助，不执行构建。`;

function packagingCommand(platform, args) {
  if (platform === 'win32') {
    if (args.length) throw new Error(`Windows 打包不支持参数：${args.join(' ')}`);
    return { command: 'powershell', args: [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'package-pc.ps1')
    ] };
  }
  if (platform === 'darwin') {
    return { command: process.execPath, args: [path.join(__dirname, 'package-macos.js'), ...args] };
  }
  throw new Error(`不支持在 ${platform} 上打包应用。`);
}

function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  try {
    const invocation = packagingCommand(process.platform, args);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'inherit'
    });
    if (result.error) throw result.error;
    return result.status === null ? 1 : result.status;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main, packagingCommand };
