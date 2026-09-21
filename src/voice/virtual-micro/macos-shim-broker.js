const { EventEmitter } = require('node:events');
const { Writable, PassThrough } = require('node:stream');

// In-process adapter for Controller's existing JSONL broker protocol. The
// authenticated runtime socket transports reports; no helper process is run.
function createMacShimBroker(runtime, { pollMs = 100 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let buffer = '', timer, polling = false, connected = false, ended = false, closing = null, opened = false, removed = false;
  let queue = Promise.resolve();
  const emit = message => { if (!ended) child.stdout.write(JSON.stringify(message) + '\n'); };
  const cleanup = () => {
    if (closing) return closing;
    ended = true; connected = false; clearInterval(timer);
    // Wait for queued transport operations before removing this session's shim.
    closing = queue.catch(() => {}).then(() => removed ? null : runtime.request('micro-close')).catch(() => {}).finally(() => child.emit('exit', 0));
    return closing;
  };
  child.kill = cleanup;
  const poll = async () => {
    if (ended || !connected || polling) return;
    polling = true;
    try {
      const result = await runtime.request('micro-poll');
      if (!result.shimInstalled || opened && !result.hostOpened) throw new Error('Codex closed the Micro shim; reconnect required.');
      opened ||= result.hostOpened;
      for (const data of result.reports) emit({ event: 'report', data });
    } catch (error) { emit({ event: 'fault', message: error.message }); void cleanup(); }
    finally { polling = false; }
  };
  const request = async message => {
    if (ended) return;
    try {
      let result;
      if (message.op === 'connect') {
        result = await runtime.request('micro-connect');
        connected = true;
        timer = setInterval(poll, pollMs); timer.unref?.();
      } else if (['heartbeat', 'submit', 'releaseAll', 'close'].includes(message.op)) {
        result = await runtime.request(`micro-${message.op}`, message.op === 'submit' ? { reports: message.reports } : {});
        if (message.op === 'close') { removed = true; connected = false; clearInterval(timer); }
      } else throw new Error('Unsupported shim broker operation.');
      emit({ id: message.id, ok: true, result });
    } catch (error) { emit({ id: message.id, ok: false, error: error.message }); }
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 65536) { callback(new Error('Shim broker frame too large.')); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch (error) { callback(error); return; }
        queue = queue.then(() => request(message));
      }
      callback();
    },
    final(callback) { void cleanup().then(() => callback()); }
  });
  return child;
}
module.exports = { createMacShimBroker };
