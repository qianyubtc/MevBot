"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MempoolMonitor = void 0;
const chalk_1 = __importDefault(require("chalk"));
const SWAP_SIGNATURES = [
    '0x38ed1739', // swapExactTokensForTokens
    '0x7ff36ab5', // swapExactETHForTokens
    '0x18cbafe5', // swapExactTokensForETH
    '0xfb3bdb41', // swapETHForExactTokens
];
class MempoolMonitor {
    constructor(client, routerAddresses) {
        this.handlers = [];
        this.running = false;
        this.client = client;
        this.routerAddresses = routerAddresses.map((a) => a.toLowerCase());
    }
    onSwap(handler) {
        this.handlers.push(handler);
    }
    async start() {
        this.running = true;
        console.log(chalk_1.default.cyan('[Mempool] 开始监听待处理交易...'));
        // Subscribe to pending transactions
        try {
            const unwatch = this.client.watchPendingTransactions({
                onTransactions: async (hashes) => {
                    if (!this.running)
                        return;
                    for (const hash of hashes.slice(0, 10)) {
                        try {
                            const tx = await this.client.getTransaction({ hash });
                            if (!tx || !tx.to)
                                continue;
                            if (!this.routerAddresses.includes(tx.to.toLowerCase()))
                                continue;
                            const sig = tx.input.slice(0, 10).toLowerCase();
                            if (!SWAP_SIGNATURES.includes(sig))
                                continue;
                            const swap = this.parseSwapTx(tx);
                            if (swap)
                                this.handlers.forEach((h) => h(swap));
                        }
                        catch { }
                    }
                },
            });
            return () => {
                this.running = false;
                unwatch();
            };
        }
        catch (err) {
            console.error(chalk_1.default.red('[Mempool] 订阅失败，使用轮询模式'));
            return this.startPolling();
        }
    }
    async startPolling() {
        while (this.running) {
            await new Promise((r) => setTimeout(r, 1000));
        }
        return () => { this.running = false; };
    }
    parseSwapTx(tx) {
        try {
            return {
                txHash: tx.hash,
                from: tx.from,
                to: tx.to,
                router: tx.to,
                tokenIn: '0x0000000000000000000000000000000000000000',
                tokenOut: '0x0000000000000000000000000000000000000000',
                amountIn: tx.value ?? 0n,
                amountOutMin: 0n,
                deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
                gasPrice: tx.gasPrice ?? 0n,
            };
        }
        catch {
            return null;
        }
    }
    stop() {
        this.running = false;
        console.log(chalk_1.default.yellow('[Mempool] 监听已停止'));
    }
}
exports.MempoolMonitor = MempoolMonitor;
