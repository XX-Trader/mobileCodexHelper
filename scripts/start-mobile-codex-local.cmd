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

set "APP_STDOUT=%WORKSPACE%\tmp\logs\mobile-codex-app.stdout.log"
set "APP_STDERR=%WORKSPACE%\tmp\logs\mobile-codex-app.stderr.log"
set "NGINX_ROOT=%WORKSPACE%\.runtime\nginx"
set "NGINX_CONF=%NGINX_ROOT%\conf\mobile-codex-nginx.conf"
set "NGINX_MIME=%NGINX_ROOT%\conf\mime.types"

if not exist "%UPSTREAM_DIR%\server\index.js" (
  echo [ERROR] Upstream checkout not found: %UPSTREAM_DIR%
  exit /b 1
)

if not exist "%UPSTREAM_DIR%\dist\index.html" (
  echo [ERROR] Frontend build output not found: %UPSTREAM_DIR%\dist\index.html
  echo [HINT] Run npm install and npm run build in %UPSTREAM_DIR%
  exit /b 1
)

if not exist "%NODE_CMD%" (
  echo [ERROR] Node executable not found: %NODE_CMD%
  exit /b 1
)

if not exist "%NGINX_CMD%" (
  echo [ERROR] nginx executable not found: %NGINX_CMD%
  exit /b 1
)

if not exist "%WORKSPACE%\tmp\logs" mkdir "%WORKSPACE%\tmp\logs"
if not exist "%NGINX_ROOT%\conf" mkdir "%NGINX_ROOT%\conf"
if not exist "%NGINX_ROOT%\logs" mkdir "%NGINX_ROOT%\logs"
if not exist "%NGINX_ROOT%\temp" mkdir "%NGINX_ROOT%\temp"

copy /Y "%WORKSPACE%\deploy\nginx-mobile-codex.conf" "%NGINX_CONF%" >nul
copy /Y "%WORKSPACE%\deploy\nginx-mime.types" "%NGINX_MIME%" >nul

call "%~dp0stop-mobile-codex-local.cmd" >nul 2>nul

>>"%APP_STDOUT%" echo.
>>"%APP_STDOUT%" echo ==== START %DATE% %TIME% ====
>>"%APP_STDERR%" echo.
>>"%APP_STDERR%" echo ==== START %DATE% %TIME% ====

set "NODE_ENV=production"
set "HOST=127.0.0.1"
set "PORT=3001"
set "CODEX_ONLY_HARDENED_MODE=true"
set "VITE_CODEX_ONLY_HARDENED_MODE=true"

pushd "%UPSTREAM_DIR%"
start "" /b "%NODE_CMD%" server\index.js 1>>"%APP_STDOUT%" 2>>"%APP_STDERR%"
popd

timeout /t 5 /nobreak >nul
start "" /b "%NGINX_CMD%" -p "%NGINX_ROOT%" -c conf/mobile-codex-nginx.conf

echo [INFO] Local app URL: http://127.0.0.1:3001
echo [INFO] Local nginx URL: http://127.0.0.1:8080

timeout /t 3 /nobreak >nul
for /f "usebackq delims=" %%A in (`curl.exe -s http://127.0.0.1:3001/health 2^>nul`) do set "APP_HEALTH=%%A"
for /f "usebackq delims=" %%A in (`curl.exe -s http://127.0.0.1:8080/health 2^>nul`) do set "NGINX_HEALTH=%%A"

if defined APP_HEALTH (
  echo [OK] App health: %APP_HEALTH%
) else (
  echo [WARN] App health check failed.
)

if defined NGINX_HEALTH (
  echo [OK] nginx health: %NGINX_HEALTH%
) else (
  echo [WARN] nginx health check failed.
)

exit /b 0
