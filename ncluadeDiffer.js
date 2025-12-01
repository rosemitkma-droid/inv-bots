/**
 * Smart Deriv Differ Trading Bot
 * Version 2.0 - Advanced AI Learning System
 * 
 * Smart Differ: Win if the last digit of the final tick is DIFFERENT from your chosen digit
 * Base Win Rate: ~90% (9/10 outcomes win)
 * Strategy: Choose the digit most likely to appear, bet it will DIFFER
 * 
 * Features:
 * - Digit Frequency Analysis with Chi-Square Testing
 * - Bayesian Digit Probability Estimation
 * - Markov Chain Digit Transition Prediction
 * - Neural Network Sequence Prediction
 * - Hot/Cold Digit Detection
 * - Ensemble Decision Making
 * - Persistent Learning Memory
 */

require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ============================================================================
// TIER 1: DIGIT STATISTICAL ENGINE
// ============================================================================

class DigitStatisticalEngine {
    constructor() {
        this.digitFrequencies = {};      // Per-asset digit frequencies
        this.bayesianPriors = {};        // Bayesian digit probabilities
        this.chiSquareScores = {};       // Statistical significance of digit deviations
        this.entropyScores = {};         // Market randomness scores
        this.expectedFrequency = 0.1;    // Expected frequency for uniform distribution (1/10)
    }

    /**
     * Initialize digit tracking for an asset
     */
    initAsset(asset) {
        this.digitFrequencies[asset] = {
            counts: Array(10).fill(0),
            total: 0,
            recentCounts: Array(10).fill(0),  // Last 100 ticks
            recentTotal: 0
        };
        this.bayesianPriors[asset] = Array(10).fill(null).map(() => ({ alpha: 1, beta: 9 }));
        this.chiSquareScores[asset] = Array(10).fill(0);
    }

    /**
     * Update digit frequency counts
     */
    updateFrequency(asset, digit) {
        if (!this.digitFrequencies[asset]) {
            this.initAsset(asset);
        }

        const freq = this.digitFrequencies[asset];
        freq.counts[digit]++;
        freq.total++;

        // Update recent window (sliding window of last 100)
        freq.recentCounts[digit]++;
        freq.recentTotal++;

        // Trim recent window
        if (freq.recentTotal > 100) {
            // Decay all recent counts proportionally
            for (let i = 0; i < 10; i++) {
                freq.recentCounts[i] = Math.floor(freq.recentCounts[i] * 0.99);
            }
            freq.recentTotal = freq.recentCounts.reduce((a, b) => a + b, 0);
        }

        // Update Bayesian priors
        this.updateBayesian(asset, digit);

        // Recalculate chi-square scores
        this.calculateChiSquare(asset);
    }

    /**
     * Get digit frequencies as probabilities
     */
    getDigitProbabilities(asset, useRecent = true) {
        if (!this.digitFrequencies[asset]) {
            return Array(10).fill(0.1);
        }

        const freq = this.digitFrequencies[asset];
        const counts = useRecent ? freq.recentCounts : freq.counts;
        const total = useRecent ? freq.recentTotal : freq.total;

        if (total === 0) {
            return Array(10).fill(0.1);
        }

        return counts.map(c => c / total);
    }

    /**
     * Bayesian probability update using Dirichlet-Multinomial
     */
    updateBayesian(asset, observedDigit) {
        if (!this.bayesianPriors[asset]) {
            this.bayesianPriors[asset] = Array(10).fill(null).map(() => ({ alpha: 1, beta: 9 }));
        }

        // Update the observed digit's alpha (success)
        this.bayesianPriors[asset][observedDigit].alpha += 1;

        // Update all other digits' beta (failure to appear)
        for (let i = 0; i < 10; i++) {
            if (i !== observedDigit) {
                this.bayesianPriors[asset][i].beta += 1;
            }
        }

        // Apply decay to prevent over-confidence
        const decay = 0.999;
        for (let i = 0; i < 10; i++) {
            this.bayesianPriors[asset][i].alpha = Math.max(1, this.bayesianPriors[asset][i].alpha * decay);
            this.bayesianPriors[asset][i].beta = Math.max(1, this.bayesianPriors[asset][i].beta * decay);
        }
    }

    /**
     * Get Bayesian probability estimates for each digit
     */
    getBayesianEstimates(asset) {
        if (!this.bayesianPriors[asset]) {
            return Array(10).fill({ mean: 0.1, variance: 0.01, confidence: 0 });
        }

        return this.bayesianPriors[asset].map(prior => {
            const { alpha, beta } = prior;
            const mean = alpha / (alpha + beta);
            const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
            const confidence = alpha + beta;

            return { mean, variance, confidence };
        });
    }

    /**
     * Chi-Square test for digit distribution anomalies
     * High score = digit appearing more/less than expected
     */
    calculateChiSquare(asset) {
        if (!this.digitFrequencies[asset]) return;

        const freq = this.digitFrequencies[asset];
        if (freq.recentTotal < 30) return; // Need sufficient samples

        const expected = freq.recentTotal * this.expectedFrequency;

        for (let i = 0; i < 10; i++) {
            const observed = freq.recentCounts[i];
            const chiSq = Math.pow(observed - expected, 2) / expected;

            // Positive if over-represented, negative if under-represented
            const direction = observed > expected ? 1 : -1;
            this.chiSquareScores[asset][i] = chiSq * direction;
        }
    }

    /**
     * Get hot digits (appearing more than expected)
     */
    getHotDigits(asset, threshold = 2.0) {
        if (!this.chiSquareScores[asset]) return [];

        return this.chiSquareScores[asset]
            .map((score, digit) => ({ digit, score }))
            .filter(d => d.score > threshold)
            .sort((a, b) => b.score - a.score)
            .map(d => d.digit);
    }

    /**
     * Get cold digits (appearing less than expected)
     */
    getColdDigits(asset, threshold = -2.0) {
        if (!this.chiSquareScores[asset]) return [];

        return this.chiSquareScores[asset]
            .map((score, digit) => ({ digit, score }))
            .filter(d => d.score < threshold)
            .sort((a, b) => a.score - b.score)
            .map(d => d.digit);
    }

    /**
     * Calculate Shannon entropy of digit distribution
     * Lower = more predictable, Higher = more random
     */
    calculateEntropy(asset) {
        const probs = this.getDigitProbabilities(asset, true);

        let entropy = 0;
        probs.forEach(p => {
            if (p > 0) {
                entropy -= p * Math.log2(p);
            }
        });

        // Normalize (max entropy for 10 digits is log2(10) ≈ 3.32)
        const normalizedEntropy = entropy / Math.log2(10);
        this.entropyScores[asset] = normalizedEntropy;

        return normalizedEntropy;
    }

