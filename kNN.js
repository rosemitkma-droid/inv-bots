/**
 * Deriv Trading Bot - FIXED VERSION with Proper Trade Tracking
 * ML kNN + EMA Ribbon + RSI Strategy
 * Author: Algorithmic Trading Developer
 * Framework: NodeJS with WebSocket (ws library)
 * Market: Volatility 100 Index (R_100)
 * Timeframe: 3-minute candles
 */

const WebSocket = require('ws');
const fs = require('fs');
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    API_TOKEN: 'DMylfkyce6VyZt7', // Replace with your actual API token
    WS_URL: 'wss://ws.derivws.com/websockets/v3?app_id=1089',
    SYMBOL: 'R_100',
    TIMEFRAME: 180, // 3 minutes in seconds
    RISK_PERCENT: 1, // 1% risk per trade
    RISK_REWARD_RATIO: 2, // 1:2 RR ratio
    MAX_DAILY_LOSS_PERCENT: 50, // 50% max daily loss
    INITIAL_CANDLES: 1000, // Pre-load for training
    KNN_HISTORY_SIZE: 500, // kNN lookback window
    KNN_K: 5, // Number of neighbors
    MAX_OPEN_TRADES: 1,

    // Indicator Parameters
    RSI_PERIOD: 14,
    RSI_OVERBOUGHT: 60,
    RSI_OVERSOLD: 40,
    EMA_RIBBON: [20, 25, 30, 35, 40, 45, 50, 55],
    EMA_TREND: 200,

    // Stop Loss Configuration
    SL_PERCENT: 0.5, // 0.5% price movement for SL

    // Investment Management
    INVESTMENT_CAPITAL: process.env.INITIAL_CAPITAL ? parseFloat(process.env.INITIAL_CAPITAL) : 100,
};

// ============================================
// UTILITY FUNCTIONS
// ============================================
class Indicators {
    static calculateEMA(data, period) {
        if (data.length < period) return null;

        const multiplier = 2 / (period + 1);
        let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

        for (let i = period; i < data.length; i++) {
            ema = (data[i] - ema) * multiplier + ema;
        }

        return ema;
    }

