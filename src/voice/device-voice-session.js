const { DEFAULT_VOICE_SHORTCUT, parseShortcut } = require('../core/keyboard-shortcut');

const DEFAULT_NATIVE_INPUT_TIMEOUT_MS = 15000;
const DEFAULT_NATIVE_INPUT_POLL_MS = 120;
const DEFAULT_NATIVE_INPUT_STABLE_MS = 450;

class DeviceVoiceSession {
  constructor(options = {}) {
    this.voiceRecognizer = options.voiceRecognizer || null;
    this.desktopController = options.desktopController;
    this.voiceShortcut = parseShortcut(options.voiceShortcut || DEFAULT_VOICE_SHORTCUT).shortcut;
    this.sendToDevice = options.sendToDevice || (async () => false);
    this.submitText = options.submitText || (async () => ({ success: false, error: 'Desktop text submission is unavailable.' }));
    this.onStatus = options.onStatus || (() => {});
    this.onResult = options.onResult || (() => {});
    this.onLog = options.onLog || (() => {});
    this.onSubmitted = options.onSubmitted || (() => {});
    this.nativeInputWaitOptions = {
      timeoutMs: Number.isFinite(options.nativeInputTimeoutMs)
        ? Math.max(1, Number(options.nativeInputTimeoutMs))
        : DEFAULT_NATIVE_INPUT_TIMEOUT_MS,
      pollMs: Number.isFinite(options.nativeInputPollMs)
        ? Math.max(10, Number(options.nativeInputPollMs))
        : DEFAULT_NATIVE_INPUT_POLL_MS,
      stableMs: Number.isFinite(options.nativeInputStableMs)
        ? Math.max(0, Number(options.nativeInputStableMs))
        : DEFAULT_NATIVE_INPUT_STABLE_MS
    };
    this.operation = Promise.resolve();
    this.activeMode = null;
  }

  handle(message) {
    const next = this.operation.catch(() => {}).then(() => {
      if (message.type === 'voice_start') return this.start(message);
      if (message.type === 'voice_end') return this.end(message);
      return undefined;
    });
    this.operation = next;
    return next;
  }

  handleAudio(message = {}) {
    const next = this.operation.catch(() => {}).then(() => this.appendAudio(message));
    this.operation = next;
    return next;
  }

  getMode() {
    const status = this.voiceRecognizer && this.voiceRecognizer.getStatus
      ? this.voiceRecognizer.getStatus()
      : null;
    return status && status.mode ? status.mode : 'native';
  }

  getShortcut() {
    const config = this.voiceRecognizer && this.voiceRecognizer.getConfig
      ? this.voiceRecognizer.getConfig()
      : null;
    const configured = config && config.native && config.native.shortcut;
    return parseShortcut(configured || this.voiceShortcut || DEFAULT_VOICE_SHORTCUT).shortcut;
  }

  async sendStage(state, details = {}) {
    const payload = { type: 'voice_status', state, ...details };
    this.onStatus(payload);
    await this.sendToDevice(payload);
    return payload;
  }

  async fail(error, requestId) {
    const message = error && error.message ? error.message : String(error || 'Voice input failed.');
    if (this.voiceRecognizer && this.voiceRecognizer.getStatus && this.voiceRecognizer.getStatus().active
      && typeof this.voiceRecognizer.cancel === 'function') {
      try { await this.voiceRecognizer.cancel(); } catch (cancelError) {}
    }
    this.activeMode = null;
    this.onLog('error', message);
    await this.sendStage('error', { requestId, message });
    return { success: false, error: message };
  }

  async start(message = {}) {
    let started = false;
    try {
      await this.sendStage('preparing', { requestId: message.requestId });
      const focusResult = await this.desktopController.focusInput();
      if (!focusResult.success) {
        throw new Error(focusResult.error || 'ChatGPT Desktop conversation editor could not be focused.');
      }

      const mode = this.getMode();
      if (mode === 'api' && !this.voiceRecognizer) {
        throw new Error('API voice recognition is not configured.');
      }
      if (mode === 'native') {
        if (focusResult.hasText === undefined
          && focusResult.nonWhitespaceLength === undefined) {
          throw new Error('ChatGPT Desktop editor text state is unavailable.');
        }
        if (focusResult.hasText || Number(focusResult.nonWhitespaceLength || 0) > 0) {
          throw new Error('ChatGPT Desktop editor already contains a draft; clear it before voice input.');
        }
      }
      if (this.voiceRecognizer) {
        await this.voiceRecognizer.start();
        started = true;
      }

      if (mode === 'native') {
        const shortcutResult = await this.desktopController.sendShortcut(this.getShortcut());
        if (!shortcutResult.success) {
          throw new Error(shortcutResult.error || 'ChatGPT Desktop voice shortcut failed.');
        }
      }

      this.activeMode = mode;
      await this.sendStage('recording', {
        requestId: message.requestId,
        mode
      });
      this.onLog('info', `${mode} voice recording started.`);
      return { success: true, state: 'recording', mode };
    } catch (error) {
      if (!started) this.activeMode = null;
      return this.fail(error, message.requestId);
    }
  }

