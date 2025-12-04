const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class PatternAnalyzer {
    constructor() {
        this.minSamples = 20; // Minimum historical occurrences required to form a reliable pattern
        this.maxPatternLength = 3; // Look at patterns up to 3 digits long
    }

    analyze(history) {
        // Need enough history
        if (!history || history.length < 50) {
            return { shouldTrade: false, confidence: 0 };
        }

        // We prioritize patterns based on specificity (length) and sample size.
        // A pattern of length 2 with 50 samples and 0 occurrences of digit X is very strong.
        // A pattern of length 1 with 500 samples and 0 occurrences of digit X is even stronger (but rare).

        const currentDigit = history[history.length - 1];
        const prevDigit = history[history.length - 2];
        const prevPrevDigit = history[history.length - 3];

        let bestPrediction = null;
        let bestConfidence = 0;
        let bestPatternType = '';
        let bestSamples = 0;

        // Check patterns from length 3 down to 1
        // We want the most specific pattern that has enough data

        // 1. Pattern Length 3 (Sequence of 3)
        // if (history.length > 3) {
        //     const pattern3 = [prevPrevDigit, prevDigit, currentDigit];
        //     const analysis3 = this.findSafeDigitForPattern(history, pattern3);
        //     if (analysis3 && analysis3.isSafe) {
        //         bestPrediction = analysis3.digit;
        //         bestConfidence = analysis3.confidence;
        //         bestPatternType = 'Sequence-3';
        //         bestSamples = analysis3.samples;
        //     }
        // }

        // 2. Pattern Length 2 (Sequence of 2) - Only override if confidence is significantly higher or we didn't find one yet
        // if (history.length > 2) {
        //     const pattern2 = [prevDigit, currentDigit];
        //     const analysis2 = this.findSafeDigitForPattern(history, pattern2);

        //     if (analysis2 && analysis2.isSafe) {
        //         // If we already have a prediction, only switch if this one has MUCH more data
        //         if (!bestPrediction || (analysis2.confidence > bestConfidence)) {
        //             bestPrediction = analysis2.digit;
        //             bestConfidence = analysis2.confidence;
        //             bestPatternType = 'Sequence-2';
        //             bestSamples = analysis2.samples;
        //         }
        //     }
        // }

        // 3. Pattern Length 1 (Last Digit) - Hardest to find 0 occurrences, but strongest if found
        if (history.length > 1) {
            const pattern1 = [currentDigit];
            const analysis1 = this.findSafeDigitForPattern(history, pattern1);

            if (analysis1 && analysis1.isSafe) {
                if (!bestPrediction || (analysis1.confidence > bestConfidence)) {
                    bestPrediction = analysis1.digit;
                    bestConfidence = analysis1.confidence;
                    bestPatternType = 'Sequence-1';
                    bestSamples = analysis1.samples;
                }
            }
        }

        if (bestPrediction !== null) {
            return {
                shouldTrade: true,
                predictedDigit: bestPrediction,
                confidence: bestConfidence,
                patternType: bestPatternType,
                samples: bestSamples
            };
        }

        return { shouldTrade: false, confidence: 0 };
    }

    findSafeDigitForPattern(history, pattern) {
        const patternLen = pattern.length;
        const nextDigitCounts = Array(10).fill(0);
        let totalOccurrences = 0;

        // Scan history for this pattern
        // Stop before the last element because we need to see what comes *after*
        for (let i = 0; i < history.length - patternLen; i++) {
            let match = true;
            for (let j = 0; j < patternLen; j++) {
                if (history[i + j] !== pattern[j]) {
                    match = false;
                    break;
                }
            }

            if (match) {
                const nextDigit = history[i + patternLen];
                if (nextDigit !== undefined) {
                    nextDigitCounts[nextDigit]++;
                    totalOccurrences++;
                }
            }
        }

        console.log('Pattern:', pattern, 'Length:', patternLen);
        console.log('Next Digit Counts:', nextDigitCounts);
        console.log('Total Occurrences:', totalOccurrences);

        if (totalOccurrences < this.minSamples) {
            return null;
        }

        // Identify digits that have NEVER appeared after this pattern
        const safeDigits = [];
        for (let d = 0; d < 10; d++) {
            if (nextDigitCounts[d] <= 33) {
                safeDigits.push(d);
            }
        }

        console.log('Safe Digits:', safeDigits);

        if (safeDigits.length > 0) {
            // If multiple safe digits, pick the one that is "coldest" (appeared longest ago in general)
            const bestDigit = this.findColdestDigit(history, safeDigits);

            // Calculate confidence based on sample size
            // If we have 100 samples and 0 occurrences, that's 99% confidence.
            // If we have 20 samples, that's maybe 85% confidence.
            let confidence = 0;
            if (totalOccurrences >= 100) confidence = 99.9;
            else if (totalOccurrences >= 50) confidence = 98;
            else if (totalOccurrences >= 30) confidence = 95;
            else confidence = 90;

            console.log('Best Digit:', bestDigit);

            console.log('Confidence:', confidence);

            return {
                isSafe: true,
                digit: bestDigit,
                confidence: confidence,
                samples: totalOccurrences
            };
        }

        return { isSafe: false };
    }

    findColdestDigit(history, candidates) {
        let bestDigit = candidates[0];
        let maxGap = -1;

        for (const digit of candidates) {
            let gap = 0;
            // Count backwards from end of history
            for (let i = history.length - 1; i >= 0; i--) {
                if (history[i] === digit) {
                    break;
                }
                gap++;
            }
            if (gap > maxGap) {
                maxGap = gap;
                bestDigit = digit;
            }
        }
        return bestDigit;
    }

    analyzeHistory(history) {
        // Helper for logging
        const analysis = this.analyze(history);
        if (analysis.shouldTrade) {
            // console.log(`Pattern Found: [${analysis.patternType}] -> Predict NOT ${analysis.predictedDigit} (Conf: ${analysis.confidence}%, Samples: ${analysis.samples})`);
        }
    }
}

