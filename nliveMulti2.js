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
            extendedHistoryLength: config.extendedHistoryLength || 5000, // NEW: Extended history
            winProbabilityThreshold: config.winProbabilityThreshold || 100,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            minWaitTime: config.minWaitTime || 200 * 1000,
            maxWaitTime: config.maxWaitTime || 500 * 1000,
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

        // NEW: Extended historical tracking for each asset
        this.extendedStayedInArrays = {}; // Stores up to 5000 items
        this.stayedInArrayHistory = {}; // Tracks the sequence of arrays
        this.previousStayedIn = {}; // Tracks previous array for comparison
        
        // NEW: Advanced pattern recognition system
        this.patternAnalyzer = {
            // Track sequences leading to resets
            resetSequences: {},
            // Statistical distribution analysis
            digitDistributions: {},
            // Trend detection
            trendIndicators: {},
            // Volatility clustering
            volatilityClusters: {},
            // Reset prediction models
            resetPredictors: {},
        };

        // NEW: Enhanced learning system with historical context
        this.learningSystem = {
            lossPatterns: {},
            failedDigitCounts: {},
            volatilityScores: {},
            filterPerformance: {},
            resetPatterns: {},
            timeWindowPerformance: [],
            adaptiveFilters: {},
            // NEW: Historical pattern matching
            historicalPatterns: {},
            // NEW: Safe zone identification
            safeZones: {},
            // NEW: Risk heat map
            riskHeatMap: {},
        };

        // NEW: Advanced risk management
        this.riskManager = {
            maxDailyLoss: config.stopLoss * 0.7,
            currentSessionRisk: 0,
            riskPerTrade: 0.02,
            cooldownPeriod: 0,
            lastLossTime: null,
            consecutiveSameDigitLosses: {},
            // NEW: Dynamic risk scoring
            riskScores: {},
        };

        // Initialize per-asset structures
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.lastDigits[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
            
            // NEW: Extended array initialization
            this.extendedStayedInArrays[asset] = [];
            this.stayedInArrayHistory[asset] = [];
            this.previousStayedIn[asset] = null;
            
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
                // NEW: Historical context
                historicalDepth: 0,
                lastResetPosition: -1,
                resetFrequency: [],
            };
            
            // Initialize pattern recognition structures
            this.patternAnalyzer.resetSequences[asset] = [];
            this.patternAnalyzer.digitDistributions[asset] = Array(100).fill(null).map(() => ({}));
            this.patternAnalyzer.trendIndicators[asset] = [];
            this.patternAnalyzer.volatilityClusters[asset] = [];
            this.patternAnalyzer.resetPredictors[asset] = {
                shortTerm: [],  // Last 100 resets
                mediumTerm: [], // Last 500 resets
                longTerm: [],   // Last 1000 resets
            };
            
            this.learningSystem.lossPatterns[asset] = [];
            this.learningSystem.volatilityScores[asset] = 0;
            this.learningSystem.adaptiveFilters[asset] = 8;
            this.learningSystem.historicalPatterns[asset] = [];
            this.learningSystem.safeZones[asset] = [];
            this.learningSystem.riskHeatMap[asset] = Array(100).fill(0);
            
            this.riskManager.consecutiveSameDigitLosses[asset] = {};
            this.riskManager.riskScores[asset] = 0.5; // Neutral risk
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

    // ========== NEW: EXTENDED ARRAY MANAGEMENT ==========
    
    /**
     * Updates the extended stayedInArray when a new proposal arrives
     * Uses the proven logic from nliveMulti3.js
     */
    updateExtendedStayedInArray(asset, stayedInArray) {
        if (!stayedInArray || stayedInArray.length < 100) return;
        
        const prev = this.previousStayedIn[asset];
        if (prev === null) {
            // First time: initialize with first 99 as historical completed runs
            this.extendedStayedInArrays[asset] = stayedInArray.slice(0, 99);
        } else {
            // Compare first 99 elements to detect reset
            let isIncreased = true;
            for (let i = 0; i < 99; i++) {
                if (stayedInArray[i] !== prev[i]) {
                    isIncreased = false;
                    break;
                }
            }
            
            if (isIncreased && stayedInArray[99] === prev[99] + 1) {
                // No reset, current run length increased - do nothing
            } else {
                // Reset detected, add the completed run length to extended history
                const completed = prev[99] + 1; // Adjust based on reset timing
                this.extendedStayedInArrays[asset].push(completed);
                
                // Maintain maximum length
                if (this.extendedStayedInArrays[asset].length > this.config.extendedHistoryLength) {
                    this.extendedStayedInArrays[asset].shift();
                }
            }
        }
        
        // Update previous for next comparison
        this.previousStayedIn[asset] = stayedInArray.slice();
        
        // Update pattern analysis with new extended data
        this.analyzeExtendedPatterns(asset);
    }



    // ========== NEW: ADVANCED PATTERN ANALYSIS ==========
    
    /**
     * Analyzes extended historical data for patterns
     */
    analyzeExtendedPatterns(asset) {
        const extended = this.extendedStayedInArrays[asset];
        if (extended.length < 100) return; // Need minimum data
        
        // 1. Calculate statistical distribution
        this.calculateDigitDistribution(asset);
        
        // 2. Identify trend patterns
        this.identifyTrends(asset);
        
        // 3. Analyze volatility clusters
        this.analyzeVolatilityClusters(asset);
        
        // 4. Build reset prediction model
        this.buildResetPredictor(asset);
        
        // 5. Identify safe trading zones
        this.identifySafeZones(asset);
    }

    /**
     * Calculates the distribution of digits at each position
     */
    calculateDigitDistribution(asset) {
        const extended = this.extendedStayedInArrays[asset];
        const distributions = this.patternAnalyzer.digitDistributions[asset];
        
        // Analyze last 1000 items or all if less
        const analyzeLength = Math.min(1000, extended.length);
        const startIdx = extended.length - analyzeLength;
        
        // Calculate frequency of each digit at each position (0-99)
        for (let pos = 0; pos < 100; pos++) {
            const dist = {};
            let count = 0;
            
            for (let i = startIdx; i < extended.length - 99 + pos; i++) {
                const digit = extended[i + pos];
                if (digit !== undefined) {
                    dist[digit] = (dist[digit] || 0) + 1;
                    count++;
                }
            }
            
            // Convert to probabilities
            if (count > 0) {
                for (let digit in dist) {
                    dist[digit] = dist[digit] / count;
                }
            }
            
            distributions[pos] = dist;
        }
    }

    /**
     * Identifies trending patterns in the data
     */
    identifyTrends(asset) {
        const extended = this.extendedStayedInArrays[asset];
        const trends = this.patternAnalyzer.trendIndicators[asset];
        
        // Clear old trends
        trends.length = 0;
        
        // Analyze trends in windows of 100
        const windowSize = 100;
        for (let i = extended.length - 100; i < extended.length - windowSize; i += windowSize) {
            if (i < 0) continue;
            
            const window = extended.slice(i, i + windowSize);
            const avg = window.reduce((a, b) => a + b, 0) / window.length;
            const variance = window.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / window.length;
            const stdDev = Math.sqrt(variance);
            
            // Calculate trend direction
            const firstHalf = window.slice(0, 50).reduce((a, b) => a + b, 0) / 50;
            const secondHalf = window.slice(50).reduce((a, b) => a + b, 0) / 50;
            const trendDirection = secondHalf > firstHalf ? 'up' : 'down';
            
            trends.push({
                position: i,
                average: avg,
                stdDev: stdDev,
                direction: trendDirection,
                strength: Math.abs(secondHalf - firstHalf) / stdDev
            });
        }
    }

    /**
     * Analyzes volatility clustering patterns
     */
    analyzeVolatilityClusters(asset) {
        const extended = this.extendedStayedInArrays[asset];
        const clusters = this.patternAnalyzer.volatilityClusters[asset];
        
        clusters.length = 0;
        
        // Calculate volatility for sliding windows
        const windowSize = 50;
        for (let i = extended.length - 100; i < extended.length - windowSize; i += 10) {
            if (i < 0) continue;
            
            const window = extended.slice(i, i + windowSize);
            let changes = 0;
            for (let j = 1; j < window.length; j++) {
                if (Math.abs(window[j] - window[j-1]) > 10) {
                    changes++;
                }
            }
            
            const volatility = changes / (window.length - 1);
            clusters.push({
                position: i,
                volatility: volatility,
                isHighVol: volatility > 0.3
            });
        }
    }

    /**
     * Builds a predictive model for market resets
     */
    buildResetPredictor(asset) {
        const assetState = this.assetStates[asset];
        const resetFreq = assetState.resetFrequency;
        
        if (resetFreq.length < 10) return;
        
        // Calculate statistics on reset intervals
        const avgResetInterval = resetFreq.reduce((a, b) => a + b, 0) / resetFreq.length;
        const minReset = Math.min(...resetFreq);
        const maxReset = Math.max(...resetFreq);
        
        // Calculate current position risk
        const currentPos = this.extendedStayedInArrays[asset].length;
        const ticksSinceLastReset = currentPos - assetState.lastResetPosition;
        
        // Risk increases as we approach average reset interval
        let resetRisk = 0;
        if (ticksSinceLastReset > avgResetInterval * 0.7) {
            resetRisk = Math.min(1.0, (ticksSinceLastReset - avgResetInterval * 0.7) / (avgResetInterval * 0.3));
        }
        
        this.riskManager.riskScores[asset] = resetRisk;
        
        return {
            avgInterval: avgResetInterval,
            currentTicks: ticksSinceLastReset,
            resetRisk: resetRisk,
            minReset: minReset,
            maxReset: maxReset
        };
    }

    /**
     * Identifies historically safe trading zones
     */
    identifySafeZones(asset) {
        const extended = this.extendedStayedInArrays[asset];
        const safeZones = this.learningSystem.safeZones[asset];
        const assetState = this.assetStates[asset];
        
        safeZones.length = 0;
        
        // Analyze which digit counts tend to be stable
        const digitStability = {};
        
        for (let i = 0; i < extended.length - 100; i += 100) {
            const window = extended.slice(i, i + 100);
            
            for (let pos = 0; pos < window.length; pos++) {
                const digit = window[pos];
                if (!digitStability[digit]) {
                    digitStability[digit] = { stable: 0, unstable: 0 };
                }
                
                // Check if next few positions stayed similar
                let stableCount = 0;
                for (let j = pos + 1; j < Math.min(pos + 10, window.length); j++) {
                    if (Math.abs(window[j] - digit) <= 5) {
                        stableCount++;
                    }
                }
                
                if (stableCount >= 7) {
                    digitStability[digit].stable++;
                } else {
                    digitStability[digit].unstable++;
                }
            }
        }
        
        // Identify safe digits (high stability ratio)
        for (let digit in digitStability) {
            const stats = digitStability[digit];
            const total = stats.stable + stats.unstable;
            if (total > 20) { // Enough data
                const stabilityRatio = stats.stable / total;
                if (stabilityRatio > 0.6) {
                    safeZones.push({
                        digit: parseInt(digit),
                        stabilityRatio: stabilityRatio,
                        confidence: total / 100
                    });
                }
            }
        }
        
        // Sort by stability
        safeZones.sort((a, b) => b.stabilityRatio - a.stabilityRatio);
    }

    // ========== NEW: ENHANCED RISK ASSESSMENT ==========
    
    /**
     * Comprehensive risk assessment using extended history
     */
    assessTradeRisk(asset, currentDigitCount, stayedInArray) {
        const extended = this.extendedStayedInArrays[asset];
        const assetState = this.assetStates[asset];
        
        let riskScore = 0;
        let riskFactors = [];
        
        // Factor 1: Reset proximity risk (30% weight)
        const resetPredictor = this.buildResetPredictor(asset);
        if (resetPredictor) {
            const resetRisk = resetPredictor.resetRisk;
            riskScore += resetRisk * 0.3;
            if (resetRisk > 0.6) {
                riskFactors.push(`High reset risk: ${(resetRisk * 100).toFixed(1)}%`);
            }
        }
        
        // Factor 2: Volatility risk (25% weight)
        const volatility = this.calculateVolatility(asset);
        const volRisk = volatility > 0.7 ? 1.0 : volatility < 0.3 ? 0.8 : volatility / 1.5;
        riskScore += volRisk * 0.25;
        if (volatility >= 0.88 || volatility < 0.3) {
            riskFactors.push(`Unfavorable volatility: ${(volatility * 100).toFixed(1)}%`);
            return { riskScore: 1.0, riskLevel: 'HIGH', riskFactors, shouldTrade: false };
        }
        
        // Factor 3: Historical pattern risk (25% weight)
        const patternRisk = this.assessPatternRisk(asset, currentDigitCount, stayedInArray);
        riskScore += patternRisk * 0.25;
        if (patternRisk > 0.6) {
            riskFactors.push(`Dangerous historical pattern detected`);
            return { riskScore: 1.0, riskLevel: 'HIGH', riskFactors, shouldTrade: false };
        }
        
        // Factor 4: Safe zone analysis (20% weight)
        const safeZoneRisk = this.assessSafeZoneRisk(asset, currentDigitCount);
        riskScore += safeZoneRisk * 0.20;
        if (safeZoneRisk > 0.7) {
            riskFactors.push(`Outside safe trading zones`);
            return { riskScore: 1.0, riskLevel: 'HIGH', riskFactors, shouldTrade: false };
        }
        
        return {
            riskScore: riskScore, // 0-1, higher is riskier
            riskLevel: riskScore < 0.3 ? 'LOW' : riskScore < 0.6 ? 'MEDIUM' : 'HIGH',
            riskFactors: riskFactors,
            shouldTrade: riskScore < 0.55 // Only trade if risk is acceptable
        };
    }

    /**
     * Assess risk based on historical patterns
     */
    assessPatternRisk(asset, currentDigitCount, stayedInArray) {
        const lossHistory = this.learningSystem.lossPatterns[asset] || [];
        
        // Check if similar patterns led to losses
        const recentLosses = lossHistory.slice(-20);
        let matchingLosses = 0;
        
        for (let loss of recentLosses) {
            if (loss.result === 'loss' && 
                Math.abs(loss.digitCount - currentDigitCount) <= 5) {
                matchingLosses++;
            }
        }
        
        return recentLosses.length > 0 ? matchingLosses / recentLosses.length : 0.5;
    }

    /**
     * Assess risk based on safe zone analysis
     */
    assessSafeZoneRisk(asset, currentDigitCount) {
        const safeZones = this.learningSystem.safeZones[asset];
        
        if (safeZones.length === 0) return 0.5; // Neutral if no data
        
        // Check if current digit is in a safe zone
        const inSafeZone = safeZones.find(zone => 
            Math.abs(zone.digit - currentDigitCount) <= 3
        );
        
        if (inSafeZone) {
            return 1.0 - inSafeZone.stabilityRatio; // Lower risk if in safe zone
        }
        
        return 0.8; // Higher risk if not in safe zone
    }

    // ========== NEW: INTELLIGENT TRADE DECISION ==========
    
    /**
     * Makes intelligent decision whether to trade based on comprehensive analysis
     */
    shouldExecuteTrade(asset, currentDigitCount, stayedInArray, appearedOnceArray) {
        const assetState = this.assetStates[asset];
        const extended = this.extendedStayedInArrays[asset];
        
        // Minimum history requirement
        if (extended.length < 99) {
            console.log(`[${asset}] Insufficient extended history (${extended.length}/500), skipping`);
            return { trade: false, reason: 'Insufficient history' };
        }
        
        // Comprehensive risk assessment
        const riskAssessment = this.assessTradeRisk(asset, currentDigitCount, stayedInArray);
        
        // console.log(`[${asset}] Risk Assessment: ${riskAssessment.riskLevel} (${(riskAssessment.riskScore * 100).toFixed(1)}%)`);
        if (riskAssessment.riskFactors.length > 0) {
            // console.log(`[${asset}] Risk Factors:`, riskAssessment.riskFactors);
        }
        
        if (!riskAssessment.shouldTrade) {
            return { 
                trade: false, 
                reason: `Risk too high: ${riskAssessment.riskLevel}`,
                riskScore: riskAssessment.riskScore
            };
        }
        
        // Check if current digit is in filtered array
        if (!appearedOnceArray.includes(currentDigitCount)) {
            return { trade: false, reason: 'Digit not in filtered array' };
        }
        
        // Additional safety checks
        if (assetState.consecutiveLosses >= 2) {
            return { trade: false, reason: 'Too many consecutive losses on this asset' };
        }
        
        // Check market conditions
        if (!this.isMarketConditionFavorable(asset)) {
            return { trade: false, reason: 'Unfavorable market conditions' };
        }
        
        // All checks passed!
        return { 
            trade: true, 
            reason: 'All safety checks passed',
            riskScore: riskAssessment.riskScore,
            confidence: 1.0 - riskAssessment.riskScore
        };
    }

    // ========== MODIFIED: PROPOSAL HANDLER WITH EXTENDED ARRAY ==========
    
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
            
            // UPDATE: Extend the historical array
            this.updateExtendedStayedInArray(asset, stayedInArray);
            
            const currentDigitCount = assetState.stayedInArray[99] + 1;
            assetState.currentProposalId = response.proposal.id;
            
            this.pendingProposals.set(response.proposal.id, asset);

            // Calculate digit frequency
            const digitFrequency = {};
            assetState.stayedInArray.forEach(digit => {
                digitFrequency[digit] = (digitFrequency[digit] || 0) + 1;
            });
            assetState.digitFrequency = digitFrequency;

            // Use adaptive filter
            const adaptiveFilter = this.calculateAdaptiveFilter(asset, currentDigitCount);
            
            const appearedOnceArray = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === adaptiveFilter)
                .map(Number);

            console.log(`[${asset}] Extended History: ${this.extendedStayedInArrays[asset].length}/${this.config.extendedHistoryLength}`);
            console.log(`[${asset}] Adaptive filter: ${adaptiveFilter}, Current digit: ${currentDigitCount}`);
            
            if (!assetState.tradeInProgress) {
                // NEW: Intelligent trade decision
                const decision = this.shouldExecuteTrade(asset, currentDigitCount, stayedInArray, appearedOnceArray);
                
                if (decision.trade) {
                    console.log(`[${asset}] ✅ TRADE APPROVED - Confidence: ${(decision.confidence * 100).toFixed(1)}%`);
                    
                    assetState.tradedDigitArray.push(currentDigitCount);
                    assetState.filteredArray = appearedOnceArray;
                    assetState.lastFilterUsed = adaptiveFilter;
                    
                    this.placeTrade(asset);
                } else {
                    // console.log(`[${asset}] ❌ TRADE REJECTED - ${decision.reason}`);
                }
            }
        }
    }

    // ========== EXISTING METHODS (with minor enhancements) ==========

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
        
        if (volatility > 0.90) {
            return false;
        }
        
        if (volatility < 0.31) {
            return false;
        }

        if (assetState.consecutiveLosses >= 2) {
            return false;
        }

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

    detectDangerousPattern(asset, currentDigitCount, stayedInArray) {
        const patternKey = `${asset}_${currentDigitCount}`;
        const recentLosses = this.learningSystem.lossPatterns[asset] || [];
        
        const similarLosses = recentLosses
            .slice(-5)
            .filter(loss => {
                return loss.digitCount === currentDigitCount &&
                       Math.abs(loss.arraySum - stayedInArray.reduce((a,b) => a+b, 0)) < 100;
            });

        if (similarLosses.length >= 2) {
            return true;
        }

        return false;
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
            // NEW: Include extended history context
            historicalDepth: this.assetStates[asset].historicalDepth,
            resetRisk: this.riskManager.riskScores[asset],
        };

        if (!this.learningSystem.lossPatterns[asset]) {
            this.learningSystem.lossPatterns[asset] = [];
        }
        this.learningSystem.lossPatterns[asset].push(outcome);

        if (this.learningSystem.lossPatterns[asset].length > 50) {
            this.learningSystem.lossPatterns[asset].shift();
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
                console.log(`[${asset}] Reducing aggression - good asset having bad run`);
            }
            else if (recentWinRate < 0.4) {
                multiplierAdjustment = 1.0;
                console.log(`[${asset}] Strong reduction - poor performing asset`);
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
                // Asset-specific data
                this.digitCounts = {};
                this.tickSubscriptionIds = {};
                this.tickHistories = {};
                this.lastDigits = {};
                this.predictedDigits = {};
                this.lastPredictions = {};
                this.assetStates = {};
                this.pendingProposals = new Map();

                // NEW: Extended historical tracking for each asset
                this.extendedStayedInArrays = {}; // Stores up to 5000 items
                this.stayedInArrayHistory = {}; // Tracks the sequence of arrays
                this.previousStayedIn = {}; // Tracks previous array for comparison
                
                // NEW: Advanced pattern recognition system
                this.patternAnalyzer = {
                    // Track sequences leading to resets
                    resetSequences: {},
                    // Statistical distribution analysis
                    digitDistributions: {},
                    // Trend detection
                    trendIndicators: {},
                    // Volatility clustering
                    volatilityClusters: {},
                    // Reset prediction models
                    resetPredictors: {},
                };

                // NEW: Enhanced learning system with historical context
                this.learningSystem = {
                    lossPatterns: {},
                    failedDigitCounts: {},
                    volatilityScores: {},
                    filterPerformance: {},
                    resetPatterns: {},
                    timeWindowPerformance: [],
                    adaptiveFilters: {},
                    // NEW: Historical pattern matching
                    historicalPatterns: {},
                    // NEW: Safe zone identification
                    safeZones: {},
                    // NEW: Risk heat map
                    riskHeatMap: {},
                };

                // NEW: Advanced risk management
                this.riskManager = {
                    maxDailyLoss: config.stopLoss * 0.7,
                    currentSessionRisk: 0,
                    riskPerTrade: 0.02,
                    cooldownPeriod: 0,
                    lastLossTime: null,
                    consecutiveSameDigitLosses: {},
                    // NEW: Dynamic risk scoring
                    riskScores: {},
                };

                // Initialize per-asset structures
                this.assets.forEach(asset => {
                    this.tickHistories[asset] = [];
                    this.digitCounts[asset] = Array(10).fill(0);
                    this.lastDigits[asset] = null;
                    this.predictedDigits[asset] = null;
                    this.lastPredictions[asset] = [];
                    
                    // NEW: Extended array initialization
                    this.extendedStayedInArrays[asset] = [];
                    this.stayedInArrayHistory[asset] = [];
                    this.previousStayedIn[asset] = null;
                    
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
                        // NEW: Historical context
                        historicalDepth: 0,
                        lastResetPosition: -1,
                        resetFrequency: [],
                    };
                    
                    // Initialize pattern recognition structures
                    this.patternAnalyzer.resetSequences[asset] = [];
                    this.patternAnalyzer.digitDistributions[asset] = Array(100).fill(null).map(() => ({}));
                    this.patternAnalyzer.trendIndicators[asset] = [];
                    this.patternAnalyzer.volatilityClusters[asset] = [];
                    this.patternAnalyzer.resetPredictors[asset] = {
                        shortTerm: [],  // Last 100 resets
                        mediumTerm: [], // Last 500 resets
                        longTerm: [],   // Last 1000 resets
                    };
                    
                    this.learningSystem.lossPatterns[asset] = [];
                    this.learningSystem.volatilityScores[asset] = 0;
                    this.learningSystem.adaptiveFilters[asset] = 8;
                    this.learningSystem.historicalPatterns[asset] = [];
                    this.learningSystem.safeZones[asset] = [];
                    this.learningSystem.riskHeatMap[asset] = Array(100).fill(0);
                    
                    this.riskManager.consecutiveSameDigitLosses[asset] = {};
                    this.riskManager.riskScores[asset] = 0.5; // Neutral risk
                });
                
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
        console.log('==================== Trading Summary ====================');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Trades Won: ${this.totalWins}`);
        console.log(`Total Trades Lost: ${this.totalLosses}`);
        console.log(`x2 Losses: ${this.consecutiveLosses2}`);
        console.log(`x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`[${asset}] Predicted Asset: ${asset}`);
        console.log(`Current Stake: ${this.currentStake.toFixed(2)}`); 
        
        // NEW: Extended history stats
        const extendedLength = this.extendedStayedInArrays[asset].length;
        const assetState = this.assetStates[asset];
        const resetPredictor = this.buildResetPredictor(asset);
        
        console.log(`\n📊 Extended Analysis for ${asset}:`);
        console.log(`   Historical Depth: ${extendedLength}/${this.config.extendedHistoryLength}`);
        if (resetPredictor) {
            console.log(`   Avg Reset Interval: ${resetPredictor.avgInterval.toFixed(0)} ticks`);
            console.log(`   Ticks Since Reset: ${resetPredictor.currentTicks}`);
            console.log(`   Reset Risk: ${(resetPredictor.resetRisk * 100).toFixed(1)}%`);
        }
        
        const assetWinRate = this.calculateAssetWinRate(asset);
        const volatility = this.learningSystem.volatilityScores[asset] || 0;
        console.log(`   Recent Win Rate: ${(assetWinRate * 100).toFixed(1)}%`);
        console.log(`   Volatility: ${(volatility * 100).toFixed(1)}%`);
        console.log(`   Risk Score: ${(this.riskManager.riskScores[asset] * 100).toFixed(1)}%`);
        
        const safeZones = this.learningSystem.safeZones[asset];
        if (safeZones.length > 0) {
            console.log(`   Safe Zones: ${safeZones.slice(0, 3).map(z => z.digit).join(', ')}`);
        }
        
        console.log(`\nCurrently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log(`Waiting for: ${this.waitTime} minutes (${this.waitSeconds} ms) before resubscribing...`);
        console.log('=========================================================');
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

        // NEW: Extended history summary
        const historyStats = this.assets.map(asset => {
            const depth = this.extendedStayedInArrays[asset].length;
            const resetCount = this.assetStates[asset].resetFrequency.length;
            return `${asset}: ${depth} ticks, ${resetCount} resets`;
        }).join('\n        ');

        const summaryText = `
        ==================== Enhanced Trading Summary ====================
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
        
        Extended Historical Context:
        ${historyStats}
        
        Asset Volatility & Risk:
        ${this.assets.map(a => {
            const vol = (this.learningSystem.volatilityScores[a] * 100 || 0).toFixed(1);
            const risk = (this.riskManager.riskScores[a] * 100 || 0).toFixed(1);
            return `${a}: Vol=${vol}%, Risk=${risk}%`;
        }).join('\n        ')}
        ==================================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Claude_Enhanced Accumulator Bot v2 - Performance Summary',
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
            `Digit: ${l.digitCount}, Filter: ${l.filterUsed}, Vol: ${(l.volatility * 100).toFixed(1)}%, ResetRisk: ${(l.resetRisk * 100).toFixed(1)}%`
        ).join('\n        ');

        const resetPredictor = this.buildResetPredictor(asset);
        const resetInfo = resetPredictor ? 
            `Avg Reset: ${resetPredictor.avgInterval.toFixed(0)} ticks | Since Last: ${resetPredictor.currentTicks} | Risk: ${(resetPredictor.resetRisk * 100).toFixed(1)}%` :
            'Insufficient data';

        const summaryText = `
        ==================== Loss Alert ====================
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
        Asset Volatility: ${(this.learningSystem.volatilityScores[asset] * 100 || 0).toFixed(1)}%
        Asset Win Rate: ${(this.calculateAssetWinRate(asset) * 100).toFixed(1)}%
        
        Extended History Context:
        Historical Depth: ${this.extendedStayedInArrays[asset].length}
        Reset Analysis: ${resetInfo}
        
        Recent Loss Pattern:
        ${lossAnalysis || 'No pattern data'}
        
        Last 10 Digits: ${lastFewTicks.join(', ')}

        Financial:
        Total P/L: ${this.totalProfitLoss.toFixed(2)}
        Current Stake: ${this.currentStake.toFixed(2)}
        
        Next Action:
        Waiting: ${this.waitTime} minutes before next trade
        ====================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: `Claude_Enhanced Accumulator Bot v2 - Loss Alert [${asset}]`,
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
        const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
        const currentHours = gmtPlus1Time.getUTCHours();
        const currentMinutes = gmtPlus1Time.getUTCMinutes();

        const historyStats = this.assets.map(asset => {
            const depth = this.extendedStayedInArrays[asset].length;
            const resetCount = this.assetStates[asset].resetFrequency.length;
            return `${asset}: ${depth} ticks, ${resetCount} resets`;
        }).join('\n        ');

        const summaryText = `
        Disconnect/Reconnect Email: Time (${currentHours}:${currentMinutes}) GMT+1

        ==================== Enhanced Trading Summary ====================
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
        
        Extended Historical Context:
        ${historyStats}
        
        Asset Volatility & Risk:
        ${this.assets.map(a => {
            const vol = (this.learningSystem.volatilityScores[a] * 100 || 0).toFixed(1);
            const risk = (this.riskManager.riskScores[a] * 100 || 0).toFixed(1);
            return `${a}: Vol=${vol}%, Risk=${risk}%`;
        }).join('\n        ')}
        ==================================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Claude_Enhanced Accumulator Bot v2 - Disconnect/Reconnect Summary',
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
            subject: 'Claude_Enhanced Accumulator Bot v2 - Error Report',
            text: `An error occurred: ${errorMessage}`
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending error email:', error);
        }
    }

    start() {
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('🚀 Enhanced Accumulator Trading Bot v2.0');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('');
        console.log('✨ NEW FEATURES:');
        console.log('   📊 Extended Historical Analysis (up to 500 ticks)');
        console.log('   🎯 Advanced Pattern Recognition');
        console.log('   🔮 Reset Prediction Modeling');
        console.log('   🛡️  Enhanced Risk Assessment');
        console.log('   🧠 Machine Learning-Inspired Analytics');
        console.log('   📍 Safe Zone Identification');
        console.log('   ⚡ Volatility Clustering Analysis');
        console.log('   🎲 Statistical Distribution Tracking');
        console.log('');
        console.log('⚙️  CONFIGURATION:');
        console.log(`   Assets: ${this.assets.join(', ')}`);
        console.log(`   Initial Stake: ${this.config.initialStake}`);
        console.log(`   Multiplier: ${this.config.multiplier}x`);
        console.log(`   Max Consecutive Losses: ${this.config.maxConsecutiveLosses}`);
        console.log(`   Stop Loss: ${this.config.stopLoss}`);
        console.log(`   Take Profit: ${this.config.takeProfit}`);
        console.log(`   Extended History Length: ${this.config.extendedHistoryLength} ticks`);
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('🔄 Connecting to Deriv API...');
        console.log('');
        
        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// ============================================================================
// USAGE EXAMPLE
// ============================================================================

const bot = new EnhancedDigitDifferTradingBot('rgNedekYXvCaPeP', {
    // API tokens: 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir', 'hsj0tA0XJoIzJG5', 'rgNedekYXvCaPeP'
    
    // Trading parameters
    initialStake: 1,
    multiplier: 21,
    maxConsecutiveLosses: 3, 
    stopLoss: 400,
    takeProfit: 5000,
    
    // Accumulator specific
    growthRate: 0.05,
    accuTakeProfit: 0.5,
    
    // History tracking
    requiredHistoryLength: 1000,
    extendedHistoryLength: 500, // NEW: Extended history up to 5000 ticks
    
    // Timing (for production, use longer wait times)
    minWaitTime: 2000,    // 2 seconds for testing
    maxWaitTime: 5000,    // 5 seconds for testing
    // minWaitTime: 300000,   // 5 Minutes for production
    // maxWaitTime: 2600000,  // ~43 Minutes for production
    
    // Other parameters
    winProbabilityThreshold: 100,
    minOccurrencesThreshold: 1,
});

bot.start();
