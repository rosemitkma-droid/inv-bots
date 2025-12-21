#!/usr/bin/env node
/**
 * Deriv Breakout Trading Bot v5.1
 * WPR Breakout Strategy with Price Confirmation & Auto-Recovery
 * 
 * STRATEGY:
 * ---------
 * BUY SETUP:
 * 1. WPR crosses above -20 (Previous WPR ≤ -20, Current WPR > -20)
 * 2. Mark previous candle High/Low as breakout levels
 * 3. Execute BUY when price CLOSES ABOVE breakout High
 * 4. If price reverses and CLOSES BELOW breakout Low:
 *    - Close BUY, open SELL at 2x stake
 *    - If loss, add to Take Profit target
 * 
 * SELL SETUP:
 * 1. WPR crosses below -80 (Previous WPR ≥ -80, Current WPR < -80)
 * 2. Mark previous candle High/Low as breakout levels
 * 3. Execute SELL when price CLOSES BELOW breakout Low
 * 4. If price reverses and CLOSES ABOVE breakout High:
 *    - Close SELL, open BUY at 2x stake
 *    - If loss, add to Take Profit target
 * 
 * AUTO-RECOVERY:
 * - If reversalLevel > 0 and currentProfit >= accumulatedLoss
 * - Auto-close position, reset stake, wait for new entry
 * 
 * BREAKOUT EXPIRY:
 * - Breakout levels only expire when NEW breakout signal forms
 * 
 * TIMEFRAMES:
 * - Configurable: 1m, 2m, 3m, 4m, 5m, 10m, 15m, 30m, 1h, 4h
 * 
 * Dependencies: npm install ws mathjs nodemailer
 * Usage: API_TOKEN=your_token TIMEFRAME=5m node deriv-breakout-bot.js
 */

const WebSocket = require('ws');
const math = require('mathjs');
const nodemailer = require('nodemailer');

// ============================================
// LOGGER UTILITY
// ============================================

