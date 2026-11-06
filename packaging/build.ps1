# ============================================================================
# 构建 Windows PC 绿色包（PyInstaller onedir）
# 用法：在 PowerShell 中执行  pwsh packaging/build.ps1
# 产物：dist/servermonitor/servermonitor.exe
# ============================================================================

# 注意：PyInstaller 会把 INFO 日志写到 stderr。Windows PowerShell 5.1 在
# $ErrorActionPreference="Stop" 时会把原生命令的 stderr 当作终止错误，导致脚本
# 误判失败。故这里使用 Continue，并统一用 $LASTEXITCODE 判定成败。
$ErrorActionPreference = "Continue"

# 切到项目根目录（本脚本位于 packaging/ 下）
Set-Location (Join-Path $PSScriptRoot "..")
Write-Host "项目根目录：$(Get-Location)" -ForegroundColor Cyan

# 安装构建期依赖（pyinstaller 等）
Write-Host '安装构建依赖：pip install -e ".[build]" ...' -ForegroundColor Cyan
python -m pip install -e ".[build]"
if ($LASTEXITCODE -ne 0) {
    Write-Host "pip 安装构建依赖失败（exit $LASTEXITCODE）" -ForegroundColor Red
    exit $LASTEXITCODE
}

# 执行打包
Write-Host "开始 PyInstaller 打包 ..." -ForegroundColor Cyan
python -m PyInstaller packaging/servermonitor.spec --noconfirm --clean
if ($LASTEXITCODE -ne 0) {
    Write-Host "PyInstaller 打包失败（exit $LASTEXITCODE）" -ForegroundColor Red
    exit $LASTEXITCODE
}

# 校验产物
$exePath = Join-Path (Get-Location) "dist/servermonitor/servermonitor.exe"
if (-not (Test-Path $exePath)) {
    Write-Host "构建结束但未找到产物：$exePath" -ForegroundColor Red
    exit 1
}

$sizeMb = (Get-Item $exePath).Length / 1MB
Write-Host ("构建成功：{0}（{1:N2} MB）" -f $exePath, $sizeMb) -ForegroundColor Green
Write-Host "下一步：把 config\、data\、logs\ 和启动脚本拷入 dist\servermonitor\ 后双击 启动.bat。" -ForegroundColor Green
