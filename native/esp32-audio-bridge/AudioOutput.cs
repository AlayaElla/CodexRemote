using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;
using System.Runtime.InteropServices;

namespace Esp32AudioBridge;

internal sealed record CableOutputDevice(string Id, string Name, string CaptureName);
internal sealed record DefaultAudioEndpoint(string Flow, string Role, string Id, string Name);

internal interface IAudioOutput : IDisposable
{
    event Action? Faulted;
    void Start();
    void Stop();
}

internal sealed class WasapiCableOutput : IAudioOutput
{
    private readonly MMDevice device;
    private readonly WasapiOut player;
    public event Action? Faulted;

    internal WasapiCableOutput(MMDevice device, BufferedWaveProvider source)
    {
        this.device = device;
        var mix = device.AudioClient.MixFormat;
        ISampleProvider sample = new Pcm16BitToSampleProvider(source);
        if (sample.WaveFormat.SampleRate != mix.SampleRate)
            sample = new WdlResamplingSampleProvider(sample, mix.SampleRate);
        sample = MatchChannels(sample, mix.Channels);
        player = new WasapiOut(device, AudioClientShareMode.Shared, false, 100);
        try
        {
            player.PlaybackStopped += (_, eventArgs) => { if (eventArgs.Exception is not null) Faulted?.Invoke(); };
            player.Init(new SampleToWaveProvider(sample));
        }
        catch
        {
            player.Dispose();
            device.Dispose();
            throw;
        }
    }

    public void Start() => player.Play();
    public void Stop() => player.Stop();
    public void Dispose()
    {
        player.Dispose();
        device.Dispose();
    }

    private static ISampleProvider MatchChannels(ISampleProvider source, int targetChannels)
    {
        if (source.WaveFormat.Channels == targetChannels) return source;
        if (source.WaveFormat.Channels == 1 && targetChannels == 2) return new MonoToStereoSampleProvider(source);
        var multiplex = new MultiplexingSampleProvider(new[] { source }, targetChannels);
        for (var output = 0; output < targetChannels; output++)
            multiplex.ConnectInputToOutput(0, output);
        return multiplex;
    }
}

internal static class CableDeviceCatalog
{
    internal static IReadOnlyList<DefaultAudioEndpoint> Defaults()
    {
        using var enumerator = new MMDeviceEnumerator();
        var endpoints = new List<DefaultAudioEndpoint>();
        foreach (var flow in new[] { DataFlow.Render, DataFlow.Capture })
        foreach (var role in new[] { Role.Console, Role.Multimedia, Role.Communications })
        {
            try
            {
                using var device = enumerator.GetDefaultAudioEndpoint(flow, role);
                endpoints.Add(new DefaultAudioEndpoint(flow.ToString().ToLowerInvariant(), role.ToString().ToLowerInvariant(), device.ID, device.FriendlyName));
            }
            catch (COMException) { }
        }
        return endpoints;
    }

    internal static IReadOnlyList<CableOutputDevice> List()
    {
        using var enumerator = new MMDeviceEnumerator();
        var captures = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var capture in enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active))
        {
            if (IsCableOutput(capture)) captures.Add(capture.FriendlyName);
            capture.Dispose();
        }
        var result = new List<CableOutputDevice>();
        foreach (var render in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            var captureName = PairedCaptureName(render.FriendlyName);
            if (IsCableInput(render) && captures.Contains(captureName))
                result.Add(new CableOutputDevice(render.ID, render.FriendlyName, captureName));
            render.Dispose();
        }
        return result;
    }

    internal static MMDevice OpenExact(string id)
    {
        using var enumerator = new MMDeviceEnumerator();
        var device = enumerator.GetDevice(id);
        if (!IsCableInput(device) || !List().Any(candidate => candidate.Id == id))
        {
            device.Dispose();
            throw new InvalidOperationException("The requested endpoint is not an active VB-CABLE Input render endpoint with an active paired CABLE Output capture endpoint.");
        }
        return device;
    }

    internal static MMDevice OpenPairedCapture(CableOutputDevice render)
    {
        using var enumerator = new MMDeviceEnumerator();
        foreach (var capture in enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active))
        {
            if (IsCableOutput(capture) && string.Equals(capture.FriendlyName, render.CaptureName, StringComparison.OrdinalIgnoreCase))
                return capture;
            capture.Dispose();
        }
        throw new InvalidOperationException("The paired CABLE Output capture endpoint is no longer active.");
    }

    private static bool IsCableInput(MMDevice device) =>
        device.FriendlyName.Contains("CABLE Input", StringComparison.OrdinalIgnoreCase) &&
        device.DeviceFriendlyName.Contains("VB-Audio Virtual Cable", StringComparison.OrdinalIgnoreCase);

    private static bool IsCableOutput(MMDevice device) =>
        device.FriendlyName.Contains("CABLE Output", StringComparison.OrdinalIgnoreCase) &&
        device.DeviceFriendlyName.Contains("VB-Audio Virtual Cable", StringComparison.OrdinalIgnoreCase);
    private static string PairedCaptureName(string renderName) => renderName.Replace("CABLE Input", "CABLE Output", StringComparison.OrdinalIgnoreCase);
}
