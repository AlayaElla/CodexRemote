const fsNative = require('node:fs');
const path = require('node:path');
const CodexKeyboardWorker = require('./codex-keyboard-worker');

function readCurrentKeymap(options) {
  let text;
  try { text = options.fs.readFileSync(path.join(options.codexHome, 'keybindings.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw new Error('Codex 快捷键配置不可读。'); }
  if (!text.trim()) return [];
  let bindings;
  try { bindings = JSON.parse(text); } catch (_) { throw new Error('Codex 快捷键配置无效。'); }
  if (!Array.isArray(bindings) || bindings.some(item => !item || typeof item.command !== 'string'
    || !(typeof item.key === 'string' || item.key === null))) throw new Error('Codex 快捷键配置无效。');
  return bindings;
}

function unpackedScriptPath(scriptPath) {
  return scriptPath.replace(/([\\/])app\.asar([\\/])/i, '$1app.asar.unpacked$2');
}

class CodexShortcuts {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.fs = options.fs || fsNative;
    this.codexHome = options.codexHome || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');
    this.scriptPath = options.scriptPath || path.join(__dirname, 'codex-shortcuts.ps1');
    this.worker = new CodexKeyboardWorker(unpackedScriptPath(this.scriptPath), { spawn: options.spawn, timeoutMs: options.timeoutMs });
  }

  warmKeyboard() { return this.platform === 'win32' ? this.worker.warmup() : Promise.resolve(); }
  dispose() { this.worker.dispose(); }

  requireBinding(command, key, defaultKey = null) {
    const bindings = readCurrentKeymap(this);
    const matching = bindings.filter(item => item.command === command);
    if ((matching.length === 0 ? defaultKey !== key : matching.length !== 1 || matching[0].key !== key)
      || bindings.some(item => item.key === key && item.command !== command)) {
      throw new Error(`请在 Codex 快捷键设置中将 ${command} 绑定为 ${key}。`);
    }
  }

  async _run(action, context = {}) {
    if (this.platform !== 'win32') throw new Error('快捷键操作仅支持 Windows。');
    const result = await this.worker.run(action, context);
    if (result?.success !== true) throw new Error(result?.error || 'Codex 快捷键未投递。');
    return result;
  }

  async escape({ stop = false } = {}) {
    await this._run(stop ? 'EscapeStop' : 'EscapeCancel');
    return { success: true, delivery: 'submitted_to_keyboard', outcome: 'requested' };
  }

  async resolveMicroDraft(context) {
    if (!context?.candidates?.length) return null;
    this.requireBinding('copyDeeplink', 'Ctrl+Alt+L', 'Ctrl+Alt+L');
    const result = await this._run('ReadTaskLink', { candidates: context.candidates });
    if (result.pending) return null;
    if (!context.candidates.includes(result.threadId)) throw new Error('当前任务不是刚创建的新任务。');
    return { threadId: result.threadId };
  }

  validateTextTarget(context) {
    if (!context?.taskId && !context?.draftToken) throw new Error('请选择任务或新建任务。');
    if (context.taskId) {
      this.requireBinding('copyDeeplink', 'Ctrl+Alt+L', 'Ctrl+Alt+L');
      this.requireBinding('focusMainChat', 'Ctrl+Shift+L');
    }
  }

  async pasteText(text, context) {
    if (typeof text !== 'string' || !text.trim() || text.length > 32768) throw new Error('文字为空或超过发送上限。');
    this.validateTextTarget(context);
    await this._run('PasteText', { text, taskId: context.taskId, draftToken: context.draftToken });
    return { success: true, delivery: 'submitted_to_keyboard', outcome: 'requested' };
  }
}

module.exports = CodexShortcuts;
module.exports.readCurrentKeymap = readCurrentKeymap;
module.exports.unpackedScriptPath = unpackedScriptPath;
