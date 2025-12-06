/**
 * Deriv Digit Differ Trading Bot v3.0 - Multi-Asset Concurrent Trading
 * 
 * Features:
 * - Concurrent trading on multiple assets (R_10, R_25, R_50, R_75, R_100)
 * - Independent analysis and stake management per asset
 * - Rigorous statistical analysis on 5000 ticks per asset
 * - Strict trading conditions
 * - Global risk management across all assets
 * 
 * DISCLAIMER: No trading bot can guarantee 100% success.
 */

const WebSocket = require('ws');
const nodemailer = require('nodemailer');
// const StatisticalAnalyzer = require('./StatisticalAnalyzer2');


/**
 * Statistical Analyzer for Digit Patterns
 * Uses rigorous statistical methods to identify optimal trading conditions
 */
class StatisticalAnalyzer {
    constructor(config) {
        this.config = config;
        this.cache = new Map();
    }

    /**
     * Main analysis function - determines if conditions are safe to trade
     * @param {number[]} history - Array of last digits (0-9)
     * @returns {Object} Analysis result with trading recommendation
     */
    analyze(history) {
        // Validate input
        if (!this.validateHistory(history)) {
            return this.createResult(false, 0, null, 'Invalid or insufficient history');
        }

        const currentDigit = history[history.length - 1];

        // Core statistical analyses
        const repetitionStats = this.analyzeRepetitions(history);
        const digitStats = this.analyzeDigitBehavior(history, currentDigit);
        const streakStats = this.analyzeStreaks(history);
        const transitionStats = this.analyzeTransitions(history, currentDigit);
        const entropyStats = this.analyzeEntropy(history);

        // Calculate composite confidence score
        const confidence = this.calculateConfidence({
            repetitionStats,
            digitStats,
            streakStats,
            transitionStats,
            entropyStats,
            currentDigit
        });

        // Determine if we should trade
        const shouldTrade = this.evaluateTradeConditions({
            confidence,
            repetitionStats,
            digitStats,
            streakStats,
            currentDigit
        });

        return this.createResult(
            shouldTrade,
            confidence,
            currentDigit,
            this.generateReason(shouldTrade, confidence, repetitionStats, digitStats),
            {
                repetitionStats,
                digitStats,
                streakStats,
                transitionStats,
                entropyStats
            }
        );
    }

