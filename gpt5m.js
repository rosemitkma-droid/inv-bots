/**
 * VPEX-5 ML Deriv Scalping Bot
 * Logistic Regression + Telegram + Advanced Logging
 */

require("dotenv").config();
const WebSocket = require("ws");
const https = require("https");

// ================= CONFIG =================
const SYMBOL = "R_75";
const APP_ID = "1089";
const STAKE = 1;
const DURATION = 5;
const MAX_LOSSES = 5;
const ML_THRESHOLD = 0.9;

// ================= COLORS =================
const C = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
};

// ================= STATE =================
let ws;
let prices = [];
let ticks = [];
let losses = 0;
let tradeOpen = false;
let lastTradeTime = 0;

// Enhanced State for Trade Tracking
const STATE = {
    connected: false,
    authorized: false,
    balance: 0,
    currency: 'USD',
    loginId: '',
    isVirtual: true,
    activeTrade: null,
    completedTrades: [],
    dailyPnL: 0,
    totalTrades: 0,
    wins: 0,
    indicators: { rsi: null, ema20: null, ema50: null, mlProb: null }
};

// ================= TELEGRAM =================
const telegram = msg => {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
    const text = encodeURIComponent(msg);
    const url = `/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${process.env.TELEGRAM_CHAT_ID}&text=${text}`;
    https.get({ hostname: "api.telegram.org", path: url });
};

