#!/usr/bin/env node

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  DERIV MULTI-ASSET FIBONACCI SCALPER BOT v2.1 - Node.js Edition              ║
 * ║  Implements 1-minute Fibonacci Scalping Strategy on Multiple Assets          ║
 * ║                                                                               ║
 * ║  Based on: https://youtu.be/AlsXNhTm4AA                                       ║
 * ║                                                                               ║
 * ║  v2.1 MAJOR FIXES (Continuous Trading):                                       ║
 * ║  - Fixed BoS detection to work continuously (track last BoS price)           ║
 * ║  - Added persistent trend mode - no need to wait for new BoS each time       ║
 * ║  - Fixed contract ID type comparison (string vs number)                       ║
 * ║  - Extended golden zone to 0.382-0.65 for more entries                        ║
 * ║  - Added 5-minute strategy diagnostics to see why bot isn't trading          ║
 * ║  - Dynamic Fibonacci recalculation on new swings                              ║
 * ║  - Removed aggressive setup invalidation                                      ║
 * ║  - Added trade entry tracking to prevent duplicate entries                    ║
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
        minImpulsePercent: 0.0002,  // Reduced for more signals
        rrRatio: 1.5,
        fibExpiryCandles: 20  // Extended expiry
    },
    'R_100': {
        name: 'Volatility 100',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [40, 100, 200, 300, 400],
        defaultMultiplier: 200,
        maxTradesPerDay: 50,
        minStake: 1.00,
        maxStake: 3000,
        tradingHours: '24/7',
        swingLookback: 5,
        minImpulsePercent: 0.0003,
        rrRatio: 1.5,
        fibExpiryCandles: 20
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
        minImpulsePercent: 0.0001,
        rrRatio: 1.3,
        fibExpiryCandles: 15
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
        minImpulsePercent: 0.0002,
        rrRatio: 1.4,
        fibExpiryCandles: 15
    },
    '1HZ100V': {
        name: 'Volatility 100 (1s)',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [40, 100, 200, 300, 400],
        defaultMultiplier: 200,
        maxTradesPerDay: 120,
        minStake: 1.00,
        maxStake: 1000,
        tradingHours: '24/7',
        swingLookback: 4,
        minImpulsePercent: 0.0003,
        rrRatio: 1.4,
        fibExpiryCandles: 15
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
        minImpulsePercent: 0.00005,
        rrRatio: 1.2,
        fibExpiryCandles: 20
    },
    // 'frxXAUUSD': {
    //     name: 'Gold/USD',
    //     category: 'commodity',
    //     contractType: 'multiplier',
    //     multipliers: [50, 100, 200, 300, 400, 500],
    //     defaultMultiplier: 500,
    //     maxTradesPerDay: 5,
    //     minStake: 5,
    //     maxStake: 5000,
    //     tradingHours: 'Sun 23:00 - Fri 21:55 GMT',
    //     swingLookback: 5,
    //     minImpulsePercent: 0.0005,
    //     rrRatio: 1.5,
    //     fibExpiryCandles: 25
    // }
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

    // Strategy defaults - WIDENED for more entries
    minTrendSwings: 2,
    fibUpperZone: 0.618,   // Extended from 0.618
    fibLowerZone: 0.5, // Extended from 0.5

    // Signal cooldown (seconds) - reduced for more trades
    signalCooldownSeconds: 5,

    // Entry cooldown after trade closes (seconds)
    postTradeCooldown: 5,

    // Require candle confirmation (can disable for more entries)
    requireConfirmation: true,  // Default OFF now

    // Global risk management
    maxDailyLossPercent: 50,
    maxDailyLoss: 50,
    maxTotalOpenPositions: 7,
    maxConsecutiveLosses: 50,
    cooldownMinutes: 1,

    // Telegram settings
    telegram: {
        enabled: true,
        botToken: '8240090224:AAEvCwqEujSdfYjs8jY7tMx1vCI995T1-Oc',
        chatId: '752497117',
        sendTradeAlerts: true,
        sendHourlySummary: true,
        sendDailySummary: true
    },

    // Candle buffer
    maxCandles: 300,

    // Reconnection
    maxReconnectAttempts: 5,

    // Strategy diagnostics interval (ms)
    diagnosticsInterval: 30000  // 5 minutes
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
    Logger.info(`Golden Zone: ${CONFIG.fibLowerZone} - ${CONFIG.fibUpperZone}`);
    Logger.info(`Signal Cooldown: ${CONFIG.signalCooldownSeconds}s | Confirmation: ${CONFIG.requireConfirmation ? 'ON' : 'OFF'}`);
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
    lastResetDate: new Date().toDateString(),
    lastDiagnosticsTime: 0
};

