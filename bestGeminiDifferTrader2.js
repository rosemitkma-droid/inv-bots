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
            hotWindow: config.hotWindow || 5, // Avoid digits appearing in last X ticks
            // Ghost Protocol Settings
            virtualTrade: config.virtualTrade || false, // true = Virtual Trading, false = Real Trading
            virtualWinsRequired: config.virtualWinsRequired || 5, // Wins needed to resume real trading
            dynamicVolatilityScaling: config.dynamicVolatilityScaling || true, // Increase required wins if volatility is high
            minProbability: config.minProbability || 8.5, // Minimum probability to consider a trade
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
        this.kconsecutiveLosses = 0;
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
        this.sysCount = 0;
        this.stopLossStake = false;
        this.xDigit = null;
        this.trendFilter = 0;
        this.trendFilter2 = 0;
        this.trendFilter3 = 0;
        this.trendFilter4 = 0;
        this.trendFilter5 = 0;
        this.trendFilter6 = 0;
        this.trendFilter7 = 0;
        this.xTrendFilter = 0;

        // Ghost Protocol State
        this.ghostMode = config.virtualTrade; // true = Virtual Trading, false = Real Trading
        this.virtualWins = 0;
        this.virtualLosses = 0;

        // Asset Data
        this.assetsData = {};
        this.assets.forEach(asset => {
            this.assetsData[asset] = {
                history: [], // Prices
                lastDigits: [], // Digits
                digitCounts: new Array(10).fill(0), // Frequency of each digit
                tradeInProgress: false,
                volatility: 0
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
        this.assetsData[asset].lastDigits = history.prices.map(price => this.getLastDigit(price, asset));
        this.assetsData[asset].history = history.prices.map(p => parseFloat(p));

        // Initialize Digit Counts
        this.assetsData[asset].digitCounts.fill(0);
        this.assetsData[asset].lastDigits.forEach(d => this.assetsData[asset].digitCounts[d]++);

        // Calculate Initial Volatility
        this.calculateVolatility(asset);

        console.log(`[${asset}] Initialized with ${this.assetsData[asset].lastDigits.length} ticks. Vol: ${this.assetsData[asset].volatility.toFixed(4)}%`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.lastDigits[asset] = lastDigit;

        this.assetsData[asset].lastDigits.push(lastDigit);
        this.assetsData[asset].history.push(parseFloat(tick.quote));

        if (this.assetsData[asset].lastDigits.length > this.config.requiredHistoryLength) {
            this.assetsData[asset].lastDigits.shift();
        }
        if (this.assetsData[asset].priceHistory.length > this.config.requiredHistoryLength) {
            this.assetsData[asset].priceHistory.shift();
        }

        // Update Counts Efficiently
        if (oldDigit !== undefined) this.assetsData[asset].digitCounts[oldDigit]--;
        this.assetsData[asset].digitCounts[digit]++;

        // Initialize Digit Counts
        this.assetsData[asset].digitCounts.fill(0);
        this.assetsData[asset].lastDigits.forEach(d => this.assetsData[asset].digitCounts[d]++);

        this.calculateVolatility(asset);

        console.log(`[${asset}] New Digit: ${digit} | Volatility: ${this.assetsData[asset].volatility.toFixed(4)}%`);

        if (this.assetsData[asset].lastDigits.length < this.config.requiredHistoryLength) {
            console.log(`⏳ [${asset}] Buffering... (${this.assetsData[asset].lastDigits.length}/${this.config.requiredHistoryLength})`);
            return;
        }

        console.log(`[${asset}] ${tick.quote} → Last 5: ${this.assetsData[asset].lastDigits.slice(-5).join(', ')}`);

        if (!this.tradeInProgress) {
            this.analyzeTicks(asset);
        }
    }

    calculateVolatility(asset) {
        const data = this.assetsData[asset];
        if (data.history.length < 20) return;

        const window = data.history.slice(-20);
        const mean = window.reduce((a, b) => a + b, 0) / window.length;
        const variance = window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / window.length;
        data.volatility = (Math.sqrt(variance) / mean) * 100;
    }


    analyzeTicks(asset) {
        if (this.tradeInProgress || this.suspendedAssets.has(asset)) {
            return;
        }

        const history = this.assetsData[asset].lastDigits;
        if (history.length < this.config.requiredHistoryLength) {
            return;
        }

        // const data = this.assetsData[asset];

        // 1. Find Lowest Occurrence Digit (LDP)
        let minCount = Infinity;
        let bestDigit = -1;

        for (let i = 0; i <= 9; i++) {
            if (this.assetsData[asset].digitCounts[i] < minCount) {
                minCount = this.assetsData[asset].digitCounts[i];
                bestDigit = i;
            }
        }

        const probability = minCount / this.assetsData[asset].lastDigits.length;

        // 2. Filter 1: Hot Filter (Avoid if appeared in last 5 ticks)
        const last5 = this.assetsData[asset].lastDigits.slice(-this.config.hotWindow);
        if (last5.includes(bestDigit)) {
            console.log(`[${asset}] Skipping Hot Digit ${bestDigit} (In last 5: ${last5.join(',')})`);
            return;
        }

        // 3. Filter 2: Trend Filter (Simplified - check if it appeared in last 20 more than expected)
        // Expected in 20 is 2. If > 3, it's trending up locally.
        const last20 = this.assetsData[asset].lastDigits.slice(-20);
        const localCount = last20.filter(d => d === bestDigit).length;
        if (localCount > 3) {
            console.log(`[${asset}] Skipping Trending Digit ${bestDigit} (Local Count: ${localCount})`);
            return;
        }

        this.probability = (probability * 100).toFixed(2);
        console.log(`[${asset}] Probability: ${this.probability}% | Trend Filter: ${this.trendFilter}%`);

        // 4. Filter 3: Probability Filter
        const isGoodTrade = this.probability <= this.config.minProbability;

        // 5. Ghost Protocol and Filter Check
        if (asset === 'R_10') {
            if (isGoodTrade && this.probability < this.trendFilter) {
                if (this.ghostMode) {
                    this.placeVirtualTrade(asset, bestDigit, this.probability, this.trendFilter);
                } else {
                    this.placeRealTrade(asset, bestDigit, this.probability, this.trendFilter);
                }
            }
        } else if (asset === 'R_25') {
            if (isGoodTrade && this.probability < this.trendFilter2) {
                if (this.ghostMode) {
                    this.placeVirtualTrade(asset, bestDigit, this.probability, this.trendFilter2);
                } else {
                    this.placeRealTrade(asset, bestDigit, this.probability, this.trendFilter2);
                }
            }
        } else if (asset === 'R_50') {
            if (isGoodTrade && this.probability < this.trendFilter3) {
                if (this.ghostMode) {
                    this.placeVirtualTrade(asset, bestDigit, this.probability, this.trendFilter3);
                } else {
                    this.placeRealTrade(asset, bestDigit, this.probability, this.trendFilter3);
                }
            }
        } else if (asset === 'R_75') {
            if (isGoodTrade && this.probability < this.trendFilter4) {
                if (this.ghostMode) {
                    this.placeVirtualTrade(asset, bestDigit, this.probability, this.trendFilter4);
                } else {
                    this.placeRealTrade(asset, bestDigit, this.probability, this.trendFilter4);
                }
            }
        } else if (asset === 'R_100') {
            if (isGoodTrade && this.probability < this.trendFilter5) {
                if (this.ghostMode) {
                    this.placeVirtualTrade(asset, bestDigit, this.probability, this.trendFilter5);
                } else {
                    this.placeRealTrade(asset, bestDigit, this.probability, this.trendFilter5);
                }
            }
        } else if (asset === 'RDBULL') {
            if (isGoodTrade && this.probability < this.trendFilter6) {
                if (this.ghostMode) {
                    this.placeVirtualTrade(asset, bestDigit, this.probability, this.trendFilter6);
                } else {
                    this.placeRealTrade(asset, bestDigit, this.probability, this.trendFilter6);
                }
            }
        } else if (asset === 'RDBEAR') {
            if (isGoodTrade && this.probability < this.trendFilter7) {
                if (this.ghostMode) {
                    this.placeVirtualTrade(asset, bestDigit, this.probability, this.trendFilter7);
                } else {
                    this.placeRealTrade(asset, bestDigit, this.probability, this.trendFilter7);
                }
            }
        }

        if (asset === 'R_10') {
            this.trendFilter = this.probability;
            console.log(`[${asset}] Asset Probability: ${this.probability}%`);
        } else if (asset == 'R_25') {
            this.trendFilter2 = this.probability;
            console.log(`[${asset}] Asset Probability: ${this.probability}%`);
        } else if (asset == 'R_50') {
            this.trendFilter3 = this.probability;
            console.log(`[${asset}] Asset Probability: ${this.probability}%`);
        } else if (asset == 'R_75') {
            this.trendFilter4 = this.probability;
            console.log(`[${asset}] Asset Probability: ${this.probability}%`);
        } else if (asset == 'R_100') {
            this.trendFilter5 = this.probability;
            console.log(`[${asset}] Asset Probability: ${this.probability}%`);
        } else if (asset == 'RDBULL') {
            this.trendFilter6 = this.probability;
            console.log(`[${asset}] Asset Probability: ${this.probability}%`);
        } else if (asset == 'RDBEAR') {
            this.trendFilter7 = this.probability;
            console.log(`[${asset}] Asset Probability: ${this.probability}%`);
        }
    }


    placeRealTrade(asset, predictedDigit, lowestProb, trendFilter) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.xDigit = predictedDigit;
        this.xTrendFilter = trendFilter;

        console.log(`🚀 [${asset}] Placing trade → Digit: ${predictedDigit} | Prob: ${lowestProb}% | Stake: $${this.currentStake}`);

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

    placeVirtualTrade(asset, digit, probability) {
        const data = this.assetsData[asset];
        console.log(`👻 [${asset}] GHOST TRADE (Virtual) | Digit: ${digit} | Prob: ${(probability * 100).toFixed(2)}%`);

        // Simulate Trade Result (Next Tick)
        // We can't know the result immediately. We need to wait for the next tick.
        // For simplicity in this architecture, we'll set a flag and check the NEXT tick for this asset.
        data.virtualTrade = {
            digit: digit,
            entryPrice: data.history[data.history.length - 1] // Not needed for differ, just digit
        };
        data.tradeInProgress = true; // Block new trades until resolved
    }

    // Override handleTick to check for virtual trade resolution
    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const price = tick.quote;
        const data = this.assetsData[asset];

        // Check Virtual Trade Resolution BEFORE updating history (so we check against the NEW tick)
        if (data.virtualTrade) {
            const resultDigit = this.getLastDigit(price, asset);
            const won = resultDigit !== data.virtualTrade.digit;
            this.handleVirtualResult(asset, won);
            data.virtualTrade = null;
            data.tradeInProgress = false;
        }

        // ... Standard Update Logic (Copied from above to avoid recursion issues if I just called super) ...
        const digit = this.getLastDigit(price, asset);
        const oldDigit = data.lastDigits.shift();
        data.lastDigits.push(digit);
        data.history.shift();
        data.history.push(parseFloat(price));
        if (oldDigit !== undefined) data.digitCounts[oldDigit]--;
        data.digitCounts[digit]++;
        this.calculateVolatility(asset);

        if (!data.tradeInProgress) {
            this.analyzeTicks(asset);
        }
    }

    handleVirtualResult(asset, won) {
        if (won) {
            this.virtualWins++;
            this.virtualLosses = 0;
            console.log(`👻 [${asset}] Virtual WIN (${this.virtualWins}/${this.config.virtualWinsRequired})`);

            // Dynamic Threshold: If volatility is high (> 0.05%), require 3 wins
            const requiredWins = this.assetsData[asset].volatility > 0.05 ? this.config.virtualWinsRequired + 3 : this.config.virtualWinsRequired;

            if (this.virtualWins >= requiredWins) {
                console.log('✨ Ghost Protocol Deactivated. Resuming REAL TRADING.');
                this.ghostMode = false;
                this.virtualWins = 0;
                //Resumption Stake
                if (this.kconsecutiveLosses === 1) {
                    this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
                    // this.kconsecutiveLosses = 0;
                } else if (this.kconsecutiveLosses === 2) {
                    this.currentStake = Math.ceil((this.config.initialStake * this.config.multiplier) * this.config.multiplier * 100) / 100;
                    // this.kconsecutiveLosses = 0;
                }
            }
        } else {
            this.virtualWins = 0;
            this.virtualLosses++;
            console.log(`💀 [${asset}] Virtual LOSS. Streak Reset.`);
        }
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

            this.currentStake = this.config.initialStake;
            this.consecutiveLosses = 0;
            this.kconsecutiveLosses = 0;

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
            // this.currentStake = this.config.initialStake;
            // this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;

            if (this.currentStake >= 0.35 && this.currentStake <= this.config.initialStake) {
                this.kconsecutiveLosses = 1;
            } else if (this.currentStake > this.config.initialStake && this.currentStake <= Math.ceil(this.config.initialStake * this.config.multiplier * 100) / 100) {
                this.kconsecutiveLosses = 2;
            } else if (this.currentStake > Math.ceil(this.config.initialStake * this.config.multiplier * 100) / 100) {
                this.kconsecutiveLosses = 3;
            }

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            console.log(`🛡️ [${asset}] Real Loss Detected. Activating GHOST PROTOCOL.`);
            this.ghostMode = true;
            this.virtualWins = 0;

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


        if (!this.endOfDay) {
            this.logTradingSummary(asset);
        }

        if (!won) {
            this.sendLossEmail(asset);

            this.currentStake = this.config.initialStake;

            //Update Filter Number
            // this.knum++;
            // if (this.knum = 3) {
            //     this.knum = 1;
            // }   

            //Suspend All Assets (Non-Loss)
            this.suspendAllExcept(asset);
        } else {
            // If there are suspended assets, reactivate the first one on win
            const firstSuspendedAsset = Array.from(this.suspendedAssets)[0];
            this.reactivateAsset(firstSuspendedAsset);
        }

        // if (!won) {
        //     //New Stake System
        //     if (this.consecutiveLosses >= 2) {
        //         if (this.sys === 1) {
        //             this.sys = 2;
        //         } else if (this.sys === 2) {
        //             this.sys = 3;
        //         }
        //         this.sysCount = 0;
        //     }

        //     if (this.sys === 3 && this.consecutiveLosses === 1 && this.currentStake === this.config.multiplier3) {
        //         this.stopLossStake = true;
        //     }

        //     if (this.sys === 2 && this.consecutiveLosses === 1 && this.currentStake === this.config.multiplier2) {
        //         this.sys = 3;
        //         this.sysCount = 0;
        //     }


        //     //New Stake System
        //     if (this.sys === 1) {
        //         this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
        //         // this.currentStake = this.config.multiplier;
        //         this.sys = 1;
        //     } else {
        //         if (this.sys === 2 && this.consecutiveLosses === 1) {
        //             this.currentStake = this.config.multiplier2;
        //             this.sysCount++;
        //         } else if (this.sys === 3 && this.consecutiveLosses === 1) {
        //             this.currentStake = this.config.multiplier3;
        //             this.sysCount++;
        //         } else {
        //             this.currentStake = this.config.initialStake;
        //         }
        //     }
        // }

        this.trendFilter = 0;
        this.trendFilter2 = 0;
        this.trendFilter3 = 0;
        this.trendFilter4 = 0;
        this.trendFilter5 = 0;
        this.trendFilter6 = 0;
        this.trendFilter7 = 0;

        // Suspend the asset after a trade
        // this.suspendAsset(asset);

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || this.totalProfitLoss <= -this.config.stopLoss || this.kconsecutiveLosses >= 3) {
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

        // Hard Reset: Clear History
        this.assets.forEach(asset => {
            this.assetsData[asset] = {
                history: [], // Prices
                lastDigits: [], // Digits
                digitCounts: new Array(10).fill(0), // Frequency of each digit
                tradeInProgress: false,
                volatility: 0
            };
        });


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
            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM GMT+1, reconnecting the bot.");
                this.LossDigitsList = [];
                this.tradeInProgress = false;
                this.usedAssets = new Set();
                this.RestartTrading = true;
                this.Pause = false;
                this.endOfDay = false;
                // Hard Reset: Clear History 
                this.assets.forEach(asset => {
                    this.assetsData[asset] = {
                        history: [], // Prices
                        lastDigits: [], // Digits
                        digitCounts: new Array(10).fill(0), // Frequency of each digit
                        tradeInProgress: false,
                        volatility: 0
                    };
                });

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
            }, 1800000); // 30 Munites
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
            subject: '2BestGeminiDifferTrader - Summary',
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

        const lastFewTicks = this.assetsData[asset].lastDigits.slice(-20);

        const summaryText = `
        Loss Trade Summary:
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
        Probability: ${this.probability}
        Trend Filter: ${this.xTrendFilter}
        
        Last 20 Digits: ${lastFewTicks.join(', ')} 

        Current Stake: $${this.currentStake.toFixed(2)}

        Waiting for: ${this.waitTime} minutes before next trade...
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: '2BestGeminiDifferTrader - Loss Alert',
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
            subject: '2BestGeminiDifferTrader - Connection/Dissconnection Summary',
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
            subject: '2BestGeminiDifferTrader - Error Report',
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
        console.log(`
        ╔══════════════════════════════════════════════════════════════╗
        ║             BEST GEMINI DIFFER TRADER (GHOST PROTOCOL)       ║
        ║             ------------------------------------------       ║
        ║  Strategy: Statistical Fortress (LDP + Filters)              ║
        ║  Risk Mode: Ghost Protocol (Virtual Recovery)                ║
        ╚══════════════════════════════════════════════════════════════╝
        `);
        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// Usage
const bot = new EnhancedDigitDifferTradingBot('rgNedekYXvCaPeP', {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir', rgNedekYXvCaPeP, hsj0tA0XJoIzJG5, Dz2V2KvRf4Uukt3
    initialStake: 0.61,
    multiplier: 11.3,
    multiplier2: 30,
    multiplier3: 100,
    maxConsecutiveLosses: 6,
    stopLoss: 138,
    takeProfit: 500,
    hotWindow: 5, // Avoid digits appearing in last X ticks
    virtualTrade: true, // Start Bot in Virtual Mode
    virtualWinsRequired: 1, // Wins needed to resume real trading
    dynamicVolatilityScaling: true, // Increase required wins if volatility is high
    minProbability: 7.9, // Minimum probability to consider a trade
    requiredHistoryLength: 1000,
    minWaitTime: 2000, //5 Minutes
    maxWaitTime: 5000, //1 Hour
});

bot.start();
