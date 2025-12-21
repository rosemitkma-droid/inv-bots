#!/usr/bin/env node
/**
 * Deriv Multi-Asset Trading Bot v2.0
 * Advanced AI-powered portfolio trading with dynamic asset selection
 * 
 * CHANGELOG v2.0:
 * - Fixed ADX calculation (now returns proper smoothed ADX)
 * - Fixed division by zero in win rate calculation
 * - Improved RSI confirmation (scoring instead of hard filter)
 * - Fixed synthetic correlation pairs
 * - Added progressive stake reduction after losses
 * - Added capital drift detection
 * - Rate-limited loss email alerts
 * - Optimized memory usage (reduced tick storage)
 * - Event-driven dashboard updates
 * 
 * Dependencies: npm install ws mathjs nodemailer
 * Usage: API_TOKEN=your_token node deriv-multi-asset-bot.js
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
    warn: (msg) => console.warn(`\x1b[33m[WARN] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`),
    dashboard: (msg) => console.log(msg)
};

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
    // Use environment variables for sensitive data
    API_TOKEN: process.env.API_key || '0P94g4WdSrSrzir',
    APP_ID: process.env.APP_ID || '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Portfolio Settings
    INITIAL_CAPITAL: parseFloat(process.env.CAPITAL) || 500,
    MAX_RISK_PER_TRADE: 0.025,           // 2.5% per trade
    DAILY_LOSS_LIMIT: 0.05,              // 5% daily loss limit
    DAILY_PROFIT_TARGET: 0.025,          // 2.5% daily profit target
    PROFIT_LOCK_RATIO: 0.5,              // Lock 50% of gains
    MAX_OPEN_POSITIONS: 5,
    TOP_ASSETS_TO_TRADE: 2,

    // Timing
    ASSET_SCORING_INTERVAL: 1 * 60 * 1000,    // 1 minute
    REBALANCE_INTERVAL: 4 * 60 * 60 * 1000,   // 4 hours
    COOLDOWN_PERIOD: 4 * 60 * 60 * 1000,      // 4 hours after 3 losses
    BLACKLIST_PERIOD: 24 * 60 * 60 * 1000,    // 24 hours (reduced from 48)
    CAPITAL_SYNC_INTERVAL: 60 * 60 * 1000,    // 1 hour for capital drift check

    // AI Settings
    MIN_CONFIDENCE_SCORE: 0.6,
    MIN_WIN_RATE_THRESHOLD: 0.5,
    WIN_RATE_LOOKBACK: 20,

    // Performance Settings
    MAX_TICKS_STORED: 100,               // Reduced from 500
    MAX_CANDLES_STORED: 150,             // Reduced from 200
    DASHBOARD_UPDATE_INTERVAL: 10000,    // 10 seconds

    // Email Rate Limiting
    MIN_EMAIL_INTERVAL: 30 * 60 * 1000,  // 30 minutes between loss emails per asset

    // Email Settings (use environment variables in production)
    EMAIL_CONFIG: {
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER || 'kenzkdp2@gmail.com',
            pass: process.env.EMAIL_PASS || 'jfjhtmussgfpbgpk'
        }
    },
    EMAIL_RECIPIENT: process.env.EMAIL_RECIPIENT || 'kenotaru@gmail.com'
};

// ============================================
// ASSET UNIVERSE CONFIGURATION
// ============================================

const ASSET_CONFIGS = {
    // Synthetic Indices
    'R_10': {
        name: 'Volatility 10 Index',
        category: 'synthetic',
        emaShort: 8,
        emaLong: 21,
        rsiPeriod: 14,
        rsiOversold: 30,
        rsiOverbought: 70,
        adxPeriod: 14,
        adxThreshold: 20,              // Lowered from 25 for more signals
        atrPeriod: 14,
        duration: 15,
        durationUnit: 'm',
        maxTradesPerDay: 5,
        volatilityClass: 'low',
        tickSubscription: 'R_10',
        defaultPayout: 0.85            // Store expected payout ratio
    },
    'R_25': {
        name: 'Volatility 25 Index',
        category: 'synthetic',
        emaShort: 10,
        emaLong: 24,
        rsiPeriod: 14,
        rsiOversold: 30,
        rsiOverbought: 70,
        adxPeriod: 14,
        adxThreshold: 20,
        atrPeriod: 14,
        duration: 20,
        durationUnit: 'm',
        maxTradesPerDay: 5,
        volatilityClass: 'medium-low',
        tickSubscription: 'R_25',
        defaultPayout: 0.85
    },
    'R_75': {
        name: 'Volatility 75 Index',
        category: 'synthetic',
        emaShort: 12,
        emaLong: 30,
        rsiPeriod: 21,
        rsiOversold: 35,
        rsiOverbought: 65,
        adxPeriod: 14,
        adxThreshold: 22,
        atrPeriod: 14,
        duration: 30,
        durationUnit: 'm',
        maxTradesPerDay: 5,
        volatilityClass: 'high',
        tickSubscription: 'R_75',
        defaultPayout: 0.82
    },
    'R_100': {
        name: 'Volatility 100 Index',
        category: 'synthetic',
        emaShort: 12,
        emaLong: 30,
        rsiPeriod: 21,
        rsiOversold: 35,
        rsiOverbought: 65,
        adxPeriod: 14,
        adxThreshold: 22,
        atrPeriod: 14,
        duration: 30,
        durationUnit: 'm',
        maxTradesPerDay: 5,
        volatilityClass: 'high',
        tickSubscription: 'R_100',
        defaultPayout: 0.80
    },
    'BOOM1000': {
        name: 'Boom 1000 Index',
        category: 'synthetic',
        emaShort: 5,
        emaLong: 15,
        rsiPeriod: 7,
        rsiOversold: 25,
        rsiOverbought: 75,
        adxPeriod: 14,
        adxThreshold: 18,
        atrPeriod: 14,
        duration: 5,
        durationUnit: 'm',
        maxTradesPerDay: 5,
        volatilityClass: 'extreme',
        tickSubscription: 'BOOM1000',
        defaultPayout: 0.75
    },
    'CRASH1000': {
        name: 'Crash 1000 Index',
        category: 'synthetic',
        emaShort: 5,
        emaLong: 15,
        rsiPeriod: 7,
        rsiOversold: 25,
        rsiOverbought: 75,
        adxPeriod: 14,
        adxThreshold: 18,
        atrPeriod: 14,
        duration: 5,
        durationUnit: 'm',
        maxTradesPerDay: 5,
        volatilityClass: 'extreme',
        tickSubscription: 'CRASH1000',
        defaultPayout: 0.75
    },
    // Cryptocurrencies
    // 'cryBTCUSD': {
    //     name: 'Bitcoin',
    //     category: 'crypto',
    //     emaShort: 10,
    //     emaLong: 25,
    //     rsiPeriod: 14,
    //     rsiOversold: 30,
    //     rsiOverbought: 70,
    //     adxPeriod: 14,
    //     adxThreshold: 20,
    //     atrPeriod: 14,
    //     duration: 1,
    //     durationUnit: 'h',
    //     maxTradesPerDay: 10,
    //     volatilityClass: 'high',
    //     tickSubscription: 'cryBTCUSD',
    //     defaultPayout: 0.80,
    //     multiplier: 100
    // },
    // 'cryETHUSD': {
    //     name: 'Ethereum',
    //     category: 'crypto',
    //     emaShort: 10,
    //     emaLong: 25,
    //     rsiPeriod: 14,
    //     rsiOversold: 30,
    //     rsiOverbought: 70,
    //     adxPeriod: 14,
    //     adxThreshold: 20,
    //     atrPeriod: 14,
    //     duration: 1,
    //     durationUnit: 'h',
    //     maxTradesPerDay: 10,
    //     volatilityClass: 'high',
    //     tickSubscription: 'cryETHUSD',
    //     defaultPayout: 0.80,
    //     multiplier: 100
    // }
    // Major Forex
    // 'frxEURUSD': {
    //     name: 'EUR/USD',
    //     category: 'forex',
    //     emaShort: 10,
    //     emaLong: 25,
    //     rsiPeriod: 14,
    //     rsiThreshold: 30,
    //     duration: 4,
    //     durationUnit: 'h',
    //     maxTradesPerDay: 1,
    //     volatilityClass: 'medium',
    //     tickSubscription: 'frxEURUSD',
    //     correlatedWith: ['frxGBPUSD']
    // },
    // 'frxGBPUSD': {
    //     name: 'GBP/USD',
    //     category: 'forex',
    //     emaShort: 10,
    //     emaLong: 25,
    //     rsiPeriod: 14,
    //     rsiThreshold: 30,
    //     duration: 4,
    //     durationUnit: 'h',
    //     maxTradesPerDay: 1,
    //     volatilityClass: 'medium',
    //     tickSubscription: 'frxGBPUSD',
    //     correlatedWith: ['frxEURUSD']
    // },
    // 'frxUSDJPY': {
    //     name: 'USD/JPY',
    //     category: 'forex',
    //     emaShort: 10,
    //     emaLong: 25,
    //     rsiPeriod: 14,
    //     rsiThreshold: 30,
    //     duration: 4,
    //     durationUnit: 'h',
    //     maxTradesPerDay: 1,
    //     volatilityClass: 'medium',
    //     tickSubscription: 'frxUSDJPY'
    // },
    // Commodities
    // 'WLDOIL': {
    //     name: 'Oil/USD',
    //     category: 'commodity',
    //     emaShort: 15,
    //     emaLong: 35,
    //     rsiPeriod: 14,
    //     rsiThreshold: 30,
    //     duration: 1,
    //     durationUnit: 'h',
    //     maxTradesPerDay: 2,
    //     volatilityClass: 'high',
    //     tickSubscription: 'WLDOIL'
    // },
    // 'frxXAUUSD': {
    //     name: 'Gold/USD',
    //     category: 'commodity',
    //     emaShort: 15,
    //     emaLong: 35,
    //     rsiPeriod: 14,
    //     rsiThreshold: 30,
    //     duration: 1,
    //     durationUnit: 'h',
    //     maxTradesPerDay: 2,
    //     volatilityClass: 'high',
    //     tickSubscription: 'frxXAUUSD'
    // }
};

// ============================================
// SYNTHETIC CORRELATION PAIRS (Fixed)
// ============================================

const SYNTHETIC_CORRELATION_PAIRS = [
    ['R_75', 'R_100'],   // High volatility pair - strong correlation
    ['R_10', 'R_25'],    // Low volatility pair - moderate correlation
];

// ============================================
// STATE MANAGEMENT
// ============================================

const state = {
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    lockedProfit: 0,
    isConnected: false,
    isAuthorized: false,
    lastDashboardHash: '',             // For event-driven updates

    assets: {},

    portfolio: {
        dailyLoss: 0,
        dailyProfit: 0,
        dailyWins: 0,
        dailyLosses: 0,
        activePositions: [],
        topRankedAssets: [],
        lastRebalance: Date.now(),
        lastScoring: Date.now(),
        lastCapitalSync: Date.now()
    },

    subscriptions: new Map(),
    pendingRequests: new Map(),
    requestId: 1,

    // Email rate limiting
    lastLossEmailTime: {}
};

// Initialize asset states
Object.keys(ASSET_CONFIGS).forEach(symbol => {
    state.assets[symbol] = {
        candles: [],
        ticks: [],
        emaShort: 0,
        emaLong: 0,
        prevEmaShort: null,
        prevEmaLong: null,
        rsi: 50,
        prevRsi: 50,
        adx: 25,
        atr: 0,
        plusDI: 0,
        minusDI: 0,
        dailyTrades: 0,
        dailyWins: 0,
        dailyLosses: 0,
        dailyTradesPerDirection: { CALL: 0, PUT: 0 },
        consecutiveLosses: 0,
        cooldownUntil: 0,
        blacklistedUntil: 0,
        tradeHistory: [],
        winRate: 0.5,
        score: 0,
        lastSignal: null,
        predictability: 0.5,
        spreadCost: 0,
        lastPayoutRatio: ASSET_CONFIGS[symbol].defaultPayout
    };
});

// ============================================
// TECHNICAL INDICATORS (Fixed & Improved)
// ============================================

class TechnicalIndicators {
    /**
     * Calculate Exponential Moving Average
     */
    static calculateEMA(prices, period) {
        if (!prices || prices.length < period) return null;

        const multiplier = 2 / (period + 1);
        let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

        for (let i = period; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }

        return ema;
    }

    /**
     * Calculate RSI with Wilder's smoothing
     */
    static calculateRSI(prices, period = 14) {
        if (!prices || prices.length < period + 1) return 50;

        const changes = [];
        for (let i = 1; i < prices.length; i++) {
            changes.push(prices[i] - prices[i - 1]);
        }

        if (changes.length < period) return 50;

        // Initial averages
        let avgGain = 0;
        let avgLoss = 0;

        for (let i = 0; i < period; i++) {
            if (changes[i] > 0) avgGain += changes[i];
            else avgLoss += Math.abs(changes[i]);
        }

        avgGain /= period;
        avgLoss /= period;

        // Wilder's smoothing for remaining values
        for (let i = period; i < changes.length; i++) {
            const change = changes[i];
            if (change > 0) {
                avgGain = (avgGain * (period - 1) + change) / period;
                avgLoss = (avgLoss * (period - 1)) / period;
            } else {
                avgGain = (avgGain * (period - 1)) / period;
                avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
            }
        }

        if (avgLoss === 0) return 100;

        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    /**
     * Calculate ADX (Average Directional Index) - FIXED VERSION
     * Now returns proper smoothed ADX, not just DX
     */
    static calculateADX(highs, lows, closes, period = 14) {
        if (!closes || closes.length < period * 3) {
            return { adx: 25, plusDI: 0, minusDI: 0 };
        }

        const trueRanges = [];
        const plusDM = [];
        const minusDM = [];

        // Calculate TR, +DM, -DM
        for (let i = 1; i < closes.length; i++) {
            const high = highs[i];
            const low = lows[i];
            const prevHigh = highs[i - 1];
            const prevLow = lows[i - 1];
            const prevClose = closes[i - 1];

            // True Range
            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );
            trueRanges.push(tr);

            // Directional Movement
            const upMove = high - prevHigh;
            const downMove = prevLow - low;

            plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
        }

        if (trueRanges.length < period * 2) {
            return { adx: 25, plusDI: 0, minusDI: 0 };
        }

        // Calculate initial smoothed values using Wilder's method
        let smoothedTR = trueRanges.slice(0, period).reduce((a, b) => a + b, 0);
        let smoothedPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
        let smoothedMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

        const dxValues = [];

        // Calculate DX values with Wilder's smoothing
        for (let i = period; i < trueRanges.length; i++) {
            // Wilder's smoothing: smoothed = previous - (previous/period) + current
            smoothedTR = smoothedTR - (smoothedTR / period) + trueRanges[i];
            smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / period) + plusDM[i];
            smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / period) + minusDM[i];

            if (smoothedTR === 0) continue;

            const plusDI = (smoothedPlusDM / smoothedTR) * 100;
            const minusDI = (smoothedMinusDM / smoothedTR) * 100;
            const diSum = plusDI + minusDI;

            if (diSum !== 0) {
                const dx = (Math.abs(plusDI - minusDI) / diSum) * 100;
                dxValues.push({ dx, plusDI, minusDI });
            }
        }

        if (dxValues.length < period) {
            return { adx: 25, plusDI: 0, minusDI: 0 };
        }

        // Calculate ADX as smoothed average of DX values
        let adx = dxValues.slice(0, period).reduce((sum, v) => sum + v.dx, 0) / period;

        // Continue Wilder's smoothing for ADX
        for (let i = period; i < dxValues.length; i++) {
            adx = ((adx * (period - 1)) + dxValues[i].dx) / period;
        }

        const lastDX = dxValues[dxValues.length - 1];

        return {
            adx: adx,
            plusDI: lastDX.plusDI,
            minusDI: lastDX.minusDI
        };
    }

    /**
     * Calculate ATR (Average True Range)
     */
    static calculateATR(highs, lows, closes, period = 14) {
        if (!closes || closes.length < period + 1) return 0;

        const trueRanges = [];

        for (let i = 1; i < closes.length; i++) {
            const tr = Math.max(
                highs[i] - lows[i],
                Math.abs(highs[i] - closes[i - 1]),
                Math.abs(lows[i] - closes[i - 1])
            );
            trueRanges.push(tr);
        }

        if (trueRanges.length < period) return 0;

        // Wilder's smoothing
        let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

        for (let i = period; i < trueRanges.length; i++) {
            atr = ((atr * (period - 1)) + trueRanges[i]) / period;
        }

        return atr;
    }

    /**
     * Detect EMA crossover
     */
    static detectCrossover(prevEmaShort, prevEmaLong, currEmaShort, currEmaLong) {
        if (prevEmaShort === null || prevEmaLong === null ||
            currEmaShort === null || currEmaLong === null) {
            return 'none';
        }

        const wasBelowOrEqual = prevEmaShort <= prevEmaLong;
        const isAbove = currEmaShort > currEmaLong;

        const wasAboveOrEqual = prevEmaShort >= prevEmaLong;
        const isBelow = currEmaShort < currEmaLong;

        if (wasBelowOrEqual && isAbove) return 'bullish';
        if (wasAboveOrEqual && isBelow) return 'bearish';

        return 'none';
    }

    /**
     * Calculate RSI Score (instead of hard filter)
     * Returns 0-1 score based on RSI position relative to direction
     */
    static calculateRSIScore(rsi, prevRsi, direction, config) {
        let score = 0;

        if (direction === 'CALL') {
            // For CALL, lower RSI is better (oversold)
            if (rsi < config.rsiOversold) {
                score = 1.0;  // Strong - oversold
            } else if (rsi < 40) {
                score = 0.8;  // Good - below neutral
            } else if (rsi < 50) {
                score = 0.6;  // Moderate - slightly below neutral
            } else if (rsi < 60) {
                score = 0.4;  // Weak - slightly above neutral
            } else {
                score = 0.2;  // Very weak - overbought territory
            }

            // Bonus for RSI momentum (RSI turning up)
            if (prevRsi !== null && rsi > prevRsi) {
                score += 0.1;
            }
        } else {
            // For PUT, higher RSI is better (overbought)
            if (rsi > config.rsiOverbought) {
                score = 1.0;  // Strong - overbought
            } else if (rsi > 60) {
                score = 0.8;  // Good - above neutral
            } else if (rsi > 50) {
                score = 0.6;  // Moderate - slightly above neutral
            } else if (rsi > 40) {
                score = 0.4;  // Weak - slightly below neutral
            } else {
                score = 0.2;  // Very weak - oversold territory
            }

            // Bonus for RSI momentum (RSI turning down)
            if (prevRsi !== null && rsi < prevRsi) {
                score += 0.1;
            }
        }

        return Math.min(score, 1);
    }

    /**
     * Calculate ADX Score for trend strength
     */
    static calculateADXScore(adx, plusDI, minusDI, direction) {
        let score = 0;

        // Base score from ADX strength
        if (adx >= 40) {
            score = 1.0;  // Very strong trend
        } else if (adx >= 30) {
            score = 0.8;  // Strong trend
        } else if (adx >= 25) {
            score = 0.6;  // Moderate trend
        } else if (adx >= 20) {
            score = 0.4;  // Weak trend
        } else {
            score = 0.2;  // No clear trend
        }

        // Bonus for DI alignment with direction
        if (direction === 'CALL' && plusDI > minusDI) {
            score += 0.15;
        } else if (direction === 'PUT' && minusDI > plusDI) {
            score += 0.15;
        }

        return Math.min(score, 1);
    }
}

