# Codex Micro 电量同步

PC 版本：0.1.9。需要同时使用本次更新的 MetalioClaw4-AgentUI 固件。

ESP32 应用主循环读取 `Board::GetBatteryLevel`，采用与设备状态栏相同的百分比和充电标记，通过已认证的 WebSocket 向 PC 发送：

```json
{"type":"device_battery","available":true,"percentage":57,"isCharging":false}
```

无法读取电量时发送 `{"type":"device_battery","available":false}`。

- 连接或重连后，在下一次应用时钟 tick 上报，通常约 1 秒内。
- 每 5 秒检查一次；数值或充电标记变化时上报，未变化则每 30 秒重报。
- 上报不依赖 Codex 页面是否打开。发送等待上限 100ms，失败后在下一次采样重试。
- PC 校验百分比范围为 0–100、充电标记为布尔值；无效消息不延长数据有效期。
- Codex 查询 `device.status` 时，PC 将新鲜样本映射到 `battery` / `is_charging`。断线、更换设备、停止服务或 90 秒没有有效样本时，省略这两个字段，表示电量未知。
- Codex 自己控制电量刷新节奏；已检查的客户端实现约每 60 秒查询一次，录音或按键交互时可能延后。

## 本地验证

PC 仓库运行 `node test/device-battery.test.js`，检查真实数值、0%/100%、充电切换、无效数据、过期、重连、服务停止，以及应用到 HID 回复的链路。

固件仓库运行 `node scripts/test-codex-battery.cjs`，检查变化上报、30 秒重报、读取失败、快速重连和发送失败重试。

2026-09-13 本地验证结果：上述两项测试通过；Micro 编解码、控制器、语音提供者、语音配置、主进程 IPC、任务菜单、WebSocket 和 PC 打包测试通过。ESP-IDF 6.0.2 完整编译及固件打包通过，PC 0.1.9 便携版打包通过，并核对包内电量相关源码与工作区一致。未进行刷机和实机验证。

## 实机验证

1. 退出旧的 CodexRemote，启动 `build/pc/CodexRemote-Portable-0.1.9.exe`。
2. 使用固件仓库的刷机脚本刷入本次构建，保留设备配置后连接 PC。
3. 在 PC 的设备消息记录中确认收到 `device_battery`，百分比和充电标记与 ESP32 状态栏一致。
4. 等待 Codex 下一次设备状态查询，检查设置里的 Codex Micro 电量。
5. 拔插充电电源、断开和恢复设备网络连接，确认充电标记跟随设备，重连后恢复电量；断线后等待下一次 Codex 查询，应清除旧电量。

编译和离线测试不能替代上述实机检查。
