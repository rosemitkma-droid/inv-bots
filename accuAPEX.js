#!/usr/bin/env node
'use strict';
/**
 * =====================================================================
 * Deriv Accumulator Bot — APEX engine (single-file) — v2.0
 * =====================================================================
 *
 * APEX = Asymmetric Post-spike EXploit
 *        (conditional-volatility bimodal survival engine)
 *
 * ─────────────────────────────────────────────────────────────────
 * WHY THIS METHOD  (research synthesis)
 * ─────────────────────────────────────────────────────────────────
 * A Deriv Accumulator pays  stake·(1+g)^N  as long as every tick
 * stays inside a FIXED ±barrier of the prior spot; one breach loses
 * the whole stake. Deriv sets that single barrier from each asset's
 * *aggregate / unconditional* volatility. That is the exploit: the
 * true short-horizon volatility is *conditional*, and on several of
 * these synthetics it is strongly regime-dependent, so at specific
 * moments the fixed barrier is much wider than the volatility that is
 * actually acting on price right now.
 *
 *   • BOOM / CRASH indices are bimodal: tiny orderly drift ~all the
 *     time, punctuated by a rare large spike every ~N ticks. Because
 *     the barrier must price in the spike, it is *very wide* vs the
 *     calm inter-spike drift → per-tick survival ≈ 1 between spikes.
 *     The ONLY real knockout is a spike, and spike hazard is lowest
 *     immediately AFTER a spike fires. APEX therefore enters only in
 *     the fresh post-spike low-hazard window and holds a short,
 *     hazard-bounded number of ticks.
 *
 *   • VOLATILITY / JUMP indices (R_*, 1HZ*V) are near-i.i.d. Gaussian.
 *     The only honest edge is *transient volatility compression* —
 *     enter only when current realised σ sits well below the σ the
 *     barrier was priced against, so the barrier is temporarily loose.
 *
 * APEX turns those two observations into one engine:
 *   1. Robust scale via MAD (spike-resistant) + EWMA fast/slow σ.
 *   2. Explicit spike detection (|return| ≫ robust scale).
 *   3. Regime classification per asset: BOOM / CRASH / VOL.
 *   4. Forward K-tick survival estimated CONDITIONALLY — the spike
 *      hazard is modelled by ticks-since-last-spike, not by blindly
 *      resampling history that contains the spike itself.
 *   5. Entry gates that fire only in the exploitable window
 *      (post-spike for Boom/Crash, vol-compressed for Vol indices),
 *      then pick the EV-optimal compounding horizon net of spread.
 *   6. Adaptive exit on rising spike hazard, drift toward barrier,
 *      or profit-lock — compounding is banked, never round-tripped.
 *
 * Every piece of trading INFRASTRUCTURE from the PULSE scaffold is
 * retained verbatim (WS/REST client, auth/OTP flow, Telegram, stats,
 * martingale, watchdog, state persistence, GMT summaries, backtester).
 * Only the market ANALYSIS and the EXIT decision are novel.
 *
 * Author : APEX synthesis
 * License: MIT
 * =====================================================================
 */
'use strict';

// ─────────────────────────────────────────────────────────────────────
// 0. DEPENDENCIES
// ─────────────────────────────────────────────────────────────────────
const WebSocket    = require('ws');            // npm install ws
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { URL }      = require('url');
const EventEmitter = require('events');

// ─────────────────────────────────────────────────────────────────────
// 1. .ENV LOADER
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

function money(n, currency = CONFIG.currency) {
  const x = Number(n || 0);
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)} ${currency}`;
}
function utcDateStr(d = new Date()) { return d.toISOString().slice(0, 10); }
function previousUtcDateStr(d = new Date()) {
  return new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10);
}
function utcHour(d = new Date()) { return d.getUTCHours(); }
const pad = n => String(n).padStart(2, '0');

// ─────────────────────────────────────────────────────────────────────
// 2. CONFIGURATION
// ─────────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  // ─ Deriv API ─
  // apiToken:    ('0P94g4WdSrSrzir').trim(),
  // appId:       '1089',
  apiToken:    'pat_27a3197287bae3ec6c2c9cbdd68fffaa2a524e3b0a6e1ecf298b5ffb338adb10',
  appId:       '33uslPtthXBEkQOdfKfoY',
  wsUrl:       'wss://ws.derivws.com/websockets/v3',
  currency:    ('USD').toUpperCase(),
  accountType: ('demo').toLowerCase(), // 'demo'|'real'

  // ─ Trade parameters ─
  stake:          parseFloat('5.0'),
  multiplier:     parseFloat('0.04'), // legacy hint
  multiplierStep: parseFloat('0.0'),
  stopLoss:       parseFloat('900.0'),
  takeProfit:     parseFloat('10000.0'),

  // ── Martingale ──
  martingale:            parseFloat('0'),   // 0 = off
  martingaleStep:        parseFloat('9'),
  lossesBeforeMartingale:parseInt  ('0'),
  maxMartingaleStep:     parseFloat('900'),

  // ─ Sizing ─
  sizingMode:        'flat',            // 'flat' | 'edge'
  edgeScaleMax:      parseFloat('2.0'),
  edgeScaleEdgeRef:  parseFloat('0.05'),
  downscaleAfterLoss:false,

  // ─ Assets ─
  // ─ Assets (Deriv synthetic indices) ─
  // assets: ('R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V,BOOM50,BOOM150N,BOOM300N,BOOM500,BOOM600,BOOM900,BOOM1000,CRASH50,CRASH150N,CRASH300N,CRASH500,CRASH600,CRASH900,CRASH1000')
  //   .split(',').map(s => s.trim()).filter(Boolean),

  assets: ('R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V,BOOM500,BOOM600,BOOM900,BOOM1000,CRASH500,CRASH600,CRASH900,CRASH1000')
    .split(',').map(s => s.trim()).filter(Boolean),

  // ─ Telegram ─
  telegram: {
    enabled : true,
    botToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    chatId  : '752497117',
  },

  // ─ Strategy timing ─
  tickWindow          : parseInt('200',   10),
  minTicksForAnalysis : parseInt('80',    10),
  analysisIntervalMs  : parseInt('15000', 10),
  tradeCooldownMs     : parseInt('4000',  10),
  maxOpenTrades       : parseInt('1',     10),

  // ─ Daily limits ─
  dailyMaxLoss  : parseFloat('500'),
  dailyMaxTrades: parseInt ('2000000000'),

  // ─ GMT/UTC reporting ─
  eodTimeGmt         : '00:00',
  eodSendDelaySeconds: parseInt('10', 10),
  hourlySummary      : true,

  // ─ Reconnect ─
  reconnect: {
    initialDelayMs: 1000,
    maxDelayMs    : 60000,
    backoffFactor : 2,
    jitterMs      : 750,
  },

  // ─ Logging ─
  logFile : 'deriv_apex_botb.log',
  logLevel: ('INFO').toUpperCase(),

  // ═══════════════════════════════════════════════════════════════════
  // PULSE-COMPAT TUNABLES (kept so the backtester & shared helpers work)
  // ═══════════════════════════════════════════════════════════════════
  pulseReturnWindow   : parseInt('120',   10), // ticks used to bootstrap μ,σ
  pulseHorizon        : parseInt('20',    10), // max ticks simulated forward
  pulseTrials         : parseInt('10000', 10), // MC paths per (asset,growth)
  pulseMinTrials      : parseInt('4000',  10),

  // ─ EV gates ─
  //   pulseEdgeThreshold: gross EV ratio floor. 1.05 = +5% expected return
  //   per unit stake AFTER spread cost. Anything below this is noise.
  pulseEdgeThreshold  : parseFloat('0.985'), //1.005 //1.015
  pulseMinEV          : parseFloat('0.005'),   //0.015 ≥ +1.5% EV net of spread
  pulseMinSurvival    : parseFloat('0.93'),   //0.985
  pulseMaxHorizon     : parseInt  ('6', 10),  

  // ─ Growth-rate candidates (Deriv supports 0.01-0.05) ─
  //   APEX evaluates every rate and lets EV pick the best per regime.
  pulseGrowthRates    : [0.05, 0.04, 0.03], // eval multiple rates, let EV pick best

  // ─ Volatility regime ─
  pulseCalmMaxRatio   : parseFloat('1.05'), // 1.05
  pulseStormyMinRatio : parseFloat('1.20'),

  // ─ Spread model ─
  //   Round-trip bid/ask cost as a fraction of stake, deducted from
  //   every edge calculation so the reported EV is honest.
  //   0.002 = 0.2% round-trip (typical short-hold estimate).
  pulseSpreadCost     : parseFloat('0.002'),

  // ═══════════════════════════════════════════════════════════════════
  // APEX STRATEGY TUNABLES  (the novel engine)
  // ═══════════════════════════════════════════════════════════════════
  //   History depth. Spike cadence can only be measured if the analysis
  //   window spans SEVERAL spike intervals. Boom/Crash 1000 spikes every
  //   ~1000 ticks, so we keep ≥6000 ticks so ≥2 spikes are almost always
  //   in view. This is the single most important APEX tunable.
  apexHistoryWindow   : parseInt('6000', 10),

  //   Robust scale + spike model. All values are conservative defaults
  //   validated against the barrier math in the research notes.
  apexScaleWindow     : parseInt('150', 10),   // ticks for MAD robust scale
  apexEwmaFast        : parseFloat('0.30'),     // fast EWMA-σ weight (recent)
  apexEwmaSlow        : parseFloat('0.03'),     // slow EWMA-σ weight (baseline)

  // ─ Spike detection ─
  //   A tick whose |log-return| exceeds apexSpikeK × robust-scale is a
  //   "spike". Boom/Crash spikes are ~10-40× the calm drift, so a K of
  //   5 cleanly separates spike from drift without false positives.
  apexSpikeK          : parseFloat('5.0'),
  apexMinSpikesSeen   : parseInt('2', 10),      // need ≥2 spikes to trust cadence

  // ─ Post-spike entry window (Boom/Crash) ─
  //   Enter only when we are within the first apexPostSpikeWindow ticks
  //   after a fresh spike AND at least apexPostSpikeMin ticks have passed
  //   (the 1-2 ticks around a spike can be jumpy). Fraction of measured
  //   spike cadence — a spike that just fired resets the hazard clock.
  apexPostSpikeMin        : parseInt('1', 10),
  apexPostSpikeWindowFrac : parseFloat('0.35'), // fraction of mean cadence
  apexMaxHazard           : parseFloat('0.010'), // legacy: reject if per-tick hazard > 1% (now superseded by apexMinSpikeSurvival)
  // v3: Hold-period-aware spike survival. Instead of a fixed per-tick hazard
  // threshold (which incorrectly blocks fast-cadence assets like BOOM50),
  // check that spike survival over the actual hold duration is acceptable.
  // e.g. 0.50 = need ≥50% chance of no spike during the hold.
  // BOOM50: (1-0.02)^8 = 0.85 ≥ 0.50 → PASS ✓
  // BOOM1000: (1-0.001)^8 = 0.992 ≥ 0.50 → PASS ✓
  // Extreme (cadence=10, hold=8): (0.9)^8 = 0.43 < 0.50 → REJECTED ✓
  apexMinSpikeSurvival    : parseFloat('0.80'), //0.50

  // ─ Vol-compression entry (Volatility / Jump indices) ─
  //   Enter only when fast σ is at most apexVolCompressRatio × slow σ,
  //   i.e. the market is quieter than the barrier was priced for.
  apexVolCompressRatio : parseFloat('0.90'),
  //   Barrier must clear current drift by this safety factor: the
  //   one-tick move needed to breach must be ≥ apexBarrierSafety × σ.
  apexBarrierSafety    : parseFloat('3.2'),

  // ─ Survival / EV requirements (per-class overrides of pulse* gates) ─
  apexMinSurvival     : parseFloat('0.90'),  // forward K-tick survival floor
  apexMinEV           : parseFloat('0.010'), // ≥ +1% net EV to fire
  apexMaxHoldBoom     : parseInt('4',  10),  // Boom/Crash hold cap (ticks)
  apexMaxHoldVol      : parseInt('4',  10),  // Vol/Jump hold cap (ticks)

  // ─ Adaptive-exit (APEX) ─
  //   Exit if the live per-tick spike hazard rises above this, if drift
  //   eats this fraction of the barrier, or once profit-lock triggers.
  apexExitHazard      : parseFloat('0.020'),
  apexExitDriftFrac   : parseFloat('0.55'),
  apexProfitLockFrac  : parseFloat('0.60'),  // lock ≥60% of expected remaining
  apexMinProfitLockFrac: parseFloat('0.004'),


  // ═══════════════════════════════════════════════════════════════════
  // v3: PER-ASSET RISK MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════

  //   Max entries per post-spike window per asset. After a spike fires,
  //   the bot has a limited exploitable window. Re-entering too many
  //   times in the same window increases exposure to the next spike.
  maxEntriesPerSpikeWindow : parseInt('3', 10),

  //   Cooldown after a loss on a specific asset (ms). Prevents
  //   re-entering the same asset immediately after a loss.
  assetLossCooldownMs      : parseInt('120000', 10),  // 2 minutes

  //   After N consecutive losses on one asset, pause that asset entirely.
  assetMaxConsecutiveLosses: parseInt('3', 10),

  //   How long to pause an asset after hitting consecutive loss limit (ms).
  assetPauseDurationMs     : parseInt('600000', 10),  // 10 minutes

  //   Don't trade an asset if its rolling win rate drops below this.
  minWinRateToTrade        : parseFloat('0.38'),  // 38%

  //   Number of recent trades per asset to consider for rolling WR.
  rollingWindowSize        : parseInt('15', 10),

  //   Session-level circuit breaker: halt ALL trading if unrealized +
  //   realized session drawdown exceeds this (in currency units).
  sessionMaxDrawdown       : parseFloat('300'),

  //   Don't trade more than N different assets in the same analysis cycle.
  maxAssetsTrading         : parseInt('2', 10),

  //   Minimum edge required to trade an asset that has recent losses.
  //   Higher loss streak → need higher edge to justify re-entry.
  edgeAfterLossBoost       : parseFloat('0.008'),  // +0.8% edge per loss in streak

  // ═══════════════════════════════════════════════════════════════════
  // v3: DYNAMIC ASSET DISCOVERY
  // ═══════════════════════════════════════════════════════════════════
  autoDiscoverAssets       : true,
  discoveryIntervalMs      : parseInt('3600000', 10),  // re-discover every hour

  //   Asset families to include in auto-discovery (case-insensitive).
  //   Empty = discover all ACCU-capable assets.
  assetFamilyFilter        : ['BOOM', 'CRASH'],

  //   Correlated assets to avoid trading simultaneously.
  //   If BOOM1000 is active, don't also enter BOOM900 (same regime).
  correlatedGroups         : [
    ['BOOM1000', 'BOOM900', 'BOOM600', 'BOOM500', 'BOOM300N', 'BOOM150N', 'BOOM50'],
    ['CRASH1000', 'CRASH900', 'CRASH600', 'CRASH500', 'CRASH1300N', 'CRASH150N', 'CRASH50'],
  ],

  // ═══════════════════════════════════════════════════════════════════
  // v3: SMART POSITION SIZING (replaces raw martingale)
  // ═══════════════════════════════════════════════════════════════════
  sizingModeV3             : 'adaptive',  // 'flat'|'adaptive'|'kelly'

  //   Adaptive: after a loss, reduce stake by this factor (anti-martingale).
  //   Rationale: a loss means the regime may have changed → trade smaller.
  lossStakeReduction       : parseFloat('0.70'),  // stake × 0.70 after each loss

  //   After a win, restore stake by this factor (partial recovery).
  winStakeRecovery         : parseFloat('1.15'),  // stake × 1.15 after each win

  //   Minimum stake floor (fraction of base stake).
  minStakeFraction         : parseFloat('0.25'),  // never go below 25% of base

  //   Maximum stake ceiling (fraction of base stake).
  maxStakeFraction         : parseFloat('2.50'),  // never exceed 250% of base

  //   Kelly fraction: use this fraction of full Kelly for sizing.
  //   0.25 = quarter-Kelly (very conservative).
  kellyFraction            : parseFloat('0.20'),

  // ─ Barrier refresh ─
  barrierRefreshMs    : parseInt('45000', 10),

  // ─ Adaptive early-exit ─
  pulseExitProfitLockFrac : parseFloat('0.55'),
  pulseExitDriftFrac      : parseFloat('0.50'),
  pulseExitNextTickEdge   : parseFloat('1.00'),
  // Bug 5 fix — profit-lock requires the profit to be at least this
  // fraction of stake before it can fire (prevents "lock at 0.001$").
  pulseMinProfitLockFrac  : parseFloat('0.003'),

  // ─ Trade watchdog ─
  tradeWatchdogMs: parseInt('90000', 10),

  // ─ State persistence ─
  stateFile          : 'deriv_apex_bot_stateb.json',
  stateSaveOnTrade   : true,
  stateSaveOnShutdown: true,

  // ═══════════════════════════════════════════════════════════════════
  // BACKTESTER (Fix #4)
  // ═══════════════════════════════════════════════════════════════════
  //   Run with:  BACKTEST=1 node accuAPEX.js
  //   Optional:  BACKTEST_ASSET=BOOM1000 BACKTEST_TICKS=100000
  //   v3 all:    BACKTEST=1 BACKTEST_ALL=1 node accuAPEX.js
  //
  //   NOTE on history depth: Deriv's ticks_history endpoint typically
  //   only serves ~24 h of ticks (≈ 43K on R_10, ≈ 43K on R_100). Asking
  //   for 100K just means "give me all you have" — the batcher stops
  //   when a batch comes back short.
  //
  //   Diagnostic overrides — these do NOT affect live trading, only the
  //   backtest run. Use them to see whether the strategy WOULD have
  //   signalled at a lower threshold, without touching live safety gates.
  //     BACKTEST_EDGE=1.015          (override pulseEdgeThreshold)
  //     BACKTEST_MIN_EV=0.010        (override pulseMinEV)
  //     BACKTEST_MAX_HORIZON=4       (override pulseMaxHorizon)
  //     BACKTEST_MIN_SURV=0.85       (override pulseMinSurvival)
  //     BACKTEST_CALM_MAX=1.20       (override pulseCalmMaxRatio)
  backtestTicks       : process.env.BACKTEST_TICKS ? parseInt(process.env.BACKTEST_TICKS) : parseInt('100000', 10),
  backtestBatchSize   : parseInt('5000',   10),
  backtestStepEvery   : parseInt('1',      10),
  backtestReportEvery : parseInt('10000',  10),
  backtestOutFile     : 'apex_backtest_report.json',

  backtestEdge        : process.env.BACKTEST_EDGE        ? parseFloat(process.env.BACKTEST_EDGE)        : null,
  backtestMinEV       : process.env.BACKTEST_MIN_EV      ? parseFloat(process.env.BACKTEST_MIN_EV)      : null,
  backtestMaxHorizon  : process.env.BACKTEST_MAX_HORIZON ? parseInt  (process.env.BACKTEST_MAX_HORIZON) : null,
  backtestMinSurv     : process.env.BACKTEST_MIN_SURV    ? parseFloat(process.env.BACKTEST_MIN_SURV)    : null,
  backtestCalmMax     : process.env.BACKTEST_CALM_MAX    ? parseFloat(process.env.BACKTEST_CALM_MAX)    : null,
});

// ─────────────────────────────────────────────────────────────────────
// 3. LOGGER
// ─────────────────────────────────────────────────────────────────────
const LOG_LEVELS   = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.INFO;

const ts = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
function _write(line) {
  try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (_) {}
}
function log(level, msg, ...rest) {
  if ((LOG_LEVELS[level] ?? 1) > currentLevel) return;
  const extras = rest.map(a => {
    if (a instanceof Error) return a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
  const line = `[${ts()}] [${level}] ${msg}${extras ? ' ' + extras : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  _write(line);
}
const logger = {
  error: (m, ...a) => log('ERROR', m, ...a),
  warn : (m, ...a) => log('WARN',  m, ...a),
  info : (m, ...a) => log('INFO',  m, ...a),
  debug: (m, ...a) => log('DEBUG', m, ...a),
};

