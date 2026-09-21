# Stream To Speaker 音频线路验证

验证线路：测试音 → Stream To Speaker 虚拟扬声器 → 原版服务 → 本机 HTTP 音频流。

原版服务使用已签名驱动读取音频；本项目只读取服务公开的 `/stream.raw`，并验证其中的 997 Hz 测试音。全部音频保留在内存中。

## 依赖与使用

1. 从 [Stream To Speaker 官方发布页](https://github.com/Mihonarium/StreamToSpeaker/releases/tag/v0.1.7) 安装原版 0.1.7。
2. 退出原版程序，使测试程序可以启动一个独立服务实例。
3. 在仓库根目录执行：

```powershell
dotnet run --project native/stream-to-speaker-probe/StreamToSpeakerProbe.csproj -c Release -- --self-probe
```

测试选择唯一启用的 Stream To Speaker 播放端点，最多发送 6 秒、1% 数字幅度的测试音。原版服务以 `--source driver` 启动，仅监听随机的 `127.0.0.1` 端口，传入 `--no-discovery` 且不开启网页管理。测试读取 4 秒 PCM，验证 WAV 格式及目标频率，输出 JSON。退出时结束本次测试启动的服务进程。原版 0.1.7 仍会记录 AirPlay 发现启动日志。

验证实际音频桥的 Opus 编码、无声启动、正常停止及进程退出清理：

```powershell
dotnet build native/esp32-audio-bridge/Esp32AudioBridge.csproj -c Release
dotnet run --project native/stream-to-speaker-probe/StreamToSpeakerProbe.csproj -c Release -- --bridge-probe native/esp32-audio-bridge/bin/Release/net9.0-windows/win-x64/Esp32AudioBridge.dll
```

退出码：0 表示测试音成功经过驱动与原版 HTTP 服务；1 表示缺少依赖、格式不符、超时或信号验证失败；2 表示参数错误。实际 Codex 和 ESP32 通话需要另行验证。

## 分发边界

[原版二进制许可](https://github.com/Mihonarium/StreamToSpeaker/blob/v0.1.7/LICENSE-BINARIES.md) 允许下载、安装和使用原版程序，要求驱动配合其原版服务使用，并禁止把发布版二进制重新分发或捆绑到其他安装器。因此原版程序是独立安装的依赖；此目录只包含我们自己的测试源代码和 NuGet 依赖声明。

## 2026-09-21 验证记录

- C# Release 构建通过，0 个警告、0 个错误。
- 官方 `StreamToSpeakerSetup-0.1.7.exe` SHA-256 与 GitHub 发布元数据一致：`f310e278ef61380b5a1adb06c3f44c7eacae8398034824c6d181bdbec1120ac7`。
- 安装包的 Authenticode 校验通过，发布者为 `High Expected Value LTD`。
- 原版安装完成，安装器退出码为 0，无需重启。已安装驱动的 `signtool verify /kp /c` 校验通过，证书发布者为 Microsoft Windows Hardware Compatibility Publisher。
- 原版服务成功打开驱动：`proto=1 build=8`。
- HTTP 自测通过：176400 帧、44100 Hz，997 Hz 幅度 `0.010000012573404132`，RMS `0.00707108493962794`。
- 音频桥集成测试通过：无声启动 426 ms；收到 175 个 16 kHz/单声道/20 ms Opus 包，解码后的 997 Hz 幅度 `0.008187930113517795`；正常停止、再次启动、音频桥被终止后的子服务清理均通过，0 个故障事件。
- 安装时 Windows 自动切换了默认播放设备的 console/multimedia 两个角色，已恢复；六项默认音频角色与安装前一致。
- C# 自测（含上游 WAV 格式拒绝检查）通过，JavaScript 回答采集专项测试 4/4 通过。
- 项目已自动为 Stream To Speaker 输出选择原版 HTTP 服务源，并复用现有重采样及 Opus 编码。原版程序单独安装；实际 Codex 与 ESP32 通话尚待验证。
