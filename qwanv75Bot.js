const WebSocket = require('ws');
const nodemailer = require('nodemailer');
// EnhancedDerivTradingBot class with Advanced Pattern Recognition and Repetition Filters
class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            // 'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR', '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V', 'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            'R_100',
        ];
        this.config = {
            initialStake: config.initialStake || 1,
            multiplier: config.multiplier || 2.2,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 8,
            takeProfit: config.takeProfit || 5000,
            stopLoss: config.stopLoss || 70,
            maxStake: config.maxStake || 127,
            repWindow: config.repWindow || 100, // Window for overall repetition rate
            condWindow: config.condWindow || 1000, // Window for conditional (individual digit) repetition rate
            repHighThreshold: config.repHighThreshold || 0.15, // High threshold for overall rep rate (above average ~0.1)
            condHighThreshold: config.condHighThreshold || 0.15, // High threshold for conditional rep rate
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
        this.requiredHistoryLength = 10000; // Fixed history length for consistency
        this.kCount = false;
        this.kCountNum = 0;
        this.kLoss = 0;
        this.multiplier2 = false;
        this.confidenceThreshold = null;
        this.kTradeCount = 0;
        this.isWinTrade = true;
        this.waitTime = 0;
        this.LossDigitsList = [];
        this.kTrade = false;
        this.xDigit = null;
        this.baselineRepeatRate = 0.1;
        this.globalRepeatHistory = []; // store rolling repeat rates
        // Dynamic thresholding state
        this.globalRepeatRates = [];           // History of global repeat rates (rolling)
        this.digitRepeatRateHistory = Array(10).fill().map(() => []); // 10 digits (0-9), each has its own history
        this.repeatRateLookback = 50;         // How many recent repeat-rate samples to consider for stats
        this.repeatRateWindow = 250;           // Window size (in ticks) to compute each repeat rate sample
        this.zScoreThreshold = 2.5;            // Lower = more trades, higher = stricter (start with 1.0–1.5)
        this.zScoreThreshold2 = 1.5;            // Lower = more trades, higher = stricter (start with 1.0–1.5)

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
        if (!this.endOfDay) {
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
                if (!this.endOfDay && !this.Pause) {
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
        this.tradeInProgress = false;
        this.lastDigitsList = [];
        this.tickHistory = [];
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
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V',].includes(asset)) {
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
            if (this.RestartTrading) {
                let availableAssets = this.assets.filter(asset => !this.usedAssets.has(asset));
                this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
                // this.usedAssets.add(this.currentAsset);
           
            console.log(`Selected asset: ${this.currentAsset}`);
            this.unsubscribeFromTicks(() => {
                this.subscribeToTickHistory(this.currentAsset);
                this.subscribeToTicks(this.currentAsset);
            });
            this.RestartTrading = false;
        }
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

        // 🔁 Every 15 ticks, update repeat rate histories (adjustable)
        if (this.tickHistory.length % 2 === 0) {
            this.updateRepeatRateHistories();
            const globalRate = this.getGlobalRepeatRate(this.repeatRateWindow);
            console.log(`Updated Global Repeat Rate: ${(globalRate * 100).toFixed(2)}%`);
        }

        console.log(`Recent digits: ${this.tickHistory.slice(-5).join(', ')}`);
        // console.log(`Current digit: ${lastDigit}`);

        if (!this.tradeInProgress && this.tickHistory.length >= this.repeatRateWindow + 100) {
            this.analyzeTicksEnhanced();
        }
    }

    // Returns the global repeat rate over the last N ticks
    getGlobalRepeatRate(historyLength = 250) {
        const history = this.tickHistory.slice(-historyLength);
        if (history.length < 2) return 0;

        let repeats = 0;
        for (let i = 1; i < history.length; i++) {
            if (history[i] === history[i-1]) repeats++;
        }
        return repeats / (history.length - 1);
    }

    // Returns repeat rate for a specific digit over last N ticks
    getDigitRepeatRate(digit, historyLength = 250) {
        const history = this.tickHistory.slice(-historyLength);
        if (history.length < 2) return 0;

        let occurrences = 0;
        let repeats = 0;

        for (let i = 1; i < history.length; i++) {
            if (history[i - 1] === digit) {
                occurrences++;
                if (history[i] === digit) repeats++;
            }
        }

        return occurrences > 0 ? repeats / occurrences : 0;
    }

    // Z-score based anomaly detection (more robust than fixed thresholds)
    isRepetitionAnomaly(repeatRate, baseline = 0.1, stdDev = 0.03, zThreshold = 1.5) {
        // Expected repeat rate ≈ 0.1 (1 in 10)
        const zScore = (repeatRate - baseline) / stdDev;
        return Math.abs(zScore) > zThreshold;
    }

    // Compute mean of an array
    mean(arr) {
        if (arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    // Compute standard deviation
    stdDev(arr) {
        if (arr.length === 0) return 0;
        const avg = this.mean(arr);
        const squareDiffs = arr.map(value => Math.pow(value - avg, 2));
        return Math.sqrt(this.mean(squareDiffs));
    }

    // Update rolling repeat rate histories every N ticks (we'll call this periodically)
    updateRepeatRateHistories() {
        if (this.tickHistory.length < this.repeatRateWindow + 1) return;

        // 1. Update global repeat rate
        const globalRate = this.getGlobalRepeatRate(this.repeatRateWindow);
        this.globalRepeatRates.push(globalRate);
        if (this.globalRepeatRates.length > this.repeatRateLookback) {
            this.globalRepeatRates.shift();
        }

        // 2. Update per-digit repeat rates
        for (let digit = 0; digit <= 9; digit++) {
            const digitRate = this.getDigitRepeatRate(digit, this.repeatRateWindow);
            this.digitRepeatRateHistory[digit].push(digitRate);
            if (this.digitRepeatRateHistory[digit].length > this.repeatRateLookback) {
                this.digitRepeatRateHistory[digit].shift();
            }
        }
    }

    analyzeTicksEnhanced() {
        if (this.tradeInProgress) return;

        const currentDigit = this.tickHistory[this.tickHistory.length - 1];

        // Ensure we have enough history to compute stats
        if (this.globalRepeatRates.length < 25 || 
            this.digitRepeatRateHistory[currentDigit].length < 25) {
            console.log('🟡 Insufficient repeat-rate history. Skipping trade.', this.digitRepeatRateHistory[currentDigit].length);
            return;
        }

        // Get latest repeat rates
        const currentGlobalRate = this.getGlobalRepeatRate(this.repeatRateWindow);
        const currentDigitRate = this.getDigitRepeatRate(currentDigit, this.repeatRateWindow);

        // Compute baseline stats from history
        const globalMean = this.mean(this.globalRepeatRates);
        const globalStd = this.stdDev(this.globalRepeatRates) || 0.01; // Avoid div/0

        const digitMean = this.mean(this.digitRepeatRateHistory[currentDigit]);
        const digitStd = this.stdDev(this.digitRepeatRateHistory[currentDigit]) || 0.01;

        // Compute z-scores
        const globalZ = (currentGlobalRate - globalMean) / globalStd;
        const digitZ = (currentDigitRate - digitMean) / digitStd;

        // Only trade if BOTH z-scores are significantly positive (high repetition anomaly)
        const isGlobalAnomaly = globalZ > this.zScoreThreshold;
        const isDigitAnomaly = digitZ > this.zScoreThreshold2;

        console.log(
            `📊 Z-Scores → Global: ${globalZ.toFixed(2)} (rate: ${(currentGlobalRate*100).toFixed(1)}%), ` +
            `Digit ${currentDigit}: ${digitZ.toFixed(2)} (rate: ${(currentDigitRate*100).toFixed(1)}%)`
        );

        const globalRate = (currentGlobalRate*100).toFixed(1);
        const digitRate = (currentDigitRate*100).toFixed(1);
        const digitZ2 = digitZ.toFixed(2);

        // if (isGlobalAnomaly && isDigitAnomaly) {
        // if (globalRate < 10 && digitRate <= 6) {
        if (digitZ2 >= 5 || digitZ2 < -3.0) {
            console.log(`✅ HIGH-CONFIDENCE SETUP: Placing trade on digit ${currentDigit}`);
            this.placeTrade(currentDigit);
        } else {
            console.log(`⏸️ No trade: Conditions not met.`);
            this.tradeInProgress = false;
        }
    }

    placeTrade(predictedDigit) {
        if (this.tradeInProgress) {
            return;
        }
        this.tradeInProgress = true;
        console.log(`\n PLACING TRADE`);
        console.log(`Digit: ${predictedDigit}`);
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
        const exitSpot = contract.exit_tick_display_value;
        const actualDigit = this.getLastDigit(parseFloat(exitSpot), this.currentAsset);
        this.actualDigit = actualDigit;
        console.log(`\n📊 TRADE RESULT: ${won ? '✅ WON' : '❌ LOST'}`);
        console.log(` Predicted to differ from: ${this.xDigit} | Actual: ${actualDigit}`);
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
        // if (!won) {
        // this.sendLossEmail();
        // }
        // this.Pause = true;
        // this.RestartTrading = true;
        if (!this.endOfDay) {
            this.logTradingSummary();
        }
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
        // this.disconnect();
        if (!this.endOfDay) {
            this.waitTime = Math.floor(Math.random() * (1000 - 1000 + 1)) + 500;
            console.log(`⏳ Waiting ${Math.round(this.waitTime / 1000)} seconds before next trade...\n`);
            // setTimeout(() => {
                this.Pause = false;
                this.kTrade = false;
                // this.tickHistory = [];
                // this.LossDigitsList = [];
                this.tradeInProgress = false;
                // this.connect();
            // }, this.waitTime);
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
                this.tickHistory = [];
                this.tradeInProgress = false;
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
        }, 5000); // Check every 5 seconds
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
        console.log(`Consecutive Losses: x2:${this.consecutiveLosses2} x3:${this.consecutiveLosses3} x4:${this.consecutiveLosses4}`);
        console.log(`Total P/L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log('Predicted Digit:', this.xDigit);
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
            subject: 'Qwan Deriv Differ Bot - Trading Summary',
            text: summaryText
        };
        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Email sending error:', error);
        }
    }
    async sendLossEmail() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const klastDigits = this.tickHistory.slice(-20);

        const currentGlobalRate = this.getGlobalRepeatRate(200);
        const globalMean = this.mean(this.globalRepeatRates);
        const globalZ = this.globalRepeatRates.length > 0 
            ? (currentGlobalRate - globalMean) / (this.stdDev(this.globalRepeatRates) || 0.01) 
            : 0;

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
       
        x2:${this.consecutiveLosses2}
        x3:${this.consecutiveLosses3}
        x4:${this.consecutiveLosses4}
       
        Pattern Analysis:
        ----------------
        Asset: ${this.currentAsset}
        Predicted Digit: ${this.xDigit} | Actual Digit: ${this.actualDigit}
        Percentage: ${this.winProbNumber}%
       
        Recent History:
        --------------
        Last 20 Digits: ${klastDigits.join(', ')}
       
        Current Stake: $${this.currentStake.toFixed(2)}

        Z-Score Analysis:
        -----------------
        Current Global Z-Score: ${globalZ.toFixed(2)}
        `;
        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Qwan Deriv Deriv Bot - Loss Alert',
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
            subject: 'Qwan Deriv Deriv Bot - Error Report',
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
            subject: 'Qwan Deriv Deriv Bot - Status Update',
            text: summaryText
        };
        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Email sending error:', error);
        }
    }
    start() {
        this.connect();
        // this.checkTimeForDisconnectReconnect();
    }
}
// Usage
const bot = new EnhancedDerivTradingBot('rgNedekYXvCaPeP', {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir'
    initialStake: 0.61,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    maxStake: 127,
    stopLoss: 86,
    takeProfit: 5,
});
bot.start();
