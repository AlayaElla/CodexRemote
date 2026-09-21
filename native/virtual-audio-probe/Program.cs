using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

const string SpeakersName = "CodexRemote Speakers";
const int ProbeTimeoutMs = 3000;

var arguments = args.ToList();
var worker = arguments.Remove("--probe-worker");
var selfTest = arguments.Remove("--self-test");
bool probe;
string? deviceId;
try
{
    probe = arguments.Remove("--probe") || worker;
    deviceId = ReadOption(arguments, "--device-id");
}
catch (ArgumentException error) { Console.Error.WriteLine(error.Message); return 2; }
if (selfTest)
{
#if LOCAL_SELF_TESTS
    return ProbeSelfTests.Run();
#else
    Console.Error.WriteLine("This build does not include local self-tests.");
    return 2;
#endif
}
if (arguments.Count != 0 || (!probe && deviceId is not null))
{
    Console.Error.WriteLine("Usage: CodexRemoteSpeakersProbe [--probe [--device-id <active endpoint id>]]");
    return 2;
}

try
{
    using var enumerator = new MMDeviceEnumerator();
    var endpoints = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active);
    RenderDevice[] devices;
    try { devices = endpoints.Select(device => new RenderDevice(device.ID, device.FriendlyName, device.DeviceFriendlyName)).OrderBy(device => device.Name, StringComparer.OrdinalIgnoreCase).ToArray(); }
    finally { foreach (var device in endpoints) device.Dispose(); }

    if (!probe)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { available = devices.Any(device => device.ProductName == SpeakersName), devices }));
        return 0;
    }

    var speakers = devices.Where(device => device.ProductName == SpeakersName).ToArray();
    if (speakers.Length == 0)
    {
        Console.Error.WriteLine("CodexRemote Speakers unavailable: install and enable the CodexRemote Speakers driver, then run this probe again.");
        return 3;
    }
    if (speakers.Length > 1 && deviceId is null)
    {
        Console.Error.WriteLine("CodexRemote Speakers is not unique. Re-run with --device-id for one of the listed active CodexRemote Speakers endpoints.");
        return 4;
    }

    var selected = deviceId is null ? speakers[0] : speakers.SingleOrDefault(device => device.Id == deviceId);
    if (selected is null)
    {
        Console.Error.WriteLine("The supplied device id is not an active CodexRemote Speakers endpoint.");
        return 4;
    }

    if (!worker) return await RunBoundedProbeAsync(selected.Id);

    using var endpoint = enumerator.GetDevice(selected.Id);
    if (endpoint.State != DeviceState.Active || endpoint.DataFlow != DataFlow.Render || endpoint.DeviceFriendlyName != SpeakersName)
        throw new InvalidOperationException("The selected endpoint changed before the probe began.");

    var result = await SpeakerProbe.RunAsync(endpoint, ProbeTimeoutMs);
    Console.WriteLine(JsonSerializer.Serialize(new { available = true, passed = result.Passed, device = selected, result }));
    return result.Passed ? 0 : 5;
}
catch (Exception error)
{
    Console.Error.WriteLine($"CodexRemote Speakers probe failed: {error.Message}");
    return 5;
}

static string? ReadOption(List<string> arguments, string name)
{
    var index = arguments.IndexOf(name);
    if (index < 0) return null;
    if (index + 1 >= arguments.Count || string.IsNullOrWhiteSpace(arguments[index + 1])) throw new ArgumentException($"{name} requires a value.");
    var value = arguments[index + 1];
    arguments.RemoveAt(index + 1);
    arguments.RemoveAt(index);
    return value;
}

