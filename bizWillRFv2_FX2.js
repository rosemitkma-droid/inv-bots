'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DERIV SYNTHETIC INDICES CALLE/PUTE BOT — v2FX2  "EVERY-CROSS"             ║
 * ║  STRATEGY (v2FX2 entry — every valid cross trades, NO first-cross filter): ║
 * ║  WPR_PERIOD (default 7, configurable via CONFIG.WPR_PERIOD)              ║
 * ║  BUY:  WPR crosses above -80 (prev <= -80 → cur > -80) → CALLE (Rise)    ║
 * ║  SELL: WPR crosses below -20 (prev >= -20 → cur < -20) → PUTE (Fall)     ║
 * ║  MULTI-ASSET: each asset fully independent — own stake, martingale      ║
 * ║  level, x2/x3.. loss counters, investment pool. One asset's win/loss    ║
 * ║  never touches another asset. Concurrent positions allowed (1/asset).   ║
 * ║  RECOVERY (signal-wait): after a loss, WAIT for next valid WPR signal;  ║
 * ║  trade that signal's direction with multiplied stake. Repeat on each    ║
 * ║  new signal until a win → stake resets to default. No same-direction,   ║
 * ║  no 58s immediate trade, no exclusive lock, no cooldown exit.           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ══════════════════════════════════════════════════════════════════════════════
// DERIV REST CLIENT  (for the PAT / OAuth OTP-based auth flow)  [RETAINED]
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
// FILE PATHS  [RETAINED]
// ============================================================
const STATE_FILE = path.join(__dirname, 'bizWillRFv2FX2_05-state.json');
const HISTORY_FILE = path.join(__dirname, 'bizWillRFv2FX2_05-history.json');
const STATE_SAVE_INTERVAL = 5000;  // ms

// ============================================================
// LOGGER  [RETAINED + CANDLE DIRECTION loggers]
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
    wpr: (msg) => console.log(`\x1b[34m[WPR]   ${getGMTTime()} - ${msg}\x1b[0m`),
    normal: (msg) => console.log(`\x1b[93m[NORM]   ${getGMTTime()} - ${msg}\x1b[0m`),
    recovery: (msg) => console.log(`\x1b[33m[RECOV]  ${getGMTTime()} - ${msg}\x1b[0m`),
    candle: (msg) => console.log(`\x1b[95m[CANDLE] ${getGMTTime()} - ${msg}\x1b[0m`),
};

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
    // ── Deriv API [RETAINED credentials] ─────────────────────
    API_TOKEN: 'pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee',
    APP_ID: '33uslPtthXBEkQOdfKfoY',
    ACCOUNT_TYPE: 'demo',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // ── Backtest historical-data scope (v5-style max backfill) ──────────
    // Ported from deriv_structure_tester_v5.js: with no --days / --from / --to
    // the backtester fetches candle history until Deriv stops serving it.
    MAX_CANDLES_FETCH_TARGET: 1000000,  // soft target for a single backtest fetch
    MAX_CANDLES_FETCH_HARD: 1200000,    // absolute guard against runaway loops
    CANDLE_FETCH_MAX_BATCH: 1000,       // candles per ticks_history call (server cap)
    CANDLE_FETCH_DELAY_MS: 350,         // rate-limit between paginated batches

    // ── Recovery Strategy ─────────────────────────────────────
    // TRUE MULTI-ASSET v4: after a loss, WAIT for a new valid WPR signal,
    // then trade that signal direction with multiplied stake (no same-direction).
    // Repeat on every new signal until a win, then reset stake to default.
    // Each asset is fully independent (own stake/martingale/pool).
    RECOVERY_WAIT_FOR_SIGNAL: true,
    // Deprecated legacy flags (kept for state-file compat, no longer used):
    // USE_RECOVERY_STRATEGY, MAX_CONSECUTIVE_LOSSES, COOLDOWN_CANDLES
    USE_RECOVERY_STRATEGY: true,

    // ── Session / daily guards (global aggregates = reporting only) ──
    // Per-asset guards live in DEFAULT_ASSET_CONFIG.SESSION_PROFIT_TARGET/STOP_LOSS.
    SESSION_PROFIT_TARGET: 500000,
    SESSION_STOP_LOSS: -308,
    COOLDOWN_CANDLES: 0,

    // ── Candle / Contract Settings (defaults, overridable per asset) ──
    GRANULARITY: 900,
    TIMEFRAME_LABEL: '15m',
    CANDLES_TO_LOAD: 100,
    MAX_CANDLES_STORED: 100,
    DURATION: 15,
    DURATION_UNIT: 'm',

    // ── Williams %R Settings (user configurable) ──────────────
    WPR_PERIOD: 7,
    WPR_OVERBOUGHT: -20,
    WPR_OVERSOLD: -80,
    // Deprecated: MAX_CONSECUTIVE_LOSSES removed — v4 recovers until win
    // (capped only by CONTINUE_EXTRA_LEVELS / investment pool per asset).
    MAX_CONSECUTIVE_LOSSES: 9,

    // ── Trading Sessions (synthetics trade 24/7) ─────────────
    USE_TRADING_SESSIONS: false,
    SESSIONS: [
        { name: 'LONDON_OPEN', start: 1, end: 17 },
        { name: 'NY_OPEN', start: 12, end: 23 },
    ],

    // ── Position Management ───────────────────────────────────
    // TRUE MULTI-ASSET: each asset trades independently (max 1 open each).
    // Total = number of active assets so assets never block each other.
    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    MAX_TOTAL_POSITIONS: 15,
    MAX_TRADES_PER_CYCLE: 1,

    // ── Active Index Assets ───────────────────────────────────
    ACTIVE_ASSETS: [
        'frxEURUSD',    // Euro/Dollar — most liquid, tightest spread
        // 'frxGBPUSD',    // Cable — high volatility, good signals
        // 'frxUSDJPY',    // Dollar/Yen — excellent trending behavior
        'frxUSDCHF',    // Dollar/Swiss — safe haven dynamics
        // 'frxAUDUSD',    // Aussie — commodity-linked, clear trends
        // 'frxUSDCAD',    // Dollar/Loonie — oil-correlated trends
        'frxEURGBP',    // Euro/Cable — range-bound, good for reversals
        'frxEURJPY',    // Euro/Yen — high volatility cross
        // 'frxXAUUSD',    // Gold — commodity-linked, clear trends
        // 'frxXAUEUR',    // Gold/Euro — commodity-linked, clear trends
            'frxNZDUSD',    // NZD/Dollar — most liquid, tightest spread
            // 'frxNZDJPY',    // NZD/JPY — most liquid, tightest spread
            // 'frxNZDCAD',    // NZD/CAD — most liquid, tightest spread
            'frxGBPNZD',    // GBP/NZD — high volatility, good signals
            'frxGBPCHF',    // GBP/CHF — high volatility, good signals
            // 'frxGBPCAD',    // GBP/CAD — high volatility, good signals
            // 'frxGBPJPY',    // GBP/JPY — high volatility, good signals
            'frxEURNZD',    // EUR/NZD — high volatility, good signals
    ],

    // ── Misc ──────────────────────────────────────────────────
    DEBUG_MODE: true,
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '7683695132:AAGA9_4uDcyZWEOAwv1_zj7Nnz5Oy0gVw04',
    TELEGRAM_CHAT_ID: '752497117',
    // Set to true to enable /backtest Telegram polling — keep false if same token used by other bots to avoid 409 Conflict
    TELEGRAM_POLLING_ENABLED: false,
};

// ============================================================
// PER-ASSET CONFIGURATION (from willRF.js)
// ============================================================
const DEFAULT_ASSET_CONFIG = {
    // Candle Settings
    GRANULARITY: 900,
    TIMEFRAME_LABEL: '15m',

    // Trade Duration
    DURATION: 15,
    DURATION_UNIT: 'm',

    // Stake Settings
    INITIAL_STAKE: 0.50,
    INVESTMENT_AMOUNT: 308,

    // Martingale Settings
    MARTINGALE_MULTIPLIER: 1.48, //1.48
    MAX_MARTINGALE_LEVEL: 1, //1
    AFTER_MAX_LOSS: 'continue', // 'continue' | 'reset' | 'stop' 
    CONTINUE_EXTRA_LEVELS: 8,
    EXTRA_LEVEL_MULTIPLIERS: [2.1, 2.2, 2, 2.1, 2.2, 2.3, 2.3], //[2.1, 2.2, 2, 2.3]

    // Auto-Compounding
    AUTO_COMPOUNDING: false,
    COMPOUND_PERCENTAGE: 0.1,

    // Risk Management
    STOP_LOSS: 308,

    // Per-asset session guards (independent — one asset hitting these
    // never affects the others; global SESSION_* in CONFIG is report-only)
    SESSION_PROFIT_TARGET: 500000,
    SESSION_STOP_LOSS: -308,
};

const ASSET_CONFIGS = {
    // Per-asset consecutive count override example:
    // 'R_10': {
    //     PATTERN_CONSECUTIVE_COUNT: 6
    // },
};

function getAssetConfig(symbol) {
    const overrides = ASSET_CONFIGS[symbol] || {};
    return { ...DEFAULT_ASSET_CONFIG, ...overrides };
}

// ============================================================
// TECHNICAL INDICATORS — Williams %R ONLY  [WPR]
// ============================================================
class TechnicalIndicators {
    /**
     * Williams %R calculated from CLOSED candles only.
     * Formula: WPR = ((HighestHigh - Close) / (HighestHigh - LowestHigh)) * -100
     * Returns null for insufficient/invalid data to avoid false crosses.
     */
    static calculateWPR(candles, period = 14) {
        if (!Array.isArray(candles) || candles.length < period) return null;
        const window = candles.slice(-period);
        let highestHigh = -Infinity;
        let lowestLow = Infinity;
        for (const c of window) {
            const high = Number(c?.high);
            const low = Number(c?.low);
            const close = Number(c?.close);
            if (![high, low, close].every(Number.isFinite) || high < low || close > high || close < low) {
                return null;
            }
            highestHigh = Math.max(highestHigh, high);
            lowestLow = Math.min(lowestLow, low);
        }
        const range = highestHigh - lowestLow;
        if (!Number.isFinite(range) || range <= 0) return null;
        const close = Number(window[window.length - 1].close);
        const value = -100 * ((highestHigh - close) / range);
        if (!Number.isFinite(value)) return null;
        return Math.max(-100, Math.min(0, value));
    }

    static calculateWPRSeries(candles, period = 14) {
        if (!Array.isArray(candles) || candles.length < period) return [];
        const values = [];
        for (let end = period; end <= candles.length; end++) {
            const v = this.calculateWPR(candles.slice(0, end), period);
            if (Number.isFinite(v)) values.push({ candleIndex: end - 1, value: v });
        }
        return values;
    }
}

// ============================================================
// SIGNAL MANAGER v2FX2 — EVERY valid cross trades (no first-cross filter).
//   BUY  (CALLE): WPR crosses above oversold  (prev <= -80 → cur > -80)
//   SELL (PUTE):  WPR crosses below overbought (prev >= -20 → cur < -20)
// No arm/flag requirement: any confirmed-candle cross is a valid entry.
// ============================================================
class SignalManager {
    static seedWPRState(symbol) {
        const a = state.assets[symbol];
        if (!a) return false;
        const cfg = getAssetConfig(symbol);
        const period = cfg.WPR_PERIOD ?? CONFIG.WPR_PERIOD ?? 14;
        const series = TechnicalIndicators.calculateWPRSeries(a.closedCandles, period);
        if (!series.length) return false;
        a.prevWpr = series.length > 1 ? series[series.length - 2].value : null;
        a.wpr = series[series.length - 1].value;
        // Legacy flags kept for state compat — always false in v2FX2 (unused).
        a.buyFlagActive = false;
        a.sellFlagActive = false;
        a.indicatorsReady = Number.isFinite(a.prevWpr) && Number.isFinite(a.wpr);
        return true;
    }

    static updateWPRState(symbol) {
        // v2FX2: no arming — every cross trades. Keep flags cleared.
        const a = state.assets[symbol];
        if (!a) return false;
        a.buyFlagActive = false;
        a.sellFlagActive = false;
        return false;
    }

    /**
     * Check BUY signal v2FX2: WPR crosses above oversold (-80). Every valid cross trades.
     * Returns {shouldTrade, direction, reason, details}
     */
    static checkBuySignal(symbol) {
        const a = state.assets[symbol];
        const wpr = a?.wpr;
        const prevWpr = a?.prevWpr;
        if (!Number.isFinite(wpr) || !Number.isFinite(prevWpr)) {
            return { shouldTrade: false, reason: `WPR not ready (${String(prevWpr)}→${String(wpr)})`, details: { wpr, prevWpr } };
        }
        const isCrossingAbove = prevWpr <= CONFIG.WPR_OVERSOLD && wpr > CONFIG.WPR_OVERSOLD;
        if (!isCrossingAbove) {
            return { shouldTrade: false, reason: `No BUY cross: ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} (need ≤${CONFIG.WPR_OVERSOLD}→>${CONFIG.WPR_OVERSOLD})`, details: { wpr, prevWpr } };
        }
        return {
            shouldTrade: true,
            direction: 'PUTE',
            confidence: 1,
            reason: `WPR v2FX2 BUY cross ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} above oversold ${CONFIG.WPR_OVERSOLD}`,
            details: { wpr, prevWpr }
        };
    }

    static checkSellSignal(symbol) {
        const a = state.assets[symbol];
        const wpr = a?.wpr;
        const prevWpr = a?.prevWpr;
        if (!Number.isFinite(wpr) || !Number.isFinite(prevWpr)) {
            return { shouldTrade: false, reason: `WPR not ready (${String(prevWpr)}→${String(wpr)})`, details: { wpr, prevWpr } };
        }
        const isCrossingBelow = prevWpr >= CONFIG.WPR_OVERBOUGHT && wpr < CONFIG.WPR_OVERBOUGHT;
        if (!isCrossingBelow) {
            return { shouldTrade: false, reason: `No SELL cross: ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} (need ≥${CONFIG.WPR_OVERBOUGHT}→<${CONFIG.WPR_OVERBOUGHT})`, details: { wpr, prevWpr } };
        }
        return {
            shouldTrade: true,
            direction: 'CALLE',
            confidence: 1,
            reason: `WPR v2FX2 SELL cross ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} below overbought ${CONFIG.WPR_OVERBOUGHT}`,
            details: { wpr, prevWpr }
        };
    }

    static analyze(symbol) {
        const buySig = this.checkBuySignal(symbol);
        if (buySig.shouldTrade) return buySig;
        const sellSig = this.checkSellSignal(symbol);
        if (sellSig.shouldTrade) return sellSig;
        // Prefer more informative reason
        const a = state.assets[symbol];
        return {
            shouldTrade: false,
            direction: null,
            confidence: 0,
            reason: buySig.reason || sellSig.reason || `No WPR v2FX2 signal wpr=${a?.wpr?.toFixed(2) ?? 'n/a'} prev=${a?.prevWpr?.toFixed(2) ?? 'n/a'}`,
            details: { wpr: a?.wpr, prevWpr: a?.prevWpr }
        };
    }
}

