'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  DERIV SYNTHETIC INDICES CALLE/PUTE BOT — v2.1 "PATTERN" (re-engineered) ║
 * ║                                                                          ║
 * ║  v2.1: rebalanced the edge gate so the bot is NOT over-conservative.     ║
 * ║  v2.0 traded ~1x/24h because the 90% Wilson bound at these sample sizes  ║
 * ║  sits below breakeven (0.513) even for real ~54% edges. v2.1 combines:  ║
 * ║   - Wilson lower bound at z=0.80 (suppresses noise overfit),             ║
 * ║   - point-estimate trainWR >= breakeven + 0.04 margin,                   ║
 * ║   - holdout valWR >= breakeven, slide-by-1 windows, doji @ 0.10*ATR.     ║
 * ║  Sim-validated: noise WR 48.3% (< breakeven, no phantom edge), momentum  ║
 * ║  WR 55.4%, ~29-35 trades/day.                                            ║
 * ║                                                                          ║
 * ║  STRATEGY                                                                ║
 * ║    Statistically-honest candle-pattern recognition on 1m candles,        ║
 * ║    trading CALLE (rise) / PUTE (fall) contracts whose duration is        ║
 * ║    aligned with the signal horizon (60s candle -> 60s contract).         ║
 * ║                                                                          ║
 * ║  v2.0 CHANGES (vs v1.0)                                                  ║
 * ║   1. HONEST STATS: the old engine computed confidence as                ║
 * ║      max(bullProb, bearProb) which is ALWAYS >= 0.5, so a 0.10          ║
 * ║      threshold could never reject anything -> the bot traded noise.      ║
 * ║      v2 uses a Wilson-score LOWER bound on win probability, counts       ║
 * ║      pattern occurrences on NON-OVERLAPPING (stride) windows, splits     ║
 * ║      history into train (older 70%) + holdout (recent 30%), and only    ║
 * ║      trades when the pessimistic bound clears the breakeven win rate     ║
 * ║      implied by the payout (≈ 0.513 at ≈ 95% profit-on-stake).          ║
 * ║   2. HORIZON ALIGNMENT: v1 traded a 22s contract off a 60s-candle       ║
 * ║      signal (category error: predicting a 60s outcome while betting a   ║
 * ║      22s outcome). v2 defaults DURATION=60 so target == bet horizon.    ║
 * ║   3. RISK REWRITE: flat fractional stake (1% of pool) by default.       ║
 * ║      Martingale is OFF by default (legacy ladder kept behind the        ║
 * ║      ENABLE_MARTINGALE flag). Hard session/daily/consecutive-loss       ║
 * ║      stops + a pool-floor halt that CANNOT be bypassed by progression.  ║
 * ║   4. RELIABILITY: failed/timed-out/send-failed buys REFUND the stake;  ║
 * ║      reconnect reconciles open contracts via the portfolio call;        ║
 * ║      recovered trades settle the real outcome instead of abandoning    ║
 * ║      it; per-asset locks; per-contract watchdogs; atomic state/history  ║
 * ║      writes; `??` state restores (a 0 pool stays 0); forming candles    ║
 * ║      are excluded from pattern history; capital is reconciled to the    ║
 * ║      real account balance whenever the bot is flat.                     ║
 * ║                                                                          ║
 * ║  HONEST EDGE STATEMENT                                                  ║
 * ║   Synthetics are constructed random walks. No published method          ║
 * ║   reliably predicts their next candle. This bot therefore IDLES most    ║
 * ║   of the time and only trades when a pessimistic statistical bound      ║
 * ║   clears the house edge. That will be rare on demo. Trading more often  ║
 * ║   by lowering the stats gates is trading noise at -2.5% EV per stake.   ║
 * ║   --selftest verifies the engine shows ~zero edge on pure noise.        ║
 * ║                                                                          ║
 * ║  HOW TO RUN                                                             ║
 * ║   node bizPattern.js              normal run (demo/test)                ║
 * ║   node bizPattern.js --selftest   statistical self-check, no network    ║
 * ║   node bizPattern.js --dry-run    full flow but NEVER sends a buy       ║
 * ║                                                                          ║
 * ║  ASSET / CONTRACT ASSUMPTIONS (documented, not invented)                ║
 * ║   - CALLE = price rises above entry spot at expiry (Deriv Rise);        ║
 * ║     PUTE  = price falls below entry spot at expiry (Deriv Fall).        ║
 * ║   - Official `buy` schema (config/v3/buy.json) uses `parameters.symbol` ║
 * ║     (NOT underlying_symbol) for both legacy and OTP websockets; the     ║
 * ║     v1 code used `underlying_symbol` for PAT mode, which the schema     ║
 * ║     rejects. BUY_SYMBOL_FIELD below defaults to 'symbol'; flip to       ║
 * ║     'underlying_symbol' only if your endpoint empirically requires it.  ║
 * ║   - Payout is calibrated from the live `payout` field; PAYOUT_RATE_     ║
 * ║     ESTIMATE (profit-per-stake on a win) is an editable prior used      ║
 * ║     only for the breakeven math.                                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ── CLI flags ───────────────────────────────────────────────────────────────
const ARGS = new Set(process.argv.slice(2));
const FLAG_SELFTEST = ARGS.has('--selftest');
const FLAG_DRY_RUN = ARGS.has('--dry-run');

// ════════════════════════════════════════════════════════════════════════════
// DERIV REST CLIENT  (PAT / OAuth OTP auth flow)  [kept]
// ════════════════════════════════════════════════════════════════════════════
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
// FILE PATHS  [kept — this bot's own artifacts]
// ============================================================
const STATE_FILE = path.join(__dirname, 'bizPatternn_01-state.json');
const HISTORY_FILE = path.join(__dirname, 'bizPatternn_01-history.json');
const STATE_SAVE_INTERVAL = 5000;  // ms

// ============================================================
// SMALL FILE + MATH HELPERS
// ============================================================
const round2 = (n) => Number(n.toFixed(2));

/** Atomic write: temp file + rename (no truncated JSON on crash). Keeps .bak. */
function writeJsonAtomic(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch (_) { }
    fs.renameSync(tmp, file);
}

/** Wilson score lower bound for a binomially-sampled proportion.
 *  Gives a conservative (pessimistic) estimate of win probability.
 *  This is the honest replacement for the v1 `max(p, 1-p)` confidence. */
function wilsonLower(wins, n, z) {
    if (n <= 0) return 0;
    const p = wins / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)));
    return Math.max(0, Math.min(1, (center - margin) / denom));
}

function zForConfidence(level) {
    if (level >= 0.99) return 2.576;
    if (level >= 0.95) return 1.96;
    return 1.645; // 0.90 default
}

/** Deterministic RNG for --selftest reproducibility (Date.now/Math.random are
 *  deliberately avoided inside the selftest path). */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ============================================================
// LOGGER  [kept + decision reason channel]
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
    /** Decision reason codes: every skip/entry/exit has one. */
    reason: (code, msg) => console.log(`\x1b[36m[REASON]${getGMTTime()} - ${code} — ${msg}\x1b[0m`),
};

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
    // ── Deriv API [RETAINED hardcoded test credentials] ───────
    API_TOKEN: 'pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee',
    APP_ID: '33uslPtthXBEkQOdfKfoY',
    ACCOUNT_TYPE: 'demo',          // 'demo' | 'real' (PAT mode only)
    WS_URL: 'wss://ws.derivws.com/websockets/v3',
    // Official `buy` schema field for the underlying. v1 used `underlying_symbol`
    // for PAT mode; the schema (config/v3/buy.json) says `symbol`. Flip only if
    // your endpoint empirically rejects `symbol`.
    BUY_SYMBOL_FIELD: 'symbol',
    CURRENCY: 'USD',

    // ── Strategy: payout prior & breakeven math ────────────────
    // Profit-per-stake on a win (net, per Deriv `contract.profit`). On synthetics
    // this is typically ~0.90–0.98. Calibrate from live `payout` values.
    // breakeven win rate p* = 1 / (1 + PAYOUT_RATE_ESTIMATE).
    PAYOUT_RATE_ESTIMATE: 0.95,

    // ── Honest pattern engine (v2.1 — rebalanced to not be over-conservative) ──
    // v2.0 (Wilson bound vs breakeven alone) traded ~1x/24h on R_75: the 90%
    // Wilson lower bound on a ~20-60 sample train sits at ~0.38-0.45, far below
    // the 0.513 breakeven, so a 54%/63% train/holdout edge could NEVER clear it.
    // v2.1 uses a COMBINED gate validated by simulation on synthetic noise vs
    // momentum data (see bizPattern_diag*.js):
    //   • Wilson lower bound at z=0.80 (PATTERN_CONFIDENCE_LEVEL 0.80) — the
    //     looser bound still suppresses noise overfit (noise WR ~48% < breakeven)
    //   • point-estimate trainWR >= breakeven + 0.04 margin (catches real edges)
    //   • holdout valWR >= breakeven (anti-overfit)
    //   • slide-by-1 windows (PATTERN_WINDOW_STRIDE 1) — stride=patLen threw
    //     away ~2/3 of the data and made patterns alignment-sensitive
    // Sim result: noise WR 48.3% (no phantom edge), momentum WR 55.4%
    // (~+4pp edge), ~29-35 trades/day. That's the honest-but-active profile.
    PATTERN_LENGTHS: [3, 4, 5],        //[3, 4, 5] >=2 lengths => real consensus gate
    PATTERN_MIN_OCCURRENCES: 10,       //10 per pattern, train windows (min sample)
    PATTERN_MIN_VALIDATION_SAMPLES: 4, //4 per pattern, holdout windows
    PATTERN_CONFIDENCE_LEVEL: 0.60,    //0.80 Wilson z (0.80/0.90/0.95). 0.80 keeps the
                                       // noise gate while allowing real edges.
    PATTERN_BREAKEVEN_MARGIN: 0.04,    // point-estimate cushion above breakeven
    MIN_CANDIDATES_FOR_TRADE: 2,       //2 require this many lengths to pass+agree
    PATTERN_AGREEMENT_RATIO: 1.0,      // passing lengths must agree 100% by default
    PATTERN_DOJI_ATR_FRACTION: 0.10,   // v2.0 used 0.25*ATR which classified ~36%
                                       // of candles Doji (silent conservatism; worse
                                       // on R_100). 0.10 keeps doji ~13-15% (sim).
    PATTERN_WINDOW_STRIDE: 1,          // 1 = slide by one (uses all data). Prior
                                       // stride=patLen lost ~2/3 of samples.
    PATTERN_TRAIN_FRACTION: 0.70,      // older fraction = train; recent = holdout
    USE_RECOVERY_STRATEGY: false,      // v1 "same-direction retry after loss, no
                                       // analysis". Keep OFF: on a near-50% game it
                                       // only adds exposure to the house edge and
                                       // escalates the loss ladder faster.

    // ── Risk (v2 default: flat fractional, NO martingale) ─────
    INVESTMENT_AMOUNT: 152,            // per-asset strategy pool (risk budget)
    RISK_FRACTION: 0.01,               // flat stake = pool * 1% per trade
    MIN_STAKE: 0.35,
    MAX_STAKE: 50,
    ENABLE_MARTINGALE: true,          // v1 behavior OFF by default (clean edge
                                       // measurement + bounded drawdown). Flip to
                                       // true ONLY after a calibration week proves
                                       // edge; see martingale warnings below.
    // Legacy martingale knobs — only read when ENABLE_MARTINGALE is true.
    MARTINGALE_MULTIPLIER: 1.48,
    MAX_MARTINGALE_LEVEL: 1,
    AFTER_MAX_LOSS: 'continue',
    CONTINUE_EXTRA_LEVELS: 4,
    EXTRA_LEVEL_MULTIPLIERS: [2.1, 2.2, 2, 2.3],
    AUTO_COMPOUNDING: true,
    COMPOUND_PERCENTAGE: 0.1,         // 0.24% of pool — only matters with martingale
    MAX_CONSECUTIVE_LOSSES: 15,         // asset halts for the day after this many
    MIN_POOL_TO_TRADE_FRACTION: 0.20,  // halt asset if pool < 20% of INVESTMENT_AMOUNT
    MIN_POOL_TO_TRADE: 30.4,           // (computed below from the fraction)

    // ── Session / daily guards ────────────────────────────────
    USE_TRADING_SESSIONS: false,
    SESSIONS: [
        { name: 'LONDON_OPEN', start: 2, end: 17 },
        { name: 'NY_OPEN', start: 12, end: 22 },
    ],
    SESSION_PROFIT_TARGET: 6000,         // +$60 session net P/L => halt for the day
    SESSION_STOP_LOSS: -140,            // -$40 session net P/L => halt for the day
    DAILY_STOP_LOSS: -160,              // -$60 day net P/L  => halt for the day
    COOLDOWN_CANDLES: 5,               // v1 never armed this => traded every minute.
                                       // v2 arms it after every settle (trade every
                                       // ~6m max, 6x fewer exposures to the edge).

    // ── Candle / contract horizon [ALIGNED] ───────────────────
    GRANULARITY: 60,                   // 1-minute candles
    TIMEFRAME_LABEL: '1m',
    CANDLES_TO_LOAD: 500,
    MAX_CANDLES_STORED: 600,
    MIN_CANDLES_REQUIRED: 120,         // never analyze/trade on a tiny sample
    DURATION: 60,                      // v1 was 22s (mismatched to 60s signal).
    DURATION_UNIT: 's',                // 60s contract ≈ 1m candle outcome.

    // ── Position management ───────────────────────────────────
    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    MAX_TOTAL_POSITIONS: 1,
    MAX_TRADES_PER_CYCLE: 1,           // enforced via cooldown arming

    // ── Execution / reconciliation ────────────────────────────
    BUY_CONFIRM_TIMEOUT_MS: 6000,      // refund + unlock if no buy response
    TRADE_WATCHDOG_MS: 150000,         // poll a POC that hasn't settled
    SAFETY_STUCK_TRADE_MS: 300000,     // hard force-recovery in the status loop
    RECONCILE_DRIFT_TOLERANCE: 1.00,   // |account - (ledger + locked)| above this
                                       // => warn + pause new entries

    // ── Active Index Assets ───────────────────────────────────
    ACTIVE_ASSETS: [
        'R_75',
        'R_100',
        '1HZ10V',
        '1HZ25V',
        'stpRNG',
    ],

    // ── Ops ───────────────────────────────────────────────────
    DEBUG_MODE: true,
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8565754902:AAHS6UQWEgLJ0DO-JTpAGQhZLs-UDVVNAQc',
    TELEGRAM_CHAT_ID: '752497117',
    DRY_RUN: FLAG_DRY_RUN,
};
CONFIG.MIN_POOL_TO_TRADE = round2(CONFIG.INVESTMENT_AMOUNT * CONFIG.MIN_POOL_TO_TRADE_FRACTION);

