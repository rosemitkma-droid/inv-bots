/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         Trend Reversal Bot — Simple Pattern Analysis         ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  STRATEGY:                                                   ║
 * ║  • Detect ASCENDING trends (e.g. 0→2→4→6, 1→3→5→7)          ║
 * ║  • Detect DESCENDING trends (e.g. 6→4→2→0, 9→6→3)           ║
 * ║  • Bet DIFFER on the predicted continuation digit            ║
 * ║  • Only trade if historical win probability ≥ 70%            ║
 * ║  • Validate pattern against 1000+ tick history               ║
 * ╚══════════════════════════════════════════════════════════════╝
 * ✅ What It Does:
 * Analyzes Last 10 Digits for trends:
*  Ascending: 0→2→4→6, 1→3→5→7, 3→6→9 (steps of +1, +2, +3)
*  Descending: 6→4→2→0, 7→5→3→1, 9→6→3 (steps of -1, -2, -3)
* Predicts Trend Continuation:
*  Ascending 0→2→4 → predicts next will be 6
*  Descending 7→5→3 → predicts next will be 1
*  Then bets DIFFER on that digit (betting it WON'T appear = trend breaks)
* Validates with History (1000 ticks):
*  Scans entire tick history for similar patterns
*  Counts how many times trend broke vs continued
*  Only trades if break probability ≥ 70%
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
    token: 'hsj0tA0XJoIzJG5',

    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'],

    initialStake: 1,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 108,
    takeProfit: 10000,

    minTimeBetweenTrades: 3000,
    requiredHistoryLength: 1000,

    // Trend Analysis Config
    trendWindow: 10,                    // Number of recent digits to analyze for trend
    minTrendStrength: 5,                // Minimum consecutive steps in same direction
    minWinProbability: 0.70,            // 70% minimum historical win rate
    historyDepth: 1000,                 // Ticks to analyze for probability calculation

    // Pattern detection
    allowedStepSizes: [1, 2, 3],       // e.g., +1 (0→1), +2 (0→2), +3 (0→3)
    minPatternOccurrences: 5,           // Minimum times pattern must appear in history

    telegramToken: '8578702717:AAFShpdLRtat7PHqjZMUqhY4UNKlWyaGtmo',
    telegramChatId: '752497117',

    maxReconnectAttempts: 50,
    reconnectDelay: 5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'trend_reversal-02_state.json');
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
                    consecutiveLosses5: bot.consecutiveLosses5,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                },
                assetMetrics: bot.assetMetrics,
                patternStats: bot.patternStats,
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
// TREND ANALYZER
// ══════════════════════════════════════════════════════════════════════════════
class TrendAnalyzer {
    constructor(config) {
        this.cfg = config;
    }

    /**
     * Analyze recent digits to detect ascending or descending trends
     * Returns: { hasTrend, direction, stepSize, sequence, predictedDigit, confidence }
     */
    detectTrend(digitHistory) {
        if (digitHistory.length < this.cfg.trendWindow) {
            return { hasTrend: false, reason: 'insufficient_data' };
        }

        const recentDigits = digitHistory.slice(-this.cfg.trendWindow);

        // Try to detect consistent step patterns
        for (const stepSize of this.cfg.allowedStepSizes) {
            // Check ASCENDING trend
            const ascResult = this._checkTrendDirection(recentDigits, stepSize, 'ASCENDING');
            if (ascResult.isValid) {
                return {
                    hasTrend: true,
                    direction: 'ASCENDING',
                    stepSize,
                    sequence: ascResult.sequence,
                    predictedDigit: ascResult.predictedDigit,
                    strength: ascResult.strength,
                    matchedIndices: ascResult.matchedIndices
                };
            }

            // Check DESCENDING trend
            const descResult = this._checkTrendDirection(recentDigits, stepSize, 'DESCENDING');
            if (descResult.isValid) {
                return {
                    hasTrend: true,
                    direction: 'DESCENDING',
                    stepSize,
                    sequence: descResult.sequence,
                    predictedDigit: descResult.predictedDigit,
                    strength: descResult.strength,
                    matchedIndices: descResult.matchedIndices
                };
            }
        }

        return { hasTrend: false, reason: 'no_pattern_detected' };
    }