// ============================================================
// STAKE CALCULATOR — auto-compounding + martingale (from reference bot)
// ============================================================
//
// INVESTMENT_AMOUNT pool model:
//   • On open:  investmentRemaining -= stake
//   • On WIN:   investmentRemaining += payout (stake + profit)  → pool grows
//   • On LOSS:  stake stays deducted (nothing added back)      → pool shrinks
//   • AUTO_COMPOUNDING: baseStake = max(pool * COMPOUND_PERCENTAGE/100, INITIAL_STAKE)
//
class StakeCalculator {

    static getBaseStake(symbol, investmentRemaining) {
        const cfg = getAssetConfig(symbol);
        if (cfg.AUTO_COMPOUNDING && investmentRemaining > 0) {
            return Math.max(
                Number((investmentRemaining * cfg.COMPOUND_PERCENTAGE / 100).toFixed(2)),
                cfg.INITIAL_STAKE
            );
        }
        return cfg.INITIAL_STAKE;
    }

    static calculate(symbol, martingaleLevel, investmentRemaining) {
        const cfg = getAssetConfig(symbol);
        let level = Math.max(0, martingaleLevel || 0);
        let base = this.getBaseStake(symbol, investmentRemaining);
        base = Math.max(base, cfg.INITIAL_STAKE);

        let stake;
        if (level <= cfg.MAX_MARTINGALE_LEVEL) {
            stake = base * Math.pow(cfg.MARTINGALE_MULTIPLIER, level);
        } else {
            stake = base * Math.pow(cfg.MARTINGALE_MULTIPLIER, cfg.MAX_MARTINGALE_LEVEL);
            const extraIdx = level - cfg.MAX_MARTINGALE_LEVEL - 1;
            for (let i = 0; i <= extraIdx; i++) {
                stake *= (cfg.EXTRA_LEVEL_MULTIPLIERS[i] || cfg.MARTINGALE_MULTIPLIER);
            }

            //reset to base stake after exceeding max martingale + extra levels
            if (level > cfg.MAX_MARTINGALE_LEVEL + cfg.CONTINUE_EXTRA_LEVELS) {
                stake = base;
                level = 0; // Reset level to 0 for calculation
            }
        }

        // Cap at remaining investment pool
        stake = Math.min(stake, investmentRemaining > 0 ? investmentRemaining : stake);
        stake = Math.max(cfg.INITIAL_STAKE, stake);
        return parseFloat(stake.toFixed(2));
    }

    static describe(symbol, investmentRemaining, martingaleLevel) {
        const stake = this.calculate(symbol, martingaleLevel, investmentRemaining);
        const pct = investmentRemaining > 0 ? ((stake / investmentRemaining) * 100).toFixed(2) : '0.00';
        return `$${stake.toFixed(2)} (${pct}% pool, martingale level ${martingaleLevel})`;
    }
}

// ============================================================
// DERIV CANDLE FETCHER — MAX-HISTORY BACKFILL (ported from
// deriv_structure_tester_v5.js): PAT/OTP session + deep backward
// pagination, fetching candles until Deriv stops serving history.
// ============================================================
class DerivCandleFetcher {
    constructor(appId, logger) {
        this.appId = appId || '1089';
        this.logger = logger || LOGGER;
        // Public app_id 1089 is the anonymous fallback feed — custom app_id (33usl...)
        // may 401 on anonymous WS.
        this.wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=1089`;
        this.fallbackUrl = `wss://ws.derivws.com/websockets/v3?app_id=${appId || CONFIG.APP_ID}`;
        // PAT/OTP authenticated session (identical to v5 resolveConnection) — gives
        // the deepest available history for the backtest.
        this._isPat = RestClient.isPat(CONFIG.API_TOKEN);
        this._rest = this._isPat ? new RestClient('https://api.derivws.com', CONFIG.APP_ID, CONFIG.API_TOKEN) : null;
        this._otpUrl = null;
    }

    /**
     * Resolve the OTP session WebSocket URL for the configured PAT token
     * (new Deriv Options API) — same flow as deriv_structure_tester_v5.js.
     */
    async _resolveOtpUrl() {
        if (this._otpUrl) return this._otpUrl;
        if (!this._rest) throw new Error('No PAT rest client available');
        const accRes = await this._rest.get('/trading/v1/options/accounts');
        if (accRes.status !== 200) {
            const msg = accRes.body?.errors?.[0]?.message || accRes.body?.message || JSON.stringify(accRes.body);
            throw new Error(`Account list failed (${accRes.status}): ${msg}`);
        }
        const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
        if (!accounts.length) throw new Error('No Options accounts found for this token');
        const desired = (CONFIG.ACCOUNT_TYPE || 'demo').toLowerCase();
        const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desired) || accounts[0];
        const otpRes = await this._rest.post(`/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`);
        if (otpRes.status !== 200) throw new Error(`OTP failed (${otpRes.status}): ${JSON.stringify(otpRes.body)}`);
        const wsUrl = otpRes.body?.data?.url;
        if (!wsUrl || !/^wss?:/i.test(wsUrl)) throw new Error('OTP response missing data.url');
        this._otpUrl = wsUrl;
        return wsUrl;
    }

    _connectTo(url) {
        return new Promise((resolve, reject) => {
            const w = new WebSocket(url, { handshakeTimeout: 15000 });
            let opened = false;
            const t = setTimeout(() => { if (!opened) { try { w.terminate(); } catch {} reject(new Error('WS connect timeout')); } }, 15000);
            w.on('open', () => { clearTimeout(t); opened = true; resolve(w); });
            w.on('error', e => { clearTimeout(t); if (!opened) reject(e); });
            w.on('unexpected-response', (_req,res)=> { clearTimeout(t); reject(new Error(`Unexpected server response: ${res.statusCode}`)); try{res.destroy();}catch{} });
        });
    }

    /**
     * Prefer the PAT/OTP session (deepest history), else the public app_id
     * feed, else fall back to the custom app_id feed.
     */
    async _connect() {
        let url = null;
        if (this._isPat && this._rest) {
            try {
                url = await this._resolveOtpUrl();
                this.logger.info('Backtest fetcher connected via PAT/OTP session (deepest history available)');
            } catch (e) {
                this.logger.warn(`PAT/OTP resolution failed: ${e.message} — falling back to public feed`);
            }
        }
        if (!url) url = this.wsUrl;
        try {
            return await this._connectTo(url);
        } catch (e) {
            this.logger.warn(`Fetcher connect ${this.wsUrl} failed: ${e.message} — trying fallback`);
            try { return await this._connectTo(this.fallbackUrl); } catch (e2) { this.logger.error(`Fetcher connect failed: ${e2.message}`); throw e2; }
        }
    }
    async fetchCandles(symbol, opts = {}) {
        const granularity = opts.granularity || getAssetConfig(symbol).GRANULARITY || CONFIG.GRANULARITY || 60;
        let want = opts.want || opts.candles || 0;
        if (opts.from && opts.to) {
            const fromSec = Math.floor(new Date(opts.from).getTime() / 1000);
            const toSec = Math.floor(new Date(opts.to).getTime() / 1000);
            if (Number.isFinite(fromSec) && Number.isFinite(toSec) && toSec > fromSec) {
                want = Math.ceil((toSec - fromSec) / granularity);
            }
        } else if (opts.days && Number(opts.days) > 0) {
            want = Math.ceil(Number(opts.days) * 86400 / granularity);
        } else if (!want) {
            // DEFAULT: fetch as much historical data as Deriv will serve (v5-style max backfill).
            want = CONFIG.MAX_CANDLES_FETCH_TARGET || 1000000;
        }
        want = Math.max(1, Math.min(want, CONFIG.MAX_CANDLES_FETCH_HARD || 1200000));
        let end = opts.to ? Math.floor(new Date(opts.to).getTime() / 1000) : 'latest';
        const startEpoch = opts.from ? Math.floor(new Date(opts.from).getTime() / 1000) : null;
        const all = [];
        let guard = 0;
        const maxBatch = Math.max(1, Math.min(CONFIG.CANDLE_FETCH_MAX_BATCH || 1000, 1000));
        const delayMs = CONFIG.CANDLE_FETCH_DELAY_MS ?? 350;
        const maxGuard = Math.ceil(want / maxBatch) + 5;
        let ws = null;
        try { ws = await this._connect(); } catch (e) { this.logger.error(`Fetcher connect failed: ${e.message}`); throw e; }
        const send = (req) => new Promise((resolve, reject) => {
            const id = Date.now() + Math.floor(Math.random()*1000);
            req.req_id = id;
            const timer = setTimeout(() => reject(new Error('ticks_history timeout')), 15000);
            const onMsg = (data) => {
                try {
                    const r = JSON.parse(data);
                    if (r.req_id === id) { ws.off('message', onMsg); clearTimeout(timer); resolve(r); }
                    else if (r.error && r.echo_req && r.echo_req.req_id === id) { ws.off('message', onMsg); clearTimeout(timer); reject(new Error(r.error.message)); }
                } catch {}
            };
            ws.on('message', onMsg);
            try { ws.send(JSON.stringify(req)); } catch (e) { clearTimeout(timer); ws.off('message', onMsg); reject(e); }
        });
        const seenTimes = new Set();
        let earliestEpoch = null;
        try {
            // v5-style deep pagination: walk backwards via end = earliestEpoch-1 and
            // keep requesting until Deriv returns an empty/short batch (history
            // exhausted) or stops honoring the pagination boundary.
            while (all.length < want && guard < maxGuard) {
                guard++;
                const batch = Math.max(1, Math.min(maxBatch, want - all.length));
                const req = { ticks_history: symbol, style: 'candles', granularity, count: batch, end, adjust_start_time: 1 };
                if (startEpoch) req.start = startEpoch;
                let r;
                try { r = await send(req); } catch (e) { this.logger.error(`Fetch batch ${guard} failed: ${e.message}`); break; }
                if (r.error) { this.logger.error(`Fetch error: ${r.error.message}`); break; }
                const candles = (r.candles || []).map(c => ({
                    open: parseFloat(c.open), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close),
                    epoch: c.epoch, open_time: c.epoch - (c.epoch % granularity)
                })).filter(c => Number.isFinite(c.open) && Number.isFinite(c.close));
                if (!candles.length) {
                    this.logger.info(`(${symbol}) server returned 0 more candles — Deriv history exhausted at ${all.length}`);
                    break;
                }
                candles.sort((a,b)=>a.open_time-b.open_time);
                const uniq = candles.filter(c => {
                    if (seenTimes.has(c.open_time)) return false;
                    seenTimes.add(c.open_time);
                    return true;
                });
                if (!uniq.length) {
                    this.logger.info(`(${symbol}) server did not honor pagination — history exhausted at ${all.length}`);
                    break;
                }
                all.unshift(...uniq);
                const earliest = candles[0];
                // Pagination must move strictly backwards; if the server refuses to
                // honour `end`, there is nothing more to fetch.
                if (earliestEpoch !== null && earliest.epoch >= earliestEpoch) {
                    this.logger.info(`(${symbol}) pagination stalled (end=${end}) — history exhausted at ${all.length}`);
                    break;
                }
                earliestEpoch = earliest.epoch;
                if (candles.length < batch) {
                    this.logger.info(`(${symbol}) last batch short: ${candles.length}/${batch} — Deriv history exhausted at ${all.length} candles`);
                    break;
                }
                end = earliest.epoch - 1;
                if (startEpoch && end < startEpoch) break;
                if (all.length < want) {
                    process.stdout.write(`\r  📡 [${symbol}] ${granularity}s backfill: ${all.length} / ${want} candles...`);
                    await new Promise(res=> setTimeout(res, delayMs));
                }
            }
        } finally {
            if (guard > 0) process.stdout.write('\n');
            try { ws.close(); } catch {}
        }
        // sort ascending and trim to want
        all.sort((a,b)=>a.open_time-b.open_time);
        if (all.length > want) return all.slice(-want);
        return all;
    }
}

