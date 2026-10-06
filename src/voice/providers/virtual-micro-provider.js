const VoiceProvider = require('./voice-provider');
const { EventEmitter } = require('events');
const Esp32AudioBridge = require('../esp32-audio-bridge');
const { controlDelivered } = require('../control-delivery');

const AUDIO_SOURCES = new Set(['esp32', 'computer']);
const AUDIO_PREPARATION_CHECK_MS = 2000;

function normalizeAudioConfig(config = {}) {
  const audioSource = String(config.audioSource || 'esp32').trim().toLowerCase();
  if (!AUDIO_SOURCES.has(audioSource)) throw new Error(`Unsupported Virtual Micro audio source: ${config.audioSource}`);
  if (config.audioDeviceId !== undefined && typeof config.audioDeviceId !== 'string') {
    throw new Error('Virtual Micro audio device id must be a string.');
  }
  return { audioSource, audioDeviceId: String(config.audioDeviceId || '').trim() };
}

function loadController(options = {}) {
  if ((options.controllerOptions?.platform || options.platform || process.platform) === 'darwin') return require('../macos-controller');
  try {
    return require('../virtual-micro/controller');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND'
      && String(error.message || '').includes('virtual-micro/controller')) {
      throw new Error('Virtual Micro controller is unavailable. Install or start the bundled HID broker first.');
    }
    throw error;
  }
}

class VirtualMicroProvider extends VoiceProvider {
  constructor(config = {}, options = {}) {
    super('virtual_micro');
    this.config = {
      profile: String(config.profile || 'codex-micro-v1'),
      ...normalizeAudioConfig(config)
    };
    const Controller = options.controller ? null : loadController(options);
    this.controller = options.controller || new Controller(this.config, options.controllerOptions || {});
    this.lastError = null;
    this.releaseUncertain = false;
    this.pressPending = false;
    this.events = new EventEmitter();
    this.lastAudioStatusAt = 0;
    this.audioStatusTimer = null;
    this.audioBridgeOptions = options.audioBridgeOptions || {};
    this.audioBridgeFactory = options.audioBridgeFactory || ((bridgeOptions) => new Esp32AudioBridge(bridgeOptions));
    this.audioBridge = null;
    this.audioPreparationTimer = null;
    this.preparationTimers = options.preparationTimers || { setInterval, clearInterval };
    this.audioPreparationPending = null;
    this.audioPreparationGeneration = 0;
    this.audioCleanupPending = 0;
    this.audioPreparationError = null;
    this.nativeDictationFactory = options.nativeDictationFactory || null;
    this.nativeDictation = null;
    this.nativeDictationSupported = false;
    this.nativeSessionOwned = false;
    this.nativeCleanupPending = null;
    this.recordingConfirmed = false;
    this.disposed = false;
    this.onControllerStatus = () => this.emit('status', this.getStatus());
    this.onControllerFault = (error) => {
      this.lastError = error && error.message ? error.message : String(error || 'Virtual Micro controller fault.');
      this.releaseUncertain = this.releaseUncertain || this.active || this.pressPending;
      this.active = false;
      this.cancelAudioImmediately();
      this.cleanupNativeDictation().catch(() => {});
      this.emit('fault', { message: this.lastError, status: this.getStatus() });
    };
    if (this.controller && typeof this.controller.on === 'function') {
      this.controller.on('status', this.onControllerStatus);
      this.controller.on('fault', this.onControllerFault);
    }
  }

  on(...args) { this.events.on(...args); return this; }
  removeListener(...args) { this.events.removeListener(...args); return this; }
  emit(...args) { return this.events.emit(...args); }

  controllerStatus() {
    const status = this.controller && typeof this.controller.getStatus === 'function'
      ? this.controller.getStatus() : {};
    return status && typeof status === 'object' ? status : {};
  }

  bridgeStatus() {
    if (!this.audioBridge || typeof this.audioBridge.getStatus !== 'function') {
      return { ready: false, active: false, packets: 0, samples: 0, peak: 0, bufferedMs: 0, lastError: null, deviceName: null, captureName: null };
    }
    return this.audioBridge.getStatus();
  }

