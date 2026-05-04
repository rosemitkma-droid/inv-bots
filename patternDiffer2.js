/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         differBot V2 — Advanced Pattern Recognition          ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  ADVANCED STRATEGY:                                          ║
 * ║  • Markov Chain Analysis (2nd & 3rd order)                   ║
 * ║  • Sequence Pattern Mining (Frequent patterns)               ║
 * ║  • Autocorrelation Analysis (Cyclic detection)               ║
 * ║  • Entropy-Based Randomness Measurement                      ║
 * ║  • Bayesian Inference (Prior/Posterior updates)              ║
 * ║  • Hidden Markov Models (State prediction)                   ║
 * ║  • Ensemble Decision System (Multi-strategy voting)          ║
 * ║  • Adaptive Weighting (Performance-based auto-tuning)        ║
 * ║  • Market Regime Detection (Trending/Ranging/Volatile)       ║
 * ║  • Advanced Monte Carlo Risk Analysis                        ║
 * ╚══════════════════════════════════════════════════════════════╝
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

    // Advanced Pattern Recognition Config
    markovOrder: 3,                     // Track up to 3rd order Markov chains
    patternMinSupport: 3,               // Minimum occurrences for pattern validity
    patternMaxLength: 5,                // Maximum pattern sequence length
    autocorrelationLags: 20,            // Number of lags for ACF analysis
    entropyWindow: 50,                  // Window for entropy calculation
    bayesianPriorWeight: 0.1,          // Weight of prior vs observed data
    hmmStates: 3,                       // Number of hidden states (low/medium/high frequency)

    // Ensemble weights (will be auto-tuned)
    ensembleWeights: {
        markov: 0.20,
        patterns: 0.15,
        autocorr: 0.10,
        entropy: 0.10,
        bayesian: 0.20,
        hmm: 0.15,
        technical: 0.10
    },

    // Trading filters
    minEnsembleConfidence: 0.72,        // Minimum consensus confidence to trade
    minStrategyAgreement: 4,            // Min number of strategies that must agree
    adaptiveWeightWindow: 50,           // Trades to consider for weight adjustment

    // Technical (kept from V1)
    bbPeriod: 20,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    minBandWidthScore: 0.80,
    minMacdFlatScore: 0.85,
    minPricePositionScore: 0.85,
    minTickStabilityScore: 0.85,
    minVolTrendScore: 0.60,
    minMaxTickMove: 0.0001,
    maxTickMove: 0.0004,

    minTimeBetweenTrades: 3000,
    requiredHistoryLength: 200,         // Increased for better pattern detection

    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    telegramChatId: '752497117',

    maxReconnectAttempts: 50,
    reconnectDelay: 5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'pattern_differBot_v2_state.json');
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
                ensembleWeights: bot.ensembleWeights,
                strategyPerformance: bot.strategyPerformance,
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

// ─────────────────────────────────────────────────────────────────────────────
// TECHNICAL INDICATORS
// ─────────────────────────────────────────────────────────────────────────────
class TechnicalIndicators {
    static SMA(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        return slice.reduce((s, v) => s + v, 0) / period;
    }

    static EMA(data, period) {
        if (data.length < period) return null;
        const k = 2 / (period + 1);
        let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
        for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
        return ema;
    }

    static stdDev(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        const mean = slice.reduce((s, v) => s + v, 0) / period;
        return Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
    }

    static bollingerBands(prices, period = 20, mult = 2.0) {
        if (prices.length < period) return null;
        const middle = this.SMA(prices, period);
        const sd = this.stdDev(prices, period);
        const upper = middle + mult * sd;
        const lower = middle - mult * sd;
        const cur = prices[prices.length - 1];
        const width = (upper - lower) / middle;
        const pctB = (upper - lower) !== 0 ? (cur - lower) / (upper - lower) : 0.5;
        return { upper, middle, lower, width, percentB: pctB, stdDev: sd };
    }

    static MACD(prices, fast = 12, slow = 26, signal = 9) {
        if (prices.length < slow + signal) return null;
        const macdVals = [];
        for (let i = slow; i <= prices.length; i++) {
            const sl = prices.slice(0, i);
            const fEMA = this.EMA(sl, fast);
            const sEMA = this.EMA(sl, slow);
            if (fEMA !== null && sEMA !== null) macdVals.push(fEMA - sEMA);
        }
        if (macdVals.length < signal) return null;
        const macdLine = macdVals[macdVals.length - 1];
        const signalLine = this.EMA(macdVals, signal);
        const histogram = macdLine - signalLine;
        const prevMacd = macdVals.slice(0, -1);
        const prevSig = prevMacd.length >= signal ? this.EMA(prevMacd, signal) : signalLine;
        const prevHist = prevMacd[prevMacd.length - 1] - prevSig;
        return {
            macdLine, signalLine, histogram, prevHistogram: prevHist,
            isConverging: Math.abs(histogram) < Math.abs(prevHist),
            histogramTrend: histogram - prevHist,
        };
    }

    static ATR(prices, period = 14) {
        if (prices.length < period + 1) return null;
        const ranges = [];
        for (let i = prices.length - period; i < prices.length; i++)
            ranges.push(Math.abs(prices[i] - prices[i - 1]));
        return ranges.reduce((s, v) => s + v, 0) / period;
    }