// ============================================================
// BACKTEST ENGINE — v4 signal-wait replay (mirrors live exactly)
// ============================================================
class BacktestEngine {
    static wilsonLowerBound(wins, n, z=1.645) {
        if (n===0) return 0;
        const p=wins/n, denom=1+(z*z)/n, centre=p+(z*z)/(2*n), margin=z*Math.sqrt((p*(1-p)/n)+(z*z)/(4*n*n));
        return (centre - margin)/denom;
    }
    static breakeven(payout){ return 1/(1+payout); }
    async run(symbol, candles, opts={}) {
        const payoutRatio = Number.isFinite(opts.payoutRatio) ? opts.payoutRatio : (Number.isFinite(opts.payout) ? opts.payout : 0.90);
        const cfg = getAssetConfig(symbol);
        const period = cfg.WPR_PERIOD ?? CONFIG.WPR_PERIOD ?? 14;
        // v4: isolated pool, signal ALWAYS required, stake multiplier only.
        let investmentRemaining = cfg.INVESTMENT_AMOUNT;
        let martingaleLevel = 0;
        let lastTradeDirection = null;
        let consecutiveLosses = 0;
        // v2FX2: no arm flags — every valid cross trades.
        let netPL = 0, totalStake = 0;
        const trades = [];
        const streakCounts = {}; let curStreak = 0, maxStreak = 0;
        // Incremental WPR: sliding N-candle window (avoids O(n²) slice-recompute —
        // required to backtest tens of thousands to a million+ candles fast).
        const wprWindow = [];
        let wprPrev = null;
        // Per-asset guard replica (independent per asset in backtest too).
        const assetPT = cfg.SESSION_PROFIT_TARGET ?? CONFIG.SESSION_PROFIT_TARGET;
        const assetSL = cfg.SESSION_STOP_LOSS ?? CONFIG.SESSION_STOP_LOSS;
        let assetStopped = false;
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            if (assetStopped) continue;
            if (Number.isFinite(assetPT) && netPL >= assetPT) { assetStopped = true; continue; }
            if (Number.isFinite(assetSL) && netPL <= assetSL) { assetStopped = true; continue; }

            // ── Incremental WPR (sliding window, O(period)/candle) ──
            // Mirrors the live MT5 recompute exactly: prevWpr is the WPR of the
            // window ending at the PREVIOUS candle; wpr ends at the current one.
            wprWindow.push(c);
            if (wprWindow.length > period) wprWindow.shift();
            const wpr = TechnicalIndicators.calculateWPR(wprWindow, period);
            const prevWpr = wprPrev;
            wprPrev = wpr;
            // v2FX2: EVERY valid confirmed-candle cross trades (no first-cross filter).
            if (!Number.isFinite(wpr) || !Number.isFinite(prevWpr)) continue;
            const buyCross = prevWpr <= CONFIG.WPR_OVERSOLD && wpr > CONFIG.WPR_OVERSOLD;
            const sellCross = prevWpr >= CONFIG.WPR_OVERBOUGHT && wpr < CONFIG.WPR_OVERBOUGHT;
            let direction = null;
            if (buyCross) direction = 'PUTE';
            else if (sellCross) direction = 'CALLE';
            else continue;
            const isRecoveryTrade = martingaleLevel > 0;
            if (i + 1 >= candles.length) break; // need next candle to settle
            const stake = StakeCalculator.calculate(symbol, martingaleLevel, investmentRemaining);
            if (stake > investmentRemaining) continue;
            // deduct from THIS asset's pool only
            investmentRemaining = Number((investmentRemaining - stake).toFixed(2));
            totalStake += stake;
            const entryClose = c.close;
            const exitClose = candles[i + 1].close;
            const won = direction === 'CALLE' ? exitClose > entryClose : exitClose < entryClose;
            const pnl = won ? Number((stake * payoutRatio).toFixed(2)) : -stake;
            netPL = Number((netPL + pnl).toFixed(2));
            trades.push({ idx: i, open_time: c.open_time, close_time: candles[i + 1].open_time, direction, stake, won, pnl, level: martingaleLevel, isRecovery: isRecoveryTrade });
            // v2FX2: no flag consumption — every valid cross trades.
            // v4 state update mirrors SessionManager.recordTradeResult
            if (won) {
                lastTradeDirection = direction;
                martingaleLevel = 0; consecutiveLosses = 0; curStreak = 0;
                investmentRemaining = Number((investmentRemaining + stake + pnl).toFixed(2));
            } else {
                lastTradeDirection = direction;
                martingaleLevel++;
                consecutiveLosses++; curStreak++; maxStreak = Math.max(maxStreak, curStreak);
                const key = 'x' + Math.min(curStreak, 12);
                streakCounts[key] = (streakCounts[key] || 0) + 1;
                // loss does not credit pool; no cooldown, no exit — wait for next signal
            }
            // next trade can only be after next candle (i+1) is close, so i++ already ensures
        }
        const total=trades.length, wins=trades.filter(t=>t.won).length, losses=total-wins;
        const winRate= total? wins/total:0;
        const breakeven= BacktestEngine.breakeven(payoutRatio);
        const expectancy= total? trades.reduce((s,t)=>s+t.pnl,0)/trades.reduce((s,t)=>s+t.stake,0) : 0; // per stake or per trade? use per trade pnl/stake
        const expectancyPerTrade= total? trades.reduce((s,t)=>s+t.pnl,0)/total : 0;
        const lb= BacktestEngine.wilsonLowerBound(wins,total);
        const successProb= lb; // lower bound as prob
        let verdict;
        if(total < 200) verdict='INSUFFICIENT SAMPLE — need ≥200 trades';
        else if(winRate > breakeven && expectancyPerTrade>0) verdict='POSITIVE EDGE (tentative)';
        else verdict='NO EDGE — do not trade live';
        return {
            symbol, wprPeriod: period, WPR_PERIOD: period, granularity: cfg.GRANULARITY, payoutRatio, breakeven: Number((breakeven*100).toFixed(2)),
            periodFrom: candles[0]?.open_time ? new Date(candles[0].open_time*1000).toISOString() : null,
            periodTo: candles[candles.length-1]?.open_time ? new Date(candles[candles.length-1].open_time*1000).toISOString() : null,
            candles: candles.length, trades: total, wins, losses, winRate: Number((winRate*100).toFixed(2)), lossRate: Number(((losses/total)*100||0).toFixed(2)),
            profitRatio: Number((winRate*100).toFixed(2)), // same as winRate
            netPL: Number(netPL.toFixed(2)), totalStake: Number(totalStake.toFixed(2)), avgStake: total? Number((totalStake/total).toFixed(2)):0,
            expectancyPerTrade: Number(expectancyPerTrade.toFixed(4)), expectancy, breakevenWinRate: Number((breakeven*100).toFixed(2)),
            streakCounts, maxConsecutiveLosses: maxStreak, successProbability: Number((successProb*100).toFixed(2)), wilsonLowerBound: Number((lb*100).toFixed(2)),
            verdict, ranAt: new Date().toISOString(), isRecoveryB: true
        };
    }
    formatReport(r){
        if(!r) return 'No backtest';
        const filtered = Object.keys(r.streakCounts).filter(k=> parseInt(k.slice(1))>=2).sort((a,b)=> parseInt(a.slice(1))-parseInt(b.slice(1)));
        const streakStr = filtered.map(k=> `${k}:${r.streakCounts[k]}`).join(' ') || 'none';
        const xn = r.maxConsecutiveLosses ? `x2..x${r.maxConsecutiveLosses}` : 'x2..xn';
        return [
            `🧪 BACKTEST v2FX2 every-cross — ${r.symbol} (WPR=${r.wprPeriod ?? r.WPR_PERIOD ?? CONFIG.WPR_PERIOD} cross >${CONFIG.WPR_OVERSOLD}→CALLE / cross <${CONFIG.WPR_OVERBOUGHT}→PUTE, ${r.granularity}s, payout ${(r.payoutRatio*100).toFixed(0)}%, stake $${getAssetConfig(r.symbol).INITIAL_STAKE}×${getAssetConfig(r.symbol).MARTINGALE_MULTIPLIER}, pool $${getAssetConfig(r.symbol).INVESTMENT_AMOUNT})`,
            `Period: ${r.periodFrom} → ${r.periodTo} (${r.candles} candles)`,
            `Trades: ${r.trades} (${r.wins}W / ${r.losses}L)  WinRate ${r.winRate}% / Loss ${r.lossRate}% (need ≥ ${r.breakevenWinRate}% BE)`,
            `Profit Ratio: ${r.profitRatio}%  Expectancy/trade: ${r.expectancyPerTrade>=0?'+':''}${r.expectancyPerTrade}  Net P/L: $${r.netPL.toFixed(2)} (staked $${r.totalStake.toFixed(2)}, avg $${r.avgStake.toFixed(2)})`,
            `Streaks ${xn}: ${streakStr}  Max consecutive losses: ${r.maxConsecutiveLosses}`,
            `Success prob (Wilson LB 90%): ${r.successProbability}% (LB) vs BE ${r.breakevenWinRate}% → ${r.wilsonLowerBound}%`,
            `Verdict: ${r.verdict}`,
        ].join('\n');
    }
    formatReportHTML(r){ return this.formatReport(r).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'<br>'); }
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
        const hour = this.getCurrentUTCHour();
        const active = CONFIG.SESSIONS.filter(s => this._inSession(hour, s.start, s.end));
        return { activeSessions: active.map(s => s.name), inSession: active.length > 0, inOverlap: active.length >= 2, gmtHour: hour };
    }

    static getStatusString() {
        const info = this.getSessionInfo();
        const time = `${String(new Date().getUTCHours()).padStart(2, '0')}:${String(new Date().getUTCMinutes()).padStart(2, '0')} UTC`;
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
        return { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0, x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0, x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0, firstTradeDate: null, lastTradeDate: null };
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
                profit: 0, loss: 0, netPL: 0, x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0, x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0, assets: {}, startCapital: state.capital, endCapital: state.capital,
            };
        }
    }

    static ensureAssetDayEntry(dateKey, symbol) {
        this.ensureDayEntry(dateKey);
        if (!tradeHistory.dailyHistory[dateKey].assets[symbol]) {
            tradeHistory.dailyHistory[dateKey].assets[symbol] = { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0, x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0, x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0 };
        }
    }

    static ensureOverallAssetEntry(symbol) {
        if (!tradeHistory.overallAssets[symbol]) {
            tradeHistory.overallAssets[symbol] = { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0, x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0, x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0 };
        }
    }

    static recordTrade(symbol, profit, martingaleLevel = 0) {
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

            if (martingaleLevel >= 2 && martingaleLevel <= 9) {
                const key = `x${martingaleLevel}Losses`;
                dayStats[key]++;
                dayAssetStats[key]++;
                overall[key]++;
                overallAsset[key]++;
            }
        }

        if (!tradeHistory.overall.firstTradeDate) tradeHistory.overall.firstTradeDate = dateKey;
        tradeHistory.overall.lastTradeDate = dateKey;
        tradeHistory.dailyHistory[dateKey].endCapital = state.capital;
        tradeHistory.lastUpdated = Date.now();
        this.saveHistory();
    }

    static getDayStats(dateKey) { this.ensureDayEntry(dateKey); return tradeHistory.dailyHistory[dateKey]; }
    static getTodayStats() { return this.getDayStats(this.getDateKey()); }
    static getOverallStats() { return tradeHistory.overall; }
    static getAllDays() { return Object.keys(tradeHistory.dailyHistory).sort(); }
    static getRecentDays(n = 7) { return this.getAllDays().slice(-n).map(d => ({ date: d, ...tradeHistory.dailyHistory[d] })); }
}

// ============================================================
// STATE PERSISTENCE  [MODIFIED for CANDLE DIRECTION + normal mode]
// ============================================================
class StatePersistence {

    static saveState() {
        try {
            const data = {
                savedAt: Date.now(),
                capital: state.capital,
                session: { ...state.session },
                portfolio: { ...state.portfolio },
                hourlyStats: { ...state.hourlyStats },
                currentTradeDay: state.currentTradeDay,
                stuckTrades: (state.stuckTrades || []).slice(-50),
                assets: {},
            };

            Object.keys(state.assets).forEach(symbol => {
                const a = state.assets[symbol];
                data.assets[symbol] = {
                    closedCandles: a.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED),
                    lastProcessedCandleOpenTime: a.lastProcessedCandleOpenTime,
                    candlesLoaded: a.candlesLoaded,
                    lastTradeDirection: a.lastTradeDirection,
                    lastTradeWasWin: a.lastTradeWasWin,
                    // v4: legacy lock flags forced false on save (compat only)
                    isRecovery: (a.martingaleLevel || 0) > 0,
                    waitingForNewSignal: (a.martingaleLevel || 0) > 0,
                    exclusiveLock: false,
                    forceRecoverDirection: null,
                    recoveryStep: a.recoveryStep,
                    currentStake: a.currentStake,
                    baseStake: a.baseStake,
                    martingaleLevel: a.martingaleLevel,
                    investmentRemaining: a.investmentRemaining,
                    stopped: !!a.stopped,
                    stoppedReason: a.stoppedReason || null,
                    x2Losses: a.x2Losses || 0, x3Losses: a.x3Losses || 0,
                    x4Losses: a.x4Losses || 0, x5Losses: a.x5Losses || 0,
                    x6Losses: a.x6Losses || 0, x7Losses: a.x7Losses || 0,
                    x8Losses: a.x8Losses || 0, x9Losses: a.x9Losses || 0,
                    consecutiveWins: a.consecutiveWins,
                    consecutiveLosses: a.consecutiveLosses,
                    cooldownCandles: a.cooldownCandles,
                    // WPR state
                    wpr: a.wpr ?? null,
                    prevWpr: a.prevWpr ?? null,
                    buyFlagActive: a.buyFlagActive,
                    sellFlagActive: a.sellFlagActive,
                    indicatorsReady: a.indicatorsReady || false,
                    inTradeCycle: a.inTradeCycle,
                    waitingForReentry: a.waitingForReentry,
                    priceReturnedToZone: a.priceReturnedToZone,
                    currentDirection: a.currentDirection,
                    // Normal mode state
                    normalModeActive: a.normalModeActive,
                    tradesInNormalMode: a.tradesInNormalMode,
                    normalModeDirection: a.normalModeDirection,
                    pendingRecovery: a.pendingRecovery || false,
                    recoveryFirstDone: a.recoveryFirstDone || false,
                    // Stats
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
            // v4: capital is recomputed as sum of pools; ignore saved global.
            state.session = { ...state.session, ...data.session };
            state.portfolio = { ...state.portfolio, ...data.portfolio };
            state.hourlyStats = data.hourlyStats || state.hourlyStats;
            state.currentTradeDay = data.currentTradeDay || TradeHistoryManager.getDateKey();
            state.stuckTrades = Array.isArray(data.stuckTrades) ? data.stuckTrades.slice(-50) : (state.stuckTrades || []);

            if (data.assets) {
                Object.keys(data.assets).forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = data.assets[symbol];
                        const a = state.assets[symbol];

                        if (saved.closedCandles?.length) a.closedCandles = saved.closedCandles;
                        a.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                        a.candlesLoaded = false;
                        a.lastTradeDirection = saved.lastTradeDirection || null;
                        a.lastTradeWasWin = saved.lastTradeWasWin ?? null;
                        // v4: derive recovery from martingale; never restore locks.
                        a.martingaleLevel = saved.martingaleLevel || 0;
                        a.isRecovery = a.martingaleLevel > 0;
                        a.waitingForNewSignal = a.martingaleLevel > 0;
                        a.exclusiveLock = false;
                        a.forceRecoverDirection = null;
                        a.recoveryStep = saved.recoveryStep || 0;
                        a.currentStake = saved.currentStake || StakeCalculator.calculate(symbol, 0, a.investmentRemaining);
                        a.baseStake = saved.baseStake || StakeCalculator.getBaseStake(symbol, a.investmentRemaining);
                        a.investmentRemaining = saved.investmentRemaining || getAssetConfig(symbol).INVESTMENT_AMOUNT;
                        a.stopped = saved.stopped || false;
                        a.stoppedReason = saved.stoppedReason || null;
                        for (let lv = 2; lv <= 9; lv++) a[`x${lv}Losses`] = saved[`x${lv}Losses`] || 0;
                        a.consecutiveWins = saved.consecutiveWins || 0;
                        a.consecutiveLosses = saved.consecutiveLosses || 0;
                        a.cooldownCandles = 0;

                        // WPR state
                        a.wpr = Number.isFinite(saved.wpr) ? Number(saved.wpr) : null;
                        a.prevWpr = Number.isFinite(saved.prevWpr) ? Number(saved.prevWpr) : null;
                        a.buyFlagActive = saved.buyFlagActive || false;
                        a.sellFlagActive = saved.sellFlagActive || false;
                        a.indicatorsReady = saved.indicatorsReady || false;
                        a.inTradeCycle = saved.inTradeCycle || false;
                        a.waitingForReentry = saved.waitingForReentry || false;
                        a.priceReturnedToZone = saved.priceReturnedToZone || false;
                        a.currentDirection = saved.currentDirection || null;

                        // Normal mode state
                        a.normalModeActive = saved.normalModeActive || false;
                        a.tradesInNormalMode = saved.tradesInNormalMode || 0;
                        a.normalModeDirection = saved.normalModeDirection || null;
                        a.pendingRecovery = saved.pendingRecovery || false;
                        a.recoveryFirstDone = saved.recoveryFirstDone || false;

                        // Stats
                        a.tradesCount = saved.tradesCount || 0;
                        a.winsCount = saved.winsCount || 0;
                        a.lossesCount = saved.lossesCount || 0;
                        a.netPL = saved.netPL || 0;
                        a.profit = saved.profit || 0;
                        a.loss = saved.loss || 0;
                        a.activePositions = (saved.activePositions || []).map(p => ({ ...p }));

                        const wprTxt = Number.isFinite(a.wpr) ? a.wpr.toFixed(1) : 'n/a';
                        const prevTxt = Number.isFinite(a.prevWpr) ? a.prevWpr.toFixed(1) : 'n/a';
                        LOGGER.info(`${symbol}: L${a.martingaleLevel} Stake=$${(a.currentStake || 0).toFixed(2)} Pool=$${(a.investmentRemaining || 0).toFixed(2)} P/L=$${(a.netPL || 0).toFixed(2)} | WPR ${prevTxt}→${wprTxt} BuyArm=${a.buyFlagActive} SellArm=${a.sellFlagActive} | Wins=${a.winsCount} Losses=${a.lossesCount} Trades=${a.tradesCount}`);
                    }
                });
            }

            SessionManager.recalcGlobalCapital();
            LOGGER.info(`State restored | Pools sum: $${state.capital.toFixed(2)} (independent per asset)`);
            return true;
        } catch (e) { LOGGER.error(`Load state error: ${e.message}`); return false; }
    }

    static startAutoSave() {
        setInterval(() => { if (state.isAuthorized) this.saveState(); }, STATE_SAVE_INTERVAL);
        LOGGER.info(`Auto-save every ${STATE_SAVE_INTERVAL / 1000}s`);
    }
}

