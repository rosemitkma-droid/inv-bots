'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DERIV SYNTHETIC INDICES CALLE/PUTE BOT — v2  "CONSECUTIVE OPPOSITE"    ║
 * ║  STRATEGY:                                                               ║
 * ║  1. Last N (default 6, per-asset configurable) same candles →            ║
 * ║     opposite trade (6 BULL → PUTE, 6 BEAR → CALLE, Doji breaks streak)  ║
 * ║  2. Recovery (B + Exclusive): on loss → first recovery 58s (finish      ║
 * ║     current candle, no skip), then every next 1m candle 1m until win.  ║
 * ║     While recovery active, ONLY recovery asset trades (exclusive).       ║
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
const STATE_FILE = path.join(__dirname, 'bizArbitrage_trend4_01-state.json');
const HISTORY_FILE = path.join(__dirname, 'bizArbitrage_trend4_01-history.json');
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
    API_TOKEN: 'pat_27a3197287bae3ec6c2c9cbdd68fffaa2a524e3b0a6e1ecf298b5ffb338adb10',
    APP_ID: '33uslPtthXBEkQOdfKfoY',
    ACCOUNT_TYPE: 'demo',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // ── Recovery Strategy (from arbitrageRF.js) ──────────────
    // When enabled: After a loss, trade immediately on next candle in SAME direction (no analysis)
    // When disabled: After a loss, wait for pattern analysis signal
    USE_RECOVERY_STRATEGY: true,

    // ── Session / daily guards ───────────────────
    SESSION_PROFIT_TARGET: 500000,
    SESSION_STOP_LOSS: -508,
    COOLDOWN_CANDLES: 5,

    // ── Candle / Contract Settings (defaults, overridable per asset) ──
    GRANULARITY: 60,
    TIMEFRAME_LABEL: '1m',
    CANDLES_TO_LOAD: 15,
    MAX_CANDLES_STORED: 15,
    DURATION: 1,
    DURATION_UNIT: 'm',
    // MIN_CANDLES_REQUIRED: 82,

    // ── Consecutive Candle Pattern (user configurable) ──────────
    // Number of consecutive same-direction candles to trigger opposite trade
    PATTERN_CONSECUTIVE_COUNT: 6,
    // MIN_RECOVERY_SECONDS kept for backward compat (no longer used — recovery always 1m on candle close)
    MIN_RECOVERY_SECONDS: 10,

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
        'R_25',
        'R_50',
        'R_75',
        'R_100',
        '1HZ10V',
        '1HZ25V',
        '1HZ50V',
        '1HZ75V',
        '1HZ100V',
        'stpRNG',
        'stpRNG2',
        'stpRNG3',
        'stpRNG4',
        'stpRNG5'
    ],

    // ── Misc ──────────────────────────────────────────────────
    DEBUG_MODE: true,
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8565754902:AAHS6UQWEgLJ0DO-JTpAGQhZLs-UDVVNAQc',
    TELEGRAM_CHAT_ID: '752497117',
};

// ============================================================
// PER-ASSET CONFIGURATION (from arbitrageRF.js)
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
    INVESTMENT_AMOUNT: 508,

    // Martingale Settings
    MARTINGALE_MULTIPLIER: 1.48, //1.48
    MAX_MARTINGALE_LEVEL: 1, //1
    AFTER_MAX_LOSS: 'continue', // 'continue' | 'reset' | 'stop' 
    CONTINUE_EXTRA_LEVELS: 9,
    EXTRA_LEVEL_MULTIPLIERS: [2.1, 2.2, 2, 2.1, 2.2, 2.3, 2.2, 2.3], //[2.1, 2.2, 2, 2.3]

    // Auto-Compounding
    AUTO_COMPOUNDING: false,
    COMPOUND_PERCENTAGE: 0.1,

    // Risk Management
    STOP_LOSS: 508,

    // Pattern Analysis Settings — CONSECUTIVE OPPOSITE logic
    // Number of consecutive same candles (B or R) required before opposite trade
    // Doji breaks the streak (no trade). User can set per-asset via ASSET_CONFIGS.
    PATTERN_CONSECUTIVE_COUNT: 8,
    PATTERN_DOJI_THRESHOLD: 0.00001,
    // MIN_RECOVERY_SECONDS kept for compat (recovery now always 1m on candle close)
    MIN_RECOVERY_SECONDS: 10,
    // Legacy fields retained for compat but unused in consecutive mode
    PATTERN_MIN_CONFIDENCE: 0.10,
    MIN_PATTERN_CONFIDENCE: 0.10,
    MIN_PATTERN_CONFIDENCE_STEP_RNG: 0.10,
    PATTERN_LENGTHS: [2],
    PATTERN_MIN_OCCURRENCES: 1,
    PATTERN_RECENCY_DECAY: 0.9990,
};

const ASSET_CONFIGS = {
    // Per-asset consecutive count override example:
    'R_10': {
        PATTERN_CONSECUTIVE_COUNT: 6
    },
    'R_25': {
        PATTERN_CONSECUTIVE_COUNT: 8
    },
    'R_50': {
        PATTERN_CONSECUTIVE_COUNT: 8
    },
    'R_75': {
        PATTERN_CONSECUTIVE_COUNT: 8
    },
    'R_100': {
        PATTERN_CONSECUTIVE_COUNT: 8
    },
    '1HZ10V': {
        PATTERN_CONSECUTIVE_COUNT: 6
    },
    '1HZ25V': {
        PATTERN_CONSECUTIVE_COUNT: 10
    },
    '1HZ50V': {
        PATTERN_CONSECUTIVE_COUNT: 8
    },
    '1HZ75V': {
        PATTERN_CONSECUTIVE_COUNT: 6
    },
    '1HZ100V': {
        PATTERN_CONSECUTIVE_COUNT: 7
    },
    'stpRNG': {
        PATTERN_CONSECUTIVE_COUNT: 10
    },
    'stpRNG2': {
        PATTERN_CONSECUTIVE_COUNT: 10
    },
    'stpRNG3': {
        PATTERN_CONSECUTIVE_COUNT: 8
    },
    'stpRNG4': {
        PATTERN_CONSECUTIVE_COUNT: 8
    },
    'stpRNG5': {
        PATTERN_CONSECUTIVE_COUNT: 7
    },
};

function getAssetConfig(symbol) {
    const overrides = ASSET_CONFIGS[symbol] || {};
    return { ...DEFAULT_ASSET_CONFIG, ...overrides };
}

