import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron'
import path from 'path'
import { startRunner, onLog, LogLine } from './runner'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let runnerStarted = false

// Buffer logs emitted before the renderer is ready
const logBuffer: LogLine[] = []
const MAX_BUF = 500

onLog((line) => {
  logBuffer.push(line)
  if (logBuffer.length > MAX_BUF) logBuffer.shift()
  // Send to renderer if window exists
  win?.webContents.send('log', line)
})

function createWindow() {
  win = new BrowserWindow({
    width: 860,
    height: 600,
    minWidth: 700,
    minHeight: 400,
    backgroundColor: '#0a0b0e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../assets/icon.png'),
    title: 'MEV Terminal',
  })

  win.loadFile(path.join(__dirname, '../ui/index.html'))

  // When renderer finishes loading, replay buffered logs then start runner
  win.webContents.on('did-finish-load', async () => {
    // Replay any logs already buffered (shouldn't happen on first load, but safe)
    for (const line of logBuffer) {
      win?.webContents.send('log', line)
    }
    // Start runner once, on first window load
    if (!runnerStarted) {
      runnerStarted = true
      await startRunner()
    }
  })

  win.on('close', (e) => {
    if (process.platform === 'darwin') {
      e.preventDefault()
      win?.hide()
    }
  })
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/tray.png'))
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  const menu = Menu.buildFromTemplate([
    { label: '显示面板', click: () => win?.show() },
    { type: 'separator' },
    { label: '退出', click: () => { app.exit(0) } },
  ])
  tray.setContextMenu(menu)
  tray.setToolTip('MEV Terminal — Runner 运行中')
  tray.on('click', () => win?.show())
}

app.whenReady().then(() => {
  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else win?.show()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// IPC: renderer can request status
ipcMain.handle('get-status', () => ({ running: runnerStarted }))
