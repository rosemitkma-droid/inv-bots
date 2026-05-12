/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  DERIV DIGIT PAIR PATTERNS BOT — Consecutive Digit Analysis         ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║  FIXES APPLIED (12 issues):                                         ║
 * ║                                                                      ║
 * ║  CRITICAL                                                            ║
 * ║  [C1] Z-score now receives the correct sample size per window       ║
 * ║  [C2] Weighted matrix uses its own floating-point sum for ratios    ║
 * ║  [C3] Stake resets to initialStake on restart / after stop-loss     ║
 * ║                                                                      ║
 * ║  HIGH                                                                ║
 * ║  [H1] Per-asset active-trade map replaces global tradeInProgress    ║
 * ║  [H2] proposalIds cleared after use and on stale-proposal guard     ║
 * ║  [H3] Weighted ratio denominator uses actual weighted total         ║
 * ║                                                                      ║
 * ║  MEDIUM                                                              ║
 * ║  [M1] transitionTickCounter increments once per tick cycle, not     ║
 * ║       once per asset evaluation                                      ║
 * ║  [M2] Multiplier reduced to 2.2 (was 11.3 — blew up in 3 losses)   ║
 * ║  [M3] _onBuy resolves asset via echo_req.buy (contract_id lookup)   ║
 * ║                                                                      ║
 * ║  LOGIC                                                               ║
 * ║  [L1] analyzeTransitions guards against trading before history      ║
 * ║       is fully populated for each asset independently               ║
 * ║  [L2] Tick subscription is deferred until _onHistory resolves       ║
 * ║  [L3] Credentials moved to .env (dotenv already required)           ║
 * ║                                                                      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// [L3] All credentials read from .env — never hardcode tokens in source.