// ============================================================
// CANDLE PATTERN ANALYZER CLASS (from arbitrageRF.js)
// ============================================================
class CandlePatternAnalyzer {
  constructor(options = {}) {
    this.minConfidence = options.minConfidence || 0.60;
    this.patternLengths = options.patternLengths || [3, 4, 5, 6, 7, 8];
    this.minOccurrences = options.minOccurrences || 5;
    this.recencyDecay = options.recencyDecay || 0.9990;
    this.dojiThreshold = options.dojiThreshold || 0.00001;
    this.lastAnalysis = null;
    this.lastAnalysisTime = 0;
  }

  classifyCandle(candle) {
    const bodySize = Math.abs(candle.close - candle.open);
    const threshold = candle.open * this.dojiThreshold;
    if (bodySize <= threshold) return 'D';
    if (candle.close > candle.open) return 'B';
    return 'R';
  }

  classifyAll(candles) {
    return candles.map(c => this.classifyCandle(c));
  }

  // ── CONSECUTIVE OPPOSITE LOGIC (replaces legacy pattern analysis) ──
  // Checks last N closed candles: if all B → trade PUTE, all R → trade CALLE
  // Doji breaks streak (no trade). N is configurable per asset.
  checkConsecutiveOpposite(closedCandles, consecutiveCount) {
    const N = consecutiveCount || 6;
    if (!closedCandles || closedCandles.length < N) {
      return {
        shouldTrade: false,
        direction: null,
        confidence: 0,
        reason: `Insufficient candles: ${closedCandles ? closedCandles.length : 0} < ${N} required`,
        details: { consecutiveCount: N, totalCandles: closedCandles ? closedCandles.length : 0 }
      };
    }
    const lastN = closedCandles.slice(-N);
    const types = this.classifyAll(lastN);
    const typesStr = types.join('');

    // Doji breaks streak
    if (types.includes('D')) {
      return {
        shouldTrade: false,
        direction: null,
        confidence: 0,
        reason: `Streak broken by Doji in last ${N}: ${typesStr}`,
        details: { consecutiveCount: N, types: typesStr, totalCandles: closedCandles.length }
      };
    }

    const allBullish = types.every(t => t === 'B');
    const allBearish = types.every(t => t === 'R');

    if (allBullish) {
      const result = {
        shouldTrade: true,
        direction: 'PUTE',
        confidence: 1,
        reason: `Last ${N} candles all BULLISH (${typesStr}) → opposite PUTE`,
        details: { consecutiveCount: N, types: typesStr, totalCandles: closedCandles.length }
      };
      this.lastAnalysis = result;
      this.lastAnalysisTime = Date.now();
      return result;
    }
    if (allBearish) {
      const result = {
        shouldTrade: true,
        direction: 'CALLE',
        confidence: 1,
        reason: `Last ${N} candles all BEARISH (${typesStr}) → opposite CALLE`,
        details: { consecutiveCount: N, types: typesStr, totalCandles: closedCandles.length }
      };
      this.lastAnalysis = result;
      this.lastAnalysisTime = Date.now();
      return result;
    }

    return {
      shouldTrade: false,
      direction: null,
      confidence: 0,
      reason: `Last ${N} not uniform: ${typesStr}`,
      details: { consecutiveCount: N, types: typesStr, totalCandles: closedCandles.length }
    };
  }

  // Legacy analyze kept for compat but delegates to consecutive logic
  analyze(closedCandles, consecutiveCount) {
    const N = consecutiveCount || 6;
    return this.checkConsecutiveOpposite(closedCandles, N);
  }

  getAnalysisSummary(result) {
    if (!result || !result.details || !result.details.patternResults) {
      return 'No analysis available';
    }

    const lines = [];
    lines.push(`📊 Pattern Analysis (${result.details.totalCandlesAnalyzed} candles):`);
    lines.push(`   Decision: ${result.details.decisionMethod}`);

    for (const r of result.details.patternResults) {
      const dirIcon = r.direction === 'CALLE' ? '🟢' : '🔴';
      lines.push(
        `   L${r.patternLength} "${r.pattern}" → ${dirIcon} ${(r.confidence * 100).toFixed(1)}% (${r.rawOccurrences} matches)`
      );
    }

    if (result.shouldTrade) {
      lines.push(`   ✅ SIGNAL: ${result.direction} @ ${(result.confidence * 100).toFixed(1)}%`);
    } else {
      lines.push(`   ⏳ NO TRADE: ${(result.confidence * 100).toFixed(1)}% < ${(this.minConfidence * 100).toFixed(1)}%`);
    }

    return lines.join('\n');
  }
}

