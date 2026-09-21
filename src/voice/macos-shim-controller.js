const Controller = require('./virtual-micro/controller');
const MacController = require('./macos-controller');
const { CodexMicroSlots } = require('../core/codex-micro-slots');
const { createMacShimBroker } = require('./virtual-micro/macos-shim-broker');

class MacShimController extends Controller {
  constructor(config = {}, options = {}) {
    const runtime = options.runtime || new CodexMicroSlots({ platform: 'darwin' });
    super(config, { ...options, spawn: () => createMacShimBroker(runtime, options) });
    this.runtime = runtime;
    this.ownsRuntime = !options.runtime;
    this.auxiliary = new MacController(config, { ...options, runtime });
    this.state.supported = true;
    this.state.transport = 'codex_hid_shim';
  }
  _transportReady(info) { return info.connected === true && info.shimInstalled === true; }
  // Text insertion and Escape are separate runtime capabilities. All Micro
  // keys, including task selection and PTT, use the native HID/RPC channel.
  pasteText(text, context) { return this.auxiliary.pasteText(text, context); }
  escape(options) { return this.auxiliary.escape(options); }
  resolveMicroDraft(context) { return this.auxiliary.resolveMicroDraft(context); }
  async close() {
    try { await super.close(); }
    finally { if (this.ownsRuntime) this.runtime.stop(); }
  }
}
module.exports = MacShimController;
