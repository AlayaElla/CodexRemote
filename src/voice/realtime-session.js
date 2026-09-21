const { EventEmitter } = require('events');

const validId = value => typeof value === 'string' && /^[\w.:-]{1,128}$/.test(value);
const PHASES = new Set(['listening', 'thinking', 'speaking', 'muted']);

// Owns one native call and both audio directions. No dictation or task submission.
class RealtimeSession extends EventEmitter {
  constructor(options) {
    super();
    Object.assign(this, options);
    this.active = null;
    this.operation = Promise.resolve();
    this.pendingStarts = new Set();
    this.cancelledStarts = new Set();
  }
  get busy() { return Boolean(this.active); }
  getStatus() { return this.active ? { state: this.active.state, requestId: this.active.id } : { state: 'ended' }; }
  async publish(call, state, message) {
    if (this.active !== call) return;
    call.state = state;
    const acceptsAudio = call.ready && !call.muted && ['listening', 'thinking'].includes(state);
    call.acceptsAudio = acceptsAudio;
    const status = { type: 'realtime_status', requestId: call.id, state, acceptsAudio,
      host_id: call.context.hostId, thread_id: call.context.taskId, stream_id: call.context.streamId,
      ...(message ? { message } : {}) };
    this.emit('status', status);
    if (await this.send(status) === false) throw new Error('设备已断开，实时语音状态发送失败。');
  }
  handle(message) {
    if (!validId(message?.requestId)) return Promise.resolve(false);
    if (message.type === 'realtime_start') this.pendingStarts.add(message.requestId);
    if (message.type === 'realtime_end' && this.pendingStarts.has(message.requestId)) this.cancelledStarts.add(message.requestId);
    // An end request closes the uplink gate immediately, even during native startup.
    if (message.type === 'realtime_end' && this.active?.id === message.requestId) {
      this.active.cancelled = true;
      this.active.acceptsAudio = false;
    }
    const run = this.operation.catch(() => {}).then(async () => {
      if (message.type === 'realtime_start') {
        try { return await this.start(message); }
        finally { this.pendingStarts.delete(message.requestId); this.cancelledStarts.delete(message.requestId); }
      }
      const call = this.active;
      if (!call || call.id !== message.requestId) return false;
      try {
        if (message.type === 'realtime_end') return this.stop('ended');
        await this.assertTarget(call.context);
        if (message.type === 'realtime_mute') {
          if (typeof message.muted !== 'boolean') throw new Error('无效的静音状态。');
          await call.native.setMuted(message.muted);
          call.muted = message.muted;
          await call.audio.discard();
          if (!call.muted) await call.audio.start(call.inputDeviceId);
          return this.publish(call, call.muted ? 'muted' : 'listening');
        }
        if (message.type === 'realtime_interrupt') {
          if (call.native.supportsInterrupt !== true) {
            return this.publish(call, call.state, '当前 Codex 版本暂不支持设备端打断回答。');
          }
          await this.clearAudio(call);
          await call.native.interrupt();
          return this.publish(call, call.muted ? 'muted' : 'listening');
        }
      } catch (error) { await this.stop('error', error.message); }
      return false;
    });
    this.operation = run;
    return run;
  }
  async start(message) {
    if (this.active?.id === message.requestId) return this.publish(this.active, this.active.state);
    if (this.active || this.isOtherVoiceBusy()) {
      return this.send({ type: 'realtime_status', requestId: message.requestId, state: 'error', acceptsAudio: false,
        host_id: message.host_id, thread_id: message.thread_id, stream_id: message.stream_id, message: '请先结束当前语音会话。' });
    }
    let call;
    try {
      const context = await this.getTarget({ ...message, requireTarget: true });
      if (this.cancelledStarts.has(message.requestId)) return this.send({ type: 'realtime_status', requestId: message.requestId,
        state: 'ended', acceptsAudio: false, host_id: context.hostId, thread_id: context.taskId, stream_id: context.streamId });
      if (!context.taskId) throw new Error('请先选择一个已建立的 Codex 任务。');
      const config = this.getConfig();
      if (!config.realtime?.outputDeviceId) throw new Error('请在电脑语音设置中选择 Codex 专属回答音频设备。');
      if (config.virtualMicro.audioSource !== 'esp32') throw new Error('请将音频来源设为 ESP32 麦克风。');
      call = { id: message.requestId, context, state: 'connecting', generation: 1, sequence: 0,
        inputSequence: -1, inputDeviceId: config.virtualMicro.audioDeviceId || '', ready: false,
        muted: false, acceptsAudio: false, cancelled: false, pendingInput: 0, pendingOutput: 0,
        native: this.nativeFactory(), audio: this.audioFactory() };
      this.active = call;
      await this.publish(call, 'connecting');
      call.onFault = error => { if (this.active === call) void this.stop('error', error.message).catch(() => {}); };
      call.onAudio = packet => { void this.output(call, packet).catch(call.onFault); };
      call.onState = event => {
        if (this.active !== call || !call.ready || call.cancelled) return;
        const state = typeof event === 'string' ? event : event.state;
        if (state === 'ended' || state === 'disconnected' || state === 'error') {
          void this.stop(state, event.message).catch(() => {});
        } else if (PHASES.has(state)) {
          void this.publish(call, call.muted ? 'muted' : state).catch(call.onFault);
        }
      };
      call.audio.on('audio', call.onAudio); call.audio.on('fault', call.onFault);
      call.native.on('state', call.onState); call.native.on('fault', call.onFault);
      // Initialize answer capture before opening the microphone render stream.
      // Opening WASAPI loopback immediately after render startup can block.
      const capture = await call.audio.startCapture(config.realtime.outputDeviceId, call.inputDeviceId);
      if (this.active !== call || call.cancelled) throw new Error('语音连接已取消。');
      await call.audio.start(call.inputDeviceId);
      await this.assertTarget(context);
      if (this.active !== call || call.cancelled) throw new Error('语音连接已取消。');
      const result = await call.native.start(context, {
        inputCaptureName: call.audio.getStatus?.().captureName,
        outputDeviceId: config.realtime.outputDeviceId,
        outputDeviceName: capture?.name
      });
      if (result?.confirmed !== true) throw new Error('未能确认 Codex 原生语音已连接。');
      if (this.active !== call || call.cancelled) throw new Error('语音连接已取消。');
      await this.assertTarget(context);
      call.ready = true;
      await this.send({ type: 'realtime_audio_clear', requestId: call.id, generation: 1,
        host_id: context.hostId, thread_id: context.taskId, stream_id: context.streamId });
      call.guard = setInterval(() => {
        Promise.resolve().then(() => this.assertTarget(context)).catch(call.onFault);
      }, 500);
      call.guard.unref?.();
      const initialState = typeof result.state === 'string' ? result.state : result.state?.state;
      return this.publish(call, PHASES.has(initialState) ? initialState : 'listening');
    } catch (error) {
      if (call && this.active === call) return this.stop(call.cancelled ? 'ended' : 'error', call.cancelled ? undefined : error.message);
      if (!call) return this.send({ type: 'realtime_status', requestId: message.requestId, state: 'error', acceptsAudio: false,
        host_id: message.host_id, thread_id: message.thread_id, stream_id: message.stream_id, message: error.message });
    }
  }
  async input(message) {
    const call = this.active;
    if (!call || call.cancelled || !call.acceptsAudio || message.requestId !== call.id || message.generation !== 1) return false;
    if (message.codec !== 'opus' || !Number.isSafeInteger(message.sequence) || message.sequence <= call.inputSequence ||
        typeof message.data !== 'string' || message.data.length > 5464 || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.data)) return false;
    const packet = Buffer.from(message.data, 'base64');
    if (!packet.length || packet.length > 4096 || packet.toString('base64') !== message.data) return false;
    if (call.pendingInput >= 8) { await this.stop('error', '上行音频队列拥塞，请重新连接。'); return false; }
    call.inputSequence = message.sequence;
    call.pendingInput++;
    try { await call.audio.append(packet); return true; }
    catch (error) { if (this.active === call) await this.stop('error', error.message); return false; }
    finally { call.pendingInput--; }
  }
  async output(call, packet) {
    if (this.active !== call || !call.ready || call.cancelled) return;
    if (call.pendingOutput >= 8) throw new Error('下行音频队列拥塞，请重新连接。');
    if (packet.sampleRate !== 16000 || packet.frameDuration !== 20 || typeof packet.packet !== 'string' ||
        !packet.packet.length || packet.packet.length > 5464 ||
        Buffer.from(packet.packet, 'base64').length > 4096 ||
        Buffer.from(packet.packet, 'base64').toString('base64') !== packet.packet) throw new Error('回答音频帧无效。');
    call.pendingOutput++;
    try {
      const ok = await this.send({ type: 'realtime_audio', requestId: call.id, generation: call.generation,
        host_id: call.context.hostId, thread_id: call.context.taskId, stream_id: call.context.streamId,
        sequence: ++call.sequence, codec: 'opus', data: packet.packet,
        sampleRate: packet.sampleRate, frameDuration: packet.frameDuration });
      if (ok === false) throw new Error('回答音频发送失败。');
    } finally { call.pendingOutput--; }
  }
  async clearAudio(call) {
    await this.send({ type: 'realtime_audio_clear', requestId: call.id, generation: ++call.generation,
      host_id: call.context.hostId, thread_id: call.context.taskId, stream_id: call.context.streamId });
  }
  async stop(state = 'ended', message) {
    const call = this.active;
    if (!call) return;
    if (call.stopping) return call.stopping;
    call.cancelled = true; call.ready = false; call.acceptsAudio = false;
    clearInterval(call.guard);
    call.stopping = (async () => {
      if (call.onAudio) call.audio.removeListener('audio', call.onAudio);
      if (call.onFault) call.audio.removeListener('fault', call.onFault);
      if (call.onState) call.native.removeListener('state', call.onState);
      if (call.onFault) call.native.removeListener('fault', call.onFault);
      try {
        await this.clearAudio(call).catch(() => {});
        const cleanup = await Promise.allSettled([call.native.stop(call.context), call.audio.dispose()]);
        const failure = cleanup.find(result => result.status === 'rejected');
        if (failure) {
          state = 'error';
          message = `语音清理未确认，请检查电脑端通话：${failure.reason?.message || failure.reason}`;
        }
        await this.publish(call, state, message);
      } finally { if (this.active === call) this.active = null; }
    })();
    return call.stopping;
  }
  async dispose() { return this.stop('ended'); }
}
module.exports = RealtimeSession;
