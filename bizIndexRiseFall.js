const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// FILE PATHS
// ============================================
const STATE_FILE   = path.join(__dirname, 'IndexBot-state_07.json');
const HISTORY_FILE = path.join(__dirname, 'IndexBot-history_07.json');
const STATE_SAVE_INTERVAL = 5000;

// ============================================
// LOGGER (defined first — used everywhere)
// ============================================
const getGMTTime = () => new Date().toISOString().replace('T', ' ').split('.')[0] + ' GMT';

const LOGGER = {
    info:  msg => console.log(`[INFO]  ${getGMTTime()} - ${msg}`),
    trade: msg => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn:  msg => console.warn(`\x1b[33m[WARN]  ${getGMTTime()} - ${msg}\x1b[0m`),
    error: msg => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: msg => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); },
    signal:msg => console.log(`\x1b[36m[SIGNAL]${getGMTTime()} - ${msg}\x1b[0m`)
};

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // ── Deriv API ──────────────────────────────────────────────────
    API_TOKEN:  'hsj0tA0XJoIzJG5',
    APP_ID:     '1089',
    WS_URL:     'wss://ws.derivws.com/websockets/v3',

    // ── Capital & Risk ─────────────────────────────────────────────
    INITIAL_CAPITAL:        1000,
    STAKE:                  0.35,       // Base stake per trade (USD)
    SESSION_PROFIT_TARGET:  2500,        // Stop trading after +$500 session profit
    SESSION_STOP_LOSS:      -250,       // Stop trading after -$100 session loss

    // ── Candle / Contract Settings ─────────────────────────────────
    // 1-minute candles: best balance of signal quality vs trade frequency
    // for Deriv Index Assets
    GRANULARITY:            60,        // 5 minutes in seconds
    TIMEFRAME_LABEL:        '1m',
    CANDLES_TO_LOAD:        100,        // History for indicator warmup
    MAX_CANDLES_STORED:     200,        // Rolling window

    // 1-minute duration aligns contract expiry with candle close
    // giving the best directional accuracy for Index on Deriv
    DURATION:               58,
    DURATION_UNIT:          's',        // Minutes

    // ── Strategy Parameters ────────────────────────────────────────
    // EMA periods for trend direction
    EMA_FAST:               8,
    EMA_SLOW:               21,
    EMA_TREND:              50,         // Long-term trend filter

    // RSI for momentum confirmation
    RSI_PERIOD:             14,
    RSI_OVERBOUGHT:         65,         // Conservative (was 70) — fewer but better signals
    RSI_OVERSOLD:           35,         // Conservative (was 30)

    // Bollinger Bands for volatility/squeeze detection
    BB_PERIOD:              20,
    BB_STD_DEV:             2.0,
    BB_SQUEEZE_THRESHOLD:   0.002,      // Width/price ratio below this = squeeze

    // ATR for volatility filter (avoid trading flat markets)
    ATR_PERIOD:             14,
    // ATR_MIN_THRESHOLD:      0.0003,     // Minimum ATR to trade (30 pips for 5-digit)
    // ATR_MAX_THRESHOLD:      0.005,      // Maximum ATR (avoid extreme volatility)
    ATR_THRESHOLDS: {
        R_10:  { min: 0.2,  max: 3.0 },
        R_25:  { min: 0.5,  max: 5.0 },
        R_50:  { min: 0.02, max: 0.5 },
        R_75:  { min: 5.0,  max: 50.0 },
        R_100: { min: 0.2,  max: 2.0 },

        stpRNG:  { min: 0.5, max: 10.0 },
        stpRNG2: { min: 1.0, max: 10.0 },
        stpRNG3: { min: 1.0, max: 10.0 },
        stpRNG4: { min: 1.0, max: 10.0 },
        stpRNG5: { min: 1.0, max: 10.0 },
    },

    // MACD for additional momentum
    MACD_FAST:              12,
    MACD_SLOW:              26,
    MACD_SIGNAL:            9,

    // Minimum confluence score to enter a trade (out of 5 possible signals)
    MIN_CONFLUENCE_SCORE:   4.0,

    // ── Martingale Recovery ────────────────────────────────────────
    MARTINGALE_MULTIPLIER:  1.48,       // Covers loss + commission on standard win
    MARTINGALE_MULTIPLIER2: 1.95,
    MARTINGALE_MULTIPLIER3: 2.1,
    MAX_MARTINGALE_STEPS:   8,          

    // ── Trading Sessions (GMT) ─────────────────────────────────────
    // London: 08:00–17:00 GMT | New York: 13:00–22:00 GMT
    // Overlap 13:00–17:00 GMT = highest liquidity + tightest spreads
    USE_TRADING_SESSIONS:   true,
    SESSIONS: [
        { name: 'LONDON',   start: 7,  end: 17 },  // London session
        { name: 'NEW_YORK', start: 12, end: 23 },  // New York session
    ],
    // Only trade during session overlap for highest quality signals
    REQUIRE_SESSION_OVERLAP: false,     // Set true for overlap-only mode

    // ── Position Management ────────────────────────────────────────
    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    MAX_TOTAL_POSITIONS:          5,    // Max simultaneous trades across all pairs

    // ── Misc ───────────────────────────────────────────────────────
    DEBUG_MODE:             true,
    TELEGRAM_ENABLED:       true,
    TELEGRAM_BOT_TOKEN: '8565754902:AAHS6UQWEgLJ0DO-JTpAGQhZLs-UDVVNAQc',
    TELEGRAM_CHAT_ID: '752497117',

    // ── Active Index Assets ─────────────────────────────────────────
    // Deriv offers these as frxXXXYYY format
    // Selected for highest liquidity and binary option suitability
    ACTIVE_ASSETS: [
        // 'R_100',    // 100-index: highest volatility, most patterns
        // 'R_75',     // 75-index: very volatile
        // 'R_50',     // 50-index: balanced volatility
        // 'R_25',     // 25-index: lower volatility, cleaner signals
        // 'R_10',     // 10-index: lowest volatility, lowest noise
        'stpRNG', 
        'stpRNG2',
        'stpRNG3', 
        'stpRNG4', 
        'stpRNG5'
    ]
};

// ── Per-asset overrides (if needed) ───────────────────────────────
// JPY pairs need different pip calculations (2 decimal places vs 4/5)
const ASSET_CONFIGS = {};

function getAssetConfig(symbol) {
    const overrides = ASSET_CONFIGS[symbol] || {};
    return {
        GRANULARITY:         CONFIG.GRANULARITY,
        TIMEFRAME_LABEL:     CONFIG.TIMEFRAME_LABEL,
        MAX_CANDLES_STORED:  CONFIG.MAX_CANDLES_STORED,
        CANDLES_TO_LOAD:     CONFIG.CANDLES_TO_LOAD,
        DURATION:            CONFIG.DURATION,
        DURATION_UNIT:       CONFIG.DURATION_UNIT,
        // PIP_MULTIPLIER:      overrides.PIP_MULTIPLIER      ?? 10000,    // 4/5-digit pairs
        // ATR_MIN_THRESHOLD:   overrides.ATR_MIN_THRESHOLD   ?? CONFIG.ATR_MIN_THRESHOLD,
        // ATR_MAX_THRESHOLD:   overrides.ATR_MAX_THRESHOLD   ?? CONFIG.ATR_MAX_THRESHOLD,
    };
}

// ============================================
// TECHNICAL INDICATOR ENGINE
// ============================================
class Indicators {

