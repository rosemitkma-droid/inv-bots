'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║         DERIV SYNTHETIC INDICES CALL/PUT BOT  —  v2.0                  ║
 * ║                                                                          ║
 * ║  Strategy: Volatility-Regime Adaptive Multi-Confluence System           ║
 * ║  ─────────────────────────────────────────────────────────────────────  ║
 * ║  LAYER 1 — REGIME GATE (hard gate, no score)                            ║
 * ║    • ATR Volatility Band   — only trade inside valid ATR range           ║
 * ║    • ADX Trend Strength    — ADX ≥ 20 required (trending regime)         ║
 * ║    • BB Squeeze Guard      — skip when bands are collapsing              ║
 * ║                                                                          ║
 * ║  LAYER 2 — TREND DIRECTION (must all agree)                             ║
 * ║    • Supertrend (ATR-based trailing stop line)                           ║
 * ║    • EMA Stack 8 > 21 > 50 alignment + slope confirmation               ║
 * ║    • Donchian Channel breakout (20-period high/low)                      ║
 * ║                                                                          ║
 * ║  LAYER 3 — MOMENTUM CONFLUENCE (scored 0–4)                             ║
 * ║    • RSI 14 in momentum zone (45–65 bull / 35–55 bear)                  ║
 * ║    • MACD histogram direction + crossover                                ║
 * ║    • Stochastic(5,3,3) crossover in correct zone                        ║
 * ║    • Candle Pattern bias confirmation                                    ║
 * ║                                                                          ║
 * ║  ENTRY: All Layer 1 gates pass + Layer 2 agree + Layer 3 score ≥ 3      ║
 * ║                                                                          ║
 * ║  RISK MANAGEMENT: Fixed-Fractional (1% of capital per trade)            ║
 * ║    • Conservative base: 1% per trade (replaces martingale)              ║
 * ║    • Optional limited recovery: max 2 steps, capped at 2.5% capital     ║
 * ║    • Hard daily stop-loss drawer protection                              ║
 * ║    • Three-consecutive-loss pause (cool-down before re-entry)            ║
 * ║                                                                          ║
 * ║  BUG FIXES vs v1:                                                        ║
 * ║    ✔ All LOGGER calls fixed (proper parentheses, not tagged templates)   ║
 * ║    ✔ All .map() calls fixed (removed Markdown link encoding)             ║
 * ║    ✔ Trade mutex/lock added (prevents race-condition double-trades)      ║
 * ║    ✔ getDayStats() method added to TradeHistoryManager                   ║
 * ║    ✔ Recovery direction logic fixed (signal-driven, not same-direction)  ║
 * ║    ✔ Martingale replaced with fractional fixed staking + 2-step recovery ║
 * ║    ✔ Session filter made optional and correct for synthetics (24/7)      ║
 * ║    ✔ State file age threshold raised to 120 min                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

const WebSocket = require('ws');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');

// ============================================================
// FILE PATHS
// ============================================================
const STATE_FILE        = path.join(__dirname, 'IndexBot-state_v2.json');
const HISTORY_FILE      = path.join(__dirname, 'IndexBot-history_v2.json');
const STATE_SAVE_INTERVAL = 5000;  // ms

// ============================================================
// LOGGER  ← BUG FIX: all methods use proper () not tagged templates
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
    // ── Deriv API ─────────────────────────────────────────────
    API_TOKEN:  'hsj0tA0XJoIzJG5',   // 
    APP_ID:     '1089',
    WS_URL:     'wss://ws.derivws.com/websockets/v3',

    // ── Capital & Risk (Fixed-Fractional — replaces martingale) ──
    INITIAL_CAPITAL:            1000,
    RISK_PERCENT_PER_TRADE:     1.0,    // % of capital per trade (1% = conservative)
    MAX_STAKE:                  10.0,   // Hard cap per trade in USD
    MIN_STAKE:                  0.35,   // Minimum stake allowed by Deriv

    // Recovery staking (limited — max 2 steps)
    RECOVERY_ENABLED:           true,
    RECOVERY_MULTIPLIER:        1.5,    // Step 1 recovery multiplier
    RECOVERY_MULTIPLIER2:       2.0,    // Step 2 recovery multiplier (final)
    MAX_RECOVERY_STEPS:         2,      // Never go beyond 2 recovery steps
    MAX_RECOVERY_STAKE_PCT:     2.5,    // Recovery stake never exceeds 2.5% of capital

    // Session profit/loss guards
    SESSION_PROFIT_TARGET:      500,    // Stop after +$500 session gain
    SESSION_STOP_LOSS:          -150,   // Stop after -$150 session loss
    DAILY_STOP_LOSS:            -200,   // Hard daily stop, resets at UTC midnight

    // Cool-down after consecutive losses
    MAX_CONSECUTIVE_LOSSES:     3,      // Pause trading after 3 straight losses
    COOLDOWN_CANDLES:           3,      // Wait 3 candles before re-entry

    // ── Candle / Contract Settings ────────────────────────────
    GRANULARITY:                60,     // 1-minute candles
    TIMEFRAME_LABEL:            '1m',
    CANDLES_TO_LOAD:            150,    // History for indicator warmup
    MAX_CANDLES_STORED:         250,    // Rolling window

    // Contract duration (slightly less than granularity to close on candle)
    DURATION:                   58,
    DURATION_UNIT:              's',

    // Minimum candles before analysis begins
    MIN_CANDLES_REQUIRED:       60,

    // ── LAYER 1: Regime Gate Parameters ──────────────────────
    // ATR per-asset thresholds (must be inside range to trade)
    ATR_THRESHOLDS: {
        R_10:    { min: 0.20,  max: 3.0  },
        R_25:    { min: 0.50,  max: 5.0  },
        R_50:    { min: 0.02,  max: 0.5  },
        R_75:    { min: 5.0,   max: 50.0 },
        R_100:   { min: 0.20,  max: 2.0  },
        stpRNG:  { min: 0.05,  max: 2.0  },
        stpRNG2: { min: 0.05,  max: 2.0  },
        stpRNG3: { min: 0.05,  max: 2.0  },
        stpRNG4: { min: 0.05,  max: 2.0  },
        stpRNG5: { min: 0.05,  max: 2.0  },
    },
    ATR_PERIOD:                 14,

    // ADX trend-strength gate
    ADX_PERIOD:                 14,
    ADX_MIN_THRESHOLD:          20,     // Below this = ranging/no-trade

    // Bollinger Bands squeeze guard
    BB_PERIOD:                  20,
    BB_STD_DEV:                 2.0,
    BB_SQUEEZE_THRESHOLD:       0.002,  // Width/price below this = squeeze

    // ── LAYER 2: Trend Direction ──────────────────────────────
    // EMA stack
    EMA_FAST:                   8,
    EMA_SLOW:                   21,
    EMA_TREND:                  50,

    // Supertrend
    SUPERTREND_ATR_PERIOD:      10,
    SUPERTREND_MULTIPLIER:      3.0,

    // Donchian Channel breakout
    DONCHIAN_PERIOD:            20,

    // ── LAYER 3: Momentum Confluence ─────────────────────────
    RSI_PERIOD:                 14,
    RSI_BULL_LOW:               45,     // RSI must be 45–68 for bullish momentum
    RSI_BULL_HIGH:              68,
    RSI_BEAR_LOW:               32,     // RSI must be 32–55 for bearish momentum
    RSI_BEAR_HIGH:              55,

    MACD_FAST:                  12,
    MACD_SLOW:                  26,
    MACD_SIGNAL:                9,

    STOCH_K:                    5,      // Fast stochastic for synthetics
    STOCH_D:                    3,
    STOCH_SMOOTH:               3,

    // Minimum Layer 3 confluence score (out of 4 possible)
    MIN_CONFLUENCE_SCORE:       3,

    // ── Trading Sessions (Synthetics trade 24/7 — sessions optional) ─
    // Research shows synthetics have peak pattern clarity at specific hours.
    // Disabling avoids forex-centric session bias on PRNG assets.
    USE_TRADING_SESSIONS:       false,  // Recommended: false for synthetics
    SESSIONS: [
        { name: 'ASIA_OPEN',    start: 22, end: 6  },  // UTC: 22:00–06:00
        { name: 'LONDON_OPEN',  start: 7,  end: 17 },  // UTC: 07:00–17:00
        { name: 'NY_OPEN',      start: 12, end: 23 },  // UTC: 12:00–23:00
    ],

    // ── Position Management ───────────────────────────────────
    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    MAX_TOTAL_POSITIONS:          3,    // Reduced from 5 — tighter risk control

    // ── Active Index Assets ───────────────────────────────────
    ACTIVE_ASSETS: [
        'stpRNG',
        'stpRNG2',
        'stpRNG3',
        'stpRNG4',
        'stpRNG5',
        // Uncomment to add volatility indices:
        'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
    ],

    // ── Misc ──────────────────────────────────────────────────
    DEBUG_MODE:                 true,
    TELEGRAM_ENABLED:           true,
    TELEGRAM_BOT_TOKEN: '8565754902:AAHS6UQWEgLJ0DO-JTpAGQhZLs-UDVVNAQc',
    TELEGRAM_CHAT_ID: '752497117',
};

