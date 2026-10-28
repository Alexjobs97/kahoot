# Quiz in aula

Quiz in tempo reale in stile Kahoot: l'istruttore proietta le domande, gli studenti rispondono dal telefono, senza app e senza registrazione.

Funziona in due modi, con lo stesso codice:

| | **GitHub Pages** (consigliato) | **Server Node** (facoltativo) |
|---|---|---|
| Installazione | nessuna: apri un indirizzo fisso | `npm install` + `npm start` |
| Wi-Fi | qualsiasi, anche 4G | stessa rete, oppure tunnel |
| Come funziona | il browser dell'istruttore fa da server, gli studenti si collegano a lui (WebRTC) | il server Node fa da tramite (WebSocket) |

## Pubblicare su GitHub Pages (una volta sola)

1. Crea un repository su GitHub e carica tutto il contenuto di questa cartella (compresa la cartella nascosta `.github`).
2. Nel repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Dopo il primo caricamento (ramo `main`) parte da solo il workflow «Pubblica su GitHub Pages». Quando è verde, il sito è su `https://TUO-NOME.github.io/NOME-REPOSITORY/`.

Da quel momento:
- **Istruttore:** apri `https://TUO-NOME.github.io/NOME-REPOSITORY/host.html` (mettila nei preferiti).
- **Studenti:** QR code, oppure il link che mandi su WhatsApp dal pulsante «Invia su WhatsApp».
- **Archivio domande:** sostituisci `public/quiz.txt` con il tuo file e fai commit. Il sito si aggiorna da solo in un minuto circa.

Alternativa senza workflow: carica solo il contenuto della cartella `public` nella radice del repository e scegli **Source: Deploy from a branch → main / (root)**.

## Come si usa

1. Apri il pannello istruttore. Di base usa l'**Archivio del sito** (`quiz.txt`); con **Carica un file mio** puoi usarne un altro (o incollare il testo).
2. Scegli **quante domande** fare, quali **categorie** includere o escludere e le impostazioni (vedi sotto). Premi **Crea la stanza**.
3. Mostra il QR code sul proiettore, oppure **Invia su WhatsApp** / **Copia il link**. Gli studenti scrivono il nome e sono dentro.
4. **Avvia il quiz**. Per ogni domanda vedi chi ha risposto in tempo reale; puoi **bloccare le risposte** quando vuoi, poi **Domanda successiva**.
5. Alla fine: podio, classifica, percentuale di risposte giuste per domanda e risultati in Excel (CSV).

## Formato di `quiz.txt`

```
1/16) Testo della domanda
a. risposta GIUSTA
b. risposta sbagliata
c. risposta sbagliata
d. risposta sbagliata

3/12/15) Altra domanda
a. ...
```

Il numero prima della parentesi è la **categoria**; con più categorie si separano con `/`.

| 1 Traumatico | 7 Intossicazione | 13 Dermatologico |
|---|---|---|
| 2 Cardiocircolatorio | 8 Metabolico | 14 Ostetrico-ginecologico |
| 3 Respiratorio | 9 Gastroenterologico | 15 Infettivo |
| 4 Neurologico | 10 Urologico | 16 Pediatrico |
| 5 Psichiatrico | 11 Oculistico | 17 Altro |
| 6 Neoplastico | 12 Otorinolaringoiatrico | |

- La risposta **a.** è sempre quella giusta; sullo schermo e sui telefoni l'ordine viene mescolato a ogni domanda.
- Una domanda senza categoria valida (mancante, o numero fuori da 1–17) viene messa in «Altro» e segnalata tra gli avvisi.
- Accettati anche `1.`, `A)`, `(a)`, domande o risposte su più righe, righe vuote in più, accenti salvati da Word/Blocco note.
- La prima riga `# Titolo` imposta il titolo del quiz; le altre righe `#` prima delle domande sono commenti.
- Le domande incomplete vengono segnalate con il numero di riga e saltate; le altre si caricano.

## Scelta delle domande

- **Quante:** scrivi il numero (o usa − + e «Tutte»). Le domande sono estratte a caso dall'insieme disponibile.
- **Categorie** (clic ciclico): un clic la **sceglie**, un secondo la **esclude**, un terzo la **toglie**.
  - Con categorie scelte, una domanda è valida se **almeno una** delle sue categorie è scelta.
  - Una categoria esclusa elimina **tutte** le domande che la contengono, anche se hanno altre categorie scelte (scelgo 1, 3, 15 e escludo la 14: `7/14/15` non esce).
  - Se non scegli nulla valgono tutte; se escludi soltanto, valgono tutte tranne le escluse.