    /**
     * Find the best digit to bet AGAINST (most likely to appear)
     */
    getBestDigitToDiffer(asset) {
        const probs = this.getDigitProbabilities(asset, true);
        const bayesian = this.getBayesianEstimates(asset);
        const hotDigits = this.getHotDigits(asset);

        // Score each digit
        const scores = [];
        for (let digit = 0; digit < 10; digit++) {
            // Higher score = more likely to appear = better to bet DIFFER
            let score = 0;

            // Frequency-based score
            score += probs[digit] * 40;

            // Bayesian mean
            score += bayesian[digit].mean * 30;

            // Hot digit bonus
            if (hotDigits.includes(digit)) {
                score += 20;
            }

            // Confidence adjustment
            const confidence = Math.min(1, bayesian[digit].confidence / 100);
            score *= (0.5 + 0.5 * confidence);

            scores.push({ digit, score, prob: probs[digit], bayesian: bayesian[digit].mean });
        }

        // Sort by score descending
        scores.sort((a, b) => b.score - a.score);

        return scores;
    }

    /**
     * Export state for persistence
     */
    exportState() {
        return {
            digitFrequencies: this.digitFrequencies,
            bayesianPriors: this.bayesianPriors,
            chiSquareScores: this.chiSquareScores,
            entropyScores: this.entropyScores
        };
    }

    /**
     * Import state from saved data
     */
    importState(state) {
        if (state.digitFrequencies) this.digitFrequencies = state.digitFrequencies;
        if (state.bayesianPriors) this.bayesianPriors = state.bayesianPriors;
        if (state.chiSquareScores) this.chiSquareScores = state.chiSquareScores;
        if (state.entropyScores) this.entropyScores = state.entropyScores;
    }
}

// ============================================================================
// TIER 2: DIGIT PATTERN ENGINE
// ============================================================================

class DigitPatternEngine {
    constructor() {
        this.transitionMatrices = {};    // Markov chain transitions
        this.ngramModels = {};           // N-gram sequence patterns
        this.streakTrackers = {};        // Digit streak tracking
        this.sequenceBuffers = {};       // Recent digit sequences
    }

    /**
     * Initialize pattern tracking for an asset
     */
    initAsset(asset) {
        // First-order Markov transition matrix (10x10)
        this.transitionMatrices[asset] = {
            first: Array(10).fill(null).map(() => Array(10).fill(0)),
            second: {},  // Second-order: key = "d1,d2" -> counts[10]
            totals: Array(10).fill(0)
        };
        this.ngramModels[asset] = {};
        this.streakTrackers[asset] = { currentDigit: null, streakLength: 0, history: [] };
        this.sequenceBuffers[asset] = [];
    }

    /**
     * Update pattern models with new digit observation
     */
    updatePatterns(asset, digit) {
        if (!this.transitionMatrices[asset]) {
            this.initAsset(asset);
        }

        const buffer = this.sequenceBuffers[asset];

        // Update first-order Markov
        if (buffer.length >= 1) {
            const prevDigit = buffer[buffer.length - 1];
            this.transitionMatrices[asset].first[prevDigit][digit]++;
            this.transitionMatrices[asset].totals[prevDigit]++;
        }

        // Update second-order Markov
        if (buffer.length >= 2) {
            const key = `${buffer[buffer.length - 2]},${buffer[buffer.length - 1]}`;
            if (!this.transitionMatrices[asset].second[key]) {
                this.transitionMatrices[asset].second[key] = Array(10).fill(0);
            }
            this.transitionMatrices[asset].second[key][digit]++;
        }

        // Update N-gram models
        this.updateNgrams(asset, digit);

        // Update streak tracker
        this.updateStreak(asset, digit);

        // Add to buffer
        buffer.push(digit);
        if (buffer.length > 100) {
            buffer.shift();
        }
    }

    /**
     * Update N-gram frequency models
     */
    updateNgrams(asset, digit) {
        const buffer = this.sequenceBuffers[asset];
        if (!this.ngramModels[asset]) {
            this.ngramModels[asset] = {};
        }

        // Build n-grams of length 2-5
        for (let n = 2; n <= 5; n++) {
            if (buffer.length >= n - 1) {
                const context = buffer.slice(-(n - 1)).join(',');
                const key = `${n}:${context}`;

                if (!this.ngramModels[asset][key]) {
                    this.ngramModels[asset][key] = Array(10).fill(0);
                }
                this.ngramModels[asset][key][digit]++;
            }
        }
    }

    /**
     * Update digit streak tracking
     */
    updateStreak(asset, digit) {
        const tracker = this.streakTrackers[asset];

        if (digit === tracker.currentDigit) {
            tracker.streakLength++;
        } else {
            // Record completed streak
            if (tracker.currentDigit !== null && tracker.streakLength > 1) {
                tracker.history.push({
                    digit: tracker.currentDigit,
                    length: tracker.streakLength
                });
                if (tracker.history.length > 100) {
                    tracker.history.shift();
                }
            }
            tracker.currentDigit = digit;
            tracker.streakLength = 1;
        }
    }

    /**
     * Get transition probabilities from current digit
     */
    getTransitionProbabilities(asset, currentDigit, order = 1) {
        if (!this.transitionMatrices[asset]) {
            return Array(10).fill(0.1);
        }

        if (order === 1) {
            const total = this.transitionMatrices[asset].totals[currentDigit];
            if (total === 0) return Array(10).fill(0.1);

            return this.transitionMatrices[asset].first[currentDigit].map(c => c / total);
        }

        // Second order
        const buffer = this.sequenceBuffers[asset];
        if (buffer.length < 1) return Array(10).fill(0.1);

        const key = `${buffer[buffer.length - 1]},${currentDigit}`;
        const counts = this.transitionMatrices[asset].second[key];

        if (!counts) return Array(10).fill(0.1);

        const total = counts.reduce((a, b) => a + b, 0);
        if (total === 0) return Array(10).fill(0.1);

        return counts.map(c => c / total);
    }

    /**
     * Predict next digit probabilities using N-grams
     */
    predictFromNgrams(asset, n = 3) {
        const buffer = this.sequenceBuffers[asset];
        if (!this.ngramModels[asset] || buffer.length < n - 1) {
            return null;
        }

        const context = buffer.slice(-(n - 1)).join(',');
        const key = `${n}:${context}`;
        const counts = this.ngramModels[asset][key];

        if (!counts) return null;

        const total = counts.reduce((a, b) => a + b, 0);
        if (total < 5) return null; // Need sufficient samples

        const probs = counts.map(c => c / total);
        const maxProb = Math.max(...probs);
        const predictedDigit = probs.indexOf(maxProb);

        return {
            probabilities: probs,
            predictedDigit,
            confidence: maxProb,
            samples: total
        };
    }

