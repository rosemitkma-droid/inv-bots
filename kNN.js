/**
 * Deriv ML Trading Bot - NodeJS Version
 * Strategy: Machine Learning kNN + EMA Ribbon + RSI
 * Market: Volatility 100 Index (R_100)
 * Timeframe: 3 minutes
 */

const WebSocket = require('ws');
const fs = require('fs');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    // API Configuration
    API_TOKEN: 'DMylfkyce6VyZt7', // Replace with your actual token
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3?app_id=1089',

    // Market Configuration
    SYMBOL: 'R_100',
    TIMEFRAME: 180, // 3 minutes in seconds

    // Strategy Parameters
    EMA_RIBBON_PERIODS: [20, 25, 30, 35, 40, 45, 50, 55],
    TREND_EMA_PERIOD: 200,
    RSI_PERIOD: 14,
    RSI_OVERBOUGHT: 60,
    RSI_OVERSOLD: 40,
    ROC_PERIOD: 12,

    // ML Parameters
    KNN_K: 5,
    KNN_HISTORY_SIZE: 500,
    HISTORICAL_CANDLES: 1000,
    MAX_CANDLES: 1000,

    // Money Management
    INVESTMENT_AMOUNT: 500,
    RISK_PERCENTAGE: 0.01, // 1% per trade
    RISK_REWARD_RATIO: 2, // 1:2
    SL_PERCENTAGE: 0.005, // 0.5%
    MAX_DAILY_LOSS_PERCENT: 0.10, // 10%
    MAX_OPEN_TRADES: 1,

    // Connection
    PING_INTERVAL: 30000, // 30 seconds
    RECONNECT_DELAY: 5000 // 5 seconds
};

// ============================================================================
// DERIV BOT CLASS
// ============================================================================

class DerivBot {
    constructor() {
        this.ws = null;
        this.isConnected = false;
        this.isTrading = false;
        this.isAuthorized = false;

        // Account data
        this.balance = 0;
        this.startingBalance = 0;
        this.dailyProfit = 0;
        this.activeTrade = null;
        this.accountEmail = '';

        // Market data
        this.candles = [];
        this.knnHistory = [];

        // Connection management
        this.pingInterval = null;
        this.shouldReconnect = true;
        this.subscriptions = new Map();

        // Statistics
        this.tradesExecuted = 0;
        this.winningTrades = 0;
        this.losingTrades = 0;
    }

    // ========================================================================
    // LOGGING METHODS
    // ========================================================================

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

