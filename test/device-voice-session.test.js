const assert = require('assert');
const { EventEmitter } = require('events');
const DeviceVoiceSession = require('../src/voice/device-voice-session');
const VoiceRecognizer = require('../src/voice/voice-recognizer');

function microSubmissionOptions(context = {
  executionState: 'idle', kind: 'local', generation: 1, draftToken: 'draft-1'
}) {
  return {
    async getSubmissionContext() { return context; },
    async getMicroLayout() {
      return { layout: { slots: { ACT06: { action: { type: 'command', commandId: 'composer.submit' } } } } };
    }
  };
}

async function testMicroSessionNeverUsesDesktopOrSubmit() {
  const events = [];
  const calls = [];
  let active = false;
  const session = new DeviceVoiceSession({
    ...microSubmissionOptions(),
    voiceRecognizer: {
      getStatus() { return { mode: 'virtual_micro', active, connected: true, microConnected: true }; },
      getConfig() { return { mode: 'virtual_micro' }; },
      async start() { active = true; calls.push('start'); return { delivery: 'submitted_to_hid', outcome: 'unknown' }; },
      async stop() { active = false; calls.push('stop'); return { delivery: 'submitted_to_hid', outcome: 'unknown' }; },
      async cancel() { active = false; calls.push('cancel'); return { delivery: 'submitted_to_hid', outcome: 'unknown' }; }
    },
    async submitText() { throw new Error('Micro must not submit text'); },
    async sendToDevice(message) {
      events.push(message.type + ':' + (message.state || ''));
      return true;
    },
    onStatus(message) { events.push('ui:' + message.state); },
    onLog(_level, message) { events.push('log:' + message); },
    onSubmitted() { events.push('task-active'); }
  });

  const startPromise = session.handle({ type: 'voice_start', requestId: 'voice-1' });
  const endPromise = session.handle({ type: 'voice_end', requestId: 'voice-1' });
  assert.equal((await startPromise).success, true);
  assert.equal((await endPromise).success, true);
  assert.deepEqual(calls, ['start', 'stop']);
  assert(!events.some((event) => /transcrib|voice_recognized|submitted:/.test(event)));
  assert(events.includes('ui:recording'));
  assert(events.includes('ui:stopped'));
}

async function testMicroNotReadyFailsWithoutDesktopCall() {
  let desktopCalls = 0;
  const session = new DeviceVoiceSession({
    voiceRecognizer: {
      getStatus() { return { mode: 'virtual_micro', active: false, connected: false }; },
      async start() { throw new Error('Codex Micro is not ready.'); }
    },
    async sendToDevice() { return true; },
    onLog() {}
  });
  const result = await session.handle({ type: 'voice_start', requestId: 'micro-not-ready' });
  assert.equal(result.success, false);
  assert.match(result.error, /not ready/);
  assert.equal(desktopCalls, 0);
}

async function testMicroModeChangeAndCompatibilityCancel() {
  const calls = [];
  let active = false;
  let mode = 'virtual_micro';
  const recognizer = {
    getStatus() { return { mode, active, connected: true, microConnected: true }; },
    async start() { active = true; calls.push(`start:${mode}`); return { delivery: 'submitted_to_hid', outcome: 'unknown' }; },
    async stop() { active = false; calls.push('stop'); return { delivery: 'submitted_to_hid', outcome: 'unknown' }; },
    async cancel() { active = false; calls.push('cancel'); return { delivery: 'submitted_to_hid', outcome: 'unknown' }; }
  };
  const session = new DeviceVoiceSession({ voiceRecognizer: recognizer, async sendToDevice() { return true; }, onLog() {} });
  await session.handle({ type: 'voice_start', requestId: 'mode-1' });
  assert.equal((await session.handle({ type: 'voice_start', requestId: 'mode-1' })).idempotent, true);
  assert.equal((await session.handle({ type: 'voice_start', requestId: 'other-request' })).success, false);
  mode = 'api';
  await session.handle({ type: 'voice_end', requestId: 'mode-1' });
  mode = 'virtual_micro';
  await session.handle({ type: 'voice_start', requestId: 'mode-2' });
  const cancel = await session.cancelVirtualMicro('mode change');
  assert.equal(cancel.success, true);
  assert.deepEqual(calls, ['start:virtual_micro', 'stop', 'start:virtual_micro', 'cancel']);
}

