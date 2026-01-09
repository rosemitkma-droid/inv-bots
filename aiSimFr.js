/**
 * ============================================================
 * AI-LOGIC DERIV DIGIT DIFFER TRADING BOT v5.0
 * Simulated AI Ensemble with Advanced Statistical Methods
 * ============================================================
 * 
 * This version replaces external AI APIs with sophisticated
 * JavaScript-based statistical analysis engines that simulate
 * AI prediction capabilities.
 * 
 * SIMULATED AI ENGINES:
 * 1. Frequency Deviation Analyzer (FDA)
 * 2. Markov Chain Predictor (MCP)
 * 3. Entropy & Information Theory Engine (EITE)
 * 4. Pattern Recognition Neural Network (PRNN)
 * 5. Bayesian Probability Estimator (BPE)
 * 6. Gap Analysis & Mean Reversion (GAMR)
 * 7. Momentum & Trend Detector (MTD)
 * 8. Chaos Theory Attractor Finder (CTAF)
 * 9. Monte Carlo Simulator (MCS)
 * 10. Ensemble Meta-Learner (EML)
 * 
 * ============================================================
 */

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

// ============================================================
// SIMULATED AI ENGINE 1: Frequency Deviation Analyzer (FDA)
// Uses chi-square tests and frequency deviation analysis
// ============================================================

class FrequencyDeviationAnalyzer {
    constructor() {
        this.name = 'FDA';
        this.fullName = 'Frequency Deviation Analyzer';
        this.weight = 1.2;
        this.wins = 0;
        this.losses = 0;
        this.lastPrediction = null;
        this.lastOutcome = null;
    }

    analyze(tickHistory) {
        if (tickHistory.length < 150) {
            return { error: 'Insufficient data' };
        }

        const lastDigit = tickHistory[tickHistory.length - 1];

        const longWindow = Math.min(1000, tickHistory.length);
        const longSample = tickHistory.slice(-longWindow);
        const shortWindow = Math.min(60, tickHistory.length);
        const shortSample = tickHistory.slice(-shortWindow);

        const longCounts = Array(10).fill(0);
        const shortCounts = Array(10).fill(0);
        longSample.forEach(d => longCounts[d]++);
        shortSample.forEach(d => shortCounts[d]++);

        const longTotal = longSample.length;
        const shortTotal = shortSample.length;
        const expectedLong = longTotal / 10;
        const expectedShort = shortTotal / 10;

        const baseline = 0.1;
        const clamp01 = (x) => Math.max(0, Math.min(1, x));

        // Compute deviation and significance for each digit
        const analysis = [];
        for (let d = 0; d < 10; d++) {
            const longFreq = longCounts[d] / longTotal;
            const shortFreq = shortCounts[d] / shortTotal;
            const longDeviation = (longFreq - baseline) / baseline;
            const shortDeviation = (shortFreq - baseline) / baseline;

            // Chi-square component for this digit
            const chiContribution = Math.pow(longCounts[d] - expectedLong, 2) / expectedLong;

            // Z-score approximation for binomial
            const varLong = baseline * (1 - baseline) / longTotal;
            const zScore = varLong > 0 ? (longFreq - baseline) / Math.sqrt(varLong) : 0;

            // For DIGITDIFF: we want digits that are OVERREPRESENTED (likely to appear)
            // So we can bet that they will NOT appear next
            const overrepStrength = clamp01((longFreq - baseline) / baseline);
            const recentOverrepStrength = clamp01((shortFreq - baseline) / baseline);
            const combinedOverrep = 0.7 * overrepStrength + 0.3 * recentOverrepStrength;

            // Penalize if digit just appeared (gap = 0)
            const gap = this.calculateGap(tickHistory, d);
            const gapPenalty = gap === 0 ? 1 : 0;

            // Score: higher = more overrepresented = better for DIGITDIFF (bet against)
            const score =
                (1.2 * combinedOverrep) +
                (0.4 * clamp01(Math.abs(zScore) / 2)) +
                (0.3 * clamp01(chiContribution / 2)) -
                (0.9 * gapPenalty);

            analysis.push({
                digit: d,
                longFreq,
                shortFreq,
                longDeviation,
                shortDeviation,
                zScore,
                chiContribution,
                overrepStrength,
                recentOverrepStrength,
                combinedOverrep,
                gap,
                score
            });
        }

        // Overall chi-square for uniformity
        const chiSquare = analysis.reduce((sum, a) => sum + a.chiContribution, 0);
        const isUniform = chiSquare < 16.919; // df=9, p=0.05

        const sorted = analysis.sort((a, b) => b.score - a.score);
        const predicted = sorted.find(s => s.digit !== lastDigit) || sorted[0];

        // Confidence (can reach 100% with strong evidence)
        const evidenceStrength = clamp01((1 - Math.exp(-longTotal / 300)) * (1 - Math.exp(-Math.abs(predicted.zScore) / 2)));
        const runnerUp = sorted.find(s => s.digit !== predicted.digit && s.digit !== lastDigit) || sorted[1] || sorted[0];
        const separation = predicted.score - runnerUp.score;
        const separationStrength = clamp01(separation / 0.8);

        const composite =
            (0.45 * predicted.combinedOverrep) +
            (0.25 * separationStrength) +
            (0.15 * clamp01(Math.abs(predicted.zScore) / 2)) +
            (0.15 * clamp01(predicted.chiContribution / 2));

        let confidence = 40 + 60 * (composite * (0.4 + 0.6 * evidenceStrength));

        // Strong overrepresentation bonus
        const strongOverrepBonus =
            20 * predicted.combinedOverrep * clamp01(separation / 0.6) * clamp01(evidenceStrength);
        confidence = Math.min(100, confidence + strongOverrepBonus);
        confidence = Math.max(0, confidence);

        this.lastPrediction = predicted.digit;

        return {
            predictedDigit: predicted.digit,
            confidence: Math.round(confidence),
            primaryStrategy: 'Frequency Deviation Analysis',
            riskAssessment: (predicted.combinedOverrep < 0.08 || evidenceStrength < 0.3) ? 'high' : (predicted.combinedOverrep < 0.12 || evidenceStrength < 0.5) ? 'medium' : 'low',
            marketRegime: isUniform ? 'random' : 'patterned',
            statisticalEvidence: {
                lastState: lastDigit,
                chiSquare: chiSquare.toFixed(2),
                isUniform,
                longDeviation: predicted.longDeviation.toFixed(3),
                shortDeviation: predicted.shortDeviation.toFixed(3),
                zScore: predicted.zScore.toFixed(3),
                overrepStrength: predicted.overrepStrength.toFixed(3),
                recentOverrepStrength: predicted.recentOverrepStrength.toFixed(3),
                combinedOverrep: predicted.combinedOverrep.toFixed(3),
                gap: predicted.gap,
                evidenceStrength: evidenceStrength.toFixed(3)
            },
            alternativeCandidates: sorted
                .filter(s => s.digit !== predicted.digit && s.digit !== lastDigit)
                .slice(0, 2)
                .map(s => s.digit)
        };
    }

    calculateGap(tickHistory, digit) {
        for (let i = tickHistory.length - 1; i >= 0; i--) {
            if (tickHistory[i] === digit) {
                return tickHistory.length - 1 - i;
            }
        }
        return tickHistory.length;
    }

    calculatePValue(zScore) {
        // Approximation of two-tailed p-value
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const p = 0.3275911;

        const sign = zScore < 0 ? -1 : 1;
        const z = Math.abs(zScore) / Math.sqrt(2);
        const t = 1.0 / (1.0 + p * z);
        const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

        return 2 * (1 - (0.5 * (1.0 + sign * y)));
    }
}

// ============================================================
// SIMULATED AI ENGINE 2: Markov Chain Predictor (MCP)
// Uses transition probability matrices
// ============================================================
class MarkovChainPredictor {
    constructor() {
        this.name = 'MCP';
        this.fullName = 'Markov Chain Predictor';
        this.weight = 1.3;
        this.wins = 0;
        this.losses = 0;
        this.lastPrediction = null;
        this.lastOutcome = null;
    }

    analyze(tickHistory) {
        if (tickHistory.length < 100) {
            return { error: 'Insufficient data for Markov analysis' };
        }

        // Build first-order transition matrix
        const transitionMatrix = Array(10).fill(null).map(() => Array(10).fill(0));
        const transitionCounts = Array(10).fill(0);

        for (let i = 0; i < tickHistory.length - 1; i++) {
            const current = tickHistory[i];
            const next = tickHistory[i + 1];
            transitionMatrix[current][next]++;
            transitionCounts[current]++;
        }

        // Normalize to probabilities
        for (let i = 0; i < 10; i++) {
            if (transitionCounts[i] > 0) {
                for (let j = 0; j < 10; j++) {
                    transitionMatrix[i][j] /= transitionCounts[i];
                }
            }
        }

        // Build second-order transition matrix (bigram)
        const bigramMatrix = {};
        for (let i = 0; i < tickHistory.length - 2; i++) {
            const key = `${tickHistory[i]},${tickHistory[i + 1]}`;
            const next = tickHistory[i + 2];
            if (!bigramMatrix[key]) {
                bigramMatrix[key] = Array(10).fill(0);
            }
            bigramMatrix[key][next]++;
        }

        // Normalize bigram probabilities
        for (const key in bigramMatrix) {
            const total = bigramMatrix[key].reduce((a, b) => a + b, 0);
            if (total > 0) {
                bigramMatrix[key] = bigramMatrix[key].map(c => c / total);
            }
        }

        // Get predictions based on current state
        const lastDigit = tickHistory[tickHistory.length - 1];
        const secondLastDigit = tickHistory[tickHistory.length - 2];
        const bigramKey = `${secondLastDigit},${lastDigit}`;

        // First-order prediction
        const firstOrderProbs = transitionMatrix[lastDigit];

        // Second-order prediction (if available)
        const secondOrderProbs = bigramMatrix[bigramKey] || firstOrderProbs;

        // Combine predictions (weighted average)
        const combinedProbs = firstOrderProbs.map((p, i) => {
            const p2 = secondOrderProbs[i] || 0.1;
            return p * 0.4 + p2 * 0.6; // Weight second-order more
        });

        // For DIFFER: we want digit LEAST likely to appear
        const predictions = combinedProbs.map((prob, digit) => ({
            digit,
            probability: prob,
            differScore: (0.1 - prob) * 100 // Higher score = less likely to appear
        }));

        // Sort by differ score (highest = best for DIFFER)
        const sorted = predictions.sort((a, b) => b.differScore - a.differScore);
        const predicted = sorted[0];

        // Calculate confidence based on probability difference
        const probDiff = sorted[0].differScore - sorted[1].differScore;
        let confidence = 50 + probDiff * 2;

        // Boost if probability is significantly below expected
        if (predicted.probability < 0.05) confidence += 15;
        if (predicted.probability < 0.08) confidence += 10;

        confidence = Math.min(95, Math.max(50, confidence));

        // Calculate entropy of transition probabilities
        let entropy = 0;
        for (const p of combinedProbs) {
            if (p > 0) entropy -= p * Math.log2(p);
        }
        const normalizedEntropy = entropy / Math.log2(10);

        return {
            predictedDigit: predicted.digit,
            confidence: Math.round(confidence),
            primaryStrategy: 'Markov Chain Transition Analysis',
            riskAssessment: normalizedEntropy > 0.95 ? 'high' : normalizedEntropy > 0.85 ? 'medium' : 'low',
            marketRegime: normalizedEntropy > 0.95 ? 'random' : 'structured',
            statisticalEvidence: {
                transitionProbability: predicted.probability.toFixed(4),
                entropyLevel: normalizedEntropy.toFixed(4),
                lastState: lastDigit,
                bigramState: bigramKey
            },
            alternativeCandidates: [sorted[1].digit, sorted[2].digit]
        };
    }
}

// ============================================================
// SIMULATED AI ENGINE 3: Entropy & Information Theory (EITE)
// Uses Shannon entropy and information gain
// ============================================================
class EntropyInformationEngine {
    constructor() {
        this.name = 'EITE';
        this.fullName = 'Entropy Information Theory Engine';
        this.weight = 1.1;

        this.wins = 0;
        this.losses = 0;
        this.lastPrediction = null;
        this.lastOutcome = null;
    }

    analyze(tickHistory) {
        if (tickHistory.length < 100) {
            return { error: 'Insufficient data' };
        }

        const window200 = tickHistory.slice(-200);
        const window100 = tickHistory.slice(-100);
        const window50 = tickHistory.slice(-50);

        // Calculate entropy at different time scales
        const windows = [25, 50, 100, 200];
        const entropyByWindow = {};
        for (const w of windows) {
            const src = w === 25 ? tickHistory.slice(-25) : w === 50 ? window50 : w === 100 ? window100 : window200;
            if (src.length >= Math.min(w, 100)) {
                entropyByWindow[w] = this.calculateEntropy(src);
            }
        }

        // Calculate conditional entropy H(X|X-1)
        const conditionalEntropy = this.calculateConditionalEntropy(window200);

        // Calculate mutual information
        const mutualInfo = this.calculateMutualInformation(window200);

        const fullEntropy = this.calculateEntropy(window200);

        const counts200 = Array(10).fill(0);
        for (const d of window200) counts200[d]++;
        const probs200 = counts200.map(c => c / window200.length);

        const transitions = Array(10).fill(null).map(() => Array(10).fill(0));
        const transCounts = Array(10).fill(0);
        for (let i = 0; i < window200.length - 1; i++) {
            const a = window200[i];
            const b = window200[i + 1];
            transitions[a][b]++;
            transCounts[a]++;
        }

        const lastDigit = window200[window200.length - 1];
        const baseline = 0.1;

        const getCondProbs = (window) => {
            if (window.length < 2) return null;
            const t = Array(10).fill(null).map(() => Array(10).fill(0));
            const c = Array(10).fill(0);
            for (let i = 0; i < window.length - 1; i++) {
                const a = window[i];
                const b = window[i + 1];
                t[a][b]++;
                c[a]++;
            }
            if (c[lastDigit] <= 0) return null;
            return t[lastDigit].map(v => v / c[lastDigit]);
        };

        const condProbs200 = transCounts[lastDigit] > 0
            ? transitions[lastDigit].map(v => v / transCounts[lastDigit])
            : probs200;

        const condProbs100 = getCondProbs(window100);
        const condProbs50 = getCondProbs(window50);

        const candidates = condProbs200.map((p, digit) => {
            const marginalP = probs200[digit];
            const surprise = marginalP > 0 ? -Math.log2(marginalP) : 10;
            const differScore = (baseline - p) / baseline;
            return {
                digit,
                probability: p,
                marginalProbability: marginalP,
                surprise,
                differScore
            };
        });

        const sorted = candidates.sort((a, b) => b.differScore - a.differScore);

        let finalPrediction = sorted[0];
        if (finalPrediction.digit === lastDigit && sorted.length > 1) {
            finalPrediction = sorted[1];
        }

        const predictedIndex = sorted.findIndex(s => s.digit === finalPrediction.digit);
        const nextCandidate = predictedIndex >= 0 ? sorted[predictedIndex + 1] : null;

        const p = finalPrediction.probability;
        const rarityScore = Math.max(0, baseline - p) / baseline;
        const separation = nextCandidate ? Math.max(0, nextCandidate.probability - p) : 0;
        const separationScore = Math.min(1, separation / baseline);
        const predictabilityScore = Math.min(1, Math.max(0, 1 - conditionalEntropy));
        const mutualInfoScore = Math.min(1, Math.max(0, mutualInfo / 0.2));

        const p100 = condProbs100 ? condProbs100[finalPrediction.digit] : null;
        const p50 = condProbs50 ? condProbs50[finalPrediction.digit] : null;
        const stability100 = p100 === null ? 0.5 : 1 - Math.min(1, Math.abs(p100 - p) / 0.05);
        const stability50 = p50 === null ? 0.5 : 1 - Math.min(1, Math.abs(p50 - p) / 0.05);
        const stabilityScore = Math.max(0, Math.min(1, (stability100 + stability50) / 2));

        let confidence = 50;
        confidence += rarityScore * 35;
        confidence += separationScore * 20;
        confidence += predictabilityScore * 15;
        confidence += stabilityScore * 10;
        confidence += mutualInfoScore * 10;
        if (p < 0.01) confidence += 5;
        if (p < 0.005) confidence += 5;
        confidence = Math.min(100, Math.max(50, confidence));

        this.lastPrediction = finalPrediction.digit;

        return {
            predictedDigit: finalPrediction.digit,
            confidence: Math.round(confidence),
            primaryStrategy: 'Entropy Information Theory',
            riskAssessment: finalPrediction.marginalProbability.toFixed(4) >= 0.1000 ? 'high' : finalPrediction.marginalProbability.toFixed(4) > 0.0900 ? 'medium' : 'low',
            marketRegime: finalPrediction.marginalProbability.toFixed(4) >= 0.1000 ? 'random' : finalPrediction.marginalProbability.toFixed(4) > 0.0900 ? 'semi-random' : 'patterned',
            statisticalEvidence: {
                entropy: fullEntropy.toFixed(4),
                conditionalEntropy: conditionalEntropy.toFixed(4),
                mutualInformation: mutualInfo.toFixed(4),
                surpriseValue: finalPrediction.surprise.toFixed(3),
                marginalProbability: finalPrediction.marginalProbability.toFixed(4)
            },
            alternativeCandidates: [sorted[1].digit, sorted[2].digit]
        };
    }