    // ── Exponential Moving Average ─────────────────────────────────
    static ema(values, period) {
        if (values.length < period) return null;
        const k   = 2 / (period + 1);
        let ema   = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < values.length; i++) {
            ema = values[i] * k + ema * (1 - k);
        }
        return ema;
    }

    // Returns full EMA array (for slope calculations)
    static emaArray(values, period) {
        if (values.length < period) return [];
        const k      = 2 / (period + 1);
        const result = [];
        let ema      = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
        result.push(ema);
        for (let i = period; i < values.length; i++) {
            ema = values[i] * k + ema * (1 - k);
            result.push(ema);
        }
        return result;
    }

    // ── Simple Moving Average ──────────────────────────────────────
    static sma(values, period) {
        if (values.length < period) return null;
        const slice = values.slice(-period);
        return slice.reduce((a, b) => a + b, 0) / period;
    }

    // ── Relative Strength Index ────────────────────────────────────
    static rsi(closes, period = 14) {
        if (closes.length < period + 1) return null;
        const slice = closes.slice(-(period + 1));
        let gains   = 0;
        let losses  = 0;

        for (let i = 1; i < slice.length; i++) {
            const diff = slice[i] - slice[i - 1];
            if (diff >= 0) gains  += diff;
            else           losses += Math.abs(diff);
        }

        const avgGain = gains  / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    // Smooth RSI (Wilder's method — more accurate)
    static rsiSmoothed(closes, period = 14) {
        if (closes.length < period * 2) return null;

        // First RSI value (simple average)
        let gains  = 0;
        let losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) gains  += diff;
            else          losses += Math.abs(diff);
        }
        let avgGain = gains  / period;
        let avgLoss = losses / period;

        // Smoothed subsequent values
        for (let i = period + 1; i < closes.length; i++) {
            const diff = closes[i] - closes[i - 1];
            const gain = diff > 0 ? diff : 0;
            const loss = diff < 0 ? Math.abs(diff) : 0;
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
        }

        if (avgLoss === 0) return 100;
        return 100 - (100 / (1 + avgGain / avgLoss));
    }

    // ── Bollinger Bands ────────────────────────────────────────────
    static bollingerBands(closes, period = 20, stdDev = 2) {
        if (closes.length < period) return null;
        const slice = closes.slice(-period);
        const mid   = slice.reduce((a, b) => a + b, 0) / period;
        const variance = slice.reduce((sum, v) => sum + Math.pow(v - mid, 2), 0) / period;
        const std   = Math.sqrt(variance);
        return {
            upper:  mid + stdDev * std,
            middle: mid,
            lower:  mid - stdDev * std,
            width:  (stdDev * 2 * std) / mid,  // Normalized band width
            std
        };
    }

    // ── MACD ───────────────────────────────────────────────────────
    static macd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        if (closes.length < slowPeriod + signalPeriod) return null;

        const fastEMA   = this.emaArray(closes, fastPeriod);
        const slowEMA   = this.emaArray(closes, slowPeriod);

        // Align arrays (slow EMA is shorter due to longer period warmup)
        const offset    = slowPeriod - fastPeriod;
        const macdLine  = slowEMA.map((slow, i) => fastEMA[i + offset] - slow);

        if (macdLine.length < signalPeriod) return null;

        const signalLine    = this.emaArray(macdLine, signalPeriod);
        const lastMacd      = macdLine[macdLine.length - 1];
        const lastSignal    = signalLine[signalLine.length - 1];
        const prevMacd      = macdLine[macdLine.length - 2];
        const prevSignal    = signalLine[signalLine.length - 2] ?? lastSignal;

        return {
            macd:       lastMacd,
            signal:     lastSignal,
            histogram:  lastMacd - lastSignal,
            prevMacd,
            prevSignal,
            prevHistogram: prevMacd - prevSignal,
            // Crossover detection
            bullishCross: prevMacd <= prevSignal && lastMacd > lastSignal,
            bearishCross: prevMacd >= prevSignal && lastMacd < lastSignal
        };
    }

    // ── Average True Range ─────────────────────────────────────────
    static atr(candles, period = 14) {
        if (candles.length < period + 1) return null;
        const slice = candles.slice(-(period + 1));
        const trValues = [];

        for (let i = 1; i < slice.length; i++) {
            const high      = slice[i].high;
            const low       = slice[i].low;
            const prevClose = slice[i - 1].close;
            const tr        = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low  - prevClose)
            );
            trValues.push(tr);
        }

        return trValues.reduce((a, b) => a + b, 0) / trValues.length;
    }

    // ── Stochastic Oscillator ──────────────────────────────────────
    static stochastic(candles, kPeriod = 14, dPeriod = 3) {
        if (candles.length < kPeriod + dPeriod) return null;
        const slice   = candles.slice(-( kPeriod + dPeriod));
        const kValues = [];

        for (let i = dPeriod - 1; i < slice.length; i++) {
            const window  = slice.slice(i - kPeriod + 1, i + 1);
            const highest = Math.max(...window.map(c => c.high));
            const lowest  = Math.min(...window.map(c => c.low));
            const current = slice[i].close;
            const k       = lowest === highest ? 50 : ((current - lowest) / (highest - lowest)) * 100;
            kValues.push(k);
        }

        const d = kValues.reduce((a, b) => a + b, 0) / kValues.length;
        return {
            k:    kValues[kValues.length - 1],
            d,
            prevK: kValues[kValues.length - 2] ?? kValues[kValues.length - 1],
            overbought:  kValues[kValues.length - 1] > 80,
            oversold:    kValues[kValues.length - 1] < 20,
            bullishCross: kValues[kValues.length - 2] < d && kValues[kValues.length - 1] > d,
            bearishCross: kValues[kValues.length - 2] > d && kValues[kValues.length - 1] < d
        };
    }

    // ── Support / Resistance Levels ────────────────────────────────
    static findKeyLevels(candles, lookback = 20) {
        const slice    = candles.slice(-lookback);
        const highs    = slice.map(c => c.high);
        const lows     = slice.map(c => c.low);
        return {
            resistance: Math.max(...highs),
            support:    Math.min(...lows),
            midpoint:   (Math.max(...highs) + Math.min(...lows)) / 2
        };
    }

    // ── Candle Pattern Recognition ─────────────────────────────────
    static detectPattern(candles) {
        if (candles.length < 3) return { pattern: 'NONE', bias: 'NEUTRAL' };

        const [c2, c1, c0] = candles.slice(-3); // c0 = most recent closed
        const body0  = Math.abs(c0.close - c0.open);
        const range0 = c0.high - c0.low;
        const body1  = Math.abs(c1.close - c1.open);
        const range1 = c1.high - c1.low;

        // Doji
        if (range0 > 0 && body0 / range0 < 0.1) {
            return { pattern: 'DOJI', bias: 'NEUTRAL' };
        }

        // Bullish Engulfing
        if (c1.close < c1.open && c0.close > c0.open &&
            c0.open  < c1.close && c0.close > c1.open) {
            return { pattern: 'BULLISH_ENGULFING', bias: 'BULLISH' };
        }

        // Bearish Engulfing
        if (c1.close > c1.open && c0.close < c0.open &&
            c0.open  > c1.close && c0.close < c1.open) {
            return { pattern: 'BEARISH_ENGULFING', bias: 'BEARISH' };
        }

        // Bullish Pin Bar (hammer) — long lower wick, small body at top
        const lowerWick0 = Math.min(c0.open, c0.close) - c0.low;
        const upperWick0 = c0.high - Math.max(c0.open, c0.close);
        if (lowerWick0 > body0 * 2 && upperWick0 < body0 * 0.5) {
            return { pattern: 'HAMMER', bias: 'BULLISH' };
        }

        // Bearish Pin Bar (shooting star) — long upper wick, small body at bottom
        if (upperWick0 > body0 * 2 && lowerWick0 < body0 * 0.5) {
            return { pattern: 'SHOOTING_STAR', bias: 'BEARISH' };
        }

        // Three White Soldiers
        if (c2.close > c2.open && c1.close > c1.open && c0.close > c0.open &&
            c1.open > c2.open && c0.open > c1.open &&
            c1.close > c2.close && c0.close > c1.close) {
            return { pattern: 'THREE_WHITE_SOLDIERS', bias: 'BULLISH' };
        }

        // Three Black Crows
        if (c2.close < c2.open && c1.close < c1.open && c0.close < c0.open &&
            c1.open < c2.open && c0.open < c1.open &&
            c1.close < c2.close && c0.close < c1.close) {
            return { pattern: 'THREE_BLACK_CROWS', bias: 'BEARISH' };
        }

        // Morning Star (3-candle reversal bullish)
        const body2 = Math.abs(c2.close - c2.open);
        if (c2.close < c2.open && body1 < body2 * 0.3 && c0.close > c0.open &&
            c0.close > (c2.open + c2.close) / 2) {
            return { pattern: 'MORNING_STAR', bias: 'BULLISH' };
        }

        // Evening Star (3-candle reversal bearish)
        if (c2.close > c2.open && body1 < body2 * 0.3 && c0.close < c0.open &&
            c0.close < (c2.open + c2.close) / 2) {
            return { pattern: 'EVENING_STAR', bias: 'BEARISH' };
        }

        // Strong bullish/bearish candle (momentum)
        if (c0.close > c0.open && body0 / range0 > 0.7) {
            return { pattern: 'STRONG_BULLISH', bias: 'BULLISH' };
        }
        if (c0.close < c0.open && body0 / range0 > 0.7) {
            return { pattern: 'STRONG_BEARISH', bias: 'BEARISH' };
        }

        return {
            pattern: c0.close > c0.open ? 'BULLISH_CANDLE' : 'BEARISH_CANDLE',
            bias:    c0.close > c0.open ? 'BULLISH' : 'BEARISH'
        };
    }
}

// ============================================
// CANDLE ANALYSIS UTILITY
// ============================================
class CandleAnalyzer {
    static isBullish(candle)  { return candle.close > candle.open; }
    static isBearish(candle)  { return candle.close < candle.open; }

