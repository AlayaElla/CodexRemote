using System.Diagnostics;
using System.Text.Json;
using System.Collections.Concurrent;
using Concentus;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

internal static class BridgeProbe
{
    internal static async Task<int> RunAsync(string bridgeDll)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(40));
        var token = timeout.Token;
        var start = new ProcessStartInfo("dotnet") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add(Path.GetFullPath(bridgeDll));
        using var bridge = new Process { StartInfo = start };
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            using var device = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
                .Single(d => d.FriendlyName.EndsWith(" (Stream To Speaker)", StringComparison.Ordinal));
            var replies = new ConcurrentDictionary<string, TaskCompletionSource<JsonElement>>();
            var packets = new List<byte[]>(); var faults = new List<string>();
            bridge.Start();
            var errors = bridge.StandardError.ReadToEndAsync(token);
            var pump = Task.Run(async () =>
            {
                while (await bridge.StandardOutput.ReadLineAsync(token) is { } line)
                {
                    using var document = JsonDocument.Parse(line);
                    var root = document.RootElement;
                    if (root.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String && replies.TryRemove(id.GetString()!, out var reply)) reply.TrySetResult(root.Clone());
                    else if (root.TryGetProperty("event", out var kind))
                    {
                        if (kind.GetString() == "capture_audio") lock (packets) packets.Add(Convert.FromBase64String(root.GetProperty("packet").GetString()!));
                        if (kind.GetString() is "capture_fault" or "fault") lock (faults) faults.Add(line);
                    }
                }
            }, token);
            var sequence = 0;
            async Task Request(string op)
            {
                var id = (++sequence).ToString();
                var reply = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
                replies[id] = reply;
                await bridge.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { id, op, deviceId = device.ID }));
                var result = await reply.Task.WaitAsync(TimeSpan.FromSeconds(12), token);
                if (!result.GetProperty("ok").GetBoolean()) throw new InvalidOperationException(result.ToString());
            }
            var timer = Stopwatch.StartNew();
            await Request("capture_start");
            var startupMs = timer.ElapsedMilliseconds;
            await Task.Delay(400, token); // Startup must succeed before any renderer exists.
            var mix = device.AudioClient.MixFormat;
            using (var output = new WasapiOut(device, AudioClientShareMode.Shared, false, 100))
            {
                var tone = new SignalGenerator(mix.SampleRate, mix.Channels) { Gain = .01, Frequency = 997, Type = SignalGeneratorType.Sin };
                output.Init(tone.Take(TimeSpan.FromSeconds(3)).ToWaveProvider());
                output.Play(); await Task.Delay(3500, token); output.Stop();
            }
            await Request("capture_stop");
            var normalCleanup = Process.GetProcessesByName("stream-to-speaker").Length == 0;
            byte[][] captured; lock (packets) captured = packets.ToArray();
            var decoder = OpusCodecFactory.CreateDecoder(16000, 1);
            var decoded = new List<short>(); var frame = new short[320];
            foreach (var packet in captured)
            {
                var count = decoder.Decode(packet, frame, frame.Length, false);
                if (count != 320) throw new InvalidDataException("Unexpected Opus frame duration.");
                decoded.AddRange(frame);
            }
            double re = 0, im = 0;
            for (var i = 0; i < decoded.Count; i++) { var phase = 2 * Math.PI * 997 * i / 16000; re += decoded[i] / 32768.0 * Math.Cos(phase); im += decoded[i] / 32768.0 * Math.Sin(phase); }
            var magnitude = decoded.Count == 0 ? 0 : 2 * Math.Sqrt(re * re + im * im) / decoded.Count;
            await Request("capture_start"); // Verify immediate reuse after normal stop.
            bridge.Kill(); await bridge.WaitForExitAsync(token); await pump;
            for (var retry = 0; retry < 30 && Process.GetProcessesByName("stream-to-speaker").Length != 0; retry++) await Task.Delay(100, token);
            var crashCleanup = Process.GetProcessesByName("stream-to-speaker").Length == 0;
            var passed = captured.Length > 100 && magnitude > .001 && normalCleanup && crashCleanup && faults.Count == 0;
            Console.WriteLine(JsonSerializer.Serialize(new { passed, startupMs, packets = captured.Length, target997 = magnitude, normalCleanup, crashCleanup, faults }));
            return passed ? 0 : 1;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally { try { if (!bridge.HasExited) { bridge.Kill(); await bridge.WaitForExitAsync(); } } catch (InvalidOperationException) { } }
    }
}
