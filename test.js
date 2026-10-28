'use strict';
/* Test automatici: parser + partite complete con client simulati.  Esegui: npm test */
const assert = require('assert');
const fs = require('fs');
const WebSocket = require('ws');
const { start } = require('./server.js');
const { parse } = require('./public/parser.js');

let passed = 0;
const ok = (name) => { passed++; console.log('  ✔', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────── parser ───────── */
function testParser() {
  console.log('Parser');
  let r = parse(fs.readFileSync('./public/esempio-domande.txt', 'utf8'));
  assert.strictEqual(r.questions.length, 6);
  assert.strictEqual(r.title, 'Quiz di prova');
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.warnings.length, 0);
  assert.strictEqual(r.questions[0].options[0], 'Roma');
  assert.strictEqual(r.questions[0].correct, 0);
  ok('file di esempio: 6 domande, titolo, nessun errore');

  r = parse('﻿1) Domanda uno\r\na. giusta\r\nb. x\r\nc. y\r\nd. z\r\n\r\n\r\n2) Due\r\na. g\r\nb. x\r\nc. y\r\nd. z');
  assert.strictEqual(r.questions.length, 2);
  ok('BOM, CRLF, righe vuote multiple');

  r = parse('1. Dose di 3.5 mg\nA) uno\nB) due\nC) tre\nD) quattro\n2 - Seconda\n(a) sì\n(b) no\n(c) forse\n(d) mai\n3: Terza\na: x\nb: y\nc: z\nd: w');
  assert.strictEqual(r.questions.length, 3);
  assert.strictEqual(r.questions[0].text, 'Dose di 3.5 mg');
  assert.strictEqual(r.questions[1].options[0], 'sì');
  assert.strictEqual(r.questions[2].options[3], 'w');
  ok('varianti di numerazione e lettere ("1." "2 -" "3:", "A)", "(a)", "a:")');

  r = parse('1) Domanda molto lunga\nche va a capo\na. risposta giusta\nche continua\nb. due\nc. tre\nd. quattro');
  assert.strictEqual(r.questions[0].text, 'Domanda molto lunga che va a capo');
  assert.strictEqual(r.questions[0].options[0], 'risposta giusta che continua');
  ok('domande e risposte su più righe');

  r = parse('1) Uno\na. g\nb. x\nc. y\nd. z\n\nDomanda senza numero\na. g\nb. x\nc. y\nd. z');
  assert.strictEqual(r.questions.length, 2);
  ok('domanda senza numero dopo riga vuota');

  r = parse('1) Solo due\na. g\nb. x\n2) Una sola\na. g\n3) Nessuna\n4) Ok\na. g\nb. x\nc. y\nd. z');
  assert.strictEqual(r.questions.length, 2);
  assert.strictEqual(r.errors.length, 2);
  assert.ok(r.warnings.length >= 1);
  ok('domande incomplete: segnalate/ignorate, le altre salvate');

  r = parse('niente di utile qui');
  assert.strictEqual(r.questions.length, 0);
  assert.ok(r.errors.length >= 1);
  ok('file senza domande → errore chiaro');
}

/* ───────── client WebSocket ───────── */
function client(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port);
  const all = [];
  let cursor = 0;
  const wake = [];
  ws.on('message', (d) => { all.push(JSON.parse(d)); wake.splice(0).forEach((f) => f()); });
  return {
    ws, all,
    open: new Promise((res) => ws.on('open', res)),
    send: (o) => ws.send(JSON.stringify(o)),
    async waitFor(pred, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        while (cursor < all.length) { const m = all[cursor++]; if (pred(m)) return m; }
        const left = end - Date.now();
        if (left <= 0) throw new Error('timeout; ultimi messaggi: ' + JSON.stringify(all.slice(-3)).slice(0, 500));
        await new Promise((r) => { wake.push(r); setTimeout(r, left); });
      }
    },
    last: (pred) => [...all].reverse().find(pred),
    close: () => ws.close(),
  };
}

const QUIZ = `# Test
1) Capitale d'Italia?
a. Roma
b. Milano
c. Napoli
d. Torino

2) Lati di un esagono?
a. Sei
b. Cinque
c. Otto
d. Dieci

3) Pianeta più vicino al Sole?
a. Mercurio
b. Venere
c. Marte
d. Giove`;

