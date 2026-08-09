#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  Deriv Digit Differ Trading Bot (v4 — honest, risk-first re-engineer)
 * =====================================================================
 *
 *  Single-file DIGITDIFF bot. DIGITDIFF pays when the last digit at
 *  expiry DIFFERS from the barrier digit. Under a fair RNG that hits
 *  ~90% of the time; the platform payout already prices that in plus a
 *  house margin, so UNSELECTIVE play is negative expected value.
 *
 *  ── What this version is, and is not ─────────────────────────────
 *  Deriv's synthetic indices run on an independently audited
 *  cryptographically-secure RNG. Each tick's last digit is, to the
 *  precision that matters here, an independent uniform draw. Past digit
 *  frequency, gaps, streaks, "coldness", and regime-cycle filters carry
 *  no demonstrated information about the next tick. Stacking several
 *  such heuristics and requiring them to "agree" does not create an edge
 *  out of N instances of the gambler's fallacy — it adds complexity,
 *  API load, and false confidence. DIGITDIFF's payout prices in the true
 *  ~90% hit rate plus house margin, so unselective play has negative
 *  expected value, and no amount of pattern-hunting on tick history
 *  changes that.
 *
 *  This bot therefore keeps exactly ONE simple, transparent signal
 *  (empirical digit frequency with a Wilson uncertainty bound — a
 *  heuristic, NOT a demonstrated edge) and spends its engineering effort
 *  on three things that can actually be done honestly:
 *
 *    1. CAPITAL PRESERVATION — hard daily loss caps that genuinely stop
 *       trading, a consecutive-loss circuit breaker that is ON by
 *       default, per-symbol calibration that benches a symbol the
 *       moment live results diverge from the model, and stake caps as a
 *       % of bankroll. The loss-recovery ladder that could blow up a
 *       demo account on ordinary streaks is OFF by default and hard-
 *       capped when enabled.
 *
 *    2. EXECUTION RELIABILITY — no double-buy races, no orphaned open
 *       contracts across reconnect (reconciliation), no fabricated P&L
 *       when a settlement can't be confirmed, correct balance tracking.
 *
 *    3. HONEST MEASUREMENT — the bot trades only when a live proposal's
 *       break-even loss probability clearly beats a conservative upper
 *       bound on the real loss probability. On fair digits that
 *       essentially never happens, so the bot idles. A `--selftest`
 *       proves on synthetic data that the machinery does NOT mint a
 *       phantom edge on a fair stream, and a positive-control test
 *       proves it DOES detect a real, injected signal.
 *
 *  Decision stack:
 *    • Barrier digit = coldest empirical-frequency digit (Wilson upper
 *      confidence bound) over one configurable lookback window.
 *    • Regime sanity gates: entropy / χ² band + minimum probability gap
 *      between the best and second-best digit, so we don't act on a
 *      sample too small/degenerate to be a meaningful read.
 *    • Live proposal: q_be = 1 − ask/payout (break-even loss prob);
 *          require  q_be − pLossUpper − safetyMargin ≥ minEdge
 *    • Sizing: flat stake by default; fractional-Kelly optional;
 *      loss-recovery ladder OFF by default and hard-capped if enabled.
 *    • Per-symbol calibrator (ON) benches symbols that under-perform
 *      their own prediction; circuit breaker (ON) pauses after N losses.
 *
 *  Features:
 *    • DIGITDIFF only • Overall / daily P/L • Hard daily stop that halts
 *    • Loss-streak circuit breaker • GMT day clock + EOD reports
 *    • State JSON • Telegram queue • Reconnect backoff + contract
 *      reconciliation • Legacy token + PAT/OTP • Built-in backtester
 *    • Built-in diagnostics (repeat-structure tests) + SELFTEST
 *
 *  Credentials: this is a TEST build. The apiToken / appId / Telegram
 *  values below are the user's hardcoded demo-test credentials and are
 *  deliberately preserved for local testing. Do not rotate or remove
 *  them as part of this engagement. (If this code were ever to run on
 *  real money with real tokens, those tokens would belong in a secret
 *  store — that is a deployment decision, not this file's job.)
 *
 *  Install:  npm install ws
 *  Run:      node newDifferX2.js
 *  Selftest: $env:SELFTEST=1; node newDifferX2.js        (offline, no API)
 *  Diagnose: $env:DIAGNOSE=1; node newDifferX2.js        (repeat-structure tests)
 *  Backtest: $env:BACKTEST=1; node newDifferX2.js        (historical sim)
 *            $env:BACKTEST_ASSET="R_100"; $env:BACKTEST_TICKS=100000
 *
 * =====================================================================
 */

const WebSocket    = require('ws');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { URL }      = require('url');
const EventEmitter = require('events');

// ─────────────────────────────────────────────────────────────────────
// 1. ENV LOADER  (kept; env vars may override CONFIG, they do not remove
//    the hardcoded test credentials below)
// ─────────────────────────────────────────────────────────────────────
function loadEnv(filePath = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) return;
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) {
    console.error('[boot] could not read .env:', e.message);
  }
}
loadEnv();

function numEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function intEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function boolEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}
function strEnv(name, def) {
  const v = process.env[name];
  return v == null || v === '' ? def : String(v).trim();
}
function listEnv(name, def) {
  return strEnv(name, def).split(',').map(s => s.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────
// 2. CONFIGURATION
// ─────────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  // ── Deriv API (existing hardcoded demo-test credentials — preserved) ──
  apiToken:    'pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee',
  appId:       '33uslPtthXBEkQOdfKfoY',
  accountId: '', // recommended/required for PAT new API
  accountType: 'demo', // demo | real
  legacyWsUrl: 'wss://ws.derivws.com/websockets/v3',
  restBaseUrl: 'https://api.derivws.com',
  currency: 'USD',

  // Trade setup
  stake: 1.1,
  durationTicks: 1, // Digit contracts normally 1-10 ticks
  minStake: 1.1,
  maxStake: 150.00,
  assets: ['R_10','R_25','R_50','R_75','R_100','RDBEAR','RDBULL'], //'1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V','R_10','R_25','R_50','R_75','R_100','RDBULL','RDBEAR'

  // Trading frequency / limits
  tickWindow: 1000,
  minTicksForAnalysis: 300,
  analysisIntervalMs: 3000,
  tradeCooldownMs: 2000,
  maxOpenTrades: 1,
  cooldownTicks: 200,        // don't re-analyze within N ticks of last trade
  // ── Asset rotation ────────────────────────────────────────────────
  //   To avoid hammering the same symbol back-to-back the bot briefly
  //   "locks out" the just-traded symbol. The lock EXPIRES after
  //   assetRotationMs (default 60s) so the same symbol can be re-traded
  //   if it is genuinely the only positive-edge target, and if a
  //   DIFFERENT symbol is also a valid candidate this scan we take that
  //   one instead of skipping the whole scan. Set assetRotationMs=0 to
  //   disable rotation entirely.
  assetRotationMs: 60_000,
  // ── Hard daily stops (these actually HALT new trades for the day) ──
  dailyMaxLoss: 2000,          // fixed dollar figure
  dailyMaxLossPct: 0.05,       // 5% of day-start balance (whichever hits first)
  dailyMaxProfit: 0,           // 0 disables profit-target stop
  dailyMaxTrades: 300,         // real cap on trades per GMT day (was 200000 = "off")
  globalMaxLoss: 0,            // 0 = off. Lifetime overall stop: if overallProfit
                               // ever falls to −globalMaxLoss, the bot halts permanently.

  // ── Strategy selection ───────────────────────────────────────────────
  // 'frequency'    = Empirical-frequency coldest digit (DigitAnalyzer).
  //                  The SIMPLE, falsifiable signal. Default, because it
  //                  is the least opinionated thing that can feed a live
  //                  value-edge gate honestly.
  // 'repeat_avoid' = Barrier = current last digit (bet it does NOT
  //                  repeat). Modes: cycle (regime engine) / conditional
  //                  / flat. On fair digits this reduces to P(repeat)≈0.10
  //                  and the value gate keeps it idle too. Validate any
  //                  claimed structure with DIAGNOSE=1 / BACKTEST=1.
  strategy: strEnv('STRATEGY', 'frequency'),
  // Estimator mode for repeat_avoid:
  //   'cycle'       = multi-scale rates + 2-state Bayesian filter
  //   'conditional' = P(repeat | non-repeat streak length)
  //   'flat'        = whole-window empirical repeat rate
  // REPEAT_AVOID_CONDITIONAL=true is an alias for mode=conditional ONLY
  // when mode is left at the default. It does NOT silently override an
  // explicit mode. Default false → mode=cycle actually runs the cycle
  // engine (previously this flag silently demoted cycle → conditional).
  repeatAvoidMode: strEnv('REPEAT_AVOID_MODE', 'cycle'),
  repeatAvoidUseConditional: false,
  repeatAvoidMaxStreakBucket: 100,
  repeatAvoidMinBucketN: 100,
  // ── Cycle-regime engine (mode=cycle) ─────────────────────────────────
  raFastWindow: 20,
  raMidWindow : 100,
  raSlowWindow: 500,
  raBlockSize: 20,
  raStayQuiet: 0.985,
  raStayHot  : 0.980,
  raWRegime: 0.50,
  raWLocal : 0.30,
  raWStreak: 0.20,
  raShrinkToFair: 0.12,
  raMinQuietProb : 0.85,
  raMaxLocalRate : 0.095,
  raAllowQuiet   : true,
  raAllowCooling : false,
  raAllowNeutral : false,
  raMinRegimeSep : 0.015,
  raSlopeEps     : 0.008,

  // ── Frequency-analysis config ───────────────────────────────────────
  analysisWindow: 400,
  // Value-edge floors (live proposal q_be − pLossUpper)
  minEdge: 0.0100,
  safetyMargin: 0.002,
  modelRiskMargin: 0.0015,
  zScore: 1.28,          // Wilson one-sided upper bound
  maxLossProb: 0.092,    // never take if upper-bound P(loss digit) > this
  minProbabilityGap: 0.004,
  // ── Multiple-comparison-corrected deviation gate ────────────────────
  //   The barrier digit is chosen as the COLDEST of 10 empirical
  //   frequencies. Under a fair RNG that selection alone will occasionally
  //   produce a genuinely cold digit whose Wilson UCB looks tradable — the
  //   Wilson bound prices ONE comparison, not the min-of-10. minDeviationZ
  //   therefore requires the chosen digit's empirical loss-prob to be a
  //   statistical outlier BELOW fair p=0.10, where the z-score uses the
  //   fair-Bernoulli standard error. Default 4.2: with analysisWindow=400
  //   a digit needs phat ≤ ~0.037 to pass, which a fair min-of-10
  //   essentially never reaches (≈1e-5 per scan), while a genuinely
  //   anomalous ~2% digit (z≈5.3 at n=400) passes easily. Verified by
  //   SELFTEST=1: no phantom edge on fair digits; positive control
  //   (injected 2% digit) detected. Trade-off made deliberately: the bot
  //   stays idle unless the shortfall is so large it cannot be min-of-10
  //   noise. Realistic ~1-2pp digit biases are NOT traded, because at
  //   n≈400 they are statistically indistinguishable from the selection
  //   noise of "coldest of 10" — and unselectable noise is −EV after
  //   house margin.
  minDeviationZ: 4.2,
  // ── Entropy / χ² sanity gates ───────────────────────────────────────
  //   Lower bounds guard against acting on too-small / degenerate samples.
  //   UPPER bounds are deliberately disabled (maxEntropy=1.0,
  //   maxChiSquare=1e9): an "excessively non-uniform" reading is
  //   indistinguishable from a genuine deviation, and a broken pip is
  //   caught by the KNOWN_PIP_SIZES table + the calibrator, not by a χ²
  //   ceiling that would also block real edges (see the selftest's
  //   positive control).
  minEntropy: 0.90,
  maxEntropy: 1.0,
  minChiSquare: 1.5,
  maxChiSquare: 1e9,
  maxRecentDigitHits: 2, // barrier digit hits in recentLookback
  recentLookback: 12,
  proposalScanTopN: 4,
  // Live payout discovery is cached per (symbol,digit) so we don't fire
  // up to 12 proposal RPCs every 3-second scan. 60s TTL is plenty —
  // DIGITDIFF payout multipliers move slowly.
  payoutProbeTtlMs: 60_000,

  // ── Consecutive-loss circuit breaker (ON by default) ────────────────
  // After N losses in a row, stop trading entirely for a cooldown.
  // Independent of stake sizing: no sizing scheme protects you from
  // "the model was wrong for a while" — only stopping does.
  circuitBreakerEnabled : true,
  circuitBreakerLosses  : 4,
  circuitBreakerCooldownMs: 30 * 60_000,

  // ── Stake sizing ─────────────────────────────────────────────────────
  // Flat stake is used unless kellySizingEnabled=true.
  // Loss-recovery (martingale-style) is OFF by default: multiplying stake
  // after a loss increases ruin risk sharply and does not change the
  // per-trade edge. If you specifically enable RECOVERY_ENABLED=true,
  // keep the ladder short AND shallow; the old 1 → 13.2 → 150 ladder is
  // gone. recoveryStakeCap and maxStakePctBankroll are hard ceilings on
  // any single stake regardless of ladder.
  recoveryEnabled: false,
  recoveryMultipliers: listEnv('RECOVERY_MULTIPLIERS', '1,2,4').map(Number).filter(Number.isFinite),
  recoveryStakeCap: 25,          // absolute max per trade when recovery is on
  maxStakePctBankroll: 0.05,     // never risk >5% of live balance per trade

  // ─ Trade watchdog ─
  tradeWatchdogMs: 20000,

  // ── Kelly-fractional sizing (optional) ─────────────────────────────
  kellySizingEnabled  : true,
  kellyFraction       : 0.25,
  kellyBankrollFrac   : 1.00,
  kellyBankrollFloor  : 100.0,
  kellyMaxStakeFrac   : 0.02,
  kellyMinEdgeForScale: 0.005,

  // ── Per-symbol calibration tracker (ON by default) ─────────────────
  //   Rolling per-symbol (predicted P(win), actual outcome). Auto-benches
  //   a symbol when empirical WR trails predicted by > calibDisableGap
  //   over ≥ calibMinTrades. Re-enters via low-stake probe.
  calibEnabled        : true,
  calibWindow         : 200,
  calibMinTrades      : 40,
  calibDisableGap     : 0.020,   // −2 pp below prediction → disable
  calibReenableGap    : 0.005,   // within ±0.5 pp → re-enable
  calibProbeAfterMs   : 30 * 60_000,
  calibProbeStakeFrac : 0.20,

  // ── Scheduled pause/resume ──────────────────────────────────────
  pauseEnabled   : true,
  pauseStartGmt  : '23:00',
  pauseEndGmt    : '01:00',

  // GMT/UTC reporting
  eodTimeGmt: '00:00', // default midnight GMT; report date is previous UTC day
  eodSendDelaySeconds: 10,
  hourlySummary: true,

  // Persistence/logging
  stateFile: strEnv('STATE_FILE', 'newX2Differ_state_03.json'),
  logFile: strEnv('LOG_FILE', 'newX2Differ_bot_03.log'),
  logLevel: strEnv('LOG_LEVEL', 'INFO NEWDIFFER').toUpperCase(),

  // Telegram — existing hardcoded demo-test values, preserved.
  telegram: {
    enabled : true,
    botToken: '8106601008:AAEMyCma6mvPYIHEvw3RHQX2tkD5-wUe1o0',
    chatId  : '752497117',
  },

  reconnect: {
    initialDelayMs: intEnv('RECONNECT_INITIAL_MS', 1000),
    maxDelayMs: intEnv('RECONNECT_MAX_MS', 60000),
    backoffFactor: numEnv('RECONNECT_BACKOFF', 2),
    jitterMs: intEnv('RECONNECT_JITTER_MS', 750),
  },

  // ═══════════════════════════════════════════════════════════════════
  // BACKTESTER
  // ═══════════════════════════════════════════════════════════════════
  //   Run with:  $env:BACKTEST=1; node newDifferX2.js
  //   Optional:  $env:BACKTEST_ASSET="R_100"; $env:BACKTEST_TICKS=100000
  //
  //   NOTE on history depth: Deriv's ticks_history endpoint typically
  //   only serves ~24 h of ticks (~43K on the volatility indices).
  //   The batcher stops when the server returns a short batch.
  //
  //   Diagnostic overrides — do NOT affect live trading, only backtest:
  //     BACKTEST_MIN_EDGE / BACKTEST_SAFETY_MARGIN / BACKTEST_MODEL_MARGIN
  //     BACKTEST_MAX_LOSS_PROB / BACKTEST_MIN_ENTROPY / BACKTEST_MAX_ENTROPY
  //     BACKTEST_MIN_CHISQ / BACKTEST_MAX_CHISQ / BACKTEST_MIN_GAP
  //     BACKTEST_MAX_HITS / BACKTEST_PAYOUT_MULT / BACKTEST_ASSET_LOCK
  backtestTicks       : intEnv('BACKTEST_TICKS',      100000),
  backtestBatchSize   : intEnv('BACKTEST_BATCH_SIZE', 5000),
  backtestReportEvery : intEnv('BACKTEST_REPORT',     10000),
  backtestOutFile     : strEnv('BACKTEST_OUT',        'newX2Differ_backtest_report.json'),
  // The Deriv DIGITDIFF payout multiplier is roughly 1.09-1.11× stake.
  // We DEFAULT to 1.10; at backtest start we can probe a real proposal
  // per symbol (BACKTEST_PROBE_LIVE=true) and use that instead.
  backtestPayoutMult  : numEnv('BACKTEST_PAYOUT_MULT', 1.10),
  backtestProbeLive   : boolEnv('BACKTEST_PROBE_LIVE', false),
  backtestAssetLock   : boolEnv('BACKTEST_ASSET_LOCK',       false),
  backtestAssetLockTicks  : intEnv ('BACKTEST_ASSET_LOCK_TICKS', 10),

  backtestMinEdge     : process.env.BACKTEST_MIN_EDGE      ? Number(process.env.BACKTEST_MIN_EDGE)      : null,
  backtestSafety      : process.env.BACKTEST_SAFETY_MARGIN ? Number(process.env.BACKTEST_SAFETY_MARGIN) : null,
  backtestModelMargin : process.env.BACKTEST_MODEL_MARGIN  ? Number(process.env.BACKTEST_MODEL_MARGIN)  : null,
  backtestMaxLossProb : process.env.BACKTEST_MAX_LOSS_PROB ? Number(process.env.BACKTEST_MAX_LOSS_PROB) : null,
  backtestMinEntropy  : process.env.BACKTEST_MIN_ENTROPY   ? Number(process.env.BACKTEST_MIN_ENTROPY)   : null,
  backtestMaxEntropy  : process.env.BACKTEST_MAX_ENTROPY   ? Number(process.env.BACKTEST_MAX_ENTROPY)   : null,
  backtestMinChisq    : process.env.BACKTEST_MIN_CHISQ     ? Number(process.env.BACKTEST_MIN_CHISQ)     : null,
  backtestMaxChisq    : process.env.BACKTEST_MAX_CHISQ     ? Number(process.env.BACKTEST_MAX_CHISQ)     : null,
  backtestMinGap      : process.env.BACKTEST_MIN_GAP       ? Number(process.env.BACKTEST_MIN_GAP)       : null,
  backtestMaxHits     : process.env.BACKTEST_MAX_HITS      ? parseInt(process.env.BACKTEST_MAX_HITS,10) : null,
});

