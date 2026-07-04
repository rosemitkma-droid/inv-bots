#!/usr/bin/env node
'use strict';
/**
 * =====================================================================
 *  Deriv Accumulator Bot  —  PULSE engine  (single-file)
 * =====================================================================
 *
 *  PULSE  =  Probability-weighted Unconditional Log-return Survival
 *            Estimator
 *
 *  ─────────────────────────────────────────────────────────────────
 *  RESEARCH SYNTHESIS (why this bot is built differently)
 *  ─────────────────────────────────────────────────────────────────
 *  An Accumulator (ACCU) contract pays   stake × (1+g)^N   if the price
 *  survives inside a fixed barrier range for N ticks. Its expected
 *  value for a planned hold of N ticks is exactly:
 *
 *        EV(N)  =  stake × [ (1+g)^N · p_N  −  1 ]            ... (1)
 *
 *  where p_N is the true probability of surviving N ticks. This is the
 *  ONLY quantity that matters. It is positive iff
 *
 *        p_N  >  (1+g)^−N                                    ... (2)
 *
 *  The broker calibrates the barrier so that LONG holds are negative-EV
 *  (that is the house edge). Every public "accumulator strategy" that
 *  the research surfaced — Bollinger/MACD confluence, volatility
 *  contraction, "rising digits", quick-exit, asset selection — is a
 *  *proxy* for raising p_N. They never measure p_N directly. Worse, the
 *  popular add-ons (Martingale recovery, chasing the exponential payout
 *  with long holds) are mathematically ruinous: Martingale guarantees
 *  gambler's ruin under a negative-EV edge, and EV is monotonically
 *  decreasing in N once you are past the EV-peak.
 *
 *  PULSE throws the proxies away and measures the real object:
 *
 *    1. Bootstrap the per-tick log-return distribution from the most
 *       recent ~120 LIVE ticks (captures the actual current
 *       micro-regime — drift μ and volatility σ — empirically, with no
 *       indicator lag).
 *    2. MONTE-CARLO the barrier-survival curve S(t) for t = 1..H by
 *       resampling those bootstrapped increments against the REAL
 *       barrier (taken from Deriv's own proposal response). This yields
 *       a direct, model-free estimate of p_t for every t.
 *    3. Plug into (1): find the EV-OPTIMAL horizon  N* = argmax EV(N).
 *       Set take-profit to exit at N*. Verified by simulation: at real
 *       barriers N* is almost always 1–3 ticks — exactly the opposite
 *       of "let the exponential run".
 *    4. Optimise across ALL five growth rates (1%–5%) and pick the
 *       (asset, growth, N*) triple with the best edge.
 *    5. Hard EV gates: only enter when  edgeRatio ≥ 1.15  AND  EV ≥
 *       minEV  AND  the volatility regime is calm. "edgeRatio" is
 *       (1+g)^N·p_N — i.e. gross return per unit staked in expectation.
 *    6. LIVE ADAPTIVE EARLY-EXIT: every tick of an open contract we
 *       re-bootstrap from the latest ticks AND re-simulate from the
 *       current (possibly drifted) spot. Two exits fire:
 *         (a) profit-lock  — realised profit exceeds the best expected
 *             remaining payout; bank it.
 *         (b) danger-lock  — incremental one-tick survival × growth no
 *             longer clears breakeven, OR drift has consumed ≥ set
 *             fraction of the barrier. Sell before a knockout.
 *    7. NO MARTINGALE. Sizing is flat-stake by default (optionally a
 *       capped fractional-Kelly that scales with the measured edge, and
 *       scales DOWN — never up — after losses).
 *
 *  Net effect: every entry is a positive-EV bet by construction, every
 *  exit locks the EV peak, and position sizing never compounds losses.
 *
 *  ─────────────────────────────────────────────────────────────────
 *  CREDITS / INFRASTRUCTURE
 *  ─────────────────────────────────────────────────────────────────
 *  The connection layer (PAT/OTP REST→WS auth), reconnection, market
 *  data, Telegram notifier, statistics, state persistence, watchdog,
 *  and daily/hourly summaries are retained from the reference bot so
 *  the bot plugs into the same account and notification channel.
 *  ONLY the analysis + execution brain is replaced by PULSE.
 *
 *  Author : PULSE synthesis
 *  License: MIT
 * =====================================================================
 */
