@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo Installation failed. See INSTALL.md.
) else (
  echo Installed. Open AE - Window - Extensions - Star Isle File Manager.
)
pause
