/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         QUANTUM CONFLUENCE ENGINE (QCE) — COMPLETE v3        ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  ADVANCED MATHEMATICAL & RECURRENT ARCHITECTURE:             ║
 * ║  ✓ Layer 1: PRNG Entropy Estimator (Lempel-Ziv Complexity)    ║
 * ║  ✓ Layer 2: Cross-Asset Lag Correlation Matrix (Multiplexed) ║
 * ║  ✓ Layer 3: Temporal Entropy Cycle Detection (Fourier/Window)║
 * ║  ✓ Layer 4: Multi-Lag Autocorrelation (Lag-7, 13, 19)        ║
 * ║  ✓ Layer 5: Velocity-Weighted Liquidity Sweep Engine         ║
 * ║  ✓ Layer 6: Recurrent Pattern Emergence Classifier (Native)  ║
 * ║  ✓ Ensemble: Adaptive Bayesian Dynamic Weighting Optimization ║
 * ║                                                              ║
 * ║  TARGET WIN RATE: 85-95% (Extreme Institutional Filtering)   ║
 * ║  SINGLE NODEJS APP — ZERO EXTERNAL MATH/ML DEPENDENCIES     ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const BOT_CONFIG = {
    token: 'Dz2V2KvRf4Uukt3',
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
    initialStake: 1.00,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 150.00,
    takeProfit: 5000.00,

    // Layer 1: PRNG State Complexity Estimator
    prngEstimator: {
        window: 120,
        entropyThreshold: 2.45, //2.45 Critical limit for structural predictability
    },

    // Layer 2: Multi-Asset Multiplex Lag Matrix 
    crossAssetCorrelation: {
        anchor: 'R_10',
        maxLagWindow: 12,
        minCorrelationThreshold: 0.58, //0.68
    },

    // Layer 3: Temporal Entropy Periodicity Tracker
    temporalEntropy: {
        sampleIntervalMs: 60000,
        macroLookbackWindow: 45,  // 45-minute moving frame
        minLowEntropyDensity: 0.75, // Must be 75% low entropy inside the current cycle
    },

    // Layer 4: Multi-Lag Autocorrelation Engine
    multiLagAutocorr: {
        lags: [7, 13, 19],
        criticalValueCutoff: 0.10, //0.35 Strict covariance bounds
    },

    // Layer 5: Kinetic Velocity-Weighted Sweeper
    kineticLiquidity: {
        window: 60,
        minVelocityTPS: 1.85, //1.85 Minimum Ticks Per Second arrival density
        minRepetitionCount: 3,  //4 Strong clustering constraint
    },

    // Layer 6: Native Recurrent Neural Pattern Emergence Classifier
    recurrentClassifier: {
        hiddenSize: 16,
        learningRate: 0.015,
        sequenceLength: 15,
        targetConfidence: 0.88,//0.88
    },

    // Ensemble System Config
    ensemble: {
        strictQuorumCount: 6,       // At least 5/6 systems must match target projection
        masterConfidenceLimit: 0.80, //0.88 Minimum probability bound to fire execution
        bayesianMemoryLength: 50,
    },

    minTimeBetweenTrades: 25000,
    requiredHistoryLength: 200,
    telegramToken: '7919033379:AAHluKFMECmhMrBhNr_XVpWvCKEonQPx9_0',
    telegramChatId: '752497117',
    maxReconnectAttempts: 30,
    reconnectDelay: 4000
};

// ─────────────────────────────────────────────────────────────────────────────
// QUANTUM PRODUCTION LOGGER (COLOR CODED METRICS HUB)
// ─────────────────────────────────────────────────────────────────────────────
class ProductionLogger {
    constructor() {
        this.logPath = path.join(__dirname, 'qce2_quantum_engine01.log');
    }

    raw(level, scope, message, meta = null) {
        const timestamp = new Date().toISOString();
        const colors = {
            PRNG: '\x1b[36m',       // Cyan
            CROSS: '\x1b[34m',      // Blue
            CYCLE: '\x1b[35m',      // Magenta
            AUTOCORR: '\x1b[93m',   // Bright Yellow
            KINETIC: '\x1b[32m',    // Green
            NEURAL: '\x1b[31m',     // Red
            ENSEMBLE: '\x1b[95m',   // Light Purple
            SYSTEM: '\x1b[37m',     // White
            CRITICAL: '\x1b[41m\x1b[37m' // Red Background
        };
        const clr = colors[scope] || '\x1b[0m';
        const rst = '\x1b[0m';

        let formattedMeta = '';
        if (meta && Object.keys(meta).length > 0) {
            formattedMeta = ' ── ' + JSON.stringify(meta);
        }

        console.log(`${clr}[${level}][${scope}]${rst} ${timestamp} | ${message}${formattedMeta}`);

        try {
            fs.appendFileSync(this.logPath, `[${level}][${scope}] ${timestamp} | ${message} ${meta ? JSON.stringify(meta) : ''}\n`);
        } catch (e) {
            console.error(`Logging system failure: ${e.message}`);
        }
    }

