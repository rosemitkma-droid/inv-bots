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
const STATE_FILE = path.join(__dirname, 'nliveMulti_01-state.json');
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
                    sys2: bot.sys2,
                    sys2WinCount: bot.sys2WinCount,
                    isWinTrade: bot.isWinTrade,
                },
                learningSystem: bot.learningSystem,
                extendedStayedIn: bot.extendedStayedIn,
                previousStayedIn: bot.previousStayedIn,
                assetStates: bot.assetStates,
                subscriptions: {
                    tickSubscriptionIds: { ...bot.tickSubscriptionIds }
                },
                assets: {},
                hourlyStats: bot.hourlyStats,
                observationCount: bot.observationCount,
                learningMode: bot.learningMode
            };

            bot.assets.forEach(asset => {
                persistableState.assets[asset] = {
                    tickHistory: bot.tickHistories[asset] || []
                };
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
            // console.log(`💾 State saved successfully at ${new Date().toLocaleTimeString()}`);
            return true;
        } catch (error) {
            console.error(`❌ Failed to save state: ${error.message}`);
            return false;
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                console.log('📂 No previous state file found, starting fresh');
                return null;
            }

            const fileContent = fs.readFileSync(STATE_FILE, 'utf8');
            const savedData = JSON.parse(fileContent);

            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            if (ageMinutes > 30) {
                console.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                // Optionally backup old state before deleting
                const backupFile = STATE_FILE.replace('.json', `_backup_${Date.now()}.json`);
                fs.renameSync(STATE_FILE, backupFile);
                console.log(`📦 Old state backed up to: ${backupFile}`);
                return null;
            }

            console.log(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);
            return savedData;
        } catch (error) {
            console.error(`❌ Failed to load state: ${error.message}`);
            if (error.code === 'ENOENT') {
                console.log('📂 State file not found, starting fresh');
            } else if (error instanceof SyntaxError) {
                console.error('⚠️ State file corrupted, starting fresh');
                // Backup corrupted file
                try {
                    const backupFile = STATE_FILE.replace('.json', `_corrupted_${Date.now()}.json`);
                    fs.renameSync(STATE_FILE, backupFile);
                    console.log(`📦 Corrupted file backed up to: ${backupFile}`);
                } catch (backupError) {
                    console.error('Failed to backup corrupted file:', backupError.message);
                }
            }
            return null;
        }
    }

    static startAutoSave(bot) {
        // Clear any existing auto-save interval
        if (bot.autoSaveInterval) {
            clearInterval(bot.autoSaveInterval);
        }

        bot.autoSaveInterval = setInterval(() => {
            if (bot.connected && !bot.endOfDay) {
                StatePersistence.saveState(bot);
            }
        }, STATE_SAVE_INTERVAL);

        console.log(`🔄 Auto-save started (every ${STATE_SAVE_INTERVAL / 1000} seconds)`);

        // Save on process exit
        const exitHandler = (options) => {
            console.log('\n🛑 Shutting down, saving final state...');
            StatePersistence.saveState(bot);
            if (options.exit) {
                process.exit();
            }
        };

        // Handle different exit events
        process.on('exit', exitHandler.bind(null, { cleanup: true }));
        process.on('SIGINT', exitHandler.bind(null, { exit: true }));
        process.on('SIGTERM', exitHandler.bind(null, { exit: true }));
        process.on('uncaughtException', (err) => {
            console.error('Uncaught Exception:', err);
            exitHandler({ exit: true });
        });
    }

    static stopAutoSave(bot) {
        if (bot.autoSaveInterval) {
            clearInterval(bot.autoSaveInterval);
            bot.autoSaveInterval = null;
            console.log('🔄 Auto-save stopped');
        }
    }
}

// ============================================================================
// TIER 1: STATISTICAL LEARNING ENGINE
// ============================================================================
class StatisticalEngine {
    constructor() {
        this.runHistory = {};           // All completed runs
        this.conditionalSurvivalCache = {};
        this.regimeHistory = {};
    }

    recordCompletedRun(asset, runLength) {
        if (!this.runHistory[asset]) this.runHistory[asset] = [];
        this.runHistory[asset].push(runLength);
        
        // Keep last 800 runs
        if (this.runHistory[asset].length > 800) this.runHistory[asset].shift();
    }

