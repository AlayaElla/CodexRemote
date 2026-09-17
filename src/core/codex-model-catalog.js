const EFFORT_LABELS = Object.freeze({ low: '轻', medium: '中', high: '高', xhigh: '极高', ultra: 'Ultra' });
const NATIVE_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function deviceModelCatalog(cache) {
  return (Array.isArray(cache?.models) ? cache.models : [])
    .filter(model => typeof model?.slug === 'string' && /^gpt-(?:6(?:$|[-.])|5\.6(?:$|[-.]))/.test(model.slug) && model.visibility !== 'hide')
    .map(model => {
      const supported = new Set((model.supported_reasoning_levels || []).map(level => level?.effort));
      const efforts = Object.entries(EFFORT_LABELS).filter(([id]) => supported.has(id)).map(([id, label]) => ({ id, label }));
      const fast = (model.service_tiers || []).find(tier => String(tier.name).toLowerCase() === 'fast' || String(tier.id).toLowerCase() === 'priority');
      return { id: model.slug, label: model.display_name || model.slug, efforts,
        nativeEfforts: NATIVE_EFFORT_ORDER.filter(id => supported.has(id)),
        defaultEffort: efforts.some(item => item.id === model.default_reasoning_level) ? model.default_reasoning_level : efforts[0]?.id || null,
        fastSupported: Boolean(fast), fastTier: fast?.id || null };
    });
}

module.exports = { deviceModelCatalog };
