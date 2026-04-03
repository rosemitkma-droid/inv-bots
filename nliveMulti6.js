/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Deriv Accumulator Bot v4.0 — VAQM Strategy (Single File)
 *  "Volatility-Adaptive Quick-Scalp with Multi-Lane Execution"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  FUNDAMENTAL CHANGES FROM v3.1:
 *  1. Tick-level Bollinger+MACD on actual price changes (not digit analysis)
 *  2. Dynamic growth rate selection (1–3%, not fixed 5%)
 *  3. Multi-lane concurrent trading across assets
 *  4. Kelly criterion staking (not martingale)
 *  5. Quick scalp targets (3–5 ticks)
 *  6. Working sell execution (not commented out)
 *  7. No "entry window" based on ticks_stayed_in (irrelevant to new contract)
 *  8. All secrets in .env
 *
 *  Usage:
 *    1. Create .env file with DERIV_API_TOKEN, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
 *    2. npm install ws node-telegram-bot-api dotenv
 *    3. node accumulator-bot-v4.js
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ════════════════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

const CONFIG = {
    // --- Connection ---
    apiEndpoint: 'wss://ws.binaryws.com/websockets/v3?app_id=1089',

    // --- Assets (lower volatility indices are safer for accumulators) ---
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],

    // --- Dynamic growth rate tiers (selected per-trade based on volatility) ---
    growthRates: {
        veryCalm: { rate: 0.03, targetTicks: 5, label: '3%' },
        calm: { rate: 0.02, targetTicks: 4, label: '2%' },
        normal: { rate: 0.01, targetTicks: 3, label: '1%' },
    },

    // --- Barrier widths by growth rate (from Deriv specifications) ---
    barrierWidths: {
        0.01: 0.0064867741,
        0.02: 0.0058,
        0.03: 0.0053,
        0.04: 0.0051,
        0.05: 0.0049358253,
    },

    // --- Volatility Engine ---
    volatility: {
        veryCalmMax: 0.25,
        calmMax: 0.40,
        normalMax: 0.55,
        lookbackTicks: 50,
        emaFastPeriod: 5,
        emaSlowPeriod: 13,
        emaSignalPeriod: 4,
        bollingerPeriod: 20,
        bollingerStdDev: 2,
        maxMacdHistogram: 0.0002,
        minConfidence: 0.60,
    },

    // --- Staking (Kelly Criterion) ---
    staking: {
        bankroll: 100,
        maxStakePercent: 0.03,
        reducedStakePercent: 0.015,
        minStake: 1,
        maxStake: 50,
        losingStreakThreshold: 3,
        kellySafetyFactor: 0.25,
    },

    // --- Risk ---
    risk: {
        maxDailyLoss: 100,
        maxDailyLossPercent: 0.20,
        maxConsecutiveLosses: 6,
        assetCooldownMs: 15000,
        globalCooldownMs: 3000,
        maxConcurrentTrades: 3,
    },

    // --- Session ---
    session: {
        takeProfitTotal: 50000,
        maxTrades: 200000000,
    },

    // --- History ---
    requiredHistoryTicks: 100,

    // --- Analysis Throttle ---
    analysisIntervalMs: 1500,

    // --- State persistence ---
    stateFile: path.join(__dirname, 'accumulator-bot-v4-state_002.json'),
    stateSaveIntervalMs: 5000,

    // --- Reconnection ---
    maxReconnectAttempts: 30,
    baseReconnectDelayMs: 5000,
};

// ════════════════════════════════════════════════════════════════════════════
//  STATE PERSISTENCE
// ════════════════════════════════════════════════════════════════════════════

