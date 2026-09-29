@echo off
setlocal enabledelayedexpansion
title VEDETTA Agent - Crea EXE (1 clic)
echo ============================================================
echo   VEDETTA Agent - creazione EXE nativo (Windows)
echo ============================================================
echo.
echo Questo strumento crea un vero VedettaAgent.exe autonomo
echo (non serve Python per usarlo dopo). Richiede una connessione a
echo internet solo per questa prima creazione.
echo.

rem --- Python richiesto solo per COSTRUIRE l'exe ---
where python >nul 2>&1
if errorlevel 1 (
  echo [X] Python non trovato.
  echo     Installalo da https://www.python.org/downloads/  ^(spunta "Add python.exe to PATH"^)
  echo     poi rilancia questo file.
  echo.
  pause
  exit /b 1
)

echo [*] Installazione strumenti di build ^(pyinstaller, psutil^)...
python -m pip install --quiet --disable-pip-version-check pyinstaller psutil pystray pillow
if errorlevel 1 (
  echo [X] Installazione dipendenze non riuscita. Verifica la connessione.
  pause
  exit /b 1
)

rem --- Sorgente accanto al .bat ---
set "SRC=%~dp0vedetta-agent.py"
if not exist "%SRC%" (
  echo [X] vedetta-agent.py non trovato accanto a questo .bat.
  echo     Scaricalo dalla console: pulsante "vedetta-agent.py" nella scheda Agenti Browser.
  pause
  exit /b 1
)

echo [*] Compilazione in corso ^(puo' richiedere 1-2 minuti^)...
set "WORK=%TEMP%\vedetta-agent-build"
set "OUT=%~dp0."
if exist "%WORK%" rmdir /s /q "%WORK%"
python -m PyInstaller --onefile --windowed --clean --noconfirm --name VedettaAgent --distpath "%OUT%" --workpath "%WORK%" --specpath "%WORK%" "%SRC%"

if not exist "%~dp0VedettaAgent.exe" (
  echo [X] Creazione EXE non riuscita. Controlla i messaggi qui sopra.
  pause
  exit /b 1
)

if exist "%WORK%" rmdir /s /q "%WORK%"
echo.
echo ============================================================
echo   [OK] Creato: %~dp0VedettaAgent.exe
echo   Doppio clic per avviarlo. Al primo avvio inserisci
echo   URL console e Agent key.
echo ============================================================
echo.
choice /c SN /m "Vuoi avviarlo adesso"
if errorlevel 2 goto :fine
start "" "%~dp0VedettaAgent.exe"
:fine
pause
