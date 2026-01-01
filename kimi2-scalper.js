/**
 * Deriv Grid Scalping Bot - FIXED VERSION
 * Production-ready automated trading bot for Deriv Multiplier
 * Implements grid trading strategy with comprehensive risk management
 * 
 * @version 2.0.0 (Fixed)
 * @date 2025-01-01
 */

const WebSocket = require('ws');
const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

/**
 * Configuration Object
 */
const CONFIG = {
    // Trading Parameters
    symbol: 'R_100',
    stake: 1.00,
    multiplier: 100,
    gridLevels: 5,
    gridSpacing: 0.5,              // Grid spacing in price units

    // Risk Management
    maxDailyLoss: 50.00,
    maxTradesPerHour: 10,
    stopLossPercentage: 50,        // 50% of stake
    takeProfitPercentage: 100,     // 100% of stake
    maxOpenPositions: 3,

    // Time-based Settings
    tradingHours: {
        start: 0,
        end: 23,
        days: [0, 1, 2, 3, 4, 5, 6]  // All days for synthetic indices
    },

    // Technical Analysis
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    atrPeriod: 14,

    // API and Connection
    apiUrl: 'wss://ws.derivws.com/websockets/v3?app_id=',
    appId: '1089',
    apiToken: 'Dz2V2KvRf4Uukt3',
    reconnectDelay: 5000,
    maxReconnectAttempts: 5,

    // Logging and Monitoring
    logLevel: 'INFO',
    logFile: './logs/bot.log',
    performanceTracking: true,

    // Safety Features
    enableTrendFilter: true,
    enableVolatilityFilter: true,
    minConfidenceScore: 0.6,
    tradeCooldownMs: 30000         // 30 seconds between trades
};

/**
 * Logger Class
 */
class Logger {
    constructor(config) {
        this.config = config;
        this.logQueue = [];
        this.isWriting = false;
        this.ensureLogDirectory();
    }

    async ensureLogDirectory() {
        try {
            const logDir = path.dirname(this.config.logFile);
            await fs.mkdir(logDir, { recursive: true });
        } catch (error) {
            // Ignore if directory exists
        }
    }

    log(level, message, data = {}) {
        const timestamp = new Date().toISOString();
        const dataStr = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
        const formattedMessage = `[${timestamp}] [${level}] ${message}${dataStr}`;

        // Color coding for console
        const colors = {
            DEBUG: '\x1b[36m',
            INFO: '\x1b[32m',
            WARN: '\x1b[33m',
            ERROR: '\x1b[31m',
            RESET: '\x1b[0m'
        };

        console.log(`${colors[level] || ''}${formattedMessage}${colors.RESET}`);

        // Queue for file writing
        this.logQueue.push(formattedMessage);
        this.flushLogs();
    }

    async flushLogs() {
        if (this.isWriting || this.logQueue.length === 0) return;

        this.isWriting = true;
        const logsToWrite = this.logQueue.splice(0);
        const logContent = logsToWrite.join('\n') + '\n';

        try {
            await fs.appendFile(this.config.logFile, logContent);
        } catch (error) {
            // Silently fail file logging
        } finally {
            this.isWriting = false;
            if (this.logQueue.length > 0) {
                this.flushLogs();
            }
        }
    }

    debug(message, data) { if (this.shouldLog('DEBUG')) this.log('DEBUG', message, data); }
    info(message, data) { if (this.shouldLog('INFO')) this.log('INFO', message, data); }
    warn(message, data) { if (this.shouldLog('WARN')) this.log('WARN', message, data); }
    error(message, data) { if (this.shouldLog('ERROR')) this.log('ERROR', message, data); }

    shouldLog(level) {
        const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
        return levels[level] >= levels[this.config.logLevel];
    }
}

/**
 * Risk Manager
 */
class RiskManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.dailyLoss = 0;
        this.tradesThisHour = 0;
        this.hourStartTime = Date.now();
        this.openPositions = new Map();
        this.accountBalance = 0;
        this.initialBalance = 0;
        this.lastTradeTime = 0;
    }

    updateAccountBalance(balance) {
        if (this.initialBalance === 0) {
            this.initialBalance = balance;
        }
        const previousBalance = this.accountBalance;
        this.accountBalance = balance;

        // Track daily loss
        if (balance < previousBalance) {
            this.dailyLoss += (previousBalance - balance);
        }
    }

    canOpenPosition() {
        const now = Date.now();

        // Reset hourly counter
        if (now - this.hourStartTime >= 3600000) {
            this.tradesThisHour = 0;
            this.hourStartTime = now;
        }

        // Check cooldown
        if (now - this.lastTradeTime < this.config.tradeCooldownMs) {
            this.logger.debug('Trade cooldown active', {
                remaining: Math.ceil((this.config.tradeCooldownMs - (now - this.lastTradeTime)) / 1000) + 's'
            });
            return false;
        }

        // Check position limit
        if (this.openPositions.size >= this.config.maxOpenPositions) {
            this.logger.warn('Maximum open positions reached', {
                current: this.openPositions.size,
                max: this.config.maxOpenPositions
            });
            return false;
        }

        // Check daily loss limit
        if (this.dailyLoss >= this.config.maxDailyLoss) {
            this.logger.warn('Daily loss limit reached', {
                current: this.dailyLoss.toFixed(2),
                limit: this.config.maxDailyLoss
            });
            return false;
        }

        // Check hourly trade limit
        if (this.tradesThisHour >= this.config.maxTradesPerHour) {
            this.logger.warn('Hourly trade limit reached', {
                current: this.tradesThisHour,
                limit: this.config.maxTradesPerHour
            });
            return false;
        }

        // Check trading hours
        if (!this.isTradingHours()) {
            this.logger.debug('Outside trading hours');
            return false;
        }

        return true;
    }

    isTradingHours() {
        const now = new Date();
        const currentHour = now.getHours();
        const currentDay = now.getDay();

        return this.config.tradingHours.days.includes(currentDay) &&
            currentHour >= this.config.tradingHours.start &&
            currentHour <= this.config.tradingHours.end;
    }

    recordTradeAttempt() {
        this.lastTradeTime = Date.now();
        this.tradesThisHour++;
    }

    addPosition(contractId, positionData) {
        this.openPositions.set(contractId, {
            ...positionData,
            openTime: Date.now()
        });
        this.logger.info('Position opened', {
            contractId,
            openPositions: this.openPositions.size
        });
    }

    removePosition(contractId) {
        const position = this.openPositions.get(contractId);
        if (position) {
            this.openPositions.delete(contractId);
            this.logger.info('Position closed', {
                contractId,
                openPositions: this.openPositions.size
            });
            return position;
        }
        return null;
    }

    getOpenPositions() {
        return Array.from(this.openPositions.entries());
    }

    getRiskMetrics() {
        return {
            dailyLoss: this.dailyLoss.toFixed(2),
            dailyLossLimit: this.config.maxDailyLoss,
            openPositions: this.openPositions.size,
            maxOpenPositions: this.config.maxOpenPositions,
            tradesThisHour: this.tradesThisHour,
            maxTradesPerHour: this.config.maxTradesPerHour,
            accountBalance: this.accountBalance.toFixed(2),
            initialBalance: this.initialBalance.toFixed(2)
        };
    }

    resetDailyStats() {
        this.dailyLoss = 0;
        this.initialBalance = this.accountBalance;
        this.logger.info('Daily stats reset');
    }
}

/**
 * Technical Analysis Module
 */
