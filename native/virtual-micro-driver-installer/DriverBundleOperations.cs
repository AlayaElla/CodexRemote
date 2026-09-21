namespace VirtualMicroBroker;

internal sealed record ComponentResult(int Code, bool Attempted, bool RebootRequired, bool Absent = false)
{
    internal bool Success => Attempted && Code == 0;
    internal int ExitCode => Code != 0 ? Code : RebootRequired ? DriverSetup.RebootExitCode : 0;
    internal static ComponentResult FromExitCode(int code, bool reboot = false, bool absent = false) =>
        new(code == DriverSetup.RebootExitCode ? 0 : code, true, reboot || code == DriverSetup.RebootExitCode, absent);
    internal static ComponentResult Failure(Exception error, bool reboot = false) =>
        new(error is System.ComponentModel.Win32Exception win32 && win32.NativeErrorCode != 0 ? win32.NativeErrorCode : 1, true, reboot);
}
internal sealed record BundleOperationResult(ComponentResult Micro, ComponentResult Audio)
{
    internal bool Success => Micro.Success && Audio.Success;
    internal bool RebootRequired => Micro.RebootRequired || Audio.RebootRequired;
    internal int ExitCode => !Success ? (Micro.Code != 0 ? Micro.Code : Audio.Code != 0 ? Audio.Code : 1) : RebootRequired ? DriverSetup.RebootExitCode : 0;
}

internal static class DriverBundleOperations
{
    internal static BundleOperationResult Install(Func<bool> preflight, Func<ComponentResult> micro, Func<ComponentResult> audio)
    {
        try { if (!preflight()) return new(new(577, false, false), new(577, false, false)); }
        catch { return new(new(577, false, false), new(577, false, false)); }
        var microResult = Invoke(micro);
        return new(microResult, microResult.Success ? Invoke(audio) : new(0, false, false));
    }
    internal static BundleOperationResult Remove(Func<ComponentResult> micro, Func<ComponentResult> audio)
    {
        var microResult = Invoke(micro);
        var audioResult = Invoke(audio);
        return new(microResult, audioResult);
    }
    private static ComponentResult Invoke(Func<ComponentResult> action)
    { try { return action(); } catch (Exception error) { return ComponentResult.Failure(error); } }
}
