using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Win32.SafeHandles;

namespace VirtualMicroBroker;

// This is deliberately not a general-purpose signing API.  DriverSetup can call
// it only after it has checked the fixed, protected package snapshot.
internal enum LocalDriverSigningStep { None, CreateCertificate, SignDriver, VerifyDriverMembership, SignCatalog, VerifyCatalogMembership, TrustRoot, TrustPublisher, VerifyTrustedCatalog, Cleanup }
internal enum LocalDriverTrustStore { Root, TrustedPublisher }
internal sealed record LocalDriverSigningResult(bool Success, LocalDriverSigningStep Step, string Message, string? Thumbprint = null, LocalDriverSigningLease? Lease = null);
internal sealed record LocalSigningCertificate(X509Certificate2 Certificate, string Thumbprint);

// Before the first SetupCopyOEMInf/PnP mutation, the caller must durably journal
// this thumbprint and then retain the lease.  Prior to that point disposal rolls
// back only this attempt's exact trust entries.  After retain, uncertainty must
// preserve trust because Windows can still retain a staged package reference.
internal sealed class LocalDriverSigningLease : IDisposable
{
    private readonly ILocalDriverSigningPlatform _platform;
    private readonly string _thumbprint;
    private bool _retained;
    internal bool CleanupSucceeded { get; private set; } = true;
    internal string? CleanupFailure { get; private set; }
    internal LocalDriverSigningLease(ILocalDriverSigningPlatform platform, string thumbprint) { _platform = platform; _thumbprint = thumbprint; }
    internal string Thumbprint => _thumbprint;
    internal void RetainForStaging() => _retained = true;
    internal void Commit() => RetainForStaging();
    // The integration layer can abandon its pending journal only when this
    // returns true. Any uncertain store cleanup must retain the journal.
    internal bool TryRollbackBeforeStaging()
    {
        if (_retained) return CleanupSucceeded;
        Remove(LocalDriverTrustStore.TrustedPublisher);
        Remove(LocalDriverTrustStore.Root);
        _retained = true;
        return CleanupSucceeded;
    }
    public void Dispose()
    {
        _ = TryRollbackBeforeStaging();
    }
    private void Remove(LocalDriverTrustStore store)
    {
        try { _platform.RemoveTrustExact(_thumbprint, store); }
        catch (Exception error) { CleanupSucceeded = false; CleanupFailure ??= error.Message; }
    }
}

// Native side effects are behind this boundary so the ordering and rollback
// policy can be tested without creating a certificate, changing trust, or
// writing a driver package.
internal interface ILocalDriverSigningPlatform
{
    LocalSigningCertificate CreateProductCertificate();
    void SignAuthenticode(LocalSigningCertificate certificate, string filePath);
    bool VerifyCatalogMember(string catalogPath, string memberPath);
    bool VerifyCatalogSignature(string catalogPath, bool requireTrustedChain);
    void AddTrust(LocalSigningCertificate certificate, LocalDriverTrustStore store);
    void RemoveTrustExact(string thumbprint, LocalDriverTrustStore store);
    void DestroySigningMaterialExact(LocalSigningCertificate certificate);
}

