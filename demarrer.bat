@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
 echo Lancez installer.bat une premiere fois.
 pause
 exit /b 1
)
".venv\Scripts\python.exe" scripts\local_runtime.py start
if errorlevel 1 pause
