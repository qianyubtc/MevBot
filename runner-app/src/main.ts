import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron'
import path from 'path'
import { startRunner, onLog } from './runner'

let win: BrowserWindow | null = null
let tray: Tray | null = null

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

  // Forward runner logs → renderer
  onLog((line) => {
    win?.webContents.send('log', line)
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

app.whenReady().then(async () => {
  createWindow()
  createTray()
  await startRunner()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else win?.show()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// IPC: renderer can request config sync
ipcMain.handle('get-status', () => ({ running: true }))
