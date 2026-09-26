const assert = require('node:assert/strict');
const { test } = require('node:test');
const { TargetedTextRequests, validateTargetedText } = require('../../src/core/codex-targeted-text');

const target = { type: 'text_input', request_id: 'text-1', text: '发送给精确任务', host_id: 'local', stream_id: 'stream-1', thread_id: 'task-1' };

test('targeted text requires exactly one fresh task or draft identity', () => {
  assert.deepEqual(validateTargetedText(target), target);
  assert.throws(() => validateTargetedText({ ...target, thread_id: 'other', draft_id: 'draft-1' }), /明确选择/);
  assert.throws(() => validateTargetedText({ ...target, stream_id: 'stale stream' }), /连接身份/);
  assert.throws(() => validateTargetedText({ ...target, host_id: 'remote' }), /连接身份/);
});

test('targeted text reuses the matching result but rejects duplicate IDs with another target', async () => {
  const requests = new TargetedTextRequests(); let calls = 0;
  const submit = async request => { calls++; assert.equal(request.thread_id, 'task-1'); return { success: true, delivery: 'submitted_to_hid' }; };
  const [first, replay] = await Promise.all([requests.handle(target, submit), requests.handle(target, submit)]);
  assert.equal(calls, 1); assert.deepEqual(first, replay); assert.equal(first.thread_id, 'task-1');
  const conflict = await requests.handle({ ...target, thread_id: 'task-2' }, submit);
  assert.equal(conflict.success, false); assert.match(conflict.error, /已用于其他/);
});

test('draft first message keeps its draft identity in the acknowledgement', async () => {
  const request = { ...target, request_id: 'draft-message', thread_id: undefined, draft_id: 'draft-1' };
  const result = await new TargetedTextRequests().handle(request, async value => {
    assert.equal(value.draft_id, 'draft-1'); return { success: true, outcome: 'requested' };
  });
  assert.equal(result.draft_id, 'draft-1'); assert.equal(result.thread_id, undefined);
});

test('pending sends are never evicted when the receipt cache fills', async () => {
  const requests = new TargetedTextRequests({ maxRequests: 1 });
  let finish; let calls = 0;
  const submit = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = requests.handle(target, submit);
  await Promise.resolve();
  const rejected = await requests.handle({ ...target, request_id: 'second' }, submit);
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /队列已满/);
  const replay = requests.handle(target, submit);
  assert.equal(calls, 1);
  finish({ success: true, submissionConfirmed: false });
  assert.deepEqual(await first, await replay);
  const next = await requests.handle({ ...target, request_id: 'second' }, async () => ({ success: true }));
  assert.equal(next.success, true);
});