    /**
     * Check if a digit is in an active streak
     */
    isDigitStreaking(asset, digit) {
        const tracker = this.streakTrackers[asset];
        return tracker.currentDigit === digit && tracker.streakLength >= 2;
    }

    /**
     * Get average streak length for a digit
     */
    getAverageStreakLength(asset, digit) {
        const tracker = this.streakTrackers[asset];
        const digitStreaks = tracker.history.filter(s => s.digit === digit);

        if (digitStreaks.length === 0) return 1;

        const avgLength = digitStreaks.reduce((a, b) => a + b.length, 0) / digitStreaks.length;
        return avgLength;
    }

    /**
     * Predict most likely next digits based on all pattern models
     */
    predictNextDigits(asset) {
        const buffer = this.sequenceBuffers[asset];
        if (buffer.length === 0) return null;

        const currentDigit = buffer[buffer.length - 1];

        // Get predictions from different models
        const firstOrder = this.getTransitionProbabilities(asset, currentDigit, 1);
        const secondOrder = this.getTransitionProbabilities(asset, currentDigit, 2);
        const ngram3 = this.predictFromNgrams(asset, 3);
        const ngram4 = this.predictFromNgrams(asset, 4);

        // Combine predictions
        const combined = Array(10).fill(0);
        const weights = { first: 0.2, second: 0.3, ngram3: 0.3, ngram4: 0.2 };

        for (let i = 0; i < 10; i++) {
            combined[i] += firstOrder[i] * weights.first;
            combined[i] += secondOrder[i] * weights.second;

            if (ngram3) {
                combined[i] += ngram3.probabilities[i] * weights.ngram3;
            } else {
                combined[i] += 0.1 * weights.ngram3;
            }

            if (ngram4) {
                combined[i] += ngram4.probabilities[i] * weights.ngram4;
            } else {
                combined[i] += 0.1 * weights.ngram4;
            }
        }

        // Normalize
        const sum = combined.reduce((a, b) => a + b, 0);
        const normalized = combined.map(p => p / sum);

        return {
            probabilities: normalized,
            mostLikely: normalized.indexOf(Math.max(...normalized)),
            leastLikely: normalized.indexOf(Math.min(...normalized))
        };
    }

    /**
     * Export state for persistence
     */
    exportState() {
        return {
            transitionMatrices: this.transitionMatrices,
            ngramModels: this.ngramModels,
            streakTrackers: this.streakTrackers,
            sequenceBuffers: this.sequenceBuffers
        };
    }

    /**
     * Import state from saved data
     */
    importState(state) {
        if (state.transitionMatrices) this.transitionMatrices = state.transitionMatrices;
        if (state.ngramModels) this.ngramModels = state.ngramModels;
        if (state.streakTrackers) this.streakTrackers = state.streakTrackers;
        if (state.sequenceBuffers) this.sequenceBuffers = state.sequenceBuffers;
    }
}

// ============================================================================
// TIER 3: NEURAL NETWORK DIGIT PREDICTOR
// ============================================================================

class DigitNeuralEngine {
    constructor(inputSize = 50, hiddenSizes = [64, 32], outputSize = 10) {
        this.inputSize = inputSize;
        this.hiddenSizes = hiddenSizes;
        this.outputSize = outputSize;
        this.learningRate = 0.01;
        this.momentum = 0.9;
        this.weights = {};
        this.biases = {};
        this.velocities = {};
        this.trainingHistory = [];
        this.initialized = false;

        this.initializeNetwork();
    }

    initializeNetwork() {
        const layers = [this.inputSize, ...this.hiddenSizes, this.outputSize];

        for (let i = 0; i < layers.length - 1; i++) {
            const fanIn = layers[i];
            const fanOut = layers[i + 1];
            const scale = Math.sqrt(2.0 / (fanIn + fanOut));

            this.weights[i] = [];
            this.velocities[`w${i}`] = [];

            for (let j = 0; j < fanOut; j++) {
                this.weights[i][j] = [];
                this.velocities[`w${i}`][j] = [];

                for (let k = 0; k < fanIn; k++) {
                    this.weights[i][j][k] = (Math.random() * 2 - 1) * scale;
                    this.velocities[`w${i}`][j][k] = 0;
                }
            }

            this.biases[i] = new Array(fanOut).fill(0).map(() => (Math.random() * 2 - 1) * 0.1);
            this.velocities[`b${i}`] = new Array(fanOut).fill(0);
        }

        this.initialized = true;
    }

    relu(x) {
        return Math.max(0, x);
    }

    reluDerivative(x) {
        return x > 0 ? 1 : 0;
    }

    softmax(arr) {
        const maxVal = Math.max(...arr);
        const exps = arr.map(x => Math.exp(x - maxVal));
        const sum = exps.reduce((a, b) => a + b, 0);
        return exps.map(e => e / sum);
    }

    /**
     * Forward pass through the network
     */
    forward(input) {
        if (input.length !== this.inputSize) {
            console.error(`Input size mismatch: expected ${this.inputSize}, got ${input.length}`);
            return { output: Array(10).fill(0.1), activations: [] };
        }

        const activations = [input];
        let current = input;

        const numLayers = Object.keys(this.weights).length;

        for (let i = 0; i < numLayers; i++) {
            const nextLayer = [];

            for (let j = 0; j < this.weights[i].length; j++) {
                let sum = this.biases[i][j];

                for (let k = 0; k < current.length; k++) {
                    sum += current[k] * this.weights[i][j][k];
                }

                // ReLU for hidden layers, raw for output (softmax applied separately)
                if (i < numLayers - 1) {
                    nextLayer.push(this.relu(sum));
                } else {
                    nextLayer.push(sum);
                }
            }

            current = nextLayer;
            activations.push(current);
        }

        // Apply softmax to output
        const output = this.softmax(current);

        return { output, activations, rawOutput: current };
    }

    /**
     * Train on a single sample
     */
    trainOnSample(input, targetDigit) {
        const { output, activations, rawOutput } = this.forward(input);

        // Cross-entropy loss gradient
        const outputGradient = [...output];
        outputGradient[targetDigit] -= 1; // Gradient of cross-entropy with softmax

        // Backpropagate
        const numLayers = Object.keys(this.weights).length;
        let delta = outputGradient;

        for (let i = numLayers - 1; i >= 0; i--) {
            const prevActivation = activations[i];
            const newDelta = [];

            // Update weights and biases
            for (let j = 0; j < this.weights[i].length; j++) {
                for (let k = 0; k < this.weights[i][j].length; k++) {
                    const grad = delta[j] * prevActivation[k];
                    this.velocities[`w${i}`][j][k] =
                        this.momentum * this.velocities[`w${i}`][j][k] - this.learningRate * grad;
                    this.weights[i][j][k] += this.velocities[`w${i}`][j][k];
                }

                this.velocities[`b${i}`][j] =
                    this.momentum * this.velocities[`b${i}`][j] - this.learningRate * delta[j];
                this.biases[i][j] += this.velocities[`b${i}`][j];
            }

            // Compute delta for previous layer
            if (i > 0) {
                for (let k = 0; k < this.weights[i][0].length; k++) {
                    let sum = 0;
                    for (let j = 0; j < this.weights[i].length; j++) {
                        sum += delta[j] * this.weights[i][j][k];
                    }
                    newDelta.push(sum * this.reluDerivative(prevActivation[k]));
                }
                delta = newDelta;
            }
        }

        // Calculate loss
        const loss = -Math.log(Math.max(output[targetDigit], 1e-10));

        this.trainingHistory.push({
            loss,
            predicted: output.indexOf(Math.max(...output)),
            actual: targetDigit,
            correct: output.indexOf(Math.max(...output)) === targetDigit
        });

        if (this.trainingHistory.length > 1000) {
            this.trainingHistory.shift();
        }

        return { loss, predicted: output.indexOf(Math.max(...output)) };
    }

