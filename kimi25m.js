#!/usr/bin/env node

/**
 * DERIV V75 5-MINUTE SCALPING BOT
 * Fixed Node.js Implementation with Proper Logging
 * 
 * INSTALLATION:
 * 1. npm install ws
 * 2. Configure API_TOKEN below
 * 3. node bot.js
 */

const WebSocket = require('ws');
const fs = require('fs');

// ==================== CONFIGURATION ====================
const CONFIG = {
    // API Credentials
    API_TOKEN: '0P94g4WdSrSrzir',  // Replace with your token from app.deriv.com
    APP_ID: 1089,

    // Trading Parameters
    SYMBOL: 'R_75',
    TIMEFRAME: 300,
    STAKE_AMOUNT: 1,
    CONTRACT_DURATION: 5,
    CONTRACT_DURATION_UNIT: 'm',
    MAX_TRADES_PER_DAY: 10,

    // Risk Management
    MAX_CONSECUTIVE_LOSSES: 3,
    DAILY_LOSS_LIMIT_PERCENT: 5,

    // Strategy Parameters
    EMA_FAST: 8,
    EMA_MEDIUM: 21,
    EMA_SLOW: 50,
    STOCHASTIC_K: 5,
    STOCHASTIC_D: 3,
    STOCHASTIC_OVERBOUGHT: 80,
    STOCHASTIC_OVERSOLD: 20,

    // Connection Settings
    RECONNECT_INTERVAL: 5000,
    HEARTBEAT_INTERVAL: 30000,
    REQUEST_TIMEOUT: 30000,

    // Logging
    LOG_LEVEL: 'INFO',
    ENABLE_FILE_LOG: true,
    LOG_FILE: 'bot.log'
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
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
};

// ==================== GLOBAL STATE ====================
const STATE = {
    ws: null,
    isConnected: false,
    isAuthorized: false,
    account: {
        balance: 0,
        currency: 'USD',
        loginid: '',
        is_virtual: true
    },
    candles: [],
    indicators: {
        ema8: null,
        ema21: null,
        ema50: null,
        stochK: null
    },
    trading: {
        isActive: false,
        dailyTrades: 0,
        dailyPnL: 0,
        consecutiveLosses: 0,
        lastTradeDate: new Date().toDateString()
    },
    activeTrades: [],
    completedTrades: [],
    subscriptions: new Map(),
    pendingRequests: new Map(),
    requestId: 0
};

