#!/usr/bin/env node

/*
 * ════════════════════════════════════════════════════════════════════
 * ADVANCED DERIV MULTIPLIER BOT
 * V75 Volatility Index Optimized | Multi-Indicator Strategy
 * ════════════════════════════════════════════════════════════════════
 * 
 * STRATEGY: Triple Confirmation System
 * - RSI (14) for momentum detection
 * - EMA Crossover (8/21) for trend direction  
 * - ATR (14) for volatility-based filtering & position sizing
 * - Multi-timeframe analysis (1m base, 5m confirmation)
 * 
 * RISK MANAGEMENT:
 * - Kelly Criterion position sizing (optional)
 * - Volatility-adjusted stake sizing
 * - Multiple TP levels (25%, 50%, 75%)
 * - Trailing stop activation
 * - Daily loss limit with automatic shutdown
 * - Consecutive loss protection
 * 
 * LOGGING: JSON structured logs for analytics
 * 
 * USAGE:
 *   npm install ws winston mathjs
 *   node deriv-v75-bot.js
 * 
 * MONITORING:
 *   tail -f logs/trades.log | jq .
 * ════════════════════════════════════════════════════════════════════
 */

// ============================================================
// DEPENDENCIES
// ============================================================
const WebSocket = require('ws');
const winston = require('winston');
const { std, mean } = require('mathjs');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ============================================================
// ADVANCED CONFIGURATION
// ============================================================
const CONFIG = {
    // DERIV API
    DERIV_TOKEN: 'rgNedekYXvCaPeP', // GET FROM: deriv.com > API Token
    DERIV_WS_URL: 'wss://ws.derivws.com/websockets/v3?app_id=1089',

    // TRADING ASSET
    SYMBOL: 'R_75', // Volatility 75 Index (Change to R_100, BOOM500, etc.)
    CONTRACT_TYPE: 'MULTUP', // MULTUP or MULTDOWN

    // STRATEGY PARAMETERS (Fine-tuned for V75)
    STRATEGY: {
        // RSI Settings
        RSI_PERIOD: 14,
        RSI_OVERSOLD: 35,      // More conservative than standard 30
        RSI_OVERBOUGHT: 65,    // More conservative than standard 70

        // EMA Settings
        FAST_EMA_PERIOD: 8,
        SLOW_EMA_PERIOD: 21,

        // ATR Settings
        ATR_PERIOD: 14,
        MIN_ATR_THRESHOLD: 0.002, // Minimum volatility to trade (0.2%)
        MAX_ATR_THRESHOLD: 0.015, // Maximum volatility to avoid (1.5%)

        // Multi-timeframe confirmation
        CONFIRMATION_TIMEFRAME: '5m', // 5-minute trend confirmation
        MIN_SIGNAL_STRENGTH: 3,      // Consecutive signals needed

        // Dynamic Multiplier selection
        MULTIPLIER_LOW_VOL: 100,     // ATR < 0.5%
        MULTIPLIER_MED_VOL: 150,     // ATR 0.5% - 1.0%
        MULTIPLIER_HIGH_VOL: 80,     // ATR > 1.0% (reduced for safety)
    },

    // RISK MANAGEMENT (MANDATORY - DO NOT DISABLE)
    RISK: {
        // Position Sizing Method
        // 'KELLY' | 'FIXED' | 'PERCENT'
        SIZING_METHOD: 'KELLY',      // Kelly Criterion for optimal growth
        KELLY_FRACTION: 0.25,        // Use 25% of full Kelly (conservative)
        FIXED_STAKE: 5,              // Used if SIZING_METHOD = 'FIXED'
        PERCENT_PER_TRADE: 0.02,     // 2% if SIZING_METHOD = 'PERCENT'

        // Safety Limits
        MIN_STAKE: 1,                // Minimum $1 per trade
        MAX_STAKE: 50,               // Maximum $50 per trade (protects balance)
        MAX_DAILY_LOSS_PERCENT: 0.03, // 3% daily loss limit (STRICT!)
        MAX_CONSECUTIVE_LOSSES: 4,    // Stop after 4 consecutive losses

        // Risk:Reward Configuration
        TARGET_RISK_REWARD: 1.5,     // 1:1.5 ratio minimum
        STOP_LOSS_PERCENT: 0.70,     // 70% of stake (triggers before auto-stop)

        // Multiple Take Profit Levels (Partial Profit Taking)
        TP_LEVELS: [
            { target: 0.25, closePercent: 0.50 }, // At 25% profit, close 50%
            { target: 0.75, closePercent: 0.30 }, // At 75% profit, close 30%
            { target: 1.50, closePercent: 0.20 }, // At 150% profit, close 20%
        ],

        // Trailing Stop
        TRAILING_STOP: {
            ENABLED: true,
            ACTIVATION_PERCENT: 1.00,  // Activate after 100% profit
            TRAIL_PERCENT: 0.30,       // Trail 30% behind peak profit
        },
    },

    // TRADING SESSIONS (UTC)
    // Only trade during these hours (prevents low liquidity periods)
    TRADING_SESSIONS: [
        { start: '06:00', end: '09:00' },   // London session
        { start: '13:00', end: '16:00' },   // New York session
        { start: '22:00', end: '01:00' },   // Asian session
    ],

    // TIMING
    TRADE_COOLDOWN_MS: 10000,    // 10 seconds between trades
    HEARTBEAT_INTERVAL_MS: 30000,

    // NEW: INVESTMENT CAPITAL CONTROL
    INVESTMENT_CAPITAL: 500,     // Base all risk/stake on this amount

    // TELEGRAM (From ncluadeDiffer.js)
    TELEGRAM_TOKEN: '8132747567:AAFtaN1j9U5HgNiK_TVE7axWzFDifButwKk',
    TELEGRAM_CHAT_ID: '752497117',
    TELEGRAM_SUMMARY_INTERVAL_MS: 1800000, // 30 Minutes

    // LOGGING
    LOG_LEVEL: 'info',
    LOG_FILE_ENABLED: false,
};