    static getLastClosedCandle(symbol) {
        const assetState = state.assets[symbol];
        if (!assetState?.closedCandles?.length) return null;
        return assetState.closedCandles[assetState.closedCandles.length - 1];
    }

    static getCandleDirection(candle) {
        if (this.isBullish(candle)) return 'BULLISH';
        if (this.isBearish(candle)) return 'BEARISH';
        return 'DOJI';
    }
}

// ============================================
// SIGNAL ANALYZER
// ============================================
/**
 * Core strategy: Multi-factor confluence.
 * Each factor votes +1 (bullish), -1 (bearish), or 0 (neutral).
 * Trade fires when |score| >= MIN_CONFLUENCE_SCORE AND all votes agree in direction.
 *
 * Factors:
 *   1. EMA Trend         — 8 EMA > 21 EMA > 50 EMA = bullish trend
 *   2. RSI Momentum      — RSI 40-65 rising = bullish; RSI 35-60 falling = bearish
 *   3. MACD              — Histogram positive and rising OR bullish crossover
 *   4. Bollinger Bands   — Price above middle band + not at upper band
 *   5. Candle Pattern    — Bullish/bearish pattern confirmation
 *   6. Stochastic        — K line direction and level
 *   7. ATR Filter        — Volatility within acceptable range (gate, not score)
 */
class SignalAnalyzer {

    static analyze(candles, symbol) {
        const assetCfg = getAssetConfig(symbol);
        const result   = {
            direction:       null,   // 'CALLE', 'PUTE', or null
            score:           0,
            maxScore:        6,
            signals:         {},
            indicators:      {},
            shouldTrade:     false,
            reason:          '',
            warnings:        []
        };

        if (!candles || candles.length < CONFIG.CANDLES_TO_LOAD * 0.6) {
            result.reason = 'Insufficient candle history';
            return result;
        }

        const closes  = candles.map(c => c.close);
        const highs   = candles.map(c => c.high);
        const lows    = candles.map(c => c.low);
        const lastClose = closes[closes.length - 1];
        const prevClose = closes[closes.length - 2];

        // ── Compute all indicators ─────────────────────────────────
        const emaFast   = Indicators.ema(closes, CONFIG.EMA_FAST);
        const emaSlow   = Indicators.ema(closes, CONFIG.EMA_SLOW);
        const emaTrend  = Indicators.ema(closes, CONFIG.EMA_TREND);

        // EMA arrays for slope
        const emaFastArr  = Indicators.emaArray(closes, CONFIG.EMA_FAST);
        const emaSlowArr  = Indicators.emaArray(closes, CONFIG.EMA_SLOW);

        const rsi       = Indicators.rsiSmoothed(closes, CONFIG.RSI_PERIOD);
        const bb        = Indicators.bollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_STD_DEV);
        const macd      = Indicators.macd(closes, CONFIG.MACD_FAST, CONFIG.MACD_SLOW, CONFIG.MACD_SIGNAL);
        const atr       = Indicators.atr(candles, CONFIG.ATR_PERIOD);
        const stoch     = Indicators.stochastic(candles, 14, 3);
        const pattern   = Indicators.detectPattern(candles);
        const keyLevels = Indicators.findKeyLevels(candles, 20);

        // Store indicators for display
        result.indicators = {
            emaFast:  emaFast?.toFixed(5),
            emaSlow:  emaSlow?.toFixed(5),
            emaTrend: emaTrend?.toFixed(5),
            rsi:      rsi?.toFixed(2),
            bbWidth:  bb?.width?.toFixed(4),
            bbMiddle: bb?.middle?.toFixed(5),
            macd:     macd?.macd?.toFixed(5),
            macdHist: macd?.histogram?.toFixed(5),
            atr:      atr?.toFixed(5),
            stochK:   stoch?.k?.toFixed(2),
            stochD:   stoch?.d?.toFixed(2),
            pattern:  pattern.pattern,
            support:  keyLevels.support?.toFixed(5),
            resistance: keyLevels.resistance?.toFixed(5),
            lastClose: lastClose?.toFixed(5)
        };

        // ── Gate: ATR Volatility Filter (hard gate, not a score) ──
        if (atr !== null) {
            const atrConfig = CONFIG.ATR_THRESHOLDS[symbol];

            if (atrConfig) {

                if (atr < atrConfig.min) {
                    result.reason =
                        `ATR too low (${atr.toFixed(5)} < ${atrConfig.min})`;

                    result.warnings.push('LOW_VOLATILITY');
                    return result;
                }

                if (atr > atrConfig.max) {
                    result.reason =
                        `ATR too high (${atr.toFixed(5)} > ${atrConfig.max})`;

                    result.warnings.push('EXTREME_VOLATILITY');
                    return result;
                }
            }
        }

        // ── Gate: Bollinger Band Squeeze filter ───────────────────
        if (bb && bb.width < CONFIG.BB_SQUEEZE_THRESHOLD) {
            result.reason   = `BB squeeze (width: ${bb.width.toFixed(4)}) — waiting for breakout`;
            result.warnings.push('BB_SQUEEZE');
            return result;
        }

        // ── Signal scoring ─────────────────────────────────────────
        let bullScore = 0;
        let bearScore = 0;
        const signals = {};

        // ── 1. EMA Trend Alignment ─────────────────────────────────
        if (emaFast !== null && emaSlow !== null && emaTrend !== null) {
            const emaFastSlope = emaFastArr.length >= 3
                ? emaFastArr[emaFastArr.length - 1] - emaFastArr[emaFastArr.length - 3]
                : 0;
            const emaSlowSlope = emaSlowArr.length >= 3
                ? emaSlowArr[emaSlowArr.length - 1] - emaSlowArr[emaSlowArr.length - 3]
                : 0;

            if (emaFast > emaSlow && emaSlow > emaTrend && emaFastSlope > 0) {
                bullScore++;
                signals.emaTrend = 'BULLISH (8>21>50, rising)';
            } else if (emaFast < emaSlow && emaSlow < emaTrend && emaFastSlope < 0) {
                bearScore++;
                signals.emaTrend = 'BEARISH (8<21<50, falling)';
            } else if (emaFast > emaSlow) {
                bullScore += 0.5;
                signals.emaTrend = 'MILD_BULLISH (8>21 only)';
            } else if (emaFast < emaSlow) {
                bearScore += 0.5;
                signals.emaTrend = 'MILD_BEARISH (8<21 only)';
            } else {
                signals.emaTrend = 'NEUTRAL';
            }
        }

        // ── 2. RSI Momentum ───────────────────────────────────────
        if (rsi !== null) {
            const prevRsi = Indicators.rsiSmoothed(closes.slice(0, -1), CONFIG.RSI_PERIOD);
            const rsiSlope = prevRsi ? rsi - prevRsi : 0;

            if (rsi > 50 && rsi < CONFIG.RSI_OVERBOUGHT && rsiSlope > 0) {
                bullScore++;
                signals.rsi = `BULLISH (RSI: ${rsi.toFixed(1)}, rising)`;
            } else if (rsi < 50 && rsi > CONFIG.RSI_OVERSOLD && rsiSlope < 0) {
                bearScore++;
                signals.rsi = `BEARISH (RSI: ${rsi.toFixed(1)}, falling)`;
            } else if (rsi >= CONFIG.RSI_OVERBOUGHT) {
                bearScore += 0.5;
                signals.rsi = `OVERBOUGHT (RSI: ${rsi.toFixed(1)}) — bearish bias`;
                result.warnings.push('RSI_OVERBOUGHT');
            } else if (rsi <= CONFIG.RSI_OVERSOLD) {
                bullScore += 0.5;
                signals.rsi = `OVERSOLD (RSI: ${rsi.toFixed(1)}) — bullish bias`;
                result.warnings.push('RSI_OVERSOLD');
            } else {
                signals.rsi = `NEUTRAL (RSI: ${rsi.toFixed(1)})`;
            }
        }

        // ── 3. MACD ───────────────────────────────────────────────
        if (macd !== null) {
            if (macd.bullishCross || (macd.histogram > 0 && macd.histogram > macd.prevHistogram)) {
                bullScore++;
                signals.macd = macd.bullishCross
                    ? 'BULLISH CROSS'
                    : `BULLISH histogram rising (${macd.histogram.toFixed(5)})`;
            } else if (macd.bearishCross || (macd.histogram < 0 && macd.histogram < macd.prevHistogram)) {
                bearScore++;
                signals.macd = macd.bearishCross
                    ? 'BEARISH CROSS'
                    : `BEARISH histogram falling (${macd.histogram.toFixed(5)})`;
            } else {
                signals.macd = 'NEUTRAL';
            }
        }

