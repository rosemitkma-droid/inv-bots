'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║      DERIV SYNTHETIC INDICES CALLE/PUTE BOT  —  v3.0  "DARE"            ║
 * ║      Directional Adaptive Regime Engine                                  ║
 * ║                                                                          ║
 * ║  ────────────────────────────────────────────────────────────────────── ║
 * ║  NOVEL STRATEGY  (synthesized from Rise/Fall research — see block below) ║
 * ║                                                                          ║
 * ║  CORE INSIGHT: Synthetic indices are PRNG random walks with drift ≈ 0.   ║
 * ║  No static directional system beats them long-term. The only durable     ║
 * ║  edges in binary Rise/Fall are:                                          ║
 * ║     (a) EXPECTED-VALUE (payout) GATING                                    ║
 * ║     (b) REGIME CONDITIONING that tilts conditional P(win) 50% → 55-60%   ║
 * ║     (c) KELLY position sizing + diversification                          ║
 * ║     (d) AVOIDING ruin — no martingale ladders                            ║
 * ║                                                                          ║
 * ║  THE DARE ENGINE (4 layers, all novel relative to the v2 scaffold):     ║
 * ║                                                                          ║
 * ║  LAYER 0 — DATA INTEGRITY                                                ║
 * ║    · Log-return computation + sigma/range sanity                         ║
 * ║    · Minimum sample gate                                                 ║
 * ║                                                                          ║
 * ║  LAYER 1 — REGIME CLASSIFIER (adaptive, self-normalized per asset)       ║
 * ║    · Variance-Ratio statistic (Lo-MacKinlay VR(q)) → quantitative       ║
 * ║      persistence measure. VR>1 = trending, VR<1 = mean-reverting,       ║
 * ║      VR≈1 = random walk → STAND ASIDE.                                   ║
 * ║    · ATR percentile regime (LOW / NORMAL / HIGH / EXTREME)               ║
 * ║      — percentile vs asset's OWN recent history, never static thresholds ║
 * ║    · BB-squeeze guard (collapsing volatility = await breakout)          ║
 * ║    · Extreme-volatility circuit-breaker (skip choppy chaos)              ║
 * ║                                                                          ║
 * ║  LAYER 2 — STRATEGY ROUTER (regime → method)                             ║
 * ║    · TRENDING  + NORMAL vol  → MOMENTUM sub-engine                       ║
 * ║         EMA stack (8/21/50) + Supertrend + MACD accel + Donchian BO      ║
 * ║    · MEAN-REVERTING + NORMAL/LOW vol → MEAN-REVERSION sub-engine         ║
 * ║         Bollinger %B extremes + RSI z-score + Stochastic reversal +      ║
 * ║         reversal-candle confirmation (fade the extreme)                  ║
 * ║    · Other regimes → NO TRADE                                            ║
 * ║                                                                          ║
 * ║  LAYER 3 — CONVICTION SCORER (calibrated P(win))                         ║
 * ║    · Each contributing signal returns a 0..1 sub-confidence × weight     ║
 * ║    · Calibrated p = base_p + Σ(weight_i × conf_i)                        ║
 * ║    · base_p drifts the prior toward the asset's empirical hit-rate       ║
 * ║                                                                          ║
 * ║  LAYER 4 — EV / RISK GATE (the real binary-options edge)                 ║
 * ║    · Fetch live proposal → net odds b = payout/ask − 1                   ║
 * ║    · EV = p·b − (1−p); require EV > MIN_EDGE                             ║
 * ║    · Kelly stake scaled by conviction: k = (p·b − (1−p)) / b             ║
 * ║    · Hard caps: MIN_STAKE, MAX_STAKE, MAX_RISK_PCT                       ║
 * ║                                                                          ║
 * ║  RISK MANAGEMENT — single capped recoup step (NOT martingale)            ║
 * ║    · After a loss: ONE recoup attempt, ×1.3 multiplier, hard-capped at   ║
 * ║      MAX_RECOUP_STAKE_PCT of capital. Never a ladder.                    ║
 * ║    · No "force-trade after loss" (v2's most dangerous feature).          ║
 * ║    · Consecutive-loss cool-down, daily & session stop-losses.            ║
 * ║                                                                          ║
 * ║  RETAINED FROM v2 SCAFFOLD (unchanged):                                  ║
 * ║    API_TOKEN, APP_ID, Telegram credentials, RestClient, dual-mode        ║
 * ║    PAT/legacy WebSocket auth, ConnectionManager, watchdog, persistence,  ║
 * ║    trade-history, TelegramService, SessionManager plumbing, state shape. ║
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
const STATE_FILE          = path.join(__dirname, 'dare_02-state_v3.json');
const HISTORY_FILE        = path.join(__dirname, 'dare_02-history_v3.json');
const STATE_SAVE_INTERVAL = 5000;  // ms
// ============================================================
// LOGGER  [RETAINED]
// ============================================================
const getGMTTime = () =>
    new Date().toISOString().replace('T', ' ').split('.')[0] + ' GMT';
const LOGGER = {
    info:  (msg) => console.log(`[INFO]  ${getGMTTime()} - ${msg}`),
    trade: (msg) => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn:  (msg) => console.warn(`\x1b[33m[WARN]  ${getGMTTime()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); },
    signal:(msg) => console.log(`\x1b[36m[SIGNAL]${getGMTTime()} - ${msg}\x1b[0m`),
    regime:(msg) => console.log(`\x1b[35m[REGIME]${getGMTTime()} - ${msg}\x1b[0m`),
};
// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
    // ── Deriv API [RETAINED credentials] ─────────────────────
    API_TOKEN:    'pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee',
    APP_ID:       '33uslPtthXBEkQOdfKfoY',
    ACCOUNT_TYPE: 'demo',          // 'demo' | 'real' (PAT mode only)
    WS_URL:       'wss://ws.derivws.com/websockets/v3',
    // ── Capital & Risk ────────────────────────────────────────
    INITIAL_CAPITAL:            250,
    BASE_RISK_PERCENT_PER_TRADE: 0.05, // % of capital per trade (Kelly-fractional base)
    MIN_STAKE:                  1,
    MAX_STAKE:                  150,
    MAX_RISK_PCT:               1.50,  // Hard cap: never risk >1.5% of capital on a single trade
    // ── DARE Edge / EV gating (the real binary-options edge) ──
    ENABLE_EV_GATE:       true,   // Fetch live proposal, gate on EV before buying
    MIN_EDGE:             0.015,  // Require EV >= +1.5% net (after payout/ask)
    MIN_WIN_PROB:         0.545,  // Calibrated P(win) floor before EV even computed
    MAX_LOSS_PROB_TARGET: 0.45,   // 1 - MIN_WIN_PROB, used for diagnostics
    // ── Single capped recoup step (NOT martingale) ────────────
    RECOVERY_ENABLED:       true,
    RECOVERY_MULTIPLIER:    1.30,   // ONE recoup step only
    MAX_RECOVERY_STEPS:     1,      // Hard rule: never more than 1 recoup (no ladder)
    MAX_RECOVERY_STAKE_PCT: 1.5,    // Recoup stake capped at 1.5% of capital
    // ── Session / daily guards [RETAINED structure] ───────────
    SESSION_PROFIT_TARGET:      5000,
    SESSION_STOP_LOSS:          -1500,
    DAILY_STOP_LOSS:            -2000,
    MAX_CONSECUTIVE_LOSSES:     3,
    COOLDOWN_CANDLES:           5,
    // ── Candle / Contract Settings ────────────────────────────
    GRANULARITY:                300,     // 5-minute candles
    TIMEFRAME_LABEL:            '5m',
    CANDLES_TO_LOAD:            200,     // larger window for percentile + VR(q) stability
    MAX_CANDLES_STORED:         300,
    DURATION:                   294,
    DURATION_UNIT:              's',
    MIN_CANDLES_REQUIRED:       80,      // raised — VR & percentile need warmup
    // ── LAYER 1: Regime Classifier ───────────────────────────
    // Variance-Ratio (Lo-MacKinlay) — VR(1) on q-lagged returns.
    VR_Q:                        4,     // q-period variance ratio
    VR_TREND_BAND:               1.10,  // VR >= this          → trending
    VR_REVERT_BAND:              0.90,  // VR <= this          → mean-reverting
    VR_PERSISTENCE_HISTORY:      3,     // require N recent bars agree on regime
    VR_LOOKBACK:                 60,    // sample window for VR computation
    // Adaptive ATR percentile (per-asset, self-normalized)
    ATR_PERIOD:                  14,
    ATR_PCT_LOOKBACK:            120,
    ATR_PCT_EXTREME_HIGH:        92,    // >= 92nd percentile → EXTREME (skip)
    ATR_PCT_EXTREME_LOW:         4,     // <= 4th percentile  → DEAD (skip / squeeze)
    // Bollinger squeeze guard
    BB_PERIOD:                   20,
    BB_STD_DEV:                  2.0,
    BB_SQUEEZE_THRESHOLD:        0.0025, // width/price below this = collapsing vol
    // ── LAYER 2: Trend sub-engine ────────────────────────────
    EMA_FAST: 8, EMA_SLOW: 21, EMA_TREND: 50,
    SUPERTREND_ATR_PERIOD: 10, SUPERTREND_MULTIPLIER: 3.0,
    DONCHIAN_PERIOD:        20,
    MACD_FAST: 12, MACD_SLOW: 26, MACD_SIGNAL: 9,
    RSI_PERIOD: 14,
    STOCH_K: 5, STOCH_D: 3, STOCH_SMOOTH: 3,
    // ── LAYER 2: Mean-reversion sub-engine ───────────────────
    MR_BB_PCTB_EXTREME_HIGH: 0.98, // %B >= 0.98 → overbought extreme (fade down)
    MR_BB_PCTB_EXTREME_LOW:  0.02, // %B <= 0.02 → oversold extreme (fade up)
    MR_RSI_OB:               72,
    MR_RSI_OS:               28,
    // ── LAYER 3: Conviction weights (sum need not = 1; calibrated) ─
    // Momentum weights
    W_MOM_EMA:        0.18,
    W_MOM_SUPERTREND: 0.18,
    W_MOM_MACD:       0.14,
    W_MOM_BREAKOUT:   0.14,
    W_MOM_PATTERN:    0.06,
    // Mean-reversion weights
    W_MR_BB:          0.20,
    W_MR_RSI:         0.18,
    W_MR_STOCH:       0.16,
    W_MR_PATTERN:     0.06,
    BASE_WIN_PROB:    0.52,     // prior P(win) before sub-confidence additions
    // ── Trading Sessions (synthetics trade 24/7) ─────────────
    USE_TRADING_SESSIONS:       false,  // 24/7 for synthetics
    SESSIONS: [
        { name: 'LONDON_OPEN', start: 2,  end: 17 },
        { name: 'NY_OPEN',     start: 12, end: 22 },
    ],
    // ── Position Management ───────────────────────────────────
    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    MAX_TOTAL_POSITIONS:          6,     // tighter diversification control
    // ── Active Index Assets ───────────────────────────────────
    ACTIVE_ASSETS: [
        'stpRNG', 'stpRNG2', 'stpRNG3', 'stpRNG4', 'stpRNG5',
        'R_10', 'R_25', 'R_75', 'R_50', 'R_100',
        '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V',
    ],
    // ── Misc ──────────────────────────────────────────────────
    DEBUG_MODE:                 true,
    TELEGRAM_ENABLED:           true,
    TELEGRAM_BOT_TOKEN: '8565754902:AAHS6UQWEgLJ0DO-JTpAGQhZLs-UDVVNAQc',
    TELEGRAM_CHAT_ID: '752497117',
};
// ============================================================
// TECHNICAL INDICATOR ENGINE  (extended for DARE)
// ============================================================
class Indicators {
    static ema(values, period) {
        if (!values || values.length < period) return null;
        const k = 2 / (period + 1);
        let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
        return ema;
    }
    static emaArray(values, period) {
        if (!values || values.length < period) return [];
        const k = 2 / (period + 1);
        const result = [];
        let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
        result.push(ema);
        for (let i = period; i < values.length; i++) {
            ema = values[i] * k + ema * (1 - k);
            result.push(ema);
        }
        return result;
    }
    static sma(values, period) {
        if (!values || values.length < period) return null;
        return values.slice(-period).reduce((a, b) => a + b, 0) / period;
    }
    static rsiSmoothed(closes, period = 14) {
        if (!closes || closes.length < period * 2) return null;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) gains += diff; else losses += Math.abs(diff);
        }
        let avgGain = gains / period;
        let avgLoss = losses / period;
        for (let i = period + 1; i < closes.length; i++) {
            const diff = closes[i] - closes[i - 1];
            avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
            avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
        }
        if (avgLoss === 0) return 100;
        return 100 - (100 / (1 + avgGain / avgLoss));
    }
    static bollingerBands(closes, period = 20, stdDev = 2) {
        if (!closes || closes.length < period) return null;
        const slice = closes.slice(-period);
        const mid = slice.reduce((a, b) => a + b, 0) / period;
        const variance = slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period;
        const std = Math.sqrt(variance);
        return { upper: mid + stdDev * std, middle: mid, lower: mid - stdDev * std, width: stdDev * 2 * std / mid, std };
    }
    static macd(closes, fastP = 12, slowP = 26, sigP = 9) {
        if (!closes || closes.length < slowP + sigP) return null;
        const fastEMA = this.emaArray(closes, fastP);
        const slowEMA = this.emaArray(closes, slowP);
        const offset = slowP - fastP;
        const macdLine = slowEMA.map((slow, i) => fastEMA[i + offset] - slow);
        if (macdLine.length < sigP) return null;
        const signalLine = this.emaArray(macdLine, sigP);
        const last = macdLine.length - 1;
        const lastSig = signalLine.length - 1;
        const lastMacd = macdLine[last];
        const lastSignal = signalLine[lastSig];
        const prevMacd = macdLine[last - 1] ?? lastMacd;
        const prevSignal = signalLine[lastSig - 1] ?? lastSignal;
        return {
            macd: lastMacd, signal: lastSignal,
            histogram: lastMacd - lastSignal,
            prevHistogram: prevMacd - prevSignal,
            bullishCross: prevMacd <= prevSignal && lastMacd > lastSignal,
            bearishCross: prevMacd >= prevSignal && lastMacd < lastSignal,
        };
    }
    static atr(candles, period = 14) {
        if (!candles || candles.length < period + 1) return null;
        const slice = candles.slice(-(period + 1));
        const trs = [];
        for (let i = 1; i < slice.length; i++) {
            const { high, low } = slice[i];
            const prevClose = slice[i - 1].close;
            trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
        }
        return trs.reduce((a, b) => a + b, 0) / trs.length;
    }
    // Rolling ATR series — needed for self-normalized percentile ranking.
    static atrSeries(candles, period = 14, lookback = 120) {
        if (!candles || candles.length < period + 1 + lookback) return [];
        const out = [];
        for (let end = candles.length - lookback; end <= candles.length; end++) {
            const v = this.atr(candles.slice(0, end), period);
            if (v !== null && isFinite(v)) out.push(v);
        }
        return out;
    }
    static supertrend(candles, period = 10, multiplier = 3.0) {
        if (!candles || candles.length < period + 5) return null;
        const slice = candles.slice(-(period + 40 > candles.length ? candles.length : period + 40));
        let stUp = 0, stDown = 0, trend = 'UP', prevTrend = 'UP', prevStUp = 0, prevStDown = 0;
        for (let i = period; i < slice.length; i++) {
            const window = slice.slice(i - period, i + 1);
            const atrVal = this.atr(window, period) ?? 0;
            const hl2 = (slice[i].high + slice[i].low) / 2;
            const rawUp = hl2 - multiplier * atrVal;
            const rawDown = hl2 + multiplier * atrVal;
            stUp = (rawUp > prevStUp || slice[i - 1]?.close < prevStUp) ? rawUp : prevStUp;
            stDown = (rawDown < prevStDown || slice[i - 1]?.close > prevStDown) ? rawDown : prevStDown;
            prevTrend = trend;
            if (slice[i].close > prevStDown) trend = 'UP';
            if (slice[i].close < prevStUp) trend = 'DOWN';
            prevStUp = stUp; prevStDown = stDown;
        }
        const line = trend === 'UP' ? stUp : stDown;
        const flipped = trend !== prevTrend;
        return { trend, line, flipped };
    }
    static adx(candles, period = 14) {
        if (!candles || candles.length < period * 2 + 1) return null;
        const slice = candles.slice(-(period * 2 + 1));
        let smoothTR = 0, smoothPDM = 0, smoothMDM = 0;
        for (let i = 1; i <= period; i++) {
            const high = slice[i].high, low = slice[i].low, prevClose = slice[i-1].close;
            const prevHigh = slice[i-1].high, prevLow = slice[i-1].low;
            const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            const pdm = Math.max(high - prevHigh, 0);
            const mdm = Math.max(prevLow - low, 0);
            smoothTR += tr;
            smoothPDM += (pdm > mdm ? pdm : 0);
            smoothMDM += (mdm > pdm ? mdm : 0);
        }
        let adxSum = 0, adx14 = 0;
        for (let i = period + 1; i < slice.length; i++) {
            const high = slice[i].high, low = slice[i].low, prevClose = slice[i-1].close;
            const prevHigh = slice[i-1].high, prevLow = slice[i-1].low;
            const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            const pdm = Math.max(high - prevHigh, 0);
            const mdm = Math.max(prevLow - low, 0);
            smoothTR = smoothTR - smoothTR / period + tr;
            smoothPDM = smoothPDM - smoothPDM / period + (pdm > mdm ? pdm : 0);
            smoothMDM = smoothMDM - smoothMDM / period + (mdm > pdm ? mdm : 0);
            const plusDI = smoothTR ? (smoothPDM / smoothTR) * 100 : 0;
            const minusDI = smoothTR ? (smoothMDM / smoothTR) * 100 : 0;
            const diDiff = Math.abs(plusDI - minusDI);
            const diSum = plusDI + minusDI;
            const dx = diSum ? (diDiff / diSum) * 100 : 0;
            const idx = i - period;
            if (idx < period) { adxSum += dx; if (idx === period - 1) adx14 = adxSum / period; }
            else { adx14 = (adx14 * (period - 1) + dx) / period; }
        }
        const last = slice.length - 1;
        const high = slice[last].high, low = slice[last].low;
        const prevClose = slice[last-1].close;
        const prevHigh = slice[last-1].high, prevLow = slice[last-1].low;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        const pdm = Math.max(high - prevHigh, 0);
        const mdm = Math.max(prevLow - low, 0);
        smoothTR = smoothTR - smoothTR / period + tr;
        smoothPDM = smoothPDM - smoothPDM / period + (pdm > mdm ? pdm : 0);
        smoothMDM = smoothMDM - smoothMDM / period + (mdm > pdm ? mdm : 0);
        const plusDI = smoothTR ? (smoothPDM / smoothTR) * 100 : 0;
        const minusDI = smoothTR ? (smoothMDM / smoothTR) * 100 : 0;
        return { adx: adx14, plusDI, minusDI };
    }
    static stochastic(candles, kPeriod = 5, dPeriod = 3, smooth = 3) {
        if (!candles || candles.length < kPeriod + dPeriod + smooth) return null;
        const rawK = [];
        for (let i = kPeriod - 1; i < candles.length; i++) {
            const window = candles.slice(i - kPeriod + 1, i + 1);
            const highest = Math.max(...window.map(c => c.high));
            const lowest = Math.min(...window.map(c => c.low));
            rawK.push(lowest === highest ? 50 : ((candles[i].close - lowest) / (highest - lowest)) * 100);
        }
        const smoothedK = [];
        for (let i = smooth - 1; i < rawK.length; i++) {
            smoothedK.push(rawK.slice(i - smooth + 1, i + 1).reduce((a, b) => a + b, 0) / smooth);
        }
        const dValues = [];
        for (let i = dPeriod - 1; i < smoothedK.length; i++) {
            dValues.push(smoothedK.slice(i - dPeriod + 1, i + 1).reduce((a, b) => a + b, 0) / dPeriod);
        }
        const kLast = smoothedK[smoothedK.length - 1];
        const kPrev = smoothedK[smoothedK.length - 2] ?? kLast;
        const dLast = dValues[dValues.length - 1];
        return {
            k: kLast, d: dLast, prevK: kPrev,
            overbought: kLast > 80, oversold: kLast < 20,
            bullishCross: kPrev < dLast && kLast > dLast,
            bearishCross: kPrev > dLast && kLast < dLast,
        };
    }
    static donchian(candles, period = 20) {
        if (!candles || candles.length < period + 1) return null;
        const window = candles.slice(-period - 1, -1);
        const high = Math.max(...window.map(c => c.high));
        const low = Math.min(...window.map(c => c.low));
        const close = candles[candles.length - 1].close;
        return {
            upper: high, lower: low, mid: (high + low) / 2,
            bullBreakout: close > high, bearBreakout: close < low,
        };
    }
    // ── Candle Pattern Recognition [RETAINED + slight bias set] ──
    static detectPattern(candles) {
        if (!candles || candles.length < 3) return { pattern: 'NONE', bias: 'NEUTRAL' };
        const [c2, c1, c0] = candles.slice(-3);
        const body0 = Math.abs(c0.close - c0.open);
        const range0 = c0.high - c0.low || 0.0001;
        const body1 = Math.abs(c1.close - c1.open);
        const body2 = Math.abs(c2.close - c2.open);
        if (range0 > 0 && body0 / range0 < 0.1) return { pattern: 'DOJI', bias: 'NEUTRAL' };
        if (c1.close < c1.open && c0.close > c0.open && c0.open < c1.close && c0.close > c1.open)
            return { pattern: 'BULLISH_ENGULFING', bias: 'BULLISH' };
        if (c1.close > c1.open && c0.close < c0.open && c0.open > c1.close && c0.close < c1.open)
            return { pattern: 'BEARISH_ENGULFING', bias: 'BEARISH' };
        const lowerWick = Math.min(c0.open, c0.close) - c0.low;
        const upperWick = c0.high - Math.max(c0.open, c0.close);
        if (body0 > 0 && lowerWick > body0 * 2 && upperWick < body0 * 0.5)
            return { pattern: 'HAMMER', bias: 'BULLISH' };
        if (body0 > 0 && upperWick > body0 * 2 && lowerWick < body0 * 0.5)
            return { pattern: 'SHOOTING_STAR', bias: 'BEARISH' };
        if (c2.close > c2.open && c1.close > c1.open && c0.close > c0.open &&
            c1.open > c2.open && c0.open > c1.open && c1.close > c2.close && c0.close > c1.close)
            return { pattern: 'THREE_WHITE_SOLDIERS', bias: 'BULLISH' };
        if (c2.close < c2.open && c1.close < c1.open && c0.close < c0.open &&
            c1.open < c2.open && c0.open < c1.open && c1.close < c2.close && c0.close < c1.close)
            return { pattern: 'THREE_BLACK_CROWS', bias: 'BEARISH' };
        if (c2.close < c2.open && body1 < body2 * 0.3 && c0.close > c0.open && c0.close > (c2.open + c2.close) / 2)
            return { pattern: 'MORNING_STAR', bias: 'BULLISH' };
        if (c2.close > c2.open && body1 < body2 * 0.3 && c0.close < c0.open && c0.close < (c2.open + c2.close) / 2)
            return { pattern: 'EVENING_STAR', bias: 'BEARISH' };
        if (c0.close > c0.open && body0 / range0 > 0.7) return { pattern: 'STRONG_BULLISH', bias: 'BULLISH' };
        if (c0.close < c0.open && body0 / range0 > 0.7) return { pattern: 'STRONG_BEARISH', bias: 'BEARISH' };
        return {
            pattern: c0.close > c0.open ? 'BULLISH_CANDLE' : 'BEARISH_CANDLE',
            bias:    c0.close > c0.open ? 'BULLISH' : 'BEARISH',
        };
    }
    // ── Bollinger %B (position within bands, 0..1) ──────────────
    static bollingerPctB(closes, period = 20, stdDev = 2) {
        const bb = this.bollingerBands(closes, period, stdDev);
        if (!bb) return null;
        const last = closes[closes.length - 1];
        const span = bb.upper - bb.lower || 1e-9;
        return { pctB: (last - bb.lower) / span, bb };
    }
    // ── Returns (log) — DARE Layer 0 ──────────────────────────
    static logReturns(closes) {
        const out = [];
        for (let i = 1; i < closes.length; i++) {
            if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
        }
        return out;
    }
    // ════════════════════════════════════════════════════════════
    // VARIANCE RATIO (Lo-MacKinlay, 1988) — DARE Layer 1 backbone.
    // VR(q) = Var(q-period return)/q  ÷  Var(1-period return).
    //   VR > 1  → auto-correlated, trending (momentum regime)
    //   VR < 1  → mean-reverting (fading regime)
    //   VR ≈ 1  → random walk (no edge → STAND ASIDE)
    // Includes asymptotic z-score for significance.
    // ════════════════════════════════════════════════════════════
    static varianceRatio(closes, q = 4) {
        const minLen = (q + 1) * 8; // decent statistical sample
        if (!closes || closes.length < minLen) return null;
        const r = closes.map((c, i) => i === 0 ? null : Math.log(c / closes[i - 1])).filter(x => x !== null);
        const n = r.length;
        if (n < q * 4) return null;
        const mean = r.reduce((a, b) => a + b, 0) / n;
        // 1-period variance
        let s1 = 0;
        for (let i = 0; i < n; i++) s1 += (r[i] - mean) ** 2;
        const var1 = s1 / (n - 1);
        // q-period variance (overlapping)
        let sq = 0;
        const m = n - q;
        for (let t = q; t < n; t++) {
            let seg = 0;
            for (let k = 0; k < q; k++) seg += r[t - k];
            sq += (seg - q * mean) ** 2;
        }
        const varq = sq / (m * q);
        if (var1 <= 0) return null;
        const vr = varq / var1;
        // Heteroskedasticity-consistent z-statistic (Lo-MacKinlay)
        const theta = 0;
        let thetaSum = 0;
        for (let j = 1; j < q; j++) {
            const denom = (n - j) * var1 * var1;
            if (denom === 0) continue;
            let sum = 0;
            for (let t = j; t < n; t++) {
                sum += (r[t] - mean) ** 2 * (r[t - j] - mean) ** 2;
            }
            thetaSum += ((q - j) / q) * (sum / denom);
        }
        const phi = Math.sqrt(Math.max(1e-9, thetaSum * (4 * q / (q + 1)) / (n - 1)));
        const z = phi > 0 ? (vr - 1) / phi : 0;
        return { vr, z, absZ: Math.abs(z), n };
    }
    // ── Percentile rank of a value within a series ─────────────
    static percentileRank(series, value) {
        if (!series || !series.length) return 50;
        let below = 0;
        for (const v of series) if (v <= value) below++;
        return (below / series.length) * 100;
    }
}
// ============================================================
// REGIME CLASSIFIER — DARE Layer 1
// ============================================================
class RegimeClassifier {
    /**
     * Returns a rich regime descriptor:
     * {
     *   ok:          boolean,   // may the engine even attempt a trade?
     *   persistence: 'TREND' | 'MEAN_REVERT' | 'RANDOM' | 'UNKNOWN',
     *   volClass:    'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME' | 'DEAD',
     *   vr, z, atrPct, bbWidth, squeeze, extremeVol,
     *   reasons:     string[],  // human-readable gates
     * }
     */
    static classify(candles) {
        const out = {
            ok: true, persistence: 'UNKNOWN', volClass: 'NORMAL',
            vr: null, z: 0, atrPct: 50, bbWidth: null, squeeze: false, extremeVol: false,
            reasons: [],
        };
        if (!candles || candles.length < CONFIG.MIN_CANDLES_REQUIRED) {
            out.ok = false;
            out.reasons.push(`insufficient candles (${candles?.length ?? 0})`);
            return out;
        }
        const closes = candles.map(c => c.close);
        // ── Variance-Ratio persistence ─────────────────────────
        const vr = Indicators.varianceRatio(closes, CONFIG.VR_Q);
        out.vr = vr?.vr ?? null;
        out.z  = vr?.z  ?? 0;
        if (!vr) {
            out.ok = false;
            out.persistence = 'UNKNOWN';
            out.reasons.push('VR sample too small');
        } else if (vr.vr >= CONFIG.VR_TREND_BAND && vr.absZ >= 1.0) {
            out.persistence = 'TREND';
        } else if (vr.vr <= CONFIG.VR_REVERT_BAND && vr.absZ >= 1.0) {
            out.persistence = 'MEAN_REVERT';
        } else {
            // Random walk (or weak signal) — DARE's biggest rule: STAND ASIDE.
            out.persistence = 'RANDOM';
            out.ok = false;
            out.reasons.push(`VR random-walk (vr=${vr.vr.toFixed(3)} z=${vr.z.toFixed(2)})`);
        }
        // ── Adaptive ATR percentile regime ─────────────────────
        const atrSeries = Indicators.atrSeries(candles, CONFIG.ATR_PERIOD, CONFIG.ATR_PCT_LOOKBACK);
        const atrNow    = Indicators.atr(candles, CONFIG.ATR_PERIOD);
        if (atrSeries.length >= 20 && atrNow !== null) {
            out.atrPct = Indicators.percentileRank(atrSeries, atrNow);
            if (out.atrPct >= CONFIG.ATR_PCT_EXTREME_HIGH) {
                out.volClass = 'EXTREME';
                out.extremeVol = true;
                out.ok = false;
                out.reasons.push(`ATR extreme (${out.atrPct.toFixed(0)}pctl)`);
            } else if (out.atrPct <= CONFIG.ATR_PCT_EXTREME_LOW) {
                out.volClass = 'DEAD';
                out.ok = false;
                out.reasons.push(`ATR dead (${out.atrPct.toFixed(0)}pctl)`);
            } else if (out.atrPct >= 70) {
                out.volClass = 'HIGH';
            } else if (out.atrPct <= 20) {
                out.volClass = 'LOW';
            } else {
                out.volClass = 'NORMAL';
            }
        }
        // ── Bollinger squeeze guard ────────────────────────────
        const bb = Indicators.bollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_STD_DEV);
        if (bb) {
            out.bbWidth = bb.width;
            if (bb.width < CONFIG.BB_SQUEEZE_THRESHOLD) {
                out.squeeze = true;
                out.ok = false;
                out.reasons.push(`BB squeeze (w=${bb.width.toFixed(4)})`);
            }
        }
        return out;
    }
}
// ============================================================
// DARE SIGNAL ANALYZER — Layers 2 & 3 (router + conviction)
// ============================================================
class DAREAnalyzer {
    /**
     * analyze(candles, symbol) → {
     *   direction, shouldTrade, pWin, conviction, evNetOdds,
     *   regime, method, reason, warnings, indicators, components
     * }
     */
    static analyze(candles, symbol) {
        const result = {
            direction:   null,
            shouldTrade: false,
            pWin:        CONFIG.BASE_WIN_PROB,
            conviction:  0,
            evNetOdds:   null,
            regime:      null,
            method:      'NONE',
            reason:      '',
            warnings:    [],
            indicators:  {},
            components:  [],
        };
        // ── LAYER 1: Regime ────────────────────────────────────
        const regime = RegimeClassifier.classify(candles);
        result.regime = regime;
        const closes     = candles.map(c => c.close);
        const lastClose  = closes[closes.length - 1];
        const atrVal  = Indicators.atr(candles, CONFIG.ATR_PERIOD);
        const adxData = Indicators.adx(candles, CONFIG.ADX_PERIOD || 14);
        const bb      = Indicators.bollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_STD_DEV);
        const st      = Indicators.supertrend(candles, CONFIG.SUPERTREND_ATR_PERIOD, CONFIG.SUPERTREND_MULTIPLIER);
        const emaFast = Indicators.ema(closes, CONFIG.EMA_FAST);
        const emaSlow = Indicators.ema(closes, CONFIG.EMA_SLOW);
        const emaTrend= Indicators.ema(closes, CONFIG.EMA_TREND);
        const emaFastArr = Indicators.emaArray(closes, CONFIG.EMA_FAST);
        const donchian   = Indicators.donchian(closes, CONFIG.DONCHIAN_PERIOD);
        const rsi        = Indicators.rsiSmoothed(closes, CONFIG.RSI_PERIOD);
        const macd       = Indicators.macd(closes, CONFIG.MACD_FAST, CONFIG.MACD_SLOW, CONFIG.MACD_SIGNAL);
        const stoch      = Indicators.stochastic(candles, CONFIG.STOCH_K, CONFIG.STOCH_D, CONFIG.STOCH_SMOOTH);
        const pattern    = Indicators.detectPattern(candles);
        const bbPctB     = Indicators.bollingerPctB(closes, CONFIG.BB_PERIOD, CONFIG.BB_STD_DEV);
        const emaFastSlope = emaFastArr.length >= 3
            ? emaFastArr[emaFastArr.length - 1] - emaFastArr[emaFastArr.length - 3]
            : 0;
        result.indicators = {
            vr:          regime.vr?.toFixed(3),
            vrZ:         regime.z?.toFixed(2),
            atr:         atrVal?.toFixed(5),
            atrPct:      regime.atrPct?.toFixed(0),
            volClass:    regime.volClass,
            persistence: regime.persistence,
            bbWidth:     bb?.width?.toFixed(4),
            bbPctB:      bbPctB?.pctB?.toFixed(3),
            adx:         adxData?.adx?.toFixed(1),
            plusDI:      adxData?.plusDI?.toFixed(1),
            minusDI:     adxData?.minusDI?.toFixed(1),
            rsi:         rsi?.toFixed(2),
            stTrend:     st?.trend,
            emaFast:     emaFast?.toFixed(5),
            emaSlow:     emaSlow?.toFixed(5),
            emaTrend:    emaTrend?.toFixed(5),
            macdHist:    macd?.histogram?.toFixed(5),
            stochK:      stoch?.k?.toFixed(2),
            stochD:      stoch?.d?.toFixed(2),
            donchHigh:   donchian?.upper?.toFixed(5),
            donchLow:    donchian?.lower?.toFixed(5),
            pattern:     pattern.pattern,
            lastClose:   lastClose?.toFixed(5),
        };
        // Hard regime gate
        if (!regime.ok) {
            result.reason = `L1 BLOCK: ${regime.reasons.join('; ') || 'regime not tradeable'}`;
            return result;
        }
        // ── LAYER 2/3: Route by persistence ────────────────────
        let dir, pWin;
        if (regime.persistence === 'TREND') {
            const m = this._momentumEngine({ emaFast, emaSlow, emaTrend, emaFastSlope, st, macd, donchian, pattern, adxData });
            result.method = 'MOMENTUM';
            result.components = m.components;
            dir  = m.direction;
            pWin = m.pWin;
            result.warnings.push(...m.warnings);
            if (!dir) {
                result.reason = `MOMENTUM: no aligned signal (${m.reason})`;
                return result;
            }
        } else if (regime.persistence === 'MEAN_REVERT') {
            const m = this._meanReversionEngine({ rsi, bbPctB, stoch, pattern, lastClose, bb });
            result.method = 'MEAN_REVERSION';
            result.components = m.components;
            dir  = m.direction;
            pWin = m.pWin;
            result.warnings.push(...m.warnings);
            if (!dir) {
                result.reason = `MEAN_REVERSION: no extreme to fade (${m.reason})`;
                return result;
            }
        } else {
            result.reason = `Unknown persistence — stand aside`;
            return result;
        }
        // ── Probability floor / sanity ─────────────────────────
        if (pWin < CONFIG.MIN_WIN_PROB) {
            result.reason = `L3 BLOCK: calibrated P(win)=${pWin.toFixed(3)} < ${CONFIG.MIN_WIN_PROB}`;
            return result;
        }
        result.direction  = dir;            // 'CALLE' | 'PUTE'
        result.pWin       = pWin;
        result.conviction = Math.max(0, Math.min(1, pWin - 0.5)); // 0..0.5-ish
        result.shouldTrade= true;
        result.reason = `${result.method} ${dir} | VR=${regime.vr?.toFixed(2)} ATRpctl=${regime.atrPct.toFixed(0)} P(win)=${pWin.toFixed(3)}`;
        return result;
    }
    // ──────────────────────────────────────────────────────────
    // MOMENTUM sub-engine — conviction-weighted, returns pWin.
    // ──────────────────────────────────────────────────────────
    static _momentumEngine(ctx) {
        const out = { direction: null, pWin: CONFIG.BASE_WIN_PROB, components: [], reason: '', warnings: [] };
        let bull = 0, bear = 0;
        const W = {
            ema: CONFIG.W_MOM_EMA, st: CONFIG.W_MOM_SUPERTREND,
            macd: CONFIG.W_MOM_MACD, bo: CONFIG.W_MOM_BREAKOUT, pat: CONFIG.W_MOM_PATTERN,
        };
        // EMA stack + slope
        if (ctx.emaFast && ctx.emaSlow && ctx.emaTrend) {
            const bullStack = ctx.emaFast > ctx.emaSlow && ctx.emaSlow > ctx.emaTrend && ctx.emaFastSlope > 0;
            const bearStack = ctx.emaFast < ctx.emaSlow && ctx.emaSlow < ctx.emaTrend && ctx.emaFastSlope < 0;
            if (bullStack) { out.pWin += W.ema; bull++; out.components.push(`EMA✅bull`); }
            else if (bearStack) { out.pWin += W.ema; bear++; out.components.push(`EMA✅bear`); }
            else out.components.push(`EMA✗`);
        }
        // Supertrend
        if (ctx.st) {
            if (ctx.st.trend === 'UP')   { out.pWin += W.st; bull++; out.components.push(`ST✅up${ctx.st.flipped ? '*flip' : ''}`); }
            else                         { out.pWin += W.st; bear++; out.components.push(`ST✅dn${ctx.st.flipped ? '*flip' : ''}`); }
        }
        // MACD acceleration
        if (ctx.macd) {
            const histRising  = ctx.macd.histogram > 0 && ctx.macd.histogram > ctx.macd.prevHistogram;
            const histFalling = ctx.macd.histogram < 0 && ctx.macd.histogram < ctx.macd.prevHistogram;
            if (ctx.macd.bullishCross || histRising)        { out.pWin += W.macd; bull++; out.components.push(`MACD✅${ctx.macd.bullishCross ? 'x' : '↑'}`); }
            else if (ctx.macd.bearishCross || histFalling)  { out.pWin += W.macd; bear++; out.components.push(`MACD✅${ctx.macd.bearishCross ? 'x' : '↓'}`); }
            else out.components.push(`MACD✗`);
        }
        // Donchian breakout
        if (ctx.donchian) {
            if (ctx.donchian.bullBreakout)      { out.pWin += W.bo; bull++; out.components.push(`DON✅BO↑`); }
            else if (ctx.donchian.bearBreakout) { out.pWin += W.bo; bear++; out.components.push(`DON✅BO↓`); }
            else out.components.push(`DON✗`);
        }
        // Pattern bias
        if (ctx.pattern?.bias === 'BULLISH')      { out.pWin += W.pat; bull++; out.components.push(`PAT✅${ctx.pattern.pattern}`); }
        else if (ctx.pattern?.bias === 'BEARISH') { out.pWin += W.pat; bear++; out.components.push(`PAT✅${ctx.pattern.pattern}`); }
        // ADX directional agreement (bonus, not penalizing if absent)
        if (ctx.adxData && ctx.adxData.adx >= 20) {
            const agree = bull > bear ? ctx.adxData.plusDI > ctx.adxData.minusDI : ctx.adxData.minusDI > ctx.adxData.plusDI;
            if (agree) out.pWin += 0.04;
            else out.warnings.push('ADX_DI_DISAGREE');
        }
        // Require majority alignment with no strong conflict
        const total = bull + bear;
        if (total < 3) { out.reason = `only ${total} signals`; return out; }
        if (bull > bear && bear === 0)      out.direction = 'CALLE';
        else if (bear > bull && bull === 0) out.direction = 'PUTE';
        else { out.direction = null; out.reason = `conflict bull:${bull} bear:${bear}`; }
        return out;
    }
    // ──────────────────────────────────────────────────────────
    // MEAN-REVERSION sub-engine — fade verified extremes.
    // ──────────────────────────────────────────────────────────
    static _meanReversionEngine(ctx) {
        const out = { direction: null, pWin: CONFIG.BASE_WIN_PROB, components: [], reason: '', warnings: [] };
        let up = 0, dn = 0; // "up" = bet price reverts UP (buy oversold), "dn" = bet reverts DOWN (fade overbought)
        const W = { bb: CONFIG.W_MR_BB, rsi: CONFIG.W_MR_RSI, stoch: CONFIG.W_MR_STOCH, pat: CONFIG.W_MR_PATTERN };
        // Bollinger %B extreme
        if (ctx.bbPctB) {
            if (ctx.bbPctB.pctB >= CONFIG.MR_BB_PCTB_EXTREME_HIGH) { out.pWin += W.bb; dn++; out.components.push(`BB✅OB %B=${ctx.bbPctB.pctB.toFixed(2)}`); }
            else if (ctx.bbPctB.pctB <= CONFIG.MR_BB_PCTB_EXTREME_LOW) { out.pWin += W.bb; up++; out.components.push(`BB✅OS %B=${ctx.bbPctB.pctB.toFixed(2)}`); }
            else out.components.push(`BB✗ %B=${ctx.bbPctB.pctB?.toFixed(2)}`);
        }
        // RSI extreme
        if (ctx.rsi !== null) {
            if (ctx.rsi >= CONFIG.MR_RSI_OB) { out.pWin += W.rsi; dn++; out.components.push(`RSI✅OB(${ctx.rsi.toFixed(0)})`); }
            else if (ctx.rsi <= CONFIG.MR_RSI_OS) { out.pWin += W.rsi; up++; out.components.push(`RSI✅OS(${ctx.rsi.toFixed(0)})`); }
            else out.components.push(`RSI✗(${ctx.rsi.toFixed(0)})`);
        }
        // Stochastic reversal cross in extreme zone
        if (ctx.stoch) {
            if (ctx.stoch.oversold && ctx.stoch.bullishCross)       { out.pWin += W.stoch; up++; out.components.push(`STO✅OS-rev`); }
            else if (ctx.stoch.overbought && ctx.stoch.bearishCross){ out.pWin += W.stoch; dn++; out.components.push(`STO✅OB-rev`); }
            else out.components.push(`STO✗ K=${ctx.stoch.k.toFixed(0)}`);
        }
        // Reversal-candle confirmation (hammer at low, shooting star at high)
        if (ctx.pattern?.pattern === 'HAMMER')         { out.pWin += W.pat; up++; out.components.push(`PAT✅HAMMER`); }
        else if (ctx.pattern?.pattern === 'SHOOTING_STAR'){ out.pWin += W.pat; dn++; out.components.push(`PAT✅SHOOT`); }
        else if (ctx.pattern?.pattern === 'BULLISH_ENGULFING')  { out.pWin += W.pat; up++; out.components.push(`PAT✅B-ENG`); }
        else if (ctx.pattern?.pattern === 'BEARISH_ENGULFING')  { out.pWin += W.pat; dn++; out.components.push(`PAT✅S-ENG`); }
        const total = up + dn;
        if (total < 2) { out.reason = `only ${total} extremes`; return out; }
        if (up > dn && dn === 0)     out.direction = 'CALLE';
        else if (dn > up && up === 0)out.direction = 'PUTE';
        else { out.direction = null; out.reason = `mixed extremes up:${up} dn:${dn}`; }
        return out;
    }
}
// ============================================================
// STAKE CALCULATOR — Kelly-fractional + single capped recoup
// ============================================================
class StakeCalculator {
    /**
     * Calculate trade stake.
     *  • recoveryStep === 0  → Kelly-fractional on conviction: k = f·(p·b − (1−p))/b
     *    (Here we approximate b≈0.9 — typical Deriv Rise/Fall net odds.)
     *  • recoveryStep === 1  → single capped recoup (×1.3, hard cap MAX_RECOVERY_STAKE_PCT)
     *  • Never escalates beyond 1 step.
     */
    static calculate(capital, recoveryStep = 0, pWin = null) {
        const b = 0.90; // conservative assumed net odds (overwritten at EV-gate if enabled)
        const p = pWin && pWin > 0.5 ? pWin : 0.54;
        let stake;
        if (!CONFIG.RECOVERY_ENABLED || recoveryStep <= 0) {
            // Kelly fraction (half-Kelly, floored) on conviction
            const kelly = b > 0 ? (p * b - (1 - p)) / b : 0;
            const frac  = Math.max(0, Math.min(0.5, kelly * 0.5)); // half-Kelly, capped
            const riskCapital = capital * (CONFIG.BASE_RISK_PERCENT_PER_TRADE / 100);
            stake = riskCapital * (0.5 + frac); // scale within base risk envelope
        } else if (recoveryStep === 1) {
            const riskCapital = capital * (CONFIG.BASE_RISK_PERCENT_PER_TRADE / 100);
            stake = riskCapital * CONFIG.RECOVERY_MULTIPLIER;
        } else {
            // Hard rule: never more than 1 recovery step.
            const riskCapital = capital * (CONFIG.BASE_RISK_PERCENT_PER_TRADE / 100);
            stake = riskCapital;
        }
        // Hard caps
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
// TRADING SESSION MANAGER  [RETAINED + corrected for synthetics]
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
        if (!CONFIG.USE_TRADING_SESSIONS) return `🟢 SYNTHETIC 24/7 MODE (${time})`;
        if (!info.inSession) return `🔴 OUTSIDE SESSIONS (${time})`;
        return `🟢 ${info.activeSessions.join('+')} (${time})${info.inOverlap ? ' 🔥 OVERLAP' : ''}`;
    }
}
// ============================================================
// TRADE HISTORY MANAGER  [RETAINED + getDayStats]
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
// STATE PERSISTENCE  [RETAINED + raised age threshold]
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
                    recoveryStep:                a.recoveryStep,
                    currentStake:                a.currentStake,
                    consecutiveWins:             a.consecutiveWins,
                    consecutiveLosses:           a.consecutiveLosses,
                    cooldownCandles:             a.cooldownCandles,
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
            LOGGER.info(`📁 Restoring state from ${ageMins.toFixed(1)} minutes ago`);
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
                        a.recoveryStep                = saved.recoveryStep        || 0;
                        a.currentStake                = saved.currentStake        || StakeCalculator.calculate(state.capital);
                        a.consecutiveWins             = saved.consecutiveWins     || 0;
                        a.consecutiveLosses           = saved.consecutiveLosses   || 0;
                        a.cooldownCandles             = saved.cooldownCandles      || 0;
                        a.tradesCount = saved.tradesCount || 0;
                        a.winsCount   = saved.winsCount   || 0;
                        a.lossesCount = saved.lossesCount || 0;
                        a.netPL       = saved.netPL       || 0;
                        a.profit      = saved.profit      || 0;
                        a.loss        = saved.loss        || 0;
                        a.activePositions = (saved.activePositions || []).map(p => ({ ...p }));
                        LOGGER.info(`📊 ${symbol}: Recovery=${a.recoveryStep}, Stake=$${(a.currentStake || 0).toFixed(2)}, P/L=$${(a.netPL || 0).toFixed(2)}, CooldownCandles:${a.cooldownCandles}`);
                    }
                });
            }
            LOGGER.info(`✅ State restored | Capital: $${state.capital.toFixed(2)}`);
            return true;
        } catch (e) { LOGGER.error(`Load state error: ${e.message}`); return false; }
    }
    static startAutoSave() {
        setInterval(() => { if (state.isAuthorized) this.saveState(); }, STATE_SAVE_INTERVAL);
        LOGGER.info(`💾 Auto-save every ${STATE_SAVE_INTERVAL / 1000}s`);
    }
}
// ============================================================
// TELEGRAM SERVICE  [RETAINED, adapted for DARE display]
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
        const emoji   = type === 'OPEN' ? '🚀' : type === 'WIN' ? '✅' : '❌';
        const a       = state.assets[symbol];
        const overall = TradeHistoryManager.getOverallStats();
        const today   = TradeHistoryManager.getTodayStats();
        const ind     = details.indicators || {};
        const lines   = [
            `${emoji} <b>DARE BOT v3 — ${type}</b>`,
            `Pair: <b>${symbol}</b>  Direction: <b>${direction === 'CALLE' ? '📈 CALLE' : '📉 PUTE'}</b>`,
            `Stake: $${stake.toFixed(2)} | Duration: ${duration}${durationUnit.toUpperCase()}`,
            `Recovery Step: ${a?.recoveryStep ?? 0} | ${TradingSessionManager.getStatusString()}`,
            ``,
        ];
        if (type === 'OPEN' && details.signal) {
            const sig = details.signal;
            const reg = sig.regime || {};
            lines.push(`🧠 <b>DARE Analysis:</b>`);
            lines.push(`Regime: ${reg.persistence} / ${reg.volClass} | VR:${ind.vr} (z:${ind.vrZ}) ATRpctl:${ind.atrPct}`);
            lines.push(`Method: ${sig.method} | P(win): ${((sig.pWin ?? 0) * 100).toFixed(1)}%`);
            lines.push(`Components: ${(sig.components || []).join(' ')}`);
            lines.push(`RSI:${ind.rsi} MACD:${ind.macdHist} ST:${ind.stTrend} Stoch:${ind.stochK}/${ind.stochD}`);
            if (sig.warnings?.length) lines.push(`⚠️ Warnings: ${sig.warnings.join(', ')}`);
        }
        if (details.profit !== undefined) {
            const pl = Number(details.profit) || 0;
            lines.push(`Profit: ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}`);
            lines.push(``);
            lines.push(`📋 <b>${symbol} Stats:</b>`);
            lines.push(`W/L: ${a?.winsCount ?? 0}/${a?.lossesCount ?? 0} | P/L: $${(a?.netPL ?? 0).toFixed(2)}`);
            lines.push(``);
            lines.push(`📋 <b>Today:</b>`);
            lines.push(`Trades: ${today.tradesCount} | W/L: ${today.winsCount}/${today.lossesCount} | P/L: $${(today.netPL || 0).toFixed(2)}`);
            lines.push(`Capital: $${state.capital.toFixed(2)}`);
            lines.push(``);
            lines.push(`📋 <b>Overall:</b>`);
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
                assetInfo += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L $${(a.netPL || 0).toFixed(2)} Rec:${a.recoveryStep}`;
            }
        });
        await this.sendMessage([
            `⏰ <b>DARE v3 Hourly</b>`,
            `Last Hour: ${h.trades}t ${h.wins}W/${h.losses}L ${wr}% ${h.pnl >= 0 ? '🟢' : '🔴'} $${h.pnl.toFixed(2)}`,
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
            `📊 <b>DARE v3 SESSION SUMMARY</b>`,
            `Duration: ${stats.duration} | Trades: ${stats.trades}`,
            `W: ${stats.wins} | L: ${stats.losses} | Win Rate: ${stats.winRate}`,
            `Session P/L: $${(stats.netPL || 0).toFixed(2)}`,
            `Today P/L: $${(today.netPL || 0).toFixed(2)}`,
            ``,
            `📋 <b>Overall:</b> ${overall.tradesCount} trades | WR: ${wr}% | P/L: $${(overall.netPL || 0).toFixed(2)}`,
            pairBreakdown ? `\n<b>Per-Asset:</b>${pairBreakdown}` : '',
            ``,
            `💰 Capital: $${state.capital.toFixed(2)}`,
        ].join('\n'));
    }
    static async sendStartupMessage() {
        const overall = TradeHistoryManager.getOverallStats();
        let pairInfo = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            pairInfo += `\n  ${sym}: ${CONFIG.TIMEFRAME_LABEL} | ${CONFIG.DURATION}${CONFIG.DURATION_UNIT}`;
        });
        await this.sendMessage([
            `🤖 <b>DARE BOT v3 STARTED</b>`,
            `Strategy: Directional Adaptive Regime Engine`,
            `L1: VR(Lo-MacKinlay) + ATR-pctile + BB-squeeze | L2: regime-routed momentum/mean-reversion`,
            `L3: conviction-weighted P(win) | L4: EV payout gate + Kelly`,
            `Risk: ${CONFIG.BASE_RISK_PERCENT_PER_TRADE}%/trade (cap ${CONFIG.MAX_RISK_PCT}%) | Min edge: ${CONFIG.MIN_EDGE}`,
            `Recovery: ${CONFIG.RECOVERY_ENABLED ? `single capped step (×${CONFIG.RECOVERY_MULTIPLIER})` : 'Disabled'} — no martingale`,
            `Capital: $${state.capital.toFixed(2)}`,
            TradingSessionManager.getStatusString(),
            ``,
            `📊 Overall: ${overall.tradesCount} trades | P/L: $${(overall.netPL || 0).toFixed(2)}`,
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
// SESSION MANAGER  [RETAINED + daily stop-loss]
// ============================================================
class SessionManager {
    static isSessionActive() { return state.session.isActive; }
    static checkSessionTargets() {
        const netPL = state.session?.netPL || 0;
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
            LOGGER.error(`🛑 Daily stop-loss reached: $${(today?.netPL || 0).toFixed(2)}`);
            this.endSession('DAILY_STOP_LOSS');
            return true;
        }
        return false;
    }
    static async endSession(reason) {
        state.session.isActive = false;
        LOGGER.info(`🛑 Session ended: ${reason}`);
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
            LOGGER.info(`🗓️ Day changed: ${state.currentTradeDay} → ${today}`);
            const dayStats = TradeHistoryManager.getDayStats(state.currentTradeDay);
            TelegramService.sendMessage(
                `🌙 <b>END OF DAY ${state.currentTradeDay}</b>\nP/L: $${(dayStats?.netPL || 0).toFixed(2)}\nCapital: $${state.capital.toFixed(2)}`
            );
            this._resetDailyStats();
            if (!state.session.isActive) {
                state.session.isActive = true;
                LOGGER.info('🔄 Session re-activated for new day');
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
        state.capital          += profit;
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
            a.recoveryStep      = 0;       // win resets recoup
            a.cooldownCandles   = 0;
            a.currentStake      = StakeCalculator.calculate(state.capital);
            a.lastTradeWasWin   = true;
            LOGGER.trade(`✅ [${symbol}] WIN +$${(profit || 0).toFixed(2)} | ${direction} | P/L: $${(a.netPL || 0).toFixed(2)}`);
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
            // Single capped recoup step ONLY (no ladder, no force-trade)
            if (CONFIG.RECOVERY_ENABLED && a.recoveryStep < CONFIG.MAX_RECOVERY_STEPS) {
                a.recoveryStep = 1;
            } else {
                a.recoveryStep = 0; // recoup already used / disabled → reset to base stake
            }
            a.currentStake = StakeCalculator.calculate(state.capital, a.recoveryStep);
            if (a.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
                a.cooldownCandles = CONFIG.COOLDOWN_CANDLES;
                LOGGER.warn(`❄️ [${symbol}] ${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses — cooling down for ${CONFIG.COOLDOWN_CANDLES} candles`);
                TelegramService.sendMessage(
                    `❄️ <b>[${symbol}] COOL-DOWN ACTIVATED</b>\n` +
                    `${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses\n` +
                    `Pausing for ${CONFIG.COOLDOWN_CANDLES} candles\n` +
                    `Capital: $${state.capital.toFixed(2)}`
                );
            }
            LOGGER.trade(`❌ [${symbol}] LOSS -$${Math.abs(profit || 0).toFixed(2)} | ${direction} | Next Stake: $${(a.currentStake || 0).toFixed(2)} (recoup=${a.recoveryStep})`);
        }
        TradeHistoryManager.recordTrade(symbol, profit, a.recoveryStep);
    }
}
// ============================================================
// STATE  [RETAINED structure]
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
    // EV gate: pending proposals awaiting payout quotes { [req_id]: {symbol, direction, signal, stake} }
    pendingProposals:       {},
};
let tradeHistory = null;
// ============================================================
// CONNECTION MANAGER  [RETAINED + trade lock + DARE buy flow]
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
        LOGGER.info('🔌 Connecting to Deriv API...');
        this.cleanup();
        this.isShuttingDown = false;
        if (this._isPat) {
            LOGGER.info('🔑 PAT token detected → using NEW Deriv API (OTP flow)');
            this._newApiConnect().catch(err => {
                LOGGER.error(`New API connect failed: ${err.message}`);
                this.onClose();
            });
        } else {
            LOGGER.info('🔑 Using legacy Deriv API (token authorize flow)');
            this._openWs(`${CONFIG.WS_URL}?app_id=${encodeURIComponent(CONFIG.APP_ID)}`);
        }
    }
    _openWs(url) {
        try {
            this.ws = new WebSocket(url, {
                headers: { 'User-Agent': 'bizIndexRiseFall3/3.0 (+Node.js)' },
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
        LOGGER.info('🌐 REST: GET /trading/v1/options/accounts');
        const accRes = await this._rest.get('/trading/v1/options/accounts');
        if (accRes.status !== 200) {
            const msg = accRes.body?.errors?.[0]?.message || accRes.body?.message || JSON.stringify(accRes.body);
            let hint = '';
            if (accRes.status === 401) hint = ' — check PAT validity and APP_ID registration at https://developers.deriv.com/';
            else if (accRes.status === 403) hint = ' — PAT may lack "trade" scope (regenerate at https://app.deriv.com/account/api-token)';
            else if (accRes.status === 404) hint = ' — accounts endpoint not found; token may be legacy';
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
        LOGGER.info(`👤 Selected account ${acct.account_id} (${acct.account_type}, ${acct.currency}, balance=${acct.balance})`);
        const otpPath = `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`;
        LOGGER.info(`🌐 REST: POST ${otpPath}`);
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
            `🔑 Authorized ${this.accountInfo.loginid} ` +
            `(${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) ` +
            `balance=${this.accountInfo.balance} ${this.accountInfo.currency} via PAT/new-API`
        );
        state.isAuthorized   = true;
        state.accountBalance = this.accountInfo.balance;
        if (state.capital === CONFIG.INITIAL_CAPITAL) state.capital = this.accountInfo.balance;
        this.send({ balance: 1, subscribe: 1 });
        if (this.reconnectAttempts > 0 || this.hasAnyActivePositions()) {
            CONFIG.ACTIVE_ASSETS.forEach(sym => {
                const a = state.assets[sym];
                if (a?.activePositions?.length) {
                    a.activePositions.forEach(pos => {
                        if (pos.contractId) this.send({ proposal_open_contract: 1, contract_id: pos.contractId, subscribe: 1 });
                    });
                }
            });
        }
        bot.start();
    }
    onOpen() {
        LOGGER.info('✅ Connected to Deriv API');
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
                    recoveryStep:                0,
                    currentStake:                StakeCalculator.calculate(CONFIG.INITIAL_CAPITAL),
                    canTrade:                    false,
                    consecutiveWins:             0,
                    consecutiveLosses:           0,
                    cooldownCandles:             0,
                    activePositions:             [],
                    tradesCount: 0, winsCount: 0, lossesCount: 0,
                    profit: 0, loss: 0, netPL: 0,
                };
                LOGGER.info(`📊 Initialized asset: ${symbol}`);
            }
        });
    }
    cleanup() {
        this.stopPing();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
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
            case 'proposal':               this.handleProposal(r);       break;  // DARE EV gate
            case 'proposal_open_contract': this.handleOpenContract(r);   break;
            case 'ping':                                                  break;
            default:                                                      break;
        }
    }
    handleAuthorize(r) {
        if (r.error) { LOGGER.error(`Auth failed: ${r.error.message}`); return; }
        LOGGER.info(`🔑 Authorized: ${r.authorize.loginid} | Balance: ${r.authorize.balance} ${r.authorize.currency}`);
        state.isAuthorized   = true;
        state.accountBalance = r.authorize.balance;
        if (state.capital === CONFIG.INITIAL_CAPITAL) state.capital = r.authorize.balance;
        this.send({ balance: 1, subscribe: 1 });
        if (this.reconnectAttempts > 0 || this.hasAnyActivePositions()) {
            CONFIG.ACTIVE_ASSETS.forEach(sym => {
                const a = state.assets[sym];
                if (a?.activePositions?.length) {
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
    // ── DARE LAYER 4: EV gate ─────────────────────────────────
    // On receiving a live proposal quote, compute net odds + EV.
    // Only fire the buy if EV >= MIN_EDGE.
    handleProposal(r) {
        const reqId = r.echo_req?.req_id;
        const pending = reqId ? state.pendingProposals[reqId] : null;
        if (!pending) return; // stale or not ours
        if (r.error) {
            LOGGER.warn(`Proposal error (${pending.symbol}): ${r.error.message} — skipping trade`);
            delete state.pendingProposals[reqId];
            bot._forceReleaseTradeLock();
            return;
        }
        const ask    = r.proposal.ask_price;
        const payout = r.proposal.payout;
        if (!(ask > 0) || !(payout > 0)) {
            LOGGER.warn(`Proposal malformed (${pending.symbol}) — skipping`);
            delete state.pendingProposals[reqId];
            bot._forceReleaseTradeLock();
            return;
        }
        const netOdds = (payout - ask) / ask;          // b
        const p       = pending.signal.pWin;
        const ev      = p * netOdds - (1 - p);          // EV per $1 risked
        pending.signal.evNetOdds = netOdds;
        pending.signal.ev        = ev;
        LOGGER.signal(
            `[${pending.symbol}] EV-GATE: ask=$${ask} payout=$${payout} netOdds=${netOdds.toFixed(3)} ` +
            `P(win)=${p.toFixed(3)} EV=${(ev * 100).toFixed(2)}%`
        );
        if (CONFIG.ENABLE_EV_GATE && ev < CONFIG.MIN_EDGE) {
            LOGGER.warn(`[${pending.symbol}] EV ${(ev * 100).toFixed(2)}% < min ${CONFIG.MIN_EDGE * 100}% — REJECT (no edge)`);
            delete state.pendingProposals[reqId];
            bot._forceReleaseTradeLock();
            return;
        }
        // ── EV passed → fire buy ──────────────────────────────
        bot._fireBuyFromProposal(pending);
        delete state.pendingProposals[reqId];
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
        LOGGER.trade(`📋 Contract opened: ${contract.contract_id} | Buy Price: $${contract.buy_price}`);
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
                        { signal: pos.signal, indicators: pos.indicators }
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
                    const dir  = closed.close > closed.open ? '🟢' : '🔴';
                    const time = new Date(closed.epoch * 1000).toISOString();
                    LOGGER.info(`${dir} [${symbol}] CANDLE CLOSED [${time}] O:${closed.open.toFixed(5)} H:${closed.high.toFixed(5)} L:${closed.low.toFixed(5)} C:${closed.close.toFixed(5)} | Total: ${a.closedCandles.length}`);
                    if (a.cooldownCandles > 0) {
                        a.cooldownCandles--;
                        LOGGER.info(`❄️ [${symbol}] Cool-down: ${a.cooldownCandles} candles remaining`);
                    }
                    a.canTrade = true;
                    try {
                        bot.executeNextTrade(symbol, closed);
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
        const signal = DAREAnalyzer.analyze(candles, symbol);
        LOGGER.info(
            `📊 [${symbol}] Loaded ${candles.length} ${CONFIG.TIMEFRAME_LABEL} candles | ` +
            `VR:${signal.indicators?.vr} pers:${signal.regime?.persistence} vol:${signal.regime?.volClass} ` +
            `${signal.direction ?? 'NO_TRADE'} | ${signal.reason}`
        );
    }
    onError(err) { LOGGER.error(`WebSocket error: ${err.message}`); }
    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
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
            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})`);
            TelegramService.sendMessage(`⚠️ <b>CONNECTION LOST</b> — Reconnecting (attempt ${this.reconnectAttempts})`);
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (this.isShuttingDown) return;
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached — giving up');
            TelegramService.sendMessage(`🛑 <b>BOT STOPPED</b> — Max reconnections\nFinal P/L: $${(state.session.netPL || 0).toFixed(2)}`);
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
// MAIN BOT CLASS  — v3 DARE
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
        console.log(' DERIV SYNTHETIC INDICES BOT v3 — DARE (Directional Adaptive Regime Engine)');
        console.log('═'.repeat(74));
        console.log(`Assets    : ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        console.log(`Timeframe : ${CONFIG.TIMEFRAME_LABEL} candles | Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT}`);
        console.log(`Strategy  : VR-persistence → {MOMENTUM | MEAN-REVERSION | STAND-ASIDE}`);
        console.log(`Edge      : EV gate (min ${CONFIG.MIN_EDGE*100}%) + half-Kelly | Min P(win) ${CONFIG.MIN_WIN_PROB}`);
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
        LOGGER.info('✅ DARE Bot v3 fully started!');
    }
    subscribeToCandles(symbol) {
        if (this.connection.activeSubscriptions.has(symbol)) {
            LOGGER.debug(`Already subscribed to ${symbol}`);
            return;
        }
        LOGGER.info(`📡 Subscribing to ${symbol} (${CONFIG.TIMEFRAME_LABEL})...`);
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
    // CORE TRADE EXECUTION — DARE 4-layer pipeline.
    //   1. Pre-flight guards (session, positions, cooldown, capital)
    //   2. DARE signal analysis (Layers 1-3)
    //   3. EV gate via live proposal (Layer 4) → only then buy
    // No force-trading. No martingale ladder.
    // ════════════════════════════════════════════════════════
    executeNextTrade(symbol, lastClosedCandle) {
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
                    LOGGER.info(`⏰ ${TradingSessionManager.getStatusString()} — holding new trades`);
                    state.lastSessionLogTime = now;
                }
                a.canTrade = false;
                return;
            }
        }
        const stake = a.currentStake;
        if (state.capital < stake) {
            LOGGER.error(`[${symbol}] Insufficient capital: $${state.capital.toFixed(2)} < stake $${stake.toFixed(2)}`);
            a.recoveryStep = 0;
            a.currentStake = StakeCalculator.calculate(state.capital);
            a.canTrade = false;
            return;
        }
        if (a.closedCandles.length < CONFIG.MIN_CANDLES_REQUIRED) {
            LOGGER.debug(`[${symbol}] Not enough candles yet (${a.closedCandles.length}/${CONFIG.MIN_CANDLES_REQUIRED})`);
            a.canTrade = false;
            return;
        }
        // ── DARE analysis ────────────────────────────────────
        const signal = DAREAnalyzer.analyze(a.closedCandles, symbol);
        LOGGER.signal(
            `[${symbol}] ${signal.regime?.persistence}/${signal.regime?.volClass} ` +
            `VR:${signal.indicators?.vr} ATRpctl:${signal.indicators?.atrPct} ` +
            `${signal.direction ?? 'NO_TRADE'} | ${signal.reason}`
        );
        if (CONFIG.DEBUG_MODE && signal.components?.length) {
            LOGGER.debug(`[${symbol}] components: ${signal.components.join(' ')}`);
        }
        if (!signal.shouldTrade || !signal.direction) {
            a.canTrade = false;
            return;
        }
        // ── Lock and route through EV gate ──────────────────
        this._tradeLocked = true;
        a.canTrade = false;
        a.lastTradeDirection = signal.direction;
        // Recompute stake with calibrated pWin
        const finalStake = StakeCalculator.calculate(state.capital, a.recoveryStep, signal.pWin);
        a.currentStake = finalStake;
        LOGGER.trade(
            `🎯 [${symbol}] ${signal.direction === 'CALLE' ? '📈 CALLE' : '📉 PUTE'} | ` +
            `${signal.method} | P(win)=${signal.pWin.toFixed(3)} | Stake: $${finalStake.toFixed(2)} ` +
            `(recoup ${a.recoveryStep})`
        );
        LOGGER.trade(`   ${signal.reason} | comps: ${(signal.components || []).join(' ')}`);
        const pos = {
            symbol,
            direction:    signal.direction,
            stake:        finalStake,
            duration:     CONFIG.DURATION,
            durationUnit: CONFIG.DURATION_UNIT,
            entryTime:    Date.now(),
            contractId:   null,
            reqId:        null,
            currentProfit: 0,
            buyPrice:     0,
            signal: {
                score:       signal.conviction,
                maxScore:    0.5,
                reason:      signal.reason,
                method:      signal.method,
                pWin:        signal.pWin,
                components:  signal.components,
                regime:      signal.regime,
                warnings:    signal.warnings,
            },
            indicators:   signal.indicators,
        };
        a.activePositions.push(pos);
        // DARE Layer 4: request a live proposal to gate on EV.
        if (CONFIG.ENABLE_EV_GATE) {
            const propReqId = this.connection.send({
                proposal: 1,
                amount:    finalStake.toFixed(2),
                basis:     'stake',
                contract_type: signal.direction,
                currency:  'USD',
                duration:  CONFIG.DURATION,
                duration_unit: CONFIG.DURATION_UNIT,
                [this.connection._isPat ? 'underlying_symbol' : 'symbol']: symbol,
            });
            if (!propReqId) {
                // send failed → release lock
                a.activePositions.pop();
                this._tradeLocked = false;
                return;
            }
            state.pendingProposals[propReqId] = { symbol, direction: signal.direction, signal: pos.signal, stake: finalStake, pos };
            // Safety: if proposal never returns, release lock after 8s
            setTimeout(() => {
                if (state.pendingProposals[propReqId]) {
                    LOGGER.warn(`[${symbol}] Proposal timeout — releasing lock`);
                    delete state.pendingProposals[propReqId];
                    const idx = a.activePositions.indexOf(pos);
                    if (idx >= 0) a.activePositions.splice(idx, 1);
                    this._tradeLocked = false;
                }
            }, 8000);
        } else {
            // EV gate disabled → buy directly
            this._fireBuyFromProposal({ symbol, direction: signal.direction, signal: pos.signal, stake: finalStake, pos });
        }
        StatePersistence.saveState();
    }
    // ── Fire the actual buy once EV (if enabled) has passed ──
    _fireBuyFromProposal(pending) {
        const a = state.assets[pending.symbol];
        if (!a) { this._tradeLocked = false; return; }
        const reqId = this.connection.send({
            buy: 1, subscribe: 1, price: pending.stake.toFixed(2),
            parameters: {
                contract_type: pending.direction,
                [this.connection._isPat ? 'underlying_symbol' : 'symbol']: pending.symbol,
                currency:      'USD',
                amount:        pending.stake.toFixed(2),
                duration:      CONFIG.DURATION,
                duration_unit: CONFIG.DURATION_UNIT,
                basis:         'stake',
            },
        });
        pending.pos.reqId = reqId;
        // Safety: release lock after 5s if buy response hasn't come
        setTimeout(() => {
            if (this._tradeLocked && !pending.pos.contractId) {
                LOGGER.warn(`[${pending.symbol}] Buy response timeout — releasing lock`);
                const idx = a.activePositions.indexOf(pending.pos);
                if (idx >= 0) a.activePositions.splice(idx, 1);
                this._tradeLocked = false;
            }
        }, 5000);
    }
    // ── WATCHDOG [RETAINED] ────────────────────────────────────
    _startTradeWatchdog(contractId) {
        this._clearAllWatchdogTimers();
        state.tradeWatchdogTimer = setTimeout(() => {
            if (!state.currentContractId) return;
            LOGGER.warn(`⏰ WATCHDOG fired for contract ${contractId}`);
            if (state.isConnected && state.isAuthorized) {
                this.connection.send({ forget_all: 'proposal_open_contract' });
                this.connection.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
                state.tradeWatchdogPollTimer = setTimeout(() => {
                    if (!state.currentContractId) return;
                    LOGGER.error(`🚨 WATCHDOG: Poll timeout — forcing recovery`);
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
        LOGGER.warn('⚠️ Trade lock force-released');
    }
    _recoverStuckTrade(reason) {
        LOGGER.warn(`🔄 Stuck trade recovery: ${reason}`);
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
            `⚠️ <b>STUCK TRADE RECOVERED [${reason}]</b>\n` +
            `Contract: ${contractId}\n` +
            `⚠️ VERIFY OUTCOME MANUALLY ON DERIV\n` +
            `Capital: $${state.capital.toFixed(2)}`
        );
        StatePersistence.saveState();
    }
    stop() {
        LOGGER.info('🛑 Stopping bot...');
        CONFIG.ACTIVE_ASSETS.forEach(sym => { if (state.assets[sym]) state.assets[sym].canTrade = false; });
        TelegramService.clearTimers();
        this._clearAllWatchdogTimers();
        if (this.statusDisplayIntervalId) clearInterval(this.statusDisplayIntervalId);
        if (this.sessionTimeCheckerId)    clearInterval(this.sessionTimeCheckerId);
        if (this.contractCleanupInterval) clearInterval(this.contractCleanupInterval);
        StatePersistence.saveState();
        TradeHistoryManager.saveHistory();
        setTimeout(() => { this.connection.cleanup(); LOGGER.info('👋 Bot stopped'); }, 2000);
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
                const signal = a.closedCandles.length >= CONFIG.MIN_CANDLES_REQUIRED
                    ? DAREAnalyzer.analyze(a.closedCandles, sym)
                    : null;
                pairStatuses[sym] = {
                    recoveryStep:    a.recoveryStep,
                    currentStake:    a.currentStake,
                    activePositions: a.activePositions.length,
                    cooldownCandles: a.cooldownCandles,
                    trades: a.tradesCount, wins: a.winsCount, losses: a.lossesCount, netPL: a.netPL,
                    lastDirection: a.lastTradeDirection,
                    signal: signal ? { method: signal.method, direction: signal.direction, reason: signal.reason } : null,
                    indicators: signal?.indicators ?? {},
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
LOGGER.info(stateLoaded ? '🔄 Resuming from saved state' : '🆕 Starting fresh session');
if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.error('\n⚠️  Set CONFIG.API_TOKEN before running!\n');
    process.exit(1);
}
console.log('\n🚀 Starting DARE Bot v3...\n');
bot.connection.connect();
// ── Status display every 60s ──────────────────────────────────
const statusInterval = setInterval(() => {
    if (!state.isAuthorized) return;
    const status = bot.getStatus();
    if (state.currentContractId && state.tradeStartTime) {
        const elapsed = Date.now() - state.tradeStartTime;
        if (elapsed > 420000) {
            LOGGER.error(`🚨 SAFETY: Trade stuck ${Math.round(elapsed / 1000)}s — forcing recovery`);
            bot._recoverStuckTrade('safety-timeout');
        }
    }
    if (bot._tradeLocked && status.totalPositions === 0) {
        LOGGER.warn('⚠️ Trade lock stuck with no open positions — auto-releasing');
        bot._tradeLocked = false;
    }
    let pairLines = '';
    CONFIG.ACTIVE_ASSETS.forEach(sym => {
        const p = status.pairs[sym];
        if (p) {
            const sig    = p.signal ? `${p.signal.method}:${p.signal.direction ?? 'NONE'}` : 'Analyzing...';
            const pers    = p.indicators?.persistence ? `${p.indicators.persistence[0]}` : '?';
            const vol     = p.indicators?.volClass    ? `${p.indicators.volClass[0]}`     : '?';
            const vr      = p.indicators?.vr          ? `VR:${p.indicators.vr}`           : '';
            const cdwn    = p.cooldownCandles > 0      ? ` ❄️CD:${p.cooldownCandles}`     : '';
            pairLines += `\n  ${sym}: ${pers}/${vol} ${vr} Rec${p.recoveryStep} $${(p.currentStake || 0).toFixed(2)} | ${p.trades}t ${p.wins}W/${p.losses}L $${(p.netPL || 0).toFixed(2)} | Pos:${p.activePositions}${cdwn} | ${sig}`;
        }
    });
    console.log(`\n📊 ${getGMTTime()} | Session: ${status.session.trades}t ${status.session.winRate} $${(status.session.netPL || 0).toFixed(2)} | Capital: $${status.capital.toFixed(2)}`);
    console.log(`📋 Overall: ${status.overall.tradesCount}t | P/L: $${(status.overall.netPL || 0).toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
    console.log(`🕐 ${TradingSessionManager.getStatusString()}`);
    console.log(`📈 Assets:${pairLines}`);
}, 60000);
bot.statusDisplayIntervalId = statusInterval;
