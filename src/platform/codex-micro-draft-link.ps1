[CmdletBinding()]
param([IntPtr]$Window, [string]$TargetBase64)
$ErrorActionPreference = 'Stop'
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TargetBase64)) | ConvertFrom-Json
if (-not $target.candidates) { throw 'New task candidates are missing.' }
function Assert-Window {
  if ([CodexShortcutNative]::GetForegroundWindow() -ne $Window -or [CodexShortcutNative]::IsIconic($Window)) {
    throw 'Keep the newly submitted task in the foreground until it synchronizes.'
  }
}
Assert-Window
$original = [Windows.Forms.Clipboard]::GetDataObject()
$saved = [Windows.Forms.DataObject]::new()
if ($null -ne $original) {
  foreach ($format in $original.GetFormats($false)) { $saved.SetData($format, $false, $original.GetData($format, $false)) }
}
$sequence = [CodexShortcutNative]::GetClipboardSequenceNumber()
$copiedSequence = $null
$held = New-Object 'System.Collections.Generic.HashSet[UInt16]'
$size = [Runtime.InteropServices.Marshal]::SizeOf([type]'CodexShortcutNative+INPUT')
try {
  foreach ($key in @(0x10, 0x11, 0x12, 0x5B, 0x5C, 0x4C)) {
    if (([CodexShortcutNative]::GetAsyncKeyState($key) -band 0x8000) -ne 0) { throw 'Release the keyboard before task synchronization.' }
  }
  Assert-Window
  if ([CodexShortcutNative]::GetClipboardSequenceNumber() -ne $sequence) { throw 'Clipboard changed before task synchronization.' }
  $inputs = @([CodexShortcutNative]::KeyInput(0x11, $false), [CodexShortcutNative]::KeyInput(0x12, $false),
    [CodexShortcutNative]::KeyInput(0x4C, $false), [CodexShortcutNative]::KeyInput(0x4C, $true),
    [CodexShortcutNative]::KeyInput(0x12, $true), [CodexShortcutNative]::KeyInput(0x11, $true))
  $sent = [CodexShortcutNative]::SendInput(6, $inputs, $size)
  for ($i = 0; $i -lt $sent; $i++) {
    $key = $inputs[$i].U.ki
    if (($key.dwFlags -band 2) -ne 0) { [void]$held.Remove($key.wVk) } else { [void]$held.Add($key.wVk) }
  }
  if ($sent -ne 6) { throw 'Task link keyboard delivery failed.' }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  do {
    Assert-Window
    $current = [CodexShortcutNative]::GetClipboardSequenceNumber()
    if ($current -ne $sequence) {
      $link = [Windows.Forms.Clipboard]::GetText()
      if ($link -match '^codex://threads/([0-9a-fA-F-]{36})$') {
        $copiedSequence = $current
        if ($target.candidates -contains $Matches[1]) { return @{ success = $true; threadId = $Matches[1] } }
      }
      throw 'The foreground page is not a candidate for the newly submitted task.'
    }
    Start-Sleep -Milliseconds 60
  } while ($watch.ElapsedMilliseconds -lt 1800)
  return @{ success = $true; pending = $true }
} finally {
  foreach ($key in $held) { [void][CodexShortcutNative]::SendInput(1, @([CodexShortcutNative]::KeyInput($key, $true)), $size) }
  if ($null -ne $copiedSequence -and [CodexShortcutNative]::GetClipboardSequenceNumber() -eq $copiedSequence) {
    if ($null -ne $original) { [Windows.Forms.Clipboard]::SetDataObject($saved, $true) }
    else { [Windows.Forms.Clipboard]::Clear() }
  }
}
