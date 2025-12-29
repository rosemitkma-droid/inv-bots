/**
 * Deriv Trading Bot - Multi-Asset 1s Index Price Action Strategy
 * Manual WebSocket Implementation (Refactored & Enhanced)
 */

const WebSocket = require('ws');
const fs = require('fs');
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// ========== CONFIGURATION ==========
const CONFIG = {
    app_id: '1089',
    token: process.env.DERIV_API_TOKEN || 'Dz2V2KvRf4Uukt3',
    ws_url: 'wss://ws.derivws.com/websockets/v3',

    // MULTI-ASSET CONFIGURATION
    symbols: [
        { name: '1HZ10V', label: 'Volatility 10 (1s)', enabled: false },
        { name: '1HZ25V', label: 'Volatility 25 (1s)', enabled: false },
        { name: '1HZ50V', label: 'Volatility 50 (1s)', enabled: true },
        { name: '1HZ75V', label: 'Volatility 75 (1s)', enabled: true },
        { name: '1HZ100V', label: 'Volatility 100 (1s)', enabled: true }
    ],

    stake: 1,              // $5 per trade per symbol
    multiplier: 200,        // 200x multiplier
    stop_loss: 50,          // $5 stop loss
    currency: 'USD',

    // Investment Management
    INVESTMENT_CAPITAL: process.env.INITIAL_CAPITAL ? parseFloat(process.env.INITIAL_CAPITAL) : 1000,
    RISK_PERCENT: 5, // 5% risk per trade if using capital

    // Strategy parameters
    dailyOpenThreshold: 0.5,
    h4CandlesForTrend: 7,
    h4CandlesForTP: 10,
    h1CandlesForConfirm: 6,
    smaPeriod: 20,

    checkInterval: 20000, // Increased to 20s for better processing
    maxTradesPerSymbol: 1,
    maxTotalTrades: 5,

    // Telegram Configuration
    telegramToken: process.env.TELEGRAM_BOT_TOKEN7,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
};

// ========== GLOBAL STATE ==========
let ws = null;
let isConnected = false;
let isAuthorized = false;
let requestId = 1;
let currentTrades = {};
let completedTrades = [];
let strategyStates = {};
let isRunning = true;
let activeSymbols = [];
let pendingPromises = new Map();
let telegramBot = null;
let sessionStats = {
    startTime: new Date(),
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalPnL: 0
};

// ========== UTILITY FUNCTIONS ==========

function log(message, level = 'INFO', symbol = '') {
    const timestamp = new Date().toLocaleTimeString();
    const symbolTag = symbol ? `[${symbol}] ` : '';
    console.log(`[${timestamp}] [${level}] ${symbolTag}${message}`);
}

function calculateSMA(candles, period) {
    if (!candles || candles.length < period) return null;
    const closes = candles.slice(-period).map(c => parseFloat(c.close));
    return closes.reduce((a, b) => a + b, 0) / period;
}

function isBullishCandle(candle) {
    return parseFloat(candle.close) > parseFloat(candle.open);
}

function getHighestHigh(candles) {
    return Math.max(...candles.map(c => parseFloat(c.high)));
}

// ========== TELEGRAM HELPERS ==========

function initTelegram() {
    if (CONFIG.telegramToken && CONFIG.telegramChatId) {
        telegramBot = new TelegramBot(CONFIG.telegramToken, { polling: false });
        log('📱 Telegram notifications enabled');
    } else {
        log('📱 Telegram notifications disabled (missing API keys)', 'WARNING');
    }
}

async function sendTelegramMessage(message) {
    if (!telegramBot) return;
    try {
        await telegramBot.sendMessage(CONFIG.telegramChatId, message, { parse_mode: 'HTML' });
    } catch (error) {
        log(`Failed to send Telegram message: ${error.message}`, 'ERROR');
    }
}

function getSessionSummary() {
    const runtime = Math.floor((new Date() - sessionStats.startTime) / 1000 / 60);
    const winRate = sessionStats.totalTrades > 0 ? ((sessionStats.wins / sessionStats.totalTrades) * 100).toFixed(1) : 0;

    return `
📊 <b>Session Summary</b>
━━━━━━━━━━━━━━━━━
⏱ <b>Runtime:</b> ${runtime} mins
📈 <b>Total Trades:</b> ${sessionStats.totalTrades}
✅ <b>Wins:</b> ${sessionStats.wins}
❌ <b>Losses:</b> ${sessionStats.losses}
🔥 <b>Win Rate:</b> ${winRate}%
💰 <b>Net P/L:</b> $${sessionStats.totalPnL.toFixed(2)}
    `;
}