// ============================================================
// STRATEGY ENGINE — single decision point shared by live + backtest
// Pure function over assetState snapshot + ctx. NO side effects.
// Action enum:
//   'skip'           — no trade this candle
//   'recovery_first' — first recovery trade (58s remaining on current candle)
//   'recovery_1m'    — subsequent recovery trade (full next 1m candle)
//   'enter'          — pattern-driven trade (CALLE or PUTE)
// ============================================================
class StrategyEngine {
    static decide(symbol, assetState, cfg, ctx = {}) {
        const isSessionActive = ctx.isSessionActive !== false; // default true
        const isAnyOtherInRecovery = !!ctx.isAnyOtherInRecovery;
        if (!isSessionActive) {
            return { action: 'skip', direction: null, analysis: null, reason: 'session_inactive' };
        }
        // Cooldown: live decrements BEFORE deciding (handleOHLC ~1802). Caller must
        // have already decremented cooldownCandles for this candle. We only read it.
        if ((assetState.cooldownCandles || 0) > 0) {
            return { action: 'skip', direction: null, analysis: null, reason: 'cooldown' };
        }
        // Exclusive: if some OTHER asset is in recovery, only it may trade.
        if (isAnyOtherInRecovery && !assetState.isRecovery) {
            return { action: 'skip', direction: null, analysis: null, reason: 'recovery_exclusive' };
        }
        // Recovery path (B-style): same direction as last loss
        if (CONFIG.USE_RECOVERY_STRATEGY && assetState.isRecovery && assetState.lastTradeDirection) {
            if (!assetState.recoveryFirstDone) {
                return {
                    action: 'recovery_first',
                    direction: assetState.lastTradeDirection,
                    analysis: null,
                    reason: 'recovery_first_58s',
                };
            }
            return {
                action: 'recovery_1m',
                direction: assetState.lastTradeDirection,
                analysis: null,
                reason: 'recovery_1m_until_win',
            };
        }
        // Pattern-driven entry
        const N = cfg.PATTERN_CONSECUTIVE_COUNT || CONFIG.PATTERN_CONSECUTIVE_COUNT || 6;
        const analyzer = assetState.patternAnalyzer
            || new CandlePatternAnalyzer({ dojiThreshold: cfg.PATTERN_DOJI_THRESHOLD });
        const analysis = analyzer.checkConsecutiveOpposite(assetState.closedCandles || [], N);
        if (!analysis.shouldTrade) {
            return { action: 'skip', direction: null, analysis, reason: analysis.reason || 'no_pattern' };
        }
        return { action: 'enter', direction: analysis.direction, analysis, reason: analysis.reason };
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
// NOTE: Deriv ticks_history candles return `epoch` as the candle CLOSE.
//   open_time is therefore computed as floor((epoch - granularity) / granularity) * granularity.
//   This matches live handleCandlesHistory mapping below (epoch == close).
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
            const d = Number(opts.days);
            if (!Number.isFinite(d) || d <= 0) throw new Error(`Invalid --days: ${opts.days}`);
            want = Math.ceil(d * 86400 / granularity);
        } else if (!want) {
            want = 30 * 1440; // default 30 days of 1m
        }
        if (want > 500000) {
            this.logger.warn(`Requested ${want} candles exceeds 500000 cap — clamping`);
            want = 500000;
        }
        want = Math.max(1, want);
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
                    epoch: c.epoch,
                    // epoch = candle close → open_time = floor((epoch-granularity)/granularity)*granularity
                    open_time: Math.floor((c.epoch - granularity) / granularity) * granularity
                })).filter(c => Number.isFinite(c.open) && Number.isFinite(c.close));
                if (!candles.length) break;
                candles.sort((a,b)=>a.open_time-b.open_time);
                const existing = new Set(all.map(x=>x.open_time));
                const uniq = candles.filter(c=> !existing.has(c.open_time));
                all.unshift(...uniq);
                const earliest = candles[0];
                if (!earliest || candles.length < batch) break;
                end = earliest.epoch - 1;
                if (startEpoch && end < startEpoch) break;
                await new Promise(res=> setTimeout(res, 300));
            }
        } finally {
            try { ws.close(); } catch {}
        }
        // dedup (paranoid) + sort ascending + trim to want
        const dedup = new Map();
        for (const c of all) dedup.set(c.open_time, c);
        const merged = [...dedup.values()].sort((a,b)=>a.open_time-b.open_time);
        const dupesRemoved = all.length - merged.length;
        if (dupesRemoved > 0) this.logger.warn(`Fetch dedup removed ${dupesRemoved} duplicate candle(s)`);
        if (merged.length > want) return { candles: merged.slice(-want), requested: want, fetched: merged.length, dupesRemoved };
        return { candles: merged, requested: want, fetched: merged.length, dupesRemoved };
    }
}

