const assert = require('assert');
const {
  DEFAULT_VOICE_SHORTCUT,
  parseShortcut,
  validateShortcut
} = require('../src/core/keyboard-shortcut');

assert.equal(DEFAULT_VOICE_SHORTCUT, 'Ctrl+Shift+R');
assert.deepEqual(parseShortcut(' control + shift + r '), {
  shortcut: 'Ctrl+Shift+R',
  modifiers: ['Ctrl', 'Shift'],
  key: 'R'
});
assert.equal(parseShortcut('Alt+F12').shortcut, 'Alt+F12');
assert.equal(parseShortcut('Win+ArrowLeft').shortcut, 'Win+Left');
assert.equal(parseShortcut('Ctrl+Space').shortcut, 'Ctrl+Space');
assert.equal(validateShortcut('Ctrl+Ctrl+R').success, false);
assert.equal(validateShortcut('Ctrl+?').success, false);
assert.equal(validateShortcut('R').success, false);
assert.equal(validateShortcut('Ctrl+Shift').success, false);

console.log('keyboard shortcut tests passed');