// ========== CONNECTION MANAGEMENT ==========

function connect() {
    log('Connecting to Deriv API...');
    ws = new WebSocket(`${CONFIG.ws_url}?app_id=${CONFIG.app_id}`);

    ws.on('open', () => {
        isConnected = true;
        log('WebSocket connected', 'SUCCESS');
        authorize();
    });

    ws.on('message', (data) => {
        try {
            const response = JSON.parse(data);
            handleMessage(response);
        } catch (e) {
            log(`Parsing error: ${e.message}`, 'ERROR');
        }
    });

    ws.on('close', () => {
        isConnected = false;
        isAuthorized = false;
        log('WebSocket disconnected. Reconnecting in 5s...', 'WARNING');
        setTimeout(connect, 5000);
    });

    ws.on('error', (err) => {
        log(`WebSocket error: ${err.message}`, 'ERROR');
    });
}

function sendRequest(request) {
    if (!isConnected) return null;
    const reqId = requestId++;
    request.req_id = reqId;
    ws.send(JSON.stringify(request));
    return reqId;
}

function sendRequestWithPromise(request) {
    return new Promise((resolve, reject) => {
        if (!isConnected) return reject(new Error('Not connected'));
        const reqId = requestId++;
        request.req_id = reqId;

        pendingPromises.set(reqId, {
            resolve, reject, timeout: setTimeout(() => {
                if (pendingPromises.has(reqId)) {
                    pendingPromises.delete(reqId);
                    reject(new Error(`Request ${reqId} (${request.msg_type || 'unknown'}) timed out`));
                }
            }, 30000)
        });

        ws.send(JSON.stringify(request));
    });
}

function handleMessage(msg) {
    if (msg.req_id && pendingPromises.has(msg.req_id)) {
        const { resolve, reject, timeout } = pendingPromises.get(msg.req_id);
        clearTimeout(timeout);
        pendingPromises.delete(msg.req_id);
        if (msg.error) reject(msg.error);
        else resolve(msg);
        return;
    }

    if (msg.error) {
        log(`API Error: ${msg.error.message}`, 'ERROR');
        return;
    }

    switch (msg.msg_type) {
        case 'authorize':
            isAuthorized = true;
            log(`Authorized: ${msg.authorize.email} (Balance: $${msg.authorize.balance})`, 'SUCCESS');
            CONFIG.currency = msg.authorize.currency;

            sendTelegramMessage(`🚀 <b>Bot Connected & Authorized</b>\n<b>Account:</b> ${msg.authorize.email}\n<b>Balance:</b> $${msg.authorize.balance}\n<b>Capital:</b> $${CONFIG.INVESTMENT_CAPITAL}`);

            startStrategyLoop();
            break;
        case 'proposal_open_contract':
            handleContractUpdate(msg.proposal_open_contract);
            break;
    }
}

function authorize() {
    sendRequest({ authorize: CONFIG.token });
}

// ========== API FUNCTIONS ==========

async function fetchCandles(symbol, granularity, count = 20) {
    try {
        const response = await sendRequestWithPromise({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: count,
            end: 'latest',
            granularity: granularity,
            style: 'candles'
        });
        return response.candles;
    } catch (error) {
        log(`[${symbol}] Error fetching candles: ${error.message}`, 'ERROR');
        return null;
    }
}

async function buyMultiplierContract(symbol) {
    try {
        const symbolState = strategyStates[symbol];

        const baseCapital = CONFIG.INVESTMENT_CAPITAL || CONFIG.stake;
        const stake = Math.max(baseCapital * (CONFIG.RISK_PERCENT / 100), 0.35).toFixed(2);

        log(`Requesting proposal...`, 'TRADE', symbol);

        const proposalResponse = await sendRequestWithPromise({
            proposal: 1,
            amount: parseFloat(stake),
            basis: 'stake',
            contract_type: 'MULTUP',
            currency: CONFIG.currency,
            symbol: symbol,
            multiplier: CONFIG.multiplier,
            limit_order: {
                stop_loss: CONFIG.stop_loss
            }
        });

        log(`Buying contract | Stake: $${stake}...`, 'TRADE', symbol);

        const buyResponse = await sendRequestWithPromise({
            buy: proposalResponse.proposal.id,
            price: parseFloat(stake)
        });

        const contractId = buyResponse.buy.contract_id;
        const buyPrice = parseFloat(buyResponse.buy.buy_price);

        log(`✅ TRADE OPENED - ID: ${contractId}, Entry: ${buyPrice.toFixed(2)}`, 'SUCCESS', symbol);

        currentTrades[contractId] = {
            id: contractId,
            symbol: symbol,
            entryPrice: buyPrice,
            entryTime: new Date(),
            tpZone: symbolState.tpZone,
            lastLogTime: 0
        };

        sessionStats.totalTrades++;

        sendTelegramMessage(`🚀 <b>TRADE OPENED</b> [${symbol}]\n━━━━━━━━━━━━━━━━━\n<b>ID:</b> ${contractId}\n<b>Stake:</b> $${stake}\n<b>Entry:</b> ${buyPrice.toFixed(2)}\n<b>TP Zone:</b> ${symbolState.tpZone.toFixed(2)}`);

        sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });

    } catch (error) {
        log(`Error buying contract: ${error.message}`, 'ERROR', symbol);
    }
}

