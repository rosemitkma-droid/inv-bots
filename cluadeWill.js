'use strict';
/**
 * DERIV MULTIPLIER BOT v7.4 — "WILL"
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
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Load a local .env file without adding another dependency. Existing shell
// environment variables always win. Keep secrets out of this source file.
function loadLocalEnv(filePath = path.join(__dirname, '.env')) {
    try {
        if (!fs.existsSync(filePath)) return;
        for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const separator = line.indexOf('=');
            if (separator < 1) continue;
            const key = line.slice(0, separator).trim();
            let value = line.slice(separator + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (process.env[key] === undefined) process.env[key] = value;
        }
    } catch (error) {
        console.warn(`Could not read .env: ${error.message}`);
    }
}

const envNumber = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
};
const envBoolean = (name, fallback = false) => {
    if (process.env[name] === undefined) return fallback;
    return /^(1|true|yes|on)$/i.test(process.env[name]);
};

loadLocalEnv();

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

// ══════════════════════════════════════════════════════════════════════════════
// FILE PATHS
// ══════════════════════════════════════════════════════════════════════════════
const STATE_FILE = path.join(__dirname, 'claudeWill_01-state.json');
const HISTORY_FILE = path.join(__dirname, 'claudeWill_01-history.json');
const STATE_SAVE_INTERVAL = 5000;

// ══════════════════════════════════════════════════════════════════════════════
// LOGGER  [RETAINED]
// ══════════════════════════════════════════════════════════════════════════════
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
    breakout: (msg) => console.log(`\x1b[35m[BREAK]  ${getGMTTime()} - ${msg}\x1b[0m`),
    recovery: (msg) => console.log(`\x1b[33m[RECOV]  ${getGMTTime()} - ${msg}\x1b[0m`),
    candle: (msg) => console.log(`\x1b[95m[CANDLE] ${getGMTTime()} - ${msg}\x1b[0m`),
};

// ══════════════════════════════════════════════════════════════════════════════
// TIMEFRAME CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════
const TIMEFRAMES = {
    '1m': { seconds: 60, granularity: 60, label: '1 Minute' },
    '2m': { seconds: 120, granularity: 120, label: '2 Minutes' },
    '3m': { seconds: 180, granularity: 180, label: '3 Minutes' },
    '5m': { seconds: 300, granularity: 300, label: '5 Minutes' },
    '10m': { seconds: 600, granularity: 600, label: '10 Minutes' },
    '15m': { seconds: 900, granularity: 900, label: '15 Minutes' },
    '1h': { seconds: 3600, granularity: 3600, label: '1 Hour' },
};
const SELECTED_TIMEFRAME = '1m';
const TIMEFRAME_CONFIG = TIMEFRAMES[SELECTED_TIMEFRAME];

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════
const CONFIG = {
    // Secrets and account selection must come from the environment/.env.
    API_TOKEN: 'pat_cb2016855b5e6c61ac95f94432192dd6ed86bec7f7454e575d3fe1ed9f617692',
    APP_ID: '33uslPtthXBEkQOdfKfoY',
    ACCOUNT_TYPE: 'demo',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    INITIAL_CAPITAL: 1275,

    INITIAL_STAKE: 5.00,
    TAKE_PROFIT: 1,

    SESSION_PROFIT_TARGET: 15000,
    SESSION_STOP_LOSS: -1275,

    REVERSAL_STAKE_MULTIPLIER: 2,
    MAX_REVERSAL_LEVEL: 7,
    MAX_STAKE_FRACTION_OF_CAPITAL: 1.0,
    AUTO_CLOSE_ON_RECOVERY: false,

    TIMEFRAME: SELECTED_TIMEFRAME,
    GRANULARITY: TIMEFRAME_CONFIG.granularity,
    TIMEFRAME_LABEL: TIMEFRAME_CONFIG.label,
    TIMEFRAME_SECONDS: TIMEFRAME_CONFIG.seconds,

    WPR_PERIOD: 80,
    WPR_OVERBOUGHT: -20,
    WPR_OVERSOLD: -80,

    MAX_TRADES_PER_ASSET: 200000,
    MAX_OPEN_POSITIONS: 1000,

    COOLDOWN_AFTER_SESSION_END: 60_000,

    MAX_TICKS_STORED: 300,
    MAX_CANDLES_STORED: 500,
    MIN_CANDLES_REQUIRED: 82,
    CANDLES_TO_LOAD: 200,

    DEBUG_MODE: true,

    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8196927342:AAHa8d0OrF3D6yYTA_QcCPOzz5G0SPj82xE',
    TELEGRAM_CHAT_ID: '752497117'
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
    /**
     * Williams %R calculated from CLOSED candles only.
     * Returns null for bad/insufficient data instead of returning a neutral -50,
     * because a synthetic -50 can create a false threshold crossing.
     */
    static calculateWPR(candles, period = 80) {
        if (!Array.isArray(candles) || candles.length < period) return null;

        const window = candles.slice(-period);
        let highestHigh = -Infinity;
        let lowestLow = Infinity;

        for (const candle of window) {
            const high = Number(candle?.high);
            const low = Number(candle?.low);
            const close = Number(candle?.close);
            if (![high, low, close].every(Number.isFinite) || high < low || close > high || close < low) {
                LOGGER.warn('WPR skipped: invalid OHLC candle in the active window');
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

        // Tiny floating point errors can put an otherwise valid result outside
        // the documented [-100, 0] range.
        return Math.max(-100, Math.min(0, value));
    }

    static calculateWPR_TaLib(candles, period = 80) {
        return this.calculateWPR(candles, period);
    }

    static calculateWPRSeries(candles, period = 80) {
        if (!Array.isArray(candles) || candles.length < period) return [];
        const values = [];
        for (let end = period; end <= candles.length; end++) {
            const value = this.calculateWPR(candles.slice(0, end), period);
            if (Number.isFinite(value)) values.push({ candleIndex: end - 1, value });
        }
        return values;
    }

    static verifyWPRCalculation(candles, period = 80) {
        const wpr1 = this.calculateWPR(candles, period);
        const wpr2 = this.calculateWPR_TaLib(candles, period);
        return Number.isFinite(wpr1) && Number.isFinite(wpr2) && Math.abs(wpr1 - wpr2) <= 0.5;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// SIGNAL MANAGER — WPR-based signal detection  [FROM REFERENCE BOT]
// ══════════════════════════════════════════════════════════════════════════════
class SignalManager {
    static seedWPRState(symbol) {
        const assetState = state.assets[symbol];
        if (!assetState) return false;

        const series = TechnicalIndicators.calculateWPRSeries(
            assetState.closedCandles,
            CONFIG.WPR_PERIOD
        );
        if (!series.length) return false;

        // Rebuild the two "first crossing" arms from candle history so a restart
        // neither loses a valid arm nor executes a stale historical signal.
        let buyArmed = false;
        let sellArmed = false;
        let previous = null;

        for (const point of series) {
            const current = point.value;
            if (current <= CONFIG.WPR_OVERSOLD) buyArmed = true;
            if (current >= CONFIG.WPR_OVERBOUGHT) sellArmed = true;

            if (Number.isFinite(previous)) {
                if (previous <= CONFIG.WPR_OVERBOUGHT &&
                    current > CONFIG.WPR_OVERBOUGHT && buyArmed) {
                    buyArmed = false;
                }
                if (previous >= CONFIG.WPR_OVERSOLD &&
                    current < CONFIG.WPR_OVERSOLD && sellArmed) {
                    sellArmed = false;
                }
            }
            previous = current;
        }

        assetState.prevWpr = series.length > 1 ? series[series.length - 2].value : null;
        assetState.wpr = series[series.length - 1].value;
        assetState.buyFlagActive = buyArmed;
        assetState.sellFlagActive = sellArmed;
        assetState.indicatorsReady = Number.isFinite(assetState.prevWpr);
        return true;
    }

    static updateWPRState(symbol) {
        const assetState = state.assets[symbol];
        const wpr = assetState?.wpr;
        const prevWpr = assetState?.prevWpr;
        if (!Number.isFinite(wpr) || !Number.isFinite(prevWpr)) return false;

        if (wpr <= CONFIG.WPR_OVERSOLD && !assetState.buyFlagActive) {
            assetState.buyFlagActive = true;
            LOGGER.wpr(`${symbol}: BUY FLAG ARMED — WPR entered oversold (${wpr.toFixed(2)})`);
        }
        if (wpr >= CONFIG.WPR_OVERBOUGHT && !assetState.sellFlagActive) {
            assetState.sellFlagActive = true;
            LOGGER.wpr(`${symbol}: SELL FLAG ARMED — WPR entered overbought (${wpr.toFixed(2)})`);
        }

        if (!assetState.inTradeCycle && !assetState.waitingForReentry) {
            if (this.checkBuySignal(symbol)) return true;
            if (this.checkSellSignal(symbol)) return true;
        }
        return false;
    }

    static _entrySnapshot(assetState) {
        return {
            breakout: { ...assetState.breakout },
            inTradeCycle: assetState.inTradeCycle,
            waitingForReentry: assetState.waitingForReentry,
            priceReturnedToZone: assetState.priceReturnedToZone,
        };
    }

    static _restoreEntrySnapshot(assetState, snapshot) {
        assetState.breakout = snapshot.breakout;
        assetState.inTradeCycle = snapshot.inTradeCycle;
        assetState.waitingForReentry = snapshot.waitingForReentry;
        assetState.priceReturnedToZone = snapshot.priceReturnedToZone;
    }

    static checkBuySignal(symbol) {
        const assetState = state.assets[symbol];
        const wpr = assetState.wpr;
        const prevWpr = assetState.prevWpr;
        const isCrossingAbove = prevWpr <= CONFIG.WPR_OVERBOUGHT && wpr > CONFIG.WPR_OVERBOUGHT;
        if (!isCrossingAbove || !assetState.buyFlagActive) return false;

        if (assetState.breakout.active &&
            assetState.breakout.type === 'BUY' &&
            !assetState.breakout.canBeReplaced) {
            LOGGER.debug(`${symbol}: BUY signal ignored — active BUY breakout exists`);
            return false;
        }

        LOGGER.signal(`${symbol} BUY SIGNAL: WPR ${prevWpr.toFixed(2)} → ${wpr.toFixed(2)}`);
        const snapshot = this._entrySnapshot(assetState);
        if (!BreakoutManager.setupBreakoutLevels(symbol, 'UP', 'BUY')) return false;

        if (!bot?.executeTrade(symbol, 'UP', false)) {
            this._restoreEntrySnapshot(assetState, snapshot);
            LOGGER.warn(`${symbol}: BUY signal was valid, but the order was not sent; cycle lock rolled back`);
            return false;
        }

        // Consume the same-side arm. It cannot arm again until WPR revisits -80.
        assetState.buyFlagActive = false;
        TelegramService.sendBreakoutAlert(
            symbol, 'BUY', assetState.breakout.highLevel, assetState.breakout.lowLevel
        );
        TelegramService.sendSignalAlert(symbol, 'BUY EXECUTED', wpr);
        return true;
    }

    static checkSellSignal(symbol) {
        const assetState = state.assets[symbol];
        const wpr = assetState.wpr;
        const prevWpr = assetState.prevWpr;
        const isCrossingBelow = prevWpr >= CONFIG.WPR_OVERSOLD && wpr < CONFIG.WPR_OVERSOLD;
        if (!isCrossingBelow || !assetState.sellFlagActive) return false;

        if (assetState.breakout.active &&
            assetState.breakout.type === 'SELL' &&
            !assetState.breakout.canBeReplaced) {
            LOGGER.debug(`${symbol}: SELL signal ignored — active SELL breakout exists`);
            return false;
        }

        LOGGER.signal(`${symbol} SELL SIGNAL: WPR ${prevWpr.toFixed(2)} → ${wpr.toFixed(2)}`);
        const snapshot = this._entrySnapshot(assetState);
        if (!BreakoutManager.setupBreakoutLevels(symbol, 'DOWN', 'SELL')) return false;

        if (!bot?.executeTrade(symbol, 'DOWN', false)) {
            this._restoreEntrySnapshot(assetState, snapshot);
            LOGGER.warn(`${symbol}: SELL signal was valid, but the order was not sent; cycle lock rolled back`);
            return false;
        }

        // Consume the same-side arm. It cannot arm again until WPR revisits -20.
        assetState.sellFlagActive = false;
        TelegramService.sendBreakoutAlert(
            symbol, 'SELL', assetState.breakout.highLevel, assetState.breakout.lowLevel
        );
        TelegramService.sendSignalAlert(symbol, 'SELL EXECUTED', wpr);
        return true;
    }

    static checkReentrySignal(symbol) {
        const assetState = state.assets[symbol];
        const breakout = assetState.breakout;
        const closedCandles = assetState.closedCandles;
        if (!breakout.active || closedCandles.length < 1) return null;

        const closePrice = Number(closedCandles[closedCandles.length - 1].close);
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
            LOGGER.signal(`${symbol} RE-ENTRY BUY: ${closePrice.toFixed(5)} > ${breakout.highLevel.toFixed(5)}`);
            return 'UP';
        }
        if (closePrice < breakout.lowLevel) {
            LOGGER.signal(`${symbol} RE-ENTRY SELL: ${closePrice.toFixed(5)} < ${breakout.lowLevel.toFixed(5)}`);
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
        const assetState = state.assets[symbol];
        const closedCandles = assetState.closedCandles;
        if (closedCandles.length < 1) {
            LOGGER.warn(`${symbol}: Not enough closed candles for breakout setup`);
            return false;
        }
        // The signal is evaluated when this candle has just closed, so it is
        // the "previous" candle relative to the newly forming live candle.
        const previousCandle = closedCandles[closedCandles.length - 1];
        const highLevel = Number(previousCandle.high);
        const lowLevel = Number(previousCandle.low);
        if (!Number.isFinite(highLevel) || !Number.isFinite(lowLevel) || highLevel <= lowLevel) {
            LOGGER.warn(`${symbol}: Invalid breakout candle levels`);
            return false;
        }
        assetState.breakout = {
            active: true, type: breakoutType,
            highLevel, lowLevel,
            triggerCandle: previousCandle.open_time ?? previousCandle.epoch,
            canBeReplaced: false,
        };
        assetState.inTradeCycle = true;
        assetState.waitingForReentry = false;

        // Do not clear the opposite arm here. For example, a BUY crossing also
        // puts WPR in overbought territory and should arm the next SELL cycle.
        LOGGER.breakout(`${symbol} ${breakoutType} BREAKOUT LEVELS SET:`);
        LOGGER.breakout(`  High: ${highLevel.toFixed(5)} | Low: ${lowLevel.toFixed(5)}`);
        return true;
    }

    static replaceBreakoutLevels(symbol, direction, newType) {
        const assetState = state.assets[symbol];
        const closedCandles = assetState.closedCandles;
        if (closedCandles.length < 1) return false;
        const previousCandle = closedCandles[closedCandles.length - 1];
        const highLevel = Number(previousCandle.high);
        const lowLevel = Number(previousCandle.low);
        if (!Number.isFinite(highLevel) || !Number.isFinite(lowLevel) || highLevel <= lowLevel) return false;
        LOGGER.breakout(`${symbol} REPLACING ${assetState.breakout.type} breakout with ${newType}`);
        assetState.breakout = {
            active: true, type: newType,
            highLevel, lowLevel,
            triggerCandle: previousCandle.open_time ?? previousCandle.epoch,
            canBeReplaced: false,
        };
        TelegramService.sendBreakoutAlert(symbol, newType, highLevel, lowLevel);
        return true;
    }

    static checkReversal(symbol) {
        const assetState = state.assets[symbol];
        const breakout = assetState.breakout;
        const closedCandles = assetState.closedCandles;
        if (!assetState.inTradeCycle || !breakout?.active || closedCandles.length < 1) return null;

        const lastClosedCandle = closedCandles[closedCandles.length - 1];
        const closePrice = Number(lastClosedCandle.close);
        const lowLevel = Number(breakout.lowLevel);
        const highLevel = Number(breakout.highLevel);
        const currentDirection = assetState.currentDirection || assetState.activePosition?.direction;
        if (![closePrice, lowLevel, highLevel].every(Number.isFinite)) {
            LOGGER.warn(`${symbol}: Reversal check skipped — invalid close/breakout level`);
            return null;
        }

        LOGGER.debug(`${symbol}: REVERSAL CHECK | Direction:${currentDirection || 'none'} Close:${closePrice.toFixed(5)} Low:${lowLevel.toFixed(5)} High:${highLevel.toFixed(5)} Contract:${assetState.activePosition?.contractId || 'pending'}`);

        if (currentDirection === 'UP' && closePrice < lowLevel) {
            LOGGER.breakout(`${symbol} PRICE REVERSAL: BUY → SELL because candle closed ${closePrice.toFixed(5)} below ${lowLevel.toFixed(5)}`);
            return 'DOWN';
        }
        if (currentDirection === 'DOWN' && closePrice > highLevel) {
            LOGGER.breakout(`${symbol} PRICE REVERSAL: SELL → BUY because candle closed ${closePrice.toFixed(5)} above ${highLevel.toFixed(5)}`);
            return 'UP';
        }
        return null;
    }

    static checkForBreakoutReplacement(symbol) {
        const assetState = state.assets[symbol];
        const wpr = assetState.wpr;
        const prevWpr = assetState.prevWpr;
        const breakout = assetState.breakout;
        if (!breakout.active || !assetState.inTradeCycle ||
            !Number.isFinite(wpr) || !Number.isFinite(prevWpr)) return null;

        if (breakout.type === 'BUY') {
            const isCrossingBelow = prevWpr >= CONFIG.WPR_OVERSOLD && wpr < CONFIG.WPR_OVERSOLD;
            if (isCrossingBelow && assetState.sellFlagActive) {
                LOGGER.signal(`${symbol} NEW SELL BREAKOUT during BUY cycle`);
                if (this.replaceBreakoutLevels(symbol, 'DOWN', 'SELL')) {
                    assetState.sellFlagActive = false;
                    if (assetState.currentDirection === 'UP') return 'DOWN';
                }
            }
        }
        if (breakout.type === 'SELL') {
            const isCrossingAbove = prevWpr <= CONFIG.WPR_OVERBOUGHT && wpr > CONFIG.WPR_OVERBOUGHT;
            if (isCrossingAbove && assetState.buyFlagActive) {
                LOGGER.signal(`${symbol} NEW BUY BREAKOUT during SELL cycle`);
                if (this.replaceBreakoutLevels(symbol, 'UP', 'BUY')) {
                    assetState.buyFlagActive = false;
                    if (assetState.currentDirection === 'DOWN') return 'UP';
                }
            }
        }
        return null;
    }

    static setWaitingForReentry(symbol, completedDirection = null) {
        const assetState = state.assets[symbol];
        assetState.inTradeCycle = false;
        assetState.waitingForReentry = true;
        if (completedDirection) assetState.lastTradeDirection = completedDirection;
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
        assetState.takeProfit = CONFIG.TAKE_PROFIT;
        assetState.reversalLevel = 0;
        assetState.accumulatedLoss = 0;
        assetState.takeProfitAmount = CONFIG.TAKE_PROFIT;
        assetState.currentStake = this.validateStake(symbol, CONFIG.INITIAL_STAKE);
        return assetState.currentStake;
    }

    static getReversalStake(symbol, previousLoss = 0) {
        const assetState = state.assets[symbol];
        if (assetState.reversalLevel >= CONFIG.MAX_REVERSAL_LEVEL) {
            LOGGER.warn(`${symbol}: Max reversal level reached (${CONFIG.MAX_REVERSAL_LEVEL})`);
            return -1;
        }
        const requestedStake = assetState.currentStake * CONFIG.REVERSAL_STAKE_MULTIPLIER;
        assetState.reversalLevel++;
        if (previousLoss < 0) assetState.accumulatedLoss += Math.abs(previousLoss);
        assetState.takeProfitAmount = assetState.takeProfit + assetState.accumulatedLoss;
        assetState.currentStake = this.validateStake(symbol, requestedStake);
        if (assetState.currentStake <= 0) return 0;
        if (assetState.currentStake + 0.001 < requestedStake) {
            LOGGER.error(`${symbol}: Exact 2x reversal requires $${requestedStake.toFixed(2)}, but only $${assetState.currentStake.toFixed(2)} is allowed/available; reversal aborted`);
            return 0;
        }
        LOGGER.trade(`${symbol} Reversal #${assetState.reversalLevel}/${CONFIG.MAX_REVERSAL_LEVEL}: Stake $${assetState.currentStake.toFixed(2)}`);
        LOGGER.trade(`${symbol} Dynamic TP: $${assetState.takeProfitAmount.toFixed(2)} (Base: $${assetState.takeProfit} + Loss: $${assetState.accumulatedLoss.toFixed(2)})`);
        return assetState.currentStake;
    }

    static fullReset(symbol) {
        const assetState = state.assets[symbol];
        const completedDirection = assetState.currentDirection || assetState.lastTradeDirection;
        LOGGER.recovery(`${symbol} FULL RESET — Trade cycle complete`);
        assetState.currentStake = CONFIG.INITIAL_STAKE;
        assetState.reversalLevel = 0;
        assetState.accumulatedLoss = 0;
        assetState.takeProfitAmount = CONFIG.TAKE_PROFIT;
        assetState.activePosition = null;
        assetState.currentDirection = null;
        assetState.inTradeCycle = false;
        assetState.priceReturnedToZone = false;
        if (assetState.breakout.active) {
            BreakoutManager.setWaitingForReentry(symbol, completedDirection);
        }
    }

    static fullResetWithBreakoutClear(symbol) {
        const assetState = state.assets[symbol];
        LOGGER.recovery(`${symbol} FULL RESET WITH BREAKOUT CLEAR`);
        assetState.currentStake = CONFIG.INITIAL_STAKE;
        assetState.reversalLevel = 0;
        assetState.accumulatedLoss = 0;
        assetState.takeProfitAmount = CONFIG.TAKE_PROFIT;
        assetState.activePosition = null;
        assetState.currentDirection = null;
        assetState.inTradeCycle = false;
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
        const accountFunds = Number(state.accountBalance);
        const availableCapital = accountFunds > 0
            ? Math.min(Number(state.capital), accountFunds)
            : Number(state.capital);
        const stakeFraction = Math.max(0, Math.min(1, CONFIG.MAX_STAKE_FRACTION_OF_CAPITAL));
        stake = Math.max(Number(stake), config.minStake);
        stake = Math.min(stake, config.maxStake);
        stake = Math.min(stake, availableCapital * stakeFraction);
        if (!Number.isFinite(stake) || stake < config.minStake) {
            LOGGER.error(`${symbol}: Cannot afford minimum stake of $${config.minStake.toFixed(2)}`);
            return 0;
        }
        return Number(stake.toFixed(2));
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
        const time = `${String(new Date().getUTCHours()).padStart(2, '0')}:${String(new Date().getUTCMinutes()).padStart(2, '0')} UTC`;
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
        if (isTestRuntime) return;
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
            if (profit > 0) { t.winsCount++; t.profit += profit; t.netPL += profit; }
            else { t.lossesCount++; t.loss += Math.abs(profit); t.netPL += profit; }
        });
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
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE  [MODIFIED for Multiplier]
// ══════════════════════════════════════════════════════════════════════════════
const state = {
    assets: {},
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    currency: 'USD',
    currentTradeDay: null,
    session: {
        profit: 0, loss: 0, netPL: 0,
        tradesCount: 0, winsCount: 0, lossesCount: 0,
        accumulatedLoss: 0, currentProfitTarget: CONFIG.SESSION_PROFIT_TARGET,
        isActive: true, pausedUntil: 0,
        startTime: Date.now(), startCapital: CONFIG.INITIAL_CAPITAL,
    },
    isConnected: false,
    isAuthorized: false,
    portfolio: { dailyProfit: 0, dailyLoss: 0, dailyWins: 0, dailyLosses: 0, activePositions: [] },
    requestId: 1,
};

let tradeHistory = null;
let bot = null;
let isTestRuntime = false;

// ══════════════════════════════════════════════════════════════════════════════
// STATE PERSISTENCE  [MODIFIED for Multiplier]
// ══════════════════════════════════════════════════════════════════════════════
class StatePersistence {
    static saveState() {
        if (isTestRuntime) return;
        try {
            const data = {
                savedAt: Date.now(), capital: state.capital, currency: state.currency,
                session: { ...state.session },
                portfolio: {
                    dailyProfit: state.portfolio.dailyProfit,
                    dailyLoss: state.portfolio.dailyLoss,
                    dailyWins: state.portfolio.dailyWins,
                    dailyLosses: state.portfolio.dailyLosses,
                    activePositions: state.portfolio.activePositions.map(pos => ({
                        symbol: pos.symbol, direction: pos.direction, stake: pos.stake,
                        multiplier: pos.multiplier, entryTime: pos.entryTime,
                        contractId: pos.contractId, reqId: pos.reqId,
                        buyPrice: pos.buyPrice, isReversal: pos.isReversal,
                        reversalLevel: pos.reversalLevel, currentProfit: pos.currentProfit,
                        pendingReversal: pos.pendingReversal,
                        isRecoveryClose: pos.isRecoveryClose,
                        isMaxReversalClose: pos.isMaxReversalClose,
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
                    closedCandles: a.closedCandles.slice(
                        -Math.max(CONFIG.CANDLES_TO_LOAD, CONFIG.WPR_PERIOD + 5)
                    ),
                };
            });
            fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
        } catch (e) { LOGGER.error(`Save state error: ${e.message}`); }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) return false;
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const savedAt = Number(data.savedAt);
            if (!Number.isFinite(savedAt)) throw new Error('State has no valid savedAt timestamp');

            const ageMins = (Date.now() - savedAt) / 60_000;
            if (ageMins > 30) {
                LOGGER.warn(`State is ${ageMins.toFixed(1)}min old — starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            LOGGER.info(`Restoring state from ${Math.max(0, ageMins).toFixed(1)} minutes ago`);
            if (Number.isFinite(Number(data.capital))) state.capital = Number(data.capital);
            if (data.currency) state.currency = String(data.currency);
            state.session = {
                ...state.session,
                ...(data.session || {}),
                startTime: data.session?.startTime || Date.now(),
            };

            const portfolio = data.portfolio || {};
            state.portfolio.dailyProfit = Number(portfolio.dailyProfit) || 0;
            state.portfolio.dailyLoss = Number(portfolio.dailyLoss) || 0;
            state.portfolio.dailyWins = Number(portfolio.dailyWins) || 0;
            state.portfolio.dailyLosses = Number(portfolio.dailyLosses) || 0;
            state.portfolio.activePositions = (portfolio.activePositions || [])
                .filter(pos => {
                    if (pos?.contractId) return true;
                    LOGGER.warn(`Dropping unrestorable pending order for ${pos?.symbol || 'unknown asset'}`);
                    return false;
                })
                .map(pos => ({
                    ...pos,
                    entryTime: pos.entryTime || Date.now(),
                    pendingReversal: pos.pendingReversal ?? null,
                    isRecoveryClose: Boolean(pos.isRecoveryClose),
                    isMaxReversalClose: Boolean(pos.isMaxReversalClose),
                }));

            for (const [symbol, saved] of Object.entries(data.assets || {})) {
                const a = state.assets[symbol];
                if (!a) continue;

                a.wpr = Number.isFinite(Number(saved.wpr)) ? Number(saved.wpr) : null;
                a.prevWpr = Number.isFinite(Number(saved.prevWpr)) ? Number(saved.prevWpr) : null;
                a.buyFlagActive = Boolean(saved.buyFlagActive);
                a.sellFlagActive = Boolean(saved.sellFlagActive);
                const savedBreakout = saved.breakout || {};
                a.breakout = {
                    active: Boolean(savedBreakout.active),
                    type: savedBreakout.type ?? null,
                    highLevel: Number(savedBreakout.highLevel) || 0,
                    lowLevel: Number(savedBreakout.lowLevel) || 0,
                    triggerCandle: Number(savedBreakout.triggerCandle) || 0,
                    canBeReplaced: savedBreakout.canBeReplaced !== false,
                };
                a.currentDirection = saved.currentDirection ?? null;
                a.inTradeCycle = Boolean(saved.inTradeCycle);
                a.waitingForReentry = Boolean(saved.waitingForReentry);
                a.priceReturnedToZone = Boolean(saved.priceReturnedToZone);
                a.lastTradeDirection = saved.lastTradeDirection ?? null;
                a.currentStake = Number(saved.currentStake) || CONFIG.INITIAL_STAKE;
                a.takeProfit = Number(saved.takeProfit) || CONFIG.TAKE_PROFIT;
                a.reversalLevel = Number(saved.reversalLevel) || 0;
                a.accumulatedLoss = Number(saved.accumulatedLoss) || 0;
                a.takeProfitAmount = Number(saved.takeProfitAmount) || CONFIG.TAKE_PROFIT;
                a.dailyTrades = Number(saved.dailyTrades) || 0;
                a.dailyWins = Number(saved.dailyWins) || 0;
                a.dailyLosses = Number(saved.dailyLosses) || 0;
                a.consecutiveLosses = Number(saved.consecutiveLosses) || 0;
                a.indicatorsReady = Boolean(saved.indicatorsReady);
                a.lastProcessedCandleOpenTime = Number(saved.lastProcessedCandleOpenTime) || 0;
                a.activeContract = saved.activeContract ?? null;
                a.unrealizedPnl = Number(saved.unrealizedPnl) || 0;
                if (Array.isArray(saved.closedCandles) && saved.closedCandles.length) {
                    a.closedCandles = saved.closedCandles;
                }

                const activePos = state.portfolio.activePositions.find(p => p.symbol === symbol);
                if (activePos) {
                    a.activePosition = activePos;
                    a.activeContract = activePos.contractId;
                    a.currentDirection = activePos.direction;
                    a.inTradeCycle = true;
                } else if (a.inTradeCycle && !a.waitingForReentry) {
                    // This is the deadlock state produced by rejected orders in
                    // the old build. Release it so WPR analysis can trade again.
                    LOGGER.warn(`${symbol}: Releasing orphaned inTradeCycle lock from saved state`);
                    a.inTradeCycle = false;
                    a.currentDirection = null;
                    a.breakout.canBeReplaced = true;
                }

                const wprText = Number.isFinite(a.wpr) ? a.wpr.toFixed(1) : 'n/a';
                LOGGER.info(`  ${symbol}: BuyArm=${a.buyFlagActive} SellArm=${a.sellFlagActive} InCycle=${a.inTradeCycle} Rev=${a.reversalLevel} WPR=${wprText}`);
            }

            LOGGER.info(`State restored | Capital: $${state.capital.toFixed(2)} | Session P/L: $${Number(state.session.netPL || 0).toFixed(2)}`);
            return true;
        } catch (e) {
            LOGGER.error(`Load state error: ${e.message}`);
            return false;
        }
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
    static dailyTimerStarted = false;
    static hourlyTimerId = null;
    static dailyTimerId = null;

    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED || !message?.length) return;
        if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
            LOGGER.warn('Telegram is enabled but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID is missing');
            return;
        }
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

    static async sendTradeAlert(type, symbol, direction, stake, multiplier, details = {}) {
        const emoji = type === 'OPEN' ? '\u{1f680}' : type === 'WIN' ? '\u2705' : '\u274c';
        const a = state.assets[symbol];
        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();
        const lines = [
            `${emoji} <b>WILL BOT v7.4 — ${type}</b>`,
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
        const emoji = direction === 'UP' ? '\u{1f7e2}' : '\u{1f534}';
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
        const stats = SessionManager.getSessionStats();
        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();
        const wr = overall.tradesCount > 0 ? ((overall.winsCount / overall.tradesCount) * 100).toFixed(1) : '0.0';
        let pairBreakdown = '';
        ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a?.dailyTrades > 0) {
                const pairWr = a.dailyTrades > 0 ? ((a.dailyWins / a.dailyTrades) * 100).toFixed(1) : '0.0';
                pairBreakdown += `\n  ${sym}: ${a.dailyTrades}t ${a.dailyWins}W/${a.dailyLosses}L (${pairWr}%)`;
            }
        });
        await this.sendMessage([
            `\u{1f4ca} <b>WILL v7.4 SESSION SUMMARY</b>`,
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
            `\u{1f916} <b>WILL BOT v7.4 STARTED (Multiplier)</b>`,
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
        const now = new Date();
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
            `\u23f0 <b>WILL v7.4 Hourly</b>`,
            `Today: ${today.tradesCount}t P/L: $${(today.netPL || 0).toFixed(2)}`,
            `Capital: $${state.capital.toFixed(2)}`,
            assetInfo ? `\n<b>Per-Asset:</b>${assetInfo}` : '',
        ].join('\n'));
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
            state.assets[symbol].buyFlagActive = false;
            state.assets[symbol].sellFlagActive = false;
        });
        LOGGER.info(`NEW SESSION STARTED | Capital: $${state.capital.toFixed(2)} | Target: $${CONFIG.SESSION_PROFIT_TARGET}`);
    }

    static getSessionStats() {
        const dur = Date.now() - state.session.startTime;
        const hrs = Math.floor(dur / 3600000);
        const mins = Math.floor((dur % 3600000) / 60000);
        const wr = state.session.tradesCount > 0
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
                `\u{1f319} <b>WILL v7.4 END OF DAY ${state.currentTradeDay}</b>\nP/L: $${(dayStats?.netPL || 0).toFixed(2)}\nCapital: $${state.capital.toFixed(2)}`
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
            state.session.netPL += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            a.dailyWins++;
            a.consecutiveLosses = 0;
            LOGGER.trade(`WIN [${symbol}] +$${profit.toFixed(2)} | ${direction}`);
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.portfolio.dailyLoss += Math.abs(profit);
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
        this._pendingRequests = new Map();
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
        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', data => this.onMessage(data));
        this.ws.on('error', err => this.onError(err));
        this.ws.on('close', () => this.onClose());
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
        state.isAuthorized = true;
        state.accountBalance = Number(this.accountInfo.balance) || 0;
        state.currency = this.accountInfo.currency || state.currency;
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
        ACTIVE_ASSETS.forEach(symbol => {
            if (!state.assets[symbol] && ASSET_CONFIGS[symbol]) {
                state.assets[symbol] = {
                    candles: [], closedCandles: [], currentFormingCandle: null,
                    lastProcessedCandleOpenTime: 0,
                    wpr: null, prevWpr: null,
                    buyFlagActive: false, sellFlagActive: false,
                    breakout: { active: false, type: null, highLevel: 0, lowLevel: 0, triggerCandle: 0, canBeReplaced: true },
                    activePosition: null, activeContract: null, unrealizedPnl: 0,
                    openingTrade: false,
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
            try { if (this.ws.readyState <= 1) this.ws.close(); } catch { }
            this.ws = null;
        }
        this.activeSubscriptions.clear();
        this._subscriptionIds.clear();
        this._pendingRequests.clear();
    }

    onMessage(data) {
        try { this.handleResponse(JSON.parse(data)); }
        catch (e) { LOGGER.error(`Parse error: ${e.message}`); }
    }

    _responseReqId(response) {
        return response?.req_id ?? response?.echo_req?.req_id ?? null;
    }

    _requestContext(response, consume = false) {
        const reqId = this._responseReqId(response);
        if (reqId === null) return null;
        const context = this._pendingRequests.get(reqId) || null;
        if (consume) this._pendingRequests.delete(reqId);
        return context;
    }

    handleResponse(r) {
        if (!r || typeof r !== 'object') return;
        if (r.error && !['authorize', 'candles', 'buy', 'sell', 'proposal_open_contract'].includes(r.msg_type)) {
            const context = this._requestContext(r, true);
            if (context?.type === 'candles' && context.symbol) {
                this.activeSubscriptions.delete(context.symbol);
            }
            LOGGER.error(`Deriv API error${context?.symbol ? ` [${context.symbol}]` : ''}: ${r.error.message || JSON.stringify(r.error)}`);
            return;
        }

        switch (r.msg_type) {
            case 'authorize': this.handleAuthorize(r); break;
            case 'balance':
                state.accountBalance = Number(r.balance?.balance) || state.accountBalance;
                break;
            case 'ohlc': this.handleOHLC(r.ohlc); break;
            case 'candles': this.handleCandlesHistory(r); break;
            case 'buy': this.handleBuyResponse(r); break;
            case 'sell': this.handleSellResponse(r); break;
            case 'proposal_open_contract': this.handleOpenContract(r); break;
            case 'ping': break;
            default:
                if (r.error) LOGGER.error(`Deriv API error: ${r.error.message || JSON.stringify(r.error)}`);
                break;
        }
    }

    handleAuthorize(r) {
        if (r.error) { LOGGER.error(`Auth failed: ${r.error.message}`); return; }
        LOGGER.info(`Authorized: ${r.authorize.loginid} | Balance: ${r.authorize.balance} ${r.authorize.currency}`);
        state.isAuthorized = true;
        state.accountBalance = Number(r.authorize.balance) || 0;
        state.currency = r.authorize.currency || state.currency;
        this.send({ balance: 1, subscribe: 1 });
        this.restoreActiveContracts();
        bot.start();
    }

    // ════════════════════════════════════════════════════════════
    // CANDLE PIPELINE — canonical timestamps, closed/forming split
    // ════════════════════════════════════════════════════════════
    _normaliseCandle(raw, granularity = CONFIG.GRANULARITY) {
        if (!raw) return null;
        const rawEpoch = Number(raw.open_time ?? raw.epoch);
        const openTime = Math.floor(rawEpoch / granularity) * granularity;
        const candle = {
            open: Number(raw.open),
            high: Number(raw.high),
            low: Number(raw.low),
            close: Number(raw.close),
            // Canonical epoch is candle OPEN time for both history and OHLC.
            epoch: openTime,
            open_time: openTime,
            close_time: openTime + granularity,
        };
        if (![candle.open, candle.high, candle.low, candle.close, openTime].every(Number.isFinite) ||
            candle.high < candle.low || candle.open > candle.high || candle.open < candle.low ||
            candle.close > candle.high || candle.close < candle.low) {
            return null;
        }
        return candle;
    }

    _upsertClosedCandle(assetState, candle) {
        const index = assetState.closedCandles.findIndex(c => Number(c.open_time) === candle.open_time);
        if (index >= 0) assetState.closedCandles[index] = candle;
        else assetState.closedCandles.push(candle);
        assetState.closedCandles.sort((left, right) => left.open_time - right.open_time);
        if (assetState.closedCandles.length > CONFIG.MAX_CANDLES_STORED) {
            assetState.closedCandles = assetState.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED);
        }
    }

    handleOHLC(ohlc) {
        const symbol = ohlc?.symbol;
        const assetState = state.assets[symbol];
        if (!symbol || !assetState) return;

        const incoming = this._normaliseCandle(ohlc);
        if (!incoming) {
            LOGGER.error(`[${symbol}] Invalid OHLC update ignored`);
            return;
        }

        const forming = assetState.currentFormingCandle;
        if (forming && incoming.open_time < forming.open_time) {
            LOGGER.debug(`[${symbol}] Out-of-order OHLC update ignored (${incoming.open_time})`);
            return;
        }

        if (forming && incoming.open_time > forming.open_time) {
            const closed = { ...forming, close_time: forming.open_time + CONFIG.GRANULARITY };
            this._upsertClosedCandle(assetState, closed);

            const shouldProcess = closed.open_time > assetState.lastProcessedCandleOpenTime;
            assetState.lastProcessedCandleOpenTime = Math.max(
                assetState.lastProcessedCandleOpenTime,
                closed.open_time
            );

            if (shouldProcess) {
                const direction = closed.close > closed.open ? '\u{1f7e2}' : '\u{1f534}';
                const closeIso = new Date(closed.close_time * 1000).toISOString();
                LOGGER.candle(`${direction} [${symbol}] CLOSED [${closeIso}] O:${closed.open.toFixed(5)} H:${closed.high.toFixed(5)} L:${closed.low.toFixed(5)} C:${closed.close.toFixed(5)} | Total:${assetState.closedCandles.length}`);
                this.updateIndicators(symbol);
                this.processCandleClose(symbol, closed);
            }

            if (incoming.open_time > forming.open_time + CONFIG.GRANULARITY) {
                LOGGER.warn(`[${symbol}] Candle gap detected; refreshing history`);
                this.requestCandleSnapshot(symbol);
            }
        }

        assetState.currentFormingCandle = incoming;
        assetState.candles = [
            ...assetState.closedCandles.slice(-(CONFIG.MAX_CANDLES_STORED - 1)),
            incoming,
        ];
    }

    handleCandlesHistory(r) {
        const context = this._requestContext(r, true);
        const symbol = r.echo_req?.ticks_history || context?.symbol;
        if (r.error) {
            LOGGER.error(`Candles error${symbol ? ` [${symbol}]` : ''}: ${r.error.message}`);
            if (symbol) this.activeSubscriptions.delete(symbol);
            return;
        }
        if (!symbol || !state.assets[symbol]) {
            LOGGER.error('Candle response could not be matched to an asset (missing echo_req/req_id context)');
            return;
        }

        const incoming = (r.candles || [])
            .map(candle => this._normaliseCandle(candle))
            .filter(Boolean)
            .sort((left, right) => left.open_time - right.open_time);
        if (!incoming.length) {
            LOGGER.warn(`[${symbol}] No valid candles received`);
            return;
        }

        const assetState = state.assets[symbol];
        const nowEpoch = Math.floor(Date.now() / 1000);
        const currentBucket = Math.floor(nowEpoch / CONFIG.GRANULARITY) * CONFIG.GRANULARITY;
        const closedIncoming = incoming.filter(candle => candle.open_time < currentBucket);
        const formingIncoming = [...incoming]
            .reverse()
            .find(candle => candle.open_time >= currentBucket) || null;

        // Upsert by candle OPEN time. This replaces stale partial candles and
        // repairs the old build's one-period timestamp shift.
        const candleMap = new Map();
        for (const oldCandle of assetState.closedCandles) {
            const normalised = this._normaliseCandle(oldCandle);
            if (normalised && normalised.open_time < currentBucket) {
                candleMap.set(normalised.open_time, normalised);
            }
        }
        for (const candle of closedIncoming) candleMap.set(candle.open_time, candle);
        assetState.closedCandles = [...candleMap.values()]
            .sort((left, right) => left.open_time - right.open_time)
            .slice(-CONFIG.MAX_CANDLES_STORED);

        const latestClosed = assetState.closedCandles.at(-1);
        if (latestClosed) {
            assetState.lastProcessedCandleOpenTime = Math.max(
                assetState.lastProcessedCandleOpenTime,
                latestClosed.open_time
            );
        }

        // Never replace a newer live OHLC update with an older history snapshot.
        if (formingIncoming &&
            (!assetState.currentFormingCandle ||
                formingIncoming.open_time > assetState.currentFormingCandle.open_time)) {
            assetState.currentFormingCandle = formingIncoming;
        }
        assetState.candles = [
            ...assetState.closedCandles,
            ...(assetState.currentFormingCandle ? [assetState.currentFormingCandle] : []),
        ].slice(-CONFIG.MAX_CANDLES_STORED);

        const wasLoaded = assetState.candlesLoaded;
        assetState.candlesLoaded = true;
        if (!wasLoaded) {
            SignalManager.seedWPRState(symbol);
        } else {
            const series = TechnicalIndicators.calculateWPRSeries(
                assetState.closedCandles,
                CONFIG.WPR_PERIOD
            );
            if (series.length) {
                assetState.prevWpr = series.length > 1 ? series.at(-2).value : null;
                assetState.wpr = series.at(-1).value;
                assetState.indicatorsReady = Number.isFinite(assetState.prevWpr);
            }
        }

        const wprText = Number.isFinite(assetState.wpr) ? assetState.wpr.toFixed(2) : 'warming up';
        LOGGER.info(`[${symbol}] Synced ${closedIncoming.length} closed candle(s) + ${formingIncoming ? 1 : 0} forming | WPR:${wprText} | Stored:${assetState.closedCandles.length}`);
    }

    requestCandleSnapshot(symbol) {
        const reqId = this.send({
            ticks_history: symbol,
            count: CONFIG.CANDLES_TO_LOAD,
            end: 'latest',
            style: 'candles',
            granularity: CONFIG.GRANULARITY,
            subscribe: 0,
        }, { type: 'candles', symbol, snapshot: true });
        return reqId !== null;
    }

    updateIndicators(symbol) {
        const assetState = state.assets[symbol];
        if (!assetState || assetState.closedCandles.length < CONFIG.WPR_PERIOD) return false;

        const nextWpr = TechnicalIndicators.calculateWPR(
            assetState.closedCandles,
            CONFIG.WPR_PERIOD
        );
        if (!Number.isFinite(nextWpr)) return false;

        let previous = assetState.wpr;
        if (!Number.isFinite(previous) && assetState.closedCandles.length > CONFIG.WPR_PERIOD) {
            previous = TechnicalIndicators.calculateWPR(
                assetState.closedCandles.slice(0, -1),
                CONFIG.WPR_PERIOD
            );
        }
        assetState.prevWpr = Number.isFinite(previous) ? previous : null;
        assetState.wpr = nextWpr;
        assetState.indicatorsReady = Number.isFinite(assetState.prevWpr);
        return assetState.indicatorsReady;
    }

    // ════════════════════════════════════════════════════════════
    // TRADE LOGIC — called once for each newly closed candle
    // ════════════════════════════════════════════════════════════
    processCandleClose(symbol, closedCandle) {
        const assetState = state.assets[symbol];
        if (!assetState || assetState.closedCandles.length < CONFIG.MIN_CANDLES_REQUIRED) return;
        if (!state.isConnected || !state.isAuthorized || !assetState.indicatorsReady) return;

        // Match the supplied WILL reference: update WPR state first, then allow
        // an opposite WPR crossing to replace the breakout, then check the
        // candle-close price reversal against the currently active levels.
        const enteredTrade = SignalManager.updateWPRState(symbol);
        if (enteredTrade) return;

        if (assetState.inTradeCycle && assetState.activePosition) {
            const replacementReversal = BreakoutManager.checkForBreakoutReplacement(symbol);
            if (replacementReversal) {
                bot.executeReversal(symbol, replacementReversal);
                return;
            }
        }

        if (assetState.activePosition && assetState.breakout.active) {
            const reversal = BreakoutManager.checkReversal(symbol);
            if (reversal) {
                bot.executeReversal(symbol, reversal);
                return;
            }
        }

        if (assetState.waitingForReentry) {
            const reentry = SignalManager.checkReentrySignal(symbol);
            if (reentry && bot.executeTrade(symbol, reentry, false)) {
                assetState.inTradeCycle = true;
                assetState.waitingForReentry = false;
                assetState.priceReturnedToZone = false;
            }
        }

        const wprText = Number.isFinite(assetState.wpr) ? assetState.wpr.toFixed(2) : 'n/a';
        LOGGER.debug(`[${symbol}] WPR:${wprText} | BuyArm:${assetState.buyFlagActive} | SellArm:${assetState.sellFlagActive} | InCycle:${assetState.inTradeCycle} | Waiting:${assetState.waitingForReentry} | Breakout:${assetState.breakout.type || 'none'}`);
    }

    // ════════════════════════════════════════════════════════════
    // ORDER/CONTRACT LIFECYCLE
    // ════════════════════════════════════════════════════════════
    handleBuyResponse(r) {
        const context = this._requestContext(r, true);
        const reqId = this._responseReqId(r);
        const positionIndex = state.portfolio.activePositions.findIndex(
            position => position.reqId === reqId ||
                (context?.symbol && position.symbol === context.symbol && position.opening)
        );
        const position = positionIndex >= 0 ? state.portfolio.activePositions[positionIndex] : null;

        if (r.error) {
            LOGGER.error(`Trade rejected${context?.symbol ? ` [${context.symbol}]` : ''}: ${r.error.message}`);
            if (position) {
                state.portfolio.activePositions.splice(positionIndex, 1);
                const assetState = state.assets[position.symbol];
                if (assetState) {
                    assetState.activePosition = null;
                    assetState.activeContract = null;
                    assetState.currentDirection = null;
                    assetState.openingTrade = false;
                    if (position.isReversal) {
                        StakeManager.fullResetWithBreakoutClear(position.symbol);
                    } else if (position.fromReentry) {
                        assetState.inTradeCycle = false;
                        assetState.waitingForReentry = true;
                        assetState.priceReturnedToZone = true;
                    } else {
                        BreakoutManager.clearBreakout(position.symbol);
                    }
                }
            }
            StatePersistence.saveState();
            return;
        }

        const contract = r.buy;
        if (!position || !contract?.contract_id) {
            LOGGER.error(`Buy response ${reqId ?? '?'} could not be matched to a pending position`);
            return;
        }

        position.contractId = contract.contract_id;
        position.buyPrice = Number(contract.buy_price) || position.stake;
        position.opening = false;

        const assetState = state.assets[position.symbol];
        assetState.activePosition = position;
        assetState.activeContract = contract.contract_id;
        assetState.unrealizedPnl = 0;
        assetState.openingTrade = false;

        LOGGER.trade(`Position opened: ${contract.contract_id} | Buy price: $${position.buyPrice.toFixed(2)}`);
        if (position.isReversal) {
            TelegramService.sendReversalAlert(
                position.symbol, position.direction, position.stake,
                assetState.accumulatedLoss, position.reversalLevel,
                CONFIG.MAX_REVERSAL_LEVEL,
                assetState.breakout.highLevel, assetState.breakout.lowLevel
            );
        } else {
            TelegramService.sendTradeAlert(
                'OPEN', position.symbol, position.direction,
                position.stake, position.multiplier,
                { breakoutType: assetState.breakout?.type }
            );
        }

        this.send({
            proposal_open_contract: 1,
            contract_id: contract.contract_id,
            subscribe: 1,
        });

        StatePersistence.saveState();
    }

    handleSellResponse(r) {
        const context = this._requestContext(r, true);
        if (r.error) {
            // Match the reference: do not erase pendingReversal on a sell error.
            // The next closed candle can submit the close again if still valid.
            LOGGER.error(`Sell error${context?.symbol ? ` [${context.symbol}]` : ''} (${r.error.code || 'unknown'}): ${r.error.message}`);
            return;
        }

        const sold = r.sell;
        const position = state.portfolio.activePositions.find(
            item => String(item.contractId) === String(sold?.contract_id)
        );
        if (!position) return; // proposal_open_contract may have settled it first.

        const soldFor = Number(sold.sold_for);
        const profit = Number.isFinite(soldFor)
            ? soldFor - Number(position.buyPrice || 0)
            : Number(position.currentProfit || 0);
        LOGGER.trade(`Position closed: ${sold.contract_id} | Sold for: $${Number(soldFor || 0).toFixed(2)}`);
        this._settleContract(sold.contract_id, profit);
    }

    _settleContract(contractId, rawProfit, subscriptionId = null) {
        const positionIndex = state.portfolio.activePositions.findIndex(
            item => String(item.contractId) === String(contractId)
        );
        if (positionIndex < 0) return false;

        const position = state.portfolio.activePositions[positionIndex];
        const symbol = position.symbol;
        const assetState = state.assets[symbol];
        // Store all close-routing flags BEFORE removing the old position. This
        // is the critical fix used by the supplied reference bot.
        const pendingReversalDirection = position.pendingReversal;
        const isReversalPending = Boolean(pendingReversalDirection);
        const isRecoveryClose = Boolean(position.isRecoveryClose);
        const isMaxReversalClose = Boolean(position.isMaxReversalClose);
        const profit = Number(rawProfit);
        if (!Number.isFinite(profit)) {
            LOGGER.error(`${symbol}: Contract ${contractId} closed with invalid profit`);
            return false;
        }

        state.portfolio.activePositions.splice(positionIndex, 1);
        SessionManager.recordTradeResult(symbol, profit, position.direction);
        let recoveryContinues = false;

        if (assetState) {
            assetState.activePosition = null;
            assetState.activeContract = null;
            assetState.unrealizedPnl = 0;
            assetState.openingTrade = false;
            assetState.lastTradeDirection = position.direction;
            assetState.currentDirection = position.direction;

            TelegramService.sendTradeAlert(
                profit >= 0 ? 'WIN' : 'LOSS',
                symbol, position.direction, position.stake, position.multiplier, { profit }
            );

            if (isRecoveryClose) {
                LOGGER.recovery(`${symbol}: Recovery close completed. Profit: $${profit.toFixed(2)}`);
                StakeManager.fullReset(symbol);
            } else if (isReversalPending) {
                const previousLoss = profit < 0 ? profit : 0;
                assetState.currentDirection = null;

                LOGGER.trade(`REVERSAL TRIGGERED: ${symbol} → ${pendingReversalDirection}`);
                LOGGER.trade(`Previous Loss: $${Math.abs(previousLoss).toFixed(2)}`);
                LOGGER.trade(`Current Reversal Level: ${assetState.reversalLevel}`);
                LOGGER.trade(`Next Stake: $${(assetState.currentStake * CONFIG.REVERSAL_STAKE_MULTIPLIER).toFixed(2)}`);

                // Execute immediately in the sell/closed-contract handler — no
                // timeout and no deferred queue, matching the correct reference.
                const opened = bot.executeTrade(
                    symbol,
                    pendingReversalDirection,
                    true,
                    previousLoss
                );
                if (opened) {
                    recoveryContinues = true;
                    LOGGER.trade(`Reversal trade request sent for ${symbol}`);
                } else {
                    LOGGER.error(`${symbol}: Reversal order could not be sent — clearing cycle to avoid deadlock`);
                    StakeManager.fullResetWithBreakoutClear(symbol);
                }
            } else if (isMaxReversalClose) {
                LOGGER.warn(`${symbol}: Maximum reversals reached — cycle cleared`);
                StakeManager.fullResetWithBreakoutClear(symbol);
            } else if (profit > 0 &&
                (assetState.reversalLevel === 0 || profit >= assetState.accumulatedLoss)) {
                StakeManager.fullReset(symbol);
            } else {
                // Stop-out, manual close, incomplete recovery, or another close
                // with no queued reversal must never leave inTradeCycle locked.
                LOGGER.warn(`${symbol}: Cycle ended without a completed recovery — clearing breakout`);
                StakeManager.fullResetWithBreakoutClear(symbol);
            }
        }

        // As in the working reference bot, do not end/pause the session between
        // the stopped trade and its recovery entry. Evaluate session targets
        // only when the recovery cycle has actually finished.
        if (!recoveryContinues) SessionManager.checkSessionTargets();
        StatePersistence.saveState();

        const idToForget = subscriptionId || this._subscriptionIds.get(String(contractId));
        if (idToForget) this.send({ forget: idToForget });
        this._subscriptionIds.delete(String(contractId));
        return true;
    }

    handleOpenContract(r) {
        if (r.error) {
            LOGGER.error(`Contract error: ${r.error.message}`);
            return;
        }

        const contract = r.proposal_open_contract;
        if (!contract?.contract_id) return;
        const contractId = String(contract.contract_id);
        if (r.subscription?.id) this._subscriptionIds.set(contractId, r.subscription.id);

        const isClosed = Boolean(contract.is_sold || contract.is_expired ||
            ['sold', 'won', 'lost'].includes(contract.status));
        if (isClosed) {
            const profit = Number(contract.profit);
            LOGGER.trade(`Contract ${contractId} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${Number(profit || 0).toFixed(2)}`);
            this._settleContract(contract.contract_id, profit, r.subscription?.id);
            return;
        }

        const position = state.portfolio.activePositions.find(
            item => String(item.contractId) === contractId
        );
        if (!position) return;

        position.currentProfit = Number(contract.profit) || 0;
        position.currentPrice = Number(contract.current_spot) || contract.current_spot;
        const assetState = state.assets[position.symbol];
        if (assetState) {
            assetState.unrealizedPnl = position.currentProfit;
            assetState.currentPrice = position.currentPrice;
        }

        // The previous build force-closed a contract after 20 identical P/L
        // updates. Flat P/L is not a stalled connection, so that logic was
        // removed. WebSocket ping/reconnect handles actual connection stalls.
        if (assetState && StakeManager.shouldAutoClose(position.symbol, position.currentProfit)) {
            LOGGER.recovery(`${position.symbol}: Auto close — profit covers accumulated loss`);
            position.isRecoveryClose = true;
            StatePersistence.saveState();
            this.send(
                { sell: position.contractId, price: 0 },
                { type: 'sell', symbol: position.symbol, contractId: position.contractId }
            );
        }
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
            TelegramService.sendMessage(`\u26a0\ufe0f <b>WILL v7.4 CONNECTION LOST</b> — Reconnecting (attempt ${this.reconnectAttempts})`);
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (this.isShuttingDown) return;
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached');
            TelegramService.sendMessage(`\u{1f6d1} <b>WILL v7.4 BOT STOPPED</b> — Max reconnections\nP/L: $${(state.session.netPL || 0).toFixed(2)}`);
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

    send(data, context = null) {
        if (this.ws?.readyState !== WebSocket.OPEN) {
            LOGGER.error('Cannot send: WebSocket not open');
            return null;
        }
        const payload = { ...data, req_id: state.requestId++ };
        if (context) this._pendingRequests.set(payload.req_id, context);
        try {
            this.ws.send(JSON.stringify(payload));
        } catch (e) {
            this._pendingRequests.delete(payload.req_id);
            LOGGER.error(`Send error: ${e.message}`);
            return null;
        }
        return payload.req_id;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS — v7 WILL Multiplier
// ══════════════════════════════════════════════════════════════════════════════
class IndexBot {
    constructor() {
        this.connection = new ConnectionManager();
        this._processedContracts = new Set();
        this._tradeLocked = false;
        this._started = false;
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
        const firstStart = !this._started;
        this._started = true;

        this.connection.initializeAssets();
        ACTIVE_ASSETS.forEach(symbol => this.subscribeToAssets(symbol));

        if (!firstStart) {
            LOGGER.info('Connection restored — market streams and contracts resubscribed');
            return;
        }

        console.log('\n' + '═'.repeat(74));
        console.log(' DERIV MULTIPLIER BOT v7.4 — WILL (fixed candle/WPR pipeline)');
        console.log('═'.repeat(74));
        console.log(`Assets    : ${ACTIVE_ASSETS.join(', ')}`);
        console.log(`Account   : ${CONFIG.ACCOUNT_TYPE.toUpperCase()} | Currency: ${state.currency}`);
        console.log(`Timeframe : ${CONFIG.TIMEFRAME_LABEL} closed candles`);
        console.log(`Strategy  : WPR(${CONFIG.WPR_PERIOD}) ${CONFIG.WPR_OVERBOUGHT}/${CONFIG.WPR_OVERSOLD} → Breakout → Reversal`);
        console.log(`Stake     : $${CONFIG.INITIAL_STAKE} | TP: $${CONFIG.TAKE_PROFIT} | Max reversals: ${CONFIG.MAX_REVERSAL_LEVEL}`);
        console.log(`Capital   : $${state.capital.toFixed(2)}`);
        console.log('═'.repeat(74) + '\n');

        state.currentTradeDay = TradeHistoryManager.getDateKey();
        TradeHistoryManager.ensureDayEntry(state.currentTradeDay);
        await TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();
        TelegramService.startDailyTimer();
        this.startSessionTimeChecker();
        LOGGER.info('WILL Bot v7.4 fully started');
    }

    subscribeToAssets(symbol) {
        if (this.connection.activeSubscriptions.has(symbol)) return true;
        LOGGER.info(`Subscribing to ${symbol} (${CONFIG.TIMEFRAME_LABEL})...`);

        // One request supplies both the initial history and subsequent OHLC
        // updates. The old two-request approach raced and reset the forming candle.
        const reqId = this.connection.send({
            ticks_history: symbol,
            count: CONFIG.CANDLES_TO_LOAD,
            end: 'latest',
            style: 'candles',
            granularity: CONFIG.GRANULARITY,
            subscribe: 1,
        }, { type: 'candles', symbol });

        if (reqId === null) return false;
        this.connection.activeSubscriptions.add(symbol);
        return true;
    }

    // ════════════════════════════════════════════════════════════
    // executeTrade — Multiplier contract (FROM REFERENCE BOT)
    // ════════════════════════════════════════════════════════════
    executeTrade(symbol, direction, isReversal = false, previousLoss = 0) {
        // Match the working reference bot: a reversal/recovery order must not
        // be blocked by a paused session or a target crossed by the loss that
        // was just realised. Normal WPR entries still obey session controls.
        if (!isReversal && !SessionManager.isSessionActive()) {
            LOGGER.warn(`${symbol}: Trade blocked — session is paused`);
            return false;
        }
        if (isReversal && !SessionManager.isSessionActive()) {
            LOGGER.warn(`${symbol}: Session is paused, but the pending recovery reversal is allowed`);
        }
        if (!state.isConnected || !state.isAuthorized ||
            this.connection.ws?.readyState !== WebSocket.OPEN) {
            LOGGER.warn(`${symbol}: Trade blocked — connection is not ready`);
            return false;
        }
        if (state.portfolio.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) {
            LOGGER.warn('Trade blocked — maximum open positions reached');
            return false;
        }

        const config = ASSET_CONFIGS[symbol];
        const assetState = state.assets[symbol];
        if (!config || !assetState || !['UP', 'DOWN'].includes(direction)) return false;
        if (assetState.dailyTrades >= Math.min(CONFIG.MAX_TRADES_PER_ASSET, config.maxTradesPerDay)) {
            LOGGER.warn(`${symbol}: Daily trade limit reached`);
            return false;
        }

        const hasExisting = state.portfolio.activePositions.some(position => position.symbol === symbol);
        if (hasExisting || assetState.openingTrade) {
            LOGGER.warn(`Trade blocked: position/order already active on ${symbol}`);
            return false;
        }

        const stakeSnapshot = {
            currentStake: assetState.currentStake,
            takeProfit: assetState.takeProfit,
            reversalLevel: assetState.reversalLevel,
            accumulatedLoss: assetState.accumulatedLoss,
            takeProfitAmount: assetState.takeProfitAmount,
        };
        const fromReentry = !isReversal && assetState.waitingForReentry;
        let stake;

        if (isReversal) {
            stake = StakeManager.getReversalStake(symbol, previousLoss);
            if (stake === -1) {
                LOGGER.warn(`${symbol}: Maximum reversals reached — ending trade cycle`);
                StakeManager.fullResetWithBreakoutClear(symbol);
                return false;
            }
        } else {
            stake = StakeManager.getInitialStake(symbol);
        }
        if (stake <= 0) {
            Object.assign(assetState, stakeSnapshot);
            LOGGER.error(`Cannot trade ${symbol}: insufficient available balance`);
            return false;
        }

        const contractType = direction === 'UP' ? 'MULTUP' : 'MULTDOWN';
        const multiplier = StakeManager.getMultiplier(symbol);
        const tradeRequest = {
            buy: 1,
            subscribe: 1,
            price: stake,
            parameters: {
                contract_type: contractType,
                symbol,
                currency: state.currency || 'USD',
                amount: stake,
                multiplier,
                basis: 'stake',
            },
        };
        if (assetState.takeProfitAmount > 0) {
            tradeRequest.parameters.limit_order = {
                take_profit: Number(assetState.takeProfitAmount.toFixed(2)),
            };
        }

        const reqId = this.connection.send(
            tradeRequest,
            { type: 'buy', symbol, isReversal }
        );
        if (reqId === null) {
            Object.assign(assetState, stakeSnapshot);
            return false;
        }

        const position = {
            symbol,
            direction,
            stake,
            multiplier,
            entryTime: Date.now(),
            contractId: null,
            reqId,
            currentProfit: 0,
            buyPrice: 0,
            isReversal,
            fromReentry,
            reversalLevel: assetState.reversalLevel,
            pendingReversal: null,
            isRecoveryClose: false,
            isMaxReversalClose: false,
            opening: true,
        };
        state.portfolio.activePositions.push(position);
        assetState.activePosition = position;
        assetState.currentDirection = direction;
        assetState.openingTrade = true;
        assetState.dailyTrades++;

        LOGGER.trade(`${isReversal ? 'REVERSAL' : fromReentry ? 'RE-ENTRY' : 'NEW'} ${direction} on ${config.name} | Stake:$${stake.toFixed(2)} | x${multiplier} | Rev:${assetState.reversalLevel}/${CONFIG.MAX_REVERSAL_LEVEL}`);
        LOGGER.trade(`Breakout: ${assetState.breakout.type || 'none'} | H:${Number(assetState.breakout.highLevel || 0).toFixed(5)} | L:${Number(assetState.breakout.lowLevel || 0).toFixed(5)}`);
        StatePersistence.saveState();
        return true;
    }

    // ════════════════════════════════════════════════════════════
    // executeReversal — close current, pending reversal on close
    // ════════════════════════════════════════════════════════════
    executeReversal(symbol, newDirection) {
        const assetState = state.assets[symbol];
        const position = assetState?.activePosition;

        if (!position || !position.contractId) {
            LOGGER.warn(`No active position to reverse on ${symbol}`);
            return false;
        }
        if (!['UP', 'DOWN'].includes(newDirection) || position.direction === newDirection) {
            return false;
        }

        if (assetState.reversalLevel >= CONFIG.MAX_REVERSAL_LEVEL) {
            LOGGER.warn(`${symbol}: Max reversals (${CONFIG.MAX_REVERSAL_LEVEL}) reached — closing position`);
            position.isMaxReversalClose = true;
            StatePersistence.saveState();
            const reqId = this.connection.send(
                { sell: position.contractId, price: 0 },
                { type: 'sell', reason: 'MAX_REVERSAL', symbol, contractId: position.contractId }
            );
            if (reqId === null) position.isMaxReversalClose = false;
            return reqId !== null;
        }

        LOGGER.trade(`REVERSING ${symbol}: ${position.direction} → ${newDirection} (#${assetState.reversalLevel + 1}/${CONFIG.MAX_REVERSAL_LEVEL})`);

        // Critical reference-bot behaviour: put the next direction on the OLD
        // position before requesting its sale, and persist it before any sell/
        // proposal_open_contract response can remove that position.
        position.pendingReversal = newDirection;
        StatePersistence.saveState();

        const reqId = this.connection.send(
            { sell: position.contractId, price: 0 },
            { type: 'sell', reason: 'REVERSAL', symbol, contractId: position.contractId }
        );
        if (reqId === null) {
            position.pendingReversal = null;
            StatePersistence.saveState();
            return false;
        }
        LOGGER.trade(`${symbol}: Reversal close request sent | Contract:${position.contractId} | Req:${reqId}`);
        return true;
    }

    async closeAllPositions() {
        LOGGER.info('Closing all positions...');
        for (const position of state.portfolio.activePositions) {
            if (position.contractId) {
                this.connection.send(
                    { sell: position.contractId, price: 0 },
                    { type: 'sell', symbol: position.symbol, contractId: position.contractId }
                );
                LOGGER.info(`Closing: ${position.symbol} ${position.direction}`);
            }
        }
    }

    stop() {
        LOGGER.info('Stopping bot...');
        this.closeAllPositions();
        TelegramService.clearTimers();
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
function installProcessHandlers() {
    process.on('SIGINT', () => {
        bot?.stop();
        bot?.connection.shutdown();
        setTimeout(() => process.exit(0), 3000);
    });
    process.on('SIGTERM', () => {
        bot?.stop();
        bot?.connection.shutdown();
        setTimeout(() => process.exit(0), 3000);
    });
    process.on('uncaughtException', error => {
        LOGGER.error(`UNCAUGHT: ${error.message}\n${error.stack}`);
        try { StatePersistence.saveState(); } catch { }
    });
    process.on('unhandledRejection', reason => {
        LOGGER.error(`UNHANDLED: ${reason?.stack || reason}`);
        try { StatePersistence.saveState(); } catch { }
    });
}

function startStatusDisplay(activeBot) {
    const statusInterval = setInterval(() => {
        if (!state.isAuthorized) return;
        const status = activeBot.getStatus();
        let pairLines = '';
        for (const symbol of ACTIVE_ASSETS) {
            const pair = status.pairs[symbol];
            if (!pair) continue;
            const wpr = Number.isFinite(pair.wpr) ? `WPR:${pair.wpr.toFixed(1)}` : 'WPR:warming';
            const breakout = pair.breakoutType ? `Bk:${pair.breakoutType}` : '';
            const mode = pair.inCycle ? '\u{1f504}' : (pair.waiting ? '\u23f8\ufe0f' : '-');
            pairLines += `\n  ${symbol}: ${wpr} ${pair.buyFlag ? '\u{1f7e2}BA' : ''} ${pair.sellFlag ? '\u{1f534}SA' : ''} ${breakout} Rev${pair.reversalLevel} $${Number(pair.currentStake || 0).toFixed(2)} | ${pair.trades}t ${pair.wins}W/${pair.losses}L ${mode}`;
        }
        console.log(`\n\u{1f4ca} ${getGMTTime()} | Session:${status.session.trades}t ${status.session.winRate} $${Number(status.session.netPL || 0).toFixed(2)} | Capital:$${status.capital.toFixed(2)}`);
        console.log(`\u{1f4cb} Overall:${status.overall.tradesCount}t | P/L:$${Number(status.overall.netPL || 0).toFixed(2)}`);
        console.log(`\u{1f4c8} Assets:${pairLines}`);
    }, 60_000);
    activeBot.statusDisplayIntervalId = statusInterval;
}

function main() {
    if (!CONFIG.API_TOKEN || !CONFIG.APP_ID) {
        console.error('\nSet DERIV_API_TOKEN and DERIV_APP_ID in .env before running.\n');
        process.exitCode = 1;
        return null;
    }
    if (!['demo', 'real'].includes(CONFIG.ACCOUNT_TYPE)) {
        console.error('\nDERIV_ACCOUNT_TYPE must be either demo or real.\n');
        process.exitCode = 1;
        return null;
    }

    tradeHistory = TradeHistoryManager.loadHistory();
    bot = new IndexBot();

    // Assets must exist before state loading and active-contract restoration.
    // The old order silently discarded every saved per-asset field.
    bot.connection.initializeAssets();
    const stateLoaded = StatePersistence.loadState();
    LOGGER.info(stateLoaded ? 'Resuming from saved state' : 'Starting fresh session');

    installProcessHandlers();
    startStatusDisplay(bot);
    console.log('\n\u{1f680} Starting WILL Bot v7.4 (Multiplier)...\n');
    bot.connection.connect();
    return bot;
}

if (require.main === module) main();

module.exports = {
    CONFIG,
    ACTIVE_ASSETS,
    ASSET_CONFIGS,
    TechnicalIndicators,
    SignalManager,
    BreakoutManager,
    StakeManager,
    ConnectionManager,
    IndexBot,
    StatePersistence,
    state,
    main,
    // Test hooks are intentionally prefixed and are not used by live runtime.
    _setBotForTests(testBot) { bot = testBot; },
    _initialiseForTests() {
        isTestRuntime = true;
        tradeHistory = TradeHistoryManager._emptyHistory();
        state.assets = {};
        state.portfolio = {
            dailyProfit: 0, dailyLoss: 0, dailyWins: 0, dailyLosses: 0,
            activePositions: [],
        };
        state.session = {
            profit: 0, loss: 0, netPL: 0,
            tradesCount: 0, winsCount: 0, lossesCount: 0,
            accumulatedLoss: 0,
            currentProfitTarget: CONFIG.SESSION_PROFIT_TARGET,
            isActive: true, pausedUntil: 0,
            startTime: Date.now(), startCapital: CONFIG.INITIAL_CAPITAL,
        };
        state.capital = CONFIG.INITIAL_CAPITAL;
        state.accountBalance = CONFIG.INITIAL_CAPITAL;
        state.isConnected = false;
        state.isAuthorized = false;
        const connection = new ConnectionManager();
        connection.initializeAssets();
        return connection;
    },
};
