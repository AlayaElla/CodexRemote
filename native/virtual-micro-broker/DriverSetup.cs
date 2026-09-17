using System.ComponentModel;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;

namespace VirtualMicroBroker;

internal record DriverSetupStatus(string State, string Message, bool Installed = false,
    bool DeviceReady = false, bool RebootRequired = false, bool PackagePresent = false,
    bool SignatureValid = false, bool CanInstall = false, bool Success = false, bool Cancelled = false);

// Policy is independently testable: no native mutation before a successful preflight,
// no automatic retries after elevation, and installation never asserts a Micro handshake.
internal interface IDriverSetupPlatform
{
    DriverSetupStatus Inspect(string package);
    Task<int?> ElevateAsync(string package);
}

internal static class DriverSetup
{
    internal const string Stem = "CodexRemoteVirtualMicro";
    internal const string HardwareId = @"ROOT\CodexRemoteVirtualMicro";
    // UMDF2 hosts the device in WUDFRd; the package payload is a user-mode DLL,
    // never a kernel SYS image. Keep this list as the sole source for snapshot
    // and package shape validation.
    internal static readonly string[] PackageFiles = [Stem + ".inf", Stem + ".dll", Stem + ".cat"];
    internal const int RebootExitCode = 3010;
    internal const int TrustRetainedPartialExitCode = 3011;
    internal const int CancelExitCode = 1223;
    internal static async Task<DriverSetupStatus> ExecuteAsync(string operation, string package, IDriverSetupPlatform platform)
    {
        if (operation is not "inspect" and not "install" and not "overwrite")
            throw new ArgumentException("驱动安装操作无效。");
        var before = platform.Inspect(package);
        if (operation == "inspect" || !before.CanInstall || (operation == "install" && before.DeviceReady)) return before;
        int? exitCode;
        try { exitCode = await platform.ElevateAsync(package); }
        catch (Win32Exception error) when (error.NativeErrorCode == CancelExitCode)
        {
            exitCode = CancelExitCode;
        }
        if (exitCode == CancelExitCode)
            return before with { State = "cancelled", Message = "已取消管理员授权，未执行安装。", Cancelled = true, Success = false };
        if (exitCode is null)
            return before with { State = "outcome_unknown", Message = "安装仍可能在 Windows 中执行。请稍后检查状态，勿重复安装。", CanInstall = false, Success = false };
        var after = platform.Inspect(package);
        if (exitCode == TrustRetainedPartialExitCode)
            return after with { State = "partial_cleanup", Message = "Windows 已开始处理驱动包，但安装未完成；本地开发信任将保留，直到可安全清理已记录的驱动包。", CanInstall = false, Success = false };
        if (exitCode == RebootExitCode)
            return after with { State = "reboot_required", Message = "驱动安装已完成，Windows 要求重启电脑后再检查连接。", RebootRequired = true, CanInstall = false, Success = true };
        if (exitCode == 0 && after.DeviceReady)
            return after with { State = "installed", Message = "驱动已安装并启动。请点击“检查并连接”验证 MicroRPC 连接。", Success = true, CanInstall = false };
        return after with { State = "install_failed", Success = false,
            Message = $"驱动安装未确认成功（Windows 代码 {exitCode}）。请查看 C:\\Windows\\INF\\setupapi.dev.log；若已安装，重启后再检查。" };
    }

