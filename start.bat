@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите версию 20 или новее: https://nodejs.org
  pause
  exit /b 1
)
node server\index.js --open
pause
