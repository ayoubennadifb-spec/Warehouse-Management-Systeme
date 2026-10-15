@echo off
cd /d "%~dp0"
".venv\Scripts\python.exe" "projet_portique_ contenaire_claude\vision\worker.py" --source demo
if errorlevel 1 pause
