import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('mevbot', {
  onLog: (cb: (line: { level: string; text: string; ts: number }) => void) => {
    ipcRenderer.on('log', (_event, line) => cb(line))
  },
  getStatus: () => ipcRenderer.invoke('get-status'),
})
