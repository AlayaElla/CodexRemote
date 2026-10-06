const { buildMicroReadProfile } = require('./codex-micro-read-profile');
const { readMicroRenderer } = require('./codex-micro-runtime');

const WINDOW_URL = /^app:\/\/-\/(?:index|detached-window)\.html(?:\?|$)/;

class CodexRendererMicro {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.connectionFactory = options.connectionFactory || (() => {
      const { createRendererConnection } = require('./codex-renderer-connection');
      return createRendererConnection();
    });
    this.buildProfile = options.buildProfile || buildMicroReadProfile;
    this.readRenderer = options.readRenderer || readMicroRenderer;
    this.connection = null;
    this.target = null;
    this.profile = null;
    this.rendererCode = null;
    this.appVersion = null;
  }

  async connect(target) {
    if (this.platform !== 'win32') throw new Error('Renderer Micro runtime currently supports Windows only.');
    if (!target || !Number.isInteger(target.pid) || typeof target.executable !== 'string')
      throw new Error('A verified Codex process is required for Micro synchronization.');
    await this.stop();
    const connection = this.connectionFactory();
    try {
      await connection.open(target);
      const assets = connection.assets();
      if (!assets || !Array.isArray(assets.names) || typeof assets.read !== 'function')
        throw new Error('Codex renderer assets are unavailable.');
      const signals = assets.names.filter(name => /^codex-micro-slot-signals-[\w-]+\.js$/.test(name));
      const bridges = assets.names.filter(name => /^codex-micro-bridge-[\w-]+\.js$/.test(name));
      if (signals.length !== 1 || bridges.length !== 1) throw new Error('Codex Micro bundle structure is unavailable.');
      const signalsName = signals[0], bridgeName = bridges[0], signalsText = assets.read(signalsName);
      const initialName = signalsText.match(/from["']\.\/(app-initial-[\w-]+\.js)["']/)?.[1];
      const sharedName = signalsText.match(/from["']\.\/(app-shared-[\w-]+\.js)["']/)?.[1];
      if (!initialName) throw new Error('Codex Micro module dependencies are unavailable.');
      const profile = this.buildProfile({ signalsName, signalsText,
        initialText: assets.read(initialName), bridgeText: assets.read(bridgeName),
        sharedText: sharedName ? assets.read(sharedName) : undefined });
      if (!profile || profile.signalsName !== signalsName) throw new Error('Codex Micro profile is invalid.');
      this.connection = connection;
      this.target = { pid: target.pid, executable: target.executable };
      this.profile = profile;
      this.rendererCode = `(${this.readRenderer.toString()})(${JSON.stringify(profile)})`;
      this.appVersion = typeof assets.version === 'string' ? assets.version : null;
      return this;
    } catch (error) {
      try { await connection.close?.(); } catch (_) {}
      throw error;
    }
  }

  async read() {
    if (!this.connection || !this.rendererCode) throw new Error('Codex renderer Micro runtime is not connected.');
    const windows = await this.connection.windows();
    const candidates = windows.filter(window => !window.isDestroyed()
      && WINDOW_URL.test(window.webContents.getURL())
      && !/avatar-overlay|global-dictation/.test(window.webContents.getURL()));
    if (!candidates.length) throw new Error('Codex Micro owner window is unavailable.');
    const snapshots = [];
    for (const window of candidates) {
      const snapshot = await window.webContents.executeJavaScript(this.rendererCode);
      if (snapshot) snapshots.push({ ...snapshot, windowId: window.id });
    }
    if (snapshots.length !== 1) throw new Error('Codex Micro owner window is unavailable or ambiguous.');
    return { ...snapshots[0], version: 1, nativeMicroMapping: true,
      processId: this.target.pid, appVersion: this.appVersion };
  }

  async stop() {
    const connection = this.connection;
    this.connection = null;
    this.target = null;
    this.profile = null;
    this.rendererCode = null;
    this.appVersion = null;
    await connection?.close?.();
  }
}

module.exports = { CodexRendererMicro, WINDOW_URL };
