'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║      DERIV SYNTHETIC INDICES CALLE/PUTE BOT  —  v1.0  "CANDLE CLOSE"     ║
 * ║  STRATEGY:                                                               ║
 * ║  ──────────────────────────────────────────────────────────────────────  ║
 * ║  1. Candle Direction Trading (CALLE/PUTE)                                ║
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
const STATE_FILE = path.join(__dirname, 'bizCandle_v2_01-state.json');
const HISTORY_FILE = path.join(__dirname, 'bizCandle_v2_01-history.json');
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
    normal: (msg) => console.log(`\x1b[93m[NORM]   ${getGMTTime()} - ${msg}\x1b[0m`),
    recovery: (msg) => console.log(`\x1b[33m[RECOV]  ${getGMTTime()} - ${msg}\x1b[0m`),
    candle: (msg) => console.log(`\x1b[95m[CANDLE] ${getGMTTime()} - ${msg}\x1b[0m`),
};

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
    // ── Deriv API [RETAINED credentials] ─────────────────────
    API_TOKEN: 'pat_cb2016855b5e6c61ac95f94432192dd6ed86bec7f7454e575d3fe1ed9f617692', //pat_cb2016855b5e6c61ac95f94432192dd6ed86bec7f7454e575d3fe1ed9f617692  //pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee
    APP_ID: '33uslPtthXBEkQOdfKfoY',
    ACCOUNT_TYPE: 'demo',          // 'demo' | 'real' (PAT mode only)
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // ── Martingale / staking settings mirrored from candlePatternRFm.js ─
    INITIAL_STAKE: 0.35,
    INVESTMENT_AMOUNT: 152,
    MARTINGALE_MULTIPLIER: 1.48,
    MAX_MARTINGALE_LEVEL: 1,
    AFTER_MAX_LOSS: 'continue',
    CONTINUE_EXTRA_LEVELS: 8,
    EXTRA_LEVEL_MULTIPLIERS: [2.1, 2.2, 2, 2.1, 2.2, 2.3, 2.3], //[2.1, 2.2, 2, 2.3]
    AUTO_COMPOUNDING: false,
    COMPOUND_PERCENTAGE: 0.1,
    STOP_LOSS: 152,

    // ── Session / daily guards ───────────────────
    SESSION_PROFIT_TARGET: 500000,
    SESSION_STOP_LOSS: -152,
    COOLDOWN_CANDLES: 5,

    // ── Candle / Contract Settings [RETAINED] ────────────────
    GRANULARITY: 60,     // 1-minute candles
    TIMEFRAME_LABEL: '1m',
    CANDLES_TO_LOAD: 60,      // Candlestick v2 needs EMA(4)+lookback+RSI(10) history
    MAX_CANDLES_STORED: 60,
    DURATION: 1,
    DURATION_UNIT: 'm',
    MIN_CANDLES_REQUIRED: 30,    

    // ── Trading Sessions (synthetics trade 24/7) ─────────────
    USE_TRADING_SESSIONS: false,
    SESSIONS: [
        { name: 'LONDON_OPEN', start: 2, end: 17 },
        { name: 'NY_OPEN', start: 12, end: 22 },
    ],

    // ── Position Management ───────────────────────────────────
    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    MAX_TOTAL_POSITIONS: 1,
    MAX_TRADES_PER_CYCLE: 1,

    // ── Active Index Assets ───────────────────────────────────
    ACTIVE_ASSETS: [
        // 'R_75',
        'R_100',
        // 'stpRNG',
        // 'stpRNG2',
        // 'stpRNG3',
        // 'stpRNG4',
        // 'stpRNG5',
    ],

    // ══════════════════════════════════════════════════════════
    // ── CANDLESTICK v2 STRATEGY (ported from ORSTAC XML) ──────
    // ══════════════════════════════════════════════════════════
    STRATEGY: {
        // Master switch: false = fall back to the legacy candle-direction logic
        ENABLED: true,

        // Trend filter — EMA(4) vs close over the last N closed candles
        EMA_PERIOD: 4,              // XML: EMA period 4
        EMA_LOOKBACK: 9,            // XML: ema4-contador loop 1..9
        USE_EMA_TREND: true,        // XML: ema_check

        // Momentum filter — RSI
        RSI_PERIOD: 10,             // XML: RSI period 10
        RSI_OVERBOUGHT: 70,
        RSI_OVERSOLD: 30,

        // XML: "Esperar Confirmação" — require the new (forming) candle's open
        // to confirm the signal before firing.
        WAIT_CONFIRMATION: true,

        // XML: "Confiabilidade Alta" — enable the multi-candle (3-5 bar) patterns
        HIGH_RELIABILITY: true,

        // XML: "Contabilizar Winrate" — per-pattern win/loss bookkeeping
        TRACK_PATTERN_WINRATE: true,

        // The source XML fires a CALL on a Shooting Star ("Estrela Cadente"),
        // which is a bearish reversal pattern. Set to true to trade it as a PUT.
        FIX_SHOOTING_STAR_DIRECTION: false,

        // Per-pattern toggles — defaults exactly as in the XML initialisation
        PATTERNS: {
            // Single-candle (require EMA trend + RSI extreme)
            EC: true,    // Estrela Cadente        / Shooting Star      -> CALL (see FIX_ flag)
            MTI: true,   // Martelo Invertido      / Inverted Hammer    -> CALL
            EF: true,    // Enforcado              / Hanging Man        -> PUT
            MT: true,    // Martelo                / Hammer             -> CALL

            // Multi-candle bullish
            BAA: true,   // Bebe Abandonado Alta   / Bullish Abandoned Baby
            TOUB: true,  // Three Outside Up Bullish
            CBSB: true,  // Concealing Baby Swallow Bullish
            TWSB: true,  // Three White Soldiers Bullish

            // Multi-candle bearish
            SPB: true,   // Solto Para Baixo
            BAB: true,   // Bebe Abandonado Baixa  / Bearish Abandoned Baby
            NN: false,   // Nuvem Negra            / Dark Cloud Cover   (OFF in XML)
            TODB: true,  // Three Outside Down Bearish
            FTMB: true,  // Falling Three Methods Bearish
            ITCB: true,  // Identical Three Crows Bearish
        },
    },

    // ── Misc ──────────────────────────────────────────────────
    DEBUG_MODE: true,
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8565754902:AAHS6UQWEgLJ0DO-JTpAGQhZLs-UDVVNAQc',
    TELEGRAM_CHAT_ID: '752497117',
};

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

    static getBaseStake(investmentRemaining) {
        if (CONFIG.AUTO_COMPOUNDING && investmentRemaining > 0) {
            return Math.max(
                Number((investmentRemaining * CONFIG.COMPOUND_PERCENTAGE / 100).toFixed(2)),
                CONFIG.INITIAL_STAKE
            );
        }
        return CONFIG.INITIAL_STAKE;
    }

    static calculate(investmentRemaining, martingaleLevel = 0) {
        let level = Math.max(0, martingaleLevel || 0);
        let base = this.getBaseStake(investmentRemaining);
        base = Math.max(base, CONFIG.INITIAL_STAKE);

        let stake;
        if (level <= CONFIG.MAX_MARTINGALE_LEVEL) {
            stake = base * Math.pow(CONFIG.MARTINGALE_MULTIPLIER, level);
        } else {
            stake = base * Math.pow(CONFIG.MARTINGALE_MULTIPLIER, CONFIG.MAX_MARTINGALE_LEVEL);
            const extraIdx = level - CONFIG.MAX_MARTINGALE_LEVEL - 1;
            for (let i = 0; i <= extraIdx; i++) {
                stake *= (CONFIG.EXTRA_LEVEL_MULTIPLIERS[i] || CONFIG.MARTINGALE_MULTIPLIER);
            }

            // Reset to base stake after exceeding max martingale + extra levels
            if (level > CONFIG.MAX_MARTINGALE_LEVEL + CONFIG.CONTINUE_EXTRA_LEVELS) {
                stake = base;
                level = 0; // Reset level to 0 for calculation
            }
        }

        // Cap at remaining investment pool
        stake = Math.min(stake, investmentRemaining > 0 ? investmentRemaining : stake);
        stake = Math.max(CONFIG.INITIAL_STAKE, stake);
        return parseFloat(stake.toFixed(2));
    }

    static describe(investmentRemaining, martingaleLevel) {
        const stake = this.calculate(investmentRemaining, martingaleLevel);
        const pct = investmentRemaining > 0 ? ((stake / investmentRemaining) * 100).toFixed(2) : '0.00';
        return `$${stake.toFixed(2)} (${pct}% pool, martingale level ${martingaleLevel})`;
    }
}