// ============================================
// AI PORTFOLIO MANAGER
// ============================================

class PortfolioManager {
    /**
     * Calculate asset score for ranking
     */
    static calculateAssetScore(symbol) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];

        // Recent win rate (30% weight) - FIXED division by zero
        const recentTrades = assetState.tradeHistory.slice(-CONFIG.WIN_RATE_LOOKBACK);
        const winRate = recentTrades.length > 0
            ? recentTrades.filter(t => t.profit > 0).length / recentTrades.length
            : 0.5;

        // Trend strength (25% weight) - based on proper ADX
        const trendStrength = Math.min(assetState.adx / 50, 1);

        // Volatility fit (20% weight)
        const volatilityFit = this.calculateVolatilityFit(symbol);

        // Predictability (25% weight)
        const predictability = this.calculatePredictability(symbol);

        const score = (winRate * 0.3) +
            (trendStrength * 0.25) +
            (volatilityFit * 0.2) +
            (predictability * 0.25);

        return Math.min(Math.max(score, 0), 1);
    }

    /**
     * Calculate how well current volatility matches the asset's expected volatility
     */
    static calculateVolatilityFit(symbol) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];

        if (assetState.ticks.length < 20) return 0.5;

        // Calculate recent volatility
        const recentTicks = assetState.ticks.slice(-20);
        const returns = [];
        for (let i = 1; i < recentTicks.length; i++) {
            if (recentTicks[i - 1] !== 0) {
                returns.push((recentTicks[i] - recentTicks[i - 1]) / recentTicks[i - 1]);
            }
        }

        if (returns.length === 0) return 0.5;

        const volatility = math.std(returns) * 100;

        // Expected volatility ranges by class
        const expectedRanges = {
            'low': { min: 0, max: 0.5 },
            'medium-low': { min: 0.3, max: 0.8 },
            'medium': { min: 0.5, max: 1.2 },
            'high': { min: 1, max: 2.5 },
            'extreme': { min: 2, max: 5 }
        };

        const range = expectedRanges[config.volatilityClass] || expectedRanges['medium'];

        if (volatility >= range.min && volatility <= range.max) {
            return 1;
        } else if (volatility < range.min) {
            return Math.max(0.3, 1 - (range.min - volatility) / (range.min || 0.1));
        } else {
            return Math.max(0.3, 1 - (volatility - range.max) / (range.max || 1));
        }
    }

    /**
     * Calculate predictability based on signal consistency
     */
    static calculatePredictability(symbol) {
        const assetState = state.assets[symbol];

        if (assetState.tradeHistory.length < 5) return 0.5;

        // Check for consistent directional accuracy
        const recentTrades = assetState.tradeHistory.slice(-10);
        const directions = { CALL: { wins: 0, total: 0 }, PUT: { wins: 0, total: 0 } };

        recentTrades.forEach(trade => {
            if (directions[trade.direction]) {
                directions[trade.direction].total++;
                if (trade.profit > 0) {
                    directions[trade.direction].wins++;
                }
            }
        });

        // Calculate directional accuracy
        let totalAccuracy = 0;
        let count = 0;

        ['CALL', 'PUT'].forEach(dir => {
            if (directions[dir].total >= 2) {
                totalAccuracy += directions[dir].wins / directions[dir].total;
                count++;
            }
        });

        return count > 0 ? totalAccuracy / count : 0.5;
    }

    /**
     * Rank all assets and select top performers
     */
    static rankAssets() {
        const rankings = [];

        Object.keys(ASSET_CONFIGS).forEach(symbol => {
            const assetState = state.assets[symbol];

            // Skip blacklisted or cooling down assets
            if (Date.now() < assetState.blacklistedUntil) {
                LOGGER.info(`⏸️  ${symbol} is blacklisted until ${new Date(assetState.blacklistedUntil).toLocaleTimeString()}`);
                return;
            }
            if (Date.now() < assetState.cooldownUntil) {
                LOGGER.info(`⏸️  ${symbol} is cooling down until ${new Date(assetState.cooldownUntil).toLocaleTimeString()}`);
                return;
            }

            const score = this.calculateAssetScore(symbol);
            assetState.score = score;

            rankings.push({ symbol, score });
        });

        // Sort by score descending
        rankings.sort((a, b) => b.score - a.score);

        // Select top assets
        const topAssets = rankings.slice(0, CONFIG.TOP_ASSETS_TO_TRADE);
        state.portfolio.topRankedAssets = topAssets.map(a => a.symbol);

        console.log('\n📊 Asset Rankings:');
        rankings.forEach((asset, index) => {
            const marker = index < CONFIG.TOP_ASSETS_TO_TRADE ? '🏆' : '  ';
            console.log(`${marker} ${index + 1}. ${asset.symbol}: ${(asset.score * 100).toFixed(1)}%`);
        });

        return topAssets;
    }

    /**
     * Calculate stake using Kelly Criterion with portfolio allocation
     * IMPROVED: Uses actual payout ratios and progressive reduction
     */
    static calculateStake(symbol, rank) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];
        const availableCapital = state.capital - state.lockedProfit;

        // Total risk per cycle
        const totalRisk = availableCapital * CONFIG.MAX_RISK_PER_TRADE;

        // Split based on ranking (60/40 for top 2)
        const allocationRatio = rank === 0 ? 0.6 : 0.4;

        // Kelly Criterion with actual payout ratio
        const payoutRatio = assetState.lastPayoutRatio || config.defaultPayout;
        const winProb = assetState.winRate;
        const lossProb = 1 - winProb;

        // Kelly formula for binary bets: f = (bp - q) / b
        // Where b = payout ratio, p = win probability, q = loss probability
        let kellyFraction = (payoutRatio * winProb - lossProb) / payoutRatio;
        kellyFraction = Math.max(0, Math.min(kellyFraction, 0.15)); // Cap at 15%

        // Progressive stake reduction after consecutive losses
        let lossMultiplier = 1;
        if (assetState.consecutiveLosses >= 1) lossMultiplier = 0.75;
        if (assetState.consecutiveLosses >= 2) lossMultiplier = 0.5;

        // Apply all factors
        let stake = totalRisk * allocationRatio * (1 + kellyFraction) * lossMultiplier;

        // Ensure minimum stake
        stake = Math.max(stake, 1);

        // Cap at 5% of capital for safety
        stake = Math.min(stake, availableCapital * 0.05);

        return parseFloat(stake.toFixed(2));
    }

    /**
     * Check correlation conflicts
     */
    static hasCorrelationConflict(symbol) {
        const config = ASSET_CONFIGS[symbol];
        if (!config.correlatedWith) return false;

        // Check if any correlated asset has an active position
        return state.portfolio.activePositions.some(pos =>
            config.correlatedWith.includes(pos.symbol)
        );
    }

    /**
     * Check synthetic index correlation - FIXED
     */
    static checkSyntheticCorrelation(symbol) {
        for (const pair of SYNTHETIC_CORRELATION_PAIRS) {
            if (pair.includes(symbol)) {
                const other = pair.find(s => s !== symbol);

                // Check if other asset exists and has a recent signal
                if (state.assets[other]?.lastSignal) {
                    const otherSignalAge = Date.now() - state.assets[other].lastSignal.timestamp;

                    // Only consider if signal is recent (within 5 minutes)
                    if (otherSignalAge < 5 * 60 * 1000) {
                        // Compare scores, return true if this symbol has lower score
                        return state.assets[symbol].score < state.assets[other].score;
                    }
                }
            }
        }
        return false;
    }

    /**
     * Check and log capital drift
     */
    static checkCapitalDrift() {
        const drift = Math.abs(state.capital - state.accountBalance);

        if (drift > 1) {
            LOGGER.warn(`Capital drift detected: Bot capital $${state.capital.toFixed(2)} vs Account $${state.accountBalance.toFixed(2)} (diff: $${drift.toFixed(2)})`);

            // Optional: Auto-sync if drift is significant (>5%)
            const driftPercent = drift / state.accountBalance * 100;
            if (driftPercent > 5 && state.accountBalance > 0) {
                LOGGER.warn(`Drift >5%, consider manual sync. Use: state.capital = state.accountBalance`);
            }
        }

        state.portfolio.lastCapitalSync = Date.now();
    }
}