// Production implementation.  It is never selected by the self-tests; its
// LocalMachine writes require elevation and are reached only from the future
// protected-snapshot installation path.
internal sealed class WindowsLocalDriverSigningPlatform : ILocalDriverSigningPlatform
{
    private readonly Action<string>? _beforeFirstTrustImport;
    private bool _journaled;
    internal WindowsLocalDriverSigningPlatform(Action<string>? beforeFirstTrustImport = null) => _beforeFirstTrustImport = beforeFirstTrustImport;
    public LocalSigningCertificate CreateProductCertificate() => WindowsEphemeralSigningCertificate.CreateNonExportable();
    public void SignAuthenticode(LocalSigningCertificate certificate, string filePath) => WindowsAuthenticodeSigner.SignAttachedCertificate(filePath, certificate.Certificate);
    public bool VerifyCatalogMember(string catalogPath, string memberPath) => WindowsCatalogTrust.VerifyRawMember(catalogPath, memberPath);
    public bool VerifyCatalogSignature(string catalogPath, bool requireTrustedChain) => WindowsCatalogTrust.VerifyCatalog(catalogPath, requireTrustedChain);
    public void AddTrust(LocalSigningCertificate certificate, LocalDriverTrustStore store)
    {
        if (!_journaled) { _beforeFirstTrustImport?.Invoke(certificate.Thumbprint); _journaled = true; }
        using var destination = new X509Store(store == LocalDriverTrustStore.Root ? StoreName.Root : StoreName.TrustedPublisher, StoreLocation.LocalMachine);
        destination.Open(OpenFlags.ReadWrite | OpenFlags.OpenExistingOnly);
        using var publicOnly = X509CertificateLoader.LoadCertificate(certificate.Certificate.RawData);
        destination.Add(publicOnly);
    }
    public void RemoveTrustExact(string thumbprint, LocalDriverTrustStore store)
    {
        using var destination = new X509Store(store == LocalDriverTrustStore.Root ? StoreName.Root : StoreName.TrustedPublisher, StoreLocation.LocalMachine);
        destination.Open(OpenFlags.ReadWrite | OpenFlags.OpenExistingOnly);
        foreach (var candidate in destination.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false).Cast<X509Certificate2>().ToArray()) { try { destination.Remove(candidate); } finally { candidate.Dispose(); } }
    }
    public void DestroySigningMaterialExact(LocalSigningCertificate certificate) => certificate.Certificate.Dispose();
}

internal static class LocalDriverSigning
{
    // Keep the surface package-scoped.  Neither this class nor Program exposes
    // command-line options accepting an arbitrary certificate or filename.
    internal static LocalDriverSigningResult SignAndTrustFixedPackage(string package, ILocalDriverSigningPlatform platform)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(package);
        ArgumentNullException.ThrowIfNull(platform);
        var inf = FixedFile(package, ".inf");
        var driver = FixedFile(package, ".dll");
        var catalog = FixedFile(package, ".cat");
        if (!File.Exists(inf) || !File.Exists(driver) || !File.Exists(catalog))
            return new(false, LocalDriverSigningStep.None, "固定驱动包不完整，未创建本地签名证书。");

