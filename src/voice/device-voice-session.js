function isMicroMode(mode) {
  return mode === 'virtual_micro';
}

const { commandKey } = require('../core/codex-controls');

const MAX_QUEUED_AUDIO_BYTES = 512 * 1024;
const MAX_QUEUED_AUDIO_FRAMES = 64;

function audioByteLength(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof Uint8Array || chunk instanceof ArrayBuffer) return chunk.byteLength;
  return 0;
}

function normalizeFollowUpQueueMode(value) {
  const mode = String(value || 'queue').trim().toLowerCase();
  // The desktop migrates its former "interrupt" value to "steer" and uses
  // queue when this preference is absent.
  if (mode === 'interrupt') return 'steer';
  return mode === 'steer' ? 'steer' : 'queue';
}

function sameSubmissionTarget(started = {}, current = {}) {
  if (!started || !current || started.kind !== current.kind) return false;
  if (started.generation !== undefined && started.generation !== null
    && started.generation !== current.generation) return false;
  if (started.hostId !== current.hostId || started.streamId !== current.streamId) return false;
  if (started.taskId) return started.taskId === current.taskId;
  if (started.draftToken) return current.taskId == null && started.draftToken === current.draftToken;
  // Older callers did not have a stable draft token. They can still use the
  // idle composer path, but must not silently switch to a concrete task.
  return current.taskId == null;
}

class DeviceVoiceSession {
  constructor(options = {}) {
    this.voiceRecognizer = options.voiceRecognizer || null;
    this.sendToDevice = options.sendToDevice || (async () => false);
    this.submitText = options.submitText || (async () => ({ success: false, error: 'Desktop text submission is unavailable.' }));
    this.getSubmissionContext = options.getSubmissionContext || (async () => ({}));
    this.prepareSubmissionTarget = options.prepareSubmissionTarget || (async () => {});
    this.assertSubmissionTarget = options.assertSubmissionTarget || (async () => {});
    this.getMicroLayout = options.getMicroLayout || (async () => null);
    this.cancelNativeDictation = options.cancelNativeDictation || null;
    this.pendingStarts = new Map();
    this.lastCancelledRequestId = null;
    this.onStatus = options.onStatus || (() => {});
    this.onResult = options.onResult || (() => {});
    this.onLog = options.onLog || (() => {});
    this.onSubmitted = options.onSubmitted || (() => {});
    this.operation = Promise.resolve();
    this.audioQueueBytes = 0;
    this.audioQueueFrames = 0;
    this.audioGeneration = 0;
    this.audioOverflowed = false;
    this.activeAudioBytes = 0;
    this.activeRequiresDeviceAudio = false;
    this.activeSubmissionContext = null;
    this.activeMode = null;
    this.activeRequestId = null;
    this.disposed = false;
    this.onRecognizerFault = (fault) => {
      if (this.disposed || (fault && fault.mode && !isMicroMode(fault.mode))) return;
      const message = fault && fault.message ? fault.message : 'Codex Micro controller fault.';
      this.audioOverflowed = true;
      this.discardQueuedAudio();
      const next = this.operation.catch(() => {}).then(async () => {
        if (!isMicroMode(this.activeMode)) return;
        await this.fail(new Error(message), this.activeRequestId);
      });
      this.operation = next;
    };
    if (this.voiceRecognizer && typeof this.voiceRecognizer.on === 'function') {
      this.voiceRecognizer.on('fault', this.onRecognizerFault);
    }
  }

  handle(message) {
    const pending = message.type === 'voice_start' ? { cancelled: false } : null;
    if (pending && message.requestId) this.pendingStarts.set(message.requestId, pending);
    if (message.type === 'voice_end' && message.cancelled === true && message.requestId) {
      const starting = this.pendingStarts.get(message.requestId);
      if (starting) starting.cancelled = true;
      if ((starting && !this.activeRequestId) || message.requestId === this.activeRequestId) {
        this.audioOverflowed = true;
        this.discardQueuedAudio();
        this.voiceRecognizer?.discardQueuedAudio?.();
      }
    }
    const next = this.operation.catch(() => {}).then(() => {
      if (this.disposed) return { success: false, error: 'Voice session has been disposed.' };
      if (message.type === 'voice_start') return this.start(message, pending);
      if (message.type === 'voice_end') return this.end(message);
      return undefined;
    }).finally(() => {
      if (pending && this.pendingStarts.get(message.requestId) === pending) this.pendingStarts.delete(message.requestId);
    });
    this.operation = next;
    return next;
  }

