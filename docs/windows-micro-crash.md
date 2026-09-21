# Windows Micro 连接后 Codex 闪退

2026-09-19 的本机转储记录了 `0x80000003`，致命消息为
`Invoke in DisallowJavascriptExecutionScope`。在故障调用链中，反汇编显示
构造 `{cmd: "NODE_DEBUG_ENABLED"}`，然后发送 `internalMessage`。
这一序列对应 Node 的 `NotifyClusterWorkersDebugEnabled`，由 inspector
`Agent::StartIoThread` 调用。PC 桥接中的 `process._debugProcess(pid)` 会触发
运行中的 Codex 开启 inspector，是本次修复针对的触发路径。

依据：[Node inspector 实现](https://github.com/nodejs/node/blob/main/src/inspector_agent.cc)。
本机调试输出保留在 `.tmp/codex-crashes/analysis-debug-message.txt` 和
`analysis-debug-activation.txt`。完整转储仅在本机保存。

## 自动调试与状态

Windows 桥接启动时，由 `CodexDebugActivation` 自动检查 Codex 主进程并开启本机
inspector。Codex 尚未运行时等待启动；进程重新启动后自动检查新进程。
已有有效端口直接复用。先检查监听地址和进程归属，再校验调试连接中的 PID 与
可执行文件路径。同一进程激活失败后，本轮桥接运行不会反复发送激活信号。

“Codex 桥接监听”卡片显示等待、检测、开启、验证、已开启或失败状态，
并显示端口、进程 ID 或具体错误。每 5 秒检查已连接进程与调试端点，桥接退出时
停止监测。Micro 和实时语音共用已经建立的调试端点，各自只关闭自己的连接。

## 使用

1. 退出旧版 CodexRemote。
2. 启动新版 CodexRemote 和 Codex，先后顺序均可。
3. 在“Codex 桥接监听”中确认“调试：已开启”，再检查设备任务同步。

## 验证边界

自动调试测试覆盖延迟启动、进程重启、端口失效、退出取消、已有端口复用、
端口冲突、身份不匹配、超时及目标进程退出。Micro 与语音模块的测试覆盖
独立连接不重复激活调试，以及不关闭共享 inspector。

## 2026-09-21 手动运行中开启测试

按用户要求，在 Codex `26.915.4065.0` 上重新测试了运行中开启调试。
独立实例完成端口开启和桥接运行时注入；因缺少 Micro owner window，未读取到任务。
随后对当前实际 Codex 主进程 PID `19604` 执行一次 `_debugProcess`，30 秒内
15 次采样均确认进程存活、Node 调试端口可用。桥接读取返回 6 个槽位，全部有任务映射。
本地测试记录为 `.tmp/current-runtime-debug-result.json`。

本次成功不能推翻此前已确认的闪退记录；尚未证明反复开启或长时间运行稳定，
也未验证 ESP32 屏幕上的最终显示。
