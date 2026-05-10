const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'VolatilityBreakout_01_v1-state.json');
const HISTORY_FILE = path.join(__dirname, 'VolatilityBreakout_01_v1-history.json');

const STATE_SAVE_INTERVAL = 5000;

// ============================================
// TRADE HISTORY MANAGER
// ============================================
class TradeHistoryManager {
    static getDateKey() {
        const now = new Date();
        return now.toISOString().split('T')[0];
    }

    static loadHistory() {
        try {
            if (!fs.existsSync(HISTORY_FILE)) {
                LOGGER.info('📁 No trade history file found, starting fresh history');
                return {
                    overall: {
                        tradesCount: 0, winsCount: 0, lossesCount: 0,
                        profit: 0, loss: 0, netPL: 0,
                        firstTradeDate: null, lastTradeDate: null
                    },
                    overallAssets: {},
                    dailyHistory: {},
                    lastUpdated: Date.now()
                };
            }
            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            if (!data.dailyHistory) data.dailyHistory = {};
            if (!data.overallAssets) data.overallAssets = {};
            if (!data.overall) data.overall = {
                tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0
            };
            LOGGER.info(`📁 Trade history loaded — ${Object.keys(data.dailyHistory).length} days of history`);
            return data;
        } catch (error) {
            LOGGER.error(`Failed to load trade history: ${error.message}`);
            return {
                overall: {
                    tradesCount: 0, winsCount: 0, lossesCount: 0,
                    profit: 0, loss: 0, netPL: 0,
                    firstTradeDate: null, lastTradeDate: null
                },
                overallAssets: {},
                dailyHistory: {},
                lastUpdated: Date.now()
            };
        }
    }

    static saveHistory() {
        try {
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
        } catch (error) {
            LOGGER.error(`Failed to save trade history: ${error.message}`);
        }
    }

    static ensureDayEntry(dateKey) {
        if (!tradeHistory.dailyHistory[dateKey]) {
            tradeHistory.dailyHistory[dateKey] = {
                date: dateKey,
                tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0,
                assets: {},
                startCapital: state.capital,
                endCapital: state.capital
            };
        }
    }

    static ensureAssetDayEntry(dateKey, symbol) {
        this.ensureDayEntry(dateKey);
        if (!tradeHistory.dailyHistory[dateKey].assets[symbol]) {
            tradeHistory.dailyHistory[dateKey].assets[symbol] = {
                tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0
            };
        }
    }

    static ensureOverallAssetEntry(symbol) {
        if (!tradeHistory.overallAssets[symbol]) {
            tradeHistory.overallAssets[symbol] = {
                tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0
            };
        }
    }

    static recordTrade(symbol, profit) {
        const dateKey = this.getDateKey();
        this.ensureAssetDayEntry(dateKey, symbol);
        this.ensureOverallAssetEntry(symbol);

        const dayStats = tradeHistory.dailyHistory[dateKey];
        const dayAssetStats = dayStats.assets[symbol];
        const overall = tradeHistory.overall;
        const overallAsset = tradeHistory.overallAssets[symbol];

        dayStats.tradesCount++;
        dayAssetStats.tradesCount++;
        overall.tradesCount++;
        overallAsset.tradesCount++;

        if (!overall.firstTradeDate) overall.firstTradeDate = dateKey;
        overall.lastTradeDate = dateKey;

        if (profit > 0) {
            dayStats.winsCount++; dayStats.profit += profit; dayStats.netPL += profit;
            dayAssetStats.winsCount++; dayAssetStats.profit += profit; dayAssetStats.netPL += profit;
            overall.winsCount++; overall.profit += profit; overall.netPL += profit;
            overallAsset.winsCount++; overallAsset.profit += profit; overallAsset.netPL += profit;
        } else {
            dayStats.lossesCount++; dayStats.loss += Math.abs(profit); dayStats.netPL += profit;
            dayAssetStats.lossesCount++; dayAssetStats.loss += Math.abs(profit); dayAssetStats.netPL += profit;
            overall.lossesCount++; overall.loss += Math.abs(profit); overall.netPL += profit;
            overallAsset.lossesCount++; overallAsset.loss += Math.abs(profit); overallAsset.netPL += profit;
        }

        dayStats.endCapital = state.capital;
        tradeHistory.lastUpdated = Date.now();
        this.saveHistory();
    }

    static getTodayStats() {
        const dateKey = this.getDateKey();
        this.ensureDayEntry(dateKey);
        return tradeHistory.dailyHistory[dateKey];
    }

    static getOverallStats() { return tradeHistory.overall; }
    static getDayStats(dateKey) { return tradeHistory.dailyHistory[dateKey] || null; }
    static getAllDays() { return Object.keys(tradeHistory.dailyHistory).sort(); }
    static getRecentDays(n = 7) {
        const days = this.getAllDays();
        return days.slice(-n).map(dateKey => ({ date: dateKey, ...tradeHistory.dailyHistory[dateKey] }));
    }
}

