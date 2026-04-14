/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         accumBotM — Enhanced Multi-Asset Accumulator Bot    ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  ORIGINAL STRATEGY (preserved):                              ║
 * ║  • Digit-frequency analysis on StayIN sequence               ║
 * ║  • Filters digits that appeared exactly filterNum times      ║
 * ║  • Entry when current digit count matches filtered array     ║
 * ║  • Martingale recovery with multiplier                       ║
 * ║                                                              ║
 * ║  UPGRADES:                                                   ║
 * ║  • Multi-asset concurrent trading (one contract per asset)   ║
 * ║  • Telegram notifications (replaces Gmail)                   ║
 * ║  • State persistence with auto-save                          ║
 * ║  • Trade watchdog for stuck contract recovery                ║
 * ║  • Robust reconnection with exponential backoff              ║
 * ║  • WebSocket ping keep-alive                                 ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// STATE PERSISTENCE MANAGER
// ══════════════════════════════════════════════════════════════════════════════
const STATE_FILE = path.join(__dirname, 'accumBotM2_000000001_state.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                    consecutiveLosses2: bot.consecutiveLosses2,
                    consecutiveLosses3: bot.consecutiveLosses3,
                    consecutiveLosses4: bot.consecutiveLosses4,
                    consecutiveLosses5: bot.consecutiveLosses5,
                    consecutiveLosses6: bot.consecutiveLosses6,
                    kCountNum: bot.kCountNum,
                    tradedDigitArray: bot.tradedDigitArray,
                    tradedDigitArray2: bot.tradedDigitArray2,
                    Sys1: bot.Sys1,
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
                console.warn(`⚠️  Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
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
            if (bwPercentile <= 0.20) scores.bandWidth = 1.0;        // Very tight — excellent
            else if (bwPercentile <= 0.40) scores.bandWidth = 0.85;  // Tight — good
            else if (bwPercentile <= 0.55) scores.bandWidth = 0.65;  // Average — okay
            else if (bwPercentile <= 0.70) scores.bandWidth = 0.40;  // Wide — poor
            else scores.bandWidth = 0.15;                             // Very wide — avoid
        } else {
            // Fallback: use raw width
            scores.bandWidth = 0.0;
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
        if (macd.isConverging) scores.macdConverging = 1.0;
        else scores.macdConverging = 0.35;

        // 4. %B POSITION — Price near middle band (0.3-0.7) = less likely to breach barrier
        if (bb.percentB >= 0.40 && bb.percentB <= 0.60) scores.pricePosition = 1.0;   // Sweet spot
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
        if (overallScore >= 0.85) recommendedGrowthRate = 0.03;    // High confidence → 3%
        else if (overallScore >= 0.75) recommendedGrowthRate = 0.03; // Good → 2%
        else if (overallScore >= 0.65) recommendedGrowthRate = 0.03; // Moderate → safest 1%
        else recommendedGrowthRate = 0.03;                          // Default safest

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
            volTrend: scores.volTrend
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════
class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // ── Multi-asset support ──────────────────────────────────────────────
        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];

        this.config = {
            initialStake: config.initialStake || 1,
            multiplier: config.multiplier || 6,
            multiplier2: config.multiplier2 || 8,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            takeProfit: config.takeProfit || 100,
            stopLoss: config.stopLoss || 100,
            // Accumulator specific
            growthRate: config.growthRate || 0.02,
            takeProfitMultiplier: config.takeProfitMultiplier || 0.20,
            filterNum: config.filterNum || 5,

            // Reconnection
            maxReconnectAttempts: 50,
            reconnectDelay: 5000,

            // Trade throttle per asset
            minTimeBetweenTrades: 5000,

            // History
            requiredHistoryLength: 100,
            analysisInterval: 1,

            // Telegram
            telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
            telegramChatId: '752497117',
        };

        // ── Trading state (original logic preserved) ─────────────────────────
        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.consecutiveLosses6 = 0;
        this.consecutiveLosses7 = 0;
        this.consecutiveLosses8 = 0;
        this.consecutiveLosses9 = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.dailyProfitLoss = 0;
        this.Pause = false;
        this.endOfDay = false;
        this.kCount = false;
        this.kCountNum = 0;
        this.kLoss = 0.01;
        this.confidenceThreshold = 0.5;
        this.kTradeCount = 0;
        this.isWinTrade = false;
        this.waitTime = 0;
        this.LossDigitsList = [];
        this.threeConsecutiveDigits = 0;
        this.predictedType = '';
        this.Sys1 = 0;
        this.tradedDigitArray = [];
        this.tradedDigitArray2 = [];
        this.filteredArray = [];
        this.tradeNum = Math.floor(Math.random() * (40 - 21 + 1)) + 21;
        this.filterNum = this.config.filterNum;
        this.Percentage = 0;
        this.predictedDigit = null;
        this.entryTick = null;
        this.currentTick = 0;
        // Components
        this.analyzer = new AccumulatorAnalyzer();

        // ── Multi-asset active trades ────────────────────────────────────────
        this.activeTrades = {};          // { asset: { contractId, status, ... } }
        this.contractSubscriptions = {}; // { asset: subscriptionId }
        this.tickSubscriptionIds = {};
        this.lastTradeTime = {};

        // ── Per-asset price/digit histories ──────────────────────────────────
        this.priceHistories = {};        // raw prices (not digits, for context)
        this.tickHistory = {};           // digit sequences per asset
        this.lastDigitsList = {};        // recent digits per asset
        this.tickCounts = {};            // tick counter per asset
        this.assetStates = {};           // { asset: { proposalId, ... } }

        // ── Asset metrics ────────────────────────────────────────────────────
        this.assetMetrics = {};

        // ── Asset suspension (focus on loss asset) ───────────────────────────
        this.suspendedAssets = new Set();
        this.focusAsset = null;

        // ── Telegram ─────────────────────────────────────────────────────────
        this.telegramBot = null;
        if (this.config.telegramToken && this.config.telegramChatId) {
            this.telegramBot = new TelegramBot(this.config.telegramToken, { polling: false });
        }
        this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0 };

        // ── Reconnection ─────────────────────────────────────────────────────
        this.reconnectAttempts = 0;
        this.pingInterval = null;

        // ── Trade Watchdog ───────────────────────────────────────────────────
        this.tradeWatchdogTimer = null;
        this.tradeWatchdogPollTimer = null;
        this.tradeWatchdogMs = 120000;
        this.tradeStartTime = null;

        // ── Initialize per-asset structures ──────────────────────────────────
        this.assets.forEach(asset => {
            this.priceHistories[asset] = [];
            this.tickHistory[asset] = [];
            this.lastDigitsList[asset] = [];
            this.tickCounts[asset] = 0;
            this.lastTradeTime[asset] = 0;
            this.assetStates[asset] = { proposalId: null, lastProposalAt: 0 };
            this.assetMetrics[asset] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
        });

        // ── Load saved state ─────────────────────────────────────────────────
        this.loadSavedState();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ASSET SUSPENSION LOGIC
    // ══════════════════════════════════════════════════════════════════════════
    suspendOtherAssets(lossAsset) {
        this.focusAsset = lossAsset;
        this.assets.forEach(asset => {
            if (asset !== lossAsset) {
                this.suspendedAssets.add(asset);
            }
        });
        console.log(`🔒 SUSPENDED: All assets except ${lossAsset}. Focusing on loss asset.`);
        this.sendTelegramMessage(
            `🔒 <b>Asset Suspension (accumBotM2)</b>\n\n` +
            `Loss on: <b>${lossAsset}</b>\n` +
            `Suspended: ${this.assets.filter(a => a !== lossAsset).join(', ')}\n` +
            `Focusing on ${lossAsset} until win`
        );
    }

    resumeAllAssets() {
        const prevFocus = this.focusAsset;
        this.suspendedAssets.clear();
        this.focusAsset = null;
        console.log(`✅ RESUMED: All assets active again (was focused on ${prevFocus})`);
        this.sendTelegramMessage(
            `✅ <b>All Assets Resumed (accumBotM2)</b>\n\n` +
            `Won on: <b>${prevFocus}</b>\n` +
            `All assets now active for trading`
        );
    }

    isAssetAllowed(asset) {
        if (!this.focusAsset) return true;
        return asset === this.focusAsset;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STATE MANAGEMENT
    // ══════════════════════════════════════════════════════════════════════════
    loadSavedState() {
        const state = StatePersistence.loadState();
        if (!state) return;
        try {
            if (state.trading) {
                this.currentStake = state.trading.currentStake || this.config.initialStake;
                this.consecutiveLosses = state.trading.consecutiveLosses || 0;
                this.totalTrades = state.trading.totalTrades || 0;
                this.totalWins = state.trading.totalWins || 0;
                this.totalLosses = state.trading.totalLosses || 0;
                this.totalProfitLoss = state.trading.totalProfitLoss || 0;
                this.dailyProfitLoss = state.trading.dailyProfitLoss || 0;
                this.consecutiveLosses2 = state.trading.consecutiveLosses2 || 0;
                this.consecutiveLosses3 = state.trading.consecutiveLosses3 || 0;
                this.consecutiveLosses4 = state.trading.consecutiveLosses4 || 0;
                this.consecutiveLosses5 = state.trading.consecutiveLosses5 || 0;
                this.consecutiveLosses6 = state.trading.consecutiveLosses6 || 0;
                this.kCountNum = state.trading.kCountNum || 0;
                this.tradedDigitArray = state.trading.tradedDigitArray || [];
                this.tradedDigitArray2 = state.trading.tradedDigitArray2 || [];
                this.Sys1 = state.trading.Sys1 || 0;
            }
            if (state.assetMetrics) this.assetMetrics = state.assetMetrics;
            if (state.hourlyStats) this.hourlyStats = state.hourlyStats;
            console.log(`✅ State restored: ${this.totalTrades} trades, P&L: $${this.totalProfitLoss.toFixed(2)}`);
        } catch (error) {
            console.error(`❌ Error restoring state: ${error.message}`);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // WEBSOCKET CONNECTION + PING KEEP-ALIVE
    // ══════════════════════════════════════════════════════════════════════════
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
            console.log('⚡ WebSocket disconnected');
            this.stopPingKeepAlive();
            this.handleDisconnect();
        });
    }

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

        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(this.config.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    cleanup() {
        this.stopPingKeepAlive();
        this._clearWatchdogTimers();
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

    disconnect() {
        console.log('🛑 Disconnecting...');
        StatePersistence.saveState(this);
        this.endOfDay = true;
        this.cleanup();
        console.log('✅ Bot disconnected');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // MESSAGE ROUTING
    // ══════════════════════════════════════════════════════════════════════════
    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                this.handleAuth(message);
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
                break;
            default:
                if (message.error) {
                    console.error(`API Error [${message.msg_type}]:`, message.error.message);
                }
        }
    }

    handleAuth(message) {
        if (message.error) {
            console.error('Auth failed:', message.error.message);
            this.disconnect();
            return;
        }
        console.log(`✅ Authenticated | Balance: $${message.authorize.balance}`);
        this.wsReady = true;
        this.initializeSubscriptions();
    }

    initializeSubscriptions() {
        console.log('📡 Subscribing to tick streams for all assets...');
        this.assets.forEach(asset => {
            // Historical prices
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });
            // Live tick subscription
            this.sendRequest({
                ticks: asset,
                subscribe: 1
            });
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TELEGRAM
    // ══════════════════════════════════════════════════════════════════════════
    async sendTelegramMessage(message) {
        if (!this.telegramBot) return;
        try {
            await this.telegramBot.sendMessage(this.config.telegramChatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error(`Telegram error: ${error.message}`);
        }
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

    async sendHourlySummary() {
        const winRate = this.totalTrades > 0
            ? (this.totalWins / this.totalTrades * 100).toFixed(1)
            : '0.0';
        const pnlEmoji = this.totalProfitLoss >= 0 ? '🟢' : '🔴';
        const pnlStr = (this.totalProfitLoss >= 0 ? '+' : '') + '$' + Math.abs(this.totalProfitLoss).toFixed(2);

        await this.sendTelegramMessage(
            `📊 <b>Session Summary (accumBotM2)</b>\n\n` +
            `Trades: ${this.totalTrades}\n` +
            `W/L: ${this.totalWins}/${this.totalLosses}\n` +
            `Losses x2-x6: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4}\n` +
            `Win Rate: ${winRate}%\n` +
            `${pnlEmoji} Total P&L: ${pnlStr}\n` +
            `Daily P&L: ${this.dailyProfitLoss >= 0 ? '+' : ''}$${this.dailyProfitLoss.toFixed(2)}\n` +
            `Current Stake: $${this.currentStake.toFixed(2)}\n\n` +
            `⏰ ${new Date().toLocaleTimeString()}`
        );
    }

    async sendDisconnectSummary() {
        await this.sendTelegramMessage(
            `⚠️ <b>accumBotM Disconnected2</b>\n\n` +
            `Trading Summary:\n` +
            `Total Trades: ${this.totalTrades}\n` +
            `Wins: ${this.totalWins} | Losses: ${this.totalLosses}\n` +
            `x2-x6 Losses: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4}\n\n` +
            `Total P&L: $${this.totalProfitLoss.toFixed(2)}\n` +
            `Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00'}%\n` +
            `Current Stake: $${this.currentStake.toFixed(2)}\n\n` +
            `Traded Digits: [${this.tradedDigitArray.join(', ')}]\n` +
            `Filtered Digits: [${this.filteredArray.join(', ')}]\n` +
            `Filter Number: ${this.filterNum}`
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TICK HISTORY & LIVE TICK HANDLING
    // ══════════════════════════════════════════════════════════════════════════
    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    handleTickHistory(message) {
        const asset = message.echo_req.ticks_history;
        const history = message.history;

        // Store raw prices
        this.priceHistories[asset] = history.prices.map(p => parseFloat(p));

        // Build digit history from raw prices
        this.tickHistory[asset] = history.prices.map(p => this.getLastDigit(p, asset));

        console.log(`📊 ${asset}: Loaded ${this.priceHistories[asset].length} price ticks | ${this.tickHistory[asset].length} digits`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);
        const lastDigit = this.getLastDigit(price, asset);

        // Store raw price
        this.priceHistories[asset].push(price);
        if (this.priceHistories[asset].length > 500) {
            this.priceHistories[asset] = this.priceHistories[asset].slice(-300);
        }

        // Store digit
        if (!this.lastDigitsList[asset]) this.lastDigitsList[asset] = [];
        this.lastDigitsList[asset].push(lastDigit);

        this.tickHistory[asset].push(lastDigit);
        if (this.tickHistory[asset].length > this.config.requiredHistoryLength) {
            this.tickHistory[asset].shift();
        }

        this.tickCounts[asset] = (this.tickCounts[asset] || 0) + 1;

        // Throttle analysis
        // if (this.tickCounts[asset] % this.config.analysisInterval !== 0) return;

        // Don't analyze if not ready or if asset already has active trade
        if (!this.wsReady) return;
        if (this.activeTrades[asset]) return;
        if (this.tickHistory[asset].length < this.config.requiredHistoryLength) return;

        // Minimum time between trades
        if (Date.now() - (this.lastTradeTime[asset] || 0) < this.config.minTimeBetweenTrades) return;

        // Run analysis and maybe trade
        this.evaluateAndTrade(asset);
    }

    // ========================================================================
    // TRADE ANALYSIS & EXECUTION — Bollinger + MACD Strategy
    // ========================================================================
    evaluateAndTrade(asset) {
        // Check if asset is suspended
        if (!this.isAssetAllowed(asset)) return;

        // Run original analyzeTicks logic — request proposal
        this.requestProposal(asset);
    }

    requestProposal(asset) {
        if (this.tradeInProgress) return;
        if (!this.wsReady) return;

        const takeProfitAmount = this.currentStake * this.config.takeProfitMultiplier;

        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: this.config.growthRate,
            limit_order: {
                take_profit: takeProfitAmount.toFixed(2)
            }
        };

        this.sendRequest(proposal);
    }

    handleProposal(message) {
        const asset = message.echo_req?.symbol;

        if (message.error) {
            if (asset && this.activeTrades[asset]?.status === 'requesting_proposal') {
                console.log(`❌ Proposal rejected for ${asset}: ${message.error.message}`);
                delete this.activeTrades[asset];
                this.tradeInProgress = false;
            }
            return;
        }

        if (!message.proposal) return;
        if (!asset) return;

        if (this.tradeInProgress) return;

        const proposal = message.proposal;
        const stayedInArray = proposal.contract_details.ticks_stayed_in;

        if (!stayedInArray) return;

        // Current digit count of the running accumulator
        const currentDigitCount = stayedInArray[99] + 1;

        this.currentTick = stayedInArray[99];

        console.log(`📋 Proposal for ${asset}: Current StayIN Digit Count: ${stayedInArray[99]} (${currentDigitCount})`);
        console.log(`   Filter Number: ${this.filterNum}`);

        // Store proposal ID
        this.assetStates[asset].proposalId = proposal.id;

        // ── Original frequency analysis logic ──────────────────────────────
        // Create frequency map of digits
        const digitFrequency = {};
        stayedInArray.forEach(digit => {
            digitFrequency[digit] = (digitFrequency[digit] || 0) + 1;
        });

        // Create array: digits that have appeared exactly filterNum times
        const appearedOnceArray = Object.keys(digitFrequency)
            .filter(digit => digitFrequency[digit] === this.filterNum)
            .map(Number);

        console.log(`   Digits that appeared ${this.filterNum} times: [${appearedOnceArray.join(', ')}]`);

        // Entry condition: current digit count is in appearedOnceArray
        // and not already traded, and stayedIn value >= 0
        const condition = appearedOnceArray.includes(currentDigitCount)
            && !this.tradedDigitArray.includes(stayedInArray[99])
            && stayedInArray[99] > 0;

        console.log(`   Entry condition: ${condition ? '✅ MET' : '❌ NOT MET'}`);

        // if (!this.isAssetAllowed(asset)) return;

        // 1. Technical analysis
        const prices = this.priceHistories[asset];
        const analysis = this.analyzer.analyzeEntry(prices);

        // 2. Log analysis periodically (every 30th check to avoid spam)
        // if (this.tickCounts[asset] % (this.config.analysisInterval * 10) === 0) {
        this.logAnalysis(asset, analysis);
        // }

        this.overallScore = (analysis.overallScore * 100).toFixed(1);
        this.bbWidth = analysis.bb.width.toFixed(6);
        this.percentB = (analysis.bb.percentB * 100).toFixed(1);
        this.macdHist = analysis.macd.histogram.toFixed(6);
        this.macdConverging = analysis.macd.isConverging;
        this.maxTickMove = (analysis.maxTickMove * 100).toFixed(2);
        this.tickStability = (analysis.tickStability * 100).toFixed(1);
        this.bbWidth = (analysis.scores.bandWidth * 100).toFixed(1);
        this.macdFlat = (analysis.scores.macdFlat * 100).toFixed(1);
        this.pricePosition = (analysis.scores.pricePosition * 100).toFixed(1);
        this.macdConverging = (analysis.scores.macdConverging * 100).toFixed(1);
        this.volTrend = (analysis.scores.volTrend * 100).toFixed(1);

        // 3. Decision
        // if (!analysis.shouldTrade) return;

        // if (analysis.overallScore < 0.65) return;

        if (analysis.scores.bandWidth < 1) return;

        if (analysis.scores.macdFlat < 0.5) return;

        if (analysis.scores.pricePosition < 0.5) return;

        if (!analysis.tickStability || analysis.tickStability === 'undefined' || analysis.tickStability === 'NaN' || analysis.tickStability < 1) return;

        if (analysis.scores.macdConverging < 1) return;

        if (this.maxTickMove < 0.03) return;

        if (analysis.scores.volTrend < 0.5) return;

        // Check if we should place trade
        if (condition) {
            this.tradedDigitArray.push(stayedInArray[99]);
            this.filteredArray = appearedOnceArray;
            this.entryTick = stayedInArray[99];
            console.log(`   Traded Digit Array: [${this.tradedDigitArray.join(', ')}]`);

            // 6. Request proposal with appropriate growth rate
            const growthRate = this.config.growthRate;
            const takeProfitAmount = this.currentStake * this.config.takeProfitMultiplier;

            console.log(`\n🎯 ENTRY SIGNAL: ${asset}`);
            console.log(`   Score: ${(analysis.overallScore * 100).toFixed(1)}%`);
            console.log(`   BB Width: ${analysis.bb.width.toFixed(6)} | %B: ${(analysis.bb.percentB * 100).toFixed(1)}%`);
            console.log(`   MACD Hist: ${analysis.macd.histogram.toFixed(6)} | Converging: ${analysis.macd.isConverging}`);
            console.log(`   Growth Rate: ${(growthRate * 100).toFixed(0)}% | Stake: $${this.currentStake.toFixed(2)}`);
            console.log(`   Max Tick Move: ${(analysis.maxTickMove * 100).toFixed(2)}%`);
            console.log(`   Tick Stability: ${(analysis.tickStability * 100).toFixed(1)}%`);

            console.log(`   BB Width: ${(analysis.scores.bandWidth * 100).toFixed(1)}%`);
            console.log(`   MACD Flat: ${(analysis.scores.macdFlat * 100).toFixed(1)}%`);
            console.log(`   Price Position: ${(analysis.scores.pricePosition * 100).toFixed(1)}%`);
            console.log(`   MACD Converging: ${(analysis.scores.macdConverging * 100).toFixed(1)}%`);
            console.log(`   Vol Trend: ${(analysis.scores.volTrend * 100).toFixed(1)}%`);
            console.log(`   Reason: ${analysis.reason}`);
            console.log(`   Take Profit: $${takeProfitAmount.toFixed(2)}`);

            // Place trade
            this.placeTrade(asset);
        }
    }

    logAnalysis(asset, analysis) {
        const s = analysis.scores || {};
        console.log(
            `📈 ${asset} | Score: ${(analysis.overallScore * 100 || 0).toFixed(0)}% | ` +
            `BW:${(s.bandWidth * 100 || 0).toFixed(0)} MACD:${(s.macdFlat * 100 || 0).toFixed(0)} ` +
            `Pos:${(s.pricePosition * 100 || 0).toFixed(0)} Stab:${(s.tickStability * 100 || 0).toFixed(0)} ` +
            `Conv:${(s.macdConverging * 100 || 0).toFixed(0)} Vol:${(s.volTrend * 100 || 0).toFixed(0)} ` +
            `Ticks: ${this.currentTick} | ` +
            `| ${analysis.shouldTrade ? '✅' : '❌'} ${analysis.reason}`
        );
    }

    placeTrade(asset) {
        if (this.tradeInProgress) return;

        const proposalId = this.assetStates[asset]?.proposalId;
        if (!proposalId) {
            console.error(`❌ No valid proposal ID for ${asset}`);
            return;
        }

        console.log(`\n🚀 PLACING TRADE: ${asset}`);
        console.log(`   Proposal ID: ${proposalId}`);
        console.log(`   Stake: $${this.currentStake.toFixed(2)}`);

        this.sendRequest({
            buy: proposalId,
            price: this.currentStake.toFixed(2)
        });

        this.tradeInProgress = true;
        this.activeTrades[asset] = {
            status: 'buying',
            proposalId,
            stake: this.currentStake,
            entryTime: Date.now(),
        };

        const trade = this.activeTrades[asset];

        // Telegram notification
        this.sendTelegramMessage(
            `🚀 <b>TRADE OPENED (accumBotM2)</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Entry Tick: <b>${this.entryTick}</b>\n` +
            `Stake: $${trade.stake.toFixed(2)}\n` +
            `Growth Rate: ${(this.config.growthRate * 100).toFixed(0)}%\n` +
            `Filter Number: ${this.filterNum}\n` +
            `Filtered Digits: [${this.filteredArray.join(', ')}]\n` +
            `Overall Score: ${this.overallScore}%\n` +
            `BB Width: ${this.bbWidth}%\n` +
            `MACD Flat: ${this.macdFlat}%\n` +
            `MACD Converging: ${this.macdConverging}%\n` +
            `Price Position: ${this.pricePosition}%\n` +
            `Tick Stability: ${this.tickStability}%\n` +
            `Max Tick Move: ${this.maxTickMove}%\n` +
            `Vol Trend: ${this.volTrend}%\n` +
            `Take Profit: $${(trade.stake * this.config.takeProfitMultiplier).toFixed(2)}`
        );

        this.lastTradeTime[asset] = Date.now();
    }

    handleBuyResponse(message) {
        const asset = this.findAssetByStatus('buying');

        if (message.error) {
            console.error(`❌ Buy error: ${message.error.message}`);
            if (asset) {
                delete this.activeTrades[asset];
            }
            this.tradeInProgress = false;
            this._clearWatchdogTimers();
            return;
        }

        if (!asset) {
            console.warn('Buy response but no pending trade found');
            this._clearWatchdogTimers();
            return;
        }

        const trade = this.activeTrades[asset];
        const contractId = message.buy.contract_id;

        console.log(`✅ Contract opened: ${contractId} on ${asset}`);

        trade.status = 'active';
        trade.contractId = contractId;
        trade.buyPrice = parseFloat(message.buy.buy_price);

        // Subscribe to contract updates
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });

        // Record trade start time and start watchdog
        this.tradeStartTime = Date.now();
        this._startTradeWatchdog(contractId);
        console.log(`⏱️  Trade watchdog started (${(this.tradeWatchdogMs / 1000).toFixed(0)}s timeout)`);
    }

    findAssetByStatus(status) {
        return Object.keys(this.activeTrades).find(
            asset => this.activeTrades[asset]?.status === status
        );
    }

    findAssetByContractId(contractId) {
        return Object.keys(this.activeTrades).find(
            asset => this.activeTrades[asset]?.contractId === contractId
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CONTRACT MONITORING & EXIT LOGIC
    // ══════════════════════════════════════════════════════════════════════════
    handleContractUpdate(message) {
        const contract = message.proposal_open_contract;
        if (!contract) return;

        const asset = contract.underlying || this.findAssetByContractId(contract.contract_id);
        if (!asset || !this.activeTrades[asset]) return;

        const trade = this.activeTrades[asset];

        // Store subscription ID
        if (message.subscription?.id) {
            this.contractSubscriptions[asset] = message.subscription.id;
        }

        // Contract settled?
        if (contract.is_sold) {
            this.handleTradeResult(asset, contract);
            return;
        }

        // Log progress
        const tickCount = contract.tick_count || 0;
        const profit = parseFloat(contract.profit || 0);
        const bidPrice = parseFloat(contract.bid_price || 0);

        if (tickCount > 0 && tickCount % 2 === 0) {
            console.log(
                `  📊 ${asset}: tick ${tickCount} | ` +
                `Profit: $${profit.toFixed(3)} | Bid: $${bidPrice.toFixed(2)} | ` +
                `Recent Digits: ${this.lastDigitsList[asset] ? this.lastDigitsList[asset].slice(-5).join(', ') : 'N/A'}`
            );
        }
    }

    handleSellResponse(message) {
        if (message.error) {
            console.error('❌ Sell error:', message.error.message);
            return;
        }
        console.log(`✅ Sold for: $${message.sell?.sold_for || 'N/A'}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TRADE WATCHDOG
    // ══════════════════════════════════════════════════════════════════════════
    _startTradeWatchdog(contractId) {
        this._clearWatchdogTimers();

        const timeoutMs = this.tradeWatchdogMs;

        this.tradeWatchdogTimer = setTimeout(() => {
            const hasActiveTrade = Object.keys(this.activeTrades).some(
                a => this.activeTrades[a]?.contractId
            );
            if (!hasActiveTrade) {
                this._clearWatchdogTimers();
                return;
            }

            console.warn(
                `⏰ WATCHDOG FIRED — Contract ${contractId || 'unknown'} has been open for ` +
                `${(timeoutMs / 1000).toFixed(0)}s with no settlement`
            );

            if (contractId && this.connected && this.wsReady) {
                console.log(`🔍 Polling contract ${contractId} for current status…`);
                this.sendRequest({
                    proposal_open_contract: 1,
                    contract_id: contractId,
                    subscribe: 1,
                });

                this.tradeWatchdogPollTimer = setTimeout(() => {
                    const stillActive = Object.keys(this.activeTrades).some(
                        a => this.activeTrades[a]?.contractId
                    );
                    if (!stillActive) {
                        this._clearWatchdogTimers();
                        return;
                    }
                    console.error(
                        `🚨 WATCHDOG: Poll timed out — contract ${contractId} still unresolved, ` +
                        `force-releasing lock`
                    );
                    this._recoverStuckTrade('watchdog-force');
                }, 15000);

            } else {
                this._recoverStuckTrade('watchdog-offline');
            }
        }, timeoutMs);
    }

    _clearWatchdogTimers() {
        if (this.tradeWatchdogTimer) {
            clearTimeout(this.tradeWatchdogTimer);
            this.tradeWatchdogTimer = null;
        }
        if (this.tradeWatchdogPollTimer) {
            clearTimeout(this.tradeWatchdogPollTimer);
            this.tradeWatchdogPollTimer = null;
        }
    }

    _recoverStuckTrade(reason) {
        this._clearWatchdogTimers();

        const stuckAsset = Object.keys(this.activeTrades).find(
            asset => this.activeTrades[asset]?.contractId
        );
        if (!stuckAsset) {
            console.warn('⚠️  No active trade found for stuck trade recovery');
            this.tradeInProgress = false;
            return;
        }

        const trade = this.activeTrades[stuckAsset];
        const contractId = trade.contractId || 'unknown';
        const stake = trade.stake || 0;
        const entryTime = this.tradeStartTime || Date.now();
        const openSeconds = Math.round((Date.now() - entryTime) / 1000);

        console.error(
            `\n🚨 STUCK TRADE RECOVERY [${reason}]` +
            `\n   Contract: ${contractId}` +
            `\n   Asset: ${stuckAsset}` +
            `\n   Stake: $${stake.toFixed(2)}` +
            `\n   Open for: ${openSeconds}s`
        );

        // Emergency sell attempt
        if (contractId && contractId !== 'unknown' && this.connected && this.wsReady) {
            console.log(`🔄 Attempting emergency sell of contract ${contractId}…`);
            this.sendRequest({
                sell: contractId,
                price: '0',
            });
        }

        // Forget subscription
        if (this.contractSubscriptions[stuckAsset]) {
            this.sendRequest({ forget: this.contractSubscriptions[stuckAsset] });
            delete this.contractSubscriptions[stuckAsset];
        }

        // Clear trade state
        this.tradeInProgress = false;
        this.tradeStartTime = null;
        delete this.activeTrades[stuckAsset];

        // Record as loss
        this.totalLosses++;
        this.consecutiveLosses++;
        this.consecutiveLosses2++;

        if (this.assetMetrics[stuckAsset]) {
            this.assetMetrics[stuckAsset].losses++;
            this.assetMetrics[stuckAsset].profitLoss -= stake;
        }

        this.totalProfitLoss -= stake;
        this.dailyProfitLoss -= stake;

        this.suspendOtherAssets(stuckAsset);

        console.log(
            `\n   Trade lock released — bot can now trade again` +
            `\n   Stake $${stake.toFixed(2)} recorded as loss`
        );

        this.sendTelegramMessage(
            `🚨 <b>STUCK TRADE RECOVERED2[${reason}]</b>\n\n` +
            `Contract: ${contractId}\n` +
            `Asset: ${stuckAsset}\n` +
            `Stake: $${stake.toFixed(2)}\n` +
            `Open for: ${openSeconds}s\n` +
            `Action: Emergency sell attempted, trade lock released`
        );

        StatePersistence.saveState(this);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TRADE RESULT HANDLING (original logic preserved)
    // ══════════════════════════════════════════════════════════════════════════
    handleTradeResult(asset, contract) {
        const trade = this.activeTrades[asset];
        if (!trade) {
            this._clearWatchdogTimers();
            return;
        }

        // Clear watchdog
        this._clearWatchdogTimers();

        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        // Unsubscribe from contract
        if (this.contractSubscriptions[asset]) {
            this.sendRequest({ forget: this.contractSubscriptions[asset] });
            delete this.contractSubscriptions[asset];
        }

        console.log(`\n${'═'.repeat(55)}`);
        console.log(`  ${won ? '✅ WIN' : '❌ LOSS'}: ${asset}`);
        console.log(`  Ticks: ${contract.tick_count || 0} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
        console.log(`${'═'.repeat(55)}`);

        // Update stats
        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;

        if (this.assetMetrics[asset]) {
            this.assetMetrics[asset].trades++;
            this.assetMetrics[asset].profitLoss += profit;
        }

        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.currentStake = this.config.initialStake;
            this.consecutiveLosses = 0;
            this.filterNum = this.config.filterNum;

            if (this.assetMetrics[asset]) this.assetMetrics[asset].wins++;
            this.hourlyStats.wins++;

            // Resume all assets after win
            if (this.focusAsset) {
                this.resumeAllAssets();
            }
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.kCountNum = 0;
            this.isWinTrade = false;
            this.hourlyStats.losses++;

            this.filterNum++;

            if (this.assetMetrics[asset]) this.assetMetrics[asset].losses++;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;
            else if (this.consecutiveLosses === 6) this.consecutiveLosses6++;

            // Original martingale
            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;

            // Suspend all other assets, focus on loss asset
            // this.suspendOtherAssets(asset);
        }

        // Keep traded digit array trimmed
        if (this.tradedDigitArray.length > 3) {
            this.tradedDigitArray.shift();
        }

        this.Sys1 = 0;
        this.currentTick = null;

        this.tradeInProgress = false;
        this.tradeStartTime = null;
        delete this.activeTrades[asset];

        // Send Trade result notification
        this.sendTelegramMessage(
            `${won ? '✅' : '❌'} <b>accumBotM2</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
            `Consecutive Losses: ${this.consecutiveLosses}\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
            `Losses x2-x5: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4} | ${this.consecutiveLosses5}\n` +
            `Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00'}%\n` +
            `Stake: $${this.currentStake.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`
        );

        // Log summary
        this.logTradingSummary();

        // Take profit condition
        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('🎯 Take Profit Reached... Stopping trading.');
            this.endOfDay = true;
            this.sendDisconnectSummary();
            this.disconnect();
            return;
        }

        // Stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('🛑 Stopping condition met. Disconnecting...');
            this.endOfDay = true;
            this.sendDisconnectSummary();
            this.disconnect();
            return;
        }

        StatePersistence.saveState(this);

        // ═══════════════════════════════════════════════════════════════════
        // IMMEDIATE RE-EVALUATION — Don't wait for the next tick
        // ═══════════════════════════════════════════════════════════════════
        // this._evaluateAllAssetsImmediately();
    }

    /**
     * Immediately evaluate all assets for a new trade opportunity
     * after a trade closes.
     */
    _evaluateAllAssetsImmediately() {
        this.assets.forEach(a => {
            this.tickCounts[a] = 0;
        });

        for (const asset of this.assets) {
            if (!this.isAssetAllowed(asset)) continue;
            if (this.tradeInProgress) break;
            if (this.activeTrades[asset]) continue;
            if (!this.tickHistory[asset] || this.tickHistory[asset].length < this.config.requiredHistoryLength) continue;
            if (Date.now() - (this.lastTradeTime[asset] || 0) < this.config.minTimeBetweenTrades) continue;

            console.log(`\n⚡ IMMEDIATE RE-ENTRY: ${asset} (post-trade evaluation)`);

            this.requestProposal(asset);
            break;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TIME-BASED DISCONNECT / RECONNECT (original logic preserved)
    // ══════════════════════════════════════════════════════════════════════════
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

            // Afternoon resume: 2:00 AM
            if (this.endOfDay && currentHours === 2 && currentMinutes >= 0) {
                console.log("It's 2:00 AM, reconnecting the bot.");
                this.endOfDay = false;
                this.Pause = false;
                this.tradeInProgress = false;
                this.tradedDigitArray = [];
                this.tradedDigitArray2 = [];
                this.tradeNum = Math.floor(Math.random() * (40 - 21 + 1)) + 21;
                this.connect();
            }

            // Evening stop: after 11:00 PM following a win
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 23 && currentMinutes >= 0) {
                    console.log("It's past 11:00 PM after a win trade, disconnecting.");
                    this.sendDisconnectSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TRADING SUMMARY
    // ══════════════════════════════════════════════════════════════════════════
    logTradingSummary() {
        console.log('\n📊 Trading Summary:');
        console.log(`  Total Trades: ${this.totalTrades}`);
        console.log(`  Total Trades Won: ${this.totalWins}`);
        console.log(`  Total Trades Lost: ${this.totalLosses}`);
        console.log(`  x2 Losses: ${this.consecutiveLosses2}`);
        console.log(`  x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`  x4 Losses: ${this.consecutiveLosses4}`);
        console.log(`  Total Profit/Loss: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`  Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00'}%`);
        console.log(`  Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`  Filtered Digits: [${this.filteredArray.join(', ')}]`);
        console.log(`  Traded Digits: [${this.tradedDigitArray.join(', ')}]`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ══════════════════════════════════════════════════════════════════════════
    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🚀 accumBotM — Enhanced Multi-Asset Accumulator Bot');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`  Assets:        ${this.assets.join(', ')}`);
        console.log(`  Initial Stake: $${this.config.initialStake}`);
        console.log(`  Multiplier:    x${this.config.multiplier}`);
        console.log(`  Growth Rate:   ${(this.config.growthRate * 100)}%`);
        console.log(`  Filter Num:    ${this.filterNum}`);
        console.log(`  Take Profit:   $${this.config.takeProfit}`);
        console.log(`  Stop Loss:     $${this.config.stopLoss}`);
        console.log('═══════════════════════════════════════════════════════════\n');

        this.connect();
        this.checkTimeForDisconnectReconnect();
        this.startTelegramTimer();
        StatePersistence.startAutoSave(this);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// BOT INITIALIZATION
// ══════════════════════════════════════════════════════════════════════════════
const bot = new EnhancedDerivTradingBot('DMylfkyce6VyZt7', {
    initialStake: 3,
    multiplier: 35,
    multiplier2: 8,
    maxConsecutiveLosses: 2,
    stopLoss: 108,
    takeProfit: 10000,
    growthRate: 0.03,
    takeProfitMultiplier: 0.03,
    filterNum: 4,
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    telegramChatId: '752497117',
});

bot.start();
