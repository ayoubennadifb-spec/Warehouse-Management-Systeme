@echo off
cd /d "%~dp0"
".venv\Scripts\python.exe" scripts\generate_vision_data.py --count 20 --length-mm 200 --width-mm 90 --height-mm 90
pause
