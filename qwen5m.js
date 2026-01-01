#!/usr/bin/env node

/**
 * DERIV SYNTHETIC INDICES SCALPING BOT
 * =====================================
 * Market: Volatility 75 Index (R_75) / Boom 500 (BOOM500)
 * Strategy: Multi-indicator confirmation (EMA/RSI/MACD/Bollinger Bands)
 * Timeframe: 5 Minutes
 * 
 * INSTALLATION:
 * 1. npm install ws
 * 2. Set your API_TOKEN below
 * 3. node bot.js
 */

const WebSocket = require('ws');

// ==================== CONFIGURATION ====================
const CONFIG = {
    // API Credentials
    APP_ID: 1089,
    API_TOKEN: '0P94g4WdSrSrzir', // Your Deriv API token

    // Trading Parameters
    SYMBOL: 'R_75', // R_75, R_100, BOOM500, etc.
    TIMEFRAME: 300, // 5 minutes in seconds
    STAKE: 0.50, // USD per trade
    CONTRACT_DURATION: 5,
    CONTRACT_DURATION_UNIT: 'm',

    // Risk Management
    TAKE_PROFIT: 1.50,
    STOP_LOSS: 0.50,
    DAILY_LOSS_LIMIT: 10.00,
    MAX_TRADES_PER_DAY: 20,
    CONSECUTIVE_LOSS_LIMIT: 3,
    BREAK_DURATION_MINUTES: 30,

    // Strategy Parameters - EMA
    EMA_FAST: 9,
    EMA_SLOW: 21,

    // Strategy Parameters - RSI
    RSI_PERIOD: 14,
    RSI_LOWER: 40,
    RSI_UPPER: 60,

    // Strategy Parameters - MACD
    MACD_FAST: 12,
    MACD_SLOW: 26,
    MACD_SIGNAL: 9,

    // Strategy Parameters - Bollinger Bands
    BB_PERIOD: 20,
    BB_STD_DEV: 2,

    // Connection
    RECONNECT_INTERVAL: 5000,
    HEARTBEAT_INTERVAL: 30000,
    REQUEST_TIMEOUT: 30000,
};

// ==================== COLORS FOR TERMINAL ====================
const C = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
};

// ==================== GLOBAL STATE ====================
const STATE = {
    ws: null,
    isConnected: false,
    isAuthorized: false,
    account: {
        balance: 0,
        startingBalance: 0,
        currency: 'USD',
        loginid: '',
        is_virtual: true
    },
    candles: [],
    currentCandleEpoch: 0,
    indicators: {
        emaFast: null,
        emaSlow: null,
        rsi: null,
        macd: { macd: null, signal: null, histogram: null },
        bb: { upper: null, middle: null, lower: null }
    },
    trading: {
        isActive: false,
        dailyTrades: 0,
        dailyPnL: 0,
        dailyLoss: 0,
        consecutiveLosses: 0,
        lastTradeDate: new Date().toDateString(),
        pausedUntil: 0
    },
    activeTrades: [],
    completedTrades: [],
    pendingRequests: new Map(),
    subscriptions: new Map(),
    requestId: 0
};

// ==================== LOGGER ====================
class Logger {
    static getTimestamp() {
        return new Date().toISOString().replace('T', ' ').substring(0, 19);
    }

    static log(level, message, data = null) {
        const timestamp = this.getTimestamp();
        const icons = {
            DEBUG: '🔍',
            INFO: 'ℹ️ ',
            WARN: '⚠️ ',
            ERROR: '❌',
            SUCCESS: '✅',
            TRADE: '💹',
            SIGNAL: '📡'
        };
        const colors = {
            DEBUG: C.dim,
            INFO: C.blue,
            WARN: C.yellow,
            ERROR: C.red,
            SUCCESS: C.green,
            TRADE: C.magenta,
            SIGNAL: C.cyan
        };

        const icon = icons[level] || '';
        const color = colors[level] || C.white;

        console.log(`${C.dim}[${timestamp}]${C.reset} ${color}[${level}]${C.reset} ${icon} ${message}`);

        if (data) {
            const dataStr = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
            console.log(`${C.dim}${dataStr}${C.reset}`);
        }
    }

    static debug(msg, data) { this.log('DEBUG', msg, data); }
    static info(msg, data) { this.log('INFO', msg, data); }
    static warn(msg, data) { this.log('WARN', msg, data); }
    static error(msg, data) { this.log('ERROR', msg, data); }
    static success(msg, data) { this.log('SUCCESS', msg, data); }
    static trade(msg, data) { this.log('TRADE', msg, data); }
    static signal(msg, data) { this.log('SIGNAL', msg, data); }