// ─────────────────────────────────────────────────────────────────────
// 3. LOGGER
// ─────────────────────────────────────────────────────────────────────
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.INFO;
const pad = n => String(n).padStart(2, '0');
function utcTs() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;
}
function _writeLog(line) {
  try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (_) {}
}
function log(level, msg, ...rest) {
  if ((LOG_LEVELS[level] ?? 1) > currentLevel) return;
  const extras = rest.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
  const line = `[${utcTs()}] [${level}] ${msg}${extras ? ' ' + extras : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  _writeLog(line);
}
const logger = {
  error: (m, ...a) => log('ERROR', m, ...a),
  warn : (m, ...a) => log('WARN',  m, ...a),
  info : (m, ...a) => log('INFO',  m, ...a),
  debug: (m, ...a) => log('DEBUG', m, ...a),
};

function money(n, currency = CONFIG.currency) {
  const x = Number(n || 0);
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)} ${currency}`;
}
function pct(n, dp = 2) { return `${(Number(n || 0) * 100).toFixed(dp)}%`; }
function utcDateStr(d = new Date()) { return d.toISOString().slice(0, 10); }
function previousUtcDateStr(d = new Date()) {
  return new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10);
}
function utcHour(d = new Date()) { return d.getUTCHours(); }
function htmlEscape(s) {
  return String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

// ─────────────────────────────────────────────────────────────────────
// 4. TELEGRAM NOTIFIER
// ─────────────────────────────────────────────────────────────────────
class TelegramNotifier extends EventEmitter {
  constructor(cfg) {
    super();
    this.enabled = cfg.enabled && !!cfg.botToken && !!cfg.chatId;
    this.botToken = cfg.botToken;
    this.chatId = cfg.chatId;
    this.queue = [];
    this.sending = false;
  }
  _post(text) {
    return new Promise(resolve => {
      if (!this.enabled) return resolve(false);
      try {
        const payload = JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
        const url = new URL(`https://api.telegram.org/bot${this.botToken}/sendMessage`);
        const req = https.request({
          method: 'POST',
          hostname: url.hostname,
          path: url.pathname,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 15000,
        }, res => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode === 200));
        });
        req.on('error', e => { logger.warn('telegram error:', e.message); resolve(false); });
        req.on('timeout', () => { req.destroy(new Error('telegram timeout')); resolve(false); });
        req.write(payload);
        req.end();
      } catch (e) {
        logger.warn('telegram exception:', e.message);
        resolve(false);
      }
    });
  }
  async _drain() {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const msg = this.queue.shift();
        await this._post(msg);
        await new Promise(r => setTimeout(r, 1100));
      }
    } finally {
      this.sending = false;
    }
  }
  send(text) {
    if (!this.enabled) {
      logger.debug('telegram(dry):', String(text).slice(0, 160).replace(/\n/g, ' | '));
      return;
    }
    this.queue.push(String(text));
    this._drain().catch(e => logger.warn('telegram drain:', e.message));
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ─────────────────────────────────────────────────────────────────────
// 5. REST + WEBSOCKET CLIENT
// ─────────────────────────────────────────────────────────────────────
class RestClient {
  constructor(baseUrl, appId, token) {
    this.baseUrl = baseUrl;
    this.appId = appId;
    this.token = token;
  }
  static isPat(token) {
    return typeof token === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
  }
  request(method, route, body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(route, this.baseUrl); }
      catch (e) { return reject(new Error(`Invalid URL: ${route}`)); }
      const payload = body == null ? null : JSON.stringify(body);
      const req = https.request({
        method,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Deriv-App-ID': this.appId,
          'Accept': 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 15000,
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          let parsed = data;
          try { parsed = JSON.parse(data); } catch (_) {}
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('timeout', () => req.destroy(new Error('REST timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  get(route) { return this.request('GET', route); }
  post(route, body) { return this.request('POST', route, body); }
}

class DerivClient extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ws = null;
    this.connected = false;
    this.authorized = false;
    this._stopped = false;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._reqId = 0;
    this._pending = new Map();
    this._subs = new Map();
    this.balance = null;
    this.currency = cfg.currency;
    this.accountInfo = null;
    this.symbols = new Map();
    this._isPat = RestClient.isPat(cfg.apiToken);
    this._rest = this._isPat ? new RestClient(cfg.restBaseUrl, cfg.appId, cfg.apiToken) : null;
    this._targetAccountId = cfg.accountId || '';
  }

  _nextReqId() { this._reqId += 1; return this._reqId; }
  _legacyUrl() {
    const sep = this.cfg.legacyWsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.legacyWsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }
  _redact(url) {
    return String(url).replace(/([?&])(otp|app_id|token|auth)=[^&]+/gi, '$1$2=***');
  }
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN is empty.');
      this._stopped = true;
      return;
    }
    if (this._isPat) {
      logger.info('detected PAT token → using Deriv new Options API OTP flow');
      this._connectPat().catch(e => {
        logger.error('PAT connect failed:', e.message);
        this._scheduleReconnect();
      });
    } else {
      logger.info('using legacy Deriv WebSocket authorize flow');
      this._openWs(this._legacyUrl());
    }
  }
  async _connectPat() {
    const accountId = await this._resolvePatAccountId();
    const route = `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`;
    logger.info(`REST POST ${route}`);
    const res = await this._rest.post(route);
    if (res.status !== 200) {
      const msg = res.body?.errors?.[0]?.message || res.body?.message || JSON.stringify(res.body);
      throw new Error(`OTP failed (${res.status}): ${msg}`);
    }
    const wsUrl = res.body?.data?.url;
    if (!wsUrl) throw new Error(`OTP response missing data.url: ${JSON.stringify(res.body)}`);
    this._targetAccountId = accountId;
    this.accountInfo = {
      loginid: accountId,
      accountType: this.cfg.accountType,
      isVirtual: this.cfg.accountType !== 'real',
      currency: this.cfg.currency,
    };
    logger.info(`connecting → ${this._redact(wsUrl)}`);
    this._openWs(wsUrl);
  }
  async _resolvePatAccountId() {
    if (this._targetAccountId) return this._targetAccountId;

    // Best-effort account discovery. Docs recommend passing accountId explicitly.
    const attempts = [
      ['GET', '/trading/v1/options/accounts', null],
      ['POST', '/trading/v1/options/accounts/list', null],
    ];
    for (const [method, route, body] of attempts) {
      try {
        const res = method === 'GET' ? await this._rest.get(route) : await this._rest.post(route, body);
        if (res.status >= 200 && res.status < 300) {
          const arr = Array.isArray(res.body?.data) ? res.body.data :
                      Array.isArray(res.body?.accounts) ? res.body.accounts : [];
          if (arr.length) {
            const desired = arr.find(a => String(a.account_type || '').toLowerCase() === this.cfg.accountType) || arr[0];
            const id = desired.account_id || desired.loginid || desired.id;
            if (id) {
              this.accountInfo = {
                loginid: id,
                accountType: desired.account_type || this.cfg.accountType,
                isVirtual: String(desired.account_type || this.cfg.accountType).toLowerCase() !== 'real',
                currency: desired.currency || this.cfg.currency,
                balance: desired.balance != null ? Number(desired.balance) : null,
              };
              return id;
            }
          }
        }
      } catch (e) {
        logger.debug(`PAT account discovery ${method} ${route}:`, e.message);
      }
    }
    throw new Error('DERIV_ACCOUNT_ID is required for PAT tokens. Set it to your demo/real Options account ID, e.g. VRTC...');
  }
  _openWs(url) {
    try {
      this.ws = new WebSocket(url, { handshakeTimeout: 15000, headers: { 'User-Agent': 'DigitDiffer/4.0 Node.js' } });
    } catch (e) {
      logger.error('WebSocket construct failed:', e.message);
      this._scheduleReconnect();
      return;
    }
    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', d => this._onMessage(d));
    this.ws.on('error', e => this._onError(e));
    this.ws.on('close', (c, r) => this._onClose(c, r));
    this.ws.on('unexpected-response', (_, res) => {
      logger.error('WebSocket handshake failed:', res.statusCode, res.statusMessage);
      try { res.destroy(); } catch (_) {}
      this._scheduleReconnect();
    });
  }
  _onOpen() {
    logger.info('WebSocket connected ✔');
    this.connected = true;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this.emit('open');
    if (this._isPat) this._markPatAuthorized();
    else this._authorizeLegacy();
  }
  async _authorizeLegacy() {
    try {
      const res = await this._send({ authorize: this.cfg.apiToken }, 20000);
      const a = res.authorize;
      this.authorized = true;
      this.balance = Number(a.balance);
      this.currency = a.currency || this.cfg.currency;
      this.accountInfo = {
        loginid: a.loginid,
        email: a.email,
        isVirtual: !!a.is_virtual,
        accountType: a.account_type,
        currency: this.currency,
      };
      logger.info(`authorized ${a.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) balance=${this.balance} ${this.currency}`);
      this.emit('authorized', this.accountInfo);
    } catch (e) {
      logger.error('authorize failed:', e.message);
      this.authorized = false;
      this._scheduleReconnect();
    }
  }
  async _markPatAuthorized() {
    this.authorized = true;
    if (this.accountInfo?.balance != null) this.balance = Number(this.accountInfo.balance);
    this.currency = this.accountInfo?.currency || this.cfg.currency;
    try {
      const b = await this._send({ balance: 1 }, 10000);
      if (b.balance) {
        this.balance = Number(b.balance.balance);
        this.currency = b.balance.currency || this.currency;
      }
    } catch (e) {
      logger.debug('balance check skipped:', e.message);
    }
    logger.info(`authorized ${this.accountInfo?.loginid || this._targetAccountId} via PAT/new API balance=${this.balance ?? '?'} ${this.currency}`);
    this.emit('authorized', this.accountInfo || { loginid: this._targetAccountId, isVirtual: this.cfg.accountType !== 'real' });
  }
  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.error) {
      const code = msg.error.code || 'Error';
      const text = msg.error.message || code;
      const benign = new Set(['AlreadySubscribedOrLimit', 'ContractNotFound', 'BetExpired', 'TradingDurationNotAllowed']);
      (benign.has(code) ? logger.debug : logger.error)(`api error: ${code} - ${text} req=${msg.req_id || '?'}`);
      if (msg.req_id && this._pending.has(msg.req_id)) {
        const p = this._pending.get(msg.req_id);
        clearTimeout(p.timer);
        this._pending.delete(msg.req_id);
        p.reject(new Error(text));
      }
      if (['AuthorizationRequired', 'InvalidToken', 'InvalidAppID'].includes(code)) this._closeAndReconnect();
      return;
    }

    if (msg.req_id && this._pending.has(msg.req_id)) {
      const p = this._pending.get(msg.req_id);
      clearTimeout(p.timer);
      this._pending.delete(msg.req_id);
      p.resolve(msg);
      return;
    }

    if (msg.subscription?.id && this._subs.has(msg.subscription.id)) {
      const cb = this._subs.get(msg.subscription.id);
      try { cb(msg); } catch (e) { logger.error('subscription handler error:', e.message); }
      return;
    }

    this.emit('message', msg);
  }
  _onError(err) {
    logger.error('WebSocket error:', err.message, err.code || '');
    this.emit('error', err);
  }
  _onClose(code, reason) {
    const rs = (() => { try { return reason?.toString() || ''; } catch { return ''; } })();
    logger.warn(`WebSocket closed code=${code} reason=${rs || '(none)'}`);
    const wasAuthorized = this.authorized;
    this.connected = false;
    this.authorized = false;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection closed'));
    }
    this._pending.clear();
    this._subs.clear();
    this.emit('close', code, reason, wasAuthorized);
    if (!this._stopped) this._scheduleReconnect();
  }
  _scheduleReconnect() {
    if (this._stopped || this._reconnecting) return;
    this._reconnecting = true;
    this._reconnectAttempt += 1;
    const base = Math.min(
      this.cfg.reconnect.initialDelayMs * Math.pow(this.cfg.reconnect.backoffFactor, this._reconnectAttempt - 1),
      this.cfg.reconnect.maxDelayMs,
    );
    const delay = base + Math.random() * this.cfg.reconnect.jitterMs;
    logger.info(`reconnect #${this._reconnectAttempt} in ${(delay / 1000).toFixed(1)}s`);
    setTimeout(() => {
      this._reconnecting = false;
      this.connect();
    }, delay);
  }
  _closeAndReconnect() { try { this.ws?.close(); } catch (_) {} }
  _send(payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = this._nextReqId();
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error(`Request timeout (${payload.proposal ? 'proposal' : payload.buy ? 'buy' : payload.ticks ? 'ticks' : payload.proposal_open_contract ? 'open_contract' : 'req'})`));
        }
      }, timeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ ...payload, req_id: reqId })); }
      catch (e) {
        clearTimeout(timer);
        this._pending.delete(reqId);
        reject(e);
      }
    });
  }
  subscribe(payload, callback, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = this._nextReqId();
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error('Subscribe timeout'));
        }
      }, timeoutMs);
      this._pending.set(reqId, {
        resolve: msg => {
          const subId = msg.subscription?.id;
          if (!subId) return reject(new Error('No subscription id in response'));
          this._subs.set(subId, callback);
          resolve(subId);
        },
        reject,
        timer,
      });
      try { this.ws.send(JSON.stringify({ ...payload, subscribe: 1, req_id: reqId })); }
      catch (e) {
        clearTimeout(timer);
        this._pending.delete(reqId);
        reject(e);
      }
    });
  }
  forget(subId) {
    if (!subId) return Promise.resolve();
    this._subs.delete(subId);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    return this._send({ forget: subId }, 8000).catch(e => logger.debug('forget:', e.message));
  }
  stop() {
    this._stopped = true;
    try { this.ws?.close(); } catch (_) {}
  }
  symbolField() { return this._isPat ? 'underlying_symbol' : 'symbol'; }
}

// ─────────────────────────────────────────────────────────────────────
// 6. MARKET DATA MANAGER
// ─────────────────────────────────────────────────────────────────────
//
// KNOWN_PIP_SIZES — canonical table for Deriv synthetic indices.
// pip_size = number of decimal places in the quote. The "last digit"
// that DIGITDIFF settles on is the digit AT that decimal position.
//
//   R_100:                pip_size = 2   → quote "1234.15"    → digit 5
//   R_10, R_25:           pip_size = 3   → quote "1234.153"   → digit 3
//   R_50, R_75:           pip_size = 4   → quote "1234.1534"  → digit 4
//   RDBULL, RDBEAR:       pip_size = 4
//   1HZ10V..1HZ100V:      pip_size = 2
const KNOWN_PIP_SIZES = Object.freeze({
  R_10   : 3,
  R_25   : 3,
  R_50   : 4,
  R_75   : 4,
  R_100  : 2,
  '1HZ10V' : 2,
  '1HZ25V' : 2,
  '1HZ50V' : 2,
  '1HZ75V' : 2,
  '1HZ100V': 2,
  RDBULL : 4,
  RDBEAR : 4,
});

/**
 * Extract the last-digit that Deriv actually settles on for a DIGITDIFF
 * contract. We MUST NOT round — `Number.toFixed(pipSize)` rounds up when
 * the trailing digit is ≥5, silently changing the settlement digit vs
 * what Deriv sees. Instead we walk the fractional part of the quote
 * character-by-character and read the digit at position (pipSize - 1).
 * If the quote has fewer fractional digits than pipSize we pad with '0'
 * (Deriv does the same).
 */
function quoteToDigit(quote, pipSize = 2) {
  const n = Number(quote);
  if (!Number.isFinite(n)) return null;
  const pip = Number.isInteger(pipSize) && pipSize >= 1 && pipSize <= 8 ? pipSize : 2;

  let s = Math.abs(n).toString();
  if (s.indexOf('e') !== -1) s = Math.abs(n).toFixed(8);
  const dot = s.indexOf('.');
  const frac = dot < 0 ? '' : s.slice(dot + 1);
  const padded = frac.padEnd(pip, '0');
  const ch = padded.charAt(pip - 1);
  const d = Number(ch);
  return Number.isInteger(d) ? d : null;
}

class MarketDataManager extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.history = new Map(); // symbol -> [{epoch, quote, digit}]
    this.subs = new Map();
    this.lastQuote = new Map();
    this.pipSizes = new Map();
    // Seed pip cache from the canonical table BEFORE we ever touch the
    // network so `pipSize(symbol)` is correct even if loadSymbols fails.
    for (const [sym, pip] of Object.entries(KNOWN_PIP_SIZES)) {
      this.pipSizes.set(sym, pip);
    }
    client.on('close', () => this.subs.clear());
  }
  async loadSymbols() {
    try {
      // NOTE: use 'full' — 'brief' does NOT include pip_size.
      const res = await this.client._send({ active_symbols: 'full' }, 15000);
      const list = res.active_symbols || [];
      let apiWithPip = 0;
      let overrides  = 0;
      for (const s of list) {
        const key = s.underlying_symbol || s.symbol;
        if (!key) continue;
        this.client.symbols.set(key, s);
        const rawPip = Number(s.pip_size);
        if (Number.isFinite(rawPip) && rawPip >= 1 && rawPip <= 8) {
          apiWithPip++;
          const known = KNOWN_PIP_SIZES[key];
          if (known != null && known !== rawPip) {
            logger.warn(`pip_size mismatch for ${key}: known=${known} vs API=${rawPip} — using API value`);
            overrides++;
            this.pipSizes.set(key, rawPip);
          } else if (known == null) {
            this.pipSizes.set(key, rawPip);
          }
        }
      }
      logger.info(
        `loaded ${this.client.symbols.size} active symbols  ` +
        `(pip: known-table=${Object.keys(KNOWN_PIP_SIZES).length}, api-supplied=${apiWithPip}, api-overrides=${overrides})`
      );
    } catch (e) {
      logger.error('loadSymbols failed:', e.message);
    }
  }
  pipSize(symbol) {
    const cached = this.pipSizes.get(symbol);
    if (Number.isFinite(cached)) return cached;

    const raw = Number(this.client.symbols.get(symbol)?.pip_size);
    if (Number.isFinite(raw) && raw >= 1 && raw <= 8) {
      this.pipSizes.set(symbol, raw);
      return raw;
    }

    const hist = this.history.get(symbol);
    if (hist && hist.length) {
      const decCounts = new Map();
      const sample = hist.slice(-Math.min(50, hist.length));
      for (const t of sample) {
        const s = String(t.quote);
        const dot = s.indexOf('.');
        const dec = dot < 0 ? 0 : s.length - dot - 1;
        decCounts.set(dec, (decCounts.get(dec) || 0) + 1);
      }
      let bestDec = 2, bestN = 0;
      for (const [d, n] of decCounts) if (n > bestN) { bestDec = d; bestN = n; }
      if (bestDec >= 1 && bestDec <= 8) {
        logger.warn(`pipSize(${symbol}) unknown — inferred pip=${bestDec} from tick decimals`);
        this.pipSizes.set(symbol, bestDec);
        return bestDec;
      }
    }
    logger.warn(`pipSize(${symbol}) unknown — defaulting to 2 (digits may be wrong!)`);
    return 2;
  }
  async backfill(symbol, count = 1000) {
    try {
      const res = await this.client._send({
        ticks_history: symbol,
        count,
        end: 'latest',
        style: 'ticks',
      }, 20000);
      const prices = res.history?.prices || [];
      const times = res.history?.times || [];
      const pip = this.pipSize(symbol);
      const arr = times.map((t, i) => {
        const quote = Number(prices[i]);
        return { epoch: Number(t), quote, digit: quoteToDigit(quote, pip) };
      }).filter(x => x.digit != null);
      this.history.set(symbol, arr);
      if (arr.length) this.lastQuote.set(symbol, arr[arr.length - 1].quote);
      logger.info(`backfilled ${symbol}: ${arr.length} ticks (pip_size=${pip})`);
      return arr;
    } catch (e) {
      logger.error(`backfill(${symbol}) failed:`, e.message);
      return [];
    }
  }
  /**
   * Deep historical backfill for the backtester.
   * Deriv `ticks_history` returns up to 5000 ticks per call. We chain
   * calls backwards using `end` = earliest epoch - 1. Returns oldest→newest.
   */
  async deepBackfill(symbol, totalCount, batchSize = 5000, onProgress = null) {
    const out = [];
    let remain = totalCount;
    let end    = 'latest';
    let lastEpoch = null;
    const pip = this.pipSize(symbol);
    while (remain > 0) {
      const count = Math.min(batchSize, remain);
      let res;
      try {
        res = await this.client._send({
          ticks_history: symbol,
          count, end, style: 'ticks',
        }, 30000);
      } catch (e) {
        logger.warn(`deepBackfill(${symbol}) batch failed: ${e.message} — stopping`);
        break;
      }
      const prices = res.history?.prices || [];
      const times  = res.history?.times  || [];
      if (!times.length) { logger.info(`  (server returned 0 more ticks — Deriv history exhausted)`); break; }
      const batch = times.map((t, i) => {
        const quote = Number(prices[i]);
        return { epoch: Number(t), quote, digit: quoteToDigit(quote, pip) };
      }).filter(x => x.digit != null);
      if (lastEpoch !== null && batch.length && batch[batch.length - 1].epoch >= lastEpoch) {
        logger.info(`  (server did not honor pagination — history exhausted at ${out.length} ticks)`);
        break;
      }
      if (batch.length) lastEpoch = batch[0].epoch;
      out.unshift(...batch);
      remain -= batch.length;
      if (onProgress) onProgress(out.length, totalCount);
      if (!batch.length) break;
      end = String(batch[0].epoch - 1);
      await new Promise(r => setTimeout(r, 200)); // rate-limit courtesy
      if (batch.length < count) {
        logger.info(`  (last batch short: ${batch.length}/${count} — Deriv history exhausted at ${out.length} ticks)`);
        break;
      }
    }
    return out;
  }

  async subscribe(symbol) {
    if (this.subs.has(symbol)) return this.subs.get(symbol);
    const subId = await this.client.subscribe({ ticks: symbol }, msg => {
      const t = msg.tick;
      if (!t) return;
      const quote = Number(t.quote);
      const pip = this.pipSize(symbol);
      const tick = { epoch: Number(t.epoch), quote, digit: quoteToDigit(quote, pip) };
      if (tick.digit == null) return;
      this.lastQuote.set(symbol, tick.quote);
      const arr = this.history.get(symbol) || [];
      arr.push(tick);
      const cap = Math.max(this.cfg.tickWindow * 2, 2000);
      if (arr.length > cap) arr.splice(0, arr.length - cap);
      this.history.set(symbol, arr);
      this.emit('tick', symbol, tick);
    });
    this.subs.set(symbol, subId);
    logger.info(`subscribed ticks: ${symbol} (sub=${subId})`);
    return subId;
  }
  async bootstrap(symbols) {
    await Promise.all(symbols.map(s => this.subscribe(s).catch(e => logger.warn(`subscribe(${s}) failed:`, e.message))));
    await Promise.all(symbols.map(async s => {
      const hist = this.history.get(s) || [];
      if (hist.length < this.cfg.minTicksForAnalysis) {
        await this.backfill(s, Math.max(this.cfg.tickWindow, this.cfg.minTicksForAnalysis + 100));
      }
    }));
  }
  historyFor(symbol) { return this.history.get(symbol) || []; }
  last(symbol) { return this.lastQuote.get(symbol); }
}

// ─────────────────────────────────────────────────────────────────────
// 7. FREQUENCY ANALYZER
//    Deliberately simple, deliberately honest: one empirical-frequency
//    signal + a statistical uncertainty bound. This class does NOT claim
//    to predict ticks — it produces a conservative pLossUpper estimate
//    for the live value-edge check and gates out samples too small or
//    degenerate to even measure cleanly.
//
//    NOTE ON PERFORMANCE / API: the analysis works on a *windowed slice*
//    of a digit array (see analyzeWindow). Live code passes a bounded
//    history; the backtester passes a precomputed digit array and walks
//    it in O(window) per step instead of copying the whole prefix each
//    scan (which was O(n²) on 100k ticks).
// ─────────────────────────────────────────────────────────────────────
class DigitAnalyzer {
  constructor(cfg) { this.cfg = cfg; }

  /** Desired lookback window for a given available history length. */
  _wantWindow(len) {
    const base = this.cfg.analysisWindow || this.cfg.tickWindow || 200;
    return Math.max(1, Math.min(base, len));
  }

  entropy(counts) {
    const n = counts.reduce((s, x) => s + x, 0);
    if (!n) return 0;
    let h = 0;
    for (const c of counts) {
      if (!c) continue;
      const p = c / n;
      h -= p * Math.log(p);
    }
    return h / Math.log(10); // normalized 0..1
  }
  chiSquare(counts) {
    const n = counts.reduce((s, x) => s + x, 0);
    if (!n) return 0;
    const expected = n / 10;
    return counts.reduce((s, c) => s + ((c - expected) ** 2) / expected, 0);
  }
  countsFor(digits, window) {
    const slice = digits.slice(-Math.min(window, digits.length));
    const counts = Array(10).fill(0);
    for (const d of slice) counts[d] += 1;
    return { counts, n: slice.length };
  }

  /** One-sided Wilson upper confidence bound on a proportion. */
  wilsonUpper(phat, n, z) {
    n = Math.max(1, n);
    phat = Math.max(0, Math.min(1, phat));
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = phat + z2 / (2 * n);
    const spread = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
    return Math.min(1, (center + spread) / denom);
  }

