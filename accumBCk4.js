'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║         DERIV ACCUMULATOR BOT  —  v1.1 (HOTFIX)                         ║
 * ║  FIX: Buy-response matching, contract lookup by ID, settlement guard    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

const WebSocket = require('ws');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');

// ============================================================
// FILE PATHS
// ============================================================
const STATE_FILE        = path.join(__dirname, 'accumulator_bot4-005_v1_state.json');
const HISTORY_FILE      = path.join(__dirname, 'accumulator_bot4-005_v1_history.json');
const STATE_SAVE_INTERVAL = 5000;

// ============================================================
// LOGGER
// ============================================================
const getGMTTime = () =>
    new Date().toISOString().replace('T', ' ').split('.')[0] + ' GMT';

const LOGGER = {
    info:  (msg) => console.log(`[INFO]  ${getGMTTime()} - ${msg}`),
    trade: (msg) => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn:  (msg) => console.warn(`\x1b[33m[WARN]  ${getGMTTime()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); },
    scan:  (msg) => console.log(`\x1b[34m[SCAN]  ${getGMTTime()} - ${msg}\x1b[0m`),
};

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
    // ── Deriv API ─────────────────────────────────────────────
    API_TOKEN:  '0P94g4WdSrSrzir',   
    APP_ID:     '1089',
    WS_URL:     'wss://ws.derivws.com/websockets/v3',

    // ── Capital & Risk ─────────────────────────────────────────
    INITIAL_CAPITAL:            250,
    MIN_STAKE:                  1,
    MAX_STAKE:                  150,

    // ── Accumulator Contract Settings ────────────────────────
    CONTRACT_TYPE:              'ACCU',
    GROWTH_RATE:                0.01,      // 1% growth rate
    ACCU_TICKS:                 100,       // Default accumulator length

    // Take Profit multiplier for limit_order (fallback)
    TAKE_PROFIT_MULTIPLIER:     0.20,

    // Dynamic take-profit amounts (stake / divisor)
    TP_DIVISOR_NORMAL:          5,         // stake / 4
    TP_DIVISOR_1_LOSS:          5,         // stake / 6
    TP_DIVISOR_2_PLUS_LOSS:     5,         // stake / 7

    // ── Martingale Recovery (from example) ───────────────────
    RECOVERY_ENABLED:           true,
    MULTIPLIER:                 10,         // First loss multiplier
    MULTIPLIER2:                10,         // 2nd+ loss multiplier
    INITIAL_STAKE:              1,
    INITIAL_STAKE_2:            25,        // Base after certain conditions (optional)

    // ── stayedInArray Entry Conditions ───────────────────────
    STAYED_IN_THRESHOLD:        7000,      // Asset active if total < this
    STAYED_IN_MAX_TOTAL:        7000,      // Max total sum for condition1

    // Recent value thresholds (indices 98, 99 of 100-element array)
    STAYED_IN_IDX_99_MAX:       3,
    STAYED_IN_IDX_98_MAX:       260,
    STAYED_IN_IDX_97_MAX:       260,

    // Last-6-values threshold (index 5 of sliced array = last element)
    STAYED_IN_LAST6_NORMAL:      3,
    STAYED_IN_LAST6_RECOVERY:   23,

    // ── Asset Filtering & Scanning ───────────────────────────
    SCAN_TIMER:                 60000,     // Scan pending assets every 60s
    MIN_TIME_BETWEEN_TRADES:    5000,      // Throttle per asset
    ANALYSIS_INTERVAL:            1,         // Request proposal every N ticks

    // ── Session / Risk Guards ─────────────────────────────────
    MAX_CONSECUTIVE_LOSSES:     3,
    COOLDOWN_TICKS:             3,
    SESSION_PROFIT_TARGET:      50000,
    SESSION_STOP_LOSS:          -15000,
    DAILY_STOP_LOSS:            -20000,

    // ── Time-based Disconnect (from example) ─────────────────
    USE_TIME_BASED_DISCONNECT:  true,
    DISCONNECT_HOUR:            22,        // GMT+1 hour to disconnect after win
    RECONNECT_HOUR:             1,         // GMT+1 hour to reconnect

    // ── Position Management ───────────────────────────────────
    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    MAX_TOTAL_POSITIONS:          10,

    // ── Active Assets ───────────────────────────────────────────
    ACTIVE_ASSETS: [
        // 'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'BOOM150N', 'BOOM300N',
        '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V',
        // 'BOOM50', 'BOOM500', 'BOOM600', 'BOOM900', 'BOOM1000',
        // 'CRASH150N', 'CRASH300N',
        // 'CRASH50', 'CRASH500', 'CRASH600', 'CRASH900', 'CRASH1000',
    ],

    // ── Misc ──────────────────────────────────────────────────
    DEBUG_MODE:                 true,
    TELEGRAM_ENABLED:           true,
    TELEGRAM_BOT_TOKEN:         '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    TELEGRAM_CHAT_ID:           '752497117',
};

// ============================================================
// ACCUMULATOR ANALYZER
// ============================================================
class AccumulatorAnalyzer {
    static calculateTotalStayedIn(arr) {
        if (!arr || !Array.isArray(arr)) return 0;
        return arr.reduce((sum, v) => sum + (v || 0), 0);
    }

    static checkTradeCondition(stayedInArray, consecutiveLosses, maxTotal) {
        const total = this.calculateTotalStayedIn(stayedInArray);
        const recentOk = (
            stayedInArray[99] < CONFIG.STAYED_IN_IDX_99_MAX &&
            stayedInArray[98] < CONFIG.STAYED_IN_IDX_98_MAX &&
            stayedInArray[97] < CONFIG.STAYED_IN_IDX_97_MAX 
        );
        const totalOk = total < maxTotal;
        return { passed: recentOk && totalOk, total, recentOk, totalOk };
    }

    static checkTradeCondition2(last6Array, consecutiveLosses) {
        const threshold = consecutiveLosses > 0
            ? CONFIG.STAYED_IN_LAST6_RECOVERY
            : CONFIG.STAYED_IN_LAST6_NORMAL;
        const passed = last6Array[5] < threshold;
        return { passed, threshold, value: last6Array[5] };
    }
}

// ============================================================
// STATE PERSISTENCE
// ============================================================
class StatePersistence {
    static saveState() {
        try {
            const data = {
                savedAt:         Date.now(),
                capital:         state.capital,
                session:         { ...state.session },
                hourlyStats:     { ...state.hourlyStats },
                currentTradeDay: state.currentTradeDay,
                assets:          {},
            };
            Object.keys(state.assets).forEach(symbol => {
                const a = state.assets[symbol];
                data.assets[symbol] = {
                    consecutiveLosses: a.consecutiveLosses,
                    currentStake:      a.currentStake,
                    recoveryStep:      a.recoveryStep,
                    tradesCount:       a.tradesCount,
                    winsCount:         a.winsCount,
                    lossesCount:       a.lossesCount,
                    netPL:             a.netPL,
                    cooldownTicks:     a.cooldownTicks,
                    lastTradeTime:     a.lastTradeTime,
                    activeStatus:      a.activeStatus,
                    stayedInValue:     a.stayedInValue,
                };
            });
            fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
        } catch (e) { LOGGER.error(`Save state error: ${e.message}`); }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) return false;
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMins = (Date.now() - data.savedAt) / 60000;
            if (ageMins > 120) {
                LOGGER.warn(`State is ${ageMins.toFixed(1)}min old — starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }
            LOGGER.info(`📁 Restoring state from ${ageMins.toFixed(1)} minutes ago`);
            state.capital         = data.capital ?? state.capital;
            state.session         = { ...state.session, ...data.session };
            state.hourlyStats     = data.hourlyStats || state.hourlyStats;
            state.currentTradeDay = data.currentTradeDay || TradeHistoryManager.getDateKey();
            if (data.assets) {
                Object.keys(data.assets).forEach(sym => {
                    if (state.assets[sym]) {
                        const saved = data.assets[sym];
                        const a = state.assets[sym];
                        a.consecutiveLosses = saved.consecutiveLosses ?? 0;
                        a.currentStake      = saved.currentStake      ?? CONFIG.INITIAL_STAKE;
                        a.recoveryStep      = saved.recoveryStep      ?? 0;
                        a.tradesCount       = saved.tradesCount       ?? 0;
                        a.winsCount         = saved.winsCount         ?? 0;
                        a.lossesCount       = saved.lossesCount       ?? 0;
                        a.netPL             = saved.netPL             ?? 0;
                        a.cooldownTicks     = saved.cooldownTicks     ?? 0;
                        a.lastTradeTime     = saved.lastTradeTime     ?? 0;
                        a.activeStatus      = saved.activeStatus      ?? 'pending';
                        a.stayedInValue     = saved.stayedInValue     ?? null;
                    }
                });
            }
            LOGGER.info(`✅ State restored | Capital: $${state.capital.toFixed(2)}`);
            return true;
        } catch (e) {
            LOGGER.error(`Load state error: ${e.message}`);
            return false;
        }
    }

    static startAutoSave() {
        setInterval(() => { if (state.isAuthorized) this.saveState(); }, STATE_SAVE_INTERVAL);
        LOGGER.info(`💾 Auto-save every ${STATE_SAVE_INTERVAL / 1000}s`);
    }
}

