using Microsoft.Win32.SafeHandles;

namespace VirtualMicroBroker;

internal enum SubmitDisposition { Accepted, NotSent, OutcomeUnknown, Rejected }
internal sealed record DriverInfo(bool DriverAvailable, bool HidEnumerated, ulong ConnectionEpoch,
    ulong LastBatchSequence, ulong OutputSequence, uint DroppedOutputReports, uint Flags);
internal sealed record DriverSubmitResult(SubmitDisposition Disposition, int AcceptedReportCount,
    int NativeStatus, string? Error = null);
internal interface IVirtualMicroDriver : IDisposable
{
    event Action<byte[]>? Output;
    event Action<string>? Fault;
    DriverInfo Status { get; }
    Task<DriverInfo> ConnectAsync(CancellationToken ct);
    Task<DriverInfo> RefreshInfoAsync(CancellationToken ct);
    Task<DriverSubmitResult> SubmitAsync(IReadOnlyList<byte[]> reports, CancellationToken ct);
    Task ResetAndCloseAsync(TimeSpan timeout);
}

internal static class Abi
{
    internal const uint Magic = 0x314D4356, Version = 1, Ready = 1, TransportReset = 4;
    internal const uint GetInfo = 0x22E000, SubmitInput = 0x22E004, ReadOutput = 0x22E008, ResetTransport = 0x22E010;
    internal const int InfoSize = 40, BatchHeaderSize = 16, SubmitResultSize = 32, OutputRecordSize = 96;
    internal static uint U32(byte[] data, int offset) => BitConverter.ToUInt32(data, offset);
    internal static ushort U16(byte[] data, int offset) => BitConverter.ToUInt16(data, offset);
    internal static ulong U64(byte[] data, int offset) => BitConverter.ToUInt64(data, offset);
    internal static int I32(byte[] data, int offset) => BitConverter.ToInt32(data, offset);

    internal static bool Header(byte[] bytes, int size, out string error)
    {
        error = "Invalid driver ABI length, magic or version.";
        if (bytes.Length != size || U32(bytes, 0) != Magic || U16(bytes, 4) != Version || U16(bytes, 6) != size) return false;
        error = "";
        return true;
    }

    internal static byte[] BuildBatch(IReadOnlyList<byte[]> reports, ulong sequence)
    {
        var bytes = new byte[BatchHeaderSize + reports.Count * Protocol.RawReportLength];
        BitConverter.GetBytes(Magic).CopyTo(bytes, 0);
        BitConverter.GetBytes((ushort)Version).CopyTo(bytes, 4);
        BitConverter.GetBytes((ushort)reports.Count).CopyTo(bytes, 6);
        BitConverter.GetBytes(sequence).CopyTo(bytes, 8);
        for (var index = 0; index < reports.Count; index++) reports[index].CopyTo(bytes, BatchHeaderSize + index * 64);
        return bytes;
    }

    internal static DriverSubmitResult ParseSubmit(byte[] bytes, ulong sequence, int requested)
    {
        if (!Header(bytes, SubmitResultSize, out var error) || U64(bytes, 8) != sequence)
            return new(SubmitDisposition.OutcomeUnknown, 0, 0, error.Length > 0 ? error : "Submit sequence mismatch.");
        var disposition = U32(bytes, 16);
        var accepted = U32(bytes, 20);
        var native = I32(bytes, 24);
        if (accepted > requested || U32(bytes, 28) != 0 || disposition > 4)
            return new(SubmitDisposition.OutcomeUnknown, 0, native, "Inconsistent driver acknowledgement.");
        if (disposition == 1 && accepted == requested && native >= 0)
            return new(SubmitDisposition.Accepted, (int)accepted, native);
        if (disposition == 0 && accepted == 0) return new(SubmitDisposition.NotSent, 0, native, "Driver did not send the batch.");
        if (disposition == 4 && accepted == 0) return new(SubmitDisposition.Rejected, 0, native, "Driver rejected the batch.");
        return new(SubmitDisposition.OutcomeUnknown, (int)accepted, native, "Partial, duplicate or inconsistent outcome; never replayed.");
    }

