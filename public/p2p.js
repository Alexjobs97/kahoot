/*
 * Trasporto peer-to-peer (WebRTC via PeerJS) per l'hosting statico (GitHub Pages).
 *
 *  - Istruttore: il suo browser esegue il motore di gioco (engine.js) e si registra come
 *    "quizlive-<codice>". Lo stato della stanza viene salvato nel browser: se ricarica la pagina riprende.
 *  - Studente: si collega a "quizlive-<codice>" e parla con lo stesso protocollo del WebSocket.
 *
 * Il servizio PeerJS serve solo a far "incontrare" i due browser; le risposte viaggiano direttamente.
 */
(function () {
  'use strict';

  const PREFIX = 'quizlive-';
  const SNAP_KEY = 'quiz.snapshot.v1';
  const SNAP_MAX_AGE = 12 * 3600 * 1000;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  const peerOptions = () => Object.assign({ debug: 0 }, window.QUIZ_PEER || {});
  const NET_MSG = 'Non riesco a collegarmi al servizio di connessione. Controlla la connessione a Internet e riprova.';

  // apre una connessione al servizio di segnalazione; id opzionale (l'istruttore lo vuole fisso)
  function openPeer(id, onLateError) {
    return new Promise((resolve, reject) => {
      let p;
      try { p = new window.Peer(id, peerOptions()); } catch (e) { reject({ type: 'init', error: e }); return; }
      let settled = false;
      const to = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { p.destroy(); } catch (e) { /* ignore */ }
        reject({ type: 'timeout' });
      }, 12000);
      p.on('open', () => { if (settled) return; settled = true; clearTimeout(to); resolve(p); });
      p.on('error', (err) => {
        if (!settled) {
          settled = true; clearTimeout(to);
          try { p.destroy(); } catch (e) { /* ignore */ }
          reject(err);
        } else if (onLateError) onLateError(err, p);
      });
    });
  }

  /* ═══════════════════════════ ISTRUTTORE ═══════════════════════════ */

  function qrDataUrl(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 3;
    const size = n + quiet * 2;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges">' +
      '<rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#14213d"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function host(handlers) {
    let peer = null;
    let reconnectTimer = null;
    let creating = false;

    const engine = window.QuizEngine.create({
      persist: (snap) => store.set(SNAP_KEY, JSON.stringify(snap)),
      onDestroy: () => { store.del(SNAP_KEY); closePeer(); },
    });

    // "socket" locale dell'istruttore: i messaggi del motore arrivano alla pagina in modo asincrono
    const local = {
      readyState: 1, ctx: null,
      send(str) {
        Promise.resolve().then(() => {
          try { handlers.onMessage(JSON.parse(str)); } catch (e) { console.error(e); }
        });
      },
      close() {},
    };
    const deliver = (obj) => local.send(JSON.stringify(obj));

    function closePeer() {
      clearTimeout(reconnectTimer);
      if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } peer = null; }
    }

    function errText(e) {
      if (e && e.type === 'unavailable-id') return 'Non sono riuscito a riservare un codice. Riprova.';
      return NET_MSG;
    }

    // i telefoni degli studenti → motore (solo "join" e "answer": i comandi dell'istruttore restano locali)
    function wireConn(conn) {
      let w = null;
      const make = () => {
        w = {
          ctx: null,
          get readyState() { return conn.open ? 1 : 3; },
          send(str) { try { conn.send(str); } catch (e) { /* ignore */ } },
          close() { try { conn.close(); } catch (e) { /* ignore */ } },
        };
        return w;
      };
      conn.on('data', (d) => {
        let m;
        try { m = typeof d === 'string' ? JSON.parse(d) : d; } catch (e) { return; }
        if (!m || (m.t !== 'join' && m.t !== 'answer')) return;
        try { engine.handle(w || make(), m); } catch (e) { console.error(e); }
      });
      conn.on('close', () => { if (w) engine.onClose(w); });
      conn.on('error', () => {});
    }

    function attach(p) {
      peer = p;
      p.on('connection', wireConn);
      p.on('disconnected', () => {
        // persa la linea verso il servizio di segnalazione: le connessioni attive restano, ma i nuovi arrivati no
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(function retry() {
          if (!peer || peer.destroyed) return;
          if (peer.disconnected) { try { peer.reconnect(); } catch (e) { /* ignore */ } reconnectTimer = setTimeout(retry, 4000); }
        }, 1500);
      });
    }

    async function claim(code, attempts, delay) {
      let last;
      for (let i = 0; i < attempts; i++) {
        try { return await openPeer(PREFIX + code, () => {}); } catch (e) {
          last = e;
          if (i < attempts - 1) await new Promise((r) => setTimeout(r, delay));
        }
      }
      throw last;
    }

    async function create(msg) {
      if (creating) return;
      creating = true;
      try {
        const v = engine.validateNew(msg);
        if (v.error) { deliver(v.error); return; }
        let code = null;
        let p = null;
        let lastErr = null;
        for (let i = 0; i < 10 && !p; i++) {
          code = engine.newCode();
          try { p = await openPeer(PREFIX + code, () => {}); } catch (e) {
            lastErr = e;
            if (!e || e.type !== 'unavailable-id') break;
          }
        }
        if (!p) { deliver({ t: 'error', msg: errText(lastErr) }); return; }
        const joinUrl = new URL('./?c=' + code, location.href).href;
        attach(p);
        engine.createRoom(local, msg, { code, joinUrl, qr: qrDataUrl(joinUrl) });
      } finally {
        creating = false;
      }
    }

    // all'avvio: se c'era una stanza salvata, la rimetto in piedi e mi riregistro con lo stesso codice
    function boot() {
      let snap = null;
      try { snap = JSON.parse(store.get(SNAP_KEY) || 'null'); } catch (e) { snap = null; }
      const ready = () => setTimeout(() => {
        if (handlers.onStatus) handlers.onStatus(true);
        if (handlers.onOpen) handlers.onOpen();
      }, 0);
      if (!snap || !snap.savedAt || Date.now() - snap.savedAt > SNAP_MAX_AGE) {
        store.del(SNAP_KEY);
        ready();
        return;
      }
      const room = engine.restore(snap);
      if (!room) { store.del(SNAP_KEY); ready(); return; }
      claim(room.code, 8, 1500).then((p) => { attach(p); ready(); }).catch(() => {
        // codice occupato (stanza aperta in un'altra scheda?) o servizio non raggiungibile: rinuncio
        engine.rooms.delete(room.code);
        store.del(SNAP_KEY);
        ready();
      });
    }
    boot();

    return {
      send(obj) {
        if (!obj || typeof obj.t !== 'string') return false;
        if (obj.t === 'host_create') { create(obj); return true; }
        engine.handle(local, obj);
        return true;
      },
      isOpen() { return true; },
      reconnectNow() {},
    };
  }

  /* ═══════════════════════════ STUDENTE ═══════════════════════════ */

  function player(handlers) {
    let code = (new URLSearchParams(location.search).get('c') || '').replace(/\D/g, '').slice(0, 4) || null;
    let peer = null;
    let peerPromise = null;
    let conn = null;
    let connecting = false;
    let stopped = false;
    let everOpen = false;
    let tries = 0;
    let lostSince = 0;
    let netReported = false;
    let timer = null;
    let connectTimer = null;

    const status = (ok) => { if (handlers.onStatus) handlers.onStatus(ok); };

    function getPeer() {
      if (peer && !peer.destroyed && !peer.disconnected) return Promise.resolve(peer);
      if (peerPromise) return peerPromise;
      if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } peer = null; }
      peerPromise = openPeer(undefined, (err) => {
        if (err && err.type === 'peer-unavailable') fail('peer-unavailable');
      }).then((p) => { peer = p; return p; }).finally(() => { peerPromise = null; });
      return peerPromise;
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(connect, Math.min(5000, 800 * Math.max(1, tries)));
    }

    function fail(reason) {
      clearTimeout(connectTimer);
      if (conn && !conn.open) {
        const dead = conn;
        conn = null; // prima azzero, così il suo evento "close" viene ignorato
        try { dead.close(); } catch (e) { /* ignore */ }
      }
      connecting = false;
      if (stopped) return;
      tries += 1;
      if (!lostSince) lostSince = Date.now();
      if (reason === 'peer-unavailable') {
        // l'istruttore non c'è (ancora): se ha appena ricaricato la pagina riappare entro pochi secondi
        // (il servizio risponde "non trovato" dopo ~5 secondi per tentativo: due tentativi bastano per un codice sbagliato)
        const giveUp = everOpen ? Date.now() - lostSince > 90000 : tries >= 2;
        if (giveUp) {
          stopped = true;
          handlers.onMessage({ t: 'join_error', code: 'nocode', msg: 'Stanza non trovata. Controlla il codice sullo schermo oppure chiedi all’istruttore di mostrarlo di nuovo.' });
          return;
        }
      } else if (!everOpen && tries >= 3 && !netReported) {
        netReported = true;
        handlers.onMessage({ t: 'join_error', code: 'net', msg: NET_MSG });
      }
      status(false);
      schedule();
    }

    function connect() {
      clearTimeout(timer);
      if (stopped || !code) return;
      if (conn && (conn.open || connecting)) return;
      connecting = true;
      getPeer().then((p) => {
        if (stopped) { connecting = false; return; }
        const c = p.connect(PREFIX + code, { reliable: true, serialization: 'raw' });
        conn = c;
        clearTimeout(connectTimer);
        connectTimer = setTimeout(() => { if (conn === c && !c.open) fail('timeout'); }, 15000);
        c.on('open', () => {
          if (conn !== c) return;
          clearTimeout(connectTimer);
          connecting = false; tries = 0; lostSince = 0; netReported = false; everOpen = true;
          status(true);
          if (handlers.onOpen) handlers.onOpen();
        });
        c.on('data', (d) => {
          if (conn !== c) return;
          let m;
          try { m = typeof d === 'string' ? JSON.parse(d) : d; } catch (e) { return; }
          if (!m || typeof m.t !== 'string') return;
          if (m.t === 'room_gone' || m.t === 'kicked') stopped = true;
          handlers.onMessage(m);
        });
        c.on('close', () => {
          if (conn !== c) return;
          conn = null; connecting = false;
          clearTimeout(connectTimer);
          if (stopped) return;
          if (!lostSince) lostSince = Date.now();
          status(false);
          schedule();
        });
        c.on('error', () => {});
      }).catch((err) => fail(err && err.type ? err.type : 'net'));
    }

    function reconnectNow() {
      if (stopped || !code) return;
      if (conn && (conn.open || connecting)) return;
      tries = 0;
      connect();
    }

    // al ritorno dal blocco schermo: se il canale è vivo chiedo lo stato aggiornato, altrimenti riconnetto
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (conn && conn.open) { if (handlers.onOpen) handlers.onOpen(); } else reconnectNow();
    });
    window.addEventListener('online', reconnectNow);
    window.addEventListener('pageshow', () => { if (!conn || !conn.open) reconnectNow(); });

    if (code) setTimeout(connect, 0); // codice già nel link (QR / WhatsApp): collego subito

    return {
      send(obj) {
        if (!obj || typeof obj.t !== 'string') return false;
        if (obj.t === 'join' && obj.code) {
          const c = String(obj.code).replace(/\D/g, '').slice(0, 4);
          if (c && c !== code) {
            code = c;
            if (conn) { try { conn.close(); } catch (e) { /* ignore */ } conn = null; }
            connecting = false; everOpen = false; tries = 0; lostSince = 0; netReported = false;
          }
        }
        if (conn && conn.open) {
          try { conn.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
        }
        if (obj.t === 'join') {
          stopped = false;
          connect(); // all'apertura la pagina invia da sola il "join"
          return true;
        }
        return false;
      },
      isOpen() { return !!(conn && conn.open); },
      reconnectNow,
    };
  }

  window.QuizP2P = { host, player };
})();
