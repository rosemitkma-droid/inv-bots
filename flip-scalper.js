const WebSocket = require('ws');
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// ================= CONFIGURATION =================
const CONFIG = {
    app_id: 1089, // Replace with your App ID if you have one, or keep 1089 (Deriv generic)
    token: 'hsj0tA0XJoIzJG5', // REPLACE THIS with your actual API Token

    // MULTI-ASSET CONFIGURATION
    symbols: [
        { name: '1HZ10V', label: 'Volatility 10 (1s)', multiplier: 1000, enabled: true },
        { name: '1HZ25V', label: 'Volatility 25 (1s)', multiplier: 400, enabled: true },
        { name: '1HZ50V', label: 'Volatility 50 (1s)', multiplier: 200, enabled: true },
        { name: '1HZ75V', label: 'Volatility 75 (1s)', multiplier: 100, enabled: true },
        { name: '1HZ100V', label: 'Volatility 100 (1s)', multiplier: 60, enabled: true }
    ],

    // SESSIONS CONFIGURATION
    sessions: {
        london: { name: 'London', time: '07:00', enabled: true },
        new_york: { name: 'New York', time: '13:00', enabled: true }
    },

    market_open_duration: 90, // Minutes to look for trade after open (Strategy: 90 mins)
    candle_timeframe: 15, // Opening Range Candle (Minutes)
    entry_timeframe: 5,   // Reversal Pattern Timeframe (Minutes)
    reconnect_delay: 5000, // Milliseconds before reconnection attempt
    ping_interval: 25000, // Keep-alive ping every 25 seconds

    // Investment Management
    INVESTMENT_CAPITAL: process.env.INITIAL_CAPITAL ? parseFloat(process.env.INITIAL_CAPITAL) : 500,
    RISK_PERCENT: 1, // 1% risk per trade (Stop Loss)
    RR_RATIO: 3,     // 1:3 Risk-Reward (Take Profit)
};
// =================================================

class QuickFlipBot {
    constructor() {
        this.ws = null;
        this.assets = new Map(); // Stores state for each symbol
        this.dailyATR = {}; // ATR values per symbol

        // Telegram Configuration
        this.telegramToken = process.env.TELEGRAM_BOT_TOKEN4;
        this.telegramChatId = process.env.TELEGRAM_CHAT_ID;
        this.telegramEnabled = !!(this.telegramToken && this.telegramChatId);

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
            this.startTelegramTimer();
        } else {
            this.log('📱 Telegram notifications disabled (missing API keys).', 'SYSTEM');
        }

        this.sessionStartTime = new Date();
        this.tradeLog = [];
        this.pingTimer = null;
        this.isConnected = false;

