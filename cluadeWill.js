#!/usr/bin/env node
/**
 * Deriv Multi-Asset Trading Bot v4.1
 * Uses MULTIPLIERS for instant close/reverse (MT5-style trading)
 * 
 * MULTIPLIERS ADVANTAGES:
 * - Can be closed anytime (no fixed expiry)
 * - Position flipping supported (close & reverse)
 * - Profit/loss based on price movement × multiplier
 * - Stop Loss and Take Profit built-in
 * 
 * SUPPORTED ASSETS:
 * - Synthetic Indices: Volatility 10-100, Boom/Crash 1000, Step Index, Jump Indices
 * - Forex Pairs: EUR/USD, GBP/USD, AUD/USD, USD/JPY (CFD-style multipliers)
 * - Crypto: BTC/USD, ETH/USD
 * - Commodities: Gold, Silver, Oil
 * 
 * STRATEGY: WPR Breakout (from MT5 kWilliam EA)
 * - BUY: WPR crosses above -20
 * - SELL: WPR crosses below -80
 * - Martingale stake management
 * - Accumulated loss recovery
 * 
 * Dependencies: npm install ws mathjs nodemailer
 * Usage: API_TOKEN=your_token node deriv-multiplier-bot.js
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
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`); },
    dashboard: (msg) => console.log(msg)
};

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
    // API Settings
    API_TOKEN: process.env.API_TOKEN || 'DMylfkyce6VyZt7',
    APP_ID: process.env.APP_ID || '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Capital Settings
    INITIAL_CAPITAL: parseFloat(process.env.CAPITAL) || 500,
    // Note: Initial stake should be >= highest minStake of active assets
    // Synthetics: $0.35-$1.00, Forex/Crypto/Commodities: $5.00
    INITIAL_STAKE: parseFloat(process.env.STAKE) || 1.00,

    // Session Targets
    SESSION_PROFIT_TARGET: parseFloat(process.env.PROFIT_TARGET) || 50,
    SESSION_STOP_LOSS: parseFloat(process.env.STOP_LOSS) || -50,

    // Martingale Settings
    MARTINGALE_MULTIPLIER: parseFloat(process.env.MARTINGALE) || 2.0,
    LOSSES_BEFORE_MARTINGALE: parseInt(process.env.N_LOSSES) || 1,
    MAX_MARTINGALE_LEVEL: 5,

    // Multiplier Settings
    USE_STOP_LOSS: true,
    USE_TAKE_PROFIT: true,
    STOP_LOSS_PERCENT: 5,                 // 5% stop loss on stake
    TAKE_PROFIT_PERCENT: 10,              // 10% take profit on stake

    // Trade Settings
    MAX_TRADES_PER_ASSET: 200,
    MAX_OPEN_POSITIONS: 10,
    TOP_ASSETS_TO_TRADE: 3,

    // WPR Settings
    WPR_PERIOD: 80,
    WPR_OVERBOUGHT: -20,
    WPR_OVERSOLD: -80,

    // Timing
    ASSET_SCORING_INTERVAL: 5 * 60 * 1000,
    COOLDOWN_AFTER_SESSION_END: 30 * 60 * 1000,

    // Risk Settings
    DAILY_LOSS_LIMIT: 0.20,
    MIN_WIN_RATE_THRESHOLD: 0.40,
    WIN_RATE_LOOKBACK: 20,
    BLACKLIST_PERIOD: 24 * 60 * 60 * 1000,

    // Performance
    MAX_TICKS_STORED: 100,
    MAX_CANDLES_STORED: 150,
    DASHBOARD_UPDATE_INTERVAL: 10000,

    // Debug
    DEBUG_MODE: process.env.DEBUG === 'true' || false,

    // Email Settings
    EMAIL_ENABLED: process.env.EMAIL_ENABLED === 'true' || false,
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
// COMPREHENSIVE ASSET CONFIGURATION
// ============================================

/**
 * MULTIPLIER AVAILABILITY BY ASSET TYPE:
 * 
 * Synthetic Indices:
 * - Volatility Indices (R_10, R_25, R_50, R_75, R_100): x10-x1000
 * - 1-Second Volatility (1HZ10V, etc.): x10-x1000
 * - Jump Indices (JD10, JD25, etc.): x10-x200
 * - Boom/Crash 1000: x10-x300
 * - Step Index: x10-x500
 * 
 * Forex (Deriv MT5/Multipliers):
 * - Major Pairs: x10-x1000 (varies by pair)
 * 
 * Crypto:
 * - BTC, ETH, LTC: x10-x100
 * 
 * Commodities:
 * - Gold, Silver: x10-x500
 * - Oil: x10-x100
 */

/**
 * CORRECTED MULTIPLIER VALUES FROM DERIV API
 * 
 * Based on actual API responses:
 * - R_10: [20, 40, 60, 80, 100] - min stake varies
 * - R_25: [20, 40, 60, 80, 100] - min stake varies
 * - R_50: [80, 200, 400, 600, 800] - min stake $0.50+
 * - R_75: [20, 40, 60, 80, 100, 200, 300, 400, 500] - min stake $1+
 * - R_100: [20, 40, 60, 80, 100, 200, 300, 400, 500] - min stake $1+
 * - 1HZ Series: Similar to R_ series
 * - Crypto: [50, 100, 150, 200, 250, 300] - min stake $5+
 * - Forex: Various - min stake $1+
 * 
 * IMPORTANT: Minimum stake varies by multiplier level!
 * Higher multiplier = Higher minimum stake typically
 */

