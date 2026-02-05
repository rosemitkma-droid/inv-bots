/**
 * ============================================================================
 * FIBONACCI Z-SCORE SATURATION DIGIT DIFFER BOT
 * ============================================================================
 * 
 * Implements EXACT specifications provided:
 * - Multi-layer Fibonacci Z-score saturation (windows: 13-987)
 * - Entropy + streak composite volatility filter
 * - Ultra-low volatility bonus trigger
 * - Specific martingale progression (1.8x, then 11.3^n)
 * 
 * ⚠️ CRITICAL WARNING:
 * - No trading bot achieves 3000-8000% monthly returns consistently
 * - Binary options are HIGH RISK - you can lose your entire capital
 * - Past performance does NOT guarantee future results
 * - Test extensively on DEMO before using real money
 * - Only trade money you can afford to lose completely
 * 
 * ============================================================================
 */

'use strict';

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ============================================================================
// FIBONACCI Z-SCORE SATURATION ENGINE
// ============================================================================

class FibonacciZScoreEngine {
    constructor() {
        // EXACT Fibonacci windows as specified
        this.FIBONACCI_WINDOWS = [13, 21, 34, 55, 89, 144, 233, 377, 610, 987];

        // EXACT thresholds as specified
        this.MIN_VALID_WINDOWS = 8;
        this.Z_SCORE_THRESHOLD = 11.15;
        this.RECENT_TICKS_CHECK = 9;

        // Pre-compute expected frequency for uniform distribution
        this.EXPECTED_FREQUENCY = 0.1; // Each digit should appear 10% of the time
        this.EXPECTED_STD_DEV_FACTOR = Math.sqrt(0.1 * 0.9); // sqrt(p * (1-p))
    }

    /**
     * Calculate Z-score for a specific digit over a specific window
     * Z = (observed - expected) / standard_deviation
     */
    calculateDigitZScore(history, windowSize, digit) {
        if (history.length < windowSize) {
            return null;
        }

        const window = history.slice(-windowSize);
        const count = window.filter(d => d === digit).length;

        // Expected count and standard deviation for binomial distribution
        const expected = windowSize * this.EXPECTED_FREQUENCY;
        const stdDev = Math.sqrt(windowSize) * this.EXPECTED_STD_DEV_FACTOR;

        if (stdDev === 0) return 0;

        // Z-score: positive means digit appears MORE than expected (saturated)
        const zScore = (count - expected) / stdDev;

        return zScore;
    }

    /**
     * Calculate aggregated Z-scores across all Fibonacci windows for each digit
     * Returns: { digit, totalZScore, validWindows, windowScores }
     */
    calculateMultiLayerZScores(history) {
        const results = [];

        for (let digit = 0; digit < 10; digit++) {
            let totalZScore = 0;
            let validWindows = 0;
            const windowScores = [];

            for (const windowSize of this.FIBONACCI_WINDOWS) {
                const zScore = this.calculateDigitZScore(history, windowSize, digit);

                if (zScore !== null) {
                    // Simple sum aggregation as specified
                    totalZScore += zScore;
                    validWindows++;
                    windowScores.push({
                        window: windowSize,
                        zScore: zScore.toFixed(3)
                    });
                }
            }

            results.push({
                digit,
                totalZScore,
                validWindows,
                windowScores,
                meetsWindowRequirement: validWindows >= this.MIN_VALID_WINDOWS
            });
        }

        return results;
    }

    /**
     * Check if digit appeared in last N ticks
     */
    digitInRecentTicks(history, digit, n = 9) {
        if (history.length < n) return false;
        const recent = history.slice(-n);
        return recent.includes(digit);
    }

    /**
     * Find the most saturated digit that meets ALL criteria:
     * 1. At least 8 valid windows
     * 2. Total Z-score >= 10.82
     * 3. Digit appeared in last 9 ticks
     */
    findSaturatedDigit(history) {
        const zScores = this.calculateMultiLayerZScores(history);

        // Filter by criteria and sort by total Z-score descending
        const candidates = zScores
            .filter(r => r.meetsWindowRequirement)
            .filter(r => r.totalZScore >= this.Z_SCORE_THRESHOLD)
            .filter(r => this.digitInRecentTicks(history, r.digit, this.RECENT_TICKS_CHECK))
            .sort((a, b) => b.totalZScore - a.totalZScore);

        if (candidates.length === 0) {
            return null;
        }

        const best = candidates[0];

        return {
            digit: best.digit,
            totalZScore: best.totalZScore,
            validWindows: best.validWindows,
            windowScores: best.windowScores,
            allCandidates: candidates.length
        };
    }

    /**
     * Get analysis summary for logging
     */
    getAnalysisSummary(history) {
        const zScores = this.calculateMultiLayerZScores(history);

        return zScores
            .filter(r => r.meetsWindowRequirement)
            .sort((a, b) => b.totalZScore - a.totalZScore)
            .slice(0, 3)
            .map(r => `D${r.digit}:${r.totalZScore.toFixed(2)}`);
    }
}

