"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WsServer = void 0;
const ws_1 = require("ws");
const chalk_1 = __importDefault(require("chalk"));
class WsServer {
    constructor(port = 8765) {
        this.clients = new Set();
        this.handlers = [];
        this.wss = new ws_1.WebSocketServer({ port, host: 'localhost' });
        this.wss.on('connection', (ws) => {
            this.clients.add(ws);
            console.log(chalk_1.default.green(`[WS] 客户端已连接，当前连接数: ${this.clients.size}`));
            ws.on('message', (raw) => {
                try {
                    const data = JSON.parse(raw.toString());
                    this.handlers.forEach((h) => h(data, ws));
                }
                catch { }
            });
            ws.on('close', () => {
                this.clients.delete(ws);
                console.log(chalk_1.default.yellow(`[WS] 客户端断开，当前连接数: ${this.clients.size}`));
            });
            ws.on('error', (err) => {
                console.error(chalk_1.default.red('[WS] 错误:'), err.message);
                this.clients.delete(ws);
            });
        });
        this.wss.on('listening', () => {
            console.log(chalk_1.default.cyan(`[WS] 服务器监听 ws://localhost:${port}`));
        });
    }
    on(handler) {
        this.handlers.push(handler);
    }
    broadcast(data) {
        const json = JSON.stringify(data);
        this.clients.forEach((ws) => {
            if (ws.readyState === ws_1.WebSocket.OPEN) {
                ws.send(json);
            }
        });
    }
    send(ws, data) {
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }
    get connectedCount() {
        return this.clients.size;
    }
}
exports.WsServer = WsServer;
