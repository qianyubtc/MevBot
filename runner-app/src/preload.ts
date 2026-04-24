import { contextBridge, ipcRenderer } from 'electron'

// Buffer logs that arrive before the page calls onLog()
const pending: { level: string; text: string; ts: number }[] = []
let logCb: ((line: { level: string; text: string; ts: number }) => void) | null = null

// Register IPC listener immediately in preload (before page JS runs)
ipcRenderer.on('log', (_event, line) => {
  if (logCb) {
    logCb(line)
  } else {
    pending.push(line)
  }
})

contextBridge.exposeInMainWorld('mevbot', {
  onLog: (cb: (line: { level: string; text: string; ts: number }) => void) => {
    logCb = cb
    // Flush buffered logs
    const queued = pending.splice(0)
    queued.forEach(cb)
  },
  getStatus: () => ipcRenderer.invoke('get-status'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
})
