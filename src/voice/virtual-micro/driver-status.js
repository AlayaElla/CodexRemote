const { spawn: defaultSpawn } = require('child_process');
const path = require('path');

const MAX_OUTPUT_BYTES = 64 * 1024;
const REQUIRED_FIELDS = ['state', 'message', 'installed', 'deviceReady', 'success'];

class VirtualMicroDriverStatus {
  constructor(options = {}) {
    this.isPackaged = Boolean(options.isPackaged);
    this.resourcesPath = options.resourcesPath;
    this.platform = options.platform || process.platform;
    this.spawn = options.spawn || defaultSpawn;
    this.inspectTimeoutMs = options.inspectTimeoutMs || 15000;
    this.status = null;
    this.inspecting = null;
  }

  brokerPath() {
    return this.isPackaged
      ? path.join(this.resourcesPath, 'virtual-micro', 'VirtualMicroBroker.exe')
      : path.resolve(__dirname, '..', '..', '..', 'native', 'virtual-micro-broker', 'bin', 'Release', 'net9.0-windows', 'win-x64', 'publish', 'VirtualMicroBroker.exe');
  }

  getStatus() { return this.status; }

  _result(state, message) {
    return { state, message, installed: false, deviceReady: false, success: false };
  }

  _validate(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || REQUIRED_FIELDS.some(field => typeof result[field] !== (field === 'state' || field === 'message' ? 'string' : 'boolean'))
      || !result.state.trim()) {
      throw new Error('驱动状态助手返回了无效结果。');
    }
    return result;
  }

  inspect() {
    if (this.inspecting) return this.inspecting;
    this.inspecting = this._inspect().finally(() => { this.inspecting = null; });
    return this.inspecting;
  }

  _inspect() {
    if (this.platform !== 'win32') {
      const result = this._result('unsupported', '虚拟 Codex Micro 驱动仅支持 Windows。');
      this.status = result;
      return Promise.resolve(result);
    }
    return new Promise(resolve => {
      let child;
      let output = Buffer.alloc(0);
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.status = value;
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { child && child.kill(); } catch {}
        finish(this._result('outcome_unknown', '驱动状态检查超时，请稍后刷新状态。'));
      }, this.inspectTimeoutMs);
      try {
        child = this.spawn(this.brokerPath(), ['--driver-status'], {
          shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
        });
        child.once('error', error => finish(this._result('outcome_unknown', `无法启动驱动状态助手：${error.message}`)));
        child.stdout.on('data', chunk => {
          if (done) return;
          output = Buffer.concat([output, Buffer.from(chunk)]);
          if (output.length > MAX_OUTPUT_BYTES) {
            try { child.kill(); } catch {}
            finish(this._result('outcome_unknown', '驱动状态助手输出过大，请稍后刷新状态。'));
          }
        });
        child.stdout.once('error', error => finish(this._result('outcome_unknown', `驱动状态助手输出失败：${error.message}`)));
        if (child.stderr) {
          child.stderr.on('data', () => {});
          child.stderr.once('error', () => {});
        }
        child.once('close', () => {
          if (done) return;
          try {
            finish(this._validate(JSON.parse(output.toString('utf8'))));
          } catch (error) {
            finish(this._result('outcome_unknown', `驱动状态助手结果无效：${error.message}`));
          }
        });
      } catch (error) {
        finish(this._result('outcome_unknown', `无法启动驱动状态助手：${error.message}`));
      }
    });
  }
}

module.exports = VirtualMicroDriverStatus;
