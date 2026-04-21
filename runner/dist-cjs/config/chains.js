"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEX_FACTORIES = exports.DEX_ROUTERS = exports.CHAINS = void 0;
exports.buildClients = buildClients;
const viem_1 = require("viem");
const chains_1 = require("viem/chains");
const accounts_1 = require("viem/accounts");
exports.CHAINS = { BSC: chains_1.bsc, ETH: chains_1.mainnet, Arbitrum: chains_1.arbitrum, Base: chains_1.base };
exports.DEX_ROUTERS = {
    BSC: {
        PancakeSwap: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
        BiSwap: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8',
        MDEX: '0x62c1E3f9a3B16CCCEe6E24fB8aE68f0A6B3e6e79',
        BabySwap: '0x8317c460C22A9958c27b4aCD951f499a537b960d',
    },
};
exports.DEX_FACTORIES = {
    BSC: {
        PancakeSwap: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
        BiSwap: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
        MDEX: '0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8',
    },
};
function buildClients(rpcUrl, privateKey, chainName) {
    const chain = exports.CHAINS[chainName] ?? chains_1.bsc;
    const transport = (0, viem_1.http)(rpcUrl);
    const publicClient = (0, viem_1.createPublicClient)({ chain, transport });
    const account = (0, accounts_1.privateKeyToAccount)(privateKey);
    const walletClient = (0, viem_1.createWalletClient)({ account, chain, transport });
    return { publicClient, walletClient, account, chain };
}
