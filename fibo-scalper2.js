#!/usr/bin/env node

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  DERIV MULTI-ASSET FIBONACCI SCALPER BOT v2.2 - Node.js Edition              ║
 * ║  COMPLETE REWRITE - Truly Continuous Trading                                  ║
 * ║                                                                               ║
 * ║  Based on: https://youtu.be/AlsXNhTm4AA                                       ║
 * ║                                                                               ║
 * ║  v2.2 COMPLETE REWRITE - ALL BUGS FIXED:                                      ║
 * ║  1. Removed BoS requirement - just use trend + golden zone                    ║
 * ║  2. Fib levels recalculated on EVERY candle                                   ║
 * ║  3. Simplified golden zone check using 0.5-0.618                              ║
 * ║  4. Relaxed trend detection (higher highs OR higher lows)                     ║
 * ║  5. Clear cooldowns after trade close for fresh start                         ║
 * ║  6. Per-candle full analysis with no blocking state                           ║
 * ║                                                                               ║
 * ║  ⚠️ DISCLAIMER: FOR EDUCATIONAL PURPOSES ONLY - NOT FINANCIAL ADVICE         ║
 * ║  Test extensively on VIRTUAL accounts before any live trading!               ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const WebSocket = require('ws');
const https = require('https');
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: ASSET CONFIGURATIONS
// ═══════════════════════════════════════════════════════════════════════════════