    /**
     * Validate history array
     */
    validateHistory(history) {
        if (!Array.isArray(history)) return false;
        if (history.length < this.config.minHistoryLength) return false;

        for (const digit of history) {
            if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
                return false;
            }
        }
        return true;
    }

    /**
     * Analyze repetition patterns in history
     * Key insight: We're betting the digit WON'T repeat
     */
    analyzeRepetitions(history) {
        let totalRepetitions = 0;
        let currentNonRepStreak = 0;
        let maxNonRepStreak = 0;
        const recentWindow = 100;
        let recentRepetitions = 0;

        // Full history analysis
        for (let i = 1; i < history.length; i++) {
            if (history[i] === history[i - 1]) {
                totalRepetitions++;
                maxNonRepStreak = Math.max(maxNonRepStreak, currentNonRepStreak);
                currentNonRepStreak = 0;
            } else {
                currentNonRepStreak++;
            }
        }
        maxNonRepStreak = Math.max(maxNonRepStreak, currentNonRepStreak);

        // Recent window analysis
        const recent = history.slice(-recentWindow);
        for (let i = 1; i < recent.length; i++) {
            if (recent[i] === recent[i - 1]) {
                recentRepetitions++;
            }
        }

        const overallRate = totalRepetitions / (history.length - 1);
        const recentRate = recentRepetitions / (recent.length - 1);

        // Calculate z-score for repetition rate
        // Expected rate ~10% (1/10 chance of repetition)
        const expectedRate = 0.10;
        const stdDev = Math.sqrt(expectedRate * (1 - expectedRate) / history.length);
        const zScore = (overallRate - expectedRate) / stdDev;

        return {
            overallRate,
            recentRate,
            totalRepetitions,
            currentNonRepStreak,
            maxNonRepStreak,
            zScore,
            isBelowExpected: overallRate < expectedRate,
            isSignificantlyLow: zScore < -2 // 95% confidence interval
        };
    }

    /**
     * Analyze specific digit behavior
     */
    analyzeDigitBehavior(history, targetDigit) {
        const occurrences = [];
        const gaps = [];
        let lastIndex = -1;
        let selfRepetitions = 0;

        for (let i = 0; i < history.length; i++) {
            if (history[i] === targetDigit) {
                occurrences.push(i);
                if (lastIndex !== -1) {
                    gaps.push(i - lastIndex);
                }
                // Check if this digit repeated itself
                if (i > 0 && history[i - 1] === targetDigit) {
                    selfRepetitions++;
                }
                lastIndex = i;
            }
        }

        const frequency = occurrences.length / history.length;
        const expectedFreq = 0.10;

        // Gap analysis
        const avgGap = gaps.length > 0
            ? gaps.reduce((a, b) => a + b, 0) / gaps.length
            : history.length;
        const currentGap = history.length - 1 - lastIndex;

        // Self-repetition rate for this digit
        const selfRepRate = occurrences.length > 1
            ? selfRepetitions / (occurrences.length - 1)
            : 0;

        // Is digit "cold" (appearing less than expected)?
        const isUnderrepresented = frequency < expectedFreq * 0.85;

        // Is digit "hot" (appearing more than expected)?
        const isOverrepresented = frequency > expectedFreq * 1.15;

        return {
            frequency,
            occurrences: occurrences.length,
            selfRepetitions,
            selfRepRate,
            avgGap,
            currentGap,
            maxGap: gaps.length > 0 ? Math.max(...gaps) : 0,
            minGap: gaps.length > 0 ? Math.min(...gaps) : 0,
            isUnderrepresented,
            isOverrepresented,
            lastAppearance: lastIndex
        };
    }

    /**
     * Analyze streaks of consecutive same digits
     */
    analyzeStreaks(history) {
        const streaks = [];
        let currentStreak = 1;
        let currentDigit = history[0];

        for (let i = 1; i < history.length; i++) {
            if (history[i] === currentDigit) {
                currentStreak++;
            } else {
                if (currentStreak >= 2) {
                    streaks.push({ digit: currentDigit, length: currentStreak });
                }
                currentDigit = history[i];
                currentStreak = 1;
            }
        }

        // Handle last streak
        if (currentStreak >= 2) {
            streaks.push({ digit: currentDigit, length: currentStreak });
        }

        // Recent streak analysis (last 500 ticks)
        const recent500 = history.slice(-500);
        let recentStreakCount = 0;
        for (let i = 1; i < recent500.length; i++) {
            if (recent500[i] === recent500[i - 1]) {
                recentStreakCount++;
            }
        }

        return {
            totalStreaks: streaks.length,
            avgStreakLength: streaks.length > 0
                ? streaks.reduce((a, b) => a + b.length, 0) / streaks.length
                : 0,
            maxStreak: streaks.length > 0
                ? Math.max(...streaks.map(s => s.length))
                : 0,
            recentStreakDensity: recentStreakCount / (recent500.length - 1),
            currentStreakDigit: history[history.length - 1],
            currentStreakLength: this.getCurrentStreakLength(history)
        };
    }

    getCurrentStreakLength(history) {
        let streak = 1;
        const lastDigit = history[history.length - 1];
        for (let i = history.length - 2; i >= 0; i--) {
            if (history[i] === lastDigit) {
                streak++;
            } else {
                break;
            }
        }
        return streak;
    }

    /**
     * Analyze transition probabilities
     */
    analyzeTransitions(history, fromDigit) {
        const transitions = new Array(10).fill(0);
        let totalFromDigit = 0;

        for (let i = 0; i < history.length - 1; i++) {
            if (history[i] === fromDigit) {
                transitions[history[i + 1]]++;
                totalFromDigit++;
            }
        }

        if (totalFromDigit === 0) {
            return {
                selfTransitionRate: 0,
                transitionProbs: new Array(10).fill(0.1),
                sampleSize: 0,
                isReliable: false
            };
        }

        const transitionProbs = transitions.map(t => t / totalFromDigit);
        const selfTransitionRate = transitionProbs[fromDigit];

        return {
            selfTransitionRate,
            transitionProbs,
            sampleSize: totalFromDigit,
            isReliable: totalFromDigit >= this.config.minSampleSize / 10,
            leastLikelyNext: transitionProbs.indexOf(Math.min(...transitionProbs)),
            mostLikelyNext: transitionProbs.indexOf(Math.max(...transitionProbs))
        };
    }

    /**
     * Calculate Shannon entropy of digit distribution
     * Higher entropy = more random = harder to predict
     */
    analyzeEntropy(history) {
        const counts = new Array(10).fill(0);
        for (const digit of history) {
            counts[digit]++;
        }

        let entropy = 0;
        const n = history.length;
        for (const count of counts) {
            if (count > 0) {
                const p = count / n;
                entropy -= p * Math.log2(p);
            }
        }

        // Maximum entropy for 10 equally likely outcomes
        const maxEntropy = Math.log2(10); // ~3.32
        const normalizedEntropy = entropy / maxEntropy;

        // Recent entropy (last 200 ticks)
        const recent = history.slice(-200);
        const recentCounts = new Array(10).fill(0);
        for (const digit of recent) {
            recentCounts[digit]++;
        }

        let recentEntropy = 0;
        for (const count of recentCounts) {
            if (count > 0) {
                const p = count / recent.length;
                recentEntropy -= p * Math.log2(p);
            }
        }
        const normalizedRecentEntropy = recentEntropy / maxEntropy;

        return {
            entropy,
            normalizedEntropy,
            recentEntropy,
            normalizedRecentEntropy,
            isHighlyRandom: normalizedEntropy > 0.95,
            isLessRandom: normalizedEntropy < 0.90
        };
    }

    /**
     * Calculate composite confidence score
     */
    calculateConfidence(analyses) {
        const {
            repetitionStats,
            digitStats,
            streakStats,
            transitionStats,
            entropyStats
        } = analyses;

        let confidence = 0.5; // Base confidence

        // Factor 1: Overall repetition rate (weight: 30%)
        // Lower repetition rate = higher confidence
        if (repetitionStats.overallRate < 0.08) {
            confidence += 0.15;
        } else if (repetitionStats.overallRate < 0.10) {
            confidence += 0.10;
        } else if (repetitionStats.overallRate > 0.12) {
            confidence -= 0.10;
        }

        // Factor 2: Recent repetition rate (weight: 20%)
        if (repetitionStats.recentRate < 0.08) {
            confidence += 0.10;
        } else if (repetitionStats.recentRate > 0.15) {
            confidence -= 0.15;
        }

        // Factor 3: Current non-repetition streak (weight: 15%)
        if (repetitionStats.currentNonRepStreak >= 15) {
            confidence += 0.08;
        } else if (repetitionStats.currentNonRepStreak >= 10) {
            confidence += 0.05;
        } else if (repetitionStats.currentNonRepStreak < 3) {
            confidence -= 0.05;
        }

        // Factor 4: Digit-specific self-repetition rate (weight: 20%)
        if (digitStats.selfRepRate < 0.08) {
            confidence += 0.10;
        } else if (digitStats.selfRepRate > 0.15) {
            confidence -= 0.10;
        }

        // Factor 5: Transition probability (weight: 10%)
        if (transitionStats.isReliable) {
            if (transitionStats.selfTransitionRate < 0.08) {
                confidence += 0.05;
            } else if (transitionStats.selfTransitionRate > 0.15) {
                confidence -= 0.08;
            }
        }

        // Factor 6: Statistical significance (weight: 5%)
        if (repetitionStats.isSignificantlyLow) {
            confidence += 0.05;
        }

        // Penalty: If digit just appeared in a streak, reduce confidence
        if (streakStats.currentStreakLength > 1) {
            confidence -= 0.10 * (streakStats.currentStreakLength - 1);
        }

        // Penalty: Very high entropy means truly random - harder to predict
        if (entropyStats.normalizedRecentEntropy > 0.98) {
            confidence -= 0.05;
        }

        return Math.max(0, Math.min(1, confidence));
    }

    /**
     * Evaluate if all conditions for trading are met
     */
    evaluateTradeConditions(params) {
        const { confidence, repetitionStats, digitStats, streakStats, currentDigit } = params;
        const cfg = this.config;

        // STRICT CONDITIONS - ALL must be met

        // 1. Minimum confidence threshold
        if (confidence < cfg.minConfidence) {
            return false;
        }

        // 2. Overall repetition rate must be low
        if (repetitionStats.overallRate > cfg.maxRepetitionRate) {
            return false;
        }

        // 3. Recent repetition rate must also be low
        if (repetitionStats.recentRate > cfg.maxRepetitionRate * 1.5) {
            return false;
        }

        // 4. Must have some non-repetition momentum
        if (repetitionStats.currentNonRepStreak < cfg.minNonRepStreak) {
            return false;
        }

        // 5. Digit-specific repetition rate must be low
        if (digitStats.selfRepRate > cfg.selfRepetitionRate) {
            return false;
        }

        // 6. Current digit should not be in a streak > 1
        if (streakStats.currentStreakLength > 1) {
            return false;
        }

        // 7. Validate the digit itself
        if (!Number.isInteger(currentDigit) || currentDigit < 0 || currentDigit > 9) {
            return false;
        }

        return true;
    }

    /**
     * Create standardized result object
     */
    createResult(shouldTrade, confidence, predictedDigit, reason, details = null) {
        return {
            shouldTrade,
            confidence,
            predictedDigit,  // Digit we predict WON'T appear next
            reason,
            timestamp: Date.now(),
            details
        };
    }

    /**
     * Generate human-readable reason for decision
     */
    generateReason(shouldTrade, confidence, repetitionStats, digitStats) {
        if (!shouldTrade) {
            if (confidence < this.config.minConfidence) {
                return `Confidence too low: ${(confidence * 100).toFixed(1)}% < ${(this.config.minConfidence * 100).toFixed(1)}%`;
            }
            if (repetitionStats.overallRate > this.config.maxRepetitionRate) {
                return `Repetition rate too high: ${(repetitionStats.overallRate * 100).toFixed(1)}%`;
            }
            if (digitStats.selfRepRate > this.config.selfRepetitionRate) {
                return `Digit self-rep rate too high: ${(digitStats.selfRepRate * 100).toFixed(1)}%`;
            }
            if (repetitionStats.recentRate > this.config.recentRepetitionRate) {
                return `Digit recent rate too high: ${(repetitionStats.recentRate * 100).toFixed(1)}%`;
            }
            if (repetitionStats.currentNonRepStreak < this.config.minNonRepStreak) {
                return `Non-rep streak too short: ${repetitionStats.currentNonRepStreak}`;
            }
            return 'Conditions not met';
        }
        return `All conditions met - Confidence: ${(confidence * 100).toFixed(1)}%`;
    }

    /**
     * Get summary statistics for logging
     */
    getSummary(history) {
        if (!this.validateHistory(history)) {
            return null;
        }

        const analysis = this.analyze(history);
        const currentDigit = history[history.length - 1];

        return {
            historyLength: history.length,
            currentDigit,
            shouldTrade: analysis.shouldTrade,
            confidence: (analysis.confidence * 100).toFixed(1) + '%',
            repetitionRate: analysis.details?.repetitionStats
                ? (analysis.details.repetitionStats.overallRate * 100).toFixed(2) + '%'
                : 'N/A',
            recentRepRate: analysis.details?.repetitionStats
                ? (analysis.details.repetitionStats.recentRate * 100).toFixed(2) + '%'
                : 'N/A',
            nonRepStreak: analysis.details?.repetitionStats?.currentNonRepStreak || 0,
            reason: analysis.reason,
            maxNonRepStreak: analysis.details?.repetitionStats?.maxNonRepStreak || 0,
            selfRepRate: (analysis.details?.digitStats?.selfRepRate * 100).toFixed(2) + '%' || 'N/A',
        };
    }
}

