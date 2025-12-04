/**
 * Deriv Digit Differ Trading Bot v2.0
 * 
 * Improved version with:
 * - Rigorous statistical analysis on 5000 ticks
 * - Strict trading conditions
 * - Clean, maintainable code
 * - Proper risk management
 * 
 * DISCLAIMER: No trading bot can guarantee 100% success.
 * This bot is designed to maximize probability of winning
 * by only trading under optimal conditions.
 */

const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const config = require('./config');
const StatisticalAnalyzer = require('./StatisticalAnalyzer');

class DerivDigitDifferBot {
    constructor() {
        // Core state
        this.ws = null;
        this.connected = false;
        this.authorized = false;

        // Trading state
        this.currentAsset = null;
        this.tickHistory = [];
        this.tradeInProgress = false;
        this.currentContractId = null;
        this.lastPredictedDigit = null;

        // Financial tracking
        this.currentStake = config.TRADING.initialStake;
        this.totalProfitLoss = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.maxConsecutiveLosses = 0;
        this.endOfDay = false;
        this.isWinTrade = false;

        // Connection management
        this.reconnectAttempts = 0;
        this.tickSubscriptionId = null;

        // Initialize analyzer
        this.analyzer = new StatisticalAnalyzer(config.ANALYSIS);

        // Session tracking
        this.sessionStartTime = null;
        this.isRunning = false;

        // Start email timer
        this.startSummaryEmailTimer();
    }

    /**
     * Start the bot
     */
    start() {
        this.printBanner();
        this.sessionStartTime = new Date();
        this.isRunning = true;
        this.connect();
        // this.checkTimeForDisconnectReconnect();
    }

    /**
     * Print startup banner
     */
    printBanner() {
        console.log('\n');
        console.log('╔══════════════════════════════════════════════════════════╗');
        console.log('║       DERIV DIGIT DIFFER BOT v2.0                       ║');
        console.log('║       Statistical Analysis Trading System               ║');
        console.log('╠══════════════════════════════════════════════════════════╣');
        console.log(`║  Min History Required: ${config.ANALYSIS.minHistoryLength} ticks                       ║`);
        console.log(`║  Min Confidence: ${(config.ANALYSIS.minConfidence * 100).toFixed(0)}%                                 ║`);
        console.log(`║  Max Repetition Rate: ${(config.ANALYSIS.maxRepetitionRate * 100).toFixed(0)}%                              ║`);
        console.log(`║  Initial Stake: $${config.TRADING.initialStake.toFixed(2)}                                ║`);
        console.log('╚══════════════════════════════════════════════════════════╝');
        console.log('\n');
    }

