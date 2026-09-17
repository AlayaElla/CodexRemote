# Virtual Micro UMDF2/VHF 驱动源码

实验性 Windows x64 UMDF2 控制 HID 驱动，供主程序内置 broker 使用。它不是音频设备，实际录音仍使用 PC 麦克风。

2026-09-06 已使用 VS 2026、SDK/WDK 28000 完成 x64 编译、链接、INF 校验和目录生成。输出包含 `.dll`、`.inf`、`.cat`，目前均未签名，尚未安装。HID 枚举、ChatGPT 连接和 Gate A 尚待实机验证。

在已有兼容 Visual Studio C++/WDK 的环境运行：

```powershell
powershell -NoProfile -File native/virtual-micro-driver/scripts/build.ps1
```

脚本优先使用 x64 MSBuild，构建成功后检查三个安装文件齐全。UMDF 编译版本与 INF 均为 2.15.0。输出目录：`x64/Release/CodexRemoteVirtualMicro/`。

构建仅生成未签名包；`Signability test complete` 表示满足目录生成检查，不代表获得签名。项目关闭自动签名。

## 产品安装

运行 `npm run package:driver` 后，解压 `build/driver/CodexRemote-VirtualMicro-Driver-<版本号>-x64.zip`。保持压缩包内的 `VirtualMicroDriverInstaller.exe` 与同级 `driver/` 目录在原位；安装器只使用这个固定 sibling `driver/` 目录中的 `.dll`、`.inf`、`.cat` 三件套。

运行 `VirtualMicroDriverInstaller.exe`，选择“安装（覆盖安装）”或“删除”。安装会更新已有驱动；删除只针对此虚拟驱动。只有独立安装器会请求 Windows UAC；主程序始终以普通权限运行。安装完成后回到主程序刷新驱动检查，再执行“检查并连接”。

`npm run package:driver` 先通过 WDK 构建驱动，再从临时快照生成安装器内置哈希并打包三件套；构建阶段不签名或安装驱动。当前驱动仍未签名，真实硬件 Gate A 尚未通过；不要为安装而修改 Secure Boot 或其他系统安全设置。产品不分发、调用或要求 DevGen/WDK 安装工具。若 Windows 在安装失败前已暂存 DriverStore 包，安装器不会自动删除它。

### 开发手动流程（不用于产品）

此 UMDF2 包需要目标机器接受其 INF/CAT 签名。开发测试可在指定机器使用用户明确批准的本地开发签名与信任配置；本仓库构建脚本和安装器不会导入证书、签名驱动或修改系统设置。该 INF 使用 inbox `wudfrd.inf`，模型节限制为 Windows 11 build 22000 或更高；尚未做实机兼容性验证。

参考：[微软内核驱动签名要求](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/kernel-mode-code-signing-requirements--windows-vista-and-later-)。

### 签名后的首次测试安装

以下命令只用于本机 WDK 开发测试；产品安装请使用独立的 `VirtualMicroDriverInstaller.exe`。`DevGen` 是微软测试工具，不应随产品分发。

取得签名后的完整包后，把以下路径换成该签名包的位置。在管理员 PowerShell 中先检查签名和目录成员关系；每条检查成功才继续。当前源码构建出的未签名包会在这里失败。

```powershell
$driverPackage = 'D:\AI\CodexRemote\native\virtual-micro-driver\x64\Release\CodexRemoteVirtualMicro'
$wdkSignTool = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.28000.0\x64\signtool.exe'
& $wdkSignTool verify /pa /v /c "$driverPackage\CodexRemoteVirtualMicro.cat" "$driverPackage\CodexRemoteVirtualMicro.dll"
if ($LASTEXITCODE -ne 0) { throw 'UMDF package signature/catalog verification failed.' }
& $wdkSignTool verify /pa /v /c "$driverPackage\CodexRemoteVirtualMicro.cat" "$driverPackage\CodexRemoteVirtualMicro.inf"
if ($LASTEXITCODE -ne 0) { throw 'INF signature/catalog verification failed.' }
```

确认设备管理器中还没有此虚拟设备后，仅首次创建 ROOT 设备节点，再安装驱动：

