require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'riseFall1-state00001.json');
const STATE_SAVE_INTERVAL = 5000; // Save every 5 seconds

class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                config: {
                    initialStake: bot.config.initialStake,
                    multiplier: bot.config.multiplier,
                    maxConsecutiveLosses: bot.config.maxConsecutiveLosses,
                    stopLoss: bot.config.stopLoss,
                    takeProfit: bot.config.takeProfit,
                    requiredHistoryLength: bot.config.requiredHistoryLength
                },
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    x2Losses: bot.x2Losses,
                    x3Losses: bot.x3Losses,
                    x4Losses: bot.x4Losses,
                    x5Losses: bot.x5Losses,
                    totalProfitLoss: bot.totalProfitLoss,
                    lastPrediction: bot.lastPrediction,
                    actualDigit: bot.actualDigit,
                    volatilityLevel: bot.volatilityLevel
                },
                subscriptions: {
                    // FIXED: tickSubscriptionIds is already an object, not a Map
                    tickSubscriptionIds: { ...bot.tickSubscriptionIds },
                    // FIXED: Convert Set to Array properly
                    activeSubscriptions: Array.from(bot.activeSubscriptions),
                    contractSubscription: bot.contractSubscription
                },
                assets: {}
            };

            // Save tick histories and last logs for each asset
            bot.assets.forEach(asset => {
                persistableState.assets[asset] = {
                    tickHistory: bot.tickHistories[asset].slice(-100), // Keep last 100 ticks
                    lastTickLogTime: bot.lastTickLogTime[asset]
                };
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
            // console.log('💾 State saved to disk');
        } catch (error) {
            console.error(`Failed to save state: ${error.message}`);
            console.error('Error stack:', error.stack);
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                console.log('📂 No previous state file found, starting fresh');
                return false;
            }

            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            // Only restore if state is less than 30 minutes old
            if (ageMinutes > 30) {
                console.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            console.log(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);
            return savedData;
        } catch (error) {
            console.error(`Failed to load state: ${error.message}`);
            console.error('Error stack:', error.stack);
            return false;
        }
    }

    static startAutoSave(bot) {
        setInterval(() => {
            StatePersistence.saveState(bot);
        }, STATE_SAVE_INTERVAL);
        console.log('🔄 Auto-save started (every 5 seconds)');
    }
}

class AIWeightedEnsembleBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = [
            // 'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'
            // 'stpRNG'
            'RDBEAR'
        ];

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
        this.x6Losses = 0;
        this.x7Losses = 0;
        this.x8Losses = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.suspendedAssets = new Set();
        this.endOfDay = false;
        this.isWinTrade = false;
        this.lastPrediction = null;
        this.actualDigit = null;

        // Reconnection logic
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50; // Increased for better resilience
        this.reconnectDelay = 5000; // Start with 5 seconds
        this.reconnectTimer = null;
        this.isReconnecting = false;

        // Heartbeat/Ping mechanism
        this.pingInterval = null;
        this.checkDataInterval = null;
        this.pongTimeout = null;
        this.lastPongTime = Date.now();
        this.lastDataTime = Date.now();
        this.pingIntervalMs = 20000; // Ping every 20 seconds
        this.pongTimeoutMs = 10000; // Expect pong within 10 seconds
        this.dataTimeoutMs = 60000; // Force reconnect if no data for 60s

        // Message queue for failed sends
        this.messageQueue = [];
        this.maxQueueSize = 50;

        // Active subscriptions tracking
        this.activeSubscriptions = new Set();
        this.contractSubscription = null;

        this.WINDOWS = [
            { size: 50, weight: 1.0 },
            { size: 100, weight: 1.0 },
            { size: 200, weight: 1.0 },
            { size: 500, weight: 2.5 }
        ];

        this.CONCENTRATION_WEIGHT = 0.60;
        this.STREAK_WEIGHT = 0.40;

        // Baseline expectations for random data
        // For 10 equally likely outcomes:
        this.EXPECTED_ENTROPY_RATIO = 0.95; // Random data is ~95% of max entropy
        this.EXPECTED_MAX_STREAK_RATIO = 0.35; // Max streak is ~35% of log2(n)

        // Thresholds based on deviation from expected
        // Negative deviation = less random than expected = more predictable
        this.TRADEABLE_LEVELS = ['low', 'ultra-low'];

        this.System = 1; // 1 = Continue same direction on Win and Switch direction on Loss, 
        // 2 = Switch direction on Win and Continue same direction on Loss, 
        // 3 = Switch direction every trade, 4 = Same direction every trade
        this.iDirection = 'RISE'; //Set initial direction 'RISE' or 'FALL'

        // Contract Configuration
        this.DURATION = 116;
        this.DURATION_UNIT = 's';
        this.lastTradeDirection = null;
        this.lastTradeWasWin = false;

        // Telegram Configuration
        this.telegramToken = '8335656318:AAEVL50j7n8ZdQHcC-3ov6OYOTOh5ZyEgE0';
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

        // Load saved state if available
        this.loadSavedState();
    }

    loadSavedState() {
        const savedState = StatePersistence.loadState();
        if (!savedState) return;

        try {
            // Restore trading state
            const trading = savedState.trading;
            this.currentStake = trading.currentStake;
            this.consecutiveLosses = trading.consecutiveLosses;
            this.totalTrades = trading.totalTrades;
            this.totalWins = trading.totalWins;
            this.totalLosses = trading.totalLosses;
            this.x2Losses = trading.x2Losses;
            this.x3Losses = trading.x3Losses;
            this.x4Losses = trading.x4Losses;
            this.x5Losses = trading.x5Losses;
            this.x6Losses = trading.x6Losses;
            this.x7Losses = trading.x7Losses;
            this.x8Losses = trading.x8Losses;
            this.totalProfitLoss = trading.totalProfitLoss;
            this.lastPrediction = trading.lastPrediction;
            this.actualDigit = trading.actualDigit;
            this.volatilityLevel = trading.volatilityLevel;

            // Restore tick histories
            savedState.assets && Object.keys(savedState.assets).forEach(asset => {
                if (this.tickHistories[asset]) {
                    this.tickHistories[asset] = savedState.assets[asset].tickHistory || [];
                }
            });

            console.log('✅ State restored successfully');
            console.log(`   Trades: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalLosses}`);
            console.log(`   P&L: $${this.totalProfitLoss.toFixed(2)} | Current Stake: $${this.currentStake.toFixed(2)}`);
        } catch (error) {
            console.error(`Error restoring state: ${error.message}`);
        }
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('Already connected');
            return;
        }

        console.log('🔌 Connecting to Deriv API...');

        // Clear any existing connection
        this.cleanup();

        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.wsReady = false; // Wait for auth
            this.reconnectAttempts = 0;
            this.isReconnecting = false; // Reset reconnecting flag
            this.lastPongTime = Date.now();
            this.lastDataTime = Date.now();

            this.startMonitor();
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            this.lastPongTime = Date.now();
            this.lastDataTime = Date.now();
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

    startMonitor() {
        this.stopMonitor();

        // Ping to keep connection alive (every 20 seconds)
        this.pingInterval = setInterval(() => {
            if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();

                // Check if we received pong recently
                this.pongTimeout = setTimeout(() => {
                    const timeSinceLastPong = Date.now() - this.lastPongTime;
                    if (timeSinceLastPong > this.pongTimeoutMs) {
                        console.warn('⚠️ No pong received, connection may be dead');
                    }
                }, this.pongTimeoutMs);
            }
        }, this.pingIntervalMs);

        // Check for data silence (every 10 seconds)
        this.checkDataInterval = setInterval(() => {
            if (!this.connected) return;

            const silenceDuration = Date.now() - this.lastDataTime;
            if (silenceDuration > this.dataTimeoutMs) {
                console.error(`⚠️ No data for ${Math.round(silenceDuration / 1000)}s - Forcing reconnection...`);
                StatePersistence.saveState(this);
                if (this.ws) this.ws.terminate();
            }
        }, 10000);

        console.log('🔄 Connection monitoring started');
    }

    stopMonitor() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.checkDataInterval) {
            clearInterval(this.checkDataInterval);
            this.checkDataInterval = null;
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

            // Process queued messages first
            this.processMessageQueue();

            // Then initialize/restore subscriptions
            this.initializeSubscriptions();

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
                console.log('Auth error detected, triggering reconnection...');
                this.handleDisconnect();
            }
        }
    }

    restoreSubscriptions() {
        console.log('📊 Restoring subscriptions after reconnection...');
        this.assets.forEach(asset => {
            // Restore tick subscription
            const oldSubId = this.tickSubscriptionIds[asset];
            if (oldSubId) {
                console.log(`  ✅ Re-subscribing to ${asset}`);
                this.sendRequest({
                    ticks: asset,
                    subscribe: 1
                });
            }
        });
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
            ⏰ <b>Rise/Fall Bot Hourly Summary</b>

            📊 <b>Last Hour</b>
            ├ Trades: ${stats.trades}
            ├ Wins: ${stats.wins} | Losses: ${stats.losses}
            ├ Win Rate: ${winRate}%
            └ ${pnlEmoji} <b>P&L:</b> ${pnlStr}

            📈 <b>Daily Totals</b>
            ├ Total Trades: ${this.totalTrades}
            ├ Total W/L: ${this.totalWins}/${this.totalLosses}
            ├ x2 Losses: ${this.x2Losses}
            ├ x3 Losses: ${this.x3Losses}
            ├ x4 Losses: ${this.x4Losses}
            ├ x5 Losses: ${this.x5Losses}
            ├ x6 Losses: ${this.x6Losses}
            ├ x7 Losses: ${this.x7Losses}
            ├ x8 Losses: ${this.x8Losses}
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
        console.log('📊 Initializing/restoring subscriptions...');
        this.assets.forEach(asset => {
            // Request historical data
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });

            // Subscribe to live ticks
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
        } else if (['stpRNG'].includes(asset)) {
            return fractionalPart.length >= 1 ? parseInt(fractionalPart[0]) : 0;
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
        // if (now - this.lastTickLogTime[asset] >= 30000) {
        console.log(`[${asset}] ${tick.quote}: ${this.tickHistories[asset].slice(-5).join(', ')}`);
        this.lastTickLogTime[asset] = now;
        // }

        if (!this.tradeInProgress && this.wsReady) {
            this.analyzeTicks(asset);
        }
    }

    analyzeTicks(asset) {
        if (this.tradeInProgress || this.suspendedAssets.has(asset) || !this.wsReady) return;

        const history = this.tickHistories[asset];
        if (history.length < 5) return;

        this.lastPrediction = history[history.length - 1];
        const volatility = this.calculateVolatilityLevel(history);
        this.volatilityLevel = this.getVolatilityLevel(history);

        console.log(`[${asset}] Volatility1: ${this.volatilityLevel} | Volatility2: ${volatility.level}| Score: ${volatility.score}`);

        if (
            volatility.level === 'ultra-low' &&
            (this.volatilityLevel === 'medium' ||
                this.volatilityLevel === 'low')
        ) {
            // NEW LOGIC: Determine next direction based on last trade result
            let direction;
            if (this.lastTradeDirection === null || this.lastTradeWasWin === null || this.System === 4) {
                // First trade - start with CALL (Rise)
                this.iDirection === 'RISE' ? direction = 'RISE' : direction = 'FALL';
            } else {
                // If last trade was a win, continue with same direction
                // If last trade was a loss, switch direction
                if (this.lastTradeWasWin) {
                    if (this.System === 1) {
                        direction = this.lastTradeDirection; // Continue same direction
                    } else if (this.System === 2) {
                        direction = this.lastTradeDirection === 'RISE' ? 'FALL' : 'RISE'; // Switch direction
                    } else if (this.System === 3) {
                        direction = this.lastTradeDirection === 'RISE' ? 'FALL' : 'RISE'; // Switch direction
                    }
                } else {
                    if (this.System === 1) {
                        direction = this.lastTradeDirection === 'RISE' ? 'FALL' : 'RISE'; // Switch direction
                    } else if (this.System === 2) {
                        direction = direction = this.lastTradeDirection; // Continue same direction
                    } else if (this.System === 3) {
                        direction = this.lastTradeDirection === 'RISE' ? 'FALL' : 'RISE'; // Switch direction
                    }
                }
            }

            this.placeTrade(asset, direction);
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

    calculateDeviation(history, windowSize) {
        if (history.length < windowSize) return null;


        const window = history.slice(-windowSize);

        // Calculate actual entropy
        const frequency = Array(10).fill(0);
        window.forEach(d => frequency[d]++);

        let entropy = 0;
        for (let i = 0; i < 10; i++) {
            if (frequency[i] > 0) {
                const p = frequency[i] / windowSize;
                entropy -= p * Math.log2(p);
            }
        }
        const maxEntropy = Math.log2(10);
        const entropyRatio = entropy / maxEntropy;

        // Calculate actual max streak
        let maxStreak = 1, currentStreak = 1;
        for (let i = 1; i < window.length; i++) {
            if (window[i] === window[i - 1]) {
                currentStreak++;
                maxStreak = Math.max(maxStreak, currentStreak);
            } else {
                currentStreak = 1;
            }
        }
        const expectedMaxStreak = Math.log2(windowSize);
        const streakRatio = maxStreak / expectedMaxStreak;

        // Calculate deviations from expected
        // Positive = more random than expected
        // Negative = less random than expected (more predictable)
        const entropyDeviation = (entropyRatio - this.EXPECTED_ENTROPY_RATIO) / this.EXPECTED_ENTROPY_RATIO;
        const streakDeviation = (streakRatio - this.EXPECTED_MAX_STREAK_RATIO) / this.EXPECTED_MAX_STREAK_RATIO;

        return {
            entropyDeviation,
            streakDeviation,
            entropyRatio,
            streakRatio,
            maxStreak
        };
    }

    calculateVolatilityLevel(history) {
        let entropyDeviationSum = 0;
        let streakDeviationSum = 0;
        let totalWeight = 0;
        const windowResults = [];

        for (const { size, weight } of this.WINDOWS) {
            const deviation = this.calculateDeviation(history, size);

            if (deviation !== null) {
                entropyDeviationSum += deviation.entropyDeviation * weight;
                streakDeviationSum += deviation.streakDeviation * weight;
                totalWeight += weight;

                windowResults.push({
                    window: size,
                    entropyDev: (deviation.entropyDeviation * 100).toFixed(1) + '%',
                    streakDev: (deviation.streakDeviation * 100).toFixed(1) + '%',
                    maxStreak: deviation.maxStreak
                });
            }
        }

        if (totalWeight === 0) {
            return { level: 'unknown', canTrade: false };
        }

        // Weighted average deviations
        const avgEntropyDev = entropyDeviationSum / totalWeight;
        const avgStreakDev = streakDeviationSum / totalWeight;

        // Combined deviation score
        // Negative = more predictable than expected
        const combinedDeviation = avgEntropyDev * this.CONCENTRATION_WEIGHT +
            (-avgStreakDev) * this.STREAK_WEIGHT;

        // console.log('Combined Deviation:', combinedDeviation);

        // Determine level based on how much less random than expected
        let level;
        if (combinedDeviation > 0.05) {
            level = 'extreme';       // More random than expected
        } else if (combinedDeviation > 0.02) {
            level = 'high';          // Slightly more random
        } else if (combinedDeviation > -0.02) {
            level = 'medium';        // Around expected randomness
        } else if (combinedDeviation > -0.05) {
            level = 'low';           // Slightly less random (tradeable!)
        } else {
            level = 'ultra-low';     // Much less random (definitely tradeable!)
        }

        const canTrade = this.TRADEABLE_LEVELS.includes(level);

        return {
            level,
            score: combinedDeviation,
            canTrade,
            avgEntropyDeviation: avgEntropyDev,
            avgStreakDeviation: avgStreakDev,
            windowResults
        };
    }

    placeTrade(asset, direction) {
        if (this.tradeInProgress || !this.wsReady) return;

        this.lastTradeDirection = direction;

        const kDirection = direction === 'CALL' ? 'CALL' : 'PUTE';

        this.tradeInProgress = true;

        console.log(`Placing Trade: [${asset}] Direction: ${direction} | Stake: $${this.currentStake.toFixed(2)}`);

        const message = `
            🔔 <b>Trade Opened (Rise/Fall Bot)</b>

            📊 <b>${asset}</b>
            🎯 <b>Direction:</b> ${direction}
            ⏰ <b>Duration:</b> ${this.DURATION} (${this.DURATION_UNIT})
            💰 <b>Stake:</b> $${this.currentStake.toFixed(2)}
            Last10Digits = ${this.tickHistories[asset].slice(-10).join(',')}
            Volatility = ${this.volatilityLevel}
        `.trim();
        this.sendTelegramMessage(message);

        const success = this.sendRequest({
            buy: 1,
            price: this.currentStake,
            parameters: {
                contract_type: kDirection,
                symbol: asset,
                currency: 'USD',
                amount: this.currentStake.toFixed(2),
                duration: this.DURATION,
                duration_unit: this.DURATION_UNIT,
                basis: 'stake'
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
            this.lastTradeWasWin = true;
        } else {
            this.isWinTrade = false;
            this.lastTradeWasWin = false;
            this.totalLosses++;
            this.consecutiveLosses++;

            if (this.consecutiveLosses === 2) this.x2Losses++;
            if (this.consecutiveLosses === 3) this.x3Losses++;
            if (this.consecutiveLosses === 4) this.x4Losses++;
            if (this.consecutiveLosses === 5) this.x5Losses++;
            if (this.consecutiveLosses === 6) this.x6Losses++;
            if (this.consecutiveLosses === 7) this.x7Losses++;
            if (this.consecutiveLosses === 8) this.x8Losses++;

            if (this.consecutiveLosses === 7) {
                this.currentStake = this.config.initialStake;
                this.consecutiveLosses = 0;
            } else {
                this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            }
            // this.suspendAsset(asset);
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
            ${resultEmoji} (Rise/Fall Bot)
            
            📊 <b>${asset}</b>
            ${pnlColor} <b>P&L:</b> ${pnlStr}
            📊 <b>Prediction:</b> ${this.lastTradeDirection}
            ⏰ Duration: ${this.DURATION} (${this.DURATION_UNIT})
            Last10Digits = ${this.tickHistories[asset].slice(-10).join(',')}
            Volatility = ${this.volatilityLevel}
            
            📊 <b>Trades Today:</b> ${this.totalTrades}
            📊 <b>Wins Today:</b> ${this.totalWins}
            📊 <b>Losses Today:</b> ${this.totalLosses}
            📊 <b>x2-x5 Losses:</b> ${this.x2Losses}/${this.x3Losses}/${this.x4Losses}/${this.x5Losses}/${this.x6Losses}/${this.x7Losses}/${this.x8Losses}}
            
            📈 <b>Daily P&L:</b> ${(this.totalProfitLoss >= 0 ? '+' : '')}$${this.totalProfitLoss.toFixed(2)}
            🎯 <b>Win Rate:</b> ${winRate}%
            
            📊 <b>Current Stake:</b> $${this.currentStake.toFixed(2)}
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
            this.sendHourlySummary();
            this.endOfDay = true;
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('🎉 Take profit reached');
            this.sendTelegramMessage(`🎉 <b>Take Profit Reached!</b>\nFinal P&L: $${this.totalProfitLoss.toFixed(2)}`);
            this.sendHourlySummary();
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
            const currentDay = gmtPlus1Time.getUTCDay(); // 0: Sunday, 1: Monday, ..., 6: Saturday
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Weekend logic: Saturday 11pm to Monday 2am GMT+1 -> Disconnect and stay disconnected
            const isWeekend = (currentDay === 0) || // Sunday
                (currentDay === 6 && currentHours >= 23) || // Saturday after 11pm
                (currentDay === 1 && currentHours < 2);    // Monday before 2am

            if (isWeekend) {
                if (!this.endOfDay) {
                    console.log("Weekend trading suspension (Saturday 11pm - Monday 2am). Disconnecting...");
                    this.sendHourlySummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
                return; // Prevent any reconnection logic during the weekend
            }

            if (this.endOfDay && currentHours === 2 && currentMinutes >= 0) {
                console.log("It's 2:00 AM GMT+1, reconnecting the bot.");
                this.resetDailyStats();
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 23 && currentMinutes >= 0) {
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
        console.log(`x2-x5 Losses: ${this.x2Losses}/${this.x3Losses}/${this.x4Losses}/${this.x5Losses}/${this.x6Losses}/${this.x7Losses}/${this.x8Losses}`);
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

        // Only proceed if not already handling disconnect
        if (this.isReconnecting) {
            console.log('Already handling disconnect, skipping...');
            return;
        }

        this.connected = false;
        this.wsReady = false;
        this.stopMonitor();

        // Save state immediately on disconnect
        StatePersistence.saveState(this);

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            this.sendTelegramMessage(
                `❌ <b>Max Reconnection Attempts Reached</b>\n` +
                `Please restart the bot manually.\n` +
                `Final P&L: $${this.totalProfitLoss.toFixed(2)}`
            );
            this.isReconnecting = false;
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        // Exponential backoff: 5s, 7.5s, 11.25s, etc., max 30 seconds
        const delay = Math.min(
            this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1),
            30000
        );

        console.log(
            `🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... ` +
            `(Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
        );
        console.log(
            `📊 Preserved state - Trades: ${this.totalTrades}, ` +
            `P&L: $${this.totalProfitLoss.toFixed(2)}`
        );

        this.sendTelegramMessage(
            `⚠️ <b>CONNECTION LOST - RECONNECTING</b>\n` +
            `📊 Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
            `⏱️ Retrying in ${(delay / 1000).toFixed(1)}s\n` +
            `💾 State preserved: ${this.totalTrades} trades, $${this.totalProfitLoss.toFixed(2)} P&L`
        );

        // Clear any existing reconnect timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(() => {
            console.log('🔄 Attempting reconnection...');
            this.isReconnecting = false; // Reset flag before connecting
            this.connect();
        }, delay);
    }

    cleanup() {
        this.stopMonitor();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN ||
                this.ws.readyState === WebSocket.CONNECTING) {
                try {
                    this.ws.close();
                } catch (e) {
                    console.log('WebSocket already closed');
                }
            }
            this.ws = null;
        }

        // Don't clear activeSubscriptions here - we need them for reconnection
        // Only clear when explicitly disconnecting (endOfDay = true)
        if (this.endOfDay) {
            this.activeSubscriptions.clear();
        }

        this.connected = false;
        this.wsReady = false;
    }

    disconnect() {
        console.log('🛑 Disconnecting bot...');
        StatePersistence.saveState(this);
        this.endOfDay = true; // Prevent reconnection
        this.cleanup();
        console.log('✅ Bot disconnected successfully');
    }

    start() {
        console.log('🚀 Starting Rise/Fall Bot...');
        console.log(`📊 Session Summary:`);
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins/Losses: ${this.totalWins}/${this.totalLosses}`);
        console.log(`   Total P&L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`   Current Stake: $${this.currentStake.toFixed(2)}`);
        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// Initialize and start bot
const bot = new AIWeightedEnsembleBot('0P94g4WdSrSrzir', {
    initialStake: 0.35,
    multiplier: 2.3,
    maxConsecutiveLosses: 12,
    stopLoss: 100,
    takeProfit: 5000,
    requiredHistoryLength: 3000,
    minWaitTime: 1000,
    maxWaitTime: 3000,
});

// Start auto-save immediately
StatePersistence.startAutoSave(bot);

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