        // ── 4. Bollinger Bands Position ───────────────────────────
        if (bb !== null) {
            const priceRelBand = (lastClose - bb.lower) / (bb.upper - bb.lower);

            if (lastClose > bb.middle && priceRelBand < 0.85) {
                // Price above midline but not overextended
                bullScore++;
                signals.bb = `BULLISH (price ${(priceRelBand * 100).toFixed(0)}% up band)`;
            } else if (lastClose < bb.middle && priceRelBand > 0.15) {
                // Price below midline but not overextended down
                bearScore++;
                signals.bb = `BEARISH (price ${(priceRelBand * 100).toFixed(0)}% up band)`;
            } else if (priceRelBand >= 0.85) {
                bearScore += 0.5;
                signals.bb = `NEAR UPPER BAND — bearish reversal risk`;
                result.warnings.push('NEAR_UPPER_BB');
            } else if (priceRelBand <= 0.15) {
                bullScore += 0.5;
                signals.bb = `NEAR LOWER BAND — bullish reversal potential`;
                result.warnings.push('NEAR_LOWER_BB');
            } else {
                signals.bb = 'NEUTRAL';
            }
        }

        // ── 5. Candle Pattern ─────────────────────────────────────
        if (pattern.bias === 'BULLISH') {
            bullScore++;
            signals.pattern = `BULLISH PATTERN: ${pattern.pattern}`;
        } else if (pattern.bias === 'BEARISH') {
            bearScore++;
            signals.pattern = `BEARISH PATTERN: ${pattern.pattern}`;
        } else {
            signals.pattern = `NEUTRAL: ${pattern.pattern}`;
        }

        // ── 6. Stochastic Oscillator ──────────────────────────────
        if (stoch !== null) {
            if (stoch.k > 50 && !stoch.overbought && stoch.k > stoch.prevK) {
                bullScore++;
                signals.stoch = `BULLISH (K: ${stoch.k.toFixed(1)}, rising)`;
            } else if (stoch.k < 50 && !stoch.oversold && stoch.k < stoch.prevK) {
                bearScore++;
                signals.stoch = `BEARISH (K: ${stoch.k.toFixed(1)}, falling)`;
            } else if (stoch.oversold && stoch.bullishCross) {
                bullScore++;
                signals.stoch = `OVERSOLD BULLISH CROSS (K: ${stoch.k.toFixed(1)})`;
            } else if (stoch.overbought && stoch.bearishCross) {
                bearScore++;
                signals.stoch = `OVERBOUGHT BEARISH CROSS (K: ${stoch.k.toFixed(1)})`;
            } else {
                signals.stoch = `NEUTRAL (K: ${stoch.k.toFixed(1)})`;
            }
        }

        // ── Determine final direction ──────────────────────────────
        result.signals    = signals;
        const netScore    = bullScore - bearScore;
        result.score      = Math.abs(netScore);
        result.bullScore  = bullScore;
        result.bearScore  = bearScore;

        // All signals must broadly agree — no opposing full-point signals
        const signalConflict = bullScore > 0 && bearScore > 0 &&
                               Math.min(bullScore, bearScore) >= 1.5;

        if (signalConflict) {
            result.reason = `Conflicting signals (bull: ${bullScore}, bear: ${bearScore}) — no trade`;
            result.warnings.push('SIGNAL_CONFLICT');
            return result;
        }

        if (result.score >= CONFIG.MIN_CONFLUENCE_SCORE) {
            if (netScore > 0) {
                result.direction  = 'CALLE';
                result.shouldTrade = true;
                result.reason     = `CALL: ${bullScore.toFixed(1)}/${result.maxScore} bullish signals`;
            } else if (netScore < 0) {
                result.direction  = 'PUTE';
                result.shouldTrade = true;
                result.reason     = `PUT: ${bearScore.toFixed(1)}/${result.maxScore} bearish signals`;
            }
        } else {
            result.reason = `Insufficient confluence: score ${result.score.toFixed(1)} < ${CONFIG.MIN_CONFLUENCE_SCORE} required`;
        }

        return result;
    }
}

// ============================================
// TRADING SESSION MANAGER
// ============================================
class TradingSessionManager {
    static getCurrentGMTHour() {
        return new Date().getUTCHours();
    }

    static isWithinAnySession() {
        const hour = this.getCurrentGMTHour();
        for (const session of CONFIG.SESSIONS) {
            if (this._inSession(hour, session.start, session.end)) {
                return { inSession: true, sessionName: session.name };
            }
        }
        return { inSession: false, sessionName: null };
    }

    static isInOverlap() {
        const hour   = this.getCurrentGMTHour();
        const london = CONFIG.SESSIONS.find(s => s.name === 'LONDON');
        const ny     = CONFIG.SESSIONS.find(s => s.name === 'NEW_YORK');
        if (!london || !ny) return false;
        return this._inSession(hour, london.start, london.end) &&
               this._inSession(hour, ny.start, ny.end);
    }

    static _inSession(hour, start, end) {
        if (end < start) return hour >= start || hour < end; // Overnight
        return hour >= start && hour < end;
    }

    static getSessionInfo() {
        const hour       = this.getCurrentGMTHour();
        const active     = CONFIG.SESSIONS.filter(s => this._inSession(hour, s.start, s.end));
        const inOverlap  = this.isInOverlap();
        const nextStart  = this._getNextSessionStart(hour);

        return {
            activeSessions: active.map(s => s.name),
            inSession:      active.length > 0,
            inOverlap,
            nextSession:    nextStart,
            gmtHour:        hour
        };
    }

    static _getNextSessionStart(currentHour) {
        const sorted = [...CONFIG.SESSIONS].sort((a, b) => a.start - b.start);
        const next   = sorted.find(s => s.start > currentHour);
        return next ? `${next.name} at ${next.start}:00 GMT` : `${sorted[0].name} at ${sorted[0].start}:00 GMT`;
    }

    static getStatusString() {
        const info = this.getSessionInfo();
        const time = `${String(new Date().getUTCHours()).padStart(2,'0')}:${String(new Date().getUTCMinutes()).padStart(2,'0')} GMT`;
        if (!info.inSession) return `🔴 OUTSIDE SESSIONS (${time}) — Next: ${info.nextSession}`;
        const overlap = info.inOverlap ? ' 🔥 OVERLAP' : '';
        return `🟢 ${info.activeSessions.join('+')} SESSION${overlap} (${time})`;
    }
}

// ============================================
// TRADE HISTORY MANAGER
// ============================================
class TradeHistoryManager {
    static getDateKey() { return new Date().toISOString().split('T')[0]; }

