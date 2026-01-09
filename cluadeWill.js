/**
 * DERIV MULTIPLIER BOT v6.3
 * =========================
 * WPR Strategy with Price Breakout Confirmation
 * 
 * BUY SETUP:
 * 1. WPR crosses above -20 (first time from oversold -80) - Set breakout levels
 * 2. Wait for price to close ABOVE the high breakout level - Execute BUY
 * 3. Reversal: If price closes BELOW low level - Close BUY, Open SELL (2x stake)
 * 4. Repeat reversals until Take Profit reached (max 6 times)
 * 
 * SELL SETUP:
 * 1. WPR crosses below -80 (first time from overbought -20) - Set breakout levels
 * 2. Wait for price to close BELOW the low breakout level - Execute SELL
 * 3. Reversal: If price closes ABOVE high level - Close SELL, Open BUY (2x stake)
 * 4. Repeat reversals until Take Profit reached (max 6 times)
 * 
 * BREAKOUT LEVELS:
 * - Set using the candle that triggered the WPR signal
 * - Levels remain LOCKED throughout the entire trade cycle
 * - Only cleared when trade cycle completes (TP hit or max reversals)
 */

const WebSocket = require('ws');
const math = require('mathjs');
const https = require('https');

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
${emoji} ${type} TRADE ALERT

Asset: ${symbol}
Direction: ${direction}
Stake: $${stake.toFixed(2)}
Multiplier: x${multiplier}
${details.profit !== undefined ? `Profit: $${details.profit.toFixed(2)}` : ''}
${details.reversalLevel !== undefined ? `Reversal Level: ${details.reversalLevel}/6` : ''}

Time: ${new Date().toUTCString()}
        `.trim();

        await this.sendMessage(message);
    }

    static async sendLossAlert(symbol, lossAmount, consecutiveLosses) {
        const message = `
❌ LOSS ALERT

Asset: ${symbol}
Loss Amount: $${lossAmount.toFixed(2)}
Consecutive Losses: ${consecutiveLosses}

Current Capital: $${state.capital.toFixed(2)}
Session Net P/L: $${state.session.netPL.toFixed(2)}

Time: ${new Date().toUTCString()}
        `.trim();

        await this.sendMessage(message);
    }

    static async sendSignalAlert(symbol, signalType, wpr, stoch) {
        const emoji = signalType.includes('BUY') ? '🟢' : '🔴';
        const message = `
${emoji} SIGNAL ALERT

Asset: ${symbol}
Signal: ${signalType}
WPR: ${wpr.toFixed(2)}
Stoch K/D: ${stoch.k.toFixed(2)} / ${stoch.d.toFixed(2)}
Timeframe: ${CONFIG.TIMEFRAME_LABEL}

Time: ${new Date().toUTCString()}
        `.trim();

        await this.sendMessage(message);
    }

    static async sendSessionSummary() {
        const stats = SessionManager.getSessionStats();
        const message = `
📊 SESSION SUMMARY

Duration: ${stats.duration}
Trades: ${stats.trades}
Wins: ${stats.wins} | Losses: ${stats.losses}
Win Rate: ${stats.winRate}

Net P/L: $${stats.netPL.toFixed(2)}
Current Capital: $${state.capital.toFixed(2)}

Active Assets: ${Object.keys(state.assets).length}
Timeframe: ${CONFIG.TIMEFRAME_LABEL}

Time: ${new Date().toUTCString()}
        `.trim();

        await this.sendMessage(message);
    }

    static async sendStartupMessage() {
        const message = `
🤖 DERIV BOT v6.2 STARTED

Capital: $${CONFIG.INITIAL_CAPITAL}
Stake: $${CONFIG.INITIAL_STAKE}
Timeframe: ${CONFIG.TIMEFRAME_LABEL}
Assets: ${ACTIVE_ASSETS.join(', ')}

Session Target: $${CONFIG.SESSION_PROFIT_TARGET}
Stop Loss: $${CONFIG.SESSION_STOP_LOSS}
Max Reversals: ${CONFIG.MAX_REVERSAL_LEVEL}

Strategy: WPR 
Signals: Only on CANDLE CLOSE

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
    stoch: (msg) => console.log(`\x1b[34m[STOCH] ${getGMTTime()} - ${msg}\x1b[0m`),
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

// Default to 5 minutes, user can override with TIMEFRAME env variable
const SELECTED_TIMEFRAME = process.env.TIMEFRAME || '5m';
const TIMEFRAME_CONFIG = TIMEFRAMES[SELECTED_TIMEFRAME] || TIMEFRAMES['5m'];

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
    // API Settings
    API_TOKEN: process.env.API_TOKEN || '0P94g4WdSrSrzir',
    APP_ID: process.env.APP_ID || '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Capital Settings
    INITIAL_CAPITAL: 500,
    INITIAL_STAKE: 1.00,
    TAKE_PROFIT: 1.5,

    // Session Targets
    SESSION_PROFIT_TARGET: 15000,
    SESSION_STOP_LOSS: -500,

    // Reversal Settings
    REVERSAL_STAKE_MULTIPLIER: 2,
    MAX_REVERSAL_LEVEL: 6,
    AUTO_CLOSE_ON_RECOVERY: true,

    // Timeframe Settings (DEFAULT 5 MINUTES)
    TIMEFRAME: SELECTED_TIMEFRAME,
    GRANULARITY: TIMEFRAME_CONFIG.granularity,
    TIMEFRAME_LABEL: TIMEFRAME_CONFIG.label,
    TIMEFRAME_SECONDS: TIMEFRAME_CONFIG.seconds,

    // WPR Settings
    WPR_PERIOD: 80,
    WPR_OVERBOUGHT: -20,
    WPR_OVERSOLD: -80,
    WPR_BUY_INVALIDATION: -60,
    WPR_SELL_INVALIDATION: -40,

    // Stochastic Settings
    STOCH_K_PERIOD: 5,
    STOCH_D_PERIOD: 3,
    STOCH_SMOOTH: 3,
    STOCH_OVERBOUGHT: 80,
    STOCH_OVERSOLD: 20,

    // Trade Settings
    MAX_TRADES_PER_ASSET: 20000,
    MAX_OPEN_POSITIONS: 100,

    // Timing
    COOLDOWN_AFTER_SESSION_END: 1 * 60 * 1000,
    PROFIT_CHECK_INTERVAL: 1000,

    // Risk Settings
    MIN_WIN_RATE_THRESHOLD: 0.40,
    WIN_RATE_LOOKBACK: 20,
    BLACKLIST_PERIOD: 1 * 60 * 1000,

    // Performance
    MAX_TICKS_STORED: 100,
    MAX_CANDLES_STORED: 150,
    DASHBOARD_UPDATE_INTERVAL: 60000,

    // Debug
    DEBUG_MODE: true,

    // Telegram Settings
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8132747567:AAFtaN1j9U5HgNiK_TVE7axWzFDifButwKk',
    TELEGRAM_CHAT_ID: '752497117'
};