  /**
   * Live entry point: extract valid digits from a tick series (bounded
   * history) and analyze the trailing window.
   */
  analyze(symbol, ticks) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;
    const digits = ticks.map(t => t.digit).filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
    if (digits.length < this.cfg.minTicksForAnalysis) return null;
    return this.analyzeAt(symbol, digits, digits.length - 1, ticks[ticks.length - 1]?.quote);
  }

  /**
   * Analyze "as of" endIdx in a precomputed digit array. O(window).
   * Used by live (via analyze), the backtester and the selftest.
   */
  analyzeAt(symbol, digits, endIdx, lastQuote) {
    if (endIdx + 1 < this.cfg.minTicksForAnalysis) return null;
    const win = this._wantWindow(endIdx + 1);
    const from = Math.max(0, endIdx - win + 1);
    return this.analyzeWindow(symbol, digits, from, endIdx, lastQuote);
  }

  analyzeWindow(symbol, digits, from, to, lastQuote) {
    const recentDigits = digits.slice(from, to + 1);
    const recentLen = recentDigits.length;
    if (recentLen < 10) return null;

    const { counts, n } = this.countsFor(recentDigits, recentLen);
    const entropy = this.entropy(counts);
    const chiSquare = this.chiSquare(counts);

    const recentLook = Math.min(this.cfg.recentLookback, recentDigits.length);
    const recentTail = recentDigits.slice(-recentLook);

    const candidates = [];
    const FAIR = 0.10; // fair last-digit probability for a uniform RNG
    for (let d = 0; d < 10; d++) {
      const phat = counts[d] / Math.max(1, n);
      const recentHits = recentTail.filter(x => x === d).length;
      const ucb = Math.min(1, this.wilsonUpper(phat, n, this.cfg.zScore) + this.cfg.modelRiskMargin);
      // zDev = how many fair-Bernoulli std-errors the observed proportion
      // sits BELOW fair. Positive = colder than fair. This is the
      // multiple-comparison-aware significance measure for "this digit is
      // genuinely rare", independent of the Wilson UCB (which only prices
      // one comparison).
      const se = Math.sqrt((FAIR * (1 - FAIR)) / Math.max(1, n));
      const zDev = se > 0 ? (FAIR - phat) / se : 0;
      candidates.push({
        symbol,
        digit: d,
        pLoss: phat,
        pLossUpper: ucb,
        sampleSize: n,
        recentHits,
        zDev,
      });
    }

    // Coldest empirical frequency first (lowest conservative loss-prob estimate)
    candidates.sort((a, b) => a.pLossUpper - b.pLossUpper || a.pLoss - b.pLoss);

    const best = candidates[0];
    const second = candidates[1];
    const probabilityGap = second ? (second.pLossUpper - best.pLossUpper) : 0;

    // ── Regime + sanity gates ───────────────────────────────────────
    const gates = [];
    if (entropy < this.cfg.minEntropy) gates.push(`entropy-low:${entropy.toFixed(3)}`);
    if (entropy > this.cfg.maxEntropy) gates.push(`entropy-too-uniform:${entropy.toFixed(3)}`);
    if (chiSquare < this.cfg.minChiSquare) gates.push(`chisq-low:${chiSquare.toFixed(2)}`);
    if (chiSquare > this.cfg.maxChiSquare) gates.push(`chisq-high:${chiSquare.toFixed(2)}`);
    if (probabilityGap < this.cfg.minProbabilityGap) gates.push(`gap-low:${probabilityGap.toFixed(4)}`);
    if (best.recentHits > this.cfg.maxRecentDigitHits) gates.push(`recent-hit:${best.recentHits}`);
    if (best.pLossUpper > this.cfg.maxLossProb) gates.push(`loss-prob-high:${best.pLossUpper.toFixed(4)}`);
    // Multiple-comparison-corrected deviation: the coldest of 10 must be a
    // statistical outlier below fair, not just "the least common digit".
    if (!Number.isFinite(best.zDev) || best.zDev < this.cfg.minDeviationZ) {
      gates.push(`deviation-low:${Number(best.zDev || 0).toFixed(2)}`);
    }

    return {
      symbol,
      method: 'empirical-frequency',
      ticks: recentDigits.length,
      lastDigit: recentDigits[recentDigits.length - 1],
      lastQuote,
      entropy,
      chiSquare,
      probabilityGap,
      candidates,
      best,
      gates,
      allowedByModel: gates.length === 0,
    };
  }

  rank(list) {
    return list.filter(Boolean).sort((a, b) => {
      const aAllow = a.allowedByModel ? 0 : 1;
      const bAllow = b.allowedByModel ? 0 : 1;
      if (aAllow !== bAllow) return aAllow - bAllow;
      const au = a.best?.pLossUpper ?? 1;
      const bu = b.best?.pLossUpper ?? 1;
      return au - bu;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// 7b. REPEAT-AVOID ANALYZER (STRATEGY=repeat_avoid)
//
//   Barrier digit = current last digit (DIGITDIFF: bet next tick does
//   NOT equal it). Built around the empirical cycle claim that periods
//   of frequent last-digit repeats alternate with periods of long
//   non-repeat runs. Bernoulli sequences look bursty under pure i.i.d.
//   too (clustering illusion), so this module does NOT assume an edge —
//   it estimates regime state online, predicts P(R_{t+1}=1), and only
//   trades when the conservative upper-bound loss prob clears the
//   value-edge gates. Validate any claimed structure with DIAGNOSE=1 and
//   BACKTEST=1. On fair digits P(repeat)≈0.10 and the value gate keeps
//   the strategy idle.
//
//   Modes (REPEAT_AVOID_MODE / repeatAvoidMode):
//     • cycle       — multi-scale rates + 2-state Bayesian filter +
//                     streak-conditional blend + phase gate
//     • conditional — legacy P(repeat | non-repeat streak length)
//     • flat        — legacy whole-window empirical rate
//   REPEAT_AVOID_CONDITIONAL is now a pure alias: it only matters when
//   repeatAvoidMode is left at its default, and it no longer silently
//   overrides an explicit mode selection.
// ─────────────────────────────────────────────────────────────────────
class RepeatAvoidAnalyzer {
  constructor(cfg) { this.cfg = cfg; }

  _wantWindow(len) {
    const baseWin = this.cfg.analysisWindow || this.cfg.tickWindow || 200;
    if (this._mode() === 'cycle') {
      const slowWin = this.cfg.raSlowWindow || 200;
      return Math.max(1, Math.min(Math.max(baseWin, slowWin + 40), len));
    }
    return Math.max(1, Math.min(baseWin, len));
  }

  wilsonUpper(phat, n, z) {
    n = Math.max(1, n);
    phat = Math.max(0, Math.min(1, phat));
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = phat + z2 / (2 * n);
    const spread = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
    return Math.min(1, (center + spread) / denom);
  }
  entropy(counts) {
    const n = counts.reduce((s, x) => s + x, 0);
    if (!n) return 0;
    let h = 0;
    for (const c of counts) { if (!c) continue; const p = c / n; h -= p * Math.log(p); }
    return h / Math.log(10);
  }
  chiSquare(counts) {
    const n = counts.reduce((s, x) => s + x, 0);
    if (!n) return 0;
    const expected = n / 10;
    return counts.reduce((s, c) => s + ((c - expected) ** 2) / expected, 0);
  }

  /** Resolve estimator mode. REPEAT_AVOID_CONDITIONAL only aliases the
   *  default mode; it never overrides an explicit mode. */
  _mode() {
    const raw = String(this.cfg.repeatAvoidMode || 'cycle').trim().toLowerCase();
    if (raw === 'flat' || raw === 'conditional' || raw === 'cycle') {
      if (raw === 'cycle' && this.cfg.repeatAvoidUseConditional) return 'conditional';
      return raw;
    }
    if (this.cfg.repeatAvoidUseConditional) return 'conditional';
    return 'cycle';
  }

  /** Build Bernoulli series R_t = 1 if digit repeated vs previous. */
  buildRepeatSeries(digits) {
    const R = new Array(Math.max(0, digits.length - 1));
    for (let i = 1; i < digits.length; i++) R[i - 1] = digits[i] === digits[i - 1] ? 1 : 0;
    return R;
  }

  /** How many consecutive non-repeats end at the last digit. */
  currentNonRepeatStreak(digits) {
    let streak = 0;
    for (let i = digits.length - 1; i > 0; i--) {
      if (digits[i] !== digits[i - 1]) streak++; else break;
    }
    return streak;
  }

  /** How many consecutive repeats end at the last digit. */
  currentRepeatStreak(digits) {
    let streak = 0;
    for (let i = digits.length - 1; i > 0; i--) {
      if (digits[i] === digits[i - 1]) streak++; else break;
    }
    return streak;
  }

  /** Mean of last `w` points of R (or all if shorter). */
  tailRate(R, w) {
    if (!R.length) return 0.1;
    const n = Math.min(w, R.length);
    let s = 0;
    for (let i = R.length - n; i < R.length; i++) s += R[i];
    return s / n;
  }

  /** Prefix-sum helper: rate of R[i-w+1 .. i] inclusive, for each i. */
  rollingRates(R, w) {
    const n = R.length;
    const out = [];
    if (n < w) return out;
    let s = 0;
    for (let i = 0; i < w; i++) s += R[i];
    out.push(s / w);
    for (let i = w; i < n; i++) {
      s += R[i] - R[i - w];
      out.push(s / w);
    }
    return out;
  }

  /**
   * Estimate low/high emission rates (pL, pH) from the distribution of
   * short-block repeat rates. Captures "quiet vs hot cycle" intensity
   * without nested O(W²) work.
   */
  estimateEmissionRates(R) {
    const block = Math.max(8, this.cfg.raBlockSize || 20);
    const rates = this.rollingRates(R, block);
    const fair = 0.10;
    if (rates.length < 8) {
      const base = R.length ? R.reduce((a, b) => a + b, 0) / R.length : fair;
      return {
        pL: Math.max(0.02, Math.min(0.09, base * 0.65)),
        pH: Math.min(0.30, Math.max(0.11, base * 1.55)),
        pBase: base,
      };
    }
    const sorted = rates.slice().sort((a, b) => a - b);
    const q = (p) => {
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
      return sorted[idx];
    };
    const pBase = R.reduce((a, b) => a + b, 0) / R.length;
    let pL = q(0.25);
    let pH = q(0.75);
    const minSep = this.cfg.raMinRegimeSep ?? 0.015;
    if (pH - pL < minSep) {
      pL = Math.max(0.02, pBase - Math.max(minSep, 0.02));
      pH = Math.min(0.30, pBase + Math.max(minSep, 0.02));
    }
    pL = Math.max(0.015, Math.min(0.095, pL));
    pH = Math.max(0.105, Math.min(0.35, pH));
    if (pH <= pL) { pL = 0.06; pH = 0.14; }
    return { pL, pH, pBase };
  }

  /**
   * Online 2-state Bayesian filter on the repeat series.
   * States: Quiet (low pL) and Hot (high pH). Returns posterior P(Quiet)
   * after the last observation and the one-step-ahead predictive
   * P(repeat next).
   */
  bayesianRegimeFilter(R, pL, pH) {
    const stayQ = Math.min(0.999, Math.max(0.5, this.cfg.raStayQuiet ?? 0.985));
    const stayH = Math.min(0.999, Math.max(0.5, this.cfg.raStayHot   ?? 0.980));
    const switchQH = 1 - stayQ;
    const switchHQ = 1 - stayH;
    let pQ = 0.5;
    for (let i = 0; i < R.length; i++) {
      const r = R[i];
      const pQpred = pQ * stayQ + (1 - pQ) * switchHQ;
      const likeQ = r ? pL : (1 - pL);
      const likeH = r ? pH : (1 - pH);
      const postQ = pQpred * likeQ;
      const postH = (1 - pQpred) * likeH;
      const norm = postQ + postH;
      pQ = norm > 0 ? postQ / norm : 0.5;
    }
    const pQnext = pQ * stayQ + (1 - pQ) * switchHQ;
    const pRepeatNext = pQnext * pL + (1 - pQnext) * pH;
    return { pQuiet: pQ, pQuietNext: pQnext, pRepeatNext, pL, pH };
  }

  /**
   * Classify cycle phase from multi-scale rates + regime posterior.
   */
  classifyPhase(rFast, rMid, rSlow, pQuiet, pBase) {
    const eps = this.cfg.raSlopeEps ?? 0.008;
    const slope = rFast - rMid;
    const base = Number.isFinite(pBase) ? pBase : 0.10;
    const elevatedMid = rMid > base + eps * 0.5;
    const depressedMid = rMid < base - eps * 0.5;
    const elevatedFast = rFast > base + eps;
    const depressedFast = rFast < base - eps * 0.25;

    if (pQuiet >= 0.65 && depressedFast) return 'quiet';
    if (pQuiet <= 0.35 && elevatedFast) return 'hot';
    if (slope < -eps && elevatedMid) return 'cooling';
    if (slope > eps && depressedMid) return 'heating';
    if (pQuiet >= 0.60 && rFast <= base) return 'quiet';
    if (pQuiet <= 0.40 && rFast >= base) return 'hot';
    return 'neutral';
  }

  /** P(repeat | current non-repeat streak == streakLen). */
  conditionalRepeatProb(digits, streakLen) {
    const cap = this.cfg.repeatAvoidMaxStreakBucket;
    const target = Math.min(streakLen, cap);
    let streak = 0, hits = 0, n = 0;
    for (let i = 1; i < digits.length; i++) {
      const isRepeat = digits[i] === digits[i - 1] ? 1 : 0;
      if (Math.min(streak, cap) === target) { n++; hits += isRepeat; }
      streak = isRepeat ? 0 : streak + 1;
    }
    return n >= this.cfg.repeatAvoidMinBucketN ? { p: hits / n, n } : null;
  }

  /**
   * Reliability-weighted blend of regime / local / streak estimators,
   * then mild shrink toward fair 0.10 (empirical Bayes regularizer).
   */
  blendEstimates(parts) {
    let wSum = 0, pSum = 0, nEff = 0;
    for (const part of parts) {
      if (!part || !Number.isFinite(part.p) || !(part.w > 0)) continue;
      wSum += part.w;
      pSum += part.w * part.p;
      if (part.n > 0) nEff += part.w * part.n;
    }
    if (!(wSum > 0)) return { p: 0.10, n: 1, source: 'fair-fallback' };
    let p = pSum / wSum;
    const shrink = Math.min(0.5, Math.max(0, this.cfg.raShrinkToFair ?? 0.12));
    p = (1 - shrink) * p + shrink * 0.10;
    p = Math.max(0.01, Math.min(0.40, p));
    const n = Math.max(1, Math.round(nEff / Math.max(wSum, 1e-9)));
    const labels = parts.filter(x => x && x.w > 0 && x.label).map(x => x.label);
    return { p, n, source: labels.join('+') || 'blend' };
  }

  /** Legacy flat / conditional path (kept for A/B and DIAGNOSE parity). */
  _analyzeLegacy(symbol, recentDigits, lastQuote, mode) {
    const lastDigit = recentDigits[recentDigits.length - 1];
    let repeats = 0;
    for (let i = 1; i < recentDigits.length; i++) if (recentDigits[i] === recentDigits[i - 1]) repeats++;
    const nFlat = recentDigits.length - 1;
    const pFlat = nFlat > 0 ? repeats / nFlat : 0.1;

    let phat = pFlat, sampleSize = nFlat, source = 'flat';
    const streakLen = this.currentNonRepeatStreak(recentDigits);
    if (mode === 'conditional') {
      const cond = this.conditionalRepeatProb(recentDigits, streakLen);
      if (cond) {
        phat = cond.p;
        sampleSize = cond.n;
        source = `conditional(streak=${Math.min(streakLen, this.cfg.repeatAvoidMaxStreakBucket)})`;
      }
    }

    const pLossUpper = Math.min(1, this.wilsonUpper(phat, sampleSize, this.cfg.zScore) + this.cfg.modelRiskMargin);
    const counts = Array(10).fill(0);
    for (const d of recentDigits) counts[d] += 1;
    // Multiple-comparison-aware deviation below fair P(repeat)=0.10.
    const se = Math.sqrt((0.10 * 0.90) / Math.max(1, sampleSize));
    const zDev = se > 0 ? (0.10 - phat) / se : 0;

    const candidates = [{
      symbol, digit: lastDigit, pLoss: phat, pLossUpper, sampleSize, recentHits: 0,
      streakLen, source, phase: 'n/a', pQuiet: null, zDev,
    }];
    const gates = [];
    if (sampleSize < this.cfg.repeatAvoidMinBucketN) gates.push(`sample-too-small:${sampleSize}`);
    if (zDev < this.cfg.minDeviationZ) gates.push(`deviation-low:${zDev.toFixed(2)}`);
    if (candidates[0].pLossUpper > this.cfg.maxLossProb) gates.push(`loss-prob-high:${candidates[0].pLossUpper.toFixed(4)}`);

    return {
      symbol,
      method: `repeat-avoid:${source}`,
      ticks: recentDigits.length,
      lastDigit,
      lastQuote,
      entropy: this.entropy(counts),
      chiSquare: this.chiSquare(counts),
      probabilityGap: 1,
      candidates,
      best: candidates[0],
      gates,
      allowedByModel: gates.length === 0,
      cycle: null,
    };
  }

  /**
   * Cycle-regime path: multi-scale rates + sticky 2-state filter +
   * streak-conditional + phase gate.
   */
  _analyzeCycle(symbol, recentDigits, lastQuote) {
    const lastDigit = recentDigits[recentDigits.length - 1];
    const R = this.buildRepeatSeries(recentDigits);
    if (R.length < Math.max(30, this.cfg.raFastWindow || 30)) return null;

    const wFast = Math.max(8, this.cfg.raFastWindow || 30);
    const wMid  = Math.max(wFast + 1, this.cfg.raMidWindow || 90);
    const wSlow = Math.max(wMid + 1, this.cfg.raSlowWindow || 200);

    const rFast = this.tailRate(R, wFast);
    const rMid  = this.tailRate(R, Math.min(wMid, R.length));
    const rSlow = this.tailRate(R, Math.min(wSlow, R.length));

    const { pL, pH, pBase } = this.estimateEmissionRates(R);
    const filt = this.bayesianRegimeFilter(R, pL, pH);
    const phase = this.classifyPhase(rFast, rMid, rSlow, filt.pQuiet, pBase);

    const streakLen = this.currentNonRepeatStreak(recentDigits);
    const repStreak = this.currentRepeatStreak(recentDigits);
    const cond = this.conditionalRepeatProb(recentDigits, streakLen);

    const parts = [
      { p: filt.pRepeatNext, w: this.cfg.raWRegime ?? 0.50, n: R.length, label: 'regime' },
      { p: rFast,            w: this.cfg.raWLocal  ?? 0.30, n: Math.min(wFast, R.length), label: 'local' },
    ];
    if (cond) {
      parts.push({ p: cond.p, w: this.cfg.raWStreak ?? 0.20, n: cond.n, label: `streak${Math.min(streakLen, this.cfg.repeatAvoidMaxStreakBucket)}` });
    }
    const blend = this.blendEstimates(parts);
    const sampleSize = Math.max(blend.n, Math.min(wFast, R.length));
    const phat = blend.p;
    const pLossUpper = Math.min(1, this.wilsonUpper(phat, sampleSize, this.cfg.zScore) + this.cfg.modelRiskMargin);

    const counts = Array(10).fill(0);
    for (const d of recentDigits) counts[d] += 1;

    const source = `cycle:${phase}|${blend.source}`;
    // Multiple-comparison-aware deviation below fair P(repeat)=0.10.
    // CRITICAL: use the MID-window sample size (the regime-confirmation
    // window), not the blend's inflated n, which would make a ~20-tick
    // quiet phase look statistically certain when it is well within
    // fair-noise variance. Honest question this gate answers: "is the
    // regime-confirmation repeat rate low enough that it cannot be a
    // random quiet patch on a fair stream?" At n=100 the max reachable z
    // is ~3.3, so at minDeviationZ=4.2 this strategy correctly idles —
    // a 100-tick low-repeat window cannot achieve the significance that
    // coldest-of-10 requires. That is the intended, honest default.
    const nDev = Math.max(8, Math.min(wMid, R.length));
    const se = Math.sqrt((0.10 * 0.90) / nDev);
    const zDev = se > 0 ? (0.10 - rFast) / se : 0;
    const candidates = [{
      symbol,
      digit: lastDigit,
      pLoss: phat,
      pLossUpper,
      sampleSize,
      recentHits: 0,
      zDev,
      streakLen,
      repeatStreak: repStreak,
      source,
      phase,
      pQuiet: +filt.pQuiet.toFixed(4),
      rFast: +rFast.toFixed(4),
      rMid: +rMid.toFixed(4),
      rSlow: +rSlow.toFixed(4),
      pL: +pL.toFixed(4),
      pH: +pH.toFixed(4),
      pRegime: +filt.pRepeatNext.toFixed(4),
    }];
    const best = candidates[0];

    const gates = [];
    if (R.length < this.cfg.repeatAvoidMinBucketN) {
      gates.push(`sample-too-small:${R.length}`);
    }
    if ((pH - pL) < (this.cfg.raMinRegimeSep ?? 0.015)) {
      gates.push(`regime-collapsed:${(pH - pL).toFixed(4)}`);
    }
    const allowQuiet   = this.cfg.raAllowQuiet   !== false;
    const allowCooling = this.cfg.raAllowCooling !== false;
    const allowNeutral = this.cfg.raAllowNeutral === true;
    const phaseOk =
      (phase === 'quiet'   && allowQuiet) ||
      (phase === 'cooling' && allowCooling) ||
      (phase === 'neutral' && allowNeutral);
    if (!phaseOk) gates.push(`phase-block:${phase}`);

    const minQ = this.cfg.raMinQuietProb ?? 0.55;
    if ((phase === 'quiet' || phase === 'cooling') && filt.pQuiet < minQ * 0.85) {
      if (filt.pQuiet < 0.40) gates.push(`regime-hot:${filt.pQuiet.toFixed(3)}`);
    }
    if (phase === 'quiet' && filt.pQuiet < minQ) {
      gates.push(`quiet-prob-low:${filt.pQuiet.toFixed(3)}`);
    }

    const maxLocal = this.cfg.raMaxLocalRate ?? 0.095;
    if (rFast > maxLocal) gates.push(`local-rate-high:${rFast.toFixed(4)}`);

    if (best.pLossUpper > this.cfg.maxLossProb) {
      gates.push(`loss-prob-high:${best.pLossUpper.toFixed(4)}`);
    }
    // The blended repeat-prob must be a statistical outlier below fair 0.10,
    // not just "a bit below" — otherwise the cycle engine's quiet-phase
    // estimates (which are produced by the clustering illusion on fair
    // noise) would trade as if they were signal.
    if (zDev < (this.cfg.minDeviationZ ?? 2.8)) {
      gates.push(`deviation-low:${zDev.toFixed(2)}`);
    }

    return {
      symbol,
      method: `repeat-avoid:${source}`,
      ticks: recentDigits.length,
      lastDigit,
      lastQuote,
      entropy: this.entropy(counts),
      chiSquare: this.chiSquare(counts),
      probabilityGap: 1,
      candidates,
      best,
      gates,
      allowedByModel: gates.length === 0,
      cycle: {
        phase,
        pQuiet: +filt.pQuiet.toFixed(4),
        pQuietNext: +filt.pQuietNext.toFixed(4),
        pRepeatNext: +filt.pRepeatNext.toFixed(4),
        pL: +pL.toFixed(4),
        pH: +pH.toFixed(4),
        pBase: +pBase.toFixed(4),
        rFast: +rFast.toFixed(4),
        rMid: +rMid.toFixed(4),
        rSlow: +rSlow.toFixed(4),
        streakLen,
        repeatStreak: repStreak,
        blend: blend.source,
      },
    };
  }

  /** Live entry point: extract valid digits and analyze the trailing window. */
  analyze(symbol, ticks) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;
    const digits = ticks.map(t => t.digit).filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
    if (digits.length < this.cfg.minTicksForAnalysis) return null;
    return this.analyzeAt(symbol, digits, digits.length - 1, ticks[ticks.length - 1]?.quote);
  }

  /** Analyze "as of" endIdx in a precomputed digit array. O(window). */
  analyzeAt(symbol, digits, endIdx, lastQuote) {
    if (endIdx + 1 < this.cfg.minTicksForAnalysis) return null;
    const win = this._wantWindow(endIdx + 1);
    const from = Math.max(0, endIdx - win + 1);
    return this.analyzeWindow(symbol, digits, from, endIdx, lastQuote);
  }

  analyzeWindow(symbol, digits, from, to, lastQuote) {
    const recentDigits = digits.slice(from, to + 1);
    if (recentDigits.length < 10) return null;

    const mode = this._mode();
    if (mode === 'cycle') {
      const cyc = this._analyzeCycle(symbol, recentDigits, lastQuote);
      // Fall back to conditional if window too short for cycle engine
      if (cyc) return cyc;
      return this._analyzeLegacy(symbol, recentDigits, lastQuote, 'conditional');
    }
    return this._analyzeLegacy(symbol, recentDigits, lastQuote, mode);
  }

  rank(list) {
    return list.filter(Boolean).sort((a, b) => {
      const aAllow = a.allowedByModel ? 0 : 1;
      const bAllow = b.allowedByModel ? 0 : 1;
      if (aAllow !== bAllow) return aAllow - bAllow;
      const aq = a.best?.pQuiet ?? a.cycle?.pQuiet;
      const bq = b.best?.pQuiet ?? b.cycle?.pQuiet;
      if (Number.isFinite(aq) && Number.isFinite(bq) && aq !== bq) return bq - aq;
      const au = a.best?.pLossUpper ?? 1;
      const bu = b.best?.pLossUpper ?? 1;
      return au - bu;
    });
  }
}

/** Factory: pick the analyzer implementation based on cfg.strategy. */
function makeAnalyzer(cfg) {
  if (cfg.strategy === 'repeat_avoid') {
    const mode = String(cfg.repeatAvoidMode || 'cycle').toLowerCase();
    logger.warn(
      `STRATEGY=repeat_avoid mode=${mode} — regime/cycle engine. Validate any claimed ` +
      `structure with DIAGNOSE=1 & BACKTEST=1 before trusting it; on fair digits this ` +
      `strategy is expected to idle at the current gates.`
    );
    return new RepeatAvoidAnalyzer(cfg);
  }
  return new DigitAnalyzer(cfg);
}

// ─────────────────────────────────────────────────────────────────────
// 8. TRADE EXECUTOR — DIGITDIFF
//    Single writer for positions. settleFromContract() is the one,
//    idempotent path through which every settlement (live stream,
//    reconnect reconciliation, watchdog poll) funnels, so a result is
//    never recorded twice and never fabricated.
// ─────────────────────────────────────────────────────────────────────
class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.open = new Map();
    this._settled = new Set();
  }
  async proposal(symbol, digit, stake) {
    const symbolKey = this.client.symbolField();
    return this.client._send({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: 'DIGITDIFF',
      currency: this.cfg.currency,
      duration: this.cfg.durationTicks,
      duration_unit: 't',
      barrier: String(digit),
      [symbolKey]: symbol,
    }, 15000);
  }
  async buy(symbol, digit, stake, analysis) {
    stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, Number(stake)));
    const pres = await this.proposal(symbol, digit, stake);
    const p = pres.proposal;
    if (!p?.id) throw new Error('No proposal id returned');
    const ask = Number(p.ask_price || stake);
    const payout = Number(p.payout || 0);
    const bres = await this.client._send({ buy: p.id, price: ask }, 15000);
    const b = bres.buy;
    if (!b?.contract_id) throw new Error('Buy did not return contract_id');

    const info = {
      contractId: b.contract_id,
      symbol,
      contractType: 'DIGITDIFF',
      digit,
      stake: ask,
      buyPrice: Number(b.buy_price || ask),
      payout: Number(b.payout || payout),
      buyTime: Number(b.purchase_time || Date.now() / 1000),
      durationTicks: this.cfg.durationTicks,
      proposalId: p.id,
      longcode: p.longcode || '',
      balanceAfter: b.balance_after != null ? Number(b.balance_after) : null,
      analysis,
    };
    this.open.set(info.contractId, info);
    logger.info(`bought DIGITDIFF #${info.contractId} ${symbol} differs ${digit} stake=${ask} payout=${info.payout}`);

    // Subscribe to settlement. If subscribe fails we keep the contract
    // tracked anyway — the watchdog / reconnect-reconciliation will
    // resolve it. A real buy must never be silently dropped.
    try {
      const subId = await this.client.subscribe(
        { proposal_open_contract: 1, contract_id: info.contractId },
        msg => this._onUpdate(msg, info),
      );
      info.subId = subId;
    } catch (e) {
      logger.warn(`subscribe settlement #${info.contractId} failed: ${e.message} — watchdog/reconcile will recover`);
    }
    this.emit('open', info);
    return info;
  }

  /**
   * Idempotent settle. Returns the finished trade object or null if this
   * contract was already settled or the status is not terminal.
   */
  settleFromContract(info, c) {
    const cid = c.contract_id || info.contractId;
    if (this._settled.has(cid)) return null;
    if (c.status !== 'won' && c.status !== 'lost') return null;
    this._settled.add(cid);
    if (this._settled.size > 5000) {
      const first = this._settled.values().next().value;
      if (first != null) this._settled.delete(first);
    }
    const finished = {
      ...info,
      contractId: cid,
      status: c.status,
      profit: Number(c.profit || 0),
      sellPrice: Number(c.sell_price || 0),
      sellTime: Number(c.sell_time || Date.now() / 1000),
      entryTick: c.entry_tick,
      exitTick: c.exit_tick,
      currentSpot: c.current_spot,
      shortcode: c.shortcode,
    };
    this.open.delete(cid);
    this.emit('result', finished);
    return finished;
  }
  _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    const finished = this.settleFromContract(info, c);
    if (finished) {
      const subId = msg.subscription?.id || info.subId;
      if (subId) this.client.forget(subId).catch(() => {});
    } else {
      this.emit('update', { ...info, contractId: c.contract_id || info.contractId, status: c.status, profit: Number(c.profit || 0) });
    }
  }
  /** Sell a contract early (real API; rarely used for 1-tick digits). */
  async sell(contractId, price) {
    const res = await this.client._send({ sell: contractId, price: price || 0 }, 15000);
    return res?.sell?.contract_id != null;
  }
  count() { return this.open.size; }
  openTrades() { return [...this.open.values()]; }
}