// ============================================================
// TELEGRAM SERVICE  [MODIFIED for CANDLE DIRECTION display]
// ============================================================
class TelegramService {

    static hourlyTimerStarted = false;
    static dailyTimerStarted = false;
    static hourlyTimerId = null;
    static dailyTimerId = null;

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

        // Build analysis details for OPEN trades — v4: EVERY trade has a signal
        let analysisDetails = '';
        if (type === 'OPEN' && details) {
            const analysis = details.analysis;
            const wpr = analysis?.details?.wpr;
            const prevWpr = analysis?.details?.prevWpr;
            const wprStr = Number.isFinite(wpr) && Number.isFinite(prevWpr) ? `${prevWpr.toFixed(1)}→${wpr.toFixed(1)}` : 'N/A';
            if (details.isRecovery) {
                analysisDetails = `
        🔄 <b>BizWillRFv2FX2 SIGNAL-WAIT RECOVERY L${a?.martingaleLevel ?? 0}</b> (new WPR signal direction, stake multiplier only)
        🧠 <b>WPR(${CONFIG.WPR_PERIOD}) Signal:</b>
        📊 WPR: ${wprStr} (OB ${CONFIG.WPR_OVERBOUGHT} / OS ${CONFIG.WPR_OVERSOLD})
        📊 Signal: ${analysis?.direction || direction} (${analysis?.reason || ''})`;
            } else if (analysis) {
                analysisDetails = `
        🧠 <b>BizWillRFv2FX2 WPR(${CONFIG.WPR_PERIOD}) Signal:</b>
        📊 WPR: ${wprStr} (OB ${CONFIG.WPR_OVERBOUGHT} / OS ${CONFIG.WPR_OVERSOLD})
        📊 Signal: ${analysis?.direction || 'N/A'} (${analysis?.reason || ''})`;
            }
        }

        // Profit/Loss details for WIN/LOSS trades — per-asset isolation
        let resultDetails = '';
        if (details.profit !== undefined) {
            const profitNum = Number(details.profit) || 0;
            const isWin = profitNum > 0;
            const a = state.assets[symbol];
            resultDetails = `
        ${isWin ? '🟢' : '🔴'} <b>Profit: $${profitNum.toFixed(2)}</b>

        📋 <b>${symbol} Stats (independent):</b>
        W/L: ${a?.winsCount ?? 0}/${a?.lossesCount ?? 0} | P/L: $${(a?.netPL ?? 0).toFixed(2)}
        🔢 Martingale Level: ${a?.martingaleLevel ?? 0} | Pool: $${(a?.investmentRemaining ?? 0).toFixed(2)}
        📉 ${symbol} x2-x9: ${a?.x2Losses || 0}|${a?.x3Losses || 0}|${a?.x4Losses || 0}|${a?.x5Losses || 0}|${a?.x6Losses || 0}|${a?.x7Losses || 0}|${a?.x8Losses || 0}|${a?.x9Losses || 0}
        ${isWin ? '✅ Stake reset to default (L0)' : `⏳ Waiting for NEW signal (next L${(a?.martingaleLevel ?? 0)})`}

        📋 <b>Today (all assets):</b>
        Trades: ${today.tradesCount} | W/L: ${today.winsCount || 0}/${today.lossesCount || 0} | P/L: $${(today.netPL || 0).toFixed(2)}
        💰 Pools sum: $${state.capital.toFixed(2)}

        📋 <b>Overall:</b>
        Trades: ${overall.tradesCount} | W/L: ${overall.winsCount}/${overall.lossesCount} | P/L: $${(overall.netPL || 0).toFixed(2)}`;
        }

        const recoveryStatus = (a?.martingaleLevel || 0) > 0 ? `🔄 RECOVERY L${a.martingaleLevel}` : '🎯 NORMAL';

        const msg = `
        ${emoji} <b>${type} BizWillRFv2FX2 TRADE ALERT - ${recoveryStatus}</b>

        📊 Asset: ${symbol} (pool $${(a?.investmentRemaining ?? 0).toFixed(2)})
        📈 Direction: ${direction === 'CALLE' ? 'RISE 📈' : 'FALL 📉'} (signal direction)
        💵 Stake: $${stake.toFixed(2)}
        ⏱ Duration: ${duration}${(durationUnit || 's').toUpperCase()}
        🔢 Martingale Level: ${a ? a.martingaleLevel : 0}
        ${type !== 'OPEN' ? `📉 ${symbol} x2-x9: ${a?.x2Losses || 0}|${a?.x3Losses || 0}|${a?.x4Losses || 0}|${a?.x5Losses || 0}|${a?.x6Losses || 0}|${a?.x7Losses || 0}|${a?.x8Losses || 0}|${a?.x9Losses || 0}` : ''}
        ${analysisDetails}${resultDetails}
        `.trim();

        await this.sendMessage(msg);
    }

    static async sendHourlySummary() {
        const h = state.hourlyStats;
        if (h.trades === 0) return;
        const wr = h.trades > 0 ? ((h.wins / h.trades) * 100).toFixed(1) : '0.0';
        const today = TradeHistoryManager.getTodayStats();

        let assetInfo = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                assetInfo += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L $${(a.netPL || 0).toFixed(2)} L${a.martingaleLevel || 0} pool $${(a.investmentRemaining || 0).toFixed(2)}${a.stopped ? ' STOPPED' : ''}`;
            }
        });

        await this.sendMessage([
            `⏰ <b>BizWillRFv2FX2 HOURLY SUMMARY (multi-asset independent)</b>`,
            `Last Hour: ${h.trades}t ${h.wins}W/${h.losses}L ${wr}% ${h.pnl >= 0 ? '\u{1f7e2}' : '\u{1f534}'} $${h.pnl.toFixed(2)}`,
            `Today: ${today.tradesCount}t P/L: $${(today.netPL || 0).toFixed(2)}`,
            `Loss Stats: x2:${today.x2Losses || 0} x3:${today.x3Losses || 0} x4:${today.x4Losses || 0} x5:${today.x5Losses || 0} x6:${today.x6Losses || 0} x7:${today.x7Losses || 0} x8:${today.x8Losses || 0} x9:${today.x9Losses || 0}`,
            `Pools sum: $${state.capital.toFixed(2)}`,
            TradingSessionManager.getStatusString(),
            assetInfo ? `\n<b>Per-Asset:</b>${assetInfo}` : '',
        ].join('\n'));

        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };
    }

    static async sendSessionSummary() {
        const stats = SessionManager.getSessionStats();
        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();
        const wr = overall.tradesCount > 0 ? ((overall.winsCount / overall.tradesCount) * 100).toFixed(1) : '0.0';

        let pairBreakdown = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                const pairWr = a.tradesCount > 0 ? ((a.winsCount / a.tradesCount) * 100).toFixed(1) : '0.0';
                pairBreakdown += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L (${pairWr}%) $${(a.netPL || 0).toFixed(2)} L${a.martingaleLevel || 0} pool $${(a.investmentRemaining || 0).toFixed(2)}`;
            }
        });

        await this.sendMessage([
            `\u{1f4ca} <b>BizWillRFv2FX2 SESSION SUMMARY (independent)</b>`,
            `Duration: ${stats.duration} | Trades: ${stats.trades}`,
            `W: ${stats.wins} | L: ${stats.losses} | Win Rate: ${stats.winRate}`,
            `Session P/L: $${(stats.netPL || 0).toFixed(2)}`,
            `Today P/L: $${(today.netPL || 0).toFixed(2)}`,
            ``,
            `\u{1f4cb} <b>Overall:</b> ${overall.tradesCount} trades | WR: ${wr}% | P/L: $${(overall.netPL || 0).toFixed(2)}`,
            pairBreakdown ? `\n<b>Per-Asset:</b>${pairBreakdown}` : '',
            ``,
            `\u{1f4b0} Pools sum: $${state.capital.toFixed(2)}`,
        ].join('\n'));
    }

    static async sendStartupMessage() {
        const overall = TradeHistoryManager.getOverallStats();
        let pairInfo = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const cfg = getAssetConfig(sym);
            pairInfo += `\n  ${sym}: ${CONFIG.TIMEFRAME_LABEL} | ${cfg.DURATION}${cfg.DURATION_UNIT} | stake $${cfg.INITIAL_STAKE} | pool $${cfg.INVESTMENT_AMOUNT}`;
        });

        await this.sendMessage([
            `🤖 <b>BizWillRFv2FX2 STARTED — EVERY-CROSS MULTI-ASSET</b>`,
            `Strategy v2FX2: Williams %R(${CONFIG.WPR_PERIOD}) cross ABOVE ${CONFIG.WPR_OVERSOLD} → CALLE | cross BELOW ${CONFIG.WPR_OVERBOUGHT} → PUTE (every valid cross trades)`,
            `Recovery: SIGNAL-WAIT — after loss wait for NEW signal, trade its direction with x-multiplier until win → reset to default`,
            `Independence: own stake/martingale/x2-x9/pool per asset, concurrent (1 open/asset, ${CONFIG.MAX_TOTAL_POSITIONS} total)`,
            `Pools sum: $${state.capital.toFixed(2)}`,
            TradingSessionManager.getStatusString(),
            ``,
            `📊 Overall: ${overall.tradesCount} trades | P/L: $${(overall.netPL || 0).toFixed(2)}`,
            `<b>Active Assets:</b>${pairInfo}`,
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

    static startDailyTimer() {
        if (this.dailyTimerStarted) return;
        this.dailyTimerStarted = true;
        const now = new Date();
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
        if (this.dailyTimerId) { clearInterval(this.dailyTimerId); this.dailyTimerId = null; this.dailyTimerStarted = false; }
    }
}

// ============================================================
// SESSION MANAGER — v4 TRUE MULTI-ASSET (isolated pools, signal-wait)
// ============================================================
class SessionManager {

    static isSessionActive() { return state.session.isActive; }

    // Global targets are REPORT-ONLY in v4 (never halt other assets).
    static checkSessionTargets() {
        const netPL = state.session?.netPL || 0;
        if (netPL >= CONFIG.SESSION_PROFIT_TARGET) {
            LOGGER.trade(`Global profit milestone: $${netPL.toFixed(2)} (report-only, assets continue)`);
        }
        if (netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.warn(`Global loss milestone: $${netPL.toFixed(2)} (report-only, assets continue)`);
        }
        return false;
    }

    // Per-asset guard — one asset stopping never affects the others.
    static checkAssetTargets(symbol) {
        const a = state.assets[symbol];
        if (!a || a.stopped) return true;
        const cfg = getAssetConfig(symbol);
        const pt = cfg.SESSION_PROFIT_TARGET ?? CONFIG.SESSION_PROFIT_TARGET;
        const sl = cfg.SESSION_STOP_LOSS ?? CONFIG.SESSION_STOP_LOSS;
        if (Number.isFinite(pt) && a.netPL >= pt) {
            a.stopped = true; a.stoppedReason = 'PROFIT_TARGET';
            LOGGER.trade(`[${symbol}] Per-asset profit target $${a.netPL.toFixed(2)} — asset stopped, others continue`);
            TelegramService.sendMessage(`🏁 <b>[${symbol}] BizWillRFv2FX2 PROFIT TARGET</b>\nP/L: $${a.netPL.toFixed(2)}\nPool: $${a.investmentRemaining.toFixed(2)} — others continue`);
            return true;
        }
        if (Number.isFinite(sl) && a.netPL <= sl) {
            a.stopped = true; a.stoppedReason = 'STOP_LOSS';
            LOGGER.error(`[${symbol}] Per-asset stop-loss $${a.netPL.toFixed(2)} — asset stopped, others continue`);
            TelegramService.sendMessage(`🛑 <b>[${symbol}] BizWillRFv2FX2 STOP-LOSS</b>\nP/L: $${a.netPL.toFixed(2)}\nPool: $${a.investmentRemaining.toFixed(2)} — others continue`);
            return true;
        }
        return false;
    }

    static recalcGlobalCapital() {
        try {
            const sum = CONFIG.ACTIVE_ASSETS.reduce((s, sym) => s + (Number(state.assets[sym]?.investmentRemaining) || 0), 0);
            state.capital = Number(sum.toFixed(2));
        } catch (_) { }
    }

    static async endSession(reason) {
        state.session.isActive = false;
        LOGGER.info(`Session ended: ${reason}`);
        await TelegramService.sendSessionSummary();
    }

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
            const dayStats = TradeHistoryManager.getDayStats(state.currentTradeDay);
            TelegramService.sendMessage(
                `\u{1f319} <b>BizWillRFv2FX2 END OF DAY ${state.currentTradeDay}</b>\nP/L: $${(dayStats?.netPL || 0).toFixed(2)}\nCapital: $${state.capital.toFixed(2)}`
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
        state.portfolio = { dailyProfit: 0, dailyLoss: 0, dailyWins: 0, dailyLosses: 0 };
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };

        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                // Day counters reset, but martingale/pool/consecutive losses persist until win.
                a.tradesCount = 0; a.winsCount = 0; a.lossesCount = 0;
                a.profit = 0; a.loss = 0; a.netPL = 0;
            }
        });
    }

    static recordTradeResult(symbol, profit, direction, stake) {
        const a = state.assets[symbol];
        if (!a) return;

        this.checkDayChange();

        // v4: NO global capital deduction/credit per trade.
        // Each asset owns its pool (deducted on open, payout credited here).
        // state.capital is a reporting sum only.

        const hour = new Date().getUTCHours();
        if (hour !== state.hourlyStats.lastHour) {
            state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: hour };
        }

        state.session.tradesCount++;
        state.hourlyStats.trades++;
        state.hourlyStats.pnl += profit;
        a.tradesCount++;

        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            state.hourlyStats.wins++;
            a.winsCount++;
            a.profit += profit; a.netPL += profit;
            a.consecutiveWins++;
            a.consecutiveLosses = 0;
            a.recoveryStep = 0;
            // WIN resets stake to default — recovery chain ends.
            a.martingaleLevel = 0;
            a.cooldownCandles = 0;
            a.lastTradeWasWin = true;
            // Clear legacy flags (compat — always false in v4).
            a.forceRecoverDirection = null;
            a.isRecovery = false;
            a.waitingForNewSignal = false;
            a.exclusiveLock = false;
            a.pendingRecovery = false;
            a.recoveryFirstDone = false;

            // Credit payout (stake + profit) back to THIS asset's pool only.
            a.investmentRemaining = Number((a.investmentRemaining + stake + profit).toFixed(2));
            a.baseStake = StakeCalculator.getBaseStake(symbol, a.investmentRemaining);
            a.currentStake = StakeCalculator.calculate(symbol, 0, a.investmentRemaining);

            LOGGER.trade(`WIN [${symbol}] +$${(profit || 0).toFixed(2)} | ${direction} | P/L: $${(a.netPL || 0).toFixed(2)} | stake reset to $${a.currentStake.toFixed(2)} (L0)`);
            this.checkAssetTargets(symbol);
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            state.hourlyStats.losses++;
            a.lossesCount++;
            a.loss += Math.abs(profit);
            a.netPL += profit;
            a.consecutiveLosses++;
            a.consecutiveWins = 0;
            a.lastTradeWasWin = false;
            // v4 signal-wait: NO same-direction, NO exclusive lock, NO cooldown.
            // Only the stake multiplier advances; next trade waits for a fresh WPR signal.
            a.martingaleLevel = (a.martingaleLevel || 0) + 1;
            a.isRecovery = a.martingaleLevel > 0; // informational only (L>0 = in recovery)
            a.waitingForNewSignal = true; // informational: waiting for next valid signal
            a.exclusiveLock = false;
            a.forceRecoverDirection = null;
            a.pendingRecovery = false;
            a.recoveryFirstDone = false;

            // Per-asset x2..x9 loss tracking (this asset only).
            if (a.martingaleLevel >= 2 && a.martingaleLevel <= 9) {
                const key = `x${a.martingaleLevel}Losses`;
                state.session[key]++;
                a[key] = (a[key] || 0) + 1;
            }

            a.currentStake = StakeCalculator.calculate(symbol, a.martingaleLevel, a.investmentRemaining);

            LOGGER.trade(`LOSS [${symbol}] -$${Math.abs(profit || 0).toFixed(2)} | ${direction} | waiting for NEW WPR signal | Next Stake: $${(a.currentStake || 0).toFixed(2)} (martingale L${a.martingaleLevel})`);
            this.checkAssetTargets(symbol);
        }

        this.recalcGlobalCapital();
        TradeHistoryManager.recordTrade(symbol, profit, a.martingaleLevel);
    }
}