// ================= ENHANCED LOGGER =================
const Logger = {
    getTimestamp() {
        return new Date().toISOString().replace('T', ' ').substring(0, 19);
    },

    log(level, message, data = null) {
        const timestamp = this.getTimestamp();
        const icons = {
            DEBUG: '🔍',
            INFO: 'ℹ️ ',
            WARN: '⚠️ ',
            ERROR: '❌',
            SUCCESS: '✅',
            TRADE: '💹',
            SIGNAL: '📡',
            ML: '🤖'
        };
        const colors = {
            DEBUG: C.dim,
            INFO: C.blue,
            WARN: C.yellow,
            ERROR: C.red,
            SUCCESS: C.green,
            TRADE: C.magenta,
            SIGNAL: C.cyan,
            ML: C.magenta
        };

        const icon = icons[level] || '';
        const color = colors[level] || C.white;

        console.log(`${C.dim}[${timestamp}]${C.reset} ${color}[${level}]${C.reset} ${icon} ${message}`);

        if (data) {
            const dataStr = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
            console.log(`${C.dim}${dataStr}${C.reset}`);
        }
    },

    debug(msg, data) { this.log('DEBUG', msg, data); },
    info(msg, data) { this.log('INFO', msg, data); },
    warn(msg, data) { this.log('WARN', msg, data); },
    error(msg, data) { this.log('ERROR', msg, data); },
    success(msg, data) { this.log('SUCCESS', msg, data); },
    trade(msg, data) { this.log('TRADE', msg, data); },
    signal(msg, data) { this.log('SIGNAL', msg, data); },
    ml(msg, data) { this.log('ML', msg, data); },

    separator(title = '') {
        const line = '═'.repeat(60);
        console.log(`\n${C.cyan}${C.bright}${line}${C.reset}`);
        if (title) {
            console.log(`${C.cyan}${C.bright}  ${title}${C.reset}`);
            console.log(`${C.cyan}${C.bright}${line}${C.reset}`);
        }
    },

    displayBanner() {
        console.log(`
${C.cyan}${C.bright}╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🤖 VPEX-5 ML DERIV SCALPING BOT                          ║
║   Logistic Regression + EMA + RSI Strategy                 ║
║   Node.js Automated Trading System                         ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝${C.reset}
        `);
    },

    displayConfig() {
        this.separator('⚙️  CONFIGURATION');
        console.log(`  Symbol:           ${C.bright}${SYMBOL}${C.reset}`);
        console.log(`  Stake:            ${C.bright}$${STAKE}${C.reset}`);
        console.log(`  Duration:         ${C.bright}${DURATION} minutes${C.reset}`);
        console.log(`  Max Losses:       ${C.bright}${MAX_LOSSES}${C.reset}`);
        console.log(`  ML Threshold:     ${C.bright}${(ML_THRESHOLD * 100).toFixed(0)}%${C.reset}`);
        console.log(`  Telegram:         ${C.bright}${process.env.TELEGRAM_BOT_TOKEN ? 'Enabled' : 'Disabled'}${C.reset}`);
        console.log('');
    },

    displayAccount() {
        this.separator('💰 ACCOUNT INFO');
        const accType = STATE.isVirtual ? `${C.yellow}DEMO${C.reset}` : `${C.red}${C.bright}REAL${C.reset}`;
        console.log(`  Login ID:        ${C.bright}${STATE.loginId || 'N/A'}${C.reset}`);
        console.log(`  Account:         ${accType}`);
        console.log(`  Balance:         ${C.green}${C.bright}$${STATE.balance.toFixed(2)} ${STATE.currency}${C.reset}`);
        console.log('');
    },

    displayIndicators() {
        this.separator('📊 MARKET INDICATORS');
        const { rsi, ema20, ema50, mlProb } = STATE.indicators;
        const currentPrice = prices.length > 0 ? prices[prices.length - 1] : null;

        console.log(`  Current Price:   ${currentPrice ? currentPrice.toFixed(2) : '--'}`);
        console.log(`  EMA 20:          ${ema20 ? ema20.toFixed(2) : '--'}`);
        console.log(`  EMA 50:          ${ema50 ? ema50.toFixed(2) : '--'}`);
        console.log(`  RSI:             ${rsi ? rsi.toFixed(2) : '--'}`);
        console.log(`  ML Probability:  ${mlProb ? (mlProb * 100).toFixed(1) + '%' : '--'}`);

        if (ema20 && ema50) {
            const trend = ema20 > ema50 ? `${C.green}BULLISH${C.reset}` : `${C.red}BEARISH${C.reset}`;
            console.log(`  Trend:           ${trend}`);
        }

        // ML Signal Status
        if (mlProb !== null) {
            const mlStatus = mlProb >= ML_THRESHOLD
                ? `${C.green}READY (${(mlProb * 100).toFixed(1)}%)${C.reset}`
                : `${C.yellow}WAITING (${(mlProb * 100).toFixed(1)}%)${C.reset}`;
            console.log(`  ML Signal:       ${mlStatus}`);
        }
        console.log('');
    },

    displayActiveTrade() {
        this.separator(`🔥 ACTIVE TRADE`);

        if (!STATE.activeTrade) {
            console.log(`  ${C.dim}No active trade${C.reset}`);
        } else {
            const trade = STATE.activeTrade;
            const dirColor = trade.type === 'CALL' ? C.green : C.red;
            const dirIcon = trade.type === 'CALL' ? '🟢' : '🔴';
            const elapsed = Math.floor((Date.now() - trade.startTime) / 1000);

            console.log(`  ${dirIcon} ${dirColor}${C.bright}${trade.type}${C.reset} Trade`);
            console.log(`  ├─ Contract ID:  ${trade.contractId || 'Pending...'}`);
            console.log(`  ├─ Stake:        $${trade.stake}`);
            console.log(`  ├─ Started:      ${new Date(trade.startTime).toLocaleTimeString()}`);
            console.log(`  ├─ Elapsed:      ${elapsed}s`);
            console.log(`  └─ Status:       ${C.yellow}${trade.status}${C.reset}`);
        }
        console.log('');
    },

    displayCompletedTrades() {
        this.separator(`✅ COMPLETED TRADES (${STATE.completedTrades.length})`);

        if (STATE.completedTrades.length === 0) {
            console.log(`  ${C.dim}No completed trades${C.reset}`);
        } else {
            const recentTrades = STATE.completedTrades.slice(0, 10);
            recentTrades.forEach((trade, idx) => {
                const pnlColor = trade.profit >= 0 ? C.green : C.red;
                const resultIcon = trade.profit >= 0 ? '🎉' : '😢';
                const result = trade.profit >= 0 ? 'WIN' : 'LOSS';
                const dirIcon = trade.type === 'CALL' ? '🟢' : '🔴';
                console.log(`  ${C.bright}#${idx + 1}${C.reset} | ${dirIcon} ${trade.type} | ${resultIcon} ${result} | P&L: ${pnlColor}$${trade.profit.toFixed(2)}${C.reset} | ${new Date(trade.endTime).toLocaleTimeString()}`);
            });
        }
        console.log('');
    },

    displayStats() {
        this.separator('📈 SESSION STATISTICS');
        const pnlColor = STATE.dailyPnL >= 0 ? C.green : C.red;
        const winRate = STATE.totalTrades > 0
            ? ((STATE.wins / STATE.totalTrades) * 100).toFixed(1)
            : '0.0';

        const botStatus = tradeOpen
            ? `${C.magenta}IN TRADE${C.reset}`
            : losses >= MAX_LOSSES
                ? `${C.red}STOPPED (Max Losses)${C.reset}`
                : `${C.green}ACTIVE${C.reset}`;

        console.log(`  💰 Balance:            ${C.green}$${STATE.balance.toFixed(2)}${C.reset}`);
        console.log(`  📊 Daily P&L:          ${pnlColor}$${STATE.dailyPnL.toFixed(2)}${C.reset}`);
        console.log(`  🔢 Total Trades:       ${STATE.totalTrades}`);
        console.log(`  ✅ Wins:               ${STATE.wins}`);
        console.log(`  ❌ Losses:             ${losses} / ${MAX_LOSSES}`);
        console.log(`  🎯 Win Rate:           ${winRate}%`);
        console.log(`  🤖 Bot Status:         ${botStatus}`);
        console.log(`  ⏰ Last Trade:         ${lastTradeTime ? new Date(lastTradeTime).toLocaleTimeString() : 'Never'}`);
        console.log('');
    },

    displayAll() {
        console.clear();
        this.displayBanner();
        this.displayAccount();
        this.displayStats();
        this.displayIndicators();
        this.displayActiveTrade();
        this.displayCompletedTrades();
    }
};

