using VirtualMicroBroker;

if (args.SequenceEqual(["--driver-status"]))
{
    DriverStatus.WriteJson();
    return;
}

#if LOCAL_SELF_TESTS
if (args.SequenceEqual(["--self-test"]))
{
    await BrokerSelfTests.RunAsync();
    return;
}
#endif

if (args.Length != 0)
{
    Console.Error.WriteLine("不支持的启动参数。可使用 --driver-status 查询驱动状态。");
    Environment.ExitCode = 2;
    return;
}

using var driver = new WindowsVirtualMicroDriver();
await new BrokerServer(driver, Console.OpenStandardInput(), Console.Out, Console.Error).RunAsync();
