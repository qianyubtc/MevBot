"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveTrade = saveTrade;
exports.saveSnapshot = saveSnapshot;
exports.getPnLSummary = getPnLSummary;
const path_1 = require("path");
const os_1 = require("os");
const fs_1 = require("fs");
const DB_DIR = (0, path_1.join)((0, os_1.homedir)(), '.mevbot');
(0, fs_1.mkdirSync)(DB_DIR, { recursive: true });
const TRADES_FILE = (0, path_1.join)(DB_DIR, 'trades.json');
const SNAPSHOTS_FILE = (0, path_1.join)(DB_DIR, 'snapshots.json');
function readJSON(file, fallback) {
    try {
        if (!(0, fs_1.existsSync)(file))
            return fallback;
        return JSON.parse((0, fs_1.readFileSync)(file, 'utf-8'));
    }
    catch {
        return fallback;
    }
}
function writeJSON(file, data) {
    (0, fs_1.writeFileSync)(file, JSON.stringify(data), 'utf-8');
}
function saveTrade(trade) {
    const trades = readJSON(TRADES_FILE, []);
    const idx = trades.findIndex((t) => t.id === trade.id);
    if (idx >= 0)
        trades[idx] = trade;
    else
        trades.unshift(trade);
    // Keep last 2000 trades
    writeJSON(TRADES_FILE, trades.slice(0, 2000));
}
function saveSnapshot(value) {
    const snaps = readJSON(SNAPSHOTS_FILE, []);
    snaps.push({ t: Date.now(), v: value });
    // Keep last 288 snapshots (24h at 5min intervals)
    writeJSON(SNAPSHOTS_FILE, snaps.slice(-288));
}
function getPnLSummary() {
    const trades = readJSON(TRADES_FILE, []);
    const snaps = readJSON(SNAPSHOTS_FILE, []);
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const todayTrades = trades.filter((t) => t.timestamp > todayStart && t.status === 'success');
    const todayUSD = todayTrades.reduce((s, t) => s + t.profitUSD - t.gasUSD, 0);
    const allSuccess = trades.filter((t) => t.status === 'success');
    const totalUSD = allSuccess.reduce((s, t) => s + t.profitUSD - t.gasUSD, 0);
    const winCount = todayTrades.filter((t) => t.profitUSD > t.gasUSD).length;
    const winRate = todayTrades.length > 0 ? (winCount / todayTrades.length) * 100 : 0;
    return {
        totalUSD,
        todayUSD,
        weekUSD: 0,
        totalTrades: todayTrades.length,
        winRate,
        history: snaps,
    };
}