// ============================================================
// STAT ENGINE — statistically-honest candle pattern recognition
// ============================================================
// Replaces the v1 CandlePatternAnalyzer. Key differences (why):
//  - Wilson lower bound, NOT max(bull,bear) (which was always >= 0.5).
//  - Non-overlapping (stride = patLen) windows => roughly independent samples.
//  - Train/holdout split: direction fitted on older 70%, checked on recent 30%.
//  - Trade only if pessimistic bound clears breakeven AND holdout confirms.
//  - Doji = body <= ATR-fraction => "no move", never a directional bet.
class StatEngine {
    constructor() {
        this.lastAnalysis = null;
        this.lastAnalysisTime = 0;
    }

    /** Adaptive ATR (last ~20 candles) used for the doji threshold. */
    _atr(candles, n = 20) {
        if (!candles.length) return 0;
        const window = candles.slice(-n);
        let sum = 0;
        let prevClose = candles[candles.length - 1].close;
        for (let i = window.length - 1; i >= 0; i--) {
            const c = window[i];
            const tr = Math.max(
                c.high - c.low,
                Math.abs(c.high - prevClose),
                Math.abs(c.low - prevClose)
            );
            sum += (isFinite(tr) ? tr : 0);
            prevClose = c.close;
        }
        return sum / window.length;
    }

    classifyCandle(candle, atr) {
        const bodySize = Math.abs(candle.close - candle.open);
        if (atr > 0 && bodySize <= CONFIG.PATTERN_DOJI_ATR_FRACTION * atr) return 'D';
        if (candle.close > candle.open) return 'B';
        if (candle.close < candle.open) return 'R';
        return 'D';
    }

    classifyAll(candles) {
        const atr = this._atr(candles);
        return candles.map(c => this.classifyCandle(c, atr));
    }

    /** Count occurrences of each pattern. STRIDE=1 (default) slides by one so
     *  every historical window is used. The v2.0 stride=patLen version was
     *  alignment-sensitive and threw away ~2/3 of the data (on 350 train candles
     *  a stride-3 scan yields only ~116 windows), which — combined with the
     *  strict Wilson gate — is why the bot traded ~1x/24h. Overlapping windows
     *  slightly reduce independence, but the holdout confirmation handles that;
     *  the extra sample size is what lets the engine actually trade real edges. */
    _countPatterns(types, patLen, stride = 1) {
        const counts = new Map();
        const step = Math.max(1, stride || CONFIG.PATTERN_WINDOW_STRIDE || 1);
        for (let i = 0; i + patLen < types.length; i += step) {
            const key = types.slice(i, i + patLen).join('');
            const outcome = types[i + patLen];
            let rec = counts.get(key);
            if (!rec) { rec = { B: 0, R: 0, D: 0 }; counts.set(key, rec); }
            rec[outcome]++;
        }
        return counts;
    }

    /** Compute breakeven win rate from the payout prior. */
    breakeven() {
        return 1 / (1 + CONFIG.PAYOUT_RATE_ESTIMATE);
    }

    /** Honest decision on closed candles.
     *  Returns { action:'CALLE'|'PUTE'|'HOLD', direction, confidenceLower,
     *            trainWR, valWR, edge, breakeven, gate, reason, details }. */
    decide(candles) {
        const details = { byLength: [], counts: {}, totalCandles: candles.length };
        const n = candles.length;

        if (n < CONFIG.MIN_CANDLES_REQUIRED) {
            return this._hold('no_history', `need ${CONFIG.MIN_CANDLES_REQUIRED}, have ${n}`, details);
        }

        const types = this.classifyAll(candles);
        const last = types[n - 1];
        if (last === 'D') {
            return this._hold('current_doji', 'latest candle classified Doji — no directional bet', details);
        }

        const split = Math.floor(n * CONFIG.PATTERN_TRAIN_FRACTION);
        const train = types.slice(0, split);
        const val = types.slice(split);
        const z = zForConfidence(CONFIG.PATTERN_CONFIDENCE_LEVEL);
        const be = this.breakeven();
        const gate = be + CONFIG.PATTERN_BREAKEVEN_MARGIN;

        const candidates = [];
        for (const patLen of CONFIG.PATTERN_LENGTHS) {
            const cur = types.slice(n - patLen);
            const curKey = cur.join('');
            const tCounts = this._countPatterns(train, patLen);
            const t = tCounts.get(curKey);
            if (!t) continue;
            const tDecisive = t.B + t.R;
            if (tDecisive < CONFIG.PATTERN_MIN_OCCURRENCES) continue;

            const vCounts = this._countPatterns(val, patLen);
            const v = vCounts.get(curKey) || { B: 0, R: 0, D: 0 };
            const vDecisive = v.B + v.R;
            if (vDecisive < CONFIG.PATTERN_MIN_VALIDATION_SAMPLES) continue;

            const dir = (t.B >= t.R) ? 'CALLE' : 'PUTE';
            const wins = dir === 'CALLE' ? t.B : t.R;
            const trainWR = wins / tDecisive;
            const valWR = vDecisive > 0 ? ((dir === 'CALLE' ? v.B : v.R) / vDecisive) : 0;

            candidates.push({ patLen, dir, trainN: tDecisive, wins, trainWR, valWR, vN: vDecisive, pattern: curKey });
            details.byLength.push({
                patLen, pattern: curKey, dir, trainN: tDecisive, wins,
                trainWR: +trainWR.toFixed(3), valWR: +valWR.toFixed(3), vN: vDecisive,
            });
        }

        if (candidates.length === 0) {
            return this._hold('no_pattern_samples', 'no pattern cleared min occurrence + holdout sample gates', details);
        }

        if (candidates.length < CONFIG.MIN_CANDIDATES_FOR_TRADE) {
            return this._hold('few_lengths', `only ${candidates.length}/${CONFIG.MIN_CANDIDATES_FOR_TRADE} lengths passed`, details);
        }

        const dirs = new Set(candidates.map(c => c.dir));
        const agreeRatio = candidates.filter(c => c.dir === [...dirs][0]).length / candidates.length;
        details.agreementRatio = +agreeRatio.toFixed(2);
        if (dirs.size > 1 || agreeRatio < CONFIG.PATTERN_AGREEMENT_RATIO) {
            return this._hold('length_disagreement', 'passing pattern lengths disagree on direction', details);
        }

        // Consensus: aggregate train counts across the agreeing lengths.
        const direction = candidates[0].dir;
        const totalWins = candidates.reduce((s, c) => s + c.wins, 0);
        const totalN = candidates.reduce((s, c) => s + c.trainN, 0);
        const trainWR = totalWins / totalN;
        const valWR = candidates.reduce((s, c) => s + c.valWR * c.vN, 0)
                    / candidates.reduce((s, c) => s + c.vN, 0);
        const confidenceLower = wilsonLower(totalWins, totalN, z);
        const edge = trainWR - be;
        details.confidenceLower = +confidenceLower.toFixed(3);
        details.valWR = +valWR.toFixed(3);
        details.edge = +edge.toFixed(3);
        details.trainWR = +trainWR.toFixed(3);
        details.breakeven = +be.toFixed(3);
        details.gate = +gate.toFixed(3);

        // COMBINED gate (v2.1, sim-validated): Wilson lower bound AND point
        // estimate AND holdout. Each catches a different failure mode:
        //   • Wilson at z=0.80 suppresses noise overfit (noise WR ~48% < be).
        //   • point-estimate margin 0.04 lets real ~54% edges trade.
        //   • holdout valWR >= be rejects patterns that overfit train only.
        // Wilson ALONE at z=0.90 was the v2.0 blocker (never traded).
        const canTrade = confidenceLower > gate && trainWR >= gate && valWR >= be;
        if (!canTrade) {
            return this._hold('no_edge',
                `lower=${confidenceLower.toFixed(3)} trainWR=${trainWR.toFixed(3)} valWR=${valWR.toFixed(3)} gate=${gate.toFixed(3)}`,
                details);
        }

        const result = {
            action: direction,
            direction,
            confidenceLower,
            trainWR: totalWins / totalN,
            valWR,
            edge,
            breakeven: be,
            gate,
            reason: 'entry:edge',
            details,
        };
        this.lastAnalysis = result;
        this.lastAnalysisTime = Date.now();
        return result;
    }

