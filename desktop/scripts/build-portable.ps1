# ============================================================================
# Build the desktop Electron app and assemble the portable Windows release zip.
#
# Usage (from anywhere):  powershell -NoProfile -File desktop/scripts/build-portable.ps1
#
# Steps:
#   1. Locate the project root by walking up from this script.
#   2. Build the Python backend sidecar first if its exe is missing.
#   3. pnpm install + pnpm run build (electron-builder --win, target dir).
#   4. Stage win-unpacked under desktop/build/portable/servermonitor and add
#      resources/backend, a seeded config, data/, logs/, launchers and docs.
#   5. Compress-Archive into release/服务器轮询监测工具-Windows-x64-v1.4.zip.
#
# Upgrade safety: only the staging directory is ever removed. The source
# config/, data/ and logs/ directories are never deleted; the config file is
# only seeded from the example when the staged config is absent, and every copy
# overwrites in place with -Force.
# ============================================================================

$ErrorActionPreference = 'Stop'

# --- Locate the project root (walks up from the script directory) -----------
function Resolve-ProjectRoot {
    $dir = $PSScriptRoot
    while ($dir) {
        # Preferred layout: <repo>/servermonitor-main/servermonitor-main/...
        $nested = Join-Path $dir 'servermonitor-main/servermonitor-main'
        if (Test-Path (Join-Path $nested 'desktop/package.json')) {
            return $nested
        }
        # Fallback: the directory itself is already a project root.
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
$desktopDir = Join-Path $projectRoot 'desktop'
Write-Host "Project root: $projectRoot" -ForegroundColor Cyan
Write-Host "Desktop dir:  $desktopDir" -ForegroundColor Cyan

# --- 1. Backend sidecar (build first if missing) ----------------------------
$backendDir = Join-Path $projectRoot 'dist/backend/servermonitor-backend'
$backendExe = Join-Path $backendDir 'servermonitor-backend.exe'

if (-not (Test-Path $backendExe)) {
    Write-Host 'Backend sidecar missing; building it with packaging/build-backend.ps1 ...' -ForegroundColor Yellow
    $buildBackend = Join-Path $projectRoot 'packaging/build-backend.ps1'
    if (-not (Test-Path $buildBackend)) {
        throw "Backend build script not found: $buildBackend"
    }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $buildBackend
    if ($LASTEXITCODE -ne 0) {
        throw "packaging/build-backend.ps1 failed with exit code $LASTEXITCODE"
    }
}

if (-not (Test-Path $backendExe)) {
    throw "Backend executable still missing after build: $backendExe"
}
Write-Host "Backend exe:  $backendExe" -ForegroundColor Green

# --- 2. Desktop dependencies + electron-builder -----------------------------
Push-Location $desktopDir
try {
    Write-Host 'Installing desktop dependencies (pnpm install) ...' -ForegroundColor Cyan
    # strictDepBuilds=false keeps pnpm from treating ignored dependency build
    # scripts as a hard install failure; the packages we need are still linked.
    pnpm install --config.strictDepBuilds=false
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm install failed (exit code $LASTEXITCODE). See output above."
    }

    Write-Host 'Building desktop app (pnpm run build / electron-builder) ...' -ForegroundColor Cyan
    pnpm run build
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm run build (electron-builder) failed (exit code $LASTEXITCODE). See output above."
    }
}
finally {
    Pop-Location
}

$winUnpacked = Join-Path $desktopDir 'release-electron/win-unpacked'
if (-not (Test-Path $winUnpacked)) {
    throw "electron-builder output not found: $winUnpacked"
}
Write-Host "Electron output: $winUnpacked" -ForegroundColor Green

# --- 3. Stage the portable tree --------------------------------------------
$stagingDir = Join-Path $desktopDir 'build/portable/servermonitor'
if (Test-Path $stagingDir) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
Write-Host "Staging dir:     $stagingDir" -ForegroundColor Cyan