  createAudioBridge() {
    if (this.config.audioSource !== 'esp32') return null;
    const bridge = this.audioBridgeFactory(this.audioBridgeOptions);
    if (!bridge) throw new Error('ESP32 audio bridge is unavailable.');
    const onStatus = () => this.emitAudioStatus();
    const onFault = (error) => {
      this.lastError = error && error.message ? error.message : String(error || 'ESP32 audio bridge fault.');
      this.audioPreparationError = this.lastError;
      const pttMayBePressed = this.active || this.pressPending;
      this.active = false;
      this.releaseUncertain = this.releaseUncertain || pttMayBePressed;
      this.cancelAudioImmediately();
      if (pttMayBePressed && this.controller && typeof this.controller.releaseAll === 'function') {
        this.cleanupNativeDictation().catch(() => {}).then(() => this.controller.releaseAll()).catch(() => {});
      } else {
        this.cleanupNativeDictation().catch(() => {});
      }
      this.emit('fault', { message: this.lastError, status: this.getStatus() });
    };
    if (typeof bridge.on === 'function') {
      bridge.on('status', onStatus);
      bridge.on('fault', onFault);
    }
    bridge.__virtualMicroListeners = { onStatus, onFault };
    return bridge;
  }

  getAudioBridge() {
    if (this.config.audioSource !== 'esp32') return null;
    if (!this.audioBridge) this.audioBridge = this.createAudioBridge();
    return this.audioBridge;
  }

  emitAudioStatus() {
    const now = Date.now();
    const remaining = 1000 - (now - this.lastAudioStatusAt);
    if (remaining <= 0) {
      this.lastAudioStatusAt = now;
      this.emit('status', this.getStatus());
      return;
    }
    if (this.audioStatusTimer) return;
    this.audioStatusTimer = setTimeout(() => {
      this.audioStatusTimer = null;
      this.lastAudioStatusAt = Date.now();
      this.emit('status', this.getStatus());
    }, remaining);
    if (typeof this.audioStatusTimer.unref === 'function') this.audioStatusTimer.unref();
  }

  async cancelAudioImmediately() {
    this.audioPreparationGeneration += 1;
    this.audioPreparationPending = null;
    if (!this.audioBridge || typeof this.audioBridge.cancel !== 'function') return;
    this.audioCleanupPending += 1;
    try { await this.audioBridge.cancel(); } catch (error) {}
    finally { this.audioCleanupPending -= 1; }
  }

  async cleanupNativeDictation({ cancel = true } = {}) {
    const native = this.nativeDictation;
    if (!native) return this.nativeCleanupPending;
    this.nativeDictation = null;
    this.nativeDictationSupported = false;
    this.recordingConfirmed = false;
    const cleanup = (async () => {
      try {
        if (cancel && typeof native.cancel === 'function') await native.cancel();
      } finally {
        await native.dispose?.({ cancel: false });
      }
    })();
    this.nativeCleanupPending = cleanup;
    try { return await cleanup; }
    finally { if (this.nativeCleanupPending === cleanup) this.nativeCleanupPending = null; }
  }

  maintainAudioPreparation() {
    if (this.disposed) return;
    if (!this.audioPreparationTimer) {
      // Preparation can be lost after cancellation or an idle output fault.
      // Keep the silent endpoint ready without replaying any HID operation.
      this.audioPreparationTimer = this.preparationTimers.setInterval(() => this.prepareAudioInBackground(), AUDIO_PREPARATION_CHECK_MS);
      this.audioPreparationTimer.unref?.();
    }
    this.prepareAudioInBackground();
  }

