@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TFT - local server (close to stop)
echo ============================================================
echo  TFT strategy simulation - local server starting...
echo  Browser will open: http://localhost:8765/tft/index.html
echo  To STOP: close this window.
echo ============================================================
echo.
start "" http://localhost:8765/tft/index.html
python -m http.server 8765 || py -m http.server 8765
