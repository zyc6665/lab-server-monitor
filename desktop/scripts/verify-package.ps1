# ============================================================================
# Verify a staged portable package (or the release zip) contains every file the
# desktop shell needs at runtime. Exits non-zero with a clear message on the
# first problem.
#
# Usage:
#   powershell -NoProfile -File desktop/scripts/verify-package.ps1
#   powershell -NoProfile -File desktop/scripts/verify-package.ps1 -StagingDir <dir>
#   powershell -NoProfile -File desktop/scripts/verify-package.ps1 -PackageZip release\....zip
# ============================================================================

param(
    [string]$PackageZip,
    [string]$StagingDir
)

$ErrorActionPreference = 'Stop'

function Resolve-ProjectRoot {
    $dir = $PSScriptRoot
    while ($dir) {
        $nested = Join-Path $dir 'servermonitor-main/servermonitor-main'
        if (Test-Path (Join-Path $nested 'desktop/package.json')) {
            return $nested
        }
        if (Test-Path (Join-Path $dir 'desktop/package.json')) {
            return $dir
        }
        $parent = Split-Path -Parent $dir
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $dir) { break }
        $dir = $parent
    }
    throw "Could not locate the project root (servermonitor-main/servermonitor-main) by walking up from $PSScriptRoot"
}

$projectRoot = Resolve-ProjectRoot

if (-not $StagingDir) {
    $StagingDir = Join-Path $projectRoot 'desktop/build/portable/servermonitor'
}

$required = @(
    'servermonitor.exe',
    'resources/backend/servermonitor-backend.exe',
    'config/config.yaml',
    '启动.bat'
)

# --- Check the staged directory --------------------------------------------
if (-not (Test-Path $StagingDir)) {
    throw "Staging directory not found: $StagingDir"
}

$missing = @()
foreach ($rel in $required) {
    $full = Join-Path $StagingDir $rel
    if (-not (Test-Path $full)) {
        $missing += $rel
    }
}

if ($missing.Count -gt 0) {
    throw ("Package verification failed. Missing required files under {0}: {1}" -f $StagingDir, ($missing -join ', '))
}

# --- Optionally check the zip entries --------------------------------------
if ($PackageZip) {
    if (-not (Test-Path $PackageZip)) {
        throw "Package zip not found: $PackageZip"
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $resolvedZip = (Resolve-Path -LiteralPath $PackageZip).ProviderPath
    $zip = [System.IO.Compression.ZipFile]::OpenRead($resolvedZip)
    try {
        # .NET Framework reports ZipArchiveEntry.FullName with backslashes on
        # Windows; normalise to forward slashes before comparing.
        $entryNames = @($zip.Entries | ForEach-Object { ($_.FullName -replace '\\', '/') })
        $missingEntries = @()
        foreach ($rel in $required) {
            $entry = 'servermonitor/' + ($rel -replace '\\', '/')
            if ($entryNames -notcontains $entry) {
                $missingEntries += $entry
            }
        }
        if ($missingEntries.Count -gt 0) {
            throw ("Zip verification failed. Missing entries in {0}: {1}" -f $resolvedZip, ($missingEntries -join ', '))
        }
    }
    finally {
        $zip.Dispose()
    }
    Write-Host "Zip verification passed: $resolvedZip" -ForegroundColor Green
}

Write-Host "Package verification passed: $StagingDir" -ForegroundColor Green
