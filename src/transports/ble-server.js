let noble = null;
try {
  // BLE is optional because the default PC workflow uses the WebSocket transport.
  noble = require('@abandonware/noble');
} catch (error) {
  noble = null;
}
const EventEmitter = require('events');

// UUID 定义
const SERVICE_UUID = '12345678-1234-1234-1234-123456789abc';
const CHARACTERISTIC_UUID = '87654321-4321-4321-4321-cba987654321';

class BleServer extends EventEmitter {
  constructor() {
    super();
    this.connectedPeripheral = null;
    this.writeCharacteristic = null;
    this.isReady = false;
  }

  async start() {
    if (!noble) {
      throw new Error('BLE transport requires the optional @abandonware/noble dependency');
    }

    return new Promise((resolve, reject) => {
      // 监听适配器状态
      noble.on('stateChange', (state) => {
        console.log('[BLE] Adapter state:', state);
        
        if (state === 'poweredOn') {
          this.isReady = true;
          // 开始扫描设备
          noble.startScanning([SERVICE_UUID], false);
          console.log('[BLE] Scanning for devices...');
          resolve();
        } else {
          this.isReady = false;
          noble.stopScanning();
        }
      });

      // 发现设备
      noble.on('discover', (peripheral) => {
        const name = peripheral.advertisement.localName;
        console.log('[BLE] Discovered device:', name, peripheral.address);

        // 查找 Codex Remote 设备
        if (name === 'CodexRemote' || name === 'MetalioClaw4') {
          console.log('[BLE] Found target device, connecting...');
          noble.stopScanning();
          this.connectToDevice(peripheral);
        }
      });

      // 错误处理
      noble.on('warning', (message) => {
        console.error('[BLE] Warning:', message);
      });

      // 检查适配器状态
      if (noble.state === 'poweredOn') {
        this.isReady = true;
        noble.startScanning([SERVICE_UUID], false);
        console.log('[BLE] Scanning for devices...');
        resolve();
      } else if (noble.state === 'unsupported') {
        reject(new Error('BLE not supported on this system'));
      }
    });
  }

  async connectToDevice(peripheral) {
    return new Promise((resolve, reject) => {
      peripheral.connect((err) => {
        if (err) {
          console.error('[BLE] Connect failed:', err);
          // 重新扫描
          noble.startScanning([SERVICE_UUID], false);
          reject(err);
          return;
        }

        console.log('[BLE] Connected to', peripheral.address);
        this.connectedPeripheral = peripheral;
        this.emit('device-connected', { address: peripheral.address });

        // 发现服务和特征
        peripheral.discoverAllServicesAndCharacteristics((err, services, characteristics) => {
          if (err) {
            console.error('[BLE] Discover failed:', err);
            peripheral.disconnect();
            reject(err);
            return;
          }

          console.log('[BLE] Found', characteristics.length, 'characteristics');

          // 查找目标特征
          for (const char of characteristics) {
            if (char.uuid === CHARACTERISTIC_UUID.replace(/-/g, '')) {
              this.writeCharacteristic = char;
              console.log('[BLE] Found write characteristic');

              // 订阅通知
              if (char.properties.includes('notify')) {
                char.subscribe((err) => {
                  if (err) {
                    console.error('[BLE] Subscribe failed:', err);
                  } else {
                    console.log('[BLE] Subscribed to notifications');
                  }
                });

                // 监听数据
                char.on('data', (data, isNotification) => {
                  if (isNotification) {
                    try {
                      const message = JSON.parse(data.toString());
                      this.emit('device-message', message);
                    } catch (error) {
                      console.error('[BLE] Parse message failed:', error);
                    }
                  }
                });
              }

              resolve();
              break;
            }
          }

          if (!this.writeCharacteristic) {
            console.error('[BLE] Write characteristic not found');
            peripheral.disconnect();
            reject(new Error('Characteristic not found'));
          }
        });

        // 监听断开连接
        peripheral.on('disconnect', () => {
          console.log('[BLE] Device disconnected');
          this.connectedPeripheral = null;
          this.writeCharacteristic = null;
          this.emit('device-disconnected');
          
          // 重新扫描
          if (this.isReady) {
            noble.startScanning([SERVICE_UUID], false);
          }
        });
      });
    });
  }

  async sendToDevice(message) {
    if (!this.writeCharacteristic) {
      console.error('[BLE] No write characteristic available');
      return false;
    }

    return new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(message));
      
      // 检查是否需要分包（BLE 最大 512 字节）
      const MAX_SIZE = 512;
      
      if (data.length <= MAX_SIZE) {
        this.writeCharacteristic.write(data, true, (err) => {
          if (err) {
            console.error('[BLE] Write failed:', err);
            reject(err);
          } else {
            resolve(true);
          }
        });
      } else {
        // 分包发送
        const chunks = [];
        for (let i = 0; i < data.length; i += MAX_SIZE) {
          chunks.push(data.slice(i, i + MAX_SIZE));
        }

        let sent = 0;
        const sendNext = () => {
          if (sent >= chunks.length) {
            resolve(true);
            return;
          }

          this.writeCharacteristic.write(chunks[sent], true, (err) => {
            if (err) {
              reject(err);
            } else {
              sent++;
              sendNext();
            }
          });
        };

        sendNext();
      }
    });
  }

  stop() {
    if (this.connectedPeripheral) {
      this.connectedPeripheral.disconnect();
    }
    noble.stopScanning();
  }
}

module.exports = BleServer;
