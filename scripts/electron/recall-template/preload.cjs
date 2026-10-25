const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("recall", {
  prepare: () => ipcRenderer.invoke("demo:prepare"),
  state: () => ipcRenderer.invoke("demo:state"),
  answer: (cardId, grade) => ipcRenderer.invoke("card:answer", "demo", cardId, grade),
  streak: () => ipcRenderer.invoke("stats:streak", "demo"),
});
