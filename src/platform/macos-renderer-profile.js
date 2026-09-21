// Resolve minified exports from the installed bundle, not from a fixed hash.
// A changed source shape is rejected before any control is attempted.
function buildMacRendererProfile({ signalsName, signalsText, bridgeText, initialText }) {
  function imports(text) {
    const result = {};
    for (const match of text.matchAll(/import\{([^}]+)\}from["']\.\/([^"']+)["']/g)) {
      for (const item of match[1].split(',')) {
        const [exportName, localName = exportName] = item.trim().split(/\s+as\s+/);
        result[localName] = { file: match[2], name: exportName };
      }
    }
    return result;
  }
  const signalImports = imports(signalsText), bridgeImports = imports(bridgeText);
  const exportsText = signalsText.match(/export\{([^}]+)\}/)?.[1];
  const slotLocal = exportsText?.split(',').map(entry => entry.trim().split(/\s+as\s+/)).find(entry => entry[1] === 'n')?.[0];
  if (!slotLocal || !/^[\w$]+$/.test(slotLocal)) throw new Error('Unsupported macOS Micro slot exports.');
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scopeLocal = signalsText.match(new RegExp(escape(slotLocal) + '=[$\\w]+\\(([$\\w]+),'))?.[1];
  const source = signalsText.match(/([$\w]+)\(\w+,([$\w]+)\.agentSource\)/);
  const hostLocal = signalsText.match(/hostId:\w+\.get\(([$\w]+),/)?.[1];
  const selectionLocal = signalsText.match(/selectedThreadKey:\w+\(([$\w]+)\)/)?.[1];
  const dispatcherLocal = bridgeText.match(/([$\w]+)\.dispatchHostMessage\(\{type:/)?.[1];
  const commandStart = bridgeText.indexOf('===`manageTasks`');
  const commandLocal = commandStart >= 0
    ? bridgeText.slice(commandStart, commandStart + 700).match(/\?!1:([$\w]+)\(\w+,\w+\)\}/)?.[1] : null;
  const bindingPosition = initialText.indexOf('`client-thread-bindings-v1`');
  const bindingPrefix = initialText.slice(Math.max(0, bindingPosition - 900), bindingPosition);
  const readerLocal = bindingPrefix.match(/let \w+=([$\w]+)\([$\w]+,\{\}\);if/)?.[1];
  const initialExports = initialText.slice(initialText.lastIndexOf('export{'));
  const readerExport = readerLocal && initialExports.match(new RegExp('(?:\\{|,)' + escape(readerLocal) + ' as ([$\\w]+)(?:,|\\})'))?.[1];
  const initialFile = Object.values(signalImports).find(value => value.file.startsWith('app-initial-'))?.file;
  const profile = {
    signalsName,
    scope: signalImports[scopeLocal], sourceGetter: signalImports[source?.[1]],
    config: signalImports[source?.[2]], host: signalImports[hostLocal],
    selection: signalImports[selectionLocal], dispatcher: bridgeImports[dispatcherLocal],
    command: bridgeImports[commandLocal],
    bindings: readerExport && { file: initialFile, name: readerExport }
  };
  for (const [key, value] of Object.entries(profile)) {
    if (key === 'signalsName') continue;
    if (!value || !/^app-(?:initial|shared|primary)-[\w-]+\.js$/.test(value.file) || !/^[\w$]+$/.test(value.name)) {
      throw new Error(`Unsupported macOS Codex renderer binding: ${key}.`);
    }
  }
  return profile;
}

module.exports = { buildMacRendererProfile };