class TechnicalAnalysis {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.priceHistory = [];
        this.indicators = {};
    }

    addPrice(tick) {
        this.priceHistory.push({
            timestamp: Date.now(),
            price: parseFloat(tick.quote),
            symbol: tick.symbol
        });

        // Keep only recent prices
        if (this.priceHistory.length > 1000) {
            this.priceHistory.shift();
        }

        this.calculateIndicators();
    }

    calculateIndicators() {
        if (this.priceHistory.length < this.config.rsiPeriod + 1) return;

        const prices = this.priceHistory.map(p => p.price);

        this.indicators.rsi = this.calculateRSI(prices);
        this.indicators.atr = this.calculateATR(prices);
        this.indicators.sma20 = this.calculateSMA(prices, 20);
        this.indicators.sma50 = this.calculateSMA(prices, 50);
        this.indicators.currentPrice = prices[prices.length - 1];
    }

    calculateRSI(prices, period = this.config.rsiPeriod) {
        if (prices.length < period + 1) return 50;

        let gains = 0;
        let losses = 0;

        for (let i = prices.length - period; i < prices.length; i++) {
            const change = prices[i] - prices[i - 1];
            if (change > 0) gains += change;
            else losses += Math.abs(change);
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;

        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    calculateATR(prices, period = this.config.atrPeriod) {
        if (prices.length < period + 1) return 0;

        const trValues = [];
        for (let i = prices.length - period; i < prices.length; i++) {
            const tr = Math.abs(prices[i] - prices[i - 1]);
            trValues.push(tr);
        }

        return trValues.reduce((a, b) => a + b, 0) / trValues.length;
    }

    calculateSMA(prices, period) {
        if (prices.length < period) return prices[prices.length - 1] || 0;
        const slice = prices.slice(-period);
        return slice.reduce((a, b) => a + b, 0) / period;
    }

    getSignal() {
        const rsi = this.indicators.rsi || 50;
        const currentPrice = this.indicators.currentPrice || 0;
        const sma20 = this.indicators.sma20 || currentPrice;
        const sma50 = this.indicators.sma50 || currentPrice;

        let signal = 'HOLD';
        let confidence = 0.5;
        let reasons = [];

        // RSI-based signals
        if (rsi < this.config.rsiOversold) {
            signal = 'BUY';
            confidence = 0.5 + ((this.config.rsiOversold - rsi) / this.config.rsiOversold) * 0.3;
            reasons.push(`RSI oversold (${rsi.toFixed(2)})`);
        } else if (rsi > this.config.rsiOverbought) {
            signal = 'SELL';
            confidence = 0.5 + ((rsi - this.config.rsiOverbought) / (100 - this.config.rsiOverbought)) * 0.3;
            reasons.push(`RSI overbought (${rsi.toFixed(2)})`);
        }

        // Trend filter
        if (this.config.enableTrendFilter && signal !== 'HOLD') {
            const trend = sma20 > sma50 ? 'UP' : 'DOWN';
            if ((signal === 'BUY' && trend === 'UP') || (signal === 'SELL' && trend === 'DOWN')) {
                confidence += 0.2;
                reasons.push(`Trend aligned (${trend})`);
            } else if ((signal === 'BUY' && trend === 'DOWN') || (signal === 'SELL' && trend === 'UP')) {
                confidence -= 0.2;
                reasons.push(`Trend opposing (${trend})`);
            }
        }

        return {
            signal,
            confidence: Math.max(0, Math.min(1, confidence)),
            rsi: rsi.toFixed(2),
            currentPrice: currentPrice.toFixed(5),
            trend: sma20 > sma50 ? 'UP' : 'DOWN',
            reasons
        };
    }

    getIndicators() {
        return this.indicators;
    }
}

/**
 * Grid Manager - Extends EventEmitter for proper event handling
 */
class GridManager extends EventEmitter {
    constructor(config, logger, riskManager) {
        super();
        this.config = config;
        this.logger = logger;
        this.riskManager = riskManager;
        this.gridLevels = [];
        this.currentPrice = 0;
        this.previousPrice = 0;
        this.isGridActive = false;
        this.basePrice = 0;
    }

    updatePrice(price) {
        this.previousPrice = this.currentPrice;
        this.currentPrice = price;

        if (!this.isGridActive && this.previousPrice > 0) {
            this.initializeGrid();
        }

        if (this.isGridActive && this.previousPrice > 0) {
            this.checkGridTriggers();
        }
    }

    initializeGrid() {
        this.basePrice = this.currentPrice;
        const levels = this.config.gridLevels;
        const spacing = this.config.gridSpacing;

        this.gridLevels = [];

        // Create buy levels below current price
        for (let i = 1; i <= Math.floor(levels / 2); i++) {
            this.gridLevels.push({
                type: 'BUY',
                level: i,
                price: this.basePrice - (spacing * i),
                triggered: false
            });
        }

        // Create sell levels above current price
        for (let i = 1; i <= Math.ceil(levels / 2); i++) {
            this.gridLevels.push({
                type: 'SELL',
                level: i,
                price: this.basePrice + (spacing * i),
                triggered: false
            });
        }

        this.isGridActive = true;
        this.logger.info('Grid initialized', {
            basePrice: this.basePrice.toFixed(5),
            levels: this.gridLevels.length,
            spacing: spacing
        });
    }

    checkGridTriggers() {
        if (!this.riskManager.canOpenPosition()) return;

        for (const level of this.gridLevels) {
            if (level.triggered) continue;

            let shouldTrigger = false;

            if (level.type === 'BUY') {
                // Price crossed down through buy level
                shouldTrigger = this.previousPrice > level.price && this.currentPrice <= level.price;
            } else {
                // Price crossed up through sell level
                shouldTrigger = this.previousPrice < level.price && this.currentPrice >= level.price;
            }

            if (shouldTrigger) {
                level.triggered = true;
                this.logger.info('Grid level triggered', {
                    type: level.type,
                    level: level.level,
                    triggerPrice: level.price.toFixed(5),
                    currentPrice: this.currentPrice.toFixed(5)
                });

                // Emit event for trade execution
                this.emit('gridTrigger', {
                    type: level.type,
                    price: level.price,
                    level: level.level,
                    timestamp: Date.now()
                });
            }
        }
    }

    resetGrid() {
        this.gridLevels = [];
        this.isGridActive = false;
        this.basePrice = 0;
        this.logger.info('Grid reset');
    }

    getGridStatus() {
        const buyLevels = this.gridLevels.filter(l => l.type === 'BUY');
        const sellLevels = this.gridLevels.filter(l => l.type === 'SELL');

        return {
            isActive: this.isGridActive,
            basePrice: this.basePrice,
            currentPrice: this.currentPrice,
            totalLevels: this.gridLevels.length,
            buyLevelsTriggered: buyLevels.filter(l => l.triggered).length,
            sellLevelsTriggered: sellLevels.filter(l => l.triggered).length,
            buyLevelsAvailable: buyLevels.filter(l => !l.triggered).length,
            sellLevelsAvailable: sellLevels.filter(l => !l.triggered).length
        };
    }
}

/**
 * Main Trading Bot Class - FIXED
 */
class DerivGridScalperBot extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = { ...CONFIG, ...config };
        this.logger = new Logger(this.config);
        this.riskManager = new RiskManager(this.config, this.logger);
        this.technicalAnalysis = new TechnicalAnalysis(this.config, this.logger);
        this.gridManager = new GridManager(this.config, this.logger, this.riskManager);

        this.ws = null;
        this.isConnected = false;
        this.isAuthorized = false;
        this.reconnectAttempts = 0;
        this.contracts = new Map();
        this.lastTickTime = Date.now();
        this.requestId = 0;
        this.pendingRequests = new Map();

        // Performance tracking
        this.performance = {
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            totalProfit: 0,
            totalLoss: 0,
            startTime: Date.now()
        };

        // Bind methods that need binding
        this.handleMessage = this.handleMessage.bind(this);
        this.handleError = this.handleError.bind(this);
        this.handleClose = this.handleClose.bind(this);
        this.handleGridTrigger = this.handleGridTrigger.bind(this);

        // Connect grid manager events
        this.gridManager.on('gridTrigger', this.handleGridTrigger);

        // Telegram Configuration
        this.telegramToken = process.env.TELEGRAM_BOT_TOKEN3;
        this.telegramChatId = process.env.TELEGRAM_CHAT_ID2;
        this.telegramEnabled = !!(this.telegramToken && this.telegramChatId);

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
            this.logger.info('📱 Telegram notifications enabled');
        } else {
            this.logger.warn('📱 Telegram notifications disabled (missing API keys)');
        }
    }

    /**
     * Connect to Deriv WebSocket API
     */
    async connect() {
        return new Promise((resolve, reject) => {
            try {
                const url = `${this.config.apiUrl}${this.config.appId}`;
                this.logger.info('Connecting to Deriv API', { url });

                this.ws = new WebSocket(url);

                this.ws.on('open', () => {
                    this.logger.info('WebSocket connected');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.authenticate().then(resolve).catch(reject);
                });

                this.ws.on('message', this.handleMessage);
                this.ws.on('error', this.handleError);
                this.ws.on('close', this.handleClose);

            } catch (error) {
                this.logger.error('Connection failed', { error: error.message });
                reject(error);
            }
        });
    }

    /**
     * Authenticate with API
     */
    async authenticate() {
        const token = this.config.apiToken;

        if (!token) {
            throw new Error('DERIV_API_TOKEN not set');
        }

        this.logger.info('Authenticating...');

        return new Promise((resolve, reject) => {
            const reqId = this.send({ authorize: token });

            this.pendingRequests.set(reqId, { resolve, reject, type: 'authorize' });

            // Timeout after 30 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(reqId)) {
                    this.pendingRequests.delete(reqId);
                    reject(new Error('Authentication timeout'));
                }
            }, 30000);
        });
    }

    /**
     * Handle incoming WebSocket messages
     */
    handleMessage(data) {
        try {
            const message = JSON.parse(data.toString());
            const reqId = message.req_id;

            // Handle errors
            if (message.error) {
                this.logger.error('API Error', {
                    code: message.error.code,
                    message: message.error.message,
                    msgType: message.msg_type
                });

                if (this.pendingRequests.has(reqId)) {
                    const { reject } = this.pendingRequests.get(reqId);
                    this.pendingRequests.delete(reqId);
                    reject(message.error);
                }
                return;
            }

            // Handle pending request responses
            if (this.pendingRequests.has(reqId)) {
                const { resolve } = this.pendingRequests.get(reqId);
                this.pendingRequests.delete(reqId);
                resolve(message);
            }

            // Route message by type
            switch (message.msg_type) {
                case 'authorize':
                    this.handleAuthorization(message);
                    break;
                case 'tick':
                    this.handleTick(message);
                    break;
                case 'buy':
                    this.handleBuyResponse(message);
                    break;
                case 'proposal_open_contract':
                    this.handleContractUpdate(message);
                    break;
                case 'sell':
                    this.handleSellResponse(message);
                    break;
                case 'balance':
                    this.handleBalanceUpdate(message);
                    break;
                default:
                    this.logger.debug('Message received', { type: message.msg_type });
            }
        } catch (error) {
            this.logger.error('Failed to parse message', { error: error.message });
        }
    }

    /**
     * Handle authorization response
     */
    handleAuthorization(message) {
        if (message.authorize) {
            this.isAuthorized = true;
            this.riskManager.updateAccountBalance(parseFloat(message.authorize.balance));

            this.logger.info('✅ Authorization successful', {
                account: message.authorize.loginid,
                balance: message.authorize.balance,
                currency: message.authorize.currency
            });

            // Subscribe to balance updates
            this.send({ balance: 1, subscribe: 1 });

            // Subscribe to market data
            this.subscribeToMarketData();

            this.emit('ready');
        }
    }

    /**
     * Subscribe to market tick data
     */
    subscribeToMarketData() {
        this.logger.info('Subscribing to market data', { symbol: this.config.symbol });
        this.send({ ticks: this.config.symbol, subscribe: 1 });
    }

    /**
     * Handle tick data
     */
    handleTick(message) {
        if (!message.tick) return;

        const tick = message.tick;
        this.lastTickTime = Date.now();

        // Update technical analysis
        this.technicalAnalysis.addPrice(tick);

        // Update grid manager
        this.gridManager.updatePrice(parseFloat(tick.quote));

        // Check for signal-based trading opportunities
        this.evaluateTradingOpportunity();

        this.emit('tick', tick);
    }

    /**
     * Handle balance updates
     */
    handleBalanceUpdate(message) {
        if (message.balance) {
            const newBalance = parseFloat(message.balance.balance);
            this.riskManager.updateAccountBalance(newBalance);
            this.logger.debug('Balance updated', { balance: newBalance.toFixed(2) });
        }
    }

    /**
     * Handle grid trigger events - EXECUTE TRADES
     */
    handleGridTrigger(triggerData) {
        this.logger.info('📊 Grid trigger received', triggerData);

        if (!this.riskManager.canOpenPosition()) {
            this.logger.warn('Cannot open position - risk limits');
            return;
        }

        // Execute trade based on grid trigger
        this.placeTrade(triggerData.type);
    }

    /**
     * Evaluate trading opportunities based on technical analysis
     */
    evaluateTradingOpportunity() {
        if (!this.riskManager.canOpenPosition()) return;

        const signal = this.technicalAnalysis.getSignal();

        if (signal.signal !== 'HOLD' && signal.confidence >= this.config.minConfidenceScore) {
            this.logger.info('📈 Trading signal detected', signal);
            this.placeTrade(signal.signal);
        }
    }

    /**
     * Place a trade - THE MISSING METHOD THAT CAUSED THE ERROR
     */
    placeTrade(direction) {
        if (!this.isAuthorized) {
            this.logger.error('Cannot trade - not authorized');
            return;
        }

        if (!this.riskManager.canOpenPosition()) {
            this.logger.warn('Cannot trade - risk limits reached');
            return;
        }

        const contractType = direction === 'BUY' ? 'MULTUP' : 'MULTDOWN';
        const stake = this.config.stake;
        const multiplier = this.config.multiplier;

        // Calculate SL/TP amounts
        const stopLoss = Number((stake * this.config.stopLossPercentage / 100).toFixed(2));
        const takeProfit = Number((stake * this.config.takeProfitPercentage / 100).toFixed(2));

        // CORRECT API structure for multiplier contracts
        const buyRequest = {
            buy: 1,
            subscribe: 1,
            price: stake,
            parameters: {
                contract_type: contractType,
                symbol: this.config.symbol,
                currency: 'USD',
                amount: stake,
                basis: 'stake',           // ← REQUIRED for multipliers
                multiplier: multiplier
            }
        };

        this.logger.info(`🚀 Placing ${direction} trade`, {
            contractType,
            stake,
            multiplier,
            stopLoss,
            takeProfit
        });

        // Record trade attempt
        this.riskManager.recordTradeAttempt();

        // Store pending SL/TP for after contract creation
        this.pendingLimits = { stopLoss, takeProfit };

        this.send(buyRequest);
    }

    /**
     * Handle buy response
     */
    async handleBuyResponse(message) {
        if (!message.buy) return;

        const contract = message.buy;
        const contractId = contract.contract_id;

        this.logger.info('✅ Trade executed', {
            contractId,
            type: contract.longcode,
            buyPrice: contract.buy_price
        });

        // Track contract
        this.contracts.set(contractId, {
            ...contract,
            entryTime: Date.now(),
            status: 'open'
        });

        // Add to risk manager
        this.riskManager.addPosition(contractId, contract);

        // Update performance
        this.performance.totalTrades++;

        // Set stop loss and take profit via contract_update
        if (this.pendingLimits) {
            try {
                await this.setContractLimits(contractId, this.pendingLimits.stopLoss, this.pendingLimits.takeProfit);
            } catch (error) {
                this.logger.warn('Failed to set SL/TP', { error: error.message });
            }
            this.pendingLimits = null;
        }

        // Subscription to contract updates is automatically started by 'subscribe: 1' in buyRequest

        this.emit('tradeExecuted', contract);
    }

    /**
     * Set contract limits (SL/TP) after purchase
     */
    async setContractLimits(contractId, stopLoss, takeProfit) {
        const request = {
            contract_update: 1,
            contract_id: contractId,
            limit_order: {}
        };

        if (stopLoss > 0) {
            request.limit_order.stop_loss = stopLoss;
        }
        if (takeProfit > 0) {
            request.limit_order.take_profit = takeProfit;
        }

        this.logger.info('Setting contract limits', { contractId, stopLoss, takeProfit });
        this.send(request);
    }

    /**
     * Handle contract updates
     */
    handleContractUpdate(message) {
        if (!message.proposal_open_contract) return;

        const contract = message.proposal_open_contract;
        const contractId = contract.contract_id;

        // Check if contract is settled
        if (contract.is_sold === 1 || contract.status === 'sold') {
            this.handleContractSettlement(contractId, contract);
        } else {
            // Update contract in tracking
            if (this.contracts.has(contractId)) {
                const existingContract = this.contracts.get(contractId);
                const updatedContract = { ...existingContract, ...contract };
                this.contracts.set(contractId, updatedContract);

                // Detailed active trade logging - Throttle to every 5 seconds to avoid spam
                const now = Date.now();
                if (!updatedContract.lastLogTime || now - updatedContract.lastLogTime >= 5000) {
                    updatedContract.lastLogTime = now;

                    const profit = parseFloat(contract.profit || 0);
                    const stake = parseFloat(existingContract.buy_price || this.config.stake);
                    const profitPercent = (profit / stake * 100).toFixed(2);
                    const entryPrice = parseFloat(contract.entry_spot || existingContract.entry_spot || stake);
                    const currentPrice = parseFloat(contract.current_spot);
                    const direction = updatedContract.contract_type === 'MULTUP' ? '⬆️ CALL' : '⬇️ PUT';
                    const symbol = updatedContract.display_name || this.config.symbol;

                    console.log(`\n  [ACTIVE] ${symbol} | ${direction}`);
                    console.log(`  ID: ${contractId} | Entry: ${entryPrice.toFixed(5)} | Current: ${currentPrice.toFixed(5)}`);
                    console.log(`  Profit: $${profit.toFixed(2)} (${profitPercent}%) | Status: ${contract.status.toUpperCase()}`);
                }
            }
        }
    }

    /**
     * Handle contract settlement
     */
    handleContractSettlement(contractId, contract) {
        const profit = parseFloat(contract.profit || 0);
        const isWinning = profit > 0;
        const stake = parseFloat(contract.buy_price || this.config.stake);
        const profitPercent = (profit / stake * 100).toFixed(2);

        // Update performance
        if (isWinning) {
            this.performance.winningTrades++;
            this.performance.totalProfit += profit;
        } else {
            this.performance.losingTrades++;
            this.performance.totalLoss += Math.abs(profit);
        }

        // Remove from tracking
        this.riskManager.removePosition(contractId);
        this.contracts.delete(contractId);

        const emoji = isWinning ? '💰 WIN' : '📉 LOSS';
        const separator = '═'.repeat(50);

        console.log(`\n${separator}`);
        console.log(`  ${emoji} - Trade Completed`);
        console.log(`${separator}`);
        console.log(`  Contract ID: ${contractId}`);
        console.log(`  Type       : ${contract.contract_type === 'MULTUP' ? 'UP (Call)' : 'DOWN (Put)'}`);
        console.log(`  Stake      : $${stake.toFixed(2)}`);
        console.log(`  Profit/Loss: $${profit.toFixed(2)} (${profitPercent}%)`);
        console.log(`  Entry Spot : ${contract.entry_tick}`);
        console.log(`  Exit Spot  : ${contract.exit_tick}`);
        console.log(`  Status     : ${contract.status.toUpperCase()}`);
        console.log(`${separator}`);
        console.log(`  Account Balance: $${this.riskManager.accountBalance.toFixed(2)}`);
        console.log(`  Win Rate       : ${this.getWinRate()}`);
        console.log(`${separator}\n`);

        this.emit('contractSettled', { contract, profit, isWinning });
    }

    /**
     * Handle sell response
     */
    handleSellResponse(message) {
        if (message.sell) {
            this.logger.info('Contract sold', {
                contractId: message.sell.contract_id,
                soldFor: message.sell.sold_for
            });
        }
    }

    /**
     * Handle WebSocket errors
     */
    handleError(error) {
        this.logger.error('WebSocket error', { message: error.message });
    }

    /**
     * Handle WebSocket close
     */
    handleClose(code, reason) {
        this.logger.warn('WebSocket disconnected', { code, reason: reason?.toString() });
        this.isConnected = false;
        this.isAuthorized = false;
        this.handleReconnect();
    }

    /**
     * Handle reconnection
     */
    handleReconnect() {
        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            this.logger.error('Max reconnection attempts reached');
            this.emit('maxReconnectAttemptsReached');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.config.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);

        this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);

        setTimeout(() => {
            this.connect().catch(error => {
                this.logger.error('Reconnection failed', { error: error.message });
            });
        }, delay);
    }

    /**
     * Send message to WebSocket
     */
    send(data) {
        if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.logger.error('Cannot send - not connected');
            return null;
        }

        const reqId = ++this.requestId;
        data.req_id = reqId;

        try {
            this.ws.send(JSON.stringify(data));
            this.logger.debug('Message sent', { req_id: reqId, type: Object.keys(data)[0] });
            return reqId;
        } catch (error) {
            this.logger.error('Send failed', { error: error.message });
            return null;
        }
    }

    /**
     * Send message to Telegram
     */
    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;

        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
            this.logger.debug('📱 Telegram notification sent');
        } catch (error) {
            this.logger.error('❌ Failed to send Telegram message:', error.message);
        }
    }

    /**
     * Get detailed Telegram summary
     */
    getTelegramSummary() {
        const metrics = this.getPerformanceMetrics();
        const duration = Math.floor((Date.now() - this.performance.startTime) / 1000 / 60);

        return `<b>📊 Scalper Performance Report</b>
━━━━━━━━━━━━━━━━━━━━━━━━
<b>Asset:</b> <code>${this.config.symbol}</code>
<b>Duration:</b> ${duration} minutes
<b>Total Trades:</b> ${this.performance.totalTrades}
<b>Win Rate:</b> ${metrics.winRate}

✅ <b>Wins:</b> ${this.performance.winningTrades}
❌ <b>Losses:</b> ${this.performance.losingTrades}

💰 <b>Total Profit:</b> $${this.performance.totalProfit.toFixed(2)}
📉 <b>Total Loss:</b> $${this.performance.totalLoss.toFixed(2)}
💵 <b>Net Profit:</b> $${metrics.netProfit}
🏁 <b>Profit Factor:</b> ${metrics.profitFactor}

🏦 <b>Current Balance:</b> $${this.riskManager.accountBalance.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━━━━━`;
    }

    /**
     * Send Trade Execution Notification
     */
    async sendTelegramTradeExecution(contract, direction) {
        const stake = this.config.stake;
        const msg = `🚀 <b>TRADE OPENED</b>
━━━━━━━━━━━━━━━━━━━━━━━━
<b>Type:</b> ${direction === 'BUY' ? '⬆️ CALL (Up)' : '⬇️ PUT (Down)'}
<b>Asset:</b> <code>${this.config.symbol}</code>
<b>Contract ID:</b> <code>${contract.contract_id}</code>
<b>Stake:</b> $${stake.toFixed(2)}
<b>Multiplier:</b> x${this.config.multiplier}

<b>Grid Level:</b> ${this.gridManager.getGridStatus().buyLevelsTriggered + this.gridManager.getGridStatus().sellLevelsTriggered}
<b>Timestamp:</b> ${new Date().toLocaleTimeString()}
━━━━━━━━━━━━━━━━━━━━━━━━`;
        await this.sendTelegramMessage(msg);
    }

    /**
     * Send Trade Settlement Notification
     */
    async sendTelegramTradeSettlement(contract, profit, isWinning) {
        const emoji = isWinning ? '✅ WIN' : '❌ LOSS';
        const profitPercent = (profit / parseFloat(contract.buy_price || this.config.stake) * 100).toFixed(2);

        const msg = `${isWinning ? '💰' : '📉'} <b>TRADE CLOSED: ${emoji}</b>
━━━━━━━━━━━━━━━━━━━━━━━━
<b>Contract ID:</b> <code>${contract.contract_id}</code>
<b>Asset:</b> <code>${this.config.symbol}</code>
<b>Profit/Loss:</b> $${profit.toFixed(2)} (${profitPercent}%)
<b>Entry Spot:</b> ${contract.entry_tick || 'N/A'}
<b>Exit Spot:</b> ${contract.exit_tick || 'N/A'}

<b>Total Trades:</b> ${this.performance.totalTrades}
<b>Session P/L:</b> $${(this.performance.totalProfit - this.performance.totalLoss).toFixed(2)}
<b>Current Balance:</b> $${this.riskManager.accountBalance.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━━━━━`;
        await this.sendTelegramMessage(msg);
    }

    /**
     * Disconnect from API
     */
    async disconnect() {
        this.logger.info('Disconnecting...');

        if (this.ws) {
            // Remove event listeners to prevent reconnection
            this.ws.removeAllListeners('close');
            this.ws.close();
            this.ws = null;
        }

        this.isConnected = false;
        this.isAuthorized = false;
    }

    /**
     * Get win rate percentage
     */
    getWinRate() {
        if (this.performance.totalTrades === 0) return '0.00%';
        return ((this.performance.winningTrades / this.performance.totalTrades) * 100).toFixed(2) + '%';
    }

    /**
     * Get performance metrics
     */
    getPerformanceMetrics() {
        const netProfit = this.performance.totalProfit - this.performance.totalLoss;
        const profitFactor = this.performance.totalLoss > 0
            ? (this.performance.totalProfit / this.performance.totalLoss).toFixed(2)
            : this.performance.totalProfit > 0 ? '∞' : '0';

        return {
            totalTrades: this.performance.totalTrades,
            winningTrades: this.performance.winningTrades,
            losingTrades: this.performance.losingTrades,
            winRate: this.getWinRate(),
            totalProfit: this.performance.totalProfit.toFixed(2),
            totalLoss: this.performance.totalLoss.toFixed(2),
            netProfit: netProfit.toFixed(2),
            profitFactor,
            riskMetrics: this.riskManager.getRiskMetrics(),
            gridStatus: this.gridManager.getGridStatus(),
            uptime: Math.floor((Date.now() - this.performance.startTime) / 1000 / 60) + ' minutes'
        };
    }

    /**
     * Start the bot
     */
    async start() {
        console.log('\n');
        console.log('═══════════════════════════════════════════════════════════════════════════');
        console.log('  DERIV GRID SCALPING BOT v2.0.0');
        console.log('═══════════════════════════════════════════════════════════════════════════');
        console.log('\n');

        this.logger.info('Starting bot', {
            symbol: this.config.symbol,
            stake: this.config.stake,
            multiplier: this.config.multiplier,
            gridLevels: this.config.gridLevels
        });

        // Set up event handlers
        this.on('ready', () => {
            this.logger.info('🚀 Bot is ready for trading');
        });

        this.on('tradeExecuted', (contract) => {
            this.logger.info('📈 Trade event', { contractId: contract.contract_id });
        });

        this.on('contractSettled', ({ profit, isWinning }) => {
            this.logger.info('💰 Settlement', {
                profit: profit.toFixed(2),
                result: isWinning ? 'WIN' : 'LOSS',
                winRate: this.getWinRate()
            });
        });

        if (this.telegramEnabled) {
            this.sendTelegramMessage(`🚀 <b>Bot Started: Grid Scalper v2.0.0</b>\n\n<b>Asset:</b> ${this.config.symbol}\n<b>Stake:</b> $${this.config.stake}\n<b>Balance:</b> $${this.riskManager.accountBalance.toFixed(2)}`);
        }

        // Performance logging interval
        this.performanceInterval = setInterval(() => {
            const metrics = this.getPerformanceMetrics();
            this.logger.info('📊 Performance Report', metrics);

            if (this.telegramEnabled && (this.performance.totalTrades > 0 || metrics.netProfit !== "0.00")) {
                this.sendTelegramMessage(this.getTelegramSummary());
            }
        }, 1800000); // Every 30 minutes

        // Daily stats reset
        this.dailyResetInterval = setInterval(() => {
            const now = new Date();
            if (now.getHours() === 0 && now.getMinutes() === 0) {
                this.riskManager.resetDailyStats();
                this.gridManager.resetGrid();
            }
        }, 60000); // Check every minute

        // Connect
        await this.connect();
    }

    /**
     * Stop the bot
     */
    async stop() {
        this.logger.info('Stopping bot...');

        // Clear intervals
        if (this.performanceInterval) clearInterval(this.performanceInterval);
        if (this.dailyResetInterval) clearInterval(this.dailyResetInterval);

        // Close open positions
        for (const [contractId] of this.contracts) {
            this.logger.info('Closing position', { contractId });
            this.send({ sell: contractId, price: 0 });
        }

        if (this.telegramEnabled) {
            await this.sendTelegramMessage(`⏹ <b>Bot Stopped Gracefully</b>\n\n${this.getTelegramSummary()}`);
        }

        // Wait for positions to close
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Disconnect
        await this.disconnect();

        // Final report
        const metrics = this.getPerformanceMetrics();

        console.log('\n');
        console.log('═══════════════════════════════════════════════════════════════════════════');
        console.log('  FINAL PERFORMANCE REPORT');
        console.log('═══════════════════════════════════════════════════════════════════════════');
        console.log(JSON.stringify(metrics, null, 2));
        console.log('═══════════════════════════════════════════════════════════════════════════');
        console.log('\n');

        this.emit('stopped');
    }
}

/**
 * Main execution
 */
async function main() {
    // Check for API token
    const token = process.env.DERIV_API_TOKEN || process.env.DERIV_TOKEN || process.env.DERIV_TOKENs;
    if (!token) {
        console.error('═══════════════════════════════════════════════════════════════════════════');
        console.error('  ERROR: DERIV_API_TOKEN or DERIV_TOKEN environment variable is required');
        console.error('  Please set it in your .env file');
        console.error('═══════════════════════════════════════════════════════════════════════════');
        process.exit(1);
    }

    // Create bot instance
    const bot = new DerivGridScalperBot();

    // Graceful shutdown handlers
    const shutdown = async (signal) => {
        console.log(`\nReceived ${signal}, shutting down gracefully...`);
        await bot.stop();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('uncaughtException', async (error) => {
        console.error('Uncaught exception:', error);
        await bot.stop();
        process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
        console.error('Unhandled rejection:', reason);
        await bot.stop();
        process.exit(1);
    });

    try {
        await bot.start();
    } catch (error) {
        console.error('Failed to start bot:', error.message);
        process.exit(1);
    }
}

// Run if executed directly
if (require.main === module) {
    main();
}

module.exports = { DerivGridScalperBot, CONFIG };
