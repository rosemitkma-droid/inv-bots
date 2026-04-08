/**
 * Enhanced Deriv Accumulator Trading Bot
 * Version 4.0 - Research-Based Bollinger/MACD Strategy
 * 
 * STRATEGY OVERVIEW:
 * ─────────────────
 * Core principle: Accumulators profit from LOW VOLATILITY (price staying in range).
 * We use Bollinger Bands + MACD to detect low-volatility windows, then enter
 * with a conservative growth rate and take quick profits after a few ticks.
 *
 * KEY CHANGES FROM v3.1:
 * 1. Real Bollinger Bands + MACD technical analysis on tick prices (not digits)
 * 2. Lower growth rate (1%-2%) for wider barrier range = higher survival
 * 3. Quick profit-taking (3-8 ticks) instead of holding long
 * 4. Proper take_profit limit order + active sell execution (uncommented)
 * 5. WebSocket ping keep-alive to prevent 2-minute timeout
 * 6. Removed flawed "entry window" (ticks_stayed_in) concept
 * 7. Multi-asset concurrent trading (one contract per instrument)
 * 8. Proper cooldown, money management (3% risk per trade)
 * 9. Adaptive growth rate selection based on volatility regime
 */

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'accumulator-bot5_000017-v4-state.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                config: bot.config,
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                    accountBalance: bot.accountBalance,
                    currentStake: bot.currentStake,
                    consecutiveLosses2: bot.consecutiveLosses2,
                    consecutiveLosses3: bot.consecutiveLosses3,
                    consecutiveLosses4: bot.consecutiveLosses4,
                    consecutiveLosses5: bot.consecutiveLosses5,
                    tradeSystem: bot.tradeSystem,
                },
                assetMetrics: bot.assetMetrics,
                hourlyStats: bot.hourlyStats,
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
            return true;
        } catch (error) {
            console.error(`❌ Failed to save state: ${error.message}`);
            return false;
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                console.log('🆕 No previous state found, starting fresh');
                return null;
            }
            const fileContent = fs.readFileSync(STATE_FILE, 'utf8');
            const savedData = JSON.parse(fileContent);
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;
            if (ageMinutes > 60) {
                console.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                const backupFile = STATE_FILE.replace('.json', `_backup_${Date.now()}.json`);
                fs.renameSync(STATE_FILE, backupFile);
                return null;
            }
            console.log(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);
            return savedData;
        } catch (error) {
            console.error(`❌ Failed to load state: ${error.message}`);
            return null;
        }
    }

    static startAutoSave(bot) {
        if (bot.autoSaveInterval) clearInterval(bot.autoSaveInterval);
        bot.autoSaveInterval = setInterval(() => {
            if (bot.connected && !bot.endOfDay) StatePersistence.saveState(bot);
        }, STATE_SAVE_INTERVAL);

        const exitHandler = () => {
            console.log('\n🛑 Shutting down, saving final state...');
            StatePersistence.saveState(bot);
            process.exit();
        };
        process.on('SIGINT', exitHandler);
        process.on('SIGTERM', exitHandler);
        process.on('uncaughtException', (err) => {
            console.error('Uncaught Exception:', err);
            exitHandler();
        });
    }
}

// ============================================================================
// TECHNICAL INDICATORS — Bollinger Bands + MACD on raw tick prices
// ============================================================================
class TechnicalIndicators {
    /**
     * Simple Moving Average
     */
    static SMA(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        return slice.reduce((sum, v) => sum + v, 0) / period;
    }

    /**
     * Exponential Moving Average
     */
    static EMA(data, period) {
        if (data.length < period) return null;
        const k = 2 / (period + 1);
        let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
        for (let i = period; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
        }
        return ema;
    }

    /**
     * Standard Deviation
     */
    static stdDev(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        const mean = slice.reduce((s, v) => s + v, 0) / period;
        const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
        return Math.sqrt(variance);
    }

    /**
     * Bollinger Bands (20-period SMA, 2 std devs)
     * Returns: { upper, middle, lower, width, percentB }
     */
    static bollingerBands(prices, period = 20, multiplier = 2.0) {
        if (prices.length < period) return null;

        const middle = this.SMA(prices, period);
        const sd = this.stdDev(prices, period);
        const upper = middle + multiplier * sd;
        const lower = middle - multiplier * sd;
        const currentPrice = prices[prices.length - 1];

        // Band width (normalized) — lower = less volatile
        const width = (upper - lower) / middle;

        // %B — where price sits relative to bands (0 = lower, 1 = upper)
        const percentB = (upper - lower) !== 0 ? (currentPrice - lower) / (upper - lower) : 0.5;

        return { upper, middle, lower, width, percentB, stdDev: sd };
    }

    /**
     * MACD (12, 26, 9)
     * Returns: { macdLine, signalLine, histogram }
     */
    static MACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        if (prices.length < slowPeriod + signalPeriod) return null;

        // Calculate MACD line for recent history
        const macdValues = [];
        for (let i = slowPeriod; i <= prices.length; i++) {
            const slice = prices.slice(0, i);
            const fastEMA = this.EMA(slice, fastPeriod);
            const slowEMA = this.EMA(slice, slowPeriod);
            if (fastEMA !== null && slowEMA !== null) {
                macdValues.push(fastEMA - slowEMA);
            }
        }

        if (macdValues.length < signalPeriod) return null;

        const macdLine = macdValues[macdValues.length - 1];
        const signalLine = this.EMA(macdValues, signalPeriod);
        const histogram = macdLine - signalLine;

        // Get previous histogram for trend detection
        const prevMacdValues = macdValues.slice(0, -1);
        const prevSignal = prevMacdValues.length >= signalPeriod ? this.EMA(prevMacdValues, signalPeriod) : signalLine;
        const prevHistogram = prevMacdValues[prevMacdValues.length - 1] - prevSignal;

