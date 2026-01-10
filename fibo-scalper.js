#!/usr/bin/env node

'use strict';

const WebSocket = require('ws');
const https = require('https');
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: ASSET CONFIGURATIONS
// ═══════════════════════════════════════════════════════════════════════════════

const ASSET_CONFIGS = {
    'R_75': {
        name: 'Volatility 75',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 500],
        defaultMultiplier: 200,
        maxTradesPerDay: 500000,
        minStake: 1.00,
        maxStake: 3000,
        tradingHours: '24/7',
        swingLookback: 5,
        minImpulsePercent: 0.0005,
        rrRatio: 1.5
    },
    'R_100': {
        name: 'Volatility 100',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [40, 100, 200, 300, 500],
        defaultMultiplier: 200,
        maxTradesPerDay: 50,
        minStake: 1.00,
        maxStake: 3000,
        tradingHours: '24/7',
        swingLookback: 5,
        minImpulsePercent: 0.0005,
        rrRatio: 1.5
    },
    '1HZ25V': {
        name: 'Volatility 25 (1s)',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [160, 400, 800, 1200, 1600],
        defaultMultiplier: 800,
        maxTradesPerDay: 120,
        minStake: 1.00,
        maxStake: 1000,
        tradingHours: '24/7',
        swingLookback: 4,
        minImpulsePercent: 0.0005,
        rrRatio: 1.3
    },
    '1HZ50V': {
        name: 'Volatility 50 (1s)',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [80, 200, 400, 600, 800],
        defaultMultiplier: 400,
        maxTradesPerDay: 120,
        minStake: 1.00,
        maxStake: 1000,
        tradingHours: '24/7',
        swingLookback: 4,
        minImpulsePercent: 0.0005,
        rrRatio: 1.4
    },
    '1HZ100V': {
        name: 'Volatility 100 (1s)',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [40, 100, 200, 300, 500],
        defaultMultiplier: 200,
        maxTradesPerDay: 120,
        minStake: 1.00,
        maxStake: 1000,
        tradingHours: '24/7',
        swingLookback: 4,
        minImpulsePercent: 0.0005,
        rrRatio: 1.4
    },
    'stpRNG': {
        name: 'Step Index',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [750, 2000, 3500, 5500, 7500],
        defaultMultiplier: 3500,
        maxTradesPerDay: 120,
        minStake: 1.00,
        maxStake: 1000,
        tradingHours: '24/7',
        swingLookback: 6,
        minImpulsePercent: 0.0005,
        rrRatio: 1.2
    },
    'frxXAUUSD': {
        name: 'Gold/USD',
        category: 'commodity',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 400, 500],
        defaultMultiplier: 300,
        maxTradesPerDay: 5,
        minStake: 5,
        maxStake: 5000,
        tradingHours: 'Sun 23:00 - Fri 21:55 GMT',
        swingLookback: 5,
        minImpulsePercent: 0.0005,
        rrRatio: 1.5
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: GLOBAL CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
    // Connection settings
    appId: '1089',
    apiToken: '0P94g4WdSrSrzir',
    accountType: 'real',
    wsUrl: 'wss://ws.derivws.com/websockets/v3?app_id=',

    // Active assets to trade
    activeAssets: ['R_75', 'R_100', '1HZ25V', '1HZ50V', '1HZ100V', 'stpRNG',],

    // Investment Capital
    investmentCapital: 500,

    // Global trading settings
    defaultStake: 1,
    useAssetDefaultMultiplier: true,

    // Strategy defaults
    minTrendSwings: 2,
    fibUpperZone: 0.618,
    fibLowerZone: 0.5,

    // Global risk management
    maxDailyLossPercent: 10,
    maxDailyLoss: 50,
    maxTotalOpenPositions: 7,
    maxConsecutiveLosses: 5,
    cooldownMinutes: 15,

    // Telegram settings
    telegram: {
        enabled: true,
        botToken: '8322457666:AAHuXoU9JlD-wxaL-Yw1Bl9f056AGT_9WFU',
        chatId: '752497117',
        sendTradeAlerts: true,
        sendHourlySummary: true,
        sendDailySummary: true
    },

    // Candle buffer
    maxCandles: 300,

    // Reconnection
    maxReconnectAttempts: 5
};

