// ==========================================================================
// Codex Remote renderer controller
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  const noticeStack = document.getElementById('notice-stack');

  function showNotice({ title, message, type = 'success', duration = 4000, actions = [], noticeKey = '' }) {
    if (!noticeStack) return;

    const noticeTones = {
      success: { icon: 'check_circle', classes: 'bg-success-container text-on-success-container' },
      warning: { icon: 'warning', classes: 'bg-warning-container text-on-warning-container' },
      error: { icon: 'error', classes: 'bg-error-container text-on-error-container' },
      info: { icon: 'info', classes: 'bg-info-container text-on-info-container' }
    };
    const tone = noticeTones[type] || noticeTones.info;
    const notice = document.createElement('div');
    notice.className = 'app-notice pointer-events-auto flex items-start gap-3 rounded-lg border border-outline-variant/60 bg-surface-container-lowest p-4 shadow-panel-hover';
    if (noticeKey) notice.dataset.noticeKey = noticeKey;
    notice.setAttribute('role', type === 'success' || type === 'info' ? 'status' : 'alert');

    const iconWrap = document.createElement('div');
    iconWrap.className = `mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tone.classes}`;
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined text-[20px]';
    icon.textContent = tone.icon;
    iconWrap.appendChild(icon);

    const content = document.createElement('div');
    content.className = 'min-w-0 flex-1';
    const heading = document.createElement('p');
    heading.className = 'font-body-main text-body-main font-semibold text-on-surface';
    heading.textContent = title;
    const detail = document.createElement('p');
    detail.className = 'mt-0.5 font-body-sm text-body-sm text-on-surface-variant';
    detail.textContent = message;
    content.append(heading, detail);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'icon-button h-7 w-7 shrink-0';
    closeButton.setAttribute('aria-label', '关闭通知');
    closeButton.innerHTML = '<span class="material-symbols-outlined text-[18px]">close</span>';

    let removalTimer;
    const removeNotice = () => {
      clearTimeout(removalTimer);
      if (notice.classList.contains('is-leaving')) return;
      notice.classList.add('is-leaving');
      notice.addEventListener('animationend', () => notice.remove(), { once: true });
    };
    closeButton.addEventListener('click', removeNotice);

    if (actions.length > 0) {
      const actionRow = document.createElement('div');
      actionRow.className = 'mt-3 flex flex-wrap gap-2';
      for (const action of actions) {
        const actionButton = document.createElement('button');
        actionButton.type = 'button';
        actionButton.className = 'button-secondary px-3 py-1.5';
        actionButton.textContent = action.label;
        actionButton.addEventListener('click', () => {
          action.onClick();
          removeNotice();
        });
        actionRow.appendChild(actionButton);
      }
      content.appendChild(actionRow);
    }

    notice.append(iconWrap, content, closeButton);
    noticeStack.appendChild(notice);
    if (duration > 0) removalTimer = setTimeout(removeNotice, duration);
    return removeNotice;
  }

  const btnMin = document.getElementById('btn-win-min');
  if (btnMin && window.electronAPI) {
    btnMin.addEventListener('click', () => window.electronAPI.minimizeWindow());
  }

  // Settings Overlay Drawer & Backdrop
  const btnOpenSettings = document.getElementById('btn-open-settings');
  const btnCloseDesktop = document.getElementById('btn-close-settings-desktop');
  const settingsDrawer = document.getElementById('settings-drawer');
  const drawerBackdrop = document.getElementById('drawer-backdrop');

  function openDrawer() {
    if (settingsDrawer) settingsDrawer.classList.add('open');
    if (drawerBackdrop) drawerBackdrop.classList.add('open');
    document.body.classList.add('drawer-open');
    if (settingsDrawer) {
      settingsDrawer.inert = false;
      settingsDrawer.setAttribute('aria-hidden', 'false');
    }
    if (btnOpenSettings) btnOpenSettings.setAttribute('aria-expanded', 'true');
    if (btnCloseDesktop) btnCloseDesktop.focus();
  }

  function closeDrawer() {
    if (settingsDrawer) settingsDrawer.classList.remove('open');
    if (drawerBackdrop) drawerBackdrop.classList.remove('open');
    document.body.classList.remove('drawer-open');
    if (settingsDrawer) {
      settingsDrawer.inert = true;
      settingsDrawer.setAttribute('aria-hidden', 'true');
    }
    if (btnOpenSettings) {
      btnOpenSettings.setAttribute('aria-expanded', 'false');
      btnOpenSettings.focus();
    }
  }

  if (btnOpenSettings) btnOpenSettings.addEventListener('click', openDrawer);
  if (btnCloseDesktop) btnCloseDesktop.addEventListener('click', closeDrawer);
  if (drawerBackdrop) drawerBackdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && settingsDrawer && settingsDrawer.classList.contains('open')) {
      closeDrawer();
    }
  });

  // Settings navigation
  const pickerTabs = document.querySelectorAll('.drawer-nav-btn');
  const subTabContents = document.querySelectorAll('.sub-tab-content');

  pickerTabs.forEach(item => {
    item.addEventListener('click', () => {
      const targetId = item.getAttribute('data-subtab');

      pickerTabs.forEach(p => p.setAttribute('aria-selected', 'false'));
      subTabContents.forEach(c => {
        c.classList.add('hidden');
        c.classList.remove('active', 'is-entering');
        c.setAttribute('aria-hidden', 'true');
      });

      item.setAttribute('aria-selected', 'true');

      const targetContent = document.getElementById(targetId);
      if (targetContent) {
        targetContent.classList.remove('hidden');
        targetContent.classList.add('active', 'is-entering');
        targetContent.setAttribute('aria-hidden', 'false');
      }
    });
  });

  // Background service configuration
  const serviceWsPortInput = document.getElementById('service-ws-port');
  const serviceHookPortInput = document.getElementById('service-hook-port');
  const serviceTokenInput = document.getElementById('service-token');
  const btnGenerateServiceToken = document.getElementById('btn-generate-service-token');
  const serviceCollectorTypeInput = document.getElementById('service-collector-type');
  const serviceApprovalModeInput = document.getElementById('service-approval-mode');
  const serviceConfigStatus = document.getElementById('service-config-status');
  const btnRestartServices = document.getElementById('btn-restart-services');
  const btnRepairCodexHooks = document.getElementById('btn-repair-codex-hooks');
  const codexHookInstallStatus = document.getElementById('codex-hook-install-status');
  const codexHookInstallPath = document.getElementById('codex-hook-install-path');
  const serviceRestartIcon = btnRestartServices ? btnRestartServices.querySelector('.service-restart-icon') : null;

  const voiceModeInput = document.getElementById('voice-mode');
  const voiceApiPane = document.getElementById('voice-api-pane');
  const voiceVirtualMicroPane = document.getElementById('voice-virtual-micro-pane');
  const voiceApiBaseUrlInput = document.getElementById('voice-api-base-url');
  const voiceApiKeyInput = document.getElementById('voice-api-key');
  const voiceApiModelInput = document.getElementById('voice-api-model');
  const voiceApiLanguageInput = document.getElementById('voice-api-language');
  const voiceApiInputFormatInput = document.getElementById('voice-api-input-format');
  const btnSaveVoiceConfig = document.getElementById('btn-save-voice-config');
  const voiceVirtualMicroStatus = document.getElementById('voice-virtual-micro-status');
  const voiceVirtualMicroDetail = document.getElementById('voice-virtual-micro-detail');
  const btnConnectVirtualMicro = document.getElementById('btn-connect-virtual-micro');
  const btnTestVirtualMicroPtt = document.getElementById('btn-test-virtual-micro-ptt');
  const btnRefreshVirtualMicroDriver = document.getElementById('btn-refresh-virtual-micro-driver');
  const voiceVirtualMicroDriverStatus = document.getElementById('voice-virtual-micro-driver-status');
  const voiceMicroAudioSource = document.getElementById('voice-micro-audio-source');
  const voiceMicroAudioDevice = document.getElementById('voice-micro-audio-device');
  const voiceEsp32AudioPane = document.getElementById('voice-esp32-audio-pane');
  const voiceEsp32AudioDevicesStatus = document.getElementById('voice-esp32-audio-devices-status');
  const voiceEsp32AudioStatus = document.getElementById('voice-esp32-audio-status');
  const btnRefreshEsp32Audio = document.getElementById('btn-refresh-esp32-audio');
  let audioDeviceRefreshPending = false;
  let virtualMicroPttActive = false;
  let virtualMicroPttDeliveryState = null;
  let virtualMicroReadiness = {};
  let virtualMicroConnectPending = false;
  let latestSavedVoiceStatus = null;
  let virtualMicroDriverChecked = false;
  let virtualMicroDriverGeneration = 0;

  function showVirtualMicroDriverResult(result, fallbackError = '') {
    if (!voiceVirtualMicroDriverStatus) return;
    const formatter = window.VirtualMicroDriverStatus;
    voiceVirtualMicroDriverStatus.textContent = formatter
      ? formatter.describe(result, fallbackError)
      : `驱动状态检查失败。${fallbackError}`;
  }

  async function inspectVirtualMicroDriver() {
    if (!window.electronAPI || !window.electronAPI.getVirtualMicroDriverStatus) return;
    const generation = ++virtualMicroDriverGeneration;
    if (voiceVirtualMicroDriverStatus) voiceVirtualMicroDriverStatus.textContent = '正在检查驱动状态…';
    try {
      const response = await window.electronAPI.getVirtualMicroDriverStatus();
      if (generation !== virtualMicroDriverGeneration) return;
      showVirtualMicroDriverResult(response && response.result, response && response.error);
      virtualMicroDriverChecked = true;
    } catch (error) {
      if (generation !== virtualMicroDriverGeneration) return;
      showVirtualMicroDriverResult(null, `无法检查驱动：${error.message}`);
    }
  }

  function populateServiceConfig(config) {
    if (!config) return;
    if (serviceWsPortInput) serviceWsPortInput.value = config.wsPort || '';
    if (serviceHookPortInput) serviceHookPortInput.value = config.hookPort || '';
    if (serviceTokenInput) serviceTokenInput.value = config.token || '';
    if (serviceCollectorTypeInput) serviceCollectorTypeInput.value = config.collectorType || 'codex-hooks';
    if (serviceApprovalModeInput) serviceApprovalModeInput.value = config.approvalMode || 'intercept';
  }

  function setVoiceModePaneVisibility() {
    const apiMode = voiceModeInput && voiceModeInput.value === 'api';
    const virtualMicroMode = voiceModeInput && voiceModeInput.value === 'virtual_micro';
    if (voiceApiPane) voiceApiPane.classList.toggle('hidden', !apiMode);
    if (voiceVirtualMicroPane) voiceVirtualMicroPane.classList.toggle('hidden', !virtualMicroMode);
    if (virtualMicroMode && !virtualMicroDriverChecked) inspectVirtualMicroDriver();
    setAudioSourceVisibility();
  }

  function setAudioSourceVisibility() {
    if (voiceEsp32AudioPane) voiceEsp32AudioPane.classList.toggle('hidden', voiceMicroAudioSource && voiceMicroAudioSource.value === 'computer');
  }

  async function refreshEsp32AudioDevices() {
    if (audioDeviceRefreshPending || !window.electronAPI || !window.electronAPI.listEsp32AudioDevices) return;
    audioDeviceRefreshPending = true;
    if (btnRefreshEsp32Audio) btnRefreshEsp32Audio.disabled = true;
    try {
      const result = await window.electronAPI.listEsp32AudioDevices();
      if (!result || !result.success) throw new Error(result && result.error || '无法读取音频设备。');
      const devices = Array.isArray(result.devices) ? result.devices : [];
      if (voiceMicroAudioDevice) {
        const selected = voiceMicroAudioDevice.value;
        voiceMicroAudioDevice.replaceChildren(new Option('自动选择 VB-CABLE', ''));
        for (const device of devices) voiceMicroAudioDevice.appendChild(new Option(device.name, device.id));
        if (selected && !devices.some(device => device.id === selected)) {
          voiceMicroAudioDevice.appendChild(new Option('已保存的设备（当前不可用）', selected));
        }
        voiceMicroAudioDevice.value = selected;
      }
      if (voiceEsp32AudioDevicesStatus) voiceEsp32AudioDevicesStatus.textContent = devices.length
        ? '已检测到音频通道。Codex 麦克风选择对应的 CABLE Output 后保存。'
        : '未检测到 VB-CABLE。安装并刷新后，Codex 麦克风选择 CABLE Output。';
    } catch (error) {
      if (voiceEsp32AudioDevicesStatus) voiceEsp32AudioDevicesStatus.textContent = error.message;
    } finally {
      audioDeviceRefreshPending = false;
      if (btnRefreshEsp32Audio) btnRefreshEsp32Audio.disabled = false;
    }
  }

  function selectMicroStatus(status, mode, wrapper) {
    if (!status || typeof status !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(status, 'voiceMode')) {
      if (status.voiceMode === mode && status[wrapper] && typeof status[wrapper] === 'object') {
        return {
          configured: false,
          connected: false,
          microConnected: false,
          connecting: false,
          lastError: null,
          ...status[wrapper]
        };
      }
      // A complete service snapshot for another mode must clear prior ready
      // state rather than leave a stale Micro connection visible.
      return { configured: false, connected: false, microConnected: false, connecting: false, lastError: null };
    }
    if (Object.prototype.hasOwnProperty.call(status, 'mode')) {
      return status.mode === mode ? status : null;
    }
    // Mode-less values are local patches from an IPC action.
    return status;
  }

  function updateVirtualMicroStatus(status) {
    const incoming = selectMicroStatus(status, 'virtual_micro', 'voiceVirtualMicro');
    if (incoming && typeof incoming === 'object') virtualMicroReadiness = { ...virtualMicroReadiness, ...incoming };
    const virtualMicro = virtualMicroReadiness;
    if (!virtualMicro || !voiceVirtualMicroStatus) return;
    const checks = [
      `驱动：${virtualMicro.driverAvailable ? '已检测' : '未检测'}`,
      `HID：${virtualMicro.hidEnumerated ? '已枚举' : '未枚举'}`,
      `Micro RPC：${virtualMicro.microConnected ? '已握手' : '未握手'}`
    ];
    if (virtualMicro.connecting) {
      voiceVirtualMicroStatus.textContent = '正在连接 Micro（最多 75 秒）。';
    } else if (virtualMicro.lastError) {
      voiceVirtualMicroStatus.textContent = `连接未就绪：${virtualMicro.lastError}`;
    } else if (!virtualMicro.configured) {
      voiceVirtualMicroStatus.textContent = '请先保存语音设置。';
    } else if (virtualMicroPttDeliveryState === 'recording') {
      voiceVirtualMicroStatus.textContent = 'PTT 已按下（录音状态以 Codex 为准）。';
    } else if (virtualMicroPttDeliveryState === 'stopped') {
      voiceVirtualMicroStatus.textContent = 'PTT 已松开，请在 Codex 确认并发送。';
    } else if (virtualMicro.connected && virtualMicro.microConnected) {
      voiceVirtualMicroStatus.textContent = virtualMicro.audioSource === 'esp32'
        ? '已连接，请在 ESP32 上按住说话。' : '已连接，按住下方按钮说话。';
    } else {
      voiceVirtualMicroStatus.textContent = '尚未连接，请点击“检查并连接”。';
    }
    if (voiceVirtualMicroDetail) {
      const diagnostic = virtualMicro.handshakeDiagnostics;
      if (diagnostic && typeof diagnostic === 'object') {
        const phaseText = {
          starting: '开始检查',
          opening_transport: '初始化驱动连接',
          driver_or_hid_unavailable: '驱动或 HID 未就绪',
          awaiting_host_reports: '等待主机报告',
          awaiting_rpc_message: '等待完整 RPC 报文',
          awaiting_required_rpc: '所需 RPC 未齐',
          awaiting_response_acceptance: '等待响应确认',
          ready: '握手完成',
          failed: '本次检查失败'
        }[diagnostic.failurePhase || diagnostic.phase] || '检查中';
        const deviceStatus = diagnostic.deviceStatusSeen ? '设备状态已收到' : '设备状态未收到';
        const initialization = `初始化：版本${diagnostic.versionSeen ? '已收到' : '未收到'}、灯光${diagnostic.lightingSeen ? '已收到' : '未收到'}`;
        voiceVirtualMicroDetail.textContent = `上次检查：驱动${diagnostic.driverAvailable ? '可用' : '不可用'}/HID${diagnostic.hidEnumerated ? '已枚举' : '未枚举'}；${deviceStatus}；${initialization}；收到${Number(diagnostic.hostReports) || 0}报告，RPC 总数/已识别 ${Number(diagnostic.rpcRequests) || 0}/${Number(diagnostic.knownRequests) || 0}，已接受${Number(diagnostic.acceptedResponses) || 0}响应；${phaseText}`;
      } else {
        voiceVirtualMicroDetail.textContent = checks.join(' · ');
      }
    }
    if (btnTestVirtualMicroPtt) {
      btnTestVirtualMicroPtt.disabled = !virtualMicro.configured || !virtualMicro.connected
        || !virtualMicro.microConnected || Boolean(virtualMicro.connecting) || virtualMicro.audioSource === 'esp32';
      btnTestVirtualMicroPtt.title = virtualMicro.audioSource === 'esp32' ? '请使用 ESP32 上的按住说话按钮，以启动设备麦克风。' : '';
    }
    if (voiceEsp32AudioStatus) {
      const audio = virtualMicro.audioBridge || {};
      const packets = Number(audio.packets) || 0;
      const peak = Number(audio.peak) || 0;
      const text = audio.lastError ? `ESP32 音频：${audio.lastError}`
        : packets > 0 ? `ESP32 已传入 ${packets} 帧音频${peak > 0.001 ? '，已检测到声音' : '，当前音量很低'}。识别结果以 Codex 为准。`
        : audio.active ? '音频通道已打开，等待 ESP32 传入声音。'
        : '等待 ESP32 音频。';
      if (voiceEsp32AudioStatus.textContent !== text) voiceEsp32AudioStatus.textContent = text;
    }
    if (btnConnectVirtualMicro) btnConnectVirtualMicro.disabled = Boolean(virtualMicro.connecting || virtualMicroConnectPending);
  }

  function populateVoiceConfig(config) {
    if (!config) return;
    if (voiceModeInput) voiceModeInput.value = ['api', 'virtual_micro'].includes(config.mode) ? config.mode : 'virtual_micro';
    const api = config.api || {};
    if (voiceApiBaseUrlInput) voiceApiBaseUrlInput.value = api.baseUrl || 'https://api.openai.com/v1';
    if (voiceApiKeyInput) voiceApiKeyInput.value = api.apiKey || '';
    if (voiceApiModelInput) voiceApiModelInput.value = api.model || 'gpt-4o-transcribe';
    if (voiceApiLanguageInput) voiceApiLanguageInput.value = api.language || 'zh';
    if (voiceApiInputFormatInput) voiceApiInputFormatInput.value = api.inputFormat || 'opus';
    const virtualMicro = config.virtualMicro || {};
    if (voiceMicroAudioSource) voiceMicroAudioSource.value = virtualMicro.audioSource || 'esp32';
    if (voiceMicroAudioDevice) {
      const deviceId = virtualMicro.audioDeviceId || '';
      if (deviceId && !Array.from(voiceMicroAudioDevice.options).some(option => option.value === deviceId)) {
        voiceMicroAudioDevice.appendChild(new Option('已保存的音频设备', deviceId));
      }
      voiceMicroAudioDevice.value = deviceId;
    }
    updateVirtualMicroStatus({
      ...virtualMicro,
      configured: config.mode === 'virtual_micro'
    });
    setVoiceModePaneVisibility();
    void refreshEsp32AudioDevices();
  }

  function collectVoiceConfig() {
    return {
      mode: voiceModeInput && ['api', 'virtual_micro'].includes(voiceModeInput.value) ? voiceModeInput.value : 'virtual_micro',
      api: {
        baseUrl: voiceApiBaseUrlInput ? voiceApiBaseUrlInput.value.trim() : '',
        apiKey: voiceApiKeyInput ? voiceApiKeyInput.value : '',
        model: voiceApiModelInput ? voiceApiModelInput.value.trim() : '',
        language: voiceApiLanguageInput ? voiceApiLanguageInput.value.trim() : '',
        inputFormat: voiceApiInputFormatInput ? voiceApiInputFormatInput.value : 'opus'
      },
      virtualMicro: {
        profile: 'codex-micro-v1',
        audioSource: voiceMicroAudioSource ? voiceMicroAudioSource.value : 'esp32',
        audioDeviceId: voiceMicroAudioDevice ? voiceMicroAudioDevice.value : ''
      }
    };
  }

  function updateCodexHookInstallUI(status) {
    if (!status) return;
    if (codexHookInstallStatus) {
      if (status.state === 'error') {
        codexHookInstallStatus.textContent = '安装失败';
        codexHookInstallStatus.className = 'font-body-sm text-body-sm text-error';
      } else if (status.needsTrustReview) {
        codexHookInstallStatus.textContent = '已安装 · 等待 Codex 事件';
        codexHookInstallStatus.className = 'font-body-sm text-body-sm text-warning';
      } else if (status.trust === 'observed') {
        codexHookInstallStatus.textContent = '已验证 · 正在接收事件';
        codexHookInstallStatus.className = 'font-body-sm text-body-sm text-success';
      } else {
        codexHookInstallStatus.textContent = '已就绪';
        codexHookInstallStatus.className = 'font-body-sm text-body-sm text-success';
      }
    }
    if (codexHookInstallPath) {
      codexHookInstallPath.textContent = status.error || status.configPath || '';
    }
  }

  if (window.electronAPI && window.electronAPI.getServiceConfig) {
    window.electronAPI.getServiceConfig().then(populateServiceConfig).catch(console.error);
  }

  if (window.electronAPI && window.electronAPI.getVoiceConfig) {
    window.electronAPI.getVoiceConfig().then(populateVoiceConfig).catch(console.error);
  }

  if (voiceModeInput) {
    voiceModeInput.addEventListener('change', async () => {
      // Keep the current panel visible until its PTT release has been sent.
      await setVirtualMicroTestPtt(false);
      setVoiceModePaneVisibility();
    });
  }

  if (voiceMicroAudioSource) voiceMicroAudioSource.addEventListener('change', setAudioSourceVisibility);
  if (btnRefreshEsp32Audio) btnRefreshEsp32Audio.addEventListener('click', refreshEsp32AudioDevices);

  async function connectVirtualMicro() {
    if (!window.electronAPI || !window.electronAPI.connectVirtualMicro || virtualMicroConnectPending) return;
    virtualMicroConnectPending = true;
    let connectionStatus = null;
    if (btnConnectVirtualMicro) btnConnectVirtualMicro.disabled = true;
    if (metricStt) metricStt.disabled = true;
    updateVirtualMicroStatus({ connecting: true, lastError: null });
    try {
      const result = await window.electronAPI.connectVirtualMicro();
      connectionStatus = result && result.status;
      updateVirtualMicroStatus({ ...(result && result.status), connecting: false });
      if (!result || !result.success) throw new Error(result && result.error ? result.error : '无法连接虚拟 Codex Micro。');
    } catch (error) {
      updateVirtualMicroStatus({ connecting: false, lastError: error.message });
    } finally {
      virtualMicroConnectPending = false;
      updateVirtualMicroStatus({ connecting: false });
      const responseMode = connectionStatus && connectionStatus.mode;
      const voiceMode = responseMode === 'api' || responseMode === 'virtual_micro'
        ? responseMode
        : latestSavedVoiceStatus && latestSavedVoiceStatus.voiceMode || 'virtual_micro';
      const voiceApiConfigured = voiceMode === 'api'
        ? Boolean(responseMode === 'api' ? connectionStatus.configured : latestSavedVoiceStatus && latestSavedVoiceStatus.voiceApiConfigured)
        : false;
      if (btnConnectVirtualMicro) btnConnectVirtualMicro.disabled = Boolean(virtualMicroReadiness.connecting || voiceMode === 'api');
      updateVoiceInputMetric({ voiceMode, voiceApiConfigured, voiceVirtualMicro: virtualMicroReadiness });
    }
  }

  if (btnConnectVirtualMicro && window.electronAPI && window.electronAPI.connectVirtualMicro) {
    btnConnectVirtualMicro.addEventListener('click', connectVirtualMicro);
  }

  if (btnRefreshVirtualMicroDriver) btnRefreshVirtualMicroDriver.addEventListener('click', inspectVirtualMicroDriver);

  async function setVirtualMicroTestPtt(active) {
    if (!btnTestVirtualMicroPtt || virtualMicroPttActive === active || !window.electronAPI || !window.electronAPI.testVirtualMicroPtt) return;
    if (active && btnTestVirtualMicroPtt.disabled) return;
    virtualMicroPttActive = active;
    btnTestVirtualMicroPtt.textContent = active ? '松开以停止 PTT' : '按住说话';
    try {
      const result = await window.electronAPI.testVirtualMicroPtt(active);
      if (!result || !result.success) throw new Error(result && result.error ? result.error : 'PTT 测试失败。');
    } catch (error) {
      virtualMicroPttActive = false;
      btnTestVirtualMicroPtt.textContent = '按住说话';
      updateVirtualMicroStatus({ lastError: error.message });
    }
  }

  if (btnTestVirtualMicroPtt) {
    btnTestVirtualMicroPtt.textContent = '按住说话';
    btnTestVirtualMicroPtt.addEventListener('pointerdown', (event) => {
      if (btnTestVirtualMicroPtt.disabled) return;
      event.preventDefault();
      btnTestVirtualMicroPtt.setPointerCapture(event.pointerId);
      setVirtualMicroTestPtt(true);
    });
    btnTestVirtualMicroPtt.addEventListener('lostpointercapture', () => setVirtualMicroTestPtt(false));
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => {
      btnTestVirtualMicroPtt.addEventListener(eventName, () => setVirtualMicroTestPtt(false));
    });
    btnTestVirtualMicroPtt.addEventListener('keydown', (event) => {
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
        event.preventDefault();
        setVirtualMicroTestPtt(true);
      }
    });
    btnTestVirtualMicroPtt.addEventListener('keyup', (event) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        setVirtualMicroTestPtt(false);
      }
    });
    window.addEventListener('blur', () => setVirtualMicroTestPtt(false));
  }

  if (btnSaveVoiceConfig && window.electronAPI && window.electronAPI.saveVoiceConfig) {
    btnSaveVoiceConfig.addEventListener('click', async () => {
      btnSaveVoiceConfig.disabled = true;
      try {
        const result = await window.electronAPI.saveVoiceConfig(collectVoiceConfig());
        if (!result || !result.success) {
          throw new Error(result && result.error ? result.error : '语音设置保存失败。');
        }
        populateVoiceConfig(result.config);
        showNotice({ title: '语音设置已保存', message: '所选语音输入方式和参数已应用。' });
      } catch (error) {
        showNotice({
          title: '语音设置保存失败',
          message: error && error.message ? error.message : '无法保存语音设置。',
          type: 'error',
          duration: 7000
        });
      } finally {
        btnSaveVoiceConfig.disabled = false;
      }
    });
  }

  if (btnRestartServices && window.electronAPI && window.electronAPI.restartServices) {
    btnRestartServices.addEventListener('click', async () => {
      const config = {
        wsPort: Number(serviceWsPortInput ? serviceWsPortInput.value : 0),
        hookPort: Number(serviceHookPortInput ? serviceHookPortInput.value : 0),
        token: serviceTokenInput ? serviceTokenInput.value.trim() : '',
        collectorType: serviceCollectorTypeInput ? serviceCollectorTypeInput.value : 'codex-hooks',
        approvalMode: serviceApprovalModeInput ? serviceApprovalModeInput.value : 'intercept'
      };

      btnRestartServices.disabled = true;
      if (serviceRestartIcon) serviceRestartIcon.classList.add('is-spinning');
      if (serviceConfigStatus) serviceConfigStatus.textContent = '正在保存配置并重启服务...';

      try {
        const result = await window.electronAPI.restartServices(config);
        if (result && result.success) {
          populateServiceConfig(result.config);
          addActivityItem('服务配置', `服务已重启，WebSocket 端口为 ${result.config.wsPort}`);
          showNotice({
            title: '服务已重启',
            message: '端口和 Agent 事件采集器配置已应用。'
          });
        } else {
          const currentConfig = await window.electronAPI.getServiceConfig();
          populateServiceConfig(currentConfig);
          showNotice({
            title: '重启失败',
            message: result && result.error ? result.error : '服务未能启动，请检查配置。',
            type: 'error',
            duration: 7000
          });
        }
      } catch (error) {
        showNotice({
          title: '重启失败',
          message: error && error.message ? error.message : '无法重启服务，请稍后重试。',
          type: 'error',
          duration: 7000
        });
      } finally {
        btnRestartServices.disabled = false;
        if (serviceRestartIcon) serviceRestartIcon.classList.remove('is-spinning');
      }
    });
  }

  if (btnGenerateServiceToken && window.electronAPI && window.electronAPI.generateServiceToken) {
    btnGenerateServiceToken.addEventListener('click', async () => {
      try {
        const token = await window.electronAPI.generateServiceToken();
        if (typeof token !== 'string' || !token) throw new Error('Token generation failed.');
        if (serviceTokenInput) serviceTokenInput.value = token;
        serviceTokenInput?.focus();
        serviceTokenInput?.select();
      } catch (error) {
        showNotice({ title: 'Token generation failed', message: error.message, type: 'error' });
      }
    });
  }

  if (btnRepairCodexHooks && window.electronAPI && window.electronAPI.repairCodexHooks) {
    btnRepairCodexHooks.addEventListener('click', async () => {
      btnRepairCodexHooks.disabled = true;
      try {
        const result = await window.electronAPI.repairCodexHooks();
        updateCodexHookInstallUI(result.status);
        showNotice({
          title: result.success ? 'Hook 已修复' : 'Hook 修复失败',
          message: result.success
            ? '配置已安装。请重启 Codex，并在 Hooks 页面审核/信任命令。'
            : result.error,
          type: result.success ? 'success' : 'error',
          duration: 7000
        });
      } catch (error) {
        showNotice({
          title: 'Hook 修复失败',
          message: error && error.message ? error.message : '无法修复 Codex Hook。',
          type: 'error',
          duration: 7000
        });
      } finally {
        btnRepairCodexHooks.disabled = false;
      }
    });
  }

  const labVoiceStatus = null;
  // Dashboard Status Elements
  const statusDotHero = document.getElementById('status-dot-hero');
  const statusTextHero = document.getElementById('status-text-hero');
  const deviceNameHero = document.getElementById('device-name-hero');
  const heroPortLabel = document.getElementById('hero-port-label');
  const metricWsPort = document.getElementById('metric-ws-port');
  const metricCodex = document.getElementById('metric-codex-status');
  const metricStt = document.getElementById('metric-stt-status');
  const activityList = document.getElementById('activity-list');
  const activityCount = document.getElementById('activity-count');

  // Logs Elements
  const logTerminal = document.getElementById('log-terminal-apple');
  const filterPills = document.querySelectorAll('.pill-item');
  const btnClearLogs = document.getElementById('btn-clear-logs-apple');

  let logsList = [];
  let activeLogFilter = 'all';
  let totalActivityCount = 1;

  // Initial status load via IPC
  if (window.electronAPI) {
    window.electronAPI.getStatus().then(status => {
      if (status) {
        updateStatusUI(status);
        if (status.logs) {
          logsList = status.logs.slice();
          logsList.forEach(l => addLogEntry(l));
        }
      }
    }).catch(console.error);

    window.electronAPI.onStatusUpdate((status) => {
      updateStatusUI(status);
    });

    window.electronAPI.onDeviceConnected((address) => {
      setConnectedState(true, address);
      addActivityItem('设备连接', `已关联遥控终端：${address}`);
    });

    window.electronAPI.onDeviceDisconnected(() => {
      setConnectedState(false);
      addActivityItem('设备连接', '遥控终端已断开');
    });

    window.electronAPI.onVoiceStatus((voiceStatus) => {
      if (!voiceStatus) return;
      const modeLabel = voiceStatus.mode === 'api' ? 'API 转写' : '虚拟 Codex Micro';
      if (voiceStatus.status === 'preparing') {
        if (labVoiceStatus) labVoiceStatus.textContent = `${modeLabel} 正在准备`;
      } else if (voiceStatus.status === 'recording') {
        if (voiceStatus.mode === 'virtual_micro') {
          virtualMicroPttDeliveryState = 'recording';
          if (voiceVirtualMicroStatus) voiceVirtualMicroStatus.textContent = 'PTT 已按下（录音状态以 Codex 为准）。';
        }
        if (labVoiceStatus) labVoiceStatus.textContent = voiceStatus.mode === 'virtual_micro'
          ? 'PTT 已按下（录音状态以 Codex 为准）'
          : `${modeLabel} 录音中`;
      } else if (voiceStatus.status === 'submitting') {
        if (labVoiceStatus) labVoiceStatus.textContent = `${modeLabel} 正在提交`;
      } else if (voiceStatus.status === 'recognizing') {
        if (labVoiceStatus) labVoiceStatus.textContent = `${modeLabel} 正在转写`;
      } else if (voiceStatus.status === 'submitted') {
        if (labVoiceStatus) labVoiceStatus.textContent = `${modeLabel} 已提交`;
      } else if (voiceStatus.status === 'stopped') {
        if (voiceStatus.mode === 'virtual_micro') {
          virtualMicroPttActive = false;
          virtualMicroPttDeliveryState = 'stopped';
          if (btnTestVirtualMicroPtt) btnTestVirtualMicroPtt.textContent = '按住说话';
          if (voiceVirtualMicroStatus) voiceVirtualMicroStatus.textContent = 'PTT 已松开，请在 Codex 确认并发送。';
        }
        if (labVoiceStatus) labVoiceStatus.textContent = '录音已停止，请在 Codex 确认并发送';
      } else if (voiceStatus.status === 'idle') {
        if (labVoiceStatus) labVoiceStatus.textContent = '等待语音输入';
      } else if (voiceStatus.status === 'error') {
        if (voiceStatus.mode === 'virtual_micro') {
          virtualMicroPttActive = false;
          virtualMicroPttDeliveryState = null;
          virtualMicroReadiness = { ...virtualMicroReadiness, active: false, lastError: voiceStatus.message || virtualMicroReadiness.lastError };
          if (btnTestVirtualMicroPtt) btnTestVirtualMicroPtt.textContent = '按住说话';
        }
        if (labVoiceStatus) labVoiceStatus.textContent = voiceStatus.message || `${modeLabel} 处理失败`;
      }
    });

    window.electronAPI.onDeviceMessage((msg) => {
      addDeviceTraffic('esp-to-pc', msg, { success: true });
      if (msg.type === 'device_battery') return;
      if (msg.type === 'text_input') {
        addActivityItem('指令接收', `收到指令：“${msg.text}”`);
      } else if (msg.type === 'voice_start') {
        addActivityItem('语音输入', '开始语音输入');
      } else if (msg.type === 'voice_end') {
        addActivityItem('语音输入', '结束语音输入');
      } else if (msg.type === 'voice_recognized') {
        addActivityItem('API 转写', compactActivityText(msg.text || '已返回转写文字'));
      } else {
        addActivityItem('设备消息', summarizeMessage(msg));
      }
    });

    if (window.electronAPI.onDeviceOutbound) {
      window.electronAPI.onDeviceOutbound((delivery) => {
        if (!delivery) return;
        addDeviceTraffic('pc-to-esp', delivery.message, delivery);
      });
    }

    window.electronAPI.onAgentMessage((msg) => {
      if (msg.type === 'status') {
        addActivityItem('Codex 状态', msg.state || 'unknown');
      } else if (msg.type === 'approval_request') {
        addActivityItem('操作确认', msg.question || '待授权审批操作');
        if (msg.blocking !== false) showApprovalNotice(msg);
      } else if (msg.type === 'tool_call') {
        dismissApprovalNotices();
        addActivityItem('工具调用', formatToolActivity(msg));
      } else if (msg.type === 'tool_result') {
        dismissApprovalNotices();
        addActivityItem('工具完成', formatToolActivity(msg));
      } else if (msg.type === 'chat') {
        const text = compactActivityText(msg.text || msg.message || '消息内容为空');
        addActivityItem(msg.role === 'user' ? '用户消息' : 'Codex 消息', text);
      } else if (msg.type === 'stop') {
        dismissApprovalNotices();
        addActivityItem('任务完成', compactActivityText(msg.text || msg.message || 'Codex 已完成当前任务'));
      } else {
        addActivityItem('Codex 事件', summarizeMessage(msg));
      }
    });

    window.electronAPI.onLog((logItem) => {
      logsList.push(logItem);
      addLogEntry(logItem);
    });
  }

  // Update Status UI
  function updateStatusUI(status) {
    updateCodexHookInstallUI(status.codexHook);
    if (status.connectedDevice) {
      setConnectedState(true, status.connectedDevice);
    } else {
      setConnectedState(false);
    }
    updateLabDeviceConnection(status.connectedDevice);

    const lanAddresses = Array.isArray(status.lanAddresses) ? status.lanAddresses : [];
    const primaryLanAddress = lanAddresses[0] || '';
    const connectionLabel = primaryLanAddress && status.wsPort
      ? `${primaryLanAddress}:${status.wsPort}`
      : status.wsPort
        ? `未检测到局域网 IP · 端口 ${status.wsPort}`
        : '服务未启动';
    if (heroPortLabel) {
      const connectionTitle = lanAddresses.length > 1
        ? `本机局域网地址：${lanAddresses.map((address) => `${address}:${status.wsPort}`).join('、')}`
        : connectionLabel;
      if (heroPortLabel.textContent !== connectionLabel) heroPortLabel.textContent = connectionLabel;
      if (heroPortLabel.title !== connectionTitle) heroPortLabel.title = connectionTitle;
    }
    if (metricWsPort) {
      const metricTitle = heroPortLabel ? heroPortLabel.title : connectionLabel;
      if (metricWsPort.textContent !== connectionLabel) metricWsPort.textContent = connectionLabel;
      if (metricWsPort.title !== metricTitle) metricWsPort.title = metricTitle;
    }

    const desktopControl = status.desktopControl || {};
    const desktopAvailable = Boolean(desktopControl.available);
    setMetricState(metricCodex, status.isRestartingServices
      ? { icon: 'progress_activity', label: '正在重启', tone: 'neutral' }
      : desktopAvailable
        ? { icon: 'check_circle', label: 'Codex 已连接', tone: 'success' }
        : { icon: 'error', label: desktopControl.supported ? '等待 Codex 连接' : '仅支持 Windows', tone: 'neutral' });

    if (serviceConfigStatus) {
      if (status.isRestartingServices) {
        serviceConfigStatus.textContent = '正在重启后台服务...';
      } else if (status.isWsServerRunning && status.isCodexBridgeRunning) {
        const desktopStatusLabel = desktopAvailable
          ? 'Codex 已连接'
          : '等待 Codex 连接';
        serviceConfigStatus.textContent = `服务运行中 · 设备 WebSocket ${status.wsPort} · ${desktopStatusLabel}`;
      } else {
        serviceConfigStatus.textContent = '部分服务未运行，请检查系统日志。';
      }
    }

    if (status && (status.voiceMode === 'api' || status.voiceMode === 'virtual_micro')) {
      latestSavedVoiceStatus = {
        voiceMode: status.voiceMode,
        voiceApiConfigured: Boolean(status.voiceApiConfigured)
      };
    }
    updateVoiceInputMetric(status);
    updateVirtualMicroStatus(status);
  }

  function updateVoiceInputMetric(status) {
    if (!metricStt) return;
    const micro = status.voiceVirtualMicro || {};
    const isApi = status.voiceMode === 'api';
    const canRetry = !isApi && !micro.connected && !micro.connecting;
    const voiceLabel = isApi
      ? 'API 转写' + (status.voiceApiConfigured ? '' : '（未配置密钥）')
      : '虚拟 Codex Micro' + (micro.connected ? ' · 已连接' : micro.connecting ? ' · 连接中' : ' · 未就绪 · 点击重试');
    metricStt.disabled = !canRetry;
    metricStt.title = canRetry ? '未就绪，点击重试连接虚拟 Codex Micro' : '';
    metricStt.setAttribute('aria-label', canRetry ? '虚拟 Codex Micro 未就绪，点击重试连接' : voiceLabel);
    setMetricState(metricStt, { icon: isApi ? 'cloud' : 'mic', label: voiceLabel,
      tone: (isApi ? !status.voiceApiConfigured : !micro.connected) ? 'warning' : 'primary' });
  }

  function bindVoiceInputRetry() {
    if (!metricStt) return;
    metricStt.addEventListener('click', () => {
      if (!metricStt.disabled) void connectVirtualMicro();
    });
  }

  bindVoiceInputRetry();

  function setMetricState(element, { icon, label, tone }) {
    if (!element) return;
    const toneClass = ['success', 'neutral', 'primary', 'info', 'warning'].includes(tone) ? tone : 'neutral';
    const stateKey = `${icon}\u0000${label}\u0000${toneClass}`;
    if (element.dataset.metricState === stateKey) return;
    element.dataset.metricState = stateKey;
    const className = `status-chip is-${toneClass}`;
    if (element.className !== className) element.className = className;
    element.replaceChildren();

    const iconElement = document.createElement('span');
    iconElement.className = 'material-symbols-outlined text-[14px]';
    iconElement.setAttribute('aria-hidden', 'true');
    iconElement.textContent = icon;
    element.append(iconElement, document.createTextNode(label));
    element.classList.remove('is-updating');
    void element.offsetWidth;
    element.classList.add('is-updating');
  }

  function setConnectedState(isConnected, address = '') {
    const dotClassName = isConnected
      ? 'w-2.5 h-2.5 rounded-full bg-success status-dot-pulse'
      : 'w-2.5 h-2.5 rounded-full bg-outline';
    const statusText = isConnected ? `已连接 · ${address}` : '等待硬件设备连接...';
    const deviceName = isConnected ? `终端 ${address}` : '未绑定遥控终端';
    if (isConnected) {
      if (statusDotHero) {
        if (statusDotHero.className !== dotClassName) statusDotHero.className = dotClassName;
      }
      if (statusTextHero && statusTextHero.textContent !== statusText) statusTextHero.textContent = statusText;
      if (deviceNameHero && deviceNameHero.textContent !== deviceName) deviceNameHero.textContent = deviceName;
    } else {
      if (statusDotHero) {
        if (statusDotHero.className !== dotClassName) statusDotHero.className = dotClassName;
      }
      if (statusTextHero && statusTextHero.textContent !== statusText) statusTextHero.textContent = statusText;
      if (deviceNameHero && deviceNameHero.textContent !== deviceName) deviceNameHero.textContent = deviceName;
    }
  }

  function addActivityItem(title, text) {
    if (!activityList) return;
    totalActivityCount++;
    if (activityCount) activityCount.textContent = `共 ${totalActivityCount} 条记录`;

    const item = document.createElement('div');
    item.className = 'activity-item';
    item.innerHTML = `
      <span class="min-w-0 break-words"><strong class="font-medium">[${escapeHtml(title)}]</strong> ${escapeHtml(text)}</span>
      <span class="font-label-mono text-caption-mono text-on-surface-variant shrink-0">${new Date().toLocaleTimeString()}</span>
    `;
    activityList.prepend(item);
    if (activityList.children.length > 20) {
      activityList.removeChild(activityList.lastChild);
    }
  }

  function summarizeMessage(message) {
    if (!message || typeof message !== 'object') {
      return compactActivityText(message || '收到空消息');
    }

    const detail = message.text
      || message.message
      || message.question
      || message.description
      || message.state;
    if (detail) return compactActivityText(detail);
    return compactActivityText(message.type ? `收到 ${message.type} 消息` : '消息已收到');
  }

  function compactActivityText(value, maxLength = 120) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3).trimEnd()}...`;
  }

  function formatToolActivity(message) {
    const toolName = message.tool_name || 'unknown';
    const description = compactActivityText(message.description || '未提供操作详情');
    return `${toolName} · ${description}`;
  }

  function showApprovalNotice(message) {
    const options = Array.isArray(message.options) ? message.options : [];
    const actions = options
      .filter((option) => option && option.id)
      .map((option) => ({
        label: option.label || option.id,
        onClick: () => window.electronAPI.sendApproval(message.id, option.id)
      }));
    showNotice({
      title: 'Codex 操作审批',
      message: message.question || '是否允许此操作？',
      type: 'warning',
      duration: 0,
      noticeKey: `approval:${message.id}`,
      actions
    });
  }

  function dismissApprovalNotices() {
    if (!noticeStack) return;
    noticeStack.querySelectorAll('[data-notice-key^="approval:"]').forEach((notice) => notice.remove());
  }

  // ESP32 protocol debugger
  const simVoiceStart = document.getElementById('sim-voice-start');
  const simVoiceEnd = document.getElementById('sim-voice-end');
  const simTextInput = document.getElementById('sim-text-input');
  const simTurnStop = document.getElementById('sim-turn-stop');
  const simNewTask = document.getElementById('sim-new-task');
  const simStatusIdle = document.getElementById('sim-status-idle');
  const simStatusWorking = document.getElementById('sim-status-working');
  const simStatusStop = document.getElementById('sim-status-stop');
  const labPcToEspMessage = document.getElementById('lab-pc-to-esp-message');
  const labEspToPcMessage = document.getElementById('lab-esp-to-pc-message');
  const btnSendDeviceMessage = document.getElementById('btn-send-device-message');
  const btnInjectDeviceMessage = document.getElementById('btn-inject-device-message');
  const btnClearDeviceTraffic = document.getElementById('btn-clear-device-traffic');
  const labDeviceSendStatus = document.getElementById('lab-device-send-status');
  const labDeviceReceiveStatus = document.getElementById('lab-device-receive-status');
  const labDeviceConnection = document.getElementById('lab-device-connection');
  const labDeviceTraffic = document.getElementById('lab-device-traffic');
  const labDeviceTrafficEmpty = document.getElementById('lab-device-traffic-empty');

  function parseDebugMessage(value) {
    const message = JSON.parse(value);
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('消息必须是 JSON 对象');
    }
    if (typeof message.type !== 'string' || !message.type.trim()) {
      throw new Error('消息必须包含非空 type');
    }
    return message;
  }

  function setDebugMessage(input, message) {
    if (input) input.value = JSON.stringify(message, null, 2);
  }

  async function sendDebugMessageToEsp(message) {
    if (!window.electronAPI || !window.electronAPI.sendDeviceMsg) return;
    if (labDeviceSendStatus) labDeviceSendStatus.textContent = '正在发送...';
    if (btnSendDeviceMessage) btnSendDeviceMessage.disabled = true;
    try {
      const result = await window.electronAPI.sendDeviceMsg(message);
      if (labDeviceSendStatus) {
        labDeviceSendStatus.textContent = result && result.success
          ? `已发送 · ${message.type} · ${result.delivery.durationMs} ms`
          : (result && result.error ? result.error : '发送失败');
      }
    } catch (error) {
      if (labDeviceSendStatus) labDeviceSendStatus.textContent = error.message || '发送失败';
    } finally {
      if (btnSendDeviceMessage) btnSendDeviceMessage.disabled = false;
    }
  }

  async function injectDebugMessageFromEsp(message) {
    if (!window.electronAPI || !window.electronAPI.simulateDeviceMsg) return;
    if (labDeviceReceiveStatus) labDeviceReceiveStatus.textContent = '正在注入...';
    if (btnInjectDeviceMessage) btnInjectDeviceMessage.disabled = true;
    try {
      const result = await window.electronAPI.simulateDeviceMsg(message);
      if (labDeviceReceiveStatus) {
        labDeviceReceiveStatus.textContent = result && result.success
          ? `PC 已接收 · ${message.type}`
          : (result && result.error ? result.error : '注入失败');
      }
    } catch (error) {
      if (labDeviceReceiveStatus) labDeviceReceiveStatus.textContent = error.message || '注入失败';
    } finally {
      if (btnInjectDeviceMessage) btnInjectDeviceMessage.disabled = false;
    }
  }

  function bindDownlinkPreset(button, message) {
    if (!button) return;
    button.addEventListener('click', () => {
      setDebugMessage(labPcToEspMessage, message);
      sendDebugMessageToEsp(message);
    });
  }

  function bindUplinkPreset(button, createMessage) {
    if (!button) return;
    button.addEventListener('click', () => {
      const message = createMessage();
      setDebugMessage(labEspToPcMessage, message);
      injectDebugMessageFromEsp(message);
    });
  }

  bindDownlinkPreset(simStatusIdle, { type: 'status', state: 'idle' });
  bindDownlinkPreset(simStatusWorking, { type: 'status', state: 'working' });
  bindDownlinkPreset(simStatusStop, { type: 'stop', state: 'completed', text: '' });
  bindUplinkPreset(simVoiceStart, () => ({ type: 'voice_start' }));
  bindUplinkPreset(simVoiceEnd, () => ({ type: 'voice_end' }));
  bindUplinkPreset(simTextInput, () => ({
    type: 'text_input',
    requestId: `lab-${Date.now()}`,
    text: 'ESP32 模拟文本消息'
  }));
  bindUplinkPreset(simTurnStop, () => ({ type: 'turn_stop', requestId: `lab-${Date.now()}` }));
  bindUplinkPreset(simNewTask, () => ({ type: 'task_new', requestId: `lab-${Date.now()}` }));

  if (btnSendDeviceMessage) {
    btnSendDeviceMessage.addEventListener('click', () => {
      try {
        sendDebugMessageToEsp(parseDebugMessage(labPcToEspMessage ? labPcToEspMessage.value : ''));
      } catch (error) {
        if (labDeviceSendStatus) labDeviceSendStatus.textContent = error.message || 'JSON 格式错误';
      }
    });
  }

  if (btnInjectDeviceMessage) {
    btnInjectDeviceMessage.addEventListener('click', () => {
      try {
        injectDebugMessageFromEsp(parseDebugMessage(labEspToPcMessage ? labEspToPcMessage.value : ''));
      } catch (error) {
        if (labDeviceReceiveStatus) labDeviceReceiveStatus.textContent = error.message || 'JSON 格式错误';
      }
    });
  }

  if (btnClearDeviceTraffic) {
    btnClearDeviceTraffic.addEventListener('click', () => {
      if (!labDeviceTraffic) return;
      labDeviceTraffic.replaceChildren();
      const empty = document.createElement('p');
      empty.id = 'lab-device-traffic-empty';
      empty.className = 'font-body-sm text-body-sm text-on-surface-variant';
      empty.textContent = '暂无协议消息';
      labDeviceTraffic.appendChild(empty);
    });
  }

  function updateLabDeviceConnection(address) {
    if (!labDeviceConnection) return;
    const className = `status-chip ${address ? 'is-success' : 'is-neutral'}`;
    const labelText = address ? `ESP32 ${address}` : 'ESP32 未连接';
    const iconText = address ? 'link' : 'link_off';
    const stateKey = `${className}\u0000${iconText}\u0000${labelText}`;
    if (labDeviceConnection.dataset.connectionState === stateKey) return;
    labDeviceConnection.dataset.connectionState = stateKey;
    if (labDeviceConnection.className !== className) labDeviceConnection.className = className;
    labDeviceConnection.replaceChildren();
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined text-[14px]';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = iconText;
    const label = document.createElement('span');
    label.textContent = labelText;
    labDeviceConnection.append(icon, label);
  }

  function addDeviceTraffic(direction, message, delivery = {}) {
    if (!labDeviceTraffic) return;
    const empty = document.getElementById('lab-device-traffic-empty');
    if (empty) empty.remove();

    const existingRow = delivery.sendId
      ? Array.from(labDeviceTraffic.children).find((child) => child.dataset.sendId === delivery.sendId)
      : null;
    const row = existingRow || document.createElement('div');
    if (delivery.sendId) row.dataset.sendId = delivery.sendId;
    row.className = 'rounded-lg border border-outline-variant/40 bg-surface-container-low p-3 space-y-1';
    row.replaceChildren();
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between gap-3';
    const directionLabel = document.createElement('span');
    directionLabel.className = `font-body-sm text-body-sm font-semibold ${direction === 'pc-to-esp' ? 'text-primary' : 'text-on-success-container'}`;
    directionLabel.textContent = direction === 'pc-to-esp' ? 'PC → ESP32' : 'ESP32 → PC';
    const meta = document.createElement('span');
    const isSending = delivery.phase === 'sending';
    const isFailure = delivery.success === false || delivery.level === 'error';
    meta.className = `font-body-sm text-body-sm ${isFailure ? 'text-error' : isSending ? 'text-warning' : 'text-on-surface-variant'}`;
    if (isSending) {
      meta.textContent = `发送中 · ${delivery.bytes || 0} B`;
    } else if (delivery.phase === 'completed') {
      meta.textContent = `已发送 · ${delivery.bytes || 0} B · ${delivery.durationMs} ms`;
    } else if (delivery.phase === 'timeout') {
      meta.textContent = `发送超时 · ${delivery.durationMs} ms`;
    } else if (delivery.phase === 'failed') {
      meta.textContent = `发送失败 · ${delivery.durationMs || 0} ms`;
    } else {
      meta.textContent = new Date(delivery.timestamp || Date.now()).toLocaleTimeString();
    }
    const payload = document.createElement('pre');
    payload.className = 'font-caption-mono text-caption-mono text-on-surface whitespace-pre-wrap break-all';
    payload.textContent = typeof message === 'string' ? message : JSON.stringify(message, null, 2);
    header.append(directionLabel, meta);
    row.append(header, payload);
    if (!existingRow) labDeviceTraffic.prepend(row);
    while (labDeviceTraffic.children.length > 50) labDeviceTraffic.lastChild.remove();
  }

  // Logs Console Subtab Logic
  function addLogEntry(logItem) {
    if (!logTerminal) return;
    if (activeLogFilter !== 'all' && logItem.level !== activeLogFilter) return;

    const sourceLabels = {
      Main: '主程序',
      UI: '界面',
      WS: 'WebSocket',
      Device: '设备',
      Voice: '语音',
      Lab: '模拟器'
    };
    const sourceLabel = sourceLabels[logItem.source] || logItem.source;
    const row = document.createElement('div');
    row.className = 'flex gap-2 font-caption-mono text-caption-mono';
    row.innerHTML = `
      <span class="text-outline-variant">[${escapeHtml(logItem.time)}]</span>
      <span class="text-inverse-on-surface font-semibold">[${escapeHtml(sourceLabel)}]</span>
      <span class="${logItem.level === 'error' ? 'text-error-container' : logItem.level === 'warning' ? 'text-warning-container' : logItem.level === 'success' ? 'text-success-container' : 'text-inverse-on-surface'}">${escapeHtml(logItem.message)}</span>
    `;
    logTerminal.appendChild(row);
    logTerminal.scrollTop = logTerminal.scrollHeight;
  }

  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => {
        p.classList.remove('bg-primary', 'text-on-primary');
        p.classList.add('bg-surface-container-high', 'text-on-surface-variant');
      });
      pill.classList.add('bg-primary', 'text-on-primary');
      pill.classList.remove('bg-surface-container-high', 'text-on-surface-variant');

      activeLogFilter = pill.getAttribute('data-filter');
      logTerminal.innerHTML = '';
      logsList.forEach(l => addLogEntry(l));
    });
  });

  if (btnClearLogs) {
    btnClearLogs.addEventListener('click', () => {
      logsList = [];
      logTerminal.innerHTML = '';
    });
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return String(str);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
});
