const EventEmitter = require('events');

class AgentBridge extends EventEmitter {
  constructor(collector) {
    super();
    if (!collector) throw new Error('agent event collector is required');
    this.collector = collector;
    this.onCollectorMessage = (message) => this.emit('agent-message', message);
  }

  async start() {
    this.collector.on('message', this.onCollectorMessage);
    try {
      await this.collector.start();
    } catch (error) {
      this.collector.removeListener('message', this.onCollectorMessage);
      throw error;
    }
  }

  isRunning() {
    return typeof this.collector.isRunning === 'function'
      ? this.collector.isRunning()
      : false;
  }

  getCollectorType() {
    return this.collector.type;
  }

  resolveApproval(id, decision) {
    return this.collector.resolveApproval(id, decision);
  }

  sendUserInput(text) {
    return this.collector.sendUserInput(text);
  }

  async stop() {
    this.collector.removeListener('message', this.onCollectorMessage);
    await this.collector.stop();
  }
}

module.exports = AgentBridge;
