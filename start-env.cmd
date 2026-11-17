@echo off
cd /d "%~dp0"
powershell.exe -NoLogo -NoExit -ExecutionPolicy Bypass -Command ". '.\scripts\enter-env.ps1'"
