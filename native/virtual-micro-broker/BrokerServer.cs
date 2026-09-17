using System.Diagnostics;
using System.Text.Json;
using System.Threading.Channels;

namespace VirtualMicroBroker;

internal sealed class BrokerServer
{
    private readonly IVirtualMicroDriver driver;
    private readonly BoundedUtf8LineReader input;
    private readonly TextWriter output;
    private readonly SemaphoreSlim operations = new(1, 1);
    private readonly CancellationTokenSource stopped = new();
    private readonly Channel<string> outgoing = Channel.CreateBounded<string>(new BoundedChannelOptions(128) {
        SingleReader = true, FullMode = BoundedChannelFullMode.Wait
    });
    private long lastHeartbeat = Stopwatch.GetTimestamp();
    private string? failure;
    private int cleaned;
    private readonly HashSet<string> heldControls = new(StringComparer.Ordinal);

    internal BrokerServer(IVirtualMicroDriver driver, Stream stdin, TextWriter stdout, TextWriter stderr)
    {
        this.driver = driver;
        input = new(stdin);
        output = stdout;
        // stderr is intentionally not awaited: a stopped parent may stop reading
        // either pipe. One bounded protocol writer owns all stdout writes.
        driver.Output += OnOutput;
        driver.Fault += OnFault;
    }

    private void OnOutput(byte[] raw) => Send(new { @event = "report", data = Convert.ToBase64String(raw) });
    private void OnFault(string message)
    {
        if (stopped.IsCancellationRequested) return;
        failure = message.Length > 1024 ? message[..1024] : message;
        Send(new { @event = "fault", message = failure });
        stopped.Cancel();
    }

    internal async Task RunAsync()
    {
        var writer = WriteLoopAsync();
        var watchdog = WatchdogAsync();
        try
        {
            while (!stopped.IsCancellationRequested)
            {
                // WaitAsync also bounds shutdown when an OS stdin read does not
                // implement cancellation. There is only one outstanding read.
                var line = await input.ReadAsync(stopped.Token).WaitAsync(stopped.Token);
                if (line is null) break;
                await DispatchAsync(line);
            }
        }
        catch (OperationCanceledException) when (stopped.IsCancellationRequested) { }
        catch (Exception ex) { OnFault(ex.Message); }
        finally
        {
            stopped.Cancel();
            driver.Output -= OnOutput;
            driver.Fault -= OnFault;
            await CleanupAsync();
            outgoing.Writer.TryComplete();
            await Task.WhenAny(writer, Task.Delay(700));
            await watchdog;
        }
    }

