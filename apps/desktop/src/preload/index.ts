import { contextBridge, ipcRenderer } from 'electron';
import type { AssistantApi, RendererEvent } from '../shared/ipc.js';

const api: AssistantApi = {
  sendText: (text) => ipcRenderer.invoke('assistant:send-text', text),
  toggleTts: () => ipcRenderer.invoke('assistant:toggle-tts'),
  onEvent: (handler) => {
    const listener = (_e: unknown, ev: RendererEvent) => handler(ev);
    ipcRenderer.on('assistant:event', listener);
    return () => ipcRenderer.removeListener('assistant:event', listener);
  },
};

contextBridge.exposeInMainWorld('assistant', api);