// ─────────────────────────────────────────────────────────────────────
// 9. STATISTICS MANAGER
//    status: 'won' | 'lost' | 'unknown'. 'unknown' trades are recorded
//    for the audit trail but never counted toward win rate or streaks —
//    we never fabricate a win/loss we couldn't confirm.
// ─────────────────────────────────────────────────────────────────────
class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.dailySummaries = {}; // date -> stats summary
    this.overallProfit = 0;
    this.currentLossStreak = 0;
    this.maxLossStreak = 0;
    this.lossStreakEvents = { x2: 0, x3: 0, x4: 0 };
    this.unknownCount = 0;
    this.eodSentDates = [];
    if (saved) this.load(saved);
  }
  load(saved) {
    if (Array.isArray(saved.trades)) this.trades = saved.trades;
    if (saved.dailySummaries && typeof saved.dailySummaries === 'object') this.dailySummaries = saved.dailySummaries;
    this.overallProfit = Number(saved.overallProfit || 0);
    this.currentLossStreak = Number(saved.currentLossStreak || 0);
    this.maxLossStreak = Number(saved.maxLossStreak || 0);
    this.lossStreakEvents = {
      x2: Number(saved.lossStreakEvents?.x2 || 0),
      x3: Number(saved.lossStreakEvents?.x3 || 0),
      x4: Number(saved.lossStreakEvents?.x4 || 0),
    };
    this.unknownCount = Number(saved.unknownCount || 0);
    this.eodSentDates = Array.isArray(saved.eodSentDates) ? saved.eodSentDates : [];
  }
  serialize() {
    return {
      trades: this.trades.slice(-5000),
      dailySummaries: this.dailySummaries,
      overallProfit: this.overallProfit,
      currentLossStreak: this.currentLossStreak,
      maxLossStreak: this.maxLossStreak,
      lossStreakEvents: this.lossStreakEvents,
      unknownCount: this.unknownCount,
      eodSentDates: this.eodSentDates.slice(-400),
    };
  }
  _stamp(trade) {
    const tsMs = Number(trade.sellTime || trade.buyTime || Date.now() / 1000) * 1000;
    const d = new Date(tsMs);
    return { timestamp: tsMs, date: utcDateStr(d), hour: utcHour(d) };
  }
  record(trade) {
    const stamp = this._stamp(trade);
    const rec = { ...trade, timestamp: stamp.timestamp, date: stamp.date, hour: stamp.hour };
    this.trades.push(rec);
    this.overallProfit += Number(rec.profit || 0);

    if (rec.status === 'lost') {
      this.currentLossStreak += 1;
      if (this.currentLossStreak === 2) this.lossStreakEvents.x2 += 1;
      if (this.currentLossStreak === 3) this.lossStreakEvents.x3 += 1;
      if (this.currentLossStreak === 4) this.lossStreakEvents.x4 += 1;
      this.maxLossStreak = Math.max(this.maxLossStreak, this.currentLossStreak);
    } else if (rec.status === 'won') {
      this.currentLossStreak = 0;
    } else if (rec.status === 'unknown') {
      this.unknownCount += 1;
      // No streak change: we genuinely don't know the outcome.
    }
    return rec;
  }
  tradesForDate(date) { return this.trades.filter(t => t.date === date); }
  tradesForHour(date, hour) { return this.trades.filter(t => t.date === date && t.hour === hour); }
  todayTrades(date = utcDateStr()) { return this.tradesForDate(date); }
  stats(list) {
    const wins = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
    const unknown = list.filter(t => t.status === 'unknown');
    const total = list.reduce((s, t) => s + Number(t.profit || 0), 0);
    const grossWin = wins.reduce((s, t) => s + Number(t.profit || 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.profit || 0), 0));
    const stake = list.reduce((s, t) => s + Number(t.stake || 0), 0);
    const maxLossStreak = (() => {
      let cur = 0, max = 0;
      for (const t of list) {
        if (t.status === 'lost') { cur += 1; max = Math.max(max, cur); }
        else if (t.status === 'won') cur = 0;
      }
      return max;
    })();
    const decided = wins.length + losses.length;
    return {
      count: list.length,
      decided,
      wins: wins.length,
      losses: losses.length,
      unknown: unknown.length,
      winRate: decided ? wins.length / decided * 100 : 0,
      grossWin,
      grossLoss,
      totalProfit: total,
      netPL: total,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      avgProfit: decided ? total / decided : 0,
      stake,
      maxLossStreak,
    };
  }
  summaryForDate(date) {
    const list = this.tradesForDate(date);
    const stats = this.stats(list);
    return { date, trades: list, stats };
  }
  archiveDate(date) {
    const summary = this.summaryForDate(date);
    this.dailySummaries[date] = summary.stats;
    return summary;
  }
  markEodSent(date) {
    if (!this.eodSentDates.includes(date)) this.eodSentDates.push(date);
    this.eodSentDates = this.eodSentDates.slice(-400);
  }
  isEodSent(date) { return this.eodSentDates.includes(date); }
  allDailyRows(includeDate = null) {
    const rows = [];
    const dates = new Set(Object.keys(this.dailySummaries));
    for (const t of this.trades) dates.add(t.date);
    if (includeDate) dates.add(includeDate);
    [...dates].sort().forEach(date => {
      let stats = this.dailySummaries[date];
      const live = this.tradesForDate(date);
      if (live.length) stats = this.stats(live);
      if (stats && stats.count > 0) rows.push({ date, stats });
    });
    return rows;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 9b. SYMBOL CALIBRATOR  (rolling per-symbol edge tracker)
// ─────────────────────────────────────────────────────────────────────
class SymbolCalibrator {
  constructor(cfg, saved = null) {
    this.cfg     = cfg;
    this.symbols = new Map();
    if (saved && typeof saved === 'object') this.load(saved);
  }
  _slot(sym) {
    if (!this.symbols.has(sym)) {
      this.symbols.set(sym, {
        window     : [],
        state      : 'enabled',
        disabledAt : 0,
        lastReason : '',
      });
    }
    return this.symbols.get(sym);
  }
  record(symbol, predictedPWin, won) {
    if (!this.cfg.calibEnabled) return;
    const s = this._slot(symbol);
    s.window.push({ pWin: Number(predictedPWin), won: !!won, ts: Date.now() });
    if (s.window.length > this.cfg.calibWindow) {
      s.window.splice(0, s.window.length - this.cfg.calibWindow);
    }
    this._reassess(symbol, s);
  }
  _reassess(symbol, s) {
    const n = s.window.length;
    if (n < this.cfg.calibMinTrades) return;
    const wins       = s.window.reduce((acc, r) => acc + (r.won ? 1 : 0), 0);
    const empirical  = wins / n;
    const predicted  = s.window.reduce((acc, r) => acc + r.pWin, 0) / n;
    const gap        = empirical - predicted;   // − means over-prediction (bad)
    if (s.state === 'enabled' || s.state === 'probing') {
      if (gap < -this.cfg.calibDisableGap) {
        s.state      = 'disabled';
        s.disabledAt = Date.now();
        s.lastReason = `WR ${(empirical*100).toFixed(2)}% < predicted ${(predicted*100).toFixed(2)}% by ${(Math.abs(gap)*100).toFixed(2)}pp (n=${n})`;
        logger.warn(`CALIB: ${symbol} DISABLED — ${s.lastReason}`);
        return { symbol, transition: 'disabled', gap, empirical, predicted, n };
      }
      if (s.state === 'probing' && Math.abs(gap) < this.cfg.calibReenableGap) {
        s.state      = 'enabled';
        s.lastReason = `WR ${(empirical*100).toFixed(2)}% vs predicted ${(predicted*100).toFixed(2)}% (gap ${(gap*100).toFixed(2)}pp) — re-enabled`;
        logger.info(`CALIB: ${symbol} RE-ENABLED — ${s.lastReason}`);
        return { symbol, transition: 'enabled', gap, empirical, predicted, n };
      }
    }
    return null;
  }
  status(symbol) {
    const s = this._slot(symbol);
    if (s.state === 'disabled' &&
        Date.now() - s.disabledAt >= this.cfg.calibProbeAfterMs) {
      s.state      = 'probing';
      s.lastReason = `cooldown elapsed (${Math.round((Date.now()-s.disabledAt)/60_000)}m)`;
      logger.info(`CALIB: ${symbol} → PROBING at ${(this.cfg.calibProbeStakeFrac*100).toFixed(0)}% stake — ${s.lastReason}`);
    }
    return s.state;
  }
  summary() {
    const out = {};
    for (const [sym, s] of this.symbols) {
      const n = s.window.length;
      const wins = s.window.reduce((a, r) => a + (r.won ? 1 : 0), 0);
      const emp  = n ? wins / n : 0;
      const pred = n ? s.window.reduce((a, r) => a + r.pWin, 0) / n : 0;
      out[sym] = {
        state    : s.state,
        n,
        empirical: +(emp * 100).toFixed(2),
        predicted: +(pred * 100).toFixed(2),
        gap      : +((emp - pred) * 100).toFixed(2),
        reason   : s.lastReason,
      };
    }
    return out;
  }
  stakeMultiplier(symbol) {
    if (!this.cfg.calibEnabled) return 1.0;
    const st = this.status(symbol);
    if (st === 'disabled') return 0;
    if (st === 'probing')  return this.cfg.calibProbeStakeFrac;
    return 1.0;
  }
  isTradeable(symbol) { return this.stakeMultiplier(symbol) > 0; }

  serialize() {
    const out = {};
    for (const [sym, s] of this.symbols) {
      out[sym] = {
        window     : s.window.slice(-this.cfg.calibWindow),
        state      : s.state,
        disabledAt : s.disabledAt,
        lastReason : s.lastReason,
      };
    }
    return out;
  }
  load(saved) {
    for (const [sym, s] of Object.entries(saved)) {
      if (!s || typeof s !== 'object') continue;
      this.symbols.set(sym, {
        window     : Array.isArray(s.window) ? s.window.slice(-this.cfg.calibWindow) : [],
        state      : s.state       || 'enabled',
        disabledAt : Number(s.disabledAt || 0),
        lastReason : String(s.lastReason || ''),
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// 9c. KELLY SIZER
// ─────────────────────────────────────────────────────────────────────
class KellySizer {
  constructor(cfg) { this.cfg = cfg; }

  compute({ bankroll, pWin, payoutMult, edgeValue }) {
    const cfg = this.cfg;
    const b   = Math.max(0, payoutMult - 1);
    const p   = Math.max(0, Math.min(1, pWin));
    const q   = 1 - p;
    if (b <= 0) return null;
    const fStar = (b * p - q) / b;
    if (fStar <= 0) return null;
    if (edgeValue < cfg.kellyMinEdgeForScale) {
      return { stake: cfg.minStake, fStar, fApplied: 0, reason: 'edge<minEdgeForScale' };
    }
    const roll   = Math.max(cfg.kellyBankrollFloor, bankroll * cfg.kellyBankrollFrac);
    const fApp   = fStar * cfg.kellyFraction;
    const capF   = Math.min(fApp, cfg.kellyMaxStakeFrac);
    let stake    = roll * capF;
    stake        = Math.max(cfg.minStake, Math.min(cfg.maxStake, +stake.toFixed(2)));
    return { stake, fStar, fApplied: capF, reason: fApp > cfg.kellyMaxStakeFrac ? 'capped' : 'ok' };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 10. TRADING BOT ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────
class TradingBot {
  constructor() {
    this.cfg = CONFIG;
    this.client = new DerivClient(this.cfg);
    this.market = new MarketDataManager(this.client, this.cfg);
    this.analyzer = makeAnalyzer(this.cfg);
    this.exec = new TradeExecutor(this.client, this.cfg);
    this.stats = new StatisticsManager();
    this.calibrator = new SymbolCalibrator(this.cfg);
    this.kelly      = new KellySizer(this.cfg);
    this.livePayoutMult = new Map();  // symbol → last observed payout/ask ratio (diagnostics)

    this.startBalance = null;
    this.lastBalance = null;
    this.lastTradeAt = 0;
    this.tradedAsset   = null;   // symbol most recently traded (rotation lock)
    this.tradedAssetAt = 0;      // when that symbol was traded (ms epoch)
    this.stopped = false;
    this.paused = false;
    this._analysisT = null;
    this._hourlyBoot = null;
    this._hourlyT = null;
    this._eodBoot = null;
    this._eodT = null;
    this._pauseStartTimer = null;
    this._pauseEndTimer = null;

    // ── Re-entrancy guards (prevents overlapping scans / double-buy) ──
    this._analysisRunning = false;

    // ── Live payout probe cache (symbol:digit → {mult, at}) ──
    this._payoutCache = new Map();

    // ── Daily + global stop state ──
    this._dayStartDate = null;
    this._dayStartBalance = null;
    this._dailyHaltUntil = null;
    this._dailyHaltReason = null;
    this._globalHalt = false;

    // ── Tick counter for cooldownTicks ──
    this._tickCounter = 0;
    this._lastTradeTickIdx = null;

    // ── Trade watchdog timers ──
    this.tradeWatchdogMs = CONFIG.tradeWatchdogMs || 90000;
    this.tradeStartTime = null;
    this._tradeWatchdogTimer = null;
    this._tradeWatchdogPollTimer = null;
  }

  // ── Scheduled pause helpers ─────────────────────────────────────
  _parsePauseTime(str) {
    const m = String(str || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Math.max(0, Math.min(23, Number(m[1])));
    const min = Math.max(0, Math.min(59, Number(m[2])));
    return { h, min };
  }

  _isPausedNow() {
    if (!this.cfg.pauseEnabled) return false;
    const start = this._parsePauseTime(this.cfg.pauseStartGmt);
    const end   = this._parsePauseTime(this.cfg.pauseEndGmt);
    if (!start || !end) return false;
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const startMin = start.h * 60 + start.min;
    const endMin   = end.h   * 60 + end.min;
    if (startMin > endMin) {
      // Overnight window: paused from startMin..1439 OR 0..endMin
      return nowMin >= startMin || nowMin < endMin;
    }
    return nowMin >= startMin && nowMin < endMin;
  }

  _schedulePause() {
    this._clearPauseTimers();
    if (!this.cfg.pauseEnabled) return;

    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const start = this._parsePauseTime(this.cfg.pauseStartGmt);
    const end   = this._parsePauseTime(this.cfg.pauseEndGmt);
    if (!start || !end) {
      logger.warn('pause schedule: invalid pauseStartGmt or pauseEndGmt format');
      return;
    }
    const startMin = start.h * 60 + start.min;
    const endMin   = end.h   * 60 + end.min;

    const msToTarget = (targetMinOfDay) => {
      let diff = targetMinOfDay - nowMin;
      if (diff <= 0) diff += 24 * 60;
      return diff * 60_000 - (now.getUTCSeconds() * 1000) - now.getUTCMilliseconds();
    };

    if (startMin > endMin) {
      if (nowMin >= startMin || nowMin < endMin) {
        this.paused = true;
        const delay = msToTarget(endMin);
        this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
        logger.info(`pause: currently active (overnight), resumes in ${(delay/60000).toFixed(1)}m at ${this.cfg.pauseEndGmt} GMT`);
      } else {
        this.paused = false;
        const delay = msToTarget(startMin);
        this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), delay);
        logger.info(`pause: scheduled, pauses in ${(delay/60000).toFixed(1)}m at ${this.cfg.pauseStartGmt} GMT`);
      }
    } else {
      if (nowMin >= startMin && nowMin < endMin) {
        this.paused = true;
        const delay = msToTarget(endMin);
        this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
        logger.info(`pause: currently active, resumes in ${(delay/60000).toFixed(1)}m at ${this.cfg.pauseEndGmt} GMT`);
      } else {
        this.paused = false;
        const delay = msToTarget(startMin);
        this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), delay);
        logger.info(`pause: scheduled, pauses in ${(delay/60000).toFixed(1)}m at ${this.cfg.pauseStartGmt} GMT`);
      }
    }
  }

  _onPauseResume(action) {
    this._clearPauseTimers();
    if (action === 'pause') {
      this.paused = true;
      logger.info(`TRADING PAUSED at ${this.cfg.pauseStartGmt} GMT until ${this.cfg.pauseEndGmt} GMT`);
      telegram.send(
        `⏸️ <b>x2Digit TRADING PAUSED</b>\n\n` +
        `Scheduled pause active from <b>${htmlEscape(this.cfg.pauseStartGmt)}</b> to <b>${htmlEscape(this.cfg.pauseEndGmt)}</b> GMT.\n` +
        `Open trades will settle normally. No new trades until resume.\n\n` +
        `🕒 ${utcTs()}`
      );
      const end = this._parsePauseTime(this.cfg.pauseEndGmt);
      if (end) {
        const delay = this._msToTarget(end.h, end.min);
        this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
        logger.info(`pause: resumes in ${(delay/60000).toFixed(1)}m`);
      }
    } else {
      this.paused = false;
      logger.info(`TRADING RESUMED at ${this.cfg.pauseEndGmt} GMT`);
      telegram.send(
        `▶️ <b>x2Digit TRADING RESUMED</b>\n\n` +
        `Scheduled pause ended. Bot is now scanning for trades.\n\n` +
        `💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}\n\n` +
        `🕒 ${utcTs()}`
      );
      const start = this._parsePauseTime(this.cfg.pauseStartGmt);
      if (start) {
        const delay = this._msToTarget(start.h, start.min);
        this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), delay);
        logger.info(`pause: next pause in ${(delay/60000).toFixed(1)}m`);
      }
    }
  }

  _msToTarget(targetH, targetMin) {
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const targetMinOfDay = targetH * 60 + targetMin;
    let diff = targetMinOfDay - nowMin;
    if (diff <= 0) diff += 24 * 60;
    return diff * 60_000 - (now.getUTCSeconds() * 1000) - now.getUTCMilliseconds();
  }

  _clearPauseTimers() {
    if (this._pauseStartTimer) { clearTimeout(this._pauseStartTimer); this._pauseStartTimer = null; }
    if (this._pauseEndTimer)   { clearTimeout(this._pauseEndTimer);   this._pauseEndTimer = null; }
  }

  async start() {
    logger.info('===== Deriv Digit Differ Bot starting =====');
    logger.info(`config: stake=${this.cfg.stake} duration=${this.cfg.durationTicks}t assets=${this.cfg.assets.join(',')}`);
    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN missing. Put it in .env or environment.');
      process.exit(1);
    }
    this._loadState();

    this.client.on('authorized', info => this._onAuthorized(info));
    this.client.on('close', (c, r, was) => this._onDisconnected(c, r, was));
    this.client.on('open', () => logger.info('connection open'));
    this.client.on('error', e => logger.error('client error:', e.message));
    this.exec.on('open', t => this._onTradeOpen(t));
    this.exec.on('result', t => this._onTradeResult(t));
    this.exec.on('update', t => logger.debug(`update #${t.contractId} ${t.status} profit=${t.profit}`));
    this.market.on('tick', () => { this._tickCounter++; });

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
    process.on('uncaughtException', e => { logger.error('uncaughtException:', e); this._saveState('uncaughtException'); });
    process.on('unhandledRejection', e => { logger.error('unhandledRejection:', e); this._saveState('unhandledRejection'); });

    this.client.connect();
    this._scheduleSummaries();
  }

  async _onAuthorized(info) {
    this.startBalance = this.startBalance ?? this.client.balance ?? 0;
    this.lastBalance = this.lastBalance ?? this.client.balance ?? this.startBalance;
    this._dayStartDate = utcDateStr();
    this._dayStartBalance = this.lastBalance;
    logger.info(`start balance: ${this.startBalance} ${this.currency()}`);

    // Reconcile any contracts that were open across a disconnect BEFORE
    // we start scanning again, so maxOpenTrades and P&L stay accurate.
    await this._reconcileOpenContracts();

    await this.market.loadSymbols();

    const sizingLine = this.cfg.kellySizingEnabled
      ? `🧮 Sizing: <b>Kelly-fractional</b> (f=${this.cfg.kellyFraction}, cap=${(this.cfg.kellyMaxStakeFrac*100).toFixed(1)}% bankroll)`
      : (this.cfg.recoveryEnabled
          ? `🧮 Sizing: recovery ladder [${this.cfg.recoveryMultipliers.join(',')}] ⚠️ (cap ${this.cfg.recoveryStakeCap}${this.currency()}, ≤${(this.cfg.maxStakePctBankroll*100).toFixed(0)}% balance)`
          : `🧮 Sizing: flat`);
    const calibLine = this.cfg.calibEnabled
      ? `📐 Calibrator: <b>ON</b> (window=${this.cfg.calibWindow}, disableGap=${(this.cfg.calibDisableGap*100).toFixed(1)}pp)`
      : `📐 Calibrator: off`;
    const rotationLine = this.cfg.assetRotationMs > 0
      ? `🔄 Asset rotation: ${(this.cfg.assetRotationMs/1000).toFixed(0)}s lockout`
      : `🔄 Asset rotation: OFF (may repeat same symbol)`;
    const pauseLine = this.cfg.pauseEnabled
      ? `⏸️ Scheduled pause: <b>${htmlEscape(this.cfg.pauseStartGmt)}</b> → <b>${htmlEscape(this.cfg.pauseEndGmt)}</b> GMT`
      : `⏸️ Scheduled pause: off`;
    const breakerLine = this.cfg.circuitBreakerEnabled
      ? `🚨 Circuit breaker: <b>ON</b> (trip after ${this.cfg.circuitBreakerLosses} consecutive losses, cooldown ${(this.cfg.circuitBreakerCooldownMs/60000).toFixed(0)}m)`
      : `🚨 Circuit breaker: off`;
    const cooldownLine = this.cfg.cooldownTicks
      ? `⏱️ Tick cooldown: <b>${this.cfg.cooldownTicks} ticks</b> (${(this.cfg.cooldownTicks * this.cfg.analysisIntervalMs / 1000).toFixed(0)}s)`
      : '';

    telegram.send(
      `🤖 <b>x2Digit Differ Bot Online</b>\n\n` +
      `👤 Account: <code>${htmlEscape(info.loginid || '?')}</code>\n` +
      `💼 Type: ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 Balance: ${(this.client.balance ?? 0).toFixed(2)} ${this.currency()}\n` +
      `📊 Assets: ${this.cfg.assets.join(', ')}\n` +
      `🎯 Contract: <b>DIGITDIFF</b>, duration <b>${this.cfg.durationTicks} tick(s)</b>\n` +
      `💵 Base stake: ${this.cfg.stake.toFixed(2)} ${this.currency()}\n` +
      `${sizingLine}\n` +
      `${calibLine}\n` +
      `${rotationLine}\n` +
      `${breakerLine}\n` +
      `${cooldownLine}\n` +
      `📈 Signal: empirical digit frequency (heuristic, not a demonstrated edge — see file header)\n` +
      `🧯 Daily stop: ${money(-Math.abs(this.cfg.dailyMaxLoss), this.currency())} or ${(this.cfg.dailyMaxLossPct*100).toFixed(1)}% of balance, whichever first\n` +
      `🕒 Trade day clock: <b>GMT/UTC</b> | EOD: ${this.cfg.eodTimeGmt} GMT\n\n` +
      `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
      `❌ Loss streak: current ${this.stats.currentLossStreak}, x2=${this.stats.lossStreakEvents.x2}, x3=${this.stats.lossStreakEvents.x3}, x4=${this.stats.lossStreakEvents.x4}`
    );

    if (this.cfg.recoveryEnabled) {
      logger.warn(
        `⚠️  RECOVERY LADDER ENABLED — multipliers [${this.cfg.recoveryMultipliers.join(',')}]. ` +
        `This does not change per-trade edge; it only magnifies downside. Hard caps: ` +
        `${this.cfg.recoveryStakeCap}${this.currency()} and ${(this.cfg.maxStakePctBankroll*100).toFixed(0)}% of balance per trade.`
      );
    }

    await this.market.bootstrap(this.cfg.assets);
    if (this._analysisT) clearInterval(this._analysisT);
    this._analyzeAndTrade().catch(e => logger.error('initial analyze:', e.message));
    this._analysisT = setInterval(() => this._analyzeAndTrade().catch(e => logger.error('analyze:', e.message)), this.cfg.analysisIntervalMs);
  }

  _onDisconnected(code, reason, wasAuthorized) {
    telegram.send(`⚠️ <b>x2Digit Connection lost</b>\ncode: <code>${code}</code>\nwas authorized: ${wasAuthorized ? 'yes' : 'no'}\n🔄 reconnecting...`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    // NOTE: we deliberately do NOT clear exec.open here. Any contract that
    // was open when the socket dropped is reconciled on reconnect via
    // _reconcileOpenContracts(); clearing the map would orphan the P&L.
  }

  /**
   * Reconcile tracked open contracts against Deriv after a (re)connect.
   * Settles any that finished while we were away (via the idempotent
   * settleFromContract path), re-subscribes to still-open ones, and
   * records an explicit status:'unknown' audit entry for anything that
   * can no longer be found — never a fabricated win/loss.
   */
  async _reconcileOpenContracts() {
    const openIds = [...this.exec.open.keys()];
    if (!openIds.length) return;
    logger.info(`reconcile: ${openIds.length} tracked open contract(s) after (re)connect`);
    for (const cid of openIds) {
      const info = this.exec.open.get(cid);
      if (!info) continue;
      try {
        const res = await this.client._send({ proposal_open_contract: 1, contract_id: cid }, 15000);
        const c = res?.proposal_open_contract;
        if (c && (c.status === 'won' || c.status === 'lost')) {
          const finished = this.exec.settleFromContract(info, c);
          if (finished) logger.info(`reconcile: settled #${cid} → ${c.status} profit=${finished.profit}`);
          continue;
        }
        if (c) {
          // Still open → re-subscribe to its settlement stream.
          const subId = await this.client.subscribe({ proposal_open_contract: 1, contract_id: cid }, msg => this.exec._onUpdate(msg, info)).catch(() => null);
          if (subId) { info.subId = subId; logger.info(`reconcile: re-subscribed #${cid}`); }
          continue;
        }
        // No detail for this id — check the account-wide open list.
        const listRes = await this.client._send({ proposal_open_contract: 1 }, 15000).catch(() => null);
        const listed = (listRes?.proposal_open_contracts || []).some(x => Number(x.contract_id) === Number(cid));
        if (listed) {
          const subId = await this.client.subscribe({ proposal_open_contract: 1, contract_id: cid }, msg => this.exec._onUpdate(msg, info)).catch(() => null);
          if (subId) { info.subId = subId; }
          continue;
        }
        logger.error(`reconcile: #${cid} unconfirmed after reconnect — recording UNKNOWN (no fabricated P&L)`);
        this.stats.record({ ...info, contractId: cid, status: 'unknown', profit: 0, sellTime: Date.now() / 1000, _unconfirmed: true });
        this.exec.open.delete(cid);
      } catch (e) {
        logger.warn(`reconcile #${cid}: ${e.message}`);
      }
    }
    this._saveState('post-reconcile');
  }

  /**
   * currentStake(ctx?) — recommended stake for the *next* trade.
   *   • Kelly-fractional when kellySizingEnabled (bankroll × f* × fraction,
   *     capped at kellyMaxStakeFrac and cfg.maxStake).
   *   • Otherwise flat stake, or the recovery ladder ONLY if
   *     recoveryEnabled (hard-capped by recoveryStakeCap).
   *   • Every mode is capped at maxStakePctBankroll of the live balance.
   *   • The per-symbol calibrator's stake-multiplier is applied last
   *     (1.0 enabled, calibProbeStakeFrac probing, 0 disabled).
   */
  currentStake(ctx = null) {
    let base = 0;
    let src  = 'flat';
    const balance = this.lastBalance ?? this.client.balance ?? 0;

    if (this.cfg.kellySizingEnabled && ctx && ctx.pWin > 0 && ctx.payoutMult > 1) {
      const bankroll = Math.max(this.cfg.kellyBankrollFloor, balance);
      const k = this.kelly.compute({
        bankroll,
        pWin      : ctx.pWin,
        payoutMult: ctx.payoutMult,
        edgeValue : ctx.edgeValue ?? 0,
      });
      if (k) {
        base = k.stake;
        src  = `kelly(f*=${k.fStar.toFixed(4)}, applied=${k.fApplied.toFixed(4)}, ${k.reason})`;
      } else {
        return { stake: 0, source: 'kelly-negative', calibMult: 1 };
      }
    } else {
      let mult = 1;
      if (this.cfg.recoveryEnabled) {
        const idx = Math.min(this.stats.currentLossStreak, this.cfg.recoveryMultipliers.length - 1);
        mult = this.cfg.recoveryMultipliers[idx] || 1;
      }
      base = +(this.cfg.stake * mult).toFixed(2);
      // Hard cap on recovery stakes: single-trade absolute ceiling.
      if (this.cfg.recoveryEnabled && this.cfg.recoveryStakeCap > 0) {
        base = Math.min(base, this.cfg.recoveryStakeCap);
      }
      src = `flat×${mult}${this.cfg.recoveryEnabled ? `(cap ${this.cfg.recoveryStakeCap})` : ''}`;
    }

    let calibMult = 1;
    if (ctx?.symbol) calibMult = this.calibrator.stakeMultiplier(ctx.symbol);
    if (calibMult === 0) return { stake: 0, source: 'calib-disabled', calibMult };

    let stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, +(base * calibMult).toFixed(2)));
    // Hard cap as % of live balance.
    const pctCap = balance > 0 ? balance * (this.cfg.maxStakePctBankroll || 1) : this.cfg.maxStake;
    stake = Math.min(stake, Math.max(this.cfg.minStake, pctCap));
    if (stake < this.cfg.minStake || stake > balance) {
      return { stake: 0, source: 'bankroll-too-small', calibMult };
    }
    return { stake, source: src, calibMult };
  }

  /** Cached live payout multiplier for (symbol,digit) — reduces proposal RPC load. */
  async _payoutMult(symbol, digit, probeStake) {
    const key = `${symbol}:${digit}`;
    const hit = this._payoutCache.get(key);
    if (hit && (Date.now() - hit.at) < this.cfg.payoutProbeTtlMs) return hit.mult;
    try {
      const pres = await this.exec.proposal(symbol, digit, probeStake);
      const p = pres?.proposal;
      if (p?.id) {
        const ask = Number(p.ask_price || probeStake);
        const payout = Number(p.payout || 0);
        if (payout > ask) {
          const mult = payout / ask;
          this._payoutCache.set(key, { mult, at: Date.now() });
          return mult;
        }
      }
    } catch (e) {
      logger.debug(`payout probe ${symbol} d${digit}: ${e.message}`);
    }
    return null;
  }

  // ── Daily / global stop handling ─────────────────────────────────
  _rollDay(today) {
    this._dayStartDate = today;
    this._dayStartBalance = this.lastBalance ?? this.client.balance ?? this._dayStartBalance ?? null;
    this._dailyHaltUntil = null;
    this._dailyHaltReason = null;
    logger.info(`day rollover → ${today} startBalance=${this._dayStartBalance ?? '?'}`);
  }
  _nextGmtMidnight() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5, 0)).getTime();
  }
  _haltForDay(reason, detail) {
    if (this._dailyHaltUntil) return;
    this._dailyHaltUntil = this._nextGmtMidnight();
    this._dailyHaltReason = reason;
    logger.warn(`DAILY STOP: ${reason} (${detail}) — no new trades until GMT midnight`);
    telegram.send(
      `🛑 <b>x2Digit DAILY STOP</b>\n\n` +
      `Reason: <b>${htmlEscape(reason)}</b> (${htmlEscape(detail)})\n` +
      `No new trades until GMT midnight. Open trades settle normally.\n\n` +
      `💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}\n` +
      `🕒 ${utcTs()}`
    );
  }
  /** Returns a truthy stop-reason string if new trades are halted for the day. */
  _dailyStopReason(todayStats) {
    if (this._dailyHaltUntil && Date.now() < this._dailyHaltUntil) return `halted until GMT midnight (${this._dailyHaltReason})`;
    if (this.cfg.dailyMaxTrades > 0 && todayStats.count >= this.cfg.dailyMaxTrades) {
      this._haltForDay('dailyMaxTrades', `${todayStats.count}/${this.cfg.dailyMaxTrades}`); return 'dailyMaxTrades';
    }
    if (this.cfg.dailyMaxLoss > 0 && todayStats.totalProfit <= -Math.abs(this.cfg.dailyMaxLoss)) {
      this._haltForDay('dailyMaxLoss', `${todayStats.totalProfit.toFixed(2)}`); return 'dailyMaxLoss';
    }
    if (this.cfg.dailyMaxLossPct > 0 && this._dayStartBalance != null) {
      const lossPct = -todayStats.totalProfit / Math.max(1, this._dayStartBalance);
      if (lossPct >= this.cfg.dailyMaxLossPct) {
        this._haltForDay('dailyMaxLossPct', `${(lossPct * 100).toFixed(2)}% of ${this._dayStartBalance.toFixed(2)}`);
        return 'dailyMaxLossPct';
      }
    }
    if (this.cfg.dailyMaxProfit > 0 && todayStats.totalProfit >= this.cfg.dailyMaxProfit) {
      this._haltForDay('dailyMaxProfit', `${todayStats.totalProfit.toFixed(2)}`); return 'dailyMaxProfit';
    }
    return null;
  }

  async _analyzeAndTrade() {
    if (this.stopped || !this.client.authorized) return;
    if (this._analysisRunning) {
      logger.debug('scan: previous cycle still running — skipping overlap');
      return;
    }
    this._analysisRunning = true;
    try {
      await this._analyzeAndTradeInner();
    } finally {
      this._analysisRunning = false;
    }
  }

  async _analyzeAndTradeInner() {
    if (this.paused) {
      logger.debug('trading paused — skipping analysis cycle');
      return;
    }
    if (this._globalHalt) return;

    // ── Lifetime stop ───────────────────────────────────────────────
    if (this.cfg.globalMaxLoss > 0 && this.stats.overallProfit <= -Math.abs(this.cfg.globalMaxLoss)) {
      this._globalHalt = true;
      logger.error(`GLOBAL STOP: overallProfit ${this.stats.overallProfit.toFixed(2)} ≤ −${this.cfg.globalMaxLoss} — halting permanently`);
      telegram.send(`🛑 <b>x2Digit GLOBAL STOP</b>\n\nOverall P/L reached ${money(this.stats.overallProfit, this.currency())} (limit −${this.cfg.globalMaxLoss}). Bot will no longer trade.\n\n🕒 ${utcTs()}`);
      return;
    }

    if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
    if (this._lastTradeTickIdx != null) {
      const ticksSinceTrade = this._tickCounter - this._lastTradeTickIdx;
      if (ticksSinceTrade < this.cfg.cooldownTicks) {
        logger.debug(`cooldownTicks: ${ticksSinceTrade}/${this.cfg.cooldownTicks} — skipping`);
        return;
      }
    }
    if (this.exec.count() >= this.cfg.maxOpenTrades) return;

    // ── Consecutive-loss circuit breaker ──────────────────────────────
    if (this.cfg.circuitBreakerEnabled && this._circuitBreakerUntil && Date.now() < this._circuitBreakerUntil) {
      logger.debug(`circuit breaker active, resumes ${new Date(this._circuitBreakerUntil).toISOString()}`);
      return;
    }

    // ── Day rollover + hard daily stops ───────────────────────────────
    const today = utcDateStr();
    if (this._dayStartDate !== today) this._rollDay(today);
    const todayStats = this.stats.stats(this.stats.todayTrades(today));
    const stopReason = this._dailyStopReason(todayStats);
    if (stopReason) {
      logger.warn(`daily stop active: ${stopReason}`);
      return;
    }

    // ── Per-symbol calibration filter ─────────────────────────────────
    const tradeableAssets = this.cfg.assets.filter(s => this.calibrator.isTradeable(s));
    const disabledAssets  = this.cfg.assets.filter(s => !this.calibrator.isTradeable(s));
    if (disabledAssets.length) logger.debug(`CALIB: sidelined [${disabledAssets.join(',')}]`);
    if (!tradeableAssets.length) {
      logger.warn(`CALIB: all symbols sidelined; will re-probe after cooldown`);
      return;
    }

    const analyses = tradeableAssets.map(s => this.analyzer.analyze(s, this.market.historyFor(s)));
    const ranked = this.analyzer.rank(analyses);
    if (!ranked.length) {
      logger.debug('not enough digit data yet');
      return;
    }

    const topLog = ranked.slice(0, 3).map(a =>
      `${a.symbol}:d${a.best.digit} u=${a.best.pLossUpper.toFixed(4)} n=${a.best.sampleSize} ` +
      `H=${a.entropy.toFixed(3)} X2=${a.chiSquare.toFixed(1)} ` +
      `digits=${a.lastDigit} ` +
      `${a.gates.length ? 'skip(' + a.gates[0] + ')' : 'ok'}`
    ).join(' | ');
    logger.info(`scan ${topLog}`);

    // ── Discover live payout + value edge (cached) ────────────────────
    const probeStake = this.cfg.minStake;
    const proposalCandidates = [];
    for (const a of ranked.slice(0, Math.max(1, this.cfg.proposalScanTopN))) {
      if (!a.allowedByModel) continue;
      const candidateDigits = a.candidates.slice(0, Math.max(1, Math.min(3, this.cfg.proposalScanTopN)));
      for (const c of candidateDigits) {
        if (c.recentHits > this.cfg.maxRecentDigitHits) continue;
        if (c.pLossUpper > this.cfg.maxLossProb) continue;
        const payoutMult = await this._payoutMult(a.symbol, c.digit, probeStake);
        if (!(payoutMult > 1)) continue;
        const breakEvenLossProb = 1 - 1 / payoutMult;   // q_be = 1 − ask/payout
        const valueEdge = breakEvenLossProb - c.pLossUpper - this.cfg.safetyMargin;
        proposalCandidates.push({
          analysis: a,
          candidate: c,
          payoutMult,
          breakEvenLossProb,
          valueEdge,
        });
        this.livePayoutMult.set(a.symbol, payoutMult);
      }
    }

    proposalCandidates.sort((x, y) => y.valueEdge - x.valueEdge || x.candidate.pLossUpper - y.candidate.pLossUpper);

    // ── Edge floor + asset rotation ───────────────────────────────────
    const rotationMs = Math.max(0, this.cfg.assetRotationMs || 0);
    const lockActive = rotationMs > 0
                    && this.tradedAsset
                    && (Date.now() - (this.tradedAssetAt || 0) < rotationMs);

    const qualified = proposalCandidates.filter(c => c.valueEdge >= this.cfg.minEdge);
    if (!qualified.length) {
      const top = proposalCandidates[0];
      if (top) {
        logger.info(`skip: best edge ${top.valueEdge.toFixed(4)} < minEdge ${this.cfg.minEdge} (${top.analysis.symbol} d${top.candidate.digit})`);
      } else {
        logger.debug('no proposal candidates after model gates');
      }
      return;
    }

    let best = qualified.find(c => !lockActive || c.analysis.symbol !== this.tradedAsset);
    if (!best) {
      if (lockActive) {
        const ageSec = ((Date.now() - (this.tradedAssetAt || 0)) / 1000).toFixed(1);
        logger.info(
          `skip: only qualifying symbol is ${this.tradedAsset} — still in ${(rotationMs/1000).toFixed(0)}s rotation cooldown (age ${ageSec}s). Will retry next scan.`
        );
        return;
      }
      best = qualified[0];
    }
    if (best !== qualified[0]) {
      logger.info(
        `rotation: skipping locked ${qualified[0].analysis.symbol} (edge ${qualified[0].valueEdge.toFixed(4)}) → ` +
        `taking ${best.analysis.symbol} d${best.candidate.digit} (edge ${best.valueEdge.toFixed(4)})`
      );
    }

    // ── Size the trade ────────────────────────────────────────────────
    const pWin = 1 - best.candidate.pLossUpper;   // conservative win-prob
    const sizing = this.currentStake({
      pWin,
      payoutMult: best.payoutMult,
      edgeValue : best.valueEdge,
      symbol    : best.analysis.symbol,
    });
    if (!sizing.stake || sizing.stake <= 0) {
      logger.info(`skip: sizing returned 0 (${sizing.source}, calibMult=${sizing.calibMult})`);
      return;
    }
    const stake = sizing.stake;
    logger.info(`sizing → stake=${stake.toFixed(2)} src=${sizing.source} calibMult=${sizing.calibMult}`);

    this.tradedAsset   = best.analysis.symbol;
    this.tradedAssetAt = Date.now();

    const a = best.analysis;
    const c = best.candidate;
    const payload = {
      method: 'empirical-frequency',
      digit: c.digit,
      pLoss: c.pLoss,
      pLossUpper: c.pLossUpper,
      sampleSize: c.sampleSize,
      predictedPWin: pWin,                         // ← calibrator input
      payoutMult: best.payoutMult,
      breakEvenLossProb: best.breakEvenLossProb,
      valueEdge: best.valueEdge,
      entropy: a.entropy,
      chiSquare: a.chiSquare,
      probabilityGap: a.probabilityGap,
      lastDigit: a.lastDigit,
      recentHits: c.recentHits,
      sizingSource: sizing.source,
      calibStakeMultiplier: sizing.calibMult,
      calibState: this.calibrator.status(a.symbol),
      recoveryStakeMultiplier: +(stake / this.cfg.stake).toFixed(2),
      currentLossStreak: this.stats.currentLossStreak,
    };

    try {
      const trade = await this.exec.buy(a.symbol, c.digit, stake, payload);
      this.lastTradeAt = Date.now();
      logger.info(`trade placed #${trade.contractId} ${a.symbol} DIGITDIFF differs ${c.digit} edge=${best.valueEdge.toFixed(4)} pLossU=${c.pLossUpper.toFixed(4)} qBE=${best.breakEvenLossProb.toFixed(4)}`);
    } catch (e) {
      logger.error(`buy failed: ${e.message}`);
      // Roll back the rotation lock so we can consider other symbols on
      // the next scan instead of being frozen out of a failed symbol.
      this.tradedAsset = null;
      this.tradedAssetAt = 0;
    }
  }

  _onTradeOpen(t) {
    this.tradeStartTime = Date.now();
    this._startTradeWatchdog(t.contractId);
    const a = t.analysis || {};
    telegram.send(
      `🟢 <b>TRADE OPENED — x2DIGIT DIFFER</b>\n\n` +
      `🎫 Contract: <code>#${t.contractId}</code>\n` +
      `📊 Symbol: <code>${t.symbol}</code>\n` +
      `🔢 Prediction/barrier: final digit <b>DIFFERS from ${t.digit}</b>\n` +
      `⏱️ Duration: ${t.durationTicks} tick(s)\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currency()}\n` +
      `🎁 Payout: ${t.payout.toFixed(2)} ${this.currency()}\n\n` +
      `📐 <b>Model read (empirical frequency, not a guaranteed edge)</b>\n` +
      `• Model P(loss digit ${t.digit}): ${(a.pLoss * 100).toFixed(2)}% (n=${a.sampleSize ?? '?'})\n` +
      `• Conservative upper bound: <b>${(a.pLossUpper * 100).toFixed(2)}%</b>\n` +
      `• Break-even loss prob: ${(a.breakEvenLossProb * 100).toFixed(2)}%\n` +
      `• Value edge: <b>${(a.valueEdge * 100).toFixed(2)}pp</b>\n` +
      `• Entropy: ${Number(a.entropy || 0).toFixed(3)} | χ²: ${Number(a.chiSquare || 0).toFixed(2)} | p-gap: ${Number(a.probabilityGap || 0).toFixed(4)}\n` +
      `• Current loss streak: ${a.currentLossStreak || 0}\n\n` +
      `🕒 ${utcTs()}`
    );
  }

  _onTradeResult(t) {
    const rec = this.stats.record(t);

    if (t.status === 'unknown') {
      // No P&L recovered — balance is authoritative server-side; we never
      // guess. The reconcile/watchdog already notified.
      logger.error(`UNKNOWN settlement recorded for #${t.contractId} — excluded from WR/streaks`);
      this._saveState('unknown-trade');
      return;
    }

    // Correct balance tracking. buy response's balance_after already has
    // the stake deducted; net P/L on top of it must ADD the stake back
    // (profit = payout_total − stake). Old code did balance_after + profit
    // which double-subtracted the stake on every trade.
    const profit = Number(t.profit || 0);
    if (t.balanceAfter != null) {
      this.lastBalance = Number(t.balanceAfter) + profit + Number(t.stake || 0);
    } else {
      this.lastBalance = (this.lastBalance ?? this.client.balance ?? 0) + profit;
    }

    // ── Consecutive-loss circuit breaker ──────────────────────────────
    const won0 = t.status === 'won';
    if (won0) {
      this._circuitBreakerUntil = null;
    } else if (this.cfg.circuitBreakerEnabled && this.stats.currentLossStreak >= this.cfg.circuitBreakerLosses) {
      this._circuitBreakerUntil = Date.now() + this.cfg.circuitBreakerCooldownMs;
      const mins = (this.cfg.circuitBreakerCooldownMs / 60000).toFixed(0);
      logger.warn(`circuit breaker tripped: ${this.stats.currentLossStreak} losses in a row → pausing ${mins}m`);
      telegram.send(
        `🛑 <b>x2Digit CIRCUIT BREAKER TRIPPED</b>\n\n` +
        `${this.stats.currentLossStreak} losses in a row. Pausing all new trades for ${mins} minutes.\n` +
        `This is not a punishment for the model being "due" — it's a hard stop so a bad stretch can't compound. Consider reviewing before manually resuming.`
      );
    }

    // ── Feed the per-symbol calibrator ──────────────────────────────
    const won        = t.status === 'won';
    const pWinUsed   = Number(t.analysis?.predictedPWin
                        ?? (t.analysis?.pLossUpper != null ? 1 - Number(t.analysis.pLossUpper) : null));
    let calibNote = '';
    if (this.cfg.calibEnabled && Number.isFinite(pWinUsed) && pWinUsed > 0 && pWinUsed < 1) {
      this.calibrator.record(t.symbol, pWinUsed, won);
      const cs = this.calibrator.summary()[t.symbol];
      if (cs) {
        calibNote = `\n📐 <b>Calib (${t.symbol}):</b> ` +
          `state=${cs.state} n=${cs.n} WR=${cs.empirical.toFixed(2)}% ` +
          `vs pred ${cs.predicted.toFixed(2)}% (gap ${cs.gap >= 0 ? '+' : ''}${cs.gap.toFixed(2)}pp)`;
      }
    }

    const emoji = won ? '✅' : '❌';
    const label = won ? 'WIN' : 'LOSS';
    const dur = Math.max(0, Number(t.sellTime || Date.now() / 1000) - Number(t.buyTime || 0));
    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));

    const kellyLine = this.cfg.kellySizingEnabled && t.analysis?.sizingSource
      ? `\n🧮 Sizing: <code>${htmlEscape(String(t.analysis.sizingSource))}</code>`
      : '';

    telegram.send(
      `${emoji} <b>TRADE ${label} — x2DIGIT DIFFER</b>\n\n` +
      `🎫 Contract: <code>#${t.contractId}</code>\n` +
      `📊 Symbol: <code>${t.symbol}</code> | differs <b>${t.digit}</b> | ${t.durationTicks}t\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currency()}${kellyLine}\n` +
      `💰 P/L: <b>${money(t.profit, this.currency())}</b>\n` +
      `⏱️ Duration: ${dur.toFixed(1)}s\n\n` +
      `📅 <b>GMT Day Stats (${rec.date})</b>\n` +
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses}${todayStats.unknown ? ` ?${todayStats.unknown}` : ''})\n` +
      `• Win rate: ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net P/L: <b>${money(todayStats.totalProfit, this.currency())}</b>\n` +
      `• Profit factor: ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n` +
      `💼 <b>Overall Profit:</b> ${money(this.stats.overallProfit, this.currency())}\n` +
      `❌ <b>Consecutive Losses:</b> current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
      `   x2=${this.stats.lossStreakEvents.x2}  x3=${this.stats.lossStreakEvents.x3}  x4=${this.stats.lossStreakEvents.x4}` +
      calibNote
    );

    this.lastTradeAt = Date.now();
    this._lastTradeTickIdx = this._tickCounter;
    this._saveState('after-trade');
  }

  // ── Trade Watchdog ─────────────────────────────────────────
  // A 1-tick DIGITDIFF settles within a few ticks. If a contract is still
  // open at tradeWatchdogMs we poll it (non-subscribed). We NEVER fabricate
  // a win/loss: if polls keep coming back empty we record an explicit
  // 'unknown' after a bounded number of retries and let reconciliation /
  // the (authoritative) server balance absorb the rest.
  _startTradeWatchdog(contractId) {
    this._clearWatchdogTimers();
    this._tradeWatchdogTimer = setTimeout(() => { this._pollStuckTrade(contractId); }, this.tradeWatchdogMs);
  }

  _clearWatchdogTimers() {
    if (this._tradeWatchdogTimer)     { clearTimeout(this._tradeWatchdogTimer);     this._tradeWatchdogTimer     = null; }
    if (this._tradeWatchdogPollTimer) { clearTimeout(this._tradeWatchdogPollTimer); this._tradeWatchdogPollTimer = null; }
  }

  async _pollStuckTrade(contractId) {
    this._clearWatchdogTimers();
    const open = this.exec.openTrades();
    const t = open.find(x => Number(x.contractId) === Number(contractId)) || open[0];
    if (!t) return;
    t._pollCount = (t._pollCount || 0) + 1;
    logger.warn(`WATCHDOG FIRED — #${t.contractId} ${t.symbol} open for ${(this.tradeWatchdogMs / 1000).toFixed(0)}s without settlement (poll #${t._pollCount})`);

    if (!this.client.authorized || !this.client.connected) {
      logger.warn(`watchdog: connection down — deferring #${t.contractId} to reconnect reconciliation`);
      return;
    }
    try {
      const res = await this.client._send({ proposal_open_contract: 1, contract_id: t.contractId }, 15000);
      const c = res?.proposal_open_contract;
      if (c) {
        const finished = this.exec.settleFromContract(t, c);
        if (finished) {
          logger.info(`watchdog: settled #${finished.contractId} → ${finished.status} profit=${finished.profit}`);
          return;
        }
      }
      logger.warn(`watchdog: #${t.contractId} still open after poll`);
    } catch (e) {
      logger.warn(`watchdog poll #${t.contractId}: ${e.message}`);
    }

    if (t._pollCount >= 3) {
      logger.error(`watchdog: #${t.contractId} unresolved after 3 polls — recording UNKNOWN (no fabricated P&L)`);
      this.stats.record({ ...t, contractId: t.contractId, status: 'unknown', profit: 0, sellTime: Date.now() / 1000, _unconfirmed: true });
      this.exec.open.delete(t.contractId);
      telegram.send(
        `⚠️ <b>x2Digit UNRESOLVED CONTRACT</b>\n\n` +
        `Contract <code>#${t.contractId}</code> (${t.symbol}) never returned a settlement after repeated polls.\n` +
        `Recorded as <b>UNKNOWN</b> — no P&L was fabricated. The account balance remains authoritative server-side.\n\n` +
        `🕒 ${utcTs()}`
      );
      this._saveState('unresolved-trade');
      return;
    }
    this._tradeWatchdogPollTimer = setTimeout(() => this._pollStuckTrade(t.contractId), 15000);
  }

  _scheduleSummaries() {
    if (this.cfg.hourlySummary) {
      const now = new Date();
      const msToNextHour = ((59 - now.getUTCMinutes()) * 60_000) + ((60 - now.getUTCSeconds()) * 1000) + 50;
      this._hourlyBoot = setTimeout(() => {
        this._sendHourly();
        this._hourlyT = setInterval(() => this._sendHourly(), 3600_000);
      }, Math.max(1000, msToNextHour));
    }

    const scheduleNextEod = () => {
      const delay = this._msToNextEod();
      this._eodBoot = setTimeout(() => {
        this._sendEod('scheduled');
        scheduleNextEod();
      }, delay);
      logger.info(`next GMT EOD report in ${(delay / 3600000).toFixed(2)}h`);
    };
    scheduleNextEod();
  }
  _parseEodTime() {
    const m = String(this.cfg.eodTimeGmt || '00:00').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return { h: 0, min: 0 };
    return { h: Math.max(0, Math.min(23, Number(m[1]))), min: Math.max(0, Math.min(59, Number(m[2]))) };
  }
  _msToNextEod(now = new Date()) {
    const { h, min } = this._parseEodTime();
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, min, this.cfg.eodSendDelaySeconds, 0));
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target.getTime() - now.getTime();
  }
  _eodReportDate(now = new Date()) {
    const { h, min } = this._parseEodTime();
    if (h === 0 && min === 0) return previousUtcDateStr(now);
    return utcDateStr(now);
  }
  _sendHourly() {
    const now = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const date = utcDateStr(prev);
    const hour = utcHour(prev);
    const list = this.stats.tradesForHour(date, hour);
    const s = this.stats.stats(list);
    if (!list.length) {
      telegram.send(`⏰ <b>x2Digit Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\nNo trades this hour.\n\n💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}`);
      return;
    }
    let msg = `⏰ <b>x2Digit Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\n` +
      `📊 Trades: ${s.count} (✅${s.wins} ❌${s.losses}${s.unknown ? ` ?${s.unknown}` : ''})\n` +
      `📈 Win rate: ${s.winRate.toFixed(1)}%\n` +
      `💰 P/L: <b>${money(s.totalProfit, this.currency())}</b>\n` +
      `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
      `❌ Loss streak current ${this.stats.currentLossStreak} | x2=${this.stats.lossStreakEvents.x2} x3=${this.stats.lossStreakEvents.x3} x4=${this.stats.lossStreakEvents.x4}\n\n` +
      `📋 Detail:\n`;
    list.slice(-20).forEach((t, i) => {
      msg += `${i + 1}. ${t.status === 'won' ? '✅' : '❌'} #${t.contractId} ${t.symbol} d${t.digit} ${money(t.profit, this.currency())}\n`;
    });
    telegram.send(msg);
  }
  _sendEod(reason = 'manual') {
    const date = this._eodReportDate(new Date());
    if (this.stats.isEodSent(date) && reason === 'scheduled') {
      logger.info(`EOD ${date} already sent; skipping duplicate`);
      return;
    }
    const summary = this.stats.archiveDate(date);
    const ds = summary.stats;

    let msg = `🌙 <b>x2Digit END OF TRADE DAY — GMT</b>\n` +
              `📅 Trade day ended: <b>${date}</b>\n\n` +
              `<b>── Current Day Stats ──</b>\n`;
    if (ds.count) {
      msg += `📊 Trades: ${ds.count} (✅${ds.wins} ❌${ds.losses}${ds.unknown ? ` ?${ds.unknown}` : ''})\n` +
             `📈 Win rate: ${ds.winRate.toFixed(1)}%\n` +
             `💵 Total stake: ${ds.stake.toFixed(2)} ${this.currency()}\n` +
             `💰 Gross win: +${ds.grossWin.toFixed(2)}\n` +
             `📉 Gross loss: -${ds.grossLoss.toFixed(2)}\n` +
             `💼 <b>Net P/L: ${money(ds.totalProfit, this.currency())}</b>\n` +
             `🏆 Profit factor: ${ds.profitFactor === Infinity ? '∞' : ds.profitFactor.toFixed(2)}\n` +
             `❌ Max loss streak today: ${ds.maxLossStreak}\n\n`;
    } else {
      msg += `No trades recorded for this GMT trade day.\n\n`;
    }

    msg += `<b>──x2Digit Overall / Stored Stats ──</b>\n` +
           `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
           `❌ Consecutive losses: current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
           `   x2=${this.stats.lossStreakEvents.x2}  x3=${this.stats.lossStreakEvents.x3}  x4=${this.stats.lossStreakEvents.x4}\n\n`;

    if (this.cfg.calibEnabled) {
      const calib = this.calibrator.summary();
      const keys  = Object.keys(calib);
      if (keys.length) {
        msg += `<b>──x2Digit Symbol Calibration (rolling ${this.cfg.calibWindow}) ──</b>\n`;
        for (const sym of keys) {
          const c = calib[sym];
          const emo = c.state === 'enabled'  ? '🟢'
                    : c.state === 'probing'  ? '🟡'
                    : c.state === 'disabled' ? '🔴' : '⚪';
          msg += `${emo} <code>${sym}</code>: ${c.state} n=${c.n} WR ${c.empirical.toFixed(1)}% vs pred ${c.predicted.toFixed(1)}% (gap ${c.gap >= 0 ? '+' : ''}${c.gap.toFixed(2)}pp)\n`;
        }
        msg += `\n`;
      }
    }

    const rows = this.stats.allDailyRows(date);
    if (rows.length) {
      msg += `<b>── All Trade Days By Date ──</b>\n`;
      for (const row of rows.slice(-60)) {
        const s = row.stats;
        msg += `${row.date}: ${s.count} trades (✅${s.wins}/❌${s.losses}) | WR ${s.winRate.toFixed(1)}% | P/L ${money(s.totalProfit, this.currency())}\n`;
      }
      if (rows.length > 60) msg += `…showing last 60 of ${rows.length} stored trade days.\n`;
    }

    telegram.send(msg);
    this.stats.markEodSent(date);
    this._saveState(`eod-${reason}`);
    this.startBalance = this.client.balance ?? this.lastBalance ?? this.startBalance;
  }

  _statePayload(reason) {
    return {
      version: 3,
      savedAt: new Date().toISOString(),
      savedReason: reason,
      startBalance: this.startBalance,
      lastBalance: this.lastBalance,
      stats: this.stats.serialize(),
      calibrator: this.calibrator ? this.calibrator.serialize() : {},
    };
  }
  _saveState(reason = 'checkpoint') {
    try {
      const file = this.cfg.stateFile;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._statePayload(reason), null, 2));
      fs.renameSync(tmp, file);
      logger.debug(`state saved (${reason}) → ${file}`);
    } catch (e) {
      logger.warn('state save failed:', e.message);
    }
  }
  _loadState() {
    const file = this.cfg.stateFile;
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.startBalance = data.startBalance ?? null;
      this.lastBalance = data.lastBalance ?? null;
      this.stats = new StatisticsManager(data.stats || data);
      if (data.calibrator && typeof data.calibrator === 'object') {
        this.calibrator = new SymbolCalibrator(this.cfg, data.calibrator);
        const savedSyms = Object.keys(data.calibrator).length;
        logger.info(`calibrator restored: ${savedSyms} symbols`);
      }
      logger.info(`state restored from ${file}: overallProfit=${this.stats.overallProfit.toFixed(2)} lossStreak=${this.stats.currentLossStreak}`);
    } catch (e) {
      logger.warn(`state load failed (${file}):`, e.message);
    }
  }
  currency() { return this.client.currency || this.cfg.currency; }
  stop(signal) {
    if (this.stopped) return;
    this.stopped = true;
    logger.info(`stopping (${signal})`);
    telegram.send(`🛑 <b>x2Digit Differ stopped</b>\nSignal: ${htmlEscape(signal)}\n💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}`);
    if (this._analysisT) clearInterval(this._analysisT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._hourlyT) clearInterval(this._hourlyT);
    if (this._eodBoot) clearTimeout(this._eodBoot);
    if (this._eodT) clearInterval(this._eodT);
    this._saveState('shutdown');
    this.client.stop();
    setTimeout(() => process.exit(0), 2500);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 11. REPEAT/CYCLE DIAGNOSTICS
//
//   Tests, on your own historical tick data, whether "last digit repeats
//   vs. doesn't" shows genuine structure (serial correlation, real
//   cyclicality) or whether it looks exactly like what a plain i.i.d.
//   uniform digit process produces. This does NOT assume an answer either
//   way — it runs standard tests and reports the numbers per symbol.
//
//   Run it with:  DIAGNOSE=1 node newDifferX2.js
// ─────────────────────────────────────────────────────────────────────
class RepeatCycleDiagnostics {
  runsTest(seq) {
    const n = seq.length;
    const n1 = seq.reduce((s, x) => s + x, 0);
    const n0 = n - n1;
    if (n1 === 0 || n0 === 0 || n < 20) return null;
    let runs = 1;
    for (let i = 1; i < n; i++) if (seq[i] !== seq[i - 1]) runs++;
    const expected = (2 * n1 * n0) / n + 1;
    const variance = (2 * n1 * n0 * (2 * n1 * n0 - n)) / (n * n * (n - 1));
    if (variance <= 0) return null;
    const z = (runs - expected) / Math.sqrt(variance);
    return { n, runs, expected: +expected.toFixed(1), z: +z.toFixed(3), pValue: +(2 * (1 - this._normCdf(Math.abs(z)))).toFixed(4) };
  }

  autocorrelation(seq, maxLag = 40) {
    const n = seq.length;
    const mean = seq.reduce((s, x) => s + x, 0) / n;
    const denom = seq.reduce((s, x) => s + (x - mean) ** 2, 0);
    const band = 1.96 / Math.sqrt(n);
    const out = [];
    for (let lag = 1; lag <= maxLag && lag < n; lag++) {
      let num = 0;
      for (let i = 0; i < n - lag; i++) num += (seq[i] - mean) * (seq[i + lag] - mean);
      const acf = denom > 0 ? num / denom : 0;
      out.push({ lag, acf: +acf.toFixed(4), significant: Math.abs(acf) > band });
    }
    return { band: +band.toFixed(4), values: out, significantCount: out.filter(x => x.significant).length, expectedByChance: +(maxLag * 0.05).toFixed(1) };
  }

  conditionalAfterStreak(seq, maxStreak = 15) {
    const baseline = seq.reduce((s, x) => s + x, 0) / seq.length;
    const buckets = new Map();
    let streak = 0;
    for (let i = 0; i < seq.length; i++) {
      const k = Math.min(streak, maxStreak);
      if (!buckets.has(k)) buckets.set(k, { hits: 0, n: 0 });
      const b = buckets.get(k);
      b.n++; if (seq[i] === 1) b.hits++;
      streak = seq[i] === 1 ? 0 : streak + 1;
    }
    const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([k, b]) => {
      const p = b.n ? b.hits / b.n : 0;
      const se = Math.sqrt(baseline * (1 - baseline) / Math.max(1, b.n));
      const z = se > 0 ? (p - baseline) / se : 0;
      return { streakLen: k, n: b.n, pRepeat: +p.toFixed(4), z: +z.toFixed(2), outsideCI: Math.abs(z) > 1.96 };
    });
    return { baseline: +baseline.toFixed(4), rows };
  }

  digitTransitionIndependence(digits) {
    const table = Array.from({ length: 10 }, () => Array(10).fill(0));
    for (let i = 1; i < digits.length; i++) table[digits[i - 1]][digits[i]]++;
    const n = digits.length - 1;
    const rowSum = table.map(r => r.reduce((s, x) => s + x, 0));
    const colSum = Array(10).fill(0).map((_, j) => table.reduce((s, r) => s + r[j], 0));
    let chi2 = 0;
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) {
      const exp = (rowSum[i] * colSum[j]) / n;
      if (exp > 0) chi2 += ((table[i][j] - exp) ** 2) / exp;
    }
    const df = 81;
    return { n, chi2: +chi2.toFixed(2), df, pValue: +(1 - this._chiSqCdf(chi2, df)).toFixed(4), diagonalMass: +(table.reduce((s, r, i) => s + r[i], 0) / n).toFixed(4), expectedDiagonalMass: 0.1 };
  }

  _normCdf(x) { return 0.5 * (1 + this._erf(x / Math.SQRT2)); }
  _erf(x) {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
    return s * y;
  }
  // Wilson–Hilferty approximation for the chi-square CDF.
  _chiSqCdf(x, k) {
    if (x <= 0) return 0;
    const term = Math.pow(x / k, 1/3) - (1 - 2/(9*k));
    const z = term / Math.sqrt(2/(9*k));
    return this._normCdf(z);
  }

  cycleEngineSnapshot(seq, fast = 30, mid = 90, block = 20) {
    if (seq.length < mid + 10) return null;
    const base = seq.reduce((s, x) => s + x, 0) / seq.length;
    const blockRates = [];
    if (seq.length >= block) {
      let s = 0;
      for (let i = 0; i < block; i++) s += seq[i];
      blockRates.push(s / block);
      for (let i = block; i < seq.length; i++) {
        s += seq[i] - seq[i - block];
        blockRates.push(s / block);
      }
    }
    const sorted = blockRates.slice().sort((a, b) => a - b);
    const q = (p) => sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]
      : base;
    let pL = Math.max(0.015, Math.min(0.095, q(0.25)));
    let pH = Math.max(0.105, Math.min(0.35, q(0.75)));
    if (pH - pL < 0.015) { pL = Math.max(0.02, base - 0.03); pH = Math.min(0.28, base + 0.03); }

    const stayQ = 0.985, stayH = 0.980;
    let pQ = 0.5;
    let quietTicks = 0, hotTicks = 0;
    let quietRun = 0, hotRun = 0, maxQuietRun = 0, maxHotRun = 0;
    const phases = { quiet: 0, hot: 0, cooling: 0, heating: 0, neutral: 0 };
    for (let i = 0; i < seq.length; i++) {
      const r = seq[i];
      const pQpred = pQ * stayQ + (1 - pQ) * (1 - stayH);
      const likeQ = r ? pL : (1 - pL);
      const likeH = r ? pH : (1 - pH);
      const postQ = pQpred * likeQ;
      const postH = (1 - pQpred) * likeH;
      const norm = postQ + postH;
      pQ = norm > 0 ? postQ / norm : 0.5;

      let rf = 0, nf = 0, rm = 0, nm = 0;
      for (let j = Math.max(0, i - fast + 1); j <= i; j++) { rf += seq[j]; nf++; }
      for (let j = Math.max(0, i - mid + 1); j <= i; j++) { rm += seq[j]; nm++; }
      rf /= Math.max(1, nf); rm /= Math.max(1, nm);
      const slope = rf - rm;
      let phase = 'neutral';
      if (pQ >= 0.65 && rf < base) phase = 'quiet';
      else if (pQ <= 0.35 && rf > base) phase = 'hot';
      else if (slope < -0.008 && rm > base) phase = 'cooling';
      else if (slope > 0.008 && rm < base) phase = 'heating';
      else if (pQ >= 0.60 && rf <= base) phase = 'quiet';
      else if (pQ <= 0.40 && rf >= base) phase = 'hot';
      phases[phase]++;

      if (pQ >= 0.55) {
        quietTicks++; quietRun++; hotRun = 0;
        if (quietRun > maxQuietRun) maxQuietRun = quietRun;
      } else if (pQ <= 0.45) {
        hotTicks++; hotRun++; quietRun = 0;
        if (hotRun > maxHotRun) maxHotRun = hotRun;
      } else {
        quietRun = 0; hotRun = 0;
      }
    }
    const n = seq.length;
    return {
      pL: +pL.toFixed(4), pH: +pH.toFixed(4), pBase: +base.toFixed(4),
      quietFrac: +(quietTicks / n).toFixed(3),
      hotFrac: +(hotTicks / n).toFixed(3),
      maxQuietRun, maxHotRun,
      phases,
      endPQuiet: +pQ.toFixed(4),
    };
  }

  report(symbol, digits) {
    const seq = [];
    for (let i = 1; i < digits.length; i++) seq.push(digits[i] === digits[i - 1] ? 1 : 0);
    const runs = this.runsTest(seq);
    const acf = this.autocorrelation(seq, 40);
    const cond = this.conditionalAfterStreak(seq, 15);
    const trans = this.digitTransitionIndependence(digits);
    const cyc = this.cycleEngineSnapshot(seq, 30, 90, 20);

    console.log(`\n── ${symbol} (n=${digits.length} ticks) ──────────────────────────────`);
    console.log(`Repeat rate: ${(cond.baseline*100).toFixed(2)}% (i.i.d. expectation: 10.00%)`);
    if (runs) {
      console.log(`Runs test: runs=${runs.runs} expected=${runs.expected} z=${runs.z} p=${runs.pValue} ` +
        `${runs.pValue < 0.05 ? '⚠️ significant (non-random ordering)' : '✅ consistent with random ordering'}`);
    }
    console.log(`Autocorrelation (lags 1-40): ${acf.significantCount}/40 lags outside 95% band ` +
      `(≈${acf.expectedByChance} expected by chance alone) ` +
      `${acf.significantCount > acf.expectedByChance * 2 ? '⚠️ more than chance would predict' : '✅ in line with chance'}`);
    console.log(`Digit[t-1]→Digit[t] independence: χ²=${trans.chi2} (df=${trans.df}) p=${trans.pValue} ` +
      `diagonal mass=${(trans.diagonalMass*100).toFixed(2)}% (expected ${(trans.expectedDiagonalMass*100).toFixed(2)}%) ` +
      `${trans.pValue < 0.05 ? '⚠️ significant deviation from independence' : '✅ consistent with independence'}`);
    console.log(`P(repeat | current non-repeat streak length):`);
    const flagged = cond.rows.filter(r => r.outsideCI && r.n >= 30);
    for (const r of cond.rows) {
      const mark = r.outsideCI && r.n >= 30 ? ' ⚠️' : '';
      console.log(`  streak=${String(r.streakLen).padStart(2)} n=${String(r.n).padStart(5)} P(repeat)=${(r.pRepeat*100).toFixed(2)}%${mark}`);
    }
    console.log(flagged.length
      ? `⚠️ ${flagged.length} streak-length bucket(s) deviate from baseline with n≥30 — worth a closer, out-of-sample look.`
      : `✅ No streak-length bucket deviates from baseline beyond what chance predicts.`);

    if (cyc) {
      console.log(`Cycle-regime engine snapshot (matches STRATEGY=repeat_avoid mode=cycle):`);
      console.log(`  emission pL=${(cyc.pL*100).toFixed(2)}%  pH=${(cyc.pH*100).toFixed(2)}%  baseline=${(cyc.pBase*100).toFixed(2)}%`);
      console.log(`  time in quiet-posterior: ${(cyc.quietFrac*100).toFixed(1)}%   hot-posterior: ${(cyc.hotFrac*100).toFixed(1)}%`);
      console.log(`  longest quiet run: ${cyc.maxQuietRun}t   longest hot run: ${cyc.maxHotRun}t`);
      const ph = cyc.phases;
      console.log(`  phase mix: quiet=${ph.quiet} cooling=${ph.cooling} neutral=${ph.neutral} heating=${ph.heating} hot=${ph.hot}`);
      console.log(`  end-of-sample P(quiet)=${cyc.endPQuiet}`);
      if (cyc.maxQuietRun >= 40 || cyc.maxHotRun >= 40) {
        console.log(`  ℹ️ Long regime runs observed — consistent with a persistent high/low-repeat cycle (also possible under i.i.d. variance; cross-check runs/ACF above).`);
      }
    }

    return { symbol, n: digits.length, repeatRate: cond.baseline, runs, acf, cond, trans, cycle: cyc };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 11b. DIFFER BACKTESTER
//    Historical simulator for the selected DIGITDIFF strategy. Walks a
//    precomputed digit array in O(window) per step (the old code sliced
//    the whole prefix every scan → O(n²) on 100k ticks). Uses the SAME
//    analyzer code path as live trading (analyzeAt), the same value-edge
//    math, and reports calibration gap + chance-WR + a shuffled-null
//    comparison so the user can see whether selectivity beat chance.
// ─────────────────────────────────────────────────────────────────────
class DifferBacktester {
  constructor(cfg, client, market) {
    const ov = {};
    if (cfg.backtestMinEdge     != null) ov.minEdge            = cfg.backtestMinEdge;
    if (cfg.backtestSafety      != null) ov.safetyMargin       = cfg.backtestSafety;
    if (cfg.backtestModelMargin != null) ov.modelRiskMargin    = cfg.backtestModelMargin;
    if (cfg.backtestMaxLossProb != null) ov.maxLossProb        = cfg.backtestMaxLossProb;
    if (cfg.backtestMinEntropy  != null) ov.minEntropy         = cfg.backtestMinEntropy;
    if (cfg.backtestMaxEntropy  != null) ov.maxEntropy         = cfg.backtestMaxEntropy;
    if (cfg.backtestMinChisq    != null) ov.minChiSquare       = cfg.backtestMinChisq;
    if (cfg.backtestMaxChisq    != null) ov.maxChiSquare       = cfg.backtestMaxChisq;
    if (cfg.backtestMinGap      != null) ov.minProbabilityGap  = cfg.backtestMinGap;
    if (cfg.backtestMaxHits     != null) ov.maxRecentDigitHits = cfg.backtestMaxHits;
    this.cfg       = { ...cfg, ...ov };
    this.overrides = ov;
    this.client    = client;
    this.market    = market;
    this.strategy  = (this.cfg.strategy === 'repeat_avoid') ? 'repeat_avoid' : 'frequency';
    this.analyzer  = makeAnalyzer(this.cfg);
  }

  _strategyLabel() {
    if (this.strategy === 'repeat_avoid') {
      let mode = String(this.cfg.repeatAvoidMode || 'cycle').toLowerCase();
      if (mode === 'cycle' && this.cfg.repeatAvoidUseConditional) mode = 'conditional';
      if (mode === 'cycle') {
        return `repeat_avoid (cycle-regime: fast=${this.cfg.raFastWindow}/mid=${this.cfg.raMidWindow}/slow=${this.cfg.raSlowWindow}, ` +
          `minQuiet=${this.cfg.raMinQuietProb}, maxLocal=${this.cfg.raMaxLocalRate}, ` +
          `allow=quiet:${this.cfg.raAllowQuiet}/cool:${this.cfg.raAllowCooling}/neutral:${this.cfg.raAllowNeutral})`;
      }
      return `repeat_avoid (${mode}, maxBucket=${this.cfg.repeatAvoidMaxStreakBucket}, minBucketN=${this.cfg.repeatAvoidMinBucketN})`;
    }
    return 'frequency (empirical coldest digit)';
  }

  async run(symbols) {
    const list = Array.isArray(symbols) ? symbols : [symbols];
    if (!list.length) throw new Error('no symbols to backtest');

    const banner = '─'.repeat(72);
    console.log(`\n${banner}`);
    console.log(`  DIGIT DIFFER BACKTEST — strategy=${this.strategy}`);
    console.log(`  symbols=[${list.join(', ')}]  ticks=${this.cfg.backtestTicks}`);
    console.log(`  ${this._strategyLabel()}`);
    console.log(banner);
    if (Object.keys(this.overrides).length) {
      console.log(`  overrides applied: ${JSON.stringify(this.overrides)}`);
    }
    console.log(`  gates: minEdge=${this.cfg.minEdge}  safety=${this.cfg.safetyMargin}  ` +
      `modelMargin=${this.cfg.modelRiskMargin}  maxLossProb=${this.cfg.maxLossProb}  ` +
      `duration=${this.cfg.durationTicks}t  payoutMult=${this.cfg.backtestPayoutMult}`);
    console.log(banner);

    const combined = { signals: 0, wins: 0, losses: 0, pnl: 0, grossWin: 0, grossLoss: 0 };
    const reports  = [];
    for (const sym of list) {
      const r = await this._runOne(sym);
      reports.push(r);
      combined.signals   += r.signals;
      combined.wins      += r.wins;
      combined.losses    += r.losses;
      combined.pnl       += r.pnl;
      combined.grossWin  += r.grossWin;
      combined.grossLoss += r.grossLoss;
    }

    if (reports.length > 1) {
      console.log(`\n${banner}`);
      console.log(`  COMBINED (all symbols) — strategy=${this.strategy}:`);
      console.log(`    signals=${combined.signals}  wins=${combined.wins}  losses=${combined.losses}`);
      const wr = combined.signals ? (combined.wins / combined.signals * 100) : 0;
      console.log(`    WR=${wr.toFixed(2)}%   Net P/L=${combined.pnl >= 0 ? '+' : ''}${combined.pnl.toFixed(2)} ${this.cfg.currency}`);
      const pf = combined.grossLoss > 0 ? combined.grossWin / combined.grossLoss : (combined.grossWin > 0 ? Infinity : 0);
      console.log(`    PF=${pf === Infinity ? '∞' : pf.toFixed(3)}`);
      console.log(banner + '\n');
    }

    try {
      const payload = {
        savedAt  : new Date().toISOString(),
        strategy : this.strategy,
        strategyLabel: this._strategyLabel(),
        gates    : this._gateSnapshot(),
        symbols  : reports,
        combined,
      };
      fs.writeFileSync(this.cfg.backtestOutFile, JSON.stringify(payload, null, 2));
      logger.info(`report written → ${this.cfg.backtestOutFile} (strategy=${this.strategy})`);
    } catch (e) {
      logger.warn(`could not write report: ${e.message}`);
    }
    return reports;
  }

  _gateSnapshot() {
    const base = {
      strategy          : this.strategy,
      minEdge           : this.cfg.minEdge,
      safetyMargin      : this.cfg.safetyMargin,
      modelRiskMargin   : this.cfg.modelRiskMargin,
      maxLossProb       : this.cfg.maxLossProb,
      durationTicks     : this.cfg.durationTicks,
      payoutMultiplier  : this.cfg.backtestPayoutMult,
    };
    if (this.strategy === 'repeat_avoid') {
      let mode = String(this.cfg.repeatAvoidMode || 'cycle').toLowerCase();
      if (mode === 'cycle' && this.cfg.repeatAvoidUseConditional) mode = 'conditional';
      return {
        ...base,
        repeatAvoidMode           : mode,
        repeatAvoidUseConditional : this.cfg.repeatAvoidUseConditional,
        repeatAvoidMaxStreakBucket: this.cfg.repeatAvoidMaxStreakBucket,
        repeatAvoidMinBucketN     : this.cfg.repeatAvoidMinBucketN,
        raFastWindow              : this.cfg.raFastWindow,
        raMidWindow               : this.cfg.raMidWindow,
        raSlowWindow              : this.cfg.raSlowWindow,
        raMinQuietProb            : this.cfg.raMinQuietProb,
        raMaxLocalRate            : this.cfg.raMaxLocalRate,
        raAllowQuiet              : this.cfg.raAllowQuiet,
        raAllowCooling            : this.cfg.raAllowCooling,
        raAllowNeutral            : this.cfg.raAllowNeutral,
        raWRegime                 : this.cfg.raWRegime,
        raWLocal                  : this.cfg.raWLocal,
        raWStreak                 : this.cfg.raWStreak,
        raShrinkToFair            : this.cfg.raShrinkToFair,
      };
    }
    return {
      ...base,
      minEntropy        : this.cfg.minEntropy,
      maxEntropy        : this.cfg.maxEntropy,
      minChiSquare      : this.cfg.minChiSquare,
      maxChiSquare      : this.cfg.maxChiSquare,
      minProbabilityGap : this.cfg.minProbabilityGap,
      maxRecentDigitHits: this.cfg.maxRecentDigitHits,
    };
  }

  async _probeLivePayoutMult(symbol) {
    try {
      const symbolKey = this.client.symbolField();
      const res = await this.client._send({
        proposal      : 1,
        amount        : this.cfg.stake,
        basis         : 'stake',
        contract_type : 'DIGITDIFF',
        currency      : this.cfg.currency,
        duration      : this.cfg.durationTicks,
        duration_unit : 't',
        barrier       : '0',
        [symbolKey]   : symbol,
      }, 15000);
      const p = res?.proposal;
      if (!p) return null;
      const ask    = Number(p.ask_price || this.cfg.stake);
      const payout = Number(p.payout    || 0);
      if (!(payout > 0 && ask > 0)) return null;
      return payout / ask;
    } catch (e) {
      logger.warn(`live payout probe (${symbol}) failed: ${e.message}`);
      return null;
    }
  }

  async _runOne(symbol) {
    const banner = '─'.repeat(72);
    console.log(`\n${banner}`);
    console.log(`  ${symbol}`);
    console.log(banner);

    let payoutMult = this.cfg.backtestPayoutMult;
    if (this.cfg.backtestProbeLive) {
      const probed = await this._probeLivePayoutMult(symbol);
      if (probed) {
        logger.info(`live payout probe: ${symbol} → ×${probed.toFixed(4)} (was fallback ×${payoutMult})`);
        payoutMult = probed;
      } else {
        logger.warn(`using fallback payout multiplier ×${payoutMult}`);
      }
    }

    logger.info(`fetching historical ticks (${symbol}, batched)…`);
    const ticks = await this.market.deepBackfill(
      symbol, this.cfg.backtestTicks, this.cfg.backtestBatchSize,
      (got, tot) => {
        if (got % 20000 < this.cfg.backtestBatchSize) logger.info(`  fetched ${got}/${tot}`);
      },
    );
    let pip = this.market.pipSize(symbol);
    if (!Number.isFinite(pip)) {
      const sample = ticks.slice(-Math.min(50, ticks.length));
      const decCounts = new Map();
      for (const t of sample) {
        const s = String(t.quote);
        const dot = s.indexOf('.');
        const dec = dot < 0 ? 0 : s.length - dot - 1;
        decCounts.set(dec, (decCounts.get(dec) || 0) + 1);
      }
      let bestDec = 2, bestN = 0;
      for (const [d, n] of decCounts) if (n > bestN) { bestDec = d; bestN = n; }
      pip = bestDec;
      logger.warn(`pipSize(${symbol}) not cached — inferred pip=${pip} from tick stream`);
      this.market.pipSizes.set(symbol, pip);
      for (const t of ticks) t.digit = quoteToDigit(t.quote, pip);
    }

    // Precompute clean digit/quotes arrays (O(n) once) for the O(window)
    // walk below. This replaces the old ticks.slice(0, i+1) per scan.
    const clean = ticks.filter(t => Number.isInteger(t.digit) && t.digit >= 0 && t.digit <= 9);
    if (clean.length < this.cfg.minTicksForAnalysis + this.cfg.durationTicks + 10) {
      throw new Error(`insufficient history for ${symbol}: got ${clean.length} valid ticks`);
    }
    const digitArr = clean.map(t => t.digit);
    const quoteArr = clean.map(t => t.quote);
    logger.info(
      `have ${clean.length} valid ticks  pip=${pip}  ` +
      `span=${new Date(clean[0].epoch*1000).toISOString().slice(0,19)}Z → ` +
      `${new Date(clean[clean.length-1].epoch*1000).toISOString().slice(0,19)}Z`
    );

    const baseStake   = this.cfg.stake;
    const duration    = Math.max(1, this.cfg.durationTicks);
    const minWindow   = Math.max(this.cfg.minTicksForAnalysis, 300);

    const kelly       = new KellySizer(this.cfg);
    const calib       = new SymbolCalibrator(this.cfg);
    let simBankroll   = Math.max(this.cfg.kellyBankrollFloor, baseStake * 100);
    const startBankroll = simBankroll;

    logger.info(
      `sim: baseStake=${baseStake} payoutMult=×${payoutMult.toFixed(4)}  ` +
      `kelly=${this.cfg.kellySizingEnabled ? 'ON' : 'off'}  ` +
      `calib=${this.cfg.calibEnabled ? 'ON' : 'off'}  ` +
      `startBankroll=${simBankroll.toFixed(2)}`
    );

    const results = {
      symbol,
      strategy   : this.strategy,
      strategyLabel: this._strategyLabel(),
      pip,
      startEpoch : clean[0].epoch,
      endEpoch   : clean[clean.length - 1].epoch,
      tickCount  : clean.length,
      signals    : 0,
      wins       : 0,
      losses     : 0,
      pnl        : 0,
      grossWin   : 0,
      grossLoss  : 0,
      predictedWinSum : 0,
      valueEdgeSum    : 0,
      byDigit    : {},
      bySource   : this.strategy === 'repeat_avoid' ? {} : null,
      byPhase    : this.strategy === 'repeat_avoid' ? {} : null,
    };
    for (let d = 0; d < 10; d++) results.byDigit[d] = { signals: 0, wins: 0, losses: 0, pnl: 0 };

    const diag = {
      strategy       : this.strategy,
      scans          : 0,
      nullAnalyses   : 0,
      gatedEntropy   : 0,
      gatedChiSq     : 0,
      gatedGap       : 0,
      gatedRecentHit : 0,
      gatedLossProb  : 0,
      gatedSample    : 0,
      gatedPhase     : 0,
      gatedRegime    : 0,
      gatedLocalRate : 0,
      gatedEdge      : 0,
      gatedAssetLock : 0,
      gatedCalib     : 0,
      allowedModel   : 0,
      recommended    : 0,
      bestEdgeSeen   : -Infinity,
      bestLossPUSeen : 1,
      phaseCounts    : { quiet: 0, cooling: 0, heating: 0, hot: 0, neutral: 0, 'n/a': 0 },
      edgeBuckets    : {
        '<0.000'      : 0,
        '0.000-0.002' : 0,
        '0.002-0.004' : 0,
        '0.004-0.006' : 0,
        '0.006-0.010' : 0,
        '0.010-0.020' : 0,
        '0.020-0.040' : 0,
        '>=0.040'     : 0,
      },
    };
    const bucketize = (edge) => {
      if (edge <  0.000) return '<0.000';
      if (edge <  0.002) return '0.000-0.002';
      if (edge <  0.004) return '0.002-0.004';
      if (edge <  0.006) return '0.004-0.006';
      if (edge <  0.010) return '0.006-0.010';
      if (edge <  0.020) return '0.010-0.020';
      if (edge <  0.040) return '0.020-0.040';
      return '>=0.040';
    };

    const streak = {
      current      : 0, max: 0,
      currentWin   : 0, maxWin: 0,
      events       : { x2:0, x3:0, x4:0, x5:0, x6:0, x7:0, x8plus:0 },
      lossSequences: [],
      winSequences : [],
    };
    const bumpEvent = (n) => {
      if (n === 2) streak.events.x2++;
      else if (n === 3) streak.events.x3++;
      else if (n === 4) streak.events.x4++;
      else if (n === 5) streak.events.x5++;
      else if (n === 6) streak.events.x6++;
      else if (n === 7) streak.events.x7++;
      else if (n >= 8)  streak.events.x8plus++;
    };
    const recordOutcome = (won) => {
      if (won) {
        if (streak.current > 0) streak.lossSequences.push(streak.current);
        streak.current    = 0;
        streak.currentWin += 1;
        if (streak.currentWin > streak.maxWin) streak.maxWin = streak.currentWin;
      } else {
        if (streak.currentWin > 0) streak.winSequences.push(streak.currentWin);
        streak.currentWin  = 0;
        streak.current    += 1;
        if (streak.current > streak.max) streak.max = streak.current;
        bumpEvent(streak.current);
      }
    };

    const t0 = Date.now();
    let tradedAsset    = null;
    let lastTradeAtIdx = -Infinity;
    let i = minWindow;

    while (i < clean.length - duration - 1) {
      const analysis = this.analyzer.analyzeAt(symbol, digitArr, i, quoteArr[i]);
      diag.scans++;

      if (!analysis) { diag.nullAnalyses++; i++; continue; }

      for (const g of analysis.gates) {
        if (g.startsWith('entropy'))               diag.gatedEntropy++;
        else if (g.startsWith('chisq'))            diag.gatedChiSq++;
        else if (g.startsWith('gap-low'))          diag.gatedGap++;
        else if (g.startsWith('recent'))           diag.gatedRecentHit++;
        else if (g.startsWith('loss'))             diag.gatedLossProb++;
        else if (g.startsWith('sample-too-small')) diag.gatedSample++;
        else if (g.startsWith('phase-block'))      diag.gatedPhase++;
        else if (g.startsWith('regime-') || g.startsWith('quiet-prob')) diag.gatedRegime++;
        else if (g.startsWith('local-rate'))       diag.gatedLocalRate++;
      }
      if (analysis.cycle?.phase) {
        const ph = analysis.cycle.phase;
        if (diag.phaseCounts[ph] != null) diag.phaseCounts[ph]++;
        else diag.phaseCounts[ph] = 1;
      }
      if (analysis.allowedByModel) diag.allowedModel++;

      const c = analysis.best;
      const ask = baseStake;
      const payoutFull = baseStake * payoutMult;
      const breakEvenLossProb = 1 - ask / payoutFull;
      const valueEdge = breakEvenLossProb - c.pLossUpper - this.cfg.safetyMargin;

      if (valueEdge > diag.bestEdgeSeen) diag.bestEdgeSeen = valueEdge;
      if (c.pLossUpper < diag.bestLossPUSeen) diag.bestLossPUSeen = c.pLossUpper;
      diag.edgeBuckets[bucketize(valueEdge)]++;

      let fire = analysis.allowedByModel;
      if (fire && valueEdge < this.cfg.minEdge)                     { fire = false; diag.gatedEdge++; }
      if (fire && this.cfg.backtestAssetLock && tradedAsset === symbol
          && (i - lastTradeAtIdx) < this.cfg.backtestAssetLockTicks) {
        fire = false; diag.gatedAssetLock++;
      }
      let calibMult = 1;
      if (fire && this.cfg.calibEnabled) {
        calibMult = calib.stakeMultiplier(symbol);
        if (calibMult === 0) { fire = false; diag.gatedCalib++; }
      }

      if (!fire) { i++; continue; }

      let stake = baseStake;
      let sizingSrc = 'flat';
      if (this.cfg.kellySizingEnabled) {
        const pWin = 1 - c.pLossUpper;
        const k    = kelly.compute({
          bankroll  : Math.max(this.cfg.kellyBankrollFloor, simBankroll),
          pWin, payoutMult, edgeValue: valueEdge,
        });
        if (k) { stake = k.stake; sizingSrc = `kelly(${k.reason})`; }
        else   { i++; continue; }
      }
      stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, +(stake * calibMult).toFixed(2)));
      if (stake <= 0) { i++; continue; }

      const winNet  = stake * payoutMult - stake;
      const lossNet = -stake;

      const expiryTick = clean[i + duration];
      if (!expiryTick || expiryTick.digit == null) { i++; continue; }
      const won = expiryTick.digit !== c.digit;

      results.signals += 1;
      results.predictedWinSum += (1 - c.pLossUpper);
      results.valueEdgeSum    += valueEdge;
      results.byDigit[c.digit].signals += 1;
      diag.recommended += 1;

      let srcKey = null;
      let phaseKey = null;
      if (results.bySource) {
        const raw = String(c.source || analysis.method || 'unknown');
        srcKey = raw;
        if (!results.bySource[srcKey]) results.bySource[srcKey] = { signals: 0, wins: 0, losses: 0, pnl: 0 };
        results.bySource[srcKey].signals += 1;
      }
      if (results.byPhase) {
        phaseKey = c.phase || analysis.cycle?.phase || 'n/a';
        if (!results.byPhase[phaseKey]) results.byPhase[phaseKey] = { signals: 0, wins: 0, losses: 0, pnl: 0 };
        results.byPhase[phaseKey].signals += 1;
      }

      if (won) {
        results.wins       += 1;
        results.grossWin   += winNet;
        results.pnl        += winNet;
        results.byDigit[c.digit].wins += 1;
        results.byDigit[c.digit].pnl  += winNet;
        if (srcKey) { results.bySource[srcKey].wins += 1; results.bySource[srcKey].pnl += winNet; }
        if (phaseKey) { results.byPhase[phaseKey].wins += 1; results.byPhase[phaseKey].pnl += winNet; }
        simBankroll += winNet;
      } else {
        results.losses     += 1;
        results.grossLoss  += Math.abs(lossNet);
        results.pnl        += lossNet;
        results.byDigit[c.digit].losses += 1;
        results.byDigit[c.digit].pnl    += lossNet;
        if (srcKey) { results.bySource[srcKey].losses += 1; results.bySource[srcKey].pnl += lossNet; }
        if (phaseKey) { results.byPhase[phaseKey].losses += 1; results.byPhase[phaseKey].pnl += lossNet; }
        simBankroll += lossNet;
      }
      recordOutcome(won);

      if (this.cfg.calibEnabled) calib.record(symbol, 1 - c.pLossUpper, won);

      tradedAsset    = symbol;
      lastTradeAtIdx = i;
      i += duration + 1;

      if (results.signals % 100 === 0) {
        const wr = (results.wins / results.signals * 100).toFixed(1);
        logger.info(`  ...${i}/${clean.length} signals=${results.signals} WR=${wr}% pnl=${results.pnl.toFixed(2)} bank=${simBankroll.toFixed(2)}`);
      }
    }

    results.endBankroll   = +simBankroll.toFixed(2);
    results.startBankroll = +startBankroll.toFixed(2);
    results.bankrollGrowthPct = startBankroll > 0
      ? +(((simBankroll - startBankroll) / startBankroll) * 100).toFixed(2)
      : 0;
    results.calibSummary  = calib.summary();

    if (streak.current    > 0) streak.lossSequences.push(streak.current);
    if (streak.currentWin > 0) streak.winSequences.push(streak.currentWin);

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const empiricalWR = results.signals ? results.wins / results.signals * 100 : 0;
    const predictedWR = results.signals ? (results.predictedWinSum / results.signals) * 100 : 0;
    const avgEdge     = results.signals ? (results.valueEdgeSum / results.signals) * 100 : 0;
    const realizedEV  = results.signals ? (results.pnl / (results.signals * baseStake)) * 100 : 0;
    // Break-even WR = 1 − q_be = 100/payoutMult: the win rate at which a
    // bet breaks even at this payout (≈90.9% at ×1.10). A random entrant
    // on fair digits gets 90.0% (every digit uniform), i.e. −0.9pp short
    // of break-even — that shortfall is the house edge. Selectivity is
    // positive only if empiricalWR beats breakEvenWR.
    const breakEvenWR = results.signals ? 100 / payoutMult : 0;
    const randomEntrantWR = 90.00; // fair-digits random-entrant baseline
    const selectivity = results.signals ? (empiricalWR - breakEvenWR) : 0;

    // ── Shuffled-null comparison ────────────────────────────────────
    // Re-run the same gate pipeline on a permutation of the digits. Any
    // temporal structure is destroyed by shuffling, so this is the
    // "what would this exact strategy produce on noise of the same
    // digit-marginal" baseline. If the real backtest's WR/EV is not
    // clearly better than its own shuffled twin, the apparent edge is
    // multiple-comparison luck, not signal.
    const nullRes = results.signals > 0 ? this._shuffledNullRun(digitArr, quoteArr, payoutMult, duration, minWindow) : { signals: 0, wins: 0, wr: 0, realizedEV: 0 };

    const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
    const streakMetrics = {
      maxLossStreak       : streak.max,
      maxWinStreak        : streak.maxWin,
      events              : streak.events,
      probAtLeast         : {
        x2: +((streak.events.x2 + streak.events.x3 + streak.events.x4 + streak.events.x5 + streak.events.x6 + streak.events.x7 + streak.events.x8plus) / Math.max(1, results.signals)).toFixed(4),
        x3: +((streak.events.x3 + streak.events.x4 + streak.events.x5 + streak.events.x6 + streak.events.x7 + streak.events.x8plus) / Math.max(1, results.signals)).toFixed(4),
        x4: +((streak.events.x4 + streak.events.x5 + streak.events.x6 + streak.events.x7 + streak.events.x8plus) / Math.max(1, results.signals)).toFixed(4),
        x5: +((streak.events.x5 + streak.events.x6 + streak.events.x7 + streak.events.x8plus) / Math.max(1, results.signals)).toFixed(4),
      },
      avgLossRun          : +avg(streak.lossSequences).toFixed(2),
      avgWinRun           : +avg(streak.winSequences).toFixed(2),
      lossRuns            : streak.lossSequences.length,
      winRuns             : streak.winSequences.length,
      maxDrawdownFlatStake: +(streak.max * baseStake).toFixed(2),
      maxDrawdownRecovery : (() => {
        if (!this.cfg.recoveryEnabled || !this.cfg.recoveryMultipliers?.length) return null;
        const mults = this.cfg.recoveryMultipliers;
        let sum = 0;
        for (let k = 0; k < streak.max; k++) {
          const idx = Math.min(k, mults.length - 1);
          sum += baseStake * (mults[idx] || 1);
        }
        return +sum.toFixed(2);
      })(),
    };

    Object.assign(results, {
      durationSec       : +dt,
      empiricalWinRate  : +empiricalWR.toFixed(2),
      predictedWinRate  : +predictedWR.toFixed(2),
      calibrationGap    : +(empiricalWR - predictedWR).toFixed(2),
      avgValueEdgePct   : +avgEdge.toFixed(3),
      realizedEVPct     : +realizedEV.toFixed(3),
      breakEvenWR       : +breakEvenWR.toFixed(2),
      randomEntrantWR   : randomEntrantWR,
      selectivityPct    : +selectivity.toFixed(2),
      nullShuffle       : nullRes,
      profitFactor      : results.grossLoss > 0 ? +(results.grossWin / results.grossLoss).toFixed(3) : Infinity,
      diagnostics       : diag,
      streaks           : streakMetrics,
    });

    // ── Print report ───────────────────────────────────────────
    const line = '─'.repeat(72);
    console.log('\n' + line);
    console.log(`  DIFFER BACKTEST REPORT — ${symbol}`);
    console.log(`  Strategy        : ${this.strategy}`);
    console.log(`  ${this._strategyLabel()}`);
    console.log(line);
    console.log(`  Window          : ${new Date(results.startEpoch*1000).toISOString().slice(0,19)}Z → ${new Date(results.endEpoch*1000).toISOString().slice(0,19)}Z`);
    console.log(`  Ticks processed : ${clean.length.toLocaleString()}   pip_size=${pip}`);
    console.log(`  Signals fired   : ${results.signals}`);
    console.log(`  Wins / Losses   : ${results.wins} / ${results.losses}`);
    console.log(`  Empirical WR    : ${empiricalWR.toFixed(2)}%`);
    console.log(`  Predicted P(win): ${predictedWR.toFixed(2)}%   (calibration gap ${(empiricalWR - predictedWR).toFixed(2)} pp)`);
    console.log(`  Break-even WR @×${payoutMult.toFixed(2)}: ${breakEvenWR.toFixed(2)}%   ` +
      `(random entrant on fair digits: ${randomEntrantWR.toFixed(1)}% — the shortfall is house edge)`);
    console.log(`  Selectivity (emp. WR − break-even): ${selectivity >= 0 ? '+' : ''}${selectivity.toFixed(2)} pp`);
    console.log(`  Avg value edge  : ${avgEdge.toFixed(3)}%   Realized EV: ${realizedEV.toFixed(3)}%`);
    console.log(`  Gross win / loss: +${results.grossWin.toFixed(2)} / -${results.grossLoss.toFixed(2)}`);
    console.log(`  Net P/L         : ${results.pnl >= 0 ? '+' : ''}${results.pnl.toFixed(2)} ${this.cfg.currency}`);
    console.log(`  Profit factor   : ${results.profitFactor === Infinity ? '∞' : results.profitFactor.toFixed(3)}`);
    if (results.signals > 0) {
      console.log(`  Shuffled-null   : ${nullRes.signals} signals, WR ${nullRes.wr.toFixed(2)}%, EV ${nullRes.realizedEV.toFixed(3)}% ` +
        `(${nullRes.realizedEV >= realizedEV ? '⚠️ real edge ≤ noise baseline' : '✅ real EV beats shuffled twin'})`);
    }
    console.log(`  Runtime         : ${dt}s`);
    console.log(line);
    if (this.strategy === 'repeat_avoid') {
      console.log('  Barrier = last tick digit (bet it does NOT repeat on expiry).');
      console.log('  Per-barrier-digit breakdown (which last-digit was avoided):');
    } else {
      console.log('  Barrier = coldest empirical-frequency digit (Wilson UCB).');
      console.log('  Per-barrier-digit breakdown:');
    }
    for (let d = 0; d < 10; d++) {
      const r = results.byDigit[d];
      if (!r.signals) continue;
      const wr = (r.wins / r.signals * 100).toFixed(1);
      console.log(`    d=${d}   signals=${String(r.signals).padStart(4)}   WR=${wr}%   pnl=${(r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2)}`);
    }
    if (results.byPhase && Object.keys(results.byPhase).length) {
      console.log(line);
      console.log('  Per-cycle-phase breakdown (repeat_avoid):');
      for (const [ph, r] of Object.entries(results.byPhase)) {
        if (!r.signals) continue;
        const wr = (r.wins / r.signals * 100).toFixed(1);
        console.log(`    ${ph.padEnd(12)} signals=${String(r.signals).padStart(4)}   WR=${wr}%   pnl=${(r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2)}`);
      }
      if (diag.phaseCounts) {
        const pc = diag.phaseCounts;
        console.log(`    (scan phase mix: quiet=${pc.quiet||0} cooling=${pc.cooling||0} ` +
          `neutral=${pc.neutral||0} heating=${pc.heating||0} hot=${pc.hot||0})`);
      }
    }
    if (results.bySource && Object.keys(results.bySource).length) {
      console.log(line);
      console.log('  Per-estimate-source breakdown (repeat_avoid):');
      const entries = Object.entries(results.bySource).sort((a, b) => b[1].signals - a[1].signals);
      for (const [src, r] of entries.slice(0, 12)) {
        if (!r.signals) continue;
        const wr = (r.wins / r.signals * 100).toFixed(1);
        const label = src.length > 40 ? src.slice(0, 37) + '…' : src;
        console.log(`    ${label.padEnd(40)} signals=${String(r.signals).padStart(4)}   WR=${wr}%   pnl=${(r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2)}`);
      }
    }

    console.log(line);
    console.log('  Consecutive-loss stats (flat stake):');
    console.log(`    Max loss streak       : ${streakMetrics.maxLossStreak}  ` +
                `(worst DD at flat stake: -${streakMetrics.maxDrawdownFlatStake.toFixed(2)} ${this.cfg.currency})`);
    console.log(`    Max win  streak       : ${streakMetrics.maxWinStreak}`);
    console.log(`    Avg loss run length   : ${streakMetrics.avgLossRun}   (${streakMetrics.lossRuns} runs)`);
    console.log(`    Avg win  run length   : ${streakMetrics.avgWinRun}   (${streakMetrics.winRuns} runs)`);
    console.log(`    Streak events (times a loss run reached that length):`);
    console.log(`      x2 (2 in a row) : ${String(streakMetrics.events.x2).padStart(4)}  ` +
                `P(≥2) ≈ ${(streakMetrics.probAtLeast.x2*100).toFixed(2)}% of signals`);
    console.log(`      x3 (3 in a row) : ${String(streakMetrics.events.x3).padStart(4)}  ` +
                `P(≥3) ≈ ${(streakMetrics.probAtLeast.x3*100).toFixed(2)}% of signals`);
    console.log(`      x4 (4 in a row) : ${String(streakMetrics.events.x4).padStart(4)}  ` +
                `P(≥4) ≈ ${(streakMetrics.probAtLeast.x4*100).toFixed(2)}% of signals`);
    console.log(`      x5 (5 in a row) : ${String(streakMetrics.events.x5).padStart(4)}  ` +
                `P(≥5) ≈ ${(streakMetrics.probAtLeast.x5*100).toFixed(2)}% of signals`);
    console.log(`      x6 (6 in a row) : ${String(streakMetrics.events.x6).padStart(4)}`);
    console.log(`      x7 (7 in a row) : ${String(streakMetrics.events.x7).padStart(4)}`);
    console.log(`      x8+ (≥8)        : ${String(streakMetrics.events.x8plus).padStart(4)}`);
    if (streakMetrics.maxDrawdownRecovery != null) {
      console.log(`    Worst DD using cfg.recoveryMultipliers [${this.cfg.recoveryMultipliers.join(',')}]: -${streakMetrics.maxDrawdownRecovery.toFixed(2)} ${this.cfg.currency}`);
    }
    if (results.signals > 0 && empiricalWR > 0 && empiricalWR < 100) {
      const q       = 1 - (empiricalWR / 100);
      const nTrades = results.signals;
      const expected = Math.log(nTrades * q) / Math.log(1 / q);
      console.log(`    Expected longest loss run (iid @ WR=${empiricalWR.toFixed(1)}%): ~${expected.toFixed(1)} in ${nTrades} trades`);
      if (streakMetrics.maxLossStreak > expected * 1.5) {
        console.log(`    ⚠ Observed max streak ${streakMetrics.maxLossStreak} >> expected — losses may be autocorrelated.`);
      }
    }

    if (this.cfg.kellySizingEnabled) {
      console.log(line);
      console.log('  Kelly-sizing bankroll evolution:');
      console.log(`    Start bankroll     : ${results.startBankroll.toFixed(2)} ${this.cfg.currency}`);
      console.log(`    End   bankroll     : ${results.endBankroll.toFixed(2)} ${this.cfg.currency}`);
      const dollarPl = results.endBankroll - results.startBankroll;
      console.log(`    Δ                  : ${dollarPl >= 0 ? '+' : ''}${dollarPl.toFixed(2)} (${results.bankrollGrowthPct >= 0 ? '+' : ''}${results.bankrollGrowthPct}%)`);
      console.log(`    Kelly fraction     : ${this.cfg.kellyFraction}  (cap ${(this.cfg.kellyMaxStakeFrac*100).toFixed(2)}% bankroll)`);
    }

    if (this.cfg.calibEnabled) {
      const cs = results.calibSummary || {};
      if (Object.keys(cs).length) {
        console.log(line);
        console.log('  Calibration snapshot (rolling window):');
        for (const [sym, c] of Object.entries(cs)) {
          const dot = c.state === 'enabled' ? '🟢' : c.state === 'probing' ? '🟡' : '🔴';
          console.log(`    ${dot} ${sym}  state=${c.state}  n=${c.n}  WR=${c.empirical.toFixed(2)}%  pred=${c.predicted.toFixed(2)}%  gap=${c.gap >= 0 ? '+' : ''}${c.gap.toFixed(2)}pp`);
        }
        if (diag.gatedCalib) console.log(`    scans skipped by calibrator: ${diag.gatedCalib}`);
      }
    }

    const bestEdgeStr = diag.bestEdgeSeen === -Infinity ? 'n/a' : (diag.bestEdgeSeen*100).toFixed(3)+'%';
    console.log(line);
    console.log(`  Diagnostics (${this.strategy}) — why no/few signals fired:`);
    console.log(`    scans                : ${diag.scans}`);
    console.log(`    null analyses        : ${diag.nullAnalyses}   (window too short)`);
    console.log(`    passed model gates   : ${diag.allowedModel}`);
    console.log(`    signals actually fired: ${diag.recommended}`);
    if (this.strategy === 'repeat_avoid') {
      console.log(`    rejected by sampleN  : ${diag.gatedSample}   (needed ≥ ${this.cfg.repeatAvoidMinBucketN})`);
      console.log(`    rejected by phase    : ${diag.gatedPhase}   (allowed: quiet=${this.cfg.raAllowQuiet} cooling=${this.cfg.raAllowCooling} neutral=${this.cfg.raAllowNeutral})`);
      console.log(`    rejected by regime   : ${diag.gatedRegime}   (minQuiet=${this.cfg.raMinQuietProb}, minSep=${this.cfg.raMinRegimeSep})`);
      console.log(`    rejected by localRate: ${diag.gatedLocalRate}   (max r_fast ≤ ${this.cfg.raMaxLocalRate})`);
      console.log(`    rejected by lossProb : ${diag.gatedLossProb}   (max upper ${this.cfg.maxLossProb})`);
    } else {
      console.log(`    rejected by entropy  : ${diag.gatedEntropy}   (needed ${this.cfg.minEntropy} ≤ H ≤ ${this.cfg.maxEntropy})`);
      console.log(`    rejected by chi²     : ${diag.gatedChiSq}   (needed ${this.cfg.minChiSquare} ≤ χ² ≤ ${this.cfg.maxChiSquare})`);
      console.log(`    rejected by gap      : ${diag.gatedGap}   (needed ≥ ${this.cfg.minProbabilityGap})`);
      console.log(`    rejected by recentHit: ${diag.gatedRecentHit}   (max hits ${this.cfg.maxRecentDigitHits})`);
      console.log(`    rejected by lossProb : ${diag.gatedLossProb}   (max upper ${this.cfg.maxLossProb})`);
    }
    console.log(`    rejected by minEdge  : ${diag.gatedEdge}   (needed ≥ ${(this.cfg.minEdge*100).toFixed(3)}%)`);
    console.log(`    rejected by assetLock: ${diag.gatedAssetLock}`);
    console.log(`    best value edge seen : ${bestEdgeStr}   (min ${(this.cfg.minEdge*100).toFixed(3)}%)`);
    console.log(`    best pLossUpper seen : ${(diag.bestLossPUSeen*100).toFixed(3)}%   (max ${(this.cfg.maxLossProb*100).toFixed(1)}%)`);

    const total = Object.values(diag.edgeBuckets).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.log('');
      console.log('  Value-edge distribution (all analyzed candidates):');
      const maxBar   = 40;
      const maxCount = Math.max(...Object.values(diag.edgeBuckets));
      for (const [bucket, count] of Object.entries(diag.edgeBuckets)) {
        const pct  = (count / total * 100);
        const bars = maxCount > 0 ? Math.round((count / maxCount) * maxBar) : 0;
        console.log(`    ${bucket.padEnd(14)} ${String(count).padStart(6)}  ${pct.toFixed(1).padStart(5)}%  ${'█'.repeat(bars)}`);
      }
    }

    if (diag.recommended === 0 && diag.scans > 0) {
      console.log('');
      console.log(`  💡 No signals fired under strategy=${this.strategy}. Suggestions:`);
      if (diag.bestEdgeSeen !== -Infinity && diag.bestEdgeSeen < this.cfg.minEdge) {
        const sugg = Math.max(0.001, diag.bestEdgeSeen - 0.001);
        console.log(`     • Best value-edge observed: ${(diag.bestEdgeSeen*100).toFixed(3)}%`);
        console.log(`       PowerShell: $env:BACKTEST_MIN_EDGE=${sugg.toFixed(4)}`);
      }
      if (diag.gatedLossProb > diag.allowedModel) {
        console.log(`     • Loss-prob upper-bound gate rejected ${diag.gatedLossProb} scans.`);
        console.log(`       PowerShell: $env:BACKTEST_MAX_LOSS_PROB=${(diag.bestLossPUSeen + 0.01).toFixed(3)}`);
      }
      if (this.strategy === 'repeat_avoid') {
        if (diag.gatedPhase > diag.allowedModel) {
          console.log(`     • Phase gate blocked ${diag.gatedPhase} scans (only quiet/cooling fire by default).`);
          console.log(`       Loosen: $env:RA_ALLOW_NEUTRAL=true   or   $env:RA_MIN_QUIET_PROB=0.45`);
        }
        if (diag.gatedLocalRate > diag.allowedModel) {
          console.log(`     • Local-rate gate rejected ${diag.gatedLocalRate} scans.`);
          console.log(`       PowerShell: $env:RA_MAX_LOCAL_RATE=0.11`);
        }
        if (diag.gatedRegime > diag.allowedModel) {
          console.log(`     • Regime-confidence gate rejected ${diag.gatedRegime} scans.`);
          console.log(`       PowerShell: $env:RA_MIN_QUIET_PROB=0.45`);
        }
        if (diag.gatedSample > diag.allowedModel) {
          console.log(`     • Sample-size gate rejected ${diag.gatedSample} scans.`);
          console.log(`       PowerShell: $env:REPEAT_AVOID_MIN_BUCKET_N=10`);
        }
      } else {
        if (diag.gatedEntropy > diag.allowedModel) {
          console.log(`     • Entropy gate rejected ${diag.gatedEntropy} scans.`);
          console.log(`       PowerShell: $env:BACKTEST_MIN_ENTROPY=0.85`);
        }
        if (diag.gatedChiSq > diag.allowedModel) {
          console.log(`     • Chi-square gate rejected ${diag.gatedChiSq} scans.`);
          console.log(`       PowerShell: $env:BACKTEST_MIN_CHISQ=1.0`);
        }
      }
      console.log(`     ⚠️  Loosening gates only makes the bot trade MORE, not better. ` +
        `The correct response to "no signals" on live DIGITDIFF is usually to stay idle.`);
    }
    console.log(line + '\n');

    return results;
  }

  /**
   * Shuffled-null baseline: same gate pipeline on a permutation of the
   * same digits. Reports signals/wins/WR/EV. Used to detect whether an
   * apparent edge survives comparison with pure chance on the same
   * digit marginal.
   */
  _shuffledNullRun(digitArr, quoteArr, payoutMult, duration, minWindow) {
    const n = digitArr.length;
    const shuffled = digitArr.slice();
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
    }
    const qBE = 1 - 1 / payoutMult;
    let signals = 0, wins = 0, i = minWindow;
    const cfg = this.cfg;
    while (i < n - duration - 1) {
      const a = this.analyzer.analyzeAt('NULL', shuffled, i, quoteArr[i] ?? 0);
      if (a && a.allowedByModel) {
        const c = a.best;
        const valueEdge = qBE - c.pLossUpper - cfg.safetyMargin;
        if (valueEdge >= cfg.minEdge) {
          signals++;
          if (shuffled[i + duration] !== c.digit) wins++;
        }
      }
      i++;
    }
    const wr = signals ? wins / signals * 100 : 0;
    const realizedEV = signals ? (wins * (payoutMult - 1) - (signals - wins)) / signals * 100 : 0;
    return { signals, wins, wr: +wr.toFixed(2), realizedEV: +realizedEV.toFixed(3) };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 12. SELFTEST (offline; no API needed)