// ============================================
// AI CONFIDENCE MODEL (Improved)
// ============================================

class AIConfidenceModel {
    /**
     * Calculate trade confidence score - IMPROVED
     * Now uses scoring instead of hard filters
     */
    static calculateConfidence(symbol, direction) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];

        let confidence = 0;
        const weights = {
            rsi: 0.25,
            adx: 0.25,
            recentPerformance: 0.20,
            volatilityFit: 0.15,
            timeOfDay: 0.15
        };

        // 1. RSI Score (25% weight) - Now uses scoring instead of filter
        const rsiScore = TechnicalIndicators.calculateRSIScore(
            assetState.rsi,
            assetState.prevRsi,
            direction,
            config
        );
        confidence += rsiScore * weights.rsi;

        // 2. ADX/Trend strength score (25% weight)
        const adxScore = TechnicalIndicators.calculateADXScore(
            assetState.adx,
            assetState.plusDI,
            assetState.minusDI,
            direction
        );
        confidence += adxScore * weights.adx;

        // 3. Recent performance (20% weight)
        const recentTrades = assetState.tradeHistory.slice(-5);
        const recentWins = recentTrades.filter(t => t.profit > 0).length;
        const recentScore = recentTrades.length > 0 ? recentWins / recentTrades.length : 0.5;
        confidence += recentScore * weights.recentPerformance;

        // 4. Volatility regime match (15% weight)
        const volFit = PortfolioManager.calculateVolatilityFit(symbol);
        confidence += volFit * weights.volatilityFit;

        // 5. Time-of-day factor (15% weight)
        const hour = new Date().getUTCHours();
        let timeScore = 0.5;

        if (config.category === 'forex') {
            // Forex best during London/NY sessions
            if ((hour >= 7 && hour <= 16) || (hour >= 13 && hour <= 21)) {
                timeScore = 0.9;
            } else {
                timeScore = 0.4;
            }
        } else if (config.category === 'synthetic') {
            // Synthetics trade 24/7 with consistent patterns
            timeScore = 0.7;
        } else if (config.category === 'crypto') {
            // Crypto is 24/7 but more volatile during US hours
            if (hour >= 13 && hour <= 22) {
                timeScore = 0.8;
            } else {
                timeScore = 0.6;
            }
        }
        confidence += timeScore * weights.timeOfDay;

        return Math.min(confidence, 1);
    }
}