const ASSET_CONFIGS = {
    // ==========================================
    // SYNTHETIC INDICES - Volatility (Standard)
    // ==========================================
    'R_10': {
        name: 'Volatility 10 Index',
        category: 'synthetic',
        subcategory: 'volatility',
        contractType: 'multiplier',
        multipliers: [400, 1000, 2000, 3000, 4000],
        defaultMultiplier: 400,           // Use lowest for minimum stake
        wprPeriod: 80,
        maxTradesPerDay: 12,
        volatilityClass: 'low',
        minStake: 1.00,                  // Actual minimum
        maxStake: 2000,
        tickSubscription: 'R_10',
        tradingHours: '24/7'
    },
    'R_25': {
        name: 'Volatility 25 Index',
        category: 'synthetic',
        subcategory: 'volatility',
        contractType: 'multiplier',
        multipliers: [160, 400, 800, 1200, 1600],
        defaultMultiplier: 160,
        wprPeriod: 80,
        maxTradesPerDay: 12,
        volatilityClass: 'medium-low',
        minStake: 1.00,
        maxStake: 2000,
        tickSubscription: 'R_25',
        tradingHours: '24/7'
    },
    'R_50': {
        name: 'Volatility 50 Index',
        category: 'synthetic',
        subcategory: 'volatility',
        contractType: 'multiplier',
        multipliers: [80, 200, 400, 600, 800],  // CORRECTED from API error
        defaultMultiplier: 80,                   // Use lowest
        wprPeriod: 80,
        maxTradesPerDay: 12,
        volatilityClass: 'medium',
        minStake: 1.00,
        maxStake: 2000,
        tickSubscription: 'R_50',
        tradingHours: '24/7'
    },
    'R_75': {
        name: 'Volatility 75 Index',
        category: 'synthetic',
        subcategory: 'volatility',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 500],
        defaultMultiplier: 50,                   // Lowest for min stake
        wprPeriod: 80,
        maxTradesPerDay: 12,
        volatilityClass: 'high',
        minStake: 1.00,                          // Higher min for R_75
        maxStake: 3000,
        tickSubscription: 'R_75',
        tradingHours: '24/7'
    },
    'R_100': {
        name: 'Volatility 100 Index',
        category: 'synthetic',
        subcategory: 'volatility',
        contractType: 'multiplier',
        multipliers: [40, 100, 200, 300, 400],
        defaultMultiplier: 40,
        wprPeriod: 80,
        maxTradesPerDay: 12,
        volatilityClass: 'high',
        minStake: 1.00,
        maxStake: 3000,
        tickSubscription: 'R_100',
        tradingHours: '24/7'
    },

    // ==========================================
    // SYNTHETIC INDICES - 1-Second Volatility
    // ==========================================
    '1HZ10V': {
        name: 'Volatility 10 (1s) Index',
        category: 'synthetic',
        subcategory: 'volatility_1s',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200, 300],
        defaultMultiplier: 20,
        wprPeriod: 10,
        maxTradesPerDay: 15,
        volatilityClass: 'low',
        minStake: 0.35,
        maxStake: 1000,
        tickSubscription: '1HZ10V',
        tradingHours: '24/7'
    },
    '1HZ25V': {
        name: 'Volatility 25 (1s) Index',
        category: 'synthetic',
        subcategory: 'volatility_1s',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200, 300],
        defaultMultiplier: 20,
        wprPeriod: 10,
        maxTradesPerDay: 15,
        volatilityClass: 'medium-low',
        minStake: 0.35,
        maxStake: 1000,
        tickSubscription: '1HZ25V',
        tradingHours: '24/7'
    },
    '1HZ50V': {
        name: 'Volatility 50 (1s) Index',
        category: 'synthetic',
        subcategory: 'volatility_1s',
        contractType: 'multiplier',
        multipliers: [100, 200, 300, 400, 500, 600, 800, 1000],
        defaultMultiplier: 100,
        wprPeriod: 10,
        maxTradesPerDay: 12,
        volatilityClass: 'medium',
        minStake: 0.50,
        maxStake: 1000,
        tickSubscription: '1HZ50V',
        tradingHours: '24/7'
    },
    '1HZ75V': {
        name: 'Volatility 75 (1s) Index',
        category: 'synthetic',
        subcategory: 'volatility_1s',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200, 300, 400, 500, 1000],
        defaultMultiplier: 20,
        wprPeriod: 80,
        maxTradesPerDay: 10,
        volatilityClass: 'high',
        minStake: 0.50,
        maxStake: 1500,
        tickSubscription: '1HZ75V',
        tradingHours: '24/7'
    },
    '1HZ100V': {
        name: 'Volatility 100 (1s) Index',
        category: 'synthetic',
        subcategory: 'volatility_1s',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200, 300, 400, 500, 1000],
        defaultMultiplier: 20,
        wprPeriod: 80,
        maxTradesPerDay: 10,
        volatilityClass: 'high',
        minStake: 0.50,
        maxStake: 1500,
        tickSubscription: '1HZ100V',
        tradingHours: '24/7'
    },

    // ==========================================
    // SYNTHETIC INDICES - Boom/Crash 1000
    // ==========================================
    'BOOM1000': {
        name: 'Boom 1000 Index',
        category: 'synthetic',
        subcategory: 'boom_crash',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 150, 200, 250, 300],
        defaultMultiplier: 20,
        wprPeriod: 7,
        maxTradesPerDay: 15,
        volatilityClass: 'extreme',
        minStake: 0.35,
        maxStake: 500,
        tickSubscription: 'BOOM1000',
        onlyDirection: 'UP',
        tradingHours: '24/7'
    },
    'CRASH1000': {
        name: 'Crash 1000 Index',
        category: 'synthetic',
        subcategory: 'boom_crash',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 150, 200, 250, 300],
        defaultMultiplier: 20,
        wprPeriod: 7,
        maxTradesPerDay: 15,
        volatilityClass: 'extreme',
        minStake: 0.35,
        maxStake: 500,
        tickSubscription: 'CRASH1000',
        onlyDirection: 'DOWN',
        tradingHours: '24/7'
    },

    // ==========================================
    // SYNTHETIC INDICES - Jump Indices
    // ==========================================
    'JD10': {
        name: 'Jump 10 Index',
        category: 'synthetic',
        subcategory: 'jump',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200],
        defaultMultiplier: 20,
        wprPeriod: 80,
        maxTradesPerDay: 10,
        volatilityClass: 'low',
        minStake: 0.35,
        maxStake: 1000,
        tickSubscription: 'JD10',
        tradingHours: '24/7'
    },
    'JD25': {
        name: 'Jump 25 Index',
        category: 'synthetic',
        subcategory: 'jump',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200],
        defaultMultiplier: 20,
        wprPeriod: 80,
        maxTradesPerDay: 10,
        volatilityClass: 'medium-low',
        minStake: 0.35,
        maxStake: 1000,
        tickSubscription: 'JD25',
        tradingHours: '24/7'
    },
    'JD50': {
        name: 'Jump 50 Index',
        category: 'synthetic',
        subcategory: 'jump',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200],
        defaultMultiplier: 20,
        wprPeriod: 80,
        maxTradesPerDay: 8,
        volatilityClass: 'medium',
        minStake: 0.50,
        maxStake: 1000,
        tickSubscription: 'JD50',
        tradingHours: '24/7'
    },
    'JD75': {
        name: 'Jump 75 Index',
        category: 'synthetic',
        subcategory: 'jump',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200],
        defaultMultiplier: 20,
        wprPeriod: 21,
        maxTradesPerDay: 6,
        volatilityClass: 'high',
        minStake: 0.50,
        maxStake: 1500,
        tickSubscription: 'JD75',
        tradingHours: '24/7'
    },
    'JD100': {
        name: 'Jump 100 Index',
        category: 'synthetic',
        subcategory: 'jump',
        contractType: 'multiplier',
        multipliers: [20, 40, 60, 80, 100, 200],
        defaultMultiplier: 20,
        wprPeriod: 21,
        maxTradesPerDay: 5,
        volatilityClass: 'high',
        minStake: 0.50,
        maxStake: 1500,
        tickSubscription: 'JD100',
        tradingHours: '24/7'
    },

    // ==========================================
    // SYNTHETIC INDICES - Step Index
    // ==========================================
    'stpRNG': {
        name: 'Step Index',
        category: 'synthetic',
        subcategory: 'step',
        contractType: 'multiplier',
        multipliers: [10, 25, 50, 100, 200, 300, 500],
        defaultMultiplier: 10,
        wprPeriod: 80,
        maxTradesPerDay: 10,
        volatilityClass: 'low',
        minStake: 0.10,
        maxStake: 500,
        tickSubscription: 'stpRNG',
        tradingHours: '24/7'
    },

    // ==========================================
    // FOREX - Major Pairs (Multipliers)
    // Note: Forex multipliers may have different ranges
    // ==========================================
    'frxEURUSD': {
        name: 'EUR/USD',
        category: 'forex',
        subcategory: 'major',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 400, 500, 1000],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        volatilityClass: 'medium',
        minStake: 5,                         // Higher min for forex
        maxStake: 5000,
        tickSubscription: 'frxEURUSD',
        correlatedWith: ['frxGBPUSD'],
        tradingHours: 'Sun 22:05 - Fri 21:55 GMT'
    },
    'frxGBPUSD': {
        name: 'GBP/USD',
        category: 'forex',
        subcategory: 'major',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 400, 500, 1000],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        volatilityClass: 'medium-high',
        minStake: 5,
        maxStake: 5000,
        tickSubscription: 'frxGBPUSD',
        correlatedWith: ['frxEURUSD'],
        tradingHours: 'Sun 22:05 - Fri 21:55 GMT'
    },
    'frxUSDJPY': {
        name: 'USD/JPY',
        category: 'forex',
        subcategory: 'major',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 400, 500, 1000],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        volatilityClass: 'medium',
        minStake: 5,
        maxStake: 5000,
        tickSubscription: 'frxUSDJPY',
        tradingHours: 'Sun 22:05 - Fri 21:55 GMT'
    },
    'frxAUDUSD': {
        name: 'AUD/USD',
        category: 'forex',
        subcategory: 'major',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 400, 500],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        volatilityClass: 'medium',
        minStake: 5,
        maxStake: 4000,
        tickSubscription: 'frxAUDUSD',
        tradingHours: 'Sun 22:05 - Fri 21:55 GMT'
    },
    'frxUSDCAD': {
        name: 'USD/CAD',
        category: 'forex',
        subcategory: 'major',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 400, 500],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        volatilityClass: 'medium',
        minStake: 5,
        maxStake: 4000,
        tickSubscription: 'frxUSDCAD',
        tradingHours: 'Sun 22:05 - Fri 21:55 GMT'
    },
    'frxEURGBP': {
        name: 'EUR/GBP',
        category: 'forex',
        subcategory: 'minor',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        volatilityClass: 'low',
        minStake: 5,
        maxStake: 3000,
        tickSubscription: 'frxEURGBP',
        tradingHours: 'Sun 22:05 - Fri 21:55 GMT'
    },
    'frxNZDUSD': {
        name: 'NZD/USD',
        category: 'forex',
        subcategory: 'major',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        volatilityClass: 'medium',
        minStake: 5,
        maxStake: 3000,
        tickSubscription: 'frxNZDUSD',
        tradingHours: 'Sun 22:05 - Fri 21:55 GMT'
    },

    // ==========================================
    // CRYPTOCURRENCIES (Higher min stakes)
    // ==========================================
    'cryBTCUSD': {
        name: 'Bitcoin/USD',
        category: 'crypto',
        subcategory: 'major',
        contractType: 'multiplier',
        multipliers: [50, 100, 150, 200, 250, 300],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 8,
        volatilityClass: 'high',
        minStake: 5,                         // Crypto needs higher min
        maxStake: 3000,
        tickSubscription: 'cryBTCUSD',
        tradingHours: '24/7'
    },
    'cryETHUSD': {
        name: 'Ethereum/USD',
        category: 'crypto',
        subcategory: 'major',
        contractType: 'multiplier',
        multipliers: [50, 100, 150, 200, 250, 300],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 8,
        volatilityClass: 'high',
        minStake: 5,
        maxStake: 3000,
        tickSubscription: 'cryETHUSD',
        tradingHours: '24/7'
    },
    'cryLTCUSD': {
        name: 'Litecoin/USD',
        category: 'crypto',
        subcategory: 'altcoin',
        contractType: 'multiplier',
        multipliers: [50, 100, 150, 200],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 6,
        volatilityClass: 'high',
        minStake: 5,
        maxStake: 2000,
        tickSubscription: 'cryLTCUSD',
        tradingHours: '24/7'
    },
    'cryBNBUSD': {
        name: 'Binance Coin/USD',
        category: 'crypto',
        subcategory: 'altcoin',
        contractType: 'multiplier',
        multipliers: [50, 100, 150, 200],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 6,
        volatilityClass: 'high',
        minStake: 5,
        maxStake: 2000,
        tickSubscription: 'cryBNBUSD',
        tradingHours: '24/7'
    },

    // ==========================================
    // COMMODITIES
    // ==========================================
    'frxXAUUSD': {
        name: 'Gold/USD',
        category: 'commodity',
        subcategory: 'metals',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 400, 500],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        volatilityClass: 'medium-high',
        minStake: 5,
        maxStake: 5000,
        tickSubscription: 'frxXAUUSD',
        tradingHours: 'Sun 23:00 - Fri 21:55 GMT (1h break daily)'
    },
    'frxXAGUSD': {
        name: 'Silver/USD',
        category: 'commodity',
        subcategory: 'metals',
        contractType: 'multiplier',
        multipliers: [50, 100, 200, 300],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        volatilityClass: 'high',
        minStake: 5,
        maxStake: 3000,
        tickSubscription: 'frxXAGUSD',
        tradingHours: 'Sun 23:00 - Fri 21:55 GMT (1h break daily)'
    },
    'frxXPTUSD': {
        name: 'Platinum/USD',
        category: 'commodity',
        subcategory: 'metals',
        contractType: 'multiplier',
        multipliers: [50, 100, 150],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 4,
        volatilityClass: 'high',
        minStake: 5,
        maxStake: 2000,
        tickSubscription: 'frxXPTUSD',
        tradingHours: 'Sun 23:00 - Fri 21:55 GMT'
    },
    'frxXPDUSD': {
        name: 'Palladium/USD',
        category: 'commodity',
        subcategory: 'metals',
        contractType: 'multiplier',
        multipliers: [50, 100],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 4,
        volatilityClass: 'extreme',
        minStake: 5,
        maxStake: 2000,
        tickSubscription: 'frxXPDUSD',
        tradingHours: 'Sun 23:00 - Fri 21:55 GMT'
    },
    'WLDOIL': {
        name: 'Oil/USD (WTI)',
        category: 'commodity',
        subcategory: 'energy',
        contractType: 'multiplier',
        multipliers: [50, 100],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        volatilityClass: 'high',
        minStake: 5,
        maxStake: 2000,
        tickSubscription: 'WLDOIL',
        tradingHours: 'Sun 23:00 - Fri 21:55 GMT (1h break daily)'
    },
    'frxBROUSD': {
        name: 'Brent Crude Oil',
        category: 'commodity',
        subcategory: 'energy',
        contractType: 'multiplier',
        multipliers: [50, 100],
        defaultMultiplier: 50,
        wprPeriod: 80,
        maxTradesPerDay: 5,
        volatilityClass: 'high',
        minStake: 5,
        maxStake: 2000,
        tickSubscription: 'frxBROUSD',
        tradingHours: 'Mon 01:00 - Fri 21:55 GMT'
    }
};

