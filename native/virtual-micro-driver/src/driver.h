#pragma once
#include <wdf.h>
#include <vhf.h>
#include "Public.h"

typedef struct _DEVICE_CONTEXT {
    VHFHANDLE Vhf;
    // VHF in UMDF is bound to the local WDF I/O target's file handle, not a
    // KMDF DEVICE_OBJECT.  Keep the target parented to the device until VHF
    // has synchronously cancelled every callback during cleanup.
    WDFIOTARGET VhfTarget;
    WDFWAITLOCK IoLock; // Passive-level input, reset, file and device lifetime.
    WDFFILEOBJECT OwnerFile; // Prevent queued I/O from a closed owner injecting after cleanup.
    WDFSPINLOCK Lock;   // Short shared-state sections, including VHF callbacks.
    BOOLEAN Ready;
    BOOLEAN Stopping;
    UINT64 Epoch;
    UINT64 LastBatch;
    UINT64 OutputSequence;
    ULONG LastAccepted;
    NTSTATUS LastStatus;
    ULONG Dropped;
    ULONG Head;
    ULONG Tail;
    ULONG Count;
    CRVM_OUTPUT_RECORD Output[CRVM_OUTPUT_QUEUE_CAPACITY];
} DEVICE_CONTEXT, *PDEVICE_CONTEXT;

WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(DEVICE_CONTEXT, CrGetContext)
DRIVER_INITIALIZE DriverEntry;
EVT_WDF_DRIVER_DEVICE_ADD CrEvtDeviceAdd;
EVT_WDF_OBJECT_CONTEXT_CLEANUP CrEvtCleanup;
EVT_WDF_DEVICE_PREPARE_HARDWARE CrEvtDevicePrepareHardware;
EVT_WDF_DEVICE_RELEASE_HARDWARE CrEvtDeviceReleaseHardware;
EVT_WDF_IO_QUEUE_IO_DEVICE_CONTROL CrEvtIoctl;
EVT_VHF_ASYNC_OPERATION CrEvtWriteReport;
EVT_WDF_FILE_CLEANUP CrEvtFileCleanup;
EVT_WDF_DEVICE_FILE_CREATE CrEvtFileCreate;