// ============================================
// RISK MANAGER (Improved)
// ============================================

class RiskManager {
    /**
     * Check if trading is allowed based on portfolio limits
     */
    static canTrade() {
        const { dailyLoss, dailyProfit, activePositions } = state.portfolio;
        const availableCapital = state.capital - state.lockedProfit;

        // Check daily loss limit
        if (dailyLoss >= availableCapital * CONFIG.DAILY_LOSS_LIMIT) {
            LOGGER.warn('🛑 Daily loss limit reached. Trading paused.');
            return false;
        }

        // Check max positions
        if (activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) {
            LOGGER.warn('🛑 Maximum open positions reached.');
            return false;
        }

        // Check profit target (lock 50% of gains)
        if (dailyProfit >= availableCapital * CONFIG.DAILY_PROFIT_TARGET) {
            const profitToLock = dailyProfit * CONFIG.PROFIT_LOCK_RATIO;
            if (state.lockedProfit < profitToLock) {
                state.lockedProfit = profitToLock;
                LOGGER.info(`🔒 Locked ${profitToLock.toFixed(2)} in profits`);
            }
        }

        return true;
    }

    /**
     * Check if specific asset can trade
     */
    static canAssetTrade(symbol, direction) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];

        // Check if asset is in top ranked
        if (!state.portfolio.topRankedAssets.includes(symbol)) {
            return { allowed: false, reason: 'Asset not in top ranked' };
        }

        // Check daily trade limit
        if (assetState.dailyTrades >= config.maxTradesPerDay) {
            return { allowed: false, reason: 'Daily trade limit reached' };
        }

        // Check direction limit
        if (assetState.dailyTradesPerDirection[direction] >= 3) {
            return { allowed: false, reason: `Max ${direction} trades reached` };
        }

        // Check cooldown
        if (Date.now() < assetState.cooldownUntil) {
            return { allowed: false, reason: 'Asset in cooldown' };
        }

        // Check blacklist
        if (Date.now() < assetState.blacklistedUntil) {
            return { allowed: false, reason: 'Asset blacklisted' };
        }

        // Check correlation conflict
        if (PortfolioManager.hasCorrelationConflict(symbol)) {
            return { allowed: false, reason: 'Correlation conflict' };
        }

        return { allowed: true };
    }

    /**
     * Record trade result and update risk metrics - FIXED division by zero
     */
    static recordTradeResult(symbol, profit, direction) {
        const assetState = state.assets[symbol];

        // Update daily stats
        if (profit > 0) {
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            assetState.dailyWins++;
            assetState.consecutiveLosses = 0;
        } else {
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            assetState.dailyLosses++;
            assetState.consecutiveLosses++;

            // Apply cooldown after 3 consecutive losses
            if (assetState.consecutiveLosses >= 3) {
                assetState.cooldownUntil = Date.now() + CONFIG.COOLDOWN_PERIOD;
                LOGGER.warn(`⏸️  ${symbol} entering cooldown after 3 consecutive losses`);
            }

            // Send rate-limited loss alert email
            bot.emailManager.sendLossAlert(symbol, assetState.consecutiveLosses);
        }

        // Update trade history
        assetState.tradeHistory.push({
            timestamp: Date.now(),
            direction,
            profit
        });

        // Limit trade history size
        if (assetState.tradeHistory.length > 100) {
            assetState.tradeHistory = assetState.tradeHistory.slice(-100);
        }

        // Update win rate - FIXED: Added check for empty array
        const recentTrades = assetState.tradeHistory.slice(-CONFIG.WIN_RATE_LOOKBACK);
        assetState.winRate = recentTrades.length > 0
            ? recentTrades.filter(t => t.profit > 0).length / recentTrades.length
            : 0.5;

        // Check for blacklist condition
        if (recentTrades.length >= CONFIG.WIN_RATE_LOOKBACK &&
            assetState.winRate < CONFIG.MIN_WIN_RATE_THRESHOLD) {
            assetState.blacklistedUntil = Date.now() + CONFIG.BLACKLIST_PERIOD;
            LOGGER.warn(`🚫 ${symbol} blacklisted for 24h due to low win rate (${(assetState.winRate * 100).toFixed(1)}%)`);
        }

        // Update capital
        state.capital += profit;
    }

    /**
     * Reset daily counters
     */
    static resetDailyCounters() {
        state.portfolio.dailyLoss = 0;
        state.portfolio.dailyProfit = 0;
        state.portfolio.dailyWins = 0;
        state.portfolio.dailyLosses = 0;
        state.lockedProfit = 0;

        Object.keys(state.assets).forEach(symbol => {
            state.assets[symbol].dailyTrades = 0;
            state.assets[symbol].dailyWins = 0;
            state.assets[symbol].dailyLosses = 0;
            state.assets[symbol].dailyTradesPerDirection = { CALL: 0, PUT: 0 };
        });

        LOGGER.info('📅 Daily counters reset');
    }
}

