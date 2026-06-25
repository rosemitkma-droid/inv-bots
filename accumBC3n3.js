/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   accumBC3n4 — Adaptive Multi-Regime Accumulator Bot (AMRA)    ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  NOVEL STRATEGY — Adaptive Multi-Regime Accumulator:            ║
 * ║                                                                ║
 * ║  1. MARKET REGIME DETECTION:                                    ║
 * ║     Classifies each asset into Calm / Normal / Volatile         ║
 * ║     based on price volatility, tick velocity & stay-in trends   ║
 * ║                                                                ║
 * ║  2. ADAPTIVE GROWTH RATE:                                       ║
 * ║     Calm → 4% (narrower barriers, faster compounding)           ║
 * ║     Normal → 2% (wider barriers, higher survival)               ║
 * ║     Volatile → NO TRADE (wait for regime shift)                 ║
 * ║                                                                ║
 * ║  3. STATISTICAL TAKE-PROFIT:                                    ║
 * ║     Calculated from 25th percentile of recent tick survival     ║
 * ║     counts → high-probability target aligned with market stats  ║
 * ║                                                                ║
 * ║  4. SMART RECOVERY (Kelly-Inspired):                            ║
 * ║     Stake increase proportional to composite confidence score   ║
 * ║     Capped at maxRecoveryMultiplier (8x)                        ║
 * ║     Only increases when confidence > 0.55                       ║
 * ║                                                                ║
 * ║  5. CONFIDENCE SCORING ENGINE:                                  ║
 * ║     Each asset scored on: volatility regime, stay-in trend,     ║
 * ║     tick flow momentum, recent win rate, and price position     ║
 * ║     Only top-ranked assets with score > threshold are traded    ║
 * ║                                                                ║
 * ║  6. TICK FLOW MOMENTUM:                                         ║
 * ║     Tracks recent stay-in duration trend (green/red flow)       ║
 * ║     Enters only when recent contracts show improving survival   ║
 * ║                                                                ║
 * ║  7. DYNAMIC FILTER NUM:                                         ║
 * ║     Decreases after wins (more opportunities)                   ║
 * ║     Modestly increases after losses (slightly more selective)   ║
 * ║     Bounded between minFilterNum (3) and maxFilterNum (8)       ║
 * ║                                                                ║
 * ║  INFRASTRUCTURE (preserved from BC3n3):                         ║
 * ║  • Multi-asset concurrent support                               ║
 * ║  • PAT / OAuth OTP auth flow                                    ║
 * ║  • Telegram notifications                                       ║
 * ║  • State persistence with auto-save                             ║
 * ║  • Trade watchdog for stuck contract recovery                   ║
 * ║  • Robust reconnection with exponential backoff                 ║
 * ║  • WebSocket ping keep-alive                                    ║
 * ║  • Asset filtering (active/pending)                             ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ══════════════════════════════════════════════════════════════════════════════
// DERIV REST CLIENT  (for the PAT / OAuth OTP-based auth flow)
// ══════════════════════════════════════════════════════════════════════════════
class RestClient {
    constructor(baseUrl, appId, token) {
        this.baseUrl = baseUrl || 'https://api.derivws.com';
        this.appId = appId || '1089';
        this.token = token || '';
    }

    static isPat(token) {
        return typeof token === 'string'
            && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
    }

    _request(method, urlPath, body = null) {
        return new Promise((resolve, reject) => {
            let url;
            try { url = new URL(urlPath, this.baseUrl); }
            catch (e) { return reject(new Error(`Invalid URL: ${urlPath}`)); }
            const isHttps = url.protocol === 'https:';
            const lib = isHttps ? https : http;
            const opts = {
                method,
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                headers: {
                    'Deriv-App-ID': this.appId,
                    'Authorization': 'Bearer ' + this.token,
                    'Accept': 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                timeout: 15000,
            };
            const req = lib.request(opts, res => {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => {
                    let parsed = data;
                    try { parsed = JSON.parse(data); } catch (_) {}
                    resolve({ status: res.statusCode, body: parsed });
                });
            });
            req.on('timeout', () => { req.destroy(new Error('REST request timeout')); });
            req.on('error', reject);
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    get(p)       { return this._request('GET',  p); }
    post(p, b)   { return this._request('POST', p, b); }
    delete(p)    { return this._request('DELETE', p); }
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE PERSISTENCE MANAGER
// ══════════════════════════════════════════════════════════════════════════════
const STATE_FILE = path.join(__dirname, 'accumBC3n3_03_state.json');
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
                    Sys2: bot.Sys2,
                    filterNum: bot.filterNum,
                },
                assetMetrics: bot.assetMetrics,
                hourlyStats: bot.hourlyStats,
                assetRegimes: bot.assetRegimes,
                stayInStats: bot.stayInStats,
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
            return true;
        } catch (error) {
            console.error(`Failed to save state: ${error.message}`);
            return false;
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                console.log('No previous state found, starting fresh');
                return null;
            }
            const fileContent = fs.readFileSync(STATE_FILE, 'utf8');
            const savedData = JSON.parse(fileContent);
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;
            if (ageMinutes > 60) {
                console.warn(`Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                const backupFile = STATE_FILE.replace('.json', `_backup_${Date.now()}.json`);
                fs.renameSync(STATE_FILE, backupFile);
                return null;
            }
            console.log(`Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);
            return savedData;
        } catch (error) {
            console.error(`Failed to load state: ${error.message}`);
            return null;
        }
    }

