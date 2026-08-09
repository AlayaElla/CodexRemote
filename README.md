# Codex Remote PC Bridge

这是一个面向 Windows 的 Electron PC Bridge：把 BLE、WebSocket 和 UDP 设备消息接入已经打开的 ChatGPT Desktop 窗口，并把语音、文本与状态结果回传给设备。它只操作用户当前可见的桌面窗口，不启动 Codex CLI，不保存或管理会话。

## 功能范围

- UDP `8766` 局域网发现，WebSocket `8765` 设备通道（可配置 Bearer Token）。
- BLE、WebSocket 设备传输，以及文本、状态和 Opus 音频消息。
- Windows UI Automation：聚焦 ChatGPT Desktop 编辑器、提交文本、结束当前回合。
- Codex Hook 本地收集器，默认只监听回环地址 `127.0.0.1:7777`。
- 两种语音输入：ChatGPT Desktop 原生语音快捷键，或 OpenAI-compatible 转写接口。

## 目录

```text
src/                    Electron 主进程、传输、语音和 UI
src/platform/           Windows UI Automation PowerShell helper
hooks/                  Codex Hook 命令入口和说明
test/                   Node.js 自动化测试与手工设备测试
assets/                 应用图标
scripts/package-pc.*    Windows portable 打包脚本
```

## 环境与安装

需要 Windows、Node.js（建议当前 LTS）和 npm。运行时必须安装、登录并打开 ChatGPT Desktop；UI Automation 不会控制隐藏或未打开的窗口。

```powershell
npm ci
```

开发运行：

```powershell
npm run dev       # 先构建 CSS，再启动开发窗口
npm start         # 生产模式启动
```

## 语音与 Hook 行为

原生语音模式下，开始录音会聚焦会话编辑器并发送一次语音快捷键，结束录音再发送一次。默认快捷键是 `Ctrl+Shift+R`，应与 ChatGPT Desktop 的 Voice 设置保持一致。释放后程序会进入 `recognizing`，通过同一个 UI Automation helper 等待编辑器出现稳定的非空文本（默认 450 ms，超时 15 s），再进入 `submitting` 并只按一次 Enter；超时、读取失败或编辑器选择失败会报告 `error`，不会误提交。

API 模式会收集 ESP32 音频帧，向用户配置的 OpenAI-compatible `/audio/transcriptions` 接口发送 multipart 请求，再把转写结果提交到当前 ChatGPT Desktop 会话。Base URL、API key、模型、语言和音频格式均来自运行时设置或环境变量，不应写入仓库。

PC 是设备按钮状态的唯一来源，会发送 `preparing`、`recording`、`recognizing`、`submitting`、`submitted`、`error` 等 `voice_status` 阶段；`requestId` 防止旧录音的迟到回复覆盖当前状态。语音开始和结束命令串行执行，避免慢速桌面聚焦与释放事件竞争。

Codex 生命周期 Hook 在 `Stop` 时提供最终助手文本，但没有独立的进行中 commentary 事件。Hook collector 在回合活动期间只读 Hook 提供的 `transcript_path`，转发 `phase: commentary` 记录为普通 `chat` 消息，并在 `Stop` 后释放 watcher；工具调用和结果保留给 PC 诊断，不转发到 ESP32。

## 测试

```powershell
npm test
```

`test/manual/` 下的 BLE 与 WebSocket 用例需要真实设备或等价本地服务，不会由默认测试脚本自动执行。

## 构建与打包

推荐使用仓库内脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-pc.ps1
```

也可以直接使用 npm：

```powershell
npm run package     # electron-packager，输出 build/pc/unpacked/
npm run portable    # electron-builder portable 目标
```

所有产物写入本仓库的 `build/pc/`，该目录不会提交。打包会把 `src/platform/windows-uia.ps1` 从 ASAR 解包，以便运行时调用 PowerShell；若已有 Codex Remote 进程占用输出目录，请先关闭再重试。

构建或打包成功只代表本机工具链完成，不代表 ChatGPT Desktop、BLE/网络设备或真实硬件已经完成端到端验证。

## 配置与安全边界

服务 Token、语音 API key、Hook 端口和 WebSocket 端口通过应用设置或环境变量配置。Token、API key、Electron `userData`、transcript、日志和真实设备信息都属于运行数据，禁止提交到 Git 或公开 issue。不要把 Hook 回环地址映射到局域网或公网；公开发布前应按实际依赖补充仓库许可证声明。

