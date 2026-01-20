/**
 * DERIV MULTIPLIER BOT v7.0
 * =========================
 * WPR ONLY Strategy with Persistent Breakout Levels
 *
 * BUY SETUP:
 * - WPR crosses above -20 (Previous WPR ≤ -20, Current WPR > -20)
 * - Must be FIRST crossing above -20 since coming from oversold (-80)
 * - Execute BUY immediately, mark previous candle High/Low as breakout levels
 *
 * SELL SETUP:
 * - WPR crosses below -80 (Previous WPR ≥ -80, Current WPR < -80)
 * - Must be FIRST crossing below -80 since coming from overbought (-20)
 * - Execute SELL immediately, mark previous candle High/Low as breakout levels
 *
 * REVERSAL SYSTEM:
 * - BUY reverses to SELL when candle CLOSES BELOW lower breakout level
 * - SELL reverses to BUY when candle CLOSES ABOVE higher breakout level
 * - Each reversal: 2x stake, add loss to TP target (max 6 reversals)
 *
 * PERSISTENT BREAKOUT LEVELS:
 * - Breakout levels stay active until opposite type is formed
 * - After TP reached, wait for price action between levels
 * - New trades triggered when price closes above/below levels
 *
 * Dependencies: npm install ws mathjs
 * Usage: API_TOKEN=your_token node deriv-bot.js
 */

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER - FIXED VERSION
// ============================================
const STATE_FILE = path.join(__dirname, 'claudeWillbot1Minss-state.json');
const STATE_SAVE_INTERVAL = 5000; // Save every 5 seconds

class StatePersistence {
    static saveState() {
        try {
            const persistableState = {
                savedAt: Date.now(),
                capital: state.capital,
                session: { ...state.session },
                portfolio: {
                    dailyProfit: state.portfolio.dailyProfit,
                    dailyLoss: state.portfolio.dailyLoss,
                    dailyWins: state.portfolio.dailyWins,
                    dailyLosses: state.portfolio.dailyLosses,
                    activePositions: state.portfolio.activePositions.map(pos => ({
                        symbol: pos.symbol,
                        direction: pos.direction,
                        stake: pos.stake,
                        multiplier: pos.multiplier,
                        entryTime: pos.entryTime,
                        contractId: pos.contractId,
                        reqId: pos.reqId,
                        buyPrice: pos.buyPrice,
                        isReversal: pos.isReversal,
                        reversalLevel: pos.reversalLevel,
                        currentProfit: pos.currentProfit,
                        pendingReversal: pos.pendingReversal, // FIX: Added missing field
                        isRecoveryClose: pos.isRecoveryClose, // FIX: Added missing field
                        isMaxReversalClose: pos.isMaxReversalClose // FIX: Added missing field
                    }))
                },
                assets: {}
            };

            // Save essential asset state for each symbol
            Object.keys(state.assets).forEach(symbol => {
                const asset = state.assets[symbol];
                persistableState.assets[symbol] = {
                    // WPR tracking
                    wpr: asset.wpr,
                    prevWpr: asset.prevWpr,

                    // WPR Zone flags
                    buyFlagActive: asset.buyFlagActive,
                    sellFlagActive: asset.sellFlagActive,

                    // Breakout levels
                    breakout: { ...asset.breakout },

                    // Trade cycle state
                    currentDirection: asset.currentDirection,
                    inTradeCycle: asset.inTradeCycle,
                    waitingForReentry: asset.waitingForReentry,
                    priceReturnedToZone: asset.priceReturnedToZone,
                    lastTradeDirection: asset.lastTradeDirection,

                    // Stake management
                    currentStake: asset.currentStake,
                    takeProfit: asset.takeProfit,
                    reversalLevel: asset.reversalLevel,
                    accumulatedLoss: asset.accumulatedLoss,
                    takeProfitAmount: asset.takeProfitAmount,

                    // Stats
                    dailyTrades: asset.dailyTrades,
                    dailyWins: asset.dailyWins,
                    dailyLosses: asset.dailyLosses,
                    consecutiveLosses: asset.consecutiveLosses,

                    // FIX: Added missing critical fields
                    indicatorsReady: asset.indicatorsReady,
                    lastProcessedCandleOpenTime: asset.lastProcessedCandleOpenTime,
                    activeContract: asset.activeContract,
                    unrealizedPnl: asset.unrealizedPnl,

                    // FIX: Save last few closed candles for continuity
                    closedCandles: asset.closedCandles.slice(-20) // Save last 20 candles
                };
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
            // LOGGER.debug('💾 State saved to disk');
        } catch (error) {
            LOGGER.error(`Failed to save state: ${error.message}`);
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                LOGGER.info('📂 No previous state file found, starting fresh');
                return false;
            }

            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            // Only restore if state is less than 30 minutes old
            if (ageMinutes > 30) {
                LOGGER.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE); // FIX: Delete old state file
                return false;
            }

            LOGGER.info(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);

            // Restore capital and session
            state.capital = savedData.capital;
            state.session = {
                ...state.session,
                ...savedData.session,
                startTime: savedData.session.startTime || Date.now(), // FIX: Preserve original start time
                startCapital: savedData.session.startCapital || savedData.capital
            };

            // Restore portfolio
            state.portfolio.dailyProfit = savedData.portfolio.dailyProfit;
            state.portfolio.dailyLoss = savedData.portfolio.dailyLoss;
            state.portfolio.dailyWins = savedData.portfolio.dailyWins;
            state.portfolio.dailyLosses = savedData.portfolio.dailyLosses;

            // FIX: Restore active positions with all fields
            state.portfolio.activePositions = (savedData.portfolio.activePositions || []).map(pos => ({
                ...pos,
                entryTime: pos.entryTime || Date.now() // FIX: Ensure entryTime exists
            }));

            // Restore asset states
            Object.keys(savedData.assets).forEach(symbol => {
                if (state.assets[symbol]) {
                    const saved = savedData.assets[symbol];
                    const asset = state.assets[symbol];

                    // WPR tracking
                    asset.wpr = saved.wpr || -50;
                    asset.prevWpr = saved.prevWpr || -50;

                    // WPR Zone flags
                    asset.buyFlagActive = saved.buyFlagActive || false;
                    asset.sellFlagActive = saved.sellFlagActive || false;

                    // Breakout levels
                    asset.breakout = {
                        active: saved.breakout?.active || false,
                        type: saved.breakout?.type || null,
                        highLevel: saved.breakout?.highLevel || 0,
                        lowLevel: saved.breakout?.lowLevel || 0,
                        triggerCandle: saved.breakout?.triggerCandle || 0,
                        canBeReplaced: saved.breakout?.canBeReplaced || true
                    };

                    // Trade cycle state
                    asset.currentDirection = saved.currentDirection || null;
                    asset.inTradeCycle = saved.inTradeCycle || false;
                    asset.waitingForReentry = saved.waitingForReentry || false;
                    asset.priceReturnedToZone = saved.priceReturnedToZone || false;
                    asset.lastTradeDirection = saved.lastTradeDirection || null;

                    // Stake management
                    asset.currentStake = saved.currentStake || CONFIG.INITIAL_STAKE;
                    asset.takeProfit = saved.takeProfit || CONFIG.TAKE_PROFIT;
                    asset.reversalLevel = saved.reversalLevel || 0;
                    asset.accumulatedLoss = saved.accumulatedLoss || 0;
                    asset.takeProfitAmount = saved.takeProfitAmount || CONFIG.TAKE_PROFIT;

                    // Stats
                    asset.dailyTrades = saved.dailyTrades || 0;
                    asset.dailyWins = saved.dailyWins || 0;
                    asset.dailyLosses = saved.dailyLosses || 0;
                    asset.consecutiveLosses = saved.consecutiveLosses || 0;

                    // FIX: Restore critical fields
                    asset.indicatorsReady = saved.indicatorsReady || false;
                    asset.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                    asset.activeContract = saved.activeContract || null;
                    asset.unrealizedPnl = saved.unrealizedPnl || 0;

                    // FIX: Restore closed candles if available
                    if (saved.closedCandles && saved.closedCandles.length > 0) {
                        asset.closedCandles = saved.closedCandles;
                        LOGGER.info(`  📊 Restored ${saved.closedCandles.length} closed candles for ${symbol}`);
                    }

                    // FIX: Link active positions back to assets
                    const activePos = state.portfolio.activePositions.find(p => p.symbol === symbol);
                    if (activePos) {
                        asset.activePosition = activePos;
                    }

                    LOGGER.info(`  ✅ ${symbol}: BuyFlag=${saved.buyFlagActive}, SellFlag=${saved.sellFlagActive}, InCycle=${saved.inTradeCycle}, Rev=${saved.reversalLevel}`);
                }
            });

            LOGGER.info(`✅ State restored successfully!`);
            LOGGER.info(`   💰 Capital: $${state.capital.toFixed(2)}`);
            LOGGER.info(`   📊 Session P/L: $${state.session.netPL.toFixed(2)}`);
            LOGGER.info(`   🎯 Trades: ${state.session.tradesCount} (W:${state.session.winsCount} L:${state.session.lossesCount})`);
            LOGGER.info(`   🚀 Active Positions: ${state.portfolio.activePositions.length}`);

            return true;
        } catch (error) {
            LOGGER.error(`Failed to load state: ${error.message}`);
            LOGGER.error(`Stack: ${error.stack}`);
            return false;
        }
    }

    static startAutoSave() {
        setInterval(() => {
            if (state.isAuthorized) {
                this.saveState();
            }
        }, STATE_SAVE_INTERVAL);
        LOGGER.info(`💾 Auto-save enabled (every ${STATE_SAVE_INTERVAL / 1000}s)`);
    }

    static clearState() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                fs.unlinkSync(STATE_FILE);
                LOGGER.info('🗑️ State file cleared');
            }
        } catch (error) {
            LOGGER.error(`Failed to clear state: ${error.message}`);
        }
    }
}