// ============================================================
// TECHNICAL INDICATOR ENGINE  — v2
// ============================================================
class Indicators {

    // ── EMA (single value) ──────────────────────────────────
    static ema(values, period) {
        if (!values || values.length < period) return null;
        const k   = 2 / (period + 1);
        let   ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < values.length; i++) {
            ema = values[i] * k + ema * (1 - k);
        }
        return ema;
    }

    // ── EMA array (for slope + MACD) ───────────────────────
    static emaArray(values, period) {
        if (!values || values.length < period) return [];
        const k      = 2 / (period + 1);
        const result = [];
        let   ema    = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
        result.push(ema);
        for (let i = period; i < values.length; i++) {
            ema = values[i] * k + ema * (1 - k);
            result.push(ema);
        }
        return result;
    }

    // ── SMA ────────────────────────────────────────────────
    static sma(values, period) {
        if (!values || values.length < period) return null;
        return values.slice(-period).reduce((a, b) => a + b, 0) / period;
    }

    // ── RSI (Wilder's smoothed method) ─────────────────────
    static rsiSmoothed(closes, period = 14) {
        if (!closes || closes.length < period * 2) return null;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) gains  += diff;
            else          losses += Math.abs(diff);
        }
        let avgGain = gains  / period;
        let avgLoss = losses / period;
        for (let i = period + 1; i < closes.length; i++) {
            const diff = closes[i] - closes[i - 1];
            avgGain = (avgGain * (period - 1) + Math.max(diff,  0)) / period;
            avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
        }
        if (avgLoss === 0) return 100;
        return 100 - (100 / (1 + avgGain / avgLoss));
    }

    // ── Bollinger Bands ────────────────────────────────────
    static bollingerBands(closes, period = 20, stdDev = 2) {
        if (!closes || closes.length < period) return null;
        const slice = closes.slice(-period);
        const mid   = slice.reduce((a, b) => a + b, 0) / period;
        const variance = slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period;
        const std   = Math.sqrt(variance);
        return {
            upper:  mid + stdDev * std,
            middle: mid,
            lower:  mid - stdDev * std,
            width:  stdDev * 2 * std / mid,
            std
        };
    }

    // ── MACD ───────────────────────────────────────────────
    // BUG FIX: removed Markdown link encoding on .map() calls
    static macd(closes, fastP = 12, slowP = 26, sigP = 9) {
        if (!closes || closes.length < slowP + sigP) return null;
        const fastEMA  = this.emaArray(closes, fastP);
        const slowEMA  = this.emaArray(closes, slowP);
        const offset   = slowP - fastP;
        const macdLine = slowEMA.map((slow, i) => fastEMA[i + offset] - slow);
        if (macdLine.length < sigP) return null;
        const signalLine     = this.emaArray(macdLine, sigP);
        const last           = macdLine.length - 1;
        const lastSig        = signalLine.length - 1;
        const lastMacd       = macdLine[last];
        const lastSignal     = signalLine[lastSig];
        const prevMacd       = macdLine[last - 1] ?? lastMacd;
        const prevSignal     = signalLine[lastSig - 1] ?? lastSignal;
        return {
            macd:          lastMacd,
            signal:        lastSignal,
            histogram:     lastMacd - lastSignal,
            prevHistogram: prevMacd  - prevSignal,
            bullishCross:  prevMacd <= prevSignal && lastMacd > lastSignal,
            bearishCross:  prevMacd >= prevSignal && lastMacd < lastSignal,
        };
    }

    // ── ATR ────────────────────────────────────────────────
    static atr(candles, period = 14) {
        if (!candles || candles.length < period + 1) return null;
        const slice = candles.slice(-(period + 1));
        const trs   = [];
        for (let i = 1; i < slice.length; i++) {
            const { high, low } = slice[i];
            const prevClose     = slice[i - 1].close;
            trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
        }
        return trs.reduce((a, b) => a + b, 0) / trs.length;
    }

    // ── Supertrend ─────────────────────────────────────────
    // Returns { trend: 'UP'|'DOWN', line: number, flipped: boolean }
    static supertrend(candles, period = 10, multiplier = 3.0) {
        if (!candles || candles.length < period + 5) return null;
        const slice = candles.slice(-(period + 40 > candles.length ? candles.length : period + 40));

        let stUp   = 0;
        let stDown = 0;
        let trend  = 'UP';
        let prevTrend = 'UP';
        let prevStUp  = 0;
        let prevStDown= 0;

        for (let i = period; i < slice.length; i++) {
            const window   = slice.slice(i - period, i + 1);
            const atrVal   = this.atr(window, period) ?? 0;
            const hl2      = (slice[i].high + slice[i].low) / 2;
            const rawUp    = hl2 - multiplier * atrVal;
            const rawDown  = hl2 + multiplier * atrVal;

            stUp   = (rawUp   > prevStUp   || slice[i - 1]?.close < prevStUp)   ? rawUp   : prevStUp;
            stDown = (rawDown < prevStDown  || slice[i - 1]?.close > prevStDown) ? rawDown : prevStDown;

            prevTrend = trend;
            if (slice[i].close > prevStDown) trend = 'UP';
            if (slice[i].close < prevStUp)   trend = 'DOWN';

            prevStUp   = stUp;
            prevStDown = stDown;
        }

        const line    = trend === 'UP' ? stUp : stDown;
        const flipped = trend !== prevTrend;
        return { trend, line, flipped };
    }

    // ── ADX + DI (Wilder's method) ─────────────────────────
    // Returns { adx, plusDI, minusDI }
    static adx(candles, period = 14) {
        if (!candles || candles.length < period * 2 + 1) return null;
        const slice = candles.slice(-(period * 2 + 1));

        let smoothTR  = 0, smoothPDM = 0, smoothMDM = 0;
        // First smoothed values
        for (let i = 1; i <= period; i++) {
            const high = slice[i].high, low = slice[i].low, prevClose = slice[i-1].close;
            const prevHigh = slice[i-1].high, prevLow = slice[i-1].low;
            const tr  = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            const pdm = Math.max(high - prevHigh, 0);
            const mdm = Math.max(prevLow - low,   0);
            smoothTR  += tr;
            smoothPDM += (pdm > mdm ? pdm : 0);
            smoothMDM += (mdm > pdm ? mdm : 0);
        }

        let adxSum = 0;
        let adx14  = 0;

        for (let i = period + 1; i < slice.length; i++) {
            const high = slice[i].high, low = slice[i].low, prevClose = slice[i-1].close;
            const prevHigh = slice[i-1].high, prevLow = slice[i-1].low;
            const tr  = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            const pdm = Math.max(high - prevHigh, 0);
            const mdm = Math.max(prevLow - low,   0);
            smoothTR  = smoothTR  - smoothTR  / period + tr;
            smoothPDM = smoothPDM - smoothPDM / period + (pdm > mdm ? pdm : 0);
            smoothMDM = smoothMDM - smoothMDM / period + (mdm > pdm ? mdm : 0);

            const plusDI  = smoothTR ? (smoothPDM / smoothTR) * 100 : 0;
            const minusDI = smoothTR ? (smoothMDM / smoothTR) * 100 : 0;
            const diDiff  = Math.abs(plusDI - minusDI);
            const diSum   = plusDI + minusDI;
            const dx      = diSum ? (diDiff / diSum) * 100 : 0;

            const idx = i - period;
            if (idx < period) {
                adxSum += dx;
                if (idx === period - 1) adx14 = adxSum / period;
            } else {
                adx14 = (adx14 * (period - 1) + dx) / period;
            }
        }

        const last     = slice.length - 1;
        const high     = slice[last].high,  low     = slice[last].low;
        const prevClose= slice[last-1].close;
        const prevHigh = slice[last-1].high, prevLow = slice[last-1].low;
        const tr   = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        const pdm  = Math.max(high - prevHigh, 0);
        const mdm  = Math.max(prevLow - low, 0);
        smoothTR   = smoothTR  - smoothTR  / period + tr;
        smoothPDM  = smoothPDM - smoothPDM / period + (pdm > mdm ? pdm : 0);
        smoothMDM  = smoothMDM - smoothMDM / period + (mdm > pdm ? mdm : 0);
        const plusDI   = smoothTR ? (smoothPDM / smoothTR) * 100 : 0;
        const minusDI  = smoothTR ? (smoothMDM / smoothTR) * 100 : 0;

        return { adx: adx14, plusDI, minusDI };
    }

    // ── Stochastic (fast, tuned for synthetics) ────────────
    static stochastic(candles, kPeriod = 5, dPeriod = 3, smooth = 3) {
        if (!candles || candles.length < kPeriod + dPeriod + smooth) return null;
        const rawK = [];
        for (let i = kPeriod - 1; i < candles.length; i++) {
            const window  = candles.slice(i - kPeriod + 1, i + 1);
            const highest = Math.max(...window.map(c => c.high));
            const lowest  = Math.min(...window.map(c => c.low));
            rawK.push(lowest === highest ? 50 : ((candles[i].close - lowest) / (highest - lowest)) * 100);
        }
        // Smooth %K
        const smoothedK = [];
        for (let i = smooth - 1; i < rawK.length; i++) {
            smoothedK.push(rawK.slice(i - smooth + 1, i + 1).reduce((a, b) => a + b, 0) / smooth);
        }
        // %D = SMA of smoothed %K
        const dValues = [];
        for (let i = dPeriod - 1; i < smoothedK.length; i++) {
            dValues.push(smoothedK.slice(i - dPeriod + 1, i + 1).reduce((a, b) => a + b, 0) / dPeriod);
        }
        const kLast   = smoothedK[smoothedK.length - 1];
        const kPrev   = smoothedK[smoothedK.length - 2] ?? kLast;
        const dLast   = dValues[dValues.length - 1];
        return {
            k:           kLast,
            d:           dLast,
            prevK:       kPrev,
            overbought:  kLast > 80,
            oversold:    kLast < 20,
            bullishCross: kPrev < dLast && kLast > dLast,
            bearishCross: kPrev > dLast && kLast < dLast,
        };
    }

    // ── Donchian Channel (breakout detection) ───────────────
    static donchian(candles, period = 20) {
        if (!candles || candles.length < period + 1) return null;
        const window = candles.slice(-period - 1, -1);  // exclude current forming
        const high   = Math.max(...window.map(c => c.high));
        const low    = Math.min(...window.map(c => c.low));
        const close  = candles[candles.length - 1].close;
        return {
            upper:         high,
            lower:         low,
            mid:           (high + low) / 2,
            bullBreakout:  close > high,   // price closed above prior N-bar high
            bearBreakout:  close < low,    // price closed below prior N-bar low
        };
    }

    // ── Candle Pattern Recognition ─────────────────────────
    static detectPattern(candles) {
        if (!candles || candles.length < 3) return { pattern: 'NONE', bias: 'NEUTRAL' };
        const [c2, c1, c0] = candles.slice(-3);
        const body0  = Math.abs(c0.close - c0.open);
        const range0 = c0.high - c0.low || 0.0001;
        const body1  = Math.abs(c1.close - c1.open);
        const body2  = Math.abs(c2.close - c2.open);

        if (range0 > 0 && body0 / range0 < 0.1)
            return { pattern: 'DOJI', bias: 'NEUTRAL' };

        // Bullish Engulfing
        if (c1.close < c1.open && c0.close > c0.open &&
            c0.open < c1.close && c0.close > c1.open)
            return { pattern: 'BULLISH_ENGULFING', bias: 'BULLISH' };

        // Bearish Engulfing
        if (c1.close > c1.open && c0.close < c0.open &&
            c0.open > c1.close && c0.close < c1.open)
            return { pattern: 'BEARISH_ENGULFING', bias: 'BEARISH' };

        // Hammer
        const lowerWick = Math.min(c0.open, c0.close) - c0.low;
        const upperWick = c0.high - Math.max(c0.open, c0.close);
        if (body0 > 0 && lowerWick > body0 * 2 && upperWick < body0 * 0.5)
            return { pattern: 'HAMMER', bias: 'BULLISH' };

        // Shooting Star
        if (body0 > 0 && upperWick > body0 * 2 && lowerWick < body0 * 0.5)
            return { pattern: 'SHOOTING_STAR', bias: 'BEARISH' };

        // Three White Soldiers
        if (c2.close > c2.open && c1.close > c1.open && c0.close > c0.open &&
            c1.open > c2.open && c0.open > c1.open &&
            c1.close > c2.close && c0.close > c1.close)
            return { pattern: 'THREE_WHITE_SOLDIERS', bias: 'BULLISH' };

        // Three Black Crows
        if (c2.close < c2.open && c1.close < c1.open && c0.close < c0.open &&
            c1.open < c2.open && c0.open < c1.open &&
            c1.close < c2.close && c0.close < c1.close)
            return { pattern: 'THREE_BLACK_CROWS', bias: 'BEARISH' };

        // Morning Star
        if (c2.close < c2.open && body1 < body2 * 0.3 && c0.close > c0.open &&
            c0.close > (c2.open + c2.close) / 2)
            return { pattern: 'MORNING_STAR', bias: 'BULLISH' };

        // Evening Star
        if (c2.close > c2.open && body1 < body2 * 0.3 && c0.close < c0.open &&
            c0.close < (c2.open + c2.close) / 2)
            return { pattern: 'EVENING_STAR', bias: 'BEARISH' };

        // Strong momentum candles
        if (c0.close > c0.open && body0 / range0 > 0.7)
            return { pattern: 'STRONG_BULLISH', bias: 'BULLISH' };
        if (c0.close < c0.open && body0 / range0 > 0.7)
            return { pattern: 'STRONG_BEARISH', bias: 'BEARISH' };

        return {
            pattern: c0.close > c0.open ? 'BULLISH_CANDLE' : 'BEARISH_CANDLE',
            bias:    c0.close > c0.open ? 'BULLISH' : 'BEARISH',
        };
    }

    // ── Support / Resistance Levels ────────────────────────
    static findKeyLevels(candles, lookback = 20) {
        const slice  = candles.slice(-lookback);
        const highs  = slice.map(c => c.high);
        const lows   = slice.map(c => c.low);
        const resistance = Math.max(...highs);
        const support    = Math.min(...lows);
        return { resistance, support, midpoint: (resistance + support) / 2 };
    }
}