        return {
            macdLine,
            signalLine,
            histogram,
            prevHistogram,
            isConverging: Math.abs(histogram) < Math.abs(prevHistogram),
            histogramTrend: histogram - prevHistogram,
        };
    }

    /**
     * Average True Range approximation for tick data
     * Uses absolute tick-to-tick differences
     */
    static ATR(prices, period = 14) {
        if (prices.length < period + 1) return null;
        const ranges = [];
        for (let i = prices.length - period; i < prices.length; i++) {
            ranges.push(Math.abs(prices[i] - prices[i - 1]));
        }
        return ranges.reduce((s, v) => s + v, 0) / period;
    }

    /**
     * Bollinger Band Width percentile (how tight are bands vs recent history)
     * Lower percentile = tighter bands = lower volatility = better for accumulators
     */
    static bandWidthPercentile(prices, bbPeriod = 20, lookback = 100) {
        if (prices.length < lookback + bbPeriod) return null;

        const widths = [];
        for (let i = bbPeriod; i <= Math.min(lookback, prices.length - bbPeriod); i++) {
            const slice = prices.slice(0, prices.length - i + bbPeriod);
            const bb = this.bollingerBands(slice, bbPeriod);
            if (bb) widths.push(bb.width);
        }

        if (widths.length < 10) return null;

        const currentWidth = widths[0];
        const sorted = [...widths].sort((a, b) => a - b);
        const rank = sorted.findIndex(w => w >= currentWidth);
        return rank / sorted.length;
    }
}

// ============================================================================
// ACCUMULATOR MARKET ANALYZER — Bollinger + MACD Strategy
// ============================================================================
class AccumulatorAnalyzer {
    constructor() {
        this.tradeResults = {};   // Per-asset trade outcome history
    }

    /**
     * Record a completed trade for learning
     */
    recordTradeResult(asset, result) {
        if (!this.tradeResults[asset]) this.tradeResults[asset] = [];
        this.tradeResults[asset].push({
            ...result,
            timestamp: Date.now()
        });
        // Keep last 200
        if (this.tradeResults[asset].length > 200) this.tradeResults[asset].shift();
    }

    /**
     * Get historical win rate for asset
     */
    getAssetWinRate(asset) {
        const results = this.tradeResults[asset] || [];
        if (results.length < 5) return 0.5;
        const wins = results.filter(r => r.won).length;
        return wins / results.length;
    }

    /**
     * CORE: Analyze if conditions are favorable for an accumulator entry.
     * 
     * Accumulators profit when price STAYS IN RANGE. We need:
     * 1. Bollinger Bands contracted (low volatility = wide barrier relative to movement)
     * 2. MACD histogram near zero / flat (no strong momentum that could spike price)
     * 3. Price near middle of bands (not near edges where breakout is likely)
     */
    analyzeEntry(prices) {
        if (!prices || prices.length < 50) {
            return { shouldTrade: false, reason: 'insufficient_data' };
        }

        // --- Bollinger Bands Analysis ---
        const bb = TechnicalIndicators.bollingerBands(prices, 20, 2.0);
        if (!bb) return { shouldTrade: false, reason: 'bb_calc_failed' };

        // --- MACD Analysis ---
        const macd = TechnicalIndicators.MACD(prices, 12, 26, 9);
        if (!macd) return { shouldTrade: false, reason: 'macd_calc_failed' };

        // --- ATR for volatility context ---
        const atr = TechnicalIndicators.ATR(prices, 14);
        const currentPrice = prices[prices.length - 1];

        // --- Band Width Percentile ---
        const bwPercentile = TechnicalIndicators.bandWidthPercentile(prices, 20, 100);

        // ═══════════════════════════════════════════
        // SCORING SYSTEM — Each factor scores 0-1
        // ═══════════════════════════════════════════

        const scores = {};

        // 1. BOLLINGER BAND WIDTH — Contracted bands = low volatility = GOOD
        //    We want band width to be in the lower 50th percentile
        if (bwPercentile !== null) {
            if (bwPercentile <= 0.25) scores.bandWidth = 1.0;        // Very tight — excellent
            else if (bwPercentile <= 0.40) scores.bandWidth = 0.85;  // Tight — good
            else if (bwPercentile <= 0.55) scores.bandWidth = 0.65;  // Average — okay
            else if (bwPercentile <= 0.70) scores.bandWidth = 0.40;  // Wide — poor
            else scores.bandWidth = 0.15;                             // Very wide — avoid
        } else {
            // Fallback: use raw width
            if (bb.width < 0.003) scores.bandWidth = 1.0;
            else if (bb.width < 0.006) scores.bandWidth = 0.80;
            else if (bb.width < 0.010) scores.bandWidth = 0.55;
            else if (bb.width < 0.015) scores.bandWidth = 0.30;
            else scores.bandWidth = 0.10;
        }

        // 2. MACD HISTOGRAM — Flat/near-zero histogram = no momentum = GOOD
        //    Normalize histogram by price to make it comparable across assets
        const normalizedHist = Math.abs(macd.histogram) / currentPrice;
        if (normalizedHist < 0.00005) scores.macdFlat = 1.0;         // Dead flat — excellent
        else if (normalizedHist < 0.00015) scores.macdFlat = 0.85;
        else if (normalizedHist < 0.00035) scores.macdFlat = 0.60;
        else if (normalizedHist < 0.00060) scores.macdFlat = 0.35;
        else scores.macdFlat = 0.10;                                  // Strong momentum — avoid

        // 3. MACD CONVERGENCE — Histogram getting smaller = momentum fading = GOOD
        if (macd.isConverging) scores.macdConverging = 0.80;
        else scores.macdConverging = 0.35;

        // 4. %B POSITION — Price near middle band (0.3-0.7) = less likely to breach barrier
        if (bb.percentB >= 0.30 && bb.percentB <= 0.70) scores.pricePosition = 1.0;   // Sweet spot
        else if (bb.percentB >= 0.20 && bb.percentB <= 0.80) scores.pricePosition = 0.70;
        else if (bb.percentB >= 0.10 && bb.percentB <= 0.90) scores.pricePosition = 0.40;
        else scores.pricePosition = 0.10;  // Price at band edge — high breakout risk

        // 5. RECENT TICK STABILITY — Check last 10 ticks for erratic movement
        const recentPrices = prices.slice(-10);
        let maxTickMove = 0;
        for (let i = 1; i < recentPrices.length; i++) {
            const move = Math.abs(recentPrices[i] - recentPrices[i - 1]) / recentPrices[i - 1];
            maxTickMove = Math.max(maxTickMove, move);
        }
        // For accumulators, the barrier at 1% growth rate is ±0.045% of previous spot
        // At 5% it's ±0.0065%. We want max tick move to be well under the barrier.
        if (maxTickMove < 0.0003) scores.tickStability = 1.0;
        else if (maxTickMove < 0.0008) scores.tickStability = 0.80;
        else if (maxTickMove < 0.0015) scores.tickStability = 0.55;
        else if (maxTickMove < 0.0025) scores.tickStability = 0.30;
        else scores.tickStability = 0.05;

        // 6. VOLATILITY TREND — Is ATR declining? (= getting calmer = GOOD)
        const atrRecent = TechnicalIndicators.ATR(prices, 7);
        const atrLonger = TechnicalIndicators.ATR(prices.slice(0, -7), 14);
        if (atrRecent && atrLonger && atrLonger > 0) {
            const atrRatio = atrRecent / atrLonger;
            if (atrRatio < 0.70) scores.volTrend = 1.0;        // Volatility dropping fast
            else if (atrRatio < 0.85) scores.volTrend = 0.80;
            else if (atrRatio < 1.0) scores.volTrend = 0.60;
            else if (atrRatio < 1.15) scores.volTrend = 0.40;
            else scores.volTrend = 0.15;                        // Volatility rising — avoid
        } else {
            scores.volTrend = 0.5;
        }

        // ═══════════════════════════════════════════
        // WEIGHTED COMPOSITE SCORE
        // ═══════════════════════════════════════════
        const weights = {
            bandWidth: 0.25,       // Most important — overall volatility state
            macdFlat: 0.20,        // Momentum neutrality
            macdConverging: 0.10,  // Momentum direction
            pricePosition: 0.20,   // Position safety
            tickStability: 0.15,   // Recent stability
            volTrend: 0.10,        // Volatility trajectory
        };

        let overallScore = 0;
        for (const [key, weight] of Object.entries(weights)) {
            overallScore += (scores[key] || 0) * weight;
        }

        // ═══════════════════════════════════════════
        // DETERMINE OPTIMAL GROWTH RATE
        // ═══════════════════════════════════════════
        let recommendedGrowthRate;
        if (overallScore >= 0.85) recommendedGrowthRate = 0.02;    // High confidence → 3%
        else if (overallScore >= 0.75) recommendedGrowthRate = 0.02; // Good → 2%
        else if (overallScore >= 0.65) recommendedGrowthRate = 0.02; // Moderate → safest 1%
        else recommendedGrowthRate = 0.02;                          // Default safest

        // ═══════════════════════════════════════════
        // HARD REJECTION FILTERS
        // ═══════════════════════════════════════════

        // REJECT: Bollinger Bands expanding (volatility increasing)
        if (scores.bandWidth < 0.30) {
            return {
                shouldTrade: false,
                reason: 'bands_expanding_high_volatility',
                scores, overallScore, bb, macd, recommendedGrowthRate
            };
        }

        // REJECT: Strong momentum (MACD histogram large)
        if (scores.macdFlat < 0.25) {
            return {
                shouldTrade: false,
                reason: 'strong_momentum_detected',
                scores, overallScore, bb, macd, recommendedGrowthRate
            };
        }

        // REJECT: Price at band edge (breakout imminent)
        if (scores.pricePosition < 0.25) {
            return {
                shouldTrade: false,
                reason: 'price_at_band_edge',
                scores, overallScore, bb, macd, recommendedGrowthRate
            };
        }

        // REJECT: Recent tick spike (erratic movement)
        if (scores.tickStability < 0.20) {
            return {
                shouldTrade: false,
                reason: 'erratic_tick_movement',
                scores, overallScore, bb, macd, recommendedGrowthRate
            };
        }

        // ═══════════════════════════════════════════
        // FINAL DECISION
        // ═══════════════════════════════════════════
        const minScore = 0.65; // Minimum composite score to trade

        return {
            shouldTrade: overallScore >= minScore,
            reason: overallScore >= minScore ? 'conditions_favorable' : `score_below_threshold (${(overallScore * 100).toFixed(1)}% < ${minScore * 100}%)`,
            scores,
            overallScore,
            bb,
            macd,
            recommendedGrowthRate,
            tickStability: scores.tickStability,
            atr,
            maxTickMove,
        };
    }
}

