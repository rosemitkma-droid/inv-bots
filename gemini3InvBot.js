require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

class EnhancedDigitDifferTradingBot {
    constructor(token, config = {}) {
        this.token = token;

        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || [
            'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR',
            // '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V',
        ];

        this.config = {
            initialStake: config.initialStake || 10.5,
            multiplier: config.multiplier || 11.3,
            multiplier2: config.multiplier2 || 30,
            multiplier3: config.multiplier3 || 100,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
            stopLoss: config.stopLoss || 50,
            takeProfit: config.takeProfit || 1,
            requiredHistoryLength: config.requiredHistoryLength || 200,
            winProbabilityThreshold: config.winProbabilityThreshold || 100,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            minWaitTime: config.minWaitTime || 200 * 1000,
            maxWaitTime: config.maxWaitTime || 500 * 1000,
            // Strategy Settings
            minStateSamples: config.minStateSamples || 15, // Min occurrences of a pattern to trust stats
            probabilityThreshold: config.probabilityThreshold || 0.01, // Trade if P(digit) < 3%
            volatilityWindow: config.volatilityWindow || 20, // Ticks to calculate volatility
            volatilityThreshold: config.volatilityThreshold || 0.0021,
            volatilityThreshold1: config.volatilityThreshold1 || 0.011,
            volatilityThreshold2: config.volatilityThreshold2 || 0.06,
            volatilityThreshold3: config.volatilityThreshold3 || 0.015,
        };

        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.currentTradeId = null;
        this.digitCounts = {};
        this.tickSubscriptionIds = {};
        this.tickHistories = {};
        this.tickHistories2 = {};
        this.lastDigits = {};
        this.lastDigits2 = {};
        this.predictedDigits = {};
        this.lastPredictions = {};
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.endOfDay = false;
        this.lastPredictionOutcome = null;
        this.waitTime = 0;
        this.waitSeconds = 0;
        this.isWinTrade = false;
        this.retryCount = 0;
        // this.startTime = null;
        this.isExcluded = [];
        // Add new property to track suspended assets
        this.suspendedAssets = new Set();
        this.rStats = {};
        this.sys = 1;
        this.knum = 2;
        this.minOccurences = 200;
        this.sysCount = 0;
        this.stopLossStake = false;
        this.assetsData = {};


        // Initialize per-asset storage
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.lastDigits[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
            this.assetsData[asset] = {
                history: [], // Full tick history
                lastDigits: [], // Just the digits
                markov: this.createMarkovMatrix(), // 100x10 matrix
                stateCounts: new Array(100).fill(0), // Count of times each state occurred
                suspended: false,
                consecutiveLosses: 0,
                currentStake: this.config.initialStake,
                tradeInProgress: false,
                volatility: 0,
                priceHistory: []
            };
        });


        //Email Configuration
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
        this.Pause = false;

