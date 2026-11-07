@echo off
cd /d "%~dp0"
echo BREATH demo is starting at http://127.0.0.1:3977/
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:3977/"
node server.mjs
pause