// ============================================================================
// RISK MANAGER — 3% risk per trade with proper money management
// ============================================================================
class RiskManager {
    constructor(config) {
        this.config = config;
        this.maxDailyLoss = config.maxDailyLoss || 100;
        this.maxConsecutiveLosses = config.maxConsecutiveLosses || 6;
        this.assetCooldowns = {};
        this.riskPerTrade = config.riskPerTrade || 0.03; // 3% of balance per trade
    }

    /**
     * Calculate stake based on account balance and 3% risk rule
     */
    calculateStake(accountBalance, consecutiveLosses) {
        // Base stake: 3% of balance
        let stake = accountBalance * this.riskPerTrade;

        // Reduce stake after consecutive losses (defensive)
        // if (consecutiveLosses >= 3) {
        //     stake *= 0.5; // Half stake after 3 losses
        // } else if (consecutiveLosses >= 2) {
        //     stake *= 0.75;
        // }

        // Enforce Deriv min/max
        // stake = Math.max(1, Math.min(100, stake));

        // Round to 2 decimal places
        return Math.round(stake * 100) / 100;
    }

    isAssetOnCooldown(asset) {
        const cooldown = this.assetCooldowns[asset];
        if (!cooldown) return false;
        if (Date.now() < cooldown.until) return true;
        delete this.assetCooldowns[asset];
        return false;
    }

    cooldownAsset(asset, durationMinutes = 15) {
        this.assetCooldowns[asset] = {
            until: Date.now() + (durationMinutes * 60 * 1000),
            reason: 'loss_cooldown'
        };
        console.log(`🔒 ${asset} on cooldown for ${durationMinutes} minutes`);
    }

    canTrade(asset, dailyProfitLoss, consecutiveLosses) {
        if (dailyProfitLoss <= -this.maxDailyLoss) {
            return { allowed: false, reason: 'daily_loss_limit' };
        }
        if (consecutiveLosses >= this.maxConsecutiveLosses) {
            return { allowed: false, reason: 'max_consecutive_losses' };
        }
        if (this.isAssetOnCooldown(asset)) {
            return { allowed: false, reason: 'asset_cooldown' };
        }
        return { allowed: true };
    }
}