// ============================================
// ASSET GROUPS FOR FILTERING
// ============================================

const ASSET_GROUPS = {
    synthetic_volatility: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
    synthetic_volatility_1s: ['1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'],
    synthetic_boom_crash: ['BOOM1000', 'CRASH1000'],
    synthetic_jump: ['JD10', 'JD25', 'JD50', 'JD75', 'JD100'],
    synthetic_step: ['stpRNG'],
    forex_major: ['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD', 'frxUSDCAD', 'frxNZDUSD'],
    forex_minor: ['frxEURGBP'],
    crypto: ['cryBTCUSD', 'cryETHUSD', 'cryLTCUSD', 'cryBNBUSD'],
    commodity_metals: ['frxXAUUSD', 'frxXAGUSD', 'frxXPTUSD', 'frxXPDUSD'],
    commodity_energy: ['WLDOIL', 'frxBROUSD']
};

// Active assets (can be modified at runtime)
// Note: Default to synthetics which have lower min stakes and more flexibility
let ACTIVE_ASSETS = process.env.ASSETS
    ? process.env.ASSETS.split(',')
    : [
        // Default: Synthetic indices with confirmed working multipliers
        'R_10', 'R_25',           // Low volatility - min stake $0.35
        'R_75', 'R_100',          // High volatility - min stake $1.00
        'BOOM1000', 'CRASH1000',  // Boom/Crash - min stake $0.35
        // Uncomment below if you have higher capital (min $5 stake):
        // 'frxEURUSD', 'frxXAUUSD', 'cryBTCUSD'
    ];