// ============================================
// ASSET CONFIGURATION
// ============================================

const ASSET_CONFIGS = {
    // 'R_10': {
    //     name: 'Volatility 10 Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [400, 1000, 2000, 3000, 4000],
    //     defaultMultiplier: 4000,
    //     maxTradesPerDay: 100,
    //     minStake: 1.00,
    //     maxStake: 2000,
    //     tradingHours: '24/7'
    // },
    'R_75': {
        name: 'Volatility 75 Index',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 500],
        defaultMultiplier: 500,
        maxTradesPerDay: 500000,
        minStake: 1.00,
        maxStake: 3000,
        tradingHours: '24/7'
    },
    // 'R_100': {
    //     name: 'Volatility 100 Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [40, 100, 200, 300, 500],
    //     defaultMultiplier: 500,
    //     maxTradesPerDay: 50,
    //     minStake: 1.00,
    //     maxStake: 3000,
    //     tradingHours: '24/7'
    // },
    // '1HZ10V': {
    //     name: 'Volatility 10 (1s) Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [400, 1000, 2000, 3000, 4000],
    //     defaultMultiplier: 4000,
    //     maxTradesPerDay: 150,
    //     minStake: 1.00,
    //     maxStake: 1000,
    //     tradingHours: '24/7'
    // },
    '1HZ50V': {
        name: 'Volatility 50 (1s) Index',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [80, 200, 400, 600, 800],
        defaultMultiplier: 800,
        maxTradesPerDay: 120,
        minStake: 1.00,
        maxStake: 1000,
        tradingHours: '24/7'
    },
    'stpRNG': {
        name: 'Step Index',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [750, 2000, 3500, 5500, 7500],
        defaultMultiplier: 7500,
        maxTradesPerDay: 120,
        minStake: 1.00,
        maxStake: 1000,
        tradingHours: '24/7'
    },
    'frxXAUUSD': {
        name: 'Gold/USD',
        category: 'commodity',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 400, 500],
        defaultMultiplier: 500,
        maxTradesPerDay: 5,
        minStake: 5,
        maxStake: 5000,
        tradingHours: 'Sun 23:00 - Fri 21:55 GMT'
    }
};

let ACTIVE_ASSETS = ['R_75', 'frxXAUUSD', '1HZ50V', 'stpRNG'];

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

// Initialize asset states
function initializeAssetStates() {
    ACTIVE_ASSETS.forEach(symbol => {
        if (ASSET_CONFIGS[symbol]) {
            state.assets[symbol] = {
                // Price data
                candles: [],
                ticks: [],
                currentPrice: 0,

                // CLOSED candle tracking for indicators
                closedCandles: [],  // Only completed candles
                lastClosedCandleEpoch: 0,

                // Current forming candle tracking
                currentFormingCandle: null,

                // WPR tracking (calculated on CLOSED candles only)
                wpr: -50,
                prevWpr: -50,

                // WPR Zone tracking
                wprZone: 'neutral',
                hasVisitedOversold: false,   // Set to true when entering oversold (-80)
                hasVisitedOverbought: false, // Set to true when entering overbought (-20)

                // Signal states (kept for compatibility but not used for waiting)
                buySignalActive: false,
                sellSignalActive: false,
                signalCandle: null,

                // Stochastic tracking (still calculated for display/logging)
                stochastic: {
                    k: 50,
                    d: 50,
                    prevK: 50,
                    prevD: 50
                },

                // Breakout levels - Set when WPR crosses overbought/oversold
                breakout: {
                    active: false,
                    highLevel: 0,
                    lowLevel: 0,
                    triggerCandle: 0,
                    initialDirection: null
                },

                // Active trade tracking
                activePosition: null,
                currentDirection: null,

                // Trade cycle tracking
                inTradeCycle: false,

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

                // Candle close tracking
                lastProcessedCandleEpoch: 0,

                // Indicator readiness
                indicatorsReady: false
            };
        }
    });

    LOGGER.info(`Initialized ${Object.keys(state.assets).length} assets`);
    LOGGER.info(`⏱️ Timeframe: ${CONFIG.TIMEFRAME_LABEL} (${CONFIG.GRANULARITY}s candles)`);
    LOGGER.info(`📊 Signals generated ONLY on candle CLOSE`);
    LOGGER.info(`🚀 IMMEDIATE EXECUTION on WPR cross (no Stochastic wait)`);
}

initializeAssetStates();

// ============================================
// TECHNICAL INDICATORS
// ============================================