    static loadHistory() {
        try {
            if (!fs.existsSync(HISTORY_FILE)) return this._emptyHistory();
            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            if (!data.dailyHistory)  data.dailyHistory  = {};
            if (!data.overallAssets) data.overallAssets = {};
            if (!data.overall)       data.overall       = this._emptyOverall();
            LOGGER.info(`📁 History loaded — ${Object.keys(data.dailyHistory).length} days`);
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
            x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
            firstTradeDate: null, lastTradeDate: null
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
                date: dateKey,
                tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0,
                x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
                assets: {}, startCapital: state.capital, endCapital: state.capital
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

    static recordTrade(symbol, profit, martingaleLevel) {
        const dateKey       = this.getDateKey();
        this.ensureAssetDayEntry(dateKey, symbol);
        this.ensureOverallAssetEntry(symbol);

        const targets = [
            tradeHistory.dailyHistory[dateKey],
            tradeHistory.dailyHistory[dateKey].assets[symbol],
            tradeHistory.overall,
            tradeHistory.overallAssets[symbol]
        ];

        targets.forEach(t => {
            t.tradesCount++;
            if (profit > 0) { t.winsCount++;  t.profit += profit;          t.netPL += profit; }
            else            { t.lossesCount++; t.loss   += Math.abs(profit); t.netPL += profit; }
        });

        if (profit <= 0 && martingaleLevel >= 2 && martingaleLevel <= 5) {
            const key = `x${martingaleLevel}Losses`;
            targets.forEach(t => { if (t[key] !== undefined) t[key]++; });
        }

        if (!tradeHistory.overall.firstTradeDate) tradeHistory.overall.firstTradeDate = dateKey;
        tradeHistory.overall.lastTradeDate = dateKey;

        tradeHistory.dailyHistory[dateKey].endCapital = state.capital;
        tradeHistory.lastUpdated = Date.now();
        this.saveHistory();
    }

    static getTodayStats()    { const d = this.getDateKey(); this.ensureDayEntry(d); return tradeHistory.dailyHistory[d]; }
    static getOverallStats()  { return tradeHistory.overall; }
    static getAllDays()        { return Object.keys(tradeHistory.dailyHistory).sort(); }
    static getRecentDays(n=7) {
        return this.getAllDays().slice(-n).map(d => ({ date: d, ...tradeHistory.dailyHistory[d] }));
    }
}

// ============================================
// STATE PERSISTENCE
// ============================================
class StatePersistence {
    static saveState() {
        try {
            const data = {
                savedAt:     Date.now(),
                capital:     state.capital,
                session:     { ...state.session },
                portfolio:   { ...state.portfolio },
                hourlyStats: { ...state.hourlyStats },
                currentTradeDay: state.currentTradeDay,
                assets: {}
            };

            Object.keys(state.assets).forEach(symbol => {
                const a = state.assets[symbol];
                data.assets[symbol] = {
                    closedCandles:               a.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED),
                    lastProcessedCandleOpenTime: a.lastProcessedCandleOpenTime,
                    candlesLoaded:               a.candlesLoaded,
                    lastTradeDirection:          a.lastTradeDirection,
                    lastTradeWasWin:             a.lastTradeWasWin,
                    martingaleLevel:             a.martingaleLevel,
                    currentStake:                a.currentStake,
                    consecutiveWins:             a.consecutiveWins,
                    consecutiveLosses:           a.consecutiveLosses,
                    tradesCount: a.tradesCount, winsCount:  a.winsCount,
                    lossesCount: a.lossesCount, netPL:      a.netPL,
                    profit: a.profit, loss: a.loss,
                    activePositions: a.activePositions.map(p => ({ ...p }))
                };
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
        } catch (e) { LOGGER.error(`Save state error: ${e.message}`); }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) return false;
            const data        = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMins     = (Date.now() - data.savedAt) / 60000;

            if (ageMins > 30) {
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
                        a.candlesLoaded               = false; // Force reload on reconnect
                        a.lastTradeDirection          = saved.lastTradeDirection || null;
                        a.lastTradeWasWin             = saved.lastTradeWasWin    ?? null;
                        a.martingaleLevel             = saved.martingaleLevel    || 0;
                        a.currentStake                = saved.currentStake       || CONFIG.STAKE;
                        a.consecutiveWins             = saved.consecutiveWins    || 0;
                        a.consecutiveLosses           = saved.consecutiveLosses  || 0;
                        a.tradesCount = saved.tradesCount || 0;
                        a.winsCount   = saved.winsCount   || 0;
                        a.lossesCount = saved.lossesCount || 0;
                        a.netPL       = saved.netPL       || 0;
                        a.profit      = saved.profit      || 0;
                        a.loss        = saved.loss        || 0;
                        a.activePositions = (saved.activePositions || []).map(p => ({ ...p }));
                        LOGGER.info(`📊 ${symbol}: Mart=${a.martingaleLevel}, Stake=$${a.currentStake.toFixed(2)}, P/L=$${a.netPL.toFixed(2)}`);
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

// ============================================
// TELEGRAM SERVICE
// ============================================
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
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
                }, res => {
                    res.resume();
                    res.on('end', () => resolve());
                });
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
        const session = TradingSessionManager.getSessionInfo();
        const ind     = details.indicators || {};

        const lines = [
            `${emoji} <b>INDEX BOT ${type}</b>`,
            `Pair: <b>${symbol}</b>  Direction: <b>${direction === 'CALLE' ? '📈 CALL' : '📉 PUT'}</b>`,
            `Stake: $${stake.toFixed(2)} | Duration: ${duration}${durationUnit.toUpperCase()}`,
            `Martingale: ${a?.martingaleLevel ?? 0} | Session: ${session.activeSessions.join('+')}`,
            ``
        ];

        if (type === 'OPEN' && details.signal) {
            lines.push(`📊 <b>Signal Analysis:</b>`);
            lines.push(`Score: ${details.signal.score?.toFixed(1)}/${details.signal.maxScore}`);
            lines.push(`Reason: ${details.signal.reason}`);
            if (ind.rsi)      lines.push(`RSI: ${ind.rsi} | MACD Hist: ${ind.macdHist}`);
            if (ind.emaFast)  lines.push(`EMA 8/21/50: ${ind.emaFast}/${ind.emaSlow}/${ind.emaTrend}`);
            if (ind.pattern)  lines.push(`Pattern: ${ind.pattern}`);
            if (ind.stochK)   lines.push(`Stoch K/D: ${ind.stochK}/${ind.stochD}`);
        }

        if (details.profit !== undefined) {
            const pl   = details.profit;
            lines.push(`Profit: ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}`);
            lines.push(``);
            lines.push(`📋 <b>${symbol} Stats:</b>`);
            lines.push(`W/L: ${a?.winsCount ?? 0}/${a?.lossesCount ?? 0} | P/L: $${(a?.netPL ?? 0).toFixed(2)}`);
            lines.push(``);
            lines.push(`📋 <b>Today:</b>`);
            lines.push(`Trades: ${today.tradesCount} | W/L: ${today.winsCount}/${today.lossesCount}`);
            lines.push(`P/L: $${(today.netPL || 0).toFixed(2)} | Capital: $${state.capital.toFixed(2)}`);
            lines.push(``);
            lines.push(`📋 <b>Overall:</b>`);
            lines.push(`Trades: ${overall.tradesCount} | W/L: ${overall.winsCount}/${overall.lossesCount}`);
            lines.push(`P/L: $${(overall.netPL || 0).toFixed(2)}`);
        }

        await this.sendMessage(lines.join('\n'));
    }

    static async sendHourlySummary() {
        const h = state.hourlyStats;
        if (h.trades === 0) return;

        const wr    = h.trades > 0 ? ((h.wins / h.trades) * 100).toFixed(1) : '0.0';
        const today = TradeHistoryManager.getTodayStats();
        const sess  = TradingSessionManager.getStatusString();

        let assetInfo = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a?.tradesCount > 0) {
                const signal = SignalAnalyzer.analyze(a.closedCandles, sym);
                assetInfo += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L $${a.netPL.toFixed(2)} M${a.martingaleLevel} Score:${signal.score.toFixed(1)}`;
            }
        });

        const msg = [
            `⏰ <b>Index Bot Hourly</b>`,
            `Last Hour: ${h.trades}t ${h.wins}W/${h.losses}L ${wr}% ${h.pnl >= 0 ? '🟢' : '🔴'} $${h.pnl.toFixed(2)}`,
            `Today: ${today.tradesCount}t P/L: $${(today.netPL || 0).toFixed(2)}`,
            `Capital: $${state.capital.toFixed(2)}`,
            `${sess}`,
            assetInfo ? `\n<b>Per-Pair:</b>${assetInfo}` : ''
        ].join('\n');

        await this.sendMessage(msg);
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };
    }

    static async sendSessionSummary() {
        const stats   = SessionManager.getSessionStats();
        const today   = TradeHistoryManager.getTodayStats();
        const overall = TradeHistoryManager.getOverallStats();
        const wr      = overall.tradesCount > 0 ? ((overall.winsCount / overall.tradesCount) * 100).toFixed(1) : '0.0';

        let pairBreakdown = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a?.tradesCount > 0) {
                const pairWr = ((a.winsCount / a.tradesCount) * 100).toFixed(1);
                pairBreakdown += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L (${pairWr}%) $${a.netPL.toFixed(2)}`;
            }
        });

        await this.sendMessage([
            `📊 <b>INDEX BOT SESSION SUMMARY</b>`,
            `Duration: ${stats.duration} | Trades: ${stats.trades}`,
            `Wins: ${stats.wins} | Losses: ${stats.losses} | Win Rate: ${stats.winRate}`,
            `Session P/L: $${stats.netPL.toFixed(2)}`,
            `Today P/L: $${(today.netPL || 0).toFixed(2)}`,
            ``,
            `📋 <b>Overall:</b>`,
            `Trades: ${overall.tradesCount} | Win Rate: ${wr}%`,
            `P/L: $${(overall.netPL || 0).toFixed(2)}`,
            pairBreakdown ? `\n<b>Per-Pair:</b>${pairBreakdown}` : '',
            ``,
            `💰 Capital: $${state.capital.toFixed(2)}`
        ].join('\n'));
    }

    static async sendStartupMessage() {
        const overall = TradeHistoryManager.getOverallStats();
        const sess    = TradingSessionManager.getStatusString();

        let pairInfo = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const cfg = getAssetConfig(sym);
            pairInfo += `\n  ${sym}: ${CONFIG.TIMEFRAME_LABEL} | ${cfg.DURATION}${cfg.DURATION_UNIT} duration`;
        });

        await this.sendMessage([
            `🤖 <b>DERIV INDEX BOT STARTED</b>`,
            `Strategy: EMA+RSI+MACD+BB+Stoch+Pattern (${CONFIG.MIN_CONFLUENCE_SCORE}/${6} confluence)`,
            `Timeframe: ${CONFIG.TIMEFRAME_LABEL} | Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT}`,
            `Capital: $${state.capital.toFixed(2)} | Base Stake: $${CONFIG.STAKE}`,
            `Session Trading: ${CONFIG.USE_TRADING_SESSIONS ? 'ENABLED' : 'DISABLED'}`,
            sess,
            ``,
            `📊 Overall: ${overall.tradesCount} trades | P/L: $${(overall.netPL || 0).toFixed(2)}`,
            `<b>Active Pairs:</b>${pairInfo}`
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
        if (this.hourlyTimerId)  { clearInterval(this.hourlyTimerId);  this.hourlyTimerId  = null; this.hourlyTimerStarted = false; }
        if (this.dailyTimerId)   { clearInterval(this.dailyTimerId);   this.dailyTimerId   = null; this.dailyTimerStarted = false; }
    }
}

