/**
 * Deriv Multiplier Bot - Trend Pullback (FVG + 50 EMA)
 * Strategy Source: Data Trader YouTube - Strategy #1
 */

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

// ================= CONFIGURATION =================
const CONFIG = {
    APP_ID: 1089, // Replace with your Deriv App ID
    TOKEN: 'hsj0tA0XJoIzJG5', // Replace with your Token
    SYMBOL: 'R_75', // Volatility 75 Index
    GRANULARITY: 900, // 15 Minutes (The "sweet spot" [00:03:54])

    // Risk Management
    RISK_PERCENT: 0.20, // 20% risk per trade [00:02:14]
    RR_RATIO: 3,        // 1:3 Reward-to-Risk [00:01:16]

    // Indicator Settings
    EMA_PERIOD: 50,

    // Telegram
    TELEGRAM_TOKEN: '8132747567:AAFtaN1j9U5HgNiK_TVE7axWzFDifButwKk',
    TELEGRAM_CHAT_ID: '752497117'
};

const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${CONFIG.APP_ID}`);
let tgBot = null;
if (CONFIG.TELEGRAM_TOKEN) {
    tgBot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });
}

let candles = [];
let balance = 0;
let isTrading = false;

// ================= LOGGING =================
const COLORS = {
    RESET: '\x1b[0m',
    INFO: '\x1b[37m',     // White
    SUCCESS: '\x1b[32m',  // Green
    ERROR: '\x1b[31m',    // Red
    WARNING: '\x1b[33m',  // Yellow
    SIGNAL: '\x1b[35m',   // Magenta (Analysis/Signal)
    TRADE: '\x1b[36m',    // Cyan (Trade Info)
    DATA: '\x1b[90m'      // Gray (Debug/Data)
};

function log(message, type = 'INFO') {
    const time = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
    const color = COLORS[type] || COLORS.INFO;
    console.log(`${color}[${time}] [${type}] ${message}${COLORS.RESET}`);
}

async function sendTelegram(message) {
    if (!tgBot) return;
    try {
        await tgBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
    } catch (error) {
        log(`Telegram Error: ${error.message}`, 'ERROR');
    }
}

// ================= STATE & STATS =================
let sessionStats = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    realizedPnL: 0,
    startTime: Date.now()
};

let activeTrade = null; // Stores details of the currently running trade

// ================= INDICATORS =================
function calculateEMA(data, period) {
    if (data.length < period) return null;
    const k = 2 / (period + 1);
    let ema = [data[0]];
    for (let i = 1; i < data.length; i++) {
        ema.push(data[i] * k + ema[i - 1] * (1 - k));
    }
    return ema[ema.length - 1];
}

function findFVG(c1, c2, c3) {
    // Bullish FVG
    if (c3.low > c1.high) {
        return { type: 'BULLISH', top: c3.low, bottom: c1.high };
    }
    // Bearish FVG
    if (c3.high < c1.low) {
        return { type: 'BEARISH', top: c1.low, bottom: c3.high };
    }
    return null;
}

// ================= WEBSOCKET HANDLERS =================
ws.on('open', () => {
    log('Connected to Deriv. Authorizing...', 'INFO');
    ws.send(JSON.stringify({ authorize: CONFIG.TOKEN }));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);

    if (msg.error) {
        log(msg.error.message, 'ERROR');
        return;
    }

    if (msg.msg_type === 'authorize') {
        balance = parseFloat(msg.authorize.balance);
        log(`Authorized. Account: ${msg.authorize.loginid} | Balance: $${balance.toFixed(2)}`, 'SUCCESS');

        sendTelegram(`