// ============================================================
// CANDLESTICK v2 STRATEGY ENGINE
// Faithful port of ORSTAC/champions/Candlestick v2.xml (Deriv Bot / Blockly)
// ------------------------------------------------------------
// XML candle indexing convention -> array indexing here:
//   OHLC[x][1] = the currently FORMING candle          -> forming
//   OHLC[x][2] = last CLOSED candle       (Candle 1)   -> c(1)
//   OHLC[x][3] = 2 candles back           (Candle 2)   -> c(2)
//   OHLC[x][4] = 3 candles back           (Candle 3)   -> c(3)
//   OHLC[x][5] = 4 candles back           (Candle 4)   -> c(4)
//   OHLC[x][6] = 5 candles back           (Candle 5)   -> c(5)
//
// Per-candle metrics the XML computes (all as % of the full high-low range):
//   Corpo-SomaN      -> body        (|open-close| / range * 100, rounded)
//   *-Sombra-Superior-> upperShadow (fraction 0..1; XML rounds *100 at use site)
//   *-Sombra-Inferior-> lowerShadow (fraction 0..1)
//   Candle-CorN      -> 'V' green / 'R' red / 'D' doji
// ============================================================
class CandlestickV2 {

    // ── Indicators ───────────────────────────────────────────

    // EMA over an array of numbers; returns the full EMA series.
    static ema(values, period) {
        if (!Array.isArray(values) || values.length < period) return [];
        const k = 2 / (period + 1);
        const out = [];
        let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
        out.push(prev);
        for (let i = period; i < values.length; i++) {
            prev = values[i] * k + prev * (1 - k);
            out.push(prev);
        }
        return out;
    }

    // Wilder-smoothed RSI (matches Deriv Bot's RSI block).
    static rsi(values, period) {
        if (!Array.isArray(values) || values.length < period + 1) return null;
        let gain = 0, loss = 0;
        for (let i = 1; i <= period; i++) {
            const d = values[i] - values[i - 1];
            if (d >= 0) gain += d; else loss -= d;
        }
        gain /= period; loss /= period;
        for (let i = period + 1; i < values.length; i++) {
            const d = values[i] - values[i - 1];
            gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
            loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
        }
        if (loss === 0) return 100;
        return 100 - (100 / (1 + gain / loss));
    }

    // ── Candle metrics (XML: the big tick_analysis maths block) ──
    static metrics(c) {
        const range = Math.abs(c.high - c.low);
        const bodyAbs = Math.abs(c.open - c.close);

        let color;
        if (c.open > c.close) color = 'R';
        else if (c.open < c.close) color = 'V';
        else color = 'D';

        // Guard the XML's implicit divide-by-zero (flat candle => Four Price Doji)
        if (range === 0) {
            return { ...c, color, range: 0, body: 0, upperShadow: 0, lowerShadow: 0 };
        }

        // XML computes red/green shadows separately; they are equivalent to
        // measuring from the body edge that faces the wick.
        const upperShadow = Math.abs((color === 'R' ? c.open : c.close) - c.high) / range;
        const lowerShadow = Math.abs((color === 'R' ? c.close : c.open) - c.low) / range;

        return {
            ...c,
            color,
            range,
            body: Math.abs(Math.round((bodyAbs / range) * 100)),
            upperShadow,
            lowerShadow,
        };
    }

    static pct(v) { return Math.round(v * 100); }

