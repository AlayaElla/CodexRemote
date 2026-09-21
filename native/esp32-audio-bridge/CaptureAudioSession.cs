using Concentus;
using Concentus.Enums;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace Esp32AudioBridge;

// Captures only an explicitly selected render endpoint. This is deliberately
// separate from AudioSession, which renders ESP32 microphone audio to VB-CABLE.
internal sealed class CaptureAudioSession : IDisposable
{
    internal const int SampleRate = 16000;
    internal const int FrameSamples = 320;
    internal const int FrameDurationMs = 20;
    private const int MaxBufferedMs = 1000;

    private readonly WasapiLoopbackCapture capture;
    private readonly MMDevice device;
    private readonly BufferedWaveProvider input;
    private readonly CancellationTokenSource cancelled = new();
    private readonly CoalescingWakeSignal available = new();
    private readonly IOpusEncoder encoder = OpusCodecFactory.CreateEncoder(SampleRate, 1, OpusApplication.OPUS_APPLICATION_AUDIO, null);
    private readonly Action<byte[], long> packetReady;
    private readonly Action<string> faulted;
    private readonly Task worker;
    private readonly TaskCompletionSource resourcesReleased = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int cleanupStarted;
    private readonly CaptureStopState stopState = new();
    private long sequence;

    internal CaptureAudioSession(MMDevice device, Action<byte[], long> packetReady, Action<string> faulted)
    {
        this.packetReady = packetReady;
        this.faulted = faulted;
        this.device = device;
        capture = new WasapiLoopbackCapture(device);
        input = new BufferedWaveProvider(capture.WaveFormat)
        {
            BufferLength = Math.Max(capture.WaveFormat.AverageBytesPerSecond * MaxBufferedMs / 1000, capture.WaveFormat.BlockAlign * FrameSamples),
            DiscardOnBufferOverflow = false,
            ReadFully = false
        };
        capture.DataAvailable += OnDataAvailable;
        capture.RecordingStopped += OnRecordingStopped;
        worker = Task.Run(ProcessAsync);
    }

    internal void Start()
    {
        ThrowIfDisposed();
        capture.StartRecording();
    }

    internal async Task StopAsync()
    {
        RequestStop();
        await resourcesReleased.Task.ConfigureAwait(false);
    }

    public void Dispose() => StopAsync().GetAwaiter().GetResult();

    private void OnDataAvailable(object? sender, WaveInEventArgs args)
    {
        if (stopState.IsStopping || args.BytesRecorded <= 0) return;
        try
        {
            input.AddSamples(args.Buffer, 0, args.BytesRecorded);
            available.Signal();
        }
        catch (Exception exception)
        {
            if (!stopState.IsStopping) ReportFault("Loopback capture buffer overflow: " + SafeMessage(exception));
        }
    }

    private void OnRecordingStopped(object? sender, StoppedEventArgs args)
    {
        if (!stopState.IsStopping)
            ReportFault(args.Exception is null ? "WASAPI loopback capture stopped unexpectedly." : "WASAPI loopback capture failed: " + SafeMessage(args.Exception));
    }

    private async Task ProcessAsync()
    {
        try
        {
            ISampleProvider sample = input.ToSampleProvider();
            sample = ToMono(sample);
            sample = new WdlResamplingSampleProvider(sample, SampleRate);
            var samples = new float[FrameSamples];
            var frame = new short[FrameSamples];
            var frameCount = 0;
            while (!cancelled.IsCancellationRequested)
            {
                await available.WaitAsync(cancelled.Token).ConfigureAwait(false);
                int count;
                while (!cancelled.IsCancellationRequested && (count = sample.Read(samples, 0, samples.Length)) > 0)
                {
                    for (var index = 0; index < count; index++)
                    {
                        var value = Math.Clamp(samples[index], -1f, 1f);
                        frame[frameCount++] = (short)Math.Round(value * short.MaxValue);
                        if (frameCount != FrameSamples) continue;
                        var packet = new byte[1275];
                        var written = encoder.Encode(frame, FrameSamples, packet, packet.Length);
                        if (written <= 0) throw new InvalidOperationException("Opus encoder produced an empty 20 ms frame.");
                        if (written != packet.Length) Array.Resize(ref packet, written);
                        packetReady(packet, Interlocked.Increment(ref sequence));
                        frameCount = 0;
                    }
                }
            }
        }
        catch (OperationCanceledException) when (cancelled.IsCancellationRequested) { }
        catch (Exception exception) { ReportFault("Loopback capture failed: " + SafeMessage(exception)); }
    }