// ============================================
// EMAIL MANAGER (Rate Limited)
// ============================================

class EmailManager {
    constructor() {
        this.transporter = nodemailer.createTransport(CONFIG.EMAIL_CONFIG);
    }

    async sendEmail(subject, text) {
        const mailOptions = {
            from: CONFIG.EMAIL_CONFIG.auth.user,
            to: CONFIG.EMAIL_RECIPIENT,
            subject: `ClaudeINV Deriv Multi-Asset Bot - ${subject}`,
            text: text
        };

        try {
            await this.transporter.sendMail(mailOptions);
            LOGGER.info(`📧 Email sent: ${subject}`);
        } catch (error) {
            LOGGER.error(`Email error: ${error.message}`);
        }
    }

    async sendSummary(isFinal = false) {
        const totalTrades = state.portfolio.dailyWins + state.portfolio.dailyLosses;
        const winRate = totalTrades > 0
            ? ((state.portfolio.dailyWins / totalTrades) * 100).toFixed(2)
            : 0;

        const assetBreakdown = Object.entries(state.assets)
            .filter(([_, data]) => data.dailyTrades > 0)
            .map(([symbol, data]) => {
                const assetProfit = data.tradeHistory
                    .filter(t => {
                        const today = new Date();
                        const tradeDate = new Date(t.timestamp);
                        return tradeDate.toDateString() === today.toDateString();
                    })
                    .reduce((sum, t) => sum + t.profit, 0);
                return `${symbol}: W:${data.dailyWins} L:${data.dailyLosses} WR:${(data.winRate * 100).toFixed(1)}% P/L:$${assetProfit.toFixed(2)}`;
            }).join('\n');

        const netPL = state.portfolio.dailyProfit - state.portfolio.dailyLoss;

        const summaryText = `
${isFinal ? '🏁 FINAL DAILY REPORT' : '📊 PERIODIC SUMMARY'}
========================================
Time: ${new Date().toLocaleString()}

Portfolio Performance:
---------------------
Total Trades: ${totalTrades}
Wins: ${state.portfolio.dailyWins} | Losses: ${state.portfolio.dailyLosses}
Win Rate: ${winRate}%

Financial Status:
----------------
Bot Capital: $${state.capital.toFixed(2)}
Account Balance: $${state.accountBalance.toFixed(2)}
Daily Profit: +$${state.portfolio.dailyProfit.toFixed(2)}
Daily Loss: -$${state.portfolio.dailyLoss.toFixed(2)}
Net P/L: ${netPL >= 0 ? '+' : ''}$${netPL.toFixed(2)}
Locked Profit: $${state.lockedProfit.toFixed(2)}

Active Positions: ${state.portfolio.activePositions.length}/${CONFIG.MAX_OPEN_POSITIONS}
Top Ranked: ${state.portfolio.topRankedAssets.join(', ')}

Per-Asset Breakdown:
-------------------
${assetBreakdown || 'No trades yet today.'}
        `;

        await this.sendEmail(isFinal ? 'Final Daily Report' : 'Summary Update', summaryText);
    }

    /**
     * Send loss alert with rate limiting
     */
    async sendLossAlert(symbol, consecutiveLosses) {
        const now = Date.now();
        const lastSent = state.lastLossEmailTime[symbol] || 0;

        // Only send if 30+ min since last alert for this asset, OR if entering cooldown
        if (now - lastSent < CONFIG.MIN_EMAIL_INTERVAL && consecutiveLosses < 3) {
            return; // Skip - too soon
        }

        state.lastLossEmailTime[symbol] = now;

        const asset = state.assets[symbol];
        const text = `
⚠️ LOSS ALERT - ${symbol}
====================
Asset: ${ASSET_CONFIGS[symbol]?.name || symbol}
Consecutive Losses: ${consecutiveLosses}
Today: W:${asset.dailyWins} / L:${asset.dailyLosses}
Asset Win Rate: ${(asset.winRate * 100).toFixed(1)}%
Daily Trades: ${asset.dailyTrades}

Portfolio Status:
----------------
Bot Capital: $${state.capital.toFixed(2)}
Daily P/L: +$${state.portfolio.dailyProfit.toFixed(2)} / -$${state.portfolio.dailyLoss.toFixed(2)}

${consecutiveLosses >= 3 ? '🚫 ASSET ENTERING 4-HOUR COOLDOWN' : ''}
        `;

        await this.sendEmail(`Loss Alert: ${symbol}${consecutiveLosses >= 3 ? ' (COOLDOWN)' : ''}`, text);
    }