    /**
     * Evaluate all enabled patterns.
     * @param {Array} closedCandles chronological array of closed candles
     * @param {Object|null} forming  the currently forming candle (for confirmation)
     * @returns {{direction:'CALLE'|'PUTE', pattern:string, label:string, reason:string, rsi:number, trend:string}|null}
     */
    static evaluate(closedCandles, forming) {
        const S = CONFIG.STRATEGY;
        if (!closedCandles || closedCandles.length < 8) return null;

        // c(1) = last closed candle, c(2) = one before it, ... (XML "Candle N")
        const m = closedCandles.slice(-8).map(this.metrics);
        const c = (n) => m[m.length - n];           // c(1)..c(6)
        const closes = closedCandles.map(x => x.close);

        const trend = this.emaTrend(closedCandles);
        const rsi = this.rsi(closes, S.RSI_PERIOD);
        if (rsi === null) return null;

        const P = S.PATTERNS;
        const hits = [];
        const add = (pattern, direction, label, reason) =>
            hits.push({ pattern, direction, label, reason, rsi, trend });

        // ══════════════════════════════════════════════════════
        // SINGLE-CANDLE PATTERNS (EMA trend + RSI extreme gated)
        // ══════════════════════════════════════════════════════
        const c1 = c(1);

        // Inverted-hammer shape: long upper wick > 2x body, tiny lower wick
        const invertedHammerShape =
            c1.body > 10 &&
            this.pct(c1.upperShadow) > c1.body * 2 &&
            this.pct(c1.lowerShadow) < 20;

        // Hammer shape: long lower wick > 2x body, tiny upper wick
        const hammerShape =
            c1.body > 10 &&
            this.pct(c1.lowerShadow) > c1.body * 2 &&
            this.pct(c1.upperShadow) < 20;

        if (invertedHammerShape) {
            // Estrela Cadente / Shooting Star — uptrend + overbought
            if (P.EC && trend === 'A' && rsi >= S.RSI_OVERBOUGHT) {
                const dir = S.FIX_SHOOTING_STAR_DIRECTION ? 'PUTE' : 'CALLE';
                add('EC', dir, 'Estrela Cadente / Shooting Star',
                    `Shooting Star | trend=UP RSI=${rsi.toFixed(1)}>=${S.RSI_OVERBOUGHT}`);
            }
            // Martelo Invertido / Inverted Hammer — downtrend + oversold
            if (P.MTI && trend === 'B' && rsi <= S.RSI_OVERSOLD) {
                add('MTI', 'CALLE', 'Martelo Invertido / Inverted Hammer',
                    `Inverted Hammer | trend=DOWN RSI=${rsi.toFixed(1)}<=${S.RSI_OVERSOLD}`);
            }
        }

        if (hammerShape) {
            // Enforcado / Hanging Man — uptrend + overbought -> bearish
            if (P.EF && trend === 'A' && rsi >= S.RSI_OVERBOUGHT) {
                add('EF', 'PUTE', 'Enforcado / Hanging Man',
                    `Hanging Man | trend=UP RSI=${rsi.toFixed(1)}>=${S.RSI_OVERBOUGHT}`);
            }
            // Martelo / Hammer — downtrend + oversold -> bullish
            if (P.MT && trend === 'B' && rsi <= S.RSI_OVERSOLD) {
                add('MT', 'CALLE', 'Martelo / Hammer',
                    `Hammer | trend=DOWN RSI=${rsi.toFixed(1)}<=${S.RSI_OVERSOLD}`);
            }
        }

        // ══════════════════════════════════════════════════════
        // MULTI-CANDLE "CONFIABILIDADE ALTA" PATTERNS
        // ══════════════════════════════════════════════════════
        if (S.HIGH_RELIABILITY && m.length >= 6) {
            const c2 = c(2), c3 = c(3), c4 = c(4), c5 = c(5), c6 = c(6);

            // ── BAA: Bullish Abandoned Baby / Morning Doji Star ──
            if (P.BAA &&
                c3.color === 'R' && c3.body >= 85 &&
                c3.open < c4.low &&
                c2.body <= 5 &&
                this.pct(c2.upperShadow) <= 50 && this.pct(c2.lowerShadow) <= 50 &&
                c2.open > c3.close &&
                c1.color === 'V' && c1.body >= 85) {
                add('BAA', 'CALLE', 'Bebe Abandonado de Alta / Morning Doji Star',
                    'Bullish Abandoned Baby — gap-down doji star between two strong bodies');
            }

            // ── TOUB: Three Outside Up (bullish engulfing + follow-through) ──
            if (P.TOUB &&
                c3.color === 'R' && c2.color === 'V' && c1.color === 'V' &&
                (c2.body * 2) > c3.body &&
                this.pct(c3.lowerShadow) <= 20 && this.pct(c3.upperShadow) <= 20 &&
                c4.open < c3.close && c4.close > c3.open &&
                c2.close > c3.close) {
                add('TOUB', 'CALLE', 'Three Outside Up Bullish',
                    'Three Outside Up — bullish engulfing confirmed by a third green candle');
            }

            // ── CBSB: Concealing Baby Swallow ──
            if (P.CBSB &&
                c4.color === 'R' && c3.color === 'R' && c2.color === 'R' && c1.color === 'R' &&
                c4.body >= 85 && this.pct(c4.upperShadow) <= 2 && this.pct(c4.lowerShadow) <= 2 &&
                c3.body >= 85 && this.pct(c3.upperShadow) <= 2 && this.pct(c3.lowerShadow) <= 2 &&
                c3.open < c4.close && c3.high > c4.close &&
                c2.open < c3.close && c2.close > c3.close &&
                (c1.body * 2) > c2.body) {
                add('CBSB', 'CALLE', 'Concealing Baby Swallow Bullish',
                    'Concealing Baby Swallow — two marubozu, then engulf-and-conceal');
            }

            // ── TWSB: Three White Soldiers ──
            if (P.TWSB &&
                c1.color === 'V' && c2.color === 'V' && c3.color === 'V' &&
                c2.close > c3.close && c3.close > c4.close && c2.close > c4.close &&
                c2.open < c3.close && c3.open < c4.close &&
                c1.body >= 60 && c2.body >= 60 && c3.body >= 60) {
                add('TWSB', 'CALLE', 'Three White Soldiers Bullish',
                    'Three White Soldiers — three rising green bodies >=60%');
            }

            // ── SPB: Solto Para Baixo (bearish two-bar marubozu break) ──
            if (P.SPB &&
                c1.color === 'R' && c2.color === 'V' &&
                c2.body >= 80 && this.pct(c2.upperShadow) <= 2 && this.pct(c2.lowerShadow) <= 2 &&
                c1.body >= 80 && this.pct(c1.lowerShadow) <= 2 && this.pct(c1.upperShadow) <= 2 &&
                c2.open < c3.close) {
                add('SPB', 'PUTE', 'Solto Para Baixo',
                    'Solto Para Baixo — green marubozu followed by red marubozu');
            }

            // ── BAB: Bearish Abandoned Baby / Evening Doji Star ──
            if (P.BAB &&
                c3.color === 'V' && c3.body >= 85 &&
                c3.open > c4.high &&
                c2.body <= 5 &&
                this.pct(c2.upperShadow) <= 50 && this.pct(c2.lowerShadow) <= 50 &&
                c2.open < c3.close &&
                c1.color === 'R' && c1.body >= 85) {
                add('BAB', 'PUTE', 'Bebe Abandonado de Baixa / Evening Doji Star',
                    'Bearish Abandoned Baby — gap-up doji star between two strong bodies');
            }

            // ── NN: Nuvem Negra / Dark Cloud Cover (OFF by default in XML) ──
            if (P.NN &&
                c1.color === 'R' && c2.color === 'V' &&
                c2.open > c3.close && c2.close < c3.close &&
                c1.body >= 70 && c2.body >= 70) {
                add('NN', 'PUTE', 'Nuvem Negra / Dark Cloud Cover',
                    'Dark Cloud Cover — red body pierces back into the prior green body');
            }

            // ── TODB: Three Outside Down ──
            if (P.TODB &&
                c3.color === 'V' && c2.color === 'R' && c1.color === 'R' &&
                (c2.body * 2) > c3.body &&
                this.pct(c3.lowerShadow) <= 20 && this.pct(c3.upperShadow) <= 20 &&
                c4.close < c3.open && c4.open > c3.close &&
                c2.close < c3.close) {
                add('TODB', 'PUTE', 'Three Outside Down Bearish',
                    'Three Outside Down — bearish engulfing confirmed by a third red candle');
            }

            // ── FTMB: Falling Three Methods ──
            if (P.FTMB &&
                c1.color === 'R' && c2.color === 'V' && c4.color === 'V' && c5.color === 'R' &&
                c5.body >= 80 && c4.body <= 50 && c3.body <= 50 && c2.body <= 50 &&
                c5.close < c6.high && c5.open > c6.low &&
                c4.close < c6.high && c4.open > c6.low &&
                c3.close < c6.high && c3.open > c6.low &&
                c1.body >= 80 && c2.close < c6.close) {
                add('FTMB', 'PUTE', 'Falling Three Methods Bearish',
                    'Falling Three Methods — three small bars contained, then a strong red break');
            }

            // ── ITCB: Identical Three Crows ──
            if (P.ITCB &&
                c1.color === 'R' && c2.color === 'R' && c3.color === 'R' &&
                c2.close < c3.close && c3.close < c4.close && c2.close < c4.close &&
                c2.open >= c3.close && c3.open >= c4.close &&
                c1.body >= 60 && c2.body >= 60 && c3.body >= 60) {
                add('ITCB', 'PUTE', 'Identical Three Crows Bearish',
                    'Identical Three Crows — three falling red bodies >=60%');
            }
        }

        if (!hits.length) return null;

        // XML evaluates patterns sequentially and the last assignment wins;
        // we keep the first (highest-priority) hit and report any conflict.
        const signal = hits[0];
        if (hits.length > 1) {
            const others = hits.slice(1).map(h => `${h.pattern}:${h.direction}`).join(', ');
            LOGGER.debug(`[Candlestick v2] ${hits.length} simultaneous patterns; taking ${signal.pattern}. Others: ${others}`);
        }

        // ── XML: "Esperar Confirmação" — open[1] vs close[2] ──
        if (S.WAIT_CONFIRMATION) {
            if (!forming || typeof forming.open !== 'number') {
                LOGGER.debug(`[Candlestick v2] ${signal.pattern} held — no forming candle for confirmation`);
                return null;
            }
            // The XML uses "open[1] > close[2]" for every pattern; that only makes
            // sense as "the new candle opened in the signal's favour", so we
            // direction-align it: bullish needs open above, bearish needs below.
            const ok = signal.direction === 'CALLE'
                ? forming.open > c1.close
                : forming.open < c1.close;
            if (!ok) {
                LOGGER.debug(`[Candlestick v2] ${signal.pattern} (${signal.direction}) NOT confirmed — forming open ${forming.open} vs last close ${c1.close}`);
                return null;
            }
            signal.reason += ' | confirmed by next-candle open';
        }

        return signal;
    }

