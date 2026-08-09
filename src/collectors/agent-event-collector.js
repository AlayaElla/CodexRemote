const EventEmitter = require('events');

class AgentEventCollector extends EventEmitter {
  constructor(type) {
    super();
    if (!type) throw new Error('collector type is required');
    this.type = type;
  }

  async start() {
    throw new Error(`${this.type} collector does not implement start()`);
  }

  async stop() {
    throw new Error(`${this.type} collector does not implement stop()`);
  }

  resolveApproval() {
    return false;
  }

  sendUserInput() {
    return {
      success: false,
      error: `${this.type} collector only observes agent events and cannot inject user input`
    };
  }
}

module.exports = AgentEventCollector;