    async sendStatusUpdate(status) {
        const text = `
🤖 BOT STATUS UPDATE
=================
Time: ${new Date().toLocaleString()}
Status: ${status}

Bot Capital: $${state.capital.toFixed(2)}
Account Balance: $${state.accountBalance.toFixed(2)}
Daily Profit: +$${state.portfolio.dailyProfit.toFixed(2)}
Daily Loss: -$${state.portfolio.dailyLoss.toFixed(2)}
Active Positions: ${state.portfolio.activePositions.length}
        `;

        await this.sendEmail('Status Update', text);
    }
}

// ============================================
// WEBSOCKET CONNECTION MANAGER
// ============================================

class ConnectionManager {
    constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000;
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

        // Authorize
        this.send({
            authorize: CONFIG.API_TOKEN
        });
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
        // Handle authorization
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

            // Start the bot
            bot.start();
        }

        // Handle tick data
        if (response.msg_type === 'tick') {
            this.handleTick(response.tick);
        }

        // Handle OHLC data
        if (response.msg_type === 'ohlc') {
            this.handleOHLC(response.ohlc);
        }

        // Handle candles history
        if (response.msg_type === 'candles') {
            this.handleCandlesHistory(response);
        }

        // Handle buy response
        if (response.msg_type === 'buy') {
            this.handleBuyResponse(response);
        }

        // Handle proposal
        if (response.msg_type === 'proposal') {
            this.handleProposal(response);
        }

        // Handle proposal_open_contract
        if (response.msg_type === 'proposal_open_contract') {
            this.handleOpenContract(response);
        }

        // Handle balance updates
        if (response.msg_type === 'balance') {
            state.accountBalance = response.balance.balance;
            LOGGER.info(`💰 Account balance updated: $${state.accountBalance.toFixed(2)}`);
        }

        // Resolve pending requests
        if (response.req_id && state.pendingRequests.has(response.req_id)) {
            const { resolve } = state.pendingRequests.get(response.req_id);
            state.pendingRequests.delete(response.req_id);
            resolve(response);
        }
    }

    handleTick(tick) {
        const symbol = tick.symbol;
        if (!state.assets[symbol]) return;

        state.assets[symbol].ticks.push(tick.quote);

        // Keep only last N ticks (reduced for memory)
        if (state.assets[symbol].ticks.length > CONFIG.MAX_TICKS_STORED) {
            state.assets[symbol].ticks = state.assets[symbol].ticks.slice(-CONFIG.MAX_TICKS_STORED);
        }
    }

    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        if (!state.assets[symbol]) return;

        const candle = {
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close),
            epoch: ohlc.epoch
        };

        const candles = state.assets[symbol].candles;

        // Update or add candle
        if (candles.length > 0 && candles[candles.length - 1].epoch === candle.epoch) {
            candles[candles.length - 1] = candle;
        } else {
            candles.push(candle);
        }

        // Keep only last N candles (reduced for memory)
        if (candles.length > CONFIG.MAX_CANDLES_STORED) {
            state.assets[symbol].candles = candles.slice(-CONFIG.MAX_CANDLES_STORED);
        }

        // Update indicators
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

        LOGGER.info(`📊 Loaded ${response.candles.length} candles for ${symbol}`);
        this.updateIndicators(symbol);
    }

    updateIndicators(symbol) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];
        const candles = assetState.candles;

        if (candles.length < config.emaLong + 10) return;

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);

        // Store previous values for crossover detection and RSI momentum
        assetState.prevEmaShort = assetState.emaShort;
        assetState.prevEmaLong = assetState.emaLong;
        assetState.prevRsi = assetState.rsi;

        // Calculate indicators
        assetState.emaShort = TechnicalIndicators.calculateEMA(closes, config.emaShort);
        assetState.emaLong = TechnicalIndicators.calculateEMA(closes, config.emaLong);
        assetState.rsi = TechnicalIndicators.calculateRSI(closes, config.rsiPeriod);

        // Fixed ADX calculation
        const adxResult = TechnicalIndicators.calculateADX(highs, lows, closes, config.adxPeriod);
        assetState.adx = adxResult.adx;
        assetState.plusDI = adxResult.plusDI;
        assetState.minusDI = adxResult.minusDI;

        assetState.atr = TechnicalIndicators.calculateATR(highs, lows, closes, config.atrPeriod || 14);

        // Check for signals
        if (assetState.prevEmaShort && assetState.prevEmaLong) {
            const crossover = TechnicalIndicators.detectCrossover(
                assetState.prevEmaShort, assetState.prevEmaLong,
                assetState.emaShort, assetState.emaLong
            );

            if (crossover !== 'none') {
                this.processSignal(symbol, crossover);
            }
        }
    }

    processSignal(symbol, crossover) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];

        const direction = crossover === 'bullish' ? 'CALL' : 'PUT';

        // Calculate AI confidence (now includes RSI scoring, not filtering)
        const confidence = AIConfidenceModel.calculateConfidence(symbol, direction);

        // Log signal details
        LOGGER.signal(`${symbol} ${direction} signal - RSI: ${assetState.rsi.toFixed(1)}, ADX: ${assetState.adx.toFixed(1)}, Confidence: ${(confidence * 100).toFixed(1)}%`);

        // Check minimum confidence threshold
        if (confidence < CONFIG.MIN_CONFIDENCE_SCORE) {
            LOGGER.warn(`${symbol} ${direction} signal rejected: Low confidence (${(confidence * 100).toFixed(1)}%)`);
            return;
        }

        // Check ADX for trend strength (as filter, not just score)
        if (assetState.adx < config.adxThreshold) {
            LOGGER.warn(`${symbol} ${direction} signal rejected: Weak trend (ADX: ${assetState.adx.toFixed(1)} < ${config.adxThreshold})`);
            return;
        }

        // Store the signal
        assetState.lastSignal = {
            direction,
            confidence,
            timestamp: Date.now()
        };

        LOGGER.signal(`✅ ${symbol} ${direction} signal ACCEPTED - Executing trade`);

        // Try to execute trade
        bot.executeTrade(symbol, direction, confidence);
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);

            // Remove failed position from active positions
            const reqId = response.echo_req?.req_id;
            if (reqId) {
                const posIndex = state.portfolio.activePositions.findIndex(p => p.reqId === reqId);
                if (posIndex >= 0) {
                    state.portfolio.activePositions.splice(posIndex, 1);
                    LOGGER.warn(`Removed failed position for reqId ${reqId}`);
                }
            }
            return;
        }

        const contract = response.buy;
        LOGGER.trade(`Trade executed: Contract ID ${contract.contract_id}, Buy Price: $${contract.buy_price}`);

        // Find position by req_id and update with contract details
        const reqId = response.echo_req.req_id;
        const position = state.portfolio.activePositions.find(p => p.reqId === reqId);

        if (position) {
            position.contractId = contract.contract_id;
            position.buyPrice = contract.buy_price;
            LOGGER.info(`Linked contract ${contract.contract_id} to ${position.symbol} ${position.direction}`);
        } else {
            LOGGER.warn(`Could not find position for reqId ${reqId}`);
        }

        // Subscribe to contract updates
        this.send({
            proposal_open_contract: 1,
            contract_id: contract.contract_id,
            subscribe: 1
        });
    }

    handleProposal(response) {
        if (response.error) {
            LOGGER.error(`Proposal error: ${response.error.message}`);
            return;
        }

        const proposal = response.proposal;
        const symbol = response.echo_req?.symbol;

        // Store actual payout ratio for Kelly Criterion
        if (symbol && state.assets[symbol] && proposal.payout && proposal.ask_price) {
            const payoutRatio = (proposal.payout - proposal.ask_price) / proposal.ask_price;
            state.assets[symbol].lastPayoutRatio = payoutRatio;
        }

        LOGGER.info(`📋 Proposal: Payout: $${proposal.payout}, Ask: $${proposal.ask_price}`);
    }

    handleOpenContract(response) {
        if (response.error) return;

        const contract = response.proposal_open_contract;

        // Find the position
        const posIndex = state.portfolio.activePositions.findIndex(
            p => p.contractId === contract.contract_id
        );

        if (contract.is_sold || contract.is_expired) {
            const profit = contract.profit;
            const symbol = contract.underlying;

            const resultEmoji = profit >= 0 ? '✅' : '❌';
            LOGGER.trade(`${resultEmoji} Contract ${contract.contract_id} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`);

            // Record result
            if (posIndex >= 0) {
                const position = state.portfolio.activePositions[posIndex];
                RiskManager.recordTradeResult(symbol, profit, position.direction);
                state.portfolio.activePositions.splice(posIndex, 1);
            }

            // Unsubscribe from contract
            if (response.subscription?.id) {
                this.send({
                    forget: response.subscription.id
                });
            }
        } else if (posIndex >= 0) {
            // Update position with current profit/loss
            state.portfolio.activePositions[posIndex].currentProfit = contract.profit;
        }
    }

    onError(error) {
        LOGGER.error(`WebSocket error: ${error.message}`);
    }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;

        // Attempt reconnection
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            LOGGER.info(`🔄 Reconnecting in ${this.reconnectDelay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.reconnectDelay);
        } else {
            LOGGER.error('Max reconnection attempts reached. Exiting.');
            bot.emailManager.sendStatusUpdate('Disconnected - Max reconnection attempts reached');
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

    sendAsync(data) {
        return new Promise((resolve, reject) => {
            const reqId = this.send(data);
            if (reqId === null) {
                reject(new Error('Not connected'));
                return;
            }

            state.pendingRequests.set(reqId, { resolve, reject });

            // Timeout after 30 seconds
            setTimeout(() => {
                if (state.pendingRequests.has(reqId)) {
                    state.pendingRequests.delete(reqId);
                    reject(new Error('Request timeout'));
                }
            }, 30000);
        });
    }
}

// ============================================
// MAIN BOT CLASS
// ============================================

class DerivMultiAssetBot {
    constructor() {
        this.connection = new ConnectionManager();
        this.emailManager = new EmailManager();
        this.scoringInterval = null;
        this.rebalanceInterval = null;
        this.dailyResetInterval = null;
        this.summaryInterval = null;
        this.capitalSyncInterval = null;
    }

    async start() {
        console.log('\n🤖 ClaudeINV Deriv Multi-Asset Bot v2.0 Starting...');
        console.log('=====================================');
        console.log(`💰 Initial Capital: $${state.capital}`);
        console.log(`📊 Tracking ${Object.keys(ASSET_CONFIGS).length} assets`);
        console.log(`🎯 Trading top ${CONFIG.TOP_ASSETS_TO_TRADE} ranked assets`);
        console.log('=====================================\n');

        // Subscribe to balance updates
        this.connection.send({
            balance: 1,
            subscribe: 1
        });

        // Subscribe to assets
        await this.subscribeToAssets();

        // Initial asset ranking
        PortfolioManager.rankAssets();

        // Start periodic scoring
        this.scoringInterval = setInterval(() => {
            LOGGER.info('🔄 Recalculating asset scores...');
            PortfolioManager.rankAssets();
        }, CONFIG.ASSET_SCORING_INTERVAL);

        // Start rebalance interval
        this.rebalanceInterval = setInterval(() => {
            LOGGER.info('⚖️  Rebalancing portfolio allocations...');
            state.portfolio.lastRebalance = Date.now();
            PortfolioManager.rankAssets();
        }, CONFIG.REBALANCE_INTERVAL);

        // Capital drift check
        this.capitalSyncInterval = setInterval(() => {
            PortfolioManager.checkCapitalDrift();
        }, CONFIG.CAPITAL_SYNC_INTERVAL);

        // Daily reset at midnight UTC
        this.scheduleDailyReset();

        // 30-minute email summary
        this.summaryInterval = setInterval(() => {
            this.emailManager.sendSummary();
        }, 30 * 60 * 1000);

        LOGGER.info('✅ Bot started successfully!');
    }

    async subscribeToAssets() {
        const symbols = Object.keys(ASSET_CONFIGS);

        for (const symbol of symbols) {
            const config = ASSET_CONFIGS[symbol];

            // Get candle history first
            this.connection.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: 100,
                end: 'latest',
                granularity: 60,
                style: 'candles'
            });

            // Subscribe to OHLC updates
            this.connection.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: 1,
                end: 'latest',
                granularity: 60,
                style: 'candles',
                subscribe: 1
            });

            // Subscribe to ticks for real-time price
            this.connection.send({
                ticks: symbol,
                subscribe: 1
            });

            LOGGER.info(`📡 Subscribed to ${config.name} (${symbol})`);

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    executeTrade(symbol, direction, confidence) {
        // Check portfolio-wide limits
        if (!RiskManager.canTrade()) {
            return;
        }

        // Check asset-specific limits
        const assetCheck = RiskManager.canAssetTrade(symbol, direction);
        if (!assetCheck.allowed) {
            LOGGER.warn(`Trade blocked: ${assetCheck.reason}`);
            return;
        }

        // Check synthetic correlation
        if (PortfolioManager.checkSyntheticCorrelation(symbol)) {
            LOGGER.warn(`Trade blocked: Lower ranked in correlated pair`);
            return;
        }

        const config = ASSET_CONFIGS[symbol];
        const assetState = state.assets[symbol];

        // Get asset ranking
        const rank = state.portfolio.topRankedAssets.indexOf(symbol);
        if (rank === -1) {
            LOGGER.warn(`Trade blocked: Asset not in top ranked`);
            return;
        }

        // Check for existing same-direction trade
        const hasExisting = state.portfolio.activePositions.some(
            p => p.symbol === symbol && p.direction === direction
        );
        if (hasExisting) {
            LOGGER.warn(`Trade blocked: Already have active ${direction} on ${symbol}`);
            return;
        }

        // Calculate stake (includes progressive reduction after losses)
        const stake = PortfolioManager.calculateStake(symbol, rank);

        LOGGER.trade(`🎯 Executing: ${config.name} (${symbol}) ${direction}`);
        LOGGER.trade(`   Stake: $${stake} | Duration: ${config.duration}${config.durationUnit} | Confidence: ${(confidence * 100).toFixed(1)}% | Rank: #${rank + 1}`);

        // Create position BEFORE sending (fixes race condition)
        const position = {
            symbol,
            direction,
            stake,
            confidence,
            entryTime: Date.now(),
            contractId: null,
            reqId: null,
            currentProfit: 0,
            buyPrice: 0
        };

        // Add to array BEFORE sending
        state.portfolio.activePositions.push(position);

        // Send trade request
        const contractType = direction === 'CALL' ? 'CALL' : 'PUT';

        const reqId = this.connection.send({
            buy: 1,
            subscribe: 1,
            price: stake,
            parameters: {
                contract_type: contractType,
                symbol: symbol,
                currency: 'USD',
                amount: stake,
                duration: config.duration,
                duration_unit: config.durationUnit,
                basis: 'stake'
            }
        });

        // Update position with reqId
        position.reqId = reqId;

        // Update state
        assetState.dailyTrades++;
        assetState.dailyTradesPerDirection[direction]++;
    }

    scheduleDailyReset() {
        const now = new Date();
        const midnight = new Date(now);
        midnight.setUTCHours(24, 0, 0, 0);

        const msUntilMidnight = midnight - now;

        setTimeout(async () => {
            // Send final daily report before reset
            await this.emailManager.sendSummary(true);

            RiskManager.resetDailyCounters();
            this.scheduleDailyReset(); // Schedule next reset
        }, msUntilMidnight);

        LOGGER.info(`📅 Daily reset scheduled in ${(msUntilMidnight / 3600000).toFixed(1)} hours`);
    }

    stop() {
        LOGGER.info('🛑 Stopping bot...');

        if (this.scoringInterval) clearInterval(this.scoringInterval);
        if (this.rebalanceInterval) clearInterval(this.rebalanceInterval);
        if (this.summaryInterval) clearInterval(this.summaryInterval);
        if (this.capitalSyncInterval) clearInterval(this.capitalSyncInterval);

        this.emailManager.sendSummary(true);

        if (this.connection.ws) {
            this.connection.ws.close();
        }

        LOGGER.info('👋 Bot stopped');
    }

    getStatus() {
        const netPL = state.portfolio.dailyProfit - state.portfolio.dailyLoss;

        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            accountBalance: state.accountBalance,
            lockedProfit: state.lockedProfit,
            dailyProfit: state.portfolio.dailyProfit,
            dailyLoss: state.portfolio.dailyLoss,
            netPL: netPL,
            dailyWins: state.portfolio.dailyWins,
            dailyLosses: state.portfolio.dailyLosses,
            activePositionsCount: state.portfolio.activePositions.length,
            activePositions: state.portfolio.activePositions.map(pos => ({
                symbol: pos.symbol,
                direction: pos.direction,
                stake: pos.stake,
                profit: pos.currentProfit,
                duration: Math.floor((Date.now() - pos.entryTime) / 1000)
            })),
            topAssets: state.portfolio.topRankedAssets,
            assetStats: Object.entries(state.assets).map(([symbol, data]) => {
                const todayTrades = data.tradeHistory.filter(t => {
                    const today = new Date();
                    const tradeDate = new Date(t.timestamp);
                    return tradeDate.toDateString() === today.toDateString();
                });
                const assetProfit = todayTrades.reduce((sum, t) => sum + t.profit, 0);

                return {
                    symbol,
                    score: (data.score * 100).toFixed(1) + '%',
                    winRate: (data.winRate * 100).toFixed(1) + '%',
                    dailyTrades: data.dailyTrades,
                    rsi: data.rsi.toFixed(1),
                    adx: data.adx.toFixed(1),
                    profit: assetProfit.toFixed(2),
                    consecutiveLosses: data.consecutiveLosses
                };
            })
        };
    }
}