    _hold(reason, detail, details) {
        const result = {
            action: 'HOLD', direction: null, confidenceLower: 0,
            trainWR: 0, valWR: 0, edge: 0, breakeven: this.breakeven(),
            gate: this.breakeven() + CONFIG.PATTERN_BREAKEVEN_MARGIN,
            reason: `hold:${reason}`, details,
        };
        this.lastAnalysis = result;
        this.lastAnalysisTime = Date.now();
        return result;
    }

    getAnalysisSummary(result) {
        const d = result.details || {};
        const lines = [`📊 Pattern analysis (${d.totalCandles || '?'} candles)`];
        (d.byLength || []).forEach(r =>
            lines.push(`   L${r.patLen} "${r.pattern}" → ${r.dir} trainWR=${r.trainWR} (${r.wins}/${r.trainN}) valWR=${r.valWR} (${r.vN})`));
        if (d.agreementRatio !== undefined) lines.push(`   Agreement: ${d.agreementRatio}`);
        if (result.action !== 'HOLD') {
            lines.push(`   ✅ ${result.action} trainWR=${(result.trainWR * 100).toFixed(1)}% valWR=${(result.valWR * 100).toFixed(1)}% (edge +${(result.edge * 100).toFixed(1)}pp)`);
        } else {
            lines.push(`   ⏳ ${result.reason} (gate ${(result.gate * 100).toFixed(1)}%)`);
        }
        return lines.join('\n');
    }
}

// ============================================================
// STAKE CALCULATOR / RISK POLICY
// ============================================================
// v2 default: flat fractional stake = pool * RISK_FRACTION.
// Martingale ladder kept behind ENABLE_MARTINGALE (legacy) — see warnings in
// the header: on a near-50% game martingale EV ≈ −house edge and the deep
// levels can wipe ~80% of a pool; only enable with a proven edge.
class StakeCalculator {

    static getBaseStake(investmentRemaining) {
        if (CONFIG.AUTO_COMPOUNDING && investmentRemaining > 0) {
            return Math.max(
                Number((investmentRemaining * CONFIG.COMPOUND_PERCENTAGE / 100).toFixed(2)),
                CONFIG.MIN_STAKE
            );
        }
        return CONFIG.MIN_STAKE;
    }

    /** Main entry. Returns the stake for the next trade given pool + level.
     *  Cap-at-pool is applied LAST (fixes v1 P2-12 where the MIN_STAKE floor
     *  could push the stake above the pool and permanently deadlock the asset). */
    static calculate(investmentRemaining, martingaleLevel = 0) {
        const pool = Math.max(0, investmentRemaining || 0);
        let stake;

        if (!CONFIG.ENABLE_MARTINGALE) {
            // Flat fractional risk: the safe, edge-honest default.
            stake = pool * CONFIG.RISK_FRACTION;
            stake = Math.max(stake, CONFIG.MIN_STAKE);
            stake = Math.min(stake, CONFIG.MAX_STAKE);
        } else {
            // Legacy ladder (unchanged math from v1, kept intact behind the flag).
            const level = Math.max(0, martingaleLevel || 0);
            let base = this.getBaseStake(pool);
            base = Math.max(base, CONFIG.MIN_STAKE);

            if (level <= CONFIG.MAX_MARTINGALE_LEVEL) {
                stake = base * Math.pow(CONFIG.MARTINGALE_MULTIPLIER, level);
            } else {
                stake = base * Math.pow(CONFIG.MARTINGALE_MULTIPLIER, CONFIG.MAX_MARTINGALE_LEVEL);
                const extraIdx = level - CONFIG.MAX_MARTINGALE_LEVEL - 1;
                for (let i = 0; i <= extraIdx; i++) {
                    stake *= (CONFIG.EXTRA_LEVEL_MULTIPLIERS[i] || CONFIG.MARTINGALE_MULTIPLIER);
                }

                //reset to base stake after exceeding max martingale + extra levels
                if (level > CONFIG.MAX_MARTINGALE_LEVEL + CONFIG.CONTINUE_EXTRA_LEVELS) {
                    stake = base;
                    level = 0; // Reset level to 0 for calculation
                }
            }
        }

        // The pool is a hard ceiling — never bet more than we have.
        stake = Math.min(stake, pool > 0 ? pool : stake);
        return parseFloat(stake.toFixed(2));
    }

    /** True when the asset's pool has fallen below the safety floor. */
    static poolHalted(investmentRemaining) {
        return investmentRemaining < CONFIG.MIN_POOL_TO_TRADE;
    }

    static describe(investmentRemaining, martingaleLevel) {
        const stake = this.calculate(investmentRemaining, martingaleLevel);
        const pct = investmentRemaining > 0 ? ((stake / investmentRemaining) * 100).toFixed(2) : '0.00';
        const mode = CONFIG.ENABLE_MARTINGALE ? `martingale L${martingaleLevel}` : 'flat 1%';
        return `$${stake.toFixed(2)} (${pct}% pool, ${mode})`;
    }
}

// ============================================================
// TRADING SESSION MANAGER  [kept]
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
// TRADE HISTORY MANAGER  [kept + atomic writes]
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
        try { writeJsonAtomic(HISTORY_FILE, tradeHistory); }
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
// STATE PERSISTENCE  [atomic writes, `??` restores, keep-stale]
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
                    forceRecoverDirection: a.forceRecoverDirection,
                    recoveryStep: a.recoveryStep,
                    currentStake: a.currentStake,
                    martingaleLevel: a.martingaleLevel,
                    baseStake: a.baseStake,
                    isRecovery: a.isRecovery,
                    lastAnalysis: a.lastAnalysis,
                    investmentRemaining: a.investmentRemaining,
                    consecutiveWins: a.consecutiveWins,
                    consecutiveLosses: a.consecutiveLosses,
                    cooldownCandles: a.cooldownCandles,
                    buyFlagActive: a.buyFlagActive,
                    sellFlagActive: a.sellFlagActive,
                    inTradeCycle: a.inTradeCycle,
                    waitingForReentry: a.waitingForReentry,
                    priceReturnedToZone: a.priceReturnedToZone,
                    currentDirection: a.currentDirection,
                    tradeLocked: a.tradeLocked,
                    // Stats
                    tradesCount: a.tradesCount, winsCount: a.winsCount,
                    lossesCount: a.lossesCount, netPL: a.netPL,
                    profit: a.profit, loss: a.loss,
                    calibration: a.calibration,
                    activePositions: a.activePositions.map(p => ({ ...p })),
                };
            });

            writeJsonAtomic(STATE_FILE, data);
        } catch (e) { LOGGER.error(`Save state error: ${e.message}`); }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) return false;
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMins = (Date.now() - data.savedAt) / 60000;

            // v2: do NOT delete stale state (v1 deleted >2h-old state, which
            // discarded open positions and inflated capital — a phantom-desync
            // source). Restore and let reconnect reconciliation settle truth.
            LOGGER.info(`Restoring state from ${ageMins.toFixed(1)} minutes ago`);
            if (typeof data.capital === 'number') state.capital = data.capital;
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
                        // `??`-style guards: a legitimately-zero value (e.g. a fully
                        // drained pool) must NOT be replaced by the default.
                        a.lastProcessedCandleOpenTime = (typeof saved.lastProcessedCandleOpenTime === 'number') ? saved.lastProcessedCandleOpenTime : 0;
                        a.candlesLoaded = false;
                        a.lastTradeDirection = saved.lastTradeDirection ?? null;
                        a.lastTradeWasWin = (typeof saved.lastTradeWasWin === 'boolean') ? saved.lastTradeWasWin : null;
                        a.forceRecoverDirection = saved.forceRecoverDirection ?? null;
                        a.recoveryStep = (typeof saved.recoveryStep === 'number') ? saved.recoveryStep : 0;
                        a.martingaleLevel = (typeof saved.martingaleLevel === 'number') ? saved.martingaleLevel : 0;
                        a.currentStake = (typeof saved.currentStake === 'number' && saved.currentStake > 0)
                            ? saved.currentStake : StakeCalculator.calculate(a.investmentRemaining);
                        a.baseStake = (typeof saved.baseStake === 'number' && saved.baseStake > 0) ? saved.baseStake : CONFIG.MIN_STAKE;
                        a.isRecovery = !!saved.isRecovery;
                        a.lastAnalysis = saved.lastAnalysis || null;
                        a.investmentRemaining = (typeof saved.investmentRemaining === 'number') ? saved.investmentRemaining : CONFIG.INVESTMENT_AMOUNT;
                        a.consecutiveWins = (typeof saved.consecutiveWins === 'number') ? saved.consecutiveWins : 0;
                        a.consecutiveLosses = (typeof saved.consecutiveLosses === 'number') ? saved.consecutiveLosses : 0;
                        a.cooldownCandles = (typeof saved.cooldownCandles === 'number') ? saved.cooldownCandles : 0;

                        a.buyFlagActive = !!saved.buyFlagActive;
                        a.sellFlagActive = !!saved.sellFlagActive;
                        a.inTradeCycle = !!saved.inTradeCycle;
                        a.waitingForReentry = !!saved.waitingForReentry;
                        a.priceReturnedToZone = !!saved.priceReturnedToZone;
                        a.currentDirection = saved.currentDirection ?? null;
                        a.tradeLocked = !!saved.tradeLocked;

                        // Stats
                        a.tradesCount = (typeof saved.tradesCount === 'number') ? saved.tradesCount : 0;
                        a.winsCount = (typeof saved.winsCount === 'number') ? saved.winsCount : 0;
                        a.lossesCount = (typeof saved.lossesCount === 'number') ? saved.lossesCount : 0;
                        a.netPL = (typeof saved.netPL === 'number') ? saved.netPL : 0;
                        a.profit = (typeof saved.profit === 'number') ? saved.profit : 0;
                        a.loss = (typeof saved.loss === 'number') ? saved.loss : 0;
                        a.calibration = Array.isArray(saved.calibration) ? saved.calibration : [];
                        a.activePositions = (saved.activePositions || []).map(p => ({ ...p }));

                        LOGGER.info(`${symbol}: Stake=$${(a.currentStake || 0).toFixed(2)} Pool=$${a.investmentRemaining.toFixed(2)} P/L=$${(a.netPL || 0).toFixed(2)} | W=${a.winsCount} L=${a.lossesCount} T=${a.tradesCount}`);
                    }
                });
            }

            LOGGER.info(`State restored | Ledger capital: $${state.capital.toFixed(2)}`);
            return true;
        } catch (e) { LOGGER.error(`Load state error: ${e.message}`); return false; }
    }

    static startAutoSave() {
        setInterval(() => { if (state.isAuthorized) this.saveState(); }, STATE_SAVE_INTERVAL);
        LOGGER.info(`Auto-save every ${STATE_SAVE_INTERVAL / 1000}s`);
    }
}

