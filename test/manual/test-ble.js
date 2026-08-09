/**
 * BLE通信模拟测试
 * 验证消息协议和通信流程
 */

const EventEmitter = require('events');

// 模拟BLE设备
class MockBLEDevice extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.address = 'AA:BB:CC:DD:EE:FF';
    this.name = 'CodexRemote';
  }

  connect() {
    this.connected = true;
    this.emit('connected', { address: this.address });
    return Promise.resolve();
  }

  disconnect() {
    this.connected = false;
    this.emit('disconnected');
    return Promise.resolve();
  }

  send(message) {
    if (!this.connected) {
      throw new Error('Device not connected');
    }
    
    // 模拟延迟
    return new Promise(resolve => {
      setTimeout(() => {
        this.emit('message-sent', message);
        resolve();
      }, 10);
    });
  }

  receive(message) {
    this.emit('message-received', message);
  }
}

// 测试消息协议
function testMessageProtocol() {
  console.log('\n📡 测试消息协议...\n');
  
  const tests = [
    {
      name: '语音开始消息',
      message: { type: 'voice_start' },
      expected: '{"type":"voice_start"}'
    },
    {
      name: '语音结束消息',
      message: { type: 'voice_end' },
      expected: '{"type":"voice_end"}'
    },
    {
      name: '文字输入消息',
      message: { type: 'text_input', text: '测试消息' },
      expected: '{"type":"text_input","text":"测试消息"}'
    },
    {
      name: '审批结果消息',
      message: { type: 'approval', id: 'approval-123', approved: true },
      expected: '{"type":"approval","id":"approval-123","approved":true}'
    },
    {
      name: '聊天消息',
      message: { type: 'chat', role: 'codex', text: '执行完成' },
      expected: '{"type":"chat","role":"codex","text":"执行完成"}'
    },
    {
      name: '状态消息',
      message: { type: 'status', status: 'working' },
      expected: '{"type":"status","status":"working"}'
    },
    {
      name: '审批请求消息',
      message: { 
        type: 'approval_request', 
        id: 'approval-456', 
        question: '是否继续？' 
      },
      expected: '{"type":"approval_request","id":"approval-456","question":"是否继续？"}'
    },
    {
      name: '完成消息',
      message: { type: 'complete', sound: 'done.ogg' },
      expected: '{"type":"complete","sound":"done.ogg"}'
    },
  ];

  let passed = 0;
  let failed = 0;

  tests.forEach(test => {
    try {
      const serialized = JSON.stringify(test.message);
      if (serialized === test.expected) {
        console.log(`✓ ${test.name}`);
        passed++;
      } else {
        console.log(`✗ ${test.name}`);
        console.log(`  期望: ${test.expected}`);
        console.log(`  实际: ${serialized}`);
        failed++;
      }
    } catch (error) {
      console.log(`✗ ${test.name} - 错误: ${error.message}`);
      failed++;
    }
  });

  console.log(`\n消息协议测试: ${passed}/${tests.length} 通过\n`);
  return failed === 0;
}