// EnhancedDerivTradingBot class with Advanced Pattern Recognition
class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            // 'R_50','R_100','R_25','R_75', 'R_10',
            'R_50'
        ];

        this.config = {
            initialStake: config.initialStake,
            multiplier: config.multiplier,
            maxConsecutiveLosses: config.maxConsecutiveLosses,
            takeProfit: config.takeProfit,
        };

        // Initialize existing properties
        this.currentStake = this.config.initialStake;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.currentAsset = null;
        this.currentTradeId = null;
        this.lastDigitsList = [];
        this.tickHistory = [];
        this.tradeInProgress = false;
        this.wsReady = false;
        this.predictedDigit = null;
        this.Percentage = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.Pause = false;
        this.RestartTrading = true;
        this.endOfDay = false;
        this.requiredHistoryLength = 5000; // Increased for better pattern analysis
        this.kCount = false;
        this.kCountNum = 0;
        this.kLoss = 0;
        this.multiplier2 = false;
        this.confidenceThreshold = null;
        this.kTradeCount = 0;
        this.isWinTrade = true;
        this.waitTime = 0;
        this.LossDigitsList = [];
        this.threeConsecutiveDigits = 0;
        this.patternAnalyzer = new PatternAnalyzer();// Advanced pattern analyzer
        this.kTrade = false;
        this.xDigit = null;
        this.kChaos = null;

        // WebSocket management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10000;
        this.reconnectInterval = 5000;
        this.tickSubscriptionId = null;

        // Email configuration
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };
        this.emailRecipient = 'kenotaru@gmail.com';
        this.startEmailTimer();
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
            setTimeout(() => this.sendRequest(request), this.reconnectInterval);
        } else {
            console.error('Not connected to Deriv API. Unable to send request:', request);
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.reconnectInterval);
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
                setTimeout(() => this.startTrading(), 60000);
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.startTrading(), 3600000);
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
            count: this.requiredHistoryLength,
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
            this.lastDigitsList = [];
            this.tickHistory = [];

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

    }

    handleTickUpdate(tick) {
        const lastDigit = this.getLastDigit(tick.quote, this.currentAsset);
        this.lastDigitsList.push(lastDigit);

        // Update tick history
        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.requiredHistoryLength) {
            this.tickHistory.shift();
        }

        if (this.tradeInProgress) {
            console.log(`Recent tick History: ${this.tickHistory.slice(-5).join(', ')}`);
        } else {
            console.log(`Received tick: ${this.currentAsset} => ${tick.quote} (Last digit: ${lastDigit})`);
        }

        // Update pattern analyzer with new history
        if (!this.tradeInProgress) {
            this.patternAnalyzer.analyzeHistory(this.tickHistory);
        }

        // Enhanced logging
        if (!this.tradeInProgress) {
            this.analyzeTicksEnhanced();
        }
    }

    analyzeTicksEnhanced() {
        if (this.tradeInProgress) {
            return;
        }

        // Get pattern analysis
        const analysis = this.patternAnalyzer.analyze(this.tickHistory);

        if (analysis.shouldTrade) {
            const confidence = analysis.confidence;
            const predictedDigit = analysis.predictedDigit;

            console.log(`Pattern Analysis: Type=${analysis.patternType}, Target=${predictedDigit}, Conf=${confidence.toFixed(1)}%, Samples=${analysis.samples}`);

            // Trade if confidence is high enough
            // We set a high bar for "100% certainty"
            if (confidence >= 98) { //&& predictedDigit === this.tickHistory[this.tickHistory.length - 1]
                console.log(`Pattern Found: [${analysis.patternType}] -> Predict NOT ${analysis.predictedDigit} (Conf: ${analysis.confidence}%, Samples: ${analysis.samples})`);
                this.xDigit = predictedDigit;
                this.confidenceThreshold = confidence;
                this.placeTrade(predictedDigit, confidence);
            }
        }
    }



    placeTrade(predictedDigit, confidence) {
        if (this.tradeInProgress) {
            return;
        }

        this.tradeInProgress = true;

        console.log(`\n💰 PLACING TRADE 💰`);
        console.log(`Digit: ${predictedDigit} | Confidence: ${confidence}%`);
        console.log(`Stake: $${this.currentStake.toFixed(2)}`);

        const request = {
            buy: 1,
            price: this.currentStake.toFixed(2),
            parameters: {
                amount: this.currentStake.toFixed(2),
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: this.currentAsset,
                barrier: predictedDigit
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

        console.log(`\n📊 TRADE RESULT: ${won ? '✅ WON' : '❌ LOST'}`);
        console.log(`Profit/Loss: $${profit.toFixed(2)}`);

        this.totalTrades++;

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
        } else {
            this.isWinTrade = false;
            this.totalLosses++;
            this.consecutiveLosses++;

            if (this.consecutiveLosses === 2) {
                this.consecutiveLosses2++;
            } else if (this.consecutiveLosses === 3) {
                this.consecutiveLosses3++;
            } else if (this.consecutiveLosses === 4) {
                this.consecutiveLosses4++;
            } else if (this.consecutiveLosses === 5) {
                this.consecutiveLosses5++;
            }

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;

            // this.RestartTrading = true; 
        }

        this.totalProfitLoss += profit;

        if (!won) {
            this.sendLossEmail();
        }

        this.Pause = true;

        this.RestartTrading = true;

        if (!this.endOfDay) {
            this.logTradingSummary();
        }

        this.kChaos = null;

        // Take profit condition
        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take Profit Reached... Stopping trading.');
            this.endOfDay = true;
            this.sendDisconnectResumptionEmailSummary();
            this.disconnect();
            return;
        }

        // Check stopping conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('Stopping condition met. Disconnecting...');
            this.endOfDay = true;
            this.sendDisconnectResumptionEmailSummary();
            this.disconnect();
            return;
        }

        this.unsubscribeFromTicks(() => {
            this.disconnect();
        });

        //Reset Analysis
        this.patternAnalyzer = new PatternAnalyzer();// Advanced pattern analyzer

        if (!this.endOfDay) {
            this.waitTime = Math.floor(Math.random() * (2000 - 1000 + 1)) + 1000;
            console.log(`⏳ Waiting ${Math.round(this.waitTime / 1000)} seconds before next trade...\n`);
            setTimeout(() => {
                this.Pause = false;
                this.kTrade = false;
                this.connect();
            }, this.waitTime);
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

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM GMT+1, reconnecting the bot.");
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 5000);
    }

    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    logTradingSummary() {
        console.log('\n📈 TRADING SUMMARY 📈');
        console.log('═══════════════════════════════════════');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Won: ${this.totalWins} | Lost: ${this.totalLosses}`);
        console.log(`Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%`);
        console.log(`Consecutive Losses: x2:${this.consecutiveLosses2} x3:${this.consecutiveLosses3} x4:${this.consecutiveLosses4} x5:${this.consecutiveLosses5}`);
        console.log(`Total P/L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`Pattern Confidence: ${this.confidenceThreshold}%`);
        console.log('═══════════════════════════════════════\n');
    }

    startEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendEmailSummary();
            }
        }, 1800000); // 30 minutes
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const summaryText = `
        ENHANCED TRADING BOT SUMMARY
        ============================
        
        Performance Metrics:
        -------------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        
        Loss Analysis:
        -------------
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}
        
        Financial Summary:
        -----------------
        Total P/L: $${this.totalProfitLoss.toFixed(2)}
        Current Stake: $${this.currentStake.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2 Deriv Differ Bot - Trading Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Email sending error:', error);
        }
    }

    async sendLossEmail() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const klastDigits = this.tickHistory.slice(-10);

        const summaryText = `
        LOSS ALERT - DETAILED ANALYSIS
        ===============================
        
        Trade Result: LOSS
        
        Performance Metrics:
        -------------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        Total P/L: $${this.totalProfitLoss.toFixed(2)}
        Consecutive Losses: ${this.consecutiveLosses}
        Loss Distribution: x2:${this.consecutiveLosses2} 
        x3:${this.consecutiveLosses3} 
        x4:${this.consecutiveLosses4}        
        
        Pattern Analysis:
        ----------------
        Asset: ${this.currentAsset}
        Predicted Digit: ${this.xDigit}
        Confidence: ${this.confidenceThreshold}%
        
        Recent History:
        --------------
        Last 20 Digits: ${klastDigits.join(', ')}
        
        Current Stake: $${this.currentStake.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2 Deriv Bot - Loss Alert',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Email sending error:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2 Deriv Bot - Error Report',
            text: `An error occurred in the trading bot: ${errorMessage}`
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Error sending error email:', error);
        }
    }

    async sendDisconnectResumptionEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const now = new Date();
        const currentHours = now.getHours();
        const currentMinutes = now.getMinutes();

        const summaryText = `
        BOT STATUS UPDATE
        =================
        Time: ${currentHours}:${currentMinutes.toString().padStart(2, '0')}
        Status: ${this.endOfDay ? 'Day Trading Complete' : 'Session Update'}
        
        Final Performance:
        -----------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        
        Loss Distribution:
        -----------------
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        
        Financial Summary:
        -----------------
        Total P/L: $${this.totalProfitLoss.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2 Deriv Bot - Status Update',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Email sending error:', error);
        }
    }

    start() {
        console.log('🚀 STARTING ENHANCED DERIV TRADING BOT 🚀');
        console.log('=========================================\n');

        this.connect();
        // this.checkTimeForDisconnectReconnect();
    }
}

// Usage
const bot = new EnhancedDerivTradingBot('hsj0tA0XJoIzJG5', {
    initialStake: 0.61,
    multiplier: 11.3,
    maxStake: 127,
    maxConsecutiveLosses: 3,
    stopLoss: 400,
    takeProfit: 2000,
});

bot.start();
