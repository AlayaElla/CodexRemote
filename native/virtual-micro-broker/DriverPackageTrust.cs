using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace VirtualMicroBroker;

internal static class DriverPackageTrust
{
    // Verify both catalog trust and exact membership of the INF and UMDF DLL.
    // This is preflight only: Windows still enforces package/load policy later.
    internal static bool Verify(string package)
    {
        var catalogPath = Path.Combine(package, DriverSetup.Stem + ".cat");
        return VerifySignedMembers(catalogPath, Path.Combine(package, DriverSetup.Stem + ".inf"),
            Path.Combine(package, DriverSetup.Stem + ".dll"));
    }

    internal static bool VerifySignedMembers(string catalogPath, params string[] members)
    {
        var file = new TrustFile { Size = (uint)Marshal.SizeOf<TrustFile>(), Path = catalogPath };
        if (!VerifyTrust(1, file)) return false;
        return VerifyCatalogMembers(catalogPath, members);
    }

    // Used only before elevation, together with the installer-embedded SHA-256
    // bytes. The raw Inf2Cat catalog has not yet been locally signed there, so
    // this proves member hashes but deliberately does not claim trusted-chain
    // status. The elevated path must call VerifySignedMembers after signing.
    internal static bool VerifyCatalogMembers(string catalogPath, params string[] members) =>
        File.Exists(catalogPath) && members.All(member => WindowsCatalogTrust.VerifyRawMember(catalogPath, member));

    internal static bool VerifyCatalogMembers(string package) => VerifyCatalogMembers(
        Path.Combine(package, DriverSetup.Stem + ".cat"),
        Path.Combine(package, DriverSetup.Stem + ".inf"), Path.Combine(package, DriverSetup.Stem + ".dll"));

    private static bool VerifyMember(string catalogPath, string memberPath)
    {
        // Inf2Cat emits SHA256 catalogs. SHA1 is also understood for compatible
        // existing signed packages; each attempt independently verifies trust.
        foreach (var algorithm in new[] { "SHA256", "SHA1" })
        {
            if (!CryptCATAdminAcquireContext2(out var admin, IntPtr.Zero, algorithm, IntPtr.Zero, 0)) continue;
            try
            {
                using var member = File.OpenHandle(memberPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                uint size = 0;
                if (!CryptCATAdminCalcHashFromFileHandle2(admin, member, ref size, null, 0) || size is 0 or > 128) continue;
                var hash = new byte[size];
                if (!CryptCATAdminCalcHashFromFileHandle2(admin, member, ref size, hash, 0)) continue;
                var pin = GCHandle.Alloc(hash, GCHandleType.Pinned);
                try
                {
                    var catalog = new TrustCatalog
                    {
                        Size = (uint)Marshal.SizeOf<TrustCatalog>(), CatalogPath = catalogPath,
                        MemberPath = memberPath, MemberTag = Convert.ToHexString(hash),
                        MemberFile = member.DangerousGetHandle(), Hash = pin.AddrOfPinnedObject(),
                        HashSize = size, Admin = admin
                    };
                    if (VerifyTrust(2, catalog)) return true;
                }
                finally { pin.Free(); GC.KeepAlive(member); }
            }
            finally { CryptCATAdminReleaseContext(admin, 0); }
        }
        return false;
    }

    private static bool VerifyTrust<T>(uint choice, T subject) where T : struct
    {
        var memory = Marshal.AllocHGlobal(Marshal.SizeOf<T>());
        Marshal.StructureToPtr(subject, memory, false);
        var data = new TrustData
        {
            Size = (uint)Marshal.SizeOf<TrustData>(), UIChoice = 2, UnionChoice = choice,
            Subject = memory, StateAction = 1,
            // Cache-only revocation prevents a status check waiting on the network.
            // Missing trust fails closed; the OS installer applies its own policy.
            ProviderFlags = 0x1000 | 0x80
        };
        var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        try { return WinVerifyTrust(new IntPtr(-1), ref action, ref data) == 0; }
        finally
        {
            data.StateAction = 2;
            WinVerifyTrust(new IntPtr(-1), ref action, ref data);
            Marshal.DestroyStructure<T>(memory);
            Marshal.FreeHGlobal(memory);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TrustFile
    {
        public uint Size;
        [MarshalAs(UnmanagedType.LPWStr)] public string Path;
        public IntPtr File, KnownSubject;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TrustCatalog
    {
        public uint Size, Version;
        [MarshalAs(UnmanagedType.LPWStr)] public string CatalogPath;
        [MarshalAs(UnmanagedType.LPWStr)] public string MemberTag;
        [MarshalAs(UnmanagedType.LPWStr)] public string MemberPath;
        public IntPtr MemberFile, Hash;
        public uint HashSize;
        public IntPtr CatalogContext, Admin;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct TrustData
    {
        public uint Size;
        public IntPtr PolicyCallback, SipClient;
        public uint UIChoice, RevocationChecks, UnionChoice;
        public IntPtr Subject;
        public uint StateAction;
        public IntPtr StateData, UrlReference;
        public uint ProviderFlags, UIContext;
        public IntPtr SignatureSettings;
    }
    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
    [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CryptCATAdminAcquireContext2(out IntPtr context, IntPtr subsystem, string hashAlgorithm, IntPtr policy, uint flags);
    [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool CryptCATAdminCalcHashFromFileHandle2(IntPtr context, SafeFileHandle file, ref uint hashSize, [Out] byte[]? hash, uint flags);
    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern bool CryptCATAdminReleaseContext(IntPtr context, uint flags);
}