# Copy the whole win-unpacked payload (exe, dlls, resources, locales, ...).
Copy-Item -Path (Join-Path $winUnpacked '*') -Destination $stagingDir -Recurse -Force

# The portable entry point must be servermonitor.exe. electron-builder derives
# the executable name from productName; rename the single main exe if needed so
# the archive always exposes servermonitor/servermonitor.exe.
$mainExe = Join-Path $stagingDir 'servermonitor.exe'
if (-not (Test-Path $mainExe)) {
    $candidate = Get-ChildItem -Path $stagingDir -Filter '*.exe' -File |
        Where-Object { $_.Name -notlike '*backend*' } |
        Sort-Object Length -Descending |
        Select-Object -First 1
    if (-not $candidate) {
        throw "No Electron main executable found in $winUnpacked"
    }
    Rename-Item -LiteralPath $candidate.FullName -NewName 'servermonitor.exe' -Force
    Write-Host "Renamed $($candidate.Name) -> servermonitor.exe" -ForegroundColor Yellow
}

# Backend sidecar lives next to the Electron exe under resources/backend.
$backendTarget = Join-Path $stagingDir 'resources/backend'
New-Item -ItemType Directory -Path $backendTarget -Force | Out-Null
Copy-Item -Path (Join-Path $backendDir '*') -Destination $backendTarget -Recurse -Force

# Seed config/config.yaml from the example only when staging has no config.
# Existing configs (upgrade scenario) are preserved untouched.
$stageConfigDir = Join-Path $stagingDir 'config'
New-Item -ItemType Directory -Path $stageConfigDir -Force | Out-Null
$stageConfig = Join-Path $stageConfigDir 'config.yaml'
if (-not (Test-Path $stageConfig)) {
    $exampleConfig = Join-Path $projectRoot 'config/config.yaml.example'
    if (-not (Test-Path $exampleConfig)) {
        throw "Config example not found: $exampleConfig"
    }
    Copy-Item -LiteralPath $exampleConfig -Destination $stageConfig -Force
    Write-Host 'Seeded config/config.yaml from config.yaml.example' -ForegroundColor Yellow
}

# Always ensure writable runtime directories exist.
foreach ($dirName in 'data', 'logs') {
    New-Item -ItemType Directory -Path (Join-Path $stagingDir $dirName) -Force | Out-Null
}

# Copy the user-facing launchers and docs if present.
$launchers = @('启动.bat', '停止.bat', '注册开机自启.ps1', '使用说明.txt', 'README.md')
foreach ($name in $launchers) {
    $source = Join-Path $projectRoot $name
    if (Test-Path $source) {
        Copy-Item -LiteralPath $source -Destination $stagingDir -Force
    }
    else {
        Write-Host "Skipping missing optional file: $name" -ForegroundColor DarkYellow
    }
}

# --- 4. Compress into the release zip --------------------------------------
$releaseDir = Join-Path $projectRoot 'release'
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
$zipPath = Join-Path $releaseDir '服务器轮询监测工具-Windows-x64-v1.4.zip'

if (Test-Path $zipPath) {
    # Compress-Archive -Force overwrites the existing archive in place.
    Write-Host "Overwriting existing archive: $zipPath" -ForegroundColor Yellow
}
Compress-Archive -Path $stagingDir -DestinationPath $zipPath -Force -CompressionLevel Optimal

# --- 5. Verify the archive exposes the expected entry point -----------------
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $requiredEntry = 'servermonitor/servermonitor.exe'
    # .NET Framework surfaces ZipArchiveEntry.FullName with backslashes on
    # Windows, so normalise before comparing against the forward-slash entry.
    $entryNames = @($zip.Entries | ForEach-Object { ($_.FullName -replace '\\', '/') })
    if ($entryNames -notcontains $requiredEntry) {
        throw "Archive is missing required entry: $requiredEntry"
    }
}
finally {
    $zip.Dispose()
}

$sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host ("Portable release created: {0} ({1} MB)" -f $zipPath, $sizeMb) -ForegroundColor Green
