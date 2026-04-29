import { contextBridge, ipcRenderer } from 'electron';
import type { AssistantApi, RendererEvent } from '../shared/ipc.js';

const api: AssistantApi = {
  sendText: (text) => ipcRenderer.invoke('assistant:send-text', text),
  toggleTts: () => ipcRenderer.invoke('assistant:toggle-tts'),
  liveStart: () => ipcRenderer.invoke('assistant:live-start'),
  liveStop: () => ipcRenderer.invoke('assistant:live-stop'),
  liveSendAudio: (pcm16k) => ipcRenderer.send('assistant:live-audio', pcm16k),
  liveSendText: (text) => ipcRenderer.invoke('assistant:live-send-text', text),
  liveEndTurn: () => ipcRenderer.send('assistant:live-end-turn'),
  onEvent: (handler) => {
    const listener = (_e: unknown, ev: RendererEvent) => handler(ev);
    ipcRenderer.on('assistant:event', listener);
    return () => ipcRenderer.removeListener('assistant:event', listener);
  },
};

contextBridge.exposeInMainWorld('assistant', api);
