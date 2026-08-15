'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DERIV SYNTHETIC INDICES BOT  —  v1.0  "RISE ALWAYS-CALL"              ║
 * ║  STRATEGY (ported 1:1 from the Blockly / Binary-bot XML):               ║
 * ║  ──────────────────────────────────────────────────────────────────────  ║
 * ║  • Market : Volatility Index R_50  (Rise/Fall)                          ║
 * ║  • Candle : 60s  |  Contract : 30 seconds                               ║
 * ║  • Entry  : ALWAYS buy CALL (Rise) on every candle close                ║
 * ║  • Stake  : starts at 0.70                                              ║
 * ║  • WIN    : stake resets to 0.70                                        ║
 * ║  • LOSS   : stake += |loss| * 1.071   (loss-recovery martingale)        ║
 * ║  • If |loss| >= 100  → stake resets to 0.70                             ║
 * ║  • STOP  : when total profit >= 5.00  ("Done!")                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ══════════════════════════════════════════════════════════════════════════════
// DERIV REST CLIENT  (for the PAT / OAuth OTP-based auth flow)
// ══════════════════════════════════════════════════════════════════════════════
class RestClient {
    constructor(baseUrl, appId, token) {
        this.baseUrl = baseUrl || 'https://api.derivws.com';
        this.appId = appId || '1089';
        this.token = token || '';
    }

    static isPat(token) {
        return typeof token === 'string'
            && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
    }

