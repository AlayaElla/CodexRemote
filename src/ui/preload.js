const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Expose main-process event subscriptions to the renderer.
  onDeviceConnected: (callback) => ipcRenderer.on('device-connected', (event, address) => callback(address)),
  onDeviceDisconnected: (callback) => ipcRenderer.on('device-disconnected', () => callback()),
  onDeviceMessage: (callback) => ipcRenderer.on('device-message', (event, message) => callback(message)),
  onDeviceOutbound: (callback) => ipcRenderer.on('device-outbound', (event, delivery) => callback(delivery)),
  onAgentMessage: (callback) => ipcRenderer.on('agent-message', (event, message) => callback(message)),
  onVoiceStatus: (callback) => ipcRenderer.on('voice-status', (event, data) => callback(data)),
  onLog: (callback) => ipcRenderer.on('log', (event, logData) => callback(logData)),
  onStatusUpdate: (callback) => ipcRenderer.on('status-update', (event, status) => callback(status)),

  // Expose renderer commands to the main process.
  sendApproval: (id, decision) => ipcRenderer.send('handle-approval', { id, decision }),
  sendDesktopInput: (text) => ipcRenderer.invoke('send-desktop-input', text),
  stopDesktopTurn: () => ipcRenderer.invoke('stop-desktop-turn'),
  newDesktopTask: () => ipcRenderer.invoke('new-desktop-task'),
  simulateDeviceMsg: (message) => ipcRenderer.invoke('simulate-device-msg', message),
  sendDeviceMsg: (message) => ipcRenderer.invoke('send-device-msg', message),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getServiceConfig: () => ipcRenderer.invoke('get-service-config'),
  getVoiceConfig: () => ipcRenderer.invoke('get-voice-config'),
  saveVoiceConfig: (config) => ipcRenderer.invoke('save-voice-config', config),
  connectVirtualMicro: () => ipcRenderer.invoke('connect-virtual-micro'),
  testVirtualMicroPtt: (active) => ipcRenderer.invoke('test-virtual-micro-ptt', Boolean(active)),
  getVirtualMicroDriverStatus: () => ipcRenderer.invoke('get-virtual-micro-driver-status'),
  listEsp32AudioDevices: () => ipcRenderer.invoke('list-esp32-audio-devices'),
  repairCodexHooks: () => ipcRenderer.invoke('repair-codex-hooks'),
  restartServices: (config) => ipcRenderer.invoke('restart-services', config),
  generateServiceToken: () => ipcRenderer.invoke('generate-service-token'),
  minimizeWindow: () => ipcRenderer.send('window-minimize')
});
