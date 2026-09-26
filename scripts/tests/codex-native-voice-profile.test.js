const test = require('node:test');
const assert = require('node:assert/strict');
const buildNativeVoiceProfile = require('../../src/platform/codex-native-voice-profile');

const initialName = 'app-initial-a1b2c3.js';
const initialText = 'var g9,v9,y9;cancelStart(e){e.set(g9,`stopping`)}'
  + 'applyRealtimeMicrophoneMuteState(e,t){this.runtime?.setInputMuted(t),e.set(v9,t)}'
  + 'setRealtimeVoiceActivity(e,t){e.set(y9,t)}'
  + 'export{g9 as vr,v9 as gr,y9 as br};';

test('resolves current native voice semantics without fixed asset or export names', () => {
  assert.deepEqual(buildNativeVoiceProfile({ initialName, initialText }), {
    initialName, phase: 'vr', microphoneMuted: 'gr', activity: 'br'
  });
});

test('ignores unrelated implementation changes but requires the voice signals', () => {
  assert.deepEqual(buildNativeVoiceProfile({ initialName, initialText: initialText.replace('setInputMuted', 'setOutputMuted') }).microphoneMuted, 'gr');
  assert.throws(() => buildNativeVoiceProfile({ initialName, initialText: initialText.replace('applyRealtimeMicrophoneMuteState', 'otherMute') }), /接口结构已变化/);
  assert.throws(() => buildNativeVoiceProfile({ initialName, initialText: initialText.replace('v9 as gr,', '') }), /接口结构已变化/);
  assert.throws(() => buildNativeVoiceProfile({ initialName: '../app-initial-a1b2c3.js', initialText }), /接口结构已变化/);
});