    static separator(title = '') {
        const line = '═'.repeat(60);
        console.log(`\n${C.cyan}${C.bright}${line}${C.reset}`);
        if (title) {
            console.log(`${C.cyan}${C.bright}  ${title}${C.reset}`);
            console.log(`${C.cyan}${C.bright}${line}${C.reset}`);
        }
    }

    static displayBanner() {
        console.log(`
${C.cyan}${C.bright}╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🤖 DERIV MULTI-INDICATOR SCALPING BOT                    ║
║   EMA + RSI + MACD + Bollinger Bands Strategy              ║
║   Node.js Automated Trading System v2.0                    ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝${C.reset}
        `);
    }

    static displayConfig() {
        this.separator('⚙️  CONFIGURATION');
        console.log(`  Symbol:           ${C.bright}${CONFIG.SYMBOL}${C.reset}`);
        console.log(`  Timeframe:        ${C.bright}${CONFIG.TIMEFRAME}s (${CONFIG.TIMEFRAME / 60} minutes)${C.reset}`);
        console.log(`  Stake:            ${C.bright}$${CONFIG.STAKE}${C.reset}`);
        console.log(`  Take Profit:      ${C.bright}$${CONFIG.TAKE_PROFIT}${C.reset}`);
        console.log(`  Stop Loss:        ${C.bright}$${CONFIG.STOP_LOSS}${C.reset}`);
        console.log(`  Daily Loss Limit: ${C.bright}$${CONFIG.DAILY_LOSS_LIMIT}${C.reset}`);
        console.log(`  EMA Fast/Slow:    ${C.bright}${CONFIG.EMA_FAST}/${CONFIG.EMA_SLOW}${C.reset}`);
        console.log(`  RSI Period:       ${C.bright}${CONFIG.RSI_PERIOD} (${CONFIG.RSI_LOWER}-${CONFIG.RSI_UPPER})${C.reset}`);
        console.log(`  MACD:             ${C.bright}${CONFIG.MACD_FAST}/${CONFIG.MACD_SLOW}/${CONFIG.MACD_SIGNAL}${C.reset}`);
        console.log(`  Bollinger Bands:  ${C.bright}${CONFIG.BB_PERIOD} period, ${CONFIG.BB_STD_DEV} std dev${C.reset}`);
        console.log('');
    }

    static displayAccount() {
        this.separator('💰 ACCOUNT INFO');
        const accType = STATE.account.is_virtual ? `${C.yellow}DEMO${C.reset}` : `${C.red}${C.bright}REAL${C.reset}`;
        console.log(`  Login ID:        ${C.bright}${STATE.account.loginid}${C.reset}`);
        console.log(`  Account:         ${accType}`);
        console.log(`  Balance:         ${C.green}${C.bright}$${STATE.account.balance.toFixed(2)} ${STATE.account.currency}${C.reset}`);
        console.log(`  Starting:        ${C.dim}$${STATE.account.startingBalance.toFixed(2)}${C.reset}`);
        console.log('');
    }

    static displayIndicators() {
        this.separator('📊 MARKET INDICATORS');
        const { emaFast, emaSlow, rsi, macd, bb } = STATE.indicators;
        const lastCandle = STATE.candles[STATE.candles.length - 1];
        const price = lastCandle ? lastCandle.close : '--';

        console.log(`  Price:           ${typeof price === 'number' ? price.toFixed(2) : price}`);
        console.log(`  EMA ${CONFIG.EMA_FAST}:          ${emaFast ? emaFast.toFixed(2) : '--'}`);
        console.log(`  EMA ${CONFIG.EMA_SLOW}:         ${emaSlow ? emaSlow.toFixed(2) : '--'}`);
        console.log(`  RSI ${CONFIG.RSI_PERIOD}:         ${rsi ? rsi.toFixed(2) : '--'}`);
        console.log(`  MACD:            ${macd.macd ? macd.macd.toFixed(4) : '--'}`);
        console.log(`  MACD Signal:     ${macd.signal ? macd.signal.toFixed(4) : '--'}`);
        console.log(`  BB Upper:        ${bb.upper ? bb.upper.toFixed(2) : '--'}`);
        console.log(`  BB Middle:       ${bb.middle ? bb.middle.toFixed(2) : '--'}`);
        console.log(`  BB Lower:        ${bb.lower ? bb.lower.toFixed(2) : '--'}`);

        if (emaFast && emaSlow) {
            const trend = emaFast > emaSlow ? `${C.green}BULLISH${C.reset}` : `${C.red}BEARISH${C.reset}`;
            console.log(`  Trend:           ${trend}`);
        }
        console.log('');
    }