// EnhancedDigitDifferTradingBot
class EnhancedDigitDifferTradingBot {
    constructor(token, config = {}) {
        this.token = token;

        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || [
            // '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V',
            // 'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR',
            // 'R_75',
        ];

        this.config = {
            initialStake: config.initialStake || 10.5,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
            stopLoss: config.stopLoss || 50,
            takeProfit: config.takeProfit || 1,
            requiredHistoryLength: config.requiredHistoryLength || 5000,
            winProbabilityThreshold: config.winProbabilityThreshold || 100,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            minWaitTime: config.minWaitTime || 200 * 1000,
            maxWaitTime: config.maxWaitTime || 500 * 1000,
            // Analysis Thresholds - CRITICAL for trade decisions
            ANALYSIS: {
                minHistoryLength: config.ANALYSIS.minHistoryLength || 5000,       // Minimum ticks before trading
                minConfidence: config.ANALYSIS.minConfidence || 0.8,          // Minimum confidence to trade (92%)
                maxRepetitionRate: config.ANALYSIS.maxRepetitionRate || 0.10,      // Max acceptable repetition rate (10%)
                recentRepetitionRate: config.ANALYSIS.recentRepetitionRate || 0.08,     // Maximum recent repetition rate (8%)
                selfRepetitionRate: config.ANALYSIS.selfRepetitionRate || 0.08,     // Maximum self-repetition rate (8%)
                minNonRepStreak: config.ANALYSIS.minNonRepStreak || 6,           // Minimum consecutive non-repetitions
                minSampleSize: config.ANALYSIS.minSampleSize || 500,           // Minimum samples for digit analysis 
            },
        };

        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.currentTradeId = null;
        this.digitCounts = {};
        this.tickSubscriptionIds = {};
        this.tickHistories = {};
        this.tickHistories2 = {};
        this.lastDigits = {};
        this.lastDigits2 = {};
        this.predictedDigits = {};
        this.lastPredictions = {};
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.endOfDay = false;
        this.lastPredictionOutcome = null;
        this.waitTime = 0;
        this.waitSeconds = 0;
        this.isWinTrade = false;
        this.excludedDigits = [];
        this.retryCount = 0;
        // this.startTime = null;
        this.isExcluded = [];
        // Add new property to track suspended assets
        this.suspendedAssets = new Set();
        this.rStats = {};
        this.sys = null;
        // Analyzer instance
        this.analyzer = new StatisticalAnalyzer(this.config.ANALYSIS);
        this.totalOccurences = 0;
        this.lastPredictedDigit = null;
        this.lastConfidence = null;


        // Initialize per-asset storage
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.lastDigits[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
        });