// ============================================
// STATE MANAGEMENT
// ============================================

const state = {
    // Capital
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,

    // Session (MT5 style)
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

    // Martingale
    martingale: {
        currentStake: CONFIG.INITIAL_STAKE,
        consecutiveLosses: 0,
        level: 0
    },

    // Connection
    isConnected: false,
    isAuthorized: false,
    lastDashboardHash: '',

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
    requestId: 1,
    lastEmailTime: {}
};

// Initialize asset states for active assets only
function initializeAssetStates() {
    let highestMinStake = 0;
    const stakeWarnings = [];

    ACTIVE_ASSETS.forEach(symbol => {
        if (ASSET_CONFIGS[symbol]) {
            const config = ASSET_CONFIGS[symbol];

            state.assets[symbol] = {
                candles: [],
                ticks: [],
                wpr: -50,
                prevWpr: -50,
                dailyTrades: 0,
                dailyWins: 0,
                dailyLosses: 0,
                consecutiveLosses: 0,
                blacklistedUntil: 0,
                tradeHistory: [],
                winRate: 0.5,
                score: 0,
                lastSignal: null,
                lastBarTime: 0,
                activePosition: null,
                currentDirection: null
            };

            // Track minimum stake requirements
            if (config.minStake > highestMinStake) {
                highestMinStake = config.minStake;
            }

            // Warn if initial stake is below asset minimum
            if (CONFIG.INITIAL_STAKE < config.minStake) {
                stakeWarnings.push(`${symbol} requires min $${config.minStake}`);
            }
        } else {
            LOGGER.warn(`Asset ${symbol} not found in ASSET_CONFIGS`);
        }
    });

    LOGGER.info(`Initialized ${Object.keys(state.assets).length} assets for trading`);

    // Display stake warnings
    if (stakeWarnings.length > 0) {
        LOGGER.warn('⚠️  STAKE WARNINGS:');
        stakeWarnings.forEach(w => LOGGER.warn(`   - ${w}`));
        LOGGER.warn(`   Your INITIAL_STAKE ($${CONFIG.INITIAL_STAKE}) should be >= $${highestMinStake}`);
        LOGGER.warn(`   Run with: STAKE=${highestMinStake} or higher`);
    }

    // Display multiplier info
    LOGGER.info('📊 Asset Multiplier Configuration:');
    Object.keys(state.assets).forEach(symbol => {
        const config = ASSET_CONFIGS[symbol];
        LOGGER.info(`   ${symbol}: x${config.defaultMultiplier} (options: ${config.multipliers.join(',')} | min stake: $${config.minStake})`);
    });
}

initializeAssetStates();

// ============================================
// TECHNICAL INDICATORS
// ============================================

class TechnicalIndicators {
    /**
     * Calculate Williams Percent Range (WPR)
     * WPR = (Highest High - Close) / (Highest High - Lowest Low) * -100
     * Range: -100 to 0
     */
    static calculateWPR(highs, lows, closes, period = 14) {
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
     * Detect WPR crossover signals
     */
    static detectWPRSignal(prevWpr, currWpr) {
        // BUY signal: WPR crosses above -20
        if (prevWpr <= CONFIG.WPR_OVERBOUGHT && currWpr > CONFIG.WPR_OVERBOUGHT) {
            return 'UP';
        }

        // SELL signal: WPR crosses below -80
        if (prevWpr >= CONFIG.WPR_OVERSOLD && currWpr < CONFIG.WPR_OVERSOLD) {
            return 'DOWN';
        }

        return null;
    }

    /**
     * Calculate volatility
     */
    static calculateVolatility(closes, period = 14) {
        if (closes.length < period + 1) return 0;

        const returns = [];
        for (let i = closes.length - period; i < closes.length; i++) {
            if (closes[i - 1] !== 0) {
                returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
            }
        }

        if (returns.length === 0) return 0;
        return math.std(returns) * 100;
    }
}

// ============================================
// MARTINGALE MANAGER
// ============================================

class MartingaleManager {
    static getCurrentStake() {
        return state.martingale.currentStake;
    }

    static recordWin(profit) {
        state.session.winsCount++;
        state.session.profit += profit;
        state.session.netPL += profit;

        if (state.session.netPL > 0 && state.session.accumulatedLoss > 0) {
            if (profit >= state.session.accumulatedLoss) {
                this.resetMartingale();
                state.session.accumulatedLoss = 0;
                state.session.currentProfitTarget = CONFIG.SESSION_PROFIT_TARGET;
                LOGGER.trade('🎉 Accumulated losses recovered! Resetting martingale.');
            } else {
                state.session.accumulatedLoss -= profit;
                LOGGER.info(`📉 Remaining accumulated loss: $${state.session.accumulatedLoss.toFixed(2)}`);
            }
        } else {
            this.resetMartingale();
        }

        state.capital += profit;
    }

    static recordLoss(loss) {
        const absLoss = Math.abs(loss);

        state.session.lossesCount++;
        state.session.loss += absLoss;
        state.session.netPL -= absLoss;
        state.martingale.consecutiveLosses++;

        state.session.accumulatedLoss += absLoss;
        state.session.currentProfitTarget = CONFIG.SESSION_PROFIT_TARGET + state.session.accumulatedLoss;

        if (state.martingale.consecutiveLosses >= CONFIG.LOSSES_BEFORE_MARTINGALE) {
            if (state.martingale.level < CONFIG.MAX_MARTINGALE_LEVEL) {
                state.martingale.currentStake *= CONFIG.MARTINGALE_MULTIPLIER;
                state.martingale.level++;
                state.martingale.consecutiveLosses = 0;

                LOGGER.warn(`📈 Martingale Level ${state.martingale.level}: Stake increased to $${state.martingale.currentStake.toFixed(2)}`);
            } else {
                LOGGER.error(`🛑 Max martingale level reached!`);
            }
        }

        state.capital -= absLoss;

        LOGGER.info(`📊 Accumulated Loss: $${state.session.accumulatedLoss.toFixed(2)} | New Target: $${state.session.currentProfitTarget.toFixed(2)}`);
    }

    static resetMartingale() {
        state.martingale.currentStake = CONFIG.INITIAL_STAKE;
        state.martingale.consecutiveLosses = 0;
        state.martingale.level = 0;
        LOGGER.info('🔄 Martingale reset to initial stake');
    }

    static getSafeStake(symbol) {
        const config = ASSET_CONFIGS[symbol];
        if (!config) return CONFIG.INITIAL_STAKE;

        let stake = this.getCurrentStake();

        // Ensure stake meets minimum for this asset
        stake = Math.max(stake, config.minStake);

        // Cap at asset max
        stake = Math.min(stake, config.maxStake);

        // Cap at 10% of capital
        const maxCapitalStake = state.capital * 0.1;
        stake = Math.min(stake, maxCapitalStake);

        // Ensure we don't go below minimum after caps
        if (stake < config.minStake) {
            LOGGER.warn(`⚠️ Capital too low for ${symbol}. Min stake: $${config.minStake}, Available: $${stake.toFixed(2)}`);
            return 0; // Return 0 to signal can't trade
        }

        return parseFloat(stake.toFixed(2));
    }

