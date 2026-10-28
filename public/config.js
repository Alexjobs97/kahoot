/*
 * Configurazione di trasporto.
 *  - 'p2p' (predefinito, GitHub Pages): il browser dell'istruttore fa da server, gli studenti si
 *    collegano a lui in WebRTC. Serve solo un servizio di "presentazione" (PeerJS) per l'incontro iniziale.
 *  - 'ws': quando le pagine sono servite da server.js (npm start), che sovrascrive questo file.
 *
 * Servizio di segnalazione: di base il servizio pubblico gratuito di PeerJS. Se un giorno non fosse
 * raggiungibile puoi usarne uno tuo, per esempio:
 *   window.QUIZ_PEER = { host: 'mio-server.onrender.com', port: 443, path: '/', secure: true };
 */
window.QUIZ_TRANSPORT = window.QUIZ_TRANSPORT || 'p2p';
window.QUIZ_PEER = window.QUIZ_PEER || {};