    /**
     * Predict digit probabilities
     */
    predict(input) {
        const { output } = this.forward(input);
        return output;
    }

    /**
     * Prepare input features from digit sequence
     */
    prepareFeatures(digitSequence, digitFrequencies) {
        const features = [];

        // Last 30 digits (one-hot encoded partially)
        const recent = digitSequence.slice(-30);
        while (recent.length < 30) recent.unshift(5); // Pad with 5
        recent.forEach(d => features.push(d / 9)); // Normalize

        // Digit frequency distribution (10 features)
        if (digitFrequencies && digitFrequencies.length === 10) {
            digitFrequencies.forEach(f => features.push(f));
        } else {
            for (let i = 0; i < 10; i++) features.push(0.1);
        }

        // Transition features from last few digits
        const last3 = digitSequence.slice(-3);
        while (last3.length < 3) last3.unshift(5);
        last3.forEach(d => features.push(d / 9));

        // Streak features
        let streakLength = 1;
        for (let i = digitSequence.length - 2; i >= 0 && digitSequence[i] === digitSequence[digitSequence.length - 1]; i--) {
            streakLength++;
        }
        features.push(Math.min(streakLength, 10) / 10);

        // Pad to input size
        while (features.length < this.inputSize) {
            features.push(0.5);
        }

        return features.slice(0, this.inputSize);
    }

    /**
     * Get performance metrics
     */
    getPerformanceMetrics() {
        if (this.trainingHistory.length < 10) {
            return { accuracy: 0, recentLoss: 1, trend: 'insufficient_data' };
        }

        const recent = this.trainingHistory.slice(-100);
        const avgLoss = recent.reduce((a, b) => a + b.loss, 0) / recent.length;
        const correct = recent.filter(h => h.correct).length;
        const accuracy = correct / recent.length;

        const firstHalf = recent.slice(0, 50);
        const secondHalf = recent.slice(-50);
        const firstLoss = firstHalf.reduce((a, b) => a + b.loss, 0) / firstHalf.length;
        const secondLoss = secondHalf.reduce((a, b) => a + b.loss, 0) / secondHalf.length;

        const trend = secondLoss < firstLoss * 0.9 ? 'improving' :
            secondLoss > firstLoss * 1.1 ? 'degrading' : 'stable';

        return { accuracy, recentLoss: avgLoss, trend };
    }

    exportWeights() {
        return {
            weights: this.weights,
            biases: this.biases,
            velocities: this.velocities,
            trainingHistory: this.trainingHistory.slice(-500)
        };
    }

    importWeights(state) {
        if (state.weights) this.weights = state.weights;
        if (state.biases) this.biases = state.biases;
        if (state.velocities) this.velocities = state.velocities;
        if (state.trainingHistory) this.trainingHistory = state.trainingHistory;
        this.initialized = true;
    }
}

// ============================================================================
// TIER 4: ENSEMBLE DIGIT DECISION MAKER
// ============================================================================

class DigitEnsembleDecisionMaker {
    constructor() {
        this.modelWeights = { statistical: 0.30, pattern: 0.25, neural: 0.25, streak: 0.20 };
        this.modelPerformance = {
            statistical: { correct: 0, total: 0 },
            pattern: { correct: 0, total: 0 },
            neural: { correct: 0, total: 0 },
            streak: { correct: 0, total: 0 }
        };
        this.recentDecisions = [];
        this.confidenceThreshold = 0.85;
    }

    selectDigitToDiffer(predictions) {
        const combinedScores = Array(10).fill(0);
        const details = {};

        if (predictions.statistical) {
            const scores = predictions.statistical;
            for (let i = 0; i < 10; i++) {
                const scoreItem = scores.find(s => s.digit === i);
                if (scoreItem) combinedScores[i] += scoreItem.score * this.modelWeights.statistical;
            }
            details.statistical = scores.slice(0, 3).map(s => `${s.digit}:${s.score.toFixed(1)}`).join(', ');
        }

        if (predictions.pattern && predictions.pattern.probabilities) {
            for (let i = 0; i < 10; i++) {
                combinedScores[i] += predictions.pattern.probabilities[i] * 100 * this.modelWeights.pattern;
            }
            details.pattern = `Most likely: ${predictions.pattern.mostLikely}`;
        }

        if (predictions.neural) {
            for (let i = 0; i < 10; i++) {
                combinedScores[i] += predictions.neural[i] * 100 * this.modelWeights.neural;
            }
            const maxNeural = predictions.neural.indexOf(Math.max(...predictions.neural));
            details.neural = `Predicted: ${maxNeural}`;
        }

        if (predictions.streak && predictions.streak.streaking !== null) {
            combinedScores[predictions.streak.streaking] += 15 * this.modelWeights.streak;
            details.streak = `Streaking: ${predictions.streak.streaking}`;
        }

        const ranked = combinedScores.map((score, digit) => ({ digit, score })).sort((a, b) => b.score - a.score);
        const totalScore = combinedScores.reduce((a, b) => a + b, 0);
        const avgScore = totalScore / 10;
        const maxScore = Math.max(...combinedScores);
        const minScore = Math.min(...combinedScores);

        // Fixed confidence calculation - always between 0 and 1
        let confidence = 0;
        if (avgScore > 0) {
            const rawConfidence = (ranked[0].score - avgScore) / avgScore;
            // Use sigmoid-like normalization to keep between 0 and 1
            confidence = Math.min(1, Math.max(0, rawConfidence / (1 + Math.abs(rawConfidence)) + 0.5));
        }

        // Secondary confidence measure based on score spread
        const scoreSpread = maxScore - minScore;
        const spreadConfidence = totalScore > 0 ? Math.min(1, scoreSpread / (totalScore * 0.3)) : 0;

        // Blend both confidence measures and ensure it's capped at 1
        const finalConfidence = Math.min(1, (confidence + spreadConfidence) / 2);

        return {
            digitToDiffer: ranked[0].digit,
            alternativeDigit: ranked[1].digit,
            scores: ranked,
            confidence: finalConfidence,
            probability: totalScore > 0 ? ranked[0].score / totalScore : 0.1,
            shouldTrade: finalConfidence > this.confidenceThreshold,
            details
        };
    }

