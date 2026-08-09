const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENT_ROUTES = Object.freeze({
  UserPromptSubmit: 'user-prompt',
  PreToolUse: 'pre',
  PostToolUse: 'post',
  PermissionRequest: 'waiting',
  Stop: 'stop'
});

function resolveCodexHome(env = process.env, homeDir = os.homedir()) {
  return env.CODEX_HOME || path.join(homeDir, '.codex');
}

function collectStrings(value, result = []) {
  if (typeof value === 'string') {
    result.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, result));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStrings(item, result));
  }
  return result;
}

function isManagedEntry(entry, route) {
  return collectStrings(entry).some((value) => (
    value.includes('codex-hook.js') && value.includes(` ${route} `)
  ));
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.${stamp}.bak`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return { value: {}, hadBom: false, parseError: null };
  }

  const raw = fs.readFileSync(configPath);
  const hadBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const text = raw.toString('utf8').replace(/^\uFEFF/, '');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('hooks config root must be an object');
    }
    return { value, hadBom, parseError: null };
  } catch (error) {
    return { value: {}, hadBom, parseError: error };
  }
}

function writeConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function buildManagedEntry(hookPath, route) {
  return {
    matcher: '',
    hooks: [{
      type: 'command',
      command: `node "${hookPath}" ${route} --port {{HOOK_PORT}}`
    }]
  };
}

/**
 * Install or repair the user-level Codex hooks without replacing user hooks.
 * Codex trust is intentionally not changed here; the user must review the
 * resulting commands in Codex's Hooks UI.
 */
function ensureCodexHooks(options = {}) {
  const codexHome = options.codexHome || resolveCodexHome(options.env, options.homeDir);
  const hookPort = Number(options.hookPort || 7777);
  const sourceHookPath = options.sourceHookPath || path.resolve(__dirname, '..', '..', 'hooks', 'codex-hook.js');
  const installedHookPath = options.installedHookPath || path.join(codexHome, 'remote-hooks', 'codex-hook.js');
  const configPath = path.join(codexHome, 'hooks.json');

  if (!Number.isInteger(hookPort) || hookPort < 1024 || hookPort > 65535) {
    throw new Error(`invalid Codex hook port: ${hookPort}`);
  }
  if (!fs.existsSync(sourceHookPath)) {
    throw new Error(`hook script not found: ${sourceHookPath}`);
  }

  fs.mkdirSync(path.dirname(installedHookPath), { recursive: true });
  const source = fs.readFileSync(sourceHookPath);
  let hookChanged = true;
  try {
    hookChanged = !source.equals(fs.readFileSync(installedHookPath));
  } catch {}
  if (hookChanged) fs.writeFileSync(installedHookPath, source);

  const read = readConfig(configPath);
  const config = { ...read.value };
  const existingHooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks
    : {};
  const nextHooks = { ...existingHooks };
  let configChanged = read.hadBom || Boolean(read.parseError) || !config.hooks;

  for (const [eventName, route] of Object.entries(EVENT_ROUTES)) {
    const prior = Array.isArray(existingHooks[eventName]) ? existingHooks[eventName] : [];
    const filtered = prior.filter((entry) => !isManagedEntry(entry, route));
    const managed = buildManagedEntry(installedHookPath, route);
    managed.hooks[0].command = managed.hooks[0].command.replace('{{HOOK_PORT}}', String(hookPort));
    nextHooks[eventName] = [...filtered, managed];
    if (JSON.stringify(prior) !== JSON.stringify(nextHooks[eventName])) configChanged = true;
  }
  config.hooks = nextHooks;

  let backupPath = null;
  if (read.parseError || configChanged) {
    backupPath = backupFile(configPath);
    writeConfig(configPath, config);
  }

  return {
    ok: true,
    state: read.parseError ? 'repaired' : configChanged ? 'installed' : 'ready',
    configPath,
    hookPath: installedHookPath,
    backupPath,
    events: Object.keys(EVENT_ROUTES),
    trust: 'unknown',
    needsTrustReview: true,
    changed: Boolean(hookChanged || configChanged || read.parseError)
  };
}

module.exports = {
  EVENT_ROUTES,
  resolveCodexHome,
  readConfig,
  ensureCodexHooks
};