  prepareAudioInBackground() {
    if (this.disposed || this.active || this.pressPending || this.releaseUncertain || this.audioCleanupPending
      || this.audioPreparationPending || this.config.audioSource !== 'esp32') return;
    const bridge = this.getAudioBridge();
    if (!bridge || typeof bridge.prepare !== 'function') return;
    const audioStatus = bridge.getStatus();
    if (audioStatus.active || audioStatus.ready) return;
    const deviceId = this.config.audioDeviceId;
    const generation = this.audioPreparationGeneration;
    const preparation = Promise.resolve().then(() => {
      if (this.disposed || generation !== this.audioPreparationGeneration || this.audioBridge !== bridge || this.config.audioDeviceId !== deviceId
        || this.active || this.pressPending || this.releaseUncertain || this.audioCleanupPending) return;
      const currentStatus = bridge.getStatus();
      if (currentStatus.active || currentStatus.ready) return;
      return bridge.prepare(deviceId);
    }).then(result => {
      if (!result || this.disposed || generation !== this.audioPreparationGeneration
        || this.audioBridge !== bridge || this.config.audioDeviceId !== deviceId) return;
      if (this.lastError === this.audioPreparationError) this.lastError = null;
      this.audioPreparationError = null;
      this.emitAudioStatus();
    }).catch(error => {
      // A cancelled or replaced preparation must not overwrite a new setting.
      if (this.disposed || generation !== this.audioPreparationGeneration || this.audioBridge !== bridge || this.config.audioDeviceId !== deviceId) return;
      const status = bridge.getStatus();
      if (status.lastError) {
        this.lastError = error.message;
        this.audioPreparationError = error.message;
        this.emit('status', this.getStatus());
      }
    }).finally(() => {
      if (this.audioPreparationPending === preparation) this.audioPreparationPending = null;
    });
    this.audioPreparationPending = preparation;
  }

  prepareConfig(config = {}) {
    const audio = normalizeAudioConfig(config);
    if (audio.audioSource === this.config.audioSource) return { audio, bridge: this.audioBridge };
    return { audio, bridge: audio.audioSource === 'esp32' ? this.createAudioBridge() : null };
  }

  async applyPreparedConfig(prepared) {
    if (!prepared) return;
    if (this.active) throw new Error('Stop Virtual Micro push-to-talk before changing audio settings.');
    const oldBridge = this.audioBridge;
    const deviceChanged = this.config.audioDeviceId !== prepared.audio.audioDeviceId;
    this.config = { ...this.config, ...prepared.audio };
    this.audioBridge = prepared.bridge || null;
    if (oldBridge && oldBridge !== this.audioBridge) {
      const listeners = oldBridge.__virtualMicroListeners;
      if (listeners && typeof oldBridge.removeListener === 'function') {
        oldBridge.removeListener('status', listeners.onStatus);
        oldBridge.removeListener('fault', listeners.onFault);
      }
      try { if (typeof oldBridge.dispose === 'function') await oldBridge.dispose(); } catch (error) {}
    }
    if (deviceChanged && oldBridge === this.audioBridge) await this.cancelAudioImmediately();
    this.maintainAudioPreparation();
    this.emit('status', this.getStatus());
  }

  getStatus() {
    const status = this.controllerStatus();
    const connected = Boolean(status.connected && status.microConnected);
    return {
      ...super.getStatus(),
      ...status,
      configured: true,
      connected,
      active: this.active,
      acceptsAudio: this.config.audioSource === 'esp32',
      profile: status.profile || this.config.profile,
      audioSource: this.config.audioSource,
      recordingConfirmed: this.recordingConfirmed,
      nativeDictation: this.nativeDictationSupported,
      audioBridge: this.bridgeStatus(),
      lastError: this.lastError || status.lastError || null,
      releaseUncertain: this.releaseUncertain
    };
  }

  async connect() {
    if (!this.controller || typeof this.controller.connect !== 'function') {
      throw new Error('Virtual Micro controller connect operation is unavailable.');
    }
    // Audio setup does not depend on the HID handshake; overlap both at startup.
    this.maintainAudioPreparation();
    try {
      await this.controller.connect();
      const status = this.getStatus();
      if (!status.connected) {
        throw new Error(status.lastError || 'Virtual Micro broker is not connected to the Codex Micro HID device.');
      }
      this.releaseUncertain = false;
      this.lastError = null;
      this.prepareAudioInBackground();
      return this.getStatus();
    } catch (error) {
      this.lastError = error && error.message ? error.message : String(error);
      throw error;
    }
  }