    /**
     * Get valid multiplier for asset
     */
    static getValidMultiplier(symbol) {
        const config = ASSET_CONFIGS[symbol];
        if (!config || !config.multipliers || config.multipliers.length === 0) {
            return 20; // Default fallback
        }

        // Return the lowest valid multiplier (safest for minimum stake)
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

        if (CONFIG.EMAIL_ENABLED) {
            bot.emailManager.sendSessionReport(reason);
        }

        state.session.pausedUntil = Date.now() + CONFIG.COOLDOWN_AFTER_SESSION_END;

        LOGGER.info(`⏸️ Session ended (${reason}). Paused for ${CONFIG.COOLDOWN_AFTER_SESSION_END / 60000} minutes.`);
        LOGGER.info(`📊 Session: Trades: ${state.session.tradesCount} | Wins: ${state.session.winsCount} | Losses: ${state.session.lossesCount}`);
        LOGGER.info(`💰 Net P/L: $${state.session.netPL.toFixed(2)} | Capital: $${state.capital.toFixed(2)}`);

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

        MartingaleManager.resetMartingale();

        Object.keys(state.assets).forEach(symbol => {
            state.assets[symbol].activePosition = null;
            state.assets[symbol].currentDirection = null;
        });

        LOGGER.info('🚀 NEW SESSION STARTED');
        LOGGER.info(`💰 Starting Capital: $${state.capital.toFixed(2)}`);
        LOGGER.info(`🎯 Profit Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`);
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
            profitTarget: state.session.currentProfitTarget,
            accumulatedLoss: state.session.accumulatedLoss,
            martingaleLevel: state.martingale.level,
            currentStake: state.martingale.currentStake
        };
    }
}

// ============================================
// PORTFOLIO MANAGER
// ============================================

class PortfolioManager {
    static calculateAssetScore(symbol) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];

        if (!assetState || !config) return 0;

        const recentTrades = assetState.tradeHistory.slice(-CONFIG.WIN_RATE_LOOKBACK);
        const winRate = recentTrades.length > 0
            ? recentTrades.filter(t => t.profit > 0).length / recentTrades.length
            : 0.5;

        const wpr = assetState.wpr;
        let signalQuality = 0.5;
        if (wpr <= -70 && wpr >= -90) signalQuality = 0.9;
        else if (wpr >= -30 && wpr <= -10) signalQuality = 0.9;
        else if (wpr > -70 && wpr < -30) signalQuality = 0.6;

        const volatilityFit = this.calculateVolatilityFit(symbol);
        const capacityScore = 1 - (assetState.dailyTrades / config.maxTradesPerDay);

        const score = (winRate * 0.35) +
            (signalQuality * 0.25) +
            (volatilityFit * 0.20) +
            (Math.max(0, capacityScore) * 0.20);

        return Math.min(Math.max(score, 0), 1);
    }

    static calculateVolatilityFit(symbol) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];

        if (!assetState || assetState.ticks.length < 20) return 0.5;

        const recentTicks = assetState.ticks.slice(-20);
        const returns = [];
        for (let i = 1; i < recentTicks.length; i++) {
            if (recentTicks[i - 1] !== 0) {
                returns.push((recentTicks[i] - recentTicks[i - 1]) / recentTicks[i - 1]);
            }
        }

        if (returns.length === 0) return 0.5;
        const volatility = math.std(returns) * 100;

        const expectedRanges = {
            'low': { min: 0, max: 0.3 },
            'medium-low': { min: 0.2, max: 0.5 },
            'medium': { min: 0.4, max: 0.8 },
            'medium-high': { min: 0.6, max: 1.2 },
            'high': { min: 0.8, max: 2.0 },
            'extreme': { min: 1.5, max: 4.0 }
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

    static rankAssets() {
        const rankings = [];

        Object.keys(state.assets).forEach(symbol => {
            const assetState = state.assets[symbol];

            if (Date.now() < assetState.blacklistedUntil) {
                LOGGER.debug(`⏸️ ${symbol} is blacklisted`);
                return;
            }

            const score = this.calculateAssetScore(symbol);
            assetState.score = score;

            rankings.push({ symbol, score });
        });

        rankings.sort((a, b) => b.score - a.score);

        const topAssets = rankings.slice(0, CONFIG.TOP_ASSETS_TO_TRADE);
        state.portfolio.topRankedAssets = topAssets.map(a => a.symbol);

        LOGGER.info('📊 Asset Rankings:');
        rankings.slice(0, 10).forEach((asset, index) => {
            const marker = index < CONFIG.TOP_ASSETS_TO_TRADE ? '🏆' : '  ';
            const config = ASSET_CONFIGS[asset.symbol];
            LOGGER.info(`${marker} ${index + 1}. ${asset.symbol} (${config?.category}): ${(asset.score * 100).toFixed(1)}%`);
        });

        return topAssets;
    }

    static hasCorrelationConflict(symbol, direction) {
        const config = ASSET_CONFIGS[symbol];
        if (!config || !config.correlatedWith) return false;

        return state.portfolio.activePositions.some(pos =>
            config.correlatedWith.includes(pos.symbol)
        );
    }
}

// ============================================
// RISK MANAGER
// ============================================

class RiskManager {
    static canTrade() {
        if (!SessionManager.isSessionActive()) {
            LOGGER.debug('Session not active');
            return false;
        }

        if (SessionManager.checkSessionTargets()) {
            return false;
        }

        if (state.portfolio.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) {
            LOGGER.debug('Max positions reached');
            return false;
        }

        if (state.capital < CONFIG.INITIAL_STAKE * 2) {
            LOGGER.error('Insufficient capital');
            return false;
        }

        return true;
    }

    static canAssetTrade(symbol, direction) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];

        if (!assetState || !config) {
            return { allowed: false, reason: 'Asset not configured' };
        }

        if (!state.portfolio.topRankedAssets.includes(symbol)) {
            return { allowed: false, reason: 'Not in top ranked assets' };
        }

        if (assetState.dailyTrades >= config.maxTradesPerDay) {
            return { allowed: false, reason: 'Daily trade limit reached' };
        }

        if (config.onlyDirection && config.onlyDirection !== direction) {
            return { allowed: false, reason: `Asset only allows ${config.onlyDirection}` };
        }

        if (Date.now() < assetState.blacklistedUntil) {
            return { allowed: false, reason: 'Asset blacklisted' };
        }

        if (PortfolioManager.hasCorrelationConflict(symbol, direction)) {
            return { allowed: false, reason: 'Correlation conflict' };
        }

        // Check trading hours for non-synthetic assets
        if (config.category !== 'synthetic' && !this.isWithinTradingHours(config)) {
            return { allowed: false, reason: 'Outside trading hours' };
        }

        return { allowed: true };
    }

    static isWithinTradingHours(config) {
        if (config.tradingHours === '24/7') return true;

        // For now, allow trading - implement proper hour check if needed
        const now = new Date();
        const hour = now.getUTCHours();
        const day = now.getUTCDay();

        // Basic forex check: closed on weekends
        if (config.category === 'forex' || config.category === 'commodity') {
            if (day === 0 || day === 6) {
                // Allow limited weekend hours based on typical forex times
                if (day === 0 && hour < 22) return false; // Sunday before 22:00
                if (day === 6) return false; // Saturday
            }
        }

        return true;
    }

    static recordTradeResult(symbol, profit, direction) {
        const assetState = state.assets[symbol];
        if (!assetState) return;

        state.session.tradesCount++;

        if (profit > 0) {
            MartingaleManager.recordWin(profit);
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            assetState.dailyWins++;
            assetState.consecutiveLosses = 0;

            LOGGER.trade(`✅ WIN on ${symbol}: +$${profit.toFixed(2)}`);
        } else {
            MartingaleManager.recordLoss(profit);
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            assetState.dailyLosses++;
            assetState.consecutiveLosses++;

            LOGGER.trade(`❌ LOSS on ${symbol}: -$${Math.abs(profit).toFixed(2)}`);

            if (assetState.tradeHistory.length >= CONFIG.WIN_RATE_LOOKBACK) {
                const recentWinRate = assetState.tradeHistory
                    .slice(-CONFIG.WIN_RATE_LOOKBACK)
                    .filter(t => t.profit > 0).length / CONFIG.WIN_RATE_LOOKBACK;

                if (recentWinRate < CONFIG.MIN_WIN_RATE_THRESHOLD) {
                    assetState.blacklistedUntil = Date.now() + CONFIG.BLACKLIST_PERIOD;
                    LOGGER.warn(`🚫 ${symbol} blacklisted for 24h (win rate: ${(recentWinRate * 100).toFixed(1)}%)`);
                }
            }
        }

        assetState.tradeHistory.push({
            timestamp: Date.now(),
            direction,
            profit
        });

        if (assetState.tradeHistory.length > 100) {
            assetState.tradeHistory = assetState.tradeHistory.slice(-100);
        }

        const recentTrades = assetState.tradeHistory.slice(-CONFIG.WIN_RATE_LOOKBACK);
        assetState.winRate = recentTrades.length > 0
            ? recentTrades.filter(t => t.profit > 0).length / recentTrades.length
            : 0.5;

        assetState.activePosition = null;
        assetState.currentDirection = null;
    }

    static resetDailyCounters() {
        state.portfolio.dailyProfit = 0;
        state.portfolio.dailyLoss = 0;
        state.portfolio.dailyWins = 0;
        state.portfolio.dailyLosses = 0;

        Object.keys(state.assets).forEach(symbol => {
            state.assets[symbol].dailyTrades = 0;
            state.assets[symbol].dailyWins = 0;
            state.assets[symbol].dailyLosses = 0;
        });

        LOGGER.info('📅 Daily counters reset');
    }
}