    /**
     * Check if recent digits follow a specific step pattern
     */
    _checkTrendDirection(digits, stepSize, direction) {
        const sequence = [];
        const matchedIndices = [];
        let strength = 0;

        for (let i = 0; i < digits.length; i++) {
            const digit = digits[i];

            if (sequence.length === 0) {
                sequence.push(digit);
                matchedIndices.push(i);
                continue;
            }

            const lastDigit = sequence[sequence.length - 1];
            let expectedDigit;

            if (direction === 'ASCENDING') {
                expectedDigit = (lastDigit + stepSize) % 10;
            } else {
                expectedDigit = (lastDigit - stepSize + 10) % 10;
            }

            if (digit === expectedDigit) {
                sequence.push(digit);
                matchedIndices.push(i);
                strength++;
            } else {
                // Pattern broken - check if we have enough strength
                if (strength >= this.cfg.minTrendStrength) {
                    break;
                } else {
                    // Reset and try starting from current position
                    sequence.length = 0;
                    matchedIndices.length = 0;
                    sequence.push(digit);
                    matchedIndices.push(i);
                    strength = 0;
                }
            }
        }

        // Calculate predicted next digit (the one we'll bet AGAINST)
        let predictedDigit = null;
        if (sequence.length >= this.cfg.minTrendStrength) {
            const lastInSeq = sequence[sequence.length - 1];
            if (direction === 'ASCENDING') {
                predictedDigit = (lastInSeq + stepSize) % 10;
            } else {
                predictedDigit = (lastInSeq - stepSize + 10) % 10;
            }
        }

        return {
            isValid: strength >= this.cfg.minTrendStrength && sequence.length >= 3,
            sequence,
            strength,
            predictedDigit,
            matchedIndices
        };
    }

    /**
     * Calculate historical win probability for this pattern
     * Returns probability that the trend will BREAK (our win condition)
     */
    calculateWinProbability(digitHistory, pattern) {
        if (digitHistory.length < this.cfg.requiredHistoryLength) {
            return { probability: 0, occurrences: 0, breaks: 0, continues: 0 };
        }

        const { direction, stepSize, sequence } = pattern;
        const minSeqLength = Math.max(3, sequence.length - 2); // Look for similar length patterns

        let totalOccurrences = 0;
        let trendBreaks = 0;
        let trendContinues = 0;

        // Scan through history to find similar patterns
        for (let i = 0; i < digitHistory.length - minSeqLength - 1; i++) {
            const detected = this._findPatternAt(
                digitHistory.slice(i, i + minSeqLength + 5),
                stepSize,
                direction,
                minSeqLength
            );

            if (detected.found) {
                totalOccurrences++;

                // Check what happened AFTER the pattern
                const nextDigitIndex = i + detected.sequenceLength;
                if (nextDigitIndex < digitHistory.length) {
                    const lastInPattern = digitHistory[nextDigitIndex - 1];
                    const actualNext = digitHistory[nextDigitIndex];

                    let expectedContinuation;
                    if (direction === 'ASCENDING') {
                        expectedContinuation = (lastInPattern + stepSize) % 10;
                    } else {
                        expectedContinuation = (lastInPattern - stepSize + 10) % 10;
                    }

                    if (actualNext === expectedContinuation) {
                        trendContinues++; // Trend continued (we would lose)
                    } else {
                        trendBreaks++;    // Trend broke (we would win)
                    }
                }

                // Skip ahead to avoid overlapping patterns
                i += detected.sequenceLength - 1;
            }
        }

        const totalDecisive = trendBreaks + trendContinues;
        const winProbability = totalDecisive > 0 ? trendBreaks / totalDecisive : 0;

        return {
            probability: winProbability,
            occurrences: totalOccurrences,
            breaks: trendBreaks,
            continues: trendContinues,
            isReliable: totalOccurrences >= this.cfg.minPatternOccurrences
        };
    }