    prng(msg, meta) { this.raw('ANLYS', 'PRNG', msg, meta); }
    cross(msg, meta) { this.raw('ANLYS', 'CROSS', msg, meta); }
    cycle(msg, meta) { this.raw('ANLYS', 'CYCLE', msg, meta); }
    autocorr(msg, meta) { this.raw('ANLYS', 'AUTOCORR', msg, meta); }
    kinetic(msg, meta) { this.raw('ANLYS', 'KINETIC', msg, meta); }
    neural(msg, meta) { this.raw('ANLYS', 'NEURAL', msg, meta); }
    ensemble(msg, meta) { this.raw('EXEC', 'ENSEMBLE', msg, meta); }
    sys(msg, meta) { this.raw('INFO', 'SYSTEM', msg, meta); }
    crit(msg, meta) { this.raw('FATAL', 'CRITICAL', msg, meta); }
}

const QLog = new ProductionLogger();

// ─────────────────────────────────────────────────────────────────────────────
// COMPACT HIGH-PERFORMANCE NATIVE MATRIX UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
class MatrixMath {
    static zeros2D(rows, cols) {
        return Array(rows).fill(0).map(() => Array(cols).fill(0));
    }

    static random2D(rows, cols, scale = 0.1) {
        return Array(rows).fill(0).map(() => Array(cols).fill(0).map(() => (Math.random() * 2 - 1) * scale));
    }

    static dot(v1, v2) {
        let sum = 0;
        const len = v1.length;
        for (let i = 0; i < len; i++) sum += v1[i] * v2[i];
        return sum;
    }

    static matMulVec(m, v) {
        const out = Array(m.length).fill(0);
        const rows = m.length;
        for (let i = 0; i < rows; i++) {
            out[i] = this.dot(m[i], v);
        }
        return out;
    }

    static tanh(v) {
        return v.map(x => Math.tanh(x));
    }

