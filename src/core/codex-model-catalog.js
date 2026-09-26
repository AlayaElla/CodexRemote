const EFFORT_LABELS = Object.freeze({ none: '无', minimal: '最低', low: '轻', medium: '中', high: '高', xhigh: '极高', max: 'Max', ultra: 'Ultra' });
const NATIVE_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function deviceModelCatalog(cache) {
  return (Array.isArray(cache?.models) ? cache.models : [])
    // The desktop catalog owns availability, including newly released models.
    .filter(model => typeof model?.slug === 'string' && model.slug.trim() &&
      (model.visibility == null || model.visibility === 'list'))
    .map(model => {
      const supported = new Set((model.supported_reasoning_levels || []).map(level => level?.effort));
      const efforts = Object.entries(EFFORT_LABELS).filter(([id]) => supported.has(id)).map(([id, label]) => ({ id, label }));
      const fast = (model.service_tiers || []).find(tier => String(tier.name).toLowerCase() === 'fast' || String(tier.id).toLowerCase() === 'priority');
      const label = (model.display_name || model.slug).replace(/^(gpt-\d+(?:\.\d+)?)-([a-z]+)$/i,
        (_, family, variant) => `${family.toUpperCase()} ${variant[0].toUpperCase()}${variant.slice(1).toLowerCase()}`);
      return { id: model.slug, label, efforts,
        nativeEfforts: NATIVE_EFFORT_ORDER.filter(id => supported.has(id)),
        defaultEffort: efforts.some(item => item.id === model.default_reasoning_level) ? model.default_reasoning_level : efforts[0]?.id || null,
        fastSupported: Boolean(fast), fastTier: fast?.id || null };
    });
}

module.exports = { deviceModelCatalog };