// ============================================
// TELEGRAM SERVICE
// ============================================
class TelegramService {
    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED) return;
        try {
            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const data = JSON.stringify({
                chat_id: CONFIG.TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            });

            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': data.length
                }
            };

            return new Promise((resolve, reject) => {
                const req = https.request(url, options, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            LOGGER.info(`📱 Telegram message sent`);
                            resolve(true);
                        } else {
                            LOGGER.error(`Telegram API error: ${body}`);
                            reject(new Error(body));
                        }
                    });
                });
                req.on('error', (error) => {
                    LOGGER.error(`Telegram request error: ${error.message}`);
                    reject(error);
                });
                req.write(data);
                req.end();
            });
        } catch (error) {
            LOGGER.error(`Failed to send Telegram message: ${error.message}`);
        }
    }

    static async sendTradeAlert(type, symbol, direction, stake, multiplier, details = {}) {
        const emoji = type === 'OPEN' ? '🚀' : (type === 'WIN' ? '✅' : '❌');
        const message = `
${emoji} <b>${type} TRADE ALERT</b>
Asset: ${symbol}
Direction: ${direction}
Stake: $${stake.toFixed(2)}
Multiplier: x${multiplier}
${details.profit !== undefined ? `Profit: $${details.profit.toFixed(2)}` : ''}
${details.reversalLevel !== undefined ? `Reversal Level: ${details.reversalLevel}/6` : ''}
${details.breakoutType ? `Breakout Type: ${details.breakoutType}` : ''}
Time: ${new Date().toUTCString()}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendBreakoutAlert(symbol, type, highLevel, lowLevel) {
        const emoji = type === 'BUY' ? '🟢' : '🔴';
        const message = `
${emoji} <b>BREAKOUT LEVELS SET</b>
Asset: ${symbol}
Type: ${type}
High Level: ${highLevel.toFixed(5)}
Low Level: ${lowLevel.toFixed(5)}
Time: ${new Date().toUTCString()}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendSignalAlert(symbol, signalType, wpr) {
        const emoji = signalType.includes('BUY') ? '🟢' : '🔴';
        const message = `
${emoji} <b>WPR SIGNAL - TRADE EXECUTED</b>
Asset: ${symbol}
Signal: ${signalType}
WPR: ${wpr.toFixed(2)}
Timeframe: ${CONFIG.TIMEFRAME_LABEL}
Time: ${new Date().toUTCString()}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendReversalAlert(symbol, direction, stake, previousLoss, reversalNumber, maxReversals, breakoutHigh, breakoutLow) {
        const emoji = direction === 'UP' ? '🟢' : '🔴';
        const dirLabel = direction === 'UP' ? 'BUY' : 'SELL';
        const message = `
🔄 <b>REVERSAL TRADE #${reversalNumber}</b>
Asset: ${symbol}
New Direction: ${emoji} ${dirLabel}
Stake: $${stake.toFixed(2)}
Previous Loss: $${Math.abs(previousLoss).toFixed(2)}
Reversal: ${reversalNumber}/${maxReversals}
Breakout High: ${breakoutHigh.toFixed(5)}
Breakout Low: ${breakoutLow.toFixed(5)}
Time: ${new Date().toUTCString()}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendSessionSummary() {
        const stats = SessionManager.getSessionStats();
        const message = `
📊 <b>SESSION SUMMARY</b>
Duration: ${stats.duration}
Trades: ${stats.trades}
Wins: ${stats.wins} | Losses: ${stats.losses}
Win Rate: ${stats.winRate}
Net P/L: $${stats.netPL.toFixed(2)}
Current Capital: $${state.capital.toFixed(2)}
Active Assets: ${Object.keys(state.assets).length}
Timeframe: ${CONFIG.TIMEFRAME_LABEL}
Strategy: WPR Only
Time: ${new Date().toUTCString()}
        `.trim();
        await this.sendMessage(message);
    }

    /**
     * Periodically send detail notifications for active contracts
     */
    static async sendActivePositionsUpdate() {
        if (!CONFIG.TELEGRAM_ENABLED) return;

        const activePositions = state.portfolio.activePositions.filter(p => p.contractId);

        if (activePositions.length === 0) {
            LOGGER.info('📱 Telegram: No active positions to report');
            return;
        }

        let message = `🚀 <b>ACTIVE CONTRACTS UPDATE</b>\n`;
        message += `Total: ${activePositions.length} position(s)\n\n`;

        for (const pos of activePositions) {
            const profit = pos.currentProfit || 0;
            const emoji = profit >= 0 ? '🟢' : '🔴';
            const duration = Date.now() - pos.entryTime;
            const minutes = Math.floor(duration / 60000);
            const seconds = Math.floor((duration % 60000) / 1000);

            const assetState = state.assets[pos.symbol];

            message += `📊 <b>${pos.symbol}</b> [${pos.direction}]\n`;
            message += `├ Contract: <code>${pos.contractId}</code>\n`;
            message += `├ Stake: $${pos.stake.toFixed(2)} (x${pos.multiplier})\n`;
            message += `├ Status: ${emoji} <b>$${profit.toFixed(2)}</b>\n`;
            message += `├ Reversal: ${pos.reversalLevel}/${CONFIG.MAX_REVERSAL_LEVEL}\n`;
            message += `├ Duration: ${minutes}m ${seconds}s\n`;

            if (assetState && assetState.breakout.active) {
                message += `├ Breakout: ${assetState.breakout.type}\n`;
                message += `├ High: ${assetState.breakout.highLevel.toFixed(5)}\n`;
                message += `└ Low: ${assetState.breakout.lowLevel.toFixed(5)}\n\n`;
            } else {
                message += `└ Breakout: None\n\n`;
            }
        }

        const totalProfit = activePositions.reduce((sum, p) => sum + (p.currentProfit || 0), 0);
        const totalEmoji = totalProfit >= 0 ? '🟢' : '🔴';
        message += `💰 Total Unrealized P/L: ${totalEmoji} <b>$${totalProfit.toFixed(2)}</b>\n\n`;

        // Add session statistics
        message += `📈 <b>SESSION STATS</b>\n`;
        message += `├ Session P/L: $${state.session.netPL.toFixed(2)}\n`;
        message += `├ Trades: ${state.session.tradesCount} (W:${state.session.winsCount} L:${state.session.lossesCount})\n`;
        const sessionWinRate = state.session.tradesCount > 0
            ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1)
            : '0.0';
        message += `├ Win Rate: ${sessionWinRate}%\n`;
        message += `└ Capital: $${state.capital.toFixed(2)}\n\n`;

        message += `⏰ ${new Date().toUTCString()}`;

        await this.sendMessage(message);
        LOGGER.info(`📱 Telegram: Active Contracts Update sent (${activePositions.length} positions)`);
    }

    static async sendStartupMessage() {
        const message = `
🤖 <b>DERIV BOT v7.0 STARTED</b>
Strategy: WPR Only (No Stochastic)
Capital: $${CONFIG.INITIAL_CAPITAL}
Stake: $${CONFIG.INITIAL_STAKE}
Timeframe: ${CONFIG.TIMEFRAME_LABEL}
Assets: ${ACTIVE_ASSETS.join(', ')}
Session Target: $${CONFIG.SESSION_PROFIT_TARGET}
Stop Loss: $${CONFIG.SESSION_STOP_LOSS}
Max Reversals: ${CONFIG.MAX_REVERSAL_LEVEL}

<b>Trade Logic:</b>
BUY: WPR crosses above -20 (from oversold)
SELL: WPR crosses below -80 (from overbought)
Persistent Breakout Levels Active
Time: ${new Date().toUTCString()}
        `.trim();
        await this.sendMessage(message);
    }
}

// ============================================
// LOGGER UTILITY
// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';

