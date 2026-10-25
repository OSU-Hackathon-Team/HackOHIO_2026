const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { scheduleReview } = require("./engine/scheduler.cjs");
const { computeStreak } = require("./engine/streaks.cjs");

const deckPath = name => path.join(app.getPath("userData"), "decks", `${name}.json`);
const readDeck = async name => JSON.parse(await fs.readFile(deckPath(name), "utf8"));
const writeDeck = async (name, deck) => fs.writeFile(deckPath(name), JSON.stringify(deck, null, 2));
const today = () => new Date().toISOString().slice(0, 10);

app.whenReady().then(() => {
  ipcMain.handle("card:answer", async (_event, deckName, cardId, grade) => {
    const deck = await readDeck(deckName);
    const card = deck.cards.find(item => item.id === cardId);
    Object.assign(card, scheduleReview(card, grade, Date.now()));
    deck.history.push(today());
    await writeDeck(deckName, deck);
    return card;
  });
  ipcMain.handle("stats:streak", async (_event, deckName) => {
    const deck = await readDeck(deckName);
    return computeStreak(deck.history, today());
  });

  // The demo UI uses two additional local-only channels. The original channels above
  // preserve their observed signatures and file effects.
  ipcMain.handle("demo:prepare", async () => {
    const name = "demo";
    await fs.mkdir(path.dirname(deckPath(name)), { recursive: true });
    try { return await readDeck(name); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const deck = { cards: [{ id: "first", front: "What makes a review due?", back: "Its interval and last grade.", reps: 0, interval: 0, ease: 2.5, lapses: 0, due: 0 }], history: [] };
    await writeDeck(name, deck);
    return deck;
  });
  ipcMain.handle("demo:state", () => readDeck("demo"));

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  const win = new BrowserWindow({ width: 900, height: 640, webPreferences: {
    preload: path.join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true,
  } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