        //Email Configuration
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };
        this.emailRecipient = 'kenotaru@gmail.com';

        this.startEmailTimer();

        this.reconnectAttempts = 0;
        this.Pause = false;

        this.todayPnL = 0;
    }

    connect() {
        if (!this.Pause) {
            console.log('Attempting to connect to Deriv API...');
            this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            this.ws.on('open', () => {
                console.log('Connected to Deriv API');
                this.connected = true;
                this.wsReady = true;
                this.reconnectAttempts = 0;
                this.authenticate();
            });

            this.ws.on('message', (data) => {
                const message = JSON.parse(data);
                this.handleMessage(message);
            });

            this.ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.handleDisconnect();
            });

            this.ws.on('close', () => {
                console.log('Disconnected from Deriv API');
                this.connected = false;
                if (!this.Pause) {
                    this.handleDisconnect();
                }
            });
        }
    }

    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else if (this.connected && !this.wsReady) {
            console.log('WebSocket not ready. Queueing request...');
            setTimeout(() => this.sendRequest(request), this.config.reconnectInterval);
        } else {
            console.error('Not connected to Deriv API. Unable to send request:', request);
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.config.reconnectInterval);
        }

        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.tickHistories2[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
        });
        this.tickSubscriptionIds = {};

        //unsubscribe from all assets
        this.unsubscribeAllTicks();

        //unsubscribe from all assets
        this.assets.forEach(asset => {
            this.unsubscribeFromTicks(asset);
        });
    }

    handleApiError(error) {
        console.error('API Error:', error.message);

        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token. Please check your API token and restart the bot.');
                this.sendErrorEmail('Invalid API token');
                this.disconnect();
                break;
            case 'RateLimit':
                console.log('Rate limit reached. Waiting before next request...');
                setTimeout(() => this.initializeSubscriptions(), 60000);
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.initializeSubscriptions(), 3600000);
                break;
            default:
                console.log('Encountered an error. Continuing operation...');
                this.initializeSubscriptions();
        }
    }

    authenticate() {
        console.log('Attempting to authenticate...');
        this.sendRequest({
            authorize: this.token
        });
    }

    subscribeToTickHistory(asset) {
        const request = {
            ticks_history: asset,
            adjust_start_time: 1,
            count: this.config.requiredHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        };
        this.sendRequest(request);
        // console.log(`Requested tick history for asset: ${asset}`);
    }

    subscribeToTicks(asset) {
        const request = {
            ticks: asset,
            subscribe: 1
        };
        this.sendRequest(request);
    }

    handleMessage(message) {
        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                this.disconnect();
                return;
            }
            console.log('Authentication successful');

            this.tradeInProgress = false;
            this.predictionInProgress = false;
            this.assets.forEach(asset => {
                this.tickHistories[asset] = [];
                this.tickHistories2[asset] = [];
                this.digitCounts[asset] = Array(10).fill(0);
                this.predictedDigits[asset] = null;
                this.lastPredictions[asset] = [];
            });
            this.tickSubscriptionIds = {};
            this.retryCount = 0;
            this.initializeSubscriptions();

        } else if (message.msg_type === 'history') {
            const asset = message.echo_req.ticks_history;
            this.handleTickHistory(asset, message.history);
        } else if (message.msg_type === 'tick') {
            if (message.subscription) {
                const asset = message.tick.symbol;
                this.tickSubscriptionIds[asset] = message.subscription.id;
                // console.log(`Subscribed to ticks for ${asset}. Subscription ID: ${this.tickSubscriptionIds[asset]}`);
            }
            this.handleTickUpdate(message.tick);
        } else if (message.msg_type === 'buy') {
            if (message.error) {
                console.error('Error placing trade:', message.error.message);
                this.tradeInProgress = false;
                return;
            }
            console.log('Trade placed successfully');
            this.currentTradeId = message.buy.contract_id;
            this.subscribeToOpenContract(this.currentTradeId);
        } else if (message.msg_type === 'proposal_open_contract') {
            if (message.error) {
                console.error('Error receiving contract update:', message.error.message);
                return;
            }
            this.handleContractUpdate(message.proposal_open_contract);
        } else if (message.msg_type === 'forget') {
            // console.log('Successfully unsubscribed from ticks');
        } else if (message.error) {
            this.handleApiError(message.error);
        }
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V',].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    initializeSubscriptions() {
        console.log('Initializing subscriptions for all assets...');

        //unsubscribe from all assets
        this.assets.forEach(asset => {
            this.unsubscribeFromTicks(asset);
        });

        //subscribe to all assets
        this.assets.forEach(asset => {
            this.subscribeToTickHistory(asset);
            this.subscribeToTicks(asset);
        });
    }

    handleTickHistory(asset, history) {
        this.tickHistories[asset] = history.prices.map(price => this.getLastDigit(price, asset));
        // console.log(`Received tick history for asset: ${asset}. Length: ${this.tickHistories[asset].length}`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.lastDigits[asset] = lastDigit;

        this.tickHistories[asset].push(lastDigit);

        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        }

        console.log(`[${asset}] ${tick.quote} → Last 5: ${this.tickHistories[asset].slice(-5).join(', ')}`);

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            console.log(`⏳ [${asset}] Buffering... (${this.tickHistories[asset].length}/${this.config.requiredHistoryLength})`);
            return;
        }

        if (!this.tradeInProgress) {
            // Analyze ticks
            this.analyzeTicks(asset);
        }
    }

    // ========= 🎯 CORE LOGIC: ADAPTIVE MEAN-REVERSION DIGIT SELECTOR =========
    analyzeTicks(asset) {
        if (this.tradeInProgress) return;

        const history = this.tickHistories[asset];
        if (history.length < 100) return;

        if (this.suspendedAssets.has(asset)) return;

        // Get analysis
        const analysis = this.analyzer.analyze(this.tickHistories[asset]);

        // console.log(`[${asset}] Analyzed: ${analysis.predictedDigit} | ${analysis.confidence.toFixed(2)}% | ${analysis.repetitionRate.toFixed(2)}% | ${analysis.streak.toFixed(2)}% | ${analysis.streakDirection}| ${analysis.streakDirection}`);
        console.log(`[${asset}] Analyzed: ${analysis.predictedDigit} | ${analysis.confidence.toFixed(2)}%`);

        if (!analysis.shouldTrade) return null;

        // Additional check: Don't trade same digit consecutively
        if (analysis.predictedDigit === this.lastPredictedDigit) {
            return null;
        }

        this.lastPredictedDigit = analysis.predictedDigit;
        this.lastConfidence = analysis.confidence;

        if (this.excludedDigits.includes(analysis.predictedDigit)) {
            return null;
        }

        this.placeTrade(asset, analysis.predictedDigit, analysis.confidence);
    }


    placeTrade(asset, predictedDigit, confidence) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.xDigit = predictedDigit;

        console.log(`🚀 [${asset}] Placing trade → Digit: ${predictedDigit} | Confidence: ${confidence.toFixed(2)}% | Stake: $${this.currentStake}`);
        const request = {
            buy: 1,
            price: this.currentStake,
            parameters: {
                amount: this.currentStake,
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: asset,
                barrier: predictedDigit.toString(),
            }
        };
        this.sendRequest(request);
    }

    subscribeToOpenContract(contractId) {
        const request = {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        };
        this.sendRequest(request);
    }

    handleContractUpdate(contract) {
        if (contract.is_sold) {
            this.handleTradeResult(contract);
        }
    }

    handleTradeResult(contract) {
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        console.log(`[${asset}] Trade outcome: ${won ? '✅ WON' : '❌ LOST'}`);

        this.totalTrades++;

        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
            this.excludedDigits = [];
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;
            this.excludedDigits.push(this.xDigit);

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
        }

        this.totalProfitLoss += profit;
        this.todayPnL += profit;
        this.Pause = true;

        const randomWaitTime = Math.floor(Math.random() * (this.config.maxWaitTime - this.config.minWaitTime + 1)) + this.config.minWaitTime;
        const waitTimeMinutes = Math.round(randomWaitTime / 60000);

        this.waitTime = waitTimeMinutes;
        this.waitSeconds = randomWaitTime;

        if (!this.endOfDay) {
            this.logTradingSummary(asset);
        }

        if (!won) {
            this.sendLossEmail(asset);
            // Suspend the asset after a trade
            this.suspendAsset(asset);
        }

        // If there are suspended assets, reactivate the first one on win
        if (won) {
            if (this.suspendedAssets.size > 1) {
                const firstSuspendedAsset = Array.from(this.suspendedAssets)[0];
                this.reactivateAsset(firstSuspendedAsset);
            }
        }

        // Suspend the asset after a trade
        // this.suspendAsset(asset);

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('Stop condition reached. Stopping trading.');
            this.endOfDay = true;
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take Profit Reached... Stopping trading.');
            this.endOfDay = true;
            this.sendEmailSummary();
            this.disconnect();
            return;
        }

        // this.unsubscribeAllTicks();
        this.disconnect();

        if (!this.endOfDay) {
            setTimeout(() => {
                this.tradeInProgress = false;
                this.Pause = false;
                this.connect();
            }, randomWaitTime);
        }
    }

    // Add new method to handle asset suspension
    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
        console.log(`🚫 Suspended asset: ${asset}`);
    }

    // Add new method to reactivate asset
    reactivateAsset(asset) {
        this.suspendedAssets.delete(asset);
        console.log(`✅ Reactivated asset: ${asset}`);
    }

    unsubscribeAllTicks() {
        Object.values(this.tickSubscriptionIds).forEach(subId => {
            const request = {
                forget: subId
            };
            this.sendRequest(request);
            // console.log(`Unsubscribing from ticks with ID: ${subId}`);
        });
        this.tickSubscriptionIds = {};
    }

    unsubscribeFromTicks(asset) {
        const subId = this.tickSubscriptionIds[asset];
        if (subId) {
            const request = {
                forget: subId
            };
            this.sendRequest(request);
            // console.log(`Unsubscribing from ticks for asset: ${asset}`);
            delete this.tickSubscriptionIds[asset];
        }
    }

    // Check for Disconnect and Reconnect
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            // Always use GMT +1 time regardless of server location
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000)); // Convert UTC → GMT+1
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Optional: log current GMT+1 time for monitoring
            // console.log(
            // "Current GMT+1 time:",
            // gmtPlus1Time.toISOString().replace("T", " ").substring(0, 19)
            // );

            // Check for Morning resume condition (7:00 AM GMT+1)
            if (this.endOfDay && currentHours === 7 && currentMinutes >= 0) {
                console.log("It's 7:00 AM GMT+1, reconnecting the bot.");
                this.LossDigitsList = [];
                this.tradeInProgress = false;
                this.usedAssets = new Set();
                this.RestartTrading = true;
                this.Pause = false;
                this.endOfDay = false;
                this.connect();
            }

            // Check for evening stop condition (after 5:00 PM GMT+1)
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 5000); // Check every 5 seconds
    }


    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    logTradingSummary(asset) {
        console.log('Trading Summary:');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Trades Won: ${this.totalWins}`);
        console.log(`Total Trades Lost: ${this.totalLosses}`);
        console.log(`x2 Losses: ${this.consecutiveLosses2}`);
        console.log(`x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`x4 Losses: ${this.consecutiveLosses4}`);
        console.log(`x5 Losses: ${this.consecutiveLosses5}`);
        console.log(`Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`[${asset}] Predicted Digit: ${this.lastPredictedDigit} (${this.lastConfidence.toFixed(2)}%)`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`Currently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log(`Waiting for: ${this.waitTime} minutes (${this.waitSeconds} ms) before resubscribing...`);
    }

    startEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendEmailSummary();
            }
        }, 1800000); // 30 Minutes
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const summaryText = `
        Trading Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}

        Currently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}

        Current Stake: $${this.currentStake.toFixed(2)}
        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2Bot2b - Summary',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    async sendLossEmail(asset) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const history = this.tickHistories[asset];
        const lastFewTicks = history.slice(-10);

        const summaryText = `
        Trade Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}

        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%

        Last Digit Analysis:
        Asset: ${asset}
        predicted Digit: ${this.lastPredictedDigit} (${this.lastConfidence.toFixed(2)}%) 
      
        Last 10 Digits: ${lastFewTicks.join(', ')} 

        Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}
        Excluded Digits: ${this.excludedDigits.join(', ')}

        Current Stake: $${this.currentStake.toFixed(2)}

        Waiting for: ${this.waitTime} minutes before next trade...
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2Bot2b - Loss Alert',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Loss email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending loss email:', error);
        }
    }

    async sendDisconnectResumptionEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const now = new Date();
        const currentHours = now.getHours();
        const currentMinutes = now.getMinutes();

        const summaryText = `
        Disconnect/Reconnect Email: Time (${currentHours}:${currentMinutes})

        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}

        Currently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}

        Current Stake: $${this.currentStake.toFixed(2)}
        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2Bot2b - Connection/Dissconnection Summary',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2Bot2b - Error Report',
            text: `An error occurred: ${errorMessage}`
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Error email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending error email:', error);
        }
    }

    start() {
        this.connect();
        // this.checkTimeForDisconnectReconnect();
    }
}

// Usage
const bot = new EnhancedDigitDifferTradingBot('Dz2V2KvRf4Uukt3', {
    initialStake: 0.61,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 86,
    takeProfit: 5000,
    requiredHistoryLength: 5000,
    winProbabilityThreshold: 0.6,
    minWaitTime: 2000, //5 Minutes
    maxWaitTime: 5000, //1 Hour
    // Analysis Thresholds - CRITICAL for trade decisions
    ANALYSIS: {
        minHistoryLength: 5000,       // Minimum ticks before trading
        minConfidence: 0.92,          // Minimum confidence to trade (92%)
        maxRepetitionRate: 0.10,      // Max acceptable repetition rate (10%)
        recentRepetitionRate: 0.08,     // Maximum recent repetition rate (8%)
        selfRepetitionRate: 0.08,     // Maximum self-repetition rate (8%)
        minNonRepStreak: 6,           // Minimum consecutive non-repetitions
        minSampleSize: 500,           // Minimum samples for digit analysis 
    },
});

bot.start();