static async Task<int> RunBoundedProbeAsync(string deviceId)
{
    var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Cannot determine the probe executable path.");
    using var worker = new System.Diagnostics.Process {
        StartInfo = new System.Diagnostics.ProcessStartInfo(executable) {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
        }
    };
    var dotnetHost = Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase);
    var entryAssembly = dotnetHost ? Environment.GetCommandLineArgs().Skip(1).FirstOrDefault(argument => argument.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) : null;
    foreach (var argument in ProbeWorkerArguments.Build(dotnetHost, entryAssembly, deviceId)) worker.StartInfo.ArgumentList.Add(argument);
    if (!worker.Start()) throw new InvalidOperationException("Could not start the bounded probe worker.");
    var output = worker.StandardOutput.ReadToEndAsync();
    var errors = worker.StandardError.ReadToEndAsync();
    var exit = worker.WaitForExitAsync();
    var completed = await Task.WhenAny(exit, Task.Delay(ProbeTimeoutMs)).ConfigureAwait(false);
    if (completed != exit)
    {
        var termination = await ProbeWatchdog.RequestTerminationAsync(new ProcessWorker(worker), exit, TimeSpan.FromSeconds(1)).ConfigureAwait(false);
        Console.Error.WriteLine(termination.Terminated
            ? "CodexRemote Speakers probe timed out; its worker was terminated so Windows can release the endpoint resources."
            : $"CodexRemote Speakers probe timed out; termination was {(termination.KillRequested ? "requested" : "not accepted")} but the worker may still be running (PID {termination.ProcessId}).");
        return 6;
    }
    Console.Write(await output.ConfigureAwait(false));
    Console.Error.Write(await errors.ConfigureAwait(false));
    return worker.ExitCode;
}

internal sealed record RenderDevice(string Id, string Name, string ProductName);
internal sealed record ProbeResult(bool Passed, int CapturedFrames, double LeadScore, double TailScore, string Detail);
internal readonly record struct TerminationResult(bool Terminated, bool KillRequested, int ProcessId);

internal interface IProbeWorker
{
    int Id { get; }
    void Kill();
}

internal sealed class ProcessWorker(System.Diagnostics.Process process) : IProbeWorker
{
    public int Id => process.Id;
    public void Kill() => process.Kill(entireProcessTree: true);
}

internal static class ProbeWatchdog
{
    internal static async Task<TerminationResult> RequestTerminationAsync(IProbeWorker worker, Task exit, TimeSpan grace)
    {
        var requested = false;
        try { worker.Kill(); requested = true; } catch { }
        var completed = await Task.WhenAny(exit, Task.Delay(grace)).ConfigureAwait(false);
        return new TerminationResult(completed == exit, requested, worker.Id);
    }
}

internal static class ProbeWorkerArguments
{
    internal static IReadOnlyList<string> Build(bool dotnetHost, string? entryAssembly, string deviceId)
    {
        if (dotnetHost && string.IsNullOrWhiteSpace(entryAssembly)) throw new InvalidOperationException("Cannot determine the probe assembly for the dotnet host.");
        var arguments = new List<string>();
        if (dotnetHost) arguments.Add(entryAssembly!);
        arguments.Add("--probe-worker");
        arguments.Add("--device-id");
        arguments.Add(deviceId);
        return arguments;
    }
}

internal sealed class SpeakerProbe
{
    private const double LeadFrequency = 997;
    private const double TailFrequency = 1733;

    internal static async Task<ProbeResult> RunAsync(MMDevice endpoint, int timeoutMs)
    {
        using var capture = new WasapiLoopbackCapture(endpoint);
        using var player = new WasapiOut(endpoint, AudioClientShareMode.Shared, false, 100);
        var samples = new List<byte>();
        var gate = new object();
        var maximumBytes = Math.Max(capture.WaveFormat.AverageBytesPerSecond * 5, capture.WaveFormat.BlockAlign);
        capture.DataAvailable += (_, eventArgs) =>
        {
            lock (gate)
            {
                var count = Math.Min(eventArgs.BytesRecorded, maximumBytes);
                if (samples.Count + count > maximumBytes) samples.RemoveRange(0, samples.Count + count - maximumBytes);
                samples.AddRange(eventArgs.Buffer.AsSpan(0, count).ToArray());
            }
        };

        try
        {
            var source = new ProbeToneProvider(capture.WaveFormat.SampleRate, capture.WaveFormat.Channels);
            player.Init(new SampleToWaveProvider(source));
            capture.StartRecording();
            player.Play();
            await Task.Delay(Math.Min(timeoutMs, 1200)).ConfigureAwait(false);
        }
        finally
        {
            try { player.Stop(); } catch { }
            try { capture.StopRecording(); } catch { }
        }
        await Task.Delay(150).ConfigureAwait(false);

        byte[] captured;
        lock (gate) captured = samples.ToArray();
        var mono = DecodeToMono(captured, capture.WaveFormat);
        var (lead, tail) = FindSequence(mono, capture.WaveFormat.SampleRate);
        var passed = lead >= 0.08 && tail >= 0.08;
        return new ProbeResult(passed, mono.Length, lead, tail,
            passed ? "The synthetic lead tone and tail marker were found through this endpoint's WASAPI loopback." : "The endpoint opened, but its loopback did not contain the synthetic lead tone and tail marker before timeout.");
    }

