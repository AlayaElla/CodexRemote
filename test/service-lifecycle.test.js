const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const WsServer = require('../src/transports/ws-server');
const AgentBridge = require('../src/core/agent-bridge');
const { createCollector } = require('../src/collectors');
const {
  defaultServiceConfig,
  generateServiceToken,
  loadServiceConfig,
  saveServiceConfig,
  validateServiceConfig
} = require('../src/core/service-config');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/health`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(body) }));
    });
    request.once('error', reject);
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-test-'));
  const configFile = path.join(tempDir, 'service-config.json');
  const hadTokenEnv = Object.prototype.hasOwnProperty.call(process.env, 'CODEX_REMOTE_TOKEN');
  const originalTokenEnv = process.env.CODEX_REMOTE_TOKEN;
  let wsServer;
  let codexBridge;

  try {
    delete process.env.CODEX_REMOTE_TOKEN;
    const defaultConfig = defaultServiceConfig();
    assert.equal(defaultConfig.token.length, 16);
    assert.match(defaultConfig.token, /^[A-Za-z0-9_-]{16}$/);
    const firstLaunchConfigFile = path.join(tempDir, 'first-launch-config.json');
    const firstLaunchConfig = loadServiceConfig(firstLaunchConfigFile);
    assert.equal(firstLaunchConfig.token.length, 16);
    assert.match(firstLaunchConfig.token, /^[A-Za-z0-9_-]{16}$/);
    for (const environmentToken of ['e', 'v'.repeat(16)]) {
      process.env.CODEX_REMOTE_TOKEN = environmentToken;
      assert.equal(defaultServiceConfig().token, environmentToken);
    }
    for (const invalidEnvironmentToken of ['x'.repeat(17), '   ', 'bad\nvalue']) {
      process.env.CODEX_REMOTE_TOKEN = invalidEnvironmentToken;
      const fallbackConfig = defaultServiceConfig();
      assert.equal(fallbackConfig.token.length, 16);
      assert.match(fallbackConfig.token, /^[A-Za-z0-9_-]{16}$/);
      assert.notEqual(fallbackConfig.token, invalidEnvironmentToken);
    }

    const wsPort = await getFreePort();
    const hookPort = await getFreePort();
    const validation = validateServiceConfig({
      wsPort,
      hookPort,
      token: 'x'.repeat(16),
      collectorType: 'codex-hooks',
      approvalMode: 'off'
    });
    assert.equal(validation.success, true);
    assert.equal(validation.config.approvalMode, 'off');
    assert.equal(validation.config.token.length, 16);
    assert.equal(validateServiceConfig({ wsPort, hookPort, token: 'x' }).success, true);
    assert.equal(validateServiceConfig({ wsPort, hookPort, token: 'x'.repeat(16) }).success, true);
    assert.equal(validateServiceConfig({ wsPort, hookPort, token: 'x'.repeat(17) }).success, false);
    assert.equal(validateServiceConfig({ wsPort, hookPort, token: '' }).success, false);
    const generatedTokenA = generateServiceToken();
    const generatedTokenB = generateServiceToken();
    assert.equal(generatedTokenA.length, 16);
    assert.equal(generatedTokenB.length, 16);
    assert.match(generatedTokenA, /^[A-Za-z0-9_-]{16}$/);
    assert.match(generatedTokenB, /^[A-Za-z0-9_-]{16}$/);
    assert.notEqual(generatedTokenA, generatedTokenB);
    assert.equal(validateServiceConfig({ wsPort, hookPort, token: '   ' }).success, false);
    assert.equal(validateServiceConfig({ wsPort, hookPort, token: 'a\nvalid-token' }).success, false);
    assert.equal(validateServiceConfig({ wsPort, hookPort: wsPort, collectorType: 'codex-hooks' }).success, false);
    assert.equal(validateServiceConfig({ wsPort, hookPort, collectorType: 'unknown' }).success, false);
    assert.equal(validateServiceConfig({ wsPort, hookPort, collectorType: 'codex-hooks', approvalMode: 'invalid' }).success, false);

    saveServiceConfig(configFile, validation.config);
    assert.deepEqual(loadServiceConfig(configFile), validation.config);

    wsServer = new WsServer(wsPort, { token: validation.config.token });
    codexBridge = new AgentBridge(createCollector('codex-hooks', { hookPort }));
    await wsServer.start();
    await codexBridge.start();

    assert.equal(wsServer.isReady, true);
    assert.equal(codexBridge.isRunning(), true);
    const health = await getHealth(hookPort);
    assert.equal(health.statusCode, 200);
    assert.equal(health.body.port, hookPort);
    assert.equal(health.body.collector, 'codex-hooks');
  } finally {
    if (hadTokenEnv) process.env.CODEX_REMOTE_TOKEN = originalTokenEnv;
    else delete process.env.CODEX_REMOTE_TOKEN;
    if (wsServer) await wsServer.stop();
    if (codexBridge) await codexBridge.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('service lifecycle test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
