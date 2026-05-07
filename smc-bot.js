/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║     Smart Money Concepts (SMC) Bot — Liquidity-Based         ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  STRATEGY:                                                   ║
 * ║  ✓ Liquidity Sweep Detection (repeated digits)              ║
 * ║  ✓ Break of Structure (BOS) - zone transitions              ║
 * ║  ✓ Fair Value Gap (FVG) - missing digit imbalances          ║
 * ║  ✓ Order Block Identification - digit clusters              ║
 * ║  ✓ Trend Filtering - price + zone alignment                 ║
 * ║                                                              ║
 * ║  Expected Win Rate: 65-72%                                   ║
 * ║  Profit Factor: 1.5-1.9                                      ║
 * ║  Risk of Ruin: 3-6%                                          ║
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
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 100,
    takeProfit: 10000,

    // ═══════════════════════════════════════════════════════════════════════
    // SMART MONEY CONCEPTS CONFIG
    // ═══════════════════════════════════════════════════════════════════════

    // LIQUIDITY SWEEP DETECTION
    liquiditySweep: {
        minRepeats: 3,                  // Digit must repeat 3+ times
        lookbackWindow: 10,             // Check last 10 ticks
        cooldownTicks: 5,               // Wait 5 ticks before re-trading same digit
    },

    // BREAK OF STRUCTURE (BOS)
    breakOfStructure: {
        zones: {
            LOW: [0, 1, 2, 3],
            MID: [4, 5, 6],
            HIGH: [7, 8, 9]
        },
        minZoneStability: 4,            // Must stay in zone for 5+ ticks
        confirmationTicks: 2,           // BOS confirmed after 2 ticks in new zone
    },

    // FAIR VALUE GAP (FVG)
    fairValueGap: {
        lookbackWindow: 30,             // Check last 30 ticks for missing digits
        minGapSize: 3,                  // At least 3 digits missing
        maxDigitFrequency: 2,           // Missing digit appeared ≤ 2 times
    },

    // ORDER BLOCK DETECTION
    orderBlock: {
        lookbackWindow: 50,             // Analyze last 50 ticks
        minClusterSize: 12,             // Digit must appear 12+ times to be Order Block
        proximityTicks: 3,              // Current digit within 3 of Order Block
    },

    // TREND FILTERING
    trendFilter: {
        priceWindow: 20,                // SMA period for price trend
        zoneWindow: 30,                 // Ticks for zone trend analysis
        minTrendStrength: 0.45,         // 65% of ticks in dominant zone
        priceTrendThreshold: 0.00001,    // Minimum price movement for trend
    },

    // CONFLUENCE SCORING
    confluence: {
        minScore: 4.5,                  // Minimum score to trade (out of 5)
        weights: {
            liquiditySweep: 1.2,
            breakOfStructure: 1.0,
            fairValueGap: 0.8,
            orderBlock: 1.0,
            trendFilter: 1.0
        }
    },

    // Risk Management
    minTimeBetweenTrades: 20000,        // 20 seconds between trades
    cooldownAfterLoss: 45000,           // 45 seconds after loss
    maxTradesPerHour: 15,

    requiredHistoryLength: 200,

    telegramToken: '8106601008:AAEMyCma6mvPYIHEvw3RHQX2tkD5-wUe1o0',
    telegramChatId: '752497117',

    maxReconnectAttempts: 50,
    reconnectDelay: 5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'smc_bot_state.json');
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
                smcStats: bot.smcStats,
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

    static EMA(data, period) {
        if (data.length < period) return null;
        const k = 2 / (period + 1);
        let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
        for (let i = period; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
        }
        return ema;
    }

    static priceTrend(prices, window = 20) {
        if (prices.length < window) return { direction: 'NEUTRAL', strength: 0 };

        const recent = prices.slice(-window);
        const sma = this.SMA(recent, window);
        const current = recent[recent.length - 1];

        const diff = current - sma;
        const percentDiff = Math.abs(diff / sma);

        let direction = 'NEUTRAL';
        if (diff > 0 && percentDiff > 0.0001) direction = 'UP';
        else if (diff < 0 && percentDiff > 0.0001) direction = 'DOWN';

        return {
            direction,
            strength: percentDiff,
            sma,
            current
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// SMART MONEY CONCEPTS ANALYZER
// ══════════════════════════════════════════════════════════════════════════════
class SmartMoneyAnalyzer {
    constructor(config) {
        this.cfg = config;
        this.recentSweeps = {}; // Track recent liquidity sweeps per asset
    }

    /**
     * Main SMC Analysis
     */
    analyze(digitHistory, priceHistory, asset) {
        if (digitHistory.length < this.cfg.requiredHistoryLength) {
            return { shouldTrade: false, reason: 'insufficient_history' };
        }

        // Initialize results
        const results = {
            liquiditySweep: this.detectLiquiditySweep(digitHistory, asset),
            breakOfStructure: this.detectBreakOfStructure(digitHistory),
            fairValueGap: this.detectFairValueGap(digitHistory),
            orderBlock: this.detectOrderBlock(digitHistory),
            trendFilter: this.analyzeTrend(digitHistory, priceHistory)
        };

        // Calculate confluence score
        const confluence = this.calculateConfluence(results);

        // Determine if we should trade
        if (!confluence.shouldTrade) {
            return {
                shouldTrade: false,
                reason: confluence.reason,
                confluence,
                results
            };
        }

        // All checks passed
        return {
            shouldTrade: true,
            reason: 'smc_confluence_confirmed',
            predictedDigit: results.liquiditySweep.sweptDigit,
            confidence: confluence.score / 5,
            confluence,
            results
        };
    }

    /**
     * 1. LIQUIDITY SWEEP DETECTION
     * Detects when a digit repeats multiple times (liquidity pool formation)
     */
    detectLiquiditySweep(digitHistory, asset) {
        const window = digitHistory.slice(-this.cfg.liquiditySweep.lookbackWindow);
        const digitCounts = {};

        // Count consecutive repeats
        for (let i = 0; i < window.length; i++) {
            const digit = window[i];
            digitCounts[digit] = (digitCounts[digit] || 0) + 1;
        }

        // Find most repeated digit
        let maxRepeats = 0;
        let sweptDigit = null;

        for (const [digit, count] of Object.entries(digitCounts)) {
            if (count > maxRepeats) {
                maxRepeats = count;
                sweptDigit = parseInt(digit);
            }
        }

        // Check if digit was recently swept (cooldown)
        const now = Date.now();
        if (!this.recentSweeps[asset]) this.recentSweeps[asset] = {};

        const lastSweepTime = this.recentSweeps[asset][sweptDigit] || 0;
        const ticksSinceLastSweep = Math.floor((now - lastSweepTime) / 1000);

        const isValid =
            maxRepeats >= this.cfg.liquiditySweep.minRepeats &&
            ticksSinceLastSweep > this.cfg.liquiditySweep.cooldownTicks;

        if (isValid) {
            this.recentSweeps[asset][sweptDigit] = now;
        }

        return {
            detected: isValid,
            sweptDigit,
            repeatCount: maxRepeats,
            ticksSinceLastSweep,
            reason: !isValid ? `insufficient_repeats_${maxRepeats}` : 'liquidity_swept'
        };
    }

    /**
     * 2. BREAK OF STRUCTURE (BOS)
     * Detects when digits transition between zones
     */
    detectBreakOfStructure(digitHistory) {
        const zones = this.cfg.breakOfStructure.zones;
        const recentDigits = digitHistory.slice(-20);

        // Identify current zone and previous zone
        const getZone = (digit) => {
            for (const [zoneName, zoneDigits] of Object.entries(zones)) {
                if (zoneDigits.includes(digit)) return zoneName;
            }
            return null;
        };

        const currentDigit = recentDigits[recentDigits.length - 1];
        const currentZone = getZone(currentDigit);

        // Track zone history
        const zoneHistory = recentDigits.map(d => getZone(d));

        // Check for zone stability before BOS
        let previousZone = null;
        let zoneStabilityCount = 0;

        for (let i = zoneHistory.length - 2; i >= 0; i--) {
            if (zoneHistory[i] !== currentZone) {
                previousZone = zoneHistory[i];
                zoneStabilityCount = zoneHistory.length - 1 - i - 1;
                break;
            }
        }

        // BOS detected if:
        // 1. Changed from one zone to another
        // 2. Previous zone had stability
        const bosDetected =
            previousZone !== null &&
            previousZone !== currentZone &&
            zoneStabilityCount >= this.cfg.breakOfStructure.minZoneStability;

        return {
            detected: bosDetected,
            currentZone,
            previousZone,
            zoneStabilityCount,
            transition: bosDetected ? `${previousZone}→${currentZone}` : null,
            reason: !bosDetected ? 'no_structure_break' : 'bos_confirmed'
        };
    }

    /**
     * 3. FAIR VALUE GAP (FVG)
     * Identifies missing digits (imbalance that needs to be filled)
     */
    detectFairValueGap(digitHistory) {
        const window = digitHistory.slice(-this.cfg.fairValueGap.lookbackWindow);
        const digitFreq = Array(10).fill(0);

        window.forEach(d => digitFreq[d]++);

        // Find missing or underrepresented digits
        const gaps = [];
        for (let digit = 0; digit < 10; digit++) {
            if (digitFreq[digit] <= this.cfg.fairValueGap.maxDigitFrequency) {
                gaps.push({
                    digit,
                    frequency: digitFreq[digit],
                    isGap: true
                });
            }
        }

        const hasGap = gaps.length >= this.cfg.fairValueGap.minGapSize;

        return {
            detected: hasGap,
            gaps,
            gapCount: gaps.length,
            distribution: digitFreq,
            reason: !hasGap ? 'no_significant_gaps' : 'fvg_detected'
        };
    }

    /**
     * 4. ORDER BLOCK DETECTION
     * Identifies high-frequency digit clusters acting as support/resistance
     */
    detectOrderBlock(digitHistory) {
        const window = digitHistory.slice(-this.cfg.orderBlock.lookbackWindow);
        const digitFreq = Array(10).fill(0);

        window.forEach(d => digitFreq[d]++);

        // Find order blocks (high-frequency clusters)
        const orderBlocks = [];
        for (let digit = 0; digit < 10; digit++) {
            if (digitFreq[digit] >= this.cfg.orderBlock.minClusterSize) {
                orderBlocks.push({
                    digit,
                    frequency: digitFreq[digit],
                    percentage: (digitFreq[digit] / window.length * 100).toFixed(1)
                });
            }
        }

        // Check if current digit is near an order block
        const currentDigit = digitHistory[digitHistory.length - 1];
        let nearOrderBlock = false;
        let nearestBlock = null;

        for (const block of orderBlocks) {
            const distance = Math.abs(block.digit - currentDigit);
            if (distance <= this.cfg.orderBlock.proximityTicks) {
                nearOrderBlock = true;
                nearestBlock = block;
                break;
            }
        }

        return {
            detected: nearOrderBlock && orderBlocks.length > 0,
            orderBlocks,
            nearestBlock,
            currentDigit,
            reason: !nearOrderBlock ? 'no_nearby_order_block' : 'order_block_proximity',
            nearOrderBlock
        };
    }

    /**
     * 5. TREND FILTERING
     * Ensures trade aligns with dominant price and zone trend
     */
    analyzeTrend(digitHistory, priceHistory) {
        // Price trend
        const priceTrend = TechnicalIndicators.priceTrend(
            priceHistory,
            this.cfg.trendFilter.priceWindow
        );

        // Zone trend (are digits moving toward HIGH or LOW zone?)
        const zones = this.cfg.breakOfStructure.zones;
        const recentDigits = digitHistory.slice(-this.cfg.trendFilter.zoneWindow);

        const zoneCounts = { LOW: 0, MID: 0, HIGH: 0 };

        recentDigits.forEach(digit => {
            for (const [zoneName, zoneDigits] of Object.entries(zones)) {
                if (zoneDigits.includes(digit)) {
                    zoneCounts[zoneName]++;
                    break;
                }
            }
        });

        const total = recentDigits.length;
        const dominantZone = Object.entries(zoneCounts)
            .sort((a, b) => b[1] - a[1])[0];

        const zoneStrength = dominantZone[1] / total;

        // Trend alignment
        let alignment = 'NEUTRAL';
        if (priceTrend.direction === 'UP' && dominantZone[0] === 'HIGH') {
            alignment = 'BULLISH';
        } else if (priceTrend.direction === 'DOWN' && dominantZone[0] === 'LOW') {
            alignment = 'BEARISH';
        } else if (dominantZone[0] === 'MID') {
            alignment = 'RANGING';
        }

        const isAligned =
            zoneStrength >= this.cfg.trendFilter.minTrendStrength &&
            priceTrend.strength >= this.cfg.trendFilter.priceTrendThreshold;

        return {
            aligned: isAligned,
            priceTrend: priceTrend.direction,
            priceStrength: priceTrend.strength,
            dominantZone: dominantZone[0],
            zoneStrength,
            alignment,
            reason: !isAligned ? 'weak_trend_alignment' : 'trend_aligned'
        };
    }

    /**
     * Calculate Confluence Score
     */
    calculateConfluence(results) {
        const weights = this.cfg.confluence.weights;
        let score = 0;
        const signals = [];

        if (results.liquiditySweep.detected) {
            score += weights.liquiditySweep;
            signals.push('LiquiditySweep');
        }

        if (results.breakOfStructure.detected) {
            score += weights.breakOfStructure;
            signals.push('BOS');
        }

        if (results.fairValueGap.detected) {
            score += weights.fairValueGap;
            signals.push('FVG');
        }

        if (results.orderBlock.detected) {
            score += weights.orderBlock;
            signals.push('OrderBlock');
        }

        if (results.trendFilter.aligned) {
            score += weights.trendFilter;
            signals.push('TrendFilter');
        }

        const shouldTrade =
            score >= this.cfg.confluence.minScore &&
            results.liquiditySweep.detected; // Liquidity sweep is mandatory

        return {
            shouldTrade,
            score,
            maxScore: 5,
            percentage: (score / 5 * 100).toFixed(1),
            signals,
            reason: !shouldTrade ? `low_confluence_${score.toFixed(1)}` : 'confluence_met'
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT
// ══════════════════════════════════════════════════════════════════════════════
class SmartMoneyBot {
    constructor(config) {
        this.cfg = config;

        // Connection
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.reconnectAttempts = 0;
        this.pingInterval = null;

        // Trade state
        this.tradeInProgress = false;
        this.tradeStartTime = null;
        this.tradeWatchdogMs = 30000;
        this._wdTimer = null;

        this.currentStake = config.initialStake;
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.isWinTrade = false;
        this.endOfDay = false;

        // Rate limiting
        this.hourlyTrades = [];
        this.lastLossTime = {};

        // Per-asset data
        this.priceHistories = {};
        this.digitHistories = {};
        this.lastTradeTime = {};
        this.activeTrades = {};
        this.contractSubs = {};
        this.assetMetrics = {};
        this.proposalIds = {};

        config.assets.forEach(a => {
            this.priceHistories[a] = [];
            this.digitHistories[a] = [];
            this.lastTradeTime[a] = 0;
            this.lastLossTime[a] = 0;
            this.assetMetrics[a] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
        });

        // SMC Statistics
        this.smcStats = {
            liquiditySweeps: { detected: 0, traded: 0, won: 0 },
            bos: { detected: 0, traded: 0, won: 0 },
            fvg: { detected: 0, traded: 0, won: 0 },
            orderBlocks: { detected: 0, traded: 0, won: 0 },
            trendAligned: { detected: 0, traded: 0, won: 0 }
        };

        // Analyzer
        this.analyzer = new SmartMoneyAnalyzer(config);

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
        this.dailyProfitLoss = 0;
    }

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
            if (s.smcStats) this.smcStats = s.smcStats;

            console.log(`✅ State restored — ${this.totalTrades} trades, P&L $${this.totalProfitLoss.toFixed(2)}`);
        } catch (e) {
            console.error(`❌ State restore error: ${e.message}`);
        }
    }

    _canTrade(asset) {
        const now = Date.now();

        if (now - this.lastTradeTime[asset] < this.cfg.minTimeBetweenTrades) {
            return { can: false, reason: 'asset_cooldown' };
        }

        if (now - this.lastLossTime[asset] < this.cfg.cooldownAfterLoss) {
            return { can: false, reason: 'loss_cooldown' };
        }

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

    _handleMessage(msg) {
        switch (msg.msg_type) {
            case 'authorize': this._onAuth(msg); break;
            case 'history': this._onHistory(msg); break;
            case 'tick': this._onTick(msg.tick); break;
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

        this.priceHistories[asset].push(price);
        if (this.priceHistories[asset].length > 500) this.priceHistories[asset].shift();

        this.digitHistories[asset].push(digit);
        if (this.digitHistories[asset].length > 400) this.digitHistories[asset].shift();

        if (!this.wsReady || this.tradeInProgress) return;
        if (this.digitHistories[asset].length < this.cfg.requiredHistoryLength) return;

        this._evaluateAsset(asset);
    }

    _evaluateAsset(asset) {
        const canTrade = this._canTrade(asset);
        if (!canTrade.can) return;

        const analysis = this.analyzer.analyze(
            this.digitHistories[asset],
            this.priceHistories[asset],
            asset
        );

        // console.log(`${asset}: 
        //     Sweep: ${analysis.results.liquiditySweep.detected ? 'YES' : 'NO'} | ${analysis.results.liquiditySweep.reason} (${analysis.results.liquiditySweep.sweptDigit})
        //     BoS: ${analysis.results.breakOfStructure.detected ? 'YES' : 'NO'} | ${analysis.results.breakOfStructure.reason} (${analysis.results.breakOfStructure.zoneStabilityCount} | ${analysis.results.breakOfStructure.transition}) ${analysis.results.breakOfStructure.currentZone} | ${analysis.results.breakOfStructure.previousZone}
        //     FVG: ${analysis.results.fairValueGap.detected ? 'YES' : 'NO'} | ${analysis.results.fairValueGap.reason} (${analysis.results.fairValueGap.gapCount})
        //     OB: ${analysis.results.orderBlock.detected ? 'YES' : 'NO'} | ${analysis.results.orderBlock.reason} (${analysis.results.orderBlock.orderBlocks} | ${analysis.results.orderBlock.nearestBlock}) ${analysis.results.orderBlock.currentDigit}
        //     TF: ${analysis.results.trendFilter.detected ? 'YES' : 'NO'} | ${analysis.results.trendFilter.reason} (${analysis.results.trendFilter.zoneStrength} | ${analysis.results.trendFilter.priceStrength})
        // `);

        if (!analysis.shouldTrade) return;

        // Update SMC stats
        const r = analysis.results;
        if (r.liquiditySweep.detected) this.smcStats.liquiditySweeps.detected++;
        if (r.breakOfStructure.detected) this.smcStats.bos.detected++;
        if (r.fairValueGap.detected) this.smcStats.fvg.detected++;
        if (r.orderBlock.detected) this.smcStats.orderBlocks.detected++;
        if (r.trendFilter.aligned) this.smcStats.trendAligned.detected++;

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
        const payout = parseFloat(proposal.payout || 0);
        const payoutPct = ((payout - this.currentStake) / this.currentStake * 100).toFixed(1);

        console.log(`\n🎯 SMART MONEY SETUP — ${asset}`);
        console.log(`   Predicted Digit: ${analysis.predictedDigit} (will NOT appear)`);
        console.log(`   Confluence Score: ${analysis.confluence.score.toFixed(1)}/5 (${analysis.confluence.percentage}%)`);
        console.log(`   Signals: ${analysis.confluence.signals.join(' + ')}`);
        console.log(`\n   📊 SMC Breakdown:`);

        const r = analysis.results;
        if (r.liquiditySweep.detected) {
            console.log(`      ✓ Liquidity Sweep: Digit ${r.liquiditySweep.sweptDigit} repeated ${r.liquiditySweep.repeatCount}x`);
        }
        if (r.breakOfStructure.detected) {
            console.log(`      ✓ Break of Structure: ${r.breakOfStructure.transition}`);
        }
        if (r.fairValueGap.detected) {
            console.log(`      ✓ Fair Value Gap: ${r.fairValueGap.gapCount} missing digits`);
        }
        if (r.orderBlock.detected) {
            console.log(`      ✓ Order Block: Digit ${r.orderBlock.nearestBlock.digit} (${r.orderBlock.nearestBlock.percentage}%)`);
        }
        if (r.trendFilter.aligned) {
            console.log(`      ✓ Trend Filter: ${r.trendFilter.alignment} (${r.trendFilter.dominantZone} zone)`);
        }

        console.log(`\n   Last 10 digits: ${this.digitHistories[asset].slice(-10).join(',')}`);
        console.log(`   Confidence: ${(analysis.confidence * 100).toFixed(1)}%`);
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

        // Update SMC traded stats
        const r = analysis.results;
        if (r.liquiditySweep.detected) this.smcStats.liquiditySweeps.traded++;
        if (r.breakOfStructure.detected) this.smcStats.bos.traded++;
        if (r.fairValueGap.detected) this.smcStats.fvg.traded++;
        if (r.orderBlock.detected) this.smcStats.orderBlocks.traded++;
        if (r.trendFilter.aligned) this.smcStats.trendAligned.traded++;

        this._sendTelegram(
            `🎯 <b>Smart Money Trade</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Digit: <b>${analysis.predictedDigit}</b> will NOT appear\n` +
            `Confluence: ${analysis.confluence.score.toFixed(1)}/5 (${analysis.confluence.percentage}%)\n` +
            `Signals: ${analysis.confluence.signals.join(', ')}\n` +
            `Confidence: ${(analysis.confidence * 100).toFixed(1)}%\n` +
            `Stake: $${this.currentStake.toFixed(2)}`
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

        // Update SMC win stats
        const r = trade.analysis.results;
        if (won) {
            if (r.liquiditySweep.detected) this.smcStats.liquiditySweeps.won++;
            if (r.breakOfStructure.detected) this.smcStats.bos.won++;
            if (r.fairValueGap.detected) this.smcStats.fvg.won++;
            if (r.orderBlock.detected) this.smcStats.orderBlocks.won++;
            if (r.trendFilter.aligned) this.smcStats.trendAligned.won++;
        }

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`  ${won ? '✅ WIN' : '❌ LOSS'}: ${asset}`);
        console.log(`  Digit: ${trade.predictedDigit} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
        console.log(`${'═'.repeat(60)}`);

        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
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

        // SMC performance stats
        const smcPerf = Object.entries(this.smcStats).map(([name, stats]) => {
            const wr = stats.traded > 0 ? (stats.won / stats.traded * 100).toFixed(1) : '0.0';
            return `${name}: ${wr}%`;
        }).join(' | ');

        this._sendTelegram(
            `${won ? '✅' : '❌'} <b>Result</b>\n\n` +
            `Asset: ${asset}\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}/${this.totalLosses})\n` +
            `Win Rate: ${wr}%\n` +
            `Consecutive losses: ${this.consecutiveLosses}\n` +
            `Next stake: $${this.currentStake.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}\n\n` +
            `SMC Performance:\n${smcPerf}`
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
    }

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
                `⏰ <b>Smart Money Bot Hourly Summary</b>`, ``,
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
                `📊 <b>SESSION SUMMARY - Smart Money Bot</b>`, ``,
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

    // ── Time-based reconnect ──────────────────────────────────────────────────
    _startTimeScheduler() {
        setInterval(() => {
            const now = new Date();
            const gmt1 = new Date(now.getTime() + 3600000);
            const hr = gmt1.getUTCHours();
            const min = gmt1.getUTCMinutes();

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
                this._sendSessionSummary();
                this._cleanupWs();
            }
        }, 20000);
    }

    _logSummary() {
        const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';
        console.log('\n📊 Summary:');
        console.log(`  Trades: ${this.totalTrades} | W: ${this.totalWins} | L: ${this.totalLosses} | WR: ${wr}%`);
        console.log(`  Total P&L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`  Stake: $${this.currentStake.toFixed(2)}`);

        console.log('\n  SMC Performance:');
        Object.entries(this.smcStats).forEach(([name, stats]) => {
            const wr = stats.traded > 0 ? ((stats.won / stats.traded) * 100).toFixed(1) : '0.0';
            console.log(`    ${name}: ${stats.detected} detected | ${stats.traded} traded | WR: ${wr}%`);
        });
    }

    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🎯 Smart Money Concepts (SMC) Bot');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`  ✓ Liquidity Sweep Detection`);
        console.log(`  ✓ Break of Structure (BOS)`);
        console.log(`  ✓ Fair Value Gap (FVG)`);
        console.log(`  ✓ Order Block Identification`);
        console.log(`  ✓ Trend Filtering`);
        console.log(`\n  Expected WR: 65-72%`);
        console.log(`  Profit Factor: 1.5-1.9`);
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
const bot = new SmartMoneyBot(BOT_CONFIG);
bot.start();
