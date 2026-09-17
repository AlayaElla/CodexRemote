# Codex Remote 虚拟 Micro 驱动安装器

解压独立安装器 ZIP 后，请保持 `driver` 文件夹与 `VirtualMicroDriverInstaller.exe` 位于同一目录，再双击 EXE。在窗口中选择“安装（覆盖安装）”或“删除”；安装器仅在选择安装后预检固定驱动包，通过后才显示 Windows UAC 确认，并以中文窗口显示结果。它只为这个精确的开发包在本机信任其本地开发签名证书；这不是微软签名。安装会新增本机开发证书信任，但不会关闭 Secure Boot 或驱动签名校验。若字节、签名或 catalog 成员不匹配，程序会在 UAC 前显示错误并阻止安装；请勿尝试绕过该拦截或修改 Secure Boot/系统安全设置。

`VirtualMicroDriverInstaller.exe` 是单独的 Windows x64 NativeAOT 安装器，不需要目标电脑预装 .NET Runtime。普通 Electron 应用和 HID broker 均不会因安装驱动而提权；只有这个独立 EXE 会在固定包预检通过后请求 Windows UAC。

标准发布输出路径：

```powershell
dotnet publish native/virtual-micro-driver-installer/VirtualMicroDriverInstaller.csproj -c Release -r win-x64 --self-contained true
```

`bin/Release/net9.0-windows/win-x64/publish/VirtualMicroDriverInstaller.exe` 只接受可执行文件旁固定的 `driver/` 驱动包，不支持用户选择任意驱动路径。

界面只有两个操作按钮：`安装（覆盖安装）` 和 `删除`。默认安装会在不提权的情况下校验内置的 INF/DLL/CAT SHA-256、预期 INF 身份和精确 catalog 成员关系；候选包即使当前设备已就绪也会重新校验后覆盖更新。删除只针对本产品的固定 ROOT 设备（含严格识别的旧 System 类节点），Windows 仍决定是否可以移除共享 DriverStore 包。`--elevated-install` 和 `--elevated-remove` 仅为同一 EXE 在 UAC 后使用的内部参数，不是面向用户的接口。

安装器只有在这些检查通过且 Windows 批准提权后，才使用 Windows SetupAPI/NewDev。它不需要或分发 WDK 工具；不会修改 Secure Boot、启用测试模式、调用 `bcdedit` 或修改内核签名策略。构建或自测成功不代表驱动加载、HID 枚举、ChatGPT 集成或 Gate A 已得到验证。