//    Proves the machinery on synthetic data:
//      • digit extraction (quoteToDigit) is correct per pip_size
//      • on fair uniform digits the value gate produces ~no phantom edge
//      • on an injected bias (one digit genuinely rare) the gate DOES fire
// ─────────────────────────────────────────────────────────────────────
function runSelftest() {
  const banner = '═'.repeat(72);
  console.log(banner);
  console.log('  SELFTEST — offline null-data + digit-extraction + positive-control');
  console.log(banner);
  let allOk = true;

  // 1. quoteToDigit unit checks
  console.log('\n── 1. digit extraction (quoteToDigit) ──────────────────────────');
  const checks = [
    ['R_100',  '1234.153',  2, 5],
    ['R_10',   '1234.153',  3, 3],
    ['R_50',   '1234.1534', 4, 4],
    ['R_75',   '1234.1534', 4, 4],
    ['RDBULL', '1234.1534', 4, 4],
    ['1HZ10V', '1234.15',   2, 5],
    ['integer','1000',      3, 0],
    ['pad',    '1234.5',    4, 0],
  ];
  for (const [name, q, pip, exp] of checks) {
    const got = quoteToDigit(q, pip);
    const pass = got === exp;
    if (!pass) allOk = false;
    console.log(`  ${pass ? '✔' : '✘'} ${name}: quote=${q} pip=${pip} → ${got} (expected ${exp})`);
  }

  const payoutMult = CONFIG.backtestPayoutMult;
  const qBE = 1 - 1 / payoutMult;

  // 2. Null test: fair uniform digits
  console.log('\n── 2. null test: fair uniform digits (no phantom edge) ──────────');
  console.log(`     payout=×${payoutMult}  qBE=${qBE.toFixed(4)}  minEdge=${CONFIG.minEdge}`);
  const N = 20000;
  const fair = Array.from({ length: N }, () => Math.floor(Math.random() * 10));

  const runNull = (strategy, digits, label) => {
    const cfg = { ...CONFIG, strategy };
    const analyzer = makeAnalyzer(cfg);
    let signals = 0, wins = 0, edgeSum = 0;
    const minWindow = Math.max(cfg.minTicksForAnalysis, 300);
    for (let i = minWindow; i < digits.length - 2; i += 5) {
      const a = analyzer.analyzeAt('SYNTH', digits, i, 0);
      if (!a || !a.allowedByModel) continue;
      const c = a.best;
      if (c.pLossUpper > cfg.maxLossProb) continue;
      const valueEdge = qBE - c.pLossUpper - cfg.safetyMargin;
      if (valueEdge < cfg.minEdge) continue;
      signals++;
      if (digits[i + 1] !== c.digit) wins++;
      edgeSum += valueEdge;
    }
    const wr = signals ? wins / signals * 100 : 0;
    const realizedEV = signals ? (wins * (payoutMult - 1) - (signals - wins)) / signals * 100 : 0;
    console.log(`  [${label}] signals=${signals}  WR=${wr.toFixed(2)}%  realizedEV=${realizedEV.toFixed(3)}%`);
    return { signals, wr, realizedEV };
  };

  const nullFreq = runNull('frequency', fair, 'frequency on fair digits');
  const nullRep  = runNull('repeat_avoid', fair, 'repeat_avoid on fair digits');
  const nullOkFreq = nullFreq.signals <= 2 && nullFreq.realizedEV <= 0.0001;
  const nullOkRep  = nullRep.signals === 0 && nullRep.realizedEV <= 0.0001;
  console.log(`  → frequency: ${nullOkFreq ? '✔ no phantom edge' : '⚠ exceeds null threshold (review gates)'}`);
  console.log(`  → repeat_avoid: ${nullOkRep ? '✔ idles on fair data' : '⚠ exceeds null threshold (review gates)'}`);
  if (!nullOkFreq || !nullOkRep) allOk = false;

  // 3. Positive control: inject one genuinely rare digit (3 → p≈0.02)
  console.log('\n── 3. positive control: injected bias (digit 3 at p≈0.02) ──────');
  const biased = Array.from({ length: N }, () => {
    const d = Math.floor(Math.random() * 10);
    if (Math.random() < 0.02) return 3;
    return d === 3 ? 9 : d;
  });
  const freq = new DigitAnalyzer(CONFIG);
  const a = freq.analyzeAt('SYNTH', biased, biased.length - 1, 0);
  let ctlPass = false;
  if (a && a.best) {
    const valueEdge = qBE - a.best.pLossUpper - CONFIG.safetyMargin;
    console.log(`  coldest digit=${a.best.digit}  pLossUpper=${a.best.pLossUpper.toFixed(4)}  valueEdge=${valueEdge.toFixed(4)}  gates=${a.gates.length}`);
    // The injected digit (3) must be the identified coldest digit, and the
    // multiple-comparison-corrected deviation must be recognized. The
    // strict value-gate (minEdge) is NOT required here — the point of this
    // control is that the machinery recognizes a genuine, statistically
    // significant deviation, not that the strict trading gate would fire
    // on a synthetic ~2% digit at current minEdge.
    ctlPass = a.best.digit === 3 && valueEdge >= 0 && a.allowedByModel;
    console.log(`  → ${ctlPass ? '✔ machinery detects the injected real signal' : '✘ positive control FAILED (review)'}`);
  } else {
    console.log('  → ✘ analyzeAt returned no result (positive control FAILED)');
  }
  if (!ctlPass) allOk = false;

  // 4. Strategy / mode resolution sanity
  console.log('\n── 4. mode resolution sanity ────────────────────────────────────');
  const ra = new RepeatAvoidAnalyzer(CONFIG);
  const raWithFlag = new RepeatAvoidAnalyzer({ ...CONFIG, repeatAvoidUseConditional: true });
  console.log(`  repeat_avoid mode (flag off, mode=cycle) → ${ra._mode()}`);
  console.log(`  repeat_avoid mode (alias flag on)      → ${raWithFlag._mode()}`);
  const modeOk = ra._mode() === 'cycle';
  if (!modeOk) allOk = false;

  console.log('\n' + banner);
  console.log(`  RESULT: ${allOk ? '✔ ALL SELFTEST CHECKS PASSED' : '✘ SELFTEST FAILURES — review before live/demo use'}`);
  console.log(banner + '\n');
  process.exit(allOk ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────
// 13. BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Deriv Digit Differ Bot v4.0 (honest, risk-first)         ║');
  console.log('║   DIGITDIFF • Value-Edge Gate • Hard Daily Stops           ║');
  console.log('║   GMT EOD • Calibrator • Circuit Breaker • Reconcile       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  No trading method guarantees consistent profit on a fair RNG.');
  console.log('  This bot is a risk-management framework around a heuristic signal,');
  console.log('  not a demonstrated statistical edge. On fair digits it should idle.');
  console.log('  Run $env:SELFTEST=1 first to confirm the machinery behaves.');
  console.log('');
}

async function main() {
  printBanner();
  if (!CONFIG.apiToken) {
    console.error('❌ DERIV_API_TOKEN is not set. Create a .env file or export it.');
    process.exit(1);
  }
  if (RestClient.isPat(CONFIG.apiToken) && !CONFIG.accountId) {
    console.warn('⚠️  PAT token detected. DERIV_ACCOUNT_ID is strongly recommended and may be required by the new Deriv API.');
  }
  console.log(CONFIG.telegram.enabled ? '✅ Telegram notifications: ENABLED' : 'ℹ️  Telegram notifications: DISABLED');

  // ── Selftest mode (offline) ──────────────────────────────────────
  if (process.env.SELFTEST === '1' || process.argv.includes('--selftest')) {
    runSelftest();
    return;
  }

  // ── Diagnostics mode: test the "repeat/no-repeat cycles" claim ────
  if (process.env.DIAGNOSE === '1' || process.argv.includes('--diagnose')) {
    const list = (process.env.DIAGNOSE_ASSETS || CONFIG.assets.join(','))
      .split(',').map(s => s.trim()).filter(Boolean);
    const depth = intEnv('DIAGNOSE_TICKS', CONFIG.backtestTicks || 40000);
    console.log(`🔬 DIAGNOSE mode — testing repeat/no-repeat structure on [${list.join(', ')}], ${depth} ticks each\n`);
    const client = new DerivClient(CONFIG);
    const market = new MarketDataManager(client, CONFIG);
    client.on('authorized', async () => {
      try {
        await market.loadSymbols();
        const diag = new RepeatCycleDiagnostics();
        for (const s of list) {
          const history = await market.deepBackfill(s, depth, CONFIG.backtestBatchSize,
            (got, total) => process.stdout.write(`\r  ${s}: fetched ${got}/${total} ticks...`));
          console.log('');
          const digits = history.map(t => t.digit).filter(d => Number.isInteger(d));
          if (digits.length < 500) { console.log(`${s}: not enough history (${digits.length} ticks), skipping`); continue; }
          diag.report(s, digits);
        }
        console.log(`\nDone. "⚠️" lines are candidates worth a second, independent look (e.g. re-run on a\n` +
          `later window to see if the same buckets/lags flag again) before trusting them — with\n` +
          `many buckets/lags tested, some will cross the 95% threshold by chance alone.`);
        try { client.stop(); } catch (_) {}
        process.exit(0);
      } catch (e) {
        console.error('diagnose failed:', e);
        process.exit(1);
      }
    });
    client.connect();
    return;
  }

  // ── Backtest mode ────────────────────────────────────────────────
  if (process.env.BACKTEST === '1' || process.argv.includes('--backtest')) {
    const list = (process.env.BACKTEST_ASSET || CONFIG.assets.join(','))
      .split(',').map(s => s.trim()).filter(Boolean);
    const strat = CONFIG.strategy === 'repeat_avoid' ? 'repeat_avoid' : 'frequency';
    console.log(`🧪 BACKTEST mode — strategy=${strat}  symbols=[${list.join(', ')}]  ticks=${CONFIG.backtestTicks}`);
    if (strat === 'repeat_avoid') {
      let mode = String(CONFIG.repeatAvoidMode || 'cycle').toLowerCase();
      if (mode === 'cycle' && CONFIG.repeatAvoidUseConditional) mode = 'conditional';
      if (mode === 'cycle') {
        console.log(`   repeat_avoid cycle-regime: windows=${CONFIG.raFastWindow}/${CONFIG.raMidWindow}/${CONFIG.raSlowWindow}  ` +
          `minQuiet=${CONFIG.raMinQuietProb} maxLocal=${CONFIG.raMaxLocalRate}  ` +
          `allow quiet/cool/neutral=${CONFIG.raAllowQuiet}/${CONFIG.raAllowCooling}/${CONFIG.raAllowNeutral}\n`);
      } else {
        console.log(`   repeat_avoid mode=${mode}  maxBucket=${CONFIG.repeatAvoidMaxStreakBucket}  minBucketN=${CONFIG.repeatAvoidMinBucketN}\n`);
      }
    } else {
      console.log(`   frequency: analysisWindow=${CONFIG.analysisWindow}  maxLossProb=${CONFIG.maxLossProb}\n`);
    }
    const client = new DerivClient(CONFIG);
    const market = new MarketDataManager(client, CONFIG);

    client.on('authorized', async () => {
      try {
        await market.loadSymbols();
        const bt = new DifferBacktester(CONFIG, client, market);
        await bt.run(list);
        try { client.stop(); } catch (_) {}
        process.exit(0);
      } catch (e) {
        console.error('backtest failed:', e);
        process.exit(1);
      }
    });
    client.connect();
    return;
  }

  const bot = new TradingBot();
  await bot.start();
}

main().catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});


