param(
    [string]$CodexExecutable,
    [switch]$CheckOnly,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Help) {
    Write-Host @'
Codex Windows inspector launcher
Usage: start-codex-with-inspector.ps1 [-CodexExecutable <path>] [-CheckOnly] [-Help]
Starts Codex with --inspect=127.0.0.1:9229 after checking processes and port availability.
-CheckOnly displays state without starting Codex.
'@
    return
}

if (-not $CodexExecutable) {
    $packages = @(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending)
    if ($packages.Count -eq 0) { throw 'Codex installation not found. Use -CodexExecutable with its ChatGPT.exe path.' }
    $CodexExecutable = Join-Path $packages[0].InstallLocation 'app\ChatGPT.exe'
}
$CodexExecutable = (Resolve-Path -LiteralPath $CodexExecutable).Path
if ([IO.Path]::GetFileName($CodexExecutable) -ne 'ChatGPT.exe') {
    throw 'Select the Codex app ChatGPT.exe, not the codex CLI.'
}
$running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -eq $CodexExecutable -and $_.CommandLine -notmatch '--type='
})
$listeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
    Where-Object Port -eq 9229)

if ($CheckOnly) {
    [PSCustomObject]@{
        Executable = $CodexExecutable
        Arguments = '--inspect=127.0.0.1:9229'
        RunningMainProcesses = $running.Count
        PortInUse = ($listeners.Count -gt 0)
    }
    return
}
if ($running.Count -gt 0) { throw 'Exit Codex completely first, then run this launcher again. No process was stopped.' }
if ($listeners.Count -gt 0) { throw 'Port 9229 is already in use. No application was started.' }

# The user invokes this launcher to open the application interactively.
Start-Process -FilePath $CodexExecutable -ArgumentList '--inspect=127.0.0.1:9229' | Out-Null
Write-Host 'Codex started. Checking its local inspector...'
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $targets = @(Invoke-RestMethod -Uri 'http://127.0.0.1:9229/json/list' -TimeoutSec 1)
        if (@($targets | Where-Object {
            $_.type -eq 'node' -and $_.webSocketDebuggerUrl -match '^ws://127\.0\.0\.1:9229/[\w-]+$'
        }).Count -gt 0) {
            Write-Host 'Local inspector is ready. Start Codex Remote to connect.'
            return
        }
    } catch { }
}
throw 'This Codex build did not expose its startup inspector. The bridge will report it unavailable; no runtime activation was attempted.'
