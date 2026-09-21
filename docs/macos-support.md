# macOS 功能与用法

macOS 使用进程内 Micro Shim、Unix socket 和 CoreAudio 接入 Codex，音频通过 BlackHole 输入。接口依赖 Codex 内部运行时，客户端升级可能影响兼容性。

## 使用条件

- macOS 13 或更新版本，已安装并登录 Codex。
- Node.js 22 或更新版本，用于独立启动器。
- 使用 ESP32 麦克风时安装 BlackHole。

## 安装与启动

1. 打开与 Mac 架构匹配的 `CodexRemote-<版本号>-mac-<架构>.dmg`，将应用复制到“应用程序”。也可以解压对应 ZIP 使用。
2. 保存工作，完全退出 Codex 和 Codex Remote。
3. 双击源码 `scripts/` 目录中的 `启动Codex.command`。该文件可单独复制到桌面，需要另外保留，不包含在应用安装包内。
4. 显示“本地调试接口已验证”后，打开 Codex Remote。
5. 完成设备连接，在桥接中连接 Micro，等待任务同步。

启动器参数及检查方式见 [macOS 启动器](macos-inspector-startup.md)。每次完全退出 Codex 后，需要通过启动器重新开启本地调试接口。

## 麦克风配置

### ESP32 麦克风

1. 在桥接的语音设置中选择“虚拟 Codex Micro”和“ESP32 麦克风（Wi-Fi）”。
2. 刷新音频设备，选择 BlackHole 并保存。
3. 在 Codex 中选择同一个 BlackHole 设备作为麦克风。
4. 连接 Micro 后，在设备上选择任务并按住说话。

音频路径为 `ESP32 Opus → Swift helper / libopus → CoreAudio → BlackHole → Codex`。桥接仅写入所选端点，不修改系统默认音频设备。

### Mac 麦克风

在桥接中将麦克风来源设为“电脑麦克风”，在 Codex 中选择实际麦克风。该方式不需要 BlackHole。

设备网络、Token、任务菜单和日常操作沿用[主分支用法](https://github.com/AlayaElla/CodexRemote/blob/main/README.md)。

## macOS 接入功能

| 功能 | macOS 实现 |
| --- | --- |
| Micro 连接 | 进程内 Shim 提供设备枚举及 raw64/RPC 通信，无需 Windows 控制驱动 |
| 六槽位同步 | 读取原生 Micro 状态，保留任务主机、ID、顺序和空槽 |
| 听写与控制 | Micro Shim 配合本机运行时接口处理听写、发送、取消和任务操作 |
| 本地通信 | Unix socket，并校验进程身份与连接令牌 |
| 音频输入 | Swift helper 解码 Opus，通过 CoreAudio 写入 BlackHole |

Shim 不创建系统 HID；连接状态以 Micro RPC 往返结果为准。macOS 桥接只连接已有调试接口，不向运行中的 Codex 发送 `SIGUSR1`。

## 从源码运行

需要 Xcode 命令行工具；单独构建音频 helper 时需要 `opus` 和 `pkg-config`。

```sh
npm ci
brew install opus pkg-config
npm run build:macos-audio-bridge
npm run dev
```

启动桥接前，先按启动器说明启动 Codex。

## 打包

在项目根目录执行：

```sh
npm ci
npm run package:mac
```

默认构建当前机器架构，也可显式指定：

```sh
# Apple Silicon Mac
npm run package:mac -- --arch=arm64

# Intel Mac
npm run package:mac -- --arch=x64
```

不支持跨架构编译。`npm run package` 在 Mac 上执行相同流程。

脚本下载固定版本的 Opus、校验 SHA-256，在 `build/macos-deps/` 编译，再构建样式、Swift 音频 helper 和安装包。音频 helper、libopus 和许可证随应用打包，目标机器不需要 Homebrew。

输出位于 `build/mac/`：

- `CodexRemote-<版本号>-mac-<架构>.dmg`
- `CodexRemote-<版本号>-mac-<架构>.zip`

没有开发者证书时使用临时签名；通过 `CSC_LINK` 或 `CSC_NAME` 配置签名证书。公证需要另行配置 Apple 凭据。

查看脚本帮助：

```sh
npm run package:mac -- --help
node scripts/start-codex-with-inspector-macos.js --help
```

## 常见问题

| 问题 | 处理方式 |
| --- | --- |
| 调试接口不可用 | 完全退出 Codex 和桥接，再运行独立启动器 |
| 9229 端口被占用 | 检查已有 Codex 实例或占用端口的程序 |
| 找不到 BlackHole | 安装后刷新音频设备并重新选择 |
| 有音频但没有转写 | 确认 Codex 与桥接选择同一个 BlackHole 设备 |
| Micro 已连接但任务未同步 | 检查调试接口、Codex 当前窗口及版本兼容性 |

macOS 设备端语音全流程仍需实机确认。端口验证或 Micro 握手成功仅代表对应接口可用。

## 实时语音（实验性）

已同步主分支 `da96bc1` 的原生语音会话控制，支持当前 Mac 客户端
`26.915.31945`。开始、静音和结束通过实际承载语音的窗口执行；资源版本
不匹配时会拒绝启动，不尝试使用未知接口。仍需通过独立启动器开启 Inspector。

1. 安装两条独立 BlackHole 线路，例如 BlackHole 2ch 和 BlackHole 16ch。
2. 在桥接语音设置中，将音频来源设为 ESP32 麦克风，并明确选择一条
   BlackHole 麦克风设备（实时语音不能使用“自动选择”）。
3. 刷新 Codex 回答音频设备，选择另一条 BlackHole 并保存。两条线路不能
   指向同一设备；不需要修改系统默认输出。
4. 连接设备和 Micro，选中已有任务，在设备菜单中启动“实时语音”。
   当前任务必须提供可用的“开始语音聊天”入口；任务正在运行时该入口可能不显示。

音频路径：

```text
ESP32 → 16 kHz / 60 ms Opus → Swift 解码 → BlackHole A → Codex
Codex → BlackHole B → CoreAudio 采集与重采样 → 16 kHz / 20 ms Opus → ESP32
```

第一次采集可能需要允许麦克风权限；此处采集的是明确选择的 BlackHole
虚拟输入。当前为轮流说话，回答期间暂停 ESP32 麦克风上行，不承诺自然插话。

### 本机验证

`node scripts/check-macos-audio-bridge.js` 检查 helper 协议。
`node --test scripts/tests/*.test.js` 覆盖会话归属、路由、启动失败清理、
Mac Inspector 身份验证等行为。

合成音回传探测（仅选一条空闲的 BlackHole 用作测试回环，不代表通话配置）：

```sh
python3 scripts/probe-macos-realtime-audio.py <BlackHole设备UID> <libopus.0.dylib路径>
```

该探测器仅发送合成的 440 Hz 测试音，不读取真实麦克风，不保存音频。
验证 16 kHz 单声道、每帧 320 样本、Opus 解码、目标频率与停止后重启。

2026-09-21：本机 BlackHole 16ch 的合成音往返通过（128 帧有效音频），
并成功读取 Mac 客户端原生语音状态。完整 Codex/ESP32 双向通话尚未验收：
本机只有一条 BlackHole，且正在执行任务的界面没有可用的开始语音按钮。
