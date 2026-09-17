using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Security.AccessControl;
using System.Security.Principal;

namespace VirtualMicroBroker;

// This journal is deliberately not a trust authority. It only records exact
// references which must still be independently revalidated from DriverStore
// before removal. A pending entry means "keep trust": crashes must never turn
// uncertainty into certificate deletion.
internal sealed record DriverTrustLedgerEntry(string Thumbprint, string SnapshotIdentity, bool StageStarted, bool PendingStage, IReadOnlyList<string> PublishedInfs);

internal interface IDriverTrustLedger
{
    void BeginPending(string thumbprint);
    void WritePendingTrust(string thumbprint, string snapshotIdentity);
    void RecordPublishedInf(string thumbprint, string publishedInf);
    void MarkStageStarted(string thumbprint);
    void AbandonBeforeStaging(string thumbprint);
    IReadOnlyList<DriverTrustLedgerEntry> Read();
    void Remove(string thumbprint, IEnumerable<string> publishedInfs);
}

internal sealed class DriverTrustLedger : IDriverTrustLedger
{
    private static readonly Regex OemInf = new("^oem[0-9]{1,4}\\.inf$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private readonly string _path;
    private readonly bool _testBackend;
    private readonly object _gate = new();

    internal DriverTrustLedger(string? path = null)
    {
        _testBackend = path is not null;
        _path = path ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "CodexRemoteVirtualMicroDriverTrust", "ledger.json");
    }

    public void BeginPending(string thumbprint)
        => WritePendingTrust(thumbprint, "legacy-no-snapshot");