    internal static bool TryOutput(byte[] bytes, ulong previous, out byte[] raw, out string error)
    {
        raw = [];
        if (!Header(bytes, OutputRecordSize, out error)) return false;
        var length = U32(bytes, 24);
        var flags = U32(bytes, 28);
        if (U64(bytes, 8) != previous + 1 || (flags != 1 && flags != 2) ||
            (flags == 1 && length != 64) || (flags == 2 && (length < 2 || length > 63)))
        {
            error = "Invalid output sequence, original length or flags.";
            return false;
        }
        // The ABI always contains NORMALIZED raw64, including for flag 2.
        raw = bytes.AsSpan(32, 64).ToArray();
        if (!Protocol.IsRawReport(raw) || (flags == 2 && raw[2] > length - 2))
        {
            error = "Invalid normalized output payload.";
            return false;
        }
        return true;
    }

    internal static DriverInfo ParseInfo(byte[] bytes)
    {
        if (!Header(bytes, InfoSize, out var error)) throw new InvalidDataException(error);
        var flags = U32(bytes, 36);
        if ((flags & ~(Ready | TransportReset)) != 0 || (flags & Ready) == 0)
            throw new InvalidDataException("Driver transport is not ready or flags are unsupported.");
        return new(true, false, U64(bytes, 8), U64(bytes, 16), U64(bytes, 24), U32(bytes, 32), flags);
    }
}

internal sealed class WindowsVirtualMicroDriver : IVirtualMicroDriver
{
    private static readonly Guid InterfaceGuid = new("E2A7CB54-8420-4D51-9DD8-D6575B9251D1");
    private static readonly DriverInfo Disconnected = new(false, false, 0, 0, 0, 0, 0);
    private readonly object lifecycle = new();
    private SafeFileHandle? handle;
    private CancellationTokenSource? readStop;
    private Task? reader;
    private ulong nextSequence = 1;
    private DriverInfo status = Disconnected;
    public DriverInfo Status => Volatile.Read(ref status);
    public event Action<byte[]>? Output;
    public event Action<string>? Fault;

    public async Task<DriverInfo> ConnectAsync(CancellationToken ct)
    {
        await ResetAndCloseAsync(TimeSpan.FromMilliseconds(500));
        var endpoints = SetupApi.FindTargetMicroEndpoints();
        var path = endpoints.ControlPath;
        status = Disconnected with { DriverAvailable = true, HidEnumerated = !string.IsNullOrEmpty(endpoints.HidPath) };
        var candidate = Native.CreateFileW(path, Native.GenericRead | Native.GenericWrite, 0,
            IntPtr.Zero, Native.OpenExisting, Native.FileFlagOverlapped, IntPtr.Zero);
        try
        {
            if (candidate.IsInvalid) throw new IOException("Cannot open driver control interface (access denied or another broker owns it).");
            var info = await PrepareConnectionAsync(
                (code, size, token) => NativeIo.RunAsync(candidate, code, [], size, token), ct);
            // VhfStart alone does not prove that this control devnode's own HID
            // child enumerated. The selector rejects cross-device combinations.
            info = info with { HidEnumerated = !string.IsNullOrEmpty(endpoints.HidPath) };
            var source = new CancellationTokenSource();
            lock (lifecycle)
            {
                handle = candidate;
                status = info;
                nextSequence = checked(info.LastBatchSequence + 1);
                readStop = source;
                reader = Task.Run(() => ReadLoopAsync(candidate, info.ConnectionEpoch, source.Token));
            }
            return Status;
        }
        catch
        {
            candidate.Dispose(); // Driver file cleanup performs a best-effort neutral release.
            throw;
        }
    }

    internal static async Task<DriverInfo> PrepareConnectionAsync(
        Func<uint, int, CancellationToken, Task<IoReply>> request, CancellationToken ct)
    {
        var info = Abi.ParseInfo((await request(Abi.GetInfo, Abi.InfoSize, ct)).RequireBytes());
        if (info.DroppedOutputReports == 0) return info;
        if ((info.Flags & Abi.TransportReset) == 0)
            throw new IOException("Driver output overflowed and this driver cannot reset its transport.");

        // No reader or PTT session exists yet. Discard the incomplete old FIFO
        // once, then wait for fresh host requests; never replay old button input.
        (await request(Abi.ResetTransport, 0, ct)).RequireBytes();
        var fresh = Abi.ParseInfo((await request(Abi.GetInfo, Abi.InfoSize, ct)).RequireBytes());
        if (fresh.ConnectionEpoch == info.ConnectionEpoch || fresh.DroppedOutputReports != 0 || fresh.LastBatchSequence != 0)
            throw new IOException("Driver output overflow recovery failed; reconnect the Micro host and retry.");
        // OutputSequence may already be nonzero because the host can write as
        // soon as reset completes. The new epoch's reader still starts at 1.
        return fresh;
    }

