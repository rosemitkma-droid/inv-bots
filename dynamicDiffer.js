
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
            // 'R_10','R_25','R_50','R_75', 'R_100', 
            // 'RDBULL', 'RDBEAR', 
            // '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V',
            // 'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            'R_10','R_25','R_50','R_75', 'R_100', 'RDBULL', 'RDBEAR',
            // 'R_75',
        ];

        this.config = {
            initialStake: config.initialStake || 10.5,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
            stopLoss: config.stopLoss || 50,
            takeProfit: config.takeProfit || 1,
            requiredHistoryLength: config.requiredHistoryLength || 200,
            winProbabilityThreshold: config.winProbabilityThreshold || 100,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            minWaitTime: config.minWaitTime || 200 * 1000,
            maxWaitTime: config.maxWaitTime || 500 * 1000,
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

        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.tickHistories2[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.lastDigits[asset] = null;
            this.lastDigits2[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
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
            // Preserve strategy performance data during re-authentication
            // this.assets.forEach(asset => {
            //     this.tickHistories[asset] = [];
            //     this.tickHistories2[asset] = [];
            //     this.digitCounts[asset] = Array(10).fill(0);
            //     this.predictedDigits[asset] = null;
            //     this.lastPredictions[asset] = [];
            // });
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

        console.log(`[${asset}] ${tick.quote}: ${this.tickHistories[asset].slice(-5).join(', ')}`);

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            console.log(`[${asset}] Waiting for more ticks. Current length: ${this.tickHistories[asset].length}`);
            return; 
        }

        if (!this.tradeInProgress) {
            this.analyzeTicks(asset);
        }
    }

    
    analyzeTicks(asset) {
        if (this.tradeInProgress) {
            return;
        }

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            console.log(`[${asset}] Waiting for more ticks. Current length: ${this.tickHistories[asset].length}`);
            return; 
        }

        // Don't analyze suspended assets
        if (this.suspendedAssets.has(asset)) {
            console.log(`Skipping analysis for suspended asset: ${asset}`);
            return;
        }

        const history = this.tickHistories[asset];


        // Least-occurring digit logic 
        const tickHistory2 = this.tickHistories[asset].slice(-50);
        const digitCounts = Array(10).fill(0);
        tickHistory2.forEach(digit => digitCounts[digit]++);

        let leastOccurringDigit = null;
        let minCount = Infinity;
        digitCounts.forEach((count, digit) => {
            if (count < minCount) {
                minCount = count;
                leastOccurringDigit = digit;
            }
        });

        // Least-occurring digit logic 2
        const tickHistory22 = this.tickHistories[asset].slice(-12);
        const digitCounts2 = Array(10).fill(0);
        tickHistory22.forEach(digit => digitCounts2[digit]++);

        let leastOccurringDigit2 = null;
        let minCount2 = Infinity;
        digitCounts2.forEach((count, digit) => {
            if (count < minCount2) {
                minCount2 = count;
                leastOccurringDigit2 = digit;
            }
        });

        const leastPercentage = minCount;
        console.log(`Digit counts:`, digitCounts, '(', tickHistory2.length, 'ticks)');
        console.log('Least occurring digits:', leastOccurringDigit, '|', leastOccurringDigit2, `(${minCount}/${minCount2} times)`);

        const lastDigit = history[history.length - 1];

        const predictedDigit = leastOccurringDigit;
        const predictedDigit2 = leastOccurringDigit2;

        // if(this.sys === 1) {
            if(predictedDigit !== lastDigit && predictedDigit === predictedDigit2) {
                this.xDigit = predictedDigit;
                this.placeTrade(asset, predictedDigit, leastPercentage);
            }
            else
            {
                console.log(`[${asset}] Skipping trade for digit: ${predictedDigit}(${leastPercentage})`);
                // this.disconnect();
            }
        // }
    }


    placeTrade(asset, predictedDigit, leastPercentage) {
        if (this.tradeInProgress) {
            return;
        }
       
        this.tradeInProgress = true;

        console.log(`[${asset}] 🚀 Placing trade for digit: ${predictedDigit}(${leastPercentage} times) | Stake: ${this.currentStake.toFixed(2)}`);
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

            if (this.sys === 1) {
                this.sys = 2;
            } else {
                this.sys = 1;
            }
               

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
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
        }

        if(!this.endOfDay) {
            this.logTradingSummary(asset);
        }

        // If there are suspended assets, reactivate the first one on win
        if (this.suspendedAssets.size > 3) {
            const firstSuspendedAsset = Array.from(this.suspendedAssets)[0];
            this.reactivateAsset(firstSuspendedAsset);
        }

        // Suspend the asset after a trade
        this.suspendAsset(asset);
        
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || this.totalProfitLoss <= -this.config.stopLoss) {
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
            const now = new Date();
            const currentHours = now.getHours();
            const currentMinutes = now.getMinutes();

            // Check for afternoon resume condition (7:00 AM)
            if (this.endOfDay && currentHours === 14 && currentMinutes >= 0) {
                console.log("It's 7:00 AM, reconnecting the bot.");
                this.LossDigitsList = [];
                this.tradeInProgress = false;
                this.usedAssets = new Set();
                this.RestartTrading = true;
                this.Pause = false;
                this.endOfDay = false;
                this.tradedDigitArray = [];
                this.tradedDigitArray2 = [];
                this.tradeNum = Math.floor(Math.random() * (40 - 21 + 1)) + 21;
                this.connect();
            }
    
            // Check for evening stop condition (after 5:00 PM)
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 23 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM after a win trade, disconnecting the bot.");
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
            subject: 'DynamicDiffer-Multi_Asset_Bot - Summary',
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
            subject: 'DynamicDiffer-Multi_Asset_Bot - Loss Alert',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Loss email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending loss email:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'DynamicDiffer-Multi_Asset_Bot - Error Report',
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


class DynamicDigitDifferTradingBot extends EnhancedDigitDifferTradingBot {
    constructor(token, config = {}) {
        super(token, config);

        // Add pattern tracking
        this.patternStrategies = [
            'frequencyAnalysis',
            'gapDetection',
            'momentumReversal',
            'sequenceBreaker',
            'volatilityCluster',
            'fibonacciRetracement',
            'movingAverageCrossover',
            'bollingerBandSqueeze'
        ];

        this.currentStrategyIndex = 0;
        this.patternHistory = {};
        this.strategyPerformance = {};
        this.currentStrategy = {}; // Track current strategy per asset
        this.assets.forEach(asset => {
            this.patternHistory[asset] = [];
            this.strategyPerformance[asset] = {};
            this.currentStrategy[asset] = null;
            this.patternStrategies.forEach(strategy => {
                this.strategyPerformance[asset][strategy] = {
                    wins: 0,
                    losses: 0,
                    lastUsed: 0,
                    totalTrades: 0,
                    winRate: 0
                };
            });
        });

        // Enhanced configuration
        this.config = {
            ...this.config,
            minPatternStrength: config.minPatternStrength || 0.7,
            maxStrategyReuse: config.maxStrategyReuse || 3,
            patternWindowSizes: config.patternWindowSizes || [12, 25, 50, 100, 200],
            volatilityThreshold: config.volatilityThreshold || 0.3
        };

        // Load saved strategy performance if available
        this.loadStrategyPerformance();
    }

    // Save strategy performance to file
    saveStrategyPerformance() {
        try {
            const fs = require('fs');
            const path = require('path');
            
            const performanceData = {
                strategyPerformance: this.strategyPerformance,
                currentStrategy: this.currentStrategy,
                timestamp: new Date().toISOString()
            };
            
            const filePath = path.join(__dirname, 'strategy_performance.json');
            fs.writeFileSync(filePath, JSON.stringify(performanceData, null, 2));
            console.log('Strategy performance data saved successfully');
        } catch (error) {
            console.error('Error saving strategy performance:', error);
        }
    }

    // Load strategy performance from file
    loadStrategyPerformance() {
        try {
            const fs = require('fs');
            const path = require('path');
            
            const filePath = path.join(__dirname, 'strategy_performance.json');
            
            if (fs.existsSync(filePath)) {
                const savedData = fs.readFileSync(filePath, 'utf8');
                const performanceData = JSON.parse(savedData);
                
                this.strategyPerformance = performanceData.strategyPerformance || this.strategyPerformance;
                this.currentStrategy = performanceData.currentStrategy || this.currentStrategy;
                
                // Ensure all assets have all strategies initialized
                this.assets.forEach(asset => {
                    if (!this.strategyPerformance[asset]) {
                        this.strategyPerformance[asset] = {};
                        this.patternStrategies.forEach(strategy => {
                            this.strategyPerformance[asset][strategy] = {
                                wins: 0,
                                losses: 0,
                                lastUsed: 0,
                                totalTrades: 0,
                                winRate: 0
                            };
                        });
                    } else {
                        // Ensure all strategies exist for this asset
                        this.patternStrategies.forEach(strategy => {
                            if (!this.strategyPerformance[asset][strategy]) {
                                this.strategyPerformance[asset][strategy] = {
                                    wins: 0,
                                    losses: 0,
                                    lastUsed: 0,
                                    totalTrades: 0,
                                    winRate: 0
                                };
                            }
                        });
                    }
                    
                    if (!this.currentStrategy[asset]) {
                        this.currentStrategy[asset] = null;
                    }
                });
                
                console.log('Strategy performance data loaded successfully');
            } else {
                console.log('No saved strategy performance data found, starting fresh');
            }
        } catch (error) {
            console.error('Error loading strategy performance:', error);
            console.log('Starting with fresh strategy performance data');
        }
    }

    // Rotate through strategies dynamically
    getNextStrategy(asset) {
        // Find best performing strategies (win rate > 40%)
        const strategiesByPerformance = this.patternStrategies
            .filter(strategy => {
                const perf = this.strategyPerformance[asset][strategy];
                const winRate = perf.totalTrades > 0 ? perf.wins / perf.totalTrades : 0;
                return winRate > 0.4;
            })
            .sort((a, b) => {
                const perfA = this.strategyPerformance[asset][a];
                const perfB = this.strategyPerformance[asset][b];
                // Sort by win rate descending, then by last used ascending
                const winRateA = perfA.totalTrades > 0 ? perfA.wins / perfA.totalTrades : 0;
                const winRateB = perfB.totalTrades > 0 ? perfB.wins / perfB.totalTrades : 0;
                
                if (winRateA !== winRateB) {
                    return winRateB - winRateA; // Higher win rate first
                }
                return perfA.lastUsed - perfB.lastUsed; // Less recently used first
            });

        // If we have good strategies, use the best one
        // if (strategiesByPerformance.length > 0) {
        //     const selectedStrategy = strategiesByPerformance[0];
        //     this.strategyPerformance[asset][selectedStrategy].lastUsed = Date.now();
        //     this.currentStrategy[asset] = selectedStrategy;
        //     this.saveStrategyPerformance(); // Save the update
        //     return selectedStrategy;
        // }

        // Otherwise cycle through all strategies
        this.currentStrategyIndex = (this.currentStrategyIndex + 1) % this.patternStrategies.length;
        const strategy = this.patternStrategies[this.currentStrategyIndex];
        this.strategyPerformance[asset][strategy].lastUsed = Date.now();
        this.currentStrategy[asset] = strategy;
        this.saveStrategyPerformance(); // Save the update
        return strategy;
    }

    // Enhanced analysis with multiple pattern recognition strategies
    analyzeTicks(asset) {
        if (this.tradeInProgress) return;
        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) return;
        if (this.suspendedAssets.has(asset)) return;

        // Select next strategy to use
        const strategy = this.getNextStrategy(asset);
        console.log(`[${asset}] Using strategy: ${strategy}`);

        // Execute selected strategy
        switch(strategy) {
            case 'frequencyAnalysis':
                this.analyzeFrequency(asset);
                break;
            case 'gapDetection':
                this.analyzeGaps(asset);
                break;
            case 'momentumReversal':
                this.analyzeMomentum(asset);
                break;
            case 'sequenceBreaker':
                this.analyzeSequences(asset);
                break;
            case 'volatilityCluster':
                this.analyzeVolatility(asset);
                break;
            case 'fibonacciRetracement':
                this.analyzeFibonacci(asset);
                break;
            case 'movingAverageCrossover':
                this.analyzeMovingAverages(asset);
                break;
            case 'bollingerBandSqueeze':
                this.analyzeBollingerBands(asset);
                break;
            default:
                this.analyzeFrequency(asset);
        }
    }

    // 1. Frequency Analysis (your existing method enhanced)
    analyzeFrequency(asset) {
        const history = this.tickHistories[asset];
        const lastDigit = history[history.length - 1];

        // Multi-window frequency analysis
        const windowResults = this.config.patternWindowSizes.map(windowSize => {
            const windowHistory = history.slice(-windowSize);
            const digitCounts = Array(10).fill(0);
            windowHistory.forEach(digit => digitCounts[digit]++);

            let leastOccurringDigit = null;
            let minCount = Infinity;
            digitCounts.forEach((count, digit) => {
                if (count < minCount && digit !== lastDigit) {
                    minCount = count;
                    leastOccurringDigit = digit;
                }
            });

            return {
                windowSize,
                digit: leastOccurringDigit,
                count: minCount,
                confidence: 1 - (minCount / windowSize)
            };
        });

        // Find consensus across windows
        const consensusDigit = this.findConsensusDigit(windowResults);
        if (consensusDigit && consensusDigit.confidence > this.config.minPatternStrength) {
            console.log(`[${asset}] Frequency Analysis - Predicting digit ${consensusDigit.digit} won't appear`);
            console.log(`Confidence: ${(consensusDigit.confidence * 100).toFixed(2)}%`);
            this.placeTrade(asset, consensusDigit.digit, consensusDigit.confidence);
        } else {
            console.log(`[${asset}] Frequency Analysis - No strong pattern found`);
        }
    }

    // 2. Gap Detection Strategy
    analyzeGaps(asset) {
        const history = this.tickHistories[asset].slice(-50);
        const lastDigit = history[history.length - 1];

        // Track gaps between digit appearances
        const digitGaps = Array(10).fill(0);
        let currentGap = Array(10).fill(0);

        // Calculate current gaps
        for (let i = history.length - 1; i >= 0; i--) {
            const digit = history[i];
            for (let d = 0; d < 10; d++) {
                if (d === digit) {
                    digitGaps[d] = Math.max(digitGaps[d], currentGap[d]);
                    currentGap[d] = 0;
                } else {
                    currentGap[d]++;
                }
            }
        }

        // Find digit with largest gap that's not the last digit
        let maxGap = 0;
        let gapDigit = null;

        for (let d = 0; d < 10; d++) {
            if (d !== lastDigit && currentGap[d] > maxGap) {
                maxGap = currentGap[d];
                gapDigit = d;
            }
        }

        if (gapDigit !== null) {
            const confidence = Math.min(1, maxGap / this.config.requiredHistoryLength);
            console.log(`[${asset}] Gap Detection - Predicting digit ${gapDigit} won't appear`);
            console.log(`Current gap: ${maxGap} ticks, Confidence: ${(confidence * 100).toFixed(2)}%`);
            this.placeTrade(asset, gapDigit, confidence);
        } else {
            console.log(`[${asset}] Gap Detection - No strong pattern found`);
        }
    }

    // 3. Momentum Reversal Strategy
    analyzeMomentum(asset) {
        const history = this.tickHistories[asset];
        const lastDigit = history[history.length - 1];

        // Calculate momentum for each digit
        const windowSize = 50;
        const momentum = Array(10).fill(0);

        for (let d = 0; d < 10; d++) {
            // Count occurrences in first half vs second half of window
            const firstHalf = history.slice(-windowSize, -windowSize/2).filter(x => x === d).length;
            const secondHalf = history.slice(-windowSize/2).filter(x => x === d).length;

            // Momentum is the change in frequency
            momentum[d] = secondHalf - firstHalf;
        }

        // Find digit with strongest negative momentum (decreasing frequency)
        let minMomentum = 0;
        let momentumDigit = null;

        for (let d = 0; d < 10; d++) {
            if (d !== lastDigit && momentum[d] < minMomentum) {
                minMomentum = momentum[d];
                momentumDigit = d;
            }
        }

        if (momentumDigit !== null && minMomentum < -3) {
            const confidence = Math.min(1, Math.abs(minMomentum) / (windowSize/2));
            console.log(`[${asset}] Momentum Reversal - Predicting digit ${momentumDigit} won't appear`);
            console.log(`Momentum: ${minMomentum}, Confidence: ${(confidence * 100).toFixed(2)}%`);
            this.placeTrade(asset, momentumDigit, confidence);
        } else {
            console.log(`[${asset}] Momentum Reversal - No strong pattern found`);
        }
    }

    // 4. Sequence Breaker Strategy
    analyzeSequences(asset) {
        const history = this.tickHistories[asset].slice(-50);
        const lastDigit = history[history.length - 1];

        // Look for repeating sequences
        const maxSequenceLength = 5;
        const sequenceCounts = {};

        for (let len = 2; len <= maxSequenceLength; len++) {
            for (let i = history.length - len; i >= 0; i--) {
                const sequence = history.slice(i, i + len).join(',');
                sequenceCounts[sequence] = (sequenceCounts[sequence] || 0) + 1;
            }
        }

        // Find most common sequences ending with each digit
        const digitSequences = Array(10).fill().map(() => ({}));
        for (const [seq, count] of Object.entries(sequenceCounts)) {
            if (count > 1) {
                const parts = seq.split(',');
                const last = parseInt(parts[parts.length - 1]);
                digitSequences[last][seq] = count;
            }
        }

        // Find digit that would break the most common sequences
        let bestDigit = null;
        let maxBreaks = 0;

        for (let d = 0; d < 10; d++) {
            if (d === lastDigit) continue;

            let breaks = 0;
            for (let target = 0; target < 10; target++) {
                if (target === d) continue;

                for (const [seq, count] of Object.entries(digitSequences[target] || {})) {
                    // If this digit would break the sequence
                    breaks += count;
                }
            }

            if (breaks > maxBreaks) {
                maxBreaks = breaks;
                bestDigit = d;
            }
        }

        if (bestDigit !== null) {
            const confidence = Math.min(1, maxBreaks / 10);
            console.log(`[${asset}] Sequence Breaker - Predicting digit ${bestDigit} won't appear`);
            console.log(`Potential breaks: ${maxBreaks}, Confidence: ${(confidence * 100).toFixed(2)}%`);
            this.placeTrade(asset, bestDigit, confidence);
        } else {
            console.log(`[${asset}] Sequence Breaker - No strong pattern found`);
        }
    }

    // 5. Volatility Cluster Strategy
    analyzeVolatility(asset) {
        const history = this.tickHistories[asset];
        const lastDigit = history[history.length - 1];

        // Calculate volatility for each digit
        const windowSize = 50;
        const digitVolatility = Array(10).fill(0);
        const digitOccurrences = Array(10).fill(0);

        // First count occurrences in the window
        const windowHistory = history.slice(-windowSize);
        windowHistory.forEach(digit => digitOccurrences[digit]++);

        // Then calculate volatility (standard deviation of gaps between occurrences)
        const digitGaps = Array(10).fill([]);

        let currentGap = Array(10).fill(0);
        for (const digit of windowHistory) {
            for (let d = 0; d < 10; d++) {
                if (d === digit) {
                    if (currentGap[d] > 0) {
                        digitGaps[d].push(currentGap[d]);
                    }
                    currentGap[d] = 0;
                } else {
                    currentGap[d]++;
                }
            }
        }

        // Calculate standard deviation for each digit's gaps
        for (let d = 0; d < 10; d++) {
            if (digitGaps[d].length > 1) {
                const mean = digitGaps[d].reduce((a, b) => a + b, 0) / digitGaps[d].length;
                const variance = digitGaps[d].reduce((a, b) => a + Math.pow(b - mean, 2), 0) / digitGaps[d].length;
                digitVolatility[d] = Math.sqrt(variance);
            }
        }

        // Find digit with lowest volatility (most stable, least likely to appear)
        let minVolatility = Infinity;
        let volatilityDigit = null;

        for (let d = 0; d < 10; d++) {
            if (d !== lastDigit && digitVolatility[d] < minVolatility &&
                digitOccurrences[d] < windowSize * 0.1) { // Also consider frequency
                minVolatility = digitVolatility[d];
                volatilityDigit = d;
            }
        }

        if (volatilityDigit !== null) {
            const confidence = Math.min(1, 1 - (minVolatility / 10));
            console.log(`[${asset}] Volatility Cluster - Predicting digit ${volatilityDigit} won't appear`);
            console.log(`Volatility: ${minVolatility.toFixed(2)}, Confidence: ${(confidence * 100).toFixed(2)}%`);
            this.placeTrade(asset, volatilityDigit, confidence);
        } else {
            console.log(`[${asset}] Volatility Cluster - No strong pattern found`);
        }
    }

    // 6. Fibonacci Retracement Strategy
    analyzeFibonacci(asset) {
        const history = this.tickHistories[asset];
        const lastDigit = history[history.length - 1];

        // Look for Fibonacci patterns in digit sequences
        const fibSequence = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34];
        const windowSize = 100;
        const windowHistory = history.slice(-windowSize);

        // Count transitions between digits
        const transitionMatrix = Array(10).fill().map(() => Array(10).fill(0));
        for (let i = 1; i < windowHistory.length; i++) {
            const from = windowHistory[i-1];
            const to = windowHistory[i];
            transitionMatrix[from][to]++;
        }

        // Find digits that are "resistance" points (rarely transitioned to)
        const resistanceScores = Array(10).fill(0);
        for (let d = 0; d < 10; d++) {
            const totalTransitionsTo = transitionMatrix.reduce((sum, row) => sum + row[d], 0);
            resistanceScores[d] = 1 - (totalTransitionsTo / (windowSize - 1));
        }

        // Find digit with highest resistance that's not the last digit
        let maxResistance = 0;
        let resistanceDigit = null;

        for (let d = 0; d < 10; d++) {
            if (d !== lastDigit && resistanceScores[d] > maxResistance) {
                maxResistance = resistanceScores[d];
                resistanceDigit = d;
            }
        }

        if (resistanceDigit !== null) {
            const confidence = maxResistance;
            console.log(`[${asset}] Fibonacci Retracement - Predicting digit ${resistanceDigit} won't appear`);
            console.log(`Resistance: ${maxResistance.toFixed(2)}, Confidence: ${(confidence * 100).toFixed(2)}%`);
            this.placeTrade(asset, resistanceDigit, confidence);
        } else {
            console.log(`[${asset}] Fibonacci Retracement - No strong pattern found`);
        }
    }

    // 7. Moving Average Crossover Strategy
    analyzeMovingAverages(asset) {
        const history = this.tickHistories[asset];
        const lastDigit = history[history.length - 1];

        // Calculate moving averages for each digit's appearance
        const shortWindow = 12;
        const longWindow = 50;

        const digitMAs = Array(10).fill().map(() => ({
            short: [],
            long: []
        }));

        // Calculate moving averages for each digit
        for (let d = 0; d < 10; d++) {
            // Create binary series (1 if digit appeared, 0 otherwise)
            const binarySeries = history.map(x => x === d ? 1 : 0);

            // Calculate short MA
            for (let i = shortWindow - 1; i < binarySeries.length; i++) {
                const window = binarySeries.slice(i - shortWindow + 1, i + 1);
                const sum = window.reduce((a, b) => a + b, 0);
                digitMAs[d].short.push(sum / shortWindow);
            }

            // Calculate long MA
            for (let i = longWindow - 1; i < binarySeries.length; i++) {
                const window = binarySeries.slice(i - longWindow + 1, i + 1);
                const sum = window.reduce((a, b) => a + b, 0);
                digitMAs[d].long.push(sum / longWindow);
            }
        }

        // Find digits with bearish crossover (short MA crossing below long MA)
        const currentShortMA = digitMAs.map(d => d.short[d.short.length - 1]);
        const currentLongMA = digitMAs.map(d => d.long[d.long.length - 1]);
        const prevShortMA = digitMAs.map(d => d.short[d.short.length - 2] || 0);
        const prevLongMA = digitMAs.map(d => d.long[d.long.length - 2] || 0);

        let bestDigit = null;
        let maxDifference = 0;

        for (let d = 0; d < 10; d++) {
            if (d === lastDigit) continue;

            // Check for bearish crossover
            const crossover = prevShortMA[d] > prevLongMA[d] && currentShortMA[d] <= currentLongMA[d];
            const difference = prevLongMA[d] - currentLongMA[d];

            if (crossover && difference > maxDifference) {
                maxDifference = difference;
                bestDigit = d;
            }
        }

        if (bestDigit !== null) {
            const confidence = Math.min(1, maxDifference * 10);
            console.log(`[${asset}] Moving Average Crossover - Predicting digit ${bestDigit} won't appear`);
            console.log(`MA Difference: ${maxDifference.toFixed(4)}, Confidence: ${(confidence * 100).toFixed(2)}%`);
            this.placeTrade(asset, bestDigit, confidence);
        } else {
            console.log(`[${asset}] Moving Average Crossover - No strong pattern found`);
        }
    }

    // 8. Bollinger Band Squeeze Strategy
    analyzeBollingerBands(asset) {
        const history = this.tickHistories[asset];
        const lastDigit = history[history.length - 1];

        // Calculate Bollinger Bands for each digit's appearance frequency
        const windowSize = 50;
        const k = 2; // Number of standard deviations

        const digitStats = Array(10).fill().map(() => ({
            values: [],
            ma: 0,
            upper: 0,
            lower: 0
        }));

        // Calculate statistics for each digit
        for (let d = 0; d < 10; d++) {
            // Create binary series
            const binarySeries = history.slice(-windowSize).map(x => x === d ? 1 : 0);

            // Calculate moving average
            const sum = binarySeries.reduce((a, b) => a + b, 0);
            const ma = sum / windowSize;
            digitStats[d].ma = ma;

            // Calculate standard deviation
            const variance = binarySeries.reduce((a, b) => a + Math.pow(b - ma, 2), 0) / windowSize;
            const stdDev = Math.sqrt(variance);

            // Calculate bands
            digitStats[d].upper = ma + k * stdDev;
            digitStats[d].lower = ma - k * stdDev;
            digitStats[d].values = binarySeries;
        }

        // Find digits in squeeze (low volatility) that are at their lower band
        let bestDigit = null;
        let minBandWidth = Infinity;

        for (let d = 0; d < 10; d++) {
            if (d === lastDigit) continue;

            const bandWidth = digitStats[d].upper - digitStats[d].lower;
            const currentValue = digitStats[d].values[digitStats[d].values.length - 1];

            // Look for tight bands with value at lower band
            if (bandWidth < minBandWidth &&
                currentValue <= digitStats[d].lower + 0.01 &&
                bandWidth < 0.1) { // Tight bands
                minBandWidth = bandWidth;
                bestDigit = d;
            }
        }

        if (bestDigit !== null) {
            const confidence = 1 - minBandWidth;
            console.log(`[${asset}] Bollinger Band Squeeze - Predicting digit ${bestDigit} won't appear`);
            console.log(`Band Width: ${minBandWidth.toFixed(4)}, Confidence: ${(confidence * 100).toFixed(2)}%`);
            this.placeTrade(asset, bestDigit, confidence);
        } else {
            console.log(`[${asset}] Bollinger Band Squeeze - No strong pattern found`);
        }
    }

    // Helper method to find consensus across multiple windows
    findConsensusDigit(windowResults) {
        const digitScores = {};

        windowResults.forEach(result => {
            if (result.digit !== null) {
                if (!digitScores[result.digit]) {
                    digitScores[result.digit] = {
                        totalConfidence: 0,
                        count: 0,
                        maxConfidence: 0
                    };
                }
                digitScores[result.digit].totalConfidence += result.confidence;
                digitScores[result.digit].count++;
                digitScores[result.digit].maxConfidence = Math.max(
                    digitScores[result.digit].maxConfidence,
                    result.confidence
                );
            }
        });

        let bestDigit = null;
        let bestScore = 0;

        for (const [digit, score] of Object.entries(digitScores)) {
            // Combine average confidence and maximum confidence
            const combinedScore = (score.totalConfidence / score.count) * 0.6 +
                                 score.maxConfidence * 0.4;

            if (combinedScore > bestScore) {
                bestScore = combinedScore;
                bestDigit = parseInt(digit);
            }
        }

        return bestDigit !== null ? {
            digit: bestDigit,
            confidence: bestScore
        } : null;
    }

    // Enhanced trade placement with strategy tracking
    placeTrade(asset, predictedDigit, confidence) {
        if (this.tradeInProgress) return;

        // Only trade if confidence is above threshold
        if (confidence < this.config.minPatternStrength) {
            console.log(`[${asset}] Confidence too low (${(confidence * 100).toFixed(2)}%) for digit ${predictedDigit}`);
            return;
        }

        this.tradeInProgress = true;
        this.xDigit = predictedDigit;

        console.log(`[${asset}] 🚀 Placing trade for digit: ${predictedDigit} | Confidence: ${(confidence * 100).toFixed(2)}% | Stake: ${this.currentStake.toFixed(2)}`);

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

    // Enhanced trade result handling with strategy performance tracking
    handleTradeResult(contract) {
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        console.log(`[${asset}] Trade outcome: ${won ? '✅ WON' : '❌ LOST'}`);

        // Get the actual strategy used for this asset
        const actualStrategy = this.currentStrategy[asset] || 'frequencyAnalysis';
        
        // Update strategy performance
        const strategyPerf = this.strategyPerformance[asset][actualStrategy];
        strategyPerf.totalTrades++;
        
        if (won) {
            strategyPerf.wins++;
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
        } else {
            strategyPerf.losses++;
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
        }
        
        // Calculate win rate
        strategyPerf.winRate = strategyPerf.totalTrades > 0 ?
            (strategyPerf.wins / strategyPerf.totalTrades) * 100 : 0;

        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.todayPnL += profit;
        this.Pause = true;

        // Save updated strategy performance
        this.saveStrategyPerformance();

        const randomWaitTime = Math.floor(Math.random() * (this.config.maxWaitTime - this.config.minWaitTime + 1)) + this.config.minWaitTime;
        const waitTimeMinutes = Math.round(randomWaitTime / 60000);

        this.waitTime = waitTimeMinutes;
        this.waitSeconds = randomWaitTime;

        if (!won) {
            this.sendLossEmail(asset);
        }

        this.logTradingSummary(asset);

        if (this.suspendedAssets.size > 3) {
            const firstSuspendedAsset = Array.from(this.suspendedAssets)[0];
            this.reactivateAsset(firstSuspendedAsset);
        }

        this.suspendAsset(asset);

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('Stop condition reached. Stopping trading.');
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take Profit Reached... Stopping trading.');
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

    // Enhanced logging with strategy information
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
        console.log(`Current Strategy: ${this.currentStrategy[asset] || 'None'}`);

        // Log strategy performance
        console.log('\nStrategy Performance:');
        for (const [strategy, stats] of Object.entries(this.strategyPerformance[asset])) {
            const winRate = stats.totalTrades > 0 ?
                (stats.wins / stats.totalTrades * 100).toFixed(2) : 'N/A';
            console.log(`${strategy}: ${stats.wins}W/${stats.losses}L/${stats.totalTrades}T (${winRate}%)`);
        }

        console.log(`Waiting for: ${this.waitTime} minutes (${this.waitSeconds} ms) before resubscribing...`);
    }
}

// Usage
const bot = new DynamicDigitDifferTradingBot('0P94g4WdSrSrzir', {
    initialStake: 0.61,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 129,
    takeProfit: 5000,
    requiredHistoryLength: 1000,
    winProbabilityThreshold: 100,
    minWaitTime: 300000, //5 Minutes
    maxWaitTime: 2600000, //1 Hour
    minPatternStrength: 0.01,
    maxStrategyReuse: 3,
    patternWindowSizes: [12, 25, 50, 100, 200],
    volatilityThreshold: 0.3
});

bot.start();