// Asset state factory - ENHANCED with continuous trading support
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
        lastHealthCheckError: null,

        // Strategy state - ENHANCED for continuous trading
        swingHighs: [],
        swingLows: [],
        currentTrend: null,
        previousTrend: null,
        trendStartTime: null,

        // BoS tracking - NEW: Track last BoS level for continuous detection
        bosDetected: false,
        bosTime: null,
        bosCandle: null,
        lastBosPrice: null,      // NEW: Last price where BoS was detected
        lastBosSwingPrice: null, // NEW: Track which swing was broken
        bosDirection: null,       // NEW: 'up' or 'down'

        // Fibonacci state
        impulseStart: null,
        impulseEnd: null,
        fibLevels: null,
        fibSetupTime: null,
        fibCandleCount: 0,
        lastFibUpdateTime: null,  // NEW: Track when Fib was last updated

        // Entry tracking - NEW: Prevent duplicate entries
        lastEntryPrice: null,
        lastEntryTime: null,
        lastTradeCloseTime: null,
        entriesThisSetup: 0,

        // Signal cooldown tracking
        lastSignalTime: null,
        signalsGenerated: 0,

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

        // Live position data
        currentPrice: null,
        unrealizedPnl: 0,

        // Per-asset stats
        tradesToday: 0,
        dailyPnl: 0,
        wins: 0,
        losses: 0,

        // Diagnostics
        lastAnalysisResult: null,
        analysisCount: 0,

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
// SECTION 3.5: PERSISTENT STATE MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const StateManager = {
    stateFile: path.join(__dirname, 'fibo-scalper3-state.json'),
    lastSaveTime: 0,
    saveThrottleMs: 5000, // Only save once every 5 seconds
    pendingSave: false,

    saveState() {
        const now = Date.now();

        // Throttle saves to prevent excessive disk I/O
        if (now - this.lastSaveTime < this.saveThrottleMs) {
            // Schedule a save if one isn't already pending
            if (!this.pendingSave) {
                this.pendingSave = true;
                setTimeout(() => {
                    this.pendingSave = false;
                    this.saveStateNow();
                }, this.saveThrottleMs - (now - this.lastSaveTime));
            }
            return;
        }

        this.saveStateNow();
    },

    saveStateNow() {
        try {
            const state = {
                balance: STATE.balance,
                investmentCapital: STATE.investmentCapital,
                currentCapital: STATE.currentCapital,
                totalDailyPnl: STATE.totalDailyPnl,
                totalTradesToday: STATE.totalTradesToday,
                globalWins: STATE.globalWins,
                globalLosses: STATE.globalLosses,
                consecutiveLosses: STATE.consecutiveLosses,
                consecutiveWins: STATE.consecutiveWins,
                lastResetDate: STATE.lastResetDate,

                // Save active positions
                activePositions: CONFIG.activeAssets.map(symbol => {
                    const asset = STATE.assets[symbol];
                    if (asset.activeContract) {
                        return {
                            symbol,
                            contractId: asset.contractId,
                            direction: asset.direction,
                            entryPrice: asset.entryPrice,
                            stake: asset.stake,
                            multiplier: asset.multiplier,
                            takeProfitPrice: asset.takeProfitPrice,
                            stopLossPrice: asset.stopLossPrice,
                            lastKnownPnl: asset.unrealizedPnl,
                            openTime: asset.tradeHistory.find(t => t.id === asset.contractId)?.openTime
                        };
                    }
                    return null;
                }).filter(Boolean),

                // Save per-asset stats
                assetStats: CONFIG.activeAssets.reduce((acc, symbol) => {
                    const asset = STATE.assets[symbol];
                    acc[symbol] = {
                        tradesToday: asset.tradesToday,
                        dailyPnl: asset.dailyPnl,
                        wins: asset.wins,
                        losses: asset.losses
                    };
                    return acc;
                }, {})
            };

            fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
            this.lastSaveTime = Date.now();
            // Logger.debug('State saved to disk');
        } catch (error) {
            Logger.error(`Failed to save state: ${error.message}`);
        }
    },

    loadState() {
        try {
            if (!fs.existsSync(this.stateFile)) {
                Logger.info('No previous state found - starting fresh');
                return false;
            }

            const data = fs.readFileSync(this.stateFile, 'utf8');
            const savedState = JSON.parse(data);

            // Check if it's from today
            if (savedState.lastResetDate !== new Date().toDateString()) {
                Logger.info('Previous state is from a different day - starting fresh');
                fs.unlinkSync(this.stateFile);
                return false;
            }

            // Restore global state
            STATE.investmentCapital = savedState.investmentCapital || STATE.investmentCapital;
            STATE.currentCapital = savedState.currentCapital || STATE.currentCapital;
            STATE.totalDailyPnl = savedState.totalDailyPnl || 0;
            STATE.totalTradesToday = savedState.totalTradesToday || 0;
            STATE.globalWins = savedState.globalWins || 0;
            STATE.globalLosses = savedState.globalLosses || 0;
            STATE.consecutiveLosses = savedState.consecutiveLosses || 0;
            STATE.consecutiveWins = savedState.consecutiveWins || 0;

            // Restore per-asset stats
            if (savedState.assetStats) {
                for (const symbol of CONFIG.activeAssets) {
                    const stats = savedState.assetStats[symbol];
                    if (stats) {
                        STATE.assets[symbol].tradesToday = stats.tradesToday;
                        STATE.assets[symbol].dailyPnl = stats.dailyPnl;
                        STATE.assets[symbol].wins = stats.wins;
                        STATE.assets[symbol].losses = stats.losses;
                    }
                }
            }

            Logger.success('Previous state restored successfully');
            Logger.info(`Restored: P&L=$${STATE.totalDailyPnl.toFixed(2)}, Trades=${STATE.totalTradesToday}, W/L=${STATE.globalWins}/${STATE.globalLosses}`);

            return savedState.activePositions || [];

        } catch (error) {
            Logger.error(`Failed to load state: ${error.message}`);
            return false;
        }
    },

    clearState() {
        try {
            if (fs.existsSync(this.stateFile)) {
                fs.unlinkSync(this.stateFile);
                Logger.info('State file cleared');
            }
        } catch (error) {
            Logger.error(`Failed to clear state: ${error.message}`);
        }
    }
};

// Auto-save state every 30 seconds
setInterval(() => {
    if (STATE.connected && STATE.authorized) {
        StateManager.saveStateNow(); // Force save on interval
    }
}, 30000);

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
🔔 Trade Opened Bot 3

📊 ${symbol} - ${ASSET_CONFIGS[symbol]?.name || symbol}
${dirEmoji}

💰 Stake: $${stake.toFixed(2)}
📈 Multiplier: ${multiplier}x
📍 Entry: ${entry.toFixed(4)}