const LOGGER = {
    info: (msg) => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: (msg) => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    signal: (msg) => console.log(`\x1b[36m[SIGNAL] ${getGMTTime()} - ${msg}\x1b[0m`),
    breakout: (msg) => console.log(`\x1b[35m[BREAKOUT] ${getGMTTime()} - ${msg}\x1b[0m`),
    recovery: (msg) => console.log(`\x1b[33m[RECOVERY] ${getGMTTime()} - ${msg}\x1b[0m`),
    wpr: (msg) => console.log(`\x1b[34m[WPR] ${getGMTTime()} - ${msg}\x1b[0m`),
    candle: (msg) => console.log(`\x1b[95m[CANDLE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: (msg) => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); }
};

// ============================================
// TIMEFRAME CONFIGURATION
// ============================================
const TIMEFRAMES = {
    '1m': { seconds: 60, granularity: 60, label: '1 Minute' },
    '2m': { seconds: 120, granularity: 120, label: '2 Minutes' },
    '3m': { seconds: 180, granularity: 180, label: '3 Minutes' },
    '4m': { seconds: 240, granularity: 240, label: '4 Minutes' },
    '5m': { seconds: 300, granularity: 300, label: '5 Minutes' },
    '10m': { seconds: 600, granularity: 600, label: '10 Minutes' },
    '15m': { seconds: 900, granularity: 900, label: '15 Minutes' },
    '30m': { seconds: 1800, granularity: 1800, label: '30 Minutes' },
    '1h': { seconds: 3600, granularity: 3600, label: '1 Hour' },
    '4h': { seconds: 14400, granularity: 14400, label: '4 Hours' }
};

const SELECTED_TIMEFRAME = '2m';
const TIMEFRAME_CONFIG = TIMEFRAMES[SELECTED_TIMEFRAME];

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // API Settings
    API_TOKEN: process.env.API_TOKEN || '0P94g4WdSrSrzir',
    APP_ID: process.env.APP_ID || '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Capital Settings
    INITIAL_CAPITAL: 1000,
    INITIAL_STAKE: 1.00,
    TAKE_PROFIT: 2.5,

    // Session Targets
    SESSION_PROFIT_TARGET: 15000,
    SESSION_STOP_LOSS: -1000,

    // Reversal Settings
    REVERSAL_STAKE_MULTIPLIER: 2,
    MAX_REVERSAL_LEVEL: 7,
    AUTO_CLOSE_ON_RECOVERY: false,

    // Timeframe Settings
    TIMEFRAME: SELECTED_TIMEFRAME,
    GRANULARITY: TIMEFRAME_CONFIG.granularity,
    TIMEFRAME_LABEL: TIMEFRAME_CONFIG.label,
    TIMEFRAME_SECONDS: TIMEFRAME_CONFIG.seconds,

    // WPR Settings (Only indicator now)
    WPR_PERIOD: 80,
    WPR_OVERBOUGHT: -20,  // Trigger BUY when crossing above
    WPR_OVERSOLD: -80,    // Trigger SELL when crossing below

    // Trade Settings
    MAX_TRADES_PER_ASSET: 200000,
    MAX_OPEN_POSITIONS: 1000,

    // Timing
    COOLDOWN_AFTER_SESSION_END: 1 * 60 * 1000,
    PROFIT_CHECK_INTERVAL: 1000,

    // Risk Settings
    MIN_WIN_RATE_THRESHOLD: 0.40,
    WIN_RATE_LOOKBACK: 20,
    BLACKLIST_PERIOD: 1 * 2 * 1000,

    // Performance
    MAX_TICKS_STORED: 300,
    MAX_CANDLES_STORED: 500,
    DASHBOARD_UPDATE_INTERVAL: 60000,

    // Debug
    DEBUG_MODE: true,

    // Telegram Settings
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '7976464466:AAEuJ7JWLeJhim7hz0jCeAEwZaPKyR4m7Bg',
    TELEGRAM_CHAT_ID: '752497117'
};

// ============================================
// ASSET CONFIGURATION
// ============================================
const ASSET_CONFIGS = {
    'R_75': {
        name: 'Volatility 75',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 500],
        defaultMultiplier: 100,
        maxTradesPerDay: 500000,
        minStake: 1.00,
        maxStake: 3000,
        tradingHours: '24/7'
    },
    'R_100': {
        name: 'Volatility 100',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [40, 100, 200, 300, 400],
        defaultMultiplier: 100,
        maxTradesPerDay: 50000,
        minStake: 1.00,
        maxStake: 3000,
        tradingHours: '24/7'
    },
    '1HZ25V': {
        name: 'Volatility 25 (1s)',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [160, 400, 800, 1200, 1600],
        defaultMultiplier: 400,
        maxTradesPerDay: 120000,
        minStake: 1.00,
        maxStake: 1000,
        tradingHours: '24/7'
    },
    '1HZ50V': {
        name: 'Volatility 50 (1s)',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [80, 200, 400, 600, 800],
        defaultMultiplier: 200,
        maxTradesPerDay: 120000,
        minStake: 1.00,
        maxStake: 1000,
        tradingHours: '24/7'
    },
    '1HZ100V': {
        name: 'Volatility 100 (1s)',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [40, 100, 200, 300, 400],
        defaultMultiplier: 100,
        maxTradesPerDay: 50000,
        minStake: 1.00,
        maxStake: 3000,
        tradingHours: '24/7'
    },
    'stpRNG': {
        name: 'Step Index',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [750, 2000, 3500, 5500, 7500],
        defaultMultiplier: 2000,
        maxTradesPerDay: 120000,
        minStake: 1.00,
        maxStake: 1000,
        tradingHours: '24/7'
    },
    'frxXAUUSD': {
        name: 'Gold/USD',
        category: 'commodity',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 400, 500],
        defaultMultiplier: 100,
        maxTradesPerDay: 5000,
        minStake: 1,
        maxStake: 5000,
        tradingHours: 'Sun 23:00 - Fri 21:55 GMT'
    }
};

let ACTIVE_ASSETS = ['R_75', '1HZ50V', 'stpRNG', '1HZ25V', 'R_100', '1HZ100V', 'frxXAUUSD'];

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    session: {
        profit: 0,
        loss: 0,
        netPL: 0,
        tradesCount: 0,
        winsCount: 0,
        lossesCount: 0,
        accumulatedLoss: 0,
        currentProfitTarget: CONFIG.SESSION_PROFIT_TARGET,
        isActive: true,
        pausedUntil: 0,
        startTime: Date.now(),
        startCapital: CONFIG.INITIAL_CAPITAL
    },
    isConnected: false,
    isAuthorized: false,
    assets: {},
    portfolio: {
        dailyProfit: 0,
        dailyLoss: 0,
        dailyWins: 0,
        dailyLosses: 0,
        activePositions: [],
        topRankedAssets: [],
        lastScoring: Date.now()
    },
    subscriptions: new Map(),
    pendingRequests: new Map(),
    requestId: 1
};

/**
 * Initialize asset states with WPR-only tracking
 */
function initializeAssetStates() {
    ACTIVE_ASSETS.forEach(symbol => {
        if (ASSET_CONFIGS[symbol]) {
            state.assets[symbol] = {
                // Price data
                candles: [],
                ticks: [],
                currentPrice: 0,

                // CLOSED candle tracking for indicators
                closedCandles: [],
                lastClosedCandleEpoch: 0,
                lastProcessedCandleOpenTime: 0,
                priceReturnedToZone: false,

                // Current forming candle tracking
                currentFormingCandle: null,

                // WPR tracking
                wpr: -50,
                prevWpr: -50,

                // WPR Zone flags (PERSISTENT through trading lifecycle)
                buyFlagActive: false,      // Activated when WPR goes below -80
                sellFlagActive: false,     // Activated when WPR goes above -20

                // Breakout levels (PERSISTENT until replaced by opposite type)
                breakout: {
                    active: false,
                    type: null,            // 'BUY' or 'SELL' - which signal created this breakout
                    highLevel: 0,
                    lowLevel: 0,
                    triggerCandle: 0,
                    canBeReplaced: true    // Can new breakout replace this one?
                },

                // Active trade tracking
                activePosition: null, // Full position object
                activeContract: null, // Contract ID string (for cross-bot compatibility)
                unrealizedPnl: 0,     // Live P&L tracking
                currentDirection: null,

                // Trade cycle state
                inTradeCycle: false,       // Currently in active trade with reversals
                waitingForReentry: false,  // TP reached, waiting for price action
                lastTradeDirection: null,  // Last trade direction before TP

                // Stake management
                currentStake: CONFIG.INITIAL_STAKE,
                takeProfit: CONFIG.TAKE_PROFIT,
                reversalLevel: 0,
                accumulatedLoss: 0,
                takeProfitAmount: CONFIG.TAKE_PROFIT,

                // Stats
                dailyTrades: 0,
                dailyWins: 0,
                dailyLosses: 0,
                consecutiveLosses: 0,
                blacklistedUntil: 0,
                tradeHistory: [],
                winRate: 0.5,
                score: 0,
                lastBarTime: 0,

                // Indicator readiness
                indicatorsReady: false
            };
        }
    });
    LOGGER.info(`Initialized ${Object.keys(state.assets).length} assets`);
    LOGGER.info(`⏱️ Timeframe: ${CONFIG.TIMEFRAME_LABEL} (${CONFIG.GRANULARITY}s candles)`);
    LOGGER.info(`📊 Strategy: WPR ONLY - Signals on candle CLOSE`);
}

initializeAssetStates();

// FIX: Try to load saved state AFTER assets are initialized
const stateLoaded = StatePersistence.loadState();

if (stateLoaded) {
    LOGGER.info('🔄 Bot will resume from saved state after connection');
} else {
    LOGGER.info('🆕 Bot will start with fresh state');
}

// ============================================
// TECHNICAL INDICATORS (WPR ONLY)
// ============================================
class TechnicalIndicators {
    /**
     * Calculate Williams Percent Range (WPR) - ONLY on closed candles
     */
    static calculateWPR(candles, period = 80) {
        if (!candles || candles.length < period) {
            return -50;
        }

        const recentCandles = candles.slice(-period);
        const highs = recentCandles.map(c => c.high);
        const lows = recentCandles.map(c => c.low);
        const currentClose = recentCandles[recentCandles.length - 1].close;

        const highestHigh = Math.max(...highs);
        const lowestLow = Math.min(...lows);
        const range = highestHigh - lowestLow;

        if (range === 0) return -50;

        const wpr = ((highestHigh - currentClose) / range) * -100;
        return wpr;
    }
}

// ============================================
// SIGNAL MANAGER - WPR ONLY
// ============================================
class SignalManager {
    /**
     * Update WPR state and check for trading signals
     * Logic follows user requirements exactly
     */
    static updateWPRState(symbol) {
        const assetState = state.assets[symbol];
        const wpr = assetState.wpr;
        const prevWpr = assetState.prevWpr;

        // ============================================
        // FLAG ACTIVATION (Persistent through lifecycle)
        // ============================================

        // BUY flag activates when WPR goes below -80 (enters oversold)
        // This flag stays active until a BUY trade is executed
        if (wpr < CONFIG.WPR_OVERSOLD && !assetState.buyFlagActive) {
            assetState.buyFlagActive = true;
            LOGGER.wpr(`${symbol}: 🟢 BUY FLAG ACTIVATED - WPR entered oversold zone (${wpr.toFixed(2)})`);
        }

        // SELL flag activates when WPR goes above -20 (enters overbought)
        // This flag stays active until a SELL trade is executed
        if (wpr > CONFIG.WPR_OVERBOUGHT && !assetState.sellFlagActive) {
            assetState.sellFlagActive = true;
            LOGGER.wpr(`${symbol}: 🔴 SELL FLAG ACTIVATED - WPR entered overbought zone (${wpr.toFixed(2)})`);
        }

        // ============================================
        // SIGNAL DETECTION (Only when not in trade cycle)
        // ============================================

        if (!assetState.inTradeCycle && !assetState.waitingForReentry) {
            this.checkBuySignal(symbol);
            this.checkSellSignal(symbol);
        }
    }

    /**
     * Check for BUY signal - WPR crosses above -20
     * Requirements:
     * - Previous WPR ≤ -20, Current WPR > -20
     * - buyFlagActive must be true (came from oversold)
     * - No existing BUY breakout active (unless can be replaced by new SELL first)
     */
    static checkBuySignal(symbol) {
        const assetState = state.assets[symbol];
        const wpr = assetState.wpr;
        const prevWpr = assetState.prevWpr;

        // Check for crossing above -20
        const isCrossingAbove = (prevWpr <= CONFIG.WPR_OVERBOUGHT) && (wpr > CONFIG.WPR_OVERBOUGHT);

        if (isCrossingAbove && assetState.buyFlagActive) {
            // Check if we can create new BUY breakout levels
            // Only if no active BUY breakout, or breakout can be replaced
            if (!assetState.breakout.active ||
                assetState.breakout.type === 'SELL' ||
                assetState.breakout.canBeReplaced) {

                LOGGER.signal(`${symbol} 🟢 BUY SIGNAL TRIGGERED! WPR: ${wpr.toFixed(2)} (from ${prevWpr.toFixed(2)})`);

                // Execute BUY trade immediately
                const setupSuccess = BreakoutManager.setupBreakoutLevels(symbol, 'UP', 'BUY');
                if (setupSuccess) {
                    // Flag will be reset when opposite breakout type is created
                    bot.executeTrade(symbol, 'UP', false);
                    TelegramService.sendSignalAlert(symbol, 'BUY EXECUTED', wpr);
                }
            } else {
                LOGGER.debug(`${symbol}: BUY signal ignored - active BUY breakout exists`);
            }
        }
    }

    /**
     * Check for SELL signal - WPR crosses below -80
     * Requirements:
     * - Previous WPR ≥ -80, Current WPR < -80
     * - sellFlagActive must be true (came from overbought)
     * - No existing SELL breakout active (unless can be replaced by new BUY first)
     */
    static checkSellSignal(symbol) {
        const assetState = state.assets[symbol];
        const wpr = assetState.wpr;
        const prevWpr = assetState.prevWpr;

        // Check for crossing below -80
        const isCrossingBelow = (prevWpr >= CONFIG.WPR_OVERSOLD) && (wpr < CONFIG.WPR_OVERSOLD);

        if (isCrossingBelow && assetState.sellFlagActive) {
            // Check if we can create new SELL breakout levels
            if (!assetState.breakout.active ||
                assetState.breakout.type === 'BUY' ||
                assetState.breakout.canBeReplaced) {

                LOGGER.signal(`${symbol} 🔴 SELL SIGNAL TRIGGERED! WPR: ${wpr.toFixed(2)} (from ${prevWpr.toFixed(2)})`);

                // Execute SELL trade immediately
                const setupSuccess = BreakoutManager.setupBreakoutLevels(symbol, 'DOWN', 'SELL');
                if (setupSuccess) {
                    // Flag will be reset when opposite breakout type is created
                    bot.executeTrade(symbol, 'DOWN', false);
                    TelegramService.sendSignalAlert(symbol, 'SELL EXECUTED', wpr);
                }
            } else {
                LOGGER.debug(`${symbol}: SELL signal ignored - active SELL breakout exists`);
            }
        }
    }

    /**
     * Check for re-entry when waiting after TP reached
     * CORRECTED LOGIC:
     * 1. After TP, wait for price to return INSIDE the breakout zone
     * 2. Set priceReturnedToZone = true when this happens
     * 3. Only allow trade when price THEN closes beyond levels again
     */
    static checkReentrySignal(symbol) {
        const assetState = state.assets[symbol];
        const breakout = assetState.breakout;
        const closedCandles = assetState.closedCandles;

        if (!breakout.active) {
            return null;
        }

        if (closedCandles.length < 1) return null;

        const lastCandle = closedCandles[closedCandles.length - 1];
        const closePrice = lastCandle.close;

        // Check if price is between breakout levels (inside the zone)
        const isBetweenLevels = closePrice > breakout.lowLevel && closePrice < breakout.highLevel;

        // STEP 1: Track when price returns to the zone
        if (isBetweenLevels) {
            if (!assetState.priceReturnedToZone) {
                assetState.priceReturnedToZone = true;
                LOGGER.signal(`${symbol} 🔄 PRICE RETURNED TO BREAKOUT ZONE (${closePrice.toFixed(5)})`);
                LOGGER.signal(`${symbol} Zone: ${breakout.lowLevel.toFixed(5)} - ${breakout.highLevel.toFixed(5)}`);
                LOGGER.signal(`${symbol} Waiting for next breakout to trigger re-entry...`);
            }
            return null; // Stay waiting
        }

        // STEP 2: Only allow breakout trades AFTER price has returned to zone
        if (!assetState.priceReturnedToZone) {
            LOGGER.debug(`${symbol}: Price still outside zone - waiting for return (Current: ${closePrice.toFixed(5)})`);
            return null;
        }

        // STEP 3: Price closed above high level - BUY re-entry (only if returned to zone first)
        if (closePrice > breakout.highLevel) {
            LOGGER.signal(`${symbol} 🟢 RE-ENTRY BUY TRIGGERED!`);
            LOGGER.signal(`${symbol} Price ${closePrice.toFixed(5)} broke above ${breakout.highLevel.toFixed(5)}`);
            LOGGER.signal(`${symbol} Price had previously returned to zone ✓`);

            assetState.waitingForReentry = false;
            assetState.priceReturnedToZone = false; // Reset for next cycle
            return 'UP';
        }

        // STEP 4: Price closed below low level - SELL re-entry (only if returned to zone first)
        if (closePrice < breakout.lowLevel) {
            LOGGER.signal(`${symbol} 🔴 RE-ENTRY SELL TRIGGERED!`);
            LOGGER.signal(`${symbol} Price ${closePrice.toFixed(5)} broke below ${breakout.lowLevel.toFixed(5)}`);
            LOGGER.signal(`${symbol} Price had previously returned to zone ✓`);

            assetState.waitingForReentry = false;
            assetState.priceReturnedToZone = false; // Reset for next cycle
            return 'DOWN';
        }

        return null;
    }
}

// ============================================
// BREAKOUT MANAGER
// ============================================
class BreakoutManager {
    /**
     * Set breakout levels using the PREVIOUS candle
     * @param {string} symbol - Asset symbol
     * @param {string} direction - 'UP' or 'DOWN'
     * @param {string} breakoutType - 'BUY' or 'SELL' (which signal created this)
     */
    static setupBreakoutLevels(symbol, direction, breakoutType) {
        const assetState = state.assets[symbol];
        const closedCandles = assetState.closedCandles;

        if (closedCandles.length < 1) {
            LOGGER.warn(`${symbol}: Not enough closed candles for breakout setup`);
            return false;
        }

        // Use the PREVIOUS candle (2nd to last closed candle)
        const previousCandle = closedCandles[closedCandles.length - 1];

        assetState.breakout = {
            active: true,
            type: breakoutType,
            highLevel: previousCandle.high,
            lowLevel: previousCandle.low,
            triggerCandle: previousCandle.epoch,
            canBeReplaced: false  // Cannot be replaced until opposite type forms
        };

        assetState.inTradeCycle = true;
        assetState.waitingForReentry = false;

        // Reset opposite flag when creating breakout
        if (breakoutType === 'BUY') {
            assetState.sellFlagActive = false;
            LOGGER.debug(`${symbol}: Reset sellFlagActive (BUY breakout created)`);
        } else if (breakoutType === 'SELL') {
            assetState.buyFlagActive = false;
            LOGGER.debug(`${symbol}: Reset buyFlagActive (SELL breakout created)`);
        }

        LOGGER.breakout(`${symbol} � ${breakoutType} BREAKOUT LEVELS SET:`);
        LOGGER.breakout(`${symbol} High: ${previousCandle.high.toFixed(5)} | Low: ${previousCandle.low.toFixed(5)}`);
        LOGGER.breakout(`${symbol} Candle Epoch: ${previousCandle.epoch}`);

        TelegramService.sendBreakoutAlert(symbol, breakoutType, previousCandle.high, previousCandle.low);

        return true;
    }

    /**
     * Replace breakout levels with new opposite type
     * This happens when opposite WPR signal occurs during active trade
     */
    static replaceBreakoutLevels(symbol, direction, newType) {
        const assetState = state.assets[symbol];
        const closedCandles = assetState.closedCandles;

        if (closedCandles.length < 1) {
            return false;
        }

        const previousCandle = closedCandles[closedCandles.length - 1];

        LOGGER.breakout(`${symbol} 🔄 REPLACING ${assetState.breakout.type} breakout with ${newType}`);

        assetState.breakout = {
            active: true,
            type: newType,
            highLevel: previousCandle.high,
            lowLevel: previousCandle.low,
            triggerCandle: previousCandle.epoch,
            canBeReplaced: false
        };

        // Reset opposite flag when replacing with new type
        if (newType === 'BUY') {
            assetState.sellFlagActive = false;
            LOGGER.debug(`${symbol}: Reset sellFlagActive (replaced with BUY breakout)`);
        } else if (newType === 'SELL') {
            assetState.buyFlagActive = false;
            LOGGER.debug(`${symbol}: Reset buyFlagActive (replaced with SELL breakout)`);
        }

        LOGGER.breakout(`${symbol} New High: ${previousCandle.high.toFixed(5)} | Low: ${previousCandle.low.toFixed(5)}`);

        return true;
    }

    /**
     * Check for reversal on CANDLE CLOSE
     * Reversal triggers when price CLOSES beyond breakout levels
     */
    static checkReversal(symbol) {
        const assetState = state.assets[symbol];
        const breakout = assetState.breakout;
        const closedCandles = assetState.closedCandles;

        if (!assetState.inTradeCycle) {
            return null;
        }

        if (closedCandles.length < 1) {
            return null;
        }

        const lastClosedCandle = closedCandles[closedCandles.length - 1];
        const closePrice = lastClosedCandle.close;
        const currentDirection = assetState.currentDirection;

        // UP position: Reversal if price CLOSES BELOW the lower breakout level
        if (currentDirection === 'UP' && closePrice < breakout.lowLevel) {
            LOGGER.breakout(`${symbol} 🔄 REVERSAL TRIGGERED!`);
            LOGGER.breakout(`${symbol} UP → DOWN: Close ${closePrice.toFixed(5)} < Low ${breakout.lowLevel.toFixed(5)}`);
            return 'DOWN';
        }

        // DOWN position: Reversal if price CLOSES ABOVE the higher breakout level
        if (currentDirection === 'DOWN' && closePrice > breakout.highLevel) {
            LOGGER.breakout(`${symbol} 🔄 REVERSAL TRIGGERED!`);
            LOGGER.breakout(`${symbol} DOWN → UP: Close ${closePrice.toFixed(5)} > High ${breakout.highLevel.toFixed(5)}`);
            return 'UP';
        }

        return null;
    }

    /**
     * Check if opposite WPR signal occurs - replace breakout levels
     */
    static checkForBreakoutReplacement(symbol) {
        const assetState = state.assets[symbol];
        const wpr = assetState.wpr;
        const prevWpr = assetState.prevWpr;
        const breakout = assetState.breakout;

        if (!breakout.active || !assetState.inTradeCycle) {
            return null;
        }

        // If current breakout is BUY type, check for SELL signal to replace
        if (breakout.type === 'BUY') {
            const isCrossingBelow = (prevWpr >= CONFIG.WPR_OVERSOLD) && (wpr < CONFIG.WPR_OVERSOLD);
            if (isCrossingBelow && assetState.sellFlagActive) {
                LOGGER.signal(`${symbol} 🔴 NEW SELL BREAKOUT during BUY cycle`);
                this.replaceBreakoutLevels(symbol, 'DOWN', 'SELL');
                assetState.sellFlagActive = false;

                // If currently in UP position, trigger reversal to DOWN
                if (assetState.currentDirection === 'UP') {
                    return 'DOWN';
                }
            }
        }

        // If current breakout is SELL type, check for BUY signal to replace
        if (breakout.type === 'SELL') {
            const isCrossingAbove = (prevWpr <= CONFIG.WPR_OVERBOUGHT) && (wpr > CONFIG.WPR_OVERBOUGHT);
            if (isCrossingAbove && assetState.buyFlagActive) {
                LOGGER.signal(`${symbol} 🟢 NEW BUY BREAKOUT during SELL cycle`);
                this.replaceBreakoutLevels(symbol, 'UP', 'BUY');
                assetState.buyFlagActive = false;

                // If currently in DOWN position, trigger reversal to UP
                if (assetState.currentDirection === 'DOWN') {
                    return 'UP';
                }
            }
        }

        return null;
    }

    /**
     * Mark breakout as allowing re-entry (after TP reached)
     */
    static setWaitingForReentry(symbol) {
        const assetState = state.assets[symbol];

        assetState.inTradeCycle = false;
        assetState.waitingForReentry = true;
        assetState.lastTradeDirection = assetState.currentDirection;

        // Breakout levels stay active but can be replaced by opposite type
        assetState.breakout.canBeReplaced = true;

        LOGGER.breakout(`${symbol} ⏸️ TP REACHED - Breakout levels still active, waiting for re-entry`);
        LOGGER.breakout(`${symbol} High: ${assetState.breakout.highLevel.toFixed(5)} | Low: ${assetState.breakout.lowLevel.toFixed(5)}`);
    }

    /**
     * Fully clear breakout setup (only on max reversals)
     */
    static clearBreakout(symbol) {
        const assetState = state.assets[symbol];

        LOGGER.breakout(`${symbol} 🔓 BREAKOUT LEVELS CLEARED`);

        assetState.breakout = {
            active: false,
            type: null,
            highLevel: 0,
            lowLevel: 0,
            triggerCandle: 0,
            canBeReplaced: true
        };

        assetState.inTradeCycle = false;
        assetState.waitingForReentry = false;
        assetState.priceReturnedToZone = false;
    }
}

// ============================================
// STAKE MANAGER
// ============================================
class StakeManager {
    static getInitialStake(symbol) {
        const assetState = state.assets[symbol];
        assetState.currentStake = CONFIG.INITIAL_STAKE;
        assetState.takeProfit = CONFIG.TAKE_PROFIT;
        assetState.reversalLevel = 0;
        assetState.accumulatedLoss = 0;
        assetState.takeProfitAmount = CONFIG.TAKE_PROFIT;
        return this.validateStake(symbol, assetState.currentStake);
    }

    static getReversalStake(symbol, previousLoss = 0) {
        const assetState = state.assets[symbol];

        if (assetState.reversalLevel >= CONFIG.MAX_REVERSAL_LEVEL) {
            LOGGER.warn(`${symbol}: Max reversal level reached (${CONFIG.MAX_REVERSAL_LEVEL})`);
            return -1;
        }

        assetState.currentStake *= CONFIG.REVERSAL_STAKE_MULTIPLIER;
        assetState.reversalLevel++;

        if (previousLoss < 0) {
            assetState.accumulatedLoss += Math.abs(previousLoss);
        }

        assetState.takeProfitAmount = assetState.takeProfit + assetState.accumulatedLoss;

        LOGGER.trade(`${symbol} Reversal #${assetState.reversalLevel}/${CONFIG.MAX_REVERSAL_LEVEL}: Stake $${assetState.currentStake.toFixed(2)}`);
        LOGGER.trade(`${symbol} Dynamic TP: $${assetState.takeProfitAmount.toFixed(2)} (Base: $${assetState.takeProfit} + Loss: $${assetState.accumulatedLoss.toFixed(2)})`);

        return this.validateStake(symbol, assetState.currentStake);
    }

    static fullReset(symbol) {
        const assetState = state.assets[symbol];

        LOGGER.recovery(`${symbol} 🎉 FULL RESET - Trade cycle complete`);

        assetState.currentStake = CONFIG.INITIAL_STAKE;
        assetState.reversalLevel = 0;
        assetState.accumulatedLoss = 0;
        assetState.takeProfitAmount = CONFIG.TAKE_PROFIT;
        assetState.activePosition = null;
        assetState.currentDirection = null;
        assetState.inTradeCycle = false;
        assetState.priceReturnedToZone = false;

        // Don't clear breakout - it persists!
        // Just mark as waiting for re-entry
        if (assetState.breakout.active) {
            BreakoutManager.setWaitingForReentry(symbol);
        }
    }

    static fullResetWithBreakoutClear(symbol) {
        const assetState = state.assets[symbol];

        LOGGER.recovery(`${symbol} 🔄 FULL RESET WITH BREAKOUT CLEAR`);

        assetState.currentStake = CONFIG.INITIAL_STAKE;
        assetState.reversalLevel = 0;
        assetState.accumulatedLoss = 0;
        assetState.takeProfitAmount = CONFIG.TAKE_PROFIT;
        assetState.activePosition = null;
        assetState.currentDirection = null;
        assetState.inTradeCycle = false;
        assetState.waitingForReentry = false;
        assetState.priceReturnedToZone = false;

        BreakoutManager.clearBreakout(symbol);
    }

    static shouldAutoClose(symbol, currentProfit) {
        const assetState = state.assets[symbol];

        if (assetState.reversalLevel > 0 &&
            currentProfit > 0 &&
            currentProfit >= assetState.accumulatedLoss &&
            CONFIG.AUTO_CLOSE_ON_RECOVERY) {
            return true;
        }

        return false;
    }

    static validateStake(symbol, stake) {
        const config = ASSET_CONFIGS[symbol];
        stake = Math.max(stake, config.minStake);
        stake = Math.min(stake, config.maxStake);
        stake = Math.min(stake, state.capital * 0.10);

        if (stake < config.minStake) {
            LOGGER.error(`${symbol}: Cannot afford min stake`);
            return 0;
        }

        return parseFloat(stake.toFixed(2));
    }

    static getMultiplier(symbol) {
        const config = ASSET_CONFIGS[symbol];
        return config.defaultMultiplier || config.multipliers[0];
    }
}

