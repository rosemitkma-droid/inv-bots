/**
 * Deriv Multi-Asset Trading Bot v1.0
 * ===================================
 * Dynamic asset selection with AI Portfolio Manager, per-asset strategies,
 * EMA/RSI/ADX indicators, Kelly Criterion allocation, and comprehensive risk controls.
 * 
 * Dependencies: ws, nodemailer
 */

const WebSocket = require('ws');
const nodemailer = require('nodemailer');

// ============ ASSET CONFIGURATION ============
const ASSET_CONFIG = {
    // Synthetic Indices
    R_10: {
        emaShort: 8, emaLong: 21, rsiPeriod: 14,
        duration: 15, durationUnit: 'm', maxTrades: 2,
        rsiThreshold: 30, volatilityClass: 'low',
        correlationGroup: 'synthetic', pipPosition: 2
    },
    R_25: {
        emaShort: 8, emaLong: 21, rsiPeriod: 14,
        duration: 15, durationUnit: 'm', maxTrades: 2,
        rsiThreshold: 30, volatilityClass: 'low',
        correlationGroup: 'synthetic', pipPosition: 2
    },
    R_75: {
        emaShort: 12, emaLong: 30, rsiPeriod: 21,
        duration: 30, durationUnit: 'm', maxTrades: 1,
        rsiThreshold: 35, volatilityClass: 'high',
        correlationGroup: 'synthetic_high', pipPosition: 3
    },
    BOOM1000: {
        emaShort: 5, emaLong: 15, rsiPeriod: 7,
        duration: 5, durationUnit: 'm', maxTrades: 3,
        rsiThreshold: 25, volatilityClass: 'spike',
        correlationGroup: 'boom_crash', pipPosition: 2
    },
    CRASH1000: {
        emaShort: 5, emaLong: 15, rsiPeriod: 7,
        duration: 5, durationUnit: 'm', maxTrades: 3,
        rsiThreshold: 25, volatilityClass: 'spike',
        correlationGroup: 'boom_crash', pipPosition: 2
    },
    // Forex
    frxEURUSD: {
        emaShort: 10, emaLong: 25, rsiPeriod: 14,
        duration: 4, durationUnit: 'h', maxTrades: 1,
        rsiThreshold: 30, volatilityClass: 'forex',
        correlationGroup: 'eur_pairs', pipPosition: 4
    },
    frxGBPUSD: {
        emaShort: 10, emaLong: 25, rsiPeriod: 14,
        duration: 4, durationUnit: 'h', maxTrades: 1,
        rsiThreshold: 30, volatilityClass: 'forex',
        correlationGroup: 'gbp_pairs', pipPosition: 4
    },
    frxUSDJPY: {
        emaShort: 10, emaLong: 25, rsiPeriod: 14,
        duration: 4, durationUnit: 'h', maxTrades: 1,
        rsiThreshold: 30, volatilityClass: 'forex',
        correlationGroup: 'jpy_pairs', pipPosition: 2
    },
    // Commodities
    WLDOIL: {
        emaShort: 15, emaLong: 35, rsiPeriod: 14,
        duration: 1, durationUnit: 'h', maxTrades: 2,
        rsiThreshold: 30, volatilityClass: 'commodity',
        correlationGroup: 'oil', pipPosition: 2
    },
    frxXAUUSD: {
        emaShort: 15, emaLong: 35, rsiPeriod: 14,
        duration: 1, durationUnit: 'h', maxTrades: 2,
        rsiThreshold: 30, volatilityClass: 'commodity',
        correlationGroup: 'gold', pipPosition: 2
    }
};

// Correlation pairs that cannot trade simultaneously
const CORRELATED_PAIRS = [
    ['frxEURUSD', 'frxGBPUSD'],
    ['R_75', 'R_25']
];

// ============ TECHNICAL INDICATORS ============
class TechnicalIndicators {
    /**
     * Calculate Exponential Moving Average
     */
    static calculateEMA(prices, period) {
        if (prices.length < period) return null;

        const multiplier = 2 / (period + 1);
        let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

        for (let i = period; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }

        return ema;
    }

