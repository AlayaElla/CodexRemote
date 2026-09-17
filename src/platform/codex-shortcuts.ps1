[CmdletBinding()]
param([ValidateSet('EscapeCancel', 'EscapeStop', 'ReadTaskLink', 'PasteText')][string]$Shortcut, [string]$TargetBase64, [switch]$Server)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class CodexShortcutNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public UInt32 type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public Int32 dx; public Int32 dy; public UInt32 mouseData; public UInt32 dwFlags; public UInt32 time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public UInt16 wVk; public UInt16 wScan; public UInt32 dwFlags; public UInt32 time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT { public UInt32 uMsg; public UInt16 wParamL; public UInt16 wParamH; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern UInt32 GetWindowThreadProcessId(IntPtr hWnd, out UInt32 processId);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(Int32 vKey);
  [DllImport("user32.dll")] public static extern UInt32 GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, Int32 command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern UInt32 SendInput(UInt32 count, INPUT[] inputs, Int32 size);

  public static INPUT KeyInput(UInt16 key, bool up) {
    var input = new INPUT();
    input.type = 1;
    input.U.ki.wVk = key;
    input.U.ki.dwFlags = up ? 2u : 0u;
    return input;
  }
}
'@

function New-KeyInput([UInt16]$key, [bool]$up) {
  # Nested value-type field assignments in PowerShell modify boxed copies.
  # Construct the union in C# so SendInput receives the actual key and flags.
  return [CodexShortcutNative]::KeyInput($key, $up)
}

function Release-Keys([UInt16[]]$keys, [int]$inputSize) {
  if ($keys.Count -eq 0) { return }
  $inputs = @($keys | ForEach-Object { New-KeyInput $_ $true })
  [void][CodexShortcutNative]::SendInput([uint32]$inputs.Count, $inputs, $inputSize)
}


