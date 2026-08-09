const DEFAULT_VOICE_SHORTCUT = 'Ctrl+Shift+R';

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Win'];
const MODIFIER_ALIASES = new Map([
  ['ctrl', 'Ctrl'],
  ['control', 'Ctrl'],
  ['ctl', 'Ctrl'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['shift', 'Shift'],
  ['win', 'Win'],
  ['windows', 'Win'],
  ['meta', 'Win'],
  ['cmd', 'Win'],
  ['command', 'Win']
]);

const KEY_ALIASES = new Map([
  ['space', 'Space'],
  ['spacebar', 'Space'],
  ['enter', 'Enter'],
  ['return', 'Enter'],
  ['tab', 'Tab'],
  ['escape', 'Escape'],
  ['esc', 'Escape'],
  ['backspace', 'Backspace'],
  ['back', 'Backspace'],
  ['delete', 'Delete'],
  ['del', 'Delete'],
  ['insert', 'Insert'],
  ['ins', 'Insert'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pgup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['pgdn', 'PageDown'],
  ['left', 'Left'],
  ['arrowleft', 'Left'],
  ['right', 'Right'],
  ['arrowright', 'Right'],
  ['up', 'Up'],
  ['arrowup', 'Up'],
  ['down', 'Down'],
  ['arrowdown', 'Down'],
  ['printscreen', 'PrintScreen'],
  ['prtsc', 'PrintScreen'],
  ['pause', 'Pause'],
  ['capslock', 'CapsLock'],
  ['numlock', 'NumLock'],
  ['scrolllock', 'ScrollLock']
]);

function normalizeKeyToken(value) {
  const token = String(value || '').trim();
  if (!token) throw new Error('Voice shortcut must include a key.');

  const alias = KEY_ALIASES.get(token.toLowerCase());
  if (alias) return alias;

  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(token)) {
    return token.toUpperCase();
  }

  if (token.length === 1 && /^[A-Za-z0-9]$/.test(token)) {
    return token.toUpperCase();
  }

  throw new Error(`Unsupported voice shortcut key: ${token}`);
}

function parseShortcut(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('Voice shortcut is required.');
  }

  const parts = input.split('+').map((part) => part.trim());
  if (parts.some((part) => part === '')) {
    throw new Error('Voice shortcut contains an empty key.');
  }

  const modifiers = new Set();
  const keyParts = [];
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES.get(part.toLowerCase());
    if (modifier) {
      if (modifiers.has(modifier)) throw new Error(`Duplicate voice shortcut modifier: ${part}`);
      modifiers.add(modifier);
    } else {
      keyParts.push(part);
    }
  }

  if (modifiers.size === 0) throw new Error('Voice shortcut must include at least one modifier.');
  if (keyParts.length !== 1) throw new Error('Voice shortcut must include exactly one non-modifier key.');

  const key = normalizeKeyToken(keyParts[0]);
  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return {
    shortcut: [...orderedModifiers, key].join('+'),
    modifiers: orderedModifiers,
    key
  };
}

function validateShortcut(input, fallback = DEFAULT_VOICE_SHORTCUT) {
  try {
    return { success: true, ...parseShortcut(input) };
  } catch (error) {
    return { success: false, error: error.message, fallback };
  }
}

module.exports = {
  DEFAULT_VOICE_SHORTCUT,
  MODIFIER_ORDER,
  parseShortcut,
  validateShortcut
};
