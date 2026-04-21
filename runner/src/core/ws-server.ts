import { WebSocketServer, WebSocket } from 'ws'
import chalk from 'chalk'

type MessageHandler = (data: any, ws: WebSocket) => void

export class WsServer {
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()
  private handlers: MessageHandler[] = []

  constructor(port = 8765) {
    this.wss = new WebSocketServer({ port, host: 'localhost' })

    this.wss.on('connection', (ws) => {
      this.clients.add(ws)
      console.log(chalk.green(`[WS] 客户端已连接，当前连接数: ${this.clients.size}`))

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString())
          this.handlers.forEach((h) => h(data, ws))
        } catch {}
      })

      ws.on('close', () => {
        this.clients.delete(ws)
        console.log(chalk.yellow(`[WS] 客户端断开，当前连接数: ${this.clients.size}`))
      })

      ws.on('error', (err) => {
        console.error(chalk.red('[WS] 错误:'), err.message)
        this.clients.delete(ws)
      })
    })

    this.wss.on('listening', () => {
      console.log(chalk.cyan(`[WS] 服务器监听 ws://localhost:${port}`))
    })
  }

  on(handler: MessageHandler) {
    this.handlers.push(handler)
  }

  broadcast(data: object) {
    const json = JSON.stringify(data)
    this.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json)
      }
    })
  }

  send(ws: WebSocket, data: object) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data))
    }
  }

  get connectedCount() {
    return this.clients.size
  }
}
