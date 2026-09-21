namespace VirtualMicroBroker;

internal static class DriverBundleOperationsTests
{
    internal static void Run()
    {
        var mutations = 0;
        ComponentResult Mutate() { mutations++; return new(0, true, false); }
        var blocked = DriverBundleOperations.Install(() => false, Mutate, Mutate);
        Check(!blocked.Success && !blocked.Micro.Attempted && !blocked.Audio.Attempted && mutations == 0, "preflight failure mutates neither package");
        blocked = DriverBundleOperations.Install(() => throw new IOException(), Mutate, Mutate);
        Check(!blocked.Success && mutations == 0, "preflight exception mutates neither package");
        var partial = DriverBundleOperations.Install(() => true, () => new(5, true, true), Mutate);
        Check(!partial.Success && partial.RebootRequired && !partial.Audio.Attempted && mutations == 0, "Micro failure skips audio and retains reboot");
        partial = DriverBundleOperations.Install(() => true, Mutate, () => throw new IOException());
        Check(!partial.Success && partial.Micro.Success && partial.Audio.Attempted, "audio install exception reports partial result");
        var removal = DriverBundleOperations.Remove(() => throw new IOException(), () => new(0, true, true));
        Check(!removal.Success && removal.Audio.Success && removal.RebootRequired, "Micro exception does not skip audio or discard reboot");
        removal = DriverBundleOperations.Remove(() => new(0, true, false, true), () => new(5, true, true));
        Check(!removal.Success && removal.Micro.Absent && removal.RebootRequired && removal.ExitCode == 5, "same component failure and reboot both survive aggregation");
        removal = DriverBundleOperations.Remove(() => new(0, true, false, true), () => new(0, true, false, true));
        Check(removal.Success && removal.ExitCode == 0, "both components already absent is successful cleanup");

        var audio = AudioDriverSetup.RemoveComponent(new FakeAudio { Absent = true });
        Check(audio.Success && audio.Absent, "already absent audio remains explicit");
        audio = AudioDriverSetup.RemoveComponent(new FakeAudio { RemoveCode = 5, Reboot = true });
        Check(!audio.Success && audio.Code == 5 && audio.RebootRequired, "audio platform error preserves reboot");
        audio = AudioDriverSetup.RemoveComponent(new FakeAudio { Reboot = true });
        Check(audio.Code == 1168 && audio.RebootRequired, "remaining audio identity prevents success and retains reboot");
        audio = AudioDriverSetup.RemoveComponent(new FakeAudio { Reboot = true, ThrowAfterReboot = true });
        Check(!audio.Success && audio.RebootRequired, "audio exception after a reboot request retains it");

        using var stream = typeof(AudioDriverSetup).Assembly.GetManifestResourceStream("AudioDriverSetup.ExpectedInf")!;
        using var reader = new StreamReader(stream);
        var expected = reader.ReadToEnd();
        Check(AudioDriverSetup.MatchesExpectedInf(expected), "exact product INF accepted");
        Check(!AudioDriverSetup.MatchesExpectedInf(expected.Replace("AddService=CodexRemoteVirtualAudio,", "AddService=OtherService,")), "foreign service rejected");
        Check(!AudioDriverSetup.MatchesExpectedInf("; ROOT\\CodexRemoteVirtualAudio AddService=CodexRemoteVirtualAudio\n[Version]\nDriverVer=09/21/2026,1.0.0.0"), "comment-only identity cannot authorize OEM removal");
    }
    private sealed class FakeAudio : IAudioDriverPlatform
    {
        public bool IsAdministrator => true;
        internal bool Absent { get; init; }
        internal bool Reboot { get; init; }
        internal int RemoveCode { get; init; }
        internal bool ThrowAfterReboot { get; init; }
        public int Install(string package, out bool rebootRequired) => throw new NotSupportedException();
        public bool IsAbsent() => Absent;
        public int Remove(out bool rebootRequired)
        {
            rebootRequired = Reboot;
            if (ThrowAfterReboot) throw new IOException("simulated removal failure");
            return RemoveCode;
        }
    }
    private static void Check(bool value, string name) { if (!value) throw new InvalidOperationException("Bundle operation test failed: " + name); }
}
