$ErrorActionPreference = 'Stop'

function Write-Result([bool] $success, [string] $error = $null, [hashtable] $data = @{}) {
  $result = @{ success = $success }
  if ($error) { $result.error = $error }
  foreach ($entry in $data.GetEnumerator()) { $result[$entry.Key] = $entry.Value }
  $result | ConvertTo-Json -Compress
}

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CodexDesktopNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg;
    public ushort wParamL;
    public ushort wParamH;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT_UNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public INPUT_UNION U;
  }
  public static INPUT KeyboardInput(ushort virtualKey, uint flags) {
    return new INPUT {
      type = 1,
      U = new INPUT_UNION {
        ki = new KEYBDINPUT {
          wVk = virtualKey,
          wScan = 0,
          dwFlags = flags,
          time = 0,
          dwExtraInfo = UIntPtr.Zero
        }
      }
    };
  }
  public static int InputSize() {
    return Marshal.SizeOf(typeof(INPUT));
  }

  public static IntPtr[] EnumerateTopLevelWindows() {
    var windows = new List<IntPtr>();
    EnumWindows((hWnd, lParam) => {
      windows.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }

  public static int GetProcessId(IntPtr hWnd) {
    uint processId;
    GetWindowThreadProcessId(hWnd, out processId);
    return (int)processId;
  }

  public static string GetWindowTitle(IntPtr hWnd) {
    var length = GetWindowTextLength(hWnd);
    if (length <= 0) return string.Empty;
    var text = new StringBuilder(length + 1);
    GetWindowText(hWnd, text, text.Capacity);
    return text.ToString();
  }

  public static string GetWindowClassName(IntPtr hWnd) {
    var text = new StringBuilder(256);
    GetClassName(hWnd, text, text.Capacity);
    return text.ToString();
  }
}
"@

  $inputStream = [Console]::OpenStandardInput()
  $inputBuffer = New-Object byte[] 1048576
  $inputLength = $inputStream.Read($inputBuffer, 0, $inputBuffer.Length)
  $requestText = [Text.Encoding]::UTF8.GetString($inputBuffer, 0, $inputLength)
  $request = $requestText | ConvertFrom-Json

  if ($request.operation -eq 'shortcut-self-test') {
    $actualSize = [CodexDesktopNative]::InputSize()
    $expectedSize = if ([IntPtr]::Size -eq 8) { 40 } else { 28 }
    $success = $actualSize -eq $expectedSize
    $message = if ($success) { $null } else { "Unexpected Win32 INPUT size: $actualSize (expected $expectedSize)." }
    Write-Result $success $message @{
      inputSize = $actualSize
      expectedInputSize = $expectedSize
      pointerSize = [IntPtr]::Size
    }
    exit 0
  }

  function Get-ControlTypeName($current) {
    try {
      $programmaticName = [string]$current.ControlType.ProgrammaticName
      if ($programmaticName) { return $programmaticName }
    } catch {}
    return [string]$current.ControlType
  }

  function Get-RectMetrics($rect) {
    if ($null -eq $rect) {
      return [pscustomobject]@{ Valid = $false; X = 0; Y = 0; Width = 0; Height = 0; Area = 0 }
    }
    try {
      if ([bool]$rect.IsEmpty) {
        return [pscustomobject]@{ Valid = $false; X = 0; Y = 0; Width = 0; Height = 0; Area = 0 }
      }
      $x = [double]$rect.X
      $y = [double]$rect.Y
      $width = [double]$rect.Width
      $height = [double]$rect.Height
      $valid = $width -gt 0 -and $height -gt 0
      return [pscustomobject]@{
        Valid = $valid
        X = $x
        Y = $y
        Width = $width
        Height = $height
        Area = if ($valid) { $width * $height } else { 0 }
      }
    } catch {
      return [pscustomobject]@{ Valid = $false; X = 0; Y = 0; Width = 0; Height = 0; Area = 0 }
    }
  }

  function Get-RectIntersectionArea($first, $second) {
    if ($null -eq $first -or $null -eq $second -or
        -not $first.Valid -or -not $second.Valid) {
      return 0
    }
    $left = [Math]::Max($first.X, $second.X)
    $top = [Math]::Max($first.Y, $second.Y)
    $right = [Math]::Min($first.X + $first.Width, $second.X + $second.Width)
    $bottom = [Math]::Min($first.Y + $first.Height, $second.Y + $second.Height)
    if ($right -le $left -or $bottom -le $top) { return 0 }
    return ($right - $left) * ($bottom - $top)
  }

  function Get-PatternState($element) {
    $state = [ordered]@{
      ValueSupported = $false
      ValueWritable = $false
      TextSupported = $false
    }

    # Self-test fixtures expose deterministic pattern flags without touching UIA.
    $fixturePatterns = $element.PSObject.Properties['TestPatterns']
    if ($fixturePatterns) {
      $patterns = $fixturePatterns.Value
      $state.ValueSupported = [bool]$patterns.ValueSupported
      $state.ValueWritable = $state.ValueSupported -and -not [bool]$patterns.ValueReadOnly
      $state.TextSupported = [bool]$patterns.TextSupported
      return [pscustomobject]$state
    }

    try {
      $valuePattern = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        $state.ValueSupported = $true
        $state.ValueWritable = -not [bool]$valuePattern.Current.IsReadOnly
      }
    } catch {}
    try {
      $textPattern = $null
      $state.TextSupported = $element.TryGetCurrentPattern(
        [System.Windows.Automation.TextPattern]::Pattern,
        [ref]$textPattern)
    } catch {}
    return [pscustomobject]$state
  }

  function Get-ContentSignature([string]$value) {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes([string]$value)
      return [BitConverter]::ToString($sha256.ComputeHash($bytes)).Replace('-', '')
    } finally {
      $sha256.Dispose()
    }
  }

  function Get-ElementTextSignals($element) {
    $current = $null
    try { $current = $element.Current } catch {}
    $nameText = if ($current) { [string]$current.Name } else { '' }
    $helpText = if ($current) { [string]$current.HelpText } else { '' }
    $automationId = if ($current) { [string]$current.AutomationId } else { '' }
    $valueText = $null
    $textText = $null
    $legacyValueText = $null
    $legacyNameText = $null
    $valueSupported = $false
    $textSupported = $false
    $legacySupported = $false

    # Self-test fixtures expose deterministic signals without touching UIA.
    $fixtureText = $element.PSObject.Properties['TestTextValue']
    if ($fixtureText) {
      $valueSupported = $true
      $valueText = [string]$fixtureText.Value
      $textSupported = $true
      $textText = [string]$fixtureText.Value
    } else {
      try {
        $valuePattern = $null
        if ($element.TryGetCurrentPattern(
            [System.Windows.Automation.ValuePattern]::Pattern,
            [ref]$valuePattern)) {
          $valueSupported = $true
          $valueText = [string]$valuePattern.Current.Value
        }
      } catch {}
      try {
        $textPattern = $null
        if ($element.TryGetCurrentPattern(
            [System.Windows.Automation.TextPattern]::Pattern,
            [ref]$textPattern)) {
          $textSupported = $true
          $textText = [string]$textPattern.Current.DocumentRange.GetText(-1)
        }
      } catch {}
      try {
        $legacyPattern = $null
        if ($element.TryGetCurrentPattern(
            [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern,
            [ref]$legacyPattern)) {
          $legacySupported = $true
          $legacyValueText = [string]$legacyPattern.Current.Value
          $legacyNameText = [string]$legacyPattern.Current.Name
        }
      } catch {}
    }

    $labels = @($nameText, $helpText, $automationId) |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      ForEach-Object { ([string]$_).Trim() }
    $isPlaceholder = {
      param([string]$candidate)
      if ([string]::IsNullOrWhiteSpace($candidate)) { return $false }
      $trimmedCandidate = $candidate.Trim()
      foreach ($label in $labels) {
        if ($trimmedCandidate -eq $label) { return $true }
      }
      $false
    }

    $selectedText = $null
    $selectedSource = ''
    $placeholderDetected = $false
    $candidateSources = @(
      [pscustomobject]@{ Source = 'text'; Supported = $textSupported; Text = $textText },
      [pscustomobject]@{ Source = 'value'; Supported = $valueSupported; Text = $valueText },
      [pscustomobject]@{ Source = 'legacy-value'; Supported = $legacySupported; Text = $legacyValueText }
    )
    foreach ($candidate in $candidateSources) {
      if (-not $candidate.Supported) { continue }
      if (&$isPlaceholder ([string]$candidate.Text)) {
        $placeholderDetected = $true
        continue
      }
      $selectedText = [string]$candidate.Text
      $selectedSource = $candidate.Source
      break
    }
    if ($null -eq $selectedText -and ($textSupported -or $valueSupported -or $legacySupported)) {
      $selectedText = ''
      $selectedSource = if ($placeholderDetected) { 'placeholder' } else { 'empty' }
    }

    return [pscustomobject]@{
      Readable = $null -ne $selectedText
      SelectedText = [string]$selectedText
      SelectedSource = $selectedSource
      PlaceholderDetected = $placeholderDetected
      ValuePatternSupported = $valueSupported
      ValuePatternLength = if ($null -eq $valueText) { 0 } else { ([string]$valueText).Length }
      TextPatternSupported = $textSupported
      TextPatternLength = if ($null -eq $textText) { 0 } else { ([string]$textText).Length }
      NameLength = $nameText.Length
      LegacySupported = $legacySupported
      LegacyValueLength = if ($null -eq $legacyValueText) { 0 } else { ([string]$legacyValueText).Length }
      LegacyNameLength = if ($null -eq $legacyNameText) { 0 } else { ([string]$legacyNameText).Length }
    }
  }

  function Get-ElementTextMetrics($element) {
    $signals = Get-ElementTextSignals $element
    if (-not $signals.Readable) {
      return [pscustomobject]@{
        Readable = $false
        HasText = $false
        TrimmedLength = 0
        NonWhitespaceLength = 0
        ContentSignature = $null
      }
    }

    $trimmed = ([string]$signals.SelectedText).Trim()
    $nonWhitespace = [regex]::Replace([string]$signals.SelectedText, '\s', '')
    return [pscustomobject]@{
      Readable = $true
      HasText = $nonWhitespace.Length -gt 0
      TrimmedLength = $trimmed.Length
      NonWhitespaceLength = $nonWhitespace.Length
      ContentSignature = Get-ContentSignature $trimmed
      SelectedSource = $signals.SelectedSource
      PlaceholderDetected = $signals.PlaceholderDetected
      ValuePatternLength = $signals.ValuePatternLength
      TextPatternLength = $signals.TextPatternLength
      NameLength = $signals.NameLength
      LegacyValueLength = $signals.LegacyValueLength
      LegacyNameLength = $signals.LegacyNameLength
    }
  }

  function Get-ElementDescendants($element) {
    $fixtureDescendants = $element.PSObject.Properties['TestDescendants']
    if ($fixtureDescendants) { return @($fixtureDescendants.Value) }
    try {
      return @($element.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition))
    } catch {
      return @()
    }
  }

  function Get-EditorCandidate($element, $windowRecord) {
    try { $current = $element.Current } catch { return $null }
    $controlType = Get-ControlTypeName $current
    if ($controlType -ne 'ControlType.Edit') { return $null }
    if (-not [bool]$current.IsKeyboardFocusable -or
        -not [bool]$current.IsEnabled -or
        [bool]$current.IsOffscreen) {
      return $null
    }

    $rect = Get-RectMetrics $current.BoundingRectangle
    if (-not $rect.Valid) { return $null }
    $windowRect = Get-RectMetrics $windowRecord.UiaRect
    $intersectionArea = Get-RectIntersectionArea $rect $windowRect
    if ($intersectionArea -le 0 -or ($intersectionArea / $rect.Area) -lt 0.5) {
      return $null
    }
    $patterns = Get-PatternState $element
    $className = [string]$current.ClassName
    $score = 100
    if ($windowRecord.NativeVisible) { $score += 50 }
    if ($patterns.ValueWritable) { $score += 20 }
    if ($patterns.TextSupported) { $score += 5 }
    # Keep legacy support, but never make a framework class a hard requirement.
    if ($className -match '(^|\s)ProseMirror(\s|$)') { $score += 1 }

    return [pscustomobject]@{
      Element = $element
      Window = $windowRecord
      WindowVisible = $windowRecord.NativeVisible
      ControlType = $controlType
      ClassName = $className
      Score = $score
      Area = $rect.Area
      WindowArea = $windowRecord.WindowArea
      Rect = $rect
      ValueWritable = $patterns.ValueWritable
      TextSupported = $patterns.TextSupported
    }
  }

  function Get-WindowRecord {
    param(
      [IntPtr]$Handle,
      [int]$ProcessId,
      $Element,
      [bool]$NativeVisible,
      [bool]$NativeMinimized,
      [int]$NativeWidth,
      [int]$NativeHeight
    )

    $uiaEnabled = $false
    $uiaOffscreen = $true
    $uiaType = ''
    $uiaClass = ''
    $uiaFramework = ''
    $uiaNameLength = 0
    $uiaRect = Get-RectMetrics $null
    $descendants = @()
    if ($Element) {
      try {
        $current = $Element.Current
        $uiaEnabled = [bool]$current.IsEnabled
        $uiaOffscreen = [bool]$current.IsOffscreen
        $uiaType = Get-ControlTypeName $current
        $uiaClass = [string]$current.ClassName
        $uiaFramework = [string]$current.FrameworkId
        $uiaNameLength = ([string]$current.Name).Length
        $uiaRect = Get-RectMetrics $current.BoundingRectangle
        $descendants = Get-ElementDescendants $Element
      } catch {}
    }

    $windowArea = [double]$NativeWidth * [double]$NativeHeight
    if ($windowArea -le 0) { $windowArea = $uiaRect.Area }
    $record = [pscustomobject]@{
      Handle = $Handle
      ProcessId = $ProcessId
      Element = $Element
      NativeVisible = $NativeVisible
      NativeMinimized = $NativeMinimized
      NativeWidth = $NativeWidth
      NativeHeight = $NativeHeight
      UiaEnabled = $uiaEnabled
      UiaOffscreen = $uiaOffscreen
      UiaType = $uiaType
      UiaClassName = $uiaClass
      UiaFrameworkId = $uiaFramework
      UiaNameLength = $uiaNameLength
      UiaRect = $uiaRect
      WindowArea = $windowArea
      DescendantCount = $descendants.Count
      EditCount = 0
      EditableValueCount = 0
      DocumentCount = 0
      RootWebAreaCount = 0
      Candidates = @()
    }

    $candidates = @()
    foreach ($descendant in $descendants) {
      try {
        $descendantCurrent = $descendant.Current
        $descendantType = Get-ControlTypeName $descendantCurrent
        if ($descendantType -eq 'ControlType.Edit') {
          $record.EditCount++
        }
        if ($descendantType -eq 'ControlType.Document') { $record.DocumentCount++ }
        if ([string]$descendantCurrent.AutomationId -eq 'RootWebArea') { $record.RootWebAreaCount++ }
        $descendantPatterns = Get-PatternState $descendant
        if ($descendantPatterns.ValueWritable) { $record.EditableValueCount++ }
        if (-not $record.NativeMinimized -and $record.UiaEnabled -and
            -not $record.UiaOffscreen) {
          $candidate = Get-EditorCandidate $descendant $record
          if ($candidate) { $candidates += $candidate }
        }
      } catch {}
    }
    $record.Candidates = @($candidates)
    return $record
  }

  function Get-ChatGPTWindowRecords {
    $processes = @(Get-Process -Name 'ChatGPT', 'codex' -ErrorAction SilentlyContinue |
      Sort-Object -Property Id -Unique)
    $processIds = @{}
    foreach ($process in $processes) { $processIds[[int]$process.Id] = $true }
    $records = @()
    foreach ($handle in @([CodexDesktopNative]::EnumerateTopLevelWindows())) {
      $processId = [CodexDesktopNative]::GetProcessId($handle)
      if (-not $processIds.ContainsKey($processId)) { continue }
      $nativeRect = New-Object CodexDesktopNative+RECT
      $hasRect = [CodexDesktopNative]::GetWindowRect($handle, [ref]$nativeRect)
      $width = if ($hasRect) { $nativeRect.Right - $nativeRect.Left } else { 0 }
      $height = if ($hasRect) { $nativeRect.Bottom - $nativeRect.Top } else { 0 }
      $element = $null
      try { $element = [System.Windows.Automation.AutomationElement]::FromHandle($handle) } catch {}
      $record = Get-WindowRecord `
        -Handle $handle `
        -ProcessId $processId `
        -Element $element `
        -NativeVisible ([CodexDesktopNative]::IsWindowVisible($handle)) `
        -NativeMinimized ([CodexDesktopNative]::IsIconic($handle)) `
        -NativeWidth $width `
        -NativeHeight $height
      $records += $record
    }
    return @($records)
  }

  function Get-SelectionStats($windows) {
    $records = @($windows)
    $selectableWindows = @($records | Where-Object {
      $_.NativeVisible -and -not $_.NativeMinimized -and $_.UiaEnabled -and
      -not $_.UiaOffscreen -and $_.WindowArea -gt 0
    })
    $candidates = @($records | ForEach-Object { $_.Candidates })
    return @{
      windowsChecked = $records.Count
      visibleWindows = $selectableWindows.Count
      editableCandidates = $candidates.Count
      candidateWindows = @($records | Where-Object { @($_.Candidates).Count -gt 0 }).Count
    }
  }

  function Resolve-EditorSelection($windows) {
    $records = @($windows)
    $stats = Get-SelectionStats $records
    $candidates = @($records | ForEach-Object { $_.Candidates })
    if ($candidates.Count -eq 0) {
      return [pscustomobject]@{
        Success = $false
        ErrorCode = 'no-editor'
        Error = "No safe ChatGPT editor found (windows checked: $($stats.windowsChecked); visible windows: $($stats.visibleWindows); editable candidates: $($stats.editableCandidates))."
        Stats = $stats
      }
    }

    $ordered = @($candidates | Sort-Object -Property `
      @{ Expression = 'Score'; Descending = $true },
      @{ Expression = 'Area'; Descending = $true },
      @{ Expression = { $_.Window.WindowArea }; Descending = $true })
    $topScore = $ordered[0].Score
    $top = @($ordered | Where-Object { $_.Score -eq $topScore })
    if ($top.Count -gt 1) {
      $topVisible = @($top | Where-Object { $_.WindowVisible })
      if ($topVisible.Count -eq 0) {
        return [pscustomobject]@{
          Success = $false
          ErrorCode = 'ambiguous-editor'
          Error = "ChatGPT editor selection is ambiguous (windows checked: $($stats.windowsChecked); visible windows: $($stats.visibleWindows); editable candidates: $($stats.editableCandidates))."
          Stats = $stats
        }
      }
      $largest = $top[0]
      $second = $top[1]
      if ($second.Area -le 0 -or $largest.Area -lt ($second.Area * 1.5)) {
        return [pscustomobject]@{
          Success = $false
          ErrorCode = 'ambiguous-editor'
          Error = "ChatGPT editor selection is ambiguous (windows checked: $($stats.windowsChecked); visible windows: $($stats.visibleWindows); editable candidates: $($stats.editableCandidates))."
          Stats = $stats
        }
      }
    }

    return [pscustomobject]@{
      Success = $true
      Candidate = $ordered[0]
      Window = $ordered[0].Window
      Stats = $stats
    }
  }

  function Resolve-WindowSelection($windows, [bool]$RequireEditor) {
    $editorSelection = Resolve-EditorSelection $windows
    if ($editorSelection.Success) { return $editorSelection }
    if ($RequireEditor) { return $editorSelection }

    $stats = $editorSelection.Stats
    $visible = @($windows | Where-Object {
      $_.NativeVisible -and -not $_.NativeMinimized -and $_.UiaEnabled -and
      -not $_.UiaOffscreen -and $_.WindowArea -gt 0
    })
    if ($visible.Count -eq 0) {
      return [pscustomobject]@{
        Success = $false
        ErrorCode = 'no-window'
        Error = "No visible ChatGPT window found (windows checked: $($stats.windowsChecked); visible windows: 0; editable candidates: $($stats.editableCandidates))."
        Stats = $stats
      }
    }
    $ordered = @($visible | Sort-Object -Property @{ Expression = 'WindowArea'; Descending = $true })
    $largestArea = $ordered[0].WindowArea
    $largest = @($ordered | Where-Object { $_.WindowArea -eq $largestArea })
    if ($largest.Count -gt 1) {
      return [pscustomobject]@{
        Success = $false
        ErrorCode = 'ambiguous-window'
        Error = "ChatGPT window selection is ambiguous (windows checked: $($stats.windowsChecked); visible windows: $($stats.visibleWindows); editable candidates: $($stats.editableCandidates))."
        Stats = $stats
      }
    }
    return [pscustomobject]@{ Success = $true; Window = $largest[0]; Stats = $stats }
  }

  function New-TestElement {
    param(
      [string]$ControlType = 'ControlType.Edit',
      [string]$ClassName = 'GenericEditor',
      [string]$Name = '',
      [string]$HelpText = '',
      [bool]$Enabled = $true,
      [bool]$Focusable = $true,
      [bool]$Offscreen = $false,
      [double]$X = 0,
      [double]$Y = 0,
      [double]$Width = 800,
      [double]$Height = 50,
      [bool]$ValueSupported = $true,
      [bool]$ValueReadOnly = $false,
      [bool]$TextSupported = $true,
      [AllowNull()][string]$TextValue = $null
    )
    return [pscustomobject]@{
      Current = [pscustomobject]@{
        ControlType = $ControlType
        ClassName = $ClassName
        Name = $Name
        HelpText = $HelpText
        AutomationId = ''
        IsKeyboardFocusable = $Focusable
        IsEnabled = $Enabled
        IsOffscreen = $Offscreen
        BoundingRectangle = [pscustomobject]@{ IsEmpty = $false; X = $X; Y = $Y; Width = $Width; Height = $Height }
      }
      TestPatterns = @{
        ValueSupported = $ValueSupported
        ValueReadOnly = $ValueReadOnly
        TextSupported = $TextSupported
      }
      TestTextValue = $TextValue
    }
  }

  function New-TestWindowRecord {
    param(
      [string]$Id,
      [bool]$Visible = $true,
      [bool]$Minimized = $false,
      [bool]$Enabled = $true,
      [int]$Width = 1200,
      [int]$Height = 800,
      [object[]]$Elements = @()
    )
    $record = [pscustomobject]@{
      Handle = $Id
      ProcessId = 1
      Element = $null
      NativeVisible = $Visible
      NativeMinimized = $Minimized
      NativeWidth = $Width
      NativeHeight = $Height
      UiaEnabled = $Enabled
      UiaOffscreen = $false
      UiaType = 'ControlType.Window'
      UiaClassName = ''
      UiaFrameworkId = 'Chrome'
      UiaNameLength = 0
      UiaRect = [pscustomobject]@{ Valid = $true; X = 0; Y = 0; Width = $Width; Height = $Height; Area = $Width * $Height }
      WindowArea = $Width * $Height
      DescendantCount = @($Elements).Count
      EditCount = 0
      EditableValueCount = 0
      DocumentCount = 1
      RootWebAreaCount = 1
      Candidates = @()
    }
    $candidates = @()
    foreach ($element in @($Elements)) {
      $candidate = Get-EditorCandidate $element $record
      if ($candidate) { $candidates += $candidate }
    }
    $record.Candidates = @($candidates)
    $record.EditCount = @($Elements | Where-Object { (Get-ControlTypeName $_.Current) -eq 'ControlType.Edit' }).Count
    return $record
  }

  function Invoke-EditorSelectorSelfTest {
    $results = @()
    $old = New-TestWindowRecord -Id 'old-prosemirror' -Elements @(
      (New-TestElement -ClassName 'ProseMirror' -ValueSupported $true -ValueReadOnly $false))
    $oldResult = Resolve-EditorSelection @($old)
    $results += [pscustomobject]@{ Name = 'legacy-prosemirror'; Passed = $oldResult.Success }

    $generic = New-TestWindowRecord -Id 'generic-edit' -Elements @(
      (New-TestElement -ClassName 'RichEditor' -ValueSupported $true -ValueReadOnly $false -TextSupported $false))
    $genericResult = Resolve-EditorSelection @($generic)
    $results += [pscustomobject]@{ Name = 'generic-edit-without-version'; Passed = $genericResult.Success }

    $mini = New-TestWindowRecord -Id 'mini-surface' -Width 900 -Height 105 -Elements @()
    $full = New-TestWindowRecord -Id 'full-window' -Width 1720 -Height 1076 -Elements @(
      (New-TestElement -ClassName 'CurrentFrameworkClass' -ValueSupported $true -ValueReadOnly $false))
    $multiResult = Resolve-EditorSelection @($mini, $full)
    $results += [pscustomobject]@{
      Name = 'multi-window-mini-plus-full'
      Passed = $multiResult.Success -and $multiResult.Window.Handle -eq 'full-window'
    }

    $visibleMini = New-TestWindowRecord -Id 'visible-mini' -Visible $true -Width 900 -Height 105 -Elements @()
    $hiddenFull = New-TestWindowRecord -Id 'hidden-full' -Visible $false -Width 1720 -Height 1076 -Elements @(
      (New-TestElement -ClassName 'CurrentFrameworkClass' -ValueSupported $true -ValueReadOnly $false))
    $hiddenResult = Resolve-EditorSelection @($visibleMini, $hiddenFull)
    $results += [pscustomobject]@{
      Name = 'visible-mini-plus-hidden-full'
      Passed = $hiddenResult.Success -and $hiddenResult.Window.Handle -eq 'hidden-full'
    }

    $ambiguous = New-TestWindowRecord -Id 'ambiguous' -Visible $false -Elements @(
      (New-TestElement -ClassName 'EditorA' -Width 800 -Height 50 -ValueSupported $true -ValueReadOnly $false),
      (New-TestElement -ClassName 'EditorB' -Width 800 -Height 50 -ValueSupported $true -ValueReadOnly $false))
    $ambiguousResult = Resolve-EditorSelection @($ambiguous)
    $results += [pscustomobject]@{
      Name = 'dangerous-tie-rejected'
      Passed = -not $ambiguousResult.Success -and $ambiguousResult.ErrorCode -eq 'ambiguous-editor'
    }

    $unsafe = New-TestWindowRecord -Id 'unsafe' -Elements @(
      (New-TestElement -ClassName 'DisabledEdit' -Enabled $false),
      (New-TestElement -ClassName 'OffscreenEdit' -Offscreen $true),
      (New-TestElement -ClassName 'NotFocusableEdit' -Focusable $false),
      (New-TestElement -ClassName 'OutsideWindowEdit' -X 2000 -Y 2000))
    $unsafeResult = Resolve-EditorSelection @($unsafe)
    $results += [pscustomobject]@{
      Name = 'unsafe-candidates-rejected'
      Passed = -not $unsafeResult.Success -and $unsafeResult.ErrorCode -eq 'no-editor'
    }

    $sameLengthA = Get-ElementTextMetrics (New-TestElement -TextValue 'A')
    $sameLengthB = Get-ElementTextMetrics (New-TestElement -TextValue 'B')
    $sameLengthStablePolls = 0
    $previousSignature = $null
    foreach ($signature in @($sameLengthA.ContentSignature, $sameLengthB.ContentSignature, $sameLengthB.ContentSignature)) {
      if ($signature -eq $previousSignature) { $sameLengthStablePolls++ } else { $sameLengthStablePolls = 0 }
      $previousSignature = $signature
    }
    $results += [pscustomobject]@{
      Name = 'same-length-content-change-detected'
      Passed = $sameLengthA.TrimmedLength -eq $sameLengthB.TrimmedLength -and
        $sameLengthA.ContentSignature -ne $sameLengthB.ContentSignature -and
        $sameLengthStablePolls -eq 1
    }

    $placeholder = Get-ElementTextMetrics (New-TestElement -Name 'Type here' -TextValue 'Type here')
    $results += [pscustomobject]@{
      Name = 'placeholder-is-empty'
      Passed = $placeholder.Readable -and -not $placeholder.HasText -and
        $placeholder.TrimmedLength -eq 0 -and $placeholder.PlaceholderDetected
    }

    $failed = @($results | Where-Object { -not $_.Passed })
    $allPassed = $failed.Count -eq 0
    $message = if ($allPassed) { $null } else { 'Editor selector self-test failed.' }
    Write-Result $allPassed $message @{
      selectorTests = @($results)
      testCount = $results.Count
      failedCount = $failed.Count
    }
  }

  if ($request.operation -eq 'editor-selector-self-test') {
    Invoke-EditorSelectorSelfTest
    exit 0
  }

  $windows = Get-ChatGPTWindowRecords
  $requiresEditor = $request.operation -in @('focus-input', 'submit-input', 'send', 'input-state', 'wait-for-input')
  $selection = Resolve-WindowSelection $windows $requiresEditor
  if (-not $selection.Success) {
    Write-Result $false $selection.Error $selection.Stats
    exit 0
  }

  $windowRecord = $selection.Window
  $window = $windowRecord.Element
  $editor = if ($selection.Candidate) { $selection.Candidate.Element } else { $null }
  $selectionStats = $selection.Stats

  if ($request.operation -eq 'input-state') {
    if (-not $editor) {
      Write-Result $false "No safe ChatGPT editor found (windows checked: $($selectionStats.windowsChecked); visible windows: $($selectionStats.visibleWindows); editable candidates: $($selectionStats.editableCandidates))." $selectionStats
      exit 0
    }
    $metrics = Get-ElementTextMetrics $editor
    if (-not $metrics.Readable) {
      Write-Result $false "ChatGPT editor text state could not be read (windows checked: $($selectionStats.windowsChecked); visible windows: $($selectionStats.visibleWindows); editable candidates: $($selectionStats.editableCandidates))." $selectionStats
      exit 0
    }
    Write-Result $true $null @{
      action = 'input-state'
      hasText = $metrics.HasText
      trimmedLength = $metrics.TrimmedLength
      nonWhitespaceLength = $metrics.NonWhitespaceLength
      placeholderDetected = $metrics.PlaceholderDetected
      valuePatternLength = $metrics.ValuePatternLength
      textPatternLength = $metrics.TextPatternLength
      nameLength = $metrics.NameLength
      legacyValueLength = $metrics.LegacyValueLength
      legacyNameLength = $metrics.LegacyNameLength
      windowsChecked = $selectionStats.windowsChecked
      visibleWindows = $selectionStats.visibleWindows
      editableCandidates = $selectionStats.editableCandidates
    }
    exit 0
  }

  if ($request.operation -eq 'wait-for-input') {
    if (-not $editor) {
      Write-Result $false "No safe ChatGPT editor found (windows checked: $($selectionStats.windowsChecked); visible windows: $($selectionStats.visibleWindows); editable candidates: $($selectionStats.editableCandidates))." $selectionStats
      exit 0
    }

    $timeoutMs = 15000
    $pollMs = 120
    $stableMs = 450
    try { if ($null -ne $request.timeoutMs) { $timeoutMs = [Math]::Min(30000, [Math]::Max(1, [int]$request.timeoutMs)) } } catch {}
    try { if ($null -ne $request.pollMs) { $pollMs = [Math]::Min(1000, [Math]::Max(10, [int]$request.pollMs)) } } catch {}
    try { if ($null -ne $request.stableMs) { $stableMs = [Math]::Min(5000, [Math]::Max(0, [int]$request.stableMs)) } } catch {}

    $startedAt = [DateTime]::UtcNow
    $stableAt = $null
    $lastSignature = $null
    $pollCount = 0
    while ($true) {
      $pollCount++
      $metrics = Get-ElementTextMetrics $editor
      if (-not $metrics.Readable) {
        Write-Result $false "ChatGPT editor text state could not be read while waiting (windows checked: $($selectionStats.windowsChecked); visible windows: $($selectionStats.visibleWindows); editable candidates: $($selectionStats.editableCandidates))." $selectionStats
        exit 0
      }

      $elapsedMs = ([DateTime]::UtcNow - $startedAt).TotalMilliseconds
      if ($metrics.HasText) {
        $signature = $metrics.ContentSignature
        if ($signature -ne $lastSignature) {
          $lastSignature = $signature
          $stableAt = [DateTime]::UtcNow
        } elseif ($stableAt -and (([DateTime]::UtcNow - $stableAt).TotalMilliseconds -ge $stableMs)) {
          Write-Result $true $null @{
            action = 'wait-for-input'
            hasText = $true
            trimmedLength = $metrics.TrimmedLength
            nonWhitespaceLength = $metrics.NonWhitespaceLength
            polls = $pollCount
            elapsedMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
            windowsChecked = $selectionStats.windowsChecked
            visibleWindows = $selectionStats.visibleWindows
            editableCandidates = $selectionStats.editableCandidates
          }
          exit 0
        }
      } else {
        $lastSignature = $null
        $stableAt = $null
      }

      if ($elapsedMs -ge $timeoutMs) {
        Write-Result $false "ChatGPT editor text did not become stable before timeout (windows checked: $($selectionStats.windowsChecked); visible windows: $($selectionStats.visibleWindows); editable candidates: $($selectionStats.editableCandidates))." $selectionStats
        exit 0
      }
      Start-Sleep -Milliseconds $pollMs
    }
  }

  [CodexDesktopNative]::ShowWindowAsync([IntPtr]$window.Current.NativeWindowHandle, 9) | Out-Null
  [CodexDesktopNative]::SetForegroundWindow([IntPtr]$window.Current.NativeWindowHandle) | Out-Null

  if ($request.operation -eq 'probe') {
    Write-Result $true $null @{
      window = 'selected'
      windowsChecked = $selectionStats.windowsChecked
      visibleWindows = $selectionStats.visibleWindows
      editableCandidates = $selectionStats.editableCandidates
    }
    exit 0
  }

  if ($request.operation -eq 'new-task') {
    [System.Windows.Forms.SendKeys]::SendWait('^n')
    Write-Result $true $null @{ action = 'new-task-shortcut'; shortcut = 'Ctrl+N' }
    exit 0
  }

  if ($request.operation -eq 'shortcut') {
    $modifierCodes = @{
      Ctrl = [uint16]0x11
      Alt = [uint16]0x12
      Shift = [uint16]0x10
      Win = [uint16]0x5B
    }
    $namedKeyCodes = @{
      Space = [uint16]0x20
      Enter = [uint16]0x0D
      Tab = [uint16]0x09
      Escape = [uint16]0x1B
      Backspace = [uint16]0x08
      Delete = [uint16]0x2E
      Insert = [uint16]0x2D
      Home = [uint16]0x24
      End = [uint16]0x23
      PageUp = [uint16]0x21
      PageDown = [uint16]0x22
      Left = [uint16]0x25
      Up = [uint16]0x26
      Right = [uint16]0x27
      Down = [uint16]0x28
      PrintScreen = [uint16]0x2C
      Pause = [uint16]0x13
      CapsLock = [uint16]0x14
      NumLock = [uint16]0x90
      ScrollLock = [uint16]0x91
    }
    $modifierVirtualKeys = @()
    foreach ($modifier in @($request.modifiers)) {
      if (-not $modifierCodes.ContainsKey([string]$modifier)) {
        Write-Result $false "Unsupported voice shortcut modifier: $modifier"
        exit 0
      }
      $modifierVirtualKeys += $modifierCodes[[string]$modifier]
    }
    $keyToken = [string]$request.key
    $keyVirtualCode = $null
    if ($namedKeyCodes.ContainsKey($keyToken)) {
      $keyVirtualCode = $namedKeyCodes[$keyToken]
    } elseif ($keyToken -match '^F([1-9]|1[0-9]|2[0-4])$') {
      $keyVirtualCode = [uint16](0x6F + [int]$Matches[1])
    } elseif ($keyToken.Length -eq 1 -and $keyToken -ne '+') {
      $scanCode = [CodexDesktopNative]::VkKeyScan([char]$keyToken[0])
      if ($scanCode -eq -1) {
        Write-Result $false "Unsupported voice shortcut key: $keyToken"
        exit 0
      }
      $keyVirtualCode = [uint16]($scanCode -band 0xFF)
    } else {
      Write-Result $false "Unsupported voice shortcut key: $keyToken"
      exit 0
    }

    $inputCount = ($modifierVirtualKeys.Count + 1) * 2
    $inputs = [CodexDesktopNative+INPUT[]]::new($inputCount)
    $inputIndex = 0
    foreach ($virtualKey in $modifierVirtualKeys) {
      $inputs[$inputIndex] = [CodexDesktopNative]::KeyboardInput($virtualKey, 0)
      $inputIndex++
    }
    $inputs[$inputIndex] = [CodexDesktopNative]::KeyboardInput($keyVirtualCode, 0)
    $inputIndex++
    $inputs[$inputIndex] = [CodexDesktopNative]::KeyboardInput($keyVirtualCode, 2)
    $inputIndex++
    for ($modifierIndex = $modifierVirtualKeys.Count - 1; $modifierIndex -ge 0; $modifierIndex--) {
      $inputs[$inputIndex] = [CodexDesktopNative]::KeyboardInput($modifierVirtualKeys[$modifierIndex], 2)
      $inputIndex++
    }
    $sent = [CodexDesktopNative]::SendInput($inputCount, $inputs, [CodexDesktopNative]::InputSize())
    if ($sent -ne $inputCount) {
      Write-Result $false "Windows key injection failed for shortcut $($request.shortcut)."
      exit 0
    }
    Write-Result $true $null @{ action = 'shortcut'; shortcut = [string]$request.shortcut }
    exit 0
  }

  $descendants = Get-ElementDescendants $window

  if ($request.operation -eq 'focus-input' -or $request.operation -eq 'submit-input') {
    if (-not $editor) {
      Write-Result $false "No safe ChatGPT editor found (windows checked: $($selectionStats.windowsChecked); visible windows: $($selectionStats.visibleWindows); editable candidates: $($selectionStats.editableCandidates))." $selectionStats
      exit 0
    }

    $editor.SetFocus()
    Start-Sleep -Milliseconds 120
    if ($request.operation -eq 'submit-input') {
      [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      Write-Result $true $null @{
        action = $request.operation
        window = 'selected'
        windowsChecked = $selectionStats.windowsChecked
        visibleWindows = $selectionStats.visibleWindows
        editableCandidates = $selectionStats.editableCandidates
      }
      exit 0
    }
    $metrics = Get-ElementTextMetrics $editor
    if (-not $metrics.Readable) {
      Write-Result $false "ChatGPT editor text state could not be read (windows checked: $($selectionStats.windowsChecked); visible windows: $($selectionStats.visibleWindows); editable candidates: $($selectionStats.editableCandidates))." $selectionStats
      exit 0
    }
    Write-Result $true $null @{
      action = $request.operation
      window = 'selected'
      hasText = $metrics.HasText
      trimmedLength = $metrics.TrimmedLength
      nonWhitespaceLength = $metrics.NonWhitespaceLength
      placeholderDetected = $metrics.PlaceholderDetected
      valuePatternLength = $metrics.ValuePatternLength
      textPatternLength = $metrics.TextPatternLength
      nameLength = $metrics.NameLength
      legacyValueLength = $metrics.LegacyValueLength
      legacyNameLength = $metrics.LegacyNameLength
      windowsChecked = $selectionStats.windowsChecked
      visibleWindows = $selectionStats.visibleWindows
      editableCandidates = $selectionStats.editableCandidates
    }
    exit 0
  }

  if ($request.operation -eq 'send') {
    if (-not $editor) {
      Write-Result $false "No safe ChatGPT editor found (windows checked: $($selectionStats.windowsChecked); visible windows: $($selectionStats.visibleWindows); editable candidates: $($selectionStats.editableCandidates))." $selectionStats
      exit 0
    }

    $editor.SetFocus()
    Set-Clipboard -Value ([string]$request.text)
    Start-Sleep -Milliseconds 80
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 80
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Write-Result $true $null @{
      action = 'send'
      window = 'selected'
      windowsChecked = $selectionStats.windowsChecked
      visibleWindows = $selectionStats.visibleWindows
      editableCandidates = $selectionStats.editableCandidates
    }
    exit 0
  }

  if ($request.operation -eq 'stop') {
    $stopButton = $null
    foreach ($element in $descendants) {
      if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
          $element.Current.Name -match 'Stop|\u505c\u6b62' -and
          $element.Current.IsEnabled -and
          -not $element.Current.IsOffscreen) {
        $stopButton = $element
        break
      }
    }
    if ($stopButton) {
      $invoke = $null
      if ($stopButton.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        $invoke.Invoke()
        Write-Result $true $null @{ action = 'stop-button' }
        exit 0
      }
    }

    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
    Write-Result $true $null @{ action = 'escape-fallback' }
    exit 0
  }

  Write-Result $false "Unsupported Desktop operation: $($request.operation)"
} catch {
  Write-Result $false $_.Exception.Message
}
