const assert = require('assert');
const { shouldForwardAgentMessageToDevice } = require('../src/core/agent-message-policy');

assert.equal(shouldForwardAgentMessageToDevice({ type: 'chat', role: 'codex', text: 'progress' }), true);
assert.equal(shouldForwardAgentMessageToDevice({ type: 'status', state: 'working' }), true);
assert.equal(shouldForwardAgentMessageToDevice({ type: 'stop', text: 'done' }), true);
assert.equal(shouldForwardAgentMessageToDevice({ type: 'approval_request', id: 'approval-1' }), true);

assert.equal(shouldForwardAgentMessageToDevice({ type: 'tool_call' }), false);
assert.equal(shouldForwardAgentMessageToDevice({ type: 'tool_result' }), false);
assert.equal(shouldForwardAgentMessageToDevice({ type: 'agent_event' }), false);
assert.equal(shouldForwardAgentMessageToDevice(null), false);

console.log('agent message policy test passed');
