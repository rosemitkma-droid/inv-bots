const WebSocket = require('ws');
const nodemailer = require('nodemailer');

// EnhancedDerivTradingBot class with Advanced Repetition Pattern Analysis
class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            // 'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR', '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V', 'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            'R_75',
        ];

        this.config = {
            initialStake: config.initialStake,
            multiplier: config.multiplier,
            maxConsecutiveLosses: config.maxConsecutiveLosses,
            takeProfit: config.takeProfit,
            stopLoss: config.stopLoss,
            // Repetition filter configuration
            minWindowSize: config.minWindowSize || 100,
            maxWindowSize: config.maxWindowSize || 500,
            overallRepetitionHighThreshold: config.overallRepetitionHighThreshold || 0.15,
            overallRepetitionLowThreshold: config.overallRepetitionLowThreshold || 0.05,
            individualRepetitionHighThreshold: config.individualRepetitionHighThreshold || 0.25,
            individualRepetitionLowThreshold: config.individualRepetitionLowThreshold || 0.02,
            minConfidenceScore: config.minConfidenceScore || 0.65,
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
        this.requiredHistoryLength = 10000;
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

        // New properties for repetition analysis
        this.repetitionMetrics = {
            overallRate: 0,
            individualRates: {},
            recentTrend: 'neutral',
            confidenceScore: 0,
            signalStrength: 'none'
        };
        this.tradesSkipped = 0;
        this.tradesExecuted = 0;

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

        console.log(`Recent tick History: ${this.tickHistory.slice(-5).join(', ')}`);
        console.log('Current Digit:', this.tickHistory[this.tickHistory.length - 1]);

        if (!this.tradeInProgress) {
            this.analyzeTicksWithRepetitionFilter();
        }
    }

    /**
     * CORE REPETITION ANALYSIS METHOD
     * Analyzes tick history to determine if conditions are favorable for trading
     */
    analyzeTicksWithRepetitionFilter() {
        if (this.tradeInProgress || this.tickHistory.length < this.config.minWindowSize) {
            return;
        }

        this.lastDigit = this.tickHistory[this.tickHistory.length - 1];
        this.xDigit = this.lastDigit;

        // Perform comprehensive repetition analysis
        const analysis = this.performRepetitionAnalysis();
        
        // Store metrics for logging
        this.repetitionMetrics = analysis;

        // Log detailed analysis
        this.logRepetitionAnalysis(analysis);

        // Determine if we should execute the trade
        if (analysis.shouldTrade) {
            console.log(`\n✅ TRADE CONDITIONS FAVORABLE - Confidence: ${(analysis.confidenceScore * 100).toFixed(1)}%`);
            this.tradesExecuted++;
            this.placeTrade(this.xDigit);
        } else {
            console.log(`\n❌ TRADE CONDITIONS UNFAVORABLE - Signal: ${analysis.signalStrength.toUpperCase()}`);
            console.log(`   Skipping this opportunity. Waiting for better conditions...\n`);
            this.tradesSkipped++;
            this.tradeInProgress = false;
        }
    }

    /**
     * Performs comprehensive repetition pattern analysis
     * Returns object with analysis results and trading recommendation
     */
    performRepetitionAnalysis() {
        const windowSizes = [100, 200, 300, 500];
        const analyses = [];

        // Analyze multiple time windows
        for (const windowSize of windowSizes) {
            if (this.tickHistory.length >= windowSize) {
                const window = this.tickHistory.slice(-windowSize);
                const analysis = this.analyzeWindow(window, windowSize);
                analyses.push(analysis);
            }
        }

        // Aggregate results across all windows
        const aggregated = this.aggregateAnalyses(analyses);
        
        // Calculate confidence score and determine if should trade
        const confidenceScore = this.calculateConfidenceScore(aggregated);
        const shouldTrade = confidenceScore >= this.config.minConfidenceScore;

        return {
            ...aggregated,
            confidenceScore,
            shouldTrade,
            analyses: analyses
        };
    }

    /**
     * Analyzes a specific window of tick history
     */
    analyzeWindow(window, windowSize) {
        // Calculate overall repetition rate
        let repetitions = 0;
        for (let i = 1; i < window.length; i++) {
            if (window[i] === window[i - 1]) {
                repetitions++;
            }
        }
        const overallRepetitionRate = repetitions / (window.length - 1);

        // Calculate individual digit repetition rates
        const digitRepetitionRates = {};
        for (let digit = 0; digit <= 9; digit++) {
            const digitOccurrences = [];
            for (let i = 0; i < window.length; i++) {
                if (window[i] === digit) {
                    digitOccurrences.push(i);
                }
            }

            if (digitOccurrences.length > 1) {
                let digitRepetitions = 0;
                for (let j = 1; j < digitOccurrences.length; j++) {
                    if (digitOccurrences[j] - digitOccurrences[j - 1] === 1) {
                        digitRepetitions++;
                    }
                }
                digitRepetitionRates[digit] = digitRepetitions / (digitOccurrences.length - 1);
            } else {
                digitRepetitionRates[digit] = 0;
            }
        }

        // Get current digit's repetition rate
        const currentDigitRate = digitRepetitionRates[this.lastDigit] || 0;

        // Analyze recent trend (last 20 ticks)
        const recentWindow = window.slice(-20);
        let recentRepetitions = 0;
        for (let i = 1; i < recentWindow.length; i++) {
            if (recentWindow[i] === recentWindow[i - 1]) {
                recentRepetitions++;
            }
        }
        const recentRepetitionRate = recentRepetitions / (recentWindow.length - 1);

        // Determine trend
        let trend = 'neutral';
        if (recentRepetitionRate > overallRepetitionRate * 1.5) {
            trend = 'increasing';
        } else if (recentRepetitionRate < overallRepetitionRate * 0.5) {
            trend = 'decreasing';
        }

        return {
            windowSize,
            overallRepetitionRate,
            digitRepetitionRates,
            currentDigitRate,
            recentRepetitionRate,
            trend
        };
    }

    /**
     * Aggregates analyses from multiple windows
     */
    aggregateAnalyses(analyses) {
        if (analyses.length === 0) {
            return {
                overallRate: 0,
                currentDigitRate: 0,
                recentTrend: 'neutral',
                signalStrength: 'none'
            };
        }

        // Weight recent windows more heavily
        const weights = analyses.map((_, idx) => idx + 1);
        const totalWeight = weights.reduce((a, b) => a + b, 0);

        let weightedOverallRate = 0;
        let weightedCurrentDigitRate = 0;
        const trends = [];

        analyses.forEach((analysis, idx) => {
            const weight = weights[idx] / totalWeight;
            weightedOverallRate += analysis.overallRepetitionRate * weight;
            weightedCurrentDigitRate += analysis.currentDigitRate * weight;
            trends.push(analysis.trend);
        });

        // Determine dominant trend
        const trendCounts = { increasing: 0, decreasing: 0, neutral: 0 };
        trends.forEach(trend => trendCounts[trend]++);
        const recentTrend = Object.keys(trendCounts).reduce((a, b) => 
            trendCounts[a] > trendCounts[b] ? a : b
        );

        // Determine signal strength
        let signalStrength = 'none';
        
        // Check for extreme overall repetition conditions
        if (weightedOverallRate >= this.config.overallRepetitionHighThreshold) {
            signalStrength = 'strong_high_overall';
            console.log('High overall repetition detected', weightedOverallRate);
        } else if (weightedOverallRate <= this.config.overallRepetitionLowThreshold) {
            signalStrength = 'strong_low_overall';
            console.log('Low overall repetition detected', weightedOverallRate);
        }
        
        // Check for extreme individual digit repetition conditions
        if (weightedCurrentDigitRate >= this.config.individualRepetitionHighThreshold) {
            signalStrength = signalStrength === 'none' ? 'strong_high_individual' : 'very_strong_high';
            console.log('High individual digit repetition detected', weightedCurrentDigitRate);
        } else if (weightedCurrentDigitRate <= this.config.individualRepetitionLowThreshold) {
            signalStrength = signalStrength === 'none' ? 'strong_low_individual' : 'very_strong_low';
            console.log('Low individual digit repetition detected', weightedCurrentDigitRate);
        }

        // Moderate signals
        // if (signalStrength === 'none') {
        //     if (weightedOverallRate >= this.config.overallRepetitionHighThreshold * 0.8 ||
        //         weightedOverallRate <= this.config.overallRepetitionLowThreshold * 1.2) {
        //         signalStrength = 'moderate';
        //     }
        // }

        return {
            overallRate: weightedOverallRate,
            currentDigitRate: weightedCurrentDigitRate,
            recentTrend,
            signalStrength
        };
    }

    /**
     * Calculates confidence score based on aggregated analysis
     */
    calculateConfidenceScore(aggregated) {
        let score = 0;

        // Base score from signal strength
        const signalScores = {
            'very_strong_high': 0.95,
            'very_strong_low': 0.95,
            'strong_high_overall': 0.80,
            'strong_low_overall': 0.80,
            'strong_high_individual': 0.75,
            'strong_low_individual': 0.75,
            'moderate': 0.60,
            'none': 0.40
        };
        
        score = signalScores[aggregated.signalStrength] || 0.40;

        // Adjust based on trend consistency
        if (aggregated.recentTrend === 'increasing' && aggregated.overallRate >= this.config.overallRepetitionHighThreshold) {
            score += 0.05; // Recent high repetition makes non-repeat more likely
        } else if (aggregated.recentTrend === 'decreasing' && aggregated.overallRate <= this.config.overallRepetitionLowThreshold) {
            score += 0.05; // Recent low repetition makes non-repeat more likely
        }

        // Adjust based on current digit specific pattern
        if (aggregated.currentDigitRate >= this.config.individualRepetitionHighThreshold) {
            score += 0.05; // This specific digit repeats a lot, unlikely to continue
        } else if (aggregated.currentDigitRate <= this.config.individualRepetitionLowThreshold) {
            score += 0.05; // This specific digit rarely repeats
        }

        // Ensure score is between 0 and 1
        return Math.min(Math.max(score, 0), 1);
    }

    /**
     * Logs detailed repetition analysis
     */
    logRepetitionAnalysis(analysis) {
        console.log('\n' + '═'.repeat(60));
        console.log('📊 REPETITION PATTERN ANALYSIS');
        console.log('═'.repeat(60));
        console.log(`Current Digit: ${this.lastDigit}`);
        console.log(`Overall Repetition Rate: ${(analysis.overallRate * 100).toFixed(2)}%`);
        console.log(`Current Digit (${this.lastDigit}) Rep Rate: ${(analysis.currentDigitRate * 100).toFixed(2)}%`);
        console.log(`Recent Trend: ${analysis.recentTrend.toUpperCase()}`);
        console.log(`Signal Strength: ${analysis.signalStrength.toUpperCase()}`);
        console.log(`Confidence Score: ${(analysis.confidenceScore * 100).toFixed(1)}%`);
        console.log(`Trade Decision: ${analysis.shouldTrade ? '✅ EXECUTE' : '❌ SKIP'}`);
        console.log('─'.repeat(60));
        console.log(`Trades Executed: ${this.tradesExecuted} | Skipped: ${this.tradesSkipped}`);
        console.log(`Execution Rate: ${this.tradesExecuted + this.tradesSkipped > 0 ? 
            ((this.tradesExecuted / (this.tradesExecuted + this.tradesSkipped)) * 100).toFixed(1) : 0}%`);
        console.log('═'.repeat(60));
    }

    placeTrade(predictedDigit) {
        if (this.tradeInProgress) {
            return;
        }

        this.tradeInProgress = true;

        console.log(`\n🎯 PLACING TRADE`);
        console.log(`Predicted to differ from: ${predictedDigit}`);
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
        console.log(`   Predicted to differ from: ${this.xDigit} | Actual: ${actualDigit}`);
        console.log(`   Profit/Loss: $${profit.toFixed(2)}`);
        console.log(`   Confidence Score: ${(this.repetitionMetrics.confidenceScore * 100).toFixed(1)}%`);

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
        }

        this.totalProfitLoss += profit;

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

        if (!this.endOfDay) {
            this.waitTime = Math.floor(Math.random() * (1000 - 1000 + 1)) + 500;
            console.log(`⏳ Waiting ${Math.round(this.waitTime / 1000)} seconds before next trade...\n`);
            this.Pause = false;
            this.kTrade = false;
            this.tradeInProgress = false;
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
            const currentDay = gmtPlus1Time.getUTCDay();

            if (currentDay === 0) {
                if (!this.endOfDay) {
                    console.log("It's Sunday, disconnecting the bot. No trading on Sundays.");
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
                return;
            }

            if (this.endOfDay && currentHours === 7 && currentMinutes >= 0) {
                console.log("It's 7:00 AM GMT+1, reconnecting the bot.");
                this.LossDigitsList = [];
                this.tickHistory = [];
                this.tradeInProgress = false;
                this.RestartTrading = true;
                this.Pause = false;
                this.endOfDay = false;
                this.tradesSkipped = 0;
                this.tradesExecuted = 0;
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
        console.log(`Consecutive Losses: x2:${this.consecutiveLosses2} x3:${this.consecutiveLosses3} x4:${this.consecutiveLosses4}`);
        console.log(`Total P/L: ${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Current Stake: ${this.currentStake.toFixed(2)}`);
        console.log(`Filter Performance: Executed ${this.tradesExecuted} | Skipped ${this.tradesSkipped}`);
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
        ENHANCED TRADING BOT SUMMARY (With Repetition Filter)
        ====================================================
        
        Performance Metrics:
        -------------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        
        Filter Performance:
        ------------------
        Trades Executed: ${this.tradesExecuted}
        Trades Skipped: ${this.tradesSkipped}
        Execution Rate: ${this.tradesExecuted + this.tradesSkipped > 0 ? 
            ((this.tradesExecuted / (this.tradesExecuted + this.tradesSkipped)) * 100).toFixed(1) : 0}%
        
        Loss Analysis:
        -------------
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}
        
        Financial Summary:
        -----------------
        Total P/L: ${this.totalProfitLoss.toFixed(2)}
        Current Stake: ${this.currentStake.toFixed(2)}
        
        Latest Analysis:
        ---------------
        Overall Rep Rate: ${(this.repetitionMetrics.overallRate * 100).toFixed(2)}%
        Current Digit Rep Rate: ${(this.repetitionMetrics.currentDigitRate * 100).toFixed(2)}%
        Signal Strength: ${this.repetitionMetrics.signalStrength}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'claude Differ Repetition Filter Bot - Trading Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // Silent fail
        }
    }

    async sendLossEmail() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const klastDigits = this.tickHistory.slice(-20);

        const summaryText = `
        LOSS ALERT - DETAILED ANALYSIS
        ===============================
        
        Trade Result: LOSS
        
        Performance Metrics:
        -------------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        Total P/L: ${this.totalProfitLoss.toFixed(2)}
        
        x2:${this.consecutiveLosses2} 
        x3:${this.consecutiveLosses3} 
        x4:${this.consecutiveLosses4}        
        
        Pattern Analysis:
        ----------------
        Asset: ${this.currentAsset}
        Predicted Digit: ${this.xDigit} | Actual Digit: ${this.actualDigit}
        Confidence Score: ${(this.repetitionMetrics.confidenceScore * 100).toFixed(1)}%
        Signal Strength: ${this.repetitionMetrics.signalStrength}
        Overall Rep Rate: ${(this.repetitionMetrics.overallRate * 100).toFixed(2)}%
        
        Recent History:
        --------------
        Last 20 Digits: ${klastDigits.join(', ')}
        
        Current Stake: ${this.currentStake.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'claude Differ Repetition Filter Bot - Loss Alert',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // Silent fail
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'claude Differ Repetition Filter Bot - Error Report',
            text: `An error occurred in the trading bot: ${errorMessage}`
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // Silent fail
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
       
        Filter Performance:
        ------------------
        Trades Executed: ${this.tradesExecuted}
        Trades Skipped: ${this.tradesSkipped}
        
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        
        Financial Summary:
        -----------------
        Total P/L: ${this.totalProfitLoss.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'claude Differ Repetition Filter Bot - Status Update',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // Silent fail
        }
    }

    start() {
        this.connect();
        // Uncomment to enable time-based disconnect/reconnect
        // this.checkTimeForDisconnectReconnect();
    }
}

// Usage Example
const bot = new EnhancedDerivTradingBot('0P94g4WdSrSrzir', {
    initialStake: 0.61,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    maxStake: 127,
    stopLoss: 70,
    takeProfit: 2.5,
    
    // Repetition filter configuration (adjust these based on testing)
    minWindowSize: 100,              // Minimum history to analyze
    maxWindowSize: 500,              // Maximum window size
    overallRepetitionHighThreshold: 0.15,   // 15% overall repetition is high
    overallRepetitionLowThreshold: 0.05,    // 5% overall repetition is low
    individualRepetitionHighThreshold: 0.25, // 25% for specific digit is high
    individualRepetitionLowThreshold: 0.02,  // 2% for specific digit is low
    minConfidenceScore: 0.65,        // Minimum confidence to execute trade (65%)
});

bot.start();
