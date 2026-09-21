using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

// Uses the unmodified upstream service's public HTTP output. No driver IOCTLs,
// microphone access, global volume changes, or third-party binaries in this project.
if (args.Length == 2 && args[0] == "--bridge-probe") return await BridgeProbe.RunAsync(args[1]);
if (args.Length != 1 || args[0] != "--self-probe") {
    Console.WriteLine("Usage: StreamToSpeakerProbe --self-probe");
    return 2;
}
using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(25));
var token = deadline.Token;
Process? service = null;
try {
    var executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Stream To Speaker", "stream-to-speaker.exe");
    if (!File.Exists(executable)) throw new InvalidOperationException("Install the official Stream To Speaker application first.");
    if (Process.GetProcessesByName("stream-to-speaker").Length != 0)
        throw new InvalidOperationException("Stream To Speaker is already running; this standalone probe requires an idle service.");
    using var enumerator = new MMDeviceEnumerator();
    var matches = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
        .Where(d => d.FriendlyName.Contains("Stream To Speaker", StringComparison.OrdinalIgnoreCase)).ToArray();
    if (matches.Length != 1) throw new InvalidOperationException($"Expected one Stream To Speaker render endpoint, found {matches.Length}.");
    using var device = matches[0];
    Console.WriteLine($"Endpoint: {device.ID} / {device.FriendlyName}");
    // Reserve a free localhost port, then let the original service bind it.
    var reservation = new TcpListener(IPAddress.Loopback, 0);
    reservation.Start();
    var port = ((IPEndPoint)reservation.LocalEndpoint).Port;
    reservation.Stop();
    var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var argument in new[] { "--headless", "--no-discovery", "--no-interactive", "--bind", "127.0.0.1", "--port", port.ToString(), "--source", "driver", "--no-silence-injection", "--log-level", "info" }) start.ArgumentList.Add(argument);
    service = Process.Start(start) ?? throw new InvalidOperationException("Cannot start original service.");
    service.OutputDataReceived += (_, e) => { if (e.Data is not null) Console.WriteLine("service: " + e.Data); };
    service.ErrorDataReceived += (_, e) => { if (e.Data is not null) Console.WriteLine("service: " + e.Data); };
    service.BeginOutputReadLine(); service.BeginErrorReadLine();
    // The service can wait for the first driver packet before flushing HTTP
    // headers. Start playback before awaiting that response.
    var mix = device.AudioClient.MixFormat;
    using var output = new WasapiOut(device, AudioClientShareMode.Shared, false, 100);
    var signal = new SignalGenerator(mix.SampleRate, mix.Channels) { Gain = .01, Frequency = 997, Type = SignalGeneratorType.Sin };
    output.Init(signal.Take(TimeSpan.FromSeconds(6)).ToWaveProvider());
    Exception? playbackError = null;
    output.PlaybackStopped += (_, e) => playbackError = e.Exception;
    output.Play();
    using var http = new HttpClient(new SocketsHttpHandler { UseProxy = false, AllowAutoRedirect = false }) { Timeout = Timeout.InfiniteTimeSpan };
    HttpResponseMessage? response = null;
    for (var retry = 0; retry < 40; retry++) {
        token.ThrowIfCancellationRequested();
        if (service.HasExited) throw new InvalidOperationException($"Original service exited: {service.ExitCode}");
        try { response = await http.GetAsync($"http://127.0.0.1:{port}/stream.raw", HttpCompletionOption.ResponseHeadersRead, token); break; }
        catch (HttpRequestException) { await Task.Delay(100, token); }
    }
    using var ownedResponse = response ?? throw new InvalidOperationException("Original service did not start its HTTP stream.");
    ownedResponse.EnsureSuccessStatusCode();
    await using var stream = await ownedResponse.Content.ReadAsStreamAsync(token);
    var header = new byte[44];
    await stream.ReadExactlyAsync(header, token);
    var wave = Encoding.ASCII.GetString(header, 0, 4) == "RIFF" && Encoding.ASCII.GetString(header, 8, 8) == "WAVEfmt " && Encoding.ASCII.GetString(header, 36, 4) == "data";
    var format = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(20));
    var channels = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(22));
    var rate = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(24));
    var bits = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(34));
    if (!wave || format != 1 || channels != 2 || rate != 44100 || bits != 16) throw new InvalidOperationException("Unexpected upstream HTTP audio format.");
    var data = new byte[rate * channels * 2 * 4];
    var reading = stream.ReadExactlyAsync(data, token).AsTask();
    await reading;
    output.Stop();
    if (playbackError is not null) throw playbackError;
    double re = 0, im = 0, energy = 0;
    var frames = data.Length / 4;
    for (var i = 0; i < frames; i++) {
        var value = (BinaryPrimitives.ReadInt16LittleEndian(data.AsSpan(i * 4)) + BinaryPrimitives.ReadInt16LittleEndian(data.AsSpan(i * 4 + 2))) / 65536.0;
        var phase = 2 * Math.PI * 997 * i / rate;
        re += value * Math.Cos(phase); im += value * Math.Sin(phase); energy += value * value;
    }
    var magnitude = 2 * Math.Sqrt(re * re + im * im) / frames;
    var passed = magnitude > .001;
    Console.WriteLine(JsonSerializer.Serialize(new { source = "official-service-http", deviceId = device.ID, frames, rate, target997 = magnitude, rms = Math.Sqrt(energy / frames), passed }));
    return passed ? 0 : 1;
} catch (Exception error) {
    Console.Error.WriteLine(error.Message);
    return 1;
} finally {
    if (service is not null) {
        try { if (!service.HasExited) service.Kill(entireProcessTree: true); await service.WaitForExitAsync(); }
        finally { service.Dispose(); }
    }
}
