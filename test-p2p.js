'use strict';
/*
 * Test di punta a punta della modalità GitHub Pages (WebRTC), con browser veri.
 * Richiede:  npm i --no-save peer playwright   (e un Chromium per Playwright)
 * Usa un server di segnalazione PeerJS locale al posto di quello pubblico.
 * Esegui:    node test-p2p.js [cartella-per-gli-screenshot]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { PeerServer } = require('peer');
const { chromium } = require('playwright');
const P = require('./public/parser.js');

const SHOTS = process.argv[2] || null;
const PUB = path.join(__dirname, 'public');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
let passed = 0;
const ok = (m) => { passed++; console.log('  ✔', m); };

function staticServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const f = path.join(PUB, p);
      if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
      fs.readFile(f, (e, d) => {
        if (e) { res.writeHead(404); return res.end('nf'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(d);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const web = await staticServer();
  const base = 'http://127.0.0.1:' + web.address().port;
  const sigPort = 19000 + Math.floor(Math.random() * 500);
  const sig = PeerServer({ port: sigPort, host: '127.0.0.1', path: '/' });
  const peerCfg = { host: '127.0.0.1', port: sigPort, path: '/', secure: false, config: { iceServers: [] } };

  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const newPage = async (opts, tag) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript((cfg) => { window.QUIZ_PEER = cfg; }, peerCfg);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(tag + ' pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(tag + ' console: ' + m.text()); });
    page.on('dialog', (d) => d.accept());
    return page;
  };

  const archive = P.parse(fs.readFileSync(path.join(PUB, 'quiz.txt'), 'utf8')).questions;
  const sel = { include: [2, 3], ban: [16] };
  const allowed = P.filterPool(archive, sel);
  assert.strictEqual(allowed.length, 6);

  console.log('Modalità GitHub Pages (WebRTC)');
  const host = await newPage({ viewport: { width: 1360, height: 900 } }, 'host');
  await host.goto(base + '/host.html');
  await host.waitForFunction(() => /28 domande/.test(document.querySelector('#archiveStatus').textContent));
  await host.waitForSelector('#selPanel:not([hidden])');
  assert.strictEqual(await host.locator('#cats .cat').count(), 17);
  ok('archivio quiz.txt letto (28 domande), 17 categorie mostrate');

  // categorie: neutra → scelta → esclusa → neutra
  const cat = (id) => host.locator(`#cats .cat[data-id="${id}"]`);
  await cat(3).click();
  assert.ok((await cat(3).getAttribute('class')).includes('sel'));
  await cat(3).click();
  assert.ok((await cat(3).getAttribute('class')).includes('ban'));
  await cat(3).click();
  const cls = await cat(3).getAttribute('class'); assert.ok(!cls.includes('sel') && !cls.includes('ban'));
  ok('click ciclico sulla categoria: scelta → esclusa → neutra');

  await cat(2).click(); await cat(3).click(); await cat(16).click(); await cat(16).click();   // 2 e 3 scelte, 16 esclusa
  assert.match(await host.textContent('#availLine'), /con questi filtri: 6 su 28/);
  ok('disponibilità con filtri: 6 su 28 (la 3/16 è esclusa dal ban)');

  await host.fill('#countInput', '20');
  assert.match(await host.textContent('#selErr'), /ce ne sono solo 6/);
  assert.ok(await host.isDisabled('#createBtn'));
  if (SHOTS) await host.screenshot({ path: SHOTS + '/p2p-1-setup-error.png', fullPage: true });
  ok('20 richieste su 6 disponibili → errore e pulsante bloccato');

  await host.click('#countAll');
  assert.strictEqual(await host.inputValue('#countInput'), '6');
  await host.fill('#countInput', '3');
  assert.ok(await host.isEnabled('#createBtn'));
  await host.fill('#quizTitle', 'Prova P2P');
  await host.selectOption('[data-k="timeLimit"] >> nth=0', '30');

  // ───── stanza 1: 3 domande ─────
  await host.click('#createBtn');
  await host.waitForSelector('#joinCode:visible');
  const code1 = (await host.textContent('#joinCode')).trim();
  assert.match(code1, /^\d{4}$/);
  assert.ok((await host.getAttribute('#qrImg', 'src')).startsWith('data:image/svg+xml'));
  const wa = decodeURIComponent((await host.getAttribute('#waBtn', 'href')).split('text=')[1]);
  const joinUrl = wa.slice(wa.indexOf('http'));
  assert.ok(joinUrl.endsWith('/?c=' + code1), joinUrl);
  assert.match(await host.textContent('#lobbySummary'), /^3 domande/);
  ok('stanza P2P creata: codice ' + code1 + ', QR (SVG) e link per WhatsApp');
  if (SHOTS) await host.screenshot({ path: SHOTS + '/p2p-2-lobby.png' });

  const snap1 = JSON.parse(await host.evaluate(() => localStorage.getItem('quiz.snapshot.v1')));
  const q1 = snap1.questions.map((q) => q.text);
  assert.strictEqual(q1.length, 3);
  assert.ok(q1.every((t) => allowed.some((a) => a.text === t)));
  ok('le 3 domande estratte rispettano filtri e ban');

  const phones = [];
  for (const name of ['Maria R.', 'Giuseppe', 'Anna Lisa']) {
    const p = await newPage({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true }, 'phone-' + name);
    await p.goto(joinUrl);
    await p.waitForSelector('#nameInput');
    await p.fill('#nameInput', name);
    await p.click('#joinBtn');
    await p.waitForSelector('[data-view="wait"]:not([hidden])', { timeout: 15000 });
    phones.push(p);
  }
  await host.waitForFunction(() => document.querySelector('#lobbyCount').textContent === '3');
  ok('3 telefoni collegati via WebRTC dal link');

  // un telefono con codice sbagliato → errore chiaro
  const lost = await newPage({ viewport: { width: 390, height: 780 } }, 'lost');
  await lost.goto(base + '/?c=0000');
  await lost.waitForSelector('#joinErr:not([hidden])', { timeout: 40000 });
  assert.match(await lost.textContent('#joinErr'), /Stanza non trovata/);
  ok('link con codice inesistente → "Stanza non trovata"');

  // gioco: tutti rispondono alla prima opzione; si controlla anche la fine
  await host.click('#startBtn');
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await host.waitForSelector('#blocks .block');
    seen.push((await host.textContent('#qText')).trim());
    for (const p of phones) { await p.waitForSelector('[data-view="question"]:not([hidden]) .tile'); await p.locator('.tile').nth(i % 4).click(); }
    await host.waitForSelector('#nextBtn:visible', { timeout: 10000 });
    for (const p of phones) await p.waitForSelector('[data-view="reveal"]:not([hidden])');
    if (i === 1) {
      // ───── l'istruttore ricarica la pagina a metà partita ─────
      await host.reload();
      await host.waitForSelector('#nextBtn:visible', { timeout: 25000 });
      assert.match(await host.textContent('#qHead'), /Domanda 2 di 3/);
      await host.waitForFunction(() => document.querySelectorAll('.toplist li').length === 3);
      ok('ricarica dell\'istruttore a metà partita: riprende dalla correzione della domanda 2');
      await sleep(3000); // gli studenti si riconnettono da soli
    }
    await host.click('#nextBtn');
    if (i < 2) {
      for (const p of phones) await p.waitForSelector('[data-view="question"]:not([hidden]) .tile', { timeout: 20000 });
    }
  }
  await host.waitForSelector('[data-hview="final"]:not([hidden])');
  assert.deepStrictEqual(new Set(seen), new Set(q1));
  ok('partita completa di 3 domande, dopo la ricarica gli studenti sono rientrati da soli');
  for (const p of phones) await p.waitForSelector('[data-view="final"]:not([hidden])');
  if (SHOTS) await host.screenshot({ path: SHOTS + '/p2p-3-final.png', fullPage: true });

  // ───── stanza 2: stessi filtri, altre 3 domande (rotazione) ─────
  await host.click('#closeBtn');
  await host.waitForSelector('[data-hview="setup"]:not([hidden])');
  for (const p of phones) await p.waitForSelector('[data-view="gone"]:not([hidden])', { timeout: 15000 });
  ok('chiusura stanza: gli studenti vedono "Il quiz è chiuso"');

  await host.waitForSelector('#selPanel:not([hidden])');
  assert.strictEqual(await host.inputValue('#countInput'), '3');
  assert.match(await host.textContent('#rotHint'), /Mai uscite, con questi filtri: 3 su 6/);
  assert.ok((await cat(2).getAttribute('class')).includes('sel') && (await cat(16).getAttribute('class')).includes('ban'));
  ok('filtri e numero ricordati; la rotazione sa che 3 domande su 6 non sono ancora uscite');
  if (SHOTS) await host.screenshot({ path: SHOTS + '/p2p-4-setup-again.png', fullPage: true });

  await host.click('#createBtn');
  await host.waitForSelector('#joinCode:visible');
  const code2 = (await host.textContent('#joinCode')).trim();
  const snap2 = JSON.parse(await host.evaluate(() => localStorage.getItem('quiz.snapshot.v1')));
  const q2 = snap2.questions.map((q) => q.text);
  assert.strictEqual(q2.length, 3);
  assert.ok(q2.every((t) => !q1.includes(t)), 'ripetute: ' + q2.filter((t) => q1.includes(t)));
  assert.strictEqual(new Set(q1.concat(q2)).size, 6);
  ok('secondo quiz: 3 domande diverse dalle prime → copertura completa delle 6 (codice ' + code2 + ')');

  console.log('Pagina studente con il server WebSocket sostituito da P2P: errori in console →', JSON.stringify(errors));
  assert.deepStrictEqual(errors, []);
  ok('nessun errore JavaScript nelle pagine');

  await browser.close();
  await new Promise((r) => web.close(r));
  try { sig.close ? sig.close() : null; } catch (e) { /* ignore */ }
  console.log(`\nTest P2P superati (${passed}).`);
  process.exit(0);
})().catch((e) => { console.error('\nTEST P2P FALLITO:', e); process.exit(1); });