class StatePersistence {
    static saveState(bot) {
        try {
            const data = {
                savedAt: Date.now(),
                riskManager: {
                    bankroll: bot.riskManager.bankroll,
                    dailyProfitLoss: bot.riskManager.dailyProfitLoss,
                    sessionProfitLoss: bot.riskManager.sessionProfitLoss,
                    totalTrades: bot.riskManager.totalTrades,
                    totalWins: bot.riskManager.totalWins,
                    globalConsecutiveLosses: bot.riskManager.globalConsecutiveLosses,
                    isWinTrade: bot.isWinTrade,
                    endOfDay: bot.endOfDay,
                },
                laneStats: {},
            };

            for (const [asset, lane] of Object.entries(bot.lanes)) {
                data.laneStats[asset] = { ...lane.stats };
            }

            fs.writeFileSync(CONFIG.stateFile, JSON.stringify(data, null, 2));
            return true;
        } catch (err) {
            console.error(`❌ State save failed: ${err.message}`);
            return false;
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(CONFIG.stateFile)) {
                console.log('🆕 No saved state found — starting fresh');
                return null;
            }

            const raw = fs.readFileSync(CONFIG.stateFile, 'utf8');
            const data = JSON.parse(raw);
            const ageMin = (Date.now() - data.savedAt) / 60000;

            if (ageMin > 60) {
                console.warn(`⚠️ State is ${ageMin.toFixed(1)} min old — starting fresh`);
                const backup = CONFIG.stateFile.replace('.json', `_bak_${Date.now()}.json`);
                fs.renameSync(CONFIG.stateFile, backup);
                return null;
            }

            console.log(`📂 Restoring state from ${ageMin.toFixed(1)} min ago`);
            return data;
        } catch (err) {
            console.error(`❌ State load failed: ${err.message}`);
            return null;
        }
    }

    static startAutoSave(bot) {
        if (bot._autoSaveTimer) clearInterval(bot._autoSaveTimer);

        bot._autoSaveTimer = setInterval(() => {
            if (bot.connected) StatePersistence.saveState(bot);
        }, CONFIG.stateSaveIntervalMs);

        const onExit = () => {
            console.log('\n🛑 Saving final state before exit...');
            StatePersistence.saveState(bot);
            process.exit();
        };

        process.on('SIGINT', onExit);
        process.on('SIGTERM', onExit);
        process.on('uncaughtException', (err) => {
            console.error('Uncaught exception:', err);
            onExit();
        });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  VOLATILITY ENGINE  (Bollinger + MACD on tick-to-tick % changes)
// ════════════════════════════════════════════════════════════════════════════

class VolatilityEngine {
    constructor() {
        this.priceHistories = {};
        this.changeHistories = {};
        this.indicators = {};
        this.macdHistory = {};
    }

    // ------------------------------------------------------------------
    //  Feed a new raw price
    // ------------------------------------------------------------------
    addTick(asset, price) {
        if (!this.priceHistories[asset]) {
            this.priceHistories[asset] = [];
            this.changeHistories[asset] = [];
            this.macdHistory[asset] = [];
            this.indicators[asset] = { ready: false };
        }

        const prices = this.priceHistories[asset];
        const changes = this.changeHistories[asset];

        prices.push(price);

        if (prices.length >= 2) {
            const prev = prices[prices.length - 2];
            const curr = prices[prices.length - 1];
            if (prev !== 0) {
                changes.push(Math.abs((curr - prev) / prev) * 100);
            }
        }

        // Bound history length
        const maxLen = CONFIG.volatility.lookbackTicks * 3;
        if (prices.length > maxLen) prices.splice(0, prices.length - maxLen);
        if (changes.length > maxLen) changes.splice(0, changes.length - maxLen);

        this._computeIndicators(asset);
    }

    // ------------------------------------------------------------------
    //  Get trading signal
    // ------------------------------------------------------------------
    getSignal(asset) {
        const ind = this.indicators[asset];
        if (!ind || !ind.ready) {
            return { signal: 'NO_TRADE', reason: 'insufficient_data' };
        }

        const {
            bandwidthRatio,
            macdHistogram,
            macdTrending,
            bollingerSqueezing,
        } = ind;

        // HARD: Too volatile
        if (bandwidthRatio > CONFIG.volatility.normalMax) {
            return {
                signal: 'NO_TRADE',
                reason: `too_volatile (bw=${bandwidthRatio.toFixed(4)})`,
                details: ind,
            };
        }

        // HARD: Momentum detected
        if (Math.abs(macdHistogram) > CONFIG.volatility.maxMacdHistogram || macdTrending) {
            return {
                signal: 'NO_TRADE',
                reason: `momentum (macd=${macdHistogram.toFixed(6)}, trending=${macdTrending})`,
                details: ind,
            };
        }

        // Determine tier
        let tier;
        if (bandwidthRatio < CONFIG.volatility.veryCalmMax) {
            tier = 'veryCalm';
        } else if (bandwidthRatio < CONFIG.volatility.calmMax) {
            tier = 'calm';
        } else {
            tier = 'normal';
        }

        // Confidence score
        const volScore = 1 - (bandwidthRatio / CONFIG.volatility.normalMax);
        const momScore = 1 - Math.min(1, Math.abs(macdHistogram) / CONFIG.volatility.maxMacdHistogram);
        const sqzBonus = bollingerSqueezing ? 0.15 : 0;
        const confidence = volScore * 0.50 + momScore * 0.30 + sqzBonus * 0.20;

        if (confidence < CONFIG.volatility.minConfidence) {
            return {
                signal: 'NO_TRADE',
                reason: `low_confidence (${(confidence * 100).toFixed(1)}%)`,
                details: ind,
            };
        }

        return { signal: 'GO', tier, confidence, details: ind };
    }

    // ------------------------------------------------------------------
    //  Compute indicators
    // ------------------------------------------------------------------
    _computeIndicators(asset) {
        const changes = this.changeHistories[asset];
        if (!changes || changes.length < CONFIG.volatility.lookbackTicks) {
            this.indicators[asset] = { ready: false };
            return;
        }

        const recent = changes.slice(-CONFIG.volatility.lookbackTicks);

        // --- Bollinger on tick-changes ---
        const bbP = CONFIG.volatility.bollingerPeriod;
        const bbSlice = recent.slice(-bbP);
        const mean = bbSlice.reduce((s, v) => s + v, 0) / bbP;
        const variance = bbSlice.reduce((s, v) => s + (v - mean) ** 2, 0) / bbP;
        const stdDev = Math.sqrt(variance);

        const upperBand = mean + CONFIG.volatility.bollingerStdDev * stdDev;
        const lowerBand = mean - CONFIG.volatility.bollingerStdDev * stdDev;

        // Bandwidth ratio vs. the 1% barrier (widest/safest reference)
        const refBarrier = CONFIG.barrierWidths[0.01];
        const bandwidthRatio = stdDev / refBarrier;

        // Squeeze detection: current stdDev vs longer-window stdDev
        const longSlice = recent.slice(-40);
        const longMean = longSlice.reduce((s, v) => s + v, 0) / longSlice.length;
        const longVar = longSlice.reduce((s, v) => s + (v - longMean) ** 2, 0) / longSlice.length;
        const longStdDev = Math.sqrt(longVar);
        const bollingerSqueezing = stdDev < longStdDev * 0.80;

        // --- MACD on tick-changes ---
        const emaFast = this._ema(recent, CONFIG.volatility.emaFastPeriod);
        const emaSlow = this._ema(recent, CONFIG.volatility.emaSlowPeriod);
        const macdLine = emaFast - emaSlow;

        // Maintain a short MACD history per asset for signal line
        this.macdHistory[asset].push(macdLine);
        if (this.macdHistory[asset].length > 30) this.macdHistory[asset].shift();

        const macdSignal = this.macdHistory[asset].length >= CONFIG.volatility.emaSignalPeriod
            ? this._ema(this.macdHistory[asset], CONFIG.volatility.emaSignalPeriod)
            : macdLine;

        const macdHistogram = macdLine - macdSignal;

        // Trending detection: monotonic increase/decrease in last 5 change values
        const tail = recent.slice(-5);
        const allUp = tail.every((v, i) => i === 0 || v >= tail[i - 1] * 0.98);
        const allDown = tail.every((v, i) => i === 0 || v <= tail[i - 1] * 1.02);
        const macdTrending = (allUp && tail[4] > tail[0] * 1.10)
            || (allDown && tail[4] < tail[0] * 0.90);

        this.indicators[asset] = {
            ready: true,
            meanChange: mean,
            stdDev,
            upperBand,
            lowerBand,
            bandwidthRatio,
            bollingerSqueezing,
            macdLine,
            macdSignal,
            macdHistogram,
            macdTrending,
        };
    }

    _ema(data, period) {
        if (data.length === 0) return 0;
        const k = 2 / (period + 1);
        let ema = data[0];
        for (let i = 1; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
        }
        return ema;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  TRADING LANE — Independent state machine per asset
// ════════════════════════════════════════════════════════════════════════════

const LANE_STATES = {
    IDLE: 'IDLE',
    ANALYZING: 'ANALYZING',
    BUYING: 'BUYING',
    ACTIVE: 'ACTIVE',
    COOLDOWN: 'COOLDOWN',
    DISABLED: 'DISABLED',
};

class TradingLane {
    constructor(asset) {
        this.asset = asset;
        this.state = LANE_STATES.IDLE;

        this.currentProposalId = null;
        this.currentContractId = null;
        this.currentSubscriptionId = null;
        this.tradeDetails = null;
        this.cooldownUntil = 0;
        this._cooldownTimer = null;

        this.stats = {
            trades: 0,
            wins: 0,
            losses: 0,
            profitLoss: 0,
            consecutiveLosses: 0,
            lastTradeTime: 0,
        };
    }

    canAnalyze() {
        if (this.state !== LANE_STATES.IDLE) return false;
        if (Date.now() < this.cooldownUntil) return false;
        return true;
    }

    beginAnalysis() {
        this.state = LANE_STATES.ANALYZING;
    }

    prepareTradeFromSignal(signal, growthConfig, stake) {
        const rate = growthConfig.rate;
        const ticks = growthConfig.targetTicks;
        const takeProfitAmount = stake * (Math.pow(1 + rate, ticks) - 1);

        this.tradeDetails = {
            asset: this.asset,
            growthRate: rate,
            targetTicks: ticks,
            stake,
            takeProfitAmount,
            confidence: signal.confidence,
            tier: signal.tier,
            entryTime: Date.now(),
            ticksElapsed: 0,
        };

        return this.tradeDetails;
    }

    setBuying(proposalId) {
        this.currentProposalId = proposalId;
        this.state = LANE_STATES.BUYING;
    }

    setActive(contractId) {
        this.currentContractId = contractId;
        this.state = LANE_STATES.ACTIVE;
    }

    recordResult(won, profit) {
        this.stats.trades++;
        this.stats.profitLoss += profit;

        if (won) {
            this.stats.wins++;
            this.stats.consecutiveLosses = 0;
        } else {
            this.stats.losses++;
            this.stats.consecutiveLosses++;
        }

        this.stats.lastTradeTime = Date.now();

        const cooldownMs = won
            ? CONFIG.risk.globalCooldownMs
            : CONFIG.risk.assetCooldownMs;

        this.cooldownUntil = Date.now() + cooldownMs;
        this._resetTradeState();
        this.state = LANE_STATES.COOLDOWN;

        if (this._cooldownTimer) clearTimeout(this._cooldownTimer);
        this._cooldownTimer = setTimeout(() => {
            if (this.state === LANE_STATES.COOLDOWN) {
                this.state = LANE_STATES.IDLE;
            }
        }, cooldownMs);

        return {
            won,
            profit,
            asset: this.asset,
            consecutiveLosses: this.stats.consecutiveLosses,
        };
    }

    getWinRate() {
        return this.stats.trades > 0 ? this.stats.wins / this.stats.trades : 0;
    }

    reset() {
        this._resetTradeState();
        this.state = LANE_STATES.IDLE;
    }

    _resetTradeState() {
        this.currentProposalId = null;
        this.currentContractId = null;
        this.currentSubscriptionId = null;
        this.tradeDetails = null;
    }

    disable(reason) {
        this.state = LANE_STATES.DISABLED;
        console.log(`🚫 Lane ${this.asset} disabled: ${reason}`);
    }

    restoreStats(saved) {
        if (saved) {
            Object.assign(this.stats, saved);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  RISK MANAGER — Kelly Criterion staking, no martingale
// ════════════════════════════════════════════════════════════════════════════

class RiskManager {
    constructor() {
        this.bankroll = CONFIG.staking.bankroll;
        this.dailyProfitLoss = 0;
        this.sessionProfitLoss = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.globalConsecutiveLosses = 0;
    }

    calculateStake() {
        // Estimate win rate (conservative default until enough data)
        const winRate = this.totalTrades >= 20
            ? this.totalWins / this.totalTrades
            : 0.70;

        // Average win/loss ratios (conservative)
        const avgWinRatio = 0.06;  // ~6% profit per win
        const avgLossRatio = 1.0;   // lose full stake

        // Kelly fraction
        let kelly = (winRate * avgWinRatio - (1 - winRate) * avgLossRatio) / avgWinRatio;
        let fraction = Math.max(0, kelly * CONFIG.staking.kellySafetyFactor);

        // Halve fraction after losing streak
        if (this.globalConsecutiveLosses >= CONFIG.staking.losingStreakThreshold) {
            fraction *= 0.5;
        }

        // Compute and clamp
        let stake = this.bankroll * fraction;
        stake = Math.max(CONFIG.staking.minStake, stake);
        stake = Math.min(CONFIG.staking.maxStake, stake);
        stake = Math.min(this.bankroll * CONFIG.staking.maxStakePercent, stake);
        stake = Math.round(stake * 100) / 100;

        return stake;
    }

    canTrade(activeLaneCount) {
        if (this.dailyProfitLoss <= -CONFIG.risk.maxDailyLoss) {
            return { allowed: false, reason: 'daily_loss_limit' };
        }
        if (this.globalConsecutiveLosses >= CONFIG.risk.maxConsecutiveLosses) {
            return { allowed: false, reason: 'max_consecutive_losses' };
        }
        if (activeLaneCount >= CONFIG.risk.maxConcurrentTrades) {
            return { allowed: false, reason: 'max_concurrent_trades' };
        }
        if (this.sessionProfitLoss >= CONFIG.session.takeProfitTotal) {
            return { allowed: false, reason: 'session_target_reached' };
        }
        if (this.totalTrades >= CONFIG.session.maxTrades) {
            return { allowed: false, reason: 'max_trades_reached' };
        }
        if (this.bankroll < CONFIG.staking.minStake) {
            return { allowed: false, reason: 'bankroll_depleted' };
        }
        return { allowed: true };
    }

    recordResult(won, profit) {
        this.totalTrades++;
        this.dailyProfitLoss += profit;
        this.sessionProfitLoss += profit;
        this.bankroll += profit;

        if (won) {
            this.totalWins++;
            this.globalConsecutiveLosses = 0;
        } else {
            this.globalConsecutiveLosses++;
        }
    }

    restore(saved) {
        if (!saved) return;
        this.bankroll = saved.bankroll ?? this.bankroll;
        this.dailyProfitLoss = saved.dailyProfitLoss ?? 0;
        this.sessionProfitLoss = saved.sessionProfitLoss ?? 0;
        this.totalTrades = saved.totalTrades ?? 0;
        this.totalWins = saved.totalWins ?? 0;
        this.globalConsecutiveLosses = saved.globalConsecutiveLosses ?? 0;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  TRADE EXECUTOR — Proposal → Buy → Monitor → Sell
// ════════════════════════════════════════════════════════════════════════════

class TradeExecutor {
    constructor(sendFn) {
        this.send = sendFn;
        this.pendingBuys = new Map();   // asset → lane
        this.activeContracts = new Map();   // contractId → lane
    }

    // ----- Request a proposal for a lane -----
    requestProposal(lane) {
        const t = lane.tradeDetails;
        this.pendingBuys.set(t.asset, lane);

        this.send({
            proposal: 1,
            amount: t.stake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: t.asset,
            growth_rate: t.growthRate,
            limit_order: {
                take_profit: t.takeProfitAmount.toFixed(2),
            },
        });

        console.log(`  📋 [${t.asset}] Proposal requested — stake=$${t.stake.toFixed(2)}, growth=${(t.growthRate * 100).toFixed(0)}%, TP=$${t.takeProfitAmount.toFixed(3)}`);
    }

    // ----- Handle proposal response — buy immediately -----
    handleProposal(message) {
        if (message.error) {
            const asset = message.echo_req?.symbol;
            if (asset && this.pendingBuys.has(asset)) {
                console.error(`  ❌ [${asset}] Proposal error: ${message.error.message}`);
                this.pendingBuys.get(asset).reset();
                this.pendingBuys.delete(asset);
            }
            return false;
        }

        const asset = message.echo_req?.symbol;
        const lane = this.pendingBuys.get(asset);

        if (!lane || !message.proposal?.id) return false;

        const proposalId = message.proposal.id;
        lane.setBuying(proposalId);

        console.log(`  🛒 [${asset}] Buying proposal ${proposalId}`);
        this.send({
            buy: proposalId,
            price: lane.tradeDetails.stake.toFixed(2),
        });

        return true;
    }

    // ----- Handle buy response -----
    handleBuyResponse(message) {
        if (message.error) {
            console.error(`  ❌ Buy error: ${message.error.message}`);
            // Reset the lane that was buying
            for (const [asset, lane] of this.pendingBuys) {
                if (lane.state === LANE_STATES.BUYING) {
                    lane.reset();
                    this.pendingBuys.delete(asset);
                    break;
                }
            }
            return null;
        }

        const contractId = message.buy.contract_id;
        const purchasePrice = parseFloat(message.buy.buy_price);

        // Find the lane
        let foundLane = null;
        let foundAsset = null;

        for (const [asset, lane] of this.pendingBuys) {
            if (lane.state === LANE_STATES.BUYING) {
                foundLane = lane;
                foundAsset = asset;
                break;
            }
        }

        if (!foundLane) {
            console.warn(`  ⚠️ Buy response for unknown lane (contract ${contractId})`);
            return null;
        }

        this.pendingBuys.delete(foundAsset);
        foundLane.setActive(contractId);
        this.activeContracts.set(contractId, foundLane);

        console.log(`  ✅ [${foundAsset}] Contract ${contractId} ACTIVE — paid $${purchasePrice.toFixed(2)}`);

        // Subscribe to contract updates
        this.send({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
        });

        return { lane: foundLane, contractId };
    }

    // ----- Handle contract updates (THE CRITICAL MONITOR + SELL) -----
    handleContractUpdate(contract) {
        if (!contract) return null;

        const contractId = contract.contract_id;
        const lane = this.activeContracts.get(contractId);
        if (!lane) return null;

        // Capture subscription id for cleanup
        if (contract.id) {
            lane.currentSubscriptionId = contract.id;
        }

        // ---- Contract CLOSED (by take_profit limit order or knockout) ----
        if (contract.is_sold) {
            return this._closeContract(contract, lane);
        }

        // ---- Contract still ACTIVE — monitor & backup sell ----
        const tickCount = contract.tick_count || 0;
        const currentProfit = parseFloat(contract.profit || 0);
        const bidPrice = parseFloat(contract.bid_price || 0);

        if (lane.tradeDetails) {
            lane.tradeDetails.ticksElapsed = tickCount;
        }

        // Progress log every 2 ticks
        if (tickCount > 0 && tickCount % 2 === 0) {
            const target = lane.tradeDetails?.targetTicks || '?';
            console.log(`  📊 [${lane.asset}] Tick ${tickCount}/${target} | Profit: $${currentProfit.toFixed(3)} | Bid: $${bidPrice.toFixed(2)}`);
        }

        // Backup sell logic (take_profit limit order is primary)
        if (contract.is_valid_to_sell && lane.tradeDetails) {
            const sellDecision = this._shouldSell(lane, tickCount, currentProfit, bidPrice);
            if (sellDecision.sell) {
                console.log(`  🎯 [${lane.asset}] SELLING: ${sellDecision.reason}`);
                this._sellContract(contractId, bidPrice);
            }
        }

        return null;
    }

    // ----- Sell decision (backup to limit order) -----
    _shouldSell(lane, ticksHeld, profit, bidPrice) {
        const target = lane.tradeDetails.targetTicks;
        const tp = lane.tradeDetails.takeProfitAmount;

        // 1. Comfortably past target ticks — take_profit should have fired
        if (ticksHeld >= target + 2 && profit > 0) {
            return { sell: true, reason: `target+2 reached (${ticksHeld}/${target}), profit=$${profit.toFixed(3)}` };
        }

        // 2. Well past target with any profit
        if (ticksHeld >= target + 5 && profit > 0) {
            return { sell: true, reason: `extended hold (${ticksHeld} ticks) with profit` };
        }

        // 3. Way past target — exit regardless to free the lane
        if (ticksHeld >= target + 10) {
            return { sell: true, reason: `max hold exceeded (${ticksHeld} ticks)` };
        }

        // 4. Unexpected large profit (2x TP)
        if (profit >= tp * 2) {
            return { sell: true, reason: `outsized profit $${profit.toFixed(3)} (2x TP)` };
        }

        return { sell: false };
    }

    _sellContract(contractId, price) {
        console.log(`  📤 Sell request: contract=${contractId}, bid=$${price.toFixed(2)}`);
        this.send({
            sell: contractId,
            price: price.toFixed(2),
        });
    }

    _closeContract(contract, lane) {
        const contractId = contract.contract_id;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit || 0);
        const tickCount = contract.tick_count || 0;
        const exitSpot = contract.exit_tick_display_value || contract.exit_tick || '';

        // Cleanup subscription
        if (lane.currentSubscriptionId) {
            this.send({ forget: lane.currentSubscriptionId });
        }
        this.activeContracts.delete(contractId);

        const emoji = won ? '✅' : '❌';
        const pnlSign = profit >= 0 ? '+' : '';

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`  ${emoji} ${won ? 'WIN' : 'LOSS'} — ${lane.asset}`);
        console.log(`     Ticks held: ${tickCount}  |  P&L: ${pnlSign}$${profit.toFixed(3)}`);
        if (exitSpot) console.log(`     Exit spot: ${exitSpot}`);
        console.log(`${'═'.repeat(60)}\n`);

        const result = lane.recordResult(won, profit);
        result.tickCount = tickCount;
        result.profit = profit;

        return result;
    }

    getActiveLaneCount() {
        return this.activeContracts.size;
    }

    cleanupAll(sendForget = true) {
        for (const [, lane] of this.activeContracts) {
            if (sendForget && lane.currentSubscriptionId) {
                this.send({ forget: lane.currentSubscriptionId });
            }
            lane.reset();
        }
        for (const [, lane] of this.pendingBuys) {
            lane.reset();
        }
        this.activeContracts.clear();
        this.pendingBuys.clear();
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  TELEGRAM NOTIFIER
// ════════════════════════════════════════════════════════════════════════════

class TelegramNotifier {
    constructor() {
        const token = '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ';
        const chatId = '752497117';

        this.enabled = !!(token && chatId);
        this.chatId = chatId;

        if (this.enabled) {
            this.bot = new TelegramBot(token, { polling: false });
        }
    }

    async send(text) {
        if (!this.enabled) return;
        try {
            await this.bot.sendMessage(this.chatId, text, { parse_mode: 'HTML' });
        } catch (err) {
            console.error(`  Telegram error: ${err.message}`);
        }
    }

    tradeOpened(lane) {
        if (!lane.tradeDetails) return;
        const t = lane.tradeDetails;
        this.send(
            `🚀 <b>TRADE OPENED 6</b> (v4)\n\n` +
            `Asset: ${t.asset}\n` +
            `Growth: ${(t.growthRate * 100).toFixed(0)}% (${t.tier})\n` +
            `Target: ${t.targetTicks} ticks\n` +
            `Stake: $${t.stake.toFixed(2)}\n` +
            `TP: $${t.takeProfitAmount.toFixed(3)}\n` +
            `Confidence: ${(t.confidence * 100).toFixed(1)}%`
        );
    }

    tradeClosed(result, riskManager) {
        const { won, profit, asset, tickCount } = result;
        const rm = riskManager;
        const emoji = won ? '✅' : '❌';
        const pnl = profit >= 0 ? `+$${profit.toFixed(3)}` : `-$${Math.abs(profit).toFixed(3)}`;
        const winRate = rm.totalTrades > 0 ? (rm.totalWins / rm.totalTrades * 100).toFixed(1) : '0.0';

        this.send(
            `${emoji} <b> Bot 6 ${won ? 'WIN' : 'LOSS'}</b> (v4)\n\n` +
            `Asset: ${asset}\n` +
            `P&L: ${pnl}  |  Ticks: ${tickCount}\n\n` +
            `📊 Session:\n` +
            `Trades: ${rm.totalTrades}  |  W/L: ${rm.totalWins}/${rm.totalTrades - rm.totalWins}\n` +
            `Win Rate: ${winRate}%\n` +
            `Total P&L: ${rm.sessionProfitLoss >= 0 ? '+' : ''}$${rm.sessionProfitLoss.toFixed(2)}\n` +
            `Bankroll: $${rm.bankroll.toFixed(2)}`
        );
    }

    hourlyReport(riskManager) {
        const rm = riskManager;
        const wr = rm.totalTrades > 0 ? (rm.totalWins / rm.totalTrades * 100).toFixed(1) : '0.0';
        this.send(
            `📊 <b>Hourly Report 6</b> (v4)\n\n` +
            `Trades: ${rm.totalTrades}  |  Win Rate: ${wr}%\n` +
            `Session P&L: ${rm.sessionProfitLoss >= 0 ? '+' : ''}$${rm.sessionProfitLoss.toFixed(2)}\n` +
            `Bankroll: $${rm.bankroll.toFixed(2)}`
        );
    }

    shutdown(reason, riskManager) {
        const rm = riskManager;
        const wr = rm.totalTrades > 0 ? (rm.totalWins / rm.totalTrades * 100).toFixed(1) : '0.0';
        this.send(
            `🛑 <b>BOT SHUTDOWN< 6/b> (v4)\n\n` +
            `Reason: ${reason}\n\n` +
            `Final Stats:\n` +
            `Trades: ${rm.totalTrades}  |  Win Rate: ${wr}%\n` +
            `P&L: ${rm.sessionProfitLoss >= 0 ? '+' : ''}$${rm.sessionProfitLoss.toFixed(2)}\n` +
            `Bankroll: $${rm.bankroll.toFixed(2)}`
        );
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  TRADE LOGGER — Append-only JSONL
// ════════════════════════════════════════════════════════════════════════════

class TradeLogger {
    constructor() {
        this.logFile = path.join(__dirname, 'trades-v4.jsonl');
    }

    log(entry) {
        try {
            const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
            fs.appendFileSync(this.logFile, line, 'utf8');
        } catch (err) {
            console.error(`  Trade log error: ${err.message}`);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN BOT ORCHESTRATOR
// ════════════════════════════════════════════════════════════════════════════

class AccumulatorBotV4 {
    constructor(token) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.authenticated = false;
        this._shuttingDown = false;

        // Core components
        this.volatilityEngine = new VolatilityEngine();
        this.riskManager = new RiskManager();
        this.executor = null;
        this.notifier = new TelegramNotifier();
        this.tradeLogger = new TradeLogger();

        // Trading lanes
        this.lanes = {};
        CONFIG.assets.forEach(asset => {
            this.lanes[asset] = new TradingLane(asset);
        });

        // Analysis throttle
        this.lastAnalysisTime = {};

        // Timers
        this._autoSaveTimer = null;
        this._hourlyTimer = null;

        // Reconnection
        this.reconnectAttempts = 0;

        this.endOfDay = false;
        this.isWinTrade = false;

        // Restore saved state
        this._restoreState();
    }

    // ────────────────────────────────────
    //  LIFECYCLE
    // ────────────────────────────────────

    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🚀 ACCUMULATOR BOT v4.0 — VAQM Strategy');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`  Assets:          ${CONFIG.assets.join(', ')}`);
        console.log(`  Growth Rates:    Dynamic 1–3%`);
        console.log(`  Target Ticks:    3–5 (quick scalp)`);
        console.log(`  Staking:         Kelly Criterion (¼ Kelly)`);
        console.log(`  Max Concurrent:  ${CONFIG.risk.maxConcurrentTrades} lanes`);
        console.log(`  Bankroll:        $${this.riskManager.bankroll.toFixed(2)}`);
        console.log(`  Session TP:      $${CONFIG.session.takeProfitTotal}`);
        console.log(`  Daily Stop:      -$${CONFIG.risk.maxDailyLoss}`);
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');

        StatePersistence.startAutoSave(this);
        this._connect();

        this._hourlyTimer = setInterval(() => {
            this._logHourlySummary();
        }, 60 * 60 * 1000);

        this.checkTimeForDisconnectReconnect();
    }

    shutdown(reason = 'manual') {
        if (this._shuttingDown) return;
        this._shuttingDown = true;

        console.log(`\n🛑 SHUTDOWN — Reason: ${reason}`);
        StatePersistence.saveState(this);

        if (this.executor) this.executor.cleanupAll(this.connected);
        if (this._hourlyTimer) clearInterval(this._hourlyTimer);
        if (this._autoSaveTimer) clearInterval(this._autoSaveTimer);

        this.notifier.shutdown(reason, this.riskManager);
        this._logFinalSummary();
        this._cleanup();
    }

    // ────────────────────────────────────
    //  WEBSOCKET CONNECTION
    // ────────────────────────────────────

    _connect() {
        if (this.ws) this._cleanup();

        console.log('🔌 Connecting to Deriv API...');

        this.ws = new WebSocket(CONFIG.apiEndpoint);

        this.ws.on('open', () => {
            console.log('✅ WebSocket connected');
            this.connected = true;
            this.reconnectAttempts = 0;

            this.executor = new TradeExecutor((req) => this._send(req));
            this._send({ authorize: this.token });
        });

        this.ws.on('message', (raw) => {
            try {
                this._handleMessage(JSON.parse(raw));
            } catch (err) {
                console.error('  Message parse error:', err.message);
            }
        });

        this.ws.on('error', (err) => {
            console.error('  WS error:', err.message);
        });

        this.ws.on('close', () => {
            console.log('  WS disconnected');
            this._handleDisconnect();
        });
    }

    _send(req) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(req));
                return true;
            } catch (err) {
                console.error('  Send error:', err.message);
            }
        }
        return false;
    }

    _cleanup() {
        if (this.ws) {
            this.ws.removeAllListeners();
            try { this.ws.close(); } catch (_) { }
            this.ws = null;
        }
        this.connected = false;
        this.authenticated = false;
    }

    _handleDisconnect() {
        this.connected = false;
        this.authenticated = false;

        if (this._shuttingDown || this.endOfDay) return;

        StatePersistence.saveState(this);

        if (this.reconnectAttempts >= CONFIG.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            this.shutdown('max_reconnect');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(
            CONFIG.baseReconnectDelayMs * Math.pow(1.5, this.reconnectAttempts - 1),
            30000
        );

        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (${this.reconnectAttempts}/${CONFIG.maxReconnectAttempts})`);
        setTimeout(() => this._connect(), delay);
    }

    // ────────────────────────────────────
    //  MESSAGE ROUTER
    // ────────────────────────────────────

    _handleMessage(msg) {
        switch (msg.msg_type) {

            // ---- Auth ----
            case 'authorize':
                if (msg.error) {
                    console.error('❌ Auth failed:', msg.error.message);
                    return this.shutdown('auth_failed');
                }
                console.log(`✅ Authenticated as ${msg.authorize.fullname || msg.authorize.loginid}`);
                this.authenticated = true;
                this._subscribeAllTicks();
                break;

            // ---- Tick history ----
            case 'history': {
                const asset = msg.echo_req.ticks_history;
                const prices = (msg.history?.prices || []).map(Number);
                prices.forEach(p => this.volatilityEngine.addTick(asset, p));
                console.log(`📊 [${asset}] Loaded ${prices.length} historical ticks`);
                break;
            }

            // ---- Live tick ----
            case 'tick':
                if (msg.tick) this._handleTick(msg.tick);
                break;

            // ---- Proposal response → executor ----
            case 'proposal':
                if (this.executor) this.executor.handleProposal(msg);
                break;

            // ---- Buy response → executor ----
            case 'buy':
                if (this.executor) {
                    const res = this.executor.handleBuyResponse(msg);
                    if (res) this.notifier.tradeOpened(res.lane);
                }
                break;

            // ---- Contract update → executor ----
            case 'proposal_open_contract':
                if (this.executor) {
                    const closeResult = this.executor.handleContractUpdate(msg.proposal_open_contract);
                    if (closeResult) this._handleTradeResult(closeResult);
                }
                break;

            // ---- Sell response ----
            case 'sell':
                if (msg.error) {
                    console.error(`  ❌ Sell error: ${msg.error.message}`);
                }
                // Contract update will handle the actual close
                break;

            // ---- Errors ----
            default:
                if (msg.error) {
                    console.error(`  API error [${msg.msg_type}]: ${msg.error.message}`);
                }
        }
    }

    // ────────────────────────────────────
    //  TICK SUBSCRIPTION & HANDLING
    // ────────────────────────────────────

    _subscribeAllTicks() {
        console.log('📡 Subscribing to tick streams...\n');

        CONFIG.assets.forEach(asset => {
            // History
            this._send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: CONFIG.requiredHistoryTicks,
                end: 'latest',
                start: 1,
                style: 'ticks',
            });

            // Live stream
            this._send({ ticks: asset, subscribe: 1 });
        });
    }

    _handleTick(tick) {
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);

        // Feed raw price to volatility engine
        this.volatilityEngine.addTick(asset, price);

        // Throttle: max 1 analysis per asset per interval
        const now = Date.now();
        if (now - (this.lastAnalysisTime[asset] || 0) < CONFIG.analysisIntervalMs) return;
        this.lastAnalysisTime[asset] = now;

        // Evaluate
        this._evaluateAndTrade(asset);
    }

    // ────────────────────────────────────
    //  CORE TRADE DECISION
    // ────────────────────────────────────

    _evaluateAndTrade(asset) {
        const lane = this.lanes[asset];

        // Lane must be idle and past cooldown
        if (!lane.canAnalyze()) return;

        // Global risk gate
        const riskCheck = this.riskManager.canTrade(
            this.executor ? this.executor.getActiveLaneCount() : 0
        );
        if (!riskCheck.allowed) {
            // Log occasionally
            if (Math.random() < 0.005) {
                console.log(`  ⛔ Trading blocked: ${riskCheck.reason}`);
            }
            return;
        }

        // Get volatility-based signal
        const signal = this.volatilityEngine.getSignal(asset);

        // console.log(`Signal:  ⏳ [${asset}] ${signal.signal || 'NO_TRADE'}`);
        // console.log(`Confidence:  ⏳ [${asset}] ${signal.confidence || 'undefined'}`);
        // console.log(`Tier:  ⏳ [${asset}] ${signal.tier || 'undefined'}`);
        // console.log(`Reason:  ⏳ [${asset}] ${signal.reason || 'undefined'}`);
        // console.log(`Details:  ⏳ [${asset}] ${JSON.stringify(signal.details)}`);

        if (signal.signal !== 'GO' || signal.confidence < 0.6) {
            // Sparse logging for NO_TRADE
            if (Math.random() < 0.01) {
                console.log(`  ⏳ [${asset}] ${signal.reason}`);
            }
            return;
        }

        // ---- Signal is GO — prepare and execute ----
        lane.beginAnalysis();

        const growthConfig = CONFIG.growthRates[signal.tier];
        const stake = this.riskManager.calculateStake();
        const trade = lane.prepareTradeFromSignal(signal, growthConfig, stake);

        console.log(`\n🚀 ═══ TRADE SIGNAL ═══════════════════════════════════════`);
        console.log(`  Asset:      ${asset}`);
        console.log(`  Tier:       ${signal.tier} → Growth ${(growthConfig.rate * 100).toFixed(0)}%`);
        console.log(`  Target:     ${growthConfig.targetTicks} ticks`);
        console.log(`  Stake:      $${stake.toFixed(2)}`);
        console.log(`  TP Amount:  $${trade.takeProfitAmount.toFixed(3)}`);
        console.log(`  Confidence: ${(signal.confidence * 100).toFixed(1)}%`);

        if (signal.details) {
            console.log(`  Bandwidth:  ${signal.details.bandwidthRatio.toFixed(4)}`);
            console.log(`  BB Squeeze: ${signal.details.bollingerSqueezing}`);
            console.log(`  MACD Hist:  ${signal.details.macdHistogram.toFixed(6)}`);
        }
        console.log(`══════════════════════════════════════════════════════════\n`);

        this.executor.requestProposal(lane);
    }

    // ────────────────────────────────────
    //  TRADE RESULT HANDLING
    // ────────────────────────────────────

    _handleTradeResult(result) {
        const { won, profit, asset, tickCount, consecutiveLosses } = result;

        // Update global risk
        this.riskManager.recordResult(won, profit);
        if (won) this.isWinTrade = true;

        // Log to file
        this.tradeLogger.log({
            asset,
            won,
            profit,
            tickCount,
            bankroll: this.riskManager.bankroll,
            sessionPnL: this.riskManager.sessionProfitLoss,
            totalTrades: this.riskManager.totalTrades,
            winRate: this.riskManager.totalTrades > 0
                ? (this.riskManager.totalWins / this.riskManager.totalTrades).toFixed(3)
                : '0',
        });

        // Telegram
        this.notifier.tradeClosed(result, this.riskManager);

        // Session summary log
        const rm = this.riskManager;
        const wr = rm.totalTrades > 0 ? (rm.totalWins / rm.totalTrades * 100).toFixed(1) : '0.0';
        console.log(`  📈 Session: ${rm.totalTrades} trades | WR: ${wr}% | P&L: $${rm.sessionProfitLoss.toFixed(2)} | Bankroll: $${rm.bankroll.toFixed(2)}\n`);

        // Save state
        StatePersistence.saveState(this);

        // Check stop conditions
        const riskCheck = this.riskManager.canTrade(0);
        if (!riskCheck.allowed) {
            this.shutdown(riskCheck.reason);
        }
    }

    // ────────────────────────────────────
    //  REPORTING
    // ────────────────────────────────────

    _logHourlySummary() {
        const rm = this.riskManager;
        const wr = rm.totalTrades > 0 ? (rm.totalWins / rm.totalTrades * 100).toFixed(1) : '0.0';

        console.log('\n📊 ═══ HOURLY SUMMARY ═══════════════════════════════════');
        console.log(`  Trades:   ${rm.totalTrades}`);
        console.log(`  Win Rate: ${wr}%`);
        console.log(`  P&L:      ${rm.sessionProfitLoss >= 0 ? '+' : ''}$${rm.sessionProfitLoss.toFixed(2)}`);
        console.log(`  Bankroll: $${rm.bankroll.toFixed(2)}`);

        // Per-lane breakdown
        for (const [asset, lane] of Object.entries(this.lanes)) {
            if (lane.stats.trades > 0) {
                const lwr = (lane.stats.wins / lane.stats.trades * 100).toFixed(0);
                console.log(`    [${asset}] ${lane.stats.trades} trades, WR ${lwr}%, P&L $${lane.stats.profitLoss.toFixed(2)}`);
            }
        }
        console.log('══════════════════════════════════════════════════════════\n');

        this.notifier.hourlyReport(rm);
    }

    _logFinalSummary() {
        const rm = this.riskManager;
        const wr = rm.totalTrades > 0 ? (rm.totalWins / rm.totalTrades * 100).toFixed(1) : '0.0';

        console.log('\n🏁 ═══ FINAL SESSION SUMMARY ════════════════════════════');
        console.log(`  Total Trades:       ${rm.totalTrades}`);
        console.log(`  Wins / Losses:      ${rm.totalWins} / ${rm.totalTrades - rm.totalWins}`);
        console.log(`  Win Rate:           ${wr}%`);
        console.log(`  Session P&L:        ${rm.sessionProfitLoss >= 0 ? '+' : ''}$${rm.sessionProfitLoss.toFixed(2)}`);
        console.log(`  Final Bankroll:     $${rm.bankroll.toFixed(2)}`);
        console.log(`  Consec. Losses:     ${rm.globalConsecutiveLosses}`);

        console.log('\n  Per-Asset Breakdown:');
        for (const [asset, lane] of Object.entries(this.lanes)) {
            if (lane.stats.trades > 0) {
                const lwr = (lane.stats.wins / lane.stats.trades * 100).toFixed(1);
                console.log(`    ${asset}: ${lane.stats.trades} trades, WR ${lwr}%, P&L $${lane.stats.profitLoss.toFixed(2)}, CL ${lane.stats.consecutiveLosses}`);
            }
        }
        console.log('══════════════════════════════════════════════════════════\n');
    }

    // ────────────────────────────────────
    //  STATE RESTORE
    // ────────────────────────────────────

    _restoreState() {
        const saved = StatePersistence.loadState();
        if (!saved) return;

        if (saved.riskManager) {
            this.riskManager.restore(saved.riskManager);
            console.log(`  ✅ RiskManager restored: ${this.riskManager.totalTrades} trades, P&L $${this.riskManager.sessionProfitLoss.toFixed(2)}, Bankroll $${this.riskManager.bankroll.toFixed(2)}`);
        }

        if (saved.laneStats) {
            for (const [asset, stats] of Object.entries(saved.laneStats)) {
                if (this.lanes[asset]) {
                    this.lanes[asset].restoreStats(stats);
                }
            }
            console.log('  ✅ Lane stats restored');
        }

        if (saved.riskManager) {
            this.isWinTrade = saved.riskManager.isWinTrade || false;
            this.endOfDay = saved.riskManager.endOfDay || false;
        }
    }

    // ────────────────────────────────────
    //  TIME-BASED CONTROLS (v4 Port)
    // ────────────────────────────────────

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay();
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Reconnect at 2 AM
            if (this.endOfDay && currentHours === 2 && currentMinutes >= 0 && currentMinutes < 2) {
                console.log("\n🌅 It's 2:00 AM GMT+1, resetting for new day and reconnecting...");
                this.resetForNewDay();
                this.endOfDay = false;
                this._connect();
            }

            // Disconnect at 11:30 PM after a win
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 23 && currentMinutes >= 30) {
                    console.log("\n🌙 It's past 11:30 PM GMT+1 after a win trade, securing profits and disconnecting.");
                    this.notifier.send(`🌙 <b>END OF DAY SUSPENSION</b>\n\nProfit secured. Reconnecting at 2:00 AM.`);
                    this._logHourlySummary(); // Send final report
                    this.endOfDay = true;
                    this._cleanup();
                }
            }

            // Also support mid-day pauses if nliveMultib logic is strictly followed
            // New York Session Pause (1 PM - 3 PM)
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 13 && currentMinutes >= 0 && currentHours < 15) {
                    console.log("\n⏸️ New York session pause (1 PM GMT+1). Disconnecting...");
                    this.notifier.send(`⏸️ <b>SESSION PAUSE</b>\n\nNew York overlap pause. Resuming at 3 PM.`);
                    this.endOfDay = true;
                    this._cleanup();
                }
            }

            if (this.endOfDay && currentHours === 15 && currentMinutes >= 0 && currentMinutes < 2) {
                 console.log("\n▶️ Resuming after New York pause...");
                 this.endOfDay = false;
                 this._connect();
            }

        }, 20000);
    }

    resetForNewDay() {
        console.log('🌅 Resetting daily metrics...');
        this.isWinTrade = false;
        if (this.riskManager) {
            this.riskManager.dailyProfitLoss = 0;
            this.riskManager.globalConsecutiveLosses = 0;
            // Optionally reset bankroll reference if needed, but usually we just keep cumulative
        }
        this.reconnectAttempts = 0;
        console.log('✅ Daily reset complete');
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ════════════════════════════════════════════════════════════════════════════

(function main() {
    const token = 'Dz2V2KvRf4Uukt3';

    if (!token) {
        console.error('═══════════════════════════════════════════════════════════');
        console.error('  ❌ ERROR: DERIV_API_TOKEN not found in .env file');
        console.error('');
        console.error('  Create a .env file in the same directory:');
        console.error('');
        console.error('    DERIV_API_TOKEN=your_deriv_api_token');
        console.error('    TELEGRAM_TOKEN=your_telegram_bot_token');
        console.error('    TELEGRAM_CHAT_ID=your_chat_id');
        console.error('═══════════════════════════════════════════════════════════');
        process.exit(1);
    }

    const bot = new AccumulatorBotV4(token);
    bot.start();
})();

module.exports = { AccumulatorBotV4 };
