/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  DERIV DIGIT FREQUENCY ANALYSIS BOT                                 ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║  Analyzes digit frequencies across multiple windows                 ║
 * ║  - Short, Medium, and Long window analysis                          ║
 * ║  - Configurable frequency thresholds                                ║
 * ║  - Repeat probability analysis                                      ║
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
// ─────────────────────────────────────────────────────────────────────────────
const BOT_CONFIG = {
    token: 'Dz2V2KvRf4Uukt3',
    assets: ['R_10', 'R_25', 'R_50', 'R_75'], //['R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR']

    initialStake: 2.55,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 100,
    takeProfit: 50000,

    // Frequency Analysis Configuration
    frequencyAnalysis: {
        // Window sizes for frequency analysis
        shortWindow: 10,
        mediumWindow: 100,
        longWindow: 1000,

        // Minimum history required before trading
        minHistorySize: 1000,

        // Frequency thresholds for each window (in percentage)
        shortWindowThreshold: 40,    // >= 60%
        mediumWindowThreshold: 10,   // >= 10%
        mediumWindowThresholdHigh: 15, //15%
        longWindowThreshold: 10,     // >= 10%
        longWindowThresholdHigh: 12, //12%
        // Repeat probability threshold
        maxRepeatProbability: 7,    // <= 10%
        minRepeatProbability: 5,    // >= 10%

        // Minimum sample size for repeat probability calculation
        minRepeatSample: 10,
    },

    minTimeBetweenTrades: 25000,
    cooldownAfterLoss: 60000,
    maxTradesPerHour: 20000,
    maxExposure: 50,

    telegramToken: '8106601008:AAEMyCma6mvPYIHEvw3RHQX2tkD5-wUe1o0',
    telegramChatId: '752497117',

    maxReconnectAttempts: 50,
    reconnectDelay: 5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'deriv_frequency_bot_state.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static save(bot) {
        try {
            const data = {
                savedAt: Date.now(),
                trading: {
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
// DIGIT FREQUENCY ANALYZER
// ══════════════════════════════════════════════════════════════════════════════

class DigitFrequencyAnalyzer {
    constructor(config) {
        this.cfg = config.frequencyAnalysis;
    }

    /**
     * Calculate frequency of each digit in a given window
     * Returns object with digit frequencies and percentages
     */
    calculateFrequencies(digitArray, windowSize) {
        const window = digitArray.slice(-windowSize);
        const frequencies = {};

        // Initialize frequencies for all digits 0-9
        for (let i = 0; i < 10; i++) {
            frequencies[i] = { count: 0, percentage: 0 };
        }

        // Count occurrences
        window.forEach(digit => {
            if (digit >= 0 && digit <= 9) {
                frequencies[digit].count++;
            }
        });

        // Calculate percentages
        const total = window.length;
        for (let i = 0; i < 10; i++) {
            frequencies[i].percentage = (frequencies[i].count / total) * 100;
        }

        return frequencies;
    }

    /**
     * Calculate repeat probability for a specific digit
     * Analyzes how often the digit appears consecutively
     */
    calculateRepeatProbability(digitArray, targetDigit, windowSize = null) {
        const data = windowSize ? digitArray.slice(-windowSize) : digitArray;

        let consecutivePairs = 0;
        let totalOccurrences = 0;

        for (let i = 0; i < data.length - 1; i++) {
            if (data[i] === targetDigit) {
                totalOccurrences++;
                if (data[i + 1] === targetDigit) {
                    consecutivePairs++;
                }
            }
        }

        // Check last digit
        if (data[data.length - 1] === targetDigit) {
            totalOccurrences++;
        }

        if (totalOccurrences < this.cfg.minRepeatSample) {
            return {
                probability: 0,
                consecutivePairs,
                totalOccurrences,
                insufficient: true
            };
        }

        const probability = (consecutivePairs / totalOccurrences) * 100;

        return {
            probability,
            consecutivePairs,
            totalOccurrences,
            insufficient: false
        };
    }

    /**
     * Main analysis function
     * Identifies digits that meet frequency criteria across all windows
     */
    analyzeFrequencies(digitArray, currentDigit) {
        if (digitArray.length < this.cfg.minHistorySize) {
            return {
                shouldTrade: false,
                reason: 'insufficient_history',
                requiredHistory: this.cfg.minHistorySize,
                currentHistory: digitArray.length
            };
        }

        // Calculate frequencies for all three windows
        const shortFreq = this.calculateFrequencies(digitArray, this.cfg.shortWindow);
        const mediumFreq = this.calculateFrequencies(digitArray, this.cfg.mediumWindow);
        const longFreq = this.calculateFrequencies(digitArray, this.cfg.longWindow);

        const candidates = [];

        // Analyze each digit
        for (let digit = 0; digit < 10; digit++) {
            const shortPct = shortFreq[digit].percentage;
            const mediumPct = mediumFreq[digit].percentage;
            const longPct = longFreq[digit].percentage;

            // Check if digit meets all frequency thresholds
            const meetsShort = shortPct >= this.cfg.shortWindowThreshold;
            const meetsMedium = mediumPct > this.cfg.mediumWindowThreshold && mediumPct < this.cfg.mediumWindowThresholdHigh;
            const meetsLong = longPct > this.cfg.longWindowThreshold && longPct < this.cfg.longWindowThresholdHigh;

            if (meetsShort && meetsMedium && meetsLong) {
                // Calculate repeat probability across different windows
                const shortRepeat = this.calculateRepeatProbability(
                    digitArray, digit, this.cfg.shortWindow
                );
                const mediumRepeat = this.calculateRepeatProbability(
                    digitArray, digit, this.cfg.mediumWindow
                );
                const longRepeat = this.calculateRepeatProbability(
                    digitArray, digit, this.cfg.longWindow
                );

                // Use weighted average for repeat probability
                const avgRepeatProb = (
                    shortRepeat.probability * 0.4 +
                    mediumRepeat.probability * 0.4 +
                    longRepeat.probability * 0.2
                );

                candidates.push({
                    digit,
                    shortFrequency: shortPct,
                    mediumFrequency: mediumPct,
                    longFrequency: longPct,
                    shortRepeatProb: shortRepeat.probability,
                    mediumRepeatProb: mediumRepeat.probability,
                    longRepeatProb: longRepeat.probability,
                    avgRepeatProb,
                    shortRepeatData: shortRepeat,
                    mediumRepeatData: mediumRepeat,
                    longRepeatData: longRepeat,
                    meetsRepeatThreshold: avgRepeatProb <= this.cfg.maxRepeatProbability && avgRepeatProb > this.cfg.minRepeatProbability
                });
            }
        }

        // Filter candidates that meet repeat probability threshold
        const validCandidates = candidates.filter(c => c.meetsRepeatThreshold);

        if (validCandidates.length === 0) {
            return {
                shouldTrade: false,
                reason: validCandidates.length === 0 ? 'no_valid_candidates' : 'repeat_probability_too_high',
                allCandidates: candidates,
                currentDigit,
                frequencies: {
                    short: shortFreq,
                    medium: mediumFreq,
                    long: longFreq
                }
            };
        }

        // Sort by highest frequency in short window (most recent data)
        validCandidates.sort((a, b) => b.shortFrequency - a.shortFrequency);

        const best = validCandidates[0];

        return {
            shouldTrade: true,
            reason: 'frequency_analysis_signal',
            currentDigit,
            predictedDigit: best.digit,
            contractType: 'DIGITDIFF',  // We bet the predicted digit will NOT appear
            confidence: this._calculateConfidence(best),
            analysis: {
                shortFrequency: best.shortFrequency.toFixed(2),
                mediumFrequency: best.mediumFrequency.toFixed(2),
                longFrequency: best.longFrequency.toFixed(2),
                shortRepeatProb: best.shortRepeatProb.toFixed(2),
                mediumRepeatProb: best.mediumRepeatProb.toFixed(2),
                longRepeatProb: best.longRepeatProb.toFixed(2),
                avgRepeatProb: best.avgRepeatProb.toFixed(2),
                shortRepeatData: best.shortRepeatData,
                mediumRepeatData: best.mediumRepeatData,
                longRepeatData: best.longRepeatData,
            },
            allCandidates: validCandidates.slice(0, 3),
            frequencies: {
                short: shortFreq,
                medium: mediumFreq,
                long: longFreq
            }
        };
    }

    /**
     * Calculate confidence score based on how well criteria are met
     */
    _calculateConfidence(candidate) {
        // Higher frequency = higher confidence
        const freqScore = (
            (candidate.shortFrequency / 100) * 0.5 +
            (candidate.mediumFrequency / 100) * 0.3 +
            (candidate.longFrequency / 100) * 0.2
        );

        // Lower repeat probability = higher confidence
        const repeatScore = 1 - (candidate.avgRepeatProb / 100);

        // Combined confidence (0-1 scale)
        const confidence = (freqScore * 0.6) + (repeatScore * 0.4);

        return Math.min(confidence, 1);
    }

    /**
     * Display detailed frequency table
     */
    displayFrequencyTable(frequencies, windowName, asset) {
        console.log(`\n  ┌─────────────────────────────────────────────────────────┐`);
        console.log(`  │ [${asset}] ${windowName.toUpperCase()} WINDOW FREQUENCIES`.padEnd(57) + '│');
        console.log(`  ├────────┬──────────┬─────────────┬─────────────────────┤`);
        console.log(`  │ Digit  │  Count   │ Percentage  │  Visual Bar         │`);
        console.log(`  ├────────┼──────────┼─────────────┼─────────────────────┤`);

        for (let i = 0; i < 10; i++) {
            const freq = frequencies[i];
            const barLength = Math.round(freq.percentage / 5);  // Scale to 20 chars max
            const bar = '█'.repeat(barLength) + '░'.repeat(20 - barLength);

            console.log(
                `  │   ${i}    │  ${freq.count.toString().padStart(4)}    │  ` +
                `${freq.percentage.toFixed(2).padStart(6)}%   │  ${bar} │`
            );
        }

        console.log(`  └────────┴──────────┴─────────────┴─────────────────────┘`);
    }

    /**
     * Display repeat probability analysis
     */
    displayRepeatAnalysis(digit, repeatData, windowName) {
        console.log(`\n  ┌─────────────────────────────────────────────────────────┐`);
        console.log(`  │  DIGIT ${digit} - ${windowName.toUpperCase()} REPEAT PROBABILITY`.padEnd(57) + '│');
        console.log(`  ├─────────────────────────────┬───────────────────────────┤`);
        console.log(`  │ Total Occurrences           │  ${repeatData.totalOccurrences.toString().padStart(8)}           │`);
        console.log(`  │ Consecutive Pairs           │  ${repeatData.consecutivePairs.toString().padStart(8)}           │`);
        console.log(`  │ Repeat Probability          │  ${repeatData.probability.toFixed(2).padStart(7)}%          │`);
        console.log(`  └─────────────────────────────┴───────────────────────────┘`);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT
// ══════════════════════════════════════════════════════════════════════════════

class DerivFrequencyBot {
    constructor(config) {
        this.cfg = config;

        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.reconnectAttempts = 0;
        this.pingInterval = null;

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
        this.historyLoaded = {};
        this.assetMetrics = {};
        this.proposalIds = {};

        config.assets.forEach(a => {
            this.priceHistories[a] = [];
            this.digitHistories[a] = [];
            this.lastTradeTime[a] = 0;
            this.lastLossTime[a] = 0;
            this.assetMetrics[a] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
            this.historyLoaded[a] = false;
        });

        this.analyzer = new DigitFrequencyAnalyzer(config);

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
        if (this.activeTrades[asset])
            return { can: false, reason: 'trade_in_progress' };

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

        this.cfg.assets.forEach(asset => {
            this._send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: Math.max(this.cfg.frequencyAnalysis.longWindow + 100, 5500),
                end: 'latest',
                start: 1,
                style: 'ticks',
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
        this.historyLoaded[asset] = true;
        console.log(`📊 ${asset}: loaded ${this.priceHistories[asset].length} ticks`);
    }

    _onTick(tick) {
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);
        const digit = this._lastDigit(price, asset);

        this.priceHistories[asset].push(price);
        if (this.priceHistories[asset].length > this.cfg.frequencyAnalysis.minHistorySize) this.priceHistories[asset].shift();

        this.digitHistories[asset].push(digit);
        if (this.digitHistories[asset].length > this.cfg.frequencyAnalysis.minHistorySize) this.digitHistories[asset].shift();

        if (!this.wsReady || !this.historyLoaded[asset]) return;
        if (this.digitHistories[asset].length < this.cfg.frequencyAnalysis.minHistorySize) return;

        this._evaluateAsset(asset);
    }

    _evaluateAsset(asset) {
        const canTrade = this._canTrade(asset);
        if (!canTrade.can) return;

        const currentDigit = this.digitHistories[asset][this.digitHistories[asset].length - 1];
        const analysis = this.analyzer.analyzeFrequencies(this.digitHistories[asset], currentDigit);

        // Display frequency analysis
        console.log(`\n${'═'.repeat(70)}`);
        console.log(`  📊 FREQUENCY ANALYSIS — ${asset}`);
        console.log(`${'═'.repeat(70)}`);
        console.log(`  Current Digit: ${currentDigit}`);
        console.log(`  Last 10 Digits: [ ${this.digitHistories[asset].slice(-10).join(' ')} ]`);

        if (analysis.frequencies) {
            // this.analyzer.displayFrequencyTable(
            //     analysis.frequencies.short,
            //     `Short (${this.cfg.frequencyAnalysis.shortWindow})`,
            //     asset
            // );
            // this.analyzer.displayFrequencyTable(
            //     analysis.frequencies.medium,
            //     `Medium (${this.cfg.frequencyAnalysis.mediumWindow})`,
            //     asset
            // );
            // this.analyzer.displayFrequencyTable(
            //     analysis.frequencies.long,
            //     `Long (${this.cfg.frequencyAnalysis.longWindow})`,
            //     asset
            // );
        }

        if (analysis.shouldTrade) {
            console.log(`\n  ┌─────────────────────────────────────────────────────────┐`);
            console.log(`  │  ✅ TRADE SIGNAL DETECTED                              │`);
            console.log(`  ├─────────────────────────────┬───────────────────────────┤`);
            console.log(`  │ Predicted Digit             │  ${analysis.predictedDigit}                        │`);
            console.log(`  │ Contract Type               │  ${analysis.contractType}              │`);
            console.log(`  │ Confidence                  │  ${(analysis.confidence * 100).toFixed(2)}%                  │`);
            console.log(`  └─────────────────────────────┴───────────────────────────┘`);

            console.log(`\n  ┌─────────────────────────────────────────────────────────┐`);
            console.log(`  │  DIGIT ${analysis.predictedDigit} - FREQUENCY ANALYSIS ${asset}`.padEnd(57) + '│');
            console.log(`  ├─────────────────────────────┬───────────────────────────┤`);
            console.log(`  │ Short Window Frequency      │  ${analysis.analysis.shortFrequency}%`.padEnd(57) + '│');
            console.log(`  │ Medium Window Frequency     │  ${analysis.analysis.mediumFrequency}%`.padEnd(57) + '│');
            console.log(`  │ Long Window Frequency       │  ${analysis.analysis.longFrequency}%`.padEnd(57) + '│');
            console.log(`  ├─────────────────────────────┼───────────────────────────┤`);
            console.log(`  │ Short Repeat Probability    │  ${analysis.analysis.shortRepeatProb}%`.padEnd(57) + '│');
            console.log(`  │ Medium Repeat Probability   │  ${analysis.analysis.mediumRepeatProb}%`.padEnd(57) + '│');
            console.log(`  │ Long Repeat Probability     │  ${analysis.analysis.longRepeatProb}%`.padEnd(57) + '│');
            console.log(`  │ Average Repeat Probability  │  ${analysis.analysis.avgRepeatProb}%`.padEnd(57) + '│');
            console.log(`  └─────────────────────────────┴───────────────────────────┘`);

            // Display detailed repeat analysis
            this.analyzer.displayRepeatAnalysis(
                analysis.predictedDigit,
                analysis.analysis.shortRepeatData,
                `Short (${this.cfg.frequencyAnalysis.shortWindow})`
            );
            this.analyzer.displayRepeatAnalysis(
                analysis.predictedDigit,
                analysis.analysis.mediumRepeatData,
                `Medium (${this.cfg.frequencyAnalysis.mediumWindow})`
            );
            this.analyzer.displayRepeatAnalysis(
                analysis.predictedDigit,
                analysis.analysis.longRepeatData,
                `Long (${this.cfg.frequencyAnalysis.longWindow})`
            );

            // Don't trade if current digit is not equal to predicted digit
            if (analysis.currentDigit !== analysis.predictedDigit) {
                console.log(`\n  ⚠️  Current digit (${analysis.currentDigit}) Not Same as Predicted digit (${analysis.predictedDigit}) — skipping trade`);
                console.log(`${'═'.repeat(70)}\n`);
                return;
            }

            this._requestProposal(asset, analysis);
        } else {
            console.log(`\n  ℹ️  Signal: ${analysis.reason}`);
            if (analysis.allCandidates && analysis.allCandidates.length > 0) {
                console.log(`\n  Top candidates (failed repeat probability check):`);
                analysis.allCandidates.slice(0, 3).forEach((c, i) => {
                    console.log(`    ${i + 1}. Digit ${c.digit}: ` +
                        `Freq(${c.shortFrequency.toFixed(1)}%/${c.mediumFrequency.toFixed(1)}%/${c.longFrequency.toFixed(1)}%) ` +
                        `Repeat(${c.avgRepeatProb.toFixed(2)}%)`);
                });
            }
        }
        // console.log(`${'═'.repeat(70)}\n`);
    }

    _requestProposal(asset, analysis) {
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

        this.proposalIds[asset] = { analysis, requestedAt: Date.now() };
    }

    _onProposal(msg) {
        if (msg.error) {
            console.log(`❌ Proposal error: ${msg.error.message}`);
            const asset = msg.echo_req?.symbol;
            if (asset) delete this.proposalIds[asset];
            return;
        }

        const asset = msg.echo_req?.symbol;
        if (!asset) return;

        if (this.activeTrades[asset]) return;

        const storedData = this.proposalIds[asset];
        if (!storedData) return;

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
        console.log(`  💼 PLACING TRADE — ${asset}`);
        console.log(`${'═'.repeat(70)}`);
        console.log(`  Predicted Digit  : ${analysis.predictedDigit}`);
        console.log(`  Contract         : ${analysis.contractType}`);
        console.log(`  Stake            : $${this.currentStake.toFixed(2)}`);
        console.log(`  Payout           : $${payout.toFixed(2)} (+${payoutPct}%)`);
        console.log(`  Confidence       : ${(analysis.confidence * 100).toFixed(2)}%`);
        console.log(`${'═'.repeat(70)}\n`);

        this._placeTrade(asset, analysis, proposal);
    }

    _placeTrade(asset, analysis, proposal) {
        if (this.activeTrades[asset]) return;

        this._send({ buy: proposal.id, price: this.currentStake.toFixed(2) });

        this.activeTrades[asset] = {
            status: 'buying',
            proposalId: proposal.id,
            stake: this.currentStake,
            analysis,
            entryTime: Date.now(),
        };

        delete this.proposalIds[asset];
        this.hourlyTrades.push(Date.now());

        this._sendTelegram(
            `💼 <b>Frequency Analysis Trade</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Predicted Digit: ${analysis.predictedDigit}\n` +
            `Current Digit: ${analysis.currentDigit}\n` +
            `Confidence: ${(analysis.confidence * 100).toFixed(2)}%\n\n` +
            `<b>Frequencies:</b>\n` +
            `Short: ${analysis.analysis.shortFrequency}%\n` +
            `Medium: ${analysis.analysis.mediumFrequency}%\n` +
            `Long: ${analysis.analysis.longFrequency}%\n\n` +
            `<b>Repeat Probability:</b>\n` +
            `Average: ${analysis.analysis.avgRepeatProb}%\n\n` +
            `Stake: $${this.currentStake.toFixed(2)}`
        );

        this.lastTradeTime[asset] = Date.now();
        this._startWatchdog(asset);
    }

    _onBuy(msg) {
        const proposalId = msg.echo_req?.buy;
        const asset = proposalId
            ? Object.keys(this.activeTrades).find(a => this.activeTrades[a]?.proposalId === proposalId)
            : Object.keys(this.activeTrades).find(a => this.activeTrades[a]?.status === 'buying');

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
        console.log(`  Predicted Digit: ${trade.analysis.predictedDigit}`);
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
            this.currentStake = Math.ceil(this.currentStake * this.cfg.multiplier * 100) / 100;
        }

        delete this.activeTrades[asset];

        const wr = ((this.totalWins / this.totalTrades) * 100).toFixed(2);

        this._sendTelegram(
            `${won ? '✅' : '❌'} <b>Result</b>\n\n` +
            `Asset: ${asset}\n` +
            `Predicted Digit: ${trade.analysis.predictedDigit}\n` +
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
                `⏰ <b>Frequency Analysis Bot - Hourly Summary</b>`, ``,
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
                `📊 <b>SESSION SUMMARY — Frequency Analysis Bot</b>`, ``,
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
                this.activeTrades = {};
                this.connect();
            }

            if (!this.endOfDay && hr === 11) {
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
        console.log('  📊 DERIV DIGIT FREQUENCY ANALYSIS BOT');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('  ✓ Multi-Window Frequency Analysis');
        console.log('  ✓ Repeat Probability Detection');
        console.log('  ✓ Configurable Thresholds');
        console.log(`\n  Window Sizes: Short(${this.cfg.frequencyAnalysis.shortWindow}) | Medium(${this.cfg.frequencyAnalysis.mediumWindow}) | Long(${this.cfg.frequencyAnalysis.longWindow})`);
        console.log(`  Frequency Thresholds: ${this.cfg.frequencyAnalysis.shortWindowThreshold}% | ${this.cfg.frequencyAnalysis.mediumWindowThreshold}% | ${this.cfg.frequencyAnalysis.longWindowThreshold}%`);
        console.log(`  Max Repeat Probability: ${this.cfg.frequencyAnalysis.maxRepeatProbability}%`);
        console.log(`  Multiplier: ${this.cfg.multiplier}×  |  Max losses: ${this.cfg.maxConsecutiveLosses}`);
        console.log('═══════════════════════════════════════════════════════════════\n');

        if (!this.cfg.token) {
            console.error('❌ DERIV_TOKEN not set — aborting');
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
const bot = new DerivFrequencyBot(BOT_CONFIG);
bot.start();
