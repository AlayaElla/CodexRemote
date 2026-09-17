// Application heartbeats remain separate from task updates and WebSocket pings.
// The device can therefore detect a stalled bridge even while the socket lives.
class BridgeConnectionStatus {
  constructor({ server, getCodexConnected, timers = global, intervalMs = 2000 }) {
    this.server = server;
    this.getCodexConnected = getCodexConnected;
    this.timers = timers;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    if (this.timer || this.stopped) return;
    this.timer = this.timers.setInterval(() => { void this.publish(); }, this.intervalMs);
    this.timer.unref?.();
    void this.publish();
  }

  async publish(state = 'ready') {
    if ((this.stopped && state !== 'stopping') || this.server.connectedClient?.readyState !== 1) return false;
    try {
      return await this.server.sendToDevice({ type: 'bridge_status', version: 1, state,
        codexConnected: state === 'ready' && this.getCodexConnected() === true });
    } catch (_) {
      // A failed heartbeat must not keep the bridge or its shutdown alive.
      return false;
    }
  }

  stop() {
    if (this.stopped) return Promise.resolve(false);
    this.stopped = true;
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
    return this.publish('stopping');
  }
}

module.exports = BridgeConnectionStatus;
