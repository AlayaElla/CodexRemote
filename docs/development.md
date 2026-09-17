# 开发与打包

## 从源码运行与打包

开发需要 Node.js、npm 和 .NET 9 SDK。驱动构建另需 Visual Studio C++、Windows SDK/WDK。

```powershell
npm ci
npm run build:virtual-micro-broker
npm run build:esp32-audio-bridge
npm run dev
```

打包主程序：

```powershell
npm run package
```

输出：`build/pc/CodexRemote-Portable-<版本号>.exe`。也可双击 `scripts/package-pc.cmd`。

打包独立驱动安装器：

```powershell
npm run package:driver
```

输出：`build/driver/CodexRemote-VirtualMicro-Driver-<版本号>-x64.zip`。流程会构建驱动、建立临时文件快照、生成内置哈希、编译 NativeAOT 安装器并生成 ZIP。也可双击 `scripts/package-virtual-micro-driver.cmd`。

## 项目结构

```text
src/          桌面主程序、设备通信、语音和界面
native/       音频桥、Micro broker、驱动及安装器源码
assets/       应用图标
hooks/        Codex 生命周期 Hook
scripts/      构建与打包工具
docs/         功能与协议说明
```

详细说明：[设备菜单](esp32-codex-menu.md)、[音频路径](esp32-wifi-microphone.md)、[控制通道](control-transports.md)、[驱动安装器](../native/virtual-micro-driver-installer/README.md)。

构建产物、临时文件、测试文件、日志及设备凭据留在本地。构建与打包通过不代表实际驱动安装或设备端语音流程已完成验证。
