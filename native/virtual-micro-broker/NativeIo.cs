using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace VirtualMicroBroker;

internal sealed record IoReply(bool Success, bool Issued, int NativeError, byte[] Bytes, string? Error)
{
    internal byte[] RequireBytes() => Success ? Bytes : throw new IOException(Error ?? "Driver I/O failed.");
}

internal static class NativeIo
{
    internal static async Task<IoReply> RunAsync(SafeFileHandle handle, uint code, byte[] input, int outputLength, CancellationToken ct)
    {
        if (ct.IsCancellationRequested || handle.IsClosed) return new(false, false, 995, [], "I/O cancelled before issue.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(2));
        using var request = new NativeRequest(handle, input, outputLength);
        var immediate = Native.DeviceIoControl(request.Handle, code, request.Input, input.Length, request.Output,
            outputLength, out var transferred, request.Overlapped);
        var error = immediate ? 0 : Marshal.GetLastWin32Error();
        if (!immediate && error != 997) return new(false, true, error, [], new Win32Exception(error).Message);
        if (!immediate)
        {
            var completed = await Task.Run(() => WaitHandle.WaitAny([request.Event, deadline.Token.WaitHandle]));
            if (completed != 0)
            {
                Native.CancelIoEx(request.Handle, request.Overlapped);
                if (!await Task.Run(() => request.Event.WaitOne(500)))
                {
                    // Terminate only the isolated broker. Never free kernel-owned
                    // OVERLAPPED/buffers or close their handles while I/O is pending.
                    Environment.FailFast("Virtual Micro driver did not complete cancellation; broker terminated for memory safety.");
                }
            }
            if (!Native.GetOverlappedResult(request.Handle, request.Overlapped, out transferred, false))
            {
                error = Marshal.GetLastWin32Error();
                if (error == 996) Environment.FailFast("Driver signalled an incomplete overlapped request.");
                return new(false, true, error, [], new Win32Exception(error).Message);
            }
        }
        if (transferred > outputLength) return new(false, true, 13, [], "Driver returned an oversized result.");
        return new(true, true, 0, request.CopyOutput((int)transferred), null);
    }

    private sealed class NativeRequest : IDisposable
    {
        private readonly SafeFileHandle handle;
        private bool added;
        internal IntPtr Handle => handle.DangerousGetHandle();
        internal EventWaitHandle Event { get; } = new(false, EventResetMode.ManualReset);
        internal IntPtr Input { get; private set; }
        internal IntPtr Output { get; private set; }
        internal IntPtr Overlapped { get; private set; }

        internal NativeRequest(SafeFileHandle handle, byte[] input, int outputLength)
        {
            this.handle = handle;
            try
            {
                handle.DangerousAddRef(ref added);
                if (input.Length > 0)
                {
                    Input = Marshal.AllocHGlobal(input.Length);
                    Marshal.Copy(input, 0, Input, input.Length);
                }
                if (outputLength > 0) Output = Marshal.AllocHGlobal(outputLength);
                var size = IntPtr.Size == 8 ? 32 : 20;
                Overlapped = Marshal.AllocHGlobal(size);
                Marshal.Copy(new byte[size], 0, Overlapped, size);
                Marshal.WriteIntPtr(Overlapped, IntPtr.Size == 8 ? 24 : 16, Event.SafeWaitHandle.DangerousGetHandle());
            }
            catch { Dispose(); throw; }
        }

        internal byte[] CopyOutput(int count)
        {
            var bytes = new byte[count];
            if (count > 0) Marshal.Copy(Output, bytes, 0, count);
            return bytes;
        }

        public void Dispose()
        {
            if (Input != IntPtr.Zero) { Marshal.FreeHGlobal(Input); Input = IntPtr.Zero; }
            if (Output != IntPtr.Zero) { Marshal.FreeHGlobal(Output); Output = IntPtr.Zero; }
            if (Overlapped != IntPtr.Zero) { Marshal.FreeHGlobal(Overlapped); Overlapped = IntPtr.Zero; }
            Event.Dispose();
            if (added) { added = false; handle.DangerousRelease(); }
        }
    }
}

internal static class Native
{
    internal const uint GenericRead = 0x80000000, GenericWrite = 0x40000000, OpenExisting = 3, FileFlagOverlapped = 0x40000000;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    internal static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    internal static extern bool DeviceIoControl(IntPtr handle, uint code, IntPtr input, int inputLength,
        IntPtr output, int outputLength, out uint bytes, IntPtr overlapped);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    internal static extern bool GetOverlappedResult(IntPtr handle, IntPtr overlapped, out uint bytes, bool wait);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    internal static extern bool CancelIoEx(IntPtr handle, IntPtr overlapped);
}
