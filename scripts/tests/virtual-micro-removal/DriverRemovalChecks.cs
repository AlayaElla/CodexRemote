namespace VirtualMicroBroker;

internal static class DriverRemovalChecks
{
    private static readonly Guid HidClass = new("745a17a0-74d3-11d0-b6fe-00a0c90f57da");
    private static readonly Guid LegacySystemClass = new("4d36e97d-e325-11ce-bfc1-08002be10318");
    private const string Hardware = @"ROOT\CodexRemoteVirtualMicro", HostService = "WUDFRd", LegacyService = "CodexRemoteVirtualMicro";

    internal static void Run()
    {
        var owned = Device(1, HidClass, Hardware, HostService, DriverInfAssociation.Valid, "oem7.inf", true);
        var legacy = Device(2, LegacySystemClass, Hardware, LegacyService, DriverInfAssociation.Valid, "oem8.inf", true);
        var unrelatedService = Device(3, HidClass, Hardware, "Other", DriverInfAssociation.Valid, "oem9.inf", false);
        var unrelatedHardware = Device(4, HidClass, @"ROOT\Other", HostService, DriverInfAssociation.Valid, "oem10.inf", false);
        var unrelatedClass = Device(5, Guid.NewGuid(), Hardware, HostService, DriverInfAssociation.Valid, "oem11.inf", false);
        var fake = new Fake([owned, legacy, unrelatedService, unrelatedHardware, unrelatedClass]);
        Check(DriverRemovalNative.RemoveInstalledDriver(fake) == 0, "matching disconnected node removed");
        Check(fake.Removed.SequenceEqual([1L, 2L]), "current and exact legacy nodes removed");
        Check(fake.Uninstalled.SequenceEqual(["oem7.inf", "oem8.inf"]), "only exact associated INF considered");

        var none = new Fake([unrelatedService, unrelatedHardware, unrelatedClass]);
        Check(DriverRemovalNative.RemoveInstalledDriver(none) == 0 && none.Removed.Count == 0 && none.Uninstalled.Count == 0, "no match is no-op");

        var shared = new Fake([owned]) { UninstallCode = 32 };
        Check(DriverRemovalNative.RemoveInstalledDriver(shared) != 0, "shared or in-use INF failure is not success");
        Check(shared.Removed.SequenceEqual([1L]), "shared INF result remains a truthful partial cleanup");

        var missing = new Fake([owned with { InfAssociation = DriverInfAssociation.Missing, InfName = null }]);
        Check(DriverRemovalNative.RemoveInstalledDriver(missing) == 0 && missing.Removed.SequenceEqual([1L]), "missing INF association permits device cleanup");
        var stub = new Fake([owned with { ClassGuid = Guid.Empty, Service = null, InfAssociation = DriverInfAssociation.Missing, InfName = null }]);
        Check(DriverRemovalNative.RemoveInstalledDriver(stub) == 0 && stub.Removed.SequenceEqual([1L]), "unbound product stub removed");
        var orphan = new Fake([]) { PublishedInfs = ["oem7.inf", "oem9.inf"] };
        Check(DriverRemovalNative.RemoveInstalledDriver(orphan) == 0 && orphan.Uninstalled.SequenceEqual(["oem7.inf"]), "orphan package removed without touching foreign package");
        var retry = new Fake([owned]) { PublishedInfs = ["oem7.inf"], FailInf = "oem7.inf" };
        Check(DriverRemovalNative.RemoveInstalledDriver(retry) == 32, "first attempt reports package failure after removing node");
        retry.FailInf = null;
        Check(DriverRemovalNative.RemoveInstalledDriver(retry) == 0 && retry.Removed.Count == 1 && retry.Uninstalled.Count == 2, "second attempt discovers remaining package without a node or ledger");
        var pending = new Ledger([new("AABBCCDDEEFF00112233445566778899AABBCCDD", new string('A', 64), true, true, [])]);
        var interrupted = new Fake([owned]) { PublishedInfs = ["oem7.inf"] };
        Check(DriverRemovalNative.RemoveInstalledDriver(interrupted, pending, new Signing()) == DriverSetup.TrustRetainedPartialExitCode && interrupted.Uninstalled.Count == 1 && pending.Entries.Count == 1, "pending signing record does not block identified driver cleanup");
        var malformed = new Fake([owned with { InfAssociation = DriverInfAssociation.Malformed, InfName = null }]);
        Check(DriverRemovalNative.RemoveInstalledDriver(malformed) == DriverRemovalNative.ErrorInvalidData && malformed.Removed.SequenceEqual([1L]), "malformed INF association is partial");

        var removeFailure = new Fake([owned]) { RemoveCode = 5 };
        Check(DriverRemovalNative.RemoveInstalledDriver(removeFailure) == 5 && removeFailure.Uninstalled.Count == 0, "device removal error stops store cleanup");
        var reboot = new Fake([owned]) { Reboot = true };
        Check(DriverRemovalNative.RemoveInstalledDriver(reboot) == DriverSetup.RebootExitCode, "reboot signal preserved");
        var failedAfterReboot = new Fake([owned]) { Reboot = true, UninstallCode = 32 };
        var failedCode = DriverRemovalNative.RemoveInstalledDriver(failedAfterReboot, new Ledger([]), new Signing(), out var stillNeedsReboot);
        Check(failedCode == 32 && stillNeedsReboot, "Micro OEM failure preserves earlier reboot request");

        var two = new Fake([owned]) { Probes = new(StringComparer.OrdinalIgnoreCase) { ["oem7.inf"] = PublishedInfProbe.Owned, ["oem8.inf"] = PublishedInfProbe.Owned }, FailInf = "oem8.inf" };
        var ledger = new Ledger([new("AABBCCDDEEFF00112233445566778899AABBCCDD", "A".PadLeft(64, 'A'), true, false, ["oem7.inf", "oem8.inf"])]);
        Check(DriverRemovalNative.RemoveInstalledDriver(two, ledger, new Signing()) != 0, "second OEM failure retains journal");
        two.FailInf = null; two.Probes["oem7.inf"] = PublishedInfProbe.Missing;
        Check(DriverRemovalNative.RemoveInstalledDriver(two, ledger, new Signing()) == 0 && ledger.Entries.Count == 0, "missing first OEM permits retry of second");

        var denied = new Fake([owned]) { Probes = new(StringComparer.OrdinalIgnoreCase) { ["oem7.inf"] = PublishedInfProbe.ForeignOrUnknown } };
        Check(DriverRemovalNative.RemoveInstalledDriver(denied) == DriverRemovalNative.ErrorInvalidData && denied.Uninstalled.Count == 0, "access denied probe is not missing");
    }

