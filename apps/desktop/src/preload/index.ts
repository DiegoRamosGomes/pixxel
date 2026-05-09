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
  claudeStart: (prompt) => ipcRenderer.invoke('assistant:claude-start', prompt),
  claudeCancel: () => ipcRenderer.invoke('assistant:claude-cancel'),
  claudePermissionResponse: (requestId, allowed) =>
    ipcRenderer.send('assistant:claude-permission-response', requestId, allowed),
  claudeResetSession: () => ipcRenderer.invoke('assistant:claude-reset-session'),
  windowClose: () => ipcRenderer.send('assistant:window-close'),
  windowMinimize: () => ipcRenderer.send('assistant:window-minimize'),
  windowMaximizeToggle: () => ipcRenderer.send('assistant:window-maximize-toggle'),
  memoryGraph: () => ipcRenderer.invoke('assistant:memory-graph'),
  cameraFrame: (requestId, dataUrl) =>
    ipcRenderer.send('assistant:camera-frame', requestId, dataUrl),
  handMouseEnable: () => ipcRenderer.invoke('assistant:hand-mouse-enable'),
  handMouseDisable: () => ipcRenderer.invoke('assistant:hand-mouse-disable'),
  handMouseMove: (x, y) => ipcRenderer.send('assistant:hand-mouse-move', x, y),
  handMouseClick: (button) =>
    ipcRenderer.send('assistant:hand-mouse-click', button),
  handMouseDown: (button) =>
    ipcRenderer.send('assistant:hand-mouse-down', button),
  handMouseUp: (button) => ipcRenderer.send('assistant:hand-mouse-up', button),
  handMouseScroll: (direction, ticks) =>
    ipcRenderer.send('assistant:hand-mouse-scroll', direction, ticks ?? 1),
  explainClickupTask: (taskId) =>
    ipcRenderer.send('assistant:explain-clickup-task', taskId),
  instagramPublish: (fileBytes, fileName, caption, shareToFeed) =>
    ipcRenderer.invoke(
      'assistant:instagram-publish',
      fileBytes,
      fileName,
      caption,
      shareToFeed ?? false,
    ),
  onEvent: (handler) => {
    const listener = (_e: unknown, ev: RendererEvent) => handler(ev);
    ipcRenderer.on('assistant:event', listener);
    return () => ipcRenderer.removeListener('assistant:event', listener);
  },
};

contextBridge.exposeInMainWorld('assistant', api);
