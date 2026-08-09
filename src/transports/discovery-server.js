const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 8766;
const DISCOVERY_REQUEST_TYPE = 'codex-remote-discovery';
const DISCOVERY_RESPONSE_TYPE = 'codex-remote-discovery-response';
const PROTOCOL_VERSION = 1;

function isPrivateIpv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function getLanAddresses(networkInterfaces = os.networkInterfaces()) {
  const addresses = [];
  for (const [interfaceName, entries] of Object.entries(networkInterfaces || {})) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string' ? entry.family : Number(entry.family) === 4 ? 'IPv4' : '';
      if (family !== 'IPv4' || entry.internal || !entry.address) continue;
      addresses.push({ interfaceName, address: entry.address });
    }
  }

  addresses.sort((left, right) => {
    const privateOrder = Number(isPrivateIpv4(right.address)) - Number(isPrivateIpv4(left.address));
    if (privateOrder !== 0) return privateOrder;
    return left.interfaceName.localeCompare(right.interfaceName) || left.address.localeCompare(right.address);
  });
  return addresses.map((entry) => entry.address);
}

class DiscoveryServer {
  constructor(wsPort, options = {}) {
    this.wsPort = Number(wsPort);
    this.discoveryPort = Number.isInteger(options.discoveryPort) ? options.discoveryPort : DISCOVERY_PORT;
    this.hostname = options.hostname || os.hostname();
    this.socket = null;
    this.isReady = false;
  }

  start() {
    if (this.socket) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = socket;

      const fail = (error) => {
        socket.removeAllListeners();
        try { socket.close(); } catch {}
        if (this.socket === socket) this.socket = null;
        this.isReady = false;
        reject(error);
      };

      socket.once('error', fail);
      socket.on('message', (payload, remote) => this.handleMessage(payload, remote));
      socket.bind(this.discoveryPort, '0.0.0.0', () => {
        socket.removeListener('error', fail);
        socket.on('error', (error) => console.error('[Discovery] UDP error:', error.message));
        this.discoveryPort = socket.address().port;
        this.isReady = true;
        resolve();
      });
    });
  }

  handleMessage(payload, remote) {
    if (!this.socket || !this.isReady || !remote || !remote.address || !remote.port) return;

    let request;
    try {
      request = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    if (request.type !== DISCOVERY_REQUEST_TYPE || request.protocolVersion !== PROTOCOL_VERSION) return;

    const response = Buffer.from(JSON.stringify({
      type: DISCOVERY_RESPONSE_TYPE,
      protocolVersion: PROTOCOL_VERSION,
      name: this.hostname,
      wsPort: this.wsPort
    }));
    this.socket.send(response, remote.port, remote.address);
  }

  stop() {
    const socket = this.socket;
    this.socket = null;
    this.isReady = false;
    if (!socket) return Promise.resolve();

    return new Promise((resolve) => {
      socket.close(() => resolve());
    });
  }
}

module.exports = {
  DISCOVERY_PORT,
  DISCOVERY_REQUEST_TYPE,
  DISCOVERY_RESPONSE_TYPE,
  PROTOCOL_VERSION,
  DiscoveryServer,
  getLanAddresses
};
