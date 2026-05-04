/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║        differBot v2 — 4-Engine Consensus Digit Differ        ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  STRATEGY (corrected):                                       ║
 * ║  • DIGITDIFF wins when next_digit ≠ chosen_digit             ║
 * ║  • Win prob = 1 − P(chosen_digit appears next)               ║
 * ║  • Goal: choose the COLDEST digit (least likely next tick)   ║
 * ║                                                              ║
 * ║  4-ENGINE CONSENSUS:                                         ║
 * ║  1. MarkovEngine    — Order-2 Markov chain transitions       ║
 * ║  2. FrequencyEngine — Multi-window (20/50/100) cold digit    ║
 * ║  3. StatisticalEngine — Z-score + Chi-square + Entropy       ║
 * ║  4. StreakEngine    — Absence streak + hot-filter veto        ║
 * ║                                                              ║
 * ║  Engines vote → weighted consensus → coldest digit chosen    ║
 * ║  Martingale stake recovery on loss                           ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { ConsensusAnalyzer } = require('./differAnalyzer');


// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — edit these values before running
// ─────────────────────────────────────────────────────────────────────────────
const BOT_CONFIG = {
    token: 'hsj0tA0XJoIzJG5',        // Deriv API token

    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'],

    initialStake: 1,               // Starting stake in USD
    multiplier: 11.3,              // Martingale multiplier on loss
    maxConsecutiveLosses: 3,               // Stop-loss trigger
    stopLoss: 108,             // Total P&L stop-loss (USD)
    takeProfit: 10000,           // Session take-profit (USD)

    // ── 4-Engine Consensus Settings ──────────────────────────────
    requiredHistoryLength: 1000,      // Ticks needed before analysis starts

    // Markov Engine
    markovMinSamples: 20,           // Min state observations to trust Markov

    // Frequency Engine
    freqWindows: [20, 50, 100],     // Multi-window sizes
    freqWeights: [0.50, 0.30, 0.20],// Weights (recent ticks weighted highest)

    // Statistical Engine
    statWindow: 100,                // Window for chi-square / z-score
    minChiSquare: 3.5,              // Min chi-square stat to detect bias
    maxEntropy: 3.10,               // Max Shannon entropy (bits) — higher = too random

    // Streak Engine
    hotFilterTicks: 3,              // Veto digit if appeared in last N ticks

    // Consensus Gate
    minConsensusScore: 0.45,        // Minimum weighted consensus score to trade
    minEnginesAgreeing: 2,          // Minimum engines that must vote same digit

    minTimeBetweenTrades: 5000,     // ms cooldown per asset after a trade

    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    telegramChatId: '752497117',

    maxReconnectAttempts: 50,
    reconnectDelay: 5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'pattern_differBot_state.json');
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
                    recentPredictions: bot.recentPredictions,
                },
                assetMetrics: bot.assetMetrics,
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

// NOTE: DigitDifferAnalyzer replaced by ConsensusAnalyzer from differAnalyzer.js

