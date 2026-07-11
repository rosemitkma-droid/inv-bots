#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  Deriv Digit Differ Trading Bot (v3 — "honest edition")
 * =====================================================================
 *
 *  Single-file DIGITDIFF bot with a deliberately SIMPLE prediction model
 *  and its main engineering effort spent on risk management instead.
 *
 *  ── Why this looks different from the old "X2" version ───────
 *  The previous version stacked 8 "modules" (multi-window frequency,
 *  EWMA, Dirichlet-Bayesian, order-1/order-2 Markov, gap/absence,
 *  hot-pressure, cross-horizon persistence) and traded when they
 *  "agreed". Worth being blunt about why that was replaced:
 *
 *    Deriv's synthetic indices run on an independently audited
 *    cryptographically-secure RNG. Each tick's last digit is, to the
 *    precision that matters here, an independent uniform draw. Past
 *    digit frequency, gaps, streaks, and short-window "coldness" carry
 *    no information about the next tick. Stacking several such
 *    heuristics and requiring them to "agree" doesn't create an edge
 *    out of eight instances of the gambler's fallacy — it just adds
 *    complexity and false confidence. DIGITDIFF's payout already prices
 *    in the true ~90% hit rate plus house margin, so unselective play
 *    has negative expected value, and no amount of pattern-hunting on
 *    tick history changes that.
 *
 *  This version keeps exactly ONE simple, transparent signal — empirical
 *  digit frequency with a statistical uncertainty bound — purely so the
 *  live value-edge check below has *something* to compare against the
 *  payout. It is a heuristic, not a demonstrated edge. The real work in
 *  this file is capital preservation: hard daily/session loss caps, a
 *  consecutive-loss circuit breaker, conservative fractional-Kelly
 *  sizing capped as a % of bankroll, and a per-symbol calibrator that
 *  sidelines a symbol the moment live results diverge from the model.
 *
 *  Decision stack:
 *    • Barrier digit = coldest empirical-frequency digit (Wilson upper
 *      confidence bound), over one configurable lookback window.
 *    • Regime sanity gates: entropy / χ² band, so we don't act on a
 *      sample too small to be meaningfully non-uniform.
 *    • Anti-hit gate: barrier digit not among last N recent ticks.
 *    • Live proposal: q_be = 1 − ask/payout; require
 *          pLossUpper + safetyMargin ≤ q_be − minEdge
 *    • Fractional-Kelly sizing (capped) + per-symbol calibration
 *      sideline + consecutive-loss circuit breaker.
 *
 *  Features:
 *    • DIGITDIFF only • Overall / daily P/L • Loss-streak circuit breaker
 *    • GMT day clock + EOD reports • State JSON • Telegram queue
 *    • Reconnect backoff • Legacy token + PAT/OTP • Built-in backtester
 *
 *  Credentials: DERIV_API_TOKEN, DERIV_ACCOUNT_ID, TELEGRAM_BOT_TOKEN,
 *  and TELEGRAM_CHAT_ID must be set in your .env — see .env.example.
 *  NEVER commit real tokens to source. If a token has ever been shared,
 *  pasted, or committed anywhere, treat it as compromised and rotate it
 *  in your Deriv / Telegram account settings before running this bot.
 *
 *  Install:  npm install ws
 *  Run:      node accurateDiffer3.js
 *  Backtest: $env:BACKTEST=1; node accurateDiffer3.js
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
// 1. ENV LOADER
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
  // Deriv API — MUST come from .env / environment, never hardcode a real
  // token in source. See .env.example for the required keys.
  apiToken:    ('0P94g4WdSrSrzir').trim(),
  appId:       '1089',
  accountId: '', // recommended/required for PAT new API
  accountType: 'demo', // demo | real
  legacyWsUrl: 'wss://ws.derivws.com/websockets/v3',
  restBaseUrl: 'https://api.derivws.com',
  currency: 'USD',

  // Trade setup
  stake: numEnv('STAKE', 0.63),
  durationTicks: intEnv('DURATION_TICKS', 1), // Digit contracts normally 1-10 ticks
  minStake: numEnv('MIN_STAKE', 0.63),
  maxStake: numEnv('MAX_STAKE', 82.00),
  assets: ['R_25','R_50','R_75','R_100','RDBEAR','RDBULL'], //'1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V','R_10','R_25','R_50','R_75','R_100','RDBULL','RDBEAR'

  // Trading frequency / limits
  tickWindow: intEnv('TICK_WINDOW', 1000),
  minTicksForAnalysis: intEnv('MIN_TICKS_ANALYSIS', 300),
  analysisIntervalMs: intEnv('ANALYSIS_INTERVAL_MS', 3000),
  tradeCooldownMs: intEnv('TRADE_COOLDOWN_MS', 2500),
  maxOpenTrades: intEnv('MAX_OPEN_TRADES', 1),
  // ── Asset rotation ────────────────────────────────────────────────
  //   To avoid hammering the same symbol back-to-back the bot briefly
  //   "locks out" the just-traded symbol. Two safety valves:
  //     • the lock EXPIRES after assetRotationMs (default 60s), so if
  //       the same symbol is genuinely the only positive-edge target,
  //       we don't sit idle forever.
  //     • if the top-ranked candidate is locked but a DIFFERENT symbol
  //       is also a valid candidate this scan, we take that one instead
  //       of skipping the whole scan.
  //   Set assetRotationMs=0 to disable the rotation entirely (trade
  //   whatever ranks first every scan).
  assetRotationMs: intEnv('ASSET_ROTATION_MS', 60_000),
  dailyMaxLoss: numEnv('DAILY_MAX_LOSS', 20),
  // Belt-and-braces: stop for the day at whichever loss cap is hit first —
  // a fixed dollar figure AND a % of the balance seen at the start of the day.
  dailyMaxLossPct: numEnv('DAILY_MAX_LOSS_PCT', 0.05), // 5% of day-start balance
  dailyMaxProfit: numEnv('DAILY_MAX_PROFIT', 0), // 0 disables profit target stop
  dailyMaxTrades: intEnv('DAILY_MAX_TRADES', 200),

  // ── Strategy selection ───────────────────────────────────────────────
  // 'frequency'    = Empirical-frequency coldest digit (DigitAnalyzer).
  // 'repeat_avoid' = Barrier = current last digit (bet it does NOT
  //                  repeat). Operationalizes the observed cycle of
  //                  high-repeat vs low-repeat regimes via a multi-scale
  //                  2-state Bayesian filter + phase gate (see
  //                  RepeatAvoidAnalyzer). Still subject to the house
  //                  edge; validate with BACKTEST=1 / DIAGNOSE=1.
  strategy: strEnv('STRATEGY', 'repeat_avoid'),
  // Estimator mode for repeat_avoid:
  //   'cycle'       = full regime-cycle engine (recommended default)
  //   'conditional' = legacy P(repeat | non-repeat streak length)
  //   'flat'        = legacy whole-window empirical repeat rate
  // REPEAT_AVOID_CONDITIONAL=true is an alias for mode=conditional
  // when mode is left at default and that flag is set.
  repeatAvoidMode: strEnv('REPEAT_AVOID_MODE', 'cycle'),
  repeatAvoidUseConditional: boolEnv('REPEAT_AVOID_CONDITIONAL', true),
  repeatAvoidMaxStreakBucket: intEnv('REPEAT_AVOID_MAX_STREAK_BUCKET', 100),
  repeatAvoidMinBucketN: intEnv('REPEAT_AVOID_MIN_BUCKET_N', 100),
  // ── Cycle-regime engine (mode=cycle) ─────────────────────────────────
  // Multi-scale windows on the Bernoulli "is-repeat" series:
  //   fast = local intensity, mid = regime confirmation, slow = baseline.
  raFastWindow: intEnv('RA_FAST_WINDOW', 20),
  raMidWindow : intEnv('RA_MID_WINDOW',  100),
  raSlowWindow: intEnv('RA_SLOW_WINDOW', 500),
  // Block size used to estimate low/high emission rates (pL, pH) from
  // the distribution of short-block repeat rates inside the window.
  raBlockSize: intEnv('RA_BLOCK_SIZE', 20),
  // HMM-style state persistence (per tick). Higher = longer regimes.
  raStayQuiet: numEnv('RA_STAY_QUIET', 0.985),
  raStayHot  : numEnv('RA_STAY_HOT',   0.980),
  // Blend weights for p(repeat) estimate (renormalized if a leg missing).
  // regime = 2-state predictive mix; local = fast EWMA-like rate;
  // streak = P(repeat | current non-repeat streak).
  raWRegime: numEnv('RA_W_REGIME', 0.50),
  raWLocal : numEnv('RA_W_LOCAL',  0.30),
  raWStreak: numEnv('RA_W_STREAK', 0.20),
  // Empirical-Bayes shrink of the blend toward fair 0.10 (less overfit).
  raShrinkToFair: numEnv('RA_SHRINK_TO_FAIR', 0.12),
  // Phase / regime trade gates (DIGITDIFF wants LOW next-tick repeat prob).
  // Only fire when model is confident we are in a quiet (or cooling) phase.
  raMinQuietProb : numEnv('RA_MIN_QUIET_PROB', 0.85),
  raMaxLocalRate : numEnv('RA_MAX_LOCAL_RATE', 0.095),
  raAllowQuiet   : boolEnv('RA_ALLOW_QUIET',   true),
  raAllowCooling : boolEnv('RA_ALLOW_COOLING', false),
  raAllowNeutral : boolEnv('RA_ALLOW_NEUTRAL', false),
  // Require low vs high regime rates to be separated enough to trust the filter.
  raMinRegimeSep : numEnv('RA_MIN_REGIME_SEP', 0.015),
  // Slope threshold (fast − mid rate) for heating/cooling classification.
  raSlopeEps     : numEnv('RA_SLOPE_EPS', 0.008),

  // ── Frequency-analysis config ───────────────────────────────────────
  // Single empirical-frequency window used to rank digits + a Wilson
  // upper confidence bound. This is a heuristic used to feed the live
  // value-edge check below, not a claimed predictive edge — see header.
  analysisWindow: intEnv('ANALYSIS_WINDOW', 200),
  // Value-edge floors (live proposal q_be − pLossUpper)
  minEdge: numEnv('MIN_EDGE', 0.0100),
  safetyMargin: numEnv('SAFETY_MARGIN', 0.002),
  modelRiskMargin: numEnv('MODEL_RISK_MARGIN', 0.0015),
  zScore: numEnv('EDGE_ZSCORE', 1.28),          // Wilson one-sided upper bound
  maxLossProb: numEnv('MAX_LOSS_PROB', 0.092),  // never take if upper-bound P(loss digit) > this
  minProbabilityGap: numEnv('MIN_PROBABILITY_GAP', 0.004),
  // Regime sanity gates: skip samples too small/degenerate to be a
  // meaningful (non-uniform-looking) read, in either direction.
  minEntropy: numEnv('MIN_ENTROPY', 0.90),
  maxEntropy: numEnv('MAX_ENTROPY', 0.9997),
  minChiSquare: numEnv('MIN_CHISQUARE', 1.5),
  maxChiSquare: numEnv('MAX_CHISQUARE', 40.0),
  maxRecentDigitHits: intEnv('MAX_RECENT_DIGIT_HITS', 2), // barrier digit hits in recentLookback
  recentLookback: intEnv('RECENT_LOOKBACK', 12),
  proposalScanTopN: intEnv('PROPOSAL_SCAN_TOP_N', 4),

  // ── Consecutive-loss circuit breaker ────────────────────────────────
  // Independent of stake sizing: after N losses in a row, STOP trading
  // entirely for a cooldown period. This exists because no sizing
  // scheme protects you from "the model was wrong for a while" — only
  // stopping does.
  circuitBreakerEnabled : boolEnv('CIRCUIT_BREAKER_ENABLED', false),
  circuitBreakerLosses  : intEnv ('CIRCUIT_BREAKER_LOSSES',  4),
  circuitBreakerCooldownMs: intEnv('CIRCUIT_BREAKER_COOLDOWN_MS', 30 * 60_000),

  // ── Stake sizing ─────────────────────────────────────────────────────
  // Flat stake is used unless kellySizingEnabled=true (see Kelly block
  // below). Loss-recovery/martingale-style multipliers are NOT offered
  // as a default sizing mode: multiplying stake after a loss to "catch
  // up" increases ruin risk sharply and does not change the underlying
  // per-trade edge. If you specifically want it, set RECOVERY_ENABLED=true
  // and keep the multiplier ladder short and shallow — DO NOT use
  // multiplier ladders like 7x/82x; those go bankrupt on a bad but
  // entirely ordinary run of consecutive losses.
  recoveryEnabled: boolEnv('RECOVERY_ENABLED', false),
  recoveryMultipliers: listEnv('RECOVERY_MULTIPLIERS', '1,7.5,82.0').map(Number).filter(Number.isFinite),

  // ─ Trade watchdog ─
  tradeWatchdogMs: intEnv('TRADE_WATCHDOG_MS', 20000),

  // ── Kelly-fractional sizing ────────────────────────────────────────
  //   kellySizingEnabled=true replaces flat/recovery stake with:
  //       f* = (b·p - q) / b   (Kelly optimum;  b = payout-1, p = win prob, q = 1-p)
  //       stake = clamp(bankroll × f* × kellyFraction, minStake, maxStake)
  //   kellyFraction = 0.25 → "quarter-Kelly" (industry-standard safety
  //   cushion; full Kelly is mathematically optimal for growth but has
  //   ~40% drawdowns). Disable with KELLY_ENABLED=false to fall back
  //   to the legacy flat/recovery sizing above.
  kellySizingEnabled  : boolEnv('KELLY_ENABLED',         false),
  kellyFraction       : numEnv ('KELLY_FRACTION',        0.25),
  kellyBankrollFrac   : numEnv ('KELLY_BANKROLL_FRAC',   1.00),  // % of live balance to treat as risk bankroll
  kellyBankrollFloor  : numEnv ('KELLY_BANKROLL_FLOOR',  100.0), // never scale below this bankroll
  kellyMaxStakeFrac   : numEnv ('KELLY_MAX_STAKE_FRAC',  0.02),  // hard cap: ≤2% of bankroll per trade
  kellyMinEdgeForScale: numEnv ('KELLY_MIN_EDGE_SCALE',  0.005), // no scaling unless edge > 0.5pp

  // ── Per-symbol calibration tracker ─────────────────────────────────
  //   Rolling per-symbol (predicted P(win), actual outcome). Auto-disables
  //   a symbol when empirical WR trails predicted by > calibDisableGap
  //   over ≥ calibMinTrades. Re-enters via low-stake probe after
  //   calibProbeAfterMs; fully re-enabled when calibration re-converges.
  calibEnabled        : boolEnv('CALIB_ENABLED',         false),
  calibWindow         : intEnv ('CALIB_WINDOW',          200),
  calibMinTrades      : intEnv ('CALIB_MIN_TRADES',      40),
  calibDisableGap     : numEnv ('CALIB_DISABLE_GAP',     0.020),   // −2 pp below prediction → disable
  calibReenableGap    : numEnv ('CALIB_REENABLE_GAP',    0.005),  // within ±0.5 pp → re-enable
  calibProbeAfterMs   : intEnv ('CALIB_PROBE_AFTER_MS',  30 * 60_000),
  calibProbeStakeFrac : numEnv ('CALIB_PROBE_STAKE_FRAC', 0.20),

  // GMT/UTC reporting
  eodTimeGmt: strEnv('TRADE_DAY_END_GMT', '00:00'), // default midnight GMT; report date is previous UTC day
  eodSendDelaySeconds: intEnv('EOD_SEND_DELAY_SECONDS', 10),
  hourlySummary: boolEnv('HOURLY_SUMMARY', true),

  // Persistence/logging
  stateFile: strEnv('STATE_FILE', 'accurateDifferx2_state.json'),
  logFile: strEnv('LOG_FILE', 'accurateDifferx2_bot.log'),
  logLevel: strEnv('LOG_LEVEL', 'INFO').toUpperCase(),

  // Telegram — MUST come from .env / environment, never hardcode a real
  // bot token in source. Notifications are auto-disabled if either is empty.
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
  //   Run with:  $env:BACKTEST=1; node accurateDiffer.js
  //   Optional:  $env:BACKTEST_ASSET="R_100"; $env:BACKTEST_TICKS=100000
  //
  //   NOTE on history depth: Deriv's ticks_history endpoint typically
  //   only serves ~24 h of ticks (~43K on the volatility indices).
  //   The batcher stops when the server returns a short batch.
  //
  //   Diagnostic overrides — do NOT affect live trading, only backtest:
  //     BACKTEST_MIN_EDGE      (override minEdge)
  //     BACKTEST_SAFETY_MARGIN (override safetyMargin)
  //     BACKTEST_MODEL_MARGIN  (override modelRiskMargin)
  //     BACKTEST_MAX_LOSS_PROB (override maxLossProb)
  //     BACKTEST_MIN_ENTROPY   (override minEntropy)
  //     BACKTEST_MAX_ENTROPY   (override maxEntropy)
  //     BACKTEST_MIN_CHISQ     (override minChiSquare)
  //     BACKTEST_MAX_CHISQ     (override maxChiSquare)
  //     BACKTEST_MIN_GAP       (override minProbabilityGap)
  //     BACKTEST_MAX_HITS      (override maxRecentDigitHits)
  //     BACKTEST_PAYOUT_MULT   (payout multiplier per 1 stake, default 8.83)
  //     BACKTEST_ASSET_LOCK    ("true"/"false" — apply tradedAsset skip)
  backtestTicks       : intEnv('BACKTEST_TICKS',      100000),
  backtestBatchSize   : intEnv('BACKTEST_BATCH_SIZE', 5000),
  backtestReportEvery : intEnv('BACKTEST_REPORT',     10000),
  backtestOutFile     : strEnv('BACKTEST_OUT',        'accurateDifferx2_backtest_report.json'),
  // The Deriv DIGITDIFF payout multiplier is roughly 1.09-1.11× stake
  // (win ~90% of the time, get ~10% profit). We DEFAULT to 1.10, but at
  // backtest start we probe a real Deriv proposal for the actual live
  // value per symbol and use that instead. This makes the "value edge"
  // computation match live trading exactly. Override the fallback with
  // BACKTEST_PAYOUT_MULT if the probe fails.
  backtestPayoutMult  : numEnv('BACKTEST_PAYOUT_MULT', 1.10),
  backtestProbeLive   : boolEnv('BACKTEST_PROBE_LIVE', false),
  // In LIVE trading the tradedAsset lock forces multi-symbol rotation
  // (don't hammer the same symbol twice in a row while other symbols
  //  are available). In backtest we scan one symbol at a time, so
  // the lock — if enabled — would fire exactly once and then block
  // every subsequent scan indefinitely, resulting in a single trade.
  // Default is therefore FALSE for backtests. Set BACKTEST_ASSET_LOCK=true
  // only if you specifically want to see the effect of the live lock
  // (the lock will self-clear after this many ticks so trades aren't
  //  blocked forever).
  backtestAssetLock       : boolEnv('BACKTEST_ASSET_LOCK',       false),
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

    // Best-effort account discovery. Docs recommend passing accountId explicitly;
    // this fallback supports environments where account list is enabled.
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
      this.ws = new WebSocket(url, { handshakeTimeout: 15000, headers: { 'User-Agent': 'DigitDiffer/3.0 Node.js' } });
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
    // Try to obtain live balance over WS; if unsupported, continue.
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

    // Some streams may send msg_type without subscription id in edge cases.
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
          reject(new Error(`Request timeout (${payload.proposal ? 'proposal' : payload.buy ? 'buy' : payload.ticks ? 'ticks' : 'req'})`));
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
// Rationale: Deriv's `active_symbols` sometimes omits `pip_size` on
// certain requests, and even when present, an off-by-one here silently
// makes the bot train and settle on the WRONG last digit, breaking every
// downstream statistic. This table is the source of truth; the API is a
// fallback; inference from tick decimals is a last resort.
//
// pip_size = number of decimal places in the quote. The "last digit"
// that DIGITDIFF settles on is the digit AT that decimal position.
//
//   R_100:                pip_size = 2   → quote "1234.15"    → digit 5
//   R_10, R_25:           pip_size = 3   → quote "1234.153"   → digit 3
//   R_50, R_75:           pip_size = 4   → quote "1234.1534"  → digit 4
//   RDBULL, RDBEAR:       pip_size = 4
//   1HZ10V, 1HZ25V, 1HZ50V, 1HZ75V, 1HZ100V: pip_size = 2
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
 * what Deriv sees.
 *
 * Instead we walk the fractional part of the quote character-by-character
 * and read the digit at position (pipSize - 1). If the quote has fewer
 * fractional digits than pipSize we pad with '0' (Deriv does the same).
 *
 * Matches the reference bot's per-asset positional extraction, but
 * generalised over any pip_size.
 */