// ============================================================
// BACKTEST ENGINE — exact live strategy replay per asset
// Drives StrategyEngine.decide() with a full assetState mirror.
// ============================================================
class BacktestEngine {
    static wilsonLowerBound(wins, n, z=1.645) {
        if (n===0) return 0;
        const p=wins/n, denom=1+(z*z)/n, centre=p+(z*z)/(2*n), margin=z*Math.sqrt((p*(1-p)/n)+(z*z)/(4*n*n));
        return (centre - margin)/denom;
    }
    static breakeven(payout){ return 1/(1+payout); }
    async run(symbol, candles, opts={}) {
        // Backwards compat: caller may pass {candles, requested, fetched, dupesRemoved}
        const candleList = Array.isArray(candles) ? candles : (candles?.candles || []);
        const candleStats = Array.isArray(candles) ? null : candles;

        const payoutRatio = Number.isFinite(opts.payoutRatio) ? opts.payoutRatio : (Number.isFinite(opts.payout) ? opts.payout : 0.90);
        const cfg = getAssetConfig(symbol);

        // ── Stateful asset mirror (mirrors state.assets[symbol]) ──────────
        const assetState = {
            closedCandles: [],
            lastTradeDirection: null,
            isRecovery: false,
            recoveryFirstDone: false,
            forceRecoverDirection: null,
            martingaleLevel: 0,
            consecutiveLosses: 0,
            consecutiveWins: 0,
            cooldownCandles: 0,
            investmentRemaining: cfg.INVESTMENT_AMOUNT,
            baseStake: cfg.INITIAL_STAKE,
            currentStake: cfg.INITIAL_STAKE,
            patternAnalyzer: new CandlePatternAnalyzer({ dojiThreshold: cfg.PATTERN_DOJI_THRESHOLD }),
            tradesCount: 0, winsCount: 0, lossesCount: 0,
            profit: 0, loss: 0, netPL: 0,
        };

        // Session guard (one-shot per run, mirrors SessionManager.checkSessionTargets)
        const session = { isActive: true, netPL: 0 };

        let totalStake = 0;
        let sessionNetPL = 0;
        let maxDrawdown = 0;
        let peakPL = 0;
        const trades = [];
        const streakCounts = {};
        let curStreak = 0;
        let maxStreak = 0;
        const perDayPnl = {};

        for (let i = 0; i < candleList.length; i++) {
            const c = candleList[i];
            if (!c || !Number.isFinite(c.close)) continue;

            // ── 1. Append closed candle (mirrors handleOHLC closed-candle push)
            assetState.closedCandles.push(c);
            if (assetState.closedCandles.length > CONFIG.MAX_CANDLES_STORED) {
                assetState.closedCandles = assetState.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED);
            }

            // ── 2. Decrement cooldown BEFORE decision (live: handleOHLC ~1802)
            if (assetState.cooldownCandles > 0) {
                assetState.cooldownCandles--;
                if (assetState.cooldownCandles === 0) assetState.forceRecoverDirection = null;
            }

            // ── 3. Session check (mirror checkSessionTargets one-shot)
            if (CONFIG.SESSION_PROFIT_TARGET && sessionNetPL >= CONFIG.SESSION_PROFIT_TARGET) session.isActive = false;
            if (CONFIG.SESSION_STOP_LOSS && sessionNetPL <= CONFIG.SESSION_STOP_LOSS) session.isActive = false;

            // ── 4. Shared decision
            const decision = StrategyEngine.decide(symbol, assetState, cfg, {
                isSessionActive: session.isActive,
                isAnyOtherInRecovery: false, // single-asset backtest (documented limitation)
            });
            if (decision.action === 'skip') continue;

            // ── 5. Need next candle to settle
            if (i + 1 >= candleList.length) break;
            const next = candleList[i + 1];
            if (!next || !Number.isFinite(next.close)) continue;

            // ── 6. Stake (uses same StakeCalculator as live)
            const stake = StakeCalculator.calculate(symbol, assetState.martingaleLevel, assetState.investmentRemaining);
            if (stake > assetState.investmentRemaining) continue; // insufficient pool — skip (mirrors live)

            assetState.investmentRemaining = Number((assetState.investmentRemaining - stake).toFixed(2));
            totalStake += stake;

            // ── 7. Settle on next candle close
            const entryClose = c.close;
            const exitClose = next.close;
            const won = decision.direction === 'CALLE' ? exitClose > entryClose : exitClose < entryClose;
            const pnl = won ? Number((stake * payoutRatio).toFixed(2)) : -stake;
            const netPLDelta = pnl;
            const isRecoveryTrade = decision.action === 'recovery_first' || decision.action === 'recovery_1m';

            trades.push({
                idx: i,
                open_time: c.open_time,
                close_time: next.open_time,
                decision: decision.action,
                decision_reason: decision.reason,
                direction: decision.direction,
                stake,
                won,
                pnl,
                level: assetState.martingaleLevel,
                isRecovery: isRecoveryTrade,
                recoveryFirst: decision.action === 'recovery_first',
            });

            // ── 8. Mirror SessionManager.recordTradeResult
            assetState.tradesCount++;
            sessionNetPL = Number((sessionNetPL + netPLDelta).toFixed(2));
            if (won) {
                assetState.winsCount++;
                assetState.profit += pnl;
                assetState.netPL += pnl;
                assetState.lastTradeDirection = decision.direction;
                assetState.isRecovery = false;
                assetState.recoveryFirstDone = false;
                assetState.martingaleLevel = 0;
                assetState.consecutiveLosses = 0;
                assetState.consecutiveWins++;
                curStreak = 0;
                assetState.investmentRemaining = Number((assetState.investmentRemaining + stake + pnl).toFixed(2));
                assetState.forceRecoverDirection = null;
                assetState.baseStake = StakeCalculator.getBaseStake(symbol, assetState.investmentRemaining);
                assetState.currentStake = StakeCalculator.calculate(symbol, 0, assetState.investmentRemaining);
            } else {
                assetState.lossesCount++;
                assetState.loss += Math.abs(pnl);
                assetState.netPL += pnl;
                assetState.lastTradeDirection = decision.direction;
                assetState.forceRecoverDirection = decision.direction;
                assetState.martingaleLevel = (assetState.martingaleLevel || 0) + 1;
                assetState.consecutiveLosses++;
                assetState.consecutiveWins = 0;
                const wasAlreadyRecovery = assetState.isRecovery;
                assetState.isRecovery = true;
                if (!wasAlreadyRecovery) assetState.recoveryFirstDone = false;
                // B logic: first recovery execution marks done — but in backtest we set it
                // optimistically since we settle at next candle close. The live bot sets
                // recoveryFirstDone after executeRecoveryTradeImmediate returns true.
                if (!assetState.recoveryFirstDone) assetState.recoveryFirstDone = true;
                curStreak++;
                if (curStreak > maxStreak) maxStreak = curStreak;
                const key = 'x' + Math.min(curStreak, 12);
                streakCounts[key] = (streakCounts[key] || 0) + 1;
                if (assetState.consecutiveLosses >= 10) {
                    assetState.martingaleLevel = 0;
                    assetState.cooldownCandles = CONFIG.COOLDOWN_CANDLES;
                    assetState.forceRecoverDirection = null;
                }
                assetState.currentStake = StakeCalculator.calculate(symbol, assetState.martingaleLevel, assetState.investmentRemaining);
            }

            // Track drawdown + per-day PnL
            if (assetState.netPL > peakPL) peakPL = assetState.netPL;
            const dd = peakPL - assetState.netPL;
            if (dd > maxDrawdown) maxDrawdown = dd;
            const dayKey = new Date(c.open_time * 1000).toISOString().slice(0, 10);
            perDayPnl[dayKey] = Number(((perDayPnl[dayKey] || 0) + netPLDelta).toFixed(2));
        }

        const total = trades.length;
        const wins = trades.filter(t => t.won).length;
        const losses = total - wins;
        const winRate = total ? wins / total : 0;
        const breakeven = BacktestEngine.breakeven(payoutRatio);
        const expectancyPerTrade = total ? trades.reduce((s, t) => s + t.pnl, 0) / total : 0;
        const lb = BacktestEngine.wilsonLowerBound(wins, total);
        let verdict;
        if (total < 200) verdict = 'INSUFFICIENT SAMPLE — need ≥200 trades';
        else if (winRate > breakeven && expectancyPerTrade > 0) verdict = 'POSITIVE EDGE (tentative)';
        else verdict = 'NO EDGE — do not trade live';

        const N = cfg.PATTERN_CONSECUTIVE_COUNT ?? CONFIG.PATTERN_CONSECUTIVE_COUNT ?? 6;
        const filtered = Object.keys(streakCounts).filter(k => parseInt(k.slice(1)) >= 2).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
        const streakStr = filtered.map(k => `${k}:${streakCounts[k]}`).join(' ') || 'none';