// ============================================================
// SIGNAL ANALYZER  — v2 (3-layer architecture)
// ============================================================
class SignalAnalyzer {
    /**
     * Returns:
     * {
     *   direction:   'CALL' | 'PUT' | null,
     *   shouldTrade: boolean,
     *   score:       number,   (Layer 3 momentum score, max 4)
     *   maxScore:    4,
     *   reason:      string,
     *   layer1:      object,   (regime gates)
     *   layer2:      object,   (trend direction)
     *   layer3:      object,   (momentum signals)
     *   indicators:  object,   (raw indicator values for display)
     *   warnings:    string[],
     * }
     */
    static analyze(candles, symbol) {
        const result = {
            direction:   null,
            shouldTrade: false,
            score:       0,
            maxScore:    4,
            reason:      '',
            layer1:      {},
            layer2:      {},
            layer3:      {},
            indicators:  {},
            warnings:    [],
        };

        if (!candles || candles.length < CONFIG.MIN_CANDLES_REQUIRED) {
            result.reason = `Insufficient candles (${candles?.length ?? 0}/${CONFIG.MIN_CANDLES_REQUIRED})`;
            return result;
        }

        const closes    = candles.map(c => c.close);
        const lastClose = closes[closes.length - 1];

        // ── Compute all indicators ─────────────────────────
        const atrVal    = Indicators.atr(candles, CONFIG.ATR_PERIOD);
        const adxData   = Indicators.adx(candles, CONFIG.ADX_PERIOD);
        const bb        = Indicators.bollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_STD_DEV);
        const st        = Indicators.supertrend(candles, CONFIG.SUPERTREND_ATR_PERIOD, CONFIG.SUPERTREND_MULTIPLIER);
        const emaFast   = Indicators.ema(closes, CONFIG.EMA_FAST);
        const emaSlow   = Indicators.ema(closes, CONFIG.EMA_SLOW);
        const emaTrend  = Indicators.ema(closes, CONFIG.EMA_TREND);
        const emaFastArr= Indicators.emaArray(closes, CONFIG.EMA_FAST);
        const donchian  = Indicators.donchian(candles, CONFIG.DONCHIAN_PERIOD);
        const rsi       = Indicators.rsiSmoothed(closes, CONFIG.RSI_PERIOD);
        const macd      = Indicators.macd(closes, CONFIG.MACD_FAST, CONFIG.MACD_SLOW, CONFIG.MACD_SIGNAL);
        const stoch     = Indicators.stochastic(candles, CONFIG.STOCH_K, CONFIG.STOCH_D, CONFIG.STOCH_SMOOTH);
        const pattern   = Indicators.detectPattern(candles);
        const keyLevels = Indicators.findKeyLevels(candles, 20);

