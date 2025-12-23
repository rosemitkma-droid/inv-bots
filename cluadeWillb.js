#!/usr/bin/env node
/**
 * Deriv Multiplier WPR Bot v1.1
 * Simple WPR Strategy on R_75 using Multiplier Contracts
 * 
 * MULTIPLIER ADVANTAGES:
 * - Can be closed anytime (no fixed expiry)
 * - Position flipping supported (close & reverse instantly)
 * - Profit/loss based on price movement × multiplier
 * - Stop Loss and Take Profit available
 * 
 * STRATEGY:
 * ---------
 * BUY (MULTUP):  WPR crosses above -20 (Prev WPR ≤ -20, Curr WPR > -20)
 * SELL (MULTDOWN): WPR crosses below -80 (Prev WPR ≥ -80, Curr WPR < -80)
 * 
 * POSITION RULES:
 * - Only 1 BUY position at a time
 * - Only 1 SELL position at a time
 * - Opposite signal triggers reversal (close current, open opposite)
 * 
 * TAKE PROFIT LOGIC:
 * - Initial TP: User-configured amount (e.g., $0.50)
 * - On reversal after loss: TP = Initial TP + Accumulated Losses
 * - When TP is hit: Covers all losses + original profit target
 * 
 * MARTINGALE:
 * - Configurable losses before multiplier kicks in
 * - 2x stake on each multiplier level
 * 
 * Dependencies: npm install ws
 * Usage: API_TOKEN=your_token node deriv-multiplier-wpr-bot.js
 */

const WebSocket = require('ws');

// ============================================
// LOGGER UTILITY
// ============================================

