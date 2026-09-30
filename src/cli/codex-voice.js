#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const CodexAppServerClient = require('./codex-app-server-client');

const ROOT = path.join(os.tmpdir(), 'codex-remote-voice');
const config = {
  whisper: process.env.WHISPER_CLI || process.env.CODEX_VOICE_WHISPER || 'whisper-cli',
  model: process.env.WHISPER_MODEL || process.env.CODEX_VOICE_WHISPER_MODEL || '',
  language: process.env.WHISPER_LANGUAGE || process.env.CODEX_VOICE_LANGUAGE || 'auto',
  recorder: process.env.CODEX_VOICE_RECORDER || '',
  input: process.env.CODEX_VOICE_INPUT || '',
  cwd: process.env.CODEX_VOICE_CWD || process.cwd()
};

function usage() {
  console.log(`Codex Remote CLI Voice\n\n` +
    `Enter = start/stop recording, q = quit.\n\n` +
    `Environment:\n` +
    `  WHISPER_CLI              whisper-cli executable\n` +
    `  WHISPER_MODEL            ggml model path\n` +
    `  WHISPER_LANGUAGE         auto, zh, en, ...\n` +
    `  CODEX_VOICE_RECORDER     pw-record, arecord, or ffmpeg\n` +
    `  CODEX_VOICE_INPUT        PipeWire/ALSA input device\n` +
    `  CODEX_COMMAND            Codex executable\n` +
    `  CODEX_APP_SERVER_ARGS    app-server arguments, default: app-server\n`);
}

function commandExists(command) {
  return spawnSync('sh', ['-lc', `command -v ${JSON.stringify(command)}`], { encoding: 'utf8' }).status === 0;
}

function chooseRecorder() {
  if (config.recorder) return config.recorder;
  if (commandExists('pw-record')) return 'pw-record';
  if (commandExists('arecord')) return 'arecord';
  if (commandExists('ffmpeg')) return 'ffmpeg';
  throw new Error('未找到录音工具。请安装 PipeWire pw-record、ALSA arecord 或 ffmpeg。');
}

function recorderArgs(command, file) {
  if (command === 'pw-record') {
    const args = ['--rate', '16000', '--channels', '1', '--format', 's16'];
    if (config.input) args.push('--target', config.input);
    return [...args, file];
  }
  if (command === 'arecord') {
    const args = ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1'];
    if (config.input) args.push('-D', config.input);
    return [...args, file];
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'pulse'];
  if (config.input) args.push('-i', config.input); else args.push('-i', 'default');
  return [...args, '-ac', '1', '-ar', '16000', '-y', file];
}

function record(command, file) {
  const child = spawn(command, recorderArgs(command, file), { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const promise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 || code === 130
      ? resolve()
      : reject(new Error(`${command} 录音失败(${code}): ${stderr.trim()}`)));
  });
  return { promise, stop: () => child.kill('SIGINT') };
}

async function transcribe(file) {
  if (!config.model) throw new Error('请设置 WHISPER_MODEL 指向 Whisper.cpp 的 ggml 模型。');
  const outputBase = path.join(ROOT, `transcript-${process.pid}-${Date.now()}`);
  const args = ['-m', config.model, '-f', file, '--no-timestamps', '--no-prints', '--output-txt', '--output-file', outputBase];
  if (config.language) args.push('--language', config.language);
  await new Promise((resolve, reject) => {
    const child = spawn(config.whisper, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Whisper.cpp 转写失败(${code}): ${stderr.trim()}`)));
  });
  const textFile = `${outputBase}.txt`;
  try { return fs.readFileSync(textFile, 'utf8').replace(/\s+/g, ' ').trim(); }
  finally { try { fs.unlinkSync(textFile); } catch {} }
}

async function main() {
  if (process.argv.includes('-h') || process.argv.includes('--help')) { usage(); return; }
  if (process.platform !== 'linux') throw new Error('CLI 语音模式当前只支持 Linux。');
  fs.mkdirSync(ROOT, { recursive: true });
  const recorder = chooseRecorder();
  const client = new CodexAppServerClient({ cwd: config.cwd });
  client.on('stderr', text => process.stderr.write(`[codex] ${text}`));
  client.on('error', error => process.stderr.write(`\n[codex] ${error.message}\n`));
  client.on('approval-request', () => process.stderr.write('\n[codex] approval request ignored because approvalPolicy=never\n'));
  await client.start();
  await client.ensureThread();
  console.log(`Codex Voice ready (${recorder}). Enter 开始/停止录音，q 退出。`);

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let recording = null;
  const finish = async () => {
    if (recording) {
      recording.stop();
      await recording.promise;
      recording = null;
    }
    client.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };
  process.stdin.on('keypress', async (_, key) => {
    if (key?.ctrl && key.name === 'c') { await finish(); process.exit(0); }
    if (key?.name === 'q' && !recording) { await finish(); process.exit(0); }
    if (key?.name !== 'return') return;
    if (!recording) {
      const file = path.join(ROOT, `voice-${process.pid}-${Date.now()}.wav`);
      process.stdout.write('\n录音中，再按 Enter 停止…');
      recording = record(recorder, file);
      recording.promise.then(async () => {
        process.stdout.write('\n转写中…');
        const text = await transcribe(file);
        try { fs.unlinkSync(file); } catch {}
        if (!text) { console.log('空语音，跳过。'); return; }
        console.log(`\n你说：${text}\nCodex：`);
        await client.sendText(text);
      }).catch(error => console.error(`\n语音失败：${error.message}`)).finally(() => { recording = null; });
    } else {
      recording.stop();
    }
  });
  process.once('SIGINT', () => { void finish().finally(() => process.exit(0)); });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
