#!/usr/bin/env node

// Codex invokes this command with one lifecycle-event JSON object on stdin.
// The bridge is a read-only event sink: all runtime data travels over loopback
// HTTP, and this hook never reads or writes Codex session files.
const http = require('http');

const hookRoute = process.argv[2] || '';
const portFlagIndex = process.argv.indexOf('--port');
const cliPort = portFlagIndex >= 0 ? Number(process.argv[portFlagIndex + 1]) : NaN;
const port = Number.isInteger(cliPort)
  ? cliPort
  : Number(process.env.CODEX_REMOTE_HOOK_PORT || 7777);
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const APPROVAL_TIMEOUT_MS = 9 * 60 * 1000;
const EVENT_BY_ROUTE = Object.freeze({
  'user-prompt': 'UserPromptSubmit',
  pre: 'PreToolUse',
  post: 'PostToolUse',
  waiting: 'PermissionRequest',
  stop: 'Stop'
});

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let input = '';
    let bytes = 0;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (bytes >= MAX_INPUT_BYTES) return;
      const remaining = MAX_INPUT_BYTES - bytes;
      const accepted = Buffer.from(chunk).subarray(0, remaining).toString('utf8');
      input += accepted;
      bytes += Buffer.byteLength(accepted);
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', () => resolve(input));
  });
}

function postEvent(eventName, payload) {
  const timeout = eventName === 'PermissionRequest' ? APPROVAL_TIMEOUT_MS : 1500;
  return new Promise((resolve) => {
    const body = JSON.stringify({ event_name: eventName, payload });
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/events',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => {
        try {
          resolve(responseBody ? JSON.parse(responseBody) : {});
        } catch {
          resolve({});
        }
      });
    });
    request.on('error', () => resolve({}));
    request.on('timeout', () => {
      request.destroy();
      resolve({});
    });
    request.end(body);
  });
}

const currentEventName = EVENT_BY_ROUTE[hookRoute] || '';

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  if (!currentEventName) return;

  const response = await postEvent(currentEventName, payload);

  // PermissionRequest uses this output to apply the user's remote choice.
  // Stop requires valid JSON on stdout even when no continuation is requested.
  if (currentEventName === 'PermissionRequest' || currentEventName === 'Stop') {
    process.stdout.write(JSON.stringify(response.hook_output || {}));
  }
}

main().catch(() => {
  if (currentEventName === 'Stop') process.stdout.write('{}');
}).finally(() => process.exit(0));