// ============================================
// SESSION MANAGER
// ============================================
class SessionManager {
    static isSessionActive() {
        if (Date.now() < state.session.pausedUntil) {
            return false;
        }
        return state.session.isActive;
    }

    static checkSessionTargets() {
        const netPL = state.session.netPL;

        if (netPL >= state.session.currentProfitTarget) {
            LOGGER.trade(`🎯 SESSION PROFIT TARGET REACHED! Net P/L: $${netPL.toFixed(2)}`);
            this.endSession('PROFIT_TARGET');
            return true;
        }

        if (netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.error(`🛑 SESSION STOP LOSS REACHED! Net P/L: $${netPL.toFixed(2)}`);
            this.endSession('STOP_LOSS');
            return true;
        }

        return false;
    }

    static async endSession(reason) {
        state.session.isActive = false;
        await bot.closeAllPositions();
        state.session.pausedUntil = Date.now() + CONFIG.COOLDOWN_AFTER_SESSION_END;

        LOGGER.info(`⏸️ Session ended (${reason}).`);
        TelegramService.sendSessionSummary();

        setTimeout(() => {
            this.startNewSession();
        }, CONFIG.COOLDOWN_AFTER_SESSION_END);
    }

    static startNewSession() {
        state.session = {
            profit: 0,
            loss: 0,
            netPL: 0,
            tradesCount: 0,
            winsCount: 0,
            lossesCount: 0,
            accumulatedLoss: 0,
            currentProfitTarget: CONFIG.SESSION_PROFIT_TARGET,
            isActive: true,
            pausedUntil: 0,
            startTime: Date.now(),
            startCapital: state.capital
        };

        Object.keys(state.assets).forEach(symbol => {
            StakeManager.fullResetWithBreakoutClear(symbol);
            // Reset WPR flags for new session
            state.assets[symbol].buyFlagActive = false;
            state.assets[symbol].sellFlagActive = false;
        });

        LOGGER.info('🚀 NEW SESSION STARTED');
        LOGGER.info(`💰 Capital: $${state.capital.toFixed(2)} | Target: $${CONFIG.SESSION_PROFIT_TARGET}`);
    }

