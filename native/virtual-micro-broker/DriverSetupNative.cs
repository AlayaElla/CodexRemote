using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace VirtualMicroBroker;

internal static class DriverSetupNative
{
    internal static readonly Guid HidClass = new("745a17a0-74d3-11d0-b6fe-00a0c90f57da");
    private static readonly Guid LegacySystemClass = new("4d36e97d-e325-11ce-bfc1-08002be10318");
    private static readonly Guid ControlInterface = new("E2A7CB54-8420-4D51-9DD8-D6575B9251D1");
    private const string HostService = "WUDFRd";
    private const uint RegisterDevice = 0x19, RemoveDevice = 0x05;
    private const uint InstallFlagForce = 0x00000001;

    internal static DriverObservation Observe()
    {
        using var devices = new DeviceSet(HidClass);
        var installed = false;
        var started = false;
        foreach (var entry in devices.MatchingDevices())
        {
            var data = entry;
            var service = devices.Property(ref data, 4); // SPDRP_SERVICE
            installed |= string.Equals(service, HostService, StringComparison.OrdinalIgnoreCase);
            if (CM_Get_DevNode_Status(out var status, out var problem, data.DevInst, 0) == 0 &&
                (status & 8) != 0 && problem == 0 && string.Equals(service, HostService, StringComparison.OrdinalIgnoreCase))
                started = true;
        }
        return new(installed, started && SetupApi.FindInterfacePaths(ControlInterface).Any());
    }

    internal static int Install(string package, bool overwrite = false) => Install(package, overwrite, null);