    private static RemovalDevice Device(long token, Guid classGuid, string hardware, string service, DriverInfAssociation association, string? inf, bool disconnected) => new(token, classGuid, hardware, service, association, inf, disconnected);
    private static void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException("Driver removal self-test failed: " + name); }

    private sealed class Fake(IReadOnlyList<RemovalDevice> devices) : IRemovalPlatform
    {
        public bool IsWindowsX64 => true;
        public bool IsAdministrator => true;
        public int RemoveCode { get; init; }
        public int UninstallCode { get; init; }
        public string? FailInf { get; set; }
        public Dictionary<string, PublishedInfProbe> Probes { get; set; } = new(StringComparer.OrdinalIgnoreCase);
        public bool Reboot { get; init; }
        public List<long> Removed { get; } = [];
        public List<string> Uninstalled { get; } = [];
        public IReadOnlyList<string> PublishedInfs { get; init; } = [];
        public IReadOnlyList<string> EnumeratePublishedInfs() => PublishedInfs;
        public IReadOnlyList<RemovalDevice> EnumerateDevices() => devices.Where(device => !Removed.Contains(device.Token)).ToArray();
        public int RemoveDevice(RemovalDevice expected, out bool rebootRequired) { if (RemoveCode == 0) Removed.Add(expected.Token); rebootRequired = Reboot; return RemoveCode; }
        public PublishedInfProbe ProbePublishedInf(string infName) => Probes.TryGetValue(infName, out var probe) ? probe : infName is "oem7.inf" or "oem8.inf" ? PublishedInfProbe.Owned : PublishedInfProbe.ForeignOrUnknown;
        public int UninstallPublishedInf(string infName) { Uninstalled.Add(infName); return string.Equals(FailInf, infName, StringComparison.OrdinalIgnoreCase) ? 32 : UninstallCode; }
    }

    private sealed class Ledger(List<DriverTrustLedgerEntry> entries) : IDriverTrustLedger
    {
        public List<DriverTrustLedgerEntry> Entries { get; } = entries;
        public void BeginPending(string thumbprint) { } public void WritePendingTrust(string thumbprint, string identity) { } public void MarkStageStarted(string thumbprint) { } public void RecordPublishedInf(string thumbprint, string inf) { } public void AbandonBeforeStaging(string thumbprint) { }
        public IReadOnlyList<DriverTrustLedgerEntry> Read() => Entries;
        public void Remove(string thumbprint, IEnumerable<string> infs) { Entries.RemoveAll(entry => entry.Thumbprint == thumbprint); }
    }
    private sealed class Signing : ILocalDriverSigningPlatform
    {
        public LocalSigningCertificate CreateProductCertificate() => throw new NotSupportedException(); public void SignAuthenticode(LocalSigningCertificate certificate, string filePath) { } public bool VerifyCatalogMember(string catalogPath, string memberPath) => false; public bool VerifyCatalogSignature(string catalogPath, bool requireTrustedChain) => false; public void AddTrust(LocalSigningCertificate certificate, LocalDriverTrustStore store) { } public void RemoveTrustExact(string thumbprint, LocalDriverTrustStore store) { } public void DestroySigningMaterialExact(LocalSigningCertificate certificate) { }
    }
}