    static getSessionStats() {
        const duration = Date.now() - state.session.startTime;
        const hours = Math.floor(duration / 3600000);
        const minutes = Math.floor((duration % 3600000) / 60000);

        return {
            duration: `${hours}h ${minutes}m`,
            trades: state.session.tradesCount,
            wins: state.session.winsCount,
            losses: state.session.lossesCount,
            winRate: state.session.tradesCount > 0
                ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1) + '%'
                : '0%',
            netPL: state.session.netPL,
            profitTarget: state.session.currentProfitTarget
        };
    }
}

// ============================================
// RISK MANAGER
// ============================================
class RiskManager {
    static canTrade(isReversal = false) {
        if (!isReversal) {
            if (!SessionManager.isSessionActive()) return false;
            if (SessionManager.checkSessionTargets()) return false;
        }

        if (state.portfolio.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) return false;

        if (state.capital < CONFIG.INITIAL_STAKE) {
            LOGGER.error(`Insufficient capital: $${state.capital.toFixed(2)}`);
            return false;
        }

        return true;
    }

    static canAssetTrade(symbol) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];

        if (!assetState || !config) {
            return { allowed: false, reason: 'Asset not configured' };
        }

        if (!TradingHoursManager.isWithinTradingHours(symbol)) {
            return { allowed: false, reason: `Outside trading hours` };
        }

        if (assetState.dailyTrades >= config.maxTradesPerDay) {
            return { allowed: false, reason: `Daily trade limit reached` };
        }

        // if (Date.now() < assetState.blacklistedUntil) {
        //     return { allowed: false, reason: `Asset blacklisted` };
        // }

        return { allowed: true };
    }

    static recordTradeResult(symbol, profit, direction) {
        const assetState = state.assets[symbol];

        state.session.tradesCount++;
        state.capital += profit;

        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            assetState.dailyWins++;
            assetState.consecutiveLosses = 0;

            LOGGER.trade(`✅ WIN on ${symbol}: +$${profit.toFixed(2)}`);
            TelegramService.sendTradeAlert('WIN', symbol, direction, assetState.currentStake, StakeManager.getMultiplier(symbol), { profit });
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            assetState.dailyLosses++;
            assetState.consecutiveLosses++;

            LOGGER.trade(`❌ LOSS on ${symbol}: -$${Math.abs(profit).toFixed(2)}`);
        }

        assetState.tradeHistory.push({ timestamp: Date.now(), direction, profit });
        if (assetState.tradeHistory.length > 100) {
            assetState.tradeHistory = assetState.tradeHistory.slice(-100);
        }

        const recentTrades = assetState.tradeHistory.slice(-CONFIG.WIN_RATE_LOOKBACK);
        assetState.winRate = recentTrades.length > 0
            ? recentTrades.filter(t => t.profit > 0).length / recentTrades.length
            : 0.5;
    }
}

// ============================================
// TRADING HOURS MANAGER
// ============================================
class TradingHoursManager {
    static isWithinTradingHours(symbol) {
        const config = ASSET_CONFIGS[symbol];
        if (!config) return false;

        if (config.tradingHours === '24/7') {
            return true;
        }

        if (symbol === 'frxXAUUSD') {
            return this.checkGoldTradingHours();
        }

        return true;
    }

    static checkGoldTradingHours() {
        const now = new Date();
        const day = now.getUTCDay();
        const hours = now.getUTCHours();
        const minutes = now.getUTCMinutes();
        const timeInMinutes = hours * 60 + minutes;

        if (day === 6) return false;
        if (day === 0) return timeInMinutes >= 23 * 60;
        if (day === 5) return timeInMinutes < 21 * 60 + 55;
        return true;
    }
}

