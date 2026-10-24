"use strict";
const fs = require("fs/promises");
const path = require("path");

async function loadVault(dir) {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  return Promise.all(files.map(async (f) => {
    const body = await fs.readFile(path.join(dir, f), "utf8");
    const heading = body.match(/^#\s+(.+)$/m);
    return { id: f, title: heading ? heading[1].trim() : f.replace(/\.md$/, ""), body };
  }));
}

module.exports = { loadVault };