        return {
            symbol,
            N,
            granularity: cfg.GRANULARITY,
            payoutRatio,
            breakeven: Number((breakeven * 100).toFixed(2)),
            periodFrom: candleList[0]?.open_time ? new Date(candleList[0].open_time * 1000).toISOString() : null,
            periodTo: candleList[candleList.length - 1]?.open_time ? new Date(candleList[candleList.length - 1].open_time * 1000).toISOString() : null,
            candles: candleList.length,
            trades: total,
            wins,
            losses,
            winRate: Number((winRate * 100).toFixed(2)),
            lossRate: Number(((losses / total) * 100 || 0).toFixed(2)),
            profitRatio: Number((winRate * 100).toFixed(2)),
            netPL: Number(assetState.netPL.toFixed(2)),
            totalStake: Number(totalStake.toFixed(2)),
            avgStake: total ? Number((totalStake / total).toFixed(2)) : 0,
            expectancyPerTrade: Number(expectancyPerTrade.toFixed(4)),
            breakevenWinRate: Number((breakeven * 100).toFixed(2)),
            streakCounts,
            maxConsecutiveLosses: maxStreak,
            streakSummary: streakStr,
            maxDrawdown: Number(maxDrawdown.toFixed(2)),
            perDayPnl,
            successProbability: Number((lb * 100).toFixed(2)),
            wilsonLowerBound: Number((lb * 100).toFixed(2)),
            verdict,
            ranAt: new Date().toISOString(),
            // ── Provenance: prove what was actually simulated ──
            strategyParity: {
                exclusiveSimulated: false,          // single-asset; cross-asset mutex not modelled
                cooldownDecrementedBeforeDecision: true,
                martingaleResetAfterExtra: false,    // live does NOT reset; backtest matches
                sessionGateActive: true,             // SESSION_PROFIT_TARGET / STOP_LOSS one-shot
                firstRecovery58sApproximated: true,  // entry at i.close, settle at i+1.close
                sharedStrategyEngine: true,          // calls StrategyEngine.decide (same as live)
            },
            effectiveConfig: {
                PATTERN_CONSECUTIVE_COUNT: cfg.PATTERN_CONSECUTIVE_COUNT,
                PATTERN_DOJI_THRESHOLD: cfg.PATTERN_DOJI_THRESHOLD,
                INVESTMENT_AMOUNT: cfg.INVESTMENT_AMOUNT,
                INITIAL_STAKE: cfg.INITIAL_STAKE,
                MARTINGALE_MULTIPLIER: cfg.MARTINGALE_MULTIPLIER,
                MAX_MARTINGALE_LEVEL: cfg.MAX_MARTINGALE_LEVEL,
                CONTINUE_EXTRA_LEVELS: cfg.CONTINUE_EXTRA_LEVELS,
                EXTRA_LEVEL_MULTIPLIERS: cfg.EXTRA_LEVEL_MULTIPLIERS,
                COOLDOWN_CANDLES: CONFIG.COOLDOWN_CANDLES,
                SESSION_PROFIT_TARGET: CONFIG.SESSION_PROFIT_TARGET,
                SESSION_STOP_LOSS: CONFIG.SESSION_STOP_LOSS,
                USE_RECOVERY_STRATEGY: CONFIG.USE_RECOVERY_STRATEGY,
                GRANULARITY: cfg.GRANULARITY,
            },
            candleStats: candleStats || null,
            sampleTrades: trades.slice(0, 10),
        };
    }
    formatReport(r){
        if(!r) return 'No backtest';
        const cfg = getAssetConfig(r.symbol);
        const xn = r.maxConsecutiveLosses ? `x2..x${r.maxConsecutiveLosses}` : 'x2..xn';
        const streakStr = r.streakSummary || 'none';
        const parity = r.strategyParity || {};
        const parityFlags = [
            parity.exclusiveSimulated ? 'exclusive:ON' : 'exclusive:OFF',
            parity.cooldownDecrementedBeforeDecision ? 'cooldown-pre:ON' : 'cooldown-pre:OFF',
            parity.sessionGateActive ? 'session-gate:ON' : 'session-gate:OFF',
            parity.firstRecovery58sApproximated ? 'recovery-58s:approx' : 'recovery-58s:exact',
            parity.sharedStrategyEngine ? 'shared-engine:YES' : 'shared-engine:NO',
        ].join(' ');
        const periodLine = r.candleStats
            ? `Period: ${r.periodFrom} → ${r.periodTo} (requested ${r.candleStats.requested}, fetched ${r.candleStats.fetched}, dupes removed ${r.candleStats.dupesRemoved}, granularity ${r.granularity}s)`
            : `Period: ${r.periodFrom} → ${r.periodTo} (${r.candles} candles, ${r.granularity}s)`;
        return [
            `🧪 BACKTEST — ${r.symbol} (N=${r.N}, payout ${(r.payoutRatio*100).toFixed(0)}%, stake $${cfg.INITIAL_STAKE}×${cfg.MARTINGALE_MULTIPLIER}, pool $${cfg.INVESTMENT_AMOUNT})`,
            periodLine,
            `Trades: ${r.trades} (${r.wins}W / ${r.losses}L)  WinRate ${r.winRate}% / Loss ${r.lossRate}% (need ≥ ${r.breakevenWinRate}% BE)`,
            `Net P/L: $${r.netPL.toFixed(2)} (staked $${r.totalStake.toFixed(2)}, avg $${r.avgStake.toFixed(2)}, max DD $${(r.maxDrawdown||0).toFixed(2)})`,
            `Expectancy/trade: ${r.expectancyPerTrade>=0?'+':''}${r.expectancyPerTrade}`,
            `Streaks ${xn}: ${streakStr}  Max consecutive losses: ${r.maxConsecutiveLosses}`,
            `Wilson LB 90%: ${r.wilsonLowerBound}% vs BE ${r.breakevenWinRate}%`,
            `Parity: ${parityFlags}`,
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
                    forceRecoverDirection: a.forceRecoverDirection,
                    recoveryStep: a.recoveryStep,
                    currentStake: a.currentStake,
                    baseStake: a.baseStake,
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
                        a.forceRecoverDirection = saved.forceRecoverDirection ?? null;
                        a.recoveryStep = saved.recoveryStep || 0;
                        a.martingaleLevel = saved.martingaleLevel || 0;
                        a.currentStake = saved.currentStake || StakeCalculator.calculate(symbol, 0, a.investmentRemaining);
                        a.baseStake = saved.baseStake || StakeCalculator.getBaseStake(symbol, a.investmentRemaining);
                        a.investmentRemaining = saved.investmentRemaining || getAssetConfig(symbol).INVESTMENT_AMOUNT;
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

        // Build analysis details for OPEN trades
        let analysisDetails = '';
        if (type === 'OPEN' && details) {
            if (details.isRecovery) {
                analysisDetails = `
        🔄 <b>RECOVERY MODE: YES</b> (${duration}${(durationUnit||'m').toUpperCase()} full 1m candle, every candle until win)
        ⚡ Same direction as loss trade (NO pattern analysis)`;
            } else if (details.analysis) {
                const analysis = details.analysis;
                const typesStr = analysis?.details?.types || 'N/A';
                const N = analysis?.details?.consecutiveCount || getAssetConfig(symbol).PATTERN_CONSECUTIVE_COUNT || CONFIG.PATTERN_CONSECUTIVE_COUNT;
                analysisDetails = `
        🧠 <b>CONSECUTIVE PATTERN (N=${N}):</b>
        📊 Last ${N}: ${typesStr}
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
        ${emoji} <b>${type} ARBITRAGE4 TRADE ALERT - ${recoveryStatus}</b>

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
            `⏰ <b>ARBITRAGE4 PATTERN BOT HOURLY SUMMARY</b>`,
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
            `\u{1f4ca} <b>ARBITRAGE4 CANDLE PATTERN BOT SESSION SUMMARY</b>`,
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
            `\u{1f916} <b>ARBITRAGE4 PATTERN BOT STARTED</b>`,
            `Strategy: Candle Pattern Recognition + Grid Martingale`,
            `Risk: Martingale progression with cap $${getAssetConfig(CONFIG.ACTIVE_ASSETS[0]).INVESTMENT_AMOUNT}`,
            `Recovery: ${CONFIG.USE_RECOVERY_STRATEGY ? 'ENABLED (immediate same-direction retry)' : 'DISABLED (wait for pattern analysis)'}`,
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
                `\u{1f319} <b>ARBITRAGE4 PATTERN BOT END OF DAY ${state.currentTradeDay}</b>\nP/L: $${(dayStats?.netPL || 0).toFixed(2)}\nCapital: $${state.capital.toFixed(2)}`
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

            // Exit recovery mode on win — revert to default 1m duration
            if (a.isRecovery) {
                a.isRecovery = false;
                LOGGER.info(`[${symbol}] Recovery mode EXITED - Win achieved → revert to ${getAssetConfig(symbol).DURATION}${getAssetConfig(symbol).DURATION_UNIT}`);
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

            // Enter recovery mode on loss (if recovery strategy is enabled)
            if (CONFIG.USE_RECOVERY_STRATEGY) {
                const wasAlreadyRecovery = a.isRecovery;
                a.isRecovery = true;
                a.pendingRecovery = false;
                if (!wasAlreadyRecovery) a.recoveryFirstDone = false;
                LOGGER.info(`[${symbol}] Recovery mode ENTERED - First recovery 58s (finish current candle), then 1m every candle until win (exclusive asset)`);
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

            if (a.consecutiveLosses >= 10) {
                const assetCfg = getAssetConfig(symbol);
                a.currentStake = assetCfg.INITIAL_STAKE;
                a.cooldownCandles = CONFIG.COOLDOWN_CANDLES;
                a.forceRecoverDirection = null;
                LOGGER.warn(`[${symbol}] 10 consecutive losses — cooling down for ${CONFIG.COOLDOWN_CANDLES} candles`);
                TelegramService.sendMessage(
                    `❄️ <b>[${symbol}] ARBITRAGE4 PATTERN BOT COOL-DOWN ACTIVATED</b>\n` +
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
                    // Pattern analyzer — consecutive opposite logic (Doji breaks streak)
                    patternAnalyzer: new CandlePatternAnalyzer({
                        dojiThreshold: assetConfig.PATTERN_DOJI_THRESHOLD
                    }),
                    lastTradeDirection: null,
                    lastTradeWasWin: null,
                    isRecovery: false,
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

                    const dir = closed.close > closed.open ? '\u{1f7e2}' : '\u{1f534}';
                    const time = new Date(closed.epoch * 1000).toISOString();
                    LOGGER.candle(`${dir} [${symbol}] CANDLE CLOSED [${time}] O:${closed.open.toFixed(5)} H:${closed.high.toFixed(5)} L:${closed.low.toFixed(5)} C:${closed.close.toFixed(5)} | Total: ${a.closedCandles.length}`);

                    if (a.cooldownCandles > 0) {
                        a.cooldownCandles--;
                        if (a.cooldownCandles === 0) a.forceRecoverDirection = null;
                        LOGGER.info(`❄️ [${symbol}] Cool-down: ${a.cooldownCandles} candles remaining`);
                    }

                    a.canTrade = true;

                    // Exclusive recovery: if any asset is in recovery, only that asset may trade
                    const recoveryAsset = bot._getRecoveryAsset ? bot._getRecoveryAsset() : null;
                    if (recoveryAsset && recoveryAsset !== symbol) {
                        LOGGER.info(`[${symbol}] Candle closed but blocked — recovery exclusive on ${recoveryAsset} (no skip for ${recoveryAsset}, wait)`);
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
            TelegramService.sendMessage(`⚠️ <b>ARBITRAGE4 PATTERN BOT CONNECTION LOST</b> — Reconnecting (attempt ${this.reconnectAttempts})`);

            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (this.isShuttingDown) return;
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached — giving up');
            TelegramService.sendMessage(`\u{1f6d1} <b>ARBITRAGE4 PATTERN BOT STOPPED</b> — Max reconnections\nFinal P/L: $${(state.session.netPL || 0).toFixed(2)}`);
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
        console.log(' DERIV CALLE/PUTE BOT v2 — CONSECUTIVE OPPOSITE + IMMEDIATE RECOVERY');
        console.log('═'.repeat(74));
        console.log(`Assets    : ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        const nDefault = CONFIG.PATTERN_CONSECUTIVE_COUNT;
        console.log(`Pattern   : Last N=${nDefault} same (B→PUTE, R→CALLE, Doji breaks) — per-asset override via ASSET_CONFIGS`);
        console.log(`Timeframe : ${CONFIG.TIMEFRAME_LABEL} candles | Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT} | Recovery B: first 58s (finish current candle), then 1m every candle (exclusive asset) until win`);
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

    // ── Exclusive recovery helper (only recovery asset may trade) ──
    _getRecoveryAsset() {
        for (const sym of CONFIG.ACTIVE_ASSETS) {
            const a = state.assets[sym];
            if (a && a.isRecovery) return sym;
        }
        return null;
    }
    _hasAnyRecovery() { return !!this._getRecoveryAsset(); }

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
            const typesStr = analysis?.details?.types || 'N/A';
            const N = analysis?.details?.consecutiveCount || getAssetConfig(symbol).PATTERN_CONSECUTIVE_COUNT || CONFIG.PATTERN_CONSECUTIVE_COUNT;
            LOGGER.trade(`   Recovery Mode: NO | N=${N} ${typesStr} → ${direction} | Stake: $${stake.toFixed(2)} | Martingale: L${assetState.martingaleLevel} | Duration: ${duration}${durationUnit}`);
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
        // Exclusive: only recovery asset may trade while any asset is in recovery
        const recoveryAsset = this._getRecoveryAsset();
        if (recoveryAsset && recoveryAsset !== symbol) {
            LOGGER.info(`[${symbol}] Blocked — recovery exclusive on ${recoveryAsset}`);
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
    // Called on every candle close. Delegates decision to StrategyEngine
    // so live and backtest share identical branching.
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

        // Exclusive recovery: only recovery asset may trade
        const recoveryAsset = this._getRecoveryAsset();
        const isAnyOtherInRecovery = !!recoveryAsset && recoveryAsset !== symbol;

        // Shared decision (mirrors backtest)
        const decision = StrategyEngine.decide(symbol, assetState, assetConfig, {
            isSessionActive: SessionManager.isSessionActive(),
            isAnyOtherInRecovery,
        });

        if (decision.action === 'skip') {
            if (decision.reason === 'recovery_exclusive') {
                LOGGER.info(`[${symbol}] Blocked — recovery exclusive on ${recoveryAsset} (normal trades paused)`);
                assetState.canTrade = false;
            } else if (decision.reason === 'cooldown') {
                LOGGER.info(`[${symbol}] In cool-down (${assetState.cooldownCandles} candles remaining) — skipping`);
                assetState.canTrade = false;
            } else if (decision.reason === 'session_inactive') {
                // session already checked above
            } else if (decision.analysis) {
                LOGGER.info(`[${symbol}] No trade — ${decision.analysis.reason}`);
            }
            assetState.canTrade = false;
            return;
        }

        if (decision.action === 'recovery_first' || decision.action === 'recovery_1m') {
            if (assetState.cooldownCandles > 0) {
                LOGGER.info(`[${symbol}] In recovery but cool-down ${assetState.cooldownCandles} — skipping`);
                assetState.canTrade = false;
                return;
            }
            this.executeRecoveryTradeImmediate(symbol);
            return;
        }

        // decision.action === 'enter'
        const N = assetConfig.PATTERN_CONSECUTIVE_COUNT ?? CONFIG.PATTERN_CONSECUTIVE_COUNT ?? 6;
        assetState.lastAnalysis = decision.analysis;
        LOGGER.trade(`🎯 [${symbol}] CONSECUTIVE SIGNAL N=${N} ${decision.analysis.details.types} → ${decision.direction} | ${decision.reason}`);
        this._executeBuy(symbol, decision.direction, false, decision.analysis);
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
            `⚠️ <b>ARBITRAGE4 PATTERN STUCK TRADE RECOVERED [${reason}]</b>\n` +
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
    // Validate inputs early so we fail before any network call
    if (opts.days !== null && opts.days !== undefined) {
        const d = Number(opts.days);
        if (!Number.isFinite(d) || d <= 0) {
            LOGGER.error(`Invalid --days: ${opts.days} (must be a positive number)`);
            process.exit(2);
        }
        opts.days = d;
    }
    if (opts.candles !== null && opts.candles !== undefined) {
        const c = Number(opts.candles);
        if (!Number.isFinite(c) || c <= 0) {
            LOGGER.error(`Invalid --candles: ${opts.candles} (must be a positive integer)`);
            process.exit(2);
        }
        opts.candles = Math.floor(c);
    }

    const symbols = (!opts.asset || opts.asset.toLowerCase() === 'all') ? CONFIG.ACTIVE_ASSETS : [opts.asset];
    const payoutRatio = Number.isFinite(opts.payout) ? opts.payout : 0.90;
    LOGGER.info(`🧪 BACKTEST standalone: ${symbols.join(', ')} | ${opts.days ? opts.days + 'd' : opts.candles ? opts.candles + ' candles' : '30d'} | payout ${(payoutRatio * 100).toFixed(0)}%`);
    const fetcher = new DerivCandleFetcher(CONFIG.APP_ID, LOGGER);
    const engine = new BacktestEngine();
    const reports = [];
    for (const sym of symbols) {
        if (!CONFIG.ACTIVE_ASSETS.includes(sym) && !Object.keys(ASSET_CONFIGS).includes(sym) && sym !== 'all') {
            LOGGER.error(`Unknown asset ${sym}. Active: ${CONFIG.ACTIVE_ASSETS.join(', ')} | per-asset overrides: ${Object.keys(ASSET_CONFIGS).join(', ') || 'none'}`);
            continue;
        }
        LOGGER.info(`Fetching candles for ${sym}...`);
        let fetchResult;
        try { fetchResult = await fetcher.fetchCandles(sym, opts); }
        catch (e) { LOGGER.error(`Fetch failed for ${sym}: ${e.message}`); continue; }
        // Backwards-compat: fetcher now returns { candles, requested, fetched, dupesRemoved }
        const candleList = Array.isArray(fetchResult) ? fetchResult : fetchResult.candles;
        const candleStats = Array.isArray(fetchResult) ? null : fetchResult;
        LOGGER.info(`Fetched ${candleList.length} candles for ${sym} (${candleList[0] ? new Date(candleList[0].open_time * 1000).toISOString() : '-'} → ${candleList[candleList.length - 1] ? new Date(candleList[candleList.length - 1].open_time * 1000).toISOString() : '-'})`);
        const report = await engine.run(sym, candleList, { payoutRatio });
        // Stamp fetch stats onto report so the JSON carries provenance
        if (candleStats) report.candleStats = candleStats;
        reports.push(report);
        console.log('\n' + engine.formatReport(report) + '\n');
        const fname = `bizArbitrage2-backtest-${sym}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`;
        try { fs.writeFileSync(path.join(__dirname, fname), JSON.stringify(report, null, 2)); LOGGER.info(`Report saved: ${fname}`); }
        catch (e) { LOGGER.error(`Save report failed: ${e.message}`); }
    }
    if (reports.length > 1) {
        console.log('\n══════════════════════════════════════════');
        console.log('SUMMARY (all assets)');
        reports.forEach(r => console.log(`${r.symbol}: ${r.trades} trades WR ${r.winRate}% Net $${r.netPL.toFixed(2)} Verdict ${r.verdict}`));
        console.log('══════════════════════════════════════════\n');
    }
}
function startTelegramBacktestPolling(){
    if(!CONFIG.TELEGRAM_ENABLED || !CONFIG.TELEGRAM_BOT_TOKEN || CONFIG.TELEGRAM_BOT_TOKEN.includes('8565754902')===false) return;
    try {
        const TelegramBot = require('node-telegram-bot-api');
        const tbot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, {polling:true});
        LOGGER.info('Telegram backtest polling started (/backtest)');
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
                    const fetchResult=await fetcher.fetchCandles(sym, {days:days||30, from, to, payoutRatio:payoutArg});
                    const candleList = Array.isArray(fetchResult) ? fetchResult : fetchResult.candles;
                    const report=await engine.run(sym,candleList,{payoutRatio: payoutArg||0.90});
                    if (!Array.isArray(fetchResult)) report.candleStats = fetchResult;
                    await tbot.sendMessage(chatId, engine.formatReport(report), {parse_mode:'HTML'});
                }
            } catch(e){
                await tbot.sendMessage(chatId, `Backtest failed: ${e.message}`);
            }
        });
        tbot.on('polling_error', e=> LOGGER.error(`TG poll: ${e.message}`));
    } catch(e){ LOGGER.error(`Telegram backtest poll init failed: ${e.message}`); }
}

