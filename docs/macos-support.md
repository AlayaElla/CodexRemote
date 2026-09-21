# macOS 支持实施说明

## 约束

- Windows 0.2.1 的已用功能是行为基线，macOS 不能通过删减 Windows 路径来实现。
- 不启动 Codex App Server，也不要求用户打开远程服务。
- Codex Remote 仍在本机运行；ESP32 继续通过现有局域网 WebSocket 传输 Opus 和控制消息。
- 任务同步直接连接本机 Codex 进程。Windows 使用 PowerShell/WMI 与 Node inspector；macOS 使用 `ps` 发现原生 app 主进程、Node inspector 临时注入和 Unix domain socket。inspector 只负责建立窄接口，随后关闭。
- 音频只写入用户明确选择的虚拟音频端点，不修改系统默认输入或输出。

## 分层

```text
ESP32
  |  Wi-Fi / WebSocket（现有协议）
  v
Codex Remote Electron
  |-- Task plane ---- macOS Codex process -> temporary inspector -> Unix socket
  |-- Control plane - Codex renderer/runtime commands（已接入，待 Mac 实机验证）
  `-- Audio plane --- Swift helper -> libopus -> CoreAudio -> BlackHole -> Codex microphone
```

这里借鉴了 [open-voice-bridge](https://github.com/nijez/open-voice-bridge) 的设备音频经 CoreAudio
进入 BlackHole、再由目标应用当作麦克风读取的边界设计。该项目采用 GPL-3.0；本仓库不复制其源代码，
macOS helper 依据本仓库现有 JSONL 协议、CoreAudio 公共 API 和 libopus 独立实现。

## Windows 对齐矩阵

| 能力 | Windows 基线 | macOS 当前分支 | macOS 放行条件 |
| --- | --- | --- | --- |
| ESP32 发现与连接 | 可用 | 复用现有 Node 服务 | 局域网实机回归 |
| Opus 音频解码 | Concentus | Swift helper + libopus 已落源码 | arm64/x64 编译和坏包/溢出测试 |
| 虚拟麦克风输出 | VB-CABLE/WASAPI | BlackHole/CoreAudio 已落源码 | 末帧、取消、连续录音实测 |
| 六槽任务读取 | Windows 进程发现 + inspector + named pipe | `ps` + inspector + Unix socket 已接平台分支 | 当前 Codex 版本实机探测 |
| 任务状态流 | `codex-ipc` named pipe | 已接 `CODEX_HOME/ipc/ipc.sock`；复用快照、patch、重连 | Mac 当前版本实际握手和任务订阅 |
| PTT、发送与取消 | 虚拟 HID broker / Escape | 已接本机 renderer 听写消息和命令；录音状态确认 | 设备 PTT、首次启动、连续录音和取消实测 |
| 任务切换、新任务与绑定 | Micro 按键与原生当前页身份 | 已接深链切换、命令创建、当前页与 binding 校验 | 六槽顺序、空槽、草稿绑定实测 |
| 文本、停止、审批 | 原生输入、Escape、已有 IPC | 已接 Mac 文本输入、Escape；复用 IPC 审批 | 已有文字保留、停止、审批和问题回答实测 |
| 模型、推理强度与 Fast | 绝对值 IPC 设置及确认 | 复用同一状态流和设置路径 | Mac 当前模型清单及设置回读 |
| 设置界面 | VB-CABLE、驱动/HID 诊断 | 已区分 BlackHole 和本机控制接口状态 | Mac 窗口实际显示检查 |
| 打包 | win-x64 portable | 本轮不执行 | 功能验收后另行安排 |

macOS 仍处于 bring-up 状态。在“任务同步、控制、语音”三个实机 Gate 全部通过前，产品状态不得宣称 macOS 可用。

## 已落地的第一阶段

1. 音频 helper 路径按 `win32` / `darwin` 分流；Windows 的文件名和开发路径保持不变。
2. Codex home 改用 Node 的跨平台 home 目录解析。
3. `CodexMicroSlots` 增加 macOS 主进程发现和 Unix socket 地址，保留原 Windows PowerShell/WMI 实现。
4. 新增原生 Swift audio helper，复用 Windows 的 `list/start/append/stop/cancel/discard` JSONL 合约：
   - 16 kHz、单声道、单包最多 4096 bytes；
   - PCM 队列最多 2 秒；
   - `stop` 等待播放完成并保留 350 ms 尾部保护；
   - `discard` 清空音频但保留已打开端点；
   - 只列出同时具有输入和输出通道且名称含 `BlackHole` 的设备。

## macOS 实机 Gate 0

先在与目标发布版本一致的 Mac 和 Codex 桌面版本上运行，不通过就不继续包装：

```sh
brew install opus pkg-config
npm ci
npm run build:macos-audio-bridge
native/macos-audio-bridge/.build/release/CodexRemoteMacAudioBridge
```

向 helper stdin 发送：

```json
{"id":"1","op":"list"}
```

验收记录必须包含：

- Intel/Apple Silicon 架构、macOS 与 Codex 版本；
- BlackHole 2ch 的 UID、输入/输出通道数及 Codex 中所选麦克风；
- helper 的六个操作、坏 JSON、坏 base64、坏 Opus、2 秒溢出、EOF 清理；
- Codex 主进程唯一发现、inspector 身份校验、Unix socket 读取六槽；
- inspector 建立 socket 后确实关闭，Codex 退出后 socket/helper 均清理。

## 当前验证边界

当前开发主机是 Windows。本机已经执行 Windows 回归和隔离的 Mac 控制协议测试；
这些测试不连接真实 Codex，也不证明 macOS 编译、权限或音频端到端可用。
状态流端点及 renderer 导出解析依据本机安装的 Codex 26.915.4065.0 共享源码确认，
仍必须用目标 Mac 的实际安装包核验。客户端升级后解析失败会明确报错，不猜测替代接口。

开发检查（不打包）：

```sh
node --test scripts/tests/macos-*.test.js
swift build --package-path native/macos-audio-bridge -c release
node scripts/check-macos-audio-bridge.js
```

本轮验收顺序：Mac 编译和协议检查 → 本机控制与状态流 → ESP32 语音全链路 → 异常/重连回归。
打包、签名、公证、发布均不属于本轮执行范围。

## 第二阶段进展

- 修复原生音频重复关闭、解码器重建失败后重复释放、缓存溢出后会话残留。
- AVAudioPlayerNode 接收 Float32；排空使用精确帧数和单调时钟。
- macOS socket 缩短文件名并检查 103 字节路径上限，设置仅当前用户读写权限。
- macOS 进程路径按大小写精确校验；Windows 保留忽略大小写的比较。
- 增加 `scripts/check-macos-audio-bridge.js`：检查 JSONL 请求、无会话操作、坏 UTF-8、超长行和不完整 EOF，不播放音频。
- 增加 GitHub Actions macOS 编译及协议检查工作流。目前仅写入仓库，尚未运行。

## 第三阶段：功能路径接入

- 增加 macOS 本机控制器，接入现有语音 provider、设备会话、任务控制和文本输入流程。
- 从当前安装包解析 renderer 导出，不固定压缩符号；不伪装物理 Micro 的连接状态。
- 单次操作固定任务和页面身份；串行控制，最多 32 个待处理请求；结果未知不自动重放。
- PTT 必须读到 recording 才确认开始；发送触发草稿绑定后不向新页面补发 PTT-stop。
- 控制 socket 使用随机令牌和 0600 权限；10 秒无请求自动关闭；异常关闭只尝试取消原页面听写。
- 音频 JSONL 输入与排空分离，最多排队 128 条请求；输入 EOF 可中断排空。
- CoreAudio 验证实际输出设备与存活状态；配置变化通知 fault 并清理会话，不主动切换默认音频设备。
- UI 在 macOS 显示 BlackHole 和本机接口状态，保留 Windows 原有驱动/HID 显示。

隔离测试覆盖路径、安全校验、动态符号解析、PTT、任务切换、新任务、未知结果、
socket 鉴权、锁屏拒绝、控制串行和正在执行时关闭。Windows 原有回归也通过。

仍待完成且不能用模拟测试代替：真实 Mac 的 Swift 编译、Codex 运行时接入和 ESP32 音频端到端验收。
功能相同行为的验收必须包括：切换六个槽位/空槽、新任务创建后发送并绑定、文字与多行输入、
模型/推理/Fast 回读、审批/拒绝/问题回答、停止执行、电脑麦克风/ESP32 麦克风、取消和连续录音、
设备断网、Codex 退出重启、锁屏、BlackHole 断开，以及尾帧不丢失。