function Assert-Foreground([IntPtr]$Window) {
  if ([CodexShortcutNative]::GetForegroundWindow() -ne $Window -or [CodexShortcutNative]::IsIconic($Window)) {
    throw 'Codex lost foreground focus; no keys were sent.'
  }
}
function Send-Keys([IntPtr]$Window, [UInt16[]]$Keys) {
  Assert-Foreground $Window
  foreach ($key in @($Keys) + @(0x10, 0x11, 0x12, 0x5B, 0x5C)) {
    if (([CodexShortcutNative]::GetAsyncKeyState($key) -band 0x8000) -ne 0) { throw 'Release held keyboard keys before continuing.' }
  }
  $size = [Runtime.InteropServices.Marshal]::SizeOf([type]'CodexShortcutNative+INPUT')
  if ($size -ne 40) { throw 'Windows INPUT layout is unsupported.' }
  $inputs = @($Keys | ForEach-Object { New-KeyInput $_ $false })
  for ($i = $Keys.Count - 1; $i -ge 0; $i--) { $inputs += New-KeyInput $Keys[$i] $true }
  Assert-Foreground $Window
  $sent = [CodexShortcutNative]::SendInput([uint32]$inputs.Count, $inputs, $size)
  if ($sent -ne $inputs.Count) {
    Release-Keys $Keys $size
    throw 'Windows rejected keyboard delivery.'
  }
}
function Invoke-CodexShortcut([string]$Action, [string]$TargetBase64) {
  if ($Action -notin @('EscapeCancel', 'EscapeStop', 'ReadTaskLink', 'PasteText')) { throw 'Unsupported keyboard action.' }
  $package = $script:CodexPackage
  if (-not $package) { $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop | Select-Object -First 1; $script:CodexPackage = $package }
  if (-not $package -or -not $package.InstallLocation) { throw 'Codex application package is unavailable.' }
  $expected = @('ChatGPT.exe', 'Codex.exe') | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $package.InstallLocation ('app\' + $_))) }
  $candidates = @(Get-Process -Name 'ChatGPT','Codex' -ErrorAction SilentlyContinue | Where-Object {
    if ($_.MainWindowHandle -eq 0 -or -not $_.Path) { return $false }
    $candidatePath = [IO.Path]::GetFullPath([string]$_.Path)
    return @($expected | Where-Object { $_.Equals($candidatePath, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
  })
  if ($candidates.Count -eq 0) { $script:CodexPackage = $null }
  $foreground = [CodexShortcutNative]::GetForegroundWindow()
  $process = @($candidates | Where-Object { $_.MainWindowHandle -eq $foreground })
  if ($process.Count -eq 0 -and $candidates.Count -eq 1) { $process = $candidates }
  if ($process.Count -ne 1) { throw 'Codex main window is unavailable or ambiguous.' }
  $window = [IntPtr]$process[0].MainWindowHandle
  if ($Action -in @('EscapeCancel', 'EscapeStop')) {
    if ([CodexShortcutNative]::IsIconic($window)) { [void][CodexShortcutNative]::ShowWindow($window, 9) }
    if ($foreground -ne $window) { [void][CodexShortcutNative]::SetForegroundWindow($window) }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ([CodexShortcutNative]::GetForegroundWindow() -ne $window) {
      if ($watch.ElapsedMilliseconds -ge 1000) { throw 'Codex could not be activated.' }
      Start-Sleep -Milliseconds 20
    }
    $count = if ($Action -eq 'EscapeStop') { 2 } else { 1 }
    for ($i = 0; $i -lt $count; $i++) {
      Send-Keys $window @(0x1B)
      if ($i + 1 -lt $count) { Start-Sleep -Milliseconds 100 }
    }
    return @{ success = $true; delivery = 'submitted_to_keyboard' }
  }
  Assert-Foreground $window
  if ($Action -eq 'ReadTaskLink') {
    return & (Join-Path $PSScriptRoot 'codex-micro-draft-link.ps1') -Window $window -TargetBase64 $TargetBase64
  }
  $target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TargetBase64)) | ConvertFrom-Json
  if (-not $target.text -or $target.text.Length -gt 32768 -or (-not $target.taskId -and -not $target.draftToken)) { throw 'Text or task identity is invalid.' }
  if ($target.taskId) {
    $linkRequest = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{ candidates = @($target.taskId) } | ConvertTo-Json -Compress)))
    $link = & (Join-Path $PSScriptRoot 'codex-micro-draft-link.ps1') -Window $window -TargetBase64 $linkRequest
    if (-not $link.success -or $link.threadId -ne $target.taskId) { throw 'The foreground task does not match the text target.' }
    Send-Keys $window @(0x11, 0x10, 0x4C)
    Start-Sleep -Milliseconds 150
  }
  Assert-Foreground $window
  $original = [Windows.Forms.Clipboard]::GetDataObject()
  $saved = [Windows.Forms.DataObject]::new()
  if ($null -ne $original) {
    foreach ($format in $original.GetFormats($false)) { $saved.SetData($format, $false, $original.GetData($format, $false)) }
  }
  $sequence = [CodexShortcutNative]::GetClipboardSequenceNumber()
  $writtenSequence = $null
  try {
    Assert-Foreground $window
    if ([CodexShortcutNative]::GetClipboardSequenceNumber() -ne $sequence) { throw 'Clipboard changed before text insertion.' }
    [Windows.Forms.Clipboard]::SetText([string]$target.text)
    $writtenSequence = [CodexShortcutNative]::GetClipboardSequenceNumber()
    Send-Keys $window @(0x11, 0x56)
    Start-Sleep -Milliseconds 150
    Assert-Foreground $window
    return @{ success = $true; delivery = 'submitted_to_keyboard' }
  } finally {
    if ($null -ne $writtenSequence -and [CodexShortcutNative]::GetClipboardSequenceNumber() -eq $writtenSequence) {
      if ($null -ne $original) { [Windows.Forms.Clipboard]::SetDataObject($saved, $true) }
      else { [Windows.Forms.Clipboard]::Clear() }
    }
  }
}
Add-Type -AssemblyName System.Windows.Forms
if ($Server) {
  [Console]::WriteLine('{"ready":true}')
  while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $null
    try {
      if ($line.Length -gt 270000) { throw 'Keyboard request exceeds the size limit.' }
      $request = $line | ConvertFrom-Json
      if (-not $request.id -or -not $request.target) { throw 'Invalid keyboard request.' }
      $result = Invoke-CodexShortcut $request.action $request.target
      [Console]::WriteLine((@{ id = $request.id; result = $result } | ConvertTo-Json -Compress -Depth 5))
    } catch {
      [Console]::WriteLine((@{ id = $request.id; result = @{ success = $false; error = [string]$_.Exception.Message } } | ConvertTo-Json -Compress -Depth 5))
    }
  }
} else {
  try {
    Invoke-CodexShortcut $Shortcut $TargetBase64 | ConvertTo-Json -Compress -Depth 5
  } catch {
    @{ success = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
  }
}
