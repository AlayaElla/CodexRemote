const WebSocket = require('ws');
const EventEmitter = require('events');
const crypto = require('crypto');

class WsServer extends EventEmitter {
  constructor(port = 8765, options = {}) {
    super();
    this.port = port;
    this.sendTimeoutMs = Number.isFinite(options.sendTimeoutMs) ? options.sendTimeoutMs : 5000;
    this.token = typeof options.token === 'string' ? options.token : '';
    this.wss = null;
    this.connectedClient = null;
    this.isReady = false;
    this.heartbeatTimer = null;
    this.sendSequence = 0;
  }

  isAuthorized(req) {
    if (!this.token) return true;
    const expected = Buffer.from(`Bearer ${this.token}`);
    const supplied = Buffer.from(String(req.headers.authorization || ''));
    return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  }

  static normalizeAddress(address) {
    if (typeof address !== 'string' || address.length === 0) return 'unknown';
    if (address.startsWith('::ffff:')) return address.slice('::ffff:'.length);
    if (address === '::1') return '127.0.0.1';
    return address;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const client = this.connectedClient;
      if (!client || client.readyState !== WebSocket.OPEN) return;

      if (client.isAlive === false) {
        client.missedPongs = (client.missedPongs || 0) + 1;
        if (client.missedPongs >= 2) {
          client.terminate();
          return;
        }
      }

      client.isAlive = false;
      try { client.ping(); } catch (_) { client.terminate(); }
    }, 5000);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocket.Server({
          port: this.port,
          maxPayload: 512 * 1024,
          verifyClient: ({ req }, done) => done(this.isAuthorized(req), 401, 'Unauthorized')
        }, () => {
          console.log(`[WebSocket] Server started on port ${this.port}`);
          this.isReady = true;
          this.startHeartbeat();
          resolve();
        });

        this.wss.on('connection', (ws, req) => {
          const clientIp = WsServer.normalizeAddress(req.socket.remoteAddress);
          console.log(`[WebSocket] Client connected from ${clientIp}`);

          if (this.connectedClient) {
            console.log('[WebSocket] Closing existing connection for new client');
            this.connectedClient.close();
          }

          this.connectedClient = ws;
          ws.deviceAddress = clientIp;
          ws.isAlive = true;
          ws.missedPongs = 0;
          this.emit('device-connected', { address: clientIp });

          ws.on('pong', () => {
            ws.isAlive = true;
            ws.missedPongs = 0;
          });

          ws.on('message', (data, isBinary) => {
            if (this.connectedClient !== ws) return;
            if (isBinary) {
              // Binary Opus Audio Frame
              this.emit('device-audio', data);
            } else {
              // Text JSON Control Frame
              try {
                const message = JSON.parse(data.toString());
                console.log('[WebSocket] Received JSON type:', message?.type);
                this.emit('device-message', message);
              } catch (err) {
                console.error('[WebSocket] Failed to parse JSON message:', err.message);
              }
            }
          });

          ws.on('close', () => {
            console.log(`[WebSocket] Client disconnected: ${clientIp}`);
            if (this.connectedClient === ws) {
              this.connectedClient = null;
              this.emit('device-disconnected');
            }
          });

          ws.on('error', (err) => {
            console.error('[WebSocket] Client error:', err.message);
          });
        });

        this.wss.on('error', (err) => {
          console.error('[WebSocket] Server error:', err.message);
          reject(err);
        });

      } catch (err) {
        reject(err);
      }
    });
  }

  async sendToDeviceDetailed(message) {
    const sendId = `ws-${Date.now()}-${++this.sendSequence}`;
    const startedAt = Date.now();
    let payload;
    try {
      payload = typeof message === 'string' ? message : JSON.stringify(message);
    } catch (err) {
      const delivery = {
        sendId,
        phase: 'failed',
        message,
        success: false,
        error: err.message,
        bytes: 0,
        durationMs: Date.now() - startedAt,
        timestamp: Date.now(),
        target: null
      };
      this.emit('device-send', delivery);
      return delivery;
    }

    const bytes = Buffer.byteLength(payload, 'utf8');
    const client = this.connectedClient;
    const baseDelivery = {
      sendId,
      message,
      bytes,
      target: client ? client.deviceAddress || null : null
    };
    this.emit('device-send', {
      ...baseDelivery,
      phase: 'sending',
      success: null,
      error: null,
      durationMs: 0,
      timestamp: startedAt
    });

    if (!client || client.readyState !== WebSocket.OPEN) {
      console.error('[WebSocket] No connected client to send message to');
      const delivery = {
        ...baseDelivery,
        phase: 'failed',
        success: false,
        error: 'No ESP32 device is connected.',
        durationMs: Date.now() - startedAt,
        timestamp: Date.now()
      };
      this.emit('device-send', delivery);
      return delivery;
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (success, error, phase) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const delivery = {
          ...baseDelivery,
          phase,
          success,
          error: error || null,
          durationMs: Date.now() - startedAt,
          timestamp: Date.now()
        };
        this.emit('device-send', delivery);
        resolve(delivery);
      };
      const timeout = setTimeout(() => {
        finish(false, `Send timed out after ${this.sendTimeoutMs} ms.`, 'timeout');
      }, this.sendTimeoutMs);

      try {
        client.send(payload, (error) => {
          if (error) console.error('[WebSocket] Send failed:', error.message);
          finish(!error, error ? error.message : null, error ? 'failed' : 'completed');
        });
      } catch (error) {
        console.error('[WebSocket] Send failed:', error.message);
        finish(false, error.message, 'failed');
      }
    });
  }

  async sendToDevice(message) {
    const delivery = await this.sendToDeviceDetailed(message);
    return delivery.success;
  }

  stop() {
    if (this.connectedClient) {
      this.connectedClient.close();
      this.connectedClient = null;
    }
    const server = this.wss;
    this.wss = null;
    this.isReady = false;
    this.stopHeartbeat();
    if (!server) return Promise.resolve();
    // A device behind a broken network cannot acknowledge a close frame.
    // Bound shutdown, including sockets replaced by a newer device connection.
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        for (const client of server.clients) client.terminate();
      }, 1000);
      server.close(() => { clearTimeout(timeout); resolve(); });
    });
  }
}

module.exports = WsServer;
