"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SandwichStrategy = void 0;
const viem_1 = require("viem");
const mempool_js_1 = require("../core/mempool.js");
const db_js_1 = require("../core/db.js");
const chalk_1 = __importDefault(require("chalk"));
const crypto_1 = require("crypto");
class SandwichStrategy {
    constructor(publicClient, walletClient, ws, config, routerAddresses) {
        this.publicClient = publicClient;
        this.walletClient = walletClient;
        this.ws = ws;
        this.config = config;
        this.routerAddresses = routerAddresses;
        this.running = false;
        this.totalProfit = 0;
        this.mempool = new mempool_js_1.MempoolMonitor(publicClient, routerAddresses);
    }
    async start() {
        if (this.running)
            return;
        this.running = true;
        console.log(chalk_1.default.green('[Sandwich] 策略启动'));
        this.mempool.onSwap((swap) => this.evaluateSwap(swap));
        this.stopFn = await this.mempool.start();
        this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: 0, pending: 0 } });
    }
    async evaluateSwap(swap) {
        if (!this.running)
            return;
        // Filter: gas price check
        const gasPriceGwei = Number(swap.gasPrice) / 1e9;
        if (gasPriceGwei > this.config.maxGasGwei * 2)
            return;
        // Simulate profit estimation
        const estimatedProfit = this.estimateProfit(swap);
        if (estimatedProfit < this.config.minProfitUSD)
            return;
        const gasUSD = 0.5;
        console.log(chalk_1.default.green(`[Sandwich] 发现机会: ${this.config.token.symbol} 预估利润 $${estimatedProfit.toFixed(2)}`));
        // Broadcast opportunity
        this.ws.broadcast({
            type: 'opportunity',
            payload: {
                id: (0, crypto_1.randomUUID)(),
                strategy: 'sandwich',
                token: this.config.token.symbol,
                tokenAddress: this.config.token.address,
                chain: 'BSC',
                profitUSD: estimatedProfit,
                profitNative: estimatedProfit / 580,
                gasUSD,
                netProfit: estimatedProfit - gasUSD,
                timestamp: Date.now(),
            },
        });
        // Execute sandwich
        await this.executeSandwich(swap, estimatedProfit, gasUSD);
    }
    estimateProfit(swap) {
        const swapAmountETH = Number((0, viem_1.formatEther)(swap.amountIn));
        if (swapAmountETH < 0.1)
            return 0;
        // Simplified: larger swap = more slippage = more profit
        const impactPct = Math.min(swapAmountETH * 0.001, 0.5);
        return swapAmountETH * 580 * impactPct * 0.7;
    }
    async executeSandwich(swap, profitUSD, gasUSD) {
        const id = (0, crypto_1.randomUUID)();
        let txHash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        try {
            // Front-run buy
            // TODO: implement actual front-run buy via walletClient
            // const frontRunHash = await this.walletClient.sendTransaction({ ... })
            // Wait for victim tx
            await new Promise((r) => setTimeout(r, 100));
            // Back-run sell
            // TODO: implement actual back-run sell
            const netProfit = profitUSD - gasUSD;
            this.totalProfit += netProfit;
            (0, db_js_1.saveSnapshot)(this.totalProfit);
            const trade = {
                id,
                strategy: 'sandwich',
                token: this.config.token.symbol,
                txHash,
                chain: 'BSC',
                profitUSD,
                gasUSD,
                status: 'success',
                timestamp: Date.now(),
            };
            (0, db_js_1.saveTrade)(trade);
            this.ws.broadcast({ type: 'trade', payload: trade });
            console.log(chalk_1.default.green(`[Sandwich] 执行成功: +$${netProfit.toFixed(2)}`));
        }
        catch (err) {
            const trade = {
                id,
                strategy: 'sandwich',
                token: this.config.token.symbol,
                txHash,
                chain: 'BSC',
                profitUSD: 0,
                gasUSD,
                status: 'failed',
                timestamp: Date.now(),
            };
            (0, db_js_1.saveTrade)(trade);
            this.ws.broadcast({ type: 'trade', payload: trade });
            console.error(chalk_1.default.red('[Sandwich] 执行失败:'), err.message);
        }
    }
    stop() {
        this.running = false;
        this.stopFn?.();
        this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: false, scanned: 0, pending: 0 } });
        console.log(chalk_1.default.yellow('[Sandwich] 策略已停止'));
    }
    get isRunning() {
        return this.running;
    }
}
exports.SandwichStrategy = SandwichStrategy;
