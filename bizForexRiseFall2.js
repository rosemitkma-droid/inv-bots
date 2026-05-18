const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// FILE PATHS
// ============================================
const STATE_FILE   = path.join(__dirname, 'IndicesBot-state_02.json');
const HISTORY_FILE = path.join(__dirname, 'IndicesBot-history_02.json');
const STATE_SAVE_INTERVAL = 3000;

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
    API_TOKEN:  '0P94g4WdSrSrzir',
    APP_ID:     '1089',
    WS_URL:     'wss://ws.derivws.com/websockets/v3',

    // ── Capital & Risk ─────────────────────────────────────────────
    INITIAL_CAPITAL:        500,        // Start with $500
    STAKE:                  0.35,       // $0.50 per 1-minute trade (high frequency)
    SESSION_PROFIT_TARGET:  250,        // +$250 = end day
    SESSION_STOP_LOSS:      -150,        // -$50 = end day (tight stop)

    // ── Candle / Contract Settings ─────────────────────────────────
    // 1-minute candles: perfect for synthetic indices (high volatility, quick reversals)
    // Synthetic indices move predictably on 1m timeframe with consistent patterns
    GRANULARITY:            60,         // 1 minute in seconds
    TIMEFRAME_LABEL:        '1m',
    CANDLES_TO_LOAD:        200,        // 200 minutes of history for indicator warmup
    MAX_CANDLES_STORED:     300,        // Keep 5 hours of 1m data

    // 1-minute contract duration
    // Synth indices: expiry at candle close = high accuracy
    DURATION:               58,
    DURATION_UNIT:          's',

    // ── Strategy Parameters ────────────────────────────────────────
    // For 1m: use SHORTER indicator periods (more responsive)
    // Synthetic indices have built-in volatility, don't need EMA smoothing

    // Super-fast EMA for 1m direction
    EMA_FAST:               3,          // Fast: 3-period
    EMA_SLOW:               8,          // Slow: 8-period
    EMA_TREND:              20,         // Trend: 20-period (1m × 20 = 20min trend)

    // RSI for overbought/oversold on 1m
    RSI_PERIOD:             9,          // Shorter period = faster response
    RSI_OVERBOUGHT:         70,         // Standard zones (good for 1m)
    RSI_OVERSOLD:           30,

    // Bollinger Bands for volatility bursts
    BB_PERIOD:              14,
    BB_STD_DEV:             2.0,
    BB_SQUEEZE_THRESHOLD:   0.015,     //0.0015 Tighter squeeze for 1m

    // ATR for volatility filter (synths have consistent ATR)
    ATR_PERIOD:             9,
    // ATR_MIN_THRESHOLD:      0.0001,     // Very small moves allowed (synths trade 0.0001 increments)
    // ATR_MAX_THRESHOLD:      0.002,      // Max before extreme volatility
    ATR_THRESHOLDS: {
        R_10:  { min: 0.2,  max: 3.0 },
        R_25:  { min: 0.5,  max: 5.0 },
        R_50:  { min: 0.02, max: 0.5 },
        R_75:  { min: 5.0,  max: 50.0 },
        R_100: { min: 0.2,  max: 2.0 },

        stpRNG:  { min: 0.5, max: 5.0 },
        stpRNG3: { min: 1.0, max: 10.0 },
        stpRNG4: { min: 1.0, max: 10.0 },
        stpRNG5: { min: 1.0, max: 10.0 },
    },

    // MACD for quick momentum
    MACD_FAST:              5,          // Very fast for 1m
    MACD_SLOW:              13,         // Slow
    MACD_SIGNAL:            5,

    // Williams %R (better than RSI for 1m reversals)
    WILLIAMS_R_PERIOD:      9,

    // Momentum Oscillator
    MOMENTUM_PERIOD:        6,

    // CCI (Commodity Channel Index) for divergences
    CCI_PERIOD:             9,

    // Minimum confluence score to enter (out of 5 signals)
    // Lower threshold = more trades, higher risk
    MIN_CONFLUENCE_SCORE:   3.5,

    // ── Martingale Recovery ────────────────────────────────────────
    // For 1m with tight stops: aggressive recovery needed
    MARTINGALE_MULTIPLIER:  2.2,        // 1m trades lose more % due to volatility
    MARTINGALE_MULTIPLIER2: 2.5,
    MARTINGALE_MULTIPLIER3: 3.0,
    MAX_MARTINGALE_STEPS:   5,          // Only 3 steps max (limited capital)

    // ── Candle Pattern Detection ───────────────────────────────────
    // For 1m: focus on quick reversals
    PATTERN_DETECT_ENGULFING: true,     // Bullish/Bearish engulfing
    PATTERN_DETECT_PINBAR:    true,     // Pin bars (hammers, shooting stars)
    PATTERN_DETECT_INSIDE:    true,     // Inside bars (squeeze + breakout)

    // ── Position Management ────────────────────────────────────────
    MAX_OPEN_POSITIONS_PER_ASSET: 1,    // One trade per index at a time
    MAX_TOTAL_POSITIONS:          10,    // Max 3 simultaneous trades
    MIN_CANDLES_BEFORE_TRADE:     30,   // Warm up for 30 minutes before first trade

    // ── Misc ───────────────────────────────────────────────────────
    DEBUG_MODE:             true,
    TELEGRAM_ENABLED:       true,
    TELEGRAM_BOT_TOKEN: '8306232249:AAGMwjFngs68Lcq27oGmqewQgthXTJJRxP0',
    TELEGRAM_CHAT_ID: '752497117',

    // ── Active Synthetic Indices ───────────────────────────────────
    // R_XX = Rise/Fall index (XX = volatility)
    // Higher number = higher volatility, but more predictable patterns
    ACTIVE_ASSETS: [
        'R_100',    // 100-index: highest volatility, most patterns
        'R_75',     // 75-index: very volatile
        'R_50',     // 50-index: balanced volatility
        'R_25',     // 25-index: lower volatility, cleaner signals
        'R_10',     // 10-index: lowest volatility, lowest noise
        'stpRNG', 
        'stpRNG3', 
        'stpRNG4', 
        'stpRNG5'
    ]
};

const ASSET_CONFIGS = {};  // Per-asset overrides (none needed for synth indices)

