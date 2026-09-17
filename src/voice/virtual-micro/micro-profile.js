const { TextDecoder } = require('util');
const { encodeHid, encodeText, assertReport, RPC_CHANNEL } = require('./report-codec');

// Compatibility observations include the local Codex Micro host's initial
// lighting-configuration then device-status sequence. This compatibility
// profile is not a public OpenAI protocol or a guarantee for any ChatGPT build.
class MicroProfile {
  static defaultFreshnessMs = 90000;
  // A still-open host connection polls device.status every 60 seconds. Give
  // reconnects a complete poll interval plus time for host scheduling/replies.
  static defaultHandshakeTimeoutMs = 75000;
  constructor(name = 'codex-micro-v1', { getBatteryStatus = () => ({}) } = {}) {
    if (name !== 'codex-micro-v1') throw new Error(`Unknown Micro profile: ${name}`);
    this.name = name;
    this.getBatteryStatus = getBatteryStatus;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.reset();
  }

  reset() {
    this.pending = Buffer.alloc(0);
    this.scanOffset = 0;
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
    this.lastHostAt = 0;
    this.versionSeen = false;
    this.statusSeen = false;
    this.deviceStatusSeen = false;
    this.lightingSeen = false;
    this.hostReports = 0;
    this.rpcRequests = 0;
    this.knownRequests = 0;
    this.feedbackEvents = 0;
  }

  _increment(field) {
    this[field] = Math.min(Number.MAX_SAFE_INTEGER, this[field] + 1);
  }

  ptt(down) { return encodeHid('ACT10', down ? 1 : 0); }

  _readRequests(payload) {
    // The host sends JSON objects without a newline, even when the final HID
    // report is exactly 61 bytes. Device replies use newline framing instead.
    // Scan JSON structure across reports and decode UTF-8 only after a complete
    // object arrives, so strings, nested objects and split codepoints are safe.
    this.pending = Buffer.concat([this.pending, payload]);
    const requests = [];
    while (this.scanOffset < this.pending.length) {
      const byte = this.pending[this.scanOffset++];
      if (this.scanOffset > 65536) throw new Error('Host RPC exceeds message limit.');
      if (!this.depth) {
        if ([9, 10, 13, 32].includes(byte)) continue;
        if (byte !== 123) throw new Error('Invalid host RPC envelope.');
        this.depth = 1;
      } else if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (byte === 92) this.escaped = true;
        else if (byte === 34) this.inString = false;
      } else if (byte === 34) {
        this.inString = true;
      } else if (byte === 123) {
        this.depth++;
      } else if (byte === 125 && --this.depth === 0) {
        requests.push(JSON.parse(this.decoder.decode(this.pending.subarray(0, this.scanOffset))));
        this.pending = this.pending.subarray(this.scanOffset);
        this.scanOffset = 0;
      }
    }
    if (!this.depth) {
      this.pending = Buffer.alloc(0);
      this.scanOffset = 0;
    }
    return requests;
  }

  observe(reports) {
    const responses = [];
    const feedback = [];
    for (const raw of reports) {
      const report = assertReport(raw);
      this._increment('hostReports');
      if (report[1] !== RPC_CHANNEL) continue;
      for (const request of this._readRequests(report.subarray(3, 3 + report[2]))) {
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid host RPC envelope.');
        // Count only the completed JSON envelope, never its contents.  This lets
        // diagnostics distinguish a silent host from an unrecognised protocol.
        this._increment('rpcRequests');
        if (!Object.hasOwn(request, 'id') || typeof request.method !== 'string') continue;
        const validId = request.id === null || Number.isSafeInteger(request.id)
          || (typeof request.id === 'string' && request.id.length <= 128);
        if (!validId) throw new Error('Invalid host RPC identifier.');
        let result;
        let known = true;
        switch (request.method) {
          case 'sys.version':
            result = { version: '1.0.0-vhf' };
            this.versionSeen = true;
            break;
          case 'device.status':
            // The SDK accepts omitted battery fields when no fresh reading is
            // available; null would fail its response validation.
            result = { version: '1.0.0-vhf', profile_index: 0, layer_index: 0, ...this.getBatteryStatus() };
            this.statusSeen = true;
            this.deviceStatusSeen = true;
            break;
          case 'v.oai.rgbcfg':
          case 'v.oai.thstatus':
            result = true;
            this.statusSeen = true;
            this.lightingSeen = true;
            break;
          default:
            known = false;
        }
        if (known) this._increment('knownRequests');
        const response = known ? { id: request.id, result } : {
          id: request.id, error: { code: -32601, message: 'Method not supported.' }
        };
        responses.push(encodeText(`${JSON.stringify(response)}\n`));
        // These are host-originated configuration notifications only. Do not
        // infer task identity, reasoning effort, or Fast from lighting data.
        if (request.method === 'v.oai.rgbcfg' || request.method === 'v.oai.thstatus') {
          this._increment('feedbackEvents');
          feedback.push({
            type: 'micro_lighting_feedback', method: request.method,
            requestId: request.id === null || typeof request.id === 'string' || Number.isSafeInteger(request.id) ? request.id : null,
            observedAt: Date.now()
          });
        }
        if (known) this.lastHostAt = Date.now();
      }
    }
    return { responses, feedback, observedAt: this.lastHostAt, ready: this.isFresh() };
  }

  handshakeComplete() {
    // Reopening our broker does not reopen the host's HID handle. The host can
    // keep polling device.status without replaying version/lighting setup.
    // A complete status request identifies that active RPC session; Controller
    // additionally waits for response acceptance before enabling PTT.
    return this.deviceStatusSeen || (this.versionSeen && this.statusSeen);
  }

  isFresh(maxAgeMs = MicroProfile.defaultFreshnessMs) {
    return this.handshakeComplete() && Date.now() - this.lastHostAt <= maxAgeMs;
  }

  getHandshakeDiagnostics() {
    return {
      hostReports: this.hostReports,
      rpcRequests: this.rpcRequests,
      knownRequests: this.knownRequests,
      versionSeen: this.versionSeen,
      statusSeen: this.statusSeen,
      deviceStatusSeen: this.deviceStatusSeen,
      lightingSeen: this.lightingSeen,
      handshakeComplete: this.handshakeComplete()
    };
  }
}

module.exports = MicroProfile;