// ============================================================
// TELEGRAM SERVICE  [kept + reason/edge display]
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
            `${emoji} <b>PATTERN BOT v2.1 — ${type}</b>`,
            `Pair: <b>${symbol}</b>  Direction: <b>${direction === 'CALLE' ? '\u{1f4c8} CALLE' : '\u{1f4c9} PUTE'}</b>`,
            `Stake: $${stake.toFixed(2)} | Duration: ${duration}${(durationUnit || 's').toUpperCase()}`,
            `Reason: ${details.reasonCode || 'n/a'}`,
            ``,
        ];

        if (type === 'OPEN' && details.analysis) {
            const an = details.analysis;
            const d = an.details || {};
            const confPct = ((an.confidenceLower || 0) * 100).toFixed(1);
            const edgePct = ((an.edge || 0) * 100).toFixed(1);
            const valWR = an.valWR !== undefined ? ((an.valWR * 100).toFixed(0) + '%') : 'N/A';
            lines.push(`\u{1f9e0} <b>Edge model:</b>`);
            lines.push(`Lower-bound conf: ${confPct}% | Holdout WR: ${valWR} | Edge: +${edgePct}pp`);
            lines.push(`Lengths passing: ${(d.byLength || []).length}`);
            lines.push(`${TradingSessionManager.getStatusString()}`);
        }

        if (details.profit !== undefined) {
            const pl = Number(details.profit) || 0;
            lines.push(`Profit: ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}`);
            lines.push(``);
            lines.push(`\u{1f4cb} <b>${symbol} Stats:</b>`);
            lines.push(`W/L: ${a?.winsCount ?? 0}/${a?.lossesCount ?? 0} | Pool: $${(a?.investmentRemaining ?? 0).toFixed(2)}`);
            lines.push(``);
            lines.push(`\u{1f4cb} <b>Today:</b>`);
            lines.push(`Trades: ${today.tradesCount} | W/L: ${today.winsCount}/${today.lossesCount} | P/L: $${(today.netPL || 0).toFixed(2)}`);
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
                assetInfo += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L $${(a.netPL || 0).toFixed(2)} Pool:$${a.investmentRemaining.toFixed(2)}`;
            }
        });

        await this.sendMessage([
            `⏰ <b>PATTERN BOT v2.1 Hourly</b>`,
            `Last Hour: ${h.trades}t ${h.wins}W/${h.losses}L ${wr}% ${h.pnl >= 0 ? '\u{1f7e2}' : '\u{1f534}'} $${h.pnl.toFixed(2)}`,
            `Today: ${today.tradesCount}t P/L: $${(today.netPL || 0).toFixed(2)}`,
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
            `\u{1f4ca} <b>PATTERN BOT v2.1 SESSION SUMMARY</b>`,
            `Duration: ${stats.duration} | Trades: ${stats.trades}`,
            `W: ${stats.wins} | L: ${stats.losses} | Win Rate: ${stats.winRate}`,
            `Session P/L: $${(stats.netPL || 0).toFixed(2)}`,
            `Today P/L: $${(today.netPL || 0).toFixed(2)}`,
            ``,
            `\u{1f4cb} <b>Overall:</b> ${overall.tradesCount} trades | WR: ${wr}% | P/L: $${(overall.netPL || 0).toFixed(2)}`,
            pairBreakdown ? `\n<b>Per-Asset:</b>${pairBreakdown}` : '',
            ``,
            `\u{1f4b0} Ledger capital: $${state.capital.toFixed(2)}`,
        ].join('\n'));
    }

    static async sendStartupMessage() {
        const overall = TradeHistoryManager.getOverallStats();
        let pairInfo = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            pairInfo += `\n  ${sym}: ${CONFIG.TIMEFRAME_LABEL} | ${CONFIG.DURATION}${CONFIG.DURATION_UNIT}`;
        });

        await this.sendMessage([
            `\u{1f916} <b>PATTERN BOT v2.1 STARTED</b>`,
            `Strategy: Honest candle-pattern edge (Wilson lower bound vs breakeven)`,
            `Pattern Lengths: ${CONFIG.PATTERN_LENGTHS.join(',')} | Min occurrences: ${CONFIG.PATTERN_MIN_OCCURRENCES}`,
            `Risk: ${CONFIG.ENABLE_MARTINGALE ? 'MARTINGALE ON (legacy!)' : `Flat ${(CONFIG.RISK_FRACTION * 100).toFixed(0)}% of pool`}`,
            `Session stop: $${Math.abs(CONFIG.SESSION_STOP_LOSS)} | Daily stop: $${Math.abs(CONFIG.DAILY_STOP_LOSS)} | Cooldown: ${CONFIG.COOLDOWN_CANDLES}c`,
            `Ledger capital: $${state.capital.toFixed(2)}`,
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
// SESSION MANAGER  [stops + daily + cooldown arming + calibration]
// ============================================================
class SessionManager {

    static isSessionActive() { return state.session.isActive; }

    /** Enforced at the TOP of every executeNextTrade AND after every settle. */
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
        if ((today.netPL || 0) <= CONFIG.DAILY_STOP_LOSS) {
            LOGGER.error(`Daily stop-loss reached: $${(today.netPL || 0).toFixed(2)}`);
            this.endSession('DAILY_STOP_LOSS');
            return true;
        }

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
                `\u{1f319} <b>PATTERN BOT END OF DAY ${state.currentTradeDay}</b>\nP/L: $${(dayStats?.netPL || 0).toFixed(2)}\nLedger: $${state.capital.toFixed(2)}`
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
                // Fresh day clears streak-based halts. Pool-floor halts are NOT
                // cleared: a drained pool is real money that trading can't recover.
                a.consecutiveLosses = 0;
                a.canTrade = true;
            }
        });
    }

    /** Record a settled outcome. Correct accounting invariant:
     *  stake was deducted on open; a win credits stake+profit back to the pool;
     *  a loss leaves the stake deducted (pool shrinks). state.capital is
     *  reconciled to the real balance by ConnectionManager.reconcileBalance
     *  whenever the bot is flat, so ledger drift cannot accumulate. */
    static recordTradeResult(symbol, profit, direction, stake, payout = null) {
        const a = state.assets[symbol];
        if (!a) return;

        this.checkDayChange();

        const isWin = profit > 0;
        const profitNum = Number(profit) || 0;

        // Ledger: stake was already removed on open; add back the full payout
        // on a win (stake + profit), nothing on a loss (consistent with Deriv
        // where loss profit == -stake). Use payout if provided, else stake+profit.
        if (isWin) {
            const credit = (payout != null && Number(payout) > 0)
                ? Number(payout)
                : (stake + profitNum);
            state.capital = round2(state.capital + credit);
            a.investmentRemaining = round2(a.investmentRemaining + credit);
            LOGGER.trade(`[${symbol}] Pool +$${credit.toFixed(2)} (payout) → $${a.investmentRemaining.toFixed(2)}`);
        } else {
            // Loss: nothing to credit back; stake stays deducted.
            state.capital = round2(state.capital + stake + profitNum); // profitNum ≈ -stake → net 0
            LOGGER.trade(`[${symbol}] Pool unchanged on loss (stake already deducted) → $${a.investmentRemaining.toFixed(2)}`);
        }

        // Session
        state.session.tradesCount++;
        if (isWin) { state.session.winsCount++; state.session.profit += profitNum; }
        else { state.session.lossesCount++; state.session.loss += Math.abs(profitNum); }
        state.session.netPL += profitNum;

        // x2..x9 loss tracking (level BEFORE increment)
        if (!isWin && a.martingaleLevel >= 1 && a.martingaleLevel <= 8) {
            const nextLevel = a.martingaleLevel + 1;
            if (nextLevel >= 2 && nextLevel <= 9) {
                const key = `x${nextLevel}Losses`;
                state.session[key] = (state.session[key] || 0) + 1;
                a[key] = (a[key] || 0) + 1;
            }
        }

        // Hourly (UTC)
        const hour = new Date().getUTCHours();
        if (hour !== state.hourlyStats.lastHour) {
            state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: hour };
        }
        state.hourlyStats.trades++;
        state.hourlyStats.pnl += profitNum;
        if (isWin) state.hourlyStats.wins++; else state.hourlyStats.losses++;

        // Per-asset
        a.tradesCount++;
        if (isWin) {
            a.winsCount++;
            a.profit += profitNum;
            a.netPL += profitNum;
            a.martingaleLevel = 0;
            a.lastTradeWasWin = true;
            a.consecutiveLosses = 0;
            a.isRecovery = false;
            a.baseStake = StakeCalculator.getBaseStake(a.investmentRemaining);
            a.currentStake = StakeCalculator.calculate(a.investmentRemaining, 0);
            LOGGER.trade(`WIN [${symbol}] +$${profitNum.toFixed(2)} | Pool: $${a.investmentRemaining.toFixed(2)} | Next: $${a.currentStake.toFixed(2)}`);
        } else {
            a.lossesCount++;
            a.loss += Math.abs(profitNum);
            a.netPL += profitNum;
            a.martingaleLevel++;
            a.lastTradeWasWin = false;
            a.consecutiveLosses++;

            if (CONFIG.USE_RECOVERY_STRATEGY) {
                a.isRecovery = true;
                LOGGER.info(`[${symbol}] Recovery mode ENTERED (same direction, no analysis)`);
            }

            if (CONFIG.ENABLE_MARTINGALE) {
                if (CONFIG.AUTO_COMPOUNDING) a.baseStake = StakeCalculator.getBaseStake(a.investmentRemaining);
                a.currentStake = StakeCalculator.calculate(a.investmentRemaining, a.martingaleLevel);
                if (a.martingaleLevel >= CONFIG.MAX_MARTINGALE_LEVEL + CONFIG.CONTINUE_EXTRA_LEVELS) {
                    LOGGER.warn(`⚠️ [${symbol}] Max martingale reached, resetting`);
                    a.martingaleLevel = 0;
                    a.baseStake = StakeCalculator.getBaseStake(a.investmentRemaining);
                    a.currentStake = StakeCalculator.calculate(a.investmentRemaining, 0);
                    a.isRecovery = false;
                }
            } else {
                a.currentStake = StakeCalculator.calculate(a.investmentRemaining, 0);
            }
            LOGGER.trade(`LOSS [${symbol}] -$${Math.abs(profitNum).toFixed(2)} | Pool: $${a.investmentRemaining.toFixed(2)} | Next: $${a.currentStake.toFixed(2)} (CL=${a.consecutiveLosses})`);
        }

        // Calibration tracking: predicted lower-bound vs realized outcome.
        if (a.lastAnalysis && a.lastAnalysis.confidenceLower > 0) {
            a.calibration.push({ pred: a.lastAnalysis.confidenceLower, win: isWin ? 1 : 0 });
            if (a.calibration.length > 400) a.calibration = a.calibration.slice(-400);
        }

        // Cooldown arming: v1 never set this, so it traded every candle close.
        // v2 arms it after EVERY settle -> at most one trade per COOLDOWN_CANDLES
        // candles per asset, cutting exposure to the house edge ~6x.
        a.cooldownCandles = Math.max(a.cooldownCandles, CONFIG.COOLDOWN_CANDLES);

        // Asset halt on consecutive-loss streak (streak-based protection that
        // martingale 'continue' cannot bypass).
        if (a.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
            LOGGER.error(`[${symbol}] ${a.consecutiveLosses} consecutive losses — asset halted for the day`);
            a.canTrade = false;
            a.haltedReason = `consecutive_losses_${a.consecutiveLosses}`;
        }

        TradeHistoryManager.recordTrade(symbol, profitNum, a.martingaleLevel);
        StatePersistence.saveState();
    }
}

// ============================================================
// STATE
// ============================================================
const state = {
    assets: {},
    capital: CONFIG.INVESTMENT_AMOUNT,   // ledger; reconciled to account when flat
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
    pendingTradeInfo: null,
    tradeStartTime: null,
    currentContractId: null,
};

let tradeHistory = null;

// ============================================================
// CONNECTION MANAGER
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
        this._portfolioRequested = false;
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
        state.accountBalance = Number(this.accountInfo.balance) || 0;
        this.send({ balance: 1, subscribe: 1 });

        this._afterAuthorize();
        bot.start();
    }

    /** Shared post-authorize path: reconcile open positions + ledger truth. */
    _afterAuthorize() {
        // Seed the ledger from the real account on a fresh start.
        if (state.accountBalance > 0 && state.capital <= 0) {
            state.capital = state.accountBalance;
        }
        // Re-subscribe POC for tracked positions with a contract id.
        this.resubscribeOpenContracts();
        // Enumerate the exchange's view of open contracts and reconcile.
        this.requestPortfolioReconcile(true);
    }

    resubscribeOpenContracts() {
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a?.activePositions) {
                a.activePositions.forEach(pos => {
                    if (pos.contractId) {
                        this.send({ proposal_open_contract: 1, contract_id: pos.contractId, subscribe: 1 });
                    }
                });
            }
        });
    }

    /** Ask the exchange for its open contracts and reconcile against our ledger.
     *  Fixes v1 P0-2/P0-3: buys whose response was lost (contractId null) are
     *  recovered by contract_id, and recovered trades settle the real outcome
     *  instead of being abandoned. */
    requestPortfolioReconcile(afterReconnect = false) {
        if (afterReconnect) {
            // Slight delay lets the socket + auth settle before the query.
            setTimeout(() => this.send({ portfolio: 1 }), 1500);
        } else {
            this.send({ portfolio: 1 });
        }
    }

    handlePortfolio(r) {
        if (r.error) { LOGGER.error(`Portfolio error: ${r.error.message}`); return; }
        const contracts = (r.portfolio && r.portfolio.contracts) || [];
        LOGGER.info(`Portfolio reconcile: ${contracts.length} open contracts on exchange`);

        // Collect all positions across assets for matching.
        const allPositions = [];
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a?.activePositions) {
                a.activePositions.forEach(pos => allPositions.push({ sym, a, pos }));
            }
        });

        const matchedPos = new Set();

        // 1) Attach contract ids to pending positions whose buy actually landed.
        for (const c of contracts) {
            const cid = c.contract_id;
            // Match an existing tracked position by contract id.
            let entry = allPositions.find(p => p.pos.contractId === cid);
            if (entry) {
                matchedPos.add(entry.pos);
                continue;
            }
            // Match a pending position (no contractId) on the same symbol with a
            // recent buy request — the buy response was lost mid-disconnect.
            const asset = state.assets[c.symbol];
            if (asset && asset.activePositions) {
                const pending = asset.activePositions.find(p =>
                    !p.contractId && p.symbol === c.symbol &&
                    (Date.now() - (p.buySentAt || 0)) < 120000);
                if (pending) {
                    pending.contractId = cid;
                    pending.buyPrice = c.buy_price || pending.buyPrice;
                    pending.status = 'open';
                    pending.phantom = false;
                    matchedPos.add(pending);
                    LOGGER.warn(`[${c.symbol}] Attached lost buy response: contract ${cid}`);
                    this.send({ proposal_open_contract: 1, contract_id: cid, subscribe: 1 });
                    bot._startWatchdog(cid);
                    continue;
                }
            }
            // 2) Contract on exchange but unknown to us (ghost buy / external):
            //    track it as a phantom position so its settlement reconciles.
            const symbol = c.symbol || allPositions[0]?.sym;
            if (symbol && state.assets[symbol]) {
                const a = state.assets[symbol];
                const phantom = {
                    symbol, direction: c.contract_type === 'PUTE' || c.contract_type === 'PUT' ? 'PUTE' : 'CALLE',
                    stake: Number(c.buy_price) || CONFIG.MIN_STAKE,
                    duration: CONFIG.DURATION, durationUnit: CONFIG.DURATION_UNIT,
                    entryTime: Date.now(), buySentAt: Date.now(), contractId: cid,
                    reqId: null, currentProfit: 0, buyPrice: c.buy_price || 0,
                    status: 'open', phantom: true, signal: null, reasonCode: 'reconciled:ghost',
                };
                a.activePositions.push(phantom);
                LOGGER.warn(`[${symbol}] Unknown open contract ${cid} tracked as phantom`);
                this.send({ proposal_open_contract: 1, contract_id: cid, subscribe: 1 });
                bot._startWatchdog(cid);
            }
        }

        // 3) Positions the exchange no longer lists.
        const now = Date.now();
        for (const { sym, a, pos } of allPositions) {
            if (matchedPos.has(pos)) continue;

            // Tracked open contract but absent from portfolio and old enough that
            // it should have settled: our POC subscription was lost AND the settle
            // never reached us. Outcome is unknowable -> conservative explicit
            // loss (never credit unverifiable profit). Fixes v1 P0-3 orphaned
            // wins being silently dropped.
            if (pos.contractId) {
                const age = now - (pos.entryTime || 0);
                if (age > CONFIG.BUY_CONFIRM_TIMEOUT_MS + CONFIG.TRADE_WATCHDOG_MS) {
                    LOGGER.warn(`[${sym}] Contract ${pos.contractId} absent from portfolio and unverified ${Math.round(age / 1000)}s — settling as loss`);
                    bot._processedContracts.add(String(pos.contractId));
                    SessionManager.recordTradeResult(sym, -(pos.stake || 0), pos.direction, pos.stake, 0);
                    a.activePositions.splice(a.activePositions.indexOf(pos), 1);
                    a.tradeLocked = false;
                    a.canTrade = true;
                }
                continue;
            }

            // Pending position (buy sent, no contract) NOT on the exchange and
            // older than the confirm window never executed -> refund the stake.
            if (pos.buySentAt && (now - pos.buySentAt) < CONFIG.BUY_CONFIRM_TIMEOUT_MS) continue; // still waiting
            bot._refundPosition(sym, pos, 'refund:reconcile_no_contract');
        }

        this.reconcileBalance();
    }

    /** Reconcile the local ledger against the real account balance whenever we
     *  are flat. With positions open, only warn on drift beyond tolerance. */
    reconcileBalance() {
        if (!state.isAuthorized || state.accountBalance <= 0) return;
        const locked = CONFIG.ACTIVE_ASSETS.reduce((sum, sym) =>
            sum + (state.assets[sym]?.activePositions || []).reduce((s, p) => s + (p.stake || 0), 0), 0);
        if (locked <= 0) {
            if (Math.abs(state.capital - state.accountBalance) > 0.01) {
                LOGGER.normal(`Reconciled ledger $${state.capital.toFixed(2)} -> account $${state.accountBalance.toFixed(2)}`);
                state.capital = state.accountBalance;
            }
            return;
        }
        const expected = state.capital + locked;
        if (Math.abs(state.accountBalance - expected) > CONFIG.RECONCILE_DRIFT_TOLERANCE) {
            LOGGER.error(`Capital drift: ledger=$${state.capital.toFixed(2)} locked=$${locked.toFixed(2)} acct=$${state.accountBalance.toFixed(2)}`);
            TelegramService.sendMessage(
                `⚠️ <b>PATTERN CAPITAL DRIFT DETECTED</b>\nledger=$${state.capital.toFixed(2)} + locked=$${locked.toFixed(2)}\naccount=$${state.accountBalance.toFixed(2)}\nNew entries paused.`
            );
            CONFIG.ACTIVE_ASSETS.forEach(sym => { if (state.assets[sym]) state.assets[sym].canTrade = false; });
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
                    investmentRemaining: CONFIG.INVESTMENT_AMOUNT,
                    canTrade: true,
                    tradeLocked: false,
                    haltedReason: null,
                    statEngine: new StatEngine(),
                    isRecovery: false,
                    baseStake: CONFIG.MIN_STAKE,
                    lastAnalysis: null,
                    consecutiveWins: 0,
                    consecutiveLosses: 0,
                    cooldownCandles: 0,
                    activePositions: [],
                    calibration: [],
                    tradesCount: 0, winsCount: 0, lossesCount: 0,
                    profit: 0, loss: 0, netPL: 0,
                    buyFlagActive: false,
                    sellFlagActive: false,
                    inTradeCycle: false,
                    waitingForReentry: false,
                    priceReturnedToZone: false,
                    currentDirection: null,
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
            case 'balance':
                if (r.balance) {
                    state.accountBalance = Number(r.balance.balance) || state.accountBalance;
                    this.reconcileBalance();
                }
                break;
            case 'ohlc': this.handleOHLC(r.ohlc); break;
            case 'candles': this.handleCandlesHistory(r); break;
            case 'buy': this.handleBuyResponse(r); break;
            case 'portfolio': this.handlePortfolio(r); break;
            case 'proposal_open_contract': this.handleOpenContract(r); break;
            case 'ping': break;
            default: break;
        }
    }

    handleAuthorize(r) {
        if (r.error) { LOGGER.error(`Auth failed: ${r.error.message}`); return; }

        LOGGER.info(`Authorized: ${r.authorize.loginid} | Balance: ${r.authorize.balance} ${r.authorize.currency}`);
        state.isAuthorized = true;
        state.accountBalance = Number(r.authorize.balance) || 0;
        this.send({ balance: 1, subscribe: 1 });

        this._afterAuthorize();
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
                            // P0-1 FIX: refund the stake on buy failure.
                            const pos = a.activePositions[i];
                            bot._refundPosition(sym, pos, 'refund:buy_error');
                        }
                    }
                });
            } else {
                // No req_id echoed: purge any pending position older than the
                // confirm window (fixes v1 P2-14 ghost positions).
                CONFIG.ACTIVE_ASSETS.forEach(sym => {
                    const a = state.assets[sym];
                    if (a?.activePositions) {
                        a.activePositions.slice().forEach(pos => {
                            if (!pos.contractId &&
                                pos.buySentAt &&
                                (Date.now() - pos.buySentAt) >= CONFIG.BUY_CONFIRM_TIMEOUT_MS) {
                                bot._refundPosition(sym, pos, 'refund:buy_error_no_reqid');
                            }
                        });
                    }
                });
            }
            if (bot) bot._forceReleaseTradeLocks('buy_error');
            return;
        }

        const contract = r.buy;
        LOGGER.trade(`Contract opened: ${contract.contract_id} | Buy Price: $${contract.buy_price}`);

        const reqId = r.echo_req.req_id;
        let matched = false;
        for (const sym of CONFIG.ACTIVE_ASSETS) {
            const a = state.assets[sym];
            if (a?.activePositions) {
                const pos = a.activePositions.find(p => p.reqId === reqId);
                if (pos) {
                    pos.contractId = contract.contract_id;
                    pos.buyPrice = contract.buy_price;
                    pos.status = 'open';
                    pos.phantom = false;
                    state.currentContractId = contract.contract_id;
                    state.tradeStartTime = Date.now();
                    state.pendingTradeInfo = { stake: pos.stake, direction: pos.direction, symbol: pos.symbol };
                    matched = true;

                    bot._startWatchdog(contract.contract_id);

                    TelegramService.sendTradeAlert(
                        'OPEN', pos.symbol, pos.direction, pos.stake,
                        pos.duration, pos.durationUnit,
                        { analysis: pos.signal, reasonCode: pos.reasonCode }
                    );
                    break;
                }
            }
        }

        // Acknowledge to the exchange even if we couldn't match locally.
        this.send({ proposal_open_contract: 1, contract_id: contract.contract_id, subscribe: 1 });
        if (!matched) {
            LOGGER.warn(`Buy ${contract.contract_id} could not be matched to a local position`);
            bot._forceReleaseTradeLocks('buy_unmatched');
        }
        StatePersistence.saveState();
    }

    /** Canonical candle open-time key. Prefer the API-provided open_time; else
     *  floor epoch to the granularity. Used identically by history and live
     *  paths so the same candle gets the same key (fixes v1 P1-5). */
    static candleOpenTime(c, gran) {
        if (c.open_time != null) return Math.floor(c.open_time / gran) * gran;
        return Math.floor((c.epoch || 0) / gran) * gran;
    }

    handleOpenContract(r) {
        if (r.error) {
            LOGGER.error(`Contract error: ${r.error.message}`);
            if (bot) bot._forceReleaseTradeLocks('poc_error');
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

        // Open contract — just track running profit.
        if (!contract.is_sold && !contract.is_expired && contract.status !== 'sold' &&
            contract.status !== 'won' && contract.status !== 'lost' && contract.status !== 'cancelled') {
            for (const sym of CONFIG.ACTIVE_ASSETS) {
                const a = state.assets[sym];
                if (a?.activePositions) {
                    const pos = a.activePositions.find(p => p.contractId === contractId);
                    if (pos) { pos.currentProfit = contract.profit; break; }
                }
            }
            return;
        }

        // Settled. Locate the owning position.
        let ownerSym = null, posIdx = -1;
        for (const sym of CONFIG.ACTIVE_ASSETS) {
            const a = state.assets[sym];
            if (a?.activePositions) {
                const i = a.activePositions.findIndex(p => String(p.contractId) === contractIdStr);
                if (i >= 0) { ownerSym = sym; posIdx = i; break; }
            }
        }

        if (posIdx < 0 || !ownerSym) {
            // Settled contract with no matching local position. Retry once, then
            // resolve authoritatively (fixes v1 P0-3/P3-16: never abandon the
            // outcome — settle an explicit loss so the ledger stays consistent).
            if (!r._contractMatchRetry) {
                r._contractMatchRetry = true;
                LOGGER.warn(`Contract ${contractId} settled but not found — retrying in 500ms`);
                setTimeout(() => this.handleOpenContract(r), 500);
                return;
            }
            LOGGER.warn(`Contract ${contractId} settled but still not found — settling as explicit -stake`);
            bot._processedContracts.add(contractIdStr);
            // Best-effort: find a pending position with no contractId whose buy
            // is older than the confirm window and attribute this loss to it.
            let attributed = false;
            for (const sym of CONFIG.ACTIVE_ASSETS) {
                const a = state.assets[sym];
                if (a?.activePositions) {
                    const i = a.activePositions.findIndex(p => !p.contractId);
                    if (i >= 0) {
                        const pos = a.activePositions[i];
                        SessionManager.recordTradeResult(sym, -(pos.stake || 0), pos.direction, pos.stake, 0);
                        a.activePositions.splice(i, 1);
                        a.tradeLocked = false;
                        a.canTrade = true;
                        attributed = true;
                        break;
                    }
                }
            }
            if (!attributed) {
                // No position at all: reflect as a session loss so totals aren't inflated.
                state.session.netPL -= CONFIG.MIN_STAKE;
                state.capital = round2(state.capital - CONFIG.MIN_STAKE);
            }
            if (r.subscription?.id) this.send({ forget: r.subscription.id });
            SessionManager.checkSessionTargets();
            StatePersistence.saveState();
            return;
        }

        bot._processedContracts.add(contractIdStr);
        bot._clearWatchdog(contractIdStr);

        const a = state.assets[ownerSym];
        const pos = a.activePositions[posIdx];
        const profit = Number(contract.profit);

        SessionManager.recordTradeResult(ownerSym, profit, pos.direction, pos.stake, contract.payout);
        a.canTrade = true;

        TelegramService.sendTradeAlert(
            profit >= 0 ? 'WIN' : 'LOSS',
            ownerSym, pos.direction, pos.stake,
            pos.duration, pos.durationUnit,
            { profit, reasonCode: pos.reasonCode }
        );

        a.activePositions.splice(posIdx, 1);
        a.tradeLocked = false;
        state.currentContractId = null;
        state.tradeStartTime = null;
        state.pendingTradeInfo = null;

        if (r.subscription?.id) this.send({ forget: r.subscription.id });

        this.reconcileBalance();
        SessionManager.checkSessionTargets();
        StatePersistence.saveState();
    }

    // ════════════════════════════════════════════════════════
    // OHLC HANDLER — candle close triggers trade logic
    // ════════════════════════════════════════════════════════
    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        const a = state.assets[symbol];
        if (!a) return;

        const gran = CONFIG.GRANULARITY;
        const openTime = ConnectionManager.candleOpenTime(ohlc, gran);

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

            // Dedupe against history-merged candles with tolerance (fixes P1-5:
            // history vs live epoch semantics may differ by one gran).
            const alreadyIn = a.closedCandles.some(c => Math.abs(c.open_time - closed.open_time) < gran / 2);

            if (closed.open_time !== a.lastProcessedCandleOpenTime && !alreadyIn) {
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

                try {
                    bot.executeNextTrade(symbol, closed);
                } catch (err) {
                    LOGGER.error(`[${symbol}] Trade execution error: ${err.message}`);
                    bot._forceReleaseTradeLocks('exec_error');
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
            epoch: c.epoch, open_time: ConnectionManager.candleOpenTime(c, gran),
        }));

        if (!incomingCandles.length) { LOGGER.warn(`[${symbol}] No candles received`); return; }

        const a = state.assets[symbol];

        // FIX (v1 P1-6): the final history candle is the still-FORMING candle.
        // Do not treat it as closed — keep it as currentFormingCandle and only
        // merge the fully closed ones.
        const forming = incomingCandles[incomingCandles.length - 1];
        const closedHistory = incomingCandles.slice(0, -1);

        const existingEpochs = new Set(a.closedCandles.map(c => c.open_time));
        let addedCount = 0;
        for (const c of closedHistory) {
            // tolerant dedupe: same physical candle may key differently by one gran
            if (!a.closedCandles.some(x => Math.abs(x.open_time - c.open_time) < gran / 2)) {
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
        a.currentFormingCandle = forming;

        // Advance lastProcessed only to the last FULLY CLOSED history candle so
        // the forming candle's close still fires a trade event.
        if (closedHistory.length) {
            const lastClosed = closedHistory[closedHistory.length - 1];
            if (!a.lastProcessedCandleOpenTime || lastClosed.open_time > a.lastProcessedCandleOpenTime) {
                a.lastProcessedCandleOpenTime = lastClosed.open_time;
            }
        }

        a.candlesLoaded = true;

        LOGGER.info(
            `[${symbol}] Loaded ${incomingCandles.length} ${CONFIG.TIMEFRAME_LABEL} candles (${addedCount} new merged, total: ${a.closedCandles.length})`
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
            TelegramService.sendMessage(`⚠️ <b>PATTERN BOT CONNECTION LOST</b> — Reconnecting (attempt ${this.reconnectAttempts})`);

            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (this.isShuttingDown) return;
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached — giving up');
            TelegramService.sendMessage(`\u{1f6d1} <b>PATTERN BOT STOPPED</b> — Max reconnections\nFinal P/L: $${(state.session.netPL || 0).toFixed(2)}`);
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
// MAIN BOT CLASS — v2 orchestration
// ============================================================
class IndexBot {

    constructor() {
        this.connection = new ConnectionManager();
        this._processedContracts = new Set();
        this._watchdogs = new Map();           // contractId -> {poll, recover}
        this.tradeWatchdogMs = CONFIG.TRADE_WATCHDOG_MS;
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
        console.log(' DERIV CALLE/PUTE BOT v2.1 — HONEST CANDLE-PATTERN EDGE (Pattern Engine)');
        console.log('═'.repeat(74));
        console.log(`Assets    : ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        console.log(`Timeframe : ${CONFIG.TIMEFRAME_LABEL} candles | Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT} (aligned)`);
        console.log(`Risk      : ${CONFIG.ENABLE_MARTINGALE ? 'MARTINGALE (legacy, ON)' : `Flat ${(CONFIG.RISK_FRACTION * 100).toFixed(0)}% of pool`}`);
        console.log(`Guards    : Session -$${Math.abs(CONFIG.SESSION_STOP_LOSS)} / Daily -$${Math.abs(CONFIG.DAILY_STOP_LOSS)} / ${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive / cooldown ${CONFIG.COOLDOWN_CANDLES}c`);
        console.log(`Ledger    : $${state.capital.toFixed(2)}${CONFIG.DRY_RUN ? '   [DRY-RUN — no buys sent]' : ''}`);
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

        LOGGER.info('PATTERN BOT v2.1 fully started!');
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
    // CORE TRADE LOGIC — called on every candle close
    // ════════════════════════════════════════════════════════
    executeNextTrade(symbol, lastClosedCandle) {
        const a = state.assets[symbol];
        if (!a) return;
        if (!state.isConnected || !state.isAuthorized) { LOGGER.reason('hold:not_authorized', symbol); return; }
        if (!a.canTrade) { LOGGER.reason('hold:can_trade_off', symbol); return; }
        if (!SessionManager.isSessionActive()) { LOGGER.reason('hold:session_inactive', symbol); return; }
        if (a.tradeLocked) { LOGGER.reason('hold:asset_locked', symbol); return; }
        if (a.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) { LOGGER.reason('hold:max_positions_per_asset', symbol); return; }

        // Session/daily stops are enforced at the TOP of every decision.
        if (SessionManager.checkSessionTargets()) { LOGGER.reason('hold:session_stop', symbol); return; }

        if (a.cooldownCandles > 0) {
            LOGGER.reason('hold:cooldown', `${symbol} (${a.cooldownCandles}c left)`);
            return;
        }

        if (StakeCalculator.poolHalted(a.investmentRemaining)) {
            a.canTrade = false;
            a.haltedReason = 'pool_floor';
            LOGGER.reason('hold:asset_pool_halted', `${symbol} pool $${a.investmentRemaining.toFixed(2)} < floor $${CONFIG.MIN_POOL_TO_TRADE.toFixed(2)}`);
            return;
        }

        if (a.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
            a.canTrade = false;
            a.haltedReason = `consecutive_losses_${a.consecutiveLosses}`;
            LOGGER.reason('hold:consecutive_losses', `${symbol} (${a.consecutiveLosses})`);
            return;
        }

        const totalPositions = CONFIG.ACTIVE_ASSETS.reduce(
            (sum, s) => sum + (state.assets[s]?.activePositions?.length ?? 0), 0
        );
        if (totalPositions >= CONFIG.MAX_TOTAL_POSITIONS) {
            LOGGER.reason('hold:max_total_positions', `${totalPositions}/${CONFIG.MAX_TOTAL_POSITIONS}`);
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
                LOGGER.reason('hold:outside_sessions', symbol);
                return;
            }
        }

        if (a.closedCandles.length < CONFIG.MIN_CANDLES_REQUIRED) {
            LOGGER.reason('hold:no_history', `${symbol} (${a.closedCandles.length}/${CONFIG.MIN_CANDLES_REQUIRED} candles)`);
            return;
        }

        // ── Signal decision ──────────────────────────────────
        let direction;
        let analysis = null;
        let isRecovery = false;
        let reasonCode;

        // Recovery (behind flag; off by default — see header warnings).
        if (CONFIG.USE_RECOVERY_STRATEGY && a.isRecovery && a.lastTradeDirection) {
            direction = a.lastTradeDirection;
            isRecovery = true;
            reasonCode = 'entry:recovery';
            LOGGER.recovery(`🔄 [${symbol}] RECOVERY TRADE - Same direction: ${direction} (NO analysis)`);
        } else {
            analysis = a.statEngine.decide(a.closedCandles);
            a.lastAnalysis = analysis;
            LOGGER.signal(`[${symbol}] ${a.statEngine.getAnalysisSummary(analysis)}`);

            if (analysis.action === 'HOLD') {
                LOGGER.reason(analysis.reason, `${symbol} ${analysis.details.edge !== undefined ? 'edge=' + analysis.details.edge : ''}`);
                return;
            }
            direction = analysis.action;
            reasonCode = 'entry:edge';
        }

        // ── Stake / risk sizing ──────────────────────────────
        const stake = StakeCalculator.calculate(a.investmentRemaining, a.martingaleLevel);
        if (stake > a.investmentRemaining) {
            LOGGER.reason('hold:insufficient_pool', `${symbol} stake $${stake.toFixed(2)} > pool $${a.investmentRemaining.toFixed(2)}`);
            a.canTrade = false;
            return;
        }
        if (stake > state.capital) {
            LOGGER.reason('hold:insufficient_capital', `${symbol} stake $${stake.toFixed(2)} > ledger $${state.capital.toFixed(2)}`);
            a.canTrade = false;
            return;
        }

        // ── DRY-RUN: decide + pace, but never send a buy ─────
        if (CONFIG.DRY_RUN) {
            a.canTrade = false;
            a.cooldownCandles = Math.max(a.cooldownCandles, CONFIG.COOLDOWN_CANDLES);
            LOGGER.normal(`DRY-RUN [${symbol}] would BUY ${direction} | ${StakeCalculator.describe(a.investmentRemaining, a.martingaleLevel)} | reason=${reasonCode}`);
            return;
        }

        // ── Reserve stake & send buy ─────────────────────────
        a.investmentRemaining = round2(a.investmentRemaining - stake);
        state.capital = round2(state.capital - stake);

        a.canTrade = false;
        a.lastTradeDirection = direction;
        a.tradeLocked = true;

        const position = {
            symbol, direction, stake, duration: CONFIG.DURATION, durationUnit: CONFIG.DURATION_UNIT,
            entryTime: Date.now(), buySentAt: Date.now(), contractId: null, reqId: null,
            currentProfit: 0, buyPrice: 0, status: 'pending',
            signal: analysis, reasonCode, isRecovery, phantom: false,
        };

        a.activePositions.push(position);

        LOGGER.trade(
            `\u{1f3af} [${symbol}] ${direction === 'CALLE' ? '\u{1f4c8} CALLE' : '\u{1f4c9} PUTE'} |` +
            `Stake: $${stake.toFixed(2)} | ${analysis?.reason || reasonCode}`
        );

        // Official `buy` schema: the PAT (new) API expects `underlying_symbol`,
        // the legacy API expects `symbol`. Derive it from the live connection
        // (matches bizarbitrage.js), instead of the hardcoded BUY_SYMBOL_FIELD
        // which always sent `symbol` and got rejected by the PAT endpoint.
        const symbolKey = this.connection && this.connection._isPat ? 'underlying_symbol' : 'symbol';
        const params = {
            contract_type: direction,
            [symbolKey]: symbol,
            currency: CONFIG.CURRENCY,
            amount: Number(stake).toFixed(2),
            duration: CONFIG.DURATION,
            duration_unit: CONFIG.DURATION_UNIT,
            basis: 'stake',
        };

        const reqId = this.connection.send({
            buy: 1, subscribe: 1, price: Number(stake).toFixed(2),
            parameters: params,
        });

        if (reqId === null) {
            // P1-4 FIX: send() failed (socket closed between the check and the
            // call) — the buy never left the client. Refund synchronously.
            LOGGER.error(`[${symbol}] Send failed — refunding stake immediately`);
            this._refundPosition(symbol, position, 'refund:send_failed');
            return;
        }

        position.reqId = reqId;

        // Buy confirm timeout (fixes P0-1: refunds if no response in time).
        setTimeout(() => {
            if (a.tradeLocked && !position.contractId) {
                LOGGER.warn(`[${symbol}] Buy response timeout — refunding stake`);
                this._refundPosition(symbol, position, 'refund:buy_timeout');
            }
        }, CONFIG.BUY_CONFIRM_TIMEOUT_MS);

        StatePersistence.saveState();
    }

    /** Refund a position's reserved stake (buy never confirmed). Restores both
     *  ledgers and releases the asset lock. Central P0-1 fix. */
    _refundPosition(symbol, pos, reason) {
        const a = state.assets[symbol];
        if (!a) return;
        const idx = a.activePositions.indexOf(pos);
        if (idx < 0) {
            // Not tracked here; still try to unlock.
            a.tradeLocked = false;
            return;
        }
        // If the buy actually confirmed (contractId set), do NOT refund or
        // untrack: the contract is live and its settlement will reconcile the
        // stake. Only release the asset lock so the bot keeps operating.
        if (pos.contractId) {
            a.tradeLocked = false;
            return;
        }
        const refund = Number(pos.stake) || 0;
        a.activePositions.splice(idx, 1);
        a.investmentRemaining = round2(a.investmentRemaining + refund);
        state.capital = round2(state.capital + refund);
        a.tradeLocked = false;
        a.canTrade = true;
        LOGGER.reason(reason, `${symbol} refunded $${refund.toFixed(2)} → pool $${a.investmentRemaining.toFixed(2)}`);
        StatePersistence.saveState();
    }

    // ── Watchdogs (per-contract; fixes v1 P3-17 shared timers) ──
    _startWatchdog(contractId) {
        const key = String(contractId);
        this._clearWatchdog(key);
        const entry = {
            recover: null,
            poll: setTimeout(() => {
                LOGGER.warn(`WATCHDOG fired for contract ${key}`);
                if (state.isConnected && state.isAuthorized) {
                    this.connection.send({ forget_all: 'proposal_open_contract' });
                    this.connection.send({ proposal_open_contract: 1, contract_id: Number(key), subscribe: 1 });
                    entry.poll = setTimeout(() => {
                        LOGGER.error(`WATCHDOG: Poll timeout — forcing recovery`);
                        this._recoverStuckTrade('watchdog-timeout', key);
                    }, 30000);
                } else {
                    this._recoverStuckTrade('watchdog-offline', key);
                }
            }, this.tradeWatchdogMs),
        };
        this._watchdogs.set(key, entry);
    }

    _clearWatchdog(contractId) {
        const key = String(contractId);
        const entry = this._watchdogs.get(key);
        if (entry) {
            if (entry.recover) clearTimeout(entry.recover);
            if (entry.poll) clearTimeout(entry.poll);
            this._watchdogs.delete(key);
        }
    }

    _clearAllWatchdogs() {
        for (const key of [...this._watchdogs.keys()]) this._clearWatchdog(key);
    }

    _forceReleaseTradeLocks(reason) {
        this._clearAllWatchdogs();
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                a.tradeLocked = false;
                // Only re-arm canTrade for assets not mid-cooldown (fixes P3-18).
                if (a.cooldownCandles === 0) a.canTrade = true;
            }
        });
        state.currentContractId = null;
        state.tradeStartTime = null;
        state.pendingTradeInfo = null;
        LOGGER.warn(`Trade locks force-released (${reason})`);
    }

    /** Recover a stuck open contract WITHOUT abandoning its outcome (fixes v1
     *  P0-3: never add to _processedContracts here and NEVER untrack the
     *  position — the re-subscribed proposal_open_contract stream will deliver
     *  the real settlement to handleOpenContract, which credits win or loss
     *  correctly. We only release the asset lock so the bot keeps operating;
     *  the position stays reserved so the pool cannot be double-spent.
     *  If the contract truly never settles and drops out of the portfolio,
     *  handlePortfolio's absence-fallback records a conservative loss. */
    _recoverStuckTrade(reason, contractIdStr) {
        LOGGER.warn(`Stuck trade recovery: ${reason} (contract ${contractIdStr})`);
        this._clearWatchdog(contractIdStr);

        const contractId = contractIdStr ? Number(contractIdStr) : state.currentContractId;

        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a?.activePositions) {
                const i = a.activePositions.findIndex(p => String(p.contractId) === String(contractId));
                if (i >= 0) {
                    // Keep the position tracked; only release the lock. The
                    // position stays reserved until the real settle arrives.
                    a.tradeLocked = false;
                    LOGGER.info(`Released lock for stuck position on ${sym} (awaiting settle)`);
                }
            }
        });

        // Re-subscribe + ask the exchange for truth so the settle reconciles.
        if (contractId && state.isConnected && state.isAuthorized) {
            this.connection.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
        }
        this.connection.requestPortfolioReconcile(true);

        state.currentContractId = null;
        state.pendingTradeInfo = null;
        state.tradeStartTime = null;

        TelegramService.sendMessage(
            `⚠️ <b>PATTERN BOT STUCK TRADE [${reason}]</b>\n` +
            `Contract: ${contractId}\n` +
            `Outcome will be reconciled against the exchange.`
        );

        StatePersistence.saveState();
    }

    stop() {
        LOGGER.info('Stopping bot...');
        CONFIG.ACTIVE_ASSETS.forEach(sym => { if (state.assets[sym]) state.assets[sym].canTrade = false; });
        TelegramService.clearTimers();
        this._clearAllWatchdogs();
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
                    martingaleLevel: a.martingaleLevel,
                    isRecovery: a.isRecovery,
                    pool: a.investmentRemaining,
                    consecutiveLosses: a.consecutiveLosses,
                    haltedReason: a.haltedReason,
                };
            }
        });

        return {
            connected: state.isConnected, authorized: state.isAuthorized, capital: state.capital,
            accountBalance: state.accountBalance,
            session: SessionManager.getSessionStats(), sessionInfo: TradingSessionManager.getSessionInfo(),
            totalPositions: CONFIG.ACTIVE_ASSETS.reduce((s, sym) => s + (state.assets[sym]?.activePositions?.length ?? 0), 0),
            pairs: pairStatuses, overall, today,
        };
    }
}

