// A projection of the desktop's ordered history. Array positions are preserved
// for Immer patches; tool inputs, output, reasoning and attachments are dropped.
const TEXT_BYTES = 4096;
const MEDIA_REF_CHARS = 12 * 1024 * 1024;
const RECENT_MESSAGE_LIMIT = 10;
const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text']);
function clipText(value) {
  if (typeof value !== 'string') return '';
  const bytes = Buffer.from(value);
  if (bytes.length <= TEXT_BYTES) return value;
  let end = TEXT_BYTES - 3;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + '…';
}
const part = { type: 'id', text: 'text', url: 'media', path: 'media', width: 'dimension', height: 'dimension', alt: 'text' };
const item = { type: 'id', id: 'id', text: 'text', phase: 'id', status: 'id', clientId: 'id', clientUserMessageId: 'id', serverUserMessageId: 'id', input: [part], src: 'media', savedPath: 'media', result: 'media', width: 'dimension', height: 'dimension', alt: 'text', content: [part] };
const MESSAGE_TYPES = new Set(['userMessage', 'steeringUserMessage', 'agentMessage', 'imageGeneration']);
const turn = { turnId: 'id', params: { clientUserMessageId: 'id', input: [part] }, items: [item] };
const schema = {
  turns: [turn],
  turnHistory: { kind: 'id', history: {
    entitiesByKey: { '*': turn },
    islands: [{ entries: [{ key: 'id', value: 'id' }] }]
  } }
};
const safeKey = key => !['__proto__', 'constructor', 'prototype'].includes(String(key));
function project(value, spec) {
  if (spec === 'id') return typeof value === 'string' ? value.slice(0, 192) : '';
  if (spec === 'text') return clipText(value);
  if (spec === 'media') return typeof value === 'string' && value.length <= MEDIA_REF_CHARS ? value : '';
  if (spec === 'dimension') return Number.isSafeInteger(value) && value > 0 && value <= 16384 ? value : null;
  if (Array.isArray(spec)) return Array.isArray(value) ? value.map(v => project(v, spec[0])) : [];
  const out = {};
  if (!value || typeof value !== 'object') return out;
  // Retain a placeholder for tool items so subsequent array-index patches fit.
  if (spec === item && !MESSAGE_TYPES.has(value.type)) return { type: value.type };
  for (const key of Object.keys(value)) {
    const child = spec[key] || spec['*'];
    if (safeKey(key) && child) out[key] = project(value[key], child);
  }
  return out;
}
function pathSpec(path) {
  let spec = schema;
  for (const key of path) {
    if (!safeKey(key)) return null;
    if (Array.isArray(spec)) {
      if (!/^\d+$/.test(String(key)) || Number(key) > 500000) return null;
      spec = spec[0];
    } else if (typeof spec === 'object') spec = spec[key] || spec['*'];
    else return null;
    if (!spec) return null;
  }
  return spec;
}
function applyHistoryPatches(history, patches) {
  for (const patch of patches) {
    const path = Array.isArray(patch.path) ? patch.path : typeof patch.path === 'string'
      ? patch.path.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
    if (!path.length || !['add', 'replace', 'remove'].includes(patch.op)) continue;
    const spec = pathSpec(path);
    if (!spec) continue;
    let parent = history;
    for (const key of path.slice(0, -1)) { parent = parent?.[key]; if (!parent) break; }
    if (!parent || typeof parent !== 'object') continue;
    // Do not accumulate text patched onto a tool placeholder.
    if (parent.type && !MESSAGE_TYPES.has(parent.type) && !['text', 'input_text', 'output_text', 'image', 'localImage'].includes(parent.type)) continue;
    const key = path.at(-1);
    if (patch.op === 'remove') {
      if (Array.isArray(parent)) { if (Number(key) < parent.length) parent.splice(Number(key), 1); }
      else delete parent[key];
    } else {
      const value = project(patch.value, spec);
      if (Array.isArray(parent)) {
        if (Number(key) > parent.length) continue;
        if (patch.op === 'add') parent.splice(Number(key), 0, value);
        else parent[Number(key)] = value;
      } else parent[key] = value;
    }
  }
  return history;
}
function contentText(parts) {
  return clipText((parts || []).filter(p => TEXT_PART_TYPES.has(p?.type))
    .map(p => p.text || '').join('\n'));
}
function mediaRef(source, kind, width, height, alt) {
  if (typeof source !== 'string' || source.length === 0 || source.length > MEDIA_REF_CHARS) return null;
  return { source, kind, width: Number.isSafeInteger(width) ? width : null, height: Number.isSafeInteger(height) ? height : null, alt: typeof alt === 'string' ? clipText(alt) : null };
}
function imageContent(parts, textTypes) {
  const content = [];
  for (const value of parts || []) {
    if (textTypes.has(value?.type)) {
      const text = clipText(value.text);
      if (text) content.push({ type: 'text', text });
      continue;
    }
    const source = value?.type === 'image' ? value.url : value?.type === 'localImage' ? value.path : null;
    const ref = mediaRef(source, value?.type, value?.width, value?.height, value?.alt);
    if (ref) content.push({ type: 'image', mediaRef: ref, width: ref.width, height: ref.height, alt: ref.alt });
  }
  return content;
}
function userContent(parts) {
  return imageContent(parts, new Set(['text', 'input_text']));
}
function agentContent(parts) {
  const content = [];
  for (const value of parts || []) {
    // Structured assistant text can itself contain rendered Markdown images.
    // Project those exactly like the legacy item.text path so a source URL or
    // local filename cannot arrive in the device's visible text field.
    if (TEXT_PART_TYPES.has(value?.type)) {
      content.push(...markdownContent(value.text));
      continue;
    }
    const source = value?.type === 'image' ? value.url : value?.type === 'localImage' ? value.path : null;
    const ref = mediaRef(source, value?.type, value?.width, value?.height, value?.alt);
    if (ref) content.push({ type: 'image', mediaRef: ref, width: ref.width, height: ref.height, alt: ref.alt });
  }
  return content;
}
// Only Markdown image syntax creates a media reference. Plain links and bare
// URLs stay text, so they cannot turn into a device media fetch.
const MARKDOWN_IMAGE = /!\[([^\]\r\n]{0,256})\]\((?:<([^>\r\n]{1,8192})>|([^\s)\r\n]{1,8192}))(?:\s+['"][^\r\n'"]{0,256}['"])?\)/g;
function markdownContent(value) {
  const text = clipText(value);
  if (!text) return [];
  const content = []; let offset = 0; let match;
  // The expression deliberately accepts only the URL token (or <URL> form)
  // from ![alt](url); ordinary [label](url) has no match.
  while ((match = MARKDOWN_IMAGE.exec(text)) != null) {
    const source = match[2] || match[3];
    const ref = mediaRef(source, 'markdownImage', null, null, match[1]);
    if (!ref) continue;
    const before = text.slice(offset, match.index);
    if (before) content.push({ type: 'text', text: before });
    content.push({ type: 'image', mediaRef: ref, width: null, height: null, alt: ref.alt });
    offset = match.index + match[0].length;
  }
  if (content.length === 0) return [{ type: 'text', text }];
  const tail = text.slice(offset);
  if (tail) content.push({ type: 'text', text: tail });
  return content;
}
function generatedImageContent(value) {
  const savedPath = typeof value?.savedPath === 'string' && value.savedPath ? value.savedPath : null;
  const src = typeof value?.src === 'string' && value.src ? value.src : null;
  const result = typeof value?.result === 'string' && value.result ? value.result : null;
  const source = savedPath || src || result;
  const kind = source === result && savedPath == null && src == null ? 'generatedResult' : 'generatedImage';
  const ref = mediaRef(source, kind, value?.width, value?.height, value?.alt);
  return ref ? [{ type: 'image', mediaRef: ref, width: ref.width, height: ref.height, alt: ref.alt }] : [];
}
function recentMessages(history, limit = RECENT_MESSAGE_LIMIT) {
  const canonical = history.turnHistory?.history;
  const turns = history.turnHistory?.kind === 'canonical' && canonical
    ? (canonical.islands || []).flatMap(i => (i.entries || []).map(e => canonical.entitiesByKey?.[e.value]))
    : history.turns || [];
  const result = [], ids = new Set();
  const add = ({ id, role, text, content, turnId }) => {
    if (!Array.isArray(content) || content.length === 0 || ids.has(id)) return;
    ids.add(id); result.unshift({ id, role, text: clipText(text), content, turnId });
  };
  const messageLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, RECENT_MESSAGE_LIMIT) : RECENT_MESSAGE_LIMIT;
  for (let t = turns.length - 1; t >= 0 && result.length < messageLimit; t--) {
    const turn = turns[t]; if (!turn) continue;
    const items = turn.items || [];
    // The desktop replaces an accepted steer's server userMessage with a
    // steered marker. Keep its steeringUserMessage, and suppress a duplicate
    // server echo while the replacement patches are still in flight.
    const steers = items.filter(item => item?.type === 'steeringUserMessage');
    for (let i = items.length - 1; i >= 0 && result.length < messageLimit; i--) {
      const item = items[i];
      if (item?.type === 'agentMessage' && (!item.phase || ['commentary', 'final_answer', 'final'].includes(item.phase))) {
        // `content` is the structured, ordered source when present. The
        // Markdown fallback handles older agent messages that only contain
        // text, including pure image replies.
        const content = agentContent(item.content);
        const projected = content.length > 0 ? content : markdownContent(item.text);
        add({ id: item.id || `${turn.turnId}:agent:${i}`, role: 'codex', text: contentText(projected), content: projected, turnId: turn.turnId || null });
      }
      if (item?.type === 'imageGeneration') {
        const content = generatedImageContent(item);
        add({ id: item.id || `${turn.turnId}:image:${i}`, role: 'codex', text: '', content, turnId: turn.turnId || null });
      }
      if (item?.type === 'userMessage') {
        if (steers.some(steer => steer.serverUserMessageId === item.id ||
            (item.clientId && steer.clientUserMessageId === item.clientId))) continue;
        const content = userContent(item.content);
        add({ id: item.id || `${turn.turnId}:user:${i}`, role: 'user', text: contentText(item.content), content, turnId: turn.turnId || null });
      }
      if (item?.type === 'steeringUserMessage') {
        const content = userContent(item.input);
        add({ id: item.id || item.clientUserMessageId || `${turn.turnId}:steer:${i}`, role: 'user',
          text: contentText(item.input), content, turnId: turn.turnId || null });
      }
    }
    if (result.length < messageLimit && !items.some(i => i?.type === 'userMessage')) {
      const content = userContent(turn.params?.input);
      add({ id: turn.params?.clientUserMessageId || `${turn.turnId}:user`, role: 'user', text: contentText(turn.params?.input), content, turnId: turn.turnId || null });
    }
  }
  return result;
}
function projectHistory(state) { return project(state, schema); }
module.exports = { projectHistory, applyHistoryPatches, recentMessages, clipText };
