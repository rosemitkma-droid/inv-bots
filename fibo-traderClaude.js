require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ============================================
// FIBONACCI DIGIT ANALYZER - ADVANCED ENGINE
// ============================================
class FibonacciDigitAnalyzer {
    constructor() {
        // Core Fibonacci sequence (first 30 numbers)
        this.fibSequence = this.generateFibonacci(30);

        // Fibonacci digits (single digits that appear in Fibonacci sequence)
        this.fibDigits = new Set([0, 1, 2, 3, 5, 8]);
        this.nonFibDigits = new Set([4, 6, 7, 9]);

        // Golden ratio and derivatives
        this.PHI = (1 + Math.sqrt(5)) / 2;           // ~1.6180339887
        this.PHI_INVERSE = 1 / this.PHI;              // ~0.6180339887
        this.PHI_SQUARED = this.PHI * this.PHI;       // ~2.6180339887
        this.PSI = (1 - Math.sqrt(5)) / 2;            // ~-0.6180339887

        // Fibonacci retracement levels
        this.FIB_LEVELS = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.272, 1.618];

        // Fibonacci analysis periods
        this.FIB_PERIODS = [3, 5, 8, 13, 21, 34, 55, 89, 144];

        // Pisano period for base 10 (last digits of Fibonacci repeat every 60)
        this.PISANO_PERIOD = 60;
        this.pisanoSequence = this.generatePisanoSequence();

        // Lucas numbers (related to Fibonacci)
        this.lucasNumbers = this.generateLucas(20);

        // Tribonacci sequence (Fibonacci variant)
        this.tribonacciSequence = this.generateTribonacci(20);

        // Analysis weights based on golden ratio
        this.methodWeights = {
            frequencyAnalysis: this.PHI_INVERSE,           // 0.618
            gapAnalysis: this.PHI_INVERSE * 0.618,         // 0.382
            pisanoPattern: 0.236,                           // Fibonacci level
            momentumScore: this.PHI_INVERSE * 0.382,       // 0.236
            clusterAnalysis: 0.5,                           // Midpoint
            cyclicalPattern: this.PHI_INVERSE * 0.5,       // 0.309
            lucasCorrelation: 0.236,                        // Fibonacci level
            entropyScore: this.PHI_INVERSE * 0.618         // 0.382
        };

        // Normalize weights to sum to 1
        const totalWeight = Object.values(this.methodWeights).reduce((a, b) => a + b, 0);
        Object.keys(this.methodWeights).forEach(key => {
            this.methodWeights[key] /= totalWeight;
        });

