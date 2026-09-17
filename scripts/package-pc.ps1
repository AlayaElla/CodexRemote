Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryDirectory = (Resolve-Path (Join-Path $ScriptDirectory "..")).Path
$ProjectDirectory = $RepositoryDirectory
$NpmCommand = "npm.cmd"
$NpxCommand = "npx.cmd"
$StagingDirectory = $null
$TemporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$PublisherScript = Join-Path $ScriptDirectory ("publish-pc-package" + ".js")

if (-not (Test-Path -LiteralPath $PublisherScript -PathType Leaf)) {
    throw "PC packaging support script is missing: $PublisherScript"
}

Push-Location $ProjectDirectory
try {
    & $NpmCommand run build:css
    if ($LASTEXITCODE -ne 0) { throw "PC CSS build failed." }
    & $NpmCommand run build:virtual-micro-broker
    if ($LASTEXITCODE -ne 0) { throw "Virtual Micro broker build failed." }
    & $NpmCommand run build:esp32-audio-bridge
    if ($LASTEXITCODE -ne 0) { throw "ESP32 audio bridge build failed." }

    # electron-builder replaces its staging directory in place. A unique temp
    # directory prevents stale file handles (for example, default_app.asar
    # held by antivirus/indexing) from breaking the next package build.
    $StagingDirectory = Join-Path $TemporaryRoot ("codex-remote-pc-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $StagingDirectory | Out-Null

    # Use the Electron distribution installed with this repository.
    $ElectronDirectory = Join-Path $RepositoryDirectory "node_modules\electron\dist"
    & $NpxCommand --no-install electron-builder --win portable --x64 "--config.directories.output=$StagingDirectory" "--config.electronDist=$ElectronDirectory"
    if ($LASTEXITCODE -ne 0) { throw "PC package build failed." }

    & node (Join-Path $ScriptDirectory "publish-pc-package.js") $StagingDirectory
    if ($LASTEXITCODE -ne 0) { throw "PC package publication failed; the previous package was preserved." }

    Write-Host "PC package created successfully."
}
finally {
    if ($null -ne $StagingDirectory -and (Test-Path -LiteralPath $StagingDirectory)) {
        try {
            $ResolvedStaging = (Resolve-Path -LiteralPath $StagingDirectory).Path
            $StagingItem = Get-Item -LiteralPath $ResolvedStaging -Force
            if ((Split-Path -Parent $ResolvedStaging).TrimEnd('\') -ne $TemporaryRoot.TrimEnd('\') -or
                (Split-Path -Leaf $ResolvedStaging) -notmatch '^codex-remote-pc-[0-9a-f]{32}$' -or
                ($StagingItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                throw "Refusing to clean an unexpected staging path: $ResolvedStaging"
            }
            Remove-Item -LiteralPath $ResolvedStaging -Recurse -Force -ErrorAction Stop
        }
        catch {
            Write-Warning "Could not remove temporary packaging directory '$StagingDirectory': $($_.Exception.Message)"
        }
    }
    Pop-Location
}