    _request(method, urlPath, body = null) {
        return new Promise((resolve, reject) => {
            let url;
            try { url = new URL(urlPath, this.baseUrl); }
            catch (e) { return reject(new Error(`Invalid URL: ${urlPath}`)); }

            const isHttps = url.protocol === 'https:';
            const lib = isHttps ? https : http;

            const opts = {
                method,
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                headers: {
                    'Deriv-App-ID': this.appId,
                    'Authorization': 'Bearer ' + this.token,
                    'Accept': 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                timeout: 15000,
            };

            const req = lib.request(opts, res => {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => {
                    let parsed = data;
                    try { parsed = JSON.parse(data); } catch (_) { }
                    resolve({ status: res.statusCode, body: parsed });
                });
            });

            req.on('timeout', () => { req.destroy(new Error('REST request timeout')); });
            req.on('error', reject);
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    get(p) { return this._request('GET', p); }
    post(p, b) { return this._request('POST', p, b); }
    delete(p) { return this._request('DELETE', p); }
}

// ============================================================
// FILE PATHS
// ============================================================
const STATE_FILE = path.join(__dirname, 'riseFallR50-state_01.json');
const HISTORY_FILE = path.join(__dirname, 'riseFallR50-history_01.json');
const STATE_SAVE_INTERVAL = 5000;  // ms

// ============================================================
// LOGGER
// ============================================================
const getGMTTime = () =>
    new Date().toISOString().replace('T', ' ').split('.')[0] + ' GMT';

const LOGGER = {
    info: (msg) => console.log(`[INFO]  ${getGMTTime()} - ${msg}`),
    trade: (msg) => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: (msg) => console.warn(`\x1b[33m[WARN]  ${getGMTTime()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); },
    signal: (msg) => console.log(`\x1b[36m[SIGNAL]${getGMTTime()} - ${msg}\x1b[0m`),
    win: (msg) => console.log(`\x1b[92m[WIN]   ${getGMTTime()} - ${msg}\x1b[0m`),
    loss: (msg) => console.log(`\x1b[91m[LOSS]  ${getGMTTime()} - ${msg}\x1b[0m`),
    candle: (msg) => console.log(`\x1b[95m[CANDLE] ${getGMTTime()} - ${msg}\x1b[0m`),
};

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
    // ── Deriv API credentials ────────────────────────────────
    API_TOKEN: 'pat_cb2016855b5e6c61ac95f94432192dd6ed86bec7f7454e575d3fe1ed9f617692',
    APP_ID: '33uslPtthXBEkQOdfKfoY',
    ACCOUNT_TYPE: 'demo',          // 'demo' | 'real' (PAT mode only)
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // ── Strategy money-management (from the XML variables) ──
    INITIAL_STAKE: 0.7,            // "Initial Amount"
    WIN_AMOUNT: 0.7,               // "Win Amount" — reset stake after a win
    LOSS_RECOVERY_MULTIPLIER: 1.071, // after a loss: stake += |loss| * 1.071
    MAX_LOSS_AMOUNT: 100,          // "Max Loss Amount" — reset stake if |loss| >= this
    EXPECTED_PROFIT: 5,            // "Expected Profit" — stop when total profit >= this

    // ── Candle / Contract settings (from the XML trade block) ─
    GRANULARITY: 60,               // 60-second candles
    TIMEFRAME_LABEL: '1m',
    CANDLES_TO_LOAD: 30,
    MAX_CANDLES_STORED: 30,
    DURATION: 30,                  // 30-second contract
    DURATION_UNIT: 's',
    MIN_CANDLES_REQUIRED: 1,       // always-CALL needs no analysis → trade ASAP

    // ── Trading sessions (synthetics trade 24/7) ────────────
    USE_TRADING_SESSIONS: false,
    SESSIONS: [
        { name: 'LONDON_OPEN', start: 2, end: 17 },
        { name: 'NY_OPEN', start: 12, end: 22 },
    ],

    // ── Position management ─────────────────────────────────
    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    MAX_TOTAL_POSITIONS: 1,

    // ── Active asset ────────────────────────────────────────
    ACTIVE_ASSETS: ['R_50'],

    // ── Misc ────────────────────────────────────────────────
    DEBUG_MODE: true,
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8565754902:AAHS6UQWEgLJ0DO-JTpAGQhZLs-UDVVNAQc',
    TELEGRAM_CHAT_ID: '752497117',
};

// ============================================================
// TRADING SESSION MANAGER
// ============================================================
class TradingSessionManager {

    static getCurrentUTCHour() { return new Date().getUTCHours(); }

    static isWithinAnySession() {
        if (!CONFIG.USE_TRADING_SESSIONS) return { inSession: true, sessionName: '24/7' };
        const hour = this.getCurrentUTCHour();
        for (const session of CONFIG.SESSIONS) {
            if (this._inSession(hour, session.start, session.end)) {
                return { inSession: true, sessionName: session.name };
            }
        }
        return { inSession: false, sessionName: null };
    }

    static _inSession(hour, start, end) {
        if (end <= start) return hour >= start || hour < end;
        return hour >= start && hour < end;
    }

    static getStatusString() {
        const time = `${String(new Date().getUTCHours()).padStart(2, '0')}:${String(new Date().getUTCMinutes()).padStart(2, '0')} UTC`;
        if (!CONFIG.USE_TRADING_SESSIONS) return `\u{1f7e2} SYNTHETIC 24/7 MODE (${time})`;
        const info = this.isWithinAnySession();
        return info.inSession ? `\u{1f7e2} ${info.sessionName} (${time})` : `\u{1f534} OUTSIDE SESSIONS (${time})`;
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
            if (!data.dailyHistory) data.dailyHistory = {};
            if (!data.overallAssets) data.overallAssets = {};
            if (!data.overall) data.overall = this._emptyOverall();
            LOGGER.info(`History loaded — ${Object.keys(data.dailyHistory).length} days on record`);
            return data;
        } catch (e) {
            LOGGER.error(`Failed to load history: ${e.message}`);
            return this._emptyHistory();
        }
    }

    static _emptyOverall() {
        return { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0, firstTradeDate: null, lastTradeDate: null };
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
                profit: 0, loss: 0, netPL: 0, assets: {},
            };
        }
    }

    static ensureAssetDayEntry(dateKey, symbol) {
        this.ensureDayEntry(dateKey);
        if (!tradeHistory.dailyHistory[dateKey].assets[symbol]) {
            tradeHistory.dailyHistory[dateKey].assets[symbol] = { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0 };
        }
    }

    static ensureOverallAssetEntry(symbol) {
        if (!tradeHistory.overallAssets[symbol]) {
            tradeHistory.overallAssets[symbol] = { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0 };
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

        dayStats.tradesCount++; dayAssetStats.tradesCount++;
        overall.tradesCount++; overallAsset.tradesCount++;

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

        if (!tradeHistory.overall.firstTradeDate) tradeHistory.overall.firstTradeDate = dateKey;
        tradeHistory.overall.lastTradeDate = dateKey;
        tradeHistory.lastUpdated = Date.now();
        this.saveHistory();
    }

    static getDayStats(dateKey) { this.ensureDayEntry(dateKey); return tradeHistory.dailyHistory[dateKey]; }
    static getTodayStats() { return this.getDayStats(this.getDateKey()); }
    static getOverallStats() { return tradeHistory.overall; }
    static getAllDays() { return Object.keys(tradeHistory.dailyHistory).sort(); }
}

// ============================================================
// STATE PERSISTENCE
// ============================================================
class StatePersistence {

    static saveState() {
        try {
            const data = {
                savedAt: Date.now(),
                accountBalance: state.accountBalance,
                totalProfit: state.totalProfit,
                profitTargetReached: state.profitTargetReached,
                session: { ...state.session },
                currentTradeDay: state.currentTradeDay,
                assets: {},
            };

            Object.keys(state.assets).forEach(symbol => {
                const a = state.assets[symbol];
                data.assets[symbol] = {
                    closedCandles: a.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED),
                    lastProcessedCandleOpenTime: a.lastProcessedCandleOpenTime,
                    candlesLoaded: a.candlesLoaded,
                    currentStake: a.currentStake,
                    consecutiveWins: a.consecutiveWins,
                    consecutiveLosses: a.consecutiveLosses,
                    tradesCount: a.tradesCount, winsCount: a.winsCount,
                    lossesCount: a.lossesCount, netPL: a.netPL,
                    profit: a.profit, loss: a.loss,
                    activePositions: a.activePositions.map(p => ({ ...p })),
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

            LOGGER.info(`Restoring state from ${ageMins.toFixed(1)} minutes ago`);
            state.accountBalance = data.accountBalance ?? 0;
            state.totalProfit = data.totalProfit ?? 0;
            state.profitTargetReached = data.profitTargetReached ?? false;
            state.session = { ...state.session, ...data.session };
            state.currentTradeDay = data.currentTradeDay || TradeHistoryManager.getDateKey();

            if (data.assets) {
                Object.keys(data.assets).forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = data.assets[symbol];
                        const a = state.assets[symbol];

                        if (saved.closedCandles?.length) a.closedCandles = saved.closedCandles;
                        a.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                        a.candlesLoaded = false;
                        a.currentStake = saved.currentStake || CONFIG.INITIAL_STAKE;
                        a.consecutiveWins = saved.consecutiveWins || 0;
                        a.consecutiveLosses = saved.consecutiveLosses || 0;
                        a.tradesCount = saved.tradesCount || 0;
                        a.winsCount = saved.winsCount || 0;
                        a.lossesCount = saved.lossesCount || 0;
                        a.netPL = saved.netPL || 0;
                        a.profit = saved.profit || 0;
                        a.loss = saved.loss || 0;
                        a.activePositions = (saved.activePositions || []).map(p => ({ ...p }));

                        LOGGER.info(`${symbol}: Stake=$${(a.currentStake || 0).toFixed(2)} P/L=$${(a.netPL || 0).toFixed(2)} | W=${a.winsCount} L=${a.lossesCount} T=${a.tradesCount}`);
                    }
                });
            }

            LOGGER.info(`State restored | Total profit: $${state.totalProfit.toFixed(2)} | Target reached: ${state.profitTargetReached}`);
            return true;
        } catch (e) { LOGGER.error(`Load state error: ${e.message}`); return false; }
    }

    static startAutoSave() {
        setInterval(() => { if (state.isAuthorized) this.saveState(); }, STATE_SAVE_INTERVAL);
        LOGGER.info(`Auto-save every ${STATE_SAVE_INTERVAL / 1000}s`);
    }
}

// ============================================================
// TELEGRAM SERVICE
// ============================================================
class TelegramService {

    static hourlyTimerStarted = false;
    static hourlyTimerId = null;

    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED || !message?.length) return;
        try {
            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
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

    static async sendTradeAlert(type, symbol, direction, stake, duration, durationUnit, details = {}) {
        const emoji = type === 'OPEN' ? '\u{1f680}' : type === 'WIN' ? '✅' : '❌';
        const a = state.assets[symbol];
        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();

        const lines = [
            `${emoji} <b>RISE ALWAYS-CALL BOT — ${type}</b>`,
            `Pair: <b>${symbol}</b>  Direction: <b>${direction === 'CALLE' ? '\u{1f4c8} CALLE (Rise)' : '\u{1f4c9} PUTE (Fall)'}</b>`,
            `Stake: $${stake.toFixed(2)} | Duration: ${duration}${(durationUnit || 's').toUpperCase()}`,
            `${TradingSessionManager.getStatusString()}`,
            ``,
        ];

        if (details.profit !== undefined) {
            const pl = Number(details.profit) || 0;
            lines.push(`Profit: ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}`);
            lines.push(``);
            lines.push(`\u{1f4cb} <b>${symbol} Stats:</b>`);
            lines.push(`W/L: ${a?.winsCount ?? 0}/${a?.lossesCount ?? 0} | P/L: $${(a?.netPL ?? 0).toFixed(2)}`);
            lines.push(`Next Stake: $${(a?.currentStake ?? 0).toFixed(2)}`);
            lines.push(``);
            lines.push(`\u{1f4cb} <b>Today:</b>`);
            lines.push(`Trades: ${today.tradesCount} | W/L: ${today.winsCount}/${today.lossesCount} | P/L: $${(today.netPL || 0).toFixed(2)}`);
            lines.push(`Balance: $${(state.accountBalance || 0).toFixed(2)}`);
            lines.push(`Total Profit (cycle): $${(state.totalProfit || 0).toFixed(2)} / $${CONFIG.EXPECTED_PROFIT}`);
            lines.push(``);
            lines.push(`\u{1f4cb} <b>Overall:</b>`);
            lines.push(`Trades: ${overall.tradesCount} | W/L: ${overall.winsCount}/${overall.lossesCount} | P/L: $${(overall.netPL || 0).toFixed(2)}`);
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
                assetInfo += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L $${(a.netPL || 0).toFixed(2)}`;
            }
        });

        await this.sendMessage([
            `⏰ <b>RISE ALWAYS-CALL BOT Hourly</b>`,
            `Last Hour: ${h.trades}t ${h.wins}W/${h.losses}L ${wr}% ${h.pnl >= 0 ? '\u{1f7e2}' : '\u{1f534}'} $${h.pnl.toFixed(2)}`,
            `Today: ${today.tradesCount}t P/L: $${(today.netPL || 0).toFixed(2)}`,
            `Total Profit (cycle): $${(state.totalProfit || 0).toFixed(2)} / $${CONFIG.EXPECTED_PROFIT}`,
            `Balance: $${(state.accountBalance || 0).toFixed(2)}`,
            TradingSessionManager.getStatusString(),
            assetInfo ? `\n<b>Per-Asset:</b>${assetInfo}` : '',
        ].join('\n'));

        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };
    }

    static async sendStartupMessage() {
        const overall = TradeHistoryManager.getOverallStats();

        await this.sendMessage([
            `\u{1f916} <b>RISE ALWAYS-CALL BOT STARTED</b>`,
            `Strategy: Always CALL (Rise) on R_50 — 30s contracts`,
            `Stake: $${CONFIG.INITIAL_STAKE.toFixed(2)} | Win reset: $${CONFIG.WIN_AMOUNT.toFixed(2)}`,
            `Loss recovery: +|loss| × ${CONFIG.LOSS_RECOVERY_MULTIPLIER} | Max loss reset: $${CONFIG.MAX_LOSS_AMOUNT}`,
            `Target: stop at +$${CONFIG.EXPECTED_PROFIT.toFixed(2)} total profit`,
            `Balance: $${(state.accountBalance || 0).toFixed(2)}`,
            TradingSessionManager.getStatusString(),
            ``,
            `\u{1f4ca} Overall: ${overall.tradesCount} trades | P/L: $${(overall.netPL || 0).toFixed(2)}`,
        ].join('\n'));
    }

    static startHourlyTimer() {
        if (this.hourlyTimerStarted) return;
        this.hourlyTimerStarted = true;
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0);
        setTimeout(() => {
            this.sendHourlySummary();
            this.hourlyTimerId = setInterval(() => this.sendHourlySummary(), 3600000);
        }, nextHour.getTime() - now.getTime());
    }

    static clearTimers() {
        if (this.hourlyTimerId) { clearInterval(this.hourlyTimerId); this.hourlyTimerId = null; this.hourlyTimerStarted = false; }
    }
}

// ============================================================
// SESSION MANAGER  — money management lives in recordTradeResult
// ============================================================
class SessionManager {

    static isSessionActive() { return state.session.isActive && !state.profitTargetReached; }

    static getSessionStats() {
        const dur = Date.now() - state.session.startTime;
        const hrs = Math.floor(dur / 3600000);
        const mins = Math.floor((dur % 3600000) / 60000);
        const wr = state.session.tradesCount > 0
            ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1) + '%'
            : '0%';
        return { duration: `${hrs}h ${mins}m`, trades: state.session.tradesCount, wins: state.session.winsCount, losses: state.session.lossesCount, winRate: wr, netPL: state.session.netPL };
    }

    static checkDayChange() {
        const today = TradeHistoryManager.getDateKey();
        if (state.currentTradeDay && state.currentTradeDay !== today) {
            LOGGER.info(`Day changed: ${state.currentTradeDay} -> ${today}`);
            this._resetDailyStats();
        }
        state.currentTradeDay = today;
    }

    static _resetDailyStats() {
        const s = state.session;
        s.tradesCount = 0; s.winsCount = 0; s.lossesCount = 0;
        s.profit = 0; s.loss = 0; s.netPL = 0;
        s.startTime = Date.now();
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };

        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                a.tradesCount = 0; a.winsCount = 0; a.lossesCount = 0;
                a.profit = 0; a.loss = 0; a.netPL = 0;
            }
        });
    }

