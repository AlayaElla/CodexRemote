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

## 2026-10-04 Owl 运行时兼容性

本机 Codex Windows 包 `26.930.3930.0` 的
`resources/owl-electron-app.json` 标记 `runtimeName: owl`。独立临时配置实例实测：
运行中 `_debugProcess` 调用失败；`--inspect` 和 `NODE_OPTIONS=--inspect=...`
均没有开放 Node inspector。`--remote-debugging-port` 能开放浏览器页面调试端点，
该端点提供页面调试能力，需要使用独立的 renderer 适配器。
原始结果位于本机 `.tmp/owl-inspector-*/result.json`，测试实例已关闭。

0.2.4 为 Owl 增加 renderer 调试连接，Micro 槽位读取和原生语音控制共用此连接。
旧版 Node inspector 路径保留；Owl 不再接收旧的运行中激活信号。
桥接读取 Codex 用户目录中的 `DevToolsActivePort`，连接前核验唯一主进程、
可执行路径、端口归属及 `127.0.0.1` 监听地址，仅操作 Codex 的应用页面。

首次使用 Owl 时，先保存工作，再在 PC 端点击“启动或重启 Codex 并连接”。
按钮查找当前安装的 Codex，以 `--remote-debugging-port=0` 和
`--remote-debugging-address=127.0.0.1` 启动。端口由系统选择，使用原有用户目录；
Codex 已打开时，先核验当前用户、安装路径和进程创建时间，请求正常关闭该进程的全部窗口。
后台运行或 15 秒内仍未退出时，结束已核验的 Codex 主进程，确认退出后再启动。
重启可能中断正在执行的任务，按钮旁会提示先保存工作。
从普通快捷方式启动后需要连接时，也可以直接使用该按钮重启。
调试接口在该 Codex 进程退出后关闭，不写入永久调试设置。

连接错误保留具体原因并写入 PC 日志。失败的同一端点不会持续重连，用户可以点击
“重试连接”；端点或 Codex 进程变化后自动重新尝试。桥接退出时先清理语音和槽位
服务，再关闭共享调试连接。

验证包含本机新版 Codex 独立配置实例的随机端口连接、6 个真实 Micro 任务槽位、
灯光配置与只读语音状态；没有启动真实通话。设备端任务显示和双向语音仍需使用
实际设备验收。本机运行记录为 `.tmp/renderer-live-qRqQ7r/result.json`。

## ESP32 听写输入与发送

ESP32 音频经 PC 桥写入虚拟声卡的播放端，Codex 听写需要采集配对的输入端。
旧链路只投递 PTT，Codex 自己保存的麦克风选择仍会影响实际采集来源。
0.2.4 的 Owl 听写适配器为本次请求匹配唯一任务窗口和虚拟采集设备，确认
实际音轨设备及 Codex 录音状态后，才报告“正在录制 ESP32 语音”。
准备录音时，在当前窗口中匹配唯一可见的听写输入栏，并保留其组件身份。
子窗口通过 React Portal 留在主窗口界面树中的输入栏按所属文档区分。
录音后的读取、发送和取消仍绑定本次组件，即使其工具栏临时隐藏也保持归属。
松手时先等待设备音频排空，再调用当前听写的原生发送操作。
未收到设备音频、任务或连接变化时取消本次录音。

输入路由只作用于本次 ESP32 请求，结束后恢复原有麦克风接口。
取消听写的错误与 HID 按键释放结果分别处理；HID 已确认释放后恢复下一次
录音准备，保留原生听写清理的具体错误。
PC 状态中的“已请求发送”表示客户端接收了发送操作；服务端最终提交和
设备真机录音仍需要实际验证。

Chromium 提供运行中授权远程调试的
[设置入口](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)，
但本机 Codex 的隔离实例打开 `chrome://inspect/#remote-debugging` 返回
`ERR_INVALID_URL`，记录在 `.tmp/renderer-live-1B54Zh/result.json`。
目前未找到可验证的 Owl 运行中调试入口。
