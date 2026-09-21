// Serialized alongside the reader; resolve imports by their use in the installed
// bundle so a release changing minified export names cannot silently empty slots.
function buildMicroReadProfile({ signalsName, signalsText, bridgeText, initialText }) {
  const imports = text => Object.fromEntries([...text.matchAll(/import\{([^}]+)\}from["']\.\/([^"']+)["']/g)]
    .flatMap(match => match[1].split(',').map(item => {
      const [name, local = name] = item.trim().split(/\s+as\s+/);
      return [local, { file: match[2], name }];
    })));
  const signalImports = imports(signalsText), bridgeImports = imports(bridgeText);
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const slot = signalsText.match(/export\{([^}]+)\}/)?.[1].split(',')
    .map(entry => entry.trim().split(/\s+as\s+/)).find(entry => entry[1] === 'n')?.[0];
  if (!slot) throw new Error('Codex Micro slot export is unavailable');
  const scope = signalsText.match(new RegExp(escape(slot) + '=[$\\w]+\\(([$\\w]+),'))?.[1];
  const source = signalsText.match(/([$\w]+)\(\w+,([$\w]+)\.agentSource\)/);
  const host = signalsText.match(/hostId:\w+\.get\(([$\w]+),/)?.[1];
  const owner = bridgeText.match(/let\{isOwner:([$\w]+)\}=[$\w]+;[^}]*?\.set\(([$\w]+),\1\)/)?.[2];
  const position = initialText.indexOf('`client-thread-bindings-v1`');
  const reader = initialText.slice(Math.max(0, position - 900), position)
    .match(/let \w+=([$\w]+)\([$\w]+,\{\}\);if/)?.[1];
  const readerExport = reader && initialText.slice(initialText.lastIndexOf('export{'))
    .match(new RegExp('(?:\\{|,)' + escape(reader) + ' as ([$\\w]+)(?:,|\\})'))?.[1];
  const initialFile = Object.values(signalImports).find(value => value.file.startsWith('app-initial-'))?.file;
  const profile = { signalsName, scope: signalImports[scope], owner: bridgeImports[owner],
    sourceGetter: signalImports[source?.[1]], config: signalImports[source?.[2]], host: signalImports[host],
    bindings: readerExport && { file: initialFile, name: readerExport } };
  for (const [key, binding] of Object.entries(profile)) {
    if (key === 'signalsName') continue;
    if (!binding || !/^app-(?:initial|shared|primary)-[\w-]+\.js$/.test(binding.file) || !/^[\w$]+$/.test(binding.name))
      throw new Error(`Codex Micro renderer binding is unavailable: ${key}`);
  }
  return profile;
}

module.exports = { buildMicroReadProfile };