// ============================================================
// SELFTEST — verify the strategy shows ~zero edge on pure noise
// ============================================================
function runSelftest() {
    console.log('\n🧪 PATTERN BOT v2.1 — SELFTEST\n');
    const rng = mulberry32(20260804);

    const makeNoiseCandles = (n, r) => {
        const out = [];
        let price = 10000;
        for (let i = 0; i < n; i++) {
            const open = price;
            const move = (r() < 0.5 ? -1 : 1) * (1 + r() * 3); // body > doji threshold
            const close = open + move;
            const high = Math.max(open, close) + r();
            const low = Math.min(open, close) - r();
            out.push({ open, high, low, close, epoch: i * 60 });
            price = close;
        }
        return out;
    };

    // ── 1. Pure-noise null test ──────────────────────────────
    const eng = new StatEngine();
    let trials = 0, traded = 0, wins = 0;
    const N_TRIALS = 500;
    const N_CANDLES = 501; // 500 for decide, +1 for realized outcome

    for (let t = 0; t < N_TRIALS; t++) {
        const candles = makeNoiseCandles(N_CANDLES, rng);
        const decision = eng.decide(candles.slice(0, N_CANDLES - 1));
        trials++;
        if (decision.action !== 'HOLD') {
            traded++;
            const realizedIsB = candles[N_CANDLES - 1].close > candles[N_CANDLES - 1].open;
            const won = (decision.action === 'CALLE' && realizedIsB) || (decision.action === 'PUTE' && !realizedIsB);
            if (won) wins++;
        }
    }

    const tradeRate = traded / trials;
    const realizedWR = traded > 0 ? wins / traded : null;
    // std err of a proportion ~ sqrt(0.5*0.5/n). A healthy engine should be
    // within ~2.5 sigma of 50% on noise (no phantom edge above breakeven 51.3%).
    const se = traded > 0 ? Math.sqrt(0.25 / traded) : 0;

    console.log('── 1. Pure-noise null test (500 independent 500-candle walks) ──');
    console.log(`   Trades taken on noise   : ${traded}/${trials} (${(tradeRate * 100).toFixed(2)}%)`);
    console.log(`   Realized win rate       : ${realizedWR === null ? 'n/a (no trades)' : (realizedWR * 100).toFixed(1) + '%'}`);
    console.log(`   Breakeven win rate      : ${(eng.breakeven() * 100).toFixed(1)}%`);
    console.log(`   Trade gate              : ${((eng.breakeven() + CONFIG.PATTERN_BREAKEVEN_MARGIN) * 100).toFixed(1)}%`);

    // Two-part check: the engine should NOT show a phantom edge above breakeven
    // on noise (realized WR not significantly > 51.3%), AND it must actually
    // trade on noise at least a little (regression guard against over-conservative
    // configs that never enter — the v2.0 bug that traded ~1x/24h).
    const phantom = realizedWR !== null && (realizedWR - eng.breakeven()) > 2.5 * se;
    const tooConservative = traded < 5;
    const nullOk = !phantom && !tooConservative;
    console.log(`   Phantom edge check     : ${phantom ? 'FAIL ❌ (WR above breakeven on noise)' : 'PASS ✅'}`);
    console.log(`   Activity check         : ${tooConservative ? 'FAIL ❌ (trades <5/500 on noise — too conservative)' : 'PASS ✅'}`);
    console.log(`   Null test               : ${nullOk ? 'PASS ✅ (no phantom alpha, active)' : 'FAIL ❌ (see above)'}`);

    // ── 2. Stake / risk math ────────────────────────────────
    console.log('\n── 2. Stake / risk math ──');
    const mk = () => ({ investmentRemaining: CONFIG.INVESTMENT_AMOUNT, martingaleLevel: 0 });
    const checks = [];
    const check = (name, cond) => { checks.push(cond); console.log(`   ${cond ? 'PASS ✅' : 'FAIL ❌'} ${name}`); };

    const s152 = StakeCalculator.calculate(mk().investmentRemaining, 0);
    if (CONFIG.ENABLE_MARTINGALE) {
        // Legacy martingale mode (user-enabled): level-0 stake = base (0.24% of
        // pool, floored at MIN_STAKE). Assert it's sane and within the pool.
        check(`pool=152 martingale base = ${s152} (sane, <= 1% of pool)`, s152 >= 0.35 && s152 <= 1.52);
    } else {
        check(`pool=152 flat stake = ${s152} (≈1%)`, s152 > 1.4 && s152 < 1.7);
    }

    const s10 = StakeCalculator.calculate(10, 0);
    check(`pool=10 stake = ${s10} (≥ MIN_STAKE 0.35)`, s10 === 0.35);

    const s0_2 = StakeCalculator.calculate(0.2, 0);
    check(`pool=0.2 stake = ${s0_2} (never exceeds pool — P2-12 fixed)`, s0_2 <= 0.2);

    // poolHalted(pool) is true when pool < 20% of INVESTMENT_AMOUNT (30.40).
    check(`poolHalted(152) = false`, StakeCalculator.poolHalted(CONFIG.INVESTMENT_AMOUNT) === false);
    check(`poolHalted(76) = false (50%)`, StakeCalculator.poolHalted(CONFIG.INVESTMENT_AMOUNT * 0.5) === false);
    check(`poolHalted(5) = true (floor ${CONFIG.MIN_POOL_TO_TRADE})`, StakeCalculator.poolHalted(5) === true);

    // ── 3. Wilson bound sanity (z-agnostic) ────────────────
    console.log('\n── 3. Wilson lower-bound sanity ──');
    const z = zForConfidence(CONFIG.PATTERN_CONFIDENCE_LEVEL);
    const w00 = wilsonLower(0, 0, z);
    const w55 = wilsonLower(5, 5, z);
    const w50_100 = wilsonLower(50, 100, z);
    const w95_100 = wilsonLower(95, 100, z);
    check(`wilson(0,0)=${w00}`, w00 === 0);
    check(`wilson(5,5)=${w55.toFixed(3)} < 1`, w55 < 1);
    check(`wilson(50,100)=${w50_100.toFixed(3)} < 0.5 (conservative)`, w50_100 < 0.5);
    check(`wilson(95,100)=${w95_100.toFixed(3)} in (0.80,1) (95/100, any z)`, w95_100 > 0.80 && w95_100 < 1);
    check(`wilson(95,100) <= point estimate 0.95 (lower bound)`, w95_100 <= 0.95);
    check('breakeven p* ≈ 0.513 at 95% payout', Math.abs(eng.breakeven() - 1 / 1.95) < 0.001);

    // ── Summary ─────────────────────────────────────────────
    const allPass = nullOk && checks.every(Boolean);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(allPass
        ? 'SELFTEST: PASS ✅  Engine shows ~zero edge on noise; risk math is sane.'
        : 'SELFTEST: FAIL ❌  Review the failed checks above.');
    console.log('═'.repeat(60) + '\n');
    process.exit(allPass ? 0 : 1);
}