    public async Task<DriverInfo> RefreshInfoAsync(CancellationToken ct)
    {
        SafeFileHandle? current;
        lock (lifecycle) current = handle;
        if (current is null) return Status;
        try
        {
            var fresh = Abi.ParseInfo((await NativeIo.RunAsync(current, Abi.GetInfo, [], Abi.InfoSize, ct)).RequireBytes());
            var previous = Status;
            if (fresh.ConnectionEpoch != previous.ConnectionEpoch || fresh.DroppedOutputReports != previous.DroppedOutputReports)
                throw new IOException("Driver reset or output loss detected; reconnect required.");
            lock (lifecycle)
            {
                if (handle == current) status = fresh with { HidEnumerated = previous.HidEnumerated };
            }
            return Status;
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException)
        {
            MarkFault(current, ex.Message);
            throw;
        }
    }

    public async Task<DriverSubmitResult> SubmitAsync(IReadOnlyList<byte[]> reports, CancellationToken ct)
    {
        if (reports.Count is < 1 or > 64 || reports.Any(report => !Protocol.IsRawReport(report)))
            return new(SubmitDisposition.Rejected, 0, 0, "Invalid raw64 batch.");
        SafeFileHandle? current;
        ulong sequence;
        lock (lifecycle) { current = handle; sequence = nextSequence++; }
        if (current is null || current.IsClosed || sequence == 0)
            return new(SubmitDisposition.NotSent, 0, 0, "Driver endpoint is not open.");
        var reply = await NativeIo.RunAsync(current, Abi.SubmitInput, Abi.BuildBatch(reports, sequence), Abi.SubmitResultSize, ct);
        return reply.Success ? Abi.ParseSubmit(reply.Bytes, sequence, reports.Count)
            : new(reply.Issued ? SubmitDisposition.OutcomeUnknown : SubmitDisposition.NotSent, 0, reply.NativeError, reply.Error);
    }

    private async Task ReadLoopAsync(SafeFileHandle current, ulong epoch, CancellationToken ct)
    {
        // A new epoch's FIFO begins at 1 even if reports arrived before GET_INFO.
        ulong last = 0;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var reply = await NativeIo.RunAsync(current, Abi.ReadOutput, [], Abi.OutputRecordSize, ct);
                if (!reply.Success && reply.NativeError == 259) { await Task.Delay(25, ct); continue; }
                if (ct.IsCancellationRequested) return;
                if (!reply.Success) throw new IOException(reply.Error);
                if (!Abi.TryOutput(reply.Bytes, last, out var raw, out var error)) throw new IOException(error);
                last++;
                lock (lifecycle) { if (handle != current || status.ConnectionEpoch != epoch) return; }
                Output?.Invoke(raw);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception ex) { if (!ct.IsCancellationRequested) MarkFault(current, ex.Message); }
    }

    private void MarkFault(SafeFileHandle current, string error)
    {
        lock (lifecycle)
        {
            if (handle != current) return;
            status = Disconnected;
            readStop?.Cancel();
        }
        Fault?.Invoke(error);
    }

    public async Task ResetAndCloseAsync(TimeSpan timeout)
    {
        SafeFileHandle? current;
        CancellationTokenSource? source;
        Task? read;
        lock (lifecycle)
        {
            current = handle; source = readStop; read = reader;
            handle = null; readStop = null; reader = null; status = Disconnected;
        }
        if (current is null) return;
        source?.Cancel();
        try
        {
            if (read is not null) await read.WaitAsync(timeout + TimeSpan.FromSeconds(1));
            using var timer = new CancellationTokenSource(timeout);
            await NativeIo.RunAsync(current, Abi.ResetTransport, [], 0, timer.Token);
        }
        finally { current.Dispose(); source?.Dispose(); }
    }

    public void Dispose() => ResetAndCloseAsync(TimeSpan.FromMilliseconds(500)).GetAwaiter().GetResult();
}
