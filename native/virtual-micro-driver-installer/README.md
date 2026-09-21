# Codex Remote 控制与音频驱动安装器

解压独立安装器 ZIP 后，请保持 `driver-bundle/micro/`、`driver-bundle/audio/` 与 `VirtualMicroDriverInstaller.exe` 位于同一目录，再双击 EXE。在窗口中选择“安装（覆盖安装）”或“删除”。安装器会先同时预检两个编译固定的包，两个都通过后才显示 Windows UAC；音频包未通过签名验证时，Micro 也不会先更新。

`micro/` 是 UMDF2/VHF HID 控制包，安装器只为其精确三件套建立本机开发签名信任；这不是微软签名。`audio/` 是 WDM WaveRT 内核音频包，包含 `CodexRemoteVirtualAudio.sys/.inf/.cat`、固定硬件 ID `ROOT\CodexRemoteVirtualAudio` 和服务 `CodexRemoteVirtualAudio`。它必须通过 Windows 驱动签名策略和精确 catalog 成员验证；本地开发签名绝不会被当作内核签名接受。安装器不会关闭 Secure Boot、启用测试模式、调用 `bcdedit` 或改变任何系统签名策略。

`VirtualMicroDriverInstaller.exe` 是单独的 Windows x64 NativeAOT 安装器，不需要目标电脑预装 .NET Runtime。普通 Electron 应用和 HID broker 均不会因安装驱动而提权；只有这个独立 EXE 会在固定包预检通过后请求 Windows UAC。

标准发布输出路径：

```powershell
dotnet publish native/virtual-micro-driver-installer/VirtualMicroDriverInstaller.csproj -c Release -r win-x64 --self-contained true
```

`bin/Release/net9.0-windows/win-x64/publish/VirtualMicroDriverInstaller.exe` 只接受可执行文件旁固定的 `driver-bundle/micro/` 和 `driver-bundle/audio/`，不支持用户选择任意驱动路径或由可替换 manifest 决定身份。

界面只有两个操作按钮：`安装（覆盖安装）` 和 `删除`。默认安装会在不提权的情况下校验内置的 INF/DLL/CAT SHA-256、预期 INF 身份和精确 catalog 成员关系；候选包即使当前设备已就绪也会重新校验后覆盖更新。删除只针对本产品的固定 ROOT 设备（含严格识别的旧 System 类节点），Windows 仍决定是否可以移除共享 DriverStore 包。`--elevated-install` 和 `--elevated-remove` 仅为同一 EXE 在 UAC 后使用的内部参数，不是面向用户的接口。

删除不需要磁盘包或签名验证，会分别尝试清理这两个固定产品身份；一项缺失或失败不会阻止另一项执行，并合并重启需求。Micro 的本地信任账本只在其精确 DriverStore 记录完全删除后才清理，音频删除不会触碰该证书或其它包。

构建或自测成功不代表内核驱动加载、Windows 声音端点、HID 枚举、ChatGPT 集成或 Gate A 已得到验证。

完整双包构建入口：

```powershell
powershell -NoProfile -File scripts/package-virtual-micro-driver.ps1
```

默认构建得到开发组合包，音频驱动尚未签名，安装预检会阻止安装。收到 Microsoft
签名后的三件套后，指定其目录重新生成安装器及组合包：

```powershell
powershell -NoProfile -File scripts/package-virtual-micro-driver.ps1 -AudioDriverPackagePath C:\SignedAudioPackage
```

该参数保留签名返回包的原始字节，不重新生成其 SYS 或 CAT。组合包位于
`build/driver/CodexRemote-Drivers-<版本>-x64.zip`，同时保留音频上游许可证。