    static bandWidthPercentile(prices, bbPeriod = 20, lookback = 60) {
        if (prices.length < lookback + bbPeriod) return null;
        const widths = [];
        for (let i = bbPeriod; i <= Math.min(lookback, prices.length - bbPeriod); i++) {
            const sl = prices.slice(0, prices.length - i + bbPeriod);
            const bb = this.bollingerBands(sl, bbPeriod);
            if (bb) widths.push(bb.width);
        }
        if (widths.length < 10) return null;
        const cur = widths[0];
        const sorted = [...widths].sort((a, b) => a - b);
        return sorted.findIndex(w => w >= cur) / sorted.length;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ADVANCED PATTERN RECOGNITION: MARKOV CHAIN ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════
class MarkovChainAnalyzer {
    constructor(order = 3) {
        this.order = order;
        this.chains = {}; // Store transition matrices for each order
    }

    /**
     * Build Markov transition matrices from digit history
     * Returns probabilities for each possible next digit given recent sequence
     */
    analyze(digitHistory) {
        if (digitHistory.length < this.order + 50) {
            return { predictions: null, confidence: 0, reason: 'insufficient_history' };
        }

        // Build transition counts for each order
        const transitions = {};
        for (let ord = 1; ord <= this.order; ord++) {
            transitions[ord] = {};
        }

        // Count transitions
        for (let i = this.order; i < digitHistory.length; i++) {
            for (let ord = 1; ord <= this.order; ord++) {
                const state = digitHistory.slice(i - ord, i).join(',');
                const next = digitHistory[i];

                if (!transitions[ord][state]) {
                    transitions[ord][state] = Array(10).fill(0);
                }
                transitions[ord][state][next]++;
            }
        }

        // Convert counts to probabilities
        const probabilities = {};
        for (let ord = 1; ord <= this.order; ord++) {
            probabilities[ord] = {};
            for (const state in transitions[ord]) {
                const total = transitions[ord][state].reduce((a, b) => a + b, 0);
                if (total > 0) {
                    probabilities[ord][state] = transitions[ord][state].map(count => count / total);
                }
            }
        }

        // Get predictions for current state
        const predictions = {};
        let maxConfidence = 0;
        let bestPrediction = null;

        for (let ord = this.order; ord >= 1; ord--) {
            const currentState = digitHistory.slice(-ord).join(',');
            if (probabilities[ord][currentState]) {
                const probs = probabilities[ord][currentState];
                const maxProb = Math.max(...probs);
                const predictedDigit = probs.indexOf(maxProb);

                // For DIFFER, we want the digit LEAST likely to appear
                const minProb = Math.min(...probs.filter(p => p > 0));
                const leastLikelyDigit = probs.indexOf(minProb);

                predictions[ord] = {
                    mostLikely: predictedDigit,
                    mostLikelyProb: maxProb,
                    leastLikely: leastLikelyDigit,
                    leastLikelyProb: minProb,
                    distribution: probs,
                    sampleSize: transitions[ord][currentState].reduce((a, b) => a + b, 0)
                };

                // Higher order chains with sufficient samples are more reliable
                const confidence = maxProb * Math.min(1, predictions[ord].sampleSize / 20);
                if (confidence > maxConfidence && predictions[ord].sampleSize >= 5) {
                    maxConfidence = confidence;
                    bestPrediction = {
                        digit: leastLikelyDigit, // Bet DIFFER on least likely
                        confidence: confidence,
                        order: ord,
                        prob: minProb
                    };
                }
            }
        }

        return {
            predictions,
            bestPrediction,
            confidence: maxConfidence,
            probabilities
        };
    }

    /**
     * Get prediction specifically for DIFFER strategy
     */
    predictForDiffer(digitHistory) {
        const result = this.analyze(digitHistory);
        if (!result.bestPrediction) {
            return { shouldTrade: false, digit: null, confidence: 0, reason: 'no_prediction' };
        }

        // For DIFFER: predict the digit that is statistically LEAST likely
        return {
            shouldTrade: result.confidence > 0.3,
            digit: result.bestPrediction.digit,
            confidence: result.confidence,
            order: result.bestPrediction.order,
            probability: result.bestPrediction.prob,
            reason: `markov_order_${result.bestPrediction.order}_confidence_${result.confidence.toFixed(3)}`
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ADVANCED PATTERN RECOGNITION: SEQUENCE PATTERN MINING
// ══════════════════════════════════════════════════════════════════════════════
class SequencePatternMiner {
    constructor(minSupport = 3, maxLength = 5) {
        this.minSupport = minSupport;
        this.maxLength = maxLength;
        this.patterns = new Map();
    }

    /**
     * Mine frequent sequences using modified Apriori algorithm
     */
    minePatterns(digitHistory) {
        if (digitHistory.length < 100) {
            return { patterns: [], prediction: null, confidence: 0 };
        }

        this.patterns.clear();

        // Find frequent patterns of varying lengths
        for (let len = 2; len <= Math.min(this.maxLength, 5); len++) {
            for (let i = 0; i <= digitHistory.length - len - 1; i++) {
                const pattern = digitHistory.slice(i, i + len);
                const next = digitHistory[i + len];
                const key = pattern.join(',');

                if (!this.patterns.has(key)) {
                    this.patterns.set(key, {
                        pattern,
                        nextDigits: Array(10).fill(0),
                        count: 0
                    });
                }

                const entry = this.patterns.get(key);
                entry.nextDigits[next]++;
                entry.count++;
            }
        }

        // Filter by minimum support
        const frequentPatterns = Array.from(this.patterns.entries())
            .filter(([_, data]) => data.count >= this.minSupport)
            .map(([key, data]) => {
                const total = data.nextDigits.reduce((a, b) => a + b, 0);
                const probabilities = data.nextDigits.map(count => count / total);
                const maxProb = Math.max(...probabilities);
                const minProb = Math.min(...probabilities.filter(p => p > 0));

                return {
                    pattern: key,
                    patternArray: data.pattern,
                    count: data.count,
                    nextDigitProbs: probabilities,
                    mostLikelyNext: probabilities.indexOf(maxProb),
                    leastLikelyNext: probabilities.indexOf(minProb),
                    confidence: maxProb,
                    leastLikelyProb: minProb
                };
            })
            .sort((a, b) => b.count - a.count);

        // Find matching pattern for current sequence
        let prediction = null;
        let maxConfidence = 0;

        for (let len = Math.min(this.maxLength, digitHistory.length); len >= 2; len--) {
            const currentSeq = digitHistory.slice(-len).join(',');
            const match = frequentPatterns.find(p => p.pattern === currentSeq);

            if (match && match.count >= this.minSupport) {
                const conf = match.confidence * Math.min(1, match.count / 10);
                if (conf > maxConfidence) {
                    maxConfidence = conf;
                    prediction = {
                        digit: match.leastLikelyNext, // For DIFFER
                        confidence: conf,
                        patternLength: len,
                        occurrences: match.count,
                        probability: match.leastLikelyProb
                    };
                }
            }
        }

        return {
            patterns: frequentPatterns.slice(0, 10),
            prediction,
            confidence: maxConfidence
        };
    }

    predictForDiffer(digitHistory) {
        const result = this.minePatterns(digitHistory);

        if (!result.prediction) {
            return { shouldTrade: false, digit: null, confidence: 0, reason: 'no_pattern_match' };
        }

        return {
            shouldTrade: result.confidence > 0.25,
            digit: result.prediction.digit,
            confidence: result.confidence,
            patternLength: result.prediction.patternLength,
            occurrences: result.prediction.occurrences,
            reason: `pattern_len_${result.prediction.patternLength}_occurs_${result.prediction.occurrences}`
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ADVANCED PATTERN RECOGNITION: AUTOCORRELATION ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════
class AutocorrelationAnalyzer {
    constructor(maxLag = 20) {
        this.maxLag = maxLag;
    }

    /**
     * Calculate autocorrelation function (ACF)
     * Detects cyclic patterns and periodicities
     */
    calculateACF(digitHistory) {
        if (digitHistory.length < this.maxLag * 2) {
            return { acf: null, significantLags: [], confidence: 0 };
        }

        const n = digitHistory.length;
        const mean = digitHistory.reduce((a, b) => a + b, 0) / n;
        const variance = digitHistory.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / n;

        const acf = [];
        for (let lag = 0; lag <= this.maxLag; lag++) {
            let sum = 0;
            for (let i = 0; i < n - lag; i++) {
                sum += (digitHistory[i] - mean) * (digitHistory[i + lag] - mean);
            }
            acf.push(sum / (n * variance));
        }

        // Find significant lags (above 95% confidence interval)
        const criticalValue = 1.96 / Math.sqrt(n);
        const significantLags = acf
            .map((val, lag) => ({ lag, value: val }))
            .filter(item => item.lag > 0 && Math.abs(item.value) > criticalValue)
            .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

        return { acf, significantLags, criticalValue };
    }

    /**
     * Predict based on cyclic patterns
     */
    predictForDiffer(digitHistory) {
        const { acf, significantLags, criticalValue } = this.calculateACF(digitHistory);

        if (!acf || significantLags.length === 0) {
            return { shouldTrade: false, digit: null, confidence: 0, reason: 'no_significant_autocorr' };
        }

        // Use most significant lag to predict
        const topLag = significantLags[0];
        const laggedDigit = digitHistory[digitHistory.length - topLag.lag];

        // Calculate frequency of each digit at this lag
        const laggedFreqs = Array(10).fill(0);
        for (let i = topLag.lag; i < digitHistory.length; i++) {
            laggedFreqs[digitHistory[i - topLag.lag]]++;
        }

        const total = laggedFreqs.reduce((a, b) => a + b, 0);
        const probs = laggedFreqs.map(f => f / total);
        const minProb = Math.min(...probs.filter(p => p > 0));
        const predictedDigit = probs.indexOf(minProb);

        const confidence = Math.abs(topLag.value) * 0.8; // ACF strength as confidence

        return {
            shouldTrade: confidence > 0.15 && significantLags.length >= 2,
            digit: predictedDigit,
            confidence,
            lag: topLag.lag,
            acfValue: topLag.value,
            reason: `autocorr_lag_${topLag.lag}_acf_${topLag.value.toFixed(3)}`
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ADVANCED PATTERN RECOGNITION: ENTROPY ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════
class EntropyAnalyzer {
    constructor(windowSize = 50) {
        this.windowSize = windowSize;
    }

    /**
     * Calculate Shannon entropy
     * Low entropy = predictable, High entropy = random
     */
    calculateEntropy(digitHistory) {
        if (digitHistory.length < this.windowSize) {
            return { entropy: null, isLowEntropy: false, confidence: 0 };
        }

        const window = digitHistory.slice(-this.windowSize);
        const freq = Array(10).fill(0);

        window.forEach(d => freq[d]++);

        const probs = freq.map(f => f / window.length).filter(p => p > 0);
        const entropy = -probs.reduce((sum, p) => sum + p * Math.log2(p), 0);

        // Maximum entropy for 10 digits is log2(10) ≈ 3.32
        const maxEntropy = Math.log2(10);
        const normalizedEntropy = entropy / maxEntropy;

        // Low entropy means predictable patterns
        const isLowEntropy = normalizedEntropy < 0.85;

        // Find least frequent digit in low-entropy windows
        const minFreq = Math.min(...freq.filter(f => f > 0));
        const predictedDigit = freq.indexOf(minFreq);

        // Kolmogorov complexity estimation (compression ratio)
        const compressed = this.estimateComplexity(window);
        const compressionRatio = compressed / window.length;

        return {
            entropy,
            normalizedEntropy,
            isLowEntropy,
            compressionRatio,
            predictedDigit,
            confidence: isLowEntropy ? (1 - normalizedEntropy) : 0,
            distribution: freq
        };
    }

    /**
     * Estimate Kolmogorov complexity via simple run-length encoding
     */
    estimateComplexity(sequence) {
        let compressed = 0;
        let i = 0;

        while (i < sequence.length) {
            let runLength = 1;
            while (i + runLength < sequence.length && sequence[i] === sequence[i + runLength]) {
                runLength++;
            }
            compressed += 2; // Store digit + count
            i += runLength;
        }

        return compressed;
    }

    predictForDiffer(digitHistory) {
        const result = this.calculateEntropy(digitHistory);

        if (!result.entropy) {
            return { shouldTrade: false, digit: null, confidence: 0, reason: 'insufficient_data' };
        }

        // Only trade in low-entropy (predictable) conditions
        if (!result.isLowEntropy) {
            return {
                shouldTrade: false,
                digit: null,
                confidence: 0,
                reason: `high_entropy_${result.normalizedEntropy.toFixed(3)}`
            };
        }

        return {
            shouldTrade: result.confidence > 0.12,
            digit: result.predictedDigit,
            confidence: result.confidence,
            entropy: result.normalizedEntropy,
            compressionRatio: result.compressionRatio,
            reason: `low_entropy_${result.normalizedEntropy.toFixed(3)}_predictable`
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ADVANCED PATTERN RECOGNITION: BAYESIAN INFERENCE
// ══════════════════════════════════════════════════════════════════════════════
class BayesianPredictor {
    constructor(priorWeight = 0.1) {
        this.priorWeight = priorWeight;
        this.priors = Array(10).fill(0.1); // Uniform prior
    }

    /**
     * Update beliefs using Bayes' theorem
     * P(digit|evidence) = P(evidence|digit) * P(digit) / P(evidence)
     */
    predict(digitHistory) {
        if (digitHistory.length < 50) {
            return { posteriors: null, prediction: null, confidence: 0 };
        }

        // Calculate likelihood from observed frequencies
        const observed = Array(10).fill(0);
        const window = digitHistory.slice(-100);
        window.forEach(d => observed[d]++);

        const likelihoods = observed.map(count => (count + 1) / (window.length + 10)); // Laplace smoothing

        // Calculate posteriors: P(digit) * P(evidence|digit)
        let posteriors = this.priors.map((prior, digit) => {
            return prior * this.priorWeight + likelihoods[digit] * (1 - this.priorWeight);
        });

        // Normalize
        const sum = posteriors.reduce((a, b) => a + b, 0);
        posteriors = posteriors.map(p => p / sum);

        // Update priors for next iteration
        this.priors = posteriors;

        // For DIFFER: choose digit with lowest posterior probability
        const minPosterior = Math.min(...posteriors);
        const predictedDigit = posteriors.indexOf(minPosterior);

        // Confidence based on how much lower the minimum is vs others
        const avgPosterior = posteriors.reduce((a, b) => a + b, 0) / 10;
        const confidence = (avgPosterior - minPosterior) / avgPosterior;

        return {
            posteriors,
            prediction: predictedDigit,
            confidence,
            minPosterior,
            avgPosterior
        };
    }

    predictForDiffer(digitHistory) {
        const result = this.predict(digitHistory);

        if (!result.posteriors) {
            return { shouldTrade: false, digit: null, confidence: 0, reason: 'insufficient_data' };
        }

        return {
            shouldTrade: result.confidence > 0.15,
            digit: result.prediction,
            confidence: result.confidence,
            posterior: result.minPosterior,
            reason: `bayesian_posterior_${result.minPosterior.toFixed(4)}`
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ADVANCED PATTERN RECOGNITION: HIDDEN MARKOV MODEL (Simplified)
// ══════════════════════════════════════════════════════════════════════════════
class HiddenMarkovModel {
    constructor(numStates = 3) {
        this.numStates = numStates; // Low/Medium/High frequency states
        this.transitionProbs = null;
        this.emissionProbs = null;
        this.stateProbs = null;
    }

    /**
     * Train HMM using Baum-Welch-like approach (simplified)
     */
    train(digitHistory) {
        if (digitHistory.length < 100) return false;

        // Initialize matrices
        this.transitionProbs = Array(this.numStates).fill(null)
            .map(() => Array(this.numStates).fill(1 / this.numStates));

        this.emissionProbs = Array(this.numStates).fill(null)
            .map(() => Array(10).fill(0.1));

        this.stateProbs = Array(this.numStates).fill(1 / this.numStates);

        // Segment history into states based on local frequency variance
        const states = this.segmentIntoStates(digitHistory);

        // Count transitions
        const transitionCounts = Array(this.numStates).fill(null)
            .map(() => Array(this.numStates).fill(0));

        for (let i = 0; i < states.length - 1; i++) {
            transitionCounts[states[i]][states[i + 1]]++;
        }

        // Normalize to probabilities
        for (let i = 0; i < this.numStates; i++) {
            const rowSum = transitionCounts[i].reduce((a, b) => a + b, 0);
            if (rowSum > 0) {
                this.transitionProbs[i] = transitionCounts[i].map(c => c / rowSum);
            }
        }

        // Count emissions (digit frequencies per state)
        const emissionCounts = Array(this.numStates).fill(null)
            .map(() => Array(10).fill(0));

        for (let i = 0; i < digitHistory.length; i++) {
            emissionCounts[states[i]][digitHistory[i]]++;
        }

        // Normalize
        for (let s = 0; s < this.numStates; s++) {
            const total = emissionCounts[s].reduce((a, b) => a + b, 0);
            if (total > 0) {
                this.emissionProbs[s] = emissionCounts[s].map(c => (c + 0.1) / (total + 1)); // Smoothing
            }
        }

        return true;
    }

    /**
     * Segment history into states based on local entropy
     */
    segmentIntoStates(digitHistory) {
        const states = [];
        const windowSize = 20;

        for (let i = 0; i < digitHistory.length; i++) {
            const start = Math.max(0, i - windowSize);
            const window = digitHistory.slice(start, i + 1);

            // Calculate local frequency variance
            const freq = Array(10).fill(0);
            window.forEach(d => freq[d]++);
            const variance = this.variance(freq);

            // Map variance to state (0=low, 1=medium, 2=high)
            let state;
            if (variance < 3) state = 0;
            else if (variance < 8) state = 1;
            else state = 2;

            states.push(state);
        }

        return states;
    }

    variance(arr) {
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        return arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
    }

    /**
     * Predict next digit using Viterbi-like algorithm
     */
    predict(digitHistory) {
        if (!this.emissionProbs) {
            this.train(digitHistory);
        }

        if (!this.emissionProbs) {
            return { prediction: null, confidence: 0, state: null };
        }

        // Determine current most likely state
        const currentState = this.segmentIntoStates(digitHistory.slice(-20))[0];

        // Get emission probabilities for current state
        const emissions = this.emissionProbs[currentState];

        // For DIFFER: choose least likely digit in current state
        const minEmission = Math.min(...emissions);
        const predictedDigit = emissions.indexOf(minEmission);

        // Confidence based on probability spread
        const avgEmission = emissions.reduce((a, b) => a + b, 0) / 10;
        const confidence = (avgEmission - minEmission) / avgEmission;

        return {
            prediction: predictedDigit,
            confidence,
            state: currentState,
            emissions
        };
    }

    predictForDiffer(digitHistory) {
        const result = this.predict(digitHistory);

        if (!result.prediction) {
            return { shouldTrade: false, digit: null, confidence: 0, reason: 'hmm_not_trained' };
        }

        return {
            shouldTrade: result.confidence > 0.12,
            digit: result.prediction,
            confidence: result.confidence,
            state: result.state,
            reason: `hmm_state_${result.state}_conf_${result.confidence.toFixed(3)}`
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MARKET REGIME DETECTION
// ══════════════════════════════════════════════════════════════════════════════
class RegimeDetector {
    /**
     * Detect market regime: TRENDING, RANGING, VOLATILE
     */
    static detectRegime(priceHistory) {
        if (priceHistory.length < 50) {
            return { regime: 'UNKNOWN', confidence: 0 };
        }

        const recent = priceHistory.slice(-50);

        // Calculate metrics
        const returns = [];
        for (let i = 1; i < recent.length; i++) {
            returns.push((recent[i] - recent[i - 1]) / recent[i - 1]);
        }

        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const volatility = Math.sqrt(
            returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
        );

        // Trend strength (using linear regression slope)
        const slope = this.linearRegressionSlope(recent);
        const trendStrength = Math.abs(slope) / volatility;

        // ADX-like calculation
        const adx = this.calculateADX(priceHistory.slice(-30));

        let regime;
        let confidence;

        if (adx > 25 && trendStrength > 0.5) {
            regime = 'TRENDING';
            confidence = Math.min(adx / 50, 1);
        } else if (volatility > 0.002) {
            regime = 'VOLATILE';
            confidence = Math.min(volatility / 0.004, 1);
        } else {
            regime = 'RANGING';
            confidence = 1 - Math.min(volatility / 0.001, 1);
        }

        return {
            regime,
            confidence,
            volatility,
            trendStrength,
            adx,
            slope
        };
    }

    static linearRegressionSlope(data) {
        const n = data.length;
        const sumX = (n * (n - 1)) / 2;
        const sumY = data.reduce((a, b) => a + b, 0);
        const sumXY = data.reduce((sum, y, x) => sum + x * y, 0);
        const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;

        return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    }

    static calculateADX(prices, period = 14) {
        if (prices.length < period * 2) return 25;

        const tr = [];
        const plusDM = [];
        const minusDM = [];

        for (let i = 1; i < prices.length; i++) {
            const high = Math.max(prices[i], prices[i - 1]);
            const low = Math.min(prices[i], prices[i - 1]);
            tr.push(high - low);

            const upMove = prices[i] - prices[i - 1];
            const downMove = prices[i - 1] - prices[i];

            plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
        }

        const avgTR = tr.slice(-period).reduce((a, b) => a + b, 0) / period;
        const avgPlusDM = plusDM.slice(-period).reduce((a, b) => a + b, 0) / period;
        const avgMinusDM = minusDM.slice(-period).reduce((a, b) => a + b, 0) / period;

        const plusDI = (avgPlusDM / avgTR) * 100;
        const minusDI = (avgMinusDM / avgTR) * 100;

        const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
        return dx;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ENSEMBLE DECISION SYSTEM
// ══════════════════════════════════════════════════════════════════════════════
class EnsembleDecisionSystem {
    constructor(config, weights) {
        this.cfg = config;
        this.weights = { ...weights };

        // Initialize all analyzers
        this.markov = new MarkovChainAnalyzer(config.markovOrder);
        this.patterns = new SequencePatternMiner(config.patternMinSupport, config.patternMaxLength);
        this.autocorr = new AutocorrelationAnalyzer(config.autocorrelationLags);
        this.entropy = new EntropyAnalyzer(config.entropyWindow);
        this.bayesian = new BayesianPredictor(config.bayesianPriorWeight);
        this.hmm = new HiddenMarkovModel(config.hmmStates);
    }

    /**
     * Run all prediction strategies and combine results
     */
    analyze(digitHistory, priceHistory) {
        const predictions = {};

        // Run each strategy
        predictions.markov = this.markov.predictForDiffer(digitHistory);
        predictions.patterns = this.patterns.predictForDiffer(digitHistory);
        predictions.autocorr = this.autocorr.predictForDiffer(digitHistory);
        predictions.entropy = this.entropy.predictForDiffer(digitHistory);
        predictions.bayesian = this.bayesian.predictForDiffer(digitHistory);
        predictions.hmm = this.hmm.predictForDiffer(digitHistory);

        // Technical score (from existing system)
        predictions.technical = this._technicalScore(priceHistory);

        // Market regime
        const regime = RegimeDetector.detectRegime(priceHistory);

        // Count votes for each digit
        const votes = Array(10).fill(0);
        const confidences = Array(10).fill(0);
        let totalWeight = 0;
        let strategiesVoting = 0;

        for (const [strategy, prediction] of Object.entries(predictions)) {
            if (prediction.shouldTrade && prediction.digit !== null) {
                const weight = this.weights[strategy] || 0;
                votes[prediction.digit] += weight;
                confidences[prediction.digit] += prediction.confidence * weight;
                totalWeight += weight;
                strategiesVoting++;
            }
        }

        // Find consensus digit
        const maxVotes = Math.max(...votes);
        const consensusDigit = votes.indexOf(maxVotes);
        const consensusConfidence = totalWeight > 0 ? confidences[consensusDigit] / totalWeight : 0;

        // Calculate agreement score
        const agreementScore = strategiesVoting > 0 ? maxVotes / totalWeight : 0;

        // Overall decision
        const shouldTrade =
            strategiesVoting >= this.cfg.minStrategyAgreement &&
            consensusConfidence >= this.cfg.minEnsembleConfidence &&
            agreementScore > 0.4;

        return {
            shouldTrade,
            consensusDigit,
            consensusConfidence,
            agreementScore,
            strategiesVoting,
            predictions,
            votes,
            regime,
            reason: this._buildReason(predictions, shouldTrade, strategiesVoting)
        };
    }

    _technicalScore(priceHistory) {
        if (!priceHistory || priceHistory.length < 50) {
            return { shouldTrade: false, digit: null, confidence: 0, reason: 'insufficient_price_data' };
        }

        const bb = TechnicalIndicators.bollingerBands(priceHistory, this.cfg.bbPeriod);
        if (!bb) return { shouldTrade: false, digit: null, confidence: 0, reason: 'bb_failed' };

        const macd = TechnicalIndicators.MACD(priceHistory, this.cfg.macdFast, this.cfg.macdSlow, this.cfg.macdSignal);
        if (!macd) return { shouldTrade: false, digit: null, confidence: 0, reason: 'macd_failed' };

        const atr = TechnicalIndicators.ATR(priceHistory, 14);
        const curPrice = priceHistory[priceHistory.length - 1];

        // Calculate scores
        const scores = {};

        // Band width
        const bwPct = TechnicalIndicators.bandWidthPercentile(priceHistory, this.cfg.bbPeriod, 60);
        if (bwPct !== null) {
            if (bwPct <= 0.20) scores.bandWidth = 1.0;
            else if (bwPct <= 0.40) scores.bandWidth = 0.85;
            else if (bwPct <= 0.55) scores.bandWidth = 0.65;
            else if (bwPct <= 0.70) scores.bandWidth = 0.40;
            else scores.bandWidth = 0.15;
        } else {
            scores.bandWidth = 0.5;
        }

        // MACD flat
        const normHist = Math.abs(macd.histogram) / curPrice;
        if (normHist < 0.00005) scores.macdFlat = 1.0;
        else if (normHist < 0.00015) scores.macdFlat = 0.85;
        else if (normHist < 0.00035) scores.macdFlat = 0.60;
        else if (normHist < 0.00060) scores.macdFlat = 0.35;
        else scores.macdFlat = 0.10;

        // Price position
        if (bb.percentB >= 0.40 && bb.percentB <= 0.60) scores.pricePosition = 1.0;
        else if (bb.percentB >= 0.20 && bb.percentB <= 0.80) scores.pricePosition = 0.70;
        else if (bb.percentB >= 0.10 && bb.percentB <= 0.90) scores.pricePosition = 0.40;
        else scores.pricePosition = 0.10;

        // Tick stability
        const recent = priceHistory.slice(-10);
        let maxMove = 0;
        for (let i = 1; i < recent.length; i++)
            maxMove = Math.max(maxMove, Math.abs(recent[i] - recent[i - 1]) / recent[i - 1]);

        if (maxMove < 0.0003) scores.tickStability = 1.0;
        else if (maxMove < 0.0008) scores.tickStability = 0.80;
        else if (maxMove < 0.0015) scores.tickStability = 0.55;
        else if (maxMove < 0.0025) scores.tickStability = 0.30;
        else scores.tickStability = 0.05;

        // Volatility trend
        const atrShort = TechnicalIndicators.ATR(priceHistory, 7);
        const atrLonger = TechnicalIndicators.ATR(priceHistory.slice(0, -7), 14);
        if (atrShort && atrLonger && atrLonger > 0) {
            const ratio = atrShort / atrLonger;
            if (ratio < 0.70) scores.volTrend = 1.0;
            else if (ratio < 0.85) scores.volTrend = 0.80;
            else if (ratio < 1.0) scores.volTrend = 0.60;
            else if (ratio < 1.15) scores.volTrend = 0.40;
            else scores.volTrend = 0.15;
        } else {
            scores.volTrend = 0.5;
        }

        const overallScore = (
            scores.bandWidth * 0.25 +
            scores.macdFlat * 0.25 +
            scores.pricePosition * 0.20 +
            scores.tickStability * 0.20 +
            scores.volTrend * 0.10
        );

        const shouldTrade =
            overallScore >= 0.7 &&
            scores.bandWidth >= this.cfg.minBandWidthScore &&
            scores.macdFlat >= this.cfg.minMacdFlatScore &&
            scores.pricePosition >= this.cfg.minPricePositionScore &&
            scores.tickStability >= this.cfg.minTickStabilityScore &&
            scores.volTrend >= this.cfg.minVolTrendScore &&
            maxMove >= this.cfg.minMaxTickMove &&
            maxMove <= this.cfg.maxTickMove;

        return {
            shouldTrade,
            digit: null, // Technical doesn't predict specific digit
            confidence: overallScore,
            scores,
            bb,
            macd,
            maxMove,
            atr,
            reason: `technical_score_${overallScore.toFixed(3)}`
        };
    }

    _buildReason(predictions, shouldTrade, strategiesVoting) {
        if (!shouldTrade) {
            if (strategiesVoting < this.cfg.minStrategyAgreement) {
                return `insufficient_agreement_${strategiesVoting}_strategies`;
            }
            return 'confidence_below_threshold';
        }

        const voting = Object.entries(predictions)
            .filter(([_, p]) => p.shouldTrade)
            .map(([name, _]) => name)
            .join('+');

        return `ensemble_${voting}`;
    }

    /**
     * Update strategy weights based on recent performance
     */
    updateWeights(strategyPerformance) {
        const recentWindow = this.cfg.adaptiveWeightWindow;

        for (const [strategy, perf] of Object.entries(strategyPerformance)) {
            if (perf.predictions < 10) continue; // Not enough data

            const recentWinRate = perf.recentWins / Math.min(perf.predictions, recentWindow);
            const overallWinRate = perf.wins / perf.predictions;

            // Increase weight for outperforming strategies
            if (recentWinRate > 0.70 && overallWinRate > 0.65) {
                this.weights[strategy] = Math.min(this.weights[strategy] * 1.1, 0.30);
            } else if (recentWinRate < 0.50) {
                this.weights[strategy] = Math.max(this.weights[strategy] * 0.9, 0.05);
            }
        }

        // Normalize weights
        const totalWeight = Object.values(this.weights).reduce((a, b) => a + b, 0);
        for (const strategy in this.weights) {
            this.weights[strategy] /= totalWeight;
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ENHANCED MONTE CARLO SIMULATOR
// ══════════════════════════════════════════════════════════════════════════════
class MonteCarloSimulator {
    static runSimulation(recentTrades, numSimulations = 1000, numFutureTrades = 50) {
        if (recentTrades.length < 10) {
            return {
                canTrade: true,
                confidence: 0.5,
                recommendedStakeMultiplier: 1.0,
                riskOfRuin: 0.05,
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

        const results = [];
        for (let sim = 0; sim < numSimulations; sim++) {
            const simResults = this.runSingleSimulation(winRate, avgWin, avgLoss, numFutureTrades);
            results.push(simResults);
        }

        const finalBalance = results.map(r => r.finalBalance).sort((a, b) => a - b);
        const maxDrawdowns = results.map(r => r.maxDrawdown).sort((a, b) => a - b);

        const avgFinalBalance = finalBalance.reduce((a, b) => a + b) / finalBalance.length;
        const var95 = finalBalance[Math.floor(finalBalance.length * 0.05)];
        const expectedDrawdown = maxDrawdowns[Math.floor(maxDrawdowns.length * 0.5)];
        const worst95Drawdown = maxDrawdowns[Math.floor(maxDrawdowns.length * 0.95)];
        const riskOfRuin = results.filter(r => r.finalBalance <= 0).length / numSimulations;

        const confidence = Math.max(0, Math.min(1, (avgFinalBalance / 100) * 0.5 + (1 - riskOfRuin) * 0.5));

        let recommendedMultiplier = 1.0;
        if (riskOfRuin < 0.01 && confidence > 0.80) recommendedMultiplier = 1.3;
        else if (riskOfRuin < 0.05 && confidence > 0.70) recommendedMultiplier = 1.15;
        else if (riskOfRuin > 0.15) recommendedMultiplier = 0.7;
        else if (riskOfRuin > 0.25) recommendedMultiplier = 0.5;

        return {
            canTrade: riskOfRuin < 0.20,
            confidence,
            recommendedStakeMultiplier: recommendedMultiplier,
            riskOfRuin,
            expectedDrawdown: expectedDrawdown / 100,
            worst95Drawdown: worst95Drawdown / 100,
            var95: var95 / 100,
            winRate,
            payoutRatio: avgWin / avgLoss
        };
    }

    static runSingleSimulation(winRate, avgWin, avgLoss, numTrades) {
        let balance = 100;
        let minBalance = 100;

        for (let i = 0; i < numTrades; i++) {
            const won = Math.random() < winRate;
            balance += won ? avgWin : -avgLoss;
            minBalance = Math.min(minBalance, balance);
        }

        return {
            finalBalance: balance,
            minBalance,
            maxDrawdown: ((minBalance - 100) / 100) * 100
        };
    }

    static getAverageWin(trades) {
        const wins = trades.filter(t => t.won);
        return wins.length === 0 ? 0 : wins.reduce((sum, t) => sum + t.profit, 0) / wins.length;
    }

    static getAverageLoss(trades) {
        const losses = trades.filter(t => !t.won);
        return losses.length === 0 ? 0 : losses.reduce((sum, t) => sum + Math.abs(t.profit), 0) / losses.length;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT V2
// ══════════════════════════════════════════════════════════════════════════════
class DigitDifferBotV2 {
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
        this.recentPredictions = [];

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

        // Strategy performance tracking
        this.strategyPerformance = {
            markov: { predictions: 0, wins: 0, losses: 0, recentWins: 0, recentPredictions: [] },
            patterns: { predictions: 0, wins: 0, losses: 0, recentWins: 0, recentPredictions: [] },
            autocorr: { predictions: 0, wins: 0, losses: 0, recentWins: 0, recentPredictions: [] },
            entropy: { predictions: 0, wins: 0, losses: 0, recentWins: 0, recentPredictions: [] },
            bayesian: { predictions: 0, wins: 0, losses: 0, recentWins: 0, recentPredictions: [] },
            hmm: { predictions: 0, wins: 0, losses: 0, recentWins: 0, recentPredictions: [] },
            technical: { predictions: 0, wins: 0, losses: 0, recentWins: 0, recentPredictions: [] }
        };

        // Ensemble weights (will be adapted)
        this.ensembleWeights = { ...config.ensembleWeights };

        // Components
        this.ensemble = new EnsembleDecisionSystem(config, this.ensembleWeights);
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
            if (s.ensembleWeights) this.ensembleWeights = s.ensembleWeights;
            if (s.strategyPerformance) this.strategyPerformance = s.strategyPerformance;

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
        if (this.priceHistories[asset].length > 1000) this.priceHistories[asset] = this.priceHistories[asset].slice(-500);

        this.digitHistories[asset].push(digit);
        if (this.digitHistories[asset].length > 500) this.digitHistories[asset] = this.digitHistories[asset].slice(-300);

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
        const analysis = this.ensemble.analyze(
            this.digitHistories[asset],
            this.priceHistories[asset]
        );

        if (!analysis.shouldTrade) return;

        // Adaptive weight tuning every 50 trades
        if (this.totalTrades > 0 && this.totalTrades % 50 === 0) {
            this.ensemble.updateWeights(this.strategyPerformance);
            console.log('\n🔄 Ensemble weights updated:', this.ensemble.weights);
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
            barrier: analysis.consensusDigit.toString(),
        });

        // Store analysis for later use
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

        // Re-run analysis to confirm (market conditions may have changed)
        const freshAnalysis = this.ensemble.analyze(
            this.digitHistories[asset],
            this.priceHistories[asset]
        );

        if (!freshAnalysis.shouldTrade || freshAnalysis.consensusDigit !== analysis.consensusDigit) {
            console.log(`   ❌ Conditions changed — aborting`);
            return;
        }

        // Monte Carlo risk check
        const mcResult = MonteCarloSimulator.runSimulation(this.tradeHistory, 500, 50);

        const payout = parseFloat(proposal.payout || 0);
        const payoutPct = this.currentStake > 0 ? ((payout - this.currentStake) / this.currentStake * 100).toFixed(1) : '?';

        // Final entry confirmation
        if (freshAnalysis.consensusConfidence >= this.cfg.minEnsembleConfidence &&
            freshAnalysis.strategiesVoting >= this.cfg.minStrategyAgreement &&
            mcResult.canTrade) {

            console.log(`\n🎯 ENTRY SIGNAL — ${asset} [V2 ENSEMBLE]`);
            console.log(`   Consensus Digit: ${freshAnalysis.consensusDigit} (betting it will NOT appear)`);
            console.log(`   Confidence: ${(freshAnalysis.consensusConfidence * 100).toFixed(1)}%`);
            console.log(`   Agreement: ${(freshAnalysis.agreementScore * 100).toFixed(1)}%`);
            console.log(`   Strategies Voting: ${freshAnalysis.strategiesVoting}`);
            console.log(`   Regime: ${freshAnalysis.regime.regime} (${(freshAnalysis.regime.confidence * 100).toFixed(1)}%)`);
            console.log(`   Last 10 Digits: ${this.digitHistories[asset].slice(-10).join(',')}`);
            console.log(`   Stake: $${this.currentStake.toFixed(2)} | Payout: $${payout.toFixed(2)} (+${payoutPct}%)`);
            console.log(`   MC Risk of Ruin: ${(mcResult.riskOfRuin * 100).toFixed(2)}%`);
            console.log(`   MC Confidence: ${(mcResult.confidence * 100).toFixed(1)}%`);

            // Log individual strategy predictions
            console.log('\n   📊 Strategy Breakdown:');
            for (const [strategy, pred] of Object.entries(freshAnalysis.predictions)) {
                if (pred.shouldTrade) {
                    console.log(`      ${strategy}: digit ${pred.digit} (conf: ${(pred.confidence * 100).toFixed(1)}%)`);
                }
            }

            this._placeTrade(asset, freshAnalysis, proposal, mcResult);
        }
    }

    _placeTrade(asset, analysis, proposal, mcResult) {
        if (this.tradeInProgress) return;

        this._send({ buy: proposal.id, price: this.currentStake.toFixed(2) });

        this.tradeInProgress = true;
        this.activeTrades[asset] = {
            status: 'buying',
            proposalId: proposal.id,
            stake: this.currentStake,
            predictedDigit: analysis.consensusDigit,
            analysis,
            entryTime: Date.now(),
        };

        this._sendTelegram(
            `🎯 <b>BOTv2 Trade Opened (Ensemble)</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Consensus Digit: <b>${analysis.consensusDigit}</b> will NOT appear\n` +
            `Confidence: ${(analysis.consensusConfidence * 100).toFixed(1)}%\n` +
            `Agreement: ${(analysis.agreementScore * 100).toFixed(1)}%\n` +
            `Strategies: ${analysis.strategiesVoting}\n` +
            `Regime: ${analysis.regime.regime}\n` +
            `Last 10: ${this.digitHistories[asset].slice(-10).join(',')}\n` +
            `MC RoR: ${(mcResult.riskOfRuin * 100).toFixed(2)}%\n` +
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

        // Update strategy performance
        const analysis = trade.analysis;
        for (const [strategy, pred] of Object.entries(analysis.predictions)) {
            if (pred.shouldTrade && pred.digit === trade.predictedDigit) {
                const perf = this.strategyPerformance[strategy];
                perf.predictions++;
                if (won) {
                    perf.wins++;
                    perf.recentWins++;
                } else {
                    perf.losses++;
                }

                perf.recentPredictions.push(won);
                if (perf.recentPredictions.length > this.cfg.adaptiveWeightWindow) {
                    const removed = perf.recentPredictions.shift();
                    if (removed) perf.recentWins--;
                }
            }
        }

        // Add to trade history
        this.tradeHistory.push({
            won,
            profit,
            stake: trade.stake,
            predictedDigit: trade.predictedDigit,
            timestamp: Date.now()
        });

        if (this.tradeHistory.length > this.maxTradeHistory) {
            this.tradeHistory.shift();
        }

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`  ${won ? '✅ WIN' : '❌ LOSS'}: ${asset}`);
        console.log(`  Predicted: ${trade.predictedDigit} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
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

        // Calculate strategy win rates
        const strategyStats = Object.entries(this.strategyPerformance)
            .map(([name, perf]) => {
                const wr = perf.predictions > 0 ? (perf.wins / perf.predictions * 100).toFixed(1) : '0.0';
                return `${name}:${wr}%`;
            })
            .join(' | ');

        this._sendTelegram(
            `${won ? '✅' : '❌'} <b>BOTv2 Result</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Digit: ${trade.predictedDigit} | ${won ? 'Not appeared ✅' : 'Appeared ❌'}\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
            `Consecutive losses: ${this.consecutiveLosses}\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
            `Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%\n` +
            `Next stake: $${this.currentStake.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}\n\n` +
            `Strategy Win Rates:\n${strategyStats}`
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

        console.log('\n  Strategy Performance:');
        for (const [strategy, perf] of Object.entries(this.strategyPerformance)) {
            if (perf.predictions > 0) {
                const wr = (perf.wins / perf.predictions * 100).toFixed(1);
                console.log(`    ${strategy}: ${perf.wins}/${perf.predictions} (${wr}%) | Weight: ${(this.ensemble.weights[strategy] * 100).toFixed(1)}%`);
            }
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🎯 differBot V2 — Advanced Pattern Recognition');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`  Assets:      ${this.cfg.assets.join(', ')}`);
        console.log(`  Stake:       $${this.cfg.initialStake} × ${this.cfg.multiplier}x`);
        console.log(`  Strategies:  Markov | Patterns | Autocorr | Entropy | Bayesian | HMM`);
        console.log(`  Min Conf:    ${(this.cfg.minEnsembleConfidence * 100).toFixed(0)}%`);
        console.log(`  Min Agree:   ${this.cfg.minStrategyAgreement} strategies`);
        console.log('═══════════════════════════════════════════════════════════\n');

        this.connect();
        StatePersistence.startAutoSave(this);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
const bot = new DigitDifferBotV2(BOT_CONFIG);
bot.start();
