const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { installMacMicroShim } = require('../../src/platform/macos-micro-shim');
const Controller = require('../../src/voice/macos-shim-controller');
const { encodeText, encodeHid } = require('../../src/voice/virtual-micro/report-codec');

function fixture({ handshake = true } = {}) {
  const hardware = [{ path: 'physical-device', vendorId: 99 }];
  let realOpens = 0, incoming = '', shim, received = [], host;
  const real = { devices: () => hardware, devicesAsync: async () => hardware,
    HIDAsync: { open: async () => { realOpens++; return 'physical-handle'; } } };
  const topology = { id: '/Codex/Contents/Resources/native/hid-topology-watcher.node',
    exports: { watch() {}, findCodexMicroInterfaces: () => hardware } };
  const originalTopology = topology.exports;
  class Service {
    constructor() { this.lifecycleState = 'started'; this.state = { status: 'not-detected' }; }
    getState() { return this.state; }
    updateLighting() { return true; }
    async handleHidTopologyChanged() {
      if (!handshake) return;
      const list = await topology.exports.findCodexMicroInterfaces();
      const item = list.find(x => x.vendorId === 0x303a);
      if (!item) return;
      host = await real.HIDAsync.open(item.path);
      host.on('data', frame => {
        incoming += frame.subarray(3, 3 + frame[2]).toString();
        let end;
        while ((end = incoming.indexOf('\n')) >= 0) {
          const message = JSON.parse(incoming.slice(0, end)); incoming = incoming.slice(end + 1);
          received.push(message);
          if (message.id === 1) this.state = { status: 'connected', controlPlaneStatus: 'ready' };
        }
      });
      for (const report of encodeText(JSON.stringify({ id: 1, method: 'device.status' }))) await host.write(report);
    }
  }
  const service = new Service();
  const originalState = Service.prototype.getState;
  const modules = { _cache: { topology,
    service: { id: '/Codex/app.asar/.vite/build/service-test.js', exports: { CodexMicroService: Service } } } };
  const requireNative = name => {
    if (name === 'node:events') return { EventEmitter };
    if (name === 'node:path') return path;
    if (name === 'node:module') return modules;
    if (name === 'electron') return { app: { getAppPath: () => '/Codex/app.asar' } };
    if (name.endsWith('/node-hid')) return real;
    throw Error(name);
  };
  const install = vm.runInNewContext(`(${installMacMicroShim.toString()})`, {
    Buffer, setTimeout, clearTimeout, queueMicrotask, process: { resourcesPath: '/Codex/Contents/Resources' }
  });
  const runtime = { request: async (type, payload) => {
    if (type === 'micro-connect') { shim = install(requireNative, 'owner'); service.getState(); return shim.status(); }
    if (type === 'micro-poll') return shim.poll();
    if (type === 'micro-heartbeat') return shim.heartbeat();
    if (type === 'micro-submit') return shim.submit(payload.reports);
    if (type === 'micro-releaseAll') return shim.releaseAll();
    if (type === 'micro-close') { shim?.close(); return { closed: true }; }
    throw Error(type);
  } };
  return { real, hardware, topology, originalTopology, Service, originalState, service, runtime,
    install: token => install(requireNative, token), received, realOpens: () => realOpens, host: () => host,
    shim: () => shim };
}

test('native discovery, raw reports and RPC responses are required before controller readiness', async () => {
  const f = fixture(), controller = new Controller({}, { runtime: f.runtime, pollMs: 5, handshakeTimeoutMs: 200 });
  try {
    assert.equal(controller.getStatus().microConnected, false);
    const status = await controller.connect();
    assert.equal(status.transport, 'codex_hid_shim');
    assert.equal(status.microConnected, true);
    assert.equal(status.driverAvailable, false);
    assert.equal(status.hidEnumerated, false, 'process shim never claims an OS HID device');
    assert.equal(f.service.state.status, 'connected');
    assert.equal(status.handshakeDiagnostics.acceptedResponses, 1);
    await controller.setPtt(true);
    await controller.tapKey('AG01');
    assert.deepEqual(f.received.filter(x => x.m).map(x => x.p), [
      { k: 'ACT10', act: 1 }, { k: 'AG01', act: 1 }, { k: 'AG01', act: 0 }]);
  } finally { await controller.close(); }
  assert.deepEqual(f.received.at(-1).p, { k: 'ACT10', act: 0 });
  assert.equal(f.topology.exports, f.originalTopology);
  assert.equal(f.Service.prototype.getState, f.originalState);
});

test('installation alone never reports Micro ready, and timed-out attempts restore discovery', async () => {
  const f = fixture({ handshake: false }), controller = new Controller({}, { runtime: f.runtime, pollMs: 5, handshakeTimeoutMs: 30 });
  try {
    await assert.rejects(controller.connect(), /未收到主机报告/);
    assert.equal(controller.getStatus().microConnected, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.topology.exports, f.originalTopology);
  } finally { await controller.close(); }
});

test('shim preserves physical devices and filtering, rejects competing owners, and restores exports', async () => {
  const f = fixture({ handshake: false }), shim = f.install('one');
  try {
    assert.equal(f.real.devices().length, 2);
    assert.equal(f.real.devices(99).length, 1);
    assert.equal((await f.real.devicesAsync()).length, 2);
    assert.equal(await f.real.HIDAsync.open('physical-device'), 'physical-handle');
    assert.equal(f.realOpens(), 1);
    assert.throws(() => f.install('two'), /Another/);
    assert.equal(f.install('one'), shim);
  } finally { shim.close(); }
  assert.equal(f.real.devices(), f.hardware);
  assert.equal(f.topology.exports, f.originalTopology);
});

test('shim validates frames and control allowlist before emitting input', async () => {
  const f = fixture();
  await f.runtime.request('micro-connect');
  await new Promise(resolve => setImmediate(resolve));
  try {
    const shim = f.shim();
    assert.throws(() => shim.submit(['bad']), /encoding/);
    assert.throws(() => shim.submit(encodeText('{"m":"v.oai.hid","p":{"k":"UNKNOWN","act":1}}').map(x => x.toString('base64'))), /Unsupported/);
    assert.equal(f.received.length, 0);
    shim.submit(encodeHid('ACT10', 1).map(x => x.toString('base64')));
    shim.releaseAll();
    assert.deepEqual(f.received.map(x => x.p.act), [1, 0]);
  } finally { f.shim().close(); }
});

test('old cleanup cannot remove a reconnected shim, and host disconnect clears readiness', async () => {
  const f = fixture(), controller = new Controller({}, { runtime: f.runtime, pollMs: 5, handshakeTimeoutMs: 200 });
  try {
    await controller.connect();
    await controller.close();
    await controller.connect();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(controller.getStatus().microConnected, true);
    assert.equal(f.shim().status().shimInstalled, true);
    await f.host().close();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(controller.getStatus().microConnected, false);
  } finally { await controller.close(); }
});