// ============================================
// CONNECTION MANAGER
// ============================================
class ConnectionManager {
    constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50; // Increased for better resilience
        this.reconnectDelay = 5000;
        this.pingInterval = null;
        this.checkDataInterval = null;
        this.contractMonitorInterval = null;
        this.lastDataTime = Date.now();
        this.isReconnecting = false;
        this.stalledContractChecks = new Map(); // Track stalled contracts
        this.autoSaveStarted = false;
    }

    connect() {
        LOGGER.info('🔌 Connecting to Deriv API...');
        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);

        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', (data) => this.onMessage(data));
        this.ws.on('error', (error) => this.onError(error));
        this.ws.on('close', () => this.onClose());

        return this.ws;
    }

    onOpen() {
        LOGGER.info('✅ Connected to Deriv API');
        state.isConnected = true;
        this.reconnectAttempts = 0;
        this.lastDataTime = Date.now();

        this.startMonitor();

        // FIX: Start auto-save after connection established
        if (!this.autoSaveStarted) {
            StatePersistence.startAutoSave();
            this.autoSaveStarted = true;
        }

        this.send({ authorize: CONFIG.API_TOKEN });

        // If reconnecting, we need to restore subscriptions after authorization
        if (this.isReconnecting) {
            LOGGER.info('🔄 Reconnection detected - will restore subscriptions after auth');
        }
    }

    /**
     * Restore open contract subscriptions after reconnection
     */
    async restoreOpenContracts() {
        const activePositions = state.portfolio.activePositions.filter(p => p.contractId);

        if (activePositions.length === 0) {
            LOGGER.info('📋 No open contracts to restore');
            return;
        }

        LOGGER.info(`📋 Restoring ${activePositions.length} open contract subscriptions...`);

        for (const position of activePositions) {
            // Re-subscribe to contract updates
            this.send({
                proposal_open_contract: 1,
                contract_id: position.contractId,
                subscribe: 1
            });

            // Link position to asset state
            if (state.assets[position.symbol]) {
                state.assets[position.symbol].activePosition = position;
            }

            LOGGER.info(`  ✅ Restored subscription for ${position.symbol} contract ${position.contractId}`);
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    onMessage(data) {
        this.lastDataTime = Date.now();
        try {
            const response = JSON.parse(data);
            this.handleResponse(response);
        } catch (error) {
            LOGGER.error(`Error parsing message: ${error.message}`);
        }
    }

    handleResponse(response) {
        if (response.msg_type === 'authorize') {
            if (response.error) {
                LOGGER.error(`Authorization failed: ${response.error.message}`);
                return;
            }
            LOGGER.info('🔐 Authorized successfully');
            LOGGER.info(`👤 Account: ${response.authorize.loginid}`);
            LOGGER.info(`💰 Balance: ${response.authorize.balance} ${response.authorize.currency}`);

            state.isAuthorized = true;
            state.accountBalance = response.authorize.balance;

            if (state.capital === CONFIG.INITIAL_CAPITAL) {
                state.capital = response.authorize.balance;
                LOGGER.info(`⚖️ Session capital: $${state.capital.toFixed(2)}`);
            }

            // Handle reconnection vs fresh start
            if (this.isReconnecting) {
                LOGGER.info('🔄 Handling reconnection...');
                this.isReconnecting = false;

                // Restore open contract subscriptions
                this.restoreOpenContracts();

                // Re-subscribe to assets
                bot.subscribeToAssets();

                // Re-subscribe to balance
                this.send({ balance: 1, subscribe: 1 });

                TelegramService.sendMessage(`🔄 <b>BOT RECONNECTED</b>\nRestored ${state.portfolio.activePositions.length} open positions\nTime: ${new Date().toUTCString()}`);
            } else {
                bot.start();
            }
        }

        if (response.msg_type === 'tick') {
            this.handleTick(response.tick);
        }

        if (response.msg_type === 'ohlc') {
            this.handleOHLC(response.ohlc);
        }

        if (response.msg_type === 'candles') {
            this.handleCandlesHistory(response);
        }

        if (response.msg_type === 'buy') {
            this.handleBuyResponse(response);
        }

        if (response.msg_type === 'sell') {
            this.handleSellResponse(response);
        }

        if (response.msg_type === 'proposal_open_contract') {
            this.handleOpenContract(response);
        }

        if (response.msg_type === 'balance') {
            state.accountBalance = response.balance.balance;
        }
    }

    handleTick(tick) {
        const symbol = tick.symbol;
        if (!state.assets[symbol]) return;

        const assetState = state.assets[symbol];
        assetState.currentPrice = tick.quote;
        assetState.ticks.push(tick.quote);

        if (assetState.ticks.length > CONFIG.MAX_TICKS_STORED) {
            assetState.ticks = assetState.ticks.slice(-CONFIG.MAX_TICKS_STORED);
        }
    }

    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        if (!state.assets[symbol]) return;

        const assetState = state.assets[symbol];
        const calculatedOpenTime = ohlc.open_time ||
            Math.floor(ohlc.epoch / CONFIG.GRANULARITY) * CONFIG.GRANULARITY;

        const incomingCandle = {
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close),
            epoch: ohlc.epoch,
            open_time: calculatedOpenTime
        };

        const currentOpenTime = assetState.currentFormingCandle?.open_time;
        const isNewCandle = currentOpenTime && incomingCandle.open_time !== currentOpenTime;

        if (isNewCandle) {
            const closedCandle = { ...assetState.currentFormingCandle };
            closedCandle.epoch = closedCandle.open_time + CONFIG.GRANULARITY;

            if (closedCandle.open_time !== assetState.lastProcessedCandleOpenTime) {
                assetState.closedCandles.push(closedCandle);

                if (assetState.closedCandles.length > CONFIG.MAX_CANDLES_STORED) {
                    assetState.closedCandles = assetState.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED);
                }

                assetState.lastProcessedCandleOpenTime = closedCandle.open_time;

                const closeTime = new Date(closedCandle.epoch * 1000).toISOString();
                LOGGER.candle(`${symbol} 🕯️ CANDLE CLOSED [${closeTime}]: O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)}`);

                this.processCandleClose(symbol);
            }
        }

        assetState.currentFormingCandle = incomingCandle;

        const candles = assetState.candles;
        const existingIndex = candles.findIndex(c => c.open_time === incomingCandle.open_time);
        if (existingIndex >= 0) {
            candles[existingIndex] = incomingCandle;
        } else {
            candles.push(incomingCandle);
        }

        if (candles.length > CONFIG.MAX_CANDLES_STORED) {
            assetState.candles = candles.slice(-CONFIG.MAX_CANDLES_STORED);
        }
    }

    handleCandlesHistory(response) {
        if (response.error) {
            LOGGER.error(`Error fetching candles: ${response.error.message}`);
            return;
        }

        const symbol = response.echo_req.ticks_history;
        if (!state.assets[symbol]) return;

        const candles = response.candles.map(c => {
            const openTime = Math.floor((c.epoch - CONFIG.GRANULARITY) / CONFIG.GRANULARITY) * CONFIG.GRANULARITY;
            return {
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close),
                epoch: c.epoch,
                open_time: openTime
            };
        });

        if (candles.length === 0) {
            LOGGER.warn(`${symbol}: No historical candles received`);
            return;
        }

        state.assets[symbol].candles = [...candles];
        state.assets[symbol].closedCandles = [...candles];

        const lastCandle = candles[candles.length - 1];
        state.assets[symbol].lastProcessedCandleOpenTime = lastCandle.open_time;
        state.assets[symbol].currentFormingCandle = null;

        LOGGER.info(`📊 Loaded ${candles.length} ${CONFIG.TIMEFRAME_LABEL} candles for ${symbol}`);

        this.updateIndicators(symbol);
        state.assets[symbol].indicatorsReady = true;
    }

    updateIndicators(symbol) {
        const assetState = state.assets[symbol];
        const closedCandles = assetState.closedCandles;

        if (closedCandles.length < CONFIG.WPR_PERIOD) {
            LOGGER.debug(`${symbol}: Not enough candles for WPR (${closedCandles.length}/${CONFIG.WPR_PERIOD})`);
            assetState.indicatorsReady = false;
            return;
        }

        // Store previous WPR before updating
        assetState.prevWpr = assetState.wpr;

        // Calculate WPR on CLOSED candles only
        assetState.wpr = TechnicalIndicators.calculateWPR(closedCandles, CONFIG.WPR_PERIOD);
        assetState.indicatorsReady = true;

        LOGGER.debug(`${symbol} WPR: ${assetState.wpr.toFixed(2)} (prev: ${assetState.prevWpr.toFixed(2)}) | BuyFlag: ${assetState.buyFlagActive} | SellFlag: ${assetState.sellFlagActive}`);
    }

    processCandleClose(symbol) {
        const assetState = state.assets[symbol];
        const closedCandles = assetState.closedCandles;

        if (closedCandles.length < CONFIG.WPR_PERIOD) {
            LOGGER.debug(`${symbol}: Not enough candles for processing`);
            return;
        }

        // 1. Update WPR indicator
        this.updateIndicators(symbol);

        if (!assetState.indicatorsReady) {
            return;
        }

        // 2. Update WPR state and check for signals
        SignalManager.updateWPRState(symbol);

        // 3. Check for breakout replacement during active trade
        if (assetState.inTradeCycle && assetState.activePosition) {
            const replacementReversal = BreakoutManager.checkForBreakoutReplacement(symbol);
            if (replacementReversal) {
                bot.executeReversal(symbol, replacementReversal);
                return;
            }
        }

        // 4. Check for reversal if in active trade
        if (assetState.activePosition && assetState.breakout.active) {
            const reversal = BreakoutManager.checkReversal(symbol);
            if (reversal) {
                bot.executeReversal(symbol, reversal);
                return;
            }
        }

        // 5. Check for re-entry if waiting after TP
        if (assetState.waitingForReentry) {
            const reentry = SignalManager.checkReentrySignal(symbol);
            if (reentry) {
                assetState.inTradeCycle = true;
                bot.executeTrade(symbol, reentry, false);
            }
        }

        // Log status
        LOGGER.debug(`${symbol} STATUS | WPR: ${assetState.wpr.toFixed(2)} | BuyFlag: ${assetState.buyFlagActive} | SellFlag: ${assetState.sellFlagActive} | InCycle: ${assetState.inTradeCycle} | Waiting: ${assetState.waitingForReentry} | Breakout: ${assetState.breakout.type || 'none'}`);
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);
            const reqId = response.echo_req?.req_id;
            if (reqId) {
                const posIndex = state.portfolio.activePositions.findIndex(p => p.reqId === reqId);
                if (posIndex >= 0) {
                    const pos = state.portfolio.activePositions[posIndex];
                    if (state.assets[pos.symbol]) {
                        state.assets[pos.symbol].activePosition = null;
                        state.assets[pos.symbol].currentDirection = null;
                        if (state.assets[pos.symbol].reversalLevel === 0) {
                            StakeManager.fullReset(pos.symbol);
                        }
                    }
                    state.portfolio.activePositions.splice(posIndex, 1);
                }
            }
            return;
        }

        const contract = response.buy;
        LOGGER.trade(`✅ Position opened: Contract ${contract.contract_id}, Buy Price: $${contract.buy_price}`);

        const reqId = response.echo_req.req_id;
        const position = state.portfolio.activePositions.find(p => p.reqId === reqId);

        if (position) {
            position.contractId = contract.contract_id;
            position.buyPrice = contract.buy_price;

            if (state.assets[position.symbol]) {
                state.assets[position.symbol].activePosition = position;
                state.assets[position.symbol].activeContract = contract.contract_id;
                state.assets[position.symbol].unrealizedPnl = 0;
            }

            // Send appropriate notification based on trade type
            if (position.isReversal) {
                const assetState = state.assets[position.symbol];
                TelegramService.sendReversalAlert(
                    position.symbol,
                    position.direction,
                    position.stake,
                    assetState.accumulatedLoss,
                    position.reversalLevel,
                    CONFIG.MAX_REVERSAL_LEVEL,
                    assetState.breakout.highLevel,
                    assetState.breakout.lowLevel
                );
                LOGGER.trade(`📱 Reversal notification sent for ${position.symbol}`);
            } else {
                TelegramService.sendTradeAlert('OPEN', position.symbol, position.direction, position.stake, position.multiplier, {
                    reversalLevel: position.reversalLevel,
                    breakoutType: state.assets[position.symbol]?.breakout?.type
                });
            }
        }

        this.send({
            proposal_open_contract: 1,
            contract_id: contract.contract_id,
            subscribe: 1
        });
    }

    handleSellResponse(response) {
        if (response.error) {
            LOGGER.error(`Sell error: ${response.error.message}`);
            return;
        }

        const sold = response.sell;
        LOGGER.trade(`✅ Position closed: Contract ${sold.contract_id}, Sold at: $${sold.sold_for}`);

        const posIndex = state.portfolio.activePositions.findIndex(
            p => p.contractId === sold.contract_id
        );

        if (posIndex >= 0) {
            const position = state.portfolio.activePositions[posIndex];
            const profit = sold.sold_for - position.buyPrice;

            // FIX: Store reversal info BEFORE removing position
            const pendingReversalDirection = position.pendingReversal;
            const isReversalPending = !!pendingReversalDirection;
            const symbol = position.symbol;

            RiskManager.recordTradeResult(position.symbol, profit, position.direction);
            state.portfolio.activePositions.splice(posIndex, 1);

            const assetState = state.assets[symbol];

            if (assetState) {
                // Clear active position tracking
                assetState.activePosition = null;
                assetState.activeContract = null;
                assetState.unrealizedPnl = 0;
                assetState.currentDirection = null;

                if (position.isRecoveryClose) {
                    LOGGER.recovery(`${symbol}: Recovery close completed. Profit: $${profit.toFixed(2)}`);
                    StakeManager.fullReset(symbol);
                } else if (isReversalPending) {
                    // FIX: Execute reversal immediately (removed setTimeout)
                    const lossAmount = profit < 0 ? profit : 0;

                    LOGGER.trade(`🔄 REVERSAL TRIGGERED: ${symbol} → ${pendingReversalDirection}`);
                    LOGGER.trade(`   Previous Loss: $${Math.abs(lossAmount).toFixed(2)}`);
                    LOGGER.trade(`   Current Reversal Level: ${assetState.reversalLevel}`);
                    LOGGER.trade(`   Next Stake: $${(assetState.currentStake * CONFIG.REVERSAL_STAKE_MULTIPLIER).toFixed(2)}`);

                    // Execute reversal trade immediately
                    bot.executeTrade(symbol, pendingReversalDirection, true, lossAmount);

                    LOGGER.trade(`✅ Reversal trade executed for ${symbol}`);

                } else if (position.isMaxReversalClose) {
                    LOGGER.warn(`${symbol}: Max reversals reached. Full reset with breakout clear.`);
                    StakeManager.fullResetWithBreakoutClear(symbol);
                } else {
                    // Normal close
                    if (profit > 0) {
                        if (assetState.reversalLevel > 0) {
                            if (profit >= assetState.accumulatedLoss) {
                                StakeManager.fullReset(symbol);
                            }
                        } else {
                            StakeManager.fullReset(symbol);
                        }
                    }
                }
            }
        }
    }

    handleOpenContract(response) {
        if (response.error) {
            LOGGER.error(`Contract error: ${response.error.message}`);
            return;
        }

        const contract = response.proposal_open_contract;
        const contractId = contract.contract_id;
        const posIndex = state.portfolio.activePositions.findIndex(
            p => p.contractId === contractId
        );

        // Check if contract is closed/sold
        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
            const profit = contract.profit;
            const symbol = contract.underlying;

            // Clear stalled check tracking
            this.stalledContractChecks.delete(contractId);

            LOGGER.trade(`Contract ${contractId} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`);

            if (posIndex >= 0) {
                const position = state.portfolio.activePositions[posIndex];
                RiskManager.recordTradeResult(symbol, profit, position.direction);
                state.portfolio.activePositions.splice(posIndex, 1);

                if (state.assets[symbol]) {
                    state.assets[symbol].activePosition = null;
                    state.assets[symbol].activeContract = null;
                    state.assets[symbol].unrealizedPnl = 0;
                    state.assets[symbol].currentDirection = null;

                    if (profit > 0) {
                        LOGGER.recovery(`${symbol} 🎉 WIN! Trade cycle TP reached.`);
                        StakeManager.fullReset(symbol);
                    }
                }
            }

            SessionManager.checkSessionTargets();
            StatePersistence.saveState(); // Save state after trade closes

            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }
        } else if (posIndex >= 0) {
            const position = state.portfolio.activePositions[posIndex];
            const previousProfit = position.currentProfit;
            position.currentProfit = contract.profit;
            position.currentPrice = contract.current_spot;

            const assetState = state.assets[position.symbol];
            if (assetState) {
                assetState.unrealizedPnl = contract.profit;
                assetState.currentPrice = contract.current_spot;
            }

            // ============================================
            // STALLED CONTRACT DETECTION
            // ============================================
            // Check if profit hasn't changed (potential TP/SL hit but not closed)
            if (previousProfit !== undefined && previousProfit === contract.profit) {
                const checkData = this.stalledContractChecks.get(contractId) || { count: 0, lastProfit: contract.profit };
                checkData.count++;

                // If profit unchanged for 10+ checks (about 10 seconds), force close
                if (checkData.count >= 10) {
                    LOGGER.warn(`${position.symbol}: Contract ${contractId} appears STALLED (profit unchanged: $${contract.profit.toFixed(2)}) - forcing close`);

                    // Check if it hit TP or SL
                    const hitTP = contract.limit_order?.take_profit?.order_amount &&
                        contract.profit >= (contract.limit_order.take_profit.order_amount * 0.95);
                    const hitSL = contract.limit_order?.stop_loss?.order_amount &&
                        contract.profit <= -(contract.limit_order.stop_loss.order_amount * 0.95);

                    if (hitTP || hitSL || checkData.count >= 20) {
                        LOGGER.warn(`${position.symbol}: Force closing stalled contract (hitTP=${hitTP}, hitSL=${hitSL})`);
                        this.send({ sell: contractId, price: 0 });
                        this.stalledContractChecks.delete(contractId);
                    }
                }

                this.stalledContractChecks.set(contractId, checkData);
            } else {
                // Profit changed, reset stalled counter
                this.stalledContractChecks.set(contractId, { count: 0, lastProfit: contract.profit });
            }

            // Check if contract status indicates it should be closed
            if (contract.status === 'won' || contract.status === 'lost') {
                LOGGER.warn(`${position.symbol}: Contract status is '${contract.status}' but still open - forcing close`);
                this.send({ sell: contractId, price: 0 });
            }

            // Auto close on recovery
            if (assetState && StakeManager.shouldAutoClose(position.symbol, contract.profit)) {
                LOGGER.recovery(`${position.symbol}: Profit $${contract.profit.toFixed(2)} >= Loss $${assetState.accumulatedLoss.toFixed(2)} - AUTO CLOSING`);
                position.isRecoveryClose = true;
                this.send({ sell: contractId, price: 0 });
            }
        }
    }

    onError(error) {
        LOGGER.error(`WebSocket error: ${error.message}`);
    }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;

        this.stopMonitor();

        // Save state immediately on disconnect
        StatePersistence.saveState();

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.isReconnecting = true;

            // Exponential backoff with max 30 seconds
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

            TelegramService.sendMessage(`⚠️ <b>CONNECTION LOST</b>\nReconnecting... (attempt ${this.reconnectAttempts})\nOpen positions: ${state.portfolio.activePositions.length}\nTime: ${new Date().toUTCString()}`);

            setTimeout(() => this.connect(), delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            TelegramService.sendMessage(`🛑 <b>BOT STOPPED</b>\nMax reconnection attempts reached.\nPlease restart manually.\nTime: ${new Date().toUTCString()}`);

            // Save final state before exit
            StatePersistence.saveState();
            process.exit(1);
        }
    }

    startMonitor() {
        this.stopMonitor();

        // Ping to keep connection alive
        this.pingInterval = setInterval(() => {
            if (state.isConnected) {
                this.send({ ping: 1 });
            }
        }, 20000);

        // Check for data silence
        this.checkDataInterval = setInterval(() => {
            if (!state.isConnected) return;

            const silenceDuration = Date.now() - this.lastDataTime;
            if (silenceDuration > 60000) {
                LOGGER.error(`⚠️ No data for ${Math.round(silenceDuration / 1000)}s - Forcing reconnection...`);
                StatePersistence.saveState();
                if (this.ws) this.ws.terminate();
            }
        }, 10000);

        // Contract monitoring - every 10 seconds
        this.contractMonitorInterval = setInterval(() => {
            if (!state.isConnected || !state.isAuthorized) return;

            const activePositions = state.portfolio.activePositions.filter(p => p.contractId);

            if (activePositions.length === 0) return;

            // Re-request contract status
            for (const position of activePositions) {
                this.send({
                    proposal_open_contract: 1,
                    contract_id: position.contractId
                });

                // Check for very long-running trades
                const duration = Date.now() - position.entryTime;
                if (duration > 3600000) { // 1 hour
                    LOGGER.warn(`${position.symbol}: Contract ${position.contractId} open for ${Math.round(duration / 60000)}min`);
                }
            }

            // Log active contracts summary
            const logs = activePositions.map(p => {
                const profit = p.currentProfit || 0;
                const color = profit >= 0 ? '\x1b[32m' : '\x1b[31m';
                const duration = Math.floor((Date.now() - p.entryTime) / 1000);
                return `${p.symbol}: ${color}$${profit.toFixed(2)}\x1b[0m (Rev: ${p.reversalLevel}/${CONFIG.MAX_REVERSAL_LEVEL}, ${duration}s)`;
            });
            LOGGER.trade(`📊 Active: ${logs.join(' | ')}`);
        }, 10000);

        // FIX: NEW - Detailed active trades logging every 60 seconds
        this.activeTradesLogInterval = setInterval(() => {
            if (!state.isConnected || !state.isAuthorized) return;

            const activePositions = state.portfolio.activePositions.filter(p => p.contractId);

            if (activePositions.length === 0) {
                LOGGER.debug('📊 No active trades');
                return;
            }

            LOGGER.info(`\n${'═'.repeat(100)}`);
            LOGGER.info(`📊 ACTIVE TRADES SUMMARY (${activePositions.length} positions)`);
            LOGGER.info('─'.repeat(100));

            activePositions.forEach((p, idx) => {
                const profit = p.currentProfit || 0;
                const duration = Math.floor((Date.now() - p.entryTime) / 1000);
                const minutes = Math.floor(duration / 60);
                const seconds = duration % 60;
                const profitColor = profit >= 0 ? '\x1b[32m' : '\x1b[31m';
                const assetState = state.assets[p.symbol];

                LOGGER.info(`${idx + 1}. ${p.symbol.padEnd(10)} | ${p.direction.padEnd(4)} | $${p.stake.toFixed(2).padEnd(8)} x${p.multiplier}`);
                LOGGER.info(`   P/L: ${profitColor}$${profit.toFixed(2)}\x1b[0m | Rev: ${p.reversalLevel}/${CONFIG.MAX_REVERSAL_LEVEL} | Time: ${minutes}m ${seconds}s`);
                if (assetState && assetState.breakout.active) {
                    LOGGER.info(`   Breakout: ${assetState.breakout.type} | High: ${assetState.breakout.highLevel.toFixed(5)} | Low: ${assetState.breakout.lowLevel.toFixed(5)}`);
                }
                LOGGER.info('');
            });

            const totalProfit = activePositions.reduce((sum, p) => sum + (p.currentProfit || 0), 0);
            const totalColor = totalProfit >= 0 ? '\x1b[32m' : '\x1b[31m';
            LOGGER.info(`💰 Total Unrealized P/L: ${totalColor}$${totalProfit.toFixed(2)}\x1b[0m`);

            // Add session statistics
            LOGGER.info('─'.repeat(100));
            LOGGER.info(`📈 SESSION STATS:`);
            const sessionPLColor = state.session.netPL >= 0 ? '\x1b[32m' : '\x1b[31m';
            LOGGER.info(`   Session P/L: ${sessionPLColor}$${state.session.netPL.toFixed(2)}\x1b[0m | Trades: ${state.session.tradesCount} (W:${state.session.winsCount} L:${state.session.lossesCount})`);
            const sessionWinRate = state.session.tradesCount > 0
                ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1)
                : '0.0';
            LOGGER.info(`   Win Rate: ${sessionWinRate}% | Capital: $${state.capital.toFixed(2)}`);
            LOGGER.info('═'.repeat(100) + '\n');
        }, 60000); // Every 60 seconds
    }

    stopMonitor() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.checkDataInterval) clearInterval(this.checkDataInterval);
        if (this.contractMonitorInterval) clearInterval(this.contractMonitorInterval);
        if (this.activeTradesLogInterval) clearInterval(this.activeTradesLogInterval); // FIX: Clear new interval
    }

    send(data) {
        if (!state.isConnected) {
            LOGGER.error('Cannot send: Not connected');
            return null;
        }

        data.req_id = state.requestId++;
        this.ws.send(JSON.stringify(data));
        return data.req_id;
    }
}

