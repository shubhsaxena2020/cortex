@echo off
REM cortex CLI launcher — runs cortex.mjs under Electron-as-Node so
REM better-sqlite3 finds its ABI-matched binary. Add this directory to PATH
REM (or alias it) and you have `cortex` everywhere.
setlocal
set ELECTRON_RUN_AS_NODE=1
set SCRIPT_DIR=%~dp0
"%SCRIPT_DIR%..\node_modules\electron\dist\electron.exe" "%SCRIPT_DIR%cortex.mjs" %*
exit /b %ERRORLEVEL%
