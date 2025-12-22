require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');


class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.geminiApiKeys = config.geminiApiKeys || [];
        this.currentApiKeyIndex = 0;
        this.setGeminiModel();

        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || [
            'R_10', 'RDBULL', 'R_25', 'R_50', 'RDBEAR', 'R_75', 'R_100'
            // 'RDBULL'
        ];

        this.config = {
            initialStake: config.initialStake || 5,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            stopLoss: config.stopLoss || 67,
            takeProfit: config.takeProfit || 100,
            requiredHistoryLength: config.requiredHistoryLength || 1000,
            winProbabilityThreshold: config.winProbabilityThreshold || 60,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            kWinCount: config.kWinCount || 2,
            minWaitTime: config.minWaitTime || 200 * 1000,
            maxWaitTime: config.maxWaitTime || 500 * 1000,
        };

        this.currentStake = this.config.initialStake;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.currentAsset = null;
        this.currentTradeId = null;
        this.lastDigitsList = [];
        this.digitCounts = Array(10).fill(0);
        this.tickSubscriptionId = null;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.tickHistory = [];
        this.predictedDigit = null;
        this.endOfDay = false;
        this.kProfitCount = 0;
        this.winProbNumber2 = 0;
        this.digitFrequency2 = 0;
        this.SYS = 1;
        this.SYSCount = 0;
        this.SYSCountReset = 0;
        this.previousPredictions = [];
        this.predictionOutcomes = [];
        this.previousPredictions2 = [];
        this.predictionOutcomes2 = [];
        this.winningPatterns = new Map();
        this.lastPrediction = null;
        this.lastPredictionOutcome = null;
        this.kWins = 0;
        this.kLosses = 0;
        this.waitTime = 0;
        this.waitSeconds = 0;
        this.RestartTrading = true;
        this.isWinTrade = false;
        this.lastFewTicks = [];
        this.lastDigit = null;
        this.tradeMethod = [];
        this.lastDigit2 = null;
        this.riskLevel = null;
        this.retryCount = 0;
        this.ktotalTrades = 0;
        this.refreshTime = 0;

        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        };
        this.emailRecipient = process.env.EMAIL_RECIPIENT;
        this.startEmailTimer();

        this.reconnectAttempts = 0;
        this.Pause = false;

        this.currentBalance = config.initialBalance || 1000; // Set a default if not provided
        this.baseStake = config.initialStake;
        this.lastStakeUsed = null;
        this.todayPnL = 0;
    }

    // Set Gemini model with the current API key
    setGeminiModel() {
        this.geminiApiKey = this.geminiApiKeys[this.currentApiKeyIndex];
        this.genAI = new GoogleGenerativeAI(this.geminiApiKey);
        this.model = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
        // this.model = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-09-2025" });
        // this.model = this.genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
    }

    connect() {
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
                setTimeout(() => this.startTrading(), 60000); // Wait for 1 minute before retrying
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.startTrading(), 3600000); // Wait for 1 hour before retrying
                break;
            default:
                console.log('Encountered an error. Continuing operation...');
                this.startTrading();
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
        console.log(`Requested tick history for asset: ${asset}`);
    }

    subscribeToTicks(asset) {
        const request = {
            ticks: asset,
            subscribe: 1
        };
        this.sendRequest(request);
        // console.log(`Subscribed to ticks for asset: ${asset}`);
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
            this.lastDigitsList = [];
            this.tickHistory = [];
            this.digitCounts = Array(10).fill(0);
            this.predictedDigit = null;
            this.retryCount = 0;
            this.refreshTime = 0;
            this.startTrading();

        } else if (message.msg_type === 'history') {
            this.handleTickHistory(message.history);
        } else if (message.msg_type === 'tick') {
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
            console.log('Successfully unsubscribed from ticks');
            this.tickSubscriptionId = null;
        } else if (message.subscription && message.msg_type === 'tick') {
            this.tickSubscriptionId = message.subscription.id;
            console.log(`Subscribed to ticks. Subscription ID: ${this.tickSubscriptionId}`);
        } else if (message.error) {
            this.handleApiError(message.error);
        }
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    startTrading() {
        console.log('Starting trading...');
        this.tradeNextAsset();
    }

    tradeNextAsset() {
        if (this.usedAssets.size === this.assets.length) {
            this.usedAssets = new Set();
        }

        if (this.RestartTrading) {
            let availableAssets = this.assets.filter(asset => !this.usedAssets.has(asset));
            this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
            this.usedAssets.add(this.currentAsset);
        }
        console.log(`Selected asset: ${this.currentAsset}`);

        this.unsubscribeFromTicks(() => {
            this.subscribeToTickHistory(this.currentAsset);
            this.subscribeToTicks(this.currentAsset);
        });

        this.RestartTrading = false;
    }

    handleTickHistory(history) {
        this.tickHistory = history.prices.map(price => this.getLastDigit(price, this.currentAsset));
        // console.log(`Received tick history. Length: ${this.tickHistory.length}`);

    }

    handleTickUpdate(tick) {
        const lastDigit = this.getLastDigit(tick.quote, this.currentAsset);
        this.lastDigitsList.push(lastDigit);
        this.lastDigit = lastDigit;

        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.config.requiredHistoryLength) {
            this.tickHistory.shift();
        }

        this.digitCounts[lastDigit]++;

        console.log(`Received tick history: ${this.tickHistory.length}`);
        console.log(`Received tick: ${this.currentAsset}=>  ${tick.quote} (Last digit: ${lastDigit})`);
        console.log(`Last 10 digits: ${this.tickHistory.slice(-10).join(', ')}`);

        if (this.tickHistory.length < this.config.requiredHistoryLength) {
            console.log(`Waiting for more ticks. Current length: ${this.tickHistory.length}`);
            return;
        }

        if (!this.tradeInProgress && !this.predictionInProgress) {
            this.lastDigit2 = this.tickHistory.slice(-1)[0];
            console.log(`Last Digit: ${this.tickHistory.slice(-1)[0]}`);
            // if (this.ktotalTrades >= 1) {
            //     this.refreshTime++;
            //     console.log(`Refresh Time: ${this.refreshTime}`);
            //     if (this.refreshTime >= 3) {
            //         this.refreshTime = 0;
            //         this.analyzeTicks();
            //     }
            // } 
            // else {
            this.analyzeTicks();
            // }
        }
    }

    // Gemini AI Predictor Methods
    async predictBestDigit(tickHistory) {
        if (this.tradeInProgress) return null;

        let retryCount = 0;
        const maxRetries = 5;
        const baseDelay = 2000; // 2 seconds base delay

        while (retryCount < maxRetries) {
            try {
                const recentDigits = tickHistory.slice(-500);

                const currentTime = new Date().toISOString();

                console.log('Current Time:', currentTime);

                const previousOutcomesString = this.previousPredictions && this.predictionOutcomes ?
                    this.previousPredictions.map((pred, index) =>
                        `${pred}: ${this.predictionOutcomes[index] ? 'won' : 'lost'}`
                    ).join(", ") : "No previous predictions";

                console.log('Traded Methods:', this.tradeMethod.join(", "));

                // - Analysis method ${this.SYS === 1 ? allAnalysisMethods[0] : this.SYS === 2 ? allAnalysisMethods[1] : this.SYS === 3 ? allAnalysisMethods[2] : allAnalysisMethods[0]}

                //  1. NEVER repeat the same method in this Previously used methods array ${this.tradeMethod.join(", ")}


                const prompt = `
                You are an expert trading AI engaged in Deriv Digit Differ (digit that will not appear next) prediction, you are trading against an adversary (the Deriv system).

                ADVERSARIAL CONTEXT:
                - You are trading against an intelligent system that learns from your prediction patterns
                - The opposing system actively tries to break your models and cause losses
                - It adapts its digit generation to exploit your previous successful strategies
                - You must continuously evolve your analysis and prediction methods

                INPUT DATA:
                - Current asset: ${this.currentAsset}
                - Tick history: [${recentDigits.join(', ')}]
                - Last prediction: ${this.lastPrediction !== null ? this.lastPrediction : 'None'}
                - Previous predictions and outcomes: ${previousOutcomesString.length > 0 ? previousOutcomesString : 'No previous predictions'}
                - Consecutive losses: ${this.consecutiveLosses}
                - Traded methods: ${this.tradeMethod.join(", ")}
                - Current time: ${new Date().toISOString()}
            
                ANALYSIS FRAMEWORK – Use only proven methods for predicting the Digit that will NOT appear (Digit Differ):
        
                STRATEGY SELECTION & ADAPTATION:
                - Select the best method based on recent performance, market regime, and risk level
                - Avoid methods that have recently led to losses
                - Adapt strategy dynamically based on current market conditions and historical effectiveness
            
                MARKET REGIME ASSESSMENT:
                - Determine if the market is trending, ranging, or volatile using volatility and momentum indicators
                - Adjust method selection based on the identified market regime

                DECISION RULES:
                1. If consecutive losses ≥ 1, switch to conservative statistical methods
                5. Consider recent performance: adapt method selection based on what's working
            
                RISK MANAGEMENT:
                - Account for execution delays (e.g., network latency, processing time). The predicted digit should be the one that will NOT appear in the next (after your prediction).
                - Only make predictions with low risk levels
            
                Output Format (JSON only):
                {
                    "predictedDigit": X,
                    "confidence": XX,
                    "primaryStrategy": "Method-Name",
                    "marketRegime": "trending/ranging/volatile",
                    "riskAssessment": "low/medium/high"
                }
            
            CRITICAL:
                - Based on the delay from AI analysis and response, theres bound to be a 6 - 12 seconds delay (equals to 3 - 6 ticks), so your analysis and prediction should take this into consideration.
                - Base predictions on quantitative analysis, NEVER random selection
                - NEVER predict the digit likely to appear next
                - NEVER choose a method that has recently led to losses (avoid using any method that has led to losses within the last 7 trades)
            `;


                console.log('Sending request to Gemini AI...');
                const result = await this.model.generateContent(prompt);
                const response = result.response;
                const text = response.text();

                // Try to extract JSON from the response
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (!jsonMatch) {
                    throw new Error('No JSON found in response');
                }

                const prediction = JSON.parse(jsonMatch[0]);

                // Validate the prediction structure
                if (!prediction || typeof prediction !== 'object') {
                    throw new Error('Invalid prediction: not an object');
                }

                if (typeof prediction.predictedDigit !== 'number' ||
                    prediction.predictedDigit < 0 ||
                    prediction.predictedDigit > 9) {
                    throw new Error('Invalid prediction: predictedDigit must be a number between 0 and 9');
                }

                if (typeof prediction.confidence !== 'number' ||
                    prediction.confidence < 0 ||
                    prediction.confidence > 100) {
                    throw new Error('Invalid prediction: confidence must be a number between 0 and 100');
                }

                console.log('Successfully parsed prediction:', prediction);
                return prediction;

            } catch (error) {
                console.error(`Attempt ${retryCount + 1} failed:`, error.message);
                retryCount++;

                if (retryCount < maxRetries) {
                    // Calculate exponential backoff with jitter
                    const delay = Math.min(baseDelay * Math.pow(2, retryCount - 1) * (0.8 + Math.random() * 0.4), 30000);
                    console.log(`Retrying in ${Math.round(delay / 1000)} seconds...`);

                    // Cycle to the next API key before retrying
                    this.currentApiKeyIndex = (this.currentApiKeyIndex + 1) % this.geminiApiKeys.length;
                    this.setGeminiModel();
                    console.log(`Switched to Gemini API key #${this.currentApiKeyIndex + 1}`);

                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    console.error('Max retries reached. Giving up.');
                    this.Pause = true;
                    this.disconnect();
                    // return null;
                }
            }
        }
        return null;
    }


    // Analysis
    async analyzeTicks() {

        if (this.tradeInProgress || this.predictionInProgress) {
            return; // Don't start a new prediction if one is already in progress
        }

        try {

            this.predictionInProgress = true;

            //Measure AI processing time
            const startTime = Date.now();
            const prediction = await this.predictBestDigit(this.tickHistory);
            const endTime = Date.now();
            const processingTime = (endTime - startTime) / 1000; // Convert to seconds

            console.log(`AI processing time: ${processingTime} seconds`);

            if (processingTime > 12) {
                console.error('AI processing time exceeded 12 seconds, skipping trade.');
                this.predictionInProgress = false;
                this.RestartTrading = true;
                this.disconnect();
                return;
            }

            if (!prediction || prediction.skipTrade) {
                console.log('AI recommends skipping this trade.');
                this.predictionInProgress = false;
                this.RestartTrading = true;
                this.disconnect();
                return;
            }

            // Explicitly convert winProbability and predictedDigit to numbers
            const winProbNumber = prediction.confidence;
            const predictedDigitNumber = prediction.predictedDigit;

            // Log AI's reasoning
            // console.log('AI Primary Strategy:', prediction.primaryStrategy);
            this.predictionStrategy = prediction.primaryStrategy;

            this.predictedDigit = predictedDigitNumber;
            this.winProbNumber2 = winProbNumber;

            // if (winProbNumber > 60 && this.riskLevel !== 'high' && this.riskLevel !== 'medium') {
            this.lastPrediction = this.predictedDigit;
            this.riskLevel = prediction.riskAssessment;
            this.tradeMethod.push(this.predictionStrategy);
            this.placeTrade(this.predictedDigit, this.winProbNumber2);
            // } else {
            //     console.error('Confidence too low, restarting Bot!');
            //     this.predictionInProgress = false;
            //     this.RestartTrading = true;
            //     this.disconnect();
            // }
        } catch (error) {
            console.error('Error in analyzeTicks:', error.message);
            this.Pause = true;
            this.disconnect();
        }
    }

    placeTrade(predictedDigit, winProbNumber2) {
        if (this.tradeInProgress) {
            // console.log('Trade already in progress. Skipping...');
            return;
        }

        this.tradeInProgress = true;
        this.predictionInProgress = true;

        console.log(`Placing trade for digit: ${predictedDigit}(${winProbNumber2}%) Stake: ${this.currentStake.toFixed(2)}`);
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
                symbol: this.currentAsset,
                barrier: predictedDigit,
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
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        console.log(`Trade outcome: ${won ? 'Won' : 'Lost'}`);

        // Update AI feedback system
        if (this.lastPrediction !== null) {
            this.previousPredictions.push(this.lastPrediction);
            this.predictionOutcomes.push(won);

            this.previousPredictions2.push(this.lastPrediction);
            this.predictionOutcomes2.push(won);

            // Keep only last 20 predictions for logging
            if (this.previousPredictions2.length > 20) {
                this.previousPredictions2.shift();
                this.predictionOutcomes2.shift();
            }

            // Keep last 100 predictions for analysis
            if (this.previousPredictions.length > 1000) {
                this.previousPredictions.shift();
                this.predictionOutcomes.shift();
            }

            // Include previous prediction outcomes in the prompt
            const previousOutcomes = this.previousPredictions.map((pred, index) =>
                `${pred}: ${this.predictionOutcomes[index] ? 'won' : 'lost'}`
            ).join(", ");

            // Include previous prediction outcomes2 in the prompt
            const previousOutcomes2 = this.previousPredictions2.map((pred, index) =>
                `${pred}: ${this.predictionOutcomes2[index] ? 'won' : 'lost'}`
            ).join(", ");

            console.log(`Previous Predictions: ${previousOutcomes2}`)

            // Update winning patterns database
            if (won) {
                const pattern = this.tickHistory.slice(-5).join('');
                this.winningPatterns.set(
                    pattern,
                    (this.winningPatterns.get(pattern) || 0) + 1
                );
            }
        }

        this.totalTrades++;
        this.ktotalTrades++;
        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
            this.kWins++;
            if (this.kWins >= this.config.kWinCount) {
                this.SYS++; // Switch to the first analysis method after a win
                if (this.SYS >= 4) {
                    this.SYS = 1; // Switch to the first analysis method after trading all Methods
                }
                this.kWins = 0;
            }
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;
            this.kWins = 0;

            // Switch analysis method
            this.SYS++; // Switch to the next analysis method after a loss
            if (this.SYS >= 4) {
                this.SYS = 1; // Switch to the first analysis method after trading all Methods
            }

            if (this.consecutiveLosses === 2) {
                this.consecutiveLosses2++;
            } else if (this.consecutiveLosses === 3) {
                this.consecutiveLosses3++;
            }

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
        }

        if (this.tradeMethod.length >= 10) {
            this.tradeMethod.shift(); // Keep only the last 10 methods used
        }
        this.totalProfitLoss += profit;
        this.todayPnL += profit;

        this.RestartTrading = true;


        const randomWaitTime = Math.floor(Math.random() * (this.config.maxWaitTime - this.config.minWaitTime + 1)) + this.config.minWaitTime;
        const waitTimeMinutes = Math.round(randomWaitTime / 60000); // Convert to minutes for logging


        this.waitTime = waitTimeMinutes;
        this.waitSeconds = randomWaitTime;

        this.sendLossEmail();

        this.logTradingSummary();

        this.Pause = true;

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('Max consecutive losses reached. Stopping trading.');
            this.disconnect();
            return;
        }
        // if (this.totalProfitLoss <= -this.config.stopLoss) {
        //     console.log('Max consecutive losses reached. Stopping trading.');
        //     this.disconnect();
        //     return;
        // }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take Profit Reached... Stopping trading.');
            this.disconnect();
            return;
        }


        this.disconnect();

        // Cycle to the next API key and re-initialize Gemini model
        this.currentApiKeyIndex = (this.currentApiKeyIndex + 1) % this.geminiApiKeys.length;
        this.setGeminiModel();

        if (!this.endOfDay) {
            setTimeout(() => {
                this.Pause = false;
                this.connect();
            }, randomWaitTime);
        }

    }

    unsubscribeFromTicks(callback) {
        if (this.tickSubscriptionId) {
            const request = {
                forget: this.tickSubscriptionId
            };
            this.sendRequest(request);
            console.log(`Unsubscribing from ticks with ID: ${this.tickSubscriptionId}`);

            this.ws.once('message', (data) => {
                const message = JSON.parse(data);
                if (message.msg_type === 'forget' && message.forget === this.tickSubscriptionId) {
                    console.log(`Unsubscribed from ticks successfully`);
                    this.tickSubscriptionId = null;
                    if (callback) callback();
                }
            });
        } else {
            if (callback) callback();
        }
    }

    //Check for Disconnect and Reconnect
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const currentHours = now.getHours();
            const currentMinutes = now.getMinutes();

            // Check for morning resume condition (8:00 AM)
            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM, reconnecting the bot.");
                this.LossDigitsList = [];
                // this.tradeInProgress = false;
                this.usedAssets = new Set();
                this.RestartTrading = true;
                this.Pause = false;
                this.endOfDay = false;
                this.connect();
            }

            // Check for evening stop condition (after 8:00 PM)
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 20 && currentMinutes >= 0) {
                    console.log("It's past 8:00 PM after a win trade, disconnecting the bot.");
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

    logTradingSummary() {
        console.log('Trading Summary:');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Trades Won: ${this.totalWins}`);
        console.log(`Total Trades Lost: ${this.totalLosses}`);
        console.log(`x2 Losses: ${this.consecutiveLosses2}`);
        console.log(`x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`predictedDigit: ${this.lastPrediction}`);
        console.log(`winProbNumber: ${this.winProbNumber2} %`);
        console.log(`Last Digit: ${this.lastDigit2}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`Waiting for: ${this.waitTime} (${this.waitSeconds}) minutes before reconnecting to trade the next asset...`);
    }

    startEmailTimer() {
        if (!this.endOfDay) {
            setInterval(() => {
                //this.sendEmailSummary();
            }, 1800000); // 30 minutes
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
        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'GeminiAIPredictor_Differ Bot - Summary',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Email sent successfully:', info.messageId);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    async sendLossEmail() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        this.lastFewTicks = this.tickHistory.slice(-3)

        const summaryText = `
        Trade Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%

        Last Digit Analysis:
        Asset: ${this.currentAsset}
        predictedDigit: ${this.lastPrediction}
        winProbNumber: ${this.winProbNumber2}%
        Prediction Strategy: ${this.predictionStrategy}
        Risk Level: ${this.riskLevel}
        Last Digit: ${this.lastDigit2}
        Last 10 Digits: ${this.tickHistory.slice(-10)}

        Current Stake: $${this.currentStake.toFixed(2)}

        Waiting for: ${this.waitTime} (${this.waitSeconds}) minutes before reconnecting to trade the next asset...
        `;


        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'GeminiAIPredictor_Differ Bot - Summary',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Email sent successfully:', info.messageId);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'GeminiAIPredictor_Differ Bot - Error Report',
            text: `An error occurred in the trading bot: ${errorMessage}`
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            console.log('Error email sent successfully:', info.messageId);
        } catch (error) {
            console.error('Error sending error email:', error);
        }
    }

    start() {
        this.connect();
        // this.checkTimeForDisconnectReconnect(); // Automatically handles disconnect/reconnect at specified times
    }
}

// Usage
const bot = new EnhancedDerivTradingBot(process.env.DERIV_TOKEN, {
    // Replace with your actual API keys
    geminiApiKeys: process.env.GEMINI_API_KEYS.split(','),
    initialStake: 5.5,
    multiplier: 11.3,
    maxStake: 278,
    maxConsecutiveLosses: 1,
    stopLoss: 67,
    takeProfit: 0.5,
    requiredHistoryLength: 1000, // Minimum tick history length before analysis
    winProbabilityThreshold: 60, // Minimum win probability to place a trade
    minWaitTime: 10000, // 10 seconds
    maxWaitTime: 60000, // 1 minute
});

// Create and start the bot
console.log("🚀 Starting Gemini AI Enhanced Trading Bot...");
console.log("🤖 This bot will use Gemini AI for immediate predictions and trading");

bot.start();