        // EMA slope (3-bar)
        const emaFastSlope = emaFastArr.length >= 3
            ? emaFastArr[emaFastArr.length - 1] - emaFastArr[emaFastArr.length - 3]
            : 0;

        // Store all raw values for display / Telegram
        result.indicators = {
            emaFast:     emaFast?.toFixed(5),
            emaSlow:     emaSlow?.toFixed(5),
            emaTrend:    emaTrend?.toFixed(5),
            stTrend:     st?.trend,
            stLine:      st?.line?.toFixed(5),
            adx:         adxData?.adx?.toFixed(1),
            plusDI:      adxData?.plusDI?.toFixed(1),
            minusDI:     adxData?.minusDI?.toFixed(1),
            rsi:         rsi?.toFixed(2),
            bbWidth:     bb?.width?.toFixed(4),
            macdHist:    macd?.histogram?.toFixed(5),
            stochK:      stoch?.k?.toFixed(2),
            stochD:      stoch?.d?.toFixed(2),
            atr:         atrVal?.toFixed(5),
            donchHigh:   donchian?.upper?.toFixed(5),
            donchLow:    donchian?.lower?.toFixed(5),
            pattern:     pattern.pattern,
            lastClose:   lastClose?.toFixed(5),
            support:     keyLevels.support?.toFixed(5),
            resistance:  keyLevels.resistance?.toFixed(5),
        };

        // ════════════════════════════════════════════════
        // LAYER 1 — REGIME GATES (hard gates, return early)
        // ════════════════════════════════════════════════

        // Gate 1a: ATR range check
        if (atrVal !== null) {
            const atrCfg = CONFIG.ATR_THRESHOLDS[symbol];
            if (atrCfg) {
                if (atrVal < atrCfg.min) {
                    result.reason = `L1 FAIL: ATR too low (${atrVal.toFixed(5)} < ${atrCfg.min}) — flat market`;
                    result.warnings.push('LOW_VOLATILITY');
                    result.layer1 = { atr: 'FAIL_LOW' };
                    return result;
                }
                if (atrVal > atrCfg.max) {
                    result.reason = `L1 FAIL: ATR too high (${atrVal.toFixed(5)} > ${atrCfg.max}) — chaotic market`;
                    result.warnings.push('EXTREME_VOLATILITY');
                    result.layer1 = { atr: 'FAIL_HIGH' };
                    return result;
                }
            }
        }

        // Gate 1b: ADX trend-strength check
        if (adxData !== null) {
            if (adxData.adx < CONFIG.ADX_MIN_THRESHOLD) {
                result.reason = `L1 FAIL: ADX ${adxData.adx.toFixed(1)} < ${CONFIG.ADX_MIN_THRESHOLD} — ranging/no trend`;
                result.warnings.push('LOW_ADX');
                result.layer1 = { atr: 'PASS', adx: 'FAIL' };
                return result;
            }
        }

        // Gate 1c: BB squeeze guard
        if (bb && bb.width < CONFIG.BB_SQUEEZE_THRESHOLD) {
            result.reason = `L1 FAIL: BB squeeze (${bb.width.toFixed(4)}) — awaiting breakout`;
            result.warnings.push('BB_SQUEEZE');
            result.layer1 = { atr: 'PASS', adx: 'PASS', bb: 'FAIL_SQUEEZE' };
            return result;
        }

        result.layer1 = { atr: 'PASS', adx: 'PASS', bb: 'PASS' };

        // ════════════════════════════════════════════════
        // LAYER 2 — TREND DIRECTION (all 3 must agree)
        // ════════════════════════════════════════════════
        let trendBull = 0;
        let trendBear = 0;
        const l2 = {};

        // 2a: Supertrend
        if (st) {
            if (st.trend === 'UP')   { trendBull++; l2.supertrend = 'BULL'; }
            else                     { trendBear++; l2.supertrend = 'BEAR'; }
        } else {
            l2.supertrend = 'NEUTRAL';
        }

        // 2b: EMA Stack alignment
        if (emaFast && emaSlow && emaTrend) {
            if (emaFast > emaSlow && emaSlow > emaTrend && emaFastSlope > 0) {
                trendBull++; l2.ema = 'BULL (8>21>50 rising)';
            } else if (emaFast < emaSlow && emaSlow < emaTrend && emaFastSlope < 0) {
                trendBear++; l2.ema = 'BEAR (8<21<50 falling)';
            } else {
                l2.ema = 'NEUTRAL';
            }
        } else {
            l2.ema = 'NEUTRAL';
        }

        // 2c: Donchian channel breakout
        if (donchian) {
            if (donchian.bullBreakout) { trendBull++; l2.donchian = 'BULL_BREAKOUT'; }
            else if (donchian.bearBreakout) { trendBear++; l2.donchian = 'BEAR_BREAKOUT'; }
            else { l2.donchian = 'NEUTRAL'; }
        } else {
            l2.donchian = 'NEUTRAL';
        }

        result.layer2 = l2;

        // Layer 2 decision: all 3 signals must agree (no mixed signals)
        const trendDirection = trendBull === 3 ? 'BULL' : trendBear === 3 ? 'BEAR' : null;
        if (!trendDirection) {
            result.reason = `L2 FAIL: Trend not aligned (bull:${trendBull} bear:${trendBear}) — waiting for confluence`;
            return result;
        }

        // ADX directional bias must also agree (plusDI vs minusDI)
        if (adxData) {
            const diAgreement = trendDirection === 'BULL'
                ? adxData.plusDI > adxData.minusDI
                : adxData.minusDI > adxData.plusDI;
            if (!diAgreement) {
                result.reason = `L2 FAIL: ADX DI mismatch (+DI:${adxData.plusDI.toFixed(1)} -DI:${adxData.minusDI.toFixed(1)}) vs trend=${trendDirection}`;
                result.warnings.push('DI_MISMATCH');
                return result;
            }
        }

        // ════════════════════════════════════════════════
        // LAYER 3 — MOMENTUM CONFLUENCE (scored 0–4)
        // ════════════════════════════════════════════════
        let score = 0;
        const l3  = {};

        // 3a: RSI in momentum zone
        if (rsi !== null) {
            if (trendDirection === 'BULL' && rsi >= CONFIG.RSI_BULL_LOW && rsi <= CONFIG.RSI_BULL_HIGH) {
                score++; l3.rsi = `BULL_ZONE (${rsi.toFixed(1)})`;
            } else if (trendDirection === 'BEAR' && rsi >= CONFIG.RSI_BEAR_LOW && rsi <= CONFIG.RSI_BEAR_HIGH) {
                score++; l3.rsi = `BEAR_ZONE (${rsi.toFixed(1)})`;
            } else {
                l3.rsi = `OUT_OF_ZONE (${rsi.toFixed(1)})`;
                if (rsi >= 70) result.warnings.push('RSI_OVERBOUGHT');
                if (rsi <= 30) result.warnings.push('RSI_OVERSOLD');
            }
        }