    static startAutoSave(bot) {
        if (bot.autoSaveInterval) clearInterval(bot.autoSaveInterval);
        bot.autoSaveInterval = setInterval(() => {
            if (bot.connected && !bot.endOfDay) StatePersistence.saveState(bot);
        }, STATE_SAVE_INTERVAL);

        const exitHandler = () => {
            console.log('\nShutting down, saving final state...');
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

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS — Adaptive Multi-Regime Accumulator
// ══════════════════════════════════════════════════════════════════════════════
class AMRATradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // ── Auth state ─────────────────────────────────────────────────────
        this.appId = config.appId || '1089';
        this.accountType = (config.accountType || 'demo').toLowerCase();
        this._isPat = RestClient.isPat(token);
        this._rest = this._isPat
            ? new RestClient('https://api.derivws.com', this.appId, token)
            : null;
        this._otpUrl = null;
        this._targetAccount = null;
        this.accountInfo = null;

        // ── Multi-asset support ────────────────────────────────────────────
        this.assets = config.assets;

        // ── Asset Filtering System ─────────────────────────────────────────
        this.activeAssets = new Set();
        this.pendingAssets = new Set();
        this.assetStayedInValues = {};
        this.pendingScanInterval = null;

        // ══════════════════════════════════════════════════════════════════════
        // AMRA STRATEGY CONFIGURATION
        // ══════════════════════════════════════════════════════════════════════
        this.config = {
            // Position sizing
            initialStake: config.initialStake || 1,
            maxRecoveryMultiplier: config.maxRecoveryMultiplier || 8,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 10,
            takeProfit: config.takeProfit || 2500,
            stopLoss: config.stopLoss || 127,

            // Adaptive growth rates per regime
            growthRateCalm: config.growthRateCalm || 0.04,
            growthRateNormal: config.growthRateNormal || 0.02,
            growthRateVolatile: null,

            // Statistical take-profit
            takeProfitPercentile: config.takeProfitPercentile || 0.25,
            minTakeProfitTicks: config.minTakeProfitTicks || 3,
            maxTakeProfitTicks: config.maxTakeProfitTicks || 25,
            takeProfitMultiplierBase: config.takeProfitMultiplierBase || 0.12,

            // Confidence scoring
            minConfidenceThreshold: config.minConfidenceThreshold || 0.55,
            recoveryConfidenceThreshold: config.recoveryConfidenceThreshold || 0.50,

            // Dynamic filter
            minFilterNum: config.minFilterNum || 3,
            maxFilterNum: config.maxFilterNum || 8,
            filterNum: config.filterNum || 4,

            // Regime detection
            regimeLookback: config.regimeLookback || 50,
            volatilityHighThreshold: config.volatilityHighThreshold || 0.70,
            volatilityLowThreshold: config.volatilityLowThreshold || 0.35,

            // Tick flow
            tickFlowLookback: config.tickFlowLookback || 20,
            greenFlowThreshold: config.greenFlowThreshold || 0.55,

            // Asset filtering
            STAYED_IN_THRESHOLD: config.STAYED_IN_THRESHOLD || 600,
            scanTimer: config.scanTimer || 60000,

            // Reconnection
            maxReconnectAttempts: 50,
            reconnectDelay: 5000,

            // Trade throttle
            minTimeBetweenTrades: 5000,

            // History
            requiredHistoryLength: 100,
            analysisInterval: 1,

            // Telegram
            telegramToken: '8218636914:AAGvaKFh8MT769-_9eOEiU4XKufL0aHRhZ4',
            telegramChatId: '752497117',
        };

        // ── Trading state ──────────────────────────────────────────────────
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
        this.confidenceThreshold = this.config.minConfidenceThreshold;
        this.kTradeCount = 0;
        this.isWinTrade = false;
        this.waitTime = 150000;
        this.LossDigitsList = [];
        this.threeConsecutiveDigits = 0;
        this.predictedType = '';
        this.Sys1 = 0;
        this.Sys2 = false;
        this.tradedDigitArray = [];
        this.tradedDigitArray2 = [];
        this.filteredArray = [];
        this.tradeNum = Math.floor(Math.random() * (40 - 21 + 1)) + 21;
        this.filterNum = this.config.filterNum;
        this.Percentage = 0;
        this.predictedDigit = null;
        this.currentTick = 0;
        this.TP_SL = false;
        this.scanningTimer = this.config.scanTimer;

        // ── Multi-asset active trades ──────────────────────────────────────
        this.activeTrades = {};
        this.contractSubscriptions = {};
        this.tickSubscriptionIds = {};
        this.lastTradeTime = {};

        // ── Per-asset data stores ──────────────────────────────────────────
        this.priceHistories = {};
        this.tickHistory = {};
        this.lastDigitsList = {};
        this.tickCounts = {};
        this.assetStates = {};

        // ── AMRA-specific state ────────────────────────────────────────────
        this.assetRegimes = {};          // { asset: 'calm'|'normal'|'volatile' }
        this.assetConfidenceScores = {}; // { asset: 0.0-1.0 }
        this.stayInStats = {};           // { asset: { median, p25, p75, mean, greenFlow } }
        this.priceVelocity = {};         // { asset: moving average of abs(price change) }
        this.recentTradeOutcomes = {};   // { asset: [{ticksSurvived, won}] }
        this.assetMetrics = {};          // { asset: { trades, wins, losses, profitLoss } }

        // ── Asset suspension ───────────────────────────────────────────────
        this.suspendedAssets = new Set();
        this.focusAsset = null;

        // ── Telegram ───────────────────────────────────────────────────────
        this.telegramBot = null;
        if (this.config.telegramToken && this.config.telegramChatId) {
            this.telegramBot = new TelegramBot(this.config.telegramToken, { polling: false });
        }
        this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0 };

        // ── Reconnection ───────────────────────────────────────────────────
        this.reconnectAttempts = 0;
        this.pingInterval = null;

        // ── Trade Watchdog ─────────────────────────────────────────────────
        this.tradeWatchdogTimer = null;
        this.tradeWatchdogPollTimer = null;
        this.tradeWatchdogMs = 120000;
        this.tradeStartTime = null;

        // ── Initialize per-asset structures ────────────────────────────────
        this.assets.forEach(asset => {
            this.priceHistories[asset] = [];
            this.tickHistory[asset] = [];
            this.lastDigitsList[asset] = [];
            this.tickCounts[asset] = 0;
            this.lastTradeTime[asset] = 0;
            this.assetStates[asset] = { proposalId: null, lastProposalAt: 0 };
            this.assetMetrics[asset] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
            this.assetRegimes[asset] = 'normal';
            this.assetConfidenceScores[asset] = 0.5;
            this.stayInStats[asset] = { median: 10, p25: 5, p75: 18, mean: 12, greenFlow: 0.5 };
            this.priceVelocity[asset] = 0;
            this.recentTradeOutcomes[asset] = [];

            this.pendingAssets.add(asset);
            this.assetStayedInValues[asset] = null;
        });

        this.loadSavedState();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // UTILITY FUNCTIONS
    // ══════════════════════════════════════════════════════════════════════════
    calculateTotalStayedIn(stayedInArray) {
        if (!stayedInArray || !Array.isArray(stayedInArray)) return 0;
        return stayedInArray.reduce((sum, value) => sum + (value || 0), 0);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // MARKET REGIME DETECTION
    // ══════════════════════════════════════════════════════════════════════════
    /**
     * Classify the current market regime for an asset.
     * Uses price velocity and stay-in duration trends.
     *
     * Regimes:
     *   'calm'    — Low price movement, long stay-in durations → IDEAL for ACCU
     *   'normal'  — Moderate movement, moderate durations → OK for conservative ACCU
     *   'volatile'— High movement, short durations → AVOID
     */
    detectMarketRegime(asset) {
        const prices = this.priceHistories[asset];
        const stayedInArray = this.assetStayedInArrays?.[asset];
        const stayStats = this.stayInStats[asset];

        if (!prices || prices.length < 30) return this.assetRegimes[asset] || 'normal';

        // ── 1. Price Velocity (normalized volatility proxy) ─────────────────
        const recentPrices = prices.slice(-30);
        let totalAbsChange = 0;
        for (let i = 1; i < recentPrices.length; i++) {
            totalAbsChange += Math.abs(recentPrices[i] - recentPrices[i - 1]);
        }
        const avgPriceChange = totalAbsChange / (recentPrices.length - 1);
        const avgPrice = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
        const normalizedVelocity = avgPrice > 0 ? avgPriceChange / avgPrice : 0;

        // Smooth velocity
        const prevVelocity = this.priceVelocity[asset] || normalizedVelocity;
        const smoothedVelocity = prevVelocity * 0.7 + normalizedVelocity * 0.3;
        this.priceVelocity[asset] = smoothedVelocity;

        // ── 2. Stay-in duration trend ──────────────────────────────────────
        const greenFlow = stayStats?.greenFlow || 0.5;
        const medianStay = stayStats?.median || 10;

        // ── 3. Recent stay-in array values (last 5 ticks) ──────────────────
        let stayInTrend = 0;
        if (stayedInArray && stayedInArray.length >= 5) {
            const last5 = stayedInArray.slice(-5);
            for (let i = 1; i < last5.length; i++) {
                stayInTrend += (last5[i] - last5[i - 1]);
            }
            stayInTrend = stayInTrend / 4;
        }

        // ── 4. Classify regime ─────────────────────────────────────────────
        const highVol = this.config.volatilityHighThreshold;
        const lowVol = this.config.volatilityLowThreshold;

        if (smoothedVelocity > highVol || (medianStay < 5 && greenFlow < 0.35)) {
            return 'volatile';
        } else if (smoothedVelocity < lowVol && greenFlow > 0.55 && medianStay >= 8) {
            return 'calm';
        } else {
            return 'normal';
        }
    }

    /**
     * Update regime for a specific asset and log changes.
     */
    updateMarketRegime(asset) {
        const prevRegime = this.assetRegimes[asset];
        const newRegime = this.detectMarketRegime(asset);
        this.assetRegimes[asset] = newRegime;
        this.trade = false;


        if (prevRegime !== newRegime) {
            const emoji = newRegime === 'calm' ? '🟢' : newRegime === 'normal' ? '🟡' : '🔴';
            console.log(`${emoji} ${asset} regime: ${prevRegime} → ${newRegime} (velocity: ${this.priceVelocity[asset]?.toExponential(3)})`);
            if(prevRegime === 'normal' && newRegime === 'calm') {
                this.trade = true;
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STATISTICAL ANALYSIS
    // ══════════════════════════════════════════════════════════════════════════
    /**
     * Update stay-in statistics for an asset from the stayedInArray.
     * This is the statistical backbone — it computes:
     *   - median, p25, p75 stay-in durations
     *   - green flow ratio (fraction of ticks with "good" survival)
     *   - survival trend
     */
    updateStayInStats(asset, stayedInArray) {
        if (!stayedInArray || stayedInArray.length < 20) return;

        // Sort values to compute percentiles
        const sorted = [...stayedInArray].sort((a, b) => a - b);
        const n = sorted.length;

        const median = n % 2 === 0
            ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
            : sorted[Math.floor(n / 2)];

        const p25Index = Math.floor(n * 0.25);
        const p75Index = Math.floor(n * 0.75);
        const p25 = sorted[p25Index];
        const p75 = sorted[p75Index];
        const mean = stayedInArray.reduce((a, b) => a + b, 0) / n;

        // Green flow: fraction of values above the median of their local window
        const recentWindow = stayedInArray.slice(-this.config.tickFlowLookback);
        const windowMedian = [...recentWindow].sort((a, b) => a - b)[Math.floor(recentWindow.length / 2)];
        const greenCount = recentWindow.filter(v => v >= windowMedian).length;
        const greenFlow = greenCount / recentWindow.length;

        // Trend: are recent values rising or falling?
        const olderHalf = recentWindow.slice(0, Math.floor(recentWindow.length / 2));
        const newerHalf = recentWindow.slice(-Math.floor(recentWindow.length / 2));
        const olderMean = olderHalf.reduce((a, b) => a + b, 0) / olderHalf.length;
        const newerMean = newerHalf.reduce((a, b) => a + b, 0) / newerHalf.length;

        this.stayInStats[asset] = {
            median,
            p25,
            p75,
            mean,
            greenFlow,
            trend: newerMean - olderMean,
            windowMedian,
        };
    }

    /**
     * Calculate the statistically optimal take-profit (in number of ticks).
     * Uses the 25th percentile of recent stay-in durations →
     * this is a conservative target that ~75% of recent trades reached.
     */
    calculateStatisticalTakeProfit(asset) {
        const stats = this.stayInStats[asset];
        if (!stats) return this.config.minTakeProfitTicks;

        const percentile = this.config.takeProfitPercentile;
        const targetTicks = Math.max(
            this.config.minTakeProfitTicks,
            Math.min(
                this.config.maxTakeProfitTicks,
                Math.round(stats.p25)
            )
        );

        return targetTicks;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CONFIDENCE SCORING ENGINE
    // ══════════════════════════════════════════════════════════════════════════
    /**
     * Compute a composite confidence score (0.0–1.0) for trading an asset.
     *
     * Score components (each 0–1, equally weighted):
     *   1. Regime bonus: calm=0.9, normal=0.5, volatile=0.0
     *   2. Green flow: normalized greenFlow ratio
     *   3. Stay-in trend: rising trend = bonus
     *   4. Recent win rate on this asset
     *   5. Price position: is price near middle of recent range?
     */
    computeConfidenceScore(asset) {
        const regime = this.assetRegimes[asset];
        const stats = this.stayInStats[asset];
        const metrics = this.assetMetrics[asset];

        // 1. Regime score
        const regimeScore = regime === 'calm' ? 0.9 : regime === 'normal' ? 0.5 : 0.0;

        // 2. Green flow score (0–1)
        const greenFlow = stats?.greenFlow || 0.5;
        const flowScore = greenFlow;

        // 3. Trend score: normalize trend to 0–1 range
        const trend = stats?.trend || 0;
        const trendScore = Math.min(1, Math.max(0, 0.5 + trend * 0.1));

        // 4. Win rate score
        const assetTrades = (metrics?.trades || 0);
        const assetWins = (metrics?.wins || 0);
        let winRateScore = 0.5;
        if (assetTrades >= 3) {
            winRateScore = assetWins / assetTrades;
        }

        // 5. Price position: how close to recent range midpoint?
        const prices = this.priceHistories[asset];
        let positionScore = 0.5;
        if (prices && prices.length >= 20) {
            const recentPrices = prices.slice(-20);
            const high = Math.max(...recentPrices);
            const low = Math.min(...recentPrices);
            const range = high - low;
            if (range > 0) {
                const current = recentPrices[recentPrices.length - 1];
                const midRange = (high + low) / 2;
                const distanceFromMid = Math.abs(current - midRange) / (range / 2);
                positionScore = 1 - Math.min(1, distanceFromMid);
            }
        }

        // Composite: equal-weighted average
        const composite = (
            regimeScore * 0.30 +
            flowScore * 0.25 +
            trendScore * 0.15 +
            winRateScore * 0.15 +
            positionScore * 0.15
        );

        this.assetConfidenceScores[asset] = composite;
        return composite;
    }

    /**
     * Rank all allowed assets by confidence score.
     * Returns array of [asset, score] sorted highest first.
     */
    rankAssets() {
        const ranked = this.assets
            .filter(asset => this.isAssetAllowed(asset))
            .map(asset => [asset, this.assetConfidenceScores[asset] || 0])
            .sort((a, b) => b[1] - a[1]);

        return ranked;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTELLIGENT ASSET FILTERING
    // ══════════════════════════════════════════════════════════════════════════
    updateAssetStatus(asset, stayedInArray) {
        const totalStayedIn = this.calculateTotalStayedIn(stayedInArray);
        this.assetStayedInValues[asset] = totalStayedIn;

        const wasActive = this.activeAssets.has(asset);

        if (totalStayedIn > this.config.STAYED_IN_THRESHOLD) {
            if (!wasActive) {
                this.activeAssets.add(asset);
                this.pendingAssets.delete(asset);
                console.log(`ACTIVE: ${asset} (stayedIn: ${totalStayedIn})`);
            }
        } else {
            if (wasActive) {
                this.pendingAssets.add(asset);
                this.activeAssets.delete(asset);
                console.log(`PENDING: ${asset} (stayedIn: ${totalStayedIn})`);
            }
        }
    }

    isAssetReady(asset) {
        return this.activeAssets.has(asset);
    }

    startPendingAssetScan() {
        if (this.pendingScanInterval) clearInterval(this.pendingScanInterval);

        const scanningTimer = this.scanningTimer;

        this.pendingScanInterval = setInterval(() => {
            if (!this.wsReady || this.pendingAssets.size === 0) return;

            console.log(`\nScanning ${this.pendingAssets.size} pending assets...`);

            this.pendingAssets.forEach(asset => {
                if (this.activeTrades[asset]) return;
                this.requestProposalForScan(asset);
            });
        }, scanningTimer);

        console.log('Pending asset scanner started (interval: ' + scanningTimer / 1000 + 's)');
    }

    _proposalSymbolKey() {
        return this._isPat ? 'underlying_symbol' : 'symbol';
    }

    requestProposalForScan(asset) {
        if (!this.wsReady) return;

        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            [this._proposalSymbolKey()]: asset,
            growth_rate: this.config.growthRateNormal,
            limit_order: {
                take_profit: (this.currentStake * 0.05).toFixed(2)
            },
            passthrough: {
                action: 'scan_only',
                asset: asset,
                timestamp: Date.now()
            }
        };

        this.sendRequest(proposal);
    }

    getAssetFilteringSummary() {
        const activeList = Array.from(this.activeAssets).map(asset => {
            const value = this.assetStayedInValues[asset];
            const regime = this.assetRegimes[asset] || '?';
            return `${asset}(${value !== null ? value : '?'}|${regime})`;
        }).join(', ');

        const pendingList = Array.from(this.pendingAssets).map(asset => {
            const value = this.assetStayedInValues[asset];
            return `${asset}(${value !== null ? value : '?'})`;
        }).join(', ');

        return `\nAsset Status:\n` +
               `   Active (${this.activeAssets.size}): ${activeList || 'None'}\n` +
               `   Pending (${this.pendingAssets.size}): ${pendingList || 'None'}`;
    }

    stopPendingAssetScan() {
        if (this.pendingScanInterval) {
            clearInterval(this.pendingScanInterval);
            this.pendingScanInterval = null;
            console.log('Pending asset scanner stopped');
        }
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
        console.log(`SUSPENDED: All assets except ${lossAsset}. Focusing on recovery.`);
    }

    resumeAllAssets() {
        const prevFocus = this.focusAsset;
        this.suspendedAssets.clear();
        this.focusAsset = null;
        if (prevFocus) {
            console.log(`RESUMED: All assets active again (was focused on ${prevFocus})`);
        }
    }

    isAssetAllowed(asset) {
        if (!this.focusAsset) return true;
        return asset === this.focusAsset;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SMART RECOVERY — KELLY-INSPIRED POSITION SIZING
    // ══════════════════════════════════════════════════════════════════════════
    /**
     * Calculate the recovery stake based on:
     *   1. Composite confidence score
     *   2. Current consecutive losses
     *   3. Capped at maxRecoveryMultiplier
     *
     * Formula:
     *   recoveryStake = initialStake * min(maxMultiplier, 1 + losses * confidence^2)
     *
     * When confidence is HIGH (>0.7): aggressive recovery (up to 8x)
     * When confidence is MED (0.55-0.7): moderate recovery (up to 3x)
     * When confidence is LOW (<0.55): no recovery increase (flat 1x)
     */
    calculateSmartRecoveryStake() {
        const base = this.config.initialStake;
        const maxMult = this.config.maxRecoveryMultiplier;

        if (this.consecutiveLosses === 0) return base;

        // Get the best confidence score among top-ranked allowed assets
        const ranked = this.rankAssets();
        const bestScore = ranked.length > 0 ? ranked[0][1] : 0.5;

        if (bestScore < this.config.recoveryConfidenceThreshold) {
            // Low confidence: do NOT increase stake
            console.log(`   Smart Recovery: score ${bestScore.toFixed(2)} < ${this.config.recoveryConfidenceThreshold}, keeping base stake`);
            return base;
        }

        // Confidence-weighted multiplier
        const confidenceFactor = bestScore * bestScore;
        const lossFactor = Math.min(this.consecutiveLosses, 6);
        const rawMultiplier = 1 + lossFactor * confidenceFactor;

        const cappedMultiplier = Math.min(maxMult, rawMultiplier);
        const recoveryStake = Math.ceil(base * cappedMultiplier * 100) / 100;

        console.log(`   Smart Recovery: conf=${bestScore.toFixed(2)} losses=${this.consecutiveLosses} → ${cappedMultiplier.toFixed(1)}x = $${recoveryStake.toFixed(2)}`);

        return recoveryStake;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DYNAMIC FILTER NUMBER
    // ══════════════════════════════════════════════════════════════════════════
    /**
     * filterNum determines how "rare" a digit occurrence must be to trigger entry.
     * Lower = more entries, Higher = fewer but higher "quality" entries.
     *
     * Strategy: decrease after wins (cast wider net), modestly increase after losses.
     */
    adjustFilterNum(won) {
        const min = this.config.minFilterNum;
        const max = this.config.maxFilterNum;

        if (won) {
            this.filterNum = Math.max(min, this.filterNum - 1);
        } else {
            this.filterNum = Math.min(max, this.filterNum + 1);
        }
        console.log(`   filterNum adjusted to: ${this.filterNum} (${won ? 'decreased' : 'increased'})`);
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
                this.Sys2 = state.trading.Sys2 || false;
                this.filterNum = state.trading.filterNum || this.config.filterNum;
            }
            if (state.assetMetrics) this.assetMetrics = state.assetMetrics;
            if (state.hourlyStats) this.hourlyStats = state.hourlyStats;
            if (state.assetRegimes) this.assetRegimes = state.assetRegimes;
            if (state.stayInStats) this.stayInStats = state.stayInStats;
            console.log(`State restored: ${this.totalTrades} trades, P&L: $${this.totalProfitLoss.toFixed(2)}`);
        } catch (error) {
            console.error(`Error restoring state: ${error.message}`);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // WEBSOCKET CONNECTION + PING KEEP-ALIVE
    // ══════════════════════════════════════════════════════════════════════════
    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        if (!this.token) {
            console.error('DERIV_API_TOKEN is empty — aborting');
            return;
        }
        console.log('Connecting to Deriv API...');
        this.cleanup();

        if (this._isPat) {
            console.log('PAT token detected → using NEW Deriv API (OTP flow)');
            this._newApiConnect().catch(err => {
                console.error('New API connect failed:', err.message);
                this.handleDisconnect();
            });
        } else {
            console.log('Using legacy Deriv API (token authorize flow)');
            const url = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(this.appId)}`;
            this._openWs(url);
        }
    }

    _openWs(url) {
        try {
            this.ws = new WebSocket(url, {
                headers: { 'User-Agent': 'AMRA-Bot/4.0 (+Node.js)' },
                handshakeTimeout: 15000,
            });
        } catch (e) {
            console.error('WS construct failed:', e.message);
            this.handleDisconnect();
            return;
        }

        this.ws.on('open', () => {
            console.log('WebSocket connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.startPingKeepAlive();

            if (this._isPat) {
                this._newApiMarkAuthorized();
            } else {
                this.authenticate();
            }
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
            console.log('WebSocket disconnected');
            this.stopPingKeepAlive();
            this.handleDisconnect();
        });

        this.ws.on('unexpected-response', (_req, res) => {
            console.error(`WS handshake failed: ${res.statusCode} ${res.statusMessage}`);
            try { res.destroy(); } catch (_) {}
            this.handleDisconnect();
        });
    }

    async _newApiConnect() {
        console.log('REST: GET /trading/v1/options/accounts');
        const accRes = await this._rest.get('/trading/v1/options/accounts');
        if (accRes.status !== 200) {
            const msg = accRes.body?.errors?.[0]?.message
                || accRes.body?.message
                || JSON.stringify(accRes.body);
            let hint = '';
            if (accRes.status === 401) {
                hint = ' — check PAT validity and appId registration at https://developers.deriv.com/';
            } else if (accRes.status === 403) {
                hint = ' — PAT may lack required "trade" scope (regenerate at https://app.deriv.com/account/api-token)';
            } else if (accRes.status === 404) {
                hint = ' — accounts endpoint not found; token may be legacy';
            }
            throw new Error(`Account list failed (${accRes.status}): ${msg}${hint}`);
        }
        const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
        if (!accounts.length) throw new Error('No Options accounts found for this token');

        const acct = accounts.find(a => (a.account_type || '').toLowerCase() === this.accountType)
                  || accounts[0];
        this._targetAccount = acct;
        this.accountInfo = {
            loginid    : acct.account_id,
            email      : acct.email,
            isVirtual  : (acct.account_type || '').toLowerCase() === 'demo',
            accountType: acct.account_type,
            currency   : acct.currency,
            balance    : parseFloat(acct.balance),
            group      : acct.group,
        };
        console.log(`Selected account ${acct.account_id} (${acct.account_type}, ${acct.currency}, balance=${acct.balance})`);

        const otpPath = `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`;
        console.log(`REST: POST ${otpPath}`);
        const otpRes = await this._rest.post(otpPath);
        if (otpRes.status !== 200) {
            const msg = otpRes.body?.errors?.[0]?.message || JSON.stringify(otpRes.body);
            throw new Error(`OTP request failed (${otpRes.status}): ${msg}`);
        }
        const wsUrl = otpRes.body?.data?.url;
        if (!wsUrl || !/^wss?:/i.test(wsUrl)) {
            throw new Error(`OTP response missing .data.url: ${JSON.stringify(otpRes.body)}`);
        }
        this._otpUrl = wsUrl;
        this._openWs(wsUrl);
    }

    _newApiMarkAuthorized() {
        if (!this.accountInfo) return;
        console.log(
            `Authenticated ${this.accountInfo.loginid} ` +
            `(${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) ` +
            `balance=${this.accountInfo.balance} ${this.accountInfo.currency} via PAT/new-API`
        );
        this.wsReady = true;
        this.initializeSubscriptions();
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
            console.error('Max reconnection attempts reached');
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(this.config.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        console.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s... (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    cleanup() {
        this.stopPingKeepAlive();
        this.stopPendingAssetScan();
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
        console.log('Disconnecting...');
        StatePersistence.saveState(this);
        this.cleanup();
        console.log('Bot disconnected');
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
        console.log(`Authenticated | Balance: $${message.authorize.balance}`);
        this.wsReady = true;
        this.initializeSubscriptions();
    }

    initializeSubscriptions() {
        console.log('Subscribing to tick streams for all assets...');
        this.assets.forEach(asset => {
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });
            this.sendRequest({
                ticks: asset,
                subscribe: 1
            });
        });

        this.startPendingAssetScan();
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

        console.log(`Hourly summaries scheduled. First in ${Math.ceil(timeUntilNextHour / 60000)} minutes.`);
    }

    async sendHourlySummary() {
        const winRate = this.totalTrades > 0
            ? (this.totalWins / this.totalTrades * 100).toFixed(1)
            : '0.0';
        const pnlEmoji = this.totalProfitLoss >= 0 ? '🟢' : '🔴';
        const pnlStr = (this.totalProfitLoss >= 0 ? '+' : '') + '$' + Math.abs(this.totalProfitLoss).toFixed(2);

        // Regime summary
        const regimeSummary = this.assets.map(a => {
            const r = this.assetRegimes[a] || '?';
            const emoji = r === 'calm' ? '🟢' : r === 'normal' ? '🟡' : '🔴';
            return `${emoji}${a}`;
        }).join(' ');

        await this.sendTelegramMessage(
            `<b>AMRA Bot — Session Summary</b>\n\n` +
            `Trades: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalLosses}\n` +
            `Win Rate: ${winRate}%\n` +
            `${pnlEmoji} Total P&L: ${pnlStr}\n` +
            `Current Stake: $${this.currentStake.toFixed(2)}\n` +
            `Consecutive Losses: ${this.consecutiveLosses}\n` +
            `Filter: ${this.filterNum}\n\n` +
            `<b>Regimes:</b>\n${regimeSummary}\n\n` +
            `${new Date().toLocaleTimeString()}`
        );
    }

    async sendDisconnectSummary() {
        await this.sendTelegramMessage(
            `<b>AMRA Bot Disconnected</b>\n\n` +
            `Total Trades: ${this.totalTrades}\n` +
            `Wins: ${this.totalWins} | Losses: ${this.totalLosses}\n` +
            `x2-x6 Losses: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4} | ${this.consecutiveLosses5} | ${this.consecutiveLosses6}\n` +
            `Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00'}%\n` +
            `Total P&L: $${this.totalProfitLoss.toFixed(2)}`
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TICK HISTORY & LIVE TICK HANDLING
    // ══════════════════════════════════════════════════════════════════════════
    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['BOOM150N', 'CRASH150N'].includes(asset)) {
            return fractionalPart.length >= 5 ? parseInt(fractionalPart[4]) : 0;
        } else if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', 'BOOM50',
            'BOOM300N',  'BOOM500',   'BOOM600',   'BOOM900',
            'BOOM1000',  'CRASH50',   'CRASH300N',
            'CRASH500',  'CRASH600',  'CRASH900',  'CRASH1000'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    handleTickHistory(message) {
        const asset = message.echo_req.ticks_history;
        const history = message.history;

        this.priceHistories[asset] = history.prices.map(p => parseFloat(p));
        this.tickHistory[asset] = history.prices.map(p => this.getLastDigit(p, asset));

        console.log(`${asset}: Loaded ${this.priceHistories[asset].length} price ticks | ${this.tickHistory[asset].length} digits`);
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

        if (!this.wsReady) return;
        if (this.activeTrades[asset]) return;
        if (this.tickHistory[asset].length < this.config.requiredHistoryLength) return;

        if (!this.isAssetAllowed(asset)) return;
        if (!this.isAssetReady(asset) && asset !== this.focusAsset) return;
        if (Date.now() - (this.lastTradeTime[asset] || 0) < this.config.minTimeBetweenTrades) return;

        // Update regime every 10 ticks
        // if (this.tickCounts[asset] % 10 === 0) {
            this.updateMarketRegime(asset);
        // }

        this.evaluateAndTrade(asset);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TRADE ANALYSIS & EXECUTION — AMRA Strategy
    // ══════════════════════════════════════════════════════════════════════════
    evaluateAndTrade(asset) {
        if (!this.isAssetAllowed(asset)) return;

        // Check market regime — don't trade in volatile regime
        const regime = this.assetRegimes[asset];
        if (regime === 'volatile') {
            if (this.tickCounts[asset] % 50 === 0) {
                console.log(`${asset} in VOLATILE regime — skipping`);
            }
            return;
        }

        // Request proposal for analysis
        this.requestProposal(asset);
    }

    requestProposal(asset) {
        if (this.tradeInProgress) return;
        if (!this.wsReady) return;
        if (!this.isAssetAllowed(asset)) return;

        // Determine growth rate based on regime
        const regime = this.assetRegimes[asset];
        let growthRate;
        if (regime === 'calm') {
            growthRate = this.config.growthRateCalm;
        } else if (regime === 'normal') {
            growthRate = this.config.growthRateNormal;
        } else {
            return; // volatile — no trade
        }

        // Calculate take-profit using smart recovery (confidence-based) or statistical
        const statTicks = this.calculateStatisticalTakeProfit(asset);
        const stats = this.stayInStats[asset];

        // Take-profit based on statistical analysis: expected profit at p25 survival
        const stakeForTP = this.consecutiveLosses > 0
            ? this.calculateSmartRecoveryStake()
            : this.currentStake;

        const tpMultiplier = this.config.takeProfitMultiplierBase;

        const proposal = {
            proposal: 1,
            amount: stakeForTP.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            [this._proposalSymbolKey()]: asset,
            growth_rate: growthRate,
            limit_order: {
                take_profit: (stakeForTP * tpMultiplier).toFixed(2)
            }
        };

        this.sendRequest(proposal);
    }

    handleProposal(message) {
        const asset = message.echo_req?.symbol || message.echo_req?.underlying_symbol;

        if (message.error) {
            if (asset && this.activeTrades[asset]?.status === 'requesting_proposal') {
                console.log(`Proposal rejected for ${asset}: ${message.error.message}`);
                delete this.activeTrades[asset];
                this.tradeInProgress = false;
            }
            return;
        }

        if (!message.proposal) return;
        if (!asset) return;

        const proposal = message.proposal;
        const stayedInArray = proposal.contract_details.ticks_stayed_in;

        if (!stayedInArray) return;

        // Passthrough actions (scan_only, get_final_stayed_in) — handle first
        const passthrough = message.echo_req?.passthrough;

        if (passthrough?.action === 'scan_only') {
            this.updateAssetStatus(asset, stayedInArray);
            this.updateStayInStats(asset, stayedInArray);
            const totalStayedIn = this.calculateTotalStayedIn(stayedInArray);
            console.log(`   Scan ${asset}: stayedIn=${totalStayedIn} regime=${this.assetRegimes[asset] || '?'}`);
            return;
        }

        if (passthrough?.action === 'get_final_stayed_in') {
            console.log(`Final stayedInArray for ${asset}: [${stayedInArray.slice(-6).join('|')}]`);

            if (!this.assetStayedInArrays) this.assetStayedInArrays = {};
            this.assetStayedInArrays[asset] = stayedInArray;
            this.stayedInArray = stayedInArray;

            const trade = this.activeTrades[asset];
            if (trade && trade.awaitingFinalStayedIn && trade.settledContract) {
                trade.awaitingFinalStayedIn = false;
                this.handleTradeResult(asset, trade.settledContract);
            }
            return;
        }

        // Hard gate for suspended assets
        if (!this.isAssetAllowed(asset)) {
            console.log(`${asset} is suspended — ignoring proposal`);
            return;
        }

        // Update asset status and statistics
        this.updateAssetStatus(asset, stayedInArray);
        this.updateStayInStats(asset, stayedInArray);
        this.updateMarketRegime(asset);

        this.stayedInArray = stayedInArray;
        const stayedInArray2 = stayedInArray.slice(-6);

        if (!this.assetStayedInArrays) this.assetStayedInArrays = {};
        this.assetStayedInArrays[asset] = stayedInArray;

        if (this.tradeInProgress) return;

        // Check regime: only trade in calm or normal
        const regime = this.assetRegimes[asset];
        if (regime === 'volatile') return;

        // Asset readiness check
        if (!this.isAssetReady(asset) && asset !== this.focusAsset) {
            console.log(`${asset} is in pending list, skipping trade analysis`);
            return;
        }

        // ── Compute confidence score ────────────────────────────────────────
        const confidenceScore = this.computeConfidenceScore(asset);

        const threshold = this.consecutiveLosses > 0
            ? this.config.recoveryConfidenceThreshold
            : this.config.minConfidenceThreshold;

        // ── Digit frequency analysis (from original strategy, enhanced) ─────
        const currentDigitCount = stayedInArray[99] + 1;
        this.currentTick = stayedInArray[99];
        this.assetStates[asset].proposalId = proposal.id;

        const digitFrequency = {};
        stayedInArray.forEach(digit => {
            digitFrequency[digit] = (digitFrequency[digit] || 0) + 1;
        });

        const appearedOnceArray = Object.keys(digitFrequency)
            .filter(digit => digitFrequency[digit] === this.filterNum)
            .map(Number);

        // ── AMRA Entry Conditions ───────────────────────────────────────────
        // Condition A: Original stay-in pattern (price exhaustion signal)
        const conditionA = (
            stayedInArray[99] <= 0 &&
            stayedInArray[98] > stayedInArray[97] &&
            stayedInArray[97] > stayedInArray[96]
        );

        // Condition B: Total stayedIn exceeds threshold (enough data collected)
        const totalStayedIn = this.calculateTotalStayedIn(stayedInArray);
        this.totalStayedInArray = totalStayedIn;
        this.maxTotalStayedIn = this.config.STAYED_IN_THRESHOLD;
        
        const conditionB = totalStayedIn > this.config.STAYED_IN_THRESHOLD;

        // Condition C: Statistical confirmation — green flow + trend
        const stats = this.stayInStats[asset];
        const conditionC = stats && stats.greenFlow >= this.config.greenFlowThreshold;

        // Condition D: Confidence score exceeds threshold
        const conditionD = confidenceScore >= threshold;

        // Condition E: Last 6 stayed-in values sum < 160 (short-term range check)
        const totalLast6 = stayedInArray2.reduce((a, b) => a + b, 0);
        this.totalStayedInArray2 = totalLast6;
        this.maxTotalStayedIn2 = 160;
        const conditionE = totalLast6 < 160;

        // ── Decision ────────────────────────────────────────────────────────
        const primaryConditions = conditionA && conditionB;
        const confirmationConditions = conditionC && conditionE;
        const finalEntry = primaryConditions && (confirmationConditions || conditionD);

        console.log(`\n   AMRA Entry Signal: ${asset}`);
        console.log(`   Regime: ${regime} | Confidence: ${confidenceScore.toFixed(2)} | Filter: ${this.filterNum}`);
        console.log(`   A(stayIn pattern): ${conditionA || 'NA'} | B(total>${this.config.STAYED_IN_THRESHOLD}): ${conditionB}`);
        console.log(`   C(greenFlow): ${conditionC || 'NA'} | D(conf>${threshold}): ${conditionD || 'NA'} | E(last6<160): ${conditionE || 'NA'}`);
        console.log(`   stayIn trend: ${stats?.trend?.toFixed(2) || '?'} | p25: ${stats?.p25 || '?'} | greenFlow: ${stats?.greenFlow?.toFixed(2) || '?'}`);


        if (this.trade && conditionC && conditionD && conditionE) {
            console.log(`\n   AMRA Entry Signal: ${asset}`);
            console.log(`   Regime: ${regime} | Confidence: ${confidenceScore.toFixed(2)} | Filter: ${this.filterNum}`);
            console.log(`   A(stayIn pattern): ${conditionA} | B(total>${this.config.STAYED_IN_THRESHOLD}): ${conditionB}`);
            console.log(`   C(greenFlow): ${conditionC} | D(conf>${threshold}): ${conditionD} | E(last6<160): ${conditionE}`);
            console.log(`   stayIn trend: ${stats?.trend?.toFixed(2) || '?'} | p25: ${stats?.p25 || '?'} | greenFlow: ${stats?.greenFlow?.toFixed(2) || '?'}`);

            this.tradedDigitArray.push(stayedInArray[99]);
            this.filteredArray = appearedOnceArray;

            console.log(`   Traded Digit Array: [${this.tradedDigitArray.join(', ')}]`);

            const growthRate = regime === 'calm'
                ? this.config.growthRateCalm
                : this.config.growthRateNormal;

            console.log(`   Growth Rate: ${(growthRate * 100).toFixed(0)}% | Stake: $${(this.consecutiveLosses > 0 ? this.calculateSmartRecoveryStake() : this.currentStake).toFixed(2)}`);
            console.log(`   Statistical TP target: ${this.calculateStatisticalTakeProfit(asset)} ticks`);

            this.placeTrade(asset);
        }
    }

    placeTrade(asset) {
        if (this.tradeInProgress) return;

        const proposalId = this.assetStates[asset]?.proposalId;
        if (!proposalId) {
            console.error(`No valid proposal ID for ${asset}`);
            return;
        }

        // Set stake: use smart recovery if in loss streak
        if (this.consecutiveLosses > 0) {
            this.currentStake = this.calculateSmartRecoveryStake();
        }

        console.log(`\nPLACING TRADE: ${asset}`);
        console.log(`   Proposal ID: ${proposalId}`);
        console.log(`   Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`   Regime: ${this.assetRegimes[asset]} | Confidence: ${this.assetConfidenceScores[asset]?.toFixed(2)}`);
        console.log(`   Growth Rate: ${(this.assetRegimes[asset] === 'calm' ? this.config.growthRateCalm : this.config.growthRateNormal) * 100}%`);

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
            regime: this.assetRegimes[asset],
            confidence: this.assetConfidenceScores[asset],
        };

        const trade = this.activeTrades[asset];
        const regime = this.assetRegimes[asset];

        this.sendTelegramMessage(
            `<b>TRADE OPENED — AMRA</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Regime: ${regime === 'calm' ? '🟢 Calm' : '🟡 Normal'}\n` +
            `Confidence: ${this.assetConfidenceScores[asset]?.toFixed(2) || '?'}\n` +
            `Stake: $${trade.stake.toFixed(2)}\n` +
            `Growth Rate: ${(regime === 'calm' ? this.config.growthRateCalm : this.config.growthRateNormal) * 100}%\n` +
            `stayedIn: [${this.stayedInArray[99]}|${this.stayedInArray[98]}|${this.stayedInArray[97]}|${this.stayedInArray[96]}|${this.stayedInArray[95]}|${this.stayedInArray[94]}]\n` +
            `Total Sum: ${this.totalStayedInArray}/${this.maxTotalStayedIn} | Last6: ${this.totalStayedInArray2}/${this.maxTotalStayedIn2}`
        );

        this.lastTradeTime[asset] = Date.now();
    }

    handleBuyResponse(message) {
        const asset = this.findAssetByStatus('buying');

        if (message.error) {
            console.error(`Buy error: ${message.error.message}`);
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

        console.log(`Contract opened: ${contractId} on ${asset}`);

        trade.status = 'active';
        trade.contractId = contractId;
        trade.buyPrice = parseFloat(message.buy.buy_price);

        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });

        this.tradeStartTime = Date.now();
        this._startTradeWatchdog(contractId);
        console.log(`Trade watchdog started (${(this.tradeWatchdogMs / 1000).toFixed(0)}s timeout)`);
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

        if (message.subscription?.id) {
            this.contractSubscriptions[asset] = message.subscription.id;
        }

        if (contract.is_sold) {
            trade.settledContract = contract;
            this.tickPassed = contract.tick_passed;
            this.requestFinalStayedInArray(asset);
            return;
        }

        const tickCount = contract.tick_count || 0;
        const profit = parseFloat(contract.profit || 0);
        const bidPrice = parseFloat(contract.bid_price || 0);

        if (tickCount > 0 && tickCount % 2 === 0) {
            console.log(
                `  ${asset}: tick ${tickCount} | ` +
                `Profit: $${profit.toFixed(3)} | Bid: $${bidPrice.toFixed(2)} | ` +
                `Ticks Passed: ${contract.tick_passed || 0}`
            );
        }
    }

    requestFinalStayedInArray(asset) {
        const trade = this.activeTrades[asset];
        if (!trade) return;

        trade.awaitingFinalStayedIn = true;

        console.log(`Requesting final stayedInArray for ${asset}...`);

        const regime = this.assetRegimes[asset] || 'normal';
        const growthRate = regime === 'calm'
            ? this.config.growthRateCalm
            : this.config.growthRateNormal;

        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            [this._proposalSymbolKey()]: asset,
            growth_rate: growthRate,
            limit_order: {
                take_profit: (this.currentStake * this.config.takeProfitMultiplierBase).toFixed(2)
            },
            passthrough: {
                action: 'get_final_stayed_in',
                asset: asset,
                timestamp: Date.now()
            }
        };

        this.sendRequest(proposal);

        setTimeout(() => {
            const currentTrade = this.activeTrades[asset];
            if (currentTrade && currentTrade.awaitingFinalStayedIn) {
                console.warn(`Timeout waiting for final stayedInArray for ${asset}`);
                currentTrade.awaitingFinalStayedIn = false;
                this.handleTradeResult(asset, currentTrade.settledContract);
            }
        }, 3000);
    }

    handleSellResponse(message) {
        if (message.error) {
            console.error('Sell error:', message.error.message);
            return;
        }
        console.log(`Sold for: $${message.sell?.sold_for || 'N/A'}`);
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
                `WATCHDOG FIRED — Contract ${contractId || 'unknown'} open for ` +
                `${(timeoutMs / 1000).toFixed(0)}s with no settlement`
            );

            if (contractId && this.connected && this.wsReady) {
                console.log(`Polling contract ${contractId} for current status…`);
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
                        `WATCHDOG: Poll timed out — contract ${contractId} still unresolved, ` +
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
            console.warn('No active trade found for stuck trade recovery');
            this.tradeInProgress = false;
            return;
        }

        const trade = this.activeTrades[stuckAsset];
        const contractId = trade.contractId || 'unknown';
        const stake = trade.stake || 0;
        const entryTime = this.tradeStartTime || Date.now();
        const openSeconds = Math.round((Date.now() - entryTime) / 1000);

        console.error(
            `\nSTUCK TRADE RECOVERY [${reason}]` +
            `\n   Contract: ${contractId}` +
            `\n   Asset: ${stuckAsset}` +
            `\n   Stake: $${stake.toFixed(2)}` +
            `\n   Open for: ${openSeconds}s`
        );

        if (contractId && contractId !== 'unknown' && this.connected && this.wsReady) {
            console.log(`Attempting emergency sell of contract ${contractId}…`);
            this.sendRequest({
                sell: contractId,
                price: '0',
            });
        }

        if (this.contractSubscriptions[stuckAsset]) {
            this.sendRequest({ forget: this.contractSubscriptions[stuckAsset] });
            delete this.contractSubscriptions[stuckAsset];
        }

        this.tradeInProgress = false;
        this.tradeStartTime = null;
        delete this.activeTrades[stuckAsset];

        this.totalLosses++;
        this.consecutiveLosses++;
        this.consecutiveLosses2++;

        if (this.assetMetrics[stuckAsset]) {
            this.assetMetrics[stuckAsset].losses++;
            this.assetMetrics[stuckAsset].profitLoss -= stake;
        }

        this.totalProfitLoss -= stake;
        this.dailyProfitLoss -= stake;

        console.log(
            `\n   Trade lock released — bot can now trade again` +
            `\n   Stake $${stake.toFixed(2)} recorded as loss`
        );

        this.sendTelegramMessage(
            `<b>STUCK TRADE RECOVERED — AMRA [${reason}]</b>\n\n` +
            `Contract: ${contractId}\n` +
            `Asset: ${stuckAsset}\n` +
            `Stake: $${stake.toFixed(2)}\n` +
            `Open for: ${openSeconds}s\n` +
            `Action: Emergency sell attempted, trade lock released`
        );

        StatePersistence.saveState(this);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TRADE RESULT HANDLING — AMRA Strategy
    // ══════════════════════════════════════════════════════════════════════════
    handleTradeResult(asset, contract) {
        const trade = this.activeTrades[asset];
        if (!trade) {
            this._clearWatchdogTimers();
            return;
        }

        this._clearWatchdogTimers();

        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const finalStayedInArray = this.assetStayedInArrays?.[asset] || [];

        if (this.contractSubscriptions[asset]) {
            this.sendRequest({ forget: this.contractSubscriptions[asset] });
            delete this.contractSubscriptions[asset];
        }

        console.log(`\n${'═'.repeat(55)}`);
        console.log(`  ${won ? 'WIN' : 'LOSS'}: ${asset}`);
        console.log(`  Ticks: ${contract.tick_count || 0} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
        console.log(`  Regime at entry: ${trade.regime || '?'} | Confidence: ${trade.confidence?.toFixed(2) || '?'}`);
        console.log(`  Final StayedIn: [${finalStayedInArray[99]}|${finalStayedInArray[98]}|${finalStayedInArray[97]}|${finalStayedInArray[96]}|${finalStayedInArray[95]}|${finalStayedInArray[94]}]`);
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

        // Track trade outcome for per-asset stats
        this.recentTradeOutcomes[asset].push({
            ticksSurvived: contract.tick_count || 0,
            won,
            timestamp: Date.now(),
        });
        if (this.recentTradeOutcomes[asset].length > 50) {
            this.recentTradeOutcomes[asset].shift();
        }

        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.currentStake = this.config.initialStake;
            this.consecutiveLosses = 0;
            this.confidenceThreshold = this.config.minConfidenceThreshold;

            if (this.assetMetrics[asset]) this.assetMetrics[asset].wins++;
            this.hourlyStats.wins++;

            if (this.focusAsset) {
                this.resumeAllAssets();
            }

            // Decrease filterNum after win (cast wider net)
            this.adjustFilterNum(true);

        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;
            this.hourlyStats.losses++;

            if (this.assetMetrics[asset]) this.assetMetrics[asset].losses++;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;
            else if (this.consecutiveLosses === 6) this.consecutiveLosses6++;

            // Increase filterNum modestly after loss
            this.adjustFilterNum(false);

            // Smart recovery stake calculation — don't apply until next trade
            // The stake will be calculated in placeTrade() using calculateSmartRecoveryStake()
            this.currentStake = Math.max(
                this.config.initialStake,
                this.currentStake * 7.5
            );
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

        // Update regime and stats post-trade
        this.updateStayInStats(asset, finalStayedInArray);
        this.updateMarketRegime(asset);
        this.computeConfidenceScore(asset);

        // Send notification
        this.sendTelegramMessage(
            `<b>AMRA — ${won ? 'WON' : 'LOSS'}</b>\n` +
            `Asset: <b>${asset}</b>\n` +
            `Regime: ${this.assetRegimes[asset] || '?'}\n` +
            `Ticks Passed: <b>${this.tickPassed}</b>\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
            `Consecutive Losses: ${this.consecutiveLosses}\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
            `Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00'}%\n` +
            `Stake: $${this.currentStake.toFixed(2)}\n` +
            `Filter: ${this.filterNum} | Conf Thresh: ${this.confidenceThreshold}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`
        );

        this.logTradingSummary();

        // Take profit condition
        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take Profit Reached... Stopping trading.');
            this.endOfDay = true;
            this.TP_SL = true;
            this.sendDisconnectSummary();
            this.disconnect();
            return;
        }

        // Stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('Stop condition met. Disconnecting...');
            this.endOfDay = true;
            this.TP_SL = true;
            this.sendDisconnectSummary();
            this.disconnect();
            return;
        }

        StatePersistence.saveState(this);

        // Immediate re-evaluation of all assets
        this._evaluateAllAssetsImmediately();
    }

    _evaluateAllAssetsImmediately() {
        this.assets.forEach(a => {
            this.tickCounts[a] = 0;
        });

        for (const asset of this.assets) {
            if (!this.isAssetAllowed(asset)) continue;
            if (!this.isAssetReady(asset) && asset !== this.focusAsset) continue;
            if (this.tradeInProgress) break;
            if (this.activeTrades[asset]) continue;
            if (!this.tickHistory[asset] || this.tickHistory[asset].length < this.config.requiredHistoryLength) continue;
            if (Date.now() - (this.lastTradeTime[asset] || 0) < this.config.minTimeBetweenTrades) continue;

            // Skip volatile regime assets
            if (this.assetRegimes[asset] === 'volatile') continue;

            console.log(`\nIMMEDIATE RE-ENTRY: ${asset} (post-trade evaluation)`);
            this.requestProposal(asset);
            break;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TIME-BASED DISCONNECT / RECONNECT
    // ══════════════════════════════════════════════════════════════════════════
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay();
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 23 && currentMinutes >= 0) {
                    console.log("It's past 11:00 PM after a win trade, disconnecting.");
                    this.sendDisconnectSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }

            if (!this.TP_SL && this.endOfDay && currentHours === 2 && currentMinutes >= 0) {
                console.log("It's 2:00 AM, reconnecting the bot.");
                this.endOfDay = false;
                this.Pause = false;
                this.tradeInProgress = false;
                this.tradedDigitArray = [];
                this.tradedDigitArray2 = [];
                this.tradeNum = Math.floor(Math.random() * (40 - 21 + 1)) + 21;
                this.connect();
            }

        }, 20000);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TRADING SUMMARY
    // ══════════════════════════════════════════════════════════════════════════
    logTradingSummary() {
        console.log('\nTrading Summary:');
        console.log(`  Total Trades: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalLosses}`);
        console.log(`  x2-x5 Losses: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4} | ${this.consecutiveLosses5}`);
        console.log(`  P&L: $${this.totalProfitLoss.toFixed(2)} | Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00'}%`);
        console.log(`  Stake: $${this.currentStake.toFixed(2)} | Filter: ${this.filterNum}`);
        console.log(this.getAssetFilteringSummary());

        // Regime summary
        const regimeSummary = this.assets.map(a => {
            const r = this.assetRegimes[a] || '?';
            const c = this.assetConfidenceScores[a]?.toFixed(2) || '?.??';
            return `${a}(${r}/${c})`;
        }).join(' ');
        console.log(`  Regimes & Confidence: ${regimeSummary}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ══════════════════════════════════════════════════════════════════════════
    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  AMRA Bot v4.0 — Adaptive Multi-Regime Accumulator');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`  Assets:        ${this.assets.join(', ')}`);
        console.log(`  Initial Stake: $${this.config.initialStake}`);
        console.log(`  Max Recovery:  ${this.config.maxRecoveryMultiplier}x`);
        console.log(`  Growth (Calm): ${(this.config.growthRateCalm * 100)}%`);
        console.log(`  Growth (Norm): ${(this.config.growthRateNormal * 100)}%`);
        console.log(`  Take Profit:   $${this.config.takeProfit}`);
        console.log(`  Stop Loss:     $${this.config.stopLoss}`);
        console.log(`  Min Filter:    ${this.config.minFilterNum} | Max Filter: ${this.config.maxFilterNum}`);
        console.log(`  Min Confidence: ${this.config.minConfidenceThreshold}`);
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
// Token: PAT (pat_...) → new REST+OTP flow; Legacy token → WS authorize.
// Generate PAT at https://app.deriv.com/account/api-token
// Register app at https://developers.deriv.com/
// ══════════════════════════════════════════════════════════════════════════════
const bot = new AMRATradingBot('0P94g4WdSrSrzir', {
    appId: '1089',
    accountType: 'demo',

    // ── Position Sizing ────────────────────────────────────────────────────
    initialStake: 1,
    maxRecoveryMultiplier: 8,
    maxConsecutiveLosses: 10,
    stopLoss: 127,
    takeProfit: 2500,

    // ── Adaptive Growth Rates ──────────────────────────────────────────────
    growthRateCalm: 0.04,      // 4% in calm regime (moderate barriers, good compounding)
    growthRateNormal: 0.02,    // 2% in normal regime (wider barriers, safer)

    // ── Statistical Take-Profit ────────────────────────────────────────────
    takeProfitPercentile: 0.25,  // 25th percentile of stay-in durations
    minTakeProfitTicks: 3,
    maxTakeProfitTicks: 25,
    takeProfitMultiplierBase: 0.12,

    // ── Confidence Scoring ─────────────────────────────────────────────────
    minConfidenceThreshold: 0.55,
    recoveryConfidenceThreshold: 0.50,

    // ── Dynamic Filter ─────────────────────────────────────────────────────
    minFilterNum: 3,
    maxFilterNum: 8,
    filterNum: 4,

    // ── Regime Detection ───────────────────────────────────────────────────
    regimeLookback: 50,
    volatilityHighThreshold: 0.0007,   // Normalized price velocity threshold
    volatilityLowThreshold: 0.0003,

    // ── Tick Flow ──────────────────────────────────────────────────────────
    tickFlowLookback: 20,
    greenFlowThreshold: 0.55,

    // ── Asset Filtering ────────────────────────────────────────────────────
    STAYED_IN_THRESHOLD: 600,
    scanTimer: 60000,

    // ── Assets ─────────────────────────────────────────────────────────────
    assets: [
        'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
        // '1HZ10V', '1HZ25V', '1HZ75V', '1HZ100V',
    ],

    // ── Telegram ───────────────────────────────────────────────────────────
    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    telegramChatId: '752497117',
});

bot.start();