// ============================================================
// TRADE HISTORY MANAGER
// ============================================================
class TradeHistoryManager {
    static getDateKey() { return new Date().toISOString().split('T')[0]; }

    static loadHistory() {
        try {
            if (!fs.existsSync(HISTORY_FILE)) return this._emptyHistory();
            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            if (!data.dailyHistory)  data.dailyHistory  = {};
            if (!data.overallAssets) data.overallAssets = {};
            if (!data.overall)       data.overall       = this._emptyOverall();
            LOGGER.info(`📁 History loaded — ${Object.keys(data.dailyHistory).length} days on record`);
            return data;
        } catch (e) {
            LOGGER.error(`Failed to load history: ${e.message}`);
            return this._emptyHistory();
        }
    }

    static _emptyOverall() {
        return {
            tradesCount: 0, winsCount: 0, lossesCount: 0,
            profit: 0, loss: 0, netPL: 0,
            firstTradeDate: null, lastTradeDate: null,
        };
    }

    static _emptyHistory() {
        return { overall: this._emptyOverall(), overallAssets: {}, dailyHistory: {}, lastUpdated: Date.now() };
    }

    static saveHistory() {
        try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2)); }
        catch (e) { LOGGER.error(`Failed to save history: ${e.message}`); }
    }

    static ensureDayEntry(dateKey) {
        if (!tradeHistory.dailyHistory[dateKey]) {
            tradeHistory.dailyHistory[dateKey] = {
                date: dateKey, tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0,
                assets: {}, startCapital: state.capital, endCapital: state.capital,
            };
        }
    }

    static ensureAssetDayEntry(dateKey, symbol) {
        this.ensureDayEntry(dateKey);
        if (!tradeHistory.dailyHistory[dateKey].assets[symbol]) {
            tradeHistory.dailyHistory[dateKey].assets[symbol] = {
                tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0,
            };
        }
    }

    static ensureOverallAssetEntry(symbol) {
        if (!tradeHistory.overallAssets[symbol]) {
            tradeHistory.overallAssets[symbol] = {
                tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0,
            };
        }
    }

    static recordTrade(symbol, profit) {
        const dateKey = this.getDateKey();
        this.ensureAssetDayEntry(dateKey, symbol);
        this.ensureOverallAssetEntry(symbol);
        const targets = [
            tradeHistory.dailyHistory[dateKey],
            tradeHistory.dailyHistory[dateKey].assets[symbol],
            tradeHistory.overall,
            tradeHistory.overallAssets[symbol],
        ];
        targets.forEach(t => {
            t.tradesCount++;
            if (profit > 0) { t.winsCount++; t.profit += profit; t.netPL += profit; }
            else            { t.lossesCount++; t.loss += Math.abs(profit); t.netPL += profit; }
        });
        if (!tradeHistory.overall.firstTradeDate) tradeHistory.overall.firstTradeDate = dateKey;
        tradeHistory.overall.lastTradeDate = dateKey;
        tradeHistory.dailyHistory[dateKey].endCapital = state.capital;
        tradeHistory.lastUpdated = Date.now();
        this.saveHistory();
    }

    static getDayStats(dateKey) {
        this.ensureDayEntry(dateKey);
        return tradeHistory.dailyHistory[dateKey];
    }

    static getTodayStats()   { return this.getDayStats(this.getDateKey()); }
    static getOverallStats() { return tradeHistory.overall; }
    static getAllDays()       { return Object.keys(tradeHistory.dailyHistory).sort(); }
}

