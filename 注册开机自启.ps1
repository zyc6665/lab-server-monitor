# ============================================================================
# 注册“服务器轮询监测看板”开机自启（Windows）
# 优先创建登录时触发的计划任务 ServerMonitorDashboard；
# 若权限不足，回退到“启动”文件夹快捷方式。可重复运行（会先删除同名任务）。
# ============================================================================
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$TaskName = "ServerMonitorDashboard"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Launcher = Join-Path $ScriptDir "启动.bat"

if (-not (Test-Path $Launcher)) {
    Write-Host "未找到启动脚本：$Launcher" -ForegroundColor Red
    exit 1
}

try {
    # 可重复运行：先删除同名计划任务（若存在）
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "已删除旧的计划任务 '$TaskName'。" -ForegroundColor Yellow
    }

    $action = New-ScheduledTaskAction -Execute $Launcher -WorkingDirectory $ScriptDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "服务器轮询监测看板开机自启" | Out-Null
    Write-Host "已注册计划任务 '$TaskName'，下次登录 Windows 时将自动启动看板。" -ForegroundColor Green
}
catch {
    Write-Host "计划任务注册失败（可能权限不足）：$($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "回退为在“启动”文件夹创建快捷方式 ..." -ForegroundColor Yellow

    $startup = [Environment]::GetFolderPath("Startup")
    $shortcutPath = Join-Path $startup "ServerMonitorDashboard.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $Launcher
    $shortcut.WorkingDirectory = $ScriptDir
    $shortcut.Description = "服务器轮询监测看板"
    $shortcut.Save()
    Write-Host "已在启动文件夹创建快捷方式：$shortcutPath" -ForegroundColor Green
}

Write-Host "按回车退出..."
Read-Host | Out-Null
