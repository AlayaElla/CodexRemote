using Concentus;
using Concentus.Enums;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Esp32AudioBridge;

internal static class CableProbe
{
    private const int TailMarkerHz = 1000;
    internal static async Task<object> RunAsync()
    {
        var devices = CableDeviceCatalog.List();
        if (devices.Count != 1) throw new InvalidOperationException(devices.Count == 0 ? "No active paired VB-CABLE endpoints were found." : "Multiple paired VB-CABLE endpoints found; choose an endpoint through JSONL start first.");
        var device = devices[0];
        using var captureDevice = CableDeviceCatalog.OpenPairedCapture(device);
        using var capture = new WasapiCapture(captureDevice);
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var metrics = new Metrics();
        capture.DataAvailable += (_, args) =>
        {
            metrics.Add(args.Buffer, args.BytesRecorded, capture.WaveFormat);
        };
        capture.RecordingStopped += (_, _) => completion.TrySetResult();

        var packet = CreateTonePacket();
        var session = AudioSession.Create(CableDeviceCatalog.OpenExact(device.Id));
        try
        {
            capture.StartRecording();
            session.Start();
            var decoded = session.Append(packet);
            if (decoded.Samples != 960 || decoded.Peak <= 0) throw new InvalidOperationException("Probe Opus packet did not decode to non-zero 60 ms PCM.");
            if (!await session.StopAfterDrainAsync(CancellationToken.None).ConfigureAwait(false)) throw new InvalidOperationException("Probe PCM buffer did not drain.");
            await Task.Delay(250).ConfigureAwait(false);
        }
        finally
        {
            capture.StopRecording();
            await Task.WhenAny(completion.Task, Task.Delay(1000)).ConfigureAwait(false);
            session.Cancel();
        }
        var summary = metrics.Summary();
        var tailMarker = summary.TailScore > 0.01;
        if (!tailMarker) throw new InvalidOperationException("Probe capture received audio but did not observe the final 1 kHz tail marker.");
        return new { frames = summary.Frames, peak = summary.Peak, rms = summary.Rms };
    }

    private static byte[] CreateTonePacket()
    {
        var pcm = new short[960];
        for (var index = 0; index < pcm.Length; index++) pcm[index] = (short)(Math.Sin(index * 2.0 * Math.PI * TailMarkerHz / AudioSession.SampleRate) * 12000);
        var encoder = OpusCodecFactory.CreateEncoder(AudioSession.SampleRate, AudioSession.Channels, OpusApplication.OPUS_APPLICATION_AUDIO, null);
        var encoded = new byte[AudioSession.MaxPacketBytes];
        var length = encoder.Encode(pcm, pcm.Length, encoded, encoded.Length);
        if (length <= 0) throw new InvalidOperationException("Concentus could not encode the probe frame.");
        return encoded[..length];
    }

    private sealed class Metrics
    {
        private readonly object gate = new();
        private long samples;
        private double sumSquares;
        private double peak;
        private double markerCos;
        private double markerSin;
        private int channels = 1;
        private int sampleRate = AudioSession.SampleRate;

        internal void Add(byte[] bytes, int count, WaveFormat format)
        {
            lock (gate)
            {
                channels = Math.Max(1, format.Channels);
                sampleRate = Math.Max(1, format.SampleRate);
                foreach (var value in DecodeSamples(bytes, count, format))
                {
                    var frame = samples / channels;
                    var angle = 2.0 * Math.PI * TailMarkerHz * frame / sampleRate;
                    peak = Math.Max(peak, Math.Abs(value));
                    sumSquares += value * value;
                    markerCos += value * Math.Cos(angle);
                    markerSin += value * Math.Sin(angle);
                    samples++;
                }
            }
        }

        internal (long Frames, double Peak, double Rms, double TailScore) Summary()
        {
            lock (gate)
            {
                var frames = samples / channels;
                var tailScore = samples == 0 ? 0 : 2 * Math.Sqrt(markerCos * markerCos + markerSin * markerSin) / samples;
                return (frames, peak, samples == 0 ? 0 : Math.Sqrt(sumSquares / samples), tailScore);
            }
        }

        private static IEnumerable<double> DecodeSamples(byte[] bytes, int count, WaveFormat format)
        {
            if (format.Encoding == WaveFormatEncoding.IeeeFloat && format.BitsPerSample == 32)
            {
                for (var offset = 0; offset + 4 <= count; offset += 4) yield return BitConverter.ToSingle(bytes, offset);
            }
            else if (format.BitsPerSample == 16)
            {
                for (var offset = 0; offset + 2 <= count; offset += 2) yield return (double)BitConverter.ToInt16(bytes, offset) / short.MaxValue;
            }
            else if (format.BitsPerSample == 32)
            {
                for (var offset = 0; offset + 4 <= count; offset += 4) yield return (double)BitConverter.ToInt32(bytes, offset) / int.MaxValue;
            }
        }
    }
}
