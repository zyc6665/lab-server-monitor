@echo off
setlocal
cd /d "%~dp0"

if not exist "servermonitor.exe" (
    echo [错误] 未找到 servermonitor.exe。
    echo        请在绿色包目录（dist\servermonitor）中运行本脚本。
    pause
    exit /b 1
)

if not exist "config\config.yaml" (
    echo [错误] 未找到 config\config.yaml。
    echo        请将 config\config.yaml.example 复制为 config\config.yaml 并填写。
    pause
    exit /b 1
)

echo 正在启动服务器轮询监测工具...
set "DOTENV_ARG="
if exist "config\.env" set "DOTENV_ARG=--dotenv config\.env"
start "" /min servermonitor.exe --config "config\config.yaml" %DOTENV_ARG%
echo 启动后会自动打开浏览器；若未打开，请查看 data\runtime.json 中的 url。
endlocal