// ============================================
// CONSOLE DASHBOARD (Event-Driven)
// ============================================

class Dashboard {
    static getStatusHash() {
        const status = bot.getStatus();
        return JSON.stringify({
            capital: status.capital.toFixed(2),
            positions: status.activePositionsCount,
            netPL: status.netPL.toFixed(2),
            wins: status.dailyWins,
            losses: status.dailyLosses
        });
    }

    static display(force = false) {
        // Only update if something changed (event-driven)
        const currentHash = this.getStatusHash();
        if (!force && currentHash === state.lastDashboardHash) {
            return;
        }
        state.lastDashboardHash = currentHash;

        console.log('\n╔══════════════════════════════════════════════════════════════════╗');
        console.log('║         ClaudeINV DERIV MULTI-ASSET BOT v2.0 - DASHBOARD          ║');
        console.log('╠══════════════════════════════════════════════════════════════════╣');

        const status = bot.getStatus();

        const netPLColor = status.netPL >= 0 ? '\x1b[32m' : '\x1b[31m';
        const resetColor = '\x1b[0m';

        console.log(`║ 💰 Bot Capital: $${status.capital.toFixed(2).padEnd(10)} 🏦 Account: $${status.accountBalance.toFixed(2).padEnd(10)} ║`);
        console.log(`║ 📈 Daily: +$${status.dailyProfit.toFixed(2).padEnd(7)} -$${status.dailyLoss.toFixed(2).padEnd(7)} Net: ${netPLColor}${status.netPL >= 0 ? '+' : ''}$${status.netPL.toFixed(2)}${resetColor}`.padEnd(77) + '║');
        console.log(`║ 🎯 W/L: ${status.dailyWins}/${status.dailyLosses}  |  Positions: ${status.activePositionsCount}/${CONFIG.MAX_OPEN_POSITIONS}  |  🔒 Locked: $${status.lockedProfit.toFixed(2)}`.padEnd(68) + '║');
        console.log('╠══════════════════════════════════════════════════════════════════╣');

        if (status.activePositions.length > 0) {
            console.log('║ 🚀 ACTIVE POSITIONS:                                              ║');
            console.log('║ Symbol       | Dir  | Stake   | Profit  | Time                   ║');
            console.log('║--------------|------|---------|---------|------------------------║');
            status.activePositions.forEach(pos => {
                const profitColor = pos.profit >= 0 ? '\x1b[32m' : '\x1b[31m';
                const profitStr = `${pos.profit >= 0 ? '+' : ''}${pos.profit.toFixed(2)}`;
                console.log(`║ ${pos.symbol.padEnd(12)} | ${pos.direction.padEnd(4)} | $${pos.stake.toFixed(2).padEnd(6)} | ${profitColor}${profitStr.padEnd(7)}${resetColor} | ${pos.duration}s`.padEnd(77) + '║');
            });
            console.log('╠══════════════════════════════════════════════════════════════════╣');
        }

        console.log('║ 🏆 TOP RANKED: ' + status.topAssets.join(', ').padEnd(52) + '║');
        console.log('╠══════════════════════════════════════════════════════════════════╣');
        console.log('║ Symbol       | Score  | WR     | ADX   | Trades | P/L     | Streak║');
        console.log('║--------------|--------|--------|-------|--------|---------|-------║');

        status.assetStats.slice(0, 8).forEach(stat => {
            const isTop = status.topAssets.includes(stat.symbol);
            const marker = isTop ? '🏆' : '  ';
            const profitColor = parseFloat(stat.profit) >= 0 ? '\x1b[32m' : '\x1b[31m';
            const streakColor = stat.consecutiveLosses >= 2 ? '\x1b[31m' : '\x1b[0m';

            console.log(`║${marker}${stat.symbol.padEnd(11)} | ${stat.score.padEnd(6)} | ${stat.winRate.padEnd(6)} | ${stat.adx.padEnd(5)} | ${String(stat.dailyTrades).padEnd(6)} | ${profitColor}${stat.profit.padEnd(7)}${resetColor} | ${streakColor}${stat.consecutiveLosses}L${resetColor}`.padEnd(77) + '   ║');
        });

        console.log('╚══════════════════════════════════════════════════════════════════╝');
        console.log(`⏰ ${new Date().toLocaleTimeString()} | Press Ctrl+C to stop\n`);
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

const bot = new DerivMultiAssetBot();

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n⚠️  Received shutdown signal...');
    bot.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    bot.stop();
    process.exit(0);
});