    calculateEntropy(digits) {
        const counts = Array(10).fill(0);
        digits.forEach(d => counts[d]++);
        const total = digits.length;

        let entropy = 0;
        for (const count of counts) {
            if (count > 0) {
                const p = count / total;
                entropy -= p * Math.log2(p);
            }
        }
        return entropy / Math.log2(10); // Normalize to 0-1
    }

    calculateConditionalEntropy(digits) {
        if (digits.length < 50) return 1;

        const jointCounts = Array(10).fill(null).map(() => Array(10).fill(0));
        const marginalCounts = Array(10).fill(0);

        for (let i = 0; i < digits.length - 1; i++) {
            jointCounts[digits[i]][digits[i + 1]]++;
            marginalCounts[digits[i]]++;
        }

        let conditionalEntropy = 0;
        const total = digits.length - 1;

        for (let x = 0; x < 10; x++) {
            if (marginalCounts[x] > 0) {
                const px = marginalCounts[x] / total;
                let hYgivenX = 0;

                for (let y = 0; y < 10; y++) {
                    if (jointCounts[x][y] > 0) {
                        const pyGivenX = jointCounts[x][y] / marginalCounts[x];
                        hYgivenX -= pyGivenX * Math.log2(pyGivenX);
                    }
                }
                conditionalEntropy += px * hYgivenX;
            }
        }

        return conditionalEntropy / Math.log2(10);
    }

    calculateMutualInformation(digits) {
        const entropy = this.calculateEntropy(digits);
        const conditionalEntropy = this.calculateConditionalEntropy(digits);
        return Math.max(0, entropy - conditionalEntropy);
    }
}

// ============================================================
// SIMULATED AI ENGINE 4: Pattern Recognition Neural Network (PRNN)
// Uses n-gram analysis and pattern matching
// ============================================================
class PatternRecognitionEngine {
    constructor() {
        this.name = 'PRNN';
        this.fullName = 'Pattern Recognition Neural Network';
        this.weight = 1.2;
        this.wins = 0;
        this.losses = 0;
        this.lastPrediction = null;
        this.lastOutcome = null;
        this.patternMemory = new Map();
    }

    analyze(tickHistory) {
        if (tickHistory.length < 100) {
            return { error: 'Insufficient data' };
        }

        const recent = tickHistory.slice(-100)

        const results = [];

        // Analyze patterns of different lengths (2-5 digits)
        for (let patternLength = 2; patternLength <= 5; patternLength++) {
            const patternResult = this.analyzePatternLength(recent, patternLength);
            if (patternResult) results.push(patternResult);
        }

        // Analyze repeating sequences
        const sequenceResult = this.analyzeRepeatingSequences(recent);
        if (sequenceResult) results.push(sequenceResult);

        // Analyze digit clusters
        const clusterResult = this.analyzeDigitClusters(recent);
        if (clusterResult) results.push(clusterResult);

        if (results.length === 0) {
            return this.fallbackPrediction(recent);
        }

        // Combine results using weighted voting
        const votes = Array(10).fill(0);
        const confidences = Array(10).fill().map(() => []);

        for (const result of results) {
            const digit = result.predictedDigit;
            votes[digit] += result.weight;
            confidences[digit].push(result.confidence);
        }

        // Find winning digit
        let maxVotes = 0;
        let predicted = 0;
        for (let i = 0; i < 10; i++) {
            if (votes[i] > maxVotes) {
                maxVotes = votes[i];
                predicted = i;
            }
        }

        // Don't predict last digit
        if (predicted === tickHistory[tickHistory.length - 1]) {
            votes[predicted] = -1;
            maxVotes = 0;
            for (let i = 0; i < 10; i++) {
                if (votes[i] > maxVotes) {
                    maxVotes = votes[i];
                    predicted = i;
                }
            }
        }

        // Calculate average confidence
        const avgConf = confidences[predicted].length > 0
            ? confidences[predicted].reduce((a, b) => a + b, 0) / confidences[predicted].length
            : 50;

        // Get alternative candidates
        const alternatives = votes
            .map((v, i) => ({ digit: i, votes: v }))
            .filter(x => x.digit !== predicted)
            .sort((a, b) => b.votes - a.votes)
            .slice(0, 2)
            .map(x => x.digit);

        return {
            predictedDigit: predicted,
            confidence: Math.round(avgConf),
            primaryStrategy: 'Pattern Recognition',
            riskAssessment: avgConf >= 75 ? 'low' : avgConf >= 60 ? 'medium' : 'high',
            marketRegime: results.length > 2 ? 'patterned' : 'semi-random',
            statisticalEvidence: {
                patternsFound: results.length,
                patternTypes: results.map(r => r.type).join(', '),
                maxPatternWeight: Math.max(...results.map(r => r.weight)).toFixed(2)
            },
            alternativeCandidates: alternatives
        };
    }

    analyzePatternLength(recent, length) {
        const patterns = new Map();
        const sample = recent.slice(-500);

        // Build pattern frequency map
        for (let i = 0; i <= sample.length - length - 1; i++) {
            const pattern = sample.slice(i, i + length).join(',');
            const nextDigit = sample[i + length];

            if (!patterns.has(pattern)) {
                patterns.set(pattern, Array(10).fill(0));
            }
            patterns.get(pattern)[nextDigit]++;
        }

        // Get current pattern
        const currentPattern = recent.slice(-length).join(',');

        if (!patterns.has(currentPattern)) {
            return null;
        }

        const nextProbs = patterns.get(currentPattern);
        const total = nextProbs.reduce((a, b) => a + b, 0);

        if (total < 3) return null; // Need at least 3 occurrences

        // Find digit least likely to appear (for DIFFER)
        const predictions = nextProbs.map((count, digit) => ({
            digit,
            probability: count / total
        }));

        const sorted = predictions.sort((a, b) => a.probability - b.probability);
        const predicted = sorted[0]; // Lowest probability = best for DIFFER

        // Confidence based on sample size and probability
        let confidence = 50;
        if (total >= 10) confidence += 15;
        if (total >= 20) confidence += 10;
        if (predicted.probability < 0.05) confidence += 10;

        return {
            predictedDigit: predicted.digit,
            confidence: Math.min(90, confidence),
            weight: 1.0 + (length - 2) * 0.2,
            type: `${length}-gram`
        };
    }

    analyzeRepeatingSequences(recent) {
        const last20 = recent.slice(-20);

        // Check for repeating pairs
        const pairs = [];
        for (let i = 0; i < last20.length - 1; i++) {
            pairs.push(`${last20[i]},${last20[i + 1]}`);
        }

        const pairCounts = {};
        pairs.forEach(p => pairCounts[p] = (pairCounts[p] || 0) + 1);

        // Find most repeated pair
        let maxPair = null;
        let maxCount = 0;
        for (const [pair, count] of Object.entries(pairCounts)) {
            if (count > maxCount) {
                maxCount = count;
                maxPair = pair;
            }
        }

        if (maxCount < 2) return null;

        // If a pair repeats, the digits in it are "hot" - predict them for DIFFER
        const hotDigits = maxPair.split(',').map(Number);
        const predicted = hotDigits[Math.floor(Math.random() * hotDigits.length)];

        return {
            predictedDigit: predicted,
            confidence: 55 + maxCount * 5,
            weight: 0.8,
            type: 'sequence-repeat'
        };
    }

    analyzeDigitClusters(recent) {
        const last30 = recent.slice(-30);

        // Find digit that appeared in clusters (multiple times in short span)
        const clusterScores = Array(10).fill(0);

        for (let i = 0; i < last30.length - 5; i++) {
            const window = last30.slice(i, i + 5);
            const counts = Array(10).fill(0);
            window.forEach(d => counts[d]++);

            // Digit appearing 3+ times in 5 ticks is clustered
            for (let d = 0; d < 10; d++) {
                if (counts[d] >= 3) {
                    clusterScores[d] += counts[d];
                }
            }
        }

        const maxCluster = Math.max(...clusterScores);
        if (maxCluster < 3) return null;

        // Clustered digit is "exhausted" - good for DIFFER
        const predicted = clusterScores.indexOf(maxCluster);

        return {
            predictedDigit: predicted,
            confidence: 55 + maxCluster * 3,
            weight: 0.9,
            type: 'cluster-exhaustion'
        };
    }

    fallbackPrediction(recent) {
        const counts = Array(10).fill(0);
        recent.slice(-100).forEach(d => counts[d]++);

        const maxCount = Math.max(...counts);
        const predicted = counts.indexOf(maxCount);

        return {
            predictedDigit: predicted,
            confidence: 55,
            primaryStrategy: 'Pattern Recognition (Fallback)',
            riskAssessment: 'medium',
            marketRegime: 'unknown',
            statisticalEvidence: { method: 'fallback' },
            alternativeCandidates: []
        };
    }
}

// ============================================================
// SIMULATED AI ENGINE 5: Bayesian Probability Estimator (BPE)
// Uses Bayesian updating and posterior probabilities
// ============================================================
class BayesianProbabilityEstimator {
    constructor() {
        this.name = 'BPE';
        this.fullName = 'Bayesian Probability Estimator';
        this.weight = 1.15;

        this.wins = 0;
        this.losses = 0;
        this.lastPrediction = null;
        this.lastOutcome = null;

        // Prior probabilities (Dirichlet prior with alpha=1 = uniform)
        this.priorAlpha = Array(10).fill(1);
    }

    analyze(tickHistory) {
        if (tickHistory.length < 100) {
            return { error: 'Insufficient data' };
        }

        const window = tickHistory.slice(-1000);
        const lastDigit = window[window.length - 1];
        const baseline = 0.1;

        // Build conditional transition counts: count(lastDigit -> nextDigit)
        const transitionCounts = Array(10).fill(null).map(() => Array(10).fill(0));
        const stateCounts = Array(10).fill(0);
        for (let i = 0; i < window.length - 1; i++) {
            const a = window[i];
            const b = window[i + 1];
            transitionCounts[a][b]++;
            stateCounts[a]++;
        }

        const n = stateCounts[lastDigit];
        const posteriorAlpha = this.priorAlpha.map((a, j) => a + transitionCounts[lastDigit][j]);
        const totalAlpha = posteriorAlpha.reduce((a, b) => a + b, 0);
        const posteriorMean = posteriorAlpha.map(a => a / totalAlpha);
        const posteriorVariance = posteriorAlpha.map(a => (a * (totalAlpha - a)) / (totalAlpha * totalAlpha * (totalAlpha + 1)));

        const credibleIntervals = posteriorMean.map((mean, i) => {
            const std = Math.sqrt(posteriorVariance[i]);
            return {
                lower: Math.max(0, mean - 1.96 * std),
                upper: Math.min(1, mean + 1.96 * std)
            };
        });

        // For DIGITDIFF: choose the digit least likely to appear next
        const predictions = posteriorMean.map((prob, digit) => ({
            digit,
            posteriorProb: prob,
            variance: posteriorVariance[digit],
            credibleInterval: credibleIntervals[digit],
            // Higher is better for DIFFER when prob < 0.1
            differScore: (baseline - prob) / baseline
        }));

        const sorted = predictions.sort((a, b) => b.differScore - a.differScore);
        let predicted = sorted[0];
        if (predicted.digit === lastDigit && sorted.length > 1) {
            predicted = sorted[1];
        }

        // Confidence: rarity + separation + evidence strength + credible interval below baseline
        const p = predicted.posteriorProb;
        const p2 = sorted.find(s => s.digit !== predicted.digit)?.posteriorProb ?? baseline;
        const separation = Math.max(0, p2 - p);

        const rarityScore = Math.max(0, baseline - p) / baseline;
        const separationScore = Math.min(1, separation / baseline);
        const evidenceScore = Math.min(1, n / 25);

        let confidence = 50;
        confidence += rarityScore * 40;
        confidence += separationScore * 25;
        confidence += evidenceScore * 15;
        if (predicted.credibleInterval.upper < baseline) confidence += 10;
        if (p < 0.05) confidence += 5;
        if (p < 0.02) confidence += 5;
        confidence = Math.min(100, Math.max(50, confidence));

        // Entropy of the conditional distribution
        let entropy = 0;
        for (const prob of posteriorMean) {
            if (prob > 0) entropy -= prob * Math.log2(prob);
        }
        const normalizedEntropy = entropy / Math.log2(10);

        this.lastPrediction = predicted.digit;

        const alternativeCandidates = sorted
            .filter(s => s.digit !== predicted.digit)
            .slice(0, 2)
            .map(s => s.digit);

        return {
            predictedDigit: predicted.digit,
            confidence: Math.round(confidence),
            primaryStrategy: 'Bayesian Conditional Transition Estimation',
            riskAssessment: normalizedEntropy > 0.99 ? 'low' : normalizedEntropy > 0.98 ? 'medium' : 'high',
            marketRegime: normalizedEntropy > 0.99 ? 'stable' : 'volatile',
            statisticalEvidence: {
                lastState: lastDigit,
                transitionCount: n,
                posteriorProbability: predicted.posteriorProb.toFixed(4),
                variance: predicted.variance.toFixed(6),
                credibleInterval: `[${predicted.credibleInterval.lower.toFixed(3)}, ${predicted.credibleInterval.upper.toFixed(3)}]`,
                entropyLevel: normalizedEntropy.toFixed(4)
            },
            alternativeCandidates: alternativeCandidates
        };
    }
}

