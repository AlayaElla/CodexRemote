const CodexHookCollector = require('./codex-hook-collector');
const { ensureCodexHooks } = require('./codex-hook-installer');

function createCollector(type, options = {}) {
  switch (type) {
    case 'codex-hooks':
      return new CodexHookCollector(options);
    default:
      throw new Error(`Unsupported agent event collector: ${type}`);
  }
}

module.exports = {
  createCollector,
  CodexHookCollector,
  ensureCodexHooks
};
