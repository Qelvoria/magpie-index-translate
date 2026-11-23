@echo off
REM 启动 Index-Translate 的官方本地网桥（call_api.py --serve）。
REM magpie 不需要它；只有浏览器插件（沉浸式翻译等）直连公网被 CORS/WAF 挡住时才用。
REM
REM   serve.bat              监听 127.0.0.1:8080
REM   serve.bat 8088         换端口
REM   serve.bat 8080 0.0.0.0 允许局域网访问
setlocal
cd /d "%~dp0"

set PORT=%1
if "%PORT%"=="" set PORT=8080
set HOST=%2
if "%HOST%"=="" set HOST=127.0.0.1

where python >nul 2>nul
if errorlevel 1 (
  echo 找不到 python，请先安装 Python 3 并勾选 "Add python.exe to PATH"。
  exit /b 1
)

echo Index-Translate 网桥启动中: http://%HOST%:%PORT%/v1
python call_api.py --serve %PORT% --host %HOST%
