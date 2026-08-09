const assert = require('assert');
const CloudTranscriptionProvider = require('../src/voice/providers/cloud-transcription-provider');

async function main() {
  let requestDetails;
  const provider = new CloudTranscriptionProvider({
    apiKey: 'provider-secret',
    baseUrl: 'https://example.test/v1',
    model: 'gpt-4o-transcribe',
    language: 'zh',
    inputFormat: 'opus'
  }, {
    async request(details) {
      requestDetails = details;
      return { text: 'provider text' };
    }
  });

  assert.equal(provider.getStatus().provider, 'api');
  assert.equal(provider.getStatus().acceptsAudio, true);
  await provider.start();
  await provider.appendAudio(Buffer.from([0x01, 0x02, 0x03]));
  const result = await provider.stop();
  assert.equal(result.text, 'provider text');
  assert.equal(requestDetails.url.pathname, '/v1/audio/transcriptions');
  assert.equal(requestDetails.headers.Authorization, 'Bearer provider-secret');
  assert.match(requestDetails.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  assert.match(requestDetails.body.toString('utf8'), /name="model"/);
  assert.match(requestDetails.body.toString('utf8'), /gpt-4o-transcribe/);

  const unavailable = new CloudTranscriptionProvider({ baseUrl: 'https://example.test/v1' });
  await assert.rejects(() => unavailable.start(), /requires an API key/);

  const failing = new CloudTranscriptionProvider({
    apiKey: 'provider-secret',
    baseUrl: 'https://example.test/v1',
    model: 'gpt-4o-transcribe',
    inputFormat: 'pcm16'
  }, {
    async request() { throw new Error('remote error provider-secret'); }
  });
  await failing.start();
  await failing.appendAudio(Buffer.from([0x01, 0x02]));
  await assert.rejects(
    () => failing.stop(),
    (error) => error.message.includes('[redacted]') && !error.message.includes('provider-secret')
  );

  let canceledRequests = 0;
  const canceled = new CloudTranscriptionProvider({
    apiKey: 'provider-secret',
    baseUrl: 'https://example.test/v1',
    model: 'gpt-4o-transcribe',
    inputFormat: 'pcm16'
  }, {
    async request() {
      canceledRequests += 1;
      return { text: 'unexpected transcription' };
    }
  });
  await canceled.start();
  await canceled.appendAudio(Buffer.from([0x01, 0x02]));
  const canceledStatus = await canceled.cancel();
  assert.equal(canceledStatus.active, false);
  assert.equal(canceledStatus.processing, false);
  assert.equal(canceled.chunks.length, 0);
  assert.equal(canceled.totalBytes, 0);
  await canceled.stop();
  assert.equal(canceledRequests, 0);

  console.log('cloud transcription provider tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