async function testApiSessionCollectsAudioAndSubmitsText() {
  const states = [];
  const deviceMessages = [];
  const chunks = [];
  let active = false;
  const session = new DeviceVoiceSession({
    ...microSubmissionOptions(),
    voiceRecognizer: {
      getStatus() { return { mode: 'api', active, provider: 'api', configured: true, acceptsAudio: true }; },
      getConfig() {
        return {
          mode: 'api',
          api: { apiKey: 'test-secret', baseUrl: 'https://example.test/v1', model: 'test-model' }
        };
      },
      async start() { active = true; return this.getStatus(); },
      async appendAudio(chunk) { chunks.push(Buffer.from(chunk)); return this.getStatus(); },
      async stop() { active = false; return { mode: 'api', text: 'recognized text' }; }
    },
    async submitText(text) { return { success: text === 'recognized text' }; },
    async sendToDevice(message) {
      deviceMessages.push(message);
      if (message.type === 'voice_status') states.push(message.state);
      return true;
    },
    onLog() {}
  });

  await session.handle({ type: 'voice_start', requestId: 'api-1' });
  await session.handleAudio({ type: 'voice_data', requestId: 'api-1', chunk: Buffer.from([1, 2, 3]) });
  const result = await session.handle({ type: 'voice_end', requestId: 'api-1' });
  assert.equal(result.success, true);
  assert.equal(chunks.length, 1);
  assert.deepEqual([...chunks[0]], [1, 2, 3]);
  assert.deepEqual(states, ['preparing', 'recording', 'recognizing', 'submitting', 'submitted']);
  assert(deviceMessages.some((message) => message.type === 'voice_recognized' && message.text === 'recognized text'));
  assert(deviceMessages.some((message) => message.type === 'input_result'));
}

async function testApiAppendFailureCancelsWithoutTranscription() {
  let requestCalls = 0;
  const recognizer = new VoiceRecognizer({
    providerOptions: {
      api: {
        async request() {
          requestCalls += 1;
          return { text: 'unexpected transcription' };
        }
      }
    }
  });
  await recognizer.saveConfig({
    mode: 'api',
    api: {
      apiKey: 'test-secret',
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      language: 'zh',
      inputFormat: 'pcm16',
      sampleRate: 16000,
      channels: 1,
      opusFrameSamples: 2880
    }
  });

  const statuses = [];
  const session = new DeviceVoiceSession({
    voiceRecognizer: recognizer,
    async sendToDevice(message) {
      if (message.type === 'voice_status') statuses.push(message.state);
      return true;
    },
    onLog() {}
  });

  const started = await session.handle({ type: 'voice_start', requestId: 'api-cancel-1' });
  assert.equal(started.success, true);
  await session.handleAudio({ type: 'voice_data', chunk: Buffer.from([1, 2, 3]) });
  const failed = await session.handleAudio({ type: 'voice_data', chunk: { malformed: true }, requestId: 'api-cancel-1' });
  assert.equal(failed.success, false);
  assert.equal(requestCalls, 0);
  assert.equal(recognizer.getStatus().active, false);
  assert.equal(recognizer.provider.chunks.length, 0);
  assert.equal(recognizer.provider.totalBytes, 0);
  assert.deepEqual(statuses, ['preparing', 'recording', 'error']);
}

