require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

class AIWeightedEnsembleBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'];

        this.config = {
            initialStake: config.initialStake || 0.61,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            stopLoss: config.stopLoss || 129,
            takeProfit: config.takeProfit || 25,
            requiredHistoryLength: config.requiredHistoryLength || 1000,
            minWaitTime: config.minWaitTime || 120000,
            maxWaitTime: config.maxWaitTime || 180000,
        };

        // Trading state
        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.x2Losses = 0;
        this.x3Losses = 0;
        this.x4Losses = 0;
        this.x5Losses = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.suspendedAssets = new Set();
        this.endOfDay = false;
        this.isWinTrade = false;
        this.lastPrediction = null;
        this.actualDigit = null;

        // Telegram Configuration
        this.telegramToken = '8397622765:AAGL93lrQ0LtVPw8MhB3JzFjPOCAJA5CLro';
        this.telegramChatId = '752497117';
        this.telegramEnabled = true;

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
            this.startTelegramTimer();
        } else {
            console.log('📱 Telegram notifications disabled (missing API keys).');
        }

        // Stats tracking for Telegram summaries
        this.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };

        // Tick data storage
        this.tickHistories = {};
        this.tickSubscriptionIds = {};
        this.lastTickLogTime = {};
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.lastTickLogTime[asset] = 0;
        });
    }

    connect() {
        console.log('Connecting to Deriv API...');
        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.wsReady = true;
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
            this.handleDisconnect();
        });
    }

    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        }
    }

    authenticate() {
        this.sendRequest({ authorize: this.token });
    }

    handleMessage(message) {
        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                return;
            }
            console.log('✅ Authenticated successfully');
            this.initializeSubscriptions();
        } else if (message.msg_type === 'history') {
            const asset = message.echo_req.ticks_history;
            this.handleTickHistory(asset, message.history);
        } else if (message.msg_type === 'tick') {
            if (message.subscription) {
                const asset = message.tick.symbol;
                this.tickSubscriptionIds[asset] = message.subscription.id;
            }
            this.handleTickUpdate(message.tick);
        } else if (message.msg_type === 'buy') {
            if (message.error) {
                console.error('Error placing trade:', message.error.message);
                this.tradeInProgress = false;
                return;
            }
            console.log('✅ Trade placed successfully');
            this.subscribeToOpenContract(message.buy.contract_id);
        } else if (message.msg_type === 'proposal_open_contract') {
            if (message.proposal_open_contract.is_sold) {
                this.handleTradeResult(message.proposal_open_contract);
            }
        }
    }

    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;
        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
            // console.log('📱 Telegram notification sent');
        } catch (error) {
            console.error(`❌ Failed to send Telegram message: ${error.message}`);
        }
    }

    async sendHourlySummary() {
        const stats = this.hourlyStats;
        const winRate = stats.wins + stats.losses > 0
            ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1)
            : 0;
        const pnlEmoji = stats.pnl >= 0 ? '🟢' : '🔴';
        const pnlStr = (stats.pnl >= 0 ? '+' : '') + '$' + stats.pnl.toFixed(2);

        const message = `
⏰ <b>x5 Differ Bot Hourly Summary</b>

📊 <b>Last Hour</b>
├ Trades: ${stats.trades}
├ Wins: ${stats.wins} | Losses: ${stats.losses}
├ Win Rate: ${winRate}%
└ ${pnlEmoji} <b>P&L:</b> ${pnlStr}

📈 <b>Daily Totals</b>
├ Total Trades: ${this.totalTrades}
├ Total W/L: ${this.totalWins}/${this.totalLosses}
├ Daily P&L: ${(this.totalProfitLoss >= 0 ? '+' : '')}$${this.totalProfitLoss.toFixed(2)}
└ Current Capital: $${(this.config.initialStake + this.totalProfitLoss).toFixed(2)}

⏰ ${new Date().toLocaleString()}
        `.trim();

        try {
            await this.sendTelegramMessage(message);
            console.log('📱 Telegram: Hourly Summary sent');
        } catch (error) {
            console.error(`❌ Telegram hourly summary failed: ${error.message}`);
        }

        // Reset hourly stats
        this.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };
    }

    startTelegramTimer() {
        // Schedule hourly summary at the top of every hour
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1);
        nextHour.setMinutes(0);
        nextHour.setSeconds(0);
        nextHour.setMilliseconds(0);

        const timeUntilNextHour = nextHour.getTime() - now.getTime();

        setTimeout(() => {
            this.sendHourlySummary();

            setInterval(() => {
                this.sendHourlySummary();
            }, 60 * 60 * 1000);
        }, timeUntilNextHour);

        console.log(`📱 Hourly summaries scheduled. First in ${Math.ceil(timeUntilNextHour / 60000)} minutes.`);
    }

    initializeSubscriptions() {
        console.log('Initializing subscriptions...');
        this.assets.forEach(asset => {
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });
            this.sendRequest({
                ticks: asset,
                subscribe: 1
            });
        });
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

    handleTickHistory(asset, history) {
        this.tickHistories[asset] = history.prices.map(price => this.getLastDigit(price, asset));
        console.log(`📊 Loaded ${this.tickHistories[asset].length} ticks for ${asset}`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.tickHistories[asset].push(lastDigit);
        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        }

        const now = Date.now();
        if (now - this.lastTickLogTime[asset] >= 30000) {
            console.log(`[${asset}] ${tick.quote}: ${this.tickHistories[asset].slice(-5).join(', ')}`);
            this.lastTickLogTime[asset] = now;
        }

        if (!this.tradeInProgress) {
            this.analyzeTicks(asset);
        }
    }


    analyzeTicks(asset) {
        if (this.tradeInProgress || this.suspendedAssets.has(asset)) return;

        const history = this.tickHistories[asset];
        this.lastPrediction = history[history.length - 1];

        this.volatilityLevel = this.getVolatilityLevel(this.tickHistories[asset]);

        // console.log(`Volatility: ${this.volatilityLevel}`);

        if (this.lastPrediction === this.tickHistories[asset][this.tickHistories[asset].length - 1] && this.lastPrediction === this.tickHistories[asset][this.tickHistories[asset].length - 2] && this.lastPrediction === this.tickHistories[asset][this.tickHistories[asset].length - 3] && this.lastPrediction === this.tickHistories[asset][this.tickHistories[asset].length - 4] && this.lastPrediction === this.tickHistories[asset][this.tickHistories[asset].length - 5] && this.volatilityLevel === 'medium') {
            // if (this.lastPrediction === this.tickHistories[asset][this.tickHistories[asset].length - 1] && this.lastPrediction === this.tickHistories[asset][this.tickHistories[asset].length - 2] && this.volatilityLevel === 'medium') {
            this.placeTrade(asset, this.lastPrediction);
        }
    }

    getVolatilityLevel(tickHistory) {
        if (tickHistory.length < 50) return;
        const recent = tickHistory.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        const stdDev = Math.sqrt(variance);

        // console.log(`Volatility stdDev: ${stdDev.toFixed(2)}`);

        if (stdDev > 3.1) return 'extreme';
        if (stdDev > 2.8) return 'high';
        if (stdDev > 2.0) return 'medium';

        return 'low';
    }


    placeTrade(asset, predictedDigit) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;

        console.log(`Placing Trade:  [${asset}] Digit ${predictedDigit} | Stake: $${this.currentStake.toFixed(2)}`);

        // Notify Trade Opened
        const message = `
            🔔 <b>Trade Opened (x5 Differ Bot)</b>

            📊 <b>${asset}</b>
            🎯 <b>Differ Digit:</b> ${predictedDigit}
            💰 <b>Stake:</b> $${this.currentStake.toFixed(2)}

            ⏰ ${new Date().toLocaleTimeString()}
        `.trim();
        this.sendTelegramMessage(message);

        this.sendRequest({
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
        });
    }

    subscribeToOpenContract(contractId) {
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });
    }


    handleTradeResult(contract) {
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const exitSpot = contract.exit_tick_display_value;
        this.actualDigit = this.getLastDigit(exitSpot, asset);

        console.log(`[${asset}] ${won ? '✅ WON' : '❌ LOST'} | Profit: $${profit.toFixed(2)}`);

        this.totalTrades++;
        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
            this.isWinTrade = true;
        } else {
            this.isWinTrade = false;
            this.totalLosses++;
            this.consecutiveLosses++;

            if (this.consecutiveLosses === 2) {
                this.x2Losses++;
            }
            if (this.consecutiveLosses === 3) {
                this.x3Losses++;
            }
            if (this.consecutiveLosses === 4) {
                this.x4Losses++;
            }
            if (this.consecutiveLosses === 5) {
                this.x5Losses++;
            }
            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            this.suspendAsset(asset);
        }

        this.totalProfitLoss += profit;

        // Update hourly stats
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;
        if (won) this.hourlyStats.wins++;
        else this.hourlyStats.losses++;

        // Send Trade Closed Notification
        const resultEmoji = won ? '✅ WIN' : '❌ LOSS';
        const pnlStr = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(2);
        const pnlColor = profit >= 0 ? '🟢' : '🔴';
        const winRate = ((this.totalWins / this.totalTrades) * 100).toFixed(1);

        const telegramMsg = `
            ${resultEmoji} (x5 Differ Bot)

            📊 <b>${asset}</b>
            ${pnlColor} <b>P&L:</b> ${pnlStr}
            📊 <b>Last Prediction:</b> ${this.lastPrediction}
            🎯 <b>Exit Digit:</b> ${this.actualDigit}

            📊 <b>Trades Today:</b> ${this.totalTrades}
            📊 <b>Wins Today:</b> ${this.totalWins}
            📊 <b>Losses Today:</b> ${this.totalLosses}
            📊 <b>x2Losses Today:</b> ${this.x2Losses}
            📊 <b>x3Losses Today:</b> ${this.x3Losses}
            📊 <b>x4Losses Today:</b> ${this.x4Losses}
            📊 <b>x5Losses Today:</b> ${this.x5Losses}

            📈 <b>Daily P&L:</b> ${(this.totalProfitLoss >= 0 ? '+' : '')}$${this.totalProfitLoss.toFixed(2)}
            🎯 <b>Win Rate:</b> ${winRate}%

            📊 <b>Current Stake:</b> $${this.currentStake.toFixed(2)}

            📊 <b>Suspended Assets:</b> ${Array.from(this.suspendedAssets).join(', ') || 'None'}

            ⏰ ${new Date().toLocaleTimeString()}
        `.trim();
        this.sendTelegramMessage(telegramMsg);

        if (!this.endOfDay) {
            this.logSummary();
        }

        // Check stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('🛑 Stop loss reached');
            this.sendTelegramMessage(`🛑 <b>Stop Loss Reached!</b>\nFinal P&L: $${this.totalProfitLoss.toFixed(2)}`);
            this.endOfDay = true;
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('🎉 Take profit reached');
            this.sendTelegramMessage(`🎉 <b>Take Profit Reached!</b>\nFinal P&L: $${this.totalProfitLoss.toFixed(2)}`);
            this.endOfDay = true;
            this.disconnect();
            return;
        }

        this.disconnect();

        const waitTime = Math.floor(Math.random() *
            (this.config.maxWaitTime - this.config.minWaitTime + 1)) + this.config.minWaitTime;

        console.log(`⏳ Waiting ${Math.round(waitTime / 60000)} minutes before next trade...\n`);

        if (!this.endOfDay) {
            setTimeout(() => {
                this.tradeInProgress = false;
                this.connect();
            }, waitTime);
        }
    }

    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
        console.log(`🚫 Suspended: ${asset}`);

        if (this.suspendedAssets.size > 1) {
            const first = Array.from(this.suspendedAssets)[0];
            this.suspendedAssets.delete(first);
            console.log(`✅ Reactivated: ${first}`);
        }
    }

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
                    this.sendHourlySummary(); // Send final summary
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000); // Check every 20 seconds
    }

    logSummary() {
        console.log('\n📊 TRADING SUMMARY');
        console.log(`Trades: ${this.totalTrades}`);
        console.log(`Wins: ${this.totalWins}`);
        console.log(`Losses: ${this.totalLosses}`);
        console.log(`x2Losse: ${this.x2Losses}`);
        console.log(`x3Losse: ${this.x3Losses}`);
        console.log(`x4Losse: ${this.x4Losses}`);
        console.log(`x5Losse: ${this.x5Losses}`);
        console.log(`Last Prediction: ${this.lastPrediction}| Actual Digit: ${this.actualDigit}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`P&L: $${this.totalProfitLoss.toFixed(2)} | Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
    }



    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
    }

    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    start() {
        this.connect();
        // this.checkTimeForDisconnectReconnect();
    }
}

// Initialize and start bot
const bot = new AIWeightedEnsembleBot('0P94g4WdSrSrzir', {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir'
    initialStake: 5.7,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 129,
    takeProfit: 5000,
    requiredHistoryLength: 1000,
    minWaitTime: 1000, // 2 Minutes
    maxWaitTime: 3000, // 5 Minutes
});

bot.start();