const LOGGER = {
    info: (msg) => console.log(`[INFO] ${new Date().toLocaleTimeString()} - ${msg}`),
    trade: (msg) => console.log(`\x1b[32m[TRADE] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`),
    signal: (msg) => console.log(`\x1b[36m[SIGNAL] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`),
    warn: (msg) => console.warn(`\x1b[33m[WARN] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`),
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${new Date().toLocaleTimeString()} - ${msg}\x1b[0m`); }
};

// ============================================
// TIMEFRAME CONFIGURATION
// ============================================

const TIMEFRAMES = {
    '1m': { granularity: 60, label: '1 Minute' },
    '2m': { granularity: 120, label: '2 Minutes' },
    '3m': { granularity: 180, label: '3 Minutes' },
    '5m': { granularity: 300, label: '5 Minutes' },
    '10m': { granularity: 600, label: '10 Minutes' },
    '15m': { granularity: 900, label: '15 Minutes' },
    '30m': { granularity: 1800, label: '30 Minutes' },
    '1h': { granularity: 3600, label: '1 Hour' },
    '4h': { granularity: 14400, label: '4 Hours' }
};

const SELECTED_TIMEFRAME = process.env.TIMEFRAME || '5m';
const TIMEFRAME_CONFIG = TIMEFRAMES[SELECTED_TIMEFRAME] || TIMEFRAMES['5m'];

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
    // API Settings
    API_TOKEN: process.env.API_TOKENs || 'DMylfkyce6VyZt7',
    APP_ID: process.env.APP_ID || '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Trading Asset
    SYMBOL: process.env.SYMBOL || 'R_75',
    SYMBOL_NAME: 'Volatility 75 Index',

    // Multiplier Settings
    // Valid multipliers for R_75: [50, 100, 200, 300, 500]
    MULTIPLIER: parseInt(process.env.MULT) || 200,
    MIN_STAKE: 1.00,
    MAX_STAKE: 3000,

    // Capital Settings
    INITIAL_CAPITAL: parseFloat(process.env.CAPITAL) || 500,
    INITIAL_STAKE: parseFloat(process.env.STAKE) || 1.00,

    // Take Profit Settings
    INITIAL_TAKE_PROFIT: parseFloat(process.env.TAKE_PROFIT) || 0.1,  // Base TP amount in USD
    USE_STOP_LOSS: process.env.USE_SL === 'false' || false,
    STOP_LOSS_AMOUNT: parseFloat(process.env.STOP_LOSS_AMT) || 0.50,   // SL amount in USD

    // Session Targets
    SESSION_PROFIT_TARGET: parseFloat(process.env.PROFIT_TARGET) || 50,
    SESSION_STOP_LOSS: parseFloat(process.env.SESSION_SL) || -100,

    // Martingale Settings
    STAKE_MULTIPLIER: parseFloat(process.env.STAKE_MULT) || 2.0,
    LOSSES_BEFORE_MULTIPLIER: parseInt(process.env.LOSSES_BEFORE) || 1,
    MAX_MULTIPLIER_LEVEL: parseInt(process.env.MAX_LEVEL) || 6,

    // Timeframe Settings
    TIMEFRAME: SELECTED_TIMEFRAME,
    GRANULARITY: TIMEFRAME_CONFIG.granularity,
    TIMEFRAME_LABEL: TIMEFRAME_CONFIG.label,

    // WPR Settings
    WPR_PERIOD: parseInt(process.env.WPR_PERIOD) || 80,
    WPR_BUY_LEVEL: -20,
    WPR_SELL_LEVEL: -80,

    // Performance
    MAX_CANDLES_STORED: 100,
    DASHBOARD_UPDATE_INTERVAL: 5000,

    // Debug
    DEBUG_MODE: process.env.DEBUG === 'true' || false
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

    // Price Data
    candles: [],
    currentPrice: 0,

    // WPR
    wpr: -50,
    prevWpr: -50,

    // Positions (only 1 per direction allowed)
    buyPosition: null,
    sellPosition: null,

    // Stake & Take Profit Management
    currentStake: CONFIG.INITIAL_STAKE,
    currentTakeProfit: CONFIG.INITIAL_TAKE_PROFIT,
    consecutiveLosses: 0,
    multiplierLevel: 0,
    accumulatedLoss: 0,  // Track total losses for TP adjustment

    // Session Stats
    session: {
        profit: 0,
        loss: 0,
        netPL: 0,
        tradesCount: 0,
        winsCount: 0,
        lossesCount: 0,
        startTime: Date.now()
    },

    // Request tracking
    pendingRequests: new Map(),
    requestId: 1,
    lastBarTime: 0
};

// ============================================
// TECHNICAL INDICATORS
// ============================================

class TechnicalIndicators {
    /**
     * Calculate Williams Percent Range (WPR)
     * WPR = (Highest High - Close) / (Highest High - Lowest Low) * -100
     * Range: -100 to 0
     * Overbought: > -20, Oversold: < -80
     */
    static calculateWPR(highs, lows, closes, period = 80) {
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
     * Detect WPR signal crossovers
     */
    static detectSignal(prevWpr, currWpr) {
        // BUY: WPR crosses above -20
        if (prevWpr <= CONFIG.WPR_BUY_LEVEL && currWpr > CONFIG.WPR_BUY_LEVEL) {
            return 'BUY';
        }

        // SELL: WPR crosses below -80
        if (prevWpr >= CONFIG.WPR_SELL_LEVEL && currWpr < CONFIG.WPR_SELL_LEVEL) {
            return 'SELL';
        }

        return null;
    }
}

// ============================================
// STAKE & TAKE PROFIT MANAGER
// ============================================

class StakeManager {
    /**
     * Reset stake and TP to initial values
     */
    static fullReset() {
        state.currentStake = CONFIG.INITIAL_STAKE;
        state.currentTakeProfit = CONFIG.INITIAL_TAKE_PROFIT;
        state.consecutiveLosses = 0;
        state.multiplierLevel = 0;
        state.accumulatedLoss = 0;

        LOGGER.info(`🔄 Full reset - Stake: $${state.currentStake.toFixed(2)}, TP: $${state.currentTakeProfit.toFixed(2)}`);
    }

    /**
     * Get current stake (validated)
     */
    static getCurrentStake() {
        let stake = state.currentStake;
        stake = Math.max(stake, CONFIG.MIN_STAKE);
        stake = Math.min(stake, CONFIG.MAX_STAKE);
        stake = Math.min(stake, state.capital * 0.10); // Max 10% of capital
        return stake;
    }

    /**
     * Get current take profit amount
     */
    static getCurrentTakeProfit() {
        return state.currentTakeProfit;
    }

    /**
     * Record a win - reset everything
     */
    static recordWin(profit) {
        state.session.winsCount++;
        state.session.profit += profit;
        state.session.netPL += profit;
        state.capital += profit;

        LOGGER.trade(`✅ WIN: +$${profit.toFixed(2)} | Capital: $${state.capital.toFixed(2)}`);

        // Check if we recovered all losses
        if (state.accumulatedLoss > 0) {
            if (profit >= state.accumulatedLoss) {
                LOGGER.trade(`🎉 FULL RECOVERY! Profit $${profit.toFixed(2)} >= Accumulated Loss $${state.accumulatedLoss.toFixed(2)}`);
            } else {
                LOGGER.trade(`📈 Partial recovery. Covered $${profit.toFixed(2)} of $${state.accumulatedLoss.toFixed(2)} loss`);
            }
        }

        // Always reset on win (TP was designed to cover losses + profit)
        this.fullReset();
    }

    /**
     * Record a loss - apply martingale and adjust TP
     */
    static recordLoss(loss) {
        const absLoss = Math.abs(loss);

        state.session.lossesCount++;
        state.session.loss += absLoss;
        state.session.netPL -= absLoss;
        state.capital -= absLoss;
        state.consecutiveLosses++;

        // Add to accumulated loss
        state.accumulatedLoss += absLoss;

        LOGGER.trade(`❌ LOSS: -$${absLoss.toFixed(2)} | Capital: $${state.capital.toFixed(2)} | Consecutive: ${state.consecutiveLosses}`);
        LOGGER.trade(`📊 Accumulated Loss: $${state.accumulatedLoss.toFixed(2)}`);

        // Check if we should apply stake multiplier
        if (state.consecutiveLosses >= CONFIG.LOSSES_BEFORE_MULTIPLIER) {
            if (state.multiplierLevel < CONFIG.MAX_MULTIPLIER_LEVEL) {
                state.currentStake *= CONFIG.STAKE_MULTIPLIER;
                state.multiplierLevel++;
                state.consecutiveLosses = 0;  // Reset consecutive counter

                LOGGER.warn(`📈 MARTINGALE Level ${state.multiplierLevel}: Stake now $${state.currentStake.toFixed(2)}`);
            } else {
                LOGGER.error(`🛑 MAX MARTINGALE LEVEL (${CONFIG.MAX_MULTIPLIER_LEVEL}) reached!`);
            }
        }

        // Update Take Profit to cover accumulated losses + initial TP
        state.currentTakeProfit = CONFIG.INITIAL_TAKE_PROFIT + state.accumulatedLoss;

        LOGGER.trade(`🎯 New TP: $${state.currentTakeProfit.toFixed(2)} (Initial $${CONFIG.INITIAL_TAKE_PROFIT.toFixed(2)} + Losses $${state.accumulatedLoss.toFixed(2)})`);
    }

    /**
     * Get stop loss amount (if enabled)
     */
    static getStopLoss() {
        if (!CONFIG.USE_STOP_LOSS) return null;
        return CONFIG.STOP_LOSS_AMOUNT;
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
            LOGGER.info('🔐 Authorized');
            LOGGER.info(`👤 Account: ${response.authorize.loginid}`);
            LOGGER.info(`💰 Balance: $${response.authorize.balance}`);
            state.isAuthorized = true;
            state.accountBalance = response.authorize.balance;

            bot.start();
        }

        // Tick data
        if (response.msg_type === 'tick') {
            state.currentPrice = response.tick.quote;
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

        // Pending requests
        if (response.req_id && state.pendingRequests.has(response.req_id)) {
            const { resolve } = state.pendingRequests.get(response.req_id);
            state.pendingRequests.delete(response.req_id);
            resolve(response);
        }
    }

    handleOHLC(ohlc) {
        if (ohlc.symbol !== CONFIG.SYMBOL) return;

        const candle = {
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close),
            epoch: ohlc.epoch
        };

        const isNewBar = state.candles.length === 0 ||
            state.candles[state.candles.length - 1].epoch !== candle.epoch;

        if (isNewBar) {
            state.candles.push(candle);
            state.lastBarTime = candle.epoch;

            // Trim candles
            if (state.candles.length > CONFIG.MAX_CANDLES_STORED) {
                state.candles = state.candles.slice(-CONFIG.MAX_CANDLES_STORED);
            }

            // Update indicators and check signals
            this.updateIndicators();
            this.checkSignals();
        } else {
            // Update current candle
            state.candles[state.candles.length - 1] = candle;
        }
    }

    handleCandlesHistory(response) {
        if (response.error) {
            LOGGER.error(`Candles error: ${response.error.message}`);
            return;
        }

        state.candles = response.candles.map(c => ({
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close),
            epoch: c.epoch
        }));

        LOGGER.info(`📊 Loaded ${state.candles.length} candles for ${CONFIG.SYMBOL}`);
        this.updateIndicators();
    }

    updateIndicators() {
        if (state.candles.length < CONFIG.WPR_PERIOD + 2) return;

        const closes = state.candles.map(c => c.close);
        const highs = state.candles.map(c => c.high);
        const lows = state.candles.map(c => c.low);

        // Store previous WPR
        state.prevWpr = state.wpr;

        // Calculate current WPR
        state.wpr = TechnicalIndicators.calculateWPR(highs, lows, closes, CONFIG.WPR_PERIOD);
    }

    checkSignals() {
        const signal = TechnicalIndicators.detectSignal(state.prevWpr, state.wpr);

        if (!signal) return;

        LOGGER.signal(`${CONFIG.SYMBOL} WPR ${signal} (WPR: ${state.wpr.toFixed(2)} from ${state.prevWpr.toFixed(2)})`);

        if (signal === 'BUY') {
            // If we have an active SELL, close it first (reversal)
            if (state.sellPosition && state.sellPosition.contractId) {
                LOGGER.trade(`🔄 REVERSAL: Closing SELL to open BUY`);
                bot.closePosition('SELL', 'BUY');
            } else if (!state.buyPosition) {
                // No active BUY, open new one
                bot.openPosition('BUY');
            } else {
                LOGGER.debug('Already have BUY position');
            }
        } else if (signal === 'SELL') {
            // If we have an active BUY, close it first (reversal)
            if (state.buyPosition && state.buyPosition.contractId) {
                LOGGER.trade(`🔄 REVERSAL: Closing BUY to open SELL`);
                bot.closePosition('BUY', 'SELL');
            } else if (!state.sellPosition) {
                // No active SELL, open new one
                bot.openPosition('SELL');
            } else {
                LOGGER.debug('Already have SELL position');
            }
        }
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);

            // Clean up pending position
            const direction = response.echo_req?.passthrough?.direction;
            if (direction === 'BUY') state.buyPosition = null;
            if (direction === 'SELL') state.sellPosition = null;
            return;
        }

        const contract = response.buy;
        const direction = response.passthrough?.direction ||
            (response.echo_req?.parameters?.contract_type === 'MULTUP' ? 'BUY' : 'SELL');

        LOGGER.trade(`✅ ${direction} opened: Contract ${contract.contract_id}, Price: $${contract.buy_price}`);

        const position = {
            contractId: contract.contract_id,
            direction: direction,
            stake: parseFloat(response.echo_req.price),
            takeProfit: StakeManager.getCurrentTakeProfit(),
            buyPrice: contract.buy_price,
            entryTime: Date.now(),
            currentProfit: 0,
            pendingReversal: null
        };

        if (direction === 'BUY') {
            state.buyPosition = position;
        } else if (direction === 'SELL') {
            state.sellPosition = position;
        }

        state.session.tradesCount++;

        // Subscribe to contract updates
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

        // Find which position this was
        let position = null;
        let direction = null;

        if (state.buyPosition?.contractId === sold.contract_id) {
            position = state.buyPosition;
            direction = 'BUY';
            state.buyPosition = null;
        } else if (state.sellPosition?.contractId === sold.contract_id) {
            position = state.sellPosition;
            direction = 'SELL';
            state.sellPosition = null;
        }

        if (position) {
            const profit = sold.sold_for - position.buyPrice;

            if (profit >= 0) {
                StakeManager.recordWin(profit);
            } else {
                StakeManager.recordLoss(profit);
            }

            // Check for pending reversal
            if (position.pendingReversal) {
                LOGGER.trade(`🔄 Executing reversal to ${position.pendingReversal}`);
                setTimeout(() => {
                    bot.openPosition(position.pendingReversal);
                }, 500);
            }
        }
    }

    handleContractUpdate(response) {
        if (response.error) return;

        const contract = response.proposal_open_contract;

        // Update position profit
        if (state.buyPosition?.contractId === contract.contract_id) {
            state.buyPosition.currentProfit = contract.profit;
        } else if (state.sellPosition?.contractId === contract.contract_id) {
            state.sellPosition.currentProfit = contract.profit;
        }

        // Check if contract closed (by SL/TP or manually)
        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
            const profit = contract.profit;
            LOGGER.trade(`📋 Contract ${contract.contract_id} settled: ${profit >= 0 ? 'WIN' : 'LOSS'} $${Math.abs(profit).toFixed(2)}`);

            // Handle result if not already handled by sell response
            if (state.buyPosition?.contractId === contract.contract_id) {
                const position = state.buyPosition;
                state.buyPosition = null;

                if (profit >= 0) {
                    StakeManager.recordWin(profit);
                } else {
                    StakeManager.recordLoss(profit);
                }

                if (position.pendingReversal) {
                    setTimeout(() => bot.openPosition(position.pendingReversal), 500);
                }
            } else if (state.sellPosition?.contractId === contract.contract_id) {
                const position = state.sellPosition;
                state.sellPosition = null;

                if (profit >= 0) {
                    StakeManager.recordWin(profit);
                } else {
                    StakeManager.recordLoss(profit);
                }

                if (position.pendingReversal) {
                    setTimeout(() => bot.openPosition(position.pendingReversal), 500);
                }
            }

            // Unsubscribe
            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }
        }
    }

    onError(error) {
        LOGGER.error(`WebSocket error: ${error.message}`);
    }

    onClose() {
        LOGGER.warn('🔌 Disconnected');
        state.isConnected = false;
        state.isAuthorized = false;

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            LOGGER.info(`🔄 Reconnecting in ${this.reconnectDelay / 1000}s...`);
            setTimeout(() => this.connect(), this.reconnectDelay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            process.exit(1);
        }
    }

    send(data) {
        if (!state.isConnected) {
            LOGGER.error('Not connected');
            return null;
        }

        data.req_id = state.requestId++;
        this.ws.send(JSON.stringify(data));
        return data.req_id;
    }
}

// ============================================
// MAIN BOT CLASS
// ============================================

class DerivMultiplierWPRBot {
    constructor() {
        this.connection = new ConnectionManager();
    }

    async start() {
        console.log('\n' + '═'.repeat(70));
        console.log('         DERIV MULTIPLIER WPR BOT v1.1');
        console.log('         Simple WPR Strategy on ' + CONFIG.SYMBOL);
        console.log('═'.repeat(70));
        console.log(`💰 Capital: $${state.capital}`);
        console.log(`📊 Asset: ${CONFIG.SYMBOL_NAME} (${CONFIG.SYMBOL})`);
        console.log(`⏱️  Timeframe: ${CONFIG.TIMEFRAME_LABEL}`);
        console.log(`📈 Multiplier: x${CONFIG.MULTIPLIER}`);
        console.log(`🎯 Initial TP: $${CONFIG.INITIAL_TAKE_PROFIT} | Session Target: $${CONFIG.SESSION_PROFIT_TARGET}`);
        console.log(`🛑 Session Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`);
        console.log(`💹 Stake Multiplier: ${CONFIG.STAKE_MULTIPLIER}x after ${CONFIG.LOSSES_BEFORE_MULTIPLIER} loss(es)`);
        console.log(`📏 WPR Period: ${CONFIG.WPR_PERIOD} | Buy: > ${CONFIG.WPR_BUY_LEVEL} | Sell: < ${CONFIG.WPR_SELL_LEVEL}`);
        console.log('═'.repeat(70) + '\n');

        // Subscribe to balance
        this.connection.send({ balance: 1, subscribe: 1 });

        // Get candle history
        this.connection.send({
            ticks_history: CONFIG.SYMBOL,
            adjust_start_time: 1,
            count: 100,
            end: 'latest',
            granularity: CONFIG.GRANULARITY,
            style: 'candles'
        });

        // Subscribe to OHLC
        this.connection.send({
            ticks_history: CONFIG.SYMBOL,
            adjust_start_time: 1,
            count: 1,
            end: 'latest',
            granularity: CONFIG.GRANULARITY,
            style: 'candles',
            subscribe: 1
        });

        // Subscribe to ticks
        this.connection.send({
            ticks: CONFIG.SYMBOL,
            subscribe: 1
        });

        LOGGER.info(`📡 Subscribed to ${CONFIG.SYMBOL_NAME}`);
        LOGGER.info('✅ Bot started!');
    }

    /**
     * Open a new position
     */
    openPosition(direction) {
        // Check session limits
        if (state.session.netPL >= CONFIG.SESSION_PROFIT_TARGET) {
            LOGGER.trade(`🎯 Session profit target reached! Net P/L: $${state.session.netPL.toFixed(2)}`);
            return;
        }
        if (state.session.netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.error(`🛑 Session stop loss reached! Net P/L: $${state.session.netPL.toFixed(2)}`);
            return;
        }

        // Check if position already exists
        if (direction === 'BUY' && state.buyPosition) {
            LOGGER.debug('Already have BUY position');
            return;
        }
        if (direction === 'SELL' && state.sellPosition) {
            LOGGER.debug('Already have SELL position');
            return;
        }

        const stake = StakeManager.getCurrentStake();
        const takeProfit = StakeManager.getCurrentTakeProfit();
        const stopLoss = StakeManager.getStopLoss();
        const contractType = direction === 'BUY' ? 'MULTUP' : 'MULTDOWN';

        LOGGER.trade(`🎯 Opening ${direction} on ${CONFIG.SYMBOL}`);
        LOGGER.trade(`   Contract: ${contractType}`);
        LOGGER.trade(`   Stake: $${stake.toFixed(2)} | Multiplier: x${CONFIG.MULTIPLIER}`);
        LOGGER.trade(`   Take Profit: $${takeProfit.toFixed(2)}`);
        if (stopLoss) LOGGER.trade(`   Stop Loss: $${stopLoss.toFixed(2)}`);
        LOGGER.trade(`   Martingale Level: ${state.multiplierLevel}`);
        if (state.accumulatedLoss > 0) {
            LOGGER.trade(`   Accumulated Loss: $${state.accumulatedLoss.toFixed(2)}`);
        }

        // Mark position as pending
        if (direction === 'BUY') {
            state.buyPosition = { pending: true };
        } else {
            state.sellPosition = { pending: true };
        }

        // Build trade request
        const tradeRequest = {
            buy: 1,
            subscribe: 1,
            price: stake,
            parameters: {
                contract_type: contractType,
                symbol: CONFIG.SYMBOL,
                currency: 'USD',
                amount: stake,
                multiplier: CONFIG.MULTIPLIER,
                basis: 'stake'
            },
            passthrough: {
                direction: direction
            }
        };

        // Add limit orders (TP and optionally SL)
        tradeRequest.parameters.limit_order = {
            take_profit: takeProfit
        };

        if (stopLoss) {
            tradeRequest.parameters.limit_order.stop_loss = stopLoss;
        }

        // Send trade request
        this.connection.send(tradeRequest);
    }

    /**
     * Close a position (with optional reversal)
     */
    closePosition(direction, reversalDirection = null) {
        let position = null;

        if (direction === 'BUY' && state.buyPosition) {
            position = state.buyPosition;
            if (reversalDirection) position.pendingReversal = reversalDirection;
        } else if (direction === 'SELL' && state.sellPosition) {
            position = state.sellPosition;
            if (reversalDirection) position.pendingReversal = reversalDirection;
        }

        if (!position || !position.contractId) {
            LOGGER.warn(`No active ${direction} position to close`);
            if (reversalDirection) {
                this.openPosition(reversalDirection);
            }
            return;
        }

        LOGGER.trade(`🔒 Closing ${direction} position (Contract: ${position.contractId})`);

        this.connection.send({
            sell: position.contractId,
            price: 0  // Market price
        });
    }

    /**
     * Close all positions
     */
    closeAllPositions() {
        if (state.buyPosition?.contractId) {
            this.closePosition('BUY');
        }
        if (state.sellPosition?.contractId) {
            this.closePosition('SELL');
        }
    }

    /**
     * Stop the bot
     */
    stop() {
        LOGGER.info('🛑 Stopping bot...');

        this.closeAllPositions();

        setTimeout(() => {
            if (this.connection.ws) {
                this.connection.ws.close();
            }
            LOGGER.info('👋 Bot stopped');
        }, 2000);
    }

    /**
     * Get bot status
     */
    getStatus() {
        const duration = Date.now() - state.session.startTime;
        const hours = Math.floor(duration / 3600000);
        const minutes = Math.floor((duration % 3600000) / 60000);

        return {
            symbol: CONFIG.SYMBOL,
            capital: state.capital,
            accountBalance: state.accountBalance,
            wpr: state.wpr,
            prevWpr: state.prevWpr,
            currentStake: state.currentStake,
            currentTakeProfit: state.currentTakeProfit,
            multiplierLevel: state.multiplierLevel,
            consecutiveLosses: state.consecutiveLosses,
            accumulatedLoss: state.accumulatedLoss,
            buyPosition: state.buyPosition ? {
                profit: state.buyPosition.currentProfit || 0,
                stake: state.buyPosition.stake || 0,
                takeProfit: state.buyPosition.takeProfit || 0
            } : null,
            sellPosition: state.sellPosition ? {
                profit: state.sellPosition.currentProfit || 0,
                stake: state.sellPosition.stake || 0,
                takeProfit: state.sellPosition.takeProfit || 0
            } : null,
            session: {
                duration: `${hours}h ${minutes}m`,
                trades: state.session.tradesCount,
                wins: state.session.winsCount,
                losses: state.session.lossesCount,
                netPL: state.session.netPL,
                winRate: state.session.tradesCount > 0
                    ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1) + '%'
                    : '0%'
            }
        };
    }
}

// ============================================
// DASHBOARD
// ============================================

class Dashboard {
    static display() {
        const status = bot.getStatus();
        const session = status.session;

        console.log('\n' + '╔' + '═'.repeat(70) + '╗');
        console.log('║' + `  DERIV MULTIPLIER WPR BOT v1.1 - ${CONFIG.SYMBOL} (x${CONFIG.MULTIPLIER})`.padEnd(70) + '║');
        console.log('╠' + '═'.repeat(70) + '╣');

        const netPLColor = session.netPL >= 0 ? '\x1b[32m' : '\x1b[31m';
        const resetColor = '\x1b[0m';

        console.log(`║ 💰 Capital: $${status.capital.toFixed(2).padEnd(12)} Account: $${status.accountBalance.toFixed(2).padEnd(14)} ║`);
        console.log(`║ 📊 WPR: ${status.wpr.toFixed(2).padEnd(8)} (prev: ${status.prevWpr.toFixed(2)})`.padEnd(71) + '║');
        console.log(`║ 💹 Net P/L: ${netPLColor}$${session.netPL.toFixed(2).padEnd(10)}${resetColor} W/L: ${session.wins}/${session.losses}`.padEnd(79) + '║');
        console.log(`║ 📈 Stake: $${status.currentStake.toFixed(2).padEnd(8)} Level: ${status.multiplierLevel}/${CONFIG.MAX_MULTIPLIER_LEVEL}`.padEnd(71) + '║');
        console.log(`║ 🎯 Take Profit: $${status.currentTakeProfit.toFixed(2).padEnd(8)} (Initial: $${CONFIG.INITIAL_TAKE_PROFIT.toFixed(2)})`.padEnd(71) + '║');
        console.log(`║ 📉 Acc. Loss: $${status.accumulatedLoss.toFixed(2).padEnd(8)} Consec: ${status.consecutiveLosses}/${CONFIG.LOSSES_BEFORE_MULTIPLIER}`.padEnd(71) + '║');

        console.log('╠' + '═'.repeat(70) + '╣');

        // Positions
        const buyStatus = status.buyPosition
            ? `\x1b[32mACTIVE\x1b[0m P/L: $${status.buyPosition.profit?.toFixed(2) || '0.00'} TP: $${status.buyPosition.takeProfit?.toFixed(2) || '0.00'}`
            : '\x1b[90mNone\x1b[0m';
        const sellStatus = status.sellPosition
            ? `\x1b[31mACTIVE\x1b[0m P/L: $${status.sellPosition.profit?.toFixed(2) || '0.00'} TP: $${status.sellPosition.takeProfit?.toFixed(2) || '0.00'}`
            : '\x1b[90mNone\x1b[0m';

        console.log(`║ 📗 BUY:  ${buyStatus}`.padEnd(79) + '║');
        console.log(`║ 📕 SELL: ${sellStatus}`.padEnd(79) + '║');

        console.log('╠' + '═'.repeat(70) + '╣');
        console.log(`║ ⏱️  Session: ${session.duration.padEnd(10)} Trades: ${session.trades.toString().padEnd(5)} WR: ${session.winRate.padEnd(8)}  ║`);
        console.log('╚' + '═'.repeat(70) + '╝');
        console.log(`⏰ ${new Date().toLocaleTimeString()} | TF: ${CONFIG.TIMEFRAME} | Mult: x${CONFIG.MULTIPLIER} | Ctrl+C to stop\n`);
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

const bot = new DerivMultiplierWPRBot();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n⚠️  Shutdown signal...');
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

// Validate API token
if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═'.repeat(70));
    console.log('         DERIV MULTIPLIER WPR BOT v1.1');
    console.log('═'.repeat(70));
    console.log('\n⚠️  API Token not configured!\n');
    console.log('Usage:');
    console.log('  API_TOKEN=your_token node deriv-multiplier-wpr-bot.js');
    console.log('\nEnvironment Variables:');
    console.log('  API_TOKEN       - Your Deriv API token (required)');
    console.log('  SYMBOL          - Trading symbol (default: R_75)');
    console.log('  CAPITAL         - Initial capital (default: 500)');
    console.log('  STAKE           - Initial stake (default: 1)');
    console.log('  MULT            - Contract multiplier (default: 100)');
    console.log('  TAKE_PROFIT     - Initial take profit amount (default: 0.50)');
    console.log('  USE_SL          - Use stop loss true/false (default: false)');
    console.log('  STOP_LOSS_AMT   - Stop loss amount (default: 0.50)');
    console.log('  PROFIT_TARGET   - Session profit target (default: 50)');
    console.log('  SESSION_SL      - Session stop loss (default: -100)');
    console.log('  STAKE_MULT      - Stake multiplier after losses (default: 2)');
    console.log('  LOSSES_BEFORE   - Losses before stake multiplier (default: 2)');
    console.log('  MAX_LEVEL       - Max multiplier level (default: 6)');
    console.log('  TIMEFRAME       - 1m,2m,3m,5m,10m,15m,30m,1h,4h (default: 5m)');
    console.log('  WPR_PERIOD      - WPR calculation period (default: 80)');
    console.log('  DEBUG           - Enable debug mode (default: false)');
    console.log('\nValid Multipliers for R_75:');
    console.log('  20, 40, 60, 80, 100, 200, 300, 400, 500');
    console.log('\nExample:');
    console.log('  API_TOKEN=xxx STAKE=2 TAKE_PROFIT=1 MULT=100 LOSSES_BEFORE=3 node deriv-multiplier-wpr-bot.js');
    console.log('\nTake Profit Logic:');
    console.log('  - Initial TP: Set by TAKE_PROFIT (e.g., $0.50)');
    console.log('  - After loss: TP = Initial TP + Accumulated Losses');
    console.log('  - Example: Initial TP $0.50, Loss $0.30 → New TP $0.80');
    console.log('  - When TP is hit: Covers losses + makes original profit');
    console.log('\nStrategy:');
    console.log('  BUY (MULTUP):   WPR crosses above -20 (prev ≤ -20, curr > -20)');
    console.log('  SELL (MULTDOWN): WPR crosses below -80 (prev ≥ -80, curr < -80)');
    console.log('  - Only 1 BUY and 1 SELL position at a time');
    console.log('  - Opposite signal = close current, open new (reversal)');
    console.log('  - TP automatically increases after losses to ensure recovery');
    console.log('═'.repeat(70));
    process.exit(1);
}

// Start
console.log('═'.repeat(70));
console.log('         DERIV MULTIPLIER WPR BOT v1.1');
console.log('═'.repeat(70));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

setTimeout(() => {
    Dashboard.startLiveUpdates();
}, 3000);

// Export
module.exports = {
    DerivMultiplierWPRBot,
    TechnicalIndicators,
    StakeManager,
    CONFIG,
    state
};