// Validate configuration
function validateConfig() {
    if (!CONFIG.apiToken) {
        Logger.error('DERIV_API_TOKEN is required. Please set it in .env file.');
        process.exit(1);
    }

    const validAssets = CONFIG.activeAssets.filter(a => ASSET_CONFIGS[a]);
    if (validAssets.length === 0) {
        Logger.error('No valid assets configured. Check ACTIVE_ASSETS in .env');
        process.exit(1);
    }
    CONFIG.activeAssets = validAssets;

    if (CONFIG.accountType === 'real') {
        Logger.warn('⚠️  REAL ACCOUNT MODE - Trading with real money!');
    }

    if (CONFIG.telegram.enabled) {
        if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
            Logger.warn('Telegram enabled but missing BOT_TOKEN or CHAT_ID. Disabling notifications.');
            CONFIG.telegram.enabled = false;
        } else {
            Logger.success('Telegram notifications enabled');
        }
    }

    Logger.success(`Configuration validated. Trading ${validAssets.length} assets.`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════════

const STATE = {
    // Connection
    ws: null,
    connected: false,
    authorized: false,
    reconnectAttempts: 0,

    // Account
    balance: 0,
    currency: 'USD',
    accountId: null,

    // Investment Capital tracking
    investmentCapital: 0,
    currentCapital: 0,
    effectiveDailyLossLimit: 0,

    // Per-asset state
    assets: {},

    // Global tracking
    totalDailyPnl: 0,
    totalTradesToday: 0,
    totalOpenPositions: 0,
    consecutiveLosses: 0,
    consecutiveWins: 0,
    lastLossTime: null,
    globalWins: 0,
    globalLosses: 0,

    // Hourly tracking for summaries
    hourlyStats: {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        lastHour: new Date().getHours()
    },

    // Session
    startTime: new Date(),
    lastResetDate: new Date().toDateString()
};

// Asset state factory
function createAssetState(symbol) {
    const config = ASSET_CONFIGS[symbol];
    return {
        symbol: symbol,
        config: config,

        // Market data
        candles: [],
        lastTick: null,
        subscriptionId: null,
        lastProcessedTime: null,

        // Strategy state
        swingHighs: [],
        swingLows: [],
        currentTrend: null,
        bosDetected: false,
        impulseStart: null,
        impulseEnd: null,
        fibLevels: null,
        waitingForEntry: false,

        // Position tracking with live P&L
        activeContract: null,
        contractId: null,
        entryPrice: null,
        direction: null,
        takeProfitPrice: null,
        stopLossPrice: null,
        contractSubscriptionId: null,
        stake: 0,
        multiplier: 0,

        // Live position data (updated from contract subscription)
        currentPrice: null,
        unrealizedPnl: 0,

        // Per-asset stats
        tradesToday: 0,
        dailyPnl: 0,
        wins: 0,
        losses: 0,

        // Trade history
        tradeHistory: []
    };
}

// Initialize asset states
function initializeAssetStates() {
    for (const symbol of CONFIG.activeAssets) {
        STATE.assets[symbol] = createAssetState(symbol);
        Logger.info(`Initialized state for ${symbol} (${ASSET_CONFIGS[symbol].name})`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: TELEGRAM NOTIFIER
// ═══════════════════════════════════════════════════════════════════════════════

const TelegramNotifier = {
    async send(message, parseMode = 'HTML') {
        if (!CONFIG.telegram.enabled) return;

        const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
        const data = JSON.stringify({
            chat_id: CONFIG.telegram.chatId,
            text: message,
            parse_mode: parseMode,
            disable_web_page_preview: true
        });

        return new Promise((resolve, reject) => {
            const req = https.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve(JSON.parse(body));
                    } else {
                        Logger.debug(`Telegram API error: ${body}`);
                        reject(new Error(`Telegram API error: ${res.statusCode}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(data);
            req.end();
        });
    },

    async sendTradeOpened(symbol, direction, stake, multiplier, entry) {
        if (!CONFIG.telegram.sendTradeAlerts) return;

        const dirEmoji = direction === 'MULTUP' ? '🟢 BUY' : '🔴 SELL';
        const message = `
            🔔 Trade Opened

            📊 ${symbol} - ${ASSET_CONFIGS[symbol]?.name || symbol}
            ${dirEmoji}

            💰 Stake: $${stake.toFixed(2)}
            📈 Multiplier: ${multiplier}x
            📍 Entry: ${entry.toFixed(4)}

            ⏰ ${new Date().toLocaleTimeString()}
        `.trim();

        try {
            await this.send(message);
            // Logger.debug('Telegram: Trade opened notification sent', symbol);
        } catch (error) {
            // Logger.debug(`Telegram send failed: ${error.message}`);
        }
    },

    async sendTradeClosed(symbol, direction, pnl, isWin) {
        if (!CONFIG.telegram.sendTradeAlerts) return;

        const resultEmoji = isWin ? '✅ WIN' : '❌ LOSS';
        const pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
        const pnlColor = pnl >= 0 ? '🟢' : '🔴';

        const message = `
            ${resultEmoji}

            📊 ${symbol}
            ${pnlColor} P&L: ${pnlStr}

            📈 Daily P&L: ${(STATE.totalDailyPnl >= 0 ? '+' : '')}$${STATE.totalDailyPnl.toFixed(2)}
            🎯 Win Rate: ${STATE.globalWins + STATE.globalLosses > 0 ? ((STATE.globalWins / (STATE.globalWins + STATE.globalLosses)) * 100).toFixed(1) : 0}%
            📊 Trades Today: ${STATE.totalTradesToday}

            ⏰ ${new Date().toLocaleTimeString()}
        `.trim();

        try {
            await this.send(message);
            //Logger.debug('Telegram: Trade closed notification sent', symbol);
        } catch (error) {
            //Logger.debug(`Telegram send failed: ${error.message}`);
        }
    },

    async sendHourlySummary() {
        if (!CONFIG.telegram.sendHourlySummary) return;

        const stats = STATE.hourlyStats;
        // if (stats.trades === 0) {
        //     Logger.debug('Telegram: No trades in last hour, skipping summary');
        //     return;
        // }

        const winRate = stats.wins + stats.losses > 0
            ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1)
            : 0;
        const pnlEmoji = stats.pnl >= 0 ? '🟢' : '🔴';
        const pnlStr = (stats.pnl >= 0 ? '+' : '') + '$' + stats.pnl.toFixed(2);

        // Build per-asset breakdown
        let assetBreakdown = '';
        for (const symbol of CONFIG.activeAssets) {
            const asset = STATE.assets[symbol];
            if (asset.tradesToday > 0) {
                const assetPnl = (asset.dailyPnl >= 0 ? '+' : '') + '$' + asset.dailyPnl.toFixed(2);
                assetBreakdown += `  • ${symbol}: ${assetPnl} (${asset.wins}W/${asset.losses}L)\n`;
            }
        }

        const message = `
            ⏰ Hourly Trade Summary

            📊 Last Hour
            ├ Trades: ${stats.trades}
            ├ Wins: ${stats.wins} | Losses: ${stats.losses}
            ├ Win Rate: ${winRate}%
            └ ${pnlEmoji} P&L: ${pnlStr}

            📈 Daily Totals
            ├ Total Trades: ${STATE.totalTradesToday}
            ├ Total W/L: ${STATE.globalWins}/${STATE.globalLosses}
            ├ Daily P&L: ${(STATE.totalDailyPnl >= 0 ? '+' : '')}$${STATE.totalDailyPnl.toFixed(2)}
            └ Capital: $${STATE.currentCapital.toFixed(2)}

            ${assetBreakdown ? 'Per Asset:\n' + assetBreakdown : ''}
            ⏰ ${new Date().toLocaleString()}
        `.trim();

        try {
            await this.send(message);
            // Logger.info('📱 Telegram: Hourly Summary sent successfully');
        } catch (error) {
            // Logger.debug(`Telegram hourly summary failed: ${error.message}`);
        }

        // Reset hourly stats
        STATE.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };
    },

    async sendDailySummary() {
        if (!CONFIG.telegram.sendDailySummary) return;

        const winRate = STATE.globalWins + STATE.globalLosses > 0
            ? ((STATE.globalWins / (STATE.globalWins + STATE.globalLosses)) * 100).toFixed(1)
            : 0;

        const capitalChange = STATE.investmentCapital > 0
            ? ((STATE.currentCapital - STATE.investmentCapital) / STATE.investmentCapital * 100).toFixed(2)
            : 0;

        const pnlEmoji = STATE.totalDailyPnl >= 0 ? '🟢' : '🔴';

        // Build per-asset table
        let assetTable = '';
        for (const symbol of CONFIG.activeAssets) {
            const asset = STATE.assets[symbol];
            const pnl = (asset.dailyPnl >= 0 ? '+' : '') + '$' + asset.dailyPnl.toFixed(2);
            assetTable += `  ${symbol}: ${pnl} | ${asset.wins}W/${asset.losses}L\n`;
        }

        const message = `
            📊 Daily Trading Summary

            💰 Performance
            ├ ${pnlEmoji} Daily P&L: ${(STATE.totalDailyPnl >= 0 ? '+' : '')}$${STATE.totalDailyPnl.toFixed(2)}
            ├ Total Trades: ${STATE.totalTradesToday}
            ├ Wins: ${STATE.globalWins} | Losses: ${STATE.globalLosses}
            └ Win Rate: ${winRate}%

            💵 Capital
            ├ Starting: $${STATE.investmentCapital.toFixed(2)}
            ├ Current: $${STATE.currentCapital.toFixed(2)}
            └ Return: ${capitalChange >= 0 ? '+' : ''}${capitalChange}%

            📈 Per Asset:
            ${assetTable}
            📅 ${new Date().toLocaleDateString()}
        `.trim();

        try {
            await this.send(message);
            // Logger.info('📱 Telegram: Daily Summary sent successfully');
        } catch (error) {
            // Logger.debug(`Telegram daily summary failed: ${error.message}`);
        }
    },

    async sendStartup() {
        if (!CONFIG.telegram.enabled) return;

        const message = `
            🚀 Bot Started

            📊 Trading ${CONFIG.activeAssets.length} assets:
            ${CONFIG.activeAssets.map(s => `  • ${s}`).join('\n')}

            💰 Investment Capital: $${CONFIG.investmentCapital || 'Account Balance'}
            📈 Max Positions: ${CONFIG.maxTotalOpenPositions}
            🛡️ Daily Loss Limit: ${CONFIG.maxDailyLossPercent}%

            ⏰ ${new Date().toLocaleString()}
        `.trim();

        try {
            await this.send(message);
            // Logger.success('📱 Telegram: Startup notification sent');
        } catch (error) {
            // Logger.debug(`Telegram startup failed: ${error.message}`);
        }
    },

    async sendShutdown() {
        if (!CONFIG.telegram.enabled) return;

        await this.sendDailySummary();

        const message = `
            🛑 Bot Stopped

            Final P&L: ${(STATE.totalDailyPnl >= 0 ? '+' : '')}$${STATE.totalDailyPnl.toFixed(2)}
            Total Trades: ${STATE.totalTradesToday}

            ⏰ ${new Date().toLocaleString()}
        `.trim();

        try {
            await this.send(message);
        } catch (error) {
            Logger.debug(`Telegram shutdown failed: ${error.message}`);
        }
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: LOGGER
// ═══════════════════════════════════════════════════════════════════════════════

const Logger = {
    colors: {
        reset: '\x1b[0m',
        bright: '\x1b[1m',
        dim: '\x1b[2m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        cyan: '\x1b[36m',
        white: '\x1b[37m'
    },

    assetColors: {
        'R_75': '\x1b[32m',
        'R_100': '\x1b[34m',
        '1HZ25V': '\x1b[35m',
        '1HZ50V': '\x1b[36m',
        'stpRNG': '\x1b[33m',
        'frxXAUUSD': '\x1b[93m'
    },

    timestamp() {
        return new Date().toISOString().replace('T', ' ').substr(0, 19);
    },

    format(level, color, message, symbol = null) {
        const ts = this.timestamp();
        const symbolTag = symbol
            ? `${this.assetColors[symbol] || this.colors.white}[${symbol}]${this.colors.reset} `
            : '';
        return `${this.colors.dim}[${ts}]${this.colors.reset} ${color}[${level}]${this.colors.reset} ${symbolTag}${message}`;
    },

    info(message, symbol = null) {
        console.log(this.format('INFO', this.colors.blue, message, symbol));
    },

    success(message, symbol = null) {
        console.log(this.format('SUCCESS', this.colors.green, message, symbol));
    },

    warn(message, symbol = null) {
        console.log(this.format('WARN', this.colors.yellow, message, symbol));
    },

    error(message, symbol = null) {
        console.log(this.format('ERROR', this.colors.red, message, symbol));
    },

    trade(message, symbol = null) {
        console.log(this.format('TRADE', this.colors.magenta, message, symbol));
    },

    signal(message, symbol = null) {
        console.log(this.format('SIGNAL', this.colors.cyan, message, symbol));
    },

    debug(message, symbol = null) {
        if (process.env.DEBUG === 'true') {
            console.log(this.format('DEBUG', this.colors.dim, message, symbol));
        }
    },

    banner() {
        console.log('\n' + this.colors.cyan + '═'.repeat(80) + this.colors.reset);
        console.log(this.colors.bright + this.colors.cyan +
            '   DERIV MULTI-ASSET FIBONACCI SCALPER BOT' + this.colors.reset);
        console.log(this.colors.dim + '   Trading ' + CONFIG.activeAssets.length +
            ' assets simultaneously | Telegram: ' + (CONFIG.telegram.enabled ? 'ON' : 'OFF') + this.colors.reset);
        console.log(this.colors.cyan + '═'.repeat(80) + this.colors.reset + '\n');
    },

    // NEW: Enhanced asset table with direction and live P&L
    printAssetTable() {
        console.log('\n' + this.colors.yellow + '┌─ Active Assets ────────────────────────────────────────────────────────────────────────┐' + this.colors.reset);
        console.log('│  Symbol      │ Name                    │ Direction │ Entry      │ Live P&L   │ Status  │');
        console.log('├──────────────┼─────────────────────────┼───────────┼────────────┼────────────┼─────────┤');

        for (const symbol of CONFIG.activeAssets) {
            const cfg = ASSET_CONFIGS[symbol];
            const asset = STATE.assets[symbol];
            const sym = symbol.padEnd(12);
            const name = cfg.name.substring(0, 23).padEnd(23);

            let direction = '⚪ -      ';
            let entry = '-         ';
            let livePnl = '-         ';
            let status = 'READY  ';
            let statusColor = this.colors.dim;

            if (asset?.activeContract) {
                // Direction with emoji
                if (asset.direction === 'MULTUP') {
                    direction = this.colors.green + '🟢 BUY    ' + this.colors.reset;
                } else if (asset.direction === 'MULTDOWN') {
                    direction = this.colors.red + '🔴 SELL   ' + this.colors.reset;
                }

                // Entry price
                entry = asset.entryPrice ? asset.entryPrice.toFixed(2).substring(0, 10).padEnd(10) : '-         ';

                // Live P&L
                const pnl = asset.unrealizedPnl || 0;
                const pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
                if (pnl >= 0) {
                    livePnl = this.colors.green + pnlStr.padEnd(10) + this.colors.reset;
                } else {
                    livePnl = this.colors.red + pnlStr.padEnd(10) + this.colors.reset;
                }

                status = 'TRADING';
                statusColor = this.colors.green;
            }

            console.log(`│  ${this.assetColors[symbol] || ''}${sym}${this.colors.reset} │ ${name} │ ${direction} │ ${entry} │ ${livePnl} │ ${statusColor}${status}${this.colors.reset} │`);
        }
        console.log(this.colors.yellow + '└────────────────────────────────────────────────────────────────────────────────────────┘' + this.colors.reset);
    },

    globalStats() {
        const winRate = (STATE.globalWins + STATE.globalLosses) > 0
            ? ((STATE.globalWins / (STATE.globalWins + STATE.globalLosses)) * 100).toFixed(1)
            : 0;

        const capitalReturn = STATE.investmentCapital > 0
            ? ((STATE.currentCapital - STATE.investmentCapital) / STATE.investmentCapital * 100).toFixed(2)
            : 0;

        const lossLimitUsed = STATE.effectiveDailyLossLimit > 0
            ? (Math.abs(Math.min(STATE.totalDailyPnl, 0)) / STATE.effectiveDailyLossLimit * 100).toFixed(1)
            : 0;

        console.log('\n' + this.colors.green + '┌─ Global Statistics ──────────────────────────────────────────────────┐' + this.colors.reset);
        console.log(`│  Account Balance:    ${STATE.currency} ${STATE.balance.toFixed(2).padEnd(48)}│`);
        console.log(`│  Investment Capital: ${STATE.currency} ${STATE.investmentCapital.toFixed(2).padEnd(48)}│`);
        console.log(`│  Current Capital:    ${STATE.currency} ${STATE.currentCapital.toFixed(2)} (${capitalReturn >= 0 ? '+' : ''}${capitalReturn}%)`.padEnd(71) + '│');
        console.log(`│  Daily P&L:          ${(STATE.totalDailyPnl >= 0 ? '+' : '') + '$' + STATE.totalDailyPnl.toFixed(2).padEnd(48)}│`);
        console.log(`│  Daily Loss Limit:   ${STATE.currency} ${STATE.effectiveDailyLossLimit.toFixed(2)} (${lossLimitUsed}% used)`.padEnd(71) + '│');
        console.log(`│  Open Positions:     ${(STATE.totalOpenPositions + '/' + CONFIG.maxTotalOpenPositions).padEnd(49)}│`);
        console.log(`│  Trades Today:       ${STATE.totalTradesToday.toString().padEnd(49)}│`);
        console.log(`│  Win Rate:           ${(winRate + '%').padEnd(49)}│`);
        console.log(`│  Wins/Losses:        ${(STATE.globalWins + '/' + STATE.globalLosses).padEnd(49)}│`);
        console.log(this.colors.green + '└──────────────────────────────────────────────────────────────────────┘' + this.colors.reset);

        // Per-asset breakdown with live P&L
        console.log('\n' + this.colors.cyan + '┌─ Per-Asset Performance ─────────────────────────────────────────────────────┐' + this.colors.reset);
        for (const symbol of CONFIG.activeAssets) {
            const asset = STATE.assets[symbol];
            const pnl = (asset.dailyPnl >= 0 ? '+' : '') + '$' + asset.dailyPnl.toFixed(2);
            const trades = asset.tradesToday;
            const wl = asset.wins + '/' + asset.losses;

            let posStatus = '⚪ -';
            if (asset.activeContract) {
                const dir = asset.direction === 'MULTUP' ? '🟢 BUY' : '🔴 SELL';
                const livePnl = (asset.unrealizedPnl >= 0 ? '+' : '') + '$' + asset.unrealizedPnl.toFixed(2);
                posStatus = `${dir} ${livePnl}`;
            }

            console.log(`│  ${symbol.padEnd(10)} │ P&L: ${pnl.padEnd(10)} │ Trades: ${trades.toString().padEnd(4)} │ W/L: ${wl.padEnd(6)} │ ${posStatus.padEnd(18)} │`);
        }
        console.log(this.colors.cyan + '└──────────────────────────────────────────────────────────────────────────────┘' + this.colors.reset + '\n');
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: DERIV API
// ═══════════════════════════════════════════════════════════════════════════════

const DerivAPI = {
    reqId: 0,
    pendingRequests: new Map(),

    connect() {
        return new Promise((resolve, reject) => {
            const wsUrl = CONFIG.wsUrl + CONFIG.appId;
            Logger.info('Connecting to Deriv API...');

            STATE.ws = new WebSocket(wsUrl);

            STATE.ws.on('open', () => {
                STATE.connected = true;
                STATE.reconnectAttempts = 0;
                Logger.success('WebSocket connected');
                resolve();
            });

            STATE.ws.on('close', () => {
                STATE.connected = false;
                STATE.authorized = false;
                Logger.warn('WebSocket disconnected');
                this.handleDisconnect();
            });

            STATE.ws.on('error', (error) => {
                Logger.error(`WebSocket error: ${error.message}`);
                reject(error);
            });

            STATE.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data.toString());
                    this.handleMessage(response);
                } catch (error) {
                    Logger.error(`Failed to parse message: ${error.message}`);
                }
            });
        });
    },

    async handleDisconnect() {
        if (STATE.reconnectAttempts < CONFIG.maxReconnectAttempts) {
            STATE.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, STATE.reconnectAttempts), 30000);
            Logger.info(`Reconnecting in ${delay / 1000}s (attempt ${STATE.reconnectAttempts})...`);

            setTimeout(async () => {
                try {
                    await this.connect();
                    await this.authorize();
                    await this.subscribeAllAssets();
                    Logger.success('Reconnected successfully');
                } catch (error) {
                    Logger.error(`Reconnection failed: ${error.message}`);
                }
            }, delay);
        } else {
            Logger.error('Max reconnection attempts reached. Exiting...');
            process.exit(1);
        }
    },

    send(request) {
        return new Promise((resolve, reject) => {
            if (!STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket not connected'));
                return;
            }

            const reqId = ++this.reqId;
            request.req_id = reqId;

            const timeout = setTimeout(() => {
                this.pendingRequests.delete(reqId);
                reject(new Error('Request timeout'));
            }, 30000);

            this.pendingRequests.set(reqId, { resolve, reject, timeout });
            STATE.ws.send(JSON.stringify(request));
        });
    },

    handleMessage(response) {
        // Handle candle updates
        if (response.msg_type === 'ohlc') {
            const symbol = response.ohlc?.symbol;
            if (symbol && STATE.assets[symbol]) {
                CandleManager.handleCandleUpdate(symbol, response.ohlc);
            }
            return;
        }

        // Handle contract updates - includes live P&L
        if (response.msg_type === 'proposal_open_contract') {
            TradeExecutor.handleContractUpdate(response.proposal_open_contract);
            return;
        }

        // Handle request responses
        const reqId = response.req_id;
        if (reqId && this.pendingRequests.has(reqId)) {
            const { resolve, reject, timeout } = this.pendingRequests.get(reqId);
            clearTimeout(timeout);
            this.pendingRequests.delete(reqId);

            if (response.error) {
                Logger.error(`API Error: ${response.error.message}`);
                reject(new Error(response.error.message));
            } else {
                resolve(response);
            }
        }
    },

    async authorize() {
        Logger.info('Authorizing...');
        const response = await this.send({ authorize: CONFIG.apiToken });

        STATE.authorized = true;
        STATE.balance = response.authorize.balance;
        STATE.currency = response.authorize.currency;
        STATE.accountId = response.authorize.loginid;

        if (CONFIG.investmentCapital > 0) {
            if (CONFIG.investmentCapital > STATE.balance) {
                Logger.warn(`Investment capital (${CONFIG.investmentCapital}) exceeds balance (${STATE.balance}). Using balance.`);
                STATE.investmentCapital = STATE.balance;
            } else {
                STATE.investmentCapital = CONFIG.investmentCapital;
            }
        } else {
            STATE.investmentCapital = STATE.balance;
        }

        STATE.currentCapital = STATE.investmentCapital;

        if (CONFIG.maxDailyLossPercent > 0) {
            STATE.effectiveDailyLossLimit = STATE.investmentCapital * (CONFIG.maxDailyLossPercent / 100);
        } else {
            STATE.effectiveDailyLossLimit = CONFIG.maxDailyLoss;
        }

        Logger.success(`Authorized: ${response.authorize.fullname}`);
        Logger.info(`Account: ${STATE.accountId} (${response.authorize.is_virtual ? 'VIRTUAL' : 'REAL'})`);
        Logger.info(`Account Balance: ${STATE.currency} ${STATE.balance.toFixed(2)}`);
        Logger.info(`Investment Capital: ${STATE.currency} ${STATE.investmentCapital.toFixed(2)}`);
        Logger.info(`Daily Loss Limit: ${STATE.currency} ${STATE.effectiveDailyLossLimit.toFixed(2)} (${CONFIG.maxDailyLossPercent}% of capital)`);

        return response;
    },

    async subscribeCandles(symbol) {
        Logger.info(`Subscribing to ${symbol} candles...`, symbol);

        const response = await this.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: CONFIG.maxCandles,
            end: 'latest',
            granularity: 60,
            style: 'candles',
            subscribe: 1
        });

        if (response.candles && STATE.assets[symbol]) {
            STATE.assets[symbol].candles = response.candles.map(c => ({
                time: c.epoch,
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close)
            }));
            STATE.assets[symbol].subscriptionId = response.subscription?.id;
            Logger.success(`Loaded ${STATE.assets[symbol].candles.length} candles`, symbol);
        }

        return response;
    },

    async subscribeAllAssets() {
        Logger.info(`Subscribing to ${CONFIG.activeAssets.length} assets...`);

        for (const symbol of CONFIG.activeAssets) {
            try {
                await this.subscribeCandles(symbol);
                await new Promise(r => setTimeout(r, 500));
            } catch (error) {
                Logger.error(`Failed to subscribe to ${symbol}: ${error.message}`, symbol);
            }
        }

        Logger.success('All asset subscriptions complete');
    },

    async buyMultiplier(symbol, contractType, stake, multiplier, takeProfit = null, stopLoss = null) {
        const request = {
            buy: 1,
            price: stake,
            parameters: {
                contract_type: contractType,
                symbol: symbol,
                currency: STATE.currency,
                amount: stake,
                basis: 'stake',
                multiplier: multiplier
            }
        };

        if (takeProfit !== null || stopLoss !== null) {
            request.parameters.limit_order = {};
            if (takeProfit !== null) {
                request.parameters.limit_order.take_profit = parseFloat(takeProfit.toFixed(2));
            }
            if (stopLoss !== null) {
                request.parameters.limit_order.stop_loss = parseFloat(stopLoss.toFixed(2));
            }
        }

        Logger.debug(`Buy request: ${JSON.stringify(request)}`);
        return await this.send(request);
    },

    async sellContract(contractId) {
        return await this.send({ sell: contractId, price: 0 });
    },

    async subscribeContract(contractId) {
        return await this.send({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });
    },

    async getBalance() {
        const response = await this.send({ balance: 1, subscribe: 0 });
        STATE.balance = response.balance.balance;
        return STATE.balance;
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: CANDLE MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

const CandleManager = {
    handleCandleUpdate(symbol, ohlc) {
        const asset = STATE.assets[symbol];
        if (!asset) return;

        const candle = {
            time: ohlc.epoch,
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close)
        };

        asset.lastTick = candle.close;
        asset.currentPrice = candle.close;

        if (asset.candles.length === 0) {
            asset.candles.push(candle);
            return;
        }

        const lastCandle = asset.candles[asset.candles.length - 1];

        if (candle.time === lastCandle.time) {
            asset.candles[asset.candles.length - 1] = candle;
        } else if (candle.time > lastCandle.time) {
            asset.candles.push(candle);

            if (asset.candles.length > CONFIG.maxCandles) {
                asset.candles.shift();
            }

            if (asset.lastProcessedTime !== lastCandle.time) {
                asset.lastProcessedTime = lastCandle.time;
                this.onCandleClosed(symbol, lastCandle);
            }
        }
    },

    onCandleClosed(symbol, closedCandle) {
        Logger.debug(`Candle closed: ${closedCandle.close.toFixed(4)}`, symbol);

        this.checkDailyReset();
        this.checkHourlyReset();
        StrategyEngine.analyze(symbol);
    },

    checkDailyReset() {
        const today = new Date().toDateString();
        if (today !== STATE.lastResetDate) {
            Logger.info('New trading day - resetting statistics');

            // Send daily summary before reset
            TelegramNotifier.sendDailySummary();

            STATE.totalDailyPnl = 0;
            STATE.totalTradesToday = 0;
            STATE.globalWins = 0;
            STATE.globalLosses = 0;
            STATE.lastResetDate = today;

            for (const symbol of CONFIG.activeAssets) {
                STATE.assets[symbol].tradesToday = 0;
                STATE.assets[symbol].dailyPnl = 0;
                STATE.assets[symbol].wins = 0;
                STATE.assets[symbol].losses = 0;
            }
        }
    },

    checkHourlyReset() {
        const currentHour = new Date().getHours();
        if (currentHour !== STATE.hourlyStats.lastHour) {
            // Send hourly summary
            TelegramNotifier.sendHourlySummary();
            STATE.hourlyStats.lastHour = currentHour;
        }
    },

    getRecentCandles(symbol, count) {
        return STATE.assets[symbol]?.candles.slice(-count) || [];
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8: SWING DETECTOR
// ═══════════════════════════════════════════════════════════════════════════════

const SwingDetector = {
    findSwingHighs(candles, lookback) {
        const swings = [];
        for (let i = lookback; i < candles.length - lookback; i++) {
            let isSwingHigh = true;
            const currentHigh = candles[i].high;

            for (let j = 1; j <= lookback; j++) {
                if (candles[i - j].high >= currentHigh || candles[i + j].high >= currentHigh) {
                    isSwingHigh = false;
                    break;
                }
            }

            if (isSwingHigh) {
                swings.push({ index: i, time: candles[i].time, price: currentHigh });
            }
        }
        return swings;
    },

    findSwingLows(candles, lookback) {
        const swings = [];
        for (let i = lookback; i < candles.length - lookback; i++) {
            let isSwingLow = true;
            const currentLow = candles[i].low;

            for (let j = 1; j <= lookback; j++) {
                if (candles[i - j].low <= currentLow || candles[i + j].low <= currentLow) {
                    isSwingLow = false;
                    break;
                }
            }

            if (isSwingLow) {
                swings.push({ index: i, time: candles[i].time, price: currentLow });
            }
        }
        return swings;
    },

    determineTrend(swingHighs, swingLows, minSwings) {
        if (swingHighs.length < minSwings || swingLows.length < minSwings) {
            return null;
        }

        const recentHighs = swingHighs.slice(-minSwings);
        const recentLows = swingLows.slice(-minSwings);

        let higherHighs = true, higherLows = true;
        for (let i = 1; i < recentHighs.length; i++) {
            if (recentHighs[i].price <= recentHighs[i - 1].price) higherHighs = false;
        }
        for (let i = 1; i < recentLows.length; i++) {
            if (recentLows[i].price <= recentLows[i - 1].price) higherLows = false;
        }
        if (higherHighs && higherLows) return 'up';

        let lowerHighs = true, lowerLows = true;
        for (let i = 1; i < recentHighs.length; i++) {
            if (recentHighs[i].price >= recentHighs[i - 1].price) lowerHighs = false;
        }
        for (let i = 1; i < recentLows.length; i++) {
            if (recentLows[i].price >= recentLows[i - 1].price) lowerLows = false;
        }
        if (lowerHighs && lowerLows) return 'down';

        return null;
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9: FIBONACCI CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════════

const FibCalculator = {
    calculate(start, end) {
        const range = end - start;
        return {
            start, end,
            range: Math.abs(range),
            levels: {
                '0.0': end,
                '0.236': end - (range * 0.236),
                '0.382': end - (range * 0.382),
                '0.5': end - (range * 0.5),
                '0.618': end - (range * 0.618),
                '0.786': end - (range * 0.786),
                '1.0': start
            }
        };
    },

    isInGoldenZone(price, fibLevels) {
        const upperLevel = fibLevels.levels[CONFIG.fibLowerZone.toString()];
        const lowerLevel = fibLevels.levels[CONFIG.fibUpperZone.toString()];
        const zoneTop = Math.max(upperLevel, lowerLevel);
        const zoneBottom = Math.min(upperLevel, lowerLevel);
        return price >= zoneBottom && price <= zoneTop;
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10: STRATEGY ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

const StrategyEngine = {
    analyze(symbol) {
        const asset = STATE.assets[symbol];
        if (!asset) return;

        if (asset.activeContract) {
            return;
        }

        const candles = CandleManager.getRecentCandles(symbol, 100);
        if (candles.length < 50) {
            Logger.debug('Insufficient candles', symbol);
            return;
        }

        const assetConfig = asset.config;
        const lookback = assetConfig.swingLookback || 5;

        asset.swingHighs = SwingDetector.findSwingHighs(candles, lookback);
        asset.swingLows = SwingDetector.findSwingLows(candles, lookback);

        const previousTrend = asset.currentTrend;
        asset.currentTrend = SwingDetector.determineTrend(
            asset.swingHighs, asset.swingLows, CONFIG.minTrendSwings
        );

        if (asset.currentTrend !== previousTrend && asset.currentTrend) {
            Logger.signal(`Trend: ${asset.currentTrend.toUpperCase()}`, symbol);
        }

        if (!asset.currentTrend) {
            asset.bosDetected = false;
            asset.fibLevels = null;
            return;
        }

        const lastCandle = candles[candles.length - 1];
        this.detectBoS(symbol, lastCandle);

        if (asset.bosDetected && asset.fibLevels) {
            const currentPrice = lastCandle.close;
            const inGoldenZone = FibCalculator.isInGoldenZone(currentPrice, asset.fibLevels);

            // if (inGoldenZone && this.checkConfirmation(asset, lastCandle)) {
            if (this.checkConfirmation(asset, lastCandle)) {
                const signal = this.generateSignal(symbol, lastCandle);

                if (signal && RiskManager.canTrade(symbol)) {
                    Logger.signal(`Entry: ${signal.direction} @ ${signal.entry.toFixed(4)}`, symbol);
                    TradeExecutor.executeSignal(symbol, signal);
                }
            }
        }
    },

    detectBoS(symbol, lastCandle) {
        const asset = STATE.assets[symbol];
        const recentHighs = asset.swingHighs.slice(-3);
        const recentLows = asset.swingLows.slice(-3);

        if (asset.currentTrend === 'up' && recentHighs.length >= 2) {
            const lastSwingHigh = recentHighs[recentHighs.length - 2];
            if (lastCandle.close > lastSwingHigh.price && !asset.bosDetected) {
                asset.bosDetected = true;
                Logger.signal(`BoS UP - Broke ${lastSwingHigh.price.toFixed(4)}`, symbol);

                const lastSwingLow = recentLows[recentLows.length - 1];
                if (lastSwingLow) {
                    asset.impulseStart = lastSwingLow.price;
                    asset.impulseEnd = lastCandle.high;
                    asset.fibLevels = FibCalculator.calculate(asset.impulseStart, asset.impulseEnd);
                }
            }
        } else if (asset.currentTrend === 'down' && recentLows.length >= 2) {
            const lastSwingLow = recentLows[recentLows.length - 2];
            if (lastCandle.close < lastSwingLow.price && !asset.bosDetected) {
                asset.bosDetected = true;
                Logger.signal(`BoS DOWN - Broke ${lastSwingLow.price.toFixed(4)}`, symbol);

                const lastSwingHigh = recentHighs[recentHighs.length - 1];
                if (lastSwingHigh) {
                    asset.impulseStart = lastSwingHigh.price;
                    asset.impulseEnd = lastCandle.low;
                    asset.fibLevels = FibCalculator.calculate(asset.impulseStart, asset.impulseEnd);
                }
            }
        }
    },

    checkConfirmation(asset, candle) {
        if (asset.currentTrend === 'up') {
            return candle.close > candle.open;
        } else {
            return candle.close < candle.open;
        }
    },

    generateSignal(symbol, currentCandle) {
        const asset = STATE.assets[symbol];
        if (!asset.fibLevels) return null;

        const entryPrice = currentCandle.close;
        const rrRatio = asset.config.rrRatio || 1.5;
        const minImpulse = asset.config.minImpulsePercent || 0.0005;

        if (asset.currentTrend === 'up') {
            const stopLoss = asset.fibLevels.levels['0.786'];
            const riskAmount = entryPrice - stopLoss;
            const takeProfit = entryPrice + (riskAmount * rrRatio);

            if ((riskAmount / entryPrice) < minImpulse) return null;

            return {
                direction: 'MULTUP',
                entry: entryPrice,
                stopLoss, takeProfit,
                riskPips: riskAmount
            };
        } else {
            const stopLoss = asset.fibLevels.levels['0.786'];
            const riskAmount = stopLoss - entryPrice;
            const takeProfit = entryPrice - (riskAmount * rrRatio);

            if ((riskAmount / entryPrice) < minImpulse) return null;

            return {
                direction: 'MULTDOWN',
                entry: entryPrice,
                stopLoss, takeProfit,
                riskPips: riskAmount
            };
        }
    },

    reset(symbol) {
        const asset = STATE.assets[symbol];
        if (asset) {
            asset.bosDetected = false;
            asset.fibLevels = null;
            asset.waitingForEntry = false;
        }
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11: RISK MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

const RiskManager = {
    canTrade(symbol) {
        const asset = STATE.assets[symbol];
        const assetConfig = asset.config;

        if (STATE.currentCapital <= 0) {
            Logger.warn('Investment capital depleted', symbol);
            return false;
        }

        if (STATE.totalDailyPnl <= -STATE.effectiveDailyLossLimit) {
            Logger.warn(`Daily loss limit reached (${STATE.currency} ${STATE.effectiveDailyLossLimit.toFixed(2)})`, symbol);
            return false;
        }

        if (STATE.totalOpenPositions >= CONFIG.maxTotalOpenPositions) {
            Logger.warn(`Max open positions (${CONFIG.maxTotalOpenPositions}) reached`, symbol);
            return false;
        }

        if (STATE.consecutiveLosses >= CONFIG.maxConsecutiveLosses && STATE.lastLossTime) {
            const cooldownEnd = new Date(STATE.lastLossTime.getTime() + (CONFIG.cooldownMinutes * 60000));
            if (new Date() < cooldownEnd) {
                const remaining = Math.ceil((cooldownEnd - new Date()) / 60000);
                Logger.warn(`Cooldown: ${remaining} min remaining`, symbol);
                return false;
            } else {
                STATE.consecutiveLosses = 0;
            }
        }

        if (asset.tradesToday >= assetConfig.maxTradesPerDay) {
            Logger.warn('Asset daily trade limit reached', symbol);
            return false;
        }

        if (assetConfig.tradingHours !== '24/7') {
            if (!this.isWithinTradingHours(assetConfig.tradingHours)) {
                Logger.debug('Outside trading hours', symbol);
                return false;
            }
        }

        return true;
    },

    isWithinTradingHours(hoursString) {
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

        // Update hourly stats
        STATE.hourlyStats.trades++;
        STATE.hourlyStats.pnl += pnl;
        if (isWin) {
            STATE.hourlyStats.wins++;
            STATE.globalWins++;
            STATE.consecutiveWins++;
            STATE.consecutiveLosses = 0;
        } else {
            STATE.hourlyStats.losses++;
            STATE.globalLosses++;
            STATE.consecutiveLosses++;
            STATE.consecutiveWins = 0;
            STATE.lastLossTime = new Date();
        }

        const capitalChange = ((STATE.currentCapital - STATE.investmentCapital) / STATE.investmentCapital * 100).toFixed(2);
        Logger.info(`Capital: ${STATE.currency} ${STATE.currentCapital.toFixed(2)} (${capitalChange >= 0 ? '+' : ''}${capitalChange}%)`);

        if (STATE.totalTradesToday % 5 === 0) {
            Logger.globalStats();
            Logger.printAssetTable();
        }
    },

    getStake(symbol) {
        const config = ASSET_CONFIGS[symbol];
        return Math.max(config.minStake, Math.min(CONFIG.defaultStake, config.maxStake));
    },

    getMultiplier(symbol) {
        const config = ASSET_CONFIGS[symbol];
        return config.defaultMultiplier;
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12: TRADE EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════════

const TradeExecutor = {
    async executeSignal(symbol, signal) {
        const asset = STATE.assets[symbol];

        try {
            const stake = RiskManager.getStake(symbol);
            const multiplier = RiskManager.getMultiplier(symbol);
            const rrRatio = asset.config.rrRatio || 1.5;

            Logger.trade(`Opening ${signal.direction} | Stake: $${stake} | Mult: ${multiplier}x`, symbol);

            const slAmount = stake;
            const tpAmount = stake * rrRatio;

            const response = await DerivAPI.buyMultiplier(
                symbol,
                signal.direction,
                stake,
                multiplier,
                tpAmount,
                slAmount
            );

            if (response.buy) {
                asset.activeContract = response.buy.contract_id;
                asset.contractId = response.buy.contract_id;
                asset.entryPrice = signal.entry;
                asset.direction = signal.direction;
                asset.takeProfitPrice = signal.takeProfit;
                asset.stopLossPrice = signal.stopLoss;
                asset.stake = stake;
                asset.multiplier = multiplier;
                asset.unrealizedPnl = 0;

                STATE.totalOpenPositions++;

                Logger.success(`Trade opened: ID ${asset.activeContract}`, symbol);

                // Send Telegram notification
                await TelegramNotifier.sendTradeOpened(symbol, signal.direction, stake, multiplier, signal.entry);

                const subResponse = await DerivAPI.subscribeContract(asset.activeContract);
                asset.contractSubscriptionId = subResponse.subscription?.id;

                asset.tradeHistory.push({
                    id: asset.activeContract,
                    openTime: new Date(),
                    direction: signal.direction,
                    entry: signal.entry,
                    stake, multiplier,
                    status: 'open'
                });

                // Update display
                Logger.printAssetTable();
            }
        } catch (error) {
            Logger.error(`Trade execution failed: ${error.message}`, symbol);
        }
    },

    handleContractUpdate(contract) {
        if (!contract) return;

        let assetSymbol = null;
        for (const symbol of CONFIG.activeAssets) {
            if (STATE.assets[symbol].activeContract === contract.contract_id) {
                assetSymbol = symbol;
                break;
            }
        }

        if (!assetSymbol) return;

        const asset = STATE.assets[assetSymbol];

        // Update live P&L
        if (contract.profit !== undefined) {
            asset.unrealizedPnl = contract.profit;
            asset.currentPrice = contract.current_spot;
        }

        if (contract.is_sold || contract.status === 'sold') {
            this.onContractClosed(assetSymbol, contract);
        }
    },

    async onContractClosed(symbol, contract) {
        const asset = STATE.assets[symbol];
        const pnl = contract.profit || 0;
        const isWin = pnl > 0;

        Logger.trade(`${isWin ? '✅ WIN' : '❌ LOSS'} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, symbol);

        // Send Telegram notification
        await TelegramNotifier.sendTradeClosed(symbol, asset.direction, pnl, isWin);

        const trade = asset.tradeHistory.find(t => t.id === asset.activeContract);
        if (trade) {
            trade.closeTime = new Date();
            trade.pnl = pnl;
            trade.status = isWin ? 'win' : 'loss';
        }

        RiskManager.recordTrade(symbol, pnl, isWin);

        // Reset asset state
        asset.activeContract = null;
        asset.contractId = null;
        asset.entryPrice = null;
        asset.direction = null;
        asset.takeProfitPrice = null;
        asset.stopLossPrice = null;
        asset.contractSubscriptionId = null;
        asset.stake = 0;
        asset.multiplier = 0;
        asset.unrealizedPnl = 0;
        STATE.totalOpenPositions--;

        StrategyEngine.reset(symbol);

        // Update display
        Logger.printAssetTable();
    },

    async closePosition(symbol, reason = 'manual') {
        const asset = STATE.assets[symbol];
        if (!asset.activeContract) return;

        try {
            Logger.trade(`Closing position: ${reason}`, symbol);
            await DerivAPI.sellContract(asset.activeContract);
        } catch (error) {
            Logger.error(`Failed to close: ${error.message}`, symbol);
        }
    },

    async closeAllPositions(reason = 'shutdown') {
        for (const symbol of CONFIG.activeAssets) {
            if (STATE.assets[symbol].activeContract) {
                await this.closePosition(symbol, reason);
            }
        }
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 13: MAIN APPLICATION
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    Logger.banner();
    validateConfig();
    initializeAssetStates();
    Logger.printAssetTable();

    setupShutdownHandlers();
    setupHourlySummaryTimer();

    try {
        await DerivAPI.connect();
        await DerivAPI.authorize();
        await DerivAPI.subscribeAllAssets();

        // Send startup notification
        await TelegramNotifier.sendStartup();

        Logger.globalStats();
        Logger.success('Bot is running. Monitoring all assets for signals...');
        Logger.info('Press Ctrl+C for graceful shutdown\n');

        // Periodic stats display
        setInterval(() => {
            if (STATE.totalTradesToday > 0 || STATE.totalOpenPositions > 0) {
                Logger.globalStats();
                Logger.printAssetTable();
            }
        }, 30000);

        // Live position update display (every 10 seconds if positions open)
        setInterval(() => {
            if (STATE.totalOpenPositions > 0) {
                Logger.printAssetTable();
            }
        }, 10000);

        process.stdin.resume();

    } catch (error) {
        Logger.error(`Startup failed: ${error.message}`);
        process.exit(1);
    }
}

function setupHourlySummaryTimer() {
    // Calculate time until next hour
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1);
    nextHour.setMinutes(0);
    nextHour.setSeconds(0);
    nextHour.setMilliseconds(0);

    const timeUntilNextHour = nextHour.getTime() - now.getTime();

    // Set timeout for first hourly summary, then set interval
    setTimeout(() => {
        TelegramNotifier.sendHourlySummary();

        // Then run every hour
        setInterval(() => {
            TelegramNotifier.sendHourlySummary();
        }, 60 * 60 * 1000);
    }, timeUntilNextHour);

    Logger.info(`Hourly summaries scheduled. First in ${Math.ceil(timeUntilNextHour / 60000)} minutes.`);
}

function setupShutdownHandlers() {
    const shutdown = async (signal) => {
        Logger.warn(`\nReceived ${signal}. Shutting down...`);

        if (STATE.totalOpenPositions > 0) {
            Logger.warn('Closing all open positions...');
            await TradeExecutor.closeAllPositions('shutdown');
        }

        // Send shutdown notification
        await TelegramNotifier.sendShutdown();

        if (STATE.ws) STATE.ws.close();

        Logger.globalStats();
        Logger.info('Goodbye!');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (error) => {
        Logger.error(`Uncaught exception: ${error.message}`);
        shutdown('uncaughtException');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

main();