// ============================================================
// SIMULATED AI ENGINE 6: Gap Analysis & Mean Reversion (GAMR)
// Uses gap lengths and mean reversion principles
// ============================================================
class GapMeanReversionAnalyzer {
    constructor() {
        this.name = 'GAMR';
        this.fullName = 'Gap Analysis Mean Reversion';
        this.weight = 1.25;
        this.wins = 0;
        this.losses = 0;
        this.lastPrediction = null;
        this.lastOutcome = null;
    }

    analyze(tickHistory) {
        if (tickHistory.length < 150) {
            return { error: 'Insufficient data' };
        }

        const lastDigit = tickHistory[tickHistory.length - 1];

        const historyWindow = Math.min(800, tickHistory.length);
        const history = tickHistory.slice(-historyWindow);

        const freqWindow = Math.min(60, tickHistory.length);
        const recentFreqSlice = tickHistory.slice(-freqWindow);

        // Calculate gap for each digit (how long since it last appeared)
        const gaps = this.calculateCurrentGaps(history);

        // Calculate historical gap statistics
        const historicalGaps = this.calculateHistoricalGaps(history);

        // Recent/long frequencies (mean reversion signal)
        const longCounts = Array(10).fill(0);
        for (const d of history) longCounts[d]++;
        const longFreq = longCounts.map(c => c / history.length);

        const recentCounts = Array(10).fill(0);
        for (const d of recentFreqSlice) recentCounts[d]++;
        const recentFreq = recentCounts.map(c => c / recentFreqSlice.length);

        // Conditional posterior from lastDigit -> nextDigit (Dirichlet smoothing)
        const alpha = 0.6;
        const fromCounts = Array(10).fill(0);
        let totalFromLast = 0;
        for (let i = 1; i < history.length; i++) {
            if (history[i - 1] === lastDigit) {
                fromCounts[history[i]]++;
                totalFromLast++;
            }
        }
        const denom = totalFromLast + 10 * alpha;
        const posteriorMean = fromCounts.map(c => (c + alpha) / denom);

        // Mean reversion analysis for DIGITDIFF: pick the least-likely next digit
        // based on (1) low conditional probability, (2) short gap, (3) recent overrepresentation.
        const meanReversionScores = [];

        const clamp01 = (x) => Math.max(0, Math.min(1, x));
        const baseline = 0.1;
        const condReliability = clamp01(totalFromLast / 25);

        for (let d = 0; d < 10; d++) {
            const currentGap = gaps[d];
            const avgGap = historicalGaps[d].mean;
            const stdGap = historicalGaps[d].std;
            const maxGap = historicalGaps[d].max;

            // Z-score of current gap
            const gapZScore = stdGap > 1e-9 ? (currentGap - avgGap) / stdGap : 0;

            // Percentile of current gap
            const gapPercentile = historicalGaps[d].percentile(currentGap);

            const pCond = posteriorMean[d];

            // Strength signals (0..1)
            const lowProbStrength = clamp01((baseline - pCond) / baseline);
            const gapSmallStrength = clamp01((avgGap - currentGap) / Math.max(1, avgGap));
            const overrep = recentFreq[d] - longFreq[d];
            const overrepStrength = clamp01(overrep / 0.12);
            const overduePenalty = clamp01((currentGap - avgGap) / Math.max(1, 2 * stdGap + 1));
            const longBelowUniformStrength = clamp01((baseline - longFreq[d]) / baseline);

            const score =
                (1.25 * lowProbStrength * condReliability) +
                (0.55 * overrepStrength) +
                (0.45 * gapSmallStrength) +
                (0.25 * longBelowUniformStrength) -
                (0.85 * overduePenalty);

            meanReversionScores.push({
                digit: d,
                currentGap,
                avgGap,
                maxGap,
                gapZScore,
                gapPercentile,
                meanReversionScore: score,
                pCond,
                lowProbStrength,
                gapSmallStrength,
                overrepStrength,
                overduePenalty,
                isOverdue: currentGap > avgGap * 1.5
            });
        }

        const sorted = meanReversionScores.sort((a, b) => b.meanReversionScore - a.meanReversionScore);

        // Don't predict the last digit
        const predicted = sorted.find(s => s.digit !== lastDigit) || sorted[0];

        // Calculate confidence (can reach 100% with strong evidence)
        const evidenceStrength = clamp01((1 - Math.exp(-totalFromLast / 40)) * (1 - Math.exp(-history.length / 300)));
        const runnerUp = sorted.find(s => s.digit !== predicted.digit && s.digit !== lastDigit) || sorted[1] || sorted[0];
        const separation = predicted.meanReversionScore - runnerUp.meanReversionScore;
        const separationStrength = clamp01(separation / 0.9);

        const composite =
            (0.45 * predicted.lowProbStrength) +
            (0.20 * predicted.gapSmallStrength) +
            (0.20 * predicted.overrepStrength) +
            (0.15 * separationStrength);

        let confidence = 40 + 60 * (composite * (0.35 + 0.65 * evidenceStrength));

        // Strong posterior + strong evidence bonus
        const strongPosteriorBonus =
            20 * clamp01((baseline - predicted.pCond) / baseline) * clamp01(totalFromLast / 120) * clamp01(separation / 1.0);
        confidence = Math.min(100, confidence + strongPosteriorBonus);
        confidence = Math.max(0, confidence);

        this.lastPrediction = predicted.digit;

        return {
            predictedDigit: predicted.digit,
            confidence: Math.round(confidence),
            primaryStrategy: 'Gap Analysis Mean Reversion',
            riskAssessment: (predicted.pCond > 0.12 || predicted.overduePenalty > 0.5) ? 'high' : (evidenceStrength < 0.35 || predicted.pCond > 0.10) ? 'medium' : 'low',
            marketRegime: predicted.pCond.toFixed(4) >= 0.1 ? 'volatile' : predicted.pCond.toFixed(4) > 0.06 ? 'normal' : 'stable',//this.detectGapRegime(historicalGaps),
            statisticalEvidence: {
                lastState: lastDigit,
                transitionsFromLast: totalFromLast,
                currentGap: predicted.currentGap,
                averageGap: predicted.avgGap.toFixed(2),
                gapZScore: predicted.gapZScore.toFixed(3),
                gapPercentile: (predicted.gapPercentile * 100).toFixed(1) + '%',
                conditionalProbability: predicted.pCond.toFixed(4),
                evidenceStrength: evidenceStrength.toFixed(3),
                isOverdue: predicted.isOverdue,
                detectGapRegime: this.detectGapRegime(historicalGaps),
            },
            alternativeCandidates: sorted
                .filter(s => s.digit !== predicted.digit && s.digit !== lastDigit)
                .slice(0, 2)
                .map(s => s.digit)
        };
    }

    calculateCurrentGaps(tickHistory) {
        const gaps = Array(10).fill(tickHistory.length); // Default to max if never seen

        for (let i = tickHistory.length - 1; i >= 0; i--) {
            const digit = tickHistory[i];
            if (gaps[digit] === tickHistory.length) {
                gaps[digit] = tickHistory.length - 1 - i;
            }
        }

        return gaps;
    }

    calculateHistoricalGaps(tickHistory) {
        const gapHistory = Array(10).fill(null).map(() => []);
        const lastSeen = Array(10).fill(-1);

        for (let i = 0; i < tickHistory.length; i++) {
            const digit = tickHistory[i];
            if (lastSeen[digit] >= 0) {
                gapHistory[digit].push(i - lastSeen[digit]);
            }
            lastSeen[digit] = i;
        }

        return gapHistory.map((gaps, digit) => {
            if (gaps.length === 0) {
                return {
                    mean: 10,
                    std: 3,
                    max: 30,
                    min: 1,
                    percentile: (g) => 0.5
                };
            }

            const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            const variance = gaps.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / gaps.length;
            const std = Math.sqrt(variance);
            const max = Math.max(...gaps);
            const min = Math.min(...gaps);

            const sortedGaps = [...gaps].sort((a, b) => a - b);
            const percentile = (g) => {
                const index = sortedGaps.findIndex(x => x >= g);
                return index === -1 ? 1 : index / sortedGaps.length;
            };

            return { mean, std, max, min, percentile };
        });
    }

    detectGapRegime(historicalGaps) {
        const avgStd = historicalGaps.reduce((a, b) => a + b.std, 0) / 10;
        // console.log('Average standard deviation:', avgStd);
        if (avgStd > 5) return 'volatile';
        if (avgStd > 3) return 'normal';
        return 'stable';
    }
}

// ============================================================
// SIMULATED AI ENGINE 7: Momentum & Trend Detector (MTD)
// Uses momentum indicators and trend analysis
// ============================================================
class MomentumTrendDetector {
    constructor() {
        this.name = 'MTD';
        this.fullName = 'Momentum Trend Detector';
        this.weight = 1.1;
        this.wins = 0;
        this.losses = 0;
        this.lastPrediction = null;
        this.lastOutcome = null;
    }

    analyze(tickHistory) {
        if (tickHistory.length < 150) {
            return { error: 'Insufficient data' };
        }

        const lastDigit = tickHistory[tickHistory.length - 1];

        const historyWindow = Math.min(900, tickHistory.length);
        const history = tickHistory.slice(-historyWindow);

        // Momentum and RoC
        const momentum = this.calculateDigitMomentum(history);
        const roc = this.calculateRateOfChange(history);
        const trend = this.calculateTrendStrength(history);

        // For DIGITDIFF: score digits that are hot and likely to exhaust soon
        const scores = [];
        const clamp01 = (x) => Math.max(0, Math.min(1, x));

        for (let d = 0; d < 10; d++) {
            const m = momentum[d];
            const r = roc[d];
            const isHot = m > 0.5;
            const isAccelerating = r > 0;
            const isDecelerating = r < -0.1;
            const isVeryHot = m > 1.0;
            const isMildlyHot = m > 0.3;

            // Exhaustion signals (higher = better for DIGITDIFF)
            let score = 0;
            if (isHot) {
                score += 0.45 * clamp01(m); // hotness
                if (isAccelerating) score += 0.25 * clamp01(m); // hot + accelerating = may exhaust soon
                if (isDecelerating) score += 0.35 * clamp01(m); // hot + decelerating = exhaustion
                if (isVeryHot) score += 0.30;
            }
            if (isMildlyHot && isDecelerating) score += 0.20; // mild but slowing

            // Trend penalty: strong trends make exhaustion less reliable
            const trendPenalty = clamp01(trend.strength / 0.4);
            score *= (1 - 0.5 * trendPenalty);

            scores.push({
                digit: d,
                momentum: m,
                roc: r,
                isHot,
                isAccelerating,
                isDecelerating,
                isVeryHot,
                score
            });
        }

        const sorted = scores.sort((a, b) => b.score - a.score);
        const predicted = sorted.find(s => s.digit !== lastDigit) || sorted[0];

        // Confidence (can reach 100% with strong evidence)
        const evidenceStrength = clamp01((1 - Math.exp(-history.length / 300)) * (1 - Math.exp(-Math.abs(trend.slope) / 0.02)));
        const runnerUp = sorted.find(s => s.digit !== predicted.digit && s.digit !== lastDigit) || sorted[1] || sorted[0];
        const separation = predicted.score - runnerUp.score;
        const separationStrength = clamp01(separation / 0.8);

        const hotnessStrength = clamp01(predicted.momentum);
        const decelerationBonus = predicted.isDecelerating ? 0.2 : 0;
        const acceleratingBonus = predicted.isAccelerating ? 0.1 : 0;

        const composite =
            (0.35 * hotnessStrength) +
            (0.25 * separationStrength) +
            (0.20 * decelerationBonus) +
            (0.10 * acceleratingBonus) +
            (0.10 * (predicted.isVeryHot ? 1 : 0));

        let confidence = 40 + 60 * (composite * (0.4 + 0.6 * evidenceStrength));

        // Strong exhaustion bonus
        const strongExhaustionBonus =
            15 * clamp01(predicted.momentum) * clamp01(separation / 0.6) * clamp01(evidenceStrength);
        confidence = Math.min(100, confidence + strongExhaustionBonus);
        confidence = Math.max(0, confidence);

        this.lastPrediction = predicted.digit;

        return {
            predictedDigit: predicted.digit,
            confidence: Math.round(confidence),
            primaryStrategy: 'Momentum Trend Detection',
            riskAssessment: (predicted.momentum < 0.3 || trend.strength > 0.35) ? 'high' : (evidenceStrength < 0.3 || predicted.momentum < 0.5) ? 'medium' : 'low',
            marketRegime: trend.strength > 0.3 ? 'trending' : trend.strength > 0.1 ? 'ranging' : 'stable',
            statisticalEvidence: {
                lastState: lastDigit,
                momentum: predicted.momentum.toFixed(3),
                rateOfChange: predicted.roc.toFixed(3),
                isHot: predicted.isHot,
                isAccelerating: predicted.isAccelerating,
                isDecelerating: predicted.isDecelerating,
                isVeryHot: predicted.isVeryHot,
                trendStrength: trend.strength.toFixed(3),
                trendDirection: trend.direction,
                evidenceStrength: evidenceStrength.toFixed(3)
            },
            alternativeCandidates: sorted
                .filter(s => s.digit !== predicted.digit && s.digit !== lastDigit)
                .slice(0, 2)
                .map(s => s.digit)
        };
    }

    calculateDigitMomentum(tickHistory) {
        const momentum = Array(10).fill(0);

        // Recent window vs longer window
        const short = tickHistory.slice(-20);
        const long = tickHistory.slice(-100);

        const shortCounts = Array(10).fill(0);
        const longCounts = Array(10).fill(0);

        short.forEach(d => shortCounts[d]++);
        long.forEach(d => longCounts[d]++);

        for (let d = 0; d < 10; d++) {
            const shortFreq = shortCounts[d] / 20;
            const longFreq = longCounts[d] / 100;
            momentum[d] = (shortFreq - longFreq) / (longFreq + 0.01);
        }

        return momentum;
    }

    calculateRateOfChange(tickHistory) {
        const roc = Array(10).fill(0);

        // Compare last 10 to previous 10
        const recent = tickHistory.slice(-10);
        const previous = tickHistory.slice(-20, -10);

        const recentCounts = Array(10).fill(0);
        const prevCounts = Array(10).fill(0);

        recent.forEach(d => recentCounts[d]++);
        previous.forEach(d => prevCounts[d]++);

        for (let d = 0; d < 10; d++) {
            roc[d] = (recentCounts[d] - prevCounts[d]) / (prevCounts[d] + 1);
        }

        return roc;
    }