// ============================================
// SESSION MANAGER
// ============================================
class SessionManager {
    static isSessionActive() { return state.session.isActive; }

    static checkSessionTargets() {
        const { netPL } = state.session;
        if (netPL >= CONFIG.SESSION_PROFIT_TARGET) {
            LOGGER.trade(`🎯 Profit target reached: $${netPL.toFixed(2)}`);
            this.endSession('PROFIT_TARGET');
            return true;
        }
        if (netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.error(`🛑 Stop loss reached: $${netPL.toFixed(2)}`);
            this.endSession('STOP_LOSS');
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
            netPL:    state.session.netPL
        };
    }

    static checkDayChange() {
        const today = TradeHistoryManager.getDateKey();
        if (state.currentTradeDay && state.currentTradeDay !== today) {
            LOGGER.info(`🗓️ Day changed: ${state.currentTradeDay} → ${today}`);
            TelegramService.sendMessage(`🌙 <b>END OF DAY</b> ${state.currentTradeDay}\nP/L: $${(TradeHistoryManager.getDayStats(state.currentTradeDay)?.netPL || 0).toFixed(2)}`);
            this._resetDailyStats();
        }
        state.currentTradeDay = today;
    }

    static _resetDailyStats() {
        const s    = state.session;
        s.tradesCount = 0; s.winsCount = 0; s.lossesCount = 0;
        s.profit = 0; s.loss = 0; s.netPL = 0;
        s.startTime    = Date.now();
        s.startCapital = state.capital;
        state.portfolio = { dailyProfit: 0, dailyLoss: 0, dailyWins: 0, dailyLosses: 0 };
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };

        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                a.tradesCount = 0; a.winsCount = 0; a.lossesCount = 0;
                a.profit = 0; a.loss = 0; a.netPL = 0;
                // Preserve: martingaleLevel, currentStake
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
            a.profit  += profit;
            a.netPL   += profit;
            a.consecutiveWins++;
            a.consecutiveLosses = 0;
            a.martingaleLevel   = 0;
            a.currentStake      = CONFIG.STAKE;
            a.lastTradeWasWin   = true;

            LOGGER.trade(`✅ [${symbol}] WIN +$${profit.toFixed(2)} | ${direction} | P/L: $${a.netPL.toFixed(2)}`);

        } else {
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
            a.martingaleLevel++;

            // Apply multiplier based on level
            if (a.martingaleLevel === 1)      a.currentStake = Math.ceil(a.currentStake * CONFIG.MARTINGALE_MULTIPLIER  * 100) / 100;
            else if (a.martingaleLevel === 2) a.currentStake = Math.ceil(a.currentStake * CONFIG.MARTINGALE_MULTIPLIER2 * 100) / 100;
            else if (a.martingaleLevel >= 3)  a.currentStake = Math.ceil(a.currentStake * CONFIG.MARTINGALE_MULTIPLIER3 * 100) / 100;

            if (a.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS) {
                LOGGER.warn(`⚠️ [${symbol}] Max martingale (${CONFIG.MAX_MARTINGALE_STEPS}) — resetting`);
                a.martingaleLevel = 0;
                a.currentStake    = CONFIG.STAKE;
            }

            LOGGER.trade(`❌ [${symbol}] LOSS -$${Math.abs(profit).toFixed(2)} | ${direction} | Mart: ${a.martingaleLevel} | Next Stake: $${a.currentStake.toFixed(2)}`);
        }

        TradeHistoryManager.recordTrade(symbol, profit, a.martingaleLevel);
    }
}

