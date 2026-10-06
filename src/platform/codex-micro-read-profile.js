// Serialized alongside the reader; resolve imports by their use in the installed
// bundle so a release changing minified export names cannot silently empty slots.
function buildMicroReadProfile({ signalsName, signalsText, bridgeText, initialText, sharedText }) {
  function buildSharedBindingFamily() {
    const sharedFile = Object.values(signalImports).find(value => value.file.startsWith('app-shared-'))?.file;
    if (!sharedFile || typeof sharedText !== 'string') return null;
    const key = '`client-thread-bindings-v1`';
    const position = sharedText.indexOf(key);
    if (position < 0) return null;
    const nearby = sharedText.slice(position, position + 1200);
    const family = nearby.match(/,([\w$]+)=[\w$]+\([\w$]+,\([\w$]+,\{get:([\w$]+)\}\)=>[\s\S]{0,400}?\2\(([\w$]+)\)/);
    if (!family) return null;
    const atom = family[3];
    const atomPattern = new RegExp('(?:^|[,;])' + escape(atom) + '=[\\w$]+\\([\\w$]+,(?:void 0|undefined)\\)');
    if (!atomPattern.test(nearby)) return null;
    const exportTail = sharedText.slice(sharedText.lastIndexOf('export{'));
    const exportedName = exportTail.match(new RegExp('(?:^|[,\\{])' + escape(family[1]) + ' as ([\\w$]+)(?=,|\\})'))?.[1];
    if (!exportedName) return null;
    return { file: sharedFile, name: exportedName, mode: 'family' };
  }

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
  const sharedFile = Object.values(signalImports).find(value => value.file.startsWith('app-shared-'))?.file;
  const bindingFamily = buildSharedBindingFamily();
  const bindings = bindingFamily || (readerExport && { file: initialFile, name: readerExport, mode: 'getter' });
  const profile = { signalsName, scope: signalImports[scope], owner: bridgeImports[owner],
    sourceGetter: signalImports[source?.[1]], config: signalImports[source?.[2]], host: signalImports[host], bindings };
  for (const [key, binding] of Object.entries(profile)) {
    if (key === 'signalsName') continue;
    if (!binding || !/^app-(?:initial|shared|primary)-[\w-]+\.js$/.test(binding.file) || !/^[\w$]+$/.test(binding.name))
      throw new Error(`Codex Micro renderer binding is unavailable: ${key}`);
    if (key === 'bindings' && !['getter', 'family'].includes(binding.mode))
      throw new Error('Codex Micro renderer binding is unavailable: bindings');
  }
  return profile;
}

module.exports = { buildMicroReadProfile };
