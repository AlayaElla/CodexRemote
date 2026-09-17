# ESP32 Wi-Fi 麦克风

ESP32 麦克风 → Wi-Fi / Opus → CodexRemote 音频桥 → CABLE Input → CABLE Output → Codex 原生听写。

虚拟 Micro 的 HID 按键与音频是两条独立通道。HID 连接成功表示可以控制听写按键，语音设置中的音频计数和音量表示 Windows 收到了 ESP32 声音；实际识别结果以 Codex 为准。

## 设置

1. 从 [VB-Audio 官网](https://vb-audio.com/Cable/) 下载 VB-CABLE，解压后以管理员身份运行 `VBCABLE_Setup_x64.exe`。按安装器提示完成安装和重启。VB-CABLE 由 VB-Audio 提供，采用 donationware 授权，支持向作者捐赠；它是单独安装的音频驱动。
2. 更新 ESP32 固件和 CodexRemote Windows 程序。两端均需要支持 ESP32 音频协商。
3. 在 CodexRemote 的“语音输入”中选择“虚拟 Codex Micro”，麦克风来源选择“ESP32 麦克风（Wi-Fi）”。刷新音频设备，选择 CABLE Input，或保留自动选择，再保存。
4. 在 Codex 的麦克风设置中选择 `CABLE Output (VB-Audio Virtual Cable)`。Windows 的普通声音输出仍选择原来的扬声器。VB-CABLE 官方说明安装后 Windows 可能更改默认音频设备，请检查输出设置。
5. 连接 Micro，在 ESP32 上选择任务或新建任务后按住说话。松开后自动请求发送；已选任务正在执行时请求引导。新建草稿首次提交后，从任务列表选中该任务再继续。

音频桥只向 VB-CABLE 播放端点发送声音。已保存的端点失效或自动选择有歧义时会报错，需刷新并重新选择。通道未能打开时不会开始 HID 听写。

## 音频与生命周期

固件上传 16 kHz、单声道、60 ms 的裸 Opus 帧。PC 仅在按住说话会话中解码播放；固件收到同一 `requestId` 的 `recording`，且 `audioSource="esp32"`、`acceptsAudio=true` 后才开始采集。旧 PC 的 Micro 响应不包含这两个字段，固件保持原有行为。

从 PC 0.1.5 起，连接 Micro 后会提前打开静音的 Windows 音频通道。准备完成后按下设备按钮可直接使用通道；正常结束后复用音频进程并为下一次说话准备通道。准备阶段不会触发听写或启动 ESP32 麦克风。刚连接、刚取消或连续快速开始新一轮时，仍可能需要等待通道准备完成。

松开后固件排空已有 Opus 帧，再发送 `voice_end`；PC 等待音频输出排空后，先触发原生听写发送或引导，再松开 HID。取消、断线或进程故障会丢弃待播音频并释放按键。音频只在内存中转发，不落盘。API 模式继续按原有配置转写。

## 检查

- Micro 未就绪：点击首页语音状态重试。
- 找不到 VB-CABLE：完成音频驱动安装后刷新音频设备。
- 音频帧始终为 0：检查两端版本、设备连接及 ESP32 采音日志。
- 帧数增加但音量很低：检查设备板载麦克风及音频输入硬件。
- 已收到有声帧但 Codex 波形平直：检查 Codex 是否选中对应的 CABLE Output。

参考：[VB-CABLE 说明书](https://vb-audio.com/Cable/VBCABLE_ReferenceManual.pdf)。
