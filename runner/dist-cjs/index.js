"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const chalk_1 = __importDefault(require("chalk"));
const ws_server_js_1 = require("./core/ws-server.js");
const chains_js_1 = require("./config/chains.js");
const sandwich_js_1 = require("./strategies/sandwich.js");
const arbitrage_js_1 = require("./strategies/arbitrage.js");
const sniper_js_1 = require("./strategies/sniper.js");
const scanner_js_1 = require("./core/scanner.js");
const db_js_1 = require("./core/db.js");
const CHAIN = process.env.CHAIN ?? 'BSC';
const RPC_URL = process.env.RPC_URL ?? 'https://bsc-dataseed.binance.org';
const PRIVATE_KEY = process.env.PRIVATE_KEY ?? '';
// Build a read-only client for scanning (no private key needed)
function buildScanClient() {
    return (0, chains_js_1.buildClients)(RPC_URL, '0x0000000000000000000000000000000000000000000000000000000000000001', CHAIN);
}
console.log(chalk_1.default.cyan('╔════════════════════════════════╗'));
console.log(chalk_1.default.cyan('║      MEV Terminal Runner       ║'));
console.log(chalk_1.default.cyan('╚════════════════════════════════╝'));
console.log(chalk_1.default.dim(`Chain: ${CHAIN} | RPC: ${RPC_URL.slice(0, 40)}...`));
const ws = new ws_server_js_1.WsServer(8765);
const strategies = {};
ws.on(async (msg, client) => {
    const { type, payload } = msg;
    if (type === 'start') {
        const { strategy, config, token } = payload;
        console.log(chalk_1.default.cyan(`[Runner] 启动策略: ${strategy}`));
        if (!PRIVATE_KEY) {
            ws.broadcast({ type: 'error', payload: { message: '未配置私钥，无法启动策略' } });
            return;
        }
        const { publicClient, walletClient } = (0, chains_js_1.buildClients)(RPC_URL, PRIVATE_KEY, CHAIN);
        const routers = Object.values(chains_js_1.DEX_ROUTERS[CHAIN] ?? {});
        if (strategy === 'sandwich') {
            const s = new sandwich_js_1.SandwichStrategy(publicClient, walletClient, ws, { ...config, token }, routers);
            strategies[strategy] = s;
            await s.start();
        }
        else if (strategy === 'arbitrage') {
            const s = new arbitrage_js_1.ArbitrageStrategy(publicClient, walletClient, ws, config);
            strategies[strategy] = s;
            await s.start();
        }
        else if (strategy === 'sniper') {
            const factoryAddr = Object.values(chains_js_1.DEX_FACTORIES[CHAIN] ?? {})[0] ?? '0x0';
            const s = new sniper_js_1.SniperStrategy(publicClient, walletClient, ws, config, factoryAddr);
            strategies[strategy] = s;
            await s.start();
        }
    }
    if (type === 'stop') {
        const { strategy } = payload;
        const s = strategies[strategy];
        if (s) {
            s.stop();
            delete strategies[strategy];
        }
    }
    if (type === 'scan') {
        console.log(chalk_1.default.cyan(`[Runner] 真实链上扫描: ${payload.strategy}`));
        try {
            const { publicClient } = buildScanClient();
            const factories = chains_js_1.DEX_FACTORIES[CHAIN] ?? {};
            const routers = chains_js_1.DEX_ROUTERS[CHAIN] ?? {};
            const factoryName = Object.keys(factories)[0] ?? 'PancakeSwap';
            const factoryAddr = factories[factoryName];
            const routerAddr = routers[factoryName];
            const scanner = new scanner_js_1.OnChainScanner(publicClient, factoryAddr, routerAddr, factoryName);
            const bnbPrice = await scanner.getBNBPrice();
            const scannerWithPrice = new scanner_js_1.OnChainScanner(publicClient, factoryAddr, routerAddr, factoryName, bnbPrice);
            const tokens = await scannerWithPrice.scanTopPairs(24);
            ws.broadcast({ type: 'tokens', payload: tokens });
        }
        catch (err) {
            console.error(chalk_1.default.red('[Scanner] 扫描失败:'), err.message);
            ws.broadcast({ type: 'tokens', payload: [] });
        }
    }
    if (type === 'get_prices') {
        // Real multi-DEX price comparison for arbitrage
        try {
            const { publicClient } = buildScanClient();
            const routers = chains_js_1.DEX_ROUTERS[CHAIN] ?? {};
            const factories = chains_js_1.DEX_FACTORIES[CHAIN] ?? {};
            const scanner = new scanner_js_1.OnChainScanner(publicClient, Object.values(factories)[0], Object.values(routers)[0], 'PancakeSwap');
            const routerList = Object.entries(routers).map(([name, address]) => ({ name, address: address }));
            const prices = await scanner.getMultiDexPrices(payload.tokenAddress, routerList);
            ws.send(client, { type: 'prices', payload: prices });
        }
        catch { }
    }
});
// Broadcast PnL every 5 seconds
setInterval(() => {
    if (ws.connectedCount === 0)
        return;
    const pnl = (0, db_js_1.getPnLSummary)();
    ws.broadcast({ type: 'pnl', payload: pnl });
}, 5000);
// Save PnL snapshot every 5 minutes
setInterval(() => {
    const pnl = (0, db_js_1.getPnLSummary)();
    (0, db_js_1.saveSnapshot)(pnl.totalUSD);
}, 5 * 60 * 1000);
process.on('SIGINT', () => {
    console.log(chalk_1.default.yellow('\n[Runner] 正在停止所有策略...'));
    Object.values(strategies).forEach((s) => s.stop());
    process.exit(0);
});
process.on('uncaughtException', (err) => {
    console.error(chalk_1.default.red('[Runner] 未捕获异常:'), err);
});