// ============================================================
// STATE — v4 TRUE MULTI-ASSET (capital = reporting sum of pools)
// ============================================================
const state = {
    assets: {},
    // Reporting only: sum of all investmentRemaining. Never deducted directly.
    capital: CONFIG.ACTIVE_ASSETS.reduce((s, sym) => s + (getAssetConfig(sym).INVESTMENT_AMOUNT || 0), 0) || DEFAULT_ASSET_CONFIG.INVESTMENT_AMOUNT,
    accountBalance: 0,
    currentTradeDay: null,
    session: {
        profit: 0, loss: 0, netPL: 0,
        tradesCount: 0, winsCount: 0, lossesCount: 0,
        x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
        x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0,
        isActive: true, startTime: Date.now(), startCapital: CONFIG.ACTIVE_ASSETS.length ? getAssetConfig(CONFIG.ACTIVE_ASSETS[0]).INVESTMENT_AMOUNT : DEFAULT_ASSET_CONFIG.INVESTMENT_AMOUNT,
    },
    isConnected: false,
    isAuthorized: false,
    portfolio: { dailyProfit: 0, dailyLoss: 0, dailyWins: 0, dailyLosses: 0 },
    hourlyStats: { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() },
    requestId: 1,
    lastSessionLogTime: 0,
    tradeWatchdogTimer: null,
    tradeWatchdogPollTimer: null,
    pendingTradeInfo: null,
    tradeStartTime: null,
    currentContractId: null,
    // Audit trail of stuck trades force-recovered with unknown outcome (cap 50).
    stuckTrades: [],
};

let tradeHistory = null;

