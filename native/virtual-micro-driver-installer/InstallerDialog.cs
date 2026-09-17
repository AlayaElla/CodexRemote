using System.ComponentModel;
using System.Runtime.InteropServices;

namespace VirtualMicroBroker;

internal enum InstallerAction
{
    None,
    OverwriteInstall,
    Remove
}

// A native Task Dialog keeps the production surface to exactly two labelled
// actions without pulling in WinForms/WPF or a managed runtime UI framework.
internal static class InstallerDialog
{
    private const int InstallButtonId = 100;
    private const int RemoveButtonId = 101;
    private const uint TdfAllowDialogCancellation = 0x00000008;

    internal static InstallerAction ChooseAction()
    {
        var title = Marshal.StringToHGlobalUni("Codex Remote 驱动安装器");
        var instruction = Marshal.StringToHGlobalUni("虚拟 Micro 驱动");
        var content = Marshal.StringToHGlobalUni("请选择要执行的操作。");
        var install = Marshal.StringToHGlobalUni("安装（覆盖安装）");
        var remove = Marshal.StringToHGlobalUni("删除");
        var buttonSize = Marshal.SizeOf<TaskDialogButton>();
        var buttons = Marshal.AllocHGlobal(buttonSize * 2);
        try
        {
            Marshal.StructureToPtr(new TaskDialogButton { Id = InstallButtonId, Text = install }, buttons, false);
            Marshal.StructureToPtr(new TaskDialogButton { Id = RemoveButtonId, Text = remove }, IntPtr.Add(buttons, buttonSize), false);
            var config = new TaskDialogConfig
            {
                Size = (uint)Marshal.SizeOf<TaskDialogConfig>(),
                WindowTitle = title,
                MainInstruction = instruction,
                Content = content,
                Flags = TdfAllowDialogCancellation,
                ButtonCount = 2,
                Buttons = buttons
            };
            var hr = TaskDialogIndirect(ref config, out var selected, out _, out _);
            if (hr < 0) throw new Win32Exception(hr, "无法显示安装器操作窗口。");
            return selected == InstallButtonId ? InstallerAction.OverwriteInstall :
                selected == RemoveButtonId ? InstallerAction.Remove : InstallerAction.None;
        }
        finally
        {
            Marshal.FreeHGlobal(buttons);
            Marshal.FreeHGlobal(remove);
            Marshal.FreeHGlobal(install);
            Marshal.FreeHGlobal(content);
            Marshal.FreeHGlobal(instruction);
            Marshal.FreeHGlobal(title);
        }
    }

    internal static void ValidateNativeLayout()
    {
        if (Marshal.SizeOf<TaskDialogButton>() != 12 || Marshal.SizeOf<TaskDialogConfig>() != 160)
            throw new InvalidOperationException("Task Dialog native structure layout is invalid.");
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct TaskDialogButton
    {
        public int Id;
        public IntPtr Text;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct TaskDialogConfig
    {
        public uint Size;
        public IntPtr Parent;
        public IntPtr Instance;
        public uint Flags;
        public uint CommonButtons;
        public IntPtr WindowTitle;
        public IntPtr MainIcon;
        public IntPtr MainInstruction;
        public IntPtr Content;
        public uint ButtonCount;
        public IntPtr Buttons;
        public int DefaultButton;
        public uint RadioButtonCount;
        public IntPtr RadioButtons;
        public int DefaultRadioButton;
        public IntPtr VerificationText;
        public IntPtr ExpandedInformation;
        public IntPtr ExpandedControlText;
        public IntPtr CollapsedControlText;
        public IntPtr FooterIcon;
        public IntPtr Footer;
        public IntPtr Callback;
        public IntPtr CallbackData;
        public uint Width;
    }

    [DllImport("comctl32.dll", ExactSpelling = true)]
    private static extern int TaskDialogIndirect(ref TaskDialogConfig config, out int button, out int radioButton, out int verificationFlagChecked);
}
