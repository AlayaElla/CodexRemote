# Virtual Micro 用户态桥接

主程序自带的 Windows x64 / .NET 9 helper，通过私有 stdin/stdout 管道与 Electron 通信，并打开本项目 VHF 驱动的控制接口。无需启动社区 AgentController 程序。发布文件不包含 .NET 运行时，目标 PC 需要 .NET 9 Runtime。

```powershell
npm run build:virtual-micro-broker
```

发布位置：`bin/Release/net9.0-windows/win-x64/publish/VirtualMicroBroker.exe`；Electron 打包后位于 `resources/virtual-micro/`。该普通权限 broker 不包含驱动安装包，也不会提权、安装驱动或修改系统安全设置。

## 驱动安装命令

`VirtualMicroBroker.exe --driver-status` 返回单条只读 JSON：`{state,message,installed,deviceReady,success}`。它只观察 PnP 设备与控制接口；缺少驱动仍返回可解析状态，不会等待 stdin、请求 UAC 或触发安装。未知命令行参数会立即拒绝，普通 broker 协议只接受无参数启动。

驱动检查、固定开发包校验、明确确认、UAC 与 Windows SetupAPI/NewDev 安装都由单独的 [VirtualMicroDriverInstaller](../virtual-micro-driver-installer/README.md) 负责。安装器只使用其同级固定 `driver/` 目录，且只有预检通过并得到用户确认后才请求管理员权限；不需要运行时 WDK 或 DevGen/DevCon。

取消授权、安装失败、设备尚未就绪和需要重启分别返回；等待超时不会终止正在执行的系统安装，也不会自动重试。不会自动导入证书、更改测试签名/Secure Boot 设置或重启系统。签名检查依赖 Windows 信任策略，不固定特定发布者证书；Windows 安装器仍负责最终内核签名及加载策略。失败只回滚本次创建的 ROOT 节点，不删除已有设备或共享 DriverStore 包。

## 协议与安全边界

- JSONL UTF-8 每帧最多 64 KiB。请求为 `{id,op,...}`，回复包含 `{id,ok,result,error}`。支持 connect、status、heartbeat、submit、releaseAll、close。
- HID 输出为 `{event:"report",data:"base64(raw64)"}`；队列最多 128 条，写管道超时 500 ms。输出丢失、epoch 变化、父进程 5 秒无心跳均终止当前连接。
- `ok` 只确认请求被处理。提交结果区分 Accepted、NotSent、Rejected、OutcomeUnknown。部分接受、重复或矛盾 ACK 不自动重放。主程序只把完整 Accepted 视作 HID 投递确认，不视作 ChatGPT 已录音/转写/发送。
- releaseAll/退出只发送源码固定的 ACT10-up；内核文件清理另有独立的尽力释放路径。
- OVERLAPPED/缓冲区使用稳定非托管分配，持有句柄直到 I/O 终结。驱动取消后仍不完成时，终止隔离 broker，避免释放仍归内核使用的内存。
- 驱动可用、匹配 HID 接口枚举、主程序观测到的 Micro RPC 握手分别检查。接口匹配不证明设备身份或官方支持。

## 验证边界

broker 自测覆盖协议/ABI、输入边界、ACK 分类、规范化报告、EOF 与 stdout 堵塞清理。独立安装器另有驱动预检、重复请求、取消/超时、安装后就绪判定与重启结果的自测。自测不证明真实驱动安装、异步完成或 ChatGPT 兼容性；本地开发签名信任、加载、PC 麦克风录音与 Gate A 必须另行验证。

社区观察基线：[gantrol/AgentController，固定提交 cd26d043bee461c3d07e47b3bd71cf0c92217c58](https://github.com/gantrol/AgentController/tree/cd26d043bee461c3d07e47b3bd71cf0c92217c58)。未打包该项目的驱动或可执行文件；私有协议不是 OpenAI 公开兼容性承诺，分发前仍须检查上游许可与兼容性。