async function joiner(port, code, name) {
  const c = client(port);
  await c.open;
  c.send({ t: 'join', code, name });
  const j = await c.waitFor((m) => m.t === 'joined');
  c.tok = j.token;
  return c;
}

async function testTimedGame() {
  console.log('Partita (tempo limite, testo sul telefono, bonus velocità)');
  const srv = await start(0);
  const port = srv.port;
  const host = client(port);
  await host.open;
  host.send({ t: 'host_create', text: QUIZ, title: 'Prova', settings: { mode: 'timed', timeLimit: 5, showOptionsOnPhone: true, speedBonus: true } });
  const info = await host.waitFor((m) => m.t === 'host_info');
  assert.match(info.code, /^\d{4}$/);
  assert.ok(info.qr.startsWith('data:image/png'));
  assert.ok(info.joinUrl.includes('?c=' + info.code));
  ok('stanza creata, QR e link generati');

  const anna = await joiner(port, info.code, 'Anna');
  const bruno = await joiner(port, info.code, 'Bruno');
  const dup = client(port); await dup.open; dup.send({ t: 'join', code: info.code, name: 'anna' });
  assert.strictEqual((await dup.waitFor((m) => m.t === 'join_error')).code, 'dup');
  ok('nome duplicato rifiutato');
  const bad = client(port); await bad.open; bad.send({ t: 'join', code: '0000', name: 'X' });
  assert.strictEqual((await bad.waitFor((m) => m.t === 'join_error')).code, 'nocode');
  ok('codice sbagliato rifiutato');

  await host.waitFor((m) => m.t === 'host_state' && m.players.length === 2);
  ok('istruttore vede i 2 studenti');

  host.send({ t: 'start' });
  const hq = await host.waitFor((m) => m.t === 'host_state' && m.phase === 'question');
  assert.strictEqual(hq.question.options.length, 4);
  assert.strictEqual(hq.correctPos, undefined);
  const aq = await anna.waitFor((m) => m.t === 'p_state' && m.phase === 'question');
  assert.strictEqual(aq.correctPos, undefined);
  assert.strictEqual(aq.question.options.join(), hq.question.options.join());
  ok('domanda mostrata; la risposta giusta non viene rivelata durante la domanda');

  // le opzioni devono essere mescolate: la giusta non deve stare sempre in prima posizione
  const right = { "Capitale d'Italia?": 'Roma', 'Lati di un esagono?': 'Sei', 'Pianeta più vicino al Sole?': 'Mercurio' }[hq.question.text];
  const correct = hq.question.options.indexOf(right);
  assert.ok(correct >= 0);
  const wrong = (correct + 1) % 4;

  await sleep(300);
  anna.send({ t: 'answer', choice: correct });
  await host.waitFor((m) => m.t === 'host_answers' && m.answeredCount === 1);
  bruno.send({ t: 'answer', choice: wrong });
  const rev = await host.waitFor((m) => m.t === 'host_state' && m.phase === 'reveal');
  assert.strictEqual(rev.correctPos, correct);
  assert.strictEqual(rev.counts[correct], 1);
  assert.strictEqual(rev.counts[wrong], 1);
  ok('tutti hanno risposto → correzione automatica');

  const ar = await anna.waitFor((m) => m.t === 'p_state' && m.phase === 'reveal');
  const br = await bruno.waitFor((m) => m.t === 'p_state' && m.phase === 'reveal');
  assert.ok(ar.result.correct && ar.result.points > 900 && ar.result.points <= 1000, 'punti Anna ' + ar.result.points);
  assert.ok(!br.result.correct && br.result.points === 0);
  assert.strictEqual(ar.rank, 1);
  assert.strictEqual(br.rank, 2);
  ok(`punteggi: Anna +${ar.result.points} (1ª), Bruno 0 (2º)`);

  anna.send({ t: 'answer', choice: 0 }); // fuori fase: ignorata
  host.send({ t: 'next' });
  await host.waitFor((m) => m.t === 'host_state' && m.phase === 'question' && m.qNum === 2);
  const t0 = Date.now();
  const rev2 = await host.waitFor((m) => m.t === 'host_state' && m.phase === 'reveal' && m.qNum === 2, 9000);
  const dt = Date.now() - t0;
  assert.ok(dt >= 4800 && dt < 7500, 'scaduto dopo ' + dt + ' ms');
  assert.deepStrictEqual(rev2.counts, [0, 0, 0, 0]);
  ok('tempo scaduto → correzione automatica (~5 s)');
  const br2 = await bruno.waitFor((m) => m.t === 'p_state' && m.phase === 'reveal' && m.qNum === 2);
  assert.strictEqual(br2.result.answered, false);
  ok('chi non risponde: 0 punti');

  host.send({ t: 'end' });
  const fin = await host.waitFor((m) => m.t === 'host_state' && m.phase === 'finished');
  assert.strictEqual(fin.played.length, 2);
  assert.strictEqual(fin.leaderboard[0].name, 'Anna');
  assert.strictEqual(fin.results.length, 2);
  assert.strictEqual(fin.results[0].cells.length, 2);
  assert.ok(fin.results[0].cells[0] > 900 && fin.results[0].cells[1] === null);
  ok('fine anticipata: classifica finale e risultati per domanda');

  host.send({ t: 'restart' });
  const lob = await host.waitFor((m) => m.t === 'host_state' && m.phase === 'lobby' && m.leaderboard.length === 0);
  assert.strictEqual(lob.players.length, 2);
  assert.ok(lob.players.every((p) => p.score === 0));
  ok('rigioca: punti azzerati, studenti mantenuti');

  [host, anna, bruno, dup, bad].forEach((c) => c.close());
  await srv.close();
}