    static calculateRSI(prices, period = 14) {
        if (prices.length < period + 1) return null;

        let gains = 0;
        let losses = 0;

        for (let i = prices.length - period; i < prices.length; i++) {
            const change = prices[i] - prices[i - 1];
            if (change > 0) gains += change;
            else losses -= change;
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    static calculateROC(prices, period = 14) {
        if (prices.length < period + 1) return null;
        const currentPrice = prices[prices.length - 1];
        const oldPrice = prices[prices.length - period - 1];
        return ((currentPrice - oldPrice) / oldPrice) * 100;
    }
}

// ============================================
// kNN MACHINE LEARNING ENGINE
// ============================================
class KNNEngine {
    constructor(k = 5, historySize = 500) {
        this.k = k;
        this.historySize = historySize;
        this.history = [];
    }

    addDataPoint(features, label) {
        this.history.push({ features, label });
        if (this.history.length > this.historySize) {
            this.history.shift();
        }
    }

    euclideanDistance(features1, features2) {
        return Math.sqrt(
            features1.reduce((sum, val, idx) => {
                return sum + Math.pow(val - features2[idx], 2);
            }, 0)
        );
    }

    predict(features) {
        if (this.history.length < this.k) return null;

        const distances = this.history.map(point => ({
            distance: this.euclideanDistance(features, point.features),
            label: point.label
        }));

        distances.sort((a, b) => a.distance - b.distance);
        const neighbors = distances.slice(0, this.k);

        const votes = { UP: 0, DOWN: 0 };
        neighbors.forEach(neighbor => {
            votes[neighbor.label] = (votes[neighbor.label] || 0) + 1;
        });

        return votes.UP > votes.DOWN ? 'UP' : 'DOWN';
    }
}

// ============================================
// DERIV TRADING BOT
// ============================================
class DerivBot {
    constructor() {
        this.ws = null;
        this.isAuthenticated = false;
        this.candles = [];
        this.knnEngine = new KNNEngine(CONFIG.KNN_K, CONFIG.KNN_HISTORY_SIZE);

        // State Management
        this.balance = 0;
        this.startingBalance = 0;
        this.realizedPnL = 0;
        this.dailyLossLimit = 0;
        this.isTrading = false;
        this.openTrades = new Map();
        this.lastTradeTime = 0;
        this.isTradingHalted = false;
        this.haltUntil = 0;
        this.lastCandleTime = 0;
        this.currency = 'USD'; // Default currency

        // Statistics
        this.totalTrades = 0;
        this.winningTrades = 0;
        this.losingTrades = 0;
        this.totalProfit = 0;
        this.totalLoss = 0;
        this.consecutiveWins = 0;
        this.consecutiveLosses = 0;
        this.maxConsecutiveWins = 0;
        this.maxConsecutiveLosses = 0;
        this.largestWin = 0;
        this.largestLoss = 0;
        this.tradeHistory = [];

        // Indicators Cache
        this.indicators = {
            emaRibbon: [],
            emaTrend: null,
            rsi: null,
            roc: null
        };

        this.requestId = 0;

        // Telegram Configuration
        this.telegramToken = process.env.TELEGRAM_BOT_TOKEN3;
        this.telegramChatId = process.env.TELEGRAM_CHAT_ID;
        this.telegramEnabled = !!(this.telegramToken && this.telegramChatId);

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
            this.startTelegramTimer();
        } else {
            this.log('📱 Telegram notifications disabled (missing API keys).', 'WARNING');
        }

        this.sessionStartTime = new Date();
    }

    // ============================================
    // LOGGING METHODS
    // ============================================
    log(message, type = 'INFO') {
        const timestamp = new Date().toLocaleTimeString();
        const colors = {
            INFO: '\x1b[37m',      // White
            SUCCESS: '\x1b[32m',   // Green
            WARNING: '\x1b[33m',   // Yellow
            ERROR: '\x1b[31m',     // Red
            SIGNAL: '\x1b[36m',    // Cyan
            TRADE: '\x1b[35m',     // Magenta
            ANALYSIS: '\x1b[94m',  // Light Blue
            DATA: '\x1b[93m',      // Light Yellow
            RESET: '\x1b[0m'
        };

        const color = colors[type] || colors.INFO;
        const logMessage = `${color}[${timestamp}] [${type}] ${message}${colors.RESET}`;
        console.log(logMessage);

        const fileMessage = `[${timestamp}] [${type}] ${message}\n`;
        // fs.appendFileSync('trading_bot.log', fileMessage, { flag: 'a' });
    }

    logSeparator() {
        const separator = '='.repeat(100);
        console.log(`\x1b[90m${separator}\x1b[0m`);
    }

    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;
        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
            this.log('📱 Telegram notification sent', 'INFO');
        } catch (error) {
            this.log(`❌ Failed to send Telegram message: ${error.message}`, 'ERROR');
        }
    }

    getTelegramSummary() {
        const winRate = this.totalTrades > 0
            ? ((this.winningTrades / this.totalTrades) * 100).toFixed(1)
            : 0;
        const sessionPnL = this.realizedPnL.toFixed(2);

        return `
📊 <b>Trading Session Summary</b>
========================
📈 <b>Asset:</b> ${CONFIG.SYMBOL}
📊 <b>Total Trades:</b> ${this.totalTrades}
✅ <b>Wins:</b> ${this.winningTrades}
❌ <b>Losses:</b> ${this.losingTrades}
🔥 <b>Win Rate:</b> ${winRate}%
💰 <b>Session P/L:</b> $${sessionPnL}
🏦 <b>Current Balance:</b> $${this.balance.toFixed(2)}
        `;
    }

    startTelegramTimer() {
        // Send summary every 30 minutes
        setInterval(() => {
            if (this.totalTrades > 0) {
                this.sendTelegramMessage(`📊 *Periodic Performance Summary*\n${this.getTelegramSummary()}`);
            }
        }, 30 * 60 * 1000);
    }

    // ============================================
    // CONNECTION & AUTHENTICATION
    // ============================================
    connect() {
        return new Promise((resolve, reject) => {
            this.logSeparator();
            this.log('🔌 Connecting to Deriv WebSocket...', 'INFO');

            this.ws = new WebSocket(CONFIG.WS_URL);

            this.ws.on('open', () => {
                this.logSeparator();
                this.log('✅ WebSocket connected successfully!', 'SUCCESS');
                this.setupHeartbeat();
                this.authenticate().then(resolve).catch(reject);
            });

            this.ws.on('message', (data) => {
                this.handleMessage(JSON.parse(data.toString()));
            });

            this.ws.on('error', (error) => {
                this.log(`❌ WebSocket error: ${error.message}`, 'ERROR');
            });

            this.ws.on('close', () => {
                this.log('⚠️  WebSocket connection closed. Reconnecting...', 'WARNING');
                setTimeout(() => this.connect(), 5000);
            });
        });
    }

    setupHeartbeat() {
        setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ ping: 1 }));
            }
        }, 30000);
    }

    authenticate() {
        return new Promise((resolve, reject) => {
            this.log('🔐 Authenticating with Deriv API...', 'INFO');

            let authReceived = false;

            this.ws.send(JSON.stringify({
                authorize: CONFIG.API_TOKEN
            }));

            const authTimeout = setTimeout(() => {
                if (!authReceived) {
                    reject(new Error('Authentication timeout - no response after 30 seconds'));
                }
            }, 30000);

            const authHandler = (data) => {
                try {
                    const msg = JSON.parse(data.toString());

                    if (msg.error && !authReceived) {
                        authReceived = true;
                        clearTimeout(authTimeout);
                        this.ws.off('message', authHandler);
                        reject(new Error(msg.error.message));
                        return;
                    }

                    if (msg.authorize && !authReceived) {
                        authReceived = true;
                        clearTimeout(authTimeout);
                        this.ws.off('message', authHandler);

                        this.isAuthenticated = true;
                        this.balance = parseFloat(msg.authorize.balance);
                        this.startingBalance = this.balance;
                        this.currency = msg.authorize.currency || 'USD';

                        // Use INVESTMENT_CAPITAL for daily loss limit calculation
                        const baseCapital = CONFIG.INVESTMENT_CAPITAL || this.startingBalance;
                        this.dailyLossLimit = baseCapital * (CONFIG.MAX_DAILY_LOSS_PERCENT / 100);

                        this.logSeparator();
                        this.log(`✅ AUTHORIZATION SUCCESSFUL`, 'SUCCESS');
                        this.log(`👤 Account: ${msg.authorize.email}`, 'SUCCESS');
                        this.log(`💰 Balance: ${this.currency} ${this.balance.toFixed(2)}`, 'SUCCESS');
                        this.log(`💵 Currency: ${this.currency}`, 'INFO');
                        this.log(`🏢 Investment Capital: ${this.currency} ${baseCapital.toFixed(2)}`, 'INFO');
                        this.log(`🚨 Daily Loss Limit: ${this.currency} ${this.dailyLossLimit.toFixed(2)}`, 'INFO');
                        this.logSeparator();

                        // Subscribe to balance
                        this.ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));

                        resolve();
                    }
                } catch (error) {
                    clearTimeout(authTimeout);
                    this.ws.off('message', authHandler);
                    reject(error);
                }
            };

            this.ws.on('message', authHandler);
        });
    }

    getRequestId() {
        return ++this.requestId;
    }

    // ============================================
    // DATA LOADING & PREPROCESSING
    // ============================================
    async loadHistoricalData() {
        return new Promise((resolve, reject) => {
            this.log(`📊 Loading ${CONFIG.INITIAL_CANDLES} historical candles...`, 'DATA');

            // Flag to track if we've received the data
            let dataReceived = false;

            this.ws.send(JSON.stringify({
                ticks_history: CONFIG.SYMBOL,
                adjust_start_time: 1,
                count: CONFIG.INITIAL_CANDLES,
                end: 'latest',
                granularity: CONFIG.TIMEFRAME,
                style: 'candles'
            }));

            const dataTimeout = setTimeout(() => {
                if (!dataReceived) {
                    reject(new Error('Data loading timeout - no response from server after 60 seconds'));
                }
            }, 60000); // Increased to 60 seconds

            const dataHandler = (data) => {
                try {
                    const msg = JSON.parse(data.toString());

                    // Handle errors
                    if (msg.error) {
                        clearTimeout(dataTimeout);
                        this.ws.off('message', dataHandler);
                        reject(new Error(`API Error: ${msg.error.message}`));
                        return;
                    }

                    // Handle candles response
                    if (msg.candles && !dataReceived) {
                        dataReceived = true;
                        clearTimeout(dataTimeout);
                        this.ws.off('message', dataHandler);

                        this.processHistoricalCandles(msg.candles);
                        this.log(`✅ Loaded ${this.candles.length} candles`, 'SUCCESS');
                        this.trainKNN();
                        this.log(`✅ kNN trained with ${this.knnEngine.history.length} patterns`, 'SUCCESS');
                        this.logSeparator();
                        resolve();
                    }
                } catch (error) {
                    clearTimeout(dataTimeout);
                    this.ws.off('message', dataHandler);
                    reject(error);
                }
            };

            this.ws.on('message', dataHandler);
        });
    }

    processHistoricalCandles(candlesData) {
        this.candles = candlesData.map(c => ({
            time: c.epoch,
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close)
        }));

        if (this.candles.length > 0) {
            this.lastCandleTime = this.candles[this.candles.length - 1].time;
        }
    }

    trainKNN() {
        if (this.candles.length < CONFIG.EMA_TREND + CONFIG.RSI_PERIOD + 1) {
            return;
        }

        for (let i = CONFIG.EMA_TREND + CONFIG.RSI_PERIOD + 1; i < this.candles.length; i++) {
            const historicalCandles = this.candles.slice(0, i);
            const closePrices = historicalCandles.map(c => c.close);

            const rsi = Indicators.calculateRSI(closePrices, CONFIG.RSI_PERIOD);
            const roc = Indicators.calculateROC(closePrices, CONFIG.RSI_PERIOD);

            if (rsi !== null && roc !== null) {
                const currentClose = this.candles[i - 1].close;
                const nextClose = this.candles[i].close;
                const label = nextClose > currentClose ? 'UP' : 'DOWN';

                this.knnEngine.addDataPoint([rsi, roc], label);
            }
        }
    }

    subscribeToCandles() {
        this.log('📡 Subscribing to live candles...', 'INFO');

        this.ws.send(JSON.stringify({
            ticks_history: CONFIG.SYMBOL,
            adjust_start_time: 1,
            count: 1,
            end: 'latest',
            granularity: CONFIG.TIMEFRAME,
            style: 'candles',
            subscribe: 1
        }));

        this.log('✅ Ready to trade!', 'SUCCESS');
        this.logSeparator();
    }

    // ============================================
    // MESSAGE HANDLER
    // ============================================
    handleMessage(msg) {
        if (msg.ping || msg.pong) return;

        if (msg.ohlc) {
            this.onNewCandle(msg.ohlc);
        }

        if (msg.balance) {
            const previousBalance = this.balance;
            this.balance = parseFloat(msg.balance.balance);

            const change = this.balance - previousBalance;
            if (change !== 0) {
                this.log(`💵 Balance: ${this.currency} ${this.balance.toFixed(2)} (${change > 0 ? '+' : ''}${change.toFixed(2)})`, 'INFO');
            }
        }

        if (msg.buy) {
            this.handleBuyResponse(msg.buy);
        }

        if (msg.proposal_open_contract) {
            this.handleOpenContract(msg.proposal_open_contract);
        }

        if (msg.error) {
            this.log(`API Error: ${msg.error.message}`, 'ERROR');
        }
    }

    onNewCandle(ohlc) {
        const newCandle = {
            time: ohlc.epoch,
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close)
        };

        if (newCandle.time > this.lastCandleTime) {
            this.candles.push(newCandle);
            this.lastCandleTime = newCandle.time;

            if (this.candles.length > CONFIG.INITIAL_CANDLES) {
                this.candles.shift();
            }

            // this.log(`🕯️  Candle: ${newCandle.close.toFixed(2)} | O:${newCandle.open.toFixed(2)} H:${newCandle.high.toFixed(2)} L:${newCandle.low.toFixed(2)}`, 'DATA');

            this.calculateIndicators();

            if (this.isTrading) {
                this.checkTradeSignals();
            }
        }
    }

    // ============================================
    // INDICATOR CALCULATIONS
    // ============================================
    calculateIndicators() {
        const closePrices = this.candles.map(c => c.close);

        this.indicators.emaRibbon = CONFIG.EMA_RIBBON.map(period =>
            Indicators.calculateEMA(closePrices, period)
        );

        this.indicators.emaTrend = Indicators.calculateEMA(closePrices, CONFIG.EMA_TREND);
        this.indicators.rsi = Indicators.calculateRSI(closePrices, CONFIG.RSI_PERIOD);
        this.indicators.roc = Indicators.calculateROC(closePrices, CONFIG.RSI_PERIOD);
    }

    getKNNPrediction() {
        if (this.indicators.rsi === null || this.indicators.roc === null) {
            return null;
        }

        const features = [this.indicators.rsi, this.indicators.roc];
        return this.knnEngine.predict(features);
    }

    // ============================================
    // TRADING LOGIC
    // ============================================
    checkTradeSignals() {
        if (this.isTradingHalted || this.openTrades.size >= CONFIG.MAX_OPEN_TRADES) {
            return;
        }

        if (!this.indicators.emaTrend || !this.indicators.rsi) {
            return;
        }

        const currentPrice = this.candles[this.candles.length - 1].close;
        const knnPrediction = this.getKNNPrediction();

        if (!knnPrediction) {
            return;
        }

        const ribbonAvg = this.indicators.emaRibbon.reduce((sum, ema) => sum + ema, 0) / this.indicators.emaRibbon.length;

        const longCondition =
            currentPrice > this.indicators.emaTrend &&
            ribbonAvg > this.indicators.emaTrend &&
            this.indicators.rsi < CONFIG.RSI_OVERSOLD &&
            knnPrediction === 'UP';

        const shortCondition =
            currentPrice < this.indicators.emaTrend &&
            ribbonAvg < this.indicators.emaTrend &&
            this.indicators.rsi > CONFIG.RSI_OVERBOUGHT &&
            knnPrediction === 'DOWN';

        if (longCondition) {
            this.logSeparator();
            this.log('🎯 LONG SIGNAL!', 'SIGNAL');
            this.sendTelegramMessage(`🎯 <b>LONG SIGNAL DETECTED!</b>\n<b>Price:</b> ${currentPrice.toFixed(4)}\n<b>kNN:</b> ${knnPrediction}\n<b>RSI:</b> ${this.indicators.rsi.toFixed(2)}`);
            this.executeTrade('CALL');
        } else if (shortCondition) {
            this.logSeparator();
            this.log('🎯 SHORT SIGNAL!', 'SIGNAL');
            this.sendTelegramMessage(`🎯 <b>SHORT SIGNAL DETECTED!</b>\n<b>Price:</b> ${currentPrice.toFixed(4)}\n<b>kNN:</b> ${knnPrediction}\n<b>RSI:</b> ${this.indicators.rsi.toFixed(2)}`);
            this.executeTrade('PUT');
        }

        // Update kNN
        const currentClose = this.candles[this.candles.length - 1].close;
        const previousClose = this.candles[this.candles.length - 2]?.close;

        if (previousClose) {
            const label = currentClose > previousClose ? 'UP' : 'DOWN';
            this.knnEngine.addDataPoint([this.indicators.rsi, this.indicators.roc], label);
        }
    }

    executeTrade(type) {
        // Risk calculated based on INVESTMENT_CAPITAL instead of account balance
        const baseCapital = CONFIG.INVESTMENT_CAPITAL || this.balance;
        const stake = Math.max(baseCapital * (CONFIG.RISK_PERCENT / 100), 0.35).toFixed(2);
        const currentPrice = this.candles[this.candles.length - 1].close;

        this.log(`💰 EXECUTING ${type}`, 'TRADE');
        this.log(`   Capital: ${this.currency} ${baseCapital.toFixed(2)}`, 'TRADE');
        this.log(`   Stake: ${this.currency} ${stake} (${CONFIG.RISK_PERCENT}% of capital)`, 'TRADE');
        this.log(`   Entry: ${currentPrice.toFixed(4)}`, 'TRADE');
        this.log(`   Balance: ${this.currency} ${this.balance.toFixed(2)}`, 'TRADE');

        this.sendTelegramMessage(`💰 <b>EXECUTING ${type}</b>\n<b>Stake:</b> ${this.currency} ${stake}\n<b>Entry:</b> ${currentPrice.toFixed(4)}`);

        // For Rise/Fall contracts on Volatility indices
        const tradeRequest = {
            buy: 1,
            // Removed duplicate subscribe: 1 to fix API error
            price: stake,
            parameters: {
                contract_type: type, // CALL for Rise, PUT for Fall
                symbol: CONFIG.SYMBOL,
                duration: 3,
                duration_unit: 'm',
                basis: 'stake',
                amount: stake,
                currency: this.currency
            }
        };

        this.log(`📤 Sending trade request...`, 'TRADE');
        this.log(`   Request: ${JSON.stringify(tradeRequest)}`, 'DATA');

        this.ws.send(JSON.stringify(tradeRequest));
    }

    handleBuyResponse(buyData) {
        this.totalTrades++;

        this.logSeparator();
        this.log('✅ TRADE OPENED SUCCESSFULLY!', 'SUCCESS');
        this.log(`📝 Contract ID: ${buyData.contract_id}`, 'TRADE');
        this.log(`   Type: ${buyData.contract_type}`, 'TRADE');
        this.log(`   Cost: $${buyData.buy_price}`, 'TRADE');
        this.log(`   Time: ${new Date().toLocaleTimeString()}`, 'TRADE');
        this.logSeparator();

        this.sendTelegramMessage(`✅ <b>TRADE OPENED</b>\n<b>ID:</b> ${buyData.contract_id}\n<b>Type:</b> ${buyData.contract_type}\n<b>Stake:</b> $${buyData.buy_price}`);

        this.openTrades.set(buyData.contract_id, {
            contractId: buyData.contract_id,
            type: buyData.contract_type,
            buyPrice: parseFloat(buyData.buy_price),
            entryTime: new Date()
        });

        // Subscribe to contract updates
        this.ws.send(JSON.stringify({
            proposal_open_contract: 1,
            contract_id: buyData.contract_id,
            subscribe: 1
        }));

        this.log('📡 Monitoring contract...', 'INFO');
    }

    handleOpenContract(contract) {
        const contractId = contract.contract_id;

        if (!this.openTrades.has(contractId)) {
            return;
        }

        const trade = this.openTrades.get(contractId);

        // Only process when closed
        if (contract.is_sold) {
            const profit = parseFloat(contract.profit);
            const sellPrice = parseFloat(contract.sell_price || 0);
            const duration = ((new Date() - trade.entryTime) / 1000).toFixed(0);

            this.logSeparator();
            this.log('📊 TRADE CLOSED', profit >= 0 ? 'SUCCESS' : 'ERROR');
            this.log(`   Contract: ${contractId}`, 'INFO');
            this.log(`   Entry: $${trade.buyPrice.toFixed(2)}`, 'INFO');
            this.log(`   Exit: $${sellPrice.toFixed(2)}`, 'INFO');
            this.log(`   Duration: ${duration}s`, 'INFO');

            if (profit > 0) {
                this.winningTrades++;
                this.totalProfit += profit;
                this.consecutiveWins++;
                this.consecutiveLosses = 0;
                if (this.consecutiveWins > this.maxConsecutiveWins) {
                    this.maxConsecutiveWins = this.consecutiveWins;
                }
                if (profit > this.largestWin) {
                    this.largestWin = profit;
                }
                this.log(`   💰 PROFIT: +$${profit.toFixed(2)} ✅`, 'SUCCESS');
                this.log(`   🔥 Win Streak: ${this.consecutiveWins}`, 'SUCCESS');
                this.sendTelegramMessage(`🎉 <b>TRADE WON!</b>\n<b>Profit:</b> +$${profit.toFixed(2)}\n<b>Balance:</b> $${this.balance.toFixed(2)}`);
            } else {
                this.losingTrades++;
                this.totalLoss += Math.abs(profit);
                this.consecutiveLosses++;
                this.consecutiveWins = 0;
                if (this.consecutiveLosses > this.maxConsecutiveLosses) {
                    this.maxConsecutiveLosses = this.consecutiveLosses;
                }
                if (Math.abs(profit) > this.largestLoss) {
                    this.largestLoss = Math.abs(profit);
                }
                this.log(`   💸 LOSS: $${profit.toFixed(2)} ❌`, 'ERROR');
                this.log(`   📉 Loss Streak: ${this.consecutiveLosses}`, 'WARNING');
                this.sendTelegramMessage(`😔 <b>TRADE LOST</b>\n<b>Loss:</b> $${profit.toFixed(2)}\n<b>Balance:</b> $${this.balance.toFixed(2)}\n<b>Streak:</b> ${this.consecutiveLosses}`);
            }

            this.realizedPnL += profit;

            const winRate = ((this.winningTrades / this.totalTrades) * 100).toFixed(1);
            this.log(`   📊 Win Rate: ${winRate}% (${this.winningTrades}/${this.totalTrades})`, 'INFO');
            this.log(`   💵 Session P/L: ${this.realizedPnL >= 0 ? '+' : ''}$${this.realizedPnL.toFixed(2)}`, this.realizedPnL >= 0 ? 'SUCCESS' : 'ERROR');
            this.logSeparator();

            this.tradeHistory.push({
                timestamp: new Date().toISOString(),
                contractId,
                type: trade.type,
                entryPrice: trade.buyPrice,
                exitPrice: sellPrice,
                profit,
                duration,
                balance: this.balance
            });

            this.openTrades.delete(contractId);
        }
    }

    // ============================================
    // START BOT
    // ============================================
    async start() {
        try {
            // fs.writeFileSync('trading_bot.log', `=== Bot Started: ${new Date().toISOString()} ===\n`, { flag: 'w' });

            console.clear();
            this.logSeparator();
            this.log('🤖 DERIV ML TRADING BOT v3.1 - FIXED', 'SUCCESS');
            this.logSeparator();

            await this.connect();
            await this.loadHistoricalData();
            this.subscribeToCandles();

            setTimeout(() => {
                this.isTrading = true;
                this.logSeparator();
                this.log('🚀 TRADING STARTED!', 'SUCCESS');
                this.logSeparator();

                this.sendTelegramMessage(`🚀 <b>BOT STARTED & TRADING</b>\n<b>Asset:</b> ${CONFIG.SYMBOL}\n<b>Balance:</b> $${this.balance.toFixed(2)}`);
            }, 3000);

        } catch (error) {
            this.log(`❌ FATAL ERROR: ${error.message}`, 'ERROR');
            process.exit(1);
        }
    }
}

// ============================================
// MAIN EXECUTION
// ============================================
const bot = new DerivBot();

process.on('SIGINT', async () => {
    console.log('\n\nShutting down...');
    if (bot.telegramEnabled) {
        await bot.sendTelegramMessage(`⏹ <b>Bot Stopped Manually</b>\n${bot.getTelegramSummary()}`);
    }
    if (bot.ws) bot.ws.close();
    process.exit(0);
});

bot.start();

module.exports = DerivBot;
