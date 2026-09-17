using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace VirtualMicroBroker;

internal record DriverObservation(bool Installed, bool Ready);
internal record DriverStatusOutput(string State, string Message, bool Installed, bool DeviceReady, bool Success);

// Read-only PnP observation shared by the ordinary broker and separately
// elevated installer. It has no DriverStore staging, registration, NewDev,
// UAC, certificate, signing, or boot-policy calls.
internal static class DriverDeviceObservation
{
    private const string HostService = "WUDFRd";
    private const string HardwareId = @"ROOT\CodexRemoteVirtualMicro";
    private static readonly Guid HidClass = new("745a17a0-74d3-11d0-b6fe-00a0c90f57da");
    private static readonly Guid ControlInterface = new("E2A7CB54-8420-4D51-9DD8-D6575B9251D1");

    internal static DriverObservation Observe()
    {
        using var devices = new DeviceSet();
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
        private readonly IntPtr _handle;
        internal DeviceSet()
        {
            var guid = HidClass;
            // Include non-present nodes so status can distinguish installed from ready.
            _handle = SetupDiGetClassDevsW(ref guid, "ROOT", IntPtr.Zero, 0);
            if (_handle == new IntPtr(-1)) ThrowLastError();
        }

        internal IEnumerable<DeviceInfo> MatchingDevices()
        {
            for (uint index = 0; index < 4096; index++)
            {
                var data = DeviceInfo.Create();
                if (!SetupDiEnumDeviceInfo(_handle, index, ref data))
                {
                    if (Marshal.GetLastWin32Error() == 259) yield break;
                    ThrowLastError();
                }
                if ((Property(ref data, 1) ?? "").Split('\0').Contains(HardwareId, StringComparer.OrdinalIgnoreCase)) yield return data;
            }
            throw new IOException("Device enumeration exceeded its safety limit.");
        }

        internal string? Property(ref DeviceInfo data, uint property)
        {
            var buffer = new byte[65536];
            if (!SetupDiGetDeviceRegistryPropertyW(_handle, ref data, property, out var type, buffer, (uint)buffer.Length, out var needed))
            {
                if (Marshal.GetLastWin32Error() == 13) return null;
                ThrowLastError();
            }
            if (needed > buffer.Length || needed % 2 != 0 || (type != 1 && type != 7)) throw new IOException("Device property format is invalid.");
            return Encoding.Unicode.GetString(buffer, 0, (int)needed).TrimEnd('\0');
        }

        public void Dispose() => SetupDiDestroyDeviceInfoList(_handle);
    }

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr SetupDiGetClassDevsW(ref Guid guid, string enumerator, IntPtr parent, uint flags);
    [DllImport("setupapi.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool SetupDiEnumDeviceInfo(IntPtr set, uint index, ref DeviceInfo data);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool SetupDiGetDeviceRegistryPropertyW(IntPtr set, ref DeviceInfo data, uint property,
        out uint type, [Out] byte[] buffer, uint size, out uint needed);
    [DllImport("setupapi.dll", ExactSpelling = true)]
    private static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("cfgmgr32.dll", ExactSpelling = true)]
    private static extern uint CM_Get_DevNode_Status(out uint status, out uint problem, uint devInst, uint flags);
}

internal static class DriverStatus
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    internal static DriverStatusOutput Read()
    {
        try
        {
            var observation = DriverDeviceObservation.Observe();
            if (observation.Ready) return new("ready", "虚拟 Micro 驱动已安装，控制接口已就绪。", true, true, true);
            if (observation.Installed) return new("installed_not_ready", "虚拟 Micro 驱动已安装，但控制接口尚未就绪。", true, false, false);
            return new("not_installed", "尚未安装虚拟 Micro 驱动。", false, false, false);
        }
        catch (Exception error)
        {
            return new("status_unavailable", "无法读取虚拟 Micro 驱动状态：" + Bound(error.Message), false, false, false);
        }
    }

    internal static void WriteJson() => Console.WriteLine(JsonSerializer.Serialize(Read(), JsonOptions));
    private static string Bound(string message) => message.Length <= 512 ? message : message[..512];
}