    static displayActiveTrades() {
        this.separator(`🔥 ACTIVE TRADES (${STATE.activeTrades.length})`);

        if (STATE.activeTrades.length === 0) {
            console.log(`  ${C.dim}No active trades${C.reset}`);
        } else {
            STATE.activeTrades.forEach((trade, idx) => {
                const pnlColor = (trade.currentPnL || 0) >= 0 ? C.green : C.red;
                const dirColor = trade.type === 'CALL' ? C.green : C.red;
                const dirIcon = trade.type === 'CALL' ? '🟢' : '🔴';
                console.log(`  ${C.bright}#${idx + 1}${C.reset} | ${dirIcon} ${dirColor}${trade.type}${C.reset} | ID: ${trade.id}`);
                console.log(`      Entry: $${trade.entryPrice?.toFixed(2) || '--'} | P&L: ${pnlColor}$${(trade.currentPnL || 0).toFixed(2)}${C.reset} | Status: ${trade.status}`);
            });
        }
        console.log('');
    }

    static displayCompletedTrades() {
        this.separator(`✅ COMPLETED TRADES (${STATE.completedTrades.length})`);

        if (STATE.completedTrades.length === 0) {
            console.log(`  ${C.dim}No completed trades${C.reset}`);
        } else {
            const recentTrades = STATE.completedTrades.slice(0, 10);
            recentTrades.forEach((trade, idx) => {
                const pnlColor = trade.finalPnL >= 0 ? C.green : C.red;
                const resultIcon = trade.finalPnL >= 0 ? '🎉' : '😢';
                const result = trade.finalPnL >= 0 ? 'WIN' : 'LOSS';
                const dirIcon = trade.type === 'CALL' ? '🟢' : '🔴';
                console.log(`  ${C.bright}#${idx + 1}${C.reset} | ${dirIcon} ${trade.type} | ID: ${trade.id}`);
                console.log(`      ${resultIcon} ${result} | P&L: ${pnlColor}$${trade.finalPnL.toFixed(2)}${C.reset} | ${new Date(trade.endTime).toLocaleTimeString()}`);
            });
        }
        console.log('');
    }

    static displayStats() {
        this.separator('📈 SESSION STATISTICS');
        const pnlColor = STATE.trading.dailyPnL >= 0 ? C.green : C.red;
        const winTrades = STATE.completedTrades.filter(t => t.finalPnL > 0).length;
        const winRate = STATE.completedTrades.length > 0
            ? ((winTrades / STATE.completedTrades.length) * 100).toFixed(1)
            : '0.0';

        const pauseStatus = STATE.trading.pausedUntil > Date.now()
            ? `${C.yellow}PAUSED until ${new Date(STATE.trading.pausedUntil).toLocaleTimeString()}${C.reset}`
            : STATE.trading.isActive ? `${C.green}ACTIVE${C.reset}` : `${C.yellow}IDLE${C.reset}`;

        console.log(`  💰 Balance:            ${C.green}$${STATE.account.balance.toFixed(2)}${C.reset}`);
        console.log(`  📊 Daily P&L:          ${pnlColor}$${STATE.trading.dailyPnL.toFixed(2)}${C.reset}`);
        console.log(`  📉 Daily Loss:         ${C.red}$${STATE.trading.dailyLoss.toFixed(2)}${C.reset} / $${CONFIG.DAILY_LOSS_LIMIT}`);
        console.log(`  🔢 Trades Today:       ${STATE.trading.dailyTrades} / ${CONFIG.MAX_TRADES_PER_DAY}`);
        console.log(`  🔥 Active Trades:      ${STATE.activeTrades.length}`);
        console.log(`  ✅ Completed Trades:   ${STATE.completedTrades.length}`);
        console.log(`  🎯 Win Rate:           ${winRate}%`);
        console.log(`  📈 Consecutive Losses: ${STATE.trading.consecutiveLosses} / ${CONFIG.CONSECUTIVE_LOSS_LIMIT}`);
        console.log(`  🤖 Bot Status:         ${pauseStatus}`);
        console.log('');
    }

    static displayAll() {
        console.clear();
        this.displayBanner();
        this.displayAccount();
        this.displayStats();
        this.displayIndicators();
        this.displayActiveTrades();
        this.displayCompletedTrades();
    }
}