async function testVirtualMicroNeverUsesDesktopOrAudioAndStopsManual() {
  const statuses = [];
  const calls = [];
  let active = false;
  const session = new DeviceVoiceSession({
    ...microSubmissionOptions(),
    voiceRecognizer: {
      getStatus() { return { mode: 'virtual_micro', active, connected: true, microConnected: true }; },
      async start() { active = true; calls.push('start'); return { delivery: 'submitted_to_hid', outcome: 'pressed' }; },
      async stop() { active = false; calls.push('stop'); return { delivery: 'submitted_to_hid', outcome: 'unknown' }; },
      async appendAudio() { throw new Error('virtual mode must ignore audio'); },
      async cancel() { active = false; calls.push('cancel'); }
    },
    async submitText() { throw new Error('virtual mode must not submit text'); },
    async sendToDevice(message) { if (message.type === 'voice_status') statuses.push(message); },
    onResult() { throw new Error('virtual mode must not produce result'); },
    onSubmitted() { throw new Error('virtual mode must not submit'); },
    onLog() {}
  });
  assert.equal((await session.handle({ type: 'voice_start', requestId: 'virtual-1' })).success, true);
  assert.equal((await session.handleAudio({ type: 'voice_data', chunk: Buffer.from([1]) })).ignored, true);
  const ended = await session.handle({ type: 'voice_end', requestId: 'virtual-1' });
  assert.equal(ended.success, true);
  assert.deepEqual(calls, ['start', 'stop']);
  assert.deepEqual(statuses.map((item) => item.state), ['preparing', 'recording', 'submitting', 'stopped']);
  assert.equal(statuses.at(-1).delivery, 'submitted_to_hid');
  assert.equal(statuses.at(-1).submission, 'send');
}

async function testEsp32VirtualMicroForwardsAudioAndDrainsBeforeRelease() {
  const calls = [];
  const recordings = [];
  let active = false;
  const session = new DeviceVoiceSession({
    ...microSubmissionOptions(),
    voiceRecognizer: {
      getStatus() { return { mode: 'virtual_micro', active, acceptsAudio: true, audioSource: 'esp32' }; },
      async start() { active = true; calls.push('ptt:down'); return { delivery: 'submitted_to_hid', acceptsAudio: true, audioSource: 'esp32' }; },
      async appendAudio(chunk) { calls.push(`audio:${Buffer.from(chunk).toString('hex')}`); },
      async stop() { calls.push('drain'); active = false; calls.push('ptt:up'); return { delivery: 'submitted_to_hid' }; },
      async cancel() { active = false; calls.push('cancel'); return { delivery: 'submitted_to_hid' }; }
    },
    async sendToDevice(message) { if (message.type === 'voice_status') recordings.push(message); },
    onLog() {}
  });
  await session.handle({ type: 'voice_start', requestId: 'esp32-1' });
  await session.handleAudio({ type: 'voice_data', requestId: 'esp32-1', chunk: Buffer.from([0xaa, 0xbb]) });
  await session.handle({ type: 'voice_end', requestId: 'esp32-1' });
  assert.deepEqual(calls, ['ptt:down', 'audio:aabb', 'drain', 'ptt:up']);
  assert.equal(recordings.find(item => item.state === 'recording').audioSource, 'esp32');
  assert.equal(recordings.find(item => item.state === 'recording').acceptsAudio, true);
}

