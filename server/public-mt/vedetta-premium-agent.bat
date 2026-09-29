@echo off
setlocal enabledelayedexpansion
title VEDETTA Premium Agent
echo ============================================================
echo   VEDETTA Premium Agent - launcher Windows
echo   (tutti i browser + NOC)
echo ============================================================
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo [X] Python non trovato.
  echo     Installalo da https://www.python.org/downloads/  ^(spunta "Add python.exe to PATH"^)
  echo     poi rilancia questo file.
  echo.
  pause
  exit /b 1
)

echo [*] Installazione dipendenza psutil ^(metriche NOC complete^)...
python -m pip install --quiet --disable-pip-version-check psutil 2>nul

set "AGENT=%~dp0vedetta-premium-agent.py"
if not exist "%AGENT%" (
  echo [*] Scarico l'agente dalla console...
  set "AGENT=%TEMP%\vedetta-premium-agent.py"
  curl -s -o "!AGENT!" https://vedetta-24464.web.app/vedetta-premium-agent.py
  if not exist "!AGENT!" (
    echo [X] Download non riuscito. Metti vedetta-premium-agent.py nella stessa cartella di questo .bat.
    pause
    exit /b 1
  )
)

echo [*] Avvio agente Premium. Al primo avvio inserisci URL console, Agent key ed Enroll key.
echo     ^(La configurazione viene salvata in vedetta-premium.config.json^)
echo.
python "%AGENT%" %*
echo.
pause
