require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');


class EnhancedDigitDifferTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || ['R_10','R_25','R_50','R_75', 'R_100'];

        this.config = {
            initialStake: config.initialStake || 10.5,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
            stopLoss: config.stopLoss || 50,
            takeProfit: config.takeProfit || 1,
            growthRate: 0.05,
            accuTakeProfit: 0.01,
            requiredHistoryLength: config.requiredHistoryLength || 200,
            winProbabilityThreshold: config.winProbabilityThreshold || 100,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            minWaitTime: config.minWaitTime || 200 * 1000,
            maxWaitTime: config.maxWaitTime || 500 * 1000,
            // NEW: Enhanced array analysis settings
            extendedArraySize: 5000, // Extended from 100 to 5000
            recentDataWeight: 0.7, // 70% weight to recent 1000 entries
            minConfidenceThreshold: 0.65, // 65% confidence required
            minRiskRewardRatio: 0.5, // Minimum 1.5:1 risk/reward
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

        // Asset-specific data
        this.digitCounts = {};
        this.tickSubscriptionIds = {};
        this.tickHistories = {};
        this.lastDigits = {};
        this.predictedDigits = {};
        this.lastPredictions = {};
        this.assetStates = {};
        this.pendingProposals = new Map();

        // NEW: Extended circular buffer system for 5000 entries
        this.extendedArrayBuffers = {};
        
        // NEW: Advanced analytics and learning system
        this.learningSystem = {
            lossPatterns: {},
            failedDigitCounts: {},
            volatilityScores: {},
            filterPerformance: {},
            resetPatterns: {},
            timeWindowPerformance: [],
            adaptiveFilters: {},
            // NEW: Pattern recognition storage
            successfulPatterns: {},
            failedPatterns: {},
        };

        // NEW: Advanced risk management
        this.riskManager = {
            maxDailyLoss: config.stopLoss * 0.7,
            currentSessionRisk: 0,
            riskPerTrade: 0.02,
            cooldownPeriod: 0,
            lastLossTime: null,
            consecutiveSameDigitLosses: {},
            // NEW: Trade safety checks
            safetyChecks: {
                confidenceCheck: true,
                riskRewardCheck: true,
                stabilityCheck: true,
                patternCheck: true,
            },
        };

        // NEW: Advanced statistical analysis
        this.statisticalAnalysis = {
            movingAverages: {},
            volatilityMeasures: {},
            resetProbabilities: {},
            trendIndicators: {},
        };

        // NEW: Performance monitoring dashboard
        this.performanceMetrics = {
            dailyStats: {
                trades: 0,
                wins: 0,
                losses: 0,
                profitLoss: 0,
                winRate: 0,
                avgProfit: 0,
                avgLoss: 0,
                largestWin: 0,
                largestLoss: 0,
                riskAdjustedReturn: 0,
            },
            assetPerformance: {},
            strategyEffectiveness: {},
            hourlyPerformance: Array(24).fill(null).map(() => ({ trades: 0, wins: 0, pl: 0 })),
        };

        // NEW: Pattern recognition
        this.patternRecognition = {
            recentSequences: [],
            maxSequenceLength: 50,
            patternMemory: {},
        };

        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.lastDigits[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
            
            // NEW: Initialize extended circular buffer
            this.extendedArrayBuffers[asset] = {
                buffer: new Array(this.config.extendedArraySize).fill(null),
                head: 0,
                size: 0,
            };
            
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
            
            // Initialize learning system for each asset
            this.learningSystem.lossPatterns[asset] = [];
            this.learningSystem.volatilityScores[asset] = 0;
            this.learningSystem.adaptiveFilters[asset] = 8;
            this.learningSystem.successfulPatterns[asset] = [];
            this.learningSystem.failedPatterns[asset] = [];
            this.riskManager.consecutiveSameDigitLosses[asset] = {};
            
            // NEW: Initialize statistical analysis
            this.statisticalAnalysis.movingAverages[asset] = { ma20: 0, ma50: 0, ma100: 0 };
            this.statisticalAnalysis.volatilityMeasures[asset] = { std: 0, range: 0 };
            this.statisticalAnalysis.resetProbabilities[asset] = 0;
            this.statisticalAnalysis.trendIndicators[asset] = { trend: 'neutral', strength: 0 };
            
            // NEW: Initialize performance tracking
            this.performanceMetrics.assetPerformance[asset] = {
                trades: 0,
                wins: 0,
                losses: 0,
                winRate: 0,
                profitLoss: 0,
                avgTicksPerTrade: 0,
            };
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
        this.startEmailTimer();

        this.reconnectAttempts = 0;
        this.kLoss = 0.01;
    }

    // ==================== NEW: CIRCULAR BUFFER MANAGEMENT ====================
    
    /**
     * Add entry to extended circular buffer
     * Maintains 5000 most recent entries efficiently
     */
    addToExtendedBuffer(asset, value) {
        const buffer = this.extendedArrayBuffers[asset];
        buffer.buffer[buffer.head] = value;
        buffer.head = (buffer.head + 1) % this.config.extendedArraySize;
        if (buffer.size < this.config.extendedArraySize) {
            buffer.size++;
        }
    }

    /**
     * Get entries from circular buffer in chronological order
     */
    getBufferEntries(asset, count = null) {
        const buffer = this.extendedArrayBuffers[asset];
        
        // If buffer is empty or has no data, return empty array
        if (!buffer || buffer.size === 0) {
            return [];
        }
        
        const entries = [];
        const actualCount = count || buffer.size;
        
        for (let i = 0; i < Math.min(actualCount, buffer.size); i++) {
            const index = (buffer.head - 1 - i + this.config.extendedArraySize) % this.config.extendedArraySize;
            const value = buffer.buffer[index];
            if (value !== null && value !== undefined) {
                entries.unshift(value);
            }
        }
        
        return entries;
    }

    // ==================== NEW: ADVANCED STATISTICAL ANALYSIS ====================
    
    /**
     * Calculate moving averages for pattern detection
     */
    calculateMovingAverages(asset) {
        const entries = this.getBufferEntries(asset, 100);
        if (entries.length < 20) return;

        const ma20 = entries.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const ma50 = entries.length >= 50 
            ? entries.slice(-50).reduce((a, b) => a + b, 0) / 50 
            : ma20;
        const ma100 = entries.length >= 100 
            ? entries.reduce((a, b) => a + b, 0) / 100 
            : ma50;

        this.statisticalAnalysis.movingAverages[asset] = { ma20, ma50, ma100 };
    }

    /**
     * Calculate volatility measures
     */
    calculateVolatilityMeasures(asset) {
        const entries = this.getBufferEntries(asset, 100);
        if (entries.length < 20) {
            this.statisticalAnalysis.volatilityMeasures[asset] = { std: 0, range: 0 };
            return { std: 0, range: 0 };
        }

        const mean = entries.reduce((a, b) => a + b, 0) / entries.length;
        const variance = entries.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / entries.length;
        const std = Math.sqrt(variance);
        const range = Math.max(...entries) - Math.min(...entries);

        this.statisticalAnalysis.volatilityMeasures[asset] = { std, range };
        return { std, range };
    }

    /**
     * Calculate reset probability based on historical patterns
     */
    calculateResetProbability(asset, currentTicks) {
        const entries = this.getBufferEntries(asset, 500);
        if (entries.length < 50) return 0.5;

        // Count how many times price stayed in range for similar durations
        const similarDurations = entries.filter(val => Math.abs(val - currentTicks) <= 5);
        const resetCount = entries.filter(val => val < 10).length; // Early resets

        const probability = 1 - (similarDurations.length / entries.length);
        this.statisticalAnalysis.resetProbabilities[asset] = probability;
        
        return probability;
    }

    /**
     * Detect market trend using weighted analysis
     */
    detectTrend(asset) {
        const entries = this.getBufferEntries(asset, 200);
        if (entries.length < 50) return { trend: 'neutral', strength: 0 };

        // Recent data gets more weight (70%)
        const recentEntries = entries.slice(-Math.floor(entries.length * 0.3));
        const olderEntries = entries.slice(0, -Math.floor(entries.length * 0.3));

        const recentAvg = recentEntries.reduce((a, b) => a + b, 0) / recentEntries.length;
        const olderAvg = olderEntries.reduce((a, b) => a + b, 0) / olderEntries.length;

        const difference = recentAvg - olderAvg;
        const strength = Math.abs(difference) / olderAvg;

        let trend = 'neutral';
        if (difference > 2) trend = 'increasing';
        else if (difference < -2) trend = 'decreasing';

        this.statisticalAnalysis.trendIndicators[asset] = { trend, strength };
        return { trend, strength };
    }

    // ==================== NEW: MULTI-LAYERED SAFETY CHECKS ====================
    
    /**
     * Comprehensive confidence calculation
     */
    calculateTradeConfidence(asset, digitCount, stayedInArray) {
        const entries = this.getBufferEntries(asset, 1000);
        if (entries.length < 100) return 0;

        // Factor 1: Historical success rate at this digit count (30% weight)
        const similarCounts = entries.filter(val => Math.abs(val - digitCount) <= 2);
        const successRate = similarCounts.length > 0 
            ? similarCounts.filter(val => val >= digitCount).length / similarCounts.length 
            : 0.5;

        // Factor 2: Volatility score (25% weight) - FIX: Actually calculate it
        const { std } = this.calculateVolatilityMeasures(asset);
        const optimalStd = 5;
        const volatilityScore = std > 0 
            ? 1 - Math.min(Math.abs(std - optimalStd) / optimalStd, 1) 
            : 0;

        // Factor 3: Trend alignment (20% weight)
        const { trend, strength } = this.detectTrend(asset);
        const trendScore = trend === 'neutral' ? 0.8 : (1 - strength);

        // Factor 4: Reset probability (25% weight)
        const resetProb = this.calculateResetProbability(asset, digitCount);
        const resetScore = 1 - resetProb;

        // Calculate weighted confidence
        const confidence = (
            successRate * 0.30 +
            volatilityScore * 0.25 +
            trendScore * 0.20 +
            resetScore * 0.25
        );

        console.log(`[${asset}] Confidence Analysis:`);
        console.log(`  Success Rate: ${(successRate * 100).toFixed(1)}% (30% weight)`);
        console.log(`  Volatility Score: ${(volatilityScore * 100).toFixed(1)}% (25% weight) [StdDev: ${std.toFixed(2)}]`);
        console.log(`  Trend Score: ${(trendScore * 100).toFixed(1)}% (20% weight)`);
        console.log(`  Reset Score: ${(resetScore * 100).toFixed(1)}% (25% weight)`);
        console.log(`  TOTAL CONFIDENCE: ${(confidence * 100).toFixed(1)}%`);

        return confidence;
    }

    /**
     * Calculate risk/reward ratio
     */
    calculateRiskRewardRatio(asset, digitCount) {
        const potentialReward = this.currentStake * Math.pow(1.05, digitCount);
        const risk = this.currentStake;
        const resetProb = this.calculateResetProbability(asset, digitCount);
        
        // Adjust reward by reset probability
        const expectedReward = potentialReward * (1 - resetProb);
        const ratio = expectedReward / risk;

        console.log(`[${asset}] Risk/Reward Analysis:`);
        console.log(`  Potential Reward: $${potentialReward.toFixed(2)}`);
        console.log(`  Risk: $${risk.toFixed(2)}`);
        console.log(`  Reset Probability: ${(resetProb * 100).toFixed(1)}%`);
        console.log(`  Expected Reward: $${expectedReward.toFixed(2)}`);
        console.log(`  Risk/Reward Ratio: ${ratio.toFixed(2)}:1`);

        return ratio;
    }

    /**
     * Check market stability
     */
    checkMarketStability(asset) {
        const { std, range } = this.statisticalAnalysis.volatilityMeasures[asset];
        const entries = this.getBufferEntries(asset, 50);
        
        if (entries.length < 20) return false;

        // Calculate recent volatility
        const recentEntries = entries.slice(-20);
        const changes = recentEntries.slice(1).map((val, i) => Math.abs(val - recentEntries[i]));
        const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;

        // Stable if average change is low and std deviation is reasonable
        const isStable = avgChange < 3.5 && std < 8 && range < 30;

        console.log(`[${asset}] Stability Check:`);
        console.log(`  Avg Change: ${avgChange.toFixed(2)}`);
        console.log(`  Std Dev: ${std.toFixed(2)}`);
        console.log(`  Range: ${range.toFixed(2)}`);
        console.log(`  Is Stable: ${isStable ? '✓' : '✗'}`);

        return isStable;
    }

    /**
     * Check for dangerous patterns
     */
    checkDangerousPatterns(asset, digitCount, stayedInArray) {
        const recentLosses = this.learningSystem.failedPatterns[asset] || [];
        
        // Check if similar pattern failed recently
        const similarFailures = recentLosses.slice(-10).filter(pattern => 
            Math.abs(pattern.digitCount - digitCount) <= 2
        );

        if (similarFailures.length >= 3) {
            console.log(`[${asset}] ⚠️ Dangerous Pattern Detected: ${similarFailures.length} similar recent failures`);
            return true;
        }

        // Check for rapid reset pattern
        const entries = this.getBufferEntries(asset, 20);
        const rapidResets = entries.filter(val => val < 5).length;
        
        if (rapidResets >= 10) {
            console.log(`[${asset}] ⚠️ Rapid Reset Pattern: ${rapidResets}/20 early resets`);
            return true;
        }

        return false;
    }

    /**
     * Master safety check - ALL must pass
     */
    performSafetyChecks(asset, digitCount, stayedInArray) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`SAFETY CHECKS FOR ${asset} - Digit Count: ${digitCount}`);
        console.log('='.repeat(60));

        const checks = {
            confidence: false,
            riskReward: false,
            stability: false,
            pattern: false,
        };

        // Check 1: Confidence threshold
        const confidence = this.calculateTradeConfidence(asset, digitCount, stayedInArray);
        checks.confidence = confidence >= this.config.minConfidenceThreshold;
        console.log(`\n✓ Confidence Check: ${checks.confidence ? 'PASS' : 'FAIL'} (${(confidence * 100).toFixed(1)}% vs ${(this.config.minConfidenceThreshold * 100)}% required)`);

        // Check 2: Risk/Reward ratio
        const riskReward = this.calculateRiskRewardRatio(asset, digitCount);
        checks.riskReward = riskReward >= this.config.minRiskRewardRatio;
        console.log(`\n✓ Risk/Reward Check: ${checks.riskReward ? 'PASS' : 'FAIL'} (${riskReward.toFixed(2)}:1 vs ${this.config.minRiskRewardRatio}:1 required)`);

        // Check 3: Market stability
        checks.stability = this.checkMarketStability(asset);
        console.log(`\n✓ Stability Check: ${checks.stability ? 'PASS' : 'FAIL'}`);

        // Check 4: Pattern safety
        checks.pattern = !this.checkDangerousPatterns(asset, digitCount, stayedInArray);
        console.log(`\n✓ Pattern Check: ${checks.pattern ? 'PASS' : 'FAIL'}`);

        const allPassed = Object.values(checks).every(check => check);
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`FINAL VERDICT: ${allPassed ? '✅ TRADE APPROVED' : '❌ TRADE REJECTED'}`);
        console.log(`${'='.repeat(60)}\n`);

        return allPassed;
    }

    // ==================== ORIGINAL METHODS WITH ENHANCEMENTS ====================

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
        // NEW: Dynamically adjust stake based on confidence
        const confidence = this.calculateTradeConfidence(asset, 10, []);
        const adjustedStake = this.currentStake * Math.max(0.5, confidence);

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
                this.digitCounts[asset] = Array(10).fill(0);
                this.predictedDigits[asset] = null;
                this.lastPredictions[asset] = [];
            });
            this.tickSubscriptionIds = {};
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
            // Successfully unsubscribed
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
        this.assets.forEach(asset => {
            this.subscribeToTickHistory(asset);
            this.subscribeToTicks(asset);
        });
    }

    handleTickHistory(asset, history) {
        this.tickHistories[asset] = history.prices.map(price => this.getLastDigit(price, asset));
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
        
        // NEW: Add actual tick digit to extended buffer for statistical analysis
        this.addToExtendedBuffer(asset, lastDigit);

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            return; 
        }

        if (!this.tradeInProgress) {
            this.analyzeTicks(asset);
        }
}

    calculateVolatility(asset) {
        const history = this.tickHistories[asset];
        if (history.length < 20) return 0;

        const recentHistory = history.slice(-50);
        let changes = 0;
        for (let i = 1; i < recentHistory.length; i++) {
            if (recentHistory[i] !== recentHistory[i-1]) changes++;
        }
        
        const volatility = changes / (recentHistory.length - 1);
        this.learningSystem.volatilityScores[asset] = volatility;
        return volatility;
    }

    isMarketConditionFavorable(asset) {
        const volatility = this.calculateVolatility(asset);
        const assetState = this.assetStates[asset];
        
        if (volatility > 0.90) return false;
        if (volatility < 0.31) return false;
        if (assetState.consecutiveLosses >= 2) return false;

        return true;
    }

    calculateAdaptiveFilter(asset, currentDigitCount) {
        const baseFilter = 8;
        const assetState = this.assetStates[asset];
        const lossHistory = this.learningSystem.lossPatterns[asset] || [];
        
        const recentLossesWithSameCount = lossHistory
            .slice(-10)
            .filter(loss => loss.digitCount === currentDigitCount)
            .length;

        let adjustedFilter = baseFilter;
        
        if (recentLossesWithSameCount >= 2) {
            adjustedFilter += recentLossesWithSameCount * 2;
        }

        const filterStats = this.learningSystem.filterPerformance[adjustedFilter] || { wins: 0, losses: 0 };
        const winRate = filterStats.wins + filterStats.losses > 0 
            ? filterStats.wins / (filterStats.wins + filterStats.losses) 
            : 0.5;

        if (winRate < 0.4 && filterStats.wins + filterStats.losses > 5) {
            adjustedFilter += 3;
        }

        return adjustedFilter;
    }

    selectBestAsset() {
        const candidates = [];
        
        for (const asset of this.assets) {
            if (this.suspendedAssets.has(asset)) continue;
            if (this.assetStates[asset].tradeInProgress) continue;
            if (!this.isMarketConditionFavorable(asset)) continue;

            const volatility = this.learningSystem.volatilityScores[asset] || 0;
            const assetState = this.assetStates[asset];
            const recentWinRate = this.calculateAssetWinRate(asset);
            
            const score = (
                recentWinRate * 50 +
                (0.5 - Math.abs(0.5 - volatility)) * 30 +
                (3 - assetState.consecutiveLosses) * 20
            );

            candidates.push({ asset, score });
        }

        if (candidates.length === 0) return null;

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0].asset;
    }

    calculateAssetWinRate(asset) {
        const lossHistory = this.learningSystem.lossPatterns[asset] || [];
        const recentTrades = lossHistory.slice(-10);
        
        if (recentTrades.length === 0) return 0.5;
        
        const wins = recentTrades.filter(t => t.result === 'win').length;
        return wins / recentTrades.length;
    }

    recordTradeOutcome(asset, won, digitCount, filterUsed, stayedInArray) {
        const outcome = {
            asset,
            result: won ? 'win' : 'loss',
            digitCount,
            filterUsed,
            arraySum: stayedInArray.reduce((a,b) => a+b, 0),
            timestamp: Date.now(),
            volatility: this.learningSystem.volatilityScores[asset],
        };

        if (!this.learningSystem.lossPatterns[asset]) {
            this.learningSystem.lossPatterns[asset] = [];
        }
        this.learningSystem.lossPatterns[asset].push(outcome);

        if (this.learningSystem.lossPatterns[asset].length > 50) {
            this.learningSystem.lossPatterns[asset].shift();
        }

        // NEW: Store successful/failed patterns separately
        if (won) {
            this.learningSystem.successfulPatterns[asset].push(outcome);
            if (this.learningSystem.successfulPatterns[asset].length > 100) {
                this.learningSystem.successfulPatterns[asset].shift();
            }
        } else {
            this.learningSystem.failedPatterns[asset].push(outcome);
            if (this.learningSystem.failedPatterns[asset].length > 100) {
                this.learningSystem.failedPatterns[asset].shift();
            }
        }

        if (!this.learningSystem.filterPerformance[filterUsed]) {
            this.learningSystem.filterPerformance[filterUsed] = { wins: 0, losses: 0 };
        }
        if (won) {
            this.learningSystem.filterPerformance[filterUsed].wins++;
        } else {
            this.learningSystem.filterPerformance[filterUsed].losses++;
        }

        if (!won) {
            const key = `${asset}_${digitCount}`;
            this.riskManager.consecutiveSameDigitLosses[key] = 
                (this.riskManager.consecutiveSameDigitLosses[key] || 0) + 1;
        } else {
            const key = `${asset}_${digitCount}`;
            this.riskManager.consecutiveSameDigitLosses[key] = 0;
        }
        
        // NEW: Update performance metrics
        this.updatePerformanceMetrics(asset, won, outcome);
    }

    // NEW: Update performance dashboard
    updatePerformanceMetrics(asset, won, outcome) {
        const metrics = this.performanceMetrics.assetPerformance[asset];
        metrics.trades++;
        
        if (won) {
            metrics.wins++;
        } else {
            metrics.losses++;
        }
        
        metrics.winRate = metrics.wins / metrics.trades;
        
        // Update hourly performance
        const hour = new Date().getHours();
        this.performanceMetrics.hourlyPerformance[hour].trades++;
        if (won) this.performanceMetrics.hourlyPerformance[hour].wins++;
    }

    selectAlternativeDigit(asset, currentDigitCount, filteredArray, stayedInArray) {
        const key = `${asset}_${currentDigitCount}`;
        const sameDigitLosses = this.riskManager.consecutiveSameDigitLosses[key] || 0;

        if (sameDigitLosses >= 2) {
            const alternatives = filteredArray.filter(d => d !== currentDigitCount);
            
            if (alternatives.length > 0) {
                let bestAlt = alternatives[0];
                let minLosses = 999;
                
                for (const alt of alternatives) {
                    const altKey = `${asset}_${alt}`;
                    const altLosses = this.riskManager.consecutiveSameDigitLosses[altKey] || 0;
                    if (altLosses < minLosses) {
                        minLosses = altLosses;
                        bestAlt = alt;
                    }
                }
                
                return bestAlt;
            }
        }

        return currentDigitCount;
    }

    handleProposal(response) {
        if (response.error) {
            console.error('Proposal error:', response.error.message);
            return;
        }

        let asset = null;
        if (response.echo_req && response.echo_req.symbol) {
            asset = response.echo_req.symbol;
        }
        if (!asset && response.proposal && response.proposal.id) {
            asset = this.pendingProposals.get(response.proposal.id) || null;
        }
        if (!asset || !this.assets.includes(asset)) {
            return;
        }

        const assetState = this.assetStates[asset];

        if (response.proposal) {
            const stayedInArray = response.proposal.contract_details.ticks_stayed_in;
            assetState.stayedInArray = stayedInArray;
            
            // NEW: Perform statistical analysis on actual tick history
            this.calculateMovingAverages(asset);
            this.calculateVolatilityMeasures(asset);
            
            const currentDigitCount = assetState.stayedInArray[99] + 1;
            assetState.currentProposalId = response.proposal.id;
            
            this.pendingProposals.set(response.proposal.id, asset);

            const digitFrequency = {};
            assetState.stayedInArray.forEach(digit => {
                digitFrequency[digit] = (digitFrequency[digit] || 0) + 1;
            });
            assetState.digitFrequency = digitFrequency;

            const adaptiveFilter = this.calculateAdaptiveFilter(asset, currentDigitCount);
            
            const appearedOnceArray = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === adaptiveFilter)
                .map(Number);
            
            if (!assetState.tradeInProgress) {
                if (appearedOnceArray.includes(currentDigitCount) && assetState.stayedInArray[99] >= 0) {
                    const selectedDigit = this.selectAlternativeDigit(
                        asset, 
                        currentDigitCount, 
                        appearedOnceArray,
                        stayedInArray
                    );
                    
                    if (selectedDigit !== currentDigitCount) {
                        return;
                    }

                    const safetyChecksPassed = this.performSafetyChecks(
                        asset, 
                        currentDigitCount, 
                        stayedInArray
                    );
                    
                    if (!safetyChecksPassed) {
                        console.log(`[${asset}] ❌ Safety checks failed. Skipping trade.`);
                        return;
                    }

                    assetState.tradedDigitArray.push(currentDigitCount);
                    assetState.filteredArray = appearedOnceArray;
                    assetState.lastFilterUsed = adaptiveFilter;
                    
                    this.placeTrade(asset);
                }
            }
        }
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
        
        console.log(`[${asset}] Trade outcome: ${won ? '✅ WON' : '❌ LOST'} | Profit: ${profit.toFixed(2)}`);

        const digitCount = assetState.tradedDigitArray[assetState.tradedDigitArray.length - 1];
        const filterUsed = assetState.lastFilterUsed || 8;
        this.recordTradeOutcome(asset, won, digitCount, filterUsed, assetState.stayedInArray);

        this.totalTrades++;
        
        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
            
            if (assetState) {
                assetState.consecutiveLosses = 0;
            }
            
            this.learningSystem.adaptiveFilters[asset] = 8;
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
            
            const recentWinRate = this.calculateAssetWinRate(asset);
            let multiplierAdjustment = 1.0;
            
            if (recentWinRate > 0.6) {
                multiplierAdjustment = 1.0;
            } else if (recentWinRate < 0.4) {
                multiplierAdjustment = 1.0;
            }

            this.currentStake = Math.ceil(
                this.currentStake * this.config.multiplier * multiplierAdjustment * 100
            ) / 100;
        }

        this.totalProfitLoss += profit;
        this.Pause = true;

        let baseWaitTime = this.config.minWaitTime;
        
        if (!won) {
            baseWaitTime = this.config.minWaitTime + (this.consecutiveLosses * 60000);
            this.sendLossEmail(asset);
            this.suspendAllExcept(asset);
        } else {
            if (this.suspendedAssets.size > 0) {
                this.reactivateAllSuspended();
            }
        }

        const randomWaitTime = Math.floor(
            Math.random() * (this.config.maxWaitTime - baseWaitTime + 1)
        ) + baseWaitTime;
        
        const waitTimeMinutes = Math.round(randomWaitTime / 60000);
        this.waitTime = waitTimeMinutes;
        this.waitSeconds = randomWaitTime;

        if(!this.endOfDay) {
            this.logTradingSummary(asset);
        }
        
        const riskLimitReached = this.totalProfitLoss <= -this.riskManager.maxDailyLoss;
        
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || 
            this.totalProfitLoss <= -this.config.stopLoss ||
            riskLimitReached) {
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

        this.disconnect();

        if (!this.endOfDay) {
            setTimeout(() => {
                this.tradeInProgress = false;
                this.Pause = false;
                this.connect();
            }, randomWaitTime);
        }
    }

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

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            if (this.endOfDay && currentHours === 7 && currentMinutes >= 0) {
                console.log("It's 7:00 AM GMT+1, reconnecting the bot.");
                this.LossDigitsList = [];
                this.tradeInProgress = false;
                this.usedAssets = new Set();
                this.RestartTrading = true;
                this.Pause = false;
                this.endOfDay = false;
                this.tradedDigitArray = [];
                this.tradedDigitArray2 = [];
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    logTradingSummary(asset) {
        console.log('\n' + '='.repeat(70));
        console.log('TRADING SUMMARY');
        console.log('='.repeat(70));
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Wins: ${this.totalWins} | Total Losses: ${this.totalLosses}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`x2 Losses: ${this.consecutiveLosses2} | x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`Total P/L: ${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Current Stake: ${this.currentStake.toFixed(2)}`);
        console.log(`\n[${asset}] Asset Performance:`);
        console.log(`  Win Rate: ${(this.calculateAssetWinRate(asset) * 100).toFixed(1)}%`);
        console.log(`  Volatility: ${(this.learningSystem.volatilityScores[asset] * 100).toFixed(1)}%`);
        
        // NEW: Extended buffer stats
        const bufferSize = this.extendedArrayBuffers[asset].size;
        console.log(`  Extended Buffer Size: ${bufferSize}/5000 entries`);
        
        // NEW: Statistical analysis summary
        const ma = this.statisticalAnalysis.movingAverages[asset];
        console.log(`  Moving Averages: MA20=${ma.ma20.toFixed(1)}, MA50=${ma.ma50.toFixed(1)}`);
        
        const vol = this.statisticalAnalysis.volatilityMeasures[asset];
        console.log(`  Volatility Measures: StdDev=${vol.std.toFixed(2)}, Range=${vol.range.toFixed(1)}`);
        
        console.log(`\nSuspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log(`Wait Time: ${this.waitTime} minutes`);
        console.log('='.repeat(70) + '\n');
    }
    
    startEmailTimer() {
        if (!this.endOfDay) {
            setInterval(() => {
                this.sendEmailSummary();
            }, 1800000);
        }
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const totalFilterStats = Object.entries(this.learningSystem.filterPerformance)
            .map(([filter, stats]) => {
                const total = stats.wins + stats.losses;
                const winRate = total > 0 ? (stats.wins / total * 100).toFixed(1) : 0;
                return `Filter ${filter}: ${winRate}% (${stats.wins}W/${stats.losses}L)`;
            })
            .join('\n        ');
        
        // NEW: Enhanced performance summary
        const bufferSummary = this.assets.map(a => 
            `${a}: ${this.extendedArrayBuffers[a].size}/5000 entries`
        ).join('\n        ');

        const summaryText = `
        ==================== Enhanced Bot V2.0 Summary ====================
        Total Trades: ${this.totalTrades}
        Total Wins: ${this.totalWins}
        Total Losses: ${this.totalLosses}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        
        Consecutive Losses: ${this.consecutiveLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}

        Financial:
        Current Stake: ${this.currentStake.toFixed(2)}
        Total P/L: ${this.totalProfitLoss.toFixed(2)}
        
        Extended Buffer Status:
        ${bufferSummary}
        
        Learning System Performance:
        ${totalFilterStats || 'No filter data yet'}
        
        Asset Volatility & Statistics:
        ${this.assets.map(a => {
            const ma = this.statisticalAnalysis.movingAverages[a];
            const vol = this.statisticalAnalysis.volatilityMeasures[a];
            return `${a}: Vol=${(this.learningSystem.volatilityScores[a] * 100 || 0).toFixed(1)}%, MA20=${ma.ma20.toFixed(1)}, StdDev=${vol.std.toFixed(2)}`;
        }).join('\n        ')}
        
        Safety Check Configuration:
        Min Confidence: ${(this.config.minConfidenceThreshold * 100)}%
        Min Risk/Reward: ${this.config.minRiskRewardRatio}:1
        ===================================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Enhanced Accumulator Bot V2.0 - Performance Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending email:', error);
        }
    }

    async sendLossEmail(asset) {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const history = this.tickHistories[asset];
        const lastFewTicks = history.slice(-10);
        const assetState = this.assetStates[asset];

        const recentLosses = this.learningSystem.lossPatterns[asset]?.slice(-5) || [];
        const lossAnalysis = recentLosses.map(l => 
            `Digit: ${l.digitCount}, Filter: ${l.filterUsed}, Vol: ${(l.volatility * 100).toFixed(1)}%`
        ).join('\n        ');
        
        // NEW: Statistical context
        const ma = this.statisticalAnalysis.movingAverages[asset];
        const vol = this.statisticalAnalysis.volatilityMeasures[asset];
        const trend = this.statisticalAnalysis.trendIndicators[asset];

        const summaryText = `
        ==================== Loss Alert - Enhanced Analysis ====================
        Trade Summary:
        Total Trades: ${this.totalTrades}
        Wins: ${this.totalWins} | Losses: ${this.totalLosses}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        
        Consecutive Losses: ${this.consecutiveLosses}
        x2: ${this.consecutiveLosses2} | x3: ${this.consecutiveLosses3}

        Loss Analysis for [${asset}]:
        Filtered Array: ${assetState.filteredArray}
        Traded Digit: ${assetState.tradedDigitArray.slice(-1)[0]}
        Filter Used: ${assetState.lastFilterUsed || 8}
        
        Statistical Context:
        Asset Volatility: ${(this.learningSystem.volatilityScores[asset] * 100 || 0).toFixed(1)}%
        Moving Averages: MA20=${ma.ma20.toFixed(1)}, MA50=${ma.ma50.toFixed(1)}
        Std Deviation: ${vol.std.toFixed(2)}
        Trend: ${trend.trend} (strength: ${trend.strength.toFixed(2)})
        Asset Win Rate: ${(this.calculateAssetWinRate(asset) * 100).toFixed(1)}%
        Buffer Size: ${this.extendedArrayBuffers[asset].size}/5000
        
        Recent Loss Pattern:
        ${lossAnalysis || 'No pattern data'}
        
        Last 10 Digits: ${lastFewTicks.join(', ')}

        Financial:
        Total P/L: ${this.totalProfitLoss.toFixed(2)}
        Current Stake: ${this.currentStake.toFixed(2)}
        
        Next Action:
        Waiting: ${this.waitTime} minutes before next trade
        ========================================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: `Enhanced Bot V2.0 - Loss Alert [${asset}]`,
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

        const totalFilterStats = Object.entries(this.learningSystem.filterPerformance)
            .map(([filter, stats]) => {
                const total = stats.wins + stats.losses;
                const winRate = total > 0 ? (stats.wins / total * 100).toFixed(1) : 0;
                return `Filter ${filter}: ${winRate}% (${stats.wins}W/${stats.losses}L)`;
            })
            .join('\n        ');

        const now = new Date();
        const currentHours = now.getHours();
        const currentMinutes = now.getMinutes();

        const summaryText = `
        Disconnect/Reconnect Email: Time (${currentHours}:${currentMinutes})

        ==================== Enhanced Bot V2.0 Daily Summary ====================
        Total Trades: ${this.totalTrades}
        Total Wins: ${this.totalWins}
        Total Losses: ${this.totalLosses}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        
        Consecutive Losses: ${this.consecutiveLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}

        Financial:
        Current Stake: ${this.currentStake.toFixed(2)}
        Total P/L: ${this.totalProfitLoss.toFixed(2)}
        
        Learning System Performance:
        ${totalFilterStats || 'No filter data yet'}
        
        Asset Performance:
        ${this.assets.map(a => `${a}: ${(this.learningSystem.volatilityScores[a] * 100 || 0).toFixed(1)}% vol, ${this.extendedArrayBuffers[a].size} buffer entries`).join('\n        ')}
        =========================================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Enhanced Bot V2.0 - Daily Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending email:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Enhanced Bot V2.0 - Error Report',
            text: `An error occurred: ${errorMessage}`
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending error email:', error);
        }
    }

    start() {
        console.log('\n' + '='.repeat(70));
        console.log('🚀 ENHANCED DERIV ACCUMULATOR TRADING BOT V2.0');
        console.log('='.repeat(70));
        console.log('Features:');
        console.log('  ✓ Extended 5000-entry circular buffer analysis');
        console.log('  ✓ Advanced statistical pattern recognition');
        console.log('  ✓ Multi-layered safety checks (4 layers)');
        console.log('  ✓ Dynamic trade sizing');
        console.log('  ✓ Comprehensive performance monitoring');
        console.log('  ✓ Moving averages & volatility analysis');
        console.log('  ✓ Reset probability modeling');
        console.log('='.repeat(70));
        console.log('\nSafety Configuration:');
        console.log(`  Min Confidence Threshold: ${(this.config.minConfidenceThreshold * 100)}%`);
        console.log(`  Min Risk/Reward Ratio: ${this.config.minRiskRewardRatio}:1`);
        console.log(`  Extended Buffer Size: ${this.config.extendedArraySize} entries`);
        console.log('='.repeat(70) + '\n');
        
        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}


// ==================== USAGE & CONFIGURATION ====================

const bot = new EnhancedDigitDifferTradingBot('DMylfkyce6VyZt7', {
    // API tokens: 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir', 'hsj0tA0XJoIzJG5', 'rgNedekYXvCaPeP'
    
    // Basic trading parameters
    initialStake: 1,
    multiplier: 21,
    maxConsecutiveLosses: 3,
    stopLoss: 400,
    takeProfit: 500,
    
    // Accumulator specific
    growthRate: 0.05,  // 5% growth rate
    accuTakeProfit: 0.5,
    
    // History and analysis
    requiredHistoryLength: 1000,
    extendedArraySize: 5000,  // NEW: Extended buffer size
    
    // NEW: Safety thresholds
    minConfidenceThreshold: 0.65,  // 65% confidence required to trade
    minRiskRewardRatio: 1.5,       // Minimum 1.5:1 risk/reward
    recentDataWeight: 0.7,         // 70% weight to recent data
    
    // Timing
    winProbabilityThreshold: 100,
    minWaitTime: 2000,     // 2 seconds for testing
    maxWaitTime: 5000,     // 5 seconds for testing
    // Production values:
    // minWaitTime: 300000,    // 5 minutes
    // maxWaitTime: 2600000,   // ~43 minutes
    
    minOccurrencesThreshold: 1,
});

bot.start();
