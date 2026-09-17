using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace VirtualMicroBroker;

internal static class SetupApi
{
    [StructLayout(LayoutKind.Sequential)]
    private struct InterfaceData { public int Size; public Guid ClassGuid; public int Flags; public IntPtr Reserved; }
    [StructLayout(LayoutKind.Sequential)]
    private struct DeviceInfo { public int Size; public Guid ClassGuid; public uint DevInst; public IntPtr Reserved; }
    [StructLayout(LayoutKind.Sequential)]
    private struct HidAttributes { public int Size; public ushort Vendor, Product, Version; }

    private static readonly Guid DriverControlInterface = new("E2A7CB54-8420-4D51-9DD8-D6575B9251D1");

    internal static IEnumerable<string> FindInterfacePaths(Guid guid)
    {
        var set = SetupDiGetClassDevsW(ref guid, null, IntPtr.Zero, 2 | 16);
        if (set == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            for (uint index = 0; index < 1024; index++)
            {
                var data = new InterfaceData { Size = Marshal.SizeOf<InterfaceData>() };
                if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref guid, index, ref data))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error == 259) yield break;
                    throw new Win32Exception(error);
                }
                SetupDiGetDeviceInterfaceDetailW(set, ref data, IntPtr.Zero, 0, out var size, IntPtr.Zero);
                if (Marshal.GetLastWin32Error() != 122 || size < 8 || size > 65536)
                    throw new IOException("Invalid device interface detail length.");
                var memory = Marshal.AllocHGlobal((int)size);
                try
                {
                    Marshal.WriteInt32(memory, IntPtr.Size == 8 ? 8 : 6);
                    if (!SetupDiGetDeviceInterfaceDetailW(set, ref data, memory, size, out _, IntPtr.Zero))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    var path = Marshal.PtrToStringUni(IntPtr.Add(memory, 4));
                    if (!string.IsNullOrEmpty(path)) yield return path;
                }
                finally { Marshal.FreeHGlobal(memory); }
            }
            throw new IOException("Device interface enumeration exceeded limit.");
        }
        finally { SetupDiDestroyDeviceInfoList(set); }
    }

    internal static TargetMicroEndpoints FindTargetMicroEndpoints()
    {
        var controls = EnumerateInterfaceCandidates(DriverControlInterface, inspectHid: false);
        HidD_GetHidGuid(out var hidGuid);
        var hids = EnumerateInterfaceCandidates(hidGuid, inspectHid: true);
        return TargetMicroSelector.Select(controls, hids);
    }

    private static IReadOnlyList<DeviceInterfaceCandidate> EnumerateInterfaceCandidates(Guid guid, bool inspectHid)
    {
        var set = SetupDiGetClassDevsW(ref guid, null, IntPtr.Zero, 2 | 16);
        if (set == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var candidates = new List<DeviceInterfaceCandidate>();
            for (uint index = 0; index < 1024; index++)
            {
                var data = new InterfaceData { Size = Marshal.SizeOf<InterfaceData>() };
                if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref guid, index, ref data))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error == 259) break;
                    throw new Win32Exception(error);
                }
                SetupDiGetDeviceInterfaceDetailW(set, ref data, IntPtr.Zero, 0, out var size, IntPtr.Zero);
                if (Marshal.GetLastWin32Error() != 122 || size < 8 || size > 65536)
                    throw new IOException("Invalid device interface detail length.");
                var memory = Marshal.AllocHGlobal((int)size);
                try
                {
                    Marshal.WriteInt32(memory, IntPtr.Size == 8 ? 8 : 6);
                    var device = new DeviceInfo { Size = Marshal.SizeOf<DeviceInfo>() };
                    if (!SetupDiGetDeviceInterfaceDetailW(set, ref data, memory, size, out _, ref device))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    var path = Marshal.PtrToStringUni(IntPtr.Add(memory, 4));
                    if (string.IsNullOrEmpty(path)) continue;
                    candidates.Add(new DeviceInterfaceCandidate(
                        path, DeviceId(device.DevInst), HardwareIds(set, ref device),
                        AncestorIds(device.DevInst), inspectHid && IsMatchingMicroHid(path)));
                }
                finally { Marshal.FreeHGlobal(memory); }
            }
            return candidates;
        }
        finally { SetupDiDestroyDeviceInfoList(set); }
    }

    private static string DeviceId(uint devInst)
    {
        var buffer = new StringBuilder(512);
        if (CM_Get_Device_IDW(devInst, buffer, buffer.Capacity, 0) != 0)
            throw new IOException("Unable to resolve a device-interface instance ID.");
        return buffer.ToString();
    }

    private static IReadOnlySet<string> AncestorIds(uint devInst)
    {
        var ancestors = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var depth = 0; depth < 64; depth++)
        {
            ancestors.Add(DeviceId(devInst));
            if (CM_Get_Parent(out var parent, devInst, 0) != 0) return ancestors;
            devInst = parent;
        }
        throw new IOException("Device parent chain exceeded the safety limit.");
    }

    private static IReadOnlyList<string> HardwareIds(IntPtr set, ref DeviceInfo device)
    {
        var buffer = new byte[65536];
        if (!SetupDiGetDeviceRegistryPropertyW(set, ref device, 1, out var type, buffer, (uint)buffer.Length, out var needed))
        {
            if (Marshal.GetLastWin32Error() == 13) return [];
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if (needed > buffer.Length || needed % 2 != 0 || (type != 1 && type != 7))
            throw new IOException("Device hardware-ID property format is invalid.");
        return Encoding.Unicode.GetString(buffer, 0, (int)needed).Split('\0', StringSplitOptions.RemoveEmptyEntries);
    }

    private static bool IsMatchingMicroHid(string path)
    {
        // Zero desired access only queries capabilities, never reads or writes reports.
        using var device = Native.CreateFileW(path, 0, 3, IntPtr.Zero, Native.OpenExisting, 0, IntPtr.Zero);
        if (device.IsInvalid) return false;
        var attributes = new HidAttributes { Size = Marshal.SizeOf<HidAttributes>() };
        if (!HidD_GetAttributes(device, ref attributes) || attributes.Vendor != 0x303A || attributes.Product != 0x8360) return false;
        if (!HidD_GetPreparsedData(device, out var preparsed)) return false;
        try
        {
            var caps = new byte[64];
            return HidP_GetCaps(preparsed, caps) >= 0 && BitConverter.ToUInt16(caps, 0) == 1 &&
                BitConverter.ToUInt16(caps, 2) == 0xFF00 && BitConverter.ToUInt16(caps, 4) == 64 &&
                BitConverter.ToUInt16(caps, 6) == 64;
        }
        finally { HidD_FreePreparsedData(preparsed); }
    }

    internal static bool HasMicroHid()
    {
        HidD_GetHidGuid(out var guid);
        foreach (var path in FindInterfacePaths(guid))
        {
            // Zero desired access only queries capabilities, never reads/writes reports.
            using var device = Native.CreateFileW(path, 0, 3, IntPtr.Zero, Native.OpenExisting, 0, IntPtr.Zero);
            if (device.IsInvalid) continue;
            var attributes = new HidAttributes { Size = Marshal.SizeOf<HidAttributes>() };
            if (!HidD_GetAttributes(device, ref attributes) || attributes.Vendor != 0x303A || attributes.Product != 0x8360) continue;
            if (!HidD_GetPreparsedData(device, out var preparsed)) continue;
            try
            {
                // HIDP_CAPS is 64 bytes of USHORTs; first fields are usage/page,
                // input/output byte lengths. No report or user audio is captured.
                var caps = new byte[64];
                if (HidP_GetCaps(preparsed, caps) >= 0 && BitConverter.ToUInt16(caps, 0) == 1 &&
                    BitConverter.ToUInt16(caps, 2) == 0xFF00 && BitConverter.ToUInt16(caps, 4) == 64 &&
                    BitConverter.ToUInt16(caps, 6) == 64) return true;
            }
            finally { HidD_FreePreparsedData(preparsed); }
        }
        return false;
    }

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr SetupDiGetClassDevsW(ref Guid guid, string? enumerator, IntPtr parent, uint flags);
    [DllImport("setupapi.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr device, ref Guid guid, uint index, ref InterfaceData data);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool SetupDiGetDeviceInterfaceDetailW(IntPtr set, ref InterfaceData data, IntPtr detail,
        uint bytes, out uint needed, IntPtr device);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool SetupDiGetDeviceInterfaceDetailW(IntPtr set, ref InterfaceData data, IntPtr detail,
        uint bytes, out uint needed, ref DeviceInfo device);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool SetupDiGetDeviceRegistryPropertyW(IntPtr set, ref DeviceInfo device, uint property,
        out uint type, [Out] byte[] buffer, uint size, out uint needed);
    [DllImport("setupapi.dll", ExactSpelling = true)]
    private static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("hid.dll", ExactSpelling = true)] private static extern void HidD_GetHidGuid(out Guid guid);
    [DllImport("hid.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.U1)] private static extern bool HidD_GetAttributes(SafeFileHandle device, ref HidAttributes attributes);
    [DllImport("hid.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.U1)] private static extern bool HidD_GetPreparsedData(SafeFileHandle device, out IntPtr data);
    [DllImport("hid.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.U1)] private static extern bool HidD_FreePreparsedData(IntPtr data);
    [DllImport("hid.dll", ExactSpelling = true)] private static extern int HidP_GetCaps(IntPtr data, [Out] byte[] caps);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint CM_Get_Device_IDW(uint devInst, StringBuilder buffer, int length, uint flags);
    [DllImport("cfgmgr32.dll", ExactSpelling = true)]
    private static extern uint CM_Get_Parent(out uint parent, uint devInst, uint flags);
}
