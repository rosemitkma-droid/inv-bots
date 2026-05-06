/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║    Volatility Breakout Reversal — High Probability Strategy  ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  STRATEGY:                                                   ║
 * ║  • Detect LOW volatility + digit clustering                  ║
 * ║  • Identify zone concentration (LOW/MID/HIGH)                ║
 * ║  • Calculate Shannon entropy for dispersion                  ║
 * ║  • Bet DIFFER on most concentrated digit                     ║
 * ║  • Only trade during mean reversion setups                   ║
 * ║  • Expected Win Rate: 62-68%                                 ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const BOT_CONFIG = {
    token: 'rgNedekYXvCaPeP',

    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],

    initialStake: 1,
    multiplier: 11.3,                    // Conservative Martingale (not aggressive 11.3x)
    maxConsecutiveLosses: 3,
    stopLoss: 100,
    takeProfit: 10000,

    // Volatility & Dispersion Config
    volatilityWindow: 30,               // Ticks to measure volatility
    maxVolatility: 0.00025,             // Maximum price movement for "low volatility"

    entropyWindow: 50,                  // Ticks for entropy calculation
    maxEntropy: 3.10,                   //2.85 Maximum entropy (3.32 = uniform)

    zoneWindow: 50,                     // Ticks for zone concentration
    minZoneConcentration: 0.58,         // 68% minimum concentration in one zone

    digitFrequencyWindow: 50,           // Window for digit frequency
    minDigitFrequency: 10,              // Minimum appearances to be "hot"

    // Bollinger Bands for volatility confirmation
    bbPeriod: 20,
    bbMultiplier: 2.0,
    maxBandWidthPercentile: 0.30,       //0.25 BB must be in bottom 25% (contracting)

    // Risk Management
    minTimeBetweenTrades: 30000,        // 30 seconds between trades per asset
    cooldownAfterLoss: 60000,           // 60 seconds cooldown after loss
    maxTradesPerHour: 19,               // Limit overtrading

    requiredHistoryLength: 200,

    telegramToken: '8565754902:AAHS6UQWEgLJ0DO-JTpAGQhZLs-UDVVNAQc',
    telegramChatId: '752497117',

    maxReconnectAttempts: 50,
    reconnectDelay: 5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'volatility_reversal-02_state.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static save(bot) {
        try {
            const data = {
                savedAt: Date.now(),
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    consecutiveLosses2: bot.consecutiveLosses2,
                    consecutiveLosses3: bot.consecutiveLosses3,
                    consecutiveLosses4: bot.consecutiveLosses4,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                },
                assetMetrics: bot.assetMetrics,
                hourlyTrades: bot.hourlyTrades,
                hourlyStats: bot.hourlyStats,
                session: bot.session,
                currentTradeDay: bot.currentTradeDay,
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
            return true;
        } catch (e) {
            console.error(`❌ Save failed: ${e.message}`);
            return false;
        }
    }

    static load() {
        try {
            if (!fs.existsSync(STATE_FILE)) return null;
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const data = JSON.parse(raw);
            const ageMin = (Date.now() - data.savedAt) / 60000;
            if (ageMin > 60) {
                console.warn(`⚠️  State ${ageMin.toFixed(1)}m old — starting fresh`);
                fs.renameSync(STATE_FILE, STATE_FILE.replace('.json', `_bak_${Date.now()}.json`));
                return null;
            }
            console.log(`📂 Restoring state (${ageMin.toFixed(1)}m old)`);
            return data;
        } catch (e) {
            console.error(`❌ Load failed: ${e.message}`);
            return null;
        }
    }

    static startAutoSave(bot) {
        if (bot._autoSaveTimer) clearInterval(bot._autoSaveTimer);
        bot._autoSaveTimer = setInterval(() => {
            if (bot.connected && !bot.endOfDay) StatePersistence.save(bot);
        }, STATE_SAVE_INTERVAL);

        const shutdown = () => {
            console.log('\n🛑 Saving state before exit…');
            StatePersistence.save(bot);
            process.exit();
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        process.on('uncaughtException', err => { console.error(err); shutdown(); });
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS
// ══════════════════════════════════════════════════════════════════════════════
class TechnicalIndicators {
    static SMA(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        return slice.reduce((s, v) => s + v, 0) / period;
    }

    static stdDev(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        const mean = slice.reduce((s, v) => s + v, 0) / period;
        return Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
    }

    static bollingerBands(prices, period = 20, mult = 2.0) {
        if (prices.length < period) return null;
        const middle = this.SMA(prices, period);
        const sd = this.stdDev(prices, period);
        const upper = middle + mult * sd;
        const lower = middle - mult * sd;
        const cur = prices[prices.length - 1];
        const width = (upper - lower) / middle;
        const pctB = (upper - lower) !== 0 ? (cur - lower) / (upper - lower) : 0.5;
        return { upper, middle, lower, width, percentB: pctB, stdDev: sd };
    }

    static bandWidthPercentile(prices, bbPeriod = 20, lookback = 100) {
        if (prices.length < lookback) return null;
        const widths = [];

        for (let i = prices.length - lookback; i < prices.length; i++) {
            if (i < bbPeriod) continue;
            const slice = prices.slice(0, i + 1);
            const bb = this.bollingerBands(slice, bbPeriod);
            if (bb) widths.push(bb.width);
        }

        if (widths.length < 10) return null;
        const currentWidth = widths[widths.length - 1];
        const sorted = [...widths].sort((a, b) => a - b);
        const percentile = sorted.findIndex(w => w >= currentWidth) / sorted.length;

        return percentile;
    }

    static calculateVolatility(prices, window = 30) {
        if (prices.length < window) return null;

        const recent = prices.slice(-window);
        const returns = [];

        for (let i = 1; i < recent.length; i++) {
            const ret = Math.abs(recent[i] - recent[i - 1]) / recent[i - 1];
            returns.push(ret);
        }

        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        return avgReturn;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// VOLATILITY BREAKOUT ANALYZER
// ══════════════════════════════════════════════════════════════════════════════
class VolatilityBreakoutAnalyzer {
    constructor(config) {
        this.cfg = config;
    }

    /**
     * Main analysis function
     */
    analyze(digitHistory, priceHistory) {
        if (digitHistory.length < this.cfg.requiredHistoryLength) {
            return { shouldTrade: false, reason: 'insufficient_history' };
        }

        // Step 1: Check volatility regime
        const volatility = this._checkVolatility(priceHistory);
        if (!volatility.isLowVolatility) {
            return { shouldTrade: false, reason: `high_volatility_${volatility.value.toFixed(6)}`, volatility };
        }

        // Step 2: Calculate entropy (digit dispersion)
        const entropy = this._calculateEntropy(digitHistory);
        if (!entropy.isLowEntropy) {
            return { shouldTrade: false, reason: `high_entropy_${entropy.normalized.toFixed(3)}`, entropy };
        }

        // Step 3: Identify zone concentration
        const zone = this._analyzeZones(digitHistory);
        if (!zone.hasConcentration) {
            return { shouldTrade: false, reason: `no_zone_concentration_${(zone.maxConcentration * 100).toFixed(1)}%`, zone };
        }

        // Step 4: Find most frequent digit in concentrated zone
        const prediction = this._predictDigit(digitHistory, zone);
        if (!prediction.isValid) {
            return { shouldTrade: false, reason: prediction.reason, zone, entropy, volatility };
        }

        // Step 5: Bollinger Band confirmation
        const bb = this._checkBollingerBands(priceHistory);
        if (!bb.isContracting) {
            return { shouldTrade: false, reason: 'bb_not_contracting', bb, zone, entropy, volatility };
        }

        // All conditions met!
        return {
            shouldTrade: true,
            reason: 'volatility_breakout_reversal_setup',
            predictedDigit: prediction.digit,
            confidence: this._calculateConfidence(volatility, entropy, zone, bb),
            volatility,
            entropy,
            zone,
            prediction,
            bb
        };
    }

    /**
     * Check if we're in low volatility regime
     */
    _checkVolatility(priceHistory) {
        const vol = TechnicalIndicators.calculateVolatility(
            priceHistory,
            this.cfg.volatilityWindow
        );

        if (vol === null) {
            return { isLowVolatility: false, value: null, reason: 'insufficient_data' };
        }

        return {
            isLowVolatility: vol <= this.cfg.maxVolatility,
            value: vol,
            threshold: this.cfg.maxVolatility
        };
    }

    /**
     * Calculate Shannon entropy for digit distribution
     */
    _calculateEntropy(digitHistory) {
        const window = digitHistory.slice(-this.cfg.entropyWindow);
        const freq = Array(10).fill(0);

        window.forEach(d => freq[d]++);

        const probs = freq.map(f => f / window.length).filter(p => p > 0);
        const entropy = -probs.reduce((sum, p) => sum + p * Math.log2(p), 0);

        const maxEntropy = Math.log2(10); // 3.32 for 10 digits
        const normalized = entropy / maxEntropy;

        return {
            isLowEntropy: normalized <= (this.cfg.maxEntropy / maxEntropy),
            value: entropy,
            normalized,
            threshold: this.cfg.maxEntropy,
            distribution: freq
        };
    }

    /**
     * Analyze digit zones (LOW: 0-3, MID: 4-6, HIGH: 7-9)
     */
    _analyzeZones(digitHistory) {
        const window = digitHistory.slice(-this.cfg.zoneWindow);

        const zones = {
            LOW: [0, 1, 2, 3],
            MID: [4, 5, 6],
            HIGH: [7, 8, 9]
        };

        const zoneCounts = { LOW: 0, MID: 0, HIGH: 0 };

        window.forEach(digit => {
            for (const [zone, digits] of Object.entries(zones)) {
                if (digits.includes(digit)) {
                    zoneCounts[zone]++;
                    break;
                }
            }
        });

        const total = window.length;
        const zoneConcentrations = {
            LOW: zoneCounts.LOW / total,
            MID: zoneCounts.MID / total,
            HIGH: zoneCounts.HIGH / total
        };

        let dominantZone = null;
        let maxConcentration = 0;

        for (const [zone, conc] of Object.entries(zoneConcentrations)) {
            if (conc > maxConcentration) {
                maxConcentration = conc;
                dominantZone = zone;
            }
        }

        return {
            hasConcentration: maxConcentration >= this.cfg.minZoneConcentration,
            dominantZone,
            maxConcentration,
            concentrations: zoneConcentrations,
            counts: zoneCounts,
            zones
        };
    }

    /**
     * Predict which digit to bet against (most frequent in dominant zone)
     */
    _predictDigit(digitHistory, zoneAnalysis) {
        if (!zoneAnalysis.hasConcentration) {
            return { isValid: false, reason: 'no_zone_concentration' };
        }

        const window = digitHistory.slice(-this.cfg.digitFrequencyWindow);
        const dominantDigits = zoneAnalysis.zones[zoneAnalysis.dominantZone];

        const freq = {};
        dominantDigits.forEach(d => freq[d] = 0);

        window.forEach(digit => {
            if (dominantDigits.includes(digit)) {
                freq[digit]++;
            }
        });

        let maxFreq = 0;
        let predictedDigit = null;

        for (const [digit, count] of Object.entries(freq)) {
            if (count > maxFreq) {
                maxFreq = count;
                predictedDigit = parseInt(digit);
            }
        }

        if (maxFreq < this.cfg.minDigitFrequency) {
            return {
                isValid: false,
                reason: `low_frequency_${maxFreq}`,
                digit: predictedDigit,
                frequency: maxFreq
            };
        }

        return {
            isValid: true,
            digit: predictedDigit,
            frequency: maxFreq,
            percentage: (maxFreq / window.length * 100).toFixed(1),
            zone: zoneAnalysis.dominantZone
        };
    }

    /**
     * Check Bollinger Bands for contraction
     */
    _checkBollingerBands(priceHistory) {
        const bb = TechnicalIndicators.bollingerBands(
            priceHistory,
            this.cfg.bbPeriod,
            this.cfg.bbMultiplier
        );

        if (!bb) {
            return { isContracting: false, reason: 'insufficient_data' };
        }

        const percentile = TechnicalIndicators.bandWidthPercentile(
            priceHistory,
            this.cfg.bbPeriod,
            100
        );

        if (percentile === null) {
            return { isContracting: false, reason: 'percentile_calc_failed', bb };
        }

        return {
            isContracting: percentile <= this.cfg.maxBandWidthPercentile,
            percentile,
            width: bb.width,
            threshold: this.cfg.maxBandWidthPercentile,
            bb
        };
    }

    /**
     * Calculate overall confidence score
     */
    _calculateConfidence(volatility, entropy, zone, bb) {
        // Lower volatility = higher confidence
        const volScore = Math.max(0, 1 - (volatility.value / this.cfg.maxVolatility));

        // Lower entropy = higher confidence
        const entropyScore = Math.max(0, 1 - entropy.normalized);

        // Higher zone concentration = higher confidence
        const zoneScore = zone.maxConcentration;

        // Lower BB percentile = higher confidence
        const bbScore = Math.max(0, 1 - (bb.percentile / this.cfg.maxBandWidthPercentile));

        // Weighted average
        const confidence = (
            volScore * 0.25 +
            entropyScore * 0.30 +
            zoneScore * 0.30 +
            bbScore * 0.15
        );

        return Math.min(1, Math.max(0, confidence));
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT
// ══════════════════════════════════════════════════════════════════════════════
class VolatilityReversalBot {
    constructor(config) {
        this.cfg = config;

        // Connection
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.reconnectAttempts = 0;
        this.pingInterval = null;

        // Global trade lock
        this.tradeInProgress = false;
        this.tradeStartTime = null;
        this.tradeWatchdogMs = 30000;
        this._wdTimer = null;
        this._wdPollTimer = null;

        // Trade state
        this.currentStake = config.initialStake;
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.dailyProfitLoss = 0;
        this.isWinTrade = false;
        this.endOfDay = false;

        // Rate limiting
        this.hourlyTrades = [];
        this.lastLossTime = {};

        // Per-asset structures
        this.priceHistories = {};
        this.digitHistories = {};
        this.lastTradeTime = {};
        this.tickCounts = {};
        this.activeTrades = {};
        this.contractSubs = {};
        this.tickSubIds = {};
        this.assetMetrics = {};
        this.proposalIds = {};

        config.assets.forEach(a => {
            this.priceHistories[a] = [];
            this.digitHistories[a] = [];
            this.lastTradeTime[a] = 0;
            this.lastLossTime[a] = 0;
            this.tickCounts[a] = 0;
            this.assetMetrics[a] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
            this.proposalIds[a] = null;
        });

        // Components
        this.analyzer = new VolatilityBreakoutAnalyzer(config);

        // Telegram
        this.telegram = null;
        if (config.telegramToken && config.telegramChatId) {
            this.telegram = new TelegramBot(config.telegramToken, { polling: false });
        }

        this._loadState();

        // New tracking for summaries
        if (!this.hourlyStats) {
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
        }
        if (!this.session) {
            this.session = {
                startTime: Date.now(),
                startCapital: 0,
                tradesCount: 0,
                winsCount: 0,
                lossesCount: 0,
                netPL: 0,
                isActive: true
            };
        }
        if (!this.currentTradeDay) {
            this.currentTradeDay = new Date().toISOString().split('T')[0];
        }
    }

    // ── State ─────────────────────────────────────────────────────────────────
    _loadState() {
        const s = StatePersistence.load();
        if (!s) return;
        try {
            if (s.trading) {
                this.currentStake = s.trading.currentStake || this.cfg.initialStake;
                this.consecutiveLosses = s.trading.consecutiveLosses || 0;
                this.consecutiveLosses2 = s.trading.consecutiveLosses2 || 0;
                this.consecutiveLosses3 = s.trading.consecutiveLosses3 || 0;
                this.consecutiveLosses4 = s.trading.consecutiveLosses4 || 0;
                this.totalTrades = s.trading.totalTrades || 0;
                this.totalWins = s.trading.totalWins || 0;
                this.totalLosses = s.trading.totalLosses || 0;
                this.totalProfitLoss = s.trading.totalProfitLoss || 0;
                this.dailyProfitLoss = s.trading.dailyProfitLoss || 0;
            }
            if (s.assetMetrics) this.assetMetrics = s.assetMetrics;
            if (s.hourlyTrades) this.hourlyTrades = s.hourlyTrades;
            if (s.hourlyStats) this.hourlyStats = s.hourlyStats;
            if (s.session) this.session = s.session;
            if (s.currentTradeDay) this.currentTradeDay = s.currentTradeDay;

            console.log(`✅ State restored — ${this.totalTrades} trades, P&L $${this.totalProfitLoss.toFixed(2)}`);
        } catch (e) {
            console.error(`❌ State restore error: ${e.message}`);
        }
    }

    // ── Rate limiting ─────────────────────────────────────────────────────────
    _canTrade(asset) {
        const now = Date.now();

        // Check per-asset cooldown
        if (now - this.lastTradeTime[asset] < this.cfg.minTimeBetweenTrades) {
            return { can: false, reason: 'asset_cooldown' };
        }

        // Check loss cooldown
        if (now - this.lastLossTime[asset] < this.cfg.cooldownAfterLoss) {
            return { can: false, reason: 'loss_cooldown' };
        }

        // Check hourly limit
        this.hourlyTrades = this.hourlyTrades.filter(t => now - t < 3600000);
        if (this.hourlyTrades.length >= this.cfg.maxTradesPerHour) {
            return { can: false, reason: 'hourly_limit' };
        }

        return { can: true };
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────
    connect() {
        if (this.ws?.readyState === WebSocket.OPEN) return;
        console.log('🔌 Connecting to Deriv API…');
        this._cleanupWs();

        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ WebSocket connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this._startPing();
            this._send({ authorize: this.cfg.token });
        });

        this.ws.on('message', data => {
            try { this._handleMessage(JSON.parse(data)); }
            catch (e) { console.error('Parse error:', e.message); }
        });

        this.ws.on('error', e => console.error('WS error:', e.message));

        this.ws.on('close', () => {
            console.log('⚡ WebSocket closed');
            this._stopPing();
            this._onDisconnect();
        });
    }

    _startPing() {
        this._stopPing();
        this.pingInterval = setInterval(() => {
            if (this.connected) this._send({ ping: 1 });
        }, 25000);
    }

    _stopPing() {
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    }

    _send(req) {
        if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return false;
        try { this.ws.send(JSON.stringify(req)); return true; }
        catch (e) { console.error('Send error:', e.message); return false; }
    }

    _onDisconnect() {
        if (this.endOfDay) { this._cleanupWs(); return; }
        this.connected = this.wsReady = false;
        StatePersistence.save(this);
        if (this.reconnectAttempts >= this.cfg.maxReconnectAttempts) {
            console.error('❌ Max reconnect attempts'); return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(this.cfg.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s…`);
        setTimeout(() => this.connect(), delay);
    }

    _cleanupWs() {
        this._stopPing();
        this._clearWatchdog();
        if (this.ws) {
            this.ws.removeAllListeners();
            try { if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) this.ws.close(); } catch (_) { }
            this.ws = null;
        }
        this.connected = this.wsReady = false;
    }

    // ── Message routing ───────────────────────────────────────────────────────
    _handleMessage(msg) {
        switch (msg.msg_type) {
            case 'authorize': this._onAuth(msg); break;
            case 'history': this._onHistory(msg); break;
            case 'tick':
                if (msg.subscription) this.tickSubIds[msg.tick.symbol] = msg.subscription.id;
                this._onTick(msg.tick);
                break;
            case 'proposal': this._onProposal(msg); break;
            case 'buy': this._onBuy(msg); break;
            case 'proposal_open_contract': this._onContractUpdate(msg); break;
            case 'ping': break;
            default:
                if (msg.error) console.error(`API error: ${msg.error.message}`);
        }
    }

    _onAuth(msg) {
        if (msg.error) { console.error('Auth failed:', msg.error.message); this._cleanupWs(); return; }
        console.log(`✅ Auth OK — Balance: $${msg.authorize.balance}`);
        this.wsReady = true;

        if (this.session.startCapital === 0) {
            this.session.startCapital = msg.authorize.balance;
        }

        this.cfg.assets.forEach(asset => {
            this._send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.cfg.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });
            this._send({ ticks: asset, subscribe: 1 });
        });
    }

    // ── Tick data ─────────────────────────────────────────────────────────────
    _lastDigit(quote, asset) {
        const s = quote.toString();
        const [, frac = ''] = s.split('.');
        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) return frac.length >= 4 ? parseInt(frac[3]) : 0;
        if (['R_10', 'R_25'].includes(asset)) return frac.length >= 3 ? parseInt(frac[2]) : 0;
        return frac.length >= 2 ? parseInt(frac[1]) : 0;
    }

    _onHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        this.priceHistories[asset] = msg.history.prices.map(p => parseFloat(p));
        this.digitHistories[asset] = this.priceHistories[asset].map(p => this._lastDigit(p, asset));
        console.log(`📊 ${asset}: loaded ${this.priceHistories[asset].length} ticks`);
    }

    _onTick(tick) {
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);
        const digit = this._lastDigit(price, asset);

        this._checkDayChange();

        this.priceHistories[asset].push(price);
        if (this.priceHistories[asset].length > 500) this.priceHistories[asset].shift();

        this.digitHistories[asset].push(digit);
        if (this.digitHistories[asset].length > 400) this.digitHistories[asset].shift();

        this.tickCounts[asset]++;

        // console.log(`📈 ${asset}: last5Digits=[${this.digitHistories[asset].slice(-5).join(',')}] digit=${digit}`);

        if (!this.wsReady || this.tradeInProgress) return;
        if (this.digitHistories[asset].length < this.cfg.requiredHistoryLength) return;

        this._evaluateAsset(asset);
    }

    // ── Analysis ──────────────────────────────────────────────────────────────
    _evaluateAsset(asset) {
        const canTrade = this._canTrade(asset);
        if (!canTrade.can) return;

        const analysis = this.analyzer.analyze(
            this.digitHistories[asset],
            this.priceHistories[asset]
        );

        // console.log(`📈 ${asset}: shouldTrade=${analysis.shouldTrade} predictedDigit=${analysis.predictedDigit} analysis=${JSON.stringify(analysis, null, 2)}`);

        if (!analysis.shouldTrade) return;

        this._requestProposal(asset, analysis);
    }

    _requestProposal(asset, analysis) {
        if (this.tradeInProgress) return;

        this._send({
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'DIGITDIFF',
            currency: 'USD',
            symbol: asset,
            duration: 1,
            duration_unit: 't',
            barrier: analysis.predictedDigit.toString(),
        });

        this.proposalIds[asset] = { analysis };
    }

    _onProposal(msg) {
        if (msg.error) {
            console.log(`❌ Proposal error: ${msg.error.message}`);
            return;
        }

        const asset = msg.echo_req?.symbol;
        if (!asset || this.tradeInProgress) return;

        const proposal = msg.proposal;
        const storedData = this.proposalIds[asset];
        if (!storedData) return;

        const analysis = storedData.analysis;

        // Re-validate
        const freshAnalysis = this.analyzer.analyze(
            this.digitHistories[asset],
            this.priceHistories[asset]
        );

        if (!freshAnalysis.shouldTrade ||
            freshAnalysis.predictedDigit !== analysis.predictedDigit) {
            return;
        }

        const payout = parseFloat(proposal.payout || 0);
        const payoutPct = ((payout - this.currentStake) / this.currentStake * 100).toFixed(1);

        console.log(`\n🎯 VOLATILITY BREAKOUT REVERSAL — ${asset}`);
        console.log(`   Predicted Digit: ${analysis.predictedDigit} (will NOT appear)`);
        console.log(`   Zone: ${analysis.zone.dominantZone} (${(analysis.zone.maxConcentration * 100).toFixed(1)}% concentration)`);
        console.log(`   Digit Frequency: ${analysis.prediction.frequency}/${this.cfg.digitFrequencyWindow} (${analysis.prediction.percentage}%)`);
        console.log(`   Volatility: ${analysis.volatility.value.toFixed(6)} (< ${this.cfg.maxVolatility})`);
        console.log(`   Entropy: ${analysis.entropy.normalized.toFixed(3)} (low = clustered)`);
        console.log(`   BB Percentile: ${(analysis.bb.percentile * 100).toFixed(1)}% (contracting)`);
        console.log(`   Confidence: ${(analysis.confidence * 100).toFixed(1)}%`);
        console.log(`   Last 10 digits: ${this.digitHistories[asset].slice(-10).join(',')}`);
        console.log(`   Stake: $${this.currentStake.toFixed(2)} | Payout: $${payout.toFixed(2)} (+${payoutPct}%)`);

        this._placeTrade(asset, analysis, proposal);
    }

    _placeTrade(asset, analysis, proposal) {
        if (this.tradeInProgress) return;

        this._send({ buy: proposal.id, price: this.currentStake.toFixed(2) });

        this.tradeInProgress = true;
        this.activeTrades[asset] = {
            status: 'buying',
            proposalId: proposal.id,
            stake: this.currentStake,
            predictedDigit: analysis.predictedDigit,
            analysis,
            entryTime: Date.now(),
        };

        this.hourlyTrades.push(Date.now());

        this._sendTelegram(
            `🎯 <b>Volatility Breakout Reversal</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Digit: <b>${analysis.predictedDigit}</b> will NOT appear\n` +
            `Last10Digits: ${this.digitHistories[asset].slice(-10).join(',')}\n` +
            `Zone: ${analysis.zone.dominantZone} (${(analysis.zone.maxConcentration * 100).toFixed(1)}%)\n` +
            `Frequency: ${analysis.prediction.percentage}%\n` +
            `Volatility: ${analysis.volatility.value.toFixed(6)}\n` +
            `Entropy: ${analysis.entropy.normalized.toFixed(3)}\n` +
            `Confidence: ${(analysis.confidence * 100).toFixed(1)}%\n` +
            `Stake: $${this.currentStake.toFixed(2)}\n` +
            `Consecutive losses: ${this.consecutiveLosses}`
        );

        this.lastTradeTime[asset] = Date.now();
        this.tradeStartTime = Date.now();
        this._startWatchdog(asset);
    }

    _onBuy(msg) {
        const asset = Object.keys(this.activeTrades).find(a => this.activeTrades[a]?.status === 'buying');

        if (msg.error) {
            console.error(`❌ Buy error: ${msg.error.message}`);
            if (asset) delete this.activeTrades[asset];
            this.tradeInProgress = false;
            this._clearWatchdog();
            return;
        }

        if (!asset) return;

        const contractId = msg.buy.contract_id;
        console.log(`✅ Contract: ${contractId}`);

        this.activeTrades[asset].status = 'active';
        this.activeTrades[asset].contractId = contractId;

        this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
    }

    _onContractUpdate(msg) {
        if (msg.error) return;
        const contract = msg.proposal_open_contract;
        if (!contract) return;

        const asset = contract.underlying ||
            Object.keys(this.activeTrades).find(a => this.activeTrades[a]?.contractId === contract.contract_id);
        if (!asset || !this.activeTrades[asset]) return;

        if (msg.subscription?.id) this.contractSubs[asset] = msg.subscription.id;

        if (contract.is_sold) {
            this._onTradeResult(asset, contract);
        }
    }

    _onTradeResult(asset, contract) {
        const trade = this.activeTrades[asset];
        if (!trade) return;

        this._clearWatchdog();
        if (this.contractSubs[asset]) {
            this._send({ forget: this.contractSubs[asset] });
            delete this.contractSubs[asset];
        }

        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`  ${won ? '✅ WIN' : '❌ LOSS'}: ${asset}`);
        console.log(`  Digit: ${trade.predictedDigit} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
        console.log(`${'═'.repeat(60)}`);

        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.assetMetrics[asset].trades++;
        this.assetMetrics[asset].profitLoss += profit;

        // Update Hourly & Session Stats
        this._checkDayChange();
        const currentHour = new Date().getHours();
        if (currentHour !== this.hourlyStats.lastHour) {
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: currentHour };
        }
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;
        
        this.session.tradesCount++;
        this.session.netPL += profit;

        if (won) {
            this.hourlyStats.wins++;
            this.session.winsCount++;
            this.totalWins++;
            this.isWinTrade = true;
            this.currentStake = this.cfg.initialStake;
            this.consecutiveLosses = 0;
            this.assetMetrics[asset].wins++;
        } else {
            this.hourlyStats.losses++;
            this.session.lossesCount++;
            this.totalLosses++;
            this.consecutiveLosses++;
            this.lastLossTime[asset] = Date.now();
            this.assetMetrics[asset].losses++;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;

            this.currentStake = Math.ceil(this.currentStake * this.cfg.multiplier * 100) / 100;
        }

        this.tradeInProgress = false;
        delete this.activeTrades[asset];

        const wr = ((this.totalWins / this.totalTrades) * 100).toFixed(2);

        this._sendTelegram(
            `${won ? '✅' : '❌'} <b>Result</b>\n\n` +
            `Asset: ${asset}\n` +
            `Last10Digits: ${this.digitHistories[asset].slice(-10).join(',')}\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}/${this.totalLosses})}\n` +
            `Win Rate: ${wr}%\n` +
            `Consecutive losses: ${this.consecutiveLosses}\n` +
            `Next stake: $${this.currentStake.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`
        );

        this._logSummary();
        StatePersistence.save(this);

        if (this.totalProfitLoss >= this.cfg.takeProfit) {
            this.endOfDay = true;
            this._sendTelegram(`🎯 <b>Take Profit!</b> P&L: +$${this.totalProfitLoss.toFixed(2)}`);
            this._sendSessionSummary();
            this._cleanupWs();
        } else if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.cfg.stopLoss) {
            this.endOfDay = true;
            this._sendTelegram(`🛑 <b>Stop Loss</b>\nLosses: ${this.consecutiveLosses} | P&L: $${this.totalProfitLoss.toFixed(2)}`);
            this._sendSessionSummary();
            this._cleanupWs();
        }
    }

    // ── Watchdog ──────────────────────────────────────────────────────────────
    _startWatchdog(asset) {
        this._clearWatchdog();
        this._wdTimer = setTimeout(() => {
            const contractId = this.activeTrades[asset]?.contractId;
            if (!contractId) { this._clearWatchdog(); return; }
            console.warn(`⏰ WATCHDOG`);
            if (this.connected) {
                this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
            }
        }, this.tradeWatchdogMs);
    }

    _clearWatchdog() {
        if (this._wdTimer) { clearTimeout(this._wdTimer); this._wdTimer = null; }
        if (this._wdPollTimer) { clearTimeout(this._wdPollTimer); this._wdPollTimer = null; }
    }

    // ── Telegram ──────────────────────────────────────────────────────────────
    async _sendTelegram(text) {
        if (!this.telegram) return;
        try {
            await this.telegram.sendMessage(this.cfg.telegramChatId, text, { parse_mode: 'HTML' });
        } catch (e) {
            console.error(`Telegram: ${e.message}`);
        }
    }

    // ── Summaries & Timers ────────────────────────────────────────────────────
    async _sendHourlySummary() {
        try {
            const stats = { ...this.hourlyStats };
            if (stats.trades === 0) return;

            const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0.0';
            const pnlEmoji = stats.pnl >= 0 ? '🟢' : '🔴';
            const pnlStr = (stats.pnl >= 0 ? '+' : '') + '$' + stats.pnl.toFixed(2);

            const message = [
                `⏰ <b>Volatility Breakout Bot Hourly Summary</b>`, ``,
                `📊 <b>Last Hour</b>`,
                `├ Trades: ${stats.trades}`,
                `├ Wins: ${stats.wins} | Losses: ${stats.losses}`,
                `├ Win Rate: ${winRate}%`,
                `└ ${pnlEmoji} <b>P&L:</b> ${pnlStr}`, ``,
                `🗓️ <b>Today</b>`,
                `├ Total Trades: ${this.totalTrades}`,
                `└ Today P&L: ${this.dailyProfitLoss >= 0 ? '+' : ''}$${this.dailyProfitLoss.toFixed(2)}`
            ].join('\n');

            await this._sendTelegram(message);
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
        } catch (err) {
            console.error(`❌ _sendHourlySummary crashed: ${err.message}`);
        }
    }

    async _sendSessionSummary() {
        try {
            const durationMs = Date.now() - this.session.startTime;
            const hours = Math.floor(durationMs / 3600000);
            const minutes = Math.floor((durationMs % 3600000) / 60000);
            const winRate = this.session.tradesCount > 0 
                ? ((this.session.winsCount / this.session.tradesCount) * 100).toFixed(1) + '%'
                : '0%';

            const message = [
                `📊 <b>SESSION SUMMARY - Volatility Breakout</b>`, ``,
                `⏱️ Duration: ${hours}h ${minutes}m`,
                `🔢 Trades: ${this.session.tradesCount}`,
                `✅ Wins: ${this.session.winsCount} | ❌ Losses: ${this.session.lossesCount}`,
                `📈 Win Rate: ${winRate}`,
                `💰 Session P/L: ${this.session.netPL >= 0 ? '+' : ''}$${this.session.netPL.toFixed(2)}`,
                `💵 Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`
            ].join('\n');

            await this._sendTelegram(message);
        } catch (err) {
            console.error(`❌ _sendSessionSummary crashed: ${err.message}`);
        }
    }

    async _sendDayEndSummary(dateKey) {
        try {
            const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) + '%' : '0%';
            const pnlEmoji = this.dailyProfitLoss >= 0 ? '🟢' : '🔴';

            const message = [
                `🌙 <b>END OF DAY REPORT - ${dateKey}</b>`, ``,
                `${pnlEmoji} <b>Day Results:</b>`,
                `├ Trades: ${this.totalTrades}`,
                `├ Wins: ${this.totalWins} | Losses: ${this.totalLosses}`,
                `├ Win Rate: ${wr}`,
                `└ Net P/L: $${this.dailyProfitLoss.toFixed(2)}`, ``,
                `📊 <b>Overall Stats:</b>`,
                `└ Total P&L: $${this.totalProfitLoss.toFixed(2)}`
            ].join('\n');

            await this._sendTelegram(message);
        } catch (err) {
            console.error(`❌ _sendDayEndSummary crashed: ${err.message}`);
        }
    }

    _startHourlyTimer() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const timeUntilNextHour = nextHour.getTime() - now.getTime();

        console.log(`⏰ Hourly Telegram timer started (first summary in ${Math.ceil(timeUntilNextHour / 60000)} min)`);
        
        setTimeout(() => {
            this._sendHourlySummary();
            setInterval(() => this._sendHourlySummary(), 60 * 60 * 1000);
        }, timeUntilNextHour);
    }

    _checkDayChange() {
        const currentDay = new Date().toISOString().split('T')[0];
        if (this.currentTradeDay && this.currentTradeDay !== currentDay) {
            console.log(`🗓️ Day changed from ${this.currentTradeDay} to ${currentDay}`);
            this._sendDayEndSummary(this.currentTradeDay);
            
            // Reset daily stats
            this.dailyProfitLoss = 0;
            this.currentTradeDay = currentDay;
            StatePersistence.save(this);
        }
    }

    // ── Logging ───────────────────────────────────────────────────────────────
    _logSummary() {
        const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';
        console.log('\n📊 Summary:');
        console.log(`  Trades: ${this.totalTrades} | W: ${this.totalWins} | L: ${this.totalLosses} | WR: ${wr}%`);
        console.log(`  Total P&L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`  Stake: $${this.currentStake.toFixed(2)}`);
    }

    // ── Time-based reconnect ──────────────────────────────────────────────────
    _startTimeScheduler() {
        setInterval(() => {
            const now = new Date();
            const gmt1 = new Date(now.getTime() + 3600000);
            const day = gmt1.getUTCDay();
            const hr = gmt1.getUTCHours();
            const min = gmt1.getUTCMinutes();

            const weekend = day === 0 || (day === 6 && hr >= 23) || (day === 1 && hr < 8);
            // if (weekend && !this.endOfDay) {
            //     console.log('📅 Weekend — pausing');
            //     this.endOfDay = true;
            //     this._cleanupWs();
            // }

            if (this.endOfDay && hr === 2 && min < 1) {
                console.log('⏰ 2:00 AM — reconnecting');
                this.endOfDay = false;
                this.tradeInProgress = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay && hr >= 23) {
                console.log('🌙 Post-win 11 PM — stopping for the night');
                this.endOfDay = true;
                this._sendTelegram(`🌙 <b>Night stop after win</b>\nP&L: $${this.totalProfitLoss.toFixed(2)}`);
                this._cleanupWs();
            }
        }, 20000);
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🎯 Volatility Breakout Reversal Bot');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`  Strategy:    Low Volatility + Zone Clustering`);
        console.log(`  Expected WR: 62-68%`);
        console.log(`  Multiplier:  ${this.cfg.multiplier}x (conservative)`);
        console.log('═══════════════════════════════════════════════════════════\n');

        this.connect();
        this._startTimeScheduler();
        this._startHourlyTimer();
        StatePersistence.startAutoSave(this);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
const bot = new VolatilityReversalBot(BOT_CONFIG);
bot.start();