    calculateTrendStrength(tickHistory) {
        const recent = tickHistory.slice(-50);

        // Simple linear regression on digit values
        const n = recent.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

        for (let i = 0; i < n; i++) {
            sumX += i;
            sumY += recent[i];
            sumXY += i * recent[i];
            sumX2 += i * i;
        }

        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const strength = Math.abs(slope);
        const direction = slope > 0 ? 'up' : slope < 0 ? 'down' : 'flat';

        return { strength, direction, slope };
    }
}


// SIMULATED AI ENGINE 8: Chaos Theory Attractor Finder (CTAF)
// Uses chaos theory concepts like attractors and phase space
// ============================================================
class ChaosTheoryAnalyzer {
    constructor() {
        this.name = 'CTAF';
        this.fullName = 'Chaos Theory Attractor Finder';
        this.weight = 1.0;

        this.wins = 0;
        this.losses = 0;
        this.lastPrediction = null;
        this.lastOutcome = null;
    }

    analyze(tickHistory) {
        if (tickHistory.length < 100) {
            return { error: 'Insufficient data' };
        }

        const sample = tickHistory.slice(-100);
        const counts = Array(10).fill(0);
        sample.forEach(d => counts[d]++);

        let dimension = tickHistory.length >= 3000 ? 3 : 2;
        let phaseSpace = this.buildPhaseSpace(tickHistory, dimension);
        let attractors = this.findAttractors(phaseSpace);

        const alpha = 1;

        const lyapunov = this.approximateLyapunov(tickHistory);

        // Recurrence analysis
        const recurrence = this.analyzeRecurrence(tickHistory);

        // Current state in phase space
        let currentState = tickHistory.slice(-dimension).join(',');
        let currentAttractor = attractors.get(currentState);

        // If the current embedded state is too rare, fall back to a lower dimension
        if (dimension > 1 && (!currentAttractor || currentAttractor.total < 10)) {
            dimension = 1;
            phaseSpace = this.buildPhaseSpace(tickHistory, dimension);
            attractors = this.findAttractors(phaseSpace);
            currentState = tickHistory.slice(-dimension).join(',');
            currentAttractor = attractors.get(currentState);
        }

        const totalStates = phaseSpace.length;

        // Predict based on attractor dynamics
        const predictions = [];

        const lastTickDigit = tickHistory[tickHistory.length - 1];
        const nextStatePrefix = dimension > 1 ? tickHistory.slice(-(dimension - 1)) : [];

        for (let d = 0; d < 10; d++) {
            const nextState = [...nextStatePrefix, d].join(',');
            const nextAttractor = attractors.get(nextState) || { count: 0, transitions: Array(10).fill(0), total: 0 };

            // Score based on:
            // 1. How often this state is visited (attractor strength)
            // 2. Transition probability from current state
            let score = 0;

            let transitionProb = 0.1;
            let transitionSamples = 0;

            const digitFreq = counts[d] / sample.length;

            // If next state is rarely visited, it's less likely = good for DIFFER
            const rarity = Math.max(0, 5 - nextAttractor.count);
            score += rarity * 2;

            // Overrepresented digits are often decent contrarian picks for DIFFER
            if (digitFreq > 0.1) {
                score += (digitFreq - 0.1) * 60;
            }

            // Avoid choosing the last tick digit (keeps behavior consistent with shouldExecuteTrade)
            if (d === lastTickDigit) {
                score -= 15;
            }

            // Check if current state typically leads to this digit
            if (currentAttractor && currentAttractor.total > 0) {
                transitionSamples = currentAttractor.total;
                const transitionCount = currentAttractor.transitions[d] || 0;
                transitionProb = (transitionCount + alpha) / (transitionSamples + 10 * alpha);
                // Lower transition prob = less likely = good for DIFFER
                score += (0.1 - transitionProb) * 100;
            }

            // Recurrence penalty: if digit recurs too often, it might not recur now
            if (recurrence.digitRecurrence[d] > 0.15) {
                score += 5;
            }

            predictions.push({
                digit: d,
                score,
                attractorStrength: nextAttractor.count,
                nextState,
                transitionProb,
                transitionSamples
            });
        }

        // Sort by score
        const sorted = predictions.sort((a, b) => b.score - a.score);

        let predicted = sorted[0];
        if (predicted.digit === tickHistory[tickHistory.length - 1]) {
            predicted = sorted[1];
        }

        // Confidence based on chaos level
        let confidence = 50;

        if (predicted.transitionSamples >= 10) {
            const probGap = Math.max(0, 0.1 - predicted.transitionProb);
            confidence += probGap * 400;
            confidence += Math.min(15, Math.log10(predicted.transitionSamples + 1) * 10);
        }

        // Lower Lyapunov = more predictable
        if (lyapunov < 0.5) confidence += 10;
        else if (lyapunov > 1.5) confidence -= 10;

        confidence = Math.min(95, Math.max(50, confidence));

        return {
            predictedDigit: predicted.digit,
            confidence: Math.round(confidence),
            primaryStrategy: 'Chaos Theory Attractor Analysis',
            riskAssessment: lyapunov > 1.5 ? 'high' : lyapunov > 0.8 ? 'medium' : 'low',
            marketRegime: lyapunov > 1.5 ? 'chaotic' : lyapunov > 0.5 ? 'edge-of-chaos' : 'ordered',
            statisticalEvidence: {
                lyapunovExponent: lyapunov.toFixed(3),
                attractorCount: attractors.size,
                dimension,
                currentState,
                recurrenceRate: recurrence.overallRate.toFixed(3),
                currentStateCount: currentAttractor ? currentAttractor.count : 0,
                transitionSamples: predicted.transitionSamples,
                transitionProbability: predicted.transitionProb.toFixed(4),
                nextStateCount: attractors.get(predicted.nextState)?.count || 0,
                phaseStates: totalStates
            },
            alternativeCandidates: [sorted[1].digit, sorted[2].digit]
        };
    }

    buildPhaseSpace(tickHistory, dimension) {
        const states = [];
        for (let i = dimension - 1; i < tickHistory.length; i++) {
            const state = tickHistory.slice(i - dimension + 1, i + 1).join(',');
            states.push(state);
        }
        return states;
    }

    findAttractors(phaseSpace) {
        const attractors = new Map();

        for (let i = 0; i < phaseSpace.length - 1; i++) {
            const state = phaseSpace[i];
            const nextDigit = parseInt(phaseSpace[i + 1].split(',').pop());

            if (!attractors.has(state)) {
                attractors.set(state, { count: 0, transitions: Array(10).fill(0), total: 0 });
            }

            const entry = attractors.get(state);
            entry.count++;
            entry.total++;
            entry.transitions[nextDigit] = (entry.transitions[nextDigit] || 0) + 1;
        }

        return attractors;
    }

    approximateLyapunov(tickHistory) {
        // Simplified Lyapunov exponent approximation
        const n = Math.min(100, tickHistory.length);
        const sample = tickHistory.slice(-n);

        let divergence = 0;
        let count = 0;

        for (let i = 0; i < n - 10; i++) {
            // Find similar initial conditions
            for (let j = i + 1; j < n - 10; j++) {
                if (sample[i] === sample[j]) {
                    // Calculate divergence after k steps
                    let d0 = 0.1; // Initial small distance
                    let dK = Math.abs(sample[i + 5] - sample[j + 5]) + 0.1;
                    divergence += Math.log(dK / d0);
                    count++;
                }
            }
        }

        return count > 0 ? divergence / count / 5 : 1.0;
    }

    analyzeRecurrence(tickHistory) {
        const n = tickHistory.length;
        const counts = Array(10).fill(0);
        for (const d of tickHistory) {
            counts[d]++;
        }

        const possiblePairs = (n * (n - 1)) / 2;
        if (possiblePairs <= 0) {
            return { digitRecurrence: Array(10).fill(0), overallRate: 0 };
        }

        const digitRecurrence = Array(10).fill(0);
        let totalRecurrence = 0;

        for (let d = 0; d < 10; d++) {
            const c = counts[d];
            const pairs = (c * (c - 1)) / 2;
            digitRecurrence[d] = pairs / possiblePairs;
            totalRecurrence += pairs;
        }

        const overallRate = totalRecurrence / possiblePairs;
        return { digitRecurrence, overallRate };
    }
}

// ============================================================
// SIMULATED AI ENGINE 9: Monte Carlo Simulator (MCS)
// Uses random sampling and probability distributions
// ============================================================
class MonteCarloSimulator {
    constructor() {
        this.name = 'MCS';
        this.fullName = 'Monte Carlo Simulator';
        this.weight = 1.05;
        this.wins = 0;
        this.losses = 0;
        this.lastPrediction = null;
        this.lastOutcome = null;
    }

    analyze(tickHistory) {
        if (tickHistory.length < 100) {
            return { error: 'Insufficient data' };
        }

        const numSimulations = 1000;
        const results = this.runSimulations(tickHistory, numSimulations);

        // Aggregate simulation results
        const digitProbabilities = Array(10).fill(0);
        const digitConfidences = Array(10).fill().map(() => []);

        for (const sim of results) {
            digitProbabilities[sim.predictedDigit]++;
            digitConfidences[sim.predictedDigit].push(sim.confidence);
        }

        // Normalize probabilities
        for (let d = 0; d < 10; d++) {
            digitProbabilities[d] /= numSimulations;
        }

        // For DIFFER: we want digit that simulations say will appear most often
        // Actually, let's use digit that simulations say WON'T appear
        const differScores = digitProbabilities.map((prob, digit) => ({
            digit,
            probability: prob,
            // Higher probability of appearing = choose it for DIFFER
            differScore: 1 - prob,
            avgConfidence: digitConfidences[digit].length > 0
                ? digitConfidences[digit].reduce((a, b) => a + b, 0) / digitConfidences[digit].length
                : 50
        }));

        // Sort by differ score
        const sorted = differScores.sort((a, b) => b.differScore - a.differScore);

        let predicted = sorted[0];
        if (predicted.digit === tickHistory[tickHistory.length - 1]) {
            predicted = sorted[1];
        }

        const predictedIndex = sorted.findIndex(s => s.digit === predicted.digit);
        const nextCandidate = predictedIndex >= 0 ? sorted[predictedIndex + 1] : null;

        // Calculate confidence interval
        const ci = this.calculateConfidenceInterval(digitProbabilities[predicted.digit], numSimulations);

        // Calculate overall confidence
        const baseline = 0.1;
        const p = predicted.probability;
        const rarityScore = Math.max(0, baseline - p) / baseline;
        const separation = nextCandidate ? Math.max(0, nextCandidate.probability - p) : 0;
        const separationScore = Math.min(1, separation / baseline);
        const precisionScore = 1 - Math.min(1, ci.width / 0.15);

        let confidence = 50;
        confidence += rarityScore * 35;
        confidence += separationScore * 15;
        confidence += precisionScore * 10;
        confidence = Math.min(95, Math.max(50, confidence));

        const consistencyScore = this.calculateConsistency(results, predicted.digit);

        this.lastPrediction = predicted.digit;

        return {
            predictedDigit: predicted.digit,
            confidence: Math.round(confidence),
            primaryStrategy: 'Monte Carlo Simulation',
            riskAssessment: ci.width > 0.1 ? 'high' : ci.width > 0.05 ? 'medium' : 'low',
            marketRegime: this.detectRegimeFromSimulations(results),
            statisticalEvidence: {
                simulations: numSimulations,
                probability: predicted.probability.toFixed(4),
                confidenceInterval: `[${ci.lower.toFixed(3)}, ${ci.upper.toFixed(3)}]`,
                consistencyScore: consistencyScore.toFixed(3)
            },
            alternativeCandidates: [sorted[1].digit, sorted[2].digit]
        };
    }

    runSimulations(tickHistory, numSimulations) {
        const results = [];

        for (let sim = 0; sim < numSimulations; sim++) {
            const sample = this.sampleRecentWindow(tickHistory);

            // Random analysis method
            const method = Math.floor(Math.random() * 4);
            let prediction;

            switch (method) {
                case 0:
                    prediction = this.frequencyBasedPrediction(sample);
                    break;
                case 1:
                    prediction = this.transitionBasedPrediction(sample);
                    break;
                case 2:
                    prediction = this.gapBasedPrediction(sample);
                    break;
                case 3:
                    prediction = this.randomWalkPrediction(sample);
                    break;
            }

            results.push(prediction);
        }

        return results;
    }

    sampleRecentWindow(tickHistory) {
        const n = tickHistory.length;
        const minWindow = Math.min(200, n);
        const maxWindow = Math.min(800, n);
        const windowSize = minWindow + Math.floor(Math.random() * (maxWindow - minWindow + 1));
        return tickHistory.slice(-windowSize);
    }

    bootstrapSample(tickHistory) {
        const sample = [];
        const n = tickHistory.length;

        for (let i = 0; i < n; i++) {
            sample.push(tickHistory[Math.floor(Math.random() * n)]);
        }

        return sample;
    }

    frequencyBasedPrediction(sample) {
        const counts = Array(10).fill(0);
        sample.forEach(d => counts[d]++);

        const maxCount = Math.max(...counts);
        const predicted = counts.indexOf(maxCount);
        const confidence = 50 + (maxCount / sample.length - 0.1) * 200;

        return { predictedDigit: predicted, confidence };
    }

    transitionBasedPrediction(sample) {
        const lastDigit = sample[sample.length - 1];
        const transitions = Array(10).fill(0);

        for (let i = 0; i < sample.length - 1; i++) {
            if (sample[i] === lastDigit) {
                transitions[sample[i + 1]]++;
            }
        }

        const maxTrans = Math.max(...transitions);
        const predicted = transitions.indexOf(maxTrans);
        const confidence = maxTrans > 0 ? 50 + maxTrans * 5 : 50;

        return { predictedDigit: predicted, confidence };
    }

    gapBasedPrediction(sample) {
        const gaps = Array(10).fill(sample.length);

        for (let i = sample.length - 1; i >= 0; i--) {
            if (gaps[sample[i]] === sample.length) {
                gaps[sample[i]] = sample.length - 1 - i;
            }
        }

        // Predict digit with smallest gap (just appeared = good for DIFFER)
        const minGap = Math.min(...gaps.filter(g => g > 0));
        const predicted = gaps.indexOf(minGap);
        const confidence = 50 + (1 / (minGap + 1)) * 30;

        return { predictedDigit: predicted, confidence };
    }

    randomWalkPrediction(sample) {
        // Random prediction with slight bias toward frequent digits
        const counts = Array(10).fill(0);
        sample.forEach(d => counts[d]++);

        const total = sample.length;
        const probs = counts.map(c => c / total);

        // Weighted random selection
        let r = Math.random();
        let predicted = 0;

        for (let i = 0; i < 10; i++) {
            r -= probs[i];
            if (r <= 0) {
                predicted = i;
                break;
            }
        }

        return { predictedDigit: predicted, confidence: 55 };
    }

