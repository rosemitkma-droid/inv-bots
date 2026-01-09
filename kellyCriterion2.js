/**
 * ============================================================
 * KELLY CRITERION DERIV DIGIT DIFFER TRADING BOT v1.0
 * ============================================================
 */

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');


class KellyCriterionManager {
    constructor(config = {}) {
        this.investmentCapital = config.investmentCapital || 500;
        this.currentCapital = this.investmentCapital;
        this.peakCapital = this.investmentCapital;

        this.kellyFraction = config.kellyFraction || 0.25;
        this.minKellyFraction = 0.1;
        this.maxKellyFraction = 0.5;

        this.minStake = config.minStake || 0.61;
        this.maxStakePercent = config.maxStakePercent || 5;
        this.absoluteMaxStake = config.absoluteMaxStake || 50;

        this.maxDrawdownPercent = config.maxDrawdownPercent || 25;
        this.warningDrawdownPercent = config.warningDrawdownPercent || 15;
        this.dailyLossLimit = config.dailyLossLimit || 50;
        this.dailyProfitTarget = config.dailyProfitTarget || 100;

        this.recoveryMode = false;
        this.recoveryStartCapital = 0;
        this.maxRecoveryMultiplier = 2.0;

        this.tradeHistory = [];
        this.dailyPnL = 0;
        this.sessionPnL = 0;
        this.currentDrawdown = 0;
        this.maxDrawdownReached = 0;

        this.confidenceThresholds = {
            veryHigh: 90,
            high: 80,
            medium: 70,
            low: 60
        };

        this.recentWins = 0;
        this.recentLosses = 0;
        this.rollingWindowSize = 50;
        this.rollingResults = [];

        console.log('\n💰 Kelly Criterion Manager Initialized');
        console.log(`   Investment Capital: $${this.investmentCapital}`);
        console.log(`   Kelly Fraction: ${this.kellyFraction * 100}%`);
    }

    calculateFullKelly(winProbability, decimalOdds) {
        const p = Math.max(0.01, Math.min(0.99, winProbability));
        const q = 1 - p;
        const b = decimalOdds - 1;

        if (b <= 0) return 0;

        const kelly = (b * p - q) / b;
        return Math.max(0, kelly);
    }

    calculateOptimalStake(params) {
        const {
            winProbability = 0.9,
            payout = 1.09,
            confidence = 80,
            marketRegime = 'stable',
            consecutiveLosses = 0,
            consecutiveWins = 0,
            volatility = 'medium'
        } = params;

        const fullKelly = this.calculateFullKelly(winProbability, payout);
        let adjustedKelly = fullKelly * this.kellyFraction;

        adjustedKelly *= this.getConfidenceMultiplier(confidence);
        adjustedKelly *= this.getRegimeMultiplier(marketRegime);
        adjustedKelly *= this.getVolatilityMultiplier(volatility);
        adjustedKelly *= this.getLossAdjustment(consecutiveLosses);
        adjustedKelly *= this.getWinBonus(consecutiveWins);
        adjustedKelly *= this.getDrawdownMultiplier();

        let stake = this.currentCapital * adjustedKelly;

        // Apply limits
        const maxAllowedStake = Math.min(
            this.currentCapital * (this.maxStakePercent / 100),
            this.absoluteMaxStake,
            this.currentCapital * 0.1
        );

        stake = Math.min(stake, maxAllowedStake);
        stake = Math.round(stake * 100) / 100;

        return {
            stake,
            kellyFraction: adjustedKelly,
            riskLevel: this.assessRiskLevel(stake),
            recommendation: this.getStakeRecommendation(stake, confidence)
        };
    }

    getConfidenceMultiplier(confidence) {
        if (confidence >= this.confidenceThresholds.veryHigh) return 1.0;
        if (confidence >= this.confidenceThresholds.high) return 0.8;
        if (confidence >= this.confidenceThresholds.medium) return 0.5;
        if (confidence >= this.confidenceThresholds.low) return 0.25;
        return 0.1;
    }