// Legacy log function for compatibility
const log = (tag, msg) => {
    const levelMap = {
        'SYSTEM': 'INFO',
        'ANALYSIS': 'DEBUG',
        'TRADE': 'TRADE',
        'RESULT': 'SUCCESS',
        'ERROR': 'ERROR',
        'WARN': 'WARN'
    };
    Logger.log(levelMap[tag] || 'INFO', msg);
};

// ================= INDICATORS =================
const EMA = (data, period) => {
    if (data.length < period) return null;
    const k = 2 / (period + 1);
    return data.reduce((a, c, i) => (i ? c * k + a * (1 - k) : c));
};

const RSI = (data, period = 7) => {
    if (data.length < period + 1) return null;
    let g = 0, l = 0;
    for (let i = data.length - period; i < data.length - 1; i++) {
        let d = data[i + 1] - data[i];
        d >= 0 ? (g += d) : (l -= d);
    }
    let rs = g / (l || 1);
    return 100 - 100 / (1 + rs);
};

// ================= ML MODEL =================
let weights = [0, 0, 0, 0]; // Logistic Regression weights
let lr = 0.01;

const sigmoid = z => 1 / (1 + Math.exp(-z));

const predict = features =>
    sigmoid(features.reduce((s, x, i) => s + x * weights[i], 0));

const train = (features, outcome) => {
    let p = predict(features);
    features.forEach((x, i) => {
        weights[i] += lr * (outcome - p) * x;
    });
    Logger.ml(`Model updated | Weights: [${weights.map(w => w.toFixed(4)).join(', ')}]`);
};

