const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'risefall01-state00000001.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static saveState() {
        try {
            const persistableState = {
                savedAt: Date.now(),
                capital: state.capital,
                investmentRemaining: state.investmentRemaining,
                baseStake: state.baseStake,
                session: { ...state.session },
                portfolio: {
                    dailyProfit: state.portfolio.dailyProfit,
                    dailyLoss: state.portfolio.dailyLoss,
                    dailyWins: state.portfolio.dailyWins,
                    dailyLosses: state.portfolio.dailyLosses,
                    activePositions: state.portfolio.activePositions.map(pos => ({
                        symbol: pos.symbol,
                        direction: pos.direction,
                        stake: pos.stake,
                        duration: pos.duration,
                        durationUnit: pos.durationUnit,
                        entryTime: pos.entryTime,
                        contractId: pos.contractId,
                        buyPrice: pos.buyPrice,
                        currentProfit: pos.currentProfit
                    }))
                },
                lastTradeDirection: state.lastTradeDirection,
                martingaleLevel: state.martingaleLevel,
                // NEW: persist recovery state
                inRecovery: state.inRecovery,
                waitingForNewCandle: state.waitingForNewCandle,
                hourlyStats: { ...state.hourlyStats },
                assets: {}
            };

            Object.keys(state.assets).forEach(symbol => {
                const asset = state.assets[symbol];
                persistableState.assets[symbol] = {
                    closedCandles: asset.closedCandles.slice(-20),
                    lastProcessedCandleOpenTime: asset.lastProcessedCandleOpenTime,
                    candlesLoaded: asset.candlesLoaded
                };
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
        } catch (error) {
            LOGGER.error(`Failed to save state: ${error.message}`);
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                LOGGER.info('📂 No previous state file found, starting fresh');
                return false;
            }

            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            if (ageMinutes > 30) {
                LOGGER.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            LOGGER.info(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);

            state.capital = savedData.capital;
            state.investmentRemaining = savedData.investmentRemaining || savedData.capital;
            state.baseStake = savedData.baseStake || CONFIG.STAKE;
            state.session = {
                ...state.session,
                ...savedData.session,
                startTime: savedData.session.startTime || Date.now(),
                startCapital: savedData.session.startCapital || savedData.capital
            };

            state.portfolio.dailyProfit = savedData.portfolio.dailyProfit;
            state.portfolio.dailyLoss = savedData.portfolio.dailyLoss;
            state.portfolio.dailyWins = savedData.portfolio.dailyWins;
            state.portfolio.dailyLosses = savedData.portfolio.dailyLosses;

            state.portfolio.activePositions = (savedData.portfolio.activePositions || []).map(pos => ({
                ...pos,
                entryTime: pos.entryTime || Date.now()
            }));

            state.lastTradeDirection = savedData.lastTradeDirection || null;
            state.martingaleLevel = savedData.martingaleLevel || 0;
            // NEW: restore recovery state
            state.inRecovery = savedData.inRecovery || false;
            state.waitingForNewCandle = savedData.waitingForNewCandle !== undefined
                ? savedData.waitingForNewCandle
                : true;
            state.hourlyStats = savedData.hourlyStats || {
                trades: 0,
                wins: 0,
                losses: 0,
                pnl: 0,
                lastHour: new Date().getHours()
            };

            LOGGER.info(`✅ State restored successfully!`);
            LOGGER.info(`   🎯 Trades: ${state.session.tradesCount} (W:${state.session.winsCount} L:${state.session.lossesCount})`);
            LOGGER.info(`   📉 Loss Stats: x2:${state.session.x2Losses} x3:${state.session.x3Losses} x4:${state.session.x4Losses} x5:${state.session.x5Losses} x6:${state.session.x6Losses} x7:${state.session.x7Losses}`);
            LOGGER.info(`   🚀 Active Positions: ${state.portfolio.activePositions.length}`);
            LOGGER.info(`   🔄 Last Direction: ${state.lastTradeDirection || 'None'}`);
            LOGGER.info(`   📈 Martingale Level: ${state.martingaleLevel}`);
            LOGGER.info(`   🔁 In Recovery: ${state.inRecovery}`);
            LOGGER.info(`   ⏳ Waiting for New Candle: ${state.waitingForNewCandle}`);

            return true;
        } catch (error) {
            LOGGER.error(`Failed to load state: ${error.message}`);
            return false;
        }
    }

    static startAutoSave() {
        setInterval(() => {
            if (state.isAuthorized) {
                this.saveState();
            }
        }, STATE_SAVE_INTERVAL);
        LOGGER.info(`💾 Auto-save enabled (every ${STATE_SAVE_INTERVAL / 1000}s)`);
    }

    static clearState() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                fs.unlinkSync(STATE_FILE);
                LOGGER.info('🗑️ State file cleared');
            }
        } catch (error) {
            LOGGER.error(`Failed to clear state: ${error.message}`);
        }
    }
}

