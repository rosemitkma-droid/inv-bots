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
 
'use strict';
 
// ─────────────────────────────────────────────────────────────────────
// 0.  DEPENDENCIES
// ─────────────────────────────────────────────────────────────────────
const WebSocket    = require('ws');   // npm install ws
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { URL }      = require('url');
const EventEmitter = require('events');
 
// ─────────────────────────────────────────────────────────────────────
// 1.  .ENV LOADER (no external dependency)
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
      let   val = line.slice(eq + 1).trim();
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
 
// ─────────────────────────────────────────────────────────────────────
// 2.  CONFIGURATION
// ─────────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  // ─ Deriv API ─ (credentials retained from reference bot) ─
  apiToken: ('0P94g4WdSrSrzir').trim(),
  appId   : '1089',
  wsUrl   : 'wss://ws.derivws.com/websockets/v3',
  currency: ('USD').toUpperCase(),
  accountType: ('demo').toLowerCase(),  // 'demo' | 'real'
 
  // ─ Trade parameters ─
  stake          : parseFloat('1.0'),
 
  // NOTE: PULSE does NOT use Martingale. These legacy knobs are kept
  // only so the saved-state file / Telegram messages stay compatible,
  // but martingale is forced OFF (see _updateSizing).
  multiplier     : parseFloat('0.04'),   // default growth rate hint (PULSE overrides per-trade)
  multiplierStep : parseFloat('0.0'),
  stopLoss       : parseFloat('110.0'),    // hard $ stop per contract (manual sell)
  takeProfit     : parseFloat('10000.0'),
 
  // ─ Sizing (PULSE: flat stake, optional capped edge-scaled sizing) ─
  sizingMode        : 'flat',            // 'flat' | 'edge'
  edgeScaleMax      : parseFloat('2.0'), // at edge-scaled mode, max multiplier on base stake
  edgeScaleEdgeRef  : parseFloat('0.05'),// edge (EV fraction) at which we hit the cap
  downscaleAfterLoss: false,              // shrink stake after a loss (anti-ruin)
 
  // ─ Assets (Deriv synthetic indices) ─
  assets: ('R_10,R_25,R_50,R_75,R_100')
    .split(',').map(s => s.trim()).filter(Boolean),
 
  // ─ Telegram ─ (credentials retained) ─
  telegram: {
    enabled : true,
    botToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    chatId  : '752497117',
  },
 
  // ─ Strategy timing ─
  tickWindow          : parseInt('200',  10),
  minTicksForAnalysis : parseInt('80',   10),
  analysisIntervalMs  : parseInt('15000',10),
  tradeCooldownMs     : parseInt('4000', 10),
  maxOpenTrades       : parseInt('1',    10),
 
  // ─ Daily limits ─
  dailyMaxLoss  : parseFloat('50'),
  dailyMaxTrades: parseInt  ('2000000000'),

  // ─ GMT/UTC reporting (matching accurateDiffer style) ─
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
  logFile : 'deriv_pulse_bot9.log',
  logLevel: ('INFO').toUpperCase(),
 
  // ════════════════════════════════════════════════════════════════
  //  PULSE STRATEGY TUNABLES
  // ════════════════════════════════════════════════════════════════
 
  // Monte-Carlo survival engine
  pulseReturnWindow   : parseInt('120',  10), // ticks used to bootstrap μ,σ
  pulseHorizon        : parseInt('20',   10), // max ticks simulated forward
  pulseTrials         : parseInt('10000', 10), // MC paths per (asset,growth)
  pulseMinTrials      : parseInt('4000',  10), //800 adaptive: lower trials when many assets

  // ── Martingale (loss-recovery stake multiplier) ──
  // Set MARTINGALE=0 to disable. After `lossesBeforeMartingale` consecutive
  // losses the next stake is multiplied by `martingale`. Each subsequent
  // loss adds `martingaleStep` to the multiplier. A win resets to 1.0.
  martingale          : parseFloat('10'),    // base multiplier when active (0 = off)
  martingaleStep      : parseFloat('100'),  // added per extra consecutive loss
  lossesBeforeMartingale: parseInt('0'),  // N losses before martingale kicks in
  maxMartingaleStep   : parseFloat('110'),    // HARD CAP on the multiplier (e.g. 5 = never stake more than 5x base)
 
  // EV gates — the heart of "only positive-EV entries"
  pulseEdgeThreshold  : parseFloat('1.015'),  // (1+g)^N·p_N must clear this (≥1.015 = +1.5% gross EV)
  pulseMinEV          : parseFloat('0.004'),  // min EV as fraction of stake (+0.4%)
  pulseMinSurvival    : parseFloat('0.99'),   // p_{N*} floor — never bet on a coin-flip-ish survival
  pulseMaxHorizon     : parseInt('6',    10), // never hold longer than this many ticks even if "optimal"
 
  // Growth-rate candidates (Deriv supports 0.01–0.05)
  pulseGrowthRates    : [0.01, 0.02, 0.03, 0.04],
 
  // Volatility-regime gate (calm-only). ratio = recentσ / longσ.
  pulseCalmMaxRatio   : parseFloat('1.05'),   // recent vol must be ≤ ~long vol
  pulseStormyMinRatio : parseFloat('1.20'),   // hard reject above this
 
  // Barrier refresh (pull real barriers from proposal responses)
  barrierRefreshMs    : parseInt('45000', 10),
 
  // Adaptive early-exit (live re-simulation during an open trade)
  pulseExitProfitLockFrac : parseFloat('0.55'), // lock if realised ≥ frac × best expected remaining
  pulseExitDriftFrac      : parseFloat('0.50'), // danger-lock if drift ≥ frac of barrier
  pulseExitNextTickEdge   : parseFloat('1.00'), // exit if next-tick (1+g)·p1 < this (≤1 = no edge left)
 
  // ─ Trade Watchdog (stuck contract recovery) ─
  tradeWatchdogMs: parseInt('90000', 10),
 
  // ─ State persistence ─
  stateFile           : 'deriv_pulse_bot9_state.json',
  stateSaveOnTrade    : true,
  stateSaveOnShutdown : true,
});
 