  handleAudio(message = {}) {
    const currentStatus = this.voiceRecognizer && this.voiceRecognizer.getStatus
      ? this.voiceRecognizer.getStatus() : {};
    if (!currentStatus.acceptsAudio) {
      return Promise.resolve({ success: true, ignored: true });
    }
    if (this.audioOverflowed) return Promise.resolve({ success: true, ignored: true });
    const bytes = audioByteLength(message.chunk);
    if (bytes > MAX_QUEUED_AUDIO_BYTES || this.audioQueueFrames >= MAX_QUEUED_AUDIO_FRAMES
      || this.audioQueueBytes + bytes > MAX_QUEUED_AUDIO_BYTES) {
      this.audioOverflowed = true;
      this.discardQueuedAudio();
      const next = this.operation.catch(() => {}).then(() => this.fail(new Error('Voice audio queue is full.'), message.requestId));
      this.operation = next;
      return next;
    }
    const generation = this.audioGeneration;
    this.audioQueueBytes += bytes;
    this.audioQueueFrames += 1;
    const next = this.operation.catch(() => {}).then(async () => {
      try {
        if (this.disposed || generation !== this.audioGeneration) return { success: true, ignored: true };
        return await this.appendAudio(message);
      } finally {
        this.audioQueueBytes -= bytes;
        this.audioQueueFrames -= 1;
      }
    });
    this.operation = next;
    return next;
  }

  discardQueuedAudio() { this.audioGeneration += 1; }

  async cancelCurrentInput() {
    const context = this.activeSubmissionContext;
    const micro = isMicroMode(this.activeMode || this.getMode());
    const result = await this.voiceRecognizer.cancel(context && this.cancelNativeDictation && micro
      ? { beforePttRelease: () => this.cancelNativeDictation(context) } : undefined);
    if (Number.isFinite(result?.cancelMs)) this.onLog('info', `Voice cancel timing (ms): ${result.cancelMs}`);
    if (micro && result?.delivery !== 'submitted_to_hid') throw new Error('PTT release could not be confirmed.');
    return result;
  }

  cancelVirtualMicro(reason = 'Voice session cancelled.') {
    for (const pending of this.pendingStarts.values()) pending.cancelled = true;
    this.audioOverflowed = true;
    this.discardQueuedAudio();
    const next = this.operation.catch(() => {}).then(async () => {
      const status = this.voiceRecognizer && this.voiceRecognizer.getStatus
        ? this.voiceRecognizer.getStatus() : {};
      if (!isMicroMode(this.activeMode)
        && !(isMicroMode(status.mode) && (status.active || status.releaseUncertain))) {
        return { success: true, ignored: true };
      }
      const requestId = this.activeRequestId;
      try {
        const result = await this.cancelCurrentInput();
        if (!result || result.delivery !== 'submitted_to_hid') {
          throw new Error('PTT release could not be confirmed; check ChatGPT recording state.');
        }
        await this.sendStage('stopped', {
          requestId, mode: this.activeMode || status.mode || 'virtual_micro', delivery: result.delivery,
          outcome: result.outcome || 'unknown', cancelled: true, submission: 'none',
          submissionRequested: false, submissionConfirmed: false, recordingConfirmed: false, message: reason
        });
        return { success: true, delivery: result.delivery };
      } catch (error) {
        this.onLog('error', error.message);
        await this.sendStage('error', { requestId, mode: this.activeMode || status.mode || 'virtual_micro', message: error.message });
        return { success: false, error: error.message };
      } finally {
        this.activeMode = null;
        this.activeRequestId = null;
        this.activeAudioBytes = 0;
        this.activeRequiresDeviceAudio = false;
        this.activeSubmissionContext = null;
      }
    });
    this.operation = next;
    return next;
  }