function quoteToDigit(quote, pipSize = 2) {
  const n = Number(quote);
  if (!Number.isFinite(n)) return null;
  const pip = Number.isInteger(pipSize) && pipSize >= 1 && pipSize <= 8 ? pipSize : 2;

  // Use plain string form (not scientific) — synthetic indices never hit
  // scientific notation but guard anyway.
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
    // network. This guarantees `pipSize(symbol)` returns the correct
    // value even if loadSymbols fails, is delayed, or returns partial
    // data — which was the root cause of "1 trade in 3 days".
    for (const [sym, pip] of Object.entries(KNOWN_PIP_SIZES)) {
      this.pipSizes.set(sym, pip);
    }
    client.on('close', () => this.subs.clear());
  }
  async loadSymbols() {
    try {
      // NOTE: use 'full' — 'brief' does NOT include pip_size, which
      // silently forced every digit computation to fall back to pip=2.
      // Deriv's R_10..R_100 all use pip_size=3, so 'brief' was reading
      // the LAST digit of e.g. "9421.15" as "5" when it should have been
      // "5" from "9421.153". Backwards compatible: if 'full' fails or
      // pip_size is still missing we fall back to 2.
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
    // Priority:
    //   1) KNOWN_PIP_SIZES-seeded (or API-overridden) cache
    //   2) live client.symbols map (for symbols we didn't know)
    //   3) inference from a recent tick's decimal count
    //   4) default 2 (last resort)
    const cached = this.pipSizes.get(symbol);
    if (Number.isFinite(cached)) return cached;

    const raw = Number(this.client.symbols.get(symbol)?.pip_size);
    if (Number.isFinite(raw) && raw >= 1 && raw <= 8) {
      this.pipSizes.set(symbol, raw);
      return raw;
    }

    // Infer from actual tick data (last-ditch fallback)
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
//    signal + a statistical uncertainty bound. See file header for why
//    this replaced a multi-module "consensus" engine. This class does
//    NOT claim to predict ticks — it exists to produce a pLossUpper
//    estimate for the live value-edge check in TradingBot, and to gate
//    out samples too small/degenerate to even measure cleanly.
// ─────────────────────────────────────────────────────────────────────
class DigitAnalyzer {
  constructor(cfg) { this.cfg = cfg; }

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
   * analyze(symbol, ticks) — rank the 10 digits by empirical frequency
   * over a single lookback window, and report a conservative (Wilson
   * upper-bound + fixed model-risk margin) estimate of P(next digit = d)
   * for each. Also runs entropy/χ² sanity gates: these do NOT indicate
   * predictability, they only guard against acting on a sample too
   * small to even measure frequencies reliably.
   */
  analyze(symbol, ticks) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;
    const digits = ticks.map(t => t.digit).filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
    if (digits.length < this.cfg.minTicksForAnalysis) return null;

    const window = Math.min(this.cfg.analysisWindow || this.cfg.tickWindow, digits.length);
    const recentDigits = digits.slice(-window);
    const { counts, n } = this.countsFor(recentDigits, window);
    const entropy = this.entropy(counts);
    const chiSquare = this.chiSquare(counts);

    const recentLook = Math.min(this.cfg.recentLookback, recentDigits.length);
    const recentTail = recentDigits.slice(-recentLook);

    const candidates = [];
    for (let d = 0; d < 10; d++) {
      const phat = counts[d] / Math.max(1, n);
      const recentHits = recentTail.filter(x => x === d).length;
      const ucb = Math.min(1, this.wilsonUpper(phat, n, this.cfg.zScore) + this.cfg.modelRiskMargin);
      candidates.push({
        symbol,
        digit: d,
        pLoss: phat,
        pLossUpper: ucb,
        sampleSize: n,
        recentHits,
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

    return {
      symbol,
      method: 'empirical-frequency',
      ticks: recentDigits.length,
      lastDigit: recentDigits[recentDigits.length - 1],
      lastQuote: ticks[ticks.length - 1]?.quote,
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
//   NOT equal it). Built around the empirical cycle claim:
//
//     "Periods of frequent last-digit repeats alternate with periods of
//      long non-repeat runs (and back again)."
//
//   That claim is equivalent to a *regime-switching Bernoulli process*
//   on R_t = 1{digit_t == digit_{t-1}}, not a constant p=0.10 coin.
//   Bernoulli sequences look bursty under pure i.i.d. too (clustering
//   illusion), so this module does not *assume* an edge — it estimates
//   regime state online, predicts P(R_{t+1}=1), and only trades when
//   the model is confident the process is in a low-repeat (or cooling)
//   phase *and* the conservative upper-bound loss prob clears the
//   value-edge gates. Validate with DIAGNOSE=1 and BACKTEST=1.
//
//   Modes (REPEAT_AVOID_MODE / repeatAvoidMode):
//     • cycle       — multi-scale rates + 2-state Bayesian filter +
//                     streak-conditional blend + phase gate (default)
//     • conditional — legacy P(repeat | non-repeat streak length)
//     • flat        — legacy whole-window empirical rate
//
//   Same output shape as DigitAnalyzer.analyze() for drop-in use in
//   TradingBot / DifferBacktester.
// ─────────────────────────────────────────────────────────────────────
class RepeatAvoidAnalyzer {
  constructor(cfg) { this.cfg = cfg; }

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

  /** Resolve estimator mode, honouring the legacy conditional flag. */
  _mode() {
    const raw = String(this.cfg.repeatAvoidMode || 'cycle').trim().toLowerCase();
    if (raw === 'flat' || raw === 'conditional' || raw === 'cycle') {
      // Legacy alias: REPEAT_AVOID_CONDITIONAL=true forces conditional
      // only when user left mode at default cycle and set the old flag.
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
    // Guard against collapsed estimates on near-i.i.d. data
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
   *
   * Transition structure is sticky (high stay probs) so regimes persist
   * across many ticks — matching the "cycles last a while" observation.
   */
  bayesianRegimeFilter(R, pL, pH) {
    const stayQ = Math.min(0.999, Math.max(0.5, this.cfg.raStayQuiet ?? 0.985));
    const stayH = Math.min(0.999, Math.max(0.5, this.cfg.raStayHot   ?? 0.980));
    const switchQH = 1 - stayQ;
    const switchHQ = 1 - stayH;
    // Uniform prior
    let pQ = 0.5;
    for (let i = 0; i < R.length; i++) {
      const r = R[i];
      // Predict step
      const pQpred = pQ * stayQ + (1 - pQ) * switchHQ;
      // Update with Bernoulli likelihood
      const likeQ = r ? pL : (1 - pL);
      const likeH = r ? pH : (1 - pH);
      const postQ = pQpred * likeQ;
      const postH = (1 - pQpred) * likeH;
      const norm = postQ + postH;
      pQ = norm > 0 ? postQ / norm : 0.5;
    }
    // One-step predictive: mixture under transition kernel
    const pQnext = pQ * stayQ + (1 - pQ) * switchHQ;
    const pRepeatNext = pQnext * pL + (1 - pQnext) * pH;
    return { pQuiet: pQ, pQuietNext: pQnext, pRepeatNext, pL, pH };
  }

  /**
   * Classify cycle phase from multi-scale rates + regime posterior.
   *   quiet   — confident low-repeat regime, local rate depressed
   *   hot     — confident high-repeat regime, local rate elevated
   *   cooling — local intensity falling after elevated mid rate
   *             (transition into non-repeat period — key exploit)
   *   heating — local intensity rising after depressed mid rate
   *   neutral — ambiguous / mixed signals
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
  _analyzeLegacy(symbol, ticks, recentDigits, mode) {
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

    const candidates = [{
      symbol, digit: lastDigit, pLoss: phat, pLossUpper, sampleSize, recentHits: 0,
      streakLen, source, phase: 'n/a', pQuiet: null,
    }];
    const gates = [];
    if (sampleSize < this.cfg.repeatAvoidMinBucketN) gates.push(`sample-too-small:${sampleSize}`);
    if (candidates[0].pLossUpper > this.cfg.maxLossProb) gates.push(`loss-prob-high:${candidates[0].pLossUpper.toFixed(4)}`);

    return {
      symbol,
      method: `repeat-avoid:${source}`,
      ticks: recentDigits.length,
      lastDigit,
      lastQuote: ticks[ticks.length - 1]?.quote,
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
  _analyzeCycle(symbol, ticks, recentDigits) {
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
    const candidates = [{
      symbol,
      digit: lastDigit,
      pLoss: phat,
      pLossUpper,
      sampleSize,
      recentHits: 0,
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
    // Sample adequacy: need enough Bernoulli observations
    if (R.length < this.cfg.repeatAvoidMinBucketN) {
      gates.push(`sample-too-small:${R.length}`);
    }
    // Regime separation: if pL≈pH the cycle model has nothing to say
    if ((pH - pL) < (this.cfg.raMinRegimeSep ?? 0.015)) {
      gates.push(`regime-collapsed:${(pH - pL).toFixed(4)}`);
    }
    // Phase gate — only trade when cycle phase favours non-repeat
    const allowQuiet   = this.cfg.raAllowQuiet   !== false;
    const allowCooling = this.cfg.raAllowCooling !== false;
    const allowNeutral = this.cfg.raAllowNeutral === true;
    const phaseOk =
      (phase === 'quiet'   && allowQuiet) ||
      (phase === 'cooling' && allowCooling) ||
      (phase === 'neutral' && allowNeutral);
    if (!phaseOk) gates.push(`phase-block:${phase}`);

    // Confidence in quiet-side posterior (for quiet/cooling entries)
    const minQ = this.cfg.raMinQuietProb ?? 0.55;
    if ((phase === 'quiet' || phase === 'cooling') && filt.pQuiet < minQ * 0.85) {
      // Cooling can enter with slightly lower quiet posterior, but not
      // while the filter is still firmly in hot territory.
      if (filt.pQuiet < 0.40) gates.push(`regime-hot:${filt.pQuiet.toFixed(3)}`);
    }
    if (phase === 'quiet' && filt.pQuiet < minQ) {
      gates.push(`quiet-prob-low:${filt.pQuiet.toFixed(3)}`);
    }

    // Local rate confirmation: refuse if short window still looks hot
    const maxLocal = this.cfg.raMaxLocalRate ?? 0.095;
    if (rFast > maxLocal) gates.push(`local-rate-high:${rFast.toFixed(4)}`);

    if (best.pLossUpper > this.cfg.maxLossProb) {
      gates.push(`loss-prob-high:${best.pLossUpper.toFixed(4)}`);
    }

    return {
      symbol,
      method: `repeat-avoid:${source}`,
      ticks: recentDigits.length,
      lastDigit,
      lastQuote: ticks[ticks.length - 1]?.quote,
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

  analyze(symbol, ticks) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;
    const digits = ticks.map(t => t.digit).filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
    if (digits.length < this.cfg.minTicksForAnalysis) return null;

    // Prefer a longer window for cycle estimation when available —
    // multi-scale rates need room to see regime transitions.
    const mode = this._mode();
    const baseWin = this.cfg.analysisWindow || this.cfg.tickWindow;
    const slowWin = this.cfg.raSlowWindow || 200;
    const want = mode === 'cycle' ? Math.max(baseWin, slowWin + 40) : baseWin;
    const window = Math.min(want, digits.length);
    const recentDigits = digits.slice(-window);

    if (mode === 'cycle') {
      const cyc = this._analyzeCycle(symbol, ticks, recentDigits);
      // Fall back to conditional if window too short for cycle engine
      if (cyc) return cyc;
      return this._analyzeLegacy(symbol, ticks, recentDigits, 'conditional');
    }
    return this._analyzeLegacy(symbol, ticks, recentDigits, mode);
  }

  rank(list) {
    return list.filter(Boolean).sort((a, b) => {
      const aAllow = a.allowedByModel ? 0 : 1;
      const bAllow = b.allowedByModel ? 0 : 1;
      if (aAllow !== bAllow) return aAllow - bAllow;
      // Prefer higher quiet-regime confidence when both allowed
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
      `STRATEGY=repeat_avoid mode=${mode} — cycle/regime engine; validate with BACKTEST=1 & DIAGNOSE=1 before sizing up.`
    );
    return new RepeatAvoidAnalyzer(cfg);
  }
  return new DigitAnalyzer(cfg);
}

// ─────────────────────────────────────────────────────────────────────
// 8. TRADE EXECUTOR — DIGITDIFF
// ─────────────────────────────────────────────────────────────────────
class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.open = new Map();
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

    const subId = await this.client.subscribe({ proposal_open_contract: 1, contract_id: info.contractId }, msg => this._onUpdate(msg, info));
    info.subId = subId;
    this.emit('open', info);
    return info;
  }
  async _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    const cid = c.contract_id || info.contractId;
    const status = c.status;
    const profit = Number(c.profit || 0);
    if (status === 'won' || status === 'lost') {
      const finished = {
        ...info,
        contractId: cid,
        status,
        profit,
        sellPrice: Number(c.sell_price || 0),
        sellTime: Number(c.sell_time || Date.now() / 1000),
        entryTick: c.entry_tick,
        exitTick: c.exit_tick,
        currentSpot: c.current_spot,
        shortcode: c.shortcode,
      };
      this.open.delete(cid);
      this.emit('result', finished);
      const subId = msg.subscription?.id || info.subId;
      if (subId) await this.client.forget(subId).catch(() => {});
    } else {
      this.emit('update', { ...info, contractId: cid, status, profit });
    }
  }
  count() { return this.open.size; }
  openTrades() { return [...this.open.values()]; }
}

// ─────────────────────────────────────────────────────────────────────
// 9. STATISTICS MANAGER
// ─────────────────────────────────────────────────────────────────────
class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.dailySummaries = {}; // date -> stats summary
    this.overallProfit = 0;
    this.currentLossStreak = 0;
    this.maxLossStreak = 0;
    this.lossStreakEvents = { x2: 0, x3: 0, x4: 0 };
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
    }
    return rec;
  }
  tradesForDate(date) { return this.trades.filter(t => t.date === date); }
  tradesForHour(date, hour) { return this.trades.filter(t => t.date === date && t.hour === hour); }
  todayTrades(date = utcDateStr()) { return this.tradesForDate(date); }
  stats(list) {
    const wins = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
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
    return {
      count: list.length,
      wins: wins.length,
      losses: losses.length,
      winRate: list.length ? wins.length / list.length * 100 : 0,
      grossWin,
      grossLoss,
      totalProfit: total,
      netPL: total,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      avgProfit: list.length ? total / list.length : 0,
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
/**
 * Tracks, per symbol, a rolling window of (predictedPWin, wasWin) pairs.
 *
 *   • enabled      = symbol is trading normally
 *   • disabled     = under-performing prediction; auto-benched
 *   • probing      = post-cooldown probe; smaller stake until re-calibrated
 *
 * A symbol is disabled when it has ≥ calibMinTrades in its window AND
 * empiricalWR < predictedWR − calibDisableGap.
 * After calibProbeAfterMs elapsed since disable, it enters "probing" mode
 * (traded at calibProbeStakeFrac × normal stake).  It becomes "enabled"
 * again once |empiricalWR − predictedWR| < calibReenableGap over
 * calibMinTrades fresh samples.
 */
class SymbolCalibrator {
  constructor(cfg, saved = null) {
    this.cfg     = cfg;
    this.symbols = new Map();  // symbol -> { window:[], state, disabledAt, note }
    if (saved && typeof saved === 'object') this.load(saved);
  }
  _slot(sym) {
    if (!this.symbols.has(sym)) {
      this.symbols.set(sym, {
        window     : [],          // { pWin, won, ts }
        state      : 'enabled',   // 'enabled' | 'disabled' | 'probing'
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
    const gap        = empirical - predicted;   // + means under-prediction (good); − means over-prediction (bad)
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
    // Auto-transition disabled → probing after cooldown elapses.
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
    // 1.0 for enabled, calibProbeStakeFrac for probing, 0 for disabled.
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
/**
 *  Kelly-fractional position sizer.
 *
 *  Optimal Kelly fraction of bankroll to stake:
 *      f* = (b·p − q) / b     where  b = payout_mult − 1
 *                                   p = win probability (from analyzer)
 *                                   q = 1 − p
 *
 *  We stake  bankroll × f* × kellyFraction  (defaults to quarter-Kelly).
 *  Hard-capped at kellyMaxStakeFrac of bankroll to survive tail streaks.
 *  Returns null when the edge is non-positive (skip the trade).
 */
class KellySizer {
  constructor(cfg) { this.cfg = cfg; }

  /**
   * @param {object} p
   * @param {number} p.bankroll     current live balance
   * @param {number} p.pWin         analyzer-predicted win probability
   * @param {number} p.payoutMult   total payout per 1 stake (e.g. 1.10)
   * @param {number} p.edgeValue    breakEven − pLossUpper − safetyMargin
   * @returns {{stake:number, fStar:number, fApplied:number, reason:string}|null}
   */
  compute({ bankroll, pWin, payoutMult, edgeValue }) {
    const cfg = this.cfg;
    const b   = Math.max(0, payoutMult - 1);     // net-of-stake win multiplier
    const p   = Math.max(0, Math.min(1, pWin));
    const q   = 1 - p;
    if (b <= 0) return null;
    const fStar = (b * p - q) / b;
    if (fStar <= 0) return null;                 // no Kelly recommendation
    if (edgeValue < cfg.kellyMinEdgeForScale) {
      // Trust the model less when the value-edge is marginal — take the
      // MINIMUM stake in that regime, not a scaled-up Kelly stake.
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
    this.livePayoutMult = new Map();  // symbol → last observed payout/ask ratio

    this.startBalance = null;
    this.lastBalance = null;
    this.lastTradeAt = 0;
    this.tradedAsset   = null;   // symbol most recently traded (rotation lock)
    this.tradedAssetAt = 0;      // when that symbol was traded (ms epoch)
    this.stopped = false;
    this._analysisT = null;
    this._hourlyBoot = null;
    this._hourlyT = null;
    this._eodBoot = null;
    this._eodT = null;

    // ── Trade watchdog timers ──
    this.tradeWatchdogMs = CONFIG.tradeWatchdogMs || 90000;
    this.tradeStartTime = null;
    this._tradeWatchdogTimer = null;
    this._tradeWatchdogPollTimer = null;
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
    await this.market.loadSymbols();

    const sizingLine = this.cfg.kellySizingEnabled
      ? `🧮 Sizing: <b>Kelly-fractional</b> (f=${this.cfg.kellyFraction}, cap=${(this.cfg.kellyMaxStakeFrac*100).toFixed(1)}% bankroll)`
      : (this.cfg.recoveryEnabled
          ? `🧮 Sizing: recovery ladder [${this.cfg.recoveryMultipliers.join(',')}] ⚠️`
          : `🧮 Sizing: flat`);
    const calibLine = this.cfg.calibEnabled
      ? `📐 Calibrator: <b>ON</b> (window=${this.cfg.calibWindow}, disableGap=${(this.cfg.calibDisableGap*100).toFixed(1)}pp)`
      : `📐 Calibrator: off`;
    const rotationLine = this.cfg.assetRotationMs > 0
      ? `🔄 Asset rotation: ${(this.cfg.assetRotationMs/1000).toFixed(0)}s lockout`
      : `🔄 Asset rotation: OFF (may repeat same symbol)`;
    const breakerLine = this.cfg.circuitBreakerEnabled
      ? `🛑 Circuit breaker: pause ${(this.cfg.circuitBreakerCooldownMs/60000).toFixed(0)}m after ${this.cfg.circuitBreakerLosses} losses in a row`
      : `🛑 Circuit breaker: off`;

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
      `📈 Signal: empirical digit frequency (heuristic, not a demonstrated edge — see file header)\n` +
      `🧯 Daily stop: ${money(-Math.abs(this.cfg.dailyMaxLoss), this.currency())} or ${(this.cfg.dailyMaxLossPct*100).toFixed(1)}% of balance, whichever first\n` +
      `🕒 Trade day clock: <b>GMT/UTC</b> | EOD: ${this.cfg.eodTimeGmt} GMT\n\n` +
      `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
      `❌ Loss streak: current ${this.stats.currentLossStreak}, x2=${this.stats.lossStreakEvents.x2}, x3=${this.stats.lossStreakEvents.x3}, x4=${this.stats.lossStreakEvents.x4}`
    );

    await this.market.bootstrap(this.cfg.assets);
    if (this._analysisT) clearInterval(this._analysisT);
    this._analyzeAndTrade().catch(e => logger.error('initial analyze:', e.message));
    this._analysisT = setInterval(() => this._analyzeAndTrade().catch(e => logger.error('analyze:', e.message)), this.cfg.analysisIntervalMs);
  }

  _onDisconnected(code, reason, wasAuthorized) {
    telegram.send(`⚠️ <b>x2Digit Connection lost</b>\ncode: <code>${code}</code>\nwas authorized: ${wasAuthorized ? 'yes' : 'no'}\n🔄 reconnecting...`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    this.exec.open.clear();
  }

  /**
   * currentStake(ctx?) — returns the recommended stake for the *next* trade.
   *
   *   • When ctx = { pWin, payoutMult, edgeValue, symbol } and Kelly sizing
   *     is enabled, use Kelly-fractional. Applied to bankroll = live
   *     balance × kellyBankrollFrac, capped at kellyMaxStakeFrac.
   *   • Otherwise fall back to the legacy flat/recovery-multiplier stake.
   *   • In both modes, the per-symbol calibrator's stake-multiplier is
   *     applied last (1.0 enabled, calibProbeStakeFrac probing, 0 disabled).
   */
  currentStake(ctx = null) {
    let base = 0;
    let src  = 'flat';
    if (this.cfg.kellySizingEnabled && ctx && ctx.pWin > 0 && ctx.payoutMult > 1) {
      const bankroll = Math.max(this.cfg.kellyBankrollFloor, this.lastBalance ?? this.client.balance ?? 0);
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
        // No positive-edge → refuse to size a trade.
        return { stake: 0, source: 'kelly-negative', calibMult: 1 };
      }
    } else {
      let mult = 1;
      if (this.cfg.recoveryEnabled) {
        const idx = Math.min(this.stats.currentLossStreak, this.cfg.recoveryMultipliers.length - 1);
        mult = this.cfg.recoveryMultipliers[idx] || 1;
      }
      base = +(this.cfg.stake * mult).toFixed(2);
      src  = `flat×${mult}`;
    }
    // Per-symbol calibrator scaling (0 = symbol disabled)
    let calibMult = 1;
    if (ctx?.symbol) calibMult = this.calibrator.stakeMultiplier(ctx.symbol);
    const stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, +(base * calibMult).toFixed(2)));
    return { stake: calibMult === 0 ? 0 : stake, source: src, calibMult };
  }

  async _analyzeAndTrade() {
    if (this.stopped || !this.client.authorized) return;
    if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
    if (this.exec.count() >= this.cfg.maxOpenTrades) return;

    // ── Consecutive-loss circuit breaker ──────────────────────────────
    // Stops trading entirely for a cooldown after N losses in a row,
    // independent of stake sizing. Cleared automatically once the
    // cooldown elapses, or immediately on the next win.
    if (this.cfg.circuitBreakerEnabled && this._circuitBreakerUntil && Date.now() < this._circuitBreakerUntil) {
      logger.debug(`circuit breaker active, resumes ${new Date(this._circuitBreakerUntil).toISOString()}`);
      return;
    }

    const today = utcDateStr();
    if (this._dayStartDate !== today) {
      this._dayStartDate = today;
      this._dayStartBalance = this.lastBalance ?? this.client.balance ?? this._dayStartBalance ?? null;
    }
    const todayTrades = this.stats.todayTrades(today);
    const todayStats = this.stats.stats(todayTrades);
    if (todayStats.count >= this.cfg.dailyMaxTrades) {
      logger.warn(`dailyMaxTrades reached (${todayStats.count}/${this.cfg.dailyMaxTrades})`);
      return;
    }
    if (todayStats.totalProfit <= -Math.abs(this.cfg.dailyMaxLoss)) {
      logger.warn(`dailyMaxLoss reached (${todayStats.totalProfit.toFixed(2)})`);
      return;
    }
    if (this._dayStartBalance != null && this.cfg.dailyMaxLossPct > 0) {
      const lossPct = -todayStats.totalProfit / Math.max(1, this._dayStartBalance);
      if (lossPct >= this.cfg.dailyMaxLossPct) {
        logger.warn(`dailyMaxLossPct reached (${(lossPct*100).toFixed(2)}% of ${this._dayStartBalance.toFixed(2)})`);
        return;
      }
    }
    if (this.cfg.dailyMaxProfit > 0 && todayStats.totalProfit >= this.cfg.dailyMaxProfit) {
      logger.info(`dailyMaxProfit reached (${todayStats.totalProfit.toFixed(2)})`);
      return;
    }

    // Per-symbol calibration filter — drop symbols the calibrator has
    // sidelined before we waste any proposal RPCs on them.
    const tradeableAssets = this.cfg.assets.filter(s => this.calibrator.isTradeable(s));
    const disabledAssets  = this.cfg.assets.filter(s => !this.calibrator.isTradeable(s));
    if (disabledAssets.length) {
      logger.debug(`CALIB: sidelined [${disabledAssets.join(',')}]`);
    }
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

    // For the initial proposal probe we use a MINIMAL stake (just to
    // discover the live payout) — the real stake is decided *after* we
    // know the payout, using Kelly + calibration.
    const probeStake = this.cfg.minStake;
    const proposalCandidates = [];

    for (const a of ranked.slice(0, Math.max(1, this.cfg.proposalScanTopN))) {
      if (!a.allowedByModel) continue;
      const candidateDigits = a.candidates.slice(0, Math.max(1, Math.min(3, this.cfg.proposalScanTopN)));
      for (const c of candidateDigits) {
        if (c.recentHits > this.cfg.maxRecentDigitHits) continue;
        if (c.pLossUpper > this.cfg.maxLossProb) continue;
        try {
          const pres = await this.exec.proposal(a.symbol, c.digit, probeStake);
          const p = pres.proposal;
          if (!p?.id) continue;
          const ask = Number(p.ask_price || probeStake);
          const payout = Number(p.payout || 0);
          if (!(payout > ask)) continue;
          const payoutMult      = payout / ask;
          const breakEvenLossProb = 1 - ask / payout;
          const valueEdge       = breakEvenLossProb - c.pLossUpper - this.cfg.safetyMargin;
          proposalCandidates.push({
            analysis: a,
            candidate: c,
            proposal: p,
            ask, payout, payoutMult,
            breakEvenLossProb,
            valueEdge,
          });
          this.livePayoutMult.set(a.symbol, payoutMult);
        } catch (e) {
          logger.debug(`proposal ${a.symbol} d${c.digit}:`, e.message);
        }
      }
    }

    proposalCandidates.sort((a, b) => b.valueEdge - a.valueEdge || a.candidate.pLossUpper - b.candidate.pLossUpper);

    // ── Filter by edge floor + asset rotation ─────────────────────
    // The old code aborted the entire scan when the top-ranked candidate
    // matched `this.tradedAsset`. That was a permanent lock: R_10 would
    // win rank #1 every scan, get skipped every scan, and the bot could
    // sit idle for days. Two fixes:
    //   1) The lock now EXPIRES after cfg.assetRotationMs (default 60s).
    //   2) If the top candidate is locked but a different-symbol
    //      candidate is available, we fall through to that one instead
    //      of skipping the whole scan.
    const rotationMs = Math.max(0, this.cfg.assetRotationMs || 0);
    const lockActive = rotationMs > 0
                    && this.tradedAsset
                    && (Date.now() - (this.tradedAssetAt || 0) < rotationMs);

    // Only consider candidates that clear the edge floor.
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

    // Prefer the highest-edge candidate that is NOT the recently-traded
    // symbol. If every qualified candidate is on the locked symbol,
    // check whether the lock has expired; if it has, allow re-trading
    // that symbol. If the lock is still active AND every candidate is
    // on that symbol, defer to the next scan.
    let best = qualified.find(c => !lockActive || c.analysis.symbol !== this.tradedAsset);
    if (!best) {
      if (lockActive) {
        const ageSec = ((Date.now() - (this.tradedAssetAt || 0)) / 1000).toFixed(1);
        logger.info(
          `skip: only qualifying symbol is ${this.tradedAsset} — still in ${(rotationMs/1000).toFixed(0)}s rotation cooldown (age ${ageSec}s). Will retry next scan.`
        );
        return;
      }
      best = qualified[0];   // lock expired; take the top candidate
    }
    if (best !== qualified[0]) {
      logger.info(
        `rotation: skipping locked ${qualified[0].analysis.symbol} (edge ${qualified[0].valueEdge.toFixed(4)}) → ` +
        `taking ${best.analysis.symbol} d${best.candidate.digit} (edge ${best.valueEdge.toFixed(4)})`
      );
    }

    // ── Compute the ACTUAL stake using Kelly + calibrator ──────────
    const pWin = 1 - best.candidate.pLossUpper;   // conservative win-prob (uses upper bound of loss prob)
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
    this.tradedAssetAt = Date.now();   // used by the rotation-lock expiry above

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
      stakeStakeRatio: +(stake / this.cfg.stake).toFixed(2),   // legacy field name kept for messages
      recoveryStakeMultiplier: +(stake / this.cfg.stake).toFixed(2),
      currentLossStreak: this.stats.currentLossStreak,
    };

    const trade = await this.exec.buy(a.symbol, c.digit, stake, payload);
    
    this.lastTradeAt = Date.now();
    logger.info(`trade placed #${trade.contractId} ${a.symbol} DIGITDIFF differs ${c.digit} edge=${best.valueEdge.toFixed(4)} pLossU=${c.pLossUpper.toFixed(4)} qBE=${best.breakEvenLossProb.toFixed(4)}`);
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
    this.lastBalance = (this.lastBalance ?? this.client.balance ?? 0) + Number(t.profit || 0);
    if (t.balanceAfter != null) this.lastBalance = Number(t.balanceAfter) + Number(t.profit || 0);

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
    // Uses the pWin we baked into the trade's analysis payload. Fall
    // back to (1 − pLossUpper) if the field is missing (legacy trades).
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

    // Kelly sizing metadata line (only shown when Kelly is on)
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
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses})\n` +
      `• Win rate: ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net P/L: <b>${money(todayStats.totalProfit, this.currency())}</b>\n` +
      `• Profit factor: ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n` +
      `💼 <b>Overall Profit:</b> ${money(this.stats.overallProfit, this.currency())}\n` +
      `❌ <b>Consecutive Losses:</b> current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
      `   x2=${this.stats.lossStreakEvents.x2}  x3=${this.stats.lossStreakEvents.x3}  x4=${this.stats.lossStreakEvents.x4}` +
      calibNote
    );

    this.lastTradeAt = Date.now();
    this._saveState('after-trade');
  }

  // ── Trade Watchdog ─────────────────────────────────────────
  _startTradeWatchdog(contractId) {
    this._clearWatchdogTimers();
    const timeoutMs = this.tradeWatchdogMs;
    this._tradeWatchdogTimer = setTimeout(() => {
      const hasActiveTrade = this.exec.openTrades().some(t => t.contractId);
      if (!hasActiveTrade) { this._clearWatchdogTimers(); return; }
      logger.warn(`WATCHDOG FIRED — Contract ${contractId || 'unknown'} open for ${(timeoutMs/1000).toFixed(0)}s with no settlement`);
      if (contractId && this.client.authorized && this.client.connected) {
        logger.info(`Polling contract ${contractId} for current status…`);
        this.client._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 })
          .catch(e => { logger.warn(`watchdog poll failed: ${e.message}`);
                        this._recoverStuckTrade('watchdog-poll-failed'); });
        this._tradeWatchdogPollTimer = setTimeout(() => {
          if (this.exec.count() === 0) { this._clearWatchdogTimers(); return; }
          logger.error(`WATCHDOG: Poll timed out — contract ${contractId} still unresolved`);
          this._recoverStuckTrade('watchdog-force');
        }, 15000);
      } else {
        this._recoverStuckTrade('watchdog-offline');
      }
    }, timeoutMs);
  }

  _clearWatchdogTimers() {
    if (this._tradeWatchdogTimer)     { clearTimeout(this._tradeWatchdogTimer);     this._tradeWatchdogTimer     = null; }
    if (this._tradeWatchdogPollTimer) { clearTimeout(this._tradeWatchdogPollTimer); this._tradeWatchdogPollTimer = null; }
  }

  async _recoverStuckTrade(reason) {
    this._clearWatchdogTimers();
    const stuck = this.exec.openTrades()[0];
    if (!stuck) { logger.warn('No active trade found for stuck trade recovery'); return; }
    const contractId  = stuck.contractId || 'unknown';
    const symbol      = stuck.symbol;
    const stake       = stuck.stake || 0;
    const entryTime   = this.tradeStartTime || (stuck.buyTime ? stuck.buyTime * 1000 : Date.now());
    const openSeconds = Math.round((Date.now() - entryTime) / 1000);
    logger.error(`STUCK TRADE [${reason}] #${contractId} ${symbol} ${openSeconds}s`);

    if (contractId !== 'unknown' && this.client.authorized && this.client.connected) {
      try { await this.exec.sell(contractId, 0); }
      catch (e) { logger.warn(`emergency sell failed: ${e.message}`); }
    }
    this.exec.open.delete(contractId);

    const finishedTrade = {
      contractId, symbol, stake, profit: -stake, status: 'lost',
      sellPrice: 0, sellTime: Date.now()/1000, buyTime: entryTime/1000,
    };
    this.stats.record(finishedTrade);
    this.lastBalance   = (this.lastBalance ?? this.client.balance ?? 0) + finishedTrade.profit;

    this.lastTradeAt    = Date.now();
    this.tradeStartTime = null;

    telegram.send(
      `<b>x2Digit STUCK TRADE RECOVERED [${reason}]</b>\n` +
      `Contract: ${contractId}\n` +
      `Asset: ${symbol}\n` +
      `Stake: $${stake.toFixed(2)}\n` +
      `Open: ${openSeconds}s`,
    );
    this._saveState('stuck-trade-recovery');
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
    // If EOD is at midnight GMT, report the trade day that just ended.
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
      `📊 Trades: ${s.count} (✅${s.wins} ❌${s.losses})\n` +
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
      msg += `📊 Trades: ${ds.count} (✅${ds.wins} ❌${ds.losses})\n` +
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

    // Per-symbol calibration snapshot
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
      version: 2,
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
// 10b. DIFFER BACKTESTER
// ─────────────────────────────────────────────────────────────────────
/**
 * Historical simulator for the selected DIGITDIFF strategy
 * (CONFIG.strategy / STRATEGY env: 'frequency' | 'repeat_avoid').
 *
 *   1. Deep-fetch N ticks (default 100K) via ticks_history in 5K batches.
 *   2. Build the analyzer via makeAnalyzer(cfg) so the walk uses the
 *      same implementation as live trading for the chosen strategy.
 *   3. For each index i (starting at minWindow) walk the history:
 *        a. Slice ticks[0..i] as the "known" series.
 *        b. Run analyzer.analyze() on the slice.
 *        c. If a non-gated candidate exists, compute the value-edge
 *           against a *synthetic* payout (BACKTEST_PAYOUT_MULT × stake)
 *           and check the same live-trade filters (minEdge, maxLossProb,
 *           strategy-specific model gates, optional tradedAsset lock).
 *        d. If the trade would fire, look up the actual expiry digit
 *           `ticks[i + durationTicks].digit` and settle:
 *              - loss if expiryDigit == barrierDigit
 *              - win  otherwise (P/L = payout - stake)
 *        e. Advance i by durationTicks+1 on a trade, else by 1.
 *   4. Report (strategy-labelled): signals, wins, losses, empirical
 *      win-rate vs predicted P(win), edge distribution histogram,
 *      consecutive-loss streak statistics, calibration gap, and
 *      per-symbol / per-barrier-digit breakdowns.
 *
 *  All overrides are applied to a LOCAL config copy — live trading
 *  cfg is never mutated.
 */

// ─────────────────────────────────────────────────────────────────────
// 8b. REPEAT/CYCLE DIAGNOSTICS
//
//   Tests, on your own historical tick data, whether "last digit
//   repeats vs. doesn't" shows genuine structure (serial correlation,
//   real cyclicality) or whether it looks exactly like what a plain
//   i.i.d. uniform digit process produces. This does NOT assume an
//   answer either way — it runs standard tests and reports the numbers
//   so you can see for yourself, per symbol, on real data.
//
//   Why this specific claim needs a specific test, not a general
//   argument: "digit t differs from digit t−1" happening or not is a
//   Bernoulli(p≈0.1) event. Bernoulli sequences are naturally bursty —
//   under pure randomness you WILL see stretches of many ticks with no
//   repeat, followed by clusters of repeats, purely from variance. That
//   visual burstiness is the textbook "clustering illusion": humans
//   reliably perceive streaks and cycles in sequences that are
//   provably memoryless (Gilovich, Vallone & Tversky 1985; Tversky &
//   Kahneman's "law of small numbers"). It FEELS like regime-switching.
//   The only way to tell the difference between a real regime and this
//   illusion is to test whether P(repeat at t | recent history) is
//   actually different from the unconditional P(repeat) — that's what
//   this module does.
//
//   Run it with:  DIAGNOSE=1 node accurateDiffer3.js
// ─────────────────────────────────────────────────────────────────────
class RepeatCycleDiagnostics {
  /** Wald–Wolfowitz runs test on a 0/1 series. Tests whether the number
   *  of "runs" (maximal same-value streaks) matches what randomness with
   *  the observed 0/1 proportions predicts. Too few runs → real
   *  clustering; too many → real alternation; either would falsify
   *  independence. z within ±1.96 ⇒ consistent with i.i.d. at 95%. */
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

  /** Autocorrelation of the repeat/no-repeat indicator series at lags
   *  1..maxLag, with the ~95% "white noise" confidence band (±1.96/√n).
   *  A real cycle of period P would show a spike at lag P that clears
   *  the band; pure noise will occasionally clear it by chance at a
   *  handful of lags (that's expected — check if it's *systematic*). */
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

  /** Direct test of the "cycling" claim: does P(repeat next tick) shift
   *  after a run of k consecutive non-repeats? Buckets by current
   *  non-repeat streak length and compares each bucket's empirical
   *  P(repeat) to the unconditional baseline with a 95% CI. */
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

  /** Chi-square test of independence between digit[t-1] and digit[t]
   *  (10×10 contingency table vs. product of marginals). This is the
   *  general form of "does knowing today's digit predict tomorrow's" —
   *  a real repeat-cycle would show up here as excess/deficit mass on
   *  the diagonal (digit[t]==digit[t-1] cells). */
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
    const df = 81; // (10-1)*(10-1)
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
  // Wilson–Hilferty approximation for the chi-square CDF (adequate for df~81, chi2 in typical ranges)
  _chiSqCdf(x, k) {
    if (x <= 0) return 0;
    const term = Math.pow(x / k, 1/3) - (1 - 2/(9*k));
    const z = term / Math.sqrt(2/(9*k));
    return this._normCdf(z);
  }

  /**
   * Multi-scale rate path + sticky 2-state filter snapshot — same features
   * the repeat_avoid cycle engine uses. Reports how often local rate is
   * depressed vs elevated, and how long quiet/hot labels persist.
   */
  cycleEngineSnapshot(seq, fast = 30, mid = 90, block = 20) {
    if (seq.length < mid + 10) return null;
    const base = seq.reduce((s, x) => s + x, 0) / seq.length;
    // Rolling block rates for emission estimate
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

    // Sticky forward filter
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

      // multi-scale rates ending at i
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

class DifferBacktester {
  constructor(cfg, client, market) {
    // Layer any backtest overrides on top of live cfg
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
    // Honour STRATEGY env / cfg.strategy ('frequency' | 'repeat_avoid')
    // so backtests exercise the same analyzer as live trading.
    this.strategy  = (this.cfg.strategy === 'repeat_avoid') ? 'repeat_avoid' : 'frequency';
    this.analyzer  = makeAnalyzer(this.cfg);
  }

  /** Human-readable strategy label for banners / reports. */
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
    // Validate symbol list
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
    const sharedGates =
      `  gates: minEdge=${this.cfg.minEdge}  ` +
      `safety=${this.cfg.safetyMargin}  ` +
      `modelMargin=${this.cfg.modelRiskMargin}  ` +
      `maxLossProb=${this.cfg.maxLossProb}`;
    if (this.strategy === 'repeat_avoid') {
      let mode = String(this.cfg.repeatAvoidMode || 'cycle').toLowerCase();
      if (mode === 'cycle' && this.cfg.repeatAvoidUseConditional) mode = 'conditional';
      if (mode === 'cycle') {
        console.log(
          `${sharedGates}\n` +
          `         strategy=repeat_avoid  mode=cycle  ` +
          `windows=${this.cfg.raFastWindow}/${this.cfg.raMidWindow}/${this.cfg.raSlowWindow}  ` +
          `minQuiet=${this.cfg.raMinQuietProb}  maxLocal=${this.cfg.raMaxLocalRate}\n` +
          `         phase-allow quiet=${this.cfg.raAllowQuiet} cooling=${this.cfg.raAllowCooling} neutral=${this.cfg.raAllowNeutral}\n` +
          `         duration=${this.cfg.durationTicks}t  payoutMult=${this.cfg.backtestPayoutMult}  ` +
          `assetLock=${this.cfg.backtestAssetLock}`
        );
      } else {
        console.log(
          `${sharedGates}\n` +
          `         strategy=repeat_avoid  mode=${mode}  ` +
          `maxBucket=${this.cfg.repeatAvoidMaxStreakBucket}  minBucketN=${this.cfg.repeatAvoidMinBucketN}\n` +
          `         duration=${this.cfg.durationTicks}t  payoutMult=${this.cfg.backtestPayoutMult}  ` +
          `assetLock=${this.cfg.backtestAssetLock}`
        );
      }
    } else {
      console.log(
        `${sharedGates}\n` +
        `         entropy=[${this.cfg.minEntropy},${this.cfg.maxEntropy}]  ` +
        `chi²=[${this.cfg.minChiSquare},${this.cfg.maxChiSquare}]  ` +
        `minGap=${this.cfg.minProbabilityGap}  ` +
        `maxHits=${this.cfg.maxRecentDigitHits}\n` +
        `         duration=${this.cfg.durationTicks}t  payoutMult=${this.cfg.backtestPayoutMult}  ` +
        `assetLock=${this.cfg.backtestAssetLock}`
      );
    }
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

  /**
   * Fire a live proposal to discover the actual payout multiplier Deriv
   * is quoting right now. Returns fallback on failure.
   */
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
      return payout / ask;   // total payout per unit stake
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

    // 0. Probe live payout multiplier (so the value-edge math matches
    //    live trading exactly).
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

    // 1. Fetch ticks
    logger.info(`fetching historical ticks (${symbol}, batched)…`);
    const ticks = await this.market.deepBackfill(
      symbol, this.cfg.backtestTicks, this.cfg.backtestBatchSize,
      (got, tot) => {
        if (got % 20000 < this.cfg.backtestBatchSize) logger.info(`  fetched ${got}/${tot}`);
      },
    );
    let pip = this.market.pipSize(symbol);
    // Belt-and-suspenders: if loadSymbols never populated pip_size for
    // this symbol (e.g. the user is on an older version that requests
    // active_symbols: 'brief'), infer it directly from the tick stream.
    // Deriv volatility indices always use a fixed decimal count per
    // symbol so this is a safe recovery.
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
      // Push it into the market cache so downstream code (analyze,
      // recomputes) uses the same value.
      this.market.pipSizes.set(symbol, pip);
      // Also patch every tick's digit field so it reflects the
      // correct pip. Without this, the analyzer would use the old
      // (wrong) digits and every empirical WR would be garbage.
      for (const t of ticks) t.digit = quoteToDigit(t.quote, pip);
    }
    if (ticks.length < this.cfg.minTicksForAnalysis + this.cfg.durationTicks + 10) {
      throw new Error(`insufficient history for ${symbol}: got ${ticks.length}`);
    }
    logger.info(
      `have ${ticks.length} ticks  pip=${pip}  ` +
      `span=${new Date(ticks[0].epoch*1000).toISOString().slice(0,19)}Z → ` +
      `${new Date(ticks[ticks.length-1].epoch*1000).toISOString().slice(0,19)}Z`
    );

    // 2. Walk forward
    const baseStake   = this.cfg.stake;
    // `payoutMult` = total payout per 1 stake (includes returned stake),
    // probed live above. On DIGITDIFF this is typically ~1.10.
    const duration    = Math.max(1, this.cfg.durationTicks);
    const minWindow   = Math.max(this.cfg.minTicksForAnalysis, 300);

    // Local Kelly + calibrator instances so the backtest mirrors live logic.
    const kelly       = new KellySizer(this.cfg);
    const calib       = new SymbolCalibrator(this.cfg);
    // Simulated bankroll: starts at 100× base stake unless the user sets
    // KELLY_BANKROLL_FLOOR to something explicit.
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
      startEpoch : ticks[0].epoch,
      endEpoch   : ticks[ticks.length - 1].epoch,
      tickCount  : ticks.length,
      signals    : 0,
      wins       : 0,
      losses     : 0,
      pnl        : 0,
      grossWin   : 0,
      grossLoss  : 0,
      predictedWinSum : 0,   // sum of (1 - pLossUpper) across all signals
      valueEdgeSum    : 0,
      byDigit    : {},       // barrier-digit histogram
      // repeat_avoid: how often the barrier came from flat vs conditional estimate
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
      gatedSample    : 0,   // repeat_avoid: sample-too-small
      gatedPhase     : 0,   // cycle: phase-block
      gatedRegime    : 0,   // cycle: regime-hot / quiet-prob-low / collapsed
      gatedLocalRate : 0,   // cycle: local-rate-high
      gatedEdge      : 0,   // best candidate edge < minEdge
      gatedAssetLock : 0,
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

    // Loss-streak tracker — same semantics as StatisticsManager
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
    let tradedAsset    = null;   // mirrors bot.tradedAsset when assetLock=true
    let lastTradeAtIdx = -Infinity;
    let i = minWindow;

    while (i < ticks.length - duration - 1) {
      const window   = ticks.slice(0, i + 1);
      const analysis = this.analyzer.analyze(symbol, window);
      diag.scans++;

      if (!analysis) { diag.nullAnalyses++; i++; continue; }

      // Track gate rejections (mirrors analyzer `gates` for both strategies)
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

      // Compute the value edge exactly the way live code does. In the
      // backtester ask == baseStake (we're not paying for a real RPC),
      // and the payout is baseStake × payoutMult (probed live at start).
      const c = analysis.best;
      const ask = baseStake;
      const payoutFull = baseStake * payoutMult;
      const breakEvenLossProb = 1 - ask / payoutFull;
      const valueEdge = breakEvenLossProb - c.pLossUpper - this.cfg.safetyMargin;

      if (valueEdge > diag.bestEdgeSeen) diag.bestEdgeSeen = valueEdge;
      if (c.pLossUpper < diag.bestLossPUSeen) diag.bestLossPUSeen = c.pLossUpper;
      diag.edgeBuckets[bucketize(valueEdge)]++;

      // Would this trade actually fire?
      let fire = analysis.allowedByModel;
      if (fire && valueEdge < this.cfg.minEdge)                     { fire = false; diag.gatedEdge++; }
      // Asset-lock (opt-in only for single-symbol backtests). The live
      // bot uses tradedAsset to force multi-symbol rotation; in a
      // single-symbol backtest it would trigger once and then block
      // every subsequent scan, so we only apply it within a short
      // cooldown window (backtestAssetLockTicks) and never as a hard
      // permanent lock.
      if (fire && this.cfg.backtestAssetLock && tradedAsset === symbol
          && (i - lastTradeAtIdx) < this.cfg.backtestAssetLockTicks) {
        fire = false; diag.gatedAssetLock++;
      }
      // Per-symbol calibrator gate (0 = disabled) — only applied when calibEnabled
      let calibMult = 1;
      if (fire && this.cfg.calibEnabled) {
        calibMult = calib.stakeMultiplier(symbol);
        if (calibMult === 0) { fire = false; diag.gatedCalib = (diag.gatedCalib || 0) + 1; }
      }

      if (!fire) { i++; continue; }

      // ── Size the trade ─────────────────────────────────────────
      // Match live currentStake(): Kelly + calibrator when enabled,
      // otherwise flat.  All results below use this per-trade stake.
      let stake = baseStake;
      let sizingSrc = 'flat';
      if (this.cfg.kellySizingEnabled) {
        const pWin = 1 - c.pLossUpper;
        const k    = kelly.compute({
          bankroll  : Math.max(this.cfg.kellyBankrollFloor, simBankroll),
          pWin, payoutMult, edgeValue: valueEdge,
        });
        if (k) { stake = k.stake; sizingSrc = `kelly(${k.reason})`; }
        else   { i++; continue; }   // no positive-edge under Kelly → skip
      }
      stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, +(stake * calibMult).toFixed(2)));
      if (stake <= 0) { i++; continue; }

      const winNet  = stake * payoutMult - stake;
      const lossNet = -stake;

      // ── Simulate settlement ────────────────────────────────────
      const expiryTick = ticks[i + duration];
      if (!expiryTick || expiryTick.digit == null) { i++; continue; }
      const won = expiryTick.digit !== c.digit;

      results.signals += 1;
      results.predictedWinSum += (1 - c.pLossUpper);
      results.valueEdgeSum    += valueEdge;
      results.byDigit[c.digit].signals += 1;
      diag.recommended += 1;

      // repeat_avoid: track estimate source + cycle phase buckets
      let srcKey = null;
      let phaseKey = null;
      if (results.bySource) {
        const raw = String(c.source || analysis.method || 'unknown');
        srcKey = raw;
        if (!results.bySource[srcKey]) {
          results.bySource[srcKey] = { signals: 0, wins: 0, losses: 0, pnl: 0 };
        }
        results.bySource[srcKey].signals += 1;
      }
      if (results.byPhase) {
        phaseKey = c.phase || analysis.cycle?.phase || 'n/a';
        if (!results.byPhase[phaseKey]) {
          results.byPhase[phaseKey] = { signals: 0, wins: 0, losses: 0, pnl: 0 };
        }
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

      // Feed the calibrator (only if enabled)
      if (this.cfg.calibEnabled) calib.record(symbol, 1 - c.pLossUpper, won);

      tradedAsset    = symbol;
      lastTradeAtIdx = i;
      i += duration + 1;

      if (results.signals % 100 === 0) {
        const wr = (results.wins / results.signals * 100).toFixed(1);
        logger.info(`  ...${i}/${ticks.length} signals=${results.signals} WR=${wr}% pnl=${results.pnl.toFixed(2)} bank=${simBankroll.toFixed(2)}`);
      }
    }

    results.endBankroll   = +simBankroll.toFixed(2);
    results.startBankroll = +startBankroll.toFixed(2);
    results.bankrollGrowthPct = startBankroll > 0
      ? +(((simBankroll - startBankroll) / startBankroll) * 100).toFixed(2)
      : 0;
    results.calibSummary  = calib.summary();

    // Flush trailing streak
    if (streak.current    > 0) streak.lossSequences.push(streak.current);
    if (streak.currentWin > 0) streak.winSequences.push(streak.currentWin);

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const empiricalWR = results.signals ? results.wins / results.signals * 100 : 0;
    const predictedWR = results.signals ? (results.predictedWinSum / results.signals) * 100 : 0;
    const avgEdge     = results.signals ? (results.valueEdgeSum / results.signals) * 100 : 0;
    // Realized EV as % of *base* stake, so the number is comparable
    // across Kelly/flat/calibration modes.
    const realizedEV  = results.signals ? (results.pnl / (results.signals * baseStake)) * 100 : 0;

    // Loss-streak metrics
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
      // Simulated recovery-multiplier drawdown: what you'd lose in cash
      // through the WORST loss run using cfg.recoveryMultipliers.
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

    // Assemble result object
    Object.assign(results, {
      durationSec       : +dt,
      empiricalWinRate  : +empiricalWR.toFixed(2),
      predictedWinRate  : +predictedWR.toFixed(2),
      calibrationGap    : +(empiricalWR - predictedWR).toFixed(2),
      avgValueEdgePct   : +avgEdge.toFixed(3),
      realizedEVPct     : +realizedEV.toFixed(3),
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
    console.log(`  Ticks processed : ${ticks.length.toLocaleString()}   pip_size=${pip}`);
    console.log(`  Signals fired   : ${results.signals}`);
    console.log(`  Wins / Losses   : ${results.wins} / ${results.losses}`);
    console.log(`  Empirical WR    : ${empiricalWR.toFixed(2)}%`);
    console.log(`  Predicted P(win): ${predictedWR.toFixed(2)}%   (calibration gap ${(empiricalWR - predictedWR).toFixed(2)} pp)`);
    console.log(`  Avg value edge  : ${avgEdge.toFixed(3)}%   Realized EV: ${realizedEV.toFixed(3)}%`);
    console.log(`  Gross win / loss: +${results.grossWin.toFixed(2)} / -${results.grossLoss.toFixed(2)}`);
    console.log(`  Net P/L         : ${results.pnl >= 0 ? '+' : ''}${results.pnl.toFixed(2)} ${this.cfg.currency}`);
    console.log(`  Profit factor   : ${results.profitFactor === Infinity ? '∞' : results.profitFactor.toFixed(3)}`);
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

    // ── Consecutive-loss stats ────────────────────────────────
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

    // ── Bankroll evolution (Kelly-sizing view) ────────────────
    if (this.cfg.kellySizingEnabled) {
      console.log(line);
      console.log('  Kelly-sizing bankroll evolution:');
      console.log(`    Start bankroll     : ${results.startBankroll.toFixed(2)} ${this.cfg.currency}`);
      console.log(`    End   bankroll     : ${results.endBankroll.toFixed(2)} ${this.cfg.currency}`);
      const dollarPl = results.endBankroll - results.startBankroll;
      console.log(`    Δ                  : ${dollarPl >= 0 ? '+' : ''}${dollarPl.toFixed(2)} (${results.bankrollGrowthPct >= 0 ? '+' : ''}${results.bankrollGrowthPct}%)`);
      console.log(`    Kelly fraction     : ${this.cfg.kellyFraction}  (cap ${(this.cfg.kellyMaxStakeFrac*100).toFixed(2)}% bankroll)`);
    }

    // ── Per-symbol calibrator snapshot ────────────────────────
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

    // ── Diagnostics (strategy-aware) ──────────────────────────
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

    // Edge histogram
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

    // Suggestions
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
    }
    console.log(line + '\n');

    return results;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 11. BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Deriv Digit Differ Bot v3.0 (honest edition)             ║');
  console.log('║   DIGITDIFF • Empirical Frequency • Value-Edge Gate        ║');
  console.log('║   GMT EOD • Kelly/Calib • Circuit Breaker • Stateful Stats ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  No trading method guarantees consistent profit on a fair RNG.');
  console.log('  This bot is a risk-management framework around a heuristic signal,');
  console.log('  not a demonstrated statistical edge. See file header for details.');
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
          // deepBackfill chains multiple ticks_history calls to get past
          // Deriv's ~5000-tick single-request cap — same mechanism the
          // backtester uses to reach 40k-100k+ ticks.
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
//    NOTE: "wider net" does not mean "better odds" — it just means
//    fewer trades get filtered out before the sizing/circuit-breaker
//    layer. Expected value per trade is still governed by the house
//    edge on DIGITDIFF, not by this analysis window.
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