    getRegimeMultiplier(regime) {
        const multipliers = {
            'stable': 1.0, 'ordered': 1.0,
            'trending': 0.8, 'patterned': 0.9,
            'ranging': 0.9, 'semi-random': 0.7,
            'volatile': 0.5, 'chaotic': 0.4,
            'random': 0.4, 'edge-of-chaos': 0.6,
            'unknown': 0.6
        };
        return multipliers[regime] || 0.6;
    }

    getVolatilityMultiplier(volatility) {
        const multipliers = { 'low': 1.2, 'medium': 1.0, 'high': 0.6, 'extreme': 0.3 };
        return multipliers[volatility] || 1.0;
    }

    getLossAdjustment(consecutiveLosses) {
        if (consecutiveLosses === 0) return 1.0;
        if (consecutiveLosses === 1) return 0.9;
        if (consecutiveLosses === 2) return 0.7;
        if (consecutiveLosses === 3) return 0.5;
        if (consecutiveLosses === 4) return 0.3;
        return 0.2;
    }

    getWinBonus(consecutiveWins) {
        if (consecutiveWins === 0) return 1.0;
        if (consecutiveWins === 1) return 1.1;
        if (consecutiveWins === 2) return 1.2;
        if (consecutiveWins === 3) return 1.3;
        return 1.4;
    }

    getDrawdownMultiplier() {
        const drawdownPercent = this.calculateCurrentDrawdown();
        if (drawdownPercent < 5) return 1.0;
        if (drawdownPercent < 10) return 0.8;
        if (drawdownPercent < 15) return 0.6;
        if (drawdownPercent < 20) return 0.4;
        if (drawdownPercent < 25) return 0.2;
        return 0.1;
    }

    calculateCurrentDrawdown() {
        if (this.peakCapital <= 0) return 0;
        const drawdown = ((this.peakCapital - this.currentCapital) / this.peakCapital) * 100;
        this.currentDrawdown = Math.max(0, drawdown);
        this.maxDrawdownReached = Math.max(this.maxDrawdownReached, this.currentDrawdown);
        return this.currentDrawdown;
    }

    shouldContinueTrading() {
        const drawdown = this.calculateCurrentDrawdown();
        const reasons = [];

        if (drawdown >= this.maxDrawdownPercent) {
            reasons.push(`Max drawdown ${drawdown.toFixed(1)}% reached`);
        }
        if (this.dailyPnL <= -this.dailyLossLimit) {
            reasons.push(`Daily loss limit $${this.dailyLossLimit} reached`);
        }
        if (this.currentCapital < this.investmentCapital * 0.5) {
            reasons.push(`Capital below 50% of initial`);
        }

        return {
            canTrade: reasons.length === 0,
            reasons,
            warning: drawdown >= this.warningDrawdownPercent,
            reachedDailyTarget: this.dailyPnL >= this.dailyProfitTarget,
            currentDrawdown: drawdown,
            dailyPnL: this.dailyPnL
        };
    }

    updateAfterTrade(profit, isWin) {
        this.currentCapital += profit;
        this.dailyPnL += profit;
        this.sessionPnL += profit;

        if (this.currentCapital > this.peakCapital) {
            this.peakCapital = this.currentCapital;
        }

        this.rollingResults.push(isWin ? 1 : 0);
        if (this.rollingResults.length > this.rollingWindowSize) {
            this.rollingResults.shift();
        }

        if (this.rollingResults.length > 0) {
            this.recentWins = this.rollingResults.filter(r => r === 1).length;
            this.recentLosses = this.rollingResults.filter(r => r === 0).length;
        }

        this.tradeHistory.push({
            timestamp: Date.now(),
            profit,
            isWin,
            capital: this.currentCapital,
            drawdown: this.calculateCurrentDrawdown()
        });
    }

    getRollingWinRate() {
        if (this.rollingResults.length < 5) return 0.5;
        return this.recentWins / this.rollingResults.length;
    }

    getPayoutForAsset(asset) {
        const payouts = {
            'R_10': 1.85, 'R_25': 1.85, 'R_50': 1.85,
            'R_75': 1.85, 'R_100': 1.85,
            'RDBULL': 1.80, 'RDBEAR': 1.80
        };
        return payouts[asset] || 1.85;
    }