        // Also append to log file
        const fileMessage = `[${timestamp}] [${type}] ${message}\n`;
        // fs.appendFileSync('trading_bot.log', fileMessage, { flag: 'a' });
    }

    logSeparator() {
        const separator = '='.repeat(100);
        console.log(`\x1b[90m${separator}\x1b[0m`);
    }

    // ========================================================================
    // WEBSOCKET CONNECTION
    // ========================================================================

    connect() {
        this.logSeparator();
        this.log('🔌 Initiating connection to Deriv WebSocket...', 'INFO');
        this.log(`📡 WebSocket URL: ${CONFIG.WS_URL}`, 'INFO');

        try {
            this.ws = new WebSocket(CONFIG.WS_URL);

            this.ws.on('open', () => {
                this.logSeparator();
                this.log('✅ WebSocket connection established successfully!', 'SUCCESS');
                this.log('🔐 Initiating authorization...', 'INFO');
                this.isConnected = true;
                this.authorize();
                this.startPingPong();
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleMessage(message);
                } catch (error) {
                    this.log(`❌ Failed to parse WebSocket message: ${error.message}`, 'ERROR');
                    this.log(`Raw data: ${data.toString().substring(0, 100)}...`, 'ERROR');
                }
            });

            this.ws.on('error', (error) => {
                this.log(`❌ WebSocket error occurred: ${error.message}`, 'ERROR');
                if (error.code) {
                    this.log(`Error code: ${error.code}`, 'ERROR');
                }
            });

            this.ws.on('close', (code, reason) => {
                this.logSeparator();
                this.log(`⚠️  WebSocket connection closed`, 'WARNING');
                this.log(`Close code: ${code}, Reason: ${reason || 'No reason provided'}`, 'WARNING');
                this.isConnected = false;
                this.isAuthorized = false;
                this.stopPingPong();

                if (this.shouldReconnect) {
                    this.log(`🔄 Attempting to reconnect in ${CONFIG.RECONNECT_DELAY / 1000} seconds...`, 'INFO');
                    setTimeout(() => this.connect(), CONFIG.RECONNECT_DELAY);
                }
            });
        } catch (error) {
            this.log(`❌ Failed to create WebSocket connection: ${error.message}`, 'ERROR');
            this.log(`Stack trace: ${error.stack}`, 'ERROR');
        }
    }

    authorize() {
        this.log('Authorizing with API token...', 'INFO');
        this.sendRequest({ authorize: CONFIG.API_TOKEN });
    }

    sendRequest(request) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(request));
        } else {
            this.log('Cannot send request - WebSocket not connected', 'ERROR');
        }
    }

    startPingPong() {
        this.pingInterval = setInterval(() => {
            this.sendRequest({ ping: 1 });
        }, CONFIG.PING_INTERVAL);
    }

    stopPingPong() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    disconnect() {
        this.shouldReconnect = false;
        this.stopTrading();
        this.stopPingPong();

        if (this.ws) {
            this.ws.close();
        }

        this.log('Bot disconnected', 'INFO');
    }

    // ========================================================================
    // MESSAGE HANDLERS
    // ========================================================================

    handleMessage(data) {
        // Handle errors
        if (data.error) {
            this.log(`API Error: ${data.error.message}`, 'ERROR');

            if (data.error.code === 'AuthorizationRequired' ||
                data.error.code === 'InvalidToken') {
                this.log('Authorization failed - check your API token', 'ERROR');
                this.disconnect();
            }
            return;
        }

        // Route messages by type
        switch (data.msg_type) {
            case 'authorize':
                this.handleAuthorize(data);
                break;
            case 'balance':
                this.handleBalance(data);
                break;
            case 'candles':
                this.handleHistoricalCandles(data);
                break;
            case 'ohlc':
                this.handleOHLC(data);
                break;
            case 'buy':
                this.handleBuy(data);
                break;
            case 'proposal_open_contract':
                this.handleOpenContract(data);
                break;
            case 'ping':
                // Ping acknowledged
                break;
            default:
                // Ignore other message types
                break;
        }
    }

    handleAuthorize(data) {
        this.logSeparator();
        this.isAuthorized = true;
        this.accountEmail = data.authorize.email;
        this.balance = parseFloat(data.authorize.balance);
        this.startingBalance = this.balance;

        this.log(`✅ AUTHORIZATION SUCCESSFUL`, 'SUCCESS');
        this.log(`👤 Account Email: ${this.accountEmail}`, 'SUCCESS');
        this.log(`💰 Current Balance: $${this.balance.toFixed(2)}`, 'SUCCESS');
        this.log(`📊 Currency: ${data.authorize.currency}`, 'INFO');
        this.log(`🆔 Account ID: ${data.authorize.loginid}`, 'INFO');
        this.logSeparator();

        // Subscribe to balance updates
        this.log('📡 Subscribing to real-time balance updates...', 'INFO');
        this.sendRequest({ balance: 1, subscribe: 1 });

        // Load historical data
        this.loadHistoricalData();
    }

    handleBalance(data) {
        const previousBalance = this.balance;
        this.balance = parseFloat(data.balance.balance);
        this.dailyProfit = this.balance - this.startingBalance;
        const balanceChange = this.balance - previousBalance;

        if (balanceChange !== 0) {
            const changeSymbol = balanceChange > 0 ? '📈' : '📉';
            this.log(`${changeSymbol} BALANCE UPDATE: $${this.balance.toFixed(2)} (${balanceChange > 0 ? '+' : ''}$${balanceChange.toFixed(2)})`, balanceChange > 0 ? 'SUCCESS' : 'WARNING');
        }

        this.log(`💵 Current Balance: $${this.balance.toFixed(2)} | Daily P/L: ${this.dailyProfit >= 0 ? '+' : ''}$${this.dailyProfit.toFixed(2)} (${((this.dailyProfit / this.startingBalance) * 100).toFixed(2)}%)`, 'DATA');

        // Check daily stop loss
        const maxLoss = this.startingBalance * CONFIG.MAX_DAILY_LOSS_PERCENT;
        if (this.dailyProfit < -maxLoss) {
            this.logSeparator();
            this.log(`🚨 DAILY STOP LOSS TRIGGERED! 🚨`, 'ERROR');
            this.log(`Loss: $${Math.abs(this.dailyProfit).toFixed(2)} (${((this.dailyProfit / this.startingBalance) * 100).toFixed(2)}%)`, 'ERROR');
            this.log(`Maximum daily loss limit: ${(CONFIG.MAX_DAILY_LOSS_PERCENT * 100).toFixed(0)}%`, 'ERROR');
            this.logSeparator();
            this.stopTrading();
        }
    }

    handleHistoricalCandles(data) {
        this.logSeparator();
        this.log('📊 Processing historical candle data...', 'DATA');

        const candles = data.candles;
        this.candles = candles.map(c => ({
            time: c.epoch,
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close)
        }));

        this.log(`✅ Successfully loaded ${this.candles.length} historical candles`, 'SUCCESS');
        this.log(`📅 Date range: ${new Date(this.candles[0].time * 1000).toLocaleString()} to ${new Date(this.candles[this.candles.length - 1].time * 1000).toLocaleString()}`, 'INFO');
        this.log(`💹 Price range: ${Math.min(...this.candles.map(c => c.low)).toFixed(2)} - ${Math.max(...this.candles.map(c => c.high)).toFixed(2)}`, 'INFO');

        // Train kNN with historical data
        this.trainKNN();

        // Subscribe to live OHLC data
        this.subscribeToOHLC();
    }

    handleOHLC(data) {
        const ohlc = data.ohlc;
        const newCandle = {
            time: ohlc.epoch,
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close)
        };

        // Check if this is a new candle (candle closed)
        if (this.candles.length > 0 && newCandle.time > this.candles[this.candles.length - 1].time) {
            this.candles.push(newCandle);

            // Maintain max candles limit
            if (this.candles.length > CONFIG.MAX_CANDLES) {
                this.candles.shift();
            }

            this.log(`New candle closed at ${newCandle.close.toFixed(2)}`, 'INFO');

            // Analyze and potentially trade
            if (this.isTrading && !this.activeTrade) {
                this.analyzeAndTrade();
            }
        } else if (this.candles.length > 0) {
            // Update current candle
            this.candles[this.candles.length - 1] = newCandle;
        }
    }

    handleBuy(data) {
        const contract = data.buy;
        this.tradesExecuted++;

        this.logSeparator();
        this.log('✅ TRADE EXECUTED SUCCESSFULLY!', 'TRADE');
        this.log(`📝 Contract Details:`, 'TRADE');
        this.log(`   Type: ${contract.contract_type}`, 'TRADE');
        this.log(`   Contract ID: ${contract.contract_id}`, 'TRADE');
        this.log(`   Buy Price: $${contract.buy_price}`, 'TRADE');
        this.log(`   Purchase Time: ${new Date().toLocaleString()}`, 'TRADE');
        this.logSeparator();

        this.activeTrade = {
            contractId: contract.contract_id,
            type: contract.contract_type,
            buyPrice: parseFloat(contract.buy_price),
            entryTime: new Date()
        };

        // Subscribe to contract updates
        this.log('📡 Subscribing to contract updates for monitoring...', 'INFO');
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contract.contract_id,
            subscribe: 1
        });
    }

    handleOpenContract(data) {
        const contract = data.proposal_open_contract;

        // Update active trade status
        if (this.activeTrade && contract.contract_id === this.activeTrade.contractId) {
            const currentProfit = parseFloat(contract.profit || 0);
            const currentPayout = parseFloat(contract.bid_price || 0);

            // Log live updates (only every 10 updates to avoid spam)
            if (!this.contractUpdateCount) this.contractUpdateCount = 0;
            this.contractUpdateCount++;

            if (this.contractUpdateCount % 10 === 0) {
                this.log(`📊 Contract Update: P/L: $${currentProfit.toFixed(2)} | Current Value: $${currentPayout.toFixed(2)}`, 'DATA');
            }

            // Check if contract is closed
            if (contract.is_sold) {
                const profit = parseFloat(contract.profit);
                const sellPrice = parseFloat(contract.sell_price || 0);
                const status = contract.status;
                const duration = (new Date() - this.activeTrade.entryTime) / 1000; // in seconds

                this.logSeparator();
                this.log('📊 TRADE CLOSED', profit > 0 ? 'SUCCESS' : 'ERROR');
                this.log(`📝 Trade Result:`, profit > 0 ? 'SUCCESS' : 'ERROR');
                this.log(`   Contract ID: ${contract.contract_id}`, 'INFO');
                this.log(`   Type: ${this.activeTrade.type}`, 'INFO');
                this.log(`   Entry Price: $${this.activeTrade.buyPrice.toFixed(2)}`, 'INFO');
                this.log(`   Exit Price: $${sellPrice.toFixed(2)}`, 'INFO');
                this.log(`   Duration: ${Math.floor(duration / 60)}m ${Math.floor(duration % 60)}s`, 'INFO');
                this.log(`   Status: ${status}`, 'INFO');

                if (profit > 0) {
                    this.winningTrades++;
                    this.log(`   💰 PROFIT: +$${profit.toFixed(2)} ✅`, 'SUCCESS');
                    this.log(`   🎯 Take Profit Hit!`, 'SUCCESS');
                } else {
                    this.losingTrades++;
                    this.log(`   💸 LOSS: $${profit.toFixed(2)} ❌`, 'ERROR');
                    this.log(`   🛑 Stop Loss Hit`, 'ERROR');
                }

                // Display statistics
                const winRate = this.tradesExecuted > 0 ?
                    (this.winningTrades / this.tradesExecuted * 100).toFixed(1) : 0;
                const totalPnL = this.dailyProfit;

                this.logSeparator();
                this.log('📈 TRADING STATISTICS:', 'INFO');
                this.log(`   Total Trades: ${this.tradesExecuted}`, 'INFO');
                this.log(`   Winning Trades: ${this.winningTrades} 🏆`, 'SUCCESS');
                this.log(`   Losing Trades: ${this.losingTrades} 📉`, 'ERROR');
                this.log(`   Win Rate: ${winRate}%`, winRate >= 50 ? 'SUCCESS' : 'WARNING');
                this.log(`   Daily P/L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`, totalPnL >= 0 ? 'SUCCESS' : 'ERROR');
                this.logSeparator();

                this.activeTrade = null;
                this.contractUpdateCount = 0;
            }
        }
    }

    // ========================================================================
    // DATA LOADING
    // ========================================================================

    loadHistoricalData() {
        this.log(`Loading ${CONFIG.HISTORICAL_CANDLES} historical candles for ML training...`, 'INFO');

        this.sendRequest({
            ticks_history: CONFIG.SYMBOL,
            style: 'candles',
            end: 'latest',
            count: CONFIG.HISTORICAL_CANDLES,
            granularity: CONFIG.TIMEFRAME
        });
    }

    subscribeToOHLC() {
        this.log('Subscribing to live OHLC stream...', 'INFO');

        this.sendRequest({
            ticks_history: CONFIG.SYMBOL,
            style: 'candles',
            granularity: CONFIG.TIMEFRAME,
            subscribe: 1
        });

        this.log('✓ Bot ready to trade!', 'SUCCESS');
        this.log('='.repeat(80), 'INFO');
    }

    // ========================================================================
    // INDICATOR CALCULATIONS
    // ========================================================================

    calculateEMA(data, period) {
        const k = 2 / (period + 1);
        const ema = [data[0]];

        for (let i = 1; i < data.length; i++) {
            ema.push(data[i] * k + ema[i - 1] * (1 - k));
        }

        return ema;
    }

    calculateRSI(closes, period = CONFIG.RSI_PERIOD) {
        if (closes.length < period + 1) return null;

        let gains = 0;
        let losses = 0;

        // Calculate initial average gain and loss
        for (let i = closes.length - period; i < closes.length; i++) {
            const change = closes[i] - closes[i - 1];
            if (change > 0) {
                gains += change;
            } else {
                losses -= change;
            }
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;

        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    calculateROC(closes, period = CONFIG.ROC_PERIOD) {
        if (closes.length < period + 1) return 0;

        const current = closes[closes.length - 1];
        const past = closes[closes.length - period - 1];

        return ((current - past) / past) * 100;
    }

    calculateIndicators() {
        if (this.candles.length < CONFIG.TREND_EMA_PERIOD) {
            return null;
        }

        const closes = this.candles.map(c => c.close);
        const currentPrice = closes[closes.length - 1];

        // Calculate all EMAs
        const ema20 = this.calculateEMA(closes, 20);
        const ema25 = this.calculateEMA(closes, 25);
        const ema30 = this.calculateEMA(closes, 30);
        const ema35 = this.calculateEMA(closes, 35);
        const ema40 = this.calculateEMA(closes, 40);
        const ema45 = this.calculateEMA(closes, 45);
        const ema50 = this.calculateEMA(closes, 50);
        const ema55 = this.calculateEMA(closes, 55);
        const ema200 = this.calculateEMA(closes, CONFIG.TREND_EMA_PERIOD);

        // Calculate ribbon average
        const ribbonEMAs = [ema20, ema25, ema30, ema35, ema40, ema45, ema50, ema55];
        const ribbonAvg = ribbonEMAs.reduce((sum, ema) => sum + ema[ema.length - 1], 0) / ribbonEMAs.length;

        // Calculate RSI
        const rsi = this.calculateRSI(closes);

        // Calculate ROC
        const roc = this.calculateROC(closes);

        return {
            price: currentPrice,
            ema200: ema200[ema200.length - 1],
            ribbonAvg: ribbonAvg,
            rsi: rsi,
            roc: roc
        };
    }

    // ========================================================================
    // MACHINE LEARNING - kNN
    // ========================================================================

    trainKNN() {
        this.log('Training kNN model with historical data...', 'INFO');

        // Build kNN history from loaded candles
        for (let i = CONFIG.TREND_EMA_PERIOD; i < this.candles.length - 1; i++) {
            const closes = this.candles.slice(0, i + 1).map(c => c.close);
            const rsi = this.calculateRSI(closes);
            const roc = this.calculateROC(closes);

            // Next candle direction (1 for UP, -1 for DOWN)
            const nextDirection = this.candles[i + 1].close > this.candles[i].close ? 1 : -1;

            if (rsi !== null) {
                this.knnHistory.push({
                    rsi: rsi,
                    roc: roc,
                    direction: nextDirection
                });

                // Maintain history size limit
                if (this.knnHistory.length > CONFIG.KNN_HISTORY_SIZE) {
                    this.knnHistory.shift();
                }
            }
        }

        this.log(`✓ kNN trained with ${this.knnHistory.length} historical patterns`, 'SUCCESS');
    }

    getKNNPrediction(currentRSI, currentROC) {
        if (this.knnHistory.length < CONFIG.KNN_K) {
            return null;
        }

        // Calculate Euclidean distances to all historical points
        const distances = this.knnHistory.map(point => {
            const rsiDiff = currentRSI - point.rsi;
            const rocDiff = currentROC - point.roc;
            const distance = Math.sqrt(rsiDiff * rsiDiff + rocDiff * rocDiff);

            return {
                distance: distance,
                direction: point.direction
            };
        });

        // Sort by distance and take K nearest neighbors
        distances.sort((a, b) => a.distance - b.distance);
        const kNearest = distances.slice(0, CONFIG.KNN_K);

        // Vote for direction (sum of directions)
        const votes = kNearest.reduce((sum, neighbor) => sum + neighbor.direction, 0);

        // Return prediction: 'UP' or 'DOWN'
        return votes > 0 ? 'UP' : 'DOWN';
    }

    // ========================================================================
    // TRADING LOGIC
    // ========================================================================

    analyzeAndTrade() {
        this.logSeparator();
        this.log('🔍 MARKET ANALYSIS STARTED', 'ANALYSIS');

        const indicators = this.calculateIndicators();

        if (!indicators || indicators.rsi === null) {
            this.log('⚠️  Insufficient data for analysis (need more candles)', 'WARNING');
            return;
        }

        // Get kNN prediction
        const prediction = this.getKNNPrediction(indicators.rsi, indicators.roc);

        if (!prediction) {
            this.log('⚠️  Insufficient kNN history for prediction', 'WARNING');
            return;
        }

        // Log detailed analysis
        this.log('📊 Technical Indicators:', 'ANALYSIS');
        this.log(`   💹 Current Price: ${indicators.price.toFixed(2)}`, 'ANALYSIS');
        this.log(`   📈 EMA 200: ${indicators.ema200.toFixed(2)}`, 'ANALYSIS');
        this.log(`   🎀 EMA Ribbon Avg: ${indicators.ribbonAvg.toFixed(2)}`, 'ANALYSIS');
        this.log(`   📊 RSI (14): ${indicators.rsi.toFixed(2)}`, 'ANALYSIS');
        this.log(`   📉 ROC: ${indicators.roc.toFixed(2)}%`, 'ANALYSIS');
        this.log(`   🤖 kNN Prediction: ${prediction}`, 'ANALYSIS');

        // Analyze conditions
        const priceTrend = indicators.price > indicators.ema200 ? 'BULLISH' : 'BEARISH';
        const ribbonTrend = indicators.ribbonAvg > indicators.ema200 ? 'BULLISH' : 'BEARISH';
        const rsiCondition = indicators.rsi < CONFIG.RSI_OVERSOLD ? 'OVERSOLD' :
            indicators.rsi > CONFIG.RSI_OVERBOUGHT ? 'OVERBOUGHT' : 'NEUTRAL';

        this.log('🎯 Market Conditions:', 'ANALYSIS');
        this.log(`   Price vs EMA200: ${priceTrend} (${indicators.price > indicators.ema200 ? 'Above' : 'Below'})`, 'ANALYSIS');
        this.log(`   Ribbon Trend: ${ribbonTrend}`, 'ANALYSIS');
        this.log(`   RSI Status: ${rsiCondition}`, 'ANALYSIS');

        // Check for trade signals
        let signal = null;

        // LONG Signal
        if (indicators.price > indicators.ema200 &&
            indicators.ribbonAvg > indicators.ema200 &&
            indicators.rsi < CONFIG.RSI_OVERSOLD &&
            prediction === 'UP') {
            signal = 'CALL';
            this.logSeparator();
            this.log('🎯 LONG SIGNAL DETECTED! 🎯', 'SIGNAL');
            this.log('✅ All conditions met for CALL entry:', 'SIGNAL');
            this.log('   ✓ Price > 200 EMA (Bullish trend)', 'SIGNAL');
            this.log('   ✓ Ribbon > 200 EMA (Strong bullish momentum)', 'SIGNAL');
            this.log(`   ✓ RSI < ${CONFIG.RSI_OVERSOLD} (Oversold - reversal expected)`, 'SIGNAL');
            this.log('   ✓ kNN predicts UP movement', 'SIGNAL');
        }

        // SHORT Signal
        if (indicators.price < indicators.ema200 &&
            indicators.ribbonAvg < indicators.ema200 &&
            indicators.rsi > CONFIG.RSI_OVERBOUGHT &&
            prediction === 'DOWN') {
            signal = 'PUT';
            this.logSeparator();
            this.log('🎯 SHORT SIGNAL DETECTED! 🎯', 'SIGNAL');
            this.log('✅ All conditions met for PUT entry:', 'SIGNAL');
            this.log('   ✓ Price < 200 EMA (Bearish trend)', 'SIGNAL');
            this.log('   ✓ Ribbon < 200 EMA (Strong bearish momentum)', 'SIGNAL');
            this.log(`   ✓ RSI > ${CONFIG.RSI_OVERBOUGHT} (Overbought - reversal expected)`, 'SIGNAL');
            this.log('   ✓ kNN predicts DOWN movement', 'SIGNAL');
        }

        if (signal) {
            this.executeTrade(signal, indicators.price);

            // Add to kNN history
            this.knnHistory.push({
                rsi: indicators.rsi,
                roc: indicators.roc,
                direction: signal === 'CALL' ? 1 : -1
            });

            if (this.knnHistory.length > CONFIG.KNN_HISTORY_SIZE) {
                this.knnHistory.shift();
            }
        } else {
            this.log('❌ No trade signal - conditions not met', 'INFO');
        }

        this.logSeparator();
    }

    executeTrade(contractType, currentPrice) {
        // Check max open trades
        if (this.activeTrade !== null) {
            this.log('Max open trades reached. Skipping trade.', 'WARNING');
            return;
        }

        // Calculate stake (1% of investment amount)
        const stake = CONFIG.INVESTMENT_AMOUNT * CONFIG.RISK_PERCENTAGE;

        // Calculate Stop Loss and Take Profit
        const slDistance = currentPrice * CONFIG.SL_PERCENTAGE;
        const tpDistance = slDistance * CONFIG.RISK_REWARD_RATIO;

        const stopLoss = contractType === 'CALL' ?
            currentPrice - slDistance : currentPrice + slDistance;
        const takeProfit = contractType === 'CALL' ?
            currentPrice + tpDistance : currentPrice - tpDistance;

        this.log(`💰 Executing ${contractType} Trade:`, 'TRADE');
        this.log(`   Stake: $${stake.toFixed(2)}`, 'TRADE');
        this.log(`   Entry: ${currentPrice.toFixed(2)}`, 'TRADE');
        this.log(`   Stop Loss: ${stopLoss.toFixed(2)} (${(CONFIG.SL_PERCENTAGE * 100).toFixed(2)}%)`, 'TRADE');
        this.log(`   Take Profit: ${takeProfit.toFixed(2)} (${(CONFIG.SL_PERCENTAGE * CONFIG.RISK_REWARD_RATIO * 100).toFixed(2)}%)`, 'TRADE');
        this.log(`   Risk/Reward: 1:${CONFIG.RISK_REWARD_RATIO}`, 'TRADE');

        // Execute trade
        this.sendRequest({
            buy: 1,
            price: stake,
            parameters: {
                contract_type: contractType,
                symbol: CONFIG.SYMBOL,
                duration: 5,
                duration_unit: 'm',
                basis: 'stake',
                amount: stake
            }
        });
    }

    // ========================================================================
    // BOT CONTROL
    // ========================================================================

    startTrading() {
        if (!this.isAuthorized) {
            this.log('Cannot start trading - not authorized', 'ERROR');
            return;
        }

        if (this.candles.length < CONFIG.TREND_EMA_PERIOD) {
            this.log('Cannot start trading - insufficient historical data', 'ERROR');
            return;
        }

        this.isTrading = true;
        this.log('='.repeat(80), 'SUCCESS');
        this.log('🚀 TRADING STARTED', 'SUCCESS');
        this.log('='.repeat(80), 'SUCCESS');
    }

    stopTrading() {
        this.isTrading = false;
        this.log('='.repeat(80), 'WARNING');
        this.log('⏸️  TRADING STOPPED', 'WARNING');
        this.log('='.repeat(80), 'WARNING');
    }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

function main() {
    // Clear log file on startup
    // fs.writeFileSync('trading_bot.log', `=== Trading Bot Started at ${new Date().toISOString()} ===\n`, { flag: 'w' });

    console.clear();
    console.log('\n' + '='.repeat(100));
    console.log('\x1b[36m%s\x1b[0m', '                       🤖 DERIV ML TRADING BOT - v2.0 🤖');
    console.log('='.repeat(100));
    console.log('\x1b[33m%s\x1b[0m', '  📊 Strategy: Machine Learning kNN + EMA Ribbon + RSI');
    console.log('\x1b[33m%s\x1b[0m', '  📈 Market: Volatility 100 Index (R_100)');
    console.log('\x1b[33m%s\x1b[0m', '  ⏱️  Timeframe: 3 minutes');
    console.log('\x1b[33m%s\x1b[0m', '  💰 Investment per Trade: $' + (CONFIG.INVESTMENT_AMOUNT * CONFIG.RISK_PERCENTAGE).toFixed(2));
    console.log('\x1b[33m%s\x1b[0m', '  🎯 Risk/Reward Ratio: 1:' + CONFIG.RISK_REWARD_RATIO);
    console.log('='.repeat(100) + '\n');

    // Validate API token
    if (!CONFIG.API_TOKEN || CONFIG.API_TOKEN === 'YOUR_DERIV_API_TOKEN_HERE') {
        console.error('\x1b[31m%s\x1b[0m', '\n❌ ERROR: API TOKEN NOT CONFIGURED!\n');
        console.log('\x1b[33m%s\x1b[0m', '📝 Please follow these steps:');
        console.log('   1. Go to https://app.deriv.com/account/api-token');
        console.log('   2. Create a new API token with "Trade" and "Read" permissions');
        console.log('   3. Copy the token');
        console.log('   4. Open bot.js and replace "YOUR_DERIV_API_TOKEN_HERE" with your token');
        console.log('   5. Save and restart the bot\n');
        process.exit(1);
    }

    console.log('\x1b[32m%s\x1b[0m', '✅ Configuration validated successfully!');
    console.log('\x1b[32m%s\x1b[0m', '✅ API Token detected');
    console.log('\x1b[32m%s\x1b[0m', '✅ Required modules loaded\n');

    // Create and start bot
    const bot = new DerivBot();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n\n' + '='.repeat(100));
        console.log('\x1b[33m%s\x1b[0m', '⚠️  Received shutdown signal (CTRL+C)');
        console.log('🛑 Shutting down bot gracefully...');
        bot.disconnect();
        console.log('✅ Bot stopped successfully');
        // console.log('📄 Logs saved to trading_bot.log');
        console.log('='.repeat(100) + '\n');
        setTimeout(() => {
            process.exit(0);
        }, 1000);
    });

    process.on('SIGTERM', () => {
        bot.disconnect();
        process.exit(0);
    });

    process.on('uncaughtException', (error) => {
        console.error('\x1b[31m%s\x1b[0m', '\n❌ UNCAUGHT EXCEPTION:');
        console.error(error);
        bot.log(`Uncaught Exception: ${error.message}`, 'ERROR');
        bot.log(`Stack: ${error.stack}`, 'ERROR');
        bot.disconnect();
        process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('\x1b[31m%s\x1b[0m', '\n❌ UNHANDLED REJECTION:');
        console.error('Reason:', reason);
        bot.log(`Unhandled Rejection: ${reason}`, 'ERROR');
    });

    // Connect to Deriv
    bot.connect();

    // Auto-start trading after data is loaded
    setTimeout(() => {
        if (bot.isAuthorized && !bot.isTrading && bot.candles.length >= CONFIG.TREND_EMA_PERIOD) {
            bot.startTrading();
        } else if (!bot.isAuthorized) {
            bot.log('⚠️  Authorization failed - cannot start trading', 'WARNING');
        } else if (bot.candles.length < CONFIG.TREND_EMA_PERIOD) {
            bot.log('⚠️  Insufficient candle data - waiting for more data...', 'WARNING');
        }
    }, 15000); // Wait 15 seconds for data to load
}

// Check for required dependencies
try {
    require.resolve('ws');
    console.log('\x1b[32m%s\x1b[0m', '✅ WebSocket library (ws) found');
} catch (e) {
    console.error('\x1b[31m%s\x1b[0m', '\n❌ ERROR: Required dependency "ws" not found!\n');
    console.log('\x1b[33m%s\x1b[0m', '📝 Please install it by running:');
    console.log('   npm install ws\n');
    process.exit(1);
}

// Run the bot
if (require.main === module) {
    main();
}

module.exports = DerivBot;
