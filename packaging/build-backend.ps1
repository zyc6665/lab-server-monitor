# ============================================================================
# Build the desktop Python backend sidecar (PyInstaller onedir, no console).
# Usage: powershell -File packaging/build-backend.ps1
# Output: dist/backend/servermonitor-backend/servermonitor-backend.exe
# ============================================================================

$ErrorActionPreference = 'Stop'

# Move to the project root (this script lives under packaging/).
Set-Location (Join-Path $PSScriptRoot '..')
Write-Host "Project root: $(Get-Location)" -ForegroundColor Cyan

# Run PyInstaller.
Write-Host 'Building backend sidecar with PyInstaller ...' -ForegroundColor Cyan
python -m PyInstaller --noconfirm --clean packaging/backend.spec
if ($LASTEXITCODE -ne 0) {
    Write-Host "PyInstaller build failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
}

# Verify the expected onedir executable exists.
$exePath = Join-Path (Get-Location) 'dist/backend/servermonitor-backend/servermonitor-backend.exe'
if (-not (Test-Path $exePath)) {
    Write-Host "Build finished but output is missing: $exePath" -ForegroundColor Red
    exit 1
}

$sizeMb = (Get-Item $exePath).Length / 1MB
Write-Host ("Build succeeded: {0} ({1:N2} MB)" -f $exePath, $sizeMb) -ForegroundColor Green
