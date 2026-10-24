"use strict";
const { parseWikiLinks, normalizeTitle } = require("./wikilinks");

/**
 * notes: Array<{ id, title, body }>
 * Returns nodes with degree, de-duplicated directed edges, backlinks per note,
 * and unresolved link targets per note. Self-links are ignored.
 */
function buildLinkGraph(notes) {
  const byTitle = new Map();
  for (const n of notes) byTitle.set(normalizeTitle(n.title), n.id);

  const edges = [];
  const seen = new Set();
  const backlinks = {};
  const unresolved = {};
  for (const n of notes) backlinks[n.id] = [];

  for (const note of notes) {
    for (const link of parseWikiLinks(note.body)) {
      const targetId = byTitle.get(normalizeTitle(link.target));
      if (!targetId) {
        (unresolved[note.id] = unresolved[note.id] || []).push(link.target);
        continue;
      }
      if (targetId === note.id) continue;
      const key = note.id + "->" + targetId;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: note.id, to: targetId });
      backlinks[targetId].push(note.id);
    }
  }

  const degree = {};
  for (const e of edges) {
    degree[e.from] = (degree[e.from] || 0) + 1;
    degree[e.to] = (degree[e.to] || 0) + 1;
  }
  const nodes = notes.map((n) => ({ id: n.id, title: n.title, degree: degree[n.id] || 0 }));
  return { nodes, edges, backlinks, unresolved };
}

module.exports = { buildLinkGraph };
