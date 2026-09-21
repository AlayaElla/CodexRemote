using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Esp32AudioBridge;

// The upstream license requires its signed driver to run with its original
// service. Consume that service's public localhost stream, never its IOCTLs.
internal sealed class StreamToSpeakerCapture : IWaveIn
{
    private readonly CancellationTokenSource cancelled = new();
    private readonly TaskCompletionSource<int> listening = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Process? service;
    private SafeFileHandle? job;
    private Task reader = Task.CompletedTask;
    private int started;
    private int stopping;
    private int disposed;
    private string lastLog = "";
    public WaveFormat WaveFormat { get; set; } = new(44100, 16, 2);
    public event EventHandler<WaveInEventArgs>? DataAvailable;
    public event EventHandler<StoppedEventArgs>? RecordingStopped;

    internal StreamToSpeakerCapture(string selectedDeviceId)
    {
        using var enumerator = new MMDeviceEnumerator();
        var endpoints = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active).ToArray();
        try
        {
            var matches = endpoints.Where(d => Matches(d.FriendlyName)).ToArray();
            if (matches.Length != 1 || matches[0].ID != selectedDeviceId)
                throw new InvalidOperationException("Stream To Speaker 需要唯一启用的播放端点，请检查音频设备设置。");
        }
        finally { foreach (var endpoint in endpoints) endpoint.Dispose(); }
    }

    internal static bool Matches(string name) => name.Equals("Stream To Speaker", StringComparison.OrdinalIgnoreCase)
        || name.EndsWith(" (Stream To Speaker)", StringComparison.OrdinalIgnoreCase);

    public void StartRecording()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        if (Interlocked.Exchange(ref started, 1) != 0) throw new InvalidOperationException("Capture has already started.");
        try
        {
            var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Stream To Speaker", "stream-to-speaker.exe");
            if (!File.Exists(path)) throw new InvalidOperationException("请先安装 Stream To Speaker 原版程序。");
            var existing = Process.GetProcessesByName("stream-to-speaker");
            try { if (existing.Length != 0) throw new InvalidOperationException("请先从托盘退出 Stream To Speaker；通话时音频桥会自动启动原版服务。"); }
            finally { foreach (var process in existing) process.Dispose(); }

            var reservation = new TcpListener(IPAddress.Loopback, 0);
            reservation.Start();
            var port = ((IPEndPoint)reservation.LocalEndpoint).Port;
            reservation.Stop();
            job = CreateChildJob();
            var start = new ProcessStartInfo(path) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var argument in new[] { "--headless", "--no-discovery", "--no-interactive", "--bind", "127.0.0.1", "--advertise-ip", "127.0.0.1", "--port", port.ToString(), "--source", "driver", "--no-silence-injection", "--log-level", "info" }) start.ArgumentList.Add(argument);
            service = new Process { StartInfo = start, EnableRaisingEvents = true };
            service.OutputDataReceived += OnLog;
            service.ErrorDataReceived += OnLog;
            service.Exited += (_, _) =>
            {
                listening.TrySetException(new IOException("Stream To Speaker 服务已退出。"));
                try { cancelled.Cancel(); } catch (ObjectDisposedException) { }
            };
            if (!service.Start()) throw new IOException("Cannot start Stream To Speaker.");
            if (!AssignProcessToJobObject(job, service.Handle)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            service.BeginOutputReadLine(); service.BeginErrorReadLine();
            var actualPort = listening.Task.WaitAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
            if (actualPort != port) throw new IOException("Stream To Speaker 监听端口发生冲突，请重试。");
            // Return when the listener is ready. HTTP headers can be delayed until
            // Codex starts playback; waiting for them here would deadlock startup.
            reader = Task.Run(() => ReadAsync(port));
        }
        catch
        {
            StopRecording();
            StopService();
            throw;
        }
    }

    private void OnLog(object sender, DataReceivedEventArgs args)
    {
        if (args.Data is not { } line) return;
        lastLog = line[..Math.Min(256, line.Length)];
        const string marker = "HTTP server listening on ";
        var position = line.IndexOf(marker, StringComparison.Ordinal);
        if (position >= 0 && int.TryParse(line[(position + marker.Length)..].Trim(), out var port)) listening.TrySetResult(port);
    }

    private async Task ReadAsync(int port)
    {
        Exception? failure = null;
        try
        {
            using var client = new HttpClient(new SocketsHttpHandler { UseProxy = false, AllowAutoRedirect = false }) { Timeout = Timeout.InfiniteTimeSpan };
            using var response = await client.GetAsync($"http://127.0.0.1:{port}/stream.raw", HttpCompletionOption.ResponseHeadersRead, cancelled.Token).ConfigureAwait(false);
            response.EnsureSuccessStatusCode();
            await using var stream = await response.Content.ReadAsStreamAsync(cancelled.Token).ConfigureAwait(false);
            var header = new byte[44];
            await stream.ReadExactlyAsync(header, cancelled.Token).ConfigureAwait(false);
            ValidateHeader(header);
            // Fixed complete stereo PCM frames, at most 20 ms per delivery.
            var buffer = new byte[44100 * 4 / 50];
            while (!cancelled.IsCancellationRequested)
            {
                await stream.ReadExactlyAsync(buffer, cancelled.Token).ConfigureAwait(false);
                DataAvailable?.Invoke(this, new WaveInEventArgs(buffer, buffer.Length));
            }
        }
        catch (OperationCanceledException) when (Volatile.Read(ref stopping) != 0) { }
        catch (Exception error) { failure = error; }
        finally
        {
            if (Volatile.Read(ref stopping) == 0 && failure is null) failure = new IOException("Stream To Speaker 音频流意外结束。");
            if (failure is OperationCanceledException) failure = new IOException("Stream To Speaker 服务已退出。" + lastLog);
            StopService();
            RecordingStopped?.Invoke(this, new StoppedEventArgs(failure));
        }
    }

    internal static void ValidateHeader(ReadOnlySpan<byte> header)
    {
        if (header.Length != 44 || !header[..4].SequenceEqual("RIFF"u8) || !header.Slice(8, 8).SequenceEqual("WAVEfmt "u8)
            || !header.Slice(36, 4).SequenceEqual("data"u8) || BinaryPrimitives.ReadUInt32LittleEndian(header[16..]) != 16
            || BinaryPrimitives.ReadUInt16LittleEndian(header[20..]) != 1 || BinaryPrimitives.ReadUInt16LittleEndian(header[22..]) != 2
            || BinaryPrimitives.ReadUInt32LittleEndian(header[24..]) != 44100 || BinaryPrimitives.ReadUInt32LittleEndian(header[28..]) != 176400
            || BinaryPrimitives.ReadUInt16LittleEndian(header[32..]) != 4 || BinaryPrimitives.ReadUInt16LittleEndian(header[34..]) != 16)
            throw new InvalidDataException("Stream To Speaker 返回了不支持的 WAV 音频格式。");
    }

    public void StopRecording()
    {
        if (Interlocked.Exchange(ref stopping, 1) == 0) cancelled.Cancel();
    }

    private void StopService()
    {
        if (service is null) return;
        try { if (!service.HasExited) service.Kill(entireProcessTree: true); service.WaitForExit(3000); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
        finally { job?.Dispose(); job = null; }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        StopRecording();
        reader.GetAwaiter().GetResult();
        StopService();
        service?.Dispose();
        cancelled.Dispose();
    }

    private static SafeFileHandle CreateChildJob()
    {
        var handle = CreateJobObject(IntPtr.Zero, null);
        if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } }; // KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
        { var error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new System.ComponentModel.Win32Exception(error); }
        return handle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
}
