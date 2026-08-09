const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tailwindConfig = require('../tailwind.config');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'app.html'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'renderer.js'), 'utf8');
const sourceCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'tailwind.css'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const packageJson = require('../package.json');
const sourceLines = [...html.split(/\r?\n/), ...renderer.split(/\r?\n/)];
const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const rendererIds = [...renderer.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
const mixedUiFontLines = sourceLines.filter((line) =>
  /font-(?:label|caption)-mono/.test(line) && /[\u3400-\u9fff]/.test(line)
);

assert.deepEqual(mixedUiFontLines, [], 'Chinese UI text must not use a monospace utility class');
assert.equal((html.match(/class="pill-item[^\n]*font-body-main/g) || []).length, 5);
assert.deepEqual(rendererIds.filter((id) => !htmlIds.includes(id)), [], 'renderer must not reference missing DOM elements');
assert.equal(new Set(htmlIds).size, htmlIds.length, 'DOM ids must be unique');

const fonts = tailwindConfig.theme.extend.fontFamily;
const colors = tailwindConfig.theme.extend.colors;
for (const family of ['headline-display', 'body-sm', 'body-main', 'headline-section']) {
  assert.equal(fonts[family][0], 'Microsoft YaHei UI');
  assert.deepEqual(fonts[family], fonts['body-main']);
}
for (const family of ['label-mono', 'caption-mono']) {
  assert(fonts[family].includes('Microsoft YaHei UI'));
}
assert.equal(colors.background, '#f5f5f7');
assert.equal(colors.primary, '#0071e3');
assert(html.includes('ChatGPT 原生'), 'native voice mode must be visible');
assert(html.includes('API'), 'API voice mode must be visible');
assert(html.includes('/audio/transcriptions'), 'API transcription endpoint guidance must be visible');
assert(!html.includes('id="service-voice-shortcut"'), 'native shortcut must stay out of base service settings');
assert(/id="voice-native-shortcut"/.test(html), 'native shortcut must be configurable in the native pane');
assert(html.includes('自动生成'), 'service token generation button must be visible');
assert(/id="service-token"[^>]*maxlength="16"/.test(html), 'service token input must cap manual tokens at 16 characters');
assert(html.includes('1–16'), 'service token UI must document the 1–16 character range');
assert(/id="voice-mode"/.test(html), 'voice mode selector must be present');
assert(/<input type="password"[^>]*id="voice-api-key"/.test(html), 'API key must use a password input');
assert(!/local-model|LocalTranscriptionProvider|WHISPER|transcribeOnce|ffmpeg-static|asr-recorder-worklet/i.test(`${html}\n${renderer}\n${main}`),
  'offline speech recognition UI and runtime must stay absent');
assert(!/不再|以前|已移除|删除|改为/.test(html), 'voice UI must describe current functions, not edit history');
for (const iconFile of ['app-icon.svg', 'app-icon.png', 'app-icon.ico']) {
  assert(fs.existsSync(path.join(__dirname, '..', 'assets', iconFile)), `missing ${iconFile}`);
}
assert(main.includes("'assets', 'app-icon.png'"), 'window and tray must load the application icon');
assert(packageJson.scripts.package.includes('--icon=assets/app-icon.ico'), 'Windows package must embed the application icon');

const uiSource = sourceLines.join('\n');
assert(!/<style>/i.test(html), 'UI styles must live in tailwind.css instead of app.html');
assert(!/\b(?:text|bg|border)-(?:red|green|blue|amber|yellow|emerald|gray)-\d+\b/.test(uiSource),
  'UI source must use semantic color tokens');
assert(!/\brounded-xl\b/.test(uiSource), 'PC UI cards must use the shared 8px radius');
assert(sourceCss.includes('@media (prefers-reduced-motion: reduce)'), 'motion must respect reduced-motion preferences');
for (const animationName of ['surface-in', 'tab-content-in', 'status-update', 'activity-in']) {
  assert(sourceCss.includes(`@keyframes ${animationName}`), `missing ${animationName} motion`);
}

console.log('visual consistency test passed');
