# ESP32 音频通道预热恢复

日期：2026-09-14。PC 程序版本：0.1.12。

此前的预热仍存在，但只在 Micro 连接完成、正常录音结束和已连接时保存配置后触发。首次预热失败、空闲音频故障或取消录音清理通道之后，没有持续恢复机制，下一次按住说话可能重新等待端点初始化。

现在启动 Micro 连接时同时准备音频，不再等待 HID 握手完成；保存 ESP32 音频配置也会启动准备。空闲时每 2 秒检查通道，已就绪时保持原端点，缺失时重新准备。并发检查共享准备状态，清理期间、录音中、按键释放不确定时不会重新准备；退出时停止检查并清理通道。

预热仅打开静音输出和解码器，不触发 HID PTT，不允许上传音频，也不要求 ESP32 提前采集麦克风。已关闭 helper 的异步 EPIPE 和进程错误由原有运行实例检查隔离，不会使进程崩溃或影响替代 helper。

## 验证

以下测试通过：

- `test/virtual-micro-provider.test.js`：连接等待期间预热、失败重试、已就绪复用、取消后恢复、空闲故障恢复、恢复后清除音频错误、启动及清理中的互斥、释放不确定保护、退出清理。
- `test/esp32-audio-bridge.test.js`：准备后复用、准备期间拒绝音频、取消后的迟到响应、端点切换、旧进程迟到错误隔离。
- `test/voice-recognizer.test.js`、`test/device-voice-session.test.js`、`test/virtual-micro-lifecycle.test.js`、`test/virtual-micro-main-ipc.test.js`、`test/service-lifecycle.test.js`。
- `test/pc-packaging.test.js`。

这些是 PC 端自动化验证，尚未证明 ESP32 按钮到实际录音的端到端延迟。音频尚在后台准备时立即按下，仍需等剩余准备时间；任务窗口核验耗时保持原有行为。

交付文件：`build/pc/CodexRemote-Portable-0.1.12.exe`。本次不需要更新 ESP32 固件。

`npm run package` 成功。构建阶段的 `app.asar` 中，音频 provider 和音频 bridge 两个源码文件与本次验证源码逐字节一致，包内版本为 0.1.12。可执行文件大小为 68,579,821 bytes。当前运行中的旧版未自动重启；退出旧版后启动新包生效。
