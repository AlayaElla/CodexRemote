#include <initguid.h>
#include <windows.h>
#include "driver.h"

// Vendor-defined TLC, report ID 6, 63 payload bytes in both directions.
static UCHAR ReportDescriptor[] = {
    0x06, 0x00, 0xFF, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x06,
    0x09, 0x01, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08,
    0x95, 0x3F, 0x91, 0x02, 0x09, 0x02, 0x95, 0x3F, 0x81, 0x02, 0xC0
};

// VHF consumes this MULTI_SZ when it creates the HID child PDO.  Keep the
// source device's ROOT\CodexRemoteVirtualMicro identity in the INF; this is
// the child HID hardware ID that makes its interface path identify the Codex
// Micro VID/PID.  The explicit NUL plus the literal terminator form the
// required double-NUL terminator for one MULTI_SZ entry.
static WCHAR VhfHardwareIds[] = L"HID\\VID_303A&PID_8360\0";
C_ASSERT(sizeof(VhfHardwareIds) <= 0xFFFFu);

static BOOLEAN ValidReport(const UCHAR *wire)
{
    return wire[0] == 6 && (wire[1] == 1 || wire[1] == 2) && wire[2] <= 61;
}

// Caller holds IoLock. VHF's default buffering copies the input before return.
// Never hold the callback's spin lock across a VHF call.
static NTSTATUS SubmitWire(PDEVICE_CONTEXT context, UCHAR *wire)
{
    HID_XFER_PACKET packet = {0};
    if (!context->Ready || context->Stopping || !context->Vhf) {
        return STATUS_DEVICE_NOT_READY;
    }
    packet.reportId = 6;
    packet.reportBuffer = wire;
    packet.reportBufferLen = CRVM_REPORT_LENGTH;
    return VhfReadReportSubmit(context->Vhf, &packet);
}

static NTSTATUS ReleasePtt(PDEVICE_CONTEXT context)
{
    static const CHAR release[] = "{\"m\":\"v.oai.hid\",\"p\":{\"k\":\"ACT10\",\"act\":0}}\n";
    UCHAR wire[CRVM_REPORT_LENGTH] = {6, 2, sizeof(release) - 1};
    C_ASSERT(sizeof(release) - 1 <= 61);
    RtlCopyMemory(wire + 3, release, sizeof(release) - 1);
    return SubmitWire(context, wire);
}

// Caller holds IoLock. Release is always source-owned neutral ACT10-up.
static NTSTATUS ResetTransport(PDEVICE_CONTEXT context)
{
    NTSTATUS releaseStatus = ReleasePtt(context);
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    WdfSpinLockAcquire(context->Lock);
    context->Epoch = (UINT64)now.QuadPart; // Opaque connection/reset generation.
    context->LastBatch = 0;
    context->LastAccepted = 0;
    context->LastStatus = STATUS_SUCCESS;
    context->Head = context->Tail = context->Count = 0;
    context->OutputSequence = 0;
    context->Dropped = 0;
    WdfSpinLockRelease(context->Lock);
    return releaseStatus;
}

// PrepareHardware begins a distinct VHF lifetime. It cannot retain an output
// record or acknowledgement from the prior instance: the broker treats Epoch
// and sequences as a transport generation, not as durable driver history.
static VOID CrBeginTransport(PDEVICE_CONTEXT context)
{
    LARGE_INTEGER now;
    UINT64 nextEpoch;
    QueryPerformanceCounter(&now);
    WdfWaitLockAcquire(context->IoLock, NULL);
    WdfSpinLockAcquire(context->Lock);
    nextEpoch = (UINT64)now.QuadPart;
    if (nextEpoch <= context->Epoch) nextEpoch = context->Epoch + 1;
    context->Epoch = nextEpoch;
    context->LastBatch = 0;
    context->LastAccepted = 0;
    context->LastStatus = STATUS_SUCCESS;
    context->OutputSequence = 0;
    context->Dropped = 0;
    context->Head = context->Tail = context->Count = 0;
    RtlZeroMemory(context->Output, sizeof(context->Output));
    WdfSpinLockRelease(context->Lock);
    WdfWaitLockRelease(context->IoLock);
}

