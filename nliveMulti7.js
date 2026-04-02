/**
 * DERIV ACCUMULATOR BOT v4.0
 * 
 * Strategy: Adaptive Low-Volatility Accumulator Scalper (ALVAS)
 * 
 * Core improvements:
 * - Real price tracking (not digit patterns)
 * - Volatility Z-Score based entry (not gambler's fallacy)
 * - Anti-martingale staking (not exponential risk)
 * - Active contract monitoring with emergency exits
 * - Multi-asset ranking by volatility
 * - Mathematically optimized take profits
 */

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ============================================================================
// STATE PERSISTENCE
// ============================================================================

const STATE_FILE = path.join(__dirname, 'accumulator-bot-v4-state.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                config: bot.config,
                trading: {
                    currentStake: bot.currentStake,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                    consecutiveWins: bot.riskManager.consecutiveWins,
                    consecutiveLosses: bot.riskManager.consecutiveLosses,
                },
                volatility: {
                    volatilityHistory: bot.volEngine.volatilityHistory,
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
        if (bot.autoSaveInterval) {
            clearInterval(bot.autoSaveInterval);
        }

        bot.autoSaveInterval = setInterval(() => {
            if (bot.connected && !bot.endOfDay) {
                StatePersistence.saveState(bot);
            }
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
// PRICE VOLATILITY ENGINE
// ============================================================================

class PriceVolatilityEngine {
    constructor(config) {
        this.priceHistories = {};      // { asset: [price1, price2, ...] }
        this.returnHistories = {};     // { asset: [return%, return%, ...] }
        this.volatilityHistory = {};   // { asset: [vol, vol, ...] }
        this.maxHistory = 500;
        this.volWindow = config.volWindow || 30;           // ticks for rolling volatility
        this.volHistoryWindow = config.volHistoryWindow || 100; // readings for z-score
        this.assets = config.assets || [];

        // Initialize structures
        this.assets.forEach(asset => {
            this.priceHistories[asset] = [];
            this.returnHistories[asset] = [];
            this.volatilityHistory[asset] = [];
        });
    }

    /**
     * Add new price tick and compute volatility metrics
     */
    addTick(asset, price) {
        if (!this.priceHistories[asset]) {
            this.priceHistories[asset] = [];
            this.returnHistories[asset] = [];
            this.volatilityHistory[asset] = [];
        }

        const prices = this.priceHistories[asset];
        prices.push(price);

        // Trim to max history
        if (prices.length > this.maxHistory) {
            prices.shift();
            this.returnHistories[asset].shift();
        }

        // Calculate return if we have previous price
        if (prices.length >= 2) {
            const prevPrice = prices[prices.length - 2];
            const returnPct = ((price - prevPrice) / prevPrice) * 100;
            this.returnHistories[asset].push(returnPct);
        }

        // Calculate rolling volatility
        if (this.returnHistories[asset].length >= this.volWindow) {
            const vol = this.calculateRollingVolatility(asset);
            this.volatilityHistory[asset].push(vol);

            // Trim volatility history
            if (this.volatilityHistory[asset].length > this.volHistoryWindow) {
                this.volatilityHistory[asset].shift();
            }
        }
    }

    /**
     * Calculate rolling standard deviation of returns
     */
    calculateRollingVolatility(asset) {
        const returns = this.returnHistories[asset];
        if (returns.length < this.volWindow) return 0;

        const recent = returns.slice(-this.volWindow);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / recent.length;
        return Math.sqrt(variance);
    }

    /**
     * Get volatility Z-Score (how many stdevs from mean)
     * Lower = less volatile = better entry
     */
    getVolatilityZScore(asset) {
        const volHist = this.volatilityHistory[asset];
        if (!volHist || volHist.length < 20) {
            return 0; // Unknown regime
        }

        const currentVol = volHist[volHist.length - 1];
        const meanVol = volHist.reduce((a, b) => a + b, 0) / volHist.length;
        const variance = volHist.reduce((sum, v) => sum + Math.pow(v - meanVol, 2), 0) / volHist.length;
        const stddevVol = Math.sqrt(variance);

        if (stddevVol === 0) return 0;

        return (currentVol - meanVol) / stddevVol;
    }

    /**
     * Check if volatility is declining (good for entry)
     */
    isVolatilityDeclining(asset, lookback = 20) {
        const volHist = this.volatilityHistory[asset];
        if (!volHist || volHist.length < lookback + 5) {
            return false;
        }

        const recent = volHist.slice(-lookback);
        const older = volHist.slice(-(lookback + 5), -lookback);

        const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const olderMean = older.reduce((a, b) => a + b, 0) / older.length;

        return recentMean < olderMean * 0.95; // At least 5% decline
    }

    /**
     * Check if there was a recent price spike
     */
    hasRecentSpike(asset, lookback = 5, threshold = 2.0) {
        const returns = this.returnHistories[asset];
        if (!returns || returns.length < lookback) {
            return false;
        }

        const recent = returns.slice(-lookback);
        const avgAbsReturn = recent.map(r => Math.abs(r)).reduce((a, b) => a + b) / recent.length;
        const maxAbsReturn = Math.max(...recent.map(r => Math.abs(r)));

        return maxAbsReturn > avgAbsReturn * threshold;
    }

    /**
     * Get average absolute return (for barrier proximity checks)
     */
    getAverageAbsReturn(asset) {
        const returns = this.returnHistories[asset];
        if (!returns || returns.length === 0) return 0.01;

        const recent = returns.slice(-50);
        return recent.map(r => Math.abs(r)).reduce((a, b) => a + b, 0) / recent.length;
    }

    /**
     * Rank assets by volatility Z-score (lowest = best)
     */
    rankAssetsByVolatility(assets) {
        return assets
            .map(asset => ({
                asset,
                zScore: this.getVolatilityZScore(asset),
                isValid: (this.volatilityHistory[asset] || []).length >= 20
            }))
            .filter(item => item.isValid)
            .sort((a, b) => a.zScore - b.zScore);
    }

    /**
     * Comprehensive entry signal for an asset
     */
    getEntrySignal(asset) {
        const zScore = this.getVolatilityZScore(asset);
        const isDeclining = this.isVolatilityDeclining(asset);
        const hasSpike = this.hasRecentSpike(asset);
        const volHist = this.volatilityHistory[asset] || [];
        const hasEnoughData = volHist.length >= 20;

        // Eligibility check
        const isEligible = hasEnoughData &&
            zScore < -0.5 &&
            isDeclining &&
            !hasSpike;

        // Confidence: 0-1 scale
        let confidence = 0;
        if (hasEnoughData) {
            confidence += 0.4; // Base for having data
            confidence += Math.min(0.3, Math.max(0, -zScore / 2)); // Lower z-score = higher confidence
            confidence += isDeclining ? 0.2 : 0; // Trend bonus
            confidence -= hasSpike ? 0.2 : 0; // Spike penalty
            confidence = Math.max(0, Math.min(1, confidence));
        }

        return {
            zScore,
            isDeclining,
            hasSpike,
            isEligible,
            confidence,
            hasEnoughData,
            volReading: volHist[volHist.length - 1] || 0
        };
    }

    /**
     * Check if should emergency exit during active trade
     */
    shouldEmergencyExit(asset, threshold = 1.0) {
        const zScore = this.getVolatilityZScore(asset);
        return zScore > threshold; // Volatility spiked significantly
    }

    /**
     * Get volatility metrics for logging
     */
    getMetrics(asset) {
        const volHist = this.volatilityHistory[asset] || [];
        if (volHist.length === 0) {
            return { current: 0, mean: 0, zScore: 0 };
        }

        const current = volHist[volHist.length - 1];
        const mean = volHist.reduce((a, b) => a + b, 0) / volHist.length;
        const zScore = this.getVolatilityZScore(asset);

        return { current: current.toFixed(4), mean: mean.toFixed(4), zScore: zScore.toFixed(2) };
    }
}

// ============================================================================
// TAKE PROFIT CALCULATOR
// ============================================================================

class TakeProfitCalculator {
    /**
     * Calculate exact take profit amount based on compound growth
     * profit = stake × ((1 + rate)^ticks - 1)
     */
    static calculate(stake, growthRate, targetTicks) {
        const multiplier = Math.pow(1 + growthRate, targetTicks) - 1;
        return stake * multiplier;
    }

    /**
     * Find optimal target ticks for a given growth rate
     * Maximizes expected value given estimated survival per tick
     */
    static getOptimalTargetTicks(growthRate, estimatedSurvivalPerTick) {
        let bestEV = -Infinity;
        let bestTicks = 10;

        for (let n = 5; n <= 50; n++) {
            const survivalN = Math.pow(estimatedSurvivalPerTick, n);
            const profit = Math.pow(1 + growthRate, n) - 1;
            const loss = -1;
            const ev = (survivalN * profit) + ((1 - survivalN) * loss);

            if (ev > bestEV) {
                bestEV = ev;
                bestTicks = n;
            }
        }

        return { targetTicks: bestTicks, expectedValue: bestEV };
    }
}

// ============================================================================
// ADAPTIVE RISK MANAGER
// ============================================================================

class AdaptiveRiskManager {
    constructor(config) {
        this.baseStake = config.initialStake || 1;
        this.maxStake = (config.initialStake || 1) * 3;
        this.minStake = (config.initialStake || 1) * 0.25;
        this.maxDailyLoss = config.maxDailyLoss || 200;
        this.maxConsecutiveLosses = config.maxConsecutiveLosses || 4;

        this.consecutiveWins = 0;
        this.consecutiveLosses = 0;
        this.dailyProfitLoss = 0;
        this.lastTradeTime = 0;
        this.minCooldownMs = config.minTimeBetweenTrades || 30000;
        this.pauseUntil = 0;

        // Config references
        this.stakeAfterLoss1 = config.stakeAfterLoss1 || 0.75;
        this.stakeAfterLoss2 = config.stakeAfterLoss2 || 0.50;
        this.pauseDuration = config.pauseAfter3Losses || 300000; // 5 minutes
    }

    /**
     * Calculate stake using anti-martingale (reduce after losses)
     */
    // calculateStake() {
    //     let multiplier = 1.0;

    //     // Anti-martingale: reduce after losses
    //     if (this.consecutiveLosses === 1) {
    //         multiplier = this.stakeAfterLoss1;
    //     } else if (this.consecutiveLosses === 2) {
    //         multiplier = this.stakeAfterLoss2;
    //     } else if (this.consecutiveLosses >= 3) {
    //         multiplier = this.stakeAfterLoss2;
    //     }

    //     // Bonus: slight increase after wins
    //     if (this.consecutiveWins >= 2) {
    //         multiplier *= 1.05;
    //     }

    //     // Daily loss protection
    //     if (this.dailyProfitLoss < -this.maxDailyLoss * 0.5) {
    //         multiplier = Math.min(multiplier, 0.5);
    //     }

    //     let stake = this.baseStake * multiplier;
    //     stake = Math.max(this.minStake, Math.min(this.maxStake, stake));

    //     return parseFloat(stake.toFixed(2));
    // }

    calculateStake() {
        let multiplier = 1.0;

        // Anti-martingale: reduce after losses
        if (this.consecutiveLosses === 1) {
            multiplier = this.stakeAfterLoss1;
        } else if (this.consecutiveLosses === 2) {
            multiplier = this.stakeAfterLoss2;
        } else if (this.consecutiveLosses >= 3) {
            multiplier = this.stakeAfterLoss2;
        }

        // Bonus: slight increase after wins
        if (this.consecutiveWins >= 2) {
            multiplier *= 1.05;
        }

        // Daily loss protection
        if (this.dailyProfitLoss < -this.maxDailyLoss * 0.5) {
            multiplier = Math.min(multiplier, 0.5);
        }

        let stake = this.baseStake * multiplier;

        // CRITICAL FIX: Deriv minimum stake is $1.00 for accumulators
        const DERIV_MIN_STAKE = 1.00;
        stake = Math.max(DERIV_MIN_STAKE, Math.min(this.maxStake, stake));

        return parseFloat(stake.toFixed(2));
    }

    /**
     * Check if trading is allowed
     */
    canTrade() {
        // Active pause check
        if (Date.now() < this.pauseUntil) {
            const remainingMs = this.pauseUntil - Date.now();
            return {
                allowed: false,
                reason: `pause_active_${Math.ceil(remainingMs / 1000)}s`
            };
        }

        // Cooldown between trades
        if (Date.now() - this.lastTradeTime < this.minCooldownMs) {
            const remainingMs = this.minCooldownMs - (Date.now() - this.lastTradeTime);
            return {
                allowed: false,
                reason: `cooldown_${Math.ceil(remainingMs / 1000)}s`
            };
        }

        // Daily loss limit
        if (this.dailyProfitLoss <= -this.maxDailyLoss) {
            return { allowed: false, reason: 'daily_loss_limit' };
        }

        // Consecutive losses
        if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
            return { allowed: false, reason: 'max_consecutive_losses' };
        }

        return { allowed: true };
    }

    /**
     * Record trade result and update state
     */
    recordResult(won, profit) {
        this.lastTradeTime = Date.now();
        this.dailyProfitLoss += profit;

        if (won) {
            this.consecutiveWins++;
            this.consecutiveLosses = 0;
        } else {
            this.consecutiveWins = 0;
            this.consecutiveLosses++;

            // Trigger pause after 3 consecutive losses
            if (this.consecutiveLosses >= 3) {
                this.pauseUntil = Date.now() + this.pauseDuration;
                console.log(`⏸️  Pause activated for ${this.pauseDuration / 1000}s after ${this.consecutiveLosses} losses`);
            }
        }
    }

    /**
     * Reset daily stats
     */
    resetDaily() {
        this.dailyProfitLoss = 0;
        this.pauseUntil = 0;
        console.log('📅 Daily stats reset');
    }
}

// ============================================================================
// MAIN BOT CLASS
// ============================================================================

class AccumulatorBotV4 {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // Assets
        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];

        // Configuration
        this.config = {
            initialStake: config.initialStake || 1,
            growthRate: config.growthRate || 0.02,        // 2% (lower is safer)
            targetTicks: config.targetTicks || 15,        // ~34% profit at 2%
            maxDailyLoss: config.maxDailyLoss || 200,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 4,
            takeProfit: config.takeProfit || 500,

            // Volatility-based entry
            maxVolatilityZScore: config.maxVolatilityZScore || -0.5,  // Enter below avg vol
            minVolDeclineTicks: config.minVolDeclineTicks || 20,       // Vol must decline
            spikeThreshold: config.spikeThreshold || 2.0,             // Reject if spike

            // Volatility engine
            volWindow: config.volWindow || 30,
            volHistoryWindow: config.volHistoryWindow || 100,

            // In-trade safety
            emergencyExitZScore: config.emergencyExitZScore || 1.0,   // Exit on vol spike
            maxHoldTicks: config.maxHoldTicks || 30,                  // Max hold = 2× target

            // Staking
            stakeAfterLoss1: config.stakeAfterLoss1 || 0.75,
            stakeAfterLoss2: config.stakeAfterLoss2 || 0.50,
            minTimeBetweenTrades: config.minTimeBetweenTrades || 30000,
            pauseAfter3Losses: config.pauseAfter3Losses || 300000,
        };

        // Trading state
        this.currentStake = this.config.initialStake;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.endOfDay = false;
        this.lastDayReset = new Date().toDateString();
        this.ticksHeld = 0;

        // Active trade tracking
        this.activeTrade = null;
        this.contractSubscriptionId = null;

        // Asset state
        this.assetStates = {};
        this.tickSubscriptionIds = {};
        this.tickCounters = {};
        this.assetMetrics = {};

        // Initialize asset tracking
        this.assets.forEach(asset => {
            this.assetStates[asset] = {
                currentProposalId: null,
                proposalTimestamp: null,
                lastTicks: 0,
                pendingEntry: false,
                pendingStake: null,
                pendingTakeProfit: null,
                pendingRequestTime: null,
                proposalSubscriptionId: null,
            };
            this.tickCounters[asset] = 0;
            this.assetMetrics[asset] = {
                trades: 0,
                wins: 0,
                losses: 0,
                profitLoss: 0,
            };
        });

        // Components
        this.volEngine = new PriceVolatilityEngine({
            assets: this.assets,
            volWindow: this.config.volWindow,
            volHistoryWindow: this.config.volHistoryWindow,
        });
        this.riskManager = new AdaptiveRiskManager(this.config);

        // Hourly stats
        this.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
        };

        // Telegram
        this.telegramToken = config.telegramToken;
        this.telegramChatId = config.telegramChatId;
        if (this.telegramToken && this.telegramChatId) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
        }

        // Load saved state
        this.loadSavedState();

        // Reconnection
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 5000;
    }

    // ========================================================================
    // STATE MANAGEMENT
    // ========================================================================

    loadSavedState() {
        const state = StatePersistence.loadState();
        if (!state) return;

        try {
            if (state.trading) {
                this.currentStake = state.trading.currentStake || this.config.initialStake;
                this.totalTrades = state.trading.totalTrades || 0;
                this.totalWins = state.trading.totalWins || 0;
                this.totalLosses = state.trading.totalLosses || 0;
                this.totalProfitLoss = state.trading.totalProfitLoss || 0;
                this.riskManager.dailyProfitLoss = state.trading.dailyProfitLoss || 0;
                this.riskManager.consecutiveWins = state.trading.consecutiveWins || 0;
                this.riskManager.consecutiveLosses = state.trading.consecutiveLosses || 0;
            }
            if (state.volatility) {
                this.volEngine.volatilityHistory = state.volatility.volatilityHistory || {};
            }
            if (state.assetMetrics) {
                this.assetMetrics = state.assetMetrics;
            }

            console.log(`✅ State restored: ${this.totalTrades} trades, P&L: $${this.totalProfitLoss.toFixed(2)}`);
        } catch (error) {
            console.error(`❌ Error restoring state: ${error.message}`);
        }
    }

    checkDailyReset() {
        const today = new Date().toDateString();
        if (today !== this.lastDayReset) {
            console.log('📅 New day — resetting daily stats');
            this.riskManager.resetDaily();
            this.lastDayReset = today;
        }
    }

    // ========================================================================
    // WEBSOCKET CONNECTION
    // ========================================================================

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

        console.log('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                this.handleMessage(message);
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error.message);
        });

        this.ws.on('close', () => {
            console.log('Disconnected from Deriv API');
            this.handleDisconnect();
        });
    }

    authenticate() {
        this.sendRequest({ authorize: this.token });
    }

    sendRequest(request) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('Cannot send request: WebSocket not ready');
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
            console.log('Planned shutdown');
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

        setTimeout(() => {
            this.connect();
        }, delay);
    }

    cleanup() {
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try {
                    this.ws.close();
                } catch (e) { }
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
        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                this.disconnect();
                return;
            }
            console.log('✅ Authenticated');
            this.wsReady = true;
            this.initializeSubscriptions();

        } else if (message.msg_type === 'history') {
            const asset = message.echo_req.ticks_history;
            this.handleTickHistory(asset, message.history);

        } else if (message.msg_type === 'tick') {
            if (message.subscription) {
                const asset = message.tick.symbol;
                this.tickSubscriptionIds[asset] = message.subscription.id;
            }
            this.handleTickUpdate(message.tick);

        } else if (message.msg_type === 'proposal') {
            this.handleProposal(message);

        } else if (message.msg_type === 'buy') {
            this.handleBuyResponse(message);

        } else if (message.msg_type === 'proposal_open_contract') {
            if (message.error) {
                console.error('Contract error:', message.error.message);
                return;
            }
            this.handleContractUpdate(message.proposal_open_contract);

        } else if (message.msg_type === 'sell') {
            this.handleSellResponse(message);

        } else if (message.error) {
            console.error('API Error:', message.error.message);
        }
    }

    initializeSubscriptions() {
        console.log('📡 Initializing subscriptions...');

        this.assets.forEach(asset => {
            // Load price history
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: 200,
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

    handleTickHistory(asset, history) {
        if (!history || !history.prices) {
            console.error(`❌ No price history for ${asset}`);
            return;
        }

        // Add prices to volatility engine
        history.prices.forEach(price => {
            this.volEngine.addTick(asset, price);
        });

        console.log(`📊 ${asset}: Loaded ${history.prices.length} price ticks`);
    }

    /**
    * NEW: Request a proposal purely to update ticks_stayed_in
    * Uses a small fixed amount, not the actual trade stake
    */
    requestTicksUpdate(asset) {
        this.sendRequest({
            proposal: 1,
            amount: '1.00',
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: this.config.growthRate,
            req_id: 1000, // Mark as tick-update request
        });
    }

    /**
    * NEW: Request a TRADE proposal with proper stake and take profit
    * This is only called when we actually want to buy
    */
    requestTradeProposal(asset, stake, takeProfit) {
        // Cancel any existing proposal subscription for this asset
        this.forgetAllProposalSubscriptions();

        console.log(`📋 Requesting TRADE proposal for ${asset} | Stake: $${stake.toFixed(2)} | TP: $${takeProfit.toFixed(2)}`);

        // Mark pending entry BEFORE sending request
        this.assetStates[asset].pendingEntry = true;
        this.assetStates[asset].pendingStake = stake;
        this.assetStates[asset].pendingTakeProfit = takeProfit;
        this.assetStates[asset].pendingRequestTime = Date.now();

        this.sendRequest({
            proposal: 1,
            amount: stake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: this.config.growthRate,
            limit_order: {
                take_profit: takeProfit.toFixed(2)
            },
            subscribe: 1,
            req_id: 2000,
        });
    }

    forgetAllProposalSubscriptions() {
        this.assets.forEach(asset => {
            if (this.assetStates[asset].proposalSubscriptionId) {
                this.sendRequest({ forget: this.assetStates[asset].proposalSubscriptionId });
                this.assetStates[asset].proposalSubscriptionId = null;
            }
        });
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const price = tick.quote;

        // Add price to volatility engine (replaces digit tracking)
        this.volEngine.addTick(asset, price);

        // Daily reset check
        this.checkDailyReset();

        // Don't process if trading
        if (this.tradeInProgress) return;

        // Process proposals only every 5 ticks to reduce API load
        this.tickCounters[asset]++;

        // CRITICAL FIX: Request proposals periodically for ALL assets
        // so that lastTicks stays updated via handleProposal()
        // Every 10 ticks per asset, request a lightweight proposal to get ticks_stayed_in
        if (this.tickCounters[asset] % 10 === 1) {
            this.requestTicksUpdate(asset);
        }

        if (this.tickCounters[asset] % 5 !== 0) return;

        // Try to find entry opportunity
        this.analyzeAndTrade();
    }

    // ========================================================================
    // TRADE ANALYSIS & EXECUTION
    // ========================================================================

    /**
    * FIXED: Main entry analysis
    * No longer tries to buy directly — instead requests a trade proposal
    * and handleProposal() executes the buy when it arrives
    */
    analyzeAndTrade() {
        // Prevent double-entry
        if (this.tradeInProgress) return;

        // Check if any asset already has a pending entry
        const hasPending = this.assets.some(a => this.assetStates[a].pendingEntry);
        if (hasPending) {
            // Check if pending entry timed out (> 10 seconds)
            this.assets.forEach(a => {
                if (this.assetStates[a].pendingEntry) {
                    const elapsed = Date.now() - (this.assetStates[a].pendingRequestTime || 0);
                    if (elapsed > 10000) {
                        console.log(`⏰ Pending entry for ${a} timed out after ${elapsed}ms`);
                        this.assetStates[a].pendingEntry = false;
                        this.forgetProposalSubscription(a);
                    }
                }
            });

            // Re-check after timeout cleanup
            const stillPending = this.assets.some(a => this.assetStates[a].pendingEntry);
            if (stillPending) return;
        }

        // Check risk manager
        const riskCheck = this.riskManager.canTrade();
        if (!riskCheck.allowed) {
            return;
        }

        // Rank assets by volatility z-score
        const rankings = this.volEngine.rankAssetsByVolatility(this.assets);
        if (rankings.length === 0) {
            return;
        }

        // Log rankings periodically
        const totalTicks = Object.values(this.tickCounters).reduce((a, b) => a + b, 0);
        if (totalTicks % 50 === 0) {
            this.logAssetRankings(rankings);
        }

        // Find best eligible asset
        let bestAsset = null;
        let bestSignal = null;

        for (const ranked of rankings) {
            const asset = ranked.asset;
            const signal = this.volEngine.getEntrySignal(asset);

            if (!signal.isEligible) continue;
            if (signal.confidence < 0.55) continue;

            // Check run length
            const currentRun = this.assetStates[asset].lastTicks;
            if (currentRun < 5) {
                continue;
            }

            bestAsset = asset;
            bestSignal = signal;
            break;
        }

        if (!bestAsset) {
            return;
        }

        console.log(`\n✅ ENTRY CONDITIONS MET for ${bestAsset}`);
        console.log(`   Z-Score: ${bestSignal.zScore.toFixed(2)} | Declining: ${bestSignal.isDeclining} | Confidence: ${(bestSignal.confidence * 100).toFixed(0)}%`);
        console.log(`   Run Length: ${this.assetStates[bestAsset].lastTicks} ticks`);

        // Calculate stake and take profit
        const stake = this.riskManager.calculateStake();
        const takeProfit = TakeProfitCalculator.calculate(
            stake,
            this.config.growthRate,
            this.config.targetTicks
        );

        // Request trade proposal — handleProposal() will execute buy on arrival
        this.requestTradeProposal(bestAsset, stake, takeProfit);
    }

    /**
     * Execute the buy order for a proposal
     */
    executeBuy(asset, proposalId, stake, takeProfit) {
        // Set trade in progress BEFORE sending request to prevent double-entry
        this.tradeInProgress = true;

        // Clean up pending state
        this.assetStates[asset].pendingEntry = false;

        // Forget the proposal subscription (we're buying, don't need updates)
        this.forgetProposalSubscription(asset);

        // Store active trade info
        this.activeTrade = {
            asset,
            contractId: null,
            stake,
            takeProfit,
            buyTime: Date.now(),
            proposalId,
        };

        // Send buy request
        this.sendRequest({
            buy: proposalId,
            price: stake.toFixed(2)
        });

        console.log(`📤 Buy request sent for ${asset} | Proposal: ${proposalId}`);
    }

    /**
    * FIXED: Handle proposal response
    * - Separates tick-update proposals from trade proposals
    * - Immediately buys when a trade proposal arrives and conditions still valid
    */
    handleProposal(message) {
        if (message.error || !message.proposal) {
            if (message.error) {
                const asset = message.echo_req?.symbol;
                console.log(`Proposal error for ${asset}: ${message.error.message}`);

                // If trade proposal failed, reset pending state
                if (message.echo_req?.req_id === 2000 && asset) {
                    this.assetStates[asset].pendingEntry = false;
                }
            }
            return;
        }

        const asset = message.echo_req.symbol;
        const proposal = message.proposal;

        if (!proposal.contract_details || !proposal.contract_details.ticks_stayed_in) {
            return;
        }

        // Track subscription ID for cleanup
        if (message.subscription && message.subscription.id) {
            this.assetStates[asset].proposalSubscriptionId = message.subscription.id;
        }

        // Always update ticks_stayed_in
        const stayedInArray = proposal.contract_details.ticks_stayed_in;
        const currentRun = stayedInArray.length > 0
            ? stayedInArray[stayedInArray.length - 1] + 1
            : 0;
        this.assetStates[asset].lastTicks = currentRun;

        // Store proposal data
        this.assetStates[asset].currentProposalId = proposal.id;
        this.assetStates[asset].proposalTimestamp = Date.now();

        const reqId = message.echo_req?.req_id;

        // ================================================================
        // CRITICAL: If this is a TRADE proposal and we want to buy — DO IT NOW
        // The proposal.id is only valid for THIS tick. Next tick = new ID.
        // ================================================================
        if (reqId === 2000 && this.assetStates[asset].pendingEntry && !this.tradeInProgress) {
            const timeSinceRequest = Date.now() - (this.assetStates[asset].pendingRequestTime || 0);

            // Timeout: if we've been waiting too long, cancel
            if (timeSinceRequest > 15000) {
                console.log(`⚠️ Trade proposal for ${asset} timed out (${timeSinceRequest}ms)`);
                this.assetStates[asset].pendingEntry = false;
                this.forgetProposalSubscription(asset);
                return;
            }

            // Re-validate conditions
            const signal = this.volEngine.getEntrySignal(asset);
            if (!signal.isEligible || signal.confidence < 0.55) {
                console.log(`⚠️ Conditions changed for ${asset}, cancelling entry`);
                this.assetStates[asset].pendingEntry = false;
                this.forgetProposalSubscription(asset);
                return;
            }

            // ============================================================
            // BUY IMMEDIATELY with the fresh proposal ID
            // ============================================================
            const stake = this.assetStates[asset].pendingStake;
            const takeProfit = this.assetStates[asset].pendingTakeProfit;
            const askPrice = parseFloat(proposal.ask_price);

            console.log(`\n🚀 EXECUTING BUY for ${asset}`);
            console.log(`   Proposal ID: ${proposal.id}`);
            console.log(`   Ask Price: $${askPrice.toFixed(2)}`);
            console.log(`   Stake: $${stake.toFixed(2)}`);
            console.log(`   Take Profit: $${takeProfit.toFixed(2)}`);
            console.log(`   Current Run: ${currentRun} ticks`);

            // Set trade in progress BEFORE sending buy to prevent double entry
            this.tradeInProgress = true;
            this.assetStates[asset].pendingEntry = false;

            // Store active trade
            this.activeTrade = {
                asset,
                contractId: null,
                stake,
                takeProfit,
                buyTime: Date.now(),
                proposalId: proposal.id,
                askPrice,
            };

            // CRITICAL: Buy using ask_price, not stake amount
            // The price parameter in the buy request must be >= ask_price
            this.sendRequest({
                buy: proposal.id,
                price: askPrice.toFixed(2)
            });

            console.log(`📤 Buy request sent | Proposal: ${proposal.id} | Price: $${askPrice.toFixed(2)}`);

            // Forget the proposal subscription since we're buying
            this.forgetProposalSubscription(asset);
        }
    }

    /**
    * NEW: Cleanup proposal subscriptions
    */
    forgetProposalSubscription(asset) {
        if (this.assetStates[asset].proposalSubscriptionId) {
            this.sendRequest({ forget: this.assetStates[asset].proposalSubscriptionId });
            this.assetStates[asset].proposalSubscriptionId = null;
        }
    }

    handleBuyResponse(message) {
        if (message.error) {
            console.error('❌ Error placing trade:', message.error.message);
            console.error('   Full error:', JSON.stringify(message.error));

            // Reset ALL trade state
            this.tradeInProgress = false;
            this.activeTrade = null;
            this.assets.forEach(asset => {
                this.assetStates[asset].pendingEntry = false;
            });
            this.forgetAllProposalSubscriptions();

            // Add cooldown after failed buy to prevent rapid retries
            this.riskManager.lastTradeTime = Date.now();

            return;
        }

        const contractId = message.buy.contract_id;
        const buyPrice = parseFloat(message.buy.buy_price);
        const balanceAfter = parseFloat(message.buy.balance_after);

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`✅ TRADE PLACED SUCCESSFULLY`);
        console.log(`   Contract: ${contractId}`);
        console.log(`   Buy Price: $${buyPrice.toFixed(2)}`);
        console.log(`   Balance After: $${balanceAfter.toFixed(2)}`);
        console.log(`${'═'.repeat(60)}\n`);

        if (this.activeTrade) {
            this.activeTrade.contractId = contractId;
            this.activeTrade.buyPrice = buyPrice;
        }

        // Subscribe to contract updates
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });

        // Telegram notification
        this.sendTelegramMessage(
            `🚀 <b>TRADE OPENED 7 (v4.0)</b>\n\n` +
            `Asset: ${this.activeTrade?.asset}\n` +
            `Contract: ${contractId}\n` +
            `Buy Price: $${buyPrice.toFixed(2)}\n` +
            `Stake: $${this.activeTrade?.stake?.toFixed(2)}\n` +
            `Take Profit: $${this.activeTrade?.takeProfit?.toFixed(2)}\n` +
            `Target Ticks: ${this.config.targetTicks}\n` +
            `Growth Rate: ${(this.config.growthRate * 100).toFixed(1)}%\n` +
            `Balance: $${balanceAfter.toFixed(2)}`
        );
    }

    /**
     * Monitor active contract and manage exits
     */
    handleContractUpdate(contract) {
        if (!contract || !this.activeTrade) {
            return;
        }

        // Store subscription ID
        if (contract.id && !this.contractSubscriptionId) {
            this.contractSubscriptionId = contract.id;
        }

        // const ticksHeld = contract.tick_count || 0;
        const currentProfit = parseFloat(contract.profit || 0);
        const bidPrice = parseFloat(contract.bid_price || 0);
        if (this.tradeInProgress) {
            this.ticksHeld++;
        }

        // Contract already closed
        if (contract.is_sold) {
            this.handleTradeResult(contract);
            return;
        }

        // Check emergency exit conditions (CRITICAL)
        if (!contract.is_valid_to_sell) {
            return; // Can't sell yet
        }

        // 1. VOLATILITY GUARD: Emergency exit if volatility spikes during trade
        if (this.volEngine.shouldEmergencyExit(this.activeTrade.asset, this.config.emergencyExitZScore)) {
            if (currentProfit > 0) {
                console.log(`⚠️ VOLATILITY SPIKE — Emergency exit! Profit: $${currentProfit.toFixed(2)}`);
                this.sellContract(contract.contract_id, bidPrice);
                return;
            }
        }

        // 2. BARRIER PROXIMITY: Exit if approaching barrier
        if (contract.high_barrier && contract.low_barrier && contract.current_spot) {
            const spot = parseFloat(contract.current_spot);
            const high = parseFloat(contract.high_barrier);
            const low = parseFloat(contract.low_barrier);
            const highDist = high - spot;
            const lowDist = spot - low;
            const minDist = Math.min(highDist, lowDist);

            const avgReturn = this.volEngine.getAverageAbsReturn(this.activeTrade.asset);
            const dangerZone = avgReturn * 1.5;

            if (minDist < dangerZone && minDist > 0 && currentProfit > 0) {
                console.log(`⚠️ BARRIER PROXIMITY — Protective exit! Min distance: ${minDist.toFixed(6)}`);
                this.sellContract(contract.contract_id, bidPrice);
                return;
            }
        }

        // 3. TARGET TICKS REACHED: Sell at target
        console.log(`🎯 TICKS HELD (${this.ticksHeld}/${this.config.targetTicks}) — Selling!`);
        if (this.ticksHeld >= this.config.targetTicks) {
            console.log(`🎯 TARGET TICKS REACHED (${this.ticksHeld}/${this.config.targetTicks}) — Selling!`);
            this.sellContract(contract.contract_id, bidPrice);
            return;
        }

        // 4. MAXIMUM HOLD: Force sell at 2× target
        if (this.ticksHeld >= this.config.maxHoldTicks) {
            console.log(`⏰ MAXIMUM HOLD (${this.ticksHeld} ticks) — Force selling!`);
            this.sellContract(contract.contract_id, bidPrice);
            return;
        }

        // Log progress occasionally
        if (this.ticksHeld > 0 && this.ticksHeld % 5 === 0) {
            const progPercent = (this.ticksHeld / this.config.targetTicks * 100).toFixed(0);
            console.log(`📊 Trade progress: ${this.ticksHeld}/${this.config.targetTicks} ticks (${progPercent}%) | Profit: $${currentProfit.toFixed(2)}`);
        }
    }

    /**
     * Execute sell order
     */
    sellContract(contractId, bidPrice) {
        this.sendRequest({
            sell: contractId,
            price: bidPrice.toFixed(2)
        });
    }

    handleSellResponse(message) {
        if (message.error) {
            console.error('❌ Error selling contract:', message.error.message);
            return;
        }

        console.log(`✅ Sell order executed at $${message.sell?.sold_for?.toFixed(2) || 'N/A'}`);
    }

    /**
     * Handle trade completion (win or loss)
     */
    handleTradeResult(contract) {
        if (!this.activeTrade) {
            console.warn('⚠️ Trade result received but no active trade');
            this.tradeInProgress = false;
            return;
        }

        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit || 0);
        // const ticksHeld = contract.tick_count || 0;

        // Unsubscribe from contract
        if (this.contractSubscriptionId) {
            this.sendRequest({ forget: this.contractSubscriptionId });
            this.contractSubscriptionId = null;
        }

        // Log result
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`${won ? '✅ WIN' : '❌ LOSS'} | ${this.activeTrade.asset} | Ticks: ${this.ticksHeld}`);
        console.log(`P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
        console.log(`${'═'.repeat(60)}\n`);

        // Update stats
        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;

        const asset = this.activeTrade.asset;
        if (this.assetMetrics[asset]) {
            this.assetMetrics[asset].trades++;
            this.assetMetrics[asset].profitLoss += profit;
        }

        if (won) {
            this.totalWins++;
            this.hourlyStats.wins++;
            if (this.assetMetrics[asset]) this.assetMetrics[asset].wins++;
        } else {
            this.totalLosses++;
            this.hourlyStats.losses++;
            if (this.assetMetrics[asset]) this.assetMetrics[asset].losses++;
        }

        this.riskManager.recordResult(won, profit);

        const winRate = this.totalTrades > 0
            ? (this.totalWins / this.totalTrades * 100).toFixed(1)
            : 0;

        const emoji = won ? '✅' : '❌';
        const pnlEmoji = profit >= 0 ? '🟢' : '🔴';

        this.sendTelegramMessage(
            `${emoji} <b>Bot 7 ${won ? 'WIN' : 'LOSS'}</b>\n\n` +
            `Asset: ${asset}\n` +
            `${pnlEmoji} P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}\n` +
            `Ticks: ${this.ticksHeld}\n` +
            `Streak: ${won ? `✓${this.riskManager.consecutiveWins}` : `✗${this.riskManager.consecutiveLosses}`}\n\n` +
            `📊 Session:\n` +
            `Trades: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalLosses}\n` +
            `Win Rate: ${winRate}%\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}\n` +
            `Daily P&L: ${this.riskManager.dailyProfitLoss >= 0 ? '+' : ''}$${this.riskManager.dailyProfitLoss.toFixed(2)}`
        );

        // Check stop conditions
        if (this.riskManager.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            this.shutdown('max_consecutive_losses');
            return;
        }
        if (this.riskManager.dailyProfitLoss <= -this.config.maxDailyLoss) {
            this.shutdown('daily_loss_limit');
            return;
        }
        if (this.totalProfitLoss >= this.config.takeProfit) {
            this.shutdown('take_profit_reached');
            return;
        }

        // CRITICAL: Full state reset
        this.tradeInProgress = false;
        this.activeTrade = null;
        this.assets.forEach(a => {
            this.assetStates[a].pendingEntry = false;
            this.assetStates[a].currentProposalId = null;
            this.assetStates[a].proposalTimestamp = null;
        });
        this.ticksHeld = 0;
        this.forgetAllProposalSubscriptions();

        StatePersistence.saveState(this);
    }

    // ========================================================================
    // LOGGING & REPORTING
    // ========================================================================

    logAssetRankings(rankings) {
        console.log('\n📊 ASSET VOLATILITY RANKINGS:');
        rankings.slice(0, 5).forEach((item, idx) => {
            const signal = this.volEngine.getEntrySignal(item.asset);
            const metrics = this.volEngine.getMetrics(item.asset);
            console.log(
                `  ${idx + 1}. ${item.asset} | ` +
                `Z: ${item.zScore.toFixed(2)} | ` +
                `Vol: ${metrics.current} | ` +
                `Conf: ${(signal.confidence * 100).toFixed(0)}% | ` +
                `${signal.isEligible ? '✅' : '❌'}`
            );
        });
    }

    // ========================================================================
    // TELEGRAM
    // ========================================================================

    async sendTelegramMessage(message) {
        if (!this.telegramBot) return;

        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, {
                parse_mode: 'HTML'
            });
        } catch (error) {
            console.error(`Telegram error: ${error.message}`);
        }
    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    start() {
        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║          🚀 ACCUMULATOR BOT v4.0 — ALVAS Strategy           ║');
        console.log('║              Adaptive Low-Volatility Accumulator Scalper     ║');
        console.log('╚════════════════════════════════════════════════════════════╝\n');

        console.log('📋 Configuration:');
        console.log(`   Growth Rate: ${(this.config.growthRate * 100).toFixed(1)}%`);
        console.log(`   Target Ticks: ${this.config.targetTicks}`);
        console.log(`   Max Hold Ticks: ${this.config.maxHoldTicks}`);
        console.log(`   Initial Stake: $${this.config.initialStake}`);
        console.log(`   Daily Loss Limit: $${this.config.maxDailyLoss}`);
        console.log(`   Max Consecutive Losses: ${this.config.maxConsecutiveLosses}`);
        console.log(`   Min Vol Z-Score: ${this.config.maxVolatilityZScore}`);
        console.log(`   Emergency Exit Z-Score: ${this.config.emergencyExitZScore}`);
        console.log(`   Min Time Between Trades: ${this.config.minTimeBetweenTrades / 1000}s`);
        console.log('');

        StatePersistence.startAutoSave(this);
        this.connect();
    }

    shutdown(reason = 'manual') {
        console.log(`\n🛑 Shutting down... Reason: ${reason}`);
        StatePersistence.saveState(this);
        this.endOfDay = true;

        const finalStats = {
            trades: this.totalTrades,
            wins: this.totalWins,
            losses: this.totalLosses,
            winRate: this.totalTrades > 0 ? (this.totalWins / this.totalTrades * 100).toFixed(1) : 0,
            totalPL: this.totalProfitLoss.toFixed(2),
            dailyPL: this.riskManager.dailyProfitLoss.toFixed(2),
        };

        this.sendTelegramMessage(
            `🛑 <b>BOT SHUTDOWN 7 (v4.0)</b>\n\n` +
            `Reason: ${reason}\n\n` +
            `📊 Final Stats:\n` +
            `Trades: ${finalStats.trades}\n` +
            `W/L: ${finalStats.wins}/${finalStats.losses}\n` +
            `Win Rate: ${finalStats.winRate}%\n` +
            `Total P&L: ${finalStats.totalPL > 0 ? '+' : ''}$${finalStats.totalPL}\n` +
            `Daily P&L: ${finalStats.dailyPL > 0 ? '+' : ''}$${finalStats.dailyPL}`
        );

        this.cleanup();
    }

    disconnect() {
        this.shutdown('disconnect_called');
    }
}

// ============================================================================
// INSTANTIATE & RUN
// ============================================================================

const token = 'rgNedekYXvCaPeP';

const bot = new AccumulatorBotV4(token, {
    // API
    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    telegramChatId: '752497117',

    // Staking
    initialStake: 1,
    growthRate: 0.02,           // 2% (safer than 5%)
    targetTicks: 15,            // ~34% profit per winning trade

    // Risk Management
    maxDailyLoss: 200,
    maxConsecutiveLosses: 4,
    takeProfit: 500,

    // Anti-Martingale (reduce after losses)
    stakeAfterLoss1: 0.75,      // 75% after 1 loss
    stakeAfterLoss2: 0.50,      // 50% after 2+ losses

    // Volatility-Based Entry (core of ALVAS)
    maxVolatilityZScore: -0.5,  // Only enter when vol is below average
    minVolDeclineTicks: 20,     // Volatility must be declining
    spikeThreshold: 2.0,        // Reject if recent price spike

    // Volatility Engine
    volWindow: 30,              // 30-tick rolling volatility window
    volHistoryWindow: 100,      // Keep 100 volatility readings for z-score

    // In-Trade Safety
    emergencyExitZScore: 1.0,   // Exit if vol spikes +1 std above mean
    maxHoldTicks: 30,           // Never hold >30 ticks (2× target)

    // Cooldown
    minTimeBetweenTrades: 30000,    // 30 seconds between trades
    pauseAfter3Losses: 300000,      // 5 minute pause after 3 consecutive losses

    // Assets
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
});

bot.start();

module.exports = { AccumulatorBotV4 };
