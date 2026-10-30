@echo off
cd /d "%~dp0"
if not exist "secrets.bat" (
  echo [ERROR] Missing secrets.bat. Copy secrets.example.bat and set two keys.
  exit /b 1
)
call "secrets.bat"
node server.js
