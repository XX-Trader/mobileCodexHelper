@echo off
setlocal EnableExtensions

cd /d "%~dp0.."
set "WORKSPACE=%CD%"
set "START_SCRIPT=%WORKSPACE%\scripts\start-mobile-codex-local.cmd"
set "REMOTE_SCRIPT=%WORKSPACE%\scripts\enable-mobile-codex-remote.cmd"
set "START_TASK=mobileCodexHelper-StartLocal"
set "REMOTE_TASK=mobileCodexHelper-EnableRemote"
set "START_COMMAND=%ComSpec% /d /c ""%START_SCRIPT%"""
set "REMOTE_COMMAND=%ComSpec% /d /c ""%REMOTE_SCRIPT%"""

if /i "%~1"=="--dry-run" set "DRY_RUN=1"

if not exist "%START_SCRIPT%" (
  echo [ERROR] Start script not found: %START_SCRIPT%
  exit /b 1
)

if not exist "%REMOTE_SCRIPT%" (
  echo [ERROR] Remote script not found: %REMOTE_SCRIPT%
  exit /b 1
)

call :create_task "%START_TASK%" "%START_COMMAND%" ""
if errorlevel 1 exit /b 1

call :create_task "%REMOTE_TASK%" "%REMOTE_COMMAND%" "0001:00"
if errorlevel 1 exit /b 1

echo [OK] Installed logon startup tasks.
echo [INFO] Query task status with:
echo [INFO]   schtasks /Query /TN "%START_TASK%" /V /FO LIST
echo [INFO]   schtasks /Query /TN "%REMOTE_TASK%" /V /FO LIST
exit /b 0

:create_task
set "TASK_NAME=%~1"
set "TASK_COMMAND=%~2"
set "TASK_DELAY=%~3"

if defined DRY_RUN (
  if defined TASK_DELAY (
    echo [DRY-RUN] schtasks /Create /F /TN "%TASK_NAME%" /SC ONLOGON /DELAY %TASK_DELAY% /TR "%TASK_COMMAND%" /RL LIMITED
  ) else (
    echo [DRY-RUN] schtasks /Create /F /TN "%TASK_NAME%" /SC ONLOGON /TR "%TASK_COMMAND%" /RL LIMITED
  )
  exit /b 0
)

if defined TASK_DELAY (
  schtasks /Create /F /TN "%TASK_NAME%" /SC ONLOGON /DELAY %TASK_DELAY% /TR "%TASK_COMMAND%" /RL LIMITED >nul
) else (
  schtasks /Create /F /TN "%TASK_NAME%" /SC ONLOGON /TR "%TASK_COMMAND%" /RL LIMITED >nul
)

if errorlevel 1 (
  echo [ERROR] Failed to create task: %TASK_NAME%
  exit /b 1
)

echo [OK] Created task: %TASK_NAME%
exit /b 0