    /**
     * Connect to Deriv WebSocket API
     */
    connect() {
        if (!this.endOfDay) {
            console.log('🔌 Connecting to Deriv API...');

            this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            this.ws.on('open', () => {
                console.log('✅ WebSocket connected');
                this.connected = true;
                this.reconnectAttempts = 0;
                this.authenticate();
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Error parsing message:', error);
                }
            });

            this.ws.on('error', (error) => {
                console.error('❌ WebSocket error:', error.message);
            });

            this.ws.on('close', () => {
                console.log('🔌 WebSocket disconnected');
                this.connected = false;
                this.authorized = false;

                if (this.isRunning) {
                    this.handleReconnect();
                }
            });
        }
    }

    /**
     * Handle reconnection logic
     */
    handleReconnect() {
        if (!this.endOfDay) {
            if (this.reconnectAttempts >= config.TIMING.maxReconnectAttempts) {
                console.error('❌ Max reconnection attempts reached. Stopping bot.');
                this.stop();
                return;
            }

            this.reconnectAttempts++;
            console.log(`🔄 Reconnecting in ${config.TIMING.reconnectInterval / 1000}s... (Attempt ${this.reconnectAttempts})`);

            setTimeout(() => {
                if (this.isRunning) {
                    this.connect();
                }
            }, config.TIMING.reconnectInterval);
        }
    }

    /**
     * Send request to API
     */
    send(request) {
        if (this.connected && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(request));
        } else {
            console.warn('⚠️ Cannot send request - not connected');
        }
    }

    /**
     * Authenticate with API token
     */
    authenticate() {
        console.log('🔐 Authenticating...');
        this.send({ authorize: config.API_TOKEN });
    }

    /**
     * Handle incoming messages
     */
    handleMessage(message) {
        const { msg_type, error } = message;

        if (error) {
            this.handleError(error);
            return;
        }

        switch (msg_type) {
            case 'authorize':
                this.handleAuthorize(message);
                break;
            case 'history':
                this.handleHistory(message);
                break;
            case 'tick':
                this.handleTick(message);
                break;
            case 'buy':
                this.handleBuy(message);
                break;
            case 'proposal_open_contract':
                this.handleContractUpdate(message);
                break;
            case 'forget':
                // Subscription cancelled
                break;
            default:
                // Ignore other message types
                break;
        }
    }

    /**
     * Handle authorization response
     */
    handleAuthorize(message) {
        if (message.authorize) {
            console.log('✅ Authentication successful');
            console.log(`   Account: ${message.authorize.loginid}`);
            console.log(`   Balance: $${parseFloat(message.authorize.balance).toFixed(2)}`);
            this.authorized = true;
            this.startTrading();
        }
    }

    /**
     * Handle API errors
     */
    handleError(error) {
        console.error(`❌ API Error: ${error.message} (${error.code})`);

        switch (error.code) {
            case 'InvalidToken':
                console.error('   Please check your API token in config.js');
                this.stop();
                break;
            case 'RateLimit':
                console.log('   Rate limited. Waiting 60 seconds...');
                setTimeout(() => this.startTrading(), 60000);
                break;
            case 'ContractBuyValidationError':
                console.log('   Contract validation error. Retrying...');
                this.tradeInProgress = false;
                break;
            default:
                // Continue operation
                break;
        }
    }

    /**
     * Start the trading loop
     */
    startTrading() {
        // Select asset
        this.currentAsset = config.ASSETS[0];
        console.log(`\n📊 Selected asset: ${this.currentAsset}`);

        // Reset history
        this.tickHistory = [];

        // Request historical data
        this.requestHistory();

        // Subscribe to live ticks
        this.subscribeTicks();
    }

    /**
     * Request tick history
     */
    requestHistory() {
        console.log(`📥 Requesting ${config.ANALYSIS.minHistoryLength} ticks of history...`);

        this.send({
            ticks_history: this.currentAsset,
            adjust_start_time: 1,
            count: config.ANALYSIS.minHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        });
    }

    /**
     * Subscribe to live tick updates
     */
    subscribeTicks() {
        this.send({
            ticks: this.currentAsset,
            subscribe: 1
        });
    }

    /**
     * Unsubscribe from ticks
     */
    unsubscribeTicks() {
        if (this.tickSubscriptionId) {
            this.send({ forget: this.tickSubscriptionId });
            this.tickSubscriptionId = null;
        }
    }

    /**
     * Handle historical tick data
     */
    handleHistory(message) {
        const { history } = message;

        if (!history || !history.prices) {
            console.error('❌ Invalid history data received');
            return;
        }

        // Convert prices to last digits
        this.tickHistory = history.prices.map(price => this.extractLastDigit(price));

        console.log(`✅ Loaded ${this.tickHistory.length} historical ticks`);
        this.logAnalysisSummary();
    }

    /**
     * Handle live tick update
     */
    handleTick(message) {
        const { tick, subscription } = message;

        if (!tick) return;

        // Store subscription ID
        if (subscription) {
            this.tickSubscriptionId = subscription.id;
        }

        // Extract last digit
        const lastDigit = this.extractLastDigit(tick.quote);

        // Update history
        this.tickHistory.push(lastDigit);

        // Keep history at required length
        if (this.tickHistory.length > config.ANALYSIS.minHistoryLength) {
            this.tickHistory.shift();
        }

        // Log tick (condensed when not trading)
        if (!this.tradeInProgress) {
            this.logTick(tick.quote, lastDigit);
        }

        // Analyze and potentially trade
        if (!this.tradeInProgress && this.tickHistory.length >= config.ANALYSIS.minHistoryLength) {
            this.analyzeAndTrade();
        }
    }

    /**
     * Extract last digit from price
     */
    extractLastDigit(quote) {
        const quoteStr = quote.toString();
        const [, decimal = ''] = quoteStr.split('.');

        // Different assets have different decimal places
        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(this.currentAsset)) {
            return decimal.length >= 4 ? parseInt(decimal[3], 10) : 0;
        } else if (['R_10', 'R_25'].includes(this.currentAsset)) {
            return decimal.length >= 3 ? parseInt(decimal[2], 10) : 0;
        } else {
            return decimal.length >= 2 ? parseInt(decimal[1], 10) : 0;
        }
    }

    /**
     * Log tick information
     */
    logTick(quote, digit) {
        const historyLen = this.tickHistory.length;
        const required = config.ANALYSIS.minHistoryLength;

        if (historyLen < required) {
            // Show loading progress
            const progress = ((historyLen / required) * 100).toFixed(1);
            process.stdout.write(`\r⏳ Loading: ${historyLen}/${required} (${progress}%)    `);
        }
    }

    /**
     * Analyze conditions and decide whether to trade
     */
    analyzeAndTrade() {
        // Get analysis from statistical analyzer
        const analysis = this.analyzer.analyze(this.tickHistory);

        // Log analysis periodically (every 50 ticks)
        if (this.tickHistory.length % 50 === 0) {
            this.logAnalysisSummary();
        }

        // Check if we should trade
        if (!analysis.shouldTrade) {
            return;
        }

        // Additional safety check: Don't trade same digit consecutively
        if (analysis.predictedDigit === this.lastPredictedDigit) {
            console.log('⏸️  Same digit as last trade - waiting for different setup');
            return;
        }

        // Execute trade
        this.executeTrade(analysis);
    }

    /**
     * Log analysis summary
     */
    logAnalysisSummary() {
        const summary = this.analyzer.getSummary(this.tickHistory);

        if (!summary) {
            console.log('\n⏳ Waiting for sufficient history...');
            return;
        }

        console.log('\n');
        console.log('┌─────────────────────────────────────────────────────────┐');
        console.log('│                   ANALYSIS SUMMARY                      │');
        console.log('├─────────────────────────────────────────────────────────┤');
        console.log(`│  History Length:    ${summary.historyLength.toString().padEnd(36)}│`);
        console.log(`│  Current Digit:     ${summary.currentDigit.toString().padEnd(36)}│`);
        console.log(`│  Confidence:        ${summary.confidence.padEnd(36)}│`);
        console.log(`│  Repetition Rate:   ${summary.repetitionRate.toString().padEnd(36)}│`);
        console.log(`│  Recent Rep Rate:   ${summary.recentRepRate.toString().padEnd(36)}│`);
        console.log(`│  Self Rep Rate:     ${summary.selfRepRate.toString().padEnd(36)}│`);
        console.log(`│  Non-Rep Streak:    ${summary.nonRepStreak.toString().padEnd(36)}│`);
        console.log(`│  Max Non-Rep Streak: ${summary.maxNonRepStreak.toString().padEnd(36)}│`);
        console.log(`│  Should Trade:      ${(summary.shouldTrade ? '✅ YES' : '❌ NO').padEnd(36)}│`);
        console.log(`│  Reason:            ${summary.reason.substring(0, 36).padEnd(36)}│`);
        console.log('└─────────────────────────────────────────────────────────┘');
    }

    /**
     * Execute a trade
     */
    executeTrade(analysis) {
        this.tradeInProgress = true;
        this.lastPredictedDigit = analysis.predictedDigit;
        this.lastPredictionConfidence = analysis.confidence;

        console.log('\n');
        console.log('╔══════════════════════════════════════════════════════════╗');
        console.log('║                    🎯 PLACING TRADE 🎯                    ║');
        console.log('╠══════════════════════════════════════════════════════════╣');
        console.log(`║  Asset:       ${this.currentAsset.padEnd(42)}║`);
        console.log(`║  Contract:    DIGIT DIFFER                                ║`);
        console.log(`║  Barrier:     ${analysis.predictedDigit} (betting this digit WON'T repeat)      ║`);
        console.log(`║  Stake:       $${this.currentStake.toFixed(2).padEnd(40)}║`);
        console.log(`║  Confidence:  ${(analysis.confidence * 100).toFixed(1)}%                                      ║`);
        console.log('╚══════════════════════════════════════════════════════════╝');

        this.send({
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
                barrier: analysis.predictedDigit
            }
        });
    }

    /**
     * Handle buy response
     */
    handleBuy(message) {
        if (message.buy) {
            console.log(`✅ Trade placed - Contract ID: ${message.buy.contract_id}`);
            this.currentContractId = message.buy.contract_id;

            // Subscribe to contract updates
            this.send({
                proposal_open_contract: 1,
                contract_id: message.buy.contract_id,
                subscribe: 1
            });
        }
    }

    /**
     * Handle contract update
     */
    handleContractUpdate(message) {
        const contract = message.proposal_open_contract;

        if (!contract || !contract.is_sold) {
            return;
        }

        this.processTradeResult(contract);
    }

    /**
     * Process trade result
     */
    processTradeResult(contract) {
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        // Update statistics
        this.totalTrades++;
        this.totalProfitLoss += profit;

        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            this.currentStake = config.TRADING.initialStake;

            console.log('\n');
            console.log('╔══════════════════════════════════════════════════════════╗');
            console.log('║                     ✅ TRADE WON ✅                       ║');
            console.log(`║  Profit: +$${profit.toFixed(2).padEnd(45)}║`);
            console.log('╚══════════════════════════════════════════════════════════╝');
        } else {
            this.totalLosses++;
            this.isWinTrade = false;
            this.consecutiveLosses++;
            this.maxConsecutiveLosses = Math.max(this.maxConsecutiveLosses, this.consecutiveLosses);

            // Update global consecutive loss counters
            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            // Apply Martingale
            const newStake = this.currentStake * config.TRADING.multiplier;
            this.currentStake = Math.min(newStake, config.TRADING.maxStake);

            console.log('\n');
            console.log('╔══════════════════════════════════════════════════════════╗');
            console.log('║                     ❌ TRADE LOST ❌                       ║');
            console.log(`║  Loss: -$${Math.abs(profit).toFixed(2).padEnd(47)}║`);
            console.log(`║  Consecutive Losses: ${this.consecutiveLosses.toString().padEnd(35)}║`);
            console.log(`║  Next Stake: $${this.currentStake.toFixed(2).padEnd(41)}║`);
            console.log('╚══════════════════════════════════════════════════════════╝');

            // Send notification on loss
            if (config.EMAIL.enabled) {
                this.sendLossNotification(contract);
            }
        }

        // Log summary
        this.logSessionSummary();

        // Check stop conditions
        if (this.shouldStop()) {
            this.stop();
            return;
        }

        // Reset for next trade
        this.tradeInProgress = false;
        this.currentContractId = null;

        // Cooldown before next analysis
        console.log(`\n⏳ Cooldown: ${config.TIMING.tradeCooldown / 1000}s before next analysis...`);
        if (!this.endOfDay) {
            setTimeout(() => {
                this.lastPredictedDigit = null; // Allow same digit in new session
            }, config.TIMING.tradeCooldown);
        }
    }

    /**
     * Log session summary
     */
    logSessionSummary() {
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : '0.0';

        console.log('\n');
        console.log('┌─────────────────────────────────────────────────────────┐');
        console.log('│                   SESSION SUMMARY                       │');
        console.log('├─────────────────────────────────────────────────────────┤');
        console.log(`│  Total Trades:      ${this.totalTrades.toString().padEnd(36)}│`);
        console.log(`│  Wins / Losses:     ${this.totalWins} / ${this.totalLosses}`.padEnd(58) + '│');
        console.log(`│  Win Rate:          ${winRate}%`.padEnd(58) + '│');
        console.log(`│  Total P/L:         $${this.totalProfitLoss.toFixed(2)}`.padEnd(58) + '│');
        console.log(`│  Current Stake:     $${this.currentStake.toFixed(2)}`.padEnd(58) + '│');
        console.log(`│  x2 Losses:         ${this.consecutiveLosses2}`.padEnd(58) + '│');
        console.log(`│  x3 Losses:         ${this.consecutiveLosses3}`.padEnd(58) + '│');
        console.log(`│  x4 Losses:         ${this.consecutiveLosses4}`.padEnd(58) + '│');
        console.log(`│  x5 Losses:         ${this.consecutiveLosses5}`.padEnd(58) + '│');
        console.log('└─────────────────────────────────────────────────────────┘');
    }

    /**
     * Check if bot should stop
     */
    shouldStop() {
        // Check consecutive losses
        if (this.consecutiveLosses >= config.TRADING.maxConsecutiveLosses) {
            console.log('\n⛔ STOPPING: Maximum consecutive losses reached');
            return true;
        }

        // Check stop loss
        if (this.totalProfitLoss <= -config.TRADING.stopLoss || this.consecutiveLosses >= config.TRADING.maxConsecutiveLosses) {
            console.log('\n⛔ STOPPING: Stop loss reached');
            this.sendFinalSummary();
            this.stop();
            this.endOfDay = true;
            return true;
        }

        // Check take profit
        if (this.totalProfitLoss >= config.TRADING.takeProfit) {
            console.log('\n🎉 STOPPING: Take profit reached!');
            this.sendFinalSummary();
            this.stop();
            this.endOfDay = true;
            // return true;
        }

        // Check max stake
        // if (this.currentStake >= config.TRADING.maxStake) {
        //     console.log('\n⛔ STOPPING: Maximum stake reached');
        //     return true;
        // }

        return false;
    }

    /**
     * Check if it's time to disconnect or reconnect
     */
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
                    this.sendFinalSummary();
                    this.endOfDay = true;
                    this.stop();
                }
            }
        }, 5000);
    }

    startSummaryEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendSummary();
            }
        }, 1800000);
    }

    /**
     * Summary notification email
     */
    async sendSummary() {
        if (!config.EMAIL.enabled) return;

        try {
            const transporter = nodemailer.createTransport({
                service: config.EMAIL.service,
                auth: {
                    user: config.EMAIL.user,
                    pass: config.EMAIL.pass
                }
            });

            const duration = ((Date.now() - this.sessionStartTime.getTime()) / 60000).toFixed(1);
            const winRate = this.totalTrades > 0
                ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
                : '0.0';

            await transporter.sendMail({
                from: config.EMAIL.user,
                to: config.EMAIL.recipient,
                subject: `x2Bot Deriv Bot - Trade Summary`,
                text: `
                    TRADE SUMMARY
                    ================

                    Duration: ${duration} minutes
                    Total Trades: ${this.totalTrades}
                    Win Rate: ${winRate}%
                    Total P/L: $${this.totalProfitLoss.toFixed(2)}

                    Stats:
                    - Wins: ${this.totalWins}
                    - Losses: ${this.totalLosses}
                    - x2: ${this.consecutiveLosses2}
                    - x3: ${this.consecutiveLosses3}
                    - x4: ${this.consecutiveLosses4}
                    - x5: ${this.consecutiveLosses5}
                    `
            });
        } catch (error) {
            console.error('Email error:', error.message);
        }
    }

    /**
     * Send loss notification email
     */
    async sendLossNotification(contract) {
        if (!config.EMAIL.enabled) return;

        try {
            const transporter = nodemailer.createTransport({
                service: config.EMAIL.service,
                auth: {
                    user: config.EMAIL.user,
                    pass: config.EMAIL.pass
                }
            });

            const recentDigits = this.tickHistory.slice(-10).join(', ');

            await transporter.sendMail({
                from: config.EMAIL.user,
                to: config.EMAIL.recipient,
                subject: `x2Bot Deriv Bot - Trade Lost`,
                text: `
                TRADE LOSS NOTIFICATION
                =======================

                Asset: ${this.currentAsset}
                Loss Amount: $${Math.abs(parseFloat(contract.profit)).toFixed(2)}
                Consecutive Losses: ${this.consecutiveLosses}
                Total P/L: $${this.totalProfitLoss.toFixed(2)}
                Next Stake: $${this.currentStake.toFixed(2)}

                Prediction: ${this.lastPredictedDigit}
                Confidence: ${this.lastPredictionConfidence.toFixed(2)}%
                Recent Digits: ${recentDigits}

                Session Stats:
                - Total Trades: ${this.totalTrades}
                - Wins: ${this.totalWins}
                - Losses: ${this.totalLosses}
                - x2: ${this.consecutiveLosses2}
                - x3: ${this.consecutiveLosses3}
                - x4: ${this.consecutiveLosses4}
                - x5: ${this.consecutiveLosses5}
                `
            });
        } catch (error) {
            console.error('Email error:', error.message);
        }
    }

    /**
     * Stop the bot
     */
    stop() {
        console.log('\n');
        console.log('╔══════════════════════════════════════════════════════════╗');
        console.log('║                    BOT STOPPED                           ║');
        console.log('╚══════════════════════════════════════════════════════════╝');

        this.logSessionSummary();

        this.isRunning = false;
        this.unsubscribeTicks();

        if (this.ws) {
            this.ws.close();
        }

        // Send final summary email
        if (config.EMAIL.enabled) {
            this.sendFinalSummary();
        }
    }

    /**
     * Send final summary email
     */
    async sendFinalSummary() {
        if (!config.EMAIL.enabled) return;

        try {
            const transporter = nodemailer.createTransport({
                service: config.EMAIL.service,
                auth: {
                    user: config.EMAIL.user,
                    pass: config.EMAIL.pass
                }
            });

            const duration = ((Date.now() - this.sessionStartTime.getTime()) / 60000).toFixed(1);
            const winRate = this.totalTrades > 0
                ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
                : '0.0';

            await transporter.sendMail({
                from: config.EMAIL.user,
                to: config.EMAIL.recipient,
                subject: `x2Bot Deriv Bot - Session Complete ($${this.totalProfitLoss.toFixed(2)})`,
                text: `
                    SESSION COMPLETE
                    ================

                    Duration: ${duration} minutes
                    Total Trades: ${this.totalTrades}
                    Win Rate: ${winRate}%
                    Total P/L: $${this.totalProfitLoss.toFixed(2)}

                    Final Stats:
                    - Wins: ${this.totalWins}
                    - Losses: ${this.totalLosses}
                    - x2: ${this.consecutiveLosses2}
                    - x3: ${this.consecutiveLosses3}
                    - x4: ${this.consecutiveLosses4}
                    - x5: ${this.consecutiveLosses5}
                    `
            });
        } catch (error) {
            console.error('Email error:', error.message);
        }
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n🛑 Received shutdown signal...');
    bot.stop();
    process.exit(0);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

// Start the bot
const bot = new DerivDigitDifferBot();
bot.start();

module.exports = DerivDigitDifferBot;
