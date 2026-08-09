const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const WsServer = require('./transports/ws-server');
const { DiscoveryServer, getLanAddresses } = require('./transports/discovery-server');
const AgentBridge = require('./core/agent-bridge');
const { shouldForwardAgentMessageToDevice } = require('./core/agent-message-policy');
const DesktopController = require('./core/desktop-controller');
const { createCollector, ensureCodexHooks } = require('./collectors');
const VoiceRecognizer = require('./voice/voice-recognizer');
const DeviceVoiceSession = require('./voice/device-voice-session');
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
    this.wsServer = null;
    this.discoveryServer = null;
    this.agentBridge = null;
    this.desktopController = null;
    this.voiceRecognizer = null;
    this.deviceVoiceSession = null;
    this.connectedDevice = null;
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
      nativeShortcut: this.serviceConfig.voiceShortcut
    });
    this.createMainWindow();
    this.createTray();
    this.setupIpc();
    await this.startServices(this.serviceConfig);
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
      : { mode: 'native', provider: 'native', active: false, configured: true, shortcut: this.serviceConfig && this.serviceConfig.voiceShortcut };
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
      desktopControl: this.desktopController ? this.desktopController.getState() : {
        supported: process.platform === 'win32',
        available: false,
        lastAction: null,
        error: null
      },
      isRestartingServices: this.isRestartingServices,
      voiceMode: voiceStatus.mode,
      voiceShortcut: voiceStatus.shortcut || (this.serviceConfig ? this.serviceConfig.voiceShortcut : null),
      voiceProvider: voiceStatus.provider,
      voiceActive: Boolean(voiceStatus.active),
      voiceApiConfigured: Boolean(voiceStatus.configured && voiceStatus.mode === 'api'),
      codexHook: { ...this.codexHookStatus }
    };
  }

  broadcastStatus() {
    this.sendToWindow('status-update', this.getStatus());
  }

  createServices(config) {
    this.serviceConfig = config;
    this.wsServer = new WsServer(config.wsPort, { token: config.token });
    this.discoveryServer = new DiscoveryServer(config.wsPort);
    this.desktopController = new DesktopController();
    this.deviceVoiceSession = new DeviceVoiceSession({
      voiceRecognizer: this.voiceRecognizer,
      desktopController: this.desktopController,
      voiceShortcut: config.voiceShortcut,
      sendToDevice: (message) => this.wsServer.sendToDevice(message),
      submitText: (text) => this.sendDesktopText(text, 'Voice'),
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
    this.setupEventListeners();
  }

  async startServices(config) {
    this.createServices(config);
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

    const desktopController = this.desktopController;
    let lastDiscoveryState = null;
    desktopController.startAutoDiscovery({
      onUpdate: (state) => {
        // A previous service generation may still finish an in-flight probe;
        // never let it publish status after a restart or shutdown.
        if (this.desktopController !== desktopController) return;
        const discovery = state.discovery || {};
        if (discovery.state !== lastDiscoveryState) {
          if (discovery.state === 'found') {
            this.addLog('Desktop', 'success', 'ChatGPT Desktop window detected');
          } else if (discovery.state === 'timeout') {
            this.addLog('Desktop', 'warning', discovery.error || 'ChatGPT Desktop window was not detected within 30 seconds');
          }
          lastDiscoveryState = discovery.state;
        }
        this.broadcastStatus();
      }
    });
    this.addLog('Desktop', 'info', 'Searching for the ChatGPT Desktop window (up to 30 seconds)');

    this.broadcastStatus();
    return errors.length > 0
      ? { success: false, error: errors.join('; ') }
      : { success: true, config: { ...config } };
  }

  async stopServices() {
    const wsServer = this.wsServer;
    const discoveryServer = this.discoveryServer;
    const agentBridge = this.agentBridge;
    const desktopController = this.desktopController;
    if (desktopController) desktopController.stopAutoDiscovery();
    this.wsServer = null;
    this.discoveryServer = null;
    this.agentBridge = null;
    this.desktopController = null;
    this.deviceVoiceSession = null;
    this.connectedDevice = null;

    if (wsServer) wsServer.removeAllListeners();
    if (agentBridge) agentBridge.removeAllListeners();
    await Promise.allSettled([
      wsServer ? wsServer.stop() : Promise.resolve(),
      discoveryServer ? discoveryServer.stop() : Promise.resolve(),
      agentBridge ? agentBridge.stop() : Promise.resolve()
    ]);
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
    try {
      const result = await this.desktopController.sendText(text);
      const voiceConfig = this.voiceRecognizer && this.voiceRecognizer.getConfig
        ? this.voiceRecognizer.getConfig()
        : null;
      const apiKey = voiceConfig && voiceConfig.api ? voiceConfig.api.apiKey : '';
      const safeText = apiKey ? String(text).split(apiKey).join('[redacted]') : text;
      this.addLog(source, result.success ? 'info' : 'error', `${result.success ? 'Sent to ChatGPT Desktop' : 'Desktop input failed'}: ${safeText}`);
      const response = {
        success: Boolean(result.success),
        mode: 'desktop',
        text,
        error: result.error || null
      };
      this.broadcastStatus();
      return response;
    } catch (error) {
      this.addLog(source, 'error', `Desktop input failed: ${error.message}`);
      return { success: false, error: error.message, text };
    }
  }

  async stopDesktopTurn() {
    try {
      const result = await this.desktopController.stopTurn();
      this.addLog('Desktop', result.success ? 'warning' : 'error', result.success ? 'Stop requested in ChatGPT Desktop' : result.error);
      this.broadcastStatus();
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async startNewDesktopTask(source = 'UI') {
    try {
      const result = await this.desktopController.newTask();
      this.addLog(source, result.success ? 'info' : 'error', result.success
        ? 'Started a new ChatGPT Desktop task'
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

    ipcMain.handle('get-voice-config', () => this.voiceRecognizer.getConfig());

    ipcMain.handle('save-voice-config', async (event, config) => {
      try {
        const saved = await this.voiceRecognizer.saveConfig(config);
        if (saved.mode === 'native' && saved.native && saved.native.shortcut) {
          this.serviceConfig = { ...this.serviceConfig, voiceShortcut: saved.native.shortcut };
          saveServiceConfig(this.serviceConfigFile, this.serviceConfig);
        }
        this.addLog('Voice', 'success', `Voice mode saved: ${saved.mode}`);
        this.broadcastStatus();
        return { success: true, config: saved };
      } catch (error) {
        this.addLog('Voice', 'error', `Voice configuration failed: ${error.message}`);
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
    this.wsServer.on('device-send', (delivery) => {
      this.sendToWindow('device-outbound', delivery);
    });

    this.wsServer.on('device-connected', async (device) => {
      this.connectedDevice = device;
      this.addLog('WS', 'success', `Device connected: ${device.address}`);
      this.sendToWindow('device-connected', device.address);
      await this.wsServer.sendToDevice({ type: 'status', state: this.codexTaskState });
      this.broadcastStatus();
    });

    this.wsServer.on('device-disconnected', () => {
      const prevAddr = this.connectedDevice ? this.connectedDevice.address : 'unknown device';
      this.connectedDevice = null;
      this.addLog('WS', 'warning', `Device disconnected: ${prevAddr}`);
      this.sendToWindow('device-disconnected');
      this.broadcastStatus();
    });

    this.wsServer.on('device-message', async (message) => {
      this.addLog('Device', 'info', `Received device message [${message.type}]`);
      this.sendToWindow('device-message', message);

      switch (message.type) {
        case 'voice_start':
          this.deviceVoiceSession.handle(message);
          break;

        case 'voice_data':
          this.deviceVoiceSession.handleAudio(message);
          break;

        case 'voice_end':
          this.deviceVoiceSession.handle(message);
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
            const result = await this.stopDesktopTurn();
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

    this.wsServer.on('device-audio', (buffer) => {
      this.deviceVoiceSession.handleAudio({ chunk: buffer });
    });

    this.agentBridge.on('agent-message', async (message) => {
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

      if (message.type === 'status' && message.state) {
        this.codexTaskState = message.state;
      } else if (message.type === 'stop') {
        this.codexTaskState = 'idle';
      }

      if (this.connectedDevice && shouldForwardAgentMessageToDevice(message)) {
        await this.wsServer.sendToDevice(message);
      }
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

  app.on('before-quit', () => {
    appInstance.isQuitting = true;
    appInstance.stopServices();
  });

  app.on('activate', () => appInstance.showMainWindow());

  app.on('window-all-closed', (event) => {
    event.preventDefault();
  });
}