    /**
     * Record outcome and update model weights
     */
    recordOutcome(predictions, chosenDigit, actualDigit, won) {
        // The goal was for actualDigit to be DIFFERENT from chosenDigit
        // won = true means actualDigit !== chosenDigit

        Object.entries(predictions).forEach(([model, pred]) => {
            if (!pred) return;

            let modelPredicted;
            if (model === 'statistical' && Array.isArray(pred)) {
                modelPredicted = pred[0]?.digit;
            } else if (model === 'pattern' && pred.mostLikely !== undefined) {
                modelPredicted = pred.mostLikely;
            } else if (model === 'neural' && Array.isArray(pred)) {
                modelPredicted = pred.indexOf(Math.max(...pred));
            } else if (model === 'streak' && pred.streaking !== null) {
                modelPredicted = pred.streaking;
            }

            if (modelPredicted !== undefined) {
                this.modelPerformance[model].total++;
                // Model is correct if it predicted actualDigit would appear
                if (modelPredicted === actualDigit) {
                    this.modelPerformance[model].correct++;
                }
            }
        });

        this.updateModelWeights();

        this.recentDecisions.push({
            predictions,
            chosenDigit,
            actualDigit,
            won,
            timestamp: Date.now()
        });

        if (this.recentDecisions.length > 500) {
            this.recentDecisions.shift();
        }
    }

    /**
     * Update model weights based on performance
     */
    updateModelWeights() {
        const minSamples = 20;
        let totalAccuracy = 0;
        const accuracies = {};

        Object.entries(this.modelPerformance).forEach(([model, perf]) => {
            if (perf.total >= minSamples) {
                const accuracy = perf.correct / perf.total;
                accuracies[model] = accuracy;
                totalAccuracy += accuracy;
            }
        });

        if (totalAccuracy > 0 && Object.keys(accuracies).length > 0) {
            Object.entries(accuracies).forEach(([model, accuracy]) => {
                this.modelWeights[model] = Math.pow(accuracy + 0.1, 2);
            });

            const sum = Object.values(this.modelWeights).reduce((a, b) => a + b, 0);
            Object.keys(this.modelWeights).forEach(model => {
                this.modelWeights[model] /= sum;
            });
        }
    }

    /**
     * Get performance summary
     */
    getPerformanceSummary() {
        const summary = {};

        Object.entries(this.modelPerformance).forEach(([model, perf]) => {
            summary[model] = {
                accuracy: perf.total > 0 ? (perf.correct / perf.total * 100).toFixed(1) + '%' : 'N/A',
                samples: perf.total,
                weight: (this.modelWeights[model] * 100).toFixed(1) + '%'
            };
        });

        return {
            models: summary,
            confidenceThreshold: this.confidenceThreshold.toFixed(3),
            totalDecisions: this.recentDecisions.length
        };
    }

    exportState() {
        return {
            modelWeights: this.modelWeights,
            modelPerformance: this.modelPerformance,
            confidenceThreshold: this.confidenceThreshold,
            recentDecisions: this.recentDecisions.slice(-200)
        };
    }

    importState(state) {
        if (state.modelWeights) this.modelWeights = state.modelWeights;
        if (state.modelPerformance) this.modelPerformance = state.modelPerformance;
        if (state.confidenceThreshold) this.confidenceThreshold = state.confidenceThreshold;
        if (state.recentDecisions) this.recentDecisions = state.recentDecisions;
    }
}

// ============================================================================
// TIER 5: PERSISTENCE MANAGER
// ============================================================================

// class DigitPersistenceManager {
//     constructor(baseDir = './digit_bot_memory') {
//         this.baseDir = baseDir;
//         this.ensureDirectory();
//     }

//     ensureDirectory() {
//         if (!fs.existsSync(this.baseDir)) {
//             fs.mkdirSync(this.baseDir, { recursive: true });
//             console.log(`📁 Created memory directory: ${this.baseDir}`);
//         }
//     }

//     save(filename, data) {
//         try {
//             const filepath = path.join(this.baseDir, filename);
//             fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
//             console.log(`💾 Saved: ${filename}`);
//             return true;
//         } catch (error) {
//             console.error(`Error saving ${filename}:`, error.message);
//             return false;
//         }
//     }

//     load(filename) {
//         try {
//             const filepath = path.join(this.baseDir, filename);
//             if (fs.existsSync(filepath)) {
//                 const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
//                 console.log(`📂 Loaded: ${filename}`);
//                 return data;
//             }
//             return null;
//         } catch (error) {
//             console.error(`Error loading ${filename}:`, error.message);
//             return null;
//         }
//     }

//     saveFullState(bot) {
//         const state = {
//             timestamp: Date.now(),
//             statisticalEngine: bot.statisticalEngine.exportState(),
//             patternEngine: bot.patternEngine.exportState(),
//             neuralEngine: bot.neuralEngine.exportWeights(),
//             ensembleDecisionMaker: bot.ensembleDecisionMaker.exportState(),
//             performanceHistory: {
//                 totalTrades: bot.totalTrades,
//                 totalWins: bot.totalWins,
//                 totalLosses: bot.totalLosses,
//                 totalProfitLoss: bot.totalProfitLoss
//             },
//             digitTradeHistory: bot.digitTradeHistory.slice(-500)
//         };

//         return this.save('digit_bot_state.json', state);
//     }

//     loadFullState() {
//         return this.load('digit_bot_state.json');
//     }

//     appendPerformanceLog(entry) {
//         const logFile = 'digit_performance_log.json';
//         let log = this.load(logFile) || [];
//         log.push({ ...entry, timestamp: Date.now() });

//         if (log.length > 10000) {
//             log = log.slice(-10000);
//         }

//         return this.save(logFile, log);
//     }
// }

// ============================================================================
// MAIN Smart DIFFER TRADING BOT
// ============================================================================

class EnhancedDigitDifferBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];

        this.config = {
            initialStake: config.initialStake || 10,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            stopLoss: config.stopLoss || 86,
            takeProfit: config.takeProfit || 5000,
            requiredHistoryLength: config.requiredHistoryLength || 5000,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            minWaitTime: config.minWaitTime || 3000,
            maxWaitTime: config.maxWaitTime || 8000,
            tickDuration: config.tickDuration || 1,
            minConfidence: config.minConfidence || 0.85,
            learningModeThreshold: config.learningModeThreshold || 50,
            enableNeuralNetwork: config.enableNeuralNetwork !== false,
            enablePatternRecognition: config.enablePatternRecognition !== false,
            saveInterval: config.saveInterval || 300000,
        };

        // Trading state
        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.currentTradeId = null;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.endOfDay = false;
        this.Pause = false;
        this.Pause = false;
        this.isWinTrade = false;

        // Digit-specific tracking
        this.tickHistories = {};
        this.tickSubscriptionIds = {};
        this.assetStates = {};
        this.digitTradeHistory = [];

        // Enhanced Learning Components
        this.statisticalEngine = new DigitStatisticalEngine();
        this.patternEngine = new DigitPatternEngine();
        this.neuralEngine = new DigitNeuralEngine(50, [64, 32], 10);
        this.ensembleDecisionMaker = new DigitEnsembleDecisionMaker();
        // this.persistenceManager = new DigitPersistenceManager();

        // Learning mode
        this.observationCount = 0;
        this.learningMode = true;
        this.lastPredictions = {};

        // Initialize assets
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.assetStates[asset] = {
                lastDigit: null,
                currentProposalId: null,
                tradeInProgress: false,
                consecutiveLosses: 0,
                selectedDigit: null
            };
            this.statisticalEngine.initAsset(asset);
            this.patternEngine.initAsset(asset);
        });

        // Email Configuration
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };
        this.emailRecipient = 'kenotaru@gmail.com';

        this.reconnectAttempts = 0;

        // Load saved state
        // this.loadSavedState();

        // Start periodic save
        // this.startPeriodicSave();

        // Start email timer
        this.startEmailTimer();
    }

    // ========================================================================
    // PERSISTENCE METHODS
    // ========================================================================

    // loadSavedState() {
    //     const state = this.persistenceManager.loadFullState();
    //     if (state) {
    //         console.log('📂 Loading saved learning state...');

    //         if (state.statisticalEngine) {
    //             this.statisticalEngine.importState(state.statisticalEngine);
    //         }
    //         if (state.patternEngine) {
    //             this.patternEngine.importState(state.patternEngine);
    //         }
    //         if (state.neuralEngine) {
    //             this.neuralEngine.importWeights(state.neuralEngine);
    //         }
    //         if (state.ensembleDecisionMaker) {
    //             this.ensembleDecisionMaker.importState(state.ensembleDecisionMaker);
    //         }
    //         if (state.digitTradeHistory) {
    //             this.digitTradeHistory = state.digitTradeHistory;
    //         }

    //         console.log('✅ Learning state restored successfully');
    //     } else {
    //         console.log('🆕 No saved state found. Starting fresh learning.');
    //     }
    // }

    // startPeriodicSave() {
    //     setInterval(() => {
    //         this.persistenceManager.saveFullState(this);
    //     }, this.config.saveInterval);
    // }

    // ========================================================================
    // WEBSOCKET METHODS
    // ========================================================================

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
                if (!this.endOfDay) {
                    this.handleDisconnect();
                }
            });
        }
    }

    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else if (this.connected && !this.wsReady) {
            setTimeout(() => this.sendRequest(request), this.config.reconnectInterval);
        } else {
            console.error('Not connected to Deriv API.');
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Reconnecting (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.config.reconnectInterval);
        }
    }

    authenticate() {
        console.log('Authenticating...');
        this.sendRequest({ authorize: this.token });
    }

    subscribeToTicks(asset) {
        this.sendRequest({
            ticks: asset,
            subscribe: 1
        });
    }

    subscribeToTickHistory(asset) {
        this.sendRequest({
            ticks_history: asset,
            adjust_start_time: 1,
            count: this.config.requiredHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        });
    }

    // ========================================================================
    // MESSAGE HANDLERS
    // ========================================================================

    handleMessage(message) {
        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                this.disconnect();
                return;
            }
            console.log('Authentication successful');
            this.tradeInProgress = false;
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

        } else if (message.error) {
            this.handleApiError(message.error);
        }
    }

    initializeSubscriptions() {
        console.log('Initializing subscriptions for all assets...');
        this.assets.forEach(asset => {
            this.subscribeToTickHistory(asset);
            this.subscribeToTicks(asset);
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
        const digits = history.prices.map(price => this.getLastDigit(price, asset));
        this.tickHistories[asset] = digits;

        // Update learning engines with historical data
        digits.forEach(digit => {
            this.statisticalEngine.updateFrequency(asset, digit);
            this.patternEngine.updatePatterns(asset, digit);
        });

        console.log(`[${asset}] Loaded ${digits.length} historical ticks`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const digit = this.getLastDigit(tick.quote, asset);

        // Update history
        this.tickHistories[asset].push(digit);
        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        }

        // Update learning engines
        this.statisticalEngine.updateFrequency(asset, digit);
        this.patternEngine.updatePatterns(asset, digit);
        this.observationCount++;

        // Update asset state
        this.assetStates[asset].lastDigit = digit;

        // Train neural network periodically
        if (this.config.enableNeuralNetwork && this.observationCount % 5 === 0) {
            const features = this.neuralEngine.prepareFeatures(
                this.tickHistories[asset],
                this.statisticalEngine.getDigitProbabilities(asset)
            );
            this.neuralEngine.trainOnSample(features, digit);
        }

        // Check if still in learning mode
        if (this.learningMode && this.observationCount < this.config.learningModeThreshold) {
            if (this.observationCount % 10 === 0) {
                console.log(`🎓 Learning mode: ${this.observationCount}/${this.config.learningModeThreshold} observations`);
            }
            return;
        } else if (this.learningMode) {
            console.log('✅ Learning phase complete. Trading enabled.');
            this.learningMode = false;
        }

        // Analyze for trading opportunity
        if (!this.tradeInProgress) {
            this.analyzeAndTrade(asset);
        }
    }

    // ========================================================================
    // TRADING ANALYSIS
    // ========================================================================

    analyzeAndTrade(asset) {
        if (this.tradeInProgress) return;
        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) return;

        // Get predictions from all models
        const predictions = this.getEnsemblePredictions(asset);

        // Make decision
        const decision = this.ensembleDecisionMaker.selectDigitToDiffer(predictions);

        // Store for later analysis
        this.lastPredictions[asset] = predictions;

        if (decision.shouldTrade) {
            console.log(`[${asset}] 🎯 TRADE SIGNAL`);
            console.log(`   Digit to DIFFER from: ${decision.digitToDiffer}`);
            console.log(`   Probability: ${(decision.probability * 100).toFixed(1)}%`);
            console.log(`   Confidence: ${(decision.confidence * 100).toFixed(1)}%`);
            console.log(`   Models: ${JSON.stringify(decision.details)}`);

            console.log(`   Confidence: ${(decision.confidence * 100).toFixed(1)}%`);
            console.log(`   Models: ${JSON.stringify(decision.details)}`);

            this.assetStates[asset].selectedDigit = decision.digitToDiffer;
            this.requestProposal(asset, decision.digitToDiffer);
        }
    }

    getEnsemblePredictions(asset) {
        const predictions = {};

        // Statistical model
        predictions.statistical = this.statisticalEngine.getBestDigitToDiffer(asset);

        // Pattern model
        predictions.pattern = this.patternEngine.predictNextDigits(asset);

        // Neural model
        if (this.config.enableNeuralNetwork && this.neuralEngine.initialized) {
            const features = this.neuralEngine.prepareFeatures(
                this.tickHistories[asset],
                this.statisticalEngine.getDigitProbabilities(asset)
            );
            predictions.neural = this.neuralEngine.predict(features);
        }

        // Streak model
        const lastDigit = this.assetStates[asset].lastDigit;
        predictions.streak = {
            streaking: this.patternEngine.isDigitStreaking(asset, lastDigit) ? lastDigit : null
        };

        return predictions;
    }

    requestProposal(asset, barrier) {
        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'DIGITDIFF',
            currency: 'USD',
            symbol: asset,
            duration: this.config.tickDuration,
            duration_unit: 't',
            barrier: barrier
        };

        this.sendRequest(proposal);
    }

    handleProposal(message) {
        if (message.error) {
            console.error('Proposal error:', message.error.message);
            return;
        }

        if (message.proposal && !this.tradeInProgress) {
            const proposalId = message.proposal.id;
            const asset = message.echo_req.symbol;

            this.assetStates[asset].currentProposalId = proposalId;
            this.placeTrade(asset);
        }
    }

    placeTrade(asset) {
        if (this.tradeInProgress) return;

        const assetState = this.assetStates[asset];
        if (!assetState || !assetState.currentProposalId) {
            console.log(`Cannot place trade. Missing proposal for asset ${asset}.`);
            return;
        }

        const request = {
            buy: assetState.currentProposalId,
            price: this.currentStake.toFixed(2)
        };

        console.log(`🚀 Placing Smart DIFFER trade`);
        console.log(`   Asset: [${asset}] | Digit: ${assetState.selectedDigit} | Stake: $${this.currentStake.toFixed(2)}`);

        this.sendRequest(request);
        this.tradeInProgress = true;
        assetState.tradeInProgress = true;
    }

    subscribeToOpenContract(contractId) {
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });
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
        const exitSpot = contract.exit_tick_display_value;
        const actualDigit = this.getLastDigit(parseFloat(exitSpot), asset);

        const assetState = this.assetStates[asset];
        if (assetState) {
            assetState.tradeInProgress = false;
        }

        const predictedDigit = assetState ? assetState.selectedDigit : null;

        console.log(`[${asset}] Trade Result: ${won ? '✅ WON' : '❌ LOST'}`);
        console.log(`   Predicted to differ from: ${predictedDigit} | Actual: ${actualDigit}`);
        console.log(`   Profit: $${profit.toFixed(2)}`);

        // Record outcome for learning
        this.recordTradeOutcome(asset, won, predictedDigit, actualDigit, profit);

        this.totalTrades++;

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;

            if (assetState) {
                assetState.consecutiveLosses = 0;
            }
            this.isWinTrade = true;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;

            if (assetState) {
                assetState.consecutiveLosses++;
            }
            this.isWinTrade = false;

            // Update global consecutive loss counters
            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            this.isWinTrade = false;

            this.sendLossEmail(asset, actualDigit, predictedDigit);
        }

        this.totalProfitLoss += profit;

        // Save state
        // this.persistenceManager.saveFullState(this);

        // Log summary
        this.logTradingSummary(asset);

        // Check stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('Stop loss reached. Stopping trading.');
            this.endOfDay = true;
            this.sendEmailSummary();
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take profit reached. Stopping trading.');
            this.endOfDay = true;
            this.sendEmailSummary();
            this.disconnect();
            return;
        }

        // Wait before next trade
        const waitTime = Math.floor(
            Math.random() * (this.config.maxWaitTime - this.config.minWaitTime + 1)
        ) + this.config.minWaitTime;

        this.tradeInProgress = false;

        this.selectedDigit = null;
        this.selectedAsset = null;

        // Digit-specific tracking
        this.tickHistories = {};
        this.tickSubscriptionIds = {};
        this.assetStates = {};
        this.digitTradeHistory = [];

        // Enhanced Learning Components
        this.statisticalEngine = new DigitStatisticalEngine();
        this.patternEngine = new DigitPatternEngine();
        this.neuralEngine = new DigitNeuralEngine(50, [64, 32], 10);
        this.ensembleDecisionMaker = new DigitEnsembleDecisionMaker();
        // this.persistenceManager = new DigitPersistenceManager();

        // Learning mode
        // this.observationCount = 0;
        // this.learningMode = true;
        // this.lastPredictions = {};

        // Initialize assets
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.assetStates[asset] = {
                lastDigit: null,
                currentProposalId: null,
                tradeInProgress: false,
                consecutiveLosses: 0,
                selectedDigit: null
            };
            this.statisticalEngine.initAsset(asset);
            this.patternEngine.initAsset(asset);
        });

        if (!this.endOfDay) {
            setTimeout(() => {
                this.tradeInProgress = false;
            }, waitTime);
        }
    }

    recordTradeOutcome(asset, won, predictedDigit, actualDigit, profit) {
        // Update ensemble decision maker
        this.ensembleDecisionMaker.recordOutcome(
            this.lastPredictions[asset],
            predictedDigit,
            actualDigit,
            won
        );

        // Record in history
        this.digitTradeHistory.push({
            asset,
            won,
            predictedDigit,
            actualDigit,
            profit,
            timestamp: Date.now()
        });

        if (this.digitTradeHistory.length > 1000) {
            this.digitTradeHistory.shift();
        }

        // Append to performance log
        // this.persistenceManager.appendPerformanceLog({
        //     asset,
        //     won,
        //     predictedDigit,
        //     actualDigit,
        //     profit
        // });
    }

    // ========================================================================
    // UTILITY METHODS
    // ========================================================================

    handleApiError(error) {
        console.error('API Error:', error.message);

        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token.');
                this.disconnect();
                break;
            case 'RateLimit':
                console.log('Rate limit. Waiting...');
                setTimeout(() => this.initializeSubscriptions(), 60000);
                break;
            case 'MarketIsClosed':
                console.log('Market closed.');
                setTimeout(() => this.initializeSubscriptions(), 3600000);
                break;
            default:
                this.initializeSubscriptions();
        }
    }

    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    logTradingSummary(asset) {
        const entropy = this.statisticalEngine.calculateEntropy(asset);
        const neuralMetrics = this.neuralEngine.getPerformanceMetrics();
        const ensemblePerf = this.ensembleDecisionMaker.getPerformanceSummary();

        console.log('═══════════════════════════════════════════════════════════');
        console.log('              Smart DIFFER TRADING SUMMARY');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Wins: ${this.totalWins} | Losses: ${this.totalLosses}`);
        console.log(`Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%`);
        console.log(`Total P/L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`x2 Losses2: ${this.consecutiveLosses2}`);
        console.log(`x3 Losses3: ${this.consecutiveLosses3}`);
        console.log(`x4 Losses4: ${this.consecutiveLosses4}`);
        console.log(`x5 Losses5: ${this.consecutiveLosses5}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log('───────────────────────────────────────────────────────────');
        console.log(`[${asset}] Market Entropy: ${(entropy * 100).toFixed(1)}%`);
        console.log(`Neural Accuracy: ${(neuralMetrics.accuracy * 100).toFixed(1)}% | Trend: ${neuralMetrics.trend}`);
        console.log(`Confidence Threshold: ${ensemblePerf.confidenceThreshold}`);
        console.log('═══════════════════════════════════════════════════════════');
    }

    // ========================================================================
    // EMAIL METHODS
    // ========================================================================

    startEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendEmailSummary();
            }
        }, 1800000);
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const neuralMetrics = this.neuralEngine.getPerformanceMetrics();
        const ensemblePerf = this.ensembleDecisionMaker.getPerformanceSummary();

        const modelPerf = Object.entries(ensemblePerf.models)
            .map(([model, stats]) => `${model}: ${stats.accuracy} (${stats.samples} samples)`)
            .join('\n        ');

        const summaryText = `
    ==================== Smart Differ Bot Summary ====================
    
    TRADING PERFORMANCE:
    Total Trades: ${this.totalTrades}
    Wins: ${this.totalWins} | Losses: ${this.totalLosses}
    x2 Losses2: ${this.consecutiveLosses2}
    x3 Losses3: ${this.consecutiveLosses3}
    x4 Losses4: ${this.consecutiveLosses4}
    x5 Losses5: ${this.consecutiveLosses5}
    Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
    
    FINANCIAL:
    Current Stake: $${this.currentStake.toFixed(2)}
    Total P/L: $${this.totalProfitLoss.toFixed(2)}
    
    AI LEARNING SYSTEM:
    ─────────────────────────────────
    Neural Network:
        Accuracy: ${(neuralMetrics.accuracy * 100).toFixed(1)}%
        Trend: ${neuralMetrics.trend}
    
    Model Performance:
        ${modelPerf || 'No model data yet'}
    
    MARKET ANALYSIS:
    ${this.assets.map(a => {
            const entropy = this.statisticalEngine.calculateEntropy(a);
            const hotDigits = this.statisticalEngine.getHotDigits(a);
            return `${a}: Entropy=${(entropy * 100).toFixed(1)}%, Hot Digits=[${hotDigits.join(',')}]`;
        }).join('\n    ')}
    
    ===================================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Smart Differ Bot - Performance Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending email:', error);
        }
    }

    async sendLossEmail(asset, actualDigit, predictedDigit) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const recentTrades = this.digitTradeHistory.slice(-10);
        const recentAnalysis = recentTrades.map(t =>
            `${t.won ? '✅' : '❌'} Predicted: ${t.predictedDigit}, Actual: ${t.actualDigit}`
        ).join('\n        ');

        const summaryText = `
    ==================== LOSS ALERT ====================
    
    TRADE DETAILS:
    Asset: ${asset}
    Predicted to differ from: ${predictedDigit}
    Actual digit: ${actualDigit}
    
    CURRENT STATUS:
    Total Trades: ${this.totalTrades}
    Wins: ${this.totalWins} | Losses: ${this.totalLosses}
    x2 Losses2: ${this.consecutiveLosses2}
    x3 Losses3: ${this.consecutiveLosses3}
    x4 Losses4: ${this.consecutiveLosses4}
    x5 Losses5: ${this.consecutiveLosses5}
    Current Stake: $${this.currentStake.toFixed(2)}
    Total P/L: $${this.totalProfitLoss.toFixed(2)}
    
    RECENT TRADES:
        ${recentAnalysis}
    
    ====================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: `Smart Differ Bot - Loss Alert [${asset}]`,
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending loss email:', error);
        }
    }

    async sendDisconnectResumptionEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const now = new Date();
        const currentHours = now.getHours();
        const currentMinutes = now.getMinutes();

        const summaryText = `
        Disconnect/Reconnect Email: Time (${currentHours}:${currentMinutes})
        Trading Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses2: ${this.consecutiveLosses2}
        x3 Losses3: ${this.consecutiveLosses3}
        x4 Losses4: ${this.consecutiveLosses4}
        x5 Losses5: ${this.consecutiveLosses5}
        
        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Smart Differ Bot - Connection/Disconnection Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending email:', error);
        }
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM GMT+1, reconnecting the bot.");
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 5000);
    }

    // ========================================================================
    // START METHOD
    // ========================================================================

    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🎲 Smart Differ TRADING BOT v2.0');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('  📊 Contract Type: DIGIT DIFFER');
        console.log('  🎯 Strategy: Predict digit that WILL appear, bet it differs');
        console.log('  📈 Base Win Rate: ~90% (9/10 outcomes win)');
        console.log('');
        console.log('  🧠 AI Features:');
        console.log('    • Digit Frequency Analysis with Chi-Square Testing');
        console.log('    • Bayesian Probability Estimation');
        console.log('    • Markov Chain Transition Prediction');
        console.log('    • Neural Network Sequence Prediction');
        console.log('    • Hot/Cold Digit Detection');
        console.log('    • Ensemble Decision Making');
        console.log('    • Persistent Learning Memory');
        console.log('');
        console.log(`  🎓 Learning Mode: ${this.learningMode ? 'Active' : 'Complete'}`);
        // console.log(`  📁 Memory Directory: ./digit_bot_memory/`);
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');

        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// ============================================================================
// RUN THE BOT
// ============================================================================

const token = '0P94g4WdSrSrzir';

const bot = new EnhancedDigitDifferBot(token, {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir', rgNedekYXvCaPeP, hsj0tA0XJoIzJG5, Dz2V2KvRf4Uukt3
    initialStake: 0.61,
    multiplier: 11.3,
    stopLoss: 86,
    takeProfit: 5000,
    tickDuration: 1,
    minConfidence: 0.90,
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
    enableNeuralNetwork: true,
    enablePatternRecognition: true,
    learningModeThreshold: 50,
    requiredHistoryLength: 200,
});

bot.start();

module.exports = {
    EnhancedDigitDifferBot,
    DigitStatisticalEngine,
    DigitPatternEngine,
    DigitNeuralEngine,
    DigitEnsembleDecisionMaker,
    // DigitPersistenceManager
};
