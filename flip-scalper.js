const WebSocket = require('ws');
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// ================= CONFIGURATION =================
const CONFIG = {
    app_id: 1089, // Replace with your App ID if you have one, or keep 1089 (Deriv generic)
    token: 'hsj0tA0XJoIzJG5', // REPLACE THIS with your actual API Token
    symbol: 'R_100', // Volatility 100 Index (Or use 'R_50', 'R_75', etc.)
    market_open_time: '07:00', // Time to start the "Day" (HH:MM in GMT/UTC)
    trade_amount: 10, // Stake amount in USD
    multiplier: 100, // Multiplier value (e.g., 100, 200)
    market_open_duration: 90, // Minutes to look for trade after open (Strategy: 90 mins)
    candle_timeframe: 15, // Opening Range Candle (Minutes)
    entry_timeframe: 5,   // Reversal Pattern Timeframe (Minutes)
    reconnect_delay: 5000, // Milliseconds before reconnection attempt
    ping_interval: 25000, // Keep-alive ping every 25 seconds

    // Investment Management
    INVESTMENT_CAPITAL: process.env.INITIAL_CAPITAL ? parseFloat(process.env.INITIAL_CAPITAL) : 500,
    RISK_PERCENT: 1, // 1% risk per trade
};
// =================================================

class QuickFlipBot {
    constructor() {
        this.ws = null;
        this.dailyATR = 0;
        this.box = { high: null, low: null, direction: null, valid: false };
        this.state = 'WAITING_FOR_OPEN'; // WAITING_FOR_OPEN, WAITING_CANDLE_CLOSE, CALCULATING_LIQUIDITY, HUNTING, EXECUTING, IN_TRADE
        this.openTimeEpoch = null;
        this.currentContractId = null;
        this.lastCandle = null;
        this.pingTimer = null;
        this.isConnected = false;
        this.tradeLog = [];
        this.entryCandle = null;

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
    }

    start() {
        this.connect();
    }

