@echo off
setlocal enabledelayedexpansion
title VEDETTA Agent
echo ============================================================
echo   VEDETTA Agent - launcher Windows (browser + NOC + icona tray)
echo ============================================================
echo.

rem --- Verifica Python ---
where python >nul 2>&1
if errorlevel 1 (
  echo [X] Python non trovato in PATH.
  echo     Installalo da https://www.python.org/downloads/
  echo     IMPORTANTE: durante l'installazione spunta "Add python.exe to PATH".
  echo     Poi richiudi questa finestra e ridoppioclicca su questo file.
  echo.
  pause
  exit /b 1
)

echo [*] Verifica dipendenze ^(psutil, pystray, pillow^)...
python -m pip install --quiet --disable-pip-version-check psutil pystray pillow
if errorlevel 1 (
  echo [!] Alcune dipendenze non si sono installate automaticamente
  echo     ^(continuo comunque: potrebbero mancare metriche o l'icona tray^).
  echo     Puoi installarle a mano con:
  echo         python -m pip install psutil pystray pillow
  echo.
)

rem --- Verifica che lo script sia accanto a questo .bat ---
set "AGENT=%~dp0vedetta-agent.py"
if not exist "%AGENT%" (
  echo [X] vedetta-agent.py non trovato nella cartella:
  echo     %~dp0
  echo     Scarica ENTRAMBI i file ^(vedetta-agent.py e vedetta-agent.bat^)
  echo     dalla console, nella stessa cartella, poi riprova.
  echo.
  pause
  exit /b 1
)

rem --- Trova pythonw.exe (avvio senza finestra nera, solo icona nella tray) ---
set "PYW="
for /f "delims=" %%i in ('where python 2^>nul') do (
  if not defined PYW (
    set "PYEXE=%%i"
    set "CANDIDATE=!PYEXE:python.exe=pythonw.exe!"
    if exist "!CANDIDATE!" set "PYW=!CANDIDATE!"
  )
)

set "CONFIG=%~dp0vedetta-agent.config.json"

if not exist "%CONFIG%" (
  echo [*] Primo avvio: configurazione guidata.
  echo     Ti verranno chieste URL console e Agent Key ^(e, solo se usi
  echo     la console multi-tenant Firebase, anche la Enroll Key^).
  echo.
  python "%AGENT%" --once %*
  echo.
  if not exist "%CONFIG%" (
    echo [X] Configurazione non completata ^(vedi eventuale errore sopra^).
    pause
    exit /b 1
  )
  echo [OK] Configurazione salvata in vedetta-agent.config.json
  echo.
)

if defined PYW (
  echo [*] Avvio VEDETTA Agent come applicazione in background...
  echo     Troverai la sua icona ^(triangolo^) nella barra delle applicazioni
  echo     in basso a destra, vicino all'orologio ^(potrebbe essere nascosta
  echo     nella freccetta "icone nascoste" — trascinala fuori per tenerla visibile^).
  echo     Questa finestra si chiudera' da sola tra pochi secondi.
  start "" "%PYW%" "%AGENT%" %*
  timeout /t 4 /nobreak >nul
  exit /b 0
) else (
  echo [!] pythonw.exe non trovato: avvio con finestra di console visibile.
  echo     ^(funziona comunque, ma non come "app silenziosa"^)
  echo.
  python "%AGENT%" %*
  echo.
  echo ------------------------------------------------------------
  echo   L'agente si e' fermato ^(vedi eventuali messaggi sopra^).
  echo ------------------------------------------------------------
  pause
)
