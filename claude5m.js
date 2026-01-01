#!/usr/bin/env node

/**
 * DERIV 5-MINUTE SCALPING BOT (Node.js Version)
 * 
 * A fully automated trading bot implementing a 5-minute scalping strategy
 * for Deriv Synthetic Indices (Volatility 10, 25, 50, 75, 100)
 * 
 * SETUP INSTRUCTIONS:
 * 1. Install dependencies: npm install ws
 * 2. Get your API token from: https://app.deriv.com/account/api-token
 * 3. Set your credentials below in the CONFIG section
 * 4. Run: node bot.js
 * 
 * SAFETY WARNINGS:
 * - Start with DEMO account only
 * - Test thoroughly before going live
 * - Never risk more than 1% per trade
 * - Monitor the bot closely during first trades
 * 
 * @version 2.0.0
 */

const WebSocket = require('ws');

// ========================================
// CONFIGURATION
// ========================================
const CONFIG = {
    // API Credentials (REQUIRED)
    APP_ID: '1089',                    // Default demo app_id (replace with yours)
    API_TOKEN: '0P94g4WdSrSrzir',  // Replace with your token from app.deriv.com

    // Trading Parameters
    SYMBOL: 'R_25',                    // Volatility 25 (Options: R_10, R_25, R_50, R_75, R_100)
    TIMEFRAME: 300,                    // 5 minutes in seconds (M5)

    // Risk Management
    STAKE_AMOUNT: 1,                   // USD per trade
    MAX_TRADES_PER_SESSION: 50,
    MAX_CONSECUTIVE_LOSSES: 20,
    DAILY_LOSS_LIMIT_PERCENT: 30,

    // Strategy Parameters
    EMA_FAST: 8,
    EMA_MEDIUM: 21,
    EMA_SLOW: 50,
    STOCHASTIC_K: 5,
    STOCHASTIC_OVERBOUGHT: 80,
    STOCHASTIC_OVERSOLD: 20,

    // Bot Settings
    TRADE_ENABLED: true,
    LOG_LEVEL: 'INFO',                 // 'DEBUG', 'INFO', 'WARN', 'ERROR'
    RECONNECT_DELAY: 5000,             // Reconnect delay in ms
};

// ========================================
// GLOBAL STATE
// ========================================
const STATE = {
    connected: false,
    authorized: false,
    tradingActive: false,
    balance: 0,
    currency: 'USD',
    candles: [],
    tradesCount: 0,
    consecutiveLosses: 0,
    dailyPnL: 0,
    activeTrades: [],
    completedTrades: [],
    indicators: {
        ema8: null,
        ema21: null,
        ema50: null,
        stochK: null
    }
};

