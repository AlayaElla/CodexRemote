const DEVICE_VISIBLE_AGENT_MESSAGE_TYPES = new Set([
  'chat',
  'status',
  'stop',
  'approval_request'
]);

function shouldForwardAgentMessageToDevice(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && DEVICE_VISIBLE_AGENT_MESSAGE_TYPES.has(message.type)
  );
}

module.exports = {
  DEVICE_VISIBLE_AGENT_MESSAGE_TYPES,
  shouldForwardAgentMessageToDevice
};
