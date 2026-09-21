const Esp32AudioBridge = require('./esp32-audio-bridge');

// Bidirectional helper wrapper. The inherited API remains the ESP32 microphone
// path; capture_* is an independent, explicitly selected Windows render path.
class RealtimeAudioBridge extends Esp32AudioBridge {
  constructor(options = {}) {
    super(options);
    this.capture = { active: false, deviceId: null, captureId: null, generation: 0 };
  }

  async listCaptureDevices() {
    const result = await this.request('capture_list', {}, 10000);
    return Array.isArray(result.devices) ? result.devices : [];
  }

  async startCapture(outputDeviceId, inputDeviceId = '') {
    if (typeof outputDeviceId !== 'string' || !outputDeviceId.trim()) {
      throw new Error('A dedicated render outputDeviceId is required for realtime audio capture.');
    }
    if (this.capture.active) throw new Error('Realtime audio capture is already active.');
    const generation = ++this.capture.generation;
    const result = await this.request('capture_start', { deviceId: outputDeviceId, inputDeviceId }, 10000);
    if (generation !== this.capture.generation) {
      await this.request('capture_stop', {}, 3000).catch(() => {});
      throw new Error('Realtime audio capture was cancelled before it started.');
    }
    this.capture = { active: true, deviceId: outputDeviceId, captureId: result.captureId || null, generation };
    return { ...result };
  }

  async stopCapture() {
    if (!this.capture.active) return { stopped: false };
    ++this.capture.generation; // Ignore queued capture_audio emitted before native stop completes.
    this.capture.active = false;
    this.capture.captureId = null;
    try { return await this.request('capture_stop', {}, 5000); }
    finally { this.capture.deviceId = null; }
  }

  handleEvent(response, runtime = this.runtime) {
    if (response.event === 'capture_audio') {
      const capture = this.capture;
      if (!capture.active || !capture.captureId || response.captureId !== capture.captureId) return;
      if (typeof response.packet !== 'string' || !Number.isSafeInteger(response.sequence)) return;
      this.emit('audio', {
        packet: response.packet,
        sampleRate: Number(response.sampleRate) || 16000,
        frameDuration: Number(response.frameDuration) || 20,
        sequence: response.sequence
      });
      return;
    }
    if (response.event === 'capture_fault') {
      const capture = this.capture;
      if (!capture.active || !capture.captureId || response.captureId !== capture.captureId) return;
      capture.active = false;
      capture.captureId = null;
      capture.deviceId = null;
      this.emit('fault', new Error(response.error || 'Realtime audio capture failed.'));
      return;
    }
    super.handleEvent(response, runtime);
  }

  async dispose() {
    this.capture.active = false;
    this.capture.captureId = null;
    ++this.capture.generation;
    return super.dispose();
  }
}

module.exports = RealtimeAudioBridge;