// ========================================
// COLORS FOR TERMINAL OUTPUT
// ========================================
const COLORS = {
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

// ========================================
// LOGGER
// ========================================
class Logger {
    static levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, SUCCESS: 1 };

    static getTimestamp() {
        return new Date().toISOString().replace('T', ' ').substring(0, 19);
    }

    static log(level, message, data = null) {
        if (this.levels[level] === undefined || this.levels[level] < this.levels[CONFIG.LOG_LEVEL]) {
            return;
        }

        const timestamp = this.getTimestamp();
        const levelColors = {
            DEBUG: COLORS.dim,
            INFO: COLORS.blue,
            WARN: COLORS.yellow,
            ERROR: COLORS.red,
            SUCCESS: COLORS.green
        };

        const levelIcons = {
            DEBUG: '🔍',
            INFO: 'ℹ️ ',
            WARN: '⚠️ ',
            ERROR: '❌',
            SUCCESS: '✅'
        };

        const color = levelColors[level] || COLORS.white;
        const icon = levelIcons[level] || '';

        console.log(`${COLORS.dim}[${timestamp}]${COLORS.reset} ${color}[${level}]${COLORS.reset} ${icon} ${message}`);

        if (data) {
            if (typeof data === 'object') {
                console.log(`${COLORS.dim}${JSON.stringify(data, null, 2)}${COLORS.reset}`);
            } else {
                console.log(`${COLORS.dim}${data}${COLORS.reset}`);
            }
        }
    }

    static debug(msg, data) { this.log('DEBUG', msg, data); }
    static info(msg, data) { this.log('INFO', msg, data); }
    static warn(msg, data) { this.log('WARN', msg, data); }
    static error(msg, data) { this.log('ERROR', msg, data); }
    static success(msg, data) { this.log('SUCCESS', msg, data); }

    static trade(type, message, data = null) {
        const color = type === 'BUY' ? COLORS.green : type === 'SELL' ? COLORS.red : COLORS.cyan;
        const timestamp = this.getTimestamp();
        console.log(`${COLORS.dim}[${timestamp}]${COLORS.reset} ${color}${COLORS.bright}[TRADE]${COLORS.reset} ${message}`);
        if (data) {
            console.log(`${COLORS.dim}${JSON.stringify(data, null, 2)}${COLORS.reset}`);
        }
    }

    static displayActiveTrades() {
        console.log(`\n${COLORS.cyan}${COLORS.bright}═══════════════════════════════════════════════════════════${COLORS.reset}`);
        console.log(`${COLORS.cyan}${COLORS.bright}                    🔥 ACTIVE TRADES (${STATE.activeTrades.length})${COLORS.reset}`);
        console.log(`${COLORS.cyan}${COLORS.bright}═══════════════════════════════════════════════════════════${COLORS.reset}`);

        if (STATE.activeTrades.length === 0) {
            console.log(`${COLORS.dim}  No active trades${COLORS.reset}`);
        } else {
            STATE.activeTrades.forEach((trade, idx) => {
                const pnlColor = (trade.currentPnL || 0) >= 0 ? COLORS.green : COLORS.red;
                console.log(`  ${COLORS.bright}#${idx + 1}${COLORS.reset} | ${trade.type} | ID: ${trade.id}`);
                console.log(`      Entry: $${trade.entryPrice?.toFixed(2)} | P&L: ${pnlColor}$${(trade.currentPnL || 0).toFixed(2)}${COLORS.reset} | Status: ${trade.status}`);
            });
        }
        console.log(`${COLORS.cyan}═══════════════════════════════════════════════════════════${COLORS.reset}\n`);
    }

    static displayCompletedTrades() {
        console.log(`\n${COLORS.magenta}${COLORS.bright}═══════════════════════════════════════════════════════════${COLORS.reset}`);
        console.log(`${COLORS.magenta}${COLORS.bright}                  ✅ COMPLETED TRADES (${STATE.completedTrades.length})${COLORS.reset}`);
        console.log(`${COLORS.magenta}${COLORS.bright}═══════════════════════════════════════════════════════════${COLORS.reset}`);

        if (STATE.completedTrades.length === 0) {
            console.log(`${COLORS.dim}  No completed trades${COLORS.reset}`);
        } else {
            STATE.completedTrades.slice(0, 10).forEach((trade, idx) => {
                const pnlColor = trade.finalPnL >= 0 ? COLORS.green : COLORS.red;
                const resultIcon = trade.finalPnL >= 0 ? '🎉' : '😢';
                console.log(`  ${COLORS.bright}#${idx + 1}${COLORS.reset} | ${trade.type} | ID: ${trade.id}`);
                console.log(`      ${resultIcon} Result: ${trade.result?.toUpperCase()} | P&L: ${pnlColor}$${trade.finalPnL.toFixed(2)}${COLORS.reset}`);
            });
        }
        console.log(`${COLORS.magenta}═══════════════════════════════════════════════════════════${COLORS.reset}\n`);
    }

    static displayStats() {
        const pnlColor = STATE.dailyPnL >= 0 ? COLORS.green : COLORS.red;
        console.log(`\n${COLORS.yellow}${COLORS.bright}═══════════════════════════════════════════════════════════${COLORS.reset}`);
        console.log(`${COLORS.yellow}${COLORS.bright}                       📊 SESSION STATS${COLORS.reset}`);
        console.log(`${COLORS.yellow}${COLORS.bright}═══════════════════════════════════════════════════════════${COLORS.reset}`);
        console.log(`  💰 Balance:           $${STATE.balance.toFixed(2)} ${STATE.currency}`);
        console.log(`  📈 Daily P&L:         ${pnlColor}$${STATE.dailyPnL.toFixed(2)}${COLORS.reset}`);
        console.log(`  🔢 Total Trades:      ${STATE.tradesCount}`);
        console.log(`  🔥 Active Trades:     ${STATE.activeTrades.length}`);
        console.log(`  ✅ Completed Trades:  ${STATE.completedTrades.length}`);
        console.log(`  📉 Consecutive Losses: ${STATE.consecutiveLosses}`);
        console.log(`${COLORS.yellow}═══════════════════════════════════════════════════════════${COLORS.reset}\n`);
    }

    static displayIndicators() {
        console.log(`\n${COLORS.blue}${COLORS.bright}═══════════════════════════════════════════════════════════${COLORS.reset}`);
        console.log(`${COLORS.blue}${COLORS.bright}                     📉 MARKET INDICATORS${COLORS.reset}`);
        console.log(`${COLORS.blue}${COLORS.bright}═══════════════════════════════════════════════════════════${COLORS.reset}`);
        console.log(`  EMA 8:       ${STATE.indicators.ema8?.toFixed(5) || '--'}`);
        console.log(`  EMA 21:      ${STATE.indicators.ema21?.toFixed(5) || '--'}`);
        console.log(`  EMA 50:      ${STATE.indicators.ema50?.toFixed(5) || '--'}`);
        console.log(`  Stoch %K:    ${STATE.indicators.stochK?.toFixed(2) || '--'}`);
        console.log(`${COLORS.blue}═══════════════════════════════════════════════════════════${COLORS.reset}\n`);
    }
}