// ============================================
// STATE PERSISTENCE
// ============================================
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
                    dailyLosses: state.portfolio.dailyLosses
                },
                hourlyStats: { ...state.hourlyStats },
                currentTradeDay: state.currentTradeDay,
                assets: {}
            };

            Object.keys(state.assets).forEach(symbol => {
                const asset = state.assets[symbol];
                const assetConfig = getAssetConfig(symbol);
                persistableState.assets[symbol] = {
                    closedCandles: asset.closedCandles.slice(-assetConfig.MAX_CANDLES_STORED),
                    lastProcessedCandleOpenTime: asset.lastProcessedCandleOpenTime,
                    candlesLoaded: asset.candlesLoaded,
                    currentStake: asset.currentStake,
                    canTrade: asset.canTrade,
                    tradesCount: asset.tradesCount,
                    winsCount: asset.winsCount,
                    lossesCount: asset.lossesCount,
                    profit: asset.profit,
                    loss: asset.loss,
                    netPL: asset.netPL,
                    consecutiveLosses: asset.consecutiveLosses,
                    activePositions: asset.activePositions.map(pos => ({
                        symbol: pos.symbol, direction: pos.direction,
                        stake: pos.stake, duration: pos.duration,
                        durationUnit: pos.durationUnit, entryTime: pos.entryTime,
                        contractId: pos.contractId, reqId: pos.reqId,
                        buyPrice: pos.buyPrice, currentProfit: pos.currentProfit
                    }))
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
                LOGGER.info('📁 No previous state file found, starting fresh');
                return false;
            }

            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            if (ageMinutes > 30) {
                LOGGER.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            LOGGER.info(`📁 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);

            state.capital = savedData.capital;
            state.session = {
                ...state.session, ...savedData.session,
                startTime: savedData.session.startTime || Date.now(),
                startCapital: savedData.session.startCapital || savedData.capital
            };
            state.portfolio.dailyProfit = savedData.portfolio.dailyProfit;
            state.portfolio.dailyLoss = savedData.portfolio.dailyLoss;
            state.portfolio.dailyWins = savedData.portfolio.dailyWins;
            state.portfolio.dailyLosses = savedData.portfolio.dailyLosses;
            state.currentTradeDay = savedData.currentTradeDay || TradeHistoryManager.getDateKey();
            state.hourlyStats = savedData.hourlyStats || {
                trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours()
            };

            if (savedData.assets) {
                Object.keys(savedData.assets).forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = savedData.assets[symbol];
                        const asset = state.assets[symbol];

                        if (saved.closedCandles && saved.closedCandles.length > 0) {
                            asset.closedCandles = saved.closedCandles;
                            LOGGER.info(`📊 Restored ${saved.closedCandles.length} closed candles for ${symbol}`);
                        }
                        asset.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                        asset.candlesLoaded = saved.candlesLoaded || false;
                        asset.currentStake = saved.currentStake || CONFIG.STAKE;
                        asset.canTrade = saved.canTrade || false;
                        asset.tradesCount = saved.tradesCount || 0;
                        asset.winsCount = saved.winsCount || 0;
                        asset.lossesCount = saved.lossesCount || 0;
                        asset.profit = saved.profit || 0;
                        asset.loss = saved.loss || 0;
                        asset.netPL = saved.netPL || 0;
                        asset.consecutiveLosses = saved.consecutiveLosses || 0;
                        asset.activePositions = (saved.activePositions || []).map(
                            pos => ({ ...pos, entryTime: pos.entryTime || Date.now() })
                        );
                        LOGGER.info(
                            `📊 ${symbol}: Stake=$${asset.currentStake.toFixed(2)}, P/L=$${asset.netPL.toFixed(2)}, ` +
                            `Positions=${asset.activePositions.length}`
                        );
                    }
                });
            }

            LOGGER.info(`✅ State restored successfully!`);
            LOGGER.info(`💰 Capital: $${state.capital.toFixed(2)}`);
            LOGGER.info(`📊 Session P/L: $${state.session.netPL.toFixed(2)}`);
            return true;
        } catch (error) {
            LOGGER.error(`Failed to load state: ${error.message}`);
            return false;
        }
    }

    static startAutoSave() {
        setInterval(() => {
            if (state.isAuthorized) this.saveState();
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
    static hourlyTimerStarted = false;
    static dailyTimerStarted = false;

    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED) return;
        try {
            if (!message || message.length === 0) {
                LOGGER.error('[TELEGRAM] ❌ Message is empty! Not sending.');
                return;
            }
            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const data = JSON.stringify({
                chat_id: CONFIG.TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            });
            const byteLength = Buffer.byteLength(data, 'utf8');
            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': byteLength }
            };
            return new Promise((resolve, reject) => {
                const req = https.request(url, options, res => {
                    let body = '';
                    res.on('data', chunk => (body += chunk));
                    res.on('end', () => {
                        if (res.statusCode === 200) resolve(true);
                        else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
                    });
                });
                req.on('error', reject);
                req.write(data);
                req.end();
            }).then(() => {
                LOGGER.info('[TELEGRAM] ✅ Message sent successfully');
            }).catch(error => {
                LOGGER.error(`[TELEGRAM] ❌ Send failed: ${error.message}`);
            });
        } catch (error) {
            LOGGER.error(`[TELEGRAM] ❌ Failed to send message: ${error.message}`);
        }
    }

    static async sendTradeAlert(type, symbol, direction, stake, duration, durationUnit, details = {}) {
        const emoji = type === 'OPEN' ? '🚀' : type === 'WIN' ? '✅' : '❌';
        const assetState = state.assets[symbol];
        const assetNetPL = assetState ? assetState.netPL : 0;
        const assetWins = assetState ? assetState.winsCount : 0;
        const assetLosses = assetState ? assetState.lossesCount : 0;

        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();

        const message = `
${emoji} <b>${type} TRADE - VOLATILITY BREAKOUT</b>
Asset: ${symbol}
Direction: ${direction}
Stake: $${stake.toFixed(2)}
Duration: ${duration}${durationUnit}
${details.signal ? `Signal: ${details.signal}` : ''}
${details.volatility ? `Volatility: ${details.volatility}` : ''}
${details.profit !== undefined
                ? `Profit: $${details.profit.toFixed(2)}

📊 <b>Today's Stats:</b>
${symbol} P&L: $${assetNetPL.toFixed(2)}
${symbol} W/L: ${assetWins}/${assetLosses}
Today P&L: $${(today.netPL || 0).toFixed(2)}
Today W/L: ${today.winsCount || 0}/${today.lossesCount || 0}

📋 <b>Overall Stats:</b>
Overall P&L: $${(overall.netPL || 0).toFixed(2)}
Overall W/L: ${overall.winsCount || 0}/${overall.lossesCount || 0}
Total Trades: ${overall.tradesCount || 0}
Capital: $${state.capital.toFixed(2)}
`
                : ''
            }`.trim();

        await this.sendMessage(message);
    }

    static async sendSessionSummary() {
        try {
            const stats = SessionManager.getSessionStats();
            const today = TradeHistoryManager.getTodayStats();
            const overall = TradeHistoryManager.getOverallStats();

            let assetBreakdown = '';
            CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                const a = state.assets[symbol];
                if (a && a.tradesCount > 0) {
                    const winRate = a.tradesCount > 0 ? ((a.winsCount / a.tradesCount) * 100).toFixed(1) : '0.0';
                    assetBreakdown += `\n  ${symbol}: ${a.tradesCount} trades, ${a.winsCount}W/${a.lossesCount}L (${winRate}%), P/L: $${a.netPL.toFixed(2)}`;
                }
            });

            const overallWinRate = overall.tradesCount > 0
                ? ((overall.winsCount / overall.tradesCount) * 100).toFixed(1) + '%'
                : '0.0%';

            const message = [
                `📊 <b>SESSION SUMMARY - VOLATILITY BREAKOUT</b>`, ``,
                `🗓️ <b>Today (${TradeHistoryManager.getDateKey()}):</b>`,
                `Duration: ${stats.duration}`, `Trades: ${stats.trades}`,
                `Wins: ${stats.wins} | Losses: ${stats.losses}`,
                `Win Rate: ${stats.winRate}`,
                `Today P/L: $${(today.netPL || 0).toFixed(2)}`, ``,
                `📋 <b>Per-Asset:</b>${assetBreakdown || '\n  No trades yet'}`, ``,
                `📊 <b>Overall Stats:</b>`,
                `Total Trades: ${overall.tradesCount || 0}`,
                `Overall Win Rate: ${overallWinRate}`,
                `Overall P/L: $${(overall.netPL || 0).toFixed(2)}`, ``,
                `💰 Current Capital: $${state.capital.toFixed(2)}`
            ].join('\n');

            await this.sendMessage(message);
        } catch (err) {
            LOGGER.error(`❌ sendSessionSummary crashed: ${err.message}`);
        }
    }

    static async sendDayEndSummary(dateKey) {
        try {
            const dayStats = TradeHistoryManager.getDayStats(dateKey);
            const overall = TradeHistoryManager.getOverallStats();
            if (!dayStats || dayStats.tradesCount === 0) return;

            const dayWinRate = dayStats.tradesCount > 0
                ? ((dayStats.winsCount / dayStats.tradesCount) * 100).toFixed(1) + '%'
                : '0.0%';
            const overallWinRate = overall.tradesCount > 0
                ? ((overall.winsCount / overall.tradesCount) * 100).toFixed(1) + '%'
                : '0.0%';

            let assetBreakdown = '';
            if (dayStats.assets) {
                Object.keys(dayStats.assets).forEach(symbol => {
                    const a = dayStats.assets[symbol];
                    if (a && a.tradesCount > 0) {
                        const wr = ((a.winsCount / a.tradesCount) * 100).toFixed(1);
                        assetBreakdown += `\n  ${symbol}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L (${wr}%) P/L: $${(a.netPL || 0).toFixed(2)}`;
                    }
                });
            }

            const pnlEmoji = (dayStats.netPL || 0) >= 0 ? '🟢' : '🔴';
            const message = [
                `🌙 <b>END OF DAY - ${dateKey}</b>`, ``,
                `${pnlEmoji} <b>Day Results:</b>`,
                `├ Trades: ${dayStats.tradesCount}`,
                `├ Wins: ${dayStats.winsCount} | Losses: ${dayStats.lossesCount}`,
                `├ Win Rate: ${dayWinRate}`,
                `└ Net P/L: $${(dayStats.netPL || 0).toFixed(2)}`, ``,
                `📋 <b>Per-Asset:</b>${assetBreakdown || '\n  No trades'}`, ``,
                `📊 <b>Overall (All Time):</b>`,
                `├ Total Trades: ${overall.tradesCount || 0}`,
                `├ Win Rate: ${overallWinRate}`,
                `└ P/L: $${(overall.netPL || 0).toFixed(2)}`, ``,
                `💰 Capital: $${state.capital.toFixed(2)}`
            ].join('\n');

            await this.sendMessage(message);
        } catch (err) {
            LOGGER.error(`❌ sendDayEndSummary crashed: ${err.message}`);
        }
    }

    static async sendStartupMessage() {
        try {
            const overall = TradeHistoryManager.getOverallStats();
            const totalDays = TradeHistoryManager.getAllDays().length;

            const message = [
                `🤖 <b>VOLATILITY BREAKOUT BOT STARTED</b>`,
                `Strategy: Professional Volatility Compression + Momentum`,
                `Capital: $${state.capital.toFixed(2)}`,
                `Base Stake: $${CONFIG.STAKE}`,
                `Assets: ${CONFIG.ACTIVE_ASSETS.join(', ')}`, ``,
                `📊 <b>Historical Performance:</b>`,
                `├ Trading Days: ${totalDays}`,
                `├ Total Trades: ${overall.tradesCount || 0}`,
                `└ Overall P/L: $${(overall.netPL || 0).toFixed(2)}`
            ].join('\n');

            await this.sendMessage(message);
        } catch (error) {
            LOGGER.error(`[TELEGRAM] Failed to send startup message: ${error.message}`);
        }
    }

    static async sendHourlySummary() {
        try {
            const statsSnapshot = { ...state.hourlyStats };
            if (statsSnapshot.trades === 0) {
                LOGGER.info('📊 Skipping hourly summary (no trades)');
                return;
            }

            const totalTrades = statsSnapshot.wins + statsSnapshot.losses;
            const winRate = totalTrades > 0 ? ((statsSnapshot.wins / totalTrades) * 100).toFixed(1) : '0.0';
            const pnlEmoji = statsSnapshot.pnl >= 0 ? '🟢' : '🔴';
            const pnlStr = (statsSnapshot.pnl >= 0 ? '+' : '') + '$' + statsSnapshot.pnl.toFixed(2);

            const today = TradeHistoryManager.getTodayStats();

            const message = [
                `⏰ <b>Hourly Summary - Volatility Breakout</b>`, ``,
                `📊 <b>Last Hour</b>`,
                `├ Trades: ${statsSnapshot.trades}`,
                `├ Wins: ${statsSnapshot.wins} | Losses: ${statsSnapshot.losses}`,
                `├ Win Rate: ${winRate}%`,
                `└ ${pnlEmoji} <b>P&L:</b> ${pnlStr}`, ``,
                `🗓️ <b>Today</b>`,
                `├ Trades: ${today.tradesCount || 0}`,
                `└ P/L: ${(today.netPL || 0) >= 0 ? '+' : ''}$${(today.netPL || 0).toFixed(2)}`, ``,
                `💰 Capital: $${state.capital.toFixed(2)}`
            ].join('\n');

            await this.sendMessage(message);
            state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
        } catch (err) {
            LOGGER.error(`❌ sendHourlySummary crashed: ${err.message}`);
        }
    }

    static startHourlyTimer() {
        if (this.hourlyTimerStarted) return;
        this.hourlyTimerStarted = true;
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const timeUntilNextHour = nextHour.getTime() - now.getTime();
        LOGGER.info(`⏰ Hourly timer started (first summary in ${Math.ceil(timeUntilNextHour / 60000)} min)`);
        setTimeout(() => {
            this.sendHourlySummary();
            setInterval(() => this.sendHourlySummary(), 60 * 60 * 1000);
        }, timeUntilNextHour);
    }

    static startDailyTimer() {
        if (this.dailyTimerStarted) return;
        this.dailyTimerStarted = true;
        const now = new Date();
        const nextDay = new Date(now);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(0, 0, 0, 0);
        const timeUntilNextDay = nextDay.getTime() - now.getTime();
        LOGGER.info(`🗓️ Daily timer started (first summary in ${Math.ceil(timeUntilNextDay / 60000 / 60)} hours)`);
        setTimeout(() => {
            if (typeof SessionManager !== 'undefined') SessionManager.checkDayChange();
            setInterval(() => {
                if (typeof SessionManager !== 'undefined') SessionManager.checkDayChange();
            }, 24 * 60 * 60 * 1000);
        }, timeUntilNextDay);
    }
}

// ============================================
// LOGGER UTILITY
// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    API_TOKEN: 'hsj0tA0XJoIzJG5',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    INITIAL_CAPITAL: 250,
    STAKE: 0.35,

    SESSION_PROFIT_TARGET: 500000,
    SESSION_STOP_LOSS: -5000,

    // ══════════════════════════════════════════════════════════════
    // VOLATILITY BREAKOUT STRATEGY CONFIG
    // ══════════════════════════════════════════════════════════════

    // Candle settings
    GRANULARITY: 60,              // 1-minute candles
    TIMEFRAME_LABEL: '1m',
    MAX_CANDLES_STORED: 100,      // Keep 100 candles for analysis
    CANDLES_TO_LOAD: 100,

    // Volatility analysis windows
    VOLATILITY: {
        ATR_PERIOD: 14,           // Standard ATR period
        VOLATILITY_WINDOW: 50,    // Compare recent vs historical
        LOW_VOLATILITY_RATIO: 0.65, // ATR must be 65% below average
        SQUEEZE_CONFIRMATION: 3,   // Need 3 ticks confirmation
    },

    // Breakout detection
    BREAKOUT: {
        LOOKBACK_PERIOD: 20,      // Candles for high/low range
        MIN_STRENGTH: 0.1,        // Minimum breakout strength
        STRONG_STRENGTH: 0.3,     // Strong breakout
        CONFIRMATION_TICKS: 2,    // Wait for confirmation
    },

    // Trend filters
    TREND: {
        USE_EMA_FILTER: true,
        EMA_FAST: 9,
        EMA_SLOW: 21,
        MIN_TREND_STRENGTH: 0.0003, // Minimum EMA separation
    },

    // RSI filters (optional)
    RSI: {
        ENABLED: true,
        PERIOD: 14,
        OVERSOLD: 40,
        OVERBOUGHT: 60,
        USE_DIVERGENCE: false,
    },

    // Position management
    DURATION: 2,                  // 2 ticks duration
    DURATION_UNIT: 't',
    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    TRADE_DELAY: 1000,

    // Kelly Criterion position sizing
    POSITION_SIZING: {
        USE_KELLY: true,
        KELLY_FRACTION: 0.25,     // Quarter Kelly (conservative)
        MAX_POSITION_PCT: 2.0,    // Max 2% of capital per trade
        MIN_STAKE: 0.35,
        MAX_STAKE: 10.0,
    },

    // Risk management (NO MARTINGALE)
    RISK: {
        MAX_CONSECUTIVE_LOSSES: 5,
        DAILY_LOSS_LIMIT: -50,
        REDUCE_SIZE_AFTER_LOSS: true,
        LOSS_REDUCTION_FACTOR: 0.5, // Half stake after loss
        RECOVERY_TRADES_NEEDED: 2,   // Win 2 trades to restore full size
    },

    DEBUG_MODE: true,
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8306232249:AAGMwjFngs68Lcq27oGmqewQgthXTJJRxP0',
    TELEGRAM_CHAT_ID: '752497117',

    ACTIVE_ASSETS: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100']
};

function getAssetConfig(symbol) {
    return {
        GRANULARITY: CONFIG.GRANULARITY,
        TIMEFRAME_LABEL: CONFIG.TIMEFRAME_LABEL,
        MAX_CANDLES_STORED: CONFIG.MAX_CANDLES_STORED,
        CANDLES_TO_LOAD: CONFIG.CANDLES_TO_LOAD,
        DURATION: CONFIG.DURATION,
        DURATION_UNIT: CONFIG.DURATION_UNIT
    };
}

const LOGGER = {
    info: msg => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: msg => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: msg => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
    error: msg => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: msg => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); }
};

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    assets: {},
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    currentTradeDay: null,

    session: {
        profit: 0, loss: 0, netPL: 0,
        tradesCount: 0, winsCount: 0, lossesCount: 0,
        isActive: true,
        startTime: Date.now(),
        startCapital: CONFIG.INITIAL_CAPITAL,
        estimatedWinRate: 0.55, // Initial estimate, updated dynamically
    },

    isConnected: false,
    isAuthorized: false,

    portfolio: {
        dailyProfit: 0, dailyLoss: 0, dailyWins: 0, dailyLosses: 0
    },

    hourlyStats: {
        trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours()
    },

    requestId: 1,
    lastSessionLogTime: 0,

    // Watchdog
    tradeWatchdogTimer: null,
    tradeInProgress: false,
    pendingTradeInfo: null,
    tradeStartTime: null,
    currentContractId: null
};

let tradeHistory = null;

// ══════════════════════════════════════════════════════════════════════════════
// PROFESSIONAL VOLATILITY BREAKOUT ANALYZER
// ══════════════════════════════════════════════════════════════════════════════

class VolatilityBreakoutAnalyzer {

    /**
     * Calculate Average True Range (ATR)
     */
    static calculateATR(candles, period = 14) {
        if (candles.length < period + 1) return 0;

        const trueRanges = [];

        for (let i = 1; i < candles.length; i++) {
            const high = candles[i].high;
            const low = candles[i].low;
            const prevClose = candles[i - 1].close;

            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );

            trueRanges.push(tr);
        }

        const recentTR = trueRanges.slice(-period);
        return recentTR.reduce((a, b) => a + b, 0) / recentTR.length;
    }

    /**
     * Detect volatility compression (squeeze)
     */
    static detectVolatilitySqueeze(candles) {
        if (candles.length < CONFIG.VOLATILITY.VOLATILITY_WINDOW) {
            return { isSqueezing: false, ratio: 0, currentATR: 0, historicalATR: 0 };
        }

        // const currentATR = this.calculateATR(
        //     candles.slice(-CONFIG.VOLATILITY.ATR_PERIOD - 1),
        //     CONFIG.VOLATILITY.ATR_PERIOD
        // );

        // const historicalATR = this.calculateATR(
        //     candles.slice(-CONFIG.VOLATILITY.VOLATILITY_WINDOW),
        //     CONFIG.VOLATILITY.ATR_PERIOD
        // );

        const currentATR = this.calculateATR(
            candles.slice(-(CONFIG.VOLATILITY.ATR_PERIOD + 1)),
            CONFIG.VOLATILITY.ATR_PERIOD          // ATR of recent 14 candles
        );

        // Use a distinct longer period for the baseline
        const HISTORICAL_PERIOD = 30; // compare recent 14-period ATR vs longer 30-period ATR
        const historicalATR = this.calculateATR(
            candles.slice(-(HISTORICAL_PERIOD + 1)),
            HISTORICAL_PERIOD
        );

        if (historicalATR === 0) return { isSqueezing: false, ratio: 0, currentATR, historicalATR };

        const ratio = currentATR / historicalATR;
        const isSqueezing = ratio < CONFIG.VOLATILITY.LOW_VOLATILITY_RATIO;

        return {
            isSqueezing,
            ratio,
            currentATR,
            historicalATR,
            compressionLevel: (1 - ratio) * 100 // % compression
        };
    }

    /**
     * Detect price breakout from range
     */
    static detectBreakout(candles) {
        if (candles.length < CONFIG.BREAKOUT.LOOKBACK_PERIOD + CONFIG.BREAKOUT.CONFIRMATION_TICKS) {
            return { hasBreakout: false };
        }

        const lookbackCandles = candles.slice(
            -(CONFIG.BREAKOUT.LOOKBACK_PERIOD + CONFIG.BREAKOUT.CONFIRMATION_TICKS),
            -CONFIG.BREAKOUT.CONFIRMATION_TICKS
        );

        const high = Math.max(...lookbackCandles.map(c => c.high));
        const low = Math.min(...lookbackCandles.map(c => c.low));
        const range = high - low;

        if (range === 0) return { hasBreakout: false };

        const confirmationCandles = candles.slice(-CONFIG.BREAKOUT.CONFIRMATION_TICKS);
        const currentPrice = candles[candles.length - 1].close;

        // Check upward breakout
        if (currentPrice > high) {
            const strength = (currentPrice - high) / range;
            const confirmed = confirmationCandles.every(c => c.close > high);

            if (strength >= CONFIG.BREAKOUT.MIN_STRENGTH && confirmed) {
                return {
                    hasBreakout: true,
                    direction: 'CALLE',
                    strength,
                    isStrong: strength >= CONFIG.BREAKOUT.STRONG_STRENGTH,
                    breakoutPrice: high,
                    currentPrice
                };
            }
        }

        // Check downward breakout
        if (currentPrice < low) {
            const strength = (low - currentPrice) / range;
            const confirmed = confirmationCandles.every(c => c.close < low);

            if (strength >= CONFIG.BREAKOUT.MIN_STRENGTH && confirmed) {
                return {
                    hasBreakout: true,
                    direction: 'PUTE',
                    strength,
                    isStrong: strength >= CONFIG.BREAKOUT.STRONG_STRENGTH,
                    breakoutPrice: low,
                    currentPrice
                };
            }
        }

        return { hasBreakout: false };
    }

    /**
     * Calculate Exponential Moving Average
     */
    static calculateEMA(prices, period) {
        if (prices.length < period) return null;

        const k = 2 / (period + 1);
        let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

        for (let i = period; i < prices.length; i++) {
            ema = prices[i] * k + ema * (1 - k);
        }

        return ema;
    }

    /**
     * Check trend alignment using EMA
     */
    static checkTrendAlignment(candles) {
        if (!CONFIG.TREND.USE_EMA_FILTER) {
            return { aligned: true, trend: 'NEUTRAL' };
        }

        if (candles.length < CONFIG.TREND.EMA_SLOW) {
            return { aligned: false, trend: 'INSUFFICIENT_DATA' };
        }

        const closes = candles.map(c => c.close);
        const emaFast = this.calculateEMA(closes, CONFIG.TREND.EMA_FAST);
        const emaSlow = this.calculateEMA(closes, CONFIG.TREND.EMA_SLOW);

        if (!emaFast || !emaSlow) {
            return { aligned: false, trend: 'INSUFFICIENT_DATA' };
        }

        const diff = emaFast - emaSlow;
        const currentPrice = closes[closes.length - 1];
        const separation = Math.abs(diff) / currentPrice;

        let trend = 'NEUTRAL';
        let aligned = true;

        if (separation >= CONFIG.TREND.MIN_TREND_STRENGTH) {
            trend = diff > 0 ? 'UPTREND' : 'DOWNTREND';
        }

        return {
            aligned,
            trend,
            emaFast,
            emaSlow,
            separation: separation * 100
        };
    }

    /**
     * Calculate RSI
     */
    static calculateRSI(candles, period = 14) {
        if (candles.length < period + 1) return 50;

        const changes = [];
        for (let i = 1; i < candles.length; i++) {
            changes.push(candles[i].close - candles[i - 1].close);
        }

        const recentChanges = changes.slice(-period);
        const gains = recentChanges.filter(c => c > 0);
        const losses = recentChanges.filter(c => c < 0).map(Math.abs);

        const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
        const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;

        if (avgLoss === 0) return 100;

        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    /**
     * Main analysis function - combines all indicators
     */
    static analyze(candles) {
        if (!candles || candles.length < CONFIG.VOLATILITY.VOLATILITY_WINDOW) {
            return {
                shouldTrade: false,
                reason: 'insufficient_data',
                confidence: 0
            };
        }

        // Step 1: Check for volatility squeeze
        const squeeze = this.detectVolatilitySqueeze(candles);

        if (!squeeze.isSqueezing) {
            return {
                shouldTrade: false,
                reason: 'no_volatility_compression',
                volatility: squeeze,
                confidence: 0
            };
        }

        // Step 2: Detect breakout
        const breakout = this.detectBreakout(candles);

        if (!breakout.hasBreakout) {
            return {
                shouldTrade: false,
                reason: 'no_breakout_detected',
                volatility: squeeze,
                confidence: 0
            };
        }

        // Step 3: Check trend alignment
        const trend = this.checkTrendAlignment(candles);

        // Step 4: RSI filter (optional)
        let rsi = 50;
        let rsiSignal = true;

        if (CONFIG.RSI.ENABLED) {
            rsi = this.calculateRSI(candles, CONFIG.RSI.PERIOD);

            // For CALLE: prefer RSI not overbought
            // For PUTE: prefer RSI not oversold
            if (breakout.direction === 'CALLE') {
                rsiSignal = rsi < CONFIG.RSI.OVERBOUGHT;
            } else {
                rsiSignal = rsi > CONFIG.RSI.OVERSOLD;
            }

            if (!rsiSignal) {
                return {
                    shouldTrade: false,
                    reason: 'rsi_filter_reject',
                    rsi,
                    volatility: squeeze,
                    breakout,
                    confidence: 0
                };
            }
        }

        // Calculate confidence score
        let confidence = 0.5; // Base

        // Volatility compression adds confidence
        confidence += (squeeze.compressionLevel / 100) * 0.15;

        // Strong breakout adds confidence
        if (breakout.isStrong) confidence += 0.15;
        else confidence += breakout.strength * 0.10;

        // Trend alignment adds confidence
        if (trend.aligned && trend.trend !== 'NEUTRAL') {
            const trendMatch =
                (trend.trend === 'UPTREND' && breakout.direction === 'CALLE') ||
                (trend.trend === 'DOWNTREND' && breakout.direction === 'PUTE');

            if (trendMatch) confidence += 0.20;
        }

        // RSI confirmation
        if (CONFIG.RSI.ENABLED) {
            if (breakout.direction === 'CALLE' && rsi < 50) confidence += 0.10;
            if (breakout.direction === 'PUTE' && rsi > 50) confidence += 0.10;
        }

        // Cap confidence
        confidence = Math.min(confidence, 0.95);

        // Minimum confidence threshold
        if (confidence < 0.65) {
            return {
                shouldTrade: false,
                reason: 'low_confidence',
                confidence,
                volatility: squeeze,
                breakout,
                trend,
                rsi
            };
        }

        return {
            shouldTrade: true,
            direction: breakout.direction === 'CALLE' ? 'CALLE' : 'PUTE',
            confidence,
            reason: 'volatility_breakout_confirmed',
            signal: `${breakout.isStrong ? 'STRONG' : 'NORMAL'} ${breakout.direction} breakout from squeeze`,
            volatility: squeeze,
            breakout,
            trend,
            rsi
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// KELLY CRITERION POSITION SIZER
// ══════════════════════════════════════════════════════════════════════════════

class KellyPositionSizer {

    /**
     * Calculate optimal stake using Kelly Criterion
     * f* = (bp - q) / b
     * where:
     *   b = odds (payout - 1)
     *   p = win probability
     *   q = loss probability (1 - p)
     */
    static calculateStake(balance, winRate, confidence, payout = 1.95) {
        if (!CONFIG.POSITION_SIZING.USE_KELLY) {
            return Math.max(CONFIG.POSITION_SIZING.MIN_STAKE, CONFIG.STAKE);
        }

        const b = payout - 1; // Odds (e.g., 1.95 - 1 = 0.95)
        const p = winRate * confidence; // Adjusted win probability
        const q = 1 - p; // Loss probability

        // Kelly fraction
        const kellyFraction = (b * p - q) / b;

        // Safety check
        if (kellyFraction <= 0) {
            return CONFIG.POSITION_SIZING.MIN_STAKE;
        }

        // Apply fractional Kelly for safety
        const conservativeKelly = kellyFraction * CONFIG.POSITION_SIZING.KELLY_FRACTION;

        // Calculate stake
        let stake = balance * conservativeKelly;

        // Apply caps
        const maxStake = balance * (CONFIG.POSITION_SIZING.MAX_POSITION_PCT / 100);
        stake = Math.min(stake, maxStake, CONFIG.POSITION_SIZING.MAX_STAKE);
        stake = Math.max(stake, CONFIG.POSITION_SIZING.MIN_STAKE);

        return parseFloat(stake.toFixed(2));
    }

    /**
     * Adjust stake after losses
     */
    static adjustForLosses(baseStake, consecutiveLosses) {
        if (!CONFIG.RISK.REDUCE_SIZE_AFTER_LOSS) {
            return baseStake;
        }

        if (consecutiveLosses === 0) {
            return baseStake;
        }

        // Reduce stake by factor for each consecutive loss
        const reduction = Math.pow(CONFIG.RISK.LOSS_REDUCTION_FACTOR, consecutiveLosses);
        let adjustedStake = baseStake * reduction;

        // Floor at minimum
        adjustedStake = Math.max(adjustedStake, CONFIG.POSITION_SIZING.MIN_STAKE);

        return parseFloat(adjustedStake.toFixed(2));
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
            LOGGER.trade(`🎯 PROFIT TARGET REACHED! Net P/L: $${netPL.toFixed(2)}`);
            this.endSession('PROFIT_TARGET');
            return true;
        }

        if (netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.error(`🛑 STOP LOSS REACHED! Net P/L: $${netPL.toFixed(2)}`);
            this.endSession('STOP_LOSS');
            return true;
        }

        // Check daily loss limit
        const today = TradeHistoryManager.getTodayStats();
        if (today.netPL <= CONFIG.RISK.DAILY_LOSS_LIMIT) {
            LOGGER.error(`🛑 DAILY LOSS LIMIT REACHED! Today P/L: $${today.netPL.toFixed(2)}`);
            this.endSession('DAILY_LOSS_LIMIT');
            return true;
        }

        return false;
    }

    static async endSession(reason) {
        state.session.isActive = false;
        LOGGER.info(`🛑 Session ended (${reason}).`);
        TelegramService.sendSessionSummary();
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
            netPL: state.session.netPL
        };
    }

    static checkDayChange() {
        const currentDay = TradeHistoryManager.getDateKey();

        if (state.currentTradeDay && state.currentTradeDay !== currentDay) {
            LOGGER.info(`🗓️ Day changed from ${state.currentTradeDay} to ${currentDay}`);
            TelegramService.sendDayEndSummary(state.currentTradeDay);
            this.resetSessionForNewDay();
        }

        state.currentTradeDay = currentDay;
    }

    static resetSessionForNewDay() {
        LOGGER.info('🗓️ Resetting session for new day...');

        state.session.tradesCount = 0;
        state.session.winsCount = 0;
        state.session.lossesCount = 0;
        state.session.profit = 0;
        state.session.loss = 0;
        state.session.netPL = 0;
        state.session.startTime = Date.now();
        state.session.startCapital = state.capital;
        state.lastSessionLogTime = 0;

        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset) {
                asset.tradesCount = 0;
                asset.winsCount = 0;
                asset.lossesCount = 0;
                asset.profit = 0;
                asset.loss = 0;
                asset.netPL = 0;
            }
        });

        state.portfolio.dailyProfit = 0;
        state.portfolio.dailyLoss = 0;
        state.portfolio.dailyWins = 0;
        state.portfolio.dailyLosses = 0;

        state.hourlyStats = {
            trades: 0, wins: 0, losses: 0, pnl: 0,
            lastHour: new Date().getHours()
        };

        TradeHistoryManager.ensureDayEntry(TradeHistoryManager.getDateKey());
        tradeHistory.dailyHistory[TradeHistoryManager.getDateKey()].startCapital = state.capital;
        TradeHistoryManager.saveHistory();

        state.tradeInProgress = false;
        state.currentContractId = null;
        state.tradeStartTime = null;
        state.pendingTradeInfo = null;

        LOGGER.info('🗓️ Daily stats reset');
    }

    static recordTradeResult(symbol, profit, direction) {
        const assetState = state.assets[symbol];
        if (!assetState) {
            LOGGER.error(`recordTradeResult: Unknown symbol ${symbol}`);
            return;
        }

        this.checkDayChange();

        const currentHour = new Date().getHours();
        if (currentHour !== state.hourlyStats.lastHour) {
            state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: currentHour };
        }

        state.session.tradesCount++;
        state.capital += profit;
        state.hourlyStats.trades++;
        state.hourlyStats.pnl += profit;
        assetState.tradesCount++;
        assetState.lastLossTime = Date.now();

        if (profit > 0) {
            // WIN
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            state.hourlyStats.wins++;

            assetState.winsCount++;
            assetState.profit += profit;
            assetState.netPL += profit;
            assetState.consecutiveLosses = 0;

            // Update win rate estimate
            state.session.estimatedWinRate = state.session.winsCount / state.session.tradesCount;

            TradeHistoryManager.recordTrade(symbol, profit);

            LOGGER.trade(
                `✅ [${symbol}] WIN: +$${profit.toFixed(2)} | Direction: ${direction} | ` +
                `P/L: $${assetState.netPL.toFixed(2)} | Win Rate: ${(state.session.estimatedWinRate * 100).toFixed(1)}%`
            );

        } else {
            // LOSS
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            state.hourlyStats.losses++;

            assetState.lossesCount++;
            assetState.loss += Math.abs(profit);
            assetState.netPL += profit;
            assetState.consecutiveLosses++;

            // Update win rate estimate
            state.session.estimatedWinRate = state.session.winsCount / state.session.tradesCount;

            TradeHistoryManager.recordTrade(symbol, profit);

            LOGGER.trade(
                `❌ [${symbol}] LOSS: -$${Math.abs(profit).toFixed(2)} | Direction: ${direction} | ` +
                `Consecutive Losses: ${assetState.consecutiveLosses} | P/L: $${assetState.netPL.toFixed(2)}`
            );

            // Check consecutive loss limit
            // if (assetState.consecutiveLosses >= CONFIG.RISK.MAX_CONSECUTIVE_LOSSES) {
            //     LOGGER.warn(`⚠️ [${symbol}] Max consecutive losses reached, pausing asset`);
            //     assetState.canTrade = false;

            //     TelegramService.sendMessage(
            //         `⚠️ <b>Asset Paused</b>\n` +
            //         `${symbol} reached ${CONFIG.RISK.MAX_CONSECUTIVE_LOSSES} consecutive losses.\n` +
            //         `Trading paused for this asset.`
            //     );
            // }

            const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
            if (assetState.consecutiveLosses >= CONFIG.RISK.MAX_CONSECUTIVE_LOSSES) {
                const lastLossTime = assetState.lastLossTime || 0;
                if (Date.now() - lastLossTime < COOLDOWN_MS) {
                    LOGGER.debug(`${symbol} in cooldown (${Math.round((COOLDOWN_MS - (Date.now() - lastLossTime)) / 60000)}m left)`);
                    return;
                }
                // Cooldown expired — reset and allow trading again
                LOGGER.info(`[${symbol}] Cooldown expired, resuming trading`);
                assetState.consecutiveLosses = 0;
                assetState.canTrade = true;
            }
        }
        this.checkDayChange();
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
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            LOGGER.info('Already connected');
            return;
        }

        LOGGER.info('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);
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
        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            if (!state.assets[symbol]) {
                state.assets[symbol] = {
                    candles: [],
                    closedCandles: [],
                    currentFormingCandle: null,
                    lastProcessedCandleOpenTime: null,
                    candlesLoaded: false,
                    currentStake: CONFIG.STAKE,
                    canTrade: false,
                    activePositions: [],
                    tradesCount: 0,
                    winsCount: 0,
                    lossesCount: 0,
                    profit: 0,
                    loss: 0,
                    netPL: 0,
                    consecutiveLosses: 0,
                    lastLossTime: 0,
                };

                const ac = getAssetConfig(symbol);
                LOGGER.info(`📊 Initialized: ${symbol} (${ac.TIMEFRAME_LABEL})`);
            }
        });
    }

    cleanup() {
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { LOGGER.debug('WebSocket already closed'); }
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

            LOGGER.info('🔑 Authorized successfully');
            LOGGER.info(`  Account: ${response.authorize.loginid}`);
            LOGGER.info(`  Balance: ${response.authorize.balance} ${response.authorize.currency}`);

            state.isAuthorized = true;
            state.accountBalance = response.authorize.balance;

            // if (state.capital === CONFIG.INITIAL_CAPITAL) {
            //     state.capital = response.authorize.balance;
            // }

            state.capital = response.authorize.balance;
            state.accountBalance = response.authorize.balance;

            // Only set session startCapital on first connect
            if (!stateLoaded || state.session.startCapital === CONFIG.INITIAL_CAPITAL) {
                state.session.startCapital = response.authorize.balance;
            }

            this.send({ balance: 1, subscribe: 1 });
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
            const reqId = response.echo_req?.req_id;

            if (reqId) {
                CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                    const asset = state.assets[symbol];
                    if (asset && asset.activePositions) {
                        const posIndex = asset.activePositions.findIndex(p => p.reqId === reqId);
                        if (posIndex >= 0) {
                            asset.activePositions.splice(posIndex, 1);
                            LOGGER.info(`  Removed failed position from ${symbol}`);
                        }
                    }
                });
            }
            return;
        }

        const contract = response.buy;
        LOGGER.trade(`✅ Position opened: Contract ${contract.contract_id}, Buy Price: $${contract.buy_price}`);

        const reqId = response.echo_req.req_id;
        let foundSymbol = null;
        let position = null;

        for (const symbol of CONFIG.ACTIVE_ASSETS) {
            const asset = state.assets[symbol];
            if (asset && asset.activePositions) {
                position = asset.activePositions.find(p => p.reqId === reqId);
                if (position) {
                    foundSymbol = symbol;
                    break;
                }
            }
        }

        if (position && foundSymbol) {
            position.contractId = contract.contract_id;
            position.buyPrice = contract.buy_price;

            state.tradeInProgress = true;
            state.currentContractId = contract.contract_id;
            state.tradeStartTime = Date.now();
            state.pendingTradeInfo = {
                stake: position.stake,
                direction: position.direction,
                symbol: position.symbol
            };

            bot._startTradeWatchdog(contract.contract_id);

            TelegramService.sendTradeAlert(
                'OPEN',
                position.symbol,
                position.direction,
                position.stake,
                position.duration,
                position.durationUnit,
                position.analysisDetails || {}
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

        if (bot._processedContracts.has(String(contractId))) {
            LOGGER.debug(`⚠️ Contract ${contractId} already processed`);
            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }
            return;
        }

        let ownerSymbol = null;
        let posIndex = -1;

        for (const symbol of CONFIG.ACTIVE_ASSETS) {
            const asset = state.assets[symbol];
            if (asset && asset.activePositions) {
                const idx = asset.activePositions.findIndex(p => p.contractId === contractId);
                if (idx >= 0) {
                    ownerSymbol = symbol;
                    posIndex = idx;
                    break;
                }
            }
        }

        if (posIndex < 0 || !ownerSymbol) return;

        const assetState = state.assets[ownerSymbol];
        const position = assetState.activePositions[posIndex];
        position.currentProfit = contract.profit;

        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
            bot._clearAllWatchdogTimers();
            bot._processedContracts.add(String(contractId));

            const profit = contract.profit;
            LOGGER.trade(
                `[${ownerSymbol}] Contract ${contractId} closed: ` +
                `${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`
            );

            SessionManager.recordTradeResult(ownerSymbol, profit, position.direction);

            TelegramService.sendTradeAlert(
                profit >= 0 ? 'WIN' : 'LOSS',
                ownerSymbol,
                position.direction,
                position.stake,
                position.duration,
                position.durationUnit,
                { profit }
            );

            assetState.activePositions.splice(posIndex, 1);

            state.tradeInProgress = false;
            state.currentContractId = null;
            state.tradeStartTime = null;
            state.pendingTradeInfo = null;

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
        const assetConfig = getAssetConfig(symbol);
        const granularity = assetConfig.GRANULARITY;
        const calculatedOpenTime = ohlc.open_time || Math.floor(ohlc.epoch / granularity) * granularity;

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
            closedCandle.epoch = closedCandle.open_time + granularity;

            if (closedCandle.open_time !== assetState.lastProcessedCandleOpenTime) {
                assetState.closedCandles.push(closedCandle);

                if (assetState.closedCandles.length > assetConfig.MAX_CANDLES_STORED) {
                    assetState.closedCandles = assetState.closedCandles.slice(-assetConfig.MAX_CANDLES_STORED);
                }

                assetState.lastProcessedCandleOpenTime = closedCandle.open_time;

                const closeTime = new Date(closedCandle.epoch * 1000).toISOString();
                const candleType = closedCandle.close > closedCandle.open ? 'BULLISH' : 'BEARISH';
                const candleEmoji = candleType === 'BULLISH' ? '🟢' : '🔴';

                LOGGER.info(
                    `${symbol} ${candleEmoji} CANDLE CLOSED [${closeTime}] ${candleType}: ` +
                    `O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} ` +
                    `L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)}`
                );

                assetState.canTrade = true;
                bot.executeNextTrade(symbol, closedCandle);
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

        if (candles.length > assetConfig.MAX_CANDLES_STORED) {
            assetState.candles = candles.slice(-assetConfig.MAX_CANDLES_STORED);
        }
    }

    handleCandlesHistory(response) {
        if (response.error) {
            LOGGER.error(`Error fetching candles: ${response.error.message}`);
            return;
        }

        const symbol = response.echo_req.ticks_history;
        if (!state.assets[symbol]) return;

        const assetConfig = getAssetConfig(symbol);
        const granularity = assetConfig.GRANULARITY;

        const candles = response.candles.map(c => {
            const openTime = Math.floor((c.epoch - granularity) / granularity) * granularity;
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
        state.assets[symbol].lastProcessedCandleOpenTime = candles[candles.length - 1].open_time;
        state.assets[symbol].currentFormingCandle = candles[candles.length - 1];

        LOGGER.info(
            `📊 Loaded ${candles.length} ${assetConfig.TIMEFRAME_LABEL} candles for ${symbol}`
        );
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
            LOGGER.info('Already handling disconnect');
            return;
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.isReconnecting = true;
            this.reconnectAttempts++;
            const delay = Math.min(
                this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1),
                30000
            );

            LOGGER.info(
                `🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... ` +
                `(attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
            );

            TelegramService.sendMessage(
                `⚠️ <b>CONNECTION LOST - RECONNECTING</b>\n` +
                `Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
                `Retrying in ${(delay / 1000).toFixed(1)}s\n` +
                `P/L: $${state.session.netPL.toFixed(2)}`
            );

            setTimeout(() => {
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached');
            TelegramService.sendMessage(
                `🛑 <b>BOT STOPPED</b>\n` +
                `Max reconnection attempts reached.\n` +
                `Final P/L: $${state.session.netPL.toFixed(2)}`
            );
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
        this._processedContracts = new Set();
        this.tradeWatchdogMs = 75000;
    }

    async start() {
        console.log('\n' + '═'.repeat(80));
        console.log(' DERIV VOLATILITY BREAKOUT BOT - PROFESSIONAL STRATEGY');
        console.log('═'.repeat(80));
        console.log(`  Capital         : $${state.capital}`);
        console.log(`  Assets          : ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        console.log(`  Base Stake      : $${CONFIG.STAKE}`);
        console.log(`  Position Sizing : Kelly Criterion (${CONFIG.POSITION_SIZING.KELLY_FRACTION * 100}% Kelly)`);
        console.log(`  Strategy        : Volatility Compression + Momentum Breakout`);
        console.log(`  Risk Management : NO MARTINGALE - Adaptive Position Sizing`);
        console.log('═'.repeat(80) + '\n');

        state.currentTradeDay = TradeHistoryManager.getDateKey();
        TradeHistoryManager.ensureDayEntry(state.currentTradeDay);

        if (!tradeHistory.dailyHistory[state.currentTradeDay].startCapital) {
            tradeHistory.dailyHistory[state.currentTradeDay].startCapital = state.capital;
        }

        this.connection.initializeAssets();

        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            this.subscribeToCandles(symbol);
        });

        TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();
        TelegramService.startDailyTimer();

        LOGGER.info('✅ Volatility Breakout Bot started!');
    }

    subscribeToCandles(symbol) {
        const assetConfig = getAssetConfig(symbol);
        LOGGER.info(
            `📊 Subscribing to ${assetConfig.TIMEFRAME_LABEL} candles for ${symbol} ` +
            `(granularity: ${assetConfig.GRANULARITY}s)...`
        );

        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: assetConfig.CANDLES_TO_LOAD,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: assetConfig.GRANULARITY
        });

        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: 1,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: assetConfig.GRANULARITY,
            subscribe: 1
        });
    }

    executeNextTrade(symbol, lastClosedCandle) {
        const assetState = state.assets[symbol];
        if (!assetState) return;
        if (!assetState.canTrade) return;
        if (!SessionManager.isSessionActive()) return;

        // LOCK IMMEDIATELY before any other check
        assetState.canTrade = false;

        const assetConfig = getAssetConfig(symbol);

        if (assetState.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) {
            LOGGER.debug(
                `${symbol} Max positions reached ` +
                `(${assetState.activePositions.length}/${CONFIG.MAX_OPEN_POSITIONS_PER_ASSET})`
            );
            return;
        }

        // Check if asset is paused due to consecutive losses
        if (assetState.consecutiveLosses >= CONFIG.RISK.MAX_CONSECUTIVE_LOSSES) {
            LOGGER.debug(`${symbol} paused due to consecutive losses`);
            return;
        }

        // ══════════════════════════════════════════════════════════
        // VOLATILITY BREAKOUT ANALYSIS
        // ══════════════════════════════════════════════════════════

        const analysis = VolatilityBreakoutAnalyzer.analyze(assetState.closedCandles);

        if (!analysis.shouldTrade) {
            LOGGER.debug(
                `[${symbol}] No trade: ${analysis.reason} | ` +
                `Confidence: ${(analysis.confidence * 100).toFixed(1)}%`
            );
            return;
        }

        const direction = analysis.direction;
        const confidence = analysis.confidence;

        // ══════════════════════════════════════════════════════════
        // POSITION SIZING (KELLY CRITERION)
        // ══════════════════════════════════════════════════════════

        const overall = TradeHistoryManager.getOverallStats();
        const historicalWinRate = overall.tradesCount > 20
            ? overall.winsCount / overall.tradesCount
            : state.session.estimatedWinRate; // fall back to 0.55 if too few trades

        let stake = KellyPositionSizer.calculateStake(
            state.capital,
            historicalWinRate,
            confidence
        );

        // let stake = KellyPositionSizer.calculateStake(
        //     state.capital,
        //     state.session.estimatedWinRate,
        //     confidence
        // );

        // Adjust for consecutive losses
        stake = KellyPositionSizer.adjustForLosses(stake, assetState.consecutiveLosses);

        assetState.currentStake = stake;

        if (state.capital < stake) {
            LOGGER.error(
                `[${symbol}] Insufficient capital: $${state.capital.toFixed(2)} ` +
                `(need $${stake.toFixed(2)})`
            );
            return;
        }

        if (!state.isConnected || !state.isAuthorized) {
            LOGGER.warn(`[${symbol}] Not connected/authorized`);
            return;
        }

        LOGGER.trade(`\n${'═'.repeat(70)}`);
        LOGGER.trade(`  🎯 VOLATILITY BREAKOUT TRADE - ${symbol}`);
        LOGGER.trade(`${'═'.repeat(70)}`);
        LOGGER.trade(`  Direction       : ${direction === 'CALLE' ? 'RISE ↑' : 'FALL ↓'}`);
        LOGGER.trade(`  Signal          : ${analysis.signal}`);
        LOGGER.trade(`  Confidence      : ${(confidence * 100).toFixed(1)}%`);
        LOGGER.trade(`  Stake           : $${stake.toFixed(2)} (Kelly-adjusted)`);
        LOGGER.trade(`  ─────────────────────────────────────────────────────────`);
        LOGGER.trade(`  Volatility      : ${analysis.volatility.isSqueezing ? '✓' : '✗'} SQUEEZED (${analysis.volatility.compressionLevel.toFixed(1)}% compression)`);
        LOGGER.trade(`  Current ATR     : ${analysis.volatility.currentATR.toFixed(5)}`);
        LOGGER.trade(`  Historical ATR  : ${analysis.volatility.historicalATR.toFixed(5)}`);
        LOGGER.trade(`  Breakout        : ${analysis.breakout.isStrong ? 'STRONG' : 'NORMAL'} (${(analysis.breakout.strength * 100).toFixed(1)}%)`);
        LOGGER.trade(`  Trend           : ${analysis.trend.trend}`);
        if (CONFIG.RSI.ENABLED) {
            LOGGER.trade(`  RSI             : ${analysis.rsi.toFixed(1)}`);
        }
        LOGGER.trade(`  Win Rate (est.) : ${(state.session.estimatedWinRate * 100).toFixed(1)}%`);
        LOGGER.trade(`  Consecutive Loss: ${assetState.consecutiveLosses}`);
        LOGGER.trade(`${'═'.repeat(70)}\n`);

        const position = {
            symbol,
            direction,
            stake,
            duration: assetConfig.DURATION,
            durationUnit: assetConfig.DURATION_UNIT,
            entryTime: Date.now(),
            contractId: null,
            reqId: null,
            currentProfit: 0,
            buyPrice: 0,
            analysisDetails: {
                signal: analysis.signal,
                volatility: `${analysis.volatility.compressionLevel.toFixed(1)}% compressed`,
                confidence: `${(confidence * 100).toFixed(1)}%`
            }
        };

        assetState.activePositions.push(position);

        const tradeRequest = {
            buy: 1,
            subscribe: 1,
            price: stake.toFixed(2),
            parameters: {
                contract_type: direction,
                symbol,
                currency: 'USD',
                amount: stake.toFixed(2),
                duration: assetConfig.DURATION,
                duration_unit: assetConfig.DURATION_UNIT,
                basis: 'stake'
            }
        };

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;
    }

    _startTradeWatchdog(contractId) {
        const timeoutMs = this.tradeWatchdogMs;

        state.tradeWatchdogTimer = setTimeout(() => {
            if (!state.tradeInProgress) {
                LOGGER.debug('Watchdog fired but trade already completed');
                return;
            }

            LOGGER.warn(
                `⏰ WATCHDOG FIRED — Contract ${contractId} open for ` +
                `${(timeoutMs / 1000)}s with no settlement`
            );

            if (contractId && state.isConnected && state.isAuthorized) {
                LOGGER.info(`🔍 Polling contract ${contractId}...`);

                this.connection.send({
                    forget_all: 'proposal_open_contract'
                });

                this.connection.send({
                    proposal_open_contract: 1,
                    contract_id: contractId,
                    subscribe: 1
                });

                state.tradeWatchdogPollTimer = setTimeout(() => {
                    if (!state.tradeInProgress) return;

                    LOGGER.error(
                        `🚨 WATCHDOG: Poll timeout — contract ${contractId} ` +
                        `still unresolved — force-releasing lock`
                    );
                    this._recoverStuckTrade('watchdog-force');
                }, 15000);

            } else {
                LOGGER.error('Cannot poll contract - not connected');
                this._recoverStuckTrade('watchdog-offline');
            }
        }, timeoutMs);

        LOGGER.debug(`Watchdog started for ${contractId} (${timeoutMs}ms)`);
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

    _recoverStuckTrade(reason) {
        LOGGER.warn(`🔄 Recovery mode: ${reason}`);

        this._clearAllWatchdogTimers();

        const contractId = state.currentContractId;
        const openSeconds = state.tradeStartTime
            ? Math.round((Date.now() - state.tradeStartTime) / 1000)
            : '?';

        LOGGER.error(
            `🚨 STUCK TRADE RECOVERY [${reason}] | Contract: ${contractId} | ` +
            `Open for: ${openSeconds}s`
        );

        if (contractId) {
            this._processedContracts.add(String(contractId));
        }

        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset && asset.activePositions) {
                const posIndex = asset.activePositions.findIndex(p => p.contractId === contractId);
                if (posIndex >= 0) {
                    asset.activePositions.splice(posIndex, 1);
                    LOGGER.info(`Removed stuck position from ${symbol}`);
                }
            }
        });

        state.tradeInProgress = false;
        state.pendingTradeInfo = null;
        state.currentContractId = null;
        state.tradeStartTime = null;

        LOGGER.warn(`🔄 Lock released. Bot will continue...`);

        TelegramService.sendMessage(
            `⚠️ <b>STUCK TRADE RECOVERED [${reason}]</b>\n` +
            `Contract: ${contractId || 'unknown'}\n` +
            `Open for: ${openSeconds}s\n` +
            `⚠️ Manually verify on Deriv\n` +
            `Session P&L: $${state.session.netPL.toFixed(2)}`
        );

        StatePersistence.saveState();
    }

    stop() {
        LOGGER.info('🛑 Stopping bot...');

        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset) asset.canTrade = false;
        });

        StatePersistence.saveState();
        TradeHistoryManager.saveHistory();

        setTimeout(() => {
            if (this.connection.ws) this.connection.ws.close();
            LOGGER.info('👋 Bot stopped');
        }, 2000);
    }

    getStatus() {
        const sessionStats = SessionManager.getSessionStats();
        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();
        const assetStatuses = {};

        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            const a = state.assets[symbol];
            if (a) {
                assetStatuses[symbol] = {
                    currentStake: a.currentStake,
                    activePositions: a.activePositions.length,
                    trades: a.tradesCount,
                    wins: a.winsCount,
                    losses: a.lossesCount,
                    netPL: a.netPL,
                    consecutiveLosses: a.consecutiveLosses,
                    canTrade: a.canTrade
                };
            }
        });

        let totalActivePositions = 0;
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) totalActivePositions += a.activePositions.length;
        });

        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            accountBalance: state.accountBalance,
            session: sessionStats,
            totalActivePositions,
            assets: assetStatuses,
            overall,
            today
        };
    }
}