🚀 <b>PullBack Bot Started</b> [${CONFIG.SYMBOL}]
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>Strategy:</b> PullBack (FVG + 50 EMA)
<b>Balance:</b> $${balance.toFixed(2)}
<b>Risk:</b> ${(CONFIG.RISK_PERCENT * 100).toFixed(0)}%
        `);

        subscribeCandles();
    }

    if (msg.msg_type === 'ohlc') {
        processUpdate(msg.ohlc);
    }

    if (msg.msg_type === 'candles') {
        processHistory(msg.candles);
    }

    if (msg.msg_type === 'buy') {
        handleBuyResponse(msg.buy);
    }

    if (msg.msg_type === 'proposal_open_contract') {
        handleactiveTrade(msg.proposal_open_contract);
    }
});

// Processing the initial history list
function processHistory(historyList) {
    candles = historyList.map(c => ({
        time: c.epoch,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close)
    }));
    log(`✅ History loaded: ${candles.length} candles.`, 'SUCCESS');

    // Run initial analysis
    if (candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        checkStrategy(lastCandle, true);
    }
}

function subscribeCandles() {
    log(`Subscribing to ${CONFIG.SYMBOL} candles (${CONFIG.GRANULARITY / 60}m)...`, 'INFO');
    ws.send(JSON.stringify({
        ticks_history: CONFIG.SYMBOL,
        adjust_start_time: 1,
        count: 100,
        end: 'latest',
        granularity: CONFIG.GRANULARITY,
        style: 'candles',
        subscribe: 1
    }));
}

function processUpdate(ohlc) {
    const currentCandle = {
        time: ohlc.open_time,
        open: parseFloat(ohlc.open),
        high: parseFloat(ohlc.high),
        low: parseFloat(ohlc.low),
        close: parseFloat(ohlc.close)
    };

    // Update existing or push new
    let isNewCandle = false;
    if (candles.length > 0 && candles[candles.length - 1].time === currentCandle.time) {
        candles[candles.length - 1] = currentCandle;
    } else {
        candles.push(currentCandle);
        if (candles.length > 100) candles.shift();
        isNewCandle = true;
    }

    // Check strategy on every tick to catch moves into the zone
    checkStrategy(currentCandle, isNewCandle);

    // Heartbeat: Log every ~60 seconds (approx 240 ticks if tick stream is 4/sec, or use checking timestamp)
    // Using timestamp for better accuracy
    if (!global.lastHeartbeat || Date.now() - global.lastHeartbeat > 60000) {
        log(`💓 Monitoring Market... Price: ${currentCandle.close} | Waiting for Pullback`, 'INFO');
        global.lastHeartbeat = Date.now();
    }
}

// ================= STRATEGY EXECUTION =================
function checkStrategy(currentPriceCandle, isNewCandle) {
    if (isTrading || candles.length < 50) return;

    // Analysis uses CLOSED candles
    const closedCandles = candles.slice(0, -1);
    if (closedCandles.length < 50) return;

    const closes = closedCandles.map(c => c.close);
    const ema50 = calculateEMA(closes, CONFIG.EMA_PERIOD);
    const lastClosed = closedCandles[closedCandles.length - 1];

    const c1 = closedCandles[closedCandles.length - 4];
    const c2 = closedCandles[closedCandles.length - 3];
    const c3 = closedCandles[closedCandles.length - 2];

    const fvg = findFVG(c1, c2, c3);

    // Only log analysis on new candle creation to avoid spam
    if (isNewCandle) {
        const currentPrice = currentPriceCandle.close;
        const trend = lastClosed.close > ema50 ? 'BULLISH' : 'BEARISH';

        if (fvg) {
            if (trend === 'BULLISH' && fvg.type === 'BULLISH') {
                log(`🔍 ANALYSIS: ${trend} Trend (Price > EMA) | FVG detected [${fvg.bottom} - ${fvg.top}]`, 'SIGNAL');
            } else if (trend === 'BEARISH' && fvg.type === 'BEARISH') {
                log(`🔍 ANALYSIS: ${trend} Trend (Price < EMA) | FVG detected [${fvg.bottom} - ${fvg.top}]`, 'SIGNAL');
            } else {
                log(`🔍 ANALYSIS: ${trend} Trend | FVG [${fvg.type}] ignored (Counter-trend)`, 'DATA');
            }
        } else {
            log(`🔍 ANALYSIS: ${trend} Trend | Price: ${currentPrice} | EMA: ${ema50.toFixed(2)} | No FVG`, 'DATA');
        }
    }

    // Check for Entry (Always)
    if (fvg) {
        const currentPrice = currentPriceCandle.close;

        if (lastClosed.close > ema50 && fvg.type === 'BULLISH') {
            const inZone = currentPrice <= fvg.top && currentPrice >= fvg.bottom;
            if (inZone) {
                log(`⚡ PRICE IN ZONE [${fvg.bottom} - ${fvg.top}] - EXECUTING BULLISH TRADE`, 'SIGNAL');
                executeTrade('MULTUP', fvg.bottom);
            }
        }
        else if (lastClosed.close < ema50 && fvg.type === 'BEARISH') {
            const inZone = currentPrice >= fvg.bottom && currentPrice <= fvg.top;
            if (inZone) {
                log(`⚡ PRICE IN ZONE [${fvg.bottom} - ${fvg.top}] - EXECUTING BEARISH TRADE`, 'SIGNAL');
                executeTrade('MULTDOWN', fvg.top);
            }
        }
    }
}

function executeTrade(type, stopLevel) {
    if (isTrading) return; // double check

    const stake = (balance * CONFIG.RISK_PERCENT).toFixed(2);
    const currentPrice = candles[candles.length - 1].close;

    // Calculate Stop Loss distance in USD for Multipliers
    const slDistance = Math.abs(currentPrice - stopLevel);
    // Minimum buffer to avoid immediate stop out? 
    // Ensure SL is positive and reasonable
    if (slDistance === 0) return;

    const tpDistance = slDistance * CONFIG.RR_RATIO;

    log(`🚀 EXECUTING ${type} TRADE`, 'TRADE');
    log(`   Stake: $${stake} | Price: ${currentPrice}`, 'TRADE');
    log(`   Stop Loss Level: ${stopLevel} (Dist: ${slDistance.toFixed(2)})`, 'TRADE');
    log(`   Target Profit: +$${(stake * CONFIG.RR_RATIO * 20).toFixed(2)} (approx based on Multiplier)`, 'TRADE'); // Rough est

    isTrading = true; // Block new signals

    ws.send(JSON.stringify({
        buy: 1,
        price: stake,
        parameters: {
            amount: stake,
            basis: 'stake',
            contract_type: type,
            currency: 'USD',
            multiplier: 100, // Fixed multiplier
            symbol: CONFIG.SYMBOL,
            limit_order: {
                stop_loss: parseFloat(slDistance.toFixed(2)),
                take_profit: parseFloat(tpDistance.toFixed(2))
            }
        }
    }));
}

function handleBuyResponse(buy) {
    if (buy.contract_id) {
        log(`✅ TRADE OPENED SUCCESSFULLY`, 'SUCCESS');
        log(`   Contract ID: ${buy.contract_id}`, 'TRADE');
        log(`   Buy Price: $${buy.buy_price}`, 'TRADE');

        activeTrade = {
            id: buy.contract_id,
            entryPrice: buy.buy_price,
            startTime: Date.now()
        };

        const stake = (balance * CONFIG.RISK_PERCENT).toFixed(2);
        sendTelegram(`