static VOID Reply(WDFREQUEST request, UINT64 sequence, ULONG disposition,
                  ULONG accepted, NTSTATUS failure)
{
    CRVM_SUBMIT_RESULT *result;
    NTSTATUS status = WdfRequestRetrieveOutputBuffer(request, sizeof(*result), (PVOID *)&result, NULL);
    if (!NT_SUCCESS(status)) {
        WdfRequestComplete(request, status);
        return;
    }
    RtlZeroMemory(result, sizeof(*result));
    result->Magic = CRVM_MAGIC;
    result->Version = CRVM_VERSION;
    result->Size = sizeof(*result);
    result->Sequence = sequence;
    result->Disposition = disposition;
    result->AcceptedReports = accepted;
    result->FirstFailureStatus = failure;
    WdfRequestCompleteWithInformation(request, STATUS_SUCCESS, sizeof(*result));
}

static VOID GetInfo(PDEVICE_CONTEXT context, WDFREQUEST request)
{
    CRVM_INFO *info;
    NTSTATUS status = WdfRequestRetrieveOutputBuffer(request, sizeof(*info), (PVOID *)&info, NULL);
    if (!NT_SUCCESS(status)) {
        WdfRequestComplete(request, status);
        return;
    }
    RtlZeroMemory(info, sizeof(*info));
    info->Magic = CRVM_MAGIC;
    info->Version = CRVM_VERSION;
    info->Size = sizeof(*info);
    WdfSpinLockAcquire(context->Lock);
    info->ConnectionEpoch = context->Epoch;
    info->LastBatchSequence = context->LastBatch;
    info->OutputSequence = context->OutputSequence;
    info->DroppedOutputReports = context->Dropped;
    info->Flags = CRVM_FLAG_TRANSPORT_RESET | (context->Ready ? CRVM_FLAG_READY : 0);
    WdfSpinLockRelease(context->Lock);
    WdfRequestCompleteWithInformation(request, STATUS_SUCCESS, sizeof(*info));
}

static VOID ReadOutput(PDEVICE_CONTEXT context, WDFREQUEST request)
{
    CRVM_OUTPUT_RECORD *output;
    NTSTATUS status = WdfRequestRetrieveOutputBuffer(request, sizeof(*output), (PVOID *)&output, NULL);
    if (!NT_SUCCESS(status)) {
        WdfRequestComplete(request, status);
        return;
    }
    WdfSpinLockAcquire(context->Lock);
    if (context->Count == 0) {
        WdfSpinLockRelease(context->Lock);
        WdfRequestComplete(request, STATUS_NO_MORE_ENTRIES);
        return;
    }
    RtlCopyMemory(output, &context->Output[context->Head], sizeof(*output));
    context->Head = (context->Head + 1) % CRVM_OUTPUT_QUEUE_CAPACITY;
    context->Count--;
    WdfSpinLockRelease(context->Lock);
    WdfRequestCompleteWithInformation(request, STATUS_SUCCESS, sizeof(*output));
}

static VOID SubmitBatch(PDEVICE_CONTEXT context, WDFREQUEST request)
{
    CRVM_BATCH_HEADER *input;
    CRVM_BATCH_HEADER header;
    PVOID output;
    size_t inputLength;
    ULONG index, accepted = 0, disposition;
    UCHAR *reports;
    NTSTATUS status;

    status = WdfRequestRetrieveInputBuffer(request, sizeof(header), (PVOID *)&input, &inputLength);
    if (!NT_SUCCESS(status)) {
        WdfRequestComplete(request, status);
        return;
    }
    // METHOD_BUFFERED aliases input and output. Validate output before injection
    // and copy all header fields before constructing an acknowledgement.
    status = WdfRequestRetrieveOutputBuffer(request, sizeof(CRVM_SUBMIT_RESULT), &output, NULL);
    if (!NT_SUCCESS(status)) {
        WdfRequestComplete(request, status);
        return;
    }
    RtlCopyMemory(&header, input, sizeof(header));
    if (header.Magic != CRVM_MAGIC || header.Version != CRVM_VERSION || !header.Sequence ||
        !header.ReportCount || header.ReportCount > CRVM_MAX_BATCH_REPORTS ||
        inputLength != sizeof(header) + (size_t)header.ReportCount * CRVM_REPORT_LENGTH) {
        Reply(request, header.Sequence, 4, 0, STATUS_INVALID_PARAMETER);
        return;
    }
    reports = (UCHAR *)input + sizeof(header);
    for (index = 0; index < header.ReportCount; index++) {
        if (!ValidReport(reports + index * CRVM_REPORT_LENGTH)) {
            Reply(request, header.Sequence, 4, 0, STATUS_INVALID_PARAMETER);
            return;
        }
    }
    WdfWaitLockAcquire(context->IoLock, NULL);
    if (!context->OwnerFile || WdfRequestGetFileObject(request) != context->OwnerFile) {
        WdfWaitLockRelease(context->IoLock);
        Reply(request, header.Sequence, 0, 0, STATUS_FILE_CLOSED);
        return;
    }
    if (header.Sequence <= context->LastBatch) {
        BOOLEAN duplicate = header.Sequence == context->LastBatch;
        accepted = duplicate ? context->LastAccepted : 0;
        status = duplicate ? context->LastStatus : STATUS_INVALID_PARAMETER;
        WdfWaitLockRelease(context->IoLock);
        // Duplicate is not a new Accepted result and is never replayed.
        Reply(request, header.Sequence, duplicate ? 3 : 4, accepted, status);
        return;
    }
    status = STATUS_SUCCESS;
    for (index = 0; index < header.ReportCount; index++) {
        status = SubmitWire(context, reports + index * CRVM_REPORT_LENGTH);
        if (!NT_SUCCESS(status)) break;
        accepted++;
    }
    disposition = accepted == header.ReportCount ? 1 : (accepted ? 2 : 0);
    WdfSpinLockAcquire(context->Lock);
    context->LastBatch = header.Sequence;
    context->LastAccepted = accepted;
    context->LastStatus = status;
    WdfSpinLockRelease(context->Lock);
    WdfWaitLockRelease(context->IoLock);
    Reply(request, header.Sequence, disposition, accepted, status);
}

