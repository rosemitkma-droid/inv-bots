const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'abitrageRF000019-state.json');
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
                    closedCandles: asset.closedCandles ? asset.closedCandles.slice(-20) : [],
                    tickHistory: asset.tickHistory ? asset.tickHistory.slice(-1000) : [],
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
            state.lastTradeWasWin = savedData.lastTradeWasWin !== undefined ? savedData.lastTradeWasWin : null;
            state.martingaleLevel = savedData.martingaleLevel || 0;
            state.hourlyStats = savedData.hourlyStats || {
                trades: 0, wins: 0, losses: 0, pnl: 0,
                lastHour: new Date().getHours()
            };

            if (savedData.assets) {
                Object.keys(savedData.assets).forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = savedData.assets[symbol];
                        const asset = state.assets[symbol];
                        if (saved.closedCandles && saved.closedCandles.length > 0) {
                            asset.closedCandles = saved.closedCandles;
                            LOGGER.info(`  📊 Restored ${saved.closedCandles.length} closed candles for ${symbol}`);
                        }
                        if (saved.tickHistory && saved.tickHistory.length > 0) {
                            asset.tickHistory = saved.tickHistory;
                            LOGGER.info(`  📊 Restored ${saved.tickHistory.length} ticks for ${symbol}`);
                        }
                        asset.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                        asset.candlesLoaded = saved.candlesLoaded || false;
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
                        if (res.statusCode === 200) resolve(true);
                        else reject(new Error(body));
                    });
                });
                req.on('error', (error) => reject(error));
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
Duration: ${duration} ${durationUnit === 't' ? 'Ticks' : durationUnit === 's' ? 'Seconds' : 'Minutes'}
Martingale Level: ${state.martingaleLevel}
${details.reason ? `Reason: ${details.reason}` : ''}
${details.probability ? `Probability: ${details.probability}%` : ''}
${details.oscInfo ? `Oscillation: ${details.oscInfo}` : ''}
${details.profit !== undefined ? `Profit: $${details.profit.toFixed(2)}
Total P&L: $${state.session.netPL.toFixed(2)}
Wins: ${state.session.winsCount}/${state.session.lossesCount}
Win Rate: ${stats.winRate}` : ''}
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
🤖 <b>stpRNG 2025 OSCILLATION BREAKOUT BOT</b>
Strategy: Deep Oscillation Scanner + Breakout
Capital: $${state.capital.toFixed(2)}
Stake: $${CONFIG.STAKE}
Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT === 't' ? 'Ticks' : 'Seconds'}
Assets: ${ACTIVE_ASSETS.join(', ')}
Min Confidence: ${CONFIG.MIN_TREND_CONFIDENCE}%
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
            ? ((statsSnapshot.wins / totalTrades) * 100).toFixed(1) : 0;
        const pnlEmoji = statsSnapshot.pnl >= 0 ? '🟢' : '🔴';
        const pnlStr = (statsSnapshot.pnl >= 0 ? '+' : '') + '$' + statsSnapshot.pnl.toFixed(2);

        const message = `
⏰ <b>Hourly Summary</b>

📊 <b>Last Hour</b>
├ Trades: ${statsSnapshot.trades}
├ Wins: ${statsSnapshot.wins} | Losses: ${statsSnapshot.losses}
├ Win Rate: ${winRate}%
└ ${pnlEmoji} <b>P&L:</b> ${pnlStr}

📈 <b>Daily Totals</b>
├ Total Trades: ${state.session.tradesCount}
├ Total W/L: ${state.session.winsCount}/${state.session.lossesCount}
├ Daily P&L: ${(state.session.netPL >= 0 ? '+' : '')}$${state.session.netPL.toFixed(2)}
└ Capital: $${state.capital.toFixed(2)}

⏰ ${new Date().toLocaleString()}
        `.trim();

        try {
            await this.sendMessage(message);
            LOGGER.info('📱 Telegram: Hourly Summary sent');
        } catch (error) {
            LOGGER.error(`❌ Telegram hourly summary failed: ${error.message}`);
        }

        state.hourlyStats = {
            trades: 0, wins: 0, losses: 0, pnl: 0,
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
            this.sendHourlySummary();
            setInterval(() => {
                this.sendHourlySummary();
            }, 60 * 60 * 1000);
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
    static isBullish(candle) { return candle.close > candle.open; }
    static isBearish(candle) { return candle.close < candle.open; }

    static getLastClosedCandle(symbol) {
        const assetState = state.assets[symbol];
        if (!assetState || !assetState.closedCandles || assetState.closedCandles.length === 0) return null;
        return assetState.closedCandles[assetState.closedCandles.length - 1];
    }

    static getCandleDirection(candle) {
        if (this.isBullish(candle)) return 'BULLISH';
        if (this.isBearish(candle)) return 'BEARISH';
        return 'DOJI';
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
    STAKE: 0.5,

    // Session Targets
    totalTradesN: 5000000,
    SESSION_PROFIT_TARGET: 5000,
    SESSION_STOP_LOSS: -125,
    highestPercentageDigit: null,

    // Candle Settings
    GRANULARITY: 60,
    TIMEFRAME_LABEL: '1m',
    MAX_CANDLES_STORED: 100,
    CANDLES_TO_LOAD: 50,

    TOTAL_TICK_HISTORY: 50,

    // Trade Duration Settings
    DURATION: 2,
    DURATION_UNIT: 't',

    // Trade Settings
    MAX_OPEN_POSITIONS: 1,
    TRADE_DELAY: 800,

    // ═══════════════════════════════════════════
    // 2025 OSCILLATION BREAKOUT STRATEGY SETTINGS
    // ═══════════════════════════════════════════
    MIN_TREND_STREAK: 2,           // Minimum streak before considering trade
    MAX_TREND_STREAK: 3,           // Maximum streak (don't chase mature trends)
    MIN_TREND_CONFIDENCE: 20,      // Minimum historical success rate
    MIN_TREND_MATCHES: 5,          // Minimum historical samples needed

    OSC_TARGET_RATIO: 1,      // Trigger at 85% of max oscillation length
    MIN_OSC_EVENTS: 0,           // Need at least 5 historical osc→trend events
    MIN_CONFIDENCE: 60,          // Minimum confidence to trade
    MAX_OSC_MULTIPLIER: 1.5,     // Skip if oscillation > 150% of max (anomaly)

    // Martingale Settings
    MARTINGALE_MULTIPLIER: 4,
    MARTINGALE_MULTIPLIER2: 5,
    MARTINGALE_MULTIPLIER3: 5,
    MARTINGALE_MULTIPLIER4: 5,
    MARTINGALE_MULTIPLIER5: 5,
    MAX_MARTINGALE_STEPS: 4,

    // Debug
    DEBUG_MODE: true,

    // Telegram Settings
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8588380880:AAH8tOl8dxvjJ4qfWf3yr-i7FS_qlew-8t0',
    TELEGRAM_CHAT_ID: '752497117',
};

let ACTIVE_ASSETS = ['stpRNG'];

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    assets: {},
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    currentStake: CONFIG.STAKE,
    session: {
        profit: 0, loss: 0, netPL: 0,
        tradesCount: 0, winsCount: 0, lossesCount: 0,
        x2Losses: 0, x3Losses: 0, x4Losses: 0,
        x5Losses: 0, x6Losses: 0, x7Losses: 0,
        isActive: true, startTime: Date.now(),
        startCapital: CONFIG.INITIAL_CAPITAL
    },
    isConnected: false,
    isAuthorized: false,
    portfolio: {
        dailyProfit: 0, dailyLoss: 0,
        dailyWins: 0, dailyLosses: 0,
        activePositions: []
    },
    lastTradeDirection: null,
    lastTradeWasWin: null,
    martingaleLevel: 0,
    hourlyStats: {
        trades: 0, wins: 0, losses: 0, pnl: 0,
        lastHour: new Date().getHours()
    },
    requestId: 1,
    canTrade: false,
    tickData: { lastTick: null, lastDigit: null },
    // 2025 Strategy State
    oscillationLog: [],        // Tracks all detected oscillations
    lastSignalTime: 0,         // Cooldown between signals
    signalCooldownMs: 3000     // 3 second cooldown between trades
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

        if (state.session.tradesCount >= CONFIG.totalTradesN) {
            LOGGER.info(`⏸️ Session ended (reached total trades Net P/L: $${netPL.toFixed(2)}).`);
            this.endSession('TOTAL_TRADES');
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
        const currentHour = new Date().getHours();
        if (currentHour !== state.hourlyStats.lastHour) {
            // Send hourly summary before resetting
            TelegramService.sendHourlySummary();
            state.hourlyStats = {
                trades: 0, wins: 0, losses: 0, pnl: 0,
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

            LOGGER.trade(`✅ WIN: +$${profit.toFixed(2)} | Direction: ${direction} | Capital: $${state.capital.toFixed(2)} | Martingale Reset`);
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            state.hourlyStats.losses++;
            state.martingaleLevel++;
            state.lastTradeWasWin = false;

            if (state.martingaleLevel === 2) state.session.x2Losses++;
            if (state.martingaleLevel === 3) state.session.x3Losses++;
            if (state.martingaleLevel === 4) state.session.x4Losses++;
            if (state.martingaleLevel === 5) state.session.x5Losses++;
            if (state.martingaleLevel === 6) state.session.x6Losses++;
            if (state.martingaleLevel === 7) state.session.x7Losses++;

            // 2025 Smart Martingale: flat stake for first 5 losses, then scale
            if (state.martingaleLevel <= 5) {
                state.currentStake = Math.ceil(state.currentStake * CONFIG.MARTINGALE_MULTIPLIER * 100) / 100;
            };
            if (state.martingaleLevel >= 6 && state.martingaleLevel <= 10) {
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

            // Cap stake at 10% of capital
            const maxStake = state.capital * 0.10;
            if (state.currentStake > maxStake) {
                state.currentStake = Number(maxStake.toFixed(2));
                LOGGER.warn(`⚠️ Stake capped at 10% of capital: $${state.currentStake.toFixed(2)}`);
            }

            if (state.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS) {
                LOGGER.warn(`⚠️ Maximum Martingale step reached (${CONFIG.MAX_MARTINGALE_STEPS}), resetting`);
                // state.martingaleLevel = 0;
                // state.currentStake = CONFIG.STAKE;
            } else {
                LOGGER.trade(`❌ LOSS: -$${Math.abs(profit).toFixed(2)} | Direction: ${direction} | Capital: $${state.capital.toFixed(2)} | Next Level: ${state.martingaleLevel} | Next Stake: $${state.currentStake.toFixed(2)}`);
            }
        }

        CONFIG.highestPercentageDigit = null;
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
        this.tickAnalysisCount = 0;
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            LOGGER.info('Already connected');
            return;
        }

        LOGGER.info('🔌 Connecting to Deriv API...');
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
                    tickHistory: [],
                    currentFormingCandle: null,
                    lastProcessedCandleOpenTime: null,
                    candlesLoaded: false,
                    lastTick: null,
                    lastDigit: null
                };
                LOGGER.info(`📊 Initialized asset: ${symbol}`);
            } else {
                LOGGER.info(`📊 Asset ${symbol} already initialized (state restored)`);
            }
        });
    }

    subscribeToTicks(symbol) {
        LOGGER.info(`📊 Subscribing to live ticks for ${symbol}...`);

        this.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: CONFIG.TOTAL_TICK_HISTORY,
            end: 'latest',
            start: 1,
            style: 'ticks'
        });

        this.send({
            ticks: symbol,
            subscribe: 1
        });
    }

    restoreSubscriptions() {
        LOGGER.info('📊 Restoring subscriptions after reconnection...');
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

    cleanup() {
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { }
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

        if (response.msg_type === 'history') {
            this.handleTickHistory(response.echo_req.ticks_history, response.history);
        }

        if (response.msg_type === 'tick') {
            this.handleTickUpdate(response.tick);
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
            const reqId = response.echo_req?.req_id;
            if (reqId) {
                const posIndex = state.portfolio.activePositions.findIndex(p => p.reqId === reqId);
                if (posIndex >= 0) state.portfolio.activePositions.splice(posIndex, 1);
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
                'OPEN', position.symbol, position.direction,
                position.stake, position.duration, position.durationUnit,
                { reason: position.reason, probability: position.probability, oscInfo: position.oscInfo }
            );
        }

        this.send({
            proposal_open_contract: 1,
            contract_id: contract.contract_id,
            subscribe: 1
        });
    }

    handleOpenContract(response) {
        if (response.error) return;

        const contract = response.proposal_open_contract;
        const contractId = contract.contract_id;
        const posIndex = state.portfolio.activePositions.findIndex(p => p.contractId === contractId);
        if (posIndex < 0) return;

        const position = state.portfolio.activePositions[posIndex];
        position.currentProfit = contract.profit;

        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
            const profit = contract.profit;

            LOGGER.trade(`Contract ${contractId} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`);

            SessionManager.recordTradeResult(profit, position.direction);

            TelegramService.sendTradeAlert(
                profit >= 0 ? 'WIN' : 'LOSS',
                position.symbol, position.direction,
                position.stake, position.duration, position.durationUnit,
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
            open: parseFloat(ohlc.open), high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low), close: parseFloat(ohlc.close),
            epoch: ohlc.epoch, open_time: calculatedOpenTime
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
            }
        }

        assetState.currentFormingCandle = incomingCandle;

        const candles = assetState.candles;
        const existingIndex = candles.findIndex(c => c.open_time === incomingCandle.open_time);
        if (existingIndex >= 0) candles[existingIndex] = incomingCandle;
        else candles.push(incomingCandle);

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
                open: parseFloat(c.open), high: parseFloat(c.high),
                low: parseFloat(c.low), close: parseFloat(c.close),
                epoch: c.epoch, open_time: openTime
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

    handleTickHistory(asset, history) {
        if (!state.assets[asset]) return;
        state.assets[asset].tickHistory = history.prices.map(price => this.getLastDigit(price, asset));
        LOGGER.info(`📊 Loaded ${state.assets[asset].tickHistory.length} ticks for ${asset}`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);
        if (!state.assets[asset]) return;

        const assetState = state.assets[asset];
        assetState.lastTick = tick;
        assetState.lastDigit = lastDigit;

        state.tickData.lastTick = tick;
        state.tickData.lastDigit = lastDigit;

        if (!assetState.tickHistory) assetState.tickHistory = [];
        assetState.tickHistory.push(lastDigit);
        if (assetState.tickHistory.length > CONFIG.TOTAL_TICK_HISTORY) {
            assetState.tickHistory.shift();
        }

        LOGGER.debug(`[${asset}] Tick: ${tick.quote} | Digit: ${lastDigit}`);

        // ═══════════════════════════════════════════
        // RUN THE 2025 DEEP OSCILLATION SCANNER
        // ═══════════════════════════════════════════
        this.analyzeTicks2025(asset);
    }

    // 2025 SIMPLE TREND DETECTION STRATEGY
    //
    // HOW IT WORKS:
    // 1. Looks at the last 50 ticks
    // 2. Detects if market is currently trending UP or DOWN
    //    (consecutive +1 or -1 moves, handling 9→0 and 0→9 wraparound)
    // 3. When we see 2-3 consecutive moves in same direction,
    //    backtests history to see how often that led to 4+ tick trends
    // 4. Only trades when historical success rate ≥ 80%
    //
    // EXAMPLES:
    // UP trend:   ...3,4,5,6,7  or  ...8,9,0,1,2 (wraps at 9→0)
    // DOWN trend: ...7,6,5,4,3  or  ...2,1,0,9,8 (wraps at 0→9)
    // ════════════════════════════════════════════════════════════════
    // analyzeTicks2025(asset) {
    //     const h = state.assets[asset].tickHistory.slice(-100);
    //     if (!h || h.length < 100) return;
    //     if (state.portfolio.activePositions.length > 0) return;
    //     if (!state.session.isActive) return;

    //     // Cooldown between trades
    //     const now = Date.now();
    //     if (now - state.lastSignalTime < 3000) return;

    //     const len = h.length;
    //     const recent = h.slice(-20);
    //     const recentLen = recent.length;

    //     // ══════════════════════════════════════════
    //     // HELPER: Calculate step direction (-1, 0, +1)
    //     // Handles wrap-around: 9→0 is UP, 0→9 is DOWN
    //     // ══════════════════════════════════════════
    //     const getStep = (from, to) => {
    //         const diff = to - from;
    //         if (diff === 1 || diff === -9) return 1;   // UP
    //         if (diff === -1 || diff === 9) return -1;  // DOWN
    //         return 0; // Not a single step (skip, same, or jump)
    //     };

    //     // ══════════════════════════════════════════
    //     // STEP 1: Detect current momentum streak
    //     // Count consecutive +1 or -1 moves from the end
    //     // ══════════════════════════════════════════
    //     let currentStreak = 0;
    //     let currentDir = 0; // 1 = UP, -1 = DOWN

    //     for (let i = recentLen - 1; i > 0; i--) {
    //         const step = getStep(recent[i - 1], recent[i]);

    //         if (step === 0) break; // Not a clean step, streak ends

    //         if (currentStreak === 0) {
    //             // First step establishes direction
    //             currentDir = step;
    //             currentStreak = 1;
    //         } else if (step === currentDir) {
    //             // Same direction, extend streak
    //             currentStreak++;
    //         } else {
    //             // Direction changed, streak ends
    //             break;
    //         }
    //     }

    //     // ══════════════════════════════════════════
    //     // STEP 2: Only interested in "building" trends
    //     // We want to catch trends at 2-3 ticks, before they hit 4
    //     // ══════════════════════════════════════════
    //     if (currentStreak < 2 || currentStreak > 3) {
    //         // Either no momentum yet, or trend already mature
    //         return;
    //     }

    //     // ══════════════════════════════════════════
    //     // STEP 3: HARD BLOCKS - Skip bad market conditions
    //     // ══════════════════════════════════════════
    //     const last = recent[recentLen - 1];
    //     const prev = recent[recentLen - 2];

    //     // Block if last 2 digits are same (no momentum)
    //     if (last === prev) return;

    //     // Block ABAB oscillation pattern in last 4 ticks
    //     if (recentLen >= 4) {
    //         const a = recent[recentLen - 4];
    //         const b = recent[recentLen - 3];
    //         const c = recent[recentLen - 2];
    //         const d = recent[recentLen - 1];
    //         if (a === c && b === d && a !== b) return;
    //     }

    //     // ══════════════════════════════════════════
    //     // STEP 4: HISTORICAL BACKTEST
    //     // Search entire tick history for identical 2-3 tick
    //     // momentum setups and count how often they continued to 4+
    //     // ══════════════════════════════════════════
    //     let totalMatches = 0;
    //     let successCount = 0;

    //     for (let i = currentStreak; i < len - 4; i++) {
    //         // Check if position i has same streak setup as current
    //         let histStreak = 0;
    //         let histDir = 0;

    //         // Walk backwards from position i to count streak
    //         for (let j = i; j > 0 && j > i - 5; j--) {
    //             const step = getStep(h[j - 1], h[j]);

    //             if (step === 0) break;

    //             if (histStreak === 0) {
    //                 histDir = step;
    //                 histStreak = 1;
    //             } else if (step === histDir) {
    //                 histStreak++;
    //             } else {
    //                 break;
    //             }
    //         }

    //         // Found matching setup: same streak length, same direction
    //         if (histStreak === currentStreak && histDir === currentDir) {
    //             totalMatches++;

    //             // Check if the NEXT ticks continued the trend to 4+
    //             let continueStreak = histStreak;

    //             for (let k = i + 1; k < Math.min(i + 5, len); k++) {
    //                 const nextStep = getStep(h[k - 1], h[k]);
    //                 if (nextStep === histDir) {
    //                     continueStreak++;
    //                 } else {
    //                     break;
    //                 }
    //             }

    //             // Success = reached 4+ total streak
    //             if (continueStreak >= 5) {
    //                 successCount++;
    //             }
    //         }
    //     }

    //     // ══════════════════════════════════════════
    //     // STEP 5: CALCULATE PROBABILITY
    //     // ══════════════════════════════════════════
    //     if (totalMatches < 5) {
    //         // Not enough historical data for this exact setup
    //         LOGGER.debug(`[${asset}] Trend ${currentDir > 0 ? 'UP' : 'DOWN'}×${currentStreak} but only ${totalMatches} historical matches (need 5+)`);
    //         return;
    //     }

    //     const successRate = (successCount / totalMatches) * 100;

    //     // Log analysis every few ticks
    //     this.analysisCount = (this.analysisCount || 0) + 1;
    //     if (this.analysisCount % 10 === 0 || successRate >= 70) {
    //         const trendEmoji = currentDir > 0 ? '📈' : '📉';
    //         const dirLabel = currentDir > 0 ? 'UP' : 'DOWN';
    //         LOGGER.debug(`[${asset}] ${trendEmoji} Trend: ${dirLabel}×${currentStreak} | History: ${successCount}/${totalMatches} → 4+ = ${successRate.toFixed(1)}% | Last10: [${recent.slice(-10).join(',')}]`);
    //     }

    //     // ══════════════════════════════════════════
    //     // STEP 6: EXECUTE TRADE IF ≥80% CONFIDENCE
    //     // ══════════════════════════════════════════
    //     if (successRate >= 11) {
    //         const direction = currentDir > 0 ? 'CALL' : 'CALL';
    //         const dirName = currentDir > 0 ? 'RISE' : 'RISE';
    //         const trendEmoji = currentDir > 0 ? '📈' : '📉';

    //         LOGGER.trade(`═══════════════════════════════════════════════════════════`);
    //         LOGGER.trade(`${trendEmoji} TREND SIGNAL CONFIRMED`);
    //         LOGGER.trade(`   Asset: ${asset}`);
    //         LOGGER.trade(`   Direction: ${dirName} (${currentDir > 0 ? 'UPTREND' : 'DOWNTREND'})`);
    //         LOGGER.trade(`   Current Streak: ${currentStreak} ticks`);
    //         LOGGER.trade(`   Historical: ${successCount}/${totalMatches} continued to 4+ = ${successRate.toFixed(1)}%`);
    //         LOGGER.trade(`   Last 10 digits: [${recent.slice(-10).join(', ')}]`);
    //         LOGGER.trade(`   Stake: $${state.currentStake.toFixed(2)} | Level: ${state.martingaleLevel}`);
    //         LOGGER.trade(`═══════════════════════════════════════════════════════════`);

    //         state.lastSignalTime = now;
    //         state.canTrade = true;

    //         bot.executeNextTrade(asset, direction, {
    //             reason: `${currentDir > 0 ? 'UPTREND' : 'DOWNTREND'} ${currentStreak}→4+ (${successRate.toFixed(0)}%)`,
    //             probability: successRate.toFixed(1),
    //             oscInfo: `Streak: ${currentStreak}, Hist: ${successCount}/${totalMatches}`
    //         });
    //     }
    // }


    // ════════════════════════════════════════════════════════════════
    // 2025 OSCILLATION LENGTH TRACKER + TREND PREDICTOR
    //
    // HOW IT WORKS:
    // 1. Scans tick history to find all OSCILLATION → TREND transitions
    // 2. Records the length of each oscillation phase before breakout
    // 3. Learns the "typical" oscillation length before a 3+ trend
    // 4. When current oscillation reaches that length → EXECUTE TRADE
    // 5. Direction = most likely breakout direction from historical data
    //
    // DEFINITIONS:
    // - OSCILLATION: Ticks bouncing back and forth (reversals)
    // - TREND: 3+ consecutive ticks in same direction (up or down)
    // ════════════════════════════════════════════════════════════════
    analyzeTicks2025(asset) {
        const h = state.assets[asset].tickHistory;
        if (!h || h.length < 10) return;
        if (state.portfolio.activePositions.length > 0) return;
        if (!state.session.isActive) return;

        const now = Date.now();
        if (now - state.lastSignalTime < 3000) return;

        const len = h.length;

        // ══════════════════════════════════════════
        // HELPER: Get step direction
        // Returns: 1 (UP), -1 (DOWN), 0 (same/invalid)
        // Handles wrap: 9→0 is UP, 0→9 is DOWN
        // ══════════════════════════════════════════
        const getStep = (from, to) => {
            if (from === to) return 0;
            const diff = to - from;
            if (diff === 1 || diff === -9) return 1;   // UP
            if (diff === -1 || diff === 9) return -1;  // DOWN
            return 0; // Jump (not single step)
        };

        // ══════════════════════════════════════════
        // STEP 1: Build direction array
        // Convert tick history to sequence of +1/-1/0 moves
        // ══════════════════════════════════════════
        const directions = [];
        for (let i = 1; i < len; i++) {
            directions.push(getStep(h[i - 1], h[i]));
        }

        // ══════════════════════════════════════════
        // STEP 2: Find all OSCILLATION → TREND events in history
        // Oscillation = sequence of alternating +1/-1 (reversals)
        // Trend = 3+ consecutive same direction
        // ══════════════════════════════════════════
        const oscillationLengthsBeforeTrend = [];
        const trendDirectionsAfterOsc = [];

        let i = 0;
        while (i < directions.length - 5) {
            // Check if we're in an oscillation phase
            // Count consecutive reversals (direction changes)
            let oscStart = i;
            let oscLength = 0;
            let lastDir = directions[i];

            if (lastDir === 0) {
                i++;
                continue;
            }

            // Walk forward counting oscillation ticks
            let j = i + 1;
            while (j < directions.length - 3) {
                const currDir = directions[j];

                if (currDir === 0) {
                    j++;
                    continue;
                }

                // Is this a reversal? (direction changed from last)
                if (currDir === -lastDir) {
                    oscLength++;
                    lastDir = currDir;
                    j++;
                } else if (currDir === lastDir) {
                    // Same direction = potential trend start
                    // Check if it's a 3+ trend
                    let trendLen = 1;
                    let trendDir = currDir;
                    let k = j + 1;

                    while (k < directions.length && directions[k] === trendDir) {
                        trendLen++;
                        k++;
                    }

                    if (trendLen >= 2) {
                        // Found a 3+ trend after oscillation
                        // (trendLen counts moves, so 2 moves = 3 ticks in trend)
                        if (oscLength >= 3) {
                            oscillationLengthsBeforeTrend.push(oscLength);
                            trendDirectionsAfterOsc.push(trendDir);
                        }
                        i = k;
                        break;
                    } else {
                        // Not a real trend, continue oscillation
                        oscLength++;
                        lastDir = currDir;
                        j++;
                    }
                } else {
                    j++;
                }
            }

            if (j >= directions.length - 3) {
                i = j;
            }
            i++;
        }

        // ══════════════════════════════════════════
        // STEP 3: Calculate typical oscillation length
        // ══════════════════════════════════════════
        if (oscillationLengthsBeforeTrend.length < CONFIG.MIN_OSC_EVENTS) {
            LOGGER.debug(`[${asset}] Not enough osc→trend data: ${oscillationLengthsBeforeTrend.length} events`);
            return;
        }

        // Get recent oscillation lengths (last 15 events)
        const recentOscLengths = oscillationLengthsBeforeTrend.slice(-15);
        const recentTrendDirs = trendDirectionsAfterOsc.slice(-15);

        // Calculate stats
        const sortedLengths = [...recentOscLengths].sort((a, b) => a - b);
        const avgOscLength = recentOscLengths.reduce((a, b) => a + b, 0) / recentOscLengths.length;
        const medianOscLength = sortedLengths[Math.floor(sortedLengths.length / 2)];
        const maxOscLength = Math.max(...recentOscLengths);
        const minOscLength = Math.min(...recentOscLengths);

        // Target = when oscillation "should" break (we use 80-90% of max)
        const targetOscLength = Math.floor(maxOscLength * CONFIG.OSC_TARGET_RATIO);

        // ══════════════════════════════════════════
        // STEP 4: Measure CURRENT oscillation length
        // ══════════════════════════════════════════
        let currentOscLength = 0;
        let lastDirection = 0;
        const recent50 = directions.slice(-20);

        // Walk backwards from the end to count current oscillation
        for (let r = recent50.length - 1; r >= 0; r--) {
            const dir = recent50[r];

            if (dir === 0) continue;

            if (lastDirection === 0) {
                lastDirection = dir;
                currentOscLength = 1;
            } else if (dir === -lastDirection) {
                // Reversal = still oscillating
                currentOscLength++;
                lastDirection = dir;
            } else if (dir === lastDirection) {
                // Same direction = oscillation ended, we're in trend/breakout
                break;
            }
        }

        // ══════════════════════════════════════════
        // STEP 5: Log current state for debugging
        // ══════════════════════════════════════════
        this.logCount = (this.logCount || 0) + 1;
        if (this.logCount % 20 === 0) {
            LOGGER.debug(`[${asset}] 📊 Osc Stats: avg=${avgOscLength.toFixed(1)}, median=${medianOscLength}, max=${maxOscLength}, current=${currentOscLength}, target=${targetOscLength}`);
            LOGGER.debug(`[${asset}] 📊 Last 15 osc lengths: [${recentOscLengths.join(',')}]`);
        }

        // ══════════════════════════════════════════
        // STEP 6: Check if current oscillation is "ripe"
        // Trade when current oscillation >= target length
        // ══════════════════════════════════════════
        if (currentOscLength < targetOscLength) {
            return;
        }

        // Extra safety: don't trade if oscillation is way beyond max (anomaly)
        if (currentOscLength > maxOscLength * CONFIG.MAX_OSC_MULTIPLIER) {
            LOGGER.debug(`[${asset}] ⚠️ Oscillation too long: ${currentOscLength} > ${maxOscLength * CONFIG.MAX_OSC_MULTIPLIER}, skipping`);
            return;
        }

        // ══════════════════════════════════════════
        // STEP 7: Predict breakout direction
        // Based on historical trend directions after similar oscillations
        // ══════════════════════════════════════════
        let upBreaks = 0;
        let downBreaks = 0;

        // Weight recent breakouts more heavily
        for (let t = 0; t < recentTrendDirs.length; t++) {
            const weight = 1 + (t / recentTrendDirs.length); // More recent = higher weight
            if (recentTrendDirs[t] > 0) upBreaks += weight;
            else if (recentTrendDirs[t] < 0) downBreaks += weight;
        }

        // Also check last few ticks for early breakout hint
        const lastFew = h.slice(-5);
        let earlyHintDir = 0;

        if (lastFew.length >= 3) {
            const step1 = getStep(lastFew[lastFew.length - 3], lastFew[lastFew.length - 2]);
            const step2 = getStep(lastFew[lastFew.length - 2], lastFew[lastFew.length - 1]);

            if (step1 !== 0 && step1 === step2) {
                // Last 2 moves in same direction = early breakout signal
                earlyHintDir = step1;
            }
        }

        // Determine final direction
        let predictedDir = 0;
        let confidence = 0;

        if (earlyHintDir !== 0) {
            // Trust the early hint more
            predictedDir = earlyHintDir;
            confidence = 75; // Base confidence for early hint

            // Boost confidence if historical data agrees
            if ((earlyHintDir > 0 && upBreaks > downBreaks) ||
                (earlyHintDir < 0 && downBreaks > upBreaks)) {
                confidence = 85;
            }
        } else {
            // No early hint, use historical bias
            const totalBreaks = upBreaks + downBreaks;
            if (totalBreaks < 3) return;

            if (upBreaks > downBreaks * 1.3) {
                predictedDir = 1;
                confidence = (upBreaks / totalBreaks) * 100;
            } else if (downBreaks > upBreaks * 1.3) {
                predictedDir = -1;
                confidence = (downBreaks / totalBreaks) * 100;
            } else {
                // No clear bias, skip
                LOGGER.debug(`[${asset}] ⚠️ No clear direction bias: UP=${upBreaks.toFixed(1)}, DOWN=${downBreaks.toFixed(1)}`);
                return;
            }
        }

        if (confidence < CONFIG.MIN_CONFIDENCE) {
            LOGGER.debug(`[${asset}] ⚠️ Confidence too low: ${confidence.toFixed(1)}%`);
            return;
        }

        // ══════════════════════════════════════════
        // STEP 8: EXECUTE TRADE
        // ══════════════════════════════════════════
        const direction = predictedDir > 0 ? 'CALLE' : 'PUTE';
        const dirName = predictedDir > 0 ? 'RISE' : 'FALL';
        const trendEmoji = predictedDir > 0 ? '📈' : '📉';

        if (dirName === 'FALL') {
            LOGGER.debug(`[${asset}] ⚠️ FALL direction not allowed`);
            return;
        }

        LOGGER.trade(`═══════════════════════════════════════════════════════════`);
        LOGGER.trade(`${trendEmoji} OSCILLATION BREAKOUT SIGNAL`);
        LOGGER.trade(`   Asset: ${asset}`);
        LOGGER.trade(`   Direction: ${dirName}`);
        LOGGER.trade(`   Current Oscillation: ${currentOscLength} ticks (target: ${targetOscLength})`);
        LOGGER.trade(`   Typical Lengths: avg=${avgOscLength.toFixed(1)}, median=${medianOscLength}, max=${maxOscLength}`);
        LOGGER.trade(`   Historical Bias: UP=${upBreaks.toFixed(1)}, DOWN=${downBreaks.toFixed(1)}`);
        LOGGER.trade(`   Early Hint: ${earlyHintDir > 0 ? 'UP' : earlyHintDir < 0 ? 'DOWN' : 'NONE'}`);
        LOGGER.trade(`   Confidence: ${confidence.toFixed(1)}%`);
        LOGGER.trade(`   Last 10 digits: [${h.slice(-10).join(', ')}]`);
        LOGGER.trade(`   Stake: $${state.currentStake.toFixed(2)} | Level: ${state.martingaleLevel}`);
        LOGGER.trade(`═══════════════════════════════════════════════════════════`);

        state.lastSignalTime = now;
        state.canTrade = true;

        bot.executeNextTrade(asset, direction, {
            reason: `OSC ${currentOscLength}/${targetOscLength} → ${dirName}`,
            probability: confidence.toFixed(1),
            oscInfo: `Osc: ${currentOscLength}t, avg=${avgOscLength.toFixed(1)}, max=${maxOscLength}`
        });
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else if (['stpRNG', 'stpRNG2', 'stpRNG3', 'stpRNG4', 'stpRNG5'].includes(asset)) {
            return fractionalPart.length >= 1 ? parseInt(fractionalPart[0]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
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

            TelegramService.sendMessage(`⚠️ <b>CONNECTION LOST</b>\nAttempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\nRetrying in ${(delay / 1000).toFixed(1)}s\nState preserved: ${state.session.tradesCount} trades, $${state.session.netPL.toFixed(2)} P&L`);

            setTimeout(() => {
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            TelegramService.sendMessage(`🛑 <b>BOT STOPPED</b>\nMax reconnection attempts.\nFinal P&L: $${state.session.netPL.toFixed(2)}`);
            process.exit(1);
        }
    }

    startPing() {
        this.pingInterval = setInterval(() => {
            if (state.isConnected) this.send({ ping: 1 });
        }, 30000);
    }

    stopPing() {
        if (this.pingInterval) clearInterval(this.pingInterval);
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
        console.log(' 🎯 2025 stpRNG DEEP OSCILLATION BREAKOUT BOT');
        console.log('═'.repeat(80));
        console.log(`💰 Capital: $${state.capital.toFixed(2)}`);
        console.log(`📊 Assets: ${ACTIVE_ASSETS.join(', ')}`);
        console.log(`💵 Base Stake: $${CONFIG.STAKE}`);
        console.log(`⏱️ Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT === 't' ? 'Ticks' : 'Seconds'}`);
        console.log(`🎯 Min Confidence: ${CONFIG.MIN_TREND_CONFIDENCE}%`);
        console.log(`📈 Session Target: +$${CONFIG.SESSION_PROFIT_TARGET} | Stop: -$${Math.abs(CONFIG.SESSION_STOP_LOSS)}`);
        console.log(`📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ENABLED' : 'DISABLED'}`);
        console.log('═'.repeat(80));
        console.log('📋 Strategy: Deep Oscillation Scanner → Breakout Detection');
        console.log('    1. Scans full tick history for A-B-A-B oscillation patterns');
        console.log('    2. Detects clean breakout from oscillation phase');
        console.log('    3. Backtests identical pattern against all historical data');
        console.log('    4. Only trades when historical success ≥ 80%');
        console.log('═'.repeat(80) + '\n');

        this.connection.initializeAssets();

        ACTIVE_ASSETS.forEach(symbol => {
            this.subscribeToCandles(symbol);
            this.connection.subscribeToTicks(symbol);
        });

        TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();

        LOGGER.info('✅ Bot started — Scanning for oscillation breakouts...');
    }

    subscribeToCandles(symbol) {
        LOGGER.info(`📊 Subscribing to ${CONFIG.TIMEFRAME_LABEL} candles for ${symbol}...`);

        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: CONFIG.CANDLES_TO_LOAD,
            end: 'latest', start: 1,
            style: 'candles',
            granularity: CONFIG.GRANULARITY
        });

        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: 1, end: 'latest', start: 1,
            style: 'candles',
            granularity: CONFIG.GRANULARITY,
            subscribe: 1
        });
    }

    executeNextTrade(symbol, direction, signalDetails = {}) {
        if (!state.session.isActive) return;
        if (state.portfolio.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) return;

        const tradeSymbol = symbol || ACTIVE_ASSETS[0];
        const stake = state.currentStake;

        if (state.capital < stake) {
            LOGGER.error(`Insufficient capital: $${state.capital.toFixed(2)} < $${stake.toFixed(2)}`);
            if (state.martingaleLevel > 0) {
                state.martingaleLevel = 0;
                state.currentStake = CONFIG.STAKE;
            }
            return;
        }

        const lastDigit = state.tickData.lastDigit;
        if (lastDigit === null) {
            LOGGER.warn(`⚠️ No tick data yet for ${tradeSymbol}`);
            return;
        }

        const dirName = direction === 'CALLE' ? 'RISE' : 'FALL';
        state.canTrade = false;
        state.lastTradeDirection = dirName;

        LOGGER.trade(`🎯 Executing ${dirName} on ${tradeSymbol} | Stake: $${stake.toFixed(2)} | Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT} | Level: ${state.martingaleLevel}`);

        const position = {
            symbol: tradeSymbol,
            direction: dirName,
            stake: stake,
            duration: CONFIG.DURATION,
            durationUnit: CONFIG.DURATION_UNIT,
            entryTime: Date.now(),
            contractId: null,
            reqId: null,
            currentProfit: 0,
            buyPrice: 0,
            reason: signalDetails.reason || '',
            probability: signalDetails.probability || '',
            oscInfo: signalDetails.oscInfo || ''
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
        StatePersistence.saveState();
        TelegramService.sendSessionSummary();

        setTimeout(() => {
            if (this.connection.ws) this.connection.ws.close();
            LOGGER.info('👋 Bot stopped');
        }, 2000);
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay();
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            const isWeekend = (currentDay === 0) ||
                (currentDay === 6 && currentHours >= 23) ||
                (currentDay === 1 && currentHours < 2);

            if (isWeekend) {
                if (state.session.isActive) {
                    LOGGER.info("Weekend suspension. Disconnecting...");
                    TelegramService.sendHourlySummary();
                    if (this.connection.ws) this.connection.ws.close();
                    state.session.isActive = false;
                }
                return;
            }

            if (!state.session.isActive && currentHours === 2 && currentMinutes >= 0) {
                LOGGER.info("2:00 AM GMT+1, reconnecting...");
                this.resetDailyStats();
                state.session.isActive = true;
                this.connection.connect();
            }

            if (state.lastTradeWasWin && state.session.isActive) {
                if (currentHours >= 23 && currentMinutes >= 0) {
                    LOGGER.info("23:00 GMT+1 after win, disconnecting...");
                    TelegramService.sendHourlySummary();
                    if (this.connection.ws) this.connection.ws.close();
                    state.session.isActive = false;
                }
            }
        }, 20000);
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
        state.oscillationLog = [];
        LOGGER.info('📊 Daily stats reset');
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
            lastWasWin: state.lastTradeWasWin,
            martingaleLevel: state.martingaleLevel,
            currentStake: state.currentStake,
            activePositionsCount: state.portfolio.activePositions.length,
            activePositions: state.portfolio.activePositions.map(pos => ({
                symbol: pos.symbol,
                direction: pos.direction,
                stake: pos.stake,
                duration: `${pos.duration}${pos.durationUnit}`,
                profit: pos.currentProfit,
                contractId: pos.contractId,
                reason: pos.reason
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

// Initialize assets before loading state
ACTIVE_ASSETS.forEach(symbol => {
    if (!state.assets[symbol]) {
        state.assets[symbol] = {
            candles: [], closedCandles: [], tickHistory: [],
            currentFormingCandle: null, lastProcessedCandleOpenTime: null,
            candlesLoaded: false, lastTick: null, lastDigit: null
        };
    }
});

const stateLoaded = StatePersistence.loadState();

if (stateLoaded) {
    LOGGER.info('🔄 Bot will resume from saved state after connection');
} else {
    LOGGER.info('🆕 Bot will start with fresh state');
}

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═'.repeat(80));
    console.log(' stpRNG 2025 OSCILLATION BREAKOUT BOT');
    console.log('═'.repeat(80));
    console.log('\n⚠️ API Token not configured!');
    console.log('\nSet CONFIG.API_TOKEN in the source code');
    console.log('═'.repeat(80));
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(' 🎯 stpRNG 2025 DEEP OSCILLATION BREAKOUT BOT');
console.log(` Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT} | Stake: $${CONFIG.STAKE} | Confidence: ${CONFIG.MIN_TREND_CONFIDENCE}%`);
console.log('═'.repeat(80));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

// Status display every 30 seconds
setInterval(() => {
    if (state.isAuthorized) {
        const status = bot.getStatus();
        const s = state.session;
        const h = state.assets[ACTIVE_ASSETS[0]]?.tickHistory?.length || 0;
        console.log(`\n📊 ${getGMTTime()} | Trades: ${status.session.trades} | WR: ${status.session.winRate} | P&L: $${status.session.netPL.toFixed(2)} | Capital: $${state.capital.toFixed(2)} | Active: ${status.activePositionsCount} | Ticks: ${h}`);
        console.log(`📉 Losses: x2:${s.x2Losses} x3:${s.x3Losses} x4:${s.x4Losses} x5:${s.x5Losses} x6:${s.x6Losses} x7:${s.x7Losses} | Level: ${state.martingaleLevel} | Stake: $${state.currentStake.toFixed(2)}`);
    }
}, 30000);
