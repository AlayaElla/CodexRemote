(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VirtualMicroDriverStatus = api;
})(typeof window === 'undefined' ? globalThis : window, () => {
  function describe(result, fallbackError = '') {
    const detail = result && typeof result.message === 'string' ? result.message : fallbackError;
    const suffix = detail ? ` ${detail}` : '';
    const state = result && result.state;
    const labels = {
      ready: '驱动已安装，控制接口已就绪。',
      installed_not_ready: '驱动已安装，但控制接口尚未就绪。',
      not_installed: '未检测到虚拟 Codex Micro 驱动。',
      status_unavailable: '暂时无法读取虚拟 Codex Micro 驱动状态。',
      unsupported: '虚拟 Codex Micro 驱动仅支持 Windows。',
      outcome_unknown: '驱动状态暂时未知；请稍后刷新状态。'
    };
    if (state && labels[state]) return `${labels[state]}${suffix}`;
    return `驱动状态检查失败。${suffix}`;
  }

  return { describe };
});