    /**
     * XML tick_analysis EMA trend block:
     *   for i = 1..9: compare EMA(4)[10-i] against close[10-i]
     *   more EMA-above-close  -> 'B' (downtrend)
     *   otherwise             -> 'A' (uptrend)
     */
    static emaTrend(closedCandles) {
        const S = CONFIG.STRATEGY;
        if (!S.USE_EMA_TREND) return 'A';

        const need = S.EMA_PERIOD + S.EMA_LOOKBACK + 2;
        if (closedCandles.length < need) return 'A';

        const closes = closedCandles.map(c => c.close);
        const emaSeries = this.ema(closes, S.EMA_PERIOD);
        if (!emaSeries.length) return 'A';

        // Align EMA series to the close series (EMA starts at index period-1)
        const offset = S.EMA_PERIOD - 1;
        let below = 0, above = 0;

        for (let i = 1; i <= S.EMA_LOOKBACK; i++) {
            const closeIdx = closes.length - 1 - (S.EMA_LOOKBACK - i);
            const emaIdx = closeIdx - offset;
            if (emaIdx < 0 || emaIdx >= emaSeries.length) continue;
            if (emaSeries[emaIdx] > closes[closeIdx]) below++;   // candle below EMA
            else above++;
        }

        return below > above ? 'B' : 'A';
    }
}

// ============================================================
// PER-PATTERN WIN/LOSS TRACKER  (XML: "Contabilizar Winrate")
// ============================================================
class PatternStats {