- **Errore:** se chiedi più domande di quelle disponibili con i filtri, compare il messaggio (es. «Hai chiesto 20 domande, ma con questi filtri ce ne sono solo 6») e il pulsante resta bloccato.
- **Rotazione** (attiva di base): ogni domanda ricorda quante volte è uscita; si estraggono prima quelle uscite meno volte e, a parità, a caso. Così, di quiz in quiz, escono tutte prima che qualcuna si ripeta (100 domande, quiz da 20: in 5 quiz le vedi tutte una volta), e le domande nuove aggiunte al file vengono usate subito. La memoria sta nel browser dell'istruttore (non occupa nulla altrove) e si azzera con il pulsante dedicato; puoi anche spegnere la rotazione per un sorteggio puro.

## Impostazioni

| Impostazione | Opzioni |
|---|---|
| Telefono studenti | **Lettere e testo** (domanda e risposte anche sul telefono) oppure **Solo lettere A B C D** (si legge dal proiettore) |
| Tempo | **Tempo limite** (5–300 secondi; si passa alla correzione anche appena hanno risposto tutti) oppure **Si aspettano tutti** (nessun limite; si passa quando tutti hanno risposto o quando premi «Blocca le risposte») |
| Punteggio | Risposta giusta = 1000 punti; con **bonus velocità** da 1000 (subito) a 500 (all'ultimo istante). Senza limite di tempo il bonus conta i primi 30 secondi. Sbagliata o assente = 0 |
| Ordine | Domande nell'ordine del file oppure mescolate (di base mescolate) |

Le impostazioni si possono cambiare anche tra una domanda e l'altra. A parità di punti vince chi ha più risposte giuste, poi chi è stato più veloce.

## Da sapere sulla modalità GitHub Pages

- **Il tuo browser è il server.** Tieni aperta la scheda dell'istruttore e il computer acceso (lo schermo resta sveglio da solo). Se la ricarichi o la chiudi per sbaglio, riaprendo `host.html` la stanza riprende da dove era e gli studenti rientrano da soli. Non aprirla in due schede contemporaneamente.
- **Servizio di «presentazione».** Telefoni e computer si trovano tramite il servizio gratuito pubblico di PeerJS; poi le risposte viaggiano direttamente fra i dispositivi. Il servizio non ha garanzie di disponibilità: se un giorno non fosse raggiungibile compare un messaggio chiaro e puoi passare al server Node. Volendo, in `public/config.js` puoi indicare un servizio tuo (`window.QUIZ_PEER`).
- **Reti restrittive.** Di norma funziona anche con Wi-Fi aziendali e 4G (sono usati server di appoggio gratuiti); se qualche telefono non si collega, provare con i dati mobili.
- **Codice sbagliato:** lo studente vede «Stanza non trovata» dopo circa 10 secondi.

## Modalità server Node (facoltativa)

Serve [Node.js](https://nodejs.org) 16+.

```bash
npm install
npm start          # poi apri http://localhost:3000/host
```

I telefoni devono raggiungere il computer: stessa rete Wi-Fi (se la rete isola i dispositivi, usa un hotspot), oppure un tunnel:

```bash
npx cloudflared tunnel --url http://localhost:3000
PUBLIC_URL=https://....trycloudflare.com npm start
```

Oppure carica la cartella su un hosting con WebSocket (Render, Railway, Fly.io…): comando di avvio `npm start`, porta da `PORT`.

## Struttura e test

```
public/            il sito (è ciò che va su GitHub Pages)
  quiz.txt         archivio predefinito delle domande
  parser.js        lettura del file, filtri, ban, rotazione
  engine.js        motore di gioco (usato nel browser e dal server Node)
  p2p.js           collegamento WebRTC          common.js / config.js  scelta del collegamento
  host.html/js     pannello istruttore          index.html / student.js  pagina studenti
  vendor/          PeerJS e generatore di QR code (copiati qui, nessun CDN)
server.js          server Node facoltativo
test.js            test del parser, delle selezioni e del motore (npm test)
test-p2p.js        test con browser veri in WebRTC (npm i --no-save peer playwright && npm run test:p2p)
```
