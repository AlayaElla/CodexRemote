#import <Foundation/Foundation.h>
#import <IOKit/hid/IOHIDManager.h>
#import <IOKit/hidsystem/IOHIDUserDevice.h>

// Match the vendor-defined interface used by the Windows Micro transport.
// This descriptor contains no keyboard/mouse usages and emits no input.
static const uint8_t Descriptor[] = {
    0x06, 0x00, 0xFF, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x06,
    0x09, 0x01, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08,
    0x95, 0x3F, 0x91, 0x02, 0x09, 0x02, 0x95, 0x3F, 0x81, 0x02, 0xC0
};

static void WriteJSON(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2 || strcmp(argv[1], "--probe") != 0) {
            fprintf(stderr, "Usage: CodexRemoteMacHIDProbe --probe\n");
            return 64;
        }
        NSString *serial = [@"codex-remote-probe-" stringByAppendingString:NSUUID.UUID.UUIDString];
        NSDictionary *properties = @{
            @kIOHIDReportDescriptorKey: [NSData dataWithBytes:Descriptor length:sizeof(Descriptor)],
            @kIOHIDVendorIDKey: @0x303A,
            @kIOHIDProductIDKey: @0x8360,
            @kIOHIDVersionNumberKey: @0x0100,
            @kIOHIDManufacturerKey: @"Work Louder (Codex Remote virtual device)",
            @kIOHIDProductKey: @"Codex Remote Virtual Micro Probe",
            @kIOHIDSerialNumberKey: serial,
            @kIOHIDTransportKey: @"Virtual"
        };
        IOHIDUserDeviceRef device = IOHIDUserDeviceCreateWithProperties(
            kCFAllocatorDefault, (__bridge CFDictionaryRef)properties, 0);
        if (!device) {
            // Obtain the kernel connection error separately: creation itself
            // returns only NULL, so do not invent a specific failure reason.
            io_service_t resource = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDResource"));
            io_connect_t connection = IO_OBJECT_NULL;
            kern_return_t result = resource
                ? IOServiceOpen(resource, mach_task_self(), 0, &connection) : kIOReturnNotFound;
            if (connection) IOServiceClose(connection);
            if (resource) IOObjectRelease(resource);
            WriteJSON(@{ @"created": @NO, @"hidEnumerated": @NO, @"microConnected": @NO,
                @"state": @"device_creation_failed",
                @"resourceOpenResult": [NSString stringWithFormat:@"0x%08x", result],
                @"requiredEntitlement": @"com.apple.developer.hid.virtual.device",
                @"message": @"macOS 未允许创建虚拟 HID；请检查 Apple 授权的 entitlement、签名和 provisioning profile。" });
            return 2;
        }

        // A successful allocation is not sufficient: verify this exact probe's
        // serial appears through the same IOHIDManager used by HID clients.
        IOHIDManagerRef manager = IOHIDManagerCreate(kCFAllocatorDefault, 0);
        IOHIDManagerSetDeviceMatching(manager, (__bridge CFDictionaryRef)@{
            @kIOHIDVendorIDKey: @0x303A, @kIOHIDProductIDKey: @0x8360,
            @kIOHIDSerialNumberKey: serial });
        IOReturn openResult = IOHIDManagerOpen(manager, 0);
        bool enumerated = false;
        for (int attempt = 0; attempt < 10 && !enumerated && openResult == kIOReturnSuccess; attempt++) {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
            CFSetRef devices = IOHIDManagerCopyDevices(manager);
            enumerated = devices && CFSetGetCount(devices) > 0;
            if (devices) CFRelease(devices);
        }
        IOHIDManagerClose(manager, 0);
        CFRelease(manager);
        CFRelease(device); // Process lifetime only; never installs a service.
        WriteJSON(@{ @"created": @YES, @"hidEnumerated": @(enumerated), @"microConnected": @NO,
            @"state": enumerated ? @"enumerated_handshake_not_tested" : @"enumeration_failed",
            @"managerOpenResult": [NSString stringWithFormat:@"0x%08x", openResult],
            @"message": @"探针已移除；本次不发送按键、不测试 Micro RPC 握手。" });
        return enumerated ? 0 : 3;
    }
}