  async dispose() {
    this.disposed = true;
    this.audioOverflowed = true;
    this.discardQueuedAudio();
    if (this.voiceRecognizer && typeof this.voiceRecognizer.removeListener === 'function') {
      this.voiceRecognizer.removeListener('fault', this.onRecognizerFault);
    }
    return this.cancelVirtualMicro('Voice session stopped.');
  }

  getMode() {
    const status = this.voiceRecognizer && this.voiceRecognizer.getStatus
      ? this.voiceRecognizer.getStatus()
      : null;
    return status && status.mode ? status.mode : 'virtual_micro';
  }

  async sendStage(state, details = {}) {
    const payload = { type: 'voice_status', state, ...details };
    this.onStatus(payload);
    await this.sendToDevice(payload);
    return payload;
  }

  async fail(error, requestId) {
    this.audioOverflowed = true;
    this.discardQueuedAudio();
    const message = error && error.message ? error.message : String(error || 'Voice input failed.');
    const mode = this.activeMode || this.getMode();
    if (this.voiceRecognizer && this.voiceRecognizer.getStatus && (this.voiceRecognizer.getStatus().active
      || this.voiceRecognizer.getStatus().releaseUncertain)
      && typeof this.voiceRecognizer.cancel === 'function') {
      try { await this.cancelCurrentInput(); } catch (cancelError) {}
    }
    this.activeMode = null;
    this.activeRequestId = null;
    this.activeAudioBytes = 0;
    this.activeRequiresDeviceAudio = false;
    this.activeSubmissionContext = null;
    this.onLog('error', message);
    await this.sendStage('error', { requestId, mode, message });
    return { success: false, error: message };
  }