  async start(options = {}) {
    const checkCancelled = () => {
      if (options.signal?.aborted) throw Object.assign(new Error('本次语音输入已取消。'), { code: 'VOICE_INPUT_CANCELLED' });
    };
    checkCancelled();
    if (this.active) throw new Error('Virtual Micro push-to-talk is already active.');
    if (this.releaseUncertain) {
      throw new Error('Virtual Micro release state is uncertain; reconnect the HID controller before starting again.');
    }
    const startupTiming = {};
    const startStartedAt = performance.now();
    let stepStartedAt = performance.now();
    await this.connect();
    startupTiming.connectMs = Math.round(performance.now() - stepStartedAt);
    if (!this.controller || typeof this.controller.setPtt !== 'function') {
      throw new Error('Virtual Micro controller PTT operation is unavailable.');
    }
    try {
      const bridge = this.getAudioBridge();
      if (bridge && typeof bridge.start !== 'function') throw new Error('ESP32 audio bridge start operation is unavailable.');
      stepStartedAt = performance.now();
      if (bridge) await bridge.start(this.config.audioDeviceId);
      checkCancelled();
      startupTiming.audioMs = Math.round(performance.now() - stepStartedAt);
      stepStartedAt = performance.now();
      if (options.beforePttPress) await options.beforePttPress();
      startupTiming.targetMs = Math.round(performance.now() - stepStartedAt);
      if (bridge && this.nativeDictationFactory) {
        const inputCaptureName = String(bridge.getStatus?.().captureName || '').trim();
        if (!inputCaptureName) throw new Error('ESP32 虚拟麦克风采集端未就绪。');
        const native = this.nativeDictationFactory();
        if (!native || typeof native.prepare !== 'function') throw new Error('Codex 听写连接不可用。');
        this.nativeDictation = native;
        this.nativeSessionOwned = true;
        stepStartedAt = performance.now();
        const prepared = await native.prepare({
          target: options.submissionContext,
          requestId: options.requestId,
          signal: options.signal,
          inputCaptureName
        });
        startupTiming.nativePrepareMs = Math.round(performance.now() - stepStartedAt);
        if (this.nativeDictation !== native) throw new Error('本次听写连接已取消。');
        if (typeof prepared?.supported !== 'boolean') throw new Error('Codex 听写兼容状态未确认。');
        this.nativeDictationSupported = prepared?.supported === true;
        if (!this.nativeDictationSupported) {
          await this.cleanupNativeDictation({ cancel: false });
          this.nativeSessionOwned = false;
        }
        // Selection can change while the renderer resolves its input device.
        if (options.beforePttPress) await options.beforePttPress();
      }
      checkCancelled();
      this.pressPending = true;
      stepStartedAt = performance.now();
      const result = await this.controller.setPtt(true);
      startupTiming.pttMs = Math.round(performance.now() - stepStartedAt);
      if (!controlDelivered(result)) {
        throw new Error((result && result.error) || 'Virtual Micro HID PTT press was not acknowledged.');
      }
      if (this.releaseUncertain) {
        throw new Error('Virtual Micro audio fault occurred while the HID PTT press was pending.');
      }
      if (this.nativeDictationSupported) {
        const native = this.nativeDictation;
        stepStartedAt = performance.now();
        const begun = await native.begun();
        startupTiming.confirmationMs = Math.round(performance.now() - stepStartedAt);
        if (this.nativeDictation !== native || this.releaseUncertain) throw new Error('听写连接在开始录音时中断。');
        if (begun?.recordingConfirmed !== true) throw new Error('Codex 未确认从 ESP32 音源开始录音。');
        this.recordingConfirmed = true;
      }
      if (this.nativeSessionOwned) checkCancelled();
      this.active = true;
      startupTiming.totalMs = Math.round(performance.now() - startStartedAt);
      return { ...this.getStatus(), delivery: result.delivery, outcome: result.outcome || 'unknown', startupTiming };
    } catch (error) {
      const inputCancelled = error?.code === 'VOICE_INPUT_CANCELLED';
      this.lastError = inputCancelled ? null : error && error.message ? error.message : String(error);
      const pttMayBePressed = this.active || this.pressPending;
      this.releaseUncertain = this.releaseUncertain || pttMayBePressed;
      try { await this.cleanupNativeDictation(); } catch (_) {}
      if (inputCancelled && !pttMayBePressed && this.audioBridge?.discard) {
        try { await this.audioBridge.discard(); }
        catch (_) { await this.cancelAudioImmediately(); }
      } else {
        await this.cancelAudioImmediately();
      }
      if (pttMayBePressed) {
        try { await this.releaseAll(); } catch (releaseError) {}
      }
      this.nativeSessionOwned = false;
      throw error;
    } finally { this.pressPending = false; }
  }

