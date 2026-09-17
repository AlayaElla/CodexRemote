const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPPORTED_COLLECTORS = new Set(['codex-hooks']);
const APPROVAL_MODES = new Set(['intercept', 'off']);
const TOKEN_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\r\n]/;

function tokenValidationError(token) {
  if (!token) return 'Authentication token is required.';
  if (token.length > 16) return 'Authentication token must be at most 16 characters.';
  if (TOKEN_CONTROL_CHARACTERS.test(token)) {
    return 'Authentication token contains unsupported control characters.';
  }
  return null;
}

function defaultToken() {
  const environmentToken = String(process.env.CODEX_REMOTE_TOKEN ?? '').trim();
  return tokenValidationError(environmentToken) ? generateServiceToken() : environmentToken;
}

function parsePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : fallback;
}

function defaultServiceConfig() {
  const wsPort = parsePort(process.env.CODEX_REMOTE_WS_PORT, 8765);
  let hookPort = parsePort(process.env.CODEX_REMOTE_HOOK_PORT, 7777);
  if (hookPort === wsPort) hookPort = wsPort === 7777 ? 7778 : 7777;
  return {
    wsPort,
    hookPort,
    token: defaultToken(),
    collectorType: process.env.CODEX_REMOTE_COLLECTOR || 'codex-hooks',
    approvalMode: process.env.CODEX_REMOTE_APPROVAL_MODE || 'intercept'
  };
}

function validateServiceConfig(input, fallback = defaultServiceConfig()) {
  const source = input && typeof input === 'object' ? input : {};
  const wsPort = Number(source.wsPort ?? fallback.wsPort);
  const hookPort = Number(source.hookPort ?? fallback.hookPort);
  const collectorType = String(source.collectorType ?? fallback.collectorType).trim();
  const approvalMode = String(source.approvalMode ?? fallback.approvalMode).trim();
  const token = String(source.token ?? fallback.token).trim();
  for (const [label, port] of [['WebSocket', wsPort], ['Hook', hookPort]]) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return { success: false, error: `${label} port must be an integer between 1024 and 65535.` };
    }
  }
  if (wsPort === hookPort) {
    return { success: false, error: 'WebSocket and Hook ports must be different.' };
  }
  if (!SUPPORTED_COLLECTORS.has(collectorType)) {
    return { success: false, error: `Unsupported collector: ${collectorType}` };
  }
  if (!APPROVAL_MODES.has(approvalMode)) {
    return { success: false, error: `Unsupported approval mode: ${approvalMode}` };
  }
  const tokenError = tokenValidationError(token);
  if (tokenError) return { success: false, error: tokenError };

  return {
    success: true,
    config: { wsPort, hookPort, token, collectorType, approvalMode }
  };
}

function generateServiceToken() {
  return crypto.randomBytes(12).toString('base64url');
}

function loadServiceConfig(configFile) {
  const defaults = defaultServiceConfig();
  if (!fs.existsSync(configFile)) {
    saveServiceConfig(configFile, defaults);
    return defaults;
  }

  try {
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const result = validateServiceConfig(saved, defaults);
    return result.success ? result.config : defaults;
  } catch (error) {
    console.warn('[Config] Failed to load service settings:', error.message);
    return defaults;
  }
}

function saveServiceConfig(configFile, config) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
}

module.exports = {
  defaultServiceConfig,
  loadServiceConfig,
  saveServiceConfig,
  validateServiceConfig,
  generateServiceToken
};
