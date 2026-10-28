/*
 * Motore di gioco: stanze, giocatori, domande, punteggi.
 * Non sa nulla di reti: riceve messaggi da oggetti "socket" (readyState, send, close, ctx)
 * e risponde con send(). Lo usano sia server.js (WebSocket) sia il browser dell'istruttore (WebRTC).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QuizEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const Parser = (typeof module === 'object' && module.exports) ? require('./parser.js') : self.QuizParser;
  const webcrypto = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues)
    ? globalThis.crypto
    : require('crypto').webcrypto;

  const MAX_PLAYERS = 500;
  const MAX_QUESTIONS = 500;
  const MAX_NAME = 20;
  const BASE_POINTS = 1000;
  const WAIT_MODE_WINDOW_MS = 30000; // finestra di riferimento per il bonus velocità senza timer
  const GRACE_MS = 600;              // tolleranza di rete oltre la scadenza

  const DEFAULT_SETTINGS = {
    showOptionsOnPhone: true,  // mostra il testo delle risposte anche sul telefono
    mode: 'timed',             // 'timed' = tempo limite | 'wait' = si aspettano tutti
    timeLimit: 20,             // secondi (solo mode 'timed')
    speedBonus: true,          // punti anche in base alla velocità
    shuffleQuestions: false,   // mescola l'ordine delle domande
  };

  /* ───────────────────────── utilità ───────────────────────── */

  function rnd(n) { // intero uniforme in [0, n)
    const max = Math.floor(4294967296 / n) * n;
    const a = new Uint32Array(1);
    do { webcrypto.getRandomValues(a); } while (a[0] >= max);
    return a[0] % n;
  }
  function token(bytes) {
    const a = new Uint8Array(bytes || 16);
    webcrypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = rnd(i + 1);
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function cleanName(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u001f\u007f<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_NAME);
  }
  function sanitizeSettings(inp, prev) {
    const s = Object.assign({}, prev || DEFAULT_SETTINGS);
    inp = inp || {};
    if (typeof inp.showOptionsOnPhone === 'boolean') s.showOptionsOnPhone = inp.showOptionsOnPhone;
    if (inp.mode === 'timed' || inp.mode === 'wait') s.mode = inp.mode;
    if (Number.isFinite(Number(inp.timeLimit))) s.timeLimit = Math.min(300, Math.max(5, Math.round(Number(inp.timeLimit))));
    if (typeof inp.speedBonus === 'boolean') s.speedBonus = inp.speedBonus;
    if (typeof inp.shuffleQuestions === 'boolean') s.shuffleQuestions = inp.shuffleQuestions;
    return s;
  }
  const isConnected = (p) => p.sockets.size > 0;
  function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function computePoints(room, ms, limitMs) {
    if (!room.settings.speedBonus) return BASE_POINTS;
    const win = room.settings.mode === 'timed' ? limitMs : WAIT_MODE_WINDOW_MS;
    const frac = Math.min(1, Math.max(0, ms / win));
    return Math.round(BASE_POINTS * (1 - frac / 2)); // 1000 (istantanea) → 500 (ultimo istante)
  }

  /* ───────────────────────── creazione ───────────────────────── */

  // msg.questions = domande già scelte dal client [{text, options:[giusta, ...]}]  (oppure) msg.text = file .txt
  function validateNew(msg) {
    let questions;
    let fileTitle = '';
    if (Array.isArray(msg.questions)) {
      questions = [];
      msg.questions.forEach((q) => {
        if (!q || typeof q.text !== 'string' || !Array.isArray(q.options)) return;
        const text = q.text.replace(/\s+/g, ' ').trim().slice(0, 1000);
        const options = q.options.slice(0, 4).map((o) => String(o == null ? '' : o).replace(/\s+/g, ' ').trim().slice(0, 500) || '—');
        if (!text || options.length < 2) return;
        questions.push({ n: questions.length + 1, text, options, correct: 0, cats: Array.isArray(q.cats) ? q.cats : [] });
      });
    } else {
      const parsed = Parser.parse(msg.text);
      questions = parsed.questions;
      fileTitle = parsed.title;
    }
    if (!questions.length) return { error: { t: 'error', code: 'noquestions', msg: 'Nessuna domanda valida trovata nel file.' } };
    if (questions.length > MAX_QUESTIONS) return { error: { t: 'error', msg: `Troppe domande (massimo ${MAX_QUESTIONS}).` } };
    return { questions, title: cleanName(msg.title).slice(0, 80) || fileTitle.slice(0, 80) || 'Quiz' };
  }

  /* ───────────────────────── il motore ───────────────────────── */

  function create(opts) {
    opts = opts || {};
    const rooms = new Map();

    const changed = (room) => { if (opts.persist) { try { opts.persist(snapshot(room)); } catch (e) { /* ignore */ } } };

    function newCode() {
      let code;
      do { code = String(1000 + rnd(9000)); } while (rooms.has(code));
      return code;
    }

    function buildOrder(room) {
      const idx = room.quiz.questions.map((_, i) => i);
      return room.settings.shuffleQuestions ? shuffle(idx) : idx;
    }

    function resetGame(room) {
      if (room.current && room.current.timer) clearTimeout(room.current.timer);
      room.current = null;
      room.phase = 'lobby';
      room.qPos = -1;
      room.played = [];
      room.order = buildOrder(room);
      for (const p of room.players.values()) {
        p.score = 0; p.correctCount = 0; p.totalMs = 0; p.answeredCount = 0;
        p.answers = {}; p.lastPoints = 0;
      }
      room.rankDirty = true;
    }

    function ensureRanked(room) {
      if (!room.rankDirty) return room.ranked;
      const arr = [...room.players.values()].sort((a, b) =>
        b.score - a.score || b.correctCount - a.correctCount || a.totalMs - b.totalMs || a.name.localeCompare(b.name, 'it'));
      let rank = 0; let prev = null;
      arr.forEach((p, i) => { if (p.score !== prev) { rank = i + 1; prev = p.score; } p.rank = rank; });
      room.ranked = arr;
      room.rankDirty = false;
      return arr;
    }

    /* ───── stato inviato ai client ───── */

    function hostState(room) {
      const cur = room.current;
      const s = room.settings;
      const inQ = !!cur && (room.phase === 'question' || room.phase === 'reveal');
      const lb = ensureRanked(room);

      const st = {
        t: 'host_state',
        code: room.code,
        title: room.title,
        phase: room.phase,
        settings: s,
        qTotal: room.order.length,
        qNum: room.qPos + 1,
        players: [...room.players.values()].map((p) => ({
          pid: p.pid, name: p.name, connected: isConnected(p), score: p.score,
          answered: inQ && cur.answers.has(p.pid),
        })),
        leaderboard: room.phase === 'lobby' ? [] : lb.map((p) => ({
          pid: p.pid, name: p.name, score: p.score, rank: p.rank, delta: p.lastPoints,
          correct: p.correctCount, connected: isConnected(p),
        })),
      };

      if (inQ) {
        st.question = { text: cur.q.text, options: cur.optionOrder.map((i) => cur.q.options[i]) };
        st.answeredCount = cur.answers.size;
        if (room.phase === 'question') {
          st.limitMs = cur.limitMs;
          st.remainingMs = cur.deadline ? Math.max(0, cur.deadline - Date.now()) : null;
        } else {
          st.correctPos = cur.correctPos;
          st.counts = cur.counts;
        }
      }

      if (room.phase === 'finished') {
        st.played = room.played.map((r) => ({
          num: r.num, text: r.text, correctText: r.correctText, counts: r.counts,
          answered: r.answered, correct: r.correct, total: r.total,
        }));
        st.results = lb.map((p) => ({
          pid: p.pid,
          cells: room.played.map((_, i) => (p.answers[i] ? p.answers[i].points : null)),
        }));
      }
      return st;
    }

    function playerState(room, p) {
      const cur = room.current;
      const s = room.settings;
      ensureRanked(room);
      const st = {
        t: 'p_state',
        phase: room.phase,
        name: p.name,
        showOptions: s.showOptionsOnPhone,
        mode: s.mode,
        qNum: room.qPos + 1,
        qTotal: room.order.length,
        score: p.score,
        rank: p.rank || 1,
        playerCount: room.players.size,
        correctCount: p.correctCount,
      };
      if (cur && (room.phase === 'question' || room.phase === 'reveal')) {
        st.nOptions = cur.optionOrder.length;
        if (s.showOptionsOnPhone) {
          st.question = { text: cur.q.text, options: cur.optionOrder.map((i) => cur.q.options[i]) };
        }
        const a = cur.answers.get(p.pid);
        st.answered = !!a;
        st.myChoice = a ? a.choice : null;
        if (room.phase === 'question') {
          st.limitMs = cur.limitMs;
          st.remainingMs = cur.deadline ? Math.max(0, cur.deadline - Date.now()) : null;
        } else {
          st.correctPos = cur.correctPos;
          st.result = { answered: !!a, correct: !!(a && a.correct), points: p.lastPoints };
        }
      }
      return st;
    }

    /* ───── invio ───── */

    function sendHost(room, onlyWs) {
      const str = JSON.stringify(hostState(room));
      for (const ws of onlyWs ? [onlyWs] : room.hostSockets) if (ws.readyState === 1) ws.send(str);
    }
    function sendHostAnswers(room) {
      const cur = room.current;
      if (!cur) return;
      const msg = JSON.stringify({ t: 'host_answers', answered: [...cur.answers.keys()], answeredCount: cur.answers.size });
      for (const ws of room.hostSockets) if (ws.readyState === 1) ws.send(msg);
    }
    function sendPlayer(room, p) {
      const str = JSON.stringify(playerState(room, p));
      for (const ws of p.sockets) if (ws.readyState === 1) ws.send(str);
    }
    function sendPlayers(room) { for (const p of room.players.values()) sendPlayer(room, p); }
    function broadcastAll(room) { sendHost(room); sendPlayers(room); changed(room); }

    /* ───── logica di gioco ───── */

    function startQuestion(room) {
      const qi = room.order[room.qPos];
      const q = room.quiz.questions[qi];
      const optionOrder = shuffle(q.options.map((_, i) => i)); // posizione a schermo → indice originale
      const timed = room.settings.mode === 'timed';
      const limitMs = room.settings.timeLimit * 1000;
      const now = Date.now();
      room.current = {
        qi, q, optionOrder,
        correctPos: optionOrder.indexOf(0),   // l'opzione 0 (la "a" del file) è quella giusta
        startedAt: now,
        limitMs,
        deadline: timed ? now + limitMs : null,
        answers: new Map(),
        counts: null,
        timer: null,
      };
      room.phase = 'question';
      if (timed) room.current.timer = setTimeout(() => lockQuestion(room), limitMs + GRACE_MS);
    }

    function lockQuestion(room) {
      const cur = room.current;
      if (!cur || room.phase !== 'question') return;
      if (cur.timer) { clearTimeout(cur.timer); cur.timer = null; }

      const counts = cur.optionOrder.map(() => 0);
      let nCorrect = 0;
      for (const p of room.players.values()) {
        const a = cur.answers.get(p.pid);
        if (a) {
          counts[a.choice]++;
          const points = a.correct ? computePoints(room, a.ms, cur.limitMs) : 0;
          p.score += points;
          p.answeredCount++;
          if (a.correct) { p.correctCount++; p.totalMs += a.ms; nCorrect++; }
          p.answers[room.qPos] = { choice: a.choice, correct: a.correct, points, ms: a.ms };
          p.lastPoints = points;
        } else {
          p.lastPoints = 0;
        }
      }
      cur.counts = counts;
      room.played.push({
        num: room.qPos + 1,
        text: cur.q.text,
        correctText: cur.q.options[0],
        counts,
        answered: cur.answers.size,
        correct: nCorrect,
        total: room.players.size,
      });
      room.phase = 'reveal';
      room.rankDirty = true;
      broadcastAll(room);
    }

    function nextQuestion(room) {
      if (room.phase !== 'reveal') return;
      if (room.qPos + 1 >= room.order.length) {
        room.phase = 'finished';
        room.current = null;
      } else {
        room.qPos++;
        startQuestion(room);
      }
      broadcastAll(room);
    }

    function maybeAutoLock(room) {
      if (room.phase !== 'question') return;
      const conn = [...room.players.values()].filter(isConnected);
      if (!conn.length) return;
      if (conn.every((p) => room.current.answers.has(p.pid))) lockQuestion(room);
    }

    /* ───── comandi ───── */

    function hostCommand(room, msg) {
      switch (msg.t) {
        case 'settings':
          if (room.phase === 'lobby' || room.phase === 'reveal') {
            room.settings = sanitizeSettings(msg.settings, room.settings);
            if (room.phase === 'lobby') room.order = buildOrder(room);
            broadcastAll(room);
          }
          break;
        case 'start':
          if (room.phase === 'lobby') {
            room.order = buildOrder(room);
            room.qPos = 0;
            startQuestion(room);
            broadcastAll(room);
          }
          break;
        case 'lock':
          lockQuestion(room);
          break;
        case 'next':
          nextQuestion(room);
          break;
        case 'end':
          if (room.phase === 'question') lockQuestion(room);
          if (room.phase === 'reveal') { room.phase = 'finished'; room.current = null; broadcastAll(room); }
          break;
        case 'close':
          destroyRoom(room);
          break;
        case 'restart':
          if (room.phase === 'finished' || room.phase === 'reveal' || room.phase === 'question') {
            resetGame(room);
            broadcastAll(room);
          }
          break;
        case 'kick': {
          const p = room.players.get(String(msg.pid));
          if (!p) break;
          room.players.delete(p.pid);
          room.tokens.delete(p.token);
          room.rankDirty = true;
          for (const ws of p.sockets) { send(ws, { t: 'kicked' }); ws.ctx = null; ws.close(); }
          sendHost(room);
          sendPlayers(room);
          maybeAutoLock(room);
          changed(room);
          break;
        }
        default: break;
      }
    }

    function playerCommand(room, ctx, msg) {
      const p = room.players.get(ctx.pid);
      if (!p) return;
      if (msg.t === 'answer') {
        const cur = room.current;
        if (room.phase !== 'question' || !cur || cur.answers.has(p.pid)) return;
        const choice = Number.isInteger(msg.choice) ? msg.choice : -1;
        if (choice < 0 || choice >= cur.optionOrder.length) return;
        const now = Date.now();
        if (cur.deadline && now > cur.deadline + GRACE_MS) return;
        cur.answers.set(p.pid, { choice, ms: Math.min(now - cur.startedAt, cur.deadline ? cur.limitMs : Infinity), correct: choice === cur.correctPos });
        sendPlayer(room, p);
        sendHostAnswers(room);
        maybeAutoLock(room);
      }
    }

    /* ───── ingresso e uscita ───── */

    // info = { code?, joinUrl, qr }. Restituisce la stanza oppure null (errore già inviato a ws).
    function createRoom(ws, msg, info) {
      const v = validateNew(msg);
      if (v.error) { send(ws, v.error); return null; }
      const code = info.code || newCode();
      const room = {
        code, hostToken: token(), hostSockets: new Set(),
        createdAt: Date.now(), lastActivity: Date.now(),
        title: v.title, quiz: { questions: v.questions },
        settings: sanitizeSettings(msg.settings, DEFAULT_SETTINGS),
        players: new Map(), tokens: new Map(),
        phase: 'lobby', qPos: -1, order: [], current: null, played: [],
        joinUrl: info.joinUrl, qr: info.qr, ranked: [], rankDirty: true,
      };
      resetGame(room);
      rooms.set(code, room);
      ws.ctx = { role: 'host', code };
      room.hostSockets.add(ws);
      send(ws, { t: 'host_info', code, hostToken: room.hostToken, joinUrl: room.joinUrl, qr: room.qr });
      sendHost(room, ws);
      changed(room);
      return room;
    }

    function attachHost(ws, msg) {
      const room = rooms.get(String(msg.code));
      if (!room || room.hostToken !== msg.hostToken) return send(ws, { t: 'room_gone' });
      ws.ctx = { role: 'host', code: room.code };
      room.hostSockets.add(ws);
      room.lastActivity = Date.now();
      send(ws, { t: 'host_info', code: room.code, hostToken: room.hostToken, joinUrl: room.joinUrl, qr: room.qr });
      sendHost(room, ws);
    }

    function joinPlayer(ws, msg) {
      const room = rooms.get(String(msg.code || '').trim());
      if (!room) return send(ws, { t: 'join_error', code: 'nocode', msg: 'Codice non valido. Controlla le 4 cifre sullo schermo.' });
      room.lastActivity = Date.now();

      let p = null;
      if (msg.token && room.tokens.has(msg.token)) p = room.players.get(room.tokens.get(msg.token));
      let isNew = false;
      if (!p) {
        const name = cleanName(msg.name);
        if (!name) return send(ws, { t: 'join_error', code: 'noname', msg: 'Scrivi il tuo nome per entrare.' });
        const same = [...room.players.values()].find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (same) {
          if (isConnected(same)) {
            return send(ws, { t: 'join_error', code: 'dup', msg: 'Questo nome è già usato. Aggiungi l’iniziale del cognome.' });
          }
          p = same; // stesso nome, utente disconnesso: riprende da dove era
        } else {
          if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'join_error', msg: 'La stanza è piena.' });
          p = {
            pid: token(6), token: token(), name, sockets: new Set(), rank: 0,
            score: 0, correctCount: 0, totalMs: 0, answeredCount: 0, answers: {}, lastPoints: 0,
          };
          room.players.set(p.pid, p);
          room.tokens.set(p.token, p.pid);
          room.rankDirty = true;
          isNew = true;
        }
      }
      p.sockets.add(ws);
      ws.ctx = { role: 'player', code: room.code, pid: p.pid };
      send(ws, { t: 'joined', token: p.token, name: p.name, code: room.code, title: room.title });
      sendPlayer(room, p);
      sendHost(room);
      if (isNew) changed(room);
    }

    // messaggi in arrivo da un socket (tutto tranne host_create, gestito da chi crea la stanza)
    function handle(ws, msg) {
      if (!msg || typeof msg.t !== 'string') return;
      if (!ws.ctx) {
        if (msg.t === 'host_resume') return attachHost(ws, msg);
        if (msg.t === 'join') return joinPlayer(ws, msg);
        return;
      }
      const room = rooms.get(ws.ctx.code);
      if (!room) return send(ws, { t: 'room_gone' });
      room.lastActivity = Date.now();
      if (ws.ctx.role === 'host') hostCommand(room, msg);
      else if (msg.t === 'join' && msg.token && String(msg.code) === room.code) joinPlayer(ws, msg); // risincronizzazione
      else playerCommand(room, ws.ctx, msg);
    }

    function onClose(ws) {
      const ctx = ws.ctx;
      if (!ctx) return;
      const room = rooms.get(ctx.code);
      if (!room) return;
      if (ctx.role === 'host') { room.hostSockets.delete(ws); return; }
      const p = room.players.get(ctx.pid);
      if (!p) return;
      p.sockets.delete(ws);
      if (!p.sockets.size) {
        sendHost(room);
        maybeAutoLock(room);
      }
    }

    function destroyRoom(room) {
      rooms.delete(room.code);
      if (room.current && room.current.timer) clearTimeout(room.current.timer);
      const socks = [...room.hostSockets];
      for (const p of room.players.values()) socks.push(...p.sockets);
      for (const ws of socks) { send(ws, { t: 'room_gone' }); ws.ctx = null; ws.close(); }
      if (opts.onDestroy) { try { opts.onDestroy(room); } catch (e) { /* ignore */ } }
    }

    /* ───── salvataggio e ripristino (ricarica della pagina dell'istruttore) ───── */

    function snapshot(room) {
      const cur = room.current;
      return {
        v: 1,
        savedAt: Date.now(),
        code: room.code,
        hostToken: room.hostToken,
        title: room.title,
        joinUrl: room.joinUrl,
        qr: room.qr,
        questions: room.quiz.questions,
        settings: room.settings,
        phase: room.phase,
        qPos: room.qPos,
        order: room.order,
        played: room.played,
        current: (room.phase === 'reveal' && cur)
          ? { qi: cur.qi, optionOrder: cur.optionOrder, correctPos: cur.correctPos, counts: cur.counts, limitMs: cur.limitMs, startedAt: cur.startedAt, answers: [...cur.answers.entries()] }
          : null,
        players: [...room.players.values()].map((p) => ({
          pid: p.pid, token: p.token, name: p.name, score: p.score, correctCount: p.correctCount,
          totalMs: p.totalMs, answeredCount: p.answeredCount, answers: p.answers, lastPoints: p.lastPoints,
        })),
      };
    }

    function restore(snap) {
      if (!snap || snap.v !== 1 || !snap.code || !Array.isArray(snap.questions) || !snap.questions.length) return null;
      const room = {
        code: String(snap.code), hostToken: snap.hostToken, hostSockets: new Set(),
        createdAt: Date.now(), lastActivity: Date.now(),
        title: snap.title, quiz: { questions: snap.questions },
        settings: sanitizeSettings(snap.settings, DEFAULT_SETTINGS),
        players: new Map(), tokens: new Map(),
        phase: snap.phase, qPos: snap.qPos, order: snap.order, current: null, played: snap.played || [],
        joinUrl: snap.joinUrl, qr: snap.qr, ranked: [], rankDirty: true,
      };
      (snap.players || []).forEach((p) => {
        room.players.set(p.pid, Object.assign({ sockets: new Set(), rank: 0 }, p));
        room.tokens.set(p.token, p.pid);
      });
      if (room.phase === 'reveal' && snap.current) {
        const c = snap.current;
        room.current = {
          qi: c.qi, q: room.quiz.questions[c.qi], optionOrder: c.optionOrder, correctPos: c.correctPos,
          startedAt: c.startedAt, limitMs: c.limitMs, deadline: null, answers: new Map(c.answers), counts: c.counts, timer: null,
        };
      } else if (room.phase === 'question') {
        startQuestion(room); // la domanda in corso riparte da capo (le risposte date non erano state salvate)
      } else if (room.phase === 'reveal') {
        room.phase = 'lobby'; room.qPos = -1; room.played = []; // stato incoerente: si riparte
      }
      rooms.set(room.code, room);
      return room;
    }

    return { rooms, newCode, validateNew, createRoom, handle, onClose, destroyRoom, snapshot, restore };
  }

  return { create, validateNew, DEFAULT_SETTINGS, MAX_QUESTIONS };
}));
