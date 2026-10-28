(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const LETTERS = ['A', 'B', 'C', 'D'];
  const SAVED = 'quiz.host';
  const SAVED_SETTINGS = 'quiz.settings';
  const DEFAULTS = { showOptionsOnPhone: true, mode: 'timed', timeLimit: 20, speedBonus: true, shuffleQuestions: true };
  const CHECK = '<svg viewBox="0 0 20 20"><path d="M4 10.5l4 4 8-9" fill="none" stroke="#14804a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else if (v !== false && v != null) el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  let S = null;          // ultimo host_state
  let info = null;       // { code, joinUrl, qr }
  let recvAt = 0;
  let view = 'loading';

  /* ───────── viste ───────── */
  function show(name) {
    view = name;
    if (name === 'setup') setTimeout(renderSetup, 0);
    $$('[data-hview]').forEach((el) => { el.hidden = el.dataset.hview !== name; });
    const inRoom = name !== 'loading' && name !== 'setup';
    $('#topbar').hidden = !inRoom;
    $('#topLb').hidden = !(name === 'play');
    $('#topEnd').hidden = !(name === 'play');
  }

  /* ───────── connessione ───────── */
  function loadSaved() {
    try { return JSON.parse(store.get(SAVED) || 'null'); } catch (e) { return null; }
  }

  const conn = QuizConn({
    onOpen() {
      const sv = loadSaved();
      if (sv && sv.code && sv.hostToken) conn.send({ t: 'host_resume', code: sv.code, hostToken: sv.hostToken });
      else if (view === 'loading') show('setup');
    },
    onStatus(ok) { $('#conn').hidden = ok || view === 'loading' || view === 'setup'; },
    onMessage(m) {
      switch (m.t) {
        case 'host_info':
          info = m;
          closingRoom = false;
          store.set(SAVED, JSON.stringify({ code: m.code, hostToken: m.hostToken }));
          if (pendingUsage) { usage = pendingUsage; pendingUsage = null; store.set(USAGE_KEY, JSON.stringify(usage)); }
          break;
        case 'host_state':
          S = m;
          recvAt = Date.now();
          render();
          break;
        case 'host_answers':
          if (S) {
            const set = new Set(m.answered);
            S.players.forEach((p) => { p.answered = set.has(p.pid); });
            S.answeredCount = m.answeredCount;
            if (S.phase === 'question') renderTracker();
          }
          break;
        case 'room_gone':
          store.del(SAVED);
          S = null; info = null;
          if (view !== 'setup') {
            show('setup');
            if (!closingRoom) showSetupErr('La stanza precedente non è più disponibile (era stata chiusa, oppure è aperta in un’altra scheda). Creane una nuova.');
          } else if (view === 'loading') show('setup');
          break;
        case 'error':
          pendingUsage = null;
          showSetupErr(m.msg);
          renderSetup();
          break;
        default: break;
      }
    },
  }, 'host');

  function showSetupErr(msg) {
    const e = $('#setupErr');
    e.hidden = !msg;
    e.textContent = msg || '';
  }

  /* ───────── impostazioni (modulo riusato in preparazione e in finestra) ───────── */
  function mountSettings(container, onChange) {
    container.append($('#settingsTpl').content.cloneNode(true));
    const uid = Math.random().toString(36).slice(2, 7);
    $$('input[type=radio]', container).forEach((i) => { i.name = i.dataset.k + '-' + uid; });
    const radios = (k) => $$('input[data-k="' + k + '"]', container);
    const el = (k) => $('[data-k="' + k + '"]', container);

    function get() {
      return {
        showOptionsOnPhone: radios('showOptions').find((r) => r.checked).value === '1',
        mode: radios('mode').find((r) => r.checked).value,
        timeLimit: Number(el('timeLimit').value),
        speedBonus: el('speedBonus').checked,
        shuffleQuestions: el('shuffleQuestions').checked,
      };
    }

    function refresh() {
      const s = get();
      $('[data-timerow]', container).hidden = s.mode !== 'timed';
      $('[data-hint="showOptions"]', container).textContent = s.showOptionsOnPhone
        ? 'Sul telefono compaiono domanda e risposte: si legge anche da lì.'
        : 'Sul telefono compaiono solo quattro riquadri A B C D: le risposte si leggono sullo schermo dell’aula.';
      $('[data-hint="mode"]', container).textContent = s.mode === 'timed'
        ? 'La correzione parte quando scade il tempo, oppure appena hanno risposto tutti.'
        : 'Nessun limite: la correzione parte quando tutti hanno risposto, oppure quando premi “Blocca le risposte”.';
      $('[data-hint="speed"]', container).textContent = s.speedBonus
        ? 'Risposta giusta: da 1000 punti (subito) a 500 (all’ultimo istante).' + (s.mode === 'wait' ? ' Senza limite di tempo il bonus conta i primi 30 secondi.' : '')
        : 'Ogni risposta giusta vale 1000 punti, a prescindere dalla velocità.';
    }

    function set(s) {
      radios('showOptions').forEach((r) => { r.checked = (r.value === '1') === !!s.showOptionsOnPhone; });
      radios('mode').forEach((r) => { r.checked = r.value === s.mode; });
      el('timeLimit').value = String(s.timeLimit);
      if (el('timeLimit').value !== String(s.timeLimit)) {
        const o = h('option', { value: String(s.timeLimit) }, String(s.timeLimit));
        el('timeLimit').append(o);
        el('timeLimit').value = String(s.timeLimit);
      }
      el('speedBonus').checked = !!s.speedBonus;
      el('shuffleQuestions').checked = !!s.shuffleQuestions;
      refresh();
    }

    container.addEventListener('change', () => { refresh(); if (onChange) onChange(get()); });
    set(DEFAULTS);
    return { get, set };
  }

  let saved = DEFAULTS;
  try { saved = Object.assign({}, DEFAULTS, JSON.parse(store.get(SAVED_SETTINGS) || '{}')); } catch (e) { /* ignore */ }

  const setupSettings = mountSettings($('#setupSettings'), (s) => store.set(SAVED_SETTINGS, JSON.stringify(s)));
  setupSettings.set(saved);

  const dialogSettings = mountSettings($('#dialogSettings'), (s) => {
    conn.send({ t: 'settings', settings: s });
    store.set(SAVED_SETTINGS, JSON.stringify(s));
  });

  function openSettings() {
    if (S) dialogSettings.set(S.settings);
    $('#settingsDialog').showModal();
  }
  $('#settingsClose').addEventListener('click', () => $('#settingsDialog').close());
  $('#lobbySettingsBtn').addEventListener('click', openSettings);
  $('#playSettingsBtn').addEventListener('click', openSettings);

  /* ───────── scelta delle domande ───────── */
  const P = window.QuizParser;
  const SEL_KEY = 'quiz.sel.v1';
  const USAGE_KEY = 'quiz.usage.v1';
  const ICON_OK = '<svg class="i-ok" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_NO = '<svg class="i-no" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
  const catName = (id) => (P.CATEGORIES.find((c) => c.id === id) || {}).name || String(id);

  // stato della scelta (ricordato tra una sessione e l'altra)
  const sel = { src: 'archive', count: null, include: [], ban: [], rotate: true };
  try {
    const saved = JSON.parse(store.get(SEL_KEY) || '{}');
    if (saved.src === 'archive' || saved.src === 'upload') sel.src = saved.src;
    if (Number.isInteger(saved.count) && saved.count > 0) sel.count = saved.count;
    const ids = (a) => (Array.isArray(a) ? a.filter((n) => Number.isInteger(n) && n >= 1 && n <= P.CATEGORIES.length) : []);
    sel.include = ids(saved.include);
    sel.ban = ids(saved.ban).filter((n) => !sel.include.includes(n));
    if (typeof saved.rotate === 'boolean') sel.rotate = saved.rotate;
  } catch (e) { /* ignore */ }
  const saveSel = () => store.set(SEL_KEY, JSON.stringify(sel));

  // quante volte è uscita ogni domanda (per la rotazione)
  function loadUsage() {
    try {
      const u = JSON.parse(store.get(USAGE_KEY) || '{}');
      return u && typeof u === 'object' && Object.keys(u).length < 20000 ? u : {};
    } catch (e) { return {}; }
  }
  let usage = loadUsage();
  let pendingUsage = null;
  let closingRoom = false; // chiusura voluta: niente messaggio d'errore

  const pools = { archive: null, upload: null }; // { title, questions, warnings, errors }
  let archiveMsg = 'Carico l’archivio…';
  let archiveFailed = false;
  let uploadName = '';
  let catsBuiltFor = null;

  const curPool = () => pools[sel.src];

  function decodeBuf(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('windows-1252').decode(buf); }
  }

  function setSrc(v, temporary) {
    sel.src = v;
    if (!temporary) saveSel();
    $$('input[name="src"]').forEach((r) => { r.checked = r.value === v; });
    $('#srcArchive').hidden = v !== 'archive';
    $('#srcUpload').hidden = v !== 'upload';
    catsBuiltFor = null;
    syncTitle();
    renderSetup();
  }
  $$('input[name="src"]').forEach((r) => r.addEventListener('change', () => { if (r.checked) setSrc(r.value); }));

  function syncTitle() {
    const t = $('#quizTitle');
    const p = curPool();
    if (!p) return;
    if (!t.value || t.dataset.auto === '1') {
      t.value = p.title || (sel.src === 'archive' ? 'Quiz' : uploadName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Quiz');
      t.dataset.auto = '1';
    }
  }
  $('#quizTitle').addEventListener('input', (e) => { e.target.dataset.auto = '0'; });

  async function loadArchive() {
    try {
      const res = await fetch('quiz.txt', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const parsed = P.parse(decodeBuf(await res.arrayBuffer()));
      if (!parsed.questions.length) throw new Error('vuoto');
      pools.archive = parsed;
      archiveFailed = false;
      archiveMsg = 'Archivio del sito (quiz.txt): ' + parsed.questions.length + ' domande.';
    } catch (e) {
      pools.archive = null;
      archiveFailed = true;
      archiveMsg = 'Non riesco a leggere l’archivio (quiz.txt). Carica un file tuo.';
      if (sel.src === 'archive') { setSrc('upload', true); return; }
    }
    syncTitle();
    renderSetup();
  }

  function handleText(text, name) {
    pools.upload = P.parse(text);
    if (name != null) uploadName = name;
    catsBuiltFor = null;
    syncTitle();
    renderSetup();
  }

  function readFile(file) {
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { showSetupErr('Il file è troppo grande (massimo 3 MB).'); return; }
    showSetupErr('');
    file.arrayBuffer().then((buf) => {
      $('#pasteArea').value = '';
      handleText(decodeBuf(buf), file.name);
    });
  }

  $('#fileInput').addEventListener('change', (e) => readFile(e.target.files[0]));
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => readFile(e.dataTransfer.files[0]));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  let pasteTimer = null;
  $('#pasteArea').addEventListener('input', (e) => {
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => {
      if (e.target.value.trim()) handleText(e.target.value, 'Quiz');
      else { pools.upload = null; catsBuiltFor = null; renderSetup(); }
    }, 350);
  });

  /* ── rapporto sul file letto ── */
  function renderReport() {
    const box = $('#parseReport');
    box.replaceChildren();
    const status = $('#archiveStatus');
    status.textContent = archiveMsg;
    status.className = archiveFailed ? 'err' : 'muted';

    if (archiveFailed && sel.src === 'upload') box.append(h('p', { class: 'err' }, archiveMsg));
    const p = curPool();
    if (!p) return;
    const n = p.questions.length;
    if (n) box.append(h('p', { class: 'okline' }, n === 1 ? '1 domanda pronta' : n + ' domande pronte'));
    if (p.errors.length) {
      box.append(h('div', null,
        h('strong', null, 'Da correggere nel file:'),
        h('ul', null, p.errors.map((e) => h('li', { class: 'e' }, (e.line ? 'Riga ' + e.line + ': ' : '') + e.msg)))));
    }
    if (p.warnings.length) {
      box.append(h('details', null,
        h('summary', null, p.warnings.length === 1 ? '1 avviso' : p.warnings.length + ' avvisi'),
        h('ul', null, p.warnings.slice(0, 200).map((w) => h('li', { class: 'w' }, (w.line ? 'Riga ' + w.line + ': ' : '') + w.msg)))));
    }
    if (n) {
      const LIM = 40;
      box.append(h('details', null,
        h('summary', null, 'Controlla come ho letto le domande'),
        h('ul', { class: 'qprev' },
          p.questions.slice(0, LIM).map((q) => h('li', null,
            h('b', null, q.n + ') ' + q.text),
            h('div', { class: 'muted' }, q.cats.map(catName).join(', ')),
            h('div', { class: 'ok' }, q.options[0]),
            q.options.slice(1).map((o) => h('div', { class: 'no' }, 'Sbagliata: ' + o)))),
          n > LIM ? h('li', { class: 'muted' }, '…e altre ' + (n - LIM) + ' domande.') : null)));
    }
  }

  /* ── categorie, conteggio, disponibilità ── */
  function effectiveSel(hasCats) {
    return hasCats ? { include: sel.include, ban: sel.ban } : { include: [], ban: [] };
  }

  function cycleCat(id) {
    const i = sel.include.indexOf(id);
    const b = sel.ban.indexOf(id);
    if (i >= 0) { sel.include.splice(i, 1); sel.ban.push(id); } // scelta → esclusa
    else if (b >= 0) { sel.ban.splice(b, 1); }                    // esclusa → neutra
    else sel.include.push(id);                                    // neutra → scelta
    saveSel();
    renderSetup();
  }

  function buildCats(counts) {
    const box = $('#cats');
    box.replaceChildren();
    P.CATEGORIES.forEach((c) => {
      const btn = h('button', { type: 'button', class: 'cat', 'data-id': String(c.id), onclick: () => cycleCat(c.id) });
      const mark = h('span', { class: 'mark' });
      mark.innerHTML = ICON_OK + ICON_NO;
      btn.append(mark, h('span', { class: 'nm' }, c.name), h('span', { class: 'ct' }, String(counts[c.id] || 0)));
      if (!counts[c.id]) btn.disabled = true;
      box.append(btn);
    });
  }

  function updateCats(counts) {
    $$('#cats .cat').forEach((btn) => {
      const id = Number(btn.dataset.id);
      const isSel = sel.include.includes(id);
      const isBan = sel.ban.includes(id);
      btn.classList.toggle('sel', isSel);
      btn.classList.toggle('ban', isBan);
      const state = isSel ? 'scelta' : (isBan ? 'esclusa' : 'non scelta');
      btn.setAttribute('aria-label', catName(id) + ', ' + (counts[id] || 0) + ' domande, ' + state);
    });
  }

  function selectionState() {
    const p = curPool();
    if (!p || !p.questions.length) return null;
    const counts = P.categoryCounts(p.questions);
    const hasCats = P.CATEGORIES.filter((c) => counts[c.id] > 0).length > 1;
    const avail = P.filterPool(p.questions, effectiveSel(hasCats));
    const err = P.checkCount(avail.length, sel.count);
    return { p, counts, hasCats, avail, err };
  }

  function renderSetup() {
    renderReport();
    const s = selectionState();
    $('#selPanel').hidden = !s;
    $('#titlePanel').hidden = !s;
    if (!s) { $('#createBtn').disabled = true; return; }

    if (sel.count == null) { sel.count = Math.min(20, s.p.questions.length); saveSel(); }
    const inp = $('#countInput');
    if (document.activeElement !== inp) inp.value = sel.count == null ? '' : String(sel.count);
    inp.max = String(s.avail.length);

    $('#catBlock').hidden = !s.hasCats;
    if (s.hasCats) {
      if (catsBuiltFor !== s.p) { buildCats(s.counts); catsBuiltFor = s.p; }
      updateCats(s.counts);
    }

    const total = s.p.questions.length;
    $('#availLine').textContent = s.avail.length === total
      ? 'Domande disponibili: ' + total + '.'
      : 'Domande disponibili con questi filtri: ' + s.avail.length + ' su ' + total + '.';

    const e = $('#selErr');
    e.hidden = !s.err;
    e.textContent = s.err || '';

    const never = s.avail.filter((q) => !usage[P.hashQ(q)]).length;
    $('#rotateChk').checked = sel.rotate;
    $('#rotHint').textContent = sel.rotate
      ? 'Ogni domanda ricorda quante volte è uscita: si estraggono prima quelle uscite meno volte, a caso tra pari merito. ' +
        'Così in pochi quiz escono tutte. Mai uscite, con questi filtri: ' + never + ' su ' + s.avail.length + '.'
      : 'Estrazione completamente casuale, senza memoria di quelle già uscite.';
    $('#createBtn').disabled = !!s.err;
  }

  $('#countInput').addEventListener('input', (e) => {
    const n = parseInt(e.target.value, 10);
    sel.count = Number.isFinite(n) ? n : NaN;
    if (Number.isFinite(n)) saveSel();
    renderSetup();
  });
  $('#countInput').addEventListener('blur', renderSetup);
  const stepCount = (d) => { sel.count = Math.max(1, (Number.isFinite(sel.count) ? sel.count : 0) + d); saveSel(); renderSetup(); };
  $('#countMinus').addEventListener('click', () => stepCount(-1));
  $('#countPlus').addEventListener('click', () => stepCount(1));
  $('#countAll').addEventListener('click', () => {
    const s = selectionState();
    if (s) { sel.count = s.avail.length; saveSel(); renderSetup(); }
  });
  $('#catReset').addEventListener('click', () => { sel.include = []; sel.ban = []; saveSel(); renderSetup(); });
  $('#rotateChk').addEventListener('change', (e) => { sel.rotate = e.target.checked; saveSel(); renderSetup(); });
  $('#usageReset').addEventListener('click', () => {
    if (!confirm('Dimentico quali domande sono già uscite? Da adesso tutte tornano alla pari.')) return;
    usage = {}; store.del(USAGE_KEY); renderSetup();
  });

  $('#createBtn').addEventListener('click', () => {
    const s = selectionState();
    if (!s) return;
    if (s.err) { renderSetup(); return; }
    showSetupErr('');
    const res = P.pickQuestions(s.avail, sel.count, usage, { rotate: sel.rotate });
    if (res.error) { showSetupErr(res.error); return; }
    pendingUsage = P.bumpUsage(usage, res.questions);
    $('#createBtn').disabled = true;
    const sent = conn.send({
      t: 'host_create',
      questions: res.questions.map((q) => ({ text: q.text, options: q.options, cats: q.cats })),
      title: $('#quizTitle').value,
      settings: setupSettings.get(),
    });
    if (!sent) { pendingUsage = null; showSetupErr('Non sono collegato. Riprova tra un attimo.'); renderSetup(); }
  });

  /* ───────── disegno ───────── */
  let wake = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wake) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      }
    } catch (e) { /* non supportato */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S) keepAwake(); });

  function render() {
    if (!S) return;
    keepAwake();
    $('#topCode').textContent = S.code;
    $('#topTitle').textContent = S.title;
    switch (S.phase) {
      case 'lobby': show('lobby'); renderLobby(); break;
      case 'question':
      case 'reveal': show('play'); renderPlay(); break;
      case 'finished': show('final'); renderFinal(); break;
      default: break;
    }
  }

  function settingsSummary(s) {
    const parts = [];
    parts.push(s.showOptionsOnPhone ? 'Sul telefono: lettere e testo.' : 'Sul telefono: solo lettere.');
    parts.push(s.mode === 'timed' ? s.timeLimit + ' secondi per domanda.' : 'Senza limite di tempo: si aspettano tutti.');
    parts.push(s.speedBonus ? 'Bonus velocità attivo.' : 'Bonus velocità spento.');
    if (s.shuffleQuestions) parts.push('Domande mescolate.');
    return parts.join(' ');
  }

  function renderLobby() {
    if (info) {
      $('#qrImg').src = info.qr;
      $('#joinHost').textContent = 'Vai su ' + info.joinUrl.replace(/^https?:\/\//, '').replace(/\/\?c=\d+$/, '');
      $('#joinCode').textContent = info.code;
      $('#waBtn').href = 'https://wa.me/?text=' + encodeURIComponent('Entra nel quiz «' + S.title + '»: ' + info.joinUrl);
    }
    $('#lobbyCount').textContent = String(S.players.length);
    $('#lobbyEmpty').hidden = S.players.length > 0;
    const box = $('#lobbyChips');
    box.replaceChildren();
    S.players.forEach((p) => {
      box.append(h('span', { class: 'chip' + (p.connected ? '' : ' off') },
        p.name,
        h('button', { type: 'button', title: 'Rimuovi ' + p.name, 'aria-label': 'Rimuovi ' + p.name, onclick: () => conn.send({ t: 'kick', pid: p.pid }) }, '×')));
    });
    $('#lobbyQuizTitle').textContent = S.title;
    $('#lobbySummary').textContent = S.qTotal + (S.qTotal === 1 ? ' domanda. ' : ' domande. ') + settingsSummary(S.settings);
  }

  $('#startBtn').addEventListener('click', () => {
    if (S && S.players.length === 0 && !confirm('Nessuno è ancora entrato. Vuoi avviare lo stesso il quiz?')) return;
    conn.send({ t: 'start' });
  });

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
    return Promise.resolve();
  }
  $('#copyBtn').addEventListener('click', () => {
    if (!info) return;
    copyText(info.joinUrl).then(() => {
      const b = $('#copyBtn');
      b.textContent = 'Link copiato';
      setTimeout(() => { b.textContent = 'Copia il link'; }, 2000);
    });
  });

  function renderPlay() {
    $('#view-play').dataset.phase = S.phase;
    $('#qHead').textContent = 'Domanda ' + S.qNum + ' di ' + S.qTotal;
    $('#qText').textContent = S.question.text;
    drawBlocks();
    if (S.phase === 'question') {
      $('#lockBtn').disabled = false;
      renderTracker();
      tick();
    } else {
      renderReveal();
    }
  }

  function drawBlocks() {
    const box = $('#blocks');
    box.replaceChildren();
    const reveal = S.phase === 'reveal';
    const total = reveal ? Math.max(1, S.counts.reduce((a, b) => a + b, 0)) : 1;
    S.question.options.forEach((txt, i) => {
      const cls = ['block', 'tile-' + i];
      if (reveal) cls.push(i === S.correctPos ? 'right' : 'wrong');
      const el = h('div', { class: cls.join(' ') },
        h('span', { class: 'letter' }, LETTERS[i]),
        h('span', { class: 'btext' }, txt));
      if (reveal) {
        el.append(h('span', { class: 'count', title: 'Hanno scelto questa risposta' }, String(S.counts[i])));
        const bar = h('span', { class: 'bar' });
        bar.style.width = Math.round((S.counts[i] / total) * 100) + '%';
        el.append(bar);
        if (i === S.correctPos) el.append(h('span', { class: 'tag' }, 'Giusta'));
      }
      box.append(el);
    });
  }

  function renderTracker() {
    const ps = S.players;
    const ans = ps.filter((p) => p.answered).length;
    $('#ansNum').textContent = ans + ' su ' + ps.length;
    const box = $('#tracker');
    box.replaceChildren();
    ps.slice()
      .sort((a, b) => (a.answered - b.answered) || a.name.localeCompare(b.name, 'it'))
      .forEach((p) => {
        const chip = h('span', { class: 'chip' + (p.answered ? ' on' : '') + (p.connected ? '' : ' off') });
        if (p.answered) { const i = h('span'); i.innerHTML = CHECK; chip.append(i.firstChild); }
        chip.append(p.name);
        box.append(chip);
      });
  }

  function renderReveal() {
    const L = LETTERS[S.correctPos];
    $('#correctLine').textContent = 'La risposta giusta è la ' + L + ': ' + S.question.options[S.correctPos];
    const list = $('#topList');
    list.replaceChildren();
    S.leaderboard.slice(0, 5).forEach((p) => {
      list.append(h('li', null,
        h('span', { class: 'rk' }, p.rank + '°'),
        h('span', { class: 'nm' }, p.name),
        h('span', { class: 'dl' }, p.delta > 0 ? '+' + p.delta : ''),
        h('span', { class: 'pt' }, String(p.score))));
    });
    if (!S.leaderboard.length) list.append(h('li', null, 'Nessun partecipante'));
    $('#fullLbBtn').hidden = S.leaderboard.length <= 5;
    $('#nextBtn').textContent = S.qNum >= S.qTotal ? 'Vedi la classifica finale' : 'Domanda successiva';
  }

  $('#lockBtn').addEventListener('click', () => { $('#lockBtn').disabled = true; conn.send({ t: 'lock' }); });
  $('#nextBtn').addEventListener('click', () => conn.send({ t: 'next' }));

  function tick() {
    if (!S || S.phase !== 'question' || S.remainingMs == null) {
      $('#qCountdown').hidden = true;
      $('#hTimerWrap').hidden = true;
      return;
    }
    $('#qCountdown').hidden = false;
    $('#hTimerWrap').hidden = false;
    const rem = Math.max(0, S.remainingMs - (Date.now() - recvAt));
    $('#qCountdown').textContent = Math.ceil(rem / 1000) + ' s';
    $('#hTimerFill').style.width = Math.min(100, (rem / S.limitMs) * 100) + '%';
    $('#hTimerWrap').classList.toggle('low', rem / S.limitMs < 0.25);
  }
  setInterval(tick, 200);

  /* ───────── classifica ───────── */
  function lbTable(table, rows, withDelta) {
    table.replaceChildren();
    table.append(h('thead', null, h('tr', null,
      h('th', null, 'Posto'), h('th', null, 'Nome'), h('th', { class: 'num' }, 'Giuste'), h('th', { class: 'num' }, 'Punti'))));
    const body = h('tbody');
    rows.forEach((p) => body.append(h('tr', null,
      h('td', null, p.rank + '°'),
      h('td', null, p.name),
      h('td', { class: 'num' }, String(p.correct)),
      h('td', { class: 'num' }, String(p.score)))));
    table.append(body);
  }

  function openLeaderboard() {
    if (!S) return;
    lbTable($('#lbTable'), S.leaderboard);
    $('#lbDialog').showModal();
  }
  $('#topLb').addEventListener('click', openLeaderboard);
  $('#fullLbBtn').addEventListener('click', openLeaderboard);
  $('#lbClose').addEventListener('click', () => $('#lbDialog').close());

  $('#topEnd').addEventListener('click', () => {
    if (confirm('Vuoi terminare il quiz adesso? Verrà mostrata la classifica finale.')) conn.send({ t: 'end' });
  });

  /* ───────── finale ───────── */
  function renderFinal() {
    const lb = S.leaderboard;
    const pod = $('#podium');
    pod.replaceChildren();
    const order = [1, 0, 2].filter((i) => lb[i]);
    order.forEach((i) => {
      const p = lb[i];
      pod.append(h('div', { class: 'pod p' + Math.min(3, p.rank) },
        h('div', { class: 'pr' }, p.rank + '°'),
        h('div', { class: 'pn' }, p.name),
        h('div', { class: 'pp' }, p.score + ' punti')));
    });
    lbTable($('#finalTable'), lb);

    const st = $('#statsTable');
    st.replaceChildren();
    st.append(h('thead', null, h('tr', null, h('th', null, 'Domanda'), h('th', null, 'Giuste'))));
    const body = h('tbody');
    S.played.forEach((q) => {
      const pct = Math.round((100 * q.correct) / Math.max(1, q.total));
      const bar = h('i'); bar.style.width = pct + '%';
      body.append(h('tr', null,
        h('td', null, q.num + ') ' + (q.text.length > 90 ? q.text.slice(0, 88) + '…' : q.text)),
        h('td', null, h('div', { class: 'pct' }, h('div', { style: 'flex:1' }, bar), h('span', null, pct + '%')))));
    });
    st.append(body);
  }

  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = "'" + s;
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  $('#csvBtn').addEventListener('click', () => {
    if (!S) return;
    const cells = new Map(S.results.map((r) => [r.pid, r.cells]));
    const rows = [['Posizione', 'Nome', 'Punti', 'Risposte corrette', 'Risposte date'].concat(S.played.map((q) => 'D' + q.num))];
    S.leaderboard.forEach((p) => {
      const c = cells.get(p.pid) || [];
      rows.push([p.rank, p.name, p.score, p.correct, c.filter((x) => x !== null).length].concat(c.map((x) => (x === null ? '' : x))));
    });
    rows.push(['', 'Risposte corrette (%)', '', '', ''].concat(S.played.map((q) => Math.round((100 * q.correct) / Math.max(1, q.total)))));
    const csv = '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const slug = (S.title || 'quiz').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'quiz';
    const a = h('a', { href: url, download: 'risultati-' + slug + '-' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  $('#restartBtn').addEventListener('click', () => {
    if (confirm('Azzero i punti e riparto dalla prima domanda con gli stessi studenti?')) conn.send({ t: 'restart' });
  });
  $('#closeBtn').addEventListener('click', () => {
    if (confirm('Chiudere la stanza? Gli studenti verranno scollegati.')) {
      closingRoom = true;
      conn.send({ t: 'close' });
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (S && (S.phase === 'question' || S.phase === 'reveal')) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ───────── avvio ───────── */
  show(loadSaved() ? 'loading' : 'setup');
  setSrc(sel.src, true);
  loadArchive();
  setTimeout(() => { if (view === 'loading') show('setup'); }, 20000);
})();
