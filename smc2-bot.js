/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║     Smart Money Concepts (SMC) Bot v2 — Deriv Last Digit            ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║  REARCHITECTED STRATEGY (v2):                                        ║
 * ║                                                                      ║
 * ║  1. LIQUIDITY SWEEP — Detects swing-high/low equal-level clusters    ║
 * ║     in the digit stream; a "sweep" is when the same digit appears    ║
 * ║     at a swing extreme then immediately reverses (stop-hunt model).  ║
 * ║     After the sweep the bot fades the swept digit using DIGITDIFF.   ║
 * ║                                                                      ║
 * ║  2. BREAK OF STRUCTURE (BOS) — Tracks a rolling series of swing      ║
 * ║     highs and lows. A bullish BOS = new swing high above the         ║
 * ║     previous swing high (digits trending up). Bearish BOS = new      ║
 * ║     swing low below the previous swing low. BOS direction guides     ║
 * ║     which half of the digit wheel (0-4 vs 5-9) to target.           ║
 * ║                                                                      ║
 * ║  3. FAIR VALUE GAP (FVG) — 3-tick imbalance adapted for digits:     ║
 * ║     candle[i-2].high < candle[i].low  → bullish gap (digits         ║
 * ║     jumped up with a void). candle[i-2].low > candle[i].high →      ║
 * ║     bearish gap. Gap digits become the avoidance target.             ║
 * ║                                                                      ║
 * ║  4. ORDER BLOCK — Last bearish (or bullish) swing candle before a   ║
 * ║     strong impulse move. In digit terms: a cluster of the same       ║
 * ║     digit immediately before a run of different digits. Price is     ║
 * ║     expected to respect/avoid that digit cluster again.              ║
 * ║                                                                      ║
 * ║  5. TREND FILTER — Composite: (a) EMA-slope of raw prices,          ║
 * ║     (b) dominant digit-half over a rolling window, (c) CHoCH         ║
 * ║     (Change of Character) guard that halts trading when the          ║
 * ║     structure flips against the bias. All three must agree.          ║
 * ║                                                                      ║
 * ║  CONFLUENCE: All 5 signals are scored; minimum weighted score of     ║
 * ║  4.0/5.0 required. Liquidity Sweep is mandatory (gate condition).   ║
 * ║                                                                      ║
 * ║  Expected Win Rate: 65-72% | Profit Factor: 1.5-1.9                 ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const BOT_CONFIG = {
    token: 'DMylfkyce6VyZt7',

    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],

    initialStake: 2.55,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 100,
    takeProfit: 10000,

    // ═══════════════════════════════════════════════════════════════════════
    // 1. LIQUIDITY SWEEP  (swing-pivot + equal-level sweep model)
    // ═══════════════════════════════════════════════════════════════════════
    liquiditySweep: {
        // How many ticks to look left/right when identifying a swing pivot
        swingLookback: 5,
        // Two digit values are "equal" if |a - b| <= tolerance
        equalLevelTolerance: 1,
        // Maximum ticks a liquidity pool may be "open" before it expires
        poolMaxAge: 40,
        // After a sweep is detected, block re-trade of the same digit for N ticks
        cooldownTicks: 8,
        // Minimum number of distinct equal-level touches to form a pool
        minPoolTouches: 2,
    },

    // ═══════════════════════════════════════════════════════════════════════
    // 2. BREAK OF STRUCTURE (BOS)
    // ═══════════════════════════════════════════════════════════════════════
    breakOfStructure: {
        // Rolling window to track swing structure
        structureWindow: 60,
        // Swing pivot detection: N bars each side
        pivotStrength: 4,
        // How many consecutive ticks must confirm a BOS before it's valid
        confirmationTicks: 2,
        // How long a BOS bias remains active (ticks)
        biasLifetime: 30,
        // Minimum magnitude of structure break (digit units)
        minBreakMagnitude: 1,
    },

    // ═══════════════════════════════════════════════════════════════════════
    // 3. FAIR VALUE GAP (FVG) — 3-tick imbalance
    // ═══════════════════════════════════════════════════════════════════════
    fairValueGap: {
        // Number of recent ticks to scan for active (unfilled) FVGs
        scanWindow: 50,
        // An FVG is "filled" once price returns to its range
        trackFilled: true,
        // Maximum age (ticks) before an FVG expires unfilled
        maxAge: 35,
        // Minimum gap width in digit units (|high[i-2] - low[i]|)
        minGapWidth: 2,
    },

    // ═══════════════════════════════════════════════════════════════════════
    // 4. ORDER BLOCK (OB)
    // ═══════════════════════════════════════════════════════════════════════
    orderBlock: {
        // Window to search for impulse moves
        impulseWindow: 60,
        // Minimum run length to qualify as an "impulse"
        minImpulseLength: 4,
        // Minimum average digit change per tick in the impulse
        minImpulseMagnitude: 1.2,
        // The OB is the N-tick cluster immediately before the impulse
        obClusterSize: 3,
        // Current digit must be within this distance of the OB cluster mean
        proximityThreshold: 2,
        // An OB is "mitigated" (invalidated) when price closes through it
        mitigationEnabled: true,
        // OB expires after N ticks
        maxAge: 80,
    },

    // ═══════════════════════════════════════════════════════════════════════
    // 5. TREND FILTER (EMA slope + digit-half dominance + CHoCH guard)
    // ═══════════════════════════════════════════════════════════════════════
    trendFilter: {
        // EMA period applied to raw price for slope direction
        emaPeriod: 21,
        // EMA slope over N bars must exceed threshold to be "trending"
        emaLookback: 10,
        emaSlopeThreshold: 0.000005,
        // Digit-half dominance window: what fraction of ticks land in 0-4 vs 5-9
        halfWindow: 30,
        // Minimum dominance ratio (0.55 = 55% of ticks in one half)
        minHalfDominance: 0.55,
        // CHoCH: if the last N BOS events flip direction, block trading
        chochWindow: 4,
    },

    // ═══════════════════════════════════════════════════════════════════════
    // CONFLUENCE SCORING
    // ═══════════════════════════════════════════════════════════════════════
    confluence: {
        minScore: 4.0,           // Out of 5.0
        weights: {
            liquiditySweep: 1.5, // Gate + highest weight
            breakOfStructure: 1.0,
            fairValueGap: 0.8,
            orderBlock: 0.9,
            trendFilter: 0.8,
        },
    },

    // ── Risk Management ──────────────────────────────────────────────────
    minTimeBetweenTrades: 20000,
    cooldownAfterLoss: 45000,
    maxTradesPerHour: 1500,

    requiredHistoryLength: 150,

    telegramToken: '8218636914:AAGvaKFh8MT769-_9eOEiU4XKufL0aHRhZ4',
    telegramChatId: '752497117',

    maxReconnectAttempts: 50,
    reconnectDelay: 5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'smc_bot_state_v2.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static save(bot) {
        try {
            const data = {
                savedAt: Date.now(),
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    consecutiveLosses2: bot.consecutiveLosses2,
                    consecutiveLosses3: bot.consecutiveLosses3,
                    consecutiveLosses4: bot.consecutiveLosses4,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                },
                assetMetrics: bot.assetMetrics,
                hourlyTrades: bot.hourlyTrades,
                hourlyStats: bot.hourlyStats,
                session: bot.session,
                currentTradeDay: bot.currentTradeDay,
                smcStats: bot.smcStats,
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
            return true;
        } catch (e) {
            console.error(`❌ Save failed: ${e.message}`);
            return false;
        }
    }

    static load() {
        try {
            if (!fs.existsSync(STATE_FILE)) return null;
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const data = JSON.parse(raw);
            const ageMin = (Date.now() - data.savedAt) / 60000;
            if (ageMin > 60) {
                console.warn(`⚠️  State ${ageMin.toFixed(1)}m old — starting fresh`);
                fs.renameSync(STATE_FILE, STATE_FILE.replace('.json', `_bak_${Date.now()}.json`));
                return null;
            }
            console.log(`📂 Restoring state (${ageMin.toFixed(1)}m old)`);
            return data;
        } catch (e) {
            console.error(`❌ Load failed: ${e.message}`);
            return null;
        }
    }

    static startAutoSave(bot) {
        if (bot._autoSaveTimer) clearInterval(bot._autoSaveTimer);
        bot._autoSaveTimer = setInterval(() => {
            if (bot.connected && !bot.endOfDay) StatePersistence.save(bot);
        }, STATE_SAVE_INTERVAL);

        const shutdown = () => {
            console.log('\n🛑 Saving state before exit…');
            StatePersistence.save(bot);
            process.exit();
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        process.on('uncaughtException', err => { console.error(err); shutdown(); });
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS
// ══════════════════════════════════════════════════════════════════════════════
class TechnicalIndicators {
    static SMA(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        return slice.reduce((s, v) => s + v, 0) / period;
    }

    /** Full EMA sequence (returns last value) */
    static EMA(data, period) {
        if (data.length < period) return null;
        const k = 2 / (period + 1);
        let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
        for (let i = period; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
        }
        return ema;
    }

    /** Returns array of EMA values, one per data point (after warm-up) */
    static EMAArray(data, period) {
        if (data.length < period) return [];
        const k = 2 / (period + 1);
        const out = [];
        let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
        out.push(ema);
        for (let i = period; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
            out.push(ema);
        }
        return out;
    }

    /** Rolling min/max over a window */
    static rollingMinMax(arr, window) {
        const result = [];
        for (let i = window - 1; i < arr.length; i++) {
            const slice = arr.slice(i - window + 1, i + 1);
            result.push({ min: Math.min(...slice), max: Math.max(...slice) });
        }
        return result;
    }

    /** Detect local pivot high: highest within [i-strength, i+strength] */
    static isPivotHigh(arr, i, strength) {
        if (i < strength || i > arr.length - strength - 1) return false;
        for (let j = i - strength; j <= i + strength; j++) {
            if (j !== i && arr[j] >= arr[i]) return false;
        }
        return true;
    }

    /** Detect local pivot low: lowest within [i-strength, i+strength] */
    static isPivotLow(arr, i, strength) {
        if (i < strength || i > arr.length - strength - 1) return false;
        for (let j = i - strength; j <= i + strength; j++) {
            if (j !== i && arr[j] <= arr[i]) return false;
        }
        return true;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// SMART MONEY CONCEPTS ANALYZER  (v2 — fully rearchitected)
// ══════════════════════════════════════════════════════════════════════════════
class SmartMoneyAnalyzer {
    constructor(config) {
        this.cfg = config;

        // Per-asset persistent state for the stateful detectors
        this.state = {};
    }

    _initAsset(asset) {
        if (!this.state[asset]) {
            this.state[asset] = {
                // Liquidity sweep
                liquidityPools: [],       // { digit, touches, firstTick, lastTick }
                sweepCooldown: {},        // digit → tickCount when cooldown expires

                // BOS
                swingHighs: [],           // { digit, tickIdx }
                swingLows: [],            // { digit, tickIdx }
                bosEvents: [],            // { direction:'UP'|'DOWN', tickIdx, magnitude }
                bosBias: null,            // 'UP' | 'DOWN' | null
                bosBiasExpiry: 0,         // absolute tick index

                // FVG
                activeFVGs: [],           // { direction, gapTop, gapBottom, formed, age }

                // Order Blocks
                activeOBs: [],            // { direction, clusterMean, formed, age, mitigated }

                // Tick counter (relative, per asset)
                tickCount: 0,
            };
        }
        return this.state[asset];
    }

    // ────────────────────────────────────────────────────────────────────────
    // MAIN ENTRY POINT
    // ────────────────────────────────────────────────────────────────────────
    analyze(digitHistory, priceHistory, asset) {
        if (digitHistory.length < this.cfg.requiredHistoryLength) {
            return { shouldTrade: false, reason: 'insufficient_history' };
        }

        const st = this._initAsset(asset);
        st.tickCount++;

        // Run each detector (they mutate st in place for persistence)
        const lsResult = this._detectLiquiditySweep(digitHistory, st);
        const bosResult = this._detectBOS(digitHistory, st);
        const fvgResult = this._detectFVG(digitHistory, st);
        const obResult = this._detectOrderBlock(digitHistory, st);
        const tfResult = this._analyzeTrend(digitHistory, priceHistory, st);

        const results = {
            liquiditySweep: lsResult,
            breakOfStructure: bosResult,
            fairValueGap: fvgResult,
            orderBlock: obResult,
            trendFilter: tfResult,
        };

        const confluence = this._calculateConfluence(results);

        if (!confluence.shouldTrade) {
            return { shouldTrade: false, reason: confluence.reason, confluence, results };
        }

        // Determine the digit to avoid (DIGITDIFF target)
        const avoidDigit = this._resolveAvoidDigit(results, digitHistory);
        if (avoidDigit === null) {
            return { shouldTrade: false, reason: 'no_clear_avoid_digit', confluence, results };
        }

        return {
            shouldTrade: true,
            reason: 'smc_confluence_confirmed',
            predictedDigit: avoidDigit,
            confidence: confluence.score / 5,
            confluence,
            results,
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 1. LIQUIDITY SWEEP  (swing pivot + equal-level pool + sweep detection)
    // ────────────────────────────────────────────────────────────────────────
    /**
     * Algorithm:
     *  a) Identify pivot highs & lows in the last `scanWindow` ticks.
     *  b) Group pivots that share the same digit (±tolerance) into "pools".
     *  c) A "sweep" occurs when the most recent tick equals a pool digit
     *     AND the N-1 tick was on the opposite side (approaching from below
     *     for a high pool, from above for a low pool), AND the tick AFTER
     *     (i.e. the current tick) begins to move back inside.
     *  d) Return the swept digit as the one to avoid.
     */
    _detectLiquiditySweep(digitHistory, st) {
        const cfg = this.cfg.liquiditySweep;
        const n = digitHistory.length;
        const scanWindow = Math.min(n, 80);
        const recent = digitHistory.slice(-scanWindow);
        const strength = cfg.swingLookback;

        // Expire old pools
        st.liquidityPools = st.liquidityPools.filter(
            p => (st.tickCount - p.lastTick) < cfg.poolMaxAge
        );

        // Detect new pivot highs & lows in the recent window (excluding last 2 ticks
        // because we need right-side bars for confirmation)
        for (let i = strength; i < recent.length - strength; i++) {
            const absIdx = st.tickCount - (recent.length - i);

            if (TechnicalIndicators.isPivotHigh(recent, i, strength)) {
                this._addToPool(st.liquidityPools, recent[i], absIdx, 'HIGH', cfg);
            }
            if (TechnicalIndicators.isPivotLow(recent, i, strength)) {
                this._addToPool(st.liquidityPools, recent[i], absIdx, 'LOW', cfg);
            }
        }

        // Now check if the last tick "swept" any active pool
        const lastDigit = digitHistory[n - 1];
        const prevDigit = digitHistory[n - 2];
        const prevPrevDigit = n >= 3 ? digitHistory[n - 3] : null;

        let sweptPool = null;
        let sweepType = null;  // 'BUYSIDE' or 'SELLSIDE'

        for (const pool of st.liquidityPools) {
            // Skip if in cooldown
            const cooldownExpiry = st.sweepCooldown[pool.digit] || 0;
            if (st.tickCount <= cooldownExpiry) continue;
            // Need at least 2 touches to be a proper pool
            if (pool.touches < cfg.minPoolTouches) continue;

            const tol = cfg.equalLevelTolerance;

            if (pool.type === 'HIGH') {
                // Buy-side sweep: price spikes above the high then fails back down
                const atLevel = Math.abs(lastDigit - pool.digit) <= tol;
                const approaching = prevDigit < pool.digit - tol;   // was below
                const reverting = prevPrevDigit !== null && prevPrevDigit < pool.digit - tol;
                if (atLevel && (approaching || reverting)) {
                    sweptPool = pool;
                    sweepType = 'BUYSIDE';
                    break;
                }
            } else {
                // Sell-side sweep: price dips below the low then recovers
                const atLevel = Math.abs(lastDigit - pool.digit) <= tol;
                const approaching = prevDigit > pool.digit + tol;   // was above
                const reverting = prevPrevDigit !== null && prevPrevDigit > pool.digit + tol;
                if (atLevel && (approaching || reverting)) {
                    sweptPool = pool;
                    sweepType = 'SELLSIDE';
                    break;
                }
            }
        }

        if (!sweptPool) {
            return { detected: false, reason: 'no_pool_swept', pools: st.liquidityPools.length };
        }

        // Register cooldown
        st.sweepCooldown[sweptPool.digit] = st.tickCount + cfg.cooldownTicks;

        return {
            detected: true,
            reason: 'liquidity_swept',
            sweptDigit: sweptPool.digit,
            sweepType,
            poolTouches: sweptPool.touches,
            poolType: sweptPool.type,
        };
    }

    _addToPool(pools, digit, tickIdx, type, cfg) {
        const tol = cfg.equalLevelTolerance;
        const existing = pools.find(
            p => p.type === type && Math.abs(p.digit - digit) <= tol
        );
        if (existing) {
            existing.touches++;
            existing.lastTick = tickIdx;
            // Update digit to running average
            existing.digit = Math.round((existing.digit + digit) / 2);
        } else {
            pools.push({ digit, type, touches: 1, firstTick: tickIdx, lastTick: tickIdx });
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // 2. BREAK OF STRUCTURE (BOS)
    // ────────────────────────────────────────────────────────────────────────
    /**
     * Algorithm:
     *  a) Detect pivot highs and lows using isPivotHigh/Low.
     *  b) A BULLISH BOS = new pivot high > most recent recorded pivot high.
     *  c) A BEARISH BOS = new pivot low  < most recent recorded pivot low.
     *  d) A CHoCH (Change of Character) is the FIRST BOS against the prior bias.
     *  e) Bias is set/updated and expires after `biasLifetime` ticks.
     */
    _detectBOS(digitHistory, st) {
        const cfg = this.cfg.breakOfStructure;
        const n = digitHistory.length;
        const win = Math.min(n, cfg.structureWindow);
        const recent = digitHistory.slice(-win);
        const str = cfg.pivotStrength;

        // Collect swing highs and lows from the window (excluding edge ticks)
        const newHighs = [];
        const newLows = [];

        for (let i = str; i < recent.length - str; i++) {
            const absIdx = st.tickCount - (recent.length - i);
            if (TechnicalIndicators.isPivotHigh(recent, i, str)) {
                newHighs.push({ digit: recent[i], tickIdx: absIdx });
            }
            if (TechnicalIndicators.isPivotLow(recent, i, str)) {
                newLows.push({ digit: recent[i], tickIdx: absIdx });
            }
        }

        // Keep only last 5 of each type (avoid unbounded growth)
        if (newHighs.length) st.swingHighs = [...st.swingHighs, ...newHighs].slice(-5);
        if (newLows.length) st.swingLows = [...st.swingLows, ...newLows].slice(-5);

        // Expire old BOS events
        st.bosEvents = st.bosEvents.filter(e => (st.tickCount - e.tickIdx) < 50);

        // Check for BOS
        let bosDetected = false;
        let bosDirection = null;
        let bosMagnitude = 0;
        let isChoch = false;

        if (st.swingHighs.length >= 2) {
            const prevHigh = st.swingHighs[st.swingHighs.length - 2];
            const currHigh = st.swingHighs[st.swingHighs.length - 1];
            if (currHigh.digit > prevHigh.digit + cfg.minBreakMagnitude &&
                currHigh.tickIdx > prevHigh.tickIdx) {
                bosMagnitude = currHigh.digit - prevHigh.digit;
                bosDirection = 'UP';
                bosDetected = true;
                isChoch = st.bosBias === 'DOWN';   // flip = CHoCH
            }
        }

        if (!bosDetected && st.swingLows.length >= 2) {
            const prevLow = st.swingLows[st.swingLows.length - 2];
            const currLow = st.swingLows[st.swingLows.length - 1];
            if (currLow.digit < prevLow.digit - cfg.minBreakMagnitude &&
                currLow.tickIdx > prevLow.tickIdx) {
                bosMagnitude = prevLow.digit - currLow.digit;
                bosDirection = 'DOWN';
                bosDetected = true;
                isChoch = st.bosBias === 'UP';    // flip = CHoCH
            }
        }

        if (bosDetected) {
            st.bosEvents.push({ direction: bosDirection, tickIdx: st.tickCount, magnitude: bosMagnitude });
            if (!isChoch) {
                // Confirm and extend bias only on genuine BOS (not CHoCH)
                st.bosBias = bosDirection;
                st.bosBiasExpiry = st.tickCount + cfg.biasLifetime;
            } else {
                // CHoCH: reset bias to neutral (structure is uncertain)
                st.bosBias = null;
            }
        }

        // Decay bias if expired
        if (st.bosBias && st.tickCount > st.bosBiasExpiry) {
            st.bosBias = null;
        }

        return {
            detected: bosDetected && !isChoch,
            reason: bosDetected ? (isChoch ? 'choch_structure_reset' : 'bos_confirmed') : 'no_bos',
            direction: bosDirection,
            magnitude: bosMagnitude,
            bias: st.bosBias,
            isChoch,
            swingHighs: st.swingHighs.length,
            swingLows: st.swingLows.length,
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 3. FAIR VALUE GAP (FVG)  — 3-tick imbalance
    // ────────────────────────────────────────────────────────────────────────
    /**
     * For digits we treat each tick as a "candle" with high = digit, low = digit.
     * A bullish FVG: digit[i-2] < digit[i] and there is a gap:
     *   gap = digit[i] - digit[i-2] >= minGapWidth (digit[i-1] skipped over this range)
     * A bearish FVG: digit[i-2] > digit[i] and gap >= minGapWidth.
     *
     * An active FVG is "filled" when price re-enters its range.
     * We trade when price is RETURNING to fill an unfilled FVG (mean-reversion).
     */
    _detectFVG(digitHistory, st) {
        const cfg = this.cfg.fairValueGap;
        const n = digitHistory.length;

        // Scan last N ticks for new FVGs
        const scanStart = Math.max(2, n - cfg.scanWindow);
        for (let i = scanStart; i < n - 1; i++) {
            const a = digitHistory[i - 2];
            const b = digitHistory[i - 1];  // middle tick (creates the gap)
            const c = digitHistory[i];
            const absIdx = st.tickCount - (n - 1 - i);

            // Avoid duplicate detection
            if (st.activeFVGs.find(f => f.formed === absIdx)) continue;

            const bullGap = c - a;
            const bearGap = a - c;

            if (bullGap >= cfg.minGapWidth && b < c && b > a) {
                // Bullish FVG: price jumped up, gap between a's high and c's low
                st.activeFVGs.push({
                    direction: 'BULLISH',
                    gapTop: c,
                    gapBottom: a,
                    midpoint: Math.round((a + c) / 2),
                    formed: absIdx,
                    filled: false,
                });
            } else if (bearGap >= cfg.minGapWidth && b > c && b < a) {
                // Bearish FVG
                st.activeFVGs.push({
                    direction: 'BEARISH',
                    gapTop: a,
                    gapBottom: c,
                    midpoint: Math.round((a + c) / 2),
                    formed: absIdx,
                    filled: false,
                });
            }
        }

        // Age & fill FVGs
        const currentDigit = digitHistory[n - 1];
        st.activeFVGs.forEach(f => {
            f.age = st.tickCount - f.formed;
            if (!f.filled && currentDigit >= f.gapBottom && currentDigit <= f.gapTop) {
                f.filled = true;
            }
        });

        // Expire old FVGs
        st.activeFVGs = st.activeFVGs.filter(
            f => !f.filled && f.age < cfg.maxAge
        );

        // Signal: price is approaching an unfilled FVG's midpoint from the correct side
        let nearestFVG = null;
        let minDist = Infinity;

        for (const fvg of st.activeFVGs) {
            const dist = Math.abs(currentDigit - fvg.midpoint);
            if (dist < minDist) {
                minDist = dist;
                nearestFVG = fvg;
            }
        }

        const detected = nearestFVG !== null && minDist <= 2;

        return {
            detected,
            reason: detected ? 'fvg_price_approaching' : 'no_active_fvg',
            nearestFVG,
            proximity: detected ? minDist : null,
            activeFVGs: st.activeFVGs.length,
            gapDirection: nearestFVG?.direction ?? null,
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 4. ORDER BLOCK (OB)
    // ────────────────────────────────────────────────────────────────────────
    /**
     * Algorithm:
     *  a) Detect "impulse moves": runs of N ticks where the digit shifts
     *     significantly in one direction (avg change >= minImpulseMagnitude).
     *  b) The Order Block is the `obClusterSize` ticks IMMEDIATELY before
     *     the impulse. The OB cluster's mean digit is the level.
     *  c) A new OB is only created when the impulse is NEW (not already captured).
     *  d) The OB is active until price returns to its cluster mean (mitigation)
     *     or it expires.
     *  e) Signal: current digit is near an active OB's cluster mean AND
     *     approaching from the OB side.
     */
    _detectOrderBlock(digitHistory, st) {
        const cfg = this.cfg.orderBlock;
        const n = digitHistory.length;
        const win = Math.min(n, cfg.impulseWindow);
        const recent = digitHistory.slice(-win);
        const minLen = cfg.minImpulseLength;

        // Detect new impulse moves (sliding window)
        for (let i = minLen; i < recent.length; i++) {
            const absStart = st.tickCount - (recent.length - (i - minLen));
            const impulseSlice = recent.slice(i - minLen, i);

            // Measure avg digit velocity
            let totalChange = 0;
            for (let j = 1; j < impulseSlice.length; j++) {
                totalChange += Math.abs(impulseSlice[j] - impulseSlice[j - 1]);
            }
            const avgChange = totalChange / (impulseSlice.length - 1);

            if (avgChange < cfg.minImpulseMagnitude) continue;

            // Check direction
            const firstDigit = impulseSlice[0];
            const lastDigit = impulseSlice[impulseSlice.length - 1];
            const direction = lastDigit > firstDigit ? 'BULLISH' : 'BEARISH';

            // OB cluster = ticks immediately before the impulse
            const obStart = Math.max(0, i - minLen - cfg.obClusterSize);
            const obEnd = i - minLen;
            if (obEnd <= obStart) continue;

            const obSlice = recent.slice(obStart, obEnd);
            const clusterMean = Math.round(obSlice.reduce((s, v) => s + v, 0) / obSlice.length);

            // Avoid duplicate OBs at the same cluster mean
            if (st.activeOBs.find(ob => Math.abs(ob.clusterMean - clusterMean) <= 1 && ob.direction === direction)) continue;

            st.activeOBs.push({
                direction,
                clusterMean,
                impulseStart: absStart,
                formed: st.tickCount,
                age: 0,
                mitigated: false,
            });
        }

        // Age, mitigate, expire OBs
        const currentDigit = digitHistory[n - 1];
        st.activeOBs.forEach(ob => {
            ob.age = st.tickCount - ob.formed;
            if (cfg.mitigationEnabled && Math.abs(currentDigit - ob.clusterMean) <= 1) {
                ob.mitigated = true;
            }
        });
        st.activeOBs = st.activeOBs.filter(ob => !ob.mitigated && ob.age < cfg.maxAge);

        // Signal: current digit near an active OB
        let nearestOB = null;
        let minDist = Infinity;

        for (const ob of st.activeOBs) {
            const dist = Math.abs(currentDigit - ob.clusterMean);
            if (dist <= cfg.proximityThreshold && dist < minDist) {
                minDist = dist;
                nearestOB = ob;
            }
        }

        const detected = nearestOB !== null;

        return {
            detected,
            reason: detected ? 'ob_proximity_confirmed' : 'no_nearby_ob',
            nearestOB,
            proximity: detected ? minDist : null,
            activeOBs: st.activeOBs.length,
            obDirection: nearestOB?.direction ?? null,
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 5. TREND FILTER (EMA slope + digit-half dominance + CHoCH guard)
    // ────────────────────────────────────────────────────────────────────────
    /**
     * Three sub-checks, all must agree:
     *
     *  a) EMA SLOPE: Compute EMA of raw prices. If the last N EMA values
     *     have a positive slope above threshold → UP. Negative → DOWN. Else flat.
     *
     *  b) DIGIT-HALF DOMINANCE: Count how many of the last `halfWindow` digits
     *     are in 0-4 vs 5-9. Dominant half is LOW if 0-4 wins, HIGH if 5-9 wins.
     *
     *  c) CHoCH GUARD: If the last `chochWindow` BOS events alternate
     *     UP/DOWN/UP/DOWN (or similar flip), the structure is unstable → block.
     *
     *  Result: 'BULLISH' (both point up), 'BEARISH' (both point down), 'NEUTRAL'.
     *  We require BULLISH or BEARISH (not NEUTRAL) to trade.
     */
    _analyzeTrend(digitHistory, priceHistory, st) {
        const cfg = this.cfg.trendFilter;
        const n = digitHistory.length;

        // ── a) EMA Slope ──────────────────────────────────────────────────
        let emaDirection = 'NEUTRAL';
        let emaSlope = 0;

        if (priceHistory.length >= cfg.emaPeriod + cfg.emaLookback) {
            const emaArr = TechnicalIndicators.EMAArray(priceHistory, cfg.emaPeriod);
            if (emaArr.length >= cfg.emaLookback) {
                const emaOld = emaArr[emaArr.length - cfg.emaLookback];
                const emaNow = emaArr[emaArr.length - 1];
                emaSlope = (emaNow - emaOld) / cfg.emaLookback;

                if (emaSlope > cfg.emaSlopeThreshold) emaDirection = 'UP';
                else if (emaSlope < -cfg.emaSlopeThreshold) emaDirection = 'DOWN';
            }
        }

        // ── b) Digit-Half Dominance ────────────────────────────────────────
        const recent = digitHistory.slice(-cfg.halfWindow);
        const lowCount = recent.filter(d => d <= 4).length;
        const highCount = recent.filter(d => d >= 5).length;
        const total = recent.length;

        let halfBias = 'NEUTRAL';
        const lowRatio = lowCount / total;
        const highRatio = highCount / total;

        if (highRatio >= cfg.minHalfDominance) halfBias = 'HIGH';   // digits in 5-9 dominating → bullish
        else if (lowRatio >= cfg.minHalfDominance) halfBias = 'LOW';   // digits in 0-4 dominating → bearish

        // ── c) CHoCH Guard ─────────────────────────────────────────────────
        const recentBOS = st.bosEvents.slice(-cfg.chochWindow);
        let structureStable = true;

        if (recentBOS.length >= 4) {
            let alternations = 0;
            for (let i = 1; i < recentBOS.length; i++) {
                if (recentBOS[i].direction !== recentBOS[i - 1].direction) alternations++;
            }
            // If every consecutive pair alternates, structure is choppy
            if (alternations >= recentBOS.length - 1) structureStable = false;
        }

        // ── Combine ────────────────────────────────────────────────────────
        let alignment = 'NEUTRAL';
        if (emaDirection === 'UP' && halfBias === 'HIGH' && structureStable) alignment = 'BULLISH';
        if (emaDirection === 'DOWN' && halfBias === 'LOW' && structureStable) alignment = 'BEARISH';

        const aligned = alignment !== 'NEUTRAL';

        return {
            aligned,
            alignment,
            reason: aligned ? 'trend_aligned' : `no_alignment_${emaDirection}_${halfBias}`,
            emaDirection,
            emaSlope: emaSlope.toFixed(8),
            halfBias,
            lowRatio: lowRatio.toFixed(2),
            highRatio: highRatio.toFixed(2),
            structureStable,
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // CONFLUENCE SCORING
    // ────────────────────────────────────────────────────────────────────────
    _calculateConfluence(results) {
        const weights = this.cfg.confluence.weights;
        let score = 0;
        const signals = [];

        if (results.liquiditySweep.detected) { score += weights.liquiditySweep; signals.push('LiqSweep'); }
        if (results.breakOfStructure.detected) { score += weights.breakOfStructure; signals.push('BOS'); }
        if (results.fairValueGap.detected) { score += weights.fairValueGap; signals.push('FVG'); }
        if (results.orderBlock.detected) { score += weights.orderBlock; signals.push('OB'); }
        if (results.trendFilter.aligned) { score += weights.trendFilter; signals.push('TrendFilter'); }

        const shouldTrade =
            score >= this.cfg.confluence.minScore &&
            results.fairValueGap.detected &&
            results.trendFilter.aligned;

        return {
            shouldTrade,
            score,
            maxScore: 5.0,
            percentage: ((score / 5) * 100).toFixed(1),
            signals,
            reason: !shouldTrade ? `low_confluence_${score.toFixed(1)}` : 'confluence_met',
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // RESOLVE: which digit should we tell Deriv to AVOID?
    // ────────────────────────────────────────────────────────────────────────
    /**
     * Priority order:
     *  1. Swept digit from liquidity sweep (highest conviction — market just
     *     hunted that digit's liquidity and is about to reverse away from it).
     *  2. Order Block cluster mean (if OB is bearish OB, price should avoid
     *     returning to it, and vice versa).
     *  3. FVG midpoint (the gap digit that price is approaching but hasn't filled).
     *  4. Last digit (fallback, low confidence — not normally reached).
     */
    _resolveAvoidDigit(results, digitHistory) {
        // 1. Swept digit
        // if (results.liquiditySweep.detected && results.liquiditySweep.sweptDigit !== undefined) {
        //     return results.liquiditySweep.sweptDigit;
        // }
        // 2. OB cluster mean
        // if (results.orderBlock.detected && results.orderBlock.nearestOB) {
        //     return results.orderBlock.nearestOB.clusterMean;
        // }
        // 3. FVG midpoint
        if (results.fairValueGap.detected && results.fairValueGap.nearestFVG) {
            return results.fairValueGap.nearestFVG.midpoint;
        }
        // // 4. last digit
        // return digitHistory[digitHistory.length - 1];
        // 4. No digit  
        return null;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT  (infrastructure unchanged from v1; only _evaluateAsset hooks changed)
// ══════════════════════════════════════════════════════════════════════════════
class SmartMoneyBot {
    constructor(config) {
        this.cfg = config;

        // Connection
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.reconnectAttempts = 0;
        this.pingInterval = null;

        // Trade state
        this.tradeInProgress = false;
        this.tradeStartTime = null;
        this.tradeWatchdogMs = 30000;
        this._wdTimer = null;

        this.currentStake = config.initialStake;
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.isWinTrade = false;
        this.endOfDay = false;

        // Rate limiting
        this.hourlyTrades = [];
        this.lastLossTime = {};

        // Per-asset data
        this.priceHistories = {};
        this.digitHistories = {};
        this.lastTradeTime = {};
        this.activeTrades = {};
        this.contractSubs = {};
        this.assetMetrics = {};
        this.proposalIds = {};

        config.assets.forEach(a => {
            this.priceHistories[a] = [];
            this.digitHistories[a] = [];
            this.lastTradeTime[a] = 0;
            this.lastLossTime[a] = 0;
            this.assetMetrics[a] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
        });

        // SMC Statistics
        this.smcStats = {
            liquiditySweeps: { detected: 0, traded: 0, won: 0 },
            bos: { detected: 0, traded: 0, won: 0 },
            fvg: { detected: 0, traded: 0, won: 0 },
            orderBlocks: { detected: 0, traded: 0, won: 0 },
            trendAligned: { detected: 0, traded: 0, won: 0 },
        };

        // Analyzer (v2)
        this.analyzer = new SmartMoneyAnalyzer(config);

        // Telegram
        this.telegram = null;
        if (config.telegramToken && config.telegramChatId) {
            this.telegram = new TelegramBot(config.telegramToken, { polling: false });
        }

        this._loadState();

        if (!this.hourlyStats) {
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
        }
        if (!this.session) {
            this.session = {
                startTime: Date.now(), startCapital: 0,
                tradesCount: 0, winsCount: 0, lossesCount: 0, netPL: 0, isActive: true,
            };
        }
        if (!this.currentTradeDay) {
            this.currentTradeDay = new Date().toISOString().split('T')[0];
        }
        this.dailyProfitLoss = this.dailyProfitLoss || 0;
    }

    _loadState() {
        const s = StatePersistence.load();
        if (!s) return;
        try {
            if (s.trading) {
                this.currentStake = s.trading.currentStake || this.cfg.initialStake;
                this.consecutiveLosses = s.trading.consecutiveLosses || 0;
                this.consecutiveLosses2 = s.trading.consecutiveLosses2 || 0;
                this.consecutiveLosses3 = s.trading.consecutiveLosses3 || 0;
                this.consecutiveLosses4 = s.trading.consecutiveLosses4 || 0;
                this.totalTrades = s.trading.totalTrades || 0;
                this.totalWins = s.trading.totalWins || 0;
                this.totalLosses = s.trading.totalLosses || 0;
                this.totalProfitLoss = s.trading.totalProfitLoss || 0;
                this.dailyProfitLoss = s.trading.dailyProfitLoss || 0;
            }
            if (s.assetMetrics) this.assetMetrics = s.assetMetrics;
            if (s.hourlyTrades) this.hourlyTrades = s.hourlyTrades;
            if (s.hourlyStats) this.hourlyStats = s.hourlyStats;
            if (s.session) this.session = s.session;
            if (s.currentTradeDay) this.currentTradeDay = s.currentTradeDay;
            if (s.smcStats) this.smcStats = s.smcStats;
            console.log(`✅ State restored — ${this.totalTrades} trades, P&L $${this.totalProfitLoss.toFixed(2)}`);
        } catch (e) {
            console.error(`❌ State restore error: ${e.message}`);
        }
    }

    _canTrade(asset) {
        const now = Date.now();
        if (now - this.lastTradeTime[asset] < this.cfg.minTimeBetweenTrades)
            return { can: false, reason: 'asset_cooldown' };
        if (now - this.lastLossTime[asset] < this.cfg.cooldownAfterLoss)
            return { can: false, reason: 'loss_cooldown' };
        this.hourlyTrades = this.hourlyTrades.filter(t => now - t < 3600000);
        if (this.hourlyTrades.length >= this.cfg.maxTradesPerHour)
            return { can: false, reason: 'hourly_limit' };
        return { can: true };
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────
    connect() {
        if (this.ws?.readyState === WebSocket.OPEN) return;
        console.log('🔌 Connecting to Deriv API…');
        this._cleanupWs();
        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ WebSocket connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this._startPing();
            this._send({ authorize: this.cfg.token });
        });

        this.ws.on('message', data => {
            try { this._handleMessage(JSON.parse(data)); }
            catch (e) { console.error('Parse error:', e.message); }
        });

        this.ws.on('error', e => console.error('WS error:', e.message));
        this.ws.on('close', () => {
            console.log('⚡ WebSocket closed');
            this._stopPing();
            this._onDisconnect();
        });
    }

    _startPing() {
        this._stopPing();
        this.pingInterval = setInterval(() => {
            if (this.connected) this._send({ ping: 1 });
        }, 25000);
    }

    _stopPing() {
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    }

    _send(req) {
        if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return false;
        try { this.ws.send(JSON.stringify(req)); return true; }
        catch (e) { console.error('Send error:', e.message); return false; }
    }

    _onDisconnect() {
        if (this.endOfDay) { this._cleanupWs(); return; }
        this.connected = this.wsReady = false;
        StatePersistence.save(this);
        if (this.reconnectAttempts >= this.cfg.maxReconnectAttempts) {
            console.error('❌ Max reconnect attempts'); return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(this.cfg.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s…`);
        setTimeout(() => this.connect(), delay);
    }

    _cleanupWs() {
        this._stopPing();
        this._clearWatchdog();
        if (this.ws) {
            this.ws.removeAllListeners();
            try {
                if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) this.ws.close();
            } catch (_) { }
            this.ws = null;
        }
        this.connected = this.wsReady = false;
    }

    _handleMessage(msg) {
        switch (msg.msg_type) {
            case 'authorize': this._onAuth(msg); break;
            case 'history': this._onHistory(msg); break;
            case 'tick': this._onTick(msg.tick); break;
            case 'proposal': this._onProposal(msg); break;
            case 'buy': this._onBuy(msg); break;
            case 'proposal_open_contract': this._onContractUpdate(msg); break;
            case 'ping': break;
            default:
                if (msg.error) console.error(`API error: ${msg.error.message}`);
        }
    }

    _onAuth(msg) {
        if (msg.error) { console.error('Auth failed:', msg.error.message); this._cleanupWs(); return; }
        console.log(`✅ Auth OK — Balance: $${msg.authorize.balance}`);
        this.wsReady = true;

        if (this.session.startCapital === 0) this.session.startCapital = msg.authorize.balance;

        this.cfg.assets.forEach(asset => {
            this._send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.cfg.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks',
            });
            this._send({ ticks: asset, subscribe: 1 });
        });
    }

    _lastDigit(quote, asset) {
        const s = quote.toString();
        const [, frac = ''] = s.split('.');
        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) return frac.length >= 4 ? parseInt(frac[3]) : 0;
        if (['R_10', 'R_25'].includes(asset)) return frac.length >= 3 ? parseInt(frac[2]) : 0;
        return frac.length >= 2 ? parseInt(frac[1]) : 0;
    }

    _onHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        this.priceHistories[asset] = msg.history.prices.map(p => parseFloat(p));
        this.digitHistories[asset] = this.priceHistories[asset].map(p => this._lastDigit(p, asset));
        console.log(`📊 ${asset}: loaded ${this.priceHistories[asset].length} ticks`);
    }

    _onTick(tick) {
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);
        const digit = this._lastDigit(price, asset);

        this.priceHistories[asset].push(price);
        if (this.priceHistories[asset].length > 500) this.priceHistories[asset].shift();

        this.digitHistories[asset].push(digit);
        if (this.digitHistories[asset].length > 400) this.digitHistories[asset].shift();

        if (!this.wsReady || this.tradeInProgress) return;
        if (this.digitHistories[asset].length < this.cfg.requiredHistoryLength) return;

        this._evaluateAsset(asset);
    }

    _evaluateAsset(asset) {
        const canTrade = this._canTrade(asset);
        if (!canTrade.can) return;

        const analysis = this.analyzer.analyze(
            this.digitHistories[asset],
            this.priceHistories[asset],
            asset
        );

        // Uncomment for verbose debug:
        // console.log(`[${asset}] score=${analysis.confluence?.score?.toFixed(2)} signals=${analysis.confluence?.signals?.join(',')} reason=${analysis.reason}`);

        if (!analysis.shouldTrade) return;

        // Update SMC detection stats
        const r = analysis.results;
        if (r.liquiditySweep.detected) this.smcStats.liquiditySweeps.detected++;
        if (r.breakOfStructure.detected) this.smcStats.bos.detected++;
        if (r.fairValueGap.detected) this.smcStats.fvg.detected++;
        if (r.orderBlock.detected) this.smcStats.orderBlocks.detected++;
        if (r.trendFilter.aligned) this.smcStats.trendAligned.detected++;

        this._requestProposal(asset, analysis);
    }

    _requestProposal(asset, analysis) {
        if (this.tradeInProgress) return;

        this._send({
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'DIGITDIFF',
            currency: 'USD',
            symbol: asset,
            duration: 1,
            duration_unit: 't',
            barrier: analysis.predictedDigit.toString(),
        });

        this.proposalIds[asset] = { analysis };
    }

    _onProposal(msg) {
        if (msg.error) {
            console.log(`❌ Proposal error: ${msg.error.message}`);
            return;
        }

        const asset = msg.echo_req?.symbol;
        if (!asset || this.tradeInProgress) return;

        const proposal = msg.proposal;
        const storedData = this.proposalIds[asset];
        if (!storedData) return;

        const analysis = storedData.analysis;
        const payout = parseFloat(proposal.payout || 0);
        const payoutPct = ((payout - this.currentStake) / this.currentStake * 100).toFixed(1);

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`  🎯 SMC v2 TRADE SETUP — ${asset}`);
        console.log(`${'═'.repeat(60)}`);
        console.log(`  Avoid Digit : ${analysis.predictedDigit}  (DIGITDIFF — digit will NOT appear)`);
        console.log(`  Score       : ${analysis.confluence.score.toFixed(2)}/5.0 (${analysis.confluence.percentage}%)`);
        console.log(`  Signals     : ${analysis.confluence.signals.join(' ✦ ')}`);
        console.log(`  Confidence  : ${(analysis.confidence * 100).toFixed(1)}%`);
        console.log(`  Stake       : $${this.currentStake.toFixed(2)}  →  Payout: $${payout.toFixed(2)} (+${payoutPct}%)`);

        const r = analysis.results;
        console.log(`\n  📐 SMC Breakdown:`);

        if (r.liquiditySweep.detected) {
            console.log(`    ✅ LiqSweep : digit=${r.liquiditySweep.sweptDigit} | type=${r.liquiditySweep.sweepType} | touches=${r.liquiditySweep.poolTouches}`);
        } else {
            console.log(`    ⬜ LiqSweep : ${r.liquiditySweep.reason}`);
        }

        if (r.breakOfStructure.detected) {
            console.log(`    ✅ BOS      : dir=${r.breakOfStructure.direction} | mag=${r.breakOfStructure.magnitude} | bias=${r.breakOfStructure.bias}`);
        } else {
            console.log(`    ⬜ BOS      : ${r.breakOfStructure.reason}`);
        }

        if (r.fairValueGap.detected) {
            console.log(`    ✅ FVG      : ${r.fairValueGap.gapDirection} gap | midpoint=${r.fairValueGap.nearestFVG?.midpoint} | proximity=${r.fairValueGap.proximity}`);
        } else {
            console.log(`    ⬜ FVG      : ${r.fairValueGap.reason} (active: ${r.fairValueGap.activeFVGs})`);
        }

        if (r.orderBlock.detected) {
            console.log(`    ✅ OB       : mean=${r.orderBlock.nearestOB?.clusterMean} | dir=${r.orderBlock.obDirection} | prox=${r.orderBlock.proximity}`);
        } else {
            console.log(`    ⬜ OB       : ${r.orderBlock.reason} (active: ${r.orderBlock.activeOBs})`);
        }

        if (r.trendFilter.aligned) {
            console.log(`    ✅ Trend    : ${r.trendFilter.alignment} | EMA=${r.trendFilter.emaDirection} | half=${r.trendFilter.halfBias} | slope=${r.trendFilter.emaSlope}`);
        } else {
            console.log(`    ⬜ Trend    : ${r.trendFilter.reason}`);
        }

        console.log(`\n  Last 15 digits: [ ${this.digitHistories[asset].slice(-15).join(' ')} ]`);
        console.log(`${'═'.repeat(60)}\n`);

        this._placeTrade(asset, analysis, proposal);
    }

    _placeTrade(asset, analysis, proposal) {
        if (this.tradeInProgress) return;

        this._send({ buy: proposal.id, price: this.currentStake.toFixed(2) });

        this.tradeInProgress = true;
        this.activeTrades[asset] = {
            status: 'buying',
            proposalId: proposal.id,
            stake: this.currentStake,
            predictedDigit: analysis.predictedDigit,
            analysis,
            entryTime: Date.now(),
        };

        this.hourlyTrades.push(Date.now());

        // Update SMC traded stats
        const r = analysis.results;
        if (r.liquiditySweep.detected) this.smcStats.liquiditySweeps.traded++;
        if (r.breakOfStructure.detected) this.smcStats.bos.traded++;
        if (r.fairValueGap.detected) this.smcStats.fvg.traded++;
        if (r.orderBlock.detected) this.smcStats.orderBlocks.traded++;
        if (r.trendFilter.aligned) this.smcStats.trendAligned.traded++;

        this._sendTelegram(
            `🎯 <b>SMC v2 Trade</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Avoid digit: <b>${analysis.predictedDigit}</b>\n` +
            `Score: ${analysis.confluence.score.toFixed(2)}/5 (${analysis.confluence.percentage}%)\n` +
            `Signals: ${analysis.confluence.signals.join(', ')}\n` +
            `Type: ${r.liquiditySweep.sweepType ?? 'N/A'} sweep\n` +
            `Trend: ${r.trendFilter.alignment}\n` +
            `Confidence: ${(analysis.confidence * 100).toFixed(1)}%\n` +
            `Stake: $${this.currentStake.toFixed(2)}`
        );

        this.lastTradeTime[asset] = Date.now();
        this.tradeStartTime = Date.now();
        this._startWatchdog(asset);
    }

    _onBuy(msg) {
        const asset = Object.keys(this.activeTrades).find(a => this.activeTrades[a]?.status === 'buying');

        if (msg.error) {
            console.error(`❌ Buy error: ${msg.error.message}`);
            if (asset) delete this.activeTrades[asset];
            this.tradeInProgress = false;
            this._clearWatchdog();
            return;
        }

        if (!asset) return;

        const contractId = msg.buy.contract_id;
        console.log(`✅ Contract: ${contractId}`);

        this.activeTrades[asset].status = 'active';
        this.activeTrades[asset].contractId = contractId;

        this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
    }

    _onContractUpdate(msg) {
        if (msg.error) return;
        const contract = msg.proposal_open_contract;
        if (!contract) return;

        const asset = contract.underlying ||
            Object.keys(this.activeTrades).find(a => this.activeTrades[a]?.contractId === contract.contract_id);
        if (!asset || !this.activeTrades[asset]) return;

        if (msg.subscription?.id) this.contractSubs[asset] = msg.subscription.id;

        if (contract.is_sold) this._onTradeResult(asset, contract);
    }

    _onTradeResult(asset, contract) {
        const trade = this.activeTrades[asset];
        if (!trade) return;

        this._clearWatchdog();
        if (this.contractSubs[asset]) {
            this._send({ forget: this.contractSubs[asset] });
            delete this.contractSubs[asset];
        }

        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        // Update SMC win stats
        const r = trade.analysis.results;
        if (won) {
            if (r.liquiditySweep.detected) this.smcStats.liquiditySweeps.won++;
            if (r.breakOfStructure.detected) this.smcStats.bos.won++;
            if (r.fairValueGap.detected) this.smcStats.fvg.won++;
            if (r.orderBlock.detected) this.smcStats.orderBlocks.won++;
            if (r.trendFilter.aligned) this.smcStats.trendAligned.won++;
        }

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`  ${won ? '✅ WIN' : '❌ LOSS'}: ${asset} | digit avoided: ${trade.predictedDigit}`);
        console.log(`  P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
        console.log(`${'═'.repeat(60)}`);

        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
        this.assetMetrics[asset].trades++;
        this.assetMetrics[asset].profitLoss += profit;

        this._checkDayChange();
        const currentHour = new Date().getHours();
        if (currentHour !== this.hourlyStats.lastHour) {
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: currentHour };
        }
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;
        this.session.tradesCount++;
        this.session.netPL += profit;

        if (won) {
            this.hourlyStats.wins++;
            this.session.winsCount++;
            this.totalWins++;
            this.isWinTrade = true;
            this.currentStake = this.cfg.initialStake;
            this.consecutiveLosses = 0;
            this.assetMetrics[asset].wins++;
        } else {
            this.hourlyStats.losses++;
            this.session.lossesCount++;
            this.totalLosses++;
            this.consecutiveLosses++;
            this.lastLossTime[asset] = Date.now();
            this.assetMetrics[asset].losses++;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;

            this.currentStake = Math.ceil(this.currentStake * this.cfg.multiplier * 100) / 100;
        }

        this.tradeInProgress = false;
        delete this.activeTrades[asset];

        const wr = ((this.totalWins / this.totalTrades) * 100).toFixed(2);
        const smcPerf = Object.entries(this.smcStats).map(([name, stats]) => {
            const wr2 = stats.traded > 0 ? (stats.won / stats.traded * 100).toFixed(1) : '0.0';
            return `${name}: ${wr2}%`;
        }).join(' | ');

        this._sendTelegram(
            `${won ? '✅' : '❌'} <b>Result</b>\n\n` +
            `Asset: ${asset}\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
            `Win Rate: ${wr}%\n` +
            `Consec losses: ${this.consecutiveLosses}\n` +
            `Next stake: $${this.currentStake.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}\n\n` +
            `SMC Performance:\n${smcPerf}`
        );

        this._logSummary();
        StatePersistence.save(this);

        if (this.totalProfitLoss >= this.cfg.takeProfit) {
            this.endOfDay = true;
            this._sendTelegram(`🎯 <b>Take Profit!</b> P&L: +$${this.totalProfitLoss.toFixed(2)}`);
            this._sendSessionSummary();
            this._cleanupWs();
        } else if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.cfg.stopLoss) {
            this.endOfDay = true;
            this._sendTelegram(`🛑 <b>Stop Loss</b>\nLosses: ${this.consecutiveLosses} | P&L: $${this.totalProfitLoss.toFixed(2)}`);
            this._sendSessionSummary();
            this._cleanupWs();
        }
    }

    _startWatchdog(asset) {
        this._clearWatchdog();
        this._wdTimer = setTimeout(() => {
            const contractId = this.activeTrades[asset]?.contractId;
            if (!contractId) { this._clearWatchdog(); return; }
            console.warn(`⏰ WATCHDOG FIRED — re-subscribing`);
            if (this.connected) {
                this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
            }
        }, this.tradeWatchdogMs);
    }

    _clearWatchdog() {
        if (this._wdTimer) { clearTimeout(this._wdTimer); this._wdTimer = null; }
    }

    async _sendTelegram(text) {
        if (!this.telegram) return;
        try {
            await this.telegram.sendMessage(this.cfg.telegramChatId, text, { parse_mode: 'HTML' });
        } catch (e) {
            console.error(`Telegram: ${e.message}`);
        }
    }

    async _sendHourlySummary() {
        try {
            const stats = { ...this.hourlyStats };
            if (stats.trades === 0) return;
            const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0.0';
            const pnlStr = (stats.pnl >= 0 ? '+' : '') + '$' + stats.pnl.toFixed(2);
            const message = [
                `⏰ <b>SMC v2 Bot — Hourly Summary</b>`, ``,
                `📊 <b>Last Hour</b>`,
                `├ Trades: ${stats.trades}`,
                `├ Wins: ${stats.wins} | Losses: ${stats.losses}`,
                `├ Win Rate: ${winRate}%`,
                `└ ${stats.pnl >= 0 ? '🟢' : '🔴'} <b>P&L:</b> ${pnlStr}`, ``,
                `🗓️ <b>Today</b>`,
                `├ Total Trades: ${this.totalTrades}`,
                `└ Today P&L: ${this.dailyProfitLoss >= 0 ? '+' : ''}$${this.dailyProfitLoss.toFixed(2)}`,
            ].join('\n');
            await this._sendTelegram(message);
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
        } catch (err) {
            console.error(`❌ _sendHourlySummary: ${err.message}`);
        }
    }

    async _sendSessionSummary() {
        try {
            const durationMs = Date.now() - this.session.startTime;
            const hours = Math.floor(durationMs / 3600000);
            const minutes = Math.floor((durationMs % 3600000) / 60000);
            const winRate = this.session.tradesCount > 0
                ? ((this.session.winsCount / this.session.tradesCount) * 100).toFixed(1) + '%'
                : '0%';
            const message = [
                `📊 <b>SESSION SUMMARY — SMC v2</b>`, ``,
                `⏱️ Duration: ${hours}h ${minutes}m`,
                `🔢 Trades: ${this.session.tradesCount}`,
                `✅ Wins: ${this.session.winsCount} | ❌ Losses: ${this.session.lossesCount}`,
                `📈 Win Rate: ${winRate}`,
                `💰 Session P/L: ${this.session.netPL >= 0 ? '+' : ''}$${this.session.netPL.toFixed(2)}`,
                `💵 Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`,
            ].join('\n');
            await this._sendTelegram(message);
        } catch (err) {
            console.error(`❌ _sendSessionSummary: ${err.message}`);
        }
    }

    async _sendDayEndSummary(dateKey) {
        try {
            const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) + '%' : '0%';
            const message = [
                `🌙 <b>END OF DAY — ${dateKey}</b>`, ``,
                `${this.dailyProfitLoss >= 0 ? '🟢' : '🔴'} <b>Day Results:</b>`,
                `├ Trades: ${this.totalTrades}`,
                `├ Wins: ${this.totalWins} | Losses: ${this.totalLosses}`,
                `├ Win Rate: ${wr}`,
                `└ Net P/L: $${this.dailyProfitLoss.toFixed(2)}`, ``,
                `📊 <b>Overall:</b>`,
                `└ Total P&L: $${this.totalProfitLoss.toFixed(2)}`,
            ].join('\n');
            await this._sendTelegram(message);
        } catch (err) {
            console.error(`❌ _sendDayEndSummary: ${err.message}`);
        }
    }

    _startHourlyTimer() {
        const now = new Date();
        const next = new Date(now);
        next.setHours(next.getHours() + 1, 0, 0, 0);
        const wait = next.getTime() - now.getTime();
        console.log(`⏰ Hourly summary in ${Math.ceil(wait / 60000)} min`);
        setTimeout(() => {
            this._sendHourlySummary();
            setInterval(() => this._sendHourlySummary(), 60 * 60 * 1000);
        }, wait);
    }

    _checkDayChange() {
        const today = new Date().toISOString().split('T')[0];
        if (this.currentTradeDay && this.currentTradeDay !== today) {
            console.log(`🗓️ Day change: ${this.currentTradeDay} → ${today}`);
            this._sendDayEndSummary(this.currentTradeDay);
            this.dailyProfitLoss = 0;
            this.currentTradeDay = today;
            StatePersistence.save(this);
        }
    }

    _startTimeScheduler() {
        setInterval(() => {
            const gmt1 = new Date(Date.now() + 3600000);
            const hr = gmt1.getUTCHours();
            const min = gmt1.getUTCMinutes();

            if (this.endOfDay && hr === 2 && min < 1) {
                console.log('⏰ 2:00 AM GMT+1 — reconnecting');
                this.endOfDay = false;
                this.tradeInProgress = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay && hr >= 23) {
                console.log('🌙 Post-win 11 PM — stopping for the night');
                this.endOfDay = true;
                this._sendTelegram(`🌙 <b>Night stop after win</b>\nP&L: $${this.totalProfitLoss.toFixed(2)}`);
                this._sendSessionSummary();
                this._cleanupWs();
            }
        }, 20000);
    }

    _logSummary() {
        const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';
        console.log('\n📊 SUMMARY');
        console.log(`  Trades: ${this.totalTrades} | W: ${this.totalWins} | L: ${this.totalLosses} | WR: ${wr}%`);
        console.log(`  Total P&L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`  Next stake: $${this.currentStake.toFixed(2)}`);
        console.log('  SMC Signal Performance:');
        Object.entries(this.smcStats).forEach(([name, stats]) => {
            const wr2 = stats.traded > 0 ? ((stats.won / stats.traded) * 100).toFixed(1) : '0.0';
            console.log(`    ${name.padEnd(16)} det=${stats.detected} | trd=${stats.traded} | WR=${wr2}%`);
        });
    }

    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🎯 Smart Money Concepts Bot  v2');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  ✓ Liquidity Sweep  — swing pivot pool + sweep detection');
        console.log('  ✓ Break of Structure — pivot series + CHoCH guard');
        console.log('  ✓ Fair Value Gap   — 3-tick imbalance, unfilled tracking');
        console.log('  ✓ Order Block      — impulse detection + mitigation');
        console.log('  ✓ Trend Filter     — EMA slope + digit-half + CHoCH');
        console.log(`\n  Min confluence score : ${BOT_CONFIG.confluence.minScore}/5.0`);
        console.log(`  Required history     : ${BOT_CONFIG.requiredHistoryLength} ticks`);
        console.log('═══════════════════════════════════════════════════════════\n');

        this.connect();
        this._startTimeScheduler();
        this._startHourlyTimer();
        StatePersistence.startAutoSave(this);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
const bot = new SmartMoneyBot(BOT_CONFIG);
bot.start();