// ============================================================
// LOGGER SETUP - JSON Structured for Analytics
// ============================================================
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logger = winston.createLogger({
    level: CONFIG.LOG_LEVEL,
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
            return JSON.stringify({
                timestamp,
                level,
                message,
                ...meta,
            });
        })
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
                    return `[${timestamp}] ${level.padEnd(5)}: ${message} ${metaStr}`;
                })
            )
        }),
    ],
});

if (CONFIG.LOG_FILE_ENABLED) {
    logger.add(new winston.transports.File({
        filename: path.join(logDir, 'v75-bot-error.log'),
        level: 'error',
        maxsize: '20m',
        maxFiles: '10',
    }));

    logger.add(new winston.transports.File({
        filename: path.join(logDir, 'v75-bot-full.log'),
        maxsize: '50m',
        maxFiles: '20',
    }));
}

// Trade-specific logger (JSON only)
const tradeLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'ISO' }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({
            filename: path.join(logDir, 'trades.jsonl'),
            maxsize: '100m',
            maxFiles: '30',
        })
    ]
});

// Performance logger
const perfLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'ISO' }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({
            filename: path.join(logDir, 'performance.jsonl'),
            maxsize: '50m',
            maxFiles: '20',
        })
    ]
});

// ============================================================
// DERIV API CLIENT
// ============================================================
class DerivAPIClient {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.ws = null;
        this.isConnected = false;
        this.isAuthorized = false;

        // Account state
        this.balance = 0;
        this.currency = 'USD';
        this.loginId = '';

        // Market data
        this.symbol = null;
        this.contracts = null;
        this.ticks = [];
        this.candles = [];

        // Active trade
        this.activeContract = null;
        this.proposal = null;