// 测试BLE通信流程
async function testBLECommunication() {
  console.log('🔗 测试BLE通信流程...\n');
  
  const device = new MockBLEDevice();
  const sentMessages = [];
  const receivedMessages = [];

  // 监听发送的消息
  device.on('message-sent', message => {
    sentMessages.push(message);
  });

  // 监听接收的消息
  device.on('message-received', message => {
    receivedMessages.push(message);
  });

  try {
    // 测试连接
    console.log('1. 测试设备连接...');
    await device.connect();
    if (!device.connected) {
      throw new Error('连接失败');
    }
    console.log('   ✓ 设备已连接\n');

    // 测试发送消息
    console.log('2. 测试发送消息...');
    const testMessages = [
      { type: 'voice_start' },
      { type: 'voice_end' },
      { type: 'text_input', text: '测试' }
    ];

    for (const msg of testMessages) {
      await device.send(msg);
    }

    if (sentMessages.length !== testMessages.length) {
      throw new Error(`发送消息数量不匹配: 期望${testMessages.length}, 实际${sentMessages.length}`);
    }
    console.log(`   ✓ 成功发送 ${sentMessages.length} 条消息\n`);

    // 测试接收消息
    console.log('3. 测试接收消息...');
    const incomingMessages = [
      { type: 'chat', role: 'codex', text: '你好' },
      { type: 'status', status: 'working' },
      { type: 'approval_request', id: '1', question: '确认？' }
    ];

    for (const msg of incomingMessages) {
      device.receive(msg);
    }

    if (receivedMessages.length !== incomingMessages.length) {
      throw new Error(`接收消息数量不匹配: 期望${incomingMessages.length}, 实际${receivedMessages.length}`);
    }
    console.log(`   ✓ 成功接收 ${receivedMessages.length} 条消息\n`);

    // 测试断开连接
    console.log('4. 测试断开连接...');
    await device.disconnect();
    if (device.connected) {
      throw new Error('断开连接失败');
    }
    console.log('   ✓ 设备已断开\n');

    // 测试断开后发送消息
    console.log('5. 测试断开后发送消息（应该失败）...');
    try {
      await device.send({ type: 'test' });
      console.log('   ✗ 应该抛出错误但没有\n');
      return false;
    } catch (error) {
      if (error.message === 'Device not connected') {
        console.log('   ✓ 正确抛出错误\n');
      } else {
        throw error;
      }
    }

    console.log('✓ BLE通信流程测试通过\n');
    return true;

  } catch (error) {
    console.log(`✗ BLE通信流程测试失败: ${error.message}\n`);
    return false;
  }
}

// 测试消息分包
function testMessageChunking() {
  console.log('📦 测试消息分包...\n');
  
  const MAX_SIZE = 512;
  
  // 测试小消息（不分包）
  const smallMessage = { type: 'test', data: 'small' };
  const smallData = Buffer.from(JSON.stringify(smallMessage));
  
  if (smallData.length > MAX_SIZE) {
    console.log('✗ 小消息不应该超过限制');
    return false;
  }
  console.log(`✓ 小消息 (${smallData.length} bytes) 不需要分包`);

  // 测试大消息（需要分包）
  const largeData = 'x'.repeat(1500);
  const largeMessage = { type: 'test', data: largeData };
  const largeBuffer = Buffer.from(JSON.stringify(largeMessage));
  
  const chunks = [];
  for (let i = 0; i < largeBuffer.length; i += MAX_SIZE) {
    chunks.push(largeBuffer.slice(i, i + MAX_SIZE));
  }

  console.log(`✓ 大消息 (${largeBuffer.length} bytes) 分为 ${chunks.length} 个包`);

  // 验证每个包的大小
  for (let i = 0; i < chunks.length - 1; i++) {
    if (chunks[i].length !== MAX_SIZE) {
      console.log(`✗ 包 ${i} 大小不正确: ${chunks[i].length}`);
      return false;
    }
  }
  console.log('✓ 所有包大小正确');

  // 验证重组后的数据
  const reassembled = Buffer.concat(chunks);
  if (!reassembled.equals(largeBuffer)) {
    console.log('✗ 重组后的数据不匹配');
    return false;
  }
  console.log('✓ 数据重组正确\n');

  return true;
}

// 运行所有测试
async function runBLETests() {
  console.log('\n' + '='.repeat(60));
  console.log('BLE通信模拟测试');
  console.log('='.repeat(60));

  const results = {
    protocol: testMessageProtocol(),
    communication: await testBLECommunication(),
    chunking: testMessageChunking()
  };

  console.log('='.repeat(60));
  console.log('测试结果汇总');
  console.log('='.repeat(60));
  console.log(`消息协议: ${results.protocol ? '✓ 通过' : '✗ 失败'}`);
  console.log(`通信流程: ${results.communication ? '✓ 通过' : '✗ 失败'}`);
  console.log(`消息分包: ${results.chunking ? '✓ 通过' : '✗ 失败'}`);
  console.log('='.repeat(60));

  const allPassed = Object.values(results).every(r => r);
  
  if (allPassed) {
    console.log('\n✓ 所有BLE通信测试通过\n');
    console.log('注意: 这是模拟测试，真实BLE通信需要在实际硬件上验证');
    console.log('硬件要求: Metalio Claw4 设备 + 支持BLE的电脑\n');
    return 0;
  } else {
    console.log('\n✗ 部分测试失败\n');
    return 1;
  }
}

runBLETests().then(code => process.exit(code));
