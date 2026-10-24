"use strict";
const fs = require("fs/promises");
const path = require("path");

async function loadDeck(dir, name) {
  const raw = await fs.readFile(path.join(dir, name + ".json"), "utf8");
  return JSON.parse(raw);
}

async function saveDeck(dir, name, deck) {
  await fs.writeFile(path.join(dir, name + ".json"), JSON.stringify(deck, null, 2));
}

module.exports = { loadDeck, saveDeck };
