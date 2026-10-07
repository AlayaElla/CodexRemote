namespace VirtualMicroBroker;

internal static partial class InstallerMessages
{
    internal static string Blocked(DriverSetupStatus output) => output.State switch
    {
        "unsupported" => "需要 Windows 11（22000 或更高版本）x64 及系统自带 VhfUm.dll。未请求管理员权限。",
        "unsigned_package" => "驱动包未获得 Windows 信任，无法安装。安装器仅信任这个固定开发包的本地开发签名证书。",
        "missing_package" => "未找到完整驱动包。请保留安装器同级的 driver 文件夹。",
        _ => "驱动包未通过安全检查，未请求管理员权限。"
    };

    internal static string InstallResult(DriverSetupStatus output) => output.State switch
    {
        "installed" => "虚拟 Micro 驱动安装完成，可返回应用继续连接。",
        "reboot_required" => "驱动安装完成。Windows 要求重启后再返回应用连接。",
        "cancelled" => "已取消 Windows 管理员授权，未安装驱动。",
        "partial_cleanup" => "Windows 已开始处理驱动包，但安装未完成；为避免误删仍可能被系统引用的开发签名信任，安装器已保留该信任记录。",
        _ => "驱动安装未完成。\n" + Bound(output.Message)
    };

    internal static string Bound(string message) => message.Length <= 512 ? message : message[..512];
}