        LocalSigningCertificate? certificate = null;
        var trustedRoot = false;
        var trustedPublisher = false;
        var step = LocalDriverSigningStep.CreateCertificate;
        try
        {
            certificate = platform.CreateProductCertificate();
            if (string.IsNullOrWhiteSpace(certificate.Thumbprint)) throw new InvalidOperationException("本地签名证书缺少指纹。");

            step = LocalDriverSigningStep.SignDriver;
            platform.SignAuthenticode(certificate, driver);
            step = LocalDriverSigningStep.VerifyDriverMembership;
            if (!platform.VerifyCatalogMember(catalog, driver)) throw new InvalidOperationException("签名后的 DLL 不再匹配预生成目录。请重新生成驱动包目录。");

            step = LocalDriverSigningStep.SignCatalog;
            platform.SignAuthenticode(certificate, catalog);
            step = LocalDriverSigningStep.VerifyCatalogMembership;
            if (!platform.VerifyCatalogMember(catalog, inf) || !platform.VerifyCatalogMember(catalog, driver))
                throw new InvalidOperationException("签名后的目录成员校验失败。");
            // This check intentionally precedes trust import: it demonstrates
            // that the catalog is cryptographically signed, without accepting
            // a chain merely because this operation just added it.
            if (!platform.VerifyCatalogSignature(catalog, requireTrustedChain: false))
                throw new InvalidOperationException("目录签名格式校验失败。");

            step = LocalDriverSigningStep.TrustRoot;
            trustedRoot = true; // Add can mutate before reporting an exception.
            platform.AddTrust(certificate, LocalDriverTrustStore.Root);
            step = LocalDriverSigningStep.TrustPublisher;
            trustedPublisher = true; // rollback exact thumbprint on an ambiguous Add failure.
            platform.AddTrust(certificate, LocalDriverTrustStore.TrustedPublisher);
            step = LocalDriverSigningStep.VerifyTrustedCatalog;
            if (!platform.VerifyCatalogSignature(catalog, requireTrustedChain: true) ||
                !platform.VerifyCatalogMember(catalog, inf) || !platform.VerifyCatalogMember(catalog, driver))
                throw new InvalidOperationException("Windows 未确认本地目录签名和成员哈希。");
            return new(true, LocalDriverSigningStep.Cleanup, "本地签名目录已通过校验。", certificate.Thumbprint,
                new LocalDriverSigningLease(platform, certificate.Thumbprint));
        }
        catch (Exception error) when (error is CryptographicException or IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            // Never remove by subject: an interrupted attempt can only undo the
            // exact thumbprint this operation created.
            if (certificate is not null)
            {
                if (trustedPublisher) Try(() => platform.RemoveTrustExact(certificate.Thumbprint, LocalDriverTrustStore.TrustedPublisher));
                if (trustedRoot) Try(() => platform.RemoveTrustExact(certificate.Thumbprint, LocalDriverTrustStore.Root));
            }
            return new(false, step, Bound(error.Message), certificate?.Thumbprint);
        }
        finally
        {
            if (certificate is not null) Try(() => platform.DestroySigningMaterialExact(certificate));
        }
    }

    private static string FixedFile(string package, string extension) => Path.Combine(package, DriverSetup.Stem + extension);
    private static void Try(Action action) { try { action(); } catch { /* retain the primary failure */ } }
    private static string Bound(string value) => value.Length <= 512 ? value : value[..512];
}

// A direct wrapper over the OS Authenticode function.  Microsoft documents
// that this API has no import library/header and must be dynamically resolved
// from Mssign32.dll; the managed layouts below follow that published ABI.
// Certificate creation/store policy intentionally stays outside this wrapper.
internal static class WindowsAuthenticodeSigner
{
    private const uint SignerSubjectFile = 1, SignerCertStore = 2, SignerCertPolicyChainNoRoot = 8;
    private const uint CalgSha256 = 0x0000800c;

    internal static void SignAttachedCertificate(string filePath, X509Certificate2 certificate)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        if (!File.Exists(filePath)) throw new FileNotFoundException("签名目标不存在。", filePath);
        if (!certificate.HasPrivateKey) throw new CryptographicException("签名证书不含私钥。");
        var module = NativeLibrary.Load(Path.Combine(Environment.SystemDirectory, "Mssign32.dll"));
        try
        {
            var proc = Marshal.GetDelegateForFunctionPointer<SignerSignEx3Delegate>(NativeLibrary.GetExport(module, "SignerSignEx3"));
            var signerFile = new SignerFileInfo { Size = (uint)Marshal.SizeOf<SignerFileInfo>(), FileName = filePath };
            var subject = new SignerSubjectInfo { Size = (uint)Marshal.SizeOf<SignerSubjectInfo>(), SubjectChoice = SignerSubjectFile };
            var store = new SignerCertStoreInfo { Size = (uint)Marshal.SizeOf<SignerCertStoreInfo>(), SigningCert = certificate.Handle, CertPolicy = SignerCertPolicyChainNoRoot };
            var signerCert = new SignerCert { Size = (uint)Marshal.SizeOf<SignerCert>(), CertChoice = SignerCertStore };
            var signature = new SignerSignatureInfo { Size = (uint)Marshal.SizeOf<SignerSignatureInfo>(), HashAlgorithm = CalgSha256 };
            var indexMemory = Marshal.AllocHGlobal(sizeof(uint));
            var fileMemory = Marshal.AllocHGlobal(Marshal.SizeOf<SignerFileInfo>());
            var storeMemory = Marshal.AllocHGlobal(Marshal.SizeOf<SignerCertStoreInfo>());
            try
            {
                Marshal.WriteInt32(indexMemory, 0); subject.Index = indexMemory;
                Marshal.StructureToPtr(signerFile, fileMemory, false); subject.FileInfo = fileMemory;
                Marshal.StructureToPtr(store, storeMemory, false); signerCert.StoreInfo = storeMemory;
                var hr = proc(0, ref subject, ref signerCert, ref signature, IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out var context, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
                try { if (hr < 0) throw new CryptographicException($"SignerSignEx3 failed: 0x{hr:X8}"); }
                finally { if (context != IntPtr.Zero) FreeSignerContext(module, context); }
            }
            finally { Marshal.DestroyStructure<SignerFileInfo>(fileMemory); Marshal.FreeHGlobal(storeMemory); Marshal.FreeHGlobal(fileMemory); Marshal.FreeHGlobal(indexMemory); }
        }
        finally { NativeLibrary.Free(module); }
    }

