namespace Esp32AudioBridge;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
#if LOCAL_SELF_TESTS
        if (args.SequenceEqual(new[] { "--self-test" })) return await SelfTests.RunAsync();
#endif
        if (args.SequenceEqual(new[] { "--list" }))
        {
            await Console.Out.WriteLineAsync(System.Text.Json.JsonSerializer.Serialize(new { id = (string?)null, ok = true, devices = CableDeviceCatalog.List() }, Protocol.Json));
            return 0;
        }
        if (args.SequenceEqual(new[] { "--defaults" }))
        {
            await Console.Out.WriteLineAsync(System.Text.Json.JsonSerializer.Serialize(new { ok = true, defaults = CableDeviceCatalog.Defaults() }, Protocol.Json));
            return 0;
        }
        if (args.SequenceEqual(new[] { "--probe-cable" }))
        {
            try
            {
                await Console.Out.WriteLineAsync(System.Text.Json.JsonSerializer.Serialize(new { ok = true, result = await CableProbe.RunAsync() }, Protocol.Json));
                return 0;
            }
            catch (Exception exception)
            {
                await Console.Out.WriteLineAsync(System.Text.Json.JsonSerializer.Serialize(new { ok = false, error = exception.Message.Length <= 512 ? exception.Message : exception.Message[..512] }, Protocol.Json));
                return 1;
            }
        }
        if (args.Length != 0)
        {
            await Console.Out.WriteLineAsync("{\"event\":\"fault\",\"error\":\"Unsupported command line argument.\"}");
            return 2;
        }
        await new AudioBridgeServer(Console.OpenStandardInput(), Console.Out).RunAsync();
        return 0;
    }
}
