@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    py -3.12 -m venv .venv
    if errorlevel 1 goto :error
)
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :error
".venv\Scripts\python.exe" scripts\setup_local.py
if errorlevel 1 goto :error
".venv\Scripts\python.exe" scripts\setup_claude.py
if errorlevel 1 goto :error
echo Installation terminee. Ouvrez demarrer.bat.
pause
exit /b 0
:error
echo Installation interrompue. Consultez le message ci-dessus.
pause
exit /b 1
