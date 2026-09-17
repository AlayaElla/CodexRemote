# ESP32 Wi-Fi 音频桥接

`Esp32AudioBridge.exe` 是 Windows x64 / .NET 9 的私有 JSONL helper。它只把 ESP32 传来的 16 kHz 单声道裸 Opus 解为 PCM，并经指定的 **VB-CABLE Input** 渲染端点播放；Codex 应选择对应的 **CABLE Output** 作为麦克风。它不打开默认扬声器、不录音、不保存音频，也不控制 PTT。

```powershell
dotnet run --project native/esp32-audio-bridge/Esp32AudioBridge.csproj -c Release -- --list
dotnet run --project native/esp32-audio-bridge/Esp32AudioBridge.csproj -c Release -- --defaults
dotnet run --project native/esp32-audio-bridge/Esp32AudioBridge.csproj -c Release -- --probe-cable
dotnet publish native/esp32-audio-bridge/Esp32AudioBridge.csproj -c Release -r win-x64 --self-contained false
```

发布文件为 `bin/Release/net9.0-windows/win-x64/publish/Esp32AudioBridge.exe`，需要 .NET 9 Desktop Runtime。

每行请求必须小于等于 16 KiB，均含字符串 `id` 与 `op`：

- `list` 返回 `{id,ok:true,devices:[{id,name,captureName}]}`，只列出活跃的 `CABLE Input` 渲染端点且要求对应 `CABLE Output` 捕获端点也活跃；`captureName` 是应在 Codex 选择的对应名称提示。
- `start` 可带 `deviceId`。省略或为空时只会选择唯一的 `CABLE Input`；没有或多个匹配端点均返回错误。成功后才打开该端点与开始播放。
- `append` 带 `{packet:base64}`。单包限制 4096 bytes，成功返回 `{id,ok:true,result:{packets,samples,peak,bufferedMs}}`，其中 `peak` 是 0..1 的归一化 PCM 绝对峰值。PCM 队列最多约 2 秒；溢出会取消本次会话并返回错误。
- `stop` 有界等待已缓冲 PCM 排空和 350 ms 输出尾部保护（覆盖当前 100 ms WASAPI + 约 149 ms VB-CABLE 内部延迟），再关闭端点；若超过上限仍有 PCM，会取消会话并返回失败，绝不声称已排空。自定义得更高 VB-CABLE 延迟的系统仍应以 `--probe-cable` 验收。`cancel` 立即清空并关闭，不播放尾音。EOF 也立即清理。

正常非 `list` 响应形状为 `{id,ok,result,error}`；异常事件为 `{event:"fault",error}`，其中不会含音频数据。

依赖锁定为 [NAudio 2.2.1](https://www.nuget.org/packages/NAudio/2.2.1)（MS-PL）及 [Concentus 2.2.2](https://www.nuget.org/packages/Concentus/2.2.2)（MIT）；详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。


`--defaults` 是只读快照，返回 Render/Capture 的 Console、Multimedia、Communications 默认端点 `{flow,role,id,name}`，用于 VB-CABLE 安装前后比较；helper 不提供任何修改默认设备的接口。

`--probe-cable` 仅在唯一、活动且已配对的 VB-CABLE 上运行：它在内存中创建一个末尾 1 kHz 标记的 60 ms Opus 测试音，经过与实际相同的 decode/WASAPI `CABLE Input` 路径，并从配对的 `CABLE Output` WASAPI capture 读取内存样本。尾标记未到达即失败；成功 stdout 只返回 frames、归一化 peak/rms。它不会触发 PTT、使用默认扬声器、写入音频文件或修改默认设备。