```powershell
& 'C:\Program Files (x86)\Windows Kits\10\Tools\10.0.28000.0\x64\devgen.exe' /add /bus ROOT /hardwareid 'ROOT\CodexRemoteVirtualMicro'
if ($LASTEXITCODE -ne 0) { throw 'Virtual device creation failed.' }
pnputil /add-driver "$driverPackage\CodexRemoteVirtualMicro.inf" /install
if ($LASTEXITCODE -notin @(0, 3010)) { throw 'Driver installation failed; retain the device instance ID for diagnosis/removal.' }
```

保留 DevGen 输出的设备实例 ID。更新已有设备时只运行 PnPUtil 安装步骤，重复 DevGen 会产生额外设备。测试签名环境应按该机器获批准的本地信任流程验证，不应为绕过失败而直接删除检查。

参考：[DevGen 创建 ROOT 测试设备](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/devgen-command-syntax)、[PnPUtil 安装与更新](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/pnputil-command-syntax)。

### 安装后检查

```powershell
pnputil /enum-devices /deviceid 'ROOT\CodexRemoteVirtualMicro' /drivers
```

确认设备正常运行后，主程序中选择“虚拟 Codex Micro（实验）”、启用并保存，然后在 ChatGPT 中连接 Micro，再执行“检查并连接”。PTT 测试应人工观察真实录音开始/停止。

若测试失败，使用 DevGen 输出的准确实例 ID 删除该测试节点：`devgen /remove "实际设备实例ID"`。保留安装日志；不要按通用设备类批量删除。

## 设计

- VHF 默认输入缓冲；UMDF 通过 local-target file handle 绑定 VHF，INF 使用 inbox `Vhf` lower filter 和 `VhfMode=1`；vendor page `0xFF00`、usage `1`、VID `0x303A`、PID `0x8360`、Report ID `6`、raw64 双向报告。创建 VHF 时以双零结尾的 `MULTI_SZ` `HID\VID_303A&PID_8360` 提供给 `HardwareIDs`，为 HID 子节点声明该硬件 ID；ROOT 源设备的 `ROOT\CodexRemoteVirtualMicro` 硬件目标保持在 INF 中，不会被子节点 ID 替换。VHF 文档未承诺该属性一定改写 HID interface symbolic-link，因此重新加载后的接口路径必须实测。
- 控制接口仅接受一个 owner file；INF Security 允许 SYSTEM/Administrators 完整访问、交互式登录用户读写，不授予 Everyone/Network。任何有权限的本机程序均可能注入报告，不能作为安全认证设备。
- 有界输出 FIFO、序列号、epoch 与丢包计数；部分投递不重放。METHOD_BUFFERED 输入头在写入 ACK 前复制。
- 被动级别的输入/清理锁与 VHF 回调自旋锁分离，不跨自旋锁调用 VHF。
- 文件清理、reset、设备清理仅尝试源码固定的 ACT10-up，再清理本地状态。释放是尽力而为，不证明 ChatGPT 已停止录音。

Windows DDI 依据：[VHF 输入缓冲规则](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/vhf/nf-vhf-vhfreadreportsubmit)、[VHF_CONFIG UMDF file handle](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/vhf/ns-vhf-_vhf_config)。私有报告观察基线见 broker README；发布前需完成兼容性、许可、签名和安全评审。

## Gate A（尚未通过）

1. 授权测试机用已签名驱动验证加载、HID 枚举、接口权限与独占；检查子节点 Hardware IDs 及 HID 接口路径是否均包含 `VID_303A&PID_8360`，并检查 usage page `FF00`、usage `1` 与 Report ID `6`。若接口路径仍为 `HID_DEVICE_SYSTEM_VHF`，则此 VHF 配置不能满足原生 addon 的路径预筛，不应宣称已连通。
2. ChatGPT 设置检测并连接 Micro，验证双向 RPC/Output Report、前后台切换与重连。
3. 验证 PTT 按下/释放、断连/进程退出/最大按住超时下的真实录音状态；人工确认并发送。
4. 六键完整交互另行受控验证。本次语音模式只生成 ACT10 PTT，不生成发送、批准或其他按键。

完成验证前，不更改默认语音模式，也不扩展到固件。
