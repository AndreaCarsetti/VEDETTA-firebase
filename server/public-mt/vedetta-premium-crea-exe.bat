@echo off
setlocal enabledelayedexpansion
title VEDETTA Premium Agent - Crea EXE (1 clic)
echo ============================================================
echo   VEDETTA Premium Agent - creazione EXE nativo (Windows)
echo ============================================================
echo.
echo Questo strumento crea un vero VedettaPremiumAgent.exe autonomo
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
python -m pip install --quiet --disable-pip-version-check pyinstaller psutil
if errorlevel 1 (
  echo [X] Installazione dipendenze non riuscita. Verifica la connessione.
  pause
  exit /b 1
)

rem --- Sorgente accanto al .bat, altrimenti scaricalo ---
set "SRC=%~dp0vedetta-premium-agent.py"
if not exist "%SRC%" (
  echo [*] Scarico il sorgente dell'agente dalla console...
  set "SRC=%TEMP%\vedetta-premium-agent.py"
  curl -s -o "!SRC!" https://vedetta-24464.web.app/vedetta-premium-agent.py
  if not exist "!SRC!" (
    echo [X] Download non riuscito. Metti vedetta-premium-agent.py accanto a questo .bat.
    pause
    exit /b 1
  )
)

echo [*] Compilazione in corso ^(puo' richiedere 1-2 minuti^)...
set "WORK=%TEMP%\vedetta-premium-build"
if exist "%WORK%" rmdir /s /q "%WORK%"
python -m PyInstaller --onefile --windowed --clean --noconfirm ^
  --name VedettaPremiumAgent ^
  --distpath "%~dp0" ^
  --workpath "%WORK%" ^
  --specpath "%WORK%" ^
  "%SRC%"

if not exist "%~dp0VedettaPremiumAgent.exe" (
  echo [X] Creazione EXE non riuscita. Controlla i messaggi qui sopra.
  pause
  exit /b 1
)

if exist "%WORK%" rmdir /s /q "%WORK%"
echo.
echo ============================================================
echo   [OK] Creato: %~dp0VedettaPremiumAgent.exe
echo   Doppio clic per avviarlo. Al primo avvio inserisci
echo   URL console, Agent key ed Enroll key.
echo ============================================================
echo.
choice /c SN /m "Vuoi avviarlo adesso"
if errorlevel 2 goto :fine
start "" "%~dp0VedettaPremiumAgent.exe"
:fine
pause