    internal static DriverSetupStatus InspectPackage(string package, DriverObservation device, Func<string, bool> verifySignature,
        Func<string, bool>? verifyPayload = null)
    {
        var result = new DriverSetupStatus("missing_package", "未找到完整驱动包，请使用包含驱动 .inf、.dll、.cat 的安装包。", device.Installed, device.Ready);
        try
        {
            if (!Directory.Exists(package) || PackageFiles.Any(name => !File.Exists(Path.Combine(package, name))))
                return AlreadyInstalled(result);
            result = result with { PackagePresent = true };
            foreach (var name in PackageFiles)
            {
                var file = new FileInfo(Path.Combine(package, name));
                var limit = name.EndsWith(".inf", StringComparison.Ordinal) ? 65536 : 32 * 1024 * 1024;
                if (file.Length is <= 0 || file.Length > limit || file.Attributes.HasFlag(FileAttributes.ReparsePoint))
                    return AlreadyInstalled(result with { State = "invalid_package", Message = "驱动包文件大小或类型不符合要求。" });
            }
            var inf = File.ReadAllText(Path.Combine(package, Stem + ".inf"));
            if (!MatchesExpectedInf(inf))
                return AlreadyInstalled(result with { State = "invalid_package", Message = "驱动 INF 与本版本的虚拟 Codex Micro 驱动定义不匹配。" });
            if (verifyPayload is not null && !verifyPayload(package))
                return AlreadyInstalled(result with { State = "invalid_package", Message = "驱动包字节与此安装器内置的发布内容不匹配。" });
            if (!verifySignature(package))
                return AlreadyInstalled(result with { State = "unsigned_package", Message = "驱动包未签名、签名不受信任或文件校验失败。请提供有效签名的驱动包；安装不会自动修改 Windows 安全设置。" });
            return AlreadyInstalled(result with { State = "ready", Message = "驱动包签名与文件校验通过，点击安装后将请求管理员权限。", SignatureValid = true, CanInstall = true });
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            return AlreadyInstalled(result with { State = "invalid_package", Message = $"无法读取驱动包：{BoundMessage(error.Message)}" });
        }
    }

    private static DriverSetupStatus AlreadyInstalled(DriverSetupStatus result) => result.DeviceReady && result.SignatureValid
        ? result with { State = "installed", Message = "驱动已安装并启动，可检查 MicroRPC 连接。", CanInstall = true, Success = true }
        : result;

    internal static bool MatchesExpectedInf(string value)
    {
        static string[] Normalize(string text) => text.Split('\n')
            .Select(line => Regex.Replace(line.Trim(), @"^DriverVer\s*=\s*", "DriverVer=", RegexOptions.IgnoreCase))
            .Where(line => line.Length > 0 && !line.StartsWith(';')).ToArray();
        var actual = Normalize(value);
        var versions = actual.Where(line => line.StartsWith("DriverVer=", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (versions.Length != 1 || !Regex.IsMatch(versions[0], @"^DriverVer=\d{2}/\d{2}/\d{4},\d+\.\d+\.\d+\.\d+$", RegexOptions.IgnoreCase)) return false;
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("DriverSetup.ExpectedInf")!;
        using var reader = new StreamReader(stream);
        var expected = Normalize(reader.ReadToEnd());
        return actual.Where(line => !line.StartsWith("DriverVer=", StringComparison.OrdinalIgnoreCase))
            .SequenceEqual(expected.Where(line => !line.StartsWith("DriverVer=", StringComparison.OrdinalIgnoreCase)), StringComparer.OrdinalIgnoreCase);
    }

    internal static int InstallElevated(string package)
    {
        using var identity = WindowsIdentity.GetCurrent();
        if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) return 5;
        // The global mutex also covers another app instance and helpers whose parent timed out.
        using var mutex = new Mutex(false, @"Global\CodexRemote.VirtualMicro.DriverInstall.v1");
        bool acquired;
        try { acquired = mutex.WaitOne(0); }
        catch (AbandonedMutexException) { acquired = true; }
        if (!acquired) return 170; // ERROR_BUSY; never retry an installation automatically.
        string? staging = null;
        var trustRetainedForStaging = false;
        try
        {
            // Before elevation the raw Inf2Cat catalog is intentionally not yet
            // locally trusted. Require only its exact embedded bytes and member
            // hashes; the protected snapshot is signed and full-trust verified
            // below before any SetupAPI/PnP mutation.
            var before = InspectPackage(package, DriverSetupNative.Observe(), DriverPackageTrust.VerifyCatalogMembers, DriverPayloadHashes.Verify);
            if (!before.CanInstall) return 577;
            // Create a unique administrator-only snapshot, then repeat signature/member
            // validation on that snapshot to close source-file replacement races at UAC.
            staging = CreateProtectedSnapshot(package);
            if (!InspectPackage(staging, DriverSetupNative.Observe(), DriverPackageTrust.VerifyCatalogMembers, DriverPayloadHashes.Verify).CanInstall) return 577;
            var ledger = new DriverTrustLedger();
            var snapshotIdentity = DriverPayloadHashes.SnapshotIdentity(staging);
            var signing = LocalDriverSigning.SignAndTrustFixedPackage(staging,
                new WindowsLocalDriverSigningPlatform(thumbprint => ledger.WritePendingTrust(thumbprint, snapshotIdentity)));
            if (!signing.Success || signing.Lease is null)
            {
                // The signing layer may have attempted exact trust cleanup but
                // deliberately treats a cleanup exception as uncertain. A
                // pre-import journal must therefore remain for Delete's
                // idempotent exact-store cleanup; never abandon it here.
                return string.IsNullOrWhiteSpace(signing.Thumbprint) ? 577 : TrustRetainedPartialExitCode;
            }
            using var lease = signing.Lease;
            if (!DriverPackageTrust.Verify(staging))
            {
                if (lease.TryRollbackBeforeStaging()) ledger.AbandonBeforeStaging(lease.Thumbprint);
                else return TrustRetainedPartialExitCode;
                return 577;
            }
            // Retain only after the pending journal is on disk and before the
            // first API that can add a DriverStore reference. From this point
            // all uncertainty intentionally preserves trust and the journal.
            ledger.MarkStageStarted(lease.Thumbprint);
            lease.RetainForStaging();
            trustRetainedForStaging = true;
            var install = DriverSetupNative.Install(staging, overwrite: true,
                publishedInf => ledger.RecordPublishedInf(lease.Thumbprint, publishedInf));
            return install is 0 or RebootExitCode ? install : TrustRetainedPartialExitCode;
        }
        catch (Win32Exception error) { return trustRetainedForStaging ? TrustRetainedPartialExitCode : error.NativeErrorCode == 0 ? 1 : error.NativeErrorCode; }
        catch { return trustRetainedForStaging ? TrustRetainedPartialExitCode : 1; }
        finally
        {
            // Delete only our three known snapshot files, never recursively traverse paths.
            if (staging is not null)
            {
                try
                {
                    foreach (var name in PackageFiles) File.Delete(Path.Combine(staging, name));
                    Directory.Delete(staging, false);
                }
                catch { /* A failed cleanup does not change a successful driver installation. */ }
            }
            mutex.ReleaseMutex();
        }
    }

    internal static int RemoveElevated()
    {
        using var identity = WindowsIdentity.GetCurrent();
        if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) return 5;
        // Removal and overwrite installation are mutually exclusive system operations.
        using var mutex = new Mutex(false, @"Global\CodexRemote.VirtualMicro.DriverInstall.v1");
        bool acquired;
        try { acquired = mutex.WaitOne(0); }
        catch (AbandonedMutexException) { acquired = true; }
        if (!acquired) return 170;
        try { return DriverRemovalNative.RemoveInstalledDriver(); }
        catch (Win32Exception error) { return error.NativeErrorCode == 0 ? 1 : error.NativeErrorCode; }
        catch { return 1; }
        finally { mutex.ReleaseMutex(); }
    }