        // 3b: MACD histogram direction + crossover
        if (macd !== null) {
            const histRising  = macd.histogram > 0 && macd.histogram > macd.prevHistogram;
            const histFalling = macd.histogram < 0 && macd.histogram < macd.prevHistogram;
            if (trendDirection === 'BULL' && (macd.bullishCross || histRising)) {
                score++; l3.macd = macd.bullishCross ? 'BULLISH_CROSS' : 'HIST_RISING';
            } else if (trendDirection === 'BEAR' && (macd.bearishCross || histFalling)) {
                score++; l3.macd = macd.bearishCross ? 'BEARISH_CROSS' : 'HIST_FALLING';
            } else {
                l3.macd = 'NEUTRAL';
            }
        }

        // 3c: Stochastic(5,3,3) crossover
        if (stoch !== null) {
            if (trendDirection === 'BULL') {
                if ((stoch.bullishCross && !stoch.overbought) || (stoch.k > 50 && stoch.k > stoch.prevK)) {
                    score++; l3.stoch = `BULL (K:${stoch.k.toFixed(1)})`;
                } else if (stoch.overbought) {
                    l3.stoch = 'OVERBOUGHT — skip';
                    result.warnings.push('STOCH_OVERBOUGHT');
                } else {
                    l3.stoch = 'NEUTRAL';
                }
            } else {
                if ((stoch.bearishCross && !stoch.oversold) || (stoch.k < 50 && stoch.k < stoch.prevK)) {
                    score++; l3.stoch = `BEAR (K:${stoch.k.toFixed(1)})`;
                } else if (stoch.oversold) {
                    l3.stoch = 'OVERSOLD — skip';
                    result.warnings.push('STOCH_OVERSOLD');
                } else {
                    l3.stoch = 'NEUTRAL';
                }
            }
        }

        // 3d: Candle pattern confirmation
        if (pattern.bias === 'BULLISH' && trendDirection === 'BULL') {
            score++; l3.pattern = `CONFIRM_BULL: ${pattern.pattern}`;
        } else if (pattern.bias === 'BEARISH' && trendDirection === 'BEAR') {
            score++; l3.pattern = `CONFIRM_BEAR: ${pattern.pattern}`;
        } else if (pattern.bias === 'NEUTRAL') {
            l3.pattern = `NEUTRAL: ${pattern.pattern}`;
        } else {
            l3.pattern = `CONFLICT: ${pattern.pattern} vs ${trendDirection}`;
            result.warnings.push('PATTERN_CONFLICT');
        }

        result.layer3 = l3;
        result.score  = score;

        // ── Final decision ────────────────────────────────
        if (score >= CONFIG.MIN_CONFLUENCE_SCORE) {
            result.direction  = trendDirection === 'BULL' ? 'CALL' : 'PUT';
            result.shouldTrade = true;
            result.reason = (
                `${result.direction}: L1✅ L2(ST:${l2.supertrend} EMA:${l2.ema?.split(' ')[0]} DON:${l2.donchian}) ` +
                `L3:${score}/${result.maxScore} ADX:${adxData?.adx?.toFixed(1)}`
            );
        } else {
            result.reason = `L3 FAIL: score ${score}/${result.maxScore} < ${CONFIG.MIN_CONFLUENCE_SCORE} required`;
        }

        return result;
    }
}

// ============================================================
// STAKE CALCULATOR  — Fixed-Fractional + Limited Recovery
// ============================================================
class StakeCalculator {
    /**
     * Calculate trade stake using fixed-fractional position sizing.
     * Recovery is limited to 2 steps and capped at MAX_RECOVERY_STAKE_PCT.
     */
    static calculate(capital, recoveryStep = 0) {
        const baseStake = Math.max(
            CONFIG.MIN_STAKE,
            Math.min(
                capital * (CONFIG.RISK_PERCENT_PER_TRADE / 100),
                CONFIG.MAX_STAKE
            )
        );

        if (!CONFIG.RECOVERY_ENABLED || recoveryStep === 0) {
            return parseFloat(baseStake.toFixed(2));
        }

        let stake = baseStake;
        if (recoveryStep === 1) stake = baseStake * CONFIG.RECOVERY_MULTIPLIER;
        if (recoveryStep >= 2)  stake = baseStake * CONFIG.RECOVERY_MULTIPLIER2;

        // Cap recovery stake at MAX_RECOVERY_STAKE_PCT of capital
        const maxRecovery = capital * (CONFIG.MAX_RECOVERY_STAKE_PCT / 100);
        stake = Math.min(stake, maxRecovery);
        stake = Math.max(stake, CONFIG.MIN_STAKE);

        return parseFloat(Math.ceil(stake * 100) / 100);
    }

    /**
     * Format stake info for display.
     */
    static describe(capital, recoveryStep = 0) {
        const stake = this.calculate(capital, recoveryStep);
        const pct   = ((stake / capital) * 100).toFixed(2);
        return `$${stake.toFixed(2)} (${pct}% capital, recovery step ${recoveryStep})`;
    }
}

// ============================================================
// CANDLE ANALYSIS UTILITY (retained from v1)
// ============================================================
class CandleAnalyzer {
    static isBullish(candle)          { return candle.close > candle.open; }
    static isBearish(candle)          { return candle.close < candle.open; }
    static getCandleDirection(candle) {
        if (this.isBullish(candle)) return 'BULLISH';
        if (this.isBearish(candle)) return 'BEARISH';
        return 'DOJI';
    }
    static getLastClosedCandle(symbol) {
        const a = state.assets[symbol];
        if (!a?.closedCandles?.length) return null;
        return a.closedCandles[a.closedCandles.length - 1];
    }
}

// ============================================================
// TRADING SESSION MANAGER (retained + corrected)
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
        if (end <= start) return hour >= start || hour < end;  // overnight
        return hour >= start && hour < end;
    }

    static getSessionInfo() {
        if (!CONFIG.USE_TRADING_SESSIONS) {
            return { activeSessions: ['24/7_SYNTHETIC'], inSession: true, inOverlap: false, gmtHour: this.getCurrentUTCHour() };
        }
        const hour   = this.getCurrentUTCHour();
        const active = CONFIG.SESSIONS.filter(s => this._inSession(hour, s.start, s.end));
        return {
            activeSessions: active.map(s => s.name),
            inSession:      active.length > 0,
            inOverlap:      active.length >= 2,
            gmtHour:        hour,
        };
    }

    static getStatusString() {
        const info = this.getSessionInfo();
        const time = `${String(new Date().getUTCHours()).padStart(2,'0')}:${String(new Date().getUTCMinutes()).padStart(2,'0')} UTC`;
        if (!CONFIG.USE_TRADING_SESSIONS)
            return `🟢 SYNTHETIC 24/7 MODE (${time})`;
        if (!info.inSession)
            return `🔴 OUTSIDE SESSIONS (${time})`;
        return `🟢 ${info.activeSessions.join('+')} (${time})${info.inOverlap ? ' 🔥 OVERLAP' : ''}`;
    }
}

// ============================================================
// TRADE HISTORY MANAGER (retained + getDayStats fix)
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
            if (profit > 0) { t.winsCount++;  t.profit += profit;            t.netPL += profit; }
            else            { t.lossesCount++; t.loss   += Math.abs(profit);  t.netPL += profit; }
        });
        if (!tradeHistory.overall.firstTradeDate) tradeHistory.overall.firstTradeDate = dateKey;
        tradeHistory.overall.lastTradeDate = dateKey;
        tradeHistory.dailyHistory[dateKey].endCapital = state.capital;
        tradeHistory.lastUpdated = Date.now();
        this.saveHistory();
    }

    // BUG FIX: method was referenced but never defined in v1
    static getDayStats(dateKey) {
        this.ensureDayEntry(dateKey);
        return tradeHistory.dailyHistory[dateKey];
    }

    static getTodayStats()   { return this.getDayStats(this.getDateKey()); }
    static getOverallStats() { return tradeHistory.overall; }
    static getAllDays()       { return Object.keys(tradeHistory.dailyHistory).sort(); }
    static getRecentDays(n = 7) {
        return this.getAllDays().slice(-n).map(d => ({ date: d, ...tradeHistory.dailyHistory[d] }));
    }
}

