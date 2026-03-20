@echo off
setlocal EnableExtensions

set "START_TASK=mobileCodexHelper-StartLocal"
set "REMOTE_TASK=mobileCodexHelper-EnableRemote"

if /i "%~1"=="--dry-run" set "DRY_RUN=1"

call :delete_task "%START_TASK%"
call :delete_task "%REMOTE_TASK%"

echo [OK] Removed mobileCodexHelper logon startup tasks.
exit /b 0

:delete_task
set "TASK_NAME=%~1"

if defined DRY_RUN (
  echo [DRY-RUN] schtasks /Delete /F /TN "%TASK_NAME%"
  exit /b 0
)

schtasks /Delete /F /TN "%TASK_NAME%" >nul 2>nul
if errorlevel 1 (
  echo [INFO] Task not found or already removed: %TASK_NAME%
) else (
  echo [OK] Deleted task: %TASK_NAME%
)

exit /b 0