// ══════════════════════════════════════════════════════════════════════════════
// MONTE CARLO SIMULATOR — Risk Analysis & Position Sizing
// ══════════════════════════════════════════════════════════════════════════════
class MonteCarloSimulator {
    /**
     * Run Monte Carlo simulation of future trades
     * Returns confidence metrics for position sizing
     */
    static runSimulation(recentTrades, numSimulations = 1000, numFutureTrades = 50) {
        if (recentTrades.length < 10) {
            return {
                canTrade: true,
                confidence: 0.5,
                recommendedStakeMultiplier: 1.0,
                riskOfRuin: 0.05,
                maxDrawdown: 0.2,
                expectedDrawdown: 0.1,
                winProbability: 0.5
            };
        }

        const winRate = recentTrades.filter(t => t.won).length / recentTrades.length;
        const avgWin = this.getAverageWin(recentTrades);
        const avgLoss = this.getAverageLoss(recentTrades);

        if (avgWin <= 0) {
            return {
                canTrade: false,
                reason: 'no_winning_trades',
                confidence: 0,
                recommendedStakeMultiplier: 0.5,
                riskOfRuin: 1.0
            };
        }

        const payoutRatio = avgWin / avgLoss;

        // Run simulations
        const results = [];
        for (let sim = 0; sim < numSimulations; sim++) {
            const simResults = this.runSingleSimulation(
                winRate,
                avgWin,
                avgLoss,
                numFutureTrades
            );
            results.push(simResults);
        }

        // Analyze results
        const finalBalance = results.map(r => r.finalBalance);
        const maxDrawdowns = results.map(r => r.maxDrawdown);
        const minDrawdowns = results.map(r => r.minBalance);

        finalBalance.sort((a, b) => a - b);
        maxDrawdowns.sort((a, b) => a - b);

        const avgFinalBalance = finalBalance.reduce((a, b) => a + b) / finalBalance.length;
        const var95 = finalBalance[Math.floor(finalBalance.length * 0.05)];
        const expectedDrawdown = maxDrawdowns[Math.floor(maxDrawdowns.length * 0.5)];
        const worst95Drawdown = maxDrawdowns[Math.floor(maxDrawdowns.length * 0.95)];

        const riskOfRuin = results.filter(r => r.finalBalance <= 0).length / numSimulations;

        const confidence = Math.max(0, Math.min(1, (avgFinalBalance / 100) * 0.5 + (1 - riskOfRuin) * 0.5));

        let recommendedMultiplier = 1.0;
        if (riskOfRuin < 0.01 && confidence > 0.8) recommendedMultiplier = 1.3;
        else if (riskOfRuin < 0.05 && confidence > 0.7) recommendedMultiplier = 1.15;
        else if (riskOfRuin > 0.15) recommendedMultiplier = 0.7;

        return {
            canTrade: riskOfRuin < 0.2,
            confidence,
            recommendedStakeMultiplier: recommendedMultiplier,
            riskOfRuin,
            expectedDrawdown: expectedDrawdown / 100,
            worst95Drawdown: worst95Drawdown / 100,
            var95: var95 / 100,
            winRate,
            payoutRatio,
            simulations: numSimulations
        };
    }

    static runSingleSimulation(winRate, avgWin, avgLoss, numTrades) {
        let balance = 100;
        let minBalance = 100;

        for (let i = 0; i < numTrades; i++) {
            const won = Math.random() < winRate;
            if (won) {
                balance += avgWin;
            } else {
                balance -= avgLoss;
            }
            minBalance = Math.min(minBalance, balance);
        }

        const maxDrawdown = ((minBalance - 100) / 100) * 100;

        return {
            finalBalance: balance,
            minBalance,
            maxDrawdown
        };
    }

    static getAverageWin(trades) {
        const wins = trades.filter(t => t.won);
        if (wins.length === 0) return 0;
        return wins.reduce((sum, t) => sum + t.profit, 0) / wins.length;
    }