// ============================================================================
// MAIN ACCUMULATOR BOT v4.0
// ============================================================================
class AccumulatorBotV4 {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // Supported assets for accumulators
        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];

        this.config = {
            // Money management
            initialBalance: config.initialBalance || 100, //Investment Capital
            riskPerTrade: config.riskPerTrade || 0.03,  // 3% per trade
            maxConsecutiveLosses: config.maxConsecutiveLosses || 6,
            maxDailyLoss: config.maxDailyLoss || 100,
            dailyTakeProfit: config.dailyTakeProfit || 200,
            tradeSystem: config.tradeSystem || 1,

            // Accumulator settings
            defaultGrowthRate: config.defaultGrowthRate || 0.01,  // 1% — safest, widest range

            // Take profit: number of ticks to hold before selling
            targetProfitTicks: config.targetProfitTicks || 5,  // Quick profit 3-8 ticks

            // Take profit as dollar amount (backup for limit order)
            takeProfitMultiplier: config.takeProfitMultiplier || 0.10,  // 10% of stake

            // Analysis thresholds
            minOverallScore: config.minOverallScore || 0.85,
            minTimeBetweenTrades: config.minTimeBetweenTrades || 10000, // 10s between trades per asset

            // History requirements
            requiredHistoryLength: config.requiredHistoryLength || 100,

            // Analysis interval — don't analyze every single tick
            analysisInterval: config.analysisInterval || 3, // Analyze every 3rd tick
        };

        // Trading state
        this.currentStake = this.config.initialStake;
        this.accountBalance = this.config.initialBalance;
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.dailyProfitLoss = 0;
        this.endOfDay = false;
        this.isWinTrade = false;
        this.losttrades = 0;
        this.tradeInProgress = false;
        this.ticksHeld = 0;
        this.Sys = config.tradeSystem;

        // Active trades — ONE PER ASSET (Deriv rule)
        this.activeTrades = {}; // { asset: { contractId, ... } }
        this.contractSubscriptions = {}; // { asset: subscriptionId }

        // RAW PRICE histories for technical analysis (NOT last-digit)
        this.priceHistories = {};
        this.tickCounts = {};  // Count ticks per asset for analysis throttling
        this.tickSubscriptionIds = {};
        this.lastTradeTime = {}; // Per-asset trade timing

        // Asset metrics
        this.assetMetrics = {};

        // Components
        this.analyzer = new AccumulatorAnalyzer();
        this.riskManager = new RiskManager(this.config);

        // Initialize per-asset data
        this.assets.forEach(asset => {
            this.priceHistories[asset] = [];
            this.tickCounts[asset] = 0;
            this.lastTradeTime[asset] = 0;
            this.assetMetrics[asset] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
        });

        // Telegram
        this.telegramToken = config.telegramToken || process.env.TELEGRAM_TOKEN;
        this.telegramChatId = config.telegramChatId || process.env.TELEGRAM_CHAT_ID;
        if (this.telegramToken && this.telegramChatId) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
        }

        // Stats
        this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0 };

        // Load saved state
        this.loadSavedState();

        // Reconnection
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 5000;

        // Ping interval handle
        this.pingInterval = null;
    }

    // ========================================================================
    // STATE MANAGEMENT
    // ========================================================================
    loadSavedState() {
        const state = StatePersistence.loadState();
        if (!state) return;
        try {
            if (state.trading) {
                this.consecutiveLosses = state.trading.consecutiveLosses || 0;
                this.totalTrades = state.trading.totalTrades || 0;
                this.totalWins = state.trading.totalWins || 0;
                this.totalLosses = state.trading.totalLosses || 0;
                this.totalProfitLoss = state.trading.totalProfitLoss || 0;
                this.dailyProfitLoss = state.trading.dailyProfitLoss || 0;
            }
            if (state.assetMetrics) this.assetMetrics = state.assetMetrics;
            console.log(`✅ State restored: ${this.totalTrades} trades, P&L: $${this.totalProfitLoss.toFixed(2)}`);
        } catch (error) {
            console.error(`❌ Error restoring state: ${error.message}`);
        }
    }

    // ========================================================================
    // WEBSOCKET CONNECTION + PING KEEP-ALIVE
    // ========================================================================
    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        console.log('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ WebSocket connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.startPingKeepAlive();
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            try {
                this.handleMessage(JSON.parse(data));
            } catch (error) {
                console.error('Error parsing message:', error.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error.message);
        });

        this.ws.on('close', () => {
            console.log('Disconnected from Deriv API');
            this.stopPingKeepAlive();
            this.handleDisconnect();
        });
    }

    /**
     * CRITICAL: Ping every 25 seconds to prevent WebSocket timeout
     */
    startPingKeepAlive() {
        this.stopPingKeepAlive();
        this.pingInterval = setInterval(() => {
            if (this.connected) {
                this.sendRequest({ ping: 1 });
            }
        }, 25000);
    }

    stopPingKeepAlive() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    authenticate() {
        this.sendRequest({ authorize: this.token });
    }

    sendRequest(request) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            this.ws.send(JSON.stringify(request));
            return true;
        } catch (error) {
            console.error('Error sending request:', error.message);
            return false;
        }
    }

    handleDisconnect() {
        if (this.endOfDay) {
            this.cleanup();
            return;
        }
        this.connected = false;
        this.wsReady = false;
        StatePersistence.saveState(this);

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    cleanup() {
        this.stopPingKeepAlive();
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { }
            }
            this.ws = null;
        }
        this.connected = false;
        this.wsReady = false;
    }

    // ========================================================================
    // MESSAGE HANDLING
    // ========================================================================
    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                if (message.error) {
                    console.error('Auth failed:', message.error.message);
                    this.disconnect();
                    return;
                }
                console.log(`✅ Authenticated | Balance: $${message.authorize.balance}`);
                // this.accountBalance = parseFloat(message.authorize.balance);
                this.wsReady = true;
                this.initializeSubscriptions();
                break;

            case 'history':
                this.handleTickHistory(message);
                break;

            case 'tick':
                if (message.subscription) {
                    this.tickSubscriptionIds[message.tick.symbol] = message.subscription.id;
                }
                this.handleTickUpdate(message.tick);
                break;

            case 'proposal':
                this.handleProposal(message);
                break;

            case 'buy':
                this.handleBuyResponse(message);
                break;

            case 'proposal_open_contract':
                if (message.error) {
                    console.error('Contract error:', message.error.message);
                    return;
                }
                this.handleContractUpdate(message);
                break;

            case 'sell':
                this.handleSellResponse(message);
                break;

            case 'ping':
                // Keep-alive response — no action needed
                break;

            default:
                if (message.error) {
                    console.error(`API Error [${message.msg_type}]:`, message.error.message);
                }
        }
    }

    initializeSubscriptions() {
        console.log('📡 Subscribing to tick streams...');
        this.assets.forEach(asset => {
            // Get historical prices (raw prices, NOT digits)
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });
            // Subscribe to live ticks
            this.sendRequest({
                ticks: asset,
                subscribe: 1
            });
        });
    }

    startTelegramTimer() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1);
        nextHour.setMinutes(0);
        nextHour.setSeconds(0);
        nextHour.setMilliseconds(0);

        const timeUntilNextHour = nextHour.getTime() - now.getTime();

        setTimeout(() => {
            this.sendHourlySummary();
            setInterval(() => {
                this.sendHourlySummary();
            }, 60 * 60 * 1000);
        }, timeUntilNextHour);

        console.log(`📱 Hourly summaries scheduled. First in ${Math.ceil(timeUntilNextHour / 60000)} minutes.`);
    }

    handleTickHistory(message) {
        const asset = message.echo_req.ticks_history;
        const history = message.history;

        // Store RAW PRICES (not last digits!) for technical analysis
        this.priceHistories[asset] = history.prices.map(p => parseFloat(p));
        console.log(`📊 ${asset}: Loaded ${this.priceHistories[asset].length} price ticks | Last: ${this.priceHistories[asset].slice(-1)[0]}`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);

        this.priceHistories[asset].push(price);

        // Keep a rolling window
        if (this.priceHistories[asset].length > 500) {
            this.priceHistories[asset] = this.priceHistories[asset].slice(-300);
        }

        this.tickCounts[asset] = (this.tickCounts[asset] || 0) + 1;

        // Throttle analysis to every Nth tick to reduce CPU
        if (this.tickCounts[asset] % this.config.analysisInterval !== 0) return;

        // Don't analyze if not ready or if this asset already has an active trade
        if (!this.wsReady) return;
        if (this.activeTrades[asset]) return;
        if (this.priceHistories[asset].length < this.config.requiredHistoryLength) return;

        // Minimum time between trades on same asset
        if (Date.now() - (this.lastTradeTime[asset] || 0) < this.config.minTimeBetweenTrades) return;

        // Run analysis and maybe trade
        this.evaluateAndTrade(asset);
    }

    // ========================================================================
    // TRADE ANALYSIS & EXECUTION — Bollinger + MACD Strategy
    // ========================================================================
    evaluateAndTrade(asset) {
        // 1. Risk check
        const riskCheck = this.riskManager.canTrade(asset, this.dailyProfitLoss, this.consecutiveLosses);
        if (!riskCheck.allowed) {
            return; // Silent skip — don't log every tick
        }

        // 2. Technical analysis
        const prices = this.priceHistories[asset];
        const analysis = this.analyzer.analyzeEntry(prices);

        // 3. Log analysis periodically (every 30th check to avoid spam)
        if (this.tickCounts[asset] % (this.config.analysisInterval * 10) === 0) {
            this.logAnalysis(asset, analysis);
        }

        // 4. Decision
        if (this.Sys === 1) {
            if (!analysis.shouldTrade) return;

            if (analysis.maxTickMove > 0.001) return;

            if (analysis.tickStability < 0.3) return;

            if (analysis.bb.percentB < 0.3 || analysis.bb.percentB > 0.7) return;

            if (analysis.macd.histogram > 0) return;

            if (analysis.macd.isConverging) return;

            if (analysis.overallScore < 0.85) return;
        }

        const shouldTrade =
            analysis.overallScore < 0.46 &&
            analysis.scores.bandWidth < 1 &&
            analysis.scores.macdFlat < 1 &&
            analysis.scores.pricePosition < 1 &&
            analysis.scores.tickStability >= 1


        if (this.Sys === 2 && !shouldTrade) return;

        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        // 5. Calculate stake
        this.currentStake = this.riskManager.calculateStake(
            this.accountBalance,
            this.consecutiveLosses
        );

        // 6. Request proposal with appropriate growth rate
        const growthRate = analysis.recommendedGrowthRate || this.config.defaultGrowthRate;
        const takeProfitAmount = this.currentStake * this.config.takeProfitMultiplier;

        console.log(`\n🎯 ENTRY SIGNAL: ${asset}`);
        console.log(`   Score: ${(analysis.overallScore * 100).toFixed(1)}%`);
        console.log(`   BB Width: ${analysis.bb.width.toFixed(6)} | %B: ${(analysis.bb.percentB * 100).toFixed(1)}%`);
        console.log(`   MACD Hist: ${analysis.macd.histogram.toFixed(6)} | Converging: ${analysis.macd.isConverging}`);
        console.log(`   Growth Rate: ${(growthRate * 100).toFixed(0)}% | Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`   Max Tick Move: ${(analysis.maxTickMove * 100).toFixed(2)}%`);
        console.log(`   Tick Stability: ${(analysis.tickStability * 100).toFixed(1)}%`);
        console.log(`   Reason: ${analysis.reason}`);
        console.log(`   Take Profit: $${takeProfitAmount.toFixed(2)}`);

        // Store pending analysis
        this.activeTrades[asset] = {
            status: 'requesting_proposal',
            analysis,
            growthRate,
            stake: this.currentStake,
            takeProfitAmount,
            entryTime: Date.now(),
        };

        this.sendRequest({
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: growthRate,
            limit_order: {
                take_profit: takeProfitAmount.toFixed(2)
            }
        });
    }

    logAnalysis(asset, analysis) {
        const s = analysis.scores || {};
        console.log(
            `📈 ${asset} | Score: ${(analysis.overallScore * 100 || 0).toFixed(0)}% | ` +
            `BW:${(s.bandWidth * 100 || 0).toFixed(0)} MACD:${(s.macdFlat * 100 || 0).toFixed(0)} ` +
            `Pos:${(s.pricePosition * 100 || 0).toFixed(0)} Stab:${(s.tickStability * 100 || 0).toFixed(0)} ` +
            `| ${analysis.shouldTrade ? '✅' : '❌'} ${analysis.reason}`
        );
    }

    handleProposal(message) {
        if (message.error) {
            const asset = message.echo_req?.symbol;
            if (asset && this.activeTrades[asset]?.status === 'requesting_proposal') {
                console.log(`❌ Proposal rejected for ${asset}: ${message.error.message}`);
                delete this.activeTrades[asset];
            }
            return;
        }

        const asset = message.echo_req.symbol;
        const proposal = message.proposal;

        // Only buy if we initiated this proposal
        if (!this.activeTrades[asset] || this.activeTrades[asset].status !== 'requesting_proposal') {
            // Stale proposal — ignore or forget
            if (proposal.id) {
                this.sendRequest({ forget: proposal.id });
            }
            return;
        }

        const trade = this.activeTrades[asset];

        console.log(`\n🚀 BUYING ACCUMULATOR: ${asset}`);
        console.log(`   Proposal ID: ${proposal.id}`);
        console.log(`   Stake: $${trade.stake.toFixed(2)} | Growth: ${(trade.growthRate * 100).toFixed(0)}%`);

        this.sendRequest({
            buy: proposal.id,
            price: trade.stake.toFixed(2)
        });

        trade.status = 'buying';
        trade.proposalId = proposal.id;
    }

    handleBuyResponse(message) {
        // Find which trade this corresponds to
        const asset = this.findAssetByStatus('buying');

        if (message.error) {
            console.error(`❌ Buy error: ${message.error.message}`);
            if (asset) delete this.activeTrades[asset];
            return;
        }

        if (!asset) {
            console.warn('Buy response but no pending trade found');
            return;
        }

        const trade = this.activeTrades[asset];
        const contractId = message.buy.contract_id;

        console.log(`✅ Contract opened: ${contractId} on ${asset}`);

        trade.status = 'active';
        trade.contractId = contractId;
        trade.buyPrice = parseFloat(message.buy.buy_price);
        trade.ticksHeld = 0;

        this.lastTradeTime[asset] = Date.now();

        // Subscribe to contract updates
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });

        // Telegram notification
        this.sendTelegramMessage(
            `🚀 <b>TRADE OPENED 5</b>\n\n` +
            `Asset: ${asset}\n` +
            `Stake: $${trade.stake.toFixed(2)}\n` +
            `Growth Rate: ${(trade.growthRate * 100).toFixed(0)}%\n` +
            `Score: ${(trade.analysis.overallScore * 100).toFixed(1)}%\n` +
            `Trade System: ${this.Sys}\n` +
            `Take Profit: $${trade.takeProfitAmount.toFixed(2)}`
        );
    }

    findAssetByStatus(status) {
        return Object.keys(this.activeTrades).find(
            asset => this.activeTrades[asset]?.status === status
        );
    }

    // ========================================================================
    // CONTRACT MONITORING & EXIT LOGIC
    // ========================================================================
    handleContractUpdate(message) {
        const contract = message.proposal_open_contract;
        if (!contract) return;

        // Find which asset this contract belongs to
        const asset = contract.underlying || this.findAssetByContractId(contract.contract_id);
        if (!asset || !this.activeTrades[asset]) return;

        const trade = this.activeTrades[asset];

        // Store subscription ID
        if (message.subscription?.id) {
            this.contractSubscriptions[asset] = message.subscription.id;
        }

        if (this.tradeInProgress) {
            this.ticksHeld++;
        }

        const currentProfit = parseFloat(contract.profit || 0);
        const tickCount = this.ticksHeld || 0;
        const bidPrice = parseFloat(contract.bid_price || 0);

        trade.ticksHeld = tickCount;
        trade.currentProfit = currentProfit;

        // ═══════════════════════════════════════════
        // CONTRACT SOLD (by limit order or barrier breach)
        // ═══════════════════════════════════════════
        if (contract.is_sold) {
            this.handleTradeResult(asset, contract);
            return;
        }

        // ═══════════════════════════════════════════
        // ACTIVE CONTRACT — Check if we should sell
        // ═══════════════════════════════════════════
        if (contract.is_valid_to_sell) {
            // Log progress every 2 ticks
            if (tickCount > 0 && tickCount % 2 === 0) {
                console.log(
                    `  📊 ${asset}: tick ${tickCount}/${this.config.targetProfitTicks} | ` +
                    `Profit: $${currentProfit.toFixed(3)} | Bid: $${bidPrice.toFixed(2)}`
                );
            }

            const sellDecision = this.shouldSellContract(trade, tickCount, currentProfit, bidPrice);

            if (sellDecision.sell) {
                console.log(`\n🎯 SELLING ${asset}: ${sellDecision.reason}`);
                console.log(`   Ticks: ${tickCount} | Profit: $${currentProfit.toFixed(3)}`);
                this.sellContract(contract.contract_id, bidPrice);
            }
        }
    }

    findAssetByContractId(contractId) {
        return Object.keys(this.activeTrades).find(
            asset => this.activeTrades[asset]?.contractId === contractId
        );
    }

    /**
     * SELL DECISION LOGIC — Quick profit-taking strategy
     */
    shouldSellContract(trade, ticksHeld, currentProfit, bidPrice) {
        const targetTicks = this.config.targetProfitTicks;
        const takeProfitAmount = trade.takeProfitAmount;

        // 1. TARGET TICKS REACHED — primary exit
        // if (ticksHeld >= targetTicks && currentProfit > 0) {
        //     return { sell: true, reason: `target_ticks (${ticksHeld}/${targetTicks}) with profit $${currentProfit.toFixed(3)}` };
        // }

        // 2. PROFIT TARGET HIT (backup for limit order)
        if (currentProfit >= takeProfitAmount) {
            return { sell: true, reason: `profit_target ($${currentProfit.toFixed(3)} >= $${takeProfitAmount.toFixed(2)})` };
        }

        // 3. GOOD PROFIT EARLY — secure it (70% of target after 3+ ticks)
        // if (ticksHeld >= 3 && currentProfit >= takeProfitAmount * 0.7) {
        //     return { sell: true, reason: `early_profit_lock ($${currentProfit.toFixed(3)})` };
        // }

        // 4. EXTENDED HOLD — any profit after 2x target ticks
        // if (ticksHeld >= targetTicks * 2 && currentProfit > 0) {
        //     return { sell: true, reason: 'extended_hold_exit' };
        // }

        // 5. MAX HOLD TIME — exit regardless after 3x target (safety)
        // if (ticksHeld >= targetTicks * 3) {
        //     return { sell: true, reason: 'max_hold_safety_exit' };
        // }

        return { sell: false, reason: null };
    }

    sellContract(contractId, price) {
        console.log(`📤 Selling contract ${contractId} at $${price.toFixed(2)}`);
        this.sendRequest({
            sell: contractId,
            price: price.toFixed(2)
        });
    }

    handleSellResponse(message) {
        if (message.error) {
            console.error('❌ Sell error:', message.error.message);
            return;
        }
        console.log(`✅ Sold for: $${message.sell?.sold_for || 'N/A'}`);
    }

    // ========================================================================
    // TRADE RESULT HANDLING
    // ========================================================================
    handleTradeResult(asset, contract) {
        const trade = this.activeTrades[asset];
        if (!trade) return;

        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const tickCount = trade.ticksHeld || 0;

        // Unsubscribe from contract
        if (this.contractSubscriptions[asset]) {
            this.sendRequest({ forget: this.contractSubscriptions[asset] });
            delete this.contractSubscriptions[asset];
        }

        console.log(`\n${'═'.repeat(55)}`);
        console.log(`  ${won ? '✅ WIN' : '❌ LOSS'}: ${asset} | Growth: ${(trade.growthRate * 100).toFixed(0)}%`);
        console.log(`  Ticks held: ${tickCount} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
        console.log(`  Score was: ${(trade.analysis.overallScore * 100).toFixed(1)}%`);
        console.log(`${'═'.repeat(55)}`);

        // Update stats
        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
        this.accountBalance += profit;
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;

        if (this.assetMetrics[asset]) {
            this.assetMetrics[asset].trades++;
            this.assetMetrics[asset].profitLoss += profit;
        }

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.isWinTrade = true;

            if (this.accountBalance > (this.config.initialBalance * 2)) {
                this.config.riskPerTrade = 0.005; // Trade 0.5% of balance after win trade when Balance is > 2x initial Investment
            } else {
                this.config.riskPerTrade = 0.01; // Trade 1% of balance after win trade
            }

            this.riskManager = new RiskManager(this.config);

            this.hourlyStats.wins++;
            if (this.assetMetrics[asset]) this.assetMetrics[asset].wins++;

            // Cooldown on loss
            this.riskManager.cooldownAsset(asset, 30);

        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.hourlyStats.losses++;
            if (this.assetMetrics[asset]) this.assetMetrics[asset].losses++;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            if (this.accountBalance > (this.config.initialBalance * 2)) {
                if (this.consecutiveLosses > 1) {
                    this.config.riskPerTrade = 0.30; // Trade 50% of balance after loss trade
                } else {
                    this.config.riskPerTrade = 0.05; // Trade 5% of balance after loss trade
                }
            } else {
                if (this.consecutiveLosses > 1) {
                    this.config.riskPerTrade = 0.50; // Trade 100% of balance after loss trade
                } else {
                    this.config.riskPerTrade = 0.07; // Trade 10% of balance after loss trade
                }
            }
            this.riskManager = new RiskManager(this.config);
            this.losttrades++;

            // // Cooldown on loss
            // this.riskManager.cooldownAsset(asset, 10);
        }

        this.tradeInProgress = false;
        this.ticksHeld = 0;

        // Record for learning
        this.analyzer.recordTradeResult(asset, {
            won,
            profit,
            ticksHeld: tickCount,
            growthRate: trade.growthRate,
            overallScore: trade.analysis.overallScore,
            bandWidth: trade.analysis.scores?.bandWidth,
            macdFlat: trade.analysis.scores?.macdFlat,
        });

        const winRate = this.totalTrades > 0 ? (this.totalWins / this.totalTrades * 100).toFixed(1) : '0.0';

        // Telegram
        this.sendTelegramMessage(
            `${won ? '✅' : '❌'} <b>Bot 5 ${won ? 'WIN' : 'LOSS'}</b>\n\n` +
            `Asset: ${asset}\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
            `Ticks: ${tickCount} | Growth: ${(trade.growthRate * 100).toFixed(0)}%\n\n` +
            `Trade System: ${this.Sys}\n` +
            `📊 Session:\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
            `Losses x2-x5: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4} | ${this.consecutiveLosses5}\n` +
            `Win Rate: ${winRate}%\n` +
            `Balance: $${this.accountBalance.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`
        );

        // if (!won) {
        //     if (this.Sys === 1) {
        //         this.Sys = 2;
        //     } else {
        //         this.Sys = 1;
        //     }
        // }

        // Clean up active trade
        delete this.activeTrades[asset];

        // Check session stop conditions
        if (this.dailyProfitLoss <= -this.config.maxDailyLoss) {
            this.shutdown('daily_loss_limit');
            return;
        }
        if (this.dailyProfitLoss >= this.config.dailyTakeProfit) {
            this.shutdown('daily_target_reached');
            return;
        }
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            this.shutdown('max_consecutive_losses');
            return;
        }

        StatePersistence.saveState(this);
    }

    // ========================================================================
    // TELEGRAM
    // ========================================================================
    async sendTelegramMessage(message) {
        if (!this.telegramBot) return;
        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error(`Telegram error: ${error.message}`);
        }
    }

    async sendHourlySummary() {
        const winRate = this.totalTrades > 0
            ? (this.totalWins / this.totalTrades * 100).toFixed(1)
            : '0.0';
        const pnlEmoji = this.totalProfitLoss >= 0 ? '🟢' : '🔴';
        const pnlStr = (this.totalProfitLoss >= 0 ? '+' : '') + '$' + Math.abs(this.totalProfitLoss).toFixed(2);

        await this.sendTelegramMessage(
            `📊 <b>Session Summary (Bot 5)</b>\n\n` +
            `Trades: ${this.totalTrades}\n` +
            `W/L: ${this.totalWins}/${this.totalLosses}\n` +
            `Losses x2-x5: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4} | ${this.consecutiveLosses5}\n` +
            `Win Rate: ${winRate}%\n` +
            `${pnlEmoji} Total P&amp;L: ${pnlStr}\n` +
            `Daily P&amp;L: ${this.dailyProfitLoss >= 0 ? '+' : ''}$${this.dailyProfitLoss.toFixed(2)}\n\n` +
            `⏰ ${new Date().toLocaleTimeString()}`
        );
    }

    // ========================================================================
    // Time-Based Disconnect / Reconnect
    // ========================================================================
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay(); // 0: Sunday, 1: Monday, ..., 6: Saturday
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Weekend logic: Saturday 11pm to Monday 2am GMT+1 -> Disconnect and stay disconnected
            const isWeekend = (currentDay === 0) || // Sunday
                (currentDay === 6 && currentHours >= 23) || // Saturday after 11pm
                (currentDay === 1 && currentHours < 8);    // Monday before 8am

            //New Day Start 
            if (this.endOfDay && currentHours === 2 && currentMinutes >= 0) {
                console.log("It's 2:00 AM GMT+1, reconnecting the bot.");
                this.resetForNewDay();
                this.endOfDay = false;
                this.connect();
            }

            //London Session Pause trading
            // if (this.isWinTrade && !this.endOfDay && currentHours < 10) {
            //     if (currentHours >= 6 && currentMinutes >= 0) {
            //         console.log("It's past 6:00 AM GMT+1 after a win trade, disconnecting the bot.");
            //         this.endOfDay = true;
            //         this.sendHourlySummary();
            //         this.disconnect();
            //     }
            // }

            //London Session Trade Resumption
            // if (this.endOfDay && currentHours === 10 && currentMinutes >= 0) {
            //     console.log("It's 10:00 AM GMT+1, reconnecting the bot.");
            //     // this.resetForNewDay();
            //     this.endOfDay = false;
            //     this.connect();
            // }

            //New York Session Pause trading
            if (this.isWinTrade && !this.endOfDay && currentHours < 15) {
                if (currentHours >= 13 && currentMinutes >= 0) {
                    console.log("It's past 1:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.endOfDay = true;
                    this.sendHourlySummary();
                    this.disconnect();
                }
            }

            //New York Session Trade Resumption
            if (this.endOfDay && currentHours === 13 && currentMinutes >= 0) {
                console.log("It's 3:00 PM GMT+1, reconnecting the bot.");
                // this.resetForNewDay();
                this.endOfDay = false;
                this.connect();
            }

            //End of Day Reset
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 23 && currentMinutes >= 0) {
                    console.log("It's past 11:30 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendHourlySummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    resetForNewDay() {
        console.log('🌅 Resetting for new day...');
        this.dailyProfitLoss = 0;
        this.consecutiveLosses = 0;
        this.reconnectAttempts = 0;
        this.riskManager = new RiskManager(this.config);
        console.log('✅ New day reset complete');
    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================
    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🚀 ACCUMULATOR BOT v4.0 — Bollinger/MACD Strategy');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('  Strategy: Enter during LOW VOLATILITY (contracted BB +');
        console.log('            flat MACD), quick profit-taking (3-8 ticks)');
        console.log('');
        console.log('  Configuration:');
        console.log(`    Growth Rate: ${(this.config.defaultGrowthRate * 100)}% (adaptive)`);
        console.log(`    Risk Per Trade: ${(this.config.riskPerTrade * 100)}%`);
        console.log(`    Target Ticks: ${this.config.targetProfitTicks}`);
        console.log(`    Take Profit: ${(this.config.takeProfitMultiplier * 100)}% of stake`);
        console.log(`    Min Score: ${(this.config.minOverallScore * 100)}%`);
        console.log(`    Max Daily Loss: $${this.config.maxDailyLoss}`);
        console.log(`    Daily Target: $${this.config.dailyTakeProfit}`);
        console.log(`    Assets: ${this.assets.join(', ')}`);
        console.log('');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');

        StatePersistence.startAutoSave(this);
        this.connect();
        this.checkTimeForDisconnectReconnect();
        // Start hourly summaries
        this.startHourlyReport();
        this.startTelegramTimer();
    }

    startHourlyReport() {
        setInterval(() => {
            if (!this.connected) return;
            const stats = this.hourlyStats;
            console.log(`\n📊 HOURLY REPORT: ${stats.trades} trades | ${stats.wins}W/${stats.losses}L | P&L: $${stats.pnl.toFixed(2)}`);
            console.log(`   Session: ${this.totalTrades} trades | Balance: $${this.accountBalance.toFixed(2)} | Total P&L: $${this.totalProfitLoss.toFixed(2)}`);

            // Per-asset breakdown
            for (const asset of this.assets) {
                const m = this.assetMetrics[asset];
                if (m.trades > 0) {
                    const wr = m.trades > 0 ? ((m.wins / m.trades) * 100).toFixed(0) : '0';
                    console.log(`   ${asset}: ${m.trades} trades | ${wr}% WR | P&L: $${m.profitLoss.toFixed(2)}`);
                }
            }

            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        }, 3600000); // Every hour
    }

    shutdown(reason = 'manual') {
        console.log(`\n🛑 Shutting down... Reason: ${reason}`);
        StatePersistence.saveState(this);
        this.endOfDay = true;

        // Try to sell any active contracts
        for (const [asset, trade] of Object.entries(this.activeTrades)) {
            if (trade.contractId && trade.status === 'active') {
                console.log(`   Attempting to close ${asset} contract ${trade.contractId}`);
                this.sendRequest({ sell: trade.contractId, price: 0 });
            }
        }

        this.sendTelegramMessage(
            `🛑 <b>BOT SHUTDOWN</b>\n\n` +
            `Reason: ${reason}\n\n` +
            `Final Stats:\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
            `Losses x2-x5: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4} | ${this.consecutiveLosses5}\n` +
            `Win Rate: ${(this.totalWins / Math.max(1, this.totalTrades) * 100).toFixed(1)}%\n` +
            `Balance: $${this.accountBalance.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`
        );

        // Delay cleanup to let sell orders process
        setTimeout(() => this.cleanup(), 3000);
    }

    disconnect() {
        this.shutdown('disconnect_called');
    }
}


// ============================================================================
// RUN BOT
// ============================================================================

const token = 'Dz2V2KvRf4Uukt3';

const bot = new AccumulatorBotV4(token, {
    // Money management
    initialBalance: 100,
    riskPerTrade: 0.01,        // 3% of balance per trade
    maxConsecutiveLosses: 3,
    maxDailyLoss: 100,
    dailyTakeProfit: 500000,
    tradeSystem: 2,

    // Accumulator strategy
    defaultGrowthRate: 0.02,   // 1% — widest barrier, highest survival
    targetProfitTicks: 5,      // Quick profit after 5 ticks
    takeProfitMultiplier: 0.20, // 20% of stake as TP (limit order backup)

    // Analysis
    minOverallScore: 1,     // Composite threshold
    analysisInterval: 1,       // Check every 3rd tick
    minTimeBetweenTrades: 10000,

    // Assets (lower volatility indices preferred)
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'], //, '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'

    // Telegram (use env vars or fill in)
    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    telegramChatId: '752497117',
});

bot.start();

module.exports = { AccumulatorBotV4 };
