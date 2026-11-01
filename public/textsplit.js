'use strict';
// Splits a text post for WhatsApp's text status. WhatsApp takes about 700 characters per
// text status (not officially documented; third-party character counters agree); 650
// leaves room. Longer texts become several statuses, split between paragraphs, else
// between sentences, else between words, and numbered "(1/3)", "(2/3)" …
// Used by the page (posts.js, to show how many statuses a text becomes) and by the
// publisher (publisher.js, to send them).
(function (root) {
  const STATUS_TEXT_MAX = 650;
  const MARK_ROOM = 8;  // " (12/12)"

  // A piece that is still too long: sentences, then words, then hard cuts.
  function splitLong(text, limit) {
    const out = [];
    let cur = '';
    const add = unit => {
      if (!cur) cur = unit;
      else if (cur.length + 1 + unit.length <= limit) cur += ' ' + unit;
      else { out.push(cur); cur = unit; }
    };
    for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
      if (sentence.length <= limit) { add(sentence); continue; }
      for (const word of sentence.split(/\s+/)) {
        if (word.length <= limit) { add(word); continue; }
        for (let i = 0; i < word.length; i += limit) add(word.slice(i, i + limit));
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function splitStatusText(text, max = STATUS_TEXT_MAX) {
    const t = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!t) return [];
    if (t.length <= max) return [t];
    const limit = max - MARK_ROOM;
    const chunks = [];
    let cur = '';
    for (const para of t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)) {
      const pieces = para.length <= limit ? [para] : splitLong(para, limit);
      pieces.forEach((piece, i) => {
        const sep = i === 0 ? '\n\n' : ' ';
        if (!cur) cur = piece;
        else if (cur.length + sep.length + piece.length <= limit) cur += sep + piece;
        else { chunks.push(cur); cur = piece; }
      });
    }
    if (cur) chunks.push(cur);
    return chunks.map((c, i) => `${c} (${i + 1}/${chunks.length})`);
  }

  const api = { splitStatusText, STATUS_TEXT_MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