  async appendAudio(message = {}) {
    if (this.activeMode !== 'api' || !this.voiceRecognizer) return { success: true, ignored: true };
    try {
      if (message.chunk) await this.voiceRecognizer.appendAudio(message.chunk);
      return { success: true, state: 'recording', mode: 'api' };
    } catch (error) {
      return this.fail(error, message.requestId);
    }
  }

  async end(message = {}) {
    try {
      const currentStatus = this.voiceRecognizer && this.voiceRecognizer.getStatus
        ? this.voiceRecognizer.getStatus()
        : { active: this.activeMode !== null, mode: this.activeMode || 'native' };
      const mode = this.activeMode || currentStatus.mode;
      if (!currentStatus.active && !this.activeMode) {
        throw new Error('Voice recording is not active.');
      }

      if (mode === 'native') {
        const shortcutResult = await this.desktopController.sendShortcut(this.getShortcut());
        if (!shortcutResult.success) {
          throw new Error(shortcutResult.error || 'ChatGPT Desktop voice shortcut failed.');
        }
        if (this.voiceRecognizer && this.voiceRecognizer.getStatus().active) {
          await this.voiceRecognizer.stop();
        }
        await this.sendStage('recognizing', {
          requestId: message.requestId,
          mode
        });
        if (!this.desktopController || typeof this.desktopController.waitForInput !== 'function') {
          throw new Error('ChatGPT Desktop input wait is unavailable.');
        }
        const waitResult = await this.desktopController.waitForInput(this.nativeInputWaitOptions);
        if (!waitResult || !waitResult.success
          || (!waitResult.hasText && Number(waitResult.nonWhitespaceLength || 0) <= 0)) {
          throw new Error(waitResult && waitResult.error
            ? waitResult.error
            : 'ChatGPT Desktop did not produce stable recognized text.');
        }
        await this.sendStage('submitting', {
          requestId: message.requestId,
          mode
        });
        if (!this.desktopController || typeof this.desktopController.submitInput !== 'function') {
          throw new Error('ChatGPT Desktop submit operation is unavailable.');
        }
        const submitResult = await this.desktopController.submitInput();
        if (!submitResult || !submitResult.success) {
          throw new Error(submitResult && submitResult.error
            ? submitResult.error
            : 'ChatGPT Desktop rejected the recognized voice input.');
        }
        this.activeMode = null;
        await this.sendStage('submitted', { requestId: message.requestId, mode });
        this.onSubmitted(submitResult);
        return { success: true, mode, submitResult };
      }

      await this.sendStage('recognizing', {
        requestId: message.requestId,
        mode
      });
      const result = await this.voiceRecognizer.stop();
      this.activeMode = null;
      const text = String(result.text || '').trim();
      if (!text) throw new Error('API speech recognition returned no text.');

      this.onResult(text);
      this.onLog('info', `${result.mode} transcription completed.`);
      await this.sendToDevice({ type: 'voice_recognized', text, requestId: message.requestId });
      await this.sendStage('submitting', {
        requestId: message.requestId,
        mode: result.mode
      });

      const inputResult = await this.submitText(text);
      await this.sendToDevice({
        type: inputResult.success ? 'input_result' : 'input_error',
        requestId: message.requestId,
        ...inputResult
      });
      if (!inputResult.success) {
        throw new Error(inputResult.error || 'ChatGPT Desktop rejected the transcribed message.');
      }

      await this.sendStage('submitted', { requestId: message.requestId, mode: result.mode });
      this.onSubmitted(inputResult);
      return { success: true, text, inputResult };
    } catch (error) {
      return this.fail(error, message.requestId);
    }
  }
}

module.exports = DeviceVoiceSession;