    static recordTradeResult(symbol, profit, direction, stake) {
        const a = state.assets[symbol];
        if (!a) return;

        this.checkDayChange();

        const hour = new Date().getUTCHours();
        if (hour !== state.hourlyStats.lastHour) {
            state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: hour };
        }

        state.session.tradesCount++;
        state.hourlyStats.trades++;
        state.hourlyStats.pnl += profit;
        a.tradesCount++;

        // ════════════════════════════════════════════════════════
        // MONEY MANAGEMENT  (ported from the Blockly after_purchase)
        // ════════════════════════════════════════════════════════
        if (profit > 0) {
            // WIN → reset stake to "Win Amount"
            a.currentStake = CONFIG.WIN_AMOUNT;

            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            state.hourlyStats.wins++;
            a.winsCount++;
            a.profit += profit; a.netPL += profit;
            a.consecutiveWins++;
            a.consecutiveLosses = 0;

            LOGGER.win(`[${symbol}] WIN +$${profit.toFixed(2)} | ${direction} | Stake reset → $${CONFIG.WIN_AMOUNT.toFixed(2)} | Cycle P/L: $${(state.totalProfit + profit).toFixed(2)}`);
        } else {
            // LOSS → recovery martingale
            const lossAmount = Math.abs(profit);

            if (lossAmount >= CONFIG.MAX_LOSS_AMOUNT) {
                // |loss| reached "Max Loss Amount" → reset stake to "Win Amount"
                a.currentStake = CONFIG.WIN_AMOUNT;
                LOGGER.warn(`[${symbol}] MAX LOSS HIT (|loss| $${lossAmount.toFixed(2)} >= $${CONFIG.MAX_LOSS_AMOUNT}) — Stake reset → $${CONFIG.WIN_AMOUNT.toFixed(2)}`);
                TelegramService.sendMessage(
                    `🛑 <b>R_50 MAX LOSS RESET</b>\nLoss: -$${lossAmount.toFixed(2)} (>= $${CONFIG.MAX_LOSS_AMOUNT})\nStake reset to $${CONFIG.WIN_AMOUNT.toFixed(2)}`
                );
            } else {
                // stake += |loss| * 1.071
                const prevStake = a.currentStake;
                a.currentStake = Number((a.currentStake + lossAmount * CONFIG.LOSS_RECOVERY_MULTIPLIER).toFixed(2));
                LOGGER.loss(`[${symbol}] LOSS -$${lossAmount.toFixed(2)} | ${direction} | Stake $${prevStake.toFixed(2)} → $${a.currentStake.toFixed(2)} (+$${(lossAmount * CONFIG.LOSS_RECOVERY_MULTIPLIER).toFixed(2)})`);
            }

            state.session.lossesCount++;
            state.session.loss += lossAmount;
            state.session.netPL += profit;
            state.hourlyStats.losses++;
            a.lossesCount++;
            a.loss += lossAmount;
            a.netPL += profit;
            a.consecutiveLosses++;
            a.consecutiveWins = 0;
        }

