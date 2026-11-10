@echo off
setlocal
set "AE3_AI_SERVICE_DIR=%APPDATA%\AEFileManager-Anime"
if not defined APPDATA exit /b 1
set "AFM_NODE=%APPDATA%\AFMAnimeRuntime\node\node.exe"
if exist "%AFM_NODE%" (
  "%AFM_NODE%" "%~dp0ai-expression-service.js"
) else (
  echo Run the team installer first. The normal plugin starts this service automatically.
)
pause
