const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

function codexHome(options = {}) {
  const platform = options.platform || process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return options.codexHome || (options.env || process.env).CODEX_HOME || paths.join(options.homeDirectory || os.homedir(), '.codex');
}

function desktopIpcPath(options = {}) {
  const platform = options.platform || process.platform;
  if (options.pipePath) return options.pipePath;
  if (platform === 'win32') return '\\\\.\\pipe\\codex-ipc';
  if (platform === 'darwin') return path.posix.join(codexHome(options), 'ipc', 'ipc.sock');
  throw new Error(`Codex desktop integration is not available on ${platform}.`);
}

// Match Codex's own Unix IPC ownership checks. Never create or remove its socket.
function validateDesktopSocket(socketPath, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return;
  const fileSystem = options.fs || fs;
  const uid = options.uid ?? process.getuid?.();
  const directory = fileSystem.lstatSync(path.posix.dirname(socketPath));
  const socket = fileSystem.lstatSync(socketPath);
  if (!Number.isInteger(uid) || !directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o022)
      || !socket.isSocket() || socket.uid !== uid) {
    throw new Error('Codex IPC socket must be owned by the current user in a private directory.');
  }
}

module.exports = { codexHome, desktopIpcPath, validateDesktopSocket };