const LOGGER = {
    info: (msg) => console.log(`[INFO] ${new Date().toLocaleTimeString()} - ${msg}`),
    trade: (msg) => console.log(`\x1b[32m[TRADE] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`),
    signal: (msg) => console.log(`\x1b[36m[SIGNAL] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`),
    breakout: (msg) => console.log(`\x1b[35m[BREAKOUT] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`),
    recovery: (msg) => console.log(`\x1b[33m[RECOVERY] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`),
    warn: (msg) => console.warn(`\x1b[33m[WARN] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`),
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`); }
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

// Get timeframe from environment or default to 1m
const SELECTED_TIMEFRAME = process.env.TIMEFRAME || '5m';
const TIMEFRAME_CONFIG = TIMEFRAMES[SELECTED_TIMEFRAME] || TIMEFRAMES['5m'];

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
    // API Settings
    API_TOKEN: process.env.API_TOKENs || 'DMylfkyce6VyZt7',
    APP_ID: process.env.APP_ID || '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Capital Settings
    INITIAL_CAPITAL: parseFloat(process.env.CAPITAL) || 500,
    INITIAL_STAKE: parseFloat(process.env.STAKE) || 1.00,
    TAKE_PROFIT: parseFloat(process.env.TAKE_PROFIT) || 0.06,

    // Session Targets
    SESSION_PROFIT_TARGET: parseFloat(process.env.PROFIT_TARGET) || 150,
    SESSION_STOP_LOSS: parseFloat(process.env.STOP_LOSS) || -500,

    // Breakout & Reversal Settings
    REVERSAL_STAKE_MULTIPLIER: 1.5,      // 2x stake on reversal
    MAX_REVERSAL_LEVEL: 10,               // Max consecutive reversals
    AUTO_CLOSE_ON_RECOVERY: true,        // Auto-close when profit >= accumulated loss

    // Timeframe Settings
    TIMEFRAME: SELECTED_TIMEFRAME,
    GRANULARITY: TIMEFRAME_CONFIG.granularity,
    TIMEFRAME_LABEL: TIMEFRAME_CONFIG.label,

    // WPR Settings
    WPR_PERIOD: 80,
    WPR_OVERBOUGHT: -20,
    WPR_OVERSOLD: -80,

    // Trade Settings
    MAX_TRADES_PER_ASSET: 200,
    MAX_OPEN_POSITIONS: 100,
    TOP_ASSETS_TO_TRADE: 2,

    // Timing
    ASSET_SCORING_INTERVAL: 5 * 60 * 1000,
    COOLDOWN_AFTER_SESSION_END: 30 * 60 * 1000,
    PROFIT_CHECK_INTERVAL: 1000,         // Check profit recovery every second

    // Risk Settings
    MIN_WIN_RATE_THRESHOLD: 0.40,
    WIN_RATE_LOOKBACK: 20,
    BLACKLIST_PERIOD: 24 * 60 * 60 * 1000,

    // Performance
    MAX_TICKS_STORED: 100,
    MAX_CANDLES_STORED: 150,
    DASHBOARD_UPDATE_INTERVAL: 5000,

    // Debug
    DEBUG_MODE: process.env.DEBUG === 'true' || false,

    // Email Settings
    EMAIL_ENABLED: process.env.EMAIL_ENABLED === 'true' || false,
    EMAIL_CONFIG: {
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER || '',
            pass: process.env.EMAIL_PASS || ''
        }
    },
    EMAIL_RECIPIENT: process.env.EMAIL_RECIPIENT || ''
};

// ============================================
// ASSET CONFIGURATION
// ============================================

const ASSET_CONFIGS = {
    // Volatility Indices
    // 'R_10': {
    //     name: 'Volatility 10 Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [400, 1000, 2000, 3000, 4000],
    //     defaultMultiplier: 400,
    //     wprPeriod: 80,
    //     maxTradesPerDay: 100,
    //     minStake: 1.00,
    //     maxStake: 2000,
    //     tradingHours: '24/7'
    // },
    // 'R_25': {
    //     name: 'Volatility 25 Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [160, 400, 800, 1200, 1600],
    //     defaultMultiplier: 160,
    //     wprPeriod: 80,
    //     maxTradesPerDay: 100,
    //     minStake: 1.00,
    //     maxStake: 2000,
    //     tradingHours: '24/7'
    // },
    // 'R_50': {
    //     name: 'Volatility 50 Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [80, 200, 400, 600, 800],
    //     defaultMultiplier: 80,
    //     wprPeriod: 80,
    //     maxTradesPerDay: 80,
    //     minStake: 1.00,
    //     maxStake: 2000,
    //     tradingHours: '24/7'
    // },
    'R_75': {
        name: 'Volatility 75 Index',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 500],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 50,
        minStake: 1.00,
        maxStake: 3000,
        tradingHours: '24/7'
    },
    // 'R_100': {
    //     name: 'Volatility 100 Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [40, 100, 200, 300, 500],
    //     defaultMultiplier: 40,
    //     wprPeriod: 80,
    //     maxTradesPerDay: 50,
    //     minStake: 1.00,
    //     maxStake: 3000,
    //     tradingHours: '24/7'
    // },
    // 1-Second Volatility
    // '1HZ10V': {
    //     name: 'Volatility 10 (1s) Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [400, 1000, 2000, 3000, 4000],
    //     defaultMultiplier: 400,
    //     wprPeriod: 80,
    //     maxTradesPerDay: 150,
    //     minStake: 1.00,
    //     maxStake: 1000,
    //     tradingHours: '24/7'
    // },
    // '1HZ25V': {
    //     name: 'Volatility 25 (1s) Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [160, 400, 800, 1200, 1600],
    //     defaultMultiplier: 160,
    //     wprPeriod: 80,
    //     maxTradesPerDay: 150,
    //     minStake: 1.00,
    //     maxStake: 1000,
    //     tradingHours: '24/7'
    // },
    // '1HZ50V': {
    //     name: 'Volatility 50 (1s) Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [80, 200, 400, 600, 800],
    //     defaultMultiplier: 80,
    //     wprPeriod: 80,
    //     maxTradesPerDay: 120,
    //     minStake: 1.00,
    //     maxStake: 1000,
    //     tradingHours: '24/7'
    // },
    // '1HZ75V': {
    //     name: 'Volatility 75 (1s) Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [50, 100, 200, 300, 500],
    //     defaultMultiplier: 50,
    //     wprPeriod: 80,
    //     maxTradesPerDay: 100,
    //     minStake: 0.05,
    //     maxStake: 1500,
    //     tradingHours: '24/7'
    // },
    // '1HZ100V': {
    //     name: 'Volatility 100 (1s) Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [20, 40, 60, 80, 100, 200, 300, 400, 500, 1000],
    //     defaultMultiplier: 20,
    //     wprPeriod: 80,
    //     maxTradesPerDay: 100,
    //     minStake: 1.00,
    //     maxStake: 1500,
    //     tradingHours: '24/7'
    // },
    // Boom/Crash
    // 'BOOM1000': {
    //     name: 'Boom 1000 Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [20, 40, 60, 80, 100, 150, 200, 250, 300],
    //     defaultMultiplier: 20,
    //     wprPeriod: 80,
    //     maxTradesPerDay: 150,
    //     minStake: 0.35,
    //     maxStake: 500,
    //     onlyDirection: 'UP',
    //     tradingHours: '24/7'
    // },
    // 'CRASH1000': {
    //     name: 'Crash 1000 Index',
    //     category: 'synthetic',
    //     contractType: 'multiplier',
    //     multipliers: [20, 40, 60, 80, 100, 150, 200, 250, 300],
    //     defaultMultiplier: 20,
    //     wprPeriod: 80,
    //     maxTradesPerDay: 150,
    //     minStake: 0.35,
    //     maxStake: 500,
    //     onlyDirection: 'DOWN',
    //     tradingHours: '24/7'
    // },
    // Jump Indices
    'JD10': {
        name: 'Jump 10 Index',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200],
        defaultMultiplier: 20,
        wprPeriod: 80,
        maxTradesPerDay: 10,
        minStake: 0.35,
        maxStake: 1000,
        tradingHours: '24/7'
    },
    'JD25': {
        name: 'Jump 25 Index',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200],
        defaultMultiplier: 20,
        wprPeriod: 80,
        maxTradesPerDay: 10,
        minStake: 0.35,
        maxStake: 1000,
        tradingHours: '24/7'
    },
    'JD50': {
        name: 'Jump 50 Index',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200],
        defaultMultiplier: 20,
        wprPeriod: 80,
        maxTradesPerDay: 8,
        minStake: 0.50,
        maxStake: 1000,
        tradingHours: '24/7'
    },
    'JD75': {
        name: 'Jump 75 Index',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200],
        defaultMultiplier: 20,
        wprPeriod: 80,
        maxTradesPerDay: 6,
        minStake: 0.50,
        maxStake: 1500,
        tradingHours: '24/7'
    },
    'JD100': {
        name: 'Jump 100 Index',
        category: 'synthetic',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200],
        defaultMultiplier: 20,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        minStake: 0.50,
        maxStake: 1500,
        tradingHours: '24/7'
    },
    // Forex
    'frxEURUSD': {
        name: 'EUR/USD',
        category: 'forex',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 400, 500, 1000],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        minStake: 5,
        maxStake: 5000,
        tradingHours: 'Sun 22:05 - Fri 21:55 GMT'
    },
    'frxGBPUSD': {
        name: 'GBP/USD',
        category: 'forex',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 400, 500, 1000],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        minStake: 5,
        maxStake: 5000,
        tradingHours: 'Sun 22:05 - Fri 21:55 GMT'
    },
    'frxUSDJPY': {
        name: 'USD/JPY',
        category: 'forex',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 400, 500, 1000],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        minStake: 5,
        maxStake: 5000,
        tradingHours: 'Sun 22:05 - Fri 21:55 GMT'
    },
    // Crypto
    'cryBTCUSD': {
        name: 'Bitcoin/USD',
        category: 'crypto',
        contractType: 'multiplier',
        multipliers: [50, 100, 150, 200, 250, 300],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 8,
        minStake: 5,
        maxStake: 3000,
        tradingHours: '24/7'
    },
    'cryETHUSD': {
        name: 'Ethereum/USD',
        category: 'crypto',
        contractType: 'multiplier',
        multipliers: [50, 100, 150, 200, 250, 300],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 8,
        minStake: 5,
        maxStake: 3000,
        tradingHours: '24/7'
    },
    // Commodities
    'frxXAUUSD': {
        name: 'Gold/USD',
        category: 'commodity',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 400, 500],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        minStake: 5,
        maxStake: 5000,
        tradingHours: 'Sun 23:00 - Fri 21:55 GMT'
    },
    'frxXAGUSD': {
        name: 'Silver/USD',
        category: 'commodity',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        minStake: 5,
        maxStake: 3000,
        tradingHours: 'Sun 23:00 - Fri 21:55 GMT'
    }
};

// Active assets
let ACTIVE_ASSETS = process.env.ASSETS
    ? process.env.ASSETS.split(',')
    : ['R_75', '1HZ50V'];//['R_10', 'R_75', 'R_100', '1HZ10V', '1HZ50V'];

// ============================================
// STATE MANAGEMENT
// ============================================

const state = {
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,

    // Session tracking
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

    // Connection
    isConnected: false,
    isAuthorized: false,

    // Per-asset state
    assets: {},

    // Portfolio
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

// Initialize asset states with breakout tracking
function initializeAssetStates() {
    ACTIVE_ASSETS.forEach(symbol => {
        if (ASSET_CONFIGS[symbol]) {
            const config = ASSET_CONFIGS[symbol];

            state.assets[symbol] = {
                // Price data
                candles: [],
                ticks: [],
                currentPrice: 0,

                // WPR tracking
                wpr: -50,
                prevWpr: -50,

                // BREAKOUT LEVELS
                breakout: {
                    active: false,
                    type: null,           // 'BUY_SETUP' or 'SELL_SETUP'
                    highLevel: 0,         // Upper breakout level
                    lowLevel: 0,          // Lower breakout level
                    triggerCandle: 0,     // Epoch of trigger candle
                    confirmedEntry: false // Whether price confirmed breakout
                },

                // Active trade tracking
                activePosition: null,
                currentDirection: null,

                // Reversal & stake management
                currentStake: CONFIG.INITIAL_STAKE,
                takeProfit: CONFIG.TAKE_PROFIT,
                reversalLevel: 0,         // How many times we've reversed
                accumulatedLoss: 0,       // Loss to recover
                takeProfitAmount: 0,      // Dynamic TP including losses

                // Daily stats
                dailyTrades: 0,
                dailyWins: 0,
                dailyLosses: 0,
                consecutiveLosses: 0,
                blacklistedUntil: 0,
                tradeHistory: [],
                winRate: 0.5,
                score: 0,
                lastBarTime: 0
            };
        }
    });

    LOGGER.info(`Initialized ${Object.keys(state.assets).length} assets with breakout tracking`);
    LOGGER.info(`Timeframe: ${CONFIG.TIMEFRAME_LABEL} (${CONFIG.GRANULARITY}s candles)`);
}

initializeAssetStates();

// ============================================
// TECHNICAL INDICATORS
// ============================================

class TechnicalIndicators {
    /**
     * Calculate Williams Percent Range (WPR)
     */
    static calculateWPR(highs, lows, closes, period = 80) {
        if (!closes || closes.length < period) {
            return -50;
        }

        const recentHighs = highs.slice(-period);
        const recentLows = lows.slice(-period);
        const currentClose = closes[closes.length - 1];

        const highestHigh = Math.max(...recentHighs);
        const lowestLow = Math.min(...recentLows);
        const range = highestHigh - lowestLow;

        if (range === 0) return -50;

        const wpr = ((highestHigh - currentClose) / range) * -100;
        return wpr;
    }

    /**
     * Detect WPR crossover for breakout setup
     */
    static detectWPRCrossover(prevWpr, currWpr) {
        // BUY SETUP: WPR crosses above -20
        if (prevWpr <= CONFIG.WPR_OVERBOUGHT && currWpr > CONFIG.WPR_OVERBOUGHT) {
            return 'BUY_SETUP';
        }

        // SELL SETUP: WPR crosses below -80
        if (prevWpr >= CONFIG.WPR_OVERSOLD && currWpr < CONFIG.WPR_OVERSOLD) {
            return 'SELL_SETUP';
        }

        return null;
    }
}

// ============================================
// BREAKOUT MANAGER
// ============================================

class BreakoutManager {
    /**
     * Set up breakout levels when WPR signal occurs
     * Breakout only expires when a NEW breakout signal forms
     */
    static setupBreakoutLevels(symbol, setupType) {
        const assetState = state.assets[symbol];
        const candles = assetState.candles;

        if (candles.length < 2) {
            LOGGER.warn(`${symbol}: Not enough candles for breakout setup`);
            return false;
        }

        // Get the PREVIOUS candle (the one before current)
        const prevCandle = candles[candles.length - 2];

        // If we already have an active breakout, this new signal REPLACES it
        if (assetState.breakout.active) {
            LOGGER.breakout(`${symbol}: New ${setupType} replaces previous ${assetState.breakout.type}`);
        }

        // Set new breakout levels
        assetState.breakout = {
            active: true,
            type: setupType,
            highLevel: prevCandle.high,
            lowLevel: prevCandle.low,
            triggerCandle: prevCandle.epoch,
            confirmedEntry: false
        };

        LOGGER.breakout(`${symbol} ${setupType} - Levels set: High=${prevCandle.high.toFixed(5)}, Low=${prevCandle.low.toFixed(5)}`);

        return true;
    }

    /**
     * Check if price has confirmed breakout (closed above/below level)
     */
    static checkBreakoutConfirmation(symbol) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];
        const breakout = assetState.breakout;
        const candles = assetState.candles;

        if (!breakout.active || breakout.confirmedEntry) {
            return null;
        }

        // Get current (just closed) candle
        const currentCandle = candles[candles.length - 1];
        const closePrice = currentCandle.close;

        // Check direction restrictions
        if (config.onlyDirection) {
            if (breakout.type === 'BUY_SETUP' && config.onlyDirection !== 'UP') {
                LOGGER.debug(`${symbol}: BUY blocked - asset only allows ${config.onlyDirection}`);
                return null;
            }
            if (breakout.type === 'SELL_SETUP' && config.onlyDirection !== 'DOWN') {
                LOGGER.debug(`${symbol}: SELL blocked - asset only allows ${config.onlyDirection}`);
                return null;
            }
        }

        // BUY CONFIRMATION: Price closes ABOVE breakout high
        if (breakout.type === 'BUY_SETUP' && closePrice > breakout.highLevel) {
            LOGGER.breakout(`${symbol} BUY CONFIRMED! Close ${closePrice.toFixed(5)} > High ${breakout.highLevel.toFixed(5)}`);
            breakout.confirmedEntry = true;
            return 'UP';
        }

        // SELL CONFIRMATION: Price closes BELOW breakout low
        if (breakout.type === 'SELL_SETUP' && closePrice < breakout.lowLevel) {
            LOGGER.breakout(`${symbol} SELL CONFIRMED! Close ${closePrice.toFixed(5)} < Low ${breakout.lowLevel.toFixed(5)}`);
            breakout.confirmedEntry = true;
            return 'DOWN';
        }

        LOGGER.debug(`${symbol}: Waiting for breakout confirmation (Close: ${closePrice.toFixed(5)}, High: ${breakout.highLevel.toFixed(5)}, Low: ${breakout.lowLevel.toFixed(5)})`);
        return null;
    }

    /**
     * Check if price has reversed through opposite breakout level
     */
    static checkReversal(symbol) {
        const assetState = state.assets[symbol];
        const breakout = assetState.breakout;
        const candles = assetState.candles;

        if (!assetState.activePosition || !breakout.active) {
            return null;
        }

        const currentCandle = candles[candles.length - 1];
        const closePrice = currentCandle.close;
        const currentDirection = assetState.currentDirection;

        // If we're in a BUY and price closes BELOW the low level = REVERSAL to SELL
        if (currentDirection === 'UP' && closePrice < breakout.lowLevel) {
            LOGGER.breakout(`${symbol} REVERSAL! BUY invalidated - Close ${closePrice.toFixed(5)} < Low ${breakout.lowLevel.toFixed(5)}`);
            return 'DOWN';
        }

        // If we're in a SELL and price closes ABOVE the high level = REVERSAL to BUY
        if (currentDirection === 'DOWN' && closePrice > breakout.highLevel) {
            LOGGER.breakout(`${symbol} REVERSAL! SELL invalidated - Close ${closePrice.toFixed(5)} > High ${breakout.highLevel.toFixed(5)}`);
            return 'UP';
        }

        return null;
    }

    /**
     * Clear breakout setup (only called on full reset)
     */
    static clearBreakout(symbol) {
        const assetState = state.assets[symbol];
        assetState.breakout = {
            active: false,
            type: null,
            highLevel: 0,
            lowLevel: 0,
            triggerCandle: 0,
            confirmedEntry: false
        };
    }

    /**
     * Update breakout levels for a reversal (use current candle)
     */
    static updateBreakoutForReversal(symbol, newDirection) {
        const assetState = state.assets[symbol];
        const candles = assetState.candles;

        if (candles.length < 1) return;

        const currentCandle = candles[candles.length - 1];

        // Update breakout levels to current candle
        assetState.breakout = {
            active: true,
            type: newDirection === 'UP' ? 'BUY_SETUP' : 'SELL_SETUP',
            highLevel: currentCandle.high,
            lowLevel: currentCandle.low,
            triggerCandle: currentCandle.epoch,
            confirmedEntry: true // Already confirmed by reversal
        };

        LOGGER.breakout(`${symbol} Breakout levels updated for reversal: High=${currentCandle.high.toFixed(5)}, Low=${currentCandle.low.toFixed(5)}`);
    }
}

// ============================================
// STAKE MANAGER
// ============================================

class StakeManager {
    /**
     * Get stake for initial trade
     */
    static getInitialStake(symbol) {
        const config = ASSET_CONFIGS[symbol];
        const assetState = state.assets[symbol];

        // Reset to initial stake
        assetState.currentStake = CONFIG.INITIAL_STAKE;
        assetState.takeProfit = CONFIG.TAKE_PROFIT;
        assetState.reversalLevel = 0;
        assetState.accumulatedLoss = 0;
        assetState.takeProfitAmount = 0;

        return this.validateStake(symbol, assetState.currentStake);
    }

    /**
     * Get stake for reversal trade (2x previous)
     */
    static getReversalStake(symbol, previousLoss = 0) {
        const config = ASSET_CONFIGS[symbol];
        const assetState = state.assets[symbol];

        // Check max reversal level
        if (assetState.reversalLevel >= CONFIG.MAX_REVERSAL_LEVEL) {
            LOGGER.warn(`${symbol}: Max reversal level reached (${CONFIG.MAX_REVERSAL_LEVEL}), resetting`);
            return this.getInitialStake(symbol);
        }

        // Double the stake
        assetState.currentStake *= CONFIG.REVERSAL_STAKE_MULTIPLIER;
        assetState.reversalLevel++;

        // Track accumulated loss for TP adjustment
        if (previousLoss < 0) {
            assetState.accumulatedLoss += Math.abs(previousLoss);
        }

        // Calculate dynamic take profit (base + accumulated loss)
        const baseTakeProfit = assetState.takeProfit; // base TP
        assetState.takeProfitAmount = baseTakeProfit + assetState.accumulatedLoss;

        LOGGER.trade(`${symbol} Reversal stake: $${assetState.currentStake.toFixed(2)} (Level ${assetState.reversalLevel})`);
        LOGGER.trade(`${symbol} Accumulated loss: $${assetState.accumulatedLoss.toFixed(2)}, Dynamic TP: $${assetState.takeProfitAmount.toFixed(2)}`);

        return this.validateStake(symbol, assetState.currentStake);
    }

    /**
     * Full reset after recovery or win
     */
    static fullReset(symbol) {
        const assetState = state.assets[symbol];

        LOGGER.recovery(`${symbol} 🎉 Full reset - Stake back to initial`);

        assetState.currentStake = CONFIG.INITIAL_STAKE;
        assetState.reversalLevel = 0;
        assetState.accumulatedLoss = 0;
        assetState.takeProfitAmount = 0;
        assetState.activePosition = null;
        assetState.currentDirection = null;

        // Clear breakout and wait for new signal
        BreakoutManager.clearBreakout(symbol);
    }

    /**
     * Check if current profit covers accumulated loss (for auto-close)
     */
    static shouldAutoClose(symbol, currentProfit) {
        const assetState = state.assets[symbol];

        // Only auto-close if we have reversals and profit > accumulated loss
        if (assetState.reversalLevel > 0 &&
            currentProfit > 0 &&
            currentProfit > assetState.accumulatedLoss &&
            CONFIG.AUTO_CLOSE_ON_RECOVERY) {
            return true;
        }

        return false;
    }

    /**
     * Validate stake against asset limits
     */
    static validateStake(symbol, stake) {
        const config = ASSET_CONFIGS[symbol];

        // Ensure minimum stake
        stake = Math.max(stake, config.minStake);

        // Cap at maximum
        stake = Math.min(stake, config.maxStake);

        // Cap at 10% of capital
        stake = Math.min(stake, state.capital * 0.10);

        // Check if we can afford this stake
        if (stake < config.minStake) {
            LOGGER.error(`${symbol}: Cannot afford min stake. Required: $${config.minStake}, Available: $${stake.toFixed(2)}`);
            return 0;
        }

        return parseFloat(stake.toFixed(2));
    }

    /**
     * Get valid multiplier for asset
     */
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

        LOGGER.info(`⏸️ Session ended (${reason}). Paused for ${CONFIG.COOLDOWN_AFTER_SESSION_END / 60000} minutes.`);

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

        // Reset all asset states
        Object.keys(state.assets).forEach(symbol => {
            StakeManager.fullReset(symbol);
        });

        LOGGER.info('🚀 NEW SESSION STARTED');
        LOGGER.info(`💰 Capital: $${state.capital.toFixed(2)} | Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop: $${CONFIG.SESSION_STOP_LOSS}`);
        LOGGER.info(`📊 Timeframe: ${CONFIG.TIMEFRAME_LABEL}`);
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
        if (!SessionManager.isSessionActive()) {
            return false;
        }

        if (SessionManager.checkSessionTargets()) {
            return false;
        }

        if (state.portfolio.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) {
            return false;
        }

        if (state.capital < CONFIG.INITIAL_STAKE * 2) {
            LOGGER.error('Insufficient capital');
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

        if (assetState.dailyTrades >= config.maxTradesPerDay) {
            return { allowed: false, reason: 'Daily trade limit reached' };
        }

        if (Date.now() < assetState.blacklistedUntil) {
            return { allowed: false, reason: 'Asset blacklisted' };
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

        // Update trade history
        assetState.tradeHistory.push({
            timestamp: Date.now(),
            direction,
            profit
        });

        if (assetState.tradeHistory.length > 100) {
            assetState.tradeHistory = assetState.tradeHistory.slice(-100);
        }

        // Update win rate
        const recentTrades = assetState.tradeHistory.slice(-CONFIG.WIN_RATE_LOOKBACK);
        assetState.winRate = recentTrades.length > 0
            ? recentTrades.filter(t => t.profit > 0).length / recentTrades.length
            : 0.5;
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
        this.profitCheckInterval = null;
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

        this.send({ authorize: CONFIG.API_TOKEN });
    }

    onMessage(data) {
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

        if (response.req_id && state.pendingRequests.has(response.req_id)) {
            const { resolve } = state.pendingRequests.get(response.req_id);
            state.pendingRequests.delete(response.req_id);
            resolve(response);
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
        const candle = {
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close),
            epoch: ohlc.epoch
        };

        const candles = assetState.candles;
        const isNewBar = candles.length === 0 || candles[candles.length - 1].epoch !== candle.epoch;

        if (isNewBar) {
            candles.push(candle);
            assetState.lastBarTime = candle.epoch;

            // Process on new bar close
            this.processNewBar(symbol);
        } else {
            candles[candles.length - 1] = candle;
        }

        if (candles.length > CONFIG.MAX_CANDLES_STORED) {
            state.assets[symbol].candles = candles.slice(-CONFIG.MAX_CANDLES_STORED);
        }

        // Update WPR indicator
        this.updateIndicators(symbol);
    }

    handleCandlesHistory(response) {
        if (response.error) {
            LOGGER.error(`Error fetching candles: ${response.error.message}`);
            return;
        }

        const symbol = response.echo_req.ticks_history;
        if (!state.assets[symbol]) return;

        state.assets[symbol].candles = response.candles.map(c => ({
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close),
            epoch: c.epoch
        }));

        LOGGER.info(`📊 Loaded ${response.candles.length} candles for ${symbol} (${CONFIG.TIMEFRAME_LABEL})`);
        this.updateIndicators(symbol);
    }

    updateIndicators(symbol) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];
        const candles = assetState.candles;

        if (candles.length < config.wprPeriod + 2) return;

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);

        // Store previous WPR
        assetState.prevWpr = assetState.wpr;

        // Calculate current WPR
        assetState.wpr = TechnicalIndicators.calculateWPR(highs, lows, closes, config.wprPeriod);
    }

    /**
     * Main trading logic - called on each new bar
     */
    processNewBar(symbol) {
        const assetState = state.assets[symbol];
        const candles = assetState.candles;

        if (candles.length < 3) return;

        // 1. Check for WPR crossover (new breakout setup)
        const crossover = TechnicalIndicators.detectWPRCrossover(assetState.prevWpr, assetState.wpr);

        if (crossover) {
            LOGGER.signal(`${symbol} WPR ${crossover} (WPR: ${assetState.wpr.toFixed(2)} from ${assetState.prevWpr.toFixed(2)})`);

            // New breakout signal REPLACES any existing breakout (no expiry, only replacement)
            BreakoutManager.setupBreakoutLevels(symbol, crossover);

            // If we have an active position in opposite direction, check for reversal
            if (assetState.activePosition) {
                const currentDir = assetState.currentDirection;
                const newDir = crossover === 'BUY_SETUP' ? 'UP' : 'DOWN';

                if ((currentDir === 'UP' && newDir === 'DOWN') || (currentDir === 'DOWN' && newDir === 'UP')) {
                    LOGGER.signal(`${symbol}: New opposite signal - will check for reversal confirmation`);
                }
            }
        }

        // 2. If no active position, check for breakout confirmation to enter
        if (!assetState.activePosition && assetState.breakout.active) {
            const confirmation = BreakoutManager.checkBreakoutConfirmation(symbol);

            if (confirmation) {
                bot.executeTrade(symbol, confirmation, false); // false = not a reversal
            }
        }

        // 3. If active position, check for reversal
        if (assetState.activePosition && assetState.breakout.active) {
            const reversal = BreakoutManager.checkReversal(symbol);

            if (reversal) {
                bot.executeReversal(symbol, reversal);
            }
        }
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);

            // Clean up failed position
            const reqId = response.echo_req?.req_id;
            if (reqId) {
                const posIndex = state.portfolio.activePositions.findIndex(p => p.reqId === reqId);
                if (posIndex >= 0) {
                    const pos = state.portfolio.activePositions[posIndex];
                    if (state.assets[pos.symbol]) {
                        state.assets[pos.symbol].activePosition = null;
                        state.assets[pos.symbol].currentDirection = null;
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
        }

        // Subscribe to contract updates
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
                // Check if this was auto-recovery close
                if (position.isRecoveryClose) {
                    LOGGER.recovery(`${position.symbol}: Recovery close completed. Profit: $${profit.toFixed(2)}`);
                    StakeManager.fullReset(position.symbol);
                }
                // If this was a reversal trade, execute the new direction
                else if (position.pendingReversal) {
                    const reversalDir = position.pendingReversal;
                    const lossAmount = profit < 0 ? profit : 0;

                    assetState.activePosition = null;
                    assetState.currentDirection = null;

                    // Small delay to allow state to update
                    setTimeout(() => {
                        bot.executeTrade(position.symbol, reversalDir, true, lossAmount);
                    }, 500);
                } else {
                    assetState.activePosition = null;
                    assetState.currentDirection = null;

                    // Normal close - check if we should reset
                    if (profit > 0 && assetState.reversalLevel > 0) {
                        if (profit >= assetState.accumulatedLoss) {
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
                }
            }

            SessionManager.checkSessionTargets();

            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }
        } else if (posIndex >= 0) {
            const position = state.portfolio.activePositions[posIndex];
            position.currentProfit = contract.profit;
            position.currentPrice = contract.current_spot;

            // Check for auto-recovery close
            const assetState = state.assets[position.symbol];
            if (assetState && StakeManager.shouldAutoClose(position.symbol, contract.profit)) {
                LOGGER.recovery(`${position.symbol}: Profit $${contract.profit.toFixed(2)} >= Accumulated Loss $${assetState.accumulatedLoss.toFixed(2)} - AUTO CLOSING`);

                position.isRecoveryClose = true;

                // Close the position
                this.send({
                    sell: contract.contract_id,
                    price: 0
                });
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

        if (this.profitCheckInterval) {
            clearInterval(this.profitCheckInterval);
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            LOGGER.info(`🔄 Reconnecting in ${this.reconnectDelay / 1000}s...`);
            setTimeout(() => this.connect(), this.reconnectDelay);
        } else {
            LOGGER.error('Max reconnection attempts reached. Exiting.');
            process.exit(1);
        }
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

class DerivBreakoutBot {
    constructor() {
        this.connection = new ConnectionManager();
    }

    async start() {
        console.log('\n' + '═'.repeat(70));
        console.log('         DERIV BREAKOUT BOT v5.1');
        console.log('         WPR Breakout Strategy with Auto-Recovery');
        console.log('═'.repeat(70));
        console.log(`💰 Initial Capital: $${state.capital}`);
        console.log(`📊 Active Assets: ${ACTIVE_ASSETS.length} (${ACTIVE_ASSETS.join(', ')})`);
        console.log(`⏱️  Timeframe: ${CONFIG.TIMEFRAME_LABEL} (${CONFIG.GRANULARITY}s candles)`);
        console.log(`🎯 Session Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`);
        console.log(`🔄 Reversal Multiplier: ${CONFIG.REVERSAL_STAKE_MULTIPLIER}x | Max Level: ${CONFIG.MAX_REVERSAL_LEVEL}`);
        console.log(`📈 Auto-Recovery: ${CONFIG.AUTO_CLOSE_ON_RECOVERY ? 'ENABLED' : 'DISABLED'}`);
        console.log('═'.repeat(70) + '\n');

        this.connection.send({ balance: 1, subscribe: 1 });

        await this.subscribeToAssets();

        SessionManager.startNewSession();

        LOGGER.info('✅ Bot started successfully!');
    }

    async subscribeToAssets() {
        const symbols = Object.keys(state.assets);

        for (const symbol of symbols) {
            const config = ASSET_CONFIGS[symbol];
            if (!config) continue;

            // Get candle history with selected timeframe
            this.connection.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: 100,
                end: 'latest',
                granularity: CONFIG.GRANULARITY,
                style: 'candles'
            });

            // Subscribe to OHLC updates with selected timeframe
            this.connection.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: 1,
                end: 'latest',
                granularity: CONFIG.GRANULARITY,
                style: 'candles',
                subscribe: 1
            });

            // Subscribe to ticks for real-time price
            this.connection.send({
                ticks: symbol,
                subscribe: 1
            });

            LOGGER.info(`📡 Subscribed to ${config.name} (${symbol}) - ${CONFIG.TIMEFRAME_LABEL} candles`);

            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    /**
     * Execute a new trade
     */
    executeTrade(symbol, direction, isReversal = false, previousLoss = 0) {
        if (!RiskManager.canTrade()) {
            return;
        }

        const assetCheck = RiskManager.canAssetTrade(symbol);
        if (!assetCheck.allowed) {
            LOGGER.debug(`Trade blocked: ${assetCheck.reason}`);
            return;
        }

        const config = ASSET_CONFIGS[symbol];
        const assetState = state.assets[symbol];

        // Get stake based on whether this is a reversal
        let stake;
        if (isReversal) {
            stake = StakeManager.getReversalStake(symbol, previousLoss);
        } else {
            stake = StakeManager.getInitialStake(symbol);
        }

        if (stake <= 0) {
            LOGGER.error(`Cannot trade ${symbol}: Insufficient stake`);
            return;
        }

        const contractType = direction === 'UP' ? 'MULTUP' : 'MULTDOWN';
        const multiplier = StakeManager.getMultiplier(symbol);

        LOGGER.trade(`🎯 ${isReversal ? 'REVERSAL' : 'NEW'} ${direction} on ${config.name} (${symbol})`);
        LOGGER.trade(`   Type: ${contractType} | Stake: $${stake.toFixed(2)} | Multiplier: x${multiplier}`);
        LOGGER.trade(`   Reversal Level: ${assetState.reversalLevel} | Accum Loss: $${assetState.accumulatedLoss.toFixed(2)}`);
        LOGGER.trade(`   Timeframe: ${CONFIG.TIMEFRAME_LABEL}`);

        // Create position
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
            isRecoveryClose: false
        };

        state.portfolio.activePositions.push(position);

        // Build trade request
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

        // Add dynamic take profit if we have accumulated loss
        if (assetState.takeProfitAmount > 0) {
            tradeRequest.parameters.limit_order = {
                take_profit: assetState.takeProfitAmount
            };
            LOGGER.trade(`   Dynamic TP: $${assetState.takeProfitAmount.toFixed(2)} (includes loss recovery)`);
        }

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;

        // Update asset state
        assetState.dailyTrades++;
        assetState.currentDirection = direction;
    }

    /**
     * Execute a reversal (close current + open opposite)
     */
    executeReversal(symbol, newDirection) {
        const assetState = state.assets[symbol];
        const position = assetState.activePosition;

        if (!position || !position.contractId) {
            LOGGER.warn(`No active position to reverse on ${symbol}`);
            this.executeTrade(symbol, newDirection, false);
            return;
        }

        LOGGER.trade(`🔄 REVERSING ${symbol}: ${position.direction} → ${newDirection}`);

        // Mark position for reversal after close
        position.pendingReversal = newDirection;

        // Update breakout levels for the reversal
        BreakoutManager.updateBreakoutForReversal(symbol, newDirection);

        // Close current position at market
        this.connection.send({
            sell: position.contractId,
            price: 0
        });
    }

    /**
     * Close all open positions
     */
    async closeAllPositions() {
        LOGGER.info('🔒 Closing all positions...');

        for (const position of state.portfolio.activePositions) {
            if (position.contractId) {
                this.connection.send({
                    sell: position.contractId,
                    price: 0
                });
                LOGGER.info(`Closing: ${position.symbol} ${position.direction}`);
            }
        }
    }

    stop() {
        LOGGER.info('🛑 Stopping bot...');
        this.closeAllPositions();

        setTimeout(() => {
            if (this.connection.ws) {
                this.connection.ws.close();
            }
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
                isReversal: pos.isReversal,
                reversalLevel: pos.reversalLevel,
                duration: Math.floor((Date.now() - pos.entryTime) / 1000)
            })),
            assetStats: Object.entries(state.assets).map(([symbol, data]) => ({
                symbol,
                wpr: data.wpr.toFixed(1),
                direction: data.currentDirection || '-',
                breakoutActive: data.breakout.active,
                breakoutType: data.breakout.type || '-',
                breakoutHigh: data.breakout.highLevel.toFixed(5),
                breakoutLow: data.breakout.lowLevel.toFixed(5),
                reversalLevel: data.reversalLevel,
                accumulatedLoss: data.accumulatedLoss.toFixed(2),
                dailyTrades: data.dailyTrades,
                winRate: (data.winRate * 100).toFixed(1) + '%'
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

        console.log('\n' + '╔' + '═'.repeat(90) + '╗');
        console.log('║' + `     DERIV BREAKOUT BOT v5.1 - ${CONFIG.TIMEFRAME_LABEL.toUpperCase()} TIMEFRAME`.padEnd(90) + '║');
        console.log('╠' + '═'.repeat(90) + '╣');

        const netPLColor = session.netPL >= 0 ? '\x1b[32m' : '\x1b[31m';
        const resetColor = '\x1b[0m';

        console.log(`║ 💰 Capital: $${status.capital.toFixed(2).padEnd(12)} 🏦 Account: $${status.accountBalance.toFixed(2).padEnd(12)}                           ║`);
        console.log(`║ 📊 Session: ${session.duration.padEnd(10)} Trades: ${session.trades.toString().padEnd(5)} WR: ${session.winRate.padEnd(8)}                               ║`);
        console.log(`║ 💹 Net P/L: ${netPLColor}$${session.netPL.toFixed(2).padEnd(10)}${resetColor} Target: $${session.profitTarget.toFixed(2).padEnd(10)}                                      ║`);
        console.log(`║ ⏱️  Timeframe: ${CONFIG.TIMEFRAME_LABEL.padEnd(12)} Auto-Recovery: ${CONFIG.AUTO_CLOSE_ON_RECOVERY ? '✅ ON' : '❌ OFF'}`.padEnd(99) + '║');

        console.log('╠' + '═'.repeat(90) + '╣');

        // Active Positions
        if (status.activePositions.length > 0) {
            console.log('║ 🚀 ACTIVE POSITIONS:'.padEnd(91) + '║');
            console.log('║ Symbol     | Dir  | Stake   | Multi | Profit  | Rev Lvl | Duration'.padEnd(91) + '║');
            console.log('║' + '-'.repeat(90) + '║');

            status.activePositions.forEach(pos => {
                const profitColor = pos.profit >= 0 ? '\x1b[32m' : '\x1b[31m';
                const profitStr = pos.profit >= 0 ? `+${pos.profit.toFixed(2)}` : pos.profit.toFixed(2);
                console.log(`║ ${pos.symbol.padEnd(10)} | ${pos.direction.padEnd(4)} | $${pos.stake.toFixed(2).padEnd(6)} | x${pos.multiplier.toString().padEnd(3)} | ${profitColor}${profitStr.padEnd(7)}${resetColor} | ${pos.reversalLevel.toString().padEnd(7)} | ${pos.duration}s`.padEnd(99) + '║');
            });
            console.log('╠' + '═'.repeat(90) + '╣');
        }

        // Asset Stats with Breakout Levels
        console.log('║ 📊 ASSET BREAKOUT STATUS:'.padEnd(91) + '║');
        console.log('║ Symbol     | WPR    | Breakout   | High Level    | Low Level     | Rev | Loss    ║');
        console.log('║' + '-'.repeat(90) + '║');

        status.assetStats.forEach(stat => {
            const breakoutColor = stat.breakoutActive ? '\x1b[35m' : '\x1b[90m';
            const breakoutStr = stat.breakoutActive ? stat.breakoutType.substring(0, 10) : 'None';
            console.log(`║ ${stat.symbol.padEnd(10)} | ${stat.wpr.padEnd(6)} | ${breakoutColor}${breakoutStr.padEnd(10)}${resetColor} | ${stat.breakoutHigh.padEnd(13)} | ${stat.breakoutLow.padEnd(13)} | ${stat.reversalLevel.toString().padEnd(3)} | $${stat.accumulatedLoss.padEnd(6)}║`);
        });

        console.log('╚' + '═'.repeat(90) + '╝');
        console.log(`⏰ ${new Date().toLocaleTimeString()} | TF: ${CONFIG.TIMEFRAME} | Auto-Recovery: ${CONFIG.AUTO_CLOSE_ON_RECOVERY ? 'ON' : 'OFF'} | Ctrl+C to stop\n`);
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

const bot = new DerivBreakoutBot();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n⚠️  Shutdown signal received...');
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

// Validate API token
if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═'.repeat(90));
    console.log('         DERIV BREAKOUT BOT v5.1');
    console.log('         WPR Breakout Strategy with Auto-Recovery');
    console.log('═'.repeat(90));
    console.log('\n⚠️  API Token not configured!\n');
    console.log('Usage:');
    console.log('  API_TOKEN=your_token TIMEFRAME=5m node deriv-breakout-bot.js');
    console.log('\nEnvironment variables:');
    console.log('  CAPITAL        - Initial capital (default: 500)');
    console.log('  STAKE          - Initial stake (default: 1)');
    console.log('  PROFIT_TARGET  - Session profit target (default: 50)');
    console.log('  STOP_LOSS      - Session stop loss (default: -25)');
    console.log('  TIMEFRAME      - Candle timeframe (default: 1m)');
    console.log('  ASSETS         - Comma-separated assets');
    console.log('  DEBUG          - Enable debug mode (default: false)');
    console.log('\nAvailable Timeframes:');
    console.log('  1m, 2m, 3m, 4m, 5m, 10m, 15m, 30m, 1h, 4h');
    console.log('\nStrategy:');
    console.log('  - WPR crosses above -20 → Set breakout levels → BUY if price closes above high');
    console.log('  - WPR crosses below -80 → Set breakout levels → SELL if price closes below low');
    console.log('  - Breakout only expires when NEW breakout signal forms');
    console.log('  - On reversal: Close position, open opposite at 2x stake');
    console.log('  - Auto-recovery: Close when profit >= accumulated loss');
    console.log('═'.repeat(90));
    process.exit(1);
}

// Display timeframe info
console.log('═'.repeat(90));
console.log('         DERIV BREAKOUT BOT v5.1');
console.log(`         Timeframe: ${CONFIG.TIMEFRAME_LABEL}`);
console.log('═'.repeat(90));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

setTimeout(() => {
    Dashboard.startLiveUpdates();
}, 3000);

// Export
module.exports = {
    DerivBreakoutBot,
    TechnicalIndicators,
    BreakoutManager,
    StakeManager,
    SessionManager,
    RiskManager,
    CONFIG,
    ASSET_CONFIGS,
    ACTIVE_ASSETS,
    TIMEFRAMES,
    state
};
