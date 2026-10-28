'use strict';
/*
 * Quiz in Aula — server opzionale (HTTP statico + WebSocket).
 * Serve solo se NON usi la versione su GitHub Pages: la logica di gioco è in public/engine.js.
 * Avvio:  npm start     (porta: variabile PORT, default 3000)
 * Link pubblico dietro proxy/tunnel: variabile PUBLIC_URL (es. https://quiz.example.com)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const QuizEngine = require('./public/engine.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ROOMS = 100;
const ROOM_TTL_MS = 8 * 3600 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function lanIp() {
  const nets = os.networkInterfaces();
  const found = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) found.push(n.address);
    }
  }
  return found.find((ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) || found[0] || null;
}

function baseUrlFor(req, port) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const hostHeader = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${port}`).split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader);
  const h = m ? m[1] : hostHeader;
  const p = m && m[2] ? m[2] : String(port);
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(h)) {
    const ip = lanIp();
    if (ip) return `http://${ip}:${p}`;
  }
  return `${proto}://${hostHeader}`;
}

function start(port = parseInt(process.env.PORT, 10) || 3000) {
  const engine = QuizEngine.create();
  const rooms = engine.rooms;

  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
    if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    // le pagine usano il WebSocket di questo server, non WebRTC
    if (pathname === '/config.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
      return res.end("window.QUIZ_TRANSPORT = 'ws';\n");
    }
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/host' || pathname === '/host/') pathname = '/host.html';
    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Pagina non trovata'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });
  let actualPort = port;

  async function createRoom(ws, msg) {
    if (rooms.size >= MAX_ROOMS) return ws.send(JSON.stringify({ t: 'error', msg: 'Server pieno, riprova tra poco.' }));
    const v = engine.validateNew(msg);
    if (v.error) return ws.send(JSON.stringify(v.error));
    const code = engine.newCode();
    const joinUrl = `${baseUrlFor(ws.req, actualPort)}/?c=${code}`;
    const qr = await QRCode.toDataURL(joinUrl, {
      errorCorrectionLevel: 'M', margin: 1, width: 640, color: { dark: '#14213d', light: '#ffffff' },
    });
    engine.createRoom(ws, msg, { code, joinUrl, qr });
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.req = req;
    ws.ctx = null;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      try {
        if (!ws.ctx && msg.t === 'host_create') return await createRoom(ws, msg);
        engine.handle(ws, msg);
      } catch (e) {
        console.error('Errore messaggio:', e);
      }
    });
    ws.on('close', () => engine.onClose(ws));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 25000);

  const janitor = setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) if (now - room.lastActivity > ROOM_TTL_MS) engine.destroyRoom(room);
  }, 10 * 60 * 1000);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      actualPort = server.address().port;
      resolve({
        port: actualPort,
        rooms,
        close: () => new Promise((r) => {
          clearInterval(heartbeat); clearInterval(janitor);
          for (const room of [...rooms.values()]) engine.destroyRoom(room);
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => server.close(() => r()));
        }),
      });
    });
  });
}

if (require.main === module) {
  start().then(({ port }) => {
    const ip = lanIp();
    console.log('\n  Quiz in Aula avviato ✔\n');
    console.log(`  Pannello istruttore:  http://localhost:${port}/host`);
    if (ip) console.log(`  Studenti (stessa rete Wi-Fi):  http://${ip}:${port}`);
    if (process.env.PUBLIC_URL) console.log(`  Indirizzo pubblico:   ${process.env.PUBLIC_URL}`);
    console.log('');
  }).catch((e) => { console.error('Impossibile avviare il server:', e.message); process.exit(1); });
}

module.exports = { start };