// ============================================================
// TELEGRAM SERVICE
// ============================================================
class TelegramService {
    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED || !message?.length) return;
        try {
            const url  = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const body = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
            return new Promise((resolve) => {
                const req = https.request(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                }, res => { res.resume(); res.on('end', () => resolve()); });
                req.on('error', e => { LOGGER.error(`Telegram error: ${e.message}`); resolve(); });
                req.write(body);
                req.end();
            });
        } catch (e) { LOGGER.error(`Telegram exception: ${e.message}`); }
    }

    static async sendTradeAlert(type, symbol, stake, profitDetails = {}) {
        const emoji = type === 'OPEN' ? '🚀' : type === 'WIN' ? '✅' : '❌';
        const a = state.assets[symbol];
        const overall = TradeHistoryManager.getOverallStats();
        const today   = TradeHistoryManager.getTodayStats();
        const lines = [
            `${emoji} <b>ACCUMULATOR BOT4 v1 — ${type}</b>`,
            `Asset: <b>${symbol}</b>`,
            `Stake: $${stake.toFixed(2)} | Growth: ${(CONFIG.GROWTH_RATE * 100).toFixed(0)}%`,
            `Consecutive Losses: ${a?.consecutiveLosses ?? 0} | Recovery: ${a?.recoveryStep ?? 0}`,
            `Asset Status: ${a?.activeStatus?.toUpperCase() ?? 'UNKNOWN'}`,
            ``,
        ];
        if (type === 'OPEN' && profitDetails.stayedIn) {
            lines.push(`📊 <b>Entry Analysis:</b>`);
            lines.push(`Total StayedIn: ${profitDetails.stayedIn.total} / ${CONFIG.STAYED_IN_MAX_TOTAL}`);
            lines.push(`Recent Check: ${profitDetails.stayedIn.recentOk ? '✅' : '❌'}`);
            lines.push(`Last-6 Check: ${profitDetails.stayedIn.last6Ok ? '✅' : '❌'} (val: ${profitDetails.stayedIn.last6Val})`);
        }
        if (profitDetails.profit !== undefined) {
            const pl = profitDetails.profit;
            lines.push(`Profit: ${pl >= 0 ? '+' : ''}$${pl.toFixed(3)}`);
            lines.push(``);
            lines.push(`📋 <b>${symbol} Stats:</b> W/L: ${a?.winsCount ?? 0}/${a?.lossesCount ?? 0} | P/L: $${(a?.netPL ?? 0).toFixed(2)}`);
            lines.push(``);
            lines.push(`📋 <b>Today:</b> Trades: ${today.tradesCount} | P/L: $${(today.netPL || 0).toFixed(2)}`);
            lines.push(`📋 <b>Overall:</b> Trades: ${overall.tradesCount} | P/L: $${(overall.netPL || 0).toFixed(2)}`);
            lines.push(`💰 Capital: $${state.capital.toFixed(2)}`);
        }
        await this.sendMessage(lines.join('\n'));
    }

    static async sendHourlySummary() {
        const h = state.hourlyStats;
        if (h.trades === 0) return;
        const wr = h.trades > 0 ? ((h.wins / h.trades) * 100).toFixed(1) : '0.0';
        const today = TradeHistoryManager.getTodayStats();
        let assetInfo = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a?.tradesCount > 0) {
                assetInfo += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L $${a.netPL.toFixed(2)}`;
            }
        });
        await this.sendMessage([
            `⏰ <b>Accumulator Bot4 Hourly</b>`,
            `Last Hour: ${h.trades}t ${h.wins}W/${h.losses}L ${wr}% ${h.pnl >= 0 ? '🟢' : '🔴'} $${h.pnl.toFixed(2)}`,
            `Today: ${today.tradesCount}t P/L: $${(today.netPL || 0).toFixed(2)}`,
            `Capital: $${state.capital.toFixed(2)}`,
            assetInfo ? `\n<b>Per-Asset:</b>${assetInfo}` : '',
        ].join('\n'));
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };
    }
}

// ============================================================
// SESSION MANAGER
// ============================================================
class SessionManager {
    static isSessionActive() { return state.session.isActive; }

    static checkSessionTargets() {
        const { netPL } = state.session;
        if (netPL >= CONFIG.SESSION_PROFIT_TARGET) {
            LOGGER.trade(`🎯 Session profit target reached: $${netPL.toFixed(2)}`);
            this.endSession('PROFIT_TARGET');
            return true;
        }
        if (netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.error(`🛑 Session stop-loss reached: $${netPL.toFixed(2)}`);
            this.endSession('STOP_LOSS');
            return true;
        }
        const today = TradeHistoryManager.getTodayStats();
        if (today.netPL <= CONFIG.DAILY_STOP_LOSS) {
            LOGGER.error(`🛑 Daily stop-loss reached: $${today.netPL.toFixed(2)}`);
            this.endSession('DAILY_STOP_LOSS');
            return true;
        }
        return false;
    }

    static async endSession(reason) {
        state.session.isActive = false;
        LOGGER.info(`🛑 Session ended: ${reason}`);
    }

    static getSessionStats() {
        const dur = Date.now() - state.session.startTime;
        const hrs = Math.floor(dur / 3600000);
        const mins = Math.floor((dur % 3600000) / 60000);
        const wr = state.session.tradesCount > 0
            ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1) + '%'
            : '0%';
        return {
            duration: `${hrs}h ${mins}m`,
            trades: state.session.tradesCount,
            wins: state.session.winsCount,
            losses: state.session.lossesCount,
            winRate: wr,
            netPL: state.session.netPL,
        };
    }

    static checkDayChange() {
        const today = TradeHistoryManager.getDateKey();
        if (state.currentTradeDay && state.currentTradeDay !== today) {
            LOGGER.info(`🗓️ Day changed: ${state.currentTradeDay} → ${today}`);
            state.currentTradeDay = today;
            this._resetDailyStats();
            if (!state.session.isActive) {
                state.session.isActive = true;
                LOGGER.info('🔄 Session re-activated for new day');
            }
        }
    }

    static _resetDailyStats() {
        const s = state.session;
        s.tradesCount = 0; s.winsCount = 0; s.lossesCount = 0;
        s.profit = 0; s.loss = 0; s.netPL = 0;
        s.startTime = Date.now();
        s.startCapital = state.capital;
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) { a.tradesCount = 0; a.winsCount = 0; a.lossesCount = 0; a.profit = 0; a.loss = 0; a.netPL = 0; }
        });
    }

    static recordTradeResult(symbol, profit) {
        const a = state.assets[symbol];
        if (!a) return;
        this.checkDayChange();
        const hour = new Date().getUTCHours();
        if (hour !== state.hourlyStats.lastHour) {
            state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: hour };
        }
        state.session.tradesCount++;
        state.capital += profit;
        state.hourlyStats.trades++;
        state.hourlyStats.pnl += profit;
        a.tradesCount++;
        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            state.hourlyStats.wins++;
            a.winsCount++;
            a.profit += profit;
            a.netPL += profit;
            a.consecutiveLosses = 0;
            a.cooldownTicks = 0;
            a.currentStake = CONFIG.INITIAL_STAKE;
            LOGGER.trade(`✅ [${symbol}] WIN +$${profit.toFixed(3)} | P/L: $${a.netPL.toFixed(2)}`);
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.hourlyStats.losses++;
            a.lossesCount++;
            a.loss += Math.abs(profit);
            a.netPL += profit;
            a.consecutiveLosses++;
            if (a.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
                a.cooldownTicks = CONFIG.COOLDOWN_TICKS;
                LOGGER.warn(`❄️ [${symbol}] ${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses — cooling down for ${CONFIG.COOLDOWN_TICKS} ticks`);
            }
            if (a.consecutiveLosses >= 2) {
                a.currentStake = Math.ceil(a.currentStake * CONFIG.MULTIPLIER2 * 100) / 100;
            } else {
                a.currentStake = Math.ceil(a.currentStake * CONFIG.MULTIPLIER * 100) / 100;
            }
            a.currentStake = Math.min(a.currentStake, CONFIG.MAX_STAKE);
            LOGGER.trade(`❌ [${symbol}] LOSS -$${Math.abs(profit).toFixed(3)} | Recovery Stake: $${a.currentStake.toFixed(2)}`);
        }
        TradeHistoryManager.recordTrade(symbol, profit);
    }
}

// ============================================================
// STATE
// ============================================================
const state = {
    assets:         {},
    capital:        CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    currentTradeDay: null,
    session: {
        profit: 0, loss: 0, netPL: 0,
        tradesCount: 0, winsCount: 0, lossesCount: 0,
        isActive: true, startTime: Date.now(), startCapital: CONFIG.INITIAL_CAPITAL,
        endedByTime: false,
    },
    isConnected:  false,
    isAuthorized: false,
    hourlyStats:  { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() },
    requestId:    1,
};

let tradeHistory = null;

// ============================================================
// CONNECTION MANAGER
// ============================================================
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
        this._subscriptionIds = new Map();
    }

    connect() {
        if (this.ws?.readyState === WebSocket.OPEN) { LOGGER.info('Already connected'); return; }
        LOGGER.info('🔌 Connecting to Deriv API...');
        this.cleanup();
        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);
        this.ws.on('open',    ()    => this.onOpen());
        this.ws.on('message', data => this.onMessage(data));
        this.ws.on('error',   err  => this.onError(err));
        this.ws.on('close',   ()   => this.onClose());
    }

    onOpen() {
        LOGGER.info('✅ Connected to Deriv API');
        state.isConnected = true;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.startPing();
        if (!this.autoSaveStarted) { StatePersistence.startAutoSave(); this.autoSaveStarted = true; }
        this.send({ authorize: CONFIG.API_TOKEN });
    }

    initializeAssets() {
        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            if (!state.assets[symbol]) {
                state.assets[symbol] = {
                    tickCount: 0,
                    lastTradeTime: 0,
                    consecutiveLosses: 0,
                    currentStake: CONFIG.INITIAL_STAKE,
                    recoveryStep: 0,
                    activePositions: [],
                    tradesCount: 0, winsCount: 0, lossesCount: 0,
                    profit: 0, loss: 0, netPL: 0,
                    cooldownTicks: 0,
                    activeStatus: 'pending',
                    stayedInValue: null,
                };
                LOGGER.info(`📊 Initialized asset: ${symbol}`);
            }
            this.send({ ticks: symbol, subscribe: 1 });
            this.activeSubscriptions.add(symbol);
        });
    }

    cleanup() {
        this.stopPing();
        if (this.ws) {
            this.ws.removeAllListeners();
            try { if (this.ws.readyState <= 1) this.ws.close(); } catch {}
            this.ws = null;
        }
        this.activeSubscriptions.clear();
        this._subscriptionIds.clear();
    }

    onMessage(data) {
        try { this.handleResponse(JSON.parse(data)); }
        catch (e) { LOGGER.error(`Parse error: ${e.message}`); }
    }

    handleResponse(r) {
        switch (r.msg_type) {
            case 'authorize':              this.handleAuthorize(r);      break;
            case 'balance':                state.accountBalance = r.balance.balance; break;
            case 'tick':                   this.handleTick(r.tick);      break;
            case 'proposal':               this.handleProposal(r);       break;
            case 'buy':                    this.handleBuyResponse(r);    break;
            case 'proposal_open_contract': this.handleOpenContract(r);   break;
            case 'ping':                                                  break;
            default:                                                      break;
        }
    }

    handleAuthorize(r) {
        if (r.error) { LOGGER.error(`Auth failed: ${r.error.message}`); return; }
        LOGGER.info(`🔑 Authorized: ${r.authorize.loginid} | Balance: ${r.authorize.balance} ${r.authorize.currency}`);
        state.isAuthorized = true;
        state.accountBalance = r.authorize.balance;
        if (state.capital === CONFIG.INITIAL_CAPITAL) state.capital = r.authorize.balance;
        this.send({ balance: 1, subscribe: 1 });
        bot.start();
    }

    handleTick(tick) {
        const symbol = tick.symbol;
        if (!state.assets[symbol]) return;
        const a = state.assets[symbol];
        a.tickCount = (a.tickCount || 0) + 1;
        if (a.tickCount % CONFIG.ANALYSIS_INTERVAL !== 0) return;
        if (a.cooldownTicks > 0) return;
        if (a.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) return;
        if (Date.now() - (a.lastTradeTime || 0) < CONFIG.MIN_TIME_BETWEEN_TRADES) return;
        const totalPos = CONFIG.ACTIVE_ASSETS.reduce((sum, s) => sum + (state.assets[s]?.activePositions?.length ?? 0), 0);
        if (totalPos >= CONFIG.MAX_TOTAL_POSITIONS) return;
        bot.requestProposal(symbol);
    }

    handleProposal(r) {
        if (r.error) {
            LOGGER.error(`Proposal error: ${r.error.message}`);
            return;
        }
        const asset = r.echo_req?.symbol || r.echo_req?.ticks;
        if (!asset || !state.assets[asset]) return;
        const proposal = r.proposal;
        const stayedInArray = proposal?.contract_details?.ticks_stayed_in;
        if (!stayedInArray) return;

        const passthrough = r.echo_req?.passthrough;
        const isScanOnly = passthrough?.action === 'scan_only';
        const isFinalStayedIn = passthrough?.action === 'get_final_stayed_in';

        bot.updateAssetStatus(asset, stayedInArray);

        if (isScanOnly) {
            LOGGER.scan(`${asset} scan: total=${AccumulatorAnalyzer.calculateTotalStayedIn(stayedInArray)} | status=${state.assets[asset].activeStatus}`);
            return;
        }

        if (isFinalStayedIn) {
            LOGGER.info(`📊 Final stayedInArray for ${asset}: [${stayedInArray.slice(-6).join('|')}]`);
            const trade = state.assets[asset].activePositions[0];
            if (trade && trade.awaitingFinalStayedIn) {
                trade.awaitingFinalStayedIn = false;
                trade.finalStayedIn = stayedInArray;
            }
            return;
        }

        bot.evaluateProposal(asset, proposal, stayedInArray);
    }

    // ════════════════════════════════════════════════════════
    // CRITICAL FIX 1: Match buy response by proposal ID (echo_req.buy)
    // NOT by numeric req_id. The position stores proposalId.
    // ════════════════════════════════════════════════════════
    handleBuyResponse(r) {
        if (r.error) {
            LOGGER.error(`Buy error: ${r.error.message}`);
            const proposalId = r.echo_req?.buy;
            // Remove the stuck 'buying' position
            if (proposalId) {
                for (const sym of CONFIG.ACTIVE_ASSETS) {
                    const a = state.assets[sym];
                    if (a?.activePositions) {
                        const idx = a.activePositions.findIndex(p => p.proposalId === proposalId && p.status === 'buying');
                        if (idx >= 0) {
                            a.activePositions.splice(idx, 1);
                            LOGGER.warn(`Removed buying position from ${sym} after buy error`);
                            break;
                        }
                    }
                }
            }
            bot._forceReleaseTradeLock();
            return;
        }

        const proposalId = r.echo_req?.buy;
        if (!proposalId) {
            LOGGER.error('Buy response missing proposal ID in echo_req');
            bot._forceReleaseTradeLock();
            return;
        }

        // Find the matching position across ALL assets
        let foundAsset = null;
        let foundPos = null;
        for (const sym of CONFIG.ACTIVE_ASSETS) {
            const a = state.assets[sym];
            if (a?.activePositions) {
                const idx = a.activePositions.findIndex(p => p.proposalId === proposalId && p.status === 'buying');
                if (idx >= 0) {
                    foundAsset = sym;
                    foundPos = a.activePositions[idx];
                    break;
                }
            }
        }

        if (!foundPos) {
            LOGGER.warn(`Buy response for proposal ${proposalId} but no matching position found`);
            bot._forceReleaseTradeLock();
            return;
        }

        // Activate the position
        foundPos.status = 'active';
        foundPos.contractId = r.buy.contract_id;
        foundPos.buyPrice = r.buy.buy_price;

        LOGGER.trade(`📋 Contract opened: ${r.buy.contract_id} on ${foundAsset} | Buy Price: $${r.buy.buy_price}`);

        // Subscribe to contract updates
        this.send({
            proposal_open_contract: 1,
            contract_id: r.buy.contract_id,
            subscribe: 1
        });

        bot._startContractWatchdog(r.buy.contract_id, foundAsset);

        TelegramService.sendTradeAlert('OPEN', foundAsset, foundPos.stake, {
            stayedIn: foundPos.stayedInData,
        });
    }

    // ════════════════════════════════════════════════════════
    // CRITICAL FIX 2: Search by contractId across ALL assets
    // instead of relying on contract.underlying (often missing).
    // CRITICAL FIX 3: Settlement guard checks 'won' / 'lost' status.
    // ════════════════════════════════════════════════════════
    handleOpenContract(r) {
        if (r.error) {
            LOGGER.error(`Contract error: ${r.error.message}`);
            return;
        }

        const contract = r.proposal_open_contract;
        const contractId = contract.contract_id;
        if (!contractId) return;

        // Search every asset for this contractId
        let foundAsset = null;
        let foundPos = null;
        let foundIdx = -1;
        for (const sym of CONFIG.ACTIVE_ASSETS) {
            const a = state.assets[sym];
            if (a?.activePositions) {
                const idx = a.activePositions.findIndex(p => p.contractId === contractId);
                if (idx >= 0) {
                    foundAsset = sym;
                    foundPos = a.activePositions[idx];
                    foundIdx = idx;
                    break;
                }
            }
        }

        if (!foundPos) {
            // Contract not tracked (already processed or unknown)
            return;
        }

        // Store subscription ID for cleanup
        if (r.subscription?.id) {
            this._subscriptionIds.set(contractId, r.subscription.id);
        }

        // Live update (contract still open)
        const status = contract.status;
        const isSold = contract.is_sold === 1 || contract.is_sold === true;
        const isExpired = contract.is_expired === 1 || contract.is_expired === true;
        const isFinal = isSold || isExpired || status === 'sold' || status === 'won' || status === 'lost';

        if (!isFinal) {
            foundPos.currentProfit = contract.profit;
            return;
        }

        // ════════════════════════════════════════════════════════
        // CONTRACT SETTLED
        // ════════════════════════════════════════════════════════
        LOGGER.trade(`📋 Contract settled: ${contractId} on ${foundAsset} | Status: ${status} | is_sold: ${contract.is_sold}`);

        // Remove from active positions
        state.assets[foundAsset].activePositions.splice(foundIdx, 1);

        // Clear watchdog
        bot._clearContractWatchdog();

        // Only release global lock if NOTHING is active anymore
        const totalPositions = CONFIG.ACTIVE_ASSETS.reduce((sum, s) => sum + (state.assets[s]?.activePositions?.length ?? 0), 0);
        if (totalPositions === 0) {
            bot._tradeLocked = false;
        }

        // Forget the subscription stream
        const subId = this._subscriptionIds.get(contractId);
        if (subId) {
            this.send({ forget: subId });
            this._subscriptionIds.delete(contractId);
        }

        // Record result
        const profit = parseFloat(contract.profit || 0);
        SessionManager.recordTradeResult(foundAsset, profit);
        TelegramService.sendTradeAlert(profit >= 0 ? 'WIN' : 'LOSS', foundAsset, foundPos.stake, { profit });
        SessionManager.checkSessionTargets();
        StatePersistence.saveState();
    }

    onError(err) { LOGGER.error(`WebSocket error: ${err.message}`); }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;
        this.stopPing();
        StatePersistence.saveState();
        if (this.isReconnecting) return;
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.isReconnecting = true;
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})`);
            TelegramService.sendMessage(`⚠️ <b>BOT4 CONNECTION LOST</b> — Reconnecting (attempt ${this.reconnectAttempts})`);
            setTimeout(() => { this.isReconnecting = false; this.connect(); }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached — giving up');
            TelegramService.sendMessage(`🛑 <b>BOT4 STOPPED</b> — Max reconnections\nFinal P/L: $${state.session.netPL.toFixed(2)}`);
            process.exit(1);
        }
    }

    startPing() {
        this.stopPing();
        this.pingInterval = setInterval(() => {
            if (state.isConnected && this.ws?.readyState === WebSocket.OPEN) this.send({ ping: 1 });
        }, 30000);
    }

    stopPing() {
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    }

    send(data) {
        if (this.ws?.readyState !== WebSocket.OPEN) { LOGGER.error('Cannot send: WebSocket not open'); return null; }
        data.req_id = state.requestId++;
        try { this.ws.send(JSON.stringify(data)); }
        catch (e) { LOGGER.error(`Send error: ${e.message}`); return null; }
        return data.req_id;
    }
}