// ============================================================
// INITIALIZATION
// ============================================================
const FLAG_SELFTEST = process.argv.slice(2).includes('--selftest');
if (FLAG_SELFTEST) {
    // Selftest must run BEFORE we spin up tradeHistory / IndexBot (which start timers
    // and load state). Run and exit before any of that happens.
    runSelftest().catch(e => { LOGGER.error(`Selftest crashed: ${e.message}\n${e.stack}`); process.exit(2); });
    return; // unreachable inside Node top-level — but the early-return is enforced by runSelftest calling process.exit()
}

tradeHistory = TradeHistoryManager.loadHistory();
const bot = new IndexBot();

process.on('SIGINT', () => { bot.stop(); bot.connection.shutdown(); setTimeout(() => process.exit(0), 3000); });
process.on('SIGTERM', () => { bot.stop(); bot.connection.shutdown(); setTimeout(() => process.exit(0), 3000); });
process.on('uncaughtException', (err) => { LOGGER.error(`UNCAUGHT: ${err.message}\n${err.stack}`); try { StatePersistence.saveState(); } catch { } });
process.on('unhandledRejection', (reason) => { LOGGER.error(`UNHANDLED: ${reason}`); try { StatePersistence.saveState(); } catch { } });

// ── --selftest: deterministic offline engine sanity check ──
// Runs three synthetic streams (noise, alternating, all-BULL) through BacktestEngine
// without touching the network. Proves the engine plumbing is wired correctly.
function makeLcgRng(seed) {
    let s = seed >>> 0;
    return () => {
        // Numerical Recipes LCG — deterministic, no Date.now/Math.random
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}
function synthesizeCandles({ n, granularity = 60, mode, seed = 42, startEpoch = 1700000000, startPrice = 1000 }) {
    const rng = makeLcgRng(seed);
    const out = [];
    let price = startPrice;
    let epoch = startEpoch;
    let bullRun = 0;
    for (let i = 0; i < n; i++) {
        let open = price;
        let close;
        if (mode === 'all_bull') {
            // Strictly rising — every candle closes above open
            close = open * (1 + 0.001 + rng() * 0.001);
        } else if (mode === 'alternating') {
            // BBBRRR BBBRRR ... — N=6 will see 3B then 3R transitions
            const cycle = Math.floor(i / 3) % 2;
            close = cycle === 0 ? open * (1 + 0.001) : open * (1 - 0.001);
        } else {
            // 'noise': pure random walk around starting price
            close = open * (1 + (rng() - 0.5) * 0.01);
        }
        const high = Math.max(open, close) * (1 + rng() * 0.0005);
        const low = Math.min(open, close) * (1 - rng() * 0.0005);
        out.push({
            open: parseFloat(open.toFixed(5)),
            close: parseFloat(close.toFixed(5)),
            high: parseFloat(high.toFixed(5)),
            low: parseFloat(low.toFixed(5)),
            epoch,
            open_time: Math.floor((epoch - granularity) / granularity) * granularity,
        });
        price = close;
        epoch += granularity;
    }
    return out;
}
async function runSelftest() {
    LOGGER.info('🧪 SELFTEST — offline engine sanity check (no network)');
    const N = 60 * 24 * 30; // 30 days of 1m candles
    const streams = [
        { name: 'noise', mode: 'noise', expect: 'WR ~50%' },
        { name: 'alternating', mode: 'alternating', expect: 'WR any' },
        { name: 'all_bull', mode: 'all_bull', expect: 'WR ~0% (strategy fades streak)' },
    ];
    const engine = new BacktestEngine();
    const payout = 0.90;
    let failed = false;
    for (const s of streams) {
        const candles = synthesizeCandles({ n: N, mode: s.mode, seed: 42 });
        const report = await engine.run('R_100', candles, { payoutRatio: payout });
        console.log('\n' + engine.formatReport(report));
        console.log(`   expected: ${s.expect}`);
        if (s.mode === 'noise') {
            // ±5pp tolerance on 50% to avoid flake
            const wr = report.winRate;
            if (wr < 45 || wr > 55) {
                LOGGER.error(`SELFTEST FAIL: noise stream WR ${wr}% outside [45,55]`);
                failed = true;
            }
        }
        if (s.mode === 'all_bull') {
            // Strategy deliberately enters PUTE after 6 bullish → must have low WR
            if (report.winRate > 10) {
                LOGGER.error(`SELFTEST FAIL: all_bull stream WR ${report.winRate}% > 10 (strategy not fading)`);
                failed = true;
            }
        }
    }
    if (failed) {
        LOGGER.error('SELFTEST FAILED');
        process.exit(1);
    }
    LOGGER.info('✅ SELFTEST PASSED — engine plumbing verified on synthetic streams');
    process.exit(0);
}

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

    console.log('\n\u{1f680} Starting CANDLE DIRECTION BOT v1.0...\n');
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
                const normal = p.normalMode ? `Nrm:${p.normalTrades}/${CONFIG.MAX_TRADES_PER_CYCLE}` : '';
                const cdwn = p.cooldownCandles > 0 ? `❄️CD:${p.cooldownCandles}` : '';

                pairLines += `\n  ${sym}: ${p.buyFlag ? '\u{1f7e2}BF' : ''} ${p.sellFlag ? '\u{1f534}SF' : ''} Rec${p.recoveryStep} $${(p.currentStake || 0).toFixed(2)} | ${p.trades}t ${p.wins}W/${p.losses}L $${(p.netPL || 0).toFixed(2)} | Pos:${p.activePositions} ${normal}${cdwn}`;
            }
        });

        console.log(`\n\u{1f4ca} ${getGMTTime()} | Session: ${status.session.trades}t ${status.session.winRate} $${(status.session.netPL || 0).toFixed(2)} | Capital: $${status.capital.toFixed(2)}`);
        console.log(`\u{1f4cb} Overall: ${status.overall.tradesCount}t | P/L: $${(status.overall.netPL || 0).toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
        console.log(`\u{1f555} ${TradingSessionManager.getStatusString()}`);
        console.log(`\u{1f4c8} Assets:${pairLines}`);

    }, 60000);

    bot.statusDisplayIntervalId = statusInterval;
}