// ============================================================
// STATE PERSISTENCE (retained + raised age threshold)
// ============================================================
class StatePersistence {
    static saveState() {
        try {
            const data = {
                savedAt:         Date.now(),
                capital:         state.capital,
                session:         { ...state.session },
                portfolio:       { ...state.portfolio },
                hourlyStats:     { ...state.hourlyStats },
                currentTradeDay: state.currentTradeDay,
                assets:          {},
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

            // BUG FIX: raised from 30 to 120 min — don't lose martingale/recovery state on restart
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
                        LOGGER.info(`📊 ${symbol}: Recovery=${a.recoveryStep}, Stake=$${a.currentStake.toFixed(2)}, P/L=$${a.netPL.toFixed(2)}, CooldownCandles:${a.cooldownCandles}`);
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
// TELEGRAM SERVICE (retained, syntax fixed)
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
            `${emoji} <b>INDEX BOT v2 — ${type}</b>`,
            `Pair: <b>${symbol}</b>  Direction: <b>${direction === 'CALL' ? '📈 CALL' : '📉 PUT'}</b>`,
            `Stake: $${stake.toFixed(2)} | Duration: ${duration}${durationUnit.toUpperCase()}`,
            `Recovery Step: ${a?.recoveryStep ?? 0} | ${TradingSessionManager.getStatusString()}`,
            ``,
        ];

        if (type === 'OPEN' && details.signal) {
            const sig = details.signal;
            lines.push(`📊 <b>Signal Analysis (3-Layer):</b>`);
            lines.push(`L1 Gate:  ATR=${sig.layer1?.atr} ADX=${sig.layer1?.adx} BB=${sig.layer1?.bb}`);
            lines.push(`L2 Trend: ST=${sig.layer2?.supertrend} EMA=${sig.layer2?.ema?.split(' ')[0]} DON=${sig.layer2?.donchian}`);
            lines.push(`L3 Score: ${sig.score}/${sig.maxScore} | RSI:${ind.rsi} MACD:${ind.macdHist}`);
            lines.push(`ADX: ${ind.adx} (+DI:${ind.plusDI} -DI:${ind.minusDI})`);
            lines.push(`Stoch K/D: ${ind.stochK}/${ind.stochD} | Pattern: ${ind.pattern}`);
            if (sig.warnings?.length) lines.push(`⚠️ Warnings: ${sig.warnings.join(', ')}`);
        }

        if (details.profit !== undefined) {
            const pl = details.profit;
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
        const h     = state.hourlyStats;
        if (h.trades === 0) return;
        const wr    = h.trades > 0 ? ((h.wins / h.trades) * 100).toFixed(1) : '0.0';
        const today = TradeHistoryManager.getTodayStats();
        let assetInfo = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a?.tradesCount > 0) {
                assetInfo += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L $${a.netPL.toFixed(2)} Rec:${a.recoveryStep}`;
            }
        });
        await this.sendMessage([
            `⏰ <b>Index Bot v2 Hourly</b>`,
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
                pairBreakdown += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L (${pairWr}%) $${a.netPL.toFixed(2)}`;
            }
        });
        await this.sendMessage([
            `📊 <b>INDEX BOT v2 SESSION SUMMARY</b>`,
            `Duration: ${stats.duration} | Trades: ${stats.trades}`,
            `W: ${stats.wins} | L: ${stats.losses} | Win Rate: ${stats.winRate}`,
            `Session P/L: $${stats.netPL.toFixed(2)}`,
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
        let pairInfo  = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            pairInfo += `\n  ${sym}: ${CONFIG.TIMEFRAME_LABEL} | ${CONFIG.DURATION}${CONFIG.DURATION_UNIT}`;
        });
        await this.sendMessage([
            `🤖 <b>DERIV INDEX BOT v2 STARTED</b>`,
            `Strategy: 3-Layer Volatility-Regime Adaptive Confluence`,
            `L1: ATR+ADX+BB | L2: Supertrend+EMA+Donchian | L3: RSI+MACD+Stoch+Pattern (${CONFIG.MIN_CONFLUENCE_SCORE}/4)`,
            `Risk: ${CONFIG.RISK_PERCENT_PER_TRADE}% per trade | Max: $${CONFIG.MAX_STAKE}`,
            `Recovery: ${CONFIG.RECOVERY_ENABLED ? `Enabled (max ${CONFIG.MAX_RECOVERY_STEPS} steps)` : 'Disabled'}`,
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
// SESSION MANAGER (retained + daily stop-loss added)
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
        // Daily stop-loss
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
        await TelegramService.sendSessionSummary();
    }

    static getSessionStats() {
        const dur  = Date.now() - state.session.startTime;
        const hrs  = Math.floor(dur / 3600000);
        const mins = Math.floor((dur % 3600000) / 60000);
        const wr   = state.session.tradesCount > 0
            ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1) + '%'
            : '0%';
        return {
            duration: `${hrs}h ${mins}m`,
            trades:   state.session.tradesCount,
            wins:     state.session.winsCount,
            losses:   state.session.lossesCount,
            winRate:  wr,
            netPL:    state.session.netPL,
        };
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
            // Re-activate session at day start
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
        s.startTime    = Date.now();
        s.startCapital = state.capital;
        state.portfolio   = { dailyProfit: 0, dailyLoss: 0, dailyWins: 0, dailyLosses: 0 };
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                a.tradesCount = 0; a.winsCount = 0; a.lossesCount = 0;
                a.profit = 0; a.loss = 0; a.netPL = 0;
                // Do NOT reset recoveryStep or cooldownCandles — carry over within session
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
            // WIN
            state.session.winsCount++;
            state.session.profit   += profit;
            state.session.netPL    += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            state.hourlyStats.wins++;
            a.winsCount++;
            a.profit  += profit;
            a.netPL   += profit;
            a.consecutiveWins++;
            a.consecutiveLosses = 0;
            a.recoveryStep      = 0;
            a.cooldownCandles   = 0;
            a.currentStake      = StakeCalculator.calculate(state.capital);
            a.lastTradeWasWin   = true;
            LOGGER.trade(`✅ [${symbol}] WIN +$${profit.toFixed(2)} | ${direction} | P/L: $${a.netPL.toFixed(2)}`);
        } else {
            // LOSS
            state.session.lossesCount++;
            state.session.loss     += Math.abs(profit);
            state.session.netPL    += profit;
            state.portfolio.dailyLoss    += Math.abs(profit);
            state.portfolio.dailyLosses++;
            state.hourlyStats.losses++;
            a.lossesCount++;
            a.loss            += Math.abs(profit);
            a.netPL           += profit;
            a.consecutiveLosses++;
            a.consecutiveWins  = 0;
            a.lastTradeWasWin  = false;

            // Recovery step (max MAX_RECOVERY_STEPS)
            if (a.recoveryStep < CONFIG.MAX_RECOVERY_STEPS) {
                a.recoveryStep++;
            } else {
                // Exhausted recovery — reset, accept the loss, start fresh
                LOGGER.warn(`⚠️ [${symbol}] Max recovery steps reached — resetting`);
                a.recoveryStep = 0;
            }

            a.currentStake    = StakeCalculator.calculate(state.capital, a.recoveryStep);

            // Cool-down after MAX_CONSECUTIVE_LOSSES straight losses
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

            LOGGER.trade(`❌ [${symbol}] LOSS -$${Math.abs(profit).toFixed(2)} | ${direction} | Recovery:${a.recoveryStep} | Next Stake: $${a.currentStake.toFixed(2)}`);
        }

        TradeHistoryManager.recordTrade(symbol, profit, a.recoveryStep);
    }
}

// ============================================================
// STATE (retained structure, updated fields)
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
    // Watchdog
    tradeWatchdogTimer:     null,
    tradeWatchdogPollTimer: null,
    pendingTradeInfo:       null,
    tradeStartTime:         null,
    currentContractId:      null,
};

let tradeHistory = null;