// ============================================
// INITIALIZATION
// ============================================
tradeHistory = TradeHistoryManager.loadHistory();

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
    LOGGER.info('🔄 Resuming from saved state');
} else {
    LOGGER.info('🆕 Starting fresh');
}

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('⚠️ API Token not configured!');
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(' DERIV VOLATILITY BREAKOUT BOT - PROFESSIONAL STRATEGY');
console.log(' ✓ Volatility Compression Detection');
console.log(' ✓ Momentum Breakout Confirmation');
console.log(' ✓ Kelly Criterion Position Sizing');
console.log(' ✓ NO MARTINGALE - Adaptive Risk Management');
console.log('═'.repeat(80));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

// Status display every 60 seconds
setInterval(() => {
    if (state.isAuthorized) {
        const status = bot.getStatus();

        let assetLines = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = status.assets[sym];
            if (a) {
                assetLines += `\n  ${sym}: ${a.trades}t ${a.wins}W/${a.losses}L | ` +
                    `P/L:$${a.netPL.toFixed(2)} | Stake:$${a.currentStake.toFixed(2)} | ` +
                    `ConsecLoss:${a.consecutiveLosses} | Pos:${a.activePositions}`;
            }
        });

        console.log(
            `\n📊 ${getGMTTime()} | Today: ${status.session.trades} trades | ` +
            `${status.session.winRate} | $${status.session.netPL.toFixed(2)} | ` +
            `Active: ${status.totalActivePositions}`
        );
        console.log(
            `📋 Overall: ${status.overall.tradesCount} trades | ` +
            `${status.overall.winsCount}W/${status.overall.lossesCount}L | ` +
            `P/L: $${status.overall.netPL.toFixed(2)}`
        );
        console.log(`🔧 Assets:${assetLines}`);
    }
}, 60000);
