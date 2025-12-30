/**
 * ================================================================
 * DERIV MULTI-ASSET ALGORITHMIC TRADING BOT
 * Strategy: Breakout & Retest (Multi-Timeframe Analysis)
 * ================================================================
 * 
 * DISCLAIMER: Trading involves significant risk. This bot is for 
 * educational purposes. Test thoroughly on a demo account first.
 * 
 * Author: Expert Algorithmic Trading Developer
 * Version: 2.0.0 - Multi-Asset Support
 * ================================================================
 * 
 * USAGE:
 *   node deriv-multi-asset-bot.js
 * 
 * REQUIREMENTS:
 *   npm install ws
 * 
 * ================================================================
 */

const WebSocket = require('ws');
const fs = require('fs');
const readline = require('readline');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// ================================================================
// CONFIGURATION SECTION
// ================================================================

const CONFIG = {
    // API Credentials
    API_TOKEN: 'Dz2V2KvRf4Uukt3', // Get from https://app.deriv.com/account/api-token
    APP_ID: '1089', // Default Deriv App ID

    // Available Synthetic Indices
    AVAILABLE_SYMBOLS: [
        { symbol: 'R_10', name: 'Volatility 10 Index', volatility: 10 },
        { symbol: 'R_25', name: 'Volatility 25 Index', volatility: 25 },
        { symbol: 'R_50', name: 'Volatility 50 Index', volatility: 50 },
        { symbol: 'R_75', name: 'Volatility 75 Index', volatility: 75 },
        { symbol: 'R_100', name: 'Volatility 100 Index', volatility: 100 },
        // { symbol: '1HZ10V', name: 'Volatility 10 (1s) Index', volatility: 10 },
        // { symbol: '1HZ25V', name: 'Volatility 25 (1s) Index', volatility: 25 },
        // { symbol: '1HZ50V', name: 'Volatility 50 (1s) Index', volatility: 50 },
        // { symbol: '1HZ75V', name: 'Volatility 75 (1s) Index', volatility: 75 },
        // { symbol: '1HZ100V', name: 'Volatility 100 (1s) Index', volatility: 100 },
    ],

    // Symbols to Trade (select from AVAILABLE_SYMBOLS)
    ACTIVE_SYMBOLS: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'], // Add/remove symbols as needed

    // Trading Parameters
    STAKE_AMOUNT: 1, // Initial stake in USD
    DURATION: 5, // Contract duration
    DURATION_UNIT: 't', // 't' for ticks, 's' for seconds, 'm' for minutes

    // Risk Management
    STOP_LOSS: 10, // Stop loss in USD per asset (0 to disable)
    TAKE_PROFIT: 20, // Take profit in USD per asset (0 to disable)
    MAX_DAILY_LOSS: 50, // Maximum daily loss before stopping (0 to disable)
    MAX_CONCURRENT_TRADES: 3, // Maximum simultaneous trades across all assets

    // Martingale Settings
    USE_MARTINGALE: false, // Enable/disable martingale
    MARTINGALE_MULTIPLIER: 2, // Stake multiplier after loss
    MAX_MARTINGALE_STEPS: 3, // Maximum consecutive martingale steps

    // Strategy Parameters
    TOLERANCE_PIPS: 0.0005, // Price tolerance for retest detection
    MA_PERIOD: 20, // Moving Average period for trend detection
    H4_LOOKBACK: 5, // Number of H4 candles to analyze
    TRADE_COOLDOWN: 30000, // Cooldown between trades per asset (ms)

    // Bot Settings
    WEBSOCKET_URL: 'wss://ws.derivws.com/websockets/v3',
    RECONNECT_DELAY: 5000, // Milliseconds
    ENABLE_FILE_LOGGING: false,
    LOG_FILE: 'trading_log.txt',
    ENABLE_COLORS: true,

    // Investment Management
    INVESTMENT_CAPITAL: process.env.INITIAL_CAPITAL ? parseFloat(process.env.INITIAL_CAPITAL) : 100,
    RISK_PERCENT: 1, // 1% risk per trade

    // Telegram Configuration
    TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN6,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
};

// ================================================================
// GLOBAL STATE
// ================================================================

let ws = null;
let isConnected = false;
let isAuthorized = false;
let isBotRunning = true;
let requestId = 1;
let telegramBot = null;

// Per-asset trading state
const assetStates = new Map();

// Global state
let currentBalance = 0;
let dailyPnL = 0;
let sessionStats = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    realizedPnL: 0,
    startBalance: 0,
    startTime: new Date()
};

// Active positions tracking (global)
const activePositions = new Map();

// Pending proposals
const pendingProposals = new Map();

// = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =
// TELEGRAM UTILITIES
// = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =

function initTelegram() {
    if (CONFIG.TELEGRAM_TOKEN && CONFIG.TELEGRAM_CHAT_ID) {
        telegramBot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });
        log('📱 Telegram notifications enabled', 'INFO');
    } else {
        log('📱 Telegram notifications disabled (missing API keys)', 'WARNING');
    }
}

async function sendTelegramMessage(message) {
    if (!telegramBot) return;
    try {
        await telegramBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
    } catch (error) {
        log(`Failed to send Telegram message: ${error.message}`, 'ERROR');
    }
}

function getTelegramSummary() {
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
� <b>Win Rate:</b> ${winRate}%
💰 <b>Session P/L:</b> ${sessionStats.realizedPnL >= 0 ? '+' : ''}$${formatNumber(sessionStats.realizedPnL)}
    `;
}

// = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =
// UTILITY FUNCTIONS
// = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = = =

/**
 * Sleep function for async delays
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format number with fixed decimals
 */
function formatNumber(num, decimals = 2) {
    return parseFloat(num).toFixed(decimals);
}

/**
 * Get current timestamp string
 */
function getTimestamp() {
    return new Date().toISOString();
}

// ================================================================
// LOGGING SYSTEM
// ================================================================

const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',

    // Foreground colors
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',

    // Background colors
    bgBlack: '\x1b[40m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
    bgWhite: '\x1b[47m'
};

const LOG_STYLES = {
    INFO: { color: COLORS.cyan, prefix: 'ℹ' },
    SUCCESS: { color: COLORS.green, prefix: '✓' },
    WARNING: { color: COLORS.yellow, prefix: '⚠' },
    ERROR: { color: COLORS.red, prefix: '✗' },
    TRADE: { color: COLORS.magenta, prefix: '💰' },
    STRATEGY: { color: COLORS.blue, prefix: '📊' },
    SYSTEM: { color: COLORS.white, prefix: '⚙' },
    ASSET: { color: COLORS.yellow, prefix: '📈' }
};

/**
 * Advanced logging function with console and file output
 */
function log(message, type = 'INFO', symbol = null) {
    const timestamp = getTimestamp();
    const style = LOG_STYLES[type] || LOG_STYLES.INFO;
    const symbolTag = symbol ? `[${symbol}]` : '';

    const plainMessage = `[${timestamp}] [${type}]${symbolTag} ${message}`;

    // Console output with colors
    if (CONFIG.ENABLE_COLORS) {
        const coloredMessage = `${COLORS.dim}[${timestamp}]${COLORS.reset} ${style.color}${COLORS.bright}[${type}]${COLORS.reset}${COLORS.yellow}${symbolTag}${COLORS.reset} ${style.color}${style.prefix} ${message}${COLORS.reset}`;
        console.log(coloredMessage);
    } else {
        console.log(plainMessage);
    }

    // File output
    if (CONFIG.ENABLE_FILE_LOGGING) {
        try {
            fs.appendFileSync(CONFIG.LOG_FILE, plainMessage + '\n');
        } catch (err) {
            // Silently fail for file logging errors
        }
    }
}

/**
 * Log separator for better readability
 */
function logSeparator(char = '═', length = 80) {
    const separator = char.repeat(length);
    console.log(`${COLORS.dim}${separator}${COLORS.reset}`);

    if (CONFIG.ENABLE_FILE_LOGGING) {
        try {
            fs.appendFileSync(CONFIG.LOG_FILE, separator + '\n');
        } catch (err) { }
    }
}

/**
 * Log a boxed header
 */
function logHeader(title) {
    const padding = Math.floor((76 - title.length) / 2);
    const paddedTitle = ' '.repeat(padding) + title + ' '.repeat(padding);

    console.log();
    logSeparator('═');
    console.log(`${COLORS.bright}${COLORS.cyan}║${paddedTitle}║${COLORS.reset}`);
    logSeparator('═');
    console.log();
}

/**
 * Log asset status table
 */
function logAssetStatusTable() {
    console.log();
    console.log(`${COLORS.bright}${COLORS.white}┌────────────┬──────────┬──────────────┬──────────────┬─────────┐${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.white}│   Symbol   │  Trend   │  Daily Low   │ Daily Close  │  Ready  │${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.white}├────────────┼──────────┼──────────────┼──────────────┼─────────┤${COLORS.reset}`);

    for (const [symbol, state] of assetStates) {
        const trend = state.h4Trend || 'N/A';
        const trendColor = trend === 'BULLISH' ? COLORS.green : trend === 'BEARISH' ? COLORS.red : COLORS.yellow;
        const dailyLow = state.dailyLevels?.previousLow ? formatNumber(state.dailyLevels.previousLow, 5) : 'N/A';
        const dailyClose = state.dailyLevels?.previousClose ? formatNumber(state.dailyLevels.previousClose, 5) : 'N/A';
        const ready = state.isReady ? `${COLORS.green}YES${COLORS.reset}` : `${COLORS.red}NO${COLORS.reset}`;

        console.log(`${COLORS.white}│ ${symbol.padEnd(10)} │ ${trendColor}${trend.padEnd(8)}${COLORS.reset} │ ${dailyLow.padEnd(12)} │ ${dailyClose.padEnd(12)} │  ${ready}    │`);
    }

    console.log(`${COLORS.bright}${COLORS.white}└────────────┴──────────┴──────────────┴──────────────┴─────────┘${COLORS.reset}`);
    console.log();
}

/**
 * Log session statistics
 */
function logSessionStats() {
    const winRate = sessionStats.totalTrades > 0
        ? (sessionStats.wins / sessionStats.totalTrades * 100).toFixed(2)
        : 0;
    const netPnL = sessionStats.realizedPnL;
    const runtime = Math.floor((Date.now() - sessionStats.startTime) / 1000 / 60);

    console.log();
    console.log(`${COLORS.bright}${COLORS.cyan}╔══════════════════════════════════════════════════════════════════════════════╗${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║                            SESSION STATISTICS                                ║${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}╠══════════════════════════════════════════════════════════════════════════════╣${COLORS.reset}`);
    console.log(`${COLORS.cyan}║${COLORS.reset}  Runtime: ${runtime} minutes                                                        ${COLORS.cyan}║${COLORS.reset}`);
    console.log(`${COLORS.cyan}║${COLORS.reset}  Balance: $${formatNumber(currentBalance)}                                                             ${COLORS.cyan}║${COLORS.reset}`);
    console.log(`${COLORS.cyan}║${COLORS.reset}  Session P&L: ${netPnL >= 0 ? COLORS.green + '+' : COLORS.red}$${formatNumber(Math.abs(netPnL))}${COLORS.reset}                                                            ${COLORS.cyan}║${COLORS.reset}`);
    console.log(`${COLORS.cyan}║${COLORS.reset}  Trades: ${sessionStats.totalTrades}  |  Wins: ${COLORS.green}${sessionStats.wins}${COLORS.reset}  |  Losses: ${COLORS.red}${sessionStats.losses}${COLORS.reset}  |  Win Rate: ${winRate}%           ${COLORS.cyan}║${COLORS.reset}`);
    console.log(`${COLORS.cyan}║${COLORS.reset}  Active Positions: ${activePositions.size} / ${CONFIG.MAX_CONCURRENT_TRADES}                                            ${COLORS.cyan}║${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}╚══════════════════════════════════════════════════════════════════════════════╝${COLORS.reset}`);
    console.log();
}

// ================================================================
// ASSET STATE MANAGEMENT
// ================================================================

/**
 * Initialize state for each active asset
 */
function initializeAssetStates() {
    for (const symbol of CONFIG.ACTIVE_SYMBOLS) {
        const assetInfo = CONFIG.AVAILABLE_SYMBOLS.find(a => a.symbol === symbol);

        if (!assetInfo) {
            log(`Unknown symbol: ${symbol}. Skipping...`, 'WARNING');
            continue;
        }

        assetStates.set(symbol, {
            symbol: symbol,
            name: assetInfo.name,
            volatility: assetInfo.volatility,

            // Strategy state
            dailyLevels: {
                previousLow: null,
                previousClose: null,
                date: null
            },
            h4Trend: null,
            currentPrice: null,

            // Trading state
            isReady: false,
            hasActivePosition: false,
            currentStake: CONFIG.STAKE_AMOUNT,
            consecutiveLosses: 0,
            lastTradeTime: 0,

            // Statistics per asset
            stats: {
                trades: 0,
                wins: 0,
                losses: 0,
                pnl: 0
            }
        });

        log(`Initialized state for ${symbol} (${assetInfo.name})`, 'ASSET', symbol);
    }
}

/**
 * Get asset state
 */
function getAssetState(symbol) {
    return assetStates.get(symbol);
}

/**
 * Update asset state
 */
function updateAssetState(symbol, updates) {
    const state = assetStates.get(symbol);
    if (state) {
        Object.assign(state, updates);
    }
}

// ================================================================
// WEBSOCKET CONNECTION MANAGEMENT
// ================================================================

/**
 * Initialize WebSocket connection
 */
function connect() {
    log('Initiating WebSocket connection to Deriv API...', 'SYSTEM');

    ws = new WebSocket(`${CONFIG.WEBSOCKET_URL}?app_id=${CONFIG.APP_ID}`);

    ws.on('open', onOpen);
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
}

/**
 * Handle WebSocket connection open
 */
function onOpen() {
    isConnected = true;
    log('WebSocket connection established successfully!', 'SUCCESS');
    authorize();
}

/**
 * Handle incoming WebSocket messages
 */
function onMessage(data) {
    try {
        const response = JSON.parse(data);

        // Handle errors
        if (response.error) {
            handleError(response.error, response.echo_req);
            return;
        }

        // Route to appropriate handler
        switch (response.msg_type) {
            case 'authorize':
                handleAuthorize(response);
                break;
            case 'balance':
                handleBalance(response);
                break;
            case 'ticks_history':
            case 'candles':
                handleTicksHistory(response);
                break;
            case 'tick':
                handleTick(response);
                break;
            case 'proposal':
                handleProposal(response);
                break;
            case 'buy':
                handleBuy(response);
                break;
            case 'proposal_open_contract':
                handleContractUpdate(response);
                break;
        }

    } catch (err) {
        log(`Error parsing WebSocket message: ${err.message}`, 'ERROR');
    }
}

/**
 * Handle WebSocket close
 */
function onClose() {
    isConnected = false;
    isAuthorized = false;

    if (isBotRunning) {
        log(`WebSocket connection closed. Reconnecting in ${CONFIG.RECONNECT_DELAY / 1000}s...`, 'WARNING');
        setTimeout(connect, CONFIG.RECONNECT_DELAY);
    }
}

/**
 * Handle WebSocket errors
 */
function onError(error) {
    log(`WebSocket error: ${error.message}`, 'ERROR');
}

/**
 * Handle API errors
 */
function handleError(error, echoReq = null) {
    const symbol = echoReq?.ticks_history || echoReq?.ticks || echoReq?.symbol || null;
    log(`API Error [${error.code}]: ${error.message}`, 'ERROR', symbol);

    if (error.code === 'InvalidToken') {
        log('Invalid API token. Please check your configuration.', 'ERROR');
        shutdown();
    }
}

// ================================================================
// API REQUESTS
// ================================================================

/**
 * Send API request
 */
function sendRequest(request) {
    if (!isConnected) {
        log('Cannot send request: WebSocket not connected', 'ERROR');
        return null;
    }

    const reqId = requestId++;
    request.req_id = reqId;
    ws.send(JSON.stringify(request));
    return reqId;
}

/**
 * Authorize with API token
 */
function authorize() {
    log('Authorizing with API token...', 'SYSTEM');
    sendRequest({
        authorize: CONFIG.API_TOKEN
    });
}

/**
 * Subscribe to balance updates
 */
function subscribeBalance() {
    sendRequest({
        balance: 1,
        subscribe: 1
    });
}

/**
 * Get candles for a specific symbol and timeframe
 */
function getCandles(symbol, granularity, count) {
    sendRequest({
        ticks_history: symbol,
        adjust_start_time: 1,
        count: count,
        end: 'latest',
        granularity: granularity,
        style: 'candles'
    });
}

/**
 * Subscribe to tick stream for a symbol
 */
function subscribeTicks(symbol) {
    sendRequest({
        ticks: symbol,
        subscribe: 1
    });
    log(`Subscribed to tick stream`, 'INFO', symbol);
}

/**
 * Request a trade proposal
 */
function requestProposal(symbol, type, stake) {
    const reqId = sendRequest({
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: type,
        currency: 'USD',
        duration: CONFIG.DURATION,
        duration_unit: CONFIG.DURATION_UNIT,
        symbol: symbol
    });

    // Store pending proposal info
    pendingProposals.set(reqId, { symbol, type, stake });

    log(`Requesting ${type} proposal | Stake: $${formatNumber(stake)}`, 'TRADE', symbol);
}

/**
 * Buy a contract
 */
function buyContract(proposalId, price) {
    sendRequest({
        buy: proposalId,
        price: price
    });
}

// ================================================================
// RESPONSE HANDLERS
// ================================================================

/**
 * Handle authorization response
 */
function handleAuthorize(response) {
    if (response.authorize) {
        isAuthorized = true;
        currentBalance = response.authorize.balance;
        sessionStats.startBalance = currentBalance;

        log('Authorization successful!', 'SUCCESS');
        log(`Account: ${response.authorize.email}`, 'INFO');
        log(`Balance: $${formatNumber(currentBalance)} ${response.authorize.currency}`, 'INFO');
        log(`Account Type: ${response.authorize.is_virtual ? 'DEMO' : 'REAL'}`, 'INFO');

        logSeparator();

        // Initialize and start trading
        subscribeBalance();
        initializeAssetStates();
        initializeStrategies();

        sendTelegramMessage(`🚀 <b>Bot Connected & Authorized</b>\n<b>Account:</b> ${response.authorize.email}\n<b>Balance:</b> $${formatNumber(currentBalance)}\n<b>Capital:</b> $${CONFIG.INVESTMENT_CAPITAL}`);
    }
}

/**
 * Handle balance updates
 */
function handleBalance(response) {
    const oldBalance = currentBalance;
    currentBalance = response.balance.balance;

    if (oldBalance !== 0 && oldBalance !== currentBalance) {
        const change = currentBalance - oldBalance;
        const changeStr = change > 0 ? `+$${formatNumber(change)}` : `-$${formatNumber(Math.abs(change))}`;
        log(`Balance: $${formatNumber(currentBalance)} (${changeStr})`, 'INFO');
    }

    // Check daily loss limit
    if (CONFIG.MAX_DAILY_LOSS > 0 && dailyPnL < -CONFIG.MAX_DAILY_LOSS) {
        log(`Daily loss limit reached ($${formatNumber(Math.abs(dailyPnL))}). Stopping bot.`, 'ERROR');
        shutdown();
    }
}

/**
 * Handle candles/ticks_history response
 */
function handleTicksHistory(response) {
    if (!response.candles || !response.echo_req) return;

    const symbol = response.echo_req.ticks_history;
    const candles = response.candles;

    if (candles.length < 2) return;

    const granularity = candles[1].epoch - candles[0].epoch;

    if (granularity === 86400) {
        handleDailyCandles(symbol, candles);
    } else if (granularity === 14400) {
        handleH4Candles(symbol, candles);
    }
}

/**
 * Handle tick updates
 */
function handleTick(response) {
    const tick = response.tick;
    const symbol = tick.symbol;
    const state = getAssetState(symbol);

    if (!state) return;

    state.currentPrice = tick.quote;

    // Check for trading opportunities
    if (state.isReady && isBotRunning) {
        checkForRetestOpportunity(symbol, tick.quote);
    }
}

/**
 * Handle proposal response
 */
function handleProposal(response) {
    if (response.proposal) {
        const proposal = response.proposal;
        const pendingInfo = pendingProposals.get(response.req_id);

        if (pendingInfo) {
            const state = getAssetState(pendingInfo.symbol);

            if (state && !state.hasActivePosition) {
                log(`Proposal received | ID: ${proposal.id} | Payout: $${formatNumber(proposal.payout)}`, 'TRADE', pendingInfo.symbol);
                buyContract(proposal.id, proposal.ask_price);
            }

            pendingProposals.delete(response.req_id);
        }
    }
}

/**
 * Handle buy response
 */
function handleBuy(response) {
    if (response.buy) {
        const contract = response.buy;
        const symbol = response.echo_req.symbol;
        const state = getAssetState(symbol);

        // Store position
        activePositions.set(contract.contract_id, {
            id: contract.contract_id,
            symbol: symbol,
            type: contract.contract_type,
            stake: contract.buy_price,
            payout: contract.payout,
            openTime: new Date()
        });

        if (state) {
            state.hasActivePosition = true;
            state.stats.trades++;
        }

        sessionStats.totalTrades++;

        log(`Trade OPENED | Type: ${contract.contract_type} | Stake: $${formatNumber(contract.buy_price)} | Payout: $${formatNumber(contract.payout)}`, 'SUCCESS', symbol);

        sendTelegramMessage(`🚀 <b>TRADE OPENED</b> [${symbol}]\n━━━━━━━━━━━━━━━━━\n<b>Type:</b> ${contract.contract_type}\n<b>Stake:</b> $${formatNumber(contract.buy_price)}\n<b>Payout:</b> $${formatNumber(contract.payout)}`);

        // Subscribe to contract updates
        sendRequest({
            proposal_open_contract: 1,
            contract_id: contract.contract_id,
            subscribe: 1
        });
    }
}

/**
 * Handle contract updates
 */
function handleContractUpdate(response) {
    const contract = response.proposal_open_contract;

    if (!contract.is_sold) return;

    const position = activePositions.get(contract.contract_id);
    if (!position) return;

    const profit = contract.profit;
    const isWin = profit > 0;
    const state = getAssetState(position.symbol);

    if (isWin) {
        sessionStats.wins++;

        if (state) {
            state.stats.wins++;
            state.stats.pnl += profit;
            state.consecutiveLosses = 0;
            state.currentStake = CONFIG.STAKE_AMOUNT;
        }

        log(`🎉 TRADE WON! | Profit: +$${formatNumber(profit)}`, 'SUCCESS', position.symbol);
    } else {
        sessionStats.losses++;

        if (state) {
            state.stats.losses++;
            state.stats.pnl += profit;
            state.consecutiveLosses++;

            // Apply martingale if enabled
            if (CONFIG.USE_MARTINGALE && state.consecutiveLosses <= CONFIG.MAX_MARTINGALE_STEPS) {
                state.currentStake *= CONFIG.MARTINGALE_MULTIPLIER;
                log(`Martingale step ${state.consecutiveLosses}: New stake = $${formatNumber(state.currentStake)}`, 'WARNING', position.symbol);
            } else {
                state.currentStake = CONFIG.STAKE_AMOUNT;
                if (state.consecutiveLosses > CONFIG.MAX_MARTINGALE_STEPS) {
                    log(`Max martingale steps reached. Resetting stake.`, 'WARNING', position.symbol);
                }
            }
        }

        log(`❌ TRADE LOST | Loss: -$${formatNumber(Math.abs(profit))}`, 'ERROR', position.symbol);
    }

    // Update global session stats
    sessionStats.realizedPnL += profit;
    dailyPnL = sessionStats.realizedPnL; // Sync dailyPnL with session PnL for risk checks

    sendTelegramMessage(`${profit >= 0 ? '🎉' : '😔'} <b>TRADE ${isWin ? 'WON' : 'LOST'}</b> [${position.symbol}]\n━━━━━━━━━━━━━━━━━\n<b>P/L:</b> $${formatNumber(profit)}\n<b>Session P/L:</b> $${formatNumber(sessionStats.realizedPnL)}\n${getTelegramSummary()}`);

    // Clean up
    if (state) {
        state.hasActivePosition = false;
    }
    activePositions.delete(contract.contract_id);

    // Log statistics
    logSessionStats();
}

// ================================================================
// STRATEGY IMPLEMENTATION
// ================================================================

/**
 * Initialize strategies for all active assets
 */
async function initializeStrategies() {
    logHeader('INITIALIZING BREAKOUT & RETEST STRATEGY');

    log(`Active Symbols: ${CONFIG.ACTIVE_SYMBOLS.join(', ')}`, 'STRATEGY');
    log(`Stake Amount: $${CONFIG.STAKE_AMOUNT}`, 'STRATEGY');
    log(`Martingale: ${CONFIG.USE_MARTINGALE ? 'ENABLED' : 'DISABLED'}`, 'STRATEGY');
    log(`Max Concurrent Trades: ${CONFIG.MAX_CONCURRENT_TRADES}`, 'STRATEGY');

    logSeparator('-');

    // Step 1: Fetch daily levels for all assets
    log('STEP 1: Fetching Daily Support/Resistance levels...', 'STRATEGY');

    for (const symbol of CONFIG.ACTIVE_SYMBOLS) {
        if (assetStates.has(symbol)) {
            getCandles(symbol, 86400, 2);
            await sleep(500); // Stagger requests
        }
    }

    // Wait for daily data, then fetch H4
    await sleep(3000);

    // Step 2: Fetch H4 trend data
    log('STEP 2: Analyzing 4-Hour trend for all assets...', 'STRATEGY');

    for (const symbol of CONFIG.ACTIVE_SYMBOLS) {
        const state = getAssetState(symbol);
        if (state && state.dailyLevels.previousLow) {
            getCandles(symbol, 14400, CONFIG.H4_LOOKBACK + 1);
            await sleep(500);
        }
    }

    // Wait for H4 data
    await sleep(3000);

    // Step 3: Subscribe to ticks for ready assets
    log('STEP 3: Subscribing to tick streams...', 'STRATEGY');

    for (const symbol of CONFIG.ACTIVE_SYMBOLS) {
        const state = getAssetState(symbol);
        if (state && state.h4Trend) {
            subscribeTicks(symbol);
            state.isReady = true;
            await sleep(300);
        }
    }

    logSeparator();
    logAssetStatusTable();

    log('Strategy initialization complete. Monitoring for entry signals...', 'SUCCESS');
    logSeparator();

    // Start periodic status updates
    setInterval(() => {
        if (isBotRunning && isConnected) {
            logSessionStats();
        }
    }, 60000); // Every minute
}

/**
 * Process Daily candles - Extract support/resistance
 */
function handleDailyCandles(symbol, candles) {
    if (candles.length < 2) {
        log('Insufficient daily candles', 'WARNING', symbol);
        return;
    }

    const state = getAssetState(symbol);
    if (!state) return;

    // Get previous day's candle
    const previousDay = candles[candles.length - 2];

    state.dailyLevels = {
        previousLow: parseFloat(previousDay.low),
        previousClose: parseFloat(previousDay.close),
        date: new Date(previousDay.epoch * 1000).toLocaleDateString()
    };

    log(`Daily Levels | Low: ${formatNumber(state.dailyLevels.previousLow, 5)} | Close: ${formatNumber(state.dailyLevels.previousClose, 5)}`, 'STRATEGY', symbol);
}

/**
 * Process H4 candles - Determine trend
 */
function handleH4Candles(symbol, candles) {
    if (candles.length < CONFIG.H4_LOOKBACK) {
        log('Insufficient H4 candles', 'WARNING', symbol);
        return;
    }

    const state = getAssetState(symbol);
    if (!state) return;

    const recentCandles = candles.slice(-CONFIG.H4_LOOKBACK);
    const closePrices = recentCandles.map(c => parseFloat(c.close));

    // Calculate simple moving average
    const ma = closePrices.reduce((a, b) => a + b, 0) / closePrices.length;
    const currentClose = closePrices[closePrices.length - 1];
    const oldClose = closePrices[0];

    // Determine trend
    if (currentClose > ma && currentClose > oldClose) {
        state.h4Trend = 'BULLISH';
    } else if (currentClose < ma && currentClose < oldClose) {
        state.h4Trend = 'BEARISH';
    } else {
        state.h4Trend = 'NEUTRAL';
    }

    const trendEmoji = state.h4Trend === 'BULLISH' ? '📈' : state.h4Trend === 'BEARISH' ? '📉' : '➡️';
    log(`H4 Trend: ${trendEmoji} ${state.h4Trend} | MA: ${formatNumber(ma, 5)} | Close: ${formatNumber(currentClose, 5)}`, 'STRATEGY', symbol);
}

/**
 * Check for retest opportunity
 */
function checkForRetestOpportunity(symbol, currentPrice) {
    const state = getAssetState(symbol);

    if (!state || !state.dailyLevels.previousLow || !state.h4Trend) return;
    if (state.h4Trend === 'NEUTRAL') return;
    if (state.hasActivePosition) return;

    // Check cooldown
    const now = Date.now();
    if (now - state.lastTradeTime < CONFIG.TRADE_COOLDOWN) return;

    // Check max concurrent trades
    if (activePositions.size >= CONFIG.MAX_CONCURRENT_TRADES) return;

    const { previousLow, previousClose } = state.dailyLevels;

    // Check if price is near key levels
    const nearPreviousLow = Math.abs(currentPrice - previousLow) <= CONFIG.TOLERANCE_PIPS;
    const nearPreviousClose = Math.abs(currentPrice - previousClose) <= CONFIG.TOLERANCE_PIPS;

    // BULLISH SETUP
    if (state.h4Trend === 'BULLISH' && (nearPreviousLow || nearPreviousClose)) {
        log(`🎯 BULLISH RETEST at ${formatNumber(currentPrice, 5)}`, 'STRATEGY', symbol);
        executeTrade(symbol, 'CALL');
    }

    // BEARISH SETUP
    if (state.h4Trend === 'BEARISH' && (nearPreviousLow || nearPreviousClose)) {
        log(`🎯 BEARISH RETEST at ${formatNumber(currentPrice, 5)}`, 'STRATEGY', symbol);
        executeTrade(symbol, 'PUT');
    }
}

/**
 * Execute trade
 */
function executeTrade(symbol, type) {
    const state = getAssetState(symbol);

    if (!state) return;
    if (state.hasActivePosition) {
        log('Trade already active for this asset', 'WARNING', symbol);
        return;
    }
    if (activePositions.size >= CONFIG.MAX_CONCURRENT_TRADES) {
        log('Maximum concurrent trades reached', 'WARNING', symbol);
        return;
    }

    state.lastTradeTime = Date.now();

    logSeparator('-');
    log(`Executing ${type} trade | Stake: $${formatNumber(state.currentStake)}`, 'TRADE', symbol);

    requestProposal(symbol, type, state.currentStake);
}

// ================================================================
// GRACEFUL SHUTDOWN
// ================================================================

function shutdown() {
    isBotRunning = false;

    logSeparator();
    logHeader('BOT SHUTDOWN');

    log(`Final Balance: $${formatNumber(currentBalance)}`, 'INFO');
    log(`Session P&L: $${formatNumber(sessionStats.realizedPnL)}`, 'INFO');
    log(`Total Trades: ${sessionStats.totalTrades}`, 'INFO');
    log(`Wins: ${sessionStats.wins} | Losses: ${sessionStats.losses}`, 'INFO');

    const winRate = sessionStats.totalTrades > 0
        ? (sessionStats.wins / sessionStats.totalTrades * 100).toFixed(2)
        : 0;
    log(`Win Rate: ${winRate}%`, 'INFO');

    // Per-asset statistics
    logSeparator('-');
    log('Per-Asset Statistics:', 'INFO');

    for (const [symbol, state] of assetStates) {
        const assetWinRate = state.stats.trades > 0
            ? (state.stats.wins / state.stats.trades * 100).toFixed(2)
            : 0;
        log(`  ${symbol}: ${state.stats.trades} trades | W:${state.stats.wins} L:${state.stats.losses} | P&L: $${formatNumber(state.stats.pnl)} | WR: ${assetWinRate}%`, 'INFO');
    }

    logSeparator();

    if (ws) {
        ws.close();
    }

    process.exit(0);
}

// ================================================================
// SIGNAL HANDLERS
// ================================================================

process.on('SIGINT', () => {
    log('Received SIGINT signal...', 'WARNING');
    shutdown();
});

process.on('SIGTERM', () => {
    log('Received SIGTERM signal...', 'WARNING');
    shutdown();
});

process.on('uncaughtException', (error) => {
    log(`Uncaught Exception: ${error.message}`, 'ERROR');
    console.error(error.stack);
    shutdown();
});

// ================================================================
// STARTUP
// ================================================================

function startBot() {
    console.clear();

    logHeader('DERIV MULTI-ASSET ALGORITHMIC TRADING BOT v2.0');

    log(`Strategy: Breakout & Retest (Multi-Timeframe)`, 'INFO');
    log(`Active Symbols: ${CONFIG.ACTIVE_SYMBOLS.join(', ')}`, 'INFO');
    log(`Initial Stake: $${CONFIG.STAKE_AMOUNT}`, 'INFO');
    log(`Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT === 't' ? 'ticks' : CONFIG.DURATION_UNIT === 'm' ? 'minutes' : 'seconds'}`, 'INFO');
    log(`Martingale: ${CONFIG.USE_MARTINGALE ? `ENABLED (x${CONFIG.MARTINGALE_MULTIPLIER}, max ${CONFIG.MAX_MARTINGALE_STEPS} steps)` : 'DISABLED'}`, 'INFO');
    log(`Max Daily Loss: $${CONFIG.MAX_DAILY_LOSS}`, 'INFO');
    log(`Trade Cooldown: ${CONFIG.TRADE_COOLDOWN / 1000}s`, 'INFO');

    logSeparator();

    // Clear previous log file
    if (CONFIG.ENABLE_FILE_LOGGING) {
        try {
            fs.writeFileSync(CONFIG.LOG_FILE, `=== Trading Session Started: ${new Date().toISOString()} ===\n`);
            log(`Log file: ${CONFIG.LOG_FILE}`, 'INFO');
        } catch (err) {
            log(`Could not create log file: ${err.message}`, 'WARNING');
        }
    }

    // Validate configuration
    if (!CONFIG.API_TOKEN || CONFIG.API_TOKEN === 'YOUR_DERIV_API_TOKEN_HERE') {
        log('ERROR: Please configure your API token in the CONFIG section', 'ERROR');
        console.log();
        console.log(`${COLORS.yellow}To get your API token:${COLORS.reset}`);
        console.log(`${COLORS.cyan}1. Go to https://app.deriv.com/account/api-token${COLORS.reset}`);
        console.log(`${COLORS.cyan}2. Create a token with 'Trade' scope${COLORS.reset}`);
        console.log(`${COLORS.cyan}3. Copy the token and paste it in the CONFIG.API_TOKEN field${COLORS.reset}`);
        console.log();
        process.exit(1);
    }

    if (CONFIG.ACTIVE_SYMBOLS.length === 0) {
        log('ERROR: No active symbols configured', 'ERROR');
        process.exit(1);
    }

    // Validate symbols
    for (const symbol of CONFIG.ACTIVE_SYMBOLS) {
        if (!CONFIG.AVAILABLE_SYMBOLS.find(s => s.symbol === symbol)) {
            log(`WARNING: Unknown symbol "${symbol}" in ACTIVE_SYMBOLS`, 'WARNING');
        }
    }

    logSeparator();
    log('Connecting to Deriv API...', 'SYSTEM');

    initTelegram();

    // Summary timer every 1 hour
    setInterval(() => {
        if (sessionStats.totalTrades > 0) {
            sendTelegramMessage(`📢 <b>Hourly Performance Update</b>\n${getTelegramSummary()}`);
        }
    }, 60 * 60 * 1000);

    // Connect to Deriv API
    connect();
}

// Start the bot
startBot();
