namespace VirtualMicroBroker;

internal sealed record DeviceInterfaceCandidate(
    string Path,
    string InstanceId,
    IReadOnlyList<string> HardwareIds,
    IReadOnlySet<string> AncestorInstanceIds,
    bool MatchesMicroHid);

internal sealed record TargetMicroEndpoints(string ControlPath, string HidPath);

// Kept independent of SetupAPI calls so a device-selection mistake is unit-testable.
internal static class TargetMicroSelector
{
    internal const string TargetHardwareId = @"ROOT\CodexRemoteVirtualMicro";

    internal static TargetMicroEndpoints Select(
        IEnumerable<DeviceInterfaceCandidate> controls,
        IEnumerable<DeviceInterfaceCandidate> hids)
    {
        var targets = controls.Where(IsTargetControl).ToArray();
        if (targets.Length == 0)
            throw new IOException("CodexRemote Virtual Micro control interface was not found.");
        if (targets.Length != 1)
            throw new IOException("Ambiguous CodexRemote Virtual Micro control interfaces; resolve duplicate target devices before connecting.");

        var control = targets[0];
        var matchingHids = hids.Where(hid => hid.MatchesMicroHid &&
            hid.AncestorInstanceIds.Contains(control.InstanceId, StringComparer.OrdinalIgnoreCase)).ToArray();
        if (matchingHids.Length == 0)
            throw new IOException("The CodexRemote Virtual Micro control device has no matching descendant HID interface.");
        if (matchingHids.Length != 1)
            throw new IOException("Ambiguous matching HID interfaces for CodexRemote Virtual Micro; resolve duplicate target HID devices before connecting.");

        return new(control.Path, matchingHids[0].Path);
    }

    private static bool IsTargetControl(DeviceInterfaceCandidate candidate) =>
        candidate.InstanceId.StartsWith(TargetHardwareId + "\\", StringComparison.OrdinalIgnoreCase) &&
        candidate.HardwareIds.Contains(TargetHardwareId, StringComparer.OrdinalIgnoreCase);
}