    assessRiskLevel(stake) {
        const percentOfCapital = (stake / this.currentCapital) * 100;
        if (percentOfCapital <= 1) return 'very_low';
        if (percentOfCapital <= 2) return 'low';
        if (percentOfCapital <= 3) return 'medium';
        if (percentOfCapital <= 5) return 'high';
        return 'very_high';
    }

    getStakeRecommendation(stake, confidence) {
        if (confidence < 60) return 'SKIP - Confidence too low';
        if (stake < this.minStake) return 'SKIP - Stake below minimum';
        if (this.calculateCurrentDrawdown() > 20) return 'CAUTION - High drawdown';
        return 'TRADE';
    }

    getStatus() {
        return {
            investmentCapital: this.investmentCapital,
            currentCapital: this.currentCapital,
            peakCapital: this.peakCapital,
            currentDrawdown: this.calculateCurrentDrawdown(),
            maxDrawdownReached: this.maxDrawdownReached,
            dailyPnL: this.dailyPnL,
            sessionPnL: this.sessionPnL,
            rollingWinRate: this.getRollingWinRate(),
            recoveryMode: this.recoveryMode,
            tradesCount: this.tradeHistory.length
        };
    }
}
// ============================================================
// MAIN BOT CLASS
// ============================================================

class AILogicDigitDifferBot {
    constructor(config = {}) {
        this.token = config.derivToken || process.env.DERIV_TOKEN;

        // Initialize Kelly Criterion Manager
        this.kellyManager = new KellyCriterionManager({
            investmentCapital: config.investmentCapital || 500,
            kellyFraction: config.kellyFraction || 0.25,
            maxStakePercent: config.maxStakePercent || 5,
            maxDrawdownPercent: config.maxDrawdownPercent || 25,
            dailyLossLimit: config.dailyLossLimit || 50,
            dailyProfitTarget: config.dailyProfitTarget || 100
        });

        // WebSocket
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // Assets
        this.assets = config.assets || [
            // 'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'
            'R_100',
        ];

        // Trading Configuration
        this.config = {
            requiredHistoryLength: config.requiredHistoryLength || 500,
            minConfidence: config.minConfidence || 70,
            minStake: config.minStake || 0.61,
            multiplier: config.multiplier || 11.3,
            minEnginesAgreement: config.minEnginesAgreement || 4,
            minEnginesAgreement2: config.minEnginesAgreement2 || 5,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 6,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            tradeCooldown: config.tradeCooldown || 5000,
            minWaitTime: config.minWaitTime || 15000,
            maxWaitTime: config.maxWaitTime || 90000,
        };

        // Trading State
        this.currentAsset = null;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.consecutiveLossesn = 0;
        this.consecutiveWins = 0;
        this.currentTradeId = null;
        this.tickSubscriptionId = null;
        this.lastTradeResult = null;

        // Statistics
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.balance = 0;
        this.sessionStartBalance = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.currentStake = this.config.minStake;

        // Tick Data
        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);

        // Prediction Tracking
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.lastPrediction = null;
        this.lastConfidence = 0;
        this.currentPrediction = null;
        this.RestartTrading = true;

        // Connection State
        this.reconnectAttempts = 0;
        this.isPaused = false;
        this.isShuttingDown = false;
        this.isReconnecting = false;