// ============================================================
// CONNECTION MANAGER (retained + trade lock added)
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
        this.activeSubscriptions  = new Set();
        this._subscriptionIds     = new Map();
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
        state.isConnected   = true;
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
                    cooldownCandles:             0,   // candles remaining in cool-down
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
        LOGGER.info(`🔑 Authorized: ${r.authorize.loginid} | Balance: ${r.authorize.balance} ${r.authorize.currency}`);
        state.isAuthorized   = true;
        state.accountBalance = r.authorize.balance;
        if (state.capital === CONFIG.INITIAL_CAPITAL) state.capital = r.authorize.balance;
        this.send({ balance: 1, subscribe: 1 });

        // Re-subscribe to any open contracts after reconnect
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

        // Live update (not yet settled)
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

        // Find owner
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

        // Mark processed and clear watchdog
        bot._processedContracts.add(contractIdStr);
        bot._clearAllWatchdogTimers();

        const a      = state.assets[ownerSym];
        const pos    = a.activePositions[posIdx];
        const profit = contract.profit;

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
            open:      parseFloat(ohlc.open),
            high:      parseFloat(ohlc.high),
            low:       parseFloat(ohlc.low),
            close:     parseFloat(ohlc.close),
            epoch:     ohlc.epoch,
            open_time: openTime,
        };

        if ([incoming.open, incoming.high, incoming.low, incoming.close].some(isNaN)) {
            LOGGER.error(`[${symbol}] Invalid OHLC data`);
            return;
        }

        const isNewCandle = a.currentFormingCandle?.open_time !== undefined &&
                            incoming.open_time !== a.currentFormingCandle.open_time;

        if (isNewCandle) {
            const closed      = { ...a.currentFormingCandle };
            closed.epoch      = closed.open_time + gran;

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

                    // Cool-down tick-down
                    if (a.cooldownCandles > 0) {
                        a.cooldownCandles--;
                        LOGGER.info(`❄️ [${symbol}] Cool-down: ${a.cooldownCandles} candles remaining`);
                    }

                    a.canTrade = true;

                    try {
                        // BUG FIX: single consistent entry path — always run signal analysis
                        // Recovery direction is now determined by the signal, not the previous trade
                        bot.executeNextTrade(symbol, closed);
                    } catch (err) {
                        LOGGER.error(`[${symbol}] Trade execution error: ${err.message}`);
                        bot._forceReleaseTradeLock();
                    }
                }
            }
        }

        a.currentFormingCandle = incoming;

        // Update live candles array
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
        const gran    = CONFIG.GRANULARITY;
        // BUG FIX: removed Markdown link encoding on .map()
        const candles = (r.candles || []).map(c => ({
            open:      parseFloat(c.open),
            high:      parseFloat(c.high),
            low:       parseFloat(c.low),
            close:     parseFloat(c.close),
            epoch:     c.epoch,
            open_time: Math.floor((c.epoch - gran) / gran) * gran,
        }));

        if (!candles.length) { LOGGER.warn(`[${symbol}] No candles received`); return; }

        state.assets[symbol].closedCandles               = [...candles];
        state.assets[symbol].candles                     = [...candles];
        state.assets[symbol].lastProcessedCandleOpenTime = candles[candles.length - 1].open_time;
        state.assets[symbol].currentFormingCandle        = null;
        state.assets[symbol].candlesLoaded               = true;

        const signal = SignalAnalyzer.analyze(candles, symbol);
        LOGGER.info(
            `📊 [${symbol}] Loaded ${candles.length} ${CONFIG.TIMEFRAME_LABEL} candles | ` +
            `ADX:${signal.indicators?.adx} ST:${signal.indicators?.stTrend} ` +
            `Score:${signal.score}/${signal.maxScore} | ${signal.reason}`
        );
    }

    onError(err) { LOGGER.error(`WebSocket error: ${err.message}`); }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected  = false;
        state.isAuthorized = false;
        this.stopPing();
        StatePersistence.saveState();
        if (this.isReconnecting) return;
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.isReconnecting = true;
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})`);
            TelegramService.sendMessage(`⚠️ <b>CONNECTION LOST</b> — Reconnecting (attempt ${this.reconnectAttempts})`);
            setTimeout(() => { this.isReconnecting = false; this.connect(); }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached — giving up');
            TelegramService.sendMessage(`🛑 <b>BOT STOPPED</b> — Max reconnections\nFinal P/L: $${state.session.netPL.toFixed(2)}`);
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
// MAIN BOT CLASS  — v2
// ============================================================
class IndexBot {
    constructor() {
        this.connection              = new ConnectionManager();
        this._processedContracts     = new Set();
        this._tradeLocked            = false;   // BUG FIX: mutex added
        this.tradeWatchdogMs         = 80000;   // 80s (58s duration + buffer)
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
        console.log('\n' + '═'.repeat(72));
        console.log(' DERIV SYNTHETIC INDICES BOT v2 — Volatility-Regime Adaptive System');
        console.log('═'.repeat(72));
        console.log(`Assets    : ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        console.log(`Timeframe : ${CONFIG.TIMEFRAME_LABEL} candles | Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT}`);
        console.log(`Strategy  : L1(ATR+ADX+BB) + L2(ST+EMA+Donchian) + L3(RSI+MACD+Stoch+Pattern ≥${CONFIG.MIN_CONFLUENCE_SCORE}/4)`);
        console.log(`Risk      : ${CONFIG.RISK_PERCENT_PER_TRADE}%/trade | Max: $${CONFIG.MAX_STAKE} | Recovery: ${CONFIG.MAX_RECOVERY_STEPS} steps max`);
        console.log(`Capital   : $${state.capital.toFixed(2)}`);
        console.log(`Sessions  : ${TradingSessionManager.getStatusString()}`);
        console.log('═'.repeat(72) + '\n');

        state.currentTradeDay = TradeHistoryManager.getDateKey();
        TradeHistoryManager.ensureDayEntry(state.currentTradeDay);
        this.connection.initializeAssets();

        // Subscribe to all assets
        CONFIG.ACTIVE_ASSETS.forEach(sym => this.subscribeToCandles(sym));

        await TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();
        TelegramService.startDailyTimer();
        this.startSessionTimeChecker();
        LOGGER.info('✅ Index Bot v2 fully started!');
    }

    subscribeToCandles(symbol) {
        if (this.connection.activeSubscriptions.has(symbol)) {
            LOGGER.debug(`Already subscribed to ${symbol}`);
            return;
        }
        LOGGER.info(`📡 Subscribing to ${symbol} (${CONFIG.TIMEFRAME_LABEL})...`);

        // Load historical candles
        this.connection.send({
            ticks_history:     symbol,
            adjust_start_time: 1,
            count:             CONFIG.CANDLES_TO_LOAD,
            end:               'latest',
            start:             1,
            style:             'candles',
            granularity:       CONFIG.GRANULARITY,
        });

        // Subscribe to live OHLC stream
        this.connection.send({
            ticks_history:     symbol,
            adjust_start_time: 1,
            count:             1,
            end:               'latest',
            start:             1,
            style:             'candles',
            granularity:       CONFIG.GRANULARITY,
            subscribe:         1,
        });

        this.connection.activeSubscriptions.add(symbol);
    }

    // ════════════════════════════════════════════════════════
    // CORE TRADE EXECUTION — single entry path, all cases
    // BUG FIX: recovery no longer separate method with wrong direction logic
    // BUG FIX: trade mutex prevents race-condition double-trades
    // ════════════════════════════════════════════════════════
    executeNextTrade(symbol, lastClosedCandle) {
        const a = state.assets[symbol];
        if (!a || !a.canTrade)                                     return;
        if (!SessionManager.isSessionActive())                     return;
        if (a.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) return;
        if (!state.isConnected || !state.isAuthorized)             return;

        // BUG FIX: check global trade mutex to prevent race conditions
        if (this._tradeLocked) {
            LOGGER.debug(`[${symbol}] Trade mutex locked — skipping`);
            return;
        }

        // Cool-down guard
        if (a.cooldownCandles > 0) {
            LOGGER.debug(`[${symbol}] In cool-down (${a.cooldownCandles} candles remaining)`);
            a.canTrade = false;
            return;
        }

        // Total positions guard
        const totalPositions = CONFIG.ACTIVE_ASSETS.reduce(
            (sum, s) => sum + (state.assets[s]?.activePositions?.length ?? 0), 0
        );
        if (totalPositions >= CONFIG.MAX_TOTAL_POSITIONS) {
            LOGGER.debug(`[${symbol}] Max total positions (${totalPositions}/${CONFIG.MAX_TOTAL_POSITIONS})`);
            return;
        }

        // Session filter (optional — disabled for synthetics by default)
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

        // Capital check
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

        // ── Run 3-Layer Signal Analysis ────────────────────
        const signal = SignalAnalyzer.analyze(a.closedCandles, symbol);

        LOGGER.signal(
            `[${symbol}] L1:${signal.layer1?.atr ?? '?'}/${signal.layer1?.adx ?? '?'}/${signal.layer1?.bb ?? '?'} ` +
            `L2:ST=${signal.layer2?.supertrend ?? '?'} EMA=${signal.layer2?.ema?.split(' ')[0] ?? '?'} ` +
            `L3:${signal.score}/${signal.maxScore} | ${signal.direction ?? 'NO_TRADE'} | ${signal.reason}`
        );

        if (CONFIG.DEBUG_MODE) {
            Object.entries(signal.layer3 || {}).forEach(([k, v]) => LOGGER.debug(`${symbol} L3.${k}: ${v}`));
            if (signal.warnings.length) LOGGER.debug(`${symbol} Warnings: ${signal.warnings.join(', ')}`);
            LOGGER.regime(
                `[${symbol}] ADX:${signal.indicators?.adx} +DI:${signal.indicators?.plusDI} -DI:${signal.indicators?.minusDI} ` +
                `RSI:${signal.indicators?.rsi} ST:${signal.indicators?.stTrend}`
            );
        }

        if (!signal.shouldTrade || !signal.direction) {
            a.canTrade = false;

            // If in recovery and signal is flat — log but don't force trade
            if (a.recoveryStep > 0) {
                LOGGER.warn(`[${symbol}] Recovery step ${a.recoveryStep} but no signal — waiting for next candle`);
            }
            return;
        }

        // ── LOCK mutex and execute ─────────────────────────
        this._tradeLocked = true;
        a.canTrade = false;
        a.lastTradeDirection = signal.direction;

        const recoveryNote = a.recoveryStep > 0 ? ` [RECOVERY STEP ${a.recoveryStep}]` : '';
        LOGGER.trade(
            `🎯 [${symbol}]${recoveryNote} ${signal.direction === 'CALL' ? '📈 CALL' : '📉 PUT'} | ` +
            `Stake: $${stake.toFixed(2)} | Score: ${signal.score}/${signal.maxScore} | ADX: ${signal.indicators?.adx}`
        );
        LOGGER.trade(`   ${signal.reason}`);

        const pos = {
            symbol,
            direction:    signal.direction,
            stake,
            duration:     CONFIG.DURATION,
            durationUnit: CONFIG.DURATION_UNIT,
            entryTime:    Date.now(),
            contractId:   null,
            reqId:        null,
            currentProfit: 0,
            buyPrice:     0,
            signal:       {
                score:    signal.score,
                maxScore: signal.maxScore,
                reason:   signal.reason,
                layer1:   signal.layer1,
                layer2:   signal.layer2,
                layer3:   signal.layer3,
                warnings: signal.warnings,
            },
            indicators:   signal.indicators,
        };

        a.activePositions.push(pos);

        const reqId = this.connection.send({
            buy: 1, subscribe: 1, price: stake.toFixed(2),
            parameters: {
                contract_type: signal.direction,
                symbol,
                currency:      'USD',
                amount:        stake.toFixed(2),
                duration:      CONFIG.DURATION,
                duration_unit: CONFIG.DURATION_UNIT,
                basis:         'stake',
            },
        });

        pos.reqId = reqId;

        // Safety: release lock after 5s if buy response hasn't come
        setTimeout(() => {
            if (this._tradeLocked) {
                LOGGER.warn(`[${symbol}] Trade lock auto-released after timeout`);
                this._tradeLocked = false;
            }
        }, 5000);

        StatePersistence.saveState();
    }

    // ── WATCHDOG ──────────────────────────────────────────────
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

    // BUG FIX: also release trade mutex on force-release
    _forceReleaseTradeLock() {
        this._clearAllWatchdogTimers();
        this._tradeLocked           = false;
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
        this._tradeLocked           = false;
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
                    ? SignalAnalyzer.analyze(a.closedCandles, sym)
                    : null;
                pairStatuses[sym] = {
                    recoveryStep:    a.recoveryStep,
                    currentStake:    a.currentStake,
                    activePositions: a.activePositions.length,
                    cooldownCandles: a.cooldownCandles,
                    trades:    a.tradesCount, wins:  a.winsCount,
                    losses:    a.lossesCount, netPL: a.netPL,
                    lastDirection: a.lastTradeDirection,
                    signal: signal ? {
                        score:     signal.score,
                        direction: signal.direction,
                        reason:    signal.reason,
                    } : null,
                    indicators: signal?.indicators ?? {},
                };
            }
        });
        return {
            connected:  state.isConnected,
            authorized: state.isAuthorized,
            capital:    state.capital,
            session:    SessionManager.getSessionStats(),
            sessionInfo: TradingSessionManager.getSessionInfo(),
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

process.on('SIGINT',  () => { bot.stop(); setTimeout(() => process.exit(0), 3000); });
process.on('SIGTERM', () => { bot.stop(); setTimeout(() => process.exit(0), 3000); });
process.on('uncaughtException',  (err)    => { LOGGER.error(`UNCAUGHT: ${err.message}\n${err.stack}`); try { StatePersistence.saveState(); } catch {} });
process.on('unhandledRejection', (reason) => { LOGGER.error(`UNHANDLED: ${reason}`);                   try { StatePersistence.saveState(); } catch {} });

const stateLoaded = StatePersistence.loadState();
LOGGER.info(stateLoaded ? '🔄 Resuming from saved state' : '🆕 Starting fresh session');

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.error('\n⚠️  Set CONFIG.API_TOKEN before running!\n');
    process.exit(1);
}

