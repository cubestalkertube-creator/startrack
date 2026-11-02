@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0client\scripts\build.ps1" -Release -Package