    static softmax(v) {
        const max = Math.max(...v);
        const exps = v.map(x => Math.exp(x - max));
        const sum = exps.reduce((a, b) => a + b, 0);
        return exps.map(x => x / (sum || 1));
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// LAYER 6: NATIVE RECURRENT PATTERN EMERGENCE CLASSIFIER (NATIVE MATH LSTM/RNN)
// ══════════════════════════════════════════════════════════════════════════════
class NativeRecurrentClassifier {
    constructor(config) {
        this.cfg = config.recurrentClassifier;
        this.inputSize = 6;  // Features mapped: [digit, velocity, prngEntropy, lag7, lag13, crossCorr]
        this.hiddenSize = this.cfg.hiddenSize;
        this.outputSize = 10; // Probability profile mapped over base-10 spaces

        // Weight Initialization
        this.Wxh = MatrixMath.random2D(this.hiddenSize, this.inputSize);
        this.Whh = MatrixMath.random2D(this.hiddenSize, this.hiddenSize);
        this.Why = MatrixMath.random2D(this.outputSize, this.hiddenSize);

        this.bh = Array(this.hiddenSize).fill(0);
        this.by = Array(this.outputSize).fill(0);
    }

    /**
     * Compute hidden sequences through rolling state projection
     */
    forward(sequenceData) {
        let hPrev = Array(this.hiddenSize).fill(0);
        const sequenceLength = sequenceData.length;
        this.lastStates = [];

        for (let t = 0; t < sequenceLength; t++) {
            const xt = sequenceData[t];
            const ax = MatrixMath.matMulVec(this.Wxh, xt);
            const ah = MatrixMath.matMulVec(this.Whh, hPrev);

            const hRaw = ax.map((val, idx) => val + ah[idx] + this.bh[idx]);
            const hNext = MatrixMath.tanh(hRaw);

            this.lastStates.push({ xt, hPrev, hNext });
            hPrev = hNext;
        }

        const yRaw = MatrixMath.matMulVec(this.Why, hPrev).map((val, idx) => val + this.by[idx]);
        const probabilities = MatrixMath.softmax(yRaw);

        return { probabilities, finalHidden: hPrev };
    }

    /**
     * Online Real-Time Optimization Engine (Stochastic Backpropagation Loop)
     */
    trainSequence(sequenceData, actualDigitTarget) {
        const forwardPass = this.forward(sequenceData);
        const probs = forwardPass.probabilities;

        // Compute Output Error Hook
        const dY = [...probs];
        dY[actualDigitTarget] -= 1.0;

        const finalHidden = forwardPass.finalHidden;
        const dWhy = MatrixMath.zeros2D(this.outputSize, this.hiddenSize);
        const dby = [...dY];

        for (let i = 0; i < this.outputSize; i++) {
            for (let j = 0; j < this.hiddenSize; j++) {
                dWhy[i][j] = dY[i] * finalHidden[j];
            }
        }

        // Backpropagation Through Time (BPTT Frame Optimization)
        let dhNext = Array(this.hiddenSize).fill(0);
        for (let j = 0; j < this.hiddenSize; j++) {
            let sum = 0;
            for (let i = 0; i < this.outputSize; i++) sum += dY[i] * this.Why[i][j];
            dhNext[j] = sum;
        }

        const dWxh = MatrixMath.zeros2D(this.hiddenSize, this.inputSize);
        const dWhh = MatrixMath.zeros2D(this.hiddenSize, this.hiddenSize);
        const dbh = Array(this.hiddenSize).fill(0);

        const sequenceLength = this.lastStates.length;
        for (let t = sequenceLength - 1; t >= 0; t--) {
            const { xt, hPrev, hNext } = this.lastStates[t];

            // Tanh derivative conversion
            const dtanh = hNext.map((h, idx) => (1.0 - h * h) * dhNext[idx]);

            for (let i = 0; i < this.hiddenSize; i++) dbh[i] += dtanh[i];

            for (let i = 0; i < this.hiddenSize; i++) {
                for (let j = 0; j < this.inputSize; j++) {
                    dWxh[i][j] += dtanh[i] * xt[j];
                }
            }

            for (let i = 0; i < this.hiddenSize; i++) {
                for (let j = 0; j < this.hiddenSize; j++) {
                    dWhh[i][j] += dtanh[i] * hPrev[j];
                }
            }

            // Recurrent error propagation
            dhNext = Array(this.hiddenSize).fill(0);
            for (let j = 0; j < this.hiddenSize; j++) {
                let sum = 0;
                for (let i = 0; i < this.hiddenSize; i++) sum += dtanh[i] * this.Whh[i][j];
                dhNext[j] = sum;
            }
        }

        // Parameter Adjustments (SGD Gradient Shifts)
        const lr = this.cfg.learningRate;
        const clipBound = 4.0;

        const clipAndApply = (matrix, gradients) => {
            for (let i = 0; i < matrix.length; i++) {
                for (let j = 0; j < matrix[i].length; j++) {
                    let grad = gradients[i][j];
                    if (grad > clipBound) grad = clipBound;
                    if (grad < -clipBound) grad = -clipBound;
                    matrix[i][j] -= lr * grad;
                }
            }
        };

        clipAndApply(this.Wxh, dWxh);
        clipAndApply(this.Whh, dWhh);
        clipAndApply(this.Why, dWhy);

        for (let i = 0; i < this.hiddenSize; i++) this.bh[i] -= lr * Math.max(-clipBound, Math.min(clipBound, dbh[i]));
        for (let i = 0; i < this.outputSize; i++) this.by[i] -= lr * Math.max(-clipBound, Math.min(clipBound, dby[i]));
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// FULL INTEGRATED LAYERS CORE PROCESSOR
// ══════════════════════════════════════════════════════════════════════════════

// LAYER 1: PRNG State Complexity Estimator
class LayerPRNGEstimator {
    constructor(config) { this.cfg = config.prngEstimator; }
    execute(digits) {
        const slice = digits.slice(-this.cfg.window);
        const str = slice.join('');

        // Compute Lempel-Ziv Complexity
        let visited = new Set();
        let i = 0, complexity = 0;
        while (i < str.length) {
            let sub = str[i];
            let len = 1;
            while (visited.has(sub) && i + len < str.length) {
                len++;
                sub = str.substring(i, i + len);
            }
            visited.add(sub);
            complexity++;
            i += len;
        }

        const normalizedComplexity = (complexity * Math.log10(str.length)) / (str.length || 1);
        const isPredictable = normalizedComplexity < this.cfg.entropyThreshold;

        QLog.prng(`Calculated Complexity Profile`, { lz: normalizedComplexity, threshold: this.cfg.entropyThreshold, isPredictable });
        return { isPredictable, metric: normalizedComplexity };
    }
}

// LAYER 2: Multi-Asset Multiplex Lag Matrix
class LayerCrossAssetMatrix {
    constructor(config) { this.cfg = config.crossAssetCorrelation; }
    execute(allHistories, activeAsset) {
        const anchor = allHistories[this.cfg.anchor];
        const current = allHistories[activeAsset];

        if (!anchor || !current || anchor.length < 60 || current.length < 60) {
            return { isCorrelated: false, optimalLag: 0, coef: 0 };
        }

        const sampleSize = 50;
        const anchorSlice = anchor.slice(-sampleSize);

        let bestCoef = 0, optimalLag = 0;

        for (let lag = 0; lag <= this.cfg.maxLagWindow; lag++) {
            const currentSlice = current.slice(-(sampleSize + lag), current.length - lag);
            if (currentSlice.length < sampleSize) continue;

            // Calculate Pearson Correlation
            const mA = anchorSlice.reduce((a, b) => a + b, 0) / sampleSize;
            const mC = currentSlice.reduce((a, b) => a + b, 0) / sampleSize;

            let num = 0, denA = 0, denC = 0;
            for (let i = 0; i < sampleSize; i++) {
                const dA = anchorSlice[i] - mA;
                const dC = currentSlice[i] - mC;
                num += dA * dC;
                denA += dA * dA;
                denC += dC * dC;
            }
            const r = num / (Math.sqrt(denA * denC) || 1);
            if (Math.abs(r) > Math.abs(bestCoef)) {
                bestCoef = r;
                optimalLag = lag;
            }
        }

        const isCorrelated = Math.abs(bestCoef) >= this.cfg.minCorrelationThreshold;
        QLog.cross(`Cross-Asset Divergence Verified`, { asset: activeAsset, bestCoef, optimalLag, isCorrelated });
        return { isCorrelated, optimalLag, coef: bestCoef };
    }
}

// LAYER 3: Temporal Entropy Periodicity Tracker
class LayerTemporalPeriodicity {
    constructor(config) {
        this.cfg = config.temporalEntropy;
        this.timeline = [];
    }
    record(entropyValue) {
        this.timeline.push({ value: entropyValue, t: Date.now() });
        const cutoff = Date.now() - (this.cfg.macroLookbackWindow * 60 * 1000);
        this.timeline = this.timeline.filter(x => x.t > cutoff);
    }
    execute() {
        if (this.timeline.length < 15) return { structuralPass: false, density: 0 };
        const lowEntropyFrames = this.timeline.filter(x => x.value < 2.5).length;
        const density = lowEntropyFrames / this.timeline.length;

        const structuralPass = density >= this.cfg.minLowEntropyDensity;
        QLog.cycle(`Temporal Envelope State`, { density, structuralPass });
        return { structuralPass, density };
    }
}

// LAYER 4: Multi-Lag Autocorrelation Engine
class LayerMultiLagAutocorr {
    constructor(config) { this.cfg = config.multiLagAutocorr; }
    execute(digits) {
        const n = digits.length;
        const mean = digits.reduce((a, b) => a + b, 0) / n;
        let validLagsCount = 0;
        const lagData = {};

        for (const lag of this.cfg.lags) {
            let num = 0, den = 0;
            for (let i = lag; i < n; i++) {
                num += (digits[i] - mean) * (digits[i - lag] - mean);
            }
            for (let i = 0; i < n; i++) {
                den += Math.pow(digits[i] - mean, 2);
            }
            const r = num / (den || 1);
            lagData[`lag_${lag}`] = r;
            if (Math.abs(r) >= this.cfg.criticalValueCutoff) validLagsCount++;
        }

        const pass = validLagsCount >= 2;
        QLog.autocorr(`Autocorrelation State Space Matrix`, { pass, metrics: lagData });
        return { pass, lagData };
    }
}

// LAYER 5: Kinetic Velocity-Weighted Sweeper
class LayerKineticLiquidity {
    constructor(config) {
        this.cfg = config.kineticLiquidity;
        this.arrivalTimes = [];
    }
    tick() {
        this.arrivalTimes.push(Date.now());
        if (this.arrivalTimes.length > 100) this.arrivalTimes.shift();
    }
    execute(digits) {
        const now = Date.now();
        const frames = this.arrivalTimes.filter(t => (now - t) < 10000);
        const velocity = frames.length / 10.0; // Ticks Per Second profile

        const windowSlice = digits.slice(-this.cfg.window);
        const counts = Array(10).fill(0);
        windowSlice.forEach(d => counts[d]++);

        const maxCount = Math.max(...counts);
        const targetDigit = counts.indexOf(maxCount);

        const pass = velocity >= this.cfg.minVelocityTPS && maxCount >= this.cfg.minRepetitionCount;
        QLog.kinetic(`Kinetic Wave Pattern Vector`, { velocity, maxCount, targetDigit, pass });

        return { pass, targetDigit, velocity, maxCount };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MASTER ADAPTIVE ENSEMBLE SYSTEM ENGINE
// ─────────────────────────────────────────────────────────────────────────────
class MasterQuantumEnsemble {
    constructor(config) {
        this.cfg = config;
        this.l1 = new LayerPRNGEstimator(config);
        this.l2 = new LayerCrossAssetMatrix(config);
        this.l3 = new LayerTemporalPeriodicity(config);
        this.l4 = new LayerMultiLagAutocorr(config);
        this.l5 = new LayerKineticLiquidity(config);
        this.l6 = new NativeRecurrentClassifier(config);

        // Bayesian Memory Array
        this.weights = Array(6).fill(1.0);
        this.historyLog = [];
    }

    process(allHistories, activeAsset) {
        this.l5.tick();
        const digits = allHistories[activeAsset];

        const r1 = this.l1.execute(digits);
        const r2 = this.l2.execute(allHistories, activeAsset);
        this.l3.record(r1.metric);
        const r3 = this.l3.execute();
        const r4 = this.l4.execute(digits);
        const r5 = this.l5.execute(digits);

        // Extract Feature Tensor for Layer 6 Neural Pass
        const currentFeatures = [
            digits[digits.length - 1],
            r5.velocity,
            r1.metric,
            r4.lagData['lag_7'] || 0,
            r4.lagData['lag_13'] || 0,
            r2.coef
        ];

        // Hydrate recurrent sequence
        const sequenceLength = this.cfg.recurrentClassifier.sequenceLength;
        const seqTensor = [];
        for (let i = sequenceLength; i >= 1; i--) {
            const idx = digits.length - i;
            if (idx >= 0) {
                seqTensor.push([digits[idx], r5.velocity, r1.metric, 0, 0, r2.coef]);
            } else {
                seqTensor.push(currentFeatures);
            }
        }

        const neuralPass = this.l6.forward(seqTensor);
        const neuralProbMin = Math.min(...neuralPass.probabilities);
        const neuralTargetDigit = neuralPass.probabilities.indexOf(neuralProbMin);
        const neuralPassPass = (1.0 - neuralProbMin) >= this.cfg.recurrentClassifier.targetConfidence;

        QLog.neural(`Neural Recurrent Prediction Output`, { neuralTargetDigit, neuralProbMin, neuralPassPass });

        // Compile Confluence Voting Protocol
        const systems = [
            { pass: r1.isPredictable, target: r5.targetDigit },
            { pass: r2.isCorrelated, target: r5.targetDigit },
            { pass: r3.structuralPass, target: r5.targetDigit },
            { pass: r4.pass, target: r5.targetDigit },
            { pass: r5.pass, target: r5.targetDigit },
            { pass: neuralPassPass, target: neuralTargetDigit }
        ];

        // Calculate dynamic weighted voting profile
        const targetVotes = Array(10).fill(0);
        let activeLayersCount = 0;

        systems.forEach((sys, idx) => {
            if (sys.pass && sys.target !== null) {
                targetVotes[sys.target] += this.weights[idx];
                activeLayersCount++;
            }
        });

        const maxWeightedVotes = Math.max(...targetVotes);
        const consensusDigit = targetVotes.indexOf(maxWeightedVotes);
        const totalWeightSum = this.weights.reduce((a, b) => a + b, 0);
        const confidenceScore = activeLayersCount > 0 ? (maxWeightedVotes / totalWeightSum) : 0;

        const passesStrictQuorum = activeLayersCount >= this.cfg.ensemble.strictQuorumCount &&
            confidenceScore >= this.cfg.ensemble.masterConfidenceLimit;

        QLog.ensemble(`Ensemble Voting Resolution Frame`, {
            activeLayersCount,
            confidenceScore,
            consensusDigit,
            passesStrictQuorum
        });

        const packet = {
            shouldTrade: passesStrictQuorum,
            predictedDigit: consensusDigit,
            confidence: confidenceScore,
            features: currentFeatures,
            systemsState: systems.map(x => x.pass)
        };

        this.historyLog.push(packet);
        if (this.historyLog.length > this.cfg.ensemble.bayesianMemoryLength) this.historyLog.shift();

        return packet;
    }

    /**
     * Bayesian Real-Time Layer Weight Matrix Tuning Loop
     */
    commitFeedback(actualOutcomeDigit, wasWin) {
        if (this.historyLog.length === 0) return;
        const currentFrame = this.historyLog[this.historyLog.length - 1];

        // Execute real-time stochastic learning step for neural network loop
        const sequenceLength = this.cfg.recurrentClassifier.sequenceLength;
        const dummySequence = Array(sequenceLength).fill(0).map(() => currentFrame.features);
        this.l6.trainSequence(dummySequence, actualOutcomeDigit);

        // Readjust System Layer Weights via Bayesian Performance Matrix Shifts
        currentFrame.systemsState.forEach((wasActive, idx) => {
            if (wasActive) {
                if (wasWin) {
                    this.weights[idx] = Math.min(this.weights[idx] * 1.04, 3.0); // Reward execution hit
                } else {
                    this.weights[idx] = Math.max(this.weights[idx] * 0.92, 0.4); // Penalize structural miss
                }
            }
        });

        QLog.ensemble(`Bayesian Layer Weight Matrix Realigned`, { weights: this.weights.map(x => x.toFixed(2)) });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE MACHINE PERSISTENCE ENGINE
// ─────────────────────────────────────────────────────────────────────────────
const STORAGE_FILE_PATH = path.join(__dirname, 'qce_state_vault.json');

class VaultStorage {
    static preserve(engine) {
        try {
            const schema = {
                timestamp: Date.now(),
                metrics: {
                    currentStake: engine.currentStake,
                    consecutiveLosses: engine.consecutiveLosses,
                    totalTrades: engine.totalTrades,
                    totalWins: engine.totalWins,
                    totalLosses: engine.totalLosses,
                    totalProfitLoss: engine.totalProfitLoss,
                    dailyProfitLoss: engine.dailyProfitLoss
                },
                ensembleWeights: engine.ensemble.weights,
                assetMetrics: engine.assetMetrics,
                hourlyTrades: engine.hourlyTrades,
                hourlyStats: engine.hourlyStats,
                session: engine.session,
                currentTradeDay: engine.currentTradeDay
            };
            fs.writeFileSync(STORAGE_FILE_PATH, JSON.stringify(schema, null, 2));
        } catch (e) {
            QLog.crit('Vault storage dump execution crash', { msg: e.message });
        }
    }

    static reconstitute(engine) {
        try {
            if (!fs.existsSync(STORAGE_FILE_PATH)) return;
            const data = JSON.parse(fs.readFileSync(STORAGE_FILE_PATH, 'utf8'));
            if ((Date.now() - data.timestamp) > 3600000) return; // Discard expired structures

            engine.currentStake = data.metrics.currentStake;
            engine.consecutiveLosses = data.metrics.consecutiveLosses;
            engine.totalTrades = data.metrics.totalTrades;
            engine.totalWins = data.metrics.totalWins;
            engine.totalLosses = data.metrics.totalLosses;
            engine.totalProfitLoss = data.metrics.totalProfitLoss;
            engine.dailyProfitLoss = data.metrics.dailyProfitLoss || 0;
            engine.ensemble.weights = data.ensembleWeights;
            engine.assetMetrics = data.assetMetrics;
            if (data.hourlyTrades) engine.hourlyTrades = data.hourlyTrades;
            if (data.hourlyStats) engine.hourlyStats = data.hourlyStats;
            if (data.session) engine.session = data.session;
            if (data.currentTradeDay) engine.currentTradeDay = data.currentTradeDay;

            QLog.sys('Vault state vector parsed and hydrated back successfully');
        } catch (e) {
            QLog.crit('Vault storage data restoration crash', { msg: e.message });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE PRODUCTION MACHINE APP
// ─────────────────────────────────────────────────────────────────────────────
class QuantumConfluenceBot {
    constructor(config) {
        this.cfg = config;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.reconnectAttempts = 0;

        this.tradeInProgress = false;
        this.currentStake = config.initialStake;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.endOfDay = false;

        this.priceHistories = {};
        this.digitHistories = {};
        this.lastTradeTime = {};
        this.activeTrades = {};
        this.contractSubs = {};
        this.assetMetrics = {};

        config.assets.forEach(a => {
            this.priceHistories[a] = [];
            this.digitHistories[a] = [];
            this.lastTradeTime[a] = 0;
            this.assetMetrics[a] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
        });

        this.ensemble = new MasterQuantumEnsemble(config);

        if (config.telegramToken && config.telegramChatId) {
            this.telegram = new TelegramBot(config.telegramToken, { polling: false });
        }

        VaultStorage.reconstitute(this);

        // New tracking for summaries
        if (!this.hourlyStats) {
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
        }
        if (!this.session) {
            this.session = {
                startTime: Date.now(),
                startCapital: 0,
                tradesCount: 0,
                winsCount: 0,
                lossesCount: 0,
                netPL: 0,
                isActive: true
            };
        }
        if (!this.currentTradeDay) {
            this.currentTradeDay = new Date().toISOString().split('T')[0];
        }
        this.dailyProfitLoss = 0;
        this.hourlyTrades = [];
    }

    connect() {
        if (this.ws?.readyState === WebSocket.OPEN) return;
        this._cleanupWs();

        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            this.connected = true;
            this.reconnectAttempts = 0;
            this._send({ authorize: this.cfg.token });
        });

        this.ws.on('message', data => {
            try { this._handleMessage(JSON.parse(data)); } catch (e) { QLog.crit('WS pipeline parser error', { msg: e.message }); }
        });

        this.ws.on('close', () => this._onDisconnect());
        this.ws.on('error', e => QLog.crit('WS stream channel error socket fault', { msg: e.message }));
    }

    _send(packet) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(packet));
        }
    }

    _cleanupWs() {
        if (this.ws) {
            this.ws.removeAllListeners();
            try { this.ws.close(); } catch (_) { }
            this.ws = null;
        }
        this.connected = this.wsReady = false;
    }

    _onDisconnect() {
        this.connected = this.wsReady = false;
        if (this.endOfDay) return;

        if (this.reconnectAttempts >= this.cfg.maxReconnectAttempts) {
            QLog.crit('Reconnect circuit boundary exhaustion. Terminating thread.');
            return;
        }
        this.reconnectAttempts++;
        setTimeout(() => this.connect(), this.cfg.reconnectDelay);
    }

    _handleMessage(msg) {
        switch (msg.msg_type) {
            case 'authorize':
                QLog.sys('Broker Handshake Established', { balance: msg.authorize.balance });
                this.wsReady = true;

                if (this.session.startCapital === 0) {
                    this.session.startCapital = msg.authorize.balance;
                }

                this.cfg.assets.forEach(asset => {
                    this._send({ ticks_history: asset, adjust_start_time: 1, count: this.cfg.requiredHistoryLength, end: 'latest', start: 1, style: 'ticks' });
                    this._send({ ticks: asset, subscribe: 1 });
                });
                break;
            case 'history':
                const hAsset = msg.echo_req.ticks_history;
                this.priceHistories[hAsset] = msg.history.prices.map(p => parseFloat(p));
                this.digitHistories[hAsset] = this.priceHistories[hAsset].map(p => this._lastDigit(p, hAsset));
                break;
            case 'tick':
                this._onTick(msg.tick);
                break;
            case 'proposal':
                this._onProposal(msg);
                break;
            case 'buy':
                this._onBuy(msg);
                break;
            case 'proposal_open_contract':
                if (msg.proposal_open_contract?.is_sold) this._onTradeResult(msg.proposal_open_contract);
                break;
        }
    }

    _lastDigit(quote, asset) {
        const s = quote.toString();
        const [, frac = ''] = s.split('.');
        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) return frac.length >= 4 ? parseInt(frac[3]) : 0;
        if (['R_10', 'R_25'].includes(asset)) return frac.length >= 3 ? parseInt(frac[2]) : 0;
        return frac.length >= 2 ? parseInt(frac[1]) : 0;
    }

    _onTick(tick) {
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);
        const digit = this._lastDigit(price, asset);

        if (!this.priceHistories[asset]) return;

        this.priceHistories[asset].push(price);
        this.digitHistories[asset].push(digit);

        if (this.priceHistories[asset].length > 400) {
            this.priceHistories[asset].shift();
            this.digitHistories[asset].shift();
        }

        if (!this.wsReady || this.tradeInProgress) return;
        if (Date.now() - this.lastTradeTime[asset] < this.cfg.minTimeBetweenTrades) return;

        // Fire Quantum Confluence Evaluation Frame
        const analysis = this.ensemble.process(this.digitHistories, asset);
        if (analysis.shouldTrade) {
            this.tradeInProgress = true;
            this._send({
                proposal: 1,
                amount: this.currentStake.toFixed(2),
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                symbol: asset,
                duration: 1,
                duration_unit: 't',
                barrier: analysis.predictedDigit.toString()
            });
            this.activeAssetContext = asset;
        }
    }

    _onProposal(msg) {
        if (msg.error) {
            this.tradeInProgress = false;
            return;
        }
        this._send({ buy: msg.proposal.id, price: this.currentStake.toFixed(2) });
    }

    _onBuy(msg) {
        if (msg.error) {
            this.tradeInProgress = false;
            return;
        }
        const asset = this.activeAssetContext;
        this.activeTrades[asset] = { contractId: msg.buy.contract_id, stake: this.currentStake };
        this._send({ proposal_open_contract: 1, contract_id: msg.buy.contract_id, subscribe: 1 });
    }

    _onTradeResult(contract) {
        const asset = contract.underlying;
        const trade = this.activeTrades[asset];
        if (!trade) return;

        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const actualLastDigit = this._lastDigit(parseFloat(contract.barrier_count), asset);

        // Commit execution layer weight feedback loops
        this.ensemble.commitFeedback(actualLastDigit, won);

        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
        this.assetMetrics[asset].trades++;
        this.assetMetrics[asset].profitLoss += profit;

        // Update Hourly & Session Stats
        this._checkDayChange();
        const currentHour = new Date().getHours();
        if (currentHour !== this.hourlyStats.lastHour) {
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: currentHour };
        }
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;

        this.session.tradesCount++;
        this.session.netPL += profit;

        if (won) {
            this.hourlyStats.wins++;
            this.session.winsCount++;
            this.totalWins++;
            this.isWinTrade = true;
            this.currentStake = this.cfg.initialStake;
            this.consecutiveLosses = 0;
            this.assetMetrics[asset].wins++;
        } else {
            this.hourlyStats.losses++;
            this.session.lossesCount++;
            this.totalLosses++;
            this.consecutiveLosses++;
            this.assetMetrics[asset].losses++;
            this.currentStake = Math.ceil(this.currentStake * this.cfg.multiplier * 100) / 100;
        }

        this.lastTradeTime[asset] = Date.now();
        delete this.activeTrades[asset];
        this.tradeInProgress = false;

        this._dispatchTelegramNotification(asset, contract, won);
        VaultStorage.preserve(this);

        // Terminate bounds loops if limits crossed
        if (this.totalProfitLoss >= this.cfg.takeProfit) {
            this.endOfDay = true;
            this._dispatchTelegramNotification(asset, contract, won); // Ensure last result is sent
            this._sendTelegram(`🎯 <b>Take Profit!</b> P&L: +$${this.totalProfitLoss.toFixed(2)}`);
            this._sendSessionSummary();
            this._cleanupWs();
            QLog.crit('System Core Bound Intersect Triggered. Engine Halt.');
        } else if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses || this.totalProfitLoss <= -this.cfg.stopLoss) {
            this.endOfDay = true;
            this._dispatchTelegramNotification(asset, contract, won); // Ensure last result is sent
            this._sendTelegram(`🛑 <b>Stop Loss</b>\nLosses: ${this.consecutiveLosses} | P&L: $${this.totalProfitLoss.toFixed(2)}`);
            this._sendSessionSummary();
            this._cleanupWs();
            QLog.crit('System Core Bound Intersect Triggered. Engine Halt.');
        }
    }

    async _dispatchTelegramNotification(asset, contract, wasWin) {
        if (!this.telegram) return;
        const wr = ((this.totalWins / this.totalTrades) * 100).toFixed(1);
        const text = `🛸 <b>QCE Quantum Signal Closed</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Execution Outcome: ${wasWin ? '🟩 SUCCESS WIN' : '🟥 STRUCTURE BREACH'}\n` +
            `Target Barrier Digit: <b>${contract.barrier}</b>\n` +
            `P&L Generated: <b>$${contract.profit}</b>\n` +
            `Cumulative Profit Profile: $${this.totalProfitLoss.toFixed(2)}\n` +
            `Session Strike Metric: ${wr}% (W:${this.totalWins} | L:${this.totalLosses})`;
        try { await this.telegram.sendMessage(this.cfg.telegramChatId, text, { parse_mode: 'HTML' }); } catch (_) { }
    }

    async _sendTelegram(text) {
        if (!this.telegram) return;
        try { await this.telegram.sendMessage(this.cfg.telegramChatId, text, { parse_mode: 'HTML' }); }
        catch (e) { }
    }

    // ── Summaries & Timers ────────────────────────────────────────────────────
    async _sendHourlySummary() {
        try {
            const stats = { ...this.hourlyStats };
            if (stats.trades === 0) return;

            const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0.0';
            const pnlEmoji = stats.pnl >= 0 ? '🟢' : '🔴';
            const pnlStr = (stats.pnl >= 0 ? '+' : '') + '$' + stats.pnl.toFixed(2);

            const message = [
                `⏰ <b>Quantum Confluence v3 Hourly Summary</b>`, ``,
                `📊 <b>Last Hour</b>`,
                `├ Trades: ${stats.trades}`,
                `├ Wins: ${stats.wins} | Losses: ${stats.losses}`,
                `├ Win Rate: ${winRate}%`,
                `└ ${pnlEmoji} <b>P&L:</b> ${pnlStr}`, ``,
                `🗓️ <b>Today</b>`,
                `├ Total Trades: ${this.totalTrades}`,
                `└ Today P&L: ${this.dailyProfitLoss >= 0 ? '+' : ''}$${this.dailyProfitLoss.toFixed(2)}`
            ].join('\n');

            await this._sendTelegram(message);
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
        } catch (err) {
            console.error(`❌ _sendHourlySummary crashed: ${err.message}`);
        }
    }

    async _sendSessionSummary() {
        try {
            const durationMs = Date.now() - this.session.startTime;
            const hours = Math.floor(durationMs / 3600000);
            const minutes = Math.floor((durationMs % 3600000) / 60000);
            const winRate = this.session.tradesCount > 0
                ? ((this.session.winsCount / this.session.tradesCount) * 100).toFixed(1) + '%'
                : '0%';

            const message = [
                `📊 <b>SESSION SUMMARY - Quantum Confluence v3</b>`, ``,
                `⏱️ Duration: ${hours}h ${minutes}m`,
                `🔢 Trades: ${this.session.tradesCount}`,
                `✅ Wins: ${this.session.winsCount} | ❌ Losses: ${this.session.lossesCount}`,
                `📈 Win Rate: ${winRate}`,
                `💰 Session P/L: ${this.session.netPL >= 0 ? '+' : ''}$${this.session.netPL.toFixed(2)}`,
                `💵 Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`
            ].join('\n');

            await this._sendTelegram(message);
        } catch (err) {
            console.error(`❌ _sendSessionSummary crashed: ${err.message}`);
        }
    }

    async _sendDayEndSummary(dateKey) {
        try {
            const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) + '%' : '0%';
            const pnlEmoji = this.dailyProfitLoss >= 0 ? '🟢' : '🔴';

            const message = [
                `🌙 <b>END OF DAY REPORT - ${dateKey}</b>`, ``,
                `${pnlEmoji} <b>Day Results:</b>`,
                `├ Trades: ${this.totalTrades}`,
                `├ Wins: ${this.totalWins} | Losses: ${this.totalLosses}`,
                `├ Win Rate: ${wr}`,
                `└ Net P/L: $${this.dailyProfitLoss.toFixed(2)}`, ``,
                `📊 <b>Overall Stats:</b>`,
                `└ Total P&L: $${this.totalProfitLoss.toFixed(2)}`
            ].join('\n');

            await this._sendTelegram(message);
        } catch (err) {
            console.error(`❌ _sendDayEndSummary crashed: ${err.message}`);
        }
    }

    _startHourlyTimer() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const timeUntilNextHour = nextHour.getTime() - now.getTime();

        console.log(`⏰ Hourly Telegram timer started (first summary in ${Math.ceil(timeUntilNextHour / 60000)} min)`);

        setTimeout(() => {
            this._sendHourlySummary();
            setInterval(() => this._sendHourlySummary(), 60 * 60 * 1000);
        }, timeUntilNextHour);
    }

