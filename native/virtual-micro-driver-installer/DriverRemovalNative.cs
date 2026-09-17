using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;

namespace VirtualMicroBroker;

internal enum DriverInfAssociation { Valid, Missing, Malformed }
internal enum PublishedInfProbe { Missing, Owned, ForeignOrUnknown }
internal sealed record RemovalDevice(long Token, Guid ClassGuid, string? HardwareIds, string? Service, DriverInfAssociation InfAssociation, string? InfName, bool Disconnected);
internal interface IRemovalPlatform { bool IsWindowsX64 { get; } bool IsAdministrator { get; } IReadOnlyList<RemovalDevice> EnumerateDevices(); int RemoveDevice(RemovalDevice expected, out bool rebootRequired); PublishedInfProbe ProbePublishedInf(string infName); int UninstallPublishedInf(string infName); }

internal static class DriverRemovalNative
{
    internal const int ErrorAccessDenied = 5, ErrorInvalidData = 13, ErrorNotFound = 1168;
    private const string HardwareId = @"ROOT\CodexRemoteVirtualMicro", HostService = "WUDFRd", LegacyService = "CodexRemoteVirtualMicro";
    private static readonly Guid HidClass = new("745a17a0-74d3-11d0-b6fe-00a0c90f57da");
    private static readonly Guid LegacySystemClass = new("4d36e97d-e325-11ce-bfc1-08002be10318");
    internal static int RemoveInstalledDriver() => RemoveInstalledDriver(new Win32RemovalPlatform(), new DriverTrustLedger(), new WindowsLocalDriverSigningPlatform());

    internal static int RemoveInstalledDriver(IRemovalPlatform platform) => RemoveInstalledDriver(platform, new EmptyLedger(), new NoopSigningPlatform());