// ============================================
// EMAIL MANAGER
// ============================================

class EmailManager {
    constructor() {
        if (CONFIG.EMAIL_ENABLED) {
            this.transporter = nodemailer.createTransport(CONFIG.EMAIL_CONFIG);
        }
    }

    async sendEmail(subject, text) {
        if (!CONFIG.EMAIL_ENABLED || !this.transporter) return;

        try {
            await this.transporter.sendMail({
                from: CONFIG.EMAIL_CONFIG.auth.user,
                to: CONFIG.EMAIL_RECIPIENT,
                subject: `Deriv Multiplier Bot - ${subject}`,
                text: text
            });
            LOGGER.info(`📧 Email sent: ${subject}`);
        } catch (error) {
            LOGGER.error(`Email error: ${error.message}`);
        }
    }

    async sendSessionReport(reason) {
        const stats = SessionManager.getSessionStats();

        const text = `
SESSION ${reason === 'PROFIT_TARGET' ? 'COMPLETED ✅' : 'STOPPED ⛔'}
========================================
Reason: ${reason}
Duration: ${stats.duration}

Performance:
-----------
Trades: ${stats.trades}
Wins: ${stats.wins} | Losses: ${stats.losses}
Win Rate: ${stats.winRate}

Financials:
----------
Net P/L: $${stats.netPL.toFixed(2)}
Capital: $${state.capital.toFixed(2)}
Martingale Level: ${stats.martingaleLevel}

Assets Traded: ${Object.keys(state.assets).filter(s => state.assets[s].dailyTrades > 0).join(', ')}

Time: ${new Date().toLocaleString()}
        `;

        await this.sendEmail(`Session ${reason}`, text);
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
            LOGGER.debug(`💰 Balance: $${state.accountBalance.toFixed(2)}`);
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

        state.assets[symbol].ticks.push(tick.quote);

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
        const assetState = state.assets[symbol];

        const isNewBar = candles.length === 0 || candles[candles.length - 1].epoch !== candle.epoch;

        if (isNewBar) {
            candles.push(candle);
            assetState.lastBarTime = candle.epoch;
        } else {
            candles[candles.length - 1] = candle;
        }

        if (candles.length > CONFIG.MAX_CANDLES_STORED) {
            state.assets[symbol].candles = candles.slice(-CONFIG.MAX_CANDLES_STORED);
        }

        this.updateIndicators(symbol);

        if (isNewBar && candles.length > 2) {
            this.processSignals(symbol);
        }
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

        if (!assetState || !config) return;

        const candles = assetState.candles;

        if (candles.length < config.wprPeriod + 2) return;

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);