    static getAverageLoss(trades) {
        const losses = trades.filter(t => !t.won);
        if (losses.length === 0) return 0;
        return losses.reduce((sum, t) => sum + Math.abs(t.profit), 0) / losses.length;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN BOT
// ─────────────────────────────────────────────────────────────────────────────
class DigitDifferBot {
    constructor(config) {
        this.cfg = config;

        // Connection
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.reconnectAttempts = 0;
        this.pingInterval = null;

        // Global trade lock (one contract at a time across all assets)
        this.tradeInProgress = false;
        this.tradeStartTime = null;
        this.tradeWatchdogMs = 30000;      // Differ trades resolve in ~1 tick, 30s is generous
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
        this.recentPredictions = [];    // Last predicted digits (avoid repeating same digit)

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

        // 4-Engine Consensus Analyzer (per-asset, each has its own Markov state)
        this.analyzers = {};
        config.assets.forEach(a => {
            this.analyzers[a] = new ConsensusAnalyzer({
                requiredHistoryLength: config.requiredHistoryLength,
                markovMinSamples: config.markovMinSamples,
                freqWindows: config.freqWindows,
                freqWeights: config.freqWeights,
                statWindow: config.statWindow,
                minChiSquare: config.minChiSquare,
                maxEntropy: config.maxEntropy,
                hotFilterTicks: config.hotFilterTicks,
                minConsensusScore: config.minConsensusScore,
                minEnginesAgreeing: config.minEnginesAgreeing,
            });
        });

        // Monte Carlo
        this.monteCarlo = new MonteCarloSimulator();

        // Trading history (for Monte Carlo)
        this.tradeHistory = [];
        this.maxTradeHistory = 100;

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
                this.recentPredictions = s.trading.recentPredictions || [];
            }
            if (s.assetMetrics) this.assetMetrics = s.assetMetrics;
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
                else console.log(`✅ Sold for $${msg.sell?.sold_for}`);
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
        // Bootstrap Markov matrix from history
        this.analyzers[asset].bootstrap(this.digitHistories[asset]);
        console.log(`📊 ${asset}: loaded ${this.digitHistories[asset].length} ticks, Markov bootstrapped`);
    }

    _onTick(tick) {
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);
        const digit = this._lastDigit(price, asset);

        this.priceHistories[asset].push(price);
        if (this.priceHistories[asset].length > 500) this.priceHistories[asset] = this.priceHistories[asset].slice(-300);

        this.digitHistories[asset].push(digit);
        if (this.digitHistories[asset].length > 500) this.digitHistories[asset] = this.digitHistories[asset].slice(-300);

        // Update Markov matrix incrementally on every tick
        this.analyzers[asset].update(this.digitHistories[asset]);

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
        const analysis = this.analyzers[asset].analyze(this.digitHistories[asset]);

        if (!analysis.shouldTrade) return;

        // Request a Digit Differ proposal for the coldest (least likely) digit
        this._requestProposal(asset, analysis.predictedDigit);
    }

    _requestProposal(asset, predictedDigit) {
        if (this.tradeInProgress) return;

        // console.log(`\n📋 Requesting DIFFER proposal — ${asset} digit ${predictedDigit}`);

        this._send({
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'DIGITDIFF',
            currency: 'USD',
            symbol: asset,
            duration: 1,
            duration_unit: 't',
            barrier: predictedDigit.toString(),  // The digit we bet will NOT appear
        });
    }

