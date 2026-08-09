const assert = require('assert');
const net = require('net');
const WebSocket = require('ws');
const WsServer = require('../src/transports/ws-server');

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

function waitForEvent(emitter, eventName) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), 2000);
    emitter.once(eventName, (...args) => {
      clearTimeout(timeout);
      resolve(args);
    });
  });
}

async function main() {
  const port = await getFreePort();
  const token = 'test-auth-token-1234';
  const server = new WsServer(port, { token });
  let client;

  try {
    await server.start();

    const failedDeliveries = [];
    const collectFailedDelivery = (delivery) => failedDeliveries.push(delivery);
    server.on('device-send', collectFailedDelivery);
    assert.equal(await server.sendToDevice({ type: 'status', state: 'idle' }), false);
    server.removeListener('device-send', collectFailedDelivery);
    assert.deepEqual(failedDeliveries.map((delivery) => delivery.phase), ['sending', 'failed']);
    const failedDelivery = failedDeliveries.at(-1);
    assert.equal(failedDelivery.success, false);
    assert.equal(failedDelivery.message.state, 'idle');

    const unauthorized = new WebSocket(`ws://127.0.0.1:${port}`);
    const unauthorizedStatus = await new Promise((resolve, reject) => {
      unauthorized.once('unexpected-response', (_request, response) => resolve(response.statusCode));
      unauthorized.once('open', () => reject(new Error('Unauthenticated client connected')));
      unauthorized.once('error', reject);
    });
    assert.equal(unauthorizedStatus, 401);

    const connectedPromise = waitForEvent(server, 'device-connected');
    client = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    await waitForEvent(client, 'open');
    await connectedPromise;

    const clientMessagePromise = waitForEvent(client, 'message');
    const successfulDeliveries = [];
    const collectSuccessfulDelivery = (delivery) => successfulDeliveries.push(delivery);
    server.on('device-send', collectSuccessfulDelivery);
    assert.equal(await server.sendToDevice({ type: 'status', state: 'working' }), true);
    server.removeListener('device-send', collectSuccessfulDelivery);
    const [clientPayload] = await clientMessagePromise;
    assert.deepEqual(JSON.parse(clientPayload.toString()), { type: 'status', state: 'working' });
    assert.deepEqual(successfulDeliveries.map((delivery) => delivery.phase), ['sending', 'completed']);
    const successfulDelivery = successfulDeliveries.at(-1);
    assert.equal(successfulDelivery.success, true);
    assert.equal(successfulDelivery.message.state, 'working');

    const deviceMessagePromise = waitForEvent(server, 'device-message');
    client.send(JSON.stringify({ type: 'voice_start' }));
    const [deviceMessage] = await deviceMessagePromise;
    assert.deepEqual(deviceMessage, { type: 'voice_start' });

    const timeoutServer = new WsServer(0, { sendTimeoutMs: 30 });
    timeoutServer.connectedClient = {
      readyState: WebSocket.OPEN,
      deviceAddress: '192.0.2.1',
      bufferedAmount: 128,
      send() {}
    };
    const timeoutStartedAt = Date.now();
    const timeoutDelivery = await timeoutServer.sendToDeviceDetailed({ type: 'status', state: 'idle' });
    assert.equal(timeoutDelivery.success, false);
    assert.equal(timeoutDelivery.phase, 'timeout');
    assert(timeoutDelivery.durationMs >= 30);
    assert(Date.now() - timeoutStartedAt < 500, 'send timeout must resolve instead of hanging');
  } finally {
    if (client && client.readyState !== WebSocket.CLOSED) client.close();
    await server.stop();
  }

  console.log('WebSocket device messaging test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
