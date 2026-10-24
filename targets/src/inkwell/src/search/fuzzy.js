"use strict";

function isBoundary(text, i) {
  return i === 0 || /[\s\-_/.]/.test(text[i - 1]);
}

/** Subsequence match. Returns null if not all query chars appear in order. Higher = better. */
function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === " ") continue;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) { found = ti; break; }
      ti++;
    }
    if (found === -1) return null;
    score += 1;
    if (found === prev + 1) score += 5;
    if (isBoundary(text, found)) score += 10;
    if (found === 0) score += 3;
    prev = found;
    ti = found + 1;
  }
  score -= Math.floor((t.length - q.length) / 10);
  return score;
}

function rankNotes(query, notes, limit) {
  const out = [];
  for (const n of notes) {
    const s = fuzzyScore(query, n.title);
    if (s !== null) out.push({ id: n.id, title: n.title, score: s });
  }
  out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return out.slice(0, limit === undefined ? 10 : limit);
}

module.exports = { fuzzyScore, rankNotes };
