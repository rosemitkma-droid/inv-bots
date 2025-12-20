#!/usr/bin/env node
/**
 * Deriv Multi-Asset Trading Bot
 * Advanced AI-powered portfolio trading with dynamic asset selection
 * 
 * Dependencies: npm install ws mathjs @tensorflow/tfjs-node
 * Usage: API_TOKEN=your_token node deriv-multi-asset-bot.js
 */

const WebSocket = require('ws');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
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
    API_TOKEN: 'DMylfkyce6VyZt7',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Portfolio Settings
    INITIAL_CAPITAL: 500,
    MAX_RISK_PER_TRADE: 0.25,           // 2.5% per trade
    DAILY_LOSS_LIMIT: 0.25,              // 5% daily loss limit
    DAILY_PROFIT_TARGET: 0.25,          // 2.5% daily profit target
    PROFIT_LOCK_RATIO: 0.25,              // Lock 50% of gains
    MAX_OPEN_POSITIONS: 50,
    TOP_ASSETS_TO_TRADE: 2, // Increased as requested earlier or implicitly by user preference

    // Martingale Settings
    MARTINGALE_MULTIPLIER: 2.0,
    LOSSES_BEFORE_MARTINGALE: 1,

    // Timing
    ASSET_SCORING_INTERVAL: 3 * 60 * 1000,    // 3 minutes
    REBALANCE_INTERVAL: 2 * 60 * 60 * 1000,   // 2 hours
    COOLDOWN_PERIOD: 2 * 60 * 60 * 1000,      // 2 hours after 3 losses
    BLACKLIST_PERIOD: 24 * 60 * 60 * 1000,    // 24 hours

    // AI Settings
    MIN_CONFIDENCE_SCORE: 0.7,
    MIN_WIN_RATE_THRESHOLD: 0.5,
    WIN_RATE_LOOKBACK: 20,

    // Email Settings
    EMAIL_CONFIG: {
        service: 'gmail',
        auth: {
            user: 'kenzkdp2@gmail.com',
            pass: 'jfjhtmussgfpbgpk'
        }
    },
    EMAIL_RECIPIENT: 'kenotaru@gmail.com'
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
        rsiThreshold: 30,
        adxPeriod: 14,
        adxThreshold: 25,
        atrThreshold: 0.6,
        duration: 15,
        durationUnit: 'm',
        maxTradesPerDay: 10,
        volatilityClass: 'low',
        tickSubscription: 'R_10',
        multiplier: 400
    },
    'R_25': {
        name: 'Volatility 25 Index',
        category: 'synthetic',
        emaShort: 10,
        emaLong: 24,
        rsiPeriod: 14,
        rsiThreshold: 32,
        adxPeriod: 14,
        adxThreshold: 25,
        atrThreshold: 0.6,
        duration: 20,
        durationUnit: 'm',
        maxTradesPerDay: 10,
        volatilityClass: 'medium-low',
        tickSubscription: 'R_25',
        multiplier: 400
    },
    // 'R_50': {
    //     name: 'Volatility 50 Index',
    //     category: 'synthetic',
    //     emaShort: 10,
    //     emaLong: 24,
    //     rsiPeriod: 14,
    //     rsiThreshold: 32,
    //     adxPeriod: 14,
    //     adxThreshold: 25,
    //     atrThreshold: 0.6,
    //     duration: 20,
    //     durationUnit: 'm',
    //     maxTradesPerDay: 10,
    //     volatilityClass: 'medium-low',
    //     tickSubscription: 'R_50',
    //     multiplier: 400
    // },
    // 'R_75': {
    //     name: 'Volatility 75 Index',
    //     category: 'synthetic',
    //     emaShort: 12,
    //     emaLong: 30,
    //     rsiPeriod: 21,
    //     rsiThreshold: 35,
    //     duration: 30,
    //     durationUnit: 'm',
    //     maxTradesPerDay: 10,
    //     volatilityClass: 'high',
    //     tickSubscription: 'R_75',
    //     multiplier: 400
    // },
    'R_100': {
        name: 'Volatility 100 Index',
        category: 'synthetic',
        emaShort: 12,
        emaLong: 30,
        rsiPeriod: 21,
        rsiThreshold: 35,
        adxPeriod: 14,
        adxThreshold: 25,
        atrThreshold: 0.6,
        duration: 30,
        durationUnit: 'm',
        maxTradesPerDay: 10,
        volatilityClass: 'high',
        tickSubscription: 'R_100',
        multiplier: 400
    },
    'BOOM1000': {
        name: 'Boom 1000 Index',
        category: 'synthetic',
        emaShort: 5,
        emaLong: 15,
        rsiPeriod: 7,
        rsiThreshold: 25,
        adxPeriod: 14,
        adxThreshold: 25,
        atrThreshold: 0.6,
        duration: 5,
        durationUnit: 'm',
        maxTradesPerDay: 10,
        volatilityClass: 'extreme',
        tickSubscription: 'BOOM1000',
        multiplier: 200
    },
    'CRASH1000': {
        name: 'Crash 1000 Index',
        category: 'synthetic',
        emaShort: 5,
        emaLong: 15,
        rsiPeriod: 7,
        rsiThreshold: 25,
        adxPeriod: 14,
        adxThreshold: 25,
        atrThreshold: 0.6,
        duration: 5,
        durationUnit: 'm',
        maxTradesPerDay: 10,
        volatilityClass: 'extreme',
        tickSubscription: 'CRASH1000',
        multiplier: 200
    },
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
// STATE MANAGEMENT
// ============================================

