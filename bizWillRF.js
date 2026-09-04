'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DERIV SYNTHETIC INDICES CALLE/PUTE BOT — v3  "WILLIAMS %R ONLY"        ║
 * ║  STRATEGY:                                                               ║
 * ║  WPR_PERIOD (default 14, configurable via CONFIG.WPR_PERIOD)             ║
 * ║  BUY:  WPR crosses above -20 (prev <= -20 → cur > -20) — FIRST cross     ║
 * ║        since coming from oversold (-80) → CALLE (Rise)                   ║
 * ║  SELL: WPR crosses below -80 (prev >= -80 → cur < -80) — FIRST cross     ║
 * ║        since coming from overbought (-20) → PUTE (Fall)                  ║
 * ║  Recovery (B + Exclusive): on loss → same direction, first 58s (finish  ║
 * ║  current candle, no skip), then 1m every candle. If                      ║
 * ║  MAX_CONSECUTIVE_LOSSES (default 2) reached (initial+recoveries) → exit  ║
 * ║  recovery, impose COOLDOWN_CANDLES, wait for new WPR signal. Only        ║
 * ║  recovery asset may trade until win (exclusive).                         ║
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
const STATE_FILE = path.join(__dirname, 'bizWillRF_1-state.json');
const HISTORY_FILE = path.join(__dirname, 'bizWillRF_1-history.json');
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
    API_TOKEN: 'pat_27a3197287bae3ec6c2c9cbdd68fffaa2a524e3b0a6e1ecf298b5ffb338adb10',
    APP_ID: '33uslPtthXBEkQOdfKfoY',
    ACCOUNT_TYPE: 'demo',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // ── Recovery Strategy (from willRF.js) ──────────────
    // When enabled: After a loss, trade immediately on next candle in SAME direction (no analysis)
    // When disabled: After a loss, wait for pattern analysis signal
    USE_RECOVERY_STRATEGY: true,

    // ── Session / daily guards ───────────────────
    SESSION_PROFIT_TARGET: 500000,
    SESSION_STOP_LOSS: -208,
    COOLDOWN_CANDLES: 1,

    // ── Candle / Contract Settings (defaults, overridable per asset) ──
    GRANULARITY: 60,
    TIMEFRAME_LABEL: '1m',
    CANDLES_TO_LOAD: 100,
    MAX_CANDLES_STORED: 100,
    DURATION: 1,
    DURATION_UNIT: 'm',

    // ── Williams %R Settings (user configurable) ──────────────
    WPR_PERIOD: 7,
    WPR_OVERBOUGHT: -20,
    WPR_OVERSOLD: -80,
    // ── Recovery exit: max consecutive losses (initial + recoveries) before waiting for new signal
    MAX_CONSECUTIVE_LOSSES: 3,

    // ── Trading Sessions (synthetics trade 24/7) ─────────────
    USE_TRADING_SESSIONS: true,
    SESSIONS: [
        { name: 'LONDON_OPEN', start: 1, end: 17 },
        { name: 'NY_OPEN', start: 12, end: 23 },
    ],

    // ── Position Management ───────────────────────────────────
    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    MAX_TOTAL_POSITIONS: 1,
    MAX_TRADES_PER_CYCLE: 1,

    // ── Active Index Assets ───────────────────────────────────
    ACTIVE_ASSETS: [
        'R_10',
        // 'R_25',
        // 'R_50',
        'R_75',
        'R_100',
        '1HZ10V',
        '1HZ25V',
        '1HZ50V',
        '1HZ75V',
        '1HZ100V',
        'stpRNG',
        'stpRNG2',
        // 'stpRNG3',
        // 'stpRNG4',
        // 'stpRNG5'
    ],

    // ── Misc ──────────────────────────────────────────────────
    DEBUG_MODE: true,
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8565754902:AAHS6UQWEgLJ0DO-JTpAGQhZLs-UDVVNAQc',
    TELEGRAM_CHAT_ID: '752497117',
    // Set to true to enable /backtest Telegram polling — keep false if same token used by other bots to avoid 409 Conflict
    TELEGRAM_POLLING_ENABLED: false,
};

