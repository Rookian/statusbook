@echo off
title Statusbook
rem Double-click to start, or drag a folder onto this file to open it directly.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it with:  winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
node "%~dp0server.js" %*
if errorlevel 1 pause