    _onProposal(msg) {
        if (msg.error) {
            console.log(`❌ Proposal error: ${msg.error.message}`);
            return;
        }

        const asset = msg.echo_req?.symbol;
        if (!asset) return;
        if (this.tradeInProgress) return;

        const proposal = msg.proposal;
        this.proposalIds[asset] = proposal.id;

        // Re-confirm analysis (market may have moved since proposal request)
        const analysis = this.analyzers[asset].analyze(this.digitHistories[asset]);

        if (!analysis.shouldTrade) {
            console.log(`   ❌ [${asset}] Conditions changed — aborting (${analysis.reason})`);
            return;
        }

        const predictedDigit = analysis.predictedDigit;
        const payout = parseFloat(proposal.payout || 0);
        const payoutPct = this.currentStake > 0 ? ((payout - this.currentStake) / this.currentStake * 100).toFixed(1) : '?';
        const ev = analysis.engineVotes || {};
        const entropy = analysis.entropy != null ? analysis.entropy.toFixed(3) : 'n/a';
        const chi = analysis.chiSquare != null ? analysis.chiSquare.toFixed(2) : 'n/a';
        const absence = analysis.absenceStreak != null ? analysis.absenceStreak : 'n/a';
        const wFreq = analysis.weightedFreq != null ? (analysis.weightedFreq * 100).toFixed(1) : 'n/a';
        const zScore = analysis.zScore != null ? analysis.zScore.toFixed(2) : 'n/a';

        {
            console.log(`\n🎯 ENTRY SIGNAL — ${asset}`);
            console.log(`   Strategy: COLD-DIGIT DIFFER (betting digit ${predictedDigit} will NOT appear)`);
            console.log(`   Last 10 Digits: [${this.digitHistories[asset].slice(-10)}]`);
            console.log(`   Consensus Score: ${(analysis.consensusScore * 100).toFixed(1)}% (${analysis.agreeing} engines agree)`);
            console.log(`   Engine Votes — Markov:${ev.markov?.vote ?? '-'} Freq:${ev.frequency?.vote ?? '-'} Stat:${ev.statistical?.vote ?? '-'} Streak:${ev.streak?.vote ?? '-'}`);
            console.log(`   Entropy: ${entropy} bits | Chi²: ${chi} | Z-Score: ${zScore}`);
            console.log(`   Absence Streak: ${absence} ticks | Weighted Freq: ${wFreq}%`);
            console.log(`   Stake: $${this.currentStake.toFixed(2)} | Payout: $${payout.toFixed(2)} (+${payoutPct}%)`);
            console.log(`   Consecutive losses: ${this.consecutiveLosses}`);

            const mcResult = MonteCarloSimulator.runSimulation(this.tradeHistory, 500, 50);
            console.log(`   MC Confidence: ${(mcResult.confidence * 100).toFixed(1)}%`);
            console.log(`   MC Win Probability: ${(mcResult.winProbability * 100).toFixed(1)}%`);

            this._placeTrade(asset, predictedDigit, proposal, analysis, mcResult);
        }
    }

    _placeTrade(asset, predictedDigit, proposal, analysis, mcResult) {
        if (this.tradeInProgress) return;

        const proposalId = this.proposalIds[asset];
        if (!proposalId) { console.error(`❌ No proposal ID for ${asset}`); return; }

        this._send({ buy: proposalId, price: this.currentStake.toFixed(2) });

        this.tradeInProgress = true;
        this.activeTrades[asset] = {
            status: 'buying',
            proposalId,
            stake: this.currentStake,
            predictedDigit,
            entryTime: Date.now(),
        };

        const _ev = analysis.engineVotes || {};
        this._sendTelegram(
            `\ud83c\udfaf <b>BOTv2 Trade Opened</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Strategy: COLD-DIGIT DIFFER\n` +
            `Betting digit <b>${predictedDigit}</b> will NOT appear\n` +
            `Last 10: [${this.digitHistories[asset].slice(-10)}]\n` +
            `Consensus: ${(analysis.consensusScore * 100).toFixed(1)}% (${analysis.agreeing} engines agree)\n` +
            `Votes \u2014 Mk:${_ev.markov?.vote ?? '-'} Fr:${_ev.frequency?.vote ?? '-'} Stat:${_ev.statistical?.vote ?? '-'} Sk:${_ev.streak?.vote ?? '-'}\n` +
            `Entropy: ${analysis.entropy?.toFixed(3) ?? 'n/a'} bits | Chi\u00b2: ${analysis.chiSquare?.toFixed(2) ?? 'n/a'}\n` +
            `Z-Score: ${analysis.zScore?.toFixed(2) ?? 'n/a'} | Absence: ${analysis.absenceStreak ?? 'n/a'} ticks\n` +
            `MC Confidence: ${(mcResult.confidence * 100).toFixed(1)}%\n` +
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

        if (!asset) { console.warn('Buy response but no pending trade'); return; }

        const contractId = msg.buy.contract_id;
        console.log(`✅ Contract opened: ${contractId} on ${asset}`);

        this.activeTrades[asset].status = 'active';
        this.activeTrades[asset].contractId = contractId;

        this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
    }

    // ── Contract monitoring ───────────────────────────────────────────────────
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

    // ── Trade result ──────────────────────────────────────────────────────────
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

        // Record prediction regardless of win/loss (for repeat-guard)
        this.recentPredictions.push(trade.predictedDigit);
        if (this.recentPredictions.length > 10) this.recentPredictions.shift();

        // Add to trade history (for Monte Carlo)
        this.tradeHistory.push({
            won: won,
            profit: profit,
            stake: trade.stake,
            predictedDigit: trade.predictedDigit,
            timestamp: Date.now()
        });

        // Keep history size manageable
        if (this.tradeHistory.length > this.maxTradeHistory) {
            this.tradeHistory.shift();
        }

        console.log(`\n${'═'.repeat(55)}`);
        console.log(`  ${won ? '✅ WIN' : '❌ LOSS'}: ${asset}`);
        console.log(`  Predicted digit: ${trade.predictedDigit} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
        console.log(`${'═'.repeat(55)}`);

        // Update global stats
        this.totalTrades += 1;
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

        this._sendTelegram(
            `${won ? '✅' : '❌'} <b>BOTv1 Trade Result</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Digit bet: ${trade.predictedDigit} | ${won ? 'Did NOT appear ✅' : 'Appeared ❌'}\n` +
            `Last 10 Digits: ${this.digitHistories[asset].slice(-10)}\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
            `Consecutive losses: ${this.consecutiveLosses}\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
            `Losses x2-x5: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4} | ${this.consecutiveLosses5}\n` +
            `Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00'}%\n` +
            `Next stake: $${this.currentStake.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`
        );