// ============================================================
// PER-ASSET CONFIGURATION (from willRF.js)
// ============================================================
const DEFAULT_ASSET_CONFIG = {
    // Candle Settings
    GRANULARITY: 60,
    TIMEFRAME_LABEL: '1m',

    // Trade Duration
    DURATION: 1,
    DURATION_UNIT: 'm',

    // Stake Settings
    INITIAL_STAKE: 0.35,
    INVESTMENT_AMOUNT: 208,

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
    STOP_LOSS: 208,
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
// SIGNAL MANAGER — WPR-only signal detection
// ============================================================
class SignalManager {
    static seedWPRState(symbol) {
        const a = state.assets[symbol];
        if (!a) return false;
        const cfg = getAssetConfig(symbol);
        const period = cfg.WPR_PERIOD ?? CONFIG.WPR_PERIOD ?? 14;
        const series = TechnicalIndicators.calculateWPRSeries(a.closedCandles, period);
        if (!series.length) return false;
        let buyArmed = false;
        let sellArmed = false;
        let previous = null;
        for (const point of series) {
            const cur = point.value;
            if (cur <= CONFIG.WPR_OVERSOLD) buyArmed = true;
            if (cur >= CONFIG.WPR_OVERBOUGHT) sellArmed = true;
            if (Number.isFinite(previous)) {
                if (previous <= CONFIG.WPR_OVERBOUGHT && cur > CONFIG.WPR_OVERBOUGHT && buyArmed) {
                    buyArmed = false;
                }
                if (previous >= CONFIG.WPR_OVERSOLD && cur < CONFIG.WPR_OVERSOLD && sellArmed) {
                    sellArmed = false;
                }
            }
            previous = cur;
        }
        a.prevWpr = series.length > 1 ? series[series.length - 2].value : null;
        a.wpr = series[series.length - 1].value;
        a.buyFlagActive = buyArmed;
        a.sellFlagActive = sellArmed;
        a.indicatorsReady = Number.isFinite(a.prevWpr) && Number.isFinite(a.wpr);
        return true;
    }

    static updateWPRState(symbol) {
        const a = state.assets[symbol];
        if (!a || !Number.isFinite(a.wpr)) return false;
        // Arm flags when entering extremes
        if (a.wpr <= CONFIG.WPR_OVERSOLD && !a.buyFlagActive) {
            a.buyFlagActive = true;
            LOGGER.wpr(`${symbol}: BUY FLAG ARMED — WPR entered oversold (${a.wpr.toFixed(2)})`);
        }
        if (a.wpr >= CONFIG.WPR_OVERBOUGHT && !a.sellFlagActive) {
            a.sellFlagActive = true;
            LOGGER.wpr(`${symbol}: SELL FLAG ARMED — WPR entered overbought (${a.wpr.toFixed(2)})`);
        }
        return false;
    }

    /**
     * Check BUY signal: WPR crosses above -20, must be FIRST since oversold.
     * Returns {shouldTrade, direction, reason, details}
     */
    static checkBuySignal(symbol) {
        const a = state.assets[symbol];
        const wpr = a?.wpr;
        const prevWpr = a?.prevWpr;
        if (!Number.isFinite(wpr) || !Number.isFinite(prevWpr)) {
            return { shouldTrade: false, reason: `WPR not ready (${String(prevWpr)}→${String(wpr)})`, details: { wpr, prevWpr } };
        }
        const isCrossingAbove = prevWpr <= CONFIG.WPR_OVERBOUGHT && wpr > CONFIG.WPR_OVERBOUGHT;
        if (!isCrossingAbove) {
            return { shouldTrade: false, reason: `No BUY cross: ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} (need ≤${CONFIG.WPR_OVERBOUGHT}→>${CONFIG.WPR_OVERBOUGHT})`, details: { wpr, prevWpr } };
        }
        if (!a.buyFlagActive) {
            return { shouldTrade: false, reason: `BUY cross ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} but BUY flag not armed (never visited ${CONFIG.WPR_OVERSOLD} since last BUY)`, details: { wpr, prevWpr } };
        }
        return {
            shouldTrade: true,
            direction: 'CALLE',
            confidence: 1,
            reason: `WPR BUY cross ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} above ${CONFIG.WPR_OVERBOUGHT} (first since oversold)`,
            details: { wpr, prevWpr, buyFlagActive: a.buyFlagActive, sellFlagActive: a.sellFlagActive }
        };
    }

    static checkSellSignal(symbol) {
        const a = state.assets[symbol];
        const wpr = a?.wpr;
        const prevWpr = a?.prevWpr;
        if (!Number.isFinite(wpr) || !Number.isFinite(prevWpr)) {
            return { shouldTrade: false, reason: `WPR not ready (${String(prevWpr)}→${String(wpr)})`, details: { wpr, prevWpr } };
        }
        const isCrossingBelow = prevWpr >= CONFIG.WPR_OVERSOLD && wpr < CONFIG.WPR_OVERSOLD;
        if (!isCrossingBelow) {
            return { shouldTrade: false, reason: `No SELL cross: ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} (need ≥${CONFIG.WPR_OVERSOLD}→<${CONFIG.WPR_OVERSOLD})`, details: { wpr, prevWpr } };
        }
        if (!a.sellFlagActive) {
            return { shouldTrade: false, reason: `SELL cross ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} but SELL flag not armed (never visited ${CONFIG.WPR_OVERBOUGHT} since last SELL)`, details: { wpr, prevWpr } };
        }
        return {
            shouldTrade: true,
            direction: 'PUTE',
            confidence: 1,
            reason: `WPR SELL cross ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} below ${CONFIG.WPR_OVERSOLD} (first since overbought)`,
            details: { wpr, prevWpr, buyFlagActive: a.buyFlagActive, sellFlagActive: a.sellFlagActive }
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
            reason: buySig.reason || sellSig.reason || `No WPR signal wpr=${a?.wpr?.toFixed(2) ?? 'n/a'} prev=${a?.prevWpr?.toFixed(2) ?? 'n/a'}`,
            details: { wpr: a?.wpr, prevWpr: a?.prevWpr, buyFlag: a?.buyFlagActive, sellFlag: a?.sellFlagActive }
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
// DERIV CANDLE FETCHER — paginates beyond 1000 limit via end epoch
// ============================================================
class DerivCandleFetcher {
    constructor(appId, logger) {
        this.appId = appId || '1089';
        this.logger = logger || LOGGER;
        // Use public app_id 1089 for history fetch — custom app_id (33usl...) may 401 on anonymous WS
        this.wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=1089`;
        this.fallbackUrl = `wss://ws.derivws.com/websockets/v3?app_id=${appId || CONFIG.APP_ID}`;
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
        } else if (opts.days) {
            want = Math.ceil(Number(opts.days) * 86400 / granularity);
        } else if (!want) {
            want = 30 * 1440; // default 30 days of 1m
        }
        want = Math.max(1, Math.min(want, 500000));
        let end = opts.to ? Math.floor(new Date(opts.to).getTime() / 1000) : 'latest';
        const startEpoch = opts.from ? Math.floor(new Date(opts.from).getTime() / 1000) : null;
        const all = [];
        let guard = 0;
        const maxGuard = Math.ceil(want / 1000) + 5;
        let ws = null;
        const connectTo = (url) => new Promise((resolve, reject) => {
            const w = new WebSocket(url, { handshakeTimeout: 15000 });
            let opened = false;
            const t = setTimeout(() => { if (!opened) { try { w.terminate(); } catch {} reject(new Error('WS connect timeout')); } }, 15000);
            w.on('open', () => { clearTimeout(t); opened = true; resolve(w); });
            w.on('error', e => { clearTimeout(t); if (!opened) reject(e); });
            w.on('unexpected-response', (_req,res)=> { clearTimeout(t); reject(new Error(`Unexpected server response: ${res.statusCode}`)); try{res.destroy();}catch{} });
        });
        try { ws = await connectTo(this.wsUrl); } catch (e) {
            this.logger.warn(`Fetcher connect ${this.wsUrl} failed: ${e.message} — trying fallback`);
            try { ws = await connectTo(this.fallbackUrl); } catch (e2) { this.logger.error(`Fetcher connect failed: ${e2.message}`); throw e2; }
        }
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
        try {
            while (all.length < want && guard < maxGuard) {
                guard++;
                const batch = Math.min(1000, want - all.length);
                const req = { ticks_history: symbol, style: 'candles', granularity, count: batch, end, adjust_start_time: 1 };
                if (startEpoch) req.start = startEpoch;
                let r;
                try { r = await send(req); } catch (e) { this.logger.error(`Fetch batch ${guard} failed: ${e.message}`); break; }
                if (r.error) { this.logger.error(`Fetch error: ${r.error.message}`); break; }
                const candles = (r.candles || []).map(c => ({
                    open: parseFloat(c.open), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close),
                    epoch: c.epoch, open_time: c.epoch - (c.epoch % granularity)
                })).filter(c => Number.isFinite(c.open) && Number.isFinite(c.close));
                if (!candles.length) break;
                // prepend chronologically (Deriv returns oldest first? ensure order)
                candles.sort((a,b)=>a.open_time-b.open_time);
                // dedup by open_time
                const existing = new Set(all.map(x=>x.open_time));
                const uniq = candles.filter(c=> !existing.has(c.open_time));
                all.unshift(...uniq);
                // prepare next end (earliest candle before current earliest)
                const earliest = candles[0];
                if (!earliest || candles.length < batch) break;
                end = earliest.epoch - 1;
                if (startEpoch && end < startEpoch) break;
                // rate-limit
                await new Promise(res=> setTimeout(res, 300));
            }
        } finally {
            try { ws.close(); } catch {}
        }
        // sort ascending and trim to want
        all.sort((a,b)=>a.open_time-b.open_time);
        if (all.length > want) return all.slice(-want);
        return all;
    }
}

// ============================================================
// BACKTEST ENGINE — exact live strategy replay per asset
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
        // mirror live state vars — WPR flags
        let investmentRemaining = cfg.INVESTMENT_AMOUNT;
        let martingaleLevel = 0;
        let isRecovery=false, waitingForNewSignal=false, exclusiveLock=false, recoveryFirstDone=false, lastTradeDirection=null;
        let consecutiveLosses=0, cooldownCandles=0;
        let buyFlagActive=false, sellFlagActive=false;
        let netPL=0, totalStake=0;
        const trades=[];
        const streakCounts={}; let curStreak=0, maxStreak=0;
        const closed=[];
        // session guard replica (optional)
        let sessionActive=true, sessionNetPL=0;
        for(let i=0;i<candles.length;i++){
            const c=candles[i];
            closed.push(c);
            if(closed.length>50000) closed.shift();
            // cooldown — keep exclusiveLock during cooldown, only clear isRecovery/waiting via logic below
            if(cooldownCandles>0){ cooldownCandles--; continue; }
            // session guard (mirror live SESSION_PROFIT_TARGET / SESSION_STOP_LOSS)
            if(CONFIG.SESSION_PROFIT_TARGET && sessionNetPL >= CONFIG.SESSION_PROFIT_TARGET) { sessionActive=false; }
            if(CONFIG.SESSION_STOP_LOSS && sessionNetPL <= CONFIG.SESSION_STOP_LOSS) { sessionActive=false; }
            if(!sessionActive) continue;

            // ── WPR computation on closed array ──
            const wpr = TechnicalIndicators.calculateWPR(closed, period);
            const prevWpr = closed.length >= 2 ? TechnicalIndicators.calculateWPR(closed.slice(0, -1), period) : null;
            // Arm flags when entering extremes (mirror live SignalManager.updateWPRState)
            if (Number.isFinite(wpr)) {
                if (wpr <= CONFIG.WPR_OVERSOLD && !buyFlagActive) buyFlagActive = true;
                if (wpr >= CONFIG.WPR_OVERBOUGHT && !sellFlagActive) sellFlagActive = true;
            }
            let direction=null, isRecoveryTrade=false;
            // Exclusive lock in backtest is per-asset, but we still model same-direction vs signal-wait
            if(isRecovery && CONFIG.USE_RECOVERY_STRATEGY && lastTradeDirection && !waitingForNewSignal){
                direction=lastTradeDirection; isRecoveryTrade=true;
            } else {
                // If waitingForNewSignal, force WPR signal (not same-direction)
                if (!Number.isFinite(wpr) || !Number.isFinite(prevWpr)) continue;
                const buyCross = prevWpr <= CONFIG.WPR_OVERBOUGHT && wpr > CONFIG.WPR_OVERBOUGHT && buyFlagActive;
                const sellCross = prevWpr >= CONFIG.WPR_OVERSOLD && wpr < CONFIG.WPR_OVERSOLD && sellFlagActive;
                if (buyCross) { direction='CALLE'; }
                else if (sellCross) { direction='PUTE'; }
                else continue;
            }
            if(!direction) continue;
            if(i+1>=candles.length) break; // need next candle to settle
            const stake=StakeCalculator.calculate(symbol, martingaleLevel, investmentRemaining);
            if(stake > investmentRemaining) continue;
            // simulate capital check (backtest starts with INVESTMENT_AMOUNT, not global capital)
            // deduct
            investmentRemaining = Number((investmentRemaining - stake).toFixed(2));
            totalStake += stake;
            const entryClose=c.close;
            const exitClose=candles[i+1].close;
            const won = direction==='CALLE' ? exitClose > entryClose : exitClose < entryClose;
            const pnl = won ? Number((stake * payoutRatio).toFixed(2)) : -stake;
            netPL = Number((netPL + pnl).toFixed(2));
            sessionNetPL = Number((sessionNetPL + pnl).toFixed(2));
            trades.push({idx:i, open_time:c.open_time, close_time:candles[i+1].open_time, direction, stake, won, pnl, level:martingaleLevel, isRecovery:isRecoveryTrade, firstDone:recoveryFirstDone});
            // Consume flag on executed signal (first-cross logic)
            if (!isRecoveryTrade) {
                if (direction==='CALLE') buyFlagActive=false;
                else sellFlagActive=false;
            }
            // update state exactly as SessionManager.recordTradeResult (preserves martingale after MAX)
            if(won){
                // win resets all locks and martingale — exclusive lock released
                lastTradeDirection=direction;
                isRecovery=false; waitingForNewSignal=false; exclusiveLock=false;
                recoveryFirstDone=false;
                martingaleLevel=0; consecutiveLosses=0; curStreak=0;
                investmentRemaining = Number((investmentRemaining + stake + pnl).toFixed(2));
            } else {
                lastTradeDirection=direction;
                const wasRec=isRecovery;
                exclusiveLock=true;
                const underLimit = (consecutiveLosses + 1) < CONFIG.MAX_CONSECUTIVE_LOSSES;
                if (underLimit) {
                    isRecovery=true;
                    waitingForNewSignal=false;
                    if(!wasRec) recoveryFirstDone=false;
                } else {
                    // Reach MAX — stop same-direction, wait for new WPR signal but keep exclusive + martingale
                    isRecovery=false;
                    waitingForNewSignal=true;
                    recoveryFirstDone=false;
                }
                if(!recoveryFirstDone && isRecovery) recoveryFirstDone=true;
                martingaleLevel++;
                consecutiveLosses++; curStreak++; maxStreak=Math.max(maxStreak,curStreak);
                const key='x'+Math.min(curStreak,12);
                streakCounts[key]=(streakCounts[key]||0)+1;
                if(consecutiveLosses>=CONFIG.MAX_CONSECUTIVE_LOSSES){
                    // Preserve martingaleLevel & stake, impose cooldown, keep exclusiveLock
                    isRecovery=false;
                    waitingForNewSignal=true;
                    exclusiveLock=true;
                    recoveryFirstDone=false;
                    cooldownCandles=CONFIG.COOLDOWN_CANDLES;
                }
                // loss does not credit pool
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
            `🧪 BACKTEST — ${r.symbol} (WPR=${r.wprPeriod ?? r.WPR_PERIOD ?? CONFIG.WPR_PERIOD} ${CONFIG.WPR_OVERSOLD}/${CONFIG.WPR_OVERBOUGHT}, ${r.granularity}s, payout ${(r.payoutRatio*100).toFixed(0)}%, stake $${getAssetConfig(r.symbol).INITIAL_STAKE}×${getAssetConfig(r.symbol).MARTINGALE_MULTIPLIER})`,
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
                    isRecovery: a.isRecovery,
                    waitingForNewSignal: a.waitingForNewSignal || false,
                    exclusiveLock: a.exclusiveLock || false,
                    forceRecoverDirection: a.forceRecoverDirection,
                    recoveryStep: a.recoveryStep,
                    currentStake: a.currentStake,
                    baseStake: a.baseStake,
                    martingaleLevel: a.martingaleLevel,
                    investmentRemaining: a.investmentRemaining,
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
            state.capital = data.capital;
            state.session = { ...state.session, ...data.session };
            state.portfolio = { ...state.portfolio, ...data.portfolio };
            state.hourlyStats = data.hourlyStats || state.hourlyStats;
            state.currentTradeDay = data.currentTradeDay || TradeHistoryManager.getDateKey();

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
                        a.isRecovery = saved.isRecovery || false;
                        a.waitingForNewSignal = saved.waitingForNewSignal || false;
                        a.exclusiveLock = saved.exclusiveLock || false;
                        a.forceRecoverDirection = saved.forceRecoverDirection ?? null;
                        a.recoveryStep = saved.recoveryStep || 0;
                        a.martingaleLevel = saved.martingaleLevel || 0;
                        a.currentStake = saved.currentStake || StakeCalculator.calculate(symbol, 0, a.investmentRemaining);
                        a.baseStake = saved.baseStake || StakeCalculator.getBaseStake(symbol, a.investmentRemaining);
                        a.investmentRemaining = saved.investmentRemaining || getAssetConfig(symbol).INVESTMENT_AMOUNT;
                        a.consecutiveWins = saved.consecutiveWins || 0;
                        a.consecutiveLosses = saved.consecutiveLosses || 0;
                        a.cooldownCandles = saved.cooldownCandles || 0;

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
                        LOGGER.info(`${symbol}: Rec=${a.recoveryStep} Stake=$${(a.currentStake || 0).toFixed(2)} P/L=$${(a.netPL || 0).toFixed(2)} | WPR ${prevTxt}→${wprTxt} BuyArm=${a.buyFlagActive} SellArm=${a.sellFlagActive} | Wins=${a.winsCount} Losses=${a.lossesCount} Trades=${a.tradesCount}`);
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

        // Build analysis details for OPEN trades
        let analysisDetails = '';
        if (type === 'OPEN' && details) {
            if (details.isRecovery) {
                analysisDetails = `
        🔄 <b>RECOVERY MODE: YES</b> (${duration}${(durationUnit||'m').toUpperCase()} full 1m candle, every candle until win)
        ⚡ Same direction as loss trade (NO pattern analysis)`;
            } else if (details.analysis) {
                const analysis = details.analysis;
                const wpr = analysis?.details?.wpr;
                const prevWpr = analysis?.details?.prevWpr;
                const wprStr = Number.isFinite(wpr) && Number.isFinite(prevWpr) ? `${prevWpr.toFixed(1)}→${wpr.toFixed(1)}` : 'N/A';
                analysisDetails = `
        🧠 <b>WPR(${CONFIG.WPR_PERIOD}) Signal:</b>
        📊 WPR: ${wprStr} (OB ${CONFIG.WPR_OVERBOUGHT} / OS ${CONFIG.WPR_OVERSOLD})
        📊 Signal: ${analysis?.direction || 'N/A'} (${analysis?.reason || ''})`;
            }
        }

        // Profit/Loss details for WIN/LOSS trades
        let resultDetails = '';
        if (details.profit !== undefined) {
            const profitNum = Number(details.profit) || 0;
            const isWin = profitNum > 0;
            const a = state.assets[symbol];
            resultDetails = `
        ${isWin ? '🟢' : '🔴'} <b>Profit: $${profitNum.toFixed(2)}</b>

        📋 <b>${symbol} Stats:</b>
        W/L: ${a?.winsCount ?? 0}/${a?.lossesCount ?? 0} | P/L: $${(a?.netPL ?? 0).toFixed(2)}
        🔢 Martingale Level: ${a?.martingaleLevel ?? 0}

        📋 <b>Today:</b>
        Trades: ${today.tradesCount} | W/L: ${today.winsCount || 0}/${today.lossesCount || 0} | P/L: $${(today.netPL || 0).toFixed(2)}
        📉 x2-x9: ${state.session.x2Losses || 0} | ${state.session.x3Losses || 0} | ${state.session.x4Losses || 0} | ${state.session.x5Losses || 0} | ${state.session.x6Losses || 0} | ${state.session.x7Losses || 0} | ${state.session.x8Losses || 0} | ${state.session.x9Losses || 0}
        💰 Capital: $${state.capital.toFixed(2)}

        📋 <b>Overall:</b>
        Trades: ${overall.tradesCount} | W/L: ${overall.winsCount}/${overall.lossesCount} | P/L: $${(overall.netPL || 0).toFixed(2)}`;
        }

        const recoveryStatus = a?.isRecovery ? '🔄 RECOVERY' : '🎯 NORMAL';

        const msg = `
        ${emoji} <b>${type} WILLRF TRADE ALERT - ${recoveryStatus}</b>

        📊 Asset: ${symbol}
        📈 Direction: ${direction === 'CALLE' ? 'RISE 📈' : 'FALL 📉'}
        💵 Stake: $${stake.toFixed(2)}
        ⏱ Duration: ${duration}${(durationUnit || 's').toUpperCase()}
        🔢 Martingale Level: ${a ? a.martingaleLevel : 0}
        ${type !== 'OPEN' ? `📉 x2-x9: ${state.session.x2Losses} | ${state.session.x3Losses} | ${state.session.x4Losses} | ${state.session.x5Losses} | ${state.session.x6Losses} | ${state.session.x7Losses} | ${state.session.x8Losses} | ${state.session.x9Losses}` : ''}
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
            if (a?.tradesCount > 0) {
                const normalInfo = a.normalModeActive ? `Nrm:${a.tradesInNormalMode}/${CONFIG.MAX_TRADES_PER_CYCLE}` : '';
                assetInfo += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L $${(a.netPL || 0).toFixed(2)} Rec:${a.recoveryStep} ${normalInfo}`;
            }
        });

        await this.sendMessage([
            `⏰ <b>WILLRF BOT HOURLY SUMMARY</b>`,
            `Last Hour: ${h.trades}t ${h.wins}W/${h.losses}L ${wr}% ${h.pnl >= 0 ? '\u{1f7e2}' : '\u{1f534}'} $${h.pnl.toFixed(2)}`,
            `Today: ${today.tradesCount}t P/L: $${(today.netPL || 0).toFixed(2)}`,
            `Loss Stats: x2:${today.x2Losses || 0} x3:${today.x3Losses || 0} x4:${today.x4Losses || 0} x5:${today.x5Losses || 0} x6:${today.x6Losses || 0} x7:${today.x7Losses || 0} x8:${today.x8Losses || 0} x9:${today.x9Losses || 0}`,
            `Capital: $${state.capital.toFixed(2)}`,
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
            if (a?.tradesCount > 0) {
                const pairWr = a.tradesCount > 0 ? ((a.winsCount / a.tradesCount) * 100).toFixed(1) : '0.0';
                pairBreakdown += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L (${pairWr}%) $${(a.netPL || 0).toFixed(2)}`;
            }
        });

        await this.sendMessage([
            `\u{1f4ca} <b>WILLRF BOT SESSION SUMMARY</b>`,
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
            `\u{1f916} <b>WILLRF BOT STARTED</b>`,
            `Strategy: Williams %R(${CONFIG.WPR_PERIOD}) cross ${CONFIG.WPR_OVERBOUGHT}/${CONFIG.WPR_OVERSOLD} → CALLE/PUTE + Same-direction Recovery`,
            `Recovery: ${CONFIG.USE_RECOVERY_STRATEGY ? `ENABLED (same direction, max ${CONFIG.MAX_CONSECUTIVE_LOSSES} consec losses → cooldown ${CONFIG.COOLDOWN_CANDLES})` : 'DISABLED'}`,
            `Risk: Martingale progression with cap $${getAssetConfig(CONFIG.ACTIVE_ASSETS[0]).INVESTMENT_AMOUNT}`,
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
        return false;
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
                `\u{1f319} <b>WILLRF BOT END OF DAY ${state.currentTradeDay}</b>\nP/L: $${(dayStats?.netPL || 0).toFixed(2)}\nCapital: $${state.capital.toFixed(2)}`
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
                a.tradesCount = 0; a.winsCount = 0; a.lossesCount = 0;
                a.profit = 0; a.loss = 0; a.netPL = 0;
            }
        });
    }

    static recordTradeResult(symbol, profit, direction, stake) {
        const a = state.assets[symbol];
        if (!a) return;

        this.checkDayChange();

        // Credit stake + profit back to rolling pool (stake deducted on open, so return full payout)
        state.capital = Number((state.capital + stake + profit).toFixed(2));

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
            a.martingaleLevel = 0;
            a.cooldownCandles = 0;
            a.lastTradeWasWin = true;
            a.forceRecoverDirection = null;  // win exits forced recovery mode

            // Exit all recovery/exclusive locks on win — revert to default 1m duration, keep martingale reset
            const wasRecovery = a.isRecovery;
            const wasWaiting = a.waitingForNewSignal;
            const wasLocked = a.exclusiveLock;
            if (wasRecovery || wasWaiting || wasLocked) {
                a.isRecovery = false;
                a.waitingForNewSignal = false;
                a.exclusiveLock = false;
                if (wasRecovery) LOGGER.info(`[${symbol}] Recovery mode EXITED - Win achieved → revert to ${getAssetConfig(symbol).DURATION}${getAssetConfig(symbol).DURATION_UNIT}`);
                if (wasWaiting) LOGGER.info(`[${symbol}] Waiting-for-signal mode EXITED - Win achieved on exclusive asset`);
                if (wasLocked) LOGGER.info(`[${symbol}] Exclusive lock RELEASED - Win achieved, other assets may trade again`);
            }
            a.pendingRecovery = false;
            a.recoveryFirstDone = false;

            // Credit payout (stake + profit) back to investment pool — pool grows on win
            a.investmentRemaining = Number((a.investmentRemaining + stake + profit).toFixed(2));
            a.baseStake = StakeCalculator.getBaseStake(symbol, a.investmentRemaining);
            a.currentStake = StakeCalculator.calculate(symbol, 0, a.investmentRemaining);

            LOGGER.trade(`WIN [${symbol}] +$${(profit || 0).toFixed(2)} | ${direction} | P/L: $${(a.netPL || 0).toFixed(2)}`);
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
            a.forceRecoverDirection = a.lastTradeDirection === 'CALLE' ? 'CALLE' : 'PUTE';
            a.martingaleLevel = (a.martingaleLevel || 0) + 1;

            // Mark exclusive lock immediately — only this asset may trade until win
            a.exclusiveLock = true;

            // Enter recovery mode on loss (if recovery strategy is enabled and under limit)
            const underLimit = a.consecutiveLosses < CONFIG.MAX_CONSECUTIVE_LOSSES;
            if (CONFIG.USE_RECOVERY_STRATEGY && underLimit) {
                const wasAlreadyRecovery = a.isRecovery;
                a.isRecovery = true;
                a.waitingForNewSignal = false;
                a.pendingRecovery = false;
                if (!wasAlreadyRecovery) a.recoveryFirstDone = false;
                LOGGER.info(`[${symbol}] Recovery mode ENTERED - First recovery 58s (finish current candle), then 1m every candle until win (exclusive asset, ${a.consecutiveLosses}/${CONFIG.MAX_CONSECUTIVE_LOSSES} losses)`);
            } else if (CONFIG.USE_RECOVERY_STRATEGY && !underLimit) {
                // At or beyond limit — stop same-direction recovery, wait for new WPR signal but stay exclusive + martingale
                const wasRecovery = a.isRecovery;
                a.isRecovery = false;
                a.waitingForNewSignal = true;
                a.pendingRecovery = false;
                a.recoveryFirstDone = false;
                a.forceRecoverDirection = null;
                if (wasRecovery) LOGGER.warn(`[${symbol}] ${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses (initial + recoveries) — exiting same-direction recovery, cooling down for ${CONFIG.COOLDOWN_CANDLES} candles, waiting for new WPR signal on same asset (exclusive, martingale L${a.martingaleLevel} preserved)`);
            }

            // Pause normal mode during recovery
            if (a.normalModeActive) {
                a.normalModePaused = true;
                LOGGER.recovery(`[${symbol}] Normal mode PAUSED for recovery`);
            }

            if (a.martingaleLevel >= 2 && a.martingaleLevel <= 9) {
                const key = `x${a.martingaleLevel}Losses`;
                state.session[key]++;
                a[key]++;
            }

            a.currentStake = StakeCalculator.calculate(symbol, a.martingaleLevel, a.investmentRemaining);

            if (a.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
                // Impose cooldown but preserve martingale & exclusive lock — will trade next WPR signal on same asset
                a.cooldownCandles = CONFIG.COOLDOWN_CANDLES;
                // Ensure same-direction recovery is off, waiting flag stays on
                a.isRecovery = false;
                a.waitingForNewSignal = true;
                a.exclusiveLock = true;
                LOGGER.warn(`[${symbol}] COOL-DOWN ${CONFIG.COOLDOWN_CANDLES} candle(s) — Martingale L${a.martingaleLevel} ($${a.currentStake.toFixed(2)}) preserved, exclusive lock held, next trade will be WPR signal on same asset`);
                TelegramService.sendMessage(
                    `❄️ <b>[${symbol}] WPR BOT COOL-DOWN ACTIVATED</b>\n` +
                    `${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses (WPR recovery limit)\n` +
                    `Pausing ${CONFIG.COOLDOWN_CANDLES} candle(s) — martingale L${a.martingaleLevel} preserved, exclusive lock held\n` +
                    `Next trade: WPR signal on same asset until win\n` +
                    `Capital: $${state.capital.toFixed(2)}`
                );
            }

            LOGGER.trade(`LOSS [${symbol}] -$${Math.abs(profit || 0).toFixed(2)} | ${direction} | Next Stake: $${(a.currentStake || 0).toFixed(2)} (martingale=${a.martingaleLevel})`);
        }

        TradeHistoryManager.recordTrade(symbol, profit, a.martingaleLevel);
    }
}

// ============================================================
// STATE  [MODIFIED for CANDLE DIRECTION + normal mode]
// ============================================================
const state = {
    assets: {},
    capital: CONFIG.ACTIVE_ASSETS.length ? getAssetConfig(CONFIG.ACTIVE_ASSETS[0]).INVESTMENT_AMOUNT : DEFAULT_ASSET_CONFIG.INVESTMENT_AMOUNT,
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
                    isRecovery: false,
                    waitingForNewSignal: false,
                    exclusiveLock: false,
                    forceRecoverDirection: null,
                    recoveryStep: 0,
                    currentStake: assetConfig.INITIAL_STAKE,
                    baseStake: assetConfig.INITIAL_STAKE,
                    martingaleLevel: 0,
                    investmentRemaining: assetConfig.INVESTMENT_AMOUNT,
                    canTrade: false,
                    consecutiveWins: 0,
                    consecutiveLosses: 0,
                    cooldownCandles: 0,
                    activePositions: [],
                    tradesCount: 0, winsCount: 0, lossesCount: 0,
                    profit: 0, loss: 0, netPL: 0,

                    // state
                    inTradeCycle: false,
                    waitingForReentry: false,
                    priceReturnedToZone: false,
                    currentDirection: null,

                    // Normal mode state
                    normalModeActive: false,
                    tradesInNormalMode: 0,
                    normalModeDirection: null,
                    normalModePaused: false,
                    pendingRecovery: false,
                    recoveryFirstDone: false,

                    // Last analysis for notifications
                    lastAnalysis: null,
                };
                LOGGER.info(`Initialized asset: ${symbol} (Stake: $${assetConfig.INITIAL_STAKE}, Duration: ${assetConfig.DURATION}${assetConfig.DURATION_UNIT})`);
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
                    state.pendingTradeInfo = { stake: pos.stake, direction: pos.direction, symbol: pos.symbol };

                    bot._startTradeWatchdog(contract.contract_id);
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
        state.pendingTradeInfo = null;
        bot._tradeLocked = false;

        if (r.subscription?.id) this.send({ forget: r.subscription.id });

        SessionManager.checkSessionTargets();
        StatePersistence.saveState();
        // B: Immediate first recovery on settlement (58s) to avoid missing the forming candle
        if (profit < 0 && a.isRecovery && CONFIG.USE_RECOVERY_STRATEGY && a.cooldownCandles === 0) {
            setImmediate(() => {
                try {
                    if (bot && typeof bot.executeRecoveryTradeImmediate === 'function') {
                        // Execute only if still recovery and no active position (deduplicate vs OHLC)
                        if (a.isRecovery && !a.activePositions.length && !bot._tradeLocked) {
                            const ok = bot.executeRecoveryTradeImmediate(ownerSym);
                            if (ok) LOGGER.recovery(`[${ownerSym}] First recovery executed on settlement (B:58s)`);
                        }
                    }
                } catch (e) {
                    LOGGER.error(`[${ownerSym}] Immediate recovery error: ${e.message}`);
                    if (bot) bot._forceReleaseTradeLock();
                }
            });
        }
        
    }

    // ════════════════════════════════════════════════════════
    // OHLC HANDLER — candle close triggers trade logic (FIXED)
    // ════════════════════════════════════════════════════════
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

                    if (a.cooldownCandles > 0) {
                        a.cooldownCandles--;
                        if (a.cooldownCandles === 0) a.forceRecoverDirection = null;
                        LOGGER.info(`❄️ [${symbol}] Cool-down: ${a.cooldownCandles} candles remaining`);
                    }

                    a.canTrade = true;

                    // Exclusive lock: if any asset is in recovery or waiting-for-signal (post-MAX), only that asset may trade until win
                    const exclusiveAsset = bot._getExclusiveAsset ? bot._getExclusiveAsset() : (bot._getRecoveryAsset ? bot._getRecoveryAsset() : null);
                    if (exclusiveAsset && exclusiveAsset !== symbol) {
                        const ea = state.assets[exclusiveAsset];
                        const reason = ea?.waitingForNewSignal ? `waiting-for-signal (post-${CONFIG.MAX_CONSECUTIVE_LOSSES} losses, CL=${ea.consecutiveLosses})` : `recovery CL=${ea?.consecutiveLosses ?? 0}`;
                        LOGGER.info(`[${symbol}] Candle closed but blocked — exclusive lock on ${exclusiveAsset} (${reason}, no skip for ${exclusiveAsset}, wait)`);
                    } else {
                        try {
                            if (a.isRecovery && CONFIG.USE_RECOVERY_STRATEGY && a.lastTradeDirection) {
                                if (!bot.executeRecoveryTradeImmediate(symbol)) {
                                    bot.executeNextTrade(symbol, closed);
                                }
                            } else {
                                bot.executeNextTrade(symbol, closed);
                            }
                        } catch (err) {
                            LOGGER.error(`[${symbol}] Trade execution error: ${err.message}`);
                            bot._forceReleaseTradeLock();
                        }
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

        // FIX: Merge incoming candles with existing instead of replacing
        // This prevents losing candles that closed during a disconnect
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

        // ── Seed WPR state from history ──
        if (a.closedCandles.length >= (getAssetConfig(symbol).WPR_PERIOD ?? CONFIG.WPR_PERIOD ?? 14)) {
            SignalManager.seedWPRState(symbol);
            LOGGER.info(`[${symbol}] WPR seeded: ${a.prevWpr?.toFixed(2) ?? 'n/a'}→${a.wpr?.toFixed(2) ?? 'n/a'} BuyArm=${a.buyFlagActive} SellArm=${a.sellFlagActive}`);
        }

        LOGGER.info(
            `[${symbol}] Loaded ${incomingCandles.length} ${CONFIG.TIMEFRAME_LABEL} candles (${addedCount} new merged, total: ${a.closedCandles.length}) |`
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
            TelegramService.sendMessage(`⚠️ <b>WILLRF BOT CONNECTION LOST</b> — Reconnecting (attempt ${this.reconnectAttempts})`);

            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (this.isShuttingDown) return;
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached — giving up');
            TelegramService.sendMessage(`\u{1f6d1} <b>WILLRF BOT STOPPED</b> — Max reconnections\nFinal P/L: $${(state.session.netPL || 0).toFixed(2)}`);
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
// MAIN BOT CLASS — v3 WPR ONLY (WILLIAMS %R)
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
        console.log(' DERIV CALLE/PUTE BOT v3 — WILLIAMS %R ONLY + IMMEDIATE RECOVERY');
        console.log('═'.repeat(74));
        console.log(`Assets    : ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        console.log(`WPR       : Period=${CONFIG.WPR_PERIOD} OB=${CONFIG.WPR_OVERBOUGHT} OS=${CONFIG.WPR_OVERSOLD} | BUY: cross >-20 (first since -80) → CALLE | SELL: cross <-80 (first since -20) → PUTE`);
        console.log(`Timeframe : ${CONFIG.TIMEFRAME_LABEL} candles | Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT} | Recovery B: first 58s (finish current candle), then 1m every candle (exclusive asset) until win or ${CONFIG.MAX_CONSECUTIVE_LOSSES} consec losses`);
        console.log(`Risk      : Martingale level progression with cap $${CONFIG.ACTIVE_ASSETS.length ? getAssetConfig(CONFIG.ACTIVE_ASSETS[0]).INVESTMENT_AMOUNT : DEFAULT_ASSET_CONFIG.INVESTMENT_AMOUNT}`);
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

        LOGGER.info('WILLRF BOT v1.0 fully started!');
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

    // ── Duration helpers — all trades are full 1m candles (open→close) ──
    _getRemainingSecondsInCandle() {
        // Kept for backward compat / logging only — not used for trade duration
        const gran = CONFIG.GRANULARITY || 60;
        const nowSec = Math.floor(Date.now() / 1000);
        const secIntoCandle = nowSec % gran;
        let remaining = gran - secIntoCandle;
        if (remaining <= 0) remaining = gran;
        return Math.max(1, Math.min(gran, remaining));
    }

    // ── Exclusive helpers — only locked asset may trade until win (covers recovery + post-max signal-wait) ──
    _getRecoveryAsset() {
        for (const sym of CONFIG.ACTIVE_ASSETS) {
            const a = state.assets[sym];
            if (a && a.isRecovery) return sym;
        }
        return null;
    }
    _getExclusiveAsset() {
        for (const sym of CONFIG.ACTIVE_ASSETS) {
            const a = state.assets[sym];
            if (a && (a.exclusiveLock || a.isRecovery || a.waitingForNewSignal)) return sym;
        }
        return null;
    }
    _hasAnyRecovery() { return !!this._getRecoveryAsset(); }
    _hasExclusiveLock() { return !!this._getExclusiveAsset(); }

    _getTradeDuration(symbol) {
        const a = state.assets[symbol];
        const assetConfig = getAssetConfig(symbol);
        // B: first recovery after loss = remaining seconds (58s) to finish current candle, no skip
        if (a && a.isRecovery && !a.recoveryFirstDone) {
            const rem = this._getRemainingSecondsInCandle();
            return { duration: rem, durationUnit: 's', remaining: rem };
        }
        return { duration: assetConfig.DURATION, durationUnit: assetConfig.DURATION_UNIT, remaining: null };
    }

    _executeBuy(symbol, direction, isRecovery, analysis) {
        const assetState = state.assets[symbol];
        if (!assetState) return null;
        const stake = assetState.currentStake;
        if (stake > assetState.investmentRemaining) {
            LOGGER.error(`[${symbol}] Insufficient investment: stake $${stake} > remaining $${assetState.investmentRemaining.toFixed(2)}`);
            assetState.canTrade = false;
            return null;
        }
        if (stake > state.capital) {
            LOGGER.error(`[${symbol}] Insufficient balance: stake $${stake} > capital $${state.capital.toFixed(2)}`);
            assetState.canTrade = false;
            return null;
        }
        // Deduct investment immediately
        assetState.investmentRemaining = Number((assetState.investmentRemaining - stake).toFixed(2));
        state.capital = Number((state.capital - stake).toFixed(2));

        const { duration, durationUnit, remaining } = this._getTradeDuration(symbol);

        if (isRecovery) {
            const firstTag = !assetState.recoveryFirstDone ? ` (FIRST 58s finish current candle)` : ` (1m)`;
            LOGGER.trade(`   Recovery Mode: YES | Same direction ${direction} | Stake: $${stake.toFixed(2)} | Martingale: L${assetState.martingaleLevel} | Duration: ${duration}${durationUnit}${remaining ? ` (${remaining}s)` : ''}${firstTag}`);
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
        this._tradeLocked = true;
        state.currentContractId = null;
        state.pendingTradeInfo = { symbol, stake, direction, time: Date.now() };

        TelegramService.sendTradeAlert('OPEN', symbol, direction, stake, duration, durationUnit, {
            isRecovery,
            analysis: isRecovery ? null : analysis,
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
        position.reqId = reqId;
        StatePersistence.saveState();
        return position;
    }

    // Recovery trade — B: first execution 58s (finish current candle, no skip), subsequent 1m
    // Called both on settlement (handleOpenContract) and on candle close (handleOHLC)
    // Returns true if trade executed, false if blocked
    executeRecoveryTradeImmediate(symbol) {
        const a = state.assets[symbol];
        if (!a) return false;
        if (!CONFIG.USE_RECOVERY_STRATEGY || !a.isRecovery || !a.lastTradeDirection) return false;
        // Exclusive: only exclusive-locked asset may trade while any asset is locked (recovery or post-MAX wait)
        const exclusiveAsset = this._getExclusiveAsset ? this._getExclusiveAsset() : this._getRecoveryAsset();
        if (exclusiveAsset && exclusiveAsset !== symbol) {
            LOGGER.info(`[${symbol}] Blocked — exclusive lock on ${exclusiveAsset} (recovery)`);
            return false;
        }
        if (a.cooldownCandles > 0) {
            LOGGER.info(`[${symbol}] Recovery deferred — cool-down ${a.cooldownCandles} candles`);
            return false;
        }
        if (a.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) return false;
        const totalPositions = CONFIG.ACTIVE_ASSETS.reduce((s, sym) => s + (state.assets[sym]?.activePositions?.length ?? 0), 0);
        if (totalPositions >= CONFIG.MAX_TOTAL_POSITIONS) {
            LOGGER.debug(`[${symbol}] Recovery deferred — max total positions ${totalPositions}/${CONFIG.MAX_TOTAL_POSITIONS}`);
            return false;
        }
        if (!state.isAuthorized) {
            LOGGER.warn(`[${symbol}] Recovery deferred — not authorized`);
            return false;
        }
        if (this._tradeLocked && state.currentContractId) {
            LOGGER.debug(`[${symbol}] Recovery deferred — trade locked`);
            return false;
        }
        if (state.capital < a.currentStake || a.currentStake > a.investmentRemaining) {
            LOGGER.warn(`[${symbol}] Recovery cannot execute — insufficient funds`);
            return false;
        }

        a.pendingRecovery = false;
        const direction = a.lastTradeDirection;
        const isFirst = !a.recoveryFirstDone;
        const durInfo = isFirst ? `${this._getRemainingSecondsInCandle()}s (finish current candle)` : `1m`;
        LOGGER.trade(`🔄 [${symbol}] RECOVERY ${isFirst ? 'FIRST 58s' : '1m'} — ${direction} DURATION ${durInfo} ${isFirst ? '(B)' : ''}`);
        const pos = this._executeBuy(symbol, direction, true, null);
        if (pos) a.recoveryFirstDone = true;
        return !!pos;
    }

    // ════════════════════════════════════════════════════════
    // CORE TRADE LOGIC — consecutive opposite (NO market-mode filter)
    // Called on every candle close
    // ════════════════════════════════════════════════════════
    executeNextTrade(symbol, lastClosedCandle) {
        const assetState = state.assets[symbol];
        if (!assetState) return;
        if (!assetState.canTrade) return;
        if (!SessionManager.isSessionActive()) return;

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
        if (state.capital < assetState.currentStake) {
            LOGGER.warn(`[${symbol}] Insufficient capital`);
            return;
        }

        // Exclusive lock: only locked asset may trade until win (recovery + post-MAX signal-wait)
        const exclusiveAsset = this._getExclusiveAsset ? this._getExclusiveAsset() : this._getRecoveryAsset();
        if (exclusiveAsset && exclusiveAsset !== symbol) {
            const ea = state.assets[exclusiveAsset];
            const reason = ea?.waitingForNewSignal ? `waiting-for-signal (post-${CONFIG.MAX_CONSECUTIVE_LOSSES}, CL=${ea.consecutiveLosses})` : `recovery CL=${ea?.consecutiveLosses ?? 0}`;
            LOGGER.info(`[${symbol}] Blocked — exclusive lock on ${exclusiveAsset} (${reason}, only ${exclusiveAsset} may trade until win)`);
            assetState.canTrade = false;
            return;
        }

        let direction;
        let analysis = null;

        // Recovery priority: B - first 58s finish current candle, subsequent 1m until win
        if (CONFIG.USE_RECOVERY_STRATEGY && assetState.isRecovery && assetState.lastTradeDirection) {
            if (assetState.cooldownCandles > 0) {
                LOGGER.info(`[${symbol}] In recovery but cool-down ${assetState.cooldownCandles} — skipping`);
                assetState.canTrade = false;
                return;
            }
            // Delegate to unified recovery executor (handles first s vs subsequent 1m)
            this.executeRecoveryTradeImmediate(symbol);
            return;
        }

        // Normal mode: WPR-only logic
        const wprPeriod = assetConfig.WPR_PERIOD ?? CONFIG.WPR_PERIOD ?? 14;
        if (!assetState.indicatorsReady || !Number.isFinite(assetState.wpr) || !Number.isFinite(assetState.prevWpr)) {
            LOGGER.info(`[${symbol}] WPR not ready: ${assetState.prevWpr?.toFixed(2) ?? 'n/a'}→${assetState.wpr?.toFixed(2) ?? 'n/a'} (need ${wprPeriod} candles)`);
            assetState.canTrade = false;
            return;
        }
        // Check cooldown before signal (covers MAX_CONSECUTIVE_LOSSES exit)
        if (assetState.cooldownCandles > 0) {
            LOGGER.info(`[${symbol}] Cool-down active ${assetState.cooldownCandles} candles — skipping WPR signal`);
            assetState.canTrade = false;
            return;
        }
        analysis = SignalManager.analyze(symbol);
        assetState.lastAnalysis = analysis;

        if (!analysis.shouldTrade) {
            LOGGER.info(`[${symbol}] No trade — ${analysis.reason}`);
            assetState.canTrade = false;
            return;
        }

        direction = analysis.direction;
        LOGGER.trade(`🎯 [${symbol}] WPR SIGNAL WPR(${wprPeriod}) ${analysis.details.prevWpr?.toFixed(2) ?? ''}→${analysis.details.wpr?.toFixed(2) ?? ''} → ${direction} | ${analysis.reason}`);
        // Consume flag — first-cross logic (only first cross since extreme fires)
        if (direction === 'CALLE') assetState.buyFlagActive = false;
        else assetState.sellFlagActive = false;

        this._executeBuy(symbol, direction, false, analysis);
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
        if (state.tradeWatchdogTimer) { clearTimeout(state.tradeWatchdogTimer); state.tradeWatchdogTimer = null; }
        if (state.tradeWatchdogPollTimer) { clearTimeout(state.tradeWatchdogPollTimer); state.tradeWatchdogPollTimer = null; }
    }

    _forceReleaseTradeLock() {
        this._clearAllWatchdogTimers();
        this._tradeLocked = false;
        state.currentContractId = null;
        state.tradeStartTime = null;
        state.pendingTradeInfo = null;
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
        state.pendingTradeInfo = null;
        state.tradeStartTime = null;

        TelegramService.sendMessage(
            `⚠️ <b>WILLRF BOT STUCK TRADE RECOVERED [${reason}]</b>\n` +
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
                    isRecovery: a.isRecovery,
                    waitingForNewSignal: a.waitingForNewSignal || false,
                    exclusiveLock: a.exclusiveLock || false,
                    currentStake: a.currentStake,
                    activePositions: a.activePositions.length,
                    cooldownCandles: a.cooldownCandles,
                    consecutiveLosses: a.consecutiveLosses,
                    wpr: a.wpr,
                    prevWpr: a.prevWpr,
                    trades: a.tradesCount, wins: a.winsCount, losses: a.lossesCount, netPL: a.netPL,
                    lastDirection: a.lastTradeDirection,
                    buyFlag: a.buyFlagActive,
                    sellFlag: a.sellFlagActive,
                    normalMode: a.normalModeActive,
                    normalTrades: a.tradesInNormalMode,
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
    LOGGER.info(`🧪 BACKTEST standalone: ${symbols.join(', ')} | ${opts.days? opts.days+'d' : opts.candles? opts.candles+' candles' : '30d'} | payout ${(payoutRatio*100).toFixed(0)}%`);
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
        const fname = `bizArbitrage2-backtest-${sym}-${new Date().toISOString().slice(0,10).replace(/-/g,'')}.json`;
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
            await tbot.sendMessage(chatId, `🧪 Backtest started: ${asset} ${days?days+'d': from? from+':'+to : '30d'} ...`);
            try {
                const fetcher=new DerivCandleFetcher(CONFIG.APP_ID, LOGGER);
                const engine=new BacktestEngine();
                const syms= asset==='all'? CONFIG.ACTIVE_ASSETS : [asset];
                for(const sym of syms){
                    const candles=await fetcher.fetchCandles(sym, {days:days||30, from, to, payoutRatio:payoutArg});
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

    console.log('\n\u{1f680} Starting WPR BOT v3.0 (Williams %R)...\n');
    bot.connection.connect();
    // start Telegram backtest listener in live mode (optional)
    startTelegramBacktestPolling();

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
                const wpr = p.wpr != null ? `WPR:${p.wpr.toFixed(1)}` : 'WPR:n/a';
                const cdwn = p.cooldownCandles > 0 ? `❄️CD:${p.cooldownCandles}` : '';
                const rec = p.isRecovery ? '🔄REC' : (p.waitingForNewSignal ? '⏳WAIT' : '');
                const lock = p.exclusiveLock ? '🔒EXCL' : '';

                pairLines += `\n  ${sym}: ${wpr} ${p.buyFlag ? '\u{1f7e2}BF' : ''} ${p.sellFlag ? '\u{1f534}SF' : ''} ${rec}${lock} Rec${p.recoveryStep} $${(p.currentStake || 0).toFixed(2)} | ${p.trades}t ${p.wins}W/${p.losses}L $${(p.netPL || 0).toFixed(2)} | Pos:${p.activePositions} ${cdwn} CL:${p.consecutiveLosses}/${CONFIG.MAX_CONSECUTIVE_LOSSES}`;
            }
        });

        console.log(`\n\u{1f4ca} ${getGMTTime()} | Session: ${status.session.trades}t ${status.session.winRate} $${(status.session.netPL || 0).toFixed(2)} | Capital: $${status.capital.toFixed(2)}`);
        console.log(`\u{1f4cb} Overall: ${status.overall.tradesCount}t | P/L: $${(status.overall.netPL || 0).toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
        console.log(`\u{1f555} ${TradingSessionManager.getStatusString()}`);
        console.log(`\u{1f4c8} Assets:${pairLines}`);

    }, 60000);

    bot.statusDisplayIntervalId = statusInterval;
}