async function testWaitGame() {
  console.log('Partita (si aspettano tutti, solo lettere, senza bonus)');
  const srv = await start(0);
  const port = srv.port;
  const host = client(port);
  await host.open;
  host.send({ t: 'host_create', text: QUIZ, settings: { mode: 'wait', showOptionsOnPhone: false, speedBonus: false, shuffleQuestions: true } });
  const info = await host.waitFor((m) => m.t === 'host_info');
  const p1 = await joiner(port, info.code, 'Luca');
  const p2 = await joiner(port, info.code, 'Marta');
  const p3 = await joiner(port, info.code, 'Nino');

  host.send({ t: 'start' });
  const hq = await host.waitFor((m) => m.t === 'host_state' && m.phase === 'question');
  assert.strictEqual(hq.remainingMs, null);
  const right = { "Capitale d'Italia?": 'Roma', 'Lati di un esagono?': 'Sei', 'Pianeta più vicino al Sole?': 'Mercurio' }[hq.question.text];
  const cp = hq.question.options.indexOf(right);
  assert.ok(cp >= 0);
  const pq = await p1.waitFor((m) => m.t === 'p_state' && m.phase === 'question');
  assert.strictEqual(pq.question, undefined);
  assert.strictEqual(pq.nOptions, 4);
  assert.strictEqual(pq.remainingMs, null);
  ok('modalità "solo lettere": il telefono non riceve testo di domanda/risposte');

  p1.send({ t: 'answer', choice: cp });
  p2.send({ t: 'answer', choice: cp });
  await host.waitFor((m) => m.t === 'host_answers' && m.answeredCount === 2);
  await sleep(300);
  assert.strictEqual(host.last((m) => m.t === 'host_state').phase, 'question');
  ok('se manca uno studente non si passa alla correzione');

  p3.close(); // si disconnette: non blocca più
  const rev = await host.waitFor((m) => m.t === 'host_state' && m.phase === 'reveal');
  assert.strictEqual(rev.leaderboard[0].delta, 1000);
  ok('uno studente si disconnette → si procede; punti fissi (1000) senza bonus');

  const p1b = client(port);
  await p1b.open;
  p1b.send({ t: 'join', code: info.code, token: p1.tok });
  const back = await p1b.waitFor((m) => m.t === 'p_state');
  assert.strictEqual(back.score, 1000);
  assert.strictEqual(back.name, 'Luca');
  ok('riconnessione con token: punti e nome recuperati');

  const p3b = client(port);
  await p3b.open;
  p3b.send({ t: 'join', code: info.code, name: 'nino' });
  assert.ok(await p3b.waitFor((m) => m.t === 'joined'));
  ok('ritorno con lo stesso nome dopo una disconnessione');

  const marta = host.last((m) => m.t === 'host_state').players.find((p) => p.name === 'Marta');
  host.send({ t: 'kick', pid: marta.pid });
  await p2.waitFor((m) => m.t === 'kicked');
  ok('rimozione di uno studente');

  host.send({ t: 'next' });
  await host.waitFor((m) => m.t === 'host_state' && m.phase === 'question' && m.qNum === 2);
  host.send({ t: 'lock' });
  await host.waitFor((m) => m.t === 'host_state' && m.phase === 'reveal' && m.qNum === 2);
  ok('blocco manuale delle risposte');

  host.send({ t: 'next' });
  await host.waitFor((m) => m.t === 'host_state' && m.qNum === 3 && m.phase === 'question');
  host.send({ t: 'lock' });
  await host.waitFor((m) => m.t === 'host_state' && m.phase === 'reveal' && m.qNum === 3);
  host.send({ t: 'next' });
  const fin = await host.waitFor((m) => m.t === 'host_state' && m.phase === 'finished');
  assert.strictEqual(fin.played.length, 3);
  ok('ultima domanda → classifica finale');

  host.send({ t: 'close' });
  await p1b.waitFor((m) => m.t === 'room_gone');
  ok('chiusura stanza notificata agli studenti');

  [host, p1, p2, p3, p1b, p3b].forEach((c) => c.close());
  await srv.close();
}