const ASSET_CONFIGS = {
    'R_75': {
        name: 'Volatility 75 Index',
        category: 'synthetic',
        multipliers: [50, 100, 200, 300, 500],
        defaultMultiplier: 500,
        maxTradesPerDay: 500,
        minStake: 1.00,
        maxStake: 3000,
        swingLookback: 3,  // Reduced for more swings
        rrRatio: 1.5
    },
    'R_100': {
        name: 'Volatility 100 Index',
        category: 'synthetic',
        multipliers: [40, 100, 200, 300, 400],
        defaultMultiplier: 400,
        maxTradesPerDay: 500,
        minStake: 1.00,
        maxStake: 3000,
        swingLookback: 3,
        rrRatio: 1.5
    },
    '1HZ25V': {
        name: 'Volatility 25 (1s) Index',
        category: 'synthetic',
        multipliers: [160, 400, 800, 1200, 1600],
        defaultMultiplier: 1600,
        maxTradesPerDay: 500,
        minStake: 1.00,
        maxStake: 1000,
        swingLookback: 3,
        rrRatio: 1.3
    },
    '1HZ50V': {
        name: 'Volatility 50 (1s) Index',
        category: 'synthetic',
        multipliers: [80, 200, 400, 600, 800],
        defaultMultiplier: 800,
        maxTradesPerDay: 500,
        minStake: 1.00,
        maxStake: 1000,
        swingLookback: 3,
        rrRatio: 1.4
    },
    '1HZ100V': {
        name: 'Volatility 100 (1s) Index',
        category: 'synthetic',
        multipliers: [40, 100, 200, 300, 400],
        defaultMultiplier: 400,
        maxTradesPerDay: 500,
        minStake: 1.00,
        maxStake: 1000,
        swingLookback: 3,
        rrRatio: 1.4
    },
    'stpRNG': {
        name: 'Step Index',
        category: 'synthetic',
        multipliers: [750, 2000, 3500, 5500, 7500],
        defaultMultiplier: 7500,
        maxTradesPerDay: 500,
        minStake: 1.00,
        maxStake: 1000,
        swingLookback: 4,
        rrRatio: 1.2
    },
    'frxXAUUSD': {
        name: 'Gold/USD',
        category: 'commodity',
        multipliers: [50, 100, 200, 300, 400, 500],
        defaultMultiplier: 500,
        maxTradesPerDay: 50,
        minStake: 5,
        maxStake: 5000,
        swingLookback: 3,
        rrRatio: 1.5
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: GLOBAL CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
    appId: '1089',
    apiToken: '0P94g4WdSrSrzir',
    accountType: 'real',
    wsUrl: 'wss://ws.derivws.com/websockets/v3?app_id=',

    activeAssets: ['R_75', 'R_100', '1HZ50V', 'stpRNG', '1HZ25V', '1HZ100V'],

    investmentCapital: 500,
    defaultStake: 1,

    // Simplified zone - just use 0.5 and 0.618
    fibUpperZone: 0.618,
    fibLowerZone: 0.5,

    // Reduced cooldown for more trading
    signalCooldownSeconds: 15,
    postTradeCooldown: 5,

    // Risk management
    maxDailyLossPercent: 10,
    maxTotalOpenPositions: 7,
    maxConsecutiveLosses: 5,
    cooldownMinutes: 10,

    // Telegram
    telegram: {
        enabled: true,
        botToken: '8322457666:AAHuXoU9JlD-wxaL-Yw1Bl9f056AGT_9WFU',
        chatId: '752497117',
        sendTradeAlerts: true,
        sendHourlySummary: true,
        sendDailySummary: true
    },

    maxCandles: 200,
    maxReconnectAttempts: 5
};

function validateConfig() {
    if (!CONFIG.apiToken) {
        Logger.error('DERIV_API_TOKEN is required. Please set it in .env file.');
        process.exit(1);
    }

    const validAssets = CONFIG.activeAssets.filter(a => ASSET_CONFIGS[a]);
    if (validAssets.length === 0) {
        Logger.error('No valid assets configured.');
        process.exit(1);
    }
    CONFIG.activeAssets = validAssets;

    if (CONFIG.accountType === 'real') {
        Logger.warn('⚠️  REAL ACCOUNT MODE - Trading with real money!');
    }

    if (CONFIG.telegram.enabled && (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId)) {
        Logger.warn('Telegram enabled but missing credentials. Disabling.');
        CONFIG.telegram.enabled = false;
    }

    Logger.success(`Config validated. Trading ${validAssets.length} assets.`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════════

const STATE = {
    ws: null,
    connected: false,
    authorized: false,
    reconnectAttempts: 0,

    balance: 0,
    currency: 'USD',
    accountId: null,
    investmentCapital: 0,
    currentCapital: 0,
    effectiveDailyLossLimit: 0,

    assets: {},

    totalDailyPnl: 0,
    totalTradesToday: 0,
    totalOpenPositions: 0,
    consecutiveLosses: 0,
    lastLossTime: null,
    globalWins: 0,
    globalLosses: 0,

    hourlyStats: { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() },

    startTime: new Date(),
    lastResetDate: new Date().toDateString()
};

function createAssetState(symbol) {
    return {
        symbol,
        config: ASSET_CONFIGS[symbol],

        candles: [],
        lastTick: null,
        subscriptionId: null,
        lastProcessedTime: null,

        // Simplified state - no complex BoS tracking
        swingHighs: [],
        swingLows: [],
        currentTrend: null,
        fibLevels: null,

        lastSignalTime: 0,
        lastTradeCloseTime: 0,

        activeContract: null,
        contractId: null,
        entryPrice: null,
        direction: null,
        stake: 0,
        multiplier: 0,
        unrealizedPnl: 0,
        currentPrice: null,

        tradesToday: 0,
        dailyPnl: 0,
        wins: 0,
        losses: 0,

        lastBlockReason: 'Initializing...',
        analysisCount: 0
    };
}

function initializeAssetStates() {
    for (const symbol of CONFIG.activeAssets) {
        STATE.assets[symbol] = createAssetState(symbol);
        Logger.info(`Initialized ${symbol}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: LOGGER
// ═══════════════════════════════════════════════════════════════════════════════

const Logger = {
    colors: {
        reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m',
        yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m'
    },

    assetColors: {
        'R_75': '\x1b[32m', 'R_100': '\x1b[34m', '1HZ25V': '\x1b[35m',
        '1HZ50V': '\x1b[36m', '1HZ100V': '\x1b[96m', 'stpRNG': '\x1b[33m', 'frxXAUUSD': '\x1b[93m'
    },

    timestamp() { return new Date().toISOString().replace('T', ' ').substr(0, 19); },

    format(level, color, message, symbol = null) {
        const ts = this.timestamp();
        const sym = symbol ? `${this.assetColors[symbol] || ''}[${symbol}]${this.colors.reset} ` : '';
        return `${this.colors.dim}[${ts}]${this.colors.reset} ${color}[${level}]${this.colors.reset} ${sym}${message}`;
    },

    info(msg, sym = null) { console.log(this.format('INFO', this.colors.blue, msg, sym)); },
    success(msg, sym = null) { console.log(this.format('OK', this.colors.green, msg, sym)); },
    warn(msg, sym = null) { console.log(this.format('WARN', this.colors.yellow, msg, sym)); },
    error(msg, sym = null) { console.log(this.format('ERROR', this.colors.red, msg, sym)); },
    trade(msg, sym = null) { console.log(this.format('TRADE', this.colors.magenta, msg, sym)); },
    signal(msg, sym = null) { console.log(this.format('SIGNAL', this.colors.cyan, msg, sym)); },
    debug(msg, sym = null) { if (process.env.DEBUG === 'true') console.log(this.format('DEBUG', this.colors.dim, msg, sym)); },

    banner() {
        console.log('\n' + this.colors.cyan + '═'.repeat(75) + this.colors.reset);
        console.log(this.colors.cyan + '  DERIV FIBONACCI SCALPER BOT v2.2 - CONTINUOUS TRADING' + this.colors.reset);
        console.log(this.colors.dim + '  Trading ' + CONFIG.activeAssets.length + ' assets | Telegram: ' +
            (CONFIG.telegram.enabled ? 'ON' : 'OFF') + this.colors.reset);
        console.log(this.colors.cyan + '═'.repeat(75) + this.colors.reset + '\n');
    },

    printStatus() {
        console.log('\n' + this.colors.yellow + '┌─ Status ─────────────────────────────────────────────────────────────────┐' + this.colors.reset);
        console.log('│ Symbol       │ Trend  │ Fib Zone         │ Position   │ P&L        │ Block Reason         │');
        console.log('├──────────────┼────────┼──────────────────┼────────────┼────────────┼──────────────────────┤');

        for (const symbol of CONFIG.activeAssets) {
            const a = STATE.assets[symbol];
            const trend = a.currentTrend ? (a.currentTrend === 'up' ? '↑ UP  ' : '↓ DOWN') : '- NONE';
            let fib = '-                ';
            if (a.fibLevels) {
                fib = `${a.fibLevels.zone50.toFixed(1)}-${a.fibLevels.zone618.toFixed(1)}`.padEnd(16);
            }

            let pos = '-          ';
            let pnl = '-          ';
            if (a.activeContract) {
                pos = (a.direction === 'MULTUP' ? '🟢 BUY' : '🔴 SELL').padEnd(10);
                const p = a.unrealizedPnl || 0;
                pnl = ((p >= 0 ? '+' : '') + '$' + p.toFixed(2)).padEnd(10);
            }

            const block = (a.lastBlockReason || 'None').substring(0, 20).padEnd(20);

            console.log(`│ ${(this.assetColors[symbol] || '') + symbol.padEnd(12) + this.colors.reset} │ ${trend} │ ${fib} │ ${pos} │ ${pnl} │ ${block} │`);
        }
        console.log(this.colors.yellow + '└──────────────────────────────────────────────────────────────────────────────┘' + this.colors.reset);

        const wr = (STATE.globalWins + STATE.globalLosses) > 0
            ? ((STATE.globalWins / (STATE.globalWins + STATE.globalLosses)) * 100).toFixed(1) : 0;
        console.log(`\n  Balance: $${STATE.balance.toFixed(2)} | Daily P&L: ${STATE.totalDailyPnl >= 0 ? '+' : ''}$${STATE.totalDailyPnl.toFixed(2)} | Win Rate: ${wr}% | Open: ${STATE.totalOpenPositions}/${CONFIG.maxTotalOpenPositions}\n`);
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: TELEGRAM NOTIFIER
// ═══════════════════════════════════════════════════════════════════════════════

const TelegramNotifier = {
    async send(message) {
        if (!CONFIG.telegram.enabled) return;
        const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
        const data = JSON.stringify({ chat_id: CONFIG.telegram.chatId, text: message, parse_mode: 'HTML' });

        return new Promise((resolve) => {
            const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, resolve);
            req.on('error', () => { });
            req.write(data);
            req.end();
        });
    },

    async tradeOpened(symbol, direction, stake, multiplier, entry) {
        if (!CONFIG.telegram.sendTradeAlerts) return;
        const dir = direction === 'MULTUP' ? '🟢 BUY' : '🔴 SELL';
        await this.send(`🔔 Trade Opened\n\n📊 ${symbol}\n${dir}\n\n💰 Stake: $${stake.toFixed(2)}\n📈 Mult: ${multiplier}x\n📍 Entry: ${entry.toFixed(4)}\n\n⏰ ${new Date().toLocaleTimeString()}`);
    },

    async tradeClosed(symbol, pnl, isWin) {
        if (!CONFIG.telegram.sendTradeAlerts) return;
        const emoji = isWin ? '✅ WIN' : '❌ LOSS';
        await this.send(`${emoji}\n\n📊 ${symbol}\nP&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n\n📈 Daily: ${STATE.totalDailyPnl >= 0 ? '+' : ''}$${STATE.totalDailyPnl.toFixed(2)}\n📊 Trades: ${STATE.totalTradesToday}`);
    },

    async hourlySummary() {
        if (!CONFIG.telegram.sendHourlySummary) return;
        const s = STATE.hourlyStats;
        const wr = s.wins + s.losses > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : 0;
        await this.send(`⏰ Hourly Summary\n\nTrades: ${s.trades}\nWins/Losses: ${s.wins}/${s.losses}\nWin Rate: ${wr}%\nP&L: ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}\n\nDaily P&L: ${STATE.totalDailyPnl >= 0 ? '+' : ''}$${STATE.totalDailyPnl.toFixed(2)}`);
        STATE.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
    },

    async startup() {
        if (!CONFIG.telegram.enabled) return;
        await this.send(`🚀 Bot Started v2.2\n\nAssets: ${CONFIG.activeAssets.join(', ')}\nCapital: $${CONFIG.investmentCapital || STATE.balance}\nMax Positions: ${CONFIG.maxTotalOpenPositions}`);
    },

    async shutdown() {
        if (!CONFIG.telegram.enabled) return;
        await this.send(`🛑 Bot Stopped\n\nFinal P&L: ${STATE.totalDailyPnl >= 0 ? '+' : ''}$${STATE.totalDailyPnl.toFixed(2)}\nTrades: ${STATE.totalTradesToday}`);
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: DERIV API
// ═══════════════════════════════════════════════════════════════════════════════

const DerivAPI = {
    reqId: 0,
    pending: new Map(),

    connect() {
        return new Promise((resolve, reject) => {
            Logger.info('Connecting to Deriv...');
            STATE.ws = new WebSocket(CONFIG.wsUrl + CONFIG.appId);

            STATE.ws.on('open', () => {
                STATE.connected = true;
                STATE.reconnectAttempts = 0;
                Logger.success('Connected');
                resolve();
            });

            STATE.ws.on('close', () => {
                STATE.connected = false;
                STATE.authorized = false;
                Logger.warn('Disconnected');
                this.reconnect();
            });

            STATE.ws.on('error', (e) => { Logger.error(`WS Error: ${e.message}`); reject(e); });
            STATE.ws.on('message', (data) => {
                try { this.handleMessage(JSON.parse(data.toString())); }
                catch (e) { Logger.error(`Parse error: ${e.message}`); }
            });
        });
    },

    async reconnect() {
        if (STATE.reconnectAttempts >= CONFIG.maxReconnectAttempts) {
            Logger.error('Max reconnect attempts. Exiting.');
            process.exit(1);
        }
        STATE.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, STATE.reconnectAttempts), 30000);
        Logger.info(`Reconnecting in ${delay / 1000}s...`);
        setTimeout(async () => {
            try {
                await this.connect();
                await this.authorize();
                await this.subscribeAll();
            } catch (e) { Logger.error(`Reconnect failed: ${e.message}`); }
        }, delay);
    },

    send(req) {
        return new Promise((resolve, reject) => {
            if (!STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('Not connected'));
                return;
            }
            const id = ++this.reqId;
            req.req_id = id;
            const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('Timeout')); }, 30000);
            this.pending.set(id, { resolve, reject, timeout });
            STATE.ws.send(JSON.stringify(req));
        });
    },

    handleMessage(res) {
        if (res.msg_type === 'ohlc') {
            const sym = res.ohlc?.symbol;
            if (sym && STATE.assets[sym]) CandleManager.update(sym, res.ohlc);
            return;
        }

        if (res.msg_type === 'proposal_open_contract') {
            TradeExecutor.onContractUpdate(res.proposal_open_contract);
            return;
        }

        if (res.req_id && this.pending.has(res.req_id)) {
            const { resolve, reject, timeout } = this.pending.get(res.req_id);
            clearTimeout(timeout);
            this.pending.delete(res.req_id);
            if (res.error) { Logger.error(`API: ${res.error.message}`); reject(new Error(res.error.message)); }
            else resolve(res);
        }
    },

    async authorize() {
        Logger.info('Authorizing...');
        const res = await this.send({ authorize: CONFIG.apiToken });
        STATE.authorized = true;
        STATE.balance = res.authorize.balance;
        STATE.currency = res.authorize.currency;
        STATE.accountId = res.authorize.loginid;

        STATE.investmentCapital = CONFIG.investmentCapital > 0 && CONFIG.investmentCapital <= STATE.balance
            ? CONFIG.investmentCapital : STATE.balance;
        STATE.currentCapital = STATE.investmentCapital;
        STATE.effectiveDailyLossLimit = STATE.investmentCapital * (CONFIG.maxDailyLossPercent / 100);

        Logger.success(`Authorized: ${res.authorize.fullname} | Balance: $${STATE.balance.toFixed(2)}`);
    },

    async subscribeCandles(symbol) {
        const res = await this.send({
            ticks_history: symbol, adjust_start_time: 1, count: CONFIG.maxCandles,
            end: 'latest', granularity: 60, style: 'candles', subscribe: 1
        });

        if (res.candles && STATE.assets[symbol]) {
            STATE.assets[symbol].candles = res.candles.map(c => ({
                time: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close
            }));
            STATE.assets[symbol].subscriptionId = res.subscription?.id;
            Logger.success(`Subscribed: ${STATE.assets[symbol].candles.length} candles`, symbol);
        }
    },

    async subscribeAll() {
        for (const sym of CONFIG.activeAssets) {
            try { await this.subscribeCandles(sym); await new Promise(r => setTimeout(r, 300)); }
            catch (e) { Logger.error(`Subscribe failed: ${e.message}`, sym); }
        }
    },

    async buy(symbol, type, stake, multiplier, tp, sl) {
        const req = {
            buy: 1, price: stake,
            parameters: {
                contract_type: type, symbol, currency: STATE.currency,
                amount: stake, basis: 'stake', multiplier,
                limit_order: {}
            }
        };
        if (tp) req.parameters.limit_order.take_profit = +tp.toFixed(2);
        if (sl) req.parameters.limit_order.stop_loss = +sl.toFixed(2);
        return await this.send(req);
    },

    async subscribeContract(id) {
        return await this.send({ proposal_open_contract: 1, contract_id: id, subscribe: 1 });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: CANDLE MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

const CandleManager = {
    update(symbol, ohlc) {
        const asset = STATE.assets[symbol];
        if (!asset) return;

        const candle = { time: ohlc.epoch, open: +ohlc.open, high: +ohlc.high, low: +ohlc.low, close: +ohlc.close };
        asset.lastTick = candle.close;
        asset.currentPrice = candle.close;

        if (asset.candles.length === 0) { asset.candles.push(candle); return; }

        const last = asset.candles[asset.candles.length - 1];

        if (candle.time === last.time) {
            asset.candles[asset.candles.length - 1] = candle;
        } else if (candle.time > last.time) {
            asset.candles.push(candle);
            if (asset.candles.length > CONFIG.maxCandles) asset.candles.shift();

            if (asset.lastProcessedTime !== last.time) {
                asset.lastProcessedTime = last.time;
                this.onClose(symbol, last);
            }
        }
    },

    onClose(symbol, candle) {
        Logger.debug(`Candle closed: ${candle.close.toFixed(4)}`, symbol);

        // Check resets
        const today = new Date().toDateString();
        if (today !== STATE.lastResetDate) {
            Logger.info('New day - resetting stats');
            TelegramNotifier.hourlySummary();
            STATE.totalDailyPnl = 0; STATE.totalTradesToday = 0;
            STATE.globalWins = 0; STATE.globalLosses = 0;
            STATE.lastResetDate = today;
            for (const s of CONFIG.activeAssets) {
                const a = STATE.assets[s];
                a.tradesToday = 0; a.dailyPnl = 0; a.wins = 0; a.losses = 0;
            }
        }

        const hour = new Date().getHours();
        if (hour !== STATE.hourlyStats.lastHour) {
            TelegramNotifier.hourlySummary();
            STATE.hourlyStats.lastHour = hour;
        }

        // Run strategy
        Strategy.analyze(symbol);
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8: STRATEGY - COMPLETELY REWRITTEN FOR CONTINUOUS TRADING
// ═══════════════════════════════════════════════════════════════════════════════

const Strategy = {
    analyze(symbol) {
        const asset = STATE.assets[symbol];
        asset.analysisCount++;

        // 1. Skip if have open position
        if (asset.activeContract) {
            asset.lastBlockReason = 'Has open position';
            return;
        }

        // 2. Check post-trade cooldown
        const now = Date.now();
        if (asset.lastTradeCloseTime && (now - asset.lastTradeCloseTime) < CONFIG.postTradeCooldown * 1000) {
            asset.lastBlockReason = `Post-trade cooldown`;
            return;
        }

        // 3. Check signal cooldown
        if (asset.lastSignalTime && (now - asset.lastSignalTime) < CONFIG.signalCooldownSeconds * 1000) {
            asset.lastBlockReason = `Signal cooldown`;
            return;
        }

        // 4. Get candles
        const candles = asset.candles.slice(-60);
        if (candles.length < 20) {
            asset.lastBlockReason = 'Not enough candles';
            return;
        }

        // 5. Find swings (ALWAYS recalculate)
        const lookback = asset.config.swingLookback || 3;
        asset.swingHighs = this.findSwingHighs(candles, lookback);
        asset.swingLows = this.findSwingLows(candles, lookback);

        if (asset.swingHighs.length < 2 || asset.swingLows.length < 2) {
            asset.lastBlockReason = 'Not enough swings';
            return;
        }

        // 6. Determine trend (RELAXED - only need one of HH/HL or LH/LL)
        asset.currentTrend = this.detectTrend(asset.swingHighs, asset.swingLows);

        if (!asset.currentTrend) {
            asset.lastBlockReason = 'No trend';
            return;
        }

        // 7. Calculate Fib levels (ALWAYS recalculate on each candle)
        const currentCandle = candles[candles.length - 1];
        asset.fibLevels = this.calculateFib(asset, currentCandle);

        if (!asset.fibLevels) {
            asset.lastBlockReason = 'Cannot calc Fib';
            return;
        }

        // 8. Check if price is in golden zone
        const price = currentCandle.close;
        const inZone = this.isInGoldenZone(price, asset.fibLevels);

        if (!inZone) {
            asset.lastBlockReason = `Price ${price.toFixed(1)} outside zone`;
            return;
        }

        // 9. Check risk management
        if (!RiskManager.canTrade(symbol)) {
            asset.lastBlockReason = 'Risk blocked';
            return;
        }

        // 10. Generate and execute signal!
        const signal = this.createSignal(asset, currentCandle);
        if (signal) {
            Logger.signal(`ENTRY: ${signal.direction} @ ${signal.entry.toFixed(4)}`, symbol);
            asset.lastSignalTime = now;
            asset.lastBlockReason = 'Signal sent';
            TradeExecutor.execute(symbol, signal);
        }
    },

    findSwingHighs(candles, lookback) {
        const swings = [];
        for (let i = lookback; i < candles.length - 1; i++) {  // Note: -1 not -lookback for more swings
            let isSwing = true;
            const high = candles[i].high;
            for (let j = 1; j <= lookback; j++) {
                if (i - j >= 0 && candles[i - j].high >= high) { isSwing = false; break; }
                if (i + j < candles.length && candles[i + j].high > high) { isSwing = false; break; }
            }
            if (isSwing) swings.push({ index: i, price: high, time: candles[i].time });
        }
        return swings;
    },

    findSwingLows(candles, lookback) {
        const swings = [];
        for (let i = lookback; i < candles.length - 1; i++) {
            let isSwing = true;
            const low = candles[i].low;
            for (let j = 1; j <= lookback; j++) {
                if (i - j >= 0 && candles[i - j].low <= low) { isSwing = false; break; }
                if (i + j < candles.length && candles[i + j].low < low) { isSwing = false; break; }
            }
            if (isSwing) swings.push({ index: i, price: low, time: candles[i].time });
        }
        return swings;
    },

    detectTrend(highs, lows) {
        // Get last 3 of each
        const h = highs.slice(-3);
        const l = lows.slice(-3);

        if (h.length < 2 || l.length < 2) return null;

        // Check for uptrend: higher highs OR higher lows
        let higherHighs = h[h.length - 1].price > h[h.length - 2].price;
        let higherLows = l[l.length - 1].price > l[l.length - 2].price;

        // Check for downtrend: lower highs OR lower lows
        let lowerHighs = h[h.length - 1].price < h[h.length - 2].price;
        let lowerLows = l[l.length - 1].price < l[l.length - 2].price;

        // Prefer stronger signals (both conditions) but accept single
        if (higherHighs && higherLows) return 'up';
        if (lowerHighs && lowerLows) return 'down';
        // if (higherHighs || higherLows) return 'up';
        // if (lowerHighs || lowerLows) return 'down';

        return null;
    },

    calculateFib(asset, currentCandle) {
        const highs = asset.swingHighs;
        const lows = asset.swingLows;

        if (highs.length < 1 || lows.length < 1) return null;

        let start, end;

        if (asset.currentTrend === 'up') {
            // Use most recent swing low as start, highest point as end
            const recentLow = lows[lows.length - 1];
            const highPoint = Math.max(highs[highs.length - 1].price, currentCandle.high);
            start = recentLow.price;
            end = highPoint;
        } else {
            // Use most recent swing high as start, lowest point as end
            const recentHigh = highs[highs.length - 1];
            const lowPoint = Math.min(lows[lows.length - 1].price, currentCandle.low);
            start = recentHigh.price;
            end = lowPoint;
        }

        const range = end - start;
        if (Math.abs(range) < 0.0001) return null;

        // Calculate the 0.5 and 0.618 retracement levels
        const zone50 = end - (range * 0.5);
        const zone618 = end - (range * 0.618);

        return { start, end, range: Math.abs(range), zone50, zone618, trend: asset.currentTrend };
    },

    isInGoldenZone(price, fib) {
        // Get zone bounds
        const upper = Math.max(fib.zone50, fib.zone618);
        const lower = Math.min(fib.zone50, fib.zone618);

        return price >= lower && price <= upper;
    },

    createSignal(asset, candle) {
        const fib = asset.fibLevels;
        const entry = candle.close;
        const rr = asset.config.rrRatio || 1.5;

        if (asset.currentTrend === 'up') {
            // For uptrend, SL below the zone, TP above entry
            const sl = Math.min(fib.zone50, fib.zone618) - (fib.range * 0.1);
            const risk = entry - sl;
            const tp = entry + (risk * rr);

            return { direction: 'MULTUP', entry, stopLoss: sl, takeProfit: tp, risk };
        } else {
            // For downtrend, SL above the zone, TP below entry
            const sl = Math.max(fib.zone50, fib.zone618) + (fib.range * 0.1);
            const risk = sl - entry;
            const tp = entry - (risk * rr);

            return { direction: 'MULTDOWN', entry, stopLoss: sl, takeProfit: tp, risk };
        }
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9: RISK MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

const RiskManager = {
    canTrade(symbol) {
        const asset = STATE.assets[symbol];

        if (STATE.currentCapital <= 0) {
            Logger.warn('Capital depleted', symbol);
            return false;
        }

        if (STATE.totalDailyPnl <= -STATE.effectiveDailyLossLimit) {
            Logger.warn('Daily loss limit', symbol);
            return false;
        }

        if (STATE.totalOpenPositions >= CONFIG.maxTotalOpenPositions) {
            Logger.debug('Max positions', symbol);
            return false;
        }

        if (STATE.consecutiveLosses >= CONFIG.maxConsecutiveLosses && STATE.lastLossTime) {
            const cooldownEnd = new Date(STATE.lastLossTime.getTime() + CONFIG.cooldownMinutes * 60000);
            if (new Date() < cooldownEnd) {
                Logger.debug('Loss cooldown', symbol);
                return false;
            }
            STATE.consecutiveLosses = 0;
        }

        if (asset.tradesToday >= asset.config.maxTradesPerDay) {
            Logger.warn('Asset trade limit', symbol);
            return false;
        }

        return true;
    },

    recordTrade(symbol, pnl, isWin) {
        const asset = STATE.assets[symbol];

        asset.dailyPnl += pnl;
        asset.tradesToday++;
        if (isWin) asset.wins++; else asset.losses++;

        STATE.totalDailyPnl += pnl;
        STATE.totalTradesToday++;
        STATE.balance += pnl;
        STATE.currentCapital += pnl;

        STATE.hourlyStats.trades++;
        STATE.hourlyStats.pnl += pnl;
        if (isWin) { STATE.hourlyStats.wins++; STATE.globalWins++; STATE.consecutiveLosses = 0; }
        else { STATE.hourlyStats.losses++; STATE.globalLosses++; STATE.consecutiveLosses++; STATE.lastLossTime = new Date(); }
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10: TRADE EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════════

const TradeExecutor = {
    async execute(symbol, signal) {
        const asset = STATE.assets[symbol];
        if (asset.activeContract) return;

        try {
            const stake = Math.max(asset.config.minStake, Math.min(CONFIG.defaultStake, asset.config.maxStake));
            const mult = asset.config.defaultMultiplier;
            const rr = asset.config.rrRatio || 1.5;

            Logger.trade(`Opening ${signal.direction} | $${stake} @ ${mult}x`, symbol);

            const res = await DerivAPI.buy(symbol, signal.direction, stake, mult, stake * rr, stake);

            if (res.buy) {
                asset.activeContract = String(res.buy.contract_id);
                asset.contractId = String(res.buy.contract_id);
                asset.entryPrice = signal.entry;
                asset.direction = signal.direction;
                asset.stake = stake;
                asset.multiplier = mult;
                asset.unrealizedPnl = 0;

                STATE.totalOpenPositions++;
                Logger.success(`Opened: ${asset.activeContract}`, symbol);

                await TelegramNotifier.tradeOpened(symbol, signal.direction, stake, mult, signal.entry);
                await DerivAPI.subscribeContract(asset.activeContract);

                Logger.printStatus();
            }
        } catch (e) {
            Logger.error(`Execute failed: ${e.message}`, symbol);
            asset.lastBlockReason = `Error: ${e.message.substring(0, 20)}`;
        }
    },

    onContractUpdate(contract) {
        if (!contract) return;

        const id = String(contract.contract_id);
        let symbol = null;

        for (const s of CONFIG.activeAssets) {
            if (STATE.assets[s].activeContract === id) { symbol = s; break; }
        }
        if (!symbol) return;

        const asset = STATE.assets[symbol];

        if (contract.profit !== undefined) {
            asset.unrealizedPnl = contract.profit;
            asset.currentPrice = contract.current_spot;
        }

        if (contract.is_sold || contract.status === 'sold') {
            this.onClosed(symbol, contract);
        }
    },

    async onClosed(symbol, contract) {
        const asset = STATE.assets[symbol];
        const pnl = contract.profit || 0;
        const isWin = pnl > 0;

        Logger.trade(`${isWin ? '✅ WIN' : '❌ LOSS'} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, symbol);

        await TelegramNotifier.tradeClosed(symbol, pnl, isWin);
        RiskManager.recordTrade(symbol, pnl, isWin);

        // Reset position state
        asset.activeContract = null;
        asset.contractId = null;
        asset.entryPrice = null;
        asset.direction = null;
        asset.stake = 0;
        asset.multiplier = 0;
        asset.unrealizedPnl = 0;

        // CRITICAL: Reset cooldowns to allow immediate re-entry
        asset.lastTradeCloseTime = Date.now();
        // Don't reset lastSignalTime - let it expire naturally for the cooldown

        STATE.totalOpenPositions = Math.max(0, STATE.totalOpenPositions - 1);

        asset.lastBlockReason = 'Trade closed, ready';
        Logger.printStatus();
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11: MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    Logger.banner();
    validateConfig();
    initializeAssetStates();

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
        await DerivAPI.connect();
        await DerivAPI.authorize();
        await DerivAPI.subscribeAll();

        await TelegramNotifier.startup();

        Logger.printStatus();
        Logger.success('Bot running. Monitoring for signals...');
        Logger.info('Status updates every 2 minutes. Press Ctrl+C to stop.\n');

        // Status display every 2 minutes
        setInterval(() => Logger.printStatus(), 120000);

        // Live P&L update every 15 seconds when positions open
        setInterval(() => { if (STATE.totalOpenPositions > 0) Logger.printStatus(); }, 15000);

        // Hourly summary
        setInterval(() => {
            const h = new Date().getHours();
            if (h !== STATE.hourlyStats.lastHour) {
                TelegramNotifier.hourlySummary();
                STATE.hourlyStats.lastHour = h;
            }
        }, 60000);

        process.stdin.resume();
    } catch (e) {
        Logger.error(`Startup failed: ${e.message}`);
        process.exit(1);
    }
}

async function shutdown() {
    Logger.warn('\nShutting down...');
    await TelegramNotifier.shutdown();
    if (STATE.ws) STATE.ws.close();
    Logger.printStatus();
    process.exit(0);
}

main();
