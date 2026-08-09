class VoiceProvider {
  constructor(id) {
    if (!id) throw new Error('Voice provider id is required');
    this.id = id;
    this.active = false;
  }

  getStatus() {
    return {
      provider: this.id,
      supported: true,
      configured: true,
      active: this.active,
      acceptsAudio: false
    };
  }

  async start() {
    throw new Error(`${this.id} does not implement start()`);
  }

  async appendAudio() {}

  async stop() {
    throw new Error(`${this.id} does not implement stop()`);
  }
}

module.exports = VoiceProvider;