// ================= FEATURES =================
const getFeatures = () => {
    const rsi = RSI(prices);
    const ema20 = EMA(prices.slice(-20), 20);
    const ema50 = EMA(prices.slice(-50), 50);
    let momentum =
        ticks.filter((v, i) => i && v > ticks[i - 1]).length / ticks.length;

    return [
        (rsi - 50) / 50,
        (ema20 - ema50) / prices.at(-1),
        momentum,
        Math.abs(prices.at(-1) - ema20) / prices.at(-1)
    ];
};

// ================= TRADE =================
const executeTrade = type => {
    tradeOpen = true;
    lastTradeTime = Date.now();

    // Create active trade record
    STATE.activeTrade = {
        type: type,
        stake: STAKE,
        startTime: Date.now(),
        status: 'PENDING',
        contractId: null
    };

    ws.send(JSON.stringify({
        buy: 1,
        price: STAKE,
        parameters: {
            amount: STAKE,
            basis: "stake",
            contract_type: type,
            duration: DURATION,
            duration_unit: "m",
            symbol: SYMBOL,
            currency: "USD"
        }
    }));

    telegram(`📈 TRADE EXECUTED\n${type} ${SYMBOL}\nStake: $${STAKE}`);
    Logger.trade(`Executed ${type} trade | Stake: $${STAKE} | Symbol: ${SYMBOL}`);
    Logger.displayActiveTrade();
};

// ================= WEBSOCKET =================
Logger.displayBanner();
Logger.displayConfig();

ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

ws.on("open", () => {
    STATE.connected = true;
    Logger.success('Connected to Deriv WebSocket');

    ws.send(JSON.stringify({ authorize: process.env.DERIV_TOKEN }));
    ws.send(JSON.stringify({ ticks: SYMBOL, subscribe: 1 }));

    telegram("🤖 VPEX-5 ML Bot Started");
    Logger.info("Bot connected & running");
    Logger.info(`Subscribed to ${SYMBOL} ticks`);
});

ws.on("error", (error) => {
    Logger.error(`WebSocket error: ${error.message}`);
});

ws.on("close", () => {
    STATE.connected = false;
    Logger.warn('WebSocket connection closed');
});

