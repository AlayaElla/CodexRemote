'use strict';

// Only enable the Owl renderer path when the installed bundle still contains
// the dictation capture and native send semantics this adapter relies on.
function buildCodexDictationRendererProfile({ initialName, initialText }) {
  const unsupported = () => new Error('当前 Codex 听写接口结构已变化，无法安全路由 ESP32 音频。');
  if (!/^app-initial-[\w-]+\.js$/.test(initialName) || typeof initialText !== 'string') throw unsupported();
  const hasPreferredInput = /microphoneInputDeviceId/.test(initialText)
    && /deviceId:\{exact:[\w$]+\}/.test(initialText)
    && /getUserMedia\(/.test(initialText);
  const hasNativeSend = /onTranscriptSend/.test(initialText) && /\(`send`\)/.test(initialText)
    && /stopDictation/.test(initialText);
  const hasVisibleOwner = /isVisible/.test(initialText);
  const hasRecordingState = /isDictating/.test(initialText) && /stopDictation/.test(initialText);
  if (!hasPreferredInput || !hasNativeSend || !hasRecordingState || !hasVisibleOwner) throw unsupported();
  return { initialName, devicePreference: 'microphoneInputDeviceId', ownerVisibility: 'isVisible', sendAction: 'send', cancelAction: 'abort' };
}

module.exports = buildCodexDictationRendererProfile;