const state = {
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0, // Store actual account balance separately
    lockedProfit: 0,
    isConnected: false,
    isAuthorized: false,

    assets: {},

    portfolio: {
        dailyLoss: 0,
        dailyProfit: 0,
        dailyWins: 0,
        dailyLosses: 0,
        activePositions: [],
        topRankedAssets: [],
        lastRebalance: Date.now(),
        lastScoring: Date.now()
    },

    subscriptions: new Map(),
    pendingRequests: new Map(),
    requestId: 1
};

// Initialize asset states
Object.keys(ASSET_CONFIGS).forEach(symbol => {
    state.assets[symbol] = {
        candles: [],
        ticks: [],
        emaShort: 0,
        emaLong: 0,
        rsi: 50,
        adx: 0,
        atr: 0,
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
        wpr: -50,
        wprHistory: []
    };
});

// ============================================
// EMAIL MANAGER
// ============================================

class EmailManager {
    constructor() {
        this.transporter = nodemailer.createTransport(CONFIG.EMAIL_CONFIG);
    }

    async sendEmail(subject, text) {
        const mailOptions = {
            from: CONFIG.EMAIL_CONFIG.auth.user,
            to: CONFIG.EMAIL_RECIPIENT,
            subject: `ClaudeWill Deriv Multi-Asset Bot - ${subject}`,
            text: text
        };

        try {
            await this.transporter.sendMail(mailOptions);
            console.log(`📧 Email sent: ${subject}`);
        } catch (error) {
            console.error('❌ Email error:', error.message);
        }
    }

    async sendSummary(isFinal = false) {
        const totalTrades = state.portfolio.dailyWins + state.portfolio.dailyLosses;
        const winRate = totalTrades > 0
            ? ((state.portfolio.dailyWins / totalTrades) * 100).toFixed(2)
            : 0;

        const assetBreakdown = Object.entries(state.assets)
            .filter(([_, data]) => data.dailyTrades > 0)
            .map(([symbol, data]) =>
                `${symbol}: Wins: ${data.dailyWins} | Losses: ${data.dailyLosses} | WR: ${(data.winRate * 100).toFixed(1)}% | Trades: ${data.dailyTrades}`
            ).join('\n');

        const summaryText = `
            ${isFinal ? 'FINAL REPORT' : 'PERIODIC SUMMARY'}
            ========================================
            Time: ${new Date().toLocaleString()}

            Portfolio Performance:
            ---------------------
            Total Trades: ${totalTrades}
            Total Wins: ${state.portfolio.dailyWins}
            Total Losses: ${state.portfolio.dailyLosses}
            Win Rate: ${winRate}%

            Financial Status:
            ----------------
            Current Capital: $${state.capital.toFixed(2)}
            Daily Profit: $${state.portfolio.dailyProfit.toFixed(2)}
            Daily Loss: $${state.portfolio.dailyLoss.toFixed(2)}
            Locked Profit: $${state.lockedProfit.toFixed(2)}

            Active Positions: ${state.portfolio.activePositions.length}/${CONFIG.MAX_OPEN_POSITIONS}
            Top Ranked: ${state.portfolio.topRankedAssets.join(', ')}
            
            Per-Asset Breakdown:
            -------------------
            ${assetBreakdown || 'No trades yet today.'}
        `;

        await this.sendEmail(isFinal ? 'Final Report' : 'Summary Update', summaryText);
    }

    async sendLossAlert(symbol, consecutiveLosses) {
        const asset = state.assets[symbol];
        const text = `
            LOSS ALERT - ${symbol}
            ====================
            Asset: ${symbol}
            Wins/Losses Today: ${asset.dailyWins}/${asset.dailyLosses}
            Consecutive Losses: ${consecutiveLosses}
            Asset Win Rate: ${(asset.winRate * 100).toFixed(1)}%
            Daily Trades: ${asset.dailyTrades}

            Portfolio Status:
            ----------------
            Capital: $${state.capital.toFixed(2)}
            Total Portfolio Loss: $${state.portfolio.dailyLoss.toFixed(2)}

            ${consecutiveLosses >= 3 ? '⚠️ Asset entering 4-hour cooldown' : ''}
        `;

        await this.sendEmail(`Loss Alert: ${symbol}`, text);
    }

    async sendStatusUpdate(status) {
        const text = `
            BOT STATUS UPDATE
            =================
            Time: ${new Date().toLocaleString()}
            Status: ${status}

            Capital: $${state.capital.toFixed(2)}
            Total Daily Profit: $${state.portfolio.dailyProfit.toFixed(2)}
            Total Daily Loss: $${state.portfolio.dailyLoss.toFixed(2)}
        `;

        await this.sendEmail('Status Update', text);
    }
}

