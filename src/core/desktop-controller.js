const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parseShortcut } = require('./keyboard-shortcut');

const DEFAULT_DISCOVERY_INTERVAL_MS = 2000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30000;
const DISCOVERY_TIMEOUT_ERROR = '30 秒内未检测到窗口（ChatGPT Desktop），已停止自动检测。';

function getDefaultHelperPath() {
  const helperPath = path.join(__dirname, '..', 'platform', 'windows-uia.ps1');
  const asarMarker = `${path.sep}app.asar${path.sep}`;
  return helperPath.includes(asarMarker)
    ? helperPath.replace(asarMarker, `${path.sep}app.asar.unpacked${path.sep}`)
    : helperPath;
}

class DesktopController {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 10000;
    this.waitForInputTimeoutMs = Number.isInteger(options.waitForInputTimeoutMs)
      ? Math.max(this.timeoutMs, options.waitForInputTimeoutMs)
      : 25000;
    this.helperPath = options.helperPath || getDefaultHelperPath();
    this.runner = options.runner || ((request) => this.runHelper(request));
    this.defaultSetTimeout = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
    this.defaultClearTimeout = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
    this.defaultNow = typeof options.now === 'function' ? options.now : () => Date.now();
    this.discoverySetTimeout = this.defaultSetTimeout;
    this.discoveryClearTimeout = this.defaultClearTimeout;
    this.discoveryNow = this.defaultNow;
    this.discoveryTimer = null;
    this.discoveryTimeoutTimer = null;
    this.discoveryGeneration = 0;
    this.discoveryProbeInFlightGeneration = null;
    this.discoveryOnUpdate = null;
    this.lastState = {
      supported: this.platform === 'win32',
      available: false,
      lastAction: null,
      error: null,
      discovery: this.createDiscoveryState()
    };
  }

  isSupported() {
    return this.platform === 'win32';
  }

  getState() {
    return {
      ...this.lastState,
      discovery: { ...this.lastState.discovery }
    };
  }

  async sendText(text) {
    const value = String(text || '').trim();
    if (!value) return { success: false, error: 'Message text is required.' };
    return this.execute({ operation: 'send', text: value });
  }

  async focusInput() {
    return this.execute({ operation: 'focus-input' });
  }

  async submitInput() {
    return this.execute({ operation: 'submit-input' });
  }

  async getInputState() {
    return this.execute({ operation: 'input-state' });
  }

  async waitForInput(options = {}) {
    const request = { operation: 'wait-for-input' };
    for (const key of ['timeoutMs', 'pollMs', 'stableMs']) {
      if (Object.prototype.hasOwnProperty.call(options, key)) request[key] = options[key];
    }
    return this.execute(request, { timeoutMs: this.waitForInputTimeoutMs });
  }

  async stopTurn() {
    return this.execute({ operation: 'stop' });
  }

  async newTask() {
    return this.execute({ operation: 'new-task' });
  }

  async sendShortcut(shortcut) {
    let parsed;
    try {
      parsed = parseShortcut(shortcut);
    } catch (error) {
      return { success: false, error: error.message };
    }
    return this.execute({
      operation: 'shortcut',
      shortcut: parsed.shortcut,
      modifiers: parsed.modifiers,
      key: parsed.key
    });
  }

  async probe(options = {}) {
    return this.execute({ operation: 'probe' }, options);
  }

  async execute(request, options = {}) {
    const shouldCommit = typeof options.shouldCommit === 'function'
      ? options.shouldCommit
      : () => true;
    if (!this.isSupported()) {
      const result = { success: false, error: 'ChatGPT Desktop control is only supported on Windows.' };
      if (shouldCommit()) this.updateState(request.operation, result);
      return result;
    }

    try {
      const result = await this.runner(request, options);
      const normalized = result && typeof result === 'object'
        ? result
        : { success: false, error: 'Windows UI Automation returned an invalid response.' };
      if (shouldCommit()) this.updateState(request.operation, normalized);
      return normalized;
    } catch (error) {
      const result = { success: false, error: error.message };
      if (shouldCommit()) this.updateState(request.operation, result);
      return result;
    }
  }

  updateState(operation, result) {
    this.lastState = {
      ...this.lastState,
      available: Boolean(result && result.success),
      lastAction: operation,
      error: result && result.success ? null : (result && result.error) || 'Desktop control failed.',
      discovery: { ...this.lastState.discovery }
    };
  }

  createDiscoveryState(overrides = {}) {
    return {
      state: 'idle',
      active: false,
      attempts: 0,
      startedAt: null,
      deadlineAt: null,
      error: null,
      ...overrides
    };
  }

  notifyDiscoveryUpdate() {
    if (typeof this.discoveryOnUpdate !== 'function') return;
    try {
      this.discoveryOnUpdate(this.getState());
    } catch (_error) {
      // Status observers must not interrupt the discovery loop.
    }
  }

  clearDiscoveryTimers() {
    if (this.discoveryTimer !== null) {
      this.discoveryClearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.discoveryTimeoutTimer !== null) {
      this.discoveryClearTimeout(this.discoveryTimeoutTimer);
      this.discoveryTimeoutTimer = null;
    }
  }

  isDiscoveryCurrent(generation) {
    return this.discoveryGeneration === generation
      && Boolean(this.lastState.discovery && this.lastState.discovery.active);
  }

  stopAutoDiscovery(options = {}) {
    const wasActive = Boolean(this.lastState.discovery && this.lastState.discovery.active);
    this.discoveryGeneration += 1;
    this.clearDiscoveryTimers();
    this.discoveryProbeInFlightGeneration = null;

    if (wasActive && !options.silent) {
      this.lastState = {
        ...this.lastState,
        discovery: this.createDiscoveryState({
          state: 'stopped',
          active: false,
          attempts: this.lastState.discovery.attempts,
          startedAt: this.lastState.discovery.startedAt,
          deadlineAt: this.lastState.discovery.deadlineAt
        })
      };
      this.notifyDiscoveryUpdate();
    }
    this.discoveryOnUpdate = null;
  }

  startAutoDiscovery(options = {}) {
    this.stopAutoDiscovery({ silent: true });

    const intervalMs = Number.isFinite(options.intervalMs)
      ? Math.max(0, options.intervalMs)
      : DEFAULT_DISCOVERY_INTERVAL_MS;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(0, options.timeoutMs)
      : DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.discoverySetTimeout = typeof options.setTimeout === 'function'
      ? options.setTimeout
      : this.defaultSetTimeout;
    this.discoveryClearTimeout = typeof options.clearTimeout === 'function'
      ? options.clearTimeout
      : this.defaultClearTimeout;
    this.discoveryNow = typeof options.now === 'function' ? options.now : this.defaultNow;
    this.discoveryOnUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;

    const generation = this.discoveryGeneration;
    const startedAt = this.discoveryNow();
    const deadlineAt = startedAt + timeoutMs;
    this.lastState = {
      ...this.lastState,
      available: false,
      error: null,
      lastAction: 'probe',
      discovery: this.createDiscoveryState({
        state: this.isSupported() ? 'searching' : 'unsupported',
        active: this.isSupported(),
        startedAt,
        deadlineAt
      })
    };
    this.notifyDiscoveryUpdate();

    if (!this.isSupported()) return { generation, startedAt, deadlineAt };

    const finishTimeout = () => {
      if (!this.isDiscoveryCurrent(generation)) return;
      this.clearDiscoveryTimers();
      this.lastState = {
        ...this.lastState,
        available: false,
        error: DISCOVERY_TIMEOUT_ERROR,
        lastAction: 'probe',
        discovery: {
          ...this.lastState.discovery,
          state: 'timeout',
          active: false,
          error: DISCOVERY_TIMEOUT_ERROR
        }
      };
      this.notifyDiscoveryUpdate();
    };

    this.discoveryTimeoutTimer = this.discoverySetTimeout(finishTimeout, timeoutMs);
    void this.runAutoDiscoveryAttempt(generation, { intervalMs, deadlineAt, finishTimeout });
    return { generation, startedAt, deadlineAt };
  }

  async runAutoDiscoveryAttempt(generation, options) {
    if (!this.isDiscoveryCurrent(generation)) return;
    if (this.discoveryProbeInFlightGeneration === generation) return;
    this.discoveryProbeInFlightGeneration = generation;

    this.lastState = {
      ...this.lastState,
      lastAction: 'probe',
      discovery: {
        ...this.lastState.discovery,
        attempts: this.lastState.discovery.attempts + 1
      }
    };
    this.notifyDiscoveryUpdate();

    let result;
    try {
      result = await this.probe({
        shouldCommit: () => this.isDiscoveryCurrent(generation)
      });
    } finally {
      if (this.discoveryProbeInFlightGeneration === generation) {
        this.discoveryProbeInFlightGeneration = null;
      }
    }

    if (!this.isDiscoveryCurrent(generation)) return;
    if (result && result.success) {
      this.clearDiscoveryTimers();
      this.lastState = {
        ...this.lastState,
        available: true,
        error: null,
        lastAction: 'probe',
        discovery: {
          ...this.lastState.discovery,
          state: 'found',
          active: false,
          error: null
        }
      };
      this.notifyDiscoveryUpdate();
      return;
    }

    this.notifyDiscoveryUpdate();
    const remainingMs = options.deadlineAt - this.discoveryNow();
    if (remainingMs <= 0) {
      options.finishTimeout();
      return;
    }

    this.discoveryTimer = this.discoverySetTimeout(() => {
      this.discoveryTimer = null;
      void this.runAutoDiscoveryAttempt(generation, options);
    }, Math.min(options.intervalMs, remainingMs));
  }

  runHelper(request, options = {}) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(this.helperPath)) {
        reject(new Error(`Windows UI Automation helper not found: ${this.helperPath}`));
        return;
      }

      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', this.helperPath
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const helperTimeoutMs = Number.isInteger(options.timeoutMs)
        ? options.timeoutMs
        : (request.operation === 'wait-for-input' ? this.waitForInputTimeoutMs : this.timeoutMs);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('Windows UI Automation timed out.'));
      }, helperTimeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const output = stdout.trim();
        if (!output) {
          reject(new Error(stderr.trim() || `Windows UI Automation helper exited with code ${code}.`));
          return;
        }
        try {
          resolve(JSON.parse(output.split(/\r?\n/).filter(Boolean).pop()));
        } catch (error) {
          reject(new Error(`Invalid Windows UI Automation response: ${error.message}`));
        }
      });

      child.stdin.end(JSON.stringify(request));
    });
  }
}

module.exports = DesktopController;
module.exports.DEFAULT_DISCOVERY_INTERVAL_MS = DEFAULT_DISCOVERY_INTERVAL_MS;
module.exports.DEFAULT_DISCOVERY_TIMEOUT_MS = DEFAULT_DISCOVERY_TIMEOUT_MS;
module.exports.DISCOVERY_TIMEOUT_ERROR = DISCOVERY_TIMEOUT_ERROR;