// ============================================================
// CONNECTION MANAGER  [MODIFIED initializeAssets + handleOHLC]
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
            LOGGER.info('PAT token detected-> using NEW Deriv API (OTP flow)');
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
                const assetConfig = getAssetConfig(symbol);
                state.assets[symbol] = {
                    candles: [], closedCandles: [],
                    currentFormingCandle: null,
                    lastProcessedCandleOpenTime: null,
                    candlesLoaded: false,
                    // WPR state — Williams %R only
                    wpr: null,
                    prevWpr: null,
                    buyFlagActive: false,
                    sellFlagActive: false,
                    indicatorsReady: false,
                    lastTradeDirection: null,
                    lastTradeWasWin: null,
                    // v4: isRecovery = martingaleLevel>0 (informational only, no lock).
                    // Legacy flags kept for state-file compat, always false/managed per new logic.
                    isRecovery: false,
                    waitingForNewSignal: false,
                    exclusiveLock: false,
                    forceRecoverDirection: null,
                    recoveryStep: 0,
                    currentStake: assetConfig.INITIAL_STAKE,
                    baseStake: assetConfig.INITIAL_STAKE,
                    martingaleLevel: 0,
                    // INDEPENDENT pool — never touched by other assets.
                    investmentRemaining: assetConfig.INVESTMENT_AMOUNT,
                    canTrade: false,
                    stopped: false,
                    stoppedReason: null,
                    consecutiveWins: 0,
                    consecutiveLosses: 0,
                    cooldownCandles: 0,
                    activePositions: [],
                    tradesCount: 0, winsCount: 0, lossesCount: 0,
                    profit: 0, loss: 0, netPL: 0,
                    // Per-asset x2..x9 loss counters (independent).
                    x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
                    x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0,

                    // state
                    inTradeCycle: false,
                    waitingForReentry: false,
                    priceReturnedToZone: false,
                    currentDirection: null,

                    // Normal mode state (legacy, unused in v4)
                    normalModeActive: false,
                    tradesInNormalMode: 0,
                    normalModeDirection: null,
                    normalModePaused: false,
                    pendingRecovery: false,
                    recoveryFirstDone: false,

                    // Last analysis for notifications
                    lastAnalysis: null,
                };
                LOGGER.info(`Initialized asset: ${symbol} (Stake: $${assetConfig.INITIAL_STAKE}, Pool: $${assetConfig.INVESTMENT_AMOUNT}, Duration: ${assetConfig.DURATION}${assetConfig.DURATION_UNIT})`);
            } else {
                // Ensure v4 fields exist on resume from older state files.
                const a = state.assets[symbol];
                if (a.stopped === undefined) a.stopped = false;
                for (let lv = 2; lv <= 9; lv++) { if (a[`x${lv}Losses`] === undefined) a[`x${lv}Losses`] = 0; }
                if (!Number.isFinite(a.investmentRemaining)) a.investmentRemaining = getAssetConfig(symbol).INVESTMENT_AMOUNT;
                if (!Number.isFinite(a.martingaleLevel)) a.martingaleLevel = 0;
                // Legacy locks must never survive into v4.
                a.exclusiveLock = false; a.waitingForNewSignal = a.martingaleLevel > 0;
                a.isRecovery = a.martingaleLevel > 0; a.cooldownCandles = 0;
                a.forceRecoverDirection = null; a.pendingRecovery = false; a.recoveryFirstDone = false;
            }
        });
        SessionManager.recalcGlobalCapital();
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
            case 'balance': state.accountBalance = r.balance.balance; break;
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
            if (bot) bot._clearBuyAckTimeout(reqId);
            if (reqId) {
                CONFIG.ACTIVE_ASSETS.forEach(sym => {
                    const a = state.assets[sym];
                    if (a?.activePositions) {
                        const i = a.activePositions.findIndex(p => p.reqId === reqId);
                        if (i >= 0) {
                            // Refund THIS asset's pool (stake was deducted on open).
                            const [pos] = a.activePositions.splice(i, 1);
                            if (pos && Number.isFinite(pos.stake)) {
                                a.investmentRemaining = Number((a.investmentRemaining + pos.stake).toFixed(2));
                                SessionManager.recalcGlobalCapital();
                            }
                            a.canTrade = true;
                        }
                    }
                });
            }
            if (bot) bot._releaseTradeLockForReq(reqId);
            return;
        }

        const contract = r.buy;
        LOGGER.trade(`Contract opened: ${contract.contract_id} | Buy Price: $${contract.buy_price}`);

        const reqId = r.echo_req.req_id;
        if (bot) bot._clearBuyAckTimeout(reqId);
        let matched = false;
        for (const sym of CONFIG.ACTIVE_ASSETS) {
            const a = state.assets[sym];
            if (a?.activePositions) {
                const pos = a.activePositions.find(p => p.reqId === reqId);
                if (pos) {
                    pos.contractId = contract.contract_id;
                    pos.buyPrice = contract.buy_price;
                    pos.openTime = Date.now();

                    bot._startTradeWatchdog(contract.contract_id);
                    matched = true;
                    break;
                }
            }
        }

        if (!matched) {
            // Late success for a request we already refunded/timed out (or unknown):
            // a LIVE contract may exist on Deriv with no tracked position — never trade blind.
            const wasRefunded = bot && bot._refundedReqIds && bot._refundedReqIds.has(String(reqId));
            LOGGER.error(`Buy success for unknown req ${reqId} → contract ${contract.contract_id} has NO tracked position${wasRefunded ? ' (req was ack-timed-out and refunded)' : ''} — NOT tracking. VERIFY/MANAGE ON DERIV MANUALLY.`);
            TelegramService.sendMessage(
                `🚨 <b>BizWillRFv2FX2 UNTRACKED CONTRACT ${contract.contract_id}</b>\n` +
                `Buy success for unknown req ${reqId} (price $${contract.buy_price})\n` +
                `Bot is NOT tracking it — manage/close it ON DERIV MANUALLY`
            );
            if (wasRefunded && bot) bot._refundedReqIds.delete(String(reqId));
            // Still subscribe so settlement updates arrive for the loud late-settlement path.
            this.send({ proposal_open_contract: 1, contract_id: contract.contract_id, subscribe: 1 });
            return;
        }

        this.send({ proposal_open_contract: 1, contract_id: contract.contract_id, subscribe: 1 });
    }

    handleOpenContract(r) {
        if (r.error) {
            LOGGER.error(`Contract error: ${r.error.message}`);
            if (bot) bot._releaseTradeLockForContract(null);
            return;
        }

        const contract = r.proposal_open_contract;
        const contractId = contract.contract_id;
        const contractIdStr = String(contractId);

        if (r.subscription?.id) this._subscriptionIds.set(contractIdStr, r.subscription.id);

        // Late settlement for a contract we already force-recovered: NEVER
        // double-count it — the assumed loss stands. Alert loudly for manual reconcile.
        const stuckIdx = (state.stuckTrades || []).findIndex(s => String(s.contractId) === contractIdStr);
        if (stuckIdx >= 0) {
            const entry = state.stuckTrades[stuckIdx];
            const actualWon = Number(contract.profit) >= 0;
            LOGGER.error(`LATE SETTLEMENT ${contractIdStr} (${entry.symbol}): actual ${actualWon ? `WIN +$${Number(contract.profit).toFixed(2)}` : `LOSS -$${Math.abs(Number(contract.profit)).toFixed(2)}`} but it was already accounted as assumed LOSS. ` +
                (actualWon
                    ? `Manually ADD the $${Number(contract.profit).toFixed(2)} payout to ${entry.symbol}'s pool (or reset that asset) to reconcile.`
                    : `Matches the assumed loss — no action needed.`));
            TelegramService.sendMessage(
                `🚨 <b>BizWillRFv2FX2 LATE SETTLEMENT ${contractIdStr} (${entry.symbol})</b>\n` +
                `Actual: ${actualWon ? `WIN +$${Number(contract.profit).toFixed(2)}` : `LOSS`} | Accounted: assumed LOSS $${entry.stake.toFixed(2)}\n` +
                (actualWon
                    ? `ACTION: manually add $${Number(contract.profit).toFixed(2)} payout to ${entry.symbol}'s pool.\n`
                    : `Matches assumption — no action needed.\n`) +
                `Entry kept for audit.`
            );
            if (r.subscription?.id) this.send({ forget: r.subscription.id });
            return;
        }

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

            LOGGER.warn(`Contract ${contractId} settled but still not found after retry — ignoring (other assets unaffected)`);
            if (bot) bot._releaseTradeLockForContract(contractId);
            return;
        }

        bot._processedContracts.add(contractIdStr);
        bot._clearWatchdogFor(contractId);

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

        if (r.subscription?.id) this.send({ forget: r.subscription.id });

        SessionManager.checkSessionTargets();
        StatePersistence.saveState();
        // v4: NO immediate same-direction recovery. Next trade waits for a new WPR signal (see handleOHLC→executeNextTrade).
    }

    // ════════════════════════════════════════════════════════
    // OHLC HANDLER — ONLY a confirmed candle close may trigger trade logic.
    // A close is confirmed when the exchange rolls to a NEW candle:
    //   incoming.open_time > prevForming.open_time (forward only), AND
    //   incoming.open_time >= prevForming.open_time + granularity
    // (i.e. a full candle interval elapsed). Ticks for the still-forming
    // candle only update currentFormingCandle — never WPR, never trades.
    // ════════════════════════════════════════════════════════
    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        const a = state.assets[symbol];
        if (!a) return;

        const gran = getAssetConfig(symbol).GRANULARITY || CONFIG.GRANULARITY;
        const rawOpenTime = ohlc.open_time != null ? Number(ohlc.open_time) : NaN;
        const tickEpoch = Number(ohlc.epoch);
        // Prefer exchange open_time; fall back to flooring tick epoch (same formula as history).
        const openTime = Number.isFinite(rawOpenTime)
            ? rawOpenTime
            : (Number.isFinite(tickEpoch) ? Math.floor(tickEpoch / gran) * gran : NaN);
        if (!Number.isFinite(openTime)) {
            LOGGER.error(`[${symbol}] Invalid OHLC timing (open_time=${ohlc.open_time} epoch=${ohlc.epoch}) — ignored`);
            return;
        }

        const incoming = {
            open: parseFloat(ohlc.open), high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low), close: parseFloat(ohlc.close),
            epoch: ohlc.epoch, open_time: openTime,
        };

        if ([incoming.open, incoming.high, incoming.low, incoming.close].some(isNaN)) {
            LOGGER.error(`[${symbol}] Invalid OHLC data`);
            return;
        }

        const prev = a.currentFormingCandle;

        // No forming candle yet (fresh start / just after history seed) —
        // this tick STARTS the forming candle. Nothing is closed. Never trade.
        if (prev == null || prev.open_time === undefined || prev.open_time === null) {
            a.currentFormingCandle = incoming;
            const idx0 = a.candles.findIndex(c => c.open_time === incoming.open_time);
            if (idx0 >= 0) a.candles[idx0] = incoming;
            else a.candles.push(incoming);
            LOGGER.debug(`[${symbol}] Forming candle started @${incoming.open_time} — waiting for close, no signal`);
            return;
        }

        // Same candle still forming — update OHLC, no close, no WPR, no trade.
        if (incoming.open_time === prev.open_time) {
            a.currentFormingCandle = incoming;
            const idx = a.candles.findIndex(c => c.open_time === incoming.open_time);
            if (idx >= 0) a.candles[idx] = incoming;
            else a.candles.push(incoming);
            if (a.candles.length > CONFIG.MAX_CANDLES_STORED) {
                a.candles = a.candles.slice(-CONFIG.MAX_CANDLES_STORED);
            }
            return;
        }

        // Out-of-order / late tick for an older candle — ignore, never close.
        if (incoming.open_time < prev.open_time) {
            LOGGER.debug(`[${symbol}] Ignored out-of-order tick (tick open_time ${incoming.open_time} < forming ${prev.open_time})`);
            return;
        }

        // New candle ahead — CONFIRM the previous candle only if a full
        // interval elapsed. Guards against a stray tick with a jumped open_time.
        const expectedNext = prev.open_time + gran;
        if (incoming.open_time < expectedNext) {
            LOGGER.debug(`[${symbol}] Ignored unconfirmed rollover (tick open_time ${incoming.open_time} < expected ${expectedNext})`);
            return;
        }
        if (Number.isFinite(tickEpoch) && tickEpoch < expectedNext) {
            LOGGER.debug(`[${symbol}] Ignored rollover before interval end (tick epoch ${tickEpoch} < ${expectedNext}) — keeping forming candle`);
            return;
        }
        if (incoming.open_time > expectedNext) {
            LOGGER.warn(`[${symbol}] Gap detected: forming @${prev.open_time} but next tick @${incoming.open_time} (missed ${Math.round((incoming.open_time - expectedNext) / gran)} candle(s)) — closing confirmed candle, gap will backfill on next history sync`);
        }

        // ── CONFIRMED CLOSE: prev forming candle is now final ──
        {
            const closed = { ...prev };
            closed.epoch = closed.open_time + gran;

            if (closed.open_time !== a.lastProcessedCandleOpenTime) {
                const alreadyIn = a.closedCandles.some(c => c.open_time === closed.open_time);

                if (!alreadyIn) {
                    a.closedCandles.push(closed);
                    a.lastProcessedCandleOpenTime = closed.open_time;

                    if (a.closedCandles.length > CONFIG.MAX_CANDLES_STORED) {
                        a.closedCandles = a.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED);
                    }

                    // ── WPR update on closed candle — MT5 exact: recompute both bars from windows ──
                    const wprCfg = getAssetConfig(symbol);
                    const wprPeriod = wprCfg.WPR_PERIOD ?? CONFIG.WPR_PERIOD ?? 14;
                    if (a.closedCandles.length >= wprPeriod) {
                        // MT5 calculates WPR per bar from its own N-bar window; we recompute prev and current from correct slices
                        const curWpr = TechnicalIndicators.calculateWPR(a.closedCandles, wprPeriod);
                        const prevWpr = a.closedCandles.length >= wprPeriod + 1
                            ? TechnicalIndicators.calculateWPR(a.closedCandles.slice(0, -1), wprPeriod)
                            : null;
                        if (Number.isFinite(curWpr) && Number.isFinite(prevWpr)) {
                            a.prevWpr = prevWpr;
                            a.wpr = curWpr;
                            a.indicatorsReady = true;
                            SignalManager.updateWPRState(symbol);
                            LOGGER.debug(`[${symbol}] WPR ${a.prevWpr.toFixed(2)}→${a.wpr.toFixed(2)} BuyArm=${a.buyFlagActive} SellArm=${a.sellFlagActive}`);
                        } else if (Number.isFinite(curWpr)) {
                            // Not enough history for prev yet — store cur, wait next bar for valid cross
                            a.prevWpr = null;
                            a.wpr = curWpr;
                            a.indicatorsReady = false;
                            SignalManager.updateWPRState(symbol);
                            LOGGER.debug(`[${symbol}] WPR n/a→${a.wpr.toFixed(2)} (warming up) BuyArm=${a.buyFlagActive} SellArm=${a.sellFlagActive}`);
                        }
                    }

                    const dir = closed.close > closed.open ? '\u{1f7e2}' : '\u{1f534}';
                    const time = new Date(closed.epoch * 1000).toISOString();
                    LOGGER.candle(`${dir} [${symbol}] CANDLE CLOSED [${time}] O:${closed.open.toFixed(5)} H:${closed.high.toFixed(5)} L:${closed.low.toFixed(5)} C:${closed.close.toFixed(5)} | Total: ${a.closedCandles.length}`);

                    // v4: no cooldown — signal-wait recovery only (cooldown always 0).
                    if (a.cooldownCandles > 0) {
                        a.cooldownCandles = 0;
                        a.forceRecoverDirection = null;
                        LOGGER.info(`❄️ [${symbol}] Cool-down: ${a.cooldownCandles} candles remaining`);
                    }

                    a.canTrade = true;

                    // v4 TRUE MULTI-ASSET: never block on other assets.
                    // Signal-wait recovery handled inside executeNextTrade.
                    try {
                        bot.executeNextTrade(symbol, closed);
                    } catch (err) {
                        LOGGER.error(`[${symbol}] Trade execution error: ${err.message}`);
                        bot._releaseTradeLockForAsset(symbol);
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

        // Same candle-bucketing formula as live handleOHLC: floor(epoch/gran)*gran.
        // (Deriv history `epoch` is the candle open time; never subtract gran.)
        const gran = getAssetConfig(symbol).GRANULARITY || CONFIG.GRANULARITY;
        const incomingCandles = (r.candles || []).map(c => ({
            open: parseFloat(c.open), high: parseFloat(c.high),
            low: parseFloat(c.low), close: parseFloat(c.close),
            epoch: c.epoch, open_time: Math.floor(c.epoch / gran) * gran,
        })).sort((x, y) => x.open_time - y.open_time);

        if (!incomingCandles.length) { LOGGER.warn(`[${symbol}] No candles received`); return; }

        const a = state.assets[symbol];

        // The LAST history entry is the still-forming candle — it must NOT be
        // treated as closed (no WPR, no signal, no trade on unconfirmed data).
        const forming = incomingCandles[incomingCandles.length - 1];
        const closedHistory = incomingCandles.slice(0, -1);

        // FIX: Merge only CONFIRMED candles with existing instead of replacing.
        // This prevents losing candles that closed during a disconnect.
        const existingEpochs = new Set(a.closedCandles.map(c => c.open_time));
        let addedCount = 0;

        for (const c of closedHistory) {
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
        // Seed the forming candle so the next rollover produces exactly one confirmed close.
        a.currentFormingCandle = { ...forming };

        const lastClosed = a.closedCandles[a.closedCandles.length - 1];
        if (lastClosed && (!a.lastProcessedCandleOpenTime || lastClosed.open_time > a.lastProcessedCandleOpenTime)) {
            a.lastProcessedCandleOpenTime = lastClosed.open_time;
        }

        a.candlesLoaded = true;

        // ── Seed WPR state from CONFIRMED history only ──
        if (a.closedCandles.length >= (getAssetConfig(symbol).WPR_PERIOD ?? CONFIG.WPR_PERIOD ?? 14)) {
            SignalManager.seedWPRState(symbol);
            LOGGER.info(`[${symbol}] WPR seeded from ${a.closedCandles.length} confirmed candles (+1 forming @${forming.open_time}): ${a.prevWpr?.toFixed(2) ?? 'n/a'}→${a.wpr?.toFixed(2) ?? 'n/a'} BuyArm=${a.buyFlagActive} SellArm=${a.sellFlagActive}`);
        }

        LOGGER.info(
            `[${symbol}] Loaded ${incomingCandles.length} ${CONFIG.TIMEFRAME_LABEL} candles (${addedCount} new confirmed merged, total confirmed: ${a.closedCandles.length}) |`
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
            TelegramService.sendMessage(`⚠️ <b>BizWillRFv2FX2 BOT CONNECTION LOST</b> — Reconnecting (attempt ${this.reconnectAttempts})`);

            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (this.isShuttingDown) return;
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached — giving up');
            TelegramService.sendMessage(`\u{1f6d1} <b>BizWillRFv2FX2 BOT STOPPED</b> — Max reconnections\nFinal P/L: $${(state.session.netPL || 0).toFixed(2)}`);
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
// MAIN BOT CLASS — v4 TRUE MULTI-ASSET + SIGNAL-WAIT RECOVERY
// ============================================================
class IndexBot {

    constructor() {
        this.connection = new ConnectionManager();
        this._processedContracts = new Set();
        // v4: no global trade lock — concurrency is per-asset (1 open/asset).
        // _tradeLocked kept as compat getter (true if any position open).
        this.tradeWatchdogMs = 960000; //16mins
        this._watchdogTimers = new Map(); // contractId -> timeout (also 'req:<reqId>' buy-ack timers)
        // Buy-ack: max wait for a `buy` response before the position is treated
        // as an orphan (no contractId → no settlement will ever arrive).
        this.buyAckMs = 30000;
        // Watchdog re-subscribe attempts before forcing stuck recovery.
        this.watchdogPolls = 3;
        this.watchdogPollGapMs = 30000;
        // reqIds refunded by the buy-ack timeout (late buy success = live untracked contract).
        this._refundedReqIds = new Set();
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

    get _tradeLocked() {
        return CONFIG.ACTIVE_ASSETS.some(s => (state.assets[s]?.activePositions?.length || 0) > 0);
    }
    set _tradeLocked(_) { /* compat no-op — v4 uses per-asset positions */ }

    async start() {
        console.log('\n' + '═'.repeat(74));
        console.log(' DERIV CALLE/PUTE BOT v2FX2 — EVERY-CROSS + SIGNAL-WAIT RECOVERY');
        console.log('═'.repeat(74));
        console.log(`Assets    : ${CONFIG.ACTIVE_ASSETS.join(', ')} (independent pools/stakes)`);
        console.log(`WPR v2FX2    : Period=${CONFIG.WPR_PERIOD} OB=${CONFIG.WPR_OVERBOUGHT} OS=${CONFIG.WPR_OVERSOLD} | BUY: cross ABOVE -80 → CALLE | SELL: cross BELOW -20 → PUTE (every valid cross)`);
        console.log(`Timeframe : ${CONFIG.TIMEFRAME_LABEL} candles | Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT} | Recovery: wait for NEW signal, stake x-multiplier, reset on win`);
        console.log(`Risk      : Per-asset martingale pools: ${CONFIG.ACTIVE_ASSETS.map(s => `${s}=$${getAssetConfig(s).INVESTMENT_AMOUNT}`).join(', ')}`);
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

        LOGGER.info('WILLRFv2 BOT fully started!');
    }

    subscribeToCandles(symbol) {
        if (this.connection.activeSubscriptions.has(symbol)) {
            LOGGER.debug(`Already subscribed to ${symbol}`);
            return;
        }

        LOGGER.info(`Subscribing to ${symbol} (${CONFIG.TIMEFRAME_LABEL})...`);

        // Load historical candles
        this.connection.send({
            ticks_history: symbol, adjust_start_time: 1,
            count: CONFIG.CANDLES_TO_LOAD, end: 'latest', start: 1,
            style: 'candles', granularity: CONFIG.GRANULARITY,
        });

        // Subscribe to live candles
        this.connection.send({
            ticks_history: symbol, adjust_start_time: 1,
            count: 1, end: 'latest', start: 1,
            style: 'candles', granularity: CONFIG.GRANULARITY, subscribe: 1,
        });

        this.connection.activeSubscriptions.add(symbol);
    }

    _getTradeDuration(symbol) {
        const assetConfig = getAssetConfig(symbol);
        return { duration: assetConfig.DURATION, durationUnit: assetConfig.DURATION_UNIT, remaining: null };
    }

    _executeBuy(symbol, direction, isRecovery, analysis) {
        const assetState = state.assets[symbol];
        if (!assetState) return null;
        const stake = assetState.currentStake;
        if (stake > assetState.investmentRemaining) {
            LOGGER.error(`[${symbol}] Insufficient pool: stake $${stake} > remaining $${assetState.investmentRemaining.toFixed(2)} (L${assetState.martingaleLevel})`);
            assetState.canTrade = false;
            return null;
        }
        // v4: deduct from THIS asset's pool only; recalc global sum for reporting.
        assetState.investmentRemaining = Number((assetState.investmentRemaining - stake).toFixed(2));
        SessionManager.recalcGlobalCapital();

        const { duration, durationUnit } = this._getTradeDuration(symbol);

        if (isRecovery) {
            const wprStr = analysis?.details?.wpr != null && analysis?.details?.prevWpr != null
                ? `${analysis.details.prevWpr.toFixed(2)}→${analysis.details.wpr.toFixed(2)}`
                : `wpr=${assetState.wpr?.toFixed(2) ?? 'n/a'}`;
            LOGGER.trade(`   Recovery: SIGNAL-WAIT L${assetState.martingaleLevel} | WPR ${wprStr} → ${direction} (signal direction) | Stake: $${stake.toFixed(2)} | Pool left: $${assetState.investmentRemaining.toFixed(2)} | ${analysis?.reason || ''}`);
        } else {
            const wprStr = analysis?.details?.wpr != null && analysis?.details?.prevWpr != null
                ? `${analysis.details.prevWpr.toFixed(2)}→${analysis.details.wpr.toFixed(2)}`
                : `wpr=${assetState.wpr?.toFixed(2) ?? 'n/a'}`;
            LOGGER.trade(`   Recovery Mode: NO | WPR(${CONFIG.WPR_PERIOD}) ${wprStr} → ${direction} | Stake: $${stake.toFixed(2)} | Martingale: L${assetState.martingaleLevel} | Duration: ${duration}${durationUnit} | ${analysis?.reason || ''}`);
        }

        assetState.canTrade = false;
        assetState.lastTradeDirection = direction;

        const position = {
            symbol, direction, stake, duration, durationUnit,
            entryTime: Date.now(), contractId: null, reqId: null, currentProfit: 0, buyPrice: 0
        };
        assetState.activePositions.push(position);

        TelegramService.sendTradeAlert('OPEN', symbol, direction, stake, duration, durationUnit, {
            isRecovery,
            analysis,
            recoveryDuration: isRecovery ? duration : null,
            recoveryDurationUnit: isRecovery ? durationUnit : null
        });

        const symbolKey = this.connection && this.connection._isPat ? 'underlying_symbol' : 'symbol';
        const tradeRequest = {
            buy: 1,
            subscribe: 1,
            price: Number(stake).toFixed(2),
            parameters: {
                contract_type: direction,
                [symbolKey]: symbol,
                currency: 'USD',
                amount: Number(stake).toFixed(2),
                duration,
                duration_unit: durationUnit,
                basis: 'stake'
            }
        };
        const reqId = this.connection.send(tradeRequest);
        if (reqId == null) {
            // Send failed (WS not open) — no contract exists, refund pool immediately.
            assetState.activePositions.splice(assetState.activePositions.indexOf(position), 1);
            assetState.investmentRemaining = Number((assetState.investmentRemaining + stake).toFixed(2));
            SessionManager.recalcGlobalCapital();
            assetState.canTrade = true;
            LOGGER.error(`[${symbol}] Buy NOT sent (WS not open) — pool refunded $${stake.toFixed(2)}, asset freed`);
            StatePersistence.saveState();
            return null;
        }
        position.reqId = reqId;
        this._startBuyAckTimeout(symbol, reqId);
        StatePersistence.saveState();
        return position;
    }

    // ── Buy-ack timeout: a position with no contractId can never settle ──
    _startBuyAckTimeout(symbol, reqId) {
        const key = `req:${reqId}`;
        const old = this._watchdogTimers.get(key);
        if (old) clearTimeout(old);
        const timer = setTimeout(() => {
            this._watchdogTimers.delete(key);
            const a = state.assets[symbol];
            if (!a) return;
            const i = (a.activePositions || []).findIndex(p => p.reqId === reqId && (p.contractId == null));
            if (i < 0) return; // buy response arrived in time
            const [pos] = a.activePositions.splice(i, 1);
            // No contractId → Deriv holds no position for us in the normal case:
            // refund pool, free asset, alert (operator verifies no charge on Deriv).
            if (pos && Number.isFinite(pos.stake)) {
                a.investmentRemaining = Number((a.investmentRemaining + pos.stake).toFixed(2));
                SessionManager.recalcGlobalCapital();
            }
            a.canTrade = true;
            this._refundedReqIds.add(String(reqId));
            if (this._refundedReqIds.size > 200) {
                this._refundedReqIds = new Set([...this._refundedReqIds].slice(-100));
            }
            LOGGER.error(`[${symbol}] Buy ACK timeout (req ${reqId}, ${this.buyAckMs / 1000}s, no contractId) — orphan removed, pool refunded $${(pos?.stake || 0).toFixed(2)}. VERIFY on Deriv that no contract was created.`);
            TelegramService.sendMessage(
                `⚠️ <b>[${symbol}] BizWillRFv2FX2 BUY ACK TIMEOUT</b>\n` +
                `No buy response in ${this.buyAckMs / 1000}s (req ${reqId})\n` +
                `Orphan removed, pool refunded $${(pos?.stake || 0).toFixed(2)}\n` +
                `⚠️ VERIFY ON DERIV that no contract was created for this request`
            );
            StatePersistence.saveState();
        }, this.buyAckMs);
        this._watchdogTimers.set(key, timer);
    }

    _clearBuyAckTimeout(reqId) {
        if (reqId == null) return;
        const key = `req:${reqId}`;
        const t = this._watchdogTimers.get(key);
        if (t) { clearTimeout(t); this._watchdogTimers.delete(key); }
    }

    // Legacy stub — v4 never trades same-direction immediate. Always returns false.
    // Kept so old state/settlement code paths don't crash if called.
    executeRecoveryTradeImmediate(symbol) {
        LOGGER.debug(`[${symbol}] executeRecoveryTradeImmediate deprecated in v4 (signal-wait only)`);
        return false;
    }

    // ════════════════════════════════════════════════════════
    // CORE TRADE LOGIC v4 — WPR signal ALWAYS required.
    // Recovery = stake multiplier only: after a loss, wait for the next
    // valid WPR signal and trade ITS direction with L>0 stake. Repeat
    // until a win resets to L0. Assets never block each other.
    // Called on every candle close for that symbol only.
    // ════════════════════════════════════════════════════════
    executeNextTrade(symbol, lastClosedCandle) {
        const assetState = state.assets[symbol];
        if (!assetState) return;
        if (!assetState.canTrade) return;
        if (!SessionManager.isSessionActive()) return;
        if (assetState.stopped) return;

        const assetConfig = getAssetConfig(symbol);

        const totalPositions = CONFIG.ACTIVE_ASSETS.reduce(
            (sum, s) => sum + (state.assets[s]?.activePositions?.length ?? 0), 0
        );
        if (totalPositions >= CONFIG.MAX_TOTAL_POSITIONS) {
            LOGGER.debug(`[${symbol}] Max total positions (${totalPositions}/${CONFIG.MAX_TOTAL_POSITIONS})`);
            return;
        }
        if (assetState.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) return;
        if (!state.isAuthorized) {
            LOGGER.warn(`[${symbol}] Not authorized yet — cannot place trade`);
            return;
        }
        // Per-asset pool check only (never global capital).
        if (assetState.currentStake > assetState.investmentRemaining) {
            LOGGER.warn(`[${symbol}] Insufficient pool: need $${assetState.currentStake.toFixed(2)}, have $${assetState.investmentRemaining.toFixed(2)}`);
            return;
        }
        if (SessionManager.checkAssetTargets(symbol)) {
            assetState.canTrade = false;
            return;
        }

        // WPR must be ready — both fresh entries and recoveries need a signal.
        const wprPeriod = assetConfig.WPR_PERIOD ?? CONFIG.WPR_PERIOD ?? 14;
        if (!assetState.indicatorsReady || !Number.isFinite(assetState.wpr) || !Number.isFinite(assetState.prevWpr)) {
            LOGGER.info(`[${symbol}] WPR not ready: ${assetState.prevWpr?.toFixed(2) ?? 'n/a'}→${assetState.wpr?.toFixed(2) ?? 'n/a'} (need ${wprPeriod} candles)`);
            assetState.canTrade = false;
            return;
        }
        const analysis = SignalManager.analyze(symbol);
        assetState.lastAnalysis = analysis;

        if (!analysis.shouldTrade) {
            LOGGER.info(`[${symbol}] No trade — ${analysis.reason}${assetState.martingaleLevel > 0 ? ` (waiting for signal to recover L${assetState.martingaleLevel})` : ''}`);
            assetState.canTrade = false;
            return;
        }

        const direction = analysis.direction;
        const isRecovery = assetState.martingaleLevel > 0;
        if (isRecovery) {
            LOGGER.trade(`🔄 [${symbol}] RECOVERY SIGNAL L${assetState.martingaleLevel} WPR(${wprPeriod}) ${analysis.details.prevWpr?.toFixed(2) ?? ''}→${analysis.details.wpr?.toFixed(2) ?? ''} → ${direction} (signal direction, NOT same-direction) | ${analysis.reason}`);
        } else {
            LOGGER.trade(`🎯 [${symbol}] WPR v2FX2 SIGNAL WPR(${wprPeriod}) ${analysis.details.prevWpr?.toFixed(2) ?? ''}→${analysis.details.wpr?.toFixed(2) ?? ''} → ${direction} | ${analysis.reason}`);
        }
        // v2FX2: no flag consumption — every valid cross trades.

        this._executeBuy(symbol, direction, isRecovery, analysis);
    }

    // ── WATCHDOG v4 — per-contract timers (concurrent-safe) ─────
    // Fires at tradeWatchdogMs, then re-subscribes up to `watchdogPolls`
    // times before forcing stuck recovery (never gives up on 1 attempt).
    _startTradeWatchdog(contractId) {
        this._clearWatchdogFor(contractId);
        const key = String(contractId);

        const attempt = (n) => {
            const stillOpen = CONFIG.ACTIVE_ASSETS.some(sym =>
                (state.assets[sym]?.activePositions || []).some(p => String(p.contractId) === key));
            if (!stillOpen) { this._watchdogTimers.delete(key); return; }

            if (n === 0) LOGGER.warn(`WATCHDOG fired for contract ${contractId}`);

            if (state.isConnected && state.isAuthorized) {
                this.connection.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });

                if (n + 1 < this.watchdogPolls) {
                    const poll = setTimeout(() => {
                        this._watchdogTimers.delete(key + ':poll');
                        attempt(n + 1);
                    }, this.watchdogPollGapMs);
                    this._watchdogTimers.set(key + ':poll', poll);
                } else {
                    const last = setTimeout(() => {
                        this._watchdogTimers.delete(key + ':poll');
                        const so = CONFIG.ACTIVE_ASSETS.some(sym =>
                            (state.assets[sym]?.activePositions || []).some(p => String(p.contractId) === key));
                        if (!so) return;
                        LOGGER.error(`WATCHDOG: ${this.watchdogPolls} polls exhausted for ${contractId} — forcing recovery`);
                        this._recoverStuckTrade(`watchdog-timeout-${contractId}`, contractId);
                    }, this.watchdogPollGapMs);
                    this._watchdogTimers.set(key + ':poll', last);
                }
            } else {
                this._recoverStuckTrade('watchdog-offline', contractId);
            }
        };

        const timer = setTimeout(() => attempt(0), this.tradeWatchdogMs);
        this._watchdogTimers.set(key, timer);
    }

    _clearWatchdogFor(contractId) {
        if (contractId == null) return;
        const key = String(contractId);
        for (const k of [key, key + ':poll']) {
            const t = this._watchdogTimers.get(k);
            if (t) { clearTimeout(t); this._watchdogTimers.delete(k); }
        }
        // Legacy single-timer compat
        if (state.tradeWatchdogTimer) { clearTimeout(state.tradeWatchdogTimer); state.tradeWatchdogTimer = null; }
        if (state.tradeWatchdogPollTimer) { clearTimeout(state.tradeWatchdogPollTimer); state.tradeWatchdogPollTimer = null; }
    }

    _clearAllWatchdogTimers() {
        for (const t of this._watchdogTimers.values()) { try { clearTimeout(t); } catch (_) { } }
        this._watchdogTimers.clear();
        if (state.tradeWatchdogTimer) { clearTimeout(state.tradeWatchdogTimer); state.tradeWatchdogTimer = null; }
        if (state.tradeWatchdogPollTimer) { clearTimeout(state.tradeWatchdogPollTimer); state.tradeWatchdogPollTimer = null; }
    }

    // v4 lock helpers — per-asset / per-contract, never global.
    _releaseTradeLockForAsset(symbol) {
        const a = state.assets[symbol];
        if (a) a.canTrade = true;
        LOGGER.warn(`[${symbol}] Trade lock released (per-asset, others unaffected)`);
    }

    _releaseTradeLockForContract(contractId) {
        if (contractId != null) this._clearWatchdogFor(contractId);
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a && a.activePositions.length === 0) a.canTrade = true;
        });
    }

    _releaseTradeLockForReq(reqId) {
        if (reqId != null) {
            CONFIG.ACTIVE_ASSETS.forEach(sym => {
                const a = state.assets[sym];
                if (a && !(a.activePositions || []).some(p => p.reqId === reqId)) a.canTrade = true;
            });
        }
    }

    _forceReleaseTradeLock() {
        // Compat stub — releases per-asset canTrade without touching other assets' pools.
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a && a.activePositions.length === 0) a.canTrade = true;
        });
        LOGGER.warn('Trade lock force-released (v4 per-asset no-op)');
    }

    // Stuck recovery — outcome UNKNOWN. Conservative assumed-LOSS so the
    // martingale chain stays mathematically correct:
    //   • pool: NOT refunded (stake was already deducted at open — same as a real loss)
    //   • martingaleLevel/consecutiveLosses/xN/history: incremented via recordTradeResult
    //   • next trade waits for a fresh WPR signal with the multiplied stake
    // If the contract actually WON on Deriv, the pool is understated by the
    // payout — the audit entry + Telegram alert carry the exact reconcile info.
    _recoverStuckTrade(reason, contractId = null) {
        LOGGER.warn(`Stuck trade recovery: ${reason}`);
        if (contractId != null) this._clearWatchdogFor(contractId);
        else this._clearAllWatchdogTimers();

        // Stop Deriv pushing stale updates for a contract we no longer track.
        if (contractId != null) {
            const subId = this.connection && this.connection._subscriptionIds
                ? this.connection._subscriptionIds.get(String(contractId))
                : null;
            if (subId != null && this.connection) {
                try { this.connection.send({ forget: subId }); } catch (_) { }
                this.connection._subscriptionIds.delete(String(contractId));
            }
        }

        if (contractId) this._processedContracts.add(String(contractId));

        if (contractId != null) {
            let ownerSym = null, pos = null;
            CONFIG.ACTIVE_ASSETS.forEach(sym => {
                const a = state.assets[sym];
                if (a?.activePositions && !pos) {
                    const i = a.activePositions.findIndex(p => String(p.contractId) === String(contractId));
                    if (i >= 0) { ownerSym = sym; pos = a.activePositions[i]; a.activePositions.splice(i, 1); }
                }
            });
            if (!pos) {
                LOGGER.warn(`Stuck recovery ${contractId}: position already gone — nothing to assume, audit only`);
                CONFIG.ACTIVE_ASSETS.forEach(sym => {
                    const a = state.assets[sym];
                    if (a && a.activePositions.length === 0) a.canTrade = true;
                });
                StatePersistence.saveState();
                return;
            }
            const a = state.assets[ownerSym];
            // Model exactly like a real loss with this stake (pool untouched — already deducted).
            SessionManager.recordTradeResult(ownerSym, -pos.stake, pos.direction, pos.stake);
            a.canTrade = true;
            const entry = {
                contractId: String(contractId), symbol: ownerSym,
                stake: pos.stake, direction: pos.direction,
                duration: pos.duration, durationUnit: pos.durationUnit,
                reason, assumedLoss: true, time: Date.now(),
            };
            state.stuckTrades.push(entry);
            if (state.stuckTrades.length > 50) state.stuckTrades = state.stuckTrades.slice(-50);
            LOGGER.error(`[${ownerSym}] STUCK ${contractId} assumed LOSS -$${pos.stake.toFixed(2)} ${pos.direction} → L${a.martingaleLevel} next $${a.currentStake.toFixed(2)}. If it actually WON on Deriv, add the payout back to ${ownerSym}'s pool manually.`);
        } else {
            // Legacy path: release empty assets only, never wipe other assets.
            CONFIG.ACTIVE_ASSETS.forEach(sym => {
                const a = state.assets[sym];
                if (a && a.activePositions.length === 0) a.canTrade = true;
            });
        }

        SessionManager.recalcGlobalCapital();
        const last = contractId != null ? state.stuckTrades[state.stuckTrades.length - 1] : null;
        TelegramService.sendMessage(
            `⚠️ <b>BizWillRFv2FX2 BOT STUCK TRADE [${reason}]</b>\n` +
            (last
                ? `Contract: ${last.contractId} (${last.symbol} ${last.direction} $${last.stake.toFixed(2)})\n` +
                  `Accounted as assumed LOSS → ${last.symbol} now L${state.assets[last.symbol]?.martingaleLevel ?? '?'} (next $${(state.assets[last.symbol]?.currentStake || 0).toFixed(2)})\n`
                : `Contract: ${contractId}\n`) +
            `⚠️ Outcome UNKNOWN — VERIFY ON DERIV.\n` +
            `If it WON, manually add the payout to that asset's pool (or let the next win reset the chain).\n` +
            `Pools sum: $${state.capital.toFixed(2)}`
        );

        StatePersistence.saveState();
    }

    stop() {
        LOGGER.info('Stopping bot...');
        CONFIG.ACTIVE_ASSETS.forEach(sym => { if (state.assets[sym]) state.assets[sym].canTrade = false; });
        TelegramService.clearTimers();
        if (typeof stopTelegramPolling === 'function') { try { stopTelegramPolling(); } catch(_){} }
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
                    recoveryStep: a.recoveryStep,
                    isRecovery: (a.martingaleLevel || 0) > 0,
                    martingaleLevel: a.martingaleLevel || 0,
                    stopped: !!a.stopped,
                    currentStake: a.currentStake,
                    pool: a.investmentRemaining,
                    activePositions: a.activePositions.length,
                    consecutiveLosses: a.consecutiveLosses,
                    wpr: a.wpr,
                    prevWpr: a.prevWpr,
                    trades: a.tradesCount, wins: a.winsCount, losses: a.lossesCount, netPL: a.netPL,
                    lastDirection: a.lastTradeDirection,
                    buyFlag: a.buyFlagActive,
                    sellFlag: a.sellFlagActive,
                    x2: a.x2Losses || 0, x3: a.x3Losses || 0, x4: a.x4Losses || 0,
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
// BACKTEST CLI + TELEGRAM HANDLER
// ============================================================
function parseBacktestArgs(argv) {
    const a = { backtest:false, asset:null, days:null, from:null, to:null, payout:null, candles:null };
    for(let i=0;i<argv.length;i++){
        const k=argv[i];
        if(k==='--backtest') a.backtest=true;
        else if(k==='--asset' && argv[i+1]) { a.asset=argv[++i]; }
        else if(k==='--days' && argv[i+1]) { a.days=argv[++i]; }
        else if(k==='--from' && argv[i+1]) { a.from=argv[++i]; }
        else if(k==='--to' && argv[i+1]) { a.to=argv[++i]; }
        else if(k==='--payout' && argv[i+1]) { a.payout=Number(argv[++i]); }
        else if(k==='--candles' && argv[i+1]) { a.candles=Number(argv[++i]); }
        else if(k.startsWith('--asset=')) a.asset=k.split('=')[1];
        else if(k.startsWith('--days=')) a.days=k.split('=')[1];
    }
    return a;
}
async function runBacktestCLI(opts) {
    const symbols = (!opts.asset || opts.asset.toLowerCase()==='all') ? CONFIG.ACTIVE_ASSETS : [opts.asset];
    const payoutRatio = Number.isFinite(opts.payout) ? opts.payout : 0.90;
    LOGGER.info(`🧪 BACKTEST standalone: ${symbols.join(', ')} | ${opts.days && Number(opts.days)>0 ? opts.days+'d' : opts.candles? opts.candles+' candles' : opts.from&&opts.to ? opts.from+':'+opts.to : 'MAX history (as much as Deriv serves)'} | payout ${(payoutRatio*100).toFixed(0)}%`);
    const fetcher = new DerivCandleFetcher(CONFIG.APP_ID, LOGGER);
    const engine = new BacktestEngine();
    const reports=[];
    for(const sym of symbols){
        if(!CONFIG.ACTIVE_ASSETS.includes(sym) && !Object.keys(ASSET_CONFIGS).includes(sym)){
            LOGGER.warn(`Skipping unknown asset ${sym}`);
            continue;
        }
        LOGGER.info(`Fetching candles for ${sym}...`);
        let candles;
        try { candles = await fetcher.fetchCandles(sym, opts); } catch(e){ LOGGER.error(`Fetch failed for ${sym}: ${e.message}`); continue; }
        LOGGER.info(`Fetched ${candles.length} candles for ${sym} (${candles[0]?new Date(candles[0].open_time*1000).toISOString():'-'} → ${candles[candles.length-1]?new Date(candles[candles.length-1].open_time*1000).toISOString():'-'})`);
        const report = await engine.run(sym, candles, {payoutRatio});
        reports.push(report);
        console.log('\n' + engine.formatReport(report) + '\n');
        const fname = `bizWillRFv2FX2-backtest-${sym}-${new Date().toISOString().slice(0,10).replace(/-/g,'')}.json`;
        try { fs.writeFileSync(path.join(__dirname, fname), JSON.stringify(report,null,2)); LOGGER.info(`Report saved: ${fname}`);} catch(e){ LOGGER.error(`Save report failed: ${e.message}`);}
        // also per-candle CSV-like detail if needed
    }
    if(reports.length>1){
        console.log('\n══════════════════════════════════════════');
        console.log('SUMMARY (all assets)');
        reports.forEach(r=> console.log(`${r.symbol}: ${r.trades} trades WR ${r.winRate}% Net $${r.netPL.toFixed(2)} Verdict ${r.verdict}`));
        console.log('══════════════════════════════════════════\n');
    }
}
// Singleton to prevent duplicate polling within same process
let _tgPollingBot = null;
let _tgPollingActive = false;
function startTelegramBacktestPolling(){
    if(!CONFIG.TELEGRAM_ENABLED || !CONFIG.TELEGRAM_BOT_TOKEN) return;
    if(CONFIG.TELEGRAM_POLLING_ENABLED === false) {
        LOGGER.info('Telegram polling disabled (CONFIG.TELEGRAM_POLLING_ENABLED=false) — send-only mode, no 409 risk');
        return;
    }
    if(_tgPollingActive && _tgPollingBot) {
        LOGGER.warn('Telegram polling already active — skipping duplicate start');
        return;
    }
    try {
        const TelegramBot = require('node-telegram-bot-api');
        const tbot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, {
            polling: { interval: 2000, params: { timeout: 10 } }
        });
        _tgPollingBot = tbot;
        _tgPollingActive = true;
        LOGGER.info('Telegram backtest polling started (/backtest)');
        let conflictCount = 0;
        tbot.on('message', async (msg) => {
            const chatId = String(msg.chat?.id||'');
            if(chatId !== String(CONFIG.TELEGRAM_CHAT_ID)) return;
            const text=(msg.text||'').trim();
            if(!text.toLowerCase().startsWith('/backtest')) return;
            const parts=text.split(/\s+/);
            // /backtest [R_50] [30d|7d|2025-07-01:2025-08-01] [payout 0.90]
            let asset=parts[1]||'all';
            let days=null, from=null, to=null;
            if(parts[2]){
                const p=parts[2];
                if(p.includes(':')){ const [f,t]=p.split(':'); from=f; to=t; }
                else if(p.endsWith('d')) days=parseInt(p);
                else if(!isNaN(Number(p))) days=Number(p);
            }
            const payoutArg=parts[3]? Number(parts[3]): null;
            if(asset && !CONFIG.ACTIVE_ASSETS.includes(asset) && asset!=='all'){
                await tbot.sendMessage(chatId, `Unknown asset ${asset}. Active: ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
                return;
            }
            await tbot.sendMessage(chatId, `🧪 Backtest started: ${asset} ${days && Number(days)>0 ? days+'d' : from&&to ? from+':'+to : 'MAX history'} ...`);
            try {
                const fetcher=new DerivCandleFetcher(CONFIG.APP_ID, LOGGER);
                const engine=new BacktestEngine();
                const syms= asset==='all'? CONFIG.ACTIVE_ASSETS : [asset];
                for(const sym of syms){
                    const candles=await fetcher.fetchCandles(sym, {days, from, to, payoutRatio:payoutArg});
                    const report=await engine.run(sym,candles,{payoutRatio: payoutArg||0.90});
                    await tbot.sendMessage(chatId, engine.formatReport(report), {parse_mode:'HTML'});
                }
            } catch(e){
                await tbot.sendMessage(chatId, `Backtest failed: ${e.message}`);
            }
        });
        tbot.on('polling_error', e=> {
            const msg = e?.message || String(e);
            if(msg.includes('409') || msg.includes('Conflict') || msg.includes('terminated by other getUpdates')) {
                conflictCount++;
                LOGGER.warn(`TG poll 409 Conflict (#${conflictCount}): another bot instance is polling this token — stopping polling on this instance to avoid spam. Fix: kill other bot processes using the same TELEGRAM_BOT_TOKEN (${CONFIG.TELEGRAM_BOT_TOKEN.slice(0,12)}...) or set TELEGRAM_POLLING_ENABLED=false on one, or use a separate token per bot.`);
                try { tbot.stopPolling({ cancel: true }); } catch(_){}
                _tgPollingActive = false;
                if(conflictCount >= 1) {
                    // Prevent retry spam — keep polling off for this run
                    try { tbot.removeAllListeners('polling_error'); } catch(_){}
                    LOGGER.warn('TG polling disabled for this run due to 409 — send-only Telegram (alerts) still works');
                }
                return;
            }
            LOGGER.error(`TG poll: ${msg}`);
        });
        tbot.on('error', e=> LOGGER.error(`TG error: ${e?.message || e}`));
    } catch(e){ LOGGER.error(`Telegram backtest poll init failed: ${e.message}`); }
}
function stopTelegramPolling(){
    if(_tgPollingBot) {
        try { _tgPollingBot.stopPolling({ cancel: true }); } catch(_){}
        try { _tgPollingBot.removeAllListeners(); } catch(_){}
        _tgPollingBot = null;
    }
    _tgPollingActive = false;
}

// ============================================================
// INITIALIZATION
// ============================================================
tradeHistory = TradeHistoryManager.loadHistory();
const bot = new IndexBot();

process.on('SIGINT', () => { try{ stopTelegramPolling(); }catch(_){} bot.stop(); bot.connection.shutdown(); setTimeout(() => process.exit(0), 3000); });
process.on('SIGTERM', () => { try{ stopTelegramPolling(); }catch(_){} bot.stop(); bot.connection.shutdown(); setTimeout(() => process.exit(0), 3000); });
process.on('uncaughtException', (err) => { LOGGER.error(`UNCAUGHT: ${err.message}\n${err.stack}`); try { StatePersistence.saveState(); } catch { } });
process.on('unhandledRejection', (reason) => { LOGGER.error(`UNHANDLED: ${reason}`); try { StatePersistence.saveState(); } catch { } });

const cliArgs = parseBacktestArgs(process.argv.slice(2));
if (cliArgs.backtest) {
    // standalone backtest — do not start live bot
    (async()=>{
        try { await runBacktestCLI(cliArgs); } catch(e){ LOGGER.error(`Backtest fatal: ${e.message}\n${e.stack}`);} finally { process.exit(0); }
    })();
} else {
    const stateLoaded = StatePersistence.loadState();
    LOGGER.info(stateLoaded ? 'Resuming from saved state' : 'Starting fresh session');

    if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
        console.error('\n⚠️  Set CONFIG.API_TOKEN before running!\n');
        process.exit(1);
    }

    console.log('\n\u{1f680} Starting WPR BOT v2FX2 EVERY-CROSS (Williams %R)...\n');
    bot.connection.connect();
    // start Telegram backtest listener in live mode (optional)
    startTelegramBacktestPolling();

    // ── Status display every 60s (v4 per-asset) ─────────────────────
    const statusInterval = setInterval(() => {
        if (!state.isAuthorized) return;

        const status = bot.getStatus();

        // v4 safety: per-position stuck check (entryTime per position, 7min)
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            (a?.activePositions || []).forEach(pos => {
                const elapsed = Date.now() - (pos.entryTime || pos.openTime || Date.now());
                if (elapsed > CONFIG.TRADE_WATCHDOG_MS && pos.contractId) {
                    LOGGER.error(`SAFETY: [${sym}] Trade ${pos.contractId} stuck ${Math.round(elapsed / 1000)}s — forcing recovery`);
                    bot._recoverStuckTrade(`safety-timeout-${pos.contractId}`, pos.contractId);
                }
            });
        });

        let pairLines = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const p = status.pairs[sym];
            if (p) {
                const wpr = p.wpr != null ? `WPR:${p.wpr.toFixed(1)}` : 'WPR:n/a';
                const rec = p.isRecovery ? `🔄L${p.martingaleLevel}` : '🎯L0';
                const stop = p.stopped ? '⛔STOP' : '';

                pairLines += `\n  ${sym}: ${wpr} ${p.buyFlag ? '🟢BF' : ''} ${p.sellFlag ? '🔴SF' : ''} ${rec}${stop} $${(p.currentStake || 0).toFixed(2)} pool $${(p.pool || 0).toFixed(2)} | ${p.trades}t ${p.wins}W/${p.losses}L $${(p.netPL || 0).toFixed(2)} | Pos:${p.activePositions} CL:${p.consecutiveLosses} x2:${p.x2 || 0} x3:${p.x3 || 0} x4:${p.x4 || 0}  x5:${p.x5 || 0} x6:${p.x6 || 0} x7:${p.x7 || 0} x8:${p.x8 || 0} x9:${p.x9 || 0}`;
            }
        });

        console.log(`\n📊 ${getGMTTime()} | Session: ${status.session.trades}t ${status.session.winRate} $${(status.session.netPL || 0).toFixed(2)} | Pools sum: $${status.capital.toFixed(2)}`);
        console.log(`\u{1f4cb} Overall: ${status.overall.tradesCount}t | P/L: $${(status.overall.netPL || 0).toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
        console.log(`\u{1f555} ${TradingSessionManager.getStatusString()}`);
        console.log(`\u{1f4c8} Assets:${pairLines}`);

    }, 60000);

    bot.statusDisplayIntervalId = statusInterval;
}
