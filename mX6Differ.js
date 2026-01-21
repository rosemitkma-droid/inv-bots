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

        // Reconnection logic
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000; // Start with 5 seconds
        this.reconnectTimer = null;
        this.isReconnecting = false;

        // Heartbeat/Ping mechanism
        this.pingInterval = null;
        this.pongTimeout = null;
        this.lastPongTime = Date.now();
        this.pingIntervalMs = 30000; // Ping every 30 seconds
        this.pongTimeoutMs = 10000; // Expect pong within 10 seconds

        // Message queue for failed sends
        this.messageQueue = [];
        this.maxQueueSize = 50;

        // Active subscriptions tracking
        this.activeSubscriptions = new Set();
        this.contractSubscription = null;

        // Telegram Configuration
        this.telegramToken = '8218636914:AAGvaKFh8MT769-_9eOEiU4XKufL0aHRhZ4';
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
        if (this.isReconnecting) {
            console.log('Already attempting to reconnect...');
            return;
        }

        console.log('Connecting to Deriv API...');

        // Clear any existing connection
        this.cleanup();

        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.wsReady = false; // Wait for auth
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            this.lastPongTime = Date.now();

            this.authenticate();
            this.startHeartbeat();
        });

        this.ws.on('message', (data) => {
            this.lastPongTime = Date.now(); // Any message counts as activity
            try {
                const message = JSON.parse(data);
                this.handleMessage(message);
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error.message);
        });

        this.ws.on('close', (code, reason) => {
            console.log(`Disconnected from Deriv API (Code: ${code}, Reason: ${reason || 'None'})`);
            this.handleDisconnect();
        });

        this.ws.on('pong', () => {
            this.lastPongTime = Date.now();
        });
    }

    startHeartbeat() {
        this.stopHeartbeat();

        // Send ping every 30 seconds
        this.pingInterval = setInterval(() => {
            if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();

                // Check if we received pong recently
                this.pongTimeout = setTimeout(() => {
                    const timeSinceLastPong = Date.now() - this.lastPongTime;
                    if (timeSinceLastPong > this.pongTimeoutMs) {
                        console.warn('⚠️ No pong received, connection may be dead');
                        this.handleDisconnect();
                    }
                }, this.pongTimeoutMs);
            }
        }, this.pingIntervalMs);
    }

    stopHeartbeat() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    sendRequest(request) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('Cannot send request: WebSocket not ready');
            // Queue the message for later
            if (this.messageQueue.length < this.maxQueueSize) {
                this.messageQueue.push(request);
            }
            return false;
        }

        try {
            this.ws.send(JSON.stringify(request));
            return true;
        } catch (error) {
            console.error('Error sending request:', error.message);
            if (this.messageQueue.length < this.maxQueueSize) {
                this.messageQueue.push(request);
            }
            return false;
        }
    }

    processMessageQueue() {
        if (this.messageQueue.length === 0) return;

        console.log(`Processing ${this.messageQueue.length} queued messages...`);
        const queue = [...this.messageQueue];
        this.messageQueue = [];

        queue.forEach(message => {
            this.sendRequest(message);
        });
    }

    authenticate() {
        this.sendRequest({ authorize: this.token });
    }

    handleMessage(message) {
        // Handle ping response
        if (message.msg_type === 'ping') {
            this.sendRequest({ ping: 1 });
            return;
        }

        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                this.sendTelegramMessage(`❌ <b>Authentication Failed:</b> ${message.error.message}`);
                return;
            }
            console.log('✅ Authenticated successfully');
            this.wsReady = true;
            this.initializeSubscriptions();
            this.processMessageQueue();
        } else if (message.msg_type === 'history') {
            const asset = message.echo_req.ticks_history;
            this.handleTickHistory(asset, message.history);
        } else if (message.msg_type === 'tick') {
            if (message.subscription) {
                const asset = message.tick.symbol;
                this.tickSubscriptionIds[asset] = message.subscription.id;
                this.activeSubscriptions.add(message.subscription.id);
            }
            this.handleTickUpdate(message.tick);
        } else if (message.msg_type === 'buy') {
            if (message.error) {
                console.error('Error placing trade:', message.error.message);
                this.sendTelegramMessage(`❌ <b>Trade Error:</b> ${message.error.message}`);
                this.tradeInProgress = false;
                return;
            }
            console.log('✅ Trade placed successfully');
            this.subscribeToOpenContract(message.buy.contract_id);
        } else if (message.msg_type === 'proposal_open_contract') {
            if (message.proposal_open_contract.is_sold) {
                this.handleTradeResult(message.proposal_open_contract);
            }
        } else if (message.error) {
            console.error('API Error:', message.error.message);
            // Handle specific errors that require reconnection
            if (message.error.code === 'AuthorizationRequired' ||
                message.error.code === 'InvalidToken') {
                this.handleDisconnect();
            }
        }
    }

    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;
        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
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
⏰ <b>x6 Differ Bot Hourly Summary</b>

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

        this.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };
    }

    startTelegramTimer() {
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

        if (!this.tradeInProgress && this.wsReady) {
            this.analyzeTicks(asset);
        }
    }

    analyzeTicks(asset) {
        if (this.tradeInProgress || this.suspendedAssets.has(asset) || !this.wsReady) return;

        const history = this.tickHistories[asset];
        if (history.length < 5) return;

        this.lastPrediction = history[history.length - 1];
        this.volatilityLevel = this.getVolatilityLevel(history);

        if (
            this.lastPrediction === history[history.length - 2] &&
            this.lastPrediction === history[history.length - 3] &&
            this.lastPrediction === history[history.length - 4] &&
            this.lastPrediction === history[history.length - 5] &&
            this.lastPrediction === history[history.length - 6] &&
            this.volatilityLevel === 'medium'
        ) {
            this.placeTrade(asset, this.lastPrediction);
        }
    }

    getVolatilityLevel(tickHistory) {
        if (tickHistory.length < 50) return 'unknown';
        const recent = tickHistory.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        const stdDev = Math.sqrt(variance);

        if (stdDev > 3.1) return 'extreme';
        if (stdDev > 2.8) return 'high';
        if (stdDev > 2.0) return 'medium';

        return 'low';
    }

    placeTrade(asset, predictedDigit) {
        if (this.tradeInProgress || !this.wsReady) return;

        this.tradeInProgress = true;

        console.log(`Placing Trade: [${asset}] Digit ${predictedDigit} | Stake: $${this.currentStake.toFixed(2)}`);

        const message = `
            🔔 <b>Trade Opened (x6 Differ Bot)</b>

            📊 <b>${asset}</b>
            🎯 <b>Differ Digit:</b> ${predictedDigit}
            💰 <b>Stake:</b> $${this.currentStake.toFixed(2)}

            ⏰ ${new Date().toLocaleTimeString()}
        `.trim();
        this.sendTelegramMessage(message);

        const success = this.sendRequest({
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

        if (!success) {
            console.error('Failed to send trade request');
            this.tradeInProgress = false;
        }
    }

    subscribeToOpenContract(contractId) {
        this.contractSubscription = contractId;
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

            if (this.consecutiveLosses === 2) this.x2Losses++;
            if (this.consecutiveLosses === 3) this.x3Losses++;
            if (this.consecutiveLosses === 4) this.x4Losses++;
            if (this.consecutiveLosses === 5) this.x5Losses++;

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            this.suspendAsset(asset);
        }

        this.totalProfitLoss += profit;

        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;
        if (won) this.hourlyStats.wins++;
        else this.hourlyStats.losses++;

        const resultEmoji = won ? '✅ WIN' : '❌ LOSS';
        const pnlStr = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(2);
        const pnlColor = profit >= 0 ? '🟢' : '🔴';
        const winRate = ((this.totalWins / this.totalTrades) * 100).toFixed(1);

        const telegramMsg = `
            ${resultEmoji} (x6 Differ Bot)
            
            📊 <b>${asset}</b>
            ${pnlColor} <b>P&L:</b> ${pnlStr}
            📊 <b>Last Prediction:</b> ${this.lastPrediction}
            🎯 <b>Exit Digit:</b> ${this.actualDigit}
            Last10Digits = ${this.tickHistories[asset].slice(-10).join(',')}
            
            📊 <b>Trades Today:</b> ${this.totalTrades}
            📊 <b>Wins Today:</b> ${this.totalWins}
            📊 <b>Losses Today:</b> ${this.totalLosses}
            📊 <b>x2-x5 Losses:</b> ${this.x2Losses}/${this.x3Losses}/${this.x4Losses}/${this.x5Losses}
            
            📈 <b>Daily P&L:</b> ${(this.totalProfitLoss >= 0 ? '+' : '')}$${this.totalProfitLoss.toFixed(2)}
            🎯 <b>Win Rate:</b> ${winRate}%
            
            📊 <b>Current Stake:</b> $${this.currentStake.toFixed(2)}
            
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

        this.tradeInProgress = false;
        this.contractSubscription = null;
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
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            if (this.endOfDay && currentHours === 2 && currentMinutes >= 0) {
                console.log("It's 2:00 AM GMT+1, reconnecting the bot.");
                this.resetDailyStats();
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 11 && currentMinutes >= 0) {
                    console.log("It's past 23:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendHourlySummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    resetDailyStats() {
        this.tradeInProgress = false;
        this.suspendedAssets.clear();
        this.isWinTrade = false;
    }

    logSummary() {
        console.log('\n📊 TRADING SUMMARY');
        console.log(`Trades: ${this.totalTrades}`);
        console.log(`Wins: ${this.totalWins}`);
        console.log(`Losses: ${this.totalLosses}`);
        console.log(`x2-x5 Losses: ${this.x2Losses}/${this.x3Losses}/${this.x4Losses}/${this.x5Losses}`);
        console.log(`Last Prediction: ${this.lastPrediction} | Actual Digit: ${this.actualDigit}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`P&L: $${this.totalProfitLoss.toFixed(2)} | Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
    }

    handleDisconnect() {
        if (this.endOfDay) {
            console.log('Planned shutdown, not reconnecting.');
            this.cleanup();
            return;
        }

        this.connected = false;
        this.wsReady = false;
        this.cleanup();

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            this.sendTelegramMessage('❌ <b>Bot Disconnected:</b> Max reconnection attempts reached');
            return;
        }

        if (this.isReconnecting) {
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        // Exponential backoff: 5s, 10s, 20s, 40s, etc., max 5 minutes
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 300000);

        console.log(`🔄 Reconnecting in ${delay / 1000}s (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, delay);
    }

    cleanup() {
        this.stopHeartbeat();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close();
            }
            this.ws = null;
        }

        this.activeSubscriptions.clear();
    }

    disconnect() {
        console.log('Disconnecting bot...');
        this.endOfDay = true; // Prevent reconnection
        this.cleanup();
    }

    start() {
        console.log('🚀 Starting AI Weighted Ensemble Bot...');
        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// Initialize and start bot
const bot = new AIWeightedEnsembleBot('0P94g4WdSrSrzir', {
    initialStake: 5.7,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 129,
    takeProfit: 5000,
    requiredHistoryLength: 1000,
    minWaitTime: 1000,
    maxWaitTime: 3000,
});

bot.start();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n⚠️ Received SIGINT, shutting down gracefully...');
    bot.disconnect();
    setTimeout(() => process.exit(0), 2000);
});

process.on('SIGTERM', () => {
    console.log('\n⚠️ Received SIGTERM, shutting down gracefully...');
    bot.disconnect();
    setTimeout(() => process.exit(0), 2000);
});
