const { createHash } = require('node:crypto');

function targetKey(snapshot) {
  const task = snapshot.slots[snapshot.selectedSlot] || snapshot.activeTask;
  return task ? `${task.hostId}:${task.threadId}` : '';
}

// Follow explicit live submissions, never history snapshots or assistant activity.
class CodexSubmissionFollow {
  constructor({ state, controls, isBusy, beforeSelect = () => {}, now = Date.now, timers = global }) {
    Object.assign(this, { state, controls, isBusy, beforeSelect, now, timers });
    this.startedAt = now();
    this.lastSubmittedAt = this.startedAt;
    this.seen = new Map();
    this.pending = null;
    this.timer = null;
    this.closed = false;
    this.onState = () => {
      if (!state.getSnapshot().connected) this.cancel();
      else if (this.pending && targetKey(state.getSnapshot()) !== this.pending.previousTarget) this.cancel();
    };
    this.onCancel = () => this.cancel();
    state.on('state', this.onState);
    controls.on('cancel', this.onCancel);
  }

  observe(message) {
    if (this.closed || message?.source !== 'codex-hooks' || message.type !== 'chat' || message.role !== 'user') return false;
    const threadId = message.session_id || message.thread_id;
    const hostId = message.host_id || message.hostId || 'local';
    const time = this.now();
    if (hostId !== 'local' || typeof threadId !== 'string' || !/^[\w-]{1,128}$/.test(threadId)
      || !Number.isFinite(message.timestamp) || message.timestamp < this.startedAt
      || message.timestamp < this.lastSubmittedAt
      || time - message.timestamp > 30000 || message.timestamp > time + 1000) return false;
    const digest = createHash('sha256').update(JSON.stringify([hostId, threadId, message.turn_id, message.text])).digest('hex');
    const previous = this.seen.get(digest);
    if (previous !== undefined && (message.turn_id || time - previous < 2000)) return false;
    this.seen.set(digest, time);
    this.lastSubmittedAt = message.timestamp;
    if (this.seen.size > 512) this.seen.delete(this.seen.keys().next().value);
    const snapshot = this.state.getSnapshot();
    if (!snapshot.connected) return false;
    this.cancel();
    this.pending = { threadId, hostId, previousTarget: targetKey(snapshot), expiresAt: time + 30000,
      controlsGeneration: this.controls.generation };
    this.flush();
    return true;
  }

  flush() {
    const pending = this.pending;
    if (!pending || this.closed) return;
    const snapshot = this.state.getSnapshot();
    if (!snapshot.connected || this.now() >= pending.expiresAt
      || this.controls.generation !== pending.controlsGeneration
      || targetKey(snapshot) !== pending.previousTarget) return this.cancel();
    if (this.isBusy() || this.controls.isBusy()) {
      this.timer = this.timers.setTimeout(() => { this.timer = null; this.flush(); }, 100);
      this.timer?.unref?.();
      return;
    }
    this.cancel();
    const sameTask = targetKey(snapshot) === `${pending.hostId}:${pending.threadId}`;
    if (sameTask && !this.controls.pendingNewTask) return;
    // Retire draft resolution before publishing the real submitted identity.
    this.controls.invalidate();
    this.beforeSelect();
    this.state.selectThread(pending.threadId, pending.hostId);
  }

  cancel() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  stop() {
    this.closed = true;
    this.cancel();
    this.state.off('state', this.onState);
    this.controls.off('cancel', this.onCancel);
    this.seen.clear();
  }
}

module.exports = { CodexSubmissionFollow };