// ============================================
// TELEGRAM SERVICE
// ============================================
class TelegramService {
    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED) return;
        try {
            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const data = JSON.stringify({
                chat_id: CONFIG.TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            });

            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': data.length
                }
            };

            return new Promise((resolve, reject) => {
                const req = https.request(url, options, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            resolve(true);
                        } else {
                            reject(new Error(body));
                        }
                    });
                });
                req.on('error', (error) => {
                    reject(error);
                });
                req.write(data);
                req.end();
            });
        } catch (error) {
            LOGGER.error(`Failed to send Telegram message: ${error.message}`);
        }
    }

    static async sendTradeAlert(type, symbol, direction, stake, duration, durationUnit, details = {}) {
        const emoji = type === 'OPEN' ? '🚀' : (type === 'WIN' ? '✅' : '❌');
        const stats = SessionManager.getSessionStats();
        const message = `
            ${emoji} <b>${type} TRADE ALERT 01</b>
            Asset: ${symbol}
            Direction: ${direction}
            Stake: $${stake.toFixed(2)}
            Duration: ${duration} (${durationUnit == 't' ? 'Ticks' : durationUnit == 's' ? 'Seconds' : 'Minutes'})
            Martingale Level: ${state.martingaleLevel}
            Recovery Mode: ${state.inRecovery ? 'YES' : 'NO'}
            ${details.profit !== undefined ? `Profit: $${details.profit.toFixed(2)}
            Total P&L: $${state.session.netPL.toFixed(2)}
            Wins: ${state.session.winsCount}/${state.session.lossesCount}
            Win Rate: ${stats.winRate}%
            ` : ''}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendSessionSummary() {
        const stats = SessionManager.getSessionStats();
        const message = `
            📊 <b>SESSION SUMMARY 01</b>
            Duration: ${stats.duration}
            Trades: ${stats.trades}
            Wins: ${stats.wins} | Losses: ${stats.losses}
            Win Rate: ${stats.winRate}
            Loss Stats: x2:${stats.x2Losses} | x3:${stats.x3Losses} | x4:${stats.x4Losses} | x5:${stats.x5Losses} | x6:${stats.x6Losses} | x7:${stats.x7Losses} | x8:${stats.x8Losses} | x9:${stats.x9Losses}
            Net P/L: $${stats.netPL.toFixed(2)}
            Current Capital: $${state.capital.toFixed(2)}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendStartupMessage() {
        const message = `
            🤖 <b>DERIV RISE/FALL BOT STARTED 01</b>
            Strategy: Alternating Rise/Fall
            Capital: $${CONFIG.INITIAL_CAPITAL}
            Stake: $${CONFIG.STAKE}
            Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT}
            Assets: ${ACTIVE_ASSETS.join(', ')}
            Session Target: $${CONFIG.SESSION_PROFIT_TARGET}
            Stop Loss: $${CONFIG.SESSION_STOP_LOSS}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendHourlySummary() {
        const statsSnapshot = { ...state.hourlyStats };

        if (statsSnapshot.trades === 0) {
            LOGGER.info('📱 Telegram: Skipping hourly summary (no trades this hour)');
            return;
        }

        const totalTrades = statsSnapshot.wins + statsSnapshot.losses;
        const winRate = totalTrades > 0
            ? ((statsSnapshot.wins / totalTrades) * 100).toFixed(1)
            : 0;
        const pnlEmoji = statsSnapshot.pnl >= 0 ? '🟢' : '🔴';
        const pnlStr = (statsSnapshot.pnl >= 0 ? '+' : '') + '$' + statsSnapshot.pnl.toFixed(2);

        const message = `
            ⏰ <b>Rise/Fall Bot Hourly Summary 01</b>

            📊 <b>Last Hour</b>
            ├ Trades: ${statsSnapshot.trades}
            ├ Wins: ${statsSnapshot.wins} | Losses: ${statsSnapshot.losses}
            ├ Win Rate: ${winRate}%
            └ ${pnlEmoji} <b>P&L:</b> ${pnlStr}

            📈 <b>Daily Totals</b>
            ├ Total Trades: ${state.session.tradesCount}
            ├ Total W/L: ${state.session.winsCount}/${state.session.lossesCount}
            ├ Loss Chains: x2:${state.session.x2Losses} x3:${state.session.x3Losses} x4:${state.session.x4Losses} x5:${state.session.x5Losses} x6:${state.session.x6Losses} x7:${state.session.x7Losses} x8:${state.session.x8Losses} x9:${state.session.x9Losses}
            ├ Daily P&L: ${(state.session.netPL >= 0 ? '+' : '')}$${state.session.netPL.toFixed(2)}
            └ Current Capital: $${state.capital.toFixed(2)}

            ⏰ ${new Date().toLocaleString()}
        `.trim();

        try {
            await this.sendMessage(message);
            LOGGER.info('📱 Telegram: Hourly Summary sent');
            LOGGER.info(`   📊 Hour Stats: ${statsSnapshot.trades} trades, ${statsSnapshot.wins}W/${statsSnapshot.losses}L, ${pnlStr}`);
        } catch (error) {
            LOGGER.error(`❌ Telegram hourly summary failed: ${error.message}`);
        }

        state.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };
    }

    static startHourlyTimer() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1);
        nextHour.setMinutes(0);
        nextHour.setSeconds(0);
        nextHour.setMilliseconds(0);

        const timeUntilNextHour = nextHour.getTime() - now.getTime();

        setTimeout(() => {
            this.sendSessionSummary();
            setInterval(() => {
                this.sendSessionSummary();
            }, 60 * 60 * 1000);
        }, timeUntilNextHour);
    }
}

// ============================================
// CANDLE ANALYSIS UTILITY
// ============================================
class CandleAnalyzer {
    static isBullish(candle) {
        return candle.close > candle.open;
    }

    static isBearish(candle) {
        return candle.close < candle.open;
    }

    static getLastClosedCandle(symbol) {
        const assetState = state.assets[symbol];
        if (!assetState || !assetState.closedCandles || assetState.closedCandles.length === 0) {
            return null;
        }
        return assetState.closedCandles[assetState.closedCandles.length - 1];
    }

    static getCandleDirection(candle) {
        if (this.isBullish(candle)) return 'BULLISH';
        if (this.isBearish(candle)) return 'BEARISH';
        return 'DOJI';
    }
}

// ============================================
// LOGGER UTILITY
// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';

const LOGGER = {
    info: (msg) => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: (msg) => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: (msg) => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); }
};

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    API_TOKEN: 'Dz2V2KvRf4Uukt3',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    INITIAL_CAPITAL: 100,
    STAKE: 0.35,

    AUTO_COMPOUNDING: true,
    COMPOUND_PERCENTAGE: 0.35,

    SESSION_PROFIT_TARGET: 10000,
    SESSION_STOP_LOSS: -85,

    GRANULARITY: 60,
    TIMEFRAME_LABEL: '1m',
    MAX_CANDLES_STORED: 100,
    CANDLES_TO_LOAD: 50,

    DURATION: 1,
    DURATION_UNIT: 't',

    MAX_OPEN_POSITIONS: 1,
    TRADE_DELAY: 1000,
    MARTINGALE_MULTIPLIER: 1.48,
    MAX_MARTINGALE_LEVEL: 3,
    AFTER_MAX_LOSS: 'continue',
    CONTINUE_EXTRA_LEVELS: 6,
    MAX_LOSSES: 9,
    EXTRA_LEVEL_MULTIPLIERS: [2.0, 2.1, 2.1, 2.2, 2.2, 2.3],

    DEBUG_MODE: true,

    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8591937854:AAESyF-8b17sRK-xdQXzrHfALnKA1sAR3CI',
    TELEGRAM_CHAT_ID: '752497117',
};

let ACTIVE_ASSETS = ['1HZ50V'];

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    assets: {},
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    investmentRemaining: CONFIG.INITIAL_CAPITAL,
    baseStake: CONFIG.STAKE,
    session: {
        profit: 0,
        loss: 0,
        netPL: 0,
        tradesCount: 0,
        winsCount: 0,
        lossesCount: 0,
        x2Losses: 0,
        x3Losses: 0,
        x4Losses: 0,
        x5Losses: 0,
        x6Losses: 0,
        x7Losses: 0,
        x8Losses: 0,
        x9Losses: 0,
        isActive: true,
        startTime: Date.now(),
        startCapital: CONFIG.INITIAL_CAPITAL
    },
    isConnected: false,
    isAuthorized: false,
    portfolio: {
        dailyProfit: 0,
        dailyLoss: 0,
        dailyWins: 0,
        dailyLosses: 0,
        activePositions: []
    },
    lastTradeDirection: null,
    martingaleLevel: 0,
    // NEW: Clear trading flow control
    inRecovery: false,           // true = we lost and are doing recovery trades
    waitingForNewCandle: true,   // true = need a new candle before trading
    hourlyStats: {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        lastHour: new Date().getHours()
    },
    requestId: 1,
    canTrade: false,
    // Watchdog properties
    tradeWatchdogTimer: null,
    tradeWatchdogPollTimer: null,
    tradeInProgress: false,
    pendingTradeInfo: null,
    tradeStartTime: null,
    currentContractId: null
};

// ============================================
// SESSION MANAGER
// ============================================
class SessionManager {
    static isSessionActive() {
        return state.session.isActive;
    }

    static checkSessionTargets() {
        const netPL = state.session.netPL;

        if (netPL >= CONFIG.SESSION_PROFIT_TARGET) {
            LOGGER.trade(`🎯 SESSION PROFIT TARGET REACHED! Net P/L: $${netPL.toFixed(2)}`);
            this.endSession('PROFIT_TARGET');
            return true;
        }

        // const maxLevel = CONFIG.MAX_LOSSES;

        // if (state.martingaleLevel >= maxLevel) {
        //     LOGGER.error(`🛑 SESSION STOP LOSS REACHED! Net P/L: $${netPL.toFixed(2)}`);
        //     this.endSession('STOP_LOSS');
        //     return true;
        // }

        return false;
    }

    static async endSession(reason) {
        state.session.isActive = false;
        LOGGER.info(`⏸️ Session ended (${reason}).`);
        TelegramService.sendSessionSummary();
        state.canTrade = false;
    }

    static getSessionStats() {
        const duration = Date.now() - state.session.startTime;
        const hours = Math.floor(duration / 3600000);
        const minutes = Math.floor((duration % 3600000) / 60000);

        return {
            duration: `${hours}h ${minutes}m`,
            trades: state.session.tradesCount,
            wins: state.session.winsCount,
            losses: state.session.lossesCount,
            winRate: state.session.tradesCount > 0
                ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1) + '%'
                : '0%',
            x2Losses: state.session.x2Losses,
            x3Losses: state.session.x3Losses,
            x4Losses: state.session.x4Losses,
            x5Losses: state.session.x5Losses,
            x6Losses: state.session.x6Losses,
            x7Losses: state.session.x7Losses,
            x8Losses: state.session.x8Losses,
            x9Losses: state.session.x9Losses,
            netPL: state.session.netPL
        };
    }

    static recordTradeResult(profit, direction) {
        const currentHour = new Date().getHours();
        if (currentHour !== state.hourlyStats.lastHour) {
            LOGGER.warn(`⏰ Hour changed detected (${state.hourlyStats.lastHour} → ${currentHour}), resetting hourly stats`);
            state.hourlyStats = {
                trades: 0,
                wins: 0,
                losses: 0,
                pnl: 0,
                lastHour: currentHour
            };
        }

        state.session.tradesCount++;
        state.capital += profit;

        state.hourlyStats.trades++;
        state.hourlyStats.pnl += profit;

        if (profit > 0) {
            // ===== WIN =====
            state.session.winsCount++;
            state.session.profit += profit;
            state.lastTradeWasWin = true;
            state.session.netPL += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            state.hourlyStats.wins++;

            // Reset martingale
            state.martingaleLevel = 0;

            // Exit recovery and wait for new candle
            state.inRecovery = false;
            state.waitingForNewCandle = true;

            // Update investment amount (capital available for trading)
            state.investmentRemaining = Math.max(0, Number((state.investmentRemaining + profit).toFixed(2)));

            // Recalculate base stake based on NEW investment amount
            if (CONFIG.AUTO_COMPOUNDING && state.investmentRemaining > 0) {
                // Base stake is percentage of total investment (initial + profit)
                const newBaseStake = Math.max(
                    state.investmentRemaining * (CONFIG.COMPOUND_PERCENTAGE / 100),
                    0.35
                );
                
                state.baseStake = Number(newBaseStake.toFixed(2));
                
                LOGGER.trade(`✅ WIN: +$${profit.toFixed(2)} | Direction: ${direction}`);
                LOGGER.trade(`💰 Investment Pool: $${state.investmentRemaining.toFixed(2)}`);
                LOGGER.trade(`📊 New Base Stake: $${state.baseStake.toFixed(2)} (${CONFIG.COMPOUND_PERCENTAGE}% of pool)`);
            } else {
                LOGGER.trade(`✅ WIN: +$${profit.toFixed(2)} | Direction: ${direction} | Martingale Reset`);
            }

            LOGGER.trade(`🕒 Recovery complete → Waiting for NEW CANDLE before next trade`);
        } else {
            // ===== LOSS =====
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            state.hourlyStats.losses++;
            state.martingaleLevel++;

            // KEY FIX: Enter recovery mode - don't wait for new candle
            state.inRecovery = true;
            state.waitingForNewCandle = false;

            // Mark last trade as a loss for scheduler
            state.lastTradeWasWin = false;

            if (CONFIG.AUTO_COMPOUNDING) {
                state.investmentRemaining = Math.max(0, Number((state.investmentRemaining + profit).toFixed(2)));
            }

            if (state.martingaleLevel === 2) state.session.x2Losses++;
            if (state.martingaleLevel === 3) state.session.x3Losses++;
            if (state.martingaleLevel === 4) state.session.x4Losses++;
            if (state.martingaleLevel === 5) state.session.x5Losses++;
            if (state.martingaleLevel === 6) state.session.x6Losses++;
            if (state.martingaleLevel === 7) state.session.x7Losses++;
            if (state.martingaleLevel === 8) state.session.x8Losses++;
            if (state.martingaleLevel === 9) state.session.x9Losses++;

            const maxLevel = CONFIG.MAX_LOSSES;

            if (state.martingaleLevel >= maxLevel) {
                LOGGER.warn(`⚠️ Maximum Martingale level reached (${maxLevel}), Bot Stopped!`);
                // state.martingaleLevel = 0;
                // state.inRecovery = false;
                // state.waitingForNewCandle = true;
                TelegramService.sendSessionSummary();
                this.stop();
            } else {
                LOGGER.trade(`❌ LOSS: -$${Math.abs(profit).toFixed(2)} | Direction: ${direction} | Recovery Level: ${state.martingaleLevel}`);
                LOGGER.trade(`🔁 Entering RECOVERY mode → Will trade immediately`);
            }
        }
    }
}

// ============================================
// CONNECTION MANAGER
// ============================================
class ConnectionManager {
    constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 5000;
        this.pingInterval = null;
        this.autoSaveStarted = false;
        this.isReconnecting = false;
    }

    connect() {
        LOGGER.info('🔌 Connecting to Deriv API...');
        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);

        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', (data) => this.onMessage(data));
        this.ws.on('error', (error) => this.onError(error));
        this.ws.on('close', () => this.onClose());

        return this.ws;
    }

    onOpen() {
        LOGGER.info('✅ Connected to Deriv API');
        state.isConnected = true;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;

        this.startPing();

        if (!this.autoSaveStarted) {
            StatePersistence.startAutoSave();
            this.autoSaveStarted = true;
        }

        this.send({ authorize: CONFIG.API_TOKEN });
    }

    initializeAssets() {
        ACTIVE_ASSETS.forEach(symbol => {
            if (!state.assets[symbol]) {
                state.assets[symbol] = {
                    candles: [],
                    closedCandles: [],
                    currentFormingCandle: null,
                    lastProcessedCandleOpenTime: null,
                    candlesLoaded: false
                };
                LOGGER.info(`📊 Initialized asset: ${symbol}`);
            } else {
                LOGGER.info(`📊 Asset ${symbol} already initialized (state restored)`);
            }
        });
    }

    onMessage(data) {
        try {
            const response = JSON.parse(data);
            this.handleResponse(response);
        } catch (error) {
            LOGGER.error(`Error parsing message: ${error.message}`);
        }
    }

    handleResponse(response) {
        if (response.msg_type === 'authorize') {
            if (response.error) {
                LOGGER.error(`Authorization failed: ${response.error.message}`);
                return;
            }
            LOGGER.info('🔐 Authorized successfully');
            LOGGER.info(`👤 Account: ${response.authorize.loginid}`);
            LOGGER.info(`💰 Balance: ${response.authorize.balance} ${response.authorize.currency}`);

            state.isAuthorized = true;
            state.accountBalance = response.authorize.balance;

            state.capital = CONFIG.INITIAL_CAPITAL;
            state.investmentRemaining = CONFIG.INITIAL_CAPITAL;

            this.send({ balance: 1, subscribe: 1 });

            this.initializeAssets();
            ACTIVE_ASSETS.forEach(symbol => bot.subscribeToCandles(symbol));

            bot.start();
        }

        if (response.msg_type === 'balance') {
            state.accountBalance = response.balance.balance;
        }

        if (response.msg_type === 'ohlc') {
            this.handleOHLC(response.ohlc);
        }

        if (response.msg_type === 'candles') {
            this.handleCandlesHistory(response);
        }

        if (response.msg_type === 'buy') {
            this.handleBuyResponse(response);
        }

        if (response.msg_type === 'proposal_open_contract') {
            this.handleOpenContract(response);
        }
    }

    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        if (!state.assets[symbol]) return;

        const assetState = state.assets[symbol];
        const calculatedOpenTime = ohlc.open_time ||
            Math.floor(ohlc.epoch / CONFIG.GRANULARITY) * CONFIG.GRANULARITY;

        const incomingCandle = {
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close),
            epoch: ohlc.epoch,
            open_time: calculatedOpenTime
        };

        const currentOpenTime = assetState.currentFormingCandle?.open_time;
        const isNewCandle = currentOpenTime && incomingCandle.open_time !== currentOpenTime;

        if (isNewCandle) {
            const closedCandle = { ...assetState.currentFormingCandle };
            closedCandle.epoch = closedCandle.open_time + CONFIG.GRANULARITY;

            if (closedCandle.open_time !== assetState.lastProcessedCandleOpenTime) {
                assetState.closedCandles.push(closedCandle);

                if (assetState.closedCandles.length > CONFIG.MAX_CANDLES_STORED) {
                    assetState.closedCandles = assetState.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED);
                }

                assetState.lastProcessedCandleOpenTime = closedCandle.open_time;

                const closeTime = new Date(closedCandle.epoch * 1000).toISOString();
                const candleType = CandleAnalyzer.getCandleDirection(closedCandle);
                const candleEmoji = candleType === 'BULLISH' ? '🟢' : candleType === 'BEARISH' ? '🔴' : '⚪';

                LOGGER.info(`${symbol} ${candleEmoji} CANDLE CLOSED [${closeTime}] ${candleType}: O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)}`);

                // KEY FIX: New candle arrived - only trigger trade if we're
                // waiting for a new candle (not in recovery mode)
                if (state.waitingForNewCandle) {
                    LOGGER.trade(`🕯️ New candle detected! Triggering fresh trade.`);
                    state.waitingForNewCandle = false;
                    state.canTrade = true;
                    bot.executeNextTrade();
                } else {
                    LOGGER.debug(`🕯️ New candle closed but bot is in recovery or has active position, skipping trigger.`);
                }
            }
        }

        assetState.currentFormingCandle = incomingCandle;

        const candles = assetState.candles;
        const existingIndex = candles.findIndex(c => c.open_time === incomingCandle.open_time);
        if (existingIndex >= 0) {
            candles[existingIndex] = incomingCandle;
        } else {
            candles.push(incomingCandle);
        }

        if (candles.length > CONFIG.MAX_CANDLES_STORED) {
            assetState.candles = candles.slice(-CONFIG.MAX_CANDLES_STORED);
        }
    }

    handleCandlesHistory(response) {
        if (response.error) {
            LOGGER.error(`Error fetching candles: ${response.error.message}`);
            return;
        }

        const symbol = response.echo_req.ticks_history;
        if (!state.assets[symbol]) return;

        const candles = response.candles.map(c => {
            const openTime = Math.floor((c.epoch - CONFIG.GRANULARITY) / CONFIG.GRANULARITY) * CONFIG.GRANULARITY;
            return {
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close),
                epoch: c.epoch,
                open_time: openTime
            };
        });

        if (candles.length === 0) {
            LOGGER.warn(`${symbol}: No historical candles received`);
            return;
        }

        state.assets[symbol].candles = [...candles];
        state.assets[symbol].closedCandles = [...candles];

        const lastCandle = candles[candles.length - 1];
        state.assets[symbol].lastProcessedCandleOpenTime = lastCandle.open_time;
        state.assets[symbol].currentFormingCandle = null;
        state.assets[symbol].candlesLoaded = true;

        LOGGER.info(`📊 Loaded ${candles.length} ${CONFIG.TIMEFRAME_LABEL} candles for ${symbol}`);
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);

            const reqId = response.echo_req?.req_id;
            if (reqId) {
                const posIndex = state.portfolio.activePositions.findIndex(p => p.reqId === reqId);
                if (posIndex >= 0) {
                    state.portfolio.activePositions.splice(posIndex, 1);
                }
            }

            // On buy error, allow retry
            setTimeout(() => {
                state.canTrade = true;
                bot.executeNextTrade();
            }, CONFIG.TRADE_DELAY);

            return;
        }

        const contract = response.buy;
        LOGGER.trade(`✅ Position opened: Contract ${contract.contract_id}, Buy Price: $${contract.buy_price}`);

        const reqId = response.echo_req.req_id;
        const position = state.portfolio.activePositions.find(p => p.reqId === reqId);

        if (position) {
            position.contractId = contract.contract_id;
            position.buyPrice = contract.buy_price;

            // Set watchdog tracking fields
            state.tradeInProgress = true;
            state.currentContractId = contract.contract_id;
            state.tradeStartTime = Date.now();
            state.pendingTradeInfo = {
                stake: position.stake,
                direction: position.direction,
                symbol: position.symbol
            };

            // Start the watchdog timer
            bot._startTradeWatchdog(contract.contract_id);

            TelegramService.sendTradeAlert(
                'OPEN',
                position.symbol,
                position.direction,
                position.stake,
                position.duration,
                position.durationUnit
            );
        }

        this.send({
            proposal_open_contract: 1,
            contract_id: contract.contract_id,
            subscribe: 1
        });
    }

    handleOpenContract(response) {
        if (response.error) {
            LOGGER.error(`Contract error: ${response.error.message}`);
            return;
        }

        const contract = response.proposal_open_contract;
        const contractId = contract.contract_id;
        
        // Check if contract already processed
        if (bot._processedContracts.has(String(contractId))) {
            LOGGER.debug(`⚠️ Contract ${contractId} already processed, ignoring duplicate`);
            // Unsubscribe from this contract
            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }
            return;
        }

        const posIndex = state.portfolio.activePositions.findIndex(
            p => p.contractId === contractId
        );

        if (posIndex < 0) {
            LOGGER.debug(`No active position found for contract ${contractId}`);
            return;
        }

        const position = state.portfolio.activePositions[posIndex];
        position.currentProfit = contract.profit;

        // Contract closed
        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
            // Clear watchdog FIRST
            bot._clearAllWatchdogTimers();
            
            // Mark as processed BEFORE recording result
            bot._processedContracts.add(String(contractId));
            
            const profit = contract.profit;

            LOGGER.trade(`Contract ${contractId} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`);

            // Record result - this sets inRecovery and waitingForNewCandle
            SessionManager.recordTradeResult(profit, position.direction);

            // Send telegram alert
            TelegramService.sendTradeAlert(
                profit >= 0 ? 'WIN' : 'LOSS',
                position.symbol,
                position.direction,
                position.stake,
                position.duration,
                position.durationUnit,
                { profit }
            );

            // Remove position
            state.portfolio.activePositions.splice(posIndex, 1);

            // Release watchdog lock
            state.tradeInProgress = false;
            state.currentContractId = null;
            state.tradeStartTime = null;
            state.pendingTradeInfo = null;

            // Unsubscribe
            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }

            // Check session targets
            if (SessionManager.checkSessionTargets()) {
                StatePersistence.saveState();
                return;
            }

            StatePersistence.saveState();

            // Schedule next trade
            setTimeout(() => {
                if (!state.session.isActive) return;
                
                if (state.inRecovery) {
                    LOGGER.trade(`🔁 RECOVERY: Executing recovery trade (Level ${state.martingaleLevel})`);
                    state.canTrade = true;
                    bot.executeNextTrade();
                } else if (state.waitingForNewCandle) {
                    LOGGER.trade(`🕒 WIN recorded → Waiting for new candle before next trade`);
                    state.canTrade = false;
                } else {
                    state.canTrade = true;
                    bot.executeNextTrade();
                }
            }, CONFIG.TRADE_DELAY);
        }
    }

    onError(error) {
        LOGGER.error(`WebSocket error: ${error.message}`);
    }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;

        this.stopPing();
        StatePersistence.saveState();

        if (this.isReconnecting) {
            LOGGER.info('Already handling disconnect, skipping...');
            return;
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.isReconnecting = true;
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

            TelegramService.sendMessage(`⚠️ <b>CONNECTION LOST</b>\nReconnecting... (attempt ${this.reconnectAttempts})`);

            setTimeout(() => {
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            TelegramService.sendMessage(`🛑 <b>BOT STOPPED</b>\nMax reconnection attempts reached.`);
            process.exit(1);
        }
    }

    startPing() {
        this.pingInterval = setInterval(() => {
            if (state.isConnected) {
                this.send({ ping: 1 });
            }
        }, 30000);
    }

    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
    }

    send(data) {
        if (!state.isConnected) {
            LOGGER.error('Cannot send: Not connected');
            return null;
        }

        data.req_id = state.requestId++;
        this.ws.send(JSON.stringify(data));
        return data.req_id;
    }
}

// ============================================
// MAIN BOT CLASS
// ============================================
class DerivBot {
    constructor() {
        this.connection = new ConnectionManager();
        this._processedContracts = new Set();
        this.tradeWatchdogMs = 3000; // 30 second watchdog timeout
        this.endOfDay = false;
        this.isWinTrade = false;
    }

    async start() {
        console.log('\n' + '═'.repeat(80));
        console.log(' DERIV RISE/FALL ALTERNATING BOT');
        console.log('═'.repeat(80));
        console.log(`💰 Initial Capital: $${state.capital}`);
        console.log(`📊 Active Assets: ${ACTIVE_ASSETS.join(', ')}`);
        console.log(`💵 Base Stake: $${CONFIG.STAKE}`);
        if (CONFIG.AUTO_COMPOUNDING) {
            console.log(`📈 Auto-Compounding: ENABLED (${CONFIG.COMPOUND_PERCENTAGE}% of remaining investment)`);
        }
        console.log(`⏱️ Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT}`);
        console.log(`🕯️ Candle Timeframe: ${CONFIG.TIMEFRAME_LABEL}`);
        console.log(`🎯 Session Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`);
        console.log(`📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ENABLED' : 'DISABLED'}`);
        console.log('═'.repeat(80));
        console.log('📋 Strategy: Trade on new candle close');
        console.log('    🕯️ New candle closes → Execute trade');
        console.log('    ❌ Loss → Recovery trades immediately (martingale)');
        console.log('    ✅ Win → Stop trading, wait for next new candle');
        console.log('    🔁 Recovery continues until a win, then waits for candle');
        console.log('═'.repeat(80) + '\n');

        TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();

        LOGGER.info('✅ Bot started successfully!');
    }

    // ============================================
    // TIME SCHEDULER (weekend pause + EOD logic)
    // ============================================
    startTimeScheduler() {
        setInterval(() => {
            const now = new Date();
            // compute UTC ms then add 1 hour for GMT+1 reliably
            const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
            const gmt1 = new Date(utcMs + (1 * 60 * 60 * 1000));
            const day = gmt1.getDay();
            const hours = gmt1.getHours();
            const minutes = gmt1.getMinutes();

            const isWeekend =
                day === 0 ||
                (day === 6 && hours >= 23) ||
                (day === 1 && hours < 8);

            // if (isWeekend) {
            //     if (!this.endOfDay) {
            //         LOGGER.warn('📅 Weekend trading pause (Sat 23:00 – Mon 07:00 GMT+1) — disconnecting');
            //         TelegramService.sendHourlySummary();
            //         this.stop();
            //         if (this.connection && this.connection.ws) {
            //             try { this.connection.ws.close(); } catch (e) {/*ignore*/}
            //         }
            //         this.endOfDay = true;
            //     }
            //     return;
            // }

            // Reconnect at 08:00 GMT+1 when endOfDay is set
            if (this.endOfDay && hours === 2 && minutes >= 0) {
                LOGGER.info('📅 02:00 GMT+1 — reconnecting bot');
                this._resetDailyStats();
                this.endOfDay = false;
                this.connection.connect();
                return;
            }

            // Disconnect (end of day) if last trade was a win and it's late in the day
            if (!this.endOfDay && state.lastTradeWasWin && hours >= 18) {
                LOGGER.info('📅 Past 18:00 GMT+1 — end-of-day stop due to winning trade');
                TelegramService.sendHourlySummary();
                this.stop();
                if (this.connection && this.connection.ws) {
                    try { this.connection.ws.close(); } catch (e) {/*ignore*/}
                }
                this.endOfDay = true;
                return;
            }
        }, 10000);

        LOGGER.info('📅 Time scheduler started (weekend pause + EOD logic)');
    }

    _resetDailyStats() {
        state.tradeInProgress = false;
        state.lastTradeWasWin = false;
    }

    subscribeToCandles(symbol) {
        LOGGER.info(`📊 Subscribing to ${CONFIG.TIMEFRAME_LABEL} candles for ${symbol}...`);

        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: CONFIG.CANDLES_TO_LOAD,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: CONFIG.GRANULARITY
        });

        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: 1,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: CONFIG.GRANULARITY,
            subscribe: 1
        });
    }

    calculateStake(level) {
        const cfg = CONFIG;
        let base = state.baseStake;

        if (cfg.AUTO_COMPOUNDING && state.investmentRemaining > 0) {
            base = Math.max(state.investmentRemaining * cfg.COMPOUND_PERCENTAGE / 100, 0.35);
        }

        base = Math.max(base, 0.35);

        if (level <= cfg.MAX_MARTINGALE_LEVEL) {
            return Number((base * Math.pow(cfg.MARTINGALE_MULTIPLIER, level)).toFixed(2));
        }

        let stake = base * Math.pow(cfg.MARTINGALE_MULTIPLIER, cfg.MAX_MARTINGALE_LEVEL);
        const extraIdx = level - cfg.MAX_MARTINGALE_LEVEL - 1;
        const mults = cfg.EXTRA_LEVEL_MULTIPLIERS || [];

        for (let i = 0; i <= extraIdx; i++) {
            stake *= (mults[i] > 0 ? mults[i] : cfg.MARTINGALE_MULTIPLIER);
        }

        return Number(stake.toFixed(2));
    }

    executeNextTrade() {
        if (!state.canTrade) {
            LOGGER.debug('executeNextTrade called but canTrade=false, skipping');
            return;
        }
        if (!SessionManager.isSessionActive()) {
            LOGGER.debug('executeNextTrade called but session inactive, skipping');
            return;
        }
        if (state.portfolio.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) {
            LOGGER.debug('executeNextTrade called but max positions open, skipping');
            return;
        }

        const symbol = ACTIVE_ASSETS[0];
        const assetState = state.assets[symbol];

        // Check if candles are loaded
        if (!assetState || !assetState.candlesLoaded) {
            LOGGER.info('⏳ Waiting for candles to load...');
            state.canTrade = false;
            return;
        }

        const stake = this.calculateStake(state.martingaleLevel);

        if (state.capital < stake) {
            LOGGER.error(`Insufficient capital for stake: $${state.capital.toFixed(2)} (Needed: $${stake.toFixed(2)})`);
            if (state.martingaleLevel > 0) {
                LOGGER.info('Resetting Martingale level due to insufficient capital.');
                state.martingaleLevel = 0;
                state.inRecovery = false;
                state.waitingForNewCandle = true;
            }
            return;
        }

        if (CONFIG.AUTO_COMPOUNDING && state.investmentRemaining < stake) {
            LOGGER.error(`Insufficient investment for compounding: $${state.investmentRemaining.toFixed(2)} (Needed: $${stake.toFixed(2)})`);
            state.martingaleLevel = 0;
            state.inRecovery = false;
            state.waitingForNewCandle = true;
            state.canTrade = false;
            return;
        }

        // Deduct stake from investmentRemaining
        if (CONFIG.AUTO_COMPOUNDING) {
            state.investmentRemaining = Math.max(0, Number((state.investmentRemaining - stake).toFixed(2)));
        }

        // Determine trade direction based on last closed candle
        const lastCandle = CandleAnalyzer.getLastClosedCandle(symbol);
        let direction;

        if (lastCandle === null) {
            direction = 'CALLE';
            LOGGER.trade('📊 No previous candle - starting with RISE (CALLE)');
        } else if (state.inRecovery) {
            // During recovery: alternate direction from last trade
            if (state.martingaleLevel < 3) {
                if (state.lastTradeDirection === 'CALLE') {
                    direction = 'PUTE';
                    LOGGER.trade(`🔁 RECOVERY: Last was RISE → Trying FALL`);
                } else {
                    direction = 'CALLE';
                    LOGGER.trade(`🔁 RECOVERY: Last was FALL → Trying RISE`);
                }
            } else {
                if (state.lastTradeDirection === 'CALLE') {
                    direction = 'CALLE';
                    LOGGER.trade(`🔁 RECOVERY: Last was FALL → Trying RISE`);                 
                } else {
                    direction = 'PUTE';
                    LOGGER.trade(`🔁 RECOVERY: Last was RISE → Trying FALL`);
                }
            }
        } else {
            // Fresh trade: use candle direction
            const candleDir = CandleAnalyzer.getCandleDirection(lastCandle);
            if (candleDir === 'BULLISH') {
                direction = 'CALLE';
                LOGGER.trade(`📈 Last candle BULLISH → Executing RISE trade`);
            } else if (candleDir === 'BEARISH') {
                direction = 'PUTE';
                LOGGER.trade(`📉 Last candle BEARISH → Executing FALL trade`);
            } else {
                // DOJI - default to alternating from last direction
                direction = state.lastTradeDirection === 'CALLE' ? 'PUTE' : 'CALLE';
                LOGGER.trade(`⚪ Last candle DOJI → Alternating to ${direction === 'CALLE' ? 'RISE' : 'FALL'}`);
            }
        }

        state.canTrade = false;
        state.lastTradeDirection = direction;

        const modeLabel = state.inRecovery ? 'RECOVERY' : 'FRESH';
        LOGGER.trade(`🎯 [${modeLabel}] Executing ${direction === 'CALLE' ? 'RISE' : 'FALL'} trade on ${symbol}`);
        LOGGER.trade(`   Stake: $${stake.toFixed(2)} | Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT} | Level: ${state.martingaleLevel}`);

        const position = {
            symbol,
            direction,
            stake,
            duration: CONFIG.DURATION,
            durationUnit: CONFIG.DURATION_UNIT,
            entryTime: Date.now(),
            contractId: null,
            reqId: null,
            currentProfit: 0,
            buyPrice: 0
        };

        state.portfolio.activePositions.push(position);

        const tradeRequest = {
            buy: 1,
            subscribe: 1,
            price: stake.toFixed(2),
            parameters: {
                contract_type: direction,
                symbol: symbol,
                currency: 'USD',
                amount: stake.toFixed(2),
                duration: CONFIG.DURATION,
                duration_unit: CONFIG.DURATION_UNIT,
                basis: 'stake'
            }
        };

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;
    }

    // ============================================
    // TRADE WATCHDOG MANAGER
    // ============================================

    _startTradeWatchdog(contractId) {
        const timeoutMs = this.tradeWatchdogMs;

        state.tradeWatchdogTimer = setTimeout(() => {
            if (!state.tradeInProgress) {
                LOGGER.debug('Watchdog fired but trade already completed');
                return;
            }

            LOGGER.warn(
                `⏰ WATCHDOG FIRED — Contract ${contractId} has been open for ` +
                `${(timeoutMs / 1000)}s with no settlement`
            );

            // Step 1: try to poll the contract
            if (contractId && state.isConnected && state.isAuthorized) {
                LOGGER.info(`🔍 Polling contract ${contractId} for current status…`);
                
                // Unsubscribe from old subscription if exists
                this.connection.send({ 
                    forget_all: 'proposal_open_contract'
                });
                
                // Subscribe fresh
                this.connection.send({ 
                    proposal_open_contract: 1, 
                    contract_id: contractId, 
                    subscribe: 1 
                });

                // Give the poll 15 seconds before force recovery
                state.tradeWatchdogPollTimer = setTimeout(() => {
                    if (!state.tradeInProgress) {
                        LOGGER.debug('Poll timer fired but trade already completed');
                        return;
                    }
                    LOGGER.error(
                        `🚨 WATCHDOG: Poll timed out — contract ${contractId} still unresolved ` +
                        `after ${(timeoutMs/ 1000)}s — force-releasing lock`
                    );
                    this._recoverStuckTrade('watchdog-force');
                }, timeoutMs);

            } else {
                LOGGER.error('Cannot poll contract - not connected or authorized');
                this._recoverStuckTrade('watchdog-offline');
            }
        }, timeoutMs);

        LOGGER.debug(`Watchdog started for contract ${contractId} (${timeoutMs}ms)`);
    }

    _clearAllWatchdogTimers() {
        if (state.tradeWatchdogTimer) {
            clearTimeout(state.tradeWatchdogTimer);
            state.tradeWatchdogTimer = null;
        }
        if (state.tradeWatchdogPollTimer) {
            clearTimeout(state.tradeWatchdogPollTimer);
            state.tradeWatchdogPollTimer = null;
        }
    }

    // ============================================
    // RECOVER FROM STUCK TRADE
    // ============================================

    _recoverStuckTrade(reason) {
        LOGGER.warn(`🔄 Entering recovery mode: ${reason}`);
        
        this._clearAllWatchdogTimers();

        const contractId = state.currentContractId;
        const stakeInfo = state.pendingTradeInfo;
        const openSeconds = state.tradeStartTime ? Math.round((Date.now() - state.tradeStartTime) / 1000) : '?';

        LOGGER.error(
            `🚨 STUCK TRADE RECOVERY [${reason}] | Contract: ${contractId} | ` +
            `Open for: ${openSeconds}s | Level: ${state.martingaleLevel}`
        );

        // Mark contract as processed to prevent duplicate handling
        if (contractId) {
            this._processedContracts.add(String(contractId));
        }

        // Remove the stuck position from activePositions
        const posIndex = state.portfolio.activePositions.findIndex(
            p => p.contractId === contractId
        );
        if (posIndex >= 0) {
            state.portfolio.activePositions.splice(posIndex, 1);
            LOGGER.info(`Removed stuck position from activePositions`);
        }

        // Refund the stake to investmentRemaining
        if (stakeInfo && stakeInfo.stake > 0) {
            state.investmentRemaining = Number((state.investmentRemaining + stakeInfo.stake).toFixed(2));
            LOGGER.warn(
                `💰 Stake $${stakeInfo.stake.toFixed(2)} returned to pool (unknown outcome) → ` +
                `pool: $${state.investmentRemaining.toFixed(2)}`
            );
        }

        // Release the lock
        state.tradeInProgress = false;
        state.pendingTradeInfo = null;
        state.currentContractId = null;
        state.tradeStartTime = null;

        // DON'T modify martingale level or inRecovery state
        // Let the user manually verify and adjust if needed
        
        LOGGER.warn(`🔄 Trade lock released. Will retry in 5 seconds…`);

        TelegramService.sendMessage(
            `⚠️ <b>RISE/FALL STUCK TRADE RECOVERED [${reason}]</b>\n` +
            `Contract: ${contractId || 'unknown'}\n` +
            `Open for: ${openSeconds}s\n` +
            `Martingale Level: ${state.martingaleLevel}\n` +
            `Action: stake returned, retrying in 5s\n` +
            `⚠️ IMPORTANT: Manually verify outcome on Deriv\n` +
            `Investment pool: $${state.investmentRemaining.toFixed(2)}\n` +
            `Session P&L: $${state.session.netPL.toFixed(2)}\n` +
            `Recovery Mode: ${state.inRecovery ? 'YES' : 'NO'}`
        );

        StatePersistence.saveState();

        // Resume trading after delay
        if (state.session.isActive) {
            setTimeout(() => {
                if (!state.session.isActive) {
                    LOGGER.warn('Session no longer active, skipping retry');
                    return;
                }
                
                if (state.tradeInProgress) {
                    LOGGER.warn('Another trade already in progress, skipping retry');
                    return;
                }
                
                if (!state.isAuthorized) {
                    LOGGER.warn('⏳ Not authorized yet — trade will resume after reconnect');
                    return;
                }

                LOGGER.trade('🔄 Resuming trading after stuck trade recovery…');
                state.canTrade = true;
                bot.executeNextTrade();
            }, 2000);
        }
    }

    stop() {
        LOGGER.info('🛑 Stopping bot...');
        state.canTrade = false;

        setTimeout(() => {
            if (this.connection.ws) this.connection.ws.close();
            LOGGER.info('👋 Bot stopped');
        }, 2000);
    }

    getStatus() {
        const sessionStats = SessionManager.getSessionStats();

        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            accountBalance: state.accountBalance,
            session: sessionStats,
            lastDirection: state.lastTradeDirection,
            nextDirection: state.lastTradeDirection === 'CALLE' ? 'PUTE' : 'CALLE',
            inRecovery: state.inRecovery,
            waitingForNewCandle: state.waitingForNewCandle,
            activePositionsCount: state.portfolio.activePositions.length,
            activePositions: state.portfolio.activePositions.map(pos => ({
                symbol: pos.symbol,
                direction: pos.direction,
                stake: pos.stake,
                duration: `${pos.duration} ${pos.durationUnit}`,
                profit: pos.currentProfit,
                contractId: pos.contractId
            }))
        };
    }
}