        // Accumulate cycle total profit
        state.totalProfit = Number((state.totalProfit + profit).toFixed(2));

        // ════════════════════════════════════════════════════════
        // TARGET CHECK  (total_profit >= Expected Profit → "Done!")
        // ════════════════════════════════════════════════════════
        if (state.totalProfit >= CONFIG.EXPECTED_PROFIT && !state.profitTargetReached) {
            state.profitTargetReached = true;
            LOGGER.trade(`\u{1f3c1} TARGET REACHED — Done! Total profit: $${state.totalProfit.toFixed(2)} (target $${CONFIG.EXPECTED_PROFIT})`);
            TelegramService.sendMessage(
                `\u{1f3c1} <b>DONE! Total profit: $${state.totalProfit.toFixed(2)}</b>\n` +
                `Target $${CONFIG.EXPECTED_PROFIT.toFixed(2)} reached — trading stopped.\n` +
                `Balance: $${(state.accountBalance || 0).toFixed(2)}`
            );
            if (state.session.isActive) state.session.isActive = false;
        }

        TradeHistoryManager.recordTrade(symbol, profit);
    }
}

// ============================================================
// STATE
// ============================================================
const state = {
    assets: {},
    accountBalance: 0,
    totalProfit: 0,
    profitTargetReached: false,
    currentTradeDay: null,
    session: {
        profit: 0, loss: 0, netPL: 0,
        tradesCount: 0, winsCount: 0, lossesCount: 0,
        isActive: true, startTime: Date.now(),
    },
    isConnected: false,
    isAuthorized: false,
    hourlyStats: { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() },
    requestId: 1,
    lastSessionLogTime: 0,
    tradeWatchdogTimer: null,
    tradeWatchdogPollTimer: null,
    currentContractId: null,
    tradeStartTime: null,
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
        this.isShuttingDown = false;
        this.reconnectTimer = null;
        this.activeSubscriptions = new Set();
        this._subscriptionIds = new Map();
        this._isPat = RestClient.isPat(CONFIG.API_TOKEN);
        this._rest = this._isPat
            ? new RestClient('https://api.derivws.com', CONFIG.APP_ID, CONFIG.API_TOKEN)
            : null;
        this._otpUrl = null;
        this._targetAccount = null;
        this.accountInfo = null;
    }

    connect() {
        if (this.ws?.readyState === WebSocket.OPEN) { LOGGER.info('Already connected'); return; }
        if (!CONFIG.API_TOKEN) { LOGGER.error('API_TOKEN is empty — aborting'); return; }
        LOGGER.info('Connecting to Deriv API...');
        this.cleanup();
        this.isShuttingDown = false;

        if (this._isPat) {
            LOGGER.info('PAT token detected → using NEW Deriv API (OTP flow)');
            this._newApiConnect().catch(err => {
                LOGGER.error(`New API connect failed: ${err.message}`);
                this.onClose();
            });
        } else {
            LOGGER.info('Using legacy Deriv API (token authorize flow)');
            this._openWs(`${CONFIG.WS_URL}?app_id=${encodeURIComponent(CONFIG.APP_ID)}`);
        }
    }

    _openWs(url) {
        try {
            this.ws = new WebSocket(url, {
                headers: { 'User-Agent': 'Bot/1.0 (+Node.js)' },
                handshakeTimeout: 15000,
            });
        } catch (e) {
            LOGGER.error(`WS construct failed: ${e.message}`);
            this.onClose();
            return;
        }

        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', data => this.onMessage(data));
        this.ws.on('error', err => this.onError(err));
        this.ws.on('close', () => this.onClose());
        this.ws.on('unexpected-response', (_req, res) => {
            LOGGER.error(`WS handshake failed: ${res.statusCode} ${res.statusMessage}`);
            try { res.destroy(); } catch (_) { }
            this.onClose();
        });
    }

    async _newApiConnect() {
        LOGGER.info('REST: GET /trading/v1/options/accounts');
        const accRes = await this._rest.get('/trading/v1/options/accounts');

        if (accRes.status !== 200) {
            const msg = accRes.body?.errors?.[0]?.message || accRes.body?.message || JSON.stringify(accRes.body);
            let hint = '';
            if (accRes.status === 401) hint = ' — check PAT validity and APP_ID registration';
            else if (accRes.status === 403) hint = ' — PAT may lack "trade" scope';
            throw new Error(`Account list failed (${accRes.status}): ${msg}${hint}`);
        }

        const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
        if (!accounts.length) throw new Error('No Options accounts found for this token');

        const desiredType = (CONFIG.ACCOUNT_TYPE || 'demo').toLowerCase();
        const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desiredType) || accounts[0];

        this._targetAccount = acct;
        this.accountInfo = {
            loginid: acct.account_id, email: acct.email,
            isVirtual: (acct.account_type || '').toLowerCase() === 'demo',
            accountType: acct.account_type, currency: acct.currency,
            balance: parseFloat(acct.balance), group: acct.group,
        };

        LOGGER.info(`Selected account ${acct.account_id} (${acct.account_type}, ${acct.currency}, balance=${acct.balance})`);

        const otpPath = `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`;
        const otpRes = await this._rest.post(otpPath);

        if (otpRes.status !== 200) {
            const msg = otpRes.body?.errors?.[0]?.message || JSON.stringify(otpRes.body);
            throw new Error(`OTP request failed (${otpRes.status}): ${msg}`);
        }

        const wsUrl = otpRes.body?.data?.url;
        if (!wsUrl || !/^wss?:/i.test(wsUrl)) {
            throw new Error(`OTP response missing .data.url: ${JSON.stringify(otpRes.body)}`);
        }

        this._otpUrl = wsUrl;
        this._openWs(wsUrl);
    }

    _newApiMarkAuthorized() {
        if (!this.accountInfo) return;

        LOGGER.info(
            `Authorized ${this.accountInfo.loginid}` +
            `(${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'})` +
            `balance=${this.accountInfo.balance} ${this.accountInfo.currency} via PAT/new-API`
        );

        state.isAuthorized = true;
        state.accountBalance = this.accountInfo.balance;
        this.send({ balance: 1, subscribe: 1 });

        if (this.reconnectAttempts > 0 || this.hasAnyActivePositions()) {
            CONFIG.ACTIVE_ASSETS.forEach(sym => {
                const a = state.assets[sym];
                if (a?.activePositions) {
                    a.activePositions.forEach(pos => {
                        if (pos.contractId) this.send({ proposal_open_contract: 1, contract_id: pos.contractId, subscribe: 1 });
                    });
                }
            });
        }

        bot.start();
    }

    onOpen() {
        LOGGER.info('Connected to Deriv API');
        state.isConnected = true;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.startPing();

        if (!this.autoSaveStarted) { StatePersistence.startAutoSave(); this.autoSaveStarted = true; }

        if (this._isPat) {
            this._newApiMarkAuthorized();
        } else {
            this.send({ authorize: CONFIG.API_TOKEN });
        }
    }

    initializeAssets() {
        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            if (!state.assets[symbol]) {
                state.assets[symbol] = {
                    candles: [], closedCandles: [],
                    currentFormingCandle: null,
                    lastProcessedCandleOpenTime: null,
                    candlesLoaded: false,
                    currentStake: CONFIG.INITIAL_STAKE,
                    canTrade: false,
                    consecutiveWins: 0,
                    consecutiveLosses: 0,
                    activePositions: [],
                    tradesCount: 0, winsCount: 0, lossesCount: 0,
                    profit: 0, loss: 0, netPL: 0,
                };
                LOGGER.info(`Initialized asset: ${symbol}`);
            }
        });
    }

    cleanup() {
        this.stopPing();
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.ws) {
            this.ws.removeAllListeners();
            try { if (this.ws.readyState <= 1) this.ws.close(); } catch { }
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
            case 'authorize': this.handleAuthorize(r); break;
            case 'balance':
                state.accountBalance = r.balance.balance;
                break;
            case 'ohlc': this.handleOHLC(r.ohlc); break;
            case 'candles': this.handleCandlesHistory(r); break;
            case 'buy': this.handleBuyResponse(r); break;
            case 'proposal_open_contract': this.handleOpenContract(r); break;
            case 'ping': break;
            default: break;
        }
    }

    handleAuthorize(r) {
        if (r.error) { LOGGER.error(`Auth failed: ${r.error.message}`); return; }

        LOGGER.info(`Authorized: ${r.authorize.loginid} | Balance: ${r.authorize.balance} ${r.authorize.currency}`);
        state.isAuthorized = true;
        state.accountBalance = r.authorize.balance;
        this.send({ balance: 1, subscribe: 1 });

        if (this.reconnectAttempts > 0 || this.hasAnyActivePositions()) {
            CONFIG.ACTIVE_ASSETS.forEach(sym => {
                const a = state.assets[sym];
                if (a?.activePositions) {
                    a.activePositions.forEach(pos => {
                        if (pos.contractId) this.send({ proposal_open_contract: 1, contract_id: pos.contractId, subscribe: 1 });
                    });
                }
            });
        }

        bot.start();
    }

    hasAnyActivePositions() {
        return CONFIG.ACTIVE_ASSETS.some(s => state.assets[s]?.activePositions?.length > 0);
    }

    handleBuyResponse(r) {
        if (r.error) {
            LOGGER.error(`Buy error: ${r.error.message}`);
            const reqId = r.echo_req?.req_id;
            if (reqId) {
                CONFIG.ACTIVE_ASSETS.forEach(sym => {
                    const a = state.assets[sym];
                    if (a?.activePositions) {
                        const i = a.activePositions.findIndex(p => p.reqId === reqId);
                        if (i >= 0) {
                            a.activePositions.splice(i, 1);
                            a.canTrade = true;
                        }
                    }
                });
            }
            if (bot) bot._forceReleaseTradeLock();
            return;
        }

        const contract = r.buy;
        LOGGER.trade(`Contract opened: ${contract.contract_id} | Buy Price: $${contract.buy_price}`);

        const reqId = r.echo_req.req_id;
        for (const sym of CONFIG.ACTIVE_ASSETS) {
            const a = state.assets[sym];
            if (a?.activePositions) {
                const pos = a.activePositions.find(p => p.reqId === reqId);
                if (pos) {
                    pos.contractId = contract.contract_id;
                    pos.buyPrice = contract.buy_price;
                    state.currentContractId = contract.contract_id;
                    state.tradeStartTime = Date.now();

                    bot._startTradeWatchdog(contract.contract_id);

                    TelegramService.sendTradeAlert(
                        'OPEN', pos.symbol, pos.direction, pos.stake,
                        pos.duration, pos.durationUnit
                    );
                    break;
                }
            }
        }

        this.send({ proposal_open_contract: 1, contract_id: contract.contract_id, subscribe: 1 });
    }

    handleOpenContract(r) {
        if (r.error) {
            LOGGER.error(`Contract error: ${r.error.message}`);
            if (bot) bot._forceReleaseTradeLock();
            return;
        }

        const contract = r.proposal_open_contract;
        const contractId = contract.contract_id;
        const contractIdStr = String(contractId);

        if (r.subscription?.id) this._subscriptionIds.set(contractIdStr, r.subscription.id);

        if (bot._processedContracts.has(contractIdStr)) {
            if (r.subscription?.id) this.send({ forget: r.subscription.id });
            return;
        }

        if (!contract.is_sold && !contract.is_expired && contract.status !== 'sold') {
            for (const sym of CONFIG.ACTIVE_ASSETS) {
                const a = state.assets[sym];
                if (a?.activePositions) {
                    const pos = a.activePositions.find(p => p.contractId === contractId);
                    if (pos) { pos.currentProfit = contract.profit; break; }
                }
            }
            return;
        }

        let ownerSym = null, posIdx = -1;
        for (const sym of CONFIG.ACTIVE_ASSETS) {
            const a = state.assets[sym];
            if (a?.activePositions) {
                const i = a.activePositions.findIndex(p => String(p.contractId) === String(contractId));
                if (i >= 0) { ownerSym = sym; posIdx = i; break; }
            }
        }

        if (posIdx < 0 || !ownerSym) {
            if (!r._contractMatchRetry) {
                r._contractMatchRetry = true;
                LOGGER.warn(`Contract ${contractId} settled but not found — retrying in 500ms`);
                setTimeout(() => this.handleOpenContract(r), 500);
                return;
            }

            LOGGER.warn(`Contract ${contractId} settled but still not found after retry — releasing trade lock`);
            if (bot) bot._forceReleaseTradeLock();
            return;
        }

        bot._processedContracts.add(contractIdStr);
        bot._clearAllWatchdogTimers();

        const a = state.assets[ownerSym];
        const pos = a.activePositions[posIdx];
        const profit = Number(contract.profit);

        SessionManager.recordTradeResult(ownerSym, profit, pos.direction, pos.stake);
        a.canTrade = true;

        TelegramService.sendTradeAlert(
            profit >= 0 ? 'WIN' : 'LOSS',
            ownerSym, pos.direction, pos.stake,
            pos.duration, pos.durationUnit,
            { profit }
        );

        a.activePositions.splice(posIdx, 1);
        state.currentContractId = null;
        state.tradeStartTime = null;
        bot._tradeLocked = false;

        if (r.subscription?.id) this.send({ forget: r.subscription.id });

        StatePersistence.saveState();
    }

    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        const a = state.assets[symbol];
        if (!a) return;

        const gran = CONFIG.GRANULARITY;
        const openTime = ohlc.open_time || Math.floor(ohlc.epoch / gran) * gran;

        const incoming = {
            open: parseFloat(ohlc.open), high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low), close: parseFloat(ohlc.close),
            epoch: ohlc.epoch, open_time: openTime,
        };

        if ([incoming.open, incoming.high, incoming.low, incoming.close].some(isNaN)) {
            LOGGER.error(`[${symbol}] Invalid OHLC data`);
            return;
        }

        const isNewCandle = a.currentFormingCandle?.open_time !== undefined &&
            incoming.open_time !== a.currentFormingCandle.open_time;

        if (isNewCandle) {
            const closed = { ...a.currentFormingCandle };
            closed.epoch = closed.open_time + gran;

            if (closed.open_time !== a.lastProcessedCandleOpenTime) {
                const alreadyIn = a.closedCandles.some(c => c.open_time === closed.open_time);

                if (!alreadyIn) {
                    a.closedCandles.push(closed);
                    a.lastProcessedCandleOpenTime = closed.open_time;

                    if (a.closedCandles.length > CONFIG.MAX_CANDLES_STORED) {
                        a.closedCandles = a.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED);
                    }

                    const dir = closed.close > closed.open ? '\u{1f7e2}' : '\u{1f534}';
                    const time = new Date(closed.epoch * 1000).toISOString();
                    LOGGER.candle(`${dir} [${symbol}] CANDLE CLOSED [${time}] O:${closed.open.toFixed(5)} H:${closed.high.toFixed(5)} L:${closed.low.toFixed(5)} C:${closed.close.toFixed(5)} | Total: ${a.closedCandles.length}`);

                    a.canTrade = true;

                    try {
                        bot.processNewCandle(symbol, closed);
                    } catch (err) {
                        LOGGER.error(`[${symbol}] Trade execution error: ${err.message}`);
                        bot._forceReleaseTradeLock();
                    }
                }
            }
        }

        a.currentFormingCandle = incoming;

        const idx = a.candles.findIndex(c => c.open_time === incoming.open_time);
        if (idx >= 0) a.candles[idx] = incoming;
        else a.candles.push(incoming);

        if (a.candles.length > CONFIG.MAX_CANDLES_STORED) {
            a.candles = a.candles.slice(-CONFIG.MAX_CANDLES_STORED);
        }
    }

    handleCandlesHistory(r) {
        if (r.error) { LOGGER.error(`Candles error: ${r.error.message}`); return; }

        const symbol = r.echo_req?.ticks_history;
        if (!symbol || !state.assets[symbol]) return;

        const gran = CONFIG.GRANULARITY;
        const incomingCandles = (r.candles || []).map(c => ({
            open: parseFloat(c.open), high: parseFloat(c.high),
            low: parseFloat(c.low), close: parseFloat(c.close),
            epoch: c.epoch, open_time: Math.floor((c.epoch - gran) / gran) * gran,
        }));

        if (!incomingCandles.length) { LOGGER.warn(`[${symbol}] No candles received`); return; }

        const a = state.assets[symbol];

        const existingEpochs = new Set(a.closedCandles.map(c => c.open_time));
        let addedCount = 0;

        for (const c of incomingCandles) {
            if (!existingEpochs.has(c.open_time)) {
                a.closedCandles.push(c);
                existingEpochs.add(c.open_time);
                addedCount++;
            }
        }

        a.closedCandles.sort((x, y) => x.open_time - y.open_time);

        if (a.closedCandles.length > CONFIG.MAX_CANDLES_STORED) {
            a.closedCandles = a.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED);
        }

        a.candles = [...incomingCandles];
        a.currentFormingCandle = null;

        const lastCandle = incomingCandles[incomingCandles.length - 1];
        if (!a.lastProcessedCandleOpenTime || lastCandle.open_time > a.lastProcessedCandleOpenTime) {
            a.lastProcessedCandleOpenTime = lastCandle.open_time;
        }

        a.candlesLoaded = true;

        LOGGER.info(
            `[${symbol}] Loaded ${incomingCandles.length} ${CONFIG.TIMEFRAME_LABEL} candles (${addedCount} new merged, total: ${a.closedCandles.length})`
        );
    }

    onError(err) { LOGGER.error(`WebSocket error: ${err.message}`); }

    onClose() {
        LOGGER.warn('Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;
        this.stopPing();
        StatePersistence.saveState();

        if (this.isShuttingDown) return;
        if (this.isReconnecting) return;

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.isReconnecting = true;
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
            LOGGER.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})`);
            TelegramService.sendMessage(`⚠️ <b>RISE ALWAYS-CALL BOT CONNECTION LOST</b> — Reconnecting (attempt ${this.reconnectAttempts})`);

            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (this.isShuttingDown) return;
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached — giving up');
            TelegramService.sendMessage(`\u{1f6d1} <b>RISE ALWAYS-CALL BOT STOPPED</b> — Max reconnections\nTotal profit: $${(state.totalProfit || 0).toFixed(2)}`);
            process.exit(1);
        }
    }

    startPing() {
        this.stopPing();
        this.pingInterval = setInterval(() => {
            if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) this.send({ ping: 1 });
        }, 30000);
    }

    stopPing() {
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    }

    shutdown() {
        this.isShuttingDown = true;
        this.isReconnecting = false;
        this.cleanup();
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
// MAIN BOT CLASS — v1 RISE ALWAYS-CALL
// ============================================================
class IndexBot {

    constructor() {
        this.connection = new ConnectionManager();
        this._processedContracts = new Set();
        this._tradeLocked = false;
        this.tradeWatchdogMs = 150000;
        this.timeCheckStarted = false;
        this.sessionTimeCheckerId = null;
        this.statusDisplayIntervalId = null;

        this.contractCleanupInterval = setInterval(() => {
            if (this._processedContracts.size > 1000) {
                const entries = [...this._processedContracts];
                this._processedContracts = new Set(entries.slice(-100));
            }
        }, 1800000);
    }

    async start() {
        console.log('\n' + '═'.repeat(74));
        console.log(' DERIV RISE ALWAYS-CALL BOT v1.0 — R_50 Rise/Fall');
        console.log('═'.repeat(74));
        console.log(`Assets    : ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        console.log(`Timeframe : ${CONFIG.TIMEFRAME_LABEL} candles | Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT}`);
        console.log(`Entry     : ALWAYS CALLE (Rise)`);
        console.log(`Stake     : start $${CONFIG.INITIAL_STAKE.toFixed(2)} | win→reset $${CONFIG.WIN_AMOUNT.toFixed(2)} | loss→+|loss|×${CONFIG.LOSS_RECOVERY_MULTIPLIER}`);
        console.log(`Guards    : reset if |loss|≥$${CONFIG.MAX_LOSS_AMOUNT} | stop at +$${CONFIG.EXPECTED_PROFIT.toFixed(2)}`);
        console.log(`Balance   : $${(state.accountBalance || 0).toFixed(2)}`);
        console.log(`Sessions  : ${TradingSessionManager.getStatusString()}`);
        console.log('═'.repeat(74) + '\n');

        state.currentTradeDay = TradeHistoryManager.getDateKey();
        TradeHistoryManager.ensureDayEntry(state.currentTradeDay);
        this.connection.initializeAssets();

        CONFIG.ACTIVE_ASSETS.forEach(sym => this.subscribeToCandles(sym));

        await TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();
        this.startSessionTimeChecker();

        LOGGER.info('RISE ALWAYS-CALL BOT v1.0 fully started!');
    }

    subscribeToCandles(symbol) {
        if (this.connection.activeSubscriptions.has(symbol)) {
            LOGGER.debug(`Already subscribed to ${symbol}`);
            return;
        }

        LOGGER.info(`Subscribing to ${symbol} (${CONFIG.TIMEFRAME_LABEL})...`);

        this.connection.send({
            ticks_history: symbol, adjust_start_time: 1,
            count: CONFIG.CANDLES_TO_LOAD, end: 'latest', start: 1,
            style: 'candles', granularity: CONFIG.GRANULARITY,
        });

        this.connection.send({
            ticks_history: symbol, adjust_start_time: 1,
            count: 1, end: 'latest', start: 1,
            style: 'candles', granularity: CONFIG.GRANULARITY, subscribe: 1,
        });

        this.connection.activeSubscriptions.add(symbol);
    }

    // ════════════════════════════════════════════════════════
    // CORE TRADE LOGIC — on every candle close, buy CALL (Rise)
    // ════════════════════════════════════════════════════════
    processNewCandle(symbol, lastClosedCandle) {
        const a = state.assets[symbol];
        if (!a || !a.canTrade) return;
        if (!SessionManager.isSessionActive()) return;
        if (a.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) return;
        if (!state.isConnected || !state.isAuthorized) return;

        if (this._tradeLocked) {
            LOGGER.debug(`[${symbol}] Trade mutex locked — skipping`);
            return;
        }

        const totalPositions = CONFIG.ACTIVE_ASSETS.reduce(
            (sum, s) => sum + (state.assets[s]?.activePositions?.length ?? 0), 0
        );
        if (totalPositions >= CONFIG.MAX_TOTAL_POSITIONS) {
            LOGGER.debug(`[${symbol}] Max total positions (${totalPositions}/${CONFIG.MAX_TOTAL_POSITIONS})`);
            return;
        }

        if (CONFIG.USE_TRADING_SESSIONS) {
            const sessInfo = TradingSessionManager.isWithinAnySession();
            if (!sessInfo.inSession) {
                const now = Date.now();
                if (now - state.lastSessionLogTime > 300000) {
                    LOGGER.info(`${TradingSessionManager.getStatusString()} — holding new trades`);
                    state.lastSessionLogTime = now;
                }
                a.canTrade = false;
                return;
            }
        }

        if (a.closedCandles.length < CONFIG.MIN_CANDLES_REQUIRED) {
            LOGGER.debug(`[${symbol}] Not enough candles yet (${a.closedCandles.length}/${CONFIG.MIN_CANDLES_REQUIRED})`);
            a.canTrade = false;
            return;
        }

        let stake = a.currentStake;
        if (!(stake > 0)) {
            stake = CONFIG.INITIAL_STAKE;
            a.currentStake = stake;
        }

        // ── Always CALL (Rise) ──
        const direction = 'CALLE';

        LOGGER.signal(`[${symbol}] BUY SIGNAL — ALWAYS CALLE (Rise) | Stake: $${stake.toFixed(2)} | Cycle P/L: $${state.totalProfit.toFixed(2)}`);

        this._executeBuy(symbol, direction, stake, {
            method: 'RISE_ALWAYS_CALL',
            reason: 'Always buy CALL (Rise) — 30s contract',
        });
    }

    // ── Execute a buy order ────────────────────────────────
    _executeBuy(symbol, direction, stake, signalInfo = {}) {
        this._tradeLocked = true;
        state.assets[symbol].canTrade = false;

        const pos = {
            symbol, direction, stake,
            duration: CONFIG.DURATION,
            durationUnit: CONFIG.DURATION_UNIT,
            entryTime: Date.now(),
            contractId: null, reqId: null, currentProfit: 0, buyPrice: 0,
            signal: signalInfo,
        };

        state.assets[symbol].activePositions.push(pos);

        LOGGER.trade(
            `\u{1f3af} [${symbol}] ${direction === 'CALL' ? '\u{1f4c8} CALLE (Rise)' : '\u{1f4c9} PUTE (Fall)'} |` +
            `Stake: $${stake.toFixed(2)} | ${signalInfo.reason || ''}`
        );

        const reqId = this.connection.send({
            buy: 1, subscribe: 1, price: stake.toFixed(2),
            parameters: {
                contract_type: direction,
                [this.connection._isPat ? 'underlying_symbol' : 'symbol']: symbol,
                currency: 'USD', amount: stake.toFixed(2),
                duration: CONFIG.DURATION, duration_unit: CONFIG.DURATION_UNIT, basis: 'stake',
            },
        });

        pos.reqId = reqId;

        setTimeout(() => {
            if (this._tradeLocked && !pos.contractId) {
                LOGGER.warn(`[${symbol}] Buy response timeout — releasing lock`);
                const idx = state.assets[symbol].activePositions.indexOf(pos);
                if (idx >= 0) state.assets[symbol].activePositions.splice(idx, 1);
                this._tradeLocked = false;
            }
        }, 5000);

        StatePersistence.saveState();
    }

    // ── WATCHDOG ────────────────────────────────────────────
    _startTradeWatchdog(contractId) {
        this._clearAllWatchdogTimers();

        state.tradeWatchdogTimer = setTimeout(() => {
            if (!state.currentContractId) return;

            LOGGER.warn(`WATCHDOG fired for contract ${contractId}`);

            if (state.isConnected && state.isAuthorized) {
                this.connection.send({ forget_all: 'proposal_open_contract' });
                this.connection.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });

                state.tradeWatchdogPollTimer = setTimeout(() => {
                    if (!state.currentContractId) return;
                    LOGGER.error(`WATCHDOG: Poll timeout — forcing recovery`);
                    this._recoverStuckTrade('watchdog-timeout');
                }, 30000);
            } else {
                this._recoverStuckTrade('watchdog-offline');
            }
        }, this.tradeWatchdogMs);
    }

    _clearAllWatchdogTimers() {
        if (state.tradeWatchdogTimer) { clearTimeout(state.tradeWatchdogTimer); state.tradeWatchdogTimer = null; }
        if (state.tradeWatchdogPollTimer) { clearTimeout(state.tradeWatchdogPollTimer); state.tradeWatchdogPollTimer = null; }
    }

    _forceReleaseTradeLock() {
        this._clearAllWatchdogTimers();
        this._tradeLocked = false;
        state.currentContractId = null;
        state.tradeStartTime = null;
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) a.canTrade = true;
        });
        LOGGER.warn('Trade lock force-released');
    }

    _recoverStuckTrade(reason) {
        LOGGER.warn(`Stuck trade recovery: ${reason}`);
        this._clearAllWatchdogTimers();

        const contractId = state.currentContractId;
        if (contractId) this._processedContracts.add(String(contractId));

        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a?.activePositions) {
                const i = a.activePositions.findIndex(p => p.contractId === contractId);
                if (i >= 0) { a.activePositions.splice(i, 1); LOGGER.info(`Removed stuck position from ${sym}`); }
            }
        });

        this._tradeLocked = false;
        state.currentContractId = null;
        state.tradeStartTime = null;

        TelegramService.sendMessage(
            `⚠️ <b>RISE ALWAYS-CALL BOT STUCK TRADE RECOVERED [${reason}]</b>\n` +
            `Contract: ${contractId}\n` +
            `⚠️ VERIFY OUTCOME MANUALLY ON DERIV\n` +
            `Balance: $${(state.accountBalance || 0).toFixed(2)}`
        );

        StatePersistence.saveState();
    }

    stop() {
        LOGGER.info('Stopping bot...');
        CONFIG.ACTIVE_ASSETS.forEach(sym => { if (state.assets[sym]) state.assets[sym].canTrade = false; });
        TelegramService.clearTimers();
        this._clearAllWatchdogTimers();
        if (this.statusDisplayIntervalId) clearInterval(this.statusDisplayIntervalId);
        if (this.sessionTimeCheckerId) clearInterval(this.sessionTimeCheckerId);
        if (this.contractCleanupInterval) clearInterval(this.contractCleanupInterval);
        StatePersistence.saveState();
        TradeHistoryManager.saveHistory();
        setTimeout(() => { this.connection.cleanup(); LOGGER.info('Bot stopped'); }, 2000);
    }

    startSessionTimeChecker() {
        if (this.timeCheckStarted) return;
        this.timeCheckStarted = true;
        this.sessionTimeCheckerId = setInterval(() => SessionManager.checkDayChange(), 60000);
    }

    getStatus() {
        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();

        const pairStatuses = {};
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                pairStatuses[sym] = {
                    currentStake: a.currentStake,
                    activePositions: a.activePositions.length,
                    trades: a.tradesCount, wins: a.winsCount, losses: a.lossesCount, netPL: a.netPL,
                    consecutiveWins: a.consecutiveWins,
                    consecutiveLosses: a.consecutiveLosses,
                };
            }
        });

        return {
            connected: state.isConnected, authorized: state.isAuthorized,
            accountBalance: state.accountBalance,
            totalProfit: state.totalProfit,
            profitTargetReached: state.profitTargetReached,
            session: SessionManager.getSessionStats(),
            totalPositions: CONFIG.ACTIVE_ASSETS.reduce((s, sym) => s + (state.assets[sym]?.activePositions?.length ?? 0), 0),
            pairs: pairStatuses, overall, today,
        };
    }
}

