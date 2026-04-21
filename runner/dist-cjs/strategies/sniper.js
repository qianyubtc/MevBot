"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SniperStrategy = void 0;
const viem_1 = require("viem");
const db_js_1 = require("../core/db.js");
const chalk_1 = __importDefault(require("chalk"));
const crypto_1 = require("crypto");
const FACTORY_ABI = (0, viem_1.parseAbi)([
    'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
]);
class SniperStrategy {
    constructor(publicClient, walletClient, ws, config, factoryAddress) {
        this.publicClient = publicClient;
        this.walletClient = walletClient;
        this.ws = ws;
        this.config = config;
        this.factoryAddress = factoryAddress;
        this.running = false;
        this.positions = new Map();
        this.totalProfit = 0;
    }
    async start() {
        if (this.running)
            return;
        this.running = true;
        console.log(chalk_1.default.green('[Sniper] 策略启动，监听新流动性...'));
        this.ws.broadcast({ type: 'status', payload: { strategy: 'sniper', running: true, scanned: 0, pending: 0 } });
        try {
            this.unwatchFn = this.publicClient.watchContractEvent({
                address: this.factoryAddress,
                abi: FACTORY_ABI,
                eventName: 'PairCreated',
                onLogs: (logs) => {
                    for (const log of logs) {
                        this.onNewPair(log);
                    }
                },
            });
        }
        catch {
            console.log(chalk_1.default.yellow('[Sniper] 事件监听降级为轮询...'));
        }
    }
    async onNewPair(log) {
        if (!this.running)
            return;
        const { token0, token1, pair } = log.args;
        const liquidity = await this.estimateLiquidity(pair);
        if (liquidity < this.config.minLiquidityUSD) {
            console.log(chalk_1.default.gray(`[Sniper] 流动性不足 $${liquidity.toFixed(0)}，跳过`));
            return;
        }
        // Safety checks (honeypot detection, etc.)
        const isSafe = await this.safetyCheck(token0);
        if (!isSafe) {
            console.log(chalk_1.default.red('[Sniper] 安全检测不通过，跳过'));
            return;
        }
        const symbol = `TOKEN_${pair.slice(2, 6).toUpperCase()}`;
        const buyPrice = 0.0001 + Math.random() * 0.001;
        const buyAmount = Math.min(this.config.maxBuyUSD, liquidity * 0.01);
        console.log(chalk_1.default.green(`[Sniper] 发现新币 ${symbol} 流动性 $${liquidity.toFixed(0)}`));
        this.ws.broadcast({
            type: 'opportunity',
            payload: {
                id: (0, crypto_1.randomUUID)(),
                strategy: 'sniper',
                token: symbol,
                tokenAddress: token0,
                chain: 'BSC',
                profitUSD: buyAmount * (this.config.targetGainPct / 100),
                profitNative: 0,
                gasUSD: 0.3,
                netProfit: buyAmount * (this.config.targetGainPct / 100) - 0.3,
                timestamp: Date.now(),
            },
        });
        await this.executeBuy(token0, symbol, buyPrice, buyAmount);
        // Monitor position for take-profit / stop-loss
        this.monitorPosition(token0, symbol, buyPrice, buyAmount);
    }
    async safetyCheck(tokenAddress) {
        // TODO: check for honeypot, max tx limit, blacklist, etc.
        return Math.random() > 0.3;
    }
    async estimateLiquidity(pairAddress) {
        // TODO: read reserves from pair contract
        return 20000 + Math.random() * 300000;
    }
    async executeBuy(tokenAddress, symbol, price, amountUSD) {
        const id = (0, crypto_1.randomUUID)();
        const txHash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        const gasUSD = 0.3;
        try {
            // TODO: walletClient.sendTransaction(...)
            this.positions.set(tokenAddress, { buyPrice: price, amount: amountUSD / price, symbol });
            const trade = { id, strategy: 'sniper', token: symbol, txHash, chain: 'BSC', profitUSD: -amountUSD, gasUSD, status: 'pending', timestamp: Date.now() };
            (0, db_js_1.saveTrade)(trade);
            this.ws.broadcast({ type: 'trade', payload: trade });
            console.log(chalk_1.default.cyan(`[Sniper] 买入 ${symbol} $${amountUSD.toFixed(2)}`));
        }
        catch (err) {
            console.error(chalk_1.default.red('[Sniper] 买入失败:'), err.message);
        }
    }
    monitorPosition(tokenAddress, symbol, buyPrice, amountUSD) {
        const check = setInterval(async () => {
            if (!this.running || !this.positions.has(tokenAddress)) {
                clearInterval(check);
                return;
            }
            const currentPrice = buyPrice * (1 + (Math.random() - 0.4) * 0.2);
            const gainPct = ((currentPrice - buyPrice) / buyPrice) * 100;
            if (gainPct >= this.config.targetGainPct) {
                clearInterval(check);
                await this.executeSell(tokenAddress, symbol, buyPrice, currentPrice, amountUSD, 'take-profit');
            }
            else if (gainPct <= -this.config.stopLossPct) {
                clearInterval(check);
                await this.executeSell(tokenAddress, symbol, buyPrice, currentPrice, amountUSD, 'stop-loss');
            }
        }, 3000);
    }
    async executeSell(tokenAddress, symbol, buyPrice, sellPrice, amountUSD, reason) {
        this.positions.delete(tokenAddress);
        const id = (0, crypto_1.randomUUID)();
        const txHash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        const gasUSD = 0.3;
        const profitUSD = amountUSD * ((sellPrice - buyPrice) / buyPrice) - gasUSD;
        this.totalProfit += profitUSD;
        (0, db_js_1.saveSnapshot)(this.totalProfit);
        const trade = { id, strategy: 'sniper', token: symbol, txHash, chain: 'BSC', profitUSD, gasUSD, status: profitUSD > 0 ? 'success' : 'failed', timestamp: Date.now() };
        (0, db_js_1.saveTrade)(trade);
        this.ws.broadcast({ type: 'trade', payload: trade });
        console.log(chalk_1.default[profitUSD > 0 ? 'green' : 'red'](`[Sniper] 卖出 ${symbol} (${reason}) ${profitUSD > 0 ? '+' : ''}$${profitUSD.toFixed(2)}`));
    }
    stop() {
        this.running = false;
        this.unwatchFn?.();
        this.positions.clear();
        this.ws.broadcast({ type: 'status', payload: { strategy: 'sniper', running: false, scanned: 0, pending: 0 } });
        console.log(chalk_1.default.yellow('[Sniper] 策略已停止'));
    }
    get isRunning() {
        return this.running;
    }
}
exports.SniperStrategy = SniperStrategy;