        console.log('🔢 Fibonacci Analyzer initialized with Golden Ratio weights');
    }

    // Generate Fibonacci sequence
    generateFibonacci(n) {
        const fib = [0, 1];
        for (let i = 2; i < n; i++) {
            fib.push(fib[i - 1] + fib[i - 2]);
        }
        return fib;
    }

    // Generate Pisano sequence (last digits of Fibonacci mod 10)
    generatePisanoSequence() {
        const seq = [0, 1];
        for (let i = 2; i < this.PISANO_PERIOD; i++) {
            seq.push((seq[i - 1] + seq[i - 2]) % 10);
        }
        return seq;
    }

    // Generate Lucas numbers
    generateLucas(n) {
        const lucas = [2, 1];
        for (let i = 2; i < n; i++) {
            lucas.push(lucas[i - 1] + lucas[i - 2]);
        }
        return lucas;
    }

    // Generate Tribonacci sequence
    generateTribonacci(n) {
        const tri = [0, 0, 1];
        for (let i = 3; i < n; i++) {
            tri.push(tri[i - 1] + tri[i - 2] + tri[i - 3]);
        }
        return tri;
    }

    // ========================================
    // CORE ANALYSIS METHODS
    // ========================================

    /**
     * METHOD 1: Fibonacci-Weighted Frequency Analysis
     * Analyzes digit frequencies over Fibonacci periods with golden ratio weighting
     */
    fibonacciFrequencyAnalysis(history) {
        const scores = Array(10).fill(0);

        for (const period of this.FIB_PERIODS) {
            if (history.length < period) continue;

            const recentHistory = history.slice(-period);
            const frequency = Array(10).fill(0);

            // Count frequencies with Fibonacci position weighting
            recentHistory.forEach((digit, idx) => {
                // Weight increases as we approach recent data (golden ratio decay)
                const weight = Math.pow(this.PHI_INVERSE, (period - idx - 1) / period);
                frequency[digit] += weight;
            });

            // Normalize and invert (high frequency = low score for appearing again)
            const maxFreq = Math.max(...frequency);
            const minFreq = Math.min(...frequency.filter(f => f > 0));

            frequency.forEach((freq, digit) => {
                if (maxFreq > 0) {
                    // Apply Fibonacci retracement levels for scoring
                    const normalizedFreq = (freq - minFreq) / (maxFreq - minFreq + 0.001);
                    const fibLevel = this.nearestFibLevel(normalizedFreq);

                    // Higher frequency = higher score for DIFFER (less likely to appear)
                    scores[digit] += normalizedFreq * (1 / period) * this.PHI_INVERSE;
                }
            });
        }

        return this.normalizeScores(scores);
    }

    /**
     * METHOD 2: Fibonacci Gap Analysis
     * Analyzes gaps between digit occurrences using Fibonacci numbers
     */
    fibonacciGapAnalysis(history) {
        const scores = Array(10).fill(0);
        const gaps = this.calculateDigitGaps(history);

        gaps.forEach((gap, digit) => {
            // Check if gap is close to a Fibonacci number
            const nearestFib = this.nearestFibonacci(gap);
            const fibDistance = Math.abs(gap - nearestFib);

            // If gap is near a Fibonacci number, digit might be "due"
            // For DIFFER, we want digits that just appeared (low gap)
            const fibScore = 1 / (1 + fibDistance * this.PHI_INVERSE);

            // Golden ratio based scoring
            if (gap <= 2) {
                // Recently appeared - HIGH score for DIFFER (unlikely to repeat)
                scores[digit] = this.PHI;
            } else if (gap <= 5) {
                // Medium gap - moderate score
                scores[digit] = 1.0;
            } else if (gap <= 8) {
                // Approaching Fibonacci threshold
                scores[digit] = this.PHI_INVERSE;
            } else {
                // Long gap - digit might be due, LOW score for DIFFER
                scores[digit] = this.PHI_INVERSE * this.PHI_INVERSE;
            }

            // Fibonacci resonance bonus
            if (this.isFibonacci(gap)) {
                scores[digit] *= (1 + this.PHI_INVERSE * 0.5);
            }
        });

        return this.normalizeScores(scores);
    }

    /**
     * METHOD 3: Pisano Period Pattern Analysis
     * Uses the 60-cycle pattern of Fibonacci last digits
     */
    pisanoPatternAnalysis(history) {
        const scores = Array(10).fill(0);
        if (history.length < 60) return scores;

        // Find position in Pisano cycle based on recent patterns
        const recentDigits = history.slice(-10);
        let bestMatch = 0;
        let bestMatchScore = 0;

        // Compare recent sequence with Pisano sequence at different offsets
        for (let offset = 0; offset < this.PISANO_PERIOD; offset++) {
            let matchScore = 0;
            for (let i = 0; i < Math.min(recentDigits.length, 10); i++) {
                const pisanoIdx = (offset + i) % this.PISANO_PERIOD;
                if (recentDigits[i] === this.pisanoSequence[pisanoIdx]) {
                    matchScore += Math.pow(this.PHI_INVERSE, recentDigits.length - i - 1);
                }
            }
            if (matchScore > bestMatchScore) {
                bestMatchScore = matchScore;
                bestMatch = offset;
            }
        }

        // Predict next digit based on Pisano pattern
        const predictedPisanoDigit = this.pisanoSequence[(bestMatch + recentDigits.length) % this.PISANO_PERIOD];

        // For DIFFER, score the predicted digit highest (least likely to match prediction)
        for (let digit = 0; digit < 10; digit++) {
            if (digit === predictedPisanoDigit) {
                scores[digit] = this.PHI; // Best for DIFFER
            } else {
                // Distance from predicted digit affects score
                const distance = Math.min(
                    Math.abs(digit - predictedPisanoDigit),
                    10 - Math.abs(digit - predictedPisanoDigit)
                );
                scores[digit] = this.PHI_INVERSE / (1 + distance * 0.1);
            }
        }

        return this.normalizeScores(scores);
    }

    /**
     * METHOD 4: Fibonacci Momentum Score
     * Calculates momentum using Fibonacci-weighted moving averages
     */
    fibonacciMomentumScore(history) {
        const scores = Array(10).fill(0);
        if (history.length < 34) return scores;

        // Calculate Fibonacci moving averages for each digit
        const fmaShort = this.fibonacciMovingAverage(history, 8);
        const fmaMedium = this.fibonacciMovingAverage(history, 21);
        const fmaLong = this.fibonacciMovingAverage(history, 55);

        for (let digit = 0; digit < 10; digit++) {
            // Momentum based on FMA crossovers
            const shortTrend = fmaShort[digit] - fmaMedium[digit];
            const longTrend = fmaMedium[digit] - fmaLong[digit];

            // Positive momentum = digit appearing more frequently
            // For DIFFER, we want high momentum digits (less likely to break streak)
            const momentum = shortTrend * this.PHI + longTrend;

            scores[digit] = Math.max(0, 0.5 + momentum);
        }

        return this.normalizeScores(scores);
    }

    /**
     * METHOD 5: Fibonacci Cluster Analysis
     * Detects digit clusters using Fibonacci thresholds
     */
    fibonacciClusterAnalysis(history) {
        const scores = Array(10).fill(0);
        if (history.length < 21) return scores;

        const recent = history.slice(-21); // Last 21 ticks (Fibonacci number)

        // Find clusters (consecutive or near-consecutive appearances)
        for (let digit = 0; digit < 10; digit++) {
            let maxClusterSize = 0;
            let currentCluster = 0;
            let lastPosition = -999;

            recent.forEach((d, idx) => {
                if (d === digit) {
                    if (idx - lastPosition <= 3) { // Within Fibonacci gap of 3
                        currentCluster++;
                    } else {
                        currentCluster = 1;
                    }
                    lastPosition = idx;
                    maxClusterSize = Math.max(maxClusterSize, currentCluster);
                }
            });

            // Larger clusters = digit is "hot" = good for DIFFER
            if (maxClusterSize >= 5) {
                scores[digit] = this.PHI_SQUARED;
            } else if (maxClusterSize >= 3) {
                scores[digit] = this.PHI;
            } else if (maxClusterSize >= 2) {
                scores[digit] = 1;
            } else {
                scores[digit] = this.PHI_INVERSE;
            }
        }

        return this.normalizeScores(scores);
    }

    /**
     * METHOD 6: Fibonacci Cyclical Pattern Detection
     * Detects repeating patterns at Fibonacci intervals
     */
    fibonacciCyclicalPattern(history) {
        const scores = Array(10).fill(0);
        if (history.length < 89) return scores;

        const recent = history.slice(-89);

        // Check for patterns at Fibonacci intervals
        for (const period of [3, 5, 8, 13, 21, 34]) {
            if (recent.length < period * 2) continue;

            const patterns = {};
            for (let i = 0; i <= recent.length - period; i++) {
                const pattern = recent.slice(i, i + period).join('');
                patterns[pattern] = (patterns[pattern] || 0) + 1;
            }

            // Find dominant patterns
            const patternFreqs = Object.entries(patterns).sort((a, b) => b[1] - a[1]);

            if (patternFreqs.length > 0 && patternFreqs[0][1] >= 2) {
                // Strong pattern detected
                const dominantPattern = patternFreqs[0][0];
                const lastDigitOfPattern = parseInt(dominantPattern[dominantPattern.length - 1]);

                // Score based on pattern strength
                scores[lastDigitOfPattern] += patternFreqs[0][1] * this.PHI_INVERSE / period;
            }
        }

        return this.normalizeScores(scores);
    }

    /**
     * METHOD 7: Lucas Number Correlation
     * Correlates digit patterns with Lucas numbers
     */
    lucasCorrelation(history) {
        const scores = Array(10).fill(0);
        if (history.length < 21) return scores;

        const lucasDigits = this.lucasNumbers.map(n => n % 10);
        const recent = history.slice(-21);

        // Check correlation with Lucas sequence
        for (let digit = 0; digit < 10; digit++) {
            const positions = [];
            recent.forEach((d, idx) => {
                if (d === digit) positions.push(idx);
            });

            // Check if positions correlate with Lucas numbers
            let correlation = 0;
            positions.forEach(pos => {
                if (lucasDigits.includes(pos % 10)) {
                    correlation += this.PHI_INVERSE;
                }
            });

            scores[digit] = correlation;
        }

        return this.normalizeScores(scores);
    }

    /**
     * METHOD 8: Fibonacci Entropy Score
     * Measures predictability using Fibonacci-weighted entropy
     */
    fibonacciEntropyScore(history) {
        const scores = Array(10).fill(0);
        if (history.length < 55) return scores;

        // Calculate entropy over different Fibonacci windows
        for (const window of [8, 13, 21, 34, 55]) {
            if (history.length < window) continue;

            const slice = history.slice(-window);
            const freq = Array(10).fill(0);
            slice.forEach(d => freq[d]++);

            // Calculate entropy for this window
            let entropy = 0;
            freq.forEach(f => {
                if (f > 0) {
                    const p = f / window;
                    entropy -= p * Math.log2(p);
                }
            });

            // Max entropy for 10 outcomes is log2(10) ≈ 3.32
            const normalizedEntropy = entropy / 3.32;

            // For each digit, score based on its deviation from expected
            const expected = window / 10;
            freq.forEach((f, digit) => {
                const deviation = (f - expected) / expected;
                // High positive deviation = overrepresented = good for DIFFER
                scores[digit] += deviation * this.PHI_INVERSE * (1 / window);
            });
        }

        return this.normalizeScores(scores);
    }

    // ========================================
    // UTILITY METHODS
    // ========================================

    calculateDigitGaps(history) {
        const gaps = Array(10).fill(history.length);
        for (let i = history.length - 1; i >= 0; i--) {
            const digit = history[i];
            if (gaps[digit] === history.length) {
                gaps[digit] = history.length - 1 - i;
            }
        }
        return gaps;
    }

    nearestFibonacci(n) {
        let closest = this.fibSequence[0];
        for (const fib of this.fibSequence) {
            if (Math.abs(fib - n) < Math.abs(closest - n)) {
                closest = fib;
            }
        }
        return closest;
    }

    isFibonacci(n) {
        return this.fibSequence.includes(n);
    }

    nearestFibLevel(value) {
        let closest = this.FIB_LEVELS[0];
        for (const level of this.FIB_LEVELS) {
            if (Math.abs(level - value) < Math.abs(closest - value)) {
                closest = level;
            }
        }
        return closest;
    }

    fibonacciMovingAverage(history, period) {
        const fma = Array(10).fill(0);
        if (history.length < period) return fma;

        const slice = history.slice(-period);
        let totalWeight = 0;

        slice.forEach((digit, idx) => {
            // Fibonacci weighting: more recent = higher weight
            const weight = Math.pow(this.PHI_INVERSE, (period - idx - 1) / 5);
            fma[digit] += weight;
            totalWeight += weight;
        });

        // Normalize
        fma.forEach((val, idx) => {
            fma[idx] = val / totalWeight;
        });

        return fma;
    }

    normalizeScores(scores) {
        const max = Math.max(...scores);
        const min = Math.min(...scores);
        const range = max - min;

        if (range === 0) return scores.map(() => 1);

        return scores.map(s => (s - min) / range);
    }

    // ========================================
    // MAIN PREDICTION METHOD
    // ========================================

    /**
     * Combines all Fibonacci methods to find the digit most unlikely to appear
     * Returns: { digit, confidence, analysis }
     */
    predictUnlikelyDigit(history) {
        if (history.length < 100) {
            return { digit: null, confidence: 0, analysis: 'Insufficient data' };
        }

        // Run all analysis methods
        const analyses = {
            frequencyAnalysis: this.fibonacciFrequencyAnalysis(history),
            gapAnalysis: this.fibonacciGapAnalysis(history),
            pisanoPattern: this.pisanoPatternAnalysis(history),
            momentumScore: this.fibonacciMomentumScore(history),
            clusterAnalysis: this.fibonacciClusterAnalysis(history),
            cyclicalPattern: this.fibonacciCyclicalPattern(history),
            lucasCorrelation: this.lucasCorrelation(history),
            entropyScore: this.fibonacciEntropyScore(history)
        };

        // Combine scores using golden ratio weights
        const combinedScores = Array(10).fill(0);

        Object.keys(analyses).forEach(method => {
            const scores = analyses[method];
            const weight = this.methodWeights[method];

            scores.forEach((score, digit) => {
                combinedScores[digit] += score * weight;
            });
        });

        // Normalize combined scores
        const normalizedScores = this.normalizeScores(combinedScores);

        // Find the digit with highest "unlikely to appear" score
        let bestDigit = 0;
        let bestScore = normalizedScores[0];

        normalizedScores.forEach((score, digit) => {
            if (score > bestScore) {
                bestScore = score;
                bestDigit = digit;
            }
        });

        // Calculate confidence using Fibonacci levels
        const sortedScores = [...normalizedScores].sort((a, b) => b - a);
        const scoreDiff = sortedScores[0] - sortedScores[1];
        const confidenceRaw = scoreDiff * this.PHI;

        // Map to Fibonacci confidence levels
        let confidence;
        if (confidenceRaw >= 0.618) {
            confidence = 'VERY_HIGH';
        } else if (confidenceRaw >= 0.382) {
            confidence = 'HIGH';
        } else if (confidenceRaw >= 0.236) {
            confidence = 'MEDIUM';
        } else {
            confidence = 'LOW';
        }

        // Additional validation using recent history
        const last5 = history.slice(-5);
        const countInLast5 = last5.filter(d => d === bestDigit).length;

        // If predicted digit appeared multiple times recently, boost confidence
        if (countInLast5 >= 3) {
            confidence = 'VERY_HIGH';
        } else if (countInLast5 >= 2 && confidence === 'MEDIUM') {
            confidence = 'HIGH';
        }

        return {
            digit: bestDigit,
            confidence: confidence,
            confidenceScore: confidenceRaw,
            scores: normalizedScores,
            recentCount: countInLast5,
            analysis: {
                frequencyScore: analyses.frequencyAnalysis[bestDigit].toFixed(3),
                gapScore: analyses.gapAnalysis[bestDigit].toFixed(3),
                pisanoScore: analyses.pisanoPattern[bestDigit].toFixed(3),
                momentumScore: analyses.momentumScore[bestDigit].toFixed(3),
                clusterScore: analyses.clusterAnalysis[bestDigit].toFixed(3),
                cyclicalScore: analyses.cyclicalPattern[bestDigit].toFixed(3),
                lucasScore: analyses.lucasCorrelation[bestDigit].toFixed(3),
                entropyScore: analyses.entropyScore[bestDigit].toFixed(3)
            },
            isFibonacciDigit: this.fibDigits.has(bestDigit),
            phi: this.PHI,
            method: 'Fibonacci Ensemble Analysis'
        };
    }

    /**
     * Advanced pattern detection using Fibonacci sequences
     * Returns true if market conditions are favorable for trading
     */
    isFavorableTradingCondition(history) {
        if (history.length < 55) return false;

        const recent = history.slice(-55);

        // Check for Fibonacci-based patterns
        const patterns = {
            // Pattern 1: Digit appeared at Fibonacci intervals
            fibonacciInterval: false,
            // Pattern 2: Strong cluster detected
            clusterPresent: false,
            // Pattern 3: Low entropy (predictable)
            lowEntropy: false,
            // Pattern 4: Pisano alignment
            pisanoAligned: false
        };

        // Check Fibonacci interval pattern
        const lastDigit = recent[recent.length - 1];
        let fibIntervalCount = 0;
        for (const interval of [3, 5, 8, 13, 21]) {
            if (recent.length > interval && recent[recent.length - 1 - interval] === lastDigit) {
                fibIntervalCount++;
            }
        }
        patterns.fibonacciInterval = fibIntervalCount >= 2;

        // Check cluster
        const last8 = recent.slice(-8);
        const digitCounts = Array(10).fill(0);
        last8.forEach(d => digitCounts[d]++);
        patterns.clusterPresent = Math.max(...digitCounts) >= 4;

        // Check entropy
        const freq = Array(10).fill(0);
        recent.forEach(d => freq[d]++);
        let entropy = 0;
        freq.forEach(f => {
            if (f > 0) {
                const p = f / recent.length;
                entropy -= p * Math.log2(p);
            }
        });
        patterns.lowEntropy = entropy < 3.0; // Less than ~90% of max entropy

        // Check Pisano alignment
        const last3 = recent.slice(-3);
        for (let i = 0; i < this.PISANO_PERIOD - 2; i++) {
            if (last3[0] === this.pisanoSequence[i] &&
                last3[1] === this.pisanoSequence[i + 1] &&
                last3[2] === this.pisanoSequence[i + 2]) {
                patterns.pisanoAligned = true;
                break;
            }
        }

        // Require at least 2 favorable patterns
        const favorableCount = Object.values(patterns).filter(v => v).length;
        return favorableCount >= 2;
    }
}

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'fibonacci-differ-state.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                config: {
                    initialStake: bot.config.initialStake,
                    multiplier: bot.config.multiplier,
                    maxConsecutiveLosses: bot.config.maxConsecutiveLosses,
                    stopLoss: bot.config.stopLoss,
                    takeProfit: bot.config.takeProfit,
                    requiredHistoryLength: bot.config.requiredHistoryLength
                },
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    x2Losses: bot.x2Losses,
                    x3Losses: bot.x3Losses,
                    x4Losses: bot.x4Losses,
                    x5Losses: bot.x5Losses,
                    totalProfitLoss: bot.totalProfitLoss,
                    lastPrediction: bot.lastPrediction,
                    actualDigit: bot.actualDigit,
                    lastFibonacciAnalysis: bot.lastFibonacciAnalysis
                },
                subscriptions: {
                    tickSubscriptionIds: { ...bot.tickSubscriptionIds },
                    activeSubscriptions: Array.from(bot.activeSubscriptions),
                    contractSubscription: bot.contractSubscription
                },
                assets: {}
            };

            bot.assets.forEach(asset => {
                persistableState.assets[asset] = {
                    tickHistory: bot.tickHistories[asset].slice(-200),
                    lastTickLogTime: bot.lastTickLogTime[asset]
                };
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
        } catch (error) {
            console.error(`Failed to save state: ${error.message}`);
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                console.log('📂 No previous state file found, starting fresh');
                return false;
            }

            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            if (ageMinutes > 30) {
                console.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            console.log(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);
            return savedData;
        } catch (error) {
            console.error(`Failed to load state: ${error.message}`);
            return false;
        }
    }

    static startAutoSave(bot) {
        setInterval(() => {
            StatePersistence.saveState(bot);
        }, STATE_SAVE_INTERVAL);
        console.log('🔄 Auto-save started (every 5 seconds)');
    }
}