    private static string CreateProtectedSnapshot(string package)
    {
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "CodexRemote-DriverSetup-" + Guid.NewGuid().ToString("N"));
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        security.SetOwner(admins);
        foreach (var sid in new[] { admins, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        if (Directory.Exists(directory)) throw new IOException("安装暂存目录已存在。");
        new DirectoryInfo(directory).Create(security);
        try
        {
            foreach (var name in PackageFiles)
            {
                // Hold the source without write/delete sharing and impose the same size bound
                // while copying. Only the protected copy is used by Windows installation APIs.
                using var source = new FileStream(Path.Combine(package, name), FileMode.Open, FileAccess.Read, FileShare.Read);
                if (source.Length is <= 0 or > 32 * 1024 * 1024) throw new IOException("驱动文件大小无效。");
                using var target = FileSystemAclExtensions.Create(new FileInfo(Path.Combine(directory, name)), FileMode.CreateNew,
                    FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.WriteThrough, ProtectedSnapshotFileSecurity());
                source.CopyTo(target);
            }
            return directory;
        }
        catch
        {
            foreach (var name in PackageFiles) File.Delete(Path.Combine(directory, name));
            Directory.Delete(directory, false);
            throw;
        }
    }

    private static string BoundMessage(string message) => message.Length <= 512 ? message : message[..512];

    private static FileSecurity ProtectedSnapshotFileSecurity()
    {
        var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var security = new FileSecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(admins);
        foreach (var sid in new[] { admins, system }) security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
        return security;
    }
}