class TechnicalIndicators {
    /**
     * Calculate Williams Percent Range (WPR) - ONLY on closed candles
     */
    static calculateWPR(candles, period = 14) {
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

    /**
     * Calculate Stochastic Oscillator (5, 3, 3) - ONLY on closed candles
     * Returns current AND previous values for crossover detection
     */
    static calculateStochastic(candles, kPeriod = 5, dPeriod = 3, smoothK = 3) {
        const minLength = kPeriod + smoothK + dPeriod;

        if (!candles || candles.length < minLength) {
            return { k: 50, d: 50, prevK: 50, prevD: 50 };
        }

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);

        // Calculate raw %K values
        const rawK = [];
        for (let i = kPeriod - 1; i < closes.length; i++) {
            const periodHighs = highs.slice(i - kPeriod + 1, i + 1);
            const periodLows = lows.slice(i - kPeriod + 1, i + 1);
            const highestHigh = Math.max(...periodHighs);
            const lowestLow = Math.min(...periodLows);
            const range = highestHigh - lowestLow;

            if (range === 0) {
                rawK.push(50);
            } else {
                rawK.push(((closes[i] - lowestLow) / range) * 100);
            }
        }

        // Smooth %K with SMA (this is the "slow" stochastic)
        const smoothedK = [];
        for (let i = smoothK - 1; i < rawK.length; i++) {
            const sum = rawK.slice(i - smoothK + 1, i + 1).reduce((a, b) => a + b, 0);
            smoothedK.push(sum / smoothK);
        }

        // Calculate %D as SMA of smoothed %K
        const dValues = [];
        for (let i = dPeriod - 1; i < smoothedK.length; i++) {
            const sum = smoothedK.slice(i - dPeriod + 1, i + 1).reduce((a, b) => a + b, 0);
            dValues.push(sum / dPeriod);
        }

        if (dValues.length < 2 || smoothedK.length < 2) {
            return { k: 50, d: 50, prevK: 50, prevD: 50 };
        }

        // Return current and previous values for crossover detection
        return {
            k: smoothedK[smoothedK.length - 1],
            d: dValues[dValues.length - 1],
            prevK: smoothedK[smoothedK.length - 2],
            prevD: dValues[dValues.length - 2]
        };
    }

    /**
     * Detect Stochastic crossover (kept for compatibility but not used)
     */
    static detectStochCrossover(stoch) {
        return null;
    }
}

// ============================================
// SIGNAL MANAGER - ONLY ON CANDLE CLOSE
// ============================================

class SignalManager {
    /**
     * Update WPR state and check for signals - ONLY called on candle close
     */
    static updateWPRState(symbol) {
        const assetState = state.assets[symbol];
        const wpr = assetState.wpr;
        const prevWpr = assetState.prevWpr;

        // Track zone transitions for "first time" logic
        const wasInOversold = prevWpr < CONFIG.WPR_OVERSOLD;
        const wasInOverbought = prevWpr > CONFIG.WPR_OVERBOUGHT;
        const isInOversold = wpr < CONFIG.WPR_OVERSOLD;
        const isInOverbought = wpr > CONFIG.WPR_OVERBOUGHT;

        // Update zone tracking
        if (isInOversold) {
            assetState.wprZone = 'oversold';
            assetState.hasVisitedOversold = true;
            // When entering oversold, clear overbought flag
            if (!wasInOversold) {
                // assetState.hasVisitedOverbought = false;
                LOGGER.debug(`${symbol}: Entered OVERSOLD zone (WPR: ${wpr.toFixed(2)})`);
            }
        } else if (isInOverbought) {
            assetState.wprZone = 'overbought';
            assetState.hasVisitedOverbought = true;
            // When entering overbought, clear oversold flag
            if (!wasInOverbought) {
                // assetState.hasVisitedOversold = false;
                LOGGER.debug(`${symbol}: Entered OVERBOUGHT zone (WPR: ${wpr.toFixed(2)})`);
            }
        } else {
            assetState.wprZone = 'neutral';
        }

        // Only check for new signals if NOT in an active trade cycle
        if (!assetState.inTradeCycle) {
            this.checkForTradeSignal(symbol);
        }
    }

    /**
     * Check for IMMEDIATE trade signal on CANDLE CLOSE
     * BUY: Previous WPR <= -20, Current WPR > -20 (crossing above overbought)
     * SELL: Previous WPR >= -80, Current WPR < -80 (crossing below oversold)
     * EXECUTE TRADE IMMEDIATELY - No Stochastic confirmation needed
     */
    static checkForTradeSignal(symbol) {
        const assetState = state.assets[symbol];
        const wpr = assetState.wpr;
        const prevWpr = assetState.prevWpr;

        // BUY SIGNAL: WPR crosses ABOVE -20 (from oversold zone)
        const isCrossingAboveOverbought = (prevWpr <= CONFIG.WPR_OVERBOUGHT) && (wpr > CONFIG.WPR_OVERBOUGHT);

        if (isCrossingAboveOverbought &&
            assetState.hasVisitedOversold &&
            !assetState.inTradeCycle) {

            assetState.hasVisitedOversold = false;  // Reset flag after signal

            // Store the closed candle that triggered the signal
            const closedCandles = assetState.closedCandles;
            if (closedCandles.length > 0) {
                assetState.signalCandle = closedCandles[closedCandles.length - 1];
            }

            LOGGER.signal(`${symbol} 🟢 BUY SIGNAL on candle CLOSE! WPR: ${wpr.toFixed(2)} (from ${prevWpr.toFixed(2)})`);
            LOGGER.signal(`${symbol} Executing BUY trade immediately...`);

            TelegramService.sendSignalAlert(symbol, 'BUY SIGNAL - IMMEDIATE EXECUTION', wpr, assetState.stochastic);

            return 'UP';
        }

        // SELL SIGNAL: WPR crosses BELOW -80 (from overbought zone)
        const isCrossingBelowOversold = (prevWpr >= CONFIG.WPR_OVERSOLD) && (wpr < CONFIG.WPR_OVERSOLD);

        if (isCrossingBelowOversold &&
            assetState.hasVisitedOverbought &&
            !assetState.inTradeCycle) {

            assetState.hasVisitedOverbought = false;  // Reset flag after signal

            const closedCandles = assetState.closedCandles;
            if (closedCandles.length > 0) {
                assetState.signalCandle = closedCandles[closedCandles.length - 1];
            }

            LOGGER.signal(`${symbol} 🔴 SELL SIGNAL on candle CLOSE! WPR: ${wpr.toFixed(2)} (from ${prevWpr.toFixed(2)})`);
            LOGGER.signal(`${symbol} Executing SELL trade immediately...`);

            TelegramService.sendSignalAlert(symbol, 'SELL SIGNAL - IMMEDIATE EXECUTION', wpr, assetState.stochastic);

            return 'DOWN';
        }

        return null;
    }

    /**
     * Reset all signals
     */
    static resetSignals(symbol) {
        const assetState = state.assets[symbol];
        assetState.buySignalActive = false;
        assetState.sellSignalActive = false;
        assetState.signalCandle = null;
    }
}

// ============================================
// BREAKOUT MANAGER
// ============================================

