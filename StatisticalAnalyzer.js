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
        if (digitStats.selfRepRate > 0.12) {
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
            if (repetitionStats.currentNonRepStreak < this.config.minNonRepStreak) {
                return `Non-rep streak too short: ${repetitionStats.currentNonRepStreak}`;
            }
            if (digitStats.selfRepRate > 0.12) {
                return `Digit self-rep rate too high: ${(digitStats.selfRepRate * 100).toFixed(1)}%`;
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
            reason: analysis.reason
        };
    }
}

module.exports = StatisticalAnalyzer;
