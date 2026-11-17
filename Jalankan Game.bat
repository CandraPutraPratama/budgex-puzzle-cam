@echo off
title BudgEx Puzzle-Cam
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python belum terpasang di laptop ini.
  echo Pasang dulu dari https://www.python.org/downloads/ lalu jalankan file ini lagi.
  pause
  exit /b 1
)

echo ==================================================
echo   BudgEx Puzzle-Cam berjalan di http://localhost:8080
echo   JANGAN tutup jendela hitam ini selama game dipakai.
echo   Untuk mematikan game: tutup jendela ini.
echo ==================================================

rem Open the browser 2 seconds later, once the server below is up.
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8080"

python serve.py 8080

echo.
echo Server berhenti. Kalau muncul error "address already in use",
echo kemungkinan game masih jalan di jendela lain.
pause