async function testVirtualMicroRequestOwnershipPreventsCompetingPtt() {
  const calls = [];
  const statuses = [];
  let active = false;
  const session = new DeviceVoiceSession({
    ...microSubmissionOptions(),
    voiceRecognizer: {
      getStatus() { return { mode: 'virtual_micro', active }; },
      async start() { active = true; calls.push('start'); return { delivery: 'submitted_to_hid', outcome: 'pressed' }; },
      async stop() { active = false; calls.push('stop'); return { delivery: 'submitted_to_hid' }; },
      async cancel() { active = false; calls.push('cancel'); }
    },
    async sendToDevice(message) { if (message.type === 'voice_status') statuses.push(message); },
    onLog() {}
  });
  assert.equal((await session.handle({ type: 'voice_start', requestId: 'ui-1' })).success, true);
  assert.equal((await session.handle({ type: 'voice_start', requestId: 'ui-1' })).idempotent, true);
  const competing = await session.handle({ type: 'voice_start', requestId: 'esp-2' });
  assert.equal(competing.success, false);
  assert.equal(active, true);
  const wrongEnd = await session.handle({ type: 'voice_end', requestId: 'esp-2' });
  assert.equal(wrongEnd.success, false);
  assert.equal(active, true);
  assert.deepEqual(calls, ['start']);
  assert.equal((await session.handle({ type: 'voice_end', requestId: 'ui-1' })).success, true);
  assert.deepEqual(calls, ['start', 'stop']);
  assert.equal(statuses.filter((item) => item.state === 'recording').length, 1);
}

async function testMicroFaultPublishesAsyncError(mode = 'virtual_micro') {
  const events = new EventEmitter();
  const statuses = [];
  let active = false;
  const recognizer = {
    on(...args) { events.on(...args); },
    getStatus() { return { mode, active, releaseUncertain: !active }; },
    async start() { active = true; return { delivery: 'submitted_to_hid', outcome: 'pressed' }; },
    async cancel() { active = false; }
  };
  const session = new DeviceVoiceSession({
    voiceRecognizer: recognizer,
    async sendToDevice(message) { if (message.type === 'voice_status') statuses.push(message); },
    onLog() {}
  });
  await session.handle({ type: 'voice_start', requestId: `fault-${mode}` });
  active = false;
  events.emit('fault', { message: 'broker disconnected' });
  await session.operation;
  assert.deepEqual(statuses.map((item) => item.state), ['preparing', 'recording', 'error']);
  assert.match(statuses.at(-1).message, /broker disconnected/);
}

async function testMicroUsesConfiguredFollowUpAndCancelsWithoutSubmit() {
  const statuses = [];
  const calls = [];
  let active = false;
  const session = new DeviceVoiceSession({
    ...microSubmissionOptions({
      executionState: 'running', kind: 'local', taskId: 'task-1',
      followUpQueueMode: 'queue', composerEnterBehavior: 'cmdAlways'
    }),
    voiceRecognizer: {
      getStatus() { return { mode: 'virtual_micro', active, connected: true, microConnected: true }; },
      async start() { active = true; calls.push('ptt:down'); return { delivery: 'submitted_to_hid' }; },
      async stop(options) {
        calls.push('drain');
        calls.push('submit:' + options.submissionKey);
        active = false;
        calls.push('ptt:up');
        return { delivery: 'submitted_to_hid', submission: { delivery: 'submitted_to_desktop' } };
      },
      async cancel() { active = false; calls.push('cancel'); return { delivery: 'submitted_to_hid' }; }
    },
    async sendToDevice(message) { if (message.type === 'voice_status') statuses.push(message); },
    onLog() {}
  });
  await session.handle({ type: 'voice_start', requestId: 'running-1' });
  const ended = await session.handle({ type: 'voice_end', requestId: 'running-1' });
  assert.equal(ended.submission, 'queue');
  assert.equal(ended.submissionRequested, true);
  assert.deepEqual(calls, ['ptt:down', 'drain', 'submit:ACT06', 'ptt:up']);
  assert.equal(statuses.at(-1).submission, 'queue');
  assert.equal(statuses.at(-1).submissionRequested, true);
  assert.equal(statuses.at(-1).submissionConfirmed, false);

  const duplicate = await session.handle({ type: 'voice_end', requestId: 'running-1' });
  assert.equal(duplicate.success, false);
  assert.equal(calls.filter(call => call.startsWith('submit:')).length, 1,
    'a repeated voice_end must not submit the preceding dictation again');

  await session.handle({ type: 'voice_start', requestId: 'cancel-1' });
  const cancelled = await session.handle({ type: 'voice_end', requestId: 'cancel-1', cancelled: true });
  assert.equal(cancelled.cancelled, true);
  assert.equal(calls.filter(call => call.startsWith('submit:')).length, 1);
  assert.equal(calls.at(-1), 'cancel');
}