    internal static float[] DecodeToMono(byte[] data, WaveFormat format)
    {
        if (format.Channels < 1 || format.BlockAlign < 1 || format.BlockAlign % format.Channels != 0) throw new InvalidOperationException("The endpoint returned an invalid capture format.");
        var frames = data.Length / format.BlockAlign;
        var result = new float[frames];
        var bytesPerSample = format.BlockAlign / format.Channels;
        if (bytesPerSample * 8 != format.BitsPerSample || bytesPerSample is not (2 or 4)) throw new InvalidOperationException($"Unsupported loopback sample width: {bytesPerSample * 8} bits.");
        if (bytesPerSample == 2 && !IsPcm(format)) throw new InvalidOperationException("16-bit loopback capture must use PCM.");
        for (var frame = 0; frame < frames; frame++)
        {
            double sum = 0;
            for (var channel = 0; channel < format.Channels; channel++)
            {
                var offset = frame * format.BlockAlign + channel * bytesPerSample;
                sum += bytesPerSample == 2 ? BitConverter.ToInt16(data, offset) / 32768d
                    : IsIeeeFloat(format) ? BitConverter.ToSingle(data, offset)
                    : IsPcm(format) ? BitConverter.ToInt32(data, offset) / 2147483648d
                    : throw new InvalidOperationException("Unsupported 32-bit loopback subformat.");
            }
            result[frame] = (float)(sum / format.Channels);
        }
        return result;
    }

    private static bool IsIeeeFloat(WaveFormat format) => format.Encoding == WaveFormatEncoding.IeeeFloat
        || format is WaveFormatExtensible extensible && extensible.SubFormat == new Guid("00000003-0000-0010-8000-00aa00389b71");

    private static bool IsPcm(WaveFormat format) => format.Encoding == WaveFormatEncoding.Pcm
        || format is WaveFormatExtensible extensible && extensible.SubFormat == new Guid("00000001-0000-0010-8000-00aa00389b71");

    internal static (double lead, double tail) FindSequence(float[] samples, int sampleRate)
    {
        var window = Math.Max(sampleRate / 10, 1);
        var lead = 0d;
        var tail = 0d;
        for (var start = 0; start + window <= samples.Length; start += window / 2)
        {
            var candidate = ToneScore(samples, start, window, sampleRate, LeadFrequency);
            if (candidate < 0.08) continue;
            lead = Math.Max(lead, candidate);
            var limit = Math.Min(samples.Length - window, start + sampleRate);
            for (var marker = start + window / 2; marker <= limit; marker += window / 2)
                tail = Math.Max(tail, ToneScore(samples, marker, window, sampleRate, TailFrequency));
        }
        return (lead, tail);
    }

    private static double ToneScore(float[] samples, int offset, int length, int sampleRate, double frequency)
    {
        double real = 0, imaginary = 0, energy = 0;
        for (var index = 0; index < length; index++)
        {
            var sample = samples[offset + index];
            var angle = 2 * Math.PI * frequency * index / sampleRate;
            real += sample * Math.Cos(angle);
            imaginary += sample * Math.Sin(angle);
            energy += sample * sample;
        }
        return energy <= 1e-9 ? 0 : (real * real + imaginary * imaginary) / (length * energy);
    }
}

internal sealed class ProbeToneProvider : ISampleProvider
{
    private readonly int sampleRate;
    private readonly int channels;
    private long sampleIndex;
    public WaveFormat WaveFormat { get; }
    internal ProbeToneProvider(int sampleRate, int channels)
    {
        this.sampleRate = sampleRate;
        this.channels = channels;
        WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(sampleRate, channels);
    }
    public int Read(float[] buffer, int offset, int count)
    {
        for (var index = 0; index < count; index++)
        {
            var frame = sampleIndex / channels;
            var milliseconds = frame * 1000d / sampleRate;
            var frequency = milliseconds < 180 ? 997d : milliseconds is >= 300 and < 520 ? 1733d : 0d;
            buffer[offset + index] = frequency == 0 ? 0f : (float)(0.18 * Math.Sin(2 * Math.PI * frequency * frame / sampleRate));
            sampleIndex++;
        }
        return count;
    }
}