  async start(message = {}, pending = {}) {
    let started = false;
    const checkCancelled = () => {
      if (pending.cancelled) throw Object.assign(new Error('本次语音输入已取消。'), { code: 'VOICE_INPUT_CANCELLED' });
    };
    try {
      const requestedMode = this.getMode();
      if (this.activeMode) {
        if (message.requestId && message.requestId === this.activeRequestId) {
          return { success: true, state: 'recording', mode: this.activeMode, idempotent: true, recordingConfirmed: false };
        }
        const error = 'Codex Micro push-to-talk is already owned by another request.';
        this.onLog('warning', error);
        await this.sendStage('error', { requestId: message.requestId, mode: requestedMode, message: error });
        return { success: false, error };
      }
      checkCancelled();
      this.audioOverflowed = false;
      this.activeAudioBytes = 0;
      this.activeRequiresDeviceAudio = false;
      await this.sendStage('preparing', { requestId: message.requestId, mode: requestedMode });
      const mode = requestedMode;
      if (isMicroMode(mode)) {
        if (!this.voiceRecognizer) throw new Error('Codex Micro voice recognition is not configured.');
        const submissionContext = await this.getSubmissionContext(message);
        if (!submissionContext || typeof submissionContext !== 'object') {
          throw new Error('Codex Micro submission context is unavailable.');
        }
        checkCancelled();
        const result = await this.voiceRecognizer.start({ beforePttPress: async () => {
          checkCancelled();
          await this.prepareSubmissionTarget(submissionContext);
          checkCancelled();
          if (!sameSubmissionTarget(submissionContext, await this.getSubmissionContext(message))) {
            throw new Error('任务已变化，请重新按住说话。');
          }
        } });
        started = true;
        this.activeMode = mode;
        this.activeRequestId = message.requestId || null;
        this.activeSubmissionContext = submissionContext;
        checkCancelled();
        if (!sameSubmissionTarget(submissionContext, await this.getSubmissionContext(message))) {
          throw new Error('任务已变化，已取消本次听写。');
        }
        this.activeRequiresDeviceAudio = Boolean(result.acceptsAudio
          || (this.voiceRecognizer.getStatus && this.voiceRecognizer.getStatus().acceptsAudio));
        if (!result || result.delivery !== 'submitted_to_hid') {
          throw new Error('Codex Micro HID PTT press was not acknowledged.');
        }
        await this.sendStage('recording', {
          requestId: message.requestId,
          mode,
          delivery: result.delivery,
          outcome: result.outcome || 'unknown',
          recordingConfirmed: false,
          audioSource: result.audioSource || (this.voiceRecognizer.getStatus && this.voiceRecognizer.getStatus().audioSource) || 'computer',
          acceptsAudio: Boolean(result.acceptsAudio || (this.voiceRecognizer.getStatus && this.voiceRecognizer.getStatus().acceptsAudio))
        });
        this.onLog('info', `${mode} PTT press was delivered; Codex recording state is unconfirmed.`);
        if (result.startupTiming) this.onLog('info', `Voice start timing (ms): ${JSON.stringify(result.startupTiming)}`);
        return { success: true, state: 'recording', mode, recordingConfirmed: false };
      }
      const submissionContext = await this.getSubmissionContext(message);
      checkCancelled();
      await this.prepareSubmissionTarget(submissionContext);
      checkCancelled();
      this.activeSubmissionContext = submissionContext;
      if (mode === 'api' && !this.voiceRecognizer) {
        throw new Error('API voice recognition is not configured.');
      }
      if (this.voiceRecognizer) {
        await this.voiceRecognizer.start();
        started = true;
      }

      this.activeMode = mode;
      this.activeRequestId = message.requestId || null;
      checkCancelled();
      this.activeRequiresDeviceAudio = Boolean(this.voiceRecognizer && this.voiceRecognizer.getStatus
        && this.voiceRecognizer.getStatus().acceptsAudio);
      await this.sendStage('recording', {
        requestId: message.requestId,
        mode,
        audioSource: this.voiceRecognizer && this.voiceRecognizer.getStatus && this.voiceRecognizer.getStatus().audioSource,
        acceptsAudio: Boolean(this.voiceRecognizer && this.voiceRecognizer.getStatus && this.voiceRecognizer.getStatus().acceptsAudio)
      });
      this.onLog('info', `${mode} voice recording started.`);
      return { success: true, state: 'recording', mode };
    } catch (error) {
      if (pending.cancelled) {
        try {
          if (started) await this.cancelCurrentInput();
          this.activeMode = null;
          this.activeRequestId = null;
          this.activeSubmissionContext = null;
          this.activeRequiresDeviceAudio = false;
          this.activeAudioBytes = 0;
          this.audioOverflowed = true;
          this.lastCancelledRequestId = message.requestId;
          await this.sendStage('stopped', { requestId: message.requestId, mode: this.getMode(), cancelled: true, submissionRequested: false });
          return { success: true, cancelled: true, submissionRequested: false };
        } catch (cancelError) { return this.fail(cancelError, message.requestId); }
      }
      if (!started) this.activeMode = null;
      return this.fail(error, message.requestId);
    }
  }

  async appendAudio(message = {}) {
    if (!this.voiceRecognizer || (this.activeMode !== 'api' && this.activeMode !== 'virtual_micro')) return { success: true, ignored: true };
    const status = this.voiceRecognizer.getStatus ? this.voiceRecognizer.getStatus() : {};
    if (!status.acceptsAudio) return { success: true, ignored: true };
    try {
      if (message.chunk) await this.voiceRecognizer.appendAudio(message.chunk);
      this.activeAudioBytes += audioByteLength(message.chunk);
      return { success: true, state: 'recording', mode: this.activeMode };
    } catch (error) {
      return this.fail(error, message.requestId);
    }
  }

  async resolveMicroSubmission(context) {
    if (!context || typeof context !== 'object') throw new Error('Codex Micro submission context is unavailable.');
    const state = String(context && (context.executionState || context.state) || '').trim().toLowerCase();
    const isExecuting = ['active', 'running', 'working'].includes(state);
    const layout = await this.getMicroLayout();
    const key = commandKey(layout, 'composer.submit');
    if (!key) throw new Error('请在 Codex Micro 中绑定发送命令（CODEX）。');
    return { key, submission: isExecuting ? normalizeFollowUpQueueMode(context.followUpQueueMode) : 'send',
      taskId: context.taskId || null, executionState: state,
      followUpQueueMode: normalizeFollowUpQueueMode(context.followUpQueueMode) };
  }