async function testMicroSkipsSubmitWhenEsp32DeliveredNoAudio() {
  const statuses = [];
  const calls = [];
  let active = false;
  const session = new DeviceVoiceSession({
    ...microSubmissionOptions(),
    voiceRecognizer: {
      getStatus() { return { mode: 'virtual_micro', active, acceptsAudio: true, audioSource: 'esp32' }; },
      async start() { active = true; return { delivery: 'submitted_to_hid', acceptsAudio: true, audioSource: 'esp32' }; },
      async stop(options) { active = false; calls.push(options || null); return { delivery: 'submitted_to_hid' }; },
      async cancel() { active = false; }
    },
    async sendToDevice(message) { if (message.type === 'voice_status') statuses.push(message); },
    onLog() {}
  });
  await session.handle({ type: 'voice_start', requestId: 'empty-audio-1' });
  const ended = await session.handle({ type: 'voice_end', requestId: 'empty-audio-1' });
  assert.equal(ended.success, false);
  assert.deepEqual(calls, [null], 'no device frames only releases PTT and never sends an old draft');
  assert.deepEqual(statuses.map(status => status.state), ['preparing', 'recording', 'stopped']);
  assert.equal(statuses.at(-1).submission, 'none');
}

async function testMicroCancelsSubmissionWhenTargetChanges() {
  const statuses = [];
  const calls = [];
  let active = false;
  let context = {
    kind: 'local', taskId: 'task-before', executionState: 'idle', generation: 7, draftToken: null
  };
  const session = new DeviceVoiceSession({
    async getSubmissionContext() { return context; },
    async getMicroLayout() {
      return { layout: { slots: { ACT06: { action: { type: 'command', commandId: 'composer.submit' } } } } };
    },
    voiceRecognizer: {
      getStatus() { return { mode: 'virtual_micro', active }; },
      async start() { active = true; return { delivery: 'submitted_to_hid' }; },
      async stop(options) { active = false; calls.push(options || null); return { delivery: 'submitted_to_hid' }; },
      async cancel() { active = false; }
    },
    async sendToDevice(message) { if (message.type === 'voice_status') statuses.push(message); },
    onLog() {}
  });
  await session.handle({ type: 'voice_start', requestId: 'identity-1' });
  context = { ...context, taskId: 'task-after' };
  const ended = await session.handle({ type: 'voice_end', requestId: 'identity-1' });
  assert.equal(ended.success, false);
  assert.deepEqual(calls, [null], 'changed target must release PTT without a Micro submit key');
  assert.equal(statuses.at(-1).submission, 'none');
  assert.match(statuses.at(-1).message, /target changed/);
}

Promise.all([
  testMicroSessionNeverUsesDesktopOrSubmit(),
  testMicroNotReadyFailsWithoutDesktopCall(),
  testMicroModeChangeAndCompatibilityCancel(),
  testApiSessionCollectsAudioAndSubmitsText(),
  testApiAppendFailureCancelsWithoutTranscription(),
  testVirtualMicroNeverUsesDesktopOrAudioAndStopsManual(),
  testEsp32VirtualMicroForwardsAudioAndDrainsBeforeRelease(),
  testVirtualMicroRequestOwnershipPreventsCompetingPtt(),
  testMicroFaultPublishesAsyncError(),
  testMicroUsesConfiguredFollowUpAndCancelsWithoutSubmit(),
  testMicroSkipsSubmitWhenEsp32DeliveredNoAudio(),
  testMicroCancelsSubmissionWhenTargetChanges()
]).then(() => console.log('device voice session tests passed')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
