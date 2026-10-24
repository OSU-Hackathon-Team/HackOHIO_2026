"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("inkwell", {
  graph: () => ipcRenderer.invoke("graph:get"),
  search: (q) => ipcRenderer.invoke("search:query", q),
});
