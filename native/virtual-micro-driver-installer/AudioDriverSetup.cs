using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;

namespace VirtualMicroBroker;

// This policy is intentionally independent from LocalDriverSigning. A local
// development certificate is never a valid signature for the kernel-mode SYS.
internal static partial class AudioDriverPayloadHashes
{
    internal static readonly string[] PackageFiles = ["CodexRemoteVirtualAudio.inf", "CodexRemoteVirtualAudio.sys", "CodexRemoteVirtualAudio.cat"];
    internal static bool Verify(string package)
    {
        foreach (var name in PackageFiles)
        {
            if (!ExpectedSha256.TryGetValue(name, out var expected) || expected.Length != 64) return false;
            using var stream = File.OpenRead(Path.Combine(package, name));
            var actual = Convert.ToHexString(SHA256.HashData(stream));
            if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(expected), Convert.FromHexString(actual))) return false;
        }
        return ExpectedSha256.Count == PackageFiles.Length;
    }
}

internal interface IAudioDriverPlatform
{
    bool IsAdministrator { get; }
    int Install(string package, out bool rebootRequired);
    int Remove(out bool rebootRequired);
    bool IsAbsent();
}

internal static class AudioDriverSetup
{
    internal const string Stem = "CodexRemoteVirtualAudio";
    internal const string HardwareId = @"ROOT\CodexRemoteVirtualAudio";
    internal const string ServiceName = "CodexRemoteVirtualAudio";
    private static readonly Guid MediaClass = new("4d36e96c-e325-11ce-bfc1-08002be10318");

    internal static DriverSetupStatus InspectPackage(string package)
    {
        var result = new DriverSetupStatus("audio_missing_package", "未找到完整音频驱动包。", false, false);
        try
        {
            if (!Directory.Exists(package) || AudioDriverPayloadHashes.PackageFiles.Any(name => !File.Exists(Path.Combine(package, name)))) return result;
            foreach (var name in AudioDriverPayloadHashes.PackageFiles)
            {
                var file = new FileInfo(Path.Combine(package, name));
                if (file.Length is <= 0 or > 64 * 1024 * 1024 || file.Attributes.HasFlag(FileAttributes.ReparsePoint))
                    return result with { State = "audio_invalid_package", Message = "音频驱动包文件大小或类型不符合要求。" };
            }
            var inf = File.ReadAllText(Path.Combine(package, Stem + ".inf"));
            if (!MatchesExpectedInf(inf)) return result with { State = "audio_invalid_package", Message = "音频驱动 INF 与 CodexRemote Speakers 的固定定义不匹配。" };
            if (!AudioDriverPayloadHashes.Verify(package)) return result with { State = "audio_invalid_package", Message = "音频驱动包字节与安装器内置发布内容不匹配。" };
            if (!VerifyMicrosoftKernelPackage(package)) return result with { State = "audio_not_microsoft_signed", Message = "音频内核驱动未具有受 Windows 驱动策略认可的 Microsoft 签名，已阻止安装；请使用经 Microsoft 签名的发布包。" };
            return result with { State = "audio_ready", Message = "音频内核驱动已通过 Microsoft 签名、目录成员和字节校验。", PackagePresent = true, SignatureValid = true, CanInstall = true };
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or SecurityException)
        {
            return result with { State = "audio_invalid_package", Message = "无法读取音频驱动包。" };
        }
    }

    internal sealed class PreparedPackage : IDisposable
    {
        internal string Path { get; }
        internal PreparedPackage(string path) => Path = path;
        public void Dispose() { try { foreach (var name in AudioDriverPayloadHashes.PackageFiles) File.Delete(System.IO.Path.Combine(Path, name)); Directory.Delete(Path, false); } catch { } }
    }
    internal static PreparedPackage PrepareElevatedPackage(string package)
    {
        if (!new WindowsAudioDriverPlatform().IsAdministrator) throw new UnauthorizedAccessException("需要管理员权限准备音频驱动包。");
        var snapshot = CreateProtectedSnapshot(package);
        if (!InspectPackage(snapshot).CanInstall) { try { foreach (var name in AudioDriverPayloadHashes.PackageFiles) File.Delete(System.IO.Path.Combine(snapshot, name)); Directory.Delete(snapshot, false); } catch { } throw new IOException("音频驱动受保护快照未通过签名或身份校验。"); }
        return new PreparedPackage(snapshot);
    }
    internal static int InstallElevated(string package) => InstallElevated(package, new WindowsAudioDriverPlatform());
    internal static int InstallElevated(string package, IAudioDriverPlatform platform)
    {
        if (!platform.IsAdministrator) return 5;
        if (!InspectPackage(package).CanInstall) return 577;
        using var prepared = PrepareElevatedPackage(package);
        return InstallPrepared(prepared, platform).ExitCode;
    }

    internal static ComponentResult InstallPrepared(PreparedPackage prepared, IAudioDriverPlatform? platform = null)
    {
        platform ??= new WindowsAudioDriverPlatform();
        if (!platform.IsAdministrator) return new(5, false, false);
        if (!InspectPackage(prepared.Path).CanInstall) return new(577, false, false);
        var reboot = false;
        try { return ComponentResult.FromExitCode(platform.Install(prepared.Path, out reboot), reboot); }
        catch (Exception error) { return ComponentResult.Failure(error, reboot); }
    }

