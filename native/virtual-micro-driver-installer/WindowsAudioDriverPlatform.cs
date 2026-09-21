using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;

namespace VirtualMicroBroker;

// SetupAPI-only implementation. No DevCon/DevGen and no parsing of localized
// PnPUtil output is used for ownership or root-device lifecycle.
internal sealed class WindowsAudioDriverPlatform : IAudioDriverPlatform
{
    private static readonly Guid MediaClass = new("4d36e96c-e325-11ce-bfc1-08002be10318");
    private const uint RegisterDevice = 0x19, DifRemove = 5, Force = 1, DiNeedRestart = 0x80, DiNeedReboot = 0x100;
    public bool IsAdministrator { get { using var identity = WindowsIdentity.GetCurrent(); return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator); } }

    public int Install(string package, out bool rebootRequired)
    {
        rebootRequired = false;
        var inf = Path.Combine(package, AudioDriverSetup.Stem + ".inf");
        var published = new StringBuilder(260);
        if (!SetupCopyOEMInfW(inf, package, 1, 0, published, (uint)published.Capacity, out var needed, IntPtr.Zero))
        {
            if (Marshal.GetLastWin32Error() != 122 || needed is 0 or > 32768) return LastError();
            published = new StringBuilder((int)needed);
            if (!SetupCopyOEMInfW(inf, package, 1, 0, published, (uint)published.Capacity, out _, IntPtr.Zero)) return LastError();
        }
        // Include disconnected ROOT nodes: an unbound prior install must be
        // rebound, rather than creating another node with the same HWID.
        using var set = new DeviceSet(MediaClass, presentOnly: false);
        var owned = set.Owned().ToArray();
        var unbound = set.UnboundStubs().ToArray();
        // UpdateDriverForPlugAndPlayDevicesW updates by HWID, so it must never
        // run while a foreign service owns an identically-labelled Media node.
        if (set.HasForeignBinding()) return 50;
        DeviceInfo created = default; var registered = false;
        try
        {
            if (owned.Length == 0 && unbound.Length == 0)
            {
                created = DeviceInfo.Create(); var cls = MediaClass;
                if (!SetupDiCreateDeviceInfoW(set.Handle, AudioDriverSetup.Stem, ref cls, "CodexRemote Speakers", IntPtr.Zero, 1, ref created)) return LastError();
                var ids = Encoding.Unicode.GetBytes(AudioDriverSetup.HardwareId + "\0\0");
                if (!SetupDiSetDeviceRegistryPropertyW(set.Handle, ref created, 1, ids, (uint)ids.Length)) return LastError();
                if (!SetupDiCallClassInstaller(RegisterDevice, set.Handle, ref created)) return LastError();
                registered = true;
            }
            if (!UpdateDriverForPlugAndPlayDevicesW(IntPtr.Zero, AudioDriverSetup.HardwareId, inf, Force, out var reboot)) return LastError();
            rebootRequired = reboot;
            // Never call a staged package an installed driver.  SetupAPI must
            // report our exact Media-class/HWID/service triple after update.
            using var verificationSet = new DeviceSet(MediaClass, presentOnly: false);
            var bound = verificationSet.Owned().ToArray();
            if (bound.Length == 0) return 1168;
            if (!bound.Any(verificationSet.IsStarted)) return rebootRequired ? 0 : 21;
            return 0;
        }
        finally
        {
            if (registered && !rebootRequired && !OwnedExists()) SetupDiCallClassInstaller(DifRemove, set.Handle, ref created);
        }
    }

    public int Remove(out bool rebootRequired)
    {
        rebootRequired = false; var first = 0;
        using (var set = new DeviceSet(MediaClass, presentOnly: false))
        foreach (var device in set.Owned().Concat(set.UnboundStubs()).ToArray())
        {
            var target = device;
            // The set includes disconnected nodes.  Re-read all ownership
            // properties immediately before destructive removal.
            if (!set.IsRemovable(ref target)) { first = first == 0 ? 1168 : first; continue; }
            if (!SetupDiCallClassInstaller(DifRemove, set.Handle, ref target)) { first = first == 0 ? LastError() : first; continue; }
            var parameters = InstallParams.Create();
            if (!SetupDiGetDeviceInstallParamsW(set.Handle, ref target, ref parameters)) { first = first == 0 ? LastError() : first; continue; }
            rebootRequired |= (parameters.Flags & (DiNeedRestart | DiNeedReboot)) != 0;
        }
        if (first != 0) return first;
        foreach (var inf in OwnedPublishedInfs())
            if (!SetupUninstallOEMInfW(inf, 0, IntPtr.Zero) && Marshal.GetLastWin32Error() != 2) return LastError();
        return 0;
    }

    public bool IsAbsent()
    {
        using var set = new DeviceSet(MediaClass, presentOnly: false);
        return !set.Owned().Any() && !set.UnboundStubs().Any() && !OwnedPublishedInfs().Any();
    }
    private static bool OwnedExists() { using var set = new DeviceSet(MediaClass, presentOnly: false); return set.Owned().Any(); }
    private static IEnumerable<string> OwnedPublishedInfs()
    {
        var root = Path.Combine(Path.GetDirectoryName(Environment.SystemDirectory)!, "INF");
        var owned = new List<string>();
        foreach (var path in Directory.EnumerateFiles(root, "oem*.inf"))
        {
            var name = Path.GetFileName(path);
            if (!Regex.IsMatch(name, "^oem[0-9]{1,4}\\.inf$", RegexOptions.IgnoreCase)) continue;
            try
            {
                // The embedded release INF is the ownership authority.  A
                // substring hit can match an unrelated package or comment.
                if (AudioDriverSetup.MatchesExpectedInf(File.ReadAllText(path))) owned.Add(name);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        return owned;
    }
    private static int LastError() { var code = Marshal.GetLastWin32Error(); return code == 0 ? 1 : code; }

    private sealed class DeviceSet : IDisposable
    {
        internal IntPtr Handle { get; }
        internal DeviceSet(Guid cls, bool presentOnly = true) { Handle = SetupDiGetClassDevsW(ref cls, null, IntPtr.Zero, presentOnly ? 2u : 0u); if (Handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        internal IEnumerable<DeviceInfo> Owned()
        {
            for (uint index = 0; index < 4096; index++)
            {
                var data = DeviceInfo.Create();
                if (!SetupDiEnumDeviceInfo(Handle, index, ref data)) { if (Marshal.GetLastWin32Error() == 259) yield break; throw new Win32Exception(Marshal.GetLastWin32Error()); }
                if (IsOwned(ref data)) yield return data;
            }
            throw new IOException("Audio device enumeration exceeded safety limit.");
        }
        internal IEnumerable<DeviceInfo> UnboundStubs()
        {
            for (uint index = 0; index < 4096; index++)
            {
                var data = DeviceInfo.Create();
                if (!SetupDiEnumDeviceInfo(Handle, index, ref data)) { if (Marshal.GetLastWin32Error() == 259) yield break; throw new Win32Exception(Marshal.GetLastWin32Error()); }
                if (IsUnboundStub(ref data)) yield return data;
            }
            throw new IOException("Audio device enumeration exceeded safety limit.");
        }
        internal bool HasForeignBinding()
        {
            for (uint index = 0; index < 4096; index++)
            {
                var data = DeviceInfo.Create();
                if (!SetupDiEnumDeviceInfo(Handle, index, ref data)) { if (Marshal.GetLastWin32Error() == 259) return false; throw new Win32Exception(Marshal.GetLastWin32Error()); }
                if (HasHardwareId(ref data))
                {
                    var service = Property(ref data, 4);
                    if (!string.IsNullOrEmpty(service) && !string.Equals(service, AudioDriverSetup.ServiceName, StringComparison.OrdinalIgnoreCase)) return true;
                }
            }
            throw new IOException("Audio device enumeration exceeded safety limit.");
        }
        internal bool IsOwned(ref DeviceInfo data) => HasHardwareId(ref data) && string.Equals(Property(ref data, 4), AudioDriverSetup.ServiceName, StringComparison.OrdinalIgnoreCase);
        internal bool IsRemovable(ref DeviceInfo data) => IsOwned(ref data) || IsUnboundStub(ref data);
        private bool IsUnboundStub(ref DeviceInfo data) => HasHardwareId(ref data) && string.IsNullOrEmpty(Property(ref data, 4));
        internal bool IsStarted(DeviceInfo data)
        {
            var result = CM_Get_DevNode_Status(out var status, out _, data.DevInst, 0);
            return result == 0 && (status & 0x00000008) != 0; // DN_STARTED
        }
        private bool HasHardwareId(ref DeviceInfo data) => Property(ref data, 1)?.Split('\0').Any(id => string.Equals(id, AudioDriverSetup.HardwareId, StringComparison.OrdinalIgnoreCase)) == true;
        private string? Property(ref DeviceInfo data, uint property)
        {
            var buffer = new byte[65536];
            if (!SetupDiGetDeviceRegistryPropertyW(Handle, ref data, property, out var type, buffer, (uint)buffer.Length, out var needed)) { if (Marshal.GetLastWin32Error() == 13) return null; throw new Win32Exception(Marshal.GetLastWin32Error()); }
            if (needed > buffer.Length || needed % 2 != 0 || (type != 1 && type != 7)) throw new IOException("Device property format is invalid.");
            return Encoding.Unicode.GetString(buffer, 0, (int)needed).TrimEnd('\0');
        }
        public void Dispose() => SetupDiDestroyDeviceInfoList(Handle);
    }
    [StructLayout(LayoutKind.Sequential)] private struct DeviceInfo { public uint Size; public Guid ClassGuid; public uint DevInst; public UIntPtr Reserved; internal static DeviceInfo Create() => new() { Size = (uint)Marshal.SizeOf<DeviceInfo>() }; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct InstallParams { public uint Size, Flags, FlagsEx; public IntPtr A, B, C, D; public UIntPtr E; public uint F; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Path; internal static InstallParams Create() => new() { Size = (uint)Marshal.SizeOf<InstallParams>() }; }
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern bool SetupCopyOEMInfW(string source, string media, uint style, uint styleEx, StringBuilder destination, uint size, out uint required, IntPtr component);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern IntPtr SetupDiGetClassDevsW(ref Guid cls, string? enumerator, IntPtr parent, uint flags);
    [DllImport("setupapi.dll", ExactSpelling = true, SetLastError = true)] private static extern bool SetupDiEnumDeviceInfo(IntPtr set, uint index, ref DeviceInfo device);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern bool SetupDiCreateDeviceInfoW(IntPtr set, string name, ref Guid cls, string description, IntPtr parent, uint flags, ref DeviceInfo device);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern bool SetupDiSetDeviceRegistryPropertyW(IntPtr set, ref DeviceInfo device, uint property, byte[] data, uint size);
    [DllImport("setupapi.dll", ExactSpelling = true, SetLastError = true)] private static extern bool SetupDiCallClassInstaller(uint function, IntPtr set, ref DeviceInfo device);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern bool SetupDiGetDeviceInstallParamsW(IntPtr set, ref DeviceInfo device, ref InstallParams parameters);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern bool SetupDiGetDeviceRegistryPropertyW(IntPtr set, ref DeviceInfo device, uint property, out uint type, byte[] data, uint size, out uint needed);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern bool SetupUninstallOEMInfW(string name, uint flags, IntPtr reserved);
    [DllImport("setupapi.dll", ExactSpelling = true)] private static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("cfgmgr32.dll", ExactSpelling = true)] private static extern int CM_Get_DevNode_Status(out uint status, out uint problem, uint devInst, uint flags);
    [DllImport("newdev.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern bool UpdateDriverForPlugAndPlayDevicesW(IntPtr parent, string hardwareId, string inf, uint flags, out bool reboot);
}
