using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace VirtualMicroBroker;

internal static class Program
{
    private const uint MbOk = 0x00000000;
    private const uint MbIconError = 0x00000010;
    private const uint MbIconInformation = 0x00000040;
    private const uint MbSetForeground = 0x00010000;

    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (args.SequenceEqual(["--elevated-install"]))
                return SupportsWindowsX64() ? DriverSetup.InstallElevated(PackageDirectory()) : 50;
            if (args.SequenceEqual(["--elevated-remove"]))
                return SupportsRemovePlatform() ? DriverSetup.RemoveElevated() : 50;
            if (args.Length != 0) return 2;

            return await RunSelectedActionAsync(InstallerDialog.ChooseAction());
        }
        catch (Exception error)
        {
            Show("驱动操作失败。\n" + InstallerMessages.Bound(error.Message), isError: true);
            return 1;
        }
    }

    private static async Task<int> RunSelectedActionAsync(InstallerAction action) => action switch
    {
        InstallerAction.OverwriteInstall => await RunOverwriteInstallAsync(),
        InstallerAction.Remove => await RunRemoveAsync(),
        _ => 0
    };

    private static async Task<int> RunOverwriteInstallAsync()
    {
        var before = InspectPackage();
        if (!before.CanInstall)
        {
            Show(InstallerMessages.Blocked(before), isError: true);
            return 1;
        }

        // Explicit user action requests an overwrite update even if a previous
        // version is ready. The elevated child revalidates the fixed candidate
        // in an administrator-only snapshot before forcing the exact HardwareId.
        var result = await DriverSetup.ExecuteAsync("overwrite", PackageDirectory(), new InstallerPlatform());
        Show(InstallerMessages.InstallResult(result), isError: !result.Success);
        return result.Success ? 0 : 1;
    }

    private static async Task<int> RunRemoveAsync()
    {
        if (!SupportsRemovePlatform())
        {
            Show("当前系统或处理器架构不受支持。未请求管理员权限。", isError: true);
            return 1;
        }
        int? exitCode;
        try { exitCode = await new InstallerPlatform().ElevateRemoveAsync(); }
        catch (Win32Exception error) when (error.NativeErrorCode == DriverSetup.CancelExitCode)
        {
            exitCode = DriverSetup.CancelExitCode;
        }
        if (exitCode == DriverSetup.CancelExitCode)
        {
            Show("已取消 Windows 管理员授权，未删除驱动。", isError: false);
            return 0;
        }
        if (exitCode is null)
        {
            Show("删除操作仍可能在 Windows 中执行。请稍后重新检查驱动状态。", isError: true);
            return 1;
        }
        if (exitCode == DriverSetup.RebootExitCode)
        {
            Show("驱动删除完成。Windows 要求重启后再检查。", isError: false);
            return 0;
        }
        var after = DriverSetupNative.Observe();
        if (exitCode == 0 && !after.Installed)
        {
            Show("虚拟 Micro 驱动已删除。", isError: false);
            return 0;
        }
        Show($"驱动删除未完成（Windows 代码 {exitCode}）。", isError: true);
        return 1;
    }

    private static DriverSetupStatus InspectPackage() => SupportsWindowsX64()
        ? DriverSetup.InspectPackage(PackageDirectory(), DriverSetupNative.Observe(), DriverPackageTrust.VerifyCatalogMembers, DriverPayloadHashes.Verify)
        : new("unsupported", "驱动安装器仅支持原生 Windows x64。", false, false);

    // The UMDF/VHF inbox contract in the fixed INF starts at Windows 11 build
    // 22000. Reject earlier Windows before package inspection or any UAC path.
    private static bool SupportsWindowsX64() => OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000) &&
        RuntimeInformation.OSArchitecture == Architecture.X64 && Environment.Is64BitProcess && HasInboxVhfUm();

    // Delete can recover a prepared trust journal even when VHF/UMDF is no
    // longer present and no PnP node is observable.
    private static bool SupportsRemovePlatform() => OperatingSystem.IsWindows() &&
        RuntimeInformation.OSArchitecture == Architecture.X64 && Environment.Is64BitProcess;

    private static bool HasInboxVhfUm()
    {
        if (!OperatingSystem.IsWindows()) return false;
        var systemDirectory = Environment.SystemDirectory;
        return !string.IsNullOrWhiteSpace(systemDirectory) && File.Exists(Path.Combine(systemDirectory, "VhfUm.dll"));
    }

    private static string PackageDirectory()
    {
        var executable = Environment.ProcessPath ?? throw new IOException("无法定位安装器可执行文件。");
        return Path.Combine(Path.GetDirectoryName(executable)!, "driver");
    }

    private static void Show(string message, bool isError) => MessageBoxW(IntPtr.Zero, message, "Codex Remote 驱动安装器",
        MbOk | MbSetForeground | (isError ? MbIconError : MbIconInformation));

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int MessageBoxW(IntPtr owner, string text, string caption, uint type);
}

internal sealed class InstallerPlatform : IDriverSetupPlatform
{
    public DriverSetupStatus Inspect(string package) => DriverSetup.InspectPackage(package, DriverSetupNative.Observe(), DriverPackageTrust.VerifyCatalogMembers, DriverPayloadHashes.Verify);

    public Task<int?> ElevateAsync(string package) => ElevateAsync("--elevated-install", package);
    internal Task<int?> ElevateRemoveAsync() => ElevateAsync("--elevated-remove", expectedPackage: null);

    private static async Task<int?> ElevateAsync(string argument, string? expectedPackage)
    {
        var executable = Environment.ProcessPath ?? throw new IOException("无法定位安装器可执行文件。");
        var fixedPackage = Path.Combine(Path.GetDirectoryName(executable)!, "driver");
        if (expectedPackage is not null && !string.Equals(expectedPackage, fixedPackage, StringComparison.OrdinalIgnoreCase))
            throw new IOException("安装器仅接受固定的同级 driver 驱动目录。");
        if (!string.Equals(Path.GetFileName(executable), "VirtualMicroDriverInstaller.exe", StringComparison.OrdinalIgnoreCase))
            throw new IOException("请使用发布后的 VirtualMicroDriverInstaller.exe。");
        var start = new ProcessStartInfo(executable) { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden };
        start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new IOException("无法请求管理员授权。");
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(170)); }
        catch (TimeoutException) { return null; } // Do not stop an in-flight Windows operation.
        return process.ExitCode;
    }
}