// ============================================================
// MAIN BOT CLASS
// ============================================================
class AccumulatorBot {
    constructor() {
        this.connection = new ConnectionManager();
        this._tradeLocked = false;
        this.contractWatchdogTimer = null;
        this.pendingScanInterval = null;
        this.hourlyTimerId = null;
    }

    async start() {
        console.log('\n' + '═'.repeat(72));
        console.log(' DERIV ACCUMULATOR BOT v1.1 — Multi-Asset stayedInArray Filter');
        console.log('═'.repeat(72));
        console.log(`Assets     : ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        console.log(`Growth Rate: ${(CONFIG.GROWTH_RATE * 100)}%`);
        console.log(`Initial    : $${CONFIG.INITIAL_STAKE} | Martingale: x${CONFIG.MULTIPLIER} / x${CONFIG.MULTIPLIER2}`);
        console.log(`Threshold  : Active < ${CONFIG.STAYED_IN_THRESHOLD} | Max Total: ${CONFIG.STAYED_IN_MAX_TOTAL}`);
        console.log(`Capital    : $${state.capital.toFixed(2)}`);
        console.log('═'.repeat(72) + '\n');

        state.currentTradeDay = TradeHistoryManager.getDateKey();
        TradeHistoryManager.ensureDayEntry(state.currentTradeDay);
        this.connection.initializeAssets();
        this.startPendingAssetScan();
        this.startHourlyTimer();
        this.startTimeChecker();

        await TelegramService.sendMessage(
            `🤖 <b>ACCUMULATOR BOT4 v1.1 STARTED</b>\n` +
            `Assets: ${CONFIG.ACTIVE_ASSETS.length}\n` +
            `Growth: ${(CONFIG.GROWTH_RATE * 100)}% | Stake: $${CONFIG.INITIAL_STAKE}\n` +
            `Capital: $${state.capital.toFixed(2)}`
        );
        LOGGER.info('✅ Accumulator Bot fully started!');
    }

    updateAssetStatus(asset, stayedInArray) {
        const total = AccumulatorAnalyzer.calculateTotalStayedIn(stayedInArray);
        const a = state.assets[asset];
        if (!a) return;
        a.stayedInValue = total;
        if (total < CONFIG.STAYED_IN_THRESHOLD) {
            if (a.activeStatus !== 'active') {
                a.activeStatus = 'active';
                LOGGER.info(`✅ ${asset} ACTIVE (stayedIn: ${total})`);
            }
        } else {
            if (a.activeStatus !== 'pending') {
                a.activeStatus = 'pending';
                LOGGER.info(`⏸️ ${asset} PENDING (stayedIn: ${total})`);
            }
        }
    }

    isAssetReady(asset) {
        return state.assets[asset]?.activeStatus === 'active';
    }

    startPendingAssetScan() {
        if (this.pendingScanInterval) clearInterval(this.pendingScanInterval);
        this.pendingScanInterval = setInterval(() => {
            if (!state.isConnected || !state.isAuthorized) return;
            CONFIG.ACTIVE_ASSETS.forEach(asset => {
                const a = state.assets[asset];
                if (a.activeStatus === 'pending' && a.activePositions.length === 0) {
                    this.requestScanProposal(asset);
                }
            });
        }, CONFIG.SCAN_TIMER);
        LOGGER.info(`🔍 Pending asset scanner started (${CONFIG.SCAN_TIMER / 1000}s)`);
    }

    requestProposal(asset) {
        if (this._tradeLocked) return;
        const a = state.assets[asset];
        if (!a || a.activePositions.length > 0) return;
        const stake = Math.min(a.currentStake, CONFIG.MAX_STAKE);
        const takeProfit = this.calculateTakeProfit(a.consecutiveLosses, stake);
        const reqId = this.connection.send({
            proposal: 1,
            amount: stake.toFixed(2),
            basis: 'stake',
            contract_type: CONFIG.CONTRACT_TYPE,
            currency: 'USD',
            symbol: asset,
            growth_rate: CONFIG.GROWTH_RATE,
            limit_order: {
                take_profit: takeProfit.toFixed(2),
            },
            passthrough: { action: 'trade_eval', asset, timestamp: Date.now() },
        });
        return reqId;
    }

    requestScanProposal(asset) {
        this.connection.send({
            proposal: 1,
            amount: CONFIG.INITIAL_STAKE.toFixed(2),
            basis: 'stake',
            contract_type: CONFIG.CONTRACT_TYPE,
            currency: 'USD',
            symbol: asset,
            growth_rate: CONFIG.GROWTH_RATE,
            limit_order: { take_profit: (CONFIG.INITIAL_STAKE * CONFIG.TAKE_PROFIT_MULTIPLIER).toFixed(2) },
            passthrough: { action: 'scan_only', asset, timestamp: Date.now() },
        });
    }

    requestFinalStayedInArray(asset) {
        const a = state.assets[asset];
        if (!a) return;
        this.connection.send({
            proposal: 1,
            amount: (a.currentStake || CONFIG.INITIAL_STAKE).toFixed(2),
            basis: 'stake',
            contract_type: CONFIG.CONTRACT_TYPE,
            currency: 'USD',
            symbol: asset,
            growth_rate: CONFIG.GROWTH_RATE,
            limit_order: { take_profit: '1' },
            passthrough: { action: 'get_final_stayed_in', asset, timestamp: Date.now() },
        });
    }

    evaluateProposal(asset, proposal, stayedInArray) {
        const a = state.assets[asset];
        if (!a || a.activePositions.length > 0) return;
        if (!this.isAssetReady(asset) && a.consecutiveLosses === 0) return;
        if (!SessionManager.isSessionActive()) return;

        const c1 = AccumulatorAnalyzer.checkTradeCondition(stayedInArray, a.consecutiveLosses, CONFIG.STAYED_IN_MAX_TOTAL);
        const last6 = stayedInArray.slice(-6);
        const c2 = AccumulatorAnalyzer.checkTradeCondition2(last6, a.consecutiveLosses);

        LOGGER.debug(
            `${asset} | total=${c1.total} | recent=${c1.recentOk} | totalOk=${c1.totalOk} | ` +
            `last6=${c2.value} < ${c2.threshold}=${c2.passed} | losses=${a.consecutiveLosses}`
        );

        if (!c1.passed || !c2.passed) return;

        const stake = Math.min(a.currentStake, CONFIG.MAX_STAKE);
        if (state.capital < stake) {
            LOGGER.error(`[${asset}] Insufficient capital: $${state.capital.toFixed(2)} < $${stake.toFixed(2)}`);
            return;
        }

        this._tradeLocked = true;
        a.lastTradeTime = Date.now();

        const takeProfit = this.calculateTakeProfit(a.consecutiveLosses, stake);

        LOGGER.trade(
            `🎯 [${asset}] ACCU | Stake: $${stake.toFixed(2)} | ` +
            `TP: $${takeProfit.toFixed(2)} | ` +
            `StayedIn: ${c1.total} | last6: ${c2.value} | Losses: ${a.consecutiveLosses}`
        );

        // ════════════════════════════════════════════════════════
        // FIX: Store proposalId (not req_id) and status='buying'
        // ════════════════════════════════════════════════════════
        const pos = {
            symbol: asset,
            direction: 'ACCU',
            stake,
            growthRate: CONFIG.GROWTH_RATE,
            takeProfit,
            entryTime: Date.now(),
            contractId: null,
            proposalId: proposal.id,   // <-- proposal.id for buy-response matching
            status: 'buying',           // <-- track status explicitly
            currentProfit: 0,
            buyPrice: 0,
            stayedInData: { total: c1.total, recentOk: c1.recentOk, last6Ok: c2.passed, last6Val: c2.value },
            awaitingFinalStayedIn: false,
            finalStayedIn: null,
        };

        a.activePositions.push(pos);

        this.connection.send({
            buy: proposal.id,
            price: stake.toFixed(2),
        });

        // Safety: release lock after 5s if buy response never arrives
        setTimeout(() => {
            if (this._tradeLocked) {
                const stillBuying = CONFIG.ACTIVE_ASSETS.some(sym =>
                    state.assets[sym]?.activePositions?.some(p => p.status === 'buying')
                );
                if (!stillBuying) {
                    LOGGER.warn('Trade lock auto-released (no buying positions)');
                    this._tradeLocked = false;
                }
            }
        }, 5000);

        StatePersistence.saveState();
    }

    calculateTakeProfit(consecutiveLosses, stake) {
        if (consecutiveLosses < 1) return stake / CONFIG.TP_DIVISOR_NORMAL;
        if (consecutiveLosses === 1) return stake / CONFIG.TP_DIVISOR_1_LOSS;
        return stake / CONFIG.TP_DIVISOR_2_PLUS_LOSS;
    }

    _startContractWatchdog(contractId, asset) {
        if (this.contractWatchdogTimer) clearTimeout(this.contractWatchdogTimer);
        // 1-minute watchdog for accumulators
        this.contractWatchdogTimer = setTimeout(() => {
            const a = state.assets[asset];
            const pos = a?.activePositions?.find(p => p.contractId === contractId);
            if (!pos) {
                // Already settled
                return;
            }
            LOGGER.warn(`⏰ Contract watchdog fired for ${contractId} on ${asset}`);
            // Attempt to re-poll
            this.connection.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });

            // Second-level watchdog: if still stuck after 30s, force sell attempt
            setTimeout(() => {
                const stillPos = state.assets[asset]?.activePositions?.find(p => p.contractId === contractId);
                if (stillPos) {
                    LOGGER.error(`🚨 Force-selling stuck contract ${contractId}`);
                    this.connection.send({ sell: contractId, price: 0 });
                }
            }, 30000);
        }, 60000);
    }

    _clearContractWatchdog() {
        if (this.contractWatchdogTimer) { clearTimeout(this.contractWatchdogTimer); this.contractWatchdogTimer = null; }
    }

    _forceReleaseTradeLock() {
        this._tradeLocked = false;
        LOGGER.warn('⚠️ Trade lock force-released');
    }

    startTimeChecker() {
        if (!CONFIG.USE_TIME_BASED_DISCONNECT) return;
        setInterval(() => {
            const now = new Date();
            const gmtPlus1 = new Date(now.getTime() + 60 * 60 * 1000);
            const hour = gmtPlus1.getUTCHours();
            const mins = gmtPlus1.getUTCMinutes();
            // Find any asset that recently won
            let lastWinAsset = null;
            for (const sym of CONFIG.ACTIVE_ASSETS) {
                const a = state.assets[sym];
                if (a && a.activePositions.length === 0 && a.lastTradeWasWin && Date.now() - (a.lastTradeTime || 0) < 300000) {
                    lastWinAsset = sym;
                    break;
                }
            }
            if (lastWinAsset && !state.session.endedByTime) {
                if (hour >= CONFIG.DISCONNECT_HOUR && mins >= 0) {
                    LOGGER.info(`🌙 Past ${CONFIG.DISCONNECT_HOUR}:00 after win — disconnecting`);
                    state.session.endedByTime = true;
                    TelegramService.sendMessage(`🌙 <b>BOT4 Time Stop</b> — ${CONFIG.DISCONNECT_HOUR}:00 reached after win. Bot paused.`);
                    this.stop();
                }
            }
            if (state.session.endedByTime && hour === CONFIG.RECONNECT_HOUR && mins >= 0 && mins < 2) {
                LOGGER.info(`🌅 ${CONFIG.RECONNECT_HOUR}:00 — reconnecting`);
                state.session.endedByTime = false;
                state.session.isActive = true;
                this.connection.connect();
            }
        }, 20000);
    }

    startHourlyTimer() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0);
        setTimeout(() => {
            TelegramService.sendHourlySummary();
            this.hourlyTimerId = setInterval(() => TelegramService.sendHourlySummary(), 3600000);
        }, nextHour.getTime() - now.getTime());
    }

    stop() {
        LOGGER.info('🛑 Stopping bot...');
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            if (state.assets[sym]) state.assets[sym].activePositions = [];
        });
        if (this.pendingScanInterval) clearInterval(this.pendingScanInterval);
        if (this.hourlyTimerId) clearInterval(this.hourlyTimerId);
        this._clearContractWatchdog();
        StatePersistence.saveState();
        TradeHistoryManager.saveHistory();
        this.connection.cleanup();
    }

    getStatus() {
        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();
        let pairLines = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                const status = a.activeStatus === 'active' ? '🟢' : '⏸️';
                pairLines += `\n  ${status} ${sym}: Stake=$${a.currentStake.toFixed(2)} Pos=${a.activePositions.length} Losses=${a.consecutiveLosses} StayedIn=${a.stayedInValue ?? '?'}`;
            }
        });
        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            session: SessionManager.getSessionStats(),
            overall, today,
            pairs: pairLines,
        };
    }
}

// ============================================================
// INITIALIZATION
// ============================================================
tradeHistory = TradeHistoryManager.loadHistory();
const bot = new AccumulatorBot();

process.on('SIGINT',  () => { bot.stop(); setTimeout(() => process.exit(0), 3000); });
process.on('SIGTERM', () => { bot.stop(); setTimeout(() => process.exit(0), 3000); });
process.on('uncaughtException',  (err) => { LOGGER.error(`UNCAUGHT: ${err.message}\n${err.stack}`); try { StatePersistence.saveState(); } catch {} });
process.on('unhandledRejection', (reason) => { LOGGER.error(`UNHANDLED: ${reason}`); try { StatePersistence.saveState(); } catch {} });

const stateLoaded = StatePersistence.loadState();
LOGGER.info(stateLoaded ? '🔄 Resuming from saved state' : '🆕 Starting fresh session');

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.error('\n⚠️  Set CONFIG.API_TOKEN before running!\n');
    process.exit(1);
}

console.log('\n🚀 Starting Deriv Accumulator Bot v1.1...\n');
bot.connection.connect();

// ── Status display every 60s ──────────────────────────────────
const statusInterval = setInterval(() => {
    if (!state.isAuthorized) return;
    const status = bot.getStatus();
    console.log(`\n📊 ${getGMTTime()} | Session: ${status.session.trades}t ${status.session.winRate} $${status.session.netPL.toFixed(2)} | Capital: $${status.capital.toFixed(2)}`);
    console.log(`📋 Overall: ${status.overall.tradesCount}t | P/L: $${status.overall.netPL.toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
    console.log(`📈 Assets:${status.pairs}`);
}, 60000);