/* ───────── categorie, filtri, rotazione ───────── */
function mkPool() {
  // 100 domande: categoria = (i % 17) + 1, ogni 5ª ha anche una seconda categoria
  let txt = '';
  for (let i = 0; i < 100; i++) {
    const c = (i % 17) + 1;
    const cats = i % 5 === 0 ? c + '/' + (((i + 7) % 17) + 1) : String(c);
    txt += `${cats}) Domanda numero ${i}\na. giusta ${i}\nb. x\nc. y\nd. z\n\n`;
  }
  return parse(txt);
}

function testCategories() {
  console.log('Categorie e selezione');
  const P = require('./public/parser.js');
  let r = parse('1/16) Uno\na. g\nb. x\nc. y\nd. z\n\n3/12/15) Due\na. g\nb. x\nc. y\nd. z\n\n3 / 3 / 4) Tre\na. g\nb. x\nc. y\nd. z');
  assert.deepStrictEqual(r.questions.map((q) => q.cats), [[1, 16], [3, 12, 15], [3, 4]]);
  assert.strictEqual(r.errors.length, 0); assert.strictEqual(r.warnings.length, 0);
  ok('prefisso "1/16)", "3/12/15)", spazi e duplicati → elenco di categorie');

  r = parse('20) Fuori\na. g\nb. x\nc. y\nd. z\n\n4/99) Mista\na. g\nb. x\nc. y\nd. z');
  assert.deepStrictEqual(r.questions.map((q) => q.cats), [[17], [4]]);
  assert.strictEqual(r.warnings.length, 2); ok('categorie non valide: avviso, finisce in "Altro" / viene ignorata');

  r = parse('# Titolo\n# commento\n1) Q\na. g\nb. x\nc. y\nd. z');
  assert.strictEqual(r.title, 'Titolo'); assert.strictEqual(r.warnings.length, 0); ok('righe # dopo il titolo = commenti silenziosi');

  r = parse('1/2) Domanda con fraz 1/2 compressa\nsu due righe\na. 1/2 dose\nb. x\nc. y\nd. z');
  assert.strictEqual(r.questions.length, 1); assert.strictEqual(r.questions[0].options[0], '1/2 dose'); ok('"1/2" dentro il testo non confonde il parser');

  const pool = parse(
    '1) A\na. g\nb. x\nc. y\nd. z\n\n7/14/15) B\na. g\nb. x\nc. y\nd. z\n\n3/12) C\na. g\nb. x\nc. y\nd. z\n\n15) D\na. g\nb. x\nc. y\nd. z\n\n2) E\na. g\nb. x\nc. y\nd. z').questions;
  const names = (qs) => qs.map((q) => q.text).join('');
  assert.strictEqual(names(P.filterPool(pool, { include: [], ban: [] })), 'ABCDE');
  assert.strictEqual(names(P.filterPool(pool, { include: [1, 3, 15], ban: [] })), 'ABCD');
  assert.strictEqual(names(P.filterPool(pool, { include: [1, 3, 15], ban: [14] })), 'ACD');   // 7/14/15 esclusa dal ban di 14
  assert.strictEqual(names(P.filterPool(pool, { include: [], ban: [15] })), 'ACE');            // nessuna scelta + ban = tutte tranne le bandite
  assert.strictEqual(names(P.filterPool(pool, { include: [12], ban: [] })), 'C');              // basta una categoria della domanda
  assert.strictEqual(names(P.filterPool(pool, { include: [3], ban: [3] })), '');               // il ban vince
  ok('filtri: scelta (basta una categoria), ban (vince su tutto), nessuna scelta = tutte tranne le bandite');

  assert.ok(/solo 5/.test(P.checkCount(5, 6))); assert.strictEqual(P.checkCount(5, 5), null);
  assert.ok(P.checkCount(0, 1)); assert.ok(P.checkCount(5, 0)); assert.ok(P.checkCount(5, NaN)); assert.ok(P.checkCount(5, 2.5));
  assert.ok(P.pickQuestions(pool, 6).error); assert.strictEqual(P.pickQuestions(pool, 3).questions.length, 3);
  ok('errore se le domande disponibili sono meno di quelle richieste');

  const big = mkPool().questions;
  assert.strictEqual(big.length, 100);
  const counts = P.categoryCounts(big); assert.ok(Object.values(counts).every((n) => n > 0));
  const sel = P.pickQuestions(P.filterPool(big, { include: [3, 2], ban: [] }), 4).questions;
  assert.ok(sel.every((q) => q.cats.includes(2) || q.cats.includes(3)));
  ok('estrazione da pool filtrato: tutte appartengono alle categorie scelte');

  // copertura: 5 quiz da 20 su 100 domande con rotazione → ogni domanda esce esattamente una volta
  let usage = {}; const seen = new Map();
  for (let round = 0; round < 5; round++) {
    const res = P.pickQuestions(big, 20, usage);
    assert.strictEqual(res.questions.length, 20); assert.strictEqual(new Set(res.questions.map((q) => q.n)).size, 20);
    res.questions.forEach((q) => seen.set(q.n, (seen.get(q.n) || 0) + 1));
    usage = P.bumpUsage(usage, res.questions);
  }
  assert.strictEqual(seen.size, 100); assert.ok([...seen.values()].every((v) => v === 1));
  ok('rotazione: in 5 quiz da 20 escono tutte e 100 le domande, senza ripetizioni');

  // dopo il giro completo si riparte e nessuna resta indietro
  for (let round = 0; round < 5; round++) { const res = P.pickQuestions(big, 20, usage); usage = P.bumpUsage(usage, res.questions); }
  const uses = big.map((q) => usage[P.hashQ(q)]); assert.ok(uses.every((u) => u === 2)); ok('secondo giro: tutte uscite due volte');

  // domande nuove nel file hanno la precedenza; senza rotazione è sorteggio puro
  const fresh = parse('1) Nuova\na. g\nb. x\nc. y\nd. z').questions[0]; fresh.n = 101;
  const withNew = P.pickQuestions(big.concat([fresh]), 1, usage).questions[0]; assert.strictEqual(withNew.text, 'Nuova');
  const flat = new Set(); for (let i = 0; i < 40; i++) flat.add(P.pickQuestions(big, 1, usage, { rotate: false }).questions[0].n);
  assert.ok(flat.size > 5); ok('domande nuove subito in rotazione; senza rotazione estrazione casuale');

  // senza rotazione ogni domanda ha la stessa probabilità (test grossolano)
  const hits = new Array(10).fill(0); const ten = big.slice(0, 10);
  for (let i = 0; i < 3000; i++) hits[P.pickQuestions(ten, 1, {}, { rotate: false }).questions[0].n - 1]++;
  assert.ok(hits.every((h) => h > 200 && h < 400), 'distribuzione ' + hits.join(',')); ok('sorteggio uniforme (3000 estrazioni su 10 domande)');
}

