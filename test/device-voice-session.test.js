const assert = require('assert');
const DeviceVoiceSession = require('../src/voice/device-voice-session');
const VoiceRecognizer = require('../src/voice/voice-recognizer');

async function testNativeShortcutSession() {
  const events = [];
  const shortcuts = [];
  const session = new DeviceVoiceSession({
    voiceShortcut: 'control+shift+r',
    desktopController: {
      async focusInput() { events.push('focused'); return { success: true, hasText: false, nonWhitespaceLength: 0 }; },
      async sendShortcut(shortcut) {
        shortcuts.push(shortcut);
        events.push('shortcut:' + shortcut);
        return { success: true };
      },
      async waitForInput(options) { events.push('wait:' + options.stableMs); return { success: true, hasText: true }; },
      async submitInput() { events.push('submit-input'); return { success: true, action: 'submit-input' }; }
    },
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
  assert.deepEqual(shortcuts, ['Ctrl+Shift+R', 'Ctrl+Shift+R']);
  assert.equal(events.filter((event) => event.startsWith('shortcut:')).length, 2);
  assert(!events.some((event) => /transcrib|voice_recognized|submitted:/.test(event)));
  assert(events.includes('ui:recording'));
  assert(events.includes('ui:recognizing'));
  assert(events.includes('ui:submitting'));
  assert(events.includes('ui:submitted'));
}

async function testFocusFailureReturnsDeviceError() {
  const statuses = [];
  let shortcutCalls = 0;
  const session = new DeviceVoiceSession({
    desktopController: {
      async focusInput() { return { success: false, error: 'editor missing' }; },
      async sendShortcut() { shortcutCalls += 1; return { success: true }; }
    },
    async sendToDevice(message) {
      if (message.type === 'voice_status') statuses.push(message);
      return true;
    },
    onLog() {}
  });

  const result = await session.handle({ type: 'voice_start', requestId: 'voice-2' });
  assert.equal(result.success, false);
  assert.equal(shortcutCalls, 0);
  assert.deepEqual(statuses.map((item) => item.state), ['preparing', 'error']);
  assert.equal(statuses.at(-1).requestId, 'voice-2');
  assert.match(statuses.at(-1).message, /editor missing/);
}

async function testShortcutFailureDoesNotReportSubmitted() {
  const states = [];
  const session = new DeviceVoiceSession({
    desktopController: {
      async focusInput() { return { success: true, hasText: false, nonWhitespaceLength: 0 }; },
      async sendShortcut() {
        return { success: states.length < 2, error: 'shortcut failed' };
      },
      async waitForInput() { return { success: true, hasText: true }; },
      async submitInput() { return { success: true }; }
    },
    async sendToDevice(message) {
      if (message.type === 'voice_status') states.push(message.state);
      return true;
    },
    onLog() {}
  });

  await session.handle({ type: 'voice_start' });
  const result = await session.handle({ type: 'voice_end' });
  assert.equal(result.success, false);
  assert.deepEqual(states, ['preparing', 'recording', 'error']);
}

async function testApiSessionCollectsAudioAndSubmitsText() {
  const states = [];
  const deviceMessages = [];
  const chunks = [];
  let active = false;
  const session = new DeviceVoiceSession({
    voiceRecognizer: {
      getStatus() { return { mode: 'api', active, provider: 'api', configured: true }; },
      getConfig() {
        return {
          mode: 'api',
          native: { shortcut: 'Ctrl+Shift+R' },
          api: { apiKey: 'test-secret', baseUrl: 'https://example.test/v1', model: 'test-model' }
        };
      },
      async start() { active = true; return this.getStatus(); },
      async appendAudio(chunk) { chunks.push(Buffer.from(chunk)); return this.getStatus(); },
      async stop() { active = false; return { mode: 'api', text: 'recognized text' }; }
    },
    desktopController: {
      async focusInput() { return { success: true, hasText: false, nonWhitespaceLength: 0 }; },
      async sendShortcut() { throw new Error('API mode must not send a shortcut'); }
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
    native: { shortcut: 'Ctrl+Shift+R' },
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
    desktopController: {
      async focusInput() { return { success: true }; },
      async sendShortcut() { throw new Error('API mode must not send a shortcut'); }
    },
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

async function testNativeFailureCancelsRecognizer() {
  const recognizer = new VoiceRecognizer();
  await recognizer.saveConfig({
    mode: 'native',
    native: { shortcut: 'Ctrl+Shift+R' },
    api: recognizer.getConfig().api
  });
  let shortcutCalls = 0;
  const session = new DeviceVoiceSession({
    voiceRecognizer: recognizer,
    desktopController: {
      async focusInput() { return { success: true, hasText: false, nonWhitespaceLength: 0 }; },
      async sendShortcut() {
        shortcutCalls += 1;
        return shortcutCalls === 1 ? { success: true } : { success: false, error: 'shortcut failed' };
      },
      async waitForInput() { return { success: true, hasText: true }; },
      async submitInput() { return { success: true }; }
    },
    async sendToDevice() { return true; },
    onLog() {}
  });

  assert.equal((await session.handle({ type: 'voice_start' })).success, true);
  const failed = await session.handle({ type: 'voice_end' });
  assert.equal(failed.success, false);
  assert.equal(recognizer.getStatus().active, false);
}

function createNativeWaitHarness(options = {}) {
  const statuses = [];
  const calls = [];
  let shortcutCalls = 0;
  let submitCalls = 0;
  const session = new DeviceVoiceSession({
    desktopController: {
      async focusInput() {
        calls.push('focus');
        return options.initialState || { success: true, hasText: false, nonWhitespaceLength: 0 };
      },
      async sendShortcut() {
        shortcutCalls += 1;
        calls.push('shortcut');
        return options.shortcutResult || { success: true };
      },
      async waitForInput(waitOptions) {
        calls.push({ type: 'wait', options: waitOptions });
        if (options.waitForInput) return options.waitForInput(waitOptions);
        return { success: true, hasText: true, trimmedLength: 2, nonWhitespaceLength: 2 };
      },
      async submitInput() {
        submitCalls += 1;
        calls.push('submit-input');
        return options.submitResult || { success: true };
      }
    },
    nativeInputTimeoutMs: 80,
    nativeInputPollMs: 10,
    nativeInputStableMs: 20,
    async sendToDevice(message) {
      if (message.type === 'voice_status') statuses.push(message.state);
      return true;
    },
    onLog() {}
  });
  return {
    session,
    statuses,
    calls,
    get shortcutCalls() { return shortcutCalls; },
    get submitCalls() { return submitCalls; }
  };
}

async function testNativeWaitsThroughDelayedTextAndSubmitsOnce() {
  const sequence = [
    { success: true, hasText: false, trimmedLength: 0, nonWhitespaceLength: 0 },
    { success: true, hasText: false, trimmedLength: 0, nonWhitespaceLength: 0 },
    { success: true, hasText: true, trimmedLength: 2, nonWhitespaceLength: 2 },
    { success: true, hasText: true, trimmedLength: 2, nonWhitespaceLength: 2 }
  ];
  const harness = createNativeWaitHarness({
    waitForInput: async (options) => {
      assert.equal(options.timeoutMs, 80);
      assert.equal(options.pollMs, 10);
      assert.equal(options.stableMs, 20);
      assert.equal(sequence[0].hasText, false);
      assert.equal(sequence.at(-1).hasText, true);
      return sequence.at(-1);
    }
  });

  const result = await harness.session.handle({ type: 'voice_start', requestId: 'native-delay' });
  assert.equal(result.success, true);
  const ended = await harness.session.handle({ type: 'voice_end', requestId: 'native-delay' });
  assert.equal(ended.success, true);
  assert.equal(harness.submitCalls, 1);
  assert.equal(harness.calls.filter((item) => item === 'focus').length, 1);
  assert.equal(harness.calls.some((item) => item === 'input-state'), false);
  assert.deepEqual(harness.statuses, ['preparing', 'recording', 'recognizing', 'submitting', 'submitted']);
  assert.equal(harness.calls.filter((item) => item === 'submit-input').length, 1);
}

async function testNativeWhitespaceOrTimeoutDoesNotSubmit() {
  const harness = createNativeWaitHarness({
    waitForInput: async () => ({
      success: false,
      error: 'ChatGPT editor text did not become stable before timeout.'
    })
  });
  assert.equal((await harness.session.handle({ type: 'voice_start' })).success, true);
  const result = await harness.session.handle({ type: 'voice_end' });
  assert.equal(result.success, false);
  assert.equal(harness.submitCalls, 0);
  assert.deepEqual(harness.statuses, ['preparing', 'recording', 'recognizing', 'error']);
}

async function testNativeExistingDraftFailsBeforeShortcut() {
  const harness = createNativeWaitHarness({
    initialState: { success: true, hasText: true, trimmedLength: 5, nonWhitespaceLength: 5 }
  });
  const result = await harness.session.handle({ type: 'voice_start' });
  assert.equal(result.success, false);
  assert.equal(harness.shortcutCalls, 0);
  assert.equal(harness.calls.some((item) => item && item.type === 'wait'), false);
  assert.deepEqual(harness.statuses, ['preparing', 'error']);
  assert.match(result.error, /already contains a draft/);
}

async function testNativeInputReadFailureDoesNotStart() {
  const harness = createNativeWaitHarness({
    initialState: { success: false, error: 'editor text state could not be read' }
  });
  const result = await harness.session.handle({ type: 'voice_start' });
  assert.equal(result.success, false);
  assert.equal(harness.shortcutCalls, 0);
  assert.deepEqual(harness.statuses, ['preparing', 'error']);
  assert.match(result.error, /could not be read/);
}

async function testNativeLengthChangeWaitResultIsAcceptedOnlyAfterStablePolls() {
  let stablePolls = 0;
  const harness = createNativeWaitHarness({
    waitForInput: async () => {
      const values = [
        { length: 1, signature: 'A' },
        { length: 1, signature: 'B' },
        { length: 1, signature: 'B' }
      ];
      let previous = null;
      for (const value of values) {
        if (value.signature === previous) stablePolls += 1;
        else stablePolls = 0;
        previous = value.signature;
      }
      return stablePolls >= 1
        ? { success: true, hasText: true, trimmedLength: 3, nonWhitespaceLength: 3 }
        : { success: false, error: 'unstable' };
    }
  });
  assert.equal((await harness.session.handle({ type: 'voice_start' })).success, true);
  assert.equal((await harness.session.handle({ type: 'voice_end' })).success, true);
  assert.equal(stablePolls, 1);
  assert.equal(harness.submitCalls, 1);
}

Promise.all([
  testNativeShortcutSession(),
  testFocusFailureReturnsDeviceError(),
  testShortcutFailureDoesNotReportSubmitted(),
  testApiSessionCollectsAudioAndSubmitsText(),
  testApiAppendFailureCancelsWithoutTranscription(),
  testNativeFailureCancelsRecognizer(),
  testNativeWaitsThroughDelayedTextAndSubmitsOnce(),
  testNativeWhitespaceOrTimeoutDoesNotSubmit(),
  testNativeExistingDraftFailsBeforeShortcut(),
  testNativeInputReadFailureDoesNotStart(),
  testNativeLengthChangeWaitResultIsAcceptedOnlyAfterStablePolls()
]).then(() => console.log('device voice session tests passed')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
