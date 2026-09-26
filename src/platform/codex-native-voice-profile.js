// Only the signal exports need a bundle lookup. The service itself is selected
// by its live API in the renderer, where the debugger can inspect it directly.
function buildNativeVoiceProfile({ initialName, initialText }) {
  const unsupported = () => new Error('Codex 原生语音接口结构已变化，无法安全启动实时语音。');
  if (!/^app-initial-[\w-]+\.js$/.test(initialName) || typeof initialText !== 'string')
    throw unsupported();
  const phase = initialText.match(/cancelStart\([^)]*\)\{[\s\S]{0,1000}?\.set\(([\w$]+),`stopping`\)/)?.[1];
  const microphoneMuted = initialText.match(/applyRealtimeMicrophoneMuteState\([\w$]+,[\w$]+\)\{[\s\S]{0,250}?\.set\(([\w$]+),[\w$]+\)/)?.[1];
  const activity = initialText.match(/setRealtimeVoiceActivity\([\w$]+,[\w$]+\)\{[\s\S]{0,100}?\.set\(([\w$]+),[\w$]+\)/)?.[1];
  const exportsText = initialText.slice(initialText.lastIndexOf('export{'));
  const exports = new Map([...exportsText.matchAll(/(?:^|[,{])([\w$]+) as ([\w$]+)(?=,|\})/g)].map(match => [match[1], match[2]]));
  const profile = { initialName, phase: exports.get(phase),
    microphoneMuted: exports.get(microphoneMuted), activity: exports.get(activity) };
  if (Object.values(profile).some(value => typeof value !== 'string' || !/^[\w$.-]+$/.test(value)))
    throw unsupported();
  return profile;
}

module.exports = buildNativeVoiceProfile;
