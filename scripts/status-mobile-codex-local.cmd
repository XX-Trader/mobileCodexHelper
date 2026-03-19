@echo off
setlocal

cd /d "%~dp0.."
set "WORKSPACE=%CD%"
set "UPSTREAM_DIR=%MOBILE_CODEX_UPSTREAM_DIR%"
set "NODE_CMD=%MOBILE_CODEX_NODE%"
set "NGINX_CMD=%MOBILE_CODEX_NGINX%"

if not defined UPSTREAM_DIR set "UPSTREAM_DIR=%WORKSPACE%\vendor\claudecodeui-1.25.2"
if not defined NODE_CMD set "NODE_CMD=C:\Program Files\nodejs\node.exe"
if not defined NGINX_CMD set "NGINX_CMD=%WORKSPACE%\.tools\nginx-1.28.2\nginx.exe"

echo [INFO] Workspace: %WORKSPACE%
echo [INFO] Upstream : %UPSTREAM_DIR%
echo [INFO] Node     : %NODE_CMD%
echo [INFO] nginx    : %NGINX_CMD%
echo [INFO] Time     : %DATE% %TIME%
echo.

echo [INFO] Listening ports
netstat -ano -p tcp | findstr LISTENING | findstr :3001
netstat -ano -p tcp | findstr LISTENING | findstr :8080
echo.

echo [INFO] App health
curl.exe -s http://127.0.0.1:3001/health 2>nul
echo.
echo.

echo [INFO] nginx health
curl.exe -s http://127.0.0.1:8080/health 2>nul
echo.

exit /b 0
