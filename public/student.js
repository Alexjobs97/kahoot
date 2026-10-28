(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const LETTERS = ['A', 'B', 'C', 'D'];
  const ICON = {
    ok: '<svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="54" fill="currentColor"/><path d="M33 62l19 19 36-40" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bad: '<svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="54" fill="currentColor"/><path d="M40 40l40 40M80 40L40 80" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round"/></svg>',
    none: '<svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="54" fill="currentColor"/><path d="M60 32v30l20 12" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const tokKey = (c) => 'quiz.token.' + c;

  const params = new URLSearchParams(location.search);
  const urlCode = (params.get('c') || '').replace(/\D/g, '').slice(0, 4);

  let session = null;   // { code, token, name } dopo l'ingresso
  let pending = null;   // { code, name } ingresso in corso
  let st = null;        // ultimo stato dal server
  let endsAt = null;
  let limitMs = null;
  let view = 'join';
  let lastQKey = '';

  /* ───── viste ───── */
  function show(name) {
    view = name;
    document.querySelectorAll('[data-view]').forEach((el) => { el.hidden = el.dataset.view !== name; });
    window.scrollTo(0, 0);
  }

  function showJoin(errMsg) {
    show('join');
    $('#codeRow').hidden = !!urlCode;
    $('#roomNote').hidden = !urlCode;
    if (urlCode) $('#roomNote').textContent = 'Stanza ' + urlCode;
    const saved = store.get('quiz.name');
    if (saved && !$('#nameInput').value) $('#nameInput').value = saved;
    setErr(errMsg);
    $('#joinNote').hidden = true;
    $('#joinBtn').disabled = false;
  }

  function setErr(msg) {
    const e = $('#joinErr');
    e.hidden = !msg;
    e.textContent = msg || '';
  }

  /* ───── connessione ───── */
  const conn = QuizConn({
    onOpen() {
      if (session) conn.send({ t: 'join', code: session.code, token: session.token, name: session.name });
      else if (pending) conn.send({ t: 'join', code: pending.code, name: pending.name });
    },
    onStatus(ok) { $('#conn').hidden = ok || !session; },
    onMessage(m) {
      switch (m.t) {
        case 'joined':
          session = { code: m.code, token: m.token, name: m.name };
          pending = null;
          $('#joinNote').hidden = true;
          store.set(tokKey(m.code), m.token);
          store.set('quiz.name', m.name);
          requestWake();
          break;
        case 'p_state':
          st = m;
          render();
          break;
        case 'join_error':
          if (m.code === 'net') { // servizio di connessione non raggiungibile: non perdo la sessione
            if (!session) { pending = null; showJoin(m.msg); }
            break;
          }
          if (session && m.code === 'nocode') {
            store.del(tokKey(session.code));
            session = null;
            showGone('Stanza non trovata', 'Il quiz è finito oppure il codice non è più valido.');
          } else {
            if (session) { store.del(tokKey(session.code)); session = null; }
            pending = null;
            showJoin(m.msg);
          }
          break;
        case 'kicked':
          if (session) store.del(tokKey(session.code));
          session = null;
          showGone('Sei stato rimosso', 'L’istruttore ti ha tolto dal quiz. Puoi rientrare scrivendo il tuo nome.');
          break;
        case 'room_gone':
          if (session) store.del(tokKey(session.code));
          session = null;
          showGone('Il quiz è chiuso', 'L’istruttore ha chiuso la stanza. Grazie per aver partecipato!');
          break;
        default: break;
      }
    },
  }, 'player');

  function showGone(title, text) {
    $('#goneTitle').textContent = title;
    $('#goneText').textContent = text;
    $('#conn').hidden = true;
    show('gone');
  }

  /* ───── ingresso ───── */
  $('#codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });

  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = urlCode || $('#codeInput').value.trim();
    const name = $('#nameInput').value.trim();
    if (code.length !== 4) return setErr('Scrivi le 4 cifre del codice che vedi sullo schermo.');
    if (!name) return setErr('Scrivi il tuo nome per entrare.');
    setErr('');
    $('#joinBtn').disabled = true;
    $('#joinNote').hidden = false;
    pending = { code, name };
    if (!conn.send({ t: 'join', code, name })) {
      conn.reconnectNow();
      setTimeout(() => { if (pending && !conn.isOpen()) { pending = null; showJoin('Non riesco a collegarmi. Controlla la connessione e riprova.'); } }, 6000);
    }
  });

  $('#leaveBtn').addEventListener('click', () => {
    if (session) store.del(tokKey(session.code));
    session = null;
    st = null;
    showJoin();
  });
  $('#againBtn').addEventListener('click', () => {
    if (urlCode) location.href = location.pathname;
    else showJoin();
  });

  /* ───── disegno ───── */
  function render() {
    if (!st) return;
    switch (st.phase) {
      case 'lobby': renderWait(); break;
      case 'question': renderQuestion(); break;
      case 'reveal': renderReveal(); break;
      case 'finished': renderFinal(); break;
      default: break;
    }
  }

  function renderWait() {
    if (view !== 'wait') show('wait');
    $('#helloName').textContent = st.name;
    const n = st.playerCount;
    $('#waitCount').textContent = n === 1 ? 'Per ora ci sei solo tu.' : 'Siete già in ' + n + '.';
  }

  function renderQuestion() {
    const key = st.qNum + ':' + (st.answered ? 'a' + st.myChoice : 'o');
    if (view !== 'question') show('question');
    $('#qNumLbl').textContent = 'Domanda ' + st.qNum + ' di ' + st.qTotal;

    const timed = st.remainingMs != null;
    $('#timerWrap').hidden = !timed;
    $('#qTimeLbl').hidden = !timed;
    if (timed) {
      endsAt = Date.now() + st.remainingMs;
      limitMs = st.limitMs;
    } else { endsAt = null; }

    const qText = $('#qText');
    qText.hidden = !st.showOptions;
    if (st.showOptions) qText.textContent = st.question.text;
    $('#lookHint').hidden = st.showOptions || st.answered;

    if (key !== lastQKey) { buildTiles(); lastQKey = key; }

    $('#qStatus').textContent = st.answered
      ? 'Risposta inviata. Aspetta gli altri.'
      : (timed ? '' : 'Scegli e tocca una risposta.');
    tick();
  }

  function buildTiles() {
    const box = $('#tiles');
    box.replaceChildren();
    box.className = st.showOptions ? 'tiles-text' : 'tiles-letters';
    for (let i = 0; i < st.nOptions; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tile tile-' + i;
      b.setAttribute('aria-label', 'Risposta ' + LETTERS[i]);
      if (st.showOptions) {
        const badge = document.createElement('span');
        badge.className = 'tile-badge';
        badge.textContent = LETTERS[i];
        const txt = document.createElement('span');
        txt.textContent = st.question.options[i];
        b.append(badge, txt);
      } else {
        b.textContent = LETTERS[i];
      }
      if (st.answered) {
        b.disabled = true;
        b.classList.add(st.myChoice === i ? 'chosen' : 'dim');
      } else {
        b.addEventListener('click', () => answer(i));
      }
      box.append(b);
    }
  }

  function answer(i) {
    if (!st || st.answered) return;
    if (!conn.send({ t: 'answer', choice: i })) {
      $('#qStatus').textContent = 'Connessione assente. Riprovo, poi tocca di nuovo.';
      conn.reconnectNow();
      return;
    }
    if (navigator.vibrate) navigator.vibrate(30);
    st.answered = true;
    st.myChoice = i;
    lastQKey = '';
    renderQuestion();
  }

  function tick() {
    if (view !== 'question' || endsAt == null) return;
    const rem = Math.max(0, endsAt - Date.now());
    $('#timerFill').style.width = (limitMs ? Math.min(100, (rem / limitMs) * 100) : 0) + '%';
    $('#timerWrap').classList.toggle('low', limitMs && rem / limitMs < 0.25);
    $('#qTimeLbl').textContent = Math.ceil(rem / 1000) + ' s';
  }
  setInterval(tick, 100);

  function renderReveal() {
    show('reveal');
    lastQKey = '';
    const r = st.result;
    const cls = !r.answered ? 'none' : (r.correct ? 'ok' : 'bad');
    const icon = $('#resIcon');
    icon.innerHTML = ICON[cls];
    icon.className = 'res-' + cls;
    $('#resTitle').textContent = !r.answered ? 'Tempo scaduto' : (r.correct ? 'Giusto!' : 'Sbagliato');
    $('#resTitle').className = 'res-' + cls;
    $('#resPoints').textContent = r.correct ? '+' + r.points + ' punti' : (r.answered ? '0 punti' : 'Non hai risposto');

    const box = $('#resCorrect');
    box.replaceChildren();
    if (!r.correct) {
      const pill = document.createElement('span');
      pill.className = 'pill tile-' + st.correctPos;
      const badge = document.createElement('span');
      badge.className = 'tile-badge';
      badge.textContent = LETTERS[st.correctPos];
      pill.append(badge);
      if (st.showOptions && st.question) {
        const t = document.createElement('span');
        t.textContent = st.question.options[st.correctPos];
        pill.append(t);
      }
      const lead = document.createElement('span');
      lead.textContent = 'La risposta giusta era';
      box.append(lead, pill);
    }
    $('#resRank').textContent = 'Sei ' + st.rank + '° su ' + st.playerCount + ' con ' + st.score + ' punti';
    if (navigator.vibrate) navigator.vibrate(r.correct ? [60] : [40, 60, 40]);
  }

  function renderFinal() {
    show('final');
    lastQKey = '';
    const medals = { 1: '1° posto', 2: '2° posto', 3: '3° posto' };
    $('#finalRank').textContent = medals[st.rank] || (st.rank + '° posto');
    $('#finalPoints').textContent = st.score + ' punti';
    $('#finalLine').textContent = 'Risposte giuste: ' + st.correctCount + ' su ' + st.qNum + '. Siete stati in ' + st.playerCount + '.';
  }

  /* ───── schermo sempre acceso ───── */
  let wake = null;
  async function requestWake() {
    try {
      if ('wakeLock' in navigator && !wake) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      }
    } catch (e) { /* non supportato: pazienza */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && session) requestWake(); });

  /* ───── avvio ───── */
  const savedTok = urlCode ? store.get(tokKey(urlCode)) : null;
  if (urlCode && savedTok) {
    session = { code: urlCode, token: savedTok, name: store.get('quiz.name') || '' };
    show('wait');
    $('#helloName').textContent = session.name;
  } else {
    showJoin();
  }
})();