    private async Task DispatchAsync(string line)
    {
        string? id = null;
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new JsonException();
            if (!root.TryGetProperty("id", out var idValue) || idValue.ValueKind != JsonValueKind.String ||
                (id = idValue.GetString()) is null || id.Length is < 1 or > 128 ||
                !root.TryGetProperty("op", out var operation) || operation.ValueKind != JsonValueKind.String)
                throw new JsonException();
            switch (operation.GetString())
            {
                case "connect":
                    if (!Protocol.TryNeutralRelease(root, out var problem)) { Reply(id, false, null, problem); break; }
                    await operations.WaitAsync(stopped.Token);
                    try
                    {
                        Interlocked.Exchange(ref lastHeartbeat, Stopwatch.GetTimestamp());
                        var status = await driver.ConnectAsync(stopped.Token);
                        // Transport absence is a successful diagnostic exchange,
                        // not a successful connection. JS checks connected=false.
                        Reply(id, true, StatusResult(), status.HidEnumerated ? null : "Virtual Micro driver is unavailable.");
                    }
                    finally { operations.Release(); }
                    break;
                case "status": Reply(id, true, StatusResult(), null); break;
                case "heartbeat":
                    Interlocked.Exchange(ref lastHeartbeat, Stopwatch.GetTimestamp());
                    await driver.RefreshInfoAsync(stopped.Token);
                    Reply(id, true, StatusResult(), null);
                    break;
                case "submit": await SubmitAsync(id, root, false); break;
                case "releaseAll": await SubmitAsync(id, root, true); break;
                case "close":
                    await CleanupAsync();
                    Reply(id, true, new { }, null);
                    stopped.Cancel();
                    break;
                default: Reply(id, false, null, "Unsupported broker operation."); break;
            }
        }
        catch (JsonException) { Reply(id, false, null, "id/op must be bounded strings in a JSON object."); }
        catch (Exception ex) when (ex is IOException or InvalidDataException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Reply(id, false, StatusResult(), ex.Message);
            OnFault(ex.Message);
        }
    }

    private async Task SubmitAsync(string id, JsonElement root, bool release)
    {
        byte[][] reports;
        string? key = null;
        var action = 0;
        if (release)
        {
            if (!Protocol.TryNeutralRelease(root, out var error)) { Reply(id, false, null, error); return; }
            reports = [Protocol.NeutralRelease()];
        }
        else if (!Protocol.TryReports(root, "reports", out reports, out var error))
        {
            Reply(id, false, null, error);
            return;
        }
        if (!release && !Protocol.TryValidateSubmitReports(reports, out key, out action, out var validationError))
        {
            Reply(id, false, null, validationError);
            return;
        }
        await operations.WaitAsync(stopped.Token);
        try
        {
            var result = await driver.SubmitAsync(reports, stopped.Token);
            if (result.Disposition == SubmitDisposition.Accepted && key is not null)
            {
                if (action == 1) heldControls.Add(key);
                else if (action == 0) heldControls.Remove(key);
            }
            // Always preserve the structured delivery classification. Acceptance
            // is strictly checked by the controller, never by the JSONL ACK alone.
            Reply(id, true, new {
                disposition = result.Disposition.ToString(), acceptedReportCount = result.AcceptedReportCount,
                nativeStatus = result.NativeStatus, error = result.Error
            }, null);
        }
        finally { operations.Release(); }
    }

    private object StatusResult()
    {
        var status = driver.Status;
        return new {
            driverAvailable = status.DriverAvailable, hidEnumerated = status.HidEnumerated,
            connected = status.DriverAvailable && status.HidEnumerated,
            connectionEpoch = status.ConnectionEpoch, lastBatchSequence = status.LastBatchSequence,
            outputSequence = status.OutputSequence, droppedOutputReports = status.DroppedOutputReports, flags = status.Flags,
            lastError = failure
        };
    }

    private async Task WatchdogAsync()
    {
        try
        {
            while (!stopped.IsCancellationRequested)
            {
                await Task.Delay(200, stopped.Token);
                if (Stopwatch.GetElapsedTime(Interlocked.Read(ref lastHeartbeat)) > TimeSpan.FromSeconds(5))
                    OnFault("Parent heartbeat expired; reconnect and check recording state.");
            }
        }
        catch (OperationCanceledException) { }
    }

    private async Task CleanupAsync()
    {
        if (Interlocked.Exchange(ref cleaned, 1) != 0) return;
        var held = false;
        try
        {
            using var timer = new CancellationTokenSource(700);
            try
            {
                await operations.WaitAsync(timer.Token);
                held = true;
                var releases = new List<byte[]> { Protocol.NeutralRelease() };
                releases.AddRange(heldControls.Where(key => key != "ACT10").Select(key => Protocol.ControlRelease(key)));
                await driver.SubmitAsync(releases, timer.Token);
                heldControls.Clear();
            }
            catch { /* Closing the file is the final neutral-release safety path. */ }
        }
        finally
        {
            if (held) operations.Release();
            try { await driver.ResetAndCloseAsync(TimeSpan.FromMilliseconds(500)); }
            catch { /* No action replay; file cleanup/isolated process exit remains. */ }
        }
    }

    private void Reply(string? id, bool ok, object? result, string? error) => Send(new { id, ok, result, error });
    private void Send(object message)
    {
        if (!outgoing.Writer.TryWrite(JsonSerializer.Serialize(message, Protocol.Json)))
        {
            failure = "Parent output backpressure exceeded the bounded queue.";
            stopped.Cancel();
        }
    }

    private async Task WriteLoopAsync()
    {
        try
        {
            await foreach (var line in outgoing.Reader.ReadAllAsync())
            {
                await output.WriteLineAsync(line).WaitAsync(TimeSpan.FromMilliseconds(500));
                await output.FlushAsync().WaitAsync(TimeSpan.FromMilliseconds(500));
            }
        }
        catch
        {
            failure = "Parent output pipe stalled or closed.";
            stopped.Cancel();
        }
    }
}
