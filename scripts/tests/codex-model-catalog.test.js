const assert = require('node:assert/strict');
const { test } = require('node:test');
const { deviceModelCatalog } = require('../../src/core/codex-model-catalog');

const modelIds = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];
function desktopCache() {
  return { models: modelIds.map(slug => ({
    slug, display_name: slug.toUpperCase(), visibility: 'list', default_reasoning_level: 'medium',
    supported_reasoning_levels: (slug === 'gpt-5.5' ? ['low', 'medium', 'high', 'xhigh'] :
      slug.endsWith('-luna') ? ['low', 'medium', 'high', 'xhigh', 'max'] :
        ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).map(effort => ({ effort })),
    service_tiers: [{ id: 'priority', name: 'Fast' }]
  })) };
}

test('ESP32 catalog follows all seven desktop models in desktop order', () => {
  const cache = desktopCache();
  cache.models.splice(3, 0, { slug: 'gpt-reserve', visibility: 'hide' });
  cache.models.push({ slug: 'codex-auto-review', visibility: 'hide' });
  const catalog = deviceModelCatalog(cache);
  assert.deepEqual(catalog.map(model => model.id), modelIds);
  assert.deepEqual(catalog.map(model => model.label), [
    'GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna', 'GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna', 'GPT-5.5'
  ]);
  assert.equal(cache.models[0].display_name, 'GPT-6-ASTRA', 'cache is not mutated');
});

test('device choices preserve Max and model-specific Ultra support', () => {
  const catalog = deviceModelCatalog(desktopCache());
  for (const model of catalog) {
    assert.deepEqual(model.efforts.map(effort => effort.id), model.nativeEfforts);
    assert.equal(model.defaultEffort, 'medium');
    assert.equal(model.fastSupported, true);
    assert.equal(model.fastTier, 'priority');
  }
  assert.equal(catalog[0].efforts.find(effort => effort.id === 'max').label, 'Max');
  assert.equal(catalog[1].efforts.at(-1).id, 'ultra');
  assert.equal(catalog[2].efforts.at(-1).id, 'max');
  assert.equal(catalog[6].efforts.at(-1).id, 'xhigh');
});

test('new visible models are available without another version allowlist update', () => {
  assert.deepEqual(deviceModelCatalog({}), []);
  const catalog = deviceModelCatalog({ models: [null, {}, { slug: '' }, { slug: '  ' },
    { slug: 'internal', visibility: 'hide' }, { slug: 'internal', visibility: 'unlisted' },
    { slug: 'future-model', display_name: 'Future Model', visibility: 'list', default_reasoning_level: 'none',
      supported_reasoning_levels: [{ effort: 'none' }, { effort: 'minimal' }, { effort: 'medium' }] }
  ] });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].label, 'Future Model');
  assert.equal(catalog[0].defaultEffort, 'none');
  assert.deepEqual(catalog[0].efforts.map(effort => effort.id), ['none', 'minimal', 'medium']);
  assert.equal(catalog[0].fastSupported, false);
});