    /**
     * Calculate RSI (Relative Strength Index)
     */
    static calculateRSI(prices, period = 14) {
        if (prices.length < period + 1) return 50;

        const changes = [];
        for (let i = 1; i < prices.length; i++) {
            changes.push(prices[i] - prices[i - 1]);
        }

        const recentChanges = changes.slice(-period);
        let gains = 0, losses = 0;

        for (const change of recentChanges) {
            if (change > 0) gains += change;
            else losses += Math.abs(change);
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;

        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    /**
     * Calculate ADX (Average Directional Index) - Trend Strength
     */
    static calculateADX(highs, lows, closes, period = 14) {
        if (highs.length < period * 2) return 25; // Neutral default

        const trueRanges = [];
        const plusDMs = [];
        const minusDMs = [];

        for (let i = 1; i < highs.length; i++) {
            const highLow = highs[i] - lows[i];
            const highPrevClose = Math.abs(highs[i] - closes[i - 1]);
            const lowPrevClose = Math.abs(lows[i] - closes[i - 1]);

            trueRanges.push(Math.max(highLow, highPrevClose, lowPrevClose));

            const upMove = highs[i] - highs[i - 1];
            const downMove = lows[i - 1] - lows[i];

            plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
        }

        // Smoothed averages
        const smoothedTR = this.smoothedAverage(trueRanges, period);
        const smoothedPlusDM = this.smoothedAverage(plusDMs, period);
        const smoothedMinusDM = this.smoothedAverage(minusDMs, period);

        if (smoothedTR === 0) return 25;

        const plusDI = (smoothedPlusDM / smoothedTR) * 100;
        const minusDI = (smoothedMinusDM / smoothedTR) * 100;

        const diSum = plusDI + minusDI;
        if (diSum === 0) return 25;

        const dx = (Math.abs(plusDI - minusDI) / diSum) * 100;
        return dx; // Simplified ADX approximation
    }

    static smoothedAverage(values, period) {
        if (values.length < period) return 0;
        return values.slice(-period).reduce((a, b) => a + b, 0) / period;
    }

    /**
     * Detect EMA Crossover
     */
    static detectCrossover(currentShort, currentLong, prevShort, prevLong) {
        const crossUp = prevShort <= prevLong && currentShort > currentLong;
        const crossDown = prevShort >= prevLong && currentShort < currentLong;
        return { crossUp, crossDown };
    }
}

// ============ AI PORTFOLIO MANAGER ============
class AIPortfolioManager {
    constructor(bot) {
        this.bot = bot;
        this.lastRebalance = 0;
        this.rebalanceInterval = 4 * 60 * 60 * 1000; // 4 hours
        this.scoringInterval = 5 * 60 * 1000; // 5 minutes
        this.lastScoring = 0;
        this.assetScores = {};
        this.topAssets = [];
    }

    /**
     * Score all assets and select top performers
     */
    scoreAllAssets() {
        const now = Date.now();
        if (now - this.lastScoring < this.scoringInterval) {
            return this.topAssets;
        }

        this.lastScoring = now;
        const scores = {};

        for (const asset of Object.keys(this.bot.assetStates)) {
            scores[asset] = this.scoreAsset(asset);
        }

        this.assetScores = scores;

        // Sort by score and get top 2
        const sorted = Object.entries(scores)
            .filter(([asset, score]) => !this.bot.assetStates[asset].blacklisted)
            .sort((a, b) => b[1] - a[1]);

        this.topAssets = sorted.slice(0, 2).map(([asset]) => asset);

        console.log('\n📊 PORTFOLIO MANAGER - Asset Scoring:');
        sorted.forEach(([asset, score], idx) => {
            const marker = idx < 2 ? '⭐' : '  ';
            console.log(`  ${marker} ${asset}: ${score.toFixed(1)}`);
        });
        console.log(`  Top Assets: ${this.topAssets.join(', ')}\n`);

        return this.topAssets;
    }

    /**
     * Score individual asset based on multiple factors
     * Formula: (recentWinRate * 0.3) + (trendStrength * 0.25) + (volatilityFit * 0.2) + (predictability * 0.25)
     */
    scoreAsset(asset) {
        const state = this.bot.assetStates[asset];
        const config = ASSET_CONFIG[asset];

        // Recent Win Rate (0-100)
        const recentWinRate = state.recentTrades.length > 0
            ? (state.recentWins / Math.max(state.recentTrades.length, 1)) * 100
            : 55; // Default assumption

        // Trend Strength from ADX (0-100, but cap at 50 for scoring)
        const trendStrength = Math.min(state.adx || 25, 50) * 2;

        // Volatility Fit - Does volatility match asset's expected class?
        const volatilityFit = this.calculateVolatilityFit(asset, state);

        // Predictability - Consistency of recent performance
        const predictability = this.calculatePredictability(state);

        const score = (recentWinRate * 0.3) +
            (trendStrength * 0.25) +
            (volatilityFit * 0.2) +
            (predictability * 0.25);

        return score;
    }

    calculateVolatilityFit(asset, state) {
        const config = ASSET_CONFIG[asset];
        const currentVolatility = state.volatility || 50;

        // Score based on how well current volatility matches expected
        const volatilityMap = {
            'low': 30,
            'high': 70,
            'spike': 80,
            'forex': 40,
            'commodity': 50
        };

        const expected = volatilityMap[config.volatilityClass] || 50;
        const diff = Math.abs(currentVolatility - expected);

        return Math.max(0, 100 - diff * 2);
    }

    calculatePredictability(state) {
        if (state.recentTrades.length < 5) return 50;

        // Calculate consistency of outcomes
        const outcomes = state.recentTrades.map(t => t.won ? 1 : 0);
        const mean = outcomes.reduce((a, b) => a + b, 0) / outcomes.length;
        const variance = outcomes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / outcomes.length;

        // Lower variance = more predictable
        return Math.max(0, 100 - variance * 200);
    }

    /**
     * Calculate Kelly Criterion stake allocation
     */
    calculateKellyStake(asset, totalRisk) {
        const state = this.bot.assetStates[asset];
        const winRate = state.winRate || 0.55;
        const odds = 0.85; // Typical payout rate

        // Kelly Formula: f = (bp - q) / b
        // where b = odds, p = win probability, q = loss probability
        const kelly = (odds * winRate - (1 - winRate)) / odds;

        // Cap at half-Kelly for safety
        const adjustedKelly = Math.max(0, Math.min(kelly * 0.5, 0.25));

        return totalRisk * adjustedKelly;
    }

    /**
     * Get allocated stake for an asset
     */
    getAllocatedStake(asset) {
        const capital = this.bot.capital;
        const totalRisk = capital * 0.02; // 2% total risk per cycle

        if (!this.topAssets.includes(asset)) {
            console.log(`  ⛔ No stake allocated for ${asset} because it is not in the top 2 assets`);
            return 0;
        }

        const rank = this.topAssets.indexOf(asset);
        const allocation = rank === 0 ? 0.6 : 0.4; // 60% to top, 40% to second

        return Math.max(0.35, totalRisk * allocation);
    }

    /**
     * Check if rebalance is needed
     */
    shouldRebalance() {
        const now = Date.now();
        return now - this.lastRebalance >= this.rebalanceInterval;
    }

    rebalance() {
        this.lastRebalance = Date.now();
        this.scoreAllAssets();
        console.log('🔄 Portfolio rebalanced');
    }
}

// ============ RISK MANAGER ============
class RiskManager {
    constructor(bot) {
        this.bot = bot;
        this.dailyLossLimit = 0.05; // 5% of capital
        this.dailyProfitTarget = 0.03; // 3%
        this.maxPositions = 5;
        this.maxTradesPerDirection = 3;
        this.cooldownAfterLosses = 4 * 60 * 60 * 1000; // 4 hours
        this.blacklistThreshold = 0.5; // 50% win rate
        this.blacklistTradeCount = 20;
        this.blacklistDuration = 48 * 60 * 60 * 1000; // 48 hours
    }

    /**
     * Check if trade is allowed based on risk rules
     */
    canTrade(asset, direction) {
        const state = this.bot.assetStates[asset];
        const portfolio = this.bot.portfolio;
        const config = ASSET_CONFIG[asset];

        // Check daily loss limit
        if (portfolio.dailyLoss >= this.bot.capital * this.dailyLossLimit) {
            console.log('⛔ Daily loss limit reached');
            return { allowed: false, reason: 'Daily loss limit reached' };
        }

        // Check max positions
        if (portfolio.activePositions.length >= this.maxPositions) {
            return { allowed: false, reason: 'Max positions reached' };
        }

        // Check per-asset daily trades
        if (state.dailyTrades >= config.maxTrades) {
            return { allowed: false, reason: `Max daily trades for ${asset}` };
        }

        // Check per-direction trades
        const directionTrades = direction === 'CALL' ? state.dailyCallTrades : state.dailyPutTrades;
        if (directionTrades >= this.maxTradesPerDirection) {
            return { allowed: false, reason: `Max ${direction} trades for ${asset}` };
        }

        // Check cooldown after consecutive losses
        if (state.consecutiveLosses >= 3 && Date.now() < state.cooldownUntil) {
            return { allowed: false, reason: `${asset} in cooldown` };
        }

        // Check blacklist
        if (state.blacklisted && Date.now() < state.blacklistedUntil) {
            return { allowed: false, reason: `${asset} is blacklisted` };
        }

        // Check correlation risk
        const correlationCheck = this.checkCorrelationRisk(asset);
        if (!correlationCheck.allowed) {
            return correlationCheck;
        }

        return { allowed: true };
    }

    /**
     * Check if correlated pair is already trading
     */
    checkCorrelationRisk(asset) {
        const activeSymbols = this.bot.portfolio.activePositions.map(p => p.asset);

        for (const pair of CORRELATED_PAIRS) {
            if (pair.includes(asset)) {
                const correlated = pair.find(a => a !== asset);
                if (activeSymbols.includes(correlated)) {
                    return { allowed: false, reason: `Correlated with active ${correlated}` };
                }
            }
        }

        return { allowed: true };
    }

    /**
     * Update blacklist status based on performance
     */
    updateBlacklist(asset) {
        const state = this.bot.assetStates[asset];

        if (state.recentTrades.length >= this.blacklistTradeCount) {
            const winRate = state.recentWins / state.recentTrades.length;

            if (winRate < this.blacklistThreshold) {
                state.blacklisted = true;
                state.blacklistedUntil = Date.now() + this.blacklistDuration;
                console.log(`⚠️ ${asset} blacklisted for 48 hours (Win rate: ${(winRate * 100).toFixed(1)}%)`);
            }
        }
    }

    /**
     * Check profit target and lock gains
     */
    checkProfitTarget() {
        const portfolio = this.bot.portfolio;
        const profitPercent = portfolio.dailyProfit / this.bot.capital;

        if (profitPercent >= this.dailyProfitTarget) {
            // Lock 50% of gains
            const toLock = portfolio.dailyProfit * 0.5;
            portfolio.lockedProfit += toLock;
            console.log(`🔒 Profit target reached! Locked $${toLock.toFixed(2)}`);
            return true;
        }
        return false;
    }
}

// ============ MAIN BOT CLASS ============
class MultiAssetDerivBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // Select active assets (max 5 for subscription limit)
        this.activeAssets = config.assets || ['R_10', 'R_25', 'R_75', 'BOOM1000', 'CRASH1000']; //['R_10', 'R_25', 'R_75', 'BOOM1000', 'CRASH1000', 'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'WLDOIL', 'frxXAUUSD'];

        // Capital and risk
        this.capital = config.capital || 500;
        this.initialCapital = this.capital;

        // Config
        this.config = {
            stopLoss: config.stopLoss || this.capital * 0.05,
            takeProfit: config.takeProfit || this.capital * 0.015,
            growthRate: config.growthRate || 0.05,
            requiredHistoryLength: config.requiredHistoryLength || 200,
            minTimeBetweenTrades: config.minTimeBetweenTrades || 5000
        };

        // Portfolio state
        this.portfolio = {
            dailyLoss: 0,
            dailyProfit: 0,
            activePositions: [],
            lockedProfit: 0
        };

        // Per-asset state
        this.assetStates = {};
        this.initializeAssetStates();

        // Global statistics
        this.globalStats = {
            totalTrades: 0,
            totalWins: 0,
            totalLosses: 0,
            totalProfit: 0,
            sessionStartTime: Date.now()
        };

        // Managers
        this.portfolioManager = new AIPortfolioManager(this);
        this.riskManager = new RiskManager(this);

        // Trading control
        this.tradingPaused = false;
        this.endOfDay = false;

        // Reconnection
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 100;
        this.reconnectInterval = 5000;

        // Email configuration
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };
        this.emailRecipient = 'kenotaru@gmail.com';
    }

    initializeAssetStates() {
        for (const asset of this.activeAssets) {
            const config = ASSET_CONFIG[asset];
            if (!config) {
                console.warn(`⚠️ Unknown asset: ${asset}, skipping`);
                continue;
            }

            this.assetStates[asset] = {
                // Price data
                candles: [],
                prices: [],
                highs: [],
                lows: [],
                closes: [],

                // Indicators
                emaShort: 0,
                emaLong: 0,
                prevEmaShort: 0,
                prevEmaLong: 0,
                rsi: 50,
                adx: 25,
                volatility: 50,

                // Trading state
                tradeInProgress: false,
                currentContractId: null,
                currentProposalId: null,
                dailyTrades: 0,
                dailyCallTrades: 0,
                dailyPutTrades: 0,
                consecutiveLosses: 0,
                cooldownUntil: 0,

                // Blacklist status
                blacklisted: false,
                blacklistedUntil: 0,

                // Performance
                totalTrades: 0,
                totalWins: 0,
                totalLosses: 0,
                totalProfit: 0,
                winRate: 0.55,
                recentTrades: [],
                recentWins: 0,

                // Confidence
                confidence: 50,
                lastAnalysisTime: 0
            };
        }
    }

    // ============ CONNECTION ============
    connect() {
        if (this.endOfDay) return;

        console.log('🔌 Connecting to Deriv API...');
        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.wsReady = true;
            this.reconnectAttempts = 0;
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                this.handleMessage(message);
            } catch (e) {
                console.error('Message parse error:', e);
            }
        });

        this.ws.on('error', (error) => {
            console.error('❌ WebSocket error:', error.message);
            this.handleDisconnect();
        });

        this.ws.on('close', () => {
            console.log('🔌 Disconnected');
            this.connected = false;
            if (!this.tradingPaused && !this.endOfDay) {
                this.handleDisconnect();
            }
        });
    }

    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else {
            setTimeout(() => this.sendRequest(request), 1000);
        }
    }

    authenticate() {
        console.log('🔐 Authenticating...');
        this.sendRequest({ authorize: this.token });
    }

    // ============ MESSAGE HANDLING ============
    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                this.handleAuthorization(message);
                break;
            case 'candles':
                this.handleCandles(message);
                break;
            case 'ohlc':
                this.handleOHLC(message);
                break;
            case 'tick':
                this.handleTick(message);
                break;
            case 'proposal':
                this.handleProposal(message);
                break;
            case 'buy':
                this.handleBuyResponse(message);
                break;
            case 'proposal_open_contract':
                this.handleContractUpdate(message);
                break;
            case 'error':
                this.handleApiError(message.error);
                break;
        }
    }

    handleAuthorization(message) {
        if (message.error) {
            console.error('❌ Auth failed:', message.error.message);
            return;
        }

        console.log('✅ Authorized');
        this.startTrading();
    }

    // ============ TRADING INITIALIZATION ============
    async startTrading() {
        console.log(`
            ╔════════════════════════════════════════════════╗
            ║   🚀 MULTI-ASSET TRADING BOT v1.0             ║
            ╟────────────────────────────────────────────────╢
            ║ Capital: $${this.capital.toFixed(2).padEnd(35)}║
            ║ Assets: ${this.activeAssets.join(', ').padEnd(37)}║
            ║ Strategy: EMA Crossover + RSI + AI Scoring    ║
            ╚════════════════════════════════════════════════╝
        `);

        // Subscribe to OHLC candles for each asset
        for (const asset of this.activeAssets) {
            await this.subscribeToAsset(asset);
            await this.delay(500);
        }

        // Start email timer
        this.startEmailTimer();

        // Start portfolio scoring loop
        setInterval(() => {
            this.portfolioManager.scoreAllAssets();
        }, 5 * 60 * 1000);

        console.log('📊 Subscribed to all assets. Waiting for signals...\n');
    }

    async subscribeToAsset(asset) {
        console.log(`📈 Subscribing to ${asset}...`);

        // Get initial candle history
        this.sendRequest({
            ticks_history: asset,
            count: this.config.requiredHistoryLength,
            end: 'latest',
            style: 'candles',
            granularity: 60
        });

        await this.delay(500);

        // Subscribe to live OHLC candles
        this.sendRequest({
            ohlc: asset,
            subscribe: 1,
            granularity: 60
        });

        // Also subscribe to live ticks for real-time price updates between candles
        this.sendRequest({
            ticks: asset,
            subscribe: 1
        });
    }

    handleCandles(message) {
        const asset = message.echo_req.ticks_history;
        const state = this.assetStates[asset];
        const candles = message.candles;

        if (!state || !candles) return;

        console.log(`📊 Received ${candles.length} historical candles for ${asset}`);

        state.candles = candles;
        state.prices = candles.map(c => parseFloat(c.close));
        state.highs = candles.map(c => parseFloat(c.high));
        state.lows = candles.map(c => parseFloat(c.low));
        state.closes = candles.map(c => parseFloat(c.close));

        console.log(`✅ ${asset} History Initialized: Prices length: ${state.prices.length}`);

        // Initial indicators calculation
        this.updateIndicators(asset);
    }

    // ============ OHLC & TICK HANDLING ============
    handleOHLC(message) {
        const ohlc = message.ohlc;
        if (!ohlc) return;

        const asset = ohlc.symbol;
        const state = this.assetStates[asset];
        if (!state) return;

        // Check if this is a new candle or an update to the current one
        const lastCandle = state.candles[state.candles.length - 1];
        const isNewCandle = !lastCandle || ohlc.open_time > lastCandle.epoch;

        if (isNewCandle) {
            // New candle started
            state.candles.push({
                epoch: ohlc.open_time,
                open: parseFloat(ohlc.open),
                high: parseFloat(ohlc.high),
                low: parseFloat(ohlc.low),
                close: parseFloat(ohlc.close)
            });
            state.prices.push(parseFloat(ohlc.close));
            state.highs.push(parseFloat(ohlc.high));
            state.lows.push(parseFloat(ohlc.low));
            state.closes.push(parseFloat(ohlc.close));

            // Keep history limited
            const maxLen = 200;
            while (state.prices.length > maxLen) {
                state.candles.shift();
                state.prices.shift();
                state.highs.shift();
                state.lows.shift();
                state.closes.shift();
            }

            // Calculate indicators on new candle
            this.updateIndicators(asset);
        } else {
            // Update current candle
            lastCandle.high = Math.max(lastCandle.high, parseFloat(ohlc.high));
            lastCandle.low = Math.min(lastCandle.low, parseFloat(ohlc.low));
            lastCandle.close = parseFloat(ohlc.close);

            state.prices[state.prices.length - 1] = parseFloat(ohlc.close);
            state.highs[state.highs.length - 1] = lastCandle.high;
            state.lows[state.lows.length - 1] = lastCandle.low;
            state.closes[state.closes.length - 1] = lastCandle.close;
        }
    }

    handleTick(message) {
        const tick = message.tick;
        if (!tick) return;

        const asset = tick.symbol;
        const state = this.assetStates[asset];
        if (!state) return;

        const price = parseFloat(tick.quote);

        // Update real-time price
        if (state.prices.length > 0) {
            state.prices[state.prices.length - 1] = price;
        }

        console.log(`${asset} => Ticks: ${price}`);

        // Check for trading signals
        if (this.shouldAnalyze(asset)) {
            // console.log(`Checking ${asset} for trading signals...`);
            this.analyzeAndTrade(asset);
        }
    }

    // ============ INDICATOR CALCULATION ============
    updateIndicators(asset) {
        const state = this.assetStates[asset];
        const config = ASSET_CONFIG[asset];
        const prices = state.prices;

        if (prices.length < config.emaLong + 5) return;

        // Store previous EMA values for crossover detection
        state.prevEmaShort = state.emaShort;
        state.prevEmaLong = state.emaLong;

        // Calculate EMAs
        state.emaShort = TechnicalIndicators.calculateEMA(prices, config.emaShort);
        state.emaLong = TechnicalIndicators.calculateEMA(prices, config.emaLong);

        // Calculate RSI
        state.rsi = TechnicalIndicators.calculateRSI(prices, config.rsiPeriod);

        // Calculate ADX
        if (state.highs.length >= config.rsiPeriod * 2) {
            state.adx = TechnicalIndicators.calculateADX(state.highs, state.lows, state.closes, 14);
        }

        // Calculate volatility (standard deviation of returns)
        if (prices.length > 20) {
            const returns = [];
            for (let i = 1; i < prices.length; i++) {
                returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
            }
            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
            state.volatility = Math.sqrt(variance) * 100 * 100; // Annualized-ish
        }
    }

    // ============ SIGNAL ANALYSIS ============
    shouldAnalyze(asset) {
        const state = this.assetStates[asset];
        const now = Date.now();

        // Don't analyze if already trading
        if (state.tradeInProgress) return false;

        // Rate limit analysis
        // console.log(`Last analysis time: ${state.lastAnalysisTime}`);
        console.log(`Now: ${now}`);
        if (now - state.lastAnalysisTime < 3000) return false;

        // Need enough data
        // console.log(`Prices length: ${state.prices.length}`);
        // console.log(`EMA Long: ${ASSET_CONFIG[asset].emaLong}`);
        if (state.prices.length < ASSET_CONFIG[asset].emaLong + 5) return false;

        // Check if asset is in top 2
        const topAssets = this.portfolioManager.topAssets;
        // console.log(`Top assets: ${topAssets}`);
        if (topAssets.length > 0 && !topAssets.includes(asset)) return false;

        return true;
    }

    analyzeAndTrade(asset) {
        const state = this.assetStates[asset];
        const config = ASSET_CONFIG[asset];

        state.lastAnalysisTime = Date.now();

        // Detect crossover
        const { crossUp, crossDown } = TechnicalIndicators.detectCrossover(
            state.emaShort, state.emaLong, state.prevEmaShort, state.prevEmaLong
        );

        // Calculate confidence
        const confidence = this.calculateConfidence(asset);
        state.confidence = confidence;

        let direction = null;

        // CALL: EMA cross up + RSI < threshold + AI confidence > 60%
        if (crossUp && state.rsi < config.rsiThreshold && confidence > 60) {
            direction = 'CALL';
        }
        // PUT: EMA cross down + RSI > (100 - threshold) + AI confidence > 60%
        else if (crossDown && state.rsi > (100 - config.rsiThreshold) && confidence > 60) {
            direction = 'PUT';
        }

        // console.log(`📊 ${asset} Signal: ${direction} (EMA: ${state.emaShort.toFixed(4)}/${state.emaLong.toFixed(4)}, RSI: ${state.rsi.toFixed(1)}, Conf: ${confidence.toFixed(1)}%)`);

        if (direction) {
            console.log(`📊 ${asset} Signal: ${direction} (EMA: ${state.emaShort.toFixed(4)}/${state.emaLong.toFixed(4)}, RSI: ${state.rsi.toFixed(1)}, Conf: ${confidence.toFixed(1)}%)`);

            // Check risk rules
            const riskCheck = this.riskManager.canTrade(asset, direction);
            if (!riskCheck.allowed) {
                console.log(`  ⛔ Blocked: ${riskCheck.reason}`);
                return;
            }

            // Request proposal
            this.requestProposal(asset, direction);
        }
    }

    calculateConfidence(asset) {
        const state = this.assetStates[asset];

        // Base confidence from win rate
        let confidence = state.winRate * 100;

        // Boost for strong trend (ADX)
        if (state.adx > 25) confidence += 10;
        if (state.adx > 40) confidence += 10;

        // Boost for RSI extremes (better reversal potential)
        if (state.rsi < 30 || state.rsi > 70) confidence += 5;
        if (state.rsi < 20 || state.rsi > 80) confidence += 5;

        // Penalty for high volatility mismatch
        const config = ASSET_CONFIG[asset];
        if (config.volatilityClass === 'low' && state.volatility > 60) {
            confidence -= 10;
        }

        return Math.min(100, Math.max(0, confidence));
    }

    // ============ PROPOSAL & TRADING ============
    requestProposal(asset, direction) {
        const state = this.assetStates[asset];
        const config = ASSET_CONFIG[asset];
        const stake = this.portfolioManager.getAllocatedStake(asset);

        if (stake <= 0) {
            console.log(`  ⛔ No stake allocated for ${asset}`);
            return;
        }

        console.log(`  💰 Requesting ${direction} proposal for ${asset}, Stake: $${stake.toFixed(2)}`);

        const proposal = {
            proposal: 1,
            amount: stake.toFixed(2),
            basis: 'stake',
            contract_type: direction,
            currency: 'USD',
            symbol: asset,
            duration: config.duration,
            duration_unit: config.durationUnit,
            passthrough: { asset, direction }
        };

        this.sendRequest(proposal);
    }

    handleProposal(message) {
        if (message.error) {
            console.error('Proposal error:', message.error.message);
            return;
        }

        const asset = message.echo_req?.passthrough?.asset;
        const direction = message.echo_req?.passthrough?.direction;

        if (!asset) return;

        const state = this.assetStates[asset];
        if (!state || state.tradeInProgress) return;

        const proposal = message.proposal;
        if (!proposal) return;

        state.currentProposalId = proposal.id;

        // Execute trade
        this.executeTrade(asset, direction, proposal.id, parseFloat(message.echo_req.amount));
    }

    executeTrade(asset, direction, proposalId, stake) {
        const state = this.assetStates[asset];

        console.log(`
            ╔════════════════════════════════════════╗
            ║        🎯 EXECUTING TRADE              ║
            ╟────────────────────────────────────────╢
            ║ Asset: ${asset.padEnd(30)} ║
            ║ Direction: ${direction.padEnd(27)} ║
            ║ Stake: $${stake.toFixed(2).padEnd(29)} ║
            ╚════════════════════════════════════════╝
        `);

        state.tradeInProgress = true;

        this.sendRequest({
            buy: proposalId,
            price: stake.toFixed(2)
        });
    }

    handleBuyResponse(message) {
        if (message.error) {
            console.error('❌ Buy error:', message.error.message);

            // Reset trade state for failed purchase
            for (const state of Object.values(this.assetStates)) {
                if (state.tradeInProgress && !state.currentContractId) {
                    state.tradeInProgress = false;
                }
            }
            return;
        }

        const contractId = message.buy.contract_id;
        const asset = message.echo_req?.passthrough?.asset;
        const direction = message.echo_req?.passthrough?.direction;

        if (asset) {
            const state = this.assetStates[asset];
            state.currentContractId = contractId;

            // Add to active positions
            this.portfolio.activePositions.push({
                asset,
                direction,
                contractId,
                entryTime: Date.now()
            });

            console.log(`✅ Trade placed: ${asset} ${direction} - Contract: ${contractId}`);

            // Subscribe to contract updates
            this.sendRequest({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1
            });
        }
    }

    handleContractUpdate(message) {
        const contract = message.proposal_open_contract;
        if (!contract) return;

        const contractId = contract.contract_id;

        // Find the asset for this contract
        let asset = null;
        for (const [assetName, state] of Object.entries(this.assetStates)) {
            if (state.currentContractId === contractId) {
                asset = assetName;
                break;
            }
        }

        if (!asset) return;

        // Check if contract ended
        if (contract.is_sold) {
            this.handleTradeResult(asset, contract);
        }
    }

    // ============ TRADE RESULT HANDLING ============
    handleTradeResult(asset, contract) {
        const state = this.assetStates[asset];
        const profit = parseFloat(contract.profit || 0);
        const won = contract.status === 'won';
        const direction = this.portfolio.activePositions.find(p => p.asset === asset)?.direction;

        // Update asset stats
        state.totalTrades++;
        state.dailyTrades++;

        if (direction === 'CALL') state.dailyCallTrades++;
        if (direction === 'PUT') state.dailyPutTrades++;

        // Track recent trades
        state.recentTrades.push({ won, profit, time: Date.now() });
        if (state.recentTrades.length > 20) state.recentTrades.shift();
        state.recentWins = state.recentTrades.filter(t => t.won).length;

        if (won) {
            state.totalWins++;
            state.consecutiveLosses = 0;
            state.totalProfit += profit;
            console.log(`✅ ${asset} WON! +$${profit.toFixed(2)}`);
        } else {
            state.totalLosses++;
            state.consecutiveLosses++;
            state.totalProfit += profit;

            if (state.consecutiveLosses >= 3) {
                state.cooldownUntil = Date.now() + this.riskManager.cooldownAfterLosses;
                console.log(`  ⏸️ ${asset} entering 4-hour cooldown`);
            }

            console.log(`❌ ${asset} LOST! -$${Math.abs(profit).toFixed(2)}`);
            this.sendLossEmail(asset, state);
        }

        // Update win rate
        state.winRate = state.totalTrades > 0 ? state.totalWins / state.totalTrades : 0.55;

        // Update portfolio
        if (profit > 0) {
            this.portfolio.dailyProfit += profit;
        } else {
            this.portfolio.dailyLoss += Math.abs(profit);
        }

        // Remove from active positions
        this.portfolio.activePositions = this.portfolio.activePositions.filter(p => p.asset !== asset);

        // Update global stats
        this.globalStats.totalTrades++;
        if (won) this.globalStats.totalWins++;
        else this.globalStats.totalLosses++;
        this.globalStats.totalProfit += profit;

        // Update capital
        this.capital += profit;

        // Check blacklist
        this.riskManager.updateBlacklist(asset);

        // Check profit target
        this.riskManager.checkProfitTarget();

        // Reset state
        state.tradeInProgress = false;
        state.currentContractId = null;
        state.currentProposalId = null;

        // Log summary
        this.logSummary();

        // Check exit conditions
        if (this.checkExitConditions()) {
            this.stopTrading();
        }
    }

    // ============ EXIT CONDITIONS ============
    checkExitConditions() {
        // Stop loss
        if (this.portfolio.dailyLoss >= this.config.stopLoss) {
            console.log('🛑 Daily stop loss reached');
            return true;
        }

        // Take profit (50% locked)
        if (this.portfolio.dailyProfit >= this.config.takeProfit * 2) {
            console.log('🎯 Daily take profit reached');
            return true;
        }

        return false;
    }

    stopTrading() {
        console.log('\n📊 STOPPING TRADING...');
        this.tradingPaused = true;
        this.endOfDay = true;
        this.sendEmailSummary(true);
        this.disconnect();
    }

    // ============ LOGGING ============
    logSummary() {
        const winRate = this.globalStats.totalTrades > 0
            ? ((this.globalStats.totalWins / this.globalStats.totalTrades) * 100).toFixed(1)
            : 0;

        console.log(`
            ═══════════════════════════════════════════════════
            📊 PORTFOLIO SUMMARY
            ═══════════════════════════════════════════════════
            Capital: $${this.capital.toFixed(2)} (${this.globalStats.totalProfit >= 0 ? '+' : ''}$${this.globalStats.totalProfit.toFixed(2)})
            Trades: ${this.globalStats.totalTrades} | Won: ${this.globalStats.totalWins} | Lost: ${this.globalStats.totalLosses}
            Win Rate: ${winRate}%
            Active Positions: ${this.portfolio.activePositions.length}/${this.riskManager.maxPositions}
            Daily Loss: $${this.portfolio.dailyLoss.toFixed(2)} / $${this.config.stopLoss.toFixed(2)}
            ═══════════════════════════════════════════════════
        `);
    }

    // ============ EMAIL FUNCTIONS ============
    startEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendEmailSummary();
            }
        }, 1800000); // 30 minutes
    }

    async sendEmailSummary(isFinal = false) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const winRate = this.globalStats.totalTrades > 0
            ? ((this.globalStats.totalWins / this.globalStats.totalTrades) * 100).toFixed(2)
            : 0;

        const assetBreakdown = Object.entries(this.assetStates)
            .map(([asset, state]) =>
                `${asset}: Trades: ${state.totalTrades} | Win Rate: ${(state.winRate * 100).toFixed(1)}% | P/L: $${state.totalProfit.toFixed(2)}`
            ).join('\n');

        const summaryText = `
            DERIV MULTI-ASSET BOT ${isFinal ? 'FINAL ' : ''}SUMMARY
            ========================================

            Portfolio Performance:
            ---------------------
            Capital: $${this.capital.toFixed(2)}
            Total P/L: $${this.globalStats.totalProfit.toFixed(2)}
            Daily Profit: $${this.portfolio.dailyProfit.toFixed(2)}
            Daily Loss: $${this.portfolio.dailyLoss.toFixed(2)}
            Locked Profit: $${this.portfolio.lockedProfit.toFixed(2)}

            Trading Statistics:
            ------------------
            Total Trades: ${this.globalStats.totalTrades}
            Won: ${this.globalStats.totalWins} | Lost: ${this.globalStats.totalLosses}
            Win Rate: ${winRate}%
            Active Positions: ${this.portfolio.activePositions.length}

            Top Assets: ${this.portfolioManager.topAssets.join(', ')}

            Per-Asset Breakdown:
            -------------------
            ${assetBreakdown}

            Risk Status:
            -----------
            Daily Loss Limit: ${(this.portfolio.dailyLoss / (this.capital * 0.05) * 100).toFixed(1)}% used
            Blacklisted Assets: ${Object.entries(this.assetStates).filter(([, s]) => s.blacklisted).map(([a]) => a).join(', ') || 'None'}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: `Deriv Multi-Asset Bot - ${isFinal ? 'Final Report' : 'Summary'}`,
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Email error:', error.message);
        }
    }

    async sendLossEmail(asset, assetState) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const summaryText = `
            LOSS ALERT - ${asset}
            ====================

            Asset: ${asset}
            Consecutive Losses: ${assetState.consecutiveLosses}
            Asset P/L: $${assetState.totalProfit.toFixed(2)}
            Asset Win Rate: ${(assetState.winRate * 100).toFixed(1)}%

            Portfolio Status:
            ----------------
            Capital: $${this.capital.toFixed(2)}
            Total P/L: $${this.globalStats.totalProfit.toFixed(2)}
            Daily Loss: $${this.portfolio.dailyLoss.toFixed(2)}

            ${assetState.consecutiveLosses >= 3 ? '⚠️ Asset entering 4-hour cooldown' : ''}
            ${assetState.blacklisted ? '⛔ Asset has been blacklisted for 48 hours' : ''}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: `Deriv Multi-Asset Bot - Loss Alert: ${asset}`,
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // Silent fail
        }
    }

    async sendDisconnectResumptionEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const now = new Date();

        const summaryText = `
            BOT STATUS UPDATE
            =================
            Time: ${now.toLocaleTimeString()}
            Status: ${this.endOfDay ? 'Day Trading Complete' : 'Reconnected'}

            Capital: $${this.capital.toFixed(2)}
            Total P/L: $${this.globalStats.totalProfit.toFixed(2)}
            Trades: ${this.globalStats.totalTrades}
            Win Rate: ${this.globalStats.totalTrades > 0 ? ((this.globalStats.totalWins / this.globalStats.totalTrades) * 100).toFixed(1) : 0}%
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Deriv Multi-Asset Bot - Status Update',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // Silent fail
        }
    }

    // ============ UTILITIES ============
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    handleApiError(error) {
        console.error('API Error:', error.message);
        if (error.code === 'RateLimit') {
            this.tradingPaused = true;
            setTimeout(() => { this.tradingPaused = false; }, 60000);
        }
    }

    handleDisconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts && !this.endOfDay) {
            this.reconnectAttempts++;
            console.log(`🔄 Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.reconnectInterval);
        } else {
            console.log('Max reconnection attempts reached');
            this.sendDisconnectResumptionEmailSummary();
        }
    }

    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    start() {
        console.log(`
            ╔════════════════════════════════════════════════════════════════════╗
            ║           🚀 DERIV MULTI-ASSET TRADING BOT v1.0                   ║
            ╟────────────────────────────────────────────────────────────────────╢
            ║ Strategy: EMA Crossover + RSI Filter + AI Portfolio Management   ║
            ║ Risk: Kelly Criterion Allocation | 2% per trade | 5% daily limit ║
            ╚════════════════════════════════════════════════════════════════════╝
        `);
        this.connect();
    }
}

// ============ USAGE ============
const bot = new MultiAssetDerivBot('Dz2V2KvRf4Uukt3', {
    capital: 500,
    // For Binary Options
    assets: ['R_75', 'BOOM1000', 'CRASH1000', 'frxEURUSD', 'frxXAUUSD'], //['R_10', 'R_25', 'R_75', 'BOOM1000', 'CRASH1000', 'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxXAUUSD', 'WLDOIL'];
    // For Forex/Commodities, use:
    // assets: ['frxEURUSD', 'frxGBPUSD',  'frxUSDJPY', 'frxXAUUSD', 'WLDOIL'],
    stopLoss: 25,       // 5% of 500
    takeProfit: 12.5    // 2.5% of 500
});

bot.start();
