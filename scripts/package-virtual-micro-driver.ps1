param(
    [ValidateNotNullOrEmpty()]
    [string]$AudioDriverPackagePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryDirectory = (Resolve-Path -LiteralPath (Join-Path $ScriptDirectory "..")).Path
$TemporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$StagingDirectory = $null

Push-Location $RepositoryDirectory
try {
    & (Join-Path $RepositoryDirectory 'native/virtual-micro-driver/scripts/build.ps1')
    if ($LASTEXITCODE -ne 0) { throw "Virtual Micro driver build failed." }

    $StagingDirectory = Join-Path $TemporaryRoot ("codex-remote-driver-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $StagingDirectory | Out-Null
    $AudioPackageSource = $null
    if ([string]::IsNullOrWhiteSpace($AudioDriverPackagePath)) {
        & (Join-Path $RepositoryDirectory 'native/virtual-audio-driver/scripts/build.ps1')
        if ($LASTEXITCODE -ne 0) { throw "Virtual Audio driver build failed." }
        $AudioPackageSource = Join-Path $RepositoryDirectory 'native/virtual-audio-driver/x64/Release/CodexRemoteVirtualAudio'
    }
    else {
        $AudioPackageSource = (Resolve-Path -LiteralPath $AudioDriverPackagePath -ErrorAction Stop).Path
    }

    $BundleSnapshot = Join-Path $StagingDirectory 'driver-bundle'
    $MicroSnapshot = Join-Path $BundleSnapshot 'micro'
    $AudioSnapshot = Join-Path $BundleSnapshot 'audio'
    $MicroHashManifest = Join-Path $StagingDirectory 'micro-hashes.json'
    $AudioHashManifest = Join-Path $StagingDirectory 'audio-hashes.json'
    & node (Join-Path $ScriptDirectory "prepare-virtual-micro-driver.js") $MicroSnapshot
    if ($LASTEXITCODE -ne 0) { throw "Virtual Micro driver package validation failed." }

    & node (Join-Path $ScriptDirectory "prepare-virtual-audio-driver.js") $AudioSnapshot $AudioPackageSource
    if ($LASTEXITCODE -ne 0) { throw "Virtual Audio driver package validation failed." }

    & node (Join-Path $ScriptDirectory "generate-virtual-micro-payload-hashes.js") $MicroSnapshot $MicroHashManifest
    if ($LASTEXITCODE -ne 0) { throw "Virtual Micro driver payload hash generation failed." }

    & node (Join-Path $ScriptDirectory "generate-virtual-audio-payload-hashes.js") $AudioSnapshot $AudioHashManifest
    if ($LASTEXITCODE -ne 0) { throw "Virtual Audio driver payload hash generation failed." }

    $PayloadDirectory = Join-Path $StagingDirectory "payload"
    & dotnet publish native/virtual-micro-driver-installer/VirtualMicroDriverInstaller.csproj -c Release -r win-x64 --self-contained true -p:PublishAot=true -o $PayloadDirectory
    if ($LASTEXITCODE -ne 0) { throw "Virtual Micro driver installer build failed." }

    & node (Join-Path $ScriptDirectory "bundle-virtual-micro-driver.js") $PayloadDirectory $MicroSnapshot $MicroHashManifest $AudioSnapshot $AudioHashManifest
    if ($LASTEXITCODE -ne 0) { throw "Virtual Micro driver bundle failed; the previous package was preserved." }
}
finally {
    if ($null -ne $StagingDirectory -and (Test-Path -LiteralPath $StagingDirectory)) {
        try {
            $ResolvedStaging = (Resolve-Path -LiteralPath $StagingDirectory).Path
            $StagingItem = Get-Item -LiteralPath $ResolvedStaging -Force
            if ((Split-Path -Parent $ResolvedStaging).TrimEnd('\') -ne $TemporaryRoot.TrimEnd('\') -or
                (Split-Path -Leaf $ResolvedStaging) -notmatch '^codex-remote-driver-[0-9a-f]{32}$' -or
                ($StagingItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                throw "Refusing to clean an unexpected staging path: $ResolvedStaging"
            }
            Remove-Item -LiteralPath $ResolvedStaging -Recurse -Force -ErrorAction Stop
        }
        catch {
            Write-Warning "Could not remove temporary driver directory '$StagingDirectory': $($_.Exception.Message)"
        }
    }
    Pop-Location
}