// ─────────────────────────────────────────────────────────────────────
// 4. TELEGRAM NOTIFIER
// ─────────────────────────────────────────────────────────────────────
class TelegramNotifier extends EventEmitter {
  constructor(cfg) {
    super();
    this.enabled  = cfg.enabled;
    this.botToken = cfg.botToken;
    this.chatId   = cfg.chatId;
    this.queue    = [];
    this.sending  = false;
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
          method  : 'POST',
          hostname: url.hostname,
          path    : url.pathname,
          headers : {
            'Content-Type'  : 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        }, res => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode === 200));
        });
        req.on('error', e => { logger.warn('telegram error:', e.message); resolve(false); });
        req.setTimeout(10000, () => { req.destroy(new Error('tg timeout')); });
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
        const m = this.queue.shift();
        await this._post(m);
        await new Promise(r => setTimeout(r, 1100));
      }
    } finally {
      this.sending = false;
    }
  }
  send(text) {
    if (!this.enabled) { logger.debug('tg(dry):', text.slice(0, 100)); return; }
    this.queue.push(text);
    this._drain();
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ─────────────────────────────────────────────────────────────────────
// 5a. DERIV REST CLIENT (PAT/OAuth OTP-based auth)
// ─────────────────────────────────────────────────────────────────────
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
  _request(method, reqPath, body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(reqPath, this.baseUrl); }
      catch (e) { return reject(new Error(`Invalid URL: ${reqPath}`)); }
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : require('http');
      const opts = {
        method,
        hostname: url.hostname,
        port    : url.port || (isHttps ? 443 : 80),
        path    : url.pathname + url.search,
        headers : {
          'Deriv-App-ID' : this.appId,
          'Authorization': 'Bearer ' + this.token,
          'Accept'       : 'application/json',
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
  async get(p)     { return this._request('GET',  p); }
  async post(p, b) { return this._request('POST', p, b); }
}

// ─────────────────────────────────────────────────────────────────────
// 5. DERIV WEBSOCKET CLIENT
// ─────────────────────────────────────────────────────────────────────
class DerivClient extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ws  = null;
    this.connected     = false;
    this.authorized    = false;
    this._stopped      = false;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._reqId    = 0;
    this._pending  = new Map();
    this._subs     = new Map();
    this.balance   = null;
    this.currency  = cfg.currency;
    this.accountInfo = null;
    this.symbols   = new Map();
    this._isPat    = RestClient.isPat(cfg.apiToken);
    this._rest     = this._isPat
      ? new RestClient('https://api.derivws.com', cfg.appId, cfg.apiToken)
      : null;
    this._otpUrl        = null;
    this._targetAccount = null;

    // Bot state
    this.market   = null;
    this.analyzer = null;
    this.exec     = null;
    this.stats    = null;
    this.lastTradeAt = 0;
    this.startBalance = null;
    this.lastBalance  = null;
    this.stopped      = false;
    this.overallProfit = 0;
    this._analysisT = null;
    this._hourlyT   = null;
    this._eodT      = null;
    this._hourlyBoot = null;
    this._eodBoot    = null;
    this._barrierT   = null;
    this.tradeWatchdogMs = cfg.tradeWatchdogMs;
    this.tradeStartTime  = null;
    this._tradeWatchdogTimer     = null;
    this._tradeWatchdogPollTimer = null;
    this.dailyHistory   = {};
    this._lastDayISODate = null;

    // ── Martingale state ──
    this.lossesStreak         = 0;
    this.martingaleMultiplier = 1.0;
    this.currentStake2        = cfg.stake;
    this._lastTradeWon        = true;

    // ── v3: Per-asset risk tracker ──
    this.assetTracker = new PerAssetTracker(cfg);
  }

  start() {
    logger.info('===== APEX Bot starting =====');
    logger.info(`assets: ${this.cfg.assets.join(', ')}`);
    logger.info(`telegram: ${this.cfg.telegram.enabled ? 'ENABLED ✔' : 'disabled'}`);
    this.market   = new MarketDataManager(this, this.cfg);
    this.analyzer = new ApexAnalyzer(this.cfg);
    this.exec     = new TradeExecutor(this, this.cfg);
    this.exec.bot = this;
    this.stats    = new StatisticsManager();

    this.on('authorized', info => this._onAuthorized(info));
    this.on('close', (c, r, was) => this._onDisconnected(c, r, was));
    this.on('open', () => logger.info('connection open'));
    this.on('error', e => logger.error('client error:', e.message));

    this.exec.on('open',         t => this._onTradeOpen(t));
    this.exec.on('update',       t => this._onTradeUpdate(t));
    this.exec.on('result',       t => this._onTradeResult(t));
    this.exec.on('driftWarning', t => this._onPulseDrift(t));

    process.on('SIGINT',  () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));

    this._loadState();
    this._scheduleSummaries();
    this.connect();
  }

  _onAuthorized(info) {
    this.startBalance = this.balance;
    this.lastBalance  = this.balance;
    logger.info(`start-of-day balance: ${this.startBalance} ${this.currencyStr()}`);

    const martingaleLine = (this.cfg.sizingModeV3 !== 'adaptive' && this.cfg.martingale && this.cfg.martingale > 0)
      ? `<b>Martingale:</b> ×${this.cfg.martingale} (after ${this.cfg.lossesBeforeMartingale} losses, +${this.cfg.martingaleStep}/loss, cap ×${this.cfg.maxMartingaleStep})\n`
      : '';

    telegram.send(
      `<b>APEX v3 Bot Online</b>\n\n` +
      `<b>Account:</b> ${info.loginid}\n` +
      `<b>Type:</b> ${info.isVirtual ? 'DEMO' : 'REAL'}\n` +
      `<b>Balance:</b> ${this.startBalance.toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Assets:</b> ${this.cfg.assets.length} ${this.cfg.autoDiscoverAssets ? '(auto-discover ON)' : ''}\n` +
      `<b>Stake:</b> ${this.cfg.stake}\n` +
      `<b>Growth rates:</b> ${this.cfg.pulseGrowthRates.map(g => (g*100).toFixed(0)+'%').join(', ')}\n` +
      `<b>Sizing:</b> ${this.cfg.sizingModeV3} ` +
        `(loss×${this.cfg.lossStakeReduction}, win×${this.cfg.winStakeRecovery})\n` +
      martingaleLine +
      `<b>Min EV:</b> ${(this.cfg.apexMinEV*100).toFixed(1)}%\n` +
      `<b>Min survival:</b> ${(this.cfg.apexMinSurvival*100).toFixed(1)}%\n` +
      `<b>Spread cost:</b> ${(this.cfg.pulseSpreadCost*100).toFixed(2)}%\n\n` +
      `<b>v3 Risk Gates</b>\n` +
      `• Max entries/window: ${this.cfg.maxEntriesPerSpikeWindow}\n` +
      `• Loss cooldown: ${this.cfg.assetLossCooldownMs/1000}s\n` +
      `• Pause after ${this.cfg.assetMaxConsecutiveLosses} losses: ${this.cfg.assetPauseDurationMs/1000}s\n` +
      `• Min win rate: ${(this.cfg.minWinRateToTrade*100).toFixed(0)}% (over ${this.cfg.rollingWindowSize} trades)\n` +
      `• Session max DD: ${this.cfg.sessionMaxDrawdown}\n` +
      `• Correlated filter: ${this.cfg.correlatedGroups.length} groups\n\n` +
      `<b>APEX engine active</b>\n` +
      `Post-spike (Boom/Crash) + vol-compression (Vol) · holds ≤${this.cfg.apexMaxHoldBoom} ticks\n\n` +
      `<b>Overall Profit:</b> ${money(this.stats.overallProfit, this.currencyStr())}\n` +
      `Loss streak: current ${this.stats.currentLossStreak}, x2=${this.stats.lossStreakEvents.x2}, x3=${this.stats.lossStreakEvents.x3}, x4=${this.stats.lossStreakEvents.x4}`,
    );

    Promise.all([
      this.market.loadSymbols(),
      this.market.bootstrap(this.cfg.assets),
      this._refreshBarriers(),
    ]).then(async () => {
      // v3: Dynamic asset discovery (if enabled)
      if (this.cfg.autoDiscoverAssets) {
        try {
          const discovered = await this.market.discoverAccuAssets();
          if (discovered.length > this.cfg.assets.length) {
            const newAssets = discovered.filter(a => !this.cfg.assets.includes(a));
            if (newAssets.length) {
              logger.info(`v3: discovered ${newAssets.length} new assets: ${newAssets.join(', ')}`);
              // Add to runtime asset list (mutate cfg.assets array)
              for (const a of newAssets) {
                if (!this.cfg.assets.includes(a)) this.cfg.assets.push(a);
              }
              // Bootstrap newly discovered assets (subscribe + backfill)
              await this.market.bootstrap(newAssets);
              // Refresh barriers for new assets too
              await this._refreshBarriers();
              telegram.send(
                `<b>v3: New Assets Discovered</b>\n` +
                `Added: ${newAssets.join(', ')}\n` +
                `Total: ${this.cfg.assets.length} assets`,
              );
            }
          }
        } catch (e) {
          logger.warn(`v3: asset discovery error: ${e.message}`);
        }
        // Schedule periodic re-discovery
        if (this._discoveryT) clearInterval(this._discoveryT);
        this._discoveryT = setInterval(async () => {
          try {
            const discovered = await this.market.discoverAccuAssets();
            const newAssets = discovered.filter(a => !this.cfg.assets.includes(a));
            if (newAssets.length) {
              for (const a of newAssets) this.cfg.assets.push(a);
              await this.market.bootstrap(newAssets);
              await this._refreshBarriers();
              logger.info(`v3: periodic discovery found ${newAssets.length} new assets: ${newAssets.join(', ')}`);
            }
          } catch (e) {
            logger.debug(`v3: periodic discovery error: ${e.message}`);
          }
        }, this.cfg.discoveryIntervalMs);
      }

      if (this._analysisT) clearInterval(this._analysisT);
      this._analyzeAndTrade();
      this._analysisT = setInterval(() => this._analyzeAndTrade(), this.cfg.analysisIntervalMs);
      if (this._barrierT) clearInterval(this._barrierT);
      this._barrierT = setInterval(() => this._refreshBarriers(), this.cfg.barrierRefreshMs);
    });
  }

  _onDisconnected(code, reason, wasAuthorized) {
    this._clearWatchdogTimers();
    telegram.send(
      `<b>Connection3 lost</b>\n` +
      `code: <code>${code}</code>\n` +
      `was authorised: ${wasAuthorized ? 'yes' : 'no'}\n` +
      `reconnecting…`,
    );
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    if (this.exec) this.exec.open.clear();
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

  _nextReqId() { return ++this._reqId; }

  _url() {
    const sep = this.cfg.wsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.wsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }
  _redact(url) {
    return url.replace(/([?&])(otp|app_id|token)=[^&]+/g, '$1$2=***');
  }
  _openWs(url) {
    try {
      this.ws = new WebSocket(url, {
        headers: { 'User-Agent': 'DerivAccumulatorBot/2.0 (+Node.js)' },
        handshakeTimeout: 15000,
      });
    } catch (e) {
      logger.error('ws construct failed:', e.message);
      this._scheduleReconnect();
      return false;
    }
    this.ws.on('open',    () => this._onOpen());
    this.ws.on('message', d  => this._onMessage(d));
    this.ws.on('error',   e  => this._onError(e));
    this.ws.on('close',   (c, r) => this._onClose(c, r));
    this.ws.on('unexpected-response', (_, res) => {
      logger.error('ws handshake failed:', res.statusCode, res.statusMessage);
      try { res.destroy(); } catch (_) {}
      this._scheduleReconnect();
    });
    return true;
  }
  connect() {
    if (this.ws &&
       (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)) return;
    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN is empty — aborting');
      this._stopped = true;
      return;
    }
    if (this._isPat) {
      logger.info('detected PAT token → using NEW Deriv API (OTP flow)');
      this._newApiConnect().catch(e => {
        logger.error('new API connect failed:', e.message);
        this._scheduleReconnect();
      });
    } else {
      logger.info('using legacy Deriv API (token authorize flow)');
      const url = this._url();
      logger.info(`connecting → ${this._redact(url)}`);
      this._openWs(url);
    }
  }
  async _newApiConnect() {
    const desiredType = (this.cfg.accountType || 'demo').toLowerCase();
    logger.info('REST: GET /trading/v1/options/accounts');
    const accRes = await this._rest.get('/trading/v1/options/accounts');
    if (accRes.status !== 200) {
      const msg = accRes.body?.errors?.[0]?.message
        || accRes.body?.message
        || JSON.stringify(accRes.body);
      let hint = '';
      if (accRes.status === 401) hint = ' — check PAT + DERIV_APP_ID';
      else if (accRes.status === 403) hint = ' — PAT lacks "trade" scope';
      else if (accRes.status === 404) hint = ' — legacy token with new API?';
      throw new Error(`account list failed (${accRes.status}): ${msg}${hint}`);
    }
    const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
    if (!accounts.length) throw new Error('no Options accounts found for this token');
    const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desiredType)
              || accounts[0];
    this._targetAccount = acct;
    this.accountInfo = {
      loginid    : acct.account_id,
      email      : acct.email,
      isVirtual  : (acct.account_type || '').toLowerCase() === 'demo',
      accountType: acct.account_type,
      currency   : acct.currency,
      balance    : parseFloat(acct.balance),
      group      : acct.group,
    };
    logger.info(`selected account ${acct.account_id} (${acct.account_type}, ${acct.currency}, balance=${acct.balance})`);

    const otpPath = `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`;
    logger.info(`REST: POST ${otpPath}`);
    const otpRes = await this._rest.post(otpPath);
    if (otpRes.status !== 200) {
      throw new Error(`OTP request failed (${otpRes.status}): ${JSON.stringify(otpRes.body)}`);
    }
    const wsUrl = otpRes.body?.data?.url;
    if (!wsUrl || !/^wss?:/i.test(wsUrl)) {
      throw new Error(`OTP response missing .data.url: ${JSON.stringify(otpRes.body)}`);
    }
    this._otpUrl = wsUrl;
    logger.info(`connecting → ${this._redact(wsUrl)}`);
    this._openWs(wsUrl);
  }

  _onOpen() {
    logger.info('ws connected ✔');
    this.connected = true;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this.emit('open');
    if (this._isPat) this._newApiMarkAuthorized();
    else             this._authorize();
  }
  _newApiMarkAuthorized() {
    if (!this.accountInfo) return;
    this.authorized = true;
    this.balance    = this.accountInfo.balance ?? null;
    this.currency   = this.accountInfo.currency || this.cfg.currency;
    logger.info(
      `authorized ${this.accountInfo.loginid} ` +
      `(${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) ` +
      `balance=${this.balance} ${this.currency} via PAT/new-API`,
    );
    this.emit('authorized', this.accountInfo);
  }
  async _authorize() {
    try {
      const res = await this._send({ authorize: this.cfg.apiToken }, 20000);
      this.authorized = true;
      this.balance    = parseFloat(res.authorize.balance);
      this.currency   = res.authorize.currency || this.cfg.currency;
      this.accountInfo = {
        loginid    : res.authorize.loginid,
        email      : res.authorize.email,
        isVirtual  : !!res.authorize.is_virtual,
        accountType: res.authorize.account_type,
        country    : res.authorize.country,
      };
      logger.info(`authorized ${res.authorize.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) balance=${this.balance} ${this.currency}`);
      this.emit('authorized', this.accountInfo);
    } catch (e) {
      logger.error('authorize failed:', e.message);
      this.authorized = false;
      this._scheduleReconnect();
    }
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.error) {
      const code = msg.error.code;
      const RACE = new Set(['BetExpired','TradingDurationNotAllowed','ContractNotFound','InvalidContract']);
      if (RACE.has(code)) {
        logger.debug(`(race) api error: ${code} – ${msg.error.message} req=${msg.req_id || '?'}`);
      } else {
        logger.error(`api error: ${code} – ${msg.error.message} (req=${msg.req_id || '?'})`);
      }
      if (msg.req_id && this._pending.has(msg.req_id)) {
        const p = this._pending.get(msg.req_id);
        clearTimeout(p.timer);
        this._pending.delete(msg.req_id);
        p.reject(new Error(msg.error.message || code));
      }
      if (['AuthorizationRequired','InvalidToken','InvalidAppID'].includes(code)) this._closeAndReconnect();
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
      try { cb(msg); } catch (e) { logger.error('sub handler error:', e.message); }
    }
  }
  _onError(err) {
    logger.error('ws error:', err.message, err.code || '');
    this.emit('error', err);
  }
  _onClose(code, reason) {
    const reasonStr = (() => { try { return reason?.toString(); } catch { return ''; } })();
    logger.warn(`ws closed code=${code} reason=${reasonStr || '(none)'}`);
    const wasAuthorized = this.authorized;
    this.connected  = false;
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
    this._reconnectAttempt++;
    const base = Math.min(
      this.cfg.reconnect.initialDelayMs * Math.pow(this.cfg.reconnect.backoffFactor, this._reconnectAttempt - 1),
      this.cfg.reconnect.maxDelayMs,
    );
    const jitter = Math.random() * this.cfg.reconnect.jitterMs;
    const delay  = base + jitter;
    logger.info(`reconnect #${this._reconnectAttempt} in ${(delay/1000).toFixed(1)}s`);
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
      const text  = JSON.stringify({ ...payload, req_id: reqId });
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error(`Request timeout (${payload.proposal ?? payload.buy ?? payload.ticks ?? 'req'})`));
        }
      }, timeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });
      try { this.ws.send(text); }
      catch (e) { clearTimeout(timer); this._pending.delete(reqId); reject(e); }
    });
  }
  subscribe(payload, callback, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = this._nextReqId();
      const text  = JSON.stringify({ ...payload, req_id: reqId, subscribe: 1 });
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error('Subscribe timeout'));
        }
      }, timeoutMs);
      this._pending.set(reqId, {
        resolve: msg => {
          const subId = msg.subscription?.id;
          if (subId) { this._subs.set(subId, callback); resolve(subId); }
          else       { reject(new Error('No subscription id in response')); }
        },
        reject, timer,
      });
      try { this.ws.send(text); }
      catch (e) { clearTimeout(timer); this._pending.delete(reqId); reject(e); }
    });
  }
  forget(subId) {
    if (!subId) return Promise.resolve();
    this._subs.delete(subId);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    return this._send({ forget: subId }, 8000).catch(e => logger.debug('forget:', e.message));
  }

  // ── Trade lifecycle hooks ────────────────────────────────────
  _onTradeResult(t) {
    this._clearWatchdogTimers();
    this.tradeStartTime = null;
    const rec  = this.stats.record(t);
    const emoji = t.status === 'won' ? '✅' : '❌';
    const label = t.status === 'won' ? 'WIN' : 'LOSS';
    const dur   = Math.max(0, (t.sellTime || Date.now()/1000) - (t.buyTime || 0));
    this.lastBalance   = (this.lastBalance ?? this.balance ?? 0) + t.profit;
    this.overallProfit += t.profit;
    this._updateMartingale(t.status);

    // v3: Update per-asset tracker
    const won = t.status === 'won';
    this.assetTracker.onTradeResult(t.symbol, won, t.profit);

    // v3: Update adaptive stake for this asset
    if (this.cfg.sizingModeV3 === 'adaptive') {
      const currentStake = this.assetTracker.getAdaptiveStake(t.symbol, this.cfg.stake);
      this.assetTracker.updateStakeAfterResult(t.symbol, won, currentStake, this.cfg.stake);
    }

    // Bug 7 fix — Deriv returns lowercase 'won'/'lost' (not 'Won').
    // On a win: reset the persisted stake baseline; on a loss: remember
    // the losing stake as a string with 2-decimal precision.
    if (won) {
      this.currentStake2 = this.cfg.stake;
    } else {
      this.currentStake2 = Number(t.stake).toFixed(2);
    }

    const martingaleLine = this.martingaleMultiplier > 1
      ? `<b>Martingale:</b> ×${this.martingaleMultiplier.toFixed(2)} (${this.lossesStreak} consecutive losses)\n`
      : '';
    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));

    // v3: Per-asset stats
    const assetState = this.assetTracker._getAsset(t.symbol);
    const v3AssetLine =
      `<b>Asset (${t.symbol}):</b> WR=${(assetState.rollingWinRate*100).toFixed(0)}% ` +
      `(last ${assetState.recentResults.length}) | ` +
      `Losses: ${assetState.consecutiveLosses} | P/L: ${assetState.totalPnl >= 0 ? '+' : ''}${assetState.totalPnl.toFixed(2)}\n`;
    const v3SessionLine =
      `<b>Session P/L:</b> ${this.assetTracker.sessionPnl >= 0 ? '+' : ''}${this.assetTracker.sessionPnl.toFixed(2)} ${this.currencyStr()}\n`;

    let msg =
      `${emoji} <b>APEX TRADE ${label}</b>\n\n` +
      `<b>Contract:</b> #${t.contractId}\n` +
      `<b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth:</b> ${(t.growthRate*100).toFixed(0)}%\n` +
      `<b>Stake:</b> ${Number(t.stake).toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Sell:</b> ${Number(t.sellPrice).toFixed(2)}\n` +
      `${t.profit >= 0 ? '💚' : '💔'} <b>Profit:</b> ${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Duration:</b> ${dur.toFixed(1)}s\n` +
      `<b>Balance:</b> ${this.lastBalance.toFixed(2)} ${this.currencyStr()}\n\n` +
      v3AssetLine +
      v3SessionLine +
      `<b>GMT Day Stats (${rec.date})</b>\n` +
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses})\n` +
      `• Win rate: ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net P/L: ${todayStats.totalProfit >= 0 ? '+' : ''}${todayStats.totalProfit.toFixed(2)} ${this.currencyStr()}\n` +
      `• Profit factor: ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n` +
      `<b>Overall:</b> ${this.overallProfit >= 0 ? '+' : ''}${this.overallProfit.toFixed(2)} ${this.currencyStr()}\n` +
      martingaleLine +
      `<b>Consecutive Losses:</b> current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
      ` x2=${this.stats.lossStreakEvents.x2} x3=${this.stats.lossStreakEvents.x3} x4=${this.stats.lossStreakEvents.x4}`;
    telegram.send(msg);

    this.lastTradeAt = Date.now();
    this._saveState('after-trade');
  }

  _onTradeOpen(t) {
    this.tradeStartTime = Date.now();
    this._startTradeWatchdog(t.contractId);

    // v3: Build sizing line
    const a = t._analysis || {};
    const sizingMode = a.sizingMode || 'legacy';
    let sizingLine;
    if (sizingMode === 'adaptive') {
      const assetState = this.assetTracker._getAsset(t.symbol);
      sizingLine = `<b>Sizing:</b> Adaptive (${t.stake.toFixed(2)} ${this.currencyStr()})\n` +
        `• Base: ${(a.baseStake ?? this.cfg.stake).toFixed(2)} | WR: ${(assetState.rollingWinRate*100).toFixed(0)}% | Asset losses: ${assetState.consecutiveLosses}\n`;
    } else {
      sizingLine = this.martingaleMultiplier > 1
        ? `<b>Martingale:</b> ×${this.martingaleMultiplier.toFixed(2)} (${this.lossesStreak} losses)\n`
        : '';
    }

    const msg =
      `<b>APEX v3 TRADE OPENED</b>\n\n` +
      `<b>Contract:</b> #${t.contractId}\n` +
      `<b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth Rate:</b> ${(t.growthRate*100).toFixed(2)}%\n` +
      `<b>Stake:</b> ${t.stake.toFixed(2)} ${this.currencyStr()}\n` +
      sizingLine +
      `<b>Take Profit:</b> ${t.limit?.take_profit ?? '–'}\n` +
      `<b>Overall Profit:</b> ${this.overallProfit >= 0 ? '+' : ''}${this.overallProfit.toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Session P/L:</b> ${this.assetTracker.sessionPnl >= 0 ? '+' : ''}${this.assetTracker.sessionPnl.toFixed(2)}\n` +
      `\n` +
      `<b>APEX Analysis</b>\n` +
      `• Regime: ${a.regimeClass ?? '?'} (${a.entryReason ?? '?'})\n` +
      `• Edge (net spread): ${((a.edge ?? 0)*100).toFixed(2)}%\n` +
      `• EV: ${((a.ev ?? 0)*100).toFixed(2)}%\n` +
      `• Survival pN: ${((a.pN ?? 0)*100).toFixed(2)}%  (per-tick ${((a.perTickSurv ?? 0)*100).toFixed(2)}%)\n` +
      `• N*: ${a.bestN ?? '?'} ticks\n` +
      `• Spike hazard: ${((a.hazard ?? 0)*100).toFixed(2)}%  cadence≈${a.spikeCadence ?? '?'}  since=${a.ticksSinceSpike ?? '?'}\n` +
      `• σfast/σslow: ${(a.volRatio ?? 0).toFixed(2)}  barrier=±${((a.barrierFrac ?? 0)*100).toFixed(4)}%`;
    telegram.send(msg);
  }
  _onTradeUpdate(t) {
    logger.debug(`update #${t.contractId}: profit=${t.profit.toFixed(3)} spot=${t.currentSpot}`);
  }
  _onPulseDrift(t) {
    logger.debug(`apex-exit #${t.contractId} urg=${t.dec.urgency.toFixed(2)} ${t.dec.reason}`);
  }

  // ── PULSE sizing ────────────────────────────────────────────
  currentStake(edge) {
    const base = this.stats.currentLossStreak > 0 ? Number(this.currentStake2) : this.cfg.stake;
    let mult = 1.0;
    if (this.cfg.sizingMode === 'edge' && edge && edge > 1) {
      const evFrac = Math.max(0, edge - 1);
      const scaled = 1 + (evFrac / this.cfg.edgeScaleEdgeRef) * (this.cfg.edgeScaleMax - 1);
      mult = Math.max(1, Math.min(this.cfg.edgeScaleMax, scaled));
    }
    if (this.cfg.downscaleAfterLoss && this.stats.currentLossStreak > 0) {
      mult *= Math.max(0.5, Math.pow(0.85, this.stats.currentLossStreak));
    }
    const m = this.cfg.martingale || 0;
    if (m > 0 && this.lossesStreak > (this.cfg.lossesBeforeMartingale || 0)) {
      mult *= this.martingaleMultiplier;
    }
    return +(base * mult).toFixed(2);
  }

  _updateMartingale(tradeResult) {
    if (!this.cfg.martingale || this.cfg.martingale <= 0) {
      this.lossesStreak         = 0;
      this.martingaleMultiplier = 1.0;
      this._lastTradeWon        = tradeResult === 'won';
      return;
    }
    const threshold = this.cfg.lossesBeforeMartingale || 0;
    const cap       = this.cfg.maxMartingaleStep || Infinity;
    if (tradeResult === 'won') {
      this.lossesStreak         = 0;
      this.martingaleMultiplier = 1.0;
      this.currentStake2        = this.cfg.stake;
    } else {
      this.lossesStreak++;
      if (this.lossesStreak > threshold) {
        const stepNum = this.lossesStreak - threshold - 1;
        const raw     = this.cfg.martingale + this.cfg.martingaleStep * stepNum;
        const capped  = Math.min(raw, cap);
        if (capped !== this.martingaleMultiplier) {
          this.martingaleMultiplier = capped;
          const note = raw > cap ? ` (raw ×${raw.toFixed(2)} capped at ×${cap})` : '';
          logger.info(`martingale: ${this.lossesStreak} losses streak → stake × ${this.martingaleMultiplier.toFixed(2)}${note}`);
        }
      }
    }
    this._lastTradeWon = tradeResult === 'won';
  }

  // ── Trade Watchdog ─────────────────────────────────────────
  _startTradeWatchdog(contractId) {
    this._clearWatchdogTimers();
    const timeoutMs = this.tradeWatchdogMs;
    this._tradeWatchdogTimer = setTimeout(() => {
      const hasActiveTrade = this.exec.openTrades().some(t => t.contractId);
      if (!hasActiveTrade) { this._clearWatchdogTimers(); return; }
      logger.warn(`WATCHDOG FIRED — Contract ${contractId || 'unknown'} open for ${(timeoutMs/1000).toFixed(0)}s with no settlement`);
      if (contractId && this.authorized && this.connected) {
        logger.info(`Polling contract ${contractId} for current status…`);
        this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 })
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

    if (contractId !== 'unknown' && this.authorized && this.connected) {
      try { await this.exec.sell(contractId, 0); }
      catch (e) { logger.warn(`emergency sell failed: ${e.message}`); }
    }
    this.exec.open.delete(contractId);

    const finishedTrade = {
      contractId, symbol, stake, profit: -stake, status: 'lost',
      sellPrice: 0, sellTime: Date.now()/1000, buyTime: entryTime/1000,
      growthRate: stuck.growthRate || this.cfg.multiplier,
    };
    this.stats.record(finishedTrade);
    // Bug 8 fix — increment martingale/loss-streak state on stuck loss.
    this._updateMartingale('lost');
    // v3: update per-asset tracker on stuck trade recovery
    this.assetTracker.onTradeResult(symbol, false, -stake);
    this.lastBalance   = (this.lastBalance ?? this.balance ?? 0) + finishedTrade.profit;
    this.overallProfit += finishedTrade.profit;

    this.lastTradeAt    = Date.now();
    this.tradeStartTime = null;

    telegram.send(
      `<b>STUCK3 TRADE RECOVERED [${reason}]</b>\nContract: ${contractId}\n` +
      `Asset: ${symbol}\nStake: $${stake.toFixed(2)}\nOpen: ${openSeconds}s\n` +
      `Loss streak now: ${this.stats.currentLossStreak}`,
    );
    this._saveState('stuck-trade-recovery');
  }

  // ── PULSE decision loop ────────────────────────────────────
  async _analyzeAndTrade() {
    try {
      if (this.stopped)   return;
      if (!this.authorized) return;

      // Daily limits
      const today = this.stats.todayTrades();
      if (today.length >= this.cfg.dailyMaxTrades) {
        logger.warn(`dailyMaxTrades reached — pausing`); return;
      }
      const pl = today.reduce((s, t) => s + (t.profit || 0), 0);
      if (pl <= -this.cfg.dailyMaxLoss) {
        logger.warn(`dailyMaxLoss reached — pausing`);
        telegram.send(`<b>Daily3 loss limit</b>\nNet P/L: ${pl.toFixed(2)} ${this.currencyStr()}`);
        return;
      }
      if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
      if (this.exec.count() >= this.cfg.maxOpenTrades)              return;

      // v3: Session drawdown circuit breaker
      if (this.assetTracker.sessionHalted) {
        logger.warn(`session halted: ${this.assetTracker.sessionHaltReason}`);
        return;
      }

      // v3: Don't exceed max simultaneously active assets
      if (this.assetTracker.activeCount() >= this.cfg.maxAssetsTrading) {
        logger.debug(`max assets trading reached (${this.assetTracker.activeCount()}/${this.cfg.maxAssetsTrading})`);
        return;
      }

      // Analyse every asset with APEX
      const analyses   = this.cfg.assets.map(s =>
        this.analyzer.analyze(s, this.market.historyFor(s), this.market));
      const ranked     = this.analyzer.rank(analyses);
      const candidates = ranked.filter(a => a.recommend);

      if (!candidates.length) {
        if (ranked.length) {
          const b = ranked[0];
          logger.info(
            `scan: best=${b.symbol} [${b.regimeClass}] g=${(b.growthRate*100).toFixed(0)}% edge=${b.edge.toFixed(4)} ` +
            `ev=${(b.ev*100).toFixed(2)}% N*=${b.bestN} pN=${(b.pN*100).toFixed(1)}% hazard=${(b.hazard*100).toFixed(2)}% — ` +
            `[${[
              b.edgeOK ? '' : `edge<${this.cfg.pulseEdgeThreshold}`,
              b.evOK   ? '' : `ev<${this.cfg.apexMinEV}`,
              b.survOK ? '' : `surv<${this.cfg.apexMinSurvival}`,
              b.calmOK ? '' : `window:${b.entryReason}`,
            ].filter(Boolean).join(',')}] no trade`,
          );
        }
        return;
      }

      // v3: Filter candidates through per-asset risk checks
      //     Try each candidate in ranked order; the first one that passes
      //     all risk gates is the one we trade.
      let chosen = null;
      let chosenCheck = null;
      for (const cand of candidates) {
        // v3: Check correlated assets — don't double up on same regime
        if (this.assetTracker.isCorrelated(cand.symbol)) {
          logger.debug(`v3: skipping ${cand.symbol} — correlated with active asset`);
          continue;
        }

        // v3: Per-asset risk check (cooldown, window limit, win rate, edge penalty)
        const check = this.assetTracker.checkEntry(cand.symbol, cand.edge, cand.ticksSinceSpike);
        if (!check.allowed) {
          logger.info(
            `v3: ${cand.symbol} BLOCKED — ${check.reason}`,
          );
          continue;
        }

        chosen = cand;
        chosenCheck = check;
        break;
      }

      if (!chosen) {
        logger.debug('v3: no candidate passed per-asset risk gates');
        return;
      }

      const best = chosen;

      logger.info(
        `APEX ENTER ${best.symbol} [${best.regimeClass}:${best.entryReason}] g=${(best.growthRate*100).toFixed(0)}% ` +
        `edge=${best.edge.toFixed(4)} ev=${(best.ev*100).toFixed(2)}% ` +
        `N*=${best.bestN} pN=${(best.pN*100).toFixed(1)}% hazard=${(best.hazard*100).toFixed(2)}% ` +
        `sinceSpike=${best.ticksSinceSpike} cadence=${best.spikeCadence} ` +
        `hold=${best.adaptiveMaxHold} winFrac=${best.adaptiveWindowFrac} ` +
        `spikeSurv=${(best.spikeSurvivalHold*100).toFixed(1)}%`,
      );

      // v3: Use adaptive stake sizing instead of raw martingale
      const baseStake = this.cfg.stake;
      const stake = (this.cfg.sizingModeV3 === 'adaptive')
        ? this.assetTracker.getAdaptiveStake(best.symbol, baseStake)
        : this.currentStake(best.edge);

      const tpFraction  = best.suggestedTakeProfit;
      const takeProfit  = +(stake * tpFraction).toFixed(2);
      const stopLoss    = this.cfg.stopLoss;

      const analysis = {
        edge: best.edge, ev: best.ev, bestN: best.bestN,
        pN: best.pN, p1: best.p1, regime: best.regime,
        regimeClass: best.regimeClass, entryReason: best.entryReason,
        perTickSurv: best.perTickSurv, hazard: best.hazard,
        ticksSinceSpike: best.ticksSinceSpike, spikeCadence: best.spikeCadence,
        volRatio: best.volRatio, barrierFrac: best.barrierFrac,
        vrRatio: best.vrRatio, sigma: best.sigma,
        growthRate: best.growthRate, halfBarrierFrac: best.halfBarrierFrac,
        logBarrierHalf: best.logBarrierHalf,
        // v3: Use adaptive sizing info instead of martingale
        sizingMode: this.cfg.sizingModeV3,
        adaptiveStake: stake,
        baseStake: baseStake,
        rollingWinRate: this.assetTracker._getAsset(best.symbol).rollingWinRate,
        assetLosses: this.assetTracker._getAsset(best.symbol).consecutiveLosses,
        sessionPnl: this.assetTracker.sessionPnl,
      };

      // v3: Notify tracker of trade open
      this.assetTracker.onTradeOpen(best.symbol);

      const trade = await this.exec.buy(
        best.symbol, best.growthRate, stake,
        { stop_loss: stopLoss, take_profit: takeProfit },
        analysis,
      );

      const v3Note = this.cfg.sizingModeV3 === 'adaptive'
        ? ` adaptive-stake=${stake} (WR=${(analysis.rollingWinRate*100).toFixed(0)}%)`
        : ` martingale × ${this.martingaleMultiplier.toFixed(2)} (${this.lossesStreak} losses)`;
      logger.info(
        `trade placed #${trade.contractId} ${best.symbol} g=${best.growthRate} ` +
        `stake=${stake}${v3Note} tp=${takeProfit} ` +
        `barrier=±${trade.halfBarrierPct.toFixed(4)}%`,
      );
    } catch (e) {
      logger.error('APEX analyse/trade error:', e.message);
    }
  }

  async _refreshBarriers() {
    try {
      if (!this.authorized) return;
      await this.market.refreshBarriers(this.cfg.assets, this.cfg.pulseGrowthRates);
      logger.debug('barrier cache refreshed');
    } catch (e) {
      logger.debug('barrier refresh error:', e.message);
    }
  }

  // ── State persistence ─────────────────────────────────────
  _statePayload(reason) {
    return {
      version: 4,
      engine : 'APEX v3',
      savedAt: new Date().toISOString(),
      savedReason: reason,
      startBalance: this.startBalance,
      lastBalance : this.lastBalance,
      lastDayISODate: this._lastDayISODate || this._todayISO(),
      dailyHistory  : this.dailyHistory || {},
      stats         : this.stats.serialize(),
      lossesStreak  : this.lossesStreak ?? 0,
      martingaleMultiplier: this.martingaleMultiplier ?? 1.0,
      // v3: per-asset tracker state
      assetTracker  : this.assetTracker.serialize(),
    };
  }
  _saveState(reason = 'checkpoint') {
    if (!this.cfg.stateSaveOnTrade    && reason === 'after-trade') return;
    if (!this.cfg.stateSaveOnShutdown && reason === 'shutdown')    return;
    try {
      const file = this.cfg.stateFile;
      const tmp  = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._statePayload(reason), null, 2));
      fs.renameSync(tmp, file);
      logger.debug(`state saved (${reason}) → ${file}`);
    } catch (e) {
      logger.warn('state save failed:', e.message);
    }
  }
  _loadState() {
    const file = this.cfg.stateFile;
    if (!fs.existsSync(file)) { logger.debug(`no state file (fresh start)`); return; }
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.startBalance != null) this.startBalance = data.startBalance;
      if (data.lastBalance  != null) this.lastBalance  = data.lastBalance;
      if (data.lastDayISODate)       this._lastDayISODate = data.lastDayISODate;
      if (data.dailyHistory)         this.dailyHistory    = data.dailyHistory;
      if (data.lossesStreak != null) this.lossesStreak    = data.lossesStreak;
      if (data.martingaleMultiplier != null) this.martingaleMultiplier = data.martingaleMultiplier;
      this.stats = new StatisticsManager(data.stats || data);
      // v3: restore per-asset tracker state
      if (data.assetTracker) this.assetTracker.loadSaved(data.assetTracker);
      logger.info(
        `state restored (APEX v3): overallProfit=${this.stats.overallProfit.toFixed(2)} ` +
        `lossStreak=${this.stats.currentLossStreak} ` +
        `sessionPnl=${this.assetTracker.sessionPnl.toFixed(2)} ` +
        `trackedAssets=${this.assetTracker.assets.size}`,
      );
    } catch (e) {
      logger.warn(`state load failed:`, e.message);
    }
  }
  _todayISO() { return utcDateStr(); }
  _gmtNowStr() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

  // ── Summaries ─────────────────────────────────────────────
  _sendHourly() {
    const now  = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const date = utcDateStr(prev);
    const hour = utcHour(prev);
    const list = this.stats.tradesForHour(date, hour);
    const s    = this.stats.stats(list);
    if (!list.length) {
      telegram.send(`<b>Hourly3 Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\nNo trades this hour.\n\nOverall Profit: ${money(this.stats.overallProfit, this.currencyStr())}`);
      return;
    }
    let msg =
      `<b>Hourly3 Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\n` +
      `Trades: ${s.count} (✅${s.wins} ❌${s.losses})\n` +
      `Win rate: ${s.winRate.toFixed(1)}%\n` +
      `P/L: <b>${money(s.totalProfit, this.currencyStr())}</b>\n` +
      `Overall Profit: <b>${money(this.stats.overallProfit, this.currencyStr())}</b>\n` +
      `Loss streak current ${this.stats.currentLossStreak} | x2=${this.stats.lossStreakEvents.x2} x3=${this.stats.lossStreakEvents.x3} x4=${this.stats.lossStreakEvents.x4}\n\n` +
      `Detail:\n`;
    list.slice(-20).forEach((t, i) => {
      msg += `${i + 1}. ${t.status === 'won' ? '✅' : '❌'} #${t.contractId} ${t.symbol} ${money(t.profit, this.currencyStr())}\n`;
    });
    telegram.send(msg);
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
  _sendEod(reason = 'manual') {
    const date = this._eodReportDate(new Date());
    if (this.stats.isEodSent(date) && reason === 'scheduled') {
      logger.info(`EOD ${date} already sent; skipping duplicate`); return;
    }
    const summary  = this.stats.archiveDate(date);
    const ds       = summary.stats;
    const balStart = this.startBalance ?? 0;
    const balNow   = this.lastBalance  ?? balStart;
    const balDelta = balNow - balStart;
    const balPct   = balStart ? (balDelta / balStart) * 100 : 0;

    let msg = `<b>APEX END OF TRADE DAY — GMT</b>\n` +
      `Trade day ended: <b>${date}</b>\n\n` +
      `<b>── Current Day Stats ──</b>\n`;
    if (ds.count) {
      msg += `Trades: ${ds.count} (✅${ds.wins} ❌${ds.losses})\n` +
        `Win rate: ${ds.winRate.toFixed(1)}%\n` +
        `Total stake: ${ds.stake.toFixed(2)} ${this.currencyStr()}\n` +
        `Gross win: +${ds.grossWin.toFixed(2)}\n` +
        `Gross loss: -${ds.grossLoss.toFixed(2)}\n` +
        `<b>Net P/L: ${money(ds.totalProfit, this.currencyStr())}</b>\n` +
        `Profit factor: ${ds.profitFactor === Infinity ? '∞' : ds.profitFactor.toFixed(2)}\n` +
        `Max loss streak today: ${ds.maxLossStreak}\n\n`;
    } else {
      msg += `No trades recorded for this GMT trade day.\n\n`;
    }
    msg += `<b>── Balance ──</b>\n${balStart.toFixed(2)} → ${balNow.toFixed(2)} ` +
      `(${balDelta >= 0 ? '+' : ''}${balDelta.toFixed(2)} / ${balPct >= 0 ? '+' : ''}${balPct.toFixed(2)}%)\n\n`;
    msg += `<b>── Overall / Stored Stats ──</b>\n` +
      `Overall Profit: <b>${money(this.stats.overallProfit, this.currencyStr())}</b>\n` +
      `Consecutive losses: current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
      ` x2=${this.stats.lossStreakEvents.x2} x3=${this.stats.lossStreakEvents.x3} x4=${this.stats.lossStreakEvents.x4}\n\n`;

    // v3: Per-asset breakdown
    const assetSummary = this.assetTracker.summary();
    if (assetSummary) {
      msg += `<b>── v3: Per-Asset Performance ──</b>\n${assetSummary}\n\n`;
    }

    const rows = this.stats.allDailyRows(date);
    if (rows.length) {
      msg += `<b>── All Trade Days By Date ──</b>\n`;
      for (const row of rows.slice(-60)) {
        const s = row.stats;
        msg += `${row.date}: ${s.count} trades (✅${s.wins}/❌${s.losses}) | WR ${s.winRate.toFixed(1)}% | P/L ${money(s.totalProfit, this.currencyStr())}\n`;
      }
      if (rows.length > 60) msg += `…showing last 60 of ${rows.length} stored trade days.\n`;
    }

    telegram.send(msg);
    this.stats.markEodSent(date);
    this._saveState(`eod-${reason}`);
    this.startBalance = this.balance ?? this.lastBalance ?? this.startBalance;
  }

  currencyStr() { return this.currency || this.cfg.currency; }

  stop(signal) {
    if (this.stopped) return;
    this.stopped = true;
    this._clearWatchdogTimers();
    logger.info(`stopping (signal: ${signal})`);
    telegram.send(`<b>APEX Bot stopped</b>\nSignal: ${signal}`);
    if (this._analysisT)  clearInterval(this._analysisT);
    if (this._hourlyT)    clearInterval(this._hourlyT);
    if (this._eodT)       clearInterval(this._eodT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._eodBoot)    clearTimeout(this._eodBoot);
    if (this._barrierT)   clearInterval(this._barrierT);
    if (this._discoveryT) clearInterval(this._discoveryT);  // v3: cleanup discovery timer
    this._saveState('shutdown');
    try { this.ws?.close(); } catch (_) {}
    setTimeout(() => process.exit(0), 2500);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 6. MARKET DATA MANAGER
// ─────────────────────────────────────────────────────────────────────
class MarketDataManager {
  constructor(client, cfg) {
    this.client = client;
    this.cfg    = cfg;
    this.history      = new Map();
    this.subs         = new Map();
    this.lastQuote    = new Map();
    this._bootstrapping = false;
    this.stayCache     = new Map();
    this._refreshInFlight = false;
    this._barrierCache = new Map();
    client.on('close', () => { this.subs.clear(); });
  }
  cacheStays(symbol, growthRate, contractDetails) {
    if (!contractDetails) return;
    const arr = contractDetails.ticks_stayed_in;
    if (!Array.isArray(arr) || !arr.length) return;
    const key = +(+growthRate).toFixed(4);
    if (!this.stayCache.has(symbol)) this.stayCache.set(symbol, new Map());
    const sub = this.stayCache.get(symbol);
    sub.set(key, {
      ticks_stayed_in: arr,
      maxTicks : +contractDetails.maximum_ticks || 0,
      maxPayout: +contractDetails.maximum_payout || 0,
      barrier  : +contractDetails.tick_size_barrier_percentage || 0,
      ts       : Date.now(),
    });
  }
  getStays(symbol, growthRate) {
    const sub = this.stayCache.get(symbol);
    if (!sub) return null;
    const key = +(+growthRate).toFixed(4);
    return sub.get(key) || null;
  }
  async refreshBarriers(assets, growthRates) {
    for (const sym of assets) {
      for (const gr of growthRates) {
        try {
          const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
          const res = await this.client._send({
            proposal: 1,
            amount  : this.cfg.stake,
            basis   : 'stake',
            contract_type: 'ACCU',
            currency: this.cfg.currency,
            [symbolKey]: sym,
            growth_rate: gr,
          }, 8000);
          if (res?.proposal?.contract_details) {
            const cd  = res.proposal.contract_details;
            const key = `${sym}:${gr}`;
            this._barrierCache.set(key, {
              halfBarrierPct: parseFloat(cd.tick_size_barrier_percentage || 0),
              highBarrier   : parseFloat(cd.high_barrier || 0),
              lowBarrier    : parseFloat(cd.low_barrier || 0),
              maxPayout     : parseFloat(cd.maximum_payout || 0),
            });
          }
        } catch (e) {
          logger.debug(`refreshBarriers(${sym},${gr}) failed:`, e.message);
        }
      }
    }
  }
  getBarrier(symbol, growthRate) {
    return this._barrierCache.get(`${symbol}:${growthRate}`);
  }
  async loadSymbols() {
    try {
      const res = await this.client._send({ active_symbols: 'brief' }, 15000);
      const list = res.active_symbols || [];
      for (const s of list) {
        const key = s.underlying_symbol || s.symbol;
        if (key) this.client.symbols.set(key, s);
      }
      logger.info(`loaded ${this.client.symbols.size} active symbols`);
    } catch (e) {
      logger.error('loadSymbols failed:', e.message);
    }
  }

  /**
   * v3: Dynamic asset discovery — queries Deriv for all ACCU-capable assets,
   * filters by configured families, and returns the discovered list.
   * Called on startup and periodically.
   */
  async discoverAccuAssets() {
    const discovered = [];
    try {
      // Fetch the full list of active symbols with their contract types
      const res = await this.client._send({ active_symbols: 'full' }, 20000);
      const list = res.active_symbols || [];

      const families = (this.cfg.assetFamilyFilter || [])
        .map(f => f.toUpperCase());

      for (const s of list) {
        const key = (s.underlying_symbol || s.symbol || '').toUpperCase();
        if (!key) continue;

        // Check if this symbol supports Accumulator contracts
        // Deriv synthetic indices with "boom", "crash", "volatility", "jump" support ACCU
        const market = (s.market || '').toLowerCase();
        const submarket = (s.submarket || '').toLowerCase();
        const symbolType = (s.symbol_type || '').toLowerCase();

        // Accept if it's a synthetic index (our target market)
        const isSynth = market === 'synthetic_index' || symbolType === 'synthetic_index';
        if (!isSynth) continue;

        // Filter by family if configured
        if (families.length > 0) {
          const matchesFamily = families.some(f => key.includes(f));
          if (!matchesFamily) continue;
        }

        // Verify it supports ACCU by doing a probe proposal
        // (skip this for speed — Deriv's synthetic indices generally support ACCU)
        discovered.push(key);
      }

      // Sort: BOOM/CRASH first (our specialty), then others
      discovered.sort((a, b) => {
        const aBoom = a.includes('BOOM') || a.includes('CRASH') ? 0 : 1;
        const bBoom = b.includes('BOOM') || b.includes('CRASH') ? 0 : 1;
        return aBoom - bBoom || a.localeCompare(b);
      });

      logger.info(`v3: discovered ${discovered.length} ACCU-capable assets: ${discovered.join(', ')}`);
    } catch (e) {
      logger.warn(`v3: asset discovery failed: ${e.message} — using configured list`);
      // Fall back to configured assets
      return this.cfg.assets.slice();
    }

    // Merge discovered with configured (configured always included)
    const merged = new Set([...this.cfg.assets, ...discovered]);
    return [...merged];
  }

  async backfill(symbol, count = 1000) {
    try {
      const res = await this.client._send({
        ticks_history: symbol,
        count, end: 'latest', style: 'ticks',
      }, 20000);
      const prices = res.history?.prices || [];
      const times  = res.history?.times  || [];
      const arr    = times.map((t, i) => ({ epoch: +t, quote: parseFloat(prices[i]) }));
      this.history.set(symbol, arr);
      if (arr.length) this.lastQuote.set(symbol, arr[arr.length - 1].quote);
      logger.debug(`backfilled ${symbol}: ${arr.length} ticks`);
      return arr;
    } catch (e) {
      logger.error(`backfill(${symbol}) failed:`, e.message);
      return [];
    }
  }

  /**
   * Deep historical backfill for the backtester (Fix #4).
   * Deriv `ticks_history` returns up to 5000 ticks per call.
   * We chain calls backwards using `end` = earliest epoch - 1.
   * Returns oldest → newest.
   */
  async deepBackfill(symbol, totalCount, batchSize = 5000, onProgress = null) {
    const out  = [];
    let remain = totalCount;
    let end    = 'latest';
    let lastEpoch = null;
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
      const batch = times.map((t, i) => ({ epoch: +t, quote: parseFloat(prices[i]) }));
      // Guard against server ignoring `end=` and re-serving the same window
      if (lastEpoch !== null && batch[batch.length - 1].epoch >= lastEpoch) {
        logger.info(`  (server did not honor pagination — history exhausted at ${out.length} ticks)`);
        break;
      }
      lastEpoch = batch[0].epoch;
      out.unshift(...batch);
      remain -= batch.length;
      if (onProgress) onProgress(out.length, totalCount);
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
    const subId = await this.client.subscribe(
      { ticks: symbol },
      msg => {
        const t = msg.tick;
        if (!t) return;
        const tick = { epoch: +t.epoch, quote: parseFloat(t.quote) };
        this.lastQuote.set(symbol, tick.quote);
        const arr = this.history.get(symbol);
        if (arr) {
          arr.push(tick);
          // APEX needs a deep buffer so spike cadence stays measurable.
          const cap = Math.max(this.cfg.apexHistoryWindow + 500, this.cfg.tickWindow * 8, 2000);
          if (arr.length > cap) arr.splice(0, arr.length - cap);
          this.history.set(symbol, arr);
        } else {
          this.history.set(symbol, [tick]);
        }
      },
    );
    this.subs.set(symbol, subId);
    logger.info(`subscribed ticks: ${symbol} (sub=${subId})`);
    return subId;
  }
  async unsubscribe(symbol) {
    const subId = this.subs.get(symbol);
    if (!subId) return;
    await this.client.forget(subId).catch(() => {});
    this.subs.delete(symbol);
    logger.info(`unsubscribed ticks: ${symbol}`);
  }
  async subscribeAll(symbols) {
    await Promise.all(symbols.map(s =>
      this.subscribe(s).catch(e => logger.warn(`subscribe(${s}) failed:`, e.message)),
    ));
  }
  async bootstrap(symbols) {
    if (this._bootstrapping) return;
    this._bootstrapping = true;
    try {
      await this.subscribeAll(symbols);
      const fetches = symbols.map(async s => {
        const hist = this.history.get(s) || [];
        // APEX needs a deep history so spike cadence is measurable from
        // the first analysis. Deep-fetch up to apexHistoryWindow ticks.
        const want = Math.max(this.cfg.apexHistoryWindow, this.cfg.tickWindow * 5, 1000);
        if (hist.length < want) {
          const fetched = await this.deepBackfill(s, want, this.cfg.backtestBatchSize);
          if (fetched && fetched.length) {
            // Merge deep history in front of any live ticks already buffered.
            const live = this.history.get(s) || [];
            const lastEpoch = fetched[fetched.length - 1].epoch;
            const tail = live.filter(t => t.epoch > lastEpoch);
            const merged = fetched.concat(tail);
            this.history.set(s, merged);
            if (merged.length) this.lastQuote.set(s, merged[merged.length - 1].quote);
          }
        }
      });
      await Promise.all(fetches);
    } finally {
      this._bootstrapping = false;
    }
  }
  historyFor(symbol) { return this.history.get(symbol) || []; }
  last(symbol)       { return this.lastQuote.get(symbol); }
}

// ─────────────────────────────────────────────────────────────────────
// 7. APEX ANALYZER  (Conditional-volatility bimodal survival engine)
// ─────────────────────────────────────────────────────────────────────
//
// KEY MODELLING CORRECTION vs the scaffold:
//   A Deriv Accumulator's barrier is recomputed EVERY tick around the
//   PREVIOUS spot. A knockout therefore happens when a *single* tick's
//   move exceeds the ± barrier — it is NOT a cumulative drift from the
//   entry price. So per-tick survival is  P(|one-tick return| < barrier)
//   and K-tick survival is that raised to the K-th power (approx. iid).
//
//   For Boom/Crash indices the calm inter-spike drift is far smaller
//   than the barrier, so a calm tick essentially never breaches — the
//   only knockout is a SPIKE. APEX models spike risk explicitly as a
//   per-tick hazard = 1 / (mean spike cadence), and only enters in the
//   fresh post-spike window where that hazard clock has just reset.
//
//   For Volatility/Jump indices there are no spikes; the barrier is
//   priced from aggregate σ, so APEX only enters when current σ is
//   compressed below baseline (barrier temporarily loose).
//
class ApexAnalyzer {
  constructor(cfg) { this.cfg = cfg; }

  analyze(symbol, ticks, market, currentSpot = null) {
    return this._analyzeWithRates(symbol, ticks, market, currentSpot, this.cfg.pulseGrowthRates);
  }

  // Live re-analysis during an open trade (single growth rate).
  reanalyze(symbol, ticks, market, currentSpot, growthRate) {
    return this._analyzeWithRates(symbol, ticks, market, currentSpot, [growthRate]);
  }

  // ── small numeric helpers ──────────────────────────────────────────
  _median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  _regimeClass(symbol) {
    const u = String(symbol).toUpperCase();
    if (u.includes('BOOM'))  return 'BOOM';
    if (u.includes('CRASH')) return 'CRASH';
    return 'VOL';
  }

  _analyzeWithRates(symbol, ticks, market, currentSpot, growthRates) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;
    const q = ticks.map(t => t.quote).filter(v => v > 0);
    if (q.length < 20) return null;

    // ── 1. Log returns (full history, so rare spikes are captured) ────
    const returns = [];
    for (let i = 1; i < q.length; i++) returns.push(Math.log(q[i] / q[i - 1]));
    if (returns.length < 15) return null;

    const price = currentSpot != null && currentSpot > 0 ? currentSpot : q[q.length - 1];
    const regimeClass = this._regimeClass(symbol);

    // ── 2. Robust scale (MAD) — spike-resistant unlike stdev ──────────
    const absR  = returns.map(Math.abs);
    const scale = Math.max(1.4826 * this._median(absR), 1e-12);
    const spikeThresh = this.cfg.apexSpikeK * scale;

    // ── 3. EWMA fast/slow σ  → volatility-compression signal ──────────
    //   Iterate oldest→newest; fast reacts to recent regime, slow is the
    //   baseline the barrier was effectively priced against.
    let fastVar = returns[0] * returns[0];
    let slowVar = fastVar;
    const af = this.cfg.apexEwmaFast, as = this.cfg.apexEwmaSlow;
    for (let i = 1; i < returns.length; i++) {
      const r2 = returns[i] * returns[i];
      fastVar = af * r2 + (1 - af) * fastVar;
      slowVar = as * r2 + (1 - as) * slowVar;
    }
    const sigmaFast = Math.sqrt(Math.max(fastVar, 1e-24));
    const sigmaSlow = Math.sqrt(Math.max(slowVar, 1e-24));
    const volRatio  = sigmaFast / Math.max(sigmaSlow, 1e-12);
    const mu        = returns.reduce((s, v) => s + v, 0) / returns.length;

    // ── 4. Spike detection + cadence (directional for Boom/Crash) ─────
    //   Boom spikes UP, Crash spikes DOWN. We only count spikes in the
    //   index's spike direction — those are the knockout events.
    const spikeIdx = [];
    for (let i = 0; i < returns.length; i++) {
      const r = returns[i];
      if (Math.abs(r) < spikeThresh) continue;
      if (regimeClass === 'BOOM'  && r > 0) spikeIdx.push(i);
      else if (regimeClass === 'CRASH' && r < 0) spikeIdx.push(i);
      else if (regimeClass === 'VOL') spikeIdx.push(i); // any large move
    }
    const spikesSeen = spikeIdx.length;
    let spikeCadence = 0;
    if (spikesSeen >= 2) {
      let gapSum = 0;
      for (let k = 1; k < spikeIdx.length; k++) gapSum += (spikeIdx[k] - spikeIdx[k - 1]);
      spikeCadence = gapSum / (spikeIdx.length - 1);
    }
    const ticksSinceSpike = spikesSeen
      ? (returns.length - 1) - spikeIdx[spikeIdx.length - 1]
      : Infinity;

    // Calm (non-spike) returns — the drift-only distribution.
    const calmReturns = returns.filter(r => Math.abs(r) <= spikeThresh);

    // ── 5. Barrier reference (fractional per-tick barrier) ────────────
    const refGr          = this.cfg.pulseGrowthRates[0] || 0.03;
    const barrierInfoRef = market ? market.getBarrier(symbol, refGr) : null;
    const spread         = this.cfg.pulseSpreadCost;

    // v3: ADAPTIVE EV THRESHOLD based on asset cadence.
    // Fast-cadence assets (BOOM50, cadence~50) have tighter barriers and
    // thinner per-trade EV, but compensate with 10x more opportunities.
    // BOOM1000: cadence~1000 → EV threshold stays at apexMinEV (0.5%)
    // BOOM50:   cadence~50   → EV threshold drops to ~0.125%
    // The threshold scales linearly from apexMinEV at cadence≥200 down
    // to 25% of apexMinEV at cadence≤50.
    const adaptiveMinEV = regimeClass === 'VOL'
      ? this.cfg.apexMinEV
      : Math.max(
          this.cfg.apexMinEV * 0.25,  // floor: 25% of base
          this.cfg.apexMinEV * Math.min(1, spikeCadence / 200),
        );

    // v3: ADAPTIVE SURVIVAL THRESHOLD based on asset cadence.
    // Fast-cadence assets (BOOM50, perTickSurv=94.56%) drop below 93%
    // at K=2 (0.9456²=89.4%). But 89% survival over 2 ticks is fine for
    // a fast-cadence asset with many daily opportunities. Scale the
    // survival floor down for fast assets.
    const adaptiveMinSurvival = regimeClass === 'VOL'
      ? this.cfg.apexMinSurvival
      : Math.max(
          0.70,  // floor: 70% absolute minimum
          this.cfg.apexMinSurvival * Math.min(1, spikeCadence / 200),
        );

    let best = null;

    for (const growthRate of growthRates) {
      const grBarrier = market ? market.getBarrier(symbol, growthRate) : null;

      // Prefer the exact per-tick barrier % (tick_size_barrier_percentage).
      let barrierFrac, barrierEstimated = false;
      if (grBarrier && grBarrier.halfBarrierPct > 0) {
        barrierFrac = grBarrier.halfBarrierPct / 100;
      } else if (barrierInfoRef && barrierInfoRef.halfBarrierPct > 0) {
        // scale ref barrier roughly with growth rate (narrower = higher g)
        barrierFrac = (barrierInfoRef.halfBarrierPct / 100) * (refGr / growthRate);
        barrierEstimated = true;
      } else {
        barrierFrac = 6 * scale;    // last-resort estimate — never traded on
        barrierEstimated = true;
      }
      const logBarrierHalf = Math.log(1 + barrierFrac);
      if (logBarrierHalf <= 0) continue;

      // ── 6. Per-tick survival = (1-hazard)·(1-P(calm breach)) ────────
      //   Calm-breach probability: fraction of calm ticks whose single
      //   move would exceed the barrier (≈0 for Boom/Crash, meaningful
      //   for Vol indices where the barrier is only a few σ wide).
      const calmBreaches = calmReturns.reduce(
        (c, r) => c + (Math.abs(r) >= logBarrierHalf ? 1 : 0), 0);
      const pBreachCalm = calmReturns.length ? calmBreaches / calmReturns.length : 1;

      let hazard;
      if (regimeClass === 'VOL') {
        hazard = 0;                                   // no spike process
      } else {
        hazard = (spikesSeen >= this.cfg.apexMinSpikesSeen && spikeCadence > 0)
          ? 1 / spikeCadence
          : 1;                                        // unknown cadence → reject
      }
      const perTickSurv = Math.max(0, (1 - hazard) * (1 - pBreachCalm));
      if (perTickSurv <= 0) continue;

      // ── 7. Class-specific entry window (the exploitable moment) ─────
      // v3: ASSET-ADAPTIVE parameters based on detected cadence.
      // Fast-cadence assets (BOOM50, cadence~50) get shorter holds and
      // wider windows; slow-cadence assets (BOOM1000, cadence~1000) keep
      // the standard settings.
      let maxHold, windowFrac;
      if (regimeClass === 'VOL') {
        maxHold    = this.cfg.apexMaxHoldVol;
        windowFrac = 1.0;  // vol compression has no spike window concept
      } else if (spikeCadence > 0) {
        // Adaptive max hold: scale with cadence (12% of cadence, min 3, max configured)
        // BOOM50:  min(8, max(3, floor(50*0.12)))  = min(8, 6)  = 6 ticks
        // BOOM150: min(8, max(3, floor(150*0.12))) = min(8, 18) = 8 ticks
        // BOOM1000: min(8, max(3, floor(1000*0.12))) = min(8, 120) = 8 ticks
        maxHold = Math.min(
          this.cfg.apexMaxHoldBoom,
          Math.max(3, Math.floor(spikeCadence * 0.12)),
        );
        // Adaptive window: faster assets get a wider fraction (more opportunities)
        // BOOM50:  min(0.50, 0.35 + 10*0.05) = min(0.50, 0.85) = 0.50 → 25 ticks
        // BOOM150: min(0.50, 0.35 + 3.3*0.05) = min(0.50, 0.52) = 0.50 → 75 ticks
        // BOOM1000: min(0.50, 0.35 + 0.5*0.05) = min(0.50, 0.375) = 0.375 → 375 ticks
        windowFrac = Math.min(
          0.50,
          this.cfg.apexPostSpikeWindowFrac + (500 / Math.max(spikeCadence, 50)) * 0.05,
        );
      } else {
        maxHold    = this.cfg.apexMaxHoldBoom;
        windowFrac = this.cfg.apexPostSpikeWindowFrac;
      }

      let entryOK = false, entryReason = '';
      if (regimeClass === 'VOL') {
        const compressed   = volRatio <= this.cfg.apexVolCompressRatio;
        const barrierClears = barrierFrac >= this.cfg.apexBarrierSafety * sigmaFast;
        entryOK = compressed && barrierClears && !barrierEstimated;
        entryReason = barrierEstimated ? 'no-barrier'
                    : !compressed      ? 'vol-not-compressed'
                    : !barrierClears   ? 'barrier-too-tight'
                    : 'vol-compressed';
      } else {
        const cadenceKnown = spikesSeen >= this.cfg.apexMinSpikesSeen && spikeCadence > 0;
        const freshWindow  = ticksSinceSpike >= this.cfg.apexPostSpikeMin &&
                             ticksSinceSpike <= windowFrac * spikeCadence;

        // v3: HOLD-PERIOD-AWARE hazard check (replaces fixed per-tick threshold).
        // Instead of rejecting assets where hazard > 1% (which blocks BOOM50 at
        // 2% even though its 8-tick hold only has ~15% spike risk), we check
        // whether the spike survival over the actual hold duration is acceptable.
        // spikeSurvival = (1 - hazard)^maxHold
        // e.g. BOOM50: (1-0.02)^8 = 0.85 → 85% survival → OK
        //      BOOM1000: (1-0.001)^8 = 0.992 → 99.2% survival → OK
        //      Extreme: hazard=10%, hold=8: (0.9)^8 = 0.43 → REJECTED
        const spikeSurvivalHold = Math.pow(Math.max(0, 1 - hazard), maxHold);
        const hazardOK = spikeSurvivalHold >= this.cfg.apexMinSpikeSurvival;
        entryOK = cadenceKnown && freshWindow && hazardOK && !barrierEstimated;
        entryReason = barrierEstimated    ? 'no-barrier'
                    : !cadenceKnown       ? 'cadence-unknown'
                    : !freshWindow        ? 'not-post-spike'
                    : !hazardOK           ? `hazard-low-surv:${(spikeSurvivalHold*100).toFixed(0)}%`
                    : 'post-spike';
      }

      // ── 8. EV-optimal compounding horizon (closed form) ─────────────
      //   value(K) = ((1+g)·perTickSurv)^K ; edge = value − spread.
      let bestN = 0, bestEv = -Infinity, bestEdge = 0, bestSurv = 0;
      let rawEdge = -Infinity, rawEv = -Infinity, rawN = 1, rawSurv = perTickSurv;
      for (let K = 1; K <= maxHold; K++) {
        const survK = Math.pow(perTickSurv, K);
        const edge  = Math.pow(1 + growthRate, K) * survK - spread;
        const ev    = edge - 1;
        if (edge > rawEdge) { rawEdge = edge; rawEv = ev; rawN = K; rawSurv = survK; }
        // v3: use adaptive thresholds (cadence-scaled) instead of fixed values
        if (survK >= adaptiveMinSurvival && ev >= adaptiveMinEV && ev > bestEv) {
          bestEv = ev; bestN = K; bestEdge = edge; bestSurv = survK;
        }
      }

      const chosen = bestN > 0;
      const N       = chosen ? bestN    : rawN;
      const ev      = chosen ? bestEv   : rawEv;
      const edge    = chosen ? bestEdge : (rawEdge === -Infinity ? 0 : rawEdge);
      const pN      = chosen ? bestSurv : rawSurv;

      const edgeOK = edge >= this.cfg.pulseEdgeThreshold;
      const evOK   = ev   >= adaptiveMinEV;  // v3: cadence-adaptive (not fixed)
      const survOK = pN   >= adaptiveMinSurvival;  // v3: cadence-adaptive (not fixed)
      const calmOK = entryOK;   // "entry window open" — reuses the scaffold gate name

      const candidate = {
        symbol, growthRate,
        regime: regimeClass.toLowerCase(), regimeClass,
        edge, ev, bestN: N,
        pN, p1: perTickSurv,
        perTickSurv, hazard, pBreachCalm, barrierEstimated,
        ticksSinceSpike: Number.isFinite(ticksSinceSpike) ? ticksSinceSpike : -1,
        spikeCadence: +spikeCadence.toFixed(1), spikesSeen,
        sigma: sigmaFast, sigmaFast, sigmaSlow, volRatio, vrRatio: volRatio,
        scale, mu,
        barrierFrac, halfBarrierFrac: logBarrierHalf, logBarrierHalf, price,
        suggestedTakeProfit: Math.max(Math.pow(1 + growthRate, N) - 1, 0.005),
        spreadCost: spread,
        // v3: asset-adaptive parameters
        adaptiveMaxHold: maxHold,
        adaptiveWindowFrac: +windowFrac.toFixed(4),
        adaptiveMinEV: +adaptiveMinEV.toFixed(6),
        spikeSurvivalHold: regimeClass !== 'VOL' ? +Math.pow(Math.max(0, 1 - hazard), maxHold).toFixed(4) : 1,
        entryReason,
        edgeOK, evOK, survOK, calmOK,
        recommend: chosen && edgeOK && evOK && survOK && calmOK,
      };
      // Rank preference: recommendable candidates first, then by edge.
      if (!best ||
          (candidate.recommend && !best.recommend) ||
          (candidate.recommend === best.recommend && candidate.edge > best.edge)) {
        best = candidate;
      }
    }
    return best;
  }

  rank(analyses) {
    return analyses.filter(Boolean).sort((a, b) => {
      if (a.recommend !== b.recommend) return a.recommend ? -1 : 1;
      return b.edge - a.edge;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// 8. TRADE EXECUTOR (Accumulator)
// ─────────────────────────────────────────────────────────────────────
class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client   = client;
    this.cfg      = cfg;
    this.open     = new Map();
    this.analyzer = null;
    this._selling = new Set();
  }

  async buy(symbol, growthRate, stake, limit, analysis = null) {
    growthRate = Math.max(0.01, Math.min(0.05, +growthRate.toFixed(4)));
    try {
      const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
      const pres = await this.client._send({
        proposal      : 1,
        amount        : stake,
        basis         : 'stake',
        contract_type : 'ACCU',
        currency      : this.cfg.currency,
        [symbolKey]   : symbol,
        growth_rate   : growthRate,
        ...((limit.take_profit != null && limit.take_profit > 0)
          ? { limit_order: { take_profit: limit.take_profit } } : {}),
      }, 20000);
      const p = pres.proposal;
      if (!p?.id) throw new Error('No proposal id returned');
      logger.info(`proposal id=${p.id} ask=${p.ask_price} payout=${p.payout} spot=${p.spot}`);
      if (pres.error) throw new Error(pres.error.message);

      const bres = await this.client._send({ buy: p.id, price: p.ask_price }, 20000);
      const b = bres.buy;
      if (!b?.contract_id) throw new Error('Buy did not return contract_id');
      logger.info(`bought ACCU #${b.contract_id} for ${b.buy_price}`);

      const cd            = p.contract_details || {};
      const entrySpot     = parseFloat(p.spot ?? cd.current_spot ?? 0);
      const halfBarrierPct = entrySpot
        ? (parseFloat(cd.barrier_spot_distance ?? 0) / entrySpot) * 100
        : 0;
      const highBarrier = parseFloat(cd.high_barrier    ?? 0);
      const lowBarrier  = parseFloat(cd.low_barrier     ?? 0);
      const maxPayout   = parseFloat(cd.maximum_payout  ?? 0);

      const info = {
        contractId: b.contract_id,
        symbol, growthRate, stake,
        buyPrice: parseFloat(b.buy_price),
        payout  : parseFloat(b.payout),
        buyTime : b.purchase_time || (Date.now() / 1000),
        limit   : {
          stop_loss  : limit.stop_loss   ?? null,
          take_profit: limit.take_profit ?? null,
        },
        contractDetails: cd,
        entrySpot, halfBarrierPct, highBarrier, lowBarrier, maxPayout,
        proposalId  : p.id,
        balanceAfter: parseFloat(b.balance_after ?? this.client.balance),
        ticksHeld   : 0,
        peakProfit  : 0,
        lastBid     : null,   // Bug 6 — track live bid_price for sells
      };
      if (analysis && typeof analysis === 'object') info._analysis = analysis;

      this.open.set(b.contract_id, info);
      logger.info(
        `barrier: ±${halfBarrierPct.toFixed(4)}% spot=${entrySpot.toFixed(2)} ` +
        `[${lowBarrier.toFixed(2)} … ${highBarrier.toFixed(2)}] maxPayout=${maxPayout}`,
      );

      if (this.bot?.market?.cacheStays) this.bot.market.cacheStays(symbol, growthRate, cd);

      await this.client.subscribe(
        { proposal_open_contract: 1, contract_id: b.contract_id },
        msg => this._onUpdate(msg, info),
      );

      this.emit('open', info);
      return info;
    } catch (e) {
      logger.error(`buy(${symbol}) failed:`, e.message);
      throw e;
    }
  }

  // ── Adaptive early-exit ────────────────────────────────────
  _adaptiveExitDecision(info, currentProfit, currentSpot) {
    const cfg      = this.cfg;
    const analysis = info._analysis;
    if (!analysis) return { exit: false, reason: 'no-analysis', urgency: 0 };

    const growthRate = info.growthRate;
    const stake      = info.stake;

    const analyzer = this.bot?.analyzer ?? this.analyzer;
    const market   = this.bot?.market   ?? null;
    const ticks    = market?.historyFor(info.symbol) ?? [];

    // Baselines from the entry analysis; refreshed live below.
    let perTickSurv = analysis.perTickSurv ?? analysis.p1 ?? 0.99;
    let hazardLive  = analysis.hazard      ?? 0;
    let bestEVLive  = analysis.ev          ?? 0;
    let bestNLive   = analysis.bestN       ?? 1;

    if (analyzer && ticks.length >= cfg.minTicksForAnalysis && currentSpot > 0) {
      try {
        const live = analyzer.reanalyze(info.symbol, ticks, market, currentSpot, growthRate);
        if (live) {
          perTickSurv = live.perTickSurv ?? perTickSurv;
          hazardLive  = live.hazard      ?? hazardLive;
          bestEVLive  = live.ev          ?? bestEVLive;
          bestNLive   = live.bestN       ?? bestNLive;
        }
      } catch (e) {
        logger.debug(`reanalyze error #${info.contractId}: ${e.message}`);
      }
    }

    const ticksHeld = info.ticksHeld ?? 0;

    // ── Signal A: EV-optimal horizon reached ─────────────────
    //   We entered planning to compound bestN ticks; once we've held
    //   that many, banking is the whole thesis — don't get greedy.
    const targetReached = ticksHeld >= (analysis.bestN ?? bestNLive);

    // ── Signal B: Profit-lock ────────────────────────────────
    //   Require BOTH an absolute floor and a fraction of the still-
    //   expected remaining upside, so we don't lock at ~$0.
    const lockFrac            = cfg.apexProfitLockFrac;
    const expectedRemaining   = stake * Math.max(bestEVLive, 0);
    const profitLockThreshold = lockFrac * expectedRemaining;
    const minProfitToLock     = stake * cfg.apexMinProfitLockFrac;
    const profitLock = currentProfit >= minProfitToLock
                    && currentProfit >= profitLockThreshold;

    // ── Signal C: Rising spike hazard (Boom/Crash core exit) ──
    //   As ticks-since-spike grows the hazard clock re-arms; bail once
    //   the live per-tick spike hazard exceeds the exit threshold.
    const hazardExit = hazardLive >= cfg.apexExitHazard;

    // ── Signal D: Holding is now EV-negative ─────────────────
    const nextTickEdge = (1 + growthRate) * perTickSurv - cfg.pulseSpreadCost;
    const nextTickExit = nextTickEdge < 1.0;

    // ── Signal E: A near-miss big tick (drift danger) ─────────
    //   Per-tick model: look at the most recent single-tick move vs the
    //   barrier. A tick that used a large fraction of the barrier warns
    //   volatility is expanding — exit before the next one breaches.
    let driftExit = false, driftFrac = 0;
    const hist = ticks;
    if (hist.length >= 2) {
      const a = hist[hist.length - 2].quote, b = hist[hist.length - 1].quote;
      if (a > 0 && b > 0) {
        const step = Math.abs(Math.log(b / a));
        const logBarrierHalf = analysis.logBarrierHalf
          ?? Math.log(1 + (info.halfBarrierPct ?? 0.05) / 100);
        driftFrac = step / Math.max(logBarrierHalf, 1e-12);
        driftExit = driftFrac >= cfg.apexExitDriftFrac;
      }
    }

    const urgency = Math.max(
      targetReached ? 1            : 0,
      profitLock    ? lockFrac     : 0,
      hazardExit    ? hazardLive*50: 0,
      nextTickExit  ? 1-nextTickEdge : 0,
      driftExit     ? driftFrac    : 0,
    );

    if (targetReached) {
      return { exit: true, reason: `target-reached: held ${ticksHeld} ≥ N*=${analysis.bestN ?? bestNLive}`, urgency };
    }
    if (driftExit) {
      return { exit: true, reason: `drift-danger: last tick used ${(driftFrac*100).toFixed(1)}% of barrier`, urgency };
    }
    if (hazardExit) {
      return { exit: true, reason: `spike-hazard: live hazard ${(hazardLive*100).toFixed(2)}% ≥ ${(cfg.apexExitHazard*100).toFixed(2)}%`, urgency };
    }
    if (profitLock) {
      return {
        exit: true,
        reason: `profit-lock: realised ${currentProfit.toFixed(3)} ≥ ` +
                `max(${minProfitToLock.toFixed(3)}, ${lockFrac}×${expectedRemaining.toFixed(3)})` +
                ` (live-EV=${(bestEVLive*100).toFixed(2)}% N*=${bestNLive})`,
        urgency,
      };
    }
    if (nextTickExit) {
      return {
        exit: true,
        reason: `next-tick-edge: (1+g)·surv−spread=${nextTickEdge.toFixed(4)} < 1.0`,
        urgency,
      };
    }
    return { exit: false, reason: 'hold', urgency };
  }

  async _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    const cid         = c.contract_id ?? info.contractId;
    const profit      = parseFloat(c.profit ?? 0);
    const currentSpot = parseFloat(c.current_spot ?? 0);
    const status      = c.status;

    // Track ticks, peak, and any live bid price we can use as a floor
    // for sell() (Bug 6 mitigation).
    if (status === 'open') {
      info.ticksHeld  = (info.ticksHeld ?? 0) + 1;
      info.peakProfit = Math.max(info.peakProfit ?? 0, profit);
    }
    if (c.bid_price != null) info.lastBid = parseFloat(c.bid_price);

    logger.debug(
      `contract #${cid} status=${status} profit=${profit.toFixed(3)} ` +
      `spot=${currentSpot} ticksHeld=${info.ticksHeld ?? 0}`,
    );

    // ── Hard stop-loss ───────────────────────────────────────
    const stopLossAbs = Math.abs(info.limit?.stop_loss || 0);
    if (status === 'open' && stopLossAbs > 0 && profit <= -stopLossAbs && !this._selling.has(cid)) {
      logger.warn(`contract #${cid} hit stop-loss @ profit=${profit.toFixed(2)} ≤ -${stopLossAbs} — selling`);
      this._selling.add(cid);
      try { await this.sell(cid, 0, info); }
      catch (e) { logger.error(`emergency sell #${cid} failed:`, e.message); }
      finally  { this._selling.delete(cid); }
      return;
    }

    // ── Adaptive early-exit ─────────────────────────────────
    if (status === 'open' && !this._selling.has(cid)) {
      const dec = this._adaptiveExitDecision(info, profit, currentSpot);
      if (dec.exit) {
        logger.info(`APEX adaptive exit #${cid}: ${dec.reason} urgency=${dec.urgency.toFixed(3)}`);
        this.emit('driftWarning', { ...info, contractId: cid, profit, currentSpot, dec });
        this._selling.add(cid);
        try { await this.sell(cid, 0, info); }
        catch (e) { logger.error(`adaptive sell #${cid} failed:`, e.message); }
        finally  { this._selling.delete(cid); }
        return;
      }
      this.emit('update', { ...info, contractId: cid, profit, currentSpot, status, dec });
      return;
    }

    // ── Contract settled ────────────────────────────────────
    if (status === 'won' || status === 'lost') {
      const finished = {
        ...info,
        contractId: cid, profit, status,
        sellPrice: parseFloat(c.sell_price ?? 0),
        sellTime : c.sell_time ?? (Date.now() / 1000),
        currentSpot,
      };
      this.open.delete(cid);
      this.emit('result', finished);
      if (msg.subscription?.id) {
        await this.client.forget(msg.subscription.id).catch(() => {});
      }
    }
  }

  /**
   * Sell.
   *
   * Bug 6 mitigation — when we have a recent bid_price from the
   * proposal_open_contract stream we pass a small floor (95% of that
   * bid) so Deriv doesn't fill an order at an unexpectedly bad price.
   * Passing `price: 0` alone means "accept anything", which on 1-2
   * tick holds can leak significant sell-side spread.
   */
  async sell(contractId, minPrice = 0, info = null) {
    try {
      let floor = Number(minPrice) || 0;
      if (info && info.lastBid && info.lastBid > 0 && floor === 0) {
        floor = +(info.lastBid * 0.95).toFixed(2);
      }
      const res = await this.client._send({ sell: contractId, price: floor }, 15000);
      logger.info(`sold #${contractId} for ${res.sell?.sold_for} (floor=${floor})`);
      return res.sell;
    } catch (e) {
      // If the floor was rejected, retry with price:0 once as a safety net.
      if (minPrice === 0 && /price/i.test(e.message || '')) {
        try {
          const res = await this.client._send({ sell: contractId, price: 0 }, 15000);
          logger.warn(`sell fallback (price:0) #${contractId} for ${res.sell?.sold_for}`);
          return res.sell;
        } catch (e2) {
          logger.error(`sell(${contractId}) fallback failed:`, e2.message);
          throw e2;
        }
      }
      logger.error(`sell(${contractId}) failed:`, e.message);
      throw e;
    }
  }

  openTrades() { return Array.from(this.open.values()); }
  count()      { return this.open.size; }
}