async function testServerQuestions() {
  console.log('Creazione stanza con domande già scelte + ripristino');
  const srv = await start(0); const port = srv.port;
  const host = client(port); await host.open;
  host.send({ t: 'host_create', questions: [
    { text: 'D1?', options: ['giusta', 'x', 'y', 'z'], cats: [3] },
    { text: 'D2?', options: ['giusta2', 'x', 'y'] },
    { text: '', options: ['a', 'b'] }, { text: 'senza opzioni', options: ['solo una'] }, 'spazzatura',
  ], title: 'Da archivio', settings: { mode: 'wait' } });
  await host.waitFor((m) => m.t === 'host_info');
  const st = await host.waitFor((m) => m.t === 'host_state');
  assert.strictEqual(st.qTotal, 2); assert.strictEqual(st.title, 'Da archivio'); ok('solo le domande valide entrano nella stanza');
  host.send({ t: 'host_create', questions: [] });
  const bad = client(port); await bad.open; bad.send({ t: 'host_create', questions: [{ text: '', options: [] }] });
  assert.strictEqual((await bad.waitFor((m) => m.t === 'error')).code, 'noquestions'); ok('nessuna domanda valida → errore');
  [host, bad].forEach((c) => c.close()); await srv.close();

  // snapshot/restore del motore
  const Engine = require('./public/engine.js');
  const mkWs = () => { const w = { readyState: 1, ctx: null, out: [], send(s) { w.out.push(JSON.parse(s)); }, close() { w.readyState = 3; } }; return w; };
  let saved = null;
  const e1 = Engine.create({ persist: (s) => { saved = JSON.parse(JSON.stringify(s)); } });
  const h1 = mkWs();
  const room = e1.createRoom(h1, { questions: [{ text: 'Q1?', options: ['r', 'a', 'b', 'c'] }, { text: 'Q2?', options: ['r2', 'a', 'b', 'c'] }], settings: { mode: 'wait' } }, { code: '4321', joinUrl: 'http://x/?c=4321', qr: 'data:' });
  const pl = mkWs(); e1.handle(pl, { t: 'join', code: '4321', name: 'Zeno' });
  const tok = pl.out.find((m) => m.t === 'joined').token;
  e1.handle(h1, { t: 'start' });
  const cp = room.current.correctPos; // lo stato inviato all'istruttore non lo contiene durante la domanda
  e1.handle(pl, { t: 'answer', choice: cp });                           // unico giocatore → correzione automatica
  assert.strictEqual(h1.out.filter((m) => m.t === 'host_state').pop().phase, 'reveal');
  const score = room.players.values().next().value.score; assert.ok(score > 0);
  ok('motore: partita in locale con un giocatore');

  // simulo la ricarica della pagina dell'istruttore: nuovo motore dallo snapshot
  const e2 = Engine.create();
  const r2 = e2.restore(saved); assert.ok(r2); assert.strictEqual(r2.phase, 'reveal');
  const h2 = mkWs(); e2.handle(h2, { t: 'host_resume', code: '4321', hostToken: saved.hostToken });
  assert.ok(h2.out.find((m) => m.t === 'host_info')); const hs = h2.out.filter((m) => m.t === 'host_state').pop();
  assert.strictEqual(hs.phase, 'reveal'); assert.strictEqual(hs.correctPos, cp); assert.strictEqual(hs.leaderboard[0].score, score);
  const pl2 = mkWs(); e2.handle(pl2, { t: 'join', code: '4321', token: tok });
  const back = pl2.out.filter((m) => m.t === 'p_state').pop(); assert.strictEqual(back.name, 'Zeno'); assert.strictEqual(back.score, score);
  assert.strictEqual(back.result.correct, true);
  ok('ripristino dopo ricarica: fase di correzione, punteggi e studente (via token) recuperati');
  e2.handle(h2, { t: 'next' });
  assert.strictEqual(h2.out.filter((m) => m.t === 'host_state').pop().phase, 'question'); ok('dopo il ripristino si può proseguire');
  // snapshot a metà domanda → la domanda riparte
  const snapQ = JSON.parse(JSON.stringify(e2.snapshot(r2)));
  const e3 = Engine.create(); const r3 = e3.restore(snapQ); assert.strictEqual(r3.phase, 'question'); assert.strictEqual(r3.current.answers.size, 0);
  clearTimeout(r3.current.timer); if (r2.current.timer) clearTimeout(r2.current.timer);
  ok('snapshot durante una domanda: la domanda ricomincia pulita');
  // risincronizzazione dello studente con "join" + token sullo stesso canale
  const n0 = pl2.out.length; e2.handle(pl2, { t: 'join', code: '4321', token: tok });
  assert.ok(pl2.out.length > n0 && pl2.out.slice(n0).some((m) => m.t === 'p_state')); ok('risincronizzazione: stato rinviato sullo stesso canale');
}

(async () => {
  try {
    testParser();
    testCategories();
    await testServerQuestions();
    await testTimedGame();
    await testWaitGame();
    console.log(`\nTutti i test superati (${passed}).`);
    process.exit(0);
  } catch (e) {
    console.error('\nTest fallito:', e);
    process.exit(1);
  }
})();
