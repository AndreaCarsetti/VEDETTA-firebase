# VEDETTA — Firebase Edition

VEDETTA è una console multitenant per eventi e monitoraggio endpoint. Questa versione usa **Firebase Hosting + Cloud Functions + Firestore** come infrastruttura ufficiale.

## Architettura

- `server/public-mt/` → dashboard PWA, agent e file pubblici serviti da Firebase Hosting
- `functions/index.js` → API Express su Cloud Functions
- Firestore → tenant, utenti, ruoli, sessioni, Agent Key, Enroll Key, regole, piattaforme, eventi, agenti, endpoint, telemetria, dispositivi e storico check
- `firestore.rules` → accesso diretto dal client negato; i dati passano dalle API Admin SDK
- `firestore.indexes.json` → indici necessari
- `firebase.json` → Hosting + rewrite `/api/**` verso la Function `api`

## Deploy

```bash
firebase login
firebase use <PROJECT_ID>
cd functions
npm install
cd ..
firebase deploy --only functions,hosting,firestore
```

Prima del primo deploy crea `functions/.env` partendo da `functions/.env.example` e imposta:

- `VEDETTA_OWNER_EMAIL`
- `VEDETTA_OWNER_PASSWORD` (almeno 12 caratteri)
- `VEDETTA_SESSION_SECRET`

Il bootstrap crea il primo tenant **solo se Firestore è vuoto**. Nei deploy successivi non ricrea né sovrascrive i dati.

## Git + Firebase

Git contiene il codice, non il database. Se due persone fanno pull e pubblicano sullo **stesso Firebase project**, vedono gli stessi dati Firestore. Se pubblicano su progetti Firebase diversi, i database restano separati.

Non committare mai `functions/.env`, credenziali di service account o chiavi private.

## Monitoraggio dispositivi

I check agentless vengono eseguiti dalla Cloud Function schedulata ogni minuto. Per un check TCP configurare una porta. Il vecchio check ICMP/ping locale non viene usato nel percorso Firebase perché Cloud Functions non garantisce il binario `ping`/ICMP.

## Versione locale SQLite

È stata rimossa dal percorso ufficiale di deploy. La vecchia v7 non deve essere avviata insieme a questa versione.
