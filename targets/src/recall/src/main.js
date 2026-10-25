"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { loadDeck, saveDeck } = require("./db/deckStore");
const { scheduleReview } = require("./scheduler/sm2");
const { computeStreak } = require("./stats/streaks");

const DATA_DIR = () => path.join(app.getPath("userData"), "decks");

app.whenReady().then(() => {
  ipcMain.handle("card:answer", async (_e, deckName, cardId, grade) => {
    const deck = await loadDeck(DATA_DIR(), deckName);
    const card = deck.cards.find((c) => c.id === cardId);
    Object.assign(card, scheduleReview(card, grade, Date.now()));
    deck.history.push(new Date().toISOString().slice(0, 10));
    await saveDeck(DATA_DIR(), deckName, deck);
    return card;
  });
  ipcMain.handle("stats:streak", async (_e, deckName) => {
    const deck = await loadDeck(DATA_DIR(), deckName);
    return computeStreak(deck.history, new Date().toISOString().slice(0, 10));
  });
  new BrowserWindow({ width: 900, height: 640 }).loadURL("data:text/html,<h1>Recall</h1>");
});