    calculateConsistency(results, digit) {
        const matching = results.filter(r => r.predictedDigit === digit).length;
        return matching / results.length;
    }

    calculateConfidenceInterval(probability, n) {
        const z = 1.96; // 95% CI
        const se = Math.sqrt((probability * (1 - probability)) / n);

        return {
            lower: Math.max(0, probability - z * se),
            upper: Math.min(1, probability + z * se),
            width: 2 * z * se
        };
    }

    detectRegimeFromSimulations(results) {
        // Check consistency of predictions
        const counts = Array(10).fill(0);
        results.forEach(r => counts[r.predictedDigit]++);

        const maxCount = Math.max(...counts);
        const dominance = maxCount / results.length;

        if (dominance > 0.4) return 'stable';
        if (dominance > 0.2) return 'ranging';
        return 'volatile';
    }
}

// ============================================================
// SIMULATED AI ENGINE 10: Ensemble Meta-Learner (EML)
// Combines insights from all other engines
// ============================================================
class EnsembleMetaLearner {
    constructor() {
        this.name = 'EML';
        this.fullName = 'Ensemble Meta-Learner';
        this.weight = 1.4; // Highest weight
        this.wins = 0;
        this.losses = 0;
        this.lastPrediction = null;
        this.lastOutcome = null;

        // Performance memory for adaptive weighting
        this.enginePerformance = {};
    }

    analyze(tickHistory, engineResults) {
        if (!engineResults || engineResults.length === 0) {
            return this.fallbackAnalysis(tickHistory);
        }

        // Weighted voting with adaptive weights
        const votes = Array(10).fill(0);
        const confidences = Array(10).fill().map(() => []);
        const riskScores = [];
        const regimeVotes = {};

        for (const result of engineResults) {
            if (result.error) continue;

            const digit = result.predictedDigit;
            let weight = result.weight || 1.0;

            // Adjust weight based on historical performance
            const perf = this.enginePerformance[result.name];
            if (perf && perf.total >= 10) {
                const winRate = perf.wins / perf.total;
                weight *= (0.5 + winRate); // Boost winners, reduce losers
            }

            // Adjust weight based on confidence
            weight *= (result.confidence / 70);

            votes[digit] += weight;
            confidences[digit].push(result.confidence);

            // Track risk and regime
            const riskValue = result.riskAssessment === 'high' ? 3 : result.riskAssessment === 'medium' ? 2 : 1;
            riskScores.push(riskValue);

            if (result.marketRegime) {
                regimeVotes[result.marketRegime] = (regimeVotes[result.marketRegime] || 0) + weight;
            }
        }

        // Find winning digit
        let maxVotes = 0;
        let predicted = 0;
        for (let i = 0; i < 10; i++) {
            if (votes[i] > maxVotes) {
                maxVotes = votes[i];
                predicted = i;
            }
        }

        // Don't predict last digit
        if (predicted === tickHistory[tickHistory.length - 1]) {
            votes[predicted] = -1;
            maxVotes = 0;
            for (let i = 0; i < 10; i++) {
                if (votes[i] > maxVotes) {
                    maxVotes = votes[i];
                    predicted = i;
                }
            }
        }

        // Calculate meta-confidence
        const numEngines = engineResults.filter(r => !r.error).length;
        const agreement = engineResults.filter(r => r.predictedDigit === predicted).length;
        const avgConfidence = confidences[predicted].length > 0
            ? confidences[predicted].reduce((a, b) => a + b, 0) / confidences[predicted].length
            : 50;

        let metaConfidence = avgConfidence;

        // Boost for strong agreement
        if (agreement >= numEngines * 0.7) metaConfidence += 15;
        else if (agreement >= numEngines * 0.5) metaConfidence += 10;

        // Penalize for low agreement
        if (agreement < numEngines * 0.3) metaConfidence -= 15;

        metaConfidence = Math.min(95, Math.max(50, metaConfidence));

        // Determine overall risk
        const avgRisk = riskScores.length > 0
            ? riskScores.reduce((a, b) => a + b, 0) / riskScores.length
            : 2;
        const overallRisk = avgRisk >= 2.5 ? 'high' : avgRisk >= 1.5 ? 'medium' : 'low';

        // Determine regime by consensus
        let consensusRegime = 'unknown';
        let maxRegimeVotes = 0;
        for (const [regime, count] of Object.entries(regimeVotes)) {
            if (count > maxRegimeVotes) {
                maxRegimeVotes = count;
                consensusRegime = regime;
            }
        }

        // Get alternative candidates
        const alternatives = votes
            .map((v, i) => ({ digit: i, votes: v }))
            .filter(x => x.digit !== predicted && x.votes > 0)
            .sort((a, b) => b.votes - a.votes)
            .slice(0, 2)
            .map(x => x.digit);

        return {
            predictedDigit: predicted,
            confidence: Math.round(metaConfidence),
            primaryStrategy: 'Ensemble Meta-Learning',
            riskAssessment: overallRisk,
            marketRegime: consensusRegime,
            statisticalEvidence: {
                enginesConsulted: numEngines,
                agreement: `${agreement}/${numEngines}`,
                weightedVotes: maxVotes.toFixed(2),
                confidenceRange: `${Math.min(...confidences[predicted] || [50])}-${Math.max(...confidences[predicted] || [50])}`
            },
            alternativeCandidates: alternatives
        };
    }

    // fallbackAnalysis(tickHistory) {
    //     const counts = Array(10).fill(0);
    //     tickHistory.slice(-100).forEach(d => counts[d]++);

    //     const maxCount = Math.max(...counts);
    //     const predicted = counts.indexOf(maxCount);

    //     return {
    //         predictedDigit: predicted,
    //         confidence: 55,
    //         primaryStrategy: 'Ensemble Meta-Learning (Fallback)',
    //         riskAssessment: 'medium',
    //         marketRegime: 'unknown',
    //         statisticalEvidence: { method: 'fallback-frequency' },
    //         alternativeCandidates: []
    //     };
    // }

    updatePerformance(engineName, won) {
        if (!this.enginePerformance[engineName]) {
            this.enginePerformance[engineName] = { wins: 0, losses: 0, total: 0 };
        }

        this.enginePerformance[engineName].total++;
        if (won) {
            this.enginePerformance[engineName].wins++;
        } else {
            this.enginePerformance[engineName].losses++;
        }
    }
}

// ============================================================
// KELLY CRITERION MANAGER (from previous version)
// ============================================================

class KellyCriterionManager {
    constructor(config = {}) {
        this.investmentCapital = config.investmentCapital || 500;
        this.currentCapital = this.investmentCapital;
        this.peakCapital = this.investmentCapital;

        this.kellyFraction = config.kellyFraction || 0.25;
        this.minKellyFraction = 0.1;
        this.maxKellyFraction = 0.5;

        this.minStake = config.minStake || 0.61;
        this.maxStakePercent = config.maxStakePercent || 5;
        this.absoluteMaxStake = config.absoluteMaxStake || 50;

        this.maxDrawdownPercent = config.maxDrawdownPercent || 25;
        this.warningDrawdownPercent = config.warningDrawdownPercent || 15;
        this.dailyLossLimit = config.dailyLossLimit || 50;
        this.dailyProfitTarget = config.dailyProfitTarget || 100;

        this.recoveryMode = false;
        this.recoveryStartCapital = 0;
        this.maxRecoveryMultiplier = 2.0;

        this.tradeHistory = [];
        this.dailyPnL = 0;
        this.sessionPnL = 0;
        this.currentDrawdown = 0;
        this.maxDrawdownReached = 0;

        this.confidenceThresholds = {
            veryHigh: 90,
            high: 80,
            medium: 70,
            low: 60
        };

        this.recentWins = 0;
        this.recentLosses = 0;
        this.rollingWindowSize = 50;
        this.rollingResults = [];

        console.log('\n💰 Kelly Criterion Manager Initialized');
        console.log(`   Investment Capital: $${this.investmentCapital}`);
        console.log(`   Kelly Fraction: ${this.kellyFraction * 100}%`);
    }

    calculateFullKelly(winProbability, decimalOdds) {
        const p = Math.max(0.01, Math.min(0.99, winProbability));
        const q = 1 - p;
        const b = decimalOdds - 1;

        if (b <= 0) return 0;

        const kelly = (b * p - q) / b;
        return Math.max(0, kelly);
    }

    calculateOptimalStake(params) {
        const {
            winProbability = 0.5,
            payout = 1.85,
            confidence = 70,
            marketRegime = 'stable',
            consecutiveLosses = 0,
            consecutiveWins = 0,
            volatility = 'medium'
        } = params;

        const fullKelly = this.calculateFullKelly(winProbability, payout);
        let adjustedKelly = fullKelly * this.kellyFraction;

        adjustedKelly *= this.getConfidenceMultiplier(confidence);
        adjustedKelly *= this.getRegimeMultiplier(marketRegime);
        adjustedKelly *= this.getVolatilityMultiplier(volatility);
        adjustedKelly *= this.getLossAdjustment(consecutiveLosses);
        adjustedKelly *= this.getWinBonus(consecutiveWins);
        adjustedKelly *= this.getDrawdownMultiplier();

        let stake = this.currentCapital * adjustedKelly;

        stake = Math.max(this.minStake, stake);
        stake = Math.min(stake, this.currentCapital * (this.maxStakePercent / 100));
        stake = Math.min(stake, this.absoluteMaxStake);
        stake = Math.min(stake, this.currentCapital * 0.1);

        stake = Math.round(stake * 100) / 100;

        return {
            stake,
            kellyFraction: adjustedKelly,
            riskLevel: this.assessRiskLevel(stake),
            recommendation: this.getStakeRecommendation(stake, confidence)
        };
    }

    getConfidenceMultiplier(confidence) {
        if (confidence >= this.confidenceThresholds.veryHigh) return 1.0;
        if (confidence >= this.confidenceThresholds.high) return 0.8;
        if (confidence >= this.confidenceThresholds.medium) return 0.5;
        if (confidence >= this.confidenceThresholds.low) return 0.25;
        return 0.1;
    }

    getRegimeMultiplier(regime) {
        const multipliers = {
            'stable': 1.0, 'ordered': 1.0,
            'trending': 0.8, 'patterned': 0.9,
            'ranging': 0.9, 'semi-random': 0.7,
            'volatile': 0.5, 'chaotic': 0.4,
            'random': 0.4, 'edge-of-chaos': 0.6,
            'unknown': 0.6
        };
        return multipliers[regime] || 0.6;
    }

    getVolatilityMultiplier(volatility) {
        const multipliers = { 'low': 1.2, 'medium': 1.0, 'high': 0.6, 'extreme': 0.3 };
        return multipliers[volatility] || 1.0;
    }

    getLossAdjustment(consecutiveLosses) {
        if (consecutiveLosses === 0) return 1.0;
        if (consecutiveLosses === 1) return 0.9;
        if (consecutiveLosses === 2) return 0.7;
        if (consecutiveLosses === 3) return 0.5;
        if (consecutiveLosses === 4) return 0.3;
        return 0.2;
    }

    getWinBonus(consecutiveWins) {
        if (consecutiveWins === 0) return 1.0;
        if (consecutiveWins === 1) return 1.1;
        if (consecutiveWins === 2) return 1.2;
        if (consecutiveWins === 3) return 1.3;
        return 1.4;
    }

    getDrawdownMultiplier() {
        const drawdownPercent = this.calculateCurrentDrawdown();
        if (drawdownPercent < 5) return 1.0;
        if (drawdownPercent < 10) return 0.8;
        if (drawdownPercent < 15) return 0.6;
        if (drawdownPercent < 20) return 0.4;
        if (drawdownPercent < 25) return 0.2;
        return 0.1;
    }

    calculateCurrentDrawdown() {
        if (this.peakCapital <= 0) return 0;
        const drawdown = ((this.peakCapital - this.currentCapital) / this.peakCapital) * 100;
        this.currentDrawdown = Math.max(0, drawdown);
        this.maxDrawdownReached = Math.max(this.maxDrawdownReached, this.currentDrawdown);
        return this.currentDrawdown;
    }

    shouldContinueTrading() {
        const drawdown = this.calculateCurrentDrawdown();
        const reasons = [];

        if (drawdown >= this.maxDrawdownPercent) {
            reasons.push(`Max drawdown ${drawdown.toFixed(1)}% reached`);
        }
        if (this.dailyPnL <= -this.dailyLossLimit) {
            reasons.push(`Daily loss limit $${this.dailyLossLimit} reached`);
        }
        if (this.currentCapital < this.investmentCapital * 0.5) {
            reasons.push(`Capital below 50% of initial`);
        }

        return {
            canTrade: reasons.length === 0,
            reasons,
            warning: drawdown >= this.warningDrawdownPercent,
            reachedDailyTarget: this.dailyPnL >= this.dailyProfitTarget,
            currentDrawdown: drawdown,
            dailyPnL: this.dailyPnL
        };
    }

    updateAfterTrade(profit, isWin) {
        this.currentCapital += profit;
        this.dailyPnL += profit;
        this.sessionPnL += profit;

        if (this.currentCapital > this.peakCapital) {
            this.peakCapital = this.currentCapital;
        }

        this.rollingResults.push(isWin ? 1 : 0);
        if (this.rollingResults.length > this.rollingWindowSize) {
            this.rollingResults.shift();
        }

        if (this.rollingResults.length > 0) {
            this.recentWins = this.rollingResults.filter(r => r === 1).length;
            this.recentLosses = this.rollingResults.filter(r => r === 0).length;
        }

        this.tradeHistory.push({
            timestamp: Date.now(),
            profit,
            isWin,
            capital: this.currentCapital,
            drawdown: this.calculateCurrentDrawdown()
        });
    }

    getRollingWinRate() {
        if (this.rollingResults.length < 5) return 0.5;
        return this.recentWins / this.rollingResults.length;
    }

    getPayoutForAsset(asset) {
        const payouts = {
            'R_10': 1.85, 'R_25': 1.85, 'R_50': 1.85,
            'R_75': 1.85, 'R_100': 1.85,
            'RDBULL': 1.80, 'RDBEAR': 1.80
        };
        return payouts[asset] || 1.85;
    }

    assessRiskLevel(stake) {
        const percentOfCapital = (stake / this.currentCapital) * 100;
        if (percentOfCapital <= 1) return 'very_low';
        if (percentOfCapital <= 2) return 'low';
        if (percentOfCapital <= 3) return 'medium';
        if (percentOfCapital <= 5) return 'high';
        return 'very_high';
    }

    getStakeRecommendation(stake, confidence) {
        if (confidence < 60) return 'SKIP - Confidence too low';
        if (stake < this.minStake) return 'SKIP - Stake below minimum';
        if (this.calculateCurrentDrawdown() > 20) return 'CAUTION - High drawdown';
        return 'TRADE';
    }

    getStatus() {
        return {
            investmentCapital: this.investmentCapital,
            currentCapital: this.currentCapital,
            peakCapital: this.peakCapital,
            currentDrawdown: this.calculateCurrentDrawdown(),
            maxDrawdownReached: this.maxDrawdownReached,
            dailyPnL: this.dailyPnL,
            sessionPnL: this.sessionPnL,
            rollingWinRate: this.getRollingWinRate(),
            recoveryMode: this.recoveryMode,
            tradesCount: this.tradeHistory.length
        };
    }
}
// ============================================================
// MAIN BOT CLASS
// ============================================================

