'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║      DERIV SYNTHETIC INDICES CALLE/PUTE BOT  —  v4.0  "WILL"           ║
 * ║      Williams %R Breakout + Normal Trading Mode                         ║
 * ║                                                                          ║
 * ║  STRATEGY:                                                               ║
 * ║  ────────────────────────────────────────────────────────────────────── ║
 * ║  1. WPR (Williams Percent Range) detects momentum shifts:               ║
 * ║     · BUY:  WPR crosses above -20 (must have visited -80 first)        ║
 * ║     · SELL: WPR crosses below -80 (must have visited -20 first)        ║
 * ║                                                                          ║
 * ║  2. When WPR signal fires → set breakout levels (prev candle H/L)      ║
 * ║     and execute first trade in breakout direction.                      ║
 * ║                                                                          ║
 * ║  3. NORMAL MODE: After breakout levels set, trade on every candle close ║
 * ║     · Bullish candle (close > open) → CALLE                             ║
 * ║     · Bearish candle (close < open) → PUTE                              ║
 * ║     · Continues for MAX_TRADES_PER_CYCLE trades (default 20)           ║
 * ║     · After cycle completes → wait for new WPR signal                   ║
 * ║                                                                          ║
 * ║  4. RECOVERY MODE (retained from v3 DARE):                              ║
 * ║     · After loss → force opposite direction with increased stake        ║
 * ║     · Capped recovery steps, no martingale ladder                       ║
 * ║     · Recovery trades do NOT count toward normal mode trade count      ║
 * ║                                                                          ║
 * ║  RETAINED FROM v3:                                                       ║
 * ║    RestClient, PAT/legacy auth, ConnectionManager, watchdog,            ║
 * ║    persistence, trade-history, SessionManager, recovery logic.          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */
const WebSocket = require('ws');
const https     = require('https');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const { URL }   = require('url');
// ══════════════════════════════════════════════════════════════════════════════
// DERIV REST CLIENT  (for the PAT / OAuth OTP-based auth flow)  [RETAINED]
// ══════════════════════════════════════════════════════════════════════════════
class RestClient {
    constructor(baseUrl, appId, token) {
        this.baseUrl = baseUrl || 'https://api.derivws.com';
        this.appId   = appId   || '1089';
        this.token   = token   || '';
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
                    try { parsed = JSON.parse(data); } catch (_) {}
                    resolve({ status: res.statusCode, body: parsed });
                });
            });
            req.on('timeout', () => { req.destroy(new Error('REST request timeout')); });
            req.on('error', reject);
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }
    get(p)     { return this._request('GET',  p); }
    post(p, b) { return this._request('POST', p, b); }
    delete(p)  { return this._request('DELETE', p); }
}
// ============================================================
// FILE PATHS  [RETAINED]
// ============================================================
const STATE_FILE          = path.join(__dirname, 'will4_03-state.json');
const HISTORY_FILE        = path.join(__dirname, 'will4_03-history.json');
const STATE_SAVE_INTERVAL = 5000;  // ms
// ============================================================
// LOGGER  [RETAINED + WPR/breakout loggers]
// ============================================================
const getGMTTime = () =>
    new Date().toISOString().replace('T', ' ').split('.')[0] + ' GMT';