VOID CrEvtWriteReport(PVOID opaque, VHFOPERATIONHANDLE operation, PVOID operationContext,
                      PHID_XFER_PACKET packet)
{
    PDEVICE_CONTEXT context = (PDEVICE_CONTEXT)opaque;
    CRVM_OUTPUT_RECORD record = {0};
    NTSTATUS status = STATUS_SUCCESS;
    UNREFERENCED_PARAMETER(operationContext);
    if (!context || !packet || packet->reportId != 6 || !packet->reportBuffer) {
        VhfAsyncOperationComplete(operation, STATUS_INVALID_PARAMETER);
        return;
    }
    if (packet->reportBufferLen == CRVM_REPORT_LENGTH && packet->reportBuffer[0] == 6) {
        RtlCopyMemory(record.WireReport, packet->reportBuffer, CRVM_REPORT_LENGTH);
        record.Flags = CRVM_OUTPUT_INCLUDED_REPORT_ID;
    } else if (packet->reportBufferLen >= 2 && packet->reportBufferLen <= 63) {
        record.WireReport[0] = 6;
        RtlCopyMemory(record.WireReport + 1, packet->reportBuffer, packet->reportBufferLen);
        record.Flags = CRVM_OUTPUT_EXCLUDED_REPORT_ID;
        if (record.WireReport[2] > packet->reportBufferLen - 2) status = STATUS_INVALID_BUFFER_SIZE;
    } else {
        status = STATUS_INVALID_BUFFER_SIZE;
    }
    if (!NT_SUCCESS(status) || !ValidReport(record.WireReport)) {
        VhfAsyncOperationComplete(operation, NT_SUCCESS(status) ? STATUS_INVALID_PARAMETER : status);
        return;
    }
    record.Magic = CRVM_MAGIC;
    record.Version = CRVM_VERSION;
    record.Size = sizeof(record);
    {
        LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        record.PerformanceCounter = (UINT64)now.QuadPart;
    }
    record.OriginalLength = packet->reportBufferLen;
    WdfSpinLockAcquire(context->Lock);
    if (!context->Ready || context->Stopping) {
        status = STATUS_DEVICE_NOT_READY;
    } else {
        record.Sequence = ++context->OutputSequence;
        if (context->Count == CRVM_OUTPUT_QUEUE_CAPACITY) {
            context->Dropped++;
            status = STATUS_DEVICE_BUSY;
        } else {
            RtlCopyMemory(&context->Output[context->Tail], &record, sizeof(record));
            context->Tail = (context->Tail + 1) % CRVM_OUTPUT_QUEUE_CAPACITY;
            context->Count++;
        }
    }
    WdfSpinLockRelease(context->Lock);
    VhfAsyncOperationComplete(operation, status);
}