class BreakoutManager {
    /**
     * Set breakout levels using the candle that triggered the WPR cross
     * This is the candle where WPR crossed above -20 or below -80
     */
    static setupBreakoutLevels(symbol, direction) {
        const assetState = state.assets[symbol];
        const closedCandles = assetState.closedCandles;

        if (closedCandles.length < 1) {
            LOGGER.warn(`${symbol}: Not enough closed candles for breakout setup`);
            return false;
        }

        // Use the CURRENT candle (the one that just closed and triggered the WPR cross)
        const triggerCandle = closedCandles[closedCandles.length - 1];

        assetState.breakout = {
            active: true,
            highLevel: parseFloat(triggerCandle.high.toFixed(5)),
            lowLevel: parseFloat(triggerCandle.low.toFixed(5)),
            triggerCandle: triggerCandle.epoch,
            initialDirection: direction
        };

        assetState.inTradeCycle = true;

        const candleTime = new Date(triggerCandle.epoch * 1000).toISOString().split('T')[1].split('.')[0];

        LOGGER.breakout(`${symbol} 📊 BREAKOUT LEVELS SET (WPR Cross Candle):`);
        LOGGER.breakout(`${symbol}    🔺 High: ${assetState.breakout.highLevel.toFixed(5)}`);
        LOGGER.breakout(`${symbol}    🔻 Low:  ${assetState.breakout.lowLevel.toFixed(5)}`);
        LOGGER.breakout(`${symbol}    Direction: ${direction} | Time: ${candleTime} GMT`);
        LOGGER.breakout(`${symbol}    🔒 LEVELS LOCKED FOR ENTIRE TRADE CYCLE`);

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

        if (!assetState.activePosition || !breakout.active) {
            return null;
        }

        if (closedCandles.length < 1) {
            return null;
        }

        // Check the last CLOSED candle
        const lastClosedCandle = closedCandles[closedCandles.length - 1];
        const closePrice = lastClosedCandle.close;
        const currentDirection = assetState.currentDirection;

        // UP position: Reversal if price CLOSES BELOW the lower breakout level
        if (currentDirection === 'UP' && closePrice < breakout.lowLevel) {
            LOGGER.breakout(`${symbol} 🔄 REVERSAL TRIGGERED on candle CLOSE!`);
            LOGGER.breakout(`${symbol}    UP → DOWN: Close ${closePrice.toFixed(5)} < Low ${breakout.lowLevel.toFixed(5)}`);
            return 'DOWN';
        }

        // DOWN position: Reversal if price CLOSES ABOVE the higher breakout level
        if (currentDirection === 'DOWN' && closePrice > breakout.highLevel) {
            LOGGER.breakout(`${symbol} 🔄 REVERSAL TRIGGERED on candle CLOSE!`);
            LOGGER.breakout(`${symbol}    DOWN → UP: Close ${closePrice.toFixed(5)} > High ${breakout.highLevel.toFixed(5)}`);
            return 'UP';
        }

        return null;
    }

    /**
     * Maintain breakout levels during reversals
     * Levels should stay the same throughout the entire trade cycle
     */
    static maintainBreakoutLevels(symbol) {
        const assetState = state.assets[symbol];

        // Breakout levels remain active and unchanged during reversals
        if (assetState.breakout.active) {
            LOGGER.breakout(`${symbol} 🔒 BREAKOUT LEVELS MAINTAINED:`);
            LOGGER.breakout(`${symbol}    High: ${assetState.breakout.highLevel.toFixed(5)} | Low: ${assetState.breakout.lowLevel.toFixed(5)}`);
        }
    }

    /**
     * Clear breakout setup
     */
    static clearBreakout(symbol) {
        const assetState = state.assets[symbol];

        LOGGER.breakout(`${symbol} 🔓 BREAKOUT LEVELS CLEARED`);

        assetState.breakout = {
            active: false,
            highLevel: 0,
            lowLevel: 0,
            triggerCandle: 0,
            initialDirection: null
        };

        assetState.inTradeCycle = false;
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
        LOGGER.trade(`${symbol} Dynamic TP: $${assetState.takeProfitAmount.toFixed(2)}`);

        return this.validateStake(symbol, assetState.currentStake);
    }

