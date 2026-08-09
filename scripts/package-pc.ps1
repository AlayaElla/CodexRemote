Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# All release artifacts are written under the repository build directory.
$PackageTarget = "portable"

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryDirectory = (Resolve-Path (Join-Path $ScriptDirectory "..")).Path
$ProjectDirectory = $RepositoryDirectory
$OutputDirectory = Join-Path $RepositoryDirectory "build\pc"
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$NpmCommand = "npm.cmd"
$NpxCommand = "npx.cmd"
$StagingDirectory = $null

Push-Location $ProjectDirectory
try {
    & $NpmCommand run build:css
    if ($LASTEXITCODE -ne 0) { throw "PC CSS build failed." }

    # electron-builder replaces its staging directory in place. A unique temp
    # directory prevents stale file handles (for example, default_app.asar
    # held by antivirus/indexing) from breaking the next package build.
    $StagingDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-remote-pc-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $StagingDirectory | Out-Null

    & $NpxCommand electron-builder --win $PackageTarget --x64 "--config.directories.output=$StagingDirectory"
    if ($LASTEXITCODE -ne 0) { throw "PC package build failed." }

    $Artifacts = @(Get-ChildItem -LiteralPath $StagingDirectory -Filter "*.exe" -File)
    if ($Artifacts.Count -ne 1) {
        throw "Expected one portable executable in staging directory, found $($Artifacts.Count)."
    }

    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
    $PublishedArtifact = Join-Path $OutputDirectory $Artifacts[0].Name
    Copy-Item -LiteralPath $Artifacts[0].FullName -Destination $PublishedArtifact -Force

    Write-Host "PC package created in: $OutputDirectory"
    Get-ChildItem -LiteralPath $OutputDirectory -Filter "*.exe" -Recurse |
        Select-Object FullName, Length
}
finally {
    if ($null -ne $StagingDirectory -and (Test-Path -LiteralPath $StagingDirectory)) {
        try {
            Remove-Item -LiteralPath $StagingDirectory -Recurse -Force -ErrorAction Stop
        }
        catch {
            Write-Warning "Could not remove temporary packaging directory '$StagingDirectory': $($_.Exception.Message)"
        }
    }
    Pop-Location
}
