# VEDETTA — architettura Firebase

Questa versione usa Firebase come fonte unica e persistente dei dati.

## Cosa NON viene più salvato in SQLite

- tenant/clienti
- utenti e ruoli
- password hash e TOTP
- sessioni
- Agent Key / Enroll Key
- regole e policy
- piattaforme/DOM
- eventi
- agenti
- endpoint NOC e telemetria
- dispositivi agentless
- storico dei check
- configurazione tenant

Tutti questi dati sono in Firestore.

## Deploy

1. Installa/aggiorna Firebase CLI.
2. Entra nel progetto Firebase corretto:

   `firebase login`

   `firebase use <PROJECT_ID>`

3. Crea `functions/.env` partendo da `functions/.env.example`.
4. Imposta una password owner di almeno 12 caratteri e un session secret lungo e casuale.
5. Installa le dipendenze:

   `cd functions`
   `npm install`

6. Dalla root del progetto:

   `firebase deploy --only functions,hosting`

Il primo deploy crea il tenant/owner iniziale **solo se Firestore non contiene ancora tenant**. Nei deploy successivi i dati esistenti non vengono ricreati né sovrascritti.

## Importazione dal vecchio SQLite

La vecchia v7 non deve essere usata insieme a questa versione. Il file SQLite locale era la fonte dei dati precedente. Prima di cancellarlo, esportalo/converti i dati in Firestore con uno script di migrazione dedicato.

## Importante

Git contiene il codice, non i dati Firestore. Questo è intenzionale: chiavi, password, utenti ed eventi non devono finire nel repository.

Se un altro amministratore fa clone/pull e pubblica sullo **stesso Firebase project**, vede gli stessi dati perché il database è Firestore. Se pubblica su un altro Firebase project, avrà ovviamente un database separato.
