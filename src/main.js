const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('path');
const WsServer = require('./transports/ws-server');
const { DiscoveryServer, getLanAddresses } = require('./transports/discovery-server');
const AgentBridge = require('./core/agent-bridge');
const { CodexDesktopState } = require('./core/codex-desktop-state');
const { CodexControls, commandKey } = require('./core/codex-controls');
const { CodexSubmissionFollow } = require('./core/codex-submission-follow');
const CodexShortcuts = require('./platform/codex-shortcuts');
const CodexConversationStore = require('./core/codex-conversation-store');
const { CodexMedia } = require('./core/codex-media');
const CodexMediaTransfer = require('./core/codex-media-transfer');
const { createCollector, ensureCodexHooks } = require('./collectors');
const VoiceRecognizer = require('./voice/voice-recognizer');
const DeviceVoiceSession = require('./voice/device-voice-session');
const DeviceBattery = require('./core/device-battery');
const BridgeConnectionStatus = require('./core/bridge-connection-status');
const VirtualMicroDriverStatus = require('./voice/virtual-micro/driver-status');
const {
  generateServiceToken,
  loadServiceConfig,
  saveServiceConfig,
  validateServiceConfig
} = require('./core/service-config');

class CodexRemoteApp {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.isQuitting = false;
    this.quitCleanupComplete = false;
    this.quitCleanupPromise = null;
    this.wsServer = null;
    this.discoveryServer = null;
    this.agentBridge = null;
    this.voiceRecognizer = null;
    this.deviceVoiceSession = null;
    this.codexDesktopState = null;
    this.bridgeConnectionStatus = null;
    this.codexControls = null;
    this.deviceGeneration = 0;
    this.deviceConnectionGeneration = 0;
    this.voiceOperationPending = 0;
    this.lastCodexCapabilities = '';
    this.newTaskSequence = 0;
    this.virtualMicroTestRequestId = null;
    this.microConnecting = false;
    this.virtualMicroDriverStatus = null;
    this.voiceTransition = Promise.resolve();
    this.connectedDevice = null;
    this.deviceBattery = new DeviceBattery();
    this.codexTaskState = 'idle';
    this.logs = [];
    this.serviceConfig = null;
    this.serviceConfigFile = null;
    this.isRestartingServices = false;
    this.codexHookStatus = {
      state: 'unknown',
      trust: 'unknown',
      needsTrustReview: true,
      configPath: null,
      hookPath: null,
      events: []
    };
  }

  async init() {
    await app.whenReady();

    // Hide Electron's default application menu.
    Menu.setApplicationMenu(null);

    this.serviceConfigFile = path.join(app.getPath('userData'), 'service-config.json');
    this.serviceConfig = loadServiceConfig(this.serviceConfigFile);
    this.voiceRecognizer = new VoiceRecognizer({
      configFile: path.join(app.getPath('userData'), 'voice-config.json'),
      providerOptions: {
        virtualMicro: {
          audioBridgeOptions: app.isPackaged ? { resourcesPath: process.resourcesPath } : {},
          controllerOptions: {
            getBatteryStatus: () => this.deviceBattery.getMicroStatus(),
            ...(app.isPackaged
              ? { resourcesPath: process.resourcesPath }
              : { brokerPath: path.join(__dirname, '..', 'native', 'virtual-micro-broker', 'bin', 'Release', 'net9.0-windows', 'win-x64', 'publish', 'VirtualMicroBroker.exe') })
          }
        }
      }
    });
    this.virtualMicroDriverStatus = new VirtualMicroDriverStatus({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath
    });
    if (this.voiceRecognizer && typeof this.voiceRecognizer.on === 'function') {
      this.voiceRecognizer.on('fault', ({ mode, message }) => {
        if (mode !== 'virtual_micro') return;
        this.addLog('Voice', 'warning', `Codex Micro fault: ${message || 'unknown error'}`);
        this.broadcastStatus();
      });
      this.voiceRecognizer.on('status', (status) => {
        if (!status || status.mode !== 'virtual_micro') return;
        this.broadcastStatus();
      });
    }
    this.createMainWindow();
    this.createTray();
    this.setupIpc();
    await this.startServices(this.serviceConfig);
    // Do not make window startup wait for the broker handshake (which can take
    // up to 75 seconds), but begin it as soon as the app is ready.
    void this.autoConnectVirtualMicro();
  }

  addLog(source, level, message) {
    const time = new Date().toLocaleTimeString();
    const logItem = { source, level, message, time };
    this.logs.push(logItem);
    if (this.logs.length > 500) this.logs.shift();

    console.log(`[${time}] [${source}] [${level.toUpperCase()}] ${message}`);
    this.sendToWindow('log', logItem);
  }

  getStatus() {
    const voiceStatus = this.voiceRecognizer
      ? this.voiceRecognizer.getStatus()
      : { mode: 'virtual_micro', provider: 'virtual_micro', active: false, configured: true };
    const sourceDiagnostics = voiceStatus.handshakeDiagnostics;
    const handshakeDiagnostics = sourceDiagnostics && typeof sourceDiagnostics === 'object' && !Array.isArray(sourceDiagnostics)
      ? {
        phase: typeof sourceDiagnostics.phase === 'string' ? sourceDiagnostics.phase : null,
        failurePhase: typeof sourceDiagnostics.failurePhase === 'string' ? sourceDiagnostics.failurePhase : null,
        driverAvailable: sourceDiagnostics.driverAvailable === true,
        hidEnumerated: sourceDiagnostics.hidEnumerated === true,
        hostReports: Number.isSafeInteger(sourceDiagnostics.hostReports) ? sourceDiagnostics.hostReports : 0,
        rpcRequests: Number.isSafeInteger(sourceDiagnostics.rpcRequests) ? sourceDiagnostics.rpcRequests : 0,
        knownRequests: Number.isSafeInteger(sourceDiagnostics.knownRequests) ? sourceDiagnostics.knownRequests : 0,
        acceptedResponses: Number.isSafeInteger(sourceDiagnostics.acceptedResponses) ? sourceDiagnostics.acceptedResponses : 0,
        versionSeen: sourceDiagnostics.versionSeen === true,
        statusSeen: sourceDiagnostics.statusSeen === true,
        lightingSeen: sourceDiagnostics.lightingSeen === true,
        deviceStatusSeen: sourceDiagnostics.deviceStatusSeen === true,
        handshakeComplete: sourceDiagnostics.handshakeComplete === true
      }
      : null;
    const microStatus = {
      supported: Boolean(voiceStatus.supported),
      configured: Boolean(voiceStatus.configured),
      connecting: this.microConnecting,
      connected: Boolean(voiceStatus.connected),
      active: Boolean(voiceStatus.active),
      driverAvailable: Boolean(voiceStatus.driverAvailable),
      hidEnumerated: Boolean(voiceStatus.hidEnumerated),
      microConnected: Boolean(voiceStatus.microConnected),
      profile: voiceStatus.profile || null,
      lastError: voiceStatus.lastError || null,
      audioSource: voiceStatus.audioSource || 'esp32',
      acceptsAudio: Boolean(voiceStatus.acceptsAudio),
      audioBridge: voiceStatus.audioBridge ? {
        ready: Boolean(voiceStatus.audioBridge.ready),
        active: Boolean(voiceStatus.audioBridge.active),
        packets: Number(voiceStatus.audioBridge.packets) || 0,
        samples: Number(voiceStatus.audioBridge.samples) || 0,
        peak: Number(voiceStatus.audioBridge.peak) || 0,
        bufferedMs: Number(voiceStatus.audioBridge.bufferedMs) || 0,
        deviceName: voiceStatus.audioBridge.deviceName || null,
        captureName: voiceStatus.audioBridge.captureName || null,
        lastError: voiceStatus.audioBridge.lastError || null
      } : null,
      handshakeDiagnostics
    };
    return {
      wsPort: this.serviceConfig ? this.serviceConfig.wsPort : null,
      discoveryPort: this.discoveryServer ? this.discoveryServer.discoveryPort : null,
      lanAddresses: getLanAddresses(),
      hookPort: this.serviceConfig ? this.serviceConfig.hookPort : null,
      collectorType: this.agentBridge ? this.agentBridge.getCollectorType() : null,
      approvalMode: this.serviceConfig ? this.serviceConfig.approvalMode : 'intercept',
      connectedDevice: this.connectedDevice ? this.connectedDevice.address : null,
      isWsServerRunning: Boolean(this.wsServer && this.wsServer.isReady),
      isDiscoveryRunning: Boolean(this.discoveryServer && this.discoveryServer.isReady),
      isCodexBridgeRunning: Boolean(this.agentBridge && this.agentBridge.isRunning()),
      desktopControl: { supported: process.platform === 'win32', available: Boolean(this.codexDesktopState?.connected) },
      isRestartingServices: this.isRestartingServices,
      voiceMode: voiceStatus.mode,
      voiceProvider: voiceStatus.provider,
      voiceActive: Boolean(voiceStatus.active),
      voiceApiConfigured: Boolean(voiceStatus.configured && voiceStatus.mode === 'api'),
      voiceVirtualMicro: voiceStatus.mode === 'virtual_micro' ? microStatus : { configured: false, connected: false },
      codexHook: { ...this.codexHookStatus }
    };
  }

  broadcastStatus() {
    this.sendToWindow('status-update', this.getStatus());
    const capabilities = JSON.stringify(this.codexControls?.getSnapshot().capabilities || {});
    if (this.lastCodexCapabilities !== capabilities) {
      this.lastCodexCapabilities = capabilities;
      this.publishCodexState();
    }
  }

  publishCodexState(coalesce = false) {
    if (this.connectedDevice && this.wsServer && this.codexControls) {
      const snapshot = this.codexConversation?.decorate(this.codexControls.getSnapshot()) || this.codexControls.getSnapshot();
      const target = snapshot.slots[snapshot.selectedSlot] || snapshot.activeTask;
      const mediaTarget = `${snapshot.streamId}:${target?.hostId}:${target?.threadId}`;
      if (mediaTarget !== this.lastCodexMediaTarget) {
        this.codexMediaTransfer?.cancel();
        this.lastCodexMediaTarget = mediaTarget;
      }
      const key = `${snapshot.streamId}:${target?.hostId}:${target?.threadId}:${target?.state}:${snapshot.connected}`;
      if (coalesce && key === this.lastCodexTarget && Date.now() - this.lastCodexPublishedAt < 200) {
        if (!this.codexPublishTimer) this.codexPublishTimer = setTimeout(() => {
          this.codexPublishTimer = null;
          this.publishCodexState(); // Read the current task when flushing.
        }, 200 - (Date.now() - this.lastCodexPublishedAt));
        return;
      }
      if (this.codexPublishTimer) clearTimeout(this.codexPublishTimer);
      this.codexPublishTimer = null;
      this.lastCodexTarget = key;
      this.lastCodexPublishedAt = Date.now();
      void this.wsServer.sendToDevice(snapshot);
    }
  }

  isVoiceBusy() {
    const status = this.voiceRecognizer?.getStatus?.() || {};
    return Boolean(this.desktopQuestionPending || this.voiceOperationPending || this.deviceVoiceSession?.activeRequestId
      || status.active || status.releaseUncertain);
  }

  async handleDeviceVoice(message) {
    if (message.type === 'voice_start' && (this.desktopQuestionPending || this.codexControls?.isBusy())) {
      return this.wsServer.sendToDevice({ type: 'voice_status', state: 'error', requestId: message.requestId,
        message: '请等待任务操作完成。' });
    }
    this.voiceOperationPending++;
    const draftToken = this.codexControls?.pendingNewTask?.requestId;
    try {
      const result = await this.deviceVoiceSession.handle({ ...message, requireTarget: true });
      if (message.type === 'voice_end' && result?.submissionRequested && draftToken) {
        this.codexControls?.noteNativeSubmission(draftToken);
      }
      return result;
    }
    finally { this.voiceOperationPending--; }
  }

  getVoiceSubmissionContext(message = {}) {
    const snapshot = this.codexDesktopState?.getSnapshot();
    const layout = this.codexDesktopState?.getMicroLayout();
    const target = snapshot?.slots[snapshot.selectedSlot] || snapshot?.activeTask;
    const draftToken = this.codexControls?.pendingNewTask?.requestId || null;
    if (!snapshot?.connected) throw new Error('Codex 任务连接尚未就绪。');
    const draft = this.codexControls?.pendingNewTask;
    if (draft?.status === 'preparing') throw new Error('正在准备新任务，请稍候。');
    if (draft?.status === 'error') throw new Error(draft.error || '任务同步失败，请重试同步或从菜单选择任务。');
    if (!target?.threadId && this.codexControls?.pendingNewTask?.submitted) throw new Error('正在连接刚发送的新任务，请稍候。');
    if (!target?.threadId && !draftToken) throw new Error('请先选择任务或新建任务，再按住说话。');
    if (target?.threadId && !target.synced) throw new Error('任务状态尚未同步，请稍后再试。');
    if (target?.threadId && target.hostId !== 'local') throw new Error('仅支持本机任务的语音输入。');
    if (message.requireTarget && (message.stream_id !== snapshot.streamId || message.host_id !== 'local' ||
        (target?.threadId ? message.thread_id !== target.threadId || Boolean(message.draft_id) :
          Boolean(message.thread_id) || message.draft_id !== draftToken))) {
      throw new Error('设备显示的任务已变化，请等待同步后重试。');
    }
    return { kind: 'local', taskId: target?.threadId || null, hostId: 'local', streamId: snapshot.streamId,
      taskTitle: target?.title || null,
      executionState: target?.state || 'idle', generation: this.deviceGeneration,
      draftToken, followUpQueueMode: layout?.followUpQueueMode,
      composerEnterBehavior: layout?.composerEnterBehavior };
  }

  createServices(config) {
    this.serviceConfig = config;
    this.wsServer = new WsServer(config.wsPort, { token: config.token });
    this.discoveryServer = new DiscoveryServer(config.wsPort);
    const shortcuts = new CodexShortcuts();
    this.codexShortcuts = shortcuts;
    void shortcuts.warmKeyboard().catch(error => this.addLog('Voice', 'warning', `Keyboard helper warmup failed: ${error.message}`));
    this.deviceVoiceSession = new DeviceVoiceSession({
      voiceRecognizer: this.voiceRecognizer,
      sendToDevice: (message) => this.wsServer.sendToDevice(message),
      submitText: (text) => this.sendDesktopText(text, 'Voice'),
      getSubmissionContext: async message => this.getVoiceSubmissionContext(message),
      prepareSubmissionTarget: async context => {
        if (!DeviceVoiceSession.sameSubmissionTarget(context, this.getVoiceSubmissionContext())) throw new Error('任务已变化，请重新按住说话。');
      },
      assertSubmissionTarget: async context => {
        const current = this.getVoiceSubmissionContext();
        if (!DeviceVoiceSession.sameSubmissionTarget(context, current)) throw new Error('任务已变化，已取消语音发送。');
      },
      getMicroLayout: async () => this.codexDesktopState?.getMicroLayout(),
      cancelNativeDictation: async context => {
        const guard = () => {
          if (!DeviceVoiceSession.sameSubmissionTarget(context, this.getVoiceSubmissionContext())) throw new Error('任务已变化，无法向其他任务发送取消按键。');
        };
        guard();
        if (context.taskId) await this.codexControls.activateMicroTask(context.taskId, context.hostId, guard);
        guard();
        return shortcuts.escape();
      },
      onResult: (text) => this.sendToWindow('voice-result', text),
      onStatus: (message) => {
        this.sendToWindow('voice-status', { ...message, status: message.state });
        this.broadcastStatus();
      },
      onLog: (level, message) => this.addLog('Voice', level, message),
      onSubmitted: () => {
        this.codexTaskState = 'working';
        this.broadcastStatus();
      }
    });
    this.agentBridge = new AgentBridge(createCollector(config.collectorType, {
      hookPort: config.hookPort,
      approvalMode: config.approvalMode
    }));
    this.codexDesktopState = new CodexDesktopState();
    const desktopState = this.codexDesktopState;
    this.bridgeConnectionStatus = new BridgeConnectionStatus({ server: this.wsServer,
      getCodexConnected: () => desktopState.connected });
    this.codexControls = new CodexControls({
      state: this.codexDesktopState,
      getController: () => this.voiceRecognizer?.getMicroController?.(),
      isVoiceBusy: () => this.isVoiceBusy(),
      resolveDraft: context => shortcuts.resolveMicroDraft(context)
    });
    this.codexControls.on('state', () => this.publishCodexState());
    this.codexSubmissionFollow = new CodexSubmissionFollow({
      state: desktopState, controls: this.codexControls,
      isBusy: () => this.isVoiceBusy(),
      beforeSelect: () => {
        this.deviceGeneration++;
        this.codexMediaTransfer?.cancel();
      }
    });
    this.codexControls.on('diagnostic', event => {
      this.addLog('NewTask', event.error ? 'warning' : 'info',
        `${event.requestId} ${event.stage} ${event.elapsedMs}ms${event.error ? `: ${event.error}` : ''}`);
    });
    this.codexMedia = new CodexMedia();
    this.codexConversation = new CodexConversationStore({
      media: this.codexMedia,
      respondNative: (...args) => this.codexDesktopState.ipc.respondInteraction(...args),
      respondDesktop: (...args) => this.respondDesktopQuestion(...args),
      respondHook: (id, decision) => this.agentBridge.resolveApproval(id, decision)
    });
    this.codexMediaTransfer = new CodexMediaTransfer({ media: this.codexMedia,
      send: message => this.wsServer?.sendToDevice(message),
      getTarget: () => {
        const snapshot = this.codexControls?.getSnapshot();
        return snapshot?.slots[snapshot.selectedSlot] || snapshot?.activeTask;
      }, isVoiceBusy: () => this.isVoiceBusy() });
    const conversation = this.codexConversation;
    this.codexDesktopState.ipc.on('state', event => {
      if (this.codexConversation === conversation) conversation.observe(event);
    });
    this.codexConversation.on('change', () => this.publishCodexState(true));
    this.codexConversation.on('notification', event => {
      if (this.connectedDevice) void this.wsServer?.sendToDevice(event);
    });
    let codexConnected = false;
    this.codexDesktopState.on('state', () => {
      if (this.codexDesktopState !== desktopState) return;
      const snapshot = desktopState.getSnapshot();
      if (codexConnected !== snapshot.connected) {
        codexConnected = snapshot.connected;
        this.broadcastStatus();
        void this.bridgeConnectionStatus?.publish();
        if (!codexConnected) {
          // Invalidate pending device responses before asynchronous voice cleanup.
          this.deviceGeneration++;
          this.codexControls?.invalidate();
          this.codexMediaTransfer?.cancel();
          void this.releaseActiveVoice('Codex disconnected');
        }
      }
      this.codexTaskState = (snapshot.slots[snapshot.selectedSlot] || snapshot.activeTask)?.state || 'idle';
      this.publishCodexState(true);
    });
    this.setupEventListeners();
  }

  async startServices(config) {
    this.createServices(config);
    this.codexDesktopState.start();
    const errors = [];

    try {
      this.codexHookStatus = ensureCodexHooks({ hookPort: config.hookPort });
      this.addLog('Hooks', 'success', `Hook ${this.codexHookStatus.state === 'ready' ? 'ready' : 'installed/repaired'}`);
    } catch (error) {
      this.codexHookStatus = {
        state: 'error',
        trust: 'unknown',
        needsTrustReview: false,
        configPath: null,
        hookPath: null,
        events: [],
        error: error.message
      };
      errors.push(`Codex hook install: ${error.message}`);
      this.addLog('Codex', 'error', `Codex Hook automatic installation failed: ${error.message}`);
    }

    try {
      await this.wsServer.start();
      this.bridgeConnectionStatus.start();
      this.addLog('Main', 'success', `WebSocket server started successfully on port ${config.wsPort}`);
    } catch (error) {
      errors.push(`WebSocket: ${error.message}`);
      this.addLog('Main', 'error', `WebSocket startup failed: ${error.message}`);
    }

    if (this.wsServer.isReady) {
      try {
        await this.discoveryServer.start();
        this.addLog('Discovery', 'success', `LAN discovery started on UDP port ${this.discoveryServer.discoveryPort}`);
      } catch (error) {
        errors.push(`Discovery: ${error.message}`);
        this.addLog('Discovery', 'error', `LAN discovery startup failed: ${error.message}`);
      }
    }

    try {
      await this.agentBridge.start();
      this.addLog('Hooks', 'success', `${config.collectorType} collector started on port ${config.hookPort}`);
    } catch (error) {
      errors.push(`Codex hook: ${error.message}`);
      this.addLog('Codex', 'error', `Codex bridge initialization failed: ${error.message}`);
    }

    this.addLog('Desktop', 'info', 'Searching for the ChatGPT Desktop window (up to 30 seconds)');

    this.broadcastStatus();
    return errors.length > 0
      ? { success: false, error: errors.join('; ') }
      : { success: true, config: { ...config } };
  }

  async stopServices() {
    const connectionShutdown = this.bridgeConnectionStatus?.stop();
    this.bridgeConnectionStatus = null;
    this.deviceBattery.clear();
    if (this.codexPublishTimer) clearTimeout(this.codexPublishTimer);
    this.codexPublishTimer = null;
    this.deviceGeneration++;
    this.deviceConnectionGeneration++;
    this.codexMediaTransfer?.cancel();
    this.codexConversation?.removeAllListeners();
    this.codexConversation = null;
    this.codexMediaTransfer = null;
    this.codexMedia = null;
    this.codexControls?.stop();
    this.codexSubmissionFollow?.stop();
    this.codexSubmissionFollow = null;
    this.codexDesktopState?.stop();
    this.codexDesktopState?.removeAllListeners();
    this.codexControls = null;
    this.codexDesktopState = null;
    await this.releaseActiveVoice('Background services stopped.');
    const wsServer = this.wsServer;
    const discoveryServer = this.discoveryServer;
    const agentBridge = this.agentBridge;
    const deviceVoiceSession = this.deviceVoiceSession;
    if (deviceVoiceSession && typeof deviceVoiceSession.dispose === 'function') {
      await deviceVoiceSession.dispose();
    }
    this.codexShortcuts?.dispose();
    this.codexShortcuts = null;
    this.wsServer = null;
    this.discoveryServer = null;
    this.agentBridge = null;
    this.deviceVoiceSession = null;
    this.connectedDevice = null;
    this.deviceBattery.clear();

    await connectionShutdown;
    if (wsServer) wsServer.removeAllListeners();
    if (agentBridge) agentBridge.removeAllListeners();
    await Promise.allSettled([
      wsServer ? wsServer.stop() : Promise.resolve(),
      discoveryServer ? discoveryServer.stop() : Promise.resolve(),
      agentBridge ? agentBridge.stop() : Promise.resolve()
    ]);
  }

  async releaseActiveVoice(reason) {
    this.virtualMicroTestRequestId = null;
    if (!this.deviceVoiceSession || typeof this.deviceVoiceSession.cancelVirtualMicro !== 'function') return;
    try {
      await this.deviceVoiceSession.cancelVirtualMicro(reason);
    } catch (error) {
      this.addLog('Voice', 'warning', `Voice release failed during ${reason}: ${error.message}`);
    }
  }

  isAuthorizedMainFrame(event) {
    return Boolean(this.mainWindow && event && event.sender === this.mainWindow.webContents
      && event.senderFrame === this.mainWindow.webContents.mainFrame);
  }

  runVoiceTransition(task) {
    const next = this.voiceTransition.catch(() => {}).then(task);
    this.voiceTransition = next;
    return next;
  }

  connectMicro(mode) {
    return this.runVoiceTransition(async () => {
      try {
        const current = this.voiceRecognizer && this.voiceRecognizer.getStatus();
        if (!current || current.mode !== mode || !current.configured) {
          throw new Error('请先保存所选 Micro 语音模式。');
        }
        if (current.active) {
          throw new Error('请先停止听写并确认按键已松开。');
        }
        this.microConnecting = true;
        this.broadcastStatus();
        const status = await this.voiceRecognizer.connect();
        return { success: true, status: status || this.voiceRecognizer.getStatus() };
      } catch (error) {
        this.addLog('Voice', 'warning', `Codex Micro connection failed: ${error.message}`);
        return { success: false, error: error.message, status: this.voiceRecognizer && this.voiceRecognizer.getStatus() };
      } finally {
        this.microConnecting = false;
        this.broadcastStatus();
      }
    });
  }

  autoConnectVirtualMicro() {
    const current = this.voiceRecognizer && this.voiceRecognizer.getStatus();
    if (!current || current.mode !== 'virtual_micro' || !current.configured) {
      return Promise.resolve({ success: false, skipped: true });
    }
    return this.connectMicro('virtual_micro');
  }

  async testMicroPtt(mode, active) {
    if (!this.deviceVoiceSession) return { success: false, error: 'Voice session is unavailable.' };
    if (typeof active !== 'boolean') return { success: false, error: 'PTT test state must be boolean.' };
    const current = this.voiceRecognizer && this.voiceRecognizer.getStatus();
    if (!current || current.mode !== mode || (active && !current.connected)) {
      return { success: false, error: 'Codex Micro 尚未连接，请先连接设备。' };
    }
    if (active && current.audioSource === 'esp32') {
      return { success: false, error: '请在 ESP32 上按住说话，以启动设备麦克风。' };
    }
    const key = 'virtualMicroTestRequestId';
    const requestId = active ? (this[key] || `${mode}-micro-test-${Date.now()}`) : this[key];
    if (active) this[key] = requestId;
    if (!requestId) return { success: false, error: 'Microphone test is not active.' };
    const result = await this.deviceVoiceSession.handle({ type: active ? 'voice_start' : 'voice_end', requestId });
    if ((!active || !result || !result.success) && this[key] === requestId) this[key] = null;
    this.broadcastStatus();
    return result || { success: true };
  }

  async restartServices(input) {
    if (this.isRestartingServices) {
      return { success: false, error: 'Services are restarting; please wait.' };
    }

    const validated = validateServiceConfig(input, this.serviceConfig);
    if (!validated.success) return validated;

    const previousConfig = { ...this.serviceConfig };
    const nextConfig = validated.config;
    this.isRestartingServices = true;
    this.broadcastStatus();
    this.addLog('Main', 'info', 'Restarting background services...');

    try {
      await this.stopServices();
      const result = await this.startServices(nextConfig);
      if (!result.success) {
        await this.stopServices();
        this.addLog('Main', 'warning', 'New configuration failed to start; restoring the previous configuration');
        await this.startServices(previousConfig);
        return { success: false, error: `${result.error}。已恢复原配置。` };
      }

      saveServiceConfig(this.serviceConfigFile, nextConfig);
      this.addLog('Main', 'success', 'Background services restarted with the new configuration');
      return { success: true, config: { ...nextConfig } };
    } catch (error) {
      await this.stopServices();
      await this.startServices(previousConfig);
      return { success: false, error: `${error.message}。已恢复原配置。` };
    } finally {
      this.isRestartingServices = false;
      this.broadcastStatus();
    }
  }

  async sendDesktopText(text, source = 'UI') {
    let locked = false;
    try {
      if (typeof text !== 'string' || !text.trim() || text.length > 32768) throw new Error('文字为空或超过发送上限。');
      if ((source !== 'Voice' && this.isVoiceBusy()) || this.codexControls?.isBusy()) throw new Error('请等待当前操作结束。');
      const context = this.getVoiceSubmissionContext();
      const shortcuts = this.codexShortcuts;
      const controller = this.voiceRecognizer?.getMicroController?.();
      const key = commandKey(this.codexDesktopState.getMicroLayout(), 'composer.submit');
      if (!key || !controller?.getStatus?.().microConnected) throw new Error('请连接 Codex Micro 并绑定发送命令（CODEX）。');
      shortcuts.validateTextTarget(context);
      const guard = () => {
        if (this.codexShortcuts !== shortcuts || !DeviceVoiceSession.sameSubmissionTarget(context, this.getVoiceSubmissionContext()))
          throw new Error('任务或连接已变化，已取消文字发送。');
      };
      this.voiceOperationPending++; locked = true;
      if (context.taskId) await this.codexControls.activateMicroTask(context.taskId, context.hostId, guard);
      guard();
      await shortcuts.pasteText(text, context);
      guard();
      if (commandKey(this.codexDesktopState.getMicroLayout(), 'composer.submit') !== key) throw new Error('Micro 发送绑定已变化。');
      const sent = await controller.tapKey(key);
      if (sent?.delivery !== 'submitted_to_hid') throw new Error('Micro 发送按键未确认投递。');
      guard();
      if (context.draftToken) this.codexControls.noteNativeSubmission(context.draftToken);
      const result = { success: true, delivery: 'submitted_to_hid', outcome: 'requested' };
      const voiceConfig = this.voiceRecognizer && this.voiceRecognizer.getConfig
        ? this.voiceRecognizer.getConfig()
        : null;
      const apiKey = voiceConfig && voiceConfig.api ? voiceConfig.api.apiKey : '';
      const safeText = apiKey ? String(text).split(apiKey).join('[redacted]') : text;
      this.addLog(source, 'info', `Codex text submission requested: ${safeText}`);
      const response = {
        success: Boolean(result.success),
        mode: 'desktop',
        delivery: result.delivery,
        submissionConfirmed: false,
        text,
        error: result.error || null
      };
      this.broadcastStatus();
      return response;
    } catch (error) {
      this.addLog(source, 'error', `Desktop input failed: ${error.message}`);
      return { success: false, error: error.message, text };
    } finally { if (locked) this.voiceOperationPending--; }
  }

  async stopDesktopTurn(message = null) {
    let locked = false;
    try {
      if (this.isVoiceBusy() || this.codexControls?.isBusy()) throw new Error('请等待当前操作结束。');
      const context = this.getVoiceSubmissionContext(message ? { ...message, requireTarget: true } : {});
      if (!context.taskId) throw new Error('请先选择要停止的任务。');
      this.voiceOperationPending++;
      locked = true;
      const guard = () => {
        if (!DeviceVoiceSession.sameSubmissionTarget(context, this.getVoiceSubmissionContext())) throw new Error('任务已变化，已取消停止请求。');
      };
      await this.codexControls.activateMicroTask(context.taskId, context.hostId, guard);
      guard();
      const result = await this.codexShortcuts.escape({ stop: true });
      this.addLog('Desktop', 'warning', 'Stop requested through Micro and Esc; completion awaits task state.');
      this.broadcastStatus();
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    } finally { if (locked) this.voiceOperationPending--; }
  }

  async respondDesktopQuestion(threadId, interaction, answers, { hostId = 'local' } = {}) {
    if (hostId !== 'local' || this.isVoiceBusy() || this.codexControls?.isBusy()) throw new Error('请等待语音或任务操作结束。');
    if (!/^[\w-]{1,128}$/.test(threadId) || interaction.nativeKind !== 'asyncTool' || interaction.questions?.length !== 1)
      throw new Error('问题身份或形式不受支持。');
    const generation = this.deviceGeneration;
    const ipc = this.codexDesktopState.ipc;
    const question = interaction.questions[0];
    const interactionId = interaction.id || interaction.nativeId;
    const wireQuestionId = interaction.wireQuestions?.[0]?.id || question.id;
    const selected = answers?.[wireQuestionId];
    if (!Array.isArray(selected) || selected.length !== 1 || typeof selected[0] !== 'string' || !selected[0].trim())
      throw new Error('请填写或选择一个答案。');
    const assertCurrent = () => {
      const snapshot = this.codexControls?.getSnapshot();
      const target = snapshot?.slots[snapshot.selectedSlot] || snapshot?.activeTask;
      if (this.deviceGeneration !== generation || this.codexDesktopState?.ipc !== ipc || target?.hostId !== hostId || target?.threadId !== threadId)
        throw new Error('连接或目标任务已变化，请重新提交。');
      return target;
    };
    assertCurrent();
    this.desktopQuestionPending = true;
    this.publishCodexState(true);
    try {
      const result = await ipc.respondAsyncQuestion(threadId, interactionId, selected[0], { hostId, assertCurrent });
      assertCurrent();
      return result;
    } finally {
      this.desktopQuestionPending = false;
      this.publishCodexState(true);
    }
  }

  async startNewDesktopTask(source = 'UI') {
    try {
      const result = this.codexControls
        ? await this.codexControls.handle({ type: 'codex_action', action: 'new_task', request_id: `new-${Date.now()}-${++this.newTaskSequence}` })
        : { success: false, error: 'Codex 控制服务尚未就绪。' };
      this.addLog(source, result.success ? 'info' : 'error', result.success
        ? 'Requested a new Codex task'
        : `New Desktop task failed: ${result.error}`);
      this.broadcastStatus();
      return result;
    } catch (error) {
      this.addLog(source, 'error', `New Desktop task failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  normalizeAgentNotification(message) {
    const params = message.params || {};
    const common = {
      source: 'hooks',
      session_id: null,
      turn_id: params.turnId || (params.turn && params.turn.id) || null,
      timestamp: Date.now()
    };
    if (message.method === 'turn/started') {
      return { type: 'status', state: 'working', ...common };
    }
    if (message.method === 'turn/completed') {
      const turn = params.turn || {};
      return {
        type: 'stop',
        state: turn.status || 'completed',
        message: turn.error && turn.error.message ? turn.error.message : null,
        ...common
      };
    }
    if (message.method === 'thread/status/changed') {
      return { type: 'status', state: params.status && params.status.type ? params.status.type : 'unknown', ...common };
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = params.item || {};
      const completed = message.method === 'item/completed';
      if (item.type === 'agentMessage') {
        return completed ? { type: 'chat', role: 'codex', text: item.text || '', ...common } : null;
      }
      if (item.type === 'userMessage') {
        const text = Array.isArray(item.content)
          ? item.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
          : '';
        return completed ? { type: 'chat', role: 'user', text, ...common } : null;
      }
      if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
        return {
          type: completed ? 'tool_result' : 'tool_call',
          id: item.id,
          tool_name: item.type,
          description: item.command || item.tool || item.server || item.type,
          output: completed ? item : undefined,
          ...common
        };
      }
    }
    return {
      type: 'agent_event',
      method: message.method,
      params,
      ...common
    };
  }

  normalizeAgentRequest(message) {
    const params = message.params || {};
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
      return {
        type: 'agent_request',
        id: message.id,
        method: message.method,
        params,
        source: 'hooks',
        timestamp: Date.now()
      };
    }
    return {
      type: 'approval_request',
      id: message.id,
      question: params.reason || params.command || (message.method.includes('fileChange') ? '是否允许修改文件？' : '是否允许运行命令？'),
      options: [
        { id: 'allow', label: '允许' },
        { id: 'allow_session', label: '本次会话允许' },
        { id: 'deny', label: '拒绝' }
      ],
      blocking: true,
      source: 'hooks',
      session_id: params.threadId || null,
      turn_id: params.turnId || null,
      timestamp: Date.now()
    };
  }

  setupIpc() {
    ipcMain.handle('get-status', () => {
      return { ...this.getStatus(), logs: this.logs };
    });

    ipcMain.handle('get-service-config', () => ({ ...this.serviceConfig }));

    ipcMain.handle('get-voice-config', event => {
      if (!this.isAuthorizedMainFrame(event)) return { success: false, error: '无效的语音配置请求。' };
      return this.voiceRecognizer.getConfig();
    });

    ipcMain.handle('save-voice-config', async (event, config) => {
      if (!this.isAuthorizedMainFrame(event)) return { success: false, error: '无效的语音配置保存请求。' };
      return this.runVoiceTransition(async () => {
        try {
        const saved = await this.voiceRecognizer.saveConfig(config);
        this.addLog('Voice', 'success', `Voice mode saved: ${saved.mode}`);
        this.broadcastStatus();
        return { success: true, config: saved };
        } catch (error) {
        this.addLog('Voice', 'error', `Voice configuration failed: ${error.message}`);
        return { success: false, error: error.message };
        }
      });
    });

    ipcMain.handle('connect-virtual-micro', async event => {
      if (!this.isAuthorizedMainFrame(event)) return { success: false, error: '无效的虚拟 Micro 连接请求。' };
      return this.connectMicro('virtual_micro');
    });

    ipcMain.handle('test-virtual-micro-ptt', async (event, active) => {
      if (!this.isAuthorizedMainFrame(event)) {
        return { success: false, error: 'Invalid virtual microphone test source.' };
      }
      return this.testMicroPtt('virtual_micro', active);
    });

    ipcMain.handle('get-virtual-micro-driver-status', async event => {
      if (!this.isAuthorizedMainFrame(event)) return { success: false, error: '无效的驱动状态请求。' };
      if (!this.virtualMicroDriverStatus) return { success: false, error: '此版本不包含驱动状态查询。' };
      const result = await this.virtualMicroDriverStatus.inspect();
      return { success: Boolean(result.success), result };
    });

    ipcMain.handle('list-esp32-audio-devices', async event => {
      if (!this.isAuthorizedMainFrame(event)) return { success: false, error: '无效的音频设备查询请求。' };
      try {
        return { success: true, devices: await this.voiceRecognizer.listAudioDevices() };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('repair-codex-hooks', () => {
      try {
        this.codexHookStatus = ensureCodexHooks({ hookPort: this.serviceConfig.hookPort });
        this.addLog('Hooks', 'success', 'Hook checked and repaired');
        this.broadcastStatus();
        return { success: true, status: { ...this.codexHookStatus } };
      } catch (error) {
        this.codexHookStatus = {
          ...this.codexHookStatus,
          state: 'error',
          error: error.message
        };
        this.addLog('Hooks', 'error', `Hook repair failed: ${error.message}`);
        this.broadcastStatus();
        return { success: false, error: error.message, status: { ...this.codexHookStatus } };
      }
    });

    ipcMain.handle('restart-services', (event, config) => this.restartServices(config));
    ipcMain.handle('send-desktop-input', (event, text) => this.sendDesktopText(text, 'UI'));
    ipcMain.handle('stop-desktop-turn', () => this.stopDesktopTurn());
    ipcMain.handle('new-desktop-task', () => this.startNewDesktopTask('UI'));

    ipcMain.handle('generate-service-token', () => generateServiceToken());

    ipcMain.on('handle-approval', (event, { id, decision, approved }) => {
      const selectedDecision = decision || (approved === true ? 'allow' : approved === false ? 'deny' : null);
      const handled = Boolean(this.agentBridge && this.agentBridge.resolveApproval(id, selectedDecision));
      this.addLog('UI', handled ? 'info' : 'warning', handled
        ? `Approval request #${id} handled: ${selectedDecision}`
        : `Approval request missing or invalid: #${id}`);
    });

    ipcMain.handle('simulate-device-msg', (event, message) => {
      if (!this.mainWindow || event.sender !== this.mainWindow.webContents) {
        return { success: false, error: '无效的模拟器消息来源。' };
      }
      const validation = this.validateDebugDeviceMessage(message);
      if (!validation.success) return validation;
      if (!this.wsServer) return { success: false, error: 'WebSocket 服务未运行。' };
      this.addLog('Lab', 'info', `Simulated ESP32 message [${message.type}]`);
      this.wsServer.emit('device-message', message);
      return { success: true };
    });

    ipcMain.handle('send-device-msg', async (event, message) => {
      if (!this.mainWindow || event.sender !== this.mainWindow.webContents) {
        return { success: false, error: '无效的设备消息来源。' };
      }
      const validation = this.validateDebugDeviceMessage(message);
      if (!validation.success) return validation;
      if (!this.wsServer) return { success: false, error: 'WebSocket 服务未运行。' };

      const delivery = await this.wsServer.sendToDeviceDetailed(message);
      this.addLog('Lab', delivery.success ? 'success' : 'warning',
        `${delivery.success ? 'Sent' : 'Failed to send'} ESP32 message [${message.type}] in ${delivery.durationMs} ms`);
      return delivery.success
        ? { success: true, delivery }
        : {
            success: false,
            error: delivery.phase === 'timeout'
              ? `发送超时（${delivery.durationMs} ms），请检查 ESP32 网络和 WebSocket 状态。`
              : (delivery.error || 'ESP32 未连接或消息发送失败。'),
            delivery
          };
    });

    ipcMain.on('window-minimize', () => {
      this.hideMainWindow();
    });
  }

  getAppIconPath() {
    return path.join(__dirname, '..', 'assets', 'app-icon.png');
  }

  createTrayIcon() {
    return nativeImage.createFromPath(this.getAppIconPath()).resize({ width: 16, height: 16, quality: 'best' });
  }

  createTray() {
    this.tray = new Tray(this.createTrayIcon());
    this.tray.setToolTip('Codex 远程控制台');
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => this.showMainWindow() },
      { type: 'separator' },
      {
        label: '退出应用',
        click: () => {
          this.isQuitting = true;
          app.quit();
        }
      }
    ]));
    this.tray.on('click', () => this.showMainWindow());
  }

  hideMainWindow() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.setSkipTaskbar(true);
    this.mainWindow.hide();
  }

  showMainWindow() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      this.createMainWindow();
    }

    this.mainWindow.setSkipTaskbar(false);
    if (this.mainWindow.isMinimized()) this.mainWindow.restore();
    this.mainWindow.show();
    this.mainWindow.focus();
  }

  setupEventListeners() {
    const wsServer = this.wsServer;
    wsServer.on('device-send', (delivery) => {
      if (this.wsServer !== wsServer) return;
      if (delivery.message?.type === 'bridge_status') return;
      this.sendToWindow('device-outbound', delivery.message?.type === 'codex_media_chunk'
        ? { ...delivery, message: { ...delivery.message, data: '[图片分块]' } } : delivery);
    });

    wsServer.on('device-connected', async (device) => {
      if (this.wsServer !== wsServer) return;
      const generation = ++this.deviceConnectionGeneration;
      this.deviceGeneration++;
      this.codexMediaTransfer?.cancel();
      this.deviceBattery.clear();
      this.codexControls?.invalidate();
      if (this.connectedDevice) await this.releaseActiveVoice('device replaced');
      if (this.wsServer !== wsServer || generation !== this.deviceConnectionGeneration) return;
      this.connectedDevice = device;
      this.addLog('WS', 'success', `Device connected: ${device.address}`);
      this.sendToWindow('device-connected', device.address);
      void this.bridgeConnectionStatus?.publish();
      this.publishCodexState();
      this.broadcastStatus();
    });

    wsServer.on('device-disconnected', async () => {
      if (this.wsServer !== wsServer) return;
      this.deviceBattery.clear();
      const prevAddr = this.connectedDevice ? this.connectedDevice.address : 'unknown device';
      this.deviceGeneration++;
      this.deviceConnectionGeneration++;
      this.codexMediaTransfer?.cancel();
      this.codexControls?.invalidate();
      this.connectedDevice = null;
      await this.releaseActiveVoice('device disconnect');
      if (this.wsServer !== wsServer || this.connectedDevice) return;
      this.addLog('WS', 'warning', `Device disconnected: ${prevAddr}`);
      this.sendToWindow('device-disconnected');
      this.broadcastStatus();
    });

    wsServer.on('device-message', async (message) => {
      if (this.wsServer !== wsServer) return;
      if (!message || typeof message !== 'object') return;
      this.addLog('Device', 'info', `Received device message [${message.type}]`);
      this.sendToWindow('device-message', message.type === 'codex_interaction_response'
        ? { ...message, answers: message.answers ? '[用户回答]' : undefined } : message);

      switch (message.type) {
        case 'device_battery':
          this.deviceBattery.update(message);
          break;
        case 'codex_sync':
          void this.bridgeConnectionStatus?.publish();
          this.publishCodexState();
          break;
        case 'codex_action':
          {
            const generation = this.deviceGeneration;
            const result = await this.codexControls.handle(message);
            if (result.state) result.state = this.codexConversation?.decorate(result.state) || result.state;
            if (this.wsServer === wsServer && generation === this.deviceGeneration) await wsServer.sendToDevice(result);
          }
          break;

        case 'codex_interaction_response': {
          const generation = this.deviceGeneration;
          const result = await this.codexConversation.respond(message);
          if (generation === this.deviceGeneration && this.wsServer === wsServer) {
            await wsServer.sendToDevice(result);
            this.publishCodexState();
          }
          break;
        }
        case 'codex_media_request':
          this.codexMediaTransfer.enqueue(message);
          break;

        case 'voice_start':
          void this.handleDeviceVoice(message);
          break;

        case 'voice_data':
          this.deviceVoiceSession.handleAudio(message);
          break;

        case 'voice_end':
          void this.handleDeviceVoice(message);
          break;

        case 'text_input':
          {
            const inputResult = await this.sendDesktopText(message.text, 'Device');
            await this.wsServer.sendToDevice({
              type: inputResult.success ? 'input_result' : 'input_error',
              requestId: message.requestId,
              ...inputResult
            });
          }
          break;

        case 'turn_stop':
          {
            const result = await this.stopDesktopTurn(message);
            await this.wsServer.sendToDevice({
              type: 'turn_stop_result',
              requestId: message.requestId,
              ...result
            });
          }
          break;

        case 'task_new':
        case 'new_task':
        case 'new_chat':
          {
            const result = await this.startNewDesktopTask('Device');
            await this.wsServer.sendToDevice({
              type: 'task_new_result',
              requestId: message.requestId,
              ...result
            });
          }
          break;

        case 'approval':
          {
            const decision = message.decision || (message.approved === true ? 'allow' : message.approved === false ? 'deny' : null);
            const handled = Boolean(this.agentBridge && this.agentBridge.resolveApproval(message.id, decision));
            await this.wsServer.sendToDevice({
              type: 'approval_result',
              id: message.id,
              decision,
              handled
            });
          }
          break;
      }
    });

    wsServer.on('device-audio', (buffer) => {
      if (this.wsServer !== wsServer) return;
      this.deviceVoiceSession.handleAudio({ chunk: buffer });
    });

    this.agentBridge.on('agent-message', async (message) => {
      if (message.type === 'approval_request') this.codexConversation?.addHook(message);
      if (message.type === 'approval_resolved') this.codexConversation?.resolveHook(message);
      if (this.codexHookStatus.trust !== 'observed') {
        this.codexHookStatus = {
          ...this.codexHookStatus,
          trust: 'observed',
          needsTrustReview: false,
          lastEventAt: Date.now()
        };
        this.broadcastStatus();
      }
      this.addLog('Hooks', 'info', `Collected agent event [${message.type}]`);
      this.sendToWindow('agent-message', message);
      this.codexSubmissionFollow?.observe(message);

      const hostId = message.host_id || message.hostId || 'local';
      const threadId = message.session_id || message.thread_id;
      if (hostId === 'local') {
        const state = message.type === 'approval_request' ? 'waiting'
          : message.type === 'stop' ? 'idle'
          : message.type === 'chat' && message.role === 'user' ? 'working'
          : message.type === 'status' ? message.state : null;
        if (['working', 'waiting', 'idle', 'error'].includes(state)) {
          this.codexDesktopState?.observeTaskSignal(threadId, { state });
        }
      }

      // Hook requests join the ordered conversation snapshot. Completion
      // sounds are emitted only by the native successful-turn transition.
    });
  }

  validateDebugDeviceMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { success: false, error: '消息必须是 JSON 对象。' };
    }
    if (typeof message.type !== 'string' || message.type.trim().length === 0) {
      return { success: false, error: '消息必须包含非空 type。' };
    }
    try {
      if (Buffer.byteLength(JSON.stringify(message), 'utf8') > 64 * 1024) {
        return { success: false, error: '消息超过 64 KB 调试限制。' };
      }
    } catch (error) {
      return { success: false, error: `消息无法序列化：${error.message}` };
    }
    return { success: true };
  }

  createMainWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1040,
      height: 720,
      minWidth: 800,
      minHeight: 560,
      title: 'Codex 远程控制台',
      icon: this.getAppIconPath(),
      frame: false,
      show: false,
      backgroundColor: '#f5f5f7',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'ui', 'preload.js')
      }
    });

    this.mainWindow.loadFile(path.join(__dirname, 'ui', 'app.html'));
    this.mainWindow.once('ready-to-show', () => this.showMainWindow());

    this.mainWindow.webContents.on('render-process-gone', (_event, details) => {
      const reason = details && details.reason ? details.reason : 'unknown';
      const exitCode = details && Number.isInteger(details.exitCode) ? details.exitCode : 'unknown';
      this.addLog('Renderer', 'error', `Renderer process exited (${reason}, code ${exitCode})`);
    });
    this.mainWindow.on('unresponsive', () => {
      this.addLog('Renderer', 'error', 'Renderer window became unresponsive');
    });
    this.mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level < 2) return;
      const source = sourceId ? path.basename(sourceId) : 'renderer';
      this.addLog('Renderer', level >= 3 ? 'error' : 'warn', `${message} (${source}:${line || 0})`);
    });

    if (process.argv.includes('--dev')) {
      this.mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    this.mainWindow.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.hideMainWindow();
      }
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });
  }

  sendToWindow(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  const appInstance = new CodexRemoteApp();

  app.on('second-instance', () => {
    if (app.isReady()) appInstance.showMainWindow();
  });
  appInstance.init().catch((err) => console.error('[Main Fatal Error]', err));

  app.on('before-quit', (event) => {
    if (!appInstance.quitCleanupComplete) {
      event.preventDefault();
      if (!appInstance.quitCleanupPromise) {
        appInstance.isQuitting = true;
        const cleanup = async () => {
          await appInstance.stopServices();
          if (appInstance.voiceRecognizer && typeof appInstance.voiceRecognizer.dispose === 'function') {
            await appInstance.voiceRecognizer.dispose();
          }
        };
        const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
        appInstance.quitCleanupPromise = Promise.race([cleanup(), timeout]).catch(() => {}).finally(() => {
          appInstance.quitCleanupComplete = true;
          app.quit();
        });
      }
      return;
    }
    appInstance.isQuitting = true;
  });

  app.on('activate', () => appInstance.showMainWindow());

  app.on('window-all-closed', (event) => {
    event.preventDefault();
  });
}
