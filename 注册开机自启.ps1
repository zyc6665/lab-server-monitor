# ============================================================================
# 注册“服务器轮询监测工具”开机自启（Windows 桌面版）
# 创建登录时触发的计划任务 ServerMonitorDashboard，直接执行
# servermonitor.exe --start-hidden（只在托盘运行，不弹主窗口）。
# 可重复运行（会先删除同名任务）；权限不足时回退到“启动”文件夹快捷方式。
# ============================================================================
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$TaskName = "ServerMonitorDashboard"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $ScriptDir "servermonitor.exe"

if (-not (Test-Path $Exe)) {
    Write-Host "未找到 servermonitor.exe：$Exe" -ForegroundColor Red
    Write-Host "请确认已完整解压绿色包，且本脚本与 servermonitor.exe 在同一目录。"
    exit 1
}

try {
    # 可重复运行：先删除同名计划任务（若存在）
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "已删除旧的计划任务 '$TaskName'。" -ForegroundColor Yellow
    }

    # 直接执行 servermonitor.exe 并传 --start-hidden。
    $action = New-ScheduledTaskAction -Execute $Exe -Argument "--start-hidden" -WorkingDirectory $ScriptDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "服务器轮询监测工具开机自启（托盘运行）" | Out-Null
    Write-Host "已注册计划任务 '$TaskName'，下次登录 Windows 时将在托盘自动启动。" -ForegroundColor Green
}
catch {
    Write-Host "计划任务注册失败（可能权限不足）：$($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "回退为在“启动”文件夹创建快捷方式 ..." -ForegroundColor Yellow

    $startup = [Environment]::GetFolderPath("Startup")
    $shortcutPath = Join-Path $startup "ServerMonitorDashboard.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $Exe
    $shortcut.Arguments = "--start-hidden"
    $shortcut.WorkingDirectory = $ScriptDir
    $shortcut.Description = "服务器轮询监测工具"
    $shortcut.Save()
    Write-Host "已在启动文件夹创建快捷方式：$shortcutPath" -ForegroundColor Green
}

Write-Host "按回车退出..."
Read-Host | Out-Null