// ==================== LOGGER ====================
class Logger {
    static levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, SUCCESS: 1, TRADE: 1 };

    static getTimestamp() {
        return new Date().toISOString().replace('T', ' ').substring(0, 19);
    }

    static log(level, message, data = null) {
        if (this.levels[level] === undefined) return;
        if (this.levels[level] < this.levels[CONFIG.LOG_LEVEL]) return;

        const timestamp = this.getTimestamp();
        const icons = {
            DEBUG: '🔍', INFO: 'ℹ️ ', WARN: '⚠️ ', ERROR: '❌', SUCCESS: '✅', TRADE: '💹'
        };
        const colors = {
            DEBUG: C.dim, INFO: C.blue, WARN: C.yellow, ERROR: C.red, SUCCESS: C.green, TRADE: C.magenta
        };

        const icon = icons[level] || '';
        const color = colors[level] || C.white;

        console.log(`${C.dim}[${timestamp}]${C.reset} ${color}[${level}]${C.reset} ${icon} ${message}`);

        if (data) {
            const dataStr = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
            console.log(`${C.dim}${dataStr}${C.reset}`);
        }

        // File logging
        if (CONFIG.ENABLE_FILE_LOG) {
            const logEntry = `[${timestamp}] [${level}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`;
            fs.appendFileSync(CONFIG.LOG_FILE, logEntry);
        }
    }

    static debug(msg, data) { this.log('DEBUG', msg, data); }
    static info(msg, data) { this.log('INFO', msg, data); }
    static warn(msg, data) { this.log('WARN', msg, data); }
    static error(msg, data) { this.log('ERROR', msg, data); }
    static success(msg, data) { this.log('SUCCESS', msg, data); }
    static trade(msg, data) { this.log('TRADE', msg, data); }

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
║       🤖 DERIV V75 5-MINUTE SCALPING BOT                   ║
║       Node.js Automated Trading System                     ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝${C.reset}
        `);
    }

    static displayConfig() {
        this.separator('⚙️  CONFIGURATION');
        console.log(`  Symbol:          ${C.bright}${CONFIG.SYMBOL}${C.reset}`);
        console.log(`  Timeframe:       ${C.bright}${CONFIG.TIMEFRAME}s (${CONFIG.TIMEFRAME / 60} minutes)${C.reset}`);
        console.log(`  Stake:           ${C.bright}$${CONFIG.STAKE_AMOUNT}${C.reset}`);
        console.log(`  Duration:        ${C.bright}${CONFIG.CONTRACT_DURATION}${CONFIG.CONTRACT_DURATION_UNIT}${C.reset}`);
        console.log(`  Max Daily Trades: ${C.bright}${CONFIG.MAX_TRADES_PER_DAY}${C.reset}`);
        console.log(`  Max Consec. Loss: ${C.bright}${CONFIG.MAX_CONSECUTIVE_LOSSES}${C.reset}`);
        console.log('');
    }

    static displayAccount() {
        this.separator('💰 ACCOUNT INFO');
        const accType = STATE.account.is_virtual ? `${C.yellow}DEMO${C.reset}` : `${C.red}${C.bright}REAL${C.reset}`;
        console.log(`  Login ID:    ${C.bright}${STATE.account.loginid}${C.reset}`);
        console.log(`  Account:     ${accType}`);
        console.log(`  Balance:     ${C.green}${C.bright}$${STATE.account.balance.toFixed(2)} ${STATE.account.currency}${C.reset}`);
        console.log('');
    }

    static displayIndicators() {
        this.separator('📊 MARKET INDICATORS');
        const { ema8, ema21, ema50, stochK } = STATE.indicators;
        console.log(`  EMA 8:       ${ema8 ? ema8.toFixed(5) : '--'}`);
        console.log(`  EMA 21:      ${ema21 ? ema21.toFixed(5) : '--'}`);
        console.log(`  EMA 50:      ${ema50 ? ema50.toFixed(5) : '--'}`);
        console.log(`  Stoch %K:    ${stochK ? stochK.toFixed(2) : '--'}`);
        console.log('');
    }

    static displayActiveTrades() {
        this.separator(`🔥 ACTIVE TRADES (${STATE.activeTrades.length})`);

        if (STATE.activeTrades.length === 0) {
            console.log(`  ${C.dim}No active trades${C.reset}`);
        } else {
            STATE.activeTrades.forEach((trade, idx) => {
                const pnlColor = (trade.currentPnL || 0) >= 0 ? C.green : C.red;
                const dirColor = trade.direction === 'LONG' ? C.green : C.red;
                console.log(`  ${C.bright}#${idx + 1}${C.reset} | ${dirColor}${trade.type}${C.reset} | ID: ${trade.id}`);
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
                console.log(`  ${C.bright}#${idx + 1}${C.reset} | ${trade.type} | ID: ${trade.id}`);
                console.log(`      ${resultIcon} ${result} | P&L: ${pnlColor}$${trade.finalPnL.toFixed(2)}${C.reset} | ${new Date(trade.endTime).toLocaleTimeString()}`);
            });
        }
        console.log('');
    }

    static displayStats() {
        this.separator('📈 SESSION STATISTICS');
        const pnlColor = STATE.trading.dailyPnL >= 0 ? C.green : C.red;
        console.log(`  💰 Balance:            ${C.green}$${STATE.account.balance.toFixed(2)}${C.reset}`);
        console.log(`  📊 Daily P&L:          ${pnlColor}$${STATE.trading.dailyPnL.toFixed(2)}${C.reset}`);
        console.log(`  🔢 Total Trades Today: ${STATE.trading.dailyTrades}`);
        console.log(`  🔥 Active Trades:      ${STATE.activeTrades.length}`);
        console.log(`  ✅ Completed Trades:   ${STATE.completedTrades.length}`);
        console.log(`  📉 Consecutive Losses: ${STATE.trading.consecutiveLosses}`);
        console.log(`  🎯 Bot Status:         ${STATE.trading.isActive ? `${C.green}ACTIVE${C.reset}` : `${C.yellow}IDLE${C.reset}`}`);
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

// ==================== TRADING STRATEGY ====================
class Strategy {
    static analyzeMarket(candles) {
        if (candles.length < CONFIG.EMA_SLOW) {
            return { signal: 'WAIT', reason: 'Insufficient data' };
        }

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);

        const ema8 = Indicators.calculateEMA(closes, CONFIG.EMA_FAST);
        const ema21 = Indicators.calculateEMA(closes, CONFIG.EMA_MEDIUM);
        const ema50 = Indicators.calculateEMA(closes, CONFIG.EMA_SLOW);
        const stochK = Indicators.calculateStochastic(highs, lows, closes, CONFIG.STOCHASTIC_K);

        STATE.indicators = { ema8, ema21, ema50, stochK };

        const currentPrice = closes[closes.length - 1];
        return this.checkEntrySignals(currentPrice, ema8, ema21, ema50, stochK);
    }

    static checkEntrySignals(price, ema8, ema21, ema50, stochK) {
        // LONG CONDITIONS
        const longTrend = price > ema50;
        const longEmaAlignment = ema8 > ema21 && ema21 > ema50;
        const longStochastic = stochK < CONFIG.STOCHASTIC_OVERSOLD;
        const longPullback = price <= ema21;

        if (longTrend && longEmaAlignment && longStochastic && longPullback) {
            return {
                signal: 'LONG',
                reason: 'Uptrend + EMA alignment + Oversold + Pullback',
                confidence: 'HIGH'
            };
        }

        // SHORT CONDITIONS
        const shortTrend = price < ema50;
        const shortEmaAlignment = ema8 < ema21 && ema21 < ema50;
        const shortStochastic = stochK > CONFIG.STOCHASTIC_OVERBOUGHT;
        const shortPullback = price >= ema21;

        if (shortTrend && shortEmaAlignment && shortStochastic && shortPullback) {
            return {
                signal: 'SHORT',
                reason: 'Downtrend + EMA alignment + Overbought + Pullback',
                confidence: 'HIGH'
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
            STATE.trading.consecutiveLosses = 0;
            STATE.trading.lastTradeDate = today;
            Logger.info('📅 New trading day - counters reset');
        }

        if (STATE.trading.dailyTrades >= CONFIG.MAX_TRADES_PER_DAY) {
            Logger.warn(`Max daily trades reached: ${STATE.trading.dailyTrades}`);
            return false;
        }

        if (STATE.trading.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
            Logger.warn(`Max consecutive losses: ${STATE.trading.consecutiveLosses}`);
            return false;
        }

        const maxDailyLoss = (STATE.account.balance * CONFIG.DAILY_LOSS_LIMIT_PERCENT) / 100;
        if (STATE.trading.dailyPnL <= -maxDailyLoss) {
            Logger.warn(`Daily loss limit reached: $${STATE.trading.dailyPnL.toFixed(2)}`);
            return false;
        }

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

            // FIXED: Include app_id in WebSocket URL
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
        Logger.info(`📈 Subscribing to ${CONFIG.SYMBOL} candles...`);

        try {
            // Get historical candles first
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
            STATE.trading.isActive = true;

        } catch (error) {
            Logger.error('Failed to subscribe to candles', error);
            throw error;
        }
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

        // Update or add candle
        const lastCandle = STATE.candles[STATE.candles.length - 1];
        if (lastCandle && lastCandle.time === candle.time) {
            STATE.candles[STATE.candles.length - 1] = candle;
        } else {
            STATE.candles.push(candle);
            if (STATE.candles.length > CONFIG.EMA_SLOW + 20) {
                STATE.candles.shift();
            }

            Logger.info(`📊 New Candle: O:${candle.open.toFixed(2)} H:${candle.high.toFixed(2)} L:${candle.low.toFixed(2)} C:${candle.close.toFixed(2)}`);

            // Analyze and potentially trade on new candle
            this.analyzeAndTrade();
        }
    }

    // Analyze market and execute trade if signal found
    async analyzeAndTrade() {
        if (!Strategy.shouldTrade()) {
            return;
        }

        const analysis = Strategy.analyzeMarket(STATE.candles);

        Logger.debug('Market analysis', analysis);

        if (analysis.signal === 'LONG' || analysis.signal === 'SHORT') {
            Logger.trade(`🎯 ${analysis.signal} SIGNAL DETECTED`, analysis);
            Logger.displayIndicators();
            await this.executeTrade(analysis.signal);
        }
    }

    // Execute a trade
    async executeTrade(direction) {
        const contractType = direction === 'LONG' ? 'CALL' : 'PUT';

        Logger.trade(`📝 Executing ${contractType} trade...`);

        try {
            // Get proposal
            const proposalResponse = await this.send({
                proposal: 1,
                amount: CONFIG.STAKE_AMOUNT,
                basis: 'stake',
                contract_type: contractType,
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
                STATE.trading.dailyTrades++;

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
        const contractId = contract.contract_id;

        // Find active trade
        const tradeIndex = STATE.activeTrades.findIndex(t => t.id === contractId);
        if (tradeIndex === -1) return;

        const trade = STATE.activeTrades[tradeIndex];
        trade.currentPnL = parseFloat(contract.profit || 0);
        trade.status = contract.status;

        // Check if contract is closed
        if (contract.status === 'sold' || contract.status === 'won' || contract.status === 'lost') {
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
                Logger.warn(`😢 Trade LOST! Loss: $${trade.finalPnL.toFixed(2)}`);
            }

            Logger.displayCompletedTrades();
            Logger.displayStats();
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
            Logger.displayStats();

        } catch (error) {
            Logger.error('Failed to start bot', error.message || error);
            process.exit(1);
        }
    }
}

// ==================== MAIN EXECUTION ====================
// Validate configuration
if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
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