        this.initializeAssets();
    }

    initializeAssets() {
        CONFIG.symbols.forEach(s => {
            if (s.enabled) {
                this.assets.set(s.name, {
                    symbol: s.name,
                    label: s.label,
                    multiplier: s.multiplier,
                    state: 'WAITING_FOR_OPEN',
                    openTimeEpoch: null,
                    session: null, // 'london' or 'new_york'
                    box: { high: null, low: null, direction: null, valid: false },
                    lastCandle: null,
                    entryCandle: null,
                    currentContractId: null,
                    lastTimeLog: 0,
                    lastWarningLog: 0,
                    lastSessionTraded: null // Tracks 'YYYY-MM-DD:sessionKey'
                });
            }
        });
    }

    start() {
        this.connect();
    }

    connect() {
        this.log('='.repeat(60), 'SYSTEM');
        this.log('🚀 Starting MULTI-ASSET Quick Flip Scalper Bot', 'SYSTEM');
        this.log(`📊 Active Symbols: ${Array.from(this.assets.keys()).join(', ')}`, 'SYSTEM');
        this.log(`💰 Capital: $${CONFIG.INVESTMENT_CAPITAL} | Risk: ${CONFIG.RISK_PERCENT}% per trade`, 'SYSTEM');
        this.log(`⏰ Sessions: ${Object.values(CONFIG.sessions).filter(s => s.enabled).map(s => `${s.name} (${s.time})`).join(', ')}`, 'SYSTEM');
        this.log('='.repeat(60), 'SYSTEM');

        this.ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${CONFIG.app_id}`);

        this.ws.on('open', () => {
            this.isConnected = true;
            this.log('✅ Connected to Deriv API', 'CONNECTION');
            this.authorize();
            this.startPingInterval();
        });

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                this.handleMessage(msg);
            } catch (err) {
                this.log(`❌ Error parsing message: ${err.message}`, 'ERROR');
            }
        });

        this.ws.on('error', (err) => {
            this.log(`❌ WebSocket Error: ${err.message}`, 'ERROR');
        });

        this.ws.on('close', () => {
            this.isConnected = false;
            this.log('⚠️  Connection closed. Attempting reconnection...', 'CONNECTION');
            this.cleanup();
            setTimeout(() => this.connect(), CONFIG.reconnect_delay);
        });
    }

    startPingInterval() {
        this.pingTimer = setInterval(() => {
            if (this.isConnected) {
                this.ws.send(JSON.stringify({ ping: 1 }));
                // this.log('📡 Keep-alive ping sent', 'SYSTEM');
            }
        }, CONFIG.ping_interval);
    }

    cleanup() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    log(message, category = 'INFO', symbol = '', isBoxed = false) {
        const timestamp = new Date().toISOString();
        const symbolTag = symbol ? `[${symbol}] ` : '';
        const categoryColors = {
            'SYSTEM': '\x1b[36m',    // Cyan
            'CONNECTION': '\x1b[32m', // Green
            'STRATEGY': '\x1b[33m',   // Yellow
            'TRADE': '\x1b[35m',      // Magenta
            'ERROR': '\x1b[31m',      // Red
            'SUCCESS': '\x1b[32m',    // Green
            'INFO': '\x1b[37m'        // White
        };
        const reset = '\x1b[0m';
        const color = categoryColors[category] || categoryColors['INFO'];

        if (isBoxed) {
            console.log(`${color}┏${'━'.repeat(60)}┓${reset}`);
            const lines = message.split('\n');
            lines.forEach(line => {
                console.log(`${color}┃ ${line.padEnd(58)} ┃${reset}`);
            });
            console.log(`${color}┗${'━'.repeat(60)}┛${reset}`);
        } else {
            console.log(`${color}[${timestamp}] [${category}] ${symbolTag}${message}${reset}`);
        }
    }

    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;
        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
            this.log('📱 Telegram notification sent', 'SYSTEM');
        } catch (error) {
            this.log(`❌ Failed to send Telegram message: ${error.message}`, 'ERROR');
        }
    }

    getTelegramSummary() {
        let totalProfit = 0;
        let wins = 0;
        let losses = 0;
        const assetStats = {};

        this.tradeLog.forEach(trade => {
            if (trade.profit !== undefined) {
                totalProfit += trade.profit;
                if (trade.result === 'WIN') wins++;
                else losses++;

                if (!assetStats[trade.symbol]) assetStats[trade.symbol] = { pnl: 0, count: 0 };
                assetStats[trade.symbol].pnl += trade.profit;
                assetStats[trade.symbol].count++;
            }
        });

        const winRate = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(1) : 0;

        let assetBreakdown = '';
        Object.keys(assetStats).forEach(sym => {
            assetBreakdown += `\n• <b>${sym}:</b> $${assetStats[sym].pnl.toFixed(2)} (${assetStats[sym].count} trades)`;
        });

        return `
📊 <b>Flip Scalper Session Summary</b>
========================
<b>Total Trades:</b> ${wins + losses}
✅ <b>Wins:</b> ${wins} | ❌ <b>Losses:</b> ${losses}
🔥 <b>Win Rate:</b> ${winRate}%
💰 <b>Total P/L:</b> $${totalProfit.toFixed(2)}
${assetBreakdown ? `\n<b>Asset Breakdown:</b>${assetBreakdown}` : ''}`;
    }

    startTelegramTimer() {
        // Send summary every 30 minutes
        setInterval(() => {
            if (this.tradeLog.length > 0) {
                this.sendTelegramMessage(`📊 <b>Periodic Performance Summary</b>\n${this.getTelegramSummary()}`);
            }
        }, 30 * 60 * 1000);
    }

    authorize() {
        this.log('🔐 Authorizing with API Token...', 'SYSTEM');
        this.ws.send(JSON.stringify({ authorize: CONFIG.token }));
    }

    handleMessage(msg) {
        // Handle pong
        if (msg.msg_type === 'ping') {
            // this.log('📡 Pong received', 'SYSTEM');
            return;
        }

        if (msg.error) {
            this.log(`❌ API Error: ${msg.error.message} (Code: ${msg.error.code})`, 'ERROR');
            if (msg.error.code === 'InvalidToken') {
                this.log('🛑 Invalid API Token. Please update CONFIG.token', 'ERROR');
                process.exit(1);
            }
            return;
        }

        if (msg.msg_type === 'authorize') {
            this.log(`✅ Authorized as: ${msg.authorize.email}`, 'SUCCESS');
            this.log(`💵 Balance: ${msg.authorize.balance} ${msg.authorize.currency}`, 'INFO');

            // Log Investment Capital info
            const baseCapital = CONFIG.INVESTMENT_CAPITAL;
            const dailyLossLimit = baseCapital * 0.5;

            this.log(`🏢 Investment Capital: $${baseCapital.toFixed(2)}`, 'INFO');
            this.log(`🚨 Daily Loss Limit: $${dailyLossLimit.toFixed(2)} (50%)`, 'INFO');

            this.log('-'.repeat(60), 'SYSTEM');
            this.log('📈 Strategy: Quick Flip Scalper (Multi-Asset)', 'STRATEGY');
            this.startClock();
        }

        if (msg.msg_type === 'history' || msg.msg_type === 'candles') {
            const sym = msg.echo_req.ticks_history;
            if (msg.req_id === 1) { // daily_atr
                this.calculateATR(sym, msg.history || [], msg.candles || []);
            } else if (msg.req_id === 2) { // opening_candle
                this.analyzeOpeningCandle(sym, msg.candles || []);
            }
        }

        if (msg.msg_type === 'tick') {
            this.checkTime();
        }

        if (msg.msg_type === 'ohlc') {
            this.checkForReversal(msg.ohlc.symbol, msg.ohlc);
        }

        if (msg.msg_type === 'candles' && !msg.echo_req.req_id) {
            const sym = msg.echo_req.ticks_history;
            const asset = this.assets.get(sym);
            if (asset && msg.candles && msg.candles.length > 0) {
                asset.lastCandle = msg.candles[msg.candles.length - 1];
            }
        }

        if (msg.msg_type === 'buy') {
            this.handleBuyResponse(msg);
        }

        if (msg.msg_type === 'proposal_open_contract') {
            this.handleTradeUpdate(msg.proposal_open_contract);
        }

        if (msg.msg_type === 'sell') {
            this.handleSellResponse(msg);
        }
    }

    startClock() {
        this.log('🔄 Starting multi-asset market monitoring...', 'SYSTEM');

        for (const [symbol, asset] of this.assets) {
            this.ws.send(JSON.stringify({ ticks: symbol }));
            this.getDailyHistory(symbol);
        }

        this.checkTime(); // Immediate initial check
    }

    checkTime() {
        const now = new Date();
        const nowString = now.toISOString().substring(11, 16); // Extract HH:MM

        for (const [symbol, asset] of this.assets) {
            // Determine active/future sessions for this asset
            const sessions = Object.keys(CONFIG.sessions).filter(k => CONFIG.sessions[k].enabled);

            for (const sessionKey of sessions) {
                const session = CONFIG.sessions[sessionKey];

                // Calculate session open epoch
                const [h, m] = session.time.split(':').map(Number);
                const openTime = new Date(now);
                openTime.setUTCHours(h, m, 0, 0);
                const openEpoch = Math.floor(openTime.getTime() / 1000);

                const minsSinceOpen = (Date.now() / 1000 - openEpoch) / 60;
                const sessionTag = `${now.toISOString().split('T')[0]}:${sessionKey}`;

                // 1. Detect Session Open (or Catch-up)
                if (asset.state === 'WAITING_FOR_OPEN' && asset.lastSessionTraded !== sessionTag) {
                    // Start of window trigger
                    if (nowString === session.time || (minsSinceOpen >= 0 && minsSinceOpen < CONFIG.market_open_duration)) {
                        asset.session = sessionKey;
                        asset.openTimeEpoch = openEpoch;

                        this.log('='.repeat(60), 'STRATEGY', symbol);
                        if (nowString === session.time) {
                            this.log(`🔔 ${session.name.toUpperCase()} SESSION OPEN DETECTED!`, 'STRATEGY', symbol);
                        } else {
                            this.log(`⚡ CATCH-UP: ${session.name} session active (${minsSinceOpen.toFixed(1)}m passed)`, 'STRATEGY', symbol);
                        }

                        if (minsSinceOpen < CONFIG.candle_timeframe) {
                            this.log(`⏱️ Waiting for opening candle... (${(CONFIG.candle_timeframe - minsSinceOpen).toFixed(1)}m left)`, 'STRATEGY', symbol);
                            asset.state = 'WAITING_CANDLE_CLOSE';

                            this.sendTelegramMessage(`🔔 <b>${session.name} Session Open</b> [${symbol}]\nWaiting for 15-min opening candle...`);
                        } else {
                            this.log(`✅ Opening candle closed. Analyzing liquidity...`, 'STRATEGY', symbol);
                            asset.state = 'CALCULATING_LIQUIDITY';
                            this.getOpeningCandle(symbol);
                        }
                        this.log('='.repeat(60), 'STRATEGY', symbol);
                        break; // Move to next symbol
                    }
                }
            }

            // 2. Wait for candle close
            if (asset.state === 'WAITING_CANDLE_CLOSE') {
                const minsSinceOpen = (Date.now() / 1000 - asset.openTimeEpoch) / 60;
                if (minsSinceOpen >= CONFIG.candle_timeframe) {
                    this.log('✅ Opening candle closed. Fetching data...', 'STRATEGY', symbol);
                    this.getOpeningCandle(symbol);
                    asset.state = 'CALCULATING_LIQUIDITY';
                }
            }

            // 3. Window Expiration / Timeout check
            if (asset.state === 'HUNTING' || asset.state === 'CALCULATING_LIQUIDITY' || asset.state === 'WAITING_CANDLE_CLOSE') {
                const minsSinceOpen = (Date.now() / 1000 - asset.openTimeEpoch) / 60;
                if (minsSinceOpen > CONFIG.market_open_duration) {
                    this.log('='.repeat(60), 'STRATEGY', symbol);
                    this.log(`⏰ ${CONFIG.market_open_duration} Minutes passed. Window expired.`, 'STRATEGY', symbol);
                    this.log('='.repeat(60), 'STRATEGY', symbol);

                    if (asset.state === 'HUNTING') {
                        this.ws.send(JSON.stringify({ forget_all: 'candles' }));
                    }

                    asset.state = 'WAITING_FOR_OPEN';
                    this.resetSetup(symbol);
                }
            }

            // Log periodic heartbeat
            const currentMinute = nowString.substring(14, 16);
            if (['00', '15', '30', '45'].includes(currentMinute)) {
                if (Date.now() - asset.lastTimeLog > 60000) { // Every minute during heartbeat check
                    const atrStatus = this.dailyATR[symbol] ? '✅' : '❌';
                    this.log(`💓 Heartbeat | State: ${asset.state} | ATR: ${atrStatus}`, 'INFO', symbol);
                    asset.lastTimeLog = Date.now();
                }
            }
        }
    }

    getDailyHistory(symbol) {
        this.log('📊 Fetching daily candle history for ATR calculation...', 'STRATEGY', symbol);
        this.ws.send(JSON.stringify({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: 15,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: 86400, // 1 Day
            req_id: 1
        }));
    }

    calculateATR(symbol, history, candles) {
        if (!candles || candles.length < 2) {
            this.log('⚠️ Insufficient daily history for ATR calculation.', 'WARNING', symbol);
            return;
        }

        this.log('-'.repeat(60), 'STRATEGY', symbol);
        this.log('📈 AVERAGE TRUE RANGE (ATR) REPORT', 'STRATEGY', symbol);

        // Log the last few daily candles for transparency
        const recentCandles = candles.slice(-3).map(c =>
            `Day ${new Date(c.epoch * 1000).toISOString().split('T')[0]}: H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`
        ).join('\n');
        this.log(`Recent Price History:\n${recentCandles}`, 'INFO', symbol);

        let trSum = 0;
        let validIntervals = 0;
        for (let i = 1; i < candles.length; i++) {
            const current = candles[i];
            const prev = candles[i - 1];
            const hl = current.high - current.low;
            const hc = Math.abs(current.high - prev.close);
            const lc = Math.abs(current.low - prev.close);
            const tr = Math.max(hl, hc, lc);
            trSum += tr;
            validIntervals++;
        }

        this.dailyATR[symbol] = trSum / validIntervals;
        const threshold = this.dailyATR[symbol] * 0.11;

        const atrOutput =
            `✅ Daily ATR Result: ${this.dailyATR[symbol].toFixed(4)}\n` +
            `• Lookback: ${validIntervals} days\n` +
            `• Required Box Range (11%): ≥ ${threshold.toFixed(4)}`;

        this.log(atrOutput, 'SUCCESS', symbol, true);
    }

    getOpeningCandle(symbol) {
        const asset = this.assets.get(symbol);
        const startTime = asset.openTimeEpoch;
        const endTime = startTime + (CONFIG.candle_timeframe * 60);

        this.log(`🔍 Requesting candle [${new Date(startTime * 1000).toISOString()} to ${new Date(endTime * 1000).toISOString()}]`, 'STRATEGY', symbol);

        this.ws.send(JSON.stringify({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: 1,
            start: startTime,
            end: endTime,
            style: 'candles',
            granularity: CONFIG.candle_timeframe * 60,
            req_id: 2
        }));
    }

    analyzeOpeningCandle(symbol, candles) {
        const asset = this.assets.get(symbol);
        if (!candles || candles.length === 0) {
            this.log('❌ Opening candle data missing from API response', 'ERROR', symbol);
            return;
        }

        const candle = candles[0]; // We requested count: 1
        const candleTime = new Date(candle.epoch * 1000).toISOString();
        const range = candle.high - candle.low;
        const isGreen = candle.close > candle.open;
        const candleColor = isGreen ? '🟢 GREEN' : '🔴 RED';
        const atr = this.dailyATR[symbol] || 0;
        const liquidityThreshold = 0.11 * atr;
        const rangePercent = ((range / (atr || 1)) * 100).toFixed(2);

        const analysisOutput =
            `📊 OPENING CANDLE ANALYSIS: ${symbol}\n` +
            `• Start Time: ${candleTime}\n` +
            `• Open:  ${candle.open.toFixed(4)} | Close: ${candle.close.toFixed(4)}\n` +
            `• High:  ${candle.high.toFixed(4)} | Low:   ${candle.low.toFixed(4)}\n` +
            `• Range: ${range.toFixed(4)} (${rangePercent}% of ATR)\n` +
            `• Target: ≥ ${liquidityThreshold.toFixed(4)}`;

        this.log(analysisOutput, 'STRATEGY', symbol, true);

        if (range >= liquidityThreshold) {
            this.log('✅ LIQUIDITY CONFIRMED!', 'SUCCESS', symbol);
            asset.box = { high: candle.high, low: candle.low, direction: isGreen ? 'UP' : 'DOWN', valid: true };

            const bias = asset.box.direction === 'UP' ? 'SELL' : 'BUY';
            const targetSide = asset.box.direction === 'UP' ? 'High' : 'Low';
            const level = asset.box.direction === 'UP' ? asset.box.high : asset.box.low;

            const setupInfo =
                `🎯 TRADING SETUP IDENTIFIED\n` +
                `• Bias: ${bias} reversal\n` +
                `• Liquidity Box: ${asset.box.low.toFixed(4)} - ${asset.box.high.toFixed(4)}\n` +
                `• Trigger Level: Reversal at ${targetSide} (${level.toFixed(4)})`;

            this.log(setupInfo, 'STRATEGY', symbol, true);
            this.sendTelegramMessage(
                `✅ <b>Liquidity Confirmed!</b> [${symbol}]\n` +
                `<b>Session:</b> ${CONFIG.sessions[asset.session].name}\n` +
                `<b>Bias:</b> ${bias}\n` +
                `<b>Level:</b> ${level.toFixed(4)}\n` +
                `<b>Range:</b> ${rangePercent}% of ATR`
            );

            this.startHunting(symbol);
        } else {
            this.log(`❌ LIQUIDITY FAILED (${rangePercent}% of ATR is below 11%)`, 'ERROR', symbol);
            this.sendTelegramMessage(`❌ <b>Liquidity Failed</b> [${symbol}]\nRange ${rangePercent}% of ATR is too low.`);

            // Mark session as "traded/handled" even if failed liquidity, or wait? 
            // Usually if liquidity fails, we don't trade that session.
            const sessionTag = `${new Date().toISOString().split('T')[0]}:${asset.session}`;
            asset.lastSessionTraded = sessionTag;

            asset.state = 'WAITING_FOR_OPEN';
            this.resetSetup(symbol);
        }
    }

    startHunting(symbol) {
        const asset = this.assets.get(symbol);
        asset.state = 'HUNTING';
        this.log('🎯 HUNTING MODE ACTIVATED', 'STRATEGY', symbol);

        this.ws.send(JSON.stringify({
            ticks_history: symbol,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: CONFIG.entry_timeframe * 60,
            subscribe: 1
        }));
    }

    checkForReversal(symbol, candle) {
        const asset = this.assets.get(symbol);
        if (!asset || asset.state !== 'HUNTING') return;

        if (asset.lastCandle && asset.lastCandle.epoch === candle.epoch) return;
        asset.lastCandle = candle;

        const body = Math.abs(candle.close - candle.open);
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;

        // Long (Hammer) below box
        if (asset.box.direction === 'DOWN' && candle.close < asset.box.low) {
            if (lowerWick >= (2 * body) && upperWick < body && body > 0) {
                this.log('🔥 HAMMER DETECTED!', 'SUCCESS', symbol);
                this.sendTelegramMessage(`🔥 <b>Hammer Pattern</b> [${symbol}]\nExecuting LONG.`);
                asset.entryCandle = candle;
                this.executeTrade(symbol, 'MULTUP');
            }
        }

        // Short (Shooting Star) above box
        if (asset.box.direction === 'UP' && candle.close > asset.box.high) {
            if (upperWick >= (2 * body) && lowerWick < body && body > 0) {
                this.log('🔥 SHOOTING STAR DETECTED!', 'SUCCESS', symbol);
                this.sendTelegramMessage(`🔥 <b>Shooting Star</b> [${symbol}]\nExecuting SHORT.`);
                asset.entryCandle = candle;
                this.executeTrade(symbol, 'MULTDOWN');
            }
        }
    }

    executeTrade(symbol, contractType) {
        const asset = this.assets.get(symbol);
        asset.state = 'EXECUTING';

        // Calculation: 1% risk = SL. 3% TP = RR 1:3.
        const stake = (CONFIG.INVESTMENT_CAPITAL * (CONFIG.RISK_PERCENT / 100)).toFixed(2);
        const stopLossAmount = Math.max(0, stake); // 100% of stake = SL
        const takeProfitAmount = (stake * CONFIG.RR_RATIO).toFixed(2); // 300% of stake = TP

        const direction = contractType === 'MULTUP' ? '🔼 LONG' : '🔻 SHORT';

        const tradeInfo =
            `🚀 EXECUTING TRADE: ${symbol}\n` +
            `• Direction: ${direction}\n` +
            `• Stake:     $${stake} (Risk: ${CONFIG.RISK_PERCENT}%)\n` +
            `• Multiplier: x${asset.multiplier}\n` +
            `• SL Amount: -$${stake} (Fixed 100% of Stake)\n` +
            `• TP Amount: +$${takeProfitAmount} (Target RR 1:3)`;

        this.log(tradeInfo, 'TRADE', symbol, true);

        this.ws.send(JSON.stringify({ forget_all: 'candles' }));
        this.sendTelegramMessage(
            `🚀 <b>Scaling Trade Execution</b> [${symbol}]\n` +
            `<b>Session:</b> ${CONFIG.sessions[asset.session].name}\n` +
            `<b>Side:</b> ${direction}\n\n` +
            `💰 <b>Stake:</b> $${stake}\n` +
            `⚙️ <b>Mult:</b> x${asset.multiplier}\n` +
            `🛑 <b>SL:</b> $${stake}\n` +
            `🎯 <b>TP:</b> $${takeProfitAmount}`
        );

        this.ws.send(JSON.stringify({
            buy: 1,
            price: stake,
            parameters: {
                contract_type: contractType,
                symbol: symbol,
                currency: 'USD',
                multiplier: asset.multiplier,
                limit_order: {
                    take_profit: parseFloat(takeProfitAmount),
                    stop_loss: parseFloat(stopLossAmount)
                }
            },
            passthrough: { symbol: symbol }
        }));
    }

    handleBuyResponse(msg) {
        if (msg.buy) {
            const sym = msg.echo_req.passthrough.symbol;
            const asset = this.assets.get(sym);

            this.log('✅ TRADE EXECUTED SUCCESSFULLY!', 'SUCCESS', sym);
            asset.currentContractId = msg.buy.contract_id;
            asset.state = 'IN_TRADE';

            this.tradeLog.push({
                symbol: sym,
                contractId: msg.buy.contract_id,
                entryTime: new Date().toISOString(),
                direction: msg.buy.contract_type,
                stake: msg.buy.buy_price
            });

            this.monitorTrade(sym);
        }
    }

    monitorTrade(symbol) {
        const asset = this.assets.get(symbol);
        this.log('📊 Starting trade monitoring...', 'TRADE', symbol);

        if (asset.currentContractId) {
            this.ws.send(JSON.stringify({
                proposal_open_contract: 1,
                contract_id: asset.currentContractId,
                subscribe: 1
            }));
        }
    }

    handleTradeUpdate(contract) {
        const asset = Array.from(this.assets.values()).find(a => a.currentContractId === contract.contract_id);
        if (!asset) return;

        if (contract.is_sold) {
            this.handleTradeClosed(contract);
            return;
        }

        const profit = parseFloat(contract.profit || 0);
        const profitPercent = ((profit / contract.buy_price) * 100).toFixed(2);

        // Log update every few mins or significant profit changes
        if (Math.random() < 0.3) {
            this.log(`📈 Monitoring ${asset.symbol}: ${profitPercent}% | $${profit.toFixed(2)}`, 'TRADE', asset.symbol);
        }
    }

    handleTradeClosed(contract) {
        const asset = Array.from(this.assets.values()).find(a => a.currentContractId === contract.contract_id);
        const sym = asset ? asset.symbol : 'UNKNOWN';
        const profit = parseFloat(contract.profit);
        const isWin = profit > 0;

        this.log('='.repeat(60), isWin ? 'SUCCESS' : 'ERROR', sym);
        this.log(`🏁 TRADE CLOSED: ${isWin ? 'WIN 💰' : 'LOSS ❌'}`, isWin ? 'SUCCESS' : 'ERROR', sym);
        this.log(`   Profit/Loss: $${profit.toFixed(2)}`, 'INFO', sym);
        this.log('='.repeat(60), isWin ? 'SUCCESS' : 'ERROR', sym);

        const trade = this.tradeLog.find(t => t.contractId === contract.contract_id);
        if (trade) {
            trade.profit = profit;
            trade.result = isWin ? 'WIN' : 'LOSS';
            trade.exitTime = new Date().toISOString();
        }

        this.sendTelegramMessage(`${isWin ? '💰' : '❌'} <b>Trade Closed</b> [${sym}]\n<b>Result:</b> ${isWin ? 'WIN' : 'LOSS'}\n<b>P/L:</b> $${profit.toFixed(2)}\n${this.getTelegramSummary()}`);

        if (asset) {
            const sessionTag = `${new Date().toISOString().split('T')[0]}:${asset.session}`;
            asset.lastSessionTraded = sessionTag;

            asset.currentContractId = null;
            asset.state = 'WAITING_FOR_OPEN';
            this.resetSetup(sym);
        }
    }

    handleSellResponse(msg) {
        if (msg.sell) {
            this.log('✅ Manual/Auto sell successful', 'SUCCESS');
        }
    }

    printTradeLog() {
        if (this.tradeLog.length === 0) {
            this.log('📭 No trades executed this session.', 'INFO');
            return;
        }

        this.log('='.repeat(60), 'SYSTEM');
        this.log('📊 SESSION TRADE LOG SUMMARY', 'SYSTEM');
        this.log('='.repeat(60), 'SYSTEM');

        let totalProfit = 0;
        let wins = 0;
        let losses = 0;

        this.tradeLog.forEach((trade, index) => {
            const result = trade.result === 'WIN' ? '✅ WIN ' : '❌ LOSS';
            this.log(`${index + 1}. [${trade.symbol}] ${trade.direction}: ${result} | P/L: $${trade.profit.toFixed(2)}`, 'INFO');
            totalProfit += trade.profit;
            if (trade.result === 'WIN') wins++;
            else losses++;
        });

        const winRate = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(1) : 0;

        this.log('-'.repeat(60), 'SYSTEM');
        this.log(`📈 Total Trades: ${wins + losses} | Wins: ${wins} | Losses: ${losses}`, 'SYSTEM');
        this.log(`🔥 Win Rate: ${winRate}% | Total P/L: $${totalProfit.toFixed(2)}`, 'SYSTEM');
        this.log('='.repeat(60), 'SYSTEM');
    }

    resetSetup(symbol) {
        const asset = this.assets.get(symbol);
        this.ws.send(JSON.stringify({ forget_all: 'candles' }));
        if (asset) {
            asset.box = { high: null, low: null, direction: null, valid: false };
            asset.lastCandle = null;
            asset.entryCandle = null;
            asset.openTimeEpoch = null;
            asset.session = null;
            this.log('🔄 Setup reset. Ready for next session.', 'SYSTEM', symbol);
        }
    }
}

// ================= START BOT =================
const bot = new QuickFlipBot();
bot.start();

const initialStake = (CONFIG.INVESTMENT_CAPITAL * (CONFIG.RISK_PERCENT / 100)).toFixed(2);
bot.sendTelegramMessage(`🚀 <b>MULTI-ASSET QUICK FLIP SCALPER STARTED</b>\n<b>Assets:</b> ${CONFIG.symbols.filter(s => s.enabled).map(s => s.name).join(', ')}\n<b>Capital:</b> $${CONFIG.INVESTMENT_CAPITAL.toFixed(2)}\n<b>Target Stake:</b> $${initialStake}`);

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down bot...');
    if (bot.telegramEnabled) {
        await bot.sendTelegramMessage(`⏹ <b>Bot Stopped Manually</b>\n${bot.getTelegramSummary()}`);
    }
    bot.printTradeLog();
    bot.cleanup();
    process.exit(0);
});