const LOGGER = {
    info:     (msg) => console.log(`[INFO]  ${getGMTTime()} - ${msg}`),
    trade:    (msg) => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn:     (msg) => console.warn(`\x1b[33m[WARN]  ${getGMTTime()} - ${msg}\x1b[0m`),
    error:    (msg) => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug:    (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); },
    signal:   (msg) => console.log(`\x1b[36m[SIGNAL]${getGMTTime()} - ${msg}\x1b[0m`),
    wpr:      (msg) => console.log(`\x1b[34m[WPR]   ${getGMTTime()} - ${msg}\x1b[0m`),
    breakout: (msg) => console.log(`\x1b[35m[BREAK]  ${getGMTTime()} - ${msg}\x1b[0m`),
    normal:   (msg) => console.log(`\x1b[93m[NORM]   ${getGMTTime()} - ${msg}\x1b[0m`),
    recovery: (msg) => console.log(`\x1b[33m[RECOV]  ${getGMTTime()} - ${msg}\x1b[0m`),
    candle:   (msg) => console.log(`\x1b[95m[CANDLE] ${getGMTTime()} - ${msg}\x1b[0m`),
};
// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
    // ── Deriv API [RETAINED credentials] ─────────────────────
    // API_TOKEN:    '0P94g4WdSrSrzir',
    // APP_ID:       '1089',
    // ACCOUNT_TYPE: 'demo',
    API_TOKEN:    'pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee',
    APP_ID:       '33uslPtthXBEkQOdfKfoY',
    ACCOUNT_TYPE: 'demo',          // 'demo' | 'real' (PAT mode only)
    WS_URL:       'wss://ws.derivws.com/websockets/v3',
    // ── Capital & Risk [RETAINED] ────────────────────────────
    INITIAL_CAPITAL:            100,
    BASE_RISK_PERCENT_PER_TRADE: 0.01,
    MIN_STAKE:                  5,
    MAX_STAKE:                  80,
    MAX_RISK_PCT:               135.00,
    // ── Single capped recoup step (NOT martingale) [RETAINED] ─
    RECOVERY_ENABLED:       true,
    RECOVERY_MULTIPLIER:    2.00,
    MAX_RECOVERY_STEPS:     6,
    MAX_RECOVERY_STAKE_PCT: 80.0,
    // ── Session / daily guards [RETAINED] ───────────────────
    SESSION_PROFIT_TARGET:      500000,
    SESSION_STOP_LOSS:          -15000,
    DAILY_STOP_LOSS:            -2000,
    MAX_CONSECUTIVE_LOSSES:     5,
    COOLDOWN_CANDLES:           5,
    // ── Candle / Contract Settings [RETAINED] ────────────────
    GRANULARITY:                300,     // 5-minute candles
    TIMEFRAME_LABEL:            '5m',
    CANDLES_TO_LOAD:            200,
    MAX_CANDLES_STORED:         300,
    DURATION:                   294,
    DURATION_UNIT:              's',
    MIN_CANDLES_REQUIRED:       82,      // WPR_PERIOD (80) + 2 minimum
    // ── WPR (Williams Percent Range) Settings ───────────────
    WPR_PERIOD:                 80,      // Lookback period for WPR
    WPR_OVERBOUGHT:             -20,     // WPR > -20 = overbought (SELL signal prep)
    WPR_OVERSOLD:               -80,     // WPR < -80 = oversold (BUY signal prep)
    // ── Normal Trading Mode ─────────────────────────────────
    MAX_TRADES_PER_CYCLE:       5,      // Trade N candles in breakout direction
    // ── Trading Sessions (synthetics trade 24/7) ─────────────
    USE_TRADING_SESSIONS:       false,
    SESSIONS: [
        { name: 'LONDON_OPEN', start: 2,  end: 17 },
        { name: 'NY_OPEN',     start: 12, end: 22 },
    ],
    // ── Position Management ───────────────────────────────────
    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    MAX_TOTAL_POSITIONS:          6,
    // ── Active Index Assets ───────────────────────────────────
    ACTIVE_ASSETS: [
        'R_75'
        // 'stpRNG', 'stpRNG2', 'stpRNG3', 'stpRNG4', 'stpRNG5',
        // 'R_10', 'R_25', 'R_75', 'R_50', 'R_100',
        // '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V',
    ],
    // ── Misc ──────────────────────────────────────────────────
    DEBUG_MODE:                 true,
    TELEGRAM_ENABLED:           true,
    TELEGRAM_BOT_TOKEN: '8565754902:AAHS6UQWEgLJ0DO-JTpAGQhZLs-UDVVNAQc',
    TELEGRAM_CHAT_ID: '752497117',
};
// ============================================================
// TECHNICAL INDICATORS — WPR ONLY (from cluadeWill.js)
// ============================================================
class TechnicalIndicators {
    /**
     * Calculate Williams Percent Range (WPR)
     * Formula: WPR = ((Highest High - Close) / (Highest High - Lowest Low)) * -100
     * @param {Array} candles - Array of closed candle objects
     * @param {number} period - Lookback period (default: 80)
     * @returns {number} WPR value between -100 and 0
     */
    static calculateWPR(candles, period = 80) {
        if (!candles || !Array.isArray(candles)) {
            LOGGER.error('WPR Error: Invalid candles array');
            return -50;
        }
        if (candles.length < period) {
            LOGGER.debug(`WPR Warning: Not enough candles (${candles.length}/${period})`);
            return -50;
        }
        try {
            const recentCandles = candles.slice(-period);
            const validCandles = recentCandles.filter(c =>
                c && typeof c.high === 'number' && typeof c.low === 'number' &&
                typeof c.close === 'number' && !isNaN(c.high) && !isNaN(c.low) &&
                !isNaN(c.close) && c.high >= c.low
            );
            if (validCandles.length < period) {
                LOGGER.warn(`WPR Warning: Invalid candle data (${validCandles.length}/${period} valid)`);
                return -50;
            }
            const highs = validCandles.map(c => parseFloat(c.high));
            const lows  = validCandles.map(c => parseFloat(c.low));
            const close = parseFloat(validCandles[validCandles.length - 1].close);
            const highestHigh = Math.max(...highs);
            const lowestLow   = Math.min(...lows);
            const range = highestHigh - lowestLow;
            if (range === 0 || !isFinite(range)) return -50;
            const wpr = ((highestHigh - close) / range) * -100;
            if (wpr < -100 || wpr > 0 || !isFinite(wpr)) return -50;
            return wpr;
        } catch (error) {
            LOGGER.error(`WPR Calculation Exception: ${error.message}`);
            return -50;
        }
    }
    /**
     * Alternative WPR for cross-validation
     */
    static calculateWPR_TaLib(candles, period = 80) {
        if (!candles || candles.length < period) return -50;
        try {
            const slice = candles.slice(-period);
            let highestHigh = -Infinity, lowestLow = Infinity;
            for (let i = 0; i < slice.length; i++) {
                if (slice[i].high > highestHigh) highestHigh = slice[i].high;
                if (slice[i].low < lowestLow) lowestLow = slice[i].low;
            }
            const currentClose = slice[slice.length - 1].close;
            const denominator = highestHigh - lowestLow;
            if (denominator === 0) return -50;
            return Math.max(-100, Math.min(0, -100 * ((highestHigh - currentClose) / denominator)));
        } catch (error) {
            LOGGER.error(`WPR_TaLib Error: ${error.message}`);
            return -50;
        }
    }
    static verifyWPRCalculation(candles, period = 80) {
        const wpr1 = this.calculateWPR(candles, period);
        const wpr2 = this.calculateWPR_TaLib(candles, period);
        return Math.abs(wpr1 - wpr2) <= 0.5;
    }
}
// ============================================================
// SIGNAL MANAGER — WPR-based signal detection
// ============================================================
class SignalManager {
    /**
     * Update WPR state and check for flag activations
     */
    static updateWPRState(symbol) {
        const assetState = state.assets[symbol];
        const wpr    = assetState.wpr;
        const prevWpr = assetState.prevWpr;
        // BUY flag activates when WPR goes below -80 (enters oversold)
        if (wpr < CONFIG.WPR_OVERSOLD && !assetState.buyFlagActive) {
            assetState.buyFlagActive = true;
            LOGGER.wpr(`${symbol}: BUY FLAG ACTIVATED — WPR entered oversold (${wpr.toFixed(2)})`);
        }
        // SELL flag activates when WPR goes above -20 (enters overbought)
        if (wpr > CONFIG.WPR_OVERBOUGHT && !assetState.sellFlagActive) {
            assetState.sellFlagActive = true;
            LOGGER.wpr(`${symbol}: SELL FLAG ACTIVATED — WPR entered overbought (${wpr.toFixed(2)})`);
        }
    }
    /**
     * Check for BUY signal — WPR crosses above -20
     */
    static checkBuySignal(symbol) {
        const assetState = state.assets[symbol];
        const wpr    = assetState.wpr;
        const prevWpr = assetState.prevWpr;
        const isCrossingAbove = (prevWpr <= CONFIG.WPR_OVERBOUGHT) && (wpr > CONFIG.WPR_OVERBOUGHT);
        if (isCrossingAbove && assetState.buyFlagActive) {
            if (!assetState.breakout.active ||
                assetState.breakout.type === 'SELL' ||
                assetState.breakout.canBeReplaced) {
                LOGGER.signal(`${symbol} BUY SIGNAL TRIGGERED! WPR: ${wpr.toFixed(2)} (from ${prevWpr.toFixed(2)})`);
                return true;
            } else {
                LOGGER.debug(`${symbol}: BUY signal ignored — active BUY breakout exists`);
            }
        }
        return false;
    }
    /**
     * Check for SELL signal — WPR crosses below -80
     */
    static checkSellSignal(symbol) {
        const assetState = state.assets[symbol];
        const wpr    = assetState.wpr;
        const prevWpr = assetState.prevWpr;
        const isCrossingBelow = (prevWpr >= CONFIG.WPR_OVERSOLD) && (wpr < CONFIG.WPR_OVERSOLD);
        if (isCrossingBelow && assetState.sellFlagActive) {
            if (!assetState.breakout.active ||
                assetState.breakout.type === 'BUY' ||
                assetState.breakout.canBeReplaced) {
                LOGGER.signal(`${symbol} SELL SIGNAL TRIGGERED! WPR: ${wpr.toFixed(2)} (from ${prevWpr.toFixed(2)})`);
                return true;
            } else {
                LOGGER.debug(`${symbol}: SELL signal ignored — active SELL breakout exists`);
            }
        }
        return false;
    }
}
// ============================================================
// BREAKOUT MANAGER — Persistent breakout levels
// ============================================================
class BreakoutManager {
    /**
     * Set breakout levels using the PREVIOUS candle
     */
    static setupBreakoutLevels(symbol, direction, breakoutType) {
        const assetState   = state.assets[symbol];
        const closedCandles = assetState.closedCandles;
        if (closedCandles.length < 1) {
            LOGGER.warn(`${symbol}: Not enough closed candles for breakout setup`);
            return false;
        }
        const previousCandle = closedCandles[closedCandles.length - 1];
        assetState.breakout = {
            active: true,
            type: breakoutType,
            highLevel: previousCandle.high,
            lowLevel: previousCandle.low,
            triggerCandle: previousCandle.epoch,
            canBeReplaced: false,
        };
        assetState.inTradeCycle = true;
        assetState.waitingForReentry = false;
        // Reset opposite flag
        if (breakoutType === 'BUY') {
            assetState.sellFlagActive = false;
        } else if (breakoutType === 'SELL') {
            assetState.buyFlagActive = false;
        }
        LOGGER.breakout(`${symbol} ${breakoutType} BREAKOUT LEVELS SET:`);
        LOGGER.breakout(`  High: ${previousCandle.high.toFixed(5)} | Low: ${previousCandle.low.toFixed(5)}`);
        return true;
    }
    /**
     * Replace breakout levels with new opposite type
     */
    static replaceBreakoutLevels(symbol, direction, newType) {
        const assetState   = state.assets[symbol];
        const closedCandles = assetState.closedCandles;
        if (closedCandles.length < 1) return false;
        const previousCandle = closedCandles[closedCandles.length - 1];
        LOGGER.breakout(`${symbol} REPLACING ${assetState.breakout.type} breakout with ${newType}`);
        assetState.breakout = {
            active: true,
            type: newType,
            highLevel: previousCandle.high,
            lowLevel: previousCandle.low,
            triggerCandle: previousCandle.epoch,
            canBeReplaced: false,
        };
        if (newType === 'BUY') assetState.sellFlagActive = false;
        else if (newType === 'SELL') assetState.buyFlagActive = false;
        return true;
    }
    /**
     * Check for breakout replacement during active trade
     */
    static checkForBreakoutReplacement(symbol) {
        const assetState = state.assets[symbol];
        const wpr    = assetState.wpr;
        const prevWpr = assetState.prevWpr;
        const breakout = assetState.breakout;
        if (!breakout.active || !assetState.inTradeCycle) return null;
        if (breakout.type === 'BUY') {
            const isCrossingBelow = (prevWpr >= CONFIG.WPR_OVERSOLD) && (wpr < CONFIG.WPR_OVERSOLD);
            if (isCrossingBelow && assetState.sellFlagActive) {
                LOGGER.signal(`${symbol} NEW SELL BREAKOUT during BUY cycle`);
                this.replaceBreakoutLevels(symbol, 'DOWN', 'SELL');
                assetState.sellFlagActive = false;
                if (assetState.currentDirection === 'CALLE') return 'PUTE';
            }
        }
        if (breakout.type === 'SELL') {
            const isCrossingAbove = (prevWpr <= CONFIG.WPR_OVERBOUGHT) && (wpr > CONFIG.WPR_OVERBOUGHT);
            if (isCrossingAbove && assetState.buyFlagActive) {
                LOGGER.signal(`${symbol} NEW BUY BREAKOUT during SELL cycle`);
                this.replaceBreakoutLevels(symbol, 'UP', 'BUY');
                assetState.buyFlagActive = false;
                if (assetState.currentDirection === 'PUTE') return 'CALLE';
            }
        }
        return null;
    }
    /**
     * Mark breakout as allowing re-entry
     */
    static setWaitingForReentry(symbol) {
        const assetState = state.assets[symbol];
        assetState.inTradeCycle = false;
        assetState.waitingForReentry = true;
        assetState.lastTradeDirection = assetState.currentDirection;
        assetState.breakout.canBeReplaced = true;
        LOGGER.breakout(`${symbol} TP REACHED — breakout levels active, waiting for re-entry`);
    }
    /**
     * Fully clear breakout setup
     */
    static clearBreakout(symbol) {
        const assetState = state.assets[symbol];
        LOGGER.breakout(`${symbol} BREAKOUT LEVELS CLEARED`);
        assetState.breakout = {
            active: false, type: null, highLevel: 0, lowLevel: 0,
            triggerCandle: 0, canBeReplaced: true,
        };
        assetState.inTradeCycle = false;
        assetState.waitingForReentry = false;
        assetState.priceReturnedToZone = false;
        // Also end normal mode
        assetState.normalModeActive = false;
        assetState.tradesInNormalMode = 0;
        assetState.normalModeDirection = null;
    }
}
// ============================================================
// STAKE CALCULATOR — Kelly-fractional + single capped recoup  [RETAINED]
// ============================================================
class StakeCalculator {
    static calculate(capital, recoveryStep = 0, pWin = null) {
        const b = 0.90;
        const p = pWin && pWin > 0.5 ? pWin : 0.54;
        let stake;
        if (!CONFIG.RECOVERY_ENABLED || recoveryStep <= 0) {
            const kelly = b > 0 ? (p * b - (1 - p)) / b : 0;
            const frac  = Math.max(0, Math.min(0.5, kelly * 0.5));
            const riskCapital = capital * (CONFIG.BASE_RISK_PERCENT_PER_TRADE / 100);
            stake = riskCapital * (0.5 + frac);
        } else if (recoveryStep >= 1) {
            stake = CONFIG.MIN_STAKE * Math.pow(CONFIG.RECOVERY_MULTIPLIER, recoveryStep);
        } else {
            const riskCapital = capital * (CONFIG.BASE_RISK_PERCENT_PER_TRADE / 100);
            stake = riskCapital;
        }
        const maxRisk = capital * (CONFIG.MAX_RISK_PCT / 100);
        stake = Math.min(stake, maxRisk, CONFIG.MAX_STAKE);
        if (recoveryStep >= 1) {
            const maxRecoup = capital * (CONFIG.MAX_RECOVERY_STAKE_PCT / 100);
            stake = Math.min(stake, maxRecoup);
        }
        stake = Math.max(CONFIG.MIN_STAKE, stake);
        return parseFloat(stake.toFixed(2));
    }
    static describe(capital, recoveryStep, pWin) {
        const stake = this.calculate(capital, recoveryStep, pWin);
        const pct = ((stake / capital) * 100).toFixed(2);
        return `$${stake.toFixed(2)} (${pct}% capital, recovery step ${recoveryStep})`;
    }
}
// ============================================================
// TRADING SESSION MANAGER  [RETAINED]
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
    static getSessionInfo() {
        if (!CONFIG.USE_TRADING_SESSIONS) {
            return { activeSessions: ['24/7_SYNTHETIC'], inSession: true, inOverlap: false, gmtHour: this.getCurrentUTCHour() };
        }
        const hour   = this.getCurrentUTCHour();
        const active = CONFIG.SESSIONS.filter(s => this._inSession(hour, s.start, s.end));
        return { activeSessions: active.map(s => s.name), inSession: active.length > 0, inOverlap: active.length >= 2, gmtHour: hour };
    }
    static getStatusString() {
        const info = this.getSessionInfo();
        const time = `${String(new Date().getUTCHours()).padStart(2,'0')}:${String(new Date().getUTCMinutes()).padStart(2,'0')} UTC`;
        if (!CONFIG.USE_TRADING_SESSIONS) return `\u{1f7e2} SYNTHETIC 24/7 MODE (${time})`;
        if (!info.inSession) return `\u{1f534} OUTSIDE SESSIONS (${time})`;
        return `\u{1f7e2} ${info.activeSessions.join('+')} (${time})${info.inOverlap ? ' \u{1f525} OVERLAP' : ''}`;
    }
}
// ============================================================
// TRADE HISTORY MANAGER  [RETAINED]
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
                profit: 0, loss: 0, netPL: 0, assets: {}, startCapital: state.capital, endCapital: state.capital,
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
    static recordTrade(symbol, profit, recoveryStep) {
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
            if (profit > 0) { t.winsCount++;  t.profit += profit;           t.netPL += profit; }
            else            { t.lossesCount++; t.loss += Math.abs(profit);   t.netPL += profit; }
        });
        if (!tradeHistory.overall.firstTradeDate) tradeHistory.overall.firstTradeDate = dateKey;
        tradeHistory.overall.lastTradeDate = dateKey;
        tradeHistory.dailyHistory[dateKey].endCapital = state.capital;
        tradeHistory.lastUpdated = Date.now();
        this.saveHistory();
    }
    static getDayStats(dateKey) { this.ensureDayEntry(dateKey); return tradeHistory.dailyHistory[dateKey]; }
    static getTodayStats()      { return this.getDayStats(this.getDateKey()); }
    static getOverallStats()    { return tradeHistory.overall; }
    static getAllDays()         { return Object.keys(tradeHistory.dailyHistory).sort(); }
    static getRecentDays(n = 7) { return this.getAllDays().slice(-n).map(d => ({ date: d, ...tradeHistory.dailyHistory[d] })); }
}
// ============================================================
// STATE PERSISTENCE  [MODIFIED for WPR + normal mode]
// ============================================================
class StatePersistence {
    static saveState() {
        try {
            const data = {
                savedAt: Date.now(), capital: state.capital,
                session: { ...state.session }, portfolio: { ...state.portfolio },
                hourlyStats: { ...state.hourlyStats }, currentTradeDay: state.currentTradeDay, assets: {},
            };
            Object.keys(state.assets).forEach(symbol => {
                const a = state.assets[symbol];
                data.assets[symbol] = {
                    closedCandles:               a.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED),
                    lastProcessedCandleOpenTime: a.lastProcessedCandleOpenTime,
                    candlesLoaded:               a.candlesLoaded,
                    lastTradeDirection:          a.lastTradeDirection,
                    lastTradeWasWin:             a.lastTradeWasWin,
                    forceRecoverDirection:       a.forceRecoverDirection,
                    recoveryStep:                a.recoveryStep,
                    currentStake:                a.currentStake,
                    consecutiveWins:             a.consecutiveWins,
                    consecutiveLosses:           a.consecutiveLosses,
                    cooldownCandles:             a.cooldownCandles,
                    // WPR state
                    wpr:              a.wpr,
                    prevWpr:          a.prevWpr,
                    buyFlagActive:    a.buyFlagActive,
                    sellFlagActive:   a.sellFlagActive,
                    breakout:         { ...a.breakout },
                    inTradeCycle:     a.inTradeCycle,
                    waitingForReentry: a.waitingForReentry,
                    priceReturnedToZone: a.priceReturnedToZone,
                    currentDirection:  a.currentDirection,
                    // Normal mode state
                    normalModeActive:     a.normalModeActive,
                    tradesInNormalMode:   a.tradesInNormalMode,
                    normalModeDirection:  a.normalModeDirection,
                    // Stats
                    tradesCount:  a.tradesCount,  winsCount:    a.winsCount,
                    lossesCount:  a.lossesCount,  netPL:        a.netPL,
                    profit:       a.profit,        loss:         a.loss,
                    activePositions: a.activePositions.map(p => ({ ...p })),
                };
            });
            fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
        } catch (e) { LOGGER.error(`Save state error: ${e.message}`); }
    }
    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) return false;
            const data    = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMins = (Date.now() - data.savedAt) / 60000;
            if (ageMins > 120) {
                LOGGER.warn(`State is ${ageMins.toFixed(1)}min old — starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }
            LOGGER.info(`Restoring state from ${ageMins.toFixed(1)} minutes ago`);
            state.capital         = data.capital;
            state.session         = { ...state.session, ...data.session };
            state.portfolio       = { ...state.portfolio, ...data.portfolio };
            state.hourlyStats     = data.hourlyStats || state.hourlyStats;
            state.currentTradeDay = data.currentTradeDay || TradeHistoryManager.getDateKey();
            if (data.assets) {
                Object.keys(data.assets).forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = data.assets[symbol];
                        const a     = state.assets[symbol];
                        if (saved.closedCandles?.length) a.closedCandles = saved.closedCandles;
                        a.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                        a.candlesLoaded               = false;
                        a.lastTradeDirection          = saved.lastTradeDirection  || null;
                        a.lastTradeWasWin             = saved.lastTradeWasWin     ?? null;
                        a.forceRecoverDirection       = saved.forceRecoverDirection ?? null;
                        a.recoveryStep                = saved.recoveryStep        || 0;
                        a.currentStake                = saved.currentStake        || StakeCalculator.calculate(state.capital);
                        a.consecutiveWins             = saved.consecutiveWins     || 0;
                        a.consecutiveLosses           = saved.consecutiveLosses   || 0;
                        a.cooldownCandles             = saved.cooldownCandles      || 0;
                        // WPR state
                        a.wpr              = saved.wpr              || -50;
                        a.prevWpr          = saved.prevWpr          || -50;
                        a.buyFlagActive    = saved.buyFlagActive    || false;
                        a.sellFlagActive   = saved.sellFlagActive   || false;
                        a.breakout         = saved.breakout         || { active: false, type: null, highLevel: 0, lowLevel: 0, triggerCandle: 0, canBeReplaced: true };
                        a.inTradeCycle     = saved.inTradeCycle     || false;
                        a.waitingForReentry = saved.waitingForReentry || false;
                        a.priceReturnedToZone = saved.priceReturnedToZone || false;
                        a.currentDirection  = saved.currentDirection  || null;
                        // Normal mode state
                        a.normalModeActive     = saved.normalModeActive     || false;
                        a.tradesInNormalMode   = saved.tradesInNormalMode   || 0;
                        a.normalModeDirection  = saved.normalModeDirection  || null;
                        // Stats
                        a.tradesCount = saved.tradesCount || 0;
                        a.winsCount   = saved.winsCount   || 0;
                        a.lossesCount = saved.lossesCount || 0;
                        a.netPL       = saved.netPL       || 0;
                        a.profit      = saved.profit      || 0;
                        a.loss        = saved.loss        || 0;
                        a.activePositions = (saved.activePositions || []).map(p => ({ ...p }));
                        LOGGER.info(`  ${symbol}: Rec=${a.recoveryStep} Stake=$${(a.currentStake || 0).toFixed(2)} P/L=$${(a.netPL || 0).toFixed(2)} WPR:${a.wpr.toFixed(1)} Normal:${a.normalModeActive ? a.tradesInNormalMode + '/' + CONFIG.MAX_TRADES_PER_CYCLE : 'off'}`);
                    }
                });
            }
            LOGGER.info(`State restored | Capital: $${state.capital.toFixed(2)}`);
            return true;
        } catch (e) { LOGGER.error(`Load state error: ${e.message}`); return false; }
    }
    static startAutoSave() {
        setInterval(() => { if (state.isAuthorized) this.saveState(); }, STATE_SAVE_INTERVAL);
        LOGGER.info(`Auto-save every ${STATE_SAVE_INTERVAL / 1000}s`);
    }
}
// ============================================================
// TELEGRAM SERVICE  [MODIFIED for WPR display]
// ============================================================
class TelegramService {
    static hourlyTimerStarted = false;
    static dailyTimerStarted  = false;
    static hourlyTimerId      = null;
    static dailyTimerId       = null;
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
    static async sendTradeAlert(type, symbol, direction, stake, duration, durationUnit, details = {}) {
        const emoji   = type === 'OPEN' ? '\u{1f680}' : type === 'WIN' ? '✅' : '❌';
        const a       = state.assets[symbol];
        const overall = TradeHistoryManager.getOverallStats();
        const today   = TradeHistoryManager.getTodayStats();
        const lines   = [
            `${emoji} <b>WILL BOT v4.0 — ${type}</b>`,
            `Pair: <b>${symbol}</b>  Direction: <b>${direction === 'CALLE' ? '\u{1f4c8} CALLE' : '\u{1f4c9} PUTE'}</b>`,
            `Stake: $${stake.toFixed(2)} | Duration: ${duration}${(durationUnit || 's').toUpperCase()}`,
            `Recovery Step: ${a?.recoveryStep ?? 0} | ${TradingSessionManager.getStatusString()}`,
            ``,
        ];
        if (type === 'OPEN' && details.signal) {
            const sig = details.signal;
            lines.push(`\u{1f9e0} <b>Signal:</b> ${sig.method || 'WPR'}`);
            lines.push(`WPR: ${a?.wpr?.toFixed(2) ?? 'N/A'} | Breakout: ${a?.breakout?.type || 'none'}`);
            if (a?.breakout?.active) {
                lines.push(`Levels: H=${a.breakout.highLevel.toFixed(5)} L=${a.breakout.lowLevel.toFixed(5)}`);
            }
            if (a?.normalModeActive) {
                lines.push(`Normal Mode: ${a.tradesInNormalMode}/${CONFIG.MAX_TRADES_PER_CYCLE} trades`);
            }
        }
        if (details.profit !== undefined) {
            const pl = Number(details.profit) || 0;
            lines.push(`Profit: ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}`);
            lines.push(``);
            lines.push(`\u{1f4cb} <b>${symbol} Stats:</b>`);
            lines.push(`W/L: ${a?.winsCount ?? 0}/${a?.lossesCount ?? 0} | P/L: $${(a?.netPL ?? 0).toFixed(2)}`);
            lines.push(``);
            lines.push(`\u{1f4cb} <b>Today:</b>`);
            lines.push(`Trades: ${today.tradesCount} | W/L: ${today.winsCount}/${today.lossesCount} | P/L: $${(today.netPL || 0).toFixed(2)}`);
            lines.push(`Capital: $${state.capital.toFixed(2)}`);
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
                const normalInfo = a.normalModeActive ? ` Nrm:${a.tradesInNormalMode}/${CONFIG.MAX_TRADES_PER_CYCLE}` : '';
                assetInfo += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L $${(a.netPL || 0).toFixed(2)} Rec:${a.recoveryStep} WPR:${a.wpr?.toFixed(1)}${normalInfo}`;
            }
        });
        await this.sendMessage([
            `⏰ <b>WILL4 v4.0 Hourly</b>`,
            `Last Hour: ${h.trades}t ${h.wins}W/${h.losses}L ${wr}% ${h.pnl >= 0 ? '\u{1f7e2}' : '\u{1f534}'} $${h.pnl.toFixed(2)}`,
            `Today: ${today.tradesCount}t P/L: $${(today.netPL || 0).toFixed(2)}`,
            `Capital: $${state.capital.toFixed(2)}`,
            TradingSessionManager.getStatusString(),
            assetInfo ? `\n<b>Per-Asset:</b>${assetInfo}` : '',
        ].join('\n'));
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };
    }
    static async sendSessionSummary() {
        const stats   = SessionManager.getSessionStats();
        const overall = TradeHistoryManager.getOverallStats();
        const today   = TradeHistoryManager.getTodayStats();
        const wr      = overall.tradesCount > 0 ? ((overall.winsCount / overall.tradesCount) * 100).toFixed(1) : '0.0';
        let pairBreakdown = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a?.tradesCount > 0) {
                const pairWr = a.tradesCount > 0 ? ((a.winsCount / a.tradesCount) * 100).toFixed(1) : '0.0';
                pairBreakdown += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L (${pairWr}%) $${(a.netPL || 0).toFixed(2)}`;
            }
        });
        await this.sendMessage([
            `\u{1f4ca} <b>WILL4 v4.0 SESSION SUMMARY</b>`,
            `Duration: ${stats.duration} | Trades: ${stats.trades}`,
            `W: ${stats.wins} | L: ${stats.losses} | Win Rate: ${stats.winRate}`,
            `Session P/L: $${(stats.netPL || 0).toFixed(2)}`,
            `Today P/L: $${(today.netPL || 0).toFixed(2)}`,
            ``,
            `\u{1f4cb} <b>Overall:</b> ${overall.tradesCount} trades | WR: ${wr}% | P/L: $${(overall.netPL || 0).toFixed(2)}`,
            pairBreakdown ? `\n<b>Per-Asset:</b>${pairBreakdown}` : '',
            ``,
            `\u{1f4b0} Capital: $${state.capital.toFixed(2)}`,
        ].join('\n'));
    }
    static async sendStartupMessage() {
        const overall = TradeHistoryManager.getOverallStats();
        let pairInfo = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            pairInfo += `\n  ${sym}: ${CONFIG.TIMEFRAME_LABEL} | ${CONFIG.DURATION}${CONFIG.DURATION_UNIT}`;
        });
        await this.sendMessage([
            `\u{1f916} <b>WILL BOT v4.0 STARTED</b>`,
            `Strategy: Williams %R Breakout + Normal Trading Mode`,
            `WPR Period: ${CONFIG.WPR_PERIOD} | Overbought: ${CONFIG.WPR_OVERBOUGHT} | Oversold: ${CONFIG.WPR_OVERSOLD}`,
            `Normal Mode: ${CONFIG.MAX_TRADES_PER_CYCLE} trades per cycle`,
            `Risk: ${CONFIG.BASE_RISK_PERCENT_PER_TRADE}%/trade (cap ${CONFIG.MAX_RISK_PCT}%)`,
            `Recovery: ${CONFIG.RECOVERY_ENABLED ? `single capped step (×${CONFIG.RECOVERY_MULTIPLIER})` : 'Disabled'} — no martingale`,
            `Capital: $${state.capital.toFixed(2)}`,
            TradingSessionManager.getStatusString(),
            ``,
            `\u{1f4ca} Overall: ${overall.tradesCount} trades | P/L: $${(overall.netPL || 0).toFixed(2)}`,
            `<b>Active Assets:</b>${pairInfo}`,
        ].join('\n'));
    }
    static startHourlyTimer() {
        if (this.hourlyTimerStarted) return;
        this.hourlyTimerStarted = true;
        const now      = new Date();
        const nextHour = new Date(now);
        nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0);
        setTimeout(() => {
            this.sendHourlySummary();
            this.hourlyTimerId = setInterval(() => this.sendHourlySummary(), 3600000);
        }, nextHour.getTime() - now.getTime());
    }
    static startDailyTimer() {
        if (this.dailyTimerStarted) return;
        this.dailyTimerStarted = true;
        const now     = new Date();
        const nextDay = new Date(now);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        nextDay.setUTCHours(0, 0, 0, 0);
        setTimeout(() => {
            SessionManager.checkDayChange();
            this.dailyTimerId = setInterval(() => SessionManager.checkDayChange(), 86400000);
        }, nextDay.getTime() - now.getTime());
    }
    static clearTimers() {
        if (this.hourlyTimerId) { clearInterval(this.hourlyTimerId); this.hourlyTimerId = null; this.hourlyTimerStarted = false; }
        if (this.dailyTimerId)  { clearInterval(this.dailyTimerId);  this.dailyTimerId  = null; this.dailyTimerStarted  = false; }
    }
}
// ============================================================
// SESSION MANAGER  [MODIFIED recordTradeResult]
// ============================================================
class SessionManager {
    static isSessionActive() { return state.session.isActive; }
    static checkSessionTargets() {
        const netPL = state.session?.netPL || 0;
        if (netPL >= CONFIG.SESSION_PROFIT_TARGET) {
            LOGGER.trade(`Session profit target reached: $${netPL.toFixed(2)}`);
            this.endSession('PROFIT_TARGET');
            return true;
        }
        if (netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.error(`Session stop-loss reached: $${netPL.toFixed(2)}`);
            this.endSession('STOP_LOSS');
            return true;
        }
        const today = TradeHistoryManager.getTodayStats();
        if (today.netPL <= CONFIG.DAILY_STOP_LOSS) {
            LOGGER.error(`Daily stop-loss reached: $${(today?.netPL || 0).toFixed(2)}`);
            this.endSession('DAILY_STOP_LOSS');
            return true;
        }
        return false;
    }
    static async endSession(reason) {
        state.session.isActive = false;
        LOGGER.info(`Session ended: ${reason}`);
        await TelegramService.sendSessionSummary();
    }
    static getSessionStats() {
        const dur  = Date.now() - state.session.startTime;
        const hrs  = Math.floor(dur / 3600000);
        const mins = Math.floor((dur % 3600000) / 60000);
        const wr   = state.session.tradesCount > 0
            ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1) + '%'
            : '0%';
        return { duration: `${hrs}h ${mins}m`, trades: state.session.tradesCount, wins: state.session.winsCount, losses: state.session.lossesCount, winRate: wr, netPL: state.session.netPL };
    }
    static checkDayChange() {
        const today = TradeHistoryManager.getDateKey();
        if (state.currentTradeDay && state.currentTradeDay !== today) {
            LOGGER.info(`Day changed: ${state.currentTradeDay} -> ${today}`);
            const dayStats = TradeHistoryManager.getDayStats(state.currentTradeDay);
            TelegramService.sendMessage(
                `\u{1f319} <b>WILL4 END OF DAY ${state.currentTradeDay}</b>\nP/L: $${(dayStats?.netPL || 0).toFixed(2)}\nCapital: $${state.capital.toFixed(2)}`
            );
            this._resetDailyStats();
            if (!state.session.isActive) {
                state.session.isActive = true;
                LOGGER.info('Session re-activated for new day');
            }
        }
        state.currentTradeDay = today;
    }
    static _resetDailyStats() {
        const s = state.session;
        s.tradesCount = 0; s.winsCount = 0; s.lossesCount = 0;
        s.profit = 0; s.loss = 0; s.netPL = 0;
        s.startTime = Date.now(); s.startCapital = state.capital;
        state.portfolio   = { dailyProfit: 0, dailyLoss: 0, dailyWins: 0, dailyLosses: 0 };
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                a.tradesCount = 0; a.winsCount = 0; a.lossesCount = 0;
                a.profit = 0; a.loss = 0; a.netPL = 0;
            }
        });
    }
    static recordTradeResult(symbol, profit, direction) {
        const a = state.assets[symbol];
        if (!a) return;
        this.checkDayChange();
        const hour = new Date().getUTCHours();
        if (hour !== state.hourlyStats.lastHour) {
            state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: hour };
        }
        state.session.tradesCount++;
        state.hourlyStats.trades++;
        state.hourlyStats.pnl  += profit;
        a.tradesCount++;
        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit   += profit;
            state.session.netPL    += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            state.hourlyStats.wins++;
            a.winsCount++;
            a.profit += profit; a.netPL += profit;
            a.consecutiveWins++;
            a.consecutiveLosses = 0;
            a.recoveryStep      = 0;
            a.cooldownCandles   = 0;
            a.currentStake      = StakeCalculator.calculate(state.capital);
            a.lastTradeWasWin   = true;
            a.forceRecoverDirection = null;  // win exits forced recovery mode
            LOGGER.trade(`WIN [${symbol}] +$${(profit || 0).toFixed(2)} | ${direction} | P/L: $${(a.netPL || 0).toFixed(2)}`);
        } else {
            state.session.lossesCount++;
            state.session.loss     += Math.abs(profit);
            state.session.netPL    += profit;
            state.portfolio.dailyLoss    += Math.abs(profit);
            state.portfolio.dailyLosses++;
            state.hourlyStats.losses++;
            a.lossesCount++;
            a.loss  += Math.abs(profit);
            a.netPL += profit;
            a.consecutiveLosses++;
            a.consecutiveWins  = 0;
            a.lastTradeWasWin  = false;
            a.forceRecoverDirection = a.lastTradeDirection === 'CALLE' ? 'PUTE' : 'CALLE';  // loss -> force opposite direction
            // Pause normal mode during recovery
            if (a.normalModeActive) {
                a.normalModePaused = true;
                LOGGER.recovery(`[${symbol}] Normal mode PAUSED for recovery`);
            }
            if (CONFIG.RECOVERY_ENABLED && a.recoveryStep < CONFIG.MAX_RECOVERY_STEPS) {
                a.recoveryStep++;
            } else {
                a.recoveryStep = 0;
            }
            a.currentStake = StakeCalculator.calculate(state.capital, a.recoveryStep);
            if (a.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
                a.currentStake = CONFIG.MIN_STAKE;
                a.cooldownCandles = CONFIG.COOLDOWN_CANDLES;
                a.forceRecoverDirection = null;
                LOGGER.warn(`[${symbol}] ${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses — cooling down for ${CONFIG.COOLDOWN_CANDLES} candles`);
                TelegramService.sendMessage(
                    `❄️ <b>[${symbol}] WILL4 COOL-DOWN ACTIVATED</b>\n` +
                    `${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses\n` +
                    `Pausing for ${CONFIG.COOLDOWN_CANDLES} candles\n` +
                    `Capital: $${state.capital.toFixed(2)}`
                );
            }
            LOGGER.trade(`LOSS [${symbol}] -$${Math.abs(profit || 0).toFixed(2)} | ${direction} | Next Stake: $${(a.currentStake || 0).toFixed(2)} (recoup=${a.recoveryStep})`);
        }
        TradeHistoryManager.recordTrade(symbol, profit, a.recoveryStep);
    }
}
// ============================================================
// STATE  [MODIFIED for WPR + normal mode]
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
    },
    isConnected:  false,
    isAuthorized: false,
    portfolio:    { dailyProfit: 0, dailyLoss: 0, dailyWins: 0, dailyLosses: 0 },
    hourlyStats:  { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() },
    requestId:    1,
    lastSessionLogTime: 0,
    tradeWatchdogTimer:     null,
    tradeWatchdogPollTimer: null,
    pendingTradeInfo:       null,
    tradeStartTime:         null,
    currentContractId:      null,
};
let tradeHistory = null;
// ============================================================
// CONNECTION MANAGER  [MODIFIED initializeAssets + handleOHLC]
// ============================================================
class ConnectionManager {
    constructor() {
        this.ws                   = null;
        this.reconnectAttempts    = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay       = 5000;
        this.pingInterval         = null;
        this.autoSaveStarted      = false;
        this.isReconnecting       = false;
        this.isShuttingDown       = false;
        this.reconnectTimer       = null;
        this.activeSubscriptions  = new Set();
        this._subscriptionIds     = new Map();
        this._isPat         = RestClient.isPat(CONFIG.API_TOKEN);
        this._rest          = this._isPat
            ? new RestClient('https://api.derivws.com', CONFIG.APP_ID, CONFIG.API_TOKEN)
            : null;
        this._otpUrl        = null;
        this._targetAccount = null;
        this.accountInfo    = null;
    }
    connect() {
        if (this.ws?.readyState === WebSocket.OPEN) { LOGGER.info('Already connected'); return; }
        if (!CONFIG.API_TOKEN) { LOGGER.error('API_TOKEN is empty — aborting'); return; }
        LOGGER.info('Connecting to Deriv API...');
        this.cleanup();
        this.isShuttingDown = false;
        if (this._isPat) {
            LOGGER.info('PAT token detected -> using NEW Deriv API (OTP flow)');
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
                headers: { 'User-Agent': 'willBot4/4.0 (+Node.js)' },
                handshakeTimeout: 15000,
            });
        } catch (e) {
            LOGGER.error(`WS construct failed: ${e.message}`);
            this.onClose();
            return;
        }
        this.ws.on('open',    ()    => this.onOpen());
        this.ws.on('message', data => this.onMessage(data));
        this.ws.on('error',   err  => this.onError(err));
        this.ws.on('close',   ()   => this.onClose());
        this.ws.on('unexpected-response', (_req, res) => {
            LOGGER.error(`WS handshake failed: ${res.statusCode} ${res.statusMessage}`);
            try { res.destroy(); } catch (_) {}
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
            `Authorized ${this.accountInfo.loginid} ` +
            `(${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) ` +
            `balance=${this.accountInfo.balance} ${this.accountInfo.currency} via PAT/new-API`
        );
        state.isAuthorized   = true;
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
        state.isConnected   = true;
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
                    currentFormingCandle:        null,
                    lastProcessedCandleOpenTime: null,
                    candlesLoaded:               false,
                    lastTradeDirection:          null,
                    lastTradeWasWin:             null,
                    forceRecoverDirection:       null,
                    recoveryStep:                0,
                    currentStake:                StakeCalculator.calculate(state.capital),
                    canTrade:                    false,
                    consecutiveWins:             0,
                    consecutiveLosses:           0,
                    cooldownCandles:             0,
                    activePositions:             [],
                    tradesCount: 0, winsCount: 0, lossesCount: 0,
                    profit: 0, loss: 0, netPL: 0,
                    // WPR state
                    wpr: -50, prevWpr: -50,
                    buyFlagActive:  false,
                    sellFlagActive: false,
                    breakout: { active: false, type: null, highLevel: 0, lowLevel: 0, triggerCandle: 0, canBeReplaced: true },
                    inTradeCycle:      false,
                    waitingForReentry: false,
                    priceReturnedToZone: false,
                    currentDirection: null,
                    // Normal mode state
                    normalModeActive:     false,
                    tradesInNormalMode:   0,
                    normalModeDirection:  null,
                    normalModePaused:     false,
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
            case 'ohlc':                   this.handleOHLC(r.ohlc);      break;
            case 'candles':                this.handleCandlesHistory(r); break;
            case 'buy':                    this.handleBuyResponse(r);    break;
            case 'proposal_open_contract': this.handleOpenContract(r);   break;
            case 'ping':                                                  break;
            default:                                                      break;
        }
    }
    handleAuthorize(r) {
        if (r.error) { LOGGER.error(`Auth failed: ${r.error.message}`); return; }
        LOGGER.info(`Authorized: ${r.authorize.loginid} | Balance: ${r.authorize.balance} ${r.authorize.currency}`);
        state.isAuthorized   = true;
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
                        if (i >= 0) a.activePositions.splice(i, 1);
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
                    pos.buyPrice   = contract.buy_price;
                    state.currentContractId = contract.contract_id;
                    state.tradeStartTime    = Date.now();
                    state.pendingTradeInfo  = { stake: pos.stake, direction: pos.direction, symbol: pos.symbol };
                    bot._startTradeWatchdog(contract.contract_id);
                    TelegramService.sendTradeAlert(
                        'OPEN', pos.symbol, pos.direction, pos.stake,
                        pos.duration, pos.durationUnit,
                        { signal: pos.signal }
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
        const contract      = r.proposal_open_contract;
        const contractId    = contract.contract_id;
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
                const i = a.activePositions.findIndex(p => p.contractId === contractId);
                if (i >= 0) { ownerSym = sym; posIdx = i; break; }
            }
        }
        if (posIdx < 0 || !ownerSym) {
            LOGGER.warn(`Contract ${contractId} settled but not found — retrying in 500ms`);
            setTimeout(() => this.handleOpenContract(r), 500);
            return;
        }
        bot._processedContracts.add(contractIdStr);
        bot._clearAllWatchdogTimers();
        const a      = state.assets[ownerSym];
        const pos    = a.activePositions[posIdx];
        const profit = Number(contract.profit);
        SessionManager.recordTradeResult(ownerSym, profit, pos.direction);
        TelegramService.sendTradeAlert(
            profit >= 0 ? 'WIN' : 'LOSS',
            ownerSym, pos.direction, pos.stake,
            pos.duration, pos.durationUnit,
            { profit }
        );
        a.activePositions.splice(posIdx, 1);
        state.currentContractId = null;
        state.tradeStartTime    = null;
        state.pendingTradeInfo  = null;
        bot._tradeLocked = false;
        if (r.subscription?.id) this.send({ forget: r.subscription.id });
        SessionManager.checkSessionTargets();
        StatePersistence.saveState();
    }
    // ════════════════════════════════════════════════════════
    // OHLC HANDLER — candle close triggers trade logic
    // ════════════════════════════════════════════════════════
    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        const a      = state.assets[symbol];
        if (!a) return;
        const gran     = CONFIG.GRANULARITY;
        const openTime = ohlc.open_time || Math.floor(ohlc.epoch / gran) * gran;
        const incoming = {
            open: parseFloat(ohlc.open), high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),   close: parseFloat(ohlc.close),
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
                    const dir  = closed.close > closed.open ? '\u{1f7e2}' : '\u{1f534}';
                    const time = new Date(closed.epoch * 1000).toISOString();
                    LOGGER.candle(`${dir} [${symbol}] CANDLE CLOSED [${time}] O:${closed.open.toFixed(5)} H:${closed.high.toFixed(5)} L:${closed.low.toFixed(5)} C:${closed.close.toFixed(5)} | Total: ${a.closedCandles.length}`);
                    if (a.cooldownCandles > 0) {
                        a.cooldownCandles--;
                        if (a.cooldownCandles === 0) a.forceRecoverDirection = null;
                        LOGGER.info(`❄️ [${symbol}] Cool-down: ${a.cooldownCandles} candles remaining`);
                    }
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
        else          a.candles.push(incoming);
        if (a.candles.length > CONFIG.MAX_CANDLES_STORED) {
            a.candles = a.candles.slice(-CONFIG.MAX_CANDLES_STORED);
        }
    }
    handleCandlesHistory(r) {
        if (r.error) { LOGGER.error(`Candles error: ${r.error.message}`); return; }
        const symbol = r.echo_req?.ticks_history;
        if (!symbol || !state.assets[symbol]) return;
        const gran = CONFIG.GRANULARITY;
        const candles = (r.candles || []).map(c => ({
            open: parseFloat(c.open), high: parseFloat(c.high),
            low: parseFloat(c.low),   close: parseFloat(c.close),
            epoch: c.epoch, open_time: Math.floor((c.epoch - gran) / gran) * gran,
        }));
        if (!candles.length) { LOGGER.warn(`[${symbol}] No candles received`); return; }
        state.assets[symbol].closedCandles               = [...candles];
        state.assets[symbol].candles                     = [...candles];
        state.assets[symbol].lastProcessedCandleOpenTime = candles[candles.length - 1].open_time;
        state.assets[symbol].currentFormingCandle        = null;
        state.assets[symbol].candlesLoaded               = true;
        // Calculate initial WPR
        if (candles.length >= CONFIG.WPR_PERIOD) {
            state.assets[symbol].prevWpr = state.assets[symbol].wpr;
            state.assets[symbol].wpr = TechnicalIndicators.calculateWPR(candles, CONFIG.WPR_PERIOD);
        }
        LOGGER.info(
            `[${symbol}] Loaded ${candles.length} ${CONFIG.TIMEFRAME_LABEL} candles | ` +
            `WPR: ${state.assets[symbol].wpr.toFixed(2)} | ` +
            `Breakout: ${state.assets[symbol].breakout.type || 'none'}`
        );
    }
    onError(err) { LOGGER.error(`WebSocket error: ${err.message}`); }
    onClose() {
        LOGGER.warn('Disconnected from Deriv API');
        state.isConnected  = false;
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
            TelegramService.sendMessage(`⚠️ <b>WILL4 CONNECTION LOST</b> — Reconnecting (attempt ${this.reconnectAttempts})`);
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (this.isShuttingDown) return;
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached — giving up');
            TelegramService.sendMessage(`\u{1f6d1} <b>WILL4 BOT STOPPED</b> — Max reconnections\nFinal P/L: $${(state.session.netPL || 0).toFixed(2)}`);
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
// MAIN BOT CLASS — v4 WILL
// ============================================================
class IndexBot {
    constructor() {
        this.connection              = new ConnectionManager();
        this._processedContracts     = new Set();
        this._tradeLocked            = false;
        this.tradeWatchdogMs         = 150000;
        this.timeCheckStarted        = false;
        this.sessionTimeCheckerId    = null;
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
        console.log(' DERIV CALLE/PUTE BOT v4.0 — WILL (Williams %R Breakout Engine)');
        console.log('═'.repeat(74));
        console.log(`Assets    : ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        console.log(`Timeframe : ${CONFIG.TIMEFRAME_LABEL} candles | Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT}`);
        console.log(`Strategy  : WPR(${CONFIG.WPR_PERIOD}) cross ${CONFIG.WPR_OVERBOUGHT}/${CONFIG.WPR_OVERSOLD} → Breakout Levels → Normal Mode (${CONFIG.MAX_TRADES_PER_CYCLE} trades)`);
        console.log(`Risk      : cap ${CONFIG.MAX_RISK_PCT}% | Recoup: 1 step ×${CONFIG.RECOVERY_MULTIPLIER} (no martingale)`);
        console.log(`Capital   : $${state.capital.toFixed(2)}`);
        console.log(`Sessions  : ${TradingSessionManager.getStatusString()}`);
        console.log('═'.repeat(74) + '\n');
        state.currentTradeDay = TradeHistoryManager.getDateKey();
        TradeHistoryManager.ensureDayEntry(state.currentTradeDay);
        this.connection.initializeAssets();
        CONFIG.ACTIVE_ASSETS.forEach(sym => this.subscribeToCandles(sym));
        await TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();
        TelegramService.startDailyTimer();
        this.startSessionTimeChecker();
        LOGGER.info('WILL Bot v4.0 fully started!');
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
    // CORE TRADE LOGIC — called on every candle close
    //
    // PRIORITY ORDER:
    //   1. RECOVERY mode — forced trade after loss (retained from v3)
    //   2. NORMAL mode — trade candle direction for N trades
    //   3. WPR SIGNAL mode — detect WPR cross, set breakout, start normal mode
    // ════════════════════════════════════════════════════════
    processNewCandle(symbol, lastClosedCandle) {
        const a = state.assets[symbol];
        if (!a || !a.canTrade)                                     return;
        if (!SessionManager.isSessionActive())                     return;
        if (a.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) return;
        if (!state.isConnected || !state.isAuthorized)             return;
        if (this._tradeLocked) {
            LOGGER.debug(`[${symbol}] Trade mutex locked — skipping`);
            return;
        }
        if (a.cooldownCandles > 0) {
            LOGGER.debug(`[${symbol}] In cool-down (${a.cooldownCandles} candles remaining)`);
            a.canTrade = false;
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
        const stake = a.currentStake;
        if (state.capital < stake) {
            LOGGER.error(`[${symbol}] Stake $${stake.toFixed(2)} exceeds capital $${state.capital.toFixed(2)}`);
            a.recoveryStep = 0;
            a.forceRecoverDirection = null;
            a.currentStake = StakeCalculator.calculate(state.capital);
            a.canTrade = false;
            return;
        }
        if (a.closedCandles.length < CONFIG.MIN_CANDLES_REQUIRED) {
            LOGGER.debug(`[${symbol}] Not enough candles yet (${a.closedCandles.length}/${CONFIG.MIN_CANDLES_REQUIRED})`);
            a.canTrade = false;
            return;
        }
        // ── Only trade the asset that is in recovery; skip all others ──
        const recoveringAsset = CONFIG.ACTIVE_ASSETS.find(s => state.assets[s]?.forceRecoverDirection);
        if (recoveringAsset && recoveringAsset !== symbol) {
            LOGGER.debug(`[${symbol}] Skipping — ${recoveringAsset} is in forced recovery`);
            return;
        }
        // ── Update WPR on every candle close ──
        a.prevWpr = a.wpr;
        a.wpr = TechnicalIndicators.calculateWPR(a.closedCandles, CONFIG.WPR_PERIOD);
        // ── Update WPR flags ──
        SignalManager.updateWPRState(symbol);
        // ══════════════════════════════════════════════════════
        // PRIORITY 1: RECOVERY MODE — force trade after loss
        // ══════════════════════════════════════════════════════
        if (a.forceRecoverDirection) {
            this._tradeLocked = true;
            a.canTrade = false;
            const dir = a.forceRecoverDirection;
            const recNote = a.recoveryStep > 0 ? ` [RECOVERY STEP ${a.recoveryStep}]` : '';
            LOGGER.recovery(
                `[${symbol}]${recNote} FORCE RECOVERY ${dir === 'CALLE' ? '\u{1f4c8} CALLE' : '\u{1f4c9} PUTE'} | ` +
                `Stake: $${stake.toFixed(2)} | FORCED AFTER LOSS`
            );
            const pos = {
                symbol, direction: dir, stake, duration: CONFIG.DURATION,
                durationUnit: CONFIG.DURATION_UNIT, entryTime: Date.now(),
                contractId: null, reqId: null, currentProfit: 0, buyPrice: 0,
                signal: { reason: 'FORCED RECOVERY - Opposite direction', method: 'RECOVERY' },
            };
            a.activePositions.push(pos);
            const reqId = this.connection.send({
                buy: 1, subscribe: 1, price: stake.toFixed(2),
                parameters: {
                    contract_type: dir,
                    [this.connection._isPat ? 'underlying_symbol' : 'symbol']: symbol,
                    currency: 'USD', amount: stake.toFixed(2),
                    duration: CONFIG.DURATION, duration_unit: CONFIG.DURATION_UNIT, basis: 'stake',
                },
            });
            pos.reqId = reqId;
            setTimeout(() => {
                if (this._tradeLocked && !pos.contractId) {
                    LOGGER.warn(`[${symbol}] Buy response timeout — releasing lock`);
                    const idx = a.activePositions.indexOf(pos);
                    if (idx >= 0) a.activePositions.splice(idx, 1);
                    this._tradeLocked = false;
                }
            }, 5000);
            StatePersistence.saveState();
            return;
        }
        // ══════════════════════════════════════════════════════
        // PRIORITY 2: NORMAL MODE — trade candle direction
        // ══════════════════════════════════════════════════════
        if (a.normalModeActive && a.tradesInNormalMode < CONFIG.MAX_TRADES_PER_CYCLE) {
            // Unpause normal mode after recovery is resolved
            if (a.normalModePaused) {
                a.normalModePaused = false;
                LOGGER.normal(`[${symbol}] Normal mode RESUMED after recovery`);
            }
            // Determine direction from candle close
            const candleDir = lastClosedCandle.close > lastClosedCandle.open ? 'CALLE' : 'PUTE';
            a.tradesInNormalMode++;
            a.lastTradeDirection = candleDir;
            a.currentDirection = candleDir;
            LOGGER.normal(
                `[${symbol}] NORMAL MODE #${a.tradesInNormalMode}/${CONFIG.MAX_TRADES_PER_CYCLE} ` +
                `${candleDir === 'CALLE' ? '\u{1f4c8} CALLE' : '\u{1f4c9} PUTE'} | ` +
                `Close: ${lastClosedCandle.close.toFixed(5)} ${candleDir === 'CALLE' ? '>' : '<'} Open: ${lastClosedCandle.open.toFixed(5)} | ` +
                `Stake: $${stake.toFixed(2)}`
            );
            this._executeBuy(symbol, candleDir, stake, {
                method: 'NORMAL_MODE',
                reason: `Normal mode #${a.tradesInNormalMode}/${CONFIG.MAX_TRADES_PER_CYCLE} — candle ${candleDir === 'CALLE' ? 'bullish' : 'bearish'}`,
            });
            // Check if cycle complete
            if (a.tradesInNormalMode >= CONFIG.MAX_TRADES_PER_CYCLE) {
                LOGGER.normal(`[${symbol}] Normal mode cycle COMPLETE (${CONFIG.MAX_TRADES_PER_CYCLE} trades) — waiting for new WPR signal`);
                a.normalModeActive = false;
                a.tradesInNormalMode = 0;
                a.normalModeDirection = null;
            }
            return;
        }
        // ══════════════════════════════════════════════════════
        // PRIORITY 3: WPR SIGNAL MODE — detect signal, start cycle
        // ══════════════════════════════════════════════════════
        // Check for breakout replacement during active trade
        if (a.inTradeCycle && a.activePositions.length > 0) {
            const replacementReversal = BreakoutManager.checkForBreakoutReplacement(symbol);
            if (replacementReversal) {
                this.executeReversal(symbol, replacementReversal);
                return;
            }
        }
        // Check for breakout-level reversal
        if (a.activePositions.length > 0 && a.breakout.active) {
            const lastCandle = a.closedCandles[a.closedCandles.length - 1];
            if (lastCandle) {
                const closePrice = lastCandle.close;
                const currentDir = a.currentDirection;
                if (currentDir === 'CALLE' && closePrice < a.breakout.lowLevel) {
                    LOGGER.breakout(`[${symbol}] REVERSAL: CALLE -> PUTE (${closePrice.toFixed(5)} < ${a.breakout.lowLevel.toFixed(5)})`);
                    this.executeReversal(symbol, 'PUTE');
                    return;
                }
                if (currentDir === 'PUTE' && closePrice > a.breakout.highLevel) {
                    LOGGER.breakout(`[${symbol}] REVERSAL: PUTE -> CALLE (${closePrice.toFixed(5)} > ${a.breakout.highLevel.toFixed(5)})`);
                    this.executeReversal(symbol, 'CALLE');
                    return;
                }
            }
        }
        // Detect new WPR signals
        const buySignal  = SignalManager.checkBuySignal(symbol);
        const sellSignal = SignalManager.checkSellSignal(symbol);
        if (buySignal) {
            LOGGER.signal(`[${symbol}] BUY SIGNAL — setting breakout levels and starting normal mode`);
            const setupSuccess = BreakoutManager.setupBreakoutLevels(symbol, 'UP', 'BUY');
            if (setupSuccess) {
                // Execute first trade as CALLE
                const firstDir = 'CALLE';
                a.normalModeActive = true;
                a.tradesInNormalMode = 1;
                a.normalModeDirection = firstDir;
                a.lastTradeDirection = firstDir;
                a.currentDirection = firstDir;
                LOGGER.normal(`[${symbol}] NORMAL MODE #1/${CONFIG.MAX_TRADES_PER_CYCLE} \u{1f4c8} CALLE (initial signal trade) | Stake: $${stake.toFixed(2)}`);
                this._executeBuy(symbol, firstDir, stake, {
                    method: 'WPR_SIGNAL',
                    reason: `WPR BUY signal — WPR crossed above ${CONFIG.WPR_OVERBOUGHT} (from oversold)`,
                });
                a.buyFlagActive = false; // consumed
            }
            return;
        }
        if (sellSignal) {
            LOGGER.signal(`[${symbol}] SELL SIGNAL — setting breakout levels and starting normal mode`);
            const setupSuccess = BreakoutManager.setupBreakoutLevels(symbol, 'DOWN', 'SELL');
            if (setupSuccess) {
                // Execute first trade as PUTE
                const firstDir = 'PUTE';
                a.normalModeActive = true;
                a.tradesInNormalMode = 1;
                a.normalModeDirection = firstDir;
                a.lastTradeDirection = firstDir;
                a.currentDirection = firstDir;
                LOGGER.normal(`[${symbol}] NORMAL MODE #1/${CONFIG.MAX_TRADES_PER_CYCLE} \u{1f4c9} PUTE (initial signal trade) | Stake: $${stake.toFixed(2)}`);
                this._executeBuy(symbol, firstDir, stake, {
                    method: 'WPR_SIGNAL',
                    reason: `WPR SELL signal — WPR crossed below ${CONFIG.WPR_OVERSOLD} (from overbought)`,
                });
                a.sellFlagActive = false; // consumed
            }
            return;
        }
        // No signal — log status
        LOGGER.debug(`[${symbol}] WPR: ${a.wpr.toFixed(2)} | BuyFlag: ${a.buyFlagActive} | SellFlag: ${a.sellFlagActive} | Normal: ${a.normalModeActive ? a.tradesInNormalMode + '/' + CONFIG.MAX_TRADES_PER_CYCLE : 'off'} | Breakout: ${a.breakout.type || 'none'}`);
    }
    // ── Execute a buy order (CALLE/PUTE) ──────────────────
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
            `\u{1f3af} [${symbol}] ${direction === 'CALLE' ? '\u{1f4c8} CALLE' : '\u{1f4c9} PUTE'} | ` +
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
    // ── Execute a reversal (close + reopen in new direction) ──
    executeReversal(symbol, newDirection) {
        const a = state.assets[symbol];
        const pos = a.activePositions[0];
        if (!pos || !pos.contractId) {
            LOGGER.warn(`No active position to reverse on ${symbol}`);
            return;
        }
        LOGGER.trade(`\u{1f504} REVERSING [${symbol}]: ${pos.direction} -> ${newDirection}`);
        // Close current position, then the handleOpenContract will handle re-entry
        // For now, just close — the next candle close will handle the new trade
        this.connection.send({ sell: pos.contractId, price: 0 });
    }
    // ── WATCHDOG [RETAINED] ────────────────────────────────────
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
        if (state.tradeWatchdogTimer)     { clearTimeout(state.tradeWatchdogTimer);     state.tradeWatchdogTimer     = null; }
        if (state.tradeWatchdogPollTimer) { clearTimeout(state.tradeWatchdogPollTimer); state.tradeWatchdogPollTimer = null; }
    }
    _forceReleaseTradeLock() {
        this._clearAllWatchdogTimers();
        this._tradeLocked = false;
        state.currentContractId = null;
        state.tradeStartTime    = null;
        state.pendingTradeInfo  = null;
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
        state.pendingTradeInfo  = null;
        state.tradeStartTime    = null;
        TelegramService.sendMessage(
            `⚠️ <b>WILL4 STUCK TRADE RECOVERED [${reason}]</b>\n` +
            `Contract: ${contractId}\n` +
            `⚠️ VERIFY OUTCOME MANUALLY ON DERIV\n` +
            `Capital: $${state.capital.toFixed(2)}`
        );
        StatePersistence.saveState();
    }
    stop() {
        LOGGER.info('Stopping bot...');
        CONFIG.ACTIVE_ASSETS.forEach(sym => { if (state.assets[sym]) state.assets[sym].canTrade = false; });
        TelegramService.clearTimers();
        this._clearAllWatchdogTimers();
        if (this.statusDisplayIntervalId) clearInterval(this.statusDisplayIntervalId);
        if (this.sessionTimeCheckerId)    clearInterval(this.sessionTimeCheckerId);
        if (this.contractCleanupInterval) clearInterval(this.contractCleanupInterval);
        StatePersistence.saveState();
        TradeHistoryManager.saveHistory();
        setTimeout(() => { this.connection.cleanup(); LOGGER.info('Bot stopped'); }, 2000);
    }
    startSessionTimeChecker() {
        if (this.timeCheckStarted) return;
        this.timeCheckStarted   = true;
        this.sessionTimeCheckerId = setInterval(() => SessionManager.checkDayChange(), 60000);
    }
    getStatus() {
        const overall = TradeHistoryManager.getOverallStats();
        const today   = TradeHistoryManager.getTodayStats();
        const pairStatuses = {};
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                pairStatuses[sym] = {
                    recoveryStep:    a.recoveryStep,
                    currentStake:    a.currentStake,
                    activePositions: a.activePositions.length,
                    cooldownCandles: a.cooldownCandles,
                    trades: a.tradesCount, wins: a.winsCount, losses: a.lossesCount, netPL: a.netPL,
                    lastDirection: a.lastTradeDirection,
                    wpr:            a.wpr,
                    buyFlag:        a.buyFlagActive,
                    sellFlag:       a.sellFlagActive,
                    breakoutType:   a.breakout.type,
                    breakoutHigh:   a.breakout.highLevel,
                    breakoutLow:    a.breakout.lowLevel,
                    normalMode:     a.normalModeActive,
                    normalTrades:   a.tradesInNormalMode,
                };
            }
        });
        return {
            connected: state.isConnected, authorized: state.isAuthorized, capital: state.capital,
            session: SessionManager.getSessionStats(), sessionInfo: TradingSessionManager.getSessionInfo(),
            totalPositions: CONFIG.ACTIVE_ASSETS.reduce((s, sym) => s + (state.assets[sym]?.activePositions?.length ?? 0), 0),
            pairs: pairStatuses, overall, today,
        };
    }
}
// ============================================================
// INITIALIZATION
// ============================================================
tradeHistory  = TradeHistoryManager.loadHistory();
const bot     = new IndexBot();
process.on('SIGINT',  () => { bot.stop(); bot.connection.shutdown(); setTimeout(() => process.exit(0), 3000); });
process.on('SIGTERM', () => { bot.stop(); bot.connection.shutdown(); setTimeout(() => process.exit(0), 3000); });
process.on('uncaughtException',  (err)    => { LOGGER.error(`UNCAUGHT: ${err.message}\n${err.stack}`); try { StatePersistence.saveState(); } catch {} });
process.on('unhandledRejection', (reason) => { LOGGER.error(`UNHANDLED: ${reason}`);                   try { StatePersistence.saveState(); } catch {} });
const stateLoaded = StatePersistence.loadState();
LOGGER.info(stateLoaded ? 'Resuming from saved state' : 'Starting fresh session');
if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.error('\n⚠️  Set CONFIG.API_TOKEN before running!\n');
    process.exit(1);
}
console.log('\n\u{1f680} Starting WILL Bot v4.0...\n');
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
            const normal = p.normalMode ? `Nrm:${p.normalTrades}/${CONFIG.MAX_TRADES_PER_CYCLE}` : '';
            const wpr    = `WPR:${p.wpr?.toFixed(1) ?? '?'}`;
            const bk     = p.breakoutType ? `Bk:${p.breakoutType}` : '';
            const cdwn   = p.cooldownCandles > 0 ? ` ❄️CD:${p.cooldownCandles}` : '';
            pairLines += `\n  ${sym}: ${wpr} ${p.buyFlag ? '\u{1f7e2}BF' : ''} ${p.sellFlag ? '\u{1f534}SF' : ''} ${bk} Rec${p.recoveryStep} $${(p.currentStake || 0).toFixed(2)} | ${p.trades}t ${p.wins}W/${p.losses}L $${(p.netPL || 0).toFixed(2)} | Pos:${p.activePositions} ${normal}${cdwn}`;
        }
    });
    console.log(`\n\u{1f4ca} ${getGMTTime()} | Session: ${status.session.trades}t ${status.session.winRate} $${(status.session.netPL || 0).toFixed(2)} | Capital: $${status.capital.toFixed(2)}`);
    console.log(`\u{1f4cb} Overall: ${status.overall.tradesCount}t | P/L: $${(status.overall.netPL || 0).toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
    console.log(`\u{1f555} ${TradingSessionManager.getStatusString()}`);
    console.log(`\u{1f4c8} Assets:${pairLines}`);
}, 60000);
bot.statusDisplayIntervalId = statusInterval;
