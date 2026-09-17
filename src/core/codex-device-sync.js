const { shouldForwardAgentMessageToDevice } = require('./agent-message-policy');

function scopedTaskEvent(snapshot, message) {
  const target = snapshot?.slots[snapshot.selectedSlot] || snapshot?.activeTask;
  const hostId = message?.host_id || message?.hostId || 'local';
  const threadId = message?.session_id || message?.thread_id;
  if (!target?.threadId || target.hostId !== hostId || target.threadId !== threadId) return null;
  // Chat and runtime status come from the same ordered task snapshot. Hook
  // duplicates and late completion events cannot overwrite it.
  if (message.type === 'approval_request') return { ...message, host_id: hostId, thread_id: threadId };
  if (message.type === 'stop') return { type: 'task_complete', host_id: hostId, thread_id: threadId };
  return null;
}

function isUserChatMessage(message) {
  return Boolean(
    message
    && message.type === 'chat'
    && message.role === 'user'
  );
}

function nextCodexTaskState(currentState, message) {
  if (isUserChatMessage(message)) return 'working';
  if (message && message.type === 'status' && message.state) return message.state;
  if (message && message.type === 'stop') return 'idle';
  return currentState || 'idle';
}

function createStatusSnapshot(state) {
  return {
    type: 'status',
    state: state || 'idle'
  };
}

function prepareAgentDeviceSync(currentState, message) {
  const state = nextCodexTaskState(currentState, message);
  const messages = shouldForwardAgentMessageToDevice(message) ? [message] : [];

  // UserPromptSubmit is the earliest reliable signal that a new turn is
  // active. Send the task state with the prompt so the device switches to its
  // stop affordance without waiting for the first assistant/tool event.
  if (isUserChatMessage(message)) {
    messages.push(createStatusSnapshot(state));
  }

  return { state, messages };
}

module.exports = {
  scopedTaskEvent,
  createStatusSnapshot,
  isUserChatMessage,
  nextCodexTaskState,
  prepareAgentDeviceSync
};
