const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { CodexMicroSlots } = require('../core/codex-micro-slots');

const KEYCAP_COMMANDS = { FAST: 'composer.toggleFastMode', 'MIND+': 'composer.increaseReasoningEffort',
  'MIND-': 'composer.decreaseReasoningEffort', APPR: 'approval.approve', REJ: 'approval.decline',
  SPLIT: 'forkThread', NEW: 'newTask', CODEX: 'composer.submit' };

class MacController extends EventEmitter {
  constructor(config = {}, options = {}) {
    super();
    this.options = options;
    this.runtime = options.runtime || new CodexMicroSlots({ platform: 'darwin' });
    this.execFile = options.execFile || execFile;
    this.getLayout = options.getMicroLayout || (() => ({}));
    this.queue = Promise.resolve();
    this.pending = 0;
    this.generation = 0;
    this.pttTarget = null;
    this.heartbeat = null;
    this.state = { supported: true, configured: true, connected: false, microConnected: false,
      driverAvailable: false, hidEnumerated: false, transport: 'desktop_runtime', profile: config.profile || 'codex-micro-v1', lastError: null };
  }
  getStatus() { return { ...this.state }; }
  publish() { this.emit('status', this.getStatus()); }
  fault(error) {
    this.state.connected = this.state.microConnected = false;
    this.state.lastError = error.message;
    this.publish();
    this.emit('fault', error);
  }
  async connect() {
    if (this.pttTarget && !this.state.connected) throw new Error('Codex recording release is uncertain; stop recording before reconnecting.');
    const generation = this.generation;
    const snapshot = await this.runtime.read();
    if (generation !== this.generation) throw new Error('Mac controller connection was cancelled.');
    if (!['idle', 'recording', 'processing', 'completed'].includes(snapshot.voiceState)) throw new Error('Codex dictation state is unavailable.');
    this.state.connected = this.state.microConnected = true;
    this.state.lastError = null;
    if (!this.heartbeat) {
      let polling = false;
      this.heartbeat = setInterval(async () => {
        if (polling || this.pending || generation !== this.generation) return;
        polling = true;
        try { await this.runtime.read(); }
        catch (error) { if (generation === this.generation) this.fault(error); }
        finally { polling = false; }
      }, 2000);
      this.heartbeat.unref?.();
    }
    this.publish();
    return this.getStatus();
  }
  enqueue(operation) {
    if (this.pending >= 32) return Promise.reject(new Error('Mac control queue is full.'));
    const generation = this.generation;
    this.pending++;
    const result = this.queue.then(async () => {
      if (generation !== this.generation) throw new Error('Mac control request was cancelled.');
      return operation();
    }).finally(() => this.pending--);
    this.queue = result.catch(() => {});
    return result;
  }
  async context(target) {
    const snapshot = await this.runtime.read();
    if (target?.taskId && this.selectedThreadId(snapshot) !== target.taskId) throw new Error('Codex 当前任务与设备目标不一致。');
    if (target?.draftToken && (snapshot.selectedThreadKey !== null || !snapshot.composerReady)) throw new Error('Codex 新任务草稿已变化。');
    return { expectedThreadKey: snapshot.selectedThreadKey, expectedRoute: snapshot.route };
  }
  selectedThreadId(snapshot) {
    const key = snapshot.selectedThreadKey;
    if (typeof key !== 'string' || !key.startsWith('local:')) return null;
    const id = key.slice(6);
    // A newly created task can retain its client draft key after submission.
    // Micro slots use the persisted thread ID; use Codex's binding to compare
    // identities, while keeping the raw key for runtime dispatch guards.
    return id.startsWith('client-new-thread:') ? snapshot.threadBindings?.[id] || null : id;
  }
  async waitFor(predicate) {
    const generation = this.generation;
    const deadline = Date.now() + (this.options.confirmTimeoutMs || 5000);
    do {
      if (generation !== this.generation) throw new Error('Mac control confirmation was cancelled.');
      const snapshot = await this.runtime.read();
      if (predicate(snapshot)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error('尚未收到 Codex 的操作确认，请检查电脑端。');
  }
  selectTask(threadId, hostId = 'local', guard = () => {}) {
    return this.enqueue(async () => {
      guard();
      if (hostId !== 'local' || !/^[\w-]{1,128}$/.test(threadId)) throw new Error('Invalid local task identity.');
      const before = await this.runtime.read();
      if (!before.slots.some(slot => slot.threadId === threadId && slot.hostId === hostId)) throw new Error('Micro 槽位已变化。');
      if (this.selectedThreadId(before) !== threadId) {
        guard();
        await new Promise((resolve, reject) => this.execFile('/usr/bin/open', [`codex://threads/${encodeURIComponent(threadId)}`],
          { timeout: 5000, maxBuffer: 4096 }, error => error ? reject(error) : resolve()));
        await this.waitFor(snapshot => { guard(); return this.selectedThreadId(snapshot) === threadId; });
      }
      guard();
      return { delivery: 'desktop_runtime', outcome: 'confirmed' };
    });
  }
  setPtt(down) {
    return this.enqueue(async () => {
      if (typeof down !== 'boolean') throw new Error('Invalid PTT state.');
      if (down && this.pttTarget) throw new Error('Codex recording is already active.');
      if (!down && !this.pttTarget) return { delivery: 'desktop_runtime', outcome: 'confirmed' };
      const context = down ? await this.context(this.options.getTarget?.()) : this.pttTarget;
      if (down) this.pttTarget = context;
      try {
        const result = await this.runtime.request('ptt', { ...context, down });
        if (result?.outcome !== 'confirmed') throw new Error('Codex did not confirm dictation state.');
        clearTimeout(this.holdTimer);
        if (!down) this.pttTarget = null;
        else {
          this.holdTimer = setTimeout(() => {
            void this.escape().then(() => this.releaseAll()).catch(error => this.fault(error));
          }, this.options.maxHoldMs || 120000);
          this.holdTimer.unref?.();
        }
        return result;
      } catch (error) { this.fault(error); throw error; }
    });
  }
  tapKey(key) {
    return this.enqueue(async () => {
      const layout = this.getLayout()?.layout;
      const slot = layout?.slots?.[key];
      const command = slot?.action ? (slot.action.type === 'command' ? slot.action.commandId : null)
        : slot?.commandId || KEYCAP_COMMANDS[slot?.keycapId];
      if (!command) throw new Error('Mac controller requires a configured Micro command key.');
      const context = this.pttTarget || await this.context(command === 'newTask' || command === 'newThread' ? null : this.options.getTarget?.());
      const result = await this.runtime.request('command', { ...context, command: command === 'newThread' ? 'newTask' : command });
      if (command === 'newTask' || command === 'newThread') {
        await this.waitFor(snapshot => snapshot.selectedThreadKey === null && snapshot.composerReady && snapshot.route !== context.expectedRoute);
        return { delivery: 'desktop_runtime', outcome: 'confirmed' };
      }
      if (command === 'composer.submit' && this.pttTarget) {
        if (result?.voiceReleased !== true) throw new Error('Codex did not confirm dictation release after submit.');
        clearTimeout(this.holdTimer);
        this.pttTarget = null;
      }
      return result;
    });
  }
  escape({ stop = false, discard = false } = {}) {
    return this.enqueue(async () => {
      const context = this.pttTarget || await this.context(this.options.getTarget?.());
      return this.runtime.request('escape', { ...context, stop, discard });
    });
  }
  pasteText(text, target) {
    return this.enqueue(async () => ({ success: true,
      ...await this.runtime.request('paste', { ...await this.context(target), text }) }));
  }
  async resolveMicroDraft({ candidates }) {
    const snapshot = await this.runtime.read();
    const id = this.selectedThreadId(snapshot);
    return candidates?.includes(id) ? { threadId: id } : null;
  }
  releaseAll() { return this.setPtt(false); }
  async close() {
    clearInterval(this.heartbeat); this.heartbeat = null;
    clearTimeout(this.holdTimer);
    try { await this.releaseAll(); }
    finally {
      this.generation++;
      this.state.connected = this.state.microConnected = false;
      if (!this.options.runtime) this.runtime.stop();
      this.publish();
    }
  }
}

module.exports = MacController;