class AILogicDigitDifferBot {
    constructor(config = {}) {
        this.token = config.derivToken || process.env.DERIV_TOKEN;

        // Initialize Kelly Criterion Manager
        this.kellyManager = new KellyCriterionManager({
            investmentCapital: config.investmentCapital || 500,
            kellyFraction: config.kellyFraction || 0.25,
            maxStakePercent: config.maxStakePercent || 5,
            maxDrawdownPercent: config.maxDrawdownPercent || 25,
            dailyLossLimit: config.dailyLossLimit || 50,
            dailyProfitTarget: config.dailyProfitTarget || 100
        });

        // Initialize Simulated AI Engines
        this.aiEngines = {
            fda: new FrequencyDeviationAnalyzer(),
            mcp: new MarkovChainPredictor(),
            eite: new EntropyInformationEngine(),
            prnn: new PatternRecognitionEngine(),
            bpe: new BayesianProbabilityEstimator(),
            gamr: new GapMeanReversionAnalyzer(),
            mtd: new MomentumTrendDetector(),
            ctaf: new ChaosTheoryAnalyzer(),
            mcs: new MonteCarloSimulator(),
            eml: new EnsembleMetaLearner()
        };

        // WebSocket
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // Assets
        this.assets = config.assets || [
            // 'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'
            'R_100',
        ];

        // Trading Configuration
        this.config = {
            requiredHistoryLength: config.requiredHistoryLength || 500,
            minConfidence: config.minConfidence || 70,
            minStake: config.minStake || 0.61,
            multiplier: config.multiplier || 11.3,
            minEnginesAgreement: config.minEnginesAgreement || 4,
            minEnginesAgreement2: config.minEnginesAgreement2 || 5,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 6,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            tradeCooldown: config.tradeCooldown || 5000,
            minWaitTime: config.minWaitTime || 15000,
            maxWaitTime: config.maxWaitTime || 90000,
        };

        // Trading State
        this.currentAsset = null;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.consecutiveWins = 0;
        this.currentTradeId = null;
        this.tickSubscriptionId = null;
        this.lastTradeResult = null;

        // Statistics
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.balance = 0;
        this.sessionStartBalance = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.currentStake = this.config.minStake;

        // Tick Data
        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);

        // Prediction Tracking
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.lastPrediction = null;
        this.lastConfidence = 0;
        this.currentPrediction = null;
        this.RestartTrading = true;

        // Random Engine Selection
        this.currentEngineSetup = null;
        this.tradesInCurrentCycle = 0;
        this.engineSetups = [
            { name: 'FDA', check: (p) => p.find(e => e.name === 'FDA' && e.confidence >= 70) },
            { name: 'MCP', check: (p) => p.find(e => e.name === 'MCP' && e.confidence >= 63) },// Good
            { name: 'EITE', check: (p) => p.find(e => e.name === 'EITE' && e.confidence >= 100) },//Good
            { name: 'PRNN', check: (p) => p.find(e => e.name === 'PRNN' && e.confidence >= 85) }, //Good
            { name: 'BPE', check: (p) => p.find(e => e.name === 'BPE' && e.confidence >= 100) }, //Good
            { name: 'GAMR', check: (p) => p.find(e => e.name === 'GAMR' && e.confidence >= 70) },
            { name: 'MTD', check: (p) => p.find(e => e.name === 'MTD' && e.confidence >= 87) }, //Good
            { name: 'CTAF', check: (p) => p.find(e => e.name === 'CTAF' && e.confidence >= 91) }, //Good
            { name: 'MCS', check: (p) => p.find(e => e.name === 'MCS' && e.confidence >= 92) } //Good
        ];
        this.selectRandomEngineSetup();

        // Connection State
        this.reconnectAttempts = 0;
        this.isPaused = false;
        this.isShuttingDown = false;
        this.isReconnecting = false;