// ============================================================================
// ALTERNATIVE: RELATIVE VOLATILITY ENGINE
// Uses deviation from baseline rather than absolute thresholds
// ============================================================================

class RelativeVolatilityEngine {
    constructor() {
        this.WINDOWS = [
            { size: 50, weight: 1.0 },
            { size: 100, weight: 1.0 },
            { size: 200, weight: 1.0 },
            { size: 500, weight: 2.5 }
        ];

        this.CONCENTRATION_WEIGHT = 0.60;
        this.STREAK_WEIGHT = 0.40;

        // Baseline expectations for random data
        // For 10 equally likely outcomes:
        this.EXPECTED_ENTROPY_RATIO = 0.95; // Random data is ~95% of max entropy
        this.EXPECTED_MAX_STREAK_RATIO = 0.35; // Max streak is ~35% of log2(n)

        // Thresholds based on deviation from expected
        // Negative deviation = less random than expected = more predictable
        this.TRADEABLE_LEVELS = ['low', 'ultra-low'];
    }

    calculateDeviation(history, windowSize) {
        if (history.length < windowSize) return null;

        const window = history.slice(-windowSize);

        // Calculate actual entropy
        const frequency = Array(10).fill(0);
        window.forEach(d => frequency[d]++);

        let entropy = 0;
        for (let i = 0; i < 10; i++) {
            if (frequency[i] > 0) {
                const p = frequency[i] / windowSize;
                entropy -= p * Math.log2(p);
            }
        }
        const maxEntropy = Math.log2(10);
        const entropyRatio = entropy / maxEntropy;

        // Calculate actual max streak
        let maxStreak = 1, currentStreak = 1;
        for (let i = 1; i < window.length; i++) {
            if (window[i] === window[i - 1]) {
                currentStreak++;
                maxStreak = Math.max(maxStreak, currentStreak);
            } else {
                currentStreak = 1;
            }
        }
        const expectedMaxStreak = Math.log2(windowSize);
        const streakRatio = maxStreak / expectedMaxStreak;

        // Calculate deviations from expected
        // Positive = more random than expected
        // Negative = less random than expected (more predictable)
        const entropyDeviation = (entropyRatio - this.EXPECTED_ENTROPY_RATIO) / this.EXPECTED_ENTROPY_RATIO;
        const streakDeviation = (streakRatio - this.EXPECTED_MAX_STREAK_RATIO) / this.EXPECTED_MAX_STREAK_RATIO;

        return {
            entropyDeviation,
            streakDeviation,
            entropyRatio,
            streakRatio,
            maxStreak
        };
    }

    calculateVolatilityLevel(history) {
        let entropyDeviationSum = 0;
        let streakDeviationSum = 0;
        let totalWeight = 0;
        const windowResults = [];

        for (const { size, weight } of this.WINDOWS) {
            const deviation = this.calculateDeviation(history, size);

            if (deviation !== null) {
                entropyDeviationSum += deviation.entropyDeviation * weight;
                streakDeviationSum += deviation.streakDeviation * weight;
                totalWeight += weight;

                windowResults.push({
                    window: size,
                    entropyDev: (deviation.entropyDeviation * 100).toFixed(1) + '%',
                    streakDev: (deviation.streakDeviation * 100).toFixed(1) + '%',
                    maxStreak: deviation.maxStreak
                });
            }
        }

        if (totalWeight === 0) {
            return { level: 'unknown', canTrade: false };
        }

        // Weighted average deviations
        const avgEntropyDev = entropyDeviationSum / totalWeight;
        const avgStreakDev = streakDeviationSum / totalWeight;

        // Combined deviation score
        // Negative = more predictable than expected
        const combinedDeviation = avgEntropyDev * this.CONCENTRATION_WEIGHT +
            (-avgStreakDev) * this.STREAK_WEIGHT;

        // console.log('Combined Deviation:', combinedDeviation);

        // Determine level based on how much less random than expected
        let level;
        if (combinedDeviation > 0.05) {
            level = 'extreme';       // More random than expected
        } else if (combinedDeviation > 0.02) {
            level = 'high';          // Slightly more random
        } else if (combinedDeviation > -0.02) {
            level = 'medium';        // Around expected randomness
        } else if (combinedDeviation > -0.05) {
            level = 'low';           // Slightly less random (tradeable!)
        } else {
            level = 'ultra-low';     // Much less random (definitely tradeable!)
        }

        const canTrade = this.TRADEABLE_LEVELS.includes(level);

        return {
            level,
            score: combinedDeviation,
            canTrade,
            avgEntropyDeviation: avgEntropyDev,
            avgStreakDeviation: avgStreakDev,
            windowResults
        };
    }

    checkBonusTrigger(history) {
        if (history.length < 5) return { triggered: false };

        const last5 = history.slice(-5);
        if (last5.every(d => d === last5[0])) {
            let count = 0;
            for (let i = history.length - 1; i >= 0 && history[i] === last5[0]; i--) {
                count++;
            }
            return { triggered: true, digit: last5[0], streakLength: count };
        }
        return { triggered: false };
    }
}