    private static void FreeSignerContext(IntPtr module, IntPtr context)
    {
        var free = Marshal.GetDelegateForFunctionPointer<SignerFreeContextDelegate>(NativeLibrary.GetExport(module, "SignerFreeSignerContext"));
        _ = free(context);
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate int SignerSignEx3Delegate(uint flags, ref SignerSubjectInfo subject, ref SignerCert certificate, ref SignerSignatureInfo signature, IntPtr provider, uint timestampFlags, IntPtr timestampAlgorithm, IntPtr timestampUrl, IntPtr request, IntPtr sipData, out IntPtr context, IntPtr strongSignPolicy, IntPtr digestSignInfo, IntPtr reserved);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate int SignerFreeContextDelegate(IntPtr context);
    [StructLayout(LayoutKind.Sequential)] private struct SignerFileInfo { public uint Size; [MarshalAs(UnmanagedType.LPWStr)] public string FileName; public IntPtr File; }
    [StructLayout(LayoutKind.Sequential)] private struct SignerSubjectInfo { public uint Size; public IntPtr Index; public uint SubjectChoice; public IntPtr FileInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct SignerCertStoreInfo { public uint Size; public IntPtr SigningCert; public uint CertPolicy; public IntPtr Store; }
    [StructLayout(LayoutKind.Sequential)] private struct SignerCert { public uint Size; public uint CertChoice; public IntPtr StoreInfo; public IntPtr Window; }
    [StructLayout(LayoutKind.Sequential)] private struct SignerSignatureInfo { public uint Size; public uint HashAlgorithm; public uint AttributeChoice; public IntPtr Attributes; public IntPtr Authenticated; public IntPtr Unauthenticated; }
}

// Catalog membership is checked with the same Authenticode/SIP hash mechanism
// Windows uses for a catalog subject. Before trust import only successful
// signature validation or an untrusted-chain result is accepted; bad formats
// and bad signatures fail closed.
internal static class WindowsCatalogTrust
{
    private const uint ChoiceFile = 1, ChoiceCatalog = 2, UiNone = 2, StateVerify = 1, StateClose = 2, CacheOnlyUrlRetrieval = 0x1000, RevocationCheckChainExcludeRoot = 0x80;
    private const int Success = 0, CertEUntrustedRoot = unchecked((int)0x800B0109), CertEChainBuilding = unchecked((int)0x800B010A), CertEUntrustedTestRoot = unchecked((int)0x800B010D);
    internal static bool VerifyCatalog(string catalog, bool requireTrustedChain) => IsAcceptable(Verify(ChoiceFile, new TrustFile { Size = (uint)Marshal.SizeOf<TrustFile>(), Path = catalog }), requireTrustedChain);
    internal static bool VerifyMember(string catalog, string member, bool requireTrustedChain)
    {
        foreach (var algorithm in new[] { "SHA256", "SHA1" })
        {
            if (!CryptCATAdminAcquireContext2(out var admin, IntPtr.Zero, algorithm, IntPtr.Zero, 0)) continue;
            try
            {
                using var file = File.OpenHandle(member, FileMode.Open, FileAccess.Read, FileShare.Read);
                uint count = 0;
                if (!CryptCATAdminCalcHashFromFileHandle2(admin, file, ref count, null, 0) || count is 0 or > 128) continue;
                var hash = new byte[count];
                if (!CryptCATAdminCalcHashFromFileHandle2(admin, file, ref count, hash, 0)) continue;
                var pin = GCHandle.Alloc(hash, GCHandleType.Pinned);
                try
                {
                    var subject = new TrustCatalog { Size = (uint)Marshal.SizeOf<TrustCatalog>(), CatalogPath = catalog, MemberPath = member, MemberTag = Convert.ToHexString(hash), MemberFile = file.DangerousGetHandle(), Hash = pin.AddrOfPinnedObject(), HashSize = count, Admin = admin };
                    if (IsAcceptable(Verify(ChoiceCatalog, subject), requireTrustedChain)) return true;
                }
                finally { pin.Free(); GC.KeepAlive(file); }
            }
            finally { CryptCATAdminReleaseContext(admin, 0); }
        }
        return false;
    }
    // Raw membership is intentionally separate from trust: this is the only
    // valid pre-signing check for an Inf2Cat-produced unsigned catalog.
    internal static bool VerifyRawMember(string catalog, string member)
    {
        try
        {
            var tag = Convert.ToHexString(CalculateSipHash(member));
            var handle = CryptCATOpen(catalog, 0, IntPtr.Zero, 0, 0);
            if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return false;
            try { return CryptCATGetMemberInfo(handle, tag) != IntPtr.Zero; }
            finally { CryptCATClose(handle); }
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
        catch (CryptographicException) { return false; }
    }
    internal static byte[] CalculateSipHash(string member)
    {
        if (!CryptCATAdminAcquireContext2(out var admin, IntPtr.Zero, "SHA256", IntPtr.Zero, 0)) throw new CryptographicException(Marshal.GetLastWin32Error());
        try
        {
            using var file = File.OpenHandle(member, FileMode.Open, FileAccess.Read, FileShare.Read);
            uint count = 0;
            if (!CryptCATAdminCalcHashFromFileHandle2(admin, file, ref count, null, 0) || count is 0 or > 128) throw new CryptographicException(Marshal.GetLastWin32Error());
            var hash = new byte[count];
            if (!CryptCATAdminCalcHashFromFileHandle2(admin, file, ref count, hash, 0)) throw new CryptographicException(Marshal.GetLastWin32Error());
            return hash;
        }
        finally { CryptCATAdminReleaseContext(admin, 0); }
    }
    private static bool IsAcceptable(int code, bool trusted) => code == Success || (!trusted && code is CertEUntrustedRoot or CertEChainBuilding or CertEUntrustedTestRoot);
    private static int Verify<T>(uint choice, T subject) where T : struct
    {
        var pointer = Marshal.AllocHGlobal(Marshal.SizeOf<T>());
        Marshal.StructureToPtr(subject, pointer, false);
        var data = new TrustData { Size = (uint)Marshal.SizeOf<TrustData>(), UIChoice = UiNone, UnionChoice = choice, Subject = pointer, StateAction = StateVerify, ProviderFlags = CacheOnlyUrlRetrieval | RevocationCheckChainExcludeRoot };
        var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        try { return WinVerifyTrust(new IntPtr(-1), ref action, ref data); }
        finally { data.StateAction = StateClose; WinVerifyTrust(new IntPtr(-1), ref action, ref data); Marshal.DestroyStructure<T>(pointer); Marshal.FreeHGlobal(pointer); }
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct TrustFile { public uint Size; [MarshalAs(UnmanagedType.LPWStr)] public string Path; public IntPtr File, KnownSubject; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct TrustCatalog { public uint Size, Version; [MarshalAs(UnmanagedType.LPWStr)] public string CatalogPath; [MarshalAs(UnmanagedType.LPWStr)] public string MemberTag; [MarshalAs(UnmanagedType.LPWStr)] public string MemberPath; public IntPtr MemberFile, Hash; public uint HashSize; public IntPtr CatalogContext, Admin; }
    [StructLayout(LayoutKind.Sequential)] private struct TrustData { public uint Size; public IntPtr PolicyCallback, SipClient; public uint UIChoice, RevocationChecks, UnionChoice; public IntPtr Subject; public uint StateAction; public IntPtr StateData, UrlReference; public uint ProviderFlags, UIContext; public IntPtr SignatureSettings; }
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("wintrust.dll", ExactSpelling = true)] private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern bool CryptCATAdminAcquireContext2(out IntPtr context, IntPtr subsystem, string algorithm, IntPtr policy, uint flags);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = true)] private static extern bool CryptCATAdminCalcHashFromFileHandle2(IntPtr context, Microsoft.Win32.SafeHandles.SafeFileHandle file, ref uint count, [Out] byte[]? hash, uint flags);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("wintrust.dll", ExactSpelling = true)] private static extern bool CryptCATAdminReleaseContext(IntPtr context, uint flags);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern IntPtr CryptCATOpen(string path, uint flags, IntPtr provider, uint version, uint encoding);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("wintrust.dll", ExactSpelling = true)] private static extern bool CryptCATClose(IntPtr catalog);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern IntPtr CryptCATGetMemberInfo(IntPtr catalog, string tag);
}