VOID CrEvtIoctl(WDFQUEUE queue, WDFREQUEST request, size_t outputLength, size_t inputLength, ULONG code)
{
    PDEVICE_CONTEXT context = CrGetContext(WdfIoQueueGetDevice(queue));
    NTSTATUS status;
    UNREFERENCED_PARAMETER(outputLength);
    UNREFERENCED_PARAMETER(inputLength);
    switch (code) {
    case IOCTL_CRVM_GET_INFO: GetInfo(context, request); break;
    case IOCTL_CRVM_SUBMIT_INPUT: SubmitBatch(context, request); break;
    case IOCTL_CRVM_READ_OUTPUT: ReadOutput(context, request); break;
    case IOCTL_CRVM_RESET_TRANSPORT:
        WdfWaitLockAcquire(context->IoLock, NULL);
        status = ResetTransport(context);
        WdfWaitLockRelease(context->IoLock);
        WdfRequestComplete(request, status);
        break;
    default: WdfRequestComplete(request, STATUS_INVALID_DEVICE_REQUEST); break;
    }
}

VOID CrEvtFileCreate(WDFDEVICE device, WDFREQUEST request, WDFFILEOBJECT file)
{
    PDEVICE_CONTEXT context = CrGetContext(device);
    WdfWaitLockAcquire(context->IoLock, NULL);
    if (context->OwnerFile) {
        WdfWaitLockRelease(context->IoLock);
        WdfRequestComplete(request, STATUS_SHARING_VIOLATION);
        return;
    }
    context->OwnerFile = file;
    WdfWaitLockRelease(context->IoLock);
    WdfRequestComplete(request, STATUS_SUCCESS);
}

VOID CrEvtFileCleanup(WDFFILEOBJECT file)
{
    PDEVICE_CONTEXT context = CrGetContext(WdfFileObjectGetDevice(file));
    WdfWaitLockAcquire(context->IoLock, NULL);
    if (context->OwnerFile == file) {
        (VOID)ResetTransport(context); // Best effort only; host recording is unobservable here.
        context->OwnerFile = NULL;
    }
    WdfWaitLockRelease(context->IoLock);
}

VOID CrEvtCleanup(WDFOBJECT device)
{
    // Framework children can be deleted before their parent. VHF and the
    // local target are therefore stopped in EvtDeviceReleaseHardware, while
    // their file handle and the two WDF locks are still valid. Do not touch
    // either child handle from parent cleanup.
    UNREFERENCED_PARAMETER(device);
}

static VOID CrStopVhf(PDEVICE_CONTEXT context)
{
    VHFHANDLE vhf;
    WDFIOTARGET target;
    WdfWaitLockAcquire(context->IoLock, NULL);
    (VOID)ReleasePtt(context); // Best effort neutral ACT10-up while VHF is live.
    WdfSpinLockAcquire(context->Lock);
    context->Stopping = TRUE;
    context->Ready = FALSE;
    vhf = context->Vhf;
    target = context->VhfTarget;
    context->Vhf = NULL;
    context->VhfTarget = NULL;
    WdfSpinLockRelease(context->Lock);
    // VHF may retain the UMDF local-target file handle in callbacks. Drain it
    // before close/delete so no callback can use a stale target handle.
    if (vhf) VhfDelete(vhf, TRUE);
    if (target) {
        WdfIoTargetClose(target);
        WdfObjectDelete(target);
    }
    WdfWaitLockRelease(context->IoLock);
}

NTSTATUS CrEvtDevicePrepareHardware(WDFDEVICE device, WDFCMRESLIST rawResources,
                                    WDFCMRESLIST translatedResources)
{
    PDEVICE_CONTEXT context = CrGetContext(device);
    WDF_OBJECT_ATTRIBUTES targetAttributes;
    WDF_IO_TARGET_OPEN_PARAMS targetOpen;
    VHF_CONFIG vhf;
    HANDLE vhfFile;
    NTSTATUS status;
    UNREFERENCED_PARAMETER(rawResources);
    UNREFERENCED_PARAMETER(translatedResources);

    CrBeginTransport(context);
    WDF_OBJECT_ATTRIBUTES_INIT(&targetAttributes);
    targetAttributes.ParentObject = device;
    status = WdfIoTargetCreate(device, &targetAttributes, &context->VhfTarget);
    if (!NT_SUCCESS(status)) return status;
    WDF_IO_TARGET_OPEN_PARAMS_INIT_OPEN_BY_FILE(&targetOpen, NULL);
    status = WdfIoTargetOpen(context->VhfTarget, &targetOpen);
    if (!NT_SUCCESS(status)) goto Failed;
    vhfFile = WdfIoTargetWdmGetTargetFileHandle(context->VhfTarget);
    if (!vhfFile || vhfFile == INVALID_HANDLE_VALUE) {
        status = STATUS_INVALID_HANDLE;
        goto Failed;
    }
    VHF_CONFIG_INIT(&vhf, vhfFile, sizeof(ReportDescriptor), ReportDescriptor);
    vhf.VendorID = 0x303A;
    vhf.ProductID = 0x8360;
    vhf.VersionNumber = 1;
    vhf.HardwareIDsLength = (USHORT)sizeof(VhfHardwareIds);
    vhf.HardwareIDs = VhfHardwareIds;
    vhf.VhfClientContext = context;
    vhf.EvtVhfAsyncOperationWriteReport = CrEvtWriteReport;
    status = VhfCreate(&vhf, &context->Vhf);
    if (!NT_SUCCESS(status)) goto Failed;
    WdfSpinLockAcquire(context->Lock);
    context->Stopping = FALSE;
    context->Ready = TRUE; // Allows callbacks during VhfStart.
    WdfSpinLockRelease(context->Lock);
    status = VhfStart(context->Vhf);
    if (NT_SUCCESS(status)) return status;
    WdfSpinLockAcquire(context->Lock);
    context->Ready = FALSE;
    WdfSpinLockRelease(context->Lock);

Failed:
    CrStopVhf(context);
    return status;
}

