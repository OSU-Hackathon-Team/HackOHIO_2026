"use strict";
const FENCE = /^```/;
const LINK = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

/**
 * Extracts [[Target]], [[Target|alias]] and [[Target#Heading|alias]] links.
 * Links inside fenced code blocks and inline `code` are ignored.
 */
function parseWikiLinks(markdown) {
  const links = [];
  let inFence = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    if (FENCE.test(rawLine.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = rawLine.replace(/`[^`]*`/g, "");
    LINK.lastIndex = 0;
    let m;
    while ((m = LINK.exec(line)) !== null) {
      links.push({
        target: m[1].trim(),
        heading: m[2] ? m[2].trim() : null,
        alias: m[3] ? m[3].trim() : null,
      });
    }
  }
  return links;
}

function normalizeTitle(title) {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

module.exports = { parseWikiLinks, normalizeTitle };
