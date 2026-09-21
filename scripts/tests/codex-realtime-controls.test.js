const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const findControls = require('../../src/platform/codex-realtime-controls');

function button(label, options = {}) {
  return {
    disabled: options.disabled === true,
    getAttribute: key => key === 'aria-label' ? label : key === 'aria-disabled' ? String(options.ariaDisabled === true) : null,
    getClientRects: () => options.hidden ? [] : [{}]
  };
}
const documentWith = (...buttons) => ({ querySelectorAll: selector => {
  assert.equal(selector, 'button[aria-label]');
  return buttons;
} });

test('Chinese call controls work after renderer serialization', () => {
  const serialized = runInNewContext(`(${findControls.toString()})`);
  for (const [operation, label] of [
    ['Start voice chat', '开始语音聊天'], ['Mute microphone', '将麦克风静音'],
    ['Unmute microphone', '取消麦克风静音'], ['Stop voice chat', '结束语音聊天'],
    ['Cancel voice chat', '取消语音聊天'], ['Start voice chat', '開始語音對話'],
    ['Unmute microphone', '將麥克風取消靜音']
  ]) {
    const expected = button(label);
    const result = serialized(documentWith(button('开始听写'), expected, button('静音扬声器')), operation);
    assert.equal(result.length, 1);
    assert.equal(result[0], expected);
  }
});

test('English controls remain supported and hidden or disabled matches are ignored', () => {
  const enabled = button('Start voice chat');
  assert.deepEqual(findControls(documentWith(button('开始语音聊天', { hidden: true }),
    button('开启语音聊天', { disabled: true }), button('Start voice chat', { ariaDisabled: true }), enabled),
  'Start voice chat'), [enabled]);
});

test('multiple visible call controls remain ambiguous', () => {
  const first = button('Start voice chat'), second = button('开始语音聊天');
  assert.deepEqual(findControls(documentWith(first, second), 'Start voice chat'), [first, second]);
  assert.deepEqual(findControls(documentWith(button('开始听写')), 'Start voice chat'), []);
});