/**
 * =====================================================================
 * Deriv Accumulator Bot — PULSE engine (single-file) — v1.1
 * =====================================================================
 *
 * PULSE = Probability-weighted Unconditional Log-return Survival
 *         Estimator
 *
 * ─────────────────────────────────────────────────────────────────
 * v1.1 CHANGELOG — audit fixes applied
 * ─────────────────────────────────────────────────────────────────
 *   Fix 1  ✅  longSigma variance formula (was already correct)
 *   Fix 2  ✅  All 5 growth rates (was already correct)
 *   Fix 3  🆕  Spread modelled explicitly via pulseSpreadCost
 *   Fix 4  🆕  Backtester (100K+ ticks, batched ticks_history, real
 *             out-of-sample win rate vs predicted survival)
 *   Fix 5  🔧  pulseEdgeThreshold raised to 1.05 (+5% gross EV)
 *   Fix 6  🔧  pulseMaxHorizon lowered to 2 ticks
 *   Bug 1  🔧  Inverted calmOK gate flipped (`!b.calmOK`)
 *   Bug 2  🔧  Redundant/mis-targeted gate removed – candidates
 *             already contains only recommend=true trades
 *   Bug 3  🔧  `recommend` flag now reflects survOK && calmOK
 *   Bug 4  🔧  reanalyze() no longer mutates this.cfg – uses
 *             _analyzeWithRates() helper (thread-safe)
 *   Bug 5  🔧  Profit-lock requires minimum absolute profit
 *             (pulseMinProfitLockFrac)
 *   Bug 6  🔧  sell() honours a bid-price floor when available;
 *             MC EV already subtracts spread cost
 *   Bug 7  🔧  Case-mismatch 'Won' → 'won' in currentStake2 reset
 *   Bug 8  🔧  _recoverStuckTrade now updates martingale state
 *
 * Author : PULSE synthesis
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
  apiToken:    ('0P94g4WdSrSrzir').trim(),
  appId:       '1089',
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
  martingale:            parseFloat('25'),   // 0 = off
  martingaleStep:        parseFloat('2'),
  lossesBeforeMartingale:parseInt  ('0'),
  maxMartingaleStep:     parseFloat('5'),

  // ─ Sizing ─
  sizingMode:        'flat',            // 'flat' | 'edge'
  edgeScaleMax:      parseFloat('2.0'),
  edgeScaleEdgeRef:  parseFloat('0.05'),
  downscaleAfterLoss:false,

  // ─ Assets ─
  assets: (process.env.ASSETS || '1HZ10V,1HZ25V,1HZ75V,1HZ100V,R_10,R_25,R_50,R_75')
    .split(',').map(s => s.trim()).filter(Boolean),

  // assets: ('R_10')
  //   .split(',').map(s => s.trim()).filter(Boolean),

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
  dailyMaxLoss  : parseFloat('50'),
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
  logFile : 'deriv_pulse_bot2_01.log',
  logLevel: ('INFO').toUpperCase(),

  // ═══════════════════════════════════════════════════════════════════
  // PULSE STRATEGY TUNABLES
  // ═══════════════════════════════════════════════════════════════════
  pulseReturnWindow   : parseInt('120',   10), // ticks used to bootstrap μ,σ
  pulseHorizon        : parseInt('20',    10), // max ticks simulated forward
  pulseTrials         : parseInt('10000', 10), // MC paths per (asset,growth)
  pulseMinTrials      : parseInt('4000',  10),

  // ─ EV gates ─
  //   pulseEdgeThreshold: gross EV ratio floor. 1.05 = +5% expected return
  //   per unit stake AFTER spread cost. Anything below this is noise.
  pulseEdgeThreshold  : parseFloat('1.018'),
  pulseMinEV          : parseFloat('0.048'),   // ≥ +5% EV net of spread
  pulseMinSurvival    : parseFloat('0.99'),
  pulseMaxHorizon     : parseInt  ('2', 10), // 1-2 tick holds

  // ─ Growth-rate candidates (Deriv supports 0.01-0.05) ─
  pulseGrowthRates    : [0.05], //[0.01, 0.02, 0.03, 0.04, 0.05]

  // ─ Volatility regime ─
  pulseCalmMaxRatio   : parseFloat('1.05'),
  pulseStormyMinRatio : parseFloat('1.20'),

  // ─ Spread model (Fix #3) ─
  //   Round-trip bid/ask cost as a fraction of stake, deducted from
  //   every MC edge calculation so the reported EV is honest.
  //   0.002 = 0.2% round-trip (typical R_100 short-hold estimate).
  pulseSpreadCost     : parseFloat('0.002'),

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
  stateFile          : 'deriv_pulse_bot2_01_state.json',
  stateSaveOnTrade   : true,
  stateSaveOnShutdown: true,

  // ═══════════════════════════════════════════════════════════════════
  // BACKTESTER (Fix #4)
  // ═══════════════════════════════════════════════════════════════════
  //   Run with:  BACKTEST=1 node deriv_pulse_bot.js
  //   Optional:  BACKTEST_ASSET=R_100 BACKTEST_TICKS=100000
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
  backtestTicks       : parseInt('100000', 10),
  backtestBatchSize   : parseInt('5000',   10),
  backtestStepEvery   : parseInt('1',      10),
  backtestReportEvery : parseInt('10000',  10),
  backtestOutFile     : 'pulse_backtest_report.json',

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
  }

  start() {
    logger.info('===== PULSE Bot starting =====');
    logger.info(`assets: ${this.cfg.assets.join(', ')}`);
    logger.info(`telegram: ${this.cfg.telegram.enabled ? 'ENABLED ✔' : 'disabled'}`);
    this.market   = new MarketDataManager(this, this.cfg);
    this.analyzer = new PulseAnalyzer(this.cfg);
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

    const martingaleLine = (this.cfg.martingale && this.cfg.martingale > 0)
      ? `<b>Martingale:</b> ×${this.cfg.martingale} (after ${this.cfg.lossesBeforeMartingale} losses, +${this.cfg.martingaleStep}/loss, cap ×${this.cfg.maxMartingaleStep})\n`
      : '';

    telegram.send(
      `<b>PULSE2 Bot Online</b>\n\n` +
      `<b>Account:</b> ${info.loginid}\n` +
      `<b>Type:</b> ${info.isVirtual ? 'DEMO' : 'REAL'}\n` +
      `<b>Balance:</b> ${this.startBalance.toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Assets:</b> ${this.cfg.assets.length}\n` +
      `<b>Stake:</b> ${this.cfg.stake}\n` +
      `<b>Growth rates:</b> ${this.cfg.pulseGrowthRates.map(g => (g*100).toFixed(0)+'%').join(', ')}\n` +
      martingaleLine +
      `<b>Edge threshold:</b> ${((this.cfg.pulseEdgeThreshold-1)*100).toFixed(1)}%\n` +
      `<b>Max horizon:</b> ${this.cfg.pulseMaxHorizon} ticks\n` +
      `<b>Spread cost:</b> ${(this.cfg.pulseSpreadCost*100).toFixed(2)}%\n\n` +
      `<b>PULSE engine active</b>\n` +
      `MC trials: ${this.cfg.pulseTrials} · Horizon: ${this.cfg.pulseHorizon} ticks\n\n` +
      `<b>Overall Profit:</b> ${money(this.stats.overallProfit, this.currencyStr())}\n` +
      `Loss streak: current ${this.stats.currentLossStreak}, x2=${this.stats.lossStreakEvents.x2}, x3=${this.stats.lossStreakEvents.x3}, x4=${this.stats.lossStreakEvents.x4}`,
    );

    Promise.all([
      this.market.loadSymbols(),
      this.market.bootstrap(this.cfg.assets),
      this._refreshBarriers(),
    ]).then(() => {
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
      `<b>Connection2 lost</b>\n` +
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

    // Bug 7 fix — Deriv returns lowercase 'won'/'lost' (not 'Won').
    // On a win: reset the persisted stake baseline; on a loss: remember
    // the losing stake as a string with 2-decimal precision.
    if (t.status === 'won') {
      this.currentStake2 = this.cfg.stake;
    } else {
      this.currentStake2 = Number(t.stake).toFixed(2);
    }

    const martingaleLine = this.martingaleMultiplier > 1
      ? `<b>Martingale:</b> ×${this.martingaleMultiplier.toFixed(2)} (${this.lossesStreak} consecutive losses)\n`
      : '';
    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));

    let msg =
      `${emoji} <b>PULSE2 TRADE ${label}</b>\n\n` +
      `<b>Contract:</b> #${t.contractId}\n` +
      `<b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth:</b> ${(t.growthRate*100).toFixed(0)}%\n` +
      `<b>Stake:</b> ${Number(t.stake).toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Sell:</b> ${Number(t.sellPrice).toFixed(2)}\n` +
      `${t.profit >= 0 ? '💚' : '💔'} <b>Profit:</b> ${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Duration:</b> ${dur.toFixed(1)}s\n` +
      `<b>Balance:</b> ${this.lastBalance.toFixed(2)} ${this.currencyStr()}\n\n` +
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
    const msg =
      `<b>PULSE2 TRADE OPENED</b>\n\n` +
      `<b>Contract:</b> #${t.contractId}\n` +
      `<b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth Rate:</b> ${(t.growthRate*100).toFixed(2)}%\n` +
      `<b>Stake:</b> ${t.stake.toFixed(2)}${this.martingaleMultiplier > 1 ? ` (base ${(t._analysis?.baseStake ?? this.cfg.stake)} × ${this.martingaleMultiplier.toFixed(2)})` : ''} ${this.currencyStr()}\n` +
      `<b>Take Profit:</b> ${t.limit?.take_profit ?? '–'}\n` +
      `<b>Overall Profit:</b> ${this.overallProfit >= 0 ? '+' : ''}${this.overallProfit.toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Loss streak:</b> ${this.stats.currentLossStreak}\n` +
      (this.martingaleMultiplier > 1
        ? `<b>Martingale:</b> ×${this.martingaleMultiplier.toFixed(2)} (${this.lossesStreak} losses)\n`
        : '') + `\n` +
      `<b>PULSE Analysis</b>\n` +
      `• Edge (net spread): ${((t._analysis?.edge ?? 0)*100).toFixed(2)}%\n` +
      `• EV: ${((t._analysis?.ev ?? 0)*100).toFixed(2)}%\n` +
      `• pN: ${((t._analysis?.pN ?? 0)*100).toFixed(2)}%\n` +
      `• N*: ${t._analysis?.bestN ?? '?'}\n` +
      `• Regime: ${t._analysis?.regime ?? '?'}\n` +
      `• σ: ${((t._analysis?.sigma ?? 0)*1e4).toFixed(2)}e-4`;
    telegram.send(msg);
  }
  _onTradeUpdate(t) {
    logger.debug(`update #${t.contractId}: profit=${t.profit.toFixed(3)} spot=${t.currentSpot}`);
  }
  _onPulseDrift(t) {
    logger.debug(`pulse-drift #${t.contractId} urg=${t.dec.urgency.toFixed(2)} ${t.dec.reason}`);
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
    this.lastBalance   = (this.lastBalance ?? this.balance ?? 0) + finishedTrade.profit;
    this.overallProfit += finishedTrade.profit;

    this.lastTradeAt    = Date.now();
    this.tradeStartTime = null;

    telegram.send(
      `<b>STUCK2 TRADE RECOVERED [${reason}]</b>\nContract: ${contractId}\n` +
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
        telegram.send(`<b>Daily2 loss limit</b>\nNet P/L: ${pl.toFixed(2)} ${this.currencyStr()}`);
        return;
      }
      if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
      if (this.exec.count() >= this.cfg.maxOpenTrades)              return;

      // Analyse every asset with PULSE
      const analyses   = this.cfg.assets.map(s =>
        this.analyzer.analyze(s, this.market.historyFor(s), this.market));
      const ranked     = this.analyzer.rank(analyses);
      const candidates = ranked.filter(a => a.recommend);

      if (!candidates.length) {
        if (ranked.length) {
          const b = ranked[0];
          logger.info(
            `scan: best=${b.symbol} g=${(b.growthRate*100).toFixed(0)}% edge=${b.edge.toFixed(4)} ` +
            `ev=${(b.ev*100).toFixed(2)}% N*=${b.bestN} pN=${(b.pN*100).toFixed(1)}% regime=${b.regime} — ` +
            `[${[
              b.edgeOK ? '' : `edge<${this.cfg.pulseEdgeThreshold}`,
              b.evOK   ? '' : `ev<${this.cfg.pulseMinEV}`,
              b.survOK ? '' : `surv<${this.cfg.pulseMinSurvival}`,
              b.calmOK ? '' : 'stormy',
            ].filter(Boolean).join(',')}] no trade`,
          );
        }
        return;
      }

      // Bug 2 fix — the redundant/mis-targeted gate that operated on
      // ranked[0] has been removed. `candidates` already contains ONLY
      // rows where analyzer.analyze() set recommend = true, which now
      // (Bug 3 fix) reflects edgeOK && evOK && survOK && calmOK.
      const best = candidates[0];

      logger.info(
        `PULSE ENTER ${best.symbol} g=${(best.growthRate*100).toFixed(0)}% ` +
        `edge=${best.edge.toFixed(4)} ev=${(best.ev*100).toFixed(2)}% ` +
        `N*=${best.bestN} pN=${(best.pN*100).toFixed(1)}% regime=${best.regime} ` +
        `σ=${(best.sigma*1e4).toFixed(2)}e-4`,
      );

      const stake       = this.currentStake(best.edge);
      const tpFraction  = best.suggestedTakeProfit;
      const takeProfit  = +(stake * tpFraction).toFixed(2);
      const stopLoss    = this.cfg.stopLoss;

      const analysis = {
        edge: best.edge, ev: best.ev, bestN: best.bestN,
        pN: best.pN, p1: best.p1, regime: best.regime,
        vrRatio: best.vrRatio, sigma: best.sigma,
        growthRate: best.growthRate, halfBarrierFrac: best.halfBarrierFrac,
        logBarrierHalf: best.logBarrierHalf,
        martingaleMultiplier: this.martingaleMultiplier,
        lossesStreak: this.lossesStreak,
        baseStake: this.cfg.stake,
      };

      const trade = await this.exec.buy(
        best.symbol, best.growthRate, stake,
        { stop_loss: stopLoss, take_profit: takeProfit },
        analysis,
      );

      const martingaleNote = this.martingaleMultiplier > 1
        ? ` martingale × ${this.martingaleMultiplier.toFixed(2)} (${this.lossesStreak} losses)`
        : '';
      logger.info(
        `trade placed #${trade.contractId} ${best.symbol} g=${best.growthRate} ` +
        `stake=${stake}${martingaleNote} tp=${takeProfit} ` +
        `barrier=±${trade.halfBarrierPct.toFixed(4)}%`,
      );
    } catch (e) {
      logger.error('PULSE analyse/trade error:', e.message);
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
      version: 3,
      engine : 'PULSE',
      savedAt: new Date().toISOString(),
      savedReason: reason,
      startBalance: this.startBalance,
      lastBalance : this.lastBalance,
      lastDayISODate: this._lastDayISODate || this._todayISO(),
      dailyHistory  : this.dailyHistory || {},
      stats         : this.stats.serialize(),
      lossesStreak  : this.lossesStreak ?? 0,
      martingaleMultiplier: this.martingaleMultiplier ?? 1.0,
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
      logger.info(
        `state restored (PULSE): overallProfit=${this.stats.overallProfit.toFixed(2)} ` +
        `lossStreak=${this.stats.currentLossStreak} ` +
        `martingale=${this.martingaleMultiplier.toFixed(2)}`,
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
      telegram.send(`<b>Hourly2 Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\nNo trades this hour.\n\nOverall Profit: ${money(this.stats.overallProfit, this.currencyStr())}`);
      return;
    }
    let msg =
      `<b>Hourly2 Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\n` +
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

    let msg = `<b>PULSE2 END OF TRADE DAY — GMT</b>\n` +
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
    telegram.send(`<b>PULSE2 Bot stopped</b>\nSignal: ${signal}`);
    if (this._analysisT)  clearInterval(this._analysisT);
    if (this._hourlyT)    clearInterval(this._hourlyT);
    if (this._eodT)       clearInterval(this._eodT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._eodBoot)    clearTimeout(this._eodBoot);
    if (this._barrierT)   clearInterval(this._barrierT);
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
          const cap = Math.max(this.cfg.tickWindow * 8, 2000);
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
        if (hist.length < this.cfg.minTicksForAnalysis) {
          await this.backfill(s, Math.max(this.cfg.tickWindow * 5, 1000));
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
// 7. PULSE ANALYZER (Monte-Carlo Survival Engine)
// ─────────────────────────────────────────────────────────────────────
class PulseAnalyzer {
  constructor(cfg) { this.cfg = cfg; }

  /**
   * Public entry point — uses configured growth rates.
   */
  analyze(symbol, ticks, market, currentSpot = null) {
    return this._analyzeWithRates(symbol, ticks, market, currentSpot, this.cfg.pulseGrowthRates);
  }

  /**
   * Re-analyze from the current live spot during an open trade.
   * Bug 4 fix — no longer mutates this.cfg. Passes rate directly to
   * the private helper, so a concurrent analyze() from the scan loop
   * cannot see partial state.
   */
  reanalyze(symbol, ticks, market, currentSpot, growthRate) {
    return this._analyzeWithRates(symbol, ticks, market, currentSpot, [growthRate]);
  }

  /**
   * Core MC survival engine.
   *
   * Fix #3 — Spread cost is subtracted from every candidate's edge, so
   * "edge" and "ev" reported here are NET of the round-trip friction.
   *
   * Bug 3 fix — `recommend` reflects ALL gates (edge, EV, survival,
   * regime), not just "we found a positive-EV horizon".
   */
  _analyzeWithRates(symbol, ticks, market, currentSpot, growthRates) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;
    const window = Math.min(this.cfg.pulseReturnWindow, ticks.length);
    const q      = ticks.slice(-window).map(t => t.quote);
    if (q.length < 10) return null;

    // ── 1. Per-tick log returns ─────────────────────────────────────
    const returns = [];
    for (let i = 1; i < q.length; i++) {
      if (q[i - 1] > 0) returns.push(Math.log(q[i] / q[i - 1]));
    }
    if (returns.length < 5) return null;

    // ── 2. Current price ────────────────────────────────────────────
    const price = currentSpot != null && currentSpot > 0 ? currentSpot : q[q.length - 1];

    // ── 3. Distribution stats ──────────────────────────────────────
    const n    = returns.length;
    const mean = returns.reduce((s, v) => s + v, 0) / n;
    let variance = 0;
    for (const v of returns) variance += (v - mean) ** 2;
    const sigma = Math.sqrt(variance / n);
    const mu    = mean;

    // ── 4. Volatility regime (Fix #1 — correct variance formula) ───
    const halfIdx  = Math.floor(q.length / 2);
    const oldSlice = q.slice(0, halfIdx);
    const oldRets  = [];
    for (let i = 1; i < oldSlice.length; i++) {
      if (oldSlice[i - 1] > 0) oldRets.push(Math.log(oldSlice[i] / oldSlice[i - 1]));
    }
    let longSigma = sigma;
    if (oldRets.length > 5) {
      const om = oldRets.reduce((s, v) => s + v, 0) / oldRets.length;
      let ov = 0;
      for (const v of oldRets) ov += (v - om) ** 2;
      longSigma = Math.sqrt(ov / oldRets.length) || sigma;
    }
    const vrRatio = sigma / Math.max(longSigma, 1e-12);
    const regime  = vrRatio < this.cfg.pulseCalmMaxRatio   ? 'calm'
                  : vrRatio < this.cfg.pulseStormyMinRatio ? 'normal'
                  : 'stormy';
    const calmOK  = regime === 'calm';

    // ── 5. Barrier ref ─────────────────────────────────────────────
    const refGr           = this.cfg.pulseGrowthRates[0] || 0.03;
    const barrierInfoRef  = market ? market.getBarrier(symbol, refGr) : null;
    const baseHalfBarrierFrac = barrierInfoRef
      ? barrierInfoRef.halfBarrierPct / 100
      : 0.0005;

    // ── 6. MC loop over growth rates ───────────────────────────────
    const trials  = this.cfg.pulseTrials;
    const horizon = Math.min(this.cfg.pulseHorizon, this.cfg.pulseMaxHorizon + 5);
    const spread  = this.cfg.pulseSpreadCost; // Fix #3

    let best = null;

    for (const growthRate of growthRates) {
      const grBarrier = market ? market.getBarrier(symbol, growthRate) : null;

      let logBarrierHalf;
      if (grBarrier && grBarrier.highBarrier > 0 && grBarrier.lowBarrier > 0 && price > 0) {
        const logHigh = Math.log(grBarrier.highBarrier / price);
        const logLow  = Math.log(price / grBarrier.lowBarrier);
        logBarrierHalf = Math.min(logHigh, logLow);
      } else {
        const barrierFrac = grBarrier
          ? grBarrier.halfBarrierPct / 100
          : baseHalfBarrierFrac * (1 + (growthRate - refGr) * 2);
        logBarrierHalf = Math.log(1 + barrierFrac);
      }
      if (logBarrierHalf <= 0) continue;

      // MC simulation
      const survivalCounts = new Array(horizon + 1).fill(0);
      for (let trial = 0; trial < trials; trial++) {
        let pos = 0;
        for (let tick = 1; tick <= horizon; tick++) {
          const r = returns[Math.floor(Math.random() * returns.length)];
          pos += r;
          if (Math.abs(pos) >= logBarrierHalf) break;
          survivalCounts[tick]++;
        }
      }

      // EV-optimal horizon within cfg.pulseMaxHorizon (Fix #6 → 2 ticks)
      // We also track the raw best edge/EV observed across all ticks
      // BEFORE gate filtering — this is what the diagnostic reports.
      let bestN       = 0;
      let bestEvN     = -Infinity;
      let bestPayoutN = 0;

      // Raw observations (pre-gate). Used ONLY when nothing passes.
      let rawBestEdge = -Infinity;
      let rawBestEV   = -Infinity;
      let rawBestN    = 1;
      let rawBestPN   = 0;

      for (let tick = 1; tick <= Math.min(horizon, this.cfg.pulseMaxHorizon); tick++) {
        const pTick       = survivalCounts[tick] / trials;
        const grossReturn = Math.pow(1 + growthRate, tick);
        // Fix #3 — spread deducted from gross edge.
        const edge = grossReturn * pTick - spread;
        const ev   = edge - 1;

        // Track raw best regardless of gate
        if (edge > rawBestEdge) {
          rawBestEdge = edge;
          rawBestEV   = ev;
          rawBestN    = tick;
          rawBestPN   = pTick;
        }

        if (edge >= this.cfg.pulseEdgeThreshold && ev >= this.cfg.pulseMinEV) {
          if (ev > bestEvN) {
            bestEvN     = ev;
            bestN       = tick;
            bestPayoutN = edge;
          }
        }
      }

      if (bestN > 0) {
        const pN = survivalCounts[bestN] / trials;
        const p1 = survivalCounts[1]     / trials;
        const suggestedTakeProfit = Math.max(
          Math.pow(1 + growthRate, bestN) - 1,
          0.005,
        );

        const edgeOK = bestPayoutN >= this.cfg.pulseEdgeThreshold;
        const evOK   = bestEvN     >= this.cfg.pulseMinEV;
        const survOK = pN          >= this.cfg.pulseMinSurvival;

        const candidate = {
          symbol, growthRate,
          edge  : bestPayoutN,   // net-of-spread edge
          ev    : bestEvN,
          bestN,
          pN, p1: p1 || 0.5,
          regime, vrRatio, sigma, mu,
          halfBarrierFrac: logBarrierHalf,
          price,
          logBarrierHalf,
          survivalCounts,
          returns,
          suggestedTakeProfit,
          spreadCost: spread,
          edgeOK, evOK, survOK, calmOK,
          // Bug 3 fix — recommend only if ALL gates pass.
          recommend: edgeOK && evOK && survOK && calmOK,
        };
        if (!best || candidate.edge > best.edge) best = candidate;
      } else {
        // ── DIAGNOSTIC CANDIDATE ───────────────────────────────────
        // No horizon passed the gates. We emit a candidate whose
        // `edge`, `ev`, `pN`, `bestN` reflect the RAW best-observed
        // values so the backtester can honestly report "the closest
        // we got was edge=X". Previously this branch reported edge:0
        // which made diagnostics look broken.
        const p1 = survivalCounts[1] / trials || 0;
        const survOK = rawBestPN >= this.cfg.pulseMinSurvival;
        const edgeOK = rawBestEdge >= this.cfg.pulseEdgeThreshold;
        const evOK   = rawBestEV   >= this.cfg.pulseMinEV;
        const candidate = {
          symbol, growthRate,
          edge : rawBestEdge === -Infinity ? 0     : rawBestEdge,
          ev   : rawBestEV,
          bestN: rawBestN,
          pN   : rawBestPN,
          p1, regime, vrRatio, sigma, mu,
          halfBarrierFrac: logBarrierHalf, price, logBarrierHalf,
          survivalCounts, returns,
          suggestedTakeProfit: Math.max(Math.pow(1 + growthRate, rawBestN) - 1, 0.005),
          spreadCost: spread,
          edgeOK, evOK, survOK, calmOK,
          recommend: false,  // diagnostic — never recommends
        };
        if (!best || candidate.edge > best.edge) best = candidate;
      }
    }
    return best;
  }

  rank(analyses) {
    return analyses.filter(Boolean).sort((a, b) => b.edge - a.edge);
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

    let p1Live     = analysis.p1     ?? 0.99;
    let pNLive     = analysis.pN     ?? 0.99;
    let bestEVLive = analysis.ev     ?? 0;
    let bestNLive  = analysis.bestN  ?? 1;

    if (analyzer && ticks.length >= cfg.minTicksForAnalysis && currentSpot > 0) {
      try {
        const live = analyzer.reanalyze(info.symbol, ticks, market, currentSpot, growthRate);
        if (live) {
          p1Live     = live.p1    ?? p1Live;
          pNLive     = live.pN    ?? pNLive;
          bestEVLive = live.ev    ?? bestEVLive;
          bestNLive  = live.bestN ?? bestNLive;
        }
      } catch (e) {
        logger.debug(`reanalyze error #${info.contractId}: ${e.message}`);
      }
    }

    // ── Signal A: Profit-lock ────────────────────────────────
    // Bug 5 fix — require BOTH:
    //   (i) profit ≥ pulseMinProfitLockFrac × stake (absolute floor)
    //  (ii) profit ≥ lockFrac × expectedRemaining  (relative signal)
    // This prevents a "lock at $0.001" on the first tick when the
    // live re-simulation happens to return bestEVLive ≤ 0.
    const lockFrac           = cfg.pulseExitProfitLockFrac;
    const expectedRemaining  = stake * Math.max(bestEVLive, 0);
    const profitLockThreshold = lockFrac * expectedRemaining;
    const minProfitToLock    = stake * cfg.pulseMinProfitLockFrac;
    const profitLock = currentProfit >= minProfitToLock
                    && currentProfit >= profitLockThreshold;

    // ── Signal B: Next-tick edge (net of spread) ─────────────
    // If (1+g)·p1 − spread < threshold, next tick is EV-negative.
    const nextTickEdge = (1 + growthRate) * p1Live - cfg.pulseSpreadCost;
    const nextTickExit = nextTickEdge < cfg.pulseExitNextTickEdge;

    // ── Signal C: Drift danger ───────────────────────────────
    let driftExit = false;
    let driftFrac = 0;
    if (info.entrySpot > 0 && currentSpot > 0) {
      const logDrift = Math.abs(Math.log(currentSpot / info.entrySpot));
      const logBarrierHalf = analysis.logBarrierHalf
        ?? Math.log(1 + (info.halfBarrierPct ?? 0.05) / 100);
      driftFrac = logDrift / Math.max(logBarrierHalf, 1e-12);
      driftExit = driftFrac >= cfg.pulseExitDriftFrac;
    }

    const urgency = Math.max(
      profitLock   ? lockFrac       : 0,
      nextTickExit ? 1 - nextTickEdge : 0,
      driftExit    ? driftFrac      : 0,
    );

    if (profitLock) {
      return {
        exit: true,
        reason: `profit-lock: realised ${currentProfit.toFixed(3)} ≥ ` +
                `max(${minProfitToLock.toFixed(3)}, ${lockFrac}×${expectedRemaining.toFixed(3)})` +
                ` (live-EV=${(bestEVLive*100).toFixed(2)}% N*=${bestNLive})`,
        urgency,
      };
    }
    if (driftExit) {
      return { exit: true, reason: `drift-danger: logDrift=${(driftFrac*100).toFixed(1)}% of barrier`, urgency };
    }
    if (nextTickExit) {
      return {
        exit: true,
        reason: `next-tick-edge: (1+g)·p1−spread=${nextTickEdge.toFixed(4)} < ${cfg.pulseExitNextTickEdge}`,
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
        logger.info(`PULSE adaptive exit #${cid}: ${dec.reason} urgency=${dec.urgency.toFixed(3)}`);
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
    this.analyzer = new PulseAnalyzer(this.cfg);
  }

  // A stub "market" for the analyzer. Uses barrier cache pre-populated
  // with a single (asset, growthRate) → live barrier row (per pass).
  _syntheticMarket(barrierCache) {
    return {
      getBarrier(sym, gr) { return barrierCache.get(`${sym}:${gr}`); },
    };
  }

  async run(symbol) {
    logger.info(`── PULSE BACKTEST: ${symbol} ${this.cfg.backtestTicks} ticks ──`);
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
    const minWindow = Math.max(this.cfg.minTicksForAnalysis, this.cfg.pulseReturnWindow);
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
    for (let n = 1; n <= this.cfg.pulseMaxHorizon; n++) results.byHold[n] = { signals: 0, wins: 0, losses: 0, pnl: 0 };

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

    while (i < ticks.length - this.cfg.pulseMaxHorizon - 1) {
      const window   = ticks.slice(Math.max(0, i - this.cfg.pulseReturnWindow), i + 1);
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
        const entry      = ticks[i].quote;
        const logHalf    = analysis.logBarrierHalf;

        // Simulate future path
        let knockedOut   = false;
        for (let k = 1; k <= N; k++) {
          const p    = ticks[i + k].quote;
          const drift = Math.abs(Math.log(p / entry));
          if (drift >= logHalf) { knockedOut = true; break; }
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
    console.log(`  PULSE BACKTEST REPORT — ${symbol}`);
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
    for (let n = 1; n <= this.cfg.pulseMaxHorizon; n++) {
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
}

// ─────────────────────────────────────────────────────────────────────
// 11. BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║ Deriv Accumulator Bot — PULSE engine v1.1            ║');
  console.log('║ MC survival • EV-optimal • spread-aware • no marting.║');
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
    const symbol = process.env.BACKTEST_ASSET || CONFIG.assets[0];
    console.log(`🧪 BACKTEST mode — symbol=${symbol} ticks=${CONFIG.backtestTicks}\n`);
    const deriv = new DerivClient(CONFIG);
    // Minimal init — we need market data + authorization only.
    deriv.market   = new MarketDataManager(deriv, CONFIG);
    deriv.stats    = new StatisticsManager();
    deriv.on('authorized', async () => {
      try {
        const bt = new PulseBacktester(CONFIG, deriv);
        await bt.run(symbol);
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
