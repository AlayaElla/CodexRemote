using Concentus;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Esp32AudioBridge;

internal sealed record AppendResult(long Packets, int Samples, double Peak, int BufferedMs);

internal sealed class AudioSession : IDisposable
{
    internal const int SampleRate = 16000;
    internal const int Channels = 1;
    internal const int MaxPacketBytes = 4096;
    internal const int MaxFrameSamples = 5760;
    internal const int MaxBufferedMs = 2000;
    // WASAPI is configured for 100 ms and the stock VB-CABLE endpoint reports about 149 ms internal latency.
    // Keep 350 ms after source drain so the final frame reaches CABLE Output before the caller releases PTT.
    internal const int OutputTailGuardMs = 350;

    private readonly BufferedWaveProvider buffer;
    private readonly IOpusDecoder decoder = OpusCodecFactory.CreateDecoder(SampleRate, Channels, null);
    private readonly IAudioOutput output;
    private bool disposed;
    private long packets;
    internal event Action? Faulted;

    private AudioSession(BufferedWaveProvider source, IAudioOutput audioOutput)
    {
        buffer = source;
        output = audioOutput;
        output.Faulted += OnOutputFaulted;
    }

    internal static AudioSession Create(MMDevice device)
    {
        var source = new BufferedWaveProvider(new WaveFormat(SampleRate, 16, Channels)) {
            BufferLength = SampleRate * Channels * 2 * MaxBufferedMs / 1000,
            DiscardOnBufferOverflow = false,
            ReadFully = true
        };
        var output = new WasapiCableOutput(device, source);
        return new AudioSession(source, output);
    }

    internal static AudioSession CreateForTest(Func<BufferedWaveProvider, IAudioOutput> outputFactory)
    {
        var source = new BufferedWaveProvider(new WaveFormat(SampleRate, 16, Channels)) {
            BufferLength = SampleRate * Channels * 2 * MaxBufferedMs / 1000,
            DiscardOnBufferOverflow = false,
            ReadFully = true
        };
        return new AudioSession(source, outputFactory(source));
    }

    internal void Start()
    {
        ThrowIfDisposed();
        output.Start();
    }

    internal AppendResult Append(byte[] packet)
    {
        ThrowIfDisposed();
        if (packet.Length is < 1 or > MaxPacketBytes) throw new InvalidDataException("Opus packet must contain 1..4096 bytes.");
        var pcm = new short[MaxFrameSamples];
        int samples;
        try { samples = decoder.Decode(packet, pcm, pcm.Length, false); }
        catch (Exception exception) { throw new InvalidDataException("Invalid Opus packet.", exception); }
        if (samples <= 0 || samples > MaxFrameSamples) throw new InvalidDataException("Opus packet decoded to an invalid frame length.");
        var bytes = new byte[samples * sizeof(short)];
        Buffer.BlockCopy(pcm, 0, bytes, 0, bytes.Length);
        try { buffer.AddSamples(bytes, 0, bytes.Length); }
        catch (InvalidOperationException exception) { throw new AudioBufferOverflowException(exception); }
        var peak = 0;
        for (var index = 0; index < samples; index++) peak = Math.Max(peak, Math.Abs((int)pcm[index]));
        return new AppendResult(++packets, samples, peak / 32768.0, BufferedMilliseconds);
    }

    internal int BufferedMilliseconds => Math.Min(MaxBufferedMs, buffer.BufferedBytes * 1000 / (SampleRate * Channels * 2));

    internal async Task<bool> StopAfterDrainAsync(CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        var deadline = DateTime.UtcNow + TimeSpan.FromMilliseconds(MaxBufferedMs + 350);
        var drained = false;
        try
        {
            while (buffer.BufferedBytes > 0 && DateTime.UtcNow < deadline)
                await Task.Delay(10, cancellationToken).ConfigureAwait(false);
            if (buffer.BufferedBytes > 0) return false;
            await Task.Delay(OutputTailGuardMs, cancellationToken).ConfigureAwait(false);
            drained = true;
            return true;
        }
        catch (OperationCanceledException)
        {
            buffer.ClearBuffer();
            throw;
        }
        finally
        {
            if (!drained) buffer.ClearBuffer();
            Dispose();
        }
    }

    internal void Cancel()
    {
        if (disposed) return;
        buffer.ClearBuffer();
        Dispose();
    }

    internal async Task DiscardAsync(CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        buffer.ClearBuffer();
        decoder.ResetState();
        packets = 0;
        // Keep rendering silence while samples already handed to WASAPI/VB-CABLE
        // leave the output pipeline. They must not reach the next recording.
        await Task.Delay(OutputTailGuardMs, cancellationToken).ConfigureAwait(false);
        ThrowIfDisposed();
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        output.Stop();
        output.Faulted -= OnOutputFaulted;
        output.Dispose();
    }

    private void ThrowIfDisposed()
    {
        if (disposed) throw new InvalidOperationException("Audio session is not active.");
    }

    private void OnOutputFaulted()
    {
        if (!disposed) Faulted?.Invoke();
    }
}

internal sealed class AudioBufferOverflowException : Exception
{
    internal AudioBufferOverflowException(Exception inner) : base("PCM buffer is full; the audio session was cancelled.", inner) { }
}
