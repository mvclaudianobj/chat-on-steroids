import { contextBridge, ipcRenderer } from 'electron';

const api = {
  password: (email: string, password: string) => ipcRenderer.invoke('markspanel:password', { email, password }) as Promise<{ok: boolean; message: string}>,
  start: () => ipcRenderer.invoke('markspanel:start') as Promise<{ok: boolean; code?: string; retryAfterMs?: number; message: string}>,
  poll: () => ipcRenderer.invoke('markspanel:poll') as Promise<{ok: boolean; pending?: boolean; retryAfterMs?: number; message: string}>
};
contextBridge.exposeInMainWorld('markspanelAuth', api);