    connect() {
        this.log('='.repeat(60), 'SYSTEM');
        this.log('🚀 Starting Quick Flip Scalper Bot', 'SYSTEM');
        this.log(`📊 Symbol: ${CONFIG.symbol}`, 'SYSTEM');
        this.log(`💰 Stake: $${CONFIG.trade_amount} | Multiplier: x${CONFIG.multiplier}`, 'SYSTEM');
        this.log(`⏰ Market Open Time: ${CONFIG.market_open_time} GMT`, 'SYSTEM');
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
                this.log('📡 Keep-alive ping sent', 'SYSTEM');
            }
        }, CONFIG.ping_interval);
    }

    cleanup() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    log(message, category = 'INFO') {
        const timestamp = new Date().toISOString();
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

        console.log(`${color}[${timestamp}] [${category}] ${message}${reset}`);
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

        this.tradeLog.forEach(trade => {
            if (trade.profit !== undefined) {
                totalProfit += trade.profit;
                if (trade.result === 'WIN') wins++;
                else losses++;
            }
        });

        const winRate = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(1) : 0;

        return `
📊 <b>Flip Scalper Session Summary</b>
========================
📈 <b>Asset:</b> ${CONFIG.symbol}
📊 <b>Total Trades:</b> ${this.tradeLog.length}
✅ <b>Wins:</b> ${wins}
❌ <b>Losses:</b> ${losses}
🔥 <b>Win Rate:</b> ${winRate}%
💰 <b>Total P/L:</b> $${totalProfit.toFixed(2)}
        `;
    }

    startTelegramTimer() {
        // Send summary every 30 minutes
        setInterval(() => {
            if (this.tradeLog.length > 0) {
                this.sendTelegramMessage(`📊 *Periodic Performance Summary*\n${this.getTelegramSummary()}`);
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
            this.log('📡 Pong received', 'SYSTEM');
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
            const dailyLossLimit = baseCapital * 0.5; // Example 50% limit like kNN.js user set

            this.log(`🏢 Investment Capital: $${baseCapital.toFixed(2)}`, 'INFO');
            this.log(`🚨 Daily Loss Limit: $${dailyLossLimit.toFixed(2)} (50%)`, 'INFO');

            this.log('-'.repeat(60), 'SYSTEM');
            this.log('📈 Strategy: Quick Flip Scalper', 'STRATEGY');
            this.log(`⏳ Waiting for market open at ${CONFIG.market_open_time} GMT...`, 'STRATEGY');
            this.startClock();
        }

        if (msg.msg_type === 'history') {
            if (msg.req_id === 1) { // daily_atr
                this.calculateATR(msg.history, msg.candles);
            } else if (msg.req_id === 2) { // opening_candle
                this.analyzeOpeningCandle(msg.candles);
            }
        }

        if (msg.msg_type === 'tick') {
            this.checkTime();
        }

        if (msg.msg_type === 'ohlc') {
            this.checkForReversal(msg.ohlc);
        }

        if (msg.msg_type === 'candles') {
            // Initial subscription response
            if (msg.candles && msg.candles.length > 0) {
                this.lastCandle = msg.candles[msg.candles.length - 1];
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
        this.log('🔄 Starting market monitoring...', 'SYSTEM');
        this.ws.send(JSON.stringify({ ticks: CONFIG.symbol }));
        this.getDailyHistory();
    }

    checkTime() {
        const now = new Date();
        const nowString = now.toISOString().substring(11, 16); // Extract HH:MM
        const currentMinute = nowString.substring(14, 16);

        // Only log time check every 5 minutes to avoid spam
        if (currentMinute === '00' || currentMinute === '15' || currentMinute === '30' || currentMinute === '45') {
            if (this.state === 'WAITING_FOR_OPEN') {
                this.log(`⏰ Current Time: ${nowString} GMT | State: ${this.state}`, 'INFO');
            }
        }

        // 1. Detect Market Open
        if (this.state === 'WAITING_FOR_OPEN' && nowString === CONFIG.market_open_time) {
            this.log('='.repeat(60), 'STRATEGY');
            this.log('🔔 MARKET OPEN DETECTED!', 'STRATEGY');
            this.log(`⏱️  Waiting ${CONFIG.candle_timeframe} minutes for opening candle to close...`, 'STRATEGY');
            this.log('='.repeat(60), 'STRATEGY');

            this.sendTelegramMessage(`🔔 <b>MARKET OPEN DETECTED!</b>\n<b>Asset:</b> ${CONFIG.symbol}\n<b>Time:</b> ${nowString} GMT\nWaiting for 15-min opening candle...`);

            this.openTimeEpoch = Math.floor(now.getTime() / 1000);
            this.state = 'WAITING_CANDLE_CLOSE';
        }

        // 2. Wait for 15-min Candle Close
        if (this.state === 'WAITING_CANDLE_CLOSE') {
            const minutesPassed = (Date.now() / 1000 - this.openTimeEpoch) / 60;
            const remainingMinutes = CONFIG.candle_timeframe - minutesPassed;

            if (Math.floor(remainingMinutes) !== Math.floor(remainingMinutes + 1 / 60)) {
                this.log(`⏳ Opening candle in progress... ${Math.ceil(remainingMinutes)} minutes remaining`, 'STRATEGY');
            }

            if (minutesPassed >= CONFIG.candle_timeframe) {
                this.log('✅ Opening candle closed. Fetching data...', 'STRATEGY');
                this.getOpeningCandle();
                this.state = 'CALCULATING_LIQUIDITY';
            }
        }

        // 3. Timeout check (90 mins)
        if (this.state === 'HUNTING') {
            const minutesPassed = (Date.now() / 1000 - this.openTimeEpoch) / 60;
            const remainingMinutes = CONFIG.market_open_duration - minutesPassed;

            if (remainingMinutes > 0 && remainingMinutes < 5) {
                this.log(`⚠️  Only ${Math.ceil(remainingMinutes)} minutes left in hunting window!`, 'STRATEGY');
            }

            if (minutesPassed > CONFIG.market_open_duration) {
                this.log('='.repeat(60), 'STRATEGY');
                this.log('⏰ 90 Minutes passed. No trade taken.', 'STRATEGY');
                this.log('🔄 Resetting for next market open...', 'STRATEGY');
                this.log('='.repeat(60), 'STRATEGY');
                this.state = 'WAITING_FOR_OPEN';
                this.resetSetup();
            }
        }
    }

    getDailyHistory() {
        this.log('📊 Fetching daily candle history for ATR calculation...', 'STRATEGY');
        this.ws.send(JSON.stringify({
            ticks_history: CONFIG.symbol,
            adjust_start_time: 1,
            count: 15,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: 86400, // 1 Day
            req_id: 1 // Replacement for custom_id: 'daily_atr'
        }));
    }

    calculateATR(history, candles) {
        this.log('-'.repeat(60), 'STRATEGY');
        this.log('📈 Calculating 14-Period Average True Range (ATR)...', 'STRATEGY');

        let trSum = 0;
        const trValues = [];

        for (let i = 1; i < candles.length; i++) {
            const current = candles[i];
            const prev = candles[i - 1];
            const hl = current.high - current.low;
            const hc = Math.abs(current.high - prev.close);
            const lc = Math.abs(current.low - prev.close);
            const tr = Math.max(hl, hc, lc);
            trValues.push(tr);
            trSum += tr;
        }

        this.dailyATR = trSum / 14;

        this.log(`✅ Daily ATR (14) Calculated: ${this.dailyATR.toFixed(4)}`, 'SUCCESS');
        this.log(`   Max TR: ${Math.max(...trValues).toFixed(4)}`, 'INFO');
        this.log(`   Min TR: ${Math.min(...trValues).toFixed(4)}`, 'INFO');
        this.log(`   25% of ATR (Liquidity Threshold): ${(this.dailyATR * 0.25).toFixed(4)}`, 'INFO');
        this.log('-'.repeat(60), 'STRATEGY');
    }

    getOpeningCandle() {
        this.log('🔍 Fetching opening candle data...', 'STRATEGY');
        const endTime = this.openTimeEpoch + (CONFIG.candle_timeframe * 60);

        this.ws.send(JSON.stringify({
            ticks_history: CONFIG.symbol,
            adjust_start_time: 1,
            count: 1,
            end: endTime,
            start: 1,
            style: 'candles',
            granularity: CONFIG.candle_timeframe * 60,
            req_id: 2 // Replacement for custom_id: 'opening_candle'
        }));
    }

    analyzeOpeningCandle(candles) {
        if (!candles || candles.length === 0) {
            this.log('❌ No candle data received', 'ERROR');
            return;
        }

        const candle = candles[candles.length - 1];
        const range = candle.high - candle.low;
        const bodySize = Math.abs(candle.close - candle.open);
        const isGreen = candle.close > candle.open;
        const candleColor = isGreen ? '🟢 GREEN' : '🔴 RED';

        this.log('='.repeat(60), 'STRATEGY');
        this.log('📊 OPENING CANDLE ANALYSIS', 'STRATEGY');
        this.log('-'.repeat(60), 'STRATEGY');
        this.log(`   Open:  ${candle.open.toFixed(4)}`, 'INFO');
        this.log(`   High:  ${candle.high.toFixed(4)}`, 'INFO');
        this.log(`   Low:   ${candle.low.toFixed(4)}`, 'INFO');
        this.log(`   Close: ${candle.close.toFixed(4)}`, 'INFO');
        this.log(`   Color: ${candleColor}`, 'INFO');
        this.log(`   Range: ${range.toFixed(4)}`, 'INFO');
        this.log(`   Body:  ${bodySize.toFixed(4)}`, 'INFO');
        this.log('-'.repeat(60), 'STRATEGY');

        // Liquidity Check: Range >= 25% of ATR
        const liquidityThreshold = 0.25 * this.dailyATR;
        const rangePercent = (range / this.dailyATR * 100).toFixed(1);

        this.log(`🔍 LIQUIDITY CHECK:`, 'STRATEGY');
        this.log(`   Range: ${range.toFixed(4)} | Threshold: ${liquidityThreshold.toFixed(4)}`, 'INFO');
        this.log(`   Range is ${rangePercent}% of Daily ATR`, 'INFO');

        if (range >= liquidityThreshold) {
            this.log('✅ LIQUIDITY CONFIRMED! Setup is VALID.', 'SUCCESS');
            this.log('-'.repeat(60), 'STRATEGY');

            this.box = {
                high: candle.high,
                low: candle.low,
                direction: isGreen ? 'UP' : 'DOWN',
                valid: true
            };

            const setupType = this.box.direction === 'UP' ? '🔻 BEARISH (Short)' : '🔼 BULLISH (Long)';
            const targetSide = this.box.direction === 'UP' ? 'ABOVE' : 'BELOW';
            const targetLevel = this.box.direction === 'UP' ? this.box.high : this.box.low;

            this.log('🎯 TRADING SETUP:', 'STRATEGY');
            this.log(`   Box High: ${this.box.high.toFixed(4)}`, 'INFO');
            this.log(`   Box Low:  ${this.box.low.toFixed(4)}`, 'INFO');
            this.log(`   Bias:     ${setupType}`, 'INFO');
            this.log(`   Looking for reversal ${targetSide} ${targetLevel.toFixed(4)}`, 'INFO');
            this.log(`   Time Window: ${CONFIG.market_open_duration} minutes`, 'INFO');
            this.log('='.repeat(60), 'STRATEGY');

            this.sendTelegramMessage(`✅ <b>LIQUIDITY CONFIRMED!</b>\n<b>Box Range:</b> ${range.toFixed(4)}\n<b>ATR (25%):</b> ${liquidityThreshold.toFixed(4)}\n<b>Setup:</b> ${setupType}\nHunting reversal at ${targetLevel.toFixed(4)}`);

            this.startHunting();
        } else {
            this.log('❌ LIQUIDITY CHECK FAILED!', 'ERROR');
            this.log(`   Range (${rangePercent}% of ATR) is below 25% threshold`, 'ERROR');
            this.log('   No trade setup today. Resetting...', 'ERROR');
            this.log('='.repeat(60), 'STRATEGY');

            this.sendTelegramMessage(`❌ <b>LIQUIDITY CHECK FAILED</b>\nRange is ONLY ${rangePercent}% of ATR. No setup today.`);

            this.state = 'WAITING_FOR_OPEN';
            this.resetSetup();
        }
    }

    startHunting() {
        this.state = 'HUNTING';
        this.log('🎯 HUNTING MODE ACTIVATED', 'STRATEGY');
        this.log(`⏱️  Monitoring ${CONFIG.entry_timeframe}-minute candles for reversal patterns...`, 'STRATEGY');

        this.ws.send(JSON.stringify({
            ticks_history: CONFIG.symbol,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: CONFIG.entry_timeframe * 60,
            subscribe: 1
        }));
    }

    checkForReversal(candle) {
        if (this.state !== 'HUNTING') return;

        // Only analyze when we have a new candle (different epoch)
        if (this.lastCandle && this.lastCandle.epoch === candle.epoch) {
            return; // Same candle, skip
        }

        this.lastCandle = candle;

        const body = Math.abs(candle.close - candle.open);
        const range = candle.high - candle.low;
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        const isGreen = candle.close > candle.open;

        // Log candle monitoring (every 5th candle to reduce spam)
        if (Math.random() < 0.2) {
            this.log(`👀 Monitoring: Price ${candle.close.toFixed(4)} | Box: [${this.box.low.toFixed(4)} - ${this.box.high.toFixed(4)}]`, 'INFO');
        }

        // Condition 1: Looking for LONG (Bullish) - Price must be BELOW box low
        if (this.box.direction === 'DOWN' && candle.close < this.box.low) {
            this.log('-'.repeat(60), 'TRADE');
            this.log(`🔍 Price broke BELOW box at ${candle.close.toFixed(4)}`, 'TRADE');
            this.log(`   Analyzing for BULLISH reversal pattern...`, 'TRADE');

            // Hammer Pattern: Lower wick >= 2x Body and upper wick < body
            const isHammer = lowerWick >= (2 * body) && upperWick < body && body > 0;

            if (isHammer) {
                this.log('='.repeat(60), 'TRADE');
                this.log('🔥 HAMMER PATTERN DETECTED!', 'SUCCESS');
                this.log(`   Open:       ${candle.open.toFixed(4)}`, 'INFO');
                this.log(`   High:       ${candle.high.toFixed(4)}`, 'INFO');
                this.log(`   Low:        ${candle.low.toFixed(4)}`, 'INFO');
                this.log(`   Close:      ${candle.close.toFixed(4)}`, 'INFO');
                this.log(`   Body:       ${body.toFixed(4)}`, 'INFO');
                this.log(`   Lower Wick: ${lowerWick.toFixed(4)} (${(lowerWick / body).toFixed(2)}x body)`, 'INFO');
                this.log(`   Upper Wick: ${upperWick.toFixed(4)}`, 'INFO');
                this.log('='.repeat(60), 'TRADE');

                this.sendTelegramMessage(`🔥 <b>HAMMER PATTERN DETECTED!</b>\n<b>Reversal Pattern at:</b> ${candle.close.toFixed(4)}\nExecuting LONG.`);

                this.entryCandle = candle;
                this.executeTrade('MULTUP'); // Multiplier UP (Long)
            }
        }

        // Condition 2: Looking for SHORT (Bearish) - Price must be ABOVE box high
        if (this.box.direction === 'UP' && candle.close > this.box.high) {
            this.log('-'.repeat(60), 'TRADE');
            this.log(`🔍 Price broke ABOVE box at ${candle.close.toFixed(4)}`, 'TRADE');
            this.log(`   Analyzing for BEARISH reversal pattern...`, 'TRADE');

            // Shooting Star / Inverted Hammer: Upper wick >= 2x Body and lower wick < body
            const isShootingStar = upperWick >= (2 * body) && lowerWick < body && body > 0;

            if (isShootingStar) {
                this.log('='.repeat(60), 'TRADE');
                this.log('🔥 SHOOTING STAR PATTERN DETECTED!', 'SUCCESS');
                this.log(`   Open:       ${candle.open.toFixed(4)}`, 'INFO');
                this.log(`   High:       ${candle.high.toFixed(4)}`, 'INFO');
                this.log(`   Low:        ${candle.low.toFixed(4)}`, 'INFO');
                this.log(`   Close:      ${candle.close.toFixed(4)}`, 'INFO');
                this.log(`   Body:       ${body.toFixed(4)}`, 'INFO');
                this.log(`   Upper Wick: ${upperWick.toFixed(4)} (${(upperWick / body).toFixed(2)}x body)`, 'INFO');
                this.log(`   Lower Wick: ${lowerWick.toFixed(4)}`, 'INFO');
                this.log('='.repeat(60), 'TRADE');

                this.sendTelegramMessage(`🔥 <b>SHOOTING STAR PATTERN DETECTED!</b>\n<b>Reversal Pattern at:</b> ${candle.close.toFixed(4)}\nExecuting SHORT.`);

                this.entryCandle = candle;
                this.executeTrade('MULTDOWN'); // Multiplier DOWN (Short)
            }
        }
    }

    executeTrade(contractType) {
        this.state = 'EXECUTING';

        const baseCapital = CONFIG.INVESTMENT_CAPITAL || this.trade_amount;
        const stake = Math.max(baseCapital * (CONFIG.RISK_PERCENT / 100), 0.35).toFixed(2);

        const direction = contractType === 'MULTUP' ? '🔼 LONG' : '🔻 SHORT';
        const target = contractType === 'MULTUP' ? this.box.high : this.box.low;

        this.log('='.repeat(60), 'TRADE');
        this.log('🚀 EXECUTING TRADE', 'TRADE');
        this.log(`   Capital:     $${baseCapital.toFixed(2)}`, 'INFO');
        this.log(`   Direction:   ${direction}`, 'INFO');
        this.log(`   Symbol:      ${CONFIG.symbol}`, 'INFO');
        this.log(`   Stake:       $${stake} (${CONFIG.RISK_PERCENT}% of capital)`, 'INFO');
        this.log(`   Multiplier:  x${CONFIG.multiplier}`, 'INFO');
        this.log(`   Entry Price: ${this.entryCandle.close.toFixed(4)}`, 'INFO');
        this.log(`   Target:      ${target.toFixed(4)}`, 'INFO');
        this.log('='.repeat(60), 'TRADE');

        // Unsubscribe from candles to stop double entry
        this.ws.send(JSON.stringify({ forget_all: 'candles' }));

        this.sendTelegramMessage(`🚀 <b>EXECUTING TRADE</b>\n<b>Capital:</b> $${baseCapital.toFixed(2)}\n<b>Direction:</b> ${direction}\n<b>Stake:</b> $${stake}\n<b>Entry:</b> ${this.entryCandle.close.toFixed(4)}\n<b>Target:</b> ${target.toFixed(4)}`);

        this.ws.send(JSON.stringify({
            buy: 1,
            price: stake,
            parameters: {
                contract_type: contractType,
                symbol: CONFIG.symbol,
                currency: 'USD',
                multiplier: CONFIG.multiplier,
            }
        }));
    }

    handleBuyResponse(msg) {
        if (msg.buy) {
            this.log('='.repeat(60), 'SUCCESS');
            this.log('✅ TRADE EXECUTED SUCCESSFULLY!', 'SUCCESS');
            this.log(`   Contract ID: ${msg.buy.contract_id}`, 'INFO');
            this.log(`   Buy Price:   ${msg.buy.buy_price}`, 'INFO');
            this.log(`   Payout:      ${msg.buy.payout}`, 'INFO');
            this.log('='.repeat(60), 'SUCCESS');

            this.currentContractId = msg.buy.contract_id;
            this.state = 'IN_TRADE';

            this.tradeLog.push({
                contractId: msg.buy.contract_id,
                entryTime: new Date().toISOString(),
                entryPrice: this.entryCandle.close,
                direction: msg.buy.contract_type,
                stake: CONFIG.trade_amount,
                target: msg.buy.contract_type === 'MULTUP' ? this.box.high : this.box.low
            });

            this.monitorTrade();
        }
    }

    monitorTrade() {
        this.log('📊 Starting trade monitoring...', 'TRADE');

        if (this.currentContractId) {
            this.ws.send(JSON.stringify({
                proposal_open_contract: 1,
                contract_id: this.currentContractId,
                subscribe: 1
            }));
        }
    }

    handleTradeUpdate(contract) {
        if (contract.is_sold) {
            this.handleTradeClosed(contract);
            return;
        }

        const currentPrice = contract.current_spot;
        const entryPrice = contract.entry_spot;
        const profit = contract.profit;
        const contractType = contract.contract_type;

        // Calculate distance to target
        const target = contractType === 'MULTUP' ? this.box.high : this.box.low;
        const distanceToTarget = Math.abs(currentPrice - target);
        const progressPercent = contractType === 'MULTUP'
            ? ((currentPrice - entryPrice) / (target - entryPrice) * 100)
            : ((entryPrice - currentPrice) / (entryPrice - target) * 100);

        // Log trade status periodically
        this.log('-'.repeat(60), 'TRADE');
        this.log('📈 ACTIVE TRADE STATUS', 'TRADE');
        this.log(`   Contract ID:     ${this.currentContractId}`, 'INFO');
        this.log(`   Entry Price:     ${entryPrice.toFixed(4)}`, 'INFO');
        this.log(`   Current Price:   ${currentPrice.toFixed(4)}`, 'INFO');
        this.log(`   Target:          ${target.toFixed(4)}`, 'INFO');
        this.log(`   Distance to Target: ${distanceToTarget.toFixed(4)}`, 'INFO');
        this.log(`   Progress:        ${Math.min(progressPercent, 100).toFixed(1)}%`, 'INFO');
        this.log(`   P/L:             ${profit >= 0 ? '🟢' : '🔴'} $${profit.toFixed(2)}`, profit >= 0 ? 'SUCCESS' : 'ERROR');
        this.log('-'.repeat(60), 'TRADE');

        // Check if target hit
        let targetHit = false;

        if (contractType === 'MULTUP') { // Long
            if (currentPrice >= target) {
                targetHit = true;
            }
        } else { // Short
            if (currentPrice <= target) {
                targetHit = true;
            }
        }

        if (targetHit) {
            this.log('='.repeat(60), 'SUCCESS');
            this.log('🎯 TARGET REACHED!', 'SUCCESS');
            this.log(`   Target Price: ${target.toFixed(4)}`, 'INFO');
            this.log(`   Current Price: ${currentPrice.toFixed(4)}`, 'INFO');
            this.log(`   Profit: $${profit.toFixed(2)}`, 'INFO');
            this.log('   Closing trade at market price...', 'INFO');
            this.log('='.repeat(60), 'SUCCESS');

            this.ws.send(JSON.stringify({
                sell: this.currentContractId,
                price: 0 // Market sell
            }));
        }
    }

    handleTradeClosed(contract) {
        const profit = contract.profit;
        const exitPrice = contract.exit_tick;
        const isWin = profit > 0;

        this.log('='.repeat(60), 'SUCCESS');
        this.log('🏁 TRADE CLOSED', 'TRADE');
        this.log('-'.repeat(60), 'TRADE');
        this.log(`   Contract ID:   ${this.currentContractId}`, 'INFO');
        this.log(`   Entry Price:   ${contract.entry_spot.toFixed(4)}`, 'INFO');
        this.log(`   Exit Price:    ${exitPrice.toFixed(4)}`, 'INFO');
        this.log(`   Final P/L:     ${isWin ? '🟢' : '🔴'} $${profit.toFixed(2)}`, isWin ? 'SUCCESS' : 'ERROR');
        this.log(`   Result:        ${isWin ? '✅ WIN' : '❌ LOSS'}`, isWin ? 'SUCCESS' : 'ERROR');
        this.log('='.repeat(60), 'SUCCESS');

        // Update trade log
        const tradeIndex = this.tradeLog.findIndex(t => t.contractId === this.currentContractId);
        if (tradeIndex !== -1) {
            this.tradeLog[tradeIndex].exitTime = new Date().toISOString();
            this.tradeLog[tradeIndex].exitPrice = exitPrice;
            this.tradeLog[tradeIndex].profit = profit;
            this.tradeLog[tradeIndex].result = isWin ? 'WIN' : 'LOSS';
        }

        if (isWin) {
            this.sendTelegramMessage(`🎉 <b>TARGET HIT - TRADE WON!</b>\n<b>Profit:</b> +$${profit.toFixed(2)}\n<b>Exit Price:</b> ${exitPrice.toFixed(4)}`);
        } else {
            this.sendTelegramMessage(`❌ <b>TRADE CLOSED</b>\n<b>Profit/Loss:</b> $${profit.toFixed(2)}\n<b>Exit Price:</b> ${exitPrice.toFixed(4)}`);
        }

        this.printTradeLog();

        this.state = 'WAITING_FOR_OPEN';
        this.ws.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
        this.resetSetup();
    }

    handleSellResponse(msg) {
        if (msg.sell) {
            this.log('✅ Sell order executed', 'SUCCESS');
        }
    }

    printTradeLog() {
        if (this.tradeLog.length === 0) return;

        this.log('='.repeat(60), 'SYSTEM');
        this.log('📊 TRADE LOG SUMMARY', 'SYSTEM');
        this.log('='.repeat(60), 'SYSTEM');

        let totalProfit = 0;
        let wins = 0;
        let losses = 0;

        this.tradeLog.forEach((trade, index) => {
            this.log(`Trade #${index + 1}:`, 'INFO');
            this.log(`   Contract:    ${trade.contractId}`, 'INFO');
            this.log(`   Direction:   ${trade.direction === 'MULTUP' ? '🔼 LONG' : '🔻 SHORT'}`, 'INFO');
            this.log(`   Entry Time:  ${trade.entryTime}`, 'INFO');
            this.log(`   Entry Price: ${trade.entryPrice.toFixed(4)}`, 'INFO');
            if (trade.exitPrice) {
                this.log(`   Exit Time:   ${trade.exitTime}`, 'INFO');
                this.log(`   Exit Price:  ${trade.exitPrice.toFixed(4)}`, 'INFO');
                this.log(`   Profit:      ${trade.profit >= 0 ? '🟢' : '🔴'} ${trade.profit.toFixed(2)}`, 'INFO');
                this.log(`   Result:      ${trade.result === 'WIN' ? '✅' : '❌'} ${trade.result}`, 'INFO');
                totalProfit += trade.profit;
                if (trade.result === 'WIN') wins++;
                else losses++;
            }
            this.log('-'.repeat(60), 'SYSTEM');
        });

        const winRate = this.tradeLog.length > 0 ? (wins / (wins + losses) * 100).toFixed(1) : 0;

        this.log('OVERALL STATISTICS:', 'SYSTEM');
        this.log(`   Total Trades:  ${wins + losses}`, 'INFO');
        this.log(`   Wins:          ${wins}`, 'SUCCESS');
        this.log(`   Losses:        ${losses}`, 'ERROR');
        this.log(`   Win Rate:      ${winRate}%`, 'INFO');
        this.log(`   Total P/L:     ${totalProfit >= 0 ? '🟢' : '🔴'} ${totalProfit.toFixed(2)}`, totalProfit >= 0 ? 'SUCCESS' : 'ERROR');
        this.log('='.repeat(60), 'SYSTEM');
    }

    resetSetup() {
        this.ws.send(JSON.stringify({ forget_all: 'candles' }));
        this.box = { high: null, low: null, direction: null, valid: false };
        this.lastCandle = null;
        this.entryCandle = null;
        this.log('🔄 Setup reset. Ready for next market open.', 'SYSTEM');
    }
}

// ================= START BOT =================
const bot = new QuickFlipBot();
bot.start();

const initialStake = (CONFIG.INVESTMENT_CAPITAL * (CONFIG.RISK_PERCENT / 100)).toFixed(2);
bot.sendTelegramMessage(`🚀 <b>QUICK FLIP SCALPER STARTED</b>\n<b>Symbol:</b> ${CONFIG.symbol}\n<b>Capital:</b> $${CONFIG.INVESTMENT_CAPITAL.toFixed(2)}\n<b>Target Stake:</b> $${initialStake}\nx${CONFIG.multiplier} Multiplier`);

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
