const assert = require('assert');
const dgram = require('dgram');
const {
  DISCOVERY_REQUEST_TYPE,
  DISCOVERY_RESPONSE_TYPE,
  PROTOCOL_VERSION,
  DiscoveryServer,
  getLanAddresses
} = require('../src/transports/discovery-server');

function receive(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for discovery response')), timeoutMs);
    socket.once('message', (payload, remote) => {
      clearTimeout(timeout);
      resolve({ payload: JSON.parse(payload.toString('utf8')), remote });
    });
  });
}

async function main() {
  assert.deepEqual(getLanAddresses({
    Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    Public: [{ address: '203.0.113.4', family: 4, internal: false }],
    WiFi: [{ address: '192.168.1.20', family: 'IPv4', internal: false }]
  }), ['192.168.1.20', '203.0.113.4']);

  const server = new DiscoveryServer(9123, { discoveryPort: 0, hostname: 'test-pc' });
  const client = dgram.createSocket('udp4');

  try {
    await server.start();
    const responsePromise = receive(client);
    const request = Buffer.from(JSON.stringify({
      type: DISCOVERY_REQUEST_TYPE,
      protocolVersion: PROTOCOL_VERSION
    }));
    client.send(request, server.discoveryPort, '127.0.0.1');

    const { payload } = await responsePromise;
    assert.deepEqual(payload, {
      type: DISCOVERY_RESPONSE_TYPE,
      protocolVersion: PROTOCOL_VERSION,
      name: 'test-pc',
      wsPort: 9123
    });
  } finally {
    client.close();
    await server.stop();
  }

  console.log('LAN discovery server test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