  async stop(options = {}) {
    if (!this.active) throw new Error('Virtual Micro push-to-talk is not active.');
    const native = this.nativeDictationSupported ? this.nativeDictation : null;
    let submissionKey = options && options.submissionKey;
    let beforePttRelease = options && options.beforePttRelease;
    if (submissionKey !== undefined && (typeof submissionKey !== 'string' || !submissionKey)) {
      throw new Error('Virtual Micro submission key must be a non-empty string.');
    }
    if (beforePttRelease !== undefined && typeof beforePttRelease !== 'function') {
      throw new Error('Virtual Micro pre-release submission must be a function.');
    }
    if (submissionKey && beforePttRelease) {
      throw new Error('Virtual Micro can use only one submission path per dictation session.');
    }
    try {
      const bridge = this.config.audioSource === 'esp32' ? this.getAudioBridge() : null;
      if (bridge && typeof bridge.stop !== 'function') throw new Error('ESP32 audio bridge stop operation is unavailable.');
      if (bridge) await bridge.stop();
      if (options.beforeSubmission) {
        const fresh = await options.beforeSubmission();
        submissionKey = fresh?.submissionKey;
        beforePttRelease = fresh?.beforePttRelease;
        if (submissionKey && beforePttRelease) throw new Error('语音发送路径冲突。');
        if (!submissionKey && !beforePttRelease && !this.nativeDictationSupported) throw new Error('语音发送操作不可用。');
      }
      if (!this.active || this.releaseUncertain || (native && this.nativeDictation !== native)) {
        throw new Error('听写连接已中断，已取消本次语音发送。');
      }
      let submission = null;
      // Codex's composer.submit changes an in-progress dictation to
      // stopDictation('send'). It must therefore arrive before ACT10 is
      // released; after that release the client uses the insert action.
      if (native) {
        submission = await native.submit();
        if (!controlDelivered(submission) || submission.recordingStopped !== true) {
          throw new Error(submission?.error || 'Codex 未确认结束并发送听写。');
        }
        submissionKey = null;
      } else if (beforePttRelease) {
        submission = await beforePttRelease();
        if (!submission || submission.success === false || !submission.delivery || submission.delivery === 'not_sent') {
          throw new Error((submission && submission.error) || 'Native dictation submission was not acknowledged.');
        }
      } else if (submissionKey) {
        if (!this.controller || typeof this.controller.tapKey !== 'function') {
          throw new Error('Virtual Micro controller submission operation is unavailable.');
        }
        submission = await this.controller.tapKey(submissionKey);
        if (!controlDelivered(submission)) {
          throw new Error((submission && submission.error) || 'Virtual Micro HID submission was not acknowledged.');
        }
      }
      if (!this.controller || typeof this.controller.setPtt !== 'function') {
        throw new Error('Virtual Micro controller PTT operation is unavailable.');
      }
      const result = await this.controller.setPtt(false);
      if (!controlDelivered(result)) {
        throw new Error((result && result.error) || 'Virtual Micro HID PTT release was not acknowledged.');
      }
      this.active = false;
      await this.cleanupNativeDictation({ cancel: false });
      this.nativeSessionOwned = false;
      this.lastError = null;
      this.prepareAudioInBackground();
      return {
        ...this.getStatus(), delivery: result.delivery, outcome: result.outcome || 'unknown',
        submission: submission && {
          key: submissionKey || null,
          delivery: submission.delivery,
          outcome: submission.outcome || 'unknown'
        }
      };
    } catch (error) {
      this.active = false;
      this.releaseUncertain = true;
      this.lastError = error && error.message ? error.message : String(error);
      await this.cancelAudioImmediately();
      try {
        const released = await this.releaseAll();
        if (controlDelivered(released)) this.releaseUncertain = false;
      } catch (releaseError) {}
      throw error;
    }
  }