        // Telegram Configuration
        this.telegramToken = process.env.TELEGRAM_BOT_TOKENb;
        this.telegramChatId = process.env.TELEGRAM_CHAT_ID;
        this.telegramEnabled = !!(this.telegramToken && this.telegramChatId);

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
        }

        this.sessionStartTime = new Date();

        console.log('\n' + '='.repeat(60));
        console.log('🤖 AI-LOGIC DIGIT DIFFER TRADING BOT v5.0');
        console.log('   Simulated AI Ensemble System');
        console.log('='.repeat(60));
        this.logActiveEngines();

        if (this.telegramEnabled) {
            this.startTelegramTimer();
        }
    }

    logActiveEngines() {
        console.log('\n🧠 Active Simulated AI Engines:')
        for (const [key, engine] of Object.entries(this.aiEngines)) {
            console.log(`   ✅ ${engine.fullName} (${engine.name}) - Weight: ${engine.weight}`)
        }
        console.log(`\n   Total Active: ${Object.keys(this.aiEngines).length} engines`)
        console.log('='.repeat(60) + '\n')
    }

    selectRandomEngineSetup() {
        const randomIndex = Math.floor(Math.random() * this.engineSetups.length);
        this.currentEngineSetup = this.engineSetups[randomIndex];
        console.log(`🎲 Randomly selected engine setup: ${this.currentEngineSetup.name}`);
        this.tradesInCurrentCycle = 0;
    }

    connect() {
        if (this.isShuttingDown || this.connected) return;

        console.log('🔌 Connecting to Deriv API...');

        try {
            this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            this.ws.on('open', () => {
                console.log('✅ Connected to Deriv API');
                this.connected = true;
                this.wsReady = true;
                this.reconnectAttempts = 0;
                this.isReconnecting = false;
                this.authenticate();
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Error parsing message:', error.message);
                }
            });

            this.ws.on('error', (error) => {
                console.error('❌ WebSocket error:', error.message);
            });

            this.ws.on('close', (code) => {
                console.log(`🔌 Disconnected (code: ${code})`);
                this.connected = false;
                this.wsReady = false;
                this.ws = null;
                if (!this.isPaused && !this.isShuttingDown) {
                    this.handleDisconnect();
                }
            });

        } catch (error) {
            console.error('Error creating WebSocket:', error.message);
            this.handleDisconnect();
        }
    }

    sendRequest(request) {
        if (this.connected && this.wsReady && this.ws) {
            try {
                this.ws.send(JSON.stringify(request));
                return true;
            } catch (error) {
                console.error('Error sending request:', error.message);
                return false;
            }
        }
        return false;
    }

    handleDisconnect() {
        if (this.isReconnecting || this.isShuttingDown) return;

        this.connected = false;
        this.wsReady = false;
        this.isReconnecting = true;

        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.terminate();
            } catch (e) { }
            this.ws = null;
        }

        this.reconnectAttempts++;
        const delay = Math.min(this.config.reconnectInterval * (this.reconnectAttempts + 1), 30000);
        console.log(`🔄 Reconnecting in ${delay / 1000}s...`);

        setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    authenticate() {
        console.log('🔐 Authenticating...');
        this.sendRequest({ authorize: this.token });
    }

    disconnect() {
        this.connected = false;
        this.wsReady = false;
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close();
            } catch (e) { }
            this.ws = null;
        }
    }

    shutdown() {
        console.log('\n🛑 Shutting down...');
        this.isShuttingDown = true;
        this.isPaused = true;
        this.logFinalSummary();
        this.disconnect();
        console.log('💤 Bot stopped.');
        setInterval(() => { }, 1000 * 60 * 60);
    }

    // ==================== MESSAGE HANDLING ====================

    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                this.handleAuthorize(message);
                break;
            case 'balance':
                // this.handleBalance(message);
                break;
            case 'history':
                this.handleTickHistory(message.history);
                break;
            case 'tick':
                this.handleTickUpdate(message.tick);
                break;
            case 'buy':
                this.handleBuyResponse(message);
                break;
            case 'proposal_open_contract':
                if (message.proposal_open_contract?.is_sold) {
                    this.handleTradeResult(message.proposal_open_contract);
                }
                break;
            default:
                if (message.error) {
                    this.handleError(message.error);
                }
        }
    }

    handleAuthorize(message) {
        if (message.error) {
            console.error('❌ Authentication failed:', message.error.message);
            this.scheduleReconnect(5000);
            return;
        }

        console.log('✅ Authentication successful');
        console.log(`👤 Account: ${message.authorize.loginid}`);
        this.balance = this.kellyManager.investmentCapital;//message.authorize.balance;
        this.sessionStartBalance = this.balance;

        // this.kellyManager.currentCapital = this.balance;
        // this.kellyManager.investmentCapital = this.balance;
        // this.kellyManager.peakCapital = this.balance;

        console.log(`💰 Balance: $${this.balance.toFixed(2)}`);

        this.sendRequest({ balance: 1, subscribe: 1 });
        this.resetTradingState();
        this.startTrading();
    }

    resetTradingState() {
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);
        this.tickSubscriptionId = null;
    }

    // handleBalance(message) {
    //     if (message.balance) {
    //         this.balance = message.balance.balance;
    //         this.kellyManager.currentCapital = this.balance;
    //     }
    // }

    handleBuyResponse(message) {
        if (message.error) {
            console.error('❌ Trade error:', message.error.message);
            this.tradeInProgress = false;
            this.predictionInProgress = false;
            this.scheduleNextTrade();
            return;
        }

        console.log('✅ Trade placed successfully');
        this.currentTradeId = message.buy.contract_id;
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: this.currentTradeId,
            subscribe: 1
        });
    }

    handleError(error) {
        console.error('❌ API Error:', error.message, `(Code: ${error.code})`);

        switch (error.code) {
            case 'InvalidToken':
                this.shutdown();
                break;
            case 'RateLimit':
                this.scheduleReconnect(60000);
                break;
            case 'MarketIsClosed':
                this.scheduleReconnect(300000);
                break;
            default:
                if (!this.tradeInProgress) {
                    this.scheduleNextTrade();
                }
        }
    }

    // ==================== TRADING LOGIC ====================

    startTrading() {
        console.log('\n📈 Starting trading session...');
        console.log(`💰 Investment Capital: $${this.kellyManager.investmentCapital.toFixed(2)}`);
        this.selectNextAsset();
    }

    selectNextAsset() {
        if (this.usedAssets.size >= this.assets.length) {
            this.usedAssets.clear();
        }

        if (this.RestartTrading) {
            const availableAssets = this.assets.filter(a => !this.usedAssets.has(a));
            this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
            this.usedAssets.add(this.currentAsset);
        }

        // this.RestartTrading = false;
        console.log(`\n🎯 Selected asset: ${this.currentAsset}`);

        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);

        if (this.tickSubscriptionId) {
            this.sendRequest({ forget: this.tickSubscriptionId });
        }

        setTimeout(() => {
            this.sendRequest({
                ticks_history: this.currentAsset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });

            this.sendRequest({
                ticks: this.currentAsset,
                subscribe: 1
            });
        }, 500);
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    handleTickHistory(history) {
        if (!history || !history.prices) {
            console.log('⚠️ Invalid tick history received');
            return;
        }
        this.tickHistory = history.prices.map(price => this.getLastDigit(price, this.currentAsset));
        console.log(`📊 Received ${this.tickHistory.length} ticks of history`);
    }

    handleTickUpdate(tick) {
        if (!tick || !tick.quote) return;

        const lastDigit = this.getLastDigit(tick.quote, this.currentAsset);
        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.config.requiredHistoryLength) {
            this.tickHistory.shift();
        }
        this.digitCounts[lastDigit]++;

        // console.log(`📍 Last 5 digits: ${this.tickHistory.slice(-5).join(', ')} | History: ${this.tickHistory.length}`);

        if (!this.tradeInProgress) {
            this.analyzeTicks();
        }
    }

    // ==================== SIMULATED AI PREDICTION ENGINE ====================

    async analyzeTicks() {
        if (this.tradeInProgress) return;

        const tradingStatus = this.kellyManager.shouldContinueTrading();
        if (!tradingStatus.canTrade) {
            console.log('\n🛑 Trading stopped by Kelly Manager:');
            tradingStatus.reasons.forEach(r => console.log(`   - ${r}`));
            this.shutdown();
            return;
        }

        if (tradingStatus.warning) {
            console.log(`\n⚠️ WARNING: Drawdown at ${tradingStatus.currentDrawdown.toFixed(1)}%`);
        }

        // this.predictionInProgress = true;
        console.log('\n🧠 Starting Simulated AI Ensemble Analysis...');

        const startTime = Date.now();

        try {
            // Run all simulated AI engines
            const predictions = await this.runAllEngines();
            const processingTime = (Date.now() - startTime) / 1000;

            console.log(`⏱️  Analysis time: ${processingTime.toFixed(2)}s`);

            if (predictions.length === 0) {
                console.log('⚠️  No valid predictions received');
                this.predictionInProgress = false;
                // this.scheduleNextTrade();
                return;
            }

            // Use Meta-Learner for final ensemble decision
            const ensemble = this.aiEngines.eml.analyze(this.tickHistory, predictions);

            // console.log('\n📊 Ensemble Result:');
            // console.log(`   Predicted Digit: ${ensemble.predictedDigit}`);
            // console.log(`   Confidence: ${ensemble.confidence}%`);
            // console.log(`   Risk Level: ${ensemble.riskAssessment}`);
            // console.log(`   Market Regime: ${ensemble.marketRegime}`);
            // console.log(`   Engines Consulted: ${ensemble.statisticalEvidence.enginesConsulted}`);
            // console.log(`   Agreement: ${ensemble.statisticalEvidence.agreement}`);

            // Calculate optimal stake
            const winRate = this.kellyManager.getRollingWinRate();
            const payout = this.kellyManager.getPayoutForAsset(this.currentAsset);

            const kellyResult = this.kellyManager.calculateOptimalStake({
                winProbability: Math.max(0.4, Math.min(0.7, winRate + (ensemble.confidence - 50) / 200)),
                payout: payout,
                confidence: ensemble.confidence,
                marketRegime: ensemble.marketRegime,
                consecutiveLosses: this.consecutiveLosses,
                consecutiveWins: this.consecutiveWins,
                volatility: this.getVolatilityLevel(this.tickHistory)
            });

            // console.log(`\n💰 Kelly Criterion Result:`);
            // console.log(`   Optimal Stake: $${kellyResult.stake.toFixed(2)}`);
            // console.log(`   Risk Level: ${kellyResult.riskLevel}`);
            // console.log(`   Recommendation: ${kellyResult.recommendation}`);

            // console.log(`\n🎲 Current Engine Setup: ${this.currentEngineSetup.name} (${this.tradesInCurrentCycle}/10 trades)`);


            const tradeDecision = this.aiEngines.fda.analyze(this.tickHistory);
            const tradeDecision2 = this.aiEngines.mcp.analyze(this.tickHistory);
            const tradeDecision3 = this.aiEngines.eite.analyze(this.tickHistory);
            const tradeDecision4 = this.aiEngines.prnn.analyze(this.tickHistory);
            const tradeDecision5 = this.aiEngines.bpe.analyze(this.tickHistory);
            const tradeDecision6 = this.aiEngines.gamr.analyze(this.tickHistory);
            const tradeDecision7 = this.aiEngines.mtd.analyze(this.tickHistory);
            const tradeDecision8 = this.aiEngines.ctaf.analyze(this.tickHistory);
            const tradeDecision9 = this.aiEngines.mcs.analyze(this.tickHistory);

            const FDA_Engine = (tradeDecision.predictedDigit !== tradeDecision2.predictedDigit &&
                tradeDecision.predictedDigit !== tradeDecision3.predictedDigit &&
                tradeDecision.predictedDigit !== tradeDecision4 &&
                tradeDecision.predictedDigit !== tradeDecision5.predictedDigit &&
                tradeDecision.predictedDigit !== tradeDecision6.predictedDigit &&
                tradeDecision.predictedDigit !== tradeDecision7.predictedDigit &&
                tradeDecision.predictedDigit !== tradeDecision8.predictedDigit &&
                tradeDecision.predictedDigit !== tradeDecision9.predictedDigit &&
                tradeDecision.confidence >= 75 && tradeDecision.riskAssessment === 'low' && tradeDecision.marketRegime === 'random'
            );
            const MCP_Engine = (tradeDecision2.predictedDigit !== tradeDecision.predictedDigit &&
                tradeDecision2.predictedDigit !== tradeDecision3.predictedDigit &&
                tradeDecision2.predictedDigit !== tradeDecision4 &&
                tradeDecision2.predictedDigit !== tradeDecision5.predictedDigit &&
                tradeDecision2.predictedDigit !== tradeDecision6.predictedDigit &&
                tradeDecision2.predictedDigit !== tradeDecision7.predictedDigit &&
                tradeDecision2.predictedDigit !== tradeDecision8.predictedDigit &&
                tradeDecision2.predictedDigit !== tradeDecision9.predictedDigit &&
                tradeDecision2.confidence >= 63
            );
            const EITE_Engine = (tradeDecision3.predictedDigit !== tradeDecision.predictedDigit &&
                tradeDecision3.predictedDigit !== tradeDecision2.predictedDigit &&
                tradeDecision3.predictedDigit !== tradeDecision4 &&
                tradeDecision3.predictedDigit !== tradeDecision5.predictedDigit &&
                tradeDecision3.predictedDigit !== tradeDecision6.predictedDigit &&
                tradeDecision3.predictedDigit !== tradeDecision7.predictedDigit &&
                tradeDecision3.predictedDigit !== tradeDecision8.predictedDigit &&
                tradeDecision3.predictedDigit !== tradeDecision9.predictedDigit &&
                tradeDecision3.confidence >= 100
            );
            const PRNN_Engine = (tradeDecision4.predictedDigit !== tradeDecision.predictedDigit &&
                tradeDecision4.predictedDigit !== tradeDecision2.predictedDigit &&
                tradeDecision4.predictedDigit !== tradeDecision3 &&
                tradeDecision4.predictedDigit !== tradeDecision5.predictedDigit &&
                tradeDecision4.predictedDigit !== tradeDecision6.predictedDigit &&
                tradeDecision4.predictedDigit !== tradeDecision7.predictedDigit &&
                tradeDecision4.predictedDigit !== tradeDecision8.predictedDigit &&
                tradeDecision4.predictedDigit !== tradeDecision9.predictedDigit &&
                tradeDecision4.confidence >= 85
            );
            const BPE_Engine = (tradeDecision5.predictedDigit !== tradeDecision.predictedDigit &&
                tradeDecision5.predictedDigit !== tradeDecision2.predictedDigit &&
                tradeDecision5.predictedDigit !== tradeDecision3 &&
                tradeDecision5.predictedDigit !== tradeDecision4.predictedDigit &&
                tradeDecision5.predictedDigit !== tradeDecision6.predictedDigit &&
                tradeDecision5.predictedDigit !== tradeDecision7.predictedDigit &&
                tradeDecision5.predictedDigit !== tradeDecision8.predictedDigit &&
                tradeDecision5.predictedDigit !== tradeDecision9.predictedDigit &&
                tradeDecision5.confidence >= 100 && tradeDecision5.riskAssessment === 'low'
            );
            const GAMR_Engine = (tradeDecision6.predictedDigit !== tradeDecision.predictedDigit &&
                tradeDecision6.predictedDigit !== tradeDecision2.predictedDigit &&
                tradeDecision6.predictedDigit !== tradeDecision3 &&
                tradeDecision6.predictedDigit !== tradeDecision4.predictedDigit &&
                tradeDecision6.predictedDigit !== tradeDecision5.predictedDigit &&
                tradeDecision6.predictedDigit !== tradeDecision7.predictedDigit &&
                tradeDecision6.predictedDigit !== tradeDecision8.predictedDigit &&
                tradeDecision6.predictedDigit !== tradeDecision9.predictedDigit &&
                tradeDecision6.confidence >= 70 && tradeDecision6.riskAssessment === 'low'
            );
            const MTD_Engine = (tradeDecision7.predictedDigit !== tradeDecision.predictedDigit &&
                tradeDecision7.predictedDigit !== tradeDecision2.predictedDigit &&
                tradeDecision7.predictedDigit !== tradeDecision3 &&
                tradeDecision7.predictedDigit !== tradeDecision4.predictedDigit &&
                tradeDecision7.predictedDigit !== tradeDecision5.predictedDigit &&
                tradeDecision7.predictedDigit !== tradeDecision6.predictedDigit &&
                tradeDecision7.predictedDigit !== tradeDecision8.predictedDigit &&
                tradeDecision7.predictedDigit !== tradeDecision9.predictedDigit &&
                tradeDecision7.confidence >= 87 && tradeDecision7.riskAssessment === 'low'
            );
            const CTAF_Engine = (tradeDecision8.predictedDigit !== tradeDecision.predictedDigit &&
                tradeDecision8.predictedDigit !== tradeDecision2.predictedDigit &&
                tradeDecision8.predictedDigit !== tradeDecision3 &&
                tradeDecision8.predictedDigit !== tradeDecision4.predictedDigit &&
                tradeDecision8.predictedDigit !== tradeDecision5.predictedDigit &&
                tradeDecision8.predictedDigit !== tradeDecision6.predictedDigit &&
                tradeDecision8.predictedDigit !== tradeDecision7.predictedDigit &&
                tradeDecision8.predictedDigit !== tradeDecision9.predictedDigit &&
                tradeDecision8.confidence >= 90
            );
            const MCS_Engine = (tradeDecision9.predictedDigit !== tradeDecision.predictedDigit &&
                tradeDecision9.predictedDigit !== tradeDecision2.predictedDigit &&
                tradeDecision9.predictedDigit !== tradeDecision3 &&
                tradeDecision9.predictedDigit !== tradeDecision4.predictedDigit &&
                tradeDecision9.predictedDigit !== tradeDecision5.predictedDigit &&
                tradeDecision9.predictedDigit !== tradeDecision6.predictedDigit &&
                tradeDecision9.predictedDigit !== tradeDecision7.predictedDigit &&
                tradeDecision9.predictedDigit !== tradeDecision8.predictedDigit &&
                tradeDecision9.confidence >= 90
            );


            console.log('FDA Prediction:', tradeDecision.predictedDigit, '(Alt:', tradeDecision.alternativeCandidates.join(','), ') | Confidence:', tradeDecision.confidence, '| Risk:', tradeDecision.riskAssessment, '| Market Regime:', tradeDecision.marketRegime);
            // console.log('MCP Prediction:', tradeDecision2.predictedDigit, '(Alt:', tradeDecision2.alternativeCandidates.join(','), ') | Confidence:', tradeDecision2.confidence, '| Risk:', tradeDecision2.riskAssessment, '| Market Regime:', tradeDecision2.marketRegime);
            // console.log('EITE Prediction:', tradeDecision3.predictedDigit, '(Alt:', tradeDecision3.alternativeCandidates.join(','), ') | Confidence:', tradeDecision3.confidence, '| Risk:', tradeDecision3.riskAssessment, '| Market Regime:', tradeDecision3.marketRegime);
            // console.log('PRNN Prediction:', tradeDecision4.predictedDigit, '(Alt:', tradeDecision4.alternativeCandidates.join(','), ') | Confidence:', tradeDecision4.confidence, '| Risk:', tradeDecision4.riskAssessment, '| Market Regime:', tradeDecision4.marketRegime);
            // console.log('BPE Prediction:', tradeDecision5.predictedDigit, '(Alt:', tradeDecision5.alternativeCandidates.join(','), ') | Confidence:', tradeDecision5.confidence, '| Risk:', tradeDecision5.riskAssessment, '| Market Regime:', tradeDecision5.marketRegime);
            // console.log('GAMR Prediction:', tradeDecision6.predictedDigit, '(Alt:', tradeDecision6.alternativeCandidates.join(','), ') | Confidence:', tradeDecision6.confidence, '| Risk:', tradeDecision6.riskAssessment, '| Market Regime:', tradeDecision6.marketRegime);
            // console.log('MTD Prediction:', tradeDecision7.predictedDigit, '(Alt:', tradeDecision7.alternativeCandidates.join(','), ') | Confidence:', tradeDecision7.confidence, '| Risk:', tradeDecision7.riskAssessment, '| Market Regime:', tradeDecision7.marketRegime);
            // console.log('CTAF Prediction:', tradeDecision8.predictedDigit, '(Alt:', tradeDecision8.alternativeCandidates.join(','), ') | Confidence:', tradeDecision8.confidence, '| Risk:', tradeDecision8.riskAssessment, '| Market Regime:', tradeDecision8.marketRegime);
            // console.log('MCS Prediction:', tradeDecision9.predictedDigit, '(Alt:', tradeDecision9.alternativeCandidates.join(','), ') | Confidence:', tradeDecision9.confidence, '| Risk:', tradeDecision9.riskAssessment, '| Market Regime:', tradeDecision9.marketRegime);



            if (FDA_Engine) {
                console.log(`🎯 Using FDA: (${tradeDecision.confidence}%)`);
                this.lastPrediction = tradeDecision.predictedDigit;
                this.lastConfidence = tradeDecision.confidence;
                this.placeTrade(tradeDecision.predictedDigit, tradeDecision.confidence, kellyResult.stake);
            }
            // else
            //     if (MCP_Engine) {
            //         console.log(`🎯 Using MCP: ${tradeDecision2.confidence}% confidence`);
            //         this.lastPrediction = tradeDecision2.predictedDigit;
            //         this.lastConfidence = tradeDecision2.confidence;
            //         this.placeTrade(tradeDecision2.predictedDigit, tradeDecision2.confidence, kellyResult.stake);
            //     } else
            // if (EITE_Engine) {
            //     console.log(`🎯 Using EITE: ${tradeDecision3.confidence}% confidence`);
            //     this.lastPrediction = tradeDecision3.predictedDigit;
            //     this.lastConfidence = tradeDecision3.confidence;
            //     this.placeTrade(tradeDecision3.predictedDigit, tradeDecision3.confidence, kellyResult.stake);
            // } else
            // if (PRNN_Engine) {
            //     console.log(`🎯 Using PRNN: ${tradeDecision4.confidence}% confidence`);
            //     this.lastPrediction = tradeDecision4.predictedDigit;
            //     this.lastConfidence = tradeDecision4.confidence;
            //     this.placeTrade(tradeDecision4.predictedDigit, tradeDecision4.confidence, kellyResult.stake);
            // } else
            // if (BPE_Engine) {
            //     console.log(`🎯 Using BPE: ${tradeDecision5.confidence}% confidence`);
            //     this.lastPrediction = tradeDecision5.predictedDigit;
            //     this.lastConfidence = tradeDecision5.confidence;
            //     this.placeTrade(tradeDecision5.predictedDigit, tradeDecision5.confidence, kellyResult.stake);
            // } else
            // if (GAMR_Engine) {
            //     console.log(`🎯 Using GAMR: ${tradeDecision6.confidence}% confidence`);
            //     this.lastPrediction = tradeDecision6.predictedDigit;
            //     this.lastConfidence = tradeDecision6.confidence;
            //     this.placeTrade(tradeDecision6.predictedDigit, tradeDecision6.confidence, kellyResult.stake);
            // } else
            // if (MTD_Engine) {
            //     console.log(`🎯 Using MTD: ${tradeDecision7.confidence}% confidence`);
            //     this.lastPrediction = tradeDecision7.predictedDigit;
            //     this.lastConfidence = tradeDecision7.confidence;
            //     this.placeTrade(tradeDecision7.predictedDigit, tradeDecision7.confidence, kellyResult.stake);
            // } else
            // if (CTAF_Engine) {
            //     console.log(`🎯 Using CTAF: ${tradeDecision8.confidence}% confidence`);
            //     this.lastPrediction = tradeDecision8.predictedDigit;
            //     this.lastConfidence = tradeDecision8.confidence;
            //     this.placeTrade(tradeDecision8.predictedDigit, tradeDecision8.confidence, kellyResult.stake);
            // } else
            // if (MCS_Engine) {
            //     console.log(`🎯 Using MCS: ${tradeDecision9.confidence}% confidence`);
            //     this.lastPrediction = tradeDecision9.predictedDigit;
            //     this.lastConfidence = tradeDecision9.confidence;
            //     this.placeTrade(tradeDecision9.predictedDigit, tradeDecision9.confidence, kellyResult.stake);
            // } else 
            {
                console.log('⏭️ No engine met the criteria for trade execution.');
                this.predictionInProgress = false;
            }


        } catch (error) {
            console.error('❌ Analysis error:', error.message);
            this.predictionInProgress = false;
            this.scheduleNextTrade();
        }
    }

    async runAllEngines() {
        const predictions = [];

        console.log('\n   Running AI Engines:');

        // Run each engine (except meta-learner)
        for (const [key, engine] of Object.entries(this.aiEngines)) {
            if (key === 'eml') continue; // Skip meta-learner

            try {
                const result = engine.analyze(this.tickHistory);

                if (result && !result.error && typeof result.predictedDigit === 'number') {
                    result.name = engine.name;
                    result.weight = engine.weight;
                    predictions.push(result);
                    // console.log(`   ✅ ${engine.name}: digit=${result.predictedDigit}, conf=${result.confidence}%`);
                } else if (result && result.error) {
                    console.log(`   ❌ ${engine.name}: ${result.error}`);
                }
            } catch (error) {
                console.log(`   ❌ ${engine.name}: ${error.message}`);
            }
        }

        return predictions;
    }

    shouldExecuteTrade(ensemble, kellyResult) {
        const reasons = [];
        let execute = true;

        if (ensemble.confidence < this.config.minConfidence) {
            execute = false;
            reasons.push(`Low confidence: ${ensemble.confidence}%`);
        }

        if (kellyResult.recommendation.startsWith('SKIP')) {
            execute = false;
            reasons.push('Kelly recommends skip');
        }

        if (ensemble.riskAssessment === 'high') {
            execute = false;
            reasons.push('High risk assessment');
        }

        const agreementParts = ensemble.statisticalEvidence.agreement.split('/');
        const agreement = parseInt(agreementParts[0]);
        const total = parseInt(agreementParts[1]);

        // if (agreement < this.config.minEnginesAgreement && total >= this.config.minEnginesAgreement) {
        //     execute = false;
        //     reasons.push(`Low agreement: ${agreement}/${total}`);
        // }

        if (['volatile', 'chaotic', 'random'].includes(ensemble.marketRegime) && ensemble.confidence < 80) {
            execute = false;
            reasons.push(`${ensemble.marketRegime} market needs 80%+ confidence`);
        }

        const lastTickDigit = this.tickHistory[this.tickHistory.length - 1];
        if (ensemble.predictedDigit === lastTickDigit) {
            execute = false;
            reasons.push(`Digit ${ensemble.predictedDigit} just appeared`);
        }

        if (this.consecutiveLosses >= 4 && ensemble.confidence < 85) {
            execute = false;
            reasons.push('4+ losses need 85%+ confidence');
        }

        return {
            execute,
            reason: execute ? 'All checks passed' : reasons.join(' | ')
        };
    }

    getVolatilityLevel(tickHistory) {
        if (tickHistory.length < 50) return 'medium';
        const recent = tickHistory.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        const stdDev = Math.sqrt(variance);

        if (stdDev > 3.5) return 'extreme';
        if (stdDev > 2.8) return 'high';
        if (stdDev > 2.0) return 'medium';

        console.log(`Volatility stdDev: ${stdDev.toFixed(2)}`);
        return 'low';
    }

    // ==================== TRADE EXECUTION ====================

    placeTrade(digit, confidence, stake) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.predictionInProgress = true;

        // stake = Math.max(this.config.minStake, Math.min(stake, this.balance * 0.1));
        // stake = Math.round(stake * 100) / 100;

        // console.log(`\n💰 Placing trade: DIFFER ${digit} @ $${stake.toFixed(2)} (${confidence}% confidence)`);
        console.log(`\n💰 Placing trade: DIFFER ${digit} @ $${this.currentStake.toFixed(2)} (${confidence}% confidence)`);

        this.sendRequest({
            buy: 1,
            price: this.currentStake.toFixed(2), //stake.toFixed(2),
            parameters: {
                amount: this.currentStake.toFixed(2), //stake.toFixed(2),
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: this.currentAsset,
                barrier: digit
            }
        });

        this.currentPrediction = { digit, confidence, stake };
    }

    handleTradeResult(contract) {
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const exitSpot = contract.exit_tick_display_value;
        const actualDigit = this.getLastDigit(exitSpot, this.currentAsset);

        console.log('\n' + '='.repeat(40));
        console.log(won ? '🎉 TRADE WON!' : '😔 TRADE LOST');
        console.log(`   Predicted: ${this.lastPrediction} | Actual: ${actualDigit}`);
        console.log(`   Profit: ${won ? '+' : ''}$${profit.toFixed(2)}`);
        console.log('='.repeat(40));

        this.totalTrades++;
        this.kellyManager.updateAfterTrade(profit, won);

        // Update engine performance
        for (const [key, engine] of Object.entries(this.aiEngines)) {
            if (engine.lastPrediction !== null && engine.lastPrediction !== undefined) {
                const engineWon = engine.lastPrediction !== actualDigit;
                if (engineWon) {
                    engine.wins++;
                } else {
                    engine.losses++;
                }
                engine.lastOutcome = engineWon ? 'WON' : 'LOST';

                // Update meta-learner performance tracking
                this.aiEngines.eml.updatePerformance(engine.name, engineWon);
            }
            engine.lastPrediction = null;
        }

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.consecutiveWins++;
            this.lastTradeResult = 'won';
            this.currentStake = this.config.minStake;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.consecutiveWins = 0;
            this.lastTradeResult = 'lost';

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;

            if (this.consecutiveLosses === 2) {
                this.consecutiveLosses2++;
            } else if (this.consecutiveLosses === 3) {
                this.consecutiveLosses3++;
            } else if (this.consecutiveLosses === 4) {
                this.consecutiveLosses4++;
            } else if (this.consecutiveLosses === 5) {
                this.consecutiveLosses5++;
            }
        }

        const kellyStatus = this.kellyManager.getStatus();
        console.log(`\n📊 Kelly Status:`);
        console.log(`   Capital: $${kellyStatus.currentCapital.toFixed(2)} (Peak: $${kellyStatus.peakCapital.toFixed(2)})`);
        console.log(`   Drawdown: ${kellyStatus.currentDrawdown.toFixed(1)}%`);
        console.log(`   Session P/L: $${kellyStatus.sessionPnL.toFixed(2)}`);
        console.log(`   Win Rate: ${(kellyStatus.rollingWinRate * 100).toFixed(1)}%`);

        this.logTradingSummary();
        this.logEnginePerformance();

        if (this.checkStopConditions()) {
            return;
        }

        if (!won && this.telegramEnabled) {
            this.sendTelegramLossAlert(actualDigit, profit);
        }

        this.tradeInProgress = false;
        this.predictionInProgress = false;

        this.tradesInCurrentCycle++;
        if (this.tradesInCurrentCycle >= 3) {
            this.selectRandomEngineSetup();
        }

        this.scheduleNextTrade2();
    }

    checkStopConditions() {
        const kellyStatus = this.kellyManager.shouldContinueTrading();

        if (!kellyStatus.canTrade) {
            console.log('\n🛑 Kelly Manager stopping trading:');
            kellyStatus.reasons.forEach(r => console.log(`   - ${r}`));
            this.shutdown();
            return true;
        }

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('\n🛑 Max consecutive losses reached.');
            this.shutdown();
            return true;
        }

        if (kellyStatus.reachedDailyTarget) {
            console.log('\n🎉 Daily profit target reached!');
            this.shutdown();
            return true;
        }

        return false;
    }

    scheduleNextTrade() {
        const waitTime = Math.floor(
            Math.random() * (30000 - 25000) +
            1000
        );

        console.log(`\n⏳ Waiting ${Math.round(waitTime / 1000)}s before next trade...`);

        this.isPaused = true;
        this.disconnect();

        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.isPaused = false;
                this.reconnectAttempts = 0;
                this.connect();
            }
        }, waitTime);
    }

    scheduleNextTrade2() {
        const waitTime = Math.floor(
            Math.random() * (this.config.maxWaitTime - this.config.minWaitTime) +
            this.config.minWaitTime
        );

        console.log(`\n⏳ Next trade in ${Math.round(waitTime / 1000)}s...`);
        this.isPaused = true;
        this.disconnect();
        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.isPaused = false;
                this.reconnectAttempts = 0;
                this.connect();
            }
        }, waitTime);
    }

    scheduleReconnect(delay) {
        this.isPaused = true;
        this.disconnect();

        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.isPaused = false;
                this.reconnectAttempts = 0;
                this.connect();
            }
        }, delay);
    }

    // ==================== LOGGING & NOTIFICATIONS ====================

    logTradingSummary() {
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;

        const kellyStatus = this.kellyManager.getStatus();

        console.log('\n📊 Trading Summary:');
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins/Losses: ${this.totalWins}/${this.totalLosses}`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Session P/L: $${kellyStatus.sessionPnL.toFixed(2)}`);
        console.log(`   Balance: $${this.balance.toFixed(2)}`);
    }

    logEnginePerformance() {
        console.log('\n🧠 Engine Performance:');
        for (const [key, engine] of Object.entries(this.aiEngines)) {
            if (key === 'eml') continue;
            const total = engine.wins + engine.losses;
            const winRate = total > 0 ? ((engine.wins / total) * 100).toFixed(1) : 'N/A';
            console.log(`   ${engine.name}: ${engine.wins}W/${engine.losses}L (${winRate}%)`);
        }
    }

    logFinalSummary() {
        const duration = this.getSessionDuration();
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;
        const kellyStatus = this.kellyManager.getStatus();

        console.log('\n' + '='.repeat(60));
        console.log('📊 FINAL TRADING SUMMARY');
        console.log('='.repeat(60));
        console.log(`   Session Duration: ${duration}`);
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins: ${this.totalWins}`);
        console.log(`   Losses: ${this.totalLosses}`);
        console.log(`   x2Losses: ${this.consecutiveLosses2}`);
        console.log(`   x3Losses: ${this.consecutiveLosses3}`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Session P/L: $${kellyStatus.sessionPnL.toFixed(2)}`);
        console.log(`   Starting Capital: $${kellyStatus.investmentCapital.toFixed(2)}`);
        console.log(`   Final Capital: $${kellyStatus.currentCapital.toFixed(2)}`);
        console.log(`   Max Drawdown: ${kellyStatus.maxDrawdownReached.toFixed(1)}%`);
        console.log(`   ROI: ${((kellyStatus.currentCapital - kellyStatus.investmentCapital) / kellyStatus.investmentCapital * 100).toFixed(2)}%`);

        console.log('\n🧠 Final Engine Performance:');
        for (const [key, engine] of Object.entries(this.aiEngines)) {
            if (key === 'eml') continue;
            const total = engine.wins + engine.losses;
            const winRate = total > 0 ? ((engine.wins / total) * 100).toFixed(1) : 'N/A';
            console.log(`   ${engine.name}: ${engine.wins}W/${engine.losses}L (${winRate}%)`);
        }

        console.log('='.repeat(60) + '\n');

        if (this.telegramEnabled) {
            this.sendTelegramMessage(`<b>⏹ Bot Stopped</b>\n\n${this.getTelegramSummary()}`);
        }
    }

    getSessionDuration() {
        const now = new Date();
        const diff = now - this.sessionStartTime;
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        return `${hours}h ${minutes}m`;
    }

    getTelegramSummary() {
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;
        const kellyStatus = this.kellyManager.getStatus();

        let engineStats = '';
        for (const [key, engine] of Object.entries(this.aiEngines)) {
            if (key === 'eml') continue;
            const total = engine.wins + engine.losses;
            if (total > 0) {
                const wr = ((engine.wins / total) * 100).toFixed(0);
                engineStats += `${engine.name}: ${wr}% | `;
            }
        }

        return `<b>AI-Logic Trading Summary</b>
            ━━━━━━━━━━━━━━━━━━━━━━━━
            📊 <b>Total Trades:</b> ${this.totalTrades}
            ✅ <b>Wins:</b> ${this.totalWins}
            ❌ <b>Losses:</b> ${this.totalLosses}
            ❌ <b>x2 Losses:</b> ${this.consecutiveLosses2}
            ❌ <b>x3 Losses:</b> ${this.consecutiveLosses3}
            
            📈 <b>Win Rate:</b> ${winRate}%

            💰 <b>Investment:</b> $${kellyStatus.investmentCapital.toFixed(2)}
            💵 <b>Current Capital:</b> $${kellyStatus.currentCapital.toFixed(2)}
            📉 <b>Max Drawdown:</b> ${kellyStatus.maxDrawdownReached.toFixed(1)}%
            📊 <b>Session P/L:</b> $${kellyStatus.sessionPnL.toFixed(2)}
            📈 <b>ROI:</b> ${((kellyStatus.currentCapital - kellyStatus.investmentCapital) / kellyStatus.investmentCapital * 100).toFixed(2)}%

            🧠 <b>Engine Stats:</b>
            ${engineStats}
        `;
    }

    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;

        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error('❌ Telegram error:', error.message);
        }
    }

    startTelegramTimer() {
        setInterval(() => {
            if (this.totalTrades > 0 && !this.isShuttingDown) {
                this.sendTelegramMessage(`📊 <b>Performance Update</b>\n\n${this.getTelegramSummary()}`);
            }
        }, 30 * 60 * 1000);
    }

    async sendTelegramLossAlert(actualDigit, profit) {

        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;
        const kellyStatus = this.kellyManager.getStatus();

        let engineStats = '';
        for (const [key, engine] of Object.entries(this.aiEngines)) {
            if (key === 'eml') continue;
            const total = engine.wins + engine.losses;
            if (total > 0) {
                const wr = ((engine.wins / total) * 100).toFixed(0);
                engineStats += `${engine.name}: ${wr}% | `;
            }
        }

        const body = `🚨 <b>TRADE LOSS</b>
            ━━━━━━━━━━━━━━━━━━━━
            <b>Asset:</b> ${this.currentAsset}
            <b>Predicted:</b> ${this.lastPrediction} | <b>Actual:</b> ${actualDigit}
            <b>Loss:</b> -$${Math.abs(profit).toFixed(2)}
            
            📊 <b>Total Trades:</b> ${this.totalTrades}
            ✅ <b>Wins:</b> ${this.totalWins}
            <b>Consecutive Losses:</b> ${this.consecutiveLosses}/${this.config.maxConsecutiveLosses}
            ❌ <b>Losses:</b> ${this.totalLosses}
            ❌ <b>x2 Losses:</b> ${this.consecutiveLosses2}
            ❌ <b>x3 Losses:</b> ${this.consecutiveLosses3}
            
            📈 <b>Win Rate:</b> ${winRate}%

            💰 <b>Investment:</b> $${kellyStatus.investmentCapital.toFixed(2)}
            💵 <b>Current Capital:</b> $${kellyStatus.currentCapital.toFixed(2)}
            📉 <b>Max Drawdown:</b> ${kellyStatus.maxDrawdownReached.toFixed(1)}%
            📊 <b>Session P/L:</b> $${kellyStatus.sessionPnL.toFixed(2)}
            <b>Drawdown:</b> ${kellyStatus.currentDrawdown.toFixed(1)}%
            <b>Capital:</b> $${kellyStatus.currentCapital.toFixed(2)}
        `;

        await this.sendTelegramMessage(body);
    }

    // ==================== START BOT ====================

    start() {
        console.log('🚀 Starting AI-Logic Digit Differ Bot v5.0...');
        console.log('   Simulated AI Ensemble System Active\n');

        if (!this.token) {
            console.error('❌ Error: DERIV_TOKEN is required');
            process.exit(1);
        }

        process.on('uncaughtException', (error) => {
            console.error('Uncaught Exception:', error.message);
        });

        process.on('unhandledRejection', (reason) => {
            console.error('Unhandled Rejection:', reason);
        });

        this.connect();
    }
}

// ==================== STARTUP ====================

if (!process.env.DERIV_TOKEN) {
    console.error('❌ Error: DERIV_TOKEN is required in .env file');
    process.exit(1);
}

const bot = new AILogicDigitDifferBot({
    derivToken: '0P94g4WdSrSrzir', //process.env.DERIV_TOKEN,

    investmentCapital: 100,
    kellyFraction: 0.25,
    minStake: 0.61,
    maxStakePercent: 5,
    multiplier: 11.3,

    maxDrawdownPercent: 25,
    dailyLossLimit: 50,
    dailyProfitTarget: 15,
    maxConsecutiveLosses: 3,//6

    minConfidence: 95,
    minEnginesAgreement: 1,
    requiredHistoryLength: 1000,
    minWaitTime: 1000,
    maxWaitTime: 1000,
});

bot.start();