⏰ ${new Date().toLocaleTimeString()}
        `.trim();

        try {
            await this.send(message);
        } catch (error) {
            Logger.debug(`Telegram send failed: ${error.message}`);
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
${pnlColor} P&L Bot: ${pnlStr}

📈 Daily P&L Bot: ${(STATE.totalDailyPnl >= 0 ? '+' : '')}$${STATE.totalDailyPnl.toFixed(2)}
🎯 Win Rate Bot: ${STATE.globalWins + STATE.globalLosses > 0 ? ((STATE.globalWins / (STATE.globalWins + STATE.globalLosses)) * 100).toFixed(1) : 0}%
📊 Trades Today Bot: ${STATE.totalTradesToday}

⏰ ${new Date().toLocaleTimeString()}
        `.trim();

        try {
            await this.send(message);
        } catch (error) {
            Logger.debug(`Telegram send failed: ${error.message}`);
        }
    },

    async sendHourlySummary() {
        if (!CONFIG.telegram.sendHourlySummary) return;

        const stats = STATE.hourlyStats;
        const winRate = stats.wins + stats.losses > 0
            ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1)
            : 0;
        const pnlEmoji = stats.pnl >= 0 ? '🟢' : '🔴';
        const pnlStr = (stats.pnl >= 0 ? '+' : '') + '$' + stats.pnl.toFixed(2);

        let assetBreakdown = '';
        for (const symbol of CONFIG.activeAssets) {
            const asset = STATE.assets[symbol];
            if (asset.tradesToday > 0) {
                const assetPnl = (asset.dailyPnl >= 0 ? '+' : '') + '$' + asset.dailyPnl.toFixed(2);
                assetBreakdown += `  • ${symbol}: ${assetPnl} (${asset.wins}W/${asset.losses}L)\n`;
            }
        }

        const message = `
⏰ Hourly Trade Summary Bot 3

📊 Last Hour Bot
├ Trades: ${stats.trades}
├ Wins: ${stats.wins} | Losses: ${stats.losses}
├ Win Rate: ${winRate}%
└ ${pnlEmoji} P&L: ${pnlStr}

📈 Daily Totals Bot
├ Total Trades: ${STATE.totalTradesToday}
├ Total W/L: ${STATE.globalWins}/${STATE.globalLosses}
├ Daily P&L: ${(STATE.totalDailyPnl >= 0 ? '+' : '')}$${STATE.totalDailyPnl.toFixed(2)}
└ Capital: $${STATE.currentCapital.toFixed(2)}

${assetBreakdown ? 'Per Asset:\n' + assetBreakdown : ''}
⏰ ${new Date().toLocaleString()}
        `.trim();

        try {
            await this.send(message);
            Logger.info('📱 Telegram: Hourly Summary sent');
        } catch (error) {
            Logger.debug(`Telegram hourly summary failed: ${error.message}`);
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

        let assetTable = '';
        for (const symbol of CONFIG.activeAssets) {
            const asset = STATE.assets[symbol];
            const pnl = (asset.dailyPnl >= 0 ? '+' : '') + '$' + asset.dailyPnl.toFixed(2);
            assetTable += `  ${symbol}: ${pnl} | ${asset.wins}W/${asset.losses}L\n`;
        }

        const message = `
📊 Daily Trading Summary Bot 3

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
            Logger.info('📱 Telegram: Daily Summary sent');
        } catch (error) {
            Logger.debug(`Telegram daily summary failed: ${error.message}`);
        }
    },

    async sendStartup() {
        if (!CONFIG.telegram.enabled) return;

        const message = `
🚀 Bot 3 Started (v2.1 - Continuous Trading)

📊 Trading ${CONFIG.activeAssets.length} assets:
${CONFIG.activeAssets.map(s => `  • ${s}`).join('\n')}

💰 Investment Capital: $${CONFIG.investmentCapital || 'Account Balance'}
📈 Max Positions: ${CONFIG.maxTotalOpenPositions}
🛡️ Daily Loss Limit: ${CONFIG.maxDailyLossPercent}%
🎯 Golden Zone: ${CONFIG.fibLowerZone}-${CONFIG.fibUpperZone}
⏱️ Signal Cooldown: ${CONFIG.signalCooldownSeconds}s

⏰ ${new Date().toLocaleString()}
        `.trim();

        try {
            await this.send(message);
            Logger.success('📱 Telegram: Startup notification sent');
        } catch (error) {
            Logger.debug(`Telegram startup failed: ${error.message}`);
        }
    },

    async sendShutdown() {
        if (!CONFIG.telegram.enabled) return;

        await this.sendDailySummary();

        const message = `
🛑 Bot 3 Stopped

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
        '1HZ100V': '\x1b[96m',
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
        // if (process.env.DEBUG === 'true') {
        console.log(this.format('DEBUG', this.colors.dim, message, symbol));
        // }
    },

    strategy(message, symbol = null) {
        // if (process.env.DEBUG === 'true' || process.env.STRATEGY_DEBUG === 'true') {
        console.log(this.format('STRAT', this.colors.cyan + this.colors.dim, message, symbol));
        // }
    },

    banner() {
        console.log('\n' + this.colors.cyan + '═'.repeat(80) + this.colors.reset);
        console.log(this.colors.bright + this.colors.cyan +
            '   DERIV MULTI-ASSET FIBONACCI SCALPER BOT v2.1 (CONTINUOUS TRADING FIX)' + this.colors.reset);
        console.log(this.colors.dim + '   Trading ' + CONFIG.activeAssets.length +
            ' assets | Telegram: ' + (CONFIG.telegram.enabled ? 'ON' : 'OFF') +
            ' | Zone: ' + CONFIG.fibLowerZone + '-' + CONFIG.fibUpperZone + this.colors.reset);
        console.log(this.colors.cyan + '═'.repeat(80) + this.colors.reset + '\n');
    },

    printAssetTable() {
        console.log('\n' + this.colors.yellow + '┌─ Active Assets ─────────────────────────────────────────────────────────────────────────────────┐' + this.colors.reset);
        console.log('│  Symbol      │ Name                    │ Direction │ Entry      │ Live P&L   │ Status       │');
        console.log('├──────────────┼─────────────────────────┼───────────┼────────────┼────────────┼──────────────┤');

        for (const symbol of CONFIG.activeAssets) {
            const cfg = ASSET_CONFIGS[symbol];
            const asset = STATE.assets[symbol];
            const sym = symbol.padEnd(12);
            const name = cfg.name.substring(0, 23).padEnd(23);

            let direction = '⚪ -      ';
            let entry = '-         ';
            let livePnl = '-         ';
            let status = 'SCANNING   ';
            let statusColor = this.colors.dim;

            if (asset?.activeContract) {
                if (asset.direction === 'MULTUP') {
                    direction = this.colors.green + '🟢 BUY    ' + this.colors.reset;
                } else if (asset.direction === 'MULTDOWN') {
                    direction = this.colors.red + '🔴 SELL   ' + this.colors.reset;
                }

                entry = asset.entryPrice ? asset.entryPrice.toFixed(2).substring(0, 10).padEnd(10) : '-         ';

                const pnl = asset.unrealizedPnl || 0;
                const pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
                if (pnl >= 0) {
                    livePnl = this.colors.green + pnlStr.padEnd(10) + this.colors.reset;
                } else {
                    livePnl = this.colors.red + pnlStr.padEnd(10) + this.colors.reset;
                }

                status = 'TRADING    ';
                statusColor = this.colors.green;
            } else if (asset?.currentTrend && asset?.fibLevels) {
                const trend = asset.currentTrend === 'up' ? '📈' : '📉';
                status = `${trend} READY     `;
                statusColor = this.colors.cyan;
            } else if (asset?.currentTrend) {
                const trend = asset.currentTrend === 'up' ? '↑' : '↓';
                status = `${trend} TREND     `;
                statusColor = this.colors.blue;
            }

            console.log(`│  ${this.assetColors[symbol] || ''}${sym}${this.colors.reset} │ ${name} │ ${direction} │ ${entry} │ ${livePnl} │ ${statusColor}${status}${this.colors.reset} │`);
        }
        console.log(this.colors.yellow + '└─────────────────────────────────────────────────────────────────────────────────────────────────┘' + this.colors.reset);
    },

    // NEW: Print strategy diagnostics for each asset
    printDiagnostics() {
        console.log('\n' + this.colors.magenta + '┌─ Strategy Diagnostics ──────────────────────────────────────────────────────────────────────────┐' + this.colors.reset);
        console.log('│  Symbol      │ Trend  │ Swings(H/L) │ BoS    │ Fib Zone           │ Blocker              │');
        console.log('├──────────────┼────────┼─────────────┼────────┼────────────────────┼──────────────────────┤');

        for (const symbol of CONFIG.activeAssets) {
            const asset = STATE.assets[symbol];
            const sym = symbol.padEnd(12);

            const trend = asset.currentTrend ? (asset.currentTrend === 'up' ? '↑ UP  ' : '↓ DOWN') : '- NONE';
            const swings = `${asset.swingHighs.length}/${asset.swingLows.length}`.padEnd(11);
            const bos = asset.bosDetected ? '✓ YES ' : '✗ NO  ';

            let fibZone = '-                  ';
            if (asset.fibLevels) {
                const fib50 = asset.fibLevels.levels['0.5'].toFixed(2);
                const fib618 = asset.fibLevels.levels['0.618'].toFixed(2);
                fibZone = `${fib50}-${fib618}`.substring(0, 18).padEnd(18);
            }

            let blocker = asset.lastAnalysisResult || 'None';
            blocker = blocker.substring(0, 20).padEnd(20);

            console.log(`│  ${this.assetColors[symbol] || ''}${sym}${this.colors.reset} │ ${trend} │ ${swings} │ ${bos} │ ${fibZone} │ ${blocker} │`);
        }
        console.log(this.colors.magenta + '└──────────────────────────────────────────────────────────────────────────────────────────────────┘' + this.colors.reset + '\n');
    },

    globalStats() {
        const winRate = (STATE.globalWins + STATE.globalLosses) > 0
            ? ((STATE.globalWins / (STATE.globalWins + STATE.globalLosses)) * 100).toFixed(1)
            : 0;

        const capitalReturn = STATE.investmentCapital > 0
            ? ((STATE.currentCapital - STATE.investmentCapital) / STATE.investmentCapital * 100).toFixed(2)
            : 0;

        console.log('\n' + this.colors.green + '┌─ Global Statistics ──────────────────────────────────────────────────┐' + this.colors.reset);
        console.log(`│  Account Balance:    ${STATE.currency} ${STATE.balance.toFixed(2).padEnd(48)}│`);
        console.log(`│  Investment Capital: ${STATE.currency} ${STATE.investmentCapital.toFixed(2).padEnd(48)}│`);
        console.log(`│  Current Capital:    ${STATE.currency} ${STATE.currentCapital.toFixed(2)} (${capitalReturn >= 0 ? '+' : ''}${capitalReturn}%)`.padEnd(71) + '│');
        console.log(`│  Daily P&L:          ${(STATE.totalDailyPnl >= 0 ? '+' : '') + '$' + STATE.totalDailyPnl.toFixed(2).padEnd(48)}│`);
        console.log(`│  Open Positions:     ${(STATE.totalOpenPositions + '/' + CONFIG.maxTotalOpenPositions).padEnd(49)}│`);
        console.log(`│  Trades Today:       ${STATE.totalTradesToday.toString().padEnd(49)}│`);
        console.log(`│  Win Rate:           ${(winRate + '%').padEnd(49)}│`);
        console.log(`│  Wins/Losses:        ${(STATE.globalWins + '/' + STATE.globalLosses).padEnd(49)}│`);
        console.log(this.colors.green + '└──────────────────────────────────────────────────────────────────────┘' + this.colors.reset);
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
        if (response.msg_type === 'ohlc') {
            const symbol = response.ohlc?.symbol;
            if (symbol && STATE.assets[symbol]) {
                CandleManager.handleCandleUpdate(symbol, response.ohlc);
            }
            return;
        }

        if (response.msg_type === 'proposal_open_contract') {
            TradeExecutor.handleContractUpdate(response.proposal_open_contract);
            return;
        }

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
        Logger.info(`Balance: ${STATE.currency} ${STATE.balance.toFixed(2)} | Capital: ${STATE.currency} ${STATE.investmentCapital.toFixed(2)}`);

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
            // FIXED: Normalize historical candle epochs too
            STATE.assets[symbol].candles = response.candles.map(c => ({
                time: CandleManager.normalizeEpoch(c.epoch),  // Normalize!
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

    // Add this new method to DerivAPI object (after subscribeContract method):

    async recoverPositions(savedPositions) {
        if (!savedPositions || savedPositions.length === 0) {
            Logger.info('No positions to recover');
            return;
        }

        Logger.warn(`Found ${savedPositions.length} position(s) from previous session - recovering...`);

        for (const pos of savedPositions) {
            try {
                Logger.info(`Recovering ${pos.symbol} position: Contract ${pos.contractId}`, pos.symbol);

                // Add delay between recovery attempts
                await new Promise(r => setTimeout(r, 1000));

                // Get current contract status with retries
                let response = null;
                let attempts = 0;
                const maxAttempts = 3;

                while (attempts < maxAttempts && !response) {
                    try {
                        response = await this.send({
                            proposal_open_contract: 1,
                            contract_id: pos.contractId
                        });
                    } catch (error) {
                        attempts++;
                        if (attempts < maxAttempts) {
                            Logger.debug(`Recovery attempt ${attempts} failed, retrying...`, pos.symbol);
                            await new Promise(r => setTimeout(r, 2000));
                        } else {
                            throw error;
                        }
                    }
                }

                const contract = response?.proposal_open_contract;

                if (!contract) {
                    Logger.warn(`Contract ${pos.contractId} not found - may have closed during downtime`, pos.symbol);
                    continue;
                }

                const asset = STATE.assets[pos.symbol];

                // Check if contract is still open
                if (contract.is_sold || contract.status === 'sold') {
                    Logger.info(`Contract ${pos.contractId} was closed during downtime`, pos.symbol);

                    // Record the closed trade
                    const pnl = contract.profit || 0;
                    const isWin = pnl > 0;

                    Logger.trade(`Recovered closed trade: ${isWin ? '✅ WIN' : '❌ LOSS'} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, pos.symbol);

                    RiskManager.recordTrade(pos.symbol, pnl, isWin);

                    await TelegramNotifier.sendTradeClosed(pos.symbol, pos.direction, pnl, isWin);

                } else {
                    // Position is still open - restore it
                    asset.activeContract = String(contract.contract_id);
                    asset.contractId = String(contract.contract_id);
                    asset.entryPrice = pos.entryPrice;
                    asset.direction = pos.direction;
                    asset.takeProfitPrice = pos.takeProfitPrice;
                    asset.stopLossPrice = pos.stopLossPrice;
                    asset.stake = pos.stake;
                    asset.multiplier = pos.multiplier;
                    asset.unrealizedPnl = contract.profit || pos.lastKnownPnl || 0;

                    STATE.totalOpenPositions++;

                    Logger.success(`Position recovered: ${pos.direction} @ ${pos.entryPrice.toFixed(4)}, Current P&L: $${asset.unrealizedPnl.toFixed(2)}`, pos.symbol);

                    // Subscribe to contract updates
                    await new Promise(r => setTimeout(r, 500));
                    const subResponse = await this.subscribeContract(asset.contractId);
                    asset.contractSubscriptionId = subResponse.subscription?.id;

                    // Restore trade history entry if needed
                    if (!asset.tradeHistory.find(t => t.id === asset.contractId)) {
                        asset.tradeHistory.push({
                            id: asset.contractId,
                            openTime: pos.openTime ? new Date(pos.openTime) : new Date(),
                            direction: pos.direction,
                            entry: pos.entryPrice,
                            stake: pos.stake,
                            multiplier: pos.multiplier,
                            status: 'open'
                        });
                    }
                }

            } catch (error) {
                Logger.error(`Failed to recover position for ${pos.symbol}: ${error.message}`, pos.symbol);
            }
        }

        Logger.success('Position recovery complete');
        StateManager.saveStateNow(); // Force immediate save after recovery
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: CANDLE MANAGER (FIXED - Epoch Normalization)
// ═══════════════════════════════════════════════════════════════════════════════

const CandleManager = {
    GRANULARITY: 60, // 60 seconds = 1 minute candles

    /**
     * Normalize epoch to candle start time
     * This ensures all ticks within the same minute map to the same candle
     */
    normalizeEpoch(epoch) {
        return Math.floor(epoch / this.GRANULARITY) * this.GRANULARITY;
    },

    /**
     * Handle incoming candle updates from WebSocket
     * FIXED: Normalizes epoch to prevent multiple candles per minute
     */
    handleCandleUpdate(symbol, ohlc) {
        const asset = STATE.assets[symbol];
        if (!asset) return;

        const rawEpoch = ohlc.epoch;
        const normalizedEpoch = this.normalizeEpoch(rawEpoch);

        const candle = {
            time: normalizedEpoch,  // Use normalized epoch!
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close)
        };

        asset.lastTick = candle.close;
        asset.currentPrice = candle.close;

        // First candle ever received
        if (asset.candles.length === 0) {
            asset.candles.push(candle);
            Logger.debug(`First candle: epoch=${normalizedEpoch}`, symbol);
            return;
        }

        const lastCandle = asset.candles[asset.candles.length - 1];

        // Compare normalized epochs (candle start times)
        if (normalizedEpoch === lastCandle.time) {
            // Same candle - just update it (still forming)
            // Update high/low/close but keep the original open
            asset.candles[asset.candles.length - 1] = {
                time: lastCandle.time,
                open: lastCandle.open,  // Keep original open
                high: Math.max(lastCandle.high, candle.high),
                low: Math.min(lastCandle.low, candle.low),
                close: candle.close
            };
            // DO NOT call onCandleClosed here - candle is still forming!

        } else if (normalizedEpoch > lastCandle.time) {
            // NEW candle started - the previous candle is now CLOSED
            Logger.debug(`New candle: ${lastCandle.time} → ${normalizedEpoch}`, symbol);

            // Save the closed candle before pushing new one
            const closedCandle = { ...lastCandle };

            // Add the new forming candle
            asset.candles.push(candle);

            // Trim buffer if needed
            if (asset.candles.length > CONFIG.maxCandles) {
                asset.candles.shift();
            }

            // Process the CLOSED candle (only once per minute!)
            if (asset.lastProcessedTime !== closedCandle.time) {
                asset.lastProcessedTime = closedCandle.time;
                this.onCandleClosed(symbol, closedCandle);
            }
        }
    },

    /**
     * Called when a candle closes - triggers strategy analysis
     * Now only called ONCE per minute (when new candle starts)
     */
    onCandleClosed(symbol, closedCandle) {
        Logger.debug(`Candle CLOSED: O=${closedCandle.open.toFixed(4)} H=${closedCandle.high.toFixed(4)} L=${closedCandle.low.toFixed(4)} C=${closedCandle.close.toFixed(4)}`, symbol);

        this.checkDailyReset();
        this.checkHourlyReset();
        this.checkDiagnostics();

        const asset = STATE.assets[symbol];
        if (asset.fibLevels) {
            asset.fibCandleCount++;
        }

        StrategyEngine.analyze(symbol);
    },

    checkDailyReset() {
        const today = new Date().toDateString();
        if (today !== STATE.lastResetDate) {
            Logger.info('New trading day - resetting statistics');

            TelegramNotifier.sendDailySummary();

            STATE.totalDailyPnl = 0;
            STATE.totalTradesToday = 0;
            STATE.globalWins = 0;
            STATE.globalLosses = 0;
            STATE.lastResetDate = today;

            for (const symbol of CONFIG.activeAssets) {
                const asset = STATE.assets[symbol];
                asset.tradesToday = 0;
                asset.dailyPnl = 0;
                asset.wins = 0;
                asset.losses = 0;
                // Reset strategy state for new day
                asset.bosDetected = false;
                asset.lastBosPrice = null;
                asset.fibLevels = null;
            }
        }
    },

    checkHourlyReset() {
        const currentHour = new Date().getHours();
        if (currentHour !== STATE.hourlyStats.lastHour) {
            TelegramNotifier.sendHourlySummary();
            STATE.hourlyStats.lastHour = currentHour;
        }
    },

    checkDiagnostics() {
        const now = Date.now();
        if (now - STATE.lastDiagnosticsTime >= CONFIG.diagnosticsInterval) {
            STATE.lastDiagnosticsTime = now;
            Logger.printDiagnostics();
            Logger.globalStats();
            Logger.printAssetTable();
        }
    },

    getRecentCandles(symbol, count) {
        return STATE.assets[symbol]?.candles.slice(-count) || [];
    },

    /**
     * Get completed candles only (excludes current forming candle)
     */
    getCompletedCandles(symbol, count) {
        const candles = STATE.assets[symbol]?.candles || [];
        if (candles.length < 2) return [];
        return candles.slice(0, -1).slice(-count);
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8: SWING DETECTOR
// ═══════════════════════════════════════════════════════════════════════════════

const SwingDetector = {
    /**
     * Find swing highs - local maxima with N bars on each side lower
     * Excludes the current forming candle from analysis
     */
    findSwingHighs(candles, lookback) {
        const swings = [];

        // Exclude the last candle (current forming candle)
        if (candles.length < 2) return swings;
        const completedCandles = candles.slice(0, -1);

        // Need at least (lookback * 2 + 1) candles for valid swing detection
        if (completedCandles.length < (lookback * 2 + 1)) {
            return swings;
        }

        for (let i = lookback; i < completedCandles.length - lookback; i++) {
            let isSwingHigh = true;
            const currentHigh = completedCandles[i].high;

            // Check bars on both sides
            for (let j = 1; j <= lookback; j++) {
                if (completedCandles[i - j].high >= currentHigh ||
                    completedCandles[i + j].high >= currentHigh) {
                    isSwingHigh = false;
                    break;
                }
            }

            if (isSwingHigh) {
                swings.push({
                    index: i,
                    time: completedCandles[i].time,
                    price: currentHigh,
                    candle: completedCandles[i]
                });
            }
        }

        return swings;
    },

    /**
     * Find swing lows - local minima with N bars on each side higher
     * Excludes the current forming candle from analysis
     */
    findSwingLows(candles, lookback) {
        const swings = [];

        // Exclude the last candle (current forming candle)
        if (candles.length < 2) return swings;
        const completedCandles = candles.slice(0, -1);

        // Need at least (lookback * 2 + 1) candles for valid swing detection
        if (completedCandles.length < (lookback * 2 + 1)) {
            return swings;
        }

        for (let i = lookback; i < completedCandles.length - lookback; i++) {
            let isSwingLow = true;
            const currentLow = completedCandles[i].low;

            // Check bars on both sides
            for (let j = 1; j <= lookback; j++) {
                if (completedCandles[i - j].low <= currentLow ||
                    completedCandles[i + j].low <= currentLow) {
                    isSwingLow = false;
                    break;
                }
            }

            if (isSwingLow) {
                swings.push({
                    index: i,
                    time: completedCandles[i].time,
                    price: currentLow,
                    candle: completedCandles[i]
                });
            }
        }

        return swings;
    },

    /**
     * Determine micro-trend from sequence of swings
     */
    determineTrend(swingHighs, swingLows, minSwings) {
        if (swingHighs.length < minSwings || swingLows.length < minSwings) {
            return null;
        }

        const recentHighs = swingHighs.slice(-minSwings);
        const recentLows = swingLows.slice(-minSwings);

        // Check for uptrend (higher highs AND higher lows)
        let higherHighs = true;
        let higherLows = true;

        for (let i = 1; i < recentHighs.length; i++) {
            if (recentHighs[i].price <= recentHighs[i - 1].price) {
                higherHighs = false;
                break;
            }
        }

        for (let i = 1; i < recentLows.length; i++) {
            if (recentLows[i].price <= recentLows[i - 1].price) {
                higherLows = false;
                break;
            }
        }

        if (higherHighs && higherLows) {
            return 'up';
        }

        // Check for downtrend (lower highs AND lower lows)
        let lowerHighs = true;
        let lowerLows = true;

        for (let i = 1; i < recentHighs.length; i++) {
            if (recentHighs[i].price >= recentHighs[i - 1].price) {
                lowerHighs = false;
                break;
            }
        }

        for (let i = 1; i < recentLows.length; i++) {
            if (recentLows[i].price >= recentLows[i - 1].price) {
                lowerLows = false;
                break;
            }
        }

        if (lowerHighs && lowerLows) {
            return 'down';
        }

        return null;
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9: FIBONACCI CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════════

const FibCalculator = {
    calculate(start, end, trend) {
        const range = end - start;
        return {
            start, end,
            trend: trend,
            range: Math.abs(range),
            levels: {
                '0.0': end,
                '0.236': end - (range * 0.236),
                '0.382': end - (range * 0.382),
                '0.5': end - (range * 0.5),
                '0.618': end - (range * 0.618),
                '0.786': end - (range * 0.786),
                '1.0': start
            },
            createdAt: Date.now()
        };
    },

    // FIXED: Use configurable zone bounds
    isInGoldenZone(price, fibLevels) {
        const zoneLevels = [
            fibLevels.levels[CONFIG.fibLowerZone.toString()] || fibLevels.levels['0.382'],
            fibLevels.levels[CONFIG.fibUpperZone.toString()] || fibLevels.levels['0.618']
        ];

        // Calculate zone from configured Fib levels
        const fib382 = fibLevels.levels['0.382'];
        const fib65 = fibLevels.levels['0.5'] + (fibLevels.levels['0.618'] - fibLevels.levels['0.5']) * 0.64; // Approx 0.65

        const zoneTop = Math.max(fib382, fib65);
        const zoneBottom = Math.min(fib382, fib65);

        const inZone = price >= zoneBottom && price <= zoneTop;

        Logger.strategy(`Zone Check: price=${price.toFixed(4)}, zone=[${zoneBottom.toFixed(4)}-${zoneTop.toFixed(4)}], inZone=${inZone}`);

        return inZone;
    },

    // Check if price is between start and end of the Fib (valid for entry consideration)
    isInFibRange(price, fibLevels) {
        const top = Math.max(fibLevels.start, fibLevels.end);
        const bottom = Math.min(fibLevels.start, fibLevels.end);
        return price >= bottom && price <= top;
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10: STRATEGY ENGINE - COMPLETELY REWRITTEN FOR CONTINUOUS TRADING
// ═══════════════════════════════════════════════════════════════════════════════

const StrategyEngine = {
    analyze(symbol) {
        const asset = STATE.assets[symbol];
        if (!asset) return;

        asset.analysisCount++;

        // Skip if we have an active position
        if (asset.activeContract) {
            asset.lastAnalysisResult = 'Has open position';
            return;
        }

        // Check post-trade cooldown
        if (asset.lastTradeCloseTime) {
            const elapsed = (Date.now() - asset.lastTradeCloseTime) / 1000;
            if (elapsed < CONFIG.postTradeCooldown) {
                asset.lastAnalysisResult = `Post-trade cooldown: ${Math.ceil(CONFIG.postTradeCooldown - elapsed)}s`;
                return;
            }
        }

        const candles = CandleManager.getRecentCandles(symbol, 100);
        if (candles.length < 50) {
            asset.lastAnalysisResult = 'Insufficient candles';
            return;
        }

        const assetConfig = asset.config;
        const lookback = assetConfig.swingLookback || 5;

        // Find swings
        asset.swingHighs = SwingDetector.findSwingHighs(candles, lookback);
        asset.swingLows = SwingDetector.findSwingLows(candles, lookback);

        if (asset.swingHighs.length < 2 || asset.swingLows.length < 2) {
            asset.lastAnalysisResult = 'Not enough swings';
            return;
        }

        // Determine trend
        const previousTrend = asset.currentTrend;
        asset.currentTrend = SwingDetector.determineTrend(
            asset.swingHighs, asset.swingLows, CONFIG.minTrendSwings
        );

        // Log trend changes
        if (asset.currentTrend !== previousTrend) {
            if (asset.currentTrend) {
                Logger.signal(`Trend: ${asset.currentTrend.toUpperCase()}`, symbol);
                asset.trendStartTime = Date.now();
            }
            // Reset BoS on trend change
            asset.bosDetected = false;
            asset.lastBosPrice = null;
            asset.fibLevels = null;
        }

        if (!asset.currentTrend) {
            asset.lastAnalysisResult = 'No clear trend';
            return;
        }

        const currentCandle = candles[candles.length - 1];
        const previousCandle = candles[candles.length - 2];
        const currentPrice = currentCandle.close;

        // === CONTINUOUS BOS DETECTION ===
        // Instead of just detecting once, we track the last BoS price
        // and look for new breaks continuously
        this.updateBoS(symbol, currentCandle);

        // === DYNAMIC FIBONACCI UPDATE ===
        // Recalculate Fib levels when we have new swings
        this.updateFibLevels(symbol, currentCandle);

        // Check if we can enter
        if (!asset.fibLevels) {
            asset.lastAnalysisResult = 'No Fib levels';
            return;
        }

        if (!asset.bosDetected) {
            asset.lastAnalysisResult = 'No Bos detected';
            // return;
        }

        // Note: Fib expiry check removed since we now recalculate on every candle

        // Check if price is in golden zone
        const inGoldenZone = FibCalculator.isInGoldenZone(currentPrice, asset.fibLevels);

        if (!inGoldenZone) {
            asset.lastAnalysisResult = `Price ${currentPrice.toFixed(2)} outside zone`;
            // return;
        }

        const inFibRange = FibCalculator.isInFibRange(currentPrice, asset.fibLevels);
        if (!inFibRange) {
            asset.lastAnalysisResult = `Price ${currentPrice.toFixed(2)} outside zone`;
            // return;
        }

        // Check signal cooldown
        if (this.isSignalCooldownActive(symbol)) {
            const remaining = CONFIG.signalCooldownSeconds - Math.floor((Date.now() - asset.lastSignalTime) / 1000);
            asset.lastAnalysisResult = `Signal cooldown: ${remaining}s`;
            return;
        }

        // Optional confirmation
        if (!this.checkConfirmation(asset, previousCandle)) {
            asset.lastAnalysisResult = 'Awaiting confirmation candle';
            // return;
        }

        // Generate signal
        const signal = this.generateSignal(symbol, previousCandle);

        if (!signal) {
            asset.lastAnalysisResult = 'Signal rejected (impulse too small)';
            // return;
        }

        // Check risk management
        if (!RiskManager.canTrade(symbol)) {
            asset.lastAnalysisResult = 'Risk manager blocked';
            return;
        }

        // Execute trade!
        if (asset.fibLevels && inGoldenZone && inFibRange && signal) {
            Logger.signal(`Entry: ${signal.direction} @ ${signal.entry.toFixed(4)}`, symbol);
            asset.lastSignalTime = Date.now();
            asset.signalsGenerated++;
            asset.lastAnalysisResult = 'Signal generated';
            TradeExecutor.executeSignal(symbol, signal);
        }
    },

    // NEW: Continuous BoS detection with duplicate log prevention
    updateBoS(symbol, currentCandle) {
        const asset = STATE.assets[symbol];
        const recentHighs = asset.swingHighs.slice(-3);
        const recentLows = asset.swingLows.slice(-3);

        if (asset.currentTrend === 'up' && recentHighs.length >= 2) {
            // For uptrend, look for break above swing high
            const targetSwingHigh = recentHighs[recentHighs.length - 1];

            // Check if we've broken this level (or a higher one since last BoS)
            if (currentCandle.close > targetSwingHigh.price) {
                // Check if this is a NEW swing break
                const isFirstBreak = !asset.bosDetected;
                const isNewSwingTarget = asset.lastBosSwingPrice !== targetSwingHigh.price;

                if (isFirstBreak || isNewSwingTarget) {
                    asset.bosDetected = true;
                    asset.lastBosPrice = currentCandle.close;
                    asset.lastBosSwingPrice = targetSwingHigh.price;
                    asset.bosTime = Date.now();
                    asset.bosDirection = 'up';
                    Logger.signal(`BoS UP: Broke ${targetSwingHigh.price.toFixed(4)}`, symbol);
                }
            }
        } else if (asset.currentTrend === 'down' && recentLows.length >= 2) {
            // For downtrend, look for break below swing low
            const targetSwingLow = recentLows[recentLows.length - 1];

            if (currentCandle.close < targetSwingLow.price) {
                const isFirstBreak = !asset.bosDetected;
                const isNewSwingTarget = asset.lastBosSwingPrice !== targetSwingLow.price;

                if (isFirstBreak || isNewSwingTarget) {
                    asset.bosDetected = true;
                    asset.lastBosPrice = currentCandle.close;
                    asset.lastBosSwingPrice = targetSwingLow.price;
                    asset.bosTime = Date.now();
                    asset.bosDirection = 'down';
                    Logger.signal(`BoS DOWN: Broke ${targetSwingLow.price.toFixed(4)}`, symbol);
                }
            }
        }
    },

    // FIXED: ALWAYS recalculate Fib levels on every candle (like fibo-scalper4)
    updateFibLevels(symbol, currentCandle) {
        const asset = STATE.assets[symbol];
        const recentHighs = asset.swingHighs.slice(-3);
        const recentLows = asset.swingLows.slice(-3);

        if (asset.currentTrend === 'up' && recentLows.length >= 1 && recentHighs.length >= 1) {
            const lastSwingLow = recentLows[recentLows.length - 1];
            const lastSwingHigh = recentHighs[recentHighs.length - 1];

            // Use most recent swing low to current high as impulse
            const impulseStart = lastSwingLow.price;
            const impulseEnd = Math.max(lastSwingHigh.price, currentCandle.high);

            // ALWAYS recalculate - removed 10% threshold that blocked updates
            asset.impulseStart = impulseStart;
            asset.impulseEnd = impulseEnd;
            asset.fibLevels = FibCalculator.calculate(impulseStart, impulseEnd, 'up');
            asset.lastFibUpdateTime = Date.now();

        } else if (asset.currentTrend === 'down' && recentHighs.length >= 1 && recentLows.length >= 1) {
            const lastSwingHigh = recentHighs[recentHighs.length - 1];
            const lastSwingLow = recentLows[recentLows.length - 1];

            const impulseStart = lastSwingHigh.price;
            const impulseEnd = Math.min(lastSwingLow.price, currentCandle.low);

            // ALWAYS recalculate - removed 10% threshold that blocked updates
            asset.impulseStart = impulseStart;
            asset.impulseEnd = impulseEnd;
            asset.fibLevels = FibCalculator.calculate(impulseStart, impulseEnd, 'down');
            asset.lastFibUpdateTime = Date.now();
        }
    },

    isSignalCooldownActive(symbol) {
        const asset = STATE.assets[symbol];
        if (!asset.lastSignalTime) return false;

        const elapsed = (Date.now() - asset.lastSignalTime) / 1000;
        return elapsed < CONFIG.signalCooldownSeconds;
    },

    checkConfirmation(asset, candle) {
        if (candle.close > candle.open) {
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
        const minImpulse = asset.config.minImpulsePercent || 0.0003;

        if (asset.currentTrend === 'up') {
            const stopLoss = asset.fibLevels.levels['0.786'];
            const riskAmount = entryPrice - stopLoss;
            const takeProfit = entryPrice + (riskAmount * rrRatio);

            if ((riskAmount / entryPrice) < minImpulse) {
                Logger.strategy(`Impulse too small: ${(riskAmount / entryPrice * 100).toFixed(4)}% < ${minImpulse * 100}%`, symbol);
                return null;
            }

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

            if ((riskAmount / entryPrice) < minImpulse) {
                Logger.strategy(`Impulse too small: ${(riskAmount / entryPrice * 100).toFixed(4)}% < ${minImpulse * 100}%`, symbol);
                return null;
            }

            return {
                direction: 'MULTDOWN',
                entry: entryPrice,
                stopLoss, takeProfit,
                riskPips: riskAmount
            };
        }
    },

    resetFibLevels(symbol) {
        const asset = STATE.assets[symbol];
        asset.fibLevels = null;
        asset.fibCandleCount = 0;
        asset.lastBosSwingPrice = null;
        asset.impulseStart = null;
        asset.impulseEnd = null;
        asset.lastFibUpdateTime = null;
    },

    // Called after trade closes - reset setup to allow new BoS detection
    onTradeClose(symbol) {
        const asset = STATE.assets[symbol];
        asset.lastTradeCloseTime = Date.now();
        asset.entriesThisSetup++;

        // FIXED: Reset BoS and Fib to allow new setup detection
        // This prevents getting stuck waiting for expired setups
        this.resetFibLevels(symbol);
        asset.bosDetected = false;
        asset.lastBosPrice = null;

        Logger.strategy(`Trade closed. Setup reset for new BoS detection.`, symbol);
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
            Logger.warn(`Daily loss limit reached`, symbol);
            return false;
        }

        if (STATE.totalOpenPositions >= CONFIG.maxTotalOpenPositions) {
            Logger.warn(`Max open positions reached`, symbol);
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

        // Print capital after every trade
        Logger.info(`Capital: ${STATE.currency} ${STATE.currentCapital.toFixed(2)}`);

        // Save state after every trade
        StateManager.saveState();
    },

    getStake(symbol) {
        const config = ASSET_CONFIGS[symbol];
        return Math.max(config.minStake, Math.min(CONFIG.defaultStake, config.maxStake));
    },

    getMultiplier(symbol) {
        return ASSET_CONFIGS[symbol].defaultMultiplier;
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12: TRADE EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════════

const TradeExecutor = {
    async executeSignal(symbol, signal) {
        const asset = STATE.assets[symbol];

        if (asset.activeContract) {
            Logger.warn('Trade rejected - position already open', symbol);
            return;
        }

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
                // FIXED: Store contract ID as string for consistent comparison
                asset.activeContract = String(response.buy.contract_id);
                asset.contractId = String(response.buy.contract_id);
                asset.entryPrice = signal.entry;
                asset.direction = signal.direction;
                asset.takeProfitPrice = signal.takeProfit;
                asset.stopLossPrice = signal.stopLoss;
                asset.stake = stake;
                asset.multiplier = multiplier;
                asset.unrealizedPnl = 0;
                asset.lastEntryPrice = signal.entry;
                asset.lastEntryTime = Date.now();

                STATE.totalOpenPositions++;

                Logger.success(`Trade opened: ID ${asset.activeContract}`, symbol);

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

                // Print asset table after every trade
                Logger.printAssetTable();

                // Save state after every trade
                StateManager.saveState();
            }
        } catch (error) {
            Logger.error(`Trade execution failed: ${error.message}`, symbol);
        }
    },

    handleContractUpdate(contract) {
        if (!contract) return;

        const contractIdStr = String(contract.contract_id);

        let assetSymbol = null;
        for (const symbol of CONFIG.activeAssets) {
            if (STATE.assets[symbol].activeContract === contractIdStr) {
                assetSymbol = symbol;
                break;
            }
        }

        if (!assetSymbol) return;

        const asset = STATE.assets[assetSymbol];

        // Update current price and P&L
        if (contract.profit !== undefined) {
            asset.unrealizedPnl = contract.profit;
            asset.currentPrice = contract.current_spot;
        }

        // Enhanced closure detection - check multiple conditions
        const isSold = contract.is_sold === 1 || contract.status === 'sold';
        const isClosed = contract.status === 'closed';
        const hasExitTick = contract.exit_tick !== undefined;
        const hasSellPrice = contract.sell_price !== undefined;

        // Additional check: if profit stopped changing and TP/SL was likely hit
        const tpReached = contract.limit_order?.take_profit &&
            Math.abs(contract.profit - contract.limit_order.take_profit) < 0.01;
        const slReached = contract.limit_order?.stop_loss &&
            Math.abs(contract.profit + contract.limit_order.stop_loss) < 0.01;

        if (isSold || isClosed || hasExitTick || hasSellPrice || tpReached || slReached) {
            Logger.debug(`Contract closure detected: isSold=${isSold}, isClosed=${isClosed}, hasExitTick=${hasExitTick}, hasSellPrice=${hasSellPrice}, tpReached=${tpReached}, slReached=${slReached}`, assetSymbol);
            this.onContractClosed(assetSymbol, contract);
        }
    },

    async onContractClosed(symbol, contract) {
        const asset = STATE.assets[symbol];
        const pnl = contract.profit || 0;
        const isWin = pnl > 0;

        Logger.trade(`${isWin ? '✅ WIN' : '❌ LOSS'} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, symbol);

        await TelegramNotifier.sendTradeClosed(symbol, asset.direction, pnl, isWin);

        const trade = asset.tradeHistory.find(t => t.id === asset.activeContract);
        if (trade) {
            trade.closeTime = new Date();
            trade.pnl = pnl;
            trade.status = isWin ? 'win' : 'loss';
        }

        RiskManager.recordTrade(symbol, pnl, isWin);

        // Reset position state
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
        STATE.totalOpenPositions = Math.max(0, STATE.totalOpenPositions - 1);

        // KEY: Notify strategy engine but DON'T reset the setup
        StrategyEngine.onTradeClose(symbol);

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

    // Load previous state before connecting
    const savedPositions = StateManager.loadState();

    Logger.printAssetTable();

    setupShutdownHandlers();
    setupHourlySummaryTimer();

    try {
        await DerivAPI.connect();
        await DerivAPI.authorize();
        await DerivAPI.subscribeAllAssets();

        // Recover any positions from previous session
        if (savedPositions && savedPositions.length > 0) {
            await DerivAPI.recoverPositions(savedPositions);
        }

        await TelegramNotifier.sendStartup();

        Logger.globalStats();
        Logger.success('Bot is running. Monitoring all assets for signals...');
        Logger.info('Strategy diagnostics will print every 5 minutes');
        Logger.info('Press Ctrl+C for graceful shutdown\n');

        // Periodic health check for open positions
        setInterval(async () => {
            if (!STATE.connected || !STATE.authorized) return;

            for (const symbol of CONFIG.activeAssets) {
                const asset = STATE.assets[symbol];
                if (asset.activeContract) {
                    try {
                        // Add small delay between assets to avoid overwhelming API
                        await new Promise(r => setTimeout(r, 200));

                        const response = await DerivAPI.send({
                            proposal_open_contract: 1,
                            contract_id: asset.contractId
                        });

                        if (response.proposal_open_contract) {
                            TradeExecutor.handleContractUpdate(response.proposal_open_contract);
                        }
                    } catch (error) {
                        // Only log health check errors if they persist
                        if (!asset.lastHealthCheckError || Date.now() - asset.lastHealthCheckError > 60000) {
                            Logger.debug(`Health check failed for ${symbol}: ${error.message}`, symbol);
                            asset.lastHealthCheckError = Date.now();
                        }
                    }
                }
            }
        }, 30000); // Increased to 30 seconds to reduce API load

        // Initial diagnostics
        setTimeout(() => {
            Logger.printDiagnostics();
        }, 30000);

        // Periodic stats display
        setInterval(() => {
            Logger.globalStats();
        }, 300000);

        process.stdin.resume();

    } catch (error) {
        Logger.error(`Startup failed: ${error.message}`);
        process.exit(1);
    }
}

function setupHourlySummaryTimer() {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1);
    nextHour.setMinutes(0);
    nextHour.setSeconds(0);
    nextHour.setMilliseconds(0);

    const timeUntilNextHour = nextHour.getTime() - now.getTime();

    setTimeout(() => {
        TelegramNotifier.sendHourlySummary();

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

        // Save final state before shutdown
        StateManager.saveState();

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
        console.error(error.stack);
        shutdown('uncaughtException');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

main();
