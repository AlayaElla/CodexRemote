# macOS 虚拟 Micro

macOS 语音控制使用进程内 Shim。此目录提供独立的系统 HID 探针，用于检查设备创建和枚举能力。

## HID 探针

```sh
node scripts/build-macos-hid-probe.js
build/macos-virtual-micro/CodexRemoteMacHIDProbe --probe
```

探针调用 `IOHIDUserDeviceCreateWithProperties`，创建 VID `303A`、PID `8360`、usage page `FF00`、report ID `6` 的接口，退出时释放设备。它不发送输入或安装服务。系统虚拟 HID 需要 `com.apple.developer.hid.virtual.device` 授权。

## Micro Shim

`src/platform/macos-micro-shim.js` 提供虚拟设备枚举和精确设备打开路径；`macos-shim-controller.js` 通过运行时连接收发 Micro raw64/RPC 报告，保留真实设备。

连接由 socket 令牌和进程身份校验保护。5 秒无轮询时移除虚拟设备并恢复入口。`hidEnumerated` 与 `driverAvailable` 为 false，完成 Micro RPC 往返后才报告 `microConnected`。

Shim 通过已有 inspector 加载，不修改 Codex 安装文件。启动方法见 [macOS 调试启动器](../../docs/macos-inspector-startup.md)。兼容性取决于 Codex 内部接口。