// ============================================================================
// USAGE EXAMPLE WITH RECOMMENDATIONS
// ============================================================================

/*
// OPTION 1: Use realistic thresholds (recommended for synthetic indices)
const volatilityEngine = new VolatilityFilterEngine({
    thresholdMode: 'realistic',
    debug: false
});

// OPTION 2: Use adaptive thresholds (learns from data)
const volatilityEngine = new VolatilityFilterEngine({
    thresholdMode: 'adaptive',
    debug: false
});

// OPTION 3: Use relative deviation approach
const volatilityEngine = new RelativeVolatilityEngine();
*/

// module.exports = { VolatilityFilterEngine, RelativeVolatilityEngine };

// ============================================================================
// MONEY MANAGEMENT ENGINE
// ============================================================================

class MoneyManagementEngine {
    constructor(config) {
        // EXACT configuration as specified
        this.baseStake = config.baseStake || 0.61;
        this.firstLossMultiplier = 11.3;      // 1 loss → base × 1.8
        this.subsequentMultiplier = 11.3;    // 2+ losses → base × 11.3^(n-1)
        this.maxConsecutiveLosses = 3;

        // State
        this.consecutiveLosses = 0;
        this.currentStake = this.baseStake;

        // Stats tracking
        this.stats = {
            totalTrades: 0,
            totalWins: 0,
            totalLosses: 0,
            totalProfitLoss: 0,
            biggestWin: 0,
            biggestLoss: 0,
            maxConsecutiveLossesHit: 0,
            lossStreaks: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
        };
    }

    /**
     * Calculate next stake based on EXACT formula:
     * Win → base
     * 1 loss → base × 1.8
     * 2+ losses → base × 11.3^(losses-1)
     */
    calculateStake() {
        if (this.consecutiveLosses === 0) {
            this.currentStake = this.baseStake;
        } else if (this.consecutiveLosses === 1) {
            this.currentStake = this.baseStake * this.firstLossMultiplier;
        } else {
            // 2+ losses: base × 11.3^(n-1)
            const exponent = this.consecutiveLosses - 1;
            // this.currentStake = this.currentStake * Math.pow(this.subsequentMultiplier, exponent);
            this.currentStake = Math.ceil(this.currentStake * this.firstLossMultiplier * 100) / 100;
        }

        // Round to 2 decimal places
        // this.currentStake = Math.round(this.currentStake * 100) / 100;

        // if (this.consecutiveLosses === 2) {
        //     this.currentStake = this.baseStake;
        // } else {
        // this.currentStake = Math.ceil(this.currentStake * this.firstLossMultiplier * 100) / 100;
        // }

        return this.currentStake;
    }

    /**
     * Check if we can trade (not hit max consecutive losses)
     */
    canTrade() {
        return this.consecutiveLosses < this.maxConsecutiveLosses;
    }

    /**
     * Update state after trade result
     */
    updateAfterTrade(won, profit) {
        this.stats.totalTrades++;
        this.stats.totalProfitLoss += profit;

        if (won) {
            this.stats.totalWins++;
            this.stats.biggestWin = Math.max(this.stats.biggestWin, profit);

            // Track loss streak before resetting
            if (this.consecutiveLosses > 0) {
                const streakKey = Math.min(this.consecutiveLosses, 5);
                this.stats.lossStreaks[streakKey]++;
            }

            // Reset on win
            this.consecutiveLosses = 0;
        } else {
            this.stats.totalLosses++;
            this.stats.biggestLoss = Math.min(this.stats.biggestLoss, profit);
            this.consecutiveLosses++;
            this.stats.maxConsecutiveLossesHit = Math.max(
                this.stats.maxConsecutiveLossesHit,
                this.consecutiveLosses
            );
        }

        // Calculate next stake
        this.calculateStake();

        return this.getStats();
    }

    /**
     * Reset state (for new session)
     */
    reset() {
        this.consecutiveLosses = 0;
        this.currentStake = this.baseStake;
    }

    /**
     * Get current stats
     */
    getStats() {
        const winRate = this.stats.totalTrades > 0
            ? ((this.stats.totalWins / this.stats.totalTrades) * 100).toFixed(1)
            : 0;

        return {
            ...this.stats,
            winRate: parseFloat(winRate),
            consecutiveLosses: this.consecutiveLosses,
            currentStake: this.currentStake,
            canTrade: this.canTrade()
        };
    }

    /**
     * Get stake progression for display
     */
    getStakeProgression() {
        const progression = [];
        for (let losses = 0; losses <= this.maxConsecutiveLosses; losses++) {
            let stake;
            if (losses === 0) stake = this.baseStake;
            else if (losses === 1) stake = this.baseStake * this.firstLossMultiplier;
            else stake = this.baseStake * this.baseStake * this.firstLossMultiplier;

            progression.push({
                losses,
                stake: Math.round(stake * 100) / 100
            });
        }
        return progression;
    }
}

// ============================================================================
// STATE PERSISTENCE
// ============================================================================