// This factory creates the production signing identity in memory: no CNG key
// name, no export policy, and no certificate-store write. The certificate
// context owns a duplicated CNG handle until local signing is complete.
internal static class WindowsEphemeralSigningCertificate
{
    // No container name makes the key transient.  CertificateRequest.Create
    // avoids CreateSelfSigned/CopyWithPrivateKey, which requires exportability.
    internal static LocalSigningCertificate CreateNonExportable()
    {
        var parameters = new CngKeyCreationParameters
        {
            ExportPolicy = CngExportPolicies.None,
            KeyUsage = CngKeyUsages.Signing,
            Provider = CngProvider.MicrosoftSoftwareKeyStorageProvider
        };
        var key = CngKey.Create(CngAlgorithm.Rsa, null, parameters);
        var rsa = new RSACng(key);
        var subject = new X500DistinguishedName("CN=CodexRemote Local Driver Development");
        var request = new CertificateRequest(subject, rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid("1.3.6.1.5.5.7.3.3") }, true));
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        var certificate = request.Create(subject, X509SignatureGenerator.CreateForRSA(rsa, RSASignaturePadding.Pkcs1), DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddYears(5), RandomNumberGenerator.GetBytes(16));
        try
        {
            using var handle = key.Handle; // creates a duplicate NCRYPT handle
            if (!CertSetCertificateContextProperty(certificate.Handle, 78, 0x40000000, handle)) throw new CryptographicException(Marshal.GetLastWin32Error());
            // Windows now owns this duplicate through the certificate context;
            // INHIBIT_PERSIST prevents any property write to a store.
            handle.SetHandleAsInvalid();
            rsa.Dispose(); key.Dispose();
            return new LocalSigningCertificate(certificate, certificate.Thumbprint);
        }
        catch { certificate.Dispose(); rsa.Dispose(); key.Dispose(); throw; }
    }
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("crypt32.dll", ExactSpelling = true, SetLastError = true)] private static extern bool CertSetCertificateContextProperty(IntPtr certificateContext, uint propertyId, uint flags, SafeNCryptKeyHandle value);
}
