@echo off
REM Rebuilds the DevWebUI GUI (web\dist) that the daemon serves.
REM Standalone replacement for the tray's dev-only "Rebuild & Restart" — keep this
REM after you remove that menu item for public distribution. Double-click to run.
cd /d "%~dp0.."
echo Building DevWebUI GUI (web\dist)...
call bun run build
echo.
if errorlevel 1 (
  echo Build FAILED — see the output above.
  pause
  exit /b 1
) else (
  echo Done. Restart DevWebUI ^(tray: Restart^) to serve the new build.
  exit /b 0
)
