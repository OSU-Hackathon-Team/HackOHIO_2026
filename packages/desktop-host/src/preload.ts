import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("splice", Object.freeze({
  workflows: () => ipcRenderer.invoke("splice:workflows"),
  runWorkflow: (workflowId: string, input: Record<string, unknown>) => ipcRenderer.invoke("splice:run", workflowId, input),
  getDocument: (documentId: string) => ipcRenderer.invoke("splice:document", documentId),
}));
