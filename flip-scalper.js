#!/usr/bin/env node
/**
 * Deriv Quick Flip Scalper Bot v1.0
 * Multi-Asset Liquidity Trap & Reversal Strategy
 * 
 * STRATEGY OVERVIEW:
 * ==================
 * 1. At Market Open, identify the first 15-minute "Liquidity Candle"
 * 2. Validate: Candle Range >= 25% of Daily ATR
 * 3. Create a "Trap Box" using High/Low of liquidity candle
 * 4. Direction Bias:
 *    - GREEN candle (bullish) → Expect fake-out UP → Look to SHORT
 *    - RED candle (bearish) → Expect fake-out DOWN → Look to LONG
 * 5. Hunt for reversal patterns on 5-minute chart within 90 minutes
 * 6. Exit at opposite side of the Trap Box
 * 
 * Dependencies: npm install ws
 * Usage: API_TOKEN=your_token node deriv-quickflip-bot.js
 */

const WebSocket = require('ws');
const nodemailer = require('nodemailer');

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
    // API Settings
    API_TOKEN: process.env.API_TOKEN || '0P94g4WdSrSrzir',
    APP_ID: process.env.APP_ID || '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Trading Assets (Multi-Asset Support)
    ASSETS: (process.env.ASSETS || 'R_75', 'R_100', 'frxGBPUSD', 'frxUSDJPY', 'frxXAUUSD').split(','),

    // Capital & Risk 
    INITIAL_CAPITAL: parseFloat(process.env.CAPITAL) || 500,
    STAKE: parseFloat(process.env.STAKE) || 1.00,
    MULTIPLIER: parseInt(process.env.MULT) || 200,

    // Session Targets
    SESSION_PROFIT_TARGET: parseFloat(process.env.PROFIT_TARGET) || 50,
    SESSION_STOP_LOSS: parseFloat(process.env.STOP_LOSS) || -100,

    // Market Timing (GMT/UTC)
    // For synthetics, we can use any time as they run 24/7
    // Format: "HH:MM" in UTC
    MARKET_OPEN_TIME: process.env.MARKET_OPEN || '08:00',

    // Strategy Settings
    ATR_PERIOD: 14,                      // Daily ATR period
    ATR_LOOKBACK: 15,                    // Days to fetch for ATR
    LIQUIDITY_CANDLE_MINUTES: 15,        // First candle duration
    HUNTING_TIMEFRAME_MINUTES: 5,        // Entry candle timeframe
    HUNTING_DURATION_MINUTES: 90,        // How long to hunt after open
    MIN_ATR_RATIO: 0.25,                 // Minimum Range/ATR ratio (25%)

    // Reversal Pattern Settings
    HAMMER_BODY_RATIO: 0.33,             // Max body size vs total range
    HAMMER_WICK_RATIO: 2.0,              // Min wick size vs body

    // Multiplier Settings (per asset)
    ASSET_MULTIPLIERS: {
        'R_10': 1000,
        'R_25': 400,
        'R_50': 200,
        'R_75': 100,
        'R_100': 100,
        '1HZ10V': 1000,
        '1HZ25V': 400,
        '1HZ50V': 200,
        '1HZ75V': 100,
        '1HZ100V': 100,
        'frxEURUSD': 100,
        'frxGBPUSD': 100,
        'frxUSDJPY': 100,
        'frxXAUUSD': 100,
        'cryBTCUSD': 100
    },

    // Performance
    KEEP_ALIVE_INTERVAL: 25000,          // 25 seconds (Deriv requires <30s)
    DASHBOARD_UPDATE_INTERVAL: 5000,

    // Debug
    DEBUG_MODE: process.env.DEBUG === 'true' || false
};

// ============================================
// LOGGER UTILITY
// ============================================

// Helper function to get GMT time string
const getGMTTimeString = () => {
    const now = new Date();
    return now.toISOString(); // Already in UTC/GMT
};