// ========================================
// TECHNICAL INDICATORS
// ========================================
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

    static calculateStochastic(highs, lows, closes, period) {
        if (closes.length < period) return null;

        const recentHighs = highs.slice(-period);
        const recentLows = lows.slice(-period);
        const currentClose = closes[closes.length - 1];

        const highestHigh = Math.max(...recentHighs);
        const lowestLow = Math.min(...recentLows);

        if (highestHigh === lowestLow) return 50;
        return ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
    }
}

// ========================================
// TRADING STRATEGY
// ========================================
class Strategy {
    static analyzeMarket(candles) {
        if (candles.length < CONFIG.EMA_SLOW) {
            Logger.debug('Insufficient candles for analysis');
            return { signal: 'WAIT', reason: 'Insufficient data' };
        }

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);

        // Calculate indicators
        const ema8 = Indicators.calculateEMA(closes, CONFIG.EMA_FAST);
        const ema21 = Indicators.calculateEMA(closes, CONFIG.EMA_MEDIUM);
        const ema50 = Indicators.calculateEMA(closes, CONFIG.EMA_SLOW);
        const stochK = Indicators.calculateStochastic(highs, lows, closes, CONFIG.STOCHASTIC_K);

        // Store in state
        STATE.indicators = { ema8, ema21, ema50, stochK };

        const currentPrice = closes[closes.length - 1];

        Logger.debug('Indicators calculated', {
            price: currentPrice.toFixed(5),
            ema8: ema8?.toFixed(5),
            ema21: ema21?.toFixed(5),
            ema50: ema50?.toFixed(5),
            stochK: stochK?.toFixed(2)
        });

        return this.checkEntrySignals(currentPrice, ema8, ema21, ema50, stochK);
    }

    static checkEntrySignals(price, ema8, ema21, ema50, stochK) {
        // LONG CONDITIONS
        const longTrend = price > ema50;
        const longEmaAlignment = ema8 > ema21 && ema21 > ema50;
        const longStochastic = stochK < CONFIG.STOCHASTIC_OVERSOLD;
        const longPullback = price <= ema21;

        if (longTrend && longEmaAlignment && longStochastic && longPullback) {
            Logger.info(`${COLORS.green}🟢 LONG SIGNAL DETECTED${COLORS.reset}`);
            return {
                signal: 'LONG',
                reason: 'Uptrend + EMA alignment + Oversold stochastic + Pullback',
                confidence: 'HIGH'
            };
        }

        // SHORT CONDITIONS
        const shortTrend = price < ema50;
        const shortEmaAlignment = ema8 < ema21 && ema21 < ema50;
        const shortStochastic = stochK > CONFIG.STOCHASTIC_OVERBOUGHT;
        const shortPullback = price >= ema21;

        if (shortTrend && shortEmaAlignment && shortStochastic && shortPullback) {
            Logger.info(`${COLORS.red}🔴 SHORT SIGNAL DETECTED${COLORS.reset}`);
            return {
                signal: 'SHORT',
                reason: 'Downtrend + EMA alignment + Overbought stochastic + Pullback',
                confidence: 'HIGH'
            };
        }

        return { signal: 'WAIT', reason: 'No clear setup' };
    }

    static shouldTrade() {
        if (STATE.tradesCount >= CONFIG.MAX_TRADES_PER_SESSION) {
            Logger.warn(`Max trades reached: ${STATE.tradesCount}`);
            return false;
        }

        if (STATE.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
            Logger.warn(`Max consecutive losses: ${STATE.consecutiveLosses}`);
            return false;
        }

        const maxDailyLoss = (STATE.balance * CONFIG.DAILY_LOSS_LIMIT_PERCENT) / 100;
        if (STATE.dailyPnL <= -maxDailyLoss) {
            Logger.warn(`Daily loss limit reached: $${STATE.dailyPnL.toFixed(2)}`);
            return false;
        }

        if (STATE.activeTrades.length > 0) {
            Logger.debug('Already in position');
            return false;
        }

        return true;
    }
}