// ============================================
// MAIN BOT CLASS
// ============================================
class DerivBot {
    constructor() {
        this.connection = new ConnectionManager();
    }

    async start() {
        console.log('\n' + '═'.repeat(90));
        console.log(' DERIV MULTIPLIER BOT v7.0 - WPR ONLY STRATEGY');
        console.log(' Persistent Breakout Levels - Signals on CANDLE CLOSE');
        console.log('═'.repeat(90));
        console.log(`💰 Initial Capital: $${state.capital}`);
        console.log(`📊 Active Assets: ${ACTIVE_ASSETS.length} (${ACTIVE_ASSETS.join(', ')})`);
        console.log(`⏱️ Timeframe: ${CONFIG.TIMEFRAME_LABEL} (${CONFIG.GRANULARITY} seconds)`);
        console.log(`🎯 Session Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`);
        console.log(`🔄 Max Reversals: ${CONFIG.MAX_REVERSAL_LEVEL} | Multiplier: ${CONFIG.REVERSAL_STAKE_MULTIPLIER}x`);
        console.log(`📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ENABLED' : 'DISABLED'}`);
        console.log('═'.repeat(90));
        console.log('📋 WPR ONLY Strategy:');
        console.log(' BUY: WPR crosses above -20 (must have visited -80 first) → Execute immediately');
        console.log(' SELL: WPR crosses below -80 (must have visited -20 first) → Execute immediately');
        console.log(' Breakout levels persist until replaced by opposite type');
        console.log(' After TP: Wait for re-entry when price closes beyond levels');
        console.log('═'.repeat(90) + '\n');

        this.connection.send({ balance: 1, subscribe: 1 });

        await this.subscribeToAssets();

        SessionManager.startNewSession();
        TelegramService.sendStartupMessage();

        if (CONFIG.TELEGRAM_ENABLED) {
            // Active Position Updates every 30 minutes
            setInterval(() => {
                TelegramService.sendActivePositionsUpdate();
            }, 30 * 60 * 1000);

            // Session Summary every hour
            setInterval(() => {
                TelegramService.sendSessionSummary();
            }, 60 * 60 * 1000);

            // FIX: Send first active position update after 1 minute
            setTimeout(() => {
                TelegramService.sendActivePositionsUpdate();
            }, 60000);

            LOGGER.info('📱 Telegram notifications scheduled:');
            LOGGER.info('   - Active Position Update: Every 30 minutes (first in 1 min)');
            LOGGER.info('   - Session Summary: Every 60 minutes');
        }

        LOGGER.info('✅ Bot started successfully!');
    }

    async subscribeToAssets() {
        const symbols = Object.keys(state.assets);

        for (const symbol of symbols) {
            const config = ASSET_CONFIGS[symbol];
            if (!config) continue;

            this.connection.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: 100,
                end: 'latest',
                granularity: CONFIG.GRANULARITY,
                style: 'candles'
            });

