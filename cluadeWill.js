'use strict';
/**
 * DERIV MULTIPLIER BOT v7.0 — "WILL"
 * WPR ONLY Strategy with Persistent Breakout Levels
 *
 * BUY SETUP:
 * - WPR crosses above -20 (Previous WPR ≤ -20, Current WPR > -20)
 * - Must be FIRST crossing above -20 since coming from oversold (-80)
 * - Execute BUY immediately, mark previous candle High/Low as breakout levels
 *
 * SELL SETUP:
 * - WPR crosses below -80 (Previous WPR ≥ -80, Current WPR < -80)
 * - Must be FIRST crossing below -80 since coming from overbought (-20)
 * - Execute SELL immediately, mark previous candle High/Low as breakout levels
 *
 * REVERSAL SYSTEM:
 * - BUY reverses to SELL when candle CLOSES BELOW lower breakout level
 * - SELL reverses to BUY when candle CLOSES ABOVE higher breakout level
 * - Each reversal: 2x stake, add loss to TP target (max 6 reversals)
 *
 * PERSISTENT BREAKOUT LEVELS:
 * - Breakout levels stay active until opposite type is formed
 * - After TP reached, wait for price action between levels
 * - New trades triggered when price closes above/below levels
 *
 * RETAINED from v4 WILL:
 *   RestClient, PAT/legacy auth, enhanced Telegram, trade-history,
 *   SessionManager, persistence, state auto-save.
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

// ══════════════════════════════════════════════════════════════════════════════
// FILE PATHS
// ══════════════════════════════════════════════════════════════════════════════
const STATE_FILE          = path.join(__dirname, 'claudeWill_01-state.json');
const HISTORY_FILE        = path.join(__dirname, 'claudeWill_01-history.json');
const STATE_SAVE_INTERVAL = 5000;

// ══════════════════════════════════════════════════════════════════════════════
// LOGGER  [RETAINED]
// ══════════════════════════════════════════════════════════════════════════════
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
    recovery: (msg) => console.log(`\x1b[33m[RECOV]  ${getGMTTime()} - ${msg}\x1b[0m`),
    candle:   (msg) => console.log(`\x1b[95m[CANDLE] ${getGMTTime()} - ${msg}\x1b[0m`),
};

// ══════════════════════════════════════════════════════════════════════════════
// TIMEFRAME CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════
const TIMEFRAMES = {
    '1m': { seconds: 60,  granularity: 60,  label: '1 Minute' },
    '2m': { seconds: 120, granularity: 120, label: '2 Minutes' },
    '3m': { seconds: 180, granularity: 180, label: '3 Minutes' },
    '5m': { seconds: 300, granularity: 300, label: '5 Minutes' },
    '10m':{ seconds: 600, granularity: 600, label: '10 Minutes' },
    '15m':{ seconds: 900, granularity: 900, label: '15 Minutes' },
    '1h': { seconds: 3600,granularity:3600, label: '1 Hour' },
};
const SELECTED_TIMEFRAME = '1m';
const TIMEFRAME_CONFIG   = TIMEFRAMES[SELECTED_TIMEFRAME];

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════
const CONFIG = {
    // API_TOKEN:    '0P94g4WdSrSrzir',
    // APP_ID:       '1089',
    API_TOKEN:    'pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee',
    APP_ID:       '33uslPtthXBEkQOdfKfoY',
    WS_URL:    'wss://ws.derivws.com/websockets/v3',

    INITIAL_CAPITAL: 610,

    INITIAL_STAKE: 5.00,
    TAKE_PROFIT: 1,

    SESSION_PROFIT_TARGET: 15000,
    SESSION_STOP_LOSS: -200,

    REVERSAL_STAKE_MULTIPLIER: 2,
    MAX_REVERSAL_LEVEL: 7,
    AUTO_CLOSE_ON_RECOVERY: false,

    TIMEFRAME:        SELECTED_TIMEFRAME,
    GRANULARITY:      TIMEFRAME_CONFIG.granularity,
    TIMEFRAME_LABEL:  TIMEFRAME_CONFIG.label,
    TIMEFRAME_SECONDS: TIMEFRAME_CONFIG.seconds,

    WPR_PERIOD:     80,
    WPR_OVERBOUGHT: -20,
    WPR_OVERSOLD:   -80,

    MAX_TRADES_PER_ASSET: 200000,
    MAX_OPEN_POSITIONS:   1000,

    COOLDOWN_AFTER_SESSION_END: 1 * 60 * 1000,

    MAX_TICKS_STORED:    300,
    MAX_CANDLES_STORED:  500,
    MIN_CANDLES_REQUIRED: 82,
    CANDLES_TO_LOAD:     200,

    DEBUG_MODE: true,

    TELEGRAM_ENABLED:    true,
    TELEGRAM_BOT_TOKEN:  '8196927342:AAHa8d0OrF3D6yYTA_QcCPOzz5G0SPj82xE',
    TELEGRAM_CHAT_ID:    '752497117',
};

// ══════════════════════════════════════════════════════════════════════════════
// ASSET CONFIGURATION — Multiplier contracts
// ══════════════════════════════════════════════════════════════════════════════
const ASSET_CONFIGS = {
    'R_75': {
        name: 'Volatility 75', category: 'synthetic', contractType: 'multiplier',
        multipliers: [50, 100, 200, 300, 500], defaultMultiplier: 50,
        maxTradesPerDay: 500000, minStake: 5.00, maxStake: 3000,
        tradingHours: '24/7',
    },
    'R_100': {
        name: 'Volatility 100', category: 'synthetic', contractType: 'multiplier',
        multipliers: [40, 100, 200, 300, 400], defaultMultiplier: 40,
        maxTradesPerDay: 50000, minStake: 5.00, maxStake: 3000,
        tradingHours: '24/7',
    },
    'stpRNG': {
        name: 'Step Index', category: 'synthetic', contractType: 'multiplier',
        multipliers: [750, 2000, 3500, 5500, 7500], defaultMultiplier: 750,
        maxTradesPerDay: 120000, minStake: 5.00, maxStake: 1000,
        tradingHours: '24/7',
    },
};
const ACTIVE_ASSETS = ['R_75', 'R_100', 'stpRNG'];

// ══════════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS — WPR ONLY  [RETAINED]
// ══════════════════════════════════════════════════════════════════════════════
class TechnicalIndicators {
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
            const highs       = validCandles.map(c => parseFloat(c.high));
            const lows        = validCandles.map(c => parseFloat(c.low));
            const close       = parseFloat(validCandles[validCandles.length - 1].close);
            const highestHigh = Math.max(...highs);
            const lowestLow   = Math.min(...lows);
            const range       = highestHigh - lowestLow;
            if (range === 0 || !isFinite(range)) return -50;
            const wpr = ((highestHigh - close) / range) * -100;
            if (wpr < -100 || wpr > 0 || !isFinite(wpr)) return -50;
            return wpr;
        } catch (error) {
            LOGGER.error(`WPR Calculation Exception: ${error.message}`);
            return -50;
        }
    }

    static calculateWPR_TaLib(candles, period = 80) {
        if (!candles || candles.length < period) return -50;
        try {
            const slice = candles.slice(-period);
            let highestHigh = -Infinity, lowestLow = Infinity;
            for (let i = 0; i < slice.length; i++) {
                if (slice[i].high > highestHigh) highestHigh = slice[i].high;
                if (slice[i].low < lowestLow)   lowestLow  = slice[i].low;
            }
            const currentClose = slice[slice.length - 1].close;
            const denominator  = highestHigh - lowestLow;
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

// ══════════════════════════════════════════════════════════════════════════════
// SIGNAL MANAGER — WPR-based signal detection  [FROM REFERENCE BOT]
// ══════════════════════════════════════════════════════════════════════════════
class SignalManager {
    static updateWPRState(symbol) {
        const assetState = state.assets[symbol];
        const wpr    = assetState.wpr;
        const prevWpr = assetState.prevWpr;

        if (wpr < CONFIG.WPR_OVERSOLD && !assetState.buyFlagActive) {
            assetState.buyFlagActive = true;
            LOGGER.wpr(`${symbol}: BUY FLAG ACTIVATED — WPR entered oversold (${wpr.toFixed(2)})`);
        }
        if (wpr > CONFIG.WPR_OVERBOUGHT && !assetState.sellFlagActive) {
            assetState.sellFlagActive = true;
            LOGGER.wpr(`${symbol}: SELL FLAG ACTIVATED — WPR entered overbought (${wpr.toFixed(2)})`);
        }

        if (!assetState.inTradeCycle && !assetState.waitingForReentry) {
            this.checkBuySignal(symbol);
            this.checkSellSignal(symbol);
        }
    }

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
                const setupSuccess = BreakoutManager.setupBreakoutLevels(symbol, 'UP', 'BUY');
                if (setupSuccess) {
                    bot.executeTrade(symbol, 'UP', false);
                    TelegramService.sendSignalAlert(symbol, 'BUY EXECUTED', wpr);
                }
            } else {
                LOGGER.debug(`${symbol}: BUY signal ignored — active BUY breakout exists`);
            }
        }
        return false;
    }

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
                const setupSuccess = BreakoutManager.setupBreakoutLevels(symbol, 'DOWN', 'SELL');
                if (setupSuccess) {
                    bot.executeTrade(symbol, 'DOWN', false);
                    TelegramService.sendSignalAlert(symbol, 'SELL EXECUTED', wpr);
                }
            } else {
                LOGGER.debug(`${symbol}: SELL signal ignored — active SELL breakout exists`);
            }
        }
        return false;
    }

    static checkReentrySignal(symbol) {
        const assetState   = state.assets[symbol];
        const breakout     = assetState.breakout;
        const closedCandles = assetState.closedCandles;

        if (!breakout.active || closedCandles.length < 1) return null;

        const lastCandle  = closedCandles[closedCandles.length - 1];
        const closePrice  = lastCandle.close;
        const isBetweenLevels = closePrice > breakout.lowLevel && closePrice < breakout.highLevel;

        if (isBetweenLevels) {
            if (!assetState.priceReturnedToZone) {
                assetState.priceReturnedToZone = true;
                LOGGER.signal(`${symbol} PRICE RETURNED TO BREAKOUT ZONE (${closePrice.toFixed(5)})`);
                LOGGER.signal(`${symbol} Zone: ${breakout.lowLevel.toFixed(5)} - ${breakout.highLevel.toFixed(5)}`);
            }
            return null;
        }

        if (!assetState.priceReturnedToZone) {
            LOGGER.debug(`${symbol}: Price still outside zone — waiting for return (${closePrice.toFixed(5)})`);
            return null;
        }

        if (closePrice > breakout.highLevel) {
            LOGGER.signal(`${symbol} RE-ENTRY BUY TRIGGERED! Price ${closePrice.toFixed(5)} > ${breakout.highLevel.toFixed(5)}`);
            assetState.waitingForReentry = false;
            assetState.priceReturnedToZone = false;
            return 'UP';
        }

        if (closePrice < breakout.lowLevel) {
            LOGGER.signal(`${symbol} RE-ENTRY SELL TRIGGERED! Price ${closePrice.toFixed(5)} < ${breakout.lowLevel.toFixed(5)}`);
            assetState.waitingForReentry = false;
            assetState.priceReturnedToZone = false;
            return 'DOWN';
        }

        return null;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// BREAKOUT MANAGER — Persistent breakout levels  [FROM REFERENCE BOT]
// ══════════════════════════════════════════════════════════════════════════════
class BreakoutManager {
    static setupBreakoutLevels(symbol, direction, breakoutType) {
        const assetState    = state.assets[symbol];
        const closedCandles = assetState.closedCandles;
        if (closedCandles.length < 1) {
            LOGGER.warn(`${symbol}: Not enough closed candles for breakout setup`);
            return false;
        }
        const previousCandle = closedCandles[closedCandles.length - 1];
        assetState.breakout = {
            active: true, type: breakoutType,
            highLevel: previousCandle.high, lowLevel: previousCandle.low,
            triggerCandle: previousCandle.epoch, canBeReplaced: false,
        };
        assetState.inTradeCycle = true;
        assetState.waitingForReentry = false;

        if (breakoutType === 'BUY')  assetState.sellFlagActive = false;
        if (breakoutType === 'SELL') assetState.buyFlagActive  = false;

        LOGGER.breakout(`${symbol} ${breakoutType} BREAKOUT LEVELS SET:`);
        LOGGER.breakout(`  High: ${previousCandle.high.toFixed(5)} | Low: ${previousCandle.low.toFixed(5)}`);
        TelegramService.sendBreakoutAlert(symbol, breakoutType, previousCandle.high, previousCandle.low);
        return true;
    }

    static replaceBreakoutLevels(symbol, direction, newType) {
        const assetState    = state.assets[symbol];
        const closedCandles = assetState.closedCandles;
        if (closedCandles.length < 1) return false;
        const previousCandle = closedCandles[closedCandles.length - 1];
        LOGGER.breakout(`${symbol} REPLACING ${assetState.breakout.type} breakout with ${newType}`);
        assetState.breakout = {
            active: true, type: newType,
            highLevel: previousCandle.high, lowLevel: previousCandle.low,
            triggerCandle: previousCandle.epoch, canBeReplaced: false,
        };
        if (newType === 'BUY')  assetState.sellFlagActive = false;
        if (newType === 'SELL') assetState.buyFlagActive  = false;
        return true;
    }

    static checkReversal(symbol) {
        const assetState    = state.assets[symbol];
        const breakout      = assetState.breakout;
        const closedCandles = assetState.closedCandles;
        if (!assetState.inTradeCycle || closedCandles.length < 1) return null;

        const lastClosedCandle = closedCandles[closedCandles.length - 1];
        const closePrice       = lastClosedCandle.close;
        const currentDirection = assetState.currentDirection;

        if (currentDirection === 'UP' && closePrice < breakout.lowLevel) {
            LOGGER.breakout(`${symbol} REVERSAL TRIGGERED: UP → DOWN (${closePrice.toFixed(5)} < ${breakout.lowLevel.toFixed(5)})`);
            return 'DOWN';
        }
        if (currentDirection === 'DOWN' && closePrice > breakout.highLevel) {
            LOGGER.breakout(`${symbol} REVERSAL TRIGGERED: DOWN → UP (${closePrice.toFixed(5)} > ${breakout.highLevel.toFixed(5)})`);
            return 'UP';
        }
        return null;
    }

    static checkForBreakoutReplacement(symbol) {
        const assetState = state.assets[symbol];
        const wpr        = assetState.wpr;
        const prevWpr    = assetState.prevWpr;
        const breakout   = assetState.breakout;
        if (!breakout.active || !assetState.inTradeCycle) return null;

        if (breakout.type === 'BUY') {
            const isCrossingBelow = (prevWpr >= CONFIG.WPR_OVERSOLD) && (wpr < CONFIG.WPR_OVERSOLD);
            if (isCrossingBelow && assetState.sellFlagActive) {
                LOGGER.signal(`${symbol} NEW SELL BREAKOUT during BUY cycle`);
                this.replaceBreakoutLevels(symbol, 'DOWN', 'SELL');
                assetState.sellFlagActive = false;
                if (assetState.currentDirection === 'UP') return 'DOWN';
            }
        }
        if (breakout.type === 'SELL') {
            const isCrossingAbove = (prevWpr <= CONFIG.WPR_OVERBOUGHT) && (wpr > CONFIG.WPR_OVERBOUGHT);
            if (isCrossingAbove && assetState.buyFlagActive) {
                LOGGER.signal(`${symbol} NEW BUY BREAKOUT during SELL cycle`);
                this.replaceBreakoutLevels(symbol, 'UP', 'BUY');
                assetState.buyFlagActive = false;
                if (assetState.currentDirection === 'DOWN') return 'UP';
            }
        }
        return null;
    }

    static setWaitingForReentry(symbol) {
        const assetState = state.assets[symbol];
        assetState.inTradeCycle = false;
        assetState.waitingForReentry = true;
        assetState.lastTradeDirection = assetState.currentDirection;
        assetState.breakout.canBeReplaced = true;
        LOGGER.breakout(`${symbol} TP REACHED — breakout levels active, waiting for re-entry`);
        LOGGER.breakout(`  High: ${assetState.breakout.highLevel.toFixed(5)} | Low: ${assetState.breakout.lowLevel.toFixed(5)}`);
    }

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
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// STAKE MANAGER  [FROM REFERENCE BOT]
// ══════════════════════════════════════════════════════════════════════════════
class StakeManager {
    static getInitialStake(symbol) {
        const assetState = state.assets[symbol];
        assetState.currentStake       = CONFIG.INITIAL_STAKE;
        assetState.takeProfit         = CONFIG.TAKE_PROFIT;
        assetState.reversalLevel      = 0;
        assetState.accumulatedLoss    = 0;
        assetState.takeProfitAmount   = CONFIG.TAKE_PROFIT;
        return this.validateStake(symbol, assetState.currentStake);
    }

    static getReversalStake(symbol, previousLoss = 0) {
        const assetState = state.assets[symbol];
        if (assetState.reversalLevel >= CONFIG.MAX_REVERSAL_LEVEL) {
            LOGGER.warn(`${symbol}: Max reversal level reached (${CONFIG.MAX_REVERSAL_LEVEL})`);
            return -1;
        }
        assetState.currentStake *= CONFIG.REVERSAL_STAKE_MULTIPLIER;
        assetState.reversalLevel++;
        if (previousLoss < 0) assetState.accumulatedLoss += Math.abs(previousLoss);
        assetState.takeProfitAmount = assetState.takeProfit + assetState.accumulatedLoss;
        LOGGER.trade(`${symbol} Reversal #${assetState.reversalLevel}/${CONFIG.MAX_REVERSAL_LEVEL}: Stake $${assetState.currentStake.toFixed(2)}`);
        LOGGER.trade(`${symbol} Dynamic TP: $${assetState.takeProfitAmount.toFixed(2)} (Base: $${assetState.takeProfit} + Loss: $${assetState.accumulatedLoss.toFixed(2)})`);
        return this.validateStake(symbol, assetState.currentStake);
    }

    static fullReset(symbol) {
        const assetState = state.assets[symbol];
        LOGGER.recovery(`${symbol} FULL RESET — Trade cycle complete`);
        assetState.currentStake     = CONFIG.INITIAL_STAKE;
        assetState.reversalLevel    = 0;
        assetState.accumulatedLoss  = 0;
        assetState.takeProfitAmount = CONFIG.TAKE_PROFIT;
        assetState.activePosition   = null;
        assetState.currentDirection = null;
        assetState.inTradeCycle     = false;
        assetState.priceReturnedToZone = false;
        if (assetState.breakout.active) {
            BreakoutManager.setWaitingForReentry(symbol);
        }
    }

    static fullResetWithBreakoutClear(symbol) {
        const assetState = state.assets[symbol];
        LOGGER.recovery(`${symbol} FULL RESET WITH BREAKOUT CLEAR`);
        assetState.currentStake     = CONFIG.INITIAL_STAKE;
        assetState.reversalLevel    = 0;
        assetState.accumulatedLoss  = 0;
        assetState.takeProfitAmount = CONFIG.TAKE_PROFIT;
        assetState.activePosition   = null;
        assetState.currentDirection = null;
        assetState.inTradeCycle     = false;
        assetState.waitingForReentry = false;
        assetState.priceReturnedToZone = false;
        BreakoutManager.clearBreakout(symbol);
    }

    static shouldAutoClose(symbol, currentProfit) {
        const assetState = state.assets[symbol];
        if (assetState.reversalLevel > 0 && currentProfit > 0 &&
            currentProfit >= assetState.accumulatedLoss && CONFIG.AUTO_CLOSE_ON_RECOVERY) {
            return true;
        }
        return false;
    }

    static validateStake(symbol, stake) {
        const config = ASSET_CONFIGS[symbol];
        stake = Math.max(stake, config.minStake);
        stake = Math.min(stake, config.maxStake);
        stake = Math.min(stake, state.capital * 0.10);
        if (stake < config.minStake) {
            LOGGER.error(`${symbol}: Cannot afford min stake`);
            return 0;
        }
        return parseFloat(stake.toFixed(2));
    }

    static getMultiplier(symbol) {
        const config = ASSET_CONFIGS[symbol];
        return config.defaultMultiplier || config.multipliers[0];
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// TRADING SESSION MANAGER  [RETAINED]
// ══════════════════════════════════════════════════════════════════════════════
class TradingSessionManager {
    static getCurrentUTCHour() { return new Date().getUTCHours(); }
    static isWithinAnySession() { return { inSession: true, sessionName: '24/7' }; }
    static getStatusString() {
        const time = `${String(new Date().getUTCHours()).padStart(2,'0')}:${String(new Date().getUTCMinutes()).padStart(2,'0')} UTC`;
        return `\u{1f7e2} SYNTHETIC 24/7 MODE (${time})`;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// TRADE HISTORY MANAGER  [RETAINED]
// ══════════════════════════════════════════════════════════════════════════════
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
    static recordTrade(symbol, profit, reversalLevel) {
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
            if (profit > 0) { t.winsCount++;  t.profit += profit;         t.netPL += profit; }
            else            { t.lossesCount++; t.loss += Math.abs(profit); t.netPL += profit; }
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
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE  [MODIFIED for Multiplier]
// ══════════════════════════════════════════════════════════════════════════════
const state = {
    assets:         {},
    capital:        CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    currentTradeDay: null,
    session: {
        profit: 0, loss: 0, netPL: 0,
        tradesCount: 0, winsCount: 0, lossesCount: 0,
        accumulatedLoss: 0, currentProfitTarget: CONFIG.SESSION_PROFIT_TARGET,
        isActive: true, pausedUntil: 0,
        startTime: Date.now(), startCapital: CONFIG.INITIAL_CAPITAL,
    },
    isConnected:  false,
    isAuthorized: false,
    portfolio:    { dailyProfit: 0, dailyLoss: 0, dailyWins: 0, dailyLosses: 0, activePositions: [] },
    requestId:    1,
};

let tradeHistory = null;

// ══════════════════════════════════════════════════════════════════════════════
// STATE PERSISTENCE  [MODIFIED for Multiplier]
// ══════════════════════════════════════════════════════════════════════════════
class StatePersistence {
    static saveState() {
        try {
            const data = {
                savedAt: Date.now(), capital: state.capital,
                session: { ...state.session },
                portfolio: {
                    dailyProfit: state.portfolio.dailyProfit,
                    dailyLoss:   state.portfolio.dailyLoss,
                    dailyWins:   state.portfolio.dailyWins,
                    dailyLosses: state.portfolio.dailyLosses,
                    activePositions: state.portfolio.activePositions.map(pos => ({
                        symbol: pos.symbol, direction: pos.direction, stake: pos.stake,
                        multiplier: pos.multiplier, entryTime: pos.entryTime,
                        contractId: pos.contractId, reqId: pos.reqId,
                        buyPrice: pos.buyPrice, isReversal: pos.isReversal,
                        reversalLevel: pos.reversalLevel, currentProfit: pos.currentProfit,
                        pendingReversal: pos.pendingReversal,
                    })),
                },
                assets: {},
            };
            Object.keys(state.assets).forEach(symbol => {
                const a = state.assets[symbol];
                data.assets[symbol] = {
                    wpr: a.wpr, prevWpr: a.prevWpr,
                    buyFlagActive: a.buyFlagActive, sellFlagActive: a.sellFlagActive,
                    breakout: { ...a.breakout },
                    currentDirection: a.currentDirection, inTradeCycle: a.inTradeCycle,
                    waitingForReentry: a.waitingForReentry, priceReturnedToZone: a.priceReturnedToZone,
                    lastTradeDirection: a.lastTradeDirection,
                    currentStake: a.currentStake, takeProfit: a.takeProfit,
                    reversalLevel: a.reversalLevel, accumulatedLoss: a.accumulatedLoss,
                    takeProfitAmount: a.takeProfitAmount,
                    dailyTrades: a.dailyTrades, dailyWins: a.dailyWins,
                    dailyLosses: a.dailyLosses, consecutiveLosses: a.consecutiveLosses,
                    indicatorsReady: a.indicatorsReady,
                    lastProcessedCandleOpenTime: a.lastProcessedCandleOpenTime,
                    activeContract: a.activeContract, unrealizedPnl: a.unrealizedPnl,
                    closedCandles: a.closedCandles.slice(-50),
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
                LOGGER.warn(`State is ${ageMins.toFixed(1)}min old — starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }
            LOGGER.info(`Restoring state from ${ageMins.toFixed(1)} minutes ago`);
            state.capital   = data.capital;
            state.session   = { ...state.session, ...data.session, startTime: data.session.startTime || Date.now() };
            state.portfolio.dailyProfit = data.portfolio.dailyProfit;
            state.portfolio.dailyLoss   = data.portfolio.dailyLoss;
            state.portfolio.dailyWins   = data.portfolio.dailyWins;
            state.portfolio.dailyLosses = data.portfolio.dailyLosses;
            state.portfolio.activePositions = (data.portfolio.activePositions || []).map(pos => ({
                ...pos, entryTime: pos.entryTime || Date.now(),
            }));

            Object.keys(data.assets || {}).forEach(symbol => {
                if (state.assets[symbol]) {
                    const saved = data.assets[symbol];
                    const a     = state.assets[symbol];
                    a.wpr               = saved.wpr               || -50;
                    a.prevWpr           = saved.prevWpr           || -50;
                    a.buyFlagActive     = saved.buyFlagActive     || false;
                    a.sellFlagActive    = saved.sellFlagActive    || false;
                    a.breakout          = saved.breakout || { active: false, type: null, highLevel: 0, lowLevel: 0, triggerCandle: 0, canBeReplaced: true };
                    a.currentDirection  = saved.currentDirection  || null;
                    a.inTradeCycle      = saved.inTradeCycle      || false;
                    a.waitingForReentry = saved.waitingForReentry || false;
                    a.priceReturnedToZone = saved.priceReturnedToZone || false;
                    a.lastTradeDirection  = saved.lastTradeDirection  || null;
                    a.currentStake       = saved.currentStake       || CONFIG.INITIAL_STAKE;
                    a.takeProfit         = saved.takeProfit         || CONFIG.TAKE_PROFIT;
                    a.reversalLevel      = saved.reversalLevel      || 0;
                    a.accumulatedLoss    = saved.accumulatedLoss    || 0;
                    a.takeProfitAmount   = saved.takeProfitAmount   || CONFIG.TAKE_PROFIT;
                    a.dailyTrades        = saved.dailyTrades        || 0;
                    a.dailyWins          = saved.dailyWins          || 0;
                    a.dailyLosses        = saved.dailyLosses        || 0;
                    a.consecutiveLosses  = saved.consecutiveLosses  || 0;
                    a.indicatorsReady    = saved.indicatorsReady    || false;
                    a.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                    a.activeContract     = saved.activeContract     || null;
                    a.unrealizedPnl      = saved.unrealizedPnl      || 0;
                    if (saved.closedCandles?.length) a.closedCandles = saved.closedCandles;
                    const activePos = state.portfolio.activePositions.find(p => p.symbol === symbol);
                    if (activePos) a.activePosition = activePos;
                    LOGGER.info(`  ${symbol}: BuyFlag=${a.buyFlagActive} SellFlag=${a.sellFlagActive} InCycle=${a.inTradeCycle} Rev=${a.reversalLevel} WPR:${a.wpr.toFixed(1)}`);
                }
            });
            LOGGER.info(`State restored | Capital: $${state.capital.toFixed(2)} | Session P/L: $${state.session.netPL.toFixed(2)}`);
            return true;
        } catch (e) { LOGGER.error(`Load state error: ${e.message}`); return false; }
    }

    static startAutoSave() {
        setInterval(() => { if (state.isAuthorized) this.saveState(); }, STATE_SAVE_INTERVAL);
        LOGGER.info(`Auto-save every ${STATE_SAVE_INTERVAL / 1000}s`);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// TELEGRAM SERVICE  [RETAINED from v4 WILL — enhanced alerts]
// ══════════════════════════════════════════════════════════════════════════════
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

    static async sendTradeAlert(type, symbol, direction, stake, multiplier, details = {}) {
        const emoji   = type === 'OPEN' ? '\u{1f680}' : type === 'WIN' ? '\u2705' : '\u274c';
        const a       = state.assets[symbol];
        const overall = TradeHistoryManager.getOverallStats();
        const today   = TradeHistoryManager.getTodayStats();
        const lines   = [
            `${emoji} <b>WILL BOT v7.0 — ${type}</b>`,
            `Asset: <b>${symbol}</b>  Direction: <b>${direction === 'UP' ? '\u{1f4c8} BUY' : '\u{1f4c9} SELL'}</b>`,
            `Stake: $${stake.toFixed(2)} | Multiplier: x${multiplier}`,
            `Reversal: ${a?.reversalLevel ?? 0}/${CONFIG.MAX_REVERSAL_LEVEL} | ${TradingSessionManager.getStatusString()}`,
        ];
        if (details.breakoutType) lines.push(`Breakout: ${details.breakoutType}`);
        if (a?.breakout?.active) {
            lines.push(`Levels: H=${a.breakout.highLevel.toFixed(5)} L=${a.breakout.lowLevel.toFixed(5)}`);
        }
        if (details.profit !== undefined) {
            const pl = Number(details.profit) || 0;
            lines.push(``, `Profit: ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}`);
            lines.push(``, `\u{1f4cb} <b>${symbol} Stats:</b>`);
            lines.push(`W/L: ${a?.dailyWins ?? 0}/${a?.dailyLosses ?? 0}`);
            lines.push(``, `\u{1f4cb} <b>Today:</b>`);
            lines.push(`Trades: ${today.tradesCount} | W/L: ${today.winsCount}/${today.lossesCount} | P/L: $${(today.netPL || 0).toFixed(2)}`);
            lines.push(`Capital: $${state.capital.toFixed(2)}`);
            lines.push(``, `\u{1f4cb} <b>Overall:</b>`);
            lines.push(`Trades: ${overall.tradesCount} | W/L: ${overall.winsCount}/${overall.lossesCount} | P/L: $${(overall.netPL || 0).toFixed(2)}`);
        }
        await this.sendMessage(lines.join('\n'));
    }

    static async sendBreakoutAlert(symbol, type, highLevel, lowLevel) {
        const emoji = type === 'BUY' ? '\u{1f7e2}' : '\u{1f534}';
        const message = `${emoji} <b>BREAKOUT LEVELS SET</b>\nAsset: ${symbol}\nType: ${type}\nHigh: ${highLevel.toFixed(5)}\nLow: ${lowLevel.toFixed(5)}\nTime: ${new Date().toUTCString()}`;
        await this.sendMessage(message);
    }

    static async sendSignalAlert(symbol, signalType, wpr) {
        const emoji = signalType.includes('BUY') ? '\u{1f7e2}' : '\u{1f534}';
        const message = `${emoji} <b>WPR SIGNAL — ${signalType}</b>\nAsset: ${symbol}\nWPR: ${wpr.toFixed(2)}\nTimeframe: ${CONFIG.TIMEFRAME_LABEL}\nTime: ${new Date().toUTCString()}`;
        await this.sendMessage(message);
    }

    static async sendReversalAlert(symbol, direction, stake, previousLoss, reversalNumber, maxReversals, breakoutHigh, breakoutLow) {
        const emoji   = direction === 'UP' ? '\u{1f7e2}' : '\u{1f534}';
        const dirLabel = direction === 'UP' ? 'BUY' : 'SELL';
        const message = [
            `\u{1f504} <b>REVERSAL TRADE #${reversalNumber}</b>`,
            `Asset: ${symbol}`,
            `New Direction: ${emoji} ${dirLabel}`,
            `Stake: $${stake.toFixed(2)}`,
            `Previous Loss: $${Math.abs(previousLoss).toFixed(2)}`,
            `Reversal: ${reversalNumber}/${maxReversals}`,
            `Breakout High: ${breakoutHigh.toFixed(5)}`,
            `Breakout Low: ${breakoutLow.toFixed(5)}`,
            `Time: ${new Date().toUTCString()}`,
        ].join('\n');
        await this.sendMessage(message);
    }

    static async sendSessionSummary() {
        const stats   = SessionManager.getSessionStats();
        const overall = TradeHistoryManager.getOverallStats();
        const today   = TradeHistoryManager.getTodayStats();
        const wr      = overall.tradesCount > 0 ? ((overall.winsCount / overall.tradesCount) * 100).toFixed(1) : '0.0';
        let pairBreakdown = '';
        ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a?.dailyTrades > 0) {
                const pairWr = a.dailyTrades > 0 ? ((a.dailyWins / a.dailyTrades) * 100).toFixed(1) : '0.0';
                pairBreakdown += `\n  ${sym}: ${a.dailyTrades}t ${a.dailyWins}W/${a.dailyLosses}L (${pairWr}%)`;
            }
        });
        await this.sendMessage([
            `\u{1f4ca} <b>WILL v7.0 SESSION SUMMARY</b>`,
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
        let pairInfo = '';
        ACTIVE_ASSETS.forEach(sym => {
            const cfg = ASSET_CONFIGS[sym];
            pairInfo += `\n  ${sym}: ${cfg?.name || sym} | x${cfg?.defaultMultiplier || '?'} | ${CONFIG.TIMEFRAME_LABEL}`;
        });
        const overall = TradeHistoryManager.getOverallStats();
        await this.sendMessage([
            `\u{1f916} <b>WILL BOT v7.0 STARTED (Multiplier)</b>`,
            `Strategy: WPR Only — Persistent Breakout Levels`,
            `WPR Period: ${CONFIG.WPR_PERIOD} | OB: ${CONFIG.WPR_OVERBOUGHT} | OS: ${CONFIG.WPR_OVERSOLD}`,
            `Stake: $${CONFIG.INITIAL_STAKE} | TP: $${CONFIG.TAKE_PROFIT} | Max Reversals: ${CONFIG.MAX_REVERSAL_LEVEL}`,
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

    static async sendHourlySummary() {
        const today = TradeHistoryManager.getTodayStats();
        let assetInfo = '';
        ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a?.dailyTrades > 0) {
                assetInfo += `\n  ${sym}: ${a.dailyTrades}t ${a.dailyWins}W/${a.dailyLosses}L WPR:${a.wpr?.toFixed(1)} Rev:${a.reversalLevel}`;
            }
        });
        await this.sendMessage([
            `\u23f0 <b>WILL v7.0 Hourly</b>`,
            `Today: ${today.tradesCount}t P/L: $${(today.netPL || 0).toFixed(2)}`,
            `Capital: $${state.capital.toFixed(2)}`,
            assetInfo ? `\n<b>Per-Asset:</b>${assetInfo}` : '',
        ].join('\n'));
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

// ══════════════════════════════════════════════════════════════════════════════
// SESSION MANAGER  [MODIFIED for Multiplier]
// ══════════════════════════════════════════════════════════════════════════════
class SessionManager {
    static isSessionActive() {
        if (Date.now() < state.session.pausedUntil) return false;
        return state.session.isActive;
    }

    static checkSessionTargets() {
        const netPL = state.session.netPL;
        if (netPL >= state.session.currentProfitTarget) {
            LOGGER.trade(`SESSION PROFIT TARGET REACHED: $${netPL.toFixed(2)}`);
            this.endSession('PROFIT_TARGET');
            return true;
        }
        if (netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.error(`SESSION STOP LOSS REACHED: $${netPL.toFixed(2)}`);
            this.endSession('STOP_LOSS');
            return true;
        }
        return false;
    }

    static async endSession(reason) {
        state.session.isActive = false;
        await bot.closeAllPositions();
        state.session.pausedUntil = Date.now() + CONFIG.COOLDOWN_AFTER_SESSION_END;
        LOGGER.info(`Session ended (${reason})`);
        TelegramService.sendSessionSummary();
        setTimeout(() => this.startNewSession(), CONFIG.COOLDOWN_AFTER_SESSION_END);
    }

    static startNewSession() {
        state.session = {
            profit: 0, loss: 0, netPL: 0,
            tradesCount: 0, winsCount: 0, lossesCount: 0,
            accumulatedLoss: 0, currentProfitTarget: CONFIG.SESSION_PROFIT_TARGET,
            isActive: true, pausedUntil: 0,
            startTime: Date.now(), startCapital: state.capital,
        };
        ACTIVE_ASSETS.forEach(symbol => {
            StakeManager.fullResetWithBreakoutClear(symbol);
            state.assets[symbol].buyFlagActive  = false;
            state.assets[symbol].sellFlagActive = false;
        });
        LOGGER.info(`NEW SESSION STARTED | Capital: $${state.capital.toFixed(2)} | Target: $${CONFIG.SESSION_PROFIT_TARGET}`);
    }

    static getSessionStats() {
        const dur  = Date.now() - state.session.startTime;
        const hrs  = Math.floor(dur / 3600000);
        const mins = Math.floor((dur % 3600000) / 60000);
        const wr   = state.session.tradesCount > 0
            ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1) + '%'
            : '0%';
        return {
            duration: `${hrs}h ${mins}m`, trades: state.session.tradesCount,
            wins: state.session.winsCount, losses: state.session.lossesCount,
            winRate: wr, netPL: state.session.netPL,
            profitTarget: state.session.currentProfitTarget,
        };
    }

    static checkDayChange() {
        const today = TradeHistoryManager.getDateKey();
        if (state.currentTradeDay && state.currentTradeDay !== today) {
            LOGGER.info(`Day changed: ${state.currentTradeDay} -> ${today}`);
            const dayStats = TradeHistoryManager.getDayStats(state.currentTradeDay);
            TelegramService.sendMessage(
                `\u{1f319} <b>WILL v7.0 END OF DAY ${state.currentTradeDay}</b>\nP/L: $${(dayStats?.netPL || 0).toFixed(2)}\nCapital: $${state.capital.toFixed(2)}`
            );
            if (!state.session.isActive) {
                state.session.isActive = true;
                LOGGER.info('Session re-activated for new day');
            }
        }
        state.currentTradeDay = today;
    }

    static recordTradeResult(symbol, profit, direction) {
        const a = state.assets[symbol];
        this.checkDayChange();
        state.session.tradesCount++;
        state.capital += profit;

        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL  += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            a.dailyWins++;
            a.consecutiveLosses = 0;
            LOGGER.trade(`WIN [${symbol}] +$${profit.toFixed(2)} | ${direction}`);
        } else {
            state.session.lossesCount++;
            state.session.loss   += Math.abs(profit);
            state.session.netPL  += profit;
            state.portfolio.dailyLoss    += Math.abs(profit);
            state.portfolio.dailyLosses++;
            a.dailyLosses++;
            a.consecutiveLosses++;
            LOGGER.trade(`LOSS [${symbol}] -$${Math.abs(profit).toFixed(2)} | ${direction}`);
        }
        TradeHistoryManager.recordTrade(symbol, profit, a.reversalLevel);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// CONNECTION MANAGER  [MODIFIED: Multiplier + BUG FIX for candle data]
// ══════════════════════════════════════════════════════════════════════════════
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
        this.stalledContractChecks = new Map();
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
                headers: { 'User-Agent': 'willBot7/7.0 (+Node.js)' },
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
    }

    async _newApiConnect() {
        const accRes = await this._rest.get('/trading/v1/options/accounts');
        if (accRes.status !== 200) {
            const msg = accRes.body?.errors?.[0]?.message || accRes.body?.message || JSON.stringify(accRes.body);
            throw new Error(`Account list failed (${accRes.status}): ${msg}`);
        }
        const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
        if (!accounts.length) throw new Error('No Options accounts found');
        const desiredType = (CONFIG.ACCOUNT_TYPE || 'demo').toLowerCase();
        const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desiredType) || accounts[0];
        this._targetAccount = acct;
        this.accountInfo = {
            loginid: acct.account_id, email: acct.email,
            isVirtual: (acct.account_type || '').toLowerCase() === 'demo',
            balance: parseFloat(acct.balance), currency: acct.currency,
        };
        LOGGER.info(`Selected account ${acct.account_id} (${acct.account_type})`);
        const otpRes = await this._rest.post(`/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`);
        if (otpRes.status !== 200) throw new Error(`OTP request failed: ${JSON.stringify(otpRes.body)}`);
        const wsUrl = otpRes.body?.data?.url;
        if (!wsUrl || !/^wss?:/i.test(wsUrl)) throw new Error(`OTP response missing url`);
        this._otpUrl = wsUrl;
        this._openWs(wsUrl);
    }

    _newApiMarkAuthorized() {
        if (!this.accountInfo) return;
        LOGGER.info(`Authorized ${this.accountInfo.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) balance=${this.accountInfo.balance}`);
        state.isAuthorized   = true;
        state.accountBalance = this.accountInfo.balance;
        this.send({ balance: 1, subscribe: 1 });
        this.restoreActiveContracts();
        bot.start();
    }

    restoreActiveContracts() {
        for (const pos of state.portfolio.activePositions) {
            if (pos.contractId) {
                this.send({ proposal_open_contract: 1, contract_id: pos.contractId, subscribe: 1 });
                if (state.assets[pos.symbol]) state.assets[pos.symbol].activePosition = pos;
            }
        }
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
        ACTIVE_ASSETS.forEach(symbol => {
            if (!state.assets[symbol] && ASSET_CONFIGS[symbol]) {
                state.assets[symbol] = {
                    candles: [], closedCandles: [], currentFormingCandle: null,
                    lastProcessedCandleOpenTime: 0,
                    wpr: -50, prevWpr: -50,
                    buyFlagActive: false, sellFlagActive: false,
                    breakout: { active: false, type: null, highLevel: 0, lowLevel: 0, triggerCandle: 0, canBeReplaced: true },
                    activePosition: null, activeContract: null, unrealizedPnl: 0,
                    currentDirection: null, inTradeCycle: false,
                    waitingForReentry: false, priceReturnedToZone: false,
                    lastTradeDirection: null,
                    currentStake: CONFIG.INITIAL_STAKE, takeProfit: CONFIG.TAKE_PROFIT,
                    reversalLevel: 0, accumulatedLoss: 0, takeProfitAmount: CONFIG.TAKE_PROFIT,
                    dailyTrades: 0, dailyWins: 0, dailyLosses: 0, consecutiveLosses: 0,
                    indicatorsReady: false,
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
            case 'sell':                   this.handleSellResponse(r);   break;
            case 'proposal_open_contract': this.handleOpenContract(r);   break;
            case 'ping': break;
            default: break;
        }
    }

    handleAuthorize(r) {
        if (r.error) { LOGGER.error(`Auth failed: ${r.error.message}`); return; }
        LOGGER.info(`Authorized: ${r.authorize.loginid} | Balance: ${r.authorize.balance} ${r.authorize.currency}`);
        state.isAuthorized   = true;
        state.accountBalance = r.authorize.balance;
        this.send({ balance: 1, subscribe: 1 });
        this.restoreActiveContracts();
        bot.start();
    }

    // ════════════════════════════════════════════════════════════
    // BUG FIX: handleOHLC — deduplicate candles before adding
    // ════════════════════════════════════════════════════════════
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
                // BUG FIX: Check for duplicate before adding
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

                    // BUG FIX: Always update WPR on candle close, even during trade lock
                    this.updateIndicators(symbol);
                    this.processCandleClose(symbol, closed);
                } else {
                    LOGGER.debug(`[${symbol}] Duplicate candle ignored (open_time: ${closed.open_time})`);
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

    // ════════════════════════════════════════════════════════════
    // BUG FIX: handleCandlesHistory — merge instead of replace
    // ════════════════════════════════════════════════════════════
    handleCandlesHistory(r) {
        if (r.error) { LOGGER.error(`Candles error: ${r.error.message}`); return; }
        const symbol = r.echo_req?.ticks_history;
        if (!symbol || !state.assets[symbol]) return;
        const gran = CONFIG.GRANULARITY;
        const incomingCandles = (r.candles || []).map(c => ({
            open: parseFloat(c.open), high: parseFloat(c.high),
            low: parseFloat(c.low),   close: parseFloat(c.close),
            epoch: c.epoch, open_time: Math.floor((c.epoch - gran) / gran) * gran,
        }));
        if (!incomingCandles.length) { LOGGER.warn(`[${symbol}] No candles received`); return; }

        const a = state.assets[symbol];

        // BUG FIX: Merge incoming candles with existing instead of replacing
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
        // Sort by open_time to maintain proper order
        a.closedCandles.sort((x, y) => x.open_time - y.open_time);
        if (a.closedCandles.length > CONFIG.MAX_CANDLES_STORED) {
            a.closedCandles = a.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED);
        }

        // Update candles array (forming candle tracking)
        a.candles = [...incomingCandles];
        a.currentFormingCandle = null;

        // Set lastProcessedCandleOpenTime to the latest candle
        const lastCandle = incomingCandles[incomingCandles.length - 1];
        if (!a.lastProcessedCandleOpenTime || lastCandle.open_time > a.lastProcessedCandleOpenTime) {
            a.lastProcessedCandleOpenTime = lastCandle.open_time;
        }
        a.candlesLoaded = true;

        // Calculate initial WPR
        if (a.closedCandles.length >= CONFIG.WPR_PERIOD) {
            a.prevWpr = a.wpr;
            a.wpr = TechnicalIndicators.calculateWPR(a.closedCandles, CONFIG.WPR_PERIOD);
        }
        LOGGER.info(
            `[${symbol}] Loaded ${incomingCandles.length} candles (${addedCount} new merged) | ` +
            `WPR: ${a.wpr.toFixed(2)} | Total closed: ${a.closedCandles.length}`
        );
    }

    updateIndicators(symbol) {
        const a = state.assets[symbol];
        if (!a || a.closedCandles.length < CONFIG.WPR_PERIOD) return;
        a.prevWpr = a.wpr;
        a.wpr = TechnicalIndicators.calculateWPR(a.closedCandles, CONFIG.WPR_PERIOD);
        a.indicatorsReady = true;
    }

    // ════════════════════════════════════════════════════════════
    // processCandleClose — trade logic on every candle close
    // ════════════════════════════════════════════════════════════
    processCandleClose(symbol, closedCandle) {
        const a = state.assets[symbol];
        if (!a || a.closedCandles.length < CONFIG.MIN_CANDLES_REQUIRED) return;
        if (!state.isConnected || !state.isAuthorized) return;

        // Update WPR state and check for signals (only when not in trade cycle)
        SignalManager.updateWPRState(symbol);

        // Check for breakout replacement during active trade
        if (a.inTradeCycle && a.activePosition) {
            const replacementReversal = BreakoutManager.checkForBreakoutReplacement(symbol);
            if (replacementReversal) {
                bot.executeReversal(symbol, replacementReversal);
                return;
            }
        }

        // Check for reversal if in active trade with breakout levels
        if (a.activePosition && a.breakout.active && a.inTradeCycle) {
            const reversal = BreakoutManager.checkReversal(symbol);
            if (reversal) {
                bot.executeReversal(symbol, reversal);
                return;
            }
        }

        // Check for re-entry if waiting after TP
        if (a.waitingForReentry) {
            const reentry = SignalManager.checkReentrySignal(symbol);
            if (reentry) {
                a.inTradeCycle = true;
                bot.executeTrade(symbol, reentry, false);
            }
        }

        LOGGER.debug(`[${symbol}] WPR: ${a.wpr.toFixed(2)} | BuyFlag: ${a.buyFlagActive} | SellFlag: ${a.sellFlagActive} | InCycle: ${a.inTradeCycle} | Waiting: ${a.waitingForReentry} | Breakout: ${a.breakout.type || 'none'}`);
    }

    // ════════════════════════════════════════════════════════════
    // BUY RESPONSE — Multiplier contract
    // ════════════════════════════════════════════════════════════
    handleBuyResponse(r) {
        if (r.error) {
            LOGGER.error(`Trade error: ${r.error.message}`);
            const reqId = r.echo_req?.req_id;
            if (reqId) {
                const posIndex = state.portfolio.activePositions.findIndex(p => p.reqId === reqId);
                if (posIndex >= 0) {
                    const pos = state.portfolio.activePositions[posIndex];
                    if (state.assets[pos.symbol]) {
                        state.assets[pos.symbol].activePosition = null;
                        state.assets[pos.symbol].currentDirection = null;
                    }
                    state.portfolio.activePositions.splice(posIndex, 1);
                }
            }
            return;
        }

        const contract = r.buy;
        LOGGER.trade(`Position opened: ${contract.contract_id} | Buy Price: $${contract.buy_price}`);

        const reqId = r.echo_req.req_id;
        const position = state.portfolio.activePositions.find(p => p.reqId === reqId);

        if (position) {
            position.contractId = contract.contract_id;
            position.buyPrice   = contract.buy_price;

            if (state.assets[position.symbol]) {
                state.assets[position.symbol].activePosition = position;
                state.assets[position.symbol].activeContract = contract.contract_id;
                state.assets[position.symbol].unrealizedPnl = 0;
            }

            if (position.isReversal) {
                const assetState = state.assets[position.symbol];
                TelegramService.sendReversalAlert(
                    position.symbol, position.direction, position.stake,
                    assetState.accumulatedLoss, position.reversalLevel,
                    CONFIG.MAX_REVERSAL_LEVEL, assetState.breakout.highLevel, assetState.breakout.lowLevel
                );
            } else {
                TelegramService.sendTradeAlert('OPEN', position.symbol, position.direction,
                    position.stake, position.multiplier, { breakoutType: state.assets[position.symbol]?.breakout?.type });
            }
        }

        this.send({ proposal_open_contract: 1, contract_id: contract.contract_id, subscribe: 1 });
    }

    // ════════════════════════════════════════════════════════════
    // SELL RESPONSE — handle contract close
    // ════════════════════════════════════════════════════════════
    handleSellResponse(r) {
        if (r.error) { LOGGER.error(`Sell error: ${r.error.message}`); return; }

        const sold = r.sell;
        LOGGER.trade(`Position closed: ${sold.contract_id} | Sold: $${sold.sold_for}`);

        const posIndex = state.portfolio.activePositions.findIndex(p => p.contractId === sold.contract_id);
        if (posIndex < 0) return;

        const position = state.portfolio.activePositions[posIndex];
        const profit   = sold.sold_for - position.buyPrice;

        const pendingReversalDirection = position.pendingReversal;
        const isReversalPending = !!pendingReversalDirection;
        const symbol = position.symbol;

        SessionManager.recordTradeResult(symbol, profit, position.direction);
        state.portfolio.activePositions.splice(posIndex, 1);

        const assetState = state.assets[symbol];
        if (assetState) {
            assetState.activePosition = null;
            assetState.activeContract = null;
            assetState.unrealizedPnl  = 0;
            assetState.currentDirection = null;

            TelegramService.sendTradeAlert(
                profit >= 0 ? 'WIN' : 'LOSS',
                symbol, position.direction, position.stake, position.multiplier, { profit }
            );

            if (position.isMaxReversalClose) {
                LOGGER.warn(`${symbol}: Max reversals reached — full reset with breakout clear`);
                StakeManager.fullResetWithBreakoutClear(symbol);
            } else if (isReversalPending) {
                const lossAmount = profit < 0 ? profit : 0;
                LOGGER.trade(`REVERSAL TRIGGERED: ${symbol} → ${pendingReversalDirection} | Loss: $${Math.abs(lossAmount).toFixed(2)}`);
                bot.executeTrade(symbol, pendingReversalDirection, true, lossAmount);
            } else if (profit > 0) {
                if (assetState.reversalLevel > 0 && profit >= assetState.accumulatedLoss) {
                    StakeManager.fullReset(symbol);
                } else if (assetState.reversalLevel === 0) {
                    StakeManager.fullReset(symbol);
                }
            }
        }

        SessionManager.checkSessionTargets();
        StatePersistence.saveState();
        if (r.subscription?.id) this.send({ forget: r.subscription.id });
    }

    // ════════════════════════════════════════════════════════════
    // OPEN CONTRACT — live P&L tracking + stalled detection
    // ════════════════════════════════════════════════════════════
    handleOpenContract(r) {
        if (r.error) { LOGGER.error(`Contract error: ${r.error.message}`); return; }

        const contract   = r.proposal_open_contract;
        const contractId = String(contract.contract_id);

        if (r.subscription?.id) this._subscriptionIds.set(contractId, r.subscription.id);

        // Closed/sold contract
        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
            this.stalledContractChecks.delete(contractId);
            const profit   = contract.profit;
            const symbol   = contract.underlying;
            const posIndex = state.portfolio.activePositions.findIndex(p => p.contractId === contract.contract_id);

            LOGGER.trade(`Contract ${contractId} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`);

            if (posIndex >= 0) {
                const position = state.portfolio.activePositions[posIndex];
                SessionManager.recordTradeResult(symbol, profit, position.direction);
                state.portfolio.activePositions.splice(posIndex, 1);

                const assetState = state.assets[symbol];
                if (assetState) {
                    assetState.activePosition = null;
                    assetState.activeContract = null;
                    assetState.unrealizedPnl  = 0;
                    assetState.currentDirection = null;

                    TelegramService.sendTradeAlert(
                        profit >= 0 ? 'WIN' : 'LOSS',
                        symbol, position.direction, position.stake, position.multiplier, { profit }
                    );

                    if (position.isMaxReversalClose) {
                        StakeManager.fullResetWithBreakoutClear(symbol);
                    } else if (position.pendingReversal) {
                        const lossAmount = profit < 0 ? profit : 0;
                        bot.executeTrade(symbol, position.pendingReversal, true, lossAmount);
                    } else if (profit > 0) {
                        if (assetState.reversalLevel > 0 && profit >= assetState.accumulatedLoss) {
                            StakeManager.fullReset(symbol);
                        } else if (assetState.reversalLevel === 0) {
                            StakeManager.fullReset(symbol);
                        }
                    }
                }
            }
            SessionManager.checkSessionTargets();
            StatePersistence.saveState();
            if (r.subscription?.id) this.send({ forget: r.subscription.id });
            return;
        }

        // Live P&L update
        const posIndex = state.portfolio.activePositions.findIndex(p => p.contractId === contract.contract_id);
        if (posIndex >= 0) {
            const position    = state.portfolio.activePositions[posIndex];
            const prevProfit  = position.currentProfit;
            position.currentProfit = contract.profit;
            position.currentPrice  = contract.current_spot;

            const assetState = state.assets[position.symbol];
            if (assetState) {
                assetState.unrealizedPnl = contract.profit;
                assetState.currentPrice  = contract.current_spot;
            }

            // Stalled contract detection
            if (prevProfit !== undefined && prevProfit === contract.profit) {
                const checkData = this.stalledContractChecks.get(contractId) || { count: 0, lastProfit: contract.profit };
                checkData.count++;
                if (checkData.count >= 10) {
                    const hitTP = contract.limit_order?.take_profit?.order_amount &&
                        contract.profit >= (contract.limit_order.take_profit.order_amount * 0.95);
                    const hitSL = contract.limit_order?.stop_loss?.order_amount &&
                        contract.profit <= -(contract.limit_order.stop_loss.order_amount * 0.95);
                    if (hitTP || hitSL || checkData.count >= 20) {
                        LOGGER.warn(`${position.symbol}: Force closing stalled contract`);
                        this.send({ sell: contract.contract_id, price: 0 });
                        this.stalledContractChecks.delete(contractId);
                    }
                }
                this.stalledContractChecks.set(contractId, checkData);
            } else {
                this.stalledContractChecks.set(contractId, { count: 0, lastProfit: contract.profit });
            }

            if (contract.status === 'won' || contract.status === 'lost') {
                LOGGER.warn(`${position.symbol}: Contract status '${contract.status}' — forcing close`);
                this.send({ sell: contract.contract_id, price: 0 });
            }

            // Auto close on recovery
            if (assetState && StakeManager.shouldAutoClose(position.symbol, contract.profit)) {
                LOGGER.recovery(`${position.symbol}: Auto close — profit covers loss`);
                position.isRecoveryClose = true;
                this.send({ sell: contract.contract_id, price: 0 });
            }
        }
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
            TelegramService.sendMessage(`\u26a0\ufe0f <b>WILL v7.0 CONNECTION LOST</b> — Reconnecting (attempt ${this.reconnectAttempts})`);
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (this.isShuttingDown) return;
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached');
            TelegramService.sendMessage(`\u{1f6d1} <b>WILL v7.0 BOT STOPPED</b> — Max reconnections\nP/L: $${(state.session.netPL || 0).toFixed(2)}`);
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

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS — v7 WILL Multiplier
// ══════════════════════════════════════════════════════════════════════════════
class IndexBot {
    constructor() {
        this.connection          = new ConnectionManager();
        this._processedContracts = new Set();
        this._tradeLocked        = false;
        this.timeCheckStarted    = false;
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
        console.log(' DERIV MULTIPLIER BOT v7.0 — WILL (WPR + Persistent Breakout)');
        console.log('═'.repeat(74));
        console.log(`Assets    : ${ACTIVE_ASSETS.join(', ')}`);
        console.log(`Timeframe : ${CONFIG.TIMEFRAME_LABEL} candles`);
        console.log(`Strategy  : WPR(${CONFIG.WPR_PERIOD}) cross ${CONFIG.WPR_OVERBOUGHT}/${CONFIG.WPR_OVERSOLD} → Breakout → Reversal`);
        console.log(`Stake     : $${CONFIG.INITIAL_STAKE} | TP: $${CONFIG.TAKE_PROFIT} | Max Reversals: ${CONFIG.MAX_REVERSAL_LEVEL}`);
        console.log(`Capital   : $${state.capital.toFixed(2)}`);
        console.log('═'.repeat(74) + '\n');

        state.currentTradeDay = TradeHistoryManager.getDateKey();
        TradeHistoryManager.ensureDayEntry(state.currentTradeDay);
        this.connection.initializeAssets();
        ACTIVE_ASSETS.forEach(sym => this.subscribeToAssets(sym));
        await TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();
        TelegramService.startDailyTimer();
        this.startSessionTimeChecker();
        LOGGER.info('WILL Bot v7.0 (Multiplier) fully started!');
    }

    subscribeToAssets(symbol) {
        if (this.connection.activeSubscriptions.has(symbol)) return;
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

    // ════════════════════════════════════════════════════════════
    // executeTrade — Multiplier contract (FROM REFERENCE BOT)
    // ════════════════════════════════════════════════════════════
    executeTrade(symbol, direction, isReversal = false, previousLoss = 0) {
        if (!SessionManager.isSessionActive()) return;
        if (state.portfolio.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) return;
        if (state.capital < CONFIG.INITIAL_STAKE) {
            LOGGER.error(`Insufficient capital: $${state.capital.toFixed(2)}`);
            return;
        }

        const config     = ASSET_CONFIGS[symbol];
        const assetState = state.assets[symbol];
        if (!config || !assetState) return;

        const hasExisting = state.portfolio.activePositions.some(p => p.symbol === symbol);
        if (hasExisting) {
            LOGGER.warn(`Trade blocked: Already have active position on ${symbol}`);
            return;
        }

        let stake;
        if (isReversal) {
            stake = StakeManager.getReversalStake(symbol, previousLoss);
            if (stake === -1) {
                LOGGER.warn(`${symbol}: Max reversals reached — ending trade cycle`);
                StakeManager.fullResetWithBreakoutClear(symbol);
                return;
            }
        } else {
            stake = StakeManager.getInitialStake(symbol);
        }

        if (stake <= 0) {
            LOGGER.error(`Cannot trade ${symbol}: Insufficient stake`);
            return;
        }

        const contractType = direction === 'UP' ? 'MULTUP' : 'MULTDOWN';
        const multiplier   = StakeManager.getMultiplier(symbol);

        LOGGER.trade(`${isReversal ? 'REVERSAL' : 'NEW'} ${direction} on ${config.name} | Stake: $${stake.toFixed(2)} | x${multiplier} | Rev: ${assetState.reversalLevel}/${CONFIG.MAX_REVERSAL_LEVEL}`);
        LOGGER.trade(`Breakout: ${assetState.breakout.type} | H: ${assetState.breakout.highLevel.toFixed(5)} | L: ${assetState.breakout.lowLevel.toFixed(5)}`);

        const position = {
            symbol, direction, stake, multiplier,
            entryTime: Date.now(), contractId: null, reqId: null,
            currentProfit: 0, buyPrice: 0,
            isReversal, reversalLevel: assetState.reversalLevel,
            pendingReversal: null,
        };

        state.portfolio.activePositions.push(position);
        assetState.activePosition = position;
        assetState.currentDirection = direction;

        const tradeRequest = {
            buy: 1, subscribe: 1, price: stake,
            parameters: {
                contract_type: contractType, symbol: symbol,
                currency: 'USD', amount: stake,
                multiplier: multiplier, basis: 'stake',
            },
        };
        if (assetState.takeProfitAmount > 0) {
            tradeRequest.parameters.limit_order = { take_profit: assetState.takeProfitAmount };
        }

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;
        assetState.dailyTrades++;
    }

    // ════════════════════════════════════════════════════════════
    // executeReversal — close current, pending reversal on close
    // ════════════════════════════════════════════════════════════
    executeReversal(symbol, newDirection) {
        const assetState = state.assets[symbol];
        const position   = assetState.activePosition;
        if (!position || !position.contractId) {
            LOGGER.warn(`No active position to reverse on ${symbol}`);
            return;
        }
        if (assetState.reversalLevel >= CONFIG.MAX_REVERSAL_LEVEL) {
            LOGGER.warn(`${symbol}: Max reversals reached — closing position`);
            position.isMaxReversalClose = true;
            this.connection.send({ sell: position.contractId, price: 0 });
            return;
        }
        LOGGER.trade(`REVERSING ${symbol}: ${position.direction} → ${newDirection} (#${assetState.reversalLevel + 1})`);
        position.pendingReversal = newDirection;
        this.connection.send({ sell: position.contractId, price: 0 });
    }

    async closeAllPositions() {
        LOGGER.info('Closing all positions...');
        for (const position of state.portfolio.activePositions) {
            if (position.contractId) {
                this.connection.send({ sell: position.contractId, price: 0 });
                LOGGER.info(`Closing: ${position.symbol} ${position.direction}`);
            }
        }
    }

    stop() {
        LOGGER.info('Stopping bot...');
        this.closeAllPositions();
        TelegramService.clearTimers();
        if (this.statusDisplayIntervalId) clearInterval(this.statusDisplayIntervalId);
        if (this.sessionTimeCheckerId)    clearInterval(this.sessionTimeCheckerId);
        if (this.contractCleanupInterval) clearInterval(this.contractCleanupInterval);
        StatePersistence.saveState();
        TradeHistoryManager.saveHistory();
        setTimeout(() => { this.connection.cleanup(); LOGGER.info('Bot stopped'); }, 2000);
    }

    startSessionTimeChecker() {
        if (this.timeCheckStarted) return;
        this.timeCheckStarted    = true;
        this.sessionTimeCheckerId = setInterval(() => SessionManager.checkDayChange(), 60000);
    }

    getStatus() {
        const overall = TradeHistoryManager.getOverallStats();
        const today   = TradeHistoryManager.getTodayStats();
        const pairStatuses = {};
        ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                pairStatuses[sym] = {
                    currentStake: a.currentStake, reversalLevel: a.reversalLevel,
                    activePositions: a.activePosition ? 1 : 0,
                    trades: a.dailyTrades, wins: a.dailyWins, losses: a.dailyLosses,
                    lastDirection: a.lastTradeDirection,
                    wpr: a.wpr, buyFlag: a.buyFlagActive, sellFlag: a.sellFlagActive,
                    breakoutType: a.breakout.type, breakoutHigh: a.breakout.highLevel,
                    breakoutLow: a.breakout.lowLevel, inCycle: a.inTradeCycle,
                    waiting: a.waitingForReentry,
                };
            }
        });
        return {
            connected: state.isConnected, authorized: state.isAuthorized,
            capital: state.capital, session: SessionManager.getSessionStats(),
            totalPositions: state.portfolio.activePositions.length,
            pairs: pairStatuses, overall, today,
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════════════════════════════════════════
tradeHistory = TradeHistoryManager.loadHistory();
const bot    = new IndexBot();

process.on('SIGINT',  () => { bot.stop(); bot.connection.shutdown(); setTimeout(() => process.exit(0), 3000); });
process.on('SIGTERM', () => { bot.stop(); bot.connection.shutdown(); setTimeout(() => process.exit(0), 3000); });
process.on('uncaughtException',  (err)    => { LOGGER.error(`UNCAUGHT: ${err.message}\n${err.stack}`); try { StatePersistence.saveState(); } catch {} });
process.on('unhandledRejection', (reason) => { LOGGER.error(`UNHANDLED: ${reason}`);                   try { StatePersistence.saveState(); } catch {} });

const stateLoaded = StatePersistence.loadState();
LOGGER.info(stateLoaded ? 'Resuming from saved state' : 'Starting fresh session');

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.error('\nSet CONFIG.API_TOKEN before running!\n');
    process.exit(1);
}

console.log('\n\u{1f680} Starting WILL Bot v7.0 (Multiplier)...\n');
bot.connection.connect();

// ── Status display every 60s ──────────────────────────────────
const statusInterval = setInterval(() => {
    if (!state.isAuthorized) return;
    const status = bot.getStatus();
    let pairLines = '';
    ACTIVE_ASSETS.forEach(sym => {
        const p = status.pairs[sym];
        if (p) {
            const wpr  = `WPR:${p.wpr?.toFixed(1) ?? '?'}`;
            const bk   = p.breakoutType ? `Bk:${p.breakoutType}` : '';
            const stat = p.inCycle ? '\u{1f504}' : (p.waiting ? '\u23f8\ufe0f' : '-');
            pairLines += `\n  ${sym}: ${wpr} ${p.buyFlag ? '\u{1f7e2}BF' : ''} ${p.sellFlag ? '\u{1f534}SF' : ''} ${bk} Rev${p.reversalLevel} $${(p.currentStake || 0).toFixed(2)} | ${p.trades}t ${p.wins}W/${p.losses}L ${stat}`;
        }
    });
    console.log(`\n\u{1f4ca} ${getGMTTime()} | Session: ${status.session.trades}t ${status.session.winRate} $${(status.session.netPL || 0).toFixed(2)} | Capital: $${status.capital.toFixed(2)}`);
    console.log(`\u{1f4cb} Overall: ${status.overall.tradesCount}t | P/L: $${(status.overall.netPL || 0).toFixed(2)}`);
    console.log(`\u{1f4c8} Assets:${pairLines}`);
}, 60000);
bot.statusDisplayIntervalId = statusInterval;
