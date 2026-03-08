const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'fractal_riseFall00000002-state.json');
const STATE_SAVE_INTERVAL = 5000;

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

            Object.keys(state.assets).forEach(symbol => {
                const asset = state.assets[symbol];
                persistableState.assets[symbol] = {
                    closedCandles: asset.closedCandles.slice(-100),
                    lastProcessedCandleOpenTime: asset.lastProcessedCandleOpenTime,
                    candlesLoaded: asset.candlesLoaded,
                    lastFractalHigh: asset.lastFractalHigh,
                    lastFractalLow: asset.lastFractalLow,
                    tradedFractalHigh: asset.tradedFractalHigh,
                    tradedFractalLow: asset.tradedFractalLow
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
                LOGGER.warn(
                    `⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`
                );
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            LOGGER.info(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);

            state.capital = savedData.capital;
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

            state.portfolio.activePositions = (
                savedData.portfolio.activePositions || []
            ).map(pos => ({
                ...pos,
                entryTime: pos.entryTime || Date.now()
            }));

            state.lastTradeDirection =
                savedData.lastTradeDirection || null;
            state.lastTradeWasWin =
                savedData.lastTradeWasWin !== undefined
                    ? savedData.lastTradeWasWin
                    : null;
            state.martingaleLevel = savedData.martingaleLevel || 0;
            state.hourlyStats = savedData.hourlyStats || {
                trades: 0,
                wins: 0,
                losses: 0,
                pnl: 0,
                lastHour: new Date().getHours()
            };

            if (savedData.assets) {
                Object.keys(savedData.assets).forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = savedData.assets[symbol];
                        const asset = state.assets[symbol];

                        if (
                            saved.closedCandles &&
                            saved.closedCandles.length > 0
                        ) {
                            asset.closedCandles = saved.closedCandles;
                            LOGGER.info(
                                `  📊 Restored ${saved.closedCandles.length} closed candles for ${symbol}`
                            );
                        }

                        asset.lastProcessedCandleOpenTime =
                            saved.lastProcessedCandleOpenTime || 0;
                        asset.candlesLoaded =
                            saved.candlesLoaded || false;

                        asset.lastFractalHigh =
                            saved.lastFractalHigh || null;
                        asset.lastFractalLow =
                            saved.lastFractalLow || null;
                        asset.tradedFractalHigh = saved.tradedFractalHigh || null;
                        asset.tradedFractalLow = saved.tradedFractalLow || null;
                    }
                });
            }

            LOGGER.info(`✅ State restored successfully!`);
            LOGGER.info(
                `   💰 Capital: $${state.capital.toFixed(2)}`
            );
            LOGGER.info(
                `   📊 Session P/L: $${state.session.netPL.toFixed(2)}`
            );
            LOGGER.info(
                `   🎯 Trades: ${state.session.tradesCount} (W:${state.session.winsCount} L:${state.session.lossesCount})`
            );
            LOGGER.info(
                `   📉 Loss Stats: x2:${state.session.x2Losses} x3:${state.session.x3Losses} x4:${state.session.x4Losses} x5:${state.session.x5Losses} x6:${state.session.x6Losses} x7:${state.session.x7Losses}`
            );
            LOGGER.info(
                `   🚀 Active Positions: ${state.portfolio.activePositions.length}`
            );
            LOGGER.info(
                `   🔄 Last Direction: ${state.lastTradeDirection || 'None'}`
            );
            LOGGER.info(
                `   📈 Martingale Level: ${state.martingaleLevel}`
            );

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
        LOGGER.info(
            `💾 Auto-save enabled (every ${STATE_SAVE_INTERVAL / 1000}s)`
        );
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
                const req = https.request(url, options, res => {
                    let body = '';
                    res.on('data', chunk => (body += chunk));
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            resolve(true);
                        } else {
                            reject(new Error(body));
                        }
                    });
                });
                req.on('error', error => {
                    reject(error);
                });
                req.write(data);
                req.end();
            });
        } catch (error) {
            LOGGER.error(
                `Failed to send Telegram message: ${error.message}`
            );
        }
    }

    static async sendTradeAlert(
        type,
        symbol,
        direction,
        stake,
        duration,
        durationUnit,
        details = {}
    ) {
        const emoji =
            type === 'OPEN'
                ? '🚀'
                : type === 'WIN'
                    ? '✅'
                    : '❌';
        const stats = SessionManager.getSessionStats();
        const message = `
            ${emoji} <b>${type} TRADE ALERT</b>
            Asset: ${symbol}
            Direction: ${direction}
            Stake: $${stake.toFixed(2)}
            Duration: ${duration} (${durationUnit == 't' ? 'Ticks' : durationUnit == 's' ? 'Seconds' : 'Minutes'})
            Martingale Level: ${state.martingaleLevel}
            ${details.profit !== undefined
                ? `Profit: $${details.profit.toFixed(2)}
            Total P&L: $${state.session.netPL.toFixed(2)}
            Wins: ${state.session.winsCount}/${state.session.lossesCount}
            Win Rate: ${stats.winRate}%
            `
                : ''
            }
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
            Strategy: Fractal Breakout (MT5 Logic)
            Capital: $${CONFIG.INITIAL_CAPITAL}
            Stake: $${CONFIG.STAKE}
            Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT}
            Assets: ${ACTIVE_ASSETS.join(', ')}
            Session Target: $${CONFIG.SESSION_PROFIT_TARGET}
            Stop Loss: $${CONFIG.SESSION_STOP_LOSS}
            🕐 London Session: ${CONFIG.LONDON_START}:00 - ${CONFIG.LONDON_END}:00 (GMT+1)
            🕐 New York Session: ${CONFIG.NEWYORK_START}:00 - ${CONFIG.NEWYORK_END}:00 (GMT+1)
        `.trim();
        await this.sendMessage(message);
    }

    static async sendHourlySummary() {
        const statsSnapshot = { ...state.hourlyStats };

        if (statsSnapshot.trades === 0) {
            LOGGER.info(
                '📱 Telegram: Skipping hourly summary (no trades this hour)'
            );
            return;
        }

        const totalTrades = statsSnapshot.wins + statsSnapshot.losses;
        const winRate =
            totalTrades > 0
                ? ((statsSnapshot.wins / totalTrades) * 100).toFixed(1)
                : 0;
        const pnlEmoji = statsSnapshot.pnl >= 0 ? '🟢' : '🔴';
        const pnlStr =
            (statsSnapshot.pnl >= 0 ? '+' : '') +
            '$' +
            statsSnapshot.pnl.toFixed(2);

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
            ├ Daily P&L: ${state.session.netPL >= 0 ? '+' : ''}$${state.session.netPL.toFixed(2)}
            └ Current Capital: $${state.capital.toFixed(2)}

            ⏰ ${new Date().toLocaleString()}
        `.trim();

        try {
            await this.sendMessage(message);
            LOGGER.info('📱 Telegram: Hourly Summary sent');
            LOGGER.info(
                `   📊 Hour Stats: ${statsSnapshot.trades} trades, ${statsSnapshot.wins}W/${statsSnapshot.losses}L, ${pnlStr}`
            );
        } catch (error) {
            LOGGER.error(
                `❌ Telegram hourly summary failed: ${error.message}`
            );
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
// LOGGER UTILITY
// ============================================
const getGMTTime = () =>
    new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';

const LOGGER = {
    info: msg => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: msg =>
        console.log(
            `\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`
        ),
    warn: msg =>
        console.warn(
            `\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`
        ),
    error: msg =>
        console.error(
            `\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`
        ),
    debug: msg => {
        if (CONFIG.DEBUG_MODE)
            console.log(
                `\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`
            );
    }
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
        if (
            !assetState ||
            !assetState.closedCandles ||
            assetState.closedCandles.length === 0
        ) {
            return null;
        }
        return assetState.closedCandles[
            assetState.closedCandles.length - 1
        ];
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
    static findFractals(closedCandles) {
        const result = {
            fractalHigh: null,
            fractalLow: null,
            fractalHighIndex: null,
            fractalLowIndex: null
        };

        if (!closedCandles || closedCandles.length < 5) {
            return result;
        }

        const len = closedCandles.length;

        for (let i = len - 3; i >= 2; i--) {
            const c = closedCandles;

            if (result.fractalHigh === null) {
                if (
                    c[i].high > c[i - 1].high &&
                    c[i].high > c[i - 2].high &&
                    c[i].high > c[i + 1].high &&
                    c[i].high > c[i + 2].high
                ) {
                    result.fractalHigh = c[i].high;
                    result.fractalHighIndex = i;
                }
            }

            if (result.fractalLow === null) {
                if (
                    c[i].low < c[i - 1].low &&
                    c[i].low < c[i - 2].low &&
                    c[i].low < c[i + 1].low &&
                    c[i].low < c[i + 2].low
                ) {
                    result.fractalLow = c[i].low;
                    result.fractalLowIndex = i;
                }
            }

            if (
                result.fractalHigh !== null &&
                result.fractalLow !== null
            ) {
                break;
            }
        }

        return result;
    }

    static findAllFractals(closedCandles) {
        const highs = [];
        const lows = [];

        if (!closedCandles || closedCandles.length < 5) {
            return { highs, lows };
        }

        const len = closedCandles.length;

        for (let i = 2; i <= len - 3; i++) {
            const c = closedCandles;

            if (
                c[i].high > c[i - 1].high &&
                c[i].high > c[i - 2].high &&
                c[i].high > c[i + 1].high &&
                c[i].high > c[i + 2].high
            ) {
                highs.push({
                    price: c[i].high,
                    index: i,
                    time: c[i].epoch
                });
            }

            if (
                c[i].low < c[i - 1].low &&
                c[i].low < c[i - 2].low &&
                c[i].low < c[i + 1].low &&
                c[i].low < c[i + 2].low
            ) {
                lows.push({
                    price: c[i].low,
                    index: i,
                    time: c[i].epoch
                });
            }
        }

        return { highs, lows };
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
    GRANULARITY: 60,
    TIMEFRAME_LABEL: '1m',
    MAX_CANDLES_STORED: 100,
    CANDLES_TO_LOAD: 100,

    // Trade Duration Settings
    DURATION: 54,
    DURATION_UNIT: 's',

    // Trade Settings
    MAX_OPEN_POSITIONS: 1,
    TRADE_DELAY: 1000,
    MARTINGALE_MULTIPLIER: 1.48,
    MARTINGALE_MULTIPLIER2: 2.2,
    MARTINGALE_MULTIPLIER3: 2.3,
    MARTINGALE_MULTIPLIER4: 2.5,
    MARTINGALE_MULTIPLIER5: 3,
    MAX_MARTINGALE_STEPS: 9,
    System: 1,
    iDirection: 'RISE',

    // ============================================
    // TRADING SESSION WINDOWS (GMT+1 hours)
    // ============================================
    // London Session: 8:00 AM - 9:00 AM GMT+1
    LONDON_START: 1,
    LONDON_END: 12,
    // New York Session: 1:00 PM - 2:00 PM GMT+1
    NEWYORK_START: 12,
    NEWYORK_END: 23,

    // Debug
    DEBUG_MODE: true,

    // Telegram Settings
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '7683695132:AAGA9_4uDcyZWEOAwv1_zj7Nnz5Oy0gVw04',
    TELEGRAM_CHAT_ID: '752497117'
};

let ACTIVE_ASSETS = ['1HZ75V'];

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    assets: {},
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
    lastTradeDirection: null,
    lastTradeWasWin: null,
    martingaleLevel: 0,
    hourlyStats: {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        lastHour: new Date().getHours()
    },
    requestId: 1,
    canTrade: false,
    // NEW: Track whether we've logged "outside session" to avoid log spam
    lastSessionLogTime: 0
};

// ============================================
// TRADING SESSION HELPER
// ============================================
class TradingSessionManager {
    /**
     * Get current time in GMT+1
     * @returns {Date} Current time adjusted to GMT+1
     */
    static getGMTPlus1Time() {
        const now = new Date();
        // Create a date in GMT+1 by adding 1 hour offset to UTC
        const gmtPlus1 = new Date(now.getTime() + (1 * 60 * 60 * 1000));
        return gmtPlus1;
    }

    /**
     * Check if current time is within a trading session window
     * Uses GMT+1 timezone
     * @returns {{ inSession: boolean, sessionName: string, nextSession: string, minutesUntilNext: number }}
     */
    static isWithinTradingSession() {
        const gmtPlus1 = this.getGMTPlus1Time();
        const currentHour = gmtPlus1.getUTCHours();
        const currentMinute = gmtPlus1.getUTCMinutes();
        const currentTimeDecimal = currentHour + (currentMinute / 60);

        // Check London Session
        if (currentTimeDecimal >= CONFIG.LONDON_START && currentTimeDecimal < CONFIG.LONDON_END) {
            return {
                inSession: true,
                sessionName: 'LONDON',
                nextSession: null,
                minutesUntilNext: 0
            };
        }

        // Check New York Session
        if (currentTimeDecimal >= CONFIG.NEWYORK_START && currentTimeDecimal < CONFIG.NEWYORK_END) {
            return {
                inSession: true,
                sessionName: 'NEW YORK',
                nextSession: null,
                minutesUntilNext: 0
            };
        }

        // Not in any session — calculate next session
        let nextSession = '';
        let minutesUntilNext = 0;

        if (currentTimeDecimal < CONFIG.LONDON_START) {
            // Before London session
            nextSession = 'LONDON';
            minutesUntilNext = (CONFIG.LONDON_START - currentTimeDecimal) * 60;
        } else if (currentTimeDecimal >= CONFIG.LONDON_END && currentTimeDecimal < CONFIG.NEWYORK_START) {
            // Between London and New York
            nextSession = 'NEW YORK';
            minutesUntilNext = (CONFIG.NEWYORK_START - currentTimeDecimal) * 60;
        } else {
            // After New York session — next is London tomorrow
            nextSession = 'LONDON (tomorrow)';
            minutesUntilNext = ((24 - currentTimeDecimal) + CONFIG.LONDON_START) * 60;
        }

        return {
            inSession: false,
            sessionName: null,
            nextSession: nextSession,
            minutesUntilNext: Math.round(minutesUntilNext)
        };
    }

    /**
     * Get a formatted string of current session status
     */
    static getSessionStatusString() {
        const sessionInfo = this.isWithinTradingSession();
        const gmtPlus1 = this.getGMTPlus1Time();
        const timeStr = `${String(gmtPlus1.getUTCHours()).padStart(2, '0')}:${String(gmtPlus1.getUTCMinutes()).padStart(2, '0')} GMT+1`;

        if (sessionInfo.inSession) {
            return `🟢 IN SESSION: ${sessionInfo.sessionName} (${timeStr})`;
        } else {
            return `🔴 OUTSIDE SESSION (${timeStr}) — Next: ${sessionInfo.nextSession} in ${sessionInfo.minutesUntilNext}min`;
        }
    }
}

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
            LOGGER.trade(
                `🎯 SESSION PROFIT TARGET REACHED! Net P/L: $${netPL.toFixed(2)}`
            );
            this.endSession('PROFIT_TARGET');
            return true;
        }

        if (
            netPL <= CONFIG.SESSION_STOP_LOSS ||
            state.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS
        ) {
            LOGGER.error(
                `🛑 SESSION STOP LOSS REACHED! Net P/L: $${netPL.toFixed(2)}`
            );
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
            winRate:
                state.session.tradesCount > 0
                    ? (
                        (state.session.winsCount /
                            state.session.tradesCount) *
                        100
                    ).toFixed(1) + '%'
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
        const currentHour = new Date().getHours();
        if (currentHour !== state.hourlyStats.lastHour) {
            LOGGER.warn(
                `⏰ Hour changed detected (${state.hourlyStats.lastHour} → ${currentHour}), resetting hourly stats`
            );
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
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            state.martingaleLevel = 0;
            state.hourlyStats.wins++;
            state.lastTradeWasWin = true;
            state.currentStake = CONFIG.STAKE;

            LOGGER.trade(
                `✅ WIN: +$${profit.toFixed(2)} | Direction: ${direction} | Martingale Reset`
            );
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            state.hourlyStats.losses++;
            state.martingaleLevel++;
            state.lastTradeWasWin = false;

            if (state.martingaleLevel === 2)
                state.session.x2Losses++;
            if (state.martingaleLevel === 3)
                state.session.x3Losses++;
            if (state.martingaleLevel === 4)
                state.session.x4Losses++;
            if (state.martingaleLevel === 5)
                state.session.x5Losses++;
            if (state.martingaleLevel === 6)
                state.session.x6Losses++;
            if (state.martingaleLevel === 7)
                state.session.x7Losses++;

            if (state.martingaleLevel <= 3) {
                state.currentStake =
                    Math.ceil(
                        state.currentStake *
                        CONFIG.MARTINGALE_MULTIPLIER *
                        100
                    ) / 100;
            }
            if (
                state.martingaleLevel >= 4 &&
                state.martingaleLevel <= 10
            ) {
                state.currentStake =
                    Math.ceil(
                        state.currentStake *
                        CONFIG.MARTINGALE_MULTIPLIER2 *
                        100
                    ) / 100;
            }
            if (
                state.martingaleLevel >= 11 &&
                state.martingaleLevel <= 15
            ) {
                state.currentStake =
                    Math.ceil(
                        state.currentStake *
                        CONFIG.MARTINGALE_MULTIPLIER3 *
                        100
                    ) / 100;
            }
            if (
                state.martingaleLevel >= 16 &&
                state.martingaleLevel <= 20
            ) {
                state.currentStake =
                    Math.ceil(
                        state.currentStake *
                        CONFIG.MARTINGALE_MULTIPLIER4 *
                        100
                    ) / 100;
            }
            if (
                state.martingaleLevel >= 21 &&
                state.martingaleLevel <= 25
            ) {
                state.currentStake =
                    Math.ceil(
                        state.currentStake *
                        CONFIG.MARTINGALE_MULTIPLIER5 *
                        100
                    ) / 100;
            }

            if (
                state.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS
            ) {
                LOGGER.warn(
                    `⚠️ Maximum Martingale step reached (${CONFIG.MAX_MARTINGALE_STEPS}), resetting level to 0`
                );
                state.martingaleLevel = 0;
            } else {
                LOGGER.trade(
                    `❌ LOSS: -$${Math.abs(profit).toFixed(2)} | Direction: ${direction} | Next Martingale Level: ${state.martingaleLevel}`
                );
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
        this.activeSubscriptions = new Set();
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            LOGGER.info('Already connected');
            return;
        }

        LOGGER.info('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket(
            `${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`
        );

        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', data => this.onMessage(data));
        this.ws.on('error', error => this.onError(error));
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
                    candlesLoaded: false,
                    lastFractalHigh: null,
                    lastFractalLow: null,
                    tradedFractalHigh: null,
                    tradedFractalLow: null
                };
                LOGGER.info(`📊 Initialized asset: ${symbol}`);
            } else {
                LOGGER.info(
                    `📊 Asset ${symbol} already initialized (state restored)`
                );
            }
        });
    }

    restoreSubscriptions() {
        LOGGER.info(
            '📊 Restoring subscriptions after reconnection...'
        );
        state.portfolio.activePositions.forEach(pos => {
            if (pos.contractId) {
                LOGGER.info(
                    `  ✅ Re-subscribing to contract ${pos.contractId}`
                );
                this.send({
                    proposal_open_contract: 1,
                    contract_id: pos.contractId,
                    subscribe: 1
                });
            }
        });
    }

    cleanup() {
        if (this.ws) {
            this.ws.removeAllListeners();
            if (
                this.ws.readyState === WebSocket.OPEN ||
                this.ws.readyState === WebSocket.CONNECTING
            ) {
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
            LOGGER.error(
                `Error parsing message: ${error.message}`
            );
        }
    }

    handleResponse(response) {
        if (response.msg_type === 'authorize') {
            if (response.error) {
                LOGGER.error(
                    `Authorization failed: ${response.error.message}`
                );
                return;
            }
            LOGGER.info('🔐 Authorized successfully');
            LOGGER.info(
                `👤 Account: ${response.authorize.loginid}`
            );
            LOGGER.info(
                `💰 Balance: ${response.authorize.balance} ${response.authorize.currency}`
            );

            state.isAuthorized = true;
            state.accountBalance = response.authorize.balance;

            if (state.capital === CONFIG.INITIAL_CAPITAL) {
                state.capital = response.authorize.balance;
            }

            this.send({ balance: 1, subscribe: 1 });

            if (
                this.reconnectAttempts > 0 ||
                state.portfolio.activePositions.length > 0
            ) {
                LOGGER.info(
                    '🔄 Reconnection detected, restoring subscriptions...'
                );
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
            LOGGER.error(
                `Trade error: ${response.error.message}`
            );

            const reqId = response.echo_req?.req_id;
            if (reqId) {
                const posIndex =
                    state.portfolio.activePositions.findIndex(
                        p => p.reqId === reqId
                    );
                if (posIndex >= 0) {
                    state.portfolio.activePositions.splice(
                        posIndex,
                        1
                    );
                }
            }

            return;
        }

        const contract = response.buy;
        LOGGER.trade(
            `✅ Position opened: Contract ${contract.contract_id}, Buy Price: $${contract.buy_price}`
        );

        const reqId = response.echo_req.req_id;
        const position =
            state.portfolio.activePositions.find(
                p => p.reqId === reqId
            );

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

        this.send({
            proposal_open_contract: 1,
            contract_id: contract.contract_id,
            subscribe: 1
        });
    }

    handleOpenContract(response) {
        if (response.error) {
            LOGGER.error(
                `Contract error: ${response.error.message}`
            );
            return;
        }

        const contract = response.proposal_open_contract;
        const contractId = contract.contract_id;
        const posIndex =
            state.portfolio.activePositions.findIndex(
                p => p.contractId === contractId
            );

        if (posIndex < 0) return;

        const position =
            state.portfolio.activePositions[posIndex];
        position.currentProfit = contract.profit;

        if (
            contract.is_sold ||
            contract.is_expired ||
            contract.status === 'sold'
        ) {
            const profit = contract.profit;

            LOGGER.trade(
                `Contract ${contractId} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`
            );

            SessionManager.recordTradeResult(
                profit,
                position.direction
            );

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
        const calculatedOpenTime =
            ohlc.open_time ||
            Math.floor(ohlc.epoch / CONFIG.GRANULARITY) *
            CONFIG.GRANULARITY;

        const incomingCandle = {
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close),
            epoch: ohlc.epoch,
            open_time: calculatedOpenTime
        };

        const currentOpenTime =
            assetState.currentFormingCandle?.open_time;
        const isNewCandle =
            currentOpenTime &&
            incomingCandle.open_time !== currentOpenTime;

        if (isNewCandle) {
            const closedCandle = {
                ...assetState.currentFormingCandle
            };
            closedCandle.epoch =
                closedCandle.open_time + CONFIG.GRANULARITY;

            if (
                closedCandle.open_time !==
                assetState.lastProcessedCandleOpenTime
            ) {
                assetState.closedCandles.push(closedCandle);

                if (
                    assetState.closedCandles.length >
                    CONFIG.MAX_CANDLES_STORED
                ) {
                    assetState.closedCandles =
                        assetState.closedCandles.slice(
                            -CONFIG.MAX_CANDLES_STORED
                        );
                }

                assetState.lastProcessedCandleOpenTime =
                    closedCandle.open_time;

                const closeTime = new Date(
                    closedCandle.epoch * 1000
                ).toISOString();
                const candleType =
                    CandleAnalyzer.getCandleDirection(
                        closedCandle
                    );
                const candleEmoji =
                    candleType === 'BULLISH'
                        ? '🟢'
                        : candleType === 'BEARISH'
                            ? '🔴'
                            : '⚪';

                LOGGER.info(
                    `${symbol} ${candleEmoji} CANDLE CLOSED [${closeTime}] ${candleType}: O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)}`
                );

                // Update fractal levels
                const fractals = TechnicalIndicators.findFractals(assetState.closedCandles);

                const prevHigh = assetState.lastFractalHigh;
                const prevLow = assetState.lastFractalLow;

                if (fractals.fractalHigh !== null) {
                    if (fractals.fractalHigh !== assetState.lastFractalHigh) {
                        assetState.tradedFractalHigh = null;
                        LOGGER.info(
                            `${symbol} 🔺 NEW Fractal Resistance: ${fractals.fractalHigh.toFixed(5)} (was ${assetState.lastFractalHigh !== null ? assetState.lastFractalHigh.toFixed(5) : 'N/A'}) — breakout reset`
                        );
                    }
                    assetState.lastFractalHigh = fractals.fractalHigh;
                }

                if (fractals.fractalLow !== null) {
                    if (fractals.fractalLow !== assetState.lastFractalLow) {
                        assetState.tradedFractalLow = null;
                        LOGGER.info(
                            `${symbol} 🔻 NEW Fractal Support: ${fractals.fractalLow.toFixed(5)} (was ${assetState.lastFractalLow !== null ? assetState.lastFractalLow.toFixed(5) : 'N/A'}) — breakout reset`
                        );
                    }
                    assetState.lastFractalLow = fractals.fractalLow;
                }

                if (
                    assetState.lastFractalHigh === prevHigh &&
                    assetState.lastFractalLow === prevLow
                ) {
                    LOGGER.debug(
                        `${symbol} Fractals unchanged — R: ${assetState.lastFractalHigh !== null ? assetState.lastFractalHigh.toFixed(5) : 'N/A'} | S: ${assetState.lastFractalLow !== null ? assetState.lastFractalLow.toFixed(5) : 'N/A'}`
                    );
                }

                // TRIGGER TRADE ANALYSIS
                state.canTrade = true;
                bot.executeNextTrade(symbol, closedCandle);
            }
        }

        assetState.currentFormingCandle = incomingCandle;

        const candles = assetState.candles;
        const existingIndex = candles.findIndex(
            c => c.open_time === incomingCandle.open_time
        );
        if (existingIndex >= 0) {
            candles[existingIndex] = incomingCandle;
        } else {
            candles.push(incomingCandle);
        }

        if (candles.length > CONFIG.MAX_CANDLES_STORED) {
            assetState.candles = candles.slice(
                -CONFIG.MAX_CANDLES_STORED
            );
        }
    }

    handleCandlesHistory(response) {
        if (response.error) {
            LOGGER.error(
                `Error fetching candles: ${response.error.message}`
            );
            return;
        }

        const symbol = response.echo_req.ticks_history;
        if (!state.assets[symbol]) return;

        const candles = response.candles.map(c => {
            const openTime =
                Math.floor(
                    (c.epoch - CONFIG.GRANULARITY) /
                    CONFIG.GRANULARITY
                ) * CONFIG.GRANULARITY;
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
            LOGGER.warn(
                `${symbol}: No historical candles received`
            );
            return;
        }

        state.assets[symbol].candles = [...candles];
        state.assets[symbol].closedCandles = [...candles];

        const lastCandle = candles[candles.length - 1];
        state.assets[symbol].lastProcessedCandleOpenTime =
            lastCandle.open_time;
        state.assets[symbol].currentFormingCandle = null;

        const fractals =
            TechnicalIndicators.findFractals(candles);
        state.assets[symbol].lastFractalHigh =
            fractals.fractalHigh;
        state.assets[symbol].lastFractalLow =
            fractals.fractalLow;

        LOGGER.info(
            `📊 Loaded ${candles.length} ${CONFIG.TIMEFRAME_LABEL} candles for ${symbol}`
        );
        LOGGER.info(
            `   🔺 Fractal Resistance (High): ${fractals.fractalHigh !== null ? fractals.fractalHigh.toFixed(5) : 'N/A'}${fractals.fractalHighIndex !== null ? ` [bar ${fractals.fractalHighIndex}/${candles.length - 1}]` : ''}`
        );
        LOGGER.info(
            `   🔻 Fractal Support    (Low):  ${fractals.fractalLow !== null ? fractals.fractalLow.toFixed(5) : 'N/A'}${fractals.fractalLowIndex !== null ? ` [bar ${fractals.fractalLowIndex}/${candles.length - 1}]` : ''}`
        );

        if (CONFIG.DEBUG_MODE) {
            const allFractals =
                TechnicalIndicators.findAllFractals(candles);
            const recentHighs = allFractals.highs.slice(-5);
            const recentLows = allFractals.lows.slice(-5);
            LOGGER.debug(
                `   Recent Fractal Highs: ${recentHighs.map(f => f.price.toFixed(2)).join(', ') || 'None'}`
            );
            LOGGER.debug(
                `   Recent Fractal Lows:  ${recentLows.map(f => f.price.toFixed(2)).join(', ') || 'None'}`
            );
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
            LOGGER.info(
                'Already handling disconnect, skipping...'
            );
            return;
        }

        if (
            this.reconnectAttempts < this.maxReconnectAttempts
        ) {
            this.isReconnecting = true;
            this.reconnectAttempts++;
            const delay = Math.min(
                this.reconnectDelay *
                Math.pow(1.5, this.reconnectAttempts - 1),
                30000
            );

            LOGGER.info(
                `🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
            );
            LOGGER.info(
                `📊 Preserved state - Trades: ${state.session.tradesCount}, P&L: $${state.session.netPL.toFixed(2)}`
            );

            TelegramService.sendMessage(
                `⚠️ <b>CONNECTION LOST - RECONNECTING</b>\n📊 Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n⏱️ Retrying in ${(delay / 1000).toFixed(1)}s\n💾 State preserved: ${state.session.tradesCount} trades, $${state.session.netPL.toFixed(2)} P&L`
            );

            setTimeout(() => {
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            TelegramService.sendMessage(
                `🛑 <b>BOT STOPPED</b>\nMax reconnection attempts reached.\nFinal P&L: $${state.session.netPL.toFixed(2)}`
            );
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
        console.log(
            ' DERIV RISE/FALL FRACTAL BREAKOUT BOT (MT5 Logic)'
        );
        console.log('═'.repeat(80));
        console.log(`💰 Initial Capital: $${state.capital}`);
        console.log(
            `📊 Active Assets: ${ACTIVE_ASSETS.join(', ')}`
        );
        console.log(`💵 Stake: $${CONFIG.STAKE}`);
        console.log(
            `⏱️ Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT}`
        );
        console.log(
            `🕯️ Candle Timeframe: ${CONFIG.TIMEFRAME_LABEL}`
        );
        console.log(
            `🎯 Session Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`
        );
        console.log(
            `📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ENABLED' : 'DISABLED'}`
        );
        console.log('─'.repeat(80));
        console.log(
            `🕐 TRADING WINDOWS (GMT+1):`
        );
        console.log(
            `   🇬🇧 London Session:   ${String(CONFIG.LONDON_START).padStart(2, '0')}:00 - ${String(CONFIG.LONDON_END).padStart(2, '0')}:00`
        );
        console.log(
            `   🇺🇸 New York Session: ${String(CONFIG.NEWYORK_START).padStart(2, '0')}:00 - ${String(CONFIG.NEWYORK_END).padStart(2, '0')}:00`
        );
        console.log(
            `   📊 Current Status: ${TradingSessionManager.getSessionStatusString()}`
        );
        console.log('═'.repeat(80));
        console.log(
            '📋 Strategy: MT5 Fractal Breakout + Recovery System'
        );
        console.log(
            '    🔺 Fractal = 5-bar pattern (2 left + pivot + 2 right)'
        );
        console.log(
            '    🟢 RISE: Candle CLOSE breaks ABOVE Fractal Resistance'
        );
        console.log(
            '    🔴 FALL: Candle CLOSE breaks BELOW Fractal Support'
        );
        console.log(
            '    🔄 Recovery: Alternate direction on Loss'
        );
        console.log(
            '    📐 Levels update every candle close'
        );
        console.log('═'.repeat(80) + '\n');

        this.connection.initializeAssets();

        ACTIVE_ASSETS.forEach(symbol => {
            this.subscribeToCandles(symbol);
        });

        TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();

        // Start the session time checker
        this.startSessionTimeChecker();

        LOGGER.info('✅ Bot started successfully!');
    }

    subscribeToCandles(symbol) {
        LOGGER.info(
            `📊 Subscribing to ${CONFIG.TIMEFRAME_LABEL} candles for ${symbol}...`
        );

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

    /**
     * =========================================================
     * TRADE EXECUTION — FRACTAL BREAKOUT LOGIC
     * =========================================================
     *
     * NOW INCLUDES TRADING SESSION TIME CHECK:
     *   • Only trades during London (CONFIG.LONDON_START - CONFIG.LONDON_END GMT+1)
     *   • Only trades during New York (CONFIG.NEWYORK_START - CONFIG.NEWYORK_END GMT+1)
     *   • EXCEPTION: If in martingale recovery (martingaleLevel > 0), trades
     *     are allowed outside session windows to complete the recovery sequence
     *
     * NORMAL MODE (no recovery):
     *   • RISE trade when the just-closed candle's CLOSE > latest Fractal High
     *   • FALL trade when the just-closed candle's CLOSE < latest Fractal Low
     *
     * RECOVERY MODE (last trade was a loss):
     *   • Alternate direction from the previous losing trade
     */
    executeNextTrade(symbol, lastClosedCandle) {
        if (!state.canTrade) return;
        if (!SessionManager.isSessionActive()) return;
        if (
            state.portfolio.activePositions.length >=
            CONFIG.MAX_OPEN_POSITIONS
        )
            return;

        // =============================================
        // TRADING SESSION TIME CHECK (NEW)
        // =============================================
        const sessionCheck = TradingSessionManager.isWithinTradingSession();
        const isInMartingaleRecovery = state.martingaleLevel > 0;

        if (!sessionCheck.inSession && !isInMartingaleRecovery) {
            // Outside trading session and NOT in martingale recovery — skip trade
            const now = Date.now();
            // Only log this once every 5 minutes to avoid spam
            if (now - state.lastSessionLogTime > 300000) {
                LOGGER.info(
                    `🕐 OUTSIDE TRADING SESSION — ${TradingSessionManager.getSessionStatusString()} | Skipping trade signal`
                );
                state.lastSessionLogTime = now;
            }
            return;
        }

        if (!sessionCheck.inSession && isInMartingaleRecovery) {
            // Outside session BUT in martingale recovery — allow the trade
            LOGGER.warn(
                `🕐⚠️ OUTSIDE SESSION but Martingale Level ${state.martingaleLevel} — allowing recovery trade`
            );
        }

        if (sessionCheck.inSession) {
            LOGGER.debug(
                `🕐 Trading within ${sessionCheck.sessionName} session`
            );
        }

        const tradeSymbol = symbol || ACTIVE_ASSETS[0];
        const assetState = state.assets[tradeSymbol];
        const stake = state.currentStake;

        if (state.capital < stake) {
            LOGGER.error(
                `Insufficient capital for stake: $${state.capital.toFixed(2)} (Needed: $${stake.toFixed(2)})`
            );
            if (state.martingaleLevel > 0) {
                LOGGER.info(
                    'Resetting Martingale level due to insufficient capital.'
                );
                state.martingaleLevel = 0;
            }
            return;
        }

        // =============================================
        // GET CURRENT FRACTAL LEVELS
        // =============================================
        const resistance = assetState.lastFractalHigh;
        const support = assetState.lastFractalLow;
        const closePrice = lastClosedCandle.close;

        if (resistance === null || support === null) {
            LOGGER.info(
                `${tradeSymbol} ⏳ Waiting for fractal levels to form — Resistance: ${resistance !== null ? resistance.toFixed(5) : 'PENDING'} | Support: ${support !== null ? support.toFixed(5) : 'PENDING'}`
            );
            return;
        }

        LOGGER.info(
            `${tradeSymbol} 📐 Fractal Levels — Resistance: ${resistance.toFixed(5)} | Support: ${support.toFixed(5)} | Close: ${closePrice.toFixed(5)}`
        );

        // =============================================
        // DETERMINE TRADE DIRECTION
        // =============================================
        let direction = null;
        let signalReason = '';

        const isRecoveryMode = state.lastTradeWasWin === false;

        if (isRecoveryMode) {
            if (state.lastTradeDirection === 'CALLE') {
                direction = 'PUTE';
                signalReason =
                    'Recovery (Prev LOSS on RISE → now FALL)';
            } else {
                direction = 'CALLE';
                signalReason =
                    'Recovery (Prev LOSS on FALL → now RISE)';
            }
            LOGGER.trade(
                `🔄 RECOVERY MODE: ${signalReason}`
            );
        } else {
            // if (closePrice > resistance) {
                // if (assetState.tradedFractalHigh === resistance) {
                //     LOGGER.debug(
                //         `${tradeSymbol} ⏭️ Breakout UP already traded at Resistance ${resistance.toFixed(5)} — waiting for new fractal level`
                //     );
                // } else {
                    direction = 'CALLE';
                    signalReason = `BREAKOUT UP — Close ${closePrice.toFixed(5)} > Resistance ${resistance.toFixed(5)} (diff: +${(closePrice - resistance).toFixed(5)})`;
                // }
            // } else if (closePrice < support) {
            //     if (assetState.tradedFractalLow === support) {
            //         LOGGER.debug(
            //             `${tradeSymbol} ⏭️ Breakout DOWN already traded at Support ${support.toFixed(5)} — waiting for new fractal level`
            //         );
            //     } else {
            //         direction = 'PUTE';
            //         signalReason = `BREAKOUT DOWN — Close ${closePrice.toFixed(5)} < Support ${support.toFixed(5)} (diff: -${(support - closePrice).toFixed(5)})`;
            //     }
            // } else {
            //     LOGGER.info(
            //         `${tradeSymbol} ⏸️ No breakout — Close ${closePrice.toFixed(5)} is between Support ${support.toFixed(5)} and Resistance ${resistance.toFixed(5)}`
            //     );
            // }

            if (direction) {
                LOGGER.trade(`⚡ FRACTAL SIGNAL: ${signalReason}`);
            }
        }

        StatePersistence.saveState();

        if (!direction) {
            return;
        }

        // =============================================
        // EXECUTE TRADE
        // =============================================
        state.canTrade = false;
        state.lastTradeDirection = direction;

        const sessionLabel = sessionCheck.inSession
            ? `[${sessionCheck.sessionName}]`
            : `[RECOVERY - Outside Session]`;

        LOGGER.trade(
            `🎯 ${sessionLabel} Executing ${direction === 'CALLE' ? 'RISE' : 'FALL'} trade on ${tradeSymbol}`
        );
        LOGGER.trade(
            `   Stake: $${stake.toFixed(2)} | Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT} | Martingale Level: ${state.martingaleLevel}`
        );
        LOGGER.trade(`   Reason: ${signalReason}`);
        LOGGER.trade(
            `   Fractal Resistance: ${resistance.toFixed(5)} | Fractal Support: ${support.toFixed(5)} | Close: ${closePrice.toFixed(5)}`
        );

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

        if (direction === 'CALLE' && !isRecoveryMode) {
            assetState.tradedFractalHigh = resistance;
            LOGGER.info(
                `${tradeSymbol} ✅ Marked Resistance ${resistance.toFixed(5)} as TRADED — will not re-trade until new fractal forms`
            );
        } else if (direction === 'PUTE' && !isRecoveryMode) {
            assetState.tradedFractalLow = support;
            LOGGER.info(
                `${tradeSymbol} ✅ Marked Support ${support.toFixed(5)} as TRADED — will not re-trade until new fractal forms`
            );
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

    /**
     * NEW: Consolidated session time checker
     * Handles:
     *  - Weekend suspension
     *  - Daily reconnection
     *  - Session window logging
     *  - End-of-day disconnect (after last session ends and last trade was a win)
     */
    startSessionTimeChecker() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(
                now.getTime() + 1 * 60 * 60 * 1000
            );
            const currentDay = gmtPlus1Time.getUTCDay();
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Weekend check (Saturday 11pm - Monday 2am GMT+1)
            const isWeekend =
                currentDay === 0 ||
                (currentDay === 6 && currentHours >= 23) ||
                (currentDay === 1 && currentHours < 2);

            if (isWeekend) {
                if (state.session.isActive) {
                    LOGGER.info(
                        'Weekend trading suspension (Saturday 11pm - Monday 2am). Disconnecting...'
                    );
                    TelegramService.sendHourlySummary();
                    if (this.connection.ws)
                        this.connection.ws.close();
                    state.session.isActive = false;
                }
                return;
            }

            // Daily reconnection at 2:00 AM GMT+1 (before London session)
            if (
                !state.session.isActive &&
                currentHours === 2 &&
                currentMinutes >= 0
            ) {
                LOGGER.info(
                    "It's 2:00 AM GMT+1, reconnecting the bot and resetting daily stats."
                );
                this.resetDailyStats();
                state.session.isActive = true;
                this.connection.connect();
            }

            // End-of-day disconnect: After New York session ends, if last trade was a win
            if (
                state.lastTradeWasWin &&
                state.session.isActive &&
                state.martingaleLevel === 0
            ) {
                // Disconnect after the last session window + some buffer
                if (currentHours >= CONFIG.NEWYORK_END && currentMinutes >= 30) {
                    LOGGER.info(
                        `It's past ${CONFIG.NEWYORK_END}:30 GMT+1 after New York session ended (last trade was a win), disconnecting.`
                    );
                    TelegramService.sendHourlySummary();
                    if (this.connection.ws)
                        this.connection.ws.close();
                    state.session.isActive = false;
                }
            }
        }, 20000);
    }

    // Keep the old method name as alias for backward compatibility
    checkTimeForDisconnectReconnect() {
        this.startSessionTimeChecker();
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
        state.lastSessionLogTime = 0;
        LOGGER.info('📊 Daily stats reset');
    }

    getStatus() {
        const sessionStats = SessionManager.getSessionStats();
        const tradingSession = TradingSessionManager.getSessionStatusString();

        const nextDirection =
            state.lastTradeWasWin === null
                ? 'Waiting for signal'
                : state.lastTradeWasWin
                    ? 'Waiting for fractal breakout'
                    : state.lastTradeDirection === 'CALLE'
                        ? 'PUTE (Recovery)'
                        : 'CALLE (Recovery)';

        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            accountBalance: state.accountBalance,
            session: sessionStats,
            tradingSession: tradingSession,
            lastDirection: state.lastTradeDirection,
            lastWasWin: state.lastTradeWasWin,
            nextDirection: nextDirection,
            activePositionsCount:
                state.portfolio.activePositions.length,
            activePositions:
                state.portfolio.activePositions.map(pos => ({
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
    LOGGER.info(
        '🔄 Bot will resume from saved state after connection'
    );
} else {
    LOGGER.info('🆕 Bot will start with fresh state');
}

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═'.repeat(80));
    console.log(
        ' DERIV RISE/FALL FRACTAL BREAKOUT BOT (MT5 Logic)'
    );
    console.log('═'.repeat(80));
    console.log('\n⚠️ API Token not configured!\n');
    console.log('Usage:');
    console.log(
        ' API_TOKEN=xxx DURATION=5 DURATION_UNIT=t node risefall-bot.js'
    );
    console.log('\nEnvironment Variables:');
    console.log(
        ' API_TOKEN - Deriv API token (required)'
    );
    console.log(
        ' CAPITAL - Initial capital (default: 1000)'
    );
    console.log(
        ' STAKE - Stake per trade (default: 1)'
    );
    console.log(
        ' DURATION - Contract duration (default: 1)'
    );
    console.log(
        ' DURATION_UNIT - t=ticks, s=seconds, m=minutes (default: t)'
    );
    console.log(
        ' PROFIT_TARGET - Session profit target (default: 1000)'
    );
    console.log(
        ' STOP_LOSS - Session stop loss (default: -500)'
    );
    console.log(
        ' TELEGRAM_ENABLED - Enable Telegram (default: false)'
    );
    console.log(
        ' TELEGRAM_BOT_TOKEN - Telegram bot token'
    );
    console.log(' TELEGRAM_CHAT_ID - Telegram chat ID');
    console.log('═'.repeat(80));
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(
    ' DERIV RISE/FALL FRACTAL BREAKOUT BOT (MT5 Logic)'
);
console.log(
    ` Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT} | Stake: $${CONFIG.STAKE}`
);
console.log(
    ` 🕐 London: ${CONFIG.LONDON_START}:00-${CONFIG.LONDON_END}:00 | New York: ${CONFIG.NEWYORK_START}:00-${CONFIG.NEWYORK_END}:00 (GMT+1)`
);
console.log('═'.repeat(80));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

// Status display every 30 seconds
setInterval(() => {
    if (state.isAuthorized) {
        const status = bot.getStatus();
        const s = state.session;

        // Show fractal levels for each asset
        let fractalInfo = '';
        ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                fractalInfo += ` | ${sym} R:${a.lastFractalHigh !== null ? a.lastFractalHigh.toFixed(2) : '---'} S:${a.lastFractalLow !== null ? a.lastFractalLow.toFixed(2) : '---'}`;
            }
        });

        console.log(
            `\n📊 ${getGMTTime()} | ${status.session.trades} trades | ${status.session.winRate} | $${status.session.netPL.toFixed(2)} | ${status.activePositions.length} active${fractalInfo}`
        );
        console.log(
            `📉 Loss Stats: x2:${s.x2Losses} x3:${s.x3Losses} x4:${s.x4Losses} x5:${s.x5Losses} x6:${s.x6Losses} x7:${s.x7Losses} | Level: ${state.martingaleLevel} | Next: ${status.nextDirection}`
        );
        console.log(
            `🕐 ${status.tradingSession}`
        );
    }
}, 30000);