  async end(message = {}) {
    try {
      if (message.cancelled === true && message.requestId && message.requestId === this.lastCancelledRequestId) {
        return { success: true, cancelled: true, idempotent: true, submissionRequested: false };
      }
      const currentStatus = this.voiceRecognizer && this.voiceRecognizer.getStatus
        ? this.voiceRecognizer.getStatus()
        : { active: this.activeMode !== null, mode: this.activeMode || 'virtual_micro' };
      const mode = this.activeMode || currentStatus.mode;
      if (!currentStatus.active && !this.activeMode) {
        throw new Error('Voice recording is not active.');
      }

      if (this.activeRequestId && message.requestId !== this.activeRequestId) {
        const error = 'Codex Micro push-to-talk belongs to a different request.';
        this.onLog('warning', error);
        await this.sendStage('error', { requestId: message.requestId, mode, message: error });
        return { success: false, error };
      }

      if (isMicroMode(mode)) {
        if (!this.voiceRecognizer || typeof this.voiceRecognizer.stop !== 'function') {
          throw new Error('Codex Micro controller is unavailable.');
        }
        if (message.cancelled === true) {
          this.audioOverflowed = true;
          this.discardQueuedAudio();
          const result = await this.cancelCurrentInput();
          if (result?.delivery !== 'submitted_to_hid') throw new Error('PTT release could not be confirmed.');
          this.lastCancelledRequestId = message.requestId;
          this.activeMode = null;
          this.activeRequestId = null;
          this.activeAudioBytes = 0;
          this.activeRequiresDeviceAudio = false;
          this.activeSubmissionContext = null;
          await this.sendStage('stopped', {
            requestId: message.requestId,
            mode,
            cancelled: true,
            delivery: result && result.delivery || 'not_sent',
            outcome: result && result.outcome || 'unknown',
            submission: 'none',
            submissionRequested: false,
            submissionConfirmed: false,
            recordingConfirmed: false
          });
          return { success: true, mode, cancelled: true, submissionRequested: false };
        }

        if (this.activeRequiresDeviceAudio && this.activeAudioBytes === 0) {
          const result = await this.voiceRecognizer.stop();
          this.activeMode = null;
          this.activeRequestId = null;
          this.audioOverflowed = true;
          this.activeAudioBytes = 0;
          this.activeRequiresDeviceAudio = false;
          this.activeSubmissionContext = null;
          await this.sendStage('stopped', {
            requestId: message.requestId,
            mode,
            delivery: result && result.delivery || 'not_sent',
            outcome: result && result.outcome || 'unknown',
            submission: 'none',
            submissionRequested: false,
            submissionConfirmed: false,
            recordingConfirmed: false,
            message: 'Automatic submission was skipped because no device audio was received.'
          });
          return { success: false, mode, error: 'No device audio was received.', submissionRequested: false };
        }

        let submission;
        try {
          const currentContext = await this.getSubmissionContext();
          if (!sameSubmissionTarget(this.activeSubmissionContext, currentContext)) {
            throw new Error('Codex target changed while dictating; automatic submission was cancelled.');
          }
          submission = await this.resolveMicroSubmission(currentContext);
        } catch (error) {
          // A missing or unreadable layout must never lead to a hard-coded
          // ACT12 send. Release the current capture without submitting it.
          const result = await this.voiceRecognizer.stop();
          this.activeMode = null;
          this.activeRequestId = null;
          this.audioOverflowed = true;
          this.activeAudioBytes = 0;
          this.activeRequiresDeviceAudio = false;
          this.activeSubmissionContext = null;
          await this.sendStage('stopped', {
            requestId: message.requestId,
            mode,
            delivery: result && result.delivery || 'not_sent',
            outcome: result && result.outcome || 'unknown',
            submission: 'none',
            submissionRequested: false,
            submissionConfirmed: false,
            recordingConfirmed: false,
            message: `Automatic submission was skipped: ${error.message}`
          });
          return { success: false, mode, error: error.message, submissionRequested: false };
        }
        await this.sendStage('submitting', {
          requestId: message.requestId,
          mode,
          submission: submission.submission,
          submissionRequested: false,
          submissionConfirmed: false,
          taskId: submission.taskId,
          executionState: submission.executionState,
          followUpQueueMode: submission.followUpQueueMode
        });
        const result = await this.voiceRecognizer.stop({
          beforeSubmission: async () => {
            const current = await this.getSubmissionContext();
            if (this.audioOverflowed || !sameSubmissionTarget(this.activeSubmissionContext, current)) {
              throw new Error('任务或连接已变化，已取消本次语音发送。');
            }
            // Resolve again after draining device audio; task state and the
            // Micro layout may have changed while awaiting the audio bridge.
            submission = await this.resolveMicroSubmission(current);
            await this.assertSubmissionTarget(this.activeSubmissionContext);
            return {
              submissionKey: submission.key || undefined,
            };
          },
          ...(submission.key ? { submissionKey: submission.key } : {})
        });
        if (!result || result.delivery !== 'submitted_to_hid') {
          throw new Error('Codex Micro HID PTT release was not acknowledged.');
        }
        const submissionConfirmed = false;
        this.audioOverflowed = true;
        this.discardQueuedAudio();
        this.activeMode = null;
        this.activeRequestId = null;
        this.audioOverflowed = true;
        this.activeAudioBytes = 0;
        this.activeRequiresDeviceAudio = false;
        this.activeSubmissionContext = null;
        await this.sendStage('stopped', {
          requestId: message.requestId,
          mode,
          delivery: result.delivery,
          outcome: result.outcome || 'unknown',
          submission: submission.submission,
          submissionRequested: Boolean(result.submission && result.submission.delivery
            && result.submission.delivery !== 'not_sent'),
          submissionConfirmed,
          taskId: submission.taskId,
          executionState: submission.executionState,
          followUpQueueMode: submission.followUpQueueMode,
          recordingConfirmed: false
        });
        this.onLog('info', `${mode} native dictation send was requested through the active Micro layout; Codex completion is unconfirmed.`);
        return {
          success: true,
          mode,
          delivery: result.delivery,
          submission: submission.submission,
          submissionRequested: Boolean(result.submission && result.submission.delivery
            && result.submission.delivery !== 'not_sent'),
          submissionConfirmed
        };
      }

      if (message.cancelled === true) {
        await this.voiceRecognizer.cancel();
        this.activeMode = null;
        this.activeRequestId = null;
        this.activeSubmissionContext = null;
        await this.sendStage('stopped', { requestId: message.requestId, mode, cancelled: true, submissionRequested: false });
        return { success: true, cancelled: true };
      }
      await this.sendStage('recognizing', {
        requestId: message.requestId,
        mode
      });
      const result = await this.voiceRecognizer.stop();
      this.activeMode = null;
      this.audioOverflowed = true;
      const text = String(result.text || '').trim();
      if (!text) throw new Error('API speech recognition returned no text.');

      this.onResult(text);
      this.onLog('info', `${result.mode} transcription completed.`);
      await this.sendToDevice({ type: 'voice_recognized', text, requestId: message.requestId });
      await this.sendStage('submitting', {
        requestId: message.requestId,
        mode: result.mode
      });

      const currentContext = await this.getSubmissionContext();
      if (!sameSubmissionTarget(this.activeSubmissionContext, currentContext)) {
        throw new Error('任务已变化，已取消本次语音发送。');
      }
      await this.assertSubmissionTarget(this.activeSubmissionContext);
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
      this.activeRequestId = null;
      this.activeSubmissionContext = null;
      this.onSubmitted(inputResult);
      return { success: true, text, inputResult };
    } catch (error) {
      return this.fail(error, message.requestId);
    }
  }
}

module.exports = DeviceVoiceSession;
module.exports.normalizeFollowUpQueueMode = normalizeFollowUpQueueMode;
module.exports.sameSubmissionTarget = sameSubmissionTarget;