    /**
     * P(Survive additional M ticks | Already survived K ticks)
     */
    getConditionalSurvivalProbability(asset, currentStayedIn, additionalTicks = 5) {
        const runs = this.runHistory[asset] || [];
        if (runs.length < 60) return 0.65;

        const survivedAtLeastK = runs.filter(r => r >= currentStayedIn);
        if (survivedAtLeastK.length < 30) return 0.6;

        const survivedAtLeastKPlusM = survivedAtLeastK.filter(r => r >= currentStayedIn + additionalTicks);

        return survivedAtLeastKPlusM.length / survivedAtLeastK.length;
    }

    calculateRegimeScore(asset, recentDigits) {
        if (recentDigits.length < 40) return 0.5;

        const changes = recentDigits.slice(-40).reduce((count, digit, i, arr) => 
            count + (i > 0 && digit !== arr[i-1] ? 1 : 0), 0);

        const changeRate = changes / 39;
        
        // Ideal range for accumulators: moderate stability
        if (changeRate < 0.35) return 0.3;           // Too flat (traps)
        if (changeRate > 0.78) return 0.25;          // Too chaotic
        
        // Sweet spot
        return Math.max(0.65, 1 - Math.abs(changeRate - 0.52) * 2.8);
    }

    getLastDigitHealth(recentDigits) {
        if (recentDigits.length < 15) return 0.5;
        
        const last10 = recentDigits.slice(-10);
        const uniqueDigits = new Set(last10).size;
        
        // Too many repeating same digit = danger
        const sameDigitStreak = this.getStreak(last10);
        
        if (sameDigitStreak >= 4) return 0.2;
        if (uniqueDigits <= 3) return 0.4;
        
        return 0.85;
    }

    getStreak(digits) {
        let maxStreak = 1, current = 1;
        for (let i = 1; i < digits.length; i++) {
            if (digits[i] === digits[i-1]) current++;
            else current = 1;
            maxStreak = Math.max(maxStreak, current);
        }
        return maxStreak;
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
            initialStake2: config.initialStake2 || 5,
            multiplier: config.multiplier || 21,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            stopLoss: config.stopLoss || 400,
            takeProfit: config.takeProfit || 5000,
            growthRate: config.growthRate || 0.05,
            accuTakeProfit: config.accuTakeProfit || 0.01,
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
        this.sys2 = false;
        this.sys2WinCount = 0;
        this.ensembleAgreement = null;
        this.agreementScore = null;

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
            // this.statisticalEngine.initBayesianPrior(asset);
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

        // Load saved state if available
        this.loadSavedState();
    }

    // ========================================================================
    // PERSISTENCE METHODS
    // ========================================================================

