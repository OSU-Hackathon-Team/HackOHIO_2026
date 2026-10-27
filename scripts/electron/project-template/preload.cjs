const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("workbench", {
  manifest: () => ipcRenderer.invoke("workbench:manifest"),
  invoke: (featureId, functionName, args) => ipcRenderer.invoke("workbench:invoke", featureId, functionName, args),
});
