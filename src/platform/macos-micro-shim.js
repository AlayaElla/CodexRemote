// Serialized into the identity-verified Codex main process. Only the bundled
// Work Louder node-hid module is patched; existing hardware still delegates.
// Technique reference: mpociot/codex-micro-stream-deck-emulator (MIT).
function installMacMicroShim(requireNative, ownerToken) {
  const { EventEmitter } = requireNative('node:events');
  const path = requireNative('node:path');
  const appPath = requireNative('electron').app.getAppPath();
  const key = '__codexRemoteMicroShimV1';
  const previous = globalThis[key];
  if (previous) {
    if (previous.ownerToken === ownerToken) return previous;
    throw new Error('Another Codex Remote Micro shim is active.');
  }
  const hid = requireNative(path.join(appPath, 'node_modules/@worklouder/device-kit-oai/node_modules/@worklouder/wl-device-kit/node_modules/node-hid'));
  if (typeof hid.devices !== 'function' || typeof hid.HIDAsync?.open !== 'function') {
    throw new Error('Unsupported Codex node-hid interface.');
  }
  const cache = Object.values(requireNative('node:module')._cache);
  const serviceModule = cache.find(m => m.id.startsWith(path.join(appPath, '.vite/build/')) && m.exports?.CodexMicroService);
  const prototype = serviceModule?.exports.CodexMicroService.prototype;
  const topologyModule = cache.find(m => m.id === path.join(process.resourcesPath, 'native/hid-topology-watcher.node'));
  if (!prototype || typeof prototype.updateLighting !== 'function' || typeof prototype.getState !== 'function'
      || typeof prototype.handleHidTopologyChanged !== 'function' || typeof topologyModule?.exports.findCodexMicroInterfaces !== 'function') {
    throw new Error('Unsupported Codex Micro discovery interface.');
  }
  const originalTopology = topologyModule.exports, originalLighting = prototype.updateLighting, originalState = prototype.getState;
  let service = null;
  const descriptor = Object.freeze({ vendorId: 0x303a, productId: 0x8360,
    path: 'codex-remote-micro-shim-v1', serialNumber: 'codex-remote-micro-v1',
    manufacturer: 'Work Louder', product: 'Codex Remote Virtual Micro',
    release: 0x0100, interface: 0, usagePage: 0xff00, usage: 1 });
  const originalDevices = hid.devices, originalAsync = hid.devicesAsync, originalOpen = hid.HIDAsync.open;
  let active = true, device = null, reports = [], enumerations = 0, opens = 0, lease;
  const held = new Set();
  const buttons = new Set(['ACT06', 'ACT07', 'ACT08', 'ACT09', 'ACT10', 'ACT12', 'AG00', 'AG01', 'AG02', 'AG03', 'AG04', 'AG05']);
  const encoders = new Set(['ENC_CW', 'ENC_CC']);
  const raw = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value)) throw new Error('Invalid shim report encoding.');
    const frame = Buffer.from(value, 'base64');
    if (frame.length !== 64 || frame[0] !== 6 || frame[1] !== 2 || frame[2] > 61) throw new Error('Invalid shim report.');
    return frame;
  };
  const status = () => ({ connected: active, driverAvailable: false, hidEnumerated: false,
    shimInstalled: active, hostOpened: Boolean(device && !device.closed), enumerations, opens,
    transport: 'codex_hid_shim', nativeState: service ? originalState.call(service) : null });
  const releaseAll = () => {
    if (device && !device.closed) {
      for (const k of held) {
        const bytes = Buffer.from(JSON.stringify({ m: 'v.oai.hid', p: { k, act: 0 } }) + '\n');
        const frame = Buffer.alloc(64); frame[0] = 6; frame[1] = 2; frame[2] = bytes.length; bytes.copy(frame, 3);
        device.emit('data', frame);
      }
    }
    held.clear();
    return { disposition: 'Accepted', acceptedReportCount: 1 };
  };
  const close = () => {
    if (!active) return;
    releaseAll(); active = false; clearTimeout(lease);
    if (hid.devices === devices) hid.devices = originalDevices;
    if (hid.devicesAsync === devicesAsync) hid.devicesAsync = originalAsync;
    if (hid.HIDAsync.open === open) hid.HIDAsync.open = originalOpen;
    if (topologyModule.exports === patchedTopology) topologyModule.exports = originalTopology;
    if (prototype.updateLighting === updateLighting) prototype.updateLighting = originalLighting;
    if (prototype.getState === getState) prototype.getState = originalState;
    device?.close(); reports = [];
    if (globalThis[key] === api) delete globalThis[key];
  };
  const renew = () => { clearTimeout(lease); lease = setTimeout(close, 5000); lease.unref?.(); };
  const addDescriptor = (list, args) => {
    if (!Array.isArray(list)) throw new Error('Unexpected node-hid enumeration result.');
    // node-hid supports optional VID/PID filters; do not pollute other scans.
    if (!active || (args[0] && args[0] !== descriptor.vendorId) || (args[1] && args[1] !== descriptor.productId)) return list;
    enumerations++;
    return [...list, { ...descriptor }];
  };
  function devices(...args) { return addDescriptor(originalDevices.apply(this, args), args); }
  async function devicesAsync(...args) { return addDescriptor(await originalAsync.apply(this, args), args); }
  const patchedTopology = { ...originalTopology,
    findCodexMicroInterfaces(...args) {
      const result = originalTopology.findCodexMicroInterfaces(...args);
      return result?.then ? result.then(list => addDescriptor(list, [])) : addDescriptor(result, []);
    }
  };
  function discover(instance) {
    if (!active || service === instance || instance.lifecycleState !== 'started') return;
    service = instance;
    queueMicrotask(() => { if (active) instance.handleHidTopologyChanged(); });
  }
  function updateLighting(...args) { discover(this); return originalLighting.apply(this, args); }
  function getState(...args) { discover(this); return originalState.apply(this, args); }
  class ShimDevice extends EventEmitter {
    constructor() { super(); this.closed = false; }
    async write(value) {
      if (!active || this.closed) throw new Error('Micro shim closed.');
      const frame = Buffer.from(value);
      if (frame.length !== 64 || frame[0] !== 6 || ![1, 2].includes(frame[1]) || frame[2] > 61) throw new Error('Invalid host HID report.');
      if (reports.length >= 128) { close(); throw new Error('Micro shim host queue overflow.'); }
      reports.push(frame.toString('base64'));
      return frame.length;
    }
    async getDeviceInfo() { return { ...descriptor }; }
    async close() {
      if (this.closed) return;
      this.closed = true; held.clear(); reports = [];
      if (device === this) device = null;
      this.emit('close');
    }
  }
  async function open(devicePath, ...args) {
    if (devicePath !== descriptor.path) return originalOpen.call(this, devicePath, ...args);
    if (!active || device) throw new Error('Micro shim is unavailable or already open.');
    reports = []; device = new ShimDevice(); opens++;
    return device;
  }
  const api = { ownerToken, status, close, releaseAll, servicePrototype: prototype,
    activateService(instance) {
      if (!active || Object.getPrototypeOf(instance) !== prototype) throw new Error('Invalid Micro service identity.');
      service = instance;
      if (instance.lifecycleState === 'started') instance.handleHidTopologyChanged();
      else instance.start();
      return status();
    },
    poll() { renew(); const result = { ...status(), reports }; reports = []; return result; },
    heartbeat() { renew(); return status(); },
    submit(values) {
      if (!active || !device || device.closed) throw new Error('Codex has not opened the Micro shim.');
      if (!Array.isArray(values) || !values.length || values.length > 64) throw new Error('Invalid shim batch.');
      const frames = values.map(raw);
      const message = JSON.parse(Buffer.concat(frames.map(f => f.subarray(3, 3 + f[2]))).toString('utf8'));
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid shim message.');
      if (message.m !== undefined) {
        const { k, act } = message.p || {};
        if (message.m !== 'v.oai.hid' || !(buttons.has(k) && [0, 1].includes(act) || encoders.has(k) && act === 2)) throw new Error('Unsupported shim control.');
        if (buttons.has(k)) act === 1 ? held.add(k) : held.delete(k);
      } else if (!Object.hasOwn(message, 'id') || !(Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
        throw new Error('Invalid shim RPC response.');
      }
      renew();
      for (const frame of frames) device.emit('data', frame);
      return { disposition: 'Accepted', acceptedReportCount: frames.length };
    }
  };
  hid.devices = devices;
  if (typeof originalAsync === 'function') hid.devicesAsync = devicesAsync;
  hid.HIDAsync.open = open;
  topologyModule.exports = patchedTopology;
  prototype.updateLighting = updateLighting;
  prototype.getState = getState;
  globalThis[key] = api; renew();
  return api;
}

module.exports = { installMacMicroShim };