    loadSavedState() {
        const state = StatePersistence.loadState();

        // Check if state was successfully loaded
        if (!state) {
            console.log('🆕 No saved state found or state too old. Starting fresh learning.');
            return;
        }

        console.log('📂 Loading saved learning state...');

        try {
            // Restore trading state
            if (state.trading) {
                const trading = state.trading;
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
                this.sys2 = trading.sys2 || false;
                this.sys2WinCount = trading.sys2WinCount || 0;
                this.isWinTrade = trading.isWinTrade || false;
            }

            // Restore hourly stats
            if (state.hourlyStats) {
                this.hourlyStats = state.hourlyStats;
            }

            // Restore learning mode state
            if (state.observationCount !== undefined) {
                this.observationCount = state.observationCount;
            }
            if (state.learningMode !== undefined) {
                this.learningMode = state.learningMode;
            }

            // Restore learning system
            if (state.learningSystem) {
                this.learningSystem = { ...this.learningSystem, ...state.learningSystem };
                console.log('  ✓ Learning system restored');
            }

            // Restore extended stayed-in data
            if (state.extendedStayedIn) {
                this.extendedStayedIn = state.extendedStayedIn;
                console.log('  ✓ Extended stayed-in data restored');
            }

            // Restore previous stayed-in data
            if (state.previousStayedIn) {
                this.previousStayedIn = state.previousStayedIn;
            }

            // Restore asset states
            if (state.assetStates) {
                this.assetStates = state.assetStates;
                console.log('  ✓ Asset states restored');
            }

            // Restore tick histories
            if (state.assets) {
                Object.keys(state.assets).forEach(asset => {
                    if (this.tickHistories[asset] && state.assets[asset].tickHistory) {
                        this.tickHistories[asset] = state.assets[asset].tickHistory;
                    }
                });
                console.log('  ✓ Tick histories restored');
            }

            console.log('✅ Learning state restored successfully');
            console.log(`📊 Restored ${this.totalTrades} trades, P&L: $${this.totalProfitLoss.toFixed(2)}`);

        } catch (error) {
            console.error(`❌ Error restoring state: ${error.message}`);
            console.log('⚠️ Continuing with fresh state...');
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
                take_profit: this.config.accuTakeProfit
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


        return { changeRate: volatility};
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
        // if (assetState.consecutiveLosses >= 2) {
        //     console.log(`[${asset}] Too many consecutive losses on this asset`);
        //     return false;
        // }

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
        if (message.error || !message.proposal) return;

        const asset = message.echo_req.symbol;
        if (!asset) return;

        const proposal = message.proposal;
        if (!proposal) return;

        const assetState = this.assetStates[asset];
        assetState.currentProposalId = proposal.id;
        this.pendingProposals.set(proposal.id, asset);

        const stayedInArray = message.proposal.contract_details.ticks_stayed_in;
        const currentStayed = stayedInArray[99] + 1;

        this.assetStates[asset].stayedInArray = stayedInArray;
        this.updateRunHistory(asset, stayedInArray);

        if (!this.tradeInProgress) {
            const decision = this.makeTradeDecision(asset, stayedInArray);

            console.log(`[${asset}] Stayed: ${currentStayed} | Score: ${(decision.score*100).toFixed(1)}% | Survival: ${(decision.survival*100).toFixed(1)}% | Regime: ${(decision.regimeScore*100).toFixed(1)}% | Confidence: ${(decision.confidence*100).toFixed(1)}%`);

            if (decision.shouldTrade && decision.confidence >= 1.0) {
                console.log(`✅ STRONG SIGNAL - Entering ${asset} at ${currentStayed} ticks`);
                this.placeTrade(asset, decision);
            }
        }
    }

    updateRunHistory(asset, stayedInArray) {
        const prev = this.previousStayedIn[asset];
        if (prev && stayedInArray[99] === 0 && prev[99] > 8) {
            this.statisticalEngine.recordCompletedRun(asset, prev[99] + 1);
        }
        this.previousStayedIn[asset] = [...stayedInArray];
    }

    /**
     * Make enhanced trade decision using ensemble of all models
     */
    makeTradeDecision(asset, stayedInArray) {
        const currentStayed = stayedInArray[99] + 1;
        const recentDigits = this.tickHistories[asset].slice(-50);

        // === HARD FILTERS ===
        if (currentStayed < 9) {
            return { shouldTrade: false, reason: 'too_early', survival: 0 };
        }

        if (this.detectDangerousPattern(asset, currentStayed, stayedInArray)) {
            return { shouldTrade: false, reason: 'dangerous_pattern' };
        }

        const survivalProb = this.statisticalEngine.getConditionalSurvivalProbability(
            asset, currentStayed, 6
        );

        const regimeScore = this.statisticalEngine.calculateRegimeScore(asset, recentDigits);
        const digitHealth = this.statisticalEngine.getLastDigitHealth(recentDigits);

        const finalScore = (
            survivalProb * 0.60 +
            regimeScore * 0.25 +
            digitHealth * 0.15
        );

        const confidence = Math.min(1, (currentStayed - 8) / 25);

        const shouldTrade = finalScore >= 0.58 && survivalProb >= 0.65 && confidence >= 0.25;

        return {
            shouldTrade,
            score: finalScore,
            survival: survivalProb,
            regimeScore,
            confidence,
            currentStayed,
            reason: shouldTrade ? 'strong_signal' : 'below_threshold'
        };
    }

    /**
     * Detect dangerous patterns from historical losses
     */
    detectDangerousPattern(asset, currentDigitCount, stayedInArray) {

        // FIX: Guard against undefined/null arguments
        if (!stayedInArray || !Array.isArray(stayedInArray) || stayedInArray.length === 0) {
            return false;
        }

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

        // FIX: Guard against undefined/null/non-array
        if (!history || !Array.isArray(history) || history.length < 10) {
            return false;
        }

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

    placeTrade(asset, decision) {
        if (this.tradeInProgress) return;
        const assetState = this.assetStates[asset];
        if (!assetState || !assetState.currentProposalId) {
            console.log(`Cannot place trade. Missing proposal for asset ${asset}.`);
            return;
        }

        // FIX: Pass the required arguments from assetState
        const stayedInArray = assetState.stayedInArray;
        const currentDigitCount = (stayedInArray && stayedInArray.length >= 100)
            ? stayedInArray[99] + 1
            : null;


        const request = {
            buy: assetState.currentProposalId,
            price: this.currentStake.toFixed(2)
        };

        console.log(`🚀 Placing trade for Asset: [${asset}] | Stake: ${this.currentStake.toFixed(2)}`);

        const telegramMsg = `
            🚀 <b>Placing trade for Asset ${asset}</b>
            <b>SIGNAL: ${(decision.score*100).toFixed(1)}%</b>

            <b>DECISION:</b> ${decision.shouldTrade ? '✅ STRONG SIGNAL - Entering Trade' : '❌ Signal below threshold, not trading'}
            <b>Regime Score: ${(decision.regimeScore*100).toFixed(1)}%</b>
            <b>Confidence: ${decision.confidence.toFixed(2)}%</b> 
            <b>SurvivalProb: ${(decision.survival*100).toFixed(1)}%</b>
            <b>currentStayed: ${decision.currentStayed}</b>

            <b>Current Stake:</b> $${this.currentStake.toFixed(2)}
        `.trim();
        this.sendTelegramMessage(telegramMsg);

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

        console.log(`[${asset}] Trade outcome: ${won ? '✅ WON' : '❌ LOST'}`);

        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;
        if (won) this.hourlyStats.wins++;
        else this.hourlyStats.losses++;

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

            if (this.sys2) {
                this.currentStake = this.config.initialStake2;
                this.sys2WinCount++;
                if (this.sys2WinCount === 50) {
                    this.currentStake = this.config.initialStake;
                    this.sys2WinCount = 0;
                    this.sys2 = false;
                }
            } else {
                this.currentStake = this.config.initialStake;
            }

            this.consecutiveLosses = 0;

            // if (assetState) {
            //     assetState.consecutiveLosses = 0;
            // }
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

            if (this.consecutiveLosses === 2) {
                if (this.sys2) {
                    this.consecutiveLosses = 4
                };
                this.sys2 = true
                this.currentStake = this.config.initialStake2;
            } else {
                this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            }
            // this.suspendAsset(asset);
        }

        this.totalProfitLoss += profit;

        if (!this.hourlyStats) {
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
        }

        if (assetState) {
            assetState.tradeInProgress = false;
            assetState.lastTradeResult = won ? 'win' : 'loss';
        }

        // Record outcome for enhanced learning
        const digitCount = assetState.stayedInArray[99] + 1;
        const filterUsed = this.learningSystem.adaptiveFilters[asset];
        this.recordTradeOutcome(asset, won, digitCount, filterUsed, assetState.stayedInArray);


        const resultEmoji = won ? '✅ WIN' : '❌ LOSS';
        const pnlStr = (profit >= 0 ? '+' : '-') + '$' + Math.abs(profit).toFixed(2);
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
            
            📊 <b>Current Stake:</b> $${this.currentStake.toFixed(2)}

            🎯 <b>Win Rate:</b> ${winRate}%
            📈 <b>Total P&L:</b> ${(this.totalProfitLoss >= 0 ? '+' : '-')}$${Math.abs(this.totalProfitLoss).toFixed(2)}

            
            ⏰ ${new Date().toLocaleTimeString()}
        `.trim();
        this.sendTelegramMessage(telegramMsg);


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

        this.tradeInProgress = false;
        this.Pause = false;

        // if (!this.endOfDay) {
        //     setTimeout(() => {
        //         this.tradeInProgress = false;
        //         this.Pause = false;
        //         this.connect();
        //     }, randomWaitTime);
        // }
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


        // Tier 5: Persistence Manager
        // this.persistenceManager = new PersistenceManager();

        // Learning mode counter
        this.observationCount = 0;
        this.learningMode = true;

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
            // this.statisticalEngine.initBayesianPrior(asset);
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
                if (currentHours >= 23 && currentMinutes >= 30) {
                    console.log("It's past 11:30 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendHourlySummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    disconnect() {
        console.log('🛑 Disconnecting bot...');
        // Save final state
        StatePersistence.saveState(this);
        // Stop auto-save
        StatePersistence.stopAutoSave(this);

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

        // Start auto-save
        StatePersistence.startAutoSave(this);

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
    initialStake2: 10,
    multiplier: 21,
    stopLoss: 242,
    takeProfit: 50000,
    growthRate: 0.05,
    accuTakeProfit: 0.01,
    enableNeuralNetwork: true,
    enablePatternRecognition: true,
    learningModeThreshold: 100,
    survivalThreshold: 0.9,
    maxConsecutiveLosses: 4,
    minWaitTime: 2000,
    maxWaitTime: 2000,
});

bot.start();

module.exports = {
    EnhancedAccumulatorBot,
    StatisticalEngine,
    PatternEngine,
};
 
