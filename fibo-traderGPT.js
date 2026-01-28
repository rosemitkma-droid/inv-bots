/**
 * Deriv Digit Differ Bot (Fibonacci-Weighted "Unlikely Digit" Predictor)
 *
 * IMPORTANT:
 *  - Do NOT hardcode tokens in code. Use .env:
 *      DERIV_TOKEN=...
 *      TELEGRAM_BOT_TOKEN=...
 *      TELEGRAM_CHAT_ID=...
 *
 *  - This bot now predicts the digit that is "fibonaccically unlikely" to appear next by using:
 *      1) phi-decayed (Fibonacci-derived) frequency model
 *      2) phi-decayed transition model (from last digit)
 *      3) Fibonacci-lag resonance penalty (digits appearing at Fibonacci lags treated as more "in play")
 *    Then it chooses the digit with MIN combined probability and trades DIGITDIFF on it.
 */

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'fibo-trader2-state.json');
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
                    requiredHistoryLength: bot.config.requiredHistoryLength,
                    minWaitTime: bot.config.minWaitTime,
                    maxWaitTime: bot.config.maxWaitTime,

                    // Fibonacci model config
                    fibWindow: bot.config.fibWindow,
                    fibMaxLag: bot.config.fibMaxLag,
                    fibAlpha: bot.config.fibAlpha,
                    fibBeta: bot.config.fibBeta,
                    fibConfidenceThreshold: bot.config.fibConfidenceThreshold,
                    transitionLookback: bot.config.transitionLookback,
                    skipExtremeVolatility: bot.config.skipExtremeVolatility,
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
                    volatilityLevel: bot.volatilityLevel,
                    nextTradeAllowedAt: bot.nextTradeAllowedAt || 0,
                },
                subscriptions: {
                    tickSubscriptionIds: { ...bot.tickSubscriptionIds },
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
            'R_100'
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

            // ---------------------------
            // Fibonacci digit model config
            // ---------------------------
            fibWindow: config.fibWindow || 233,
            fibMaxLag: config.fibMaxLag || 233,
            fibAlpha: (config.fibAlpha ?? 0.60), // blend: transition vs frequency
            fibBeta: (config.fibBeta ?? 0.70),   // resonance penalty strength
            fibConfidenceThreshold: (config.fibConfidenceThreshold ?? 0.015),
            transitionLookback: config.transitionLookback || 377,
            skipExtremeVolatility: (config.skipExtremeVolatility ?? true),
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

        // trade cooldown
        this.nextTradeAllowedAt = 0;

        // Reconnection logic
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 5000;
        this.reconnectTimer = null;
        this.isReconnecting = false;

        // Heartbeat/Ping mechanism
        this.pingInterval = null;
        this.checkDataInterval = null;
        this.pongTimeout = null;
        this.lastPongTime = Date.now();
        this.lastDataTime = Date.now();
        this.pingIntervalMs = 20000;
        this.pongTimeoutMs = 10000;
        this.dataTimeoutMs = 60000;

        // Message queue for failed sends
        this.messageQueue = [];
        this.maxQueueSize = 50;

        // Active subscriptions tracking
        this.activeSubscriptions = new Set();
        this.contractSubscription = null;

        // Telegram Configuration (from env)
        this.telegramToken = '8418934966:AAFG-S3wUPV6Cdr8pQF133Ew5SfGpkfoDoU';
        this.telegramChatId = '752497117';
        this.telegramEnabled = true;

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
            this.startTelegramTimer();
        } else {
            console.log('📱 Telegram notifications disabled (missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).');
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
            const trading = savedState.trading || {};
            this.currentStake = trading.currentStake ?? this.currentStake;
            this.consecutiveLosses = trading.consecutiveLosses ?? this.consecutiveLosses;
            this.totalTrades = trading.totalTrades ?? this.totalTrades;
            this.totalWins = trading.totalWins ?? this.totalWins;
            this.totalLosses = trading.totalLosses ?? this.totalLosses;
            this.x2Losses = trading.x2Losses ?? this.x2Losses;
            this.x3Losses = trading.x3Losses ?? this.x3Losses;
            this.x4Losses = trading.x4Losses ?? this.x4Losses;
            this.x5Losses = trading.x5Losses ?? this.x5Losses;
            this.totalProfitLoss = trading.totalProfitLoss ?? this.totalProfitLoss;
            this.lastPrediction = trading.lastPrediction ?? this.lastPrediction;
            this.actualDigit = trading.actualDigit ?? this.actualDigit;
            this.volatilityLevel = trading.volatilityLevel ?? this.volatilityLevel;
            this.nextTradeAllowedAt = trading.nextTradeAllowedAt ?? this.nextTradeAllowedAt;

            // Restore config (optional; only restore what exists)
            const cfg = savedState.config || {};
            Object.assign(this.config, cfg);

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
            this.isReconnecting = false;
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

        // Ping to keep connection alive
        this.pingInterval = setInterval(() => {
            if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();

                this.pongTimeout = setTimeout(() => {
                    const timeSinceLastPong = Date.now() - this.lastPongTime;
                    if (timeSinceLastPong > this.pongTimeoutMs) {
                        console.warn('⚠️ No pong received, connection may be dead');
                    }
                }, this.pongTimeoutMs);
            }
        }, this.pingIntervalMs);

        // Check for data silence
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

            this.processMessageQueue();
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
            if (message.error.code === 'AuthorizationRequired' ||
                message.error.code === 'InvalidToken') {
                console.log('Auth error detected, triggering reconnection...');
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
            ⏰ <b>Fibo2 Differ Bot Hourly Summary</b>

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
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset)) {
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

    // ============================================
    // Fibonacci-based "Unlikely Next Digit" Model
    // ============================================

    getFibonacciLags(maxLag) {
        const lags = [];
        let a = 1, b = 2;
        if (maxLag >= 1) lags.push(1);
        if (maxLag >= 2) lags.push(2);
        while (true) {
            const c = a + b;
            if (c > maxLag) break;
            lags.push(c);
            a = b;
            b = c;
        }
        return lags;
    }

    randomWaitMs() {
        const min = this.config.minWaitTime;
        const max = this.config.maxWaitTime;
        if (max <= min) return min;
        return Math.floor(min + Math.random() * (max - min));
    }

    normalize(arr) {
        const sum = arr.reduce((a, b) => a + b, 0);
        if (sum <= 0) return Array(arr.length).fill(1 / arr.length);
        return arr.map(v => v / sum);
    }

    predictFibonacciUnlikelyDigit(history) {
        const n = history.length;
        if (n < 50) {
            const last = history.slice(-Math.min(50, n));
            const counts = Array(10).fill(0);
            last.forEach(d => counts[d]++);
            let minD = 0;
            for (let d = 1; d < 10; d++) if (counts[d] < counts[minD]) minD = d;
            return { digit: minD, prob: 0.1, confidence: 0, probs: Array(10).fill(0.1) };
        }

        const PHI = (1 + Math.sqrt(5)) / 2;
        const eps = 1e-6;

        const window = Math.min(this.config.fibWindow, n);
        const maxLag = Math.min(this.config.fibMaxLag, n - 1);
        const lookback = Math.min(this.config.transitionLookback, n - 2);

        // 1) phi-decayed frequency model
        const freq = Array(10).fill(eps);
        let freqSum = 10 * eps;
        for (let offset = 1; offset <= window; offset++) {
            const d = history[n - offset];
            const w = Math.pow(1 / PHI, offset);
            freq[d] += w;
            freqSum += w;
        }
        const freqProb = freq.map(v => v / freqSum);

        // 2) transition model from last digit (phi-decayed)
        const prev = history[n - 1];
        const trans = Array(10).fill(eps);
        let transSum = 10 * eps;

        for (let offset = 1; offset <= lookback; offset++) {
            const idx = (n - 2) - offset;
            if (idx < 0) break;
            if (history[idx] !== prev) continue;

            const next = history[idx + 1];
            const w = Math.pow(1 / PHI, offset);
            trans[next] += w;
            transSum += w;
        }
        const transProb = trans.map(v => v / transSum);

        // 3) Fibonacci-lag resonance penalty
        const lags = this.getFibonacciLags(maxLag).filter(l => l >= 2);
        const resonance = Array(10).fill(0);

        for (const lag of lags) {
            const d = history[n - lag];
            resonance[d] += 1 / Math.sqrt(lag);
        }
        const resMax = Math.max(...resonance, 1e-12);
        const resNorm = resonance.map(r => r / resMax); // 0..1

        // 4) Combine
        const alpha = this.config.fibAlpha;
        const beta = this.config.fibBeta;

        let combined = Array(10).fill(0).map((_, d) => {
            let p = alpha * transProb[d] + (1 - alpha) * freqProb[d];
            p *= (1 + beta * resNorm[d]); // higher resonance => higher p => less "unlikely"
            return p;
        });

        combined = this.normalize(combined);

        // Choose minimum probability digit
        let minDigit = 0;
        let minProb = combined[0];
        for (let d = 1; d < 10; d++) {
            if (combined[d] < minProb) {
                minProb = combined[d];
                minDigit = d;
            }
        }

        const confidence = Math.max(0, 0.1 - minProb);
        return { digit: minDigit, prob: minProb, confidence, probs: combined };
    }

    // ============================================
    // Analysis & Trade Trigger (MODIFIED)
    // ============================================
    analyzeTicks(asset) {
        if (this.tradeInProgress || this.suspendedAssets.has(asset) || !this.wsReady) return;
        if (Date.now() < (this.nextTradeAllowedAt || 0)) return;

        const history = this.tickHistories[asset];
        if (history.length < 200) return;

        this.volatilityLevel = this.getVolatilityLevel(history);
        console.log(`[${asset}] Volatility level: ${this.volatilityLevel}`);
        if (this.config.skipExtremeVolatility && this.volatilityLevel === 'extreme') return;

        const pred = this.predictFibonacciUnlikelyDigit(history);
        console.log(`[${asset}] Prediction: ${pred.digit} | Confidence: ${pred.confidence} | Probability: ${pred.prob}`);

        this.lastPrediction = pred.digit;

        // Only trade if the digit is meaningfully below uniform probability
        if (pred.confidence < this.config.fibConfidenceThreshold || pred.prob < 0.045) return;

        this.placeTrade(asset, pred.digit);
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

        console.log(`Placing Trade: [${asset}] DIGITDIFF barrier=${predictedDigit} | Stake: $${this.currentStake.toFixed(2)}`);

        const message = `
            🔔 <b>Trade Opened (Fibo2 Differ Bot)</b>

            📊 <b>${asset}</b>
            🧬 <b>Fibonacci Unlikely Digit:</b> ${predictedDigit}
            💰 <b>Stake:</b> $${this.currentStake.toFixed(2)}
            Last10Digits = ${this.tickHistories[asset].slice(-10).join(',')}

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

            if (this.consecutiveLosses === 2) {
                this.currentStake = this.config.initialStake;
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
${resultEmoji} (Fibo2 Differ Bot)

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

        // Stop conditions
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

        // Cooldown before allowing the next trade
        this.nextTradeAllowedAt = Date.now() + this.randomWaitMs();
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
            const currentDay = gmtPlus1Time.getUTCDay();
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Weekend logic
            const isWeekend = (currentDay === 0) ||
                (currentDay === 6 && currentHours >= 23) ||
                (currentDay === 1 && currentHours < 2);

            if (isWeekend) {
                if (!this.endOfDay) {
                    console.log("Weekend trading suspension (Saturday 11pm - Monday 2am). Disconnecting...");
                    this.sendHourlySummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
                return;
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

        if (this.isReconnecting) {
            console.log('Already handling disconnect, skipping...');
            return;
        }

        this.connected = false;
        this.wsReady = false;
        this.stopMonitor();

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

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(() => {
            console.log('🔄 Attempting reconnection...');
            this.isReconnecting = false;
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

        if (this.endOfDay) {
            this.activeSubscriptions.clear();
        }

        this.connected = false;
        this.wsReady = false;
    }

    disconnect() {
        console.log('🛑 Disconnecting bot...');
        StatePersistence.saveState(this);
        this.endOfDay = true;
        this.cleanup();
        console.log('✅ Bot disconnected successfully');
    }

    start() {
        console.log('🚀 Starting Fibo2 Differ Bot...');
        console.log(`📊 Session Summary:`);
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins/Losses: ${this.totalWins}/${this.totalLosses}`);
        console.log(`   Total P&L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`   Current Stake: $${this.currentStake.toFixed(2)}`);

        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// ============================
// Initialize and start bot
// ============================

const DERIV_TOKEN = '0P94g4WdSrSrzir';
if (!DERIV_TOKEN) {
    console.error('Missing DERIV_TOKEN in environment. Put it in your .env file.');
    process.exit(1);
}

const bot = new AIWeightedEnsembleBot(DERIV_TOKEN, {
    initialStake: 2.2,
    multiplier: 11.3,
    maxConsecutiveLosses: 4,
    stopLoss: 55,
    takeProfit: 5000,
    requiredHistoryLength: 1000,
    minWaitTime: 1000,
    maxWaitTime: 3000,

    // Fibonacci model settings (tune as needed)
    fibWindow: 233,
    fibMaxLag: 233,
    fibAlpha: 0.60,
    fibBeta: 0.70,
    fibConfidenceThreshold: 0.015,
    transitionLookback: 377,
    skipExtremeVolatility: true,
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