// ============================================
// TECHNICAL INDICATORS (Worker Thread Compatible)
// ============================================

class TechnicalIndicators {
    /**
     * Calculate Exponential Moving Average
     */
    static calculateEMA(prices, period) {
        if (prices.length < period) return null;

        const multiplier = 2 / (period + 1);
        let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

        for (let i = period; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }

        return ema;
    }

    /**
     * Calculate RSI
     */
    static calculateRSI(prices, period = 14) {
        if (prices.length < period + 1) return 50;

        const changes = [];
        for (let i = 1; i < prices.length; i++) {
            changes.push(prices[i] - prices[i - 1]);
        }

        const recentChanges = changes.slice(-period);
        let gains = 0, losses = 0;

        recentChanges.forEach(change => {
            if (change > 0) gains += change;
            else losses += Math.abs(change);
        });

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;

        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    /**
     * Calculate ADX (Average Directional Index) for trend strength
     */
    static calculateADX(highs, lows, closes, period = 14) {
        if (closes.length < period * 2) return 25;

        const trueRanges = [];
        const plusDM = [];
        const minusDM = [];

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

        // Smoothed averages
        const smoothedTR = this.smoothedAverage(trueRanges, period);
        const smoothedPlusDM = this.smoothedAverage(plusDM, period);
        const smoothedMinusDM = this.smoothedAverage(minusDM, period);

        if (smoothedTR === 0) return 25;

        const plusDI = (smoothedPlusDM / smoothedTR) * 100;
        const minusDI = (smoothedMinusDM / smoothedTR) * 100;

        const diSum = plusDI + minusDI;
        if (diSum === 0) return 25;

        const dx = Math.abs(plusDI - minusDI) / diSum * 100;

        return dx;
    }

    /**
     * Calculate ATR (Average True Range)
     */
    static calculateATR(highs, lows, closes, period = 14) {
        if (closes.length < period + 1) return 0;

        const trueRanges = [];

        for (let i = 1; i < closes.length; i++) {
            const tr = Math.max(
                highs[i] - lows[i],
                Math.abs(highs[i] - closes[i - 1]),
                Math.abs(lows[i] - closes[i - 1])
            );
            trueRanges.push(tr);
        }

        return this.smoothedAverage(trueRanges.slice(-period), period);
    }

    /**
     * Smoothed average for ADX calculation
     */
    static smoothedAverage(values, period) {
        if (values.length < period) return 0;

        let sum = values.slice(0, period).reduce((a, b) => a + b, 0);
        let smoothed = sum / period;

        for (let i = period; i < values.length; i++) {
            smoothed = (smoothed * (period - 1) + values[i]) / period;
        }

        return smoothed;
    }

    /**
     * Calculate Williams %R
     */
    static calculateWPR(highs, lows, closes, period = 80) {
        if (closes.length < period) return -50;

        const currentClose = closes[closes.length - 1];
        const recentHighs = highs.slice(-period);
        const recentLows = lows.slice(-period);

        const highestHigh = Math.max(...recentHighs);
        const lowestLow = Math.min(...recentLows);

        if (highestHigh === lowestLow) return -50;

        const wpr = ((highestHigh - currentClose) / (highestHigh - lowestLow)) * -100;
        return wpr;
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

        // Recent win rate (30% weight)
        const recentTrades = assetState.tradeHistory.slice(-CONFIG.WIN_RATE_LOOKBACK);
        const winRate = recentTrades.length > 0
            ? recentTrades.filter(t => t.profit > 0).length / recentTrades.length
            : 0.5;

        // Trend strength (25% weight) - based on ADX
        const trendStrength = Math.min(assetState.adx / 50, 1);

        // Volatility fit (20% weight) - how well current volatility matches asset class
        const volatilityFit = this.calculateVolatilityFit(symbol);

        // Predictability (25% weight) - based on consistent patterns
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
            returns.push((recentTicks[i] - recentTicks[i - 1]) / recentTicks[i - 1]);
        }

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
            return Math.max(0.3, 1 - (range.min - volatility) / range.min);
        } else {
            return Math.max(0.3, 1 - (volatility - range.max) / range.max);
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
            directions[trade.direction].total++;
            if (trade.profit > 0) {
                directions[trade.direction].wins++;
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
                console.log(`⏸️  ${symbol} is blacklisted until ${new Date(assetState.blacklistedUntil).toLocaleTimeString()}`);
                return;
            }
            if (Date.now() < assetState.cooldownUntil) {
                console.log(`⏸️  ${symbol} is cooling down until ${new Date(assetState.cooldownUntil).toLocaleTimeString()}`);
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
     */
    static calculateStake(symbol, rank) {
        const assetState = state.assets[symbol];
        const availableCapital = state.capital - state.lockedProfit;

        // Base Stake Calculation
        const totalRisk = availableCapital * CONFIG.MAX_RISK_PER_TRADE;
        let stake = totalRisk;
        // Simple allocation strategy for now, can be sophisticated later
        // const allocationRatio = rank === 0 ? 0.6 : 0.4;
        // stake = totalRisk * allocationRatio;

        // Use simpler fixed allocation for stability with Martingale
        stake = Math.max(1, totalRisk * 0.5);

        // Apply Martingale
        if (assetState.consecutiveLosses >= CONFIG.LOSSES_BEFORE_MARTINGALE) {
            stake = stake * Math.pow(CONFIG.MARTINGALE_MULTIPLIER, assetState.consecutiveLosses);
            console.log(`🔥 Martingale Applied for ${symbol}: ${assetState.consecutiveLosses} losses -> Stake $${stake.toFixed(2)}`);
        }

        // Ensure minimum stake
        stake = Math.max(stake, 1);

        // Cap at 20% of capital for safety (Martingale protection)
        stake = Math.min(stake, availableCapital * 0.20);

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
     * Check synthetic index correlation (R_75 and R_100 signals)
     */
    static checkSyntheticCorrelation(symbol) {
        const syntheticPairs = [
            ['R_10', 'R_100'],
            ['R_25', 'R_75'],
            ['R_75', 'R_25'],
            ['R_100', 'R_10'],
        ];

        for (const pair of syntheticPairs) {
            if (pair.includes(symbol)) {
                const other = pair.find(s => s !== symbol);
                if (state.assets[other]?.lastSignal) {
                    // Compare scores, return true if this symbol has lower score
                    return state.assets[symbol].score < state.assets[other].score;
                }
            }
        }
        return false;
    }
}

// ============================================
// AI CONFIDENCE MODEL
// ============================================

class AIConfidenceModel {
    /**
     * Calculate trade confidence score
     */
    static calculateConfidence(symbol, direction) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];

        let confidence = 0.5; // Base confidence

        // 1. RSI confirmation (20% weight)
        const rsi = assetState.rsi;
        if (direction === 'CALL') {
            if (rsi < config.rsiThreshold) confidence += 0.2;
            else if (rsi < 50) confidence += 0.1;
        } else {
            if (rsi > (100 - config.rsiThreshold)) confidence += 0.2;
            else if (rsi > 50) confidence += 0.1;
        }

        // 2. Trend strength (20% weight)
        if (assetState.adx > 25) {
            confidence += Math.min(assetState.adx / 100, 0.2);
        }

        // 3. Recent performance (20% weight)
        const recentWins = assetState.tradeHistory
            .slice(-5)
            .filter(t => t.profit > 0).length;
        confidence += (recentWins / 5) * 0.2;

        // 4. Volatility regime match (20% weight)
        const volFit = PortfolioManager.calculateVolatilityFit(symbol);
        confidence += volFit * 0.2;

        // 5. Time-of-day factor (20% weight)
        const hour = new Date().getUTCHours();
        if (config.category === 'forex') {
            // Forex best during London/NY sessions
            if ((hour >= 7 && hour <= 16) || (hour >= 13 && hour <= 21)) {
                confidence += 0.15;
            }
        } else if (config.category === 'synthetic') {
            // Synthetics trade 24/7 with consistent patterns
            confidence += 0.1;
        }

        return Math.min(confidence, 1);
    }
}

// ============================================
// RISK MANAGER
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
            console.log('🛑 Daily loss limit reached. Trading paused.');
            return false;
        }

        // Check max positions
        if (activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) {
            console.log('🛑 Maximum open positions reached.');
            return false;
        }

        // Check profit target (lock 50% of gains)
        if (dailyProfit >= availableCapital * CONFIG.DAILY_PROFIT_TARGET) {
            const profitToLock = dailyProfit * CONFIG.PROFIT_LOCK_RATIO;
            if (state.lockedProfit < profitToLock) {
                state.lockedProfit = profitToLock;
                console.log(`🔒 Locked ${profitToLock.toFixed(2)} in profits`);
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
     * Record trade result and update risk metrics
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
                console.log(`⏸️  ${symbol} entering cooldown after 3 consecutive losses`);
            }

            // Send loss alert email
            bot.emailManager.sendLossAlert(symbol, assetState.consecutiveLosses);
        }

        // Update trade history
        assetState.tradeHistory.push({
            timestamp: Date.now(),
            direction,
            profit
        });

        // Update win rate
        const recentTrades = assetState.tradeHistory.slice(-CONFIG.WIN_RATE_LOOKBACK);
        assetState.winRate = recentTrades.filter(t => t.profit > 0).length / recentTrades.length;

        // Check for blacklist condition
        if (recentTrades.length >= CONFIG.WIN_RATE_LOOKBACK &&
            assetState.winRate < CONFIG.MIN_WIN_RATE_THRESHOLD) {
            assetState.blacklistedUntil = Date.now() + CONFIG.BLACKLIST_PERIOD;
            console.log(`🚫 ${symbol} blacklisted for 48h due to low win rate (${(assetState.winRate * 100).toFixed(1)}%)`);
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

        console.log('📅 Daily counters reset');
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
        console.log('🔌 Connecting to Deriv API...');

        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);

        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', (data) => this.onMessage(data));
        this.ws.on('error', (error) => this.onError(error));
        this.ws.on('close', () => this.onClose());

        return this.ws;
    }

    onOpen() {
        console.log('✅ Connected to Deriv API');
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
            console.error('❌ Error parsing message:', error);
        }
    }

    handleResponse(response) {
        // Handle authorization
        if (response.msg_type === 'authorize') {
            if (response.error) {
                console.error('❌ Authorization failed:', response.error.message);
                return;
            }
            console.log('🔐 Authorized successfully');
            console.log(`👤 Account: ${response.authorize.loginid}`);
            console.log(`💰 Balance: ${response.authorize.balance} ${response.authorize.currency}`);
            state.isAuthorized = true;
            state.accountBalance = response.authorize.balance;
            // state.capital = response.authorize.balance; // REMOVED: Don't overwrite bot capital

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
            console.log(`💰 Real account balance updated: ${state.accountBalance}`);
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

        // Keep only last 500 ticks
        if (state.assets[symbol].ticks.length > 500) {
            state.assets[symbol].ticks = state.assets[symbol].ticks.slice(-500);
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

        // Keep only last 200 candles
        if (candles.length > 200) {
            state.assets[symbol].candles = candles.slice(-200);
        }

        // Update indicators
        this.updateIndicators(symbol);
    }

    handleCandlesHistory(response) {
        if (response.error) {
            console.error('❌ Error fetching candles:', response.error.message);
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

        console.log(`📊 Loaded ${response.candles.length} candles for ${symbol}`);
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

        // Store previous EMA values for crossover detection
        const prevEmaShort = assetState.emaShort;
        const prevEmaLong = assetState.emaLong;

        // Calculate indicators
        assetState.wpr = TechnicalIndicators.calculateWPR(highs, lows, closes, 80); // WPR Period 80
        assetState.rsi = TechnicalIndicators.calculateRSI(closes, config.rsiPeriod);//RSI Period 14
        assetState.adx = TechnicalIndicators.calculateADX(highs, lows, closes);
        assetState.atr = TechnicalIndicators.calculateATR(highs, lows, closes);

        // Update WPR History
        assetState.wprHistory.push(assetState.wpr);
        if (assetState.wprHistory.length > 3) {
            assetState.wprHistory.shift();
        }

        // Need at least 3 data points for breakout detection
        if (assetState.wprHistory.length < 3) return;

        const wprPrev = assetState.wprHistory[assetState.wprHistory.length - 2];   // Index 1 (previous)
        const wprCurr = assetState.wprHistory[assetState.wprHistory.length - 1];   // Index 2 (current)

        let signal = 'none';

        // Buy Signal: Breakout upward through -20 (Prev <= -20, Current > -20)
        // Note: kWilliamEA uses: (wprValues[1] > -20 && wprValues[2] <= -20) which interprets index 1 as current and 2 as previous?
        // Let's stick to standard chronological: Prev was below -20, Current is above -20.
        // Wait, kWilliamEA `ArraySetAsSeries(true)` means index 0 is newest.
        // EA: buySignal = (wprValues[1] > -20 && wprValues[2] <= -20);
        // wprValues[0] is current (forming), [1] is last closed bar, [2] is bar before that.
        // So checking if the *previous completed bar* broke out relative to the one before it.
        // We are processing on every tick/candle update. Let's use the last two *closed* values if possible, or just current live values.
        // Since we update using `closes` array which includes the latest candle, let's treat the latest calc as "current".

        // Buy: Cross above -20 from below
        if (wprPrev <= -20 && wprCurr > -20) {
            signal = 'CALL';
        }
        // Sell: Cross below -80 from above
        else if (wprPrev >= -80 && wprCurr < -80) {
            signal = 'PUT';
        }

        if (signal !== 'none') {
            this.processSignal(symbol, signal);
        }
    }

    processSignal(symbol, direction) {
        const assetState = state.assets[symbol];

        // Check RSI confirmation
        const config = ASSET_CONFIGS[symbol];
        let rsiConfirmed = false;
        // if (direction === 'CALL' && assetState.rsi < config.rsiThreshold) {
        //     rsiConfirmed = true;
        // } else if (direction === 'PUT' && assetState.rsi > (100 - config.rsiThreshold)) {
        //     rsiConfirmed = true;
        // }

        // if (!rsiConfirmed) {
        //     console.log(`⚠️  ${symbol} ${direction} signal rejected: RSI not confirmed (${assetState.rsi.toFixed(1)}|${config.rsiThreshold})`);
        //     return;
        // }


        //Check for ADX confirmation
        // let adxConfirmed = false;
        // if (direction === 'CALL' && assetState.adx > config.adxThreshold) {
        //     adxConfirmed = true;
        // } else if (direction === 'PUT' && assetState.adx < (100 - config.adxThreshold)) {
        //     adxConfirmed = true;
        // }

        // if (!adxConfirmed) {
        //     console.log(`⚠️  ${symbol} ${direction} signal rejected: ADX not confirmed (${assetState.adx.toFixed(1)})`);
        //     return;
        // }

        //Check for ATR confirmation
        // let atrConfirmed = false;
        // if (direction === 'CALL' && assetState.atr < config.atrThreshold) {
        //     atrConfirmed = true;
        // } else if (direction === 'PUT' && assetState.atr > (100 - config.atrThreshold)) {
        //     atrConfirmed = true;
        // }

        // if (!atrConfirmed) {
        //     console.log(`⚠️  ${symbol} ${direction} signal rejected: ATR not confirmed (${assetState.atr.toFixed(1)})`);
        //     return;
        // }

        // Calculate AI confidence
        const confidence = AIConfidenceModel.calculateConfidence(symbol, direction);

        if (confidence < CONFIG.MIN_CONFIDENCE_SCORE) {
            console.log(`⚠️  ${symbol} ${direction} signal rejected: Low confidence (${(confidence * 100).toFixed(1)}% | ${CONFIG.MIN_CONFIDENCE_SCORE})`);
            return;
        }

        // Store the signal
        assetState.lastSignal = {
            direction,
            confidence,
            timestamp: Date.now()
        };

        console.log(`\n📈 WPR Signal: ${symbol} ${direction}`);
        console.log(`   WPR Prev: ${assetState.wprHistory[assetState.wprHistory.length - 2].toFixed(2)} -> Curr: ${assetState.wprHistory[assetState.wprHistory.length - 1].toFixed(2)}`);

        // REVERSE LOGIC: Close opposite positions
        const oppositeDir = direction === 'CALL' ? 'PUT' : 'CALL';
        const activeOpposite = state.portfolio.activePositions.filter(p => p.symbol === symbol && p.direction === oppositeDir);

        if (activeOpposite.length > 0) {
            console.log(`🔄 Reversing trade for ${symbol}: Closing ${activeOpposite.length} ${oppositeDir} positions`);

            // Closing logic for Multipliers (Sell the contract)
            activeOpposite.forEach(position => {
                if (position.contractId) {
                    bot.connection.send({
                        sell: position.contractId,
                        price: 0 // Sell at market price
                    });
                    LOGGER.trade(`Selling opposite position ${position.contractId} on ${symbol}`);
                }
            });
        }

        // Try to execute trade
        LOGGER.signal(`${symbol} ${direction} WPR Breakout (Confidence: 100%)`);
        bot.executeTrade(symbol, direction, confidence);
    }

    handleBuyResponse(response) {
        if (response.error) {
            console.error('❌ Trade error:', response.error.message);
            return;
        }

        const contract = response.buy;
        console.log(`✅ Trade executed: Contract ID ${contract.contract_id}`);
        console.log(`   Buy Price: ${contract.buy_price}`);

        // Find position by req_id
        const reqId = response.echo_req.req_id;
        const position = state.portfolio.activePositions.find(p => p.reqId == reqId);

        if (position) {
            position.contractId = contract.contract_id;
            position.buyPrice = contract.buy_price;
            LOGGER.info(`Linked contract ${contract.contract_id} to position ${position.symbol} ${position.direction}`);
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
            console.error('❌ Proposal error:', response.error.message);
            return;
        }

        // Store proposal for potential execution
        const proposal = response.proposal;
        console.log(`📋 Proposal: ${proposal.longcode}`);
        console.log(`   Payout: ${proposal.payout}, Ask: ${proposal.ask_price}`);
    }

    handleOpenContract(response) {
        if (response.error) return;

        const contract = response.proposal_open_contract;

        // Debug: Log contract updates for R_75
        if (contract.underlying === 'R_75') {
            // console.log(`[DEBUG] R_75 Update: ID=${contract.contract_id} Profit=${contract.profit} Sold=${contract.is_sold}`);
        }

        // Find the position (using loose equality for IDs)
        const posIndex = state.portfolio.activePositions.findIndex(
            p => p.contractId == contract.contract_id
        );

        if (contract.is_sold || contract.is_expired) {
            const profit = contract.profit;
            const symbol = contract.underlying;

            console.log(`\n🏁 Contract ${contract.contract_id} closed`);
            console.log(`   Result: ${profit >= 0 ? '✅ WIN' : '❌ LOSS'} ${profit.toFixed(2)}`);

            // Record result
            if (posIndex >= 0) {
                const position = state.portfolio.activePositions[posIndex];
                LOGGER.trade(`Contract ${contract.contract_id} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} ($${profit.toFixed(2)})`);
                RiskManager.recordTradeResult(symbol, profit, position.direction);
                state.portfolio.activePositions.splice(posIndex, 1);
            }

            // Unsubscribe from contract
            this.send({
                forget: response.subscription?.id
            });
        } else if (posIndex >= 0) {
            // Update position with current profit/loss
            state.portfolio.activePositions[posIndex].currentProfit = contract.profit;
        }
    }

    onError(error) {
        console.error('❌ WebSocket error:', error.message);
    }

    onClose() {
        console.log('🔌 Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;

        // Attempt reconnection
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`🔄 Reconnecting in ${this.reconnectDelay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.reconnectDelay);
        } else {
            console.error('❌ Max reconnection attempts reached. Exiting.');
            // bot.emailManager.sendStatusUpdate('Disconnected - Max reconnection attempts reached');
            process.exit(1);
        }
    }

    send(data) {
        if (!state.isConnected) {
            console.error('❌ Cannot send: Not connected');
            return;
        }

        data.req_id = state.requestId++;
        this.ws.send(JSON.stringify(data));
        return data.req_id;
    }

    sendAsync(data) {
        return new Promise((resolve, reject) => {
            const reqId = this.send(data);
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
    }

    async start() {
        console.log('\n🤖 ClaudeINV Deriv Multi-Asset Bot Starting...');
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

        // Subscribe to assets (max 5 at a time for efficiency)
        await this.subscribeToAssets();

        // Initial asset ranking
        PortfolioManager.rankAssets();

        // Start periodic scoring
        this.scoringInterval = setInterval(() => {
            console.log('\n🔄 Recalculating asset scores...');
            PortfolioManager.rankAssets();
        }, CONFIG.ASSET_SCORING_INTERVAL);

        // Start rebalance interval
        this.rebalanceInterval = setInterval(() => {
            console.log('\n⚖️  Rebalancing portfolio allocations...');
            state.portfolio.lastRebalance = Date.now();
            PortfolioManager.rankAssets();
        }, CONFIG.REBALANCE_INTERVAL);

        // Daily reset at midnight UTC
        this.scheduleDailyReset();

        // Start 30-minute email summary timer
        this.summaryInterval = setInterval(() => {
            this.emailManager.sendSummary();
        }, 1800000);

        // this.emailManager.sendStatusUpdate('Bot Started Successfully');
        console.log('✅ Bot started successfully!\n');
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

            console.log(`📡 Subscribed to ${config.name} (${symbol})`);

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
            console.log(`⚠️  Trade blocked: ${assetCheck.reason}`);
            return;
        }

        // Check synthetic correlation
        if (PortfolioManager.checkSyntheticCorrelation(symbol)) {
            console.log(`⚠️  Trade blocked: Lower ranked in correlated pair`);
            return;
        }

        // Check for existing same-direction trade
        const hasExisting = state.portfolio.activePositions.some(
            p => p.symbol === symbol && p.direction === direction
        );
        if (hasExisting) {
            console.log(`⚠️  Trade blocked: Already have an active ${direction} on ${symbol}`);
            return;
        }

        const config = ASSET_CONFIGS[symbol];
        const assetState = state.assets[symbol];

        // Get asset ranking
        const rank = state.portfolio.topRankedAssets.indexOf(symbol);
        if (rank === -1) {
            console.log(`⚠️  Trade blocked: Asset not in top ranked`);
            return;
        }

        // Calculate stake
        const stake = PortfolioManager.calculateStake(symbol, rank);

        console.log(`\n🎯 Executing Trade:`);
        console.log(`   Asset: ${config.name} (${symbol})`);
        console.log(`   Direction: ${direction}`);
        console.log(`   Stake: $${stake}`);
        console.log(`   Duration: ${config.duration}${config.durationUnit}`);
        console.log(`   Confidence: ${(confidence * 100).toFixed(1)}%`);
        console.log(`   Ranking: #${rank + 1}`);

        // Send trade request
        const contractType = direction === 'CALL' ? 'MULTUP' : 'MULTDOWN';

        const reqId = this.connection.send({
            buy: 1,
            subscribe: 1,
            price: stake,
            parameters: {
                contract_type: contractType,
                symbol: symbol,
                currency: 'USD',
                amount: stake,
                multiplier: config.multiplier || 100, // Use Configured Multiplier
                // Multipliers do not have 'duration'. They run until closed or stop-out.
                // duration: config.duration,
                // duration_unit: config.durationUnit,
                basis: 'stake'
            }
        });

        // Update state
        assetState.dailyTrades++;
        assetState.dailyTradesPerDirection[direction]++;

        // Track position (contract ID will be updated in buy response)
        state.portfolio.activePositions.push({
            symbol,
            direction,
            stake,
            confidence,
            entryTime: Date.now(),
            contractId: null,
            reqId: reqId, // Store reqId to match with response
            currentProfit: 0,
            buyPrice: 0
        });

        LOGGER.trade(`Placing ${direction} trade on ${symbol} with stake $${stake}`);
    }


    scheduleDailyReset() {
        const now = new Date();
        const midnight = new Date(now);
        midnight.setUTCHours(24, 0, 0, 0);

        const msUntilMidnight = midnight - now;

        setTimeout(() => {
            RiskManager.resetDailyCounters();
            this.scheduleDailyReset(); // Schedule next reset
        }, msUntilMidnight);

        console.log(`📅 Daily reset scheduled in ${(msUntilMidnight / 3600000).toFixed(1)} hours`);
    }

    stop() {
        console.log('\n🛑 Stopping bot...');

        if (this.scoringInterval) clearInterval(this.scoringInterval);
        if (this.rebalanceInterval) clearInterval(this.rebalanceInterval);
        if (this.summaryInterval) clearInterval(this.summaryInterval);

        this.emailManager.sendSummary(true);

        if (this.connection.ws) {
            this.connection.ws.close();
        }

        console.log('👋 Bot stopped');
    }

    getStatus() {
        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            accountBalance: state.accountBalance,
            lockedProfit: state.lockedProfit,
            dailyProfit: state.portfolio.dailyProfit,
            dailyLoss: state.portfolio.dailyLoss,
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
                const assetProfit = data.tradeHistory.reduce((sum, t) => sum + t.profit, 0);
                return {
                    symbol,
                    score: (data.score * 100).toFixed(1) + '%',
                    winRate: (data.winRate * 100).toFixed(1) + '%',
                    dailyTrades: data.dailyTrades,
                    rsi: data.rsi.toFixed(1),
                    adx: data.adx.toFixed(1),
                    profit: assetProfit.toFixed(2)
                };
            })
        };
    }
}

