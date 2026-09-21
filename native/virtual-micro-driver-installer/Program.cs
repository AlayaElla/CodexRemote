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
#if LOCAL_TESTS
        if (args.SequenceEqual(["--self-test"]))
        {
            try { DriverBundleOperationsTests.Run(); DriverRemovalSelfTests.Run(); InstallerMessages.RunSelfTests(); Console.WriteLine("Installer self-tests passed."); return 0; }
            catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }
        if (args.SequenceEqual(["--audio-signature-smoke"]))
            return AudioDriverSetup.InspectPackage(Path.Combine(Directory.GetCurrentDirectory(), "native", "virtual-audio-driver", "x64", "Release", "CodexRemoteVirtualAudio")).State == "audio_not_microsoft_signed" ? 0 : 1;
#endif
        try
        {
            if (args.SequenceEqual(["--elevated-install"]))
            { var result = SupportsWindowsX64() ? InstallBothElevated() : new BundleOperationResult(new(50, false, false), new(50, false, false)); Show(BundleMessage("安装", result), !result.Success); return result.ExitCode; }
            if (args.SequenceEqual(["--elevated-remove"]))
            { var result = SupportsRemovePlatform() ? RemoveBothElevated() : new BundleOperationResult(new(50, false, false), new(50, false, false)); Show(BundleMessage("删除", result), !result.Success); return result.ExitCode; }
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
        var before = InspectPackages();
        if (!before.CanInstall)
        {
            Show(InstallerMessages.Blocked(before), isError: true);
            return 1;
        }

        // Explicit user action requests an overwrite update even if a previous
        // version is ready. The elevated child revalidates the fixed candidate
        // in an administrator-only snapshot before forcing the exact HardwareId.
        int? exitCode;
        try { exitCode = await new InstallerPlatform().ElevateAsync(MicroPackageDirectory()); }
        catch (Win32Exception error) when (error.NativeErrorCode == DriverSetup.CancelExitCode) { exitCode = DriverSetup.CancelExitCode; }
        if (exitCode == DriverSetup.CancelExitCode)
        { Show("已取消 Windows 管理员授权，未安装驱动。", isError: false); return 0; }
        if (exitCode is null)
        { Show("安装操作仍可能在 Windows 中执行。请稍后重新检查驱动状态。", isError: true); return 1; }
        return exitCode is 0 or DriverSetup.RebootExitCode ? 0 : 1;
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
        return exitCode is 0 or DriverSetup.RebootExitCode ? 0 : 1;
    }

    private static DriverSetupStatus InspectPackages() => SupportsWindowsX64()
        ? InspectBoth()
        : new("unsupported", "驱动安装器仅支持原生 Windows x64。", false, false);

    private static DriverSetupStatus InspectBoth()
    {
        var micro = DriverSetup.InspectPackage(MicroPackageDirectory(), DriverSetupNative.Observe(), DriverPackageTrust.VerifyCatalogMembers, DriverPayloadHashes.Verify);
        if (!micro.CanInstall) return micro;
        var audio = AudioDriverSetup.InspectPackage(AudioPackageDirectory());
        // Both packages must pass before the UAC path begins. In particular an
        // unsigned kernel driver cannot cause a Micro update as a side effect.
        return audio.CanInstall ? micro : audio;
    }

    private static BundleOperationResult InstallBothElevated() => WithBundleLock(() =>
    {
        AudioDriverSetup.PreparedPackage? audio = null;
        try
        {
            return DriverBundleOperations.Install(
                () =>
                {
                    if (!InspectBoth().CanInstall) return false;
                    // Freeze and verify audio before the first Micro mutation.
                    audio = AudioDriverSetup.PrepareElevatedPackage(AudioPackageDirectory());
                    return true;
                },
                () => ComponentResult.FromExitCode(DriverSetup.InstallElevated(MicroPackageDirectory())),
                () => AudioDriverSetup.InstallPrepared(audio!));
        }
        finally { audio?.Dispose(); }
    });

    private static BundleOperationResult RemoveBothElevated() => WithBundleLock(() =>
    {
        // Always attempt both independently: disk payload and signature state
        // are irrelevant to deletion, and one failure must not skip the other.
        return DriverBundleOperations.Remove(() =>
        {
            var reboot = false;
            try { return ComponentResult.FromExitCode(DriverSetup.RemoveElevated(out reboot), reboot); }
            catch (Exception error) { return ComponentResult.Failure(error, reboot); }
        }, () => AudioDriverSetup.RemoveComponent());
    });

    private static BundleOperationResult WithBundleLock(Func<BundleOperationResult> operation)
    {
        if (!new WindowsAudioDriverPlatform().IsAdministrator) return new(new(5, false, false), new(5, false, false));
        // Reuse the Micro mutex for the complete bundle. Its inner synchronous
        // operations acquire it recursively on this thread, preserving callers.
        using var mutex = new Mutex(false, @"Global\CodexRemote.VirtualMicro.DriverInstall.v1");
        bool acquired;
        try { acquired = mutex.WaitOne(0); }
        catch (AbandonedMutexException) { acquired = true; }
        if (!acquired) return new(new(170, false, false), new(170, false, false));
        try { return operation(); }
        finally { mutex.ReleaseMutex(); }
    }

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

    private static string BundleDirectory()
    {
        var executable = Environment.ProcessPath ?? throw new IOException("无法定位安装器可执行文件。");
        return Path.Combine(Path.GetDirectoryName(executable)!, "driver-bundle");
    }
    private static string MicroPackageDirectory() => Path.Combine(BundleDirectory(), "micro");
    private static string AudioPackageDirectory() => Path.Combine(BundleDirectory(), "audio");
    private static string BundleMessage(string action, BundleOperationResult result)
    {
        string Part(string name, ComponentResult item) => !item.Attempted
            ? $"{name}：未执行" + (item.Code == 0 ? "" : $"（Windows 代码 {item.Code}）")
            : item.Code != 0 ? $"{name}：失败（Windows 代码 {item.Code}）"
            : item.Absent ? $"{name}：已不存在"
            : item.RebootRequired ? $"{name}：已处理，等待重启" : $"{name}：完成";
        var reboot = result.RebootRequired ? "\nWindows 要求重启后再检查。" : "";
        return $"驱动{action}结果：\n{Part("虚拟 Micro 控制驱动", result.Micro)}\n{Part("CodexRemote Speakers 音频驱动", result.Audio)}{reboot}";
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
        var fixedPackage = Path.Combine(Path.GetDirectoryName(executable)!, "driver-bundle", "micro");
        if (expectedPackage is not null && !string.Equals(expectedPackage, fixedPackage, StringComparison.OrdinalIgnoreCase))
            throw new IOException("安装器仅接受固定的同级 driver-bundle\\micro 驱动目录。");
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
