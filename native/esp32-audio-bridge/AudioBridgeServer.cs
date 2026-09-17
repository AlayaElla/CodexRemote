using System.Text.Json;
using System.Threading.Channels;

namespace Esp32AudioBridge;

internal sealed class AudioBridgeServer
{
    private readonly BoundedUtf8LineReader input;
    private readonly TextWriter output;
    private readonly Channel<string> incoming = Channel.CreateBounded<string>(new BoundedChannelOptions(8) { SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly Channel<string> outgoing = Channel.CreateBounded<string>(new BoundedChannelOptions(64) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly CancellationTokenSource eof = new();
    private readonly CancellationTokenSource stopping = new();
    private readonly object sessionGate = new();
    private AudioSession? session;
    private bool draining;
    private int inputCompleted;
    private int stopAwaiting;
    private int cleaned;
    private int faultCleanupScheduled;

    internal AudioBridgeServer(Stream stdin, TextWriter stdout)
    {
        input = new BoundedUtf8LineReader(stdin);
        output = stdout;
    }

    internal async Task RunAsync()
    {
        var writer = WriteLoopAsync();
        var reader = ReadLoopAsync();
        try
        {
            await foreach (var line in incoming.Reader.ReadAllAsync(stopping.Token).ConfigureAwait(false))
            {
                await DispatchAsync(line).ConfigureAwait(false);
                if (stopping.IsCancellationRequested) break;
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        finally
        {
            CleanupImmediately();
            outgoing.Writer.TryComplete();
            await Task.WhenAny(writer, Task.Delay(500)).ConfigureAwait(false);
            await Task.WhenAny(reader, Task.Delay(500)).ConfigureAwait(false);
        }
    }

    private async Task ReadLoopAsync()
    {
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                var line = await input.ReadAsync(stopping.Token).ConfigureAwait(false);
                if (line is null) break;
                await incoming.Writer.WriteAsync(line, stopping.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception exception) { Fault(SafeError(exception)); }
        finally
        {
            Interlocked.Exchange(ref inputCompleted, 1);
            if (Volatile.Read(ref stopAwaiting) != 0 || HasActiveSession()) eof.Cancel();
            incoming.Writer.TryComplete();
        }
    }

    private async Task DispatchAsync(string line)
    {
        string? id = null;
        try
        {
            using var document = JsonDocument.Parse(line);
            if (!Protocol.TryIdAndOperation(document.RootElement, out id, out var operation))
            {
                Reply(id, false, null, "id and op must be bounded strings in a JSON object.");
                return;
            }
            switch (operation)
            {
                case "list": Reply(id, true, null, null, devices: CableDeviceCatalog.List()); break;
                case "start": Start(id!, document.RootElement); break;
                case "append": Append(id!, document.RootElement); break;
                case "stop": await StopAsync(id!).ConfigureAwait(false); break;
                case "cancel": Cancel(id!); break;
                case "discard": await DiscardAsync(id!).ConfigureAwait(false); break;
                default: Reply(id, false, null, "Unsupported audio bridge operation."); break;
            }
        }
        catch (JsonException) { Reply(id, false, null, "JSONL command is invalid JSON."); }
        catch (Exception exception) { Reply(id, false, null, SafeError(exception)); }
    }

    private void Start(string id, JsonElement root)
    {
        lock (sessionGate)
        {
            if (session is not null || draining) { Reply(id, false, null, "An audio session is already active."); return; }
        }
        if (!Protocol.TryGetOptionalString(root, "deviceId", out var requestedId, out var inputError)) { Reply(id, false, null, inputError); return; }
        var devices = CableDeviceCatalog.List();
        CableOutputDevice selected;
        if (string.IsNullOrWhiteSpace(requestedId))
        {
            if (devices.Count != 1) { Reply(id, false, null, devices.Count == 0 ? "No active paired VB-CABLE endpoints were found." : "Multiple paired VB-CABLE endpoints found; deviceId is required."); return; }
            selected = devices[0];
        }
        else selected = devices.FirstOrDefault(device => string.Equals(device.Id, requestedId, StringComparison.Ordinal))
            ?? throw new InvalidOperationException("Requested deviceId is not an active paired VB-CABLE endpoint.");

        AudioSession? active = null;
        try
        {
            active = AudioSession.Create(CableDeviceCatalog.OpenExact(selected.Id));
            active.Start();
            active.Faulted += OnSessionFaulted;
            lock (sessionGate)
            {
                if (session is not null || draining) throw new InvalidOperationException("An audio session became active while starting this endpoint.");
                session = active;
            }
            Reply(id, true, new { deviceId = selected.Id, name = selected.Name, captureName = selected.CaptureName, sampleRate = AudioSession.SampleRate, channels = AudioSession.Channels, maxBufferedMs = AudioSession.MaxBufferedMs }, null);
        }
        catch
        {
            active?.Cancel();
            throw;
        }
    }

    private void Append(string id, JsonElement root)
    {
        AudioSession? active;
        lock (sessionGate) active = !draining ? session : null;
        if (active is null) { Reply(id, false, null, "Start an audio session before appending packets."); return; }
        if (!Protocol.TryGetOptionalString(root, "packet", out var encoded, out var inputError) || string.IsNullOrEmpty(encoded)) { Reply(id, false, null, inputError ?? "packet must be a base64 string."); return; }
        byte[] packet;
        try { packet = Convert.FromBase64String(encoded); }
        catch (FormatException) { Reply(id, false, null, "packet must be valid base64."); return; }
        if (packet.Length > AudioSession.MaxPacketBytes) { Reply(id, false, null, "Opus packet exceeds 4096 bytes."); return; }
        try
        {
            var result = active.Append(packet);
            Reply(id, true, new { packets = result.Packets, samples = result.Samples, peak = result.Peak, bufferedMs = result.BufferedMs }, null);
        }
        catch (AudioBufferOverflowException exception)
        {
            RemoveSession(active);
            active.Cancel();
            Reply(id, false, null, SafeError(exception));
        }
        catch (InvalidDataException exception) { Reply(id, false, null, SafeError(exception)); }
        catch (InvalidOperationException) { Reply(id, false, null, "Audio session ended before the packet could be played."); }
    }

    private async Task StopAsync(string id)
    {
        AudioSession? active;
        lock (sessionGate)
        {
            active = session;
            if (active is null || draining) { Reply(id, false, null, active is null ? "No active audio session." : "Audio session is already draining."); return; }
            draining = true;
        }
        Interlocked.Exchange(ref stopAwaiting, 1);
        if (Volatile.Read(ref inputCompleted) != 0) eof.Cancel();
        var initialBufferedMs = active.BufferedMilliseconds;
        var drained = false;
        try
        {
            drained = await active.StopAfterDrainAsync(eof.Token).ConfigureAwait(false);
            if (!OwnsSession(active))
            {
                Reply(id, false, null, "Audio output fault cancelled the session before drain completed.");
                return;
            }
            if (!drained) { Reply(id, false, null, "Timed out while draining the PCM buffer; the session was cancelled."); return; }
            Reply(id, true, new { drained = true, initialBufferedMs }, null);
        }
        catch (OperationCanceledException) when (eof.IsCancellationRequested)
        {
            // Parent stdin closed: cleanup is immediate and there is no live parent to receive a reply.
        }
        catch (Exception exception) { Reply(id, false, null, SafeError(exception)); }
        finally
        {
            RemoveSession(active);
            Interlocked.Exchange(ref stopAwaiting, 0);
            if (!drained) active.Cancel();
        }
    }

    private void Cancel(string id)
    {
        AudioSession? active;
        lock (sessionGate)
        {
            active = session;
            session = null;
            draining = false;
        }
        if (active is null) { Reply(id, false, null, "No active audio session."); return; }
        active.Cancel();
        Reply(id, true, new { cancelled = true }, null);
    }

    private async Task DiscardAsync(string id)
    {
        AudioSession? active;
        lock (sessionGate)
        {
            active = session;
            if (active is null || draining) { Reply(id, false, null, "No reusable audio session."); return; }
            draining = true;
        }
        try
        {
            await active.DiscardAsync(eof.Token).ConfigureAwait(false);
            if (!OwnsSession(active)) throw new InvalidOperationException("Audio output was lost while discarding.");
            Reply(id, true, new { discarded = true, ready = true, active = false, packets = 0, samples = 0, peak = 0, bufferedMs = 0 }, null);
        }
        catch
        {
            RemoveSession(active);
            active.Cancel();
            throw;
        }
        finally { lock (sessionGate) draining = false; }
    }

    private void OnSessionFaulted()
    {
        if (Interlocked.Exchange(ref faultCleanupScheduled, 1) != 0) return;
        _ = Task.Run(() =>
        {
            AudioSession? failed;
            lock (sessionGate)
            {
                failed = session;
                session = null;
                draining = false;
            }
            try { failed?.Cancel(); }
            catch { }
            if (failed is not null) Fault("WASAPI playback stopped unexpectedly; the audio session was cancelled.");
            Interlocked.Exchange(ref faultCleanupScheduled, 0);
        });
    }

    private bool HasActiveSession() { lock (sessionGate) return session is not null; }
    private bool OwnsSession(AudioSession candidate) { lock (sessionGate) return ReferenceEquals(session, candidate); }
    private void RemoveSession(AudioSession candidate)
    {
        lock (sessionGate)
        {
            if (ReferenceEquals(session, candidate)) session = null;
            draining = false;
        }
    }

    private void CleanupImmediately()
    {
        if (Interlocked.Exchange(ref cleaned, 1) != 0) return;
        AudioSession? active;
        lock (sessionGate)
        {
            active = session;
            session = null;
            draining = false;
        }
        try { active?.Cancel(); }
        catch { }
        eof.Cancel();
        stopping.Cancel();
    }

    private void Reply(string? id, bool ok, object? result, string? error, IReadOnlyList<CableOutputDevice>? devices = null)
    {
        if (devices is not null) Send(JsonSerializer.Serialize(new { id, ok, devices }, Protocol.Json));
        else Send(JsonSerializer.Serialize(new { id, ok, result, error }, Protocol.Json));
    }
    private void Fault(string error) => Send(JsonSerializer.Serialize(new { @event = "fault", error }, Protocol.Json));
    private void Send(string message) { if (!outgoing.Writer.TryWrite(message)) stopping.Cancel(); }
    private async Task WriteLoopAsync()
    {
        try
        {
            await foreach (var line in outgoing.Reader.ReadAllAsync().ConfigureAwait(false))
            {
                await output.WriteLineAsync(line).WaitAsync(TimeSpan.FromMilliseconds(500)).ConfigureAwait(false);
                await output.FlushAsync().WaitAsync(TimeSpan.FromMilliseconds(500)).ConfigureAwait(false);
            }
        }
        catch { stopping.Cancel(); }
    }
    private static string SafeError(Exception exception)
    {
        var text = exception.Message;
        return string.IsNullOrWhiteSpace(text) ? "Audio bridge request failed." : text.Length <= 512 ? text : text[..512];
    }
}
