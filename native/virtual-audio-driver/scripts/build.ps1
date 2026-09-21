param([string]$MsBuildPath)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root 'vendor\sysvad\TabletAudioSample\TabletAudioSample.vcxproj'
$commonProject = Join-Path $root 'vendor\sysvad\EndpointsCommon\EndpointsCommon.vcxproj'
if (-not $MsBuildPath) {
    $locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $locator) {
        $MsBuildPath = & $locator -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\Current\Bin\amd64\MSBuild.exe' | Select-Object -First 1
    }
}
if (-not $MsBuildPath -or -not (Test-Path -LiteralPath $MsBuildPath)) { throw 'Visual Studio MSBuild and WDK 28000 are required.' }
& $MsBuildPath $commonProject /t:Build /p:Configuration=Release /p:Platform=x64 /p:PreferredToolArchitecture=x64 /verbosity:minimal /nologo
if ($LASTEXITCODE) { throw "WaveRT common build failed: $LASTEXITCODE" }
& $MsBuildPath $project /t:Build /p:Configuration=Release /p:Platform=x64 /p:PreferredToolArchitecture=x64 /verbosity:minimal /nologo
if ($LASTEXITCODE) { throw "Driver build failed: $LASTEXITCODE" }
$package = Join-Path $root 'x64\Release\CodexRemoteVirtualAudio'
New-Item -ItemType Directory -Force -Path $package | Out-Null
$built = Join-Path (Split-Path -Parent $project) 'x64\Release\CodexRemoteVirtualAudio.sys'
Copy-Item -LiteralPath $built -Destination (Join-Path $package 'CodexRemoteVirtualAudio.sys') -Force
Copy-Item -LiteralPath (Join-Path $root 'CodexRemoteVirtualAudio.inf') -Destination (Join-Path $package 'CodexRemoteVirtualAudio.inf') -Force
$infVerif = 'C:\Program Files (x86)\Windows Kits\10\Tools\10.0.28000.0\x64\infverif.exe'
& $infVerif /u (Join-Path $package 'CodexRemoteVirtualAudio.inf')
if ($LASTEXITCODE) { throw "InfVerif failed: $LASTEXITCODE" }
$inf2Cat = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.28000.0\x86\Inf2Cat.exe'
& $inf2Cat /driver:$package /os:10_X64
if ($LASTEXITCODE) { throw "Inf2Cat failed: $LASTEXITCODE" }
$catalog = Join-Path $package 'CodexRemoteVirtualAudio.cat'
$generatedCatalog = Join-Path $package 'codexremotevirtualaudio.cat'
if ((Test-Path -LiteralPath $generatedCatalog) -and ((Get-Item -LiteralPath $generatedCatalog).Name -cne 'CodexRemoteVirtualAudio.cat')) {
    $temporaryCatalog = Join-Path $package 'CodexRemoteVirtualAudio.catalog-tmp'
    Move-Item -LiteralPath $generatedCatalog -Destination $temporaryCatalog
    Move-Item -LiteralPath $temporaryCatalog -Destination $catalog
}
foreach ($extension in @('sys', 'inf', 'cat')) {
    $artifact = Join-Path $package "CodexRemoteVirtualAudio.$extension"
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) { throw "Driver package is missing $artifact" }
}
Write-Host "Built un-signed driver input: $package"