    static fullReset(symbol) {
        const assetState = state.assets[symbol];

        LOGGER.recovery(`${symbol} 🎉 FULL RESET`);

        assetState.currentStake = CONFIG.INITIAL_STAKE;
        assetState.reversalLevel = 0;
        assetState.accumulatedLoss = 0;
        assetState.takeProfitAmount = CONFIG.TAKE_PROFIT;
        assetState.activePosition = null;
        assetState.currentDirection = null;

        BreakoutManager.clearBreakout(symbol);
        SignalManager.resetSignals(symbol);
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
            StakeManager.fullReset(symbol);
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
    static canTrade() {
        if (!SessionManager.isSessionActive()) return false;
        if (SessionManager.checkSessionTargets()) return false;
        if (state.portfolio.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) return false;
        if (state.capital < CONFIG.INITIAL_STAKE) {
            LOGGER.error(`Insufficient capital: $${state.capital.toFixed(2)} available, $${CONFIG.INITIAL_STAKE.toFixed(2)} required`);
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

        // Check trading hours
        if (!TradingHoursManager.isWithinTradingHours(symbol)) {
            return { allowed: false, reason: `Outside trading hours (${config.tradingHours})` };
        }

        if (assetState.dailyTrades >= config.maxTradesPerDay) {
            return { allowed: false, reason: `Daily trade limit reached (${assetState.dailyTrades}/${config.maxTradesPerDay})` };
        }

        if (Date.now() < assetState.blacklistedUntil) {
            const remaining = Math.ceil((assetState.blacklistedUntil - Date.now()) / 1000);
            return { allowed: false, reason: `Asset blacklisted for ${remaining}s` };
        }

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
            TelegramService.sendLossAlert(symbol, Math.abs(profit), assetState.consecutiveLosses);
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
    /**
     * Check if asset is within trading hours
     * frxXAUUSD trades Sun 23:00 - Fri 21:55 GMT
     */
    static isWithinTradingHours(symbol) {
        const config = ASSET_CONFIGS[symbol];
        if (!config) return false;

        // Synthetic indices trade 24/7
        if (config.tradingHours === '24/7') {
            return true;
        }

        // Parse trading hours for frxXAUUSD: Sun 23:00 - Fri 21:55 GMT
        if (symbol === 'frxXAUUSD') {
            return this.checkGoldTradingHours();
        }

        // Default: allow trading if hours not specified
        return true;
    }

    static checkGoldTradingHours() {
        const now = new Date();
        const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        const hours = now.getUTCHours();
        const minutes = now.getUTCMinutes();
        const timeInMinutes = hours * 60 + minutes;

        // Trading hours: Sun 23:00 - Fri 21:55 GMT
        // Market OPENS Sunday 23:00, CLOSES Friday 21:55

        // Saturday: Market closed all day
        if (day === 6) {
            return false;
        }

        // Sunday: Only open from 23:00 onwards
        if (day === 0) {
            return timeInMinutes >= 23 * 60; // >= 23:00
        }

        // Friday: Only open until 21:55
        if (day === 5) {
            return timeInMinutes < 21 * 60 + 55; // < 21:55
        }

        // Mon-Thu: Open all day
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
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000;
        this.pingInterval = null;
        this.checkDataInterval = null;
        this.lastDataTime = Date.now();
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
        this.send({ authorize: CONFIG.API_TOKEN });
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

            // Synchronize capital with real balance if it's the first authorization
            if (state.capital === CONFIG.INITIAL_CAPITAL) {
                state.capital = response.authorize.balance;
                LOGGER.info(`⚖️ Initializing session capital to: $${state.capital.toFixed(2)}`);
            }

            bot.start();
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

    /**
     * CRITICAL FIX: Handle OHLC properly - only process on TRUE CANDLE CLOSE
     * Deriv sends OHLC updates on EVERY TICK, so we must detect actual candle closes
     */
    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        if (!state.assets[symbol]) return;

        const assetState = state.assets[symbol];

        const incomingCandle = {
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close),
            epoch: ohlc.epoch,
            open_time: ohlc.open_time
        };

        // Debug: Log every few candle updates (not every tick to avoid spam)
        if (Math.random() < 0.01) { // Log ~1% of updates
            const currentTime = new Date(Date.now()).toISOString().split('T')[1].split('.')[0];
            const candleTime = new Date(incomingCandle.epoch * 1000).toISOString().split('T')[1].split('.')[0];
            // LOGGER.debug(`${symbol} Candle Update [Now: ${currentTime}, Candle: ${candleTime}]: Current epoch: ${incomingCandle.epoch}, Forming: ${assetState.currentFormingCandle?.epoch || 'none'}`);
        }

        // Check if this is a different candle epoch (new candle = previous closed)
        const isNewCandle = assetState.currentFormingCandle &&
            assetState.currentFormingCandle.epoch !== incomingCandle.epoch;

        if (isNewCandle) {
            // Previous candle just CLOSED - process it
            const closedCandle = assetState.currentFormingCandle;

            // Check if we haven't processed this specific candle epoch yet
            if (closedCandle.epoch !== assetState.lastProcessedCandleEpoch) {

                // Verify this is a real candle from our timeframe
                // Check if epoch is properly aligned to the timeframe (should be divisible by granularity)
                const isAligned = (closedCandle.epoch % CONFIG.GRANULARITY) === 0;

                if (isAligned) {
                    // Add to closed candles array
                    assetState.closedCandles.push(closedCandle);

                    // Keep closed candles array manageable
                    if (assetState.closedCandles.length > CONFIG.MAX_CANDLES_STORED) {
                        assetState.closedCandles = assetState.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED);
                    }

                    // Mark as processed
                    assetState.lastProcessedCandleEpoch = closedCandle.epoch;

                    // Log candle close with timestamp
                    const candleTime = new Date(closedCandle.epoch * 1000).toISOString().split('T')[1].split('.')[0];
                    // LOGGER.candle(`${symbol} 🕯️ CANDLE CLOSED [${candleTime}]: O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)}`);

                    // NOW process trading logic on the CLOSED candle
                    this.processCandleClose(symbol);
                } else {
                    // LOGGER.debug(`${symbol}: Skipping non-aligned candle epoch: ${closedCandle.epoch} (not divisible by ${CONFIG.GRANULARITY})`);
                }
            }
        }

        // Update current forming candle (always update, regardless of whether we processed a close)
        assetState.currentFormingCandle = incomingCandle;

        // Also update the candles array for display purposes
        const candles = assetState.candles;
        const existingIndex = candles.findIndex(c => c.epoch === incomingCandle.epoch);

        if (existingIndex >= 0) {
            // Update existing candle (still forming)
            candles[existingIndex] = incomingCandle;
        } else {
            // Add new candle
            candles.push(incomingCandle);
        }

        // Keep candles array manageable
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

        const candles = response.candles.map(c => ({
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close),
            epoch: c.epoch
        }));

        if (candles.length === 0) {
            LOGGER.warn(`${symbol}: No historical candles received`);
            return;
        }

        // All historical candles are CLOSED candles
        state.assets[symbol].candles = [...candles];
        state.assets[symbol].closedCandles = [...candles];

        // Set the last candle as already processed
        const lastCandle = candles[candles.length - 1];
        state.assets[symbol].lastProcessedCandleEpoch = lastCandle.epoch;

        // Set the last historical candle as the initial forming candle
        // The next OHLC update will either update this or start a new one
        state.assets[symbol].currentFormingCandle = { ...lastCandle };

        LOGGER.info(`📊 Loaded ${candles.length} ${CONFIG.TIMEFRAME_LABEL} candles for ${symbol}`);
        LOGGER.info(`   Latest candle: ${new Date(lastCandle.epoch * 1000).toISOString().split('T')[1].split('.')[0]} GMT`);

        // Calculate initial indicators
        this.updateIndicators(symbol);

        // Mark indicators as ready
        state.assets[symbol].indicatorsReady = true;
    }

