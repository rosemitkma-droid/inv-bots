const WebSocket = require('ws');
const nodemailer = require('nodemailer');


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
            if (confidence > this.config.maxConfidence) {
                return `Confidence too High: ${(confidence * 100).toFixed(1)}% > ${(this.config.maxConfidence * 100).toFixed(1)}%`;
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


// EnhancedDerivTradingBot class with Advanced Pattern Recognition
class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            // 'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR', '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V', 'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            'R_25'
        ];

        this.config = {
            initialStake: config.initialStake,
            multiplier: config.multiplier,
            maxConsecutiveLosses: config.maxConsecutiveLosses,
            takeProfit: config.takeProfit,
            // Analysis Thresholds - CRITICAL for trade decisions
            ANALYSIS: {
                minHistoryLength: config.ANALYSIS.minHistoryLength || 5000,       // Minimum ticks before trading
                minConfidence: config.ANALYSIS.minConfidence || 0.2,          // Minimum confidence to trade (92%)
                minConfidence: config.ANALYSIS.maxConfidence || 0.2,          // Maximum confidence to trade (92%)
                maxRepetitionRate: config.ANALYSIS.maxRepetitionRate || 0.02,      // Max acceptable repetition rate (10%)
                recentRepetitionRate: config.ANALYSIS.recentRepetitionRate || 0.02,     // Maximum recent repetition rate (8%)
                selfRepetitionRate: config.ANALYSIS.selfRepetitionRate || 0.02,     // Maximum self-repetition rate (8%)
                minNonRepStreak: config.ANALYSIS.minNonRepStreak || 6,           // Minimum consecutive non-repetitions
                minSampleSize: config.ANALYSIS.minSampleSize || 500,           // Minimum samples for digit analysis 
            },
        };

        // Initialize existing properties
        this.currentStake = this.config.initialStake;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.currentAsset = null;
        this.currentTradeId = null;
        this.lastDigitsList = [];
        this.tickHistory = [];
        this.tradeInProgress = false;
        this.wsReady = false;
        this.predictedDigit = null;
        this.Percentage = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.Pause = false;
        this.RestartTrading = true;
        this.endOfDay = false;
        this.requiredHistoryLength = 5000; // Increased for better pattern analysis
        this.kCount = false;
        this.kCountNum = 0;
        this.kLoss = 0;
        this.multiplier2 = false;
        this.confidenceThreshold = null;
        this.kTradeCount = 0;
        this.isWinTrade = true;
        this.waitTime = 0;
        this.LossDigitsList = [];
        this.threeConsecutiveDigits = 0;
        this.kTrade = false;
        this.xDigit = null;
        this.excludedDigits = [];

        // Analyzer instance
        this.analyzer = new StatisticalAnalyzer(this.config.ANALYSIS);

        // WebSocket management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10000;
        this.reconnectInterval = 5000;
        this.tickSubscriptionId = null;

        // Email configuration
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };
        this.emailRecipient = 'kenotaru@gmail.com';
        this.startEmailTimer();
    }

    connect() {
        if (!this.endOfDay) {
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
            setTimeout(() => this.sendRequest(request), this.reconnectInterval);
        } else {
            console.error('Not connected to Deriv API. Unable to send request:', request);
        }
    }

    handleDisconnect() {
        if (!this.endOfDay) {
            this.connected = false;
            this.wsReady = false;
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
                setTimeout(() => this.connect(), this.reconnectInterval);
            }

            this.tradeInProgress = false;
            this.lastDigitsList = [];
            this.tickHistory = [];
        }
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
                setTimeout(() => this.startTrading(), 60000);
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.startTrading(), 3600000);
                break;
            default:
                console.log('Encountered an error. Continuing operation...');
                this.startTrading();
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
            count: this.requiredHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        };
        this.sendRequest(request);
        console.log(`Requested tick history for asset: ${asset}`);
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
            this.lastDigitsList = [];
            this.tickHistory = [];

            this.startTrading();

        } else if (message.msg_type === 'history') {
            this.handleTickHistory(message.history);
        } else if (message.msg_type === 'tick') {
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
            console.log('Successfully unsubscribed from ticks');
            this.tickSubscriptionId = null;
        } else if (message.subscription && message.msg_type === 'tick') {
            this.tickSubscriptionId = message.subscription.id;
            console.log(`Subscribed to ticks. Subscription ID: ${this.tickSubscriptionId}`);
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

    startTrading() {
        console.log('Starting trading...');
        this.tradeNextAsset();
    }

    tradeNextAsset() {
        if (this.usedAssets.size === this.assets.length) {
            this.usedAssets = new Set();
        }

        // if (this.RestartTrading) {
        let availableAssets = this.assets.filter(asset => !this.usedAssets.has(asset));
        this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
        this.usedAssets.add(this.currentAsset);
        // }
        console.log(`Selected asset: ${this.currentAsset}`);

        this.unsubscribeFromTicks(() => {
            this.subscribeToTickHistory(this.currentAsset);
            this.subscribeToTicks(this.currentAsset);
        });

        this.RestartTrading = false;
    }

    handleTickHistory(history) {
        this.tickHistory = history.prices.map(price => this.getLastDigit(price, this.currentAsset));

    }

    handleTickUpdate(tick) {
        const lastDigit = this.getLastDigit(tick.quote, this.currentAsset);
        this.lastDigitsList.push(lastDigit);

        // Update tick history
        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.requiredHistoryLength) {
            this.tickHistory.shift();
        }

        console.log(`Recent tick History: ${this.tickHistory.slice(-5).join(', ')}`);

        // Enhanced logging
        if (!this.tradeInProgress) {
            this.analyzeTicksEnhanced();
        }
    }

    analyzeTicksEnhanced() {
        if (this.tradeInProgress) {
            return;
        }

        // Get analysis
        const analysis = this.analyzer.analyze(this.tickHistory);

        console.log(`Analyzed: ${analysis.predictedDigit} | ${analysis.confidence.toFixed(2)}% (${analysis.shouldTrade})`);
        console.log(`Reason: ${analysis.reason}`);

        if (!analysis.shouldTrade) return null;

        // Additional check: Don't trade same digit consecutively
        // if (analysis.predictedDigit === this.xDigit) {
        //     return null;
        // }


        // if (this.excludedDigits.includes(analysis.predictedDigit)) {
        //     return null;
        // }

        const confidence = analysis.confidence.toFixed(2);

        this.xDigit = analysis.predictedDigit;
        this.winProbNumber = confidence;

        this.placeTrade(this.xDigit, this.winProbNumber);
    }


    placeTrade(predictedDigit, confidence) {
        if (this.tradeInProgress) {
            return;
        }

        this.tradeInProgress = true;

        console.log(`\n PLACING TRADE`);
        console.log(`Digit: ${predictedDigit} (${confidence}%)`);
        console.log(`Stake: $${this.currentStake.toFixed(2)}`);

        const request = {
            buy: 1,
            price: this.currentStake.toFixed(2),
            parameters: {
                amount: this.currentStake.toFixed(2),
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: this.currentAsset,
                barrier: predictedDigit
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
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        console.log(`\n📊 TRADE RESULT: ${won ? '✅ WON' : '❌ LOST'}`);
        console.log(`Profit/Loss: $${profit.toFixed(2)}`);

        this.totalTrades++;

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
            this.excludedDigits = [];
        } else {
            this.isWinTrade = false;
            this.totalLosses++;
            this.consecutiveLosses++;
            this.excludedDigits.push(this.xDigit);

            if (this.consecutiveLosses === 2) {
                this.consecutiveLosses2++;
            } else if (this.consecutiveLosses === 3) {
                this.consecutiveLosses3++;
            } else if (this.consecutiveLosses === 4) {
                this.consecutiveLosses4++;
            } else if (this.consecutiveLosses === 5) {
                this.consecutiveLosses5++;
            }

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;

            // this.RestartTrading = true; 
        }

        this.totalProfitLoss += profit;

        if (!won) {
            this.sendLossEmail();
        }

        this.Pause = true;

        this.RestartTrading = true;

        if (!this.endOfDay) {
            this.logTradingSummary();
        }

        // Take profit condition
        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take Profit Reached... Stopping trading.');
            this.endOfDay = true;
            this.sendDisconnectResumptionEmailSummary();
            this.disconnect();
            return;
        }

        // Check stopping conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('Stopping condition met. Disconnecting...');
            this.endOfDay = true;
            this.sendDisconnectResumptionEmailSummary();
            this.disconnect();
            return;
        }

        this.disconnect();

        if (!this.endOfDay) {
            this.waitTime = Math.floor(Math.random() * (5000 - 1000 + 1)) + 1000;
            console.log(`⏳ Waiting ${Math.round(this.waitTime / 1000)} seconds before next trade...\n`);
            setTimeout(() => {
                this.Pause = false;
                this.kTrade = false;
                this.connect();
            }, this.waitTime);
        }
    }

    unsubscribeFromTicks(callback) {
        if (this.tickSubscriptionId) {
            const request = {
                forget: this.tickSubscriptionId
            };
            this.sendRequest(request);
            console.log(`Unsubscribing from ticks with ID: ${this.tickSubscriptionId}`);

            this.ws.once('message', (data) => {
                const message = JSON.parse(data);
                if (message.msg_type === 'forget' && message.forget === this.tickSubscriptionId) {
                    console.log(`Unsubscribed from ticks successfully`);
                    this.tickSubscriptionId = null;
                    if (callback) callback();
                }
            });
        } else {
            if (callback) callback();
        }
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            // Always use GMT +1 time regardless of server location
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000)); // Convert UTC → GMT+1
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();
            const currentDay = gmtPlus1Time.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

            // Optional: log current GMT+1 time for monitoring
            // console.log(
            // "Current GMT+1 time:",
            // gmtPlus1Time.toISOString().replace("T", " ").substring(0, 19)
            // );

            // Check if it's Sunday - no trading on Sundays
            if (currentDay === 0) {
                if (!this.endOfDay) {
                    console.log("It's Sunday, disconnecting the bot. No trading on Sundays.");
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
                return; // Skip all other checks on Sunday
            }

            // Check for Morning resume condition (7:00 AM GMT+1) - but not on Sunday
            if (this.endOfDay && currentHours === 7 && currentMinutes >= 0) {
                console.log("It's 7:00 AM GMT+1, reconnecting the bot.");
                this.LossDigitsList = [];
                this.tradeInProgress = false;
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

    logTradingSummary() {
        console.log('\n📈 TRADING SUMMARY 📈');
        console.log('═══════════════════════════════════════');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Won: ${this.totalWins} | Lost: ${this.totalLosses}`);
        console.log(`Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%`);
        console.log(`Consecutive Losses: x2:${this.consecutiveLosses2} x3:${this.consecutiveLosses3} x4:${this.consecutiveLosses4}`);
        console.log(`Total P/L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log('Predicted Digit:', this.xDigit);
        console.log('Percentage:', this.winProbNumber), '%';
        console.log('═══════════════════════════════════════\n');
    }

    startEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendEmailSummary();
            }
        }, 1800000); // 30 minutes
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const summaryText = `
        ENHANCED TRADING BOT SUMMARY
        ============================
        
        Performance Metrics:
        -------------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        
        Loss Analysis:
        -------------
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}
        
        Financial Summary:
        -----------------
        Total P/L: $${this.totalProfitLoss.toFixed(2)}
        Current Stake: $${this.currentStake.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2Bot Differ Bot - Trading Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Email sending error:', error);
        }
    }

    async sendLossEmail() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const klastDigits = this.tickHistory.slice(-20);

        const summaryText = `
        LOSS ALERT - DETAILED ANALYSIS
        ===============================
        
        Trade Result: LOSS
        
        Performance Metrics:
        -------------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        Total P/L: $${this.totalProfitLoss.toFixed(2)}
        
        x2:${this.consecutiveLosses2} 
        x3:${this.consecutiveLosses3} 
        x4:${this.consecutiveLosses4}        
        
        Pattern Analysis:
        ----------------
        Asset: ${this.currentAsset}
        Predicted Digit: ${this.xDigit}
        Percentage: ${this.winProbNumber}%
        Chaos Level: ${this.chaosLevel}
        Chaos Details: ${this.kChaos} (${this.regimCount})
        
        Recent History:
        --------------
        Last 20 Digits: ${klastDigits.join(', ')}
        
        Current Stake: $${this.currentStake.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2Bot Deriv Bot - Loss Alert',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Email sending error:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2Bot Deriv Bot - Error Report',
            text: `An error occurred in the trading bot: ${errorMessage}`
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Error sending error email:', error);
        }
    }

    async sendDisconnectResumptionEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const now = new Date();
        const currentHours = now.getHours();
        const currentMinutes = now.getMinutes();

        const summaryText = `
        BOT STATUS UPDATE
        =================
        Time: ${currentHours}:${currentMinutes.toString().padStart(2, '0')}
        Status: ${this.endOfDay ? 'Day Trading Complete' : 'Session Update'}
        
        Final Performance:
        -----------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
       
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        
        Financial Summary:
        -----------------
        Total P/L: $${this.totalProfitLoss.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2Bot Deriv Bot - Status Update',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Email sending error:', error);
        }
    }

    start() {
        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// Usage
const bot = new EnhancedDerivTradingBot('Dz2V2KvRf4Uukt3', {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir', 'Dz2V2KvRf4Uukt3'
    initialStake: 0.61,
    multiplier: 11.3,
    maxStake: 127,
    maxConsecutiveLosses: 3,
    stopLoss: 127,
    takeProfit: 2.5,
    // Analysis Thresholds - CRITICAL for trade decisions
    ANALYSIS: {
        minHistoryLength: 5000,       // Minimum ticks before trading
        minConfidence: 0.6,          // Minimum confidence to trade (92%)
        maxConfidence: 0.7,          // Maximum confidence to trade (92%)
        maxRepetitionRate: 0.4,      // Max acceptable repetition rate (10%)
        recentRepetitionRate: 0.02,     // Maximum recent repetition rate (8%)
        selfRepetitionRate: 0.10,     // Maximum self-repetition rate (8%)
        minNonRepStreak: 6,           // Minimum consecutive non-repetitions
        minSampleSize: 500,           // Minimum samples for digit analysis 
    },
});

bot.start();
