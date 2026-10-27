import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("splice", Object.freeze({
  workflows: () => ipcRenderer.invoke("splice:workflows"),
  runWorkflow: (workflowId: string, input: Record<string, unknown>) => ipcRenderer.invoke("splice:run", workflowId, input),
  getDocument: (documentId: string) => ipcRenderer.invoke("splice:document", documentId),
  transcriptionAvailability: () => ipcRenderer.invoke("splice:transcription-availability"),
  listTranscriptions: () => ipcRenderer.invoke("splice:transcriptions"),
  getTranscription: (sessionId: string) => ipcRenderer.invoke("splice:transcription", sessionId),
  startTranscription: (bytes: Uint8Array, providerId: string, language: string) => ipcRenderer.invoke("splice:transcription-start", bytes, providerId, language),
  cancelTranscription: (sessionId: string) => ipcRenderer.invoke("splice:transcription-cancel", sessionId),
  onTranscription: (callback: (session: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, session: unknown) => callback(session);
    ipcRenderer.on("splice:transcription-event", listener);
    return () => ipcRenderer.removeListener("splice:transcription-event", listener);
  },
}));