const STATE_FILE = path.join(__dirname, 'kclaude-000016-state.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static saveState(bot) {
        try {
            const state = {
                savedAt: Date.now(),
                version: 'zscore-1.0',
                moneyManagement: {
                    consecutiveLosses: bot.moneyManager.consecutiveLosses,
                    currentStake: bot.moneyManager.currentStake,
                    stats: bot.moneyManager.stats
                },
                trading: {
                    totalProfitLoss: bot.totalProfitLoss,
                    lastPrediction: bot.lastPrediction,
                    lastTradeType: bot.lastTradeType,
                    sessionStartTime: bot.sessionStartTime
                },
                assets: {}
            };

            bot.assets.forEach(asset => {
                state.assets[asset] = {
                    tickHistory: bot.tickHistories[asset].slice(-3000),
                    lastTickLogTime: bot.lastTickLogTime[asset]
                };
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        } catch (error) {
            console.error(`State save failed: ${error.message}`);
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                console.log('📂 No saved state found, starting fresh');
                return null;
            }

            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - data.savedAt) / 60000;

            if (ageMinutes > 120) {
                console.log(`⚠️ State is ${ageMinutes.toFixed(0)}min old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return null;
            }

            console.log(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);
            return data;
        } catch (error) {
            console.error(`State load failed: ${error.message}`);
            return null;
        }
    }

    static startAutoSave(bot) {
        setInterval(() => StatePersistence.saveState(bot), STATE_SAVE_INTERVAL);
        console.log('💾 Auto-save enabled (every 5s)');
    }
}

// ============================================================================
// MAIN TRADING BOT
// ============================================================================

class FibonacciZScoreBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // EXACT assets as specified
        this.assets = [
            'R_10',
            // 'R_25',
            // 'R_50'
        ];

        // Configuration
        this.config = {
            baseStake: config.baseStake || 2.20,
            minHistoryLength: config.minHistoryLength || 2000,
            maxHistoryLength: config.maxHistoryLength || 3000,
            telegramToken: '8106601008:AAEMyCma6mvPYIHEvw3RHQX2tkD5-wUe1o0',
            telegramChatId: '752497117'
        };

        // Initialize engines
        this.zScoreEngine = new FibonacciZScoreEngine();
        this.volatilityEngine = new RelativeVolatilityEngine();
        this.moneyManager = new MoneyManagementEngine({
            baseStake: this.config.baseStake
        });

        // Trading state
        this.tradeInProgress = false;
        this.totalProfitLoss = 0;
        this.lastPrediction = null;
        this.lastTradeType = null;
        this.sessionStartTime = Date.now();
        this.suspendedAssets = new Set();
        this.endOfDay = false;
        this.isWinTrade = false;
        this.lastPrediction = null;
        this.lastZScore = null;

        // Connection management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 100;
        this.reconnectDelay = 3000;
        this.reconnectTimer = null;
        this.isReconnecting = false;

        // Heartbeat
        this.pingInterval = null;
        this.lastPongTime = Date.now();
        this.lastDataTime = Date.now();
        this.dataCheckInterval = null;

        // Message queue
        this.messageQueue = [];

        // Subscriptions
        this.activeSubscriptions = new Set();
        this.tickSubscriptionIds = {};

        // Telegram
        this.telegramEnabled = true;
        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.config.telegramToken, { polling: false });
        }

        // Tick data
        this.tickHistories = {};
        this.lastTickLogTime = {};
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.lastTickLogTime[asset] = 0;
        });

        // Stats
        this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0 };

        // Load saved state
        this.loadSavedState();
    }

    loadSavedState() {
        const saved = StatePersistence.loadState();
        if (!saved) return;

        try {
            // Restore money management state
            if (saved.moneyManagement) {
                this.moneyManager.consecutiveLosses = saved.moneyManagement.consecutiveLosses;
                this.moneyManager.currentStake = saved.moneyManagement.currentStake;
                Object.assign(this.moneyManager.stats, saved.moneyManagement.stats);
            }

            // Restore trading state
            if (saved.trading) {
                this.totalProfitLoss = saved.trading.totalProfitLoss || 0;
            }

            // Restore tick histories
            if (saved.assets) {
                Object.keys(saved.assets).forEach(asset => {
                    if (this.tickHistories[asset]) {
                        this.tickHistories[asset] = saved.assets[asset].tickHistory || [];
                    }
                });
            }

            const stats = this.moneyManager.getStats();
            console.log('✅ State restored');
            console.log(`   Trades: ${stats.totalTrades} | W/L: ${stats.totalWins}/${stats.totalLosses}`);
            console.log(`   P&L: $${this.totalProfitLoss.toFixed(2)} | Consecutive Losses: ${stats.consecutiveLosses}`);
        } catch (error) {
            console.error(`State restore error: ${error.message}`);
        }
    }

    // ========================================================================
    // WEBSOCKET CONNECTION
    // ========================================================================

    connect() {
        if (this.ws?.readyState === WebSocket.OPEN) {
            console.log('Already connected');
            return;
        }

        console.log('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ WebSocket connected');
            this.connected = true;
            this.wsReady = false;
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            this.lastPongTime = Date.now();
            this.lastDataTime = Date.now();

            this.startHeartbeat();
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            this.lastPongTime = Date.now();
            this.lastDataTime = Date.now();

            try {
                this.handleMessage(JSON.parse(data));
            } catch (error) {
                console.error('Message parse error:', error.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error.message);
        });

        this.ws.on('close', (code, reason) => {
            console.log(`WebSocket closed (${code}): ${reason || 'No reason'}`);
            this.handleDisconnect();
        });

        this.ws.on('pong', () => {
            this.lastPongTime = Date.now();
        });
    }

    startHeartbeat() {
        this.stopHeartbeat();

        // Ping every 25 seconds
        this.pingInterval = setInterval(() => {
            if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, 25000);

        // Check for data silence every 15 seconds
        this.dataCheckInterval = setInterval(() => {
            if (!this.connected) return;

            const silence = Date.now() - this.lastDataTime;
            if (silence > 90000) {
                console.error(`⚠️ No data for ${Math.round(silence / 1000)}s, reconnecting...`);
                StatePersistence.saveState(this);
                this.ws?.terminate();
            }
        }, 15000);
    }

    stopHeartbeat() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.dataCheckInterval) clearInterval(this.dataCheckInterval);
        this.pingInterval = null;
        this.dataCheckInterval = null;
    }

    sendRequest(request) {
        if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
            this.messageQueue.push(request);
            return false;
        }

        try {
            this.ws.send(JSON.stringify(request));
            return true;
        } catch (error) {
            console.error('Send error:', error.message);
            return false;
        }
    }

    authenticate() {
        this.sendRequest({ authorize: this.token });
    }

    // ========================================================================
    // MESSAGE HANDLING
    // ========================================================================

    handleMessage(msg) {
        if (msg.msg_type === 'ping') {
            this.sendRequest({ ping: 1 });
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                this.handleAuthorize(msg);
                break;
            case 'history':
                this.handleTickHistory(msg);
                break;
            case 'tick':
                this.handleTick(msg);
                break;
            case 'buy':
                this.handleBuy(msg);
                break;
            case 'proposal_open_contract':
                this.handleContractUpdate(msg);
                break;
            default:
                if (msg.error) {
                    console.error('API Error:', msg.error.message);
                    if (msg.error.code === 'AuthorizationRequired') {
                        this.handleDisconnect();
                    }
                }
        }
    }

    handleAuthorize(msg) {
        if (msg.error) {
            console.error('❌ Auth failed:', msg.error.message);
            this.sendTelegram(`❌ Auth Failed: ${msg.error.message}`);
            return;
        }

        console.log('✅ Authenticated');
        console.log(`   Account: ${msg.authorize.loginid}`);
        console.log(`   Balance: $${parseFloat(msg.authorize.balance).toFixed(2)}`);

        this.wsReady = true;

        // Process queued messages
        const queue = [...this.messageQueue];
        this.messageQueue = [];
        queue.forEach(req => this.sendRequest(req));

        // Initialize subscriptions
        this.initializeSubscriptions();

        this.sendTelegram(`
            ✅ <b>Bot Started</b>

            💼 Account: ${msg.authorize.loginid}
            💰 Balance: $${parseFloat(msg.authorize.balance).toFixed(2)}
            📊 Assets: ${this.assets.join(', ')}
            🎯 Base Stake: $${this.config.baseStake}

            ⏰ ${new Date().toLocaleString()}
        `.trim());
    }

    initializeSubscriptions() {
        console.log('📊 Initializing subscriptions...');

        this.assets.forEach(asset => {
            // Get historical ticks
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.minHistoryLength,
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

    handleBuy(msg) {
        if (msg.error) {
            console.error('❌ Trade failed:', msg.error.message);
            this.sendTelegram(`❌ Trade Error: ${msg.error.message}`);
            this.tradeInProgress = false;
            return;
        }

        console.log('✅ Trade placed, contract:', msg.buy.contract_id);

        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: msg.buy.contract_id,
            subscribe: 1
        });
    }

    handleTickHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        const prices = msg.history?.prices || [];

        this.tickHistories[asset] = prices.map(p => this.getLastDigit(p, asset));
        console.log(`📊 ${asset}: Loaded ${this.tickHistories[asset].length} ticks`);
    }

    handleTick(msg) {
        const tick = msg.tick;
        if (!tick) return;

        const asset = tick.symbol;

        // Track subscription
        if (msg.subscription) {
            this.tickSubscriptionIds[asset] = msg.subscription.id;
            this.activeSubscriptions.add(msg.subscription.id);
        }

        // Update history
        const digit = this.getLastDigit(tick.quote, asset);
        this.tickHistories[asset].push(digit);

        // Trim to max length
        while (this.tickHistories[asset].length > this.config.maxHistoryLength) {
            this.tickHistories[asset].shift();
        }

        // Periodic logging
        const now = Date.now();
        // if (now - this.lastTickLogTime[asset] >= 30000) {
        if (this.tradeInProgress) {
            this.logAssetStatus(asset);
            this.lastTickLogTime[asset] = now;
            console.log(`📊 ${asset}: ${this.tickHistories[asset].slice(-10).join(', ')}`);
        }

        // console.log(`📊 ${asset}: ${this.tickHistories[asset].slice(-10).join(', ')}`);

        // Analyze for trading
        if (!this.tradeInProgress && this.wsReady) {
            this.analyzeAndTrade(asset);
        }
    }

    // ========================================================================
    // ANALYSIS AND TRADING
    // ========================================================================

    analyzeAndTrade(asset) {
        if (this.tradeInProgress || this.suspendedAssets.has(asset) || !this.wsReady) {
            return;
        }

        const history = this.tickHistories[asset];
        if (history.length < this.config.minHistoryLength) return;
        if (!this.moneyManager.canTrade()) return;

        this.volatilityLevel = this.getVolatilityLevel(history);
        const volatility = this.volatilityEngine.calculateVolatilityLevel(history);

        console.log(`[${asset}] Volatilityn: ${this.volatilityLevel} | Volatility: ${volatility.level} (Score: ${volatility.score.toFixed(2)})`);
        if (!volatility.canTrade) return;

        let shouldTrade = false;
        let digitToTrade = null;
        let tradeType = null;

        // === 1. ULTRA-LOW BONUS TRIGGER (5+ streak) ===
        // if (volatility.level === 'ultra-low' && (this.volatilityLevel === 'medium' || this.volatilityLevel === 'low')) {
        //     const bonus = this.volatilityEngine.checkBonusTrigger(history);
        //     if (bonus.triggered && this.lastPrediction !== bonus.digit) {
        //         shouldTrade = true;
        //         digitToTrade = bonus.digit;
        //         tradeType = 'BONUS_STREAK';
        //     }
        // }

        // === 2. FIBONACCI SATURATION (ROMANIAN GHOST EXACT LOGIC) ===
        if (!shouldTrade) {
            const saturation = this.zScoreEngine.findSaturatedDigit(history);
            // console.log('Saturation Score:', JSON.stringify(saturation))

            if (saturation) {
                // ROMANIAN GHOST'S EXACT CONDITION — ONLY +0.3 improvement OR new digit
                console.log('Saturation Score:', saturation.totalZScore)
                const zImproved = !this.lastZScore || saturation.totalZScore > this.lastZScore + 0.3;
                const newDigit = this.lastPrediction !== saturation.digit;

                // if ((newDigit || zImproved) && saturation.totalZScore >= 22.30 && (volatility.level === 'ultra-low' || volatility.level === 'low')) {
                if (saturation.totalZScore >= 22.30 && (volatility.level === 'ultra-low' || volatility.level === 'low') && (this.volatilityLevel === 'medium' || this.volatilityLevel === 'low')) {
                    shouldTrade = true;
                    digitToTrade = saturation.digit;
                    tradeType = 'FIB_SATURATION';
                    this.lastZScore = saturation.totalZScore;  // Update for next comparison
                }
            }
        }

        if (shouldTrade && digitToTrade !== null) {
            this.lastPrediction = digitToTrade;
            this.executeTrade(asset, digitToTrade, tradeType, { volatility }, saturation);
        }
    }

    getVolatilityLevel(tickHistory) {
        if (tickHistory.length < 50) return 'unknown';
        const recent = tickHistory.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        const stdDev = Math.sqrt(variance);

        if (stdDev > 3.1) return 'extreme';
        if (stdDev > 2.8) return 'high';
        if (stdDev > 2.0) return 'medium';

        return 'low';
    }

    executeTrade(asset, digit, tradeType, analysisData, saturationInfo) {
        if (this.tradeInProgress || !this.wsReady) return;

        this.tradeInProgress = true;
        this.lastPrediction = digit;
        this.lastTradeType = tradeType;

        const stake = this.moneyManager.calculateStake();

        console.log(`\n🎯 TRADE SIGNAL | ${asset}`);
        console.log(`   Type: ${tradeType}`);
        console.log(`   Digit: ${digit} (betting it WON'T appear)`);
        console.log(`   Stake: $${stake.toFixed(2)}`);
        console.log(`   Volatility: ${analysisData.volatility.level} (${analysisData.volatility.score.toFixed(3)})`);
        console.log(`   Average Entropy Deviation: ${analysisData.volatility.avgEntropyDeviation.toFixed(3)}`);
        console.log(`   Entropy Streak Deviation: ${analysisData.volatility.avgStreakDeviation.toFixed(3)}`);

        if (saturationInfo) {
            console.log(`   Z-Score: ${saturationInfo.totalZScore.toFixed(2)}`);
            console.log(`   Valid Windows: ${saturationInfo.validWindows}`);
        }

        // Send Telegram alert
        this.sendTelegram(`
            🔔 <b>Trade Signal</b> | ${asset}

            🎯 Digit: <b>${digit}</b> (DIFFER)
            💰 Stake: <b>$${stake.toFixed(2)}</b>
            📊 Type: ${tradeType}

            📈 <b>Analysis:</b>
            ├ Volatility: ${analysisData.volatility.level} (${analysisData.volatility.score.toFixed(3)})
            ${saturationInfo ? `├ Z-Score: ${saturationInfo.totalZScore.toFixed(2)}
            ├ Windows: ${saturationInfo.validWindows}/10` : ''}
            └ Last 10: ${this.tickHistories[asset].slice(-10).join(',')}
        `.trim());

        // Place trade
        this.sendRequest({
            buy: 1,
            price: stake.toFixed(2),
            parameters: {
                amount: stake.toFixed(2),
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: asset,
                barrier: digit.toString()
            }
        });
    }


    handleContractUpdate(msg) {
        const contract = msg.proposal_open_contract;
        if (!contract?.is_sold) return;

        const won = contract.status === 'won';
        this.isWinTrade = won;
        const profit = parseFloat(contract.profit);
        const asset = contract.underlying;
        const exitDigit = this.getLastDigit(contract.exit_tick_display_value, asset);

        // Update money manager
        const stats = this.moneyManager.updateAfterTrade(won, profit);
        this.totalProfitLoss += profit;

        // Update hourly stats
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;
        if (won) this.hourlyStats.wins++;
        else this.hourlyStats.losses++;

        // Log result
        console.log(`\n${won ? '✅ WIN' : '❌ LOSS'} | ${asset}`);
        console.log(`   Predicted: ${this.lastPrediction} | Actual: ${exitDigit}`);
        console.log(`   P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
        console.log(`   Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`);
        console.log(`   Stats: ${stats.totalWins}W/${stats.totalLosses}L (${stats.winRate}%)`);
        console.log(`   Next Stake: $${stats.currentStake.toFixed(2)}`);

        // Telegram notification
        this.sendTelegram(`
        ${won ? '✅ WIN' : '❌ LOSS'} | <b>${asset}</b>

            🎯 Predicted: ${this.lastPrediction} | Actual: ${exitDigit}
            📊 Type: ${this.lastTradeType}
            ${profit >= 0 ? '🟢' : '🔴'} P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}

            <b>Session Stats:</b>
            ├ W/L: ${stats.totalWins}/${stats.totalLosses} (${stats.winRate}%)
            ├ Streak: ${won ? '0L' : `${stats.consecutiveLosses}L`}
            ├ Loss Streaks: 2L×${stats.lossStreaks[2]} | 3L×${stats.lossStreaks[3]} | 4L×${stats.lossStreaks[4]} | 5L×${stats.lossStreaks[5]}
            ├ Session P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}
            └ Next Stake: $${stats.currentStake.toFixed(2)}

            ⏰ ${new Date().toLocaleTimeString()}
        `.trim());

        // Check if we hit max losses
        if (!stats.canTrade) {
            console.log('🛑 MAX CONSECUTIVE LOSSES REACHED - STOPPING');
            this.sendTelegram(`
                🛑 <b>MAX LOSSES REACHED</b>

                Session ended due to ${this.moneyManager.maxConsecutiveLosses} consecutive losses.

                Final P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}
                Total Trades: ${stats.totalTrades}
                Win Rate: ${stats.winRate}%
            `.trim());

            this.endOfDay = true;
            this.disconnect();
            return;
        }

        // Suspend asset briefly after loss
        // if (!won) {
        //     this.suspendAsset(asset, 45000);
        // }

        this.tradeInProgress = false;
    }

    // ========================================================================
    // UTILITIES
    // ========================================================================

    getLastDigit(quote, asset) {
        const str = quote.toString();
        const [, decimal = ''] = str.split('.');

        // Different decimal places for different assets
        if (asset === 'R_50') {
            return decimal.length >= 4 ? parseInt(decimal[3]) : 0;
        } else if (asset === 'R_10' || asset === 'R_25') {
            return decimal.length >= 3 ? parseInt(decimal[2]) : 0;
        }
        return decimal.length >= 2 ? parseInt(decimal[1]) : 0;
    }

    logAssetStatus(asset) {
        const history = this.tickHistories[asset];
        const volatility = this.volatilityEngine.calculateVolatilityLevel(history);
        const topZScores = this.zScoreEngine.getAnalysisSummary(history);

        console.log(`[${asset}] Ticks: ${history.length} | Vol: ${volatility.level} (${volatility.score?.toFixed(3) || 'N/A'}) | Top Z: ${topZScores.join(', ') || 'N/A'}`);
    }

    suspendAsset(asset, duration = 60000) {
        this.suspendedAssets.add(asset);
        console.log(`🚫 ${asset} suspended for ${duration / 1000}s`);

        setTimeout(() => {
            this.suspendedAssets.delete(asset);
            console.log(`✅ ${asset} reactivated`);
        }, duration);
    }

    async sendTelegram(message) {
        if (!this.telegramEnabled) return;

        try {
            await this.telegramBot.sendMessage(
                this.config.telegramChatId,
                message,
                { parse_mode: 'HTML' }
            );
        } catch (error) {
            console.error('Telegram error:', error.message);
        }
    }

    // ========================================================================
    // CONNECTION MANAGEMENT
    // ========================================================================

    handleDisconnect() {
        if (this.endOfDay) {
            console.log('Planned shutdown, not reconnecting');
            this.cleanup();
            return;
        }

        if (this.isReconnecting) return;

        this.connected = false;
        this.wsReady = false;
        this.stopHeartbeat();

        StatePersistence.saveState(this);

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            this.sendTelegram(`❌ Max reconnections reached. P&L: $${this.totalProfitLoss.toFixed(2)}`);
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        const delay = Math.min(this.reconnectDelay * Math.pow(1.3, this.reconnectAttempts - 1), 60000);

        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.reconnectTimer = setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    cleanup() {
        this.stopHeartbeat();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.removeAllListeners();
            try { this.ws.close(); } catch (e) { }
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
        console.log('✅ Disconnected');
    }

    // ========================================================================
    // STARTUP
    // ========================================================================

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay(); // 0: Sunday, 1: Monday, ..., 6: Saturday
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Weekend logic: Saturday 11pm to Monday 8am GMT+1 -> Disconnect and stay disconnected
            const isWeekend = (currentDay === 0) || // Sunday
                (currentDay === 6 && currentHours >= 23) || // Saturday after 11pm
                (currentDay === 1 && currentHours < 8);    // Monday before 8am

            if (isWeekend) {
                if (!this.endOfDay) {
                    console.log("Weekend trading suspension (Saturday 11pm - Monday 8am). Disconnecting...");
                    this.disconnect();
                    this.endOfDay = true;
                }
                return; // Prevent any reconnection logic during the weekend
            }

            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM GMT+1, reconnecting the bot.");
                this.resetDailyStats();
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    resetDailyStats() {
        this.tradeInProgress = false;
        this.suspendedAssets.clear(); // Using clear() for Set
        this.isWinTrade = false;
    }

    start() {
        console.log('\n' + '═'.repeat(60));
        console.log('  FIBONACCI Z-SCORE SATURATION BOT');
        console.log('═'.repeat(60));
        console.log('');
        console.log('📋 Configuration:');
        console.log(`   Assets: ${this.assets.join(', ')}`);
        console.log(`   Base Stake: $${this.config.baseStake}`);
        console.log(`   Min History: ${this.config.minHistoryLength} ticks`);
        console.log(`   Z-Score Threshold: ${this.zScoreEngine.Z_SCORE_THRESHOLD}`);
        console.log(`   Fibonacci Windows: ${this.zScoreEngine.FIBONACCI_WINDOWS.join(', ')}`);
        console.log('');
        console.log('📈 Stake Progression:');
        this.moneyManager.getStakeProgression().forEach(({ losses, stake }) => {
            console.log(`   ${losses}L → $${stake.toFixed(2)}`);
        });
        console.log('');

        const stats = this.moneyManager.getStats();
        if (stats.totalTrades > 0) {
            console.log('📊 Restored Session:');
            console.log(`   Trades: ${stats.totalTrades} | W/L: ${stats.totalWins}/${stats.totalLosses}`);
            console.log(`   P&L: $${this.totalProfitLoss.toFixed(2)} | Win Rate: ${stats.winRate}%`);
            console.log('');
        }

        this.connect();
        this.startHourlySummary();
        this.checkTimeForDisconnectReconnect();
    }

    startHourlySummary() {
        // Send summary every hour
        setInterval(() => {
            const stats = this.moneyManager.getStats();

            this.sendTelegram(`
                ⏰ <b>Hourly Summary</b>

                <b>Last Hour:</b>
                ├ Trades: ${this.hourlyStats.trades}
                ├ W/L: ${this.hourlyStats.wins}/${this.hourlyStats.losses}
                └ P&L: ${this.hourlyStats.pnl >= 0 ? '+' : ''}$${this.hourlyStats.pnl.toFixed(2)}

                <b>Session Total:</b>
                ├ Trades: ${stats.totalTrades}
                ├ W/L: ${stats.totalWins}/${stats.totalLosses} (${stats.winRate}%)
                ├ P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}
                ├ Streak: ${stats.consecutiveLosses}L
                └ Loss Streaks: 2L×${stats.lossStreaks[2]} | 3L×${stats.lossStreaks[3]} | 4L×${stats.lossStreaks[4]} | 5L×${stats.lossStreaks[5]}

                ⏰ ${new Date().toLocaleString()}
            `.trim());

            // Reset hourly stats
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        }, 3600000);
    }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

const bot = new FibonacciZScoreBot('0P94g4WdSrSrzir', {
    baseStake: 0.61,
    minHistoryLength: 2000,
    maxHistoryLength: 3000,
    telegramToken: '',      // Add your Telegram bot token
    telegramChatId: ''      // Add your Telegram chat ID
});

StatePersistence.startAutoSave(bot);
bot.start();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n⚠️ SIGINT received, shutting down...');
    bot.disconnect();
    setTimeout(() => process.exit(0), 2000);
});

process.on('SIGTERM', () => {
    console.log('\n⚠️ SIGTERM received, shutting down...');
    bot.disconnect();
    setTimeout(() => process.exit(0), 2000);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    StatePersistence.saveState(bot);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection:', reason);
});
