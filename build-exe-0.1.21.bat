@echo off
chcp 65001 >nul
title Сборка Startrack 0.1.21 (EXE + GitHub Release)
cd /d "%~dp0client"

echo ========================================================
echo   Сборка установщика Startrack 0.1.21 (x64-setup.exe)
echo ========================================================
echo.

if not exist node_modules (
    echo [1/3] Установка зависимостей npm...
    call npm install
    if errorlevel 1 goto :err
)

echo [2/3] Запуск сборки релизного установщика Startrack 0.1.21...
if exist "%USERPROFILE%\.tauri\startrack-updater.key" (
    node scripts/release.mjs 0.1.21 notes-0.1.21.md --no-android
) else (
    echo Ключ автообновления не найден, собираем стандартный установщик Startrack_0.1.21_x64-setup.exe...
    call npx tauri build
)
if errorlevel 1 goto :err

echo.
echo [3/3] Готово! Установщик находится в папке:
echo client\src-tauri\target\release\bundle\nsis\Startrack_0.1.21_x64-setup.exe
if exist "src-tauri\target\release\bundle\nsis" explorer "src-tauri\target\release\bundle\nsis"
pause
exit /b 0

:err
echo.
echo Ошибка при сборке! Проверьте наличие Node.js и Rust.
pause
exit /b 1
