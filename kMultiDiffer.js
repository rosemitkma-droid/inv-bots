require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const crypto = require('crypto');


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
        let arraySamples = [];

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
                    arraySamples = analysis1.arraySamples;
                }
            }
        }

        if (bestPrediction !== null) {
            return {
                shouldTrade: true,
                predictedDigit: bestPrediction,
                confidence: bestConfidence,
                patternType: bestPatternType,
                samples: bestSamples,
                arraySamples: arraySamples
            };
        }

        return { shouldTrade: false, confidence: 0 };
    }

    findSafeDigitForPattern(history, pattern) {
        const patternLen = pattern.length;
        const nextDigitCounts = Array(10).fill(0);
        let totalOccurrences = 0;
        let arraySamples = [];

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
        // console.log('Next Digit Counts:', nextDigitCounts);
        console.log('Total Occurrences:', totalOccurrences);

        if (totalOccurrences < this.minSamples) {
            return null;
        }

        // Identify digits that have NEVER appeared after this pattern
        const safeDigits = [];
        for (let d = 0; d < 10; d++) {
            if (nextDigitCounts[d] === 66) {//>=66
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

            arraySamples = nextDigitCounts;

            console.log('Best Digit:', bestDigit);

            console.log('Confidence:', confidence);

            return {
                isSafe: true,
                digit: bestDigit,
                confidence: confidence,
                samples: totalOccurrences,
                arraySamples: arraySamples
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

class PatternAnalyzer2 {
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
        let arraySamples = [];

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
                    arraySamples = analysis1.arraySamples;
                }
            }
        }

        if (bestPrediction !== null) {
            return {
                shouldTrade: true,
                predictedDigit: bestPrediction,
                confidence: bestConfidence,
                patternType: bestPatternType,
                samples: bestSamples,
                arraySamples: arraySamples
            };
        }

        return { shouldTrade: false, confidence: 0 };
    }

    findSafeDigitForPattern(history, pattern) {
        const patternLen = pattern.length;
        const nextDigitCounts = Array(10).fill(0);
        let totalOccurrences = 0;
        let arraySamples = [];

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

        // console.log('Pattern2:', pattern, 'Length:', patternLen);
        // console.log('Next Digit Counts2:', nextDigitCounts);
        // console.log('Total Occurrences2:', totalOccurrences);

        if (totalOccurrences < this.minSamples) {
            return null;
        }

        // Identify digits that have NEVER appeared after this pattern
        const safeDigits = [];
        for (let d = 0; d < 10; d++) {
            if (nextDigitCounts[d] <= 36) {//<= 36
                safeDigits.push(d);
            }
        }

        // console.log('Safe Digits:', safeDigits);

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

            arraySamples = nextDigitCounts;

            // console.log('Best Digit:', bestDigit);

            // console.log('Confidence:', confidence);

            return {
                isSafe: true,
                digit: bestDigit,
                confidence: confidence,
                samples: totalOccurrences,
                arraySamples: arraySamples
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
            'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR',
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
            volatilityThreshold: config.volatilityThreshold || 2, // std dev of last 5 digits
            volatilityThreshold2: config.volatilityThreshold2 || 1.5,
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
        this.sys = null;
        this.patternAnalyzer = new PatternAnalyzer();// Advanced pattern analyzer
        this.patternAnalyzer2 = new PatternAnalyzer2();// Advanced pattern analyzer
        this.volatility = 0;
        this.totalOccurences = 0;


        // Initialize per-asset storage
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.lastDigits[asset] = null;
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

        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.tickHistories2[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
            this.lastDigits[asset] = null;
        });
        this.tickSubscriptionIds = {};

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
                this.lastDigits[asset] = null;
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

        console.log(`[${asset}] ${tick.quote} → Last 5: ${this.tickHistories[asset].slice(-5).join(', ')}`);

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            console.log(`⏳ [${asset}] Buffering... (${this.tickHistories[asset].length}/${this.config.requiredHistoryLength})`);
            return;
        }

        if (!this.tradeInProgress) {
            // Update pattern analyzer with new history
            if (!this.tradeInProgress) {
                this.patternAnalyzer.analyzeHistory(this.tickHistories[asset]);
                this.patternAnalyzer2.analyzeHistory(this.tickHistories[asset]);
            }

            // Analyze ticks
            this.analyzeTicks(asset);
        }
    }

    // ========= 🎯 CORE LOGIC: ADAPTIVE MEAN-REVERSION DIGIT SELECTOR =========
    analyzeTicks(asset) {
        if (this.tradeInProgress) return;

        const history = this.tickHistories[asset];
        if (history.length < 100) return;

        // Get pattern analysis
        const analysis = this.patternAnalyzer.analyze(history);
        const analysis2 = this.patternAnalyzer2.analyze(history);

        if (analysis.shouldTrade) {
            const confidence = analysis.confidence;
            const confidence2 = analysis2.confidence;
            const predictedDigit = analysis.predictedDigit;
            const predictedDigit2 = analysis2.predictedDigit;
            const arraySamples = analysis.arraySamples;

            console.log('Array Samples:', arraySamples);

            // console.log(`Pattern Analysis: Type=${analysis.patternType}, Target=${predictedDigit}, Conf=${confidence.toFixed(1)}%, Samples=${analysis.samples}`);
            // console.log(`Pattern Analysis 2: Type=${analysis2.patternType}, Target=${predictedDigit2}, Conf=${confidence2.toFixed(1)}%, Samples=${analysis2.samples}`);

            // Trade if confidence is high enough
            // We set a high bar for "100% certainty"
            if (this.sys !== 1 && confidence >= 98 && analysis.samples >= 500 && this.tickHistories[asset][this.tickHistories[asset].length - 1] !== predictedDigit) {
                console.log(`Pattern Found: [${analysis.patternType}] -> Predict NOT ${analysis.predictedDigit} (Conf: ${analysis.confidence}%, Samples: ${analysis.samples})`);
                // ▼▼▼ VOLATILITY FILTER ▼▼▼
                const recentDigits = history.slice(-5);
                const volStdDev = this.standardDeviation(recentDigits);
                if (volStdDev > this.config.volatilityThreshold && volStdDev < this.config.volatilityThreshold2) {
                    console.log(`🔇 [${asset}] High volatility (${volStdDev.toFixed(2)}). Skipping trade.`);
                    return;
                }
                console.log(`🔇 [${asset}] volatility (${volStdDev.toFixed(2)})`);
                this.xDigit = predictedDigit;
                this.confidenceThreshold = confidence;
                this.sys = 1;
                this.volatility = volStdDev;
                this.totalOccurences = analysis.samples;
                this.arraySamples = arraySamples;
                this.placeTrade(asset, predictedDigit, confidence);
            } else if (this.sys !== 2 && confidence2 >= 98 && analysis2.samples >= 500 && this.tickHistories[asset][this.tickHistories[asset].length - 1] !== predictedDigit2) {
                console.log(`Pattern Found2: [${analysis2.patternType}] -> Predict NOT ${analysis2.predictedDigit} (Conf: ${analysis2.confidence}%, Samples: ${analysis2.samples})`);
                // ▼▼▼ VOLATILITY FILTER ▼▼▼
                const recentDigits = history.slice(-5);
                const volStdDev = this.standardDeviation(recentDigits);
                if (volStdDev > this.config.volatilityThreshold && volStdDev < this.config.volatilityThreshold2) {
                    console.log(`🔇 [${asset}] High volatility (${volStdDev.toFixed(2)}). Skipping trade.`);
                    return;
                }
                console.log(`🔇 [${asset}] volatility (${volStdDev.toFixed(2)})`);
                this.xDigit = predictedDigit2;
                this.confidenceThreshold = confidence2;
                this.sys = 2;
                this.volatility = volStdDev;
                this.totalOccurences = analysis2.samples;
                this.arraySamples = arraySamples;
                this.placeTrade(asset, predictedDigit2, confidence2);
            }
        }
    }

    standardDeviation(values) {
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const squareDiffs = values.map(value => Math.pow(value - avg, 2));
        const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;
        return Math.sqrt(avgSquareDiff);
    }



    placeTrade(asset, predictedDigit, confidence) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.xDigit = predictedDigit;

        console.log(`🚀 [${asset}] Placing trade → Digit: ${predictedDigit} | Confidence: ${confidence}% | Stake: $${this.currentStake} | System: ${this.sys}`);
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

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
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
            // Suspend the asset after a trade
            this.suspendAsset(asset);
        } else {
            this.sys = null;
        }

        // If there are suspended assets, reactivate the first one on win
        if (this.suspendedAssets.size > 1) {
            const firstSuspendedAsset = Array.from(this.suspendedAssets)[0];
            this.reactivateAsset(firstSuspendedAsset);
        }

        this.patternAnalyzer = new PatternAnalyzer();// Advanced pattern analyzer
        this.patternAnalyzer2 = new PatternAnalyzer2();// Advanced pattern analyzer

        // Suspend the asset after a trade
        // this.suspendAsset(asset);

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

            // Optional: log current GMT+1 time for monitoring
            // console.log(
            // "Current GMT+1 time:",
            // gmtPlus1Time.toISOString().replace("T", " ").substring(0, 19)
            // );

            // Check for Morning resume condition (7:00 AM GMT+1)
            if (this.endOfDay && currentHours === 7 && currentMinutes >= 0) {
                console.log("It's 7:00 AM GMT+1, reconnecting the bot.");
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
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendEmailSummary();
            }
        }, 1800000); // 30 Minutes
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
            subject: 'kMultiDiffer - Summary',
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
        Volatility: ${this.volatility}
        Total Occurences: ${this.totalOccurences}
        Array Samples: [${this.arraySamples}]
        System: ${this.system}
        
        Last 20 Digits: ${lastFewTicks.join(', ')} 

        Current Stake: $${this.currentStake.toFixed(2)}

        Waiting for: ${this.waitTime} minutes before next trade...
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'kMultiDiffer - Loss Alert',
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
            subject: 'kMultiDiffer - Connection/Dissconnection Summary',
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
            subject: 'kMultiDiffer - Error Report',
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
const bot = new EnhancedDigitDifferTradingBot('hsj0tA0XJoIzJG5', {
    initialStake: 0.61,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 129,
    takeProfit: 5000,
    requiredHistoryLength: 5000,
    winProbabilityThreshold: 0.6,
    minWaitTime: 2000, //5 Minutes
    maxWaitTime: 5000, //1 Hour
    minOccurrencesThreshold: 1,
});

bot.start();