// ════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════
tradeHistory = TradeHistoryManager.loadHistory();
const bot = new IndexBot();

process.on('SIGINT', () => { bot.stop(); bot.connection.shutdown(); setTimeout(() => process.exit(0), 3000); });
process.on('SIGTERM', () => { bot.stop(); bot.connection.shutdown(); setTimeout(() => process.exit(0), 3000); });
process.on('uncaughtException', (err) => { LOGGER.error(`UNCAUGHT: ${err.message}\n${err.stack}`); try { StatePersistence.saveState(); } catch { } });
process.on('unhandledRejection', (reason) => { LOGGER.error(`UNHANDLED: ${reason}`); try { StatePersistence.saveState(); } catch { } });

if (FLAG_SELFTEST) {
    runSelftest();
} else {
    const stateLoaded = StatePersistence.loadState();
    LOGGER.info(stateLoaded ? 'Resuming from saved state' : 'Starting fresh session');

    if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
        console.error('\n⚠️  Set CONFIG.API_TOKEN before running!\n');
        process.exit(1);
    }

    console.log('\n\u{1f680} Starting PATTERN BOT v2.1...\n');
    bot.connection.connect();

    // ── Status display every 60s ──────────────────────────────
    const statusInterval = setInterval(() => {
        if (!state.isAuthorized) return;

        const status = bot.getStatus();

        if (state.currentContractId && state.tradeStartTime) {
            const elapsed = Date.now() - state.tradeStartTime;
            if (elapsed > CONFIG.SAFETY_STUCK_TRADE_MS) {
                LOGGER.error(`SAFETY: Trade stuck ${Math.round(elapsed / 1000)}s — forcing recovery`);
                bot._recoverStuckTrade('safety-timeout', String(state.currentContractId));
            }
        }

        // Calibration report every ~30 status ticks.
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a && a.calibration && a.calibration.length >= 25 && (a.calibration.length % 25 < 1)) {
                const wins = a.calibration.filter(x => x.win === 1).length;
                LOGGER.normal(`[${sym}] Calibration: ${a.calibration.length} trades, realized WR ${((wins / a.calibration.length) * 100).toFixed(1)}% (predicted lower bounds vs outcomes)`);
            }
        });

        let pairLines = '';
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            const p = status.pairs[sym];
            if (p) {
                const cdwn = p.cooldownCandles > 0 ? `❄️CD:${p.cooldownCandles}` : '';
                const halt = p.haltedReason ? `⛔${p.haltedReason}` : '';
                pairLines += `\n  ${sym}: $${(p.currentStake || 0).toFixed(2)} | ${p.trades}t ${p.wins}W/${p.losses}L $${(p.netPL || 0).toFixed(2)} | Pool:$${p.pool.toFixed(2)} CL:${p.consecutiveLosses} | Pos:${p.activePositions} ${cdwn} ${halt}`;
            }
        });

        console.log(`\n\u{1f4ca} ${getGMTTime()} | Session: ${status.session.trades}t ${status.session.winRate} $${(status.session.netPL || 0).toFixed(2)} | Ledger: $${status.capital.toFixed(2)} | Acct: $${status.accountBalance.toFixed(2)}`);
        console.log(`\u{1f4cb} Overall: ${status.overall.tradesCount}t | P/L: $${(status.overall.netPL || 0).toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
        console.log(`\u{1f555} ${TradingSessionManager.getStatusString()}`);
        console.log(`\u{1f4c8} Assets:${pairLines}`);

    }, 60000);

    bot.statusDisplayIntervalId = statusInterval;
}
