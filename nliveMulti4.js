/**
 * Enhanced Deriv Accumulator Trading Bot
 * Version 2.0 - Advanced AI Learning System
 * 
 * Features:
 * - Kaplan-Meier Survival Analysis
 * - Bayesian Probability Updating
 * - Markov Chain Pattern Recognition
 * - Neural Network Prediction (Simplified MLP)
 * - Ensemble Decision Making
 * - Persistent Learning Memory
 */

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'nliveMulti4-state001.json');
const STATE_SAVE_INTERVAL = 5000; // Save every 5 seconds

class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                config: bot.config,
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    consecutiveLosses2: bot.consecutiveLosses2,
                    consecutiveLosses3: bot.consecutiveLosses3,
                    consecutiveLosses4: bot.consecutiveLosses4,
                    consecutiveLosses5: bot.consecutiveLosses5,
                    totalProfitLoss: bot.totalProfitLoss,
                    Pause: bot.Pause,
                    sys: bot.sys,
                    sysCount: bot.sysCount,
                },
                neuralEngine: bot.neuralEngine.exportWeights(),
                ensembleDecisionMaker: bot.ensembleDecisionMaker.exportState(),
                learningSystem: bot.learningSystem,
                extendedStayedIn: bot.extendedStayedIn,
                previousStayedIn: bot.previousStayedIn,
                assetStates: bot.assetStates,
                subscriptions: {
                    tickSubscriptionIds: { ...bot.tickSubscriptionIds }
                },
                assets: {},
                hourlyStats: bot.hourlyStats
            };

            bot.assets.forEach(asset => {
                persistableState.assets[asset] = {
                    tickHistory: bot.tickHistories[asset]
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

// ============================================================================
// TIER 1: STATISTICAL LEARNING ENGINE
// ============================================================================

class StatisticalEngine {
    constructor() {
        this.survivalData = {};
        this.bayesianPriors = {};
        this.hazardRates = {};
        this.entropyScores = {};
    }

    /**
     * Kaplan-Meier Survival Estimator
     * Calculates survival probability with confidence intervals
     */
    kaplanMeierEstimate(runLengths, targetLength) {
        if (!runLengths || runLengths.length < 10) {
            return { survival: 0.5, ci_lower: 0.3, ci_upper: 0.7, variance: 0.1 };
        }

        // Sort run lengths
        const sorted = [...runLengths].sort((a, b) => a - b);
        const n = sorted.length;

        // Calculate number at risk and events at each time point
        const timePoints = [...new Set(sorted)].sort((a, b) => a - b);
        let survival = 1.0;
        let variance = 0;

        for (const t of timePoints) {
            if (t > targetLength) break;

            const atRisk = runLengths.filter(l => l >= t).length;
            const events = runLengths.filter(l => l === t).length;

            if (atRisk > 0) {
                const hazard = events / atRisk;
                survival *= (1 - hazard);

                // Greenwood's formula for variance
                if (atRisk > events) {
                    variance += events / (atRisk * (atRisk - events));
                }
            }
        }

        // 95% confidence interval
        const se = survival * Math.sqrt(variance);
        const z = 1.96;

        return {
            survival: Math.max(0, Math.min(1, survival)),
            ci_lower: Math.max(0, survival - z * se),
            ci_upper: Math.min(1, survival + z * se),
            variance: variance,
            sampleSize: n
        };
    }

    /**
     * Nelson-Aalen Cumulative Hazard Estimator
     */
    nelsonAalenHazard(runLengths, targetLength) {
        if (!runLengths || runLengths.length < 10) {
            return { cumulativeHazard: 0.5, hazardRate: 0.1 };
        }

        const sorted = [...runLengths].sort((a, b) => a - b);
        const timePoints = [...new Set(sorted)].sort((a, b) => a - b);

        let cumulativeHazard = 0;
        let lastHazard = 0;

        for (const t of timePoints) {
            if (t > targetLength) break;

            const atRisk = runLengths.filter(l => l >= t).length;
            const events = runLengths.filter(l => l === t).length;

            if (atRisk > 0) {
                lastHazard = events / atRisk;
                cumulativeHazard += lastHazard;
            }
        }

        return {
            cumulativeHazard,
            hazardRate: lastHazard,
            survivalFromHazard: Math.exp(-cumulativeHazard)
        };
    }

    /**
     * Bayesian Probability Updater
     * Uses Beta-Binomial conjugate prior
     */
    initBayesianPrior(asset, alpha = 2, beta = 2) {
        this.bayesianPriors[asset] = { alpha, beta };
    }

    updateBayesian(asset, survived) {
        if (!this.bayesianPriors[asset]) {
            this.initBayesianPrior(asset);
        }

        if (survived) {
            this.bayesianPriors[asset].alpha += 1;
        } else {
            this.bayesianPriors[asset].beta += 1;
        }

        // Apply decay to prevent over-confidence from old data
        const decay = 0.999;
        this.bayesianPriors[asset].alpha *= decay;
        this.bayesianPriors[asset].beta *= decay;

        // Keep minimum values
        this.bayesianPriors[asset].alpha = Math.max(1, this.bayesianPriors[asset].alpha);
        this.bayesianPriors[asset].beta = Math.max(1, this.bayesianPriors[asset].beta);
    }

    getBayesianEstimate(asset) {
        if (!this.bayesianPriors[asset]) {
            return { mean: 0.5, variance: 0.25, ci_lower: 0.25, ci_upper: 0.75 };
        }

        const { alpha, beta } = this.bayesianPriors[asset];
        const mean = alpha / (alpha + beta);
        const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
        const std = Math.sqrt(variance);

        return {
            mean,
            variance,
            ci_lower: Math.max(0, mean - 1.96 * std),
            ci_upper: Math.min(1, mean + 1.96 * std),
            confidence: alpha + beta // Higher = more confident
        };
    }

    /**
     * Shannon Entropy Calculator
     * Measures market predictability (lower = more predictable)
     */
    calculateEntropy(sequence) {
        if (!sequence || sequence.length < 10) return 1.0;

        const freq = {};
        sequence.forEach(d => {
            freq[d] = (freq[d] || 0) + 1;
        });

        let entropy = 0;
        const n = sequence.length;

        Object.values(freq).forEach(count => {
            const p = count / n;
            if (p > 0) {
                entropy -= p * Math.log2(p);
            }
        });

        // Normalize to [0, 1] (max entropy for 10 digits is log2(10) ≈ 3.32)
        return entropy / Math.log2(10);
    }

    /**
     * Conditional Entropy - measures uncertainty given recent history
     */
    calculateConditionalEntropy(sequence, order = 2) {
        if (!sequence || sequence.length < order + 10) return 1.0;

        const contextCounts = {};
        const jointCounts = {};

        for (let i = order; i < sequence.length; i++) {
            const context = sequence.slice(i - order, i).join(',');
            const outcome = sequence[i];
            const joint = `${context}|${outcome}`;

            contextCounts[context] = (contextCounts[context] || 0) + 1;
            jointCounts[joint] = (jointCounts[joint] || 0) + 1;
        }

        let conditionalEntropy = 0;
        const n = sequence.length - order;

        Object.entries(jointCounts).forEach(([joint, count]) => {
            const [context] = joint.split('|');
            const pJoint = count / n;
            const pContext = contextCounts[context] / n;
            const pConditional = count / contextCounts[context];

            if (pConditional > 0) {
                conditionalEntropy -= pJoint * Math.log2(pConditional);
            }
        });

        return conditionalEntropy / Math.log2(10);
    }

    /**
     * Kernel-smoothed hazard rate estimation
     */
    kernelSmoothedHazard(runLengths, targetLength, bandwidth = 2) {
        if (!runLengths || runLengths.length < 20) {
            return 0.1;
        }

        // Gaussian kernel
        const kernel = (u) => Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);

        let numerator = 0;
        let denominator = 0;

        runLengths.forEach(l => {
            const u = (targetLength - l) / bandwidth;
            const k = kernel(u);

            if (l === targetLength) {
                numerator += k;
            }
            if (l >= targetLength) {
                denominator += k;
            }
        });

        return denominator > 0 ? numerator / denominator : 0.1;
    }
}

// ============================================================================
// TIER 2: PATTERN RECOGNITION ENGINE
// ============================================================================

class PatternEngine {
    constructor() {
        this.ngramModels = {};
        this.markovChains = {};
        this.runLengthModels = {};
        this.regimeStates = {};
    }

    /**
     * N-Gram Pattern Analyzer
     * Detects recurring sequences of digits
     */
    buildNgramModel(asset, sequence, maxOrder = 5) {
        if (!sequence || sequence.length < maxOrder + 10) return;

        this.ngramModels[asset] = {};

        for (let order = 1; order <= maxOrder; order++) {
            this.ngramModels[asset][order] = {};

            for (let i = order; i < sequence.length; i++) {
                const context = sequence.slice(i - order, i).join(',');
                const next = sequence[i];

                if (!this.ngramModels[asset][order][context]) {
                    this.ngramModels[asset][order][context] = {};
                }

                this.ngramModels[asset][order][context][next] =
                    (this.ngramModels[asset][order][context][next] || 0) + 1;
            }
        }
    }

    predictFromNgram(asset, recentSequence, order = 3) {
        if (!this.ngramModels[asset] || !this.ngramModels[asset][order]) {
            return null;
        }

        const context = recentSequence.slice(-order).join(',');
        const predictions = this.ngramModels[asset][order][context];

        if (!predictions) return null;

        const total = Object.values(predictions).reduce((a, b) => a + b, 0);
        const probabilities = {};

        Object.entries(predictions).forEach(([digit, count]) => {
            probabilities[digit] = count / total;
        });

        // Find most likely next digit
        const mostLikely = Object.entries(probabilities)
            .sort((a, b) => b[1] - a[1])[0];

        return {
            digit: parseInt(mostLikely[0]),
            probability: mostLikely[1],
            distribution: probabilities,
            confidence: total > 20 ? 'high' : total > 10 ? 'medium' : 'low'
        };
    }

    /**
     * Markov Chain Analyzer
     * Multi-order transition matrices for run length prediction
     */
    buildMarkovChain(asset, runLengths, maxOrder = 3) {
        if (!runLengths || runLengths.length < 20) return;

        this.markovChains[asset] = {};

        // Discretize run lengths into states
        const states = runLengths.map(l => this.discretizeRunLength(l));

        for (let order = 1; order <= maxOrder; order++) {
            this.markovChains[asset][order] = {};

            for (let i = order; i < states.length; i++) {
                const context = states.slice(i - order, i).join(',');
                const next = states[i];

                if (!this.markovChains[asset][order][context]) {
                    this.markovChains[asset][order][context] = {};
                }

                this.markovChains[asset][order][context][next] =
                    (this.markovChains[asset][order][context][next] || 0) + 1;
            }
        }
    }

    discretizeRunLength(length) {
        if (length <= 2) return 'very_short';
        if (length <= 5) return 'short';
        if (length <= 10) return 'medium';
        if (length <= 20) return 'long';
        return 'very_long';
    }

    predictNextRunState(asset, recentRuns, order = 2) {
        if (!this.markovChains[asset] || !this.markovChains[asset][order]) {
            return null;
        }

        const recentStates = recentRuns.slice(-order).map(l => this.discretizeRunLength(l));
        const context = recentStates.join(',');
        const transitions = this.markovChains[asset][order][context];

        if (!transitions) return null;

        const total = Object.values(transitions).reduce((a, b) => a + b, 0);
        const probabilities = {};

        Object.entries(transitions).forEach(([state, count]) => {
            probabilities[state] = count / total;
        });

        return {
            predictions: probabilities,
            mostLikely: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0],
            confidence: total
        };
    }

    /**
     * Run Length Distribution Modeler
     * Fits Weibull/Exponential distributions
     */
    fitRunLengthDistribution(runLengths) {
        if (!runLengths || runLengths.length < 20) {
            return { type: 'unknown', params: {} };
        }

        const mean = runLengths.reduce((a, b) => a + b, 0) / runLengths.length;
        const variance = runLengths.reduce((a, b) => a + (b - mean) ** 2, 0) / runLengths.length;
        const std = Math.sqrt(variance);
        const cv = std / mean; // Coefficient of variation

        // Estimate distribution type based on CV
        // CV = 1 suggests exponential, CV < 1 suggests Weibull with shape > 1
        if (cv > 0.9 && cv < 1.1) {
            // Exponential distribution
            return {
                type: 'exponential',
                params: { lambda: 1 / mean },
                survivalProb: (t) => Math.exp(-t / mean)
            };
        } else {
            // Weibull distribution - estimate parameters
            // Using method of moments approximation
            const shape = (1.2 / cv) ** 1.1; // Approximate shape parameter
            const scale = mean / this.gamma(1 + 1 / shape);

            return {
                type: 'weibull',
                params: { shape, scale },
                survivalProb: (t) => Math.exp(-Math.pow(t / scale, shape))
            };
        }
    }

    gamma(z) {
        // Stirling's approximation for gamma function
        if (z < 0.5) {
            return Math.PI / (Math.sin(Math.PI * z) * this.gamma(1 - z));
        }
        z -= 1;
        const g = 7;
        const c = [
            0.99999999999980993, 676.5203681218851, -1259.1392167224028,
            771.32342877765313, -176.61502916214059, 12.507343278686905,
            -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
        ];
        let x = c[0];
        for (let i = 1; i < g + 2; i++) {
            x += c[i] / (z + i);
        }
        const t = z + g + 0.5;
        return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
    }

    /**
     * Regime Detector
     * Hidden Markov Model-like regime detection
     */
    detectRegime(asset, recentRuns, windowSize = 20) {
        if (!recentRuns || recentRuns.length < windowSize) {
            return { regime: 'unknown', confidence: 0 };
        }

        const recent = recentRuns.slice(-windowSize);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length;
        const shortRuns = recent.filter(l => l <= 3).length;
        const longRuns = recent.filter(l => l >= 10).length;

        // Determine regime
        let regime, confidence;

        if (shortRuns > windowSize * 0.5) {
            regime = 'volatile';
            confidence = shortRuns / windowSize;
        } else if (longRuns > windowSize * 0.3) {
            regime = 'stable';
            confidence = longRuns / windowSize;
        } else if (variance > mean * 2) {
            regime = 'unpredictable';
            confidence = Math.min(1, variance / (mean * 4));
        } else {
            regime = 'normal';
            confidence = 1 - (variance / (mean * 2));
        }

        this.regimeStates[asset] = { regime, confidence, mean, variance };

        return { regime, confidence, mean, variance, shortRuns, longRuns };
    }

    /**
     * Pattern Similarity Detector
     * Finds similar historical patterns
     */
    findSimilarPatterns(sequence, pattern, tolerance = 1) {
        const matches = [];
        const patternLength = pattern.length;

        for (let i = 0; i <= sequence.length - patternLength; i++) {
            const candidate = sequence.slice(i, i + patternLength);
            let differences = 0;

            for (let j = 0; j < patternLength; j++) {
                if (candidate[j] !== pattern[j]) differences++;
            }

            if (differences <= tolerance) {
                matches.push({
                    index: i,
                    pattern: candidate,
                    nextValue: sequence[i + patternLength] || null,
                    differences
                });
            }
        }

        return matches;
    }
}

// ============================================================================
// TIER 3: NEURAL NETWORK PREDICTOR
// ============================================================================

class NeuralEngine {
    constructor(inputSize = 60, hiddenSizes = [32, 16], outputSize = 1) {
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

            // Xavier initialization
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

    // Activation functions
    relu(x) {
        return Math.max(0, x);
    }

    reluDerivative(x) {
        return x > 0 ? 1 : 0;
    }

    sigmoid(x) {
        return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
    }

    sigmoidDerivative(x) {
        const s = this.sigmoid(x);
        return s * (1 - s);
    }

    /**
     * Forward pass through the network
     */
    forward(input) {
        if (input.length !== this.inputSize) {
            console.error(`Input size mismatch: expected ${this.inputSize}, got ${input.length}`);
            return { output: 0.5, activations: [] };
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

                // Use ReLU for hidden layers, sigmoid for output
                if (i < numLayers - 1) {
                    nextLayer.push(this.relu(sum));
                } else {
                    nextLayer.push(this.sigmoid(sum));
                }
            }

            current = nextLayer;
            activations.push(current);
        }

        return {
            output: current[0],
            activations
        };
    }

    /**
     * Backward pass with gradient descent
     */
    backward(input, target, activations) {
        const numLayers = Object.keys(this.weights).length;
        const gradients = {};

        // Output layer error
        const output = activations[activations.length - 1][0];
        let delta = [(output - target) * this.sigmoidDerivative(output)];

        // Backpropagate
        for (let i = numLayers - 1; i >= 0; i--) {
            gradients[`w${i}`] = [];
            gradients[`b${i}`] = [...delta];

            const prevActivation = activations[i];

            for (let j = 0; j < this.weights[i].length; j++) {
                gradients[`w${i}`][j] = [];

                for (let k = 0; k < this.weights[i][j].length; k++) {
                    gradients[`w${i}`][j][k] = delta[j] * prevActivation[k];
                }
            }

            if (i > 0) {
                const newDelta = [];

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

        return gradients;
    }

    /**
     * Update weights using gradients with momentum
     */
    updateWeights(gradients) {
        const numLayers = Object.keys(this.weights).length;

        for (let i = 0; i < numLayers; i++) {
            for (let j = 0; j < this.weights[i].length; j++) {
                for (let k = 0; k < this.weights[i][j].length; k++) {
                    const grad = gradients[`w${i}`][j][k];

                    // Momentum update
                    this.velocities[`w${i}`][j][k] =
                        this.momentum * this.velocities[`w${i}`][j][k] - this.learningRate * grad;

                    this.weights[i][j][k] += this.velocities[`w${i}`][j][k];
                }

                // Bias update
                const biasGrad = gradients[`b${i}`][j];
                this.velocities[`b${i}`][j] =
                    this.momentum * this.velocities[`b${i}`][j] - this.learningRate * biasGrad;

                this.biases[i][j] += this.velocities[`b${i}`][j];
            }
        }
    }

    /**
     * Train on a single sample (online learning)
     */
    trainOnSample(input, target) {
        const { output, activations } = this.forward(input);
        const gradients = this.backward(input, target, activations);
        this.updateWeights(gradients);

        const loss = 0.5 * (output - target) ** 2;
        this.trainingHistory.push({ loss, prediction: output, target });

        // Keep only recent history
        if (this.trainingHistory.length > 1000) {
            this.trainingHistory.shift();
        }

        return { loss, prediction: output };
    }

    /**
     * Predict survival probability
     */
    predict(input) {
        const { output } = this.forward(input);
        return output;
    }

    /**
     * Get prediction with uncertainty (dropout-like)
     */
    predictWithUncertainty(input, numSamples = 10) {
        const predictions = [];

        for (let i = 0; i < numSamples; i++) {
            // Add small noise for Monte Carlo estimation
            const noisyInput = input.map(x => x + (Math.random() - 0.5) * 0.1);
            predictions.push(this.predict(noisyInput));
        }

        const mean = predictions.reduce((a, b) => a + b, 0) / numSamples;
        const variance = predictions.reduce((a, b) => a + (b - mean) ** 2, 0) / numSamples;

        return {
            prediction: mean,
            uncertainty: Math.sqrt(variance),
            confidence: 1 - Math.min(1, Math.sqrt(variance) * 2)
        };
    }

    /**
     * Prepare input features from market data
     */
    prepareFeatures(tickHistory, runLengths, currentRunLength, volatility) {
        const features = [];

        // Last 30 digits (normalized)
        const recentDigits = tickHistory.slice(-30);
        while (recentDigits.length < 30) recentDigits.unshift(5);
        recentDigits.forEach(d => features.push(d / 9));

        // Digit frequency distribution (10 features)
        const digitFreq = new Array(10).fill(0);
        tickHistory.slice(-100).forEach(d => digitFreq[d]++);
        const total = Math.max(1, tickHistory.slice(-100).length);
        digitFreq.forEach(f => features.push(f / total));

        // Run length statistics (10 features)
        const recentRuns = runLengths.slice(-20);
        while (recentRuns.length < 20) recentRuns.unshift(5);

        // Mean, std, min, max of recent runs
        const runMean = recentRuns.reduce((a, b) => a + b, 0) / recentRuns.length;
        const runStd = Math.sqrt(recentRuns.reduce((a, b) => a + (b - runMean) ** 2, 0) / recentRuns.length);
        const runMin = Math.min(...recentRuns);
        const runMax = Math.max(...recentRuns);

        features.push(runMean / 50);
        features.push(runStd / 20);
        features.push(runMin / 50);
        features.push(runMax / 50);

        // Current run length (normalized)
        features.push(currentRunLength / 50);

        // Volatility
        features.push(volatility);

        // Trend features
        const shortMean = recentRuns.slice(-5).reduce((a, b) => a + b, 0) / 5;
        const longMean = recentRuns.slice(-15).reduce((a, b) => a + b, 0) / 15;
        features.push((shortMean - longMean) / 20 + 0.5);

        // Momentum
        const momentum = recentRuns.length >= 2 ?
            (recentRuns[recentRuns.length - 1] - recentRuns[recentRuns.length - 2]) / 20 + 0.5 : 0.5;
        features.push(momentum);

        // Pad to input size
        while (features.length < this.inputSize) {
            features.push(0.5);
        }

        return features.slice(0, this.inputSize);
    }

    /**
     * Get training performance metrics
     */
    getPerformanceMetrics() {
        if (this.trainingHistory.length < 10) {
            return { accuracy: 0, recentLoss: 1, trend: 'insufficient_data' };
        }

        const recent = this.trainingHistory.slice(-100);
        const avgLoss = recent.reduce((a, b) => a + b.loss, 0) / recent.length;

        // Binary accuracy (threshold at 0.5)
        const correct = recent.filter(h =>
            (h.prediction >= 0.5 && h.target >= 0.5) ||
            (h.prediction < 0.5 && h.target < 0.5)
        ).length;

        const accuracy = correct / recent.length;

        // Trend
        const firstHalf = recent.slice(0, 50).reduce((a, b) => a + b.loss, 0) / 50;
        const secondHalf = recent.slice(-50).reduce((a, b) => a + b.loss, 0) / 50;
        const trend = secondHalf < firstHalf * 0.9 ? 'improving' :
            secondHalf > firstHalf * 1.1 ? 'degrading' : 'stable';

        return { accuracy, recentLoss: avgLoss, trend };
    }

    /**
     * Export weights for persistence
     */
    exportWeights() {
        return {
            weights: this.weights,
            biases: this.biases,
            velocities: this.velocities,
            trainingHistory: this.trainingHistory.slice(-500)
        };
    }

    /**
     * Import weights from saved state
     */
    importWeights(state) {
        if (state.weights) this.weights = state.weights;
        if (state.biases) this.biases = state.biases;
        if (state.velocities) this.velocities = state.velocities;
        if (state.trainingHistory) this.trainingHistory = state.trainingHistory;
        this.initialized = true;
    }
}

// ============================================================================
// TIER 4: ENSEMBLE DECISION MAKER
// ============================================================================

class EnsembleDecisionMaker {
    constructor() {
        this.modelWeights = {
            kaplanMeier: 0.25,
            bayesian: 0.20,
            markov: 0.15,
            neural: 0.25,
            pattern: 0.15
        };

        this.modelPerformance = {
            kaplanMeier: { correct: 0, total: 0 },
            bayesian: { correct: 0, total: 0 },
            markov: { correct: 0, total: 0 },
            neural: { correct: 0, total: 0 },
            pattern: { correct: 0, total: 0 }
        };

        this.recentDecisions = [];
        this.thresholdHistory = [];
        this.adaptiveThreshold = 0.7; // Default threshold;
    }

    /**
     * Combine predictions from all models
     */
    combinePredicitions(predictions) {
        let weightedSum = 0;
        let totalWeight = 0;
        const details = {};

        Object.entries(predictions).forEach(([model, pred]) => {
            if (pred !== null && pred !== undefined && !isNaN(pred.value)) {
                const weight = this.modelWeights[model] || 0.1;
                const confidence = pred.confidence || 1;
                const adjustedWeight = weight * confidence;

                weightedSum += pred.value * adjustedWeight;
                totalWeight += adjustedWeight;

                details[model] = {
                    value: pred.value,
                    weight: adjustedWeight,
                    contribution: pred.value * adjustedWeight
                };
            }
        });

        const ensembleScore = totalWeight > 0 ? weightedSum / totalWeight : 0.5;

        // Calculate agreement (how much models agree)
        const values = Object.values(predictions)
            .filter(p => p !== null && p !== undefined)
            .map(p => p.value);

        const agreement = values.length > 1 ?
            1 - (Math.max(...values) - Math.min(...values)) : 0;

        // console.log('Adaptive Threshold:', this.adaptiveThreshold);

        return {
            score: ensembleScore,
            agreement,
            details,
            shouldTrade: ensembleScore >= this.adaptiveThreshold && agreement > 0.5
        };
    }

    /**
     * Record outcome and update model weights
     */
    recordOutcome(predictions, actualOutcome) {
        Object.entries(predictions).forEach(([model, pred]) => {
            if (pred !== null && pred !== undefined) {
                const predicted = pred.value >= 0.5;
                const actual = actualOutcome;

                this.modelPerformance[model].total++;
                if (predicted === actual) {
                    this.modelPerformance[model].correct++;
                }
            }
        });

        // Update weights based on performance
        this.updateModelWeights();

        // Record decision for threshold optimization
        this.recentDecisions.push({
            predictions,
            outcome: actualOutcome,
            timestamp: Date.now()
        });

        if (this.recentDecisions.length > 500) {
            this.recentDecisions.shift();
        }
    }

    /**
     * Update model weights based on recent performance
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

        // Normalize weights by accuracy
        if (totalAccuracy > 0 && Object.keys(accuracies).length > 0) {
            Object.entries(accuracies).forEach(([model, accuracy]) => {
                // Exponential weighting favors better models
                this.modelWeights[model] = Math.pow(accuracy, 2) / totalAccuracy;
            });

            // Normalize to sum to 1
            const sum = Object.values(this.modelWeights).reduce((a, b) => a + b, 0);
            Object.keys(this.modelWeights).forEach(model => {
                this.modelWeights[model] /= sum;
            });
        }
    }

    /**
     * Optimize trading threshold based on historical performance
     */
    optimizeThreshold() {
        if (this.recentDecisions.length < 5) return;

        const thresholds = [0.6, 0.65, 0.7, 0.75, 0.8]; //[0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
        let bestThreshold = 0.7;
        let bestScore = -Infinity;

        thresholds.forEach(threshold => {
            let wins = 0;
            let losses = 0;
            let trades = 0;

            this.recentDecisions.forEach(decision => {
                const ensemble = this.combinePredicitions(decision.predictions);
                if (ensemble.score > threshold) {
                    trades++;
                    if (decision.outcome) {
                        wins++;
                    } else {
                        losses++;
                    }
                }
            });

            // Score = win rate * sqrt(trade frequency)
            if (trades > 10) {
                const winRate = wins / trades;
                const frequency = trades / this.recentDecisions.length;
                const score = winRate * Math.sqrt(frequency);

                if (score > bestScore) {
                    bestScore = score;
                    bestThreshold = threshold;
                }
            }
        });

        // Smooth transition to new threshold
        this.adaptiveThreshold = 0.8 * this.adaptiveThreshold + 0.2 * bestThreshold;

        this.thresholdHistory.push({
            threshold: this.adaptiveThreshold,
            timestamp: Date.now()
        });
    }

    /**
     * Get current model performance summary
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
            adaptiveThreshold: this.adaptiveThreshold.toFixed(3),
            totalDecisions: this.recentDecisions.length
        };
    }

    /**
     * Export state for persistence
     */
    exportState() {
        return {
            modelWeights: this.modelWeights,
            modelPerformance: this.modelPerformance,
            adaptiveThreshold: this.adaptiveThreshold,
            recentDecisions: this.recentDecisions.slice(-200)
        };
    }

    /**
     * Import state from saved data
     */
    importState(state) {
        if (state.modelWeights) this.modelWeights = state.modelWeights;
        if (state.modelPerformance) this.modelPerformance = state.modelPerformance;
        if (state.adaptiveThreshold) this.adaptiveThreshold = state.adaptiveThreshold;
        if (state.recentDecisions) this.recentDecisions = state.recentDecisions;
    }
}

// ============================================================================
// TIER 5: PERSISTENCE MANAGER
// ============================================================================

// class PersistenceManager {
//     constructor(baseDir = './bot_memory2') {
//         this.baseDir = baseDir;
//         this.ensureDirectory();
//     }

//     ensureDirectory() {
//         if (!fs.existsSync(this.baseDir)) {
//             fs.mkdirSync(this.baseDir, { recursive: true });
//             console.log(`📁 Created memory directory: ${this.baseDir}`);
//         }
//     }

//     /**
//      * Save learning data to file
//      */
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

//     /**
//      * Load learning data from file
//      */
//     // load(filename) {
//     //     try {
//     //         const filepath = path.join(this.baseDir, filename);
//     //         if (fs.existsSync(filepath)) {
//     //             const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
//     //             console.log(`📂 Loaded: ${filename}`);
//     //             return data;
//     //         }
//     //         return null;
//     //     } catch (error) {
//     //         console.error(`Error loading ${filename}:`, error.message);
//     //         return null;
//     //     }
//     // }

//     /**
//      * Save all bot state
//      */
//     saveFullState(bot) {
//         const state = {
//             timestamp: Date.now(),
//             statisticalEngine: {
//                 bayesianPriors: bot.statisticalEngine.bayesianPriors
//             },
//             patternEngine: {
//                 ngramModels: bot.patternEngine.ngramModels,
//                 markovChains: bot.patternEngine.markovChains,
//                 regimeStates: bot.patternEngine.regimeStates
//             },
//             neuralEngine: bot.neuralEngine.exportWeights(),
//             ensembleDecisionMaker: bot.ensembleDecisionMaker.exportState(),
//             learningSystem: bot.learningSystem,
//             extendedStayedIn: bot.extendedStayedIn,
//             performanceHistory: {
//                 totalTrades: bot.totalTrades,
//                 totalWins: bot.totalWins,
//                 totalLosses: bot.totalLosses,
//                 totalProfitLoss: bot.totalProfitLoss
//             }
//         };

//         return this.save('bot_state.json', state);
//     }

//     /**
//      * Load all bot state
//      */
//     loadFullState() {
//         return this.load('bot_state.json');
//     }

//     /**
//      * Save performance log
//      */
//     appendPerformanceLog(entry) {
//         const logFile = 'performance_log.json';
//         let log = this.load(logFile) || [];
//         log.push({ ...entry, timestamp: Date.now() });

//         // Keep last 10000 entries
//         if (log.length > 10000) {
//             log = log.slice(-10000);
//         }

//         return this.save(logFile, log);
//     }

//     /**
//      * Get performance statistics
//      */
//     getPerformanceStats() {
//         const log = this.load('performance_log.json') || [];
//         if (log.length === 0) return null;

//         const wins = log.filter(e => e.won).length;
//         const losses = log.filter(e => !e.won).length;

//         // Daily breakdown
//         const dailyStats = {};
//         log.forEach(entry => {
//             const date = new Date(entry.timestamp).toISOString().split('T')[0];
//             if (!dailyStats[date]) {
//                 dailyStats[date] = { wins: 0, losses: 0, profit: 0 };
//             }
//             if (entry.won) {
//                 dailyStats[date].wins++;
//             } else {
//                 dailyStats[date].losses++;
//             }
//             dailyStats[date].profit += entry.profit || 0;
//         });

//         return {
//             total: { wins, losses, winRate: wins / (wins + losses) },
//             daily: dailyStats,
//             recentTrend: log.slice(-50)
//         };
//     }
// }

// ============================================================================
// MAIN ENHANCED TRADING BOT
// ============================================================================

class EnhancedAccumulatorBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];

        this.config = {
            initialStake: config.initialStake || 1,
            multiplier: config.multiplier || 21,
            multiplier2: config.multiplier2 || 100,
            multiplier3: config.multiplier3 || 1000,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            stopLoss: config.stopLoss || 400,
            takeProfit: config.takeProfit || 5000,
            growthRate: 0.05,
            accuTakeProfit: 0.01,
            requiredHistoryLength: config.requiredHistoryLength || 200,
            winProbabilityThreshold: config.winProbabilityThreshold || 100,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            minWaitTime: config.minWaitTime || 200 * 1000,
            maxWaitTime: config.maxWaitTime || 500 * 1000,
            survivalThreshold: config.survivalThreshold || 0.98,
            minSamplesForEstimate: 50,
            // New config options
            learningModeThreshold: config.learningModeThreshold || 100,
            enableNeuralNetwork: config.enableNeuralNetwork !== false,
            enablePatternRecognition: config.enablePatternRecognition !== false,
            saveInterval: config.saveInterval || 300000, // 5 minutes
        };

        // Trading state
        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.currentTradeId = null;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.endOfDay = false;
        this.waitTime = 0;
        this.waitSeconds = 0;
        this.isWinTrade = false;
        this.retryCount = 0;
        this.suspendedAssets = new Set();
        this.Pause = false;
        this.survivalNum = null;
        this.sys = 1;
        this.sysCount = 0;
        this.stopLossStake = false;

        // Asset-specific data
        this.digitCounts = {};
        this.tickSubscriptionIds = {};
        this.tickHistories = {};
        this.lastDigits = {};
        this.predictedDigits = {};
        this.lastPredictions = {};
        this.assetStates = {};
        this.pendingProposals = new Map();
        this.previousStayedIn = {};
        this.extendedStayedIn = {};

        // ====================================================================
        // ENHANCED LEARNING COMPONENTS
        // ====================================================================

        // Tier 1: Statistical Engine
        this.statisticalEngine = new StatisticalEngine();

        // Tier 2: Pattern Engine
        this.patternEngine = new PatternEngine();

        // Tier 3: Neural Engine
        this.neuralEngine = new NeuralEngine(60, [32, 16], 1);

        // Tier 4: Ensemble Decision Maker
        this.ensembleDecisionMaker = new EnsembleDecisionMaker();

        // Tier 5: Persistence Manager
        // this.persistenceManager = new PersistenceManager();

        // Learning mode counter
        this.observationCount = 0;
        this.learningMode = true;

        // Legacy learning system (enhanced)
        this.learningSystem = {
            lossPatterns: {},
            failedDigitCounts: {},
            volatilityScores: {},
            filterPerformance: {},
            resetPatterns: {},
            timeWindowPerformance: [],
            adaptiveFilters: {},
            predictionAccuracy: {},
        };

        // Risk manager (preserved as requested)
        this.riskManager = {
            currentSessionRisk: 0,
            riskPerTrade: 0.02,
            cooldownPeriod: 0,
            lastLossTime: null,
            consecutiveSameDigitLosses: {},
        };

        // Initialize assets
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.lastDigits[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
            this.assetStates[asset] = {
                stayedInArray: [],
                tradedDigitArray: [],
                filteredArray: [],
                totalArray: [],
                currentProposalId: null,
                tradeInProgress: false,
                consecutiveLosses: 0,
                lastTradeResult: null,
                digitFrequency: {},
            };
            this.previousStayedIn[asset] = null;
            this.extendedStayedIn[asset] = [];

            // Initialize learning components per asset
            this.learningSystem.lossPatterns[asset] = [];
            this.learningSystem.volatilityScores[asset] = 0;
            this.learningSystem.adaptiveFilters[asset] = 8;
            this.learningSystem.predictionAccuracy[asset] = { correct: 0, total: 0 };
            this.riskManager.consecutiveSameDigitLosses[asset] = {};

            // Initialize statistical engine
            this.statisticalEngine.initBayesianPrior(asset);
        });

        // Telegram Configuration
        this.telegramToken = '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ';
        this.telegramChatId = '752497117';
        this.telegramEnabled = true;

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
            this.startTelegramTimer();
        } else {
            console.log('📱 Telegram notifications disabled (missing API keys).');
        }

        // Stats tracking for Telegram summaries
        this.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };

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

        // Message queue for failed sends
        this.messageQueue = [];
        this.maxQueueSize = 50;
        this.kLoss = 0.01;

        // Load saved state if available
        this.loadSavedState();
    }

    // ========================================================================
    // PERSISTENCE METHODS
    // ========================================================================

    loadSavedState() {
        const state = StatePersistence.loadState();
        if (state) {
            console.log('📂 Loading saved learning state...');

            const trading = state.trading || {};
            this.currentStake = trading.currentStake || this.config.initialStake;
            this.consecutiveLosses = trading.consecutiveLosses || 0;
            this.totalTrades = trading.totalTrades || 0;
            this.totalWins = trading.totalWins || 0;
            this.totalLosses = trading.totalLosses || 0;
            this.consecutiveLosses2 = trading.consecutiveLosses2 || 0;
            this.consecutiveLosses3 = trading.consecutiveLosses3 || 0;
            this.consecutiveLosses4 = trading.consecutiveLosses4 || 0;
            this.consecutiveLosses5 = trading.consecutiveLosses5 || 0;
            this.totalProfitLoss = trading.totalProfitLoss || 0;
            this.Pause = trading.Pause || false;
            this.sys = trading.sys || 1;
            this.sysCount = trading.sysCount || 0;

            if (state.hourlyStats) this.hourlyStats = state.hourlyStats;

            if (state.neuralEngine) {
                this.neuralEngine.importWeights(state.neuralEngine);
            }

            if (state.ensembleDecisionMaker) {
                this.ensembleDecisionMaker.importState(state.ensembleDecisionMaker);
            }

            if (state.learningSystem) {
                this.learningSystem = { ...this.learningSystem, ...state.learningSystem };
            }

            if (state.extendedStayedIn) {
                this.extendedStayedIn = state.extendedStayedIn;
            }
            if (state.previousStayedIn) {
                this.previousStayedIn = state.previousStayedIn;
            }
            if (state.assetStates) {
                this.assetStates = state.assetStates;
            }

            if (state.assets) {
                Object.keys(state.assets).forEach(asset => {
                    if (this.tickHistories[asset]) {
                        this.tickHistories[asset] = state.assets[asset].tickHistory || [];
                    }
                });
            }

            console.log('✅ Learning state restored successfully');
        } else {
            console.log('🆕 No saved state found. Starting fresh learning.');
        }
    }

    // ========================================================================
    // WEBSOCKET & CONNECTION METHODS
    // ========================================================================

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('Already connected');
            return;
        }

        console.log('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.wsReady = false; // Wait for auth
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
    }

    stopMonitor() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.checkDataInterval) clearInterval(this.checkDataInterval);
        if (this.pongTimeout) clearTimeout(this.pongTimeout);
        this.pingInterval = null;
        this.checkDataInterval = null;
        this.pongTimeout = null;
    }

    sendRequest(request) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('Cannot send request: WebSocket not ready');
            if (this.messageQueue && this.messageQueue.length < this.maxQueueSize) {
                this.messageQueue.push(request);
            }
            return false;
        }

        try {
            this.ws.send(JSON.stringify(request));
            return true;
        } catch (error) {
            console.error('Error sending request:', error.message);
            if (this.messageQueue && this.messageQueue.length < this.maxQueueSize) {
                this.messageQueue.push(request);
            }
            return false;
        }
    }

    processMessageQueue() {
        if (!this.messageQueue || this.messageQueue.length === 0) return;
        const queue = [...this.messageQueue];
        this.messageQueue = [];
        queue.forEach(message => this.sendRequest(message));
    }

    handleDisconnect() {
        if (this.endOfDay) {
            console.log('Planned shutdown, not reconnecting.');
            this.cleanup();
            return;
        }

        if (this.isReconnecting) return;

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

        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.sendTelegramMessage(
            `⚠️ <b>CONNECTION LOST - RECONNECTING</b>\n` +
            `📊 Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
            `⏱️ Retrying in ${(delay / 1000).toFixed(1)}s`
        );

        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

        this.reconnectTimer = setTimeout(() => {
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
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { }
            }
            this.ws = null;
        }
        this.connected = false;
        this.wsReady = false;
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
    }

    subscribeToTicks(asset) {
        const request = {
            ticks: asset,
            subscribe: 1
        };
        this.sendRequest(request);
    }

    requestProposal(asset) {
        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: this.config.growthRate,
            limit_order: {
                take_profit: this.kLoss
            }
        };
        this.sendRequest(proposal);
    }

    // ========================================================================
    // MESSAGE HANDLERS
    // ========================================================================

    handleMessage(message) {
        if (message.msg_type === 'ping') {
            this.sendRequest({ ping: 1 });
            return;
        }

        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                this.sendTelegramMessage(`❌ <b>Authentication Failed:</b> ${message.error.message}`);
                this.disconnect();
                return;
            }
            console.log('✅ Authenticated successfully');
            this.wsReady = true;

            this.processMessageQueue();

            this.tradeInProgress = false;
            this.predictionInProgress = false;
            // Removed: this.resetForNewDay(); - so we don't wipe memory during a reconnect
            this.survivalNum = null;
            this.retryCount = 0;
            this.initializeSubscriptions();

        } else if (message.msg_type === 'proposal') {
            this.handleProposal(message);
        } else if (message.msg_type === 'history') {
            const asset = message.echo_req.ticks_history;
            this.handleTickHistory(asset, message.history);
        } else if (message.msg_type === 'tick') {
            if (message.subscription) {
                const asset = message.tick.symbol;
                this.tickSubscriptionIds[asset] = message.subscription.id;
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
        console.log('Initializing subscriptions for all assets...');
        //unsubscribe from all assets
        this.assets.forEach(asset => {
            this.unsubscribeFromTicks(asset);
        });
        this.assets.forEach(asset => {
            this.subscribeToTickHistory(asset);
            this.subscribeToTicks(asset);
        });
    }

    handleTickHistory(asset, history) {
        this.tickHistories[asset] = history.prices.map(price => this.getLastDigit(price, asset));

        // Build initial pattern models
        if (this.config.enablePatternRecognition) {
            this.patternEngine.buildNgramModel(asset, this.tickHistories[asset], 5);
        }
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.lastDigits[asset] = lastDigit;
        this.tickHistories[asset].push(lastDigit);

        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        }

        this.digitCounts[asset][lastDigit]++;
        this.observationCount++;

        // Update pattern models periodically
        if (this.observationCount % 2 === 0 && this.config.enablePatternRecognition) {
            this.patternEngine.buildNgramModel(asset, this.tickHistories[asset], 5);
            this.patternEngine.buildMarkovChain(asset, this.extendedStayedIn[asset], 3);
        }

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            return;
        }

        // Check learning mode
        if (this.learningMode && this.observationCount < this.config.learningModeThreshold) {
            if (this.observationCount % 2 === 0) {
                console.log(`🎓 Learning mode: ${this.observationCount}/${this.config.learningModeThreshold} observations`);
            }
            return;
        } else if (this.learningMode) {
            console.log('✅ Learning phase complete. Trading enabled.');
            this.learningMode = false;
        }

        if (!this.tradeInProgress) {
            this.analyzeTicks(asset);
        }
    }

    // ========================================================================
    // ENHANCED ANALYSIS METHODS
    // ========================================================================

    /**
     * Calculate comprehensive market volatility
     */
    calculateVolatility(asset) {
        const history = this.tickHistories[asset];
        if (history.length < 20) return 0;

        const recentHistory = history.slice(-50);
        let changes = 0;
        for (let i = 1; i < recentHistory.length; i++) {
            if (recentHistory[i] !== recentHistory[i - 1]) changes++;
        }

        const volatility = changes / (recentHistory.length - 1);
        this.learningSystem.volatilityScores[asset] = volatility;

        // Also calculate entropy-based volatility
        const entropy = this.statisticalEngine.calculateEntropy(recentHistory);

        return { changeRate: volatility, entropy, combined: (volatility + entropy) / 2 };
    }

    /**
     * Enhanced market condition analysis
     */
    isMarketConditionFavorable(asset) {
        const volatilityData = this.calculateVolatility(asset);
        const assetState = this.assetStates[asset];

        // Check regime
        const regime = this.patternEngine.detectRegime(asset, this.extendedStayedIn[asset]);

        // Too volatile or unpredictable regime
        if (volatilityData.changeRate > 0.90 || regime.regime === 'volatile') {
            console.log(`[${asset}] Market too volatile (${volatilityData.changeRate.toFixed(2)}), regime: ${regime.regime}`);
            return false;
        }

        // Too stable - hard to profit
        if (volatilityData.changeRate < 0.31) {
            console.log(`[${asset}] Market too stable (${volatilityData.changeRate.toFixed(2)})`);
            return false;
        }

        // Check consecutive losses
        if (assetState.consecutiveLosses >= 2) {
            console.log(`[${asset}] Too many consecutive losses on this asset`);
            return false;
        }

        // Check Bayesian confidence
        const bayesian = this.statisticalEngine.getBayesianEstimate(asset);
        if (bayesian.mean < 0.4 && bayesian.confidence > 20) {
            console.log(`[${asset}] Low Bayesian probability (${bayesian.mean.toFixed(3)})`);
            return false;
        }

        return true;
    }

    /**
     * Calculate asset win rate from learning history
     */
    calculateAssetWinRate(asset) {
        const lossHistory = this.learningSystem.lossPatterns[asset] || [];
        const recentTrades = lossHistory.slice(-10);

        if (recentTrades.length === 0) return 0.5;

        const wins = recentTrades.filter(t => t.result === 'win').length;
        return wins / recentTrades.length;
    }

    /**
     * Enhanced trade outcome recording with neural network training
     */
    recordTradeOutcome(asset, won, digitCount, filterUsed, stayedInArray) {
        const volatility = this.learningSystem.volatilityScores[asset] || 0;

        const outcome = {
            asset,
            result: won ? 'win' : 'loss',
            digitCount,
            filterUsed,
            arraySum: stayedInArray.reduce((a, b) => a + b, 0),
            timestamp: Date.now(),
            volatility,
        };

        // Update legacy learning system
        if (!this.learningSystem.lossPatterns[asset]) {
            this.learningSystem.lossPatterns[asset] = [];
        }
        this.learningSystem.lossPatterns[asset].push(outcome);
        if (this.learningSystem.lossPatterns[asset].length > 100) {
            this.learningSystem.lossPatterns[asset].shift();
        }

        // Update Bayesian model
        this.statisticalEngine.updateBayesian(asset, won);

        // Train neural network
        if (this.config.enableNeuralNetwork && this.neuralEngine.initialized) {
            const features = this.neuralEngine.prepareFeatures(
                this.tickHistories[asset],
                this.extendedStayedIn[asset],
                digitCount,
                volatility
            );

            const target = won ? 1 : 0;
            const { loss, prediction } = this.neuralEngine.trainOnSample(features, target);

            // Track prediction accuracy
            if (!this.learningSystem.predictionAccuracy[asset]) {
                this.learningSystem.predictionAccuracy[asset] = { correct: 0, total: 0 };
            }
            this.learningSystem.predictionAccuracy[asset].total++;
            if ((prediction >= 0.5) === won) {
                this.learningSystem.predictionAccuracy[asset].correct++;
            }

            if (this.totalTrades % 10 === 0) {
                const metrics = this.neuralEngine.getPerformanceMetrics();
                console.log(`🧠 Neural Network: Accuracy=${(metrics.accuracy * 100).toFixed(1)}%, Trend=${metrics.trend}`);
            }
        }

        // Update ensemble decision maker
        this.ensembleDecisionMaker.recordOutcome(this.lastEnsemblePredictions || {}, won);

        // Optimize threshold periodically
        if (this.totalTrades % 20 === 0) {
            this.ensembleDecisionMaker.optimizeThreshold();
        }

        // Persist performance log
        // this.persistenceManager.appendPerformanceLog({
        //     asset,
        //     won,
        //     profit: won ? this.currentStake * 0.01 : -this.currentStake,
        //     digitCount,
        //     volatility
        // });
    }

    // ========================================================================
    // ENHANCED PROPOSAL HANDLER
    // ========================================================================

    handleProposal(message) {
        if (message.error) {
            console.error('Proposal error:', message.error.message);
            return;
        }

        let asset = null;
        if (message.echo_req && message.echo_req.symbol) {
            asset = message.echo_req.symbol;
        }
        if (!asset && message.proposal && message.proposal.id) {
            asset = this.pendingProposals.get(message.proposal.id) || null;
        }
        if (!asset || !this.assets.includes(asset)) {
            return;
        }

        const assetState = this.assetStates[asset];

        if (message.proposal) {
            const stayedInArray = message.proposal.contract_details.ticks_stayed_in;
            assetState.stayedInArray = stayedInArray;

            // Update extended historical stayedInArray
            const prev = this.previousStayedIn[asset];
            if (prev === null) {
                this.extendedStayedIn[asset] = stayedInArray.slice(0, 99);
            }
            else {
                let isIncreased = true;
                for (let i = 0; i < 99; i++) {
                    if (stayedInArray[i] !== prev[i]) {
                        isIncreased = false;
                        break;
                    }
                }
                if (isIncreased && stayedInArray[99] === prev[99] + 1) {
                    // No reset
                } else {
                    const completed = prev[99] + 1;
                    this.extendedStayedIn[asset].push(completed);
                    if (this.extendedStayedIn[asset].length > 100) {
                        this.extendedStayedIn[asset].shift();
                    }
                }
            }
            this.previousStayedIn[asset] = stayedInArray.slice();

            assetState.currentProposalId = message.proposal.id;
            this.pendingProposals.set(message.proposal.id, asset);

            // Calculate digit frequency
            const digitFrequency = {};
            stayedInArray.forEach(digit => {
                digitFrequency[digit] = (digitFrequency[digit] || 0) + 1;
            });
            assetState.digitFrequency = digitFrequency;

            // ================================================================
            // ENHANCED ENSEMBLE DECISION MAKING
            // ================================================================

            if (!assetState.tradeInProgress) {
                const decision = this.makeEnhancedTradeDecision(asset, stayedInArray);

                if (decision.shouldTrade) {
                    console.log(`[${asset}] 🎯 TRADE SIGNAL | Score: ${decision.ensembleScore.toFixed(4)} | Confidence: ${decision.confidence.toFixed(2)}`);
                    console.log(`[${asset}] Model contributions: ${JSON.stringify(decision.modelContributions)}`);
                    this.placeTrade(asset);
                }
            }
        }
    }

    /**
     * Make enhanced trade decision using ensemble of all models
     */
    makeEnhancedTradeDecision(asset, stayedInArray) {
        const currentDigitCount = stayedInArray[99] + 1;
        const runLengths = this.extendedStayedIn[asset];
        const volatilityData = this.calculateVolatility(asset);

        // Check dangerous patterns first
        if (this.detectDangerousPattern(asset, currentDigitCount, stayedInArray)) {
            return { shouldTrade: false, reason: 'dangerous_pattern' };
        }

        if (this.detectDangerousPattern2(asset)) {
            return { shouldTrade: false, reason: 'short_run_pattern' };
        }

        if (!this.isMarketConditionFavorable(asset)) {
            return { shouldTrade: false, reason: 'unfavorable_market' };
        }

        // Collect predictions from all models
        const predictions = {};

        // 1. Kaplan-Meier Survival
        if (runLengths.length >= this.config.minSamplesForEstimate) {
            const km = this.statisticalEngine.kaplanMeierEstimate(runLengths, currentDigitCount);
            predictions.kaplanMeier = {
                value: km.survival,
                confidence: Math.min(1, km.sampleSize / 100)
            };
        }

        // 2. Bayesian Estimate
        const bayesian = this.statisticalEngine.getBayesianEstimate(asset);
        predictions.bayesian = {
            value: bayesian.mean,
            confidence: Math.min(1, bayesian.confidence / 50)
        };

        // 3. Markov Chain Prediction
        if (runLengths.length >= 20) {
            const markov = this.patternEngine.predictNextRunState(asset, runLengths, 2);
            if (markov) {
                const favorableStates = ['medium', 'long', 'very_long'];
                const favorableProb = favorableStates.reduce((sum, state) =>
                    sum + (markov.predictions[state] || 0), 0);
                predictions.markov = {
                    value: favorableProb,
                    confidence: Math.min(1, markov.confidence / 30)
                };
            }
        }

        // 4. Neural Network Prediction
        if (this.config.enableNeuralNetwork && this.neuralEngine.initialized) {
            const features = this.neuralEngine.prepareFeatures(
                this.tickHistories[asset],
                runLengths,
                currentDigitCount,
                volatilityData.combined
            );

            const neural = this.neuralEngine.predictWithUncertainty(features);
            predictions.neural = {
                value: neural.prediction,
                confidence: neural.confidence
            };
        }

        // 5. Pattern-based Prediction
        if (this.config.enablePatternRecognition) {
            const recentDigits = this.tickHistories[asset].slice(-5);
            const ngramPred = this.patternEngine.predictFromNgram(asset, recentDigits, 3);
            if (ngramPred) {
                // Higher probability of specific digit = more predictable = potentially favorable
                predictions.pattern = {
                    value: ngramPred.probability > 0.15 ? 0.6 : 0.4,
                    confidence: ngramPred.confidence === 'high' ? 0.8 : 0.5
                };
            }
        }

        // Store for later recording
        this.lastEnsemblePredictions = predictions;

        // Combine all predictions
        const ensemble = this.ensembleDecisionMaker.combinePredicitions(predictions);
        console.log('Ensemble Decision:', ensemble.score.toFixed(2), ' (', this.ensembleDecisionMaker.adaptiveThreshold, ') |', ensemble.agreement.toFixed(2), '(0.5) |', 'shouldTrade:', ensemble.shouldTrade);

        // Additional check with survival threshold
        const survivalCheck = this.shouldTradeBasedOnSurvivalProb(asset, stayedInArray);
        console.log('Survival Check:', survivalCheck);

        // Final decision
        const shouldTrade = ensemble.shouldTrade &&
            survivalCheck &&
            this.survivalNum > this.config.survivalThreshold;

        // Extract model contributions for logging
        const modelContributions = {};
        Object.entries(predictions).forEach(([model, pred]) => {
            if (pred) {
                modelContributions[model] = (pred.value * 100).toFixed(1) + '%';
            }
        });

        return {
            shouldTrade,
            ensembleScore: ensemble.score,
            confidence: ensemble.agreement,
            survivalProb: this.survivalNum,
            modelContributions,
            threshold: this.ensembleDecisionMaker.adaptiveThreshold
        };
    }

    /**
     * Survival probability check (enhanced from original)
     */
    shouldTradeBasedOnSurvivalProb(asset, stayedInArray) {
        const currentDigitCount = stayedInArray[99] + 1;
        const history = this.extendedStayedIn[asset];

        if (history.length < this.config.minSamplesForEstimate) {
            return false;
        }

        // Use Kaplan-Meier for primary estimate
        const km = this.statisticalEngine.kaplanMeierEstimate(history, currentDigitCount);

        // Use Nelson-Aalen as secondary
        const na = this.statisticalEngine.nelsonAalenHazard(history, currentDigitCount);

        // Kernel-smoothed hazard for additional validation
        const kernelHazard = this.statisticalEngine.kernelSmoothedHazard(history, currentDigitCount);

        // Combine estimates
        const combinedSurvival = (km.survival + na.survivalFromHazard) / 2;

        // Check if hazard is too high
        if (kernelHazard > 0.3) {
            console.log(`[${asset}] High hazard rate detected (${kernelHazard.toFixed(3)}), skipping`);
            return false;
        }

        this.survivalNum = combinedSurvival;

        console.log(`[${asset}] Survival Analysis: kHazard=${kernelHazard.toFixed(3)}, KM=${km.survival.toFixed(4)}, NA=${na.survivalFromHazard.toFixed(4)}, Combined=${combinedSurvival.toFixed(4)}`);

        return combinedSurvival > this.config.survivalThreshold;
    }

    /**
     * Detect dangerous patterns from historical losses
     */
    detectDangerousPattern(asset, currentDigitCount, stayedInArray) {
        const recentLosses = this.learningSystem.lossPatterns[asset] || [];

        if (recentLosses.length === 0) {
            return false;
        }

        const currentArraySum = stayedInArray.reduce((a, b) => a + b, 0);

        const similarLosses = recentLosses
            .filter(loss => loss.result === 'loss')
            .slice(-10)
            .filter(loss => {
                return loss.digitCount === currentDigitCount &&
                    Math.abs(loss.arraySum - currentArraySum) < 100;
            });

        if (similarLosses.length >= 2) {
            console.log(`[${asset}] 🚨 Dangerous pattern: ${similarLosses.length} similar losses`);
            return true;
        }

        return false;
    }

    /**
     * Detect frequent short run patterns
     */
    detectDangerousPattern2(asset) {
        const history = this.extendedStayedIn[asset];

        if (!history || history.length < 10) {
            return false;
        }

        const recentShort = history.slice(-10).filter(l => l < 5).length;

        if (recentShort > 6) {
            console.log(`[${asset}] 🚨 Too many short runs: ${recentShort}/10`);
            return true;
        }

        return false;
    }

    analyzeTicks(asset) {
        if (this.tradeInProgress) return;
        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) return;
        if (this.suspendedAssets.has(asset)) return;

        if (!this.isMarketConditionFavorable(asset)) {
            return;
        }

        this.requestProposal(asset);
    }

    // ========================================================================
    // TRADE EXECUTION (PRESERVED)
    // ========================================================================

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

        console.log(`🚀 Placing trade for Asset: [${asset}] | Stake: ${this.currentStake.toFixed(2)}`);
        this.sendRequest(request);
        this.tradeInProgress = true;
        assetState.tradeInProgress = true;
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
        const assetState = this.assetStates[asset];

        if (assetState) {
            assetState.tradeInProgress = false;
            assetState.lastTradeResult = won ? 'win' : 'loss';
        }

        console.log(`[${asset}] Trade outcome: ${won ? '✅ WON' : '❌ LOST'}`);

        if (!this.hourlyStats) {
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
        }
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;
        if (won) this.hourlyStats.wins++;
        else this.hourlyStats.losses++;

        const resultEmoji = won ? '✅ WIN' : '❌ LOSS';
        const pnlStr = (profit >= 0 ? '+' : '') + '$' + Math.abs(profit).toFixed(2);
        const pnlColor = profit >= 0 ? '🟢' : '🔴';
        const winRate = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : 0;

        const telegramMsg = `
            ${resultEmoji} (Enhanced Accumulator Bot)
            
            📊 <b>${asset}</b>
            ${pnlColor} <b>P&L:</b> ${pnlStr}
            
            📊 <b>Trades Today:</b> ${this.totalTrades}
            📊 <b>Wins Today:</b> ${this.totalWins}
            📊 <b>Losses Today:</b> ${this.totalLosses}
            📊 <b>x2-x5 Losses:</b> ${this.consecutiveLosses2}/${this.consecutiveLosses3}/${this.consecutiveLosses4}/${this.consecutiveLosses5}
            
            📈 <b>Total P&L:</b> ${(this.totalProfitLoss >= 0 ? '+' : '')}$${Math.abs(this.totalProfitLoss).toFixed(2)}
            🎯 <b>Win Rate:</b> ${winRate}%
            
            📊 <b>Current Stake:</b> $${this.currentStake.toFixed(2)}
            
            ⏰ ${new Date().toLocaleTimeString()}
        `.trim();
        this.sendTelegramMessage(telegramMsg);

        // Record outcome for enhanced learning
        const digitCount = assetState.stayedInArray[99] + 1;
        const filterUsed = this.learningSystem.adaptiveFilters[asset];
        this.recordTradeOutcome(asset, won, digitCount, filterUsed, assetState.stayedInArray);

        this.totalTrades++;

        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;

            // if (this.sys === 2) {
            //     if (this.sysCount === 5) {
            //         this.sys = 1;
            //         this.sysCount = 0;
            //     }
            // } else if (this.sys === 3) {
            //     if (this.sysCount === 2) {
            //         this.sys = 1;
            //         this.sysCount = 0;
            //     }
            // }

            this.currentStake = this.config.initialStake;

            if (assetState) {
                assetState.consecutiveLosses = 0;
            }
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;

            if (assetState) {
                assetState.consecutiveLosses++;
            }

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
        }

        this.totalProfitLoss += profit;
        this.Pause = true;

        let baseWaitTime = this.config.minWaitTime;

        if (!won) {
            baseWaitTime = this.config.minWaitTime;
            // Loss handled by trade result telegram message.
            this.suspendAsset(asset);

            // if (this.consecutiveLosses >= 2) {
            //     if (this.sys === 1) {
            //         this.sys = 2;
            //     } else if (this.sys === 2) {
            //         this.sys = 3;
            //     }
            //     this.sysCount = 0;
            // }

            // if (this.sys === 2 && this.consecutiveLosses === 1 && this.currentStake === this.config.multiplier2) {
            //     this.sys = 3;
            //     this.sysCount = 0;
            // }
        } else {
            if (this.suspendedAssets.size > 1) {
                const firstSuspendedAsset = Array.from(this.suspendedAssets)[0];
                this.reactivateAsset(firstSuspendedAsset);
            }
        }

        const randomWaitTime = Math.floor(
            Math.random() * (this.config.maxWaitTime - baseWaitTime + 1)
        ) + baseWaitTime;

        const waitTimeMinutes = Math.round(randomWaitTime / 60000);
        if (!won) {
            this.waitTime = waitTimeMinutes + 120000;
        } else {
            this.waitTime = waitTimeMinutes;
        }
        this.waitSeconds = randomWaitTime;

        if (!this.endOfDay) {
            this.logTradingSummary(asset);
        }

        // Save state after each trade
        // this.persistenceManager.saveFullState(this);

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || this.totalProfitLoss <= -this.config.stopLoss || this.stopLossStake) {
            console.log('Stop condition reached. Stopping trading.');
            this.endOfDay = true;
            this.sendEmailSummary();
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

        if (!this.endOfDay) {
            setTimeout(() => {
                this.tradeInProgress = false;
                this.Pause = false;
                this.connect();
            }, randomWaitTime);
        }
    }

    //Reset
    resetForNewDay() {
        // Asset-specific data
        this.digitCounts = {};
        this.tickSubscriptionIds = {};
        this.tickHistories = {};
        this.lastDigits = {};
        this.predictedDigits = {};
        this.lastPredictions = {};
        this.assetStates = {};
        this.pendingProposals = new Map();
        this.previousStayedIn = {};
        this.extendedStayedIn = {};

        // ====================================================================
        // ENHANCED LEARNING COMPONENTS
        // ====================================================================

        // Tier 1: Statistical Engine
        this.statisticalEngine = new StatisticalEngine();

        // Tier 2: Pattern Engine
        this.patternEngine = new PatternEngine();

        // Tier 3: Neural Engine
        this.neuralEngine = new NeuralEngine(60, [32, 16], 1);

        // Tier 4: Ensemble Decision Maker
        this.ensembleDecisionMaker = new EnsembleDecisionMaker();

        // Tier 5: Persistence Manager
        // this.persistenceManager = new PersistenceManager();

        // Learning mode counter
        // this.observationCount = 0;
        // this.learningMode = true;

        // Legacy learning system (enhanced)
        // this.learningSystem = {
        //     lossPatterns: {},
        //     failedDigitCounts: {},
        //     volatilityScores: {},
        //     filterPerformance: {},
        //     resetPatterns: {},
        //     timeWindowPerformance: [],
        //     adaptiveFilters: {},
        //     predictionAccuracy: {},
        // };

        // Risk manager (preserved as requested)
        // this.riskManager = {
        //     currentSessionRisk: 0,
        //     riskPerTrade: 0.02,
        //     cooldownPeriod: 0,
        //     lastLossTime: null,
        //     consecutiveSameDigitLosses: {},
        // };

        // Initialize assets
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.lastDigits[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
            this.assetStates[asset] = {
                stayedInArray: [],
                tradedDigitArray: [],
                filteredArray: [],
                totalArray: [],
                currentProposalId: null,
                tradeInProgress: false,
                consecutiveLosses: 0,
                lastTradeResult: null,
                digitFrequency: {},
            };
            this.previousStayedIn[asset] = null;
            this.extendedStayedIn[asset] = [];

            // Initialize learning components per asset
            // this.learningSystem.lossPatterns[asset] = [];
            // this.learningSystem.volatilityScores[asset] = 0;
            // this.learningSystem.adaptiveFilters[asset] = 8;
            // this.learningSystem.predictionAccuracy[asset] = { correct: 0, total: 0 };
            // this.riskManager.consecutiveSameDigitLosses[asset] = {};

            // Initialize statistical engine
            this.statisticalEngine.initBayesianPrior(asset);
        });
    }

    // ========================================================================
    // ASSET MANAGEMENT (PRESERVED)
    // ========================================================================

    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
    }

    reactivateAsset(asset) {
        this.suspendedAssets.delete(asset);
    }

    suspendAllExcept(asset) {
        this.assets.forEach(a => {
            if (a !== asset) {
                this.suspendAsset(a);
            }
        });
        this.suspendedAssets.delete(asset);
    }

    reactivateAllSuspended() {
        Array.from(this.suspendedAssets).forEach(a => {
            this.reactivateAsset(a);
        });
    }

    unsubscribeAllTicks() {
        Object.values(this.tickSubscriptionIds).forEach(subId => {
            const request = {
                forget: subId
            };
            this.sendRequest(request);
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
            // console.log(`Unsubscribing from ticks for ${asset}. Subscription ID: ${subId}`);
            delete this.tickSubscriptionIds[asset];
        }
    }

    // ========================================================================
    // TIME-BASED CONTROLS (PRESERVED)
    // ========================================================================

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay(); // 0: Sunday, 1: Monday, ..., 6: Saturday
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Weekend logic: Saturday 11pm to Monday 2am GMT+1 -> Disconnect and stay disconnected
            const isWeekend = (currentDay === 0) || // Sunday
                (currentDay === 6 && currentHours >= 23) || // Saturday after 11pm
                (currentDay === 1 && currentHours < 8);    // Monday before 8am

            // if (isWeekend) {
            //     if (!this.endOfDay) {
            //         console.log("Weekend trading suspension (Saturday 11pm - Monday 8am). Disconnecting...");
            //         this.sendHourlySummary();
            //         this.disconnect();
            //         this.endOfDay = true;
            //     }
            //     return; // Prevent any reconnection logic during the weekend
            // }

            if (this.endOfDay && currentHours === 2 && currentMinutes >= 0) {
                console.log("It's 2:00 AM GMT+1, reconnecting the bot.");
                this.resetForNewDay();
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 11 && currentMinutes >= 0) {
                    console.log("It's past 11:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendHourlySummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    disconnect() {
        console.log('🛑 Disconnecting bot...');
        StatePersistence.saveState(this);
        this.endOfDay = true; // Prevent reconnection
        this.cleanup();
        console.log('✅ Bot disconnected successfully');
    }

    // ========================================================================
    // LOGGING (ENHANCED)
    // ========================================================================

    logTradingSummary(asset) {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('                    TRADING SUMMARY');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Wins: ${this.totalWins} | Total Losses: ${this.totalLosses}`);
        console.log(`x2 Losses: ${this.consecutiveLosses2} | x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`Total Profit/Loss: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log('───────────────────────────────────────────────────────────');
        console.log(`Asset: [${asset}]`);

        const assetWinRate = this.calculateAssetWinRate(asset);
        const volatility = this.learningSystem.volatilityScores[asset] || 0;
        console.log(`Recent Win Rate: ${(assetWinRate * 100).toFixed(1)}% | Volatility: ${(volatility * 100).toFixed(1)}%`);

        // Neural network metrics
        if (this.config.enableNeuralNetwork) {
            const neuralMetrics = this.neuralEngine.getPerformanceMetrics();
            console.log(`Neural Net Accuracy: ${(neuralMetrics.accuracy * 100).toFixed(1)}% | Trend: ${neuralMetrics.trend}`);
        }

        // Ensemble performance
        const ensemblePerf = this.ensembleDecisionMaker.getPerformanceSummary();
        console.log(`Adaptive Threshold: ${ensemblePerf.adaptiveThreshold}`);
        console.log('───────────────────────────────────────────────────────────');
        console.log(`Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log(`Wait Time: ${this.waitTime} minutes (${this.waitSeconds} ms)`);
        console.log('═══════════════════════════════════════════════════════════');
    }

    // ========================================================================
    // TELEGRAM METHODS (ENHANCED)
    // ========================================================================

    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;
        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error(`❌ Failed to send Telegram message: ${error.message}`);
        }
    }

    async sendHourlySummary() {
        if (!this.hourlyStats) return;
        const stats = this.hourlyStats;
        const winRate = stats.wins + stats.losses > 0
            ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1)
            : 0;
        const pnlEmoji = stats.pnl >= 0 ? '🟢' : '🔴';
        const pnlStr = (stats.pnl >= 0 ? '+' : '') + '$' + Math.abs(stats.pnl).toFixed(2);

        // Neural network metrics
        const neuralMetrics = this.config.enableNeuralNetwork && this.neuralEngine.initialized ? this.neuralEngine.getPerformanceMetrics() : { accuracy: 0 };
        // Ensemble performance
        const ensemblePerf = this.ensembleDecisionMaker.getPerformanceSummary();

        const message = `
            ⏰ <b>Enhanced Accumulator Session Summary</b>

            📊 <b>Session Stats</b>
            ├ Trades: ${stats.trades}
            ├ Wins: ${stats.wins} | Losses: ${stats.losses}
            ├ Win Rate: ${winRate}%
            └ ${pnlEmoji} <b>P&L:</b> ${pnlStr}

            📈 <b>All-Time/Daily Totals</b>
            ├ Total Trades: ${this.totalTrades}
            ├ Total W/L: ${this.totalWins}/${this.totalLosses}
            ├ x2-x5 Losses: ${this.consecutiveLosses2}/${this.consecutiveLosses3}/${this.consecutiveLosses4}/${this.consecutiveLosses5}
            ├ Total P&L: ${(this.totalProfitLoss >= 0 ? '+' : '')}$${Math.abs(this.totalProfitLoss).toFixed(2)}
            └ Current Stake: $${this.currentStake.toFixed(2)}
            
            🧠 <b>AI System State</b>
            ├ Neural Accuracy: ${(neuralMetrics.accuracy * 100).toFixed(1)}%
            └ Adaptive Threshold: ${ensemblePerf.adaptiveThreshold}

            ⏰ ${new Date().toLocaleString()}
        `.trim();

        try {
            await this.sendTelegramMessage(message);
            console.log('📱 Telegram: Session Summary sent');
        } catch (error) {
            console.error(`❌ Telegram session summary failed: ${error.message}`);
        }

        this.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };
    }

    sendEmailSummary() {
        // Redirect legacy email summary calls to telegram summary
        this.sendHourlySummary();
    }

    sendDisconnectResumptionEmailSummary() {
        this.sendHourlySummary();
    }

    sendLossEmail(asset) {
        // Handled intrinsically by handleTradeResult
    }

    sendErrorEmail(errorMessage) {
        this.sendTelegramMessage(`❌ <b>ERROR REPORT</b>\n\n${errorMessage}`);
    }

    // ========================================================================
    // START METHOD
    // ========================================================================

    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🚀 ENHANCED AI ACCUMULATOR TRADING BOT v2.0');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('  📊 Features:');
        console.log('    • Kaplan-Meier Survival Analysis');
        console.log('    • Bayesian Probability Updating');
        console.log('    • Markov Chain Pattern Recognition');
        console.log('    • Neural Network Prediction');
        console.log('    • Ensemble Decision Making');
        console.log('    • Persistent Learning Memory');
        console.log('');
        console.log(`  🎓 Learning Mode: ${this.learningMode ? 'Active' : 'Complete'}`);
        console.log(`  📁 Memory Directory: ./bot_memory/`);
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');

        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// ============================================================================
// RUN THE BOT
// ============================================================================

const token = 'rgNedekYXvCaPeP'; //|| process.env.DERIV_TOKEN;

const bot = new EnhancedAccumulatorBot(token, {
    initialStake: 1,
    stopLoss: 400,
    takeProfit: 2.5,
    enableNeuralNetwork: true,
    enablePatternRecognition: true,
    learningModeThreshold: 100,
    survivalThreshold: 0.9,
    maxConsecutiveLosses: 3,
    minWaitTime: 2000,
    maxWaitTime: 2000,
});

bot.start();

module.exports = {
    EnhancedAccumulatorBot,
    StatisticalEngine,
    PatternEngine,
    NeuralEngine,
    EnsembleDecisionMaker,
    // PersistenceManager 
};