// ============================================================
// INITIALIZATION
// ============================================================
tradeHistory = TradeHistoryManager.loadHistory();
const bot = new IndexBot();

process.on('SIGINT', () => { bot.stop(); bot.connection.shutdown(); setTimeout(() => process.exit(0), 3000); });
process.on('SIGTERM', () => { bot.stop(); bot.connection.shutdown(); setTimeout(() => process.exit(0), 3000); });
process.on('uncaughtException', (err) => { LOGGER.error(`UNCAUGHT: ${err.message}\n${err.stack}`); try { StatePersistence.saveState(); } catch { } });
process.on('unhandledRejection', (reason) => { LOGGER.error(`UNHANDLED: ${reason}`); try { StatePersistence.saveState(); } catch { } });

const stateLoaded = StatePersistence.loadState();
LOGGER.info(stateLoaded ? 'Resuming from saved state' : 'Starting fresh session');

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.error('\n⚠️  Set CONFIG.API_TOKEN before running!\n');
    process.exit(1);
}

console.log('\n\u{1f680} Starting RISE ALWAYS-CALL BOT v1.0...\n');
bot.connection.connect();

// ── Status display every 60s ──────────────────────────────────
const statusInterval = setInterval(() => {
    if (!state.isAuthorized) return;

    const status = bot.getStatus();

    if (state.currentContractId && state.tradeStartTime) {
        const elapsed = Date.now() - state.tradeStartTime;
        if (elapsed > 420000) {
            LOGGER.error(`SAFETY: Trade stuck ${Math.round(elapsed / 1000)}s — forcing recovery`);
            bot._recoverStuckTrade('safety-timeout');
        }
    }

    if (bot._tradeLocked && status.totalPositions === 0) {
        LOGGER.warn('Trade lock stuck with no open positions — auto-releasing');
        bot._tradeLocked = false;
    }

    let pairLines = '';
    CONFIG.ACTIVE_ASSETS.forEach(sym => {
        const p = status.pairs[sym];
        if (p) {
            pairLines += `\n  ${sym}: Stake $${(p.currentStake || 0).toFixed(2)} | ${p.trades}t ${p.wins}W/${p.losses}L $${(p.netPL || 0).toFixed(2)} | Pos:${p.activePositions} | Wstreak:${p.consecutiveWins} Lstreak:${p.consecutiveLosses}`;
        }
    });

    console.log(`\n\u{1f4ca} ${getGMTTime()} | Total profit: $${status.totalProfit.toFixed(2)} / $${CONFIG.EXPECTED_PROFIT}${status.profitTargetReached ? ' 🏁 DONE' : ''} | Balance: $${(status.accountBalance || 0).toFixed(2)}`);
    console.log(`\u{1f4cb} Overall: ${status.overall.tradesCount}t | P/L: $${(status.overall.netPL || 0).toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
    console.log(`\u{1f555} ${TradingSessionManager.getStatusString()}`);
    console.log(`\u{1f4c8} Assets:${pairLines}`);

}, 60000);

bot.statusDisplayIntervalId = statusInterval;
