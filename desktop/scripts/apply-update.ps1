param(
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [Parameter(Mandatory = $true)][string]$AppDir,
    [int]$WaitPid = 0
)

$ErrorActionPreference = "Stop"
$LogDir = Join-Path $AppDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogPath = Join-Path $LogDir "update.log"

function Write-Log([string]$Message) {
    $line = "{0} {1}" -f (Get-Date).ToString("s"), $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Copy-WithRetry([string]$Source, [string]$Destination, [switch]$Recurse) {
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            if ($Recurse) {
                Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
            } else {
                Copy-Item -LiteralPath $Source -Destination $Destination -Force
            }
            return
        } catch {
            if ($attempt -eq 10) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
}

$Stage = Join-Path $env:TEMP ("servermonitor-update-" + [guid]::NewGuid().ToString("N"))
$Backup = Join-Path $AppDir ("update-backup-" + (Get-Date).ToString("yyyyMMdd-HHmmss"))
$Started = $false

try {
    Write-Log "update start: zip=$ZipPath app=$AppDir pid=$WaitPid"
    if ($WaitPid -gt 0) {
        try { Wait-Process -Id $WaitPid -Timeout 30 -ErrorAction SilentlyContinue } catch { }
    }
    Get-Process -Name "servermonitor-backend" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like "$AppDir*" } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500

    New-Item -ItemType Directory -Force -Path $Stage | Out-Null
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $Stage -Force
    $Source = Join-Path $Stage "servermonitor"
    if (-not (Test-Path -LiteralPath $Source)) { $Source = $Stage }

    New-Item -ItemType Directory -Force -Path $Backup | Out-Null
    foreach ($relative in @("servermonitor.exe", "resources\app.asar", "resources\backend", "apply-update.ps1")) {
        $current = Join-Path $AppDir $relative
        if (Test-Path -LiteralPath $current) {
            $target = Join-Path $Backup $relative
            $parent = Split-Path -Parent $target
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
            Copy-WithRetry -Source $current -Destination $target -Recurse
        }
    }

    $skipNames = @("config", "data", "logs")
    foreach ($item in (Get-ChildItem -LiteralPath $Source -Force)) {
        if ($skipNames -contains $item.Name) { continue }
        Copy-WithRetry -Source $item.FullName -Destination $AppDir -Recurse
    }

    $sourceConfig = Join-Path $Source "config"
    $targetConfig = Join-Path $AppDir "config"
    New-Item -ItemType Directory -Force -Path $targetConfig | Out-Null
    if (Test-Path -LiteralPath $sourceConfig) {
        Get-ChildItem -LiteralPath $sourceConfig -Filter "*.example" -File -ErrorAction SilentlyContinue |
            ForEach-Object { Copy-WithRetry -Source $_.FullName -Destination $targetConfig }
    }

    Write-Log "update files replaced"
    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
    $exe = Join-Path $AppDir "servermonitor.exe"
    if (Test-Path -LiteralPath $exe) {
        Start-Process -FilePath $exe -WorkingDirectory $AppDir
        $Started = $true
    }
    Write-Log "update complete"
    exit 0
} catch {
    Write-Log ("update failed: " + $_.Exception.Message)
    try {
        if (Test-Path -LiteralPath $Backup) {
            foreach ($relative in @("servermonitor.exe", "resources\app.asar", "resources\backend", "apply-update.ps1")) {
                $old = Join-Path $Backup $relative
                if (Test-Path -LiteralPath $old) {
                    $target = Join-Path $AppDir $relative
                    $parent = Split-Path -Parent $target
                    New-Item -ItemType Directory -Force -Path $parent | Out-Null
                    Copy-WithRetry -Source $old -Destination $target -Recurse
                }
            }
            Write-Log "backup restored"
        }
    } catch {
        Write-Log ("restore failed: " + $_.Exception.Message)
    }
    if (-not $Started) {
        $exe = Join-Path $AppDir "servermonitor.exe"
        if (Test-Path -LiteralPath $exe) {
            Start-Process -FilePath $exe -WorkingDirectory $AppDir
        }
    }
    exit 1
}