// ==================== TECHNICAL INDICATORS ====================
class Indicators {
    static calculateEMA(data, period) {
        if (data.length < period) return null;
        const k = 2 / (period + 1);
        let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
        }
        return ema;
    }

    static calculateEMAArray(data, period) {
        if (data.length < period) return [];
        const k = 2 / (period + 1);
        const emaArray = [];
        let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
        emaArray.push(ema);

        for (let i = period; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
            emaArray.push(ema);
        }
        return emaArray;
    }

    static calculateRSI(data, period = 14) {
        if (data.length < period + 1) return null;

        let gains = 0;
        let losses = 0;

        for (let i = 1; i <= period; i++) {
            const change = data[i] - data[i - 1];
            if (change > 0) gains += change;
            else losses += Math.abs(change);
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;

        for (let i = period + 1; i < data.length; i++) {
            const change = data[i] - data[i - 1];
            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? Math.abs(change) : 0;

            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
        }

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    static calculateMACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        if (data.length < slowPeriod + signalPeriod) return { macd: null, signal: null, histogram: null };

        const fastEMA = this.calculateEMAArray(data, fastPeriod);
        const slowEMA = this.calculateEMAArray(data, slowPeriod);

        if (fastEMA.length === 0 || slowEMA.length === 0) return { macd: null, signal: null, histogram: null };

        // Align arrays - MACD line
        const macdLine = [];
        const offset = fastPeriod - 1;
        for (let i = slowPeriod - fastPeriod; i < slowEMA.length; i++) {
            const fastVal = fastEMA[i + (slowPeriod - fastPeriod)];
            const slowVal = slowEMA[i];
            if (fastVal !== undefined && slowVal !== undefined) {
                macdLine.push(fastVal - slowVal);
            }
        }

        if (macdLine.length < signalPeriod) return { macd: null, signal: null, histogram: null };

        // Signal line
        const signalLine = this.calculateEMAArray(macdLine, signalPeriod);

        if (signalLine.length === 0) return { macd: null, signal: null, histogram: null };

        const macd = macdLine[macdLine.length - 1];
        const signal = signalLine[signalLine.length - 1];
        const histogram = macd - signal;

        return { macd, signal, histogram };
    }

    static calculateBollingerBands(data, period = 20, stdDev = 2) {
        if (data.length < period) return { upper: null, middle: null, lower: null };

        const slice = data.slice(-period);
        const middle = slice.reduce((a, b) => a + b, 0) / period;

        const squaredDiffs = slice.map(v => Math.pow(v - middle, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
        const std = Math.sqrt(variance);

        return {
            upper: middle + (stdDev * std),
            middle: middle,
            lower: middle - (stdDev * std)
        };
    }
}

// ==================== TRADING STRATEGY ====================
class Strategy {
    static analyzeMarket(candles) {
        if (candles.length < Math.max(CONFIG.EMA_SLOW, CONFIG.MACD_SLOW + CONFIG.MACD_SIGNAL, CONFIG.BB_PERIOD) + 5) {
            return { signal: 'WAIT', reason: 'Insufficient data' };
        }

        const closes = candles.map(c => c.close);

        // Calculate all indicators
        const emaFast = Indicators.calculateEMA(closes, CONFIG.EMA_FAST);
        const emaSlow = Indicators.calculateEMA(closes, CONFIG.EMA_SLOW);
        const rsi = Indicators.calculateRSI(closes, CONFIG.RSI_PERIOD);
        const macd = Indicators.calculateMACD(closes, CONFIG.MACD_FAST, CONFIG.MACD_SLOW, CONFIG.MACD_SIGNAL);
        const bb = Indicators.calculateBollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_STD_DEV);

        // Store in state
        STATE.indicators = { emaFast, emaSlow, rsi, macd, bb };

        const currentPrice = closes[closes.length - 1];

        // Check for 2 consecutive candles in same direction
        const prevCandle = candles[candles.length - 2];
        const lastCandle = candles[candles.length - 1];
        const isTwoGreen = (prevCandle.close > prevCandle.open) && (lastCandle.close > lastCandle.open);
        const isTwoRed = (prevCandle.close < prevCandle.open) && (lastCandle.close < lastCandle.open);

        // Validate all indicators exist
        if (!emaFast || !emaSlow || !rsi || !macd.macd || !bb.middle) {
            return { signal: 'WAIT', reason: 'Indicators not ready' };
        }

        // LONG CONDITIONS
        const longEma = currentPrice > emaFast && emaFast > emaSlow;
        const longRsi = rsi >= CONFIG.RSI_LOWER && rsi <= CONFIG.RSI_UPPER;
        const longMacd = macd.macd > macd.signal;
        const longBb = currentPrice > bb.lower && currentPrice < bb.upper;

        if (longEma && longRsi && longMacd && longBb && isTwoGreen) {
            return {
                signal: 'CALL',
                reason: 'Bullish: EMA aligned + RSI neutral + MACD bullish + BB confirmed + 2 green candles',
                confidence: 'HIGH',
                indicators: { emaFast, emaSlow, rsi, macd, bb, price: currentPrice }
            };
        }

        // SHORT CONDITIONS
        const shortEma = currentPrice < emaFast && emaFast < emaSlow;
        const shortRsi = rsi >= CONFIG.RSI_LOWER && rsi <= CONFIG.RSI_UPPER;
        const shortMacd = macd.macd < macd.signal;
        const shortBb = currentPrice > bb.lower && currentPrice < bb.upper;

        if (shortEma && shortRsi && shortMacd && shortBb && isTwoRed) {
            return {
                signal: 'PUT',
                reason: 'Bearish: EMA aligned + RSI neutral + MACD bearish + BB confirmed + 2 red candles',
                confidence: 'HIGH',
                indicators: { emaFast, emaSlow, rsi, macd, bb, price: currentPrice }
            };
        }

        return { signal: 'WAIT', reason: 'No clear setup' };
    }

    static shouldTrade() {
        // Reset daily counter if new day
        const today = new Date().toDateString();
        if (today !== STATE.trading.lastTradeDate) {
            STATE.trading.dailyTrades = 0;
            STATE.trading.dailyPnL = 0;
            STATE.trading.dailyLoss = 0;
            STATE.trading.consecutiveLosses = 0;
            STATE.trading.lastTradeDate = today;
            STATE.trading.pausedUntil = 0;
            Logger.info('📅 New trading day - counters reset');
        }

        // Check if paused
        if (STATE.trading.pausedUntil > Date.now()) {
            return false;
        }

        // Check daily loss limit
        if (STATE.trading.dailyLoss >= CONFIG.DAILY_LOSS_LIMIT) {
            Logger.warn(`Daily loss limit reached: $${STATE.trading.dailyLoss.toFixed(2)}`);
            return false;
        }

        // Check max trades
        if (STATE.trading.dailyTrades >= CONFIG.MAX_TRADES_PER_DAY) {
            Logger.warn(`Max daily trades reached: ${STATE.trading.dailyTrades}`);
            return false;
        }

        // Check if already in position
        if (STATE.activeTrades.length > 0) {
            Logger.debug('Already have active position');
            return false;
        }

        return true;
    }
}

// ==================== DERIV BOT ====================
class DerivBot {
    constructor() {
        this.ws = null;
        this.heartbeatInterval = null;
        this.reconnecting = false;
    }

    // Send API request
    send(request) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket not connected'));
                return;
            }

            const reqId = ++STATE.requestId;
            request.req_id = reqId;

            STATE.pendingRequests.set(reqId, { resolve, reject, timestamp: Date.now() });

            Logger.debug(`Sending request [${reqId}]`, request);
            this.ws.send(JSON.stringify(request));

            setTimeout(() => {
                if (STATE.pendingRequests.has(reqId)) {
                    STATE.pendingRequests.delete(reqId);
                    reject(new Error('Request timeout'));
                }
            }, CONFIG.REQUEST_TIMEOUT);
        });
    }

    // Connect to Deriv WebSocket
    async connect() {
        return new Promise((resolve, reject) => {
            Logger.info('🔌 Connecting to Deriv API...');

            const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${CONFIG.APP_ID}`;
            Logger.debug(`WebSocket URL: ${wsUrl}`);

            try {
                this.ws = new WebSocket(wsUrl);

                this.ws.on('open', () => {
                    STATE.isConnected = true;
                    this.reconnecting = false;
                    Logger.success('Connected to Deriv WebSocket');
                    this.startHeartbeat();
                    resolve();
                });

                this.ws.on('message', (data) => {
                    try {
                        const response = JSON.parse(data.toString());
                        this.handleMessage(response);
                    } catch (error) {
                        Logger.error('Failed to parse message', error.message);
                    }
                });

                this.ws.on('error', (error) => {
                    Logger.error('WebSocket error', error.message);
                    reject(error);
                });

                this.ws.on('close', (code, reason) => {
                    STATE.isConnected = false;
                    STATE.isAuthorized = false;
                    this.stopHeartbeat();
                    Logger.warn(`WebSocket closed. Code: ${code}`);

                    if (!this.reconnecting) {
                        this.reconnect();
                    }
                });

            } catch (error) {
                Logger.error('Failed to create WebSocket', error.message);
                reject(error);
            }
        });
    }

    // Handle incoming messages
    handleMessage(response) {
        const reqId = response.req_id;

        // Handle errors
        if (response.error) {
            Logger.error(`API Error: ${response.error.message}`, response.error);
            if (reqId && STATE.pendingRequests.has(reqId)) {
                STATE.pendingRequests.get(reqId).reject(response.error);
                STATE.pendingRequests.delete(reqId);
            }
            return;
        }

        // Handle pending request
        if (reqId && STATE.pendingRequests.has(reqId)) {
            STATE.pendingRequests.get(reqId).resolve(response);
            STATE.pendingRequests.delete(reqId);
        }

        // Handle subscription messages
        if (response.ohlc) {
            this.handleOHLC(response);
        }

        if (response.balance && !reqId) {
            STATE.account.balance = parseFloat(response.balance.balance);
            Logger.debug(`Balance updated: $${STATE.account.balance}`);
        }

        if (response.proposal_open_contract && !STATE.pendingRequests.has(reqId)) {
            this.handleContractUpdate(response);
        }
    }

    // Authorize with API token
    async authorize() {
        Logger.info('🔐 Authorizing...');

        try {
            const response = await this.send({
                authorize: CONFIG.API_TOKEN
            });

            if (response.authorize) {
                STATE.isAuthorized = true;
                STATE.account.loginid = response.authorize.loginid;
                STATE.account.balance = parseFloat(response.authorize.balance);
                STATE.account.startingBalance = STATE.account.balance;
                STATE.account.currency = response.authorize.currency;
                STATE.account.is_virtual = response.authorize.is_virtual === 1;

                Logger.success('Authorization successful');
                Logger.displayAccount();

                if (!STATE.account.is_virtual) {
                    Logger.warn('⚠️  WARNING: Trading on REAL account!');
                }

                return true;
            }
        } catch (error) {
            Logger.error('Authorization failed', error.message || error);
            throw error;
        }
    }

    // Subscribe to balance updates
    async subscribeBalance() {
        try {
            await this.send({ balance: 1, subscribe: 1 });
            Logger.info('Subscribed to balance updates');
        } catch (error) {
            Logger.error('Failed to subscribe to balance', error);
        }
    }

    // Subscribe to candles (OHLC data)
    async subscribeCandles() {
        Logger.info(`📈 Subscribing to ${CONFIG.SYMBOL} ${CONFIG.TIMEFRAME / 60}m candles...`);

        try {
            // Get historical candles first
            const history = await this.send({
                ticks_history: CONFIG.SYMBOL,
                adjust_start_time: 1,
                count: 60,
                end: 'latest',
                style: 'candles',
                granularity: CONFIG.TIMEFRAME
            });

            if (history.candles) {
                STATE.candles = history.candles.map(c => ({
                    time: c.epoch,
                    open: parseFloat(c.open),
                    high: parseFloat(c.high),
                    low: parseFloat(c.low),
                    close: parseFloat(c.close)
                }));
                Logger.success(`Loaded ${STATE.candles.length} historical candles`);

                // Update indicators immediately
                this.updateIndicators();
            }

            // Subscribe to live candles
            await this.send({
                ticks_history: CONFIG.SYMBOL,
                adjust_start_time: 1,
                count: 1,
                end: 'latest',
                style: 'candles',
                subscribe: 1,
                granularity: CONFIG.TIMEFRAME
            });

            Logger.success('Subscribed to live candles');
            STATE.trading.isActive = true;

        } catch (error) {
            Logger.error('Failed to subscribe to candles', error);
            throw error;
        }
    }

    // Update indicators
    updateIndicators() {
        if (STATE.candles.length < CONFIG.EMA_SLOW + 5) return;

        const closes = STATE.candles.map(c => c.close);
        STATE.indicators.emaFast = Indicators.calculateEMA(closes, CONFIG.EMA_FAST);
        STATE.indicators.emaSlow = Indicators.calculateEMA(closes, CONFIG.EMA_SLOW);
        STATE.indicators.rsi = Indicators.calculateRSI(closes, CONFIG.RSI_PERIOD);
        STATE.indicators.macd = Indicators.calculateMACD(closes, CONFIG.MACD_FAST, CONFIG.MACD_SLOW, CONFIG.MACD_SIGNAL);
        STATE.indicators.bb = Indicators.calculateBollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_STD_DEV);
    }

    // Handle new candle data
    handleOHLC(response) {
        const ohlc = response.ohlc;
        const candle = {
            time: parseInt(ohlc.epoch),
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close)
        };

        const candleOpenTime = parseInt(ohlc.open_time);

        // Check if new candle started (previous candle closed)
        if (STATE.currentCandleEpoch !== 0 && candleOpenTime > STATE.currentCandleEpoch) {
            Logger.info(`📊 Candle Closed | O:${candle.open.toFixed(2)} H:${candle.high.toFixed(2)} L:${candle.low.toFixed(2)} C:${candle.close.toFixed(2)}`);

            // Update candles array
            const lastCandle = STATE.candles[STATE.candles.length - 1];
            if (lastCandle && lastCandle.time === STATE.currentCandleEpoch) {
                STATE.candles[STATE.candles.length - 1] = {
                    ...lastCandle,
                    close: candle.open
                };
            }

            // Add new candle
            STATE.candles.push(candle);
            if (STATE.candles.length > 100) {
                STATE.candles.shift();
            }

            // Update indicators and analyze
            this.updateIndicators();
            Logger.displayIndicators();

            // Analyze and potentially trade on closed candle
            this.analyzeAndTrade();
        } else {
            // Update current forming candle
            const lastCandle = STATE.candles[STATE.candles.length - 1];
            if (lastCandle && lastCandle.time === candleOpenTime) {
                STATE.candles[STATE.candles.length - 1] = candle;
            }
        }

        STATE.currentCandleEpoch = candleOpenTime;
    }

    // Analyze market and execute trade if signal found
    async analyzeAndTrade() {
        if (!Strategy.shouldTrade()) {
            return;
        }

        const analysis = Strategy.analyzeMarket(STATE.candles);

        if (analysis.signal === 'CALL' || analysis.signal === 'PUT') {
            Logger.signal(`🎯 ${analysis.signal} SIGNAL DETECTED!`, { reason: analysis.reason });
            await this.executeTrade(analysis.signal);
        } else {
            Logger.debug('Market analysis', analysis);
        }
    }

    // Execute a trade
    async executeTrade(direction) {
        Logger.trade(`📝 Executing ${direction} trade...`);

        try {
            // Get proposal
            const proposalResponse = await this.send({
                proposal: 1,
                amount: CONFIG.STAKE,
                basis: 'stake',
                contract_type: direction,
                currency: STATE.account.currency,
                duration: CONFIG.CONTRACT_DURATION,
                duration_unit: CONFIG.CONTRACT_DURATION_UNIT,
                symbol: CONFIG.SYMBOL
            });

            if (!proposalResponse.proposal) {
                Logger.error('Failed to get proposal');
                return;
            }

            Logger.info('📋 Proposal received', {
                id: proposalResponse.proposal.id,
                payout: proposalResponse.proposal.payout,
                ask_price: proposalResponse.proposal.ask_price
            });

            // Buy contract
            const buyResponse = await this.send({
                buy: proposalResponse.proposal.id,
                price: CONFIG.STAKE
            });

            if (buyResponse.buy) {
                const trade = {
                    id: buyResponse.buy.contract_id,
                    type: direction,
                    entryPrice: buyResponse.buy.buy_price,
                    payout: buyResponse.buy.payout,
                    startTime: Date.now(),
                    status: 'ACTIVE',
                    currentPnL: 0
                };

                STATE.activeTrades.push(trade);
                STATE.trading.dailyTrades++;

                Logger.success('🎉 Trade executed!', {
                    contract_id: trade.id,
                    type: direction,
                    buy_price: trade.entryPrice,
                    potential_payout: trade.payout
                });

                Logger.displayActiveTrades();

                // Subscribe to contract updates
                await this.subscribeToContract(trade.id);
            }

        } catch (error) {
            Logger.error('Trade execution failed', error.message || error);
        }
    }

    // Subscribe to contract updates
    async subscribeToContract(contractId) {
        try {
            await this.send({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1
            });
            Logger.debug(`Subscribed to contract ${contractId}`);
        } catch (error) {
            Logger.error('Failed to subscribe to contract', error);
        }
    }

    // Handle contract updates
    handleContractUpdate(response) {
        const contract = response.proposal_open_contract;
        if (!contract) return;

        const contractId = contract.contract_id;

        // Find active trade
        const tradeIndex = STATE.activeTrades.findIndex(t => t.id === contractId);
        if (tradeIndex === -1) return;

        const trade = STATE.activeTrades[tradeIndex];
        trade.currentPnL = parseFloat(contract.profit || 0);
        trade.status = contract.status;

        // Check for SL/TP while contract is open
        if (!contract.is_sold && !contract.is_expired) {
            // Take Profit
            if (trade.currentPnL >= CONFIG.TAKE_PROFIT) {
                Logger.success(`🎯 Take Profit reached! +$${trade.currentPnL.toFixed(2)}`);
                this.sellContract(contractId);
                return;
            }
            // Stop Loss
            if (trade.currentPnL <= -CONFIG.STOP_LOSS) {
                Logger.warn(`🛑 Stop Loss triggered! $${trade.currentPnL.toFixed(2)}`);
                this.sellContract(contractId);
                return;
            }
        }

        // Check if contract is closed
        if (contract.is_sold || contract.is_expired || contract.status === 'sold' || contract.status === 'won' || contract.status === 'lost') {
            trade.finalPnL = trade.currentPnL;
            trade.endTime = Date.now();
            trade.result = contract.status;

            // Move to completed trades
            STATE.completedTrades.unshift(trade);
            STATE.activeTrades.splice(tradeIndex, 1);
            STATE.trading.dailyPnL += trade.finalPnL;

            if (trade.finalPnL > 0) {
                STATE.trading.consecutiveLosses = 0;
                Logger.success(`🎉 Trade WON! Profit: +$${trade.finalPnL.toFixed(2)}`);
            } else {
                STATE.trading.consecutiveLosses++;
                STATE.trading.dailyLoss += Math.abs(trade.finalPnL);
                Logger.warn(`😢 Trade LOST! Loss: $${trade.finalPnL.toFixed(2)}`);

                // Check consecutive loss limit
                if (STATE.trading.consecutiveLosses >= CONFIG.CONSECUTIVE_LOSS_LIMIT) {
                    STATE.trading.pausedUntil = Date.now() + (CONFIG.BREAK_DURATION_MINUTES * 60000);
                    Logger.warn(`🛑 ${CONFIG.CONSECUTIVE_LOSS_LIMIT} consecutive losses - pausing for ${CONFIG.BREAK_DURATION_MINUTES} minutes`);
                }
            }

            Logger.displayCompletedTrades();
            Logger.displayStats();
        }
    }

    // Sell contract early
    async sellContract(contractId) {
        try {
            await this.send({
                sell: contractId,
                price: 0
            });
            Logger.info(`Contract ${contractId} sold`);
        } catch (error) {
            Logger.error('Failed to sell contract', error);
        }
    }

    // Start heartbeat to keep connection alive
    startHeartbeat() {
        this.heartbeatInterval = setInterval(async () => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                    await this.send({ ping: 1 });
                    Logger.debug('🏓 Ping sent');
                } catch (error) {
                    Logger.debug('Ping failed', error.message);
                }
            }
        }, CONFIG.HEARTBEAT_INTERVAL);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    // Reconnect on disconnect
    async reconnect() {
        if (this.reconnecting) return;
        this.reconnecting = true;

        Logger.info(`🔄 Reconnecting in ${CONFIG.RECONNECT_INTERVAL / 1000}s...`);

        setTimeout(async () => {
            try {
                await this.connect();
                await this.authorize();
                await this.subscribeBalance();
                await this.subscribeCandles();
                Logger.success('Reconnected successfully');
            } catch (error) {
                Logger.error('Reconnection failed', error.message);
                this.reconnecting = false;
                this.reconnect();
            }
        }, CONFIG.RECONNECT_INTERVAL);
    }

    // Stop the bot
    stop() {
        STATE.trading.isActive = false;
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.close();
        }
        Logger.warn('🛑 Bot stopped');
        Logger.displayStats();
        Logger.displayCompletedTrades();
    }

    // Start the bot
    async start() {
        Logger.displayBanner();
        Logger.displayConfig();

        try {
            await this.connect();
            await this.authorize();
            await this.subscribeBalance();
            await this.subscribeCandles();

            Logger.success('🚀 Trading bot started successfully!');
            Logger.info('⏳ Waiting for trading signals...');
            Logger.displayStats();

        } catch (error) {
            Logger.error('Failed to start bot', error.message || error);
            process.exit(1);
        }
    }
}

// ==================== MAIN EXECUTION ====================
// Validate API token
if (!CONFIG.API_TOKEN || CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.error(`${C.red}${C.bright}ERROR: Please set your Deriv API token in CONFIG.API_TOKEN${C.reset}`);
    console.error(`${C.yellow}Get your token from: https://app.deriv.com/account/api-token${C.reset}`);
    process.exit(1);
}

// Check for ws module
try {
    require.resolve('ws');
} catch (e) {
    console.error(`${C.red}${C.bright}ERROR: Missing 'ws' module. Please run: npm install ws${C.reset}`);
    process.exit(1);
}

// Create and start bot
const bot = new DerivBot();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n');
    Logger.warn('🛑 Shutting down bot...');

    if (STATE.activeTrades.length > 0) {
        Logger.warn(`⚠️  ${STATE.activeTrades.length} active trade(s) will continue on Deriv`);
    }

    bot.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    bot.stop();
    process.exit(0);
});

process.on('unhandledRejection', (error) => {
    Logger.error('Unhandled rejection', error.message || error);
});

// Start the bot
bot.start();

module.exports = { DerivBot, Strategy, Indicators, CONFIG };