    static _store = {};

    static ensure(pattern) {
        if (!this._store[pattern]) this._store[pattern] = { win: 0, loss: 0 };
        return this._store[pattern];
    }

    static record(pattern, isWin) {
        if (!pattern || !CONFIG.STRATEGY.TRACK_PATTERN_WINRATE) return;
        const s = this.ensure(pattern);
        if (isWin) s.win++; else s.loss++;
    }

    static load(saved) {
        if (saved && typeof saved === 'object') this._store = saved;
    }

    static dump() { return this._store; }

    static summaryLines() {
        const keys = Object.keys(this._store).sort();
        if (!keys.length) return 'no pattern trades yet';
        return keys.map(k => {
            const s = this._store[k];
            const t = s.win + s.loss;
            const wr = t ? ((s.win / t) * 100).toFixed(0) : '0';
            return `${k} ${s.win}x${s.loss} (${wr}%)`;
        }).join(' | ');
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
                patternStats: PatternStats.dump(),
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
                    forceRecoverDirection: a.forceRecoverDirection,
                    recoveryStep: a.recoveryStep,
                    currentStake: a.currentStake,
                    martingaleLevel: a.martingaleLevel,
                    investmentRemaining: a.investmentRemaining,
                    consecutiveWins: a.consecutiveWins,
                    consecutiveLosses: a.consecutiveLosses,
                    cooldownCandles: a.cooldownCandles,
                    //  state
                    buyFlagActive: a.buyFlagActive,
                    sellFlagActive: a.sellFlagActive,
                    inTradeCycle: a.inTradeCycle,
                    waitingForReentry: a.waitingForReentry,
                    priceReturnedToZone: a.priceReturnedToZone,
                    currentDirection: a.currentDirection,
                    // Normal mode state
                    normalModeActive: a.normalModeActive,
                    tradesInNormalMode: a.tradesInNormalMode,
                    normalModeDirection: a.normalModeDirection,
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
            PatternStats.load(data.patternStats);

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
                        a.forceRecoverDirection = saved.forceRecoverDirection ?? null;
                        a.recoveryStep = saved.recoveryStep || 0;
                        a.martingaleLevel = saved.martingaleLevel || 0;
                        a.currentStake = saved.currentStake || StakeCalculator.calculate(a.investmentRemaining);
                        a.investmentRemaining = saved.investmentRemaining || CONFIG.INVESTMENT_AMOUNT;
                        a.consecutiveWins = saved.consecutiveWins || 0;
                        a.consecutiveLosses = saved.consecutiveLosses || 0;
                        a.cooldownCandles = saved.cooldownCandles || 0;

                        // state
                        a.buyFlagActive = saved.buyFlagActive || false;
                        a.sellFlagActive = saved.sellFlagActive || false;
                        a.inTradeCycle = saved.inTradeCycle || false;
                        a.waitingForReentry = saved.waitingForReentry || false;
                        a.priceReturnedToZone = saved.priceReturnedToZone || false;
                        a.currentDirection = saved.currentDirection || null;

                        // Normal mode state
                        a.normalModeActive = saved.normalModeActive || false;
                        a.tradesInNormalMode = saved.tradesInNormalMode || 0;
                        a.normalModeDirection = saved.normalModeDirection || null;

                        // Stats
                        a.tradesCount = saved.tradesCount || 0;
                        a.winsCount = saved.winsCount || 0;
                        a.lossesCount = saved.lossesCount || 0;
                        a.netPL = saved.netPL || 0;
                        a.profit = saved.profit || 0;
                        a.loss = saved.loss || 0;
                        a.activePositions = (saved.activePositions || []).map(p => ({ ...p }));

                        LOGGER.info(`${symbol}: Rec=${a.recoveryStep} Stake=$${(a.currentStake || 0).toFixed(2)} P/L=$${(a.netPL || 0).toFixed(2)} | Wins=${a.winsCount} Losses=${a.lossesCount} Trades=${a.tradesCount} | NormalMode=${a.normalModeActive ? 'ON' : 'OFF'}`);
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

        const lines = [
            `${emoji} <b>CANDLE DIRECTION BOT v1.0 — ${type}</b>`,
            `Pair: <b>${symbol}</b>  Direction: <b>${direction === 'CALLE' ? '\u{1f4c8} CALLE' : '\u{1f4c9} PUTE'}</b>`,
            `Stake: $${stake.toFixed(2)} | Duration: ${duration}${(durationUnit || 's').toUpperCase()}`,
            `Recovery Step: ${a?.recoveryStep ?? 0} | ${TradingSessionManager.getStatusString()}`,
            ``,
        ];

        if (type === 'OPEN' && details.signal) {
            const sig = details.signal;
            const modeLabel = sig.marketMode === 'trend' ? '\u{1f4c8} TREND' : '\u{1f4c9} RANGE';
            lines.push(`\u{1f9e0} <b>Signal:</b> ${'CANDLE DIRECTION'}`);
            lines.push(`Market Mode: ${modeLabel}`);
            if (a?.breakout?.active) {
                lines.push(`Levels: H=${a.breakout.highLevel.toFixed(5)} L=${a.breakout.lowLevel.toFixed(5)}`);
            }
            if (a?.normalModeActive) {
                lines.push(`Normal Mode: ${a.tradesInNormalMode} | Direction: ${a.normalModeDirection}`);
            }
        }

        if (details.profit !== undefined) {
            const pl = Number(details.profit) || 0;
            lines.push(`Profit: ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}`);
            lines.push(``);
            lines.push(`\u{1f4cb} <b>${symbol} Stats:</b>`);
            lines.push(`W/L: ${a?.winsCount ?? 0}/${a?.lossesCount ?? 0} | P/L: $${(a?.netPL ?? 0).toFixed(2)}`);
            lines.push(`\u{1f522} Martingale Level: ${a?.martingaleLevel ?? 0}`);
            lines.push(``);
            lines.push(`\u{1f4cb} <b>Today:</b>`);
            lines.push(`Trades: ${today.tradesCount} | W/L: ${today.winsCount}/${today.lossesCount} | P/L: $${(today.netPL || 0).toFixed(2)}`);
            lines.push(`\u{1f4c9} x2-x9: ${state.session.x2Losses || 0} | ${state.session.x3Losses || 0} | ${state.session.x4Losses || 0} | ${state.session.x5Losses || 0} | ${state.session.x6Losses || 0} | ${state.session.x7Losses || 0} | ${state.session.x8Losses || 0} | ${state.session.x9Losses || 0}`);
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
                const normalInfo = a.normalModeActive ? `Nrm:${a.tradesInNormalMode}/${CONFIG.MAX_TRADES_PER_CYCLE}` : '';
                assetInfo += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L $${(a.netPL || 0).toFixed(2)} Rec:${a.recoveryStep} ${normalInfo}`;
            }
        });

        await this.sendMessage([
            `⏰ <b>CANDLE DIRECTION BOT v1.0 Hourly</b>`,
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
            `\u{1f4ca} <b>CANDLE DIRECTION BOT v1.0 SESSION SUMMARY</b>`,
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
            `\u{1f916} <b>CANDLE DIRECTION BOT v1.0 STARTED</b>`,
            `Strategy: Candle Direction + Normal Trading Mode`,
            `Candle Period: ${CONFIG.CANDLE_PERIOD} | Overbought: ${CONFIG.CANDLE_OVERBOUGHT} | Oversold: ${CONFIG.CANDLE_OVERSOLD}`,
            `Risk: Martingale progression with cap $${CONFIG.INVESTMENT_AMOUNT}`,
            `Recovery: ${CONFIG.AFTER_MAX_LOSS === 'continue' ? 'Continue after max loss using extra levels' : 'Reset on max loss'}`,
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
                `\u{1f319} <b>CANDLE DIRECTION BOT END OF DAY ${state.currentTradeDay}</b>\nP/L: $${(dayStats?.netPL || 0).toFixed(2)}\nCapital: $${state.capital.toFixed(2)}`
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

    static recordTradeResult(symbol, profit, direction, stake, pattern = null) {
        const a = state.assets[symbol];
        if (!a) return;

        // XML: "Contabilizar Winrate" — per-pattern bookkeeping
        if (pattern) {
            PatternStats.record(pattern, profit > 0);
            LOGGER.info(`\u{1f4d0} Pattern winrate -> ${PatternStats.summaryLines()}`);
        }

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

            // Credit payout (stake + profit) back to investment pool — pool grows on win
            a.investmentRemaining = Number((a.investmentRemaining + stake + profit).toFixed(2));
            a.currentStake = StakeCalculator.calculate(a.investmentRemaining, 0);

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

            a.currentStake = StakeCalculator.calculate(a.investmentRemaining, a.martingaleLevel);

            if (a.consecutiveLosses >= 10) {
                a.currentStake = CONFIG.INITIAL_STAKE;
                a.cooldownCandles = CONFIG.COOLDOWN_CANDLES;
                a.forceRecoverDirection = null;
                LOGGER.warn(`[${symbol}] 10 consecutive losses — cooling down for ${CONFIG.COOLDOWN_CANDLES} candles`);
                TelegramService.sendMessage(
                    `❄️ <b>[${symbol}] CANDLE DIRECTION BOT COOL-DOWN ACTIVATED</b>\n` +
                    `10 consecutive losses\n` +
                    `Pausing for ${CONFIG.COOLDOWN_CANDLES} candles\n` +
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
    capital: CONFIG.INVESTMENT_AMOUNT,
    accountBalance: 0,
    currentTradeDay: null,
    session: {
        profit: 0, loss: 0, netPL: 0,
        tradesCount: 0, winsCount: 0, lossesCount: 0,
        x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
        x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0,
        isActive: true, startTime: Date.now(), startCapital: CONFIG.INVESTMENT_AMOUNT,
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
                state.assets[symbol] = {
                    candles: [], closedCandles: [],
                    currentFormingCandle: null,
                    lastProcessedCandleOpenTime: null,
                    candlesLoaded: false,
                    lastTradeDirection: null,
                    lastTradeWasWin: null,
                    forceRecoverDirection: null,
                    recoveryStep: 0,
                    currentStake: StakeCalculator.calculate(CONFIG.INVESTMENT_AMOUNT),
                    martingaleLevel: 0,
                    recoveryStep: 0,
                    investmentRemaining: CONFIG.INVESTMENT_AMOUNT,
                    canTrade: false,
                    consecutiveWins: 0,
                    consecutiveLosses: 0,
                    cooldownCandles: 0,
                    activePositions: [],
                    tradesCount: 0, winsCount: 0, lossesCount: 0,
                    profit: 0, loss: 0, netPL: 0,

                    // state
                    buyFlagActive: false,
                    sellFlagActive: false,
                    inTradeCycle: false,
                    waitingForReentry: false,
                    priceReturnedToZone: false,
                    currentDirection: null,

                    // Normal mode state
                    normalModeActive: false,
                    tradesInNormalMode: 0,
                    normalModeDirection: null,
                    normalModePaused: false,
                    lastPattern: null,
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

        SessionManager.recordTradeResult(ownerSym, profit, pos.direction, pos.stake, pos.signal?.pattern || null);
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

                    const dir = closed.close > closed.open ? '\u{1f7e2}' : '\u{1f534}';
                    const time = new Date(closed.epoch * 1000).toISOString();
                    LOGGER.candle(`${dir} [${symbol}] CANDLE CLOSED [${time}] O:${closed.open.toFixed(5)} H:${closed.high.toFixed(5)} L:${closed.low.toFixed(5)} C:${closed.close.toFixed(5)} | Total: ${a.closedCandles.length}`);

                    if (a.cooldownCandles > 0) {
                        a.cooldownCandles--;
                        if (a.cooldownCandles === 0) a.forceRecoverDirection = null;
                        LOGGER.info(`❄️ [${symbol}] Cool-down: ${a.cooldownCandles} candles remaining`);
                    }

                    a.canTrade = true;

                    // Publish the new forming candle BEFORE evaluating, so the
                    // Candlestick v2 confirmation rule can read its open price.
                    a.currentFormingCandle = incoming;

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
            TelegramService.sendMessage(`⚠️ <b>CANDLE DIRECTION BOT CONNECTION LOST</b> — Reconnecting (attempt ${this.reconnectAttempts})`);

            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (this.isShuttingDown) return;
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached — giving up');
            TelegramService.sendMessage(`\u{1f6d1} <b>CANDLE DIRECTION BOT STOPPED</b> — Max reconnections\nFinal P/L: $${(state.session.netPL || 0).toFixed(2)}`);
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
// MAIN BOT CLASS — v1 CANDLE DIRECTION (FIXED)
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
        console.log(' DERIV CALLE/PUTE BOT v1.0 — CANDLE DIRECTION (Candle Direction Engine)');
        console.log('═'.repeat(74));
        console.log(`Assets    : ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        console.log(`Timeframe : ${CONFIG.TIMEFRAME_LABEL} candles | Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT}`);
        console.log(`Risk      : Martingale level progression with cap $${CONFIG.INVESTMENT_AMOUNT}`);
        console.log(`Capital   : $${state.capital.toFixed(2)}`);
        console.log(`Sessions  : ${TradingSessionManager.getStatusString()}`);
        if (CONFIG.STRATEGY.ENABLED) {
            const on = Object.keys(CONFIG.STRATEGY.PATTERNS).filter(k => CONFIG.STRATEGY.PATTERNS[k]);
            console.log(`Strategy  : CANDLESTICK v2 (ORSTAC port) — ${on.length}/${Object.keys(CONFIG.STRATEGY.PATTERNS).length} patterns enabled`);
            console.log(`Filters   : EMA(${CONFIG.STRATEGY.EMA_PERIOD}) trend over ${CONFIG.STRATEGY.EMA_LOOKBACK} bars | RSI(${CONFIG.STRATEGY.RSI_PERIOD}) ${CONFIG.STRATEGY.RSI_OVERSOLD}/${CONFIG.STRATEGY.RSI_OVERBOUGHT} | Confirmation: ${CONFIG.STRATEGY.WAIT_CONFIRMATION ? 'ON' : 'OFF'}`);
            console.log(`Patterns  : ${on.join(', ')}`);
        } else {
            console.log('Strategy  : LEGACY candle-direction engine');
        }
        console.log('═'.repeat(74) + '\n');

        state.currentTradeDay = TradeHistoryManager.getDateKey();
        TradeHistoryManager.ensureDayEntry(state.currentTradeDay);
        this.connection.initializeAssets();

        CONFIG.ACTIVE_ASSETS.forEach(sym => this.subscribeToCandles(sym));

        await TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();
        TelegramService.startDailyTimer();
        this.startSessionTimeChecker();

        LOGGER.info('CANDLE DIRECTION BOT v1.0 fully started!');
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

    // ════════════════════════════════════════════════════════
    // CORE TRADE LOGIC — called on every candle close (FIXED)
    //
    // PRIORITY ORDER:
    //   1. MARTINGALE recovery after loss
    //   2. NORMAL mode — trade candle direction for N trades
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
            a.currentStake = StakeCalculator.calculate(a.investmentRemaining);
            a.canTrade = false;
            return;
        }

        if (a.closedCandles.length < CONFIG.MIN_CANDLES_REQUIRED) {
            LOGGER.debug(`[${symbol}] Not enough candles yet (${a.closedCandles.length}/${CONFIG.MIN_CANDLES_REQUIRED})`);
            a.canTrade = false;
            return;
        }

        // ── Only trade the asset that is in martingale recovery; skip all others ──
        const recoveringAsset = CONFIG.ACTIVE_ASSETS.find(s => state.assets[s]?.forceRecoverDirection);
        if (recoveringAsset && recoveringAsset !== symbol) {
            LOGGER.debug(`[${symbol}] Skipping — ${recoveringAsset} is in martingale recovery`);
            return;
        }

        // ════════════════════════════════════════════════════════
        // CANDLESTICK v2 STRATEGY (ORSTAC port)
        // ════════════════════════════════════════════════════════
        if (CONFIG.STRATEGY.ENABLED) {
            let signal = null;
            try {
                signal = CandlestickV2.evaluate(a.closedCandles, a.currentFormingCandle);
            } catch (err) {
                LOGGER.error(`[${symbol}] Candlestick v2 evaluation error: ${err.message}`);
                return;
            }

            if (!signal) {
                const trend = CandlestickV2.emaTrend(a.closedCandles);
                const rsiVal = CandlestickV2.rsi(a.closedCandles.map(x => x.close), CONFIG.STRATEGY.RSI_PERIOD);
                LOGGER.debug(
                    `[${symbol}] No Candlestick v2 pattern | trend=${trend === 'A' ? 'UP' : 'DOWN'} ` +
                    `RSI=${rsiVal === null ? 'n/a' : rsiVal.toFixed(1)} | ` +
                    `last O:${lastClosedCandle.open.toFixed(5)} H:${lastClosedCandle.high.toFixed(5)} ` +
                    `L:${lastClosedCandle.low.toFixed(5)} C:${lastClosedCandle.close.toFixed(5)}`
                );
                return;
            }

            const dirLabel = signal.direction === 'CALLE' ? '\u{1f4c8} CALLE' : '\u{1f4c9} PUTE';
            LOGGER.signal(
                `[${symbol}] ${signal.pattern} — ${signal.label} -> ${signal.direction} | ` +
                `trend=${signal.trend === 'A' ? 'UP' : 'DOWN'} RSI=${signal.rsi.toFixed(1)}`
            );

            a.normalModeActive = true;
            a.tradesInNormalMode = 1;
            a.normalModeDirection = signal.direction;
            a.lastTradeDirection = signal.direction;
            a.currentDirection = signal.direction;
            a.lastPattern = signal.pattern;

            LOGGER.normal(
                `[${symbol}] CANDLESTICK v2 ${dirLabel} [${signal.pattern}] | Stake: $${stake.toFixed(2)}`
            );

            this._executeBuy(symbol, signal.direction, stake, {
                method: `CANDLESTICK_V2_${signal.pattern}`,
                pattern: signal.pattern,
                patternLabel: signal.label,
                reason: signal.reason,
                trend: signal.trend,
                rsi: signal.rsi,
            });

            a.buyFlagActive = false;
            a.sellFlagActive = false;
            return;
        }

        // ════════════════════════════════════════════════════════
        // LEGACY candle-direction engine (STRATEGY.ENABLED = false)
        // ════════════════════════════════════════════════════════
        const dir = lastClosedCandle.close > lastClosedCandle.open ? 'CALLE' : 'PUTE';
        const mode = this._determineMarketMode(a.closedCandles);

        if (mode === 'trend') {
            const firstDir = dir;
            LOGGER.signal(`[${symbol}] ${firstDir === 'CALLE' ? 'BUY' : 'SELL'} SIGNAL`);

            a.normalModeActive = true;
            a.tradesInNormalMode = 1;
            a.normalModeDirection = firstDir;
            a.lastTradeDirection = firstDir;
            a.currentDirection = firstDir;

            LOGGER.normal(`[${symbol}] NORMAL MODE #1/${CONFIG.MAX_TRADES_PER_CYCLE} ${firstDir === 'CALLE' ? '\u{1f4c8}' : '\u{1f4c9}'} ${firstDir} (initial signal trade) | Stake: $${stake.toFixed(2)}`);

            this._executeBuy(symbol, firstDir, stake, {
                method: firstDir === 'CALLE' ? 'CANDLE_CLOSE_BULLISH' : 'CANDLE_CLOSE_BEARISH',
                reason: `${firstDir === 'CALLE' ? 'CANDLE_CLOSE_BULLISH' : 'CANDLE_CLOSE_BEARISH'} signal`,
                marketMode: mode,
            });

            a.buyFlagActive = false;
            a.sellFlagActive = false;
            return;
        }

        // No signal — log status
        LOGGER.debug(`[${symbol}] No new trade signal detected — last closed candle: O:${lastClosedCandle.open.toFixed(5)} H:${lastClosedCandle.high.toFixed(5)} L:${lastClosedCandle.low.toFixed(5)} C:${lastClosedCandle.close.toFixed(5)}`);
    }