  async releaseAll({ cancelAudio = true } = {}) {
    if (cancelAudio) await this.cancelAudioImmediately();
    if (!this.controller || typeof this.controller.releaseAll !== 'function') {
      throw new Error('Virtual Micro controller emergency release is unavailable.');
    }
    let nativeError;
    try { await this.cleanupNativeDictation(); } catch (error) { nativeError = error; }
    let releaseConfirmed = false;
    try {
      const result = await this.controller.releaseAll();
      releaseConfirmed = controlDelivered(result);
      if (releaseConfirmed) this.releaseUncertain = false;
      this.active = false;
      this.nativeSessionOwned = false;
      if (nativeError) throw nativeError;
      return {
        ...this.getStatus(),
        delivery: result && result.delivery || 'not_sent',
        outcome: result && result.outcome || 'unknown'
      };
    } catch (error) {
      this.active = false;
      if (!releaseConfirmed) this.releaseUncertain = true;
      this.lastError = error && error.message ? error.message : String(error);
      throw error;
    }
  }

  async cancel(options = {}) {
    const startedAt = performance.now();
    let discardError = null;
    const audioCleanup = (async () => { try {
      if (!this.disposed && !this.releaseUncertain && this.audioBridge?.discard) {
        this.audioCleanupPending += 1;
        try { await this.audioBridge.discard(); }
        finally { this.audioCleanupPending -= 1; }
      } else {
        await this.cancelAudioImmediately();
      }
    } catch (error) {
      // Native cancellation and key release must still run if audio reset fails.
      discardError = error;
      await this.cancelAudioImmediately();
    } })();
    let release;
    let discarded = false;
    try {
      if (this.nativeSessionOwned) {
        const native = this.nativeDictation;
        const result = native ? await native.cancel() : await this.nativeCleanupPending;
        discarded = Boolean(result?.discarded || result?.cancelled || result?.success);
        await this.cleanupNativeDictation({ cancel: false });
      } else if (options.beforePttRelease && (this.active || this.pressPending)) {
        const result = await options.beforePttRelease();
        if (!result || result.success !== true || !['discarded_in_native_app', 'submitted_to_keyboard'].includes(result.delivery)) {
          throw new Error('Codex 未确认丢弃听写。');
        }
        discarded = result.delivery === 'discarded_in_native_app';
      }
    } finally {
      // Even a failed native cancellation must release the physical key.
      try { release = await this.releaseAll({ cancelAudio: false }); }
      finally { await audioCleanup; this.prepareAudioInBackground(); }
    }
    if (discardError) this.lastError = discardError.message;
    return { ...release, discarded, cancellationRequested: true, cancelMs: Math.round(performance.now() - startedAt) };
  }

  async appendAudio(chunk) {
    if (!this.active || this.config.audioSource !== 'esp32') return this.getStatus();
    const bridge = this.getAudioBridge();
    if (!bridge || typeof bridge.append !== 'function') throw new Error('ESP32 audio bridge append operation is unavailable.');
    await bridge.append(chunk);
    return this.getStatus();
  }

  async dispose() {
    this.disposed = true;
    if (this.audioPreparationTimer) this.preparationTimers.clearInterval(this.audioPreparationTimer);
    this.audioPreparationTimer = null;
    let releaseError = null;
    if (this.audioStatusTimer) clearTimeout(this.audioStatusTimer);
    try { await this.releaseAll(); } catch (error) { releaseError = error; }
    await this.cancelAudioImmediately();
    try {
      if (this.controller && typeof this.controller.close === 'function') await this.controller.close();
    } finally {
      if (this.controller && typeof this.controller.removeListener === 'function') {
        this.controller.removeListener('status', this.onControllerStatus);
        this.controller.removeListener('fault', this.onControllerFault);
      }
    }
    if (releaseError) throw releaseError;
  }
}

module.exports = VirtualMicroProvider;
module.exports.normalizeAudioConfig = normalizeAudioConfig;