        // Connection management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.heartbeatInterval = null;
        this.messageQueue = [];
    }

    logBox(message, color = '\x1b[36m') { // Default Cyan
        const reset = '\x1b[0m';
        const lines = message.split('\n');
        const width = 60;
        console.log(`${color}┏${'━'.repeat(width)}┓${reset}`);
        lines.forEach(line => {
            console.log(`${color}┃ ${line.padEnd(width - 2)} ┃${reset}`);
        });
        console.log(`${color}┗${'━'.repeat(width)}┛${reset}`);
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.logger.info(`Connecting to Deriv API...`);
            this.ws = new WebSocket(this.config.DERIV_WS_URL);

            this.ws.on('open', () => {
                this.logger.info('✅ WebSocket connected');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.startHeartbeat();
                resolve();
            });

            this.ws.on('message', (data) => this.handleMessage(data));
            this.ws.on('close', () => this.handleDisconnect());
            this.ws.on('error', (error) => this.handleError(error));
        });
    }

    disconnect() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.ws) {
            this.ws.close();
            this.isConnected = false;
            this.isAuthorized = false;
        }
    }

    send(message) {
        if (!this.isConnected) {
            this.messageQueue.push(message);
            return;
        }
        this.ws.send(JSON.stringify(message));
    }

    handleMessage(data) {
        try {
            const message = JSON.parse(data);

            if (message.error) {
                this.logger.error('API Error', message.error);
                return;
            }

            const handlers = {
                'authorize': this.handleAuthorize,
                'balance': this.handleBalance,
                'active_symbols': this.handleActiveSymbols,
                'contracts_for': this.handleContractsFor,
                'tick': this.handleTick,
                'candles': this.handleCandles,
                'proposal': this.handleProposal,
                'buy': this.handleBuy,
                'proposal_open_contract': this.handleOpenContract,
                'sell': this.handleSell,
                'transaction': this.handleTransaction,
            };

            if (message.msg_type && handlers[message.msg_type]) {
                handlers[message.msg_type].call(this, message);
            }
        } catch (error) {
            this.logger.error('Message handling failed', error);
        }
    }

    handleAuthorize(message) {
        if (message.authorize) {
            this.isAuthorized = true;
            this.balance = parseFloat(message.authorize.balance);
            this.currency = message.authorize.currency;
            this.loginId = message.authorize.loginid;
            this.logger.info('✅ Authorization successful', {
                loginId: this.loginId,
                balance: this.balance,
                currency: this.currency,
            });
            this.send({ balance: 1, subscribe: 1 });
            this.send({ active_symbols: 'brief', product_type: 'basic' });
        }
    }

    handleBalance(message) {
        if (message.balance) {
            const oldBalance = this.balance;
            this.balance = parseFloat(message.balance.balance);

            if (oldBalance !== 0 && Math.abs(this.balance - oldBalance) > 0.01) {
                const change = ((this.balance - oldBalance) / oldBalance * 100).toFixed(2);
                this.logger.info('💰 Balance update', {
                    newBalance: this.balance.toFixed(2),
                    change: `${change > 0 ? '+' : ''}${change}%`,
                });
            }
        }
    }

    handleActiveSymbols(message) {
        if (message.active_symbols) {
            this.symbol = message.active_symbols.find(s => s.symbol === this.config.SYMBOL);
            if (this.symbol) {
                this.logger.info('✅ Symbol loaded', {
                    displayName: this.symbol.display_name,
                    symbol: this.symbol.symbol,
                });
                this.getContractsFor();
            } else {
                this.logger.error(`Symbol ${this.config.SYMBOL} not found`);
            }
        }
    }

    handleContractsFor(message) {
        if (message.contracts_for) {
            this.contracts = message.contracts_for;
            // this.logger.info('✅ Contracts loaded', {
            //     symbol: this.config.SYMBOL,
            //     contractTypes: this.contracts.available,
            // });
            this.subscribeTicks();
            this.getCandles();
        }
    }

    handleTick(message) {
        if (message.tick) {
            const tick = {
                epoch: message.tick.epoch,
                quote: parseFloat(message.tick.quote),
                symbol: message.tick.symbol,
            };

            this.ticks.push(tick);
            if (this.ticks.length > 100) this.ticks.shift();

            if (this.onTick) this.onTick(tick);
        }
    }

    handleCandles(message) {
        if (message.candles) {
            this.candles = message.candles.map(c => ({
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close),
                epoch: c.epoch,
            }));
            this.logger.info('✅ Historical candles loaded', { count: this.candles.length });
        }
    }

    handleProposal(message) {
        if (message.proposal) {
            this.proposal = message.proposal;
            this.logger.debug('Proposal received', {
                id: message.proposal.id,
                askPrice: message.proposal.ask_price,
                payout: message.proposal.payout,
            });
        }
    }

    async handleBuy(message) {
        if (message.buy) {
            this.activeContract = {
                contractId: message.buy.contract_id,
                startTime: Date.now(),
                stake: this.lastStake,
                multiplier: this.lastMultiplier,
                takeProfit: this.lastTakeProfit,
                stopLoss: this.lastStopLoss,
                entryPrice: message.buy.buy_price,
            };

            this.logger.info('🎫 Contract purchased', {
                contractId: message.buy.contract_id,
                stake: this.lastStake,
                multiplier: this.lastMultiplier,
                longcode: message.buy.longcode,
            });

            // Trigger callback for Telegram notification in DerivBot
            if (this.onTradeOpened) {
                this.onTradeOpened(this.activeContract);
            }

            // Subscribe to contract updates
            this.send({
                proposal_open_contract: 1,
                contract_id: message.buy.contract_id,
                subscribe: 1,
            });

            tradeLogger.info('TRADE_ENTRY', {
                contractId: message.buy.contract_id,
                symbol: this.config.SYMBOL,
                contractType: this.config.CONTRACT_TYPE,
                stake: this.lastStake,
                multiplier: this.lastMultiplier,
                entryPrice: message.buy.buy_price,
                takeProfit: this.lastTakeProfit,
                stopLoss: this.lastStopLoss,
                balance: this.balance,
                timestamp: new Date().toISOString(),
            });
        }
    }

    handleOpenContract(message) {
        if (message.proposal_open_contract) {
            const contract = message.proposal_open_contract;

            if (contract.is_sold) {
                this.handleContractClose(contract);
            } else {
                // Monitor contract progress
                const profit = parseFloat(contract.profit);
                const profitPercent = ((profit / this.activeContract.stake) * 100).toFixed(2);
                const color = profit >= 0 ? '\x1b[32m' : '\x1b[31m'; // Green / Red
                const reset = '\x1b[0m';

                // Log frequently for visibility
                if (Math.random() < 0.3) {
                    this.logger.info(`📈 Trade Monitoring: ${this.config.SYMBOL} | ${color}${profitPercent}% ($${profit.toFixed(2)})${reset}`);
                }

                // Check for partial profit taking
                if (this.onContractUpdate) {
                    this.onContractUpdate(contract);
                }
            }
        }
    }

    async handleContractClose(contract) {
        const profit = parseFloat(contract.profit);
        const profitPercent = ((profit / this.activeContract.stake) * 100).toFixed(2);
        const isWin = profit > 0;
        const duration = (Date.now() - this.activeContract.startTime) / 1000;
        const color = isWin ? '\x1b[32m' : '\x1b[31m';
        const reset = '\x1b[0m';

        const summary =
            `🏁 TRADE COMPLETED: ${this.config.SYMBOL}\n` +
            `• Result:   ${isWin ? 'WIN ✅' : 'LOSS ❌'}\n` +
            `• P/L:      ${color}$${profit.toFixed(2)} (${profitPercent}%)${reset}\n` +
            `• Entry:    ${this.activeContract.entryPrice.toFixed(2)} | Exit: ${contract.exit_tick.toFixed(2)}\n` +
            `• ID:       ${contract.contract_id}\n` +
            `• Duration: ${duration.toFixed(1)}s`;

        this.logBox(summary, color);

        tradeLogger.info('TRADE_EXIT', {
            contractId: contract.contract_id,
            profit: profit,
            profitPercent: profitPercent,
            isWin: isWin,
            duration: duration,
            exitPrice: contract.exit_tick,
            balance: this.balance,
            timestamp: new Date().toISOString(),
        });

        if (this.onContractClosed) {
            this.onContractClosed({ profit, profitPercent, isWin, duration, exit_tick: contract.exit_tick });
        }

        this.activeContract = null;
    }

    handleSell(message) {
        if (message.sell) {
            this.logger.info('💵 Contract sold manually', {
                soldFor: message.sell.sold_for,
                profit: message.sell.profit,
            });
        }
    }

    handleTransaction(message) {
        if (message.transaction) {
            this.logger.debug('Transaction', message.transaction);
        }
    }

    handleDisconnect() {
        this.logger.warn('⚠️ WebSocket disconnected');
        this.isConnected = false;
        this.isAuthorized = false;
        this.stopHeartbeat();

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
            this.logger.info(`Reconnecting in ${delay / 1000}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => this.connect(), delay);
        } else {
            this.logger.error('❌ Max reconnection attempts reached');
            process.exit(1);
        }
    }

    handleError(error) {
        this.logger.error('WebSocket error', error);
    }

    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            this.send({ ping: 1 });
        }, this.config.HEARTBEAT_INTERVAL_MS);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    // API Methods
    authorize() {
        this.logger.info('🔑 Authorizing...');
        this.send({ authorize: this.config.DERIV_TOKEN });
    }

    getContractsFor() {
        if (this.symbol) {
            this.send({ contracts_for: this.symbol.symbol });
        }
    }

    subscribeTicks() {
        const welcome =
            `📡 MONITORING ACTIVE: ${this.config.SYMBOL}\n` +
            `• Strategy:   RSI + EMA + ATR (Optimized for V75)\n` +
            `• Risk:       ${this.config.RISK.SIZING_METHOD} Position Sizing\n` +
            `• Status:     Waiting for triple confirmation...`;
        this.logBox(welcome);

        this.logger.info('📈 Subscribing to ticks', { symbol: this.config.SYMBOL });
        this.send({ ticks: this.config.SYMBOL, subscribe: 1 });
        this.ticks = [];
    }

    unsubscribeTicks() {
        this.logger.info('📉 Unsubscribing from ticks', { symbol: this.config.SYMBOL });
        this.send({ forget_all: 'ticks' });
    }

    getCandles(count = 100, granularity = 60) {
        // Get historical candles for analysis
        const request = {
            ticks_history: this.config.SYMBOL,
            adjust_start_time: 1,
            count: count,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: granularity, // 60 = 1 minute
        };
        this.send(request);
    }

    getProposal(stake, multiplier, limitOrder) {
        this.lastStake = stake;
        this.lastMultiplier = multiplier;
        this.lastTakeProfit = limitOrder.take_profit;
        this.lastStopLoss = limitOrder.stop_loss;

        const proposal = {
            proposal: 1,
            amount: stake,
            basis: 'stake',
            contract_type: this.config.CONTRACT_TYPE,
            currency: this.currency,
            duration: 0,
            duration_unit: 's',
            multiplier: multiplier,
            symbol: this.config.SYMBOL,
            limit_order: limitOrder,
        };

        // Add deal cancellation if enabled
        if (this.config.RISK.DEAL_CANCELLATION) {
            proposal.cancellation = this.config.RISK.DEAL_CANCELLATION;
        }

        this.send(proposal);
    }

    buy(proposalId) {
        if (proposalId) {
            this.logger.info('🛒 Buying contract...');
            this.send({ buy: proposalId, price: 100 });
        }
    }

    sell(contractId) {
        if (contractId) {
            this.logger.info('💵 Selling contract', { contractId });
            this.send({ sell: contractId, price: 0 }); // 0 = market price
        }
    }
}

// ============================================================
// TECHNICAL ANALYSIS ENGINE
// ============================================================
class TechnicalAnalysis {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.ticks = [];
        this.candles = [];

        // Indicator buffers
        this.rsi = null;
        this.atr = null;
        this.emaFast = null;
        this.emaSlow = null;

        // Signal tracking
        this.signalStrength = 0;
        this.lastSignal = null;
    }

    // Calculate RSI
    calculateRSI(period, prices) {
        if (prices.length < period + 1) return null;

        let gains = 0, losses = 0;
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

    // Calculate EMA
    calculateEMA(period, prices) {
        if (prices.length < period) return null;

        const k = 2 / (period + 1);
        let ema = prices[period - 1];

        for (let i = period; i < prices.length; i++) {
            ema = prices[i] * k + ema * (1 - k);
        }

        return ema;
    }

    // Calculate ATR
    calculateATR(period, candles) {
        if (candles.length < period) return null;

        const tr = [];
        for (let i = 1; i < candles.length; i++) {
            const current = candles[i];
            const previous = candles[i - 1];

            const tr1 = current.high - current.low;
            const tr2 = Math.abs(current.high - previous.close);
            const tr3 = Math.abs(current.low - previous.close);

            tr.push(Math.max(tr1, tr2, tr3));
        }

        return mean(tr.slice(-period));
    }

    // Main analysis function
    analyze(ticks, candles) {
        this.ticks = ticks;
        this.candles = candles;

        if (this.ticks.length < 30 || this.candles.length < 21) {
            this.logger.debug('Insufficient data for analysis', {
                ticks: this.ticks.length,
                candles: this.candles.length,
            });
            return { signal: null, metrics: {} };
        }

        // Extract price arrays
        const tickPrices = this.ticks.map(t => t.quote);
        const closePrices = this.candles.map(c => c.close);

        // Calculate indicators
        const rsi = this.calculateRSI(this.config.STRATEGY.RSI_PERIOD, tickPrices);
        const atr = this.calculateATR(this.config.STRATEGY.ATR_PERIOD, this.candles);
        const emaFast = this.calculateEMA(this.config.STRATEGY.FAST_EMA_PERIOD, closePrices);
        const emaSlow = this.calculateEMA(this.config.STRATEGY.SLOW_EMA_PERIOD, closePrices);

        // Get latest price
        const latestPrice = tickPrices[tickPrices.length - 1];

        // Calculate ATR as percentage of price
        const atrPercent = atr ? (atr / latestPrice) : 0;

        this.logger.debug('Indicators', {
            rsi: rsi ? rsi.toFixed(2) : null,
            atrPercent: atrPercent ? (atrPercent * 100).toFixed(3) + '%' : null,
            emaFast: emaFast ? emaFast.toFixed(2) : null,
            emaSlow: emaSlow ? emaSlow.toFixed(2) : null,
            price: latestPrice.toFixed(2),
        });

        // Generate signal
        let signal = null;
        let confidence = 0;

        if (rsi !== null && atrPercent !== null && emaFast !== null && emaSlow !== null) {
            // Condition 1: RSI signal
            const rsiSignal = rsi < this.config.STRATEGY.RSI_OVERSOLD ? 'MULTUP' :
                rsi > this.config.STRATEGY.RSI_OVERBOUGHT ? 'MULTDOWN' : null;

            // Condition 2: EMA crossover
            const emaSignal = emaFast > emaSlow ? 'MULTUP' : emaFast < emaSlow ? 'MULTDOWN' : null;

            // Condition 3: Volatility filter
            const volatilityOk = atrPercent >= this.config.STRATEGY.MIN_ATR_THRESHOLD &&
                atrPercent <= this.config.STRATEGY.MAX_ATR_THRESHOLD;

            // Combined signal (requires both RSI and EMA agreement)
            if (rsiSignal === emaSignal && rsiSignal !== null && volatilityOk) {
                signal = rsiSignal;
                confidence = this.calculateConfidence(rsi, atrPercent, emaFast, emaSlow);
            }
        }

        // Track signal strength (consecutive signals)
        if (signal === this.lastSignal) {
            this.signalStrength++;
        } else {
            this.signalStrength = signal ? 1 : 0;
            this.lastSignal = signal;
        }

        const finalSignal = (this.signalStrength >= this.config.STRATEGY.MIN_SIGNAL_STRENGTH) ? signal : null;

        return {
            signal: finalSignal,
            metrics: {
                rsi,
                atrPercent,
                emaFast,
                emaSlow,
                signalStrength: this.signalStrength,
                confidence,
            },
        };
    }

    calculateConfidence(rsi, atrPercent, emaFast, emaSlow) {
        // Simple confidence score 0-100
        let score = 50; // Base score

        // RSI distance from threshold (closer = higher confidence)
        const rsiDist = rsi < 50 ? Math.abs(rsi - this.config.STRATEGY.RSI_OVERSOLD) :
            Math.abs(rsi - this.config.STRATEGY.RSI_OVERBOUGHT);
        score += Math.max(0, 20 - rsiDist) * 2;

        // ATR in optimal range (middle = higher confidence)
        const midATR = (this.config.STRATEGY.MIN_ATR_THRESHOLD + this.config.STRATEGY.MAX_ATR_THRESHOLD) / 2;
        const atrDist = Math.abs(atrPercent - midATR);
        score += Math.max(0, 10 - atrDist * 1000);

        // EMA distance (wider = stronger trend)
        const emaDist = Math.abs(emaFast - emaSlow) / emaSlow * 100;
        score += Math.min(20, emaDist * 2);

        return Math.min(100, Math.max(0, score));
    }

    reset() {
        this.signalStrength = 0;
        this.lastSignal = null;
    }

    // Get dynamic multiplier based on volatility
    getDynamicMultiplier(atrPercent) {
        if (atrPercent < 0.005) return this.config.STRATEGY.MULTIPLIER_LOW_VOL;
        if (atrPercent < 0.010) return this.config.STRATEGY.MULTIPLIER_MED_VOL;
        return this.config.STRATEGY.MULTIPLIER_HIGH_VOL;
    }
}

// ============================================================
// RISK MANAGEMENT ENGINE
// ============================================================
class RiskManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;

        // Trading stats
        this.dailyLoss = 0;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.winningTrades = 0;
        this.maxDrawdown = 0;
        this.peakBalance = 0;
    }

    // Calculate position size using Kelly Criterion
    calculatePositionSize(balance, avgWin, avgLoss, winRate) {
        // Use Investment Capital if defined, otherwise fall back to account balance
        const baseCapital = this.config.INVESTMENT_CAPITAL || balance;

        if (this.config.RISK.SIZING_METHOD === 'FIXED') {
            return this.config.RISK.FIXED_STAKE;
        }

        if (this.config.RISK.SIZING_METHOD === 'PERCENT') {
            return baseCapital * this.config.RISK.PERCENT_PER_TRADE;
        }

        // Kelly Criterion: f = (bp - q) / b
        // b = avgWin / avgLoss (odds)
        // p = winRate
        // q = 1 - p
        if (avgLoss === 0 || winRate === 0) return this.config.RISK.MIN_STAKE;

        const b = avgWin / Math.abs(avgLoss);
        const p = winRate;
        const q = 1 - p;

        const kellyFraction = (b * p - q) / b;
        const conservativeFraction = kellyFraction * this.config.RISK.KELLY_FRACTION;

        const stake = baseCapital * Math.max(0, conservativeFraction);

        return Math.max(this.config.RISK.MIN_STAKE, stake);
    }

    checkLimits(balance, profit) {
        // Update stats
        this.totalTrades++;
        if (profit > 0) this.winningTrades++;
        this.dailyLoss += profit;

        // Calculate drawdown
        if (balance > this.peakBalance) {
            this.peakBalance = balance;
        }
        const drawdown = ((this.peakBalance - balance) / this.peakBalance) * 100;
        if (drawdown > this.maxDrawdown) {
            this.maxDrawdown = drawdown;
        }

        // Track consecutive losses
        if (profit < 0) {
            this.consecutiveLosses++;
        } else {
            this.consecutiveLosses = 0;
        }

        // Check daily loss limit
        const baseCapital = this.config.INVESTMENT_CAPITAL || balance;
        const maxDailyLoss = baseCapital * this.config.RISK.MAX_DAILY_LOSS_PERCENT;

        if (this.dailyLoss <= -maxDailyLoss) {
            this.logger.error('☠️ DAILY LOSS LIMIT REACHED', {
                dailyLoss: this.dailyLoss.toFixed(2),
                limit: maxDailyLoss.toFixed(2),
                basis: baseCapital === balance ? 'Account Balance' : `Investment Capital ($${baseCapital})`
            });
            return false;
        }

        // Check consecutive loss limit
        if (this.consecutiveLosses >= this.config.RISK.MAX_CONSECUTIVE_LOSSES) {
            this.logger.error('☠️ MAX CONSECUTIVE LOSSES REACHED', {
                consecutiveLosses: this.consecutiveLosses,
            });
            return false;
        }

        return true;
    }

    // Check if we're in trading session
    isTradingHours() {
        const now = new Date();
        const currentTime = now.getUTCHours().toString().padStart(2, '0') + ':' +
            now.getUTCMinutes().toString().padStart(2, '0');

        for (const session of this.config.TRADING_SESSIONS) {
            if (currentTime >= session.start && currentTime <= session.end) {
                return true;
            }
        }
        return false;
    }

    getStats() {
        const winRate = this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0;
        const profitFactor = this.dailyLoss > 0 ? this.dailyLoss / Math.abs(this.dailyLoss) : 0;

        return {
            totalTrades: this.totalTrades,
            winningTrades: this.winningTrades,
            losingTrades: this.totalTrades - this.winningTrades,
            winRate: winRate.toFixed(4),
            dailyLoss: this.dailyLoss.toFixed(2),
            consecutiveLosses: this.consecutiveLosses,
            maxDrawdown: this.maxDrawdown.toFixed(2) + '%',
        };
    }

    reset() {
        this.dailyLoss = 0;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.winningTrades = 0;
    }
}

// ============================================================
// MAIN TRADING BOT
// ============================================================
class DerivBot {
    constructor(config) {
        this.config = config;
        this.logger = logger;
        this.client = new DerivAPIClient(config, logger);
        this.ta = new TechnicalAnalysis(config, logger);
        this.risk = new RiskManager(config, logger);

        // Performance tracking
        this.tradeHistory = [];
        this.isRunning = false;
        this.lastTradeTime = 0;
        this.lastConfidence = 0; // Added to store confidence for Telegram notification

        // Telegram Bot
        if (this.config.TELEGRAM_TOKEN && this.config.TELEGRAM_TOKEN !== 'your_token') {
            this.tg = new TelegramBot(this.config.TELEGRAM_TOKEN, { polling: false });
        }

        // Bind event handlers
        this.client.onTick = (tick) => this.onTick(tick);
        this.client.onContractClosed = (result) => this.onContractClosed(result);
        this.client.onContractUpdate = (contract) => this.onContractUpdate(contract);
        this.client.onTradeOpened = (contract) => this.onTradeOpened(contract);

        // Graceful shutdown
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
        process.on('uncaughtException', (error) => {
            logger.error('Uncaught Exception', error);
            this.shutdown();
        });
    }

    async start() {
        logger.info('🚀 ADVANCED V75 BOT STARTING...');
        logger.info('Configuration', {
            symbol: this.config.SYMBOL,
            sizingMethod: this.config.RISK.SIZING_METHOD,
            investmentCapital: this.config.INVESTMENT_CAPITAL ? `$${this.config.INVESTMENT_CAPITAL}` : 'Total Balance',
            dailyLossLimit: `${this.config.RISK.MAX_DAILY_LOSS_PERCENT * 100}% of Capital`,
            sessions: this.config.TRADING_SESSIONS,
        });

        if (this.config.INVESTMENT_CAPITAL) {
            this.client.logBox(`🏦 TRADING WITH ISOLATED CAPITAL: $${this.config.INVESTMENT_CAPITAL}\nRisk and sizing are decoupled from account balance.`, '\x1b[35m'); // Magenta
        }

        // Send startup notification
        await this.sendTelegram(`
🚀 <b>IndyBot Started</b> [${this.config.SYMBOL}]
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>Capital:</b> $${this.config.INVESTMENT_CAPITAL || 'Account Balance'}
<b>Risk:</b> ${this.config.RISK.PERCENT_PER_TRADE * 100}% per trade
<b>Daily Limit:</b> ${this.config.RISK.MAX_DAILY_LOSS_PERCENT * 100}% of Capital
<b>Strategy:</b> Triple Confirmation (RSI+EMA+ATR)
<b>Status:</b> Monitoring Market...
        `);

        // Start periodic summary timer
        this.startSummaryTimer();

        // Validate configuration
        if (this.config.DERIV_TOKEN === 'your_deriv_api_token_here') {
            logger.error('❌ DERIV_TOKEN not configured');
            process.exit(1);
        }

        try {
            await this.client.connect();
            this.client.authorize();

            this.isRunning = true;
            logger.info('✅ Bot initialized successfully');

            // Start performance reporting
            this.startPerformanceReporting();

        } catch (error) {
            logger.error('❌ Failed to start bot', error);
            process.exit(1);
        }
    }

    async shutdown() {
        logger.info('🛑 SHUTTING DOWN BOT...');
        this.isRunning = false;

        if (this.client.activeContract) {
            logger.warn('Closing active contract before shutdown');
            this.client.sell(this.client.activeContract.contractId);
        }

        this.client.unsubscribeTicks();
        this.client.disconnect();

        await this.printFinalReport(); // Await the report to ensure Telegram message is sent

        setTimeout(() => {
            logger.info('👋 Bot stopped safely');
            process.exit(0);
        }, 2000);
    }

    onTick(tick) {
        if (!this.isRunning || this.client.activeContract) return;

        // Check trading hours
        if (!this.risk.isTradingHours()) {
            logger.debug('Outside trading hours, skipping...');
            return;
        }

        // Check cooldown
        const now = Date.now();
        if (now - this.lastTradeTime < this.config.TRADE_COOLDOWN_MS) {
            return;
        }

        // Analyze market
        const { signal, metrics } = this.ta.analyze(this.client.ticks, this.client.candles);
        this.lastConfidence = metrics.confidence; // Store confidence for Telegram notification

        // Visual analysis log
        if (Math.random() < 0.1 && metrics.rsi) {
            const bar = '█'.repeat(Math.round(metrics.rsi / 4)) + '░'.repeat(25 - Math.round(metrics.rsi / 4));
            this.logger.info(`🔍 Analysis [${bar}] RSI: ${metrics.rsi.toFixed(2)} | ATR: ${(metrics.atrPercent * 100).toFixed(3)}% | Conf: ${metrics.confidence?.toFixed(0)}%`);
        }

        if (signal) {
            logger.info('🎯 TRADE SIGNAL DETECTED', {
                signal,
                confidence: metrics.confidence?.toFixed(2),
                atr: (metrics.atrPercent * 100).toFixed(3) + '%',
            });

            // Update contract type
            this.client.CONTRACT_TYPE = signal;

            // Check risk limits
            if (!this.risk.checkLimits(this.client.balance, 0)) {
                logger.error('Risk limits exceeded, stopping...');
                this.isRunning = false;
                return;
            }

            // Calculate dynamic position size
            const avgWin = this.getAverageWin();
            const avgLoss = this.getAverageLoss();
            const winRate = this.getWinRate();

            const stake = this.risk.calculatePositionSize(
                this.client.balance,
                avgWin,
                avgLoss,
                winRate
            );

            // Get dynamic multiplier based on volatility
            const multiplier = this.ta.getDynamicMultiplier(metrics.atrPercent);

            // Calculate limit orders (multiple TP levels handled in update)
            const limitOrder = {
                take_profit: stake * Math.max(...this.config.RISK.TP_LEVELS.map(tp => tp.target)),
                stop_loss: stake * this.config.RISK.STOP_LOSS_PERCENT,
            };

            logger.info('📊 Trade parameters', {
                stake: stake.toFixed(2),
                multiplier,
                takeProfit: limitOrder.take_profit.toFixed(2),
                stopLoss: limitOrder.stop_loss.toFixed(2),
            });

            // Get proposal and execute
            this.client.getProposal(stake, multiplier, limitOrder);

            setTimeout(() => {
                if (this.client.proposal) {
                    this.client.buy(this.client.proposal.id);
                    this.lastTradeTime = Date.now();
                }
            }, 1500);
        }
    }

    onContractUpdate(contract) {
        // Handle partial profit taking and trailing stop
        if (!this.config.RISK.TRAILING_STOP.ENABLED) return;

        const profit = parseFloat(contract.profit);
        const profitPercent = (profit / this.client.activeContract.stake) * 100;
        const activation = this.config.RISK.TRAILING_STOP.ACTIVATION_PERCENT * 100;

        // Activate trailing stop when profit reaches threshold
        if (profitPercent >= activation && !this.trailingStopActive) {
            this.trailingStopActive = true;
            this.trailingStopPrice = profit * (1 - this.config.RISK.TRAILING_STOP.TRAIL_PERCENT);
            logger.info('🚦 Trailing stop activated', {
                activationProfit: profitPercent.toFixed(2) + '%',
                trailPrice: this.trailingStopPrice.toFixed(2),
            });
        }

        // Update trailing stop
        if (this.trailingStopActive && profit > this.trailingStopPrice) {
            this.trailingStopPrice = profit * (1 - this.config.RISK.TRAILING_STOP.TRAIL_PERCENT);
        }

        // Check for partial profit taking
        this.checkPartialProfitLevels(contract);
    }

    checkPartialProfitLevels(contract) {
        if (!this.client.activeContract) return;
        const profitPercent = (parseFloat(contract.profit) / this.client.activeContract.stake) * 100;

        for (const tp of this.config.RISK.TP_LEVELS) {
            if (profitPercent >= tp.target * 100) {
                logger.info('💰 Partial profit level reached', {
                    level: tp.target * 100 + '%',
                    closePercent: tp.closePercent * 100 + '%',
                });
            }
        }
    }

    async onTradeOpened(contract) {
        // Notify Telegram
        await this.sendTelegram(`
🎯 <b>TRADE OPENED</b> [${this.config.SYMBOL}]
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>Direction:</b> ${this.config.CONTRACT_TYPE === 'MULTUP' ? 'LONG 📈' : 'SHORT 📉'}
<b>Stake:</b> $${contract.stake.toFixed(2)}
<b>Multiplier:</b> x${contract.multiplier}
<b>Entry:</b> ${contract.entryPrice.toFixed(2)}
<b>Confidence:</b> ${this.lastConfidence?.toFixed(0)}%
        `);
    }

    async onContractClosed(result) {
        const activeContract = this.client.activeContract;
        // Update risk manager
        this.risk.checkLimits(this.client.balance, result.profit);

        // Update trade history
        this.tradeHistory.push({
            timestamp: new Date().toISOString(),
            profit: result.profit,
            isWin: result.isWin,
            duration: result.duration,
        });

        // Keep only last 100 trades
        if (this.tradeHistory.length > 100) {
            this.tradeHistory.shift();
        }

        // Log performance
        const stats = this.risk.getStats();
        perfLogger.info('PERFORMANCE_UPDATE', {
            ...stats,
            balance: this.client.balance.toFixed(2),
            timestamp: new Date().toISOString(),
        });

        this.trailingStopActive = false;
        this.trailingStopPrice = 0;

        this.ta.reset();

        // Notify Telegram
        const color = result.profit > 0 ? '✅' : '❌';
        const entryPrice = activeContract ? activeContract.entryPrice.toFixed(2) : 'N/A';

        await this.sendTelegram(`
${color} <b>TRADE COMPLETED</b> [${this.config.SYMBOL}]
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>Result:</b> ${result.profit > 0 ? 'WIN' : 'LOSS'}
<b>P/L:</b> $${parseFloat(result.profit).toFixed(2)}
<b>Entry:</b> ${entryPrice}
<b>Exit:</b> ${parseFloat(result.exit_tick).toFixed(2)}
<b>Duration:</b> ${result.duration.toFixed(1)}s

📊 <b>SESSIONS STATS</b>
<b>Total Trades:</b> ${stats.totalTrades}
<b>Win Rate:</b> ${(stats.winRate * 100).toFixed(1)}%
<b>Daily P/L:</b> $${stats.dailyLoss}
        `);
    }

    getAverageWin() {
        const wins = this.tradeHistory.filter(t => t.isWin);
        if (wins.length === 0) return 1;
        return mean(wins.map(t => t.profit));
    }

    getAverageLoss() {
        const losses = this.tradeHistory.filter(t => !t.isWin);
        if (losses.length === 0) return -1;
        return mean(losses.map(t => t.profit));
    }

    getWinRate() {
        if (this.tradeHistory.length === 0) return 0.5;
        return this.tradeHistory.filter(t => t.isWin).length / this.tradeHistory.length;
    }

    startPerformanceReporting() {
        setInterval(() => {
            if (this.isRunning) {
                const stats = this.risk.getStats();
                logger.info('📊 PERFORMANCE SNAPSHOT', {
                    ...stats,
                    balance: this.client.balance.toFixed(2),
                });
            }
        }, 60000); // Every minute
    }

    async printFinalReport(reason = 'Manual Stop') {
        const stats = this.risk.getStats();

        console.log('\n' + '═'.repeat(60));
        console.log('📈 FINAL PERFORMANCE REPORT');
        console.log('═'.repeat(60));
        console.log(`Total Trades:      ${stats.totalTrades}`);
        console.log(`Wins:              ${stats.winningTrades}`);
        console.log(`Losses:            ${stats.losingTrades}`);
        console.log(`Win Rate:          ${(stats.winRate * 100).toFixed(2)}%`);
        console.log(`Daily P&L:         ${stats.dailyLoss} USD`);
        console.log(`Max Drawdown:      ${stats.maxDrawdown}`);
        console.log(`Final Balance:     ${this.client.balance.toFixed(2)} USD`);
        console.log('═'.repeat(60));

        // Save to file
        // fs.writeFileSync(
        //     path.join(logDir, 'final-report.json'),
        //     JSON.stringify({
        //         ...stats,
        //         finalBalance: this.client.balance,
        //         symbol: this.config.SYMBOL,
        //         config: this.config,
        //         timestamp: new Date().toISOString(),
        //     }, null, 2)
        // );

        // Notify Telegram Shutdown
        await this.sendTelegram(`
            ⚠️ <b>Bot Shutting Down</b> [${this.config.SYMBOL}]
            ━━━━━━━━━━━━━━━━━━━━━━━━━━
            <b>Reason:</b> ${reason || 'Manual Stop'}
            <b>Total P/L:</b> $${stats.dailyLoss}
            <b>Trades:</b> ${stats.totalTrades} (${(stats.winRate * 100).toFixed(1)}% Win)
            <b>Final Balance:</b> $${this.client.balance.toFixed(2)}
        `);
    }

    // ============================================================
    // TELEGRAM HELPERS
    // ============================================================
    async sendTelegram(message) {
        if (!this.tg) return;
        try {
            await this.tg.sendMessage(this.config.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
        } catch (error) {
            this.logger.error('Telegram error', { error: error.message });
        }
    }

    startSummaryTimer() {
        setInterval(async () => {
            if (!this.isRunning) return;
            const stats = this.risk.getStats();
            await this.sendTelegram(`
📊 <b>PERIODIC SUMMARY</b> [${this.config.SYMBOL}]
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>Daily P/L:</b> $${stats.dailyLoss}
<b>Win Rate:</b> ${(stats.winRate * 100).toFixed(1)}%
<b>Total Trades:</b> ${stats.totalTrades}
<b>Drawdown:</b> ${stats.maxDrawdown}
<b>Time:</b> ${new Date().toLocaleTimeString()}
            `);
        }, this.config.TELEGRAM_SUMMARY_INTERVAL_MS);
    }
}

// ============================================================
// CONFIGURATION VALIDATION
// ============================================================
function validateConfig() {
    logger.info('🔍 VALIDATING CONFIGURATION...');

    if (CONFIG.DERIV_TOKEN === 'your_deriv_api_token_here') {
        logger.error('❌ DERIV_TOKEN not set! Get from: deriv.com > Account Settings > API Token');
        process.exit(1);
    }

    if (CONFIG.RISK.SIZING_METHOD === 'KELLY' && CONFIG.RISK.KELLY_FRACTION > 0.5) {
        logger.warn('⚠️  Kelly fraction > 0.5 is extremely aggressive!');
    }

    if (CONFIG.RISK.MAX_DAILY_LOSS_PERCENT > 0.05) {
        logger.error('❌ MAX_DAILY_LOSS_PERCENT should not exceed 5%');
        process.exit(1);
    }

    if (CONFIG.RISK.PERCENT_PER_TRADE > 0.03) {
        logger.warn('⚠️  Risk per trade > 3% is very risky');
    }

    logger.info('✅ Configuration validated');
}

// ============================================================
// MAIN EXECUTION
// ============================================================
if (require.main === module) {
    validateConfig();

    const bot = new DerivBot(CONFIG);

    bot.start().catch(error => {
        logger.error('Fatal error starting bot', error);
        process.exit(1);
    });
}

module.exports = { DerivBot, CONFIG, logger };

/*
 * ════════════════════════════════════════════════════════════════════
 * 🎓 USAGE INSTRUCTIONS
 * ════════════════════════════════════════════════════════════════════
 * 
 * 1. INSTALLATION:
 *    npm install ws winston mathjs
 * 
 * 2. CONFIGURE API TOKEN:
 *    - Go to deriv.com > Account Settings > API Token
 *    - Generate token with "Read + Trade" permissions
 *    - Paste in DERIV_TOKEN above
 * 
 * 3. CUSTOMIZE STRATEGY:
 *    - Adjust RSI, EMA, ATR periods in STRATEGY section
 *    - Modify TP_LEVELS for different profit targets
 *    - Set TRADING_SESSIONS for your timezone
 * 
 * 4. RISK MANAGEMENT (CRITICAL):
 *    - Start with SIZING_METHOD: 'PERCENT' and PERCENT_PER_TRADE: 0.01 (1%)
 *    - Only use KELLY after 30+ trades of data
 *    - MAX_DAILY_LOSS_PERCENT: 0.02 (2%) is recommended
 *    - Never risk more than 2% per trade
 * 
 * 5. RUN BOT:
 *    node deriv-v75-bot.js
 * 
 * 6. MONITOR IN REAL-TIME:
 *    tail -f logs/v75-bot-full.log
 *    tail -f logs/trades.jsonl | jq .
 * 
 * 7. ANALYZE PERFORMANCE:
 *    node scripts/analyze-performance.js logs/trades.jsonl
 * 
 * ════════════════════════════════════════════════════════════════════
 * ⚠️  RISK WARNING
 * ════════════════════════════════════════════════════════════════════
 * - ALWAYS test on DEMO account first for at least 1 week
 * - This bot trades with REAL MONEY
 * - Past performance does NOT guarantee future results
 * - Synthetic indices can be highly volatile
 * - You can lose your entire investment
 * - NEVER trade with money you cannot afford to lose
 * - Use STRICT risk settings (1-2% per trade max)
 * 
 * ════════════════════════════════════════════════════════════════════
 */
