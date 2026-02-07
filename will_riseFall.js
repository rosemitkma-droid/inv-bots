const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'will_riseFall2-state.json');
const STATE_SAVE_INTERVAL = 5000; // Save every 5 seconds

class StatePersistence {
    static saveState() {
        try {
            const persistableState = {
                savedAt: Date.now(),
                capital: state.capital,
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
                        reqId: pos.reqId,
                        buyPrice: pos.buyPrice,
                        currentProfit: pos.currentProfit
                    }))
                },
                lastTradeDirection: state.lastTradeDirection,
                lastTradeWasWin: state.lastTradeWasWin,
                martingaleLevel: state.martingaleLevel,
                hourlyStats: { ...state.hourlyStats },
                assets: {}
            };

            // FIX: Save essential asset state for each symbol
            Object.keys(state.assets).forEach(symbol => {
                const asset = state.assets[symbol];
                persistableState.assets[symbol] = {
                    // Save last few closed candles for continuity
                    closedCandles: asset.closedCandles.slice(-100),
                    lastProcessedCandleOpenTime: asset.lastProcessedCandleOpenTime,
                    candlesLoaded: asset.candlesLoaded,
                    // WPR State
                    wpr: asset.wpr,
                    prevWpr: asset.prevWpr
                };
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
            // LOGGER.debug('💾 State saved to disk');
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

            // Only restore if state is less than 30 minutes old
            if (ageMinutes > 30) {
                LOGGER.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE); // FIX: Delete old state file
                return false;
            }

            LOGGER.info(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);

            // Restore capital and session
            state.capital = savedData.capital;
            state.session = {
                ...state.session,
                ...savedData.session,
                startTime: savedData.session.startTime || Date.now(), // FIX: Preserve original start time
                startCapital: savedData.session.startCapital || savedData.capital
            };

            // Restore portfolio
            state.portfolio.dailyProfit = savedData.portfolio.dailyProfit;
            state.portfolio.dailyLoss = savedData.portfolio.dailyLoss;
            state.portfolio.dailyWins = savedData.portfolio.dailyWins;
            state.portfolio.dailyLosses = savedData.portfolio.dailyLosses;

            // FIX: Restore active positions with all fields
            state.portfolio.activePositions = (savedData.portfolio.activePositions || []).map(pos => ({
                ...pos,
                entryTime: pos.entryTime || Date.now() // FIX: Ensure entryTime exists
            }));

            // Restore last trade direction and martingale
            state.lastTradeDirection = savedData.lastTradeDirection || null;
            state.lastTradeWasWin = savedData.lastTradeWasWin !== undefined ? savedData.lastTradeWasWin : null;
            state.martingaleLevel = savedData.martingaleLevel || 0;
            state.hourlyStats = savedData.hourlyStats || {
                trades: 0,
                wins: 0,
                losses: 0,
                pnl: 0,
                lastHour: new Date().getHours()
            };

            // FIX: Restore asset states
            if (savedData.assets) {
                Object.keys(savedData.assets).forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = savedData.assets[symbol];
                        const asset = state.assets[symbol];

                        // FIX: Restore closed candles if available
                        if (saved.closedCandles && saved.closedCandles.length > 0) {
                            asset.closedCandles = saved.closedCandles;
                            LOGGER.info(`  📊 Restored ${saved.closedCandles.length} closed candles for ${symbol}`);
                        }

                        // FIX: Restore critical fields
                        asset.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                        asset.candlesLoaded = saved.candlesLoaded || false;

                        // FIX: Restore WPR State
                        asset.wpr = saved.wpr || -50;
                        asset.prevWpr = saved.prevWpr || -50;
                    }
                });
            }

            LOGGER.info(`✅ State restored successfully!`);
            LOGGER.info(`   💰 Capital: $${state.capital.toFixed(2)}`);
            LOGGER.info(`   📊 Session P/L: $${state.session.netPL.toFixed(2)}`);
            LOGGER.info(`   🎯 Trades: ${state.session.tradesCount} (W:${state.session.winsCount} L:${state.session.lossesCount})`);
            LOGGER.info(`   📉 Loss Stats: x2:${state.session.x2Losses} x3:${state.session.x3Losses} x4:${state.session.x4Losses} x5:${state.session.x5Losses} x6:${state.session.x6Losses} x7:${state.session.x7Losses}`);
            LOGGER.info(`   🚀 Active Positions: ${state.portfolio.activePositions.length}`);
            LOGGER.info(`   🔄 Last Direction: ${state.lastTradeDirection || 'None'}`);
            LOGGER.info(`   📈 Martingale Level: ${state.martingaleLevel}`);

            return true;
        } catch (error) {
            LOGGER.error(`Failed to load state: ${error.message}`);
            LOGGER.error(`Stack: ${error.stack}`);
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
            ${emoji} <b>${type} TRADE ALERT</b>
            Asset: ${symbol}
            Direction: ${direction}
            Stake: $${stake.toFixed(2)}
            Duration: ${duration} (${durationUnit == 't' ? 'Ticks' : durationUnit == 's' ? 'Seconds' : 'Minutes'})
            Martingale Level: ${state.martingaleLevel}
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
            📊 <b>SESSION SUMMARY</b>
            Duration: ${stats.duration}
            Trades: ${stats.trades}
            Wins: ${stats.wins} | Losses: ${stats.losses}
            Win Rate: ${stats.winRate}
            Loss Stats: x2:${stats.x2Losses} | x3:${stats.x3Losses} | x4:${stats.x4Losses} | x5:${stats.x5Losses} | x6:${stats.x6Losses} | x7:${stats.x7Losses}
            Net P/L: $${stats.netPL.toFixed(2)}
            Current Capital: $${state.capital.toFixed(2)}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendStartupMessage() {
        const message = `
            🤖 <b>DERIV RISE/FALL BOT STARTED</b>
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
        // FIX #1: Capture stats snapshot BEFORE resetting
        const statsSnapshot = { ...state.hourlyStats };

        // FIX #2: Only send if there are trades to report
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
            ⏰ <b>Rise/Fall Bot Hourly Summary</b>

            📊 <b>Last Hour</b>
            ├ Trades: ${statsSnapshot.trades}
            ├ Wins: ${statsSnapshot.wins} | Losses: ${statsSnapshot.losses}
            ├ Win Rate: ${winRate}%
            └ ${pnlEmoji} <b>P&L:</b> ${pnlStr}

            📈 <b>Daily Totals</b>
            ├ Total Trades: ${state.session.tradesCount}
            ├ Total W/L: ${state.session.winsCount}/${state.session.lossesCount}
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

        // FIX #3: Reset stats AFTER successful send
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
            }, 60 * 60 * 1000); // Every hour
        }, timeUntilNextHour);
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
// TECHNICAL INDICATORS
// ============================================
class TechnicalIndicators {
    /**
     * Calculate Williams Percent Range (WPR) - ONLY on closed candles
     */
    static calculateWPR(candles, period = 80) {
        if (!candles || candles.length < period) {
            return -50;
        }

        const recentCandles = candles.slice(-period);
        const highs = recentCandles.map(c => c.high);
        const lows = recentCandles.map(c => c.low);
        const currentClose = recentCandles[recentCandles.length - 1].close;

        const highestHigh = Math.max(...highs);
        const lowestLow = Math.min(...lows);
        const range = highestHigh - lowestLow;

        if (range === 0) return -50;

        const wpr = ((highestHigh - currentClose) / range) * -100;
        return wpr;
    }
}

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // API Settings
    API_TOKEN: '0P94g4WdSrSrzir',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Capital Settings
    INITIAL_CAPITAL: 500,
    STAKE: 1,

    // Session Targets
    SESSION_PROFIT_TARGET: 5000,
    SESSION_STOP_LOSS: -250,

    // Candle Settings
    GRANULARITY: 60, // 60 seconds = 1 minute candles
    TIMEFRAME_LABEL: '1m',
    MAX_CANDLES_STORED: 100,
    CANDLES_TO_LOAD: 100, // Increased for WPR period

    // WPR Settings
    WPR_PERIOD: 80,
    WPR_OVERBOUGHT: -20,
    WPR_OVERSOLD: -80,

    // Trade Duration Settings
    DURATION: 54,
    DURATION_UNIT: 's', // t=ticks, s=seconds, m=minutes

    // Trade Settings
    MAX_OPEN_POSITIONS: 1, // One at a time for alternating strategy
    TRADE_DELAY: 1000, // 2 seconds delay between trades
    MARTINGALE_MULTIPLIER: 2,
    MARTINGALE_MULTIPLIER2: 2.3,
    MARTINGALE_MULTIPLIER3: 2.5,
    MARTINGALE_MULTIPLIER4: 2.3,
    MARTINGALE_MULTIPLIER5: 3,
    MAX_MARTINGALE_STEPS: 7,
    System: 1,
    iDirection: 'RISE',

    // Debug
    DEBUG_MODE: true,

    // Telegram Settings
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8306232249:AAGMwjFngs68Lcq27oGmqewQgthXTJJRxP0',
    TELEGRAM_CHAT_ID: '752497117',
};


let ACTIVE_ASSETS = [
    // 'R_75', 'R_100', '1HZ25V', '1HZ50V', '1HZ100V' 'stpRNG',
    'R_100'
];

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    assets: {}, // Add this to the state object
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    currentStake: CONFIG.STAKE,
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
    lastTradeDirection: null, // 'CALLE' or 'PUTE'
    lastTradeWasWin: null, // NEW: track if last trade won
    martingaleLevel: 0,
    hourlyStats: {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        lastHour: new Date().getHours()
    },
    requestId: 1,
    canTrade: false
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

        if (netPL <= CONFIG.SESSION_STOP_LOSS || state.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS) {
            LOGGER.error(`🛑 SESSION STOP LOSS REACHED! Net P/L: $${netPL.toFixed(2)}`);
            this.endSession('STOP_LOSS');
            return true;
        }

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
            netPL: state.session.netPL
        };
    }

    static recordTradeResult(profit, direction) {
        // Check if hour has changed
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

        // Update hourly stats
        state.hourlyStats.trades++;
        state.hourlyStats.pnl += profit;

        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            state.martingaleLevel = 0;
            state.hourlyStats.wins++;
            state.lastTradeWasWin = true; // NEW
            state.currentStake = CONFIG.STAKE;

            LOGGER.trade(`✅ WIN: +$${profit.toFixed(2)} | Direction: ${direction} | Martingale Reset`);
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            state.hourlyStats.losses++;
            state.martingaleLevel++;
            state.lastTradeWasWin = false; // NEW

            if (state.martingaleLevel === 2) state.session.x2Losses++;
            if (state.martingaleLevel === 3) state.session.x3Losses++;
            if (state.martingaleLevel === 4) state.session.x4Losses++;
            if (state.martingaleLevel === 5) state.session.x5Losses++;
            if (state.martingaleLevel === 6) state.session.x6Losses++;
            if (state.martingaleLevel === 7) state.session.x7Losses++;


            // Martingale Multiplier
            if (state.martingaleLevel <= 3) {
                state.currentStake = Math.ceil(state.currentStake * CONFIG.MARTINGALE_MULTIPLIER * 100) / 100;
            };
            if (state.martingaleLevel >= 4 && state.martingaleLevel <= 10) {
                state.currentStake = Math.ceil(state.currentStake * CONFIG.MARTINGALE_MULTIPLIER2 * 100) / 100;
            };
            if (state.martingaleLevel >= 11 && state.martingaleLevel <= 15) {
                state.currentStake = Math.ceil(state.currentStake * CONFIG.MARTINGALE_MULTIPLIER3 * 100) / 100;
            };
            if (state.martingaleLevel >= 16 && state.martingaleLevel <= 20) {
                state.currentStake = Math.ceil(state.currentStake * CONFIG.MARTINGALE_MULTIPLIER4 * 100) / 100;
            };
            if (state.martingaleLevel >= 21 && state.martingaleLevel <= 25) {
                state.currentStake = Math.ceil(state.currentStake * CONFIG.MARTINGALE_MULTIPLIER5 * 100) / 100;
            };


            if (state.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS) {
                LOGGER.warn(`⚠️ Maximum Martingale step reached (${CONFIG.MAX_MARTINGALE_STEPS}), resetting level to 0`);
                state.martingaleLevel = 0;
            } else {
                LOGGER.trade(`❌ LOSS: -$${Math.abs(profit).toFixed(2)} | Direction: ${direction} | Next Martingale Level: ${state.martingaleLevel}`);
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
        this.isReconnecting = false; // FIX: Track reconnection state
        this.activeSubscriptions = new Set(); // FIX: Track active subscriptions
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            LOGGER.info('Already connected');
            return;
        }

        LOGGER.info('🔌 Connecting to Deriv API...');

        // FIX: Clean up any existing connection
        this.cleanup();

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
        this.isReconnecting = false; // FIX: Reset reconnecting flag

        this.startPing();

        if (!this.autoSaveStarted) {
            StatePersistence.startAutoSave();
            this.autoSaveStarted = true;
        }

        this.send({ authorize: CONFIG.API_TOKEN });
    }

    initializeAssets() {
        ACTIVE_ASSETS.forEach(symbol => {
            // Only initialize if not already present (to preserve loaded state)
            if (!state.assets[symbol]) {
                state.assets[symbol] = {
                    candles: [],
                    closedCandles: [],
                    currentFormingCandle: null,
                    lastProcessedCandleOpenTime: null,
                    candlesLoaded: false,
                    // WPR Initialization
                    wpr: -50,
                    prevWpr: -50
                };
                LOGGER.info(`📊 Initialized asset: ${symbol}`);
            } else {
                LOGGER.info(`📊 Asset ${symbol} already initialized (state restored)`);
            }
        });
    }

    // FIX: Add method to restore subscriptions after reconnection
    restoreSubscriptions() {
        LOGGER.info('📊 Restoring subscriptions after reconnection...');

        // Resubscribe to active positions
        state.portfolio.activePositions.forEach(pos => {
            if (pos.contractId) {
                LOGGER.info(`  ✅ Re-subscribing to contract ${pos.contractId}`);
                this.send({
                    proposal_open_contract: 1,
                    contract_id: pos.contractId,
                    subscribe: 1
                });
            }
        });
    }

    // FIX: Add cleanup method
    cleanup() {
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try {
                    this.ws.close();
                } catch (e) {
                    LOGGER.debug('WebSocket already closed');
                }
            }
            this.ws = null;
        }
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

            if (state.capital === CONFIG.INITIAL_CAPITAL) {
                state.capital = response.authorize.balance;
            }

            this.send({ balance: 1, subscribe: 1 });

            // FIX: Restore subscriptions after reconnection
            if (this.reconnectAttempts > 0 || state.portfolio.activePositions.length > 0) {
                LOGGER.info('🔄 Reconnection detected, restoring subscriptions...');
                this.restoreSubscriptions();
            }

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

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);

            // Remove failed position
            const reqId = response.echo_req?.req_id;
            if (reqId) {
                const posIndex = state.portfolio.activePositions.findIndex(p => p.reqId === reqId);
                if (posIndex >= 0) {
                    state.portfolio.activePositions.splice(posIndex, 1);
                }
            }

            return;
        }

        const contract = response.buy;
        LOGGER.trade(`✅ Position opened: Contract ${contract.contract_id}, Buy Price: $${contract.buy_price}`);

        const reqId = response.echo_req.req_id;
        const position = state.portfolio.activePositions.find(p => p.reqId === reqId);

        if (position) {
            position.contractId = contract.contract_id;
            position.buyPrice = contract.buy_price;

            TelegramService.sendTradeAlert(
                'OPEN',
                position.symbol,
                position.direction,
                position.stake,
                position.duration,
                position.durationUnit
            );
        }

        // Subscribe to contract updates
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
        const posIndex = state.portfolio.activePositions.findIndex(
            p => p.contractId === contractId
        );

        if (posIndex < 0) return;

        const position = state.portfolio.activePositions[posIndex];
        position.currentProfit = contract.profit;

        // Contract closed
        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
            const profit = contract.profit;

            LOGGER.trade(`Contract ${contractId} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`);

            SessionManager.recordTradeResult(profit, position.direction);

            TelegramService.sendTradeAlert(
                profit >= 0 ? 'WIN' : 'LOSS',
                position.symbol,
                position.direction,
                position.stake,
                position.duration,
                position.durationUnit,
                { profit }
            );

            state.portfolio.activePositions.splice(posIndex, 1);

            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }

            SessionManager.checkSessionTargets();
            StatePersistence.saveState();
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

                // TRIGGER TRADE AFTER CANDLE CLOSE
                // setTimeout(() => {
                state.canTrade = true;
                bot.executeNextTrade(symbol, closedCandle);
                // }, 500); // Small delay to ensure candle is fully processed
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

        LOGGER.info(`📊 Loaded ${candles.length} ${CONFIG.TIMEFRAME_LABEL} candles for ${symbol}`);

    }

    onError(error) {
        LOGGER.error(`WebSocket error: ${error.message}`);
    }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;

        this.stopPing();

        // FIX: Save state immediately on disconnect
        StatePersistence.saveState();

        // FIX: Prevent duplicate reconnection attempts
        if (this.isReconnecting) {
            LOGGER.info('Already handling disconnect, skipping...');
            return;
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.isReconnecting = true;
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            LOGGER.info(`📊 Preserved state - Trades: ${state.session.tradesCount}, P&L: $${state.session.netPL.toFixed(2)}`);

            TelegramService.sendMessage(`⚠️ <b>CONNECTION LOST - RECONNECTING</b>\n📊 Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n⏱️ Retrying in ${(delay / 1000).toFixed(1)}s\n💾 State preserved: ${state.session.tradesCount} trades, $${state.session.netPL.toFixed(2)} P&L`);

            setTimeout(() => {
                this.isReconnecting = false; // FIX: Reset flag before connecting
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            TelegramService.sendMessage(`🛑 <b>BOT STOPPED</b>\nMax reconnection attempts reached.\nFinal P&L: $${state.session.netPL.toFixed(2)}`);
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
    }

    async start() {
        console.log('\n' + '═'.repeat(80));
        console.log(' DERIV RISE/FALL CANDLE-BASED BOT');
        console.log('═'.repeat(80));
        console.log(`💰 Initial Capital: $${state.capital}`);
        console.log(`📊 Active Assets: ${ACTIVE_ASSETS.join(', ')}`);
        console.log(`💵 Stake: $${CONFIG.STAKE}`);
        console.log(`⏱️ Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT}`);
        console.log(`🕯️ Candle Timeframe: ${CONFIG.TIMEFRAME_LABEL}`);
        console.log(`🎯 Session Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`);
        console.log(`📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ENABLED' : 'DISABLED'}`);
        console.log('═'.repeat(80));
        console.log('📋 Strategy: WPR Cross + Recovery System');
        console.log('    🟢 Buy: WPR Cross > -20 + Bullish Candle');
        console.log('    🔴 Sell: WPR Cross < -80 + Bearish Candle');
        console.log('    🔄 Recovery: Alternate on Loss');
        console.log('═'.repeat(80) + '\n');

        // Initialize assets
        this.connection.initializeAssets();

        // Subscribe to candles for each asset
        ACTIVE_ASSETS.forEach(symbol => {
            this.subscribeToCandles(symbol);
        });

        TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();

        LOGGER.info('✅ Bot started successfully!');
    }

    subscribeToCandles(symbol) {
        LOGGER.info(`📊 Subscribing to ${CONFIG.TIMEFRAME_LABEL} candles for ${symbol}...`);

        // First, get historical candles
        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: CONFIG.CANDLES_TO_LOAD,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: CONFIG.GRANULARITY
        });

        // Then subscribe to live candle updates
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

    executeNextTrade(symbol, lastClosedCandle) {
        if (!state.canTrade) return;
        if (!SessionManager.isSessionActive()) return;
        if (state.portfolio.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) return;

        // Use symbol parameter or default to first asset
        const tradeSymbol = symbol || ACTIVE_ASSETS[0];
        const assetState = state.assets[tradeSymbol];
        const stake = state.currentStake;

        if (state.capital < stake) {
            LOGGER.error(`Insufficient capital for stake: $${state.capital.toFixed(2)} (Needed: $${stake.toFixed(2)})`);
            if (state.martingaleLevel > 0) {
                LOGGER.info('Resetting Martingale level due to insufficient capital.');
                state.martingaleLevel = 0;
            }
            return;
        }

        // 1. Calculate WPR
        const currentWPR = TechnicalIndicators.calculateWPR(assetState.closedCandles, CONFIG.WPR_PERIOD);

        // 2. Determing logic based on Trading State (Loss Recovery or Normal)
        let direction = null;
        let signalReason = '';

        const isRecoveryMode = state.lastTradeWasWin === false; // If last trade was LOSS, we are in recovery

        if (isRecoveryMode) {
            // RECOVERY MODE: Alternate direction
            // "If the trade was a loss, on new Candle open, bot should open a Sell trade" (if prev was Buy)
            // "If the trade was a loss, on new Candle open, bot should open a Buy trade" (if prev was Sell)

            if (state.lastTradeDirection === 'CALLE') {
                direction = 'PUTE'; // Prev was Rise, now Fall
                signalReason = 'Recovery (Prev LOSS on RISE)';
            } else {
                direction = 'CALLE'; // Prev was Fall, now Rise
                signalReason = 'Recovery (Prev LOSS on FALL)';
            }
            LOGGER.trade(`� RECOVERY MODE: Switching direction. ${signalReason}`);

        } else {
            // NORMAL MODE: Check WPR Signals
            // Store previous WPR to detect crossing
            const prevWpr = assetState.prevWpr;

            // Buy Signal: WPR crosses ABOVE -20 and Previous Candle Bullish
            const wprCrossAbove = prevWpr <= CONFIG.WPR_OVERBOUGHT && currentWPR > CONFIG.WPR_OVERBOUGHT;
            if (wprCrossAbove && CandleAnalyzer.isBullish(lastClosedCandle)) {
                direction = 'CALLE'; // RISE
                signalReason = `WPR Cross Above ${CONFIG.WPR_OVERBOUGHT} (${prevWpr.toFixed(2)} -> ${currentWPR.toFixed(2)}) + Bullish Candle`;
            }

            // Sell Signal: WPR crosses BELOW -80 and Previous Candle Bearish
            const wprCrossBelow = prevWpr >= CONFIG.WPR_OVERSOLD && currentWPR < CONFIG.WPR_OVERSOLD;
            if (wprCrossBelow && CandleAnalyzer.isBearish(lastClosedCandle)) {
                direction = 'PUTE'; // FALL
                signalReason = `WPR Cross Below ${CONFIG.WPR_OVERSOLD} (${prevWpr.toFixed(2)} -> ${currentWPR.toFixed(2)}) + Bearish Candle`;
            }

            if (direction) {
                LOGGER.trade(`⚡ SIGNAL DETECTED: ${signalReason}`);
            }
        }

        // Update WPR state for next check (Crucial for crossing detection)
        assetState.prevWpr = currentWPR;
        // Save state to persist prevWpr
        StatePersistence.saveState();

        if (!direction) {
            // LOGGER.info(`${tradeSymbol} WPR: ${currentWPR.toFixed(2)} | No Signal`);
            return;
        }

        state.canTrade = false; // Prevent multiple trades
        state.lastTradeDirection = direction;

        LOGGER.trade(`🎯 Executing ${direction === 'CALLE' ? 'RISE' : 'FALL'} trade on ${tradeSymbol}`);
        LOGGER.trade(`   Stake: $${stake.toFixed(2)} | Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT} | Martingale Level: ${state.martingaleLevel}`);
        LOGGER.trade(`   Reason: ${signalReason} | WPR: ${currentWPR.toFixed(2)}`);

        const position = {
            symbol: tradeSymbol,
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
                symbol: tradeSymbol,
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

    stop() {
        LOGGER.info('🛑 Stopping bot...');
        state.canTrade = false;

        setTimeout(() => {
            if (this.connection.ws) this.connection.ws.close();
            LOGGER.info('👋 Bot stopped');
        }, 2000);
    }

    // FIX: Add checkTimeForDisconnectReconnect() method from mX4Differ.js
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
                if (state.session.isActive) {
                    LOGGER.info("Weekend trading suspension (Saturday 11pm - Monday 2am). Disconnecting...");
                    TelegramService.sendHourlySummary();
                    if (this.connection.ws) this.connection.ws.close();
                    state.session.isActive = false;
                }
                return; // Prevent any reconnection logic during the weekend
            }

            // Reconnect at 2:00 AM GMT+1 if session is not active
            if (!state.session.isActive && currentHours === 2 && currentMinutes >= 0) {
                LOGGER.info("It's 2:00 AM GMT+1, reconnecting the bot.");
                this.resetDailyStats();
                state.session.isActive = true;
                this.connection.connect();
            }

            // Disconnect after 23:00 PM GMT+1 if last trade was a win
            if (state.lastTradeWasWin && state.session.isActive) {
                if (currentHours >= 23 && currentMinutes >= 0) {
                    LOGGER.info("It's past 23:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    TelegramService.sendHourlySummary();
                    if (this.connection.ws) this.connection.ws.close();
                    state.session.isActive = false;
                }
            }
        }, 20000); // Check every 20 seconds
    }

    resetDailyStats() {
        state.session.tradesCount = 0;
        state.session.winsCount = 0;
        state.session.lossesCount = 0;
        state.session.profit = 0;
        state.session.loss = 0;
        state.session.netPL = 0;
        state.session.x2Losses = 0;
        state.session.x3Losses = 0;
        state.session.x4Losses = 0;
        state.session.x5Losses = 0;
        state.session.x6Losses = 0;
        state.session.x7Losses = 0;
        state.martingaleLevel = 0;
        state.currentStake = CONFIG.STAKE;
        state.lastTradeWasWin = null;
        state.canTrade = false;
        LOGGER.info('📊 Daily stats reset');
    }

    getStatus() {
        const sessionStats = SessionManager.getSessionStats();

        const nextDirection = state.lastTradeWasWin === null
            ? 'CALLE (First trade)'
            : state.lastTradeWasWin
                ? state.lastTradeDirection // Same if won
                : (state.lastTradeDirection === 'CALLE' ? 'PUTE' : 'CALLE'); // Switch if lost

        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            accountBalance: state.accountBalance,
            session: sessionStats,
            lastDirection: state.lastTradeDirection,
            lastWasWin: state.lastTradeWasWin,
            nextDirection: nextDirection,
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

// Load saved state
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
    console.log('\nEnvironment Variables:');
    console.log(' API_TOKEN - Deriv API token (required)');
    console.log(' CAPITAL - Initial capital (default: 1000)');
    console.log(' STAKE - Stake per trade (default: 1)');
    console.log(' DURATION - Contract duration (default: 1)');
    console.log(' DURATION_UNIT - t=ticks, s=seconds, m=minutes (default: t)');
    console.log(' PROFIT_TARGET - Session profit target (default: 1000)');
    console.log(' STOP_LOSS - Session stop loss (default: -500)');
    console.log(' TELEGRAM_ENABLED - Enable Telegram (default: false)');
    console.log(' TELEGRAM_BOT_TOKEN - Telegram bot token');
    console.log(' TELEGRAM_CHAT_ID - Telegram chat ID');
    console.log('═'.repeat(80));
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(' DERIV RISE/FALL ALTERNATING BOT');
console.log(` Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT} | Stake: $${CONFIG.STAKE}`);
console.log('═'.repeat(80));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

// FIX: Start the time-based disconnect/reconnect checker
// bot.checkTimeForDisconnectReconnect();

// Status display every 30 seconds
setInterval(() => {
    if (state.isAuthorized) {
        const status = bot.getStatus();
        const s = state.session;
        console.log(`\n📊 ${getGMTTime()} | ${status.session.trades} trades | ${status.session.winRate} | $${status.session.netPL.toFixed(2)} | ${status.activePositions.length} active`);
        console.log(`📉 Loss Stats: x2:${s.x2Losses} x3:${s.x3Losses} x4:${s.x4Losses} x5:${s.x5Losses} x6:${s.x6Losses} x7:${s.x7Losses} | Level: ${state.martingaleLevel}`);
    }
}, 30000);
