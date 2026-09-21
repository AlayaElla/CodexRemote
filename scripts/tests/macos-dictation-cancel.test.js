const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { macRenderer } = require('../../src/platform/macos-renderer');

function fixture({ ambiguous = false, thread = 'local:a' } = {}) {
  let voiceState = 'recording', abortCount = 0;
  const scope = {}, selection = {}, lighting = {};
  const store = { scope, watch() {}, get: key => key === selection ? thread : key === lighting ? { voiceState } : undefined };
  const abort = async () => { abortCount++; await new Promise(resolve => setTimeout(resolve, 10)); voiceState = 'idle'; };
  const controls = { isDictating: true, abortDictation: abort };
  const fiber = { memoizedState: { memoizedState: { current: store } }, child: {
    memoizedProps: { voiceControls: controls }, sibling: {
      memoizedProps: { voiceControls: ambiguous ? { ...controls, abortDictation: () => {} } : controls }
    }
  } };
  const profile = { signalsName: 'signals', scope: { file: 'bindings', name: 'scope' },
    selection: { file: 'bindings', name: 'selection' }, dispatcher: { file: 'bindings', name: 'bus' } };
  const modules = { signals: { r() {}, t: lighting }, bindings: { scope, selection, bus: {} } };
  const run = vm.runInNewContext(`(${macRenderer.toString().replace('import(`app://-/assets/${file}`)', 'load(file)')})`, {
    load: async file => modules[file], document: { getElementById: () => ({ __reactContainerTest: fiber }) },
    location: { href: 'app://-/index.html#/a' }, performance, setTimeout
  });
  return { run: () => run(profile, { op: 'cancel-dictation', expectedThreadKey: 'local:a', expectedRoute: 'app://-/index.html#/a' }),
    state: () => ({ voiceState, abortCount }) };
}

test('native cancellation awaits abort, deduplicates controls and confirms idle without keyboard focus', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.delivery, 'discarded_in_native_app');
  assert.equal(result.success, true);
  assert.deepEqual(f.state(), { voiceState: 'idle', abortCount: 1 });
});

test('ambiguous dictation and changed tasks cannot abort another recording', async () => {
  for (const options of [{ ambiguous: true }, { thread: 'local:b' }]) {
    const f = fixture(options);
    await assert.rejects(f.run(), /unique active|task changed/);
    assert.equal(f.state().abortCount, 0);
  }
});