    private static ISampleProvider ToMono(ISampleProvider source)
    {
        if (source.WaveFormat.Channels == 1) return source;
        if (source.WaveFormat.Channels == 2)
        {
            var mono = new StereoToMonoSampleProvider(source) { LeftVolume = 0.5f, RightVolume = 0.5f };
            return mono;
        }
        return new AverageChannelsSampleProvider(source);
    }

    private void ReportFault(string message)
    {
        if (!stopState.TryReportFault(CancelWorker, StopCapture)) return;
        EnsureCleanup();
        faulted(message);
    }

    private void RequestStop()
    {
        stopState.BeginStop(CancelWorker, StopCapture);
        EnsureCleanup();
    }

    private void CancelWorker() => cancelled.Cancel();
    private void StopCapture()
    {
        try { capture.StopRecording(); }
        catch { }
    }

    private void EnsureCleanup()
    {
        if (Interlocked.Exchange(ref cleanupStarted, 1) == 0) _ = ReleaseResourcesAfterWorkerAsync();
    }

    private async Task ReleaseResourcesAfterWorkerAsync()
    {
        try
        {
            await worker.ConfigureAwait(false);
            DisposeResources();
            resourcesReleased.TrySetResult();
        }
        catch (Exception exception)
        {
            resourcesReleased.TrySetException(exception);
        }
    }

    private void DisposeResources()
    {
        capture.DataAvailable -= OnDataAvailable;
        capture.RecordingStopped -= OnRecordingStopped;
        capture.Dispose();
        device.Dispose();
        cancelled.Dispose();
    }

    private void ThrowIfDisposed()
    {
        if (stopState.IsStopping) throw new InvalidOperationException("Capture session is not active.");
    }

    private static string SafeMessage(Exception exception) => string.IsNullOrWhiteSpace(exception.Message) ? "unknown error" : exception.Message[..Math.Min(256, exception.Message.Length)];

    private sealed class AverageChannelsSampleProvider(ISampleProvider source) : ISampleProvider
    {
        private readonly int channels = source.WaveFormat.Channels;
        public WaveFormat WaveFormat { get; } = WaveFormat.CreateIeeeFloatWaveFormat(source.WaveFormat.SampleRate, 1);
        public int Read(float[] buffer, int offset, int count)
        {
            var requested = checked(count * channels);
            var input = new float[requested];
            var read = source.Read(input, 0, requested);
            var frames = read / channels;
            for (var frame = 0; frame < frames; frame++)
            {
                var sum = 0f;
                for (var channel = 0; channel < channels; channel++) sum += input[frame * channels + channel];
                buffer[offset + frame] = sum / channels;
            }
            return frames;
        }
    }
}

// Fault reporting and normal stop are separate one-time transitions. A fault
// must still cancel the worker even though it also prevents further callbacks.
internal sealed class CaptureStopState
{
    private int stopping;
    private int faultReported;
    internal bool IsStopping => Volatile.Read(ref stopping) != 0;

    internal bool BeginStop(Action cancelWorker, Action stopCapture)
    {
        if (Interlocked.Exchange(ref stopping, 1) != 0) return false;
        cancelWorker();
        stopCapture();
        return true;
    }

    internal bool TryReportFault(Action cancelWorker, Action stopCapture)
    {
        if (Interlocked.Exchange(ref faultReported, 1) != 0) return false;
        return BeginStop(cancelWorker, stopCapture);
    }
}

// Repeated WASAPI callbacks only need one worker wakeup. Keeping the semaphore
// count binary prevents callback bursts from faulting the capture session.
internal sealed class CoalescingWakeSignal
{
    private readonly SemaphoreSlim semaphore = new(0, 1);
    private int queued;

    internal void Signal()
    {
        if (Interlocked.Exchange(ref queued, 1) == 0) semaphore.Release();
    }

    internal async Task WaitAsync(CancellationToken cancellationToken)
    {
        await semaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
        Interlocked.Exchange(ref queued, 0);
    }
}