NTSTATUS CrEvtDeviceReleaseHardware(WDFDEVICE device, WDFCMRESLIST translatedResources)
{
    UNREFERENCED_PARAMETER(translatedResources);
    CrStopVhf(CrGetContext(device));
    return STATUS_SUCCESS;
}

NTSTATUS CrEvtDeviceAdd(WDFDRIVER driver, PWDFDEVICE_INIT deviceInit)
{
    WDF_OBJECT_ATTRIBUTES attributes, lockAttributes;
    WDF_FILEOBJECT_CONFIG files;
    WDF_IO_QUEUE_CONFIG queue;
    WDF_PNPPOWER_EVENT_CALLBACKS pnp;
    WDFDEVICE device;
    PDEVICE_CONTEXT context;
    NTSTATUS status;
    UNREFERENCED_PARAMETER(driver);

    // These KMDF device-object characteristics have no UMDF equivalent.
    // CrEvtFileCreate enforces one broker control endpoint explicitly.
    WDF_FILEOBJECT_CONFIG_INIT(&files, CrEvtFileCreate, WDF_NO_EVENT_CALLBACK, CrEvtFileCleanup);
    WdfDeviceInitSetFileObjectConfig(deviceInit, &files, WDF_NO_OBJECT_ATTRIBUTES);
    WDF_PNPPOWER_EVENT_CALLBACKS_INIT(&pnp);
    pnp.EvtDevicePrepareHardware = CrEvtDevicePrepareHardware;
    pnp.EvtDeviceReleaseHardware = CrEvtDeviceReleaseHardware;
    WdfDeviceInitSetPnpPowerEventCallbacks(deviceInit, &pnp);
    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, DEVICE_CONTEXT);
    attributes.ExecutionLevel = WdfExecutionLevelPassive;
    attributes.EvtCleanupCallback = CrEvtCleanup;
    status = WdfDeviceCreate(&deviceInit, &attributes, &device);
    if (!NT_SUCCESS(status)) return status;
    context = CrGetContext(device);
    WDF_OBJECT_ATTRIBUTES_INIT(&lockAttributes);
    lockAttributes.ParentObject = device;
    status = WdfSpinLockCreate(&lockAttributes, &context->Lock);
    if (!NT_SUCCESS(status)) return status;
    status = WdfWaitLockCreate(&lockAttributes, &context->IoLock);
    if (!NT_SUCCESS(status)) return status;
    {
        LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        context->Epoch = (UINT64)now.QuadPart;
    }
    WDF_IO_QUEUE_CONFIG_INIT_DEFAULT_QUEUE(&queue, WdfIoQueueDispatchSequential);
    queue.EvtIoDeviceControl = CrEvtIoctl;
    status = WdfIoQueueCreate(device, &queue, WDF_NO_OBJECT_ATTRIBUTES, WDF_NO_HANDLE);
    if (!NT_SUCCESS(status)) return status;
    status = WdfDeviceCreateDeviceInterface(device, &GUID_DEVINTERFACE_CODEXREMOTE_VMICRO, NULL);
    if (!NT_SUCCESS(status)) return status;
    return STATUS_SUCCESS;
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driver, PUNICODE_STRING registryPath)
{
    WDF_DRIVER_CONFIG config;
    WDF_DRIVER_CONFIG_INIT(&config, CrEvtDeviceAdd);
    return WdfDriverCreate(driver, registryPath, WDF_NO_OBJECT_ATTRIBUTES, &config, WDF_NO_HANDLE);
}