    internal static int RemoveInstalledDriver(IRemovalPlatform platform, IDriverTrustLedger ledger, ILocalDriverSigningPlatform signing)
    {
        if (!platform.IsWindowsX64 || !platform.IsAdministrator) return ErrorAccessDenied;
        var owned = platform.EnumerateDevices().Where(IsOwned).ToArray();
        var ledgerEntries = ledger.Read().ToArray();
        if (owned.Length == 0 && ledgerEntries.Length == 0) return 0;
        var firstError = 0; var rebootRequired = false;
        foreach (var device in owned) { var error = platform.RemoveDevice(device, out var needsReboot); if (error != 0 && firstError == 0) firstError = error; rebootRequired |= needsReboot; }
        if (firstError != 0) return firstError;
        if (owned.Any(device => device.InfAssociation == DriverInfAssociation.Malformed)) return ErrorInvalidData;
        // A legacy exact node may be removed, but a missing association must
        // keep its trust ledger untouched and report partial cleanup.
        if (owned.Any(device => device.InfAssociation == DriverInfAssociation.Missing) || ledgerEntries.Any(entry => entry.PendingStage)) return ErrorNotFound;
        var packages = owned.Select(device => device.InfName!).Concat(ledgerEntries.SelectMany(entry => entry.PublishedInfs)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        foreach (var infName in packages)
        {
            var probe = platform.ProbePublishedInf(infName);
            if (probe == PublishedInfProbe.ForeignOrUnknown) return ErrorInvalidData;
            if (probe == PublishedInfProbe.Owned) { var error = platform.UninstallPublishedInf(infName); if (error != 0) return error; }
        }
        foreach (var entry in ledgerEntries)
        {
            // The durable entry is the only authority for retrying exact trust
            // cleanup. Never erase it until both stores have confirmed removal.
            try
            {
                signing.RemoveTrustExact(entry.Thumbprint, LocalDriverTrustStore.TrustedPublisher);
                signing.RemoveTrustExact(entry.Thumbprint, LocalDriverTrustStore.Root);
            }
            catch { return ErrorInvalidData; }
            try { ledger.Remove(entry.Thumbprint, entry.PublishedInfs); }
            catch { return ErrorInvalidData; }
        }
        return rebootRequired ? DriverSetup.RebootExitCode : 0;
    }

    // Current UMDF ownership and the retired KMDF ownership are both strict
    // triples. Never select by WUDFRd or HIDClass alone.
    private static bool IsOwned(RemovalDevice device) =>
        device.HardwareIds is not null && device.HardwareIds.Split('\0').Any(id => string.Equals(id, HardwareId, StringComparison.OrdinalIgnoreCase)) &&
        ((device.ClassGuid == HidClass && string.Equals(device.Service, HostService, StringComparison.OrdinalIgnoreCase)) ||
         (device.ClassGuid == LegacySystemClass && string.Equals(device.Service, LegacyService, StringComparison.OrdinalIgnoreCase)));

    private sealed class Win32RemovalPlatform : IRemovalPlatform
    {
        private const uint DifRemove = 5, DiNeedRestart = 0x80, DiNeedReboot = 0x100;
        private const int ErrorNoMoreItems = 259, ErrorPropertyMissing = 13, ErrorInsufficientBuffer = 122, ErrorFileNotFound = 2;
        public bool IsWindowsX64 => OperatingSystem.IsWindows() && Environment.Is64BitProcess;
        public bool IsAdministrator { get { using var identity = WindowsIdentity.GetCurrent(); return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator); } }
        public IReadOnlyList<RemovalDevice> EnumerateDevices()
        {
            using var set = new DeviceSet(); var result = new List<RemovalDevice>();
            for (uint index = 0; index < 4096; index++)
            {
                var data = DeviceInfo.Create();
                if (!SetupDiEnumDeviceInfo(set.Handle, index, ref data)) { if (Marshal.GetLastWin32Error() == ErrorNoMoreItems) return result; ThrowLastError(); }
                var token = data.DevInst;
                var hardwareIds = set.Property(ref data, 1); var service = set.Property(ref data, 4);
                var owned = IsOwned(new(token, data.ClassGuid, hardwareIds, service, DriverInfAssociation.Missing, null, false));
                var association = DriverInfAssociation.Missing; string? infName = null;
                if (owned) (association, infName) = set.DriverInfPath(ref data);
                result.Add(new(token, data.ClassGuid, hardwareIds, service, association, infName, false));
            }
            throw new IOException("Driver device enumeration exceeded its safety limit.");
        }
        public int RemoveDevice(RemovalDevice expected, out bool rebootRequired)
        {
            rebootRequired = false;
            using var set = new DeviceSet();
            var found = false; var data = DeviceInfo.Create();
            for (uint index = 0; index < 4096; index++)
            {
                var candidate = DeviceInfo.Create();
                if (!SetupDiEnumDeviceInfo(set.Handle, index, ref candidate)) { if (Marshal.GetLastWin32Error() == ErrorNoMoreItems) break; ThrowLastError(); }
                if (candidate.DevInst != (uint)expected.Token) continue;
                data = candidate; found = true; break;
            }
            if (!found) return ErrorNotFound;
            var hardwareIds = set.Property(ref data, 1); var service = set.Property(ref data, 4);
            if (!IsOwned(new(expected.Token, data.ClassGuid, hardwareIds, service, DriverInfAssociation.Missing, null, false))) return ErrorNotFound;
            var (association, infName) = set.DriverInfPath(ref data);
            if (association != expected.InfAssociation || !string.Equals(infName, expected.InfName, StringComparison.OrdinalIgnoreCase)) return ErrorNotFound;
            if (!SetupDiCallClassInstaller(DifRemove, set.Handle, ref data)) return LastErrorOrOne();
            var parameters = DeviceInstallParams.Create(); if (!SetupDiGetDeviceInstallParamsW(set.Handle, ref data, ref parameters)) return LastErrorOrOne();
            rebootRequired = (parameters.Flags & (DiNeedRestart | DiNeedReboot)) != 0; return 0;
        }
        public int UninstallPublishedInf(string infName) { if (SetupUninstallOEMInfW(infName, 0, IntPtr.Zero)) return 0; var error = LastErrorOrOne(); return error == ErrorFileNotFound ? 0 : error; }
        public PublishedInfProbe ProbePublishedInf(string infName)
        {
            if (!Regex.IsMatch(infName, "^oem[0-9]{1,4}\\.inf$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)) return PublishedInfProbe.ForeignOrUnknown;
            var windows = Path.GetDirectoryName(Environment.SystemDirectory);
            if (string.IsNullOrWhiteSpace(windows)) return PublishedInfProbe.ForeignOrUnknown;
            var directory = Path.Combine(windows, "INF");
            var full = Path.GetFullPath(Path.Combine(directory, infName));
            if (!full.StartsWith(Path.GetFullPath(directory) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return PublishedInfProbe.ForeignOrUnknown;
            try { return DriverSetup.MatchesExpectedInf(File.ReadAllText(full)) ? PublishedInfProbe.Owned : PublishedInfProbe.ForeignOrUnknown; }
            catch (FileNotFoundException) { return PublishedInfProbe.Missing; }
            catch (DirectoryNotFoundException) { return PublishedInfProbe.Missing; }
            catch (IOException) { return PublishedInfProbe.ForeignOrUnknown; }
            catch (UnauthorizedAccessException) { return PublishedInfProbe.ForeignOrUnknown; }
        }

        private sealed class DeviceSet : IDisposable
        {
            internal IntPtr Handle { get; }
            // A null class GUID enumerates all ROOT nodes so migration/delete can
            // inspect only the two exact ownership triples above.
            internal DeviceSet() { Handle = SetupDiGetClassDevsW(IntPtr.Zero, "ROOT", IntPtr.Zero, 0); if (Handle == new IntPtr(-1)) ThrowLastError(); }
            internal string? Property(ref DeviceInfo data, uint property)
            {
                var buffer = new byte[65536]; if (!SetupDiGetDeviceRegistryPropertyW(Handle, ref data, property, out var type, buffer, (uint)buffer.Length, out var needed)) { if (Marshal.GetLastWin32Error() == ErrorPropertyMissing) return null; ThrowLastError(); }
                if (needed > buffer.Length || needed % 2 != 0 || (type != 1 && type != 7)) throw new IOException("Driver device property format is invalid.");
                return Encoding.Unicode.GetString(buffer, 0, (int)needed).TrimEnd('\0');
            }
            internal (DriverInfAssociation, string?) DriverInfPath(ref DeviceInfo data)
            {
                var key = new DevicePropertyKey(new Guid("A8B865DD-2E3D-4094-AD97-E593A70C75D6"), 5);
                if (!SetupDiGetDevicePropertyW(Handle, ref data, ref key, out _, null, 0, out var needed, 0)) { var error = Marshal.GetLastWin32Error(); if (error is ErrorPropertyMissing or ErrorNotFound) return (DriverInfAssociation.Missing, null); if (error != ErrorInsufficientBuffer || needed is 0 or > 65536) ThrowLastError(); }
                if (needed is 0 or > 65536) return (DriverInfAssociation.Malformed, null);
                var buffer = new byte[needed]; if (!SetupDiGetDevicePropertyW(Handle, ref data, ref key, out var type, buffer, needed, out var actual, 0)) ThrowLastError();
                if (actual > buffer.Length || type != 0x12) return (DriverInfAssociation.Malformed, null);
                var name = Encoding.Unicode.GetString(buffer, 0, (int)actual).TrimEnd('\0');
                return Regex.IsMatch(name, "^oem[0-9]{1,4}\\.inf$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase) ? (DriverInfAssociation.Valid, name) : (DriverInfAssociation.Malformed, null);
            }
            public void Dispose() => SetupDiDestroyDeviceInfoList(Handle);
        }
    }

    [StructLayout(LayoutKind.Sequential)] private struct DeviceInfo { public uint Size; public Guid ClassGuid; public uint DevInst; public UIntPtr Reserved; internal static DeviceInfo Create() => new() { Size = (uint)Marshal.SizeOf<DeviceInfo>() }; }
    [StructLayout(LayoutKind.Sequential)] private struct DevicePropertyKey { public Guid FormatId; public uint PropertyId; internal DevicePropertyKey(Guid formatId, uint propertyId) { FormatId = formatId; PropertyId = propertyId; } }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct DeviceInstallParams { public uint Size, Flags, FlagsEx; public IntPtr HwndParent, InstallMsgHandler, InstallMsgHandlerContext, FileQueue; public UIntPtr ClassInstallReserved; public uint Reserved; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string DriverPath; internal static DeviceInstallParams Create() => new() { Size = (uint)Marshal.SizeOf<DeviceInstallParams>() }; }
    private static int LastErrorOrOne() { var error = Marshal.GetLastWin32Error(); return error == 0 ? 1 : error; }
    private static void ThrowLastError() => throw new Win32Exception(Marshal.GetLastWin32Error());
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern IntPtr SetupDiGetClassDevsW(IntPtr guid, string enumerator, IntPtr parent, uint flags);
    [DllImport("setupapi.dll", ExactSpelling = true, SetLastError = true)] private static extern bool SetupDiEnumDeviceInfo(IntPtr set, uint index, ref DeviceInfo device);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern bool SetupDiGetDeviceRegistryPropertyW(IntPtr set, ref DeviceInfo device, uint property, out uint type, [Out] byte[] buffer, uint size, out uint needed);
    [DllImport("setupapi.dll", ExactSpelling = true, SetLastError = true)] private static extern bool SetupDiCallClassInstaller(uint function, IntPtr set, ref DeviceInfo device);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern bool SetupDiGetDeviceInstallParamsW(IntPtr set, ref DeviceInfo device, ref DeviceInstallParams parameters);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern bool SetupDiGetDevicePropertyW(IntPtr set, ref DeviceInfo device, ref DevicePropertyKey key, out uint type, [Out] byte[]? buffer, uint bufferSize, out uint requiredSize, uint flags);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern bool SetupUninstallOEMInfW(string infFileName, uint flags, IntPtr reserved);
    [DllImport("setupapi.dll", ExactSpelling = true)] private static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);

    private sealed class EmptyLedger : IDriverTrustLedger
    {
        public void BeginPending(string thumbprint) { }
        public void WritePendingTrust(string thumbprint, string snapshotIdentity) { }
        public void RecordPublishedInf(string thumbprint, string publishedInf) { }
        public void MarkStageStarted(string thumbprint) { }
        public void AbandonBeforeStaging(string thumbprint) { }
        public IReadOnlyList<DriverTrustLedgerEntry> Read() => [];
        public void Remove(string thumbprint, IEnumerable<string> publishedInfs) { }
    }
    private sealed class NoopSigningPlatform : ILocalDriverSigningPlatform
    {
        public LocalSigningCertificate CreateProductCertificate() => throw new NotSupportedException();
        public void SignAuthenticode(LocalSigningCertificate certificate, string filePath) => throw new NotSupportedException();
        public bool VerifyCatalogMember(string catalogPath, string memberPath) => false;
        public bool VerifyCatalogSignature(string catalogPath, bool requireTrustedChain) => false;
        public void AddTrust(LocalSigningCertificate certificate, LocalDriverTrustStore store) { }
        public void RemoveTrustExact(string thumbprint, LocalDriverTrustStore store) { }
        public void DestroySigningMaterialExact(LocalSigningCertificate certificate) { }
    }
}
