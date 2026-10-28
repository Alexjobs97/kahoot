/*
 * Connessione condivisa da pagina studenti e pagina istruttore.
 * QuizConn(handlers, role) → { send(obj), isOpen(), reconnectNow() }
 *   handlers: onOpen(), onStatus(bool), onMessage(obj)
 *   role: 'host' | 'player'
 * Con config.js = 'p2p' usa WebRTC (p2p.js); con 'ws' usa il WebSocket del server (server.js).
 */
(function () {
  'use strict';

  function wsConn(handlers) {
    let ws = null;
    let tries = 0;
    let timer = null;

    function url() {
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    }

    function open() {
      clearTimeout(timer);
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      try { ws = new WebSocket(url()); } catch (e) { schedule(); return; }
      const mine = ws;
      mine.onopen = () => {
        tries = 0;
        if (handlers.onStatus) handlers.onStatus(true);
        if (handlers.onOpen) handlers.onOpen();
      };
      mine.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m && handlers.onMessage) handlers.onMessage(m);
      };
      mine.onclose = () => {
        if (ws === mine && handlers.onStatus) handlers.onStatus(false);
        schedule();
      };
      mine.onerror = () => {};
    }

    function schedule() {
      clearTimeout(timer);
      tries += 1;
      timer = setTimeout(open, Math.min(4000, 300 * tries));
    }

    function reconnectNow() {
      if (!ws || ws.readyState > 1) { tries = 0; open(); }
    }

    document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnectNow(); });
    window.addEventListener('online', reconnectNow);
    window.addEventListener('pageshow', reconnectNow);

    open();

    return {
      send(obj) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } return false; },
      isOpen() { return !!ws && ws.readyState === 1; },
      reconnectNow,
    };
  }

  window.QuizConn = function (handlers, role) {
    if ((window.QUIZ_TRANSPORT || 'p2p') === 'p2p' && window.QuizP2P) {
      return role === 'host' ? window.QuizP2P.host(handlers) : window.QuizP2P.player(handlers);
    }
    return wsConn(handlers);
  };
})();