        this._logSummary();
        StatePersistence.save(this);

        // Stop conditions
        if (this.totalProfitLoss >= this.cfg.takeProfit) {
            console.log('🎯 Take Profit reached — stopping');
            this.endOfDay = true;
            this._sendTelegram(`🎯 <b>Take Profit reached!</b> P&L: +$${this.totalProfitLoss.toFixed(2)}`);
            this._cleanupWs();
            return;
        }
        if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses || this.totalProfitLoss <= -this.cfg.stopLoss) {
            console.log('🛑 Stop condition met — disconnecting');
            this.endOfDay = true;
            this._sendTelegram(`🛑 <b>Stop condition met</b>\nLosses: ${this.consecutiveLosses} | P&L: $${this.totalProfitLoss.toFixed(2)}`);
            this._cleanupWs();
        }
    }

    // ── Watchdog ──────────────────────────────────────────────────────────────
    _startWatchdog(asset) {
        this._clearWatchdog();
        this._wdTimer = setTimeout(() => {
            const contractId = this.activeTrades[asset]?.contractId;
            if (!contractId) { this._clearWatchdog(); return; }

            console.warn(`⏰ WATCHDOG — contract ${contractId} unresolved after ${this.tradeWatchdogMs / 1000}s`);

            if (this.connected && this.wsReady) {
                this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
                this._wdPollTimer = setTimeout(() => {
                    if (!this.activeTrades[asset]) { this._clearWatchdog(); return; }
                    console.error(`🚨 WATCHDOG: poll timed out — force releasing`);
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
        const open = Math.round((Date.now() - (this.tradeStartTime || Date.now())) / 1000);

        console.error(`🚨 STUCK TRADE [${reason}] — ${asset} | ${contractId} | open ${open}s`);

        if (contractId && this.connected) this._send({ sell: contractId, price: '0' });
        if (this.contractSubs[asset]) { this._send({ forget: this.contractSubs[asset] }); delete this.contractSubs[asset]; }

        this.tradeInProgress = false;
        this.tradeStartTime = null;
        delete this.activeTrades[asset];

        this.totalLosses++;
        this.consecutiveLosses++;
        this.totalProfitLoss -= stake;
        this.dailyProfitLoss -= stake;
        this.assetMetrics[asset].losses++;
        this.assetMetrics[asset].profitLoss -= stake;

        this.currentStake = Math.ceil(this.currentStake * this.cfg.multiplier * 100) / 100;

        this._sendTelegram(`🚨 <b>Stuck trade recovered [${reason}]</b>\nAsset: ${asset}\nStake recorded as loss: $${stake.toFixed(2)}`);
        StatePersistence.save(this);
    }

    // ── Telegram ──────────────────────────────────────────────────────────────
    async _sendTelegram(text) {
        if (!this.telegram) return;
        try { await this.telegram.sendMessage(this.cfg.telegramChatId, text, { parse_mode: 'HTML' }); }
        catch (e) { console.error(`Telegram: ${e.message}`); }
    }

    // ── Logging ───────────────────────────────────────────────────────────────
    _logAnalysis(asset, analysis) {
        const ev = analysis.engineVotes || {};
        const entropy = analysis.entropy != null ? analysis.entropy.toFixed(2) : '?';
        const chi = analysis.chiSquare != null ? analysis.chiSquare.toFixed(1) : '?';
        const digit = analysis.predictedDigit !== undefined ? `D${analysis.predictedDigit}` : '--';
        const votes = `Mk:${ev.markov?.vote ?? '-'} Fr:${ev.frequency?.vote ?? '-'} Stat:${ev.statistical?.vote ?? '-'} Sk:${ev.streak?.vote ?? '-'}`;

        console.log(
            `📊 ${asset} | ${digit} | Consensus:${((analysis.consensusScore || 0) * 100).toFixed(0)}% ` +
            `(${analysis.agreeing ?? 0} engines) | [${votes}] | ` +
            `H:${entropy}bits Chi:${chi} | ` +
            `${analysis.shouldTrade ? '✅' : '❌'} ${analysis.reason}`
        );
    }

    _logSummary() {
        const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';
        console.log('\n📊 Summary:');
        console.log(`  Trades: ${this.totalTrades} | W: ${this.totalWins} | L: ${this.totalLosses} | WR: ${wr}%`);
        console.log(`  x2 losses: ${this.consecutiveLosses2} | x3: ${this.consecutiveLosses3} | x4: ${this.consecutiveLosses4}`);
        console.log(`  Total P&L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`  Stake: $${this.currentStake.toFixed(2)}`);
    }

    // ── Time-based reconnect (unchanged from accumulator) ─────────────────────
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
                this.recentPredictions = [];
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
        console.log('═'.repeat(59));
        console.log('  🎯 differBot v2 — 4-Engine Consensus Digit Differ Bot');
        console.log('═'.repeat(59));
        console.log(`  Assets:        ${this.cfg.assets.join(', ')}`);
        console.log(`  Stake:         $${this.cfg.initialStake} × ${this.cfg.multiplier}x martingale`);
        console.log(`  Strategy:      COLD-DIGIT DIFFER (least likely digit)`);
        console.log(`  Engines:       Markov(0.35) Freq(0.30) Stat(0.20) Streak(0.15)`);
        console.log(`  Consensus gate: ≥${(this.cfg.minConsensusScore * 100).toFixed(0)}% score, ≥${this.cfg.minEnginesAgreeing} engines`);
        console.log(`  Entropy gate:   < ${this.cfg.maxEntropy} bits (random market filter)`);
        console.log(`  Chi² gate:      > ${this.cfg.minChiSquare} (bias detection)`);
        console.log(`  Hot filter:     veto if digit in last ${this.cfg.hotFilterTicks} ticks`);
        console.log(`  Max losses:    ${this.cfg.maxConsecutiveLosses}`);
        console.log('═'.repeat(59) + '\n');

        this.connect();
        // this._startTimeScheduler();
        StatePersistence.startAutoSave(this);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
const bot = new DigitDifferBot(BOT_CONFIG);
bot.start();
