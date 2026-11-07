# ============================================================================
# 允许局域网访问“服务器轮询监测工具”看板（Windows 防火墙入站规则）
# 以管理员权限运行；为 resources\backend\servermonitor-backend.exe 添加入站放行。
# 规则名固定为“服务器轮询监测工具”，可重复运行（先删除同名旧规则）。
# ============================================================================
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$RuleName = "服务器轮询监测工具"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendExe = Join-Path $ScriptDir "resources\backend\servermonitor-backend.exe"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "需要管理员权限才能修改 Windows 防火墙。" -ForegroundColor Red
    Write-Host "请打开“管理员: PowerShell”，然后运行："
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Write-Host "按回车退出..."
    Read-Host | Out-Null
    exit 1
}

if (-not (Test-Path $BackendExe)) {
    Write-Host "未找到后端程序：$BackendExe" -ForegroundColor Red
    Write-Host "请确认已完整解压绿色包，本脚本需与 servermonitor.exe 在同一目录。"
    Write-Host "按回车退出..."
    Read-Host | Out-Null
    exit 1
}

# 可重复运行：先删除同名旧规则，避免重复或指向旧路径。
$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($existing) {
    Remove-NetFirewallRule -DisplayName $RuleName
    Write-Host "已删除旧的防火墙规则 '$RuleName'。" -ForegroundColor Yellow
}

New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow -Program $BackendExe -Protocol TCP -Profile Private -Description "允许局域网访问服务器轮询监测工具看板" | Out-Null
Write-Host "已添加防火墙规则 '$RuleName'，允许专用网络内的电脑访问看板。" -ForegroundColor Green
Write-Host "请确保设置页的监听地址为 0.0.0.0（或 127.0.0.1），端口以页面显示为准。"
Write-Host "按回车退出..."
Read-Host | Out-Null