// ========================================
// DERIV BOT
// ========================================
class DerivBot {
    constructor() {
        this.ws = null;
        this.reqId = 0;
        this.pendingRequests = {};
        this.subscriptions = {};
        this.pingInterval = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
    }

    // Send request to API
    send(request) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket not connected'));
                return;
            }

            const reqId = ++this.reqId;
            request.req_id = reqId;

            this.pendingRequests[reqId] = { resolve, reject };

            Logger.debug(`Sending request [${reqId}]`, request);
            this.ws.send(JSON.stringify(request));

            // Timeout after 30 seconds
            setTimeout(() => {
                if (this.pendingRequests[reqId]) {
                    delete this.pendingRequests[reqId];
                    reject(new Error('Request timeout'));
                }
            }, 30000);
        });
    }

    // Connect to Deriv WebSocket API
    async connect() {
        return new Promise((resolve, reject) => {
            Logger.info('🔌 Connecting to Deriv API...');

            const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${CONFIG.APP_ID}`;
            Logger.debug(`WebSocket URL: ${wsUrl}`);

            try {
                this.ws = new WebSocket(wsUrl);

                this.ws.on('open', () => {
                    STATE.connected = true;
                    this.reconnectAttempts = 0;
                    Logger.success('Connected to Deriv WebSocket');
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
                    STATE.connected = false;
                    STATE.authorized = false;
                    Logger.warn(`WebSocket closed. Code: ${code}, Reason: ${reason || 'Unknown'}`);

                    if (this.pingInterval) {
                        clearInterval(this.pingInterval);
                    }

                    // Auto reconnect
                    if (this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.reconnectAttempts++;
                        Logger.info(`Reconnecting in ${CONFIG.RECONNECT_DELAY / 1000}s... (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
                        setTimeout(() => this.reconnect(), CONFIG.RECONNECT_DELAY);
                    } else {
                        Logger.error('Max reconnection attempts reached. Exiting...');
                        process.exit(1);
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
            if (this.pendingRequests[reqId]) {
                this.pendingRequests[reqId].reject(response.error);
                delete this.pendingRequests[reqId];
            }
            return;
        }

        // Handle pending request
        if (reqId && this.pendingRequests[reqId]) {
            this.pendingRequests[reqId].resolve(response);
            delete this.pendingRequests[reqId];
        }

        // Handle subscription messages (no req_id match)
        if (response.ohlc) {
            this.handleOHLC(response);
        }

        if (response.balance && !reqId) {
            this.handleBalance(response);
        }

        if (response.proposal_open_contract && !this.pendingRequests[reqId]) {
            this.handleProposalOpenContract(response);
        }
    }

    // Authorize with API token
    async authorize() {
        if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
            Logger.error('⚠️  Please set your API token in CONFIG.API_TOKEN');
            process.exit(1);
        }

        Logger.info('🔐 Authorizing...');

        try {
            const response = await this.send({
                authorize: CONFIG.API_TOKEN
            });

            if (response.authorize) {
                STATE.authorized = true;
                STATE.balance = parseFloat(response.authorize.balance);
                STATE.currency = response.authorize.currency;

                Logger.success('Authorization successful', {
                    account: response.authorize.loginid,
                    balance: `${STATE.balance} ${STATE.currency}`,
                    country: response.authorize.country,
                    is_virtual: response.authorize.is_virtual ? 'DEMO' : 'REAL'
                });

                if (response.authorize.is_virtual) {
                    Logger.info('📌 Trading on DEMO account');
                } else {
                    Logger.warn('⚠️  Trading on REAL account - Be careful!');
                }

                return true;
            }
        } catch (error) {
            Logger.error('Authorization failed', error.message || error);
            process.exit(1);
        }
    }

    // Subscribe to balance updates
    async subscribeToBalance() {
        try {
            await this.send({
                balance: 1,
                subscribe: 1
            });
            Logger.info('Subscribed to balance updates');
        } catch (error) {
            Logger.error('Failed to subscribe to balance', error);
        }
    }

    handleBalance(response) {
        STATE.balance = parseFloat(response.balance.balance);
        STATE.currency = response.balance.currency;
        Logger.debug(`Balance updated: ${STATE.balance} ${STATE.currency}`);
    }

    // Start trading
    async startTrading() {
        STATE.tradingActive = true;

        Logger.success('🚀 Trading bot started!');
        Logger.info(`📊 Symbol: ${CONFIG.SYMBOL} | Timeframe: ${CONFIG.TIMEFRAME}s`);
        Logger.info(`💵 Stake: ${CONFIG.STAKE_AMOUNT} ${STATE.currency}`);

        // Subscribe to balance
        await this.subscribeToBalance();

        // Subscribe to candles
        await this.subscribeToCandles();

        // Start ping interval
        this.startPingInterval();

        // Display initial stats
        Logger.displayStats();
    }

    // Subscribe to candle data
    async subscribeToCandles() {
        Logger.info(`📈 Subscribing to ${CONFIG.SYMBOL} candles...`);

        try {
            // Get historical candles
            const history = await this.send({
                ticks_history: CONFIG.SYMBOL,
                adjust_start_time: 1,
                count: CONFIG.EMA_SLOW + 10,
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

        } catch (error) {
            Logger.error('Failed to subscribe to candles', error);
        }
    }

    handleOHLC(response) {
        const ohlc = response.ohlc;
        const candle = {
            time: parseInt(ohlc.epoch),
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close)
        };

        // Update or add candle
        const lastCandle = STATE.candles[STATE.candles.length - 1];
        if (lastCandle && lastCandle.time === candle.time) {
            STATE.candles[STATE.candles.length - 1] = candle;
        } else {
            STATE.candles.push(candle);
            if (STATE.candles.length > CONFIG.EMA_SLOW + 20) {
                STATE.candles.shift();
            }

            Logger.debug(`📊 New Candle: O:${candle.open.toFixed(5)} H:${candle.high.toFixed(5)} L:${candle.low.toFixed(5)} C:${candle.close.toFixed(5)}`);

            // Analyze and potentially trade
            if (STATE.tradingActive && CONFIG.TRADE_ENABLED) {
                this.analyzeAndTrade();
            }
        }
    }

    async analyzeAndTrade() {
        if (!Strategy.shouldTrade()) {
            return;
        }

        const analysis = Strategy.analyzeMarket(STATE.candles);

        if (analysis.signal === 'LONG' || analysis.signal === 'SHORT') {
            Logger.info(`📢 Signal: ${analysis.signal}`, analysis);
            Logger.displayIndicators();
            await this.executeTrade(analysis.signal);
        }
    }

    async executeTrade(direction) {
        const contractType = direction === 'LONG' ? 'CALL' : 'PUT';

        Logger.trade('BUY', `🎯 Executing ${contractType} trade...`);

        try {
            // Get proposal
            const proposalResponse = await this.send({
                proposal: 1,
                amount: CONFIG.STAKE_AMOUNT,
                basis: 'stake',
                contract_type: contractType,
                currency: STATE.currency,
                duration: 5,
                duration_unit: 'm',
                symbol: CONFIG.SYMBOL
            });

            if (!proposalResponse.proposal) {
                Logger.error('Failed to get proposal');
                return;
            }

            Logger.info('📋 Proposal received', {
                payout: proposalResponse.proposal.payout,
                ask_price: proposalResponse.proposal.ask_price
            });

            // Buy contract
            const buyResponse = await this.send({
                buy: proposalResponse.proposal.id,
                price: CONFIG.STAKE_AMOUNT
            });

            if (buyResponse.buy) {
                const trade = {
                    id: buyResponse.buy.contract_id,
                    type: contractType,
                    direction: direction,
                    entryPrice: buyResponse.buy.buy_price,
                    payout: buyResponse.buy.payout,
                    startTime: Date.now(),
                    status: 'ACTIVE',
                    currentPnL: 0
                };

                STATE.activeTrades.push(trade);
                STATE.tradesCount++;

                Logger.success('Trade executed!', {
                    contract_id: trade.id,
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

    handleProposalOpenContract(response) {
        const contract = response.proposal_open_contract;
        const contractId = contract.contract_id;

        // Find active trade
        const tradeIndex = STATE.activeTrades.findIndex(t => t.id === contractId);
        if (tradeIndex === -1) return;

        const trade = STATE.activeTrades[tradeIndex];
        trade.currentPnL = parseFloat(contract.profit || 0);
        trade.status = contract.status;

        // Check if closed
        if (contract.status === 'sold' || contract.status === 'won' || contract.status === 'lost') {
            // Move to completed
            trade.finalPnL = trade.currentPnL;
            trade.endTime = Date.now();
            trade.result = contract.status;

            STATE.completedTrades.unshift(trade);
            STATE.activeTrades.splice(tradeIndex, 1);
            STATE.dailyPnL += trade.finalPnL;

            if (trade.finalPnL > 0) {
                STATE.consecutiveLosses = 0;
                Logger.success(`🎉 Trade WON! Profit: +$${trade.finalPnL.toFixed(2)}`);
            } else {
                STATE.consecutiveLosses++;
                Logger.warn(`😢 Trade LOST! Loss: $${trade.finalPnL.toFixed(2)}`);
            }

            // Display updates
            Logger.displayCompletedTrades();
            Logger.displayStats();
        }
    }

    startPingInterval() {
        this.pingInterval = setInterval(async () => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                    await this.send({ ping: 1 });
                    Logger.debug('🏓 Ping sent');
                } catch (error) {
                    Logger.error('Ping failed', error);
                }
            }
        }, 30000);
    }

    async reconnect() {
        Logger.info('🔄 Attempting to reconnect...');
        try {
            await this.connect();
            await this.authorize();
            await this.startTrading();
        } catch (error) {
            Logger.error('Reconnection failed', error);
        }
    }

    stopTrading() {
        STATE.tradingActive = false;
        Logger.warn('🛑 Trading bot stopped');

        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }

        Logger.displayStats();
        Logger.displayCompletedTrades();
    }

    disconnect() {
        this.stopTrading();
        if (this.ws) {
            this.ws.close();
        }
    }
}

// ========================================
// MAIN
// ========================================
async function main() {
    console.log(`
${COLORS.cyan}${COLORS.bright}╔════════════════════════════════════════════════════════════╗
║                                                            ║
║       🤖 DERIV 5-MINUTE SCALPING BOT v2.0                  ║
║       Automated Trading System (Node.js)                   ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝${COLORS.reset}
    `);

    Logger.info('⚙️  Configuration loaded');
    Logger.info(`Symbol: ${CONFIG.SYMBOL}`);
    Logger.info(`Timeframe: ${CONFIG.TIMEFRAME}s (${CONFIG.TIMEFRAME / 60} minutes)`);
    Logger.info(`Stake: $${CONFIG.STAKE_AMOUNT}`);
    Logger.info(`Max trades per session: ${CONFIG.MAX_TRADES_PER_SESSION}`);
    Logger.info(`Max consecutive losses: ${CONFIG.MAX_CONSECUTIVE_LOSSES}`);

    const bot = new DerivBot();

    try {
        // Connect to API
        await bot.connect();

        // Authorize
        await bot.authorize();

        // Start trading
        await bot.startTrading();

    } catch (error) {
        Logger.error('Failed to start bot', error);
        process.exit(1);
    }

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n');
        Logger.warn('🛑 Shutting down bot...');

        if (STATE.activeTrades.length > 0) {
            Logger.warn(`⚠️  ${STATE.activeTrades.length} active trade(s) detected. They will continue on Deriv.`);
        }

        Logger.displayStats();
        Logger.displayCompletedTrades();

        bot.disconnect();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        Logger.warn('Received SIGTERM');
        bot.disconnect();
        process.exit(0);
    });
}

// ========================================
// START BOT
// ========================================
main().catch((error) => {
    Logger.error('Fatal error', error);
    process.exit(1);
});

module.exports = { DerivBot, Strategy, Indicators, CONFIG };