    /**
     * Update indicators - ONLY using CLOSED candles
     */
    updateIndicators(symbol) {
        const assetState = state.assets[symbol];
        const closedCandles = assetState.closedCandles;

        const minRequired = Math.max(
            CONFIG.WPR_PERIOD,
            CONFIG.STOCH_K_PERIOD + CONFIG.STOCH_SMOOTH + CONFIG.STOCH_D_PERIOD
        );

        if (closedCandles.length < minRequired) {
            LOGGER.debug(`${symbol}: Not enough closed candles for indicators (${closedCandles.length}/${minRequired})`);
            assetState.indicatorsReady = false;
            return;
        }

        // Store previous WPR value BEFORE updating
        assetState.prevWpr = assetState.wpr;

        // Store previous Stochastic values BEFORE updating
        const prevStoch = { ...assetState.stochastic };

        // Calculate WPR on CLOSED candles only
        assetState.wpr = TechnicalIndicators.calculateWPR(closedCandles, CONFIG.WPR_PERIOD);

        // Calculate Stochastic on CLOSED candles only
        const newStoch = TechnicalIndicators.calculateStochastic(
            closedCandles,
            CONFIG.STOCH_K_PERIOD,
            CONFIG.STOCH_D_PERIOD,
            CONFIG.STOCH_SMOOTH
        );

        // Update stochastic with new values
        assetState.stochastic = {
            k: newStoch.k,
            d: newStoch.d,
            prevK: prevStoch.k,  // Use the ACTUAL previous K value
            prevD: prevStoch.d   // Use the ACTUAL previous D value
        };

        assetState.indicatorsReady = true;

        // LOGGER.debug(`${symbol} INDICATORS UPDATED: WPR: ${assetState.wpr.toFixed(2)} (prev: ${assetState.prevWpr.toFixed(2)}) | Stoch K:${assetState.stochastic.k.toFixed(2)} D:${assetState.stochastic.d.toFixed(2)}`);
    }

    /**
     * Process trading logic on CANDLE CLOSE only
     */
    processCandleClose(symbol) {
        const assetState = state.assets[symbol];
        const closedCandles = assetState.closedCandles;

        const minRequired = Math.max(
            CONFIG.WPR_PERIOD,
            CONFIG.STOCH_K_PERIOD + CONFIG.STOCH_SMOOTH + CONFIG.STOCH_D_PERIOD
        );

        if (closedCandles.length < minRequired) {
            LOGGER.debug(`${symbol}: Not enough closed candles for processing (${closedCandles.length}/${minRequired})`);
            return;
        }

        // 1. Update indicators with closed candle data
        this.updateIndicators(symbol);

        // Only proceed if indicators are ready
        if (!assetState.indicatorsReady) {
            LOGGER.debug(`${symbol}: Indicators not ready yet`);
            return;
        }

        // 2. Update WPR state and check for IMMEDIATE trade signals
        SignalManager.updateWPRState(symbol);

        // 3. If no active position and NOT in trade cycle, check for immediate entry
        if (!assetState.activePosition && !assetState.inTradeCycle) {
            const tradeSignal = SignalManager.checkForTradeSignal(symbol);

            if (tradeSignal) {
                // Setup breakout levels immediately
                const setupSuccess = BreakoutManager.setupBreakoutLevels(symbol, tradeSignal);

                if (setupSuccess) {
                    // Execute trade immediately - no waiting
                    bot.executeTrade(symbol, tradeSignal, false);
                }
            }
        }

        // 4. If active position, check for reversal
        if (assetState.activePosition && assetState.breakout.active) {
            const reversal = BreakoutManager.checkReversal(symbol);

            if (reversal) {
                bot.executeReversal(symbol, reversal);
            }
        }

        // Log status
        LOGGER.debug(`${symbol} STATUS | WPR: ${assetState.wpr.toFixed(2)} (prev: ${assetState.prevWpr.toFixed(2)}) | Stoch K:${assetState.stochastic.k.toFixed(2)} D:${assetState.stochastic.d.toFixed(2)} | InCycle: ${assetState.inTradeCycle} | Direction: ${assetState.currentDirection || 'NONE'}`);
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
            }

            TelegramService.sendTradeAlert('OPEN', position.symbol, position.direction, position.stake, position.multiplier, { reversalLevel: position.reversalLevel });
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

            RiskManager.recordTradeResult(position.symbol, profit, position.direction);
            state.portfolio.activePositions.splice(posIndex, 1);