function handleContractUpdate(contract) {
    if (!contract || !currentTrades[contract.contract_id]) return;

    const trade = currentTrades[contract.contract_id];
    const symbol = trade.symbol;
    const currentSpot = parseFloat(contract.current_spot);
    const profit = parseFloat(contract.profit || 0);

    if (Date.now() - trade.lastLogTime > 60000) { // Log every 1 minute
        log(`Contract ${contract.contract_id} | Spot: ${currentSpot.toFixed(5)} | P/L: ${profit.toFixed(2)}`, 'INFO', symbol);
        trade.lastLogTime = Date.now();
    }

    if (trade.tpZone && currentSpot >= trade.tpZone) {
        log(`🎯 TP ZONE REACHED | Current: ${currentSpot.toFixed(5)} | TP: ${trade.tpZone.toFixed(5)}`, 'TRADE', symbol);
        sellContract(contract.contract_id);
    }

    if (contract.is_sold) {
        const result = profit >= 0 ? 'WON' : 'LOST';
        log(`ℹ️ Contract CLOSED | ${result} | Profit: ${profit.toFixed(2)}`, result === 'WON' ? 'SUCCESS' : 'ERROR', symbol);

        if (profit >= 0) sessionStats.wins++;
        else sessionStats.losses++;
        sessionStats.totalPnL += profit;

        completedTrades.push({
            id: contract.contract_id,
            symbol: symbol,
            profit: profit,
            time: new Date()
        });

        sendTelegramMessage(`${profit >= 0 ? '🎉' : '😔'} <b>TRADE ${result}</b> [${symbol}]\n━━━━━━━━━━━━━━━━━\n<b>P/L:</b> $${profit.toFixed(2)}\n<b>Net P/L:</b> $${sessionStats.totalPnL.toFixed(2)}\n${getSessionSummary()}`);

        delete currentTrades[contract.contract_id];
    }
}

async function sellContract(contractId) {
    try {
        await sendRequestWithPromise({ sell: contractId, price: 0 });
    } catch (error) {
        log(`Error selling contract ${contractId}: ${error.message}`, 'ERROR');
    }
}

// ========== STRATEGY LOGIC ==========

async function analyzeDailyCandles(symbol) {
    const d1Candles = await fetchCandles(symbol, 86400, 2);
    if (!d1Candles || d1Candles.length < 2) {
        log('Insufficient D1 data', 'WARNING', symbol);
        return false;
    }
    strategyStates[symbol].dailyOpen = parseFloat(d1Candles[1].open);
    log(`D1 Analysis | Open: ${strategyStates[symbol].dailyOpen.toFixed(5)}`, 'STRATEGY', symbol);
    return true;
}

async function analyzeH4Trend(symbol) {
    const h4Candles = await fetchCandles(symbol, 14400, CONFIG.h4CandlesForTrend + 5);
    if (!h4Candles || h4Candles.length < CONFIG.h4CandlesForTrend) {
        log('Insufficient H4 data', 'WARNING', symbol);
        return false;
    }

    const recentCandles = h4Candles.slice(-4);
    const isUptrend = recentCandles.every((c, i) => i === 0 || parseFloat(c.close) > parseFloat(recentCandles[i - 1].close));

    const sma20 = calculateSMA(h4Candles, CONFIG.smaPeriod);
    const currentPrice = parseFloat(h4Candles[h4Candles.length - 1].close);
    const aboveSMA = sma20 ? currentPrice > sma20 : true;

    const tpCandles = h4Candles.slice(-CONFIG.h4CandlesForTP);
    strategyStates[symbol].tpZone = getHighestHigh(tpCandles);

    log(`H4 Analysis | Uptrend: ${isUptrend} | Above SMA: ${aboveSMA} | TP: ${strategyStates[symbol].tpZone.toFixed(2)}`, 'STRATEGY', symbol);
    return isUptrend && aboveSMA;
}