const LOGGER = {
    info: (msg) => console.log(`[INFO] ${getGMTTimeString()} - ${msg}`),
    trade: (msg) => console.log(`\x1b[32m[TRADE] ${getGMTTimeString()} - ${msg}\x1b[0m`),
    signal: (msg) => console.log(`\x1b[36m[SIGNAL] ${getGMTTimeString()} - ${msg}\x1b[0m`),
    box: (msg) => console.log(`\x1b[35m[BOX] ${getGMTTimeString()} - ${msg}\x1b[0m`),
    pattern: (msg) => console.log(`\x1b[33m[PATTERN] ${getGMTTimeString()} - ${msg}\x1b[0m`),
    warn: (msg) => console.warn(`\x1b[33m[WARN] ${getGMTTimeString()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${getGMTTimeString()} - ${msg}\x1b[0m`),
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTimeString()} - ${msg}\x1b[0m`); }
};

// ============================================
// ASSET CONFIGURATION
// ============================================

const ASSET_CONFIGS = {
    'R_10': { name: 'Volatility 10 Index', minStake: 0.35, maxStake: 2000, multipliers: [20, 40, 60, 80, 100] },
    'R_25': { name: 'Volatility 25 Index', minStake: 0.35, maxStake: 2000, multipliers: [20, 40, 60, 80, 100] },
    'R_50': { name: 'Volatility 50 Index', minStake: 0.50, maxStake: 2000, multipliers: [80, 200, 400, 600, 800] },
    'R_75': { name: 'Volatility 75 Index', minStake: 1.00, maxStake: 3000, multipliers: [20, 40, 60, 80, 100, 200, 300, 400, 500] },
    'R_100': { name: 'Volatility 100 Index', minStake: 1.00, maxStake: 3000, multipliers: [20, 40, 60, 80, 100, 200, 300, 400, 500] },
    '1HZ10V': { name: 'Volatility 10 (1s) Index', minStake: 0.35, maxStake: 1000, multipliers: [20, 40, 60, 80, 100, 200, 300] },
    '1HZ25V': { name: 'Volatility 25 (1s) Index', minStake: 0.35, maxStake: 1000, multipliers: [20, 40, 60, 80, 100, 200, 300] },
    '1HZ50V': { name: 'Volatility 50 (1s) Index', minStake: 0.50, maxStake: 1000, multipliers: [80, 200, 400, 600, 800] },
    '1HZ75V': { name: 'Volatility 75 (1s) Index', minStake: 0.50, maxStake: 1500, multipliers: [20, 40, 60, 80, 100, 200, 300, 400, 500] },
    '1HZ100V': { name: 'Volatility 100 (1s) Index', minStake: 0.50, maxStake: 1500, multipliers: [20, 40, 60, 80, 100, 200, 300, 400, 500] }
};

// ============================================
// STATE MANAGEMENT
// ============================================

const state = {
    // Account
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,

    // Connection
    isConnected: false,
    isAuthorized: false,

    // Per-Asset State
    assets: {},

    // Session
    session: {
        profit: 0,
        loss: 0,
        netPL: 0,
        tradesCount: 0,
        winsCount: 0,
        lossesCount: 0,
        startTime: Date.now()
    },

    // Active Positions
    activePositions: [],

    // Request tracking
    pendingRequests: new Map(),
    requestId: 1
};

// Initialize per-asset state
function initializeAssetStates() {
    CONFIG.ASSETS.forEach(symbol => {
        if (ASSET_CONFIGS[symbol]) {
            state.assets[symbol] = {
                // ATR Data
                dailyCandles: [],
                dailyATR: 0,
                atrCalculated: false,

                // Liquidity Candle / Trap Box
                liquidityCandle: null,
                trapBox: {
                    active: false,
                    high: 0,
                    low: 0,
                    direction: null,    // 'LONG' or 'SHORT'
                    validUntil: 0,
                    range: 0
                },

                // Hunting Phase
                huntingActive: false,
                huntingStartTime: 0,
                fiveMinCandles: [],
                breakoutDetected: false,

                // Current State
                currentPrice: 0,
                phase: 'WAITING',       // WAITING, ATR_CALC, LIQUIDITY_WATCH, HUNTING, TRADING, COOLDOWN

                // Position
                activePosition: null,

                // Stats
                dailyTrades: 0,
                dailyWins: 0,
                dailyLosses: 0
            };

            LOGGER.info(`Initialized ${ASSET_CONFIGS[symbol].name} (${symbol})`);
        } else {
            LOGGER.warn(`Unknown asset: ${symbol}`);
        }
    });
}

// ============================================
// TECHNICAL ANALYSIS
// ============================================

class TechnicalAnalysis {
    /**
     * Calculate True Range for a candle
     */
    static calculateTrueRange(high, low, prevClose) {
        if (prevClose === null || prevClose === undefined) {
            return high - low;
        }

        return Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
    }

    /**
     * Calculate ATR from daily candles
     */
    static calculateATR(candles, period = 14) {
        if (candles.length < period + 1) {
            LOGGER.warn(`Not enough candles for ATR. Need ${period + 1}, have ${candles.length}`);
            return 0;
        }

        const trueRanges = [];

        for (let i = 1; i < candles.length; i++) {
            const tr = this.calculateTrueRange(
                candles[i].high,
                candles[i].low,
                candles[i - 1].close
            );
            trueRanges.push(tr);
        }

        // Calculate initial SMA
        let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

        // Wilder's smoothing for remaining values
        for (let i = period; i < trueRanges.length; i++) {
            atr = ((atr * (period - 1)) + trueRanges[i]) / period;
        }

        return atr;
    }

    /**
     * Detect Hammer pattern (bullish reversal)
     * - Small body at top
     * - Long lower wick (at least 2x body)
     * - Little to no upper wick
     */
    static isHammer(candle) {
        const body = Math.abs(candle.close - candle.open);
        const range = candle.high - candle.low;
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;

        if (range === 0) return false;

        const bodyRatio = body / range;
        const lowerWickRatio = body > 0 ? lowerWick / body : 0;

        // Hammer: Small body, long lower wick, small upper wick
        const isHammer = (
            bodyRatio <= CONFIG.HAMMER_BODY_RATIO &&
            lowerWickRatio >= CONFIG.HAMMER_WICK_RATIO &&
            upperWick < body * 0.5
        );

        if (isHammer) {
            LOGGER.pattern(`Hammer detected: Body=${body.toFixed(5)}, LowerWick=${lowerWick.toFixed(5)}, Ratio=${lowerWickRatio.toFixed(2)}`);
        }

        return isHammer;
    }

    /**
     * Detect Shooting Star / Inverted Hammer pattern (bearish reversal)
     * - Small body at bottom
     * - Long upper wick (at least 2x body)
     * - Little to no lower wick
     */
    static isShootingStar(candle) {
        const body = Math.abs(candle.close - candle.open);
        const range = candle.high - candle.low;
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;

        if (range === 0) return false;

        const bodyRatio = body / range;
        const upperWickRatio = body > 0 ? upperWick / body : 0;

        // Shooting Star: Small body, long upper wick, small lower wick
        const isShootingStar = (
            bodyRatio <= CONFIG.HAMMER_BODY_RATIO &&
            upperWickRatio >= CONFIG.HAMMER_WICK_RATIO &&
            lowerWick < body * 0.5
        );

        if (isShootingStar) {
            LOGGER.pattern(`Shooting Star detected: Body=${body.toFixed(5)}, UpperWick=${upperWick.toFixed(5)}, Ratio=${upperWickRatio.toFixed(2)}`);
        }

        return isShootingStar;
    }

    /**
     * Check if candle is bullish (green)
     */
    static isBullish(candle) {
        return candle.close > candle.open;
    }

    /**
     * Check if candle is bearish (red)
     */
    static isBearish(candle) {
        return candle.close < candle.open;
    }
}

// ============================================
// QUICK FLIP SCALPER BOT
// ============================================

class QuickFlipBot {
    constructor() {
        this.ws = null;
        this.keepAliveInterval = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.marketOpenCheckInterval = null;
        this.endOfDay = false;
        this.isWinTrade = false;
        this.Pause = false;

        // Email Configuration (same as kInspired.js)
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };
        this.emailRecipient = 'kenotaru@gmail.com';
        this.startEmailTimer();
    }

    // ============================================
    // CONNECTION MANAGEMENT
    // ============================================

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

        // Start keep-alive
        this.startKeepAlive();

        // Authorize
        this.send({ authorize: CONFIG.API_TOKEN });
    }

    onMessage(data) {
        try {
            const response = JSON.parse(data);
            this.handleResponse(response);
        } catch (error) {
            LOGGER.error(`Parse error: ${error.message}`);
        }
    }

    handleResponse(response) {
        // Authorization
        if (response.msg_type === 'authorize') {
            if (response.error) {
                LOGGER.error(`Auth failed: ${response.error.message}`);
                return;
            }
            LOGGER.info('🔐 Authorized successfully');
            LOGGER.info(`👤 Account: ${response.authorize.loginid}`);
            LOGGER.info(`💰 Balance: $${response.authorize.balance}`);
            state.isAuthorized = true;
            state.accountBalance = response.authorize.balance;

            this.start();
        }

        // Tick data
        if (response.msg_type === 'tick') {
            this.handleTick(response.tick);
        }

        // OHLC data
        if (response.msg_type === 'ohlc') {
            this.handleOHLC(response.ohlc);
        }

        // Candles history
        if (response.msg_type === 'candles') {
            this.handleCandlesHistory(response);
        }

        // Buy response
        if (response.msg_type === 'buy') {
            this.handleBuyResponse(response);
        }

        // Sell response
        if (response.msg_type === 'sell') {
            this.handleSellResponse(response);
        }

        // Contract updates
        if (response.msg_type === 'proposal_open_contract') {
            this.handleContractUpdate(response);
        }

        // Balance updates
        if (response.msg_type === 'balance') {
            state.accountBalance = response.balance.balance;
        }

        // Ping response (keep-alive)
        if (response.msg_type === 'ping') {
            LOGGER.debug('Ping acknowledged');
        }

        // Pending requests
        if (response.req_id && state.pendingRequests.has(response.req_id)) {
            const { resolve } = state.pendingRequests.get(response.req_id);
            state.pendingRequests.delete(response.req_id);
            resolve(response);
        }
    }

    onError(error) {
        LOGGER.error(`WebSocket error: ${error.message}`);
    }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;

        this.stopKeepAlive();

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            LOGGER.info(`🔄 Reconnecting in 5s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), 5000);
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

    // ============================================
    // KEEP-ALIVE
    // ============================================

    startKeepAlive() {
        this.stopKeepAlive();

        this.keepAliveInterval = setInterval(() => {
            if (state.isConnected) {
                this.send({ ping: 1 });
                LOGGER.debug('Keep-alive ping sent');
            }
        }, CONFIG.KEEP_ALIVE_INTERVAL);

        LOGGER.info(`🏓 Keep-alive started (every ${CONFIG.KEEP_ALIVE_INTERVAL / 1000}s)`);
    }

    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    // ============================================
    // BOT STARTUP
    // ============================================

    async start() {
        console.log('\n' + '═'.repeat(70));
        console.log('         DERIV QUICK FLIP SCALPER BOT v1.0');
        console.log('         Liquidity Trap & Reversal Strategy');
        console.log('═'.repeat(70));
        console.log(`💰 Capital: $${state.capital}`);
        console.log(`📊 Assets: ${CONFIG.ASSETS.join(', ')}`);
        console.log(`⏰ Market Open: ${CONFIG.MARKET_OPEN_TIME} UTC`);
        console.log(`📏 ATR Period: ${CONFIG.ATR_PERIOD} days`);
        console.log(`🎯 Liquidity Candle: ${CONFIG.LIQUIDITY_CANDLE_MINUTES}m`);
        console.log(`🔍 Hunting Timeframe: ${CONFIG.HUNTING_TIMEFRAME_MINUTES}m`);
        console.log(`⏱️  Hunting Duration: ${CONFIG.HUNTING_DURATION_MINUTES}m after open`);
        console.log('═'.repeat(70) + '\n');

        // Initialize asset states
        initializeAssetStates();

        // Subscribe to balance updates
        this.send({ balance: 1, subscribe: 1 });

        // Fetch daily ATR for each asset
        await this.fetchDailyATR();

        // Subscribe to real-time data
        await this.subscribeToAssets();

        // Start market open monitoring
        this.startMarketOpenMonitor();

        // Start GMT-based time management for disconnect/reconnect
        this.checkTimeForDisconnectReconnect();

        // Start dashboard
        this.startDashboard();

        LOGGER.info('✅ Bot started successfully!');
        LOGGER.info(`⏰ All times are in GMT/UTC for consistency`);
    }

    // ============================================
    // DAILY ATR CALCULATION
    // ============================================

    async fetchDailyATR() {
        LOGGER.info('📊 Fetching daily candles for ATR calculation...');

        for (const symbol of CONFIG.ASSETS) {
            if (!state.assets[symbol]) continue;

            state.assets[symbol].phase = 'ATR_CALC';

            // Fetch daily candles (86400 = 1 day in seconds)
            this.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: CONFIG.ATR_LOOKBACK,
                end: 'latest',
                granularity: 86400,  // Daily candles
                style: 'candles'
            });

            // Small delay between requests
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    // ============================================
    // ASSET SUBSCRIPTIONS
    // ============================================

    async subscribeToAssets() {
        LOGGER.info('📡 Subscribing to asset data...');

        for (const symbol of CONFIG.ASSETS) {
            if (!state.assets[symbol]) continue;

            // Subscribe to 15-minute candles (900 seconds) for liquidity candle
            this.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: 1,
                end: 'latest',
                granularity: CONFIG.LIQUIDITY_CANDLE_MINUTES * 60,
                style: 'candles',
                subscribe: 1
            });

            // Subscribe to 5-minute candles (300 seconds) for hunting phase
            this.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: 10,
                end: 'latest',
                granularity: CONFIG.HUNTING_TIMEFRAME_MINUTES * 60,
                style: 'candles',
                subscribe: 1
            });

            // Subscribe to ticks for real-time price
            this.send({
                ticks: symbol,
                subscribe: 1
            });

            LOGGER.info(`📡 Subscribed to ${ASSET_CONFIGS[symbol]?.name || symbol}`);

            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    // ============================================
    // MARKET OPEN MONITORING
    // ============================================

    startMarketOpenMonitor() {
        // Check every minute for market open
        this.marketOpenCheckInterval = setInterval(() => {
            this.checkMarketOpen();
        }, 60000);

        // Also check immediately
        this.checkMarketOpen();

        LOGGER.info(`⏰ Market open monitor started (watching for ${CONFIG.MARKET_OPEN_TIME} UTC)`);
    }

    checkMarketOpen() {
        const now = new Date();
        const [openHour, openMin] = CONFIG.MARKET_OPEN_TIME.split(':').map(Number);

        const currentHour = now.getUTCHours();
        const currentMin = now.getUTCMinutes();

        // Check if we're at market open time (within 1 minute)
        if (currentHour === openHour && currentMin === openMin) {
            LOGGER.signal('🔔 MARKET OPEN DETECTED!');

            // Start liquidity candle watch for each asset
            for (const symbol of CONFIG.ASSETS) {
                if (state.assets[symbol] && state.assets[symbol].phase !== 'LIQUIDITY_WATCH') {
                    this.startLiquidityWatch(symbol);
                }
            }
        }
    }

    startLiquidityWatch(symbol) {
        const assetState = state.assets[symbol];
        if (!assetState || !assetState.atrCalculated) {
            LOGGER.warn(`${symbol}: Cannot start liquidity watch - ATR not calculated`);
            return;
        }

        assetState.phase = 'LIQUIDITY_WATCH';
        assetState.liquidityCandle = null;
        assetState.trapBox.active = false;

        LOGGER.info(`${symbol}: 📊 Watching for ${CONFIG.LIQUIDITY_CANDLE_MINUTES}-minute liquidity candle...`);
    }

    // ============================================
    // DATA HANDLERS
    // ============================================

    handleTick(tick) {
        const symbol = tick.symbol;
        if (!state.assets[symbol]) return;

        const assetState = state.assets[symbol];
        assetState.currentPrice = tick.quote;

        // Check for take profit on active positions
        this.checkTakeProfit(symbol, tick.quote);
    }

    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        if (!state.assets[symbol]) return;

        const assetState = state.assets[symbol];
        const granularity = ohlc.granularity;

        const candle = {
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close),
            epoch: ohlc.epoch,
            granularity: granularity
        };

        // Handle 15-minute candles (liquidity candle)
        if (granularity === CONFIG.LIQUIDITY_CANDLE_MINUTES * 60) {
            this.handleLiquidityCandle(symbol, candle, ohlc.open_time !== ohlc.epoch);
        }

        // Handle 5-minute candles (hunting phase)
        if (granularity === CONFIG.HUNTING_TIMEFRAME_MINUTES * 60) {
            this.handleHuntingCandle(symbol, candle, ohlc.open_time !== ohlc.epoch);
        }
    }

    handleCandlesHistory(response) {
        if (response.error) {
            LOGGER.error(`Candles error: ${response.error.message}`);
            return;
        }

        const symbol = response.echo_req.ticks_history;
        const granularity = response.echo_req.granularity;

        if (!state.assets[symbol]) return;

        const candles = response.candles.map(c => ({
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close),
            epoch: c.epoch
        }));

        // Daily candles for ATR
        if (granularity === 86400) {
            state.assets[symbol].dailyCandles = candles;

            // Calculate ATR
            const atr = TechnicalAnalysis.calculateATR(candles, CONFIG.ATR_PERIOD);
            state.assets[symbol].dailyATR = atr;
            state.assets[symbol].atrCalculated = true;
            state.assets[symbol].phase = 'WAITING';

            LOGGER.info(`${symbol}: 📏 Daily ATR calculated: ${atr.toFixed(5)}`);
        }

        // 5-minute candles for hunting
        if (granularity === CONFIG.HUNTING_TIMEFRAME_MINUTES * 60) {
            state.assets[symbol].fiveMinCandles = candles;
            LOGGER.debug(`${symbol}: Loaded ${candles.length} 5-min candles`);
        }
    }

    // ============================================
    // LIQUIDITY CANDLE LOGIC
    // ============================================

    handleLiquidityCandle(symbol, candle, isComplete) {
        const assetState = state.assets[symbol];

        if (assetState.phase !== 'LIQUIDITY_WATCH') {
            return;
        }

        // Wait for candle to complete
        if (!isComplete) {
            LOGGER.debug(`${symbol}: Liquidity candle forming... H=${candle.high.toFixed(5)} L=${candle.low.toFixed(5)}`);
            return;
        }

        // Candle completed - validate it
        const range = candle.high - candle.low;
        const atr = assetState.dailyATR;
        const minRange = atr * CONFIG.MIN_ATR_RATIO;

        LOGGER.box(`${symbol}: Liquidity candle closed`);
        LOGGER.box(`   Range: ${range.toFixed(5)} (${((range / atr) * 100).toFixed(1)}% of ATR)`);
        LOGGER.box(`   Required: ${minRange.toFixed(5)} (${(CONFIG.MIN_ATR_RATIO * 100).toFixed(0)}% of ATR)`);

        // Validation: Range >= 25% of Daily ATR
        if (range < minRange) {
            LOGGER.warn(`${symbol}: ❌ Liquidity candle INVALID - Range too small`);
            assetState.phase = 'COOLDOWN';

            // Try again at next market open
            setTimeout(() => {
                assetState.phase = 'WAITING';
            }, 60000);
            return;
        }

        // Valid liquidity candle - create Trap Box
        const isBullish = TechnicalAnalysis.isBullish(candle);
        const direction = isBullish ? 'SHORT' : 'LONG';  // Opposite of candle direction

        assetState.liquidityCandle = candle;
        assetState.trapBox = {
            active: true,
            high: candle.high,
            low: candle.low,
            direction: direction,
            validUntil: Date.now() + (CONFIG.HUNTING_DURATION_MINUTES * 60 * 1000),
            range: range
        };

        LOGGER.box(`${symbol}: ✅ TRAP BOX CREATED`);
        LOGGER.box(`   High: ${candle.high.toFixed(5)}`);
        LOGGER.box(`   Low: ${candle.low.toFixed(5)}`);
        LOGGER.box(`   Candle: ${isBullish ? 'GREEN (Bullish)' : 'RED (Bearish)'}`);
        LOGGER.box(`   Direction Bias: ${direction}`);
        LOGGER.box(`   Valid for: ${CONFIG.HUNTING_DURATION_MINUTES} minutes`);

        // Start hunting phase
        assetState.phase = 'HUNTING';
        assetState.huntingActive = true;
        assetState.huntingStartTime = Date.now();
        assetState.breakoutDetected = false;

        LOGGER.signal(`${symbol}: 🔍 HUNTING PHASE STARTED - Looking for ${direction} entry`);
    }

    // ============================================
    // HUNTING PHASE LOGIC
    // ============================================

    handleHuntingCandle(symbol, candle, isComplete) {
        const assetState = state.assets[symbol];

        if (assetState.phase !== 'HUNTING' || !assetState.trapBox.active) {
            return;
        }

        // Check if hunting period expired
        if (Date.now() > assetState.trapBox.validUntil) {
            LOGGER.warn(`${symbol}: ⏰ Hunting period expired - No valid entry found`);
            this.resetAssetState(symbol);
            return;
        }

        // Store 5-min candle
        const candles = assetState.fiveMinCandles;
        if (candles.length > 0 && candles[candles.length - 1].epoch === candle.epoch) {
            candles[candles.length - 1] = candle;
        } else {
            candles.push(candle);
            if (candles.length > 50) {
                assetState.fiveMinCandles = candles.slice(-50);
            }
        }

        // Only check on complete candles
        if (!isComplete) {
            return;
        }

        const trapBox = assetState.trapBox;
        const direction = trapBox.direction;

        LOGGER.debug(`${symbol}: 5-min candle closed - Checking for ${direction} setup`);

        // Check for breakout and reversal pattern
        if (direction === 'SHORT') {
            // For SHORT: Wait for breakout above Box High, then bearish reversal
            if (candle.high > trapBox.high) {
                assetState.breakoutDetected = true;
                LOGGER.signal(`${symbol}: 📈 Breakout ABOVE trap box detected!`);
            }

            if (assetState.breakoutDetected && TechnicalAnalysis.isShootingStar(candle)) {
                LOGGER.pattern(`${symbol}: ⭐ SHOOTING STAR detected after breakout - SHORT ENTRY!`);
                this.executeEntry(symbol, 'DOWN', trapBox.low);
            }
        } else {
            // For LONG: Wait for breakout below Box Low, then bullish reversal
            if (candle.low < trapBox.low) {
                assetState.breakoutDetected = true;
                LOGGER.signal(`${symbol}: 📉 Breakout BELOW trap box detected!`);
            }

            if (assetState.breakoutDetected && TechnicalAnalysis.isHammer(candle)) {
                LOGGER.pattern(`${symbol}: 🔨 HAMMER detected after breakout - LONG ENTRY!`);
                this.executeEntry(symbol, 'UP', trapBox.high);
            }
        }
    }

    // ============================================
    // TRADE EXECUTION
    // ============================================

    executeEntry(symbol, direction, targetPrice) {
        const assetState = state.assets[symbol];
        const config = ASSET_CONFIGS[symbol];

        if (!config) {
            LOGGER.error(`${symbol}: No configuration found`);
            return;
        }

        // Check if we already have a position on this asset
        if (assetState.activePosition) {
            LOGGER.warn(`${symbol}: Already have active position`);
            return;
        }

        const stake = Math.max(CONFIG.STAKE, config.minStake);
        const multiplier = CONFIG.ASSET_MULTIPLIERS[symbol] || config.multipliers[0];
        const contractType = direction === 'UP' ? 'MULTUP' : 'MULTDOWN';

        LOGGER.trade(`🎯 EXECUTING ${direction} on ${config.name} (${symbol})`);
        LOGGER.trade(`   Contract: ${contractType}`);
        LOGGER.trade(`   Stake: $${stake.toFixed(2)}`);
        LOGGER.trade(`   Multiplier: x${multiplier}`);
        LOGGER.trade(`   Target: ${targetPrice.toFixed(5)} (opposite side of trap box)`);

        // Create position
        const position = {
            symbol,
            direction,
            stake,
            multiplier,
            targetPrice,
            entryTime: Date.now(),
            contractId: null,
            reqId: null,
            currentProfit: 0,
            buyPrice: 0
        };

        state.activePositions.push(position);

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

        const reqId = this.send(tradeRequest);
        position.reqId = reqId;

        // Update asset state
        assetState.phase = 'TRADING';
        assetState.dailyTrades++;
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);

            // Clean up failed position
            const reqId = response.echo_req?.req_id;
            if (reqId) {
                const posIndex = state.activePositions.findIndex(p => p.reqId === reqId);
                if (posIndex >= 0) {
                    const pos = state.activePositions[posIndex];
                    if (state.assets[pos.symbol]) {
                        this.resetAssetState(pos.symbol);
                    }
                    state.activePositions.splice(posIndex, 1);
                }
            }
            return;
        }

        const contract = response.buy;
        LOGGER.trade(`✅ Position opened: Contract ${contract.contract_id}, Price: $${contract.buy_price}`);

        const reqId = response.echo_req.req_id;
        const position = state.activePositions.find(p => p.reqId === reqId);

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

    // ============================================
    // EXIT MANAGEMENT
    // ============================================

    checkTakeProfit(symbol, currentPrice) {
        const assetState = state.assets[symbol];
        if (!assetState || !assetState.activePosition) return;

        const position = assetState.activePosition;
        const direction = position.direction;
        const target = position.targetPrice;

        let targetHit = false;

        if (direction === 'UP' && currentPrice >= target) {
            targetHit = true;
            LOGGER.trade(`${symbol}: 🎯 TARGET HIT! Price ${currentPrice.toFixed(5)} >= ${target.toFixed(5)}`);
        } else if (direction === 'DOWN' && currentPrice <= target) {
            targetHit = true;
            LOGGER.trade(`${symbol}: 🎯 TARGET HIT! Price ${currentPrice.toFixed(5)} <= ${target.toFixed(5)}`);
        }

        if (targetHit && position.contractId) {
            LOGGER.trade(`${symbol}: Closing position at target...`);
            this.send({
                sell: position.contractId,
                price: 0  // Market price
            });
        }
    }

    handleSellResponse(response) {
        if (response.error) {
            LOGGER.error(`Sell error: ${response.error.message}`);
            return;
        }

        const sold = response.sell;
        LOGGER.trade(`✅ Position closed: Contract ${sold.contract_id}, Sold at: $${sold.sold_for}`);

        const posIndex = state.activePositions.findIndex(
            p => p.contractId === sold.contract_id
        );

        if (posIndex >= 0) {
            const position = state.activePositions[posIndex];
            const profit = sold.sold_for - position.buyPrice;

            this.recordTradeResult(position.symbol, profit, position.direction);
            state.activePositions.splice(posIndex, 1);

            // Reset asset state
            this.resetAssetState(position.symbol);
        }
    }

    handleContractUpdate(response) {
        if (response.error) return;

        const contract = response.proposal_open_contract;
        const posIndex = state.activePositions.findIndex(
            p => p.contractId === contract.contract_id
        );

        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
            const profit = contract.profit;
            const symbol = contract.underlying;

            LOGGER.trade(`Contract ${contract.contract_id} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${Math.abs(profit).toFixed(2)}`);

            if (posIndex >= 0) {
                const position = state.activePositions[posIndex];
                this.recordTradeResult(symbol, profit, position.direction);
                state.activePositions.splice(posIndex, 1);

                this.resetAssetState(symbol);
            }

            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }
        } else if (posIndex >= 0) {
            state.activePositions[posIndex].currentProfit = contract.profit;
        }
    }

    // ============================================
    // RESULT RECORDING
    // ============================================

    recordTradeResult(symbol, profit, direction) {
        const assetState = state.assets[symbol];

        state.session.tradesCount++;
        state.capital += profit;

        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            if (assetState) assetState.dailyWins++;
            this.isWinTrade = true;

            LOGGER.trade(`✅ WIN on ${symbol}: +$${profit.toFixed(2)}`);
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            if (assetState) assetState.dailyLosses++;
            this.isWinTrade = false;

            LOGGER.trade(`❌ LOSS on ${symbol}: -$${Math.abs(profit).toFixed(2)}`);

            // Send loss email notification
            this.sendLossEmail(symbol, profit);
        }

        LOGGER.info(`💰 Capital: $${state.capital.toFixed(2)} | Net P/L: $${state.session.netPL.toFixed(2)}`);
    }

    // ============================================
    // STATE MANAGEMENT
    // ============================================

    resetAssetState(symbol) {
        const assetState = state.assets[symbol];
        if (!assetState) return;

        assetState.phase = 'WAITING';
        assetState.liquidityCandle = null;
        assetState.trapBox = {
            active: false,
            high: 0,
            low: 0,
            direction: null,
            validUntil: 0,
            range: 0
        };
        assetState.huntingActive = false;
        assetState.huntingStartTime = 0;
        assetState.breakoutDetected = false;
        assetState.activePosition = null;

        LOGGER.info(`${symbol}: State reset - waiting for next market open`);
    }

    // ============================================
    // DASHBOARD
    // ============================================

    startDashboard() {
        setInterval(() => {
            if (state.isAuthorized) {
                this.displayDashboard();
            }
        }, CONFIG.DASHBOARD_UPDATE_INTERVAL);
    }

    displayDashboard() {
        const session = state.session;
        const now = new Date();

        console.log('\n' + '╔' + '═'.repeat(80) + '╗');
        console.log('║' + '     DERIV QUICK FLIP SCALPER BOT v1.0'.padEnd(80) + '║');
        console.log('╠' + '═'.repeat(80) + '╣');

        const netPLColor = session.netPL >= 0 ? '\x1b[32m' : '\x1b[31m';
        const resetColor = '\x1b[0m';

        console.log(`║ 💰 Capital: $${state.capital.toFixed(2).padEnd(12)} 🏦 Account: $${state.accountBalance.toFixed(2).padEnd(12)}            ║`);
        console.log(`║ 📊 Trades: ${session.tradesCount.toString().padEnd(5)} Wins: ${session.winsCount.toString().padEnd(5)} Losses: ${session.lossesCount.toString().padEnd(5)}                      ║`);
        console.log(`║ 💹 Net P/L: ${netPLColor}$${session.netPL.toFixed(2).padEnd(10)}${resetColor}                                                   ║`);
        console.log(`║ ⏰ Time: ${now.toISOString().padEnd(25)} Market Open: ${CONFIG.MARKET_OPEN_TIME} UTC     ║`);

        console.log('╠' + '═'.repeat(80) + '╣');
        console.log('║ ASSET STATUS:'.padEnd(81) + '║');
        console.log('║ Symbol     | Phase          | ATR      | Box      | Direction | Breakout   ║');
        console.log('║' + '-'.repeat(80) + '║');

        for (const symbol of CONFIG.ASSETS) {
            const asset = state.assets[symbol];
            if (!asset) continue;

            const phaseColor = asset.phase === 'HUNTING' ? '\x1b[33m' :
                asset.phase === 'TRADING' ? '\x1b[32m' : '\x1b[0m';

            const boxStatus = asset.trapBox.active ? 'ACTIVE' : '-';
            const direction = asset.trapBox.direction || '-';
            const breakout = asset.breakoutDetected ? 'YES' : '-';

            console.log(`║ ${symbol.padEnd(10)} | ${phaseColor}${asset.phase.padEnd(14)}${resetColor} | ${asset.dailyATR.toFixed(4).padEnd(8)} | ${boxStatus.padEnd(8)} | ${direction.padEnd(9)} | ${breakout.padEnd(10)} ║`);
        }

        // Active positions
        if (state.activePositions.length > 0) {
            console.log('╠' + '═'.repeat(80) + '╣');
            console.log('║ ACTIVE POSITIONS:'.padEnd(81) + '║');
            console.log('║ Symbol     | Dir  | Stake   | Target        | Profit     | Duration   ║');
            console.log('║' + '-'.repeat(80) + '║');

            for (const pos of state.activePositions) {
                const duration = Math.floor((Date.now() - pos.entryTime) / 1000);
                const profitColor = pos.currentProfit >= 0 ? '\x1b[32m' : '\x1b[31m';

                console.log(`║ ${pos.symbol.padEnd(10)} | ${pos.direction.padEnd(4)} | $${pos.stake.toFixed(2).padEnd(6)} | ${pos.targetPrice.toFixed(5).padEnd(13)} | ${profitColor}$${pos.currentProfit.toFixed(2).padEnd(8)}${resetColor} | ${duration}s`.padEnd(89) + ' ║');
            }
        }

        console.log('╘' + '═'.repeat(80) + '╛');
        console.log(`⏰ ${now.toISOString()} (GMT) | Press Ctrl+C to stop\n`);
    }

    // ============================================
    // EMAIL NOTIFICATIONS
    // ============================================

    startEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendEmailSummary();
            }
        }, 1800000); // 30 minutes
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const winRate = state.session.tradesCount > 0
            ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(2)
            : 0;

        const summaryText = `
        ==================== Quick Flip Bot Trading Summary ====================
        Total Trades: ${state.session.tradesCount}
        Total Wins: ${state.session.winsCount}
        Total Losses: ${state.session.lossesCount}
        Win Rate: ${winRate}%
        
        Financial:
        Capital: $${state.capital.toFixed(2)}
        Account Balance: $${state.accountBalance.toFixed(2)}
        Session Profit: $${state.session.profit.toFixed(2)}
        Session Loss: $${state.session.loss.toFixed(2)}
        Net P/L: $${state.session.netPL.toFixed(2)}
        
        Session Duration: ${Math.floor((Date.now() - state.session.startTime) / 60000)} minutes
        Time (GMT): ${new Date().toISOString()}
        =========================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Quick Flip Bot - Performance Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
            LOGGER.info('📧 Email summary sent successfully');
        } catch (error) {
            LOGGER.error(`Error sending email: ${error.message}`);
        }
    }

    async sendLossEmail(symbol, profit) {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const assetState = state.assets[symbol];

        const summaryText = `
        ==================== Loss Alert ====================
        Trade Summary:
        Total Trades: ${state.session.tradesCount}
        Wins: ${state.session.winsCount} | Losses: ${state.session.lossesCount}
        
        Loss Details for [${symbol}]:
        Loss Amount: $${Math.abs(profit).toFixed(2)}
        Asset Phase: ${assetState?.phase || 'Unknown'}
        Daily ATR: ${assetState?.dailyATR?.toFixed(5) || 'N/A'}
        
        Financial:
        Capital: $${state.capital.toFixed(2)}
        Net P/L: $${state.session.netPL.toFixed(2)}
        
        Time (GMT): ${new Date().toISOString()}
        ====================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: `Quick Flip Bot - Loss Alert [${symbol}]`,
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
            LOGGER.info(`📧 Loss email sent for ${symbol}`);
        } catch (error) {
            LOGGER.error(`Error sending loss email: ${error.message}`);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Quick Flip Bot - Error Report',
            text: `An error occurred: ${errorMessage}\n\nTime (GMT): ${new Date().toISOString()}`
        };

        try {
            await transporter.sendMail(mailOptions);
            LOGGER.info('📧 Error email sent');
        } catch (error) {
            LOGGER.error(`Error sending error email: ${error.message}`);
        }
    }

    async sendDisconnectResumptionEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const now = new Date();
        const gmtTime = now.toISOString();

        const summaryText = `
        Disconnect/Reconnect Email: Time (GMT): ${gmtTime}

        ==================== Trading Summary ====================
        Total Trades: ${state.session.tradesCount}
        Total Wins: ${state.session.winsCount}
        Total Losses: ${state.session.lossesCount}
        
        Financial:
        Capital: $${state.capital.toFixed(2)}
        Net P/L: $${state.session.netPL.toFixed(2)}
        
        Active Positions: ${state.activePositions.length}
        =========================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Quick Flip Bot - Disconnect/Resumption Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
            LOGGER.info('📧 Disconnect/resumption email sent');
        } catch (error) {
            LOGGER.error(`Error sending email: ${error.message}`);
        }
    }

    // ============================================
    // GMT-BASED TIME MANAGEMENT
    // ============================================

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            // Always use GMT time regardless of server location
            const now = new Date();
            const currentHours = now.getUTCHours();
            const currentMinutes = now.getUTCMinutes();
            const currentDay = now.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

            // Optional: log current GMT time for monitoring
            LOGGER.debug(`Current GMT time: ${now.toISOString()}`);

            // Check if it's Sunday - no trading on Sundays
            if (currentDay === 0) {
                if (!this.endOfDay) {
                    LOGGER.info("It's Sunday (GMT), disconnecting the bot. No trading on Sundays.");
                    this.Pause = true;
                    this.endOfDay = true;
                    this.sendEmailSummary();
                    if (this.ws) {
                        this.ws.close();
                    }
                }
                return; // Skip all other checks on Sunday
            }

            // Check for Morning resume condition (7:00 AM GMT) - but not on Sunday
            if (this.endOfDay && currentHours === 7 && currentMinutes >= 0 && currentMinutes < 5) {
                LOGGER.info("It's 7:00 AM GMT, reconnecting the bot.");
                this.Pause = false;
                this.endOfDay = false;

                // Reinitialize asset states
                for (const symbol of CONFIG.ASSETS) {
                    if (state.assets[symbol]) {
                        this.resetAssetState(symbol);
                    }
                }

                this.connect();
            }

            // Check for evening stop condition (after 10:00 PM GMT)
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 22 && currentMinutes >= 0) {
                    LOGGER.info("It's past 10:00 PM GMT after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.Pause = true;
                    this.endOfDay = true;
                    if (this.ws) {
                        this.ws.close();
                    }
                }
            }
        }, 5000); // Check every 5 seconds
    }

    // ============================================
    // SHUTDOWN
    // ============================================

    stop() {
        LOGGER.info('🛑 Stopping bot...');

        // Send final email summary before stopping
        this.sendEmailSummary();

        this.stopKeepAlive();

        if (this.marketOpenCheckInterval) {
            clearInterval(this.marketOpenCheckInterval);
        }

        // Close all positions
        for (const position of state.activePositions) {
            if (position.contractId) {
                this.send({
                    sell: position.contractId,
                    price: 0
                });
            }
        }

        setTimeout(() => {
            if (this.ws) {
                this.ws.close();
            }
            LOGGER.info('👋 Bot stopped');
        }, 2000);
    }
}

// ============================================
// INITIALIZATION
// ============================================

const bot = new QuickFlipBot();

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
    console.log('═'.repeat(80));
    console.log('         DERIV QUICK FLIP SCALPER BOT v1.0');
    console.log('         Liquidity Trap & Reversal Strategy');
    console.log('═'.repeat(80));
    console.log('\n⚠️  API Token not configured!\n');
    console.log('Usage:');
    console.log('  API_TOKEN=your_token node deriv-quickflip-bot.js');
    console.log('\nEnvironment Variables:');
    console.log('  API_TOKEN      - Your Deriv API token (required)');
    console.log('  ASSETS         - Comma-separated assets (default: R_75)');
    console.log('  CAPITAL        - Initial capital (default: 500)');
    console.log('  STAKE          - Stake amount (default: 1)');
    console.log('  MULT           - Multiplier (default: 100)');
    console.log('  MARKET_OPEN    - Market open time in UTC HH:MM (default: 00:00)');
    console.log('  PROFIT_TARGET  - Session profit target (default: 50)');
    console.log('  STOP_LOSS      - Session stop loss (default: -100)');
    console.log('  DEBUG          - Enable debug mode (default: false)');
    console.log('\nStrategy:');
    console.log('  1. At Market Open, watch the first 15-min candle (Liquidity Candle)');
    console.log('  2. If Range >= 25% of Daily ATR, create Trap Box');
    console.log('  3. GREEN candle → Look for SHORT, RED candle → Look for LONG');
    console.log('  4. Wait for breakout + reversal pattern (Hammer/Shooting Star)');
    console.log('  5. Target: Opposite side of Trap Box');
    console.log('\nExample:');
    console.log('  API_TOKEN=xxx ASSETS=R_75,R_100 MARKET_OPEN=08:00 node deriv-quickflip-bot.js');
    console.log('═'.repeat(80));
    process.exit(1);
}

// Start the bot
console.log('═'.repeat(80));
console.log('         DERIV QUICK FLIP SCALPER BOT v1.0');
console.log('═'.repeat(80));
console.log('\n🚀 Initializing...\n');

bot.connect();

// Export
module.exports = {
    QuickFlipBot,
    TechnicalAnalysis,
    CONFIG,
    ASSET_CONFIGS,
    state
};
