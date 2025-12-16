require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class EnhancedDigitDifferTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || [
            // 'R_10', 'R_25', 'R_50', 'R_75', 'R_100'
            'R_100',
        ];

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

        // NEW: Advanced analytics and learning system
        this.learningSystem = {
            // Track loss patterns by asset and digit combination
            lossPatterns: {},
            // Track which digit counts tend to fail
            failedDigitCounts: {},
            // Market volatility assessment
            volatilityScores: {},
            // Success rate by filter number
            filterPerformance: {},
            // Consecutive resets at same digit
            resetPatterns: {},
            // Best performing time windows
            timeWindowPerformance: [],
            // Dynamic filter adjustment based on learning
            adaptiveFilters: {},
        };

        // NEW: Advanced risk management
        this.riskManager = {
            maxDailyLoss: config.stopLoss * 0.7, // Stop earlier
            currentSessionRisk: 0,
            riskPerTrade: 0.02, // 2% risk per trade
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
                stayedInArray2: [],
                tradedDigitArray: [],
                filteredArray: [],
                totalArray: [],
                currentProposalId: null,
                tradeInProgress: false,
                consecutiveLosses: 0,
                lastTradeResult: null,
                digitFrequency: {},
                stayedInArray: [],
                lastFilterUsed: 8,
                tradeFrequency: 0,
                lastFilterUsed2: 7,
                tradeFrequency2: 0,
            };

            // Initialize learning system for each asset
            this.learningSystem.lossPatterns[asset] = [];
            this.learningSystem.volatilityScores[asset] = 0;
            this.learningSystem.adaptiveFilters[asset] = 8; // Default filter
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
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.lastDigits[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
            this.assetStates[asset] = {
                stayedInArray: [],
                stayedInArray2: [],
                tradedDigitArray: [],
                filteredArray: [],
                totalArray: [],
                currentProposalId: null,
                tradeInProgress: false,
                consecutiveLosses: 0,
                lastTradeResult: null,
                digitFrequency: {},
                stayedInArray: [],
                lastFilterUsed: 8,
                tradeFrequency: 0,
                lastFilterUsed2: 7,
                tradeFrequency2: 0,
            };
        });

        //unsubscribe from all assets
        this.unsubscribeAllTicks();

        //unsubscribe from all assets
        this.assets.forEach(asset => {
            this.unsubscribeFromTicks(asset);
        });
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
                this.lastDigits[asset] = null;
                this.predictedDigits[asset] = null;
                this.lastPredictions[asset] = [];
                this.assetStates[asset] = {
                    stayedInArray: [],
                    stayedInArray2: [],
                    tradedDigitArray: [],
                    filteredArray: [],
                    totalArray: [],
                    currentProposalId: null,
                    tradeInProgress: false,
                    consecutiveLosses: 0,
                    lastTradeResult: null,
                    digitFrequency: {},
                    stayedInArray: [],
                    lastFilterUsed: 8,
                    tradeFrequency: 0,
                    lastFilterUsed2: 7,
                    tradeFrequency2: 0,
                };
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
    detectDangerousPattern(asset, currentDigitCount, stayedInArray) {
        const patternKey = `${asset}_${currentDigitCount}`;
        const recentLosses = this.learningSystem.lossPatterns[asset] || [];

        // Check if we've seen similar patterns fail recently
        const similarLosses = recentLosses
            .slice(-5)
            .filter(loss => {
                return loss.digitCount === currentDigitCount &&
                    Math.abs(loss.arraySum - stayedInArray.reduce((a, b) => a + b, 0)) < 100;
            });

        if (similarLosses.length >= 2) {
            // console.log(`[${asset}] Dangerous pattern detected: ${similarLosses.length} similar losses recently`);
            return true;
        }

        return false;
    }

    // NEW: Calculate recent win rate for an asset
    calculateAssetWinRate(asset) {
        const lossHistory = this.learningSystem.lossPatterns[asset] || [];
        const recentTrades = lossHistory.slice(-10);

        if (recentTrades.length === 0) return 0.5; // Default

        const wins = recentTrades.filter(t => t.result === 'win').length;
        return wins / recentTrades.length;
    }

    // NEW: Record trade outcome for learning
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

        // Store in loss patterns
        if (!this.learningSystem.lossPatterns[asset]) {
            this.learningSystem.lossPatterns[asset] = [];
        }
        this.learningSystem.lossPatterns[asset].push(outcome);

        // Keep only last 50 trades
        if (this.learningSystem.lossPatterns[asset].length > 50) {
            this.learningSystem.lossPatterns[asset].shift();
        }

        // Update filter performance
        if (!this.learningSystem.filterPerformance[filterUsed]) {
            this.learningSystem.filterPerformance[filterUsed] = { wins: 0, losses: 0 };
        }
        if (won) {
            this.learningSystem.filterPerformance[filterUsed].wins++;
        } else {
            this.learningSystem.filterPerformance[filterUsed].losses++;
        }

        // Track consecutive losses at same digit
        if (!won) {
            const key = `${asset}_${digitCount}`;
            this.riskManager.consecutiveSameDigitLosses[key] =
                (this.riskManager.consecutiveSameDigitLosses[key] || 0) + 1;
        } else {
            // Reset on win
            const key = `${asset}_${digitCount}`;
            this.riskManager.consecutiveSameDigitLosses[key] = 0;
        }
    }

    // MODIFIED: Enhanced proposal handler with learning integration
    handleProposal(response) {
        if (response.error) {
            console.error('Proposal error:', response.error.message);
            this.tradeInProgress = false;
            return;
        }

        if (!response.proposal) return;

        // Determine which asset this proposal is for
        let asset = response.echo_req?.symbol;
        if (!asset && response.proposal?.id) {
            asset = this.pendingProposals.get(response.proposal.id);
        }
        if (!asset || !this.assets.includes(asset)) return;

        const assetState = this.assetStates[asset];
        if (!assetState) return;

        const stayedInArray = response.proposal.contract_details.ticks_stayed_in || [];
        const last10 = stayedInArray.slice(-10); // We only care about last 10
        const currentCount = last10.length > 0 ? (last10[last10.length - 1] + 1) : 1;

        // === UPDATE ASSET STATE ===
        assetState.stayedInArray = last10;
        assetState.totalStayedInArray = stayedInArray; // full history if needed
        assetState.currentProposalId = response.proposal.id;
        this.pendingProposals.set(response.proposal.id, asset);

        // === FREQUENCY ANALYSIS (on last 10 ticks) ===
        const freq = {};
        last10.forEach(d => freq[d] = (freq[d] || 0) + 1);

        const appeared = {
            1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [], 8: [], 9: [], 10: []
        };

        Object.keys(freq).forEach(digit => {
            const count = freq[digit];
            if (count >= 1 && count <= 10) {
                appeared[count].push(Number(digit));
            }
        });

        // === BEAUTIFUL LOGGING ===
        // console.log(`
        //     ${asset}: STAYED-IN ANALYSIS
        //     ├─ Last 10 Array: [${last10.join(' → ')}] (${currentCount})
        //     ├─ Digit Frequency (last 10): ${JSON.stringify(freq)}
        //     ├─ Appeared 1x: [${appeared[1].join(', ')}]
        //     ├─ Appeared 2x: [${appeared[2].join(', ')}]
        //     ├─ Appeared 3x: [${appeared[3].join(', ')}]
        //     ├─ Appeared 4x: [${appeared[4].join(', ')}]
        //     ├─ Appeared 5x: [${appeared[5].join(', ')}]
        //     ├─ Appeared 6x: [${appeared[6].join(', ')}]
        //     ├─ Appeared 7x: [${appeared[7].join(', ')}]
        // `.trim());

        console.log(`
            ${asset}: STAYED-IN ANALYSIS
            ├─ Last 10 Array: [${last10}] (${currentCount})
            ├─ Appeared 1x: [${appeared[1]}]
            ├─ Appeared 2x: [${appeared[2]}]
            ├─ Appeared 3x: [${appeared[3]}]
            ├─ Appeared 4x: [${appeared[4]}]
            ├─ Appeared 5x: [${appeared[5]}]
            ├─ Appeared 6x: [${appeared[6]}]
            ├─ Appeared 7x: [${appeared[7]}]
        `.trim());

        // === PREVENT DOUBLE TRADING ===
        if (this.tradeInProgress || assetState.tradeInProgress) {
            console.log(`Trade already in progress on ${asset}. Skipping.`);
            return;
        }

        // === DANGEROUS PATTERN CHECK ===
        if (this.detectDangerousPattern(asset, currentCount, stayedInArray)) {
            console.log(`DANGEROUS PATTERN on ${asset} → Skipping trade`);
            return;
        }

        // === TRADE LOGIC: Priority 7x → 2x (Matching bot2.js) ===
        const lastDigit = last10[last10.length - 1]; // The digit we're betting continues

        for (let times = 4; times >= 3; times--) {
            if (appeared[times].length > 0) {
                if (appeared[times].includes(currentCount) && last10[9] >= 2) {
                    console.log(`TRADE SIGNAL! Betting digit ${lastDigit} appears ${times + 1} times (currently ${times}x)`);

                    assetState.tradedDigitArray.push(currentCount);
                    assetState.filteredArray = appeared[times];
                    assetState.lastFilterUsed = times;
                    assetState.tradeFrequency = times;

                    this.placeTrade(asset);
                }
                // Stop checking lower frequencies because a higher frequency group exists (bot2.js logic)
                break;
            }
        }

        if (!assetState.tradeInProgress) {
            console.log(`No valid trade signal on ${asset} (digit ${lastDigit} not in any filter)`);
        }
    }

    analyzeTicks(asset) {
        if (this.tradeInProgress) return;
        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) return;
        if (this.suspendedAssets.has(asset)) return;

        // NEW: Check market conditions before requesting proposal
        if (!this.isMarketConditionFavorable(asset)) {
            return;
        }

        this.requestProposal(asset);
    }

    placeTrade(asset) {
        if (this.tradeInProgress || this.Pause) {
            console.log(`Cannot trade ${asset} - bot paused or trade in progress`);
            return;
        }

        const state = this.assetStates[asset];
        if (!state?.currentProposalId) {
            console.log(`No proposal ID for ${asset}`);
            return;
        }

        const buyRequest = {
            buy: state.currentProposalId,
            price: this.currentStake.toFixed(2)
        };

        console.log(`EXECUTING ACCU TRADE
        Asset: ${asset}
        Stake: $${this.currentStake.toFixed(2)}
        Target Count: ${state.tradedDigitArray.slice(-1)[0]}
        Frequency Filter: ${state.tradeFrequency}x
        `);

        this.sendRequest(buyRequest);
        this.tradeInProgress = true;
        state.tradeInProgress = true;
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
        const digitCount = assetState.tradedDigitArray[assetState.tradedDigitArray.length - 1];
        const filterUsed = assetState.lastFilterUsed || 8;
        this.recordTradeOutcome(asset, won, digitCount, filterUsed, assetState.stayedInArray);

        this.totalTrades++;

        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;

            // Reset asset-specific loss counter
            if (assetState) {
                assetState.consecutiveLosses = 0;
            }

            // NEW: Reset adaptive filters on win
            this.learningSystem.adaptiveFilters[asset] = 8;
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

            // NEW: Smarter stake adjustment based on confidence
            const recentWinRate = this.calculateAssetWinRate(asset);
            let multiplierAdjustment = 1.0;

            // If we're losing on a historically good asset, be less aggressive
            if (recentWinRate > 0.6) {
                multiplierAdjustment = 1.0 //0.9;
                console.log(`[${asset}] Reducing aggression - good asset having bad run`);
            }
            // If asset is performing poorly, be more conservative
            else if (recentWinRate < 0.4) {
                multiplierAdjustment = 1.0 //0.8;
                console.log(`[${asset}] Strong reduction - poor performing asset`);
            }

            this.currentStake = Math.ceil(
                this.currentStake * this.config.multiplier * multiplierAdjustment * 100
            ) / 100;
        }

        this.totalProfitLoss += profit;
        this.Pause = true;

        // NEW: Adaptive wait time based on market conditions and losses
        let baseWaitTime = this.config.minWaitTime;

        if (!won) {
            // Longer wait after losses to let market conditions change
            baseWaitTime = this.config.minWaitTime + (this.consecutiveLosses * 60000); // +1min per loss
            this.sendLossEmail(asset);
            // this.suspendAllExcept(asset);
        } else {
            if (this.suspendedAssets.size > 0) {
                this.reactivateAllSuspended();
            }
        }

        // Keep array length controlled (matching bot2.js)
        if (assetState && assetState.tradedDigitArray.length > 1) {
            assetState.tradedDigitArray.shift();
        }

        const randomWaitTime = Math.floor(
            Math.random() * (this.config.maxWaitTime - baseWaitTime + 1)
        ) + baseWaitTime;

        const waitTimeMinutes = Math.round(randomWaitTime / 60000);
        this.waitTime = waitTimeMinutes;
        this.waitSeconds = randomWaitTime;

        if (!this.endOfDay) {
            this.logTradingSummary(asset);
        }

        // Enhanced stop conditions with risk management
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

    // Check for Disconnect and Reconnect
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            // Always use GMT +1 time regardless of server location
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000)); // Convert UTC → GMT+1
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();
            const currentDay = gmtPlus1Time.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

            // Optional: log current GMT+1 time for monitoring
            // console.log(
            // "Current GMT+1 time:",
            // gmtPlus1Time.toISOString().replace("T", " ").substring(0, 19)
            // );

            // Check if it's Sunday - no trading on Sundays
            if (currentDay === 0) {
                if (!this.endOfDay) {
                    console.log("It's Sunday, disconnecting the bot. No trading on Sundays.");
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
                return; // Skip all other checks on Sunday
            }

            // Check for Morning resume condition (7:00 AM GMT+1) - but not on Sunday
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

            // Check for evening stop condition (after 5:00 PM GMT+1)
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 5000); // Check every 5 seconds
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
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendEmailSummary();
            }
        }, 1800000); //30 minutes
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
            subject: 'kInspired Accumulator Bot - Performance Summary',
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
            subject: `kInspired Accumulator Bot - Loss Alert [${asset}]`,
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
            subject: 'kInspired Accumulator Bot - Performance Summary',
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
            subject: 'kInspired Accumulator Bot - Error Report',
            text: `An error occurred: ${errorMessage}`
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending error email:', error);
        }
    }

    start() {
        console.log('🚀 Starting kInspired Accumulator Trading Bot with Learning System');
        console.log('Features: Adaptive filters, pattern recognition, volatility analysis');
        this.connect();
        this.checkTimeForDisconnectReconnect(); // Automatically handles disconnect/reconnect at specified times
    }
}

// Usage
const bot = new EnhancedDigitDifferTradingBot('hsj0tA0XJoIzJG5', {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir', rgNedekYXvCaPeP, hsj0tA0XJoIzJG5, Dz2V2KvRf4Uukt3
    initialStake: 1,
    multiplier: 21,
    maxConsecutiveLosses: 3,
    stopLoss: 400,
    takeProfit: 2.5,
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
