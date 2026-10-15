@echo off
cd /d "%~dp0"
set /p visionCameraIndex="Indice camera DroidCam (0, 1, 2...) : "
".venv\Scripts\python.exe" "projet_portique_ contenaire_claude\vision\worker.py" --source camera --input "%visionCameraIndex%"
if errorlevel 1 pause
