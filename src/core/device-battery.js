const { performance } = require('node:perf_hooks');

// ESP32 repeats its sample every 30 seconds. Never present an old device's
// battery, or a sample whose periodic updates have stopped, as current data.
class DeviceBattery {
  constructor({ now = () => performance.now(), maxAgeMs = 90000 } = {}) {
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    this.clear();
  }

  clear() { this.sample = null; }

  update(message) {
    if (!message || message.type !== 'device_battery') return false;
    if (message.available === false) {
      this.clear();
      return true;
    }
    if (message.available !== true || !Number.isInteger(message.percentage)
      || message.percentage < 0 || message.percentage > 100
      || typeof message.isCharging !== 'boolean') return false;
    this.sample = {
      battery: message.percentage,
      is_charging: message.isCharging,
      receivedAt: this.now()
    };
    return true;
  }

  getMicroStatus() {
    const sample = this.sample;
    if (!sample) return {};
    const age = this.now() - sample.receivedAt;
    if (age < 0 || age >= this.maxAgeMs) {
      this.clear();
      return {};
    }
    return { battery: sample.battery, is_charging: sample.is_charging };
  }
}

module.exports = DeviceBattery;
