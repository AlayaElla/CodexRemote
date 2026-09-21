# Micro 控制与回答音频驱动

## 目标与数据流

驱动安装器统一管理 Micro 控制驱动与 `CodexRemote Speakers` 虚拟扬声器。用户执行一次安装、更新或删除，界面报告两个组件各自的结果。

- 控制：ESP32 → CodexRemote → Micro HID 驱动 → Codex。
- 麦克风：ESP32 → CodexRemote 音频桥 → VB-CABLE Input → VB-CABLE Output → Codex。
- 回答：Codex → CodexRemote Speakers → WASAPI loopback → 音频桥 → ESP32。

Windows 默认扬声器和默认麦克风由用户配置；专用回答输出不应成为安装器改变全局默认设备的理由。回答线路与麦克风注入线路独立。

## 组件边界

现有 Micro 使用 UMDF2/VHF，负责 HID 报告。虚拟扬声器使用独立 Windows 音频驱动和硬件标识 `ROOT\CodexRemoteVirtualAudio`。音频桥负责重采样、Opus 编码和设备传输，内核驱动只处理音频端点及其必要的缓冲与时序。

首次实现只提供回答用的播放端点。WASAPI loopback 必须返回实际播放的样本；设备枚举成功、音量条活动或测试波形生成都不能代替这项验证。

## 安装与删除要求

1. 两个包的身份、哈希、catalog 成员关系和各自签名要求全部预检通过后，才能开始安装。
2. Micro 的本地开发签名流程不能自动适用于新增的内核音频驱动。音频签名不合要求时，应明确报告原因，保留已安装组件。
3. 安装中途失败要报告每个组件的实际状态，避免将部分安装称为全部成功。
4. 删除分别尝试两个精确硬件标识对应的本产品组件；其中一个不存在或失败时，仍然处理另一个。
5. 任一组件需要重启时，汇总结果应保留重启提示。仅在两者都确认移除后报告全部删除成功。
6. 删除不能依赖当前磁盘上的驱动包仍然存在，也不能因包缺少签名而拒绝清理已安装组件。
7. DriverStore 包和开发证书的移除必须遵守所有权及共享引用检查。VB-CABLE、网易和 Steam 等音频设备不属于该安装器的删除范围。

## 验收层次

| 层次 | 需要的证据 |
| --- | --- |
| 安装器逻辑 | 双包预检、部分安装失败、单组件缺失、删除一方失败仍处理另一方、重启结果汇总的专项测试 |
| 构建 | 音频 SYS/INF/CAT、Micro DLL/INF/CAT 和安装器产物；INF 校验与包完整性检查 |
| 驱动加载 | 获得适用签名后，在目标 Windows 验证两个设备实例、服务和音频端点 |
| 本机音频 | 仅向明确选择的专用虚拟扬声器发送内存测试信号，从 loopback 捕获并验证尾部标记；超时或无信号为失败 |
| 设备通话 | Codex 回答仅在 ESP32 播放，麦克风不收到自身回答；结束、断线、重连和卸载后的错误提示正确 |

构建通过不等于加载通过；本机音频通过不等于 ESP32 实时通话通过。验证记录应写明实际完成的层次。

## 当前验证状态（2026-09-21）

音频驱动已通过 WDK 构建、InfVerif 与 Inf2Cat。当前端点限定为 Windows 11
22000+、x64、48 kHz/16-bit/双声道，KMDF 绑定为 1.33。代码审查核对了
唯一 render 端点、wave/topology pin 连接和 Windows Audio Engine loopback 设计。

扬声器选择界面的保存值保留、设备缺失提示和并发刷新测试通过。独立音频探测器
的信号判定、格式解码和超时逻辑测试通过；当前未安装目标端点时，真实探测返回
`unavailable`。这不是实际音频传输通过的证据。

安装器的 Windows 驱动签名策略检查已用现有 VB-CABLE 已签名 catalog 验证可接受，
用新生成的未签名音频 catalog 验证会拒绝。当前开发音频包尚未取得 Microsoft
签名，也未执行系统安装、卸载、真实 loopback 或 ESP32 通话验证。

组合安装器的自测已覆盖预检失败零变更、安装中途失败、卸载一侧抛异常继续另一侧、
已不存在、同一组件失败并要求重启，以及 Micro 删除节点后 OEM 包清理失败仍保留
重启需求。发布构建不包含本地自测入口。完整双驱动构建与 NativeAOT 发布通过，
生成 `build/driver/CodexRemote-Drivers-0.2.1-x64.zip`；包内两组三件套已逐项核对
安装器编译时的 SHA-256 清单与构建原文件，音频上游许可证亦已随包保留。

## 参考

- [Microsoft SysVAD 示例](https://learn.microsoft.com/en-us/samples/microsoft/windows-driver-samples/sysvad-virtual-audio-device-driver-sample/)：提供音频驱动结构；示例默认的捕获与 loopback 测试音不能直接当作实际音频传输。
- [WASAPI loopback](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)：说明播放端点的回环捕获。
- [Windows 驱动签名策略](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/kernel-mode-code-signing-policy--windows-vista-and-later-)：新增内核驱动的签名要求。
