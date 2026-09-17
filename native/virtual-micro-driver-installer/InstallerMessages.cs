namespace VirtualMicroBroker;

internal static class InstallerMessages
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

    internal static void RunSelfTests()
    {
        Check(Blocked(new("unsupported", "", false, false)).Contains("Windows 11"), "unsupported block message");
        Check(Blocked(new("unsigned_package", "", false, false, PackagePresent: true)).Contains("本地开发签名"), "unsigned block message");
        Check(Blocked(new("missing_package", "", false, false)).Contains("driver"), "missing block message");
        Check(InstallResult(new("installed", "", true, true, PackagePresent: true, SignatureValid: true, Success: true)).Contains("安装完成"), "installed result message");
        Check(InstallResult(new("reboot_required", "", true, false, RebootRequired: true, PackagePresent: true, SignatureValid: true, Success: true)).Contains("重启"), "reboot result message");
        Check(InstallResult(new("cancelled", "", false, false, Cancelled: true)).Contains("取消"), "cancel result message");
    }

    internal static string Bound(string message) => message.Length <= 512 ? message : message[..512];
    private static void Check(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException("安装器自测失败：" + name);
    }
}