    private static string CreateProtectedSnapshot(string package)
    {
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "CodexRemote-AudioSetup-" + Guid.NewGuid().ToString("N"));
        var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(admins);
        foreach (var sid in new[] { admins, system }) security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(directory).Create(security);
        try
        {
            foreach (var name in AudioDriverPayloadHashes.PackageFiles)
            {
                using var input = new FileStream(Path.Combine(package, name), FileMode.Open, FileAccess.Read, FileShare.Read);
                if (input.Length is <= 0 or > 64 * 1024 * 1024) throw new IOException("音频驱动文件大小无效。");
                using var output = new FileStream(Path.Combine(directory, name), FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
                input.CopyTo(output);
            }
            return directory;
        }
        catch { foreach (var name in AudioDriverPayloadHashes.PackageFiles) File.Delete(Path.Combine(directory, name)); Directory.Delete(directory, false); throw; }
    }

    internal static int RemoveElevated() => RemoveElevated(new WindowsAudioDriverPlatform());
    internal static int RemoveElevated(IAudioDriverPlatform platform)
        => RemoveComponent(platform).ExitCode;

    internal static ComponentResult RemoveComponent(IAudioDriverPlatform? platform = null)
    {
        platform ??= new WindowsAudioDriverPlatform();
        if (!platform.IsAdministrator) return new(5, false, false);
        var reboot = false;
        try
        {
            var wasAbsent = platform.IsAbsent();
            var code = platform.Remove(out reboot);
            if (code == 0 && !platform.IsAbsent()) code = 1168;
            return ComponentResult.FromExitCode(code, reboot, wasAbsent && code == 0);
        }
        catch (Exception error) { return ComponentResult.Failure(error, reboot); }
    }

    private static bool VerifyMicrosoftKernelPackage(string package)
    {
        var catalog = Path.Combine(package, Stem + ".cat");
        var inf = Path.Combine(package, Stem + ".inf");
        var sys = Path.Combine(package, Stem + ".sys");
        // Generic verification confirms normal trust and each catalog member.
        // DRIVER_ACTION_VERIFY applies Windows's driver-signing policy; it is
        // deliberately not replaced by a certificate-subject text comparison.
        return DriverPackageTrust.VerifySignedMembers(catalog, inf, sys) && WindowsCatalogTrust.VerifyMember(catalog, inf, true)
            && WindowsCatalogTrust.VerifyMember(catalog, sys, true) && VerifyDriverAction(catalog);
    }

    private static bool VerifyDriverAction(string catalog)
    {
        var file = new TrustFile { Size = (uint)Marshal.SizeOf<TrustFile>(), Path = catalog };
        var memory = Marshal.AllocHGlobal(Marshal.SizeOf<TrustFile>());
        Marshal.StructureToPtr(file, memory, false);
        var data = new TrustData { Size = (uint)Marshal.SizeOf<TrustData>(), UIChoice = 2, UnionChoice = 1, Subject = memory, StateAction = 1, ProviderFlags = 0x1000 | 0x80 };
        var action = new Guid("F750E6C3-38EE-11D1-85E5-00C04FC295EE"); // DRIVER_ACTION_VERIFY
        try { return WinVerifyTrust(new IntPtr(-1), ref action, ref data) == 0; }
        finally { data.StateAction = 2; WinVerifyTrust(new IntPtr(-1), ref action, ref data); Marshal.DestroyStructure<TrustFile>(memory); Marshal.FreeHGlobal(memory); }
    }

    internal static bool MatchesExpectedInf(string value)
    {
        static string[] Normalize(string text) => text.Split('\n').Select(line => Regex.Replace(line.Trim(), @"^DriverVer\s*=\s*", "DriverVer=", RegexOptions.IgnoreCase)).Where(line => line.Length > 0 && !line.StartsWith(';')).ToArray();
        var actual = Normalize(value); var versions = actual.Where(line => line.StartsWith("DriverVer=", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (versions.Length != 1 || !Regex.IsMatch(versions[0], @"^DriverVer=\d{2}/\d{2}/\d{4},\d+\.\d+\.\d+\.\d+$", RegexOptions.IgnoreCase)) return false;
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("AudioDriverSetup.ExpectedInf");
        if (stream is null) return false;
        using var reader = new StreamReader(stream); var expected = Normalize(reader.ReadToEnd());
        return actual.Where(line => !line.StartsWith("DriverVer=", StringComparison.OrdinalIgnoreCase)).SequenceEqual(expected.Where(line => !line.StartsWith("DriverVer=", StringComparison.OrdinalIgnoreCase)), StringComparer.OrdinalIgnoreCase);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct TrustFile { public uint Size; [MarshalAs(UnmanagedType.LPWStr)] public string Path; public IntPtr File, KnownSubject; }
    [StructLayout(LayoutKind.Sequential)] private struct TrustData { public uint Size; public IntPtr PolicyCallback, SipClient; public uint UIChoice, RevocationChecks, UnionChoice; public IntPtr Subject; public uint StateAction; public IntPtr StateData, UrlReference; public uint ProviderFlags, UIContext; public IntPtr SignatureSettings; }
    [DllImport("wintrust.dll", ExactSpelling = true)] private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
}
