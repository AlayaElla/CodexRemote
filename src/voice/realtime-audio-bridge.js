const Esp32AudioBridge = require('./esp32-audio-bridge');

function sameCableRoute(left, right) {
  const cable = name => typeof name === 'string' && /^CABLE(?:-[A-Z])? (?:Input|In 16ch) \(.+\)$/i.test(name)
    ? name.replace(/ In 16ch /i, ' Input ').toLowerCase() : null;
  const a = cable(left), b = cable(right);
  return a !== null && a === b;
}

class CaptureHelper extends Esp32AudioBridge {
  handleEvent(response, runtime = this.runtime) {
    if (runtime !== this.runtime) return;
    if (response.event === 'capture_audio' || response.event === 'capture_fault') this.emit('capture-event', response);
    else super.handleEvent(response, runtime);
  }
}

// Bidirectional helper wrapper. The inherited API remains the ESP32 microphone
// path; capture_* is an independent, explicitly selected Windows render path.
class RealtimeAudioBridge extends Esp32AudioBridge {
  constructor(options = {}) {
    super(options);
    this.capture = { active: false, deviceId: null, captureId: null, generation: 0 };
    // WASAPI loopback initialization can block when this same helper already
    // owns the microphone render stream. Separate processes also isolate faults.
    this.captureHelper = new CaptureHelper(options);
    this.captureHelper.on('capture-event', response => this.handleCaptureEvent(response));
    this.captureHelper.on('fault', error => {
      this.capture.active = false;
      this.capture.captureId = null;
      this.capture.deviceId = null;
      ++this.capture.generation;
      this.emit('fault', error);
    });
  }

  async listCaptureDevices() {
    const result = await this.captureHelper.request('capture_list', {}, 10000);
    return Array.isArray(result.devices) ? result.devices : [];
  }

  async startCapture(outputDeviceId, inputDeviceId = '') {
    if (typeof outputDeviceId !== 'string' || !outputDeviceId.trim()) {
      throw new Error('A dedicated render outputDeviceId is required for realtime audio capture.');
    }
    if (this.capture.active) throw new Error('Realtime audio capture is already active.');
    if ((this.options.platform || process.platform) === 'darwin' && !inputDeviceId.trim()) {
      throw new Error('Mac 实时语音需要明确选择麦克风 BlackHole 设备，并为回答选择另一条 BlackHole 线路。');
    }
    const generation = ++this.capture.generation;
    const devices = await this.listCaptureDevices();
    const selected = devices.find(device => device.id === outputDeviceId);
    if (!selected) throw new Error('所选回答音频设备不可用，请重新选择。');
    const inputName = this.status.deviceName || devices.find(device => device.id === inputDeviceId)?.name;
    if (outputDeviceId === inputDeviceId || sameCableRoute(inputName, selected.name)) {
      throw new Error('回答音频与 ESP32 麦克风使用了同一条虚拟线。CABLE Input 和 CABLE In 16ch 不是独立线路，请选择另一音频设备。');
    }
    if (generation !== this.capture.generation) throw new Error('Realtime audio capture was cancelled before it started.');
    // WASAPI can spend over 10 seconds initializing an idle render endpoint.
    // Keep startup gated on its reply; this is separate from the Codex handshake.
    const result = await this.captureHelper.request('capture_start', { deviceId: outputDeviceId, inputDeviceId }, 30000);
    if (generation !== this.capture.generation) {
      await this.captureHelper.request('capture_stop', {}, 3000).catch(() => {});
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
    try { return await this.captureHelper.request('capture_stop', {}, 5000); }
    finally { this.capture.deviceId = null; }
  }

  handleCaptureEvent(response) {
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
  }

  async dispose() {
    this.capture.active = false;
    this.capture.captureId = null;
    ++this.capture.generation;
    await Promise.all([this.captureHelper.dispose(), super.dispose()]);
  }
}

module.exports = RealtimeAudioBridge;
module.exports.sameCableRoute = sameCableRoute;