    // ── Determine market mode from last 3 closed candles ──
    // Ranging: candles alternate every time (B→R→B or R→B→R)
    // Trending: candles do NOT fully alternate (B→R→R, R→B→B, B→B→B, etc.)
    _determineMarketMode(closedCandles) {
        if (!closedCandles || closedCandles.length < 3) return 'range';

        const recent = closedCandles.slice(-3);
        const types = recent.map(c => (c.close > c.open ? 'B' : 'R'));

        // Count how many times adjacent candles differ (alternate)
        let alternations = 0;
        for (let i = 1; i < types.length; i++) {
            if (types[i] !== types[i - 1]) alternations++;
        }

        // With 3 candles (2 pairs): all pairs alternate → range; otherwise → trend
        const mode = alternations === 2 ? 'range' : 'trend';
        LOGGER.debug(`[MarketMode] ${types.join('→')} → ${mode} (${alternations} alternations)`);
        return mode;
    }

    // ── Execute a buy order (CALLE/PUTE) ──────────────────
    _executeBuy(symbol, direction, stake, signalInfo = {}) {
        this._tradeLocked = true;
        state.assets[symbol].canTrade = false;

        // Deduct stake from rolling investment pool (reference bot behavior)
        state.assets[symbol].investmentRemaining = Number((state.assets[symbol].investmentRemaining - stake).toFixed(2));
        state.capital = Number((state.capital - stake).toFixed(2));

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
            `\u{1f3af} [${symbol}] ${direction === 'CALLE' ? '\u{1f4c8} CALLE' : '\u{1f4c9} PUTE'} |` +
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
            `⚠️ <b>CANDLE DIRECTION BOT STUCK TRADE RECOVERED [${reason}]</b>\n` +
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
                    currentStake: a.currentStake,
                    activePositions: a.activePositions.length,
                    cooldownCandles: a.cooldownCandles,
                    trades: a.tradesCount, wins: a.winsCount, losses: a.lossesCount, netPL: a.netPL,
                    lastDirection: a.lastTradeDirection,
                    buyFlag: a.buyFlagActive,
                    sellFlag: a.sellFlagActive,
                    normalMode: a.normalModeActive,
                    normalTrades: a.tradesInNormalMode,
                    lastPattern: a.lastPattern || null,
                };
            }
        });

        return {
            connected: state.isConnected, authorized: state.isAuthorized, capital: state.capital,
            session: SessionManager.getSessionStats(), sessionInfo: TradingSessionManager.getSessionInfo(),
            totalPositions: CONFIG.ACTIVE_ASSETS.reduce((s, sym) => s + (state.assets[sym]?.activePositions?.length ?? 0), 0),
            pairs: pairStatuses, overall, today,
            patternStats: PatternStats.dump(),
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

console.log('\n\u{1f680} Starting CANDLE DIRECTION BOT v1.0...\n');
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
            const cdwn = p.cooldownCandles > 0 ? `❄️CD:${p.cooldownCandles}` : '';

            const pat = p.lastPattern ? ` [${p.lastPattern}]` : '';
            pairLines += `\n  ${sym}:${pat} ${p.buyFlag ? '\u{1f7e2}BF' : ''} ${p.sellFlag ? '\u{1f534}SF' : ''} Rec${p.recoveryStep} $${(p.currentStake || 0).toFixed(2)} | ${p.trades}t ${p.wins}W/${p.losses}L $${(p.netPL || 0).toFixed(2)} | Pos:${p.activePositions} ${normal}${cdwn}`;
        }
    });

    console.log(`\n\u{1f4ca} ${getGMTTime()} | Session: ${status.session.trades}t ${status.session.winRate} $${(status.session.netPL || 0).toFixed(2)} | Capital: $${status.capital.toFixed(2)}`);
    console.log(`\u{1f4cb} Overall: ${status.overall.tradesCount}t | P/L: $${(status.overall.netPL || 0).toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
    console.log(`\u{1f555} ${TradingSessionManager.getStatusString()}`);
    console.log(`\u{1f4c8} Assets:${pairLines}`);
    if (CONFIG.STRATEGY.ENABLED) console.log(`\u{1f4d0} Patterns: ${PatternStats.summaryLines()}`);

}, 60000);

bot.statusDisplayIntervalId = statusInterval;