    // The callback runs immediately after SetupCopyOEMInf returns its exact
    // published oem*.inf name, before any root-node/PnP mutation. The caller
    // uses it to durably record certificate-to-DriverStore ownership.
    internal static int Install(string package, bool overwrite, Action<string>? stagedPackage)
    {
        var inf = Path.Combine(package, DriverSetup.Stem + ".inf");
        // Stage and let Windows validate the package before creating a root node.
        // Uses inbox SetupAPI, not redistributable-restricted WDK test tools.
        var published = new StringBuilder(260);
        if (!SetupCopyOEMInfW(inf, package, 1, 0, published, (uint)published.Capacity, out var required, IntPtr.Zero))
        {
            var error = Marshal.GetLastWin32Error();
            if (error != 122 || required is 0 or > 32768) throw new Win32Exception(error);
            published = new StringBuilder((int)required);
            if (!SetupCopyOEMInfW(inf, package, 1, 0, published, (uint)published.Capacity, out required, IntPtr.Zero)) ThrowLastError();
        }
        var publishedName = Path.GetFileName(published.ToString());
        if (!System.Text.RegularExpressions.Regex.IsMatch(publishedName, "^oem[0-9]{1,4}\\.inf$", System.Text.RegularExpressions.RegexOptions.CultureInvariant | System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            throw new IOException("Windows 返回的驱动发布名称无效。");
        stagedPackage?.Invoke(publishedName);
        // The package was staged before a legacy node is removed. A migration
        // only touches the exact pre-UMDF ownership triple, never every System
        // device, WUDFRd service, or HIDClass device.
        var legacyReboot = RemoveOwnedLegacyNodes();
        using var devices = new DeviceSet(HidClass);
        var existing = devices.MatchingDevices().ToArray();
        DeviceInfo created = default;
        var registered = false;
        try
        {
            if (existing.Length == 0)
            {
                var classGuid = HidClass;
                created = DeviceInfo.Create();
                if (!SetupDiCreateDeviceInfoW(devices.Handle, "CodexRemoteVirtualMicro", ref classGuid,
                    "CodexRemote Virtual Micro", IntPtr.Zero, 1, ref created)) ThrowLastError();
                var hardwareIds = Encoding.Unicode.GetBytes(DriverSetup.HardwareId + "\0\0");
                if (!SetupDiSetDeviceRegistryPropertyW(devices.Handle, ref created, 1, hardwareIds, (uint)hardwareIds.Length)) ThrowLastError();
                if (!SetupDiCallClassInstaller(RegisterDevice, devices.Handle, ref created)) ThrowLastError();
                registered = true;
            }
            if (!UpdateDriverForPlugAndPlayDevicesW(IntPtr.Zero, DriverSetup.HardwareId, inf, overwrite ? InstallFlagForce : 0, out var reboot))
            {
                var error = Marshal.GetLastWin32Error();
                if (error == 259 && !overwrite && Observe().Ready) return 0; // Current driver is already better.
                throw new Win32Exception(error);
            }
            // Successful installation is retained even if startup is asynchronous.
            // A reboot request is reported to the UI, never automatically performed.
            registered = false;
            if (reboot || legacyReboot) return DriverSetup.RebootExitCode;
            for (var attempt = 0; attempt < 20; attempt++)
            {
                if (Observe().Ready) return 0;
                Thread.Sleep(250);
            }
            return 21; // ERROR_NOT_READY, do not falsely report a ready device.
        }
        catch
        {
            if (registered)
            {
                // Roll back only the root node created by this invocation. Never
                // remove an existing user's device or uninstall a shared package.
                SetupDiCallClassInstaller(RemoveDevice, devices.Handle, ref created);
            }
            throw;
        }
    }

    private static bool RemoveOwnedLegacyNodes()
    {
        using var devices = new DeviceSet(LegacySystemClass);
        var reboot = false;
        foreach (var entry in devices.MatchingDevices())
        {
            var data = entry;
            if (!string.Equals(devices.Property(ref data, 4), DriverSetup.Stem, StringComparison.OrdinalIgnoreCase)) continue;
            if (!SetupDiCallClassInstaller(RemoveDevice, devices.Handle, ref data)) ThrowLastError();
            var parameters = DeviceInstallParams.Create();
            if (!SetupDiGetDeviceInstallParamsW(devices.Handle, ref data, ref parameters)) ThrowLastError();
            reboot |= (parameters.Flags & (0x80 | 0x100)) != 0;
        }
        return reboot;
    }

    private static void ThrowLastError() => throw new Win32Exception(Marshal.GetLastWin32Error());

    [StructLayout(LayoutKind.Sequential)]
    private struct DeviceInfo
    {
        public uint Size;
        public Guid ClassGuid;
        public uint DevInst;
        public UIntPtr Reserved;
        internal static DeviceInfo Create() => new() { Size = (uint)Marshal.SizeOf<DeviceInfo>() };
    }

    private sealed class DeviceSet : IDisposable
    {
        internal IntPtr Handle { get; }
        internal DeviceSet(Guid deviceClass)
        {
            var guid = deviceClass;
            // Include non-present nodes so repeated installs do not create duplicates.
            Handle = SetupDiGetClassDevsW(ref guid, "ROOT", IntPtr.Zero, 0);
            if (Handle == new IntPtr(-1)) ThrowLastError();
        }
        internal IEnumerable<DeviceInfo> MatchingDevices()
        {
            for (uint index = 0; index < 4096; index++)
            {
                var data = DeviceInfo.Create();
                if (!SetupDiEnumDeviceInfo(Handle, index, ref data))
                {
                    if (Marshal.GetLastWin32Error() == 259) yield break;
                    ThrowLastError();
                }
                if ((Property(ref data, 1) ?? "").Split('\0').Contains(DriverSetup.HardwareId, StringComparer.OrdinalIgnoreCase))
                    yield return data;
            }
            throw new IOException("设备枚举超出限制。");
        }
        internal string? Property(ref DeviceInfo data, uint property)
        {
            var buffer = new byte[65536];
            if (!SetupDiGetDeviceRegistryPropertyW(Handle, ref data, property, out var type, buffer, (uint)buffer.Length, out var needed))
            {
                if (Marshal.GetLastWin32Error() == 13) return null; // Property is not set.
                ThrowLastError();
            }
            if (needed > buffer.Length || needed % 2 != 0 || (type != 1 && type != 7))
                throw new IOException("设备属性格式无效。");
            return Encoding.Unicode.GetString(buffer, 0, (int)needed).TrimEnd('\0');
        }
        public void Dispose() => SetupDiDestroyDeviceInfoList(Handle);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DeviceInstallParams
    {
        public uint Size, Flags, FlagsEx;
        public IntPtr HwndParent, InstallMsgHandler, InstallMsgHandlerContext, FileQueue;
        public UIntPtr ClassInstallReserved;
        public uint Reserved;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string DriverPath;
        internal static DeviceInstallParams Create() => new() { Size = (uint)Marshal.SizeOf<DeviceInstallParams>() };
    }

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr SetupDiGetClassDevsW(ref Guid guid, string enumerator, IntPtr parent, uint flags);
    [DllImport("setupapi.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool SetupDiEnumDeviceInfo(IntPtr set, uint index, ref DeviceInfo data);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool SetupDiGetDeviceRegistryPropertyW(IntPtr set, ref DeviceInfo data, uint property,
        out uint type, [Out] byte[] buffer, uint size, out uint needed);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool SetupDiCreateDeviceInfoW(IntPtr set, string name, ref Guid guid, string description,
        IntPtr parent, uint flags, ref DeviceInfo data);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool SetupDiSetDeviceRegistryPropertyW(IntPtr set, ref DeviceInfo data, uint property, byte[] buffer, uint size);
    [DllImport("setupapi.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool SetupDiCallClassInstaller(uint function, IntPtr set, ref DeviceInfo data);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool SetupDiGetDeviceInstallParamsW(IntPtr set, ref DeviceInfo data, ref DeviceInstallParams parameters);
    [DllImport("setupapi.dll", ExactSpelling = true)]
    private static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool SetupCopyOEMInfW(string inf, string source, uint mediaType, uint copyStyle,
        StringBuilder destination, uint size, out uint requiredSize, IntPtr component);
    [DllImport("newdev.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool UpdateDriverForPlugAndPlayDevicesW(IntPtr parent, string hardwareId, string inf, uint flags,
        [MarshalAs(UnmanagedType.Bool)] out bool rebootRequired);
    [DllImport("cfgmgr32.dll", ExactSpelling = true)]
    private static extern uint CM_Get_DevNode_Status(out uint status, out uint problem, uint devInst, uint flags);
}