    public void WritePendingTrust(string thumbprint, string snapshotIdentity)
    {
        ValidateThumbprint(thumbprint);
        if (!Regex.IsMatch(snapshotIdentity, "^[0-9A-F]{64}$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase) && snapshotIdentity != "legacy-no-snapshot")
            throw new IOException("受保护驱动快照标识无效。");
        lock (_gate)
        {
            var entries = Load();
            if (!entries.Any(entry => string.Equals(entry.Thumbprint, thumbprint, StringComparison.OrdinalIgnoreCase)))
                entries.Add(new(thumbprint, snapshotIdentity, false, false, []));
            Save(entries);
        }
    }

    public void RecordPublishedInf(string thumbprint, string publishedInf)
    {
        ValidateThumbprint(thumbprint);
        if (!OemInf.IsMatch(publishedInf)) throw new IOException("DriverStore 发布名称无效。");
        lock (_gate)
        {
            var entries = Load();
            var index = entries.FindIndex(entry => string.Equals(entry.Thumbprint, thumbprint, StringComparison.OrdinalIgnoreCase));
            if (index < 0) throw new IOException("缺少驱动签名待处理记录。");
            var prior = entries[index];
            var infs = prior.PublishedInfs.Append(publishedInf).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(name => name, StringComparer.OrdinalIgnoreCase).ToArray();
            entries[index] = new(prior.Thumbprint, prior.SnapshotIdentity, true, false, infs);
            Save(entries);
        }
    }

    public void MarkStageStarted(string thumbprint)
    {
        ValidateThumbprint(thumbprint);
        lock (_gate)
        {
            var entries = Load(); var index = entries.FindIndex(entry => string.Equals(entry.Thumbprint, thumbprint, StringComparison.OrdinalIgnoreCase));
            if (index < 0) throw new IOException("缺少驱动签名待处理记录。");
            var prior = entries[index];
            if (prior.StageStarted) throw new IOException("驱动签名记录已进入安装阶段。");
            entries[index] = new(prior.Thumbprint, prior.SnapshotIdentity, true, true, prior.PublishedInfs); Save(entries);
        }
    }

    // The signer invokes its journal callback before trust import. If signing
    // fails before SetupCopyOEMInf is ever reached, this exact pending-only
    // record may be removed together with the exact newly imported trust.
    public void AbandonBeforeStaging(string thumbprint)
    {
        ValidateThumbprint(thumbprint);
        lock (_gate)
        {
            var entries = Load();
            var index = entries.FindIndex(entry => string.Equals(entry.Thumbprint, thumbprint, StringComparison.OrdinalIgnoreCase));
            if (index < 0) return;
            if (entries[index].StageStarted || entries[index].PendingStage || entries[index].PublishedInfs.Count != 0)
                throw new IOException("驱动签名记录已可能被 DriverStore 引用。");
            entries.RemoveAt(index);
            Save(entries);
        }
    }

    public IReadOnlyList<DriverTrustLedgerEntry> Read()
    {
        lock (_gate) return Load().Select(entry => entry with { PublishedInfs = entry.PublishedInfs.ToArray() }).ToArray();
    }

    // Removing a ledger entry is only legal after the caller independently
    // confirms every listed exact package has gone from DriverStore.
    public void Remove(string thumbprint, IEnumerable<string> publishedInfs)
    {
        ValidateThumbprint(thumbprint);
        var expected = publishedInfs.Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(name => name, StringComparer.OrdinalIgnoreCase).ToArray();
        if (expected.Any(name => !OemInf.IsMatch(name))) throw new IOException("DriverStore 发布名称无效。");
        lock (_gate)
        {
            var entries = Load();
            var index = entries.FindIndex(entry => string.Equals(entry.Thumbprint, thumbprint, StringComparison.OrdinalIgnoreCase));
            if (index < 0) throw new IOException("缺少驱动签名记录。");
            var entry = entries[index];
            if (entry.PendingStage || !entry.PublishedInfs.OrderBy(name => name, StringComparer.OrdinalIgnoreCase).SequenceEqual(expected, StringComparer.OrdinalIgnoreCase))
                throw new IOException("驱动签名记录仍有未确认的系统引用。");
            entries.RemoveAt(index);
            Save(entries);
        }
    }

    private List<DriverTrustLedgerEntry> Load()
    {
        if (_testBackend)
        {
            if (!File.Exists(_path)) return [];
        }
        else if (!TryValidateProductionPathForRead()) return [];
        var info = new FileInfo(_path);
        if (info.Attributes.HasFlag(FileAttributes.ReparsePoint) || info.Length is < 1 or > 65536) throw new IOException("驱动签名记录文件无效。");
        using var stream = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var entries = JsonSerializer.Deserialize(stream, DriverTrustLedgerJsonContext.Default.ListDriverTrustLedgerEntry) ?? throw new IOException("驱动签名记录格式无效。");
        if (!IsValidEntries(entries)) throw new IOException("驱动签名记录内容无效。");
        return entries;
    }

    private void Save(List<DriverTrustLedgerEntry> entries)
    {
        if (!IsValidEntries(entries)) throw new IOException("驱动签名记录内容无效。");
        var serialized = JsonSerializer.SerializeToUtf8Bytes(entries, DriverTrustLedgerJsonContext.Default.ListDriverTrustLedgerEntry);
        if (serialized.Length is < 1 or > 65536) throw new IOException("驱动签名记录文件无效。");
        var directory = Path.GetDirectoryName(_path)!;
        EnsureProtectedDirectory(directory);
        if (!_testBackend) _ = FileExistsAndValidateProductionLedger();
        var temporary = _path + "." + Guid.NewGuid().ToString("N") + ".new";
        using (FileStream stream = _testBackend
            ? new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)
            : FileSystemAclExtensions.Create(new FileInfo(temporary), FileMode.CreateNew, FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.WriteThrough, CreateProductionLedgerFileSecurity()))
        {
            stream.Write(serialized);
            stream.Flush(flushToDisk: true);
        }
        try
        {
            if (!_testBackend) ValidateProductionFileSecurity(temporary);
            File.Move(temporary, _path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static void ValidateThumbprint(string thumbprint)
    {
        if (!IsValidThumbprint(thumbprint))
            throw new IOException("证书指纹无效。");
    }
    private static bool IsValidThumbprint(string value) => Regex.IsMatch(value, "^[0-9A-F]{40,128}$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static bool IsValidSnapshot(string value) => Regex.IsMatch(value, "^[0-9A-F]{64}$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase) || value == "legacy-no-snapshot";
    private static bool IsValidEntries(IReadOnlyList<DriverTrustLedgerEntry> entries) =>
        entries.Count <= 128 &&
        entries.All(entry => entry is not null && IsValidThumbprint(entry.Thumbprint) && IsValidSnapshot(entry.SnapshotIdentity) && entry.PublishedInfs is not null && entry.PublishedInfs.Count <= 128 && entry.PublishedInfs.All(name => !string.IsNullOrWhiteSpace(name) && OemInf.IsMatch(name))) &&
        entries.Select(entry => entry.Thumbprint).Distinct(StringComparer.OrdinalIgnoreCase).Count() == entries.Count;

    private void EnsureProtectedDirectory(string directory)
    {
        if (_testBackend) { Directory.CreateDirectory(directory); return; }
        if (Directory.Exists(directory))
        {
            ValidateProductionDirectory(directory);
            return;
        }
        var parent = Path.GetDirectoryName(directory)!;
        if (!DirectoryExistsWithoutReparse(parent)) throw new IOException("驱动签名记录父目录无效。");
        var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(admins);
        foreach (var sid in new[] { admins, system }) security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(directory).Create(security);
        ValidateProductionDirectory(directory);
    }

    // Production callers must never treat an unreadable or redirected journal as
    // absent: only an explicit file/directory-not-found result is an empty ledger.
    private bool TryValidateProductionPathForRead()
    {
        var directory = Path.GetDirectoryName(_path)!;
        if (!DirectoryExistsWithoutReparse(directory)) return false;
        ValidateProductionDirectory(directory);
        return FileExistsAndValidateProductionLedger();
    }

    private bool FileExistsAndValidateProductionLedger()
    {
        try
        {
            var attributes = File.GetAttributes(_path);
            if (attributes.HasFlag(FileAttributes.ReparsePoint)) throw new IOException("驱动签名记录文件无效。");
            ValidateProductionFileSecurity(_path);
            return true;
        }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
    }

    private static bool DirectoryExistsWithoutReparse(string directory)
    {
        try
        {
            if (File.GetAttributes(directory).HasFlag(FileAttributes.ReparsePoint)) throw new IOException("驱动签名记录目录无效。");
            return true;
        }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
    }

    private static void ValidateProductionDirectory(string directory)
    {
        var item = new DirectoryInfo(directory);
        if (item.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new IOException("驱动签名记录目录无效。");
        var security = item.GetAccessControl();
        if (!security.AreAccessRulesProtected || !HasSafeLedgerOwnerAndAllowRules(security))
            throw new IOException("驱动签名记录目录权限无效。");
    }

    // The ledger file may inherit the safe ACEs from its protected directory;
    // requiring the file DACL itself to be protected would reject that safe layout.
    private static void ValidateProductionFileSecurity(string path)
    {
        var security = new FileInfo(path).GetAccessControl();
        if (!HasSafeLedgerOwnerAndAllowRules(security))
            throw new IOException("驱动签名记录文件权限无效。");
    }

    private static FileSecurity CreateProductionLedgerFileSecurity()
    {
        var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var security = new FileSecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(admins);
        foreach (var sid in new[] { admins, system })
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
        return security;
    }

    // Kept pure/internal so the installer test assembly can exercise the ACL
    // policy with in-memory FileSecurity/DirectorySecurity objects.
    internal static bool HasSafeLedgerOwnerAndAllowRules(FileSystemSecurity security)
    {
        if (!IsSystemOrAdministrators(security.GetOwner(typeof(SecurityIdentifier)))) return false;
        if (new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0).DiscretionaryAcl is null) return false;
        return security.GetAccessRules(includeExplicit: true, includeInherited: true, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .All(rule => rule.AccessControlType != AccessControlType.Allow || IsSystemOrAdministrators(rule.IdentityReference));
    }

    private static bool IsSystemOrAdministrators(IdentityReference? identity) =>
        identity is SecurityIdentifier sid &&
        (sid.Equals(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null)) || sid.Equals(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null)));
}

[JsonSerializable(typeof(List<DriverTrustLedgerEntry>))]
internal partial class DriverTrustLedgerJsonContext : JsonSerializerContext;