    /**
     * Find pattern starting at specific position
     */
    _findPatternAt(slice, stepSize, direction, minLength) {
        const sequence = [slice[0]];

        for (let i = 1; i < slice.length; i++) {
            const lastDigit = sequence[sequence.length - 1];
            let expected;

            if (direction === 'ASCENDING') {
                expected = (lastDigit + stepSize) % 10;
            } else {
                expected = (lastDigit - stepSize + 10) % 10;
            }

            if (slice[i] === expected) {
                sequence.push(slice[i]);
            } else {
                break;
            }
        }

        return {
            found: sequence.length >= minLength,
            sequenceLength: sequence.length,
            sequence
        };
    }

    /**
     * Main analysis function
     */
    analyze(digitHistory) {
        // Step 1: Detect trend
        const trend = this.detectTrend(digitHistory);

        if (!trend.hasTrend) {
            return {
                shouldTrade: false,
                reason: trend.reason,
                trend: null
            };
        }

        // Step 2: Calculate historical probability
        const probability = this.calculateWinProbability(digitHistory, trend);

        // Step 3: Validate reliability
        if (!probability.isReliable) {
            return {
                shouldTrade: false,
                reason: `pattern_rare_only_${probability.occurrences}_occurrences`,
                trend,
                probability
            };
        }

        // Step 4: Check win probability threshold
        if (probability.probability < this.cfg.minWinProbability) {
            return {
                shouldTrade: false,
                reason: `low_win_probability_${(probability.probability * 100).toFixed(1)}%`,
                trend,
                probability
            };
        }

        // All conditions met!
        return {
            shouldTrade: true,
            reason: 'trend_reversal_pattern_confirmed',
            trend,
            probability,
            predictedDigit: trend.predictedDigit,
            confidence: probability.probability
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT
// ══════════════════════════════════════════════════════════════════════════════
class TrendReversalBot {
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
        this.consecutiveLosses5 = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.dailyProfitLoss = 0;
        this.isWinTrade = false;
        this.endOfDay = false;

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
            this.tickCounts[a] = 0;
            this.assetMetrics[a] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
            this.proposalIds[a] = null;
        });

        // Pattern statistics
        this.patternStats = {
            ascending: { detected: 0, traded: 0, won: 0, lost: 0 },
            descending: { detected: 0, traded: 0, won: 0, lost: 0 }
        };

        // Components
        this.analyzer = new TrendAnalyzer(config);

        // Telegram
        this.telegram = null;
        if (config.telegramToken && config.telegramChatId) {
            this.telegram = new TelegramBot(config.telegramToken, { polling: false });
        }

        this._loadState();
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
                this.consecutiveLosses5 = s.trading.consecutiveLosses5 || 0;
                this.totalTrades = s.trading.totalTrades || 0;
                this.totalWins = s.trading.totalWins || 0;
                this.totalLosses = s.trading.totalLosses || 0;
                this.totalProfitLoss = s.trading.totalProfitLoss || 0;
                this.dailyProfitLoss = s.trading.dailyProfitLoss || 0;
            }
            if (s.assetMetrics) this.assetMetrics = s.assetMetrics;
            if (s.patternStats) this.patternStats = s.patternStats;

