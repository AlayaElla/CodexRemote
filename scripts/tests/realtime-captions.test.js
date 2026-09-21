const test = require('node:test');
const assert = require('node:assert/strict');
const RealtimeSession = require('../../src/voice/realtime-session');

function harness(send = async () => true) {
  const session = new RealtimeSession({ send });
  const call = { id: 'call', ready: true, voiceSessionId: 'native',
    context: { hostId: 'local', taskId: 'task', streamId: 'stream' } };
  session.active = call;
  const event = sequence => ({ sequence, hostId: 'local', conversationId: 'task', voiceSessionId: 'native',
    entries: [{ role: 'assistant', text: `回答 ${sequence}`, final: false }] });
  return { session, call, event };
}

test('caption forwarding coalesces slow sends into the latest complete snapshot', async () => {
  const sent = []; let release;
  const h = harness(async message => {
    sent.push(message);
    if (sent.length === 1) await new Promise(resolve => { release = resolve; });
    return true;
  });
  const pending = h.session.transcript(h.call, h.event(1));
  await h.session.transcript(h.call, h.event(2));
  await h.session.transcript(h.call, h.event(3));
  assert.equal(sent.length, 1);
  release(); await pending;
  assert.deepEqual(sent.map(m => m.sequence), [1, 3]);
  assert.equal(sent[1].entries[0].text, '回答 3');
  assert.equal(sent[1].requestId, 'call');
  assert.equal(sent[1].stream_id, 'stream');
  assert.equal(h.call.pendingTranscript, null);
});

test('caption forwarding rejects stale, oversized, malformed and foreign snapshots', async () => {
  const sent = [], h = harness(async message => { sent.push(message); return true; });
  await h.session.transcript(h.call, h.event(4));
  for (const event of [h.event(3), h.event(4), { ...h.event(5), sequence: 5.1 },
    { ...h.event(5), sequence: 0x100000000 }, { ...h.event(5), hostId: 'other' },
    { ...h.event(5), conversationId: 'other' }, { ...h.event(5), voiceSessionId: 'other' },
    { ...h.event(5), entries: [] }, { ...h.event(5), entries: [null] },
    { ...h.event(5), entries: [{ role: 'assistant', text: '😀'.repeat(513), final: true }] },
    { ...h.event(5), entries: [{ role: 'assistant', text: 'nul\u0000', final: true }] },
    { ...h.event(5), entries: [{ role: 'system', text: 'hidden', final: true }] }
  ]) await h.session.transcript(h.call, event);
  assert.equal(sent.length, 1);
  await h.session.transcript(h.call, { ...h.event(5), entries: [{ role: 'user', text: '😀'.repeat(512), final: true }] });
  assert.equal(sent.length, 2);
});

test('a cancelled call drops queued captions and an inactive call cannot send', async () => {
  const sent = []; let release;
  const h = harness(async message => { sent.push(message); await new Promise(resolve => { release = resolve; }); return true; });
  const pending = h.session.transcript(h.call, h.event(1));
  await h.session.transcript(h.call, h.event(2));
  h.call.cancelled = true;
  release(); await pending;
  await h.session.transcript(h.call, h.event(3));
  assert.equal(sent.length, 1);
  h.call.cancelled = false; h.session.active = null;
  await h.session.transcript(h.call, h.event(4));
  assert.equal(sent.length, 1);
});