// Validate API token
if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('              ClaudeINV DERIV MULTI-ASSET BOT v2.0              ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('\n⚠️  API Token not configured!\n');
    console.log('To run this bot, you need to:');
    console.log('1. Get your API token from https://app.deriv.com/account/api-token');
    console.log('2. Run with: API_TOKEN=your_token node deriv-multi-asset-bot.js');
    console.log('\nOptional environment variables:');
    console.log('  - CAPITAL: Initial capital (default: 500)');
    console.log('  - APP_ID: Deriv App ID (default: 1089)');
    console.log('  - EMAIL_USER: Gmail address for notifications');
    console.log('  - EMAIL_PASS: Gmail app password');
    console.log('  - EMAIL_RECIPIENT: Email to receive notifications\n');
    console.log('═══════════════════════════════════════════════════════════════');
    process.exit(1);
}

// Start the bot
console.log('═══════════════════════════════════════════════════════════════');
console.log('              ClaudeINV DERIV MULTI-ASSET BOT v2.0              ');
console.log('═══════════════════════════════════════════════════════════════');
console.log('\n🚀 Initializing bot...\n');

bot.connection.connect();

// Start dashboard updates after connection
setTimeout(() => {
    Dashboard.startLiveUpdates();
}, 3000);

// Export for testing
module.exports = {
    DerivMultiAssetBot,
    TechnicalIndicators,
    PortfolioManager,
    RiskManager,
    AIConfidenceModel,
    CONFIG,
    ASSET_CONFIGS,
    state
};
