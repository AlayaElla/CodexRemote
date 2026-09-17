const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const AgentBridge = require('../src/core/agent-bridge');
const CodexHookCollector = require('../src/collectors/codex-hook-collector');
const { describeToolCall } = CodexHookCollector;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForMessage(collector, type) {
  return new Promise((resolve) => {
    const onMessage = (message) => {
      if (message.type !== type) return;
      collector.removeListener('message', onMessage);
      resolve(message);
    };
    collector.on('message', onMessage);
  });
}

function waitForMatchingMessage(collector, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      collector.removeListener('message', onMessage);
      reject(new Error('timed out waiting for matching collector message'));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      collector.removeListener('message', onMessage);
      resolve(message);
    };
    collector.on('message', onMessage);
  });
}

function startHook(port, payload) {
  const hookPath = path.join(__dirname, '..', 'hooks', 'codex-hook.js');
  const eventName = payload.hook_event_name;
  const routeByEvent = {
    UserPromptSubmit: 'user-prompt',
    PreToolUse: 'pre',
    PostToolUse: 'post',
    PermissionRequest: 'waiting',
    Stop: 'stop'
  };
  const hookPayload = { ...payload };
  delete hookPayload.hook_event_name;
  const child = spawn(process.execPath, [
    hookPath,
    routeByEvent[eventName],
    '--port', String(port)
  ], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(hookPayload));

  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`hook ${payload.hook_event_name} timed out`));
    }, 5000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`hook ${payload.hook_event_name} exited ${code}: ${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
  return { child, completion };
}

async function runHook(port, payload) {
  return startHook(port, payload).completion;
}

async function main() {
  const hookPort = await getFreePort();
  const untouchedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-read-only-proof-'));
  const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-transcript-proof-'));
  const transcriptPath = path.join(transcriptDir, 'rollout.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const collector = new CodexHookCollector({
    hookPort,
    approvalTimeoutMs: 1000,
    transcriptPollIntervalMs: 20,
    codexDir: untouchedDir
  });
  const bridge = new AgentBridge(collector);
  const bridgedMessages = [];
  bridge.on('agent-message', (message) => bridgedMessages.push(message));

  try {
    await bridge.start();
    assert.deepEqual(fs.readdirSync(untouchedDir), [], 'collector must not touch Codex directories');

    const originalObserveTranscript = collector.observeTranscript.bind(collector);
    let releasePromptTranscript;
    collector.observeTranscript = () => new Promise((resolve) => {
      releasePromptTranscript = resolve;
    });
    const userMessagePromise = waitForMessage(collector, 'chat');
    const userHook = startHook(hookPort, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-1',
      turn_id: 'turn-1',
      transcript_path: transcriptPath,
      prompt: '用户消息'
    });
    const userMessage = await userMessagePromise;
    assert.equal(userMessage.role, 'user');
    assert.equal(userMessage.text, '用户消息');
    assert.equal(typeof releasePromptTranscript, 'function');
    releasePromptTranscript();
    await userHook.completion;
    collector.observeTranscript = originalObserveTranscript;
    await collector.observeTranscript({
      session_id: 'session-1',
      turn_id: 'turn-1',
      transcript_path: transcriptPath
    });

    const commentaryText = 'I will inspect the message flow before continuing.';
    const commentaryTimestamp = new Date().toISOString();
    const commentaryPromise = waitForMatchingMessage(
      collector,
      (message) => message.type === 'chat' && message.phase === 'commentary'
    );
    fs.appendFileSync(transcriptPath, `${JSON.stringify({
      timestamp: commentaryTimestamp,
      type: 'event_msg',
      payload: { type: 'agent_message', message: commentaryText, phase: 'commentary' }
    })}\n`, 'utf8');
    fs.appendFileSync(transcriptPath, `${JSON.stringify({
      timestamp: commentaryTimestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: commentaryText }]
      }
    })}\n`, 'utf8');
    const commentaryMessage = await commentaryPromise;
    assert.equal(commentaryMessage.role, 'codex');
    assert.equal(commentaryMessage.text, commentaryText);
    assert.equal(commentaryMessage.session_id, 'session-1');
    assert.equal(commentaryMessage.turn_id, 'turn-1');

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      bridgedMessages.filter((message) => message.type === 'chat' && message.text === commentaryText).length,
      1,
      'event_msg and response_item copies of one commentary must be deduplicated'
    );

    const fallbackText = 'Continue with the focused test.';
    const fallbackPromise = waitForMatchingMessage(
      collector,
      (message) => message.type === 'chat' && message.text === fallbackText
    );
    fs.appendFileSync(transcriptPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: fallbackText }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
      }
    })}\n`, 'utf8');
    assert.equal((await fallbackPromise).text, fallbackText);
    assert.equal(userMessage.text, '用户消息');

    const toolCallPromise = waitForMessage(collector, 'tool_call');
    await runHook(hookPort, {
      hook_event_name: 'PreToolUse',
      session_id: 'session-1',
      turn_id: 'turn-1',
      tool_use_id: 'tool-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    });
    const toolCall = await toolCallPromise;
    assert.equal(toolCall.id, 'tool-1');
    assert.equal(toolCall.description, '运行命令：npm test');
    assert.deepEqual(toolCall.input, { command: 'npm test' });

    const toolResultPromise = waitForMessage(collector, 'tool_result');
    await runHook(hookPort, {
      hook_event_name: 'PostToolUse',
      session_id: 'session-1',
      turn_id: 'turn-1',
      tool_use_id: 'tool-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0, output: 'passed' }
    });
    const toolResult = await toolResultPromise;
    assert.equal(toolResult.description, '运行命令：npm test');
    assert.deepEqual(toolResult.output, { exit_code: 0, output: 'passed' });

    const stopMessagePromise = waitForMessage(collector, 'stop');
    const stopResult = await runHook(hookPort, {
      hook_event_name: 'Stop',
      session_id: 'session-1',
      turn_id: 'turn-1',
      transcript_path: transcriptPath,
      stop_hook_active: false,
      last_assistant_message: '最终回复'
    });
    const stopMessage = await stopMessagePromise;
    assert.equal(stopMessage.role, 'codex');
    assert.equal(collector.transcriptWatches.size, 0, 'Stop must release the transcript watcher');
    assert.equal(stopMessage.text, '最终回复');
    assert.deepEqual(JSON.parse(stopResult.stdout), {});

    const approvalMessagePromise = waitForMessage(collector, 'approval_request');
    const approvalHook = startHook(hookPort, {
      hook_event_name: 'PermissionRequest',
      session_id: 'session-1',
      turn_id: 'turn-1',
      tool_name: 'Bash',
      tool_input: { command: 'git push', description: '允许推送代码吗？' }
    });
    const approvalMessage = await approvalMessagePromise;
    assert.equal(approvalMessage.question, '允许推送代码吗？');
    assert.deepEqual(
      approvalMessage.options.map((option) => option.id),
      ['allow', 'allow_session', 'deny']
    );
    assert.equal(bridge.resolveApproval(approvalMessage.id, 'allow'), true);
    const approvalResult = await approvalHook.completion;
    assert.deepEqual(JSON.parse(approvalResult.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' }
      }
    });

    const denyMessagePromise = waitForMessage(collector, 'approval_request');
    const denyHook = startHook(hookPort, {
      hook_event_name: 'PermissionRequest',
      session_id: 'session-1',
      turn_id: 'turn-1',
      tool_name: 'apply_patch',
      tool_input: { command: '*** Begin Patch' }
    });
    const denyMessage = await denyMessagePromise;
    assert.equal(bridge.resolveApproval(denyMessage.id, 'deny'), true);
    const denyResult = await denyHook.completion;
    assert.deepEqual(JSON.parse(denyResult.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Denied from Codex Remote' }
      }
    });

    const sessionMessagePromise = waitForMessage(collector, 'approval_request');
    const sessionHook = startHook(hookPort, {
      hook_event_name: 'PermissionRequest',
      session_id: 'session-1',
      turn_id: 'turn-1',
      tool_name: 'PowerShell',
      tool_input: { command: 'Get-Date' }
    });
    const sessionMessage = await sessionMessagePromise;
    assert.equal(bridge.resolveApproval(sessionMessage.id, 'allow_session'), true);
    const sessionResult = await sessionHook.completion;
    assert.equal(JSON.parse(sessionResult.stdout).hookSpecificOutput.decision.behavior, 'allow');

    const rememberedResult = await runHook(hookPort, {
      hook_event_name: 'PermissionRequest',
      session_id: 'session-1',
      turn_id: 'turn-2',
      tool_name: 'PowerShell',
      tool_input: { command: 'Get-Location' }
    });
    assert.equal(JSON.parse(rememberedResult.stdout).hookSpecificOutput.decision.behavior, 'allow');

    collector.approvalMode = 'off';
    const messageCountBeforeOff = bridgedMessages.length;
    const offResult = await runHook(hookPort, {
      hook_event_name: 'PermissionRequest',
      session_id: 'session-1',
      turn_id: 'turn-4',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    });
    assert.deepEqual(JSON.parse(offResult.stdout), {});
    assert.equal(bridgedMessages.length, messageCountBeforeOff);
    collector.approvalMode = 'intercept';

    assert.equal(bridge.resolveApproval('missing', 'deny'), false);
    const expiredId = 'closed-response-test';
    collector.pendingApprovals.set(expiredId, {
      res: { destroyed: true, headersSent: false, writableEnded: false },
      timer: setTimeout(() => {}, 60000), approvalKey: 'must-not-be-remembered'
    });
    assert.equal(bridge.resolveApproval(expiredId, 'allow_session'), false);
    assert.equal(collector.sessionAllowedTools.has('must-not-be-remembered'), false);
    const expiredEvent = bridgedMessages.find(message => message.type === 'approval_resolved' && message.id === expiredId);
    assert.equal(expiredEvent.decision, null);
    assert.equal(expiredEvent.reason, 'disconnected');
    assert(bridgedMessages.some(message => message.type === 'approval_resolved' && message.id === approvalMessage.id && message.decision === 'allow'));
    assert.equal(bridge.sendUserInput('not supported').success, false);
    assert(bridgedMessages.some((message) => message.type === 'tool_call'));
    assert.equal(describeToolCall('Read', { file_path: 'src/main.js' }), '读取文件：src/main.js');
    assert.equal(describeToolCall('Grep', { pattern: 'TODO' }), '搜索：TODO');
    assert.equal(
      describeToolCall('apply_patch', { patch: '*** Update File: src/main.js\n@@' }),
      '修改文件：src/main.js'
    );
    assert.equal(
      describeToolCall('custom_tool', { api_key: 'secret', mode: 'fast' }),
      '调用 custom_tool（mode=fast）'
    );
    assert.equal(describeToolCall('functions.exec', { input: 'await tools.get_status()' }), '执行内容：await tools.get_status()');
    assert.deepEqual(fs.readdirSync(untouchedDir), [], 'collector must remain filesystem-independent');
  } finally {
    await bridge.stop();
    fs.rmSync(untouchedDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  }

  console.log('codex hook collector test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