        // Telegram Configuration
        this.telegramToken = process.env.TELEGRAM_BOT_TOKEN6;
        this.telegramChatId = process.env.TELEGRAM_CHAT_ID;
        this.telegramEnabled = !!(this.telegramToken && this.telegramChatId);

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
        }

        this.sessionStartTime = new Date();

        console.log('\n' + '='.repeat(60));
        console.log('🤖 KELLY CRITERION DIGIT DIFFER TRADING BOT v1.0');
        console.log('='.repeat(60));

        if (this.telegramEnabled) {
            this.startTelegramTimer();
        }
    }


    connect() {
        if (this.isShuttingDown || this.connected) return;

        console.log('🔌 Connecting to Deriv API...');

        try {
            this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            this.ws.on('open', () => {
                console.log('✅ Connected to Deriv API');
                this.connected = true;
                this.wsReady = true;
                this.reconnectAttempts = 0;
                this.isReconnecting = false;
                this.authenticate();
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Error parsing message:', error.message);
                }
            });

            this.ws.on('error', (error) => {
                console.error('❌ WebSocket error:', error.message);
            });

            this.ws.on('close', (code) => {
                console.log(`🔌 Disconnected (code: ${code})`);
                this.connected = false;
                this.wsReady = false;
                this.ws = null;
                if (!this.isPaused && !this.isShuttingDown) {
                    this.handleDisconnect();
                }
            });

        } catch (error) {
            console.error('Error creating WebSocket:', error.message);
            this.handleDisconnect();
        }
    }

    sendRequest(request) {
        if (this.connected && this.wsReady && this.ws) {
            try {
                this.ws.send(JSON.stringify(request));
                return true;
            } catch (error) {
                console.error('Error sending request:', error.message);
                return false;
            }
        }
        return false;
    }

    handleDisconnect() {
        if (this.isReconnecting || this.isShuttingDown) return;

        this.connected = false;
        this.wsReady = false;
        this.isReconnecting = true;

        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.terminate();
            } catch (e) { }
            this.ws = null;
        }

        this.reconnectAttempts++;
        const delay = Math.min(this.config.reconnectInterval * (this.reconnectAttempts + 1), 30000);
        console.log(`🔄 Reconnecting in ${delay / 1000}s...`);

        setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    authenticate() {
        console.log('🔐 Authenticating...');
        this.sendRequest({ authorize: this.token });
    }

    disconnect() {
        this.connected = false;
        this.wsReady = false;
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close();
            } catch (e) { }
            this.ws = null;
        }
    }

    shutdown() {
        console.log('\n🛑 Shutting down...');
        this.isShuttingDown = true;
        this.isPaused = true;
        this.logFinalSummary();
        this.disconnect();
        console.log('💤 Bot stopped.');
        setInterval(() => { }, 1000 * 60 * 60);
    }

    // ==================== MESSAGE HANDLING ====================

    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                this.handleAuthorize(message);
                break;
            case 'balance':
                // this.handleBalance(message);
                break;
            case 'history':
                this.handleTickHistory(message.history);
                break;
            case 'tick':
                this.handleTickUpdate(message.tick);
                break;
            case 'buy':
                this.handleBuyResponse(message);
                break;
            case 'proposal_open_contract':
                if (message.proposal_open_contract?.is_sold) {
                    this.handleTradeResult(message.proposal_open_contract);
                }
                break;
            default:
                if (message.error) {
                    this.handleError(message.error);
                }
        }
    }

    handleAuthorize(message) {
        if (message.error) {
            console.error('❌ Authentication failed:', message.error.message);
            this.scheduleReconnect(5000);
            return;
        }

        console.log('✅ Authentication successful');
        console.log(`👤 Account: ${message.authorize.loginid}`);
        this.balance = this.kellyManager.investmentCapital;//message.authorize.balance;
        this.sessionStartBalance = this.balance;

        console.log(`💰 Balance: $${this.balance.toFixed(2)}`);

        this.sendRequest({ balance: 1, subscribe: 1 });
        this.resetTradingState();
        this.startTrading();
    }

    resetTradingState() {
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);
        this.tickSubscriptionId = null;
    }

    handleBuyResponse(message) {
        if (message.error) {
            console.error('❌ Trade error:', message.error.message);
            this.tradeInProgress = false;
            this.predictionInProgress = false;
            this.scheduleNextTrade();
            return;
        }

        console.log('✅ Trade placed successfully');
        this.currentTradeId = message.buy.contract_id;
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: this.currentTradeId,
            subscribe: 1
        });
    }

    handleError(error) {
        console.error('❌ API Error:', error.message, `(Code: ${error.code})`);

        switch (error.code) {
            case 'InvalidToken':
                this.shutdown();
                break;
            case 'RateLimit':
                this.scheduleReconnect(60000);
                break;
            case 'MarketIsClosed':
                this.scheduleReconnect(300000);
                break;
            default:
                if (!this.tradeInProgress) {
                    this.scheduleNextTrade();
                }
        }
    }

    // ==================== TRADING LOGIC ====================

    startTrading() {
        console.log('\n📈 Starting trading session...');
        console.log(`💰 Investment Capital: $${this.kellyManager.investmentCapital.toFixed(2)}`);
        this.selectNextAsset();
    }

    selectNextAsset() {
        if (this.usedAssets.size >= this.assets.length) {
            this.usedAssets.clear();
        }

        if (this.RestartTrading) {
            const availableAssets = this.assets.filter(a => !this.usedAssets.has(a));
            this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
            this.usedAssets.add(this.currentAsset);
        }

        // this.RestartTrading = false;
        console.log(`\n🎯 Selected asset: ${this.currentAsset}`);

        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);

        if (this.tickSubscriptionId) {
            this.sendRequest({ forget: this.tickSubscriptionId });
        }

        setTimeout(() => {
            this.sendRequest({
                ticks_history: this.currentAsset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });

            this.sendRequest({
                ticks: this.currentAsset,
                subscribe: 1
            });
        }, 500);
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

    handleTickHistory(history) {
        if (!history || !history.prices) {
            console.log('⚠️ Invalid tick history received');
            return;
        }
        this.tickHistory = history.prices.map(price => this.getLastDigit(price, this.currentAsset));
        console.log(`📊 Received ${this.tickHistory.length} ticks of history`);
    }

    handleTickUpdate(tick) {
        if (!tick || !tick.quote) return;

        const lastDigit = this.getLastDigit(tick.quote, this.currentAsset);
        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.config.requiredHistoryLength) {
            this.tickHistory.shift();
        }
        this.digitCounts[lastDigit]++;

        console.log(`📍 Last 5 digits: ${this.tickHistory.slice(-5).join(', ')} | History: ${this.tickHistory.length}`);

        if (!this.tradeInProgress) {
            this.analyzeTicks();
        }
    }

    async analyzeTicks() {
        if (this.tradeInProgress) return;

        // const tradingStatus = this.kellyManager.shouldContinueTrading();
        // if (!tradingStatus.canTrade) {
        //     console.log('\n🛑 Trading stopped by Kelly Manager:');
        //     tradingStatus.reasons.forEach(r => console.log(`   - ${r}`));
        //     this.shutdown();
        //     return;
        // }

        // if (tradingStatus.warning) {
        //     console.log(`\n⚠️ WARNING: Drawdown at ${tradingStatus.currentDrawdown.toFixed(1)}%`);
        // }


        const startTime = Date.now();

        try {
            const processingTime = (Date.now() - startTime) / 1000;

            // console.log(`⏱️  Analysis time: ${processingTime.toFixed(2)}s`);

            this.lastPrediction = this.tickHistory[this.tickHistory.length - 1];
            this.lastConfidence = 85; // Default confidence for simulated AI

            // Calculate optimal stake
            // For Digit Differ, baseline win rate is ~90%
            const rollingWinRate = this.kellyManager.getRollingWinRate();
            const payout = this.kellyManager.getPayoutForAsset(this.currentAsset);

            // Win probability estimation for Kelly
            // If we have history, use rolling win rate, otherwise use baseline 90%
            const baseProb = this.totalTrades > 5 ? rollingWinRate : 0.91;
            const adjustedWinProb = Math.max(0.88, Math.min(0.98, baseProb + (this.lastConfidence - 80) / 1000));

            const kellyResult = this.kellyManager.calculateOptimalStake({
                winProbability: adjustedWinProb,
                payout: payout,
                confidence: this.lastConfidence,
                marketRegime: 'neutral',
                consecutiveLosses: this.consecutiveLosses,
                consecutiveWins: this.consecutiveWins,
                volatility: this.getVolatilityLevel(this.tickHistory)
            });

            this.volatilityLevel = this.getVolatilityLevel(this.tickHistory)

            // console.log(`\n💰 Kelly Criterion Result:`);
            // console.log(`   Prediction: ${this.lastPrediction}`);
            // console.log(`   Optimal Stake: $${kellyResult.stake.toFixed(2)}`);
            // console.log(`   Risk Level: ${kellyResult.riskLevel}`);
            // console.log(`   Recommendation: ${kellyResult.recommendation}`);
            console.log(`   Volatility Level: ${this.volatilityLevel}`);

            if (this.lastPrediction === this.tickHistory[this.tickHistory.length - 2] && this.volatilityLevel === 'medium') {
                this.placeTrade(this.lastPrediction, this.lastConfidence, kellyResult.stake);
            }
            // else {
            //     console.log(`⏭️ Skipping trade - Wating for proper Digit setup`);
            //     this.predictionInProgress = false;
            // }

        } catch (error) {
            console.error('❌ Analysis error:', error.message);
            console.error(error.stack);
            this.predictionInProgress = false;
        }
    }

    getVolatilityLevel(tickHistory) {
        if (tickHistory.length < 50) return 'medium';
        const recent = tickHistory.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        const stdDev = Math.sqrt(variance);

        if (stdDev > 3.5) return 'extreme';
        if (stdDev > 2.8) return 'high';
        if (stdDev > 2.0) return 'medium';

        console.log(`Volatility stdDev: ${stdDev.toFixed(2)}`);
        return 'low';
    }

    // ==================== TRADE EXECUTION ====================

    placeTrade(digit, confidence, stake) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.predictionInProgress = true;

        // stake = Math.max(this.config.minStake, Math.min(stake, this.balance * 0.1));
        // stake = Math.round(stake * 100) / 100;

        // console.log(`\n💰 Placing trade: DIFFER ${digit} @ $${stake.toFixed(2)} (${confidence}% confidence)`);
        console.log(`\n💰 Placing trade: MATCH ${digit} @ $${this.currentStake.toFixed(2)} (${confidence}% confidence)`)

        this.sendRequest({
            buy: 1,
            price: this.currentStake.toFixed(2), //stake.toFixed(2),
            parameters: {
                amount: this.currentStake.toFixed(2), //stake.toFixed(2),
                basis: 'stake',
                contract_type: 'DIGITMATCH',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: this.currentAsset,
                barrier: digit
            }
        });

        this.currentPrediction = { digit, confidence, stake };
    }

    handleTradeResult(contract) {
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const exitSpot = contract.exit_tick_display_value;
        const actualDigit = this.getLastDigit(exitSpot, this.currentAsset);

        console.log('\n' + '='.repeat(40));
        console.log(won ? '🎉 TRADE WON!' : '😔 TRADE LOST');
        console.log(`   Predicted: ${this.lastPrediction} | Actual: ${actualDigit}`);
        console.log(`   Profit: ${won ? '+' : ''}$${profit.toFixed(2)}`);
        console.log('='.repeat(40));

        this.totalTrades++;
        this.kellyManager.updateAfterTrade(profit, won);
        this.balance = this.kellyManager.currentCapital; // Update local balance reference

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.consecutiveLossesn = 0;
            this.consecutiveWins++;
            this.lastTradeResult = 'won';
            this.currentStake = this.config.minStake;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.consecutiveWins = 0;
            this.lastTradeResult = 'lost';
            this.consecutiveLossesn++;

            // this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;

            if (this.consecutiveLosses === 2) {
                this.consecutiveLosses2++;
            } else if (this.consecutiveLosses === 3) {
                this.consecutiveLosses3++;
            } else if (this.consecutiveLosses === 4) {
                this.consecutiveLosses4++;
            } else if (this.consecutiveLosses === 5) {
                this.consecutiveLosses5++;
            }

            if (this.consecutiveLossesn === 5) {
                this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
                this.consecutiveLossesn = 0;
            }
        }

        const kellyStatus = this.kellyManager.getStatus();
        console.log(`\n📊 Kelly Status:`);
        console.log(`   Capital: $${kellyStatus.currentCapital.toFixed(2)} (Peak: $${kellyStatus.peakCapital.toFixed(2)})`);
        console.log(`   Drawdown: ${kellyStatus.currentDrawdown.toFixed(1)}%`);
        console.log(`   Session P/L: $${kellyStatus.sessionPnL.toFixed(2)}`);
        console.log(`   Win Rate: ${(kellyStatus.rollingWinRate * 100).toFixed(1)}%`);

        this.logTradingSummary();

        if (this.checkStopConditions()) {
            return;
        }

        if (won && this.telegramEnabled) {
            this.sendTelegramLossAlert(actualDigit, profit);
        }

        this.tradeInProgress = false;
        this.predictionInProgress = false;

        // this.scheduleNextTrade2();
    }

    checkStopConditions() {
        const kellyStatus = this.kellyManager.shouldContinueTrading();

        if (!kellyStatus.canTrade) {
            console.log('\n🛑 Kelly Manager stopping trading:');
            kellyStatus.reasons.forEach(r => console.log(`   - ${r}`));
            this.shutdown();
            return true;
        }

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('\n🛑 Max consecutive losses reached.');
            this.shutdown();
            return true;
        }

        if (kellyStatus.reachedDailyTarget) {
            console.log('\n🎉 Daily profit target reached!');
            this.shutdown();
            return true;
        }

        return false;
    }

    scheduleNextTrade() {
        const waitTime = Math.floor(
            Math.random() * (30000 - 25000) +
            1000
        );

        console.log(`\n⏳ Waiting ${Math.round(waitTime / 1000)}s before next trade...`);

        this.isPaused = true;
        this.disconnect();

        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.isPaused = false;
                this.reconnectAttempts = 0;
                this.connect();
            }
        }, waitTime);
    }

    // scheduleNextTrade2() {
    //     const waitTime = Math.floor(
    //         Math.random() * (this.config.maxWaitTime - this.config.minWaitTime) +
    //         this.config.minWaitTime
    //     );

    //     console.log(`\n⏳ Next trade in ${Math.round(waitTime / 1000)}s...`);
    //     this.isPaused = true;
    //     this.disconnect();
    //     setTimeout(() => {
    //         if (!this.isShuttingDown) {
    //             this.isPaused = false;
    //             this.reconnectAttempts = 0;
    //             this.connect();
    //         }
    //     }, waitTime);
    // }

    // scheduleReconnect(delay) {
    //     this.isPaused = true;
    //     this.disconnect();

    //     setTimeout(() => {
    //         if (!this.isShuttingDown) {
    //             this.isPaused = false;
    //             this.reconnectAttempts = 0;
    //             this.connect();
    //         }
    //     }, delay);
    // }

    // ==================== LOGGING & NOTIFICATIONS ====================

    logTradingSummary() {
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;

        const kellyStatus = this.kellyManager.getStatus();

        console.log('\n📊 Trading Summary:');
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins/Losses: ${this.totalWins}/${this.totalLosses}`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Session P/L: $${kellyStatus.sessionPnL.toFixed(2)}`);
        console.log(`   Balance: $${this.balance.toFixed(2)}`);
    }

    logFinalSummary() {
        const duration = this.getSessionDuration();
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;
        const kellyStatus = this.kellyManager.getStatus();

        console.log('\n' + '='.repeat(60));
        console.log('📊 FINAL TRADING SUMMARY');
        console.log('='.repeat(60));
        console.log(`   Session Duration: ${duration}`);
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins: ${this.totalWins}`);
        console.log(`   Losses: ${this.totalLosses}`);
        console.log(`   x2Losses: ${this.consecutiveLosses2}`);
        console.log(`   x3Losses: ${this.consecutiveLosses3}`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Session P/L: $${kellyStatus.sessionPnL.toFixed(2)}`);
        console.log(`   Starting Capital: $${kellyStatus.investmentCapital.toFixed(2)}`);
        console.log(`   Final Capital: $${kellyStatus.currentCapital.toFixed(2)}`);
        console.log(`   Max Drawdown: ${kellyStatus.maxDrawdownReached.toFixed(1)}%`);
        console.log(`   ROI: ${((kellyStatus.currentCapital - kellyStatus.investmentCapital) / kellyStatus.investmentCapital * 100).toFixed(2)}%`);


        console.log('='.repeat(60) + '\n');

        if (this.telegramEnabled) {
            this.sendTelegramMessage(`<b>⏹ Bot Stopped</b>\n\n${this.getTelegramSummary()}`);
        }
    }

    getSessionDuration() {
        const now = new Date();
        const diff = now - this.sessionStartTime;
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        return `${hours}h ${minutes}m`;
    }

    getTelegramSummary() {
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;
        const kellyStatus = this.kellyManager.getStatus();

        return `<b>Kelly Criterion2 Trading Summary</b>
            ━━━━━━━━━━━━━━━━━━━━━━━━
            📊 <b>Total Trades:</b> ${this.totalTrades}
            ✅ <b>Wins:</b> ${this.totalWins}
            ❌ <b>Losses:</b> ${this.totalLosses}
            ❌ <b>x2 Losses:</b> ${this.consecutiveLosses2}
            ❌ <b>x3 Losses:</b> ${this.consecutiveLosses3}
            
            📈 <b>Win Rate:</b> ${winRate}%

            💰 <b>Investment:</b> $${kellyStatus.investmentCapital.toFixed(2)}
            💵 <b>Current Capital:</b> $${kellyStatus.currentCapital.toFixed(2)}
            📉 <b>Max Drawdown:</b> ${kellyStatus.maxDrawdownReached.toFixed(1)}%
            📊 <b>Session P/L:</b> $${kellyStatus.sessionPnL.toFixed(2)}
            📈 <b>ROI:</b> ${((kellyStatus.currentCapital - kellyStatus.investmentCapital) / kellyStatus.investmentCapital * 100).toFixed(2)}%
        `;
    }

    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;

        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error('❌ Telegram error:', error.message);
        }
    }

    startTelegramTimer() {
        setInterval(() => {
            if (this.totalTrades > 0 && !this.isShuttingDown) {
                this.sendTelegramMessage(`📊 <b>Performance Update</b>\n\n${this.getTelegramSummary()}`);
            }
        }, 30 * 60 * 1000);
    }

    async sendTelegramLossAlert(actualDigit, profit) {

        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;
        const kellyStatus = this.kellyManager.getStatus();

        const body = `🚨 TRADE WIN - Kelly Criterion2
            ━━━━━━━━━━━━━━━━━━━━
            Asset: ${this.currentAsset}
            Predicted: ${this.lastPrediction} | Actual: ${actualDigit}
            Profit: $${Math.abs(profit).toFixed(2)}
            
            📊 Total Trades: ${this.totalTrades}
            ✅ Wins: ${this.totalWins}
            Stake: $${this.currentStake.toFixed(2)}

            Total Consecutive Losses: ${this.consecutiveLossesn}
            
            📈 Win Rate: ${winRate}%

            💰 Investment: $${kellyStatus.investmentCapital.toFixed(2)}
            💵 Current Capital: $${kellyStatus.currentCapital.toFixed(2)}
            📉 Max Drawdown: ${kellyStatus.maxDrawdownReached.toFixed(1)}%
            📊 Session P/L: $${kellyStatus.sessionPnL.toFixed(2)}
            Drawdown: ${kellyStatus.currentDrawdown.toFixed(1)}%
            Capital: $${kellyStatus.currentCapital.toFixed(2)}
        `;

        await this.sendTelegramMessage(body);
    }

    // ==================== START BOT ====================

    start() {
        console.log('🚀 Starting AI-Logic Kelly Criterion Bot v1.0...');

        if (!this.token) {
            console.error('❌ Error: DERIV_TOKEN is required');
            process.exit(1);
        }

        process.on('uncaughtException', (error) => {
            console.error('Uncaught Exception:', error.message);
        });

        process.on('unhandledRejection', (reason) => {
            console.error('Unhandled Rejection:', reason);
        });

        this.connect();
    }
}

// ==================== STARTUP ====================

if (!process.env.DERIV_TOKEN) {
    console.error('❌ Error: DERIV_TOKEN is required in .env file');
    process.exit(1);
}

const bot = new AILogicDigitDifferBot({
    derivToken: 'rgNedekYXvCaPeP',

    investmentCapital: 100,
    kellyFraction: 0.2, // 20% of full Kelly
    minStake: 0.35,
    maxStakePercent: 5,
    multiplier: 2,

    maxDrawdownPercent: 100,
    dailyLossLimit: 200,
    dailyProfitTarget: 1000,
    maxConsecutiveLosses: 100,//6

    requiredHistoryLength: 1000,
    minWaitTime: 1000,
    maxWaitTime: 1000,
});

bot.start();