// ============================================
// STATE
// ============================================
const state = {
    assets:         {},
    capital:        CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    currentTradeDay: null,
    session: {
        profit: 0, loss: 0, netPL: 0,
        tradesCount: 0, winsCount: 0, lossesCount: 0,
        isActive: true, startTime: Date.now(), startCapital: CONFIG.INITIAL_CAPITAL
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

// ============================================
// CONNECTION MANAGER
// ============================================
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
        this.ws.on('open',    ()     => this.onOpen());
        this.ws.on('message', data  => this.onMessage(data));
        this.ws.on('error',   err   => this.onError(err));
        this.ws.on('close',   ()    => this.onClose());
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
                    martingaleLevel:             0,
                    currentStake:                CONFIG.STAKE,
                    canTrade:                    false,
                    consecutiveWins:             0,
                    consecutiveLosses:           0,
                    activePositions:             [],
                    tradesCount: 0, winsCount: 0, lossesCount: 0,
                    profit: 0, loss: 0, netPL: 0
                };
                LOGGER.info(`📊 Initialized: ${symbol}`);
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
            case 'authorize':              this.handleAuthorize(r);       break;
            case 'balance':                state.accountBalance = r.balance.balance; break;
            case 'ohlc':                   this.handleOHLC(r.ohlc);       break;
            case 'candles':                this.handleCandlesHistory(r);  break;
            case 'buy':                    this.handleBuyResponse(r);     break;
            case 'proposal_open_contract': this.handleOpenContract(r);    break;
            case 'ping':                   break;
            default: break;
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
        LOGGER.trade(`📋 Contract opened: ${contract.contract_id} | Buy: $${contract.buy_price}`);

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
                    TelegramService.sendTradeAlert('OPEN', pos.symbol, pos.direction, pos.stake, pos.duration, pos.durationUnit, { signal: pos.signal, indicators: pos.indicators });
                    break;
                }
            }
        }

        this.send({ proposal_open_contract: 1, contract_id: contract.contract_id, subscribe: 1 });
    }

    handleOpenContract(r) {
        if (r.error) { LOGGER.error(`Contract error: ${r.error.message}`); if (bot) bot._forceReleaseTradeLock(); return; }

        const contract      = r.proposal_open_contract;
        const contractId    = contract.contract_id;
        const contractIdStr = String(contractId);

        if (r.subscription?.id) this._subscriptionIds.set(contractIdStr, r.subscription.id);

        if (bot._processedContracts.has(contractIdStr)) {
            if (r.subscription?.id) this.send({ forget: r.subscription.id });
            return;
        }

        // Live update only
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

        // Race condition retry
        if (posIdx < 0 || !ownerSym) {
            LOGGER.warn(`Contract ${contractId} settled but not found — retrying in 500ms`);
            setTimeout(() => this.handleOpenContract(r), 500);
            return;
        }

        // Mark processed
        bot._processedContracts.add(contractIdStr);
        bot._clearAllWatchdogTimers();

        const a      = state.assets[ownerSym];
        const pos    = a.activePositions[posIdx];
        const profit = contract.profit;

        SessionManager.recordTradeResult(ownerSym, profit, pos.direction);
        TelegramService.sendTradeAlert(
            profit >= 0 ? 'WIN' : 'LOSS',
            ownerSym, pos.direction, pos.stake, pos.duration, pos.durationUnit,
            { profit }
        );

        a.activePositions.splice(posIdx, 1);
        state.currentContractId = null;
        state.tradeStartTime    = null;
        state.pendingTradeInfo  = null;

        if (r.subscription?.id) this.send({ forget: r.subscription.id });

        SessionManager.checkSessionTargets();
        StatePersistence.saveState();

        // if (profit < 0 && SessionManager.isSessionActive()) {
        //     LOGGER.trade(`🔄 [${ownerSym}] Loss confirmed — scheduling immediate recovery trade in ${500}ms`);
        //     setTimeout(() => {
        //         bot.executeRecoveryTrade(ownerSym);
        //     }, 500);
        // }
    }

    handleOHLC(ohlc) {
        const symbol     = ohlc.symbol;
        const a          = state.assets[symbol];
        if (!a) return;

        const cfg        = getAssetConfig(symbol);
        const gran       = cfg.GRANULARITY;
        const openTime   = ohlc.open_time || Math.floor(ohlc.epoch / gran) * gran;

        const incoming   = {
            open:      parseFloat(ohlc.open),
            high:      parseFloat(ohlc.high),
            low:       parseFloat(ohlc.low),
            close:     parseFloat(ohlc.close),
            epoch:     ohlc.epoch,
            open_time: openTime
        };

        if ([incoming.open, incoming.high, incoming.low, incoming.close].some(isNaN)) {
            LOGGER.error(`[${symbol}] Invalid OHLC`);
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

                    if (a.closedCandles.length > cfg.MAX_CANDLES_STORED) {
                        a.closedCandles = a.closedCandles.slice(-cfg.MAX_CANDLES_STORED);
                    }

                    const dir   = closed.close > closed.open ? '🟢' : '🔴';
                    const time  = new Date(closed.epoch * 1000).toISOString();
                    LOGGER.info(`${dir} [${symbol}] CANDLE CLOSED [${time}] O:${closed.open.toFixed(5)} H:${closed.high.toFixed(5)} L:${closed.low.toFixed(5)} C:${closed.close.toFixed(5)} | Candles: ${a.closedCandles.length}`);

                    a.canTrade = true;

                    try {
                        if (a.martingaleLevel === 1 || a.martingaleLevel === 3 || a.martingaleLevel === 5) {
                            bot.executeRecoveryTrade(symbol, closed);
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

        a.currentFormingCandle = incoming;

        // Update live candles array
        const idx = a.candles.findIndex(c => c.open_time === incoming.open_time);
        if (idx >= 0) a.candles[idx] = incoming;
        else          a.candles.push(incoming);
        if (a.candles.length > cfg.MAX_CANDLES_STORED) {
            a.candles = a.candles.slice(-cfg.MAX_CANDLES_STORED);
        }
    }

    handleCandlesHistory(r) {
        if (r.error) { LOGGER.error(`Candles error: ${r.error.message}`); return; }

        const symbol = r.echo_req?.ticks_history;
        if (!symbol || !state.assets[symbol]) return;

        const cfg   = getAssetConfig(symbol);
        const gran  = cfg.GRANULARITY;

        const candles = (r.candles || []).map(c => ({
            open:      parseFloat(c.open),
            high:      parseFloat(c.high),
            low:       parseFloat(c.low),
            close:     parseFloat(c.close),
            epoch:     c.epoch,
            open_time: Math.floor((c.epoch - gran) / gran) * gran
        }));

        if (!candles.length) { LOGGER.warn(`[${symbol}] No candles received`); return; }

        state.assets[symbol].closedCandles                = [...candles];
        state.assets[symbol].candles                      = [...candles];
        state.assets[symbol].lastProcessedCandleOpenTime  = candles[candles.length - 1].open_time;
        state.assets[symbol].currentFormingCandle         = null;
        state.assets[symbol].candlesLoaded                = true;

        const signal = SignalAnalyzer.analyze(candles, symbol);
        LOGGER.info(`📊 [${symbol}] Loaded ${candles.length} ${cfg.TIMEFRAME_LABEL} candles | Score: ${signal.score.toFixed(1)} | Direction: ${signal.direction ?? 'NONE'} | ${signal.reason}`);
    }

    onError(err) { LOGGER.error(`WebSocket error: ${err.message}`); }

    onClose() {
        LOGGER.warn('🔌 Disconnected');
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
            LOGGER.error('Max reconnection attempts reached');
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

    stopPing() { if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; } }

    send(data) {
        if (this.ws?.readyState !== WebSocket.OPEN) { LOGGER.error('Cannot send: not open'); return null; }
        data.req_id = state.requestId++;
        try { this.ws.send(JSON.stringify(data)); }
        catch (e) { LOGGER.error(`Send error: ${e.message}`); return null; }
        return data.req_id;
    }
}

// ============================================
// MAIN BOT CLASS
// ============================================
class IndexBot {
    constructor() {
        this.connection              = new ConnectionManager();
        this._processedContracts     = new Set();
        this.tradeWatchdogMs         = 80000;  // 1:20 minutes (1m duration + buffer)
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
        console.log('\n' + '═'.repeat(70));
        console.log(' DERIV Index CALLE/PUTE BOT — Multi-Factor Confluence Strategy');
        console.log('═'.repeat(70));
        console.log(`  Pairs     : ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        console.log(`  Timeframe : ${CONFIG.TIMEFRAME_LABEL} candles`);
        console.log(`  Duration  : ${CONFIG.DURATION}${CONFIG.DURATION_UNIT}`);
        console.log(`  Strategy  : EMA+RSI+MACD+BB+Stoch+Pattern (${CONFIG.MIN_CONFLUENCE_SCORE}/6 confluence)`);
        console.log(`  Capital   : $${state.capital.toFixed(2)} | Base Stake: $${CONFIG.STAKE}`);
        console.log(`  Sessions  : ${TradingSessionManager.getStatusString()}`);
        console.log('═'.repeat(70) + '\n');

        state.currentTradeDay = TradeHistoryManager.getDateKey();
        TradeHistoryManager.ensureDayEntry(state.currentTradeDay);

        this.connection.initializeAssets();

        // Subscribe to all pairs
        CONFIG.ACTIVE_ASSETS.forEach(sym => this.subscribeToCandles(sym));

        TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();
        TelegramService.startDailyTimer();
        this.startSessionTimeChecker();
        LOGGER.info('✅ Index Bot started!');
    }

    subscribeToCandles(symbol) {
        if (this.connection.activeSubscriptions.has(symbol)) {
            LOGGER.debug(`Already subscribed to ${symbol}`);
            return;
        }

        const cfg = getAssetConfig(symbol);
        LOGGER.info(`📡 Subscribing to ${symbol} (${cfg.TIMEFRAME_LABEL})...`);

        // Load historical candles
        this.connection.send({
            ticks_history:    symbol,
            adjust_start_time: 1,
            count:            cfg.CANDLES_TO_LOAD,
            end:              'latest',
            start:            1,
            style:            'candles',
            granularity:      cfg.GRANULARITY
        });

        // Subscribe to live OHLC stream
        this.connection.send({
            ticks_history:    symbol,
            adjust_start_time: 1,
            count:            1,
            end:              'latest',
            start:            1,
            style:            'candles',
            granularity:      cfg.GRANULARITY,
            subscribe:        1
        });

        this.connection.activeSubscriptions.add(symbol);
    }

    // ── RECOVERY TRADE ──────────────────────────────────────────────
    executeRecoveryTrade(symbol, lastClosedCandle) {
        const a = state.assets[symbol];
        if (!a || a.martingaleLevel === 0)                        return;
        if (!SessionManager.isSessionActive())                    return;
        if (a.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) return;
        if (!state.isConnected || !state.isAuthorized)            return;

        const stake = a.currentStake;
        if (state.capital < stake) {
            LOGGER.error(`[${symbol}] Insufficient capital for recovery`);
            a.martingaleLevel = 0; a.currentStake = CONFIG.STAKE;
            return;
        }

        // Recovery trades do NOT require session filter
        // (we must recover the loss whenever the market allows)
        const cfg       = getAssetConfig(symbol);
        // In recovery, trade same direction as last trade
        // (following trend that caused the loss)
        const direction = a.lastTradeDirection || 'CALLE';

        // const candleType  = CandleAnalyzer.getCandleDirection(lastClosedCandle);
        // const direction   = candleType === 'BULLISH' ? 'CALLE' : 'PUTE';

        LOGGER.trade(`⚡ [${symbol}] RECOVERY | ${direction === 'CALLE' ? 'CALLE' : 'PUTE'} | Stake: $${stake.toFixed(2)} | Mart: ${a.martingaleLevel}`);
        TelegramService.sendMessage(
            `⚡ <b>Index RECOVERY [${symbol}]</b>\n` +
            `Direction: ${direction === 'CALLE' ? '📈 CALLE' : '📉 PUTE'}\n` +
            `Stake: $${stake.toFixed(2)} | Martingale Level: ${a.martingaleLevel}\n` +
            `Capital: $${state.capital.toFixed(2)}`
        );

        const pos = {
            symbol, direction, stake,
            duration: cfg.DURATION, durationUnit: cfg.DURATION_UNIT,
            entryTime: Date.now(), contractId: null, reqId: null,
            currentProfit: 0, buyPrice: 0, signal: null, indicators: {}
        };

        a.activePositions.push(pos);
        a.canTrade = false;

        const reqId = this.connection.send({
            buy: 1, subscribe: 1, price: stake.toFixed(2),
            parameters: {
                contract_type: direction, symbol, currency: 'USD',
                amount: stake.toFixed(2), duration: cfg.DURATION,
                duration_unit: cfg.DURATION_UNIT, basis: 'stake'
            }
        });
        pos.reqId = reqId;
    }

    // ── NORMAL TRADE ────────────────────────────────────────────────
    executeNextTrade(symbol, lastClosedCandle) {
        const a = state.assets[symbol];
        if (!a || !a.canTrade)                                    return;
        if (!SessionManager.isSessionActive())                    return;
        if (a.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) return;

        // Check total positions across all pairs
        const totalPositions = CONFIG.ACTIVE_ASSETS.reduce(
            (sum, s) => sum + (state.assets[s]?.activePositions?.length ?? 0), 0
        );
        if (totalPositions >= CONFIG.MAX_TOTAL_POSITIONS) {
            LOGGER.debug(`[${symbol}] Max total positions (${totalPositions}/${CONFIG.MAX_TOTAL_POSITIONS})`);
            return;
        }

        // ── Session filter ─────────────────────────────────────────
        if (CONFIG.USE_TRADING_SESSIONS) {
            const sessInfo = TradingSessionManager.isWithinAnySession();
            if (!sessInfo.inSession) {
                const now = Date.now();
                if (now - state.lastSessionLogTime > 300000) {
                    LOGGER.info(`⏰ ${TradingSessionManager.getStatusString()} — holding off new trades`);
                    state.lastSessionLogTime = now;
                }
                return;
            }
            if (CONFIG.REQUIRE_SESSION_OVERLAP && !TradingSessionManager.isInOverlap()) {
                LOGGER.debug(`[${symbol}] Overlap-only mode — not in overlap`);
                return;
            }
        }

        const stake = a.currentStake;
        if (state.capital < stake) {
            LOGGER.error(`[${symbol}] Insufficient capital: $${state.capital.toFixed(2)}`);
            if (a.martingaleLevel > 0) { a.martingaleLevel = 0; a.currentStake = CONFIG.STAKE; }
            return;
        }

        if (a.closedCandles.length < 50) {
            LOGGER.debug(`[${symbol}] Not enough candles yet (${a.closedCandles.length}/50)`);
            return;
        }

        // ── Run signal analysis ─────────────────────────────────────
        const signal = SignalAnalyzer.analyze(a.closedCandles, symbol);

        LOGGER.signal(
            `[${symbol}] Score: ${signal.score.toFixed(1)}/${signal.maxScore} | ` +
            `${signal.direction ?? 'NO SIGNAL'} | ${signal.reason}`
        );

        // Log individual signals
        if (CONFIG.DEBUG_MODE) {
            Object.entries(signal.signals).forEach(([k, v]) => {
                LOGGER.debug(`  ${symbol} ${k}: ${v}`);
            });
            if (signal.warnings.length) {
                LOGGER.debug(`  ${symbol} Warnings: ${signal.warnings.join(', ')}`);
            }
        }

        if (!signal.shouldTrade || !signal.direction) {
            a.canTrade = false;
            return;
        }

        // ── Execute trade ───────────────────────────────────────────
        const cfg       = getAssetConfig(symbol);
        const direction = signal.direction;

        a.canTrade          = false;
        a.lastTradeDirection = direction;

        LOGGER.trade(`🎯 [${symbol}] ${direction === 'CALLE' ? '📈 CALL' : '📉 PUT'} | Stake: $${stake.toFixed(2)} | Score: ${signal.score.toFixed(1)}/${signal.maxScore}`);
        LOGGER.trade(`   ${signal.reason}`);

        const pos = {
            symbol, direction, stake,
            duration: cfg.DURATION, durationUnit: cfg.DURATION_UNIT,
            entryTime: Date.now(), contractId: null, reqId: null,
            currentProfit: 0, buyPrice: 0,
            signal:     { score: signal.score, maxScore: signal.maxScore, reason: signal.reason },
            indicators: signal.indicators
        };

        a.activePositions.push(pos);

        const reqId = this.connection.send({
            buy: 1, subscribe: 1, price: stake.toFixed(2),
            parameters: {
                contract_type: direction, symbol, currency: 'USD',
                amount: stake.toFixed(2), duration: cfg.DURATION,
                duration_unit: cfg.DURATION_UNIT, basis: 'stake'
            }
        });
        pos.reqId = reqId;

        StatePersistence.saveState();
    }

    // ── WATCHDOG ────────────────────────────────────────────────────
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
        if (this.statusDisplayIntervalId) { clearInterval(this.statusDisplayIntervalId); }
        if (this.sessionTimeCheckerId)    { clearInterval(this.sessionTimeCheckerId);    }
        if (this.contractCleanupInterval) { clearInterval(this.contractCleanupInterval); }
        StatePersistence.saveState();
        TradeHistoryManager.saveHistory();
        setTimeout(() => { this.connection.cleanup(); LOGGER.info('👋 Bot stopped'); }, 2000);
    }

    startSessionTimeChecker() {
        if (this.timeCheckStarted) return;
        this.timeCheckStarted  = true;
        this.sessionTimeCheckerId = setInterval(() => SessionManager.checkDayChange(), 60000);
    }

    getStatus() {
        const overall = TradeHistoryManager.getOverallStats();
        const today   = TradeHistoryManager.getTodayStats();
        const pairStatuses = {};

        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                const signal = a.closedCandles.length >= 50 ? SignalAnalyzer.analyze(a.closedCandles, sym) : null;
                pairStatuses[sym] = {
                    martingaleLevel: a.martingaleLevel,
                    currentStake:   a.currentStake,
                    activePositions: a.activePositions.length,
                    trades:  a.tradesCount, wins:   a.winsCount,
                    losses:  a.lossesCount, netPL:  a.netPL,
                    lastDirection: a.lastTradeDirection,
                    signal: signal ? {
                        score:     signal.score,
                        direction: signal.direction,
                        reason:    signal.reason
                    } : null,
                    indicators: signal?.indicators ?? {}
                };
            }
        });

        return {
            connected:    state.isConnected,
            authorized:   state.isAuthorized,
            capital:      state.capital,
            session:      SessionManager.getSessionStats(),
            sessionInfo:  TradingSessionManager.getSessionInfo(),
            totalPositions: CONFIG.ACTIVE_ASSETS.reduce((s, sym) => s + (state.assets[sym]?.activePositions?.length ?? 0), 0),
            pairs: pairStatuses, overall, today
        };
    }
}

// ============================================
// INITIALIZATION
// ============================================
tradeHistory = TradeHistoryManager.loadHistory();
const bot    = new IndexBot();

process.on('SIGINT',  () => { bot.stop(); setTimeout(() => process.exit(0), 3000); });
process.on('SIGTERM', () => { bot.stop(); setTimeout(() => process.exit(0), 3000); });
process.on('uncaughtException',  (err)    => { LOGGER.error(`UNCAUGHT: ${err.message}`); try { StatePersistence.saveState(); } catch {} });
process.on('unhandledRejection', (reason) => { LOGGER.error(`UNHANDLED: ${reason}`);     try { StatePersistence.saveState(); } catch {} });

const stateLoaded = StatePersistence.loadState();
LOGGER.info(stateLoaded ? '🔄 Resuming from saved state' : '🆕 Starting fresh');

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.error('⚠️  Set CONFIG.API_TOKEN before running!');
    process.exit(1);
}

console.log('\n🚀 Starting Deriv Index Bot...\n');
bot.connection.connect();

// ── Status display every 60s ───────────────────────────────────────
const statusInterval = setInterval(() => {
    if (!state.isAuthorized) return;

    const status = bot.getStatus();
    const sess   = status.sessionInfo;

    // Safety: stuck trade > 7 min
    if (state.currentContractId && state.tradeStartTime) {
        const elapsed = Date.now() - state.tradeStartTime;
        if (elapsed > 420000) { // 7 minutes
            LOGGER.error(`🚨 SAFETY: Trade stuck ${Math.round(elapsed / 1000)}s — forcing recovery`);
            bot._recoverStuckTrade('safety-timeout');
        }
    }

    let pairLines = '';
    CONFIG.ACTIVE_ASSETS.forEach(sym => {
        const p = status.pairs[sym];
        if (p) {
            const sig  = p.signal ? `Score:${p.signal.score.toFixed(1)} Dir:${p.signal.direction ?? 'NONE'}` : 'Analyzing...';
            const rsi  = p.indicators?.rsi  ? `RSI:${p.indicators.rsi}` : '';
            const macd = p.indicators?.macdHist ? `MACD:${p.indicators.macdHist}` : '';
            pairLines += `\n  ${sym}: M${p.martingaleLevel} $${p.currentStake.toFixed(2)} | ${p.trades}t ${p.wins}W/${p.losses}L $${p.netPL.toFixed(2)} | Pos:${p.activePositions} | ${sig} | ${rsi} ${macd}`;
        }
    });

    console.log(`\n📊 ${getGMTTime()} | Session: ${status.session.trades}t ${status.session.winRate} $${status.session.netPL.toFixed(2)} | Capital: $${status.capital.toFixed(2)}`);
    console.log(`📋 Overall: ${status.overall.tradesCount}t | P/L: $${status.overall.netPL.toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
    console.log(`🕐 ${TradingSessionManager.getStatusString()}${sess.inOverlap ? ' 🔥 OVERLAP (best signals)' : ''}`);
    console.log(`📈 Pairs:${pairLines}`);
}, 60000);

bot.statusDisplayIntervalId = statusInterval;