            this.connection.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: 1,
                end: 'latest',
                granularity: CONFIG.GRANULARITY,
                style: 'candles',
                subscribe: 1
            });

            this.connection.send({
                ticks: symbol,
                subscribe: 1
            });

            LOGGER.info(`📡 Subscribed to ${config.name} (${symbol}) - ${CONFIG.TIMEFRAME_LABEL}`);
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    executeTrade(symbol, direction, isReversal = false, previousLoss = 0) {
        if (!RiskManager.canTrade(isReversal)) return;

        const assetCheck = RiskManager.canAssetTrade(symbol);
        if (!assetCheck.allowed) {
            LOGGER.debug(`Trade blocked: ${assetCheck.reason}`);
            return;
        }

        const config = ASSET_CONFIGS[symbol];
        const assetState = state.assets[symbol];

        const hasExisting = state.portfolio.activePositions.some(p => p.symbol === symbol);
        if (hasExisting) {
            LOGGER.warn(`Trade blocked: Already have active position on ${symbol}`);
            return;
        }

        let stake;
        if (isReversal) {
            stake = StakeManager.getReversalStake(symbol, previousLoss);
            if (stake === -1) {
                LOGGER.warn(`${symbol}: Max reversals reached - ending trade cycle`);
                StakeManager.fullResetWithBreakoutClear(symbol);
                return;
            }
            // Notification will be sent in handleBuyResponse after trade is confirmed
        } else {
            stake = StakeManager.getInitialStake(symbol);
        }

        if (stake <= 0) {
            LOGGER.error(`Cannot trade ${symbol}: Insufficient stake`);
            return;
        }

        const contractType = direction === 'UP' ? 'MULTUP' : 'MULTDOWN';
        const multiplier = StakeManager.getMultiplier(symbol);

        LOGGER.trade(`🎯 ${isReversal ? 'REVERSAL' : 'NEW'} ${direction} on ${config.name}`);
        LOGGER.trade(` Stake: $${stake.toFixed(2)} | Multiplier: x${multiplier} | Rev: ${assetState.reversalLevel}/${CONFIG.MAX_REVERSAL_LEVEL}`);
        LOGGER.trade(` Breakout: ${assetState.breakout.type} | High: ${assetState.breakout.highLevel.toFixed(5)} | Low: ${assetState.breakout.lowLevel.toFixed(5)}`);

        const position = {
            symbol,
            direction,
            stake,
            multiplier,
            entryTime: Date.now(),
            contractId: null,
            reqId: null,
            currentProfit: 0,
            buyPrice: 0,
            isReversal,
            reversalLevel: assetState.reversalLevel,
            pendingReversal: null,
            isRecoveryClose: false,
            isMaxReversalClose: false
        };

        state.portfolio.activePositions.push(position);

        const tradeRequest = {
            buy: 1,
            subscribe: 1,
            price: stake,
            parameters: {
                contract_type: contractType,
                symbol: symbol,
                currency: 'USD',
                amount: stake,
                multiplier: multiplier,
                basis: 'stake'
            }
        };

        if (assetState.takeProfitAmount > 0) {
            tradeRequest.parameters.limit_order = {
                take_profit: assetState.takeProfitAmount
            };
        }

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;

        assetState.dailyTrades++;
        assetState.currentDirection = direction;
    }

    executeReversal(symbol, newDirection) {
        const assetState = state.assets[symbol];
        const position = assetState.activePosition;

        if (!position || !position.contractId) {
            LOGGER.warn(`No active position to reverse on ${symbol}`);
            return;
        }

        if (assetState.reversalLevel >= CONFIG.MAX_REVERSAL_LEVEL) {
            LOGGER.warn(`${symbol}: Max reversals (${CONFIG.MAX_REVERSAL_LEVEL}) reached - closing position`);
            position.isMaxReversalClose = true;
            this.connection.send({ sell: position.contractId, price: 0 });
            return;
        }

        LOGGER.trade(`🔄 REVERSING ${symbol}: ${position.direction} → ${newDirection} (#${assetState.reversalLevel + 1})`);

        position.pendingReversal = newDirection;
        this.connection.send({ sell: position.contractId, price: 0 });
    }

    async closeAllPositions() {
        LOGGER.info('🔒 Closing all positions...');

        for (const position of state.portfolio.activePositions) {
            if (position.contractId) {
                this.connection.send({ sell: position.contractId, price: 0 });
                LOGGER.info(`Closing: ${position.symbol} ${position.direction}`);
            }
        }
    }

    stop() {
        LOGGER.info('🛑 Stopping bot...');
        this.closeAllPositions();

        setTimeout(() => {
            if (this.connection.ws) this.connection.ws.close();
            LOGGER.info('👋 Bot stopped');
        }, 2000);
    }

    getStatus() {
        const sessionStats = SessionManager.getSessionStats();

        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            accountBalance: state.accountBalance,
            session: sessionStats,
            timeframe: CONFIG.TIMEFRAME_LABEL,
            activePositionsCount: state.portfolio.activePositions.length,
            activePositions: state.portfolio.activePositions.map(pos => ({
                symbol: pos.symbol,
                direction: pos.direction,
                stake: pos.stake,
                multiplier: pos.multiplier,
                profit: pos.currentProfit,
                reversalLevel: pos.reversalLevel,
                duration: Math.floor((Date.now() - pos.entryTime) / 1000)
            })),
            assetStats: Object.entries(state.assets).map(([symbol, data]) => ({
                symbol,
                wpr: data.wpr.toFixed(1),
                buyFlag: data.buyFlagActive ? '🟢' : '-',
                sellFlag: data.sellFlagActive ? '🔴' : '-',
                direction: data.currentDirection || '-',
                inCycle: data.inTradeCycle ? '🔄' : (data.waitingForReentry ? '⏸️' : '-'),
                breakoutType: data.breakout.type || '-',
                breakoutHigh: data.breakout.active ? data.breakout.highLevel.toFixed(5) : '-',
                breakoutLow: data.breakout.active ? data.breakout.lowLevel.toFixed(5) : '-',
                reversalLevel: `${data.reversalLevel}/${CONFIG.MAX_REVERSAL_LEVEL}`,
                closedCandles: data.closedCandles.length,
                dailyTrades: data.dailyTrades
            }))
        };
    }
}

// ============================================
// CONSOLE DASHBOARD
// ============================================
class Dashboard {
    static display() {
        const status = bot.getStatus();
        const session = status.session;

        console.log('\n' + '╔' + '═'.repeat(120) + '╗');
        console.log('║' + ` DERIV BOT v7.0 - WPR ONLY | ${CONFIG.TIMEFRAME_LABEL} CANDLES | PERSISTENT BREAKOUT LEVELS`.padEnd(120) + '║');
        console.log('╠' + '═'.repeat(120) + '╣');

        const netPLColor = session.netPL >= 0 ? '\x1b[32m' : '\x1b[31m';
        const resetColor = '\x1b[0m';

        console.log(`║ 💰 Capital: $${status.capital.toFixed(2).padEnd(12)} 🏦 Account: $${status.accountBalance.toFixed(2).padEnd(12)} 📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ON' : 'OFF'}`.padEnd(129) + '║');
        console.log(`║ 📊 Session: ${session.duration.padEnd(10)} Trades: ${session.trades.toString().padEnd(5)} Win Rate: ${session.winRate.padEnd(8)}`.padEnd(129) + '║');
        console.log(`║ 💹 Net P/L: ${netPLColor}$${session.netPL.toFixed(2).padEnd(10)}${resetColor} Target: $${session.profitTarget.toFixed(2).padEnd(10)}`.padEnd(137) + '║');
        console.log('╠' + '═'.repeat(120) + '╣');

        if (status.activePositions.length > 0) {
            console.log('║ 🚀 ACTIVE POSITIONS:'.padEnd(121) + '║');
            console.log('║ Symbol | ID         | Dir | Stake | Multi | Profit | Rev Lvl | Duration'.padEnd(121) + '║');
            console.log('║' + '-'.repeat(120) + '║');

            status.activePositions.forEach(pos => {
                const profitColor = pos.profit >= 0 ? '\x1b[32m' : '\x1b[31m';
                const profitStr = pos.profit >= 0 ? `+${pos.profit.toFixed(2)}` : pos.profit.toFixed(2);
                const contractId = (pos.contractId || 'pending').toString().padEnd(10);
                console.log(`║ ${pos.symbol.padEnd(8)} | ${contractId} | ${pos.direction.padEnd(4)} | $${pos.stake.toFixed(2).padEnd(6)} | x${pos.multiplier.toString().padEnd(4)} | ${profitColor}${profitStr.padEnd(8)}${resetColor} | ${pos.reversalLevel.toString().padEnd(7)} | ${pos.duration}s`.padEnd(129) + '║');
            });
            console.log('╠' + '═'.repeat(120) + '╣');
        }

        console.log('║ 📊 WPR STATUS (Updated on CANDLE CLOSE only):'.padEnd(121) + '║');
        console.log('║ Symbol | WPR | BuyFlg | SellFlg | Status | BkType | High Level | Low Level | Rev | Bars ║');
        console.log('║' + '-'.repeat(120) + '║');

        status.assetStats.forEach(stat => {
            const cycleColor = stat.inCycle === '🔄' ? '\x1b[33m' : (stat.inCycle === '⏸️' ? '\x1b[36m' : '\x1b[90m');
            console.log(`║ ${stat.symbol.padEnd(10)} | ${stat.wpr.padEnd(6)} | ${stat.buyFlag.padEnd(6)} | ${stat.sellFlag.padEnd(7)} | ${cycleColor}${stat.inCycle.padEnd(6)}${'\x1b[0m'} | ${stat.breakoutType.padEnd(6)} | ${stat.breakoutHigh.padEnd(13)} | ${stat.breakoutLow.padEnd(13)} | ${stat.reversalLevel.padEnd(7)} | ${stat.closedCandles.toString().padEnd(4)} ║`);
        });

        console.log('╚' + '═'.repeat(120) + '╝');
        console.log(`⏰ ${getGMTTime()} | TF: ${CONFIG.TIMEFRAME} | Strategy: WPR Only | Ctrl+C to stop\n`);
    }

    static startLiveUpdates() {
        setInterval(() => {
            if (state.isAuthorized) {
                Dashboard.display();
            }
        }, CONFIG.DASHBOARD_UPDATE_INTERVAL);
    }
}

// ============================================
// INITIALIZATION
// ============================================
const bot = new DerivBot();

process.on('SIGINT', () => {
    console.log('\n\n⚠️ Shutdown signal received...');
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═'.repeat(90));
    console.log(' DERIV MULTIPLIER BOT v7.0 - WPR ONLY STRATEGY');
    console.log('═'.repeat(90));
    console.log('\n⚠️ API Token not configured!\n');
    console.log('Usage:');
    console.log(' API_TOKEN=xxx TIMEFRAME=5m node deriv-bot.js');
    console.log('\nEnvironment Variables:');
    console.log(' API_TOKEN - Deriv API token (required)');
    console.log(' TIMEFRAME - Candle timeframe (default: 1m)');
    console.log(' CAPITAL - Initial capital (default: 500)');
    console.log(' STAKE - Initial stake (default: 1)');
    console.log(' TAKE_PROFIT - Take profit per trade (default: 1.5)');
    console.log(' PROFIT_TARGET - Session profit target (default: 15000)');
    console.log(' STOP_LOSS - Session stop loss (default: -500)');
    console.log(' TELEGRAM_BOT_TOKEN - Telegram bot token');
    console.log(' TELEGRAM_CHAT_ID - Telegram chat ID');
    console.log('═'.repeat(90));
    process.exit(1);
}

console.log('═'.repeat(90));
console.log(' DERIV MULTIPLIER BOT v7.0 - WPR ONLY STRATEGY');
console.log(` Timeframe: ${CONFIG.TIMEFRAME_LABEL} | Signals: ON CANDLE CLOSE`);
console.log('═'.repeat(90));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

setTimeout(() => {
    Dashboard.startLiveUpdates();
}, 3000);

module.exports = {
    DerivBot,
    TechnicalIndicators,
    SignalManager,
    BreakoutManager,
    StakeManager,
    SessionManager,
    RiskManager,
    TelegramService,
    CONFIG,
    ASSET_CONFIGS,
    ACTIVE_ASSETS,
    TIMEFRAMES,
    state
};