// ============================================
// CONSOLE DASHBOARD
// ============================================

class Dashboard {
    static display() {
        // console.clear();
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log('║         ClaudeINV DERIV MULTI-ASSET BOT - LIVE DASHBOARD      ║');
        console.log('╠══════════════════════════════════════════════════════════════╣');

        const status = bot.getStatus();

        console.log(`║ 💰 Bot Capital: $${status.capital.toFixed(2).padEnd(10)} 🔒 Locked: $${status.lockedProfit.toFixed(2).padEnd(8)}║`);
        console.log(`║ 🏦 Real Balance: $${status.accountBalance.toFixed(2).padEnd(46)}║`);
        console.log(`║ 📈 Daily P/L: +$${status.dailyProfit.toFixed(2)} / -$${status.dailyLoss.toFixed(2)}`.padEnd(64) + '║');
        console.log(`║ 📊 Positions: ${status.activePositionsCount}/${CONFIG.MAX_OPEN_POSITIONS}`.padEnd(64) + '║');
        console.log('╠══════════════════════════════════════════════════════════════╣');

        if (status.activePositions.length > 0) {
            console.log('║ 🚀 ACTIVE POSITIONS:                                         ║');
            console.log('║ Symbol      | Dir  | Stake  | Profit | Time                 ║');
            console.log('║-------------|------|--------|--------|----------------------║');
            status.activePositions.forEach(pos => {
                const profit = pos.profit || 0;
                const profitColor = profit >= 0 ? '\x1b[32m' : '\x1b[31m';
                const resetColor = '\x1b[0m';
                const line = `║ ${pos.symbol.padEnd(11)} | ${pos.direction.padEnd(4)} | $${pos.stake.toFixed(2).padEnd(6)} | ${profitColor}${profit.toFixed(2).padEnd(6)}${resetColor} | ${pos.duration}s`.padEnd(73) + '║';
                console.log(line);
            });
            console.log('╠══════════════════════════════════════════════════════════════╣');
        }

        console.log('║ 🏆 TOP RANKED ASSETS:                                        ║');

        status.topAssets.forEach((symbol, idx) => {
            const stat = status.assetStats.find(s => s.symbol === symbol);
            if (stat) {
                console.log(`║   ${idx + 1}. ${symbol.padEnd(12)} Score: ${stat.score.padEnd(7)} WR: ${stat.winRate.padEnd(7)}║`);
            }
        });

        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log('║ 📊 ASSET PERFORMANCE:                                        ║');
        console.log('║ Symbol      | Score  | WinRate | Trades | RSI   | P/L       ║');
        console.log('║-------------|--------|---------|--------|-------|-----------║');

        status.assetStats.slice(0, 10).forEach(stat => {
            const profitColor = parseFloat(stat.profit) >= 0 ? '\x1b[32m' : '\x1b[31m';
            const resetColor = '\x1b[0m';
            const line = `║ ${stat.symbol.padEnd(11)} | ${stat.score.padEnd(6)} | ${stat.winRate.padEnd(7)} | ${String(stat.dailyTrades).padEnd(6)} | ${stat.rsi.padEnd(5)} | ${profitColor}${stat.profit.padEnd(9)}${resetColor} ║`;
            console.log(line);
        });

        console.log('╚══════════════════════════════════════════════════════════════╝');
        console.log(`⏰ Last update: ${new Date().toLocaleTimeString()} | Press Ctrl+C to stop`);
    }

    static startLiveUpdates() {
        setInterval(() => {
            if (state.isAuthorized) {
                Dashboard.display();
            }
        }, 5000);
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
    console.log('                    ClaudeINV DERIV MULTI-ASSET BOT              ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('\n⚠️  API Token not configured!\n');
    console.log('To run this bot, you need to:');
    console.log('1. Get your API token from https://app.deriv.com/account/api-token');
    console.log('2. Run with: API_TOKEN=your_token node deriv-multi-asset-bot.js');
    console.log('   Or set it in the CONFIG object\n');
    console.log('Optional environment variables:');
    console.log('  - CAPITAL: Initial capital (default: 500)');
    console.log('  - APP_ID: Deriv App ID (default: 1089)\n');
    console.log('═══════════════════════════════════════════════════════════════');
    process.exit(1);
}

// Start the bot
console.log('═══════════════════════════════════════════════════════════════');
console.log('                    ClaudeINV DERIV MULTI-ASSET BOT              ');
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