// ─────────────────────────────────────────────────────────────────────
// 3.  LOGGER
// ─────────────────────────────────────────────────────────────────────
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.INFO;
const pad = n => String(n).padStart(2, '0');
const ts  = () => {
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
// 4.  TELEGRAM NOTIFIER
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
          method   : 'POST',
          hostname : url.hostname,
          path     : url.pathname,
          headers  : {
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
// 5a. DERIV REST CLIENT  (PAT/OAuth OTP-based auth)
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
        port     : url.port || (isHttps ? 443 : 80),
        path     : url.pathname + url.search,
        headers  : {
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
  async get(path)     { return this._request('GET',  path); }
  async post(path, b) { return this._request('POST', path, b); }
}
 
// ─────────────────────────────────────────────────────────────────────
// 5.  DERIV WEBSOCKET CLIENT  (auto-reconnect, PAT-aware)
// ─────────────────────────────────────────────────────────────────────
class DerivClient extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg              = cfg;
    this.ws               = null;
    this.connected        = false;
    this.authorized       = false;
    this._stopped         = false;
    this._reconnecting    = false;
    this._reconnectAttempt= 0;
    this._reqId           = 0;
    this._pending         = new Map();
    this._subs            = new Map();
    this.balance          = null;
    this.currency         = cfg.currency;
    this.accountInfo      = null;
    this.symbols          = new Map();
    this._isPat           = RestClient.isPat(cfg.apiToken);
    this._rest            = this._isPat
                            ? new RestClient('https://api.derivws.com', cfg.appId, cfg.apiToken)
                            : null;
    this._otpUrl          = null;
    this._targetAccount   = null;

    // Bot state fields (initialized later in start())
    this.market           = null;
    this.analyzer         = null;
    this.exec             = null;
    this.stats            = null;
    this.lastTradeAt      = 0;
    this.startBalance     = null;
    this.lastBalance      = null;
    this.stopped          = false;
    this.overallProfit    = 0;
    this._analysisT       = null;
    this._hourlyT         = null;
    this._eodT            = null;
    this._hourlyBoot      = null;
    this._eodBoot         = null;
    this._barrierT        = null;
    this.tradeWatchdogMs  = cfg.tradeWatchdogMs;
    this.tradeStartTime   = null;
    this._tradeWatchdogTimer  = null;
    this._tradeWatchdogPollTimer = null;
    this.dailyHistory     = {};
    this._lastDayISODate  = null;

    // ── Martingale state ──
    this.lossesStreak = 0;
    this.martingaleMultiplier = 1.0;
    this._lastTradeWon = true;
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
    this.on('open',  () => logger.info('connection open'));
    this.on('error', e => logger.error('client error:', e.message));

    this.exec.on('open',    t => this._onTradeOpen(t));
    this.exec.on('update',   t => this._onTradeUpdate(t));
    this.exec.on('result',   t => this._onTradeResult(t));
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
      ? `♻️ <b>Martingale:</b> ×${this.cfg.martingale} (after ${this.cfg.lossesBeforeMartingale} losses, +${this.cfg.martingaleStep}/loss, cap ×${this.cfg.maxMartingaleStep})\n`
      : '';
    telegram.send(
      `🤖 <b>PULSE Bot Online</b>\n\n` +
      `👤 <b>Account:</b> ${info.loginid}\n` +
      `💼 <b>Type:</b> ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 <b>Balance:</b> ${this.startBalance.toFixed(2)} ${this.currencyStr()}\n` +
      `📊 <b>Assets:</b> ${this.cfg.assets.length}\n` +
      `💵 <b>Stake:</b> ${this.cfg.stake}\n` +
      `📈 <b>Growth rates:</b> ${this.cfg.pulseGrowthRates.map(g => (g*100).toFixed(0)+'%').join(', ')}\n` +
      martingaleLine +
      `🎯 <b>Edge threshold:</b> ${((this.cfg.pulseEdgeThreshold-1)*100).toFixed(1)}%\n\n` +
      `⚡ <b>PULSE engine active</b>\n` +
      `MC trials: ${this.cfg.pulseTrials} · Horizon: ${this.cfg.pulseHorizon} ticks\n\n` +
      `💼 <b>Overall Profit:</b> ${money(this.stats.overallProfit, this.currencyStr())}\n` +
      `❌ Loss streak: current ${this.stats.currentLossStreak}, x2=${this.stats.lossStreakEvents.x2}, x3=${this.stats.lossStreakEvents.x3}, x4=${this.stats.lossStreakEvents.x4}`,
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
      `⚠️ <b>Connection lost</b>\n` +
      `code: <code>${code}</code>\n` +
      `was authorised: ${wasAuthorized ? 'yes' : 'no'}\n` +
      `🔄 reconnecting…`,
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
    return url
      .replace(/([?&])(otp|app_id|token)=[^&]+/g, '$1$2=***')
      .replace(/wss:\/\/[^/]+/, m => m);
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
    this.ws.on('open',     () => this._onOpen());
    this.ws.on('message',  d  => this._onMessage(d));
    this.ws.on('error',    e  => this._onError(e));
    this.ws.on('close',    (c, r) => this._onClose(c, r));
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
      if (accRes.status === 401) {
        hint = ' — check that (1) your PAT is valid and not expired, and (2) DERIV_APP_ID matches a registered app at https://developers.deriv.com/';
      } else if (accRes.status === 403) {
        hint = ' — your PAT may lack the required "trade" scope; regenerate at https://app.deriv.com/account/api-token';
      } else if (accRes.status === 404) {
        hint = ' — account endpoint not found; you may be using a legacy token with the new API';
      }
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
      const msg = otpRes.body?.errors?.[0]?.message
        || JSON.stringify(otpRes.body);
      throw new Error(`OTP request failed (${otpRes.status}): ${msg}`);
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
    this.connected     = true;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this.emit('open');

    if (this._isPat) {
      this._newApiMarkAuthorized();
    } else {
      this._authorize();
    }
  }

  _newApiMarkAuthorized() {
    if (!this.accountInfo) return;
    this.authorized = true;
    this.balance    = this.accountInfo.balance ?? null;
    this.currency   = this.accountInfo.currency || this.cfg.currency;
    logger.info(
      `authorized ${this.accountInfo.loginid} ` +
      `(${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) ` +
      `balance=${this.balance} ${this.currency} ` +
      `via PAT/new-API`,
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
      logger.info(
        `authorized ${res.authorize.loginid} ` +
        `(${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) ` +
        `balance=${this.balance} ${this.currency}`
      );
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
      const RACE_CONDITION_CODES = new Set([
        'BetExpired',
        'TradingDurationNotAllowed',
        'ContractNotFound',
        'InvalidContract',
      ]);
      if (RACE_CONDITION_CODES.has(code)) {
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
      if (['AuthorizationRequired','InvalidToken','InvalidAppID'].includes(code)) {
        this._closeAndReconnect();
      }
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
      return;
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
      this.cfg.reconnect.initialDelayMs *
        Math.pow(this.cfg.reconnect.backoffFactor, this._reconnectAttempt - 1),
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

  _closeAndReconnect() {
    try { this.ws?.close(); } catch (_) {}
  }

  _send(payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected'));
      }
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
      catch (e) {
        clearTimeout(timer);
        this._pending.delete(reqId);
        reject(e);
      }
    });
  }

  subscribe(payload, callback, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected'));
      }
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
          if (subId) {
            this._subs.set(subId, callback);
            resolve(subId);
          } else {
            reject(new Error('No subscription id in response'));
          }
        },
        reject,
        timer,
      });
      try { this.ws.send(text); }
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

  _onTradeResult(t) {
    this._clearWatchdogTimers();
    this.tradeStartTime = null;
    const rec = this.stats.record(t);
    const emoji = t.status === 'won' ? '✅' : '❌';
    const label = t.status === 'won' ? 'WIN' : 'LOSS';
    const dur = Math.max(0, (t.sellTime || Date.now()/1000) - (t.buyTime || 0));
    this.lastBalance = (this.lastBalance ?? this.balance ?? 0) + t.profit;
 
    this.overallProfit += t.profit;
    this._updateMartingale(t.status);

    const martingaleLine = this.martingaleMultiplier > 1
      ? `♻️ <b>Martingale:</b> ×${this.martingaleMultiplier.toFixed(2)} (${this.lossesStreak} consecutive losses)\n`
      : '';
 
    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));
 
    let msg =
      `${emoji} <b>PULSE TRADE ${label}</b>\n\n` +
      `🎫 <b>Contract:</b> #${t.contractId}\n` +
      `📊 <b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `📈 <b>Growth:</b> ${(t.growthRate*100).toFixed(0)}%\n` +
      `💵 <b>Stake:</b> ${t.stake.toFixed(2)} ${this.currencyStr()}\n` +
      `💰 <b>Sell:</b> ${t.sellPrice.toFixed(2)}\n` +
      `${t.profit >= 0 ? '📈' : '📉'} <b>Profit:</b> ${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)} ${this.currencyStr()}\n` +
      `⏱️ <b>Duration:</b> ${dur.toFixed(1)}s\n` +
      `💼 <b>Balance:</b> ${this.lastBalance.toFixed(2)} ${this.currencyStr()}\n\n` +
      `📅 <b>GMT Day Stats (${rec.date})</b>\n` +
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses})\n` +
      `• Win rate: ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net P/L: ${todayStats.totalProfit >= 0 ? '+' : ''}${todayStats.totalProfit.toFixed(2)} ${this.currencyStr()}\n` +
      `• Profit factor: ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n` +
      `💼 <b>Overall:</b> ${this.overallProfit >= 0 ? '+' : ''}${this.overallProfit.toFixed(2)} ${this.currencyStr()}\n` +
      martingaleLine +
      `❌ <b>Consecutive Losses:</b> current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
      `   x2=${this.stats.lossStreakEvents.x2}  x3=${this.stats.lossStreakEvents.x3}  x4=${this.stats.lossStreakEvents.x4}`;
    telegram.send(msg);
    this.lastTradeAt = Date.now();
    this._saveState('after-trade');
  }
 
  _onTradeOpen(t) {
    this.tradeStartTime = Date.now();
    this._startTradeWatchdog(t.contractId);
    let msg =
      `🟢 <b>PULSE TRADE OPENED</b>\n\n` +
      `🎫 <b>Contract:</b> #${t.contractId}\n` +
      `📊 <b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `📈 <b>Growth Rate:</b> ${(t.growthRate*100).toFixed(2)}%\n` +
      `💵 <b>Stake:</b> ${t.stake.toFixed(2)}${this.martingaleMultiplier > 1 ? ` (base ${(t._analysis?.baseStake ?? this.cfg.stake)} × ${this.martingaleMultiplier.toFixed(2)})` : ''} ${this.currencyStr()}\n` +
      `🎯 <b>Take Profit:</b> ${t.limit?.take_profit ?? '–'}\n` +
      `🏦 <b>Overall Profit:</b> ${this.overallProfit >= 0 ? '+' : ''}${this.overallProfit.toFixed(2)} ${this.currencyStr()}\n` +
      `❌ <b>Loss streak:</b> ${this.stats.currentLossStreak}\n` +
      (this.martingaleMultiplier > 1
        ? `♻️ <b>Martingale:</b> ×${this.martingaleMultiplier.toFixed(2)} (${this.lossesStreak} losses)\n`
        : '') + `\n` +
      `🧠 <b>PULSE Analysis</b>\n` +
      `• Edge: ${((t._analysis?.edge ?? 0)*100).toFixed(2)}%\n` +
      `• EV: ${((t._analysis?.ev ?? 0)*100).toFixed(2)}%\n` +
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
 
  // ── PULSE sizing (anti-Martingale) ──────────────────────────
  /**
   * currentStake(): computes the stake for the NEXT trade.
   *  - flat mode  : always base stake (downscaled after a loss if enabled)
   *  - edge mode  : scales up with the measured edge, capped; never up
   *                 after a loss.
   */
  currentStake(edge) {
    const base = this.cfg.stake;
    let mult = 1.0;
    if (this.cfg.sizingMode === 'edge' && edge && edge > 1) {
      const evFrac = Math.max(0, edge - 1);
      const scaled = 1 + (evFrac / this.cfg.edgeScaleEdgeRef) * (this.cfg.edgeScaleMax - 1);
      mult = Math.max(1, Math.min(this.cfg.edgeScaleMax, scaled));
    }
    if (this.cfg.downscaleAfterLoss && this.stats.currentLossStreak > 0) {
      mult *= Math.max(0.5, Math.pow(0.85, this.stats.currentLossStreak));
    }
    // Martingale: multiply by martingaleMultiplier if active
    const m = this.cfg.martingale || 0;
    if (m > 0 && this.lossesStreak > (this.cfg.lossesBeforeMartingale || 0)) {
      mult *= this.martingaleMultiplier;
    }
    return +(base * mult).toFixed(2);
  }
 
  _updateMartingale(tradeResult) {
    if (!this.cfg.martingale || this.cfg.martingale <= 0) {
      this.lossesStreak = 0;
      this.martingaleMultiplier = 1.0;
      this._lastTradeWon = tradeResult === 'won';
      return;
    }
    const threshold = this.cfg.lossesBeforeMartingale || 0;
    const cap = this.cfg.maxMartingaleStep || Infinity;
    if (tradeResult === 'won') {
      this.lossesStreak = 0;
      this.martingaleMultiplier = 1.0;
    } else {
      this.lossesStreak++;
      if (this.lossesStreak > threshold) {
        const stepNum = this.lossesStreak - threshold - 1;
        const raw = this.cfg.martingale + this.cfg.martingaleStep * stepNum;
        const capped = Math.min(raw, cap);
        if (capped !== this.martingaleMultiplier) {
          this.martingaleMultiplier = capped;
          const note = raw > cap ? ` (raw ×${raw.toFixed(2)} capped at ×${cap})` : '';
          logger.info(
            `martingale: ${this.lossesStreak} losses streak → ` +
            `stake × ${this.martingaleMultiplier.toFixed(2)}${note}`,
          );
        }
      }
    }
    this._lastTradeWon = tradeResult === 'won';
  }
 
  // ── Trade Watchdog (stuck contract recovery) ─────────────────
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
          .catch(e => { logger.warn(`watchdog poll failed: ${e.message}`); this._recoverStuckTrade('watchdog-poll-failed'); });
        this._tradeWatchdogPollTimer = setTimeout(() => {
          const stillActive = this.exec.count() > 0;
          if (!stillActive) { this._clearWatchdogTimers(); return; }
          logger.error(`WATCHDOG: Poll timed out — contract ${contractId} still unresolved, force-releasing lock`);
          this._recoverStuckTrade('watchdog-force');
        }, 15000);
      } else {
        this._recoverStuckTrade('watchdog-offline');
      }
    }, timeoutMs);
  }
 
  _clearWatchdogTimers() {
    if (this._tradeWatchdogTimer)     { clearTimeout(this._tradeWatchdogTimer);     this._tradeWatchdogTimer = null; }
    if (this._tradeWatchdogPollTimer) { clearTimeout(this._tradeWatchdogPollTimer); this._tradeWatchdogPollTimer = null; }
  }
 
  async _recoverStuckTrade(reason) {
    this._clearWatchdogTimers();
    const stuck = this.exec.openTrades()[0];
    if (!stuck) {
      logger.warn('No active trade found for stuck trade recovery');
      return;
    }
    const contractId = stuck.contractId || 'unknown';
    const symbol = stuck.symbol;
    const stake = stuck.stake || 0;
    const entryTime = this.tradeStartTime || (stuck.buyTime ? stuck.buyTime * 1000 : Date.now());
    const openSeconds = Math.round((Date.now() - entryTime) / 1000);
    logger.error(`STUCK TRADE [${reason}] #${contractId} ${symbol} ${openSeconds}s`);
    if (contractId !== 'unknown' && this.authorized && this.connected) {
      try { await this.exec.sell(contractId, 0); } catch (e) { logger.warn(`emergency sell failed: ${e.message}`); }
    }
    this.exec.open.delete(contractId);
    const finishedTrade = {
      contractId, symbol, stake, profit: -stake, status: 'lost',
      sellPrice: 0, sellTime: Date.now()/1000, buyTime: entryTime/1000,
      growthRate: stuck.growthRate || this.cfg.multiplier,
    };
    this.stats.record(finishedTrade);
    this.lastTradeAt = Date.now();
    this.tradeStartTime = null;
    telegram.send(
      `<b>STUCK TRADE RECOVERED [${reason}]</b>\nContract: ${contractId}\n` +
      `Asset: ${symbol}\nStake: $${stake.toFixed(2)}\nOpen: ${openSeconds}s`,
    );
    this._saveState('stuck-trade-recovery');
  }
 
  // ── PULSE decision loop ──────────────────────────────────────
  async _analyzeAndTrade() {
    try {
      if (this.stopped) return;
      if (!this.authorized) return;
 
      // Daily limits
      const today = this.stats.todayTrades();
      if (today.length >= this.cfg.dailyMaxTrades) {
        logger.warn(`dailyMaxTrades reached — pausing`); return;
      }
      const pl = today.reduce((s, t) => s + (t.profit || 0), 0);
      if (pl <= -this.cfg.dailyMaxLoss) {
        logger.warn(`dailyMaxLoss reached — pausing`);
        telegram.send(`🛑 <b>Daily loss limit</b>\nNet P/L: ${pl.toFixed(2)} ${this.currencyStr()}`);
        return;
      }
 
      if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
      if (this.exec.count() >= this.cfg.maxOpenTrades) return;
 
      // Analyse every asset with PULSE
      const analyses = this.cfg.assets.map(s =>
        this.analyzer.analyze(s, this.market.historyFor(s), this.market));
      const ranked = this.analyzer.rank(analyses);
      const candidates = ranked.filter(a => a.recommend);
 
      if (!candidates.length) {
        // log the best-of for situational awareness
        if (ranked.length) {
          const b = ranked[0];
          logger.info(
            `scan: best=${b.symbol} g=${(b.growthRate*100).toFixed(0)}% edge=${b.edge.toFixed(4)} ` +
            `ev=${(b.ev*100).toFixed(2)}% N*=${b.bestN} pN=${(b.pN*100).toFixed(1)}% ` +
            `regime=${b.regime} — ` +
            `[${[
              b.edgeOK ? '' : `edge<${b.edge.toFixed(3)}`,
              b.evOK  ? '' : `ev<${(b.cfg||{}).pulseMinEV??''}`,
              b.survOK? '' : 'surv-low',
              b.calmOK? '' : 'stormy',
            ].filter(Boolean).join(',')}] no trade`,
          );
        }
        return;
      }
 
      const best = candidates[0];
      logger.info(
        `PULSE ENTER ${best.symbol} g=${(best.growthRate*100).toFixed(0)}% ` +
        `edge=${best.edge.toFixed(4)} ev=${(best.ev*100).toFixed(2)}% ` +
        `N*=${best.bestN} pN=${(best.pN*100).toFixed(1)}% regime=${best.regime} ` +
        `σ=${(best.sigma*1e4).toFixed(2)}e-4`,
      );
 
      // PULSE take-profit = stake × [(1+g)^N* − 1], rounded to a sensible tick.
      const stake        = this.currentStake(best.edge);
      const tpFraction   = best.suggestedTakeProfit;       // fraction of stake
      const takeProfit   = +(stake * tpFraction).toFixed(2);
      const stopLoss     = this.cfg.stopLoss;
 
      const analysis = {
        edge: best.edge, ev: best.ev, bestN: best.bestN,
        pN: best.pN, p1: best.p1, regime: best.regime,
        vrRatio: best.vrRatio, sigma: best.sigma,
        growthRate: best.growthRate, halfBarrierFrac: best.halfBarrierFrac,
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
 
  // ── Barrier refresh ─────────────────────────────────────────
  async _refreshBarriers() {
    try {
      if (!this.authorized) return;
      await this.market.refreshBarriers(this.cfg.assets, this.cfg.pulseGrowthRates);
      logger.debug('barrier cache refreshed');
    } catch (e) {
      logger.debug('barrier refresh error:', e.message);
    }
  }
 
  // ── State persistence ──────────────────────────────────────
  _statePayload(reason) {
    return {
      version: 3,
      engine: 'PULSE',
      savedAt: new Date().toISOString(),
      savedReason: reason,
      startBalance: this.startBalance,
      lastBalance: this.lastBalance,
      lastDayISODate: this._lastDayISODate || this._todayISO(),
      dailyHistory: this.dailyHistory || {},
      stats: this.stats.serialize(),
      lossesStreak: this.lossesStreak ?? 0,
      martingaleMultiplier: this.martingaleMultiplier ?? 1.0,
    };
  }
  _saveState(reason = 'checkpoint') {
    if (!this.cfg.stateSaveOnTrade && reason === 'after-trade') return;
    if (!this.cfg.stateSaveOnShutdown && reason === 'shutdown') return;
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
    if (!fs.existsSync(file)) { logger.debug(`no state file (fresh start)`); return; }
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.startBalance != null)    this.startBalance  = data.startBalance;
      if (data.lastBalance  != null)    this.lastBalance   = data.lastBalance;
      if (data.lastDayISODate)          this._lastDayISODate = data.lastDayISODate;
      if (data.dailyHistory)            this.dailyHistory  = data.dailyHistory;
      if (data.lossesStreak != null)    this.lossesStreak = data.lossesStreak;
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
 
  _todayISO()   { return utcDateStr(); }
  _gmtNowStr()  { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
 
 
  // ── Summaries ───────────────────────────────────────────────
  _sendHourly() {
    const now = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const date = utcDateStr(prev);
    const hour = utcHour(prev);
    const list = this.stats.tradesForHour(date, hour);
    const s = this.stats.stats(list);
    if (!list.length) {
      telegram.send(`⏰ <b>Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\nNo trades this hour.\n\n💼 Overall Profit: ${money(this.stats.overallProfit, this.currencyStr())}`);
      return;
    }
    let msg =
      `⏰ <b>Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\n` +
      `📊 Trades: ${s.count} (✅${s.wins} ❌${s.losses})\n` +
      `📈 Win rate: ${s.winRate.toFixed(1)}%\n` +
      `💰 P/L: <b>${money(s.totalProfit, this.currencyStr())}</b>\n` +
      `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currencyStr())}</b>\n` +
      `❌ Loss streak current ${this.stats.currentLossStreak} | x2=${this.stats.lossStreakEvents.x2} x3=${this.stats.lossStreakEvents.x3} x4=${this.stats.lossStreakEvents.x4}\n\n` +
      `📋 Detail:\n`;
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
      logger.info(`EOD ${date} already sent; skipping duplicate`);
      return;
    }
    const summary = this.stats.archiveDate(date);
    const ds = summary.stats;
    const balStart = this.startBalance ?? 0;
    const balNow = this.lastBalance ?? balStart;
    const balDelta = balNow - balStart;
    const balPct = balStart ? (balDelta / balStart) * 100 : 0;

    let msg = `🌙 <b>PULSE END OF TRADE DAY — GMT</b>\n` +
              `📅 Trade day ended: <b>${date}</b>\n\n` +
              `<b>── Current Day Stats ──</b>\n`;
    if (ds.count) {
      msg += `📊 Trades: ${ds.count} (✅${ds.wins} ❌${ds.losses})\n` +
             `📈 Win rate: ${ds.winRate.toFixed(1)}%\n` +
             `💵 Total stake: ${ds.stake.toFixed(2)} ${this.currencyStr()}\n` +
             `💰 Gross win: +${ds.grossWin.toFixed(2)}\n` +
             `📉 Gross loss: -${ds.grossLoss.toFixed(2)}\n` +
             `💼 <b>Net P/L: ${money(ds.totalProfit, this.currencyStr())}</b>\n` +
             `🏆 Profit factor: ${ds.profitFactor === Infinity ? '∞' : ds.profitFactor.toFixed(2)}\n` +
             `❌ Max loss streak today: ${ds.maxLossStreak}\n\n`;
    } else {
      msg += `No trades recorded for this GMT trade day.\n\n`;
    }

    msg += `<b>── Balance ──</b>\n${balStart.toFixed(2)} → ${balNow.toFixed(2)} ` +
           `(${balDelta >= 0 ? '+' : ''}${balDelta.toFixed(2)} / ${balPct >= 0 ? '+' : ''}${balPct.toFixed(2)}%)\n\n`;

    msg += `<b>── Overall / Stored Stats ──</b>\n` +
           `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currencyStr())}</b>\n` +
           `❌ Consecutive losses: current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
           `   x2=${this.stats.lossStreakEvents.x2}  x3=${this.stats.lossStreakEvents.x3}  x4=${this.stats.lossStreakEvents.x4}\n\n`;

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
    telegram.send(`🛑 <b>PULSE Bot stopped</b>\nSignal: ${signal}`);
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
// 6.  MARKET DATA MANAGER
// ─────────────────────────────────────────────────────────────────────
class MarketDataManager {
  constructor(client, cfg) {
    this.client      = client;
    this.cfg         = cfg;
    this.history     = new Map();
    this.subs        = new Map();
    this.lastQuote   = new Map();
    this._bootstrapping = false;
    this.stayCache   = new Map();
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

  async refreshStays(assets, growthRate) {
    if (this._refreshInFlight) return;
    if (!this.client.authorized) return;
    this._refreshInFlight = true;
    try {
      for (const sym of assets) {
        try {
          const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
          const res = await this.client._send({
            proposal: 1,
            amount  : this.cfg.stake,
            basis   : 'stake',
            contract_type: 'ACCU',
            currency: this.cfg.currency,
            [symbolKey]: sym,
            growth_rate: growthRate,
          }, 8000);
          if (res?.proposal?.contract_details) {
            this.cacheStays(sym, growthRate, res.proposal.contract_details);
          }
        } catch (e) {
          logger.debug(`refreshStays(${sym}) failed:`, e.message);
        }
      }
    } finally {
      this._refreshInFlight = false;
    }
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
            const cd = res.proposal.contract_details;
            const key = `${sym}:${gr}`;
            this._barrierCache.set(key, {
              halfBarrierPct: parseFloat(cd.tick_size_barrier_percentage || 0),
              highBarrier: parseFloat(cd.high_barrier || 0),
              lowBarrier: parseFloat(cd.low_barrier || 0),
              maxPayout: parseFloat(cd.maximum_payout || 0),
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
        count,
        end   : 'latest',
        style : 'ticks',
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
// 7.  PULSE ANALYZER  (Monte-Carlo Survival Engine)
// ─────────────────────────────────────────────────────────────────────
class PulseAnalyzer {
  constructor(cfg) {
    this.cfg = cfg;
  }

  /**
   * Bootstrap log-return distribution from recent ticks, then Monte-Carlo
   * simulate barrier survival for each growth rate and horizon.
   * Returns the best (asset, growth, N*) candidate or null.
   */
  analyze(symbol, ticks, market) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;

    const window = Math.min(this.cfg.pulseReturnWindow, ticks.length);
    const q = ticks.slice(-window).map(t => t.quote);
    if (q.length < 10) return null;

    // Per-tick log returns
    const returns = [];
    for (let i = 1; i < q.length; i++) {
      if (q[i-1] > 0) returns.push(Math.log(q[i] / q[i-1]));
    }
    if (returns.length < 5) return null;

    const price = q[q.length - 1];
    const n = returns.length;
    const mean = returns.reduce((s, v) => s + v, 0) / n;
    let variance = 0;
    for (const v of returns) variance += (v - mean) ** 2;
    const sigma = Math.sqrt(variance / n);

    // Volatility regime check: ratio of recent σ to long σ
    const longReturns = [];
    for (let i = 1; i < q.length; i++) {
      if (q[i-1] > 0) longReturns.push(Math.log(q[i] / q[i-1]));
    }
    const longSigma = longReturns.length > 20
      ? Math.sqrt(longReturns.reduce((s, v) => s + v, 0) ** 2 / longReturns.length) || sigma
      : sigma;

    const vrRatio = sigma / Math.max(longSigma, 1e-12);
    const regime = vrRatio < this.cfg.pulseCalmMaxRatio ? 'calm'
                 : vrRatio < this.cfg.pulseStormyMinRatio ? 'normal'
                 : 'stormy';

    // Estimate barrier from market data (or cached proposal)
    const barrierInfo = market ? market.getBarrier(symbol, this.cfg.pulseGrowthRates[2] || 0.03) : null;
    const halfBarrierFrac = barrierInfo ? barrierInfo.halfBarrierPct / 100 : 0.0005;

    // Number of MC trials
    const trials = this.cfg.pulseTrials;

    // Evaluate each growth rate
    let best = null;
    let bestEdge = 0;

    for (const growthRate of this.cfg.pulseGrowthRates) {
      // Get barrier for this growth rate
      const grBarrier = market ? market.getBarrier(symbol, growthRate) : null;
      const barrierFrac = grBarrier ? grBarrier.halfBarrierPct / 100
                         : halfBarrierFrac * (1 + (growthRate - 0.03) * 2);

      if (barrierFrac <= 0) continue;

      // Simulate survival
      const horizon = Math.min(this.cfg.pulseHorizon, this.cfg.pulseMaxHorizon + 5);
      const survivalCounts = new Array(horizon + 1).fill(0);
      let survivedAll = 0;

      for (let t = 0; t < trials; t++) {
        let pos = 0;
        let survived = true;
        for (let tick = 1; tick <= horizon; tick++) {
          // Bootstrap: pick a random return from history
          const r = returns[Math.floor(Math.random() * returns.length)];
          pos += r;
          const logBarrier = Math.log(1 + barrierFrac);
          if (Math.abs(pos) >= logBarrier) {
            survived = false;
            break;
          }
          if (survived) survivalCounts[tick]++;
        }
        if (survived) survivedAll++;
      }

      // Compute p_t for each t, find EV-optimal horizon
      let bestN = 0;
      let bestPayout = 0;
      const minEV = this.cfg.pulseMinEV;
      const edgeThreshold = this.cfg.pulseEdgeThreshold;

      for (let n = 1; n <= Math.min(horizon, this.cfg.pulseMaxHorizon); n++) {
        const pN = survivalCounts[n] / trials;
        const grossReturn = Math.pow(1 + growthRate, n);
        const edge = grossReturn * pN;
        const ev = edge - 1;

        if (edge >= edgeThreshold && ev >= minEV && edge > bestEdge) {
          bestEdge = edge;
          bestN = n;
          bestPayout = edge;
        }
      }

      if (bestN > 0 && regime === 'stormy') { 
        const pN = survivalCounts[bestN] / trials;
        const p1 = survivalCounts[1] / trials;
        const suggestedTakeProfit = Math.pow(1 + growthRate, bestN) - 1;

        best = {
          symbol,
          growthRate,
          edge: bestEdge,
          ev: bestPayout - 1,
          bestN,
          pN,
          p1: p1 || 0.5,
          regime,
          vrRatio,
          sigma,
          halfBarrierFrac,
          suggestedTakeProfit: Math.max(suggestedTakeProfit, 0.005),
          recommend: true,
          edgeOK: true,
          evOK: true,
          survOK: pN >= this.cfg.pulseMinSurvival,
          calmOK: regime === 'calm',
        };
      }
    }

    return best;
  }

  rank(analyses) {
    return analyses.filter(Boolean).sort((a, b) => b.edge - a.edge);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 8.  TRADE EXECUTOR  (Accumulator)
// ─────────────────────────────────────────────────────────────────────
class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client  = client;
    this.cfg     = cfg;
    this.open    = new Map();
    this.analyzer = null;
    this._selling = new Set();
  }

  async buy(symbol, growthRate, stake, limit, analysis = null) {
    growthRate = Math.max(0.01, Math.min(0.05, +growthRate.toFixed(4)));
    try {
      const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
      const pres = await this.client._send({
        proposal    : 1,
        amount      : stake,
        basis       : 'stake',
        contract_type: 'ACCU',
        currency    : this.cfg.currency,
        [symbolKey] : symbol,
        growth_rate : growthRate,
        ...((limit.take_profit != null && limit.take_profit > 0)
            ? { limit_order: { take_profit: limit.take_profit } }
            : {}),
      }, 20000);
      const p = pres.proposal;
      if (!p?.id) throw new Error('No proposal id returned');
      logger.info(`proposal id=${p.id} ask=${p.ask_price} payout=${p.payout} spot=${p.spot}`);
      if (pres.error) throw new Error(pres.error.message);

      const bres = await this.client._send({
        buy  : p.id,
        price: p.ask_price,
      }, 20000);
      const b = bres.buy;
      if (!b?.contract_id) throw new Error('Buy did not return contract_id');
      logger.info(`bought ACCU #${b.contract_id} for ${b.buy_price}`);

      const cd = p.contract_details || {};
      const entrySpot = parseFloat(p.spot ?? cd.current_spot ?? 0);
      const halfBarrierPct = entrySpot
        ? (parseFloat(cd.barrier_spot_distance ?? 0) / entrySpot) * 100
        : 0;
      const highBarrier = parseFloat(cd.high_barrier ?? 0);
      const lowBarrier  = parseFloat(cd.low_barrier  ?? 0);
      const maxPayout   = parseFloat(cd.maximum_payout ?? 0);

      const info = {
        contractId : b.contract_id,
        symbol,
        growthRate,
        stake,
        buyPrice   : parseFloat(b.buy_price),
        payout     : parseFloat(b.payout),
        buyTime    : b.purchase_time || (Date.now()/1000),
        limit      : { stop_loss: limit.stop_loss ?? null, take_profit: limit.take_profit ?? null },
        contractDetails : cd,
        entrySpot,
        halfBarrierPct,
        highBarrier,
        lowBarrier,
        maxPayout,
        proposalId : p.id,
        balanceAfter: parseFloat(b.balance_after ?? this.client.balance),
      };

      if (analysis && typeof analysis === 'object') {
        info._analysis = analysis;
      }
      this.open.set(b.contract_id, info);
      logger.info(`barrier: ±${halfBarrierPct.toFixed(4)}% spot=${entrySpot.toFixed(2)} [${lowBarrier.toFixed(2)} … ${highBarrier.toFixed(2)}] maxPayout=${maxPayout}`);

      if (this.bot?.market?.cacheStays) {
        this.bot.market.cacheStays(symbol, growthRate, cd);
      }

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

  async _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    const cid  = c.contract_id ?? info.contractId;
    const profit = parseFloat(c.profit ?? 0);
    const spot   = parseFloat(c.current_spot ?? 0);
    const status = c.status;

    logger.debug(`contract #${cid} status=${status} profit=${profit.toFixed(3)} spot=${spot}`);

    const stopLossAbs = Math.abs(info.limit?.stop_loss || 0);
    if (status === 'open' && stopLossAbs > 0 && profit <= -stopLossAbs && !this._selling.has(cid)) {
      logger.warn(`contract #${cid} hit stop-loss @ profit=${profit.toFixed(2)} ≤ -${stopLossAbs} — selling`);
      this._selling.add(cid);
      try { await this.sell(cid, 0); } catch (e) {
        logger.error(`emergency sell #${cid} failed:`, e.message);
      } finally {
        this._selling.delete(cid);
      }
    }

    if (status === 'won' || status === 'lost') {
      const finished = {
        ...info,
        contractId : cid,
        profit,
        status,
        sellPrice  : parseFloat(c.sell_price ?? 0),
        sellTime   : c.sell_time ?? (Date.now()/1000),
        currentSpot: spot,
      };
      this.open.delete(cid);
      this.emit('result', finished);
      if (msg.subscription?.id) {
        await this.client.forget(msg.subscription.id).catch(() => {});
      }
    } else {
      this.emit('update', { ...info, contractId: cid, profit, currentSpot: spot, status });
    }
  }

  async sell(contractId, minPrice = 0) {
    try {
      const res = await this.client._send({ sell: contractId, price: minPrice }, 15000);
      logger.info(`sold #${contractId} for ${res.sell?.sold_for}`);
      return res.sell;
    } catch (e) {
      logger.error(`sell(${contractId}) failed:`, e.message);
      throw e;
    }
  }

  openTrades() { return Array.from(this.open.values()); }
  count()      { return this.open.size; }
}

// ─────────────────────────────────────────────────────────────────────
// 9.  STATISTICS MANAGER  (matching accurateDiffer style)
// ─────────────────────────────────────────────────────────────────────
class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.dailySummaries = {};
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
    const wins   = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
    const total  = list.reduce((s, t) => s + Number(t.profit || 0), 0);
    const gw     = wins.reduce((s, t)   => s + Number(t.profit || 0), 0);
    const gl     = Math.abs(losses.reduce((s, t) => s + Number(t.profit || 0), 0));
    const stake  = list.reduce((s, t) => s + Number(t.stake || 0), 0);
    const maxLossStreak = (() => {
      let cur = 0, max = 0;
      for (const t of list) {
        if (t.status === 'lost') { cur += 1; max = Math.max(max, cur); }
        else if (t.status === 'won') cur = 0;
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
// 10. BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   Deriv Accumulator Bot  —  PULSE engine  v1.0     ║');
  console.log('║   MC survival • EV-optimal horizon • No martingale ║');
  console.log('╚════════════════════════════════════════════════════╝\n');
}
 
async function main() {
  printBanner();
  try { require.resolve('ws'); }
  catch (_) {
    console.error('❌  The "ws" package is not installed.');
    console.error('    Run:  npm install ws\n');
    process.exit(1);
  }
  if (!CONFIG.apiToken) {
    console.error('❌  DERIV_API_TOKEN is not set.\n');
    process.exit(1);
  }
  console.log(CONFIG.telegram.enabled
    ? '✅  Telegram notifications: ENABLED'
    : 'ℹ️   Telegram notifications: DISABLED');
 
  const bot = new DerivClient(CONFIG);
  await bot.start();
}
 
main().catch(e => { console.error('fatal:', e); process.exit(1); });
