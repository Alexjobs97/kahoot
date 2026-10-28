/*
 * Parser dei file .txt delle domande + logica di selezione (filtri, ban, rotazione).
 * Funziona sia nel browser (window.QuizParser) sia in Node (require).
 *
 * Formato:
 *
 *   1/16) Testo della domanda      <- il numero è la CATEGORIA (più categorie separate da /)
 *   a. risposta GIUSTA             <- la prima opzione è sempre quella corretta
 *   b. risposta sbagliata
 *   c. risposta sbagliata
 *   d. risposta sbagliata
 *
 * Tollerante a: righe vuote, CRLF/LF, BOM, "1)" "1." "1 -" "1:", lettere "a." "a)" "(a)" "A." "a:",
 * domande/risposte su più righe, righe di titolo opzionali che iniziano con "#".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QuizParser = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CATEGORIES = [
    { id: 1, name: 'Traumatico' },
    { id: 2, name: 'Cardiocircolatorio' },
    { id: 3, name: 'Respiratorio' },
    { id: 4, name: 'Neurologico' },
    { id: 5, name: 'Psichiatrico' },
    { id: 6, name: 'Neoplastico' },
    { id: 7, name: 'Intossicazione' },
    { id: 8, name: 'Metabolico' },
    { id: 9, name: 'Gastroenterologico' },
    { id: 10, name: 'Urologico' },
    { id: 11, name: 'Oculistico' },
    { id: 12, name: 'Otorinolaringoiatrico' },
    { id: 13, name: 'Dermatologico' },
    { id: 14, name: 'Ostetrico-ginecologico' },
    { id: 15, name: 'Infettivo' },
    { id: 16, name: 'Pediatrico' },
    { id: 17, name: 'Altro' },
  ];
  const CAT_MAX = CATEGORIES.length;
  const FALLBACK_CAT = 17; // domande senza categoria valida → "Altro"

  const LETTERS = ['a', 'b', 'c', 'd'];

  // "3/12/15) testo"  (più categorie: la parentesi è obbligatoria)
  const Q_MULTI_RE = /^\s*(\d{1,2}(?:\s*\/\s*\d{1,2})+)\s*\)\s*(.*)$/;
  // "12) testo" · "12. testo" · "12 - testo" · "12: testo"  (ma NON "3.5 mg")
  const Q_SINGLE_RE = /^\s*(\d{1,4})\s*(?:\)|[.:\-–—](?=\s|$))\s*(.*)$/;
  // "a. testo" · "a) testo" · "(a) testo" · "A - testo" · "a: testo"
  const OPT_RE = /^\s*[(\[]?\s*([a-dA-D])\s*(?:[)\]]|[.:\-–—](?=\s|$))\s*(.*)$/;

  const clean = (s) => String(s).replace(/\s+/g, ' ').trim();

  function matchQ(line) {
    const m = Q_MULTI_RE.exec(line) || Q_SINGLE_RE.exec(line);
    if (!m) return null;
    return { nums: m[1].split('/').map((x) => parseInt(x, 10)), raw: m[1].replace(/\s+/g, ''), rest: m[2] };
  }

  function parse(raw) {
    const text = String(raw == null ? '' : raw)
      .replace(/^﻿/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[   ]/g, ' ');
    const lines = text.split('\n');

    const questions = [];
    const warnings = [];
    const errors = [];
    let title = '';
    let cur = null;
    let blankBefore = false;
    let ignoredPre = false;

    const warn = (line, msg) => warnings.push({ line, msg });
    const err = (line, msg) => errors.push({ line, msg });

    function open(line, nums, rawNums, rest) {
      cur = { line, nums, raw: rawNums, textLines: rest ? [rest] : [], options: [] };
    }

    function close() {
      if (!cur) return;
      const c = cur;
      cur = null;
      const label = c.raw ? `Domanda "${c.raw})"` : 'Domanda';
      const where = `${label} (riga ${c.line})`;
      const qtext = clean(c.textLines.join(' '));
      const opts = c.options.map((o) => clean(o.lines.join(' ')));

      if (!qtext) { err(c.line, `${where}: testo della domanda mancante (ignorata)`); return; }
      if (opts.length < 2) {
        err(c.line, `${where}: servono almeno 2 risposte, ne ho trovate ${opts.length} (ignorata)`);
        return;
      }
      if (opts.length < 4) warn(c.line, `${where}: ha solo ${opts.length} risposte invece di 4`);

      opts.forEach((o, i) => {
        if (!o) { opts[i] = '—'; warn(c.line, `${where}: la risposta ${LETTERS[i]} è vuota`); }
      });
      const seen = new Set();
      opts.forEach((o) => {
        const k = o.toLowerCase();
        if (seen.has(k)) warn(c.line, `${where}: due risposte hanno lo stesso testo ("${o.slice(0, 30)}")`);
        seen.add(k);
      });

      const valid = [...new Set(c.nums.filter((n) => n >= 1 && n <= CAT_MAX))].sort((a, b) => a - b);
      const invalid = c.nums.filter((n) => n < 1 || n > CAT_MAX);
      let cats = valid;
      if (!valid.length) {
        cats = [FALLBACK_CAT];
        warn(c.line, c.nums.length
          ? `${where}: categoria ${invalid.join('/')} non valida (1–${CAT_MAX}), la metto in "Altro"`
          : `${where}: categoria mancante, la metto in "Altro"`);
      } else if (invalid.length) {
        warn(c.line, `${where}: ignoro la categoria non valida ${invalid.join('/')}`);
      }

      questions.push({
        n: questions.length + 1,
        srcNum: c.raw || null,
        line: c.line,
        text: qtext,
        options: opts,
        correct: 0, // la prima opzione è sempre quella giusta
        cats,
      });
    }

    lines.forEach((rawLine, idx) => {
      const lineNo = idx + 1;
      const line = rawLine.trim();
      if (!line) { blankBefore = true; return; }
      const wasBlank = blankBefore;
      blankBefore = false;

      const qm = matchQ(line);

      if (cur) {
        const expected = LETTERS[cur.options.length];
        if (expected) {
          const om = OPT_RE.exec(line);
          if (om && om[1].toLowerCase() === expected) {
            cur.options.push({ lines: om[2] ? [om[2]] : [] });
            return;
          }
        }
        if (qm) {
          close();
          open(lineNo, qm.nums, qm.raw, qm.rest);
          return;
        }
        // domanda senza numero, separata da una riga vuota dopo 4 risposte
        if (cur.options.length === 4 && wasBlank && !OPT_RE.test(line)) {
          close();
          open(lineNo, [], '', line);
          return;
        }
        // riga di continuazione
        if (cur.options.length > 0) cur.options[cur.options.length - 1].lines.push(line);
        else cur.textLines.push(line);
        return;
      }

      if (qm) { open(lineNo, qm.nums, qm.raw, qm.rest); return; }
      if (/^#/.test(line) && questions.length === 0) { // prima riga "#" = titolo, le altre = commenti
        if (!title) title = clean(line.replace(/^#+\s*/, ''));
        return;
      }
      if (!ignoredPre) { warn(lineNo, 'Testo prima della prima domanda: ignorato'); ignoredPre = true; }
    });
    close();

    if (!questions.length && !errors.length) {
      err(0, 'Nessuna domanda trovata. Ogni domanda deve iniziare con il numero di categoria, per esempio "3)" o "3/12)", e le risposte con "a." "b." "c." "d."');
    }
    return { title, questions, warnings, errors };
  }

  /* ───────────────────────── selezione ───────────────────────── */

  // include = categorie scelte (vuoto = tutte), ban = categorie escluse (hanno la precedenza)
  function filterPool(questions, sel) {
    const inc = new Set((sel && sel.include) || []);
    const ban = new Set((sel && sel.ban) || []);
    return questions.filter((q) =>
      !q.cats.some((c) => ban.has(c)) && (inc.size === 0 || q.cats.some((c) => inc.has(c))));
  }

  // quante domande contengono ciascuna categoria
  function categoryCounts(questions) {
    const counts = {};
    CATEGORIES.forEach((c) => { counts[c.id] = 0; });
    questions.forEach((q) => q.cats.forEach((c) => { counts[c] = (counts[c] || 0) + 1; }));
    return counts;
  }

  // impronta stabile di una domanda (testo + risposta giusta): resta uguale anche se il file cambia ordine
  function hashQ(q) {
    const s = (q.text + '\u0001' + q.options[0]).toLowerCase().replace(/\s+/g, ' ').trim();
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  /*
   * Estrae `count` domande dal pool già filtrato.
   * Rotazione ("sacchetto"): ogni domanda ha un contatore di quante volte è uscita; si prendono prima
   * quelle uscite meno volte e, a parità, a caso. Così, di quiz in quiz, escono tutte prima che
   * qualcuna si ripeta, e le domande nuove vengono usate subito. Con rotate=false è puro sorteggio.
   */
  function checkCount(available, count) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1) return 'Scrivi quante domande vuoi (almeno 1).';
    if (available === 0) return 'Con questi filtri non resta nessuna domanda.';
    if (n > available) return `Hai chiesto ${n} domande, ma con questi filtri ce ne sono solo ${available}.`;
    return null;
  }

  function pickQuestions(pool, count, usage, opts) {
    const o = opts || {};
    const rnd = o.rnd || Math.random;
    const rotate = o.rotate !== false;
    const u = usage || {};
    const bad = checkCount(pool.length, count);
    if (bad) return { error: bad, questions: [] };
    count = Number(count);
    const keyed = pool.map((q) => ({ q, k: (rotate ? (u[hashQ(q)] || 0) : 0) + rnd() }));
    keyed.sort((a, b) => a.k - b.k);
    const questions = keyed.slice(0, count).map((x) => x.q).sort((a, b) => a.n - b.n);
    return { questions, error: null };
  }

  function bumpUsage(usage, questions) {
    const next = Object.assign({}, usage || {});
    questions.forEach((q) => { const h = hashQ(q); next[h] = (next[h] || 0) + 1; });
    return next;
  }

  return { parse, CATEGORIES, filterPool, categoryCounts, hashQ, checkCount, pickQuestions, bumpUsage };
}));
