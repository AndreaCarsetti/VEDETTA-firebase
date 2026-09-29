# VEDETTA — Struttura del progetto

## Cartelle

- `functions/` — Cloud Functions Firebase / API VEDETTA.
- `server/public-mt/` — dashboard web pubblicata da Firebase Hosting e file agent distribuiti tramite la dashboard.
- `03-ESTENSIONE/` — estensione browser VEDETTA.
- `04-STRUMENTI/` — strumenti di migrazione e manutenzione.
- `00-DOCUMENTAZIONE/` — documentazione e istruzioni.

## File Firebase alla root

- `firebase.json` — configurazione Hosting + Functions.
- `firestore.rules` — regole Firestore.
- `firestore.indexes.json` — indici Firestore.
- `.gitignore` — esclusioni Git, inclusi i segreti `.env`.

## Importante

La struttura è organizzata per essere direttamente deployabile: non spostare `functions/` o `server/public-mt/` senza aggiornare `firebase.json`.

Non inserire mai `functions/.env` nel repository Git. Usare `functions/.env.example` come modello.