console.log('\n🚀 Starting Deriv Index Bot v2...\n');
bot.connection.connect();

// ── Status display every 60s ──────────────────────────────────
const statusInterval = setInterval(() => {
    if (!state.isAuthorized) return;
    const status = bot.getStatus();

    // Safety: stuck trade > 7 minutes
    if (state.currentContractId && state.tradeStartTime) {
        const elapsed = Date.now() - state.tradeStartTime;
        if (elapsed > 420000) {
            LOGGER.error(`🚨 SAFETY: Trade stuck ${Math.round(elapsed / 1000)}s — forcing recovery`);
            bot._recoverStuckTrade('safety-timeout');
        }
    }

    // BUG FIX: release trade lock if somehow stuck (no active positions)
    if (bot._tradeLocked && status.totalPositions === 0) {
        LOGGER.warn('⚠️ Trade lock stuck with no open positions — auto-releasing');
        bot._tradeLocked = false;
    }

    let pairLines = '';
    CONFIG.ACTIVE_ASSETS.forEach(sym => {
        const p = status.pairs[sym];
        if (p) {
            const sig    = p.signal ? `Score:${p.signal.score}/${4} ${p.signal.direction ?? 'NONE'}` : 'Analyzing...';
            const adx    = p.indicators?.adx  ? `ADX:${p.indicators.adx}` : '';
            const rsi    = p.indicators?.rsi  ? `RSI:${p.indicators.rsi}` : '';
            const cdwn   = p.cooldownCandles  > 0 ? ` ❄️CD:${p.cooldownCandles}` : '';
            pairLines += `\n  ${sym}: Rec${p.recoveryStep} $${p.currentStake.toFixed(2)} | ${p.trades}t ${p.wins}W/${p.losses}L $${p.netPL.toFixed(2)} | Pos:${p.activePositions}${cdwn} | ${sig} | ${adx} ${rsi}`;
        }
    });

    console.log(`\n📊 ${getGMTTime()} | Session: ${status.session.trades}t ${status.session.winRate} $${status.session.netPL.toFixed(2)} | Capital: $${status.capital.toFixed(2)}`);
    console.log(`📋 Overall: ${status.overall.tradesCount}t | P/L: $${status.overall.netPL.toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
    console.log(`🕐 ${TradingSessionManager.getStatusString()}`);
    console.log(`📈 Assets:${pairLines}`);
}, 60000);

bot.statusDisplayIntervalId = statusInterval;