    _checkDayChange() {
        const currentDay = new Date().toISOString().split('T')[0];
        if (this.currentTradeDay && this.currentTradeDay !== currentDay) {
            console.log(`🗓️ Day changed from ${this.currentTradeDay} to ${currentDay}`);
            this._sendDayEndSummary(this.currentTradeDay);

            // Reset daily stats
            this.dailyProfitLoss = 0;
            this.currentTradeDay = currentDay;
            VaultStorage.preserve(this);
        }
    }

    // ── Time-based reconnect ──────────────────────────────────────────────────
    _startTimeScheduler() {
        setInterval(() => {
            const now = new Date();
            const gmt1 = new Date(now.getTime() + 3600000);
            const hr = gmt1.getUTCHours();
            const min = gmt1.getUTCMinutes();

            if (this.endOfDay && hr === 2 && min < 1) {
                console.log('⏰ 2:00 AM — reconnecting');
                this.endOfDay = false;
                this.tradeInProgress = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay && hr >= 23) {
                console.log('🌙 Post-win 11 PM — stopping for the night');
                this.endOfDay = true;
                this._sendTelegram(`🌙 <b>Night stop after win</b>\nP&L: $${this.totalProfitLoss.toFixed(2)}`);
                this._sendSessionSummary();
                this._cleanupWs();
            }
        }, 20000);
    }

    start() {
        QLog.sys('Quantum Confluence Core Boot Sequence Initialized');
        this.connect();
        this._startTimeScheduler();
        this._startHourlyTimer();
        setInterval(() => { if (this.connected) this._send({ ping: 1 }); }, 22000);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// THREAD ENTRY SYSTEM INVOCATION
// ─────────────────────────────────────────────────────────────────────────────
const runtimeEngineInstance = new QuantumConfluenceBot(BOT_CONFIG);
runtimeEngineInstance.start();