// ─────────────────────────────────────────────────────────────────────
// 9. STATISTICS MANAGER
// ─────────────────────────────────────────────────────────────────────
class StatisticsManager {
  constructor(saved = null) {
    this.trades            = [];
    this.dailySummaries    = {};
    this.overallProfit     = 0;
    this.currentLossStreak = 0;
    this.maxLossStreak     = 0;
    this.lossStreakEvents  = { x2: 0, x3: 0, x4: 0 };
    this.eodSentDates      = [];
    if (saved) this.load(saved);
  }
  load(saved) {
    if (Array.isArray(saved.trades))                  this.trades         = saved.trades;
    if (saved.dailySummaries && typeof saved.dailySummaries === 'object')
      this.dailySummaries = saved.dailySummaries;
    this.overallProfit     = Number(saved.overallProfit     || 0);
    this.currentLossStreak = Number(saved.currentLossStreak || 0);
    this.maxLossStreak     = Number(saved.maxLossStreak     || 0);
    this.lossStreakEvents  = {
      x2: Number(saved.lossStreakEvents?.x2 || 0),
      x3: Number(saved.lossStreakEvents?.x3 || 0),
      x4: Number(saved.lossStreakEvents?.x4 || 0),
    };
    this.eodSentDates = Array.isArray(saved.eodSentDates) ? saved.eodSentDates : [];
  }
  serialize() {
    return {
      trades           : this.trades.slice(-5000),
      dailySummaries   : this.dailySummaries,
      overallProfit    : this.overallProfit,
      currentLossStreak: this.currentLossStreak,
      maxLossStreak    : this.maxLossStreak,
      lossStreakEvents : this.lossStreakEvents,
      eodSentDates     : this.eodSentDates.slice(-400),
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
    const wins   = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
    const total  = list.reduce((s, t) => s + Number(t.profit || 0), 0);
    const gw     = wins.reduce  ((s, t) => s + Number(t.profit || 0), 0);
    const gl     = Math.abs(losses.reduce((s, t) => s + Number(t.profit || 0), 0));
    const stake  = list.reduce  ((s, t) => s + Number(t.stake  || 0), 0);
    const maxLossStreak = (() => {
      let cur = 0, max = 0;
      for (const t of list) {
        if (t.status === 'lost')      { cur += 1; max = Math.max(max, cur); }
        else if (t.status === 'won')  cur = 0;
      }
      return max;
    })();
    return {
      count       : list.length,
      wins        : wins.length,
      losses      : losses.length,
      winRate     : list.length ? wins.length / list.length * 100 : 0,
      grossWin    : gw,
      grossLoss   : gl,
      totalProfit : total,
      netPL       : total,
      profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
      avgProfit   : list.length ? total / list.length : 0,
      stake, maxLossStreak,
    };
  }
  summaryForDate(date) {
    const list = this.tradesForDate(date);
    return { date, trades: list, stats: this.stats(list) };
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
    const rows  = [];
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
// 9b. PER-ASSET RISK TRACKER (v3 — the "don't over-trade" brain)
// ─────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS:
//   The original APEX engine had no memory of per-asset trading history
//   within a session. When a post-spike window opened on BOOM1000, the
//   analyzer would keep recommending re-entries because the edge still
//   looked positive — but each successive entry in the same window has
//   diminishing edge and increasing exposure to the next spike. This
//   tracker enforces hard limits on:
//     1. Entries per spike window per asset
//     2. Consecutive losses → cooldown
//     3. Rolling win rate → don't trade consistently losing assets
//     4. Session drawdown → circuit breaker
//     5. Correlated asset exposure → don't double up on same regime
//
class PerAssetTracker {
  constructor(cfg) {
    this.cfg = cfg;

    // Per-asset state: keyed by symbol
    this.assets = new Map();

    // Session-level state
    this.sessionPnl       = 0;
    this.sessionPeakPnl   = 0;
    this.sessionHalted    = false;
    this.sessionHaltReason = '';

    // Active assets (assets with an open trade right now)
    this.activeAssets = new Set();
  }

  _getAsset(symbol) {
    if (!this.assets.has(symbol)) {
      this.assets.set(symbol, {
        symbol,
        // Spike window tracking
        lastSpikeEpoch      : 0,      // epoch of last detected spike
        entriesInWindow     : 0,      // trades entered since last spike
        // Loss tracking
        consecutiveLosses   : 0,
        cooldownUntil       : 0,      // timestamp (ms) when cooldown expires
        pausedUntil         : 0,      // timestamp (ms) when asset pause expires
        // Rolling performance
        recentResults       : [],     // last N results: {won: bool, pnl: number, ts: number}
        rollingWins         : 0,
        rollingLosses       : 0,
        rollingWinRate      : 0.5,    // default to neutral
        // Per-asset P/L
        totalTrades         : 0,
        totalPnl            : 0,
        // Current stake for this asset
        adaptiveStake       : null,   // null = use global
      });
    }
    return this.assets.get(symbol);
  }

  // ── Called every analysis cycle ──
  // Returns { allowed: bool, reason: string, adjustedEdge: number }
  checkEntry(symbol, rawEdge, currentSpikeEpoch) {
    const a = this._getAsset(symbol);
    const now = Date.now();

    // 1. Session halt
    if (this.sessionHalted) {
      return { allowed: false, reason: `session-halted: ${this.sessionHaltReason}`, adjustedEdge: rawEdge };
    }

    // 2. Asset paused (too many consecutive losses)
    if (a.pausedUntil > now) {
      const remainSec = ((a.pausedUntil - now) / 1000).toFixed(0);
      return { allowed: false, reason: `asset-paused: ${remainSec}s left (${a.consecutiveLosses} consecutive losses)`, adjustedEdge: rawEdge };
    }

    // 3. Loss cooldown
    if (a.cooldownUntil > now) {
      const remainSec = ((a.cooldownUntil - now) / 1000).toFixed(0);
      return { allowed: false, reason: `loss-cooldown: ${remainSec}s left`, adjustedEdge: rawEdge };
    }

    // 4. Spike window entry limit
    //    If a new spike has fired since our last check, reset the window counter.
    if (currentSpikeEpoch > a.lastSpikeEpoch && currentSpikeEpoch > 0) {
      a.lastSpikeEpoch = currentSpikeEpoch;
      a.entriesInWindow = 0;
    }
    if (a.entriesInWindow >= this.cfg.maxEntriesPerSpikeWindow) {
      return { allowed: false, reason: `window-limit: ${a.entriesInWindow}/${this.cfg.maxEntriesPerSpikeWindow} entries in current window`, adjustedEdge: rawEdge };
    }

    // 5. Rolling win rate filter
    if (a.totalTrades >= this.cfg.rollingWindowSize) {
      if (a.rollingWinRate < this.cfg.minWinRateToTrade) {
        return { allowed: false, reason: `low-winrate: ${(a.rollingWinRate*100).toFixed(1)}% < ${(this.cfg.minWinRateToTrade*100).toFixed(0)}%`, adjustedEdge: rawEdge };
      }
    }

    // 6. Edge boost after losses: require higher edge to justify re-entry
    let adjustedEdge = rawEdge;
    if (a.consecutiveLosses > 0) {
      const edgePenalty = a.consecutiveLosses * this.cfg.edgeAfterLossBoost;
      adjustedEdge = rawEdge - edgePenalty;
      if (adjustedEdge < this.cfg.pulseEdgeThreshold) {
        return { allowed: false, reason: `edge-reduced: ${(rawEdge*100).toFixed(2)}% - ${(edgePenalty*100).toFixed(2)}% penalty = ${(adjustedEdge*100).toFixed(2)}% < threshold`, adjustedEdge };
      }
    }

    // 7. Session drawdown check
    this._updateSessionDrawdown();
    if (this.sessionHalted) {
      return { allowed: false, reason: `session-halt: drawdown ${(this.sessionPnl - this.sessionPeakPnl).toFixed(2)} exceeded limit`, adjustedEdge: rawEdge };
    }

    return { allowed: true, reason: 'ok', adjustedEdge };
  }

  // ── Called when a trade opens ──
  onTradeOpen(symbol) {
    const a = this._getAsset(symbol);
    a.entriesInWindow++;
    a.totalTrades++;
    this.activeAssets.add(symbol);
  }

  // ── Called when a trade closes ──
  onTradeResult(symbol, won, pnl) {
    const a = this._getAsset(symbol);
    const now = Date.now();

    this.activeAssets.delete(symbol);

    // Update session P/L
    this.sessionPnl += pnl;
    if (this.sessionPnl > this.sessionPeakPnl) this.sessionPeakPnl = this.sessionPnl;

    // Per-asset P/L
    a.totalPnl += pnl;

    // Rolling window
    a.recentResults.push({ won, pnl, ts: now });
    if (a.recentResults.length > this.cfg.rollingWindowSize) {
      a.recentResults.shift();
    }
    a.rollingWins   = a.recentResults.filter(r => r.won).length;
    a.rollingLosses = a.recentResults.length - a.rollingWins;
    a.rollingWinRate = a.recentResults.length > 0
      ? a.rollingWins / a.recentResults.length
      : 0.5;

    // Consecutive loss tracking
    if (won) {
      a.consecutiveLosses = 0;
      a.cooldownUntil = 0;
    } else {
      a.consecutiveLosses++;

      // Apply cooldown after each loss
      a.cooldownUntil = now + this.cfg.assetLossCooldownMs;

      // If consecutive losses hit the limit, PAUSE the asset
      if (a.consecutiveLosses >= this.cfg.assetMaxConsecutiveLosses) {
        a.pausedUntil = now + this.cfg.assetPauseDurationMs;
        logger.warn(
          `PerAsset: ${symbol} PAUSED for ${(this.cfg.assetPauseDurationMs/1000).toFixed(0)}s ` +
          `after ${a.consecutiveLosses} consecutive losses (WR: ${(a.rollingWinRate*100).toFixed(1)}%)`,
        );
      }
    }
  }

  // ── Adaptive stake sizing (replaces raw martingale) ──
  getAdaptiveStake(symbol, baseStake) {
    if (this.cfg.sizingModeV3 === 'flat') return baseStake;

    const a = this._getAsset(symbol);
    let stake = a.adaptiveStake ?? baseStake;

    // Floor and ceiling
    const floor = baseStake * this.cfg.minStakeFraction;
    const ceiling = baseStake * this.cfg.maxStakeFraction;
    stake = Math.max(floor, Math.min(ceiling, stake));

    return +stake.toFixed(2);
  }

  // ── Update stake after trade result ──
  updateStakeAfterResult(symbol, won, currentStake, baseStake) {
    const a = this._getAsset(symbol);
    let newStake;

    if (won) {
      // After a win: partially recover toward base
      newStake = currentStake * this.cfg.winStakeRecovery;
    } else {
      // After a loss: reduce stake (anti-martingale)
      newStake = currentStake * this.cfg.lossStakeReduction;
    }

    // Apply floor/ceiling
    const floor = baseStake * this.cfg.minStakeFraction;
    const ceiling = baseStake * this.cfg.maxStakeFraction;
    a.adaptiveStake = Math.max(floor, Math.min(ceiling, newStake));
  }

  // ── Session drawdown tracking ──
  _updateSessionDrawdown() {
    const dd = this.sessionPeakPnl - this.sessionPnl; // positive = drawdown
    if (dd >= this.cfg.sessionMaxDrawdown && !this.sessionHalted) {
      this.sessionHalted = true;
      this.sessionHaltReason = `drawdown ${dd.toFixed(2)} >= ${this.cfg.sessionMaxDrawdown}`;
      logger.error(`SESSION HALTED: ${this.sessionHaltReason}`);
    }
  }

  // ── Check if an asset is in the same correlated group as an active asset ──
  isCorrelated(symbol) {
    const groups = this.cfg.correlatedGroups || [];
    for (const group of groups) {
      const symUpper = symbol.toUpperCase();
      const groupUpper = group.map(s => s.toUpperCase());
      if (groupUpper.includes(symUpper)) {
        // Check if any OTHER asset in this group is currently active
        for (const active of this.activeAssets) {
          if (active !== symbol && groupUpper.includes(active.toUpperCase())) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // ── Get active asset count ──
  activeCount() { return this.activeAssets.size; }

  // ── Reset session (new trade day) ──
  resetSession() {
    this.sessionPnl     = 0;
    this.sessionPeakPnl = 0;
    this.sessionHalted  = false;
    this.sessionHaltReason = '';
    this.activeAssets.clear();
  }

  // ── Summary for Telegram ──
  summary() {
    const lines = [];
    for (const [sym, a] of this.assets) {
      if (a.totalTrades === 0) continue;
      const wr = a.totalTrades > 0 ? (a.rollingWins / Math.max(a.recentResults.length, 1) * 100).toFixed(0) : '-';
      const cool = a.cooldownUntil > Date.now() ? ' ❄️' : '';
      const pause = a.pausedUntil > Date.now() ? ' ⛔' : '';
      lines.push(`  ${sym}: ${a.totalTrades} trades, WR=${wr}%, P/L=${a.totalPnl >= 0 ? '+' : ''}${a.totalPnl.toFixed(2)}${cool}${pause}`);
    }
    return lines.join('\n');
  }

  serialize() {
    const obj = { sessionPnl: this.sessionPnl, sessionPeakPnl: this.sessionPeakPnl, assets: {} };
    for (const [sym, a] of this.assets) {
      obj.assets[sym] = {
        consecutiveLosses: a.consecutiveLosses,
        totalTrades: a.totalTrades,
        totalPnl: a.totalPnl,
        recentResults: a.recentResults.slice(-this.cfg.rollingWindowSize),
        adaptiveStake: a.adaptiveStake,
      };
    }
    return obj;
  }

  loadSaved(data) {
    if (!data || !data.assets) return;
    this.sessionPnl = data.sessionPnl ?? 0;
    this.sessionPeakPnl = data.sessionPeakPnl ?? 0;
    for (const [sym, saved] of Object.entries(data.assets)) {
      const a = this._getAsset(sym);
      a.consecutiveLosses = saved.consecutiveLosses ?? 0;
      a.totalTrades = saved.totalTrades ?? 0;
      a.totalPnl = saved.totalPnl ?? 0;
      a.recentResults = saved.recentResults ?? [];
      a.adaptiveStake = saved.adaptiveStake ?? null;
      a.rollingWins = a.recentResults.filter(r => r.won).length;
      a.rollingLosses = a.recentResults.length - a.rollingWins;
      a.rollingWinRate = a.recentResults.length > 0 ? a.rollingWins / a.recentResults.length : 0.5;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// 10. BACKTESTER (Fix #4)
// ─────────────────────────────────────────────────────────────────────
/**
 * Historical simulator.
 *   1. Deep-fetch N ticks (default 100K) via ticks_history in 5K batches.
 *   2. Walk the tick series forward. At each index i (>= minWindow):
 *        a. Slice ticks[i-window .. i] as the "live window".
 *        b. Run PulseAnalyzer.analyze() with a synthetic MarketDataManager
 *           whose barrier cache falls back to the analyzer's default.
 *        c. If recommend=true → open a virtual trade:
 *              - entrySpot   = ticks[i].quote
 *              - N           = analysis.bestN
 *              - growthRate  = analysis.growthRate
 *              - logBarrierHalf from analysis
 *           Then walk ticks[i+1..i+N] and check:
 *              - if |log(price/entry)| >= logBarrierHalf → LOSS (stake)
 *              - else after N ticks              → WIN  (stake·((1+g)^N-1)-spread·stake)
 *        d. Advance i by (N+1) if we took a trade, else 1.
 *   3. Report: signals, wins, losses, empirical win-rate vs predicted pN,
 *      total P/L, edge realized vs predicted, spread drag.
 */
class PulseBacktester {
  constructor(cfg, deriv) {
    // Build an EFFECTIVE cfg that layers backtest overrides on top of
    // the live cfg. Only the analyzer used by this backtester sees these
    // overrides — live trading is untouched.
    const overrides = {};
    if (cfg.backtestEdge       != null) overrides.pulseEdgeThreshold = cfg.backtestEdge;
    if (cfg.backtestMinEV      != null) overrides.pulseMinEV         = cfg.backtestMinEV;
    if (cfg.backtestMaxHorizon != null) overrides.pulseMaxHorizon    = cfg.backtestMaxHorizon;
    if (cfg.backtestMinSurv    != null) overrides.pulseMinSurvival   = cfg.backtestMinSurv;
    if (cfg.backtestCalmMax    != null) overrides.pulseCalmMaxRatio  = cfg.backtestCalmMax;
    this.cfg      = { ...cfg, ...overrides };
    this.overrides = overrides;
    this.deriv    = deriv;                // authorised DerivClient
    this.analyzer = new ApexAnalyzer(this.cfg);
  }

  // A stub "market" for the analyzer. Uses barrier cache pre-populated
  // with a single (asset, growthRate) → live barrier row (per pass).
  _syntheticMarket(barrierCache) {
    return {
      getBarrier(sym, gr) { return barrierCache.get(`${sym}:${gr}`); },
    };
  }

  async run(symbol) {
    logger.info(`── APEX BACKTEST: ${symbol} ${this.cfg.backtestTicks} ticks ──`);
    if (Object.keys(this.overrides).length) {
      logger.info(`   overrides applied: ${JSON.stringify(this.overrides)}`);
    }
    logger.info(
      `   gates: edgeThresh=${this.cfg.pulseEdgeThreshold}  ` +
      `minEV=${this.cfg.pulseMinEV}  ` +
      `minSurv=${this.cfg.pulseMinSurvival}  ` +
      `maxHorizon=${this.cfg.pulseMaxHorizon}  ` +
      `calmMax=${this.cfg.pulseCalmMaxRatio}  ` +
      `spread=${this.cfg.pulseSpreadCost}`,
    );
    const mdm = this.deriv.market;

    logger.info('fetching historical ticks (batched)…');
    const ticks = await mdm.deepBackfill(
      symbol, this.cfg.backtestTicks, this.cfg.backtestBatchSize,
      (got, tot) => { if (got % 20000 < this.cfg.backtestBatchSize) logger.info(`  fetched ${got}/${tot}`); },
    );
    if (ticks.length < this.cfg.minTicksForAnalysis + 10) {
      throw new Error(`insufficient history for ${symbol}: got ${ticks.length}`);
    }
    logger.info(`have ${ticks.length} ticks (spans ${new Date(ticks[0].epoch*1000).toISOString()} → ${new Date(ticks[ticks.length-1].epoch*1000).toISOString()})`);

    // Barrier lookup for each growth rate (single live-refreshed value used
    // for the whole backtest; Deriv's barrier % is quite stable per asset).
    logger.info('fetching live barrier reference…');
    const barrierCache = new Map();
    await mdm.refreshBarriers([symbol], this.cfg.pulseGrowthRates);
    for (const gr of this.cfg.pulseGrowthRates) {
      const b = mdm.getBarrier(symbol, gr);
      if (b) {
        // Store WITHOUT anchor prices — the analyzer will derive
        // logBarrierHalf from halfBarrierPct in log-space per candle.
        barrierCache.set(`${symbol}:${gr}`, {
          halfBarrierPct: b.halfBarrierPct,
          highBarrier: 0, lowBarrier: 0, maxPayout: b.maxPayout,
        });
        logger.info(`  ${symbol} g=${(gr*100).toFixed(0)}% → ±${b.halfBarrierPct.toFixed(4)}%`);
      }
    }
    if (!barrierCache.size) throw new Error('no barrier data — cannot backtest');
    const market = this._syntheticMarket(barrierCache);

    // Walk history
    const stake     = this.cfg.stake;
    const spread    = this.cfg.pulseSpreadCost;
    const minWindow = Math.max(this.cfg.minTicksForAnalysis, this.cfg.apexHistoryWindow);
    const results   = {
      symbol,
      startEpoch: ticks[0].epoch,
      endEpoch  : ticks[ticks.length - 1].epoch,
      tickCount : ticks.length,
      signals   : 0,
      wins      : 0,
      losses    : 0,
      grossWin  : 0,
      grossLoss : 0,
      pnl       : 0,
      byGrowth  : {},
      byHold    : {},
      predictedSurvivalSum: 0, // running sum of predicted pN, to compare vs empirical WR
      predictedEVSum      : 0,
      spreadDrag          : 0,
    };
    for (const gr of this.cfg.pulseGrowthRates) results.byGrowth[gr] = { signals: 0, wins: 0, losses: 0, pnl: 0 };
    // APEX holds can reach the Boom/Vol hold caps, which exceed
    // pulseMaxHorizon; size the buckets to the largest possible hold.
    const maxHoldSeen = Math.max(this.cfg.pulseMaxHorizon,
                                 this.cfg.apexMaxHoldBoom || 0,
                                 this.cfg.apexMaxHoldVol  || 0);
    for (let n = 1; n <= maxHoldSeen; n++) results.byHold[n] = { signals: 0, wins: 0, losses: 0, pnl: 0 };
    this._maxHoldSeen = maxHoldSeen;

    // Loss-streak tracking (mirrors StatisticsManager's live behaviour).
    // We record every consecutive-loss "event" the first time the streak
    // reaches a given length, so x2/x3/... count non-overlapping events.
    const streak = {
      current      : 0,
      max          : 0,
      currentWin   : 0,
      maxWin       : 0,
      events       : { x2: 0, x3: 0, x4: 0, x5: 0, x6: 0, x7: 0, x8plus: 0 },
      lossSequences: [],   // full history of contiguous loss run lengths
      winSequences : [],   // full history of contiguous win  run lengths
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
        // A "streak of length N" is counted once when the run first
        // reaches N — matches how StatisticsManager reports x2/x3/x4.
        bumpEvent(streak.current);
      }
    };

    // Diagnostic counters — track WHY no signal fires.
    const diag = {
      scans        : 0,
      nullAnalysis : 0,
      rejEdge      : 0,
      rejEV        : 0,
      rejSurv      : 0,
      rejStormy    : 0,
      recommended  : 0,
      bestEdgeSeen : -Infinity,
      bestPNSeen   : 0,
      bestEVSeen   : -Infinity,
      calmScans    : 0,
      stormyScans  : 0,
      // Histogram buckets for edge distribution (calm scans only)
      edgeBuckets  : {
        '<0.98'      : 0,
        '0.98-0.99'  : 0,
        '0.99-1.00'  : 0,
        '1.00-1.01'  : 0,
        '1.01-1.02'  : 0,
        '1.02-1.03'  : 0,
        '1.03-1.05'  : 0,
        '1.05-1.10'  : 0,
        '>=1.10'     : 0,
      },
    };
    const bucketize = (edge) => {
      if (edge <  0.98) return '<0.98';
      if (edge <  0.99) return '0.98-0.99';
      if (edge <  1.00) return '0.99-1.00';
      if (edge <  1.01) return '1.00-1.01';
      if (edge <  1.02) return '1.01-1.02';
      if (edge <  1.03) return '1.02-1.03';
      if (edge <  1.05) return '1.03-1.05';
      if (edge <  1.10) return '1.05-1.10';
      return '>=1.10';
    };

    let i = minWindow;
    const step = Math.max(1, this.cfg.backtestStepEvery);
    const t0 = Date.now();

    while (i < ticks.length - (this._maxHoldSeen || this.cfg.pulseMaxHorizon) - 1) {
      const window   = ticks.slice(Math.max(0, i - this.cfg.apexHistoryWindow), i + 1);
      const analysis = this.analyzer.analyze(symbol, window, market, ticks[i].quote);
      diag.scans++;

      if (!analysis) {
        diag.nullAnalysis++;
        i += step;
        continue;
      }

      // Track best-of, and rejection reasons — even for non-recommends
      // so we can see how far off the gates are.
      if (analysis.calmOK) diag.calmScans++; else diag.stormyScans++;
      if (analysis.edge > diag.bestEdgeSeen) diag.bestEdgeSeen = analysis.edge;
      if (analysis.pN   > diag.bestPNSeen)   diag.bestPNSeen   = analysis.pN;
      if (analysis.ev   > diag.bestEVSeen)   diag.bestEVSeen   = analysis.ev;
      // Only bucketize calm scans — that's where an entry would even
      // be possible.
      if (analysis.calmOK) {
        diag.edgeBuckets[bucketize(analysis.edge)]++;
      }
      if (!analysis.recommend) {
        if (!analysis.edgeOK) diag.rejEdge++;
        if (!analysis.evOK)   diag.rejEV++;
        if (!analysis.survOK) diag.rejSurv++;
        if (!analysis.calmOK) diag.rejStormy++;
      } else {
        diag.recommended++;
      }

      if (analysis && analysis.recommend) {
        const N          = analysis.bestN;
        const g          = analysis.growthRate;
        const logHalf    = analysis.logBarrierHalf;

        // Simulate future path with the CORRECT per-tick barrier model:
        // the accumulator knocks out when a SINGLE tick's move (relative
        // to the immediately-preceding tick) exceeds the ± barrier — it
        // is not cumulative drift from entry.
        let knockedOut   = false;
        for (let k = 1; k <= N; k++) {
          const prev = ticks[i + k - 1].quote;
          const cur  = ticks[i + k].quote;
          if (prev <= 0 || cur <= 0) continue;
          const step = Math.abs(Math.log(cur / prev));
          if (step >= logHalf) { knockedOut = true; break; }
        }
        results.signals += 1;
        results.byGrowth[g].signals += 1;
        results.byHold[N].signals   += 1;
        results.predictedSurvivalSum += analysis.pN;
        results.predictedEVSum       += analysis.ev;

        if (knockedOut) {
          const loss = -stake;
          results.losses     += 1;
          results.grossLoss  += Math.abs(loss);
          results.pnl        += loss;
          results.byGrowth[g].losses += 1;
          results.byGrowth[g].pnl    += loss;
          results.byHold[N].losses   += 1;
          results.byHold[N].pnl      += loss;
          recordOutcome(false);
        } else {
          const gross = stake * (Math.pow(1 + g, N) - 1);
          const spreadCost = stake * spread;
          const net   = gross - spreadCost;
          results.wins      += 1;
          results.grossWin  += net;
          results.pnl       += net;
          results.spreadDrag += spreadCost;
          results.byGrowth[g].wins   += 1;
          results.byGrowth[g].pnl    += net;
          results.byHold[N].wins     += 1;
          results.byHold[N].pnl      += net;
          recordOutcome(true);
        }
        i += (N + 1);
      } else {
        i += step;
      }

      if (i % this.cfg.backtestReportEvery < step) {
        const wr = results.signals ? (results.wins / results.signals * 100).toFixed(1) : '0.0';
        logger.info(`  ...${i}/${ticks.length} signals=${results.signals} WR=${wr}% pnl=${results.pnl.toFixed(2)}`);
      }
    }

    // Flush trailing streak so the final run gets recorded.
    if (streak.current    > 0) streak.lossSequences.push(streak.current);
    if (streak.currentWin > 0) streak.winSequences.push(streak.currentWin);

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const empiricalWR = results.signals ? results.wins / results.signals * 100 : 0;
    const predictedWR = results.signals ? (results.predictedSurvivalSum / results.signals) * 100 : 0;
    const predictedEV = results.signals ? (results.predictedEVSum / results.signals) * 100 : 0;
    const realizedEV  = results.signals ? (results.pnl / (results.signals * stake)) * 100 : 0;

    // ── Consecutive-loss risk metrics ──────────────────────────────
    // avgLossRun / avgWinRun: mean run length (excludes zero-length runs)
    // p(≥N losses in a row) as % of all signals — probability estimate.
    const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
    const streakMetrics = {
      maxLossStreak : streak.max,
      maxWinStreak  : streak.maxWin,
      events        : streak.events,
      // Probability of experiencing at least a given loss-streak length,
      // as a fraction of total signals. Useful for sizing / drawdown.
      probAtLeast   : (() => {
        const total = results.signals || 1;
        return {
          x2: +((streak.events.x2 + streak.events.x3 + streak.events.x4 + streak.events.x5 + streak.events.x6 + streak.events.x7 + streak.events.x8plus) / total).toFixed(4),
          x3: +((streak.events.x3 + streak.events.x4 + streak.events.x5 + streak.events.x6 + streak.events.x7 + streak.events.x8plus) / total).toFixed(4),
          x4: +((streak.events.x4 + streak.events.x5 + streak.events.x6 + streak.events.x7 + streak.events.x8plus) / total).toFixed(4),
          x5: +((streak.events.x5 + streak.events.x6 + streak.events.x7 + streak.events.x8plus) / total).toFixed(4),
        };
      })(),
      avgLossRun    : +avg(streak.lossSequences).toFixed(2),
      avgWinRun     : +avg(streak.winSequences).toFixed(2),
      lossRuns      : streak.lossSequences.length,
      winRuns       : streak.winSequences.length,
      // Worst-case cash drawdown from the longest loss run at flat stake.
      maxDrawdownFlatStake: +(streak.max * stake).toFixed(2),
    };

    results.durationSec = +dt;
    results.empiricalWinRate  = +empiricalWR.toFixed(2);
    results.predictedSurvival = +predictedWR.toFixed(2);
    results.predictedEVPct    = +predictedEV.toFixed(3);
    results.realizedEVPct     = +realizedEV.toFixed(3);
    results.calibrationGap    = +(empiricalWR - predictedWR).toFixed(2);
    results.profitFactor      = results.grossLoss > 0 ? +(results.grossWin / results.grossLoss).toFixed(3) : Infinity;
    results.diagnostics       = diag;
    results.streaks           = streakMetrics;
    results.gatesUsed         = {
      pulseEdgeThreshold: this.cfg.pulseEdgeThreshold,
      pulseMinEV        : this.cfg.pulseMinEV,
      pulseMinSurvival  : this.cfg.pulseMinSurvival,
      pulseMaxHorizon   : this.cfg.pulseMaxHorizon,
      pulseCalmMaxRatio : this.cfg.pulseCalmMaxRatio,
      pulseSpreadCost   : this.cfg.pulseSpreadCost,
    };

    // Pretty summary
    const line = '─'.repeat(66);
    console.log('\n' + line);
    console.log(`  APEX BACKTEST REPORT — ${symbol}`);
    console.log(line);
    console.log(`  Window          : ${new Date(results.startEpoch*1000).toISOString().slice(0,19)}Z → ${new Date(results.endEpoch*1000).toISOString().slice(0,19)}Z`);
    console.log(`  Ticks processed : ${ticks.length.toLocaleString()}`);
    console.log(`  Signals fired   : ${results.signals}`);
    console.log(`  Wins / Losses   : ${results.wins} / ${results.losses}`);
    console.log(`  Empirical WR    : ${empiricalWR.toFixed(2)}%`);
    console.log(`  Predicted pN    : ${predictedWR.toFixed(2)}%   (gap ${(empiricalWR - predictedWR).toFixed(2)} pp)`);
    console.log(`  Predicted EV    : ${predictedEV.toFixed(3)}%   Realized EV: ${realizedEV.toFixed(3)}%`);
    console.log(`  Gross win / loss: +${results.grossWin.toFixed(2)} / -${results.grossLoss.toFixed(2)}`);
    console.log(`  Net P/L         : ${results.pnl >= 0 ? '+' : ''}${results.pnl.toFixed(2)} ${this.cfg.currency}`);
    console.log(`  Profit factor   : ${results.profitFactor === Infinity ? '∞' : results.profitFactor.toFixed(3)}`);
    console.log(`  Spread drag     : -${results.spreadDrag.toFixed(2)} ${this.cfg.currency}`);
    console.log(`  Runtime         : ${dt}s`);
    console.log(line);
    console.log('  Per-growth breakdown:');
    for (const gr of this.cfg.pulseGrowthRates) {
      const r = results.byGrowth[gr];
      const wr = r.signals ? (r.wins / r.signals * 100).toFixed(1) : '  - ';
      console.log(`    g=${(gr*100).toFixed(0)}%  signals=${String(r.signals).padStart(4)}  ` +
                  `WR=${wr}%  pnl=${(r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2)}`);
    }
    console.log('  Per-hold breakdown:');
    for (let n = 1; n <= (this._maxHoldSeen || this.cfg.pulseMaxHorizon); n++) {
      const r = results.byHold[n];
      const wr = r.signals ? (r.wins / r.signals * 100).toFixed(1) : '  - ';
      console.log(`    N=${n}   signals=${String(r.signals).padStart(4)}  ` +
                  `WR=${wr}%  pnl=${(r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2)}`);
    }

    // ── Consecutive-loss stats ────────────────────────────────────
    console.log(line);
    console.log('  Consecutive-loss stats (flat stake):');
    console.log(`    Max loss streak       : ${streakMetrics.maxLossStreak}  ` +
                `(worst drawdown at flat stake: -${streakMetrics.maxDrawdownFlatStake.toFixed(2)} ${this.cfg.currency})`);
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
    // Expected loss-streak length under an i.i.d. Bernoulli assumption
    // with the observed win rate — sanity-check the empirical streaks.
    if (results.signals > 0 && empiricalWR > 0 && empiricalWR < 100) {
      const q       = 1 - (empiricalWR / 100);         // loss probability
      const nTrades = results.signals;
      // Expected longest run of losses in n trials ≈ log_(1/q)(n·q)
      // (classical Erdős–Rényi / Schilling result for streaks).
      const expected = Math.log(nTrades * q) / Math.log(1 / q);
      console.log(`    Expected longest loss run (iid @ WR=${empiricalWR.toFixed(1)}%): ~${expected.toFixed(1)} in ${nTrades} trades`);
      if (streakMetrics.maxLossStreak > expected * 1.5) {
        console.log(`    ⚠ Observed max streak ${streakMetrics.maxLossStreak} >> expected — losses may be autocorrelated (regime clustering).`);
      }
    }

    // Diagnostic — shows why (almost) nothing fired, or what came closest.
    const bestEdgeStr = diag.bestEdgeSeen === -Infinity ? 'n/a' : diag.bestEdgeSeen.toFixed(4);
    const bestEVStr   = diag.bestEVSeen   === -Infinity ? 'n/a' : (diag.bestEVSeen*100).toFixed(3) + '%';
    console.log(line);
    console.log('  Diagnostics — why no/few signals fired:');
    console.log(`    scans             : ${diag.scans}`);
    console.log(`    null analyses     : ${diag.nullAnalysis}   (window too short)`);
    console.log(`    regime split      : calm ${diag.calmScans}  vs  stormy ${diag.stormyScans}`);
    console.log(`    recommend=true    : ${diag.recommended}`);
    console.log(`    rejected by edge  : ${diag.rejEdge}   (needed ≥ ${this.cfg.pulseEdgeThreshold})`);
    console.log(`    rejected by EV    : ${diag.rejEV}   (needed ≥ ${this.cfg.pulseMinEV})`);
    console.log(`    rejected by surv  : ${diag.rejSurv}   (needed pN ≥ ${this.cfg.pulseMinSurvival})`);
    console.log(`    rejected by regime: ${diag.rejStormy}   (calmMax ratio ${this.cfg.pulseCalmMaxRatio})`);
    console.log(`    best edge seen    : ${bestEdgeStr}   (threshold ${this.cfg.pulseEdgeThreshold})`);
    console.log(`    best pN seen      : ${(diag.bestPNSeen*100).toFixed(2)}%`);
    console.log(`    best EV seen      : ${bestEVStr}`);

    // Edge histogram (calm scans only) — this is the money chart. It
    // tells you the actual distribution of achievable edges, which is
    // the ONLY defensible way to pick a threshold.
    const calmTotal = Object.values(diag.edgeBuckets).reduce((a, b) => a + b, 0);
    if (calmTotal > 0) {
      console.log('');
      console.log('  Edge distribution (calm scans, spread-adjusted):');
      const maxBar   = 40;
      const maxCount = Math.max(...Object.values(diag.edgeBuckets));
      for (const [bucket, count] of Object.entries(diag.edgeBuckets)) {
        const pct  = (count / calmTotal * 100);
        const bars = maxCount > 0 ? Math.round((count / maxCount) * maxBar) : 0;
        console.log(`    ${bucket.padEnd(12)} ${String(count).padStart(6)}  ${pct.toFixed(1).padStart(5)}%  ${'█'.repeat(bars)}`);
      }
    }

    if (diag.recommended === 0 && diag.scans > 0) {
      console.log('');
      console.log('  💡 No signals fired. Suggestions:');
      if (diag.bestEdgeSeen !== -Infinity && diag.bestEdgeSeen < this.cfg.pulseEdgeThreshold) {
        const suggEdge = Math.max(1.005, diag.bestEdgeSeen - 0.005);
        const suggEV   = Math.max(0.005, (diag.bestEVSeen || 0) - 0.005);
        console.log(`     • Best net-of-spread edge observed: ${diag.bestEdgeSeen.toFixed(4)}`);
        console.log(`       PowerShell: $env:BACKTEST_EDGE=${suggEdge.toFixed(3)}; $env:BACKTEST_MIN_EV=${suggEV.toFixed(3)}`);
      }
      if (diag.stormyScans > diag.calmScans * 2) {
        console.log(`     • Regime was mostly non-calm (${diag.stormyScans}/${diag.scans}).`);
        console.log(`       PowerShell: $env:BACKTEST_CALM_MAX=1.20`);
      }
      if (this.cfg.pulseMaxHorizon <= 2) {
        console.log(`     • Try longer holds:  $env:BACKTEST_MAX_HORIZON=4`);
      }
      // Only warn about survival if it's actually the binding constraint.
      if (diag.bestPNSeen < this.cfg.pulseMinSurvival) {
        const suggSurv = Math.max(0.5, diag.bestPNSeen - 0.05);
        console.log(`     • Best survival observed: ${(diag.bestPNSeen*100).toFixed(1)}% (< ${(this.cfg.pulseMinSurvival*100).toFixed(0)}% floor).`);
        console.log(`       PowerShell: $env:BACKTEST_MIN_SURV=${suggSurv.toFixed(2)}`);
      }
    }
    console.log(line + '\n');

    try {
      fs.writeFileSync(this.cfg.backtestOutFile, JSON.stringify(results, null, 2));
      logger.info(`report written → ${this.cfg.backtestOutFile}`);
    } catch (e) {
      logger.warn(`could not write report: ${e.message}`);
    }
    return results;
  }

  // ── v3: Ensure WebSocket connection is alive ──────────────
  // Long backtests can cause the WS to timeout. This checks the
  // connection and reconnects if needed before each asset backtest.
  async _ensureConnected() {
    const deriv = this.deriv;
    if (deriv.connected && deriv.authorized) return; // all good

    logger.info('v3: reconnecting for next asset…');
    // Close existing connection cleanly
    try { deriv.ws?.close(); } catch (_) {}
    deriv.connected = false;
    deriv.authorized = false;

    // Reconnect and wait for authorization
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('reconnect timeout'));
      }, 30000);

      const onAuth = () => {
        clearTimeout(timeout);
        deriv.removeListener('error', onErr);
        logger.info('v3: reconnected ✔');
        resolve();
      };
      const onErr = (e) => {
        clearTimeout(timeout);
        deriv.removeListener('authorized', onAuth);
        reject(new Error(`reconnect failed: ${e.message}`));
      };

      deriv.once('authorized', onAuth);
      deriv.once('error', onErr);
      deriv.connect();
    });
  }

  // ── v3: Multi-asset backtest ──────────────────────────────
  // Runs backtest on every asset in cfg.assets and produces a combined
  // comparison report. Used with BACKTEST_ALL=1.
  async runAll() {
    const assets = this.cfg.assets;
    const allResults = [];
    const t0 = Date.now();

    console.log('\n' + '═'.repeat(70));
    console.log(`  APEX v3 MULTI-ASSET BACKTEST — ${assets.length} assets`);
    console.log('═'.repeat(70));
    console.log(`  Assets: ${assets.join(', ')}`);
    console.log(`  Ticks per asset: ${this.cfg.backtestTicks}`);
    console.log(`  Growth rates: ${this.cfg.pulseGrowthRates.map(g => (g*100).toFixed(0)+'%').join(', ')}`);
    console.log('═'.repeat(70) + '\n');

    for (let idx = 0; idx < assets.length; idx++) {
      const symbol = assets[idx];
      console.log(`\n[${idx + 1}/${assets.length}] ─── Backtesting ${symbol} ───`);
      try {
        // v3: Ensure connection is alive before each asset backtest.
        // Long backtests can cause the WebSocket to timeout.
        await this._ensureConnected();
        const result = await this.run(symbol);
        allResults.push(result);
      } catch (e) {
        console.error(`  ⚠ ${symbol} backtest failed: ${e.message}`);
        allResults.push({ symbol, error: e.message, signals: 0, wins: 0, losses: 0, pnl: 0 });
      }
    }

    const dt = ((Date.now() - t0) / 1000).toFixed(1);

    // ── Combined summary report ─────────────────────────────
    const line = '═'.repeat(70);
    console.log('\n' + line);
    console.log('  APEX v3 MULTI-ASSET BACKTEST — COMBINED SUMMARY');
    console.log(line);

    // Sort by P/L descending
    const valid = allResults.filter(r => !r.error && r.signals > 0);
    const errored = allResults.filter(r => r.error);
    const empty = allResults.filter(r => !r.error && r.signals === 0);

    valid.sort((a, b) => b.pnl - a.pnl);

    if (valid.length) {
      console.log('');
      console.log('  Profitable/Losing Assets (sorted by P/L):');
      console.log('  ' + '-'.repeat(66));
      console.log(
        '  ' +
        'Asset'.padEnd(14) +
        'Signals'.padStart(8) +
        'WR%'.padStart(8) +
        'P/L'.padStart(12) +
        'PF'.padStart(8) +
        'MaxDD'.padStart(10) +
        'PredWR%'.padStart(10)
      );
      console.log('  ' + '-'.repeat(66));

      let totalSignals = 0, totalWins = 0, totalLosses = 0;
      let totalPnl = 0, totalGrossWin = 0, totalGrossLoss = 0;

      for (const r of valid) {
        const wr = r.signals ? (r.wins / r.signals * 100).toFixed(1) : '0.0';
        const pf = r.profitFactor === Infinity ? '∞' : (r.profitFactor || 0).toFixed(2);
        const maxDD = r.streaks ? r.streaks.maxDrawdownFlatStake : 0;
        const predWR = r.predictedSurvival || 0;
        const pnlStr = r.pnl >= 0 ? `+${r.pnl.toFixed(2)}` : r.pnl.toFixed(2);

        console.log(
          '  ' +
          r.symbol.padEnd(14) +
          String(r.signals).padStart(8) +
          (wr + '%').padStart(8) +
          pnlStr.padStart(12) +
          pf.padStart(8) +
          (`-${maxDD.toFixed(0)}`).padStart(10) +
          (predWR.toFixed(1) + '%').padStart(10)
        );

        totalSignals += r.signals;
        totalWins += r.wins;
        totalLosses += r.losses;
        totalPnl += r.pnl;
        totalGrossWin += r.grossWin || 0;
        totalGrossLoss += r.grossLoss || 0;
      }

      console.log('  ' + '-'.repeat(66));
      const totalWR = totalSignals ? (totalWins / totalSignals * 100).toFixed(1) : '0.0';
      const totalPF = totalGrossLoss > 0 ? (totalGrossWin / totalGrossLoss).toFixed(2) : '∞';
      const totalPnlStr = totalPnl >= 0 ? `+${totalPnl.toFixed(2)}` : totalPnl.toFixed(2);
      console.log(
        '  ' +
        'TOTAL'.padEnd(14) +
        String(totalSignals).padStart(8) +
        (totalWR + '%').padStart(8) +
        totalPnlStr.padStart(12) +
        totalPF.padStart(8)
      );
    }

    if (empty.length) {
      console.log(`\n  Assets with no signals: ${empty.map(r => r.symbol).join(', ')}`);
    }
    if (errored.length) {
      console.log(`  Assets that errored: ${errored.map(r => `${r.symbol} (${r.error})`).join(', ')}`);
    }

    // ── Best opportunities ──────────────────────────────────
    if (valid.length >= 2) {
      console.log('');
      console.log('  Recommended portfolio allocation (by risk-adjusted return):');
      const ranked = valid
        .filter(r => r.pnl > 0)
        .sort((a, b) => {
          // Score = P/L * winRate * profitFactor (heuristic)
          const aScore = a.pnl * (a.empiricalWinRate / 100) * Math.min(a.profitFactor || 0, 5);
          const bScore = b.pnl * (b.empiricalWinRate / 100) * Math.min(b.profitFactor || 0, 5);
          return bScore - aScore;
        });
      for (let i = 0; i < Math.min(ranked.length, 5); i++) {
        const r = ranked[i];
        console.log(
          `    ${i + 1}. ${r.symbol} — P/L ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)} ` +
          `WR=${r.empiricalWinRate.toFixed(1)}% PF=${r.profitFactor === Infinity ? '∞' : (r.profitFactor || 0).toFixed(2)}`
        );
      }
    }

    console.log('');
    console.log(`  Total backtest time: ${dt}s`);
    console.log(line + '\n');

    // Write combined report
    try {
      const reportFile = this.cfg.backtestOutFile.replace('.json', '_all.json');
      fs.writeFileSync(reportFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        assets: allResults.map(r => ({
          symbol: r.symbol,
          signals: r.signals || 0,
          wins: r.wins || 0,
          losses: r.losses || 0,
          pnl: r.pnl || 0,
          winRate: r.empiricalWinRate || 0,
          profitFactor: r.profitFactor || 0,
          error: r.error || null,
        })),
      }, null, 2));
      logger.info(`combined report written → ${reportFile}`);
    } catch (e) {
      logger.warn(`could not write combined report: ${e.message}`);
    }

    return allResults;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 11. BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║ Deriv Accumulator Bot — APEX engine v3.0             ║');
  console.log('║ post-spike exploit • conditional-vol • EV-optimal    ║');
  console.log('║ v3: adaptive sizing • per-asset risk • auto-discover ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

async function main() {
  printBanner();
  try { require.resolve('ws'); }
  catch (_) {
    console.error('❌ The "ws" package is not installed.');
    console.error('   Run: npm install ws\n');
    process.exit(1);
  }
  if (!CONFIG.apiToken) {
    console.error('❌ DERIV_API_TOKEN is not set.\n');
    process.exit(1);
  }
  console.log(CONFIG.telegram.enabled ? '✅ Telegram notifications: ENABLED' : '⚠️  Telegram notifications: DISABLED');

  // ── Backtest mode ────────────────────────────────────────
  if (process.env.BACKTEST === '1' || process.argv.includes('--backtest')) {
    const runAll = process.env.BACKTEST_ALL === '1' || process.argv.includes('--backtest-all');
    const symbol = process.env.BACKTEST_ASSET || CONFIG.assets[0];

    if (runAll) {
      console.log(`🧪 BACKTEST ALL mode — ${CONFIG.assets.length} assets, ${CONFIG.backtestTicks} ticks each\n`);
    } else {
      console.log(`🧪 BACKTEST mode — symbol=${symbol} ticks=${CONFIG.backtestTicks}\n`);
    }

    const deriv = new DerivClient(CONFIG);
    // Minimal init — we need market data + authorization only.
    deriv.market   = new MarketDataManager(deriv, CONFIG);
    deriv.stats    = new StatisticsManager();
    deriv.on('authorized', async () => {
      try {
        const bt = new PulseBacktester(CONFIG, deriv);
        if (runAll) {
          await bt.runAll();
        } else {
          await bt.run(symbol);
        }
        deriv._stopped = true;
        try { deriv.ws?.close(); } catch (_) {}
        process.exit(0);
      } catch (e) {
        console.error('backtest failed:', e);
        process.exit(1);
      }
    });
    deriv.connect();
    return;
  }

  // ── Live trading mode ────────────────────────────────────
  const bot = new DerivClient(CONFIG);
  await bot.start();
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
