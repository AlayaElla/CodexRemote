using VirtualMicroBroker;

if (args.SequenceEqual(["--inspect-removal"]))
{
    var targets = DriverRemovalNative.InspectRemovalTargets();
    Console.WriteLine($"Removal inspection: {targets.Devices.Count} owned devices, {targets.Packages.Count} owned packages.");
    foreach (var device in targets.Devices) Console.WriteLine($"Device {device.Token}: {device.Service}, {device.InfAssociation}, {device.InfName}");
    foreach (var package in targets.Packages) Console.WriteLine($"Package: {package}");
    return;
}

DriverRemovalChecks.Run();
Console.WriteLine("HID driver removal checks passed.");