        assetState.prevWpr = assetState.wpr;
        assetState.wpr = TechnicalIndicators.calculateWPR(highs, lows, closes, config.wprPeriod);
    }

    processSignals(symbol) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];

        if (!assetState || !config) return;

        const signal = TechnicalIndicators.detectWPRSignal(assetState.prevWpr, assetState.wpr);

        if (!signal) return;

        LOGGER.signal(`${symbol} WPR Signal: ${signal} (WPR: ${assetState.wpr.toFixed(2)} from ${assetState.prevWpr.toFixed(2)})`);

        // Check if we need to flip position
        if (assetState.activePosition) {
            if (assetState.currentDirection !== signal) {
                LOGGER.info(`🔄 ${symbol}: Signal flip detected - closing ${assetState.currentDirection}, opening ${signal}`);
                bot.flipPosition(symbol, signal);
            }
            return;
        }

        assetState.lastSignal = {
            direction: signal,
            wpr: assetState.wpr,
            timestamp: Date.now()
        };

        bot.executeTrade(symbol, signal);
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);

            // Parse error for useful info
            const errorMsg = response.error.message || '';

            // Extract valid multipliers from error message if present
            const multiplierMatch = errorMsg.match(/Accepts\s+([\d,\s]+)/);
            if (multiplierMatch) {
                const validMultipliers = multiplierMatch[1].split(',').map(m => parseInt(m.trim()));
                const symbol = response.echo_req?.parameters?.symbol;
                if (symbol && ASSET_CONFIGS[symbol]) {
                    LOGGER.warn(`📋 Updating ${symbol} multipliers to: [${validMultipliers.join(', ')}]`);
                    ASSET_CONFIGS[symbol].multipliers = validMultipliers;
                    ASSET_CONFIGS[symbol].defaultMultiplier = validMultipliers[0];
                }
            }

            // Extract minimum stake from error if present
            const stakeMatch = errorMsg.match(/equal to or higher than\s+([\d.]+)/);
            if (stakeMatch) {
                const minStake = parseFloat(stakeMatch[1]);
                const symbol = response.echo_req?.parameters?.symbol;
                if (symbol && ASSET_CONFIGS[symbol]) {
                    LOGGER.warn(`📋 Updating ${symbol} minStake to: $${minStake}`);
                    ASSET_CONFIGS[symbol].minStake = minStake;
                }
            }

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

            if (state.assets[position.symbol]) {
                state.assets[position.symbol].activePosition = null;
                state.assets[position.symbol].currentDirection = null;
            }

            if (position.pendingFlipTo) {
                bot.executeTrade(position.symbol, position.pendingFlipTo);
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
            state.portfolio.activePositions[posIndex].currentProfit = contract.profit;
            state.portfolio.activePositions[posIndex].currentPrice = contract.current_spot;
        }
    }

    onError(error) {
        LOGGER.error(`WebSocket error: ${error.message}`);
    }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            LOGGER.info(`🔄 Reconnecting in ${this.reconnectDelay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
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

    sendAsync(data) {
        return new Promise((resolve, reject) => {
            const reqId = this.send(data);
            if (!reqId) {
                reject(new Error('Not connected'));
                return;
            }

            state.pendingRequests.set(reqId, { resolve, reject });

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

class DerivMultiplierBot {
    constructor() {
        this.connection = new ConnectionManager();
        this.emailManager = new EmailManager();
        this.scoringInterval = null;
        this.dailyResetInterval = null;
    }

    async start() {
        console.log('\n' + '═'.repeat(70));
        console.log('         DERIV MULTIPLIER BOT v4.1');
        console.log('         Multi-Asset MT5-Style Trading');
        console.log('═'.repeat(70));
        console.log(`💰 Initial Capital: $${state.capital}`);
        console.log(`📊 Active Assets: ${ACTIVE_ASSETS.length} (${ACTIVE_ASSETS.join(', ')})`);
        console.log(`🎯 Session Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`);
        console.log(`📈 Martingale: ${CONFIG.MARTINGALE_MULTIPLIER}x after ${CONFIG.LOSSES_BEFORE_MARTINGALE} loss(es)`);
        console.log('═'.repeat(70) + '\n');

        this.connection.send({ balance: 1, subscribe: 1 });

        await this.subscribeToAssets();

        PortfolioManager.rankAssets();

        this.scoringInterval = setInterval(() => {
            LOGGER.info('🔄 Recalculating asset scores...');
            PortfolioManager.rankAssets();
        }, CONFIG.ASSET_SCORING_INTERVAL);

        this.scheduleDailyReset();

        SessionManager.startNewSession();

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
                granularity: 60,
                style: 'candles'
            });

            this.connection.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: 1,
                end: 'latest',
                granularity: 60,
                style: 'candles',
                subscribe: 1
            });

            this.connection.send({
                ticks: symbol,
                subscribe: 1
            });

            LOGGER.info(`📡 Subscribed to ${config.name} (${symbol}) [${config.category}]`);

            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    executeTrade(symbol, direction) {
        if (!RiskManager.canTrade()) {
            return;
        }

        const assetCheck = RiskManager.canAssetTrade(symbol, direction);
        if (!assetCheck.allowed) {
            LOGGER.debug(`Trade blocked: ${assetCheck.reason}`);
            return;
        }

        const config = ASSET_CONFIGS[symbol];
        const assetState = state.assets[symbol];

        if (!config || !assetState) return;

        const stake = MartingaleManager.getSafeStake(symbol);

        if (stake <= 0) {
            LOGGER.error(`Cannot trade ${symbol}: Stake below minimum ($${config.minStake} required)`);
            return;
        }

        // Validate stake meets minimum
        if (stake < config.minStake) {
            LOGGER.error(`Cannot trade ${symbol}: Stake $${stake} below minimum $${config.minStake}`);
            return;
        }

        const contractType = direction === 'UP' ? 'MULTUP' : 'MULTDOWN';

        // Get valid multiplier for this asset
        const multiplier = MartingaleManager.getValidMultiplier(symbol);

        // Validate multiplier is in allowed list
        if (!config.multipliers.includes(multiplier)) {
            LOGGER.error(`Invalid multiplier ${multiplier} for ${symbol}. Allowed: ${config.multipliers.join(', ')}`);
            return;
        }

        LOGGER.trade(`🎯 Opening ${direction} on ${config.name} (${symbol})`);
        LOGGER.trade(`   Type: ${contractType} | Stake: $${stake.toFixed(2)} | Multiplier: x${multiplier}`);
        LOGGER.trade(`   Min Stake: $${config.minStake} | Valid Multis: [${config.multipliers.join(',')}]`);
        LOGGER.trade(`   Category: ${config.category} | Martingale Level: ${state.martingale.level}`);

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
            pendingFlipTo: null
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

        if (CONFIG.USE_STOP_LOSS) {
            tradeRequest.parameters.limit_order = tradeRequest.parameters.limit_order || {};
            tradeRequest.parameters.limit_order.stop_loss = stake * (CONFIG.STOP_LOSS_PERCENT / 100);
        }

        if (CONFIG.USE_TAKE_PROFIT) {
            tradeRequest.parameters.limit_order = tradeRequest.parameters.limit_order || {};
            tradeRequest.parameters.limit_order.take_profit = stake * (CONFIG.TAKE_PROFIT_PERCENT / 100);
        }

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;

        assetState.dailyTrades++;
        assetState.currentDirection = direction;

        LOGGER.trade(`📤 Trade request sent (reqId: ${reqId})`);
    }

    async flipPosition(symbol, newDirection) {
        const assetState = state.assets[symbol];
        if (!assetState) return;

        const position = assetState.activePosition;

        if (!position || !position.contractId) {
            LOGGER.warn(`No active position to flip on ${symbol}`);
            this.executeTrade(symbol, newDirection);
            return;
        }

        LOGGER.trade(`🔄 Flipping position on ${symbol}: ${position.direction} → ${newDirection}`);

        position.pendingFlipTo = newDirection;

        this.connection.send({
            sell: position.contractId,
            price: 0
        });
    }

    async closeAllPositions() {
        LOGGER.info('🔒 Closing all positions...');

        for (const position of state.portfolio.activePositions) {
            if (position.contractId) {
                this.connection.send({
                    sell: position.contractId,
                    price: 0
                });
                LOGGER.info(`Closing position: ${position.symbol} ${position.direction}`);
            }
        }
    }

    closePosition(symbol) {
        const assetState = state.assets[symbol];
        if (!assetState) return;

        const position = assetState.activePosition;

        if (!position || !position.contractId) {
            LOGGER.warn(`No active position on ${symbol}`);
            return;
        }

        LOGGER.trade(`🔒 Manually closing position on ${symbol}`);

        this.connection.send({
            sell: position.contractId,
            price: 0
        });
    }

    scheduleDailyReset() {
        const now = new Date();
        const midnight = new Date(now);
        midnight.setUTCHours(24, 0, 0, 0);

        const msUntilMidnight = midnight - now;

        setTimeout(() => {
            RiskManager.resetDailyCounters();
            this.scheduleDailyReset();
        }, msUntilMidnight);

        LOGGER.info(`📅 Daily reset in ${(msUntilMidnight / 3600000).toFixed(1)} hours`);
    }

    stop() {
        LOGGER.info('🛑 Stopping bot...');

        if (this.scoringInterval) clearInterval(this.scoringInterval);

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

        // Group assets by category
        const assetsByCategory = {};
        Object.entries(state.assets).forEach(([symbol, data]) => {
            const config = ASSET_CONFIGS[symbol];
            if (!config) return;

            const category = config.category;
            if (!assetsByCategory[category]) {
                assetsByCategory[category] = [];
            }
            assetsByCategory[category].push({
                symbol,
                name: config.name,
                score: (data.score * 100).toFixed(1) + '%',
                winRate: (data.winRate * 100).toFixed(1) + '%',
                wpr: data.wpr.toFixed(1),
                dailyTrades: data.dailyTrades,
                direction: data.currentDirection || '-',
                multiplier: config.defaultMultiplier
            });
        });

        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            accountBalance: state.accountBalance,
            session: sessionStats,
            martingale: {
                level: state.martingale.level,
                stake: state.martingale.currentStake,
                consecutiveLosses: state.martingale.consecutiveLosses
            },
            activePositionsCount: state.portfolio.activePositions.length,
            activePositions: state.portfolio.activePositions.map(pos => {
                const config = ASSET_CONFIGS[pos.symbol];
                return {
                    symbol: pos.symbol,
                    name: config?.name || pos.symbol,
                    category: config?.category || 'unknown',
                    direction: pos.direction,
                    stake: pos.stake,
                    multiplier: pos.multiplier,
                    profit: pos.currentProfit,
                    contractId: pos.contractId,
                    duration: Math.floor((Date.now() - pos.entryTime) / 1000)
                };
            }),
            topAssets: state.portfolio.topRankedAssets,
            assetsByCategory,
            assetStats: Object.entries(state.assets).map(([symbol, data]) => {
                const config = ASSET_CONFIGS[symbol];
                return {
                    symbol,
                    name: config?.name || symbol,
                    category: config?.category || 'unknown',
                    score: (data.score * 100).toFixed(1) + '%',
                    winRate: (data.winRate * 100).toFixed(1) + '%',
                    wpr: data.wpr.toFixed(1),
                    dailyTrades: data.dailyTrades,
                    direction: data.currentDirection || '-'
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
        const status = bot.getStatus();
        const session = status.session;

        console.log('\n' + '╔' + '═'.repeat(78) + '╗');
        console.log('║' + '     DERIV MULTIPLIER BOT v4.1 - MULTI-ASSET MT5 STYLE'.padEnd(78) + '║');
        console.log('╠' + '═'.repeat(78) + '╣');

        const netPLColor = session.netPL >= 0 ? '\x1b[32m' : '\x1b[31m';
        const resetColor = '\x1b[0m';

        console.log(`║ 💰 Capital: $${status.capital.toFixed(2).padEnd(12)} 🏦 Account: $${status.accountBalance.toFixed(2).padEnd(12)}              ║`);
        console.log(`║ 📊 Session: ${session.duration.padEnd(10)} Trades: ${session.trades.toString().padEnd(5)} WR: ${session.winRate.padEnd(8)}                ║`);
        console.log(`║ 💹 Net P/L: ${netPLColor}$${session.netPL.toFixed(2).padEnd(10)}${resetColor} Target: $${session.profitTarget.toFixed(2).padEnd(10)}                       ║`);

        const mgColor = status.martingale.level > 0 ? '\x1b[33m' : '\x1b[32m';
        console.log(`║ 📈 Martingale: ${mgColor}Lvl ${status.martingale.level}${resetColor} | Stake: $${status.martingale.stake.toFixed(2)} | Consec Losses: ${status.martingale.consecutiveLosses}`.padEnd(87) + '║');

        if (session.accumulatedLoss > 0) {
            console.log(`║ ⚠️  Accumulated Loss: $${session.accumulatedLoss.toFixed(2)} (recovering...)`.padEnd(79) + '║');
        }

        console.log('╠' + '═'.repeat(78) + '╣');

        // Active Positions
        if (status.activePositions.length > 0) {
            console.log('║ 🚀 ACTIVE POSITIONS:'.padEnd(79) + '║');
            console.log('║ Symbol       | Category  | Dir  | Stake   | Multi | Profit  | Duration'.padEnd(79) + '║');
            console.log('║' + '-'.repeat(78) + '║');

            status.activePositions.forEach(pos => {
                const profitColor = pos.profit >= 0 ? '\x1b[32m' : '\x1b[31m';
                const profitStr = pos.profit >= 0 ? `+${pos.profit.toFixed(2)}` : pos.profit.toFixed(2);
                console.log(`║ ${pos.symbol.padEnd(12)} | ${pos.category.padEnd(9)} | ${pos.direction.padEnd(4)} | $${pos.stake.toFixed(2).padEnd(6)} | x${pos.multiplier.toString().padEnd(3)} | ${profitColor}${profitStr.padEnd(7)}${resetColor} | ${pos.duration}s`.padEnd(87) + '║');
            });
            console.log('╠' + '═'.repeat(78) + '╣');
        }

        // Top Assets
        console.log('║ 🏆 TOP ASSETS: ' + status.topAssets.slice(0, 5).join(', ').padEnd(63) + '║');
        console.log('╠' + '═'.repeat(78) + '╣');

        // Asset Stats by Category
        const categories = ['synthetic', 'forex', 'crypto', 'commodity'];
        categories.forEach(cat => {
            const assets = status.assetStats.filter(a => a.category === cat);
            if (assets.length > 0) {
                console.log(`║ 📁 ${cat.toUpperCase()}:`.padEnd(79) + '║');
                assets.slice(0, 4).forEach(stat => {
                    const isTop = status.topAssets.includes(stat.symbol);
                    const marker = isTop ? '🏆' : '  ';
                    console.log(`║${marker}${stat.symbol.padEnd(12)} | Scr:${stat.score.padEnd(6)} | WR:${stat.winRate.padEnd(6)} | WPR:${stat.wpr.padEnd(6)} | Trd:${stat.dailyTrades} | ${stat.direction.padEnd(4)} ║`);
                });
            }
        });

        console.log('╚' + '═'.repeat(78) + '╝');
        console.log(`⏰ ${new Date().toLocaleTimeString()} | Active: ${ACTIVE_ASSETS.length} assets | Ctrl+C to stop\n`);
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

const bot = new DerivMultiplierBot();

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
    console.log('═'.repeat(78));
    console.log('         DERIV MULTIPLIER BOT v4.1');
    console.log('         Multi-Asset MT5-Style Trading');
    console.log('═'.repeat(78));
    console.log('\n⚠️  API Token not configured!\n');
    console.log('To run this bot:');
    console.log('  API_TOKEN=your_token node deriv-multiplier-bot.js');
    console.log('\nEnvironment variables:');
    console.log('  CAPITAL        - Initial capital (default: 500)');
    console.log('  STAKE          - Initial stake (default: 1)');
    console.log('  PROFIT_TARGET  - Session profit target (default: 50)');
    console.log('  STOP_LOSS      - Session stop loss (default: -25)');
    console.log('  MARTINGALE     - Martingale multiplier (default: 2)');
    console.log('  N_LOSSES       - Losses before martingale (default: 1)');
    console.log('  ASSETS         - Comma-separated asset list (default: R_50,R_75,...)');
    console.log('  DEBUG          - Enable debug mode (default: false)');
    console.log('\nExample:');
    console.log('  API_TOKEN=xxx ASSETS=R_75,R_100,frxEURUSD,cryBTCUSD node deriv-multiplier-bot.js\n');
    console.log('\nAvailable Assets:');
    console.log('  Synthetic: R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V');
    console.log('            BOOM1000,CRASH1000,JD10,JD25,JD50,JD75,JD100,stpRNG');
    console.log('  Forex:    frxEURUSD,frxGBPUSD,frxUSDJPY,frxAUDUSD,frxUSDCAD,frxEURGBP,frxNZDUSD');
    console.log('  Crypto:   cryBTCUSD,cryETHUSD,cryLTCUSD,cryBNBUSD');
    console.log('  Commodity:frxXAUUSD,frxXAGUSD,frxXPTUSD,frxXPDUSD,WLDOIL,frxBROUSD');
    console.log('═'.repeat(78));
    process.exit(1);
}

// Start
console.log('═'.repeat(78));
console.log('         DERIV MULTIPLIER BOT v4.1');
console.log('═'.repeat(78));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

setTimeout(() => {
    Dashboard.startLiveUpdates();
}, 3000);

// Export
module.exports = {
    DerivMultiplierBot,
    TechnicalIndicators,
    MartingaleManager,
    SessionManager,
    PortfolioManager,
    RiskManager,
    CONFIG,
    ASSET_CONFIGS,
    ASSET_GROUPS,
    ACTIVE_ASSETS,
    state
};