            const assetState = state.assets[position.symbol];
            if (assetState) {
                if (position.isRecoveryClose) {
                    LOGGER.recovery(`${position.symbol}: Recovery close completed. Profit: $${profit.toFixed(2)}`);
                    StakeManager.fullReset(position.symbol);
                } else if (position.pendingReversal) {
                    const reversalDir = position.pendingReversal;
                    const lossAmount = profit < 0 ? profit : 0;

                    assetState.activePosition = null;
                    assetState.currentDirection = null;

                    setTimeout(() => {
                        bot.executeTrade(position.symbol, reversalDir, true, lossAmount);
                    }, 500);
                } else if (position.isMaxReversalClose) {
                    LOGGER.warn(`${position.symbol}: Max reversals reached. Full reset.`);
                    StakeManager.fullReset(position.symbol);
                } else {
                    assetState.activePosition = null;
                    assetState.currentDirection = null;

                    if (profit > 0) {
                        if (assetState.reversalLevel > 0) {
                            if (profit >= assetState.accumulatedLoss) {
                                StakeManager.fullReset(position.symbol);
                            }
                        } else {
                            StakeManager.fullReset(position.symbol);
                        }
                    }
                }
            }
        }
    }

    handleOpenContract(response) {
        if (response.error) return;

        const contract = response.proposal_open_contract;
        const posIndex = state.portfolio.activePositions.findIndex(
            p => p.contractId === contract.contract_id
        );

        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
            const profit = contract.profit;
            const symbol = contract.underlying;

            LOGGER.trade(`Contract ${contract.contract_id} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`);

            if (posIndex >= 0) {
                const position = state.portfolio.activePositions[posIndex];
                RiskManager.recordTradeResult(symbol, profit, position.direction);
                state.portfolio.activePositions.splice(posIndex, 1);

                if (state.assets[symbol]) {
                    state.assets[symbol].activePosition = null;
                    state.assets[symbol].currentDirection = null;

                    if (profit > 0) {
                        LOGGER.recovery(`${symbol} 🎉 WIN! Trade cycle complete.`);
                        StakeManager.fullReset(symbol);
                    }
                }
            }

            SessionManager.checkSessionTargets();

            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }
        } else if (posIndex >= 0) {
            // Update live profit and price for active positions
            const position = state.portfolio.activePositions[posIndex];
            position.currentProfit = contract.profit || 0;
            position.currentPrice = contract.current_spot || 0;
            position.bidPrice = contract.bid_price || 0;

            const assetState = state.assets[position.symbol];

            // Log profit updates periodically
            if (Math.random() < 0.05) { // Log ~5% of updates to avoid spam
                LOGGER.debug(`${position.symbol} Live P/L: $${position.currentProfit.toFixed(2)} | Price: ${position.currentPrice.toFixed(5)}`);
            }

            if (assetState && StakeManager.shouldAutoClose(position.symbol, contract.profit)) {
                LOGGER.recovery(`${position.symbol}: Profit $${contract.profit.toFixed(2)} >= Loss $${assetState.accumulatedLoss.toFixed(2)} - AUTO CLOSING`);
                position.isRecoveryClose = true;
                this.send({ sell: contract.contract_id, price: 0 });
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

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            LOGGER.info(`🔄 Reconnecting in ${this.reconnectDelay / 1000}s...`);
            setTimeout(() => this.connect(), this.reconnectDelay);
        } else {
            LOGGER.error('Max reconnection attempts reached. Exiting.');
            process.exit(1);
        }
    }

    startMonitor() {
        this.stopMonitor();

        this.pingInterval = setInterval(() => {
            if (state.isConnected) {
                this.send({ ping: 1 });
            }
        }, 20000);

        this.checkDataInterval = setInterval(() => {
            if (!state.isConnected) return;
            const silenceDuration = Date.now() - this.lastDataTime;
            if (silenceDuration > 60000) {
                LOGGER.error(`⚠️ No data for ${Math.round(silenceDuration / 1000)}s - Forcing reconnection...`);
                if (this.ws) this.ws.terminate();
            }
        }, 10000);
    }

    stopMonitor() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.checkDataInterval) clearInterval(this.checkDataInterval);
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
        console.log('         DERIV MULTIPLIER BOT v6.2');
        console.log('         WPR Strategy - SIGNALS ON CANDLE CLOSE ONLY');
        console.log('═'.repeat(90));
        console.log(`💰 Initial Capital: $${state.capital}`);
        console.log(`📊 Active Assets: ${ACTIVE_ASSETS.length} (${ACTIVE_ASSETS.join(', ')})`);
        console.log(`⏱️  Timeframe: ${CONFIG.TIMEFRAME_LABEL} (${CONFIG.GRANULARITY} seconds)`);
        console.log(`🎯 Session Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`);
        console.log(`🔄 Max Reversals: ${CONFIG.MAX_REVERSAL_LEVEL} | Multiplier: ${CONFIG.REVERSAL_STAKE_MULTIPLIER}x`);
        console.log(`📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ENABLED' : 'DISABLED'}`);
        console.log('═'.repeat(90));
        console.log('📋 Strategy (ALL SIGNALS ON CANDLE CLOSE):');
        console.log('   BUY: WPR crosses > -20 (from -80) → Execute IMMEDIATELY');
        console.log('   SELL: WPR crosses < -80 (from -20) → Execute IMMEDIATELY');
        console.log('   Reversal: Price closes beyond breakout levels (max 6x)');
        console.log('═'.repeat(90) + '\n');

        this.connection.send({ balance: 1, subscribe: 1 });
        await this.subscribeToAssets();
        SessionManager.startNewSession();

        TelegramService.sendStartupMessage();

        if (CONFIG.TELEGRAM_ENABLED) {
            setInterval(() => TelegramService.sendSessionSummary(), 60 * 60 * 1000);
            LOGGER.info('📱 Telegram notifications enabled');
        }

        LOGGER.info('✅ Bot started successfully!');
    }

    async subscribeToAssets() {
        const symbols = Object.keys(state.assets);

        for (const symbol of symbols) {
            const config = ASSET_CONFIGS[symbol];
            if (!config) continue;

            // Get historical candles
            this.connection.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: 100,
                end: 'latest',
                granularity: CONFIG.GRANULARITY,
                style: 'candles'
            });

            // Subscribe to candle updates
            this.connection.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: 1,
                end: 'latest',
                granularity: CONFIG.GRANULARITY,
                style: 'candles',
                subscribe: 1
            });

            // Subscribe to ticks for current price
            this.connection.send({
                ticks: symbol,
                subscribe: 1
            });

            LOGGER.info(`📡 Subscribed to ${config.name} (${symbol}) - ${CONFIG.TIMEFRAME_LABEL}`);
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    executeTrade(symbol, direction, isReversal = false, previousLoss = 0) {
        if (!RiskManager.canTrade()) return;

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
                StakeManager.fullReset(symbol);
                return;
            }
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
        LOGGER.trade(`   Stake: $${stake.toFixed(2)} | Multiplier: x${multiplier} | Rev: ${assetState.reversalLevel}/${CONFIG.MAX_REVERSAL_LEVEL}`);

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

        // Maintain breakout levels after reversal
        BreakoutManager.maintainBreakoutLevels(symbol);

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
            activePositions: state.portfolio.activePositions.map(pos => {
                const assetState = state.assets[pos.symbol];
                return {
                    symbol: pos.symbol,
                    direction: pos.direction,
                    stake: pos.stake,
                    multiplier: pos.multiplier,
                    profit: pos.currentProfit || 0,
                    reversalLevel: pos.reversalLevel,
                    tpTarget: assetState ? assetState.takeProfitAmount : CONFIG.TAKE_PROFIT,
                    duration: Math.floor((Date.now() - pos.entryTime) / 1000)
                };
            }),
            assetStats: Object.entries(state.assets).map(([symbol, data]) => ({
                symbol,
                wpr: data.wpr.toFixed(1),
                zone: data.wprZone,
                stochK: data.stochastic.k.toFixed(1),
                stochD: data.stochastic.d.toFixed(1),
                direction: data.currentDirection || 'NONE',
                inCycle: data.inTradeCycle ? '🔄' : '-',
                breakoutHigh: data.breakout.active ? data.breakout.highLevel.toFixed(5) : '-',
                breakoutLow: data.breakout.active ? data.breakout.lowLevel.toFixed(5) : '-',
                reversalLevel: `${data.reversalLevel}/${CONFIG.MAX_REVERSAL_LEVEL}`,
                closedCandles: data.closedCandles.length
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

        console.clear(); // Clear screen for better readability

        console.log('\n' + '╔' + '═'.repeat(115) + '╗');
        console.log('║' + `     DERIV BOT v6.3 - ${CONFIG.TIMEFRAME_LABEL} CANDLES | SIGNALS ON CLOSE ONLY`.padEnd(115) + '║');
        console.log('╠' + '═'.repeat(115) + '╣');

        const netPLColor = session.netPL >= 0 ? '\x1b[32m' : '\x1b[31m';
        const resetColor = '\x1b[0m';

        console.log(`║ 💰 Capital: $${status.capital.toFixed(2).padEnd(12)} 🏦 Account: $${status.accountBalance.toFixed(2).padEnd(12)} 📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ON' : 'OFF'}`.padEnd(124) + '║');
        console.log(`║ 📊 Session: ${session.duration.padEnd(10)} Trades: ${session.trades.toString().padEnd(5)} Win Rate: ${session.winRate.padEnd(8)}`.padEnd(124) + '║');
        console.log(`║ 💹 Net P/L: ${netPLColor}$${session.netPL.toFixed(2).padEnd(10)}${resetColor} Target: $${session.profitTarget.toFixed(2).padEnd(10)}`.padEnd(132) + '║');

        console.log('╠' + '═'.repeat(115) + '╣');

        if (status.activePositions.length > 0) {
            console.log('║ 🚀 ACTIVE POSITIONS:'.padEnd(116) + '║');
            console.log('║ Symbol      | Dir  | Stake    | Multi | Profit    | Rev | TP Target | Duration  ║');
            console.log('║' + '-'.repeat(115) + '║');

            status.activePositions.forEach(pos => {
                const profitColor = pos.profit >= 0 ? '\x1b[32m' : '\x1b[31m';
                const profitStr = pos.profit >= 0 ? `+${pos.profit.toFixed(2)}` : pos.profit.toFixed(2);
                const durationStr = this.formatDuration(pos.duration);

                console.log(`║ ${pos.symbol.padEnd(11)} | ${pos.direction.padEnd(4)} | $${pos.stake.toFixed(2).padEnd(7)} | x${pos.multiplier.toString().padEnd(4)} | ${profitColor}${profitStr.padEnd(9)}${resetColor} | ${pos.reversalLevel}/${CONFIG.MAX_REVERSAL_LEVEL} | $${pos.tpTarget.toFixed(2).padEnd(8)} | ${durationStr.padEnd(9)} ║`);
            });
            console.log('╠' + '═'.repeat(115) + '╣');
        }

        console.log('║ 📊 ASSET STATUS (Updated on CANDLE CLOSE only):'.padEnd(116) + '║');
        console.log('║ Symbol      | WPR    | Zone     | Cycle | High Lvl      | Low Lvl       | Rev   | Direction | Candles ║');
        console.log('║' + '-'.repeat(115) + '║');

        status.assetStats.forEach(stat => {
            const cycleColor = stat.inCycle === '🔄' ? '\x1b[33m' : '\x1b[90m';
            const zoneColor = stat.zone === 'oversold' ? '\x1b[36m' : (stat.zone === 'overbought' ? '\x1b[35m' : '\x1b[90m');

            console.log(`║ ${stat.symbol.padEnd(11)} | ${stat.wpr.padEnd(6)} | ${zoneColor}${stat.zone.padEnd(8)}${resetColor} | ${cycleColor}${stat.inCycle.padEnd(5)}${resetColor} | ${stat.breakoutHigh.padEnd(13)} | ${stat.breakoutLow.padEnd(13)} | ${stat.reversalLevel.padEnd(5)} | ${stat.direction.padEnd(9)} | ${stat.closedCandles.toString().padEnd(7)} ║`);
        });

        console.log('╚' + '═'.repeat(115) + '╝');
        console.log(`⏰ ${getGMTTime()} | TF: ${CONFIG.TIMEFRAME} | Active Pos: ${status.activePositionsCount} | Ctrl+C to stop\n`);
    }

    static formatDuration(seconds) {
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        if (minutes < 60) return `${minutes}m ${secs}s`;
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        return `${hours}h ${mins}m`;
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
    console.log('\n\n⚠️  Shutdown signal received...');
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═'.repeat(115));
    console.log('         DERIV MULTIPLIER BOT v6.2');
    console.log('         WPR Strategy - SIGNALS ON CANDLE CLOSE ONLY');
    console.log('═'.repeat(115));
    console.log('\n⚠️  API Token not configured!\n');
    console.log('Usage:');
    console.log('  API_TOKEN=xxx TIMEFRAME=5m TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx node deriv-bot.js');
    console.log('\nEnvironment Variables:');
    console.log('  API_TOKEN           - Deriv API token (required)');
    console.log('  TIMEFRAME           - Candle timeframe: 1m, 2m, 3m, 4m, 5m, 10m, 15m, 30m, 1h, 4h (default: 5m)');
    console.log('  CAPITAL             - Initial capital (default: 500)');
    console.log('  STAKE               - Initial stake (default: 1)');
    console.log('  TAKE_PROFIT         - Take profit per trade (default: 0.5)');
    console.log('  PROFIT_TARGET       - Session profit target (default: 150)');
    console.log('  STOP_LOSS           - Session stop loss (default: -500)');
    console.log('  TELEGRAM_BOT_TOKEN  - Telegram bot token for notifications');
    console.log('  TELEGRAM_CHAT_ID    - Telegram chat ID for notifications');
    console.log('  DEBUG               - Enable debug mode (default: false)');
    console.log('\nKey Fix in v6.2:');
    console.log('  ✅ Indicators only update on CANDLE CLOSE');
    console.log('  ✅ Signals only generated on CANDLE CLOSE');
    console.log('  ✅ No more false signals from tick-by-tick updates');
    console.log('═'.repeat(115));
    process.exit(1);
}

console.log('═'.repeat(115));
console.log('         DERIV MULTIPLIER BOT v6.2');
console.log(`         Timeframe: ${CONFIG.TIMEFRAME_LABEL} | Signals: ON CANDLE CLOSE ONLY`);
console.log('═'.repeat(115));
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
