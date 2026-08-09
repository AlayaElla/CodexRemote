/**
 * WebSocket 通信自动化测试脚本
 */
const WebSocket = require('ws');
const WsServer = require('../../src/transports/ws-server');

async function runWsTests() {
  console.log('=' .repeat(60));
  console.log('WebSocket 通信测试');
  console.log('=' .repeat(60));

  const server = new WsServer(8765);
  let serverReceivedJson = null;
  let serverReceivedAudio = null;
  let clientReceivedJson = null;

  server.on('device-message', (msg) => {
    serverReceivedJson = msg;
  });

  server.on('device-audio', (data) => {
    serverReceivedAudio = data;
  });

  try {
    // 1. 启动服务器
    console.log('1. 启动 WebSocket 服务器...');
    await server.start();
    console.log('   ✓ 服务器在 8765 端口成功启动\n');

    // 2. 模拟客户端连接
    console.log('2. 模拟 ESP32 设备连接服务器...');
    const wsClient = new WebSocket('ws://localhost:8765');

    await new Promise((resolve, reject) => {
      wsClient.on('open', resolve);
      wsClient.on('error', reject);
    });

    wsClient.on('message', (data) => {
      clientReceivedJson = JSON.parse(data.toString());
    });

    console.log('   ✓ ESP32 客户端成功连接服务器\n');

    // 3. 测试客户端发送 JSON 控制指令
    console.log('3. 测试发送 JSON 控制消息...');
    const testJson = { type: 'text_input', text: 'Hello Codex Remote' };
    wsClient.send(JSON.stringify(testJson));

    await new Promise(r => setTimeout(r, 100));

    if (serverReceivedJson && serverReceivedJson.text === 'Hello Codex Remote') {
      console.log('   ✓ JSON 控制消息接收成功\n');
    } else {
      throw new Error('JSON 消息发送/接收失败');
    }

    // 4. 测试客户端发送二进制 Opus 音频帧
    console.log('4. 测试发送二进制 Opus 音频帧...');
    const testAudioBuffer = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    wsClient.send(testAudioBuffer);

    await new Promise(r => setTimeout(r, 100));

    if (serverReceivedAudio && serverReceivedAudio.length === 5) {
      console.log('   ✓ 二进制 Opus 音频帧接收成功\n');
    } else {
      throw new Error('二进制音频帧发送/接收失败');
    }

    // 5. 测试服务器向客户端下发消息
    console.log('5. 测试服务器向 ESP32 下发响应消息...');
    const responseMsg = { type: 'chat', role: 'codex', text: 'Task Complete' };
    await server.sendToDevice(responseMsg);

    await new Promise(r => setTimeout(r, 100));

    if (clientReceivedJson && clientReceivedJson.text === 'Task Complete') {
      console.log('   ✓ 服务器下发响应成功\n');
    } else {
      throw new Error('服务器下发消息失败');
    }

    // 6. 清理退出
    wsClient.close();
    server.stop();

    console.log('=' .repeat(60));
    console.log('✓ 所有 WebSocket 通信测试通过');
    console.log('=' .repeat(60) + '\n');
    process.exit(0);

  } catch (err) {
    console.error('✗ 测试失败:', err.message);
    server.stop();
    process.exit(1);
  }
}

runWsTests();