🎯 <b>TRADE OPENED</b> [${CONFIG.SYMBOL}]
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>ID:</b> ${buy.contract_id}
<b>Stake:</b> $${stake}
<b>Price:</b> ${buy.buy_price}
        `);

        // Subscribe to this contract
        ws.send(JSON.stringify({
            proposal_open_contract: 1,
            contract_id: buy.contract_id,
            subscribe: 1
        }));
    } else {
        isTrading = false; // Reset if failed
    }
}

function handleactiveTrade(contract) {
    if (contract.is_sold) {
        // Trade Finished
        const profit = parseFloat(contract.profit);
        const result = profit >= 0 ? 'WIN' : 'LOSS';
        const duration = contract.current_spot_time - contract.entry_tick_time;

        sessionStats.totalTrades++;
        if (profit >= 0) sessionStats.wins++; else sessionStats.losses++;
        sessionStats.realizedPnL += profit;

        const winRate = sessionStats.totalTrades > 0 ? ((sessionStats.wins / sessionStats.totalTrades) * 100).toFixed(1) : "0.0";

        log(`==========================================`, result === 'WIN' ? 'SUCCESS' : 'ERROR');
        log(`🏁 TRADE COMPLETED: ${result}`, result === 'WIN' ? 'SUCCESS' : 'ERROR');
        log(`   Profit/Loss:   ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`, result === 'WIN' ? 'SUCCESS' : 'ERROR');
        log(`   Duration:      ${duration}s`, 'TRADE');
        log(`   Recovery:      $${contract.sell_price}`, 'TRADE');
        log(`------------------------------------------`, 'INFO');
        log(`📊 SESSION STATS`, 'INFO');
        log(`   Trades: ${sessionStats.totalTrades} | Win Rate: ${winRate}%`, 'INFO');
        log(`   Total P/L: ${sessionStats.realizedPnL >= 0 ? '+' : ''}$${sessionStats.realizedPnL.toFixed(2)}`, 'INFO');
        log(`==========================================`, result === 'WIN' ? 'SUCCESS' : 'ERROR');

        const color = profit > 0 ? '✅' : '❌';
        sendTelegram(`
${color} <b>TRADE COMPLETED</b> [${CONFIG.SYMBOL}]
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>Result:</b> ${result}
<b>P/L:</b> $${profit.toFixed(2)}
<b>Duration:</b> ${duration}s

📊 <b>Session Stats:</b>
<b>Trades:</b> ${sessionStats.totalTrades} (${winRate}%)
<b>Realized P/L:</b> $${sessionStats.realizedPnL.toFixed(2)}
        `);

        isTrading = false;
        activeTrade = null;

    } else {
        // Active Trade Update
        const currentProfit = parseFloat(contract.profit);
        const profitPercent = parseFloat(contract.profit_percentage).toFixed(2);

        // Log periodically or on significant change? 
        // For now, let's log every update but maybe throttle visually if it's too fast?
        // Since granularity is 15m, updates might not be super crazy fast unless volatility is high.
        // Actually Multipliers update every tick. 
        // Let's log only if profit changes significantly or just use a heartbeat?
        // User asked for "Active trade details".

        log(`⏳ ACTIVE TRADE: P/L ${currentProfit >= 0 ? '+' : ''}$${currentProfit.toFixed(2)} (${profitPercent}%) | Spot: ${contract.current_spot}`, currentProfit >= 0 ? 'SUCCESS' : 'WARNING');
    }
}