async function confirmH1Trend(symbol) {
    const h1Candles = await fetchCandles(symbol, 3600, CONFIG.h1CandlesForConfirm);
    if (!h1Candles || h1Candles.length < CONFIG.h1CandlesForConfirm) return false;
    const recentCandles = h1Candles.slice(-4);
    const confirmed = recentCandles.every((c, i) => i === 0 || parseFloat(c.close) >= parseFloat(recentCandles[i - 1].close) - 0.3);
    log(`H1 Confirmation: ${confirmed}`, 'STRATEGY', symbol);
    return confirmed;
}

async function checkM15Entry(symbol) {
    const m15Candles = await fetchCandles(symbol, 900, 5);
    if (!m15Candles || m15Candles.length < 2) return false;

    const latest = m15Candles[m15Candles.length - 1];
    const currentPrice = parseFloat(latest.close);
    const candleLow = parseFloat(latest.low);
    const dailyOpen = strategyStates[symbol].dailyOpen;

    const nearDailyOpen = Math.abs(currentPrice - dailyOpen) <= CONFIG.dailyOpenThreshold;
    const touchedDailyOpen = Math.abs(candleLow - dailyOpen) <= CONFIG.dailyOpenThreshold;
    const bullish = isBullishCandle(latest);

    log(`M15 Entry Check | Near Open: ${nearDailyOpen} | Touched: ${touchedDailyOpen} | Bullish: ${bullish}`, 'STRATEGY', symbol);
    return nearDailyOpen && bullish && touchedDailyOpen;
}

async function runStrategyCheckForSymbol(symbol) {
    if (!isRunning || !isAuthorized) return;

    try {
        const totalTrades = Object.keys(currentTrades).length;
        const symbolTrades = Object.values(currentTrades).filter(t => t.symbol === symbol).length;

        if (totalTrades >= CONFIG.maxTotalTrades) return;
        if (symbolTrades >= CONFIG.maxTradesPerSymbol) return;

        log(`Analyzing market...`, 'INFO', symbol);

        if (await analyzeDailyCandles(symbol)) {
            if (await analyzeH4Trend(symbol)) {
                if (await confirmH1Trend(symbol)) {
                    if (await checkM15Entry(symbol)) {
                        await buyMultiplierContract(symbol);
                    }
                }
            }
        }
    } catch (error) {
        log(`Strategy error: ${error.message}`, 'ERROR', symbol);
    }
}

async function startStrategyLoop() {
    log('🤖 Strategy monitoring active');

    const loop = async () => {
        if (!isRunning) return;

        log(`--- Periodic Market Scan (Active: ${Object.keys(currentTrades).length}) ---`, 'SYSTEM');

        // Parallel scan
        await Promise.all(activeSymbols.map(symbol => runStrategyCheckForSymbol(symbol)));

        setTimeout(loop, CONFIG.checkInterval);
    };

    loop();

    // Summary timer every 1 hour
    setInterval(() => {
        if (sessionStats.totalTrades > 0) {
            sendTelegramMessage(`📢 <b>Hourly Performance Update</b>\n${getSessionSummary()}`);
        }
    }, 60 * 60 * 1000);
}

// ========== MAIN ==========

async function startBot() {
    console.clear();
    log('=================================================', 'SYSTEM');
    log('  DERIV MULTI-ASSET TRADING BOT v3.5           ', 'SYSTEM');
    log('  Price Action Strategy + Multi-Symbol Monitoring', 'SYSTEM');
    log('=================================================', 'SYSTEM');

    initTelegram();

    activeSymbols = CONFIG.symbols.filter(s => s.enabled).map(s => s.name);
    activeSymbols.forEach(symbol => {
        strategyStates[symbol] = { lastCheckTime: 0 };
    });

    log(`Active Symbols: ${activeSymbols.join(', ')}`, 'SYSTEM');
    log(`Capital: $${CONFIG.INVESTMENT_CAPITAL} | Risk: ${CONFIG.RISK_PERCENT}%`, 'SYSTEM');
    log(`Interval: ${CONFIG.checkInterval / 1000}s | Limit: ${CONFIG.maxTotalTrades} trades`, 'SYSTEM');

    connect();

    process.on('SIGINT', async () => {
        log('🛑 Shutting down...', 'WARNING');
        isRunning = false;

        if (telegramBot) {
            await sendTelegramMessage(`🛑 <b>Bot Shutting Down</b>\n${getSessionSummary()}`);
        }

        setTimeout(() => {
            log('Bot offline.', 'SYSTEM');
            process.exit(0);
        }, 2000);
    });
}

startBot();
