param([string]$MsBuildPath)
$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot '..\CodexRemoteVirtualMicro.vcxproj'
if (-not $MsBuildPath) {
    $locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $locator) {
        # WDK 28000 ships the package verifier for x64/ARM64 hosts, not x86.
        $MsBuildPath = & $locator -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\Current\Bin\amd64\MSBuild.exe' | Select-Object -First 1
    }
}
if (-not $MsBuildPath) {
    $buildCommand = Get-Command msbuild.exe -ErrorAction SilentlyContinue
    if ($buildCommand) { $MsBuildPath = $buildCommand.Source }
}
if (-not $MsBuildPath -or -not (Test-Path -LiteralPath $MsBuildPath)) {
    throw 'Visual Studio MSBuild with the WDK driver toolset is required; no components were installed.'
}
$x64Sibling = Join-Path (Split-Path -Parent $MsBuildPath) 'amd64\MSBuild.exe'
if (Test-Path -LiteralPath $x64Sibling) { $MsBuildPath = $x64Sibling }
Write-Host "Building with $MsBuildPath"
& $MsBuildPath $project /t:Build /p:Configuration=Release /p:Platform=x64 /p:PreferredToolArchitecture=x64 /verbosity:minimal /nologo
if ($LASTEXITCODE) { throw "Driver build failed: $LASTEXITCODE" }
$packageDirectory = Join-Path $PSScriptRoot '..\x64\Release\CodexRemoteVirtualMicro'
foreach ($extension in @('dll', 'inf', 'cat')) {
    $artifact = Join-Path $packageDirectory "CodexRemoteVirtualMicro.$extension"
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) { throw "Driver package is missing $artifact" }
}
Write-Host "UMDF driver package: $([IO.Path]::GetFullPath($packageDirectory))"