// ============================================
// FIBONACCI TRADING BOT
// ============================================
class FibonacciDifferBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = [
            // 'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'
            'R_100'
        ];

        this.config = {
            initialStake: config.initialStake || 0.61,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            stopLoss: config.stopLoss || 129,
            takeProfit: config.takeProfit || 25,
            requiredHistoryLength: config.requiredHistoryLength || 1000,
            minConfidence: config.minConfidence || 'MEDIUM', // Minimum confidence for trading
            minWaitTime: config.minWaitTime || 120000,
            maxWaitTime: config.maxWaitTime || 180000,
        };

        // Initialize Fibonacci Analyzer
        this.fibAnalyzer = new FibonacciDigitAnalyzer();

        // Trading state
        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.x2Losses = 0;
        this.x3Losses = 0;
        this.x4Losses = 0;
        this.x5Losses = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.suspendedAssets = new Set();
        this.endOfDay = false;
        this.isWinTrade = false;
        this.lastPrediction = null;
        this.actualDigit = null;
        this.lastFibonacciAnalysis = null;

        // Reconnection logic
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 5000;
        this.reconnectTimer = null;
        this.isReconnecting = false;

        // Heartbeat/Ping mechanism
        this.pingInterval = null;
        this.checkDataInterval = null;
        this.pongTimeout = null;
        this.lastPongTime = Date.now();
        this.lastDataTime = Date.now();
        this.pingIntervalMs = 20000;
        this.pongTimeoutMs = 10000;
        this.dataTimeoutMs = 60000;

        // Message queue
        this.messageQueue = [];
        this.maxQueueSize = 50;

        // Subscriptions
        this.activeSubscriptions = new Set();
        this.contractSubscription = null;

        // Telegram Configuration
        this.telegramToken = '8106601008:AAEMyCma6mvPYIHEvw3RHQX2tkD5-wUe1o0';
        this.telegramChatId = '752497117';
        this.telegramEnabled = true;

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
            this.startTelegramTimer();
        }

        // Stats tracking
        this.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };

        // Tick data storage
        this.tickHistories = {};
        this.tickSubscriptionIds = {};
        this.lastTickLogTime = {};
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.lastTickLogTime[asset] = 0;
        });

        // Load saved state
        this.loadSavedState();
    }

    loadSavedState() {
        const savedState = StatePersistence.loadState();
        if (!savedState) return;

        try {
            const trading = savedState.trading;
            this.currentStake = trading.currentStake;
            this.consecutiveLosses = trading.consecutiveLosses;
            this.totalTrades = trading.totalTrades;
            this.totalWins = trading.totalWins;
            this.totalLosses = trading.totalLosses;
            this.x2Losses = trading.x2Losses;
            this.x3Losses = trading.x3Losses;
            this.x4Losses = trading.x4Losses;
            this.x5Losses = trading.x5Losses;
            this.totalProfitLoss = trading.totalProfitLoss;
            this.lastPrediction = trading.lastPrediction;
            this.actualDigit = trading.actualDigit;
            this.lastFibonacciAnalysis = trading.lastFibonacciAnalysis;

            savedState.assets && Object.keys(savedState.assets).forEach(asset => {
                if (this.tickHistories[asset]) {
                    this.tickHistories[asset] = savedState.assets[asset].tickHistory || [];
                }
            });

            console.log('✅ State restored successfully');
            console.log(`   Trades: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalLosses}`);
            console.log(`   P&L: $${this.totalProfitLoss.toFixed(2)} | Current Stake: $${this.currentStake.toFixed(2)}`);
        } catch (error) {
            console.error(`Error restoring state: ${error.message}`);
        }
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('Already connected');
            return;
        }

        console.log('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.wsReady = false;
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            this.lastPongTime = Date.now();
            this.lastDataTime = Date.now();

            this.startMonitor();
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            this.lastPongTime = Date.now();
            this.lastDataTime = Date.now();
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

        this.ws.on('close', (code, reason) => {
            console.log(`Disconnected from Deriv API (Code: ${code}, Reason: ${reason || 'None'})`);
            this.handleDisconnect();
        });

        this.ws.on('pong', () => {
            this.lastPongTime = Date.now();
        });
    }

    startMonitor() {
        this.stopMonitor();

        this.pingInterval = setInterval(() => {
            if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();

                this.pongTimeout = setTimeout(() => {
                    const timeSinceLastPong = Date.now() - this.lastPongTime;
                    if (timeSinceLastPong > this.pongTimeoutMs) {
                        console.warn('⚠️ No pong received, connection may be dead');
                    }
                }, this.pongTimeoutMs);
            }
        }, this.pingIntervalMs);

        this.checkDataInterval = setInterval(() => {
            if (!this.connected) return;

            const silenceDuration = Date.now() - this.lastDataTime;
            if (silenceDuration > this.dataTimeoutMs) {
                console.error(`⚠️ No data for ${Math.round(silenceDuration / 1000)}s - Forcing reconnection...`);
                StatePersistence.saveState(this);
                if (this.ws) this.ws.terminate();
            }
        }, 10000);

        console.log('🔄 Connection monitoring started');
    }

    stopMonitor() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.checkDataInterval) {
            clearInterval(this.checkDataInterval);
            this.checkDataInterval = null;
        }
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    sendRequest(request) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('Cannot send request: WebSocket not ready');
            if (this.messageQueue.length < this.maxQueueSize) {
                this.messageQueue.push(request);
            }
            return false;
        }

        try {
            this.ws.send(JSON.stringify(request));
            return true;
        } catch (error) {
            console.error('Error sending request:', error.message);
            if (this.messageQueue.length < this.maxQueueSize) {
                this.messageQueue.push(request);
            }
            return false;
        }
    }

    processMessageQueue() {
        if (this.messageQueue.length === 0) return;

        console.log(`Processing ${this.messageQueue.length} queued messages...`);
        const queue = [...this.messageQueue];
        this.messageQueue = [];

        queue.forEach(message => {
            this.sendRequest(message);
        });
    }

    authenticate() {
        this.sendRequest({ authorize: this.token });
    }

    handleMessage(message) {
        if (message.msg_type === 'ping') {
            this.sendRequest({ ping: 1 });
            return;
        }

        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                this.sendTelegramMessage(`❌ <b>Authentication Failed:</b> ${message.error.message}`);
                return;
            }
            console.log('✅ Authenticated successfully');
            this.wsReady = true;
            this.processMessageQueue();
            this.initializeSubscriptions();

        } else if (message.msg_type === 'history') {
            const asset = message.echo_req.ticks_history;
            this.handleTickHistory(asset, message.history);
        } else if (message.msg_type === 'tick') {
            if (message.subscription) {
                const asset = message.tick.symbol;
                this.tickSubscriptionIds[asset] = message.subscription.id;
                this.activeSubscriptions.add(message.subscription.id);
            }
            this.handleTickUpdate(message.tick);
        } else if (message.msg_type === 'buy') {
            if (message.error) {
                console.error('Error placing trade:', message.error.message);
                this.sendTelegramMessage(`❌ <b>Trade Error:</b> ${message.error.message}`);
                this.tradeInProgress = false;
                return;
            }
            console.log('✅ Trade placed successfully');
            this.subscribeToOpenContract(message.buy.contract_id);
        } else if (message.msg_type === 'proposal_open_contract') {
            if (message.proposal_open_contract.is_sold) {
                this.handleTradeResult(message.proposal_open_contract);
            }
        } else if (message.error) {
            console.error('API Error:', message.error.message);
            if (message.error.code === 'AuthorizationRequired' ||
                message.error.code === 'InvalidToken') {
                console.log('Auth error detected, triggering reconnection...');
                this.handleDisconnect();
            }
        }
    }

    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;
        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error(`❌ Failed to send Telegram message: ${error.message}`);
        }
    }

    async sendHourlySummary() {
        const stats = this.hourlyStats;
        const winRate = stats.wins + stats.losses > 0
            ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1)
            : 0;
        const pnlEmoji = stats.pnl >= 0 ? '🟢' : '🔴';
        const pnlStr = (stats.pnl >= 0 ? '+' : '') + '$' + stats.pnl.toFixed(2);

        const message = `
⏰ <b>Fibonacci Differ Bot Hourly Summary</b>

📊 <b>Last Hour</b>
├ Trades: ${stats.trades}
├ Wins: ${stats.wins} | Losses: ${stats.losses}
├ Win Rate: ${winRate}%
└ ${pnlEmoji} <b>P&L:</b> ${pnlStr}

📈 <b>Daily Totals</b>
├ Total Trades: ${this.totalTrades}
├ Total W/L: ${this.totalWins}/${this.totalLosses}
├ Daily P&L: ${(this.totalProfitLoss >= 0 ? '+' : '')}$${this.totalProfitLoss.toFixed(2)}
└ Current Capital: $${(this.config.initialStake + this.totalProfitLoss).toFixed(2)}

🔢 <b>Fibonacci Analysis Active</b>
├ φ (Golden Ratio): 1.618
└ Methods: 8 ensemble models

⏰ ${new Date().toLocaleString()}
`.trim();

        try {
            await this.sendTelegramMessage(message);
            console.log('📱 Telegram: Hourly Summary sent');
        } catch (error) {
            console.error(`❌ Telegram hourly summary failed: ${error.message}`);
        }

        this.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };
    }

    startTelegramTimer() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1);
        nextHour.setMinutes(0);
        nextHour.setSeconds(0);
        nextHour.setMilliseconds(0);

        const timeUntilNextHour = nextHour.getTime() - now.getTime();

        setTimeout(() => {
            this.sendHourlySummary();
            setInterval(() => {
                this.sendHourlySummary();
            }, 60 * 60 * 1000);
        }, timeUntilNextHour);

        console.log(`📱 Hourly summaries scheduled. First in ${Math.ceil(timeUntilNextHour / 60000)} minutes.`);
    }

    initializeSubscriptions() {
        console.log('📊 Initializing subscriptions for Fibonacci analysis...');
        this.assets.forEach(asset => {
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });

            this.sendRequest({
                ticks: asset,
                subscribe: 1
            });
        });
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    handleTickHistory(asset, history) {
        this.tickHistories[asset] = history.prices.map(price => this.getLastDigit(price, asset));
        console.log(`📊 Loaded ${this.tickHistories[asset].length} ticks for ${asset}`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.tickHistories[asset].push(lastDigit);
        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        }

        const now = Date.now();
        if (now - this.lastTickLogTime[asset] >= 30000) {
            console.log(`[${asset}] ${tick.quote}: ${this.tickHistories[asset].slice(-5).join(', ')}`);
            this.lastTickLogTime[asset] = now;
        }

        if (!this.tradeInProgress) {
            this.analyzeTicks(asset);
        }
    }

    analyzeTicks(asset) {
        if (this.tradeInProgress || this.suspendedAssets.has(asset)) return;

        const history = this.tickHistories[asset];
        if (history.length < 100) return;

        // Use Fibonacci analysis to predict unlikely digit
        const prediction = this.fibAnalyzer.predictUnlikelyDigit(history);
        // console.log('Prediction:', prediction);

        // Check if conditions are favorable
        const isFavorable = this.fibAnalyzer.isFavorableTradingCondition(history);
        // console.log('Is Favorable:', isFavorable);

        // Check confidence threshold
        const confidenceLevels = ['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'];
        const minConfidenceIndex = confidenceLevels.indexOf(this.config.minConfidence);
        const currentConfidenceIndex = confidenceLevels.indexOf(prediction.confidence);
        // console.log('Min Confidence Index:', minConfidenceIndex);
        // console.log('Current Confidence Index:', currentConfidenceIndex);

        if (prediction.digit !== null &&
            isFavorable &&
            currentConfidenceIndex >= minConfidenceIndex) {

            this.lastFibonacciAnalysis = prediction;
            this.lastPrediction = prediction.digit;

            console.log(`\n🔢 FIBONACCI ANALYSIS for ${asset}:`);
            console.log(`   Predicted Digit: ${prediction.digit} (${prediction.isFibonacciDigit ? 'Fibonacci' : 'Non-Fibonacci'})`);
            console.log(`   Confidence: ${prediction.confidence} (${(prediction.confidenceScore * 100).toFixed(1)}%)`);
            console.log(`   Recent Count: ${prediction.recentCount} in last 5`);
            console.log(`   Analysis Scores:`, prediction.analysis);

            this.placeTrade(asset, prediction.digit, prediction);
        }
    }

    placeTrade(asset, predictedDigit, analysis) {
        if (this.tradeInProgress || !this.wsReady) return;

        this.tradeInProgress = true;

        console.log(`\n🎯 Placing Fibonacci Trade: [${asset}] Digit ${predictedDigit} | Stake: $${this.currentStake.toFixed(2)}`);

        const message = `
            🔔 <b>Fibonacci Trade Opened</b>

            📊 <b>${asset}</b>
            🎯 <b>Differ Digit:</b> ${predictedDigit}
            💰 <b>Stake:</b> $${this.currentStake.toFixed(2)}

            🔢 <b>Fibonacci Analysis:</b>
            ├ Confidence: ${analysis.confidence}
            ├ Is Fib Digit: ${analysis.isFibonacciDigit ? 'Yes' : 'No'}
            ├ Recent Count: ${analysis.recentCount}/5
            ├ φ Score: ${analysis.confidenceScore.toFixed(3)}

            📈 <b>Method Scores:</b>
            ├ Frequency: ${analysis.analysis.frequencyScore}
            ├ Gap: ${analysis.analysis.gapScore}
            ├ Pisano: ${analysis.analysis.pisanoScore}
            ├ Momentum: ${analysis.analysis.momentumScore}
            ├ Cluster: ${analysis.analysis.clusterScore}
            ├ Cyclical: ${analysis.analysis.cyclicalScore}
            ├ Lucas: ${analysis.analysis.lucasScore}
            └ Entropy: ${analysis.analysis.entropyScore}

            Last10: ${this.tickHistories[asset].slice(-10).join(',')}

            ⏰ ${new Date().toLocaleTimeString()}
        `.trim();
        this.sendTelegramMessage(message);

        const success = this.sendRequest({
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
        });

        if (!success) {
            console.error('Failed to send trade request');
            this.tradeInProgress = false;
        }
    }

    subscribeToOpenContract(contractId) {
        this.contractSubscription = contractId;
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });
    }

    handleTradeResult(contract) {
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const exitSpot = contract.exit_tick_display_value;
        this.actualDigit = this.getLastDigit(exitSpot, asset);

        console.log(`[${asset}] ${won ? '✅ WON' : '❌ LOST'} | Profit: $${profit.toFixed(2)}`);

        this.totalTrades++;
        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
            this.isWinTrade = true;
        } else {
            this.isWinTrade = false;
            this.totalLosses++;
            this.consecutiveLosses++;

            if (this.consecutiveLosses === 2) this.x2Losses++;
            if (this.consecutiveLosses === 3) this.x3Losses++;
            if (this.consecutiveLosses === 4) this.x4Losses++;
            if (this.consecutiveLosses === 5) this.x5Losses++;

            if (this.consecutiveLosses === 2) {
                this.currentStake = this.config.initialStake;
            } else {
                this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            }
            // this.suspendAsset(asset);
        }

        this.totalProfitLoss += profit;

        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;
        if (won) this.hourlyStats.wins++;
        else this.hourlyStats.losses++;

        const resultEmoji = won ? '✅ WIN' : '❌ LOSS';
        const pnlStr = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(2);
        const pnlColor = profit >= 0 ? '🟢' : '🔴';
        const winRate = ((this.totalWins / this.totalTrades) * 100).toFixed(1);

        const telegramMsg = `
${resultEmoji} <b>Fibonacci Differ Bot</b>

📊 <b>${asset}</b>
${pnlColor} <b>P&L:</b> ${pnlStr}
📊 <b>Predicted:</b> ${this.lastPrediction}
🎯 <b>Actual:</b> ${this.actualDigit}

🔢 <b>Fibonacci Info:</b>
├ Method: ${this.lastFibonacciAnalysis?.method || 'N/A'}
├ Confidence: ${this.lastFibonacciAnalysis?.confidence || 'N/A'}
└ φ Used: ${this.lastFibonacciAnalysis?.phi?.toFixed(6) || 'N/A'}

📊 <b>Session Stats:</b>
├ Trades: ${this.totalTrades}
├ Wins: ${this.totalWins} | Losses: ${this.totalLosses}
├ x2-x5: ${this.x2Losses}/${this.x3Losses}/${this.x4Losses}/${this.x5Losses}
├ Win Rate: ${winRate}%
└ Daily P&L: ${(this.totalProfitLoss >= 0 ? '+' : '')}$${this.totalProfitLoss.toFixed(2)}

💰 <b>Next Stake:</b> $${this.currentStake.toFixed(2)}

⏰ ${new Date().toLocaleTimeString()}
`.trim();
        this.sendTelegramMessage(telegramMsg);

        if (!this.endOfDay) {
            this.logSummary();
        }

        // Check stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('🛑 Stop loss reached');
            this.sendTelegramMessage(`🛑 <b>Stop Loss Reached!</b>\nFinal P&L: $${this.totalProfitLoss.toFixed(2)}`);
            this.endOfDay = true;
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('🎉 Take profit reached');
            this.sendTelegramMessage(`🎉 <b>Take Profit Reached!</b>\nFinal P&L: $${this.totalProfitLoss.toFixed(2)}`);
            this.endOfDay = true;
            this.disconnect();
            return;
        }

        this.tradeInProgress = false;
        this.contractSubscription = null;
    }

    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
        console.log(`🚫 Suspended: ${asset}`);

        if (this.suspendedAssets.size > 1) {
            const first = Array.from(this.suspendedAssets)[0];
            this.suspendedAssets.delete(first);
            console.log(`✅ Reactivated: ${first}`);
        }
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay();
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            const isWeekend = (currentDay === 0) ||
                (currentDay === 6 && currentHours >= 23) ||
                (currentDay === 1 && currentHours < 2);

            if (isWeekend) {
                if (!this.endOfDay) {
                    console.log("Weekend trading suspension. Disconnecting...");
                    this.sendHourlySummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
                return;
            }

            if (this.endOfDay && currentHours === 2 && currentMinutes >= 0) {
                console.log("It's 2:00 AM GMT+1, reconnecting the bot.");
                this.resetDailyStats();
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 23 && currentMinutes >= 0) {
                    console.log("It's past 23:00 PM GMT+1 after a win trade, disconnecting.");
                    this.sendHourlySummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    resetDailyStats() {
        this.tradeInProgress = false;
        this.suspendedAssets.clear();
        this.isWinTrade = false;
    }

    logSummary() {
        console.log('\n📊 FIBONACCI TRADING SUMMARY');
        console.log(`Trades: ${this.totalTrades}`);
        console.log(`Wins: ${this.totalWins}`);
        console.log(`Losses: ${this.totalLosses}`);
        console.log(`x2-x5 Losses: ${this.x2Losses}/${this.x3Losses}/${this.x4Losses}/${this.x5Losses}`);
        console.log(`Last Prediction: ${this.lastPrediction} | Actual Digit: ${this.actualDigit}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`P&L: $${this.totalProfitLoss.toFixed(2)} | Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        if (this.lastFibonacciAnalysis) {
            console.log(`Fibonacci Confidence: ${this.lastFibonacciAnalysis.confidence}`);
        }
    }

    handleDisconnect() {
        if (this.endOfDay) {
            console.log('Planned shutdown, not reconnecting.');
            this.cleanup();
            return;
        }

        if (this.isReconnecting) {
            console.log('Already handling disconnect, skipping...');
            return;
        }

        this.connected = false;
        this.wsReady = false;
        this.stopMonitor();

        StatePersistence.saveState(this);

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            this.sendTelegramMessage(
                `❌ <b>Max Reconnection Attempts Reached</b>\n` +
                `Please restart the bot manually.\n` +
                `Final P&L: $${this.totalProfitLoss.toFixed(2)}`
            );
            this.isReconnecting = false;
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        const delay = Math.min(
            this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1),
            30000
        );

        console.log(
            `🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... ` +
            `(Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
        );

        this.sendTelegramMessage(
            `⚠️ <b>CONNECTION LOST - RECONNECTING</b>\n` +
            `📊 Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
            `⏱️ Retrying in ${(delay / 1000).toFixed(1)}s\n` +
            `💾 State preserved: ${this.totalTrades} trades, $${this.totalProfitLoss.toFixed(2)} P&L`
        );

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(() => {
            console.log('🔄 Attempting reconnection...');
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    cleanup() {
        this.stopMonitor();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN ||
                this.ws.readyState === WebSocket.CONNECTING) {
                try {
                    this.ws.close();
                } catch (e) {
                    console.log('WebSocket already closed');
                }
            }
            this.ws = null;
        }

        if (this.endOfDay) {
            this.activeSubscriptions.clear();
        }

        this.connected = false;
        this.wsReady = false;
    }

    disconnect() {
        console.log('🛑 Disconnecting Fibonacci bot...');
        StatePersistence.saveState(this);
        this.endOfDay = true;
        this.cleanup();
        console.log('✅ Bot disconnected successfully');
    }

    start() {
        console.log('🚀 Starting Fibonacci Differ Bot...');
        console.log('🔢 Using Golden Ratio (φ = 1.618) for analysis');
        console.log(`📊 Session Summary:`);
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins/Losses: ${this.totalWins}/${this.totalLosses}`);
        console.log(`   Total P&L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`   Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`   Min Confidence: ${this.config.minConfidence}`);
        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// ============================================
// INITIALIZE AND START BOT
// ============================================
const bot = new FibonacciDifferBot('0P94g4WdSrSrzir', {
    initialStake: 2.2,
    multiplier: 11.3,
    maxConsecutiveLosses: 4,
    stopLoss: 55,
    takeProfit: 5000,
    requiredHistoryLength: 1000,
    minConfidence: 'MEDIUM', // Can be: LOW, MEDIUM, HIGH, VERY_HIGH
    minWaitTime: 1000,
    maxWaitTime: 3000,
});

// Start auto-save
StatePersistence.startAutoSave(bot);

bot.start();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n⚠️ Received SIGINT, shutting down gracefully...');
    bot.disconnect();
    setTimeout(() => process.exit(0), 2000);
});

process.on('SIGTERM', () => {
    console.log('\n⚠️ Received SIGTERM, shutting down gracefully...');
    bot.disconnect();
    setTimeout(() => process.exit(0), 2000);
});
