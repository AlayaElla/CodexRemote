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
  const voiceNativePane = document.getElementById('voice-native-pane');
  const voiceApiPane = document.getElementById('voice-api-pane');
  const voiceNativeShortcutInput = document.getElementById('voice-native-shortcut');
  const voiceApiBaseUrlInput = document.getElementById('voice-api-base-url');
  const voiceApiKeyInput = document.getElementById('voice-api-key');
  const voiceApiModelInput = document.getElementById('voice-api-model');
  const voiceApiLanguageInput = document.getElementById('voice-api-language');
  const voiceApiInputFormatInput = document.getElementById('voice-api-input-format');
  const btnSaveVoiceConfig = document.getElementById('btn-save-voice-config');

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
    if (voiceNativePane) voiceNativePane.classList.toggle('hidden', apiMode);
    if (voiceApiPane) voiceApiPane.classList.toggle('hidden', !apiMode);
  }

  function populateVoiceConfig(config) {
    if (!config) return;
    if (voiceModeInput) voiceModeInput.value = config.mode === 'api' ? 'api' : 'native';
    const native = config.native || {};
    const api = config.api || config.cloud || {};
    if (voiceNativeShortcutInput) voiceNativeShortcutInput.value = native.shortcut || 'Ctrl+Shift+R';
    if (voiceApiBaseUrlInput) voiceApiBaseUrlInput.value = api.baseUrl || 'https://api.openai.com/v1';
    if (voiceApiKeyInput) voiceApiKeyInput.value = api.apiKey || '';
    if (voiceApiModelInput) voiceApiModelInput.value = api.model || 'gpt-4o-transcribe';
    if (voiceApiLanguageInput) voiceApiLanguageInput.value = api.language || 'zh';
    if (voiceApiInputFormatInput) voiceApiInputFormatInput.value = api.inputFormat || 'opus';
    setVoiceModePaneVisibility();
  }

  function collectVoiceConfig() {
    return {
      mode: voiceModeInput && voiceModeInput.value === 'api' ? 'api' : 'native',
      native: {
        shortcut: voiceNativeShortcutInput ? voiceNativeShortcutInput.value.trim() : 'Ctrl+Shift+R'
      },
      api: {
        baseUrl: voiceApiBaseUrlInput ? voiceApiBaseUrlInput.value.trim() : '',
        apiKey: voiceApiKeyInput ? voiceApiKeyInput.value : '',
        model: voiceApiModelInput ? voiceApiModelInput.value.trim() : '',
        language: voiceApiLanguageInput ? voiceApiLanguageInput.value.trim() : '',
        inputFormat: voiceApiInputFormatInput ? voiceApiInputFormatInput.value : 'opus'
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

  if (voiceModeInput) voiceModeInput.addEventListener('change', setVoiceModePaneVisibility);

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
      const modeLabel = voiceStatus.mode === 'api' ? 'API 转写' : 'ChatGPT 原生';
      if (voiceStatus.status === 'preparing') {
        if (labVoiceStatus) labVoiceStatus.textContent = `${modeLabel} 正在准备`;
      } else if (voiceStatus.status === 'recording') {
        if (labVoiceStatus) labVoiceStatus.textContent = `${modeLabel} 录音中`;
      } else if (voiceStatus.status === 'submitting') {
        if (labVoiceStatus) labVoiceStatus.textContent = `${modeLabel} 正在提交`;
      } else if (voiceStatus.status === 'recognizing') {
        if (labVoiceStatus) labVoiceStatus.textContent = `${modeLabel} 正在转写`;
      } else if (voiceStatus.status === 'submitted') {
        if (labVoiceStatus) labVoiceStatus.textContent = `${modeLabel} 已提交`;
      } else if (voiceStatus.status === 'idle') {
        if (labVoiceStatus) labVoiceStatus.textContent = '等待语音输入';
      } else if (voiceStatus.status === 'error') {
        if (labVoiceStatus) labVoiceStatus.textContent = voiceStatus.message || `${modeLabel} 处理失败`;
      }
    });

    window.electronAPI.onDeviceMessage((msg) => {
      addDeviceTraffic('esp-to-pc', msg, { success: true });
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
      heroPortLabel.textContent = connectionLabel;
      heroPortLabel.title = lanAddresses.length > 1
        ? `本机局域网地址：${lanAddresses.map((address) => `${address}:${status.wsPort}`).join('、')}`
        : connectionLabel;
    }
    if (metricWsPort) {
      metricWsPort.textContent = connectionLabel;
      metricWsPort.title = heroPortLabel ? heroPortLabel.title : connectionLabel;
    }

    const desktopControl = status.desktopControl || {};
    const desktopAvailable = Boolean(desktopControl.available);
    const desktopDiscovery = desktopControl.discovery || {};
    const desktopWaitingLabel = desktopDiscovery.state === 'searching'
      ? '正在自动检测 ChatGPT Desktop'
      : desktopDiscovery.state === 'timeout'
        ? '未检测到窗口（已停止自动检测）'
        : '未检测到窗口';
    setMetricState(metricCodex, status.isRestartingServices
      ? { icon: 'progress_activity', label: '正在重启', tone: 'neutral' }
      : desktopAvailable
        ? { icon: 'check_circle', label: 'ChatGPT Desktop', tone: 'success' }
        : { icon: 'error', label: desktopControl.supported ? desktopWaitingLabel : '仅支持 Windows', tone: 'neutral' });

    if (serviceConfigStatus) {
      if (status.isRestartingServices) {
        serviceConfigStatus.textContent = '正在重启后台服务...';
      } else if (status.isWsServerRunning && status.isCodexBridgeRunning) {
        const desktopStatusLabel = desktopAvailable
          ? 'Desktop 已连接'
          : desktopDiscovery.state === 'timeout'
            ? '30 秒内未检测到 ChatGPT Desktop，已停止自动检测'
            : desktopDiscovery.state === 'searching'
              ? '正在自动检测 ChatGPT Desktop'
              : '等待 ChatGPT Desktop';
        serviceConfigStatus.textContent = `服务运行中 · 设备 WebSocket ${status.wsPort} · ${desktopStatusLabel}`;
      } else {
        serviceConfigStatus.textContent = '部分服务未运行，请检查系统日志。';
      }
    }

    if (metricStt) {
      const voiceLabel = status.voiceMode === 'api'
        ? `API 转写${status.voiceApiConfigured ? '' : '（未配置密钥）'}`
        : `ChatGPT 原生 · ${status.voiceShortcut || 'Ctrl+Shift+R'}`;
      setMetricState(metricStt, {
        icon: status.voiceMode === 'api' ? 'cloud' : 'keyboard',
        label: voiceLabel,
        tone: status.voiceMode === 'api' && !status.voiceApiConfigured ? 'warning' : 'primary'
      });
    }
  }

  function setMetricState(element, { icon, label, tone }) {
    if (!element) return;
    const toneClass = ['success', 'neutral', 'primary', 'info', 'warning'].includes(tone) ? tone : 'neutral';
    element.className = `status-chip is-${toneClass}`;
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
    if (isConnected) {
      if (statusDotHero) {
        statusDotHero.className = 'w-2.5 h-2.5 rounded-full bg-success status-dot-pulse';
      }
      if (statusTextHero) statusTextHero.textContent = `已连接 · ${address}`;
      if (deviceNameHero) deviceNameHero.textContent = `终端 ${address}`;
    } else {
      if (statusDotHero) {
        statusDotHero.className = 'w-2.5 h-2.5 rounded-full bg-outline';
      }
      if (statusTextHero) statusTextHero.textContent = '等待硬件设备连接...';
      if (deviceNameHero) deviceNameHero.textContent = '未绑定遥控终端';
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
    labDeviceConnection.className = `status-chip ${address ? 'is-success' : 'is-neutral'}`;
    labDeviceConnection.replaceChildren();
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined text-[14px]';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = address ? 'link' : 'link_off';
    const label = document.createElement('span');
    label.textContent = address ? `ESP32 ${address}` : 'ESP32 未连接';
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