        this.todayPnL = 0;
    }

    /**
     * Creates a 100x10 matrix initialized to zeros.
     * Rows (0-99): Represent the state (Last 2 digits, e.g., "48" -> index 48).
     * Cols (0-9): Represent the count of the NEXT digit.
     */
    createMarkovMatrix() {
        return Array.from({ length: 100 }, () => new Array(10).fill(0));
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
                this.tickHistories2[asset] = [];
                this.digitCounts[asset] = Array(10).fill(0);
                this.predictedDigits[asset] = null;
                this.lastPredictions[asset] = [];

                // Reset Markov Data
                this.assetsData[asset].markov = this.createMarkovMatrix();
                this.assetsData[asset].stateCounts = new Array(100).fill(0);
                this.assetsData[asset].priceHistory = []; // Store prices for volatility
                this.assetsData[asset].volatility = 0;
            });
            this.tickSubscriptionIds = {};
            this.retryCount = 0;
            this.initializeSubscriptions();

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
        this.assetsData[asset].priceHistory = history.prices.map(p => parseFloat(p));

        // Populate Markov Chain from history
        const digits = this.tickHistories[asset];
        for (let i = 2; i < digits.length; i++) {
            const d1 = digits[i - 2];
            const d2 = digits[i - 1];
            const target = digits[i];

            const stateIndex = (d1 * 10) + d2;
            this.assetsData[asset].markov[stateIndex][target]++;
            this.assetsData[asset].stateCounts[stateIndex]++;
        }

        // Calculate Initial Volatility (Normalized as % of Mean Price)
        if (this.assetsData[asset].priceHistory.length >= this.config.volatilityWindow) {
            const window = this.assetsData[asset].priceHistory.slice(-this.config.volatilityWindow);
            const mean = window.reduce((a, b) => a + b, 0) / window.length;
            const variance = window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / window.length;
            const stdDev = Math.sqrt(variance);
            this.assetsData[asset].volatility = (stdDev / mean) * 100;
        }

        console.log(`[${asset}] Initialized Markov Chain with ${digits.length} ticks. Vol: ${this.assetsData[asset].volatility.toFixed(4)}%`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.lastDigits[asset] = lastDigit;

        this.tickHistories[asset].push(lastDigit);
        this.assetsData[asset].priceHistory.push(parseFloat(tick.quote));

        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        }
        if (this.assetsData[asset].priceHistory.length > this.config.requiredHistoryLength) {
            this.assetsData[asset].priceHistory.shift();
        }

        // Calculate Volatility (Normalized as % of Mean Price)
        if (this.assetsData[asset].priceHistory.length >= this.config.volatilityWindow) {
            const window = this.assetsData[asset].priceHistory.slice(-this.config.volatilityWindow);
            const mean = window.reduce((a, b) => a + b, 0) / window.length;
            const variance = window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / window.length;
            const stdDev = Math.sqrt(variance);
            this.assetsData[asset].volatility = (stdDev / mean) * 100;
        }

        // Update Markov Chain
        const n = this.tickHistories[asset].length;
        if (n >= 3) {
            const d1 = this.tickHistories[asset][n - 3];
            const d2 = this.tickHistories[asset][n - 2];
            const target = this.tickHistories[asset][n - 1];

            const stateIndex = (d1 * 10) + d2;
            this.assetsData[asset].markov[stateIndex][target]++;
            this.assetsData[asset].stateCounts[stateIndex]++;
        }

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            console.log(`⏳ [${asset}] Buffering... (${this.tickHistories[asset].length}/${this.config.requiredHistoryLength})`);
            return;
        }

        console.log(`[${asset}] ${tick.quote} → Last 5: ${this.tickHistories[asset].slice(-5).join(', ')}`);

        if (!this.tradeInProgress) {
            this.analyzeTicks(asset);
        }
    }


    analyzeTicks(asset) {
        if (this.tradeInProgress || this.suspendedAssets.has(asset)) {
            return;
        }

        const history = this.tickHistories[asset];
        if (history.length < this.config.requiredHistoryLength) {
            return;
        }

        // const data = this.assetsData[asset];

        // 1. Check Volatility
        // Note: Volatility scale depends on the asset price. This is a rough heuristic.
        // For a robust bot, we might use Bollinger Band width or similar relative metrics.
        // For now, we skip if volatility is extremely high relative to recent average (simplified).

        // 2. Determine Current State
        const n = history.length;
        const d1 = history[n - 2];
        const d2 = history[n - 1];
        const currentState = (d1 * 10) + d2;

        // 3. Check Sample Size
        const totalSamples = this.assetsData[asset].stateCounts[currentState];
        console.log(`[${asset}] Total samples for pattern [${d1}, ${d2}]: ${totalSamples}`);
        if (totalSamples < this.config.minStateSamples) {
            // Not enough data for this specific pattern yet
            console.log(`[${asset}] Not enough data for pattern [${d1}, ${d2}]`);
            return;
        }

        // 4. Analyze Probabilities
        const transitions = this.assetsData[asset].markov[currentState];
        let lowestProb = 1.0;
        let bestDigit = -1;

        for (let digit = 0; digit <= 9; digit++) {
            const count = transitions[digit];
            const prob = count / totalSamples;

            if (prob < lowestProb) {
                lowestProb = prob;
                bestDigit = digit;
            }
        }

        console.log(`[${asset}] ${d1}, ${d2} | Best Digit: ${bestDigit} | Lowest Prob: ${lowestProb} | Volatility: ${this.assetsData[asset].volatility.toFixed(4)}`);

        // 5. Place Trade if Probability is Low Enough
        if (asset === 'R_25' || asset === 'R_10') {
            if (lowestProb <= this.config.probabilityThreshold && bestDigit !== -1 && this.assetsData[asset].volatility < this.config.volatilityThreshold) {
                console.log(`⚡ [${asset}] Pattern [${d1}, ${d2}] -> ? | Digit:(${bestDigit}) = ${(lowestProb * 100).toFixed(1)}% (${transitions[bestDigit]}/${totalSamples}) | Vol: ${this.assetsData[asset].volatility.toFixed(4)}`);

                this.placeTrade(asset, bestDigit, lowestProb);
            }
        } else if (asset === 'R_50' || asset === 'R_75') {
            if (lowestProb <= this.config.probabilityThreshold && bestDigit !== -1 && this.assetsData[asset].volatility < this.config.volatilityThreshold1) {
                console.log(`⚡ [${asset}] Pattern [${d1}, ${d2}] -> ? | Digit:(${bestDigit}) = ${(lowestProb * 100).toFixed(1)}% (${transitions[bestDigit]}/${totalSamples}) | Vol: ${this.assetsData[asset].volatility.toFixed(4)}`);

                this.placeTrade(asset, bestDigit, lowestProb);
            }
        } else if (asset === 'RDBULL' || asset === 'RDBEAR') {
            if (lowestProb <= this.config.probabilityThreshold && bestDigit !== -1 && this.assetsData[asset].volatility < this.config.volatilityThreshold2) {
                console.log(`⚡ [${asset}] Pattern [${d1}, ${d2}] -> ? | Digit:(${bestDigit}) = ${(lowestProb * 100).toFixed(1)}% (${transitions[bestDigit]}/${totalSamples}) | Vol: ${this.assetsData[asset].volatility.toFixed(4)}`);

                this.placeTrade(asset, bestDigit, lowestProb);
            }
        } else if (asset === 'R_100') {
            if (lowestProb <= this.config.probabilityThreshold && bestDigit !== -1 && this.assetsData[asset].volatility < this.config.volatilityThreshold3) {
                console.log(`⚡ [${asset}] Pattern [${d1}, ${d2}] -> ? | Digit:(${bestDigit}) = ${(lowestProb * 100).toFixed(1)}% (${transitions[bestDigit]}/${totalSamples}) | Vol: ${this.assetsData[asset].volatility.toFixed(4)}`);

                this.placeTrade(asset, bestDigit, lowestProb);
            }
        }

    }


    placeTrade(asset, predictedDigit, lowestProb) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.xDigit = predictedDigit;

        console.log(`🚀 [${asset}] Placing trade → Digit: ${predictedDigit} | Prob: ${lowestProb.toFixed(4)} | Stake: $${this.currentStake}`);

        const request = {
            buy: 1,
            price: this.currentStake,
            parameters: {
                amount: this.currentStake,
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: asset,
                barrier: predictedDigit.toString(),
            }
        };
        this.sendRequest(request);
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

        console.log(`[${asset}] Trade outcome: ${won ? '✅ WON' : '❌ LOST'}`);

        this.totalTrades++;

        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            //New Stake System
            if (this.sys === 2) {
                if (this.sysCount === 3) {
                    this.sys = 1;
                    this.sysCount = 0;
                }
            } else if (this.sys === 3) {
                if (this.sysCount === 4) {
                    this.sys = 1;
                    this.sysCount = 0;
                }
            }
            this.currentStake = this.config.initialStake;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            // Suspend the asset after a loss
            // this.suspendAsset(asset);            

            // this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
        }

        this.totalProfitLoss += profit;
        this.todayPnL += profit;
        this.Pause = true;

        const randomWaitTime = Math.floor(Math.random() * (this.config.maxWaitTime - this.config.minWaitTime + 1)) + this.config.minWaitTime;
        const waitTimeMinutes = Math.round(randomWaitTime / 60000);

        this.waitTime = waitTimeMinutes;
        this.waitSeconds = randomWaitTime;

        if (!won) {
            this.sendLossEmail(asset);

            //Update Filter Number
            // this.knum++;
            // if (this.knum = 3) {
            //     this.knum = 1;
            // }   
        }

        if (!this.endOfDay) {
            this.logTradingSummary(asset);
        }

        this.minOccurences = 200;

        if (!won) {
            //New Stake System
            if (this.consecutiveLosses >= 2) {
                if (this.sys === 1) {
                    this.sys = 2;
                } else if (this.sys === 2) {
                    this.sys = 3;
                }
                this.sysCount = 0;
            }

            if (this.sys === 3 && this.consecutiveLosses === 1 && this.currentStake === this.config.multiplier3) {
                this.stopLossStake = true;
            }

            if (this.sys === 2 && this.consecutiveLosses === 1 && this.currentStake === this.config.multiplier2) {
                this.sys = 3;
                this.sysCount = 0;
            }


            //New Stake System
            if (this.sys === 1) {
                this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
                // this.currentStake = this.config.multiplier;
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
        }

        // If there are suspended assets, reactivate the first one on win
        if (this.suspendedAssets.size > 2) {
            const firstSuspendedAsset = Array.from(this.suspendedAssets)[0];
            this.reactivateAsset(firstSuspendedAsset);
        }

        // Suspend the asset after a trade
        this.suspendAsset(asset);

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || this.totalProfitLoss <= -this.config.stopLoss || this.stopLossStake) {
            console.log('Stop condition reached. Stopping trading.');
            this.endOfDay = true;
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

        // this.unsubscribeAllTicks();
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
        console.log(`🚫 Suspended asset: ${asset}`);
    }

    // Add new method to reactivate asset
    reactivateAsset(asset) {
        this.suspendedAssets.delete(asset);
        console.log(`✅ Reactivated asset: ${asset}`);
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
            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM GMT+1, reconnecting the bot.");
                this.LossDigitsList = [];
                this.tradeInProgress = false;
                this.usedAssets = new Set();
                this.RestartTrading = true;
                this.Pause = false;
                this.endOfDay = false;
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
        console.log(`x4 Losses: ${this.consecutiveLosses4}`);
        console.log(`x5 Losses: ${this.consecutiveLosses5}`);
        console.log(`Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`[${asset}] Predicted Digit: ${this.xDigit}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`Currently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log(`Waiting for: ${this.waitTime} minutes (${this.waitSeconds} ms) before resubscribing...`);
    }

    startEmailTimer() {
        if (!this.endOfDay) {
            setInterval(() => {
                this.sendEmailSummary();
            }, 21600000); // 6 Hours
        }
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const summaryText = `
        Trading Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}

        Currently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}

        Current Stake: $${this.currentStake.toFixed(2)}
        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Gemini3_Markov_Digit_Differ_Bot - Summary',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    async sendLossEmail(asset) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const history = this.tickHistories[asset];
        const lastFewTicks = history.slice(-20);

        const summaryText = `
        Trade Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}

        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%

        Last Digit Analysis:
        Asset: ${asset}
        predicted Digit: ${this.xDigit}
        
        Last 20 Digits: ${lastFewTicks.join(', ')} 

        Current Stake: $${this.currentStake.toFixed(2)}

        Waiting for: ${this.waitTime} minutes before next trade...
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Gemini3_Markov_Digit_Differ_Bot - Loss Alert',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Loss email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending loss email:', error);
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
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}

        Currently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}

        Current Stake: $${this.currentStake.toFixed(2)}
        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Gemini3_Markov_Digit_Differ_Bot - Connection/Dissconnection Summary',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Gemini3_Markov_Digit_Differ_Bot - Error Report',
            text: `An error occurred: ${errorMessage}`
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Error email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending error email:', error);
        }
    }

    start() {
        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// Usage
const bot = new EnhancedDigitDifferTradingBot('0P94g4WdSrSrzir', {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir'
    initialStake: 0.61,
    multiplier: 11.3,
    multiplier2: 30,
    multiplier3: 100,
    maxConsecutiveLosses: 6,
    stopLoss: 138,
    takeProfit: 5000,
    probabilityThreshold: 0.01, // Only trade if < 2% chance of hitting the digit
    minStateSamples: 10, // Learn quickly
    volatilityWindow: 20, // Ticks to calculate volatility
    volatilityThreshold: 0.0021, // Avoid trading if volatility > 0.0021% (erratic market) R_25, R_10: ~0.006% (Very Stable)
    volatilityThreshold1: 0.011, // Avoid trading if volatility > 0.011% (erratic market) R_50, R_75: ~0.011% (Stable)
    volatilityThreshold2: 0.06, // Avoid trading if volatility > 0.06% (erratic market) R_100, RDBULL, RDBEAR: ~0.06% (Stable)
    volatilityThreshold3: 0.015, // Avoid trading if volatility > 0.015% (erratic market) R_100: ~0.015% (Stable)
    requiredHistoryLength: 2000,
    winProbabilityThreshold: 0.8,
    minWaitTime: 3000, //5 Minutes
    maxWaitTime: 2600, //1 Hour
});

bot.start();

