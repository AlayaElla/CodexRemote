# Codex Remote · macOS

用 ESP32 远程操作 Mac 上的 Codex：选择任务、按住说话、查看回复，以及实验性的实时语音通话。

## 使用前准备

- macOS 13 或更新版本，已安装并登录 Codex。
- Node.js 22 或更新版本，供独立启动器使用。
- ESP32 与 Mac 连接同一个局域网。
- 使用 ESP32 麦克风需要 BlackHole；实时语音需要两条独立线路，建议安装 **BlackHole 2ch 和 BlackHole 16ch**。

Mac 的 Micro 连接使用进程内 Shim，不需要 Windows HID 驱动、VB-CABLE 或 .NET。

## 安装 BlackHole

从 [BlackHole 官网](https://existential.audio/blackhole/) 获取安装包。没有 Homebrew 时，直接双击 `.pkg` 安装即可。

也可以使用 Homebrew 官方配置中列出的厂商安装包：

- [BlackHole 2ch 0.7.1](https://existential.audio/downloads/BlackHole2ch-0.7.1.pkg)（[来源](https://formulae.brew.sh/cask/blackhole-2ch)）。
- 16ch 下载信息见 [Homebrew 官方配置](https://formulae.brew.sh/cask/blackhole-16ch)。已有 16ch 时保留，只需增加 2ch。

安装完成后按安装器提示重启 Mac，再刷新桥接中的音频设备。

## 安装与启动

1. 打开适合本机架构的 `CodexRemote-<版本号>-mac-<架构>.dmg`，将应用复制到“应用程序”。Apple Silicon 选择 `arm64`，Intel 选择 `x64`。
2. 保存工作，完全退出 Codex 和 Codex Remote。
3. 双击 [启动Codex.command](scripts/启动Codex.command)，等待显示“本地调试接口已验证”。该文件需要单独保留，不包含在安装包内。
4. 打开 Codex Remote。

每次完全退出 Codex 后，都需要通过独立启动器重新开启本地调试接口。详见 [macOS 启动器说明](docs/macos-inspector-startup.md)。

## 连接 ESP32

1. 在 Codex Remote 的基础配置中设置设备认证 Token，点击“重启服务”。
2. 在 ESP32 的 **Codex → 菜单 → 连接** 中选择“局域网”，填写相同 Token 并连接。
3. 在桥接语音设置中选择“虚拟 Codex Micro”，点击“检查并连接”，等待 Micro 连接及任务同步。

## 按住说话

1. 将麦克风来源设为“ESP32 麦克风（Wi-Fi）”。
2. 点击“刷新音频设备”，在“macOS 音频通道”选择 **BlackHole 2ch**，保存设置。
3. 在 Codex 中将麦克风选为同一个 **BlackHole 2ch**。
4. 在 ESP32 选择任务，按住说话，等提示后讲话，松开发送。

只使用按住说话时，一条 BlackHole 线路即可。也可将来源设为“电脑麦克风”，并在 Codex 中选择实际麦克风；这种方式不需要 BlackHole。

## 实时语音（实验性）

实时语音使用 ESP32 麦克风，并将 Codex 的回答回传到 ESP32 扬声器。

| 桥接设置 | 建议选择 |
| --- | --- |
| 麦克风来源 | ESP32 麦克风（Wi-Fi） |
| macOS 音频通道 | BlackHole 2ch |
| 实时语音 · Codex 回答音频设备 | BlackHole 16ch |

点击两个刷新按钮，分别选择设备后保存。**上下两个下拉框不能选择同一个 BlackHole。** 实时语音必须明确选择麦克风线路，不能使用“自动选择”。无需修改系统默认扬声器。

连接设备和 Micro 后，选择已有任务，在 ESP32 菜单进入“实时语音”。当前任务需要有可用的“开始语音聊天”入口；任务正在运行时该入口可能不显示。首次采集如出现音频权限提示，需要允许访问所选虚拟输入。

当前采用轮流说话：助手回答期间暂停麦克风上传，回答结束后恢复。自然插话和回声消除尚未验证。

## 验证状态与已知问题

- 自动化回归测试、Mac 原生语音状态读取、BlackHole 合成音往返及重启采集已通过。
- 当前 Mac 原生语音适配针对客户端 `26.915.31945`；客户端升级后可能需要重新适配。
- 已收到 ESP32 扬声器声音偏糊的实际反馈，降低音量后仍存在。原因尚未确定，音质问题暂未修复。
- 合成音测试不等于完整设备通话验收；音质、长时间通话、断线恢复仍需进一步实测。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 提示 `brew: command not found` | 没有安装 Homebrew；使用 BlackHole 的 `.pkg` 安装包即可 |
| 两个列表都只有 BlackHole 16ch | 安装 BlackHole 2ch，重启后刷新；两个下拉框代表用途，不是两条独立设备 |
| 调试接口不可用 | 保存工作并退出 Codex，再通过独立启动器打开 |
| ESP32 找不到 Mac | 检查同一局域网、Token、防火墙；默认端口为 TCP 8765、UDP 8766 |
| 有麦克风音频但没有转写 | 确认桥接与 Codex 选择同一个 BlackHole 麦克风设备 |
| 实时语音无法启动 | 检查两条独立线路、当前任务的语音入口及客户端版本 |

## 从源码打包

需要 Node.js 与 Xcode 命令行工具。在项目根目录执行：

```sh
npm ci
npm run package:mac
```

脚本会构建样式、下载并校验固定版本的 Opus、编译音频 helper，并生成 DMG 和 ZIP。安装包输出到 `build/mac/`，目标机器无需 Homebrew。

## 更多文档

- [macOS 功能与用法](docs/macos-support.md)：详细配置、源码运行与测试。
- [macOS 音频桥](native/macos-audio-bridge/README.md)：音频输入、回答采集与 helper 协议。
- [macOS Micro 接口](native/macos-virtual-micro/README.md)：Shim 与 HID 探针。
- [Windows 主分支说明](https://github.com/AlayaElla/CodexRemote/blob/main/README.md)。