function getAssetConfig(symbol) {
    const overrides = ASSET_CONFIGS[symbol] || {};
    return {
        GRANULARITY:         CONFIG.GRANULARITY,
        TIMEFRAME_LABEL:     CONFIG.TIMEFRAME_LABEL,
        MAX_CANDLES_STORED:  CONFIG.MAX_CANDLES_STORED,
        CANDLES_TO_LOAD:     CONFIG.CANDLES_TO_LOAD,
        DURATION:            CONFIG.DURATION,
        DURATION_UNIT:       CONFIG.DURATION_UNIT,
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

    static sma(values, period) {
        if (values.length < period) return null;
        const slice = values.slice(-period);
        return slice.reduce((a, b) => a + b, 0) / period;
    }

    // ── Relative Strength Index ────────────────────────────────────
    static rsi(closes, period = 9) {
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

    // ── Williams %R (Fast RSI alternative for 1m) ───────────────────
    static williamsR(candles, period = 9) {
        if (candles.length < period) return null;
        const slice   = candles.slice(-period);
        const highest = Math.max(...slice.map(c => c.high));
        const lowest  = Math.min(...slice.map(c => c.low));
        const close   = candles[candles.length - 1].close;

        if (highest === lowest) return -50;
        return -100 * (highest - close) / (highest - lowest);
    }

    // ── Momentum Oscillator ────────────────────────────────────────
    static momentum(closes, period = 6) {
        if (closes.length < period + 1) return null;
        return closes[closes.length - 1] - closes[closes.length - period - 1];
    }

    // ── CCI (Commodity Channel Index) ──────────────────────────────
    static cci(candles, period = 9) {
        if (candles.length < period) return null;
        const slice   = candles.slice(-period);
        const tp      = slice.map(c => (c.high + c.low + c.close) / 3);  // Typical price
        const sma_tp  = tp.reduce((a, b) => a + b, 0) / period;
        const mad     = tp.reduce((sum, v) => sum + Math.abs(v - sma_tp), 0) / period;
        const current_tp = tp[tp.length - 1];

        if (mad === 0) return 0;
        return (current_tp - sma_tp) / (0.015 * mad);
    }

    // ── Bollinger Bands ────────────────────────────────────────────
    static bollingerBands(closes, period = 14, stdDev = 2) {
        if (closes.length < period) return null;
        const slice = closes.slice(-period);
        const mid   = slice.reduce((a, b) => a + b, 0) / period;
        const variance = slice.reduce((sum, v) => sum + Math.pow(v - mid, 2), 0) / period;
        const std   = Math.sqrt(variance);
        return {
            upper:  mid + stdDev * std,
            middle: mid,
            lower:  mid - stdDev * std,
            width:  (stdDev * 2 * std) / mid,
            std,
            percBand: (closes[closes.length - 1] - mid) / (stdDev * std)  // -1 to 1
        };
    }

    // ── MACD ───────────────────────────────────────────────────────
    static macd(closes, fastPeriod = 5, slowPeriod = 13, signalPeriod = 5) {
        if (closes.length < slowPeriod + signalPeriod) return null;

        const fastEMA   = this.emaArray(closes, fastPeriod);
        const slowEMA   = this.emaArray(closes, slowPeriod);
        const offset    = slowPeriod - fastPeriod;
        const macdLine  = slowEMA.map((slow, i) => fastEMA[i + offset] - slow);

        if (macdLine.length < signalPeriod) return null;

        const signalLine    = this.emaArray(macdLine, signalPeriod);
        const lastMacd      = macdLine[macdLine.length - 1];
        const lastSignal    = signalLine[signalLine.length - 1];
        const prevMacd      = macdLine.length > 1 ? macdLine[macdLine.length - 2] : lastMacd;
        const prevSignal    = signalLine.length > 1 ? signalLine[signalLine.length - 2] : lastSignal;

        return {
            macd:       lastMacd,
            signal:     lastSignal,
            histogram:  lastMacd - lastSignal,
            prevMacd,
            prevSignal,
            prevHistogram: prevMacd - prevSignal,
            bullishCross: prevMacd <= prevSignal && lastMacd > lastSignal,
            bearishCross: prevMacd >= prevSignal && lastMacd < lastSignal
        };
    }

    // ── Average True Range ─────────────────────────────────────────
    static atr(candles, period = 9) {
        if (candles.length < period + 1) return null;
        const slice = candles.slice(-(period + 1));
        const trValues = [];

        for (let i = 1; i < slice.length; i++) {
            const tr = Math.max(
                slice[i].high - slice[i].low,
                Math.abs(slice[i].high - slice[i - 1].close),
                Math.abs(slice[i].low  - slice[i - 1].close)
            );
            trValues.push(tr);
        }

        return trValues.reduce((a, b) => a + b, 0) / trValues.length;
    }

    // ── Support / Resistance ───────────────────────────────────────
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

    // ── Candle Pattern Recognition (optimized for 1m) ───────────────
    static detectPattern(candles) {
        if (candles.length < 3) return { pattern: 'NONE', bias: 'NEUTRAL' };

        const [c2, c1, c0] = candles.slice(-3);
        const body0  = Math.abs(c0.close - c0.open);
        const range0 = c0.high - c0.low;
        const body1  = Math.abs(c1.close - c1.open);

        // Doji (small body, balanced wicks)
        if (range0 > 0 && body0 / range0 < 0.15) {
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

        // Bullish Pin Bar (hammer)
        const lowerWick0 = Math.min(c0.open, c0.close) - c0.low;
        const upperWick0 = c0.high - Math.max(c0.open, c0.close);
        if (lowerWick0 > body0 * 2.5 && upperWick0 < body0) {
            return { pattern: 'HAMMER', bias: 'BULLISH' };
        }

        // Bearish Pin Bar (shooting star)
        if (upperWick0 > body0 * 2.5 && lowerWick0 < body0) {
            return { pattern: 'SHOOTING_STAR', bias: 'BEARISH' };
        }

        // Inside Bar (squeeze + potential breakout)
        if (c0.high < c1.high && c0.low > c1.low) {
            return { pattern: 'INSIDE_BAR', bias: 'NEUTRAL' };  // Needs confirmation
        }

        // Momentum candles (big body)
        if (c0.close > c0.open && body0 / range0 > 0.75) {
            return { pattern: 'STRONG_BULLISH', bias: 'BULLISH' };
        }
        if (c0.close < c0.open && body0 / range0 > 0.75) {
            return { pattern: 'STRONG_BEARISH', bias: 'BEARISH' };
        }

        return {
            pattern: c0.close > c0.open ? 'BULLISH_CANDLE' : 'BEARISH_CANDLE',
            bias:    c0.close > c0.open ? 'BULLISH' : 'BEARISH'
        };
    }

    // ── Divergence Detection (1m specific) ──────────────────────────
    static detectDivergence(candles, rsiValues) {
        if (candles.length < 5 || rsiValues.length < 5) return null;

        const closes = candles.map(c => c.close);
        const last3 = closes.slice(-3);
        const rsi3  = rsiValues.slice(-3);

        // Bullish divergence: lower lows in price, higher lows in RSI
        if (last3[0] > last3[1] && last3[1] > last3[2] &&  // Lower lows in price
            rsi3[0] < rsi3[1] && rsi3[1] < rsi3[2]) {      // Higher lows in RSI
            return { type: 'BULLISH_DIV', strength: 0.5 };
        }

        // Bearish divergence: higher highs in price, lower highs in RSI
        if (last3[0] < last3[1] && last3[1] < last3[2] &&  // Higher highs in price
            rsi3[0] > rsi3[1] && rsi3[1] > rsi3[2]) {      // Lower highs in RSI
            return { type: 'BEARISH_DIV', strength: 0.5 };
        }

        return null;
    }
}

// ============================================
// SIGNAL ANALYZER (Optimized for 1-minute)
// ============================================
/**
 * Strategy for 1m synthetic indices:
 *
 * Factors (each ±1):
 *   1. EMA Trend        — 3>8>20 = bullish (fast responsiveness)
 *   2. RSI              — 40-60 with slope + extremes
 *   3. Williams %R      — -80 to -20 = oversold (bullish), -20 to 0 = overbought (bearish)
 *   4. MACD Histogram   — Positive and growing = bullish
 *   5. Momentum         — Positive = bullish
 *   6. CCI              — Extreme levels indicate reversal
 *   7. Candle Pattern   — Visual confirmation
 *
 * Score ≥ 2.5/7 = TRADE
 *
 * Why this works for 1m indices:
 *   - Synthetic indices have consistent mean-reversion patterns
 *   - High volatility = clear extremes in indicators
 *   - 1m candles = fast reversal confirmation
 *   - Multiple indicators reduce false signals
 */
class SignalAnalyzer {

    static analyze(candles, symbol) {
        const result = {
            direction:       null,
            score:           0,
            maxScore:        7,
            signals:         {},
            indicators:      {},
            shouldTrade:     false,
            reason:          '',
            warnings:        []
        };

        if (!candles || candles.length < CONFIG.CANDLES_TO_LOAD * 0.5) {
            result.reason = 'Insufficient candle history';
            return result;
        }

        const closes  = candles.map(c => c.close);
        const lastClose = closes[closes.length - 1];

        // ── Compute all indicators ─────────────────────────────────
        const emaFast   = Indicators.ema(closes, CONFIG.EMA_FAST);
        const emaSlow   = Indicators.ema(closes, CONFIG.EMA_SLOW);
        const emaTrend  = Indicators.ema(closes, CONFIG.EMA_TREND);

        const emaFastArr  = Indicators.emaArray(closes, CONFIG.EMA_FAST);
        const emaSlowArr  = Indicators.emaArray(closes, CONFIG.EMA_SLOW);

        const rsi       = Indicators.rsi(closes, CONFIG.RSI_PERIOD);
        const williams  = Indicators.williamsR(candles, CONFIG.WILLIAMS_R_PERIOD);
        const momentum  = Indicators.momentum(closes, CONFIG.MOMENTUM_PERIOD);
        const cci       = Indicators.cci(candles, CONFIG.CCI_PERIOD);
        const bb        = Indicators.bollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_STD_DEV);
        const macd      = Indicators.macd(closes, CONFIG.MACD_FAST, CONFIG.MACD_SLOW, CONFIG.MACD_SIGNAL);
        const atr       = Indicators.atr(candles, CONFIG.ATR_PERIOD);
        const pattern   = Indicators.detectPattern(candles);
        const diverg    = Indicators.detectDivergence(candles, emaFastArr);  // Use EMA as proxy

        // Store for display
        result.indicators = {
            emaFast:  emaFast?.toFixed(5),
            emaSlow:  emaSlow?.toFixed(5),
            emaTrend: emaTrend?.toFixed(5),
            rsi:      rsi?.toFixed(2),
            williams: williams?.toFixed(2),
            momentum: momentum?.toFixed(5),
            cci:      cci?.toFixed(2),
            macd:     macd?.macd?.toFixed(5),
            macdHist: macd?.histogram?.toFixed(5),
            atr:      atr?.toFixed(5),
            bbPercBand: bb?.percBand?.toFixed(2),
            pattern:  pattern.pattern,
            divergence: diverg?.type ?? 'NONE',
            lastClose: lastClose?.toFixed(5)
        };

        // ── Gate: ATR Filter ──────────────────────────────────────
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

        // ── Scoring ───────────────────────────────────────────────
        let bullScore = 0, bearScore = 0;

        // ── 1. EMA Trend ──────────────────────────────────────────
        if (emaFast !== null && emaSlow !== null && emaTrend !== null) {
            const emaFastSlope = emaFastArr.length >= 2
                ? emaFastArr[emaFastArr.length - 1] - emaFastArr[emaFastArr.length - 2]
                : 0;

            if (emaFast > emaSlow && emaSlow > emaTrend && emaFastSlope > 0) {
                bullScore++;
                result.signals.emaTrend = 'STRONG BULLISH (3>8>20, rising)';
            } else if (emaFast < emaSlow && emaSlow < emaTrend && emaFastSlope < 0) {
                bearScore++;
                result.signals.emaTrend = 'STRONG BEARISH (3<8<20, falling)';
            } else if (emaFast > emaSlow && emaFastSlope > 0) {
                bullScore += 0.5;
                result.signals.emaTrend = 'MILD BULLISH (3>8)';
            } else if (emaFast < emaSlow && emaFastSlope < 0) {
                bearScore += 0.5;
                result.signals.emaTrend = 'MILD BEARISH (3<8)';
            }
        }

        // ── 2. RSI ───────────────────────────────────────────────
        if (rsi !== null) {
            const prevRsi = closes.length > 1
                ? Indicators.rsi(closes.slice(0, -1), CONFIG.RSI_PERIOD)
                : rsi;
            const rsiSlope = prevRsi ? rsi - prevRsi : 0;

            if (rsi > 50 && rsi < CONFIG.RSI_OVERBOUGHT && rsiSlope > 0) {
                bullScore++;
                result.signals.rsi = `BULLISH RSI (${rsi.toFixed(1)}, rising)`;
            } else if (rsi < 50 && rsi > CONFIG.RSI_OVERSOLD && rsiSlope < 0) {
                bearScore++;
                result.signals.rsi = `BEARISH RSI (${rsi.toFixed(1)}, falling)`;
            } else if (rsi > CONFIG.RSI_OVERBOUGHT) {
                bearScore += 0.5;
                result.signals.rsi = `OVERBOUGHT (${rsi.toFixed(1)})`;
            } else if (rsi < CONFIG.RSI_OVERSOLD) {
                bullScore += 0.5;
                result.signals.rsi = `OVERSOLD (${rsi.toFixed(1)})`;
            } else {
                result.signals.rsi = `NEUTRAL (${rsi.toFixed(1)})`;
            }
        }

        // ── 3. Williams %R ───────────────────────────────────────
        if (williams !== null) {
            if (williams < -80) {
                bullScore++;
                result.signals.williams = `EXTREME OVERSOLD (${williams.toFixed(1)})`;
            } else if (williams > -20) {
                bearScore++;
                result.signals.williams = `EXTREME OVERBOUGHT (${williams.toFixed(1)})`;
            } else if (williams < -60) {
                bullScore += 0.5;
                result.signals.williams = `STRONG OVERSOLD (${williams.toFixed(1)})`;
            } else if (williams > -40) {
                bearScore += 0.5;
                result.signals.williams = `STRONG OVERBOUGHT (${williams.toFixed(1)})`;
            }
        }

        // ── 4. MACD ──────────────────────────────────────────────
        if (macd !== null) {
            if (macd.bullishCross || (macd.histogram > 0 && macd.histogram > macd.prevHistogram)) {
                bullScore++;
                result.signals.macd = macd.bullishCross ? 'BULLISH CROSS' : 'BULLISH histogram';
            } else if (macd.bearishCross || (macd.histogram < 0 && macd.histogram < macd.prevHistogram)) {
                bearScore++;
                result.signals.macd = macd.bearishCross ? 'BEARISH CROSS' : 'BEARISH histogram';
            }
        }

        // ── 5. Momentum ───────────────────────────────────────────
        if (momentum !== null) {
            if (momentum > 0) {
                bullScore += 0.5;
                result.signals.momentum = `BULLISH (${momentum.toFixed(5)})`;
            } else if (momentum < 0) {
                bearScore += 0.5;
                result.signals.momentum = `BEARISH (${momentum.toFixed(5)})`;
            }
        }

        // ── 6. CCI ───────────────────────────────────────────────
        if (cci !== null) {
            if (cci > 100) {
                bearScore += 0.5;
                result.signals.cci = `EXTREME (${cci.toFixed(1)}) — bearish reversal`;
            } else if (cci < -100) {
                bullScore += 0.5;
                result.signals.cci = `EXTREME (${cci.toFixed(1)}) — bullish reversal`;
            }
        }

        // ── 7. Candle Pattern ────────────────────────────────────
        if (pattern.bias === 'BULLISH') {
            bullScore++;
            result.signals.pattern = `BULLISH: ${pattern.pattern}`;
        } else if (pattern.bias === 'BEARISH') {
            bearScore++;
            result.signals.pattern = `BEARISH: ${pattern.pattern}`;
        }

        // ── Bonus: Divergence ────────────────────────────────────
        if (diverg?.type === 'BULLISH_DIV') {
            bullScore += 0.5;
            result.signals.divergence = 'BULLISH DIVERGENCE (RSI)';
        } else if (diverg?.type === 'BEARISH_DIV') {
            bearScore += 0.5;
            result.signals.divergence = 'BEARISH DIVERGENCE (RSI)';
        }

        // ── Determine direction ───────────────────────────────────
        const netScore    = bullScore - bearScore;
        result.score      = Math.abs(netScore);
        result.bullScore  = bullScore;
        result.bearScore  = bearScore;

        // Conflict check
        const hasConflict = bullScore > 0 && bearScore > 0 &&
                            Math.min(bullScore, bearScore) >= 1;

        if (hasConflict) {
            result.reason = `Conflicting signals — no trade (${bullScore} vs ${bearScore})`;
            result.warnings.push('SIGNAL_CONFLICT');
            return result;
        }

        if (result.score >= CONFIG.MIN_CONFLUENCE_SCORE) {
            if (netScore > 0) {
                result.direction  = 'CALLE';
                result.shouldTrade = true;
                result.reason     = `CALLE (${bullScore.toFixed(1)}/${result.maxScore} Bull signals)`;
            } else if (netScore < 0) {
                result.direction  = 'PUTE';
                result.shouldTrade = true;
                result.reason     = `PUTE (${bearScore.toFixed(1)}/${result.maxScore} Bear signals)`;
            }
        } else {
            result.reason = `Insufficient signals: ${result.score.toFixed(1)}/${CONFIG.MIN_CONFLUENCE_SCORE} required`;
        }

        return result;
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
            x2Losses: 0, x3Losses: 0, firstTradeDate: null, lastTradeDate: null
        };
    }

    static _emptyHistory() {
        return { overall: this._emptyOverall(), overallAssets: {}, dailyHistory: {}, lastUpdated: Date.now() };
    }

    static saveHistory() {
        try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2)); }
        catch (e) { LOGGER.error(`Save history error: ${e.message}`); }
    }

    static ensureDayEntry(dateKey) {
        if (!tradeHistory.dailyHistory[dateKey]) {
            tradeHistory.dailyHistory[dateKey] = {
                date: dateKey,
                tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0,
                x2Losses: 0, x3Losses: 0,
                assets: {}, startCapital: state.capital, endCapital: state.capital
            };
        }
    }

    static ensureAssetDayEntry(dateKey, symbol) {
        this.ensureDayEntry(dateKey);
        if (!tradeHistory.dailyHistory[dateKey].assets[symbol]) {
            tradeHistory.dailyHistory[dateKey].assets[symbol] = {
                tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0, x2Losses: 0, x3Losses: 0
            };
        }
    }

    static ensureOverallAssetEntry(symbol) {
        if (!tradeHistory.overallAssets[symbol]) {
            tradeHistory.overallAssets[symbol] = {
                tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0, x2Losses: 0, x3Losses: 0
            };
        }
    }

    static recordTrade(symbol, profit, martingaleLevel) {
        const dateKey = this.getDateKey();
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
            if (profit > 0) {
                t.winsCount++;
                t.profit += profit;
                t.netPL  += profit;
            } else {
                t.lossesCount++;
                t.loss  += Math.abs(profit);
                t.netPL += profit;
                if (martingaleLevel >= 2 && martingaleLevel <= 3) {
                    const key = `x${martingaleLevel}Losses`;
                    if (t[key] !== undefined) t[key]++;
                }
            }
        });

        if (!tradeHistory.overall.firstTradeDate) tradeHistory.overall.firstTradeDate = dateKey;
        tradeHistory.overall.lastTradeDate = dateKey;

        tradeHistory.dailyHistory[dateKey].endCapital = state.capital;
        this.saveHistory();
    }

    static getTodayStats()    { const d = this.getDateKey(); this.ensureDayEntry(d); return tradeHistory.dailyHistory[d]; }
    static getOverallStats()  { return tradeHistory.overall; }
    static getAllDays()       { return Object.keys(tradeHistory.dailyHistory).sort(); }
    static getRecentDays(n=7) { return this.getAllDays().slice(-n).map(d => ({ date: d, ...tradeHistory.dailyHistory[d] })); }
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

            CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                const a = state.assets[symbol];
                data.assets[symbol] = {
                    closedCandles:               a.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED),
                    lastProcessedCandleOpenTime: a.lastProcessedCandleOpenTime,
                    candlesLoaded:               a.candlesLoaded,
                    lastTradeDirection:          a.lastTradeDirection,
                    lastTradeWasWin:             a.lastTradeWasWin,
                    martingaleLevel:             a.martingaleLevel,
                    currentStake:                a.currentStake,
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
            const data    = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMins = (Date.now() - data.savedAt) / 60000;

            if (ageMins > 30) {
                LOGGER.warn(`State ${ageMins.toFixed(1)}min old — starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            state.capital = data.capital;
            state.session = { ...state.session, ...data.session };
            state.portfolio = { ...state.portfolio, ...data.portfolio };
            state.hourlyStats = data.hourlyStats || state.hourlyStats;
            state.currentTradeDay = data.currentTradeDay || TradeHistoryManager.getDateKey();

            if (data.assets) {
                CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = data.assets[symbol];
                        const a = state.assets[symbol];
                        if (saved.closedCandles?.length) a.closedCandles = saved.closedCandles;
                        a.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                        a.candlesLoaded = false;
                        a.lastTradeDirection = saved.lastTradeDirection || null;
                        a.lastTradeWasWin = saved.lastTradeWasWin ?? null;
                        a.martingaleLevel = saved.martingaleLevel || 0;
                        a.currentStake = saved.currentStake || CONFIG.STAKE;
                        a.tradesCount = saved.tradesCount || 0;
                        a.winsCount = saved.winsCount || 0;
                        a.lossesCount = saved.lossesCount || 0;
                        a.netPL = saved.netPL || 0;
                        a.profit = saved.profit || 0;
                        a.loss = saved.loss || 0;
                        a.activePositions = (saved.activePositions || []).map(p => ({ ...p }));
                    }
                });
            }
            LOGGER.info(`✅ Restored from ${ageMins.toFixed(1)}min ago | Capital: $${state.capital.toFixed(2)}`);
            return true;
        } catch (e) {
            LOGGER.error(`Load state error: ${e.message}`);
            return false;
        }
    }

    static startAutoSave() {
        setInterval(() => { if (state.isAuthorized) this.saveState(); }, STATE_SAVE_INTERVAL);
    }
}

// ============================================
// TELEGRAM SERVICE
// ============================================
class TelegramService {
    static hourlyTimerStarted = false;
    static hourlyTimerId      = null;

    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED || !message?.length) return;
        try {
            const url  = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const body = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
            return new Promise((resolve) => {
                const req = https.request(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
                }, res => { res.resume(); res.on('end', () => resolve()); });
                req.on('error', () => resolve());
                req.write(body);
                req.end();
            });
        } catch (e) { LOGGER.error(`Telegram error: ${e.message}`); }
    }

    static async sendTradeAlert(type, symbol, direction, stake, profit = null) {
        const emoji = type === 'OPEN' ? '🚀' : type === 'WIN' ? '✅' : '❌';
        const a     = state.assets[symbol];
        const today = TradeHistoryManager.getTodayStats();

        let msg = `${emoji} <b>1M INDICES BOT ${type}</b>\n${symbol} ${direction === 'CALLE' ? '📈 CALLE' : '📉 PUTE'}\nStake: $${stake.toFixed(2)} | Mart: ${a?.martingaleLevel ?? 0}`;

        if (profit !== null) {
            msg += `\nResult: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`;
            msg += `\n${symbol} P/L: $${(a?.netPL ?? 0).toFixed(2)}`;
            msg += `\nToday: ${today.winsCount}W/${today.lossesCount}L | P/L: $${(today.netPL || 0).toFixed(2)}`;
            msg += `\nCapital: $${state.capital.toFixed(2)}`;
        }

        await this.sendMessage(msg);
    }

    static async sendHourlySummary() {
        const h = state.hourlyStats;
        if (h.trades === 0) return;

        const wr = h.trades > 0 ? ((h.wins / h.trades) * 100).toFixed(1) : '0.0';
        let assetLines = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a?.tradesCount > 0) {
                assetLines += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W $${a.netPL.toFixed(2)}`;
            }
        });

        const msg = [
            `⏰ <b>1M Indices Bot Hourly</b>`,
            `Hour: ${h.trades}t ${h.wins}W/${h.losses}L ${wr}% 🟢$${h.pnl.toFixed(2)}`,
            `Capital: $${state.capital.toFixed(2)}${assetLines}`
        ].join('\n');

        await this.sendMessage(msg);
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };
    }

    static async sendStartupMessage() {
        const overall = TradeHistoryManager.getOverallStats();
        const msg = [
            `🤖 <b>DERIV 1M INDICES BOT STARTED</b>`,
            `Indices: ${CONFIG.ACTIVE_ASSETS.join(', ')}`,
            `Strategy: 7-Factor EMA+RSI+Williams+MACD+Momentum+CCI+Pattern`,
            `Capital: $${state.capital.toFixed(2)} | Stake: $${CONFIG.STAKE}`,
            `Overall: ${overall.tradesCount}t | P/L: $${(overall.netPL || 0).toFixed(2)}`
        ].join('\n');
        await this.sendMessage(msg);
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
            LOGGER.info(`🗓️ Day changed: ${state.currentTradeDay} → ${today}`);
            this._resetDailyStats();
        }
        state.currentTradeDay = today;
    }

    static _resetDailyStats() {
        state.session = {
            profit: 0, loss: 0, netPL: 0,
            tradesCount: 0, winsCount: 0, lossesCount: 0,
            isActive: true, startTime: Date.now(), startCapital: state.capital
        };
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

    static recordTradeResult(symbol, profit, direction) {
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
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            state.hourlyStats.wins++;
            a.winsCount++;
            a.profit += profit;
            a.netPL += profit;
            a.martingaleLevel = 0;
            a.currentStake = CONFIG.STAKE;
            a.lastTradeWasWin = true;

            LOGGER.trade(`✅ [${symbol}] WIN +$${profit.toFixed(2)} | ${direction} | P/L: $${a.netPL.toFixed(2)}`);
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
            a.lastTradeWasWin = false;
            a.martingaleLevel++;

            if (a.martingaleLevel === 1)     a.currentStake = Math.ceil(a.currentStake * CONFIG.MARTINGALE_MULTIPLIER * 100) / 100;
            else if (a.martingaleLevel === 2) a.currentStake = Math.ceil(a.currentStake * CONFIG.MARTINGALE_MULTIPLIER2 * 100) / 100;
            else if (a.martingaleLevel >= 3)  a.currentStake = Math.ceil(a.currentStake * CONFIG.MARTINGALE_MULTIPLIER3 * 100) / 100;

            if (a.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS) {
                LOGGER.warn(`⚠️ [${symbol}] Max martingale (${CONFIG.MAX_MARTINGALE_STEPS}) — resetting`);
                a.martingaleLevel = 0;
                a.currentStake = CONFIG.STAKE;
            }

            LOGGER.trade(`❌ [${symbol}] LOSS -$${Math.abs(profit).toFixed(2)} | ${direction} | M${a.martingaleLevel} | Stake: $${a.currentStake.toFixed(2)}`);
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
    // Watchdog
    tradeWatchdogTimer: null,
    pendingTradeInfo:   null,
    tradeStartTime:     null,
    currentContractId:  null,
};

let tradeHistory = null;

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
        this.activeSubscriptions = new Set();
        this._subscriptionIds = new Map();
    }

    connect() {
        if (this.ws?.readyState === WebSocket.OPEN) return;
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
                    candles: [], closedCandles: [],
                    currentFormingCandle: null,
                    lastProcessedCandleOpenTime: null,
                    candlesLoaded: false,
                    lastTradeDirection: null,
                    lastTradeWasWin: null,
                    martingaleLevel: 0,
                    currentStake: CONFIG.STAKE,
                    canTrade: false,
                    activePositions: [],
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

    handleBuyResponse(r) {
        if (r.error) {
            LOGGER.error(`Buy error: ${r.error.message}`);
            if (bot) bot._forceReleaseTradeLock();
            return;
        }

        const contract = r.buy;
        LOGGER.trade(`📋 Contract: ${contract.contract_id} | Buy: $${contract.buy_price}`);

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
                    TelegramService.sendTradeAlert('OPEN', pos.symbol, pos.direction, pos.stake);
                    break;
                }
            }
        }

        this.send({ proposal_open_contract: 1, contract_id: contract.contract_id, subscribe: 1 });
    }

    handleOpenContract(r) {
        if (r.error) { LOGGER.error(`Contract error: ${r.error.message}`); if (bot) bot._forceReleaseTradeLock(); return; }

        const contract = r.proposal_open_contract;
        const contractId = contract.contract_id;
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
            LOGGER.warn(`Contract ${contractId} settled but not found — retrying`);
            setTimeout(() => this.handleOpenContract(r), 300);
            return;
        }

        // Mark processed
        bot._processedContracts.add(contractIdStr);
        bot._clearAllWatchdogTimers();

        const a = state.assets[ownerSym];
        const pos = a.activePositions[posIdx];
        const profit = contract.profit;

        SessionManager.recordTradeResult(ownerSym, profit, pos.direction);
        TelegramService.sendTradeAlert(profit >= 0 ? 'WIN' : 'LOSS', ownerSym, pos.direction, pos.stake, profit);

        a.activePositions.splice(posIdx, 1);
        state.currentContractId = null;
        state.tradeStartTime = null;
        state.pendingTradeInfo = null;

        if (r.subscription?.id) this.send({ forget: r.subscription.id });

        SessionManager.checkSessionTargets();
        StatePersistence.saveState();
    }

    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        const a = state.assets[symbol];
        if (!a) return;

        const cfg = getAssetConfig(symbol);
        const gran = cfg.GRANULARITY;
        const openTime = ohlc.open_time || Math.floor(ohlc.epoch / gran) * gran;

        const incoming = {
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close),
            epoch: ohlc.epoch,
            open_time: openTime
        };

        if ([incoming.open, incoming.high, incoming.low, incoming.close].some(isNaN)) {
            LOGGER.error(`[${symbol}] Invalid OHLC`);
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

                    if (a.closedCandles.length > cfg.MAX_CANDLES_STORED) {
                        a.closedCandles = a.closedCandles.slice(-cfg.MAX_CANDLES_STORED);
                    }

                    const dir = closed.close > closed.open ? '🟢' : '🔴';
                    LOGGER.info(`${dir} [${symbol}] CANDLE CLOSED | O:${closed.open.toFixed(5)} H:${closed.high.toFixed(5)} L:${closed.low.toFixed(5)} C:${closed.close.toFixed(5)} | ${a.closedCandles.length} candles`);

                    a.canTrade = true;

                    // Wait for minimum candles before trading
                    if (a.closedCandles.length >= CONFIG.MIN_CANDLES_BEFORE_TRADE) {
                        try {
                            if (a.martingaleLevel > 0) bot.executeRecoveryTrade(symbol, closed);
                            else bot.executeNextTrade(symbol, closed);
                        } catch (err) {
                            LOGGER.error(`[${symbol}] Trade execution error: ${err.message}`);
                            bot._forceReleaseTradeLock();
                        }
                    }
                }
            }
        }

        a.currentFormingCandle = incoming;

        // Update live candles array
        const idx = a.candles.findIndex(c => c.open_time === incoming.open_time);
        if (idx >= 0) a.candles[idx] = incoming;
        else a.candles.push(incoming);
        if (a.candles.length > cfg.MAX_CANDLES_STORED) {
            a.candles = a.candles.slice(-cfg.MAX_CANDLES_STORED);
        }
    }

    handleCandlesHistory(r) {
        if (r.error) { LOGGER.error(`Candles error: ${r.error.message}`); return; }

        const symbol = r.echo_req?.ticks_history;
        if (!symbol || !state.assets[symbol]) return;

        const cfg = getAssetConfig(symbol);
        const gran = cfg.GRANULARITY;

        const candles = (r.candles || []).map(c => ({
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close),
            epoch: c.epoch,
            open_time: Math.floor((c.epoch - gran) / gran) * gran
        }));

        if (!candles.length) { LOGGER.warn(`[${symbol}] No candles`); return; }

        state.assets[symbol].closedCandles = [...candles];
        state.assets[symbol].candles = [...candles];
        state.assets[symbol].lastProcessedCandleOpenTime = candles[candles.length - 1].open_time;
        state.assets[symbol].currentFormingCandle = null;
        state.assets[symbol].candlesLoaded = true;

        const signal = state.assets[symbol].closedCandles.length >= 30
            ? SignalAnalyzer.analyze(candles, symbol)
            : null;

        LOGGER.info(`📊 [${symbol}] Loaded ${candles.length} ${cfg.TIMEFRAME_LABEL} candles${signal ? ` | Score: ${signal.score.toFixed(1)}` : ''}`);
    }

    onError(err) { LOGGER.error(`WebSocket error: ${err.message}`); }

    onClose() {
        LOGGER.warn('🔌 Disconnected');
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
            setTimeout(() => { this.isReconnecting = false; this.connect(); }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached');
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
class IndicesBot {
    constructor() {
        this.connection = new ConnectionManager();
        this._processedContracts = new Set();
        this.tradeWatchdogMs = 65000;  // 60s (1m duration) + 5s buffer
        this.statusDisplayIntervalId = null;
        this.contractCleanupInterval = setInterval(() => {
            if (this._processedContracts.size > 500) {
                this._processedContracts = new Set([...this._processedContracts].slice(-50));
            }
        }, 600000);
    }

    async start() {
        console.log('\n' + '═'.repeat(70));
        console.log(' DERIV 1-MINUTE SYNTHETIC INDICES CALLE/PUTE BOT');
        console.log('═'.repeat(70));
        console.log(`  Indices  : ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        console.log(`  Timeframe: ${CONFIG.TIMEFRAME_LABEL} | Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT}`);
        console.log(`  Strategy : 7-Factor Confluence (EMA+RSI+Williams+MACD+Momentum+CCI+Pattern)`);
        console.log(`  Capital  : $${state.capital.toFixed(2)} | Stake: $${CONFIG.STAKE}`);
        console.log(`  Min Score: ${CONFIG.MIN_CONFLUENCE_SCORE}/${7} signals`);
        console.log('═'.repeat(70) + '\n');

        state.currentTradeDay = TradeHistoryManager.getDateKey();
        TradeHistoryManager.ensureDayEntry(state.currentTradeDay);

        this.connection.initializeAssets();

        // Subscribe to all indices
        CONFIG.ACTIVE_ASSETS.forEach(sym => this.subscribeToCandles(sym));

        TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();

        LOGGER.info('✅ Bot started!');
    }

    subscribeToCandles(symbol) {
        if (this.connection.activeSubscriptions.has(symbol)) return;

        const cfg = getAssetConfig(symbol);
        LOGGER.info(`📡 Subscribing to ${symbol}...`);

        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: cfg.CANDLES_TO_LOAD,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: cfg.GRANULARITY
        });

        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: 1,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: cfg.GRANULARITY,
            subscribe: 1
        });

        this.connection.activeSubscriptions.add(symbol);
    }

    // ── RECOVERY TRADE ─────────────────────────────────────────────
    executeRecoveryTrade(symbol, closedCandle) {
        const a = state.assets[symbol];
        if (!a || a.martingaleLevel === 0) return;
        if (!SessionManager.isSessionActive()) return;
        if (a.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) return;
        if (!state.isConnected || !state.isAuthorized) return;

        const totalPos = CONFIG.ACTIVE_ASSETS.reduce((s, sym) => s + (state.assets[sym]?.activePositions?.length ?? 0), 0);
        if (totalPos >= CONFIG.MAX_TOTAL_POSITIONS) return;

        const stake = a.currentStake;
        if (state.capital < stake) {
            LOGGER.error(`[${symbol}] Insufficient capital`);
            a.martingaleLevel = 0; a.currentStake = CONFIG.STAKE;
            return;
        }

        const cfg = getAssetConfig(symbol);
        // Recovery: same direction as original trade
        const direction = a.lastTradeDirection || 'CALLE';

        LOGGER.trade(`⚡ [${symbol}] RECOVERY | ${direction === 'CALLE' ? 'CALLE' : 'PUTE'} | $${stake.toFixed(2)} | M${a.martingaleLevel}`);
        TelegramService.sendMessage(`⚡ <b>${symbol} RECOVERY</b>\nM${a.martingaleLevel} | $${stake.toFixed(2)}`);

        const pos = {
            symbol, direction, stake,
            duration: cfg.DURATION, durationUnit: cfg.DURATION_UNIT,
            entryTime: Date.now(), contractId: null, reqId: null,
            currentProfit: 0, buyPrice: 0
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

    // ── NORMAL TRADE ───────────────────────────────────────────────
    executeNextTrade(symbol, lastClosedCandle) {
        const a = state.assets[symbol];
        if (!a || !a.canTrade) return;
        if (!SessionManager.isSessionActive()) return;
        if (a.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) return;

        const totalPos = CONFIG.ACTIVE_ASSETS.reduce((s, sym) => s + (state.assets[sym]?.activePositions?.length ?? 0), 0);
        if (totalPos >= CONFIG.MAX_TOTAL_POSITIONS) {
            LOGGER.debug(`[${symbol}] Max total positions (${totalPos}/${CONFIG.MAX_TOTAL_POSITIONS})`);
            return;
        }

        const stake = a.currentStake;
        if (state.capital < stake) {
            LOGGER.error(`[${symbol}] Insufficient capital`);
            if (a.martingaleLevel > 0) { a.martingaleLevel = 0; a.currentStake = CONFIG.STAKE; }
            return;
        }

        // ── Run signal analysis ────────────────────────────────────
        const signal = SignalAnalyzer.analyze(a.closedCandles, symbol);

        LOGGER.signal(`[${symbol}] Score: ${signal.score.toFixed(1)}/${signal.maxScore} | ${signal.direction ?? 'NO SIGNAL'} | ${signal.reason}`);

        if (!signal.shouldTrade || !signal.direction) {
            a.canTrade = false;
            return;
        }

        // ── Execute trade ──────────────────────────────────────────
        const cfg = getAssetConfig(symbol);
        const direction = signal.direction;

        a.canTrade = false;
        a.lastTradeDirection = direction;

        LOGGER.trade(`🎯 [${symbol}] ${direction === 'CALLE' ? 'CALL' : 'PUT'} | $${stake.toFixed(2)} | Score: ${signal.score.toFixed(1)}/${signal.maxScore}`);
        LOGGER.trade(`   ${signal.reason}`);

        const pos = {
            symbol, direction, stake,
            duration: cfg.DURATION, durationUnit: cfg.DURATION_UNIT,
            entryTime: Date.now(), contractId: null, reqId: null,
            currentProfit: 0, buyPrice: 0
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

    // ── WATCHDOG ───────────────────────────────────────────────────
    _startTradeWatchdog(contractId) {
        this._clearAllWatchdogTimers();
        state.tradeWatchdogTimer = setTimeout(() => {
            if (!state.currentContractId) return;
            LOGGER.warn(`⏰ WATCHDOG fired for ${contractId}`);
            if (state.isConnected && state.isAuthorized) {
                this.connection.send({ forget_all: 'proposal_open_contract' });
                this.connection.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
            } else {
                this._recoverStuckTrade('watchdog-offline');
            }
        }, this.tradeWatchdogMs);
    }

    _clearAllWatchdogTimers() {
        if (state.tradeWatchdogTimer) { clearTimeout(state.tradeWatchdogTimer); state.tradeWatchdogTimer = null; }
    }

    _forceReleaseTradeLock() {
        this._clearAllWatchdogTimers();
        state.currentContractId = null;
        state.tradeStartTime = null;
        state.pendingTradeInfo = null;
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
                if (i >= 0) { a.activePositions.splice(i, 1); }
            }
        });

        state.currentContractId = null;
        state.pendingTradeInfo = null;
        state.tradeStartTime = null;

        TelegramService.sendMessage(`⚠️ STUCK TRADE RECOVERED [${reason}]\nVerify outcome on Deriv manually`);
        StatePersistence.saveState();
    }

    stop() {
        LOGGER.info('🛑 Stopping bot...');
        CONFIG.ACTIVE_ASSETS.forEach(sym => { if (state.assets[sym]) state.assets[sym].canTrade = false; });
        TelegramService.clearTimers();
        this._clearAllWatchdogTimers();
        if (this.statusDisplayIntervalId) clearInterval(this.statusDisplayIntervalId);
        if (this.contractCleanupInterval) clearInterval(this.contractCleanupInterval);
        StatePersistence.saveState();
        TradeHistoryManager.saveHistory();
        setTimeout(() => { this.connection.cleanup(); }, 2000);
    }

    getStatus() {
        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();
        const pairStatus = {};

        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                const signal = a.closedCandles.length >= 30 ? SignalAnalyzer.analyze(a.closedCandles, sym) : null;
                pairStatus[sym] = {
                    martingaleLevel: a.martingaleLevel,
                    currentStake: a.currentStake,
                    activePositions: a.activePositions.length,
                    trades: a.tradesCount, wins: a.winsCount, losses: a.lossesCount,
                    netPL: a.netPL,
                    signal: signal ? `${signal.score.toFixed(1)}/${signal.maxScore}` : '...'
                };
            }
        });

        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            session: SessionManager.getSessionStats(),
            totalPositions: CONFIG.ACTIVE_ASSETS.reduce((s, sym) => s + (state.assets[sym]?.activePositions?.length ?? 0), 0),
            pairs: pairStatus,
            overall,
            today
        };
    }
}

// ============================================
// INITIALIZATION
// ============================================
tradeHistory = TradeHistoryManager.loadHistory();
const bot = new IndicesBot();

process.on('SIGINT', () => { bot.stop(); setTimeout(() => process.exit(0), 3000); });
process.on('SIGTERM', () => { bot.stop(); setTimeout(() => process.exit(0), 3000); });
process.on('uncaughtException', (err) => {
    LOGGER.error(`UNCAUGHT: ${err.message}`);
    try { StatePersistence.saveState(); } catch {}
});

const stateLoaded = StatePersistence.loadState();
LOGGER.info(stateLoaded ? '🔄 Resuming from saved state' : '🆕 Starting fresh');

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.error('⚠️  Set CONFIG.API_TOKEN before running!');
    process.exit(1);
}

console.log('\n🚀 Starting 1M Indices Bot...\n');
bot.connection.connect();

// ── Status every 30s ────────────────────────────────────────────────
const statusInterval = setInterval(() => {
    if (!state.isAuthorized) return;

    const status = bot.getStatus();

    // Safety: stuck trade > 3 min
    if (state.currentContractId && state.tradeStartTime) {
        const elapsed = Date.now() - state.tradeStartTime;
        if (elapsed > 180000) {
            LOGGER.error(`🚨 Trade stuck ${Math.round(elapsed / 1000)}s — forcing recovery`);
            bot._recoverStuckTrade('safety-timeout');
        }
    }

    let pairLines = '';
    CONFIG.ACTIVE_ASSETS.forEach(sym => {
        const p = status.pairs[sym];
        if (p && p.trades > 0) {
            pairLines += `\n  ${sym}: M${p.martingaleLevel} $${p.currentStake.toFixed(2)} | ${p.trades}t ${p.wins}W $${p.netPL.toFixed(2)} | Sig:${p.signal}`;
        }
    });

    console.log(`\n📊 ${getGMTTime()} | Session: ${status.session.trades}t ${status.session.winRate} $${status.session.netPL.toFixed(2)} | Capital: $${status.capital.toFixed(2)}`);
    console.log(`📋 Overall: ${status.overall.tradesCount}t | P/L: $${status.overall.netPL.toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}${pairLines}`);
}, 30000);

bot.statusDisplayIntervalId = statusInterval;