// ============================================
// INITIALIZATION
// ============================================
const bot = new DerivBot();

process.on('SIGINT', () => {
    console.log('\n\n⚠️ Shutdown signal received...');
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

const stateLoaded = StatePersistence.loadState();

if (stateLoaded) {
    LOGGER.info('🔄 Bot will resume from saved state after connection');
} else {
    LOGGER.info('🆕 Bot will start with fresh state');
}

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═'.repeat(80));
    console.log(' DERIV RISE/FALL ALTERNATING BOT');
    console.log('═'.repeat(80));
    console.log('\n⚠️ API Token not configured!\n');
    console.log('Usage:');
    console.log(' API_TOKEN=xxx DURATION=5 DURATION_UNIT=t node risefall-bot.js');
    console.log('═'.repeat(80));
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(' DERIV RISE/FALL ALTERNATING BOT');
console.log(` Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT} | Stake: $${CONFIG.STAKE}`);
console.log('═'.repeat(80));
console.log('\n🚀 Initializing...\n');

// Start time scheduler (weekend pause and EOD rules)
bot.startTimeScheduler();

bot.connection.connect();

setInterval(() => {
    if (state.isAuthorized) {
        const status = bot.getStatus();
        const s = state.session;
        console.log(`\n📊 ${getGMTTime()} | ${status.session.trades} trades | ${status.session.winRate} | $${status.session.netPL.toFixed(2)} | ${status.activePositions.length} active`);
        console.log(`🔄 Mode: ${state.inRecovery ? 'RECOVERY (Level ' + state.martingaleLevel + ')' : state.waitingForNewCandle ? 'WAITING FOR CANDLE' : 'READY'}`);
        if (CONFIG.AUTO_COMPOUNDING) {
            console.log(`💰 Investment Remaining: $${state.investmentRemaining.toFixed(2)} | Base Stake: $${state.baseStake.toFixed(2)}`);
        }
        console.log(`📉 Loss Stats: x2:${s.x2Losses} x3:${s.x3Losses} x4:${s.x4Losses} x5:${s.x5Losses} x6:${s.x6Losses} x7:${s.x7Losses} x8:${s.x8Losses} x9:${s.x9Losses} | Level: ${state.martingaleLevel}`);
    }
}, 30000);