ws.on("message", msg => {
    const data = JSON.parse(msg);

    // ===== AUTHORIZATION =====
    if (data.authorize) {
        STATE.authorized = true;
        STATE.balance = parseFloat(data.authorize.balance);
        STATE.currency = data.authorize.currency;
        STATE.loginId = data.authorize.loginid;
        STATE.isVirtual = data.authorize.is_virtual === 1;

        Logger.success('Authorization successful');
        Logger.displayAccount();
        Logger.displayStats();
    }

    // ===== BALANCE UPDATE =====
    if (data.balance) {
        STATE.balance = parseFloat(data.balance.balance);
        Logger.debug(`Balance updated: $${STATE.balance.toFixed(2)}`);
    }

    // ===== TICK =====
    if (data.tick) {
        prices.push(data.tick.quote);
        ticks.push(data.tick.quote);

        if (prices.length > 100) prices.shift();
        if (ticks.length > 300) ticks.shift();

        if (
            prices.length >= 50 &&
            !tradeOpen &&
            losses < MAX_LOSSES &&
            Date.now() - lastTradeTime > 300000
        ) {
            const rsi = RSI(prices);
            const ema20 = EMA(prices.slice(-20), 20);
            const ema50 = EMA(prices.slice(-50), 50);
            const features = getFeatures();
            const prob = predict(features);

            // Update indicators in state
            STATE.indicators = { rsi, ema20, ema50, mlProb: prob };

            Logger.debug(
                `Analysis | RSI:${rsi?.toFixed(1) || '--'} EMA20:${ema20?.toFixed(2) || '--'} EMA50:${ema50?.toFixed(2) || '--'} ML:${(prob * 100).toFixed(1)}%`
            );

            if (prob >= ML_THRESHOLD) {
                Logger.signal(`ML Signal Ready | Probability: ${(prob * 100).toFixed(1)}%`);

                if (ema20 > ema50 && rsi < 30) {
                    Logger.signal('🟢 CALL Signal: EMA20 > EMA50 + RSI Oversold');
                    executeTrade("CALL");
                }
                if (ema20 < ema50 && rsi > 70) {
                    Logger.signal('🔴 PUT Signal: EMA20 < EMA50 + RSI Overbought');
                    executeTrade("PUT");
                }
            }
        }
    }

    // ===== BUY RESPONSE =====
    if (data.buy) {
        if (STATE.activeTrade) {
            STATE.activeTrade.contractId = data.buy.contract_id;
            STATE.activeTrade.status = 'OPEN';
        }
        Logger.success(`Contract purchased | ID: ${data.buy.contract_id}`);
        ws.send(JSON.stringify({ proposal_open_contract: 1, subscribe: 1 }));
        Logger.displayActiveTrade();
    }

    // ===== CONTRACT UPDATE =====
    if (data.proposal_open_contract) {
        const contract = data.proposal_open_contract;

        // Update active trade P&L
        if (STATE.activeTrade && contract.profit !== undefined) {
            STATE.activeTrade.currentPnL = parseFloat(contract.profit);
        }

        if (contract.is_sold) {
            tradeOpen = false;
            const profit = parseFloat(contract.profit);
            const win = profit > 0;
            const features = getFeatures();

            train(features, win ? 1 : 0);

            if (!win) {
                losses++;
            } else {
                STATE.wins++;
            }

            STATE.totalTrades++;
            STATE.dailyPnL += profit;

            // Record completed trade
            const completedTrade = {
                type: STATE.activeTrade?.type || 'UNKNOWN',
                stake: STAKE,
                profit: profit,
                startTime: STATE.activeTrade?.startTime || Date.now(),
                endTime: Date.now(),
                contractId: contract.contract_id
            };
            STATE.completedTrades.unshift(completedTrade);

            // Clear active trade
            STATE.activeTrade = null;

            telegram(
                win
                    ? `✅ WIN +$${profit.toFixed(2)}`
                    : `❌ LOSS -$${Math.abs(profit).toFixed(2)}`
            );

            if (win) {
                Logger.success(`Trade WON! Profit: +$${profit.toFixed(2)}`);
            } else {
                Logger.warn(`Trade LOST! Loss: $${profit.toFixed(2)}`);
            }

            // Display updated stats
            Logger.displayCompletedTrades();
            Logger.displayStats();

            if (losses >= MAX_LOSSES) {
                Logger.error(`Max losses (${MAX_LOSSES}) reached - Bot stopping`);
                telegram(`🛑 Bot stopped: Max losses reached (${MAX_LOSSES})`);
            }
        }
    }

    // ===== ERROR HANDLING =====
    if (data.error) {
        Logger.error(`API Error: ${data.error.message}`, data.error);

        if (STATE.activeTrade) {
            STATE.activeTrade.status = 'ERROR';
            STATE.activeTrade = null;
            tradeOpen = false;
        }
    }
});

// ================= PERIODIC DISPLAY =================
setInterval(() => {
    if (STATE.connected && prices.length >= 50) {
        Logger.displayIndicators();
    }
}, 60000); // Display indicators every minute

// ================= GRACEFUL SHUTDOWN =================
process.on('SIGINT', () => {
    console.log('\n');
    Logger.warn('Shutting down bot...');

    if (STATE.activeTrade) {
        Logger.warn('Active trade will continue on Deriv');
    }

    Logger.displayStats();
    Logger.displayCompletedTrades();

    if (ws) {
        ws.close();
    }

    process.exit(0);
});

process.on('unhandledRejection', (error) => {
    Logger.error('Unhandled rejection', error.message || error);
});

Logger.info('Waiting for market data...');