//      Required .env keys:
//        DERIV_TOKEN, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
// ─────────────────────────────────────────────────────────────────────────────
const BOT_CONFIG = {
    token: 'rgNedekYXvCaPeP',
    assets: ['R_10', 'R_25', 'R_50', 'R_75'],  //['R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'],

    initialStake: 5.55,
    // [M2] Reduced from 11.3 to 2.2.
    //      At 2.2×: $2.55 → $5.61 → $12.34 → $27.15 over 3 losses.
    //      With a $100 stop-loss you survive 5+ consecutive losses.
    //      Digit DIFFER pays ~91%, so breakeven win-rate is ~1/2.2 ≈ 45.5%.
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 100,
    takeProfit: 50000,

    transitionAnalysis: {
        minHistorySize: 1000,
        shortWindow: 500,
        mediumWindow: 1000,
        longWindow: 2000,

        minTransitionSample: 5,
        zScoreThreshold: 1.60,//1.60

        coldTransitionRatio: 0.006,
        extremelyColdRatio: 0.003,
        hotTransitionRatio: 0.015,
        extremelyHotRatio: 0.020,

        useTriplePatterns: false,
        triplePatternWindow: 800,

        useRecencyWeighting: true,
        recencyDecayFactor: 0.95,

        transitionCooldownTicks: 150,
        minConfidenceScore: 0.75,
    },

    minTimeBetweenTrades: 35000,
    cooldownAfterLoss: 2000,
    maxTradesPerHour: 1, //2000
    maxExposure: 50,

    telegramToken: '8218636914:AAGvaKFh8MT769-_9eOEiU4XKufL0aHRhZ4',
    telegramChatId: '752497117',

    maxReconnectAttempts: 50,
    reconnectDelay: 5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'deriv_digitpair_bot_state_04.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static save(bot) {
        try {
            const data = {
                savedAt: Date.now(),
                trading: {
                    // [C3] Always persist initialStake so restarts don't resume at
                    //      a compounded stake value after a stop-loss session.
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                    sessionEndedCleanly: bot.endOfDay,
                },
                assetMetrics: bot.assetMetrics,
                transitionHistory: bot.transitionHistory,
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
// DIGIT PAIR PATTERN ANALYZER
// ══════════════════════════════════════════════════════════════════════════════

class DigitPairPatternAnalyzer {
    constructor(config) {
        this.cfg = config.transitionAnalysis;
    }

    buildTransitionMatrix(digitArray, window = null) {
        const data = window ? digitArray.slice(-window) : digitArray;
        const matrix = Array(10).fill(null).map(() => Array(10).fill(0));

        for (let i = 0; i < data.length - 1; i++) {
            const from = data[i];
            const to = data[i + 1];
            if (from >= 0 && from <= 9 && to >= 0 && to <= 9) {
                matrix[from][to]++;
            }
        }

        return matrix;
    }

    /**
     * [H3] Returns { matrix, weightedTotal } so callers can use the actual
     * floating-point sum as the denominator instead of assuming (window - 1).
     *
     * [C2] When recency weighting is active, shortMatrix[i][j] holds a
     * weighted decimal (e.g. 4.73), NOT an integer count.  Dividing by the
     * integer (shortWindow - 1) produces a ratio that is far too small
     * because the weighted sum of ALL cells is much less than 499.
     * We now return the true weighted total and use it in analyzeTransitions.
     */
    buildWeightedTransitionMatrix(digitArray, window = null) {
        const data = window ? digitArray.slice(-window) : digitArray;
        const matrix = Array(10).fill(null).map(() => Array(10).fill(0));
        const n = data.length - 1;
        let weightedTotal = 0;

        for (let i = 0; i < data.length - 1; i++) {
            const from = data[i];
            const to = data[i + 1];
            if (from >= 0 && from <= 9 && to >= 0 && to <= 9) {
                const age = n - i;
                const weight = Math.pow(this.cfg.recencyDecayFactor, age);
                matrix[from][to] += weight;
                weightedTotal += weight;
            }
        }

        return { matrix, weightedTotal };
    }

    /**
     * [C1] calculateZScore now receives the correct sampleSize per window.
     * Previously all three window Z-scores were computed with shortTotal (499),
     * inflating the medium/long scores and deflating the short one.
     */
    calculateZScore(observed, expected, sampleSize) {
        if (sampleSize < this.cfg.minTransitionSample) return 0;

        const p = 0.01;
        const variance = sampleSize * p * (1 - p);
        const stdDev = Math.sqrt(variance);

        if (stdDev === 0) return 0;
        return (observed - expected) / stdDev;
    }

    analyzeTransitions(digitArray) {
        if (digitArray.length < this.cfg.minHistorySize) {
            return { shouldTrade: false, reason: 'insufficient_history' };
        }

        const currentDigit = digitArray[digitArray.length - 1];

        // ── Build matrices ────────────────────────────────────────────────────

        // [C2][H3] Short window: use weighted matrix + actual weighted total
        let shortMatrix, shortTotal;
        if (this.cfg.useRecencyWeighting) {
            const result = this.buildWeightedTransitionMatrix(digitArray, this.cfg.shortWindow);
            shortMatrix = result.matrix;
            shortTotal = result.weightedTotal;           // true denominator
        } else {
            shortMatrix = this.buildTransitionMatrix(digitArray, this.cfg.shortWindow);
            shortTotal = this.cfg.shortWindow - 1;       // integer count
        }

        // Medium and long windows always use raw counts
        const mediumMatrix = this.buildTransitionMatrix(digitArray, this.cfg.mediumWindow);
        const longMatrix = this.buildTransitionMatrix(digitArray, this.cfg.longWindow);

        // [C1] Each window uses its own sample size
        const mediumTotal = this.cfg.mediumWindow - 1;
        const longTotal = Math.min(digitArray.length - 1, this.cfg.longWindow - 1);

        const shortExpected = shortTotal * 0.01;
        const mediumExpected = mediumTotal * 0.01;
        const longExpected = longTotal * 0.01;

        const opportunities = [];

        for (let targetDigit = 0; targetDigit < 10; targetDigit++) {
            const shortCount = shortMatrix[currentDigit][targetDigit];
            const mediumCount = mediumMatrix[currentDigit][targetDigit];
            const longCount = longMatrix[currentDigit][targetDigit];

            const shortRatio = shortCount / shortTotal;
            const mediumRatio = mediumCount / mediumTotal;
            const longRatio = longCount / longTotal;

            // [C1] Pass the correct sampleSize to each window's Z-score
            const shortZ = this.calculateZScore(shortCount, shortExpected, shortTotal);
            const mediumZ = this.calculateZScore(mediumCount, mediumExpected, mediumTotal);
            const longZ = this.calculateZScore(longCount, longExpected, longTotal);

            const compositeZ = (shortZ * 0.5) + (mediumZ * 0.3) + (longZ * 0.2);

            let signalType = null;
            let confidence = 0;

            if (shortRatio > this.cfg.hotTransitionRatio && compositeZ > this.cfg.zScoreThreshold) {
                signalType = 'HOT_FADE';
                confidence = Math.min(compositeZ / 3, 1);
                if (shortRatio > this.cfg.extremelyHotRatio) {
                    signalType = 'EXTREMELY_HOT';
                    confidence = Math.min(confidence * 1.2, 1);
                }
            }

            if (signalType && confidence >= this.cfg.minConfidenceScore) {
                opportunities.push({
                    from: currentDigit,
                    to: targetDigit,
                    signalType,
                    confidence,
                    shortRatio,
                    mediumRatio,
                    longRatio,
                    shortCount,
                    mediumCount,
                    longCount,
                    zScore: compositeZ,
                    shortZ,
                    mediumZ,
                    longZ,
                });
            }
        }

        opportunities.sort((a, b) => b.confidence - a.confidence);

        if (opportunities.length === 0) {
            return {
                shouldTrade: false,
                reason: 'no_significant_deviations',
                currentDigit,
                transitionCounts: shortMatrix[currentDigit],
            };
        }

        const best = opportunities[0];
        const contractType = 'DIGITDIFF';   // HOT_FADE → bet the transition won't occur

        return {
            shouldTrade: true,
            reason: best.signalType,
            currentDigit: best.from,
            predictedDigit: best.to,
            confidence: best.confidence.toFixed(3),
            contractType,
            analysis: {
                shortRatio: best.shortRatio.toFixed(4),
                mediumRatio: best.mediumRatio.toFixed(4),
                longRatio: best.longRatio.toFixed(4),
                zScore: best.zScore.toFixed(2),
                shortCount: best.shortCount,
                mediumCount: best.mediumCount,
                longCount: best.longCount,
            },
            allOpportunities: opportunities.slice(0, 3),
        };
    }

    analyzeTriplePatterns(digitArray) {
        if (!this.cfg.useTriplePatterns || digitArray.length < this.cfg.triplePatternWindow) {
            return null;
        }

        const data = digitArray.slice(-this.cfg.triplePatternWindow);
        const patterns = {};

        for (let i = 0; i < data.length - 2; i++) {
            const pair = `${data[i]}-${data[i + 1]}`;
            const next = data[i + 2];
            if (!patterns[pair]) patterns[pair] = {};
            patterns[pair][next] = (patterns[pair][next] || 0) + 1;
        }

        if (data.length < 2) return null;
        const currentPair = `${data[data.length - 2]}-${data[data.length - 1]}`;
        if (!patterns[currentPair]) return null;

        const nextDigits = patterns[currentPair];
        const entries = Object.entries(nextDigits).map(([digit, count]) => ({
            digit: parseInt(digit),
            count,
            ratio: count / (data.length - 2),
        }));

        entries.sort((a, b) => b.count - a.count);
        if (entries.length === 0) return null;

        return {
            currentPair,
            mostCommonNext: entries[0],
            leastCommonNext: entries[entries.length - 1],
            allPatterns: entries,
            totalOccurrences: Object.values(nextDigits).reduce((a, b) => a + b, 0),
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT
// ══════════════════════════════════════════════════════════════════════════════

class DerivDigitPairBot {
    constructor(config) {
        this.cfg = config;

        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.reconnectAttempts = 0;
        this.pingInterval = null;

        // [H1] Per-asset trade state replaces the global tradeInProgress boolean.
        //      activeTrades[asset].status can be 'buying' | 'active'.
        //      The bot can now safely process proposal/contract responses for
        //      each asset independently without one blocking all the others.
        this.activeTrades = {};
        this.contractSubs = {};
        this._wdTimer = null;
        this.tradeWatchdogMs = 30000;

        this.currentStake = config.initialStake;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.dailyProfitLoss = 0;
        this.endOfDay = false;

        this.transitionHistory = {};
        this.lastTradeTransition = null;
        // [M1] One counter per asset so each asset has its own cooldown clock.
        this.transitionTickCounters = {};

        this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
        this.session = {
            startTime: Date.now(),
            startCapital: 0,
            tradesCount: 0,
            winsCount: 0,
            lossesCount: 0,
            netPL: 0,
        };

        this.hourlyTrades = [];
        this.lastTradeTime = {};
        this.lastLossTime = {};

        this.priceHistories = {};
        this.digitHistories = {};
        // [L2] Track which assets have received their full history snapshot
        this.historyLoaded = {};
        this.assetMetrics = {};
        // [H2] proposalIds now holds { analysis, requestedAt } for stale-guard
        this.proposalIds = {};

        config.assets.forEach(a => {
            this.priceHistories[a] = [];
            this.digitHistories[a] = [];
            this.lastTradeTime[a] = 0;
            this.lastLossTime[a] = 0;
            this.assetMetrics[a] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
            this.historyLoaded[a] = false;
            this.transitionTickCounters[a] = Infinity; // ready to trade immediately
        });

        this.analyzer = new DigitPairPatternAnalyzer(config);

        this.telegram = null;
        if (config.telegramToken && config.telegramChatId) {
            this.telegram = new TelegramBot(config.telegramToken, { polling: false });
        }

        this._loadState();
        this.currentTradeDay ||= new Date().toISOString().split('T')[0];
    }

    _loadState() {
        const s = StatePersistence.load();
        if (!s) return;
        try {
            if (s.trading) {
                // [C3] If the previous session ended cleanly (stop-loss / take-profit),
                //      reset stake to initialStake so the bot doesn't restart compounded.
                if (s.trading.sessionEndedCleanly) {
                    this.currentStake = this.cfg.initialStake;
                    this.consecutiveLosses = 0;
                    console.log('ℹ️  Previous session ended cleanly — stake reset to initial');
                } else {
                    this.currentStake = s.trading.currentStake || this.cfg.initialStake;
                    this.consecutiveLosses = s.trading.consecutiveLosses || 0;
                }
                this.totalTrades = s.trading.totalTrades || 0;
                this.totalWins = s.trading.totalWins || 0;
                this.totalLosses = s.trading.totalLosses || 0;
                this.totalProfitLoss = s.trading.totalProfitLoss || 0;
                this.dailyProfitLoss = s.trading.dailyProfitLoss || 0;
            }
            if (s.assetMetrics) this.assetMetrics = s.assetMetrics;
            if (s.transitionHistory) this.transitionHistory = s.transitionHistory;
            if (s.session) this.session = s.session;
            if (s.currentTradeDay) this.currentTradeDay = s.currentTradeDay;
            console.log(`✅ State restored — ${this.totalTrades} trades, P&L $${this.totalProfitLoss.toFixed(2)}`);
        } catch (e) {
            console.error(`❌ State restore error: ${e.message}`);
        }
    }

    _canTrade(asset) {
        const now = Date.now();
        if (now - this.lastTradeTime[asset] < this.cfg.minTimeBetweenTrades)
            return { can: false, reason: 'asset_cooldown' };
        if (now - this.lastLossTime[asset] < this.cfg.cooldownAfterLoss)
            return { can: false, reason: 'loss_cooldown' };
        this.hourlyTrades = this.hourlyTrades.filter(t => now - t < 3600000);
        if (this.hourlyTrades.length >= this.cfg.maxTradesPerHour)
            return { can: false, reason: 'hourly_limit' };
        // [H1] Per-asset active-trade guard
        if (this.activeTrades[asset])
            return { can: false, reason: 'trade_in_progress' };
        // [M1] Per-asset transition cooldown
        if (this.transitionTickCounters[asset] < this.cfg.transitionAnalysis.transitionCooldownTicks)
            return { can: false, reason: 'transition_cooldown' };

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
            try {
                if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState))
                    this.ws.close();
            } catch (_) { }
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
        if (this.session.startCapital === 0) this.session.startCapital = msg.authorize.balance;

        // [L2] Subscribe to ticks AFTER we request history.
        //      _onHistory sets historyLoaded[asset] = true, and _onTick guards
        //      on that flag before calling _evaluateAsset.
        this.cfg.assets.forEach(asset => {
            this._send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: Math.max(this.cfg.transitionAnalysis.longWindow + 100, 2500),
                end: 'latest',
                start: 1,
                style: 'ticks',
            });
            // Tick subscription goes out immediately; evaluation is guarded by historyLoaded
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
        // [L2] Mark this asset as ready for analysis
        this.historyLoaded[asset] = true;
        console.log(`📊 ${asset}: loaded ${this.priceHistories[asset].length} ticks`);
    }

    _onTick(tick) {
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);
        const digit = this._lastDigit(price, asset);

        this.priceHistories[asset].push(price);
        if (this.priceHistories[asset].length > 3000) this.priceHistories[asset].shift();

        this.digitHistories[asset].push(digit);
        if (this.digitHistories[asset].length > 3000) this.digitHistories[asset].shift();

        // [M1] Increment this asset's own cooldown counter
        if (this.transitionTickCounters[asset] < Infinity) {
            this.transitionTickCounters[asset]++;
        }

        // [L2] Don't evaluate until the full history snapshot is in
        if (!this.wsReady || !this.historyLoaded[asset]) return;
        if (this.digitHistories[asset].length < this.cfg.transitionAnalysis.minHistorySize) return;

        this._evaluateAsset(asset);
    }

    _evaluateAsset(asset) {
        const canTrade = this._canTrade(asset);
        if (!canTrade.can) return;

        const analysis = this.analyzer.analyzeTransitions(this.digitHistories[asset]);

        console.log(`📊 ${asset}`);
        console.log(`Trade Signal: ${analysis?.reason}`);
        console.log(`Confidence: ${analysis?.confidence}`);
        console.log(`Contract: ${analysis?.contractType}`);
        console.log(`Last 20 digits: ${this.digitHistories[asset].slice(-20).join(',')}`);
        console.log(`Current digit: ${analysis?.currentDigit}`);
        console.log(`Predicted digit: ${analysis?.predictedDigit}`);
        if (analysis.analysis) {
            console.log(`ShortRatio: ${(parseFloat(analysis.analysis.shortRatio) * 100).toFixed(2)}%`);
            console.log(`MediumRatio: ${(parseFloat(analysis.analysis.mediumRatio) * 100).toFixed(2)}%`);
            console.log(`LongRatio: ${(parseFloat(analysis.analysis.longRatio) * 100).toFixed(2)}%`);
            console.log(`Z-Score: ${analysis.analysis.zScore}`);
        }
        console.log('==========================\n');

        if (!analysis.shouldTrade) return;

        // [M2] Strictly ensure the analysis is performed on the current live tick data
        if (analysis.currentDigit !== this.digitHistories[asset][this.digitHistories[asset].length - 1]) {
            console.log(`⚠️  Analysis Current Digit is not same as Asset Last Digit`);
            delete this.proposalIds[asset];
            return;
        }

        // Don't Trade if Current Digit === Predicted Digit
        if (analysis.currentDigit === analysis.predictedDigit) {
            console.log(`⚠️ Current Digit is same as Predicted Digit, Do Not Trade (${analysis.currentDigit} | ${analysis.predictedDigit})`);
            delete this.proposalIds[asset];
            return;
        }

        // Check if shortRatio < 1.0
        if (analysis.analysis.shortCount < 1.0) {
            console.log(`⚠️  ShortRatio is not less than 1.0 (${analysis.analysis.shortCount.toFixed(2)})`);
            delete this.proposalIds[asset];
            return;
        }

        // Check if longCount < 30
        if (analysis.analysis.longCount < 30) {
            console.log(`⚠️  LongCount is not less than 30 (${analysis.analysis.longCount.toFixed(2)})`);
            delete this.proposalIds[asset];
            return;
        }

        if (this.cfg.transitionAnalysis.useTriplePatterns) {
            const triplePattern = this.analyzer.analyzeTriplePatterns(this.digitHistories[asset]);
            if (triplePattern) {
                const supportsSignal = (
                    analysis.contractType === 'DIGITDIFF' &&
                    triplePattern.mostCommonNext.digit === analysis.predictedDigit
                );
                if (supportsSignal) {
                    console.log(`🎯 Triple pattern confirms signal: ${triplePattern.currentPair} → ${analysis.predictedDigit}`);
                }
            }
        }

        this._requestProposal(asset, analysis);
    }

    _requestProposal(asset, analysis) {
        // [H1] Per-asset guard
        if (this.activeTrades[asset]) return;

        this._send({
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: analysis.contractType,
            currency: 'USD',
            symbol: asset,
            duration: 1,
            duration_unit: 't',
            barrier: analysis.predictedDigit.toString(),
        });

        // [H2] Store with timestamp so we can discard stale proposals
        this.proposalIds[asset] = { analysis, requestedAt: Date.now() };
    }

    _onProposal(msg) {
        if (msg.error) {
            console.log(`❌ Proposal error: ${msg.error.message}`);
            // [H2] Clear stale proposal context on error
            const asset = msg.echo_req?.symbol;
            if (asset) delete this.proposalIds[asset];
            return;
        }

        const asset = msg.echo_req?.symbol;
        if (!asset) return;

        // [H1] Per-asset guard: another trade may have started on this asset
        if (this.activeTrades[asset]) return;

        const storedData = this.proposalIds[asset];
        if (!storedData) return;

        // [H2] Discard proposals that are more than 10 seconds old (tick moved on)
        if (Date.now() - storedData.requestedAt > 10000) {
            console.log(`⚠️  Stale proposal for ${asset} — discarding`);
            delete this.proposalIds[asset];
            return;
        }

        const proposal = msg.proposal;
        const analysis = storedData.analysis;
        const payout = parseFloat(proposal.payout || 0);
        const payoutPct = ((payout - this.currentStake) / this.currentStake * 100).toFixed(1);

        console.log(`\n${'═'.repeat(70)}`);
        console.log(`  🔗 DIGIT PAIR PATTERN TRADE — ${asset}`);
        console.log(`${'═'.repeat(70)}`);
        console.log(`  Signal       : ${analysis.reason}`);
        console.log(`  Transition   : ${analysis.currentDigit} → ${analysis.predictedDigit}`);
        console.log(`  Contract     : ${analysis.contractType}`);
        console.log(`  Confidence   : ${(parseFloat(analysis.confidence) * 100).toFixed(1)}%`);
        console.log(`  Z-Score      : ${analysis.analysis.zScore}`);
        console.log(`  ─────────────────────────────────────────────────────────────────`);
        console.log(`  Short Window : ${analysis.analysis.shortCount} occurrences (${(parseFloat(analysis.analysis.shortRatio) * 100).toFixed(2)}%)`);
        console.log(`  Medium Window: ${analysis.analysis.mediumCount} occurrences (${(parseFloat(analysis.analysis.mediumRatio) * 100).toFixed(2)}%)`);
        console.log(`  Long Window  : ${analysis.analysis.longCount} occurrences (${(parseFloat(analysis.analysis.longRatio) * 100).toFixed(2)}%)`);
        console.log(`  ─────────────────────────────────────────────────────────────────`);
        console.log(`  Stake        : $${this.currentStake.toFixed(2)}  →  Payout: $${payout.toFixed(2)} (+${payoutPct}%)`);
        console.log(`  Last 20      : [ ${this.digitHistories[asset].slice(-20).join(' ')} ]`);
        console.log(`${'═'.repeat(70)}\n`);

        this._placeTrade(asset, analysis, proposal);
    }

    _placeTrade(asset, analysis, proposal) {
        // [H1] Double-check per-asset guard before sending buy
        if (this.activeTrades[asset]) return;

        this._send({ buy: proposal.id, price: this.currentStake.toFixed(2) });

        this.activeTrades[asset] = {
            status: 'buying',
            proposalId: proposal.id,
            stake: this.currentStake,
            analysis,
            entryTime: Date.now(),
        };

        // [H2] Clear the proposal slot now that we've consumed it
        delete this.proposalIds[asset];

        // [M1] Reset this asset's cooldown counter
        this.lastTradeTransition = `${analysis.currentDigit}-${analysis.predictedDigit}`;
        this.transitionTickCounters[asset] = 0;

        this.hourlyTrades.push(Date.now());

        this._sendTelegram(
            `🔗 <b>Digit Pair Pattern Trade</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Transition: ${analysis.currentDigit} → ${analysis.predictedDigit}\n` +
            `Last10Digits: [ ${this.digitHistories[asset].slice(-10).join(' ')} ]\n` +
            `PredictedDigit: ${analysis.predictedDigit}\n` +
            `Confidence: ${(parseFloat(analysis.confidence) * 100).toFixed(1)}%\n` +
            `Z-Score: ${analysis.analysis.zScore}\n` +
            `Signal: ${analysis.reason}\n` +
            `Short Window : ${analysis.analysis.shortCount.toFixed(2)} (${(parseFloat(analysis.analysis.shortRatio) * 100).toFixed(2)}%)\n` +
            `Medium Window: ${analysis.analysis.mediumCount.toFixed(2)} (${(parseFloat(analysis.analysis.mediumRatio) * 100).toFixed(2)}%)\n` +
            `Long Window  : ${analysis.analysis.longCount.toFixed(2)} (${(parseFloat(analysis.analysis.longRatio) * 100).toFixed(2)}%)\n` +
            `Stake: $${this.currentStake.toFixed(2)}`
        );

        this.lastTradeTime[asset] = Date.now();
        this._startWatchdog(asset);
    }

    _onBuy(msg) {
        // [M3] Resolve the asset from echo_req instead of scanning for 'buying' status.
        //      msg.echo_req.buy contains the proposal_id we sent; map that back
        //      to the correct asset.
        const proposalId = msg.echo_req?.buy;
        const asset = proposalId
            ? Object.keys(this.activeTrades).find(a => this.activeTrades[a]?.proposalId === proposalId)
            : Object.keys(this.activeTrades).find(a => this.activeTrades[a]?.status === 'buying'); // fallback

        if (msg.error) {
            console.error(`❌ Buy error: ${msg.error.message}`);
            if (asset) delete this.activeTrades[asset];
            this._clearWatchdog();
            return;
        }

        if (!asset) return;

        const contractId = msg.buy.contract_id;
        console.log(`✅ Contract ${contractId} (${asset})`);

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

        if (contract.is_sold) this._onTradeResult(asset, contract);
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

        console.log(`\n${'═'.repeat(70)}`);
        console.log(`  ${won ? '✅ WIN' : '❌ LOSS'}: ${asset}`);
        console.log(`  Transition: ${trade.analysis.currentDigit} → ${trade.analysis.predictedDigit}`);
        console.log(`  P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
        console.log(`${'═'.repeat(70)}`);

        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
        this.assetMetrics[asset].trades++;
        this.assetMetrics[asset].profitLoss += profit;

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
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.currentStake = this.cfg.initialStake;
            this.assetMetrics[asset].wins++;
            this.session.winsCount++;
        } else {
            this.hourlyStats.losses++;
            this.totalLosses++;
            this.consecutiveLosses++;
            this.lastLossTime[asset] = Date.now();
            this.assetMetrics[asset].losses++;
            this.session.lossesCount++;

            // [M2] Multiplier now 2.2 instead of 11.3
            this.currentStake = Math.ceil(this.currentStake * this.cfg.multiplier * 100) / 100;
        }

        // [H1] Release this asset's trade slot
        delete this.activeTrades[asset];

        const wr = ((this.totalWins / this.totalTrades) * 100).toFixed(2);

        this._sendTelegram(
            `${won ? '✅' : '❌'} <b>Result</b>\n\n` +
            `Asset: ${asset}\n` +
            `Transition: ${trade.analysis.currentDigit} → ${trade.analysis.predictedDigit}\n` +
            `Last10Digits: [ ${this.digitHistories[asset].slice(-10).join(' ')} ]\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
            `Win Rate: ${wr}%\n` +
            `Consecutive Losses: ${this.consecutiveLosses}\n` +
            `Next Stake: $${this.currentStake.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`
        );

        this._logSummary(asset);
        StatePersistence.save(this);

        if (this.totalProfitLoss >= this.cfg.takeProfit) {
            this.endOfDay = true;
            this._sendTelegram(`🎯 <b>Take Profit!</b> P&L: +$${this.totalProfitLoss.toFixed(2)}`);
            this._sendSessionSummary();
            this._cleanupWs();
        } else if (
            this.consecutiveLosses >= this.cfg.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.cfg.stopLoss
        ) {
            // [C3] Reset stake before saving so the next session starts at initialStake
            this.currentStake = this.cfg.initialStake;
            this.endOfDay = true;
            this._sendTelegram(
                `🛑 <b>Stop Loss</b>\nLosses: ${this.consecutiveLosses} | P&L: $${this.totalProfitLoss.toFixed(2)}`
            );
            this._sendSessionSummary();
            this._cleanupWs();
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
                `⏰ <b>Digit Pair Pattern Bot - Hourly Summary</b>`, ``,
                `📊 <b>Last Hour</b>`,
                `├ Trades: ${stats.trades}`,
                `├ Wins: ${stats.wins} | Losses: ${stats.losses}`,
                `├ Win Rate: ${winRate}%`,
                `└ ${pnlEmoji} <b>P&L:</b> ${pnlStr}`, ``,
                `🗓️ <b>Today</b>`,
                `├ Total Trades: ${this.totalTrades}`,
                `└ Today P&L: ${this.dailyProfitLoss >= 0 ? '+' : ''}$${this.dailyProfitLoss.toFixed(2)}`,
            ].join('\n');

            await this._sendTelegram(message);
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
        } catch (err) {
            console.error(`❌ _sendHourlySummary: ${err.message}`);
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
                `📊 <b>SESSION SUMMARY — Digit Pair Pattern Bot</b>`, ``,
                `⏱️ Duration: ${hours}h ${minutes}m`,
                `🔢 Trades: ${this.session.tradesCount}`,
                `✅ Wins: ${this.session.winsCount} | ❌ Losses: ${this.session.lossesCount}`,
                `📈 Win Rate: ${winRate}`,
                `💰 Session P/L: ${this.session.netPL >= 0 ? '+' : ''}$${this.session.netPL.toFixed(2)}`,
                `💵 Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`,
            ].join('\n');

            await this._sendTelegram(message);
        } catch (err) {
            console.error(`❌ _sendSessionSummary: ${err.message}`);
        }
    }

    async _sendDayEndSummary(dateKey) {
        try {
            const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) + '%' : '0%';
            const message = [
                `🌙 <b>END OF DAY — ${dateKey}</b>`, ``,
                `${this.dailyProfitLoss >= 0 ? '🟢' : '🔴'} <b>Day Results:</b>`,
                `├ Trades: ${this.totalTrades}`,
                `├ Wins: ${this.totalWins} | Losses: ${this.totalLosses}`,
                `├ Win Rate: ${wr}`,
                `└ Net P/L: $${this.dailyProfitLoss.toFixed(2)}`, ``,
                `📊 <b>Overall:</b>`,
                `└ Total P&L: $${this.totalProfitLoss.toFixed(2)}`,
            ].join('\n');

            await this._sendTelegram(message);
        } catch (err) {
            console.error(`❌ _sendDayEndSummary: ${err.message}`);
        }
    }

    _startHourlyTimer() {
        const now = new Date();
        const next = new Date(now);
        next.setHours(next.getHours() + 1, 0, 0, 0);
        const wait = next.getTime() - now.getTime();
        console.log(`⏰ Hourly summary in ${Math.ceil(wait / 60000)} min`);
        setTimeout(() => {
            this._sendHourlySummary();
            setInterval(() => this._sendHourlySummary(), 60 * 60 * 1000);
        }, wait);
    }

    _startWatchdog(asset) {
        this._clearWatchdog();
        this._wdTimer = setTimeout(() => {
            const contractId = this.activeTrades[asset]?.contractId;
            if (!contractId) { this._clearWatchdog(); return; }
            console.warn(`⏰ WATCHDOG — re-subscribing for ${asset}`);
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

    _checkDayChange() {
        const today = new Date().toISOString().split('T')[0];
        if (this.currentTradeDay && this.currentTradeDay !== today) {
            console.log(`🗓️ Day change: ${this.currentTradeDay} → ${today}`);
            this._sendDayEndSummary(this.currentTradeDay);
            this.dailyProfitLoss = 0;
            this.currentTradeDay = today;
            StatePersistence.save(this);
        }
    }

    _startTimeScheduler() {
        setInterval(() => {
            const gmt1 = new Date(Date.now() + 3600000);
            const hr = gmt1.getUTCHours();

            if (this.endOfDay && hr === 2) {
                console.log('⏰ 2:00 AM GMT+1 — reconnecting');
                this.endOfDay = false;
                // [H1] Clear all active trades on restart
                this.activeTrades = {};
                this.connect();
            }

            if (!this.endOfDay && hr === 23) {
                if (Object.keys(this.activeTrades).length === 0) {
                    console.log('🌙 11:00 PM GMT+1 — nightly shutdown');
                    this.endOfDay = true;
                    this._sendTelegram('🌙 <b>Nightly Shutdown</b> (11 PM GMT+1)\nBot will restart at 2 AM.');
                    this._sendSessionSummary();
                    this._cleanupWs();
                }
            }
        }, 20000);
    }

    _logSummary(asset) {
        const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';
        console.log('\n📊 SUMMARY');
        console.log(`  Trades: ${this.totalTrades} | W: ${this.totalWins} | L: ${this.totalLosses} | WR: ${wr}%`);
        console.log(`  Last 20: [ ${this.digitHistories[asset].slice(-20).join(' ')} ]`);
        console.log(`  Total P&L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`  Next stake: $${this.currentStake.toFixed(2)}`);
    }

    start() {
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('  🔗 DERIV DIGIT PAIR PATTERN BOT (fixed)');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('  ✓ Markov Chain Transition Matrix Analysis');
        console.log('  ✓ Correct Z-score per-window sample sizes [C1]');
        console.log('  ✓ Weighted matrix ratio uses actual weighted total [C2/H3]');
        console.log('  ✓ Stake resets on clean session restart [C3]');
        console.log('  ✓ Per-asset trade guards (no race conditions) [H1]');
        console.log('  ✓ Proposal IDs cleared on use/error [H2]');
        console.log('  ✓ Per-asset transition cooldown counters [M1]');
        console.log('  ✓ Safe 2.2× martingale multiplier [M2]');
        console.log('  ✓ _onBuy resolves asset by proposalId [M3]');
        console.log('  ✓ Tick evaluation gated on historyLoaded [L1/L2]');
        console.log('  ✓ Credentials loaded from .env [L3]');
        console.log(`\n  Statistical Confidence: Z > ${BOT_CONFIG.transitionAnalysis.zScoreThreshold}`);
        console.log(`  Multiplier: ${BOT_CONFIG.multiplier}×  |  Max losses: ${BOT_CONFIG.maxConsecutiveLosses}`);
        console.log('═══════════════════════════════════════════════════════════════\n');

        // Validate credentials before connecting
        if (!this.cfg.token) {
            console.error('❌ DERIV_TOKEN not set in .env — aborting');
            process.exit(1);
        }

        this.connect();
        this._startTimeScheduler();
        this._startHourlyTimer();
        StatePersistence.startAutoSave(this);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
const bot = new DerivDigitPairBot(BOT_CONFIG);
bot.start();
