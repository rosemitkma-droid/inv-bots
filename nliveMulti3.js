require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class EnhancedDigitDifferTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];

        this.config = {
            initialStake: config.initialStake || 10.5,
            multiplier: config.multiplier || 21,
            multiplier2: config.multiplier2 || 100,
            multiplier3: config.multiplier3 || 1000,
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
            survivalThreshold: 0.99, // Minimum estimated survival probability for next tick
            minSamplesForEstimate: 50, // Minimum historical samples for reliable hazard estimate
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
        this.extendedStayedIn = {}; // Extended historical run lengths (up to 5000)

        // NEW: Advanced analytics and learning system
        this.learningSystem = {
            lossPatterns: {},
            failedDigitCounts: {},
            volatilityScores: {},
            filterPerformance: {},
            resetPatterns: {},
            timeWindowPerformance: [],
            adaptiveFilters: {},
        };

        // NEW: Advanced risk management
        this.riskManager = {
            // maxDailyLoss: config.stopLoss * 0.7,
            currentSessionRisk: 0,
            riskPerTrade: 0.02,
            cooldownPeriod: 0,
            lastLossTime: null,
            consecutiveSameDigitLosses: {},
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

            // Initialize learning system for each asset
            this.learningSystem.lossPatterns[asset] = [];
            this.learningSystem.volatilityScores[asset] = 0;
            this.learningSystem.adaptiveFilters[asset] = 8;
            this.riskManager.consecutiveSameDigitLosses[asset] = {};
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
        // console.log(`Requested tick history for asset: ${asset}`);
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
            this.survivalNum = null;
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
                // console.log(`Subscribed to ticks for ${asset}. Subscription ID: ${this.tickSubscriptionIds[asset]}`);
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

    initializeSubscriptions() {
        console.log('Initializing subscriptions for all assets...');
        this.assets.forEach(asset => {
            this.subscribeToTickHistory(asset);
            this.subscribeToTicks(asset);
        });
    }

    handleTickHistory(asset, history) {
        this.tickHistories[asset] = history.prices.map(price => this.getLastDigit(price, asset));
        // console.log(`Received tick history for asset: ${asset}. Length: ${this.tickHistories[asset].length}`);
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

        // console.log(`[${asset}] ${tick.quote}: ${this.tickHistories[asset].slice(-5).join(', ')}`);

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            // console.log(`[${asset}] Waiting for more ticks. Current length: ${this.tickHistories[asset].length}`);
            return;
        }

        if (!this.tradeInProgress) {
            this.analyzeTicks(asset);
        }
    }


    // NEW: Calculate market volatility for an asset
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
        return volatility;
    }

    // NEW: Analyze if market conditions are favorable
    isMarketConditionFavorable(asset) {
        const volatility = this.calculateVolatility(asset);
        const assetState = this.assetStates[asset];

        // Too volatile - avoid trading
        if (volatility > 0.90) {
            // console.log(`[${asset}] Market too volatile (${volatility.toFixed(2)}), skipping`);
            return false;
        }

        // Too stable - hard to profit
        if (volatility < 0.31) {
            // console.log(`[${asset}] Market too stable (${volatility.toFixed(2)}), skipping`);
            return false;
        }

        // Check if we've lost too much on this asset recently
        if (assetState.consecutiveLosses >= 2) {
            // console.log(`[${asset}] Too many consecutive losses on this asset, skipping`);
            return false;
        }

        return true;
    }


    // NEW: Pattern detection - avoid trading if similar pattern led to loss
    // detectDangerousPattern(asset, currentDigitCount, stayedInArray) {
    //     const patternKey = `${asset}_${currentDigitCount}`;
    //     const recentLosses = this.learningSystem.lossPatterns[asset] || [];

    //     // Check if we've seen similar patterns fail recently
    //     const similarLosses = recentLosses
    //         .slice(-5)
    //         .filter(loss => {
    //             return loss.digitCount === currentDigitCount &&
    //                 Math.abs(loss.arraySum - stayedInArray.reduce((a, b) => a + b, 0)) < 100;
    //         });

    //     if (similarLosses.length >= 2) {
    //         // console.log(`[${asset}] Dangerous pattern detected: ${similarLosses.length} similar losses recently`);
    //         return true;
    //     }

    //     return false;
    // }

    // NEW: Calculate recent win rate for an asset
    calculateAssetWinRate(asset) {
        const lossHistory = this.learningSystem.lossPatterns[asset] || [];
        const recentTrades = lossHistory.slice(-10);

        if (recentTrades.length === 0) return 0.5; // Default

        const wins = recentTrades.filter(t => t.result === 'win').length;
        return wins / recentTrades.length;
    }

    // MODIFIED: Record outcome and update learning (keep but enhance)
    recordTradeOutcome(asset, won, digitCount, filterUsed, stayedInArray) {
        const outcome = {
            asset,
            result: won ? 'win' : 'loss',
            digitCount,
            filterUsed,
            arraySum: stayedInArray.reduce((a, b) => a + b, 0),
            timestamp: Date.now(),
            volatility: this.learningSystem.volatilityScores[asset],
        };

        if (!this.learningSystem.lossPatterns[asset]) {
            this.learningSystem.lossPatterns[asset] = [];
        }
        this.learningSystem.lossPatterns[asset].push(outcome);
        if (this.learningSystem.lossPatterns[asset].length > 100) {
            this.learningSystem.lossPatterns[asset].shift();
        }

        if (!this.learningSystem.filterPerformance[filterUsed]) {
            this.learningSystem.filterPerformance[filterUsed] = { wins: 0, losses: 0 };
        }
        if (won) {
            this.learningSystem.filterPerformance[filterUsed].wins++;
        } else {
            this.learningSystem.filterPerformance[filterUsed].losses++;
            // Dynamically adjust threshold if losing
            if (this.totalLosses % 3 === 0) {
                // this.config.survivalThreshold += 0.005; // Make stricter
                console.log(`Adjusted survival threshold to ${this.config.survivalThreshold} after losses`);
            }
        }

        if (!won) {
            const key = `${asset}_${digitCount}`;
            // this.riskManager.consecutiveSameDigitLosses[key] = (this.riskManager.consecutiveSameDigitLosses[key] || 0) + 1;
        } else {
            const key = `${asset}_${digitCount}`;
            // this.riskManager.consecutiveSameDigitLosses[key] = 0;
            // Relax threshold on wins
            // if (this.config.survivalThreshold > 0.98) {
            //     this.config.survivalThreshold -= 0.001;
            //     console.log(`Relaxed survival threshold to ${this.config.survivalThreshold} after win`);
            // }
        }
    }

    // MODIFIED: Enhanced proposal handler with learning integration and extended history
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
                this.extendedStayedIn[asset] = stayedInArray.slice(0, 99); // Initialize with first 99 as historical completed runs
            } else {
                let isIncreased = true;
                for (let i = 0; i < 99; i++) {
                    if (stayedInArray[i] !== prev[i]) {
                        isIncreased = false;
                        break;
                    }
                }
                if (isIncreased && stayedInArray[99] === prev[99] + 1) {
                    // No reset, current run length increased
                } else {
                    // Reset detected, add the completed run length to extended history
                    const completed = prev[99] + 1; // Adjust based on reset timing
                    this.extendedStayedIn[asset].push(completed);
                    if (this.extendedStayedIn[asset].length > 100) {
                        this.extendedStayedIn[asset].shift();
                    }
                }
            }
            this.previousStayedIn[asset] = stayedInArray.slice(); // Update previous

            assetState.currentProposalId = message.proposal.id;
            this.pendingProposals.set(message.proposal.id, asset);

            // Calculate digit frequency (keep for compatibility, but primary analysis is now probabilistic)
            const digitFrequency = {};
            stayedInArray.forEach(digit => {
                digitFrequency[digit] = (digitFrequency[digit] || 0) + 1;
            });
            assetState.digitFrequency = digitFrequency;

            // console.log(`[${asset}] Proposal received. Stayed-in array: [${stayedInArray.join(', ')}]`);
            // console.log(`[${asset}] Extended stayed-in history: ${this.extendedStayedIn[asset].join(', ')}, Length: ${this.extendedStayedIn[asset].length}`);
            // console.log(`[${asset}] Digit frequency: ${JSON.stringify(digitFrequency)}`);

            // console.log(`[${asset}] Survival probability (${this.survivalNum} vs ${this.config.survivalThreshold})`);

            // Check for market conditions and decide whether to trade
            if (!assetState.tradeInProgress) {
                // NEW: Use probabilistic survival estimate for trading decision
                if (this.shouldTradeBasedOnSurvivalProb(asset, stayedInArray) && this.survivalNum > this.config.survivalThreshold) {
                    console.log(`[${asset}] High survival probability (${this.survivalNum.toFixed(4)} > ${this.config.survivalThreshold}), placing trade`);
                    this.placeTrade(asset);
                }
            }
        }
    }

    // NEW: Method to decide trade based on estimated survival probability using extended history
    shouldTradeBasedOnSurvivalProb(asset, stayedInArray) {
        // Check market conditions first
        if (this.detectDangerousPattern(asset)) {
            console.log(`[${asset}] Skipping trade due to dangerous pattern`);
            return false;
        }
        if (!this.isMarketConditionFavorable(asset)) {
            // console.log(`[${asset}] Skipping trade due to market conditions`);
            return false;
        }

        const current_k = stayedInArray[99] + 1; // Keep original +1 adjustment for current count

        // Use extended history for frequency
        const history = this.extendedStayedIn[asset];
        if (history.length < this.config.minSamplesForEstimate) {
            // console.log(`[${asset}] Insufficient historical data (${history.length} < ${this.config.minSamplesForEstimate}), skipping`);
            return false;
        }

        const freq = {};
        history.forEach(l => {
            freq[l] = (freq[l] || 0) + 1;
        });

        let max_l = 0;
        if (Object.keys(freq).length > 0) {
            max_l = Math.max(...Object.keys(freq).map(Number));
        }

        const ge_counts = Array(max_l + 2).fill(0);
        for (let l = max_l; l >= 0; l--) {
            ge_counts[l] = (freq[l] || 0) + ge_counts[l + 1];
        }

        const ge_k = ge_counts[current_k - 1]; // Adjust for survival to next (since current_k is +1 adjusted)
        if (ge_k < this.config.minSamplesForEstimate) {
            // console.log(`[${asset}] Insufficient samples for current length (${ge_k} < ${this.config.minSamplesForEstimate}), skipping`);
            return false;
        }

        const num_end_at_k = freq[current_k - 1] || 0;
        const hazard = num_end_at_k / ge_k;
        const p_survive = 1 - hazard;

        // Record for learning
        this.learningSystem.resetPatterns[asset] = this.learningSystem.resetPatterns[asset] || [];
        this.learningSystem.resetPatterns[asset].push({ length: current_k, estimated_p: p_survive });

        console.log(`[${asset}] Estimated survival prob for next tick: ${p_survive.toFixed(4)} (samples: ${ge_k})`);

        // Trade if above threshold (high to minimize losses)
        if (p_survive > this.config.survivalThreshold) {
            // console.log(`[${asset}] High survival probability (${p_survive.toFixed(4)} > ${this.config.survivalThreshold}), placing trade`);
            this.survivalNum = p_survive;
            return true;
        }

        return false;
    }

    // MODIFIED: Integrate with new decision
    detectDangerousPattern(asset) {
        // Existing logic, but enhanced with extended history
        const history = this.extendedStayedIn[asset];
        // Example: Check for frequent short runs recently
        const recentShort = history.slice(-10).filter(l => l < 5).length;
        if (recentShort > 5) {
            return true;
        }
        return false;
    }

    analyzeTicks(asset) {
        if (this.tradeInProgress) return;
        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) return;
        if (this.suspendedAssets.has(asset)) return;

        // NEW: Check market conditions before requesting proposal
        if (!this.isMarketConditionFavorable(asset)) {
            console.log(`[${asset}] Skipping trade due to market conditions`);
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

        // NEW: Record outcome for learning
        const digitCount = assetState.stayedInArray[99] + 1; // Use for recording
        const filterUsed = this.learningSystem.adaptiveFilters[asset]; // Or 8
        this.recordTradeOutcome(asset, won, digitCount, filterUsed, assetState.stayedInArray);

        this.totalTrades++;

        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            //New Stake System
            if (this.sys === 2) {
                if (this.sysCount === 5) {
                    this.sys = 1;
                    this.sysCount = 0;
                }
            } else if (this.sys === 3) {
                if (this.sysCount === 2) {
                    this.sys = 1;
                    this.sysCount = 0;
                }
            }

            this.currentStake = this.config.initialStake;

            // Reset asset-specific loss counter
            if (assetState) {
                assetState.consecutiveLosses = 0;
            }

            // NEW: Reset adaptive filters on win
            // this.learningSystem.adaptiveFilters[asset] = 8;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;

            // Increment asset-specific loss counter
            if (assetState) {
                assetState.consecutiveLosses++;
            }

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;
        }

        this.totalProfitLoss += profit;
        this.Pause = true;

        // NEW: Adaptive wait time based on market conditions and losses
        let baseWaitTime = this.config.minWaitTime;

        if (!won) {
            // Longer wait after losses to let market conditions change
            baseWaitTime = this.config.minWaitTime + (this.consecutiveLosses * 60000); // +1min per loss
            this.sendLossEmail(asset);
            //Suspend All Assets (Non-Loss)
            this.suspendAsset(asset);
            // this.suspendAllExcept(asset);

            //New Stake System
            if (this.consecutiveLosses >= 2) {
                if (this.sys === 1) {
                    this.sys = 2;
                } else if (this.sys === 2) {
                    this.sys = 3;
                }
                this.sysCount = 0;
            }

            if (this.sys === 2 && this.consecutiveLosses === 1 && this.currentStake === this.config.multiplier2) {
                this.sys = 3;
                this.sysCount = 0;
            }

            if (this.sys === 3 && this.consecutiveLosses === 1 && this.currentStake === this.config.multiplier3) {
                this.stopLossStake = true;
            }

            //New Stake System
            if (this.sys === 1) {
                // this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
                this.currentStake = this.config.multiplier;
                this.sys = 1;
            } else {
                if (this.sys === 2 && this.consecutiveLosses === 1) {
                    this.currentStake = this.config.multiplier2;
                    this.sysCount++;
                } else if (this.sys === 3 && this.consecutiveLosses === 1) {
                    this.currentStake = this.config.multiplier3;
                    this.sysCount++;
                } else {
                    this.currentStake = this.config.initialStake;
                }
            }
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

        // Enhanced stop conditions with risk management
        // const riskLimitReached = this.totalProfitLoss <= -this.riskManager.maxDailyLoss;

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

        this.disconnect();

        if (!this.endOfDay) {
            setTimeout(() => {
                this.tradeInProgress = false;
                this.Pause = false;
                this.connect();
            }, randomWaitTime);
        }
    }


    // Add new method to handle asset suspension
    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
        // console.log(`🚫 Suspended asset: ${asset}`);
    }

    // Add new method to reactivate asset
    reactivateAsset(asset) {
        this.suspendedAssets.delete(asset);
        // console.log(`✅ Reactivated asset: ${asset}`);
    }

    // Add new method to handle all other assets suspension
    suspendAllExcept(asset) {
        this.assets.forEach(a => {
            if (a !== asset) {
                this.suspendAsset(a);
            }
        });
        this.suspendedAssets.delete(asset);
        // console.log(`🚫 Suspended all except: ${asset}`);
    }

    // Add new method to reactivate all suspended assets
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
            // console.log(`Unsubscribing from ticks with ID: ${subId}`);
        });
        this.tickSubscriptionIds = {};
    }

    // Check for Disconnect and Reconnect
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            // Always use GMT +1 time regardless of server location
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000)); // Convert UTC → GMT+1
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Optional: log current GMT+1 time for monitoring
            // console.log(
            // "Current GMT+1 time:",
            // gmtPlus1Time.toISOString().replace("T", " ").substring(0, 19)
            // );

            // Check for Morning resume condition (7:00 AM GMT+1)
            if (this.endOfDay && currentHours === 7 && currentMinutes >= 0) {
                console.log("It's 7:00 AM GMT+1, reconnecting the bot.");
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
                this.previousStayedIn = {};
                this.extendedStayedIn = {}; // Extended historical run lengths (up to 5000)

                // NEW: Advanced analytics and learning system
                this.learningSystem = {
                    lossPatterns: {},
                    failedDigitCounts: {},
                    volatilityScores: {},
                    filterPerformance: {},
                    resetPatterns: {},
                    timeWindowPerformance: [],
                    adaptiveFilters: {},
                };

                // NEW: Advanced risk management
                this.riskManager = {
                    // maxDailyLoss: config.stopLoss * 0.7,
                    currentSessionRisk: 0,
                    riskPerTrade: 0.02,
                    cooldownPeriod: 0,
                    lastLossTime: null,
                    consecutiveSameDigitLosses: {},
                };

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

                    // Initialize learning system for each asset
                    this.learningSystem.lossPatterns[asset] = [];
                    this.learningSystem.volatilityScores[asset] = 0;
                    this.learningSystem.adaptiveFilters[asset] = 8;
                    this.riskManager.consecutiveSameDigitLosses[asset] = {};
                });

                this.connect();
            }

            // Check for evening stop condition (after 5:00 PM GMT+1) 17
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000); // Check every 20 seconds
    }


    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    logTradingSummary(asset) {
        console.log('Trading Summary:');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Trades Won: ${this.totalWins}`);
        console.log(`Total Trades Lost: ${this.totalLosses}`);
        console.log(`x2 Losses: ${this.consecutiveLosses2}`);
        console.log(`x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`[${asset}] Predicted Asset: ${asset}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`Currently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log(`Waiting for: ${this.waitTime} minutes (${this.waitSeconds} ms) before resubscribing...`);
        const assetWinRate = this.calculateAssetWinRate(asset);
        const volatility = this.learningSystem.volatilityScores[asset] || 0;
        console.log(`[${asset}] Recent Win Rate: ${(assetWinRate * 100).toFixed(1)}% | Volatility: ${(volatility * 100).toFixed(1)}%`);

        console.log(`Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log(`Wait Time: ${this.waitTime} minutes (${this.waitSeconds} ms)`);
        console.log('=========================================================');
    }

    startEmailTimer() {
        if (!this.endOfDay) {
            setInterval(() => {
                this.sendEmailSummary();
            }, 1800000); // 30 Minutes
        }
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        // Calculate additional learning metrics
        const totalFilterStats = Object.entries(this.learningSystem.filterPerformance)
            .map(([filter, stats]) => {
                const total = stats.wins + stats.losses;
                const winRate = total > 0 ? (stats.wins / total * 100).toFixed(1) : 0;
                return `Filter ${filter}: ${winRate}% (${stats.wins}W/${stats.losses}L)`;
            })
            .join('\n        ');

        const summaryText = `
        ==================== Trading Summary ====================
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
        
        Asset Volatility:
        ${this.assets.map(a => `${a}: ${(this.learningSystem.volatilityScores[a] * 100 || 0).toFixed(1)}%`).join('\n        ')}
        =========================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Grok_Enhanced Accumulator Bot - Performance Summary',
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
            subject: `Grok_Enhanced Accumulator Bot - Loss Alert [${asset}]`,
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

        // Calculate additional learning metrics
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

        ==================== Trading Summary ====================
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
        
        Asset Volatility:
        ${this.assets.map(a => `${a}: ${(this.learningSystem.volatilityScores[a] * 100 || 0).toFixed(1)}%`).join('\n        ')}
        =========================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Grok_Enhanced Accumulator Bot - Performance Summary',
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
            subject: 'Grok_Enhanced Accumulator Bot - Error Report',
            text: `An error occurred: ${errorMessage}`
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending error email:', error);
        }
    }

    start() {
        console.log('🚀 Starting Enhanced Accumulator Trading Bot with Learning System');
        console.log('Features: Adaptive filters, pattern recognition, volatility analysis');
        this.connect();
        this.checkTimeForDisconnectReconnect(); // Automatically handles disconnect/reconnect at specified times
    }
}

// Usage
const bot = new EnhancedDigitDifferTradingBot('DMylfkyce6VyZt7', {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir', 'hsj0tA0XJoIzJG5', 'rgNedekYXvCaPeP'
    initialStake: 1,
    multiplier: 21,
    multiplier2: 100,
    multiplier3: 1000,
    maxConsecutiveLosses: 3,
    stopLoss: 400,
    takeProfit: 5000,
    growthRate: 0.05,
    accuTakeProfit: 0.5,
    requiredHistoryLength: 1000,
    winProbabilityThreshold: 100,
    minWaitTime: 2000, // 2 seconds for testing
    maxWaitTime: 5000, // 5 seconds for testing
    // minWaitTime: 300000, //5 Minutes
    // maxWaitTime: 2600000, //1 Hour
    minOccurrencesThreshold: 1,
});

bot.start();
