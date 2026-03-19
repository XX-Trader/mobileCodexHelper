@echo off
setlocal

cd /d "%~dp0.."
set "WORKSPACE=%CD%"
set "NGINX_CMD=%MOBILE_CODEX_NGINX%"
if not defined NGINX_CMD set "NGINX_CMD=%WORKSPACE%\.tools\nginx-1.28.2\nginx.exe"
set "NGINX_ROOT=%WORKSPACE%\.runtime\nginx"

if exist "%NGINX_CMD%" (
  if exist "%NGINX_ROOT%\logs\mobile-codex.pid" (
    "%NGINX_CMD%" -p "%NGINX_ROOT%" -c conf/mobile-codex-nginx.conf -s stop >nul 2>nul
    timeout /t 2 /nobreak >nul
  )
)

set "STOPPED_ANY="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr LISTENING ^| findstr /c:":3001" /c:":8080"') do (
  taskkill /PID %%P /F >nul 2>nul
  set "STOPPED_ANY=1"
)

if defined STOPPED_ANY (
  echo [OK] Stopped listeners on 127.0.0.1:3001 / 127.0.0.1:8080
) else (
  echo [INFO] No local mobileCodexHelper listeners were running.
)

exit /b 0
