// Serialized into the verified Codex renderer. No Electron or Node APIs here.
async function macRenderer(profile, request) {
  const files = [...new Set([profile.signalsName, ...Object.values(profile).filter(v => v?.file).map(v => v.file)])];
  const modules = Object.fromEntries(await Promise.all(files.map(async file => [file, await import(`app://-/assets/${file}`)])));
  const resolve = binding => modules[binding.file][binding.name];
  const signals = modules[profile.signalsName];
  signals.r();
  const root = document.getElementById('root');
  const container = root?.[Object.keys(root).find(key => key.startsWith('__reactContainer'))];
  const queue = [container?.stateNode?.current || container], seen = new Set();
  let store;
  while (queue.length && seen.size < 30000 && !store) {
    const fiber = queue.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    for (let hook = fiber.memoizedState, count = 0; hook && count++ < 100; hook = hook.next) {
      const value = hook.memoizedState?.current;
      if (value?.scope === resolve(profile.scope) && typeof value.get === 'function' && typeof value.watch === 'function') {
        store = value; break;
      }
    }
    queue.push(fiber.sibling, fiber.child);
  }
  if (!store) throw new Error('Codex renderer state is unavailable.');
  const bus = resolve(profile.dispatcher);
  const selected = () => store.get(resolve(profile.selection)) ?? null;
  const voice = () => store.get(signals.t)?.voiceState ?? null;
  function snapshot() {
    const slots = store.get(signals.n);
    if (!Array.isArray(slots) || slots.length !== 6) throw new Error('Codex Micro slot schema changed.');
    const lighting = store.get(signals.t);
    const assignments = store.get(signals.u) || {};
    const config = resolve(profile.config), getter = resolve(profile.sourceGetter);
    return {
      source: getter(store.get, config.agentSource),
      selectedThreadKey: selected(), voiceState: voice(), route: location.href,
      composerReady: document.querySelector('[contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"]') !== null,
      threadBindings: Object.fromEntries(Object.entries(resolve(profile.bindings)('client-thread-bindings-v1', {}) || {})
        .filter(([client, thread]) => /^client-new-thread:[\w-]{1,128}$/.test(client) && typeof thread === 'string' && /^[\w-]{1,128}$/.test(thread)).slice(-128)),
      lighting: lighting ? { brightnessPercent: Math.round(lighting.brightness * 100), autoDimMs: lighting.inactivityTimeoutMs, voiceState: lighting.voiceState } : null,
      slots: slots.map(slot => {
        const key = slot.threadKey;
        const id = typeof key === 'string' && key.startsWith('local:') ? key.slice(6) : null;
        const assignment = assignments[`AG${String(slot.id).padStart(2, '0')}`];
        const hostId = key == null ? null : id == null ? 'cloud'
          : store.get(resolve(profile.host), id) || (assignment?.threadKey === key ? assignment.hostId : null) || 'local';
        return { ...slot, hostId };
      })
    };
  }
  const guard = () => {
    if (request.expectedThreadKey !== undefined && selected() !== request.expectedThreadKey) throw new Error('Codex task changed before control dispatch.');
    if (request.expectedRoute !== undefined && location.href !== request.expectedRoute) throw new Error('Codex draft changed before control dispatch.');
  };
  const waitFor = async predicate => {
    const deadline = performance.now() + 3000;
    do {
      guard();
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (performance.now() < deadline);
    throw new Error('Codex did not confirm the requested state.');
  };
  const dispatch = message => {
    if (!(bus?.handlers instanceof Map) || !bus.handlers.get(message.type)?.size) throw new Error(`Codex handler is unavailable: ${message.type}`);
    bus.dispatchHostMessage(message);
  };
  guard();
  if (request.op === 'read') return snapshot();
  if (request.op === 'ptt') {
    if (typeof request.down !== 'boolean') throw new Error('Invalid PTT state.');
    if (request.down && voice() === 'recording') throw new Error('Codex is already recording.');
    dispatch({ type: request.down ? 'codex-micro-push-to-talk-start' : 'codex-micro-push-to-talk-stop' });
    await waitFor(() => request.down ? voice() === 'recording' : voice() !== 'recording');
    return { delivery: 'desktop_runtime', outcome: 'confirmed', snapshot: snapshot() };
  }
  if (request.op === 'command') {
    const allowed = ['newTask', 'composer.submit', 'composer.toggleFastMode', 'composer.increaseReasoningEffort',
      'composer.decreaseReasoningEffort', 'approval.approve', 'approval.decline', 'forkThread', 'focusMainChat'];
    if (!allowed.includes(request.command)) throw new Error('Unsupported Codex command.');
    const submittingVoice = request.command === 'composer.submit' && voice() === 'recording';
    if (resolve(profile.command)(request.command, 'codex_micro_hid') !== true) throw new Error('Codex command is unavailable in the current context.');
    if (submittingVoice) {
      // Submission can legitimately bind a draft and change its route. After
      // dispatch, observe only; do not send a PTT-stop into the new page.
      const deadline = performance.now() + 3000;
      while (voice() === 'recording') {
        if (performance.now() >= deadline) throw new Error('Codex did not finish dictation after submit.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    // Command registration acknowledges dispatch only. Callers confirm task,
    // draft, voice and settings transitions through their corresponding state.
    return { delivery: 'desktop_runtime', outcome: 'requested', voiceReleased: submittingVoice };
  }
  if (request.op === 'paste') {
    if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 32768) throw new Error('Invalid composer text.');
    if (resolve(profile.command)('focusMainChat', 'codex_micro_hid') !== true) throw new Error('Codex composer focus is unavailable.');
    guard();
    const editor = document.activeElement;
    if (!(editor instanceof HTMLElement) || !editor.isContentEditable) throw new Error('Codex composer is not focused.');
    const previous = editor.textContent || '';
    dispatch({ type: 'codex-micro-insert-composer-text', text: request.text });
    const compact = value => value.replace(/\s/g, '');
    await waitFor(() => editor.isConnected && editor.textContent !== previous && compact(editor.textContent).includes(compact(request.text)));
    return { delivery: 'desktop_runtime', outcome: 'confirmed' };
  }
  throw new Error('Unsupported renderer operation.');
}

module.exports = { macRenderer };
