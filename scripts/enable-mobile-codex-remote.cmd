@echo off
setlocal EnableExtensions

cd /d "%~dp0.."
set "WORKSPACE=%CD%"
set "LOG_DIR=%WORKSPACE%\tmp\logs"
set "STDOUT_LOG=%LOG_DIR%\mobile-codex-remote.stdout.log"
set "STDERR_LOG=%LOG_DIR%\mobile-codex-remote.stderr.log"
set "TAILSCALE_CMD=%MOBILE_CODEX_TAILSCALE%"

if not defined TAILSCALE_CMD set "TAILSCALE_CMD=C:\Program Files\Tailscale\tailscale.exe"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

>>"%STDOUT_LOG%" echo.
>>"%STDOUT_LOG%" echo ==== START %DATE% %TIME% ====
>>"%STDERR_LOG%" echo.
>>"%STDERR_LOG%" echo ==== START %DATE% %TIME% ====

call :log_info "Workspace: %WORKSPACE%"
call :log_info "Tailscale: %TAILSCALE_CMD%"

if not exist "%TAILSCALE_CMD%" (
  call :log_error "Tailscale CLI not found: %TAILSCALE_CMD%"
  exit /b 1
)

set "STATUS_FILE=%TEMP%\mobile-codex-tailscale-status-%RANDOM%%RANDOM%.json"
set "STATUS_ERR_FILE=%TEMP%\mobile-codex-tailscale-status-%RANDOM%%RANDOM%.err"
set "SERVE_FILE=%TEMP%\mobile-codex-tailscale-serve-%RANDOM%%RANDOM%.log"

"%TAILSCALE_CMD%" status --json 1>"%STATUS_FILE%" 2>"%STATUS_ERR_FILE%"
if errorlevel 1 (
  call :log_error "Failed to query Tailscale status."
  call :append_file "%STATUS_ERR_FILE%" "%STDERR_LOG%"
  if exist "%STATUS_ERR_FILE%" type "%STATUS_ERR_FILE%" 1>&2
  call :cleanup "%STATUS_FILE%" "%STATUS_ERR_FILE%" "%SERVE_FILE%"
  exit /b 1
)

call :append_file "%STATUS_FILE%" "%STDOUT_LOG%"
findstr /r /c:"\"BackendState\"[ ]*:[ ]*\"Running\"" "%STATUS_FILE%" >nul
if errorlevel 1 (
  findstr /r /c:"\"AuthURL\"[ ]*:[ ]*\"https://\"" "%STATUS_FILE%" >nul
  if errorlevel 1 (
    call :log_error "Tailscale is not running yet."
  ) else (
    call :log_error "Tailscale login required. Run tailscale up first."
  )
  call :cleanup "%STATUS_FILE%" "%STATUS_ERR_FILE%" "%SERVE_FILE%"
  exit /b 1
)

"%TAILSCALE_CMD%" serve --bg http://127.0.0.1:8080 1>"%SERVE_FILE%" 2>&1
set "SERVE_EXIT=%ERRORLEVEL%"
call :append_file "%SERVE_FILE%" "%STDOUT_LOG%"

findstr /r /c:"https://login\.tailscale\.com/f/serve\?" "%SERVE_FILE%" >nul
if not errorlevel 1 (
  call :log_error "Tailscale Serve must be enabled on your tailnet first."
  if exist "%SERVE_FILE%" type "%SERVE_FILE%" 1>&2
  call :cleanup "%STATUS_FILE%" "%STATUS_ERR_FILE%" "%SERVE_FILE%"
  exit /b 1
)

if not "%SERVE_EXIT%"=="0" (
  call :log_error "Failed to enable Tailscale Serve."
  if exist "%SERVE_FILE%" type "%SERVE_FILE%" 1>&2
  call :cleanup "%STATUS_FILE%" "%STATUS_ERR_FILE%" "%SERVE_FILE%"
  exit /b %SERVE_EXIT%
)

call :log_info "Tailscale Serve enabled for http://127.0.0.1:8080"
"%TAILSCALE_CMD%" serve status 1>>"%STDOUT_LOG%" 2>>"%STDERR_LOG%"
set "SERVE_STATUS_EXIT=%ERRORLEVEL%"

call :cleanup "%STATUS_FILE%" "%STATUS_ERR_FILE%" "%SERVE_FILE%"
exit /b %SERVE_STATUS_EXIT%

:log_info
echo [INFO] %~1
>>"%STDOUT_LOG%" echo [INFO] %DATE% %TIME% %~1
exit /b 0

:log_error
echo [ERROR] %~1 1>&2
>>"%STDERR_LOG%" echo [ERROR] %DATE% %TIME% %~1
exit /b 0

:append_file
if exist "%~1" (
  type "%~1" >> "%~2"
)
exit /b 0

:cleanup
if exist "%~1" del /q "%~1" >nul 2>nul
if exist "%~2" del /q "%~2" >nul 2>nul
if exist "%~3" del /q "%~3" >nul 2>nul
exit /b 0