            console.log(`✅ State restored — ${this.totalTrades} trades, P&L $${this.totalProfitLoss.toFixed(2)}`);
        } catch (e) {
            console.error(`❌ State restore error: ${e.message}`);
        }
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
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s… (${this.reconnectAttempts}/${this.cfg.maxReconnectAttempts})`);
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
            case 'sell':
                if (msg.error) console.error('Sell error:', msg.error.message);
                break;
            case 'ping': break;
            default:
                if (msg.error) console.error(`API error [${msg.msg_type}]: ${msg.error.message}`);
        }
    }

    _onAuth(msg) {
        if (msg.error) { console.error('Auth failed:', msg.error.message); this._cleanupWs(); return; }
        console.log(`✅ Auth OK — Balance: $${msg.authorize.balance}`);
        this.wsReady = true;
        this.cfg.assets.forEach(asset => {
            this._send({ ticks_history: asset, adjust_start_time: 1, count: this.cfg.requiredHistoryLength, end: 'latest', start: 1, style: 'ticks' });
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

        this.priceHistories[asset].push(price);
        if (this.priceHistories[asset].length > 1500) this.priceHistories[asset] = this.priceHistories[asset].slice(-1000);

        this.digitHistories[asset].push(digit);
        if (this.digitHistories[asset].length > 1500) this.digitHistories[asset] = this.digitHistories[asset].slice(-1000);

        this.tickCounts[asset] = (this.tickCounts[asset] || 0) + 1;

        if (!this.wsReady) return;
        if (this.activeTrades[asset]) return;
        if (this.digitHistories[asset].length < this.cfg.requiredHistoryLength) return;

        if (!this.tradeInProgress) {
            this._evaluateAsset(asset);
        }
    }

    // ── Analysis & proposal ───────────────────────────────────────────────────
    _evaluateAsset(asset) {
        const analysis = this.analyzer.analyze(this.digitHistories[asset]);

        if (!analysis.shouldTrade) return;

        // Update detection stats
        const dir = analysis.trend.direction.toLowerCase();
        if (this.patternStats[dir]) {
            this.patternStats[dir].detected++;
        }

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

        // Re-validate (market may have changed)
        const freshAnalysis = this.analyzer.analyze(this.digitHistories[asset]);

        if (!freshAnalysis.shouldTrade ||
            freshAnalysis.predictedDigit !== analysis.predictedDigit) {
            console.log(`   ❌ Conditions changed — aborting`);
            return;
        }

        //Don't Trade if Trend Sequence is not same as Last 4 Digits 
        if (analysis.trend.sequence.join(',') !== this.digitHistories[asset].slice(-4).join(',')) {
            console.log(`   ❌ Trend Sequence is not same as Last 4 Digits — aborting
                Trend Sequence: ${analysis.trend.sequence.join(',')}
                Last 4 Digits: ${this.digitHistories[asset].slice(-4).join(',')}
                `);
            return;
        }

        const payout = parseFloat(proposal.payout || 0);
        const payoutPct = this.currentStake > 0 ? ((payout - this.currentStake) / this.currentStake * 100).toFixed(1) : '?';

        console.log(`\n🎯 TREND REVERSAL SIGNAL — ${asset}`);
        console.log(`   Direction: ${analysis.trend.direction} (step: ${analysis.trend.stepSize})`);
        console.log(`   Sequence: ${analysis.trend.sequence.join(' → ')}`);
        console.log(`   Predicted digit: ${analysis.predictedDigit} (betting it will NOT appear)`);
        console.log(`   Last 10 digits: ${this.digitHistories[asset].slice(-10).join(',')}`);
        console.log(`   Historical Win Probability: ${(analysis.probability.probability * 100).toFixed(1)}%`);
        console.log(`   Pattern occurrences: ${analysis.probability.occurrences} (Breaks: ${analysis.probability.breaks}, Continues: ${analysis.probability.continues})`);
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

        const dir = analysis.trend.direction.toLowerCase();
        if (this.patternStats[dir]) {
            this.patternStats[dir].traded++;
        }

        this._sendTelegram(
            `🎯 <b>Trend Reversal Trade Opened</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Direction: ${analysis.trend.direction} (step ${analysis.trend.stepSize})\n` +
            `Sequence: ${analysis.trend.sequence.join(' → ')}\n` +
            `Predicted digit: <b>${analysis.predictedDigit}</b> will NOT appear\n` +
            `Last 10: ${this.digitHistories[asset].slice(-10).join(',')}\n` +
            `Win Probability: ${(analysis.probability.probability * 100).toFixed(1)}%\n` +
            `Pattern occurrences: ${analysis.probability.occurrences}\n` +
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
        console.log(`✅ Contract opened: ${contractId}`);

        this.activeTrades[asset].status = 'active';
        this.activeTrades[asset].contractId = contractId;

        this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
    }

    _onContractUpdate(msg) {
        if (msg.error) { console.error('Contract error:', msg.error.message); return; }
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

        // Update pattern stats
        const dir = trade.analysis.trend.direction.toLowerCase();
        if (this.patternStats[dir]) {
            if (won) this.patternStats[dir].won++;
            else this.patternStats[dir].lost++;
        }

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`  ${won ? '✅ WIN' : '❌ LOSS'}: ${asset}`);
        console.log(`  Trend: ${trade.analysis.trend.direction} | Predicted: ${trade.predictedDigit}`);
        console.log(`  P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
        console.log(`${'═'.repeat(60)}`);

        // Update stats
        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
        this.assetMetrics[asset].trades++;
        this.assetMetrics[asset].profitLoss += profit;

        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.currentStake = this.cfg.initialStake;
            this.consecutiveLosses = 0;
            this.assetMetrics[asset].wins++;
        } else {
            this.totalLosses++;
            this.isWinTrade = false;
            this.consecutiveLosses++;
            this.assetMetrics[asset].losses++;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            this.currentStake = Math.ceil(this.currentStake * this.cfg.multiplier * 100) / 100;
        }

        this.tradeInProgress = false;
        this.tradeStartTime = null;
        delete this.activeTrades[asset];

        const ascStats = this.patternStats.ascending;
        const descStats = this.patternStats.descending;
        const ascWR = ascStats.traded > 0 ? (ascStats.won / ascStats.traded * 100).toFixed(1) : '0.0';
        const descWR = descStats.traded > 0 ? (descStats.won / descStats.traded * 100).toFixed(1) : '0.0';

        this._sendTelegram(
            `${won ? '✅' : '❌'} <b>Trade Result</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Trend: ${trade.analysis.trend.direction}\n` +
            `Digit: ${trade.predictedDigit} | ${won ? 'Did NOT appear ✅' : 'Appeared ❌'}\n` +
            `Last10Digits: ${this.digitHistories[asset].slice(-10).join(',')}\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
            `Consecutive losses: ${this.consecutiveLosses}\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
            `Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%\n` +
            `Next stake: $${this.currentStake.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}\n\n` +
            `Pattern Stats:\n` +
            `Ascending: ${ascStats.traded} trades (WR: ${ascWR}%)\n` +
            `Descending: ${descStats.traded} trades (WR: ${descWR}%)`
        );

        this._logSummary();
        StatePersistence.save(this);

        // Stop conditions
        if (this.totalProfitLoss >= this.cfg.takeProfit) {
            console.log('🎯 Take Profit reached');
            this.endOfDay = true;
            this._sendTelegram(`🎯 <b>Take Profit!</b> P&L: +$${this.totalProfitLoss.toFixed(2)}`);
            this._cleanupWs();
            return;
        }
        if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses || this.totalProfitLoss <= -this.cfg.stopLoss) {
            console.log('🛑 Stop condition met');
            this.endOfDay = true;
            this._sendTelegram(`🛑 <b>Stop Loss</b>\nLosses: ${this.consecutiveLosses} | P&L: $${this.totalProfitLoss.toFixed(2)}`);
            this._cleanupWs();
        }
    }

    // ── Watchdog ──────────────────────────────────────────────────────────────
    _startWatchdog(asset) {
        this._clearWatchdog();
        this._wdTimer = setTimeout(() => {
            const contractId = this.activeTrades[asset]?.contractId;
            if (!contractId) { this._clearWatchdog(); return; }

            console.warn(`⏰ WATCHDOG — contract ${contractId} unresolved`);

            if (this.connected && this.wsReady) {
                this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
                this._wdPollTimer = setTimeout(() => {
                    if (!this.activeTrades[asset]) { this._clearWatchdog(); return; }
                    console.error(`🚨 WATCHDOG: force releasing`);
                    this._recoverStuck(asset, contractId, 'watchdog-force');
                }, 10000);
            } else {
                this._recoverStuck(asset, contractId, 'watchdog-offline');
            }
        }, this.tradeWatchdogMs);
    }

    _clearWatchdog() {
        if (this._wdTimer) { clearTimeout(this._wdTimer); this._wdTimer = null; }
        if (this._wdPollTimer) { clearTimeout(this._wdPollTimer); this._wdPollTimer = null; }
    }

    _recoverStuck(asset, contractId, reason) {
        this._clearWatchdog();
        const trade = this.activeTrades[asset];
        const stake = trade?.stake || 0;

        console.error(`🚨 STUCK TRADE [${reason}] — ${asset}`);

        if (contractId && this.connected) this._send({ sell: contractId, price: '0' });
        if (this.contractSubs[asset]) { this._send({ forget: this.contractSubs[asset] }); delete this.contractSubs[asset]; }

        this.tradeInProgress = false;
        this.tradeStartTime = null;
        delete this.activeTrades[asset];

        this.totalLosses++;
        this.consecutiveLosses++;
        this.totalProfitLoss -= stake;
        this.assetMetrics[asset].losses++;
        this.assetMetrics[asset].profitLoss -= stake;

        this.currentStake = Math.ceil(this.currentStake * this.cfg.multiplier * 100) / 100;

        this._sendTelegram(`🚨 <b>Stuck trade [${reason}]</b>\nAsset: ${asset}\nStake: $${stake.toFixed(2)}`);
        StatePersistence.save(this);
    }

    // ── Telegram ──────────────────────────────────────────────────────────────
    async _sendTelegram(text) {
        if (!this.telegram) return;
        try { await this.telegram.sendMessage(this.cfg.telegramChatId, text, { parse_mode: 'HTML' }); }
        catch (e) { console.error(`Telegram: ${e.message}`); }
    }

    // ── Logging ───────────────────────────────────────────────────────────────
    _logSummary() {
        const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';
        console.log('\n📊 Summary:');
        console.log(`  Trades: ${this.totalTrades} | W: ${this.totalWins} | L: ${this.totalLosses} | WR: ${wr}%`);
        console.log(`  Consecutive losses: x2:${this.consecutiveLosses2} x3:${this.consecutiveLosses3} x4:${this.consecutiveLosses4}`);
        console.log(`  Total P&L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`  Stake: $${this.currentStake.toFixed(2)}`);

        const ascStats = this.patternStats.ascending;
        const descStats = this.patternStats.descending;
        console.log('\n  Pattern Performance:');
        console.log(`    Ascending: ${ascStats.won}/${ascStats.traded} (${ascStats.traded > 0 ? (ascStats.won / ascStats.traded * 100).toFixed(1) : '0.0'}%) | Detected: ${ascStats.detected}`);
        console.log(`    Descending: ${descStats.won}/${descStats.traded} (${descStats.traded > 0 ? (descStats.won / descStats.traded * 100).toFixed(1) : '0.0'}%) | Detected: ${descStats.detected}`);
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
        console.log('  🎯 Trend Reversal Bot — Simple Pattern Analysis');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`  Assets:      ${this.cfg.assets.join(', ')}`);
        console.log(`  Stake:       $${this.cfg.initialStake} × ${this.cfg.multiplier}x`);
        console.log(`  Strategy:    Bet AGAINST trend continuation`);
        console.log(`  Trend:       Last ${this.cfg.trendWindow} digits (min ${this.cfg.minTrendStrength} steps)`);
        console.log(`  Steps:       ${this.cfg.allowedStepSizes.join(', ')}`);
        console.log(`  Min Win %:   ${(this.cfg.minWinProbability * 100).toFixed(0)}%`);
        console.log(`  History:     ${this.cfg.historyDepth} ticks analyzed`);
        console.log('═══════════════════════════════════════════════════════════\n');

        this.connect();
        this._startTimeScheduler();
        StatePersistence.startAutoSave(this);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
const bot = new TrendReversalBot(BOT_CONFIG);
bot.start();