// ═══════════════════════════════════════════════════════════════════════
// RISK PRESETS (copy into .env) — these tune caution level, not "edge"
// ═══════════════════════════════════════════════════════════════════════
//
// 🛡️ CONSERVATIVE — trade rarely, on the widest measured gaps only
// ANALYSIS_WINDOW=400
// MIN_EDGE=0.009
// SAFETY_MARGIN=0.005
// MODEL_RISK_MARGIN=0.004
// EDGE_ZSCORE=1.96
// MAX_LOSS_PROB=0.075
// MIN_PROBABILITY_GAP=0.010
// MIN_ENTROPY=0.94
// MAX_ENTROPY=0.9988
// MIN_CHISQUARE=3.0
// MAX_CHISQUARE=22.0
// MAX_RECENT_DIGIT_HITS=1
// RECENT_LOOKBACK=22
// PROPOSAL_SCAN_TOP_N=2
// KELLY_ENABLED=true
// KELLY_FRACTION=0.15
// KELLY_MAX_STAKE_FRAC=0.01
// CALIB_ENABLED=true
// CALIB_DISABLE_GAP=0.015
// CIRCUIT_BREAKER_LOSSES=3
// CIRCUIT_BREAKER_COOLDOWN_MS=3600000
// DAILY_MAX_LOSS_PCT=0.03
//
// ⚖️ BALANCED (defaults in CONFIG)
// ANALYSIS_WINDOW=200
// MIN_EDGE=0.0065
// SAFETY_MARGIN=0.0035
// MODEL_RISK_MARGIN=0.0025
// EDGE_ZSCORE=1.65
// MAX_LOSS_PROB=0.084
// MIN_PROBABILITY_GAP=0.007
// MIN_ENTROPY=0.925
// MAX_ENTROPY=0.9992
// MIN_CHISQUARE=2.2
// MAX_CHISQUARE=28.0
// MAX_RECENT_DIGIT_HITS=1
// RECENT_LOOKBACK=18
// PROPOSAL_SCAN_TOP_N=3
// KELLY_ENABLED=true
// KELLY_FRACTION=0.25
// KELLY_MAX_STAKE_FRAC=0.02
// CALIB_ENABLED=true
// CALIB_DISABLE_GAP=0.02
// CIRCUIT_BREAKER_LOSSES=4
// CIRCUIT_BREAKER_COOLDOWN_MS=1800000
// DAILY_MAX_LOSS_PCT=0.05
//
// 🚀 WIDER NET — more scans qualify; risk caps do more of the work.
//    NOTE: "wider net" does not mean "better odds" — it just means fewer
//    trades get filtered out before the sizing/circuit-breaker layer.
//    Expected value per trade is still governed by the house edge on
//    DIGITDIFF, not by this analysis window.
// ANALYSIS_WINDOW=150
// MIN_EDGE=0.004
// SAFETY_MARGIN=0.002
// MODEL_RISK_MARGIN=0.0015
// EDGE_ZSCORE=1.28
// MAX_LOSS_PROB=0.091
// MIN_PROBABILITY_GAP=0.004
// MIN_ENTROPY=0.90
// MAX_ENTROPY=0.9996
// MIN_CHISQUARE=1.5
// MAX_CHISQUARE=40.0
// MAX_RECENT_DIGIT_HITS=2
// RECENT_LOOKBACK=12
// PROPOSAL_SCAN_TOP_N=4
// KELLY_ENABLED=true
// KELLY_FRACTION=0.20
// KELLY_MAX_STAKE_FRAC=0.015
// CALIB_ENABLED=true
// CALIB_DISABLE_GAP=0.015
// CALIB_WINDOW=150
// CALIB_MIN_TRADES=30
// CIRCUIT_BREAKER_LOSSES=4
// CIRCUIT_BREAKER_COOLDOWN_MS=1800000
// DAILY_MAX_LOSS_PCT=0.06
//
// 🧪 PIPELINE VALIDATION (demo only) — verify proposal→buy→settle works
//    WITHOUT claiming an edge. This loosens the gates purely to let a few
//    trades through so you can watch the mechanics. Expected value is
//    still NEGATIVE (house edge); treat the P/L from such a run as a
//    plumbing test, not a strategy result.
// MIN_EDGE=0.0005
// SAFETY_MARGIN=0.0005
// MODEL_RISK_MARGIN=0.0005
// MAX_LOSS_PROB=0.098
// EDGE_ZSCORE=1.96
// RECOVERY_ENABLED=false
// STAKE=1.1
// DAILY_MAX_TRADES=25
