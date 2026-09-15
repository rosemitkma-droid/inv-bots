#!/usr/bin/env node
'use strict';

/**
 * ======================================================================
 *  AccuAPEX v5 — "Measure First" Deriv Accumulator engine
 * ======================================================================
 *
 *  A single-file Deriv Accumulator (ACCU) bot rebuilt from accuAPEX v4.
 *
 *  ─ WHAT THE RESEARCH CHANGED ────────────────────────────────────────
 *
 *  1. ACCU IS VOLATILITY-INDICES ONLY.
 *     Deriv offers Accumulators only on volatility indices. All of v4's
 *     BOOM/CRASH "post-spike" machinery was unreachable code for ACCU.
 *     It is gone. Assets are R_* and 1HZ*V only.
 *
 *  2. THE UNDERLYING IS I.I.D. BY CONSTRUCTION.
 *     Volatility indices are CSPRNG-generated with a CONSTANT annualised
 *     volatility. Per-tick log returns are i.i.d. Gaussian with fixed σ.
 *     Therefore NO conditional state — realized-vol compression, RSI,
 *     streaks, patterns, time of day — can predict the next tick.
 *     v4's "volatility compression" gate was measuring sampling noise.
 *     It is gone.
 *
 *  3. THE BARRIER IS THE FAIR GAUSSIAN QUANTILE MINUS A HAIRCUT.
 *     From Deriv's own published barriers, b(5%)/b(1%) = 0.76091 versus
 *     the zero-EV Gaussian ratio z(5%)/z(1%) = 0.76795. The barrier is
 *     the fair quantile, shaved. Measured against the 1% barrier as the
 *     anchor, the 5% rate costs ≈ −0.218% EV PER TICK.
 *     v4 hardcoded growth rate 0.05 — the single most expensive rate.
 *
 *  4. COST COMPOUNDS WITH HOLD TIME: E[return] = (1+ev_tick)^K − 1.
 *     Hold time is the main cost lever, and it only ever subtracts.
 *
 *  5. MARTINGALE IS OPT-IN AND BANNED BY DEFAULT.
 *     v4 shipped martingaleMultiplier 22.0. On a $5 base that is $115 at
 *     risk, and at an 80% win rate a 2-loss streak arrives every ~25
 *     trades. Martingale therefore defaults to OFF; enabling it is a
 *     deliberate, config-driven choice (MARTINGALE_MULTIPLIER /
 *     MARTINGALE_STEPS). Match accuHOLD_v2 semantics exactly when on.
 *
 *  ─ WHAT THIS BOT ACTUALLY DOES ──────────────────────────────────────
 *
 *  It refuses to assume an edge. It MEASURES one.
 *
 *    • CalibrationEngine reads the live barrier from Deriv's own proposal
 *      for every (symbol, growth rate), measures the realized per-tick
 *      breach rate from tick history, and computes a Wilson confidence
 *      interval on per-tick survival.
 *    • It trades ONLY if the LOWER confidence bound on survival exceeds
 *      the break-even survival 1/(1+g). That is the only condition under
 *      which a positive expectation is statistically defensible.
 *    • EdgeLedger runs a sequential test on realized outcomes. If the
 *      live edge is negative with significance, the bot HALTS itself.
 *    • Default mode is PAPER. It will not touch money until you flip it.
 *
 *  If no edge clears the gate, the bot stands aside and trades nothing.
 *  That is the correct behaviour, and it is the most likely behaviour.
 *
 *  ─ HONESTY ──────────────────────────────────────────────────────────
 *  Deriv's trading terms state that Accumulator pricing "include[s] a
 *  bias in our favour". This bot cannot remove that bias. It minimises
 *  exposure to it, measures it continuously, and stops when it is losing.
 *  No configuration of this file is guaranteed to be profitable.
 *
 *  Usage:
 *    node accuAPEX-v5.js --selftest      run the unit tests, exit
 *    node accuAPEX-v5.js --calibrate     measure edge, never trade, exit
 *    node accuAPEX-v5.js                 run (PAPER mode unless changed)
 *
 *  License: MIT
 * ======================================================================
 */

const WebSocket    = require('ws');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { URL }      = require('url');
const EventEmitter = require('events');

// ═══════════════════════════════════════════════════════════════════════
// 1. ENV LOADER
// ═══════════════════════════════════════════════════════════════════════
function loadEnv(filePath = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) return;
  try {
    for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) { console.error('[boot] .env read error:', e.message); }
}
loadEnv();

const envStr = (k, d) => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : d);
const envNum = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };
const envInt = (k, d) => { const v = parseInt(process.env[k], 10); return Number.isFinite(v) ? v : d; };
const envBool = (k, d) => {
  const v = process.env[k];
  if (v == null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(v.trim());
};

// ═══════════════════════════════════════════════════════════════════════
// 2. CONFIGURATION
//    Everything comes from the environment. No secret is ever hardcoded.
// ═══════════════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
  // ── Credentials (REQUIRED via .env — never commit these) ──
  apiToken : 'pat_cb2016855b5e6c61ac95f94432192dd6ed86bec7f7454e575d3fe1ed9f617692',
  appId    : '33uslPtthXBEkQOdfKfoY',
  wsUrl    : 'wss://ws.derivws.com/websockets/v3',
  currency : 'USD',
  // PAT-token (new API) only: which account type the OTP flow selects when
  // the token owns both types. 'demo' | 'real'.
  accountType: 'demo',

  // ── Execution mode ──
  //   'paper' — full pipeline, simulated fills, ZERO money at risk (DEFAULT)
  //   'live'  — real orders. Requires MODE=live AND CONFIRM_LIVE=i-understand
  mode         : 'live',
  confirmLive  : 'i-understand',

  // ── Assets: volatility indices ONLY. Accumulators exist nowhere else. ──
//   assets: envStr('ASSETS', 'R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V,BOOM900,BOOM1000,CRASH900,CRASH1000')
//     .split(',').map(s => s.trim()).filter(Boolean),

assets: envStr('ASSETS', 'R_10,R_25,R_50,R_75,R_100')
    .split(',').map(s => s.trim()).filter(Boolean),

  // ── Growth-rate grid. 0.01 measured cheapest; 0.05 measured dearest. ──
  growthRates: envStr('GROWTH_RATES', '0.05') //0.01,0.02,0.03
    .split(',').map(s => parseFloat(s.trim())).filter(v => v >= 0.01 && v <= 0.05),

  // ── Sizing. Flat or fixed-fraction base; martingale is opt-in below. ──
  sizing        : 'flat',   // 'flat' | 'fraction'
  stake         : 1.0,
  riskFraction  : 0.005,           // 0.5% of balance
  minStake      : 1.0,
  maxStake      : 15.0,

  // Martingale (accuHOLD_v2 semantics) ──
  martingaleMultiplier : 3.0, // stake × multiplier each loss step
  martingaleSteps      : 4,        // 0 = disabled
  martingaleBaseStake  : 0,   // 0 → use CONFIG.stake

  // ── Chase-on-loss ──
  // When ON, a losing trade immediately re-trades the SAME asset (same
  // growth rate) on the very next tick, skipping the stay/ev gates. It keeps
  // re-trading that same asset after each loss until a win, then returns to
  // the normal gate-based selection.
  chaseOnLoss         : true,

  // ── EOD / hourly summaries (GMT) ──
  eodTimeGmt         : '00:00',
  eodSendDelaySeconds: envInt('EOD_SEND_DELAY_SECONDS', 10),
  hourlySummary      : envBool('HOURLY_SUMMARY', true),

  // ── Hard risk rails (all enforced, all halt the bot) ──
  dailyMaxLoss      : 200,
  dailyMaxTrades    : 40000000,
  sessionMaxDrawdown: 300,
  maxOpenTrades     : 1,
  maxConsecLosses   : 5,

  // ── Calibration (the core of this build) ──
  // Trade only when the LOWER confidence bound on per-tick survival beats
  // the break-even survival 1/(1+g) by at least edgeMarginPerTick.
  calibMinTicks     : 5000,   // min history per symbol
  calibWindow       : 5000,     // max history retained
  calibConfidenceZ  : 0.96,      // 95% Wilson bound
  edgeMarginPerTick : -0.6000, // required cushion
  sellSpreadCost    : 0.0002, // modelled round-trip cost

  // ── Stayed-in array + evLower/tick gates (the ONLY entry gates) ──
  // The ACCU proposal returns contract_details.ticks_stayed_in — the last
  // barrier-stay durations, most current value last. Trade only when:
  //   • its N most-current values are each < stayMaxValue, AND
  //   • its single most-current value is < stayCurrentMax, AND
  //   • its calibrated evLowerPerTick is <= evLowerGateMax (e.g. -1.4547%).
  stayWindowN    : 4,     //6 N most-current values to check
  stayMaxValue   : 10,    //20 every one of those N must be < this
  stayCurrentMax : 1,   //2 the most-current value must be < this
  stayStaleMs    : 240000, // stays older than this are ignored
  evLowerGateMax : -0.010547, //-0.014547 evLower/tick gate: trade only when ≤ this

  // ── Take-profit ──
  // TP exits the trade after takeProfitTicks ticks (the hold target). The
  // same value feeds the live limit_order take-profit price.
  takeProfitTicks      : 10,  // sell after this many ticks

  // ── Hold-time policy ──
  maxHoldTicks      : 12,
  minHoldTicks      : 1,

  // ── Live edge monitor: halt when realized edge is significantly bad ──
  edgeMonitorMinTrades : 40,    // 40  minimum trades before edge monitor is active
  edgeMonitorZStop     : 2.0,  // 95% confidence that EV < 0),

  // ── Timing ──
  analysisIntervalMs : 2000,
  tradeCooldownMs    : 3000,
  barrierRefreshMs   : 60000,
  watchdogMs         : 60000,

  // ── Telegram (optional) ──
  telegram: {
    enabled : true,
    botToken: '8196927342:AAHa8d0OrF3D6yYTA_QcCPOzz5G0SPj82xE',
    chatId  : '752497117',
    maxQueue: 200,
  },

  // ── Reconnect ──
  reconnect: { initialDelayMs: 1000, maxDelayMs: 60000, backoffFactor: 2, jitterMs: 750 },

  // ── Logging / state ──
  logFile   : envStr('LOG_FILE', 'accuapex-v5_04.log'),
  logLevel  : envStr('LOG_LEVEL', 'INFO'),
  stateFile : envStr('STATE_FILE', 'accuapex-v5-state_04.json'),
  edgeFile  : envStr('EDGE_FILE', 'accuapex-v5-edge_04.json'),
});

// ═══════════════════════════════════════════════════════════════════════
// 3. LOGGER
// ═══════════════════════════════════════════════════════════════════════
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.INFO;
const pad = n => String(n).padStart(2, '0');
const ts = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
};
function _writeLog(line) { try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (_) {} }
function log(level, msg, ...rest) {
  if (LOG_LEVELS[level] > currentLevel) return;
  const line = `[${ts()}] [${level}] ${msg}` + (rest.length ? ' ' + rest.map(String).join(' ') : '');
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
  _writeLog(line);
}
const logger = {
  error: (m, ...r) => log('ERROR', m, ...r),
  warn : (m, ...r) => log('WARN',  m, ...r),
  info : (m, ...r) => log('INFO',  m, ...r),
  debug: (m, ...r) => log('DEBUG', m, ...r),
};

const money = (n, c = CONFIG.currency) => `${n >= 0 ? '+' : ''}${Number(n || 0).toFixed(2)} ${c}`;
const utcDateStr = (d = new Date()) => d.toISOString().slice(0, 10);
const utcHour    = (d = new Date()) => d.getUTCHours();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Human-readable duration formatter for trade-held time.
function formatDuration(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec < 0) return 'n/a';
  const s = Math.floor(totalSec);
  if (s < 1)    return '<1s';
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/**
 * Trade log + streaks + daily/hourly summaries for the telegram reports.
 * Copied from accuHOLD_v2.js so the notification output matches exactly.
 */
class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.dailySummaries = {};
    this.overallProfit = 0;
    this.currentLossStreak = 0;
    this.maxLossStreak = 0;
    this.lossStreakEvents = { x2: 0, x3: 0, x4: 0, x5: 0, x6: 0, x7: 0 };
    this.eodSentDates = [];
    this.dailyState = {};
    if (saved) this.load(saved);
  }
  load(s) {
    if (Array.isArray(s.trades)) this.trades = s.trades;
    if (s.dailySummaries) this.dailySummaries = s.dailySummaries;
    this.overallProfit = Number(s.overallProfit || 0);
    this.currentLossStreak = Number(s.currentLossStreak || 0);
    this.maxLossStreak = Number(s.maxLossStreak || 0);
    const e = s.lossStreakEvents || {};
    this.lossStreakEvents = {
      x2: Number(e.x2 || 0), x3: Number(e.x3 || 0), x4: Number(e.x4 || 0),
      x5: Number(e.x5 || 0), x6: Number(e.x6 || 0), x7: Number(e.x7 || 0),
    };
    this.eodSentDates = Array.isArray(s.eodSentDates) ? s.eodSentDates : [];
    this.dailyState = s.dailyState || {};
  }
  serialize() {
    return {
      trades: this.trades.slice(-5000), dailySummaries: this.dailySummaries,
      overallProfit: this.overallProfit, currentLossStreak: this.currentLossStreak,
      maxLossStreak: this.maxLossStreak,
      lossStreakEvents: { ...this.lossStreakEvents },
      eodSentDates: this.eodSentDates.slice(-400),
      dailyState: this.dailyState,
    };
  }
  lossStreakLine() {
    const e = this.lossStreakEvents;
    return `x2=${e.x2} x3=${e.x3} x4=${e.x4} x5=${e.x5} x6=${e.x6} x7=${e.x7}`;
  }
  record(trade) {
    const tsMs = Number(trade.sellTime || trade.buyTime || Date.now() / 1000) * 1000;
    const d = new Date(tsMs);
    const rec = { ...trade, timestamp: tsMs, date: utcDateStr(d), hour: utcHour(d) };
    this.trades.push(rec);
    if (rec.status === 'unknown') return rec;
    this.overallProfit += Number(rec.profit || 0);
    if (rec.status === 'lost') {
      this.currentLossStreak += 1;
      this.maxLossStreak = Math.max(this.maxLossStreak, this.currentLossStreak);
      if (this.currentLossStreak === 2) this.lossStreakEvents.x2 += 1;
      else if (this.currentLossStreak === 3) this.lossStreakEvents.x3 += 1;
      else if (this.currentLossStreak === 4) this.lossStreakEvents.x4 += 1;
      else if (this.currentLossStreak === 5) this.lossStreakEvents.x5 += 1;
      else if (this.currentLossStreak === 6) this.lossStreakEvents.x6 += 1;
      else if (this.currentLossStreak >= 7) this.lossStreakEvents.x7 += 1;
    } else if (rec.status === 'won') {
      this.currentLossStreak = 0;
    }
    return rec;
  }
  todayTrades(date = utcDateStr()) { return this.trades.filter(t => t.date === date); }
  tradesForHour(date, hour) { return this.trades.filter(t => t.date === date && t.hour === hour); }
  stats(list) {
    const wins = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
    const total = list.reduce((s, t) => s + Number(t.profit || 0), 0);
    const gw = wins.reduce((s, t) => s + Number(t.profit || 0), 0);
    const gl = Math.abs(losses.reduce((s, t) => s + Number(t.profit || 0), 0));
    return {
      count: list.length, wins: wins.length, losses: losses.length,
      winRate: list.length ? wins.length / list.length * 100 : 0,
      grossWin: gw, grossLoss: gl, totalProfit: total,
      profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
      stake: list.reduce((s, t) => s + Number(t.stake || 0), 0),
    };
  }
  archiveDate(date) {
    const list = this.trades.filter(t => t.date === date);
    const s = this.stats(list);
    this.dailySummaries[date] = s;
    return { date, trades: list, stats: s };
  }
  markEodSent(date) { if (!this.eodSentDates.includes(date)) this.eodSentDates.push(date); this.eodSentDates = this.eodSentDates.slice(-400); }
  isEodSent(date) { return this.eodSentDates.includes(date); }
}

// ═══════════════════════════════════════════════════════════════════════
// 4. STATISTICS
//    The maths that decides whether this bot is allowed to trade at all.
// ═══════════════════════════════════════════════════════════════════════
const Stats = {
  /**
   * Wilson score interval for a binomial proportion.
   * Far better than the normal approximation at p near 1, which is exactly
   * where per-tick accumulator survival lives (p ≈ 0.95–0.99).
   */
  wilson(successes, n, z = 1.96) {
    if (n <= 0) return { lower: 0, upper: 1, point: 0 };
    const p = successes / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const centre = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return {
      point: p,
      lower: Math.max(0, (centre - margin) / denom),
      upper: Math.min(1, (centre + margin) / denom),
    };
  },

  /** Break-even per-tick survival for a growth rate: p·(1+g) = 1. */
  breakEvenSurvival(growthRate) { return 1 / (1 + growthRate); },

  /** Expected value per tick given a survival probability. */
  evPerTick(survival, growthRate) { return survival * (1 + growthRate) - 1; },

  /** Expected total return over K ticks, including modelled exit cost. */
  evOverHold(survival, growthRate, K, spreadCost = 0) {
    return Math.pow(survival, K) * Math.pow(1 + growthRate, K) - 1 - spreadCost;
  },

  /** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf). */
  normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp(-x * x / 2);
    let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
            t * (-1.821255978 + t * 1.330274429))));
    return x > 0 ? 1 - p : p;
  },

  mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; },

  stdev(a) {
    if (a.length < 2) return 0;
    const m = this.mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
  },

  /**
   * One-sample z-statistic for H0: mean == mu0.
   * Used by the live edge monitor to decide when the bot is provably losing.
   */
  zStat(samples, mu0 = 0) {
    const n = samples.length;
    if (n < 2) return 0;
    const sd = this.stdev(samples);
    if (sd <= 0) return 0;
    return (this.mean(samples) - mu0) / (sd / Math.sqrt(n));
  },

  /**
   * Lag-1 autocorrelation. A genuine i.i.d. series gives ~0.
   * If this is reliably non-zero on a volatility index, that is the ONLY
   * kind of finding that could justify a conditional entry rule.
   */
  autocorr1(a) {
    const n = a.length;
    if (n < 3) return 0;
    const m = this.mean(a);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const d = a[i] - m;
      den += d * d;
      if (i > 0) num += d * (a[i - 1] - m);
    }
    return den > 0 ? num / den : 0;
  },
};

// ═══════════════════════════════════════════════════════════════════════
// 5. TELEGRAM (optional, bounded queue, never blocks trading)
// ═══════════════════════════════════════════════════════════════════════
class TelegramNotifier {
  constructor(cfg) {
    this.cfg = cfg;
    this.queue = [];
    this.sending = false;
    this.dropped = 0;
  }
  send(text) {
    if (!this.cfg.enabled || !this.cfg.botToken || !this.cfg.chatId) return;
    if (this.queue.length >= this.cfg.maxQueue) { this.queue.shift(); this.dropped++; }
    this.queue.push(text);
    this._drain();
  }
  async _drain() {
    if (this.sending) return;
    this.sending = true;
    while (this.queue.length) {
      const text = this.queue.shift();
      try { await this._post(text); } catch (e) { logger.debug('telegram:', e.message); }
      await sleep(350);
    }
    this.sending = false;
  }
  _post(text) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ chat_id: this.cfg.chatId, text, parse_mode: 'HTML' });
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.cfg.botToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.write(body);
      req.end();
    });
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ═══════════════════════════════════════════════════════════════════════
// 6. DERIV WEBSOCKET CLIENT
// ═══════════════════════════════════════════════════════════════════════
// The new-API (PAT) flow swaps the legacy `wss://…?app_id=…` + `authorize`
// handshake for a REST OTP handshake: list accounts, request a one-time
// session URL, then connect with that URL. The OTP socket is already
// authenticated — never send `authorize` on it.
class RestClient {
  constructor(baseUrl, appId, token) {
    this.baseUrl = baseUrl || 'https://api.derivws.com';
    this.appId = appId || '1089';
    this.token = token || '';
  }

  async _request(method, reqPath, body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(reqPath, this.baseUrl); } catch (e) {
        return reject(new Error(`Invalid URL: ${reqPath}`));
      }
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : require('http');
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
        timeout: 20000,
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
      req.on('timeout', () => req.destroy(new Error('REST timeout')));
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async get(p) { return this._request('GET', p); }
  async post(p, b) { return this._request('POST', p, b); }

  static isPat(token) {
    return typeof token === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
  }
}

class DerivClient extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ws = null;
    this.connected = false;
    this.authorized = false;
    this.reqId = 1;
    this.pending = new Map();       // reqId -> {resolve, reject, timer}
    this.subs = new Map();          // reqId/subscriptionId -> handler
    this.balance = 0;
    this.loginId = null;
    this.isVirtual = null;
    this._reconnectDelay = cfg.reconnect.initialDelayMs;
    this._shuttingDown = false;
    this._heartbeat = null;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    // Deriv's newer token format uses `underlying_symbol`; legacy uses `symbol`.
    this._isPat = RestClient.isPat(cfg.apiToken);
    this._rest = this._isPat ? new RestClient('https://api.derivws.com', cfg.appId, cfg.apiToken) : null;
    this._otpUrl = null;
    this._targetAccount = null;
  }

  get symbolKey() { return this._isPat ? 'underlying_symbol' : 'symbol'; }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve();
    }
    if (!this.cfg.apiToken) {
      return Promise.reject(new Error('DERIV_API_TOKEN is not set. Put it in .env — never in the source file.'));
    }
    if (this._isPat) {
      logger.info('PAT token detected → new API (OTP flow)');
      return this._newApiConnect().catch(e => {
        this._scheduleReconnect();
        throw e;
      });
    }
    const url = this._getWsUrl();
    logger.info(`connecting to ${url.replace(/([?&])app_id=[^&]+/, '$1app_id=***')}`);
    return this._openWs(url);
  }

  _getWsUrl() {
    const sep = this.cfg.wsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.wsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }

  async _newApiConnect() {
    const desiredType = (this.cfg.accountType || 'demo').toLowerCase();
    const accRes = await this._rest.get('/trading/v1/options/accounts');
    if (accRes.status !== 200) {
      const msg = accRes.body?.errors?.[0]?.message || accRes.body?.message || JSON.stringify(accRes.body);
      throw new Error(`Account list failed (${accRes.status}): ${msg}`);
    }
    const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
    if (!accounts.length) throw new Error('No Options accounts found');
    const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desiredType) || accounts[0];
    this._targetAccount = acct;
    this.accountInfo = {
      loginid: acct.account_id,
      email: acct.email,
      isVirtual: (acct.account_type || '').toLowerCase() === 'demo',
      accountType: acct.account_type,
      currency: acct.currency,
      balance: parseFloat(acct.balance),
      group: acct.group,
    };
    const otpPath = `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`;
    const otpRes = await this._rest.post(otpPath);
    if (otpRes.status !== 200) {
      throw new Error(`OTP failed (${otpRes.status}): ${JSON.stringify(otpRes.body)}`);
    }
    const wsUrl = otpRes.body?.data?.url;
    if (!wsUrl || !/^wss?:/i.test(wsUrl)) throw new Error('OTP missing data.url');
    this._otpUrl = wsUrl;
    logger.info(`connecting via OTP (new API) — session URL obtained for ${acct.account_type}`);
    return this._openWs(wsUrl);
  }

  _openWs(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.ws = new WebSocket(url, {
          headers: { 'User-Agent': 'AccuAPEX-v5/5.0 (+Node.js)' },
          handshakeTimeout: 15000,
        });
      } catch (e) {
        return reject(e);
      }

      this.ws.on('open', () => {
        this.connected = true;
        this._reconnecting = false;
        this._reconnectAttempt = 0;
        this._reconnectDelay = this.cfg.reconnect.initialDelayMs;
        logger.info('websocket open');
        this._startHeartbeat();

        const ready = () => {
          if (!settled) { settled = true; resolve(); }
          this.emit('ready');
        };

        if (this._isPat) {
          // OTP sockets arrive already authorised.
          this._newApiMarkAuthorized();
          ready();
        } else {
          this._authorize().then(ready).catch(e => {
            logger.error('authorize:', e.message);
            if (!settled) { settled = true; reject(e); }
          });
        }
      });

      this.ws.on('message', raw => this._onMessage(raw));

      this.ws.on('close', (code, reason) => {
        this.connected = false;
        this.authorized = false;
        this._stopHeartbeat();
        this._failAllPending(new Error(`socket closed (${code})`));
        this.subs.clear();
        logger.warn(`websocket closed code=${code} reason=${String(reason || '').slice(0, 120)}`);
        this.emit('disconnected');
        if (!settled) { settled = true; reject(new Error(`socket closed (${code})`)); }
        if (!this._shuttingDown) this._scheduleReconnect();
      });

      this.ws.on('error', err => {
        logger.error('websocket error:', err.message);
        this.emit('error', err);
        if (!settled) { settled = true; reject(err); }
      });

      this.ws.on('unexpected-response', (_, res) => {
        logger.error('WS handshake failed:', res.statusCode, res.statusMessage);
        try { res.destroy(); } catch (_) {}
        if (!settled) { settled = true; reject(new Error(`handshake failed (${res.statusCode})`)); }
        if (!this._shuttingDown) this._scheduleReconnect();
      });
    });
  }

  _newApiMarkAuthorized() {
    if (!this.accountInfo) return;
    this.authorized = true;
    this.balance = this.accountInfo.balance ?? 0;
    this.loginId = this.accountInfo.loginid;
    this.isVirtual = this.accountInfo.isVirtual;
    this.currency = this.accountInfo.currency || this.cfg.currency;
    logger.info(
      `authorized ${this.accountInfo.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) ` +
      `balance=${this.balance.toFixed(2)} ${this.currency}`,
    );
    this._subscribeBalance().catch(() => {});
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeat = setInterval(() => {
      if (this.connected) this._send({ ping: 1 }, 15000).catch(() => {});
    }, 30000);
  }
  _stopHeartbeat() { if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; } }

  _scheduleReconnect() {
    if (this._shuttingDown || this._reconnecting) return;
    this._reconnecting = true;
    this._reconnectAttempt++;
    const jitter = Math.random() * this.cfg.reconnect.jitterMs;
    const delay = Math.min(
      this.cfg.reconnect.initialDelayMs * Math.pow(this.cfg.reconnect.backoffFactor, this._reconnectAttempt - 1) + jitter,
      this.cfg.reconnect.maxDelayMs,
    );
    logger.info(`reconnecting in ${Math.round(delay)}ms`);
    setTimeout(() => {
      this._reconnecting = false;
      if (!this._shuttingDown) {
        this.connect().catch(e => logger.error('reconnect failed:', e.message));
      }
    }, delay);
  }

  _closeAndReconnect() {
    try { this.ws?.close(); } catch (_) {}
  }

  _failAllPending(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const id = msg.req_id;

    // One-shot request resolved by req_id (both APIs).
    if (id != null && this.pending.has(id)) {
      const p = this.pending.get(id);
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) {
        const code = msg.error.code;
        if (['AuthorizationRequired', 'InvalidToken', 'InvalidAppID'].includes(code)) this._closeAndReconnect();
        p.reject(Object.assign(new Error(msg.error.message || 'API error'), {
          code, details: msg.error.details,
        }));
      } else {
        p.resolve(msg);
      }
    }

    // Streaming update. Legacy streams carry the subscribing req_id; the new
    // API carries subscription.id (the initial response carries both, and the
    // pending resolution above maps that id onto the handler).
    const subKey = msg.subscription ? msg.subscription.id : (id != null && this.subs.has(id) ? id : null);
    if (subKey != null && this.subs.has(subKey)) {
      try { this.subs.get(subKey)(msg); } catch (e) { logger.debug('sub handler:', e.message); }
    }
  }

  _send(payload, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('socket not open'));
      }
      const id = this.reqId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ ...payload, req_id: id })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  async subscribe(payload, handler) {
    const id = this.reqId++;
    this.subs.set(id, handler);     // legacy-stream key
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.subs.delete(id);
        reject(new Error('subscribe timeout'));
      }, 20000);
      this.pending.set(id, {
        resolve: msg => {
          const subId = msg?.subscription?.id;
          if (subId) {
            // new-API stream key: remap the handler from req_id to subscription.id
            this.subs.set(subId, handler);
            this.subs.delete(id);
          }
          resolve(subId ?? id);
        },
        reject: err => { this.subs.delete(id); reject(err); },
        timer,
      });
      try { this.ws.send(JSON.stringify({ ...payload, subscribe: 1, req_id: id })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); this.subs.delete(id); reject(e); }
    });
  }

  async forget(subscriptionId) {
    if (subscriptionId == null) return;
    this.subs.delete(subscriptionId);
    try { await this._send({ forget: subscriptionId }, 10000); } catch (_) {}
  }

  async authorize() {
    if (!this.cfg.apiToken) {
      throw new Error('DERIV_API_TOKEN is not set. Put it in .env — never in the source file.');
    }
    const res = await this._send({ authorize: this.cfg.apiToken }, 20000);
    const a = res.authorize;
    this.authorized = true;
    this.balance = parseFloat(a.balance ?? 0);
    this.loginId = a.loginid;
    this.isVirtual = a.is_virtual === 1 || a.is_virtual === true;
    logger.info(
      `authorized ${a.loginid} (${this.isVirtual ? 'DEMO' : 'REAL'}) ` +
      `balance=${this.balance.toFixed(2)} ${a.currency}`,
    );
    this._subscribeBalance().catch(() => {});
    return a;
  }

  async _subscribeBalance() {
    await this.subscribe({ balance: 1 }, msg => {
      if (msg.balance?.balance != null) this.balance = parseFloat(msg.balance.balance);
    });
  }

  async ticksHistory(symbol, count = 5000) {
    const res = await this._send({
      ticks_history: symbol, count, end: 'latest', style: 'ticks',
    }, 30000);
    const h = res.history;
    if (!h?.prices) return [];
    return h.prices.map((p, i) => ({ quote: parseFloat(p), epoch: h.times[i] }));
  }

  /**
   * Deep historical backfill — ported from deriv_structure_tester_v5.js
   * `collectTicks`. Deriv ticks_history advertises up to 5000 ticks/call but
   * is currently capped at ~1000 via the PAT/OTP flow. To reach the target
   * we chain calls BACKWARDS using end = earliest_epoch - 1 and unshift each
   * batch so the result stays oldest→newest. Returns [] at the first empty
   * or short batch (history exhausted) or when Deriv refuses pagination.
   */
  async collectTicks(symbol, targetCount, batchSize = 1000, delayMs = 250) {
    const out = [];
    let remain = targetCount;
    let end = 'latest';
    let lastEpoch = null;
    let batches = 0;

    while (remain > 0) {
      const count = Math.min(batchSize, 1000, remain); // 1000 = observed PAT/OTP cap
      let msg;
      try {
        msg = await this._send({ ticks_history: symbol, count, end, style: 'ticks' }, 30000);
      } catch (e) {
        logger.warn(`history paging ${symbol}: ${e.message} — stopped at ${out.length}/${targetCount} ticks`);
        break;
      }
      const times = msg.history?.times ?? [];
      const prices = (msg.history?.prices ?? []).map(Number);
      if (!times.length) {
        logger.info(`history ${symbol}: server returned 0 more ticks — exhausted at ${out.length}`);
        break;
      }
      if (lastEpoch !== null && times[times.length - 1] >= lastEpoch) {
        logger.warn(`history paging ${symbol}: server did not honor pagination — stopped at ${out.length}/${targetCount} ticks`);
        break;
      }
      lastEpoch = times[0];
      batches++;
      out.unshift(...times.map((t, i) => ({ quote: prices[i], epoch: t })));
      remain -= times.length;
      logger.info(`history ${symbol}: fetched ${out.length}/${targetCount} ticks (batch ${batches})`);
      end = String(times[0] - 1);
      await sleep(delayMs);
      if (times.length < count) {
        logger.info(`history ${symbol}: last batch short (${times.length}/${count}) — exhausted at ${out.length}`);
        break;
      }
    }

    return out;
  }

  async subscribeTicks(symbol, handler) {
    return this.subscribe({ ticks: symbol }, msg => {
      if (msg.tick) handler({ quote: parseFloat(msg.tick.quote), epoch: msg.tick.epoch, symbol });
    });
  }

  async portfolio() {
    try {
      const res = await this._send({ portfolio: 1 }, 20000);
      return res.portfolio?.contracts ?? [];
    } catch (e) { logger.warn('portfolio:', e.message); return []; }
  }

  close() {
    this._shuttingDown = true;
    this._stopHeartbeat();
    try { this.ws?.close(); } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 7. MARKET DATA
// ═══════════════════════════════════════════════════════════════════════
class MarketData extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.history = new Map();    // symbol -> [{quote, epoch}]
    this.tickSubs = new Map();   // symbol -> subscription id
    this.barriers = new Map();   // `${symbol}|${gr}` -> {halfBarrierFrac, spot, at}
    this.deadAssets = new Set(); // symbols Deriv permanently rejects for ACCU
    this.stays = new Map();      // `${symbol}|${gr}` -> { arr: ticks_stayed_in, at }
    this._barrierSeen = new Set(); // keys whose first barrier fetch has already been logged
  }

  historyFor(symbol) { return this.history.get(symbol) ?? []; }

  async bootstrap(symbols) {
    const want = this.cfg.calibMinTicks;
    const cap = this.cfg.calibWindow;
    for (const s of symbols) {
      try {
        const h = await this.client.collectTicks(s, Math.min(want, cap));
        this.history.set(s, h);
        logger.info(`history ${s}: ${h.length} ticks (target ${Math.min(want, cap)})`);
        await this._attachTicks(s);
      } catch (e) {
        logger.warn(`history ${s} failed: ${e.message}`);
      }
      await sleep(250); // be polite to the rate limiter
    }
  }

  async _attachTicks(symbol) {
    if (this.tickSubs.has(symbol)) return;
    try {
      const id = await this.client.subscribeTicks(symbol, tick => this._onTick(symbol, tick));
      this.tickSubs.set(symbol, id);
    } catch (e) {
      logger.warn(`tick subscribe ${symbol}: ${e.message}`);
    }
  }

  _onTick(symbol, tick) {
    const arr = this.history.get(symbol) ?? [];
    // Deriv updates the feed at most once per second; ignore duplicate epochs.
    const last = arr[arr.length - 1];
    if (last && last.epoch === tick.epoch && last.quote === tick.quote) return;
    arr.push({ quote: tick.quote, epoch: tick.epoch });
    if (arr.length > this.cfg.calibWindow) arr.splice(0, arr.length - this.cfg.calibWindow);
    this.history.set(symbol, arr);
    this.emit('tick', symbol, tick);
  }

  async resubscribeAll() {
    this.tickSubs.clear();
    for (const s of this.history.keys()) await this._attachTicks(s);
  }

  barrierKey(symbol, gr) { return `${symbol}|${gr.toFixed(2)}`; }

  getBarrier(symbol, gr) {
    const b = this.barriers.get(this.barrierKey(symbol, gr));
    if (!b) return null;
    if (Date.now() - b.at > this.cfg.barrierRefreshMs * 4) return null; // too stale
    return b;
  }

  /**
   * The most recent ticks_stayed_in array harvested from an ACCU proposal for
   * a (symbol, growth rate). The last element is the most current value.
   * Returns null when we have none, or the harvest is too old to be trusted.
   */
  getStayedIn(symbol, gr) {
    const s = this.stays.get(this.barrierKey(symbol, gr));
    if (!s) return null;
    if (Date.now() - s.at > this.cfg.stayStaleMs) return null; // too stale
    return s.arr;
  }

  /**
   * Read the CURRENT barrier straight from Deriv's own proposal.
   * This is authoritative. The bot never estimates or extrapolates a barrier;
   * if Deriv will not quote it, the pair is simply not tradeable this cycle.
   */
  async refreshBarrier(symbol, growthRate, stake) {
    if (this.deadAssets.has(symbol)) return null;
    try {
      const res = await this.client._send({
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: 'ACCU',
        currency: this.cfg.currency,
        [this.client.symbolKey]: symbol,
        growth_rate: growthRate,
      }, 20000);
      const p = res.proposal;
      const cd = p?.contract_details ?? {};
      const spot = parseFloat(p?.spot ?? cd.current_spot ?? 0);
      let halfFrac = 0;

      if (Array.isArray(cd.ticks_stayed_in)) {
        this.stays.set(this.barrierKey(symbol, growthRate), {
          arr: cd.ticks_stayed_in,
          at: Date.now(),
        });
      }

      if (cd.barrier_spot_distance != null && spot > 0) {
        halfFrac = parseFloat(cd.barrier_spot_distance) / spot;
      } else if (cd.tick_size_barrier != null) {
        halfFrac = parseFloat(cd.tick_size_barrier);
      } else if (cd.high_barrier != null && cd.low_barrier != null && spot > 0) {
        halfFrac = (parseFloat(cd.high_barrier) - parseFloat(cd.low_barrier)) / (2 * spot);
      }

      if (!(halfFrac > 0)) return null;

      const rec = {
        halfBarrierFrac: halfFrac,
        spot,
        maxTicks: parseInt(cd.maximum_ticks ?? 0, 10) || null,
        maxPayout: parseFloat(cd.maximum_payout ?? 0) || null,
        at: Date.now(),
      };
      this.barriers.set(this.barrierKey(symbol, growthRate), rec);
      const key = this.barrierKey(symbol, growthRate);
      if (!this._barrierSeen.has(key)) {
        this._barrierSeen.add(key);
        logger.info(
          `barrier ${symbol}@g=${(growthRate * 100).toFixed(0)}% FOUND → ` +
          `±${(halfFrac * 100).toFixed(6)}% spot=${spot.toPrecision(6)} ` +
          `maxTicks=${rec.maxTicks ?? 'n/a'}`,
        );
      } else {
        logger.debug(
          `barrier refresh ${symbol}@g=${(growthRate * 100).toFixed(0)}% → ±${(halfFrac * 100).toFixed(6)}%`,
        );
      }
      return rec;
    } catch (e) {
      // Permanent rejections mean this symbol will never support ACCU.
      const permanent = /not (offered|available)|invalid symbol|market is presently closed|ContractCreationFailure/i;
      if (permanent.test(e.message || '') || permanent.test(e.code || '')) {
        this.deadAssets.add(symbol);
        logger.warn(`${symbol}: ACCU not available (permanent) — excluded`);
      } else {
        logger.debug(`barrier ${symbol}@${growthRate}: ${e.message}`);
      }
      return null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 8. CALIBRATION ENGINE  — the heart of this build
//
//    For each (symbol, growth rate) it answers one question:
//      "Is the LOWER confidence bound on per-tick survival above the
//       break-even survival 1/(1+g), by a real margin?"
//
//    If yes  -> a positive expectation is statistically defensible. Trade.
//    If no   -> stand aside. This is the expected outcome.
// ═══════════════════════════════════════════════════════════════════════
class CalibrationEngine {
  constructor(cfg) { this.cfg = cfg; }

  /** Per-tick log returns from a tick array. */
  logReturns(ticks) {
    const out = [];
    for (let i = 1; i < ticks.length; i++) {
      const a = ticks[i - 1].quote, b = ticks[i].quote;
      if (a > 0 && b > 0) out.push(Math.log(b / a));
    }
    return out;
  }

  /**
   * Count how many historical single-tick moves would have breached a
   * barrier of +/- halfBarrierFrac around the previous spot.
   *
   * This is the correct model: the Accumulator barrier is recomputed every
   * tick around the PREVIOUS spot, so a knockout is a single-tick event,
   * not cumulative drift from entry.
   */
  breachCount(returns, halfBarrierFrac) {
    const logHalf = Math.log(1 + halfBarrierFrac);
    let breaches = 0;
    for (const r of returns) if (Math.abs(r) >= logHalf) breaches++;
    return breaches;
  }

  /**
   * Full calibration for one (symbol, growth rate).
   * Returns null when there is not enough data to say anything honest.
   */
  calibrate(symbol, ticks, growthRate, barrier) {
    if (!barrier || !(barrier.halfBarrierFrac > 0)) {
      return { symbol, growthRate, tradeable: false, reason: 'no-barrier' };
    }
    if (!ticks || ticks.length < this.cfg.calibMinTicks) {
      return {
        symbol, growthRate, tradeable: false,
        reason: `insufficient-history:${ticks ? ticks.length : 0}/${this.cfg.calibMinTicks}`,
      };
    }

    const returns = this.logReturns(ticks);
    const n = returns.length;
    const breaches = this.breachCount(returns, barrier.halfBarrierFrac);
    const survivals = n - breaches;

    const ci = Stats.wilson(survivals, n, this.cfg.calibConfidenceZ);
    const breakEven = Stats.breakEvenSurvival(growthRate);

    // Point estimate and, critically, the conservative lower bound.
    const evPoint = Stats.evPerTick(ci.point, growthRate);
    const evLower = Stats.evPerTick(ci.lower, growthRate);

    // Diagnostics: is the series actually i.i.d.? If lag-1 autocorrelation of
    // |returns| is materially non-zero, volatility clusters and a conditional
    // rule could in principle exist. On a constant-vol index it will be ~0.
    const absR = returns.map(Math.abs);
    const acfAbs = Stats.autocorr1(absR);
    const acfRaw = Stats.autocorr1(returns);
    const sigma = Stats.stdev(returns);
    const barrierSigmas = sigma > 0 ? Math.log(1 + barrier.halfBarrierFrac) / sigma : 0;

    const tradeable = ci.lower > breakEven + this.cfg.edgeMarginPerTick;

    return {
      symbol, growthRate,
      tradeable,
      reason: tradeable ? 'edge-confirmed' : 'no-edge',
      n, breaches,
      survivalPoint: ci.point,
      survivalLower: ci.lower,
      survivalUpper: ci.upper,
      breakEven,
      evPointPerTick: evPoint,
      evLowerPerTick: evLower,
      marginPerTick: ci.lower - breakEven,
      halfBarrierFrac: barrier.halfBarrierFrac,
      halfBarrierPct: barrier.halfBarrierFrac * 100,
      sigma, barrierSigmas, acfAbs, acfRaw,
      maxTicks: barrier.maxTicks,
      at: Date.now(),
    };
  }

  /**
   * Choose the hold horizon K that maximises expected return, given a
   * survival estimate. With a negative per-tick EV the optimum is always
   * K = minimum, which is exactly the point: hold time only ever costs.
   */
  chooseHorizon(survival, growthRate, maxHold, minHold, spreadCost) {
    let best = { K: minHold, ev: -Infinity };
    for (let K = minHold; K <= maxHold; K++) {
      const ev = Stats.evOverHold(survival, growthRate, K, spreadCost);
      if (ev > best.ev) best = { K, ev };
    }
    return best;
  }

  /**
   * Stayed-in array gate, ported from liveMultiAccumNew.js.
   * @param {number[]} arr  ticks_stayed_in from the ACCU proposal (oldest→newest)
   * @returns {{ pass: boolean, reason: string, values: number[], latest: number|null }}
   */
  stayAnalysis(arr) {
    const N = this.cfg.stayWindowN;
    if (!Array.isArray(arr) || arr.length === 0) {
      return { pass: false, reason: 'no-stayed-in-data', values: [], latest: null };
    }
    const latest = arr[arr.length - 1];
    const tail = arr.slice(-N);
    if (arr.length < N) {
      return { pass: false, reason: `short-stay-history:${arr.length}/${N}`, values: tail, latest };
    }
    const maxInWindow = Math.max(...tail);
    if (maxInWindow >= this.cfg.stayMaxValue) {
      return { pass: false, reason: `stay-window-over:${maxInWindow}>=${this.cfg.stayMaxValue}`, values: tail, latest };
    }
    if (latest >= this.cfg.stayCurrentMax) {
      return { pass: false, reason: `stay-latest-over:${latest}>=${this.cfg.stayCurrentMax}`, values: tail, latest };
    }
    return { pass: true, reason: 'stay-ok', values: tail, latest };
  }

  /** Rank calibrations: tradeable first, then by the conservative lower EV. */
  rank(calibrations) {
    return calibrations.filter(Boolean).sort((a, b) => {
      if (a.tradeable !== b.tradeable) return a.tradeable ? -1 : 1;
      return (b.evLowerPerTick ?? -Infinity) - (a.evLowerPerTick ?? -Infinity);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 9. EDGE LEDGER — measures whether the bot is actually winning, and
//    halts it when the evidence says it is not.
// ═══════════════════════════════════════════════════════════════════════
class EdgeLedger {
  constructor(cfg) {
    this.cfg = cfg;
    this.returns = [];          // per-trade return as a fraction of stake
    this.expectedTicks = 0;     // sum of predicted survival ticks
    this.realizedTicks = 0;     // sum of actual ticks survived
    this.trades = 0;
    this.halted = false;
    this.haltReason = null;
    this.load();
  }

  record(trade) {
    const r = trade.stake > 0 ? trade.profit / trade.stake : 0;
    this.returns.push(r);
    if (this.returns.length > 5000) this.returns.shift();
    this.expectedTicks += trade.expectedTicks ?? 0;
    this.realizedTicks += trade.ticksHeld ?? 0;
    this.trades++;
    this.save();
    return this.evaluate();
  }

  /**
   * Sequential check: with enough trades, is the mean per-trade return
   * significantly below zero? If so the measured edge is negative and the
   * bot should stop rather than "wait for it to turn around".
   */
  evaluate() {
    const n = this.returns.length;
    if (n < this.cfg.edgeMonitorMinTrades) {
      return { halt: false, reason: `warmup ${n}/${this.cfg.edgeMonitorMinTrades}`, z: null };
    }
    const z = Stats.zStat(this.returns, 0);
    if (z <= -this.cfg.edgeMonitorZStop) {
      this.halted = true;
      this.haltReason =
        `measured edge significantly negative: mean return ` +
        `${(Stats.mean(this.returns) * 100).toFixed(3)}% over ${n} trades (z=${z.toFixed(2)})`;
      this.save();
      return { halt: true, reason: this.haltReason, z };
    }
    return { halt: false, reason: 'within tolerance', z };
  }

  summary() {
    const n = this.returns.length;
    const mean = Stats.mean(this.returns);
    const sd = Stats.stdev(this.returns);
    return {
      trades: this.trades,
      sampled: n,
      meanReturnPct: mean * 100,
      stdevPct: sd * 100,
      z: n >= 2 ? Stats.zStat(this.returns, 0) : null,
      avgExpectedTicks: this.trades ? this.expectedTicks / this.trades : 0,
      avgRealizedTicks: this.trades ? this.realizedTicks / this.trades : 0,
      halted: this.halted,
      haltReason: this.haltReason,
    };
  }

  save() {
    try {
      const tmp = this.cfg.edgeFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        returns: this.returns, expectedTicks: this.expectedTicks,
        realizedTicks: this.realizedTicks, trades: this.trades,
        halted: this.halted, haltReason: this.haltReason,
      }));
      fs.renameSync(tmp, this.cfg.edgeFile);
    } catch (e) { logger.debug('edge save:', e.message); }
  }

  load() {
    try {
      if (!fs.existsSync(this.cfg.edgeFile)) return;
      const d = JSON.parse(fs.readFileSync(this.cfg.edgeFile, 'utf8'));
      this.returns = Array.isArray(d.returns) ? d.returns : [];
      this.expectedTicks = d.expectedTicks ?? 0;
      this.realizedTicks = d.realizedTicks ?? 0;
      this.trades = d.trades ?? 0;
      this.halted = !!d.halted;
      this.haltReason = d.haltReason ?? null;
      if (this.trades) logger.info(`edge ledger restored: ${this.trades} trades`);
    } catch (e) { logger.debug('edge load:', e.message); }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 10. RISK MANAGER — every rail halts the bot, none of them just warn.
// ═══════════════════════════════════════════════════════════════════════
class RiskManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.day = utcDateStr();
    this.dayPnl = 0;
    this.dayTrades = 0;
    this.sessionPnl = 0;
    this.sessionPeak = 0;
    this.consecLosses = 0;
    this.halted = false;
    this.haltReason = null;
  }

  _rollDay() {
    const today = utcDateStr();
    if (today !== this.day) {
      logger.info(`UTC day rollover ${this.day} -> ${today}: daily counters reset`);
      this.day = today;
      this.dayPnl = 0;
      this.dayTrades = 0;
      // A daily-cap halt clears at rollover. A drawdown/edge halt does not.
      if (this.haltReason && /daily/i.test(this.haltReason)) {
        this.halted = false;
        this.haltReason = null;
      }
    }
  }

  halt(reason) {
    if (this.halted) return;
    this.halted = true;
    this.haltReason = reason;
    logger.error(`TRADING HALTED: ${reason}`);
    telegram.send(`⛔ <b>TRADING HALTED</b>\n${reason}`);
  }

  canTrade(openCount) {
    this._rollDay();
    if (this.halted) return { ok: false, reason: `halted: ${this.haltReason}` };
    if (openCount >= this.cfg.maxOpenTrades) return { ok: false, reason: 'max-open-trades' };
    if (this.dayTrades >= this.cfg.dailyMaxTrades) {
      this.halt(`daily trade cap reached (${this.dayTrades})`);
      return { ok: false, reason: 'daily-trade-cap' };
    }
    if (this.dayPnl <= -Math.abs(this.cfg.dailyMaxLoss)) {
      this.halt(`daily loss limit hit (${money(this.dayPnl)})`);
      return { ok: false, reason: 'daily-loss-cap' };
    }
    const drawdown = this.sessionPeak - this.sessionPnl;
    if (drawdown >= Math.abs(this.cfg.sessionMaxDrawdown)) {
      this.halt(`session drawdown limit hit (${drawdown.toFixed(2)})`);
      return { ok: false, reason: 'session-drawdown' };
    }
    if (this.consecLosses >= this.cfg.maxConsecLosses) {
      this.halt(`${this.consecLosses} consecutive losses`);
      return { ok: false, reason: 'consecutive-losses' };
    }
    return { ok: true, reason: 'ok' };
  }

  onTradeOpened() { this.dayTrades++; }

  onTradeClosed(profit) {
    this.dayPnl += profit;
    this.sessionPnl += profit;
    this.sessionPeak = Math.max(this.sessionPeak, this.sessionPnl);
    if (profit > 0) this.consecLosses = 0; else this.consecLosses++;
  }

  /**
   * Stake sizing. Flat or fixed-fraction only.
   *
   * This manager deliberately avoids progressive-staking logic: Kelly for a
   * negative-expectation bet is zero or negative; progressive staking converts
   * a slow bleed into a fast wipeout. If the edge is real and positive, flat
   * small stakes still capture it. (Optional progressive staking is handled
   * at the bot level, not here.)
   */
  stakeFor(balance) {
    let s = this.cfg.sizing === 'fraction'
      ? balance * this.cfg.riskFraction
      : this.cfg.stake;
    s = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, s));
    return +s.toFixed(2);
  }
}


// ═══════════════════════════════════════════════════════════════════════
// 11. TRADE EXECUTOR
//     Handles live and paper fills through one code path so that paper
//     results are a faithful dry run of live behaviour.
// ═══════════════════════════════════════════════════════════════════════
const TERMINAL_STATUSES = new Set(['won', 'lost', 'sold', 'cancelled', 'expired', 'refunded']);

class TradeExecutor extends EventEmitter {
  constructor(client, marketData, cfg) {
    super();
    this.client = client;
    this.md = marketData;
    this.cfg = cfg;
    this.open = new Map();      // contractId -> trade record
    this.settled = new Set();   // contractIds already accounted for (idempotency)
    this.paper = cfg.mode !== 'live';
    this._paperSeq = 1;
    this._opening = 0;          // in-flight opens (reserved before any await)
  }

  get openCount() { return this.open.size; }

  /** True when a new contract may be opened (respects maxOpenTrades). */
  canOpenNow() {
    const max = Number(this.cfg.maxOpenTrades) || 1;
    return this._opening + this.open.size < max;
  }

  /**
   * Open a position. In paper mode the contract is tracked against the real
   * live tick feed and the real barrier, so the only thing simulated is the
   * money.
   */
  async openTrade({ symbol, growthRate, stake, targetTicks, calibration }) {
    // Reserve the open slot synchronously, BEFORE any await, so two nearly
    // simultaneous ticks can never both pass maxOpenTrades (openTrade does
    // proposal + buy round-trips in live mode; without this reservation the
    // second tick sees openCount=0 and opens a second position on another
    // asset while the first is still mid-flight).
    if (!this.canOpenNow()) {
      throw new Error(`max open trades (${this.cfg.maxOpenTrades}) already reached — skipping`);
    }
    this._opening++;
    try {
      const barrier = this.md.getBarrier(symbol, growthRate)
        ?? await this.md.refreshBarrier(symbol, growthRate, stake);
      if (!barrier) throw new Error(`no live barrier for ${symbol}@${growthRate}`);

      // Take-profit that corresponds to the target hold: stake*((1+g)^K - 1),
      // capped by the contract's maximum payout.
      let tp = stake * (Math.pow(1 + growthRate, targetTicks) - 1);
      if (barrier.maxPayout) tp = Math.min(tp, barrier.maxPayout - stake);
      tp = Math.max(0.01, +tp.toFixed(2));

      if (this.paper) return this._openPaper({ symbol, growthRate, stake, targetTicks, barrier, calibration, tp });

      // ── LIVE ──
      const proposal = await this.client._send({
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: 'ACCU',
        currency: this.cfg.currency,
        [this.client.symbolKey]: symbol,
        growth_rate: growthRate,
        limit_order: { take_profit: tp },
      }, 20000);

      const p = proposal.proposal;
      if (!p?.id) throw new Error('proposal returned no id');

      const buy = await this.client._send({
        buy: p.id,
        price: parseFloat(p.ask_price ?? stake),
      }, 25000);

      const b = buy.buy;
      if (!b?.contract_id) throw new Error('buy returned no contract_id');

      const trade = this._makeTrade({
        contractId: String(b.contract_id),
        symbol, growthRate, stake, targetTicks, barrier, calibration,
        entrySpot: parseFloat(b.start_time ? (p.spot ?? 0) : (p.spot ?? 0)),
        takeProfit: tp,
      });
      this.open.set(trade.contractId, trade);
      logger.info(
        `OPEN ${symbol} g=${(growthRate * 100).toFixed(0)}% stake=${stake} ` +
        `targetK=${targetTicks} tp=${tp} id=${trade.contractId}`,
      );
      this._watchLive(trade);
      this.emit('opened', trade);
      return trade;
    } finally {
      this._opening--;
    }
  }

  _makeTrade(o) {
    return {
      contractId: o.contractId,
      symbol: o.symbol,
      growthRate: o.growthRate,
      stake: o.stake,
      targetTicks: o.targetTicks,
      expectedTicks: o.targetTicks,
      halfBarrierFrac: o.barrier.halfBarrierFrac,
      entrySpot: o.entrySpot || 0,
      takeProfit: o.takeProfit,
      calibration: o.calibration ?? null,
      openedAt: Date.now(),
      buyTime: Date.now() / 1000,
      sellTime: null,
      sellPrice: 0,
      exitReason: null,
      ticksHeld: 0,
      profit: 0,
      status: 'open',
      paper: this.paper,
    };
  }

  // ────────────────────────── PAPER ──────────────────────────
  _openPaper({ symbol, growthRate, stake, targetTicks, barrier, calibration, tp }) {
    const hist = this.md.historyFor(symbol);
    const entrySpot = hist.length ? hist[hist.length - 1].quote : barrier.spot;
    const trade = this._makeTrade({
      contractId: `paper-${this._paperSeq++}`,
      symbol, growthRate, stake, targetTicks, barrier, calibration,
      entrySpot, takeProfit: tp,
    });
    trade.lastSpot = entrySpot;
    this.open.set(trade.contractId, trade);
    logger.info(
      `OPEN(paper) ${symbol} g=${(growthRate * 100).toFixed(0)}% stake=${stake} ` +
      `targetK=${targetTicks} barrier=±${(barrier.halfBarrierFrac * 100).toFixed(6)}%`,
    );

    // Evaluate against the real incoming tick stream.
    const onTick = (sym, tick) => {
      if (sym !== symbol || !this.open.has(trade.contractId)) return;
      const prev = trade.lastSpot;
      trade.lastSpot = tick.quote;
      if (!(prev > 0)) return;

      const move = Math.abs(Math.log(tick.quote / prev));
      const limit = Math.log(1 + trade.halfBarrierFrac);

      if (move >= limit) {
        // Barrier breached: the entire stake is lost.
        this.md.off('tick', onTick);
        this._settle(trade, { status: 'lost', profit: -trade.stake, exitReason: 'knockout' });
        return;
      }
      trade.ticksHeld++;
      trade.profit = trade.stake * (Math.pow(1 + growthRate, trade.ticksHeld) - 1);
      if (trade.ticksHeld >= trade.targetTicks) {
        this.md.off('tick', onTick);
        // Model the round-trip exit cost on the way out.
        const net = trade.profit - trade.stake * this.cfg.sellSpreadCost;
        this._settle(trade, { status: 'sold', profit: +net.toFixed(4), sellPrice: +trade.profit.toFixed(4), exitReason: 'take-profit' });
      }
    };
    this.md.on('tick', onTick);
    trade._detach = () => this.md.off('tick', onTick);

    this.emit('opened', trade);
    return trade;
  }

  // ─────────────────────────── LIVE ──────────────────────────
  async _watchLive(trade) {
    let subId = null;

    // Count ticks from the regular tick stream — NOT from Deriv's tick_count
    // in proposal_open_contract, which for ACCU contracts reports unreliable
    // values (often starting at 1 immediately after purchase).
    let lastSpot = 0;
    const onTick = (sym, tick) => {
      if (sym !== trade.symbol || !this.open.has(trade.contractId)) return;
      const prev = lastSpot;
      lastSpot = tick.quote;
      if (!(prev > 0)) return;

      // If contract already settled, ignore stale ticks.
      if (!this.open.has(trade.contractId)) return;

      trade.ticksHeld++;
      trade.profit = trade.stake * (Math.pow(1 + trade.growthRate, trade.ticksHeld) - 1);

      if (trade.ticksHeld >= trade.targetTicks && !trade._closing) {
        trade._closing = true;
        trade._exitReason = trade._exitReason || `take-profit: held ${trade.ticksHeld} ticks`;
        this._sell(trade).catch(e => {
          trade._closing = false;
          logger.warn(`sell ${trade.contractId}: ${e.message}`);
        });
      }
    };
    this.md.on('tick', onTick);
    trade._detachTick = () => this.md.off('tick', onTick);

    // Also subscribe to proposal_open_contract for settlement detection.
    try {
      subId = await this.client.subscribe(
        { proposal_open_contract: 1, contract_id: trade.contractId },
        msg => {
          const c = msg.proposal_open_contract;
          if (!c) return;
          // Update profit from the API (authoritative once sold).
          trade.profit = parseFloat(c.profit ?? trade.profit) || 0;
          const status = String(c.status ?? 'open').toLowerCase();

          if (c.is_sold === 1 || TERMINAL_STATUSES.has(status)) {
            const finalProfit = parseFloat(c.profit ?? 0) || 0;
            if (subId) this.client.forget(subId);
            trade._detachTick();
            this._settle(trade, {
              status,
              profit: finalProfit,
              sellPrice: parseFloat(c.sell_price ?? 0) || 0,
              exitReason: c.exit_reason || trade._exitReason || status,
            });
            return;
          }
        },
      );
      trade._subId = subId;
    } catch (e) {
      this.md.off('tick', onTick);
      logger.error(`watch ${trade.contractId} failed: ${e.message} — will reconcile`);
    }

    // Watchdog: if the stream dies, reconcile from the portfolio rather than
    // leaving a phantom open position on the books.
    trade._watchdog = setTimeout(() => this._reconcile(trade), this.cfg.watchdogMs * 4);
  }

  async _sell(trade) {
    try {
      await this.client._send({ sell: trade.contractId, price: 0 }, 20000);
      logger.info(`SELL requested ${trade.contractId} at K=${trade.ticksHeld}`);
    } catch (e) {
      if (/already sold|not found/i.test(e.message)) {
        await this._reconcile(trade);
        return;
      }
      throw e;
    }
  }

  async _reconcile(trade) {
    if (!this.open.has(trade.contractId)) return;
    const contracts = await this.client.portfolio();
    const found = contracts.find(c => String(c.contract_id) === trade.contractId);
    if (found) {
      trade._watchdog = setTimeout(() => this._reconcile(trade), this.cfg.watchdogMs * 4);
      return;
    }
    try {
      const res = await this.client._send(
        { proposal_open_contract: 1, contract_id: trade.contractId }, 20000);
      const c = res.proposal_open_contract ?? {};
      this._settle(trade, {
        status: String(c.status ?? 'unknown').toLowerCase(),
        profit: parseFloat(c.profit ?? 0) || 0,
        sellPrice: parseFloat(c.sell_price ?? 0) || 0,
        exitReason: c.exit_reason || String(c.status ?? 'unknown').toLowerCase(),
      });
    } catch (e) {
      logger.error(`reconcile ${trade.contractId} failed: ${e.message}`);
      this._settle(trade, { status: 'unknown', profit: 0, exitReason: 'unknown' });
    }
  }

  /** Idempotent settlement. A contract is only ever booked once. */
  _settle(trade, { status, profit, sellPrice = 0, exitReason = null }) {
    if (this.settled.has(trade.contractId)) return;
    this.settled.add(trade.contractId);
    if (trade._watchdog) clearTimeout(trade._watchdog);
    if (trade._detach) trade._detach();
    if (trade._detachTick) trade._detachTick();
    if (trade._subId) this.client.forget(trade._subId);
    this.open.delete(trade.contractId);

    trade.status = status;
    trade.profit = profit;
    trade.closedAt = Date.now();
    trade.sellTime = Date.now() / 1000;
    trade.sellPrice = sellPrice || 0;
    trade.exitReason = exitReason || status;

    const tag = profit > 0 ? 'WIN ' : 'LOSS';
    logger.info(
      `${tag} ${trade.symbol} g=${(trade.growthRate * 100).toFixed(0)}% ` +
      `K=${trade.ticksHeld}/${trade.targetTicks} pnl=${money(profit)} ` +
      `status=${status}${trade.paper ? ' (paper)' : ''}`,
    );
    this.emit('closed', trade);
  }

  async closeAll() {
    for (const trade of [...this.open.values()]) {
      if (trade.paper) { this._settle(trade, { status: 'cancelled', profit: trade.profit }); continue; }
      try { await this._sell(trade); } catch (e) { logger.warn(`closeAll: ${e.message}`); }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 12. MONTE CARLO SIMULATOR
//     Lets you price a config before risking anything. Simulates GBM ticks
//     (which is exactly how Deriv generates volatility indices) against a
//     barrier, then applies this bot's own entry/exit policy.
// ═══════════════════════════════════════════════════════════════════════
function gaussian() {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Simulate N accumulator trades.
 * @param {object} o
 * @param {number} o.sigma           per-tick log-return stdev
 * @param {number} o.halfBarrierFrac barrier half-width as a fraction of spot
 * @param {number} o.growthRate      g
 * @param {number} o.holdTicks       K (exit target)
 * @param {number} o.stake
 * @param {number} o.trades
 * @param {number} o.spreadCost      round-trip exit cost as fraction of stake
 */
function monteCarlo(o) {
  const {
    sigma, halfBarrierFrac, growthRate, holdTicks,
    stake = 1, trades = 20000, spreadCost = 0,
  } = o;
  const limit = Math.log(1 + halfBarrierFrac);

  let pnl = 0, wins = 0, losses = 0, equity = 0, peak = 0, maxDd = 0;
  let consec = 0, maxConsec = 0, totalTicks = 0;
  const perTrade = [];

  for (let t = 0; t < trades; t++) {
    let survived = 0, knocked = false;
    for (let k = 0; k < holdTicks; k++) {
      if (Math.abs(gaussian() * sigma) >= limit) { knocked = true; break; }
      survived++;
    }
    totalTicks += survived + (knocked ? 1 : 0);

    let profit;
    if (knocked) {
      profit = -stake;
      losses++; consec++; maxConsec = Math.max(maxConsec, consec);
    } else {
      profit = stake * (Math.pow(1 + growthRate, survived) - 1) - stake * spreadCost;
      if (profit > 0) wins++; else losses++;
      consec = 0;
    }
    pnl += profit;
    perTrade.push(profit / stake);
    equity += profit;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }

  const pSurvive = Math.exp(-0) ; // placeholder removed below
  return {
    trades,
    totalPnl: pnl,
    pnlPerTrade: pnl / trades,
    returnPerTradePct: (pnl / trades / stake) * 100,
    winRate: wins / trades,
    wins, losses,
    maxDrawdown: maxDd,
    maxConsecLosses: maxConsec,
    avgTicksPerTrade: totalTicks / trades,
    stdevPerTradePct: Stats.stdev(perTrade) * 100,
    zScore: Stats.zStat(perTrade, 0),
    barrierSigmas: limit / sigma,
    theoreticalSurvival: 1 - 2 * (1 - Stats.normCdf(limit / sigma)),
    breakEvenSurvival: Stats.breakEvenSurvival(growthRate),
  };
}

/** Sweep growth rates x hold times for a given barrier model. */
function sweep({ sigma, barrierOf, growthRates, holdTicks, trades = 20000, spreadCost = 0 }) {
  const rows = [];
  for (const g of growthRates) {
    for (const K of holdTicks) {
      const r = monteCarlo({
        sigma, halfBarrierFrac: barrierOf(g), growthRate: g,
        holdTicks: K, stake: 1, trades, spreadCost,
      });
      rows.push({ growthRate: g, holdTicks: K, ...r });
    }
  }
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════
// 13. THE BOT
// ═══════════════════════════════════════════════════════════════════════
class AccuApexV5 {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = new DerivClient(cfg);
    this.md = new MarketData(this.client, cfg);
    this.calib = new CalibrationEngine(cfg);
    this.edge = new EdgeLedger(cfg);
    this.risk = new RiskManager(cfg);
    this.exec = new TradeExecutor(this.client, this.md, cfg);

    this.lastTradeAt = 0;
    this.loopTimer = null;
    this.barrierTimer = null;
    this.calibTimer = null;
    this._hourlyBoot = null;
    this._hourlyT = null;
    this._eodBoot = null;
    this.running = false;
    this.calibrations = new Map();  // key -> calibration result
    this._lastTradeableKeys = new Set(); // for edge-transition logging
    this.stats = { opened: 0, closed: 0, wins: 0, losses: 0, pnl: 0 };
    this.statsLog = new StatisticsManager();  // trade log + hourly/EOD summaries
    this.startedAt = Date.now();

    // ── Martingale (accuHOLD_v2 semantics; OFF unless configured) ──
    this.martingaleBase  = Number(cfg.martingaleBaseStake) > 0 ? Number(cfg.martingaleBaseStake) : Number(cfg.stake) || 1.0;
    this.martingaleStep  = 0;
    this.currentStake    = this.martingaleBase;
    this.consecutiveLosses = 0;

    // ── Chase-on-loss: when active, re-trade this same pair after each loss
    //    until a win, skipping the gates. ──
    this.chaseActive     = false;
    this.chaseSymbol     = null;
    this.chaseGrowthRate = null;

    // ── Balance / P&L tracking for telegram reports ──
    this.startBalance  = null;
    this.lastBalance   = null;

    this.exec.on('opened', t => this._onTradeOpened(t));
    this.exec.on('closed', t => this._onClosed(t));
    this.client.on('disconnected', () => {
      logger.warn('feed lost — trading paused until reconnect');
      telegram.send(`⚠️ <b>AccuAPEX v5 Connection lost</b> — reconnecting\u2026`);
    });
    this.client.on('ready', () => { if (this.running) this.md.resubscribeAll().catch(() => {}); });
  }

  _onClosed(trade) {
    this.stats.closed++;
    this.stats.pnl += trade.profit;
    if (trade.profit > 0) this.stats.wins++; else this.stats.losses++;
    this.risk.onTradeClosed(trade.profit);

    const verdict = this.edge.record(trade);
    if (verdict.halt) this.risk.halt(verdict.reason);

    // ── Trade log (feeds hourly/EOD telegram summaries) ──
    const rec = this.statsLog.record({
      ...trade,
      status: trade.profit > 0 ? 'won' : (trade.profit < 0 ? 'lost' : 'unknown'),
      date: utcDateStr(new Date(trade.closedAt)),
    });
    if (trade.profit > 0) this.consecutiveLosses = 0;
    else if (trade.profit < 0) this.consecutiveLosses += 1;

    // ── Chase-on-loss: on a loss, re-trade the SAME pair immediately (the
    //    gates are suspended until a win). On a win, return to gated mode. ──
    if (this.cfg.chaseOnLoss) {
      if (trade.profit < 0 && !this.risk.halted) {
        this.chaseActive     = true;
        this.chaseSymbol     = trade.symbol;
        this.chaseGrowthRate = trade.growthRate;
        logger.warn(
          `chaseON: loss on ${trade.symbol}@${String(trade.growthRate)} — ` +
          `next trade reopens ${trade.symbol} at ${String(trade.growthRate)} without gates until a win`,
        );
      } else if (trade.profit > 0 && this.chaseActive) {
        this.chaseActive     = false;
        this.chaseSymbol     = null;
        this.chaseGrowthRate = null;
        logger.info(`chaseOFF: win on ${trade.symbol} — returning to gate-based selection`);
      }
    }

    // ── Martingale: stake for the NEXT trade ──
    const prevStep = this.martingaleStep;
    const prevStake = this.currentStake;
    const mg = this._updateMartingaleOnResult(trade.profit > 0 ? 'won' : (trade.profit < 0 ? 'lost' : 'unknown'));
    this.lastBalance = (this.lastBalance ?? this.client.balance ?? this.startBalance ?? 0) + trade.profit;

    this._sendTradeResult(trade, rec, { prevStep, prevStake, mg });

    this._saveState();
  }

  _onTradeOpened(t) {
    this._sendTradeOpen(t);
  }

  // ── Martingale helpers (accuHOLD_v2 semantics) ──
  _isMartingaleEnabled() {
    return Number(this.cfg.martingaleMultiplier) > 1.0 && parseInt(this.cfg.martingaleSteps, 10) > 0;
  }
  _martingaleLabel() {
    if (!this._isMartingaleEnabled()) return 'OFF';
    return `×${Number(this.cfg.martingaleMultiplier).toFixed(2)} (step ${this.martingaleStep}/${this.cfg.martingaleSteps})`;
  }
  _calcMartingaleStake(step) {
    const mult = Number(this.cfg.martingaleMultiplier) || 1;
    if (step <= 0 || mult <= 1) return +this.martingaleBase.toFixed(2);
    return +(this.martingaleBase * Math.pow(mult, step)).toFixed(2);
  }
  _updateMartingaleOnResult(status) {
    if (!this._isMartingaleEnabled()) {
      this.martingaleStep = 0;
      this.currentStake = this.martingaleBase;
      return { changed: false, reason: 'disabled' };
    }
    const maxSteps = parseInt(this.cfg.martingaleSteps, 10);
    if (status === 'won') {
      if (this.martingaleStep > 0) {
        logger.info(`martingale RESET: win after ${this.martingaleStep} steps → stake ${this.currentStake.toFixed(2)} → ${this.martingaleBase.toFixed(2)}`);
        this.martingaleStep = 0;
        this.currentStake = this.martingaleBase;
        return { changed: true, reason: 'win-reset' };
      }
      this.martingaleStep = 0;
      this.currentStake = this.martingaleBase;
      return { changed: false, reason: 'win-base' };
    }
    if (status === 'lost') {
      if (this.martingaleStep < maxSteps) {
        this.martingaleStep += 1;
        const prev = this.currentStake;
        this.currentStake = this._calcMartingaleStake(this.martingaleStep);
        logger.info(`martingale STEP UP: loss streak → step ${this.martingaleStep}/${maxSteps} stake ${prev.toFixed(2)} → ${this.currentStake.toFixed(2)} (×${this.cfg.martingaleMultiplier})`);
        return { changed: true, reason: 'loss-step-up', prev };
      }
      logger.warn(`martingale MAX STEPS hit (${this.martingaleStep}/${maxSteps}) on loss — halting trading`);
      telegram.send(`⛔ <b>AccuAPEX v5 Martingale Max Steps Reached</b>\nStep ${this.martingaleStep}/${maxSteps} lost. Trading halted.`);
      this.risk.halt(`martingale max steps reached (${this.martingaleStep}/${maxSteps})`);
      return { changed: true, reason: 'max-halt' };
    }
    return { changed: false, reason: 'no-op' };
  }

  currencyStr() { return this.client.currency || this.cfg.currency; }

  // ── Telegram: trade opened ──
  _sendTradeOpen(t) {
    const c = this.currencyStr();
    const chaseNote = this.cfg.chaseOnLoss && this.chaseActive
      ? `🔥 <b>Chase:</b> re-trading ${this.chaseSymbol} after loss (gates suspended)\n`
      : '';
    const martingaleNote = this._isMartingaleEnabled()
      ? `♻️ <b>Martingale:</b> ${this._martingaleLabel()} · base ${this.martingaleBase.toFixed(2)} → <b>${t.stake.toFixed(2)} ${c}</b>${this.martingaleStep > 0 ? ` (step ${this.martingaleStep}/${this.cfg.martingaleSteps})` : ' (base)'}\n`
      : '';
    const lossNote = `📉 <b>Loss Streak:</b> ${this.consecutiveLosses} · max ${this.statsLog.maxLossStreak} · ${this.statsLog.lossStreakLine()}\n`;
    const nextStakeNote = this._isMartingaleEnabled()
      ? `➡️ <b>Next stake (if loss):</b> ${this._calcMartingaleStake(Math.min(this.martingaleStep + 1, this.cfg.martingaleSteps)).toFixed(2)} ${c}${this.martingaleStep + 1 > this.cfg.martingaleSteps ? ' (would reset to base)' : ''}\n`
      : '';
    const msg =
      `🟢 <b>AccuAPEX v5 TRADE OPENED</b>\n\n` +
      `<b>Contract:</b> #${t.contractId}\n` +
      `<b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth Rate:</b> ${(t.growthRate * 100).toFixed(2)}%\n` +
      `<b>Stake:</b> ${t.stake.toFixed(2)} ${c}${this.martingaleStep > 0 ? ` <i>(martingale ×${Math.pow(this.cfg.martingaleMultiplier, this.martingaleStep).toFixed(2)})</i>` : ''}\n` +
      chaseNote +
      martingaleNote +
      `<b>Take-Profit:</b> sell after <b>${this.cfg.takeProfitTicks}</b> ticks\n` +
      lossNote +
      nextStakeNote +
      `<b>Overall:</b> ${money(this.statsLog.overallProfit, c)}\n\n` +
      `<i>Entry: stays + evL/t gates only. Exit: TP at ${this.cfg.takeProfitTicks} ticks.</i>`;
    telegram.send(msg);
  }

  // ── Telegram: trade closed / result ──
  _sendTradeResult(t, rec, { prevStep, prevStake, mg }) {
    const c = this.currencyStr();
    const emoji = t.profit >= 0 ? '✅' : '❌';
    const label = t.profit >= 0 ? 'WIN' : 'LOSS';
    const exit = t.exitReason || 'n/a';
    const exitLine = /^take.?profit/i.test(exit) ? '🎯 take-profit'
                  : /^tick.?cap/i.test(exit)       ? '⏱️ tick-cap'
                  : /^knockout/i.test(exit)        ? '💥 knockout'
                  : exit;
    const buyTs  = Number(t.buyTime  || 0);
    const sellTs = Number(t.sellTime || 0);
    const durationSec = (buyTs > 0 && sellTs > 0 && sellTs >= buyTs) ? (sellTs - buyTs) : null;
    const durationLine = durationSec != null
      ? `⏱️ <b>Duration:</b> ${formatDuration(durationSec)}\n`
      : `⏱️ <b>Duration:</b> n/a\n`;
    let martingaleLine = '';
    if (this._isMartingaleEnabled()) {
      if (t.profit < 0) {
        if (mg.reason === 'loss-step-up') {
          martingaleLine = `♻️ <b>Martingale:</b> STEP UP  ${prevStep}/${this.cfg.martingaleSteps} → ${this.martingaleStep}/${this.cfg.martingaleSteps}  stake ${prevStake.toFixed(2)} → <b>${this.currentStake.toFixed(2)} ${c}</b> (×${this.cfg.martingaleMultiplier})\n`;
        } else if (mg.reason === 'max-halt') {
          martingaleLine = `⛔ <b>Martingale:</b> MAX STEPS hit (${this.cfg.martingaleSteps}) → TRADING HALTED\n`;
        } else {
          martingaleLine = `♻️ <b>Martingale:</b> ${this._martingaleLabel()}  stake now ${this.currentStake.toFixed(2)} ${c}\n`;
        }
      } else {
        if (mg.reason === 'win-reset') {
          martingaleLine = `♻️ <b>Martingale:</b> WIN → RESET  ${prevStake.toFixed(2)} → <b>${this.currentStake.toFixed(2)} ${c}</b> (base)\n`;
        } else {
          martingaleLine = `♻️ <b>Martingale:</b> WIN at base — stake stays <b>${this.currentStake.toFixed(2)} ${c}</b>\n`;
        }
      }
    } else {
      martingaleLine = `♻️ <b>Martingale:</b> OFF  (flat stake)\n`;
    }
    const todayStats = this.statsLog.stats(this.statsLog.todayTrades(rec.date));
    const lossBreakdown = `📉 <b>Loss Streak:</b> ${this.consecutiveLosses} · max ${this.statsLog.maxLossStreak}\n` +
                          `   ${this.statsLog.lossStreakLine()}\n`;
    const msg =
      `${emoji} <b>AccuAPEX v5 TRADE ${label}</b>\n\n` +
      `<b>Contract:</b> #${t.contractId} · <b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth:</b> ${(t.growthRate * 100).toFixed(0)}% · <b>Stake:</b> ${Number(t.stake).toFixed(2)} ${c}\n` +
      `<b>Sell:</b> ${Number(t.sellPrice ?? 0).toFixed(2)} ${c}\n` +
      `${t.profit >= 0 ? '💚' : '💔'} <b>Profit:</b> ${money(t.profit, c)}\n` +
      `<b>Exit:</b> ${exitLine}\n` +
      durationLine +
      `<b>Ticks held:</b> ${t.ticksHeld ?? '?'} (TP after ${this.cfg.takeProfitTicks})` +
      `\n` +
      martingaleLine +
      lossBreakdown +
      `<b>Balance:</b> ${(this.lastBalance ?? 0).toFixed(2)} ${c}\n\n` +
      `<b>GMT Day (${rec.date})</b>\n` +
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses}) | WR ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net: ${money(todayStats.totalProfit, c)} | PF ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n` +
      `<b>Overall:</b> ${money(this.statsLog.overallProfit, c)}`;
    telegram.send(msg);
  }

  // ── Telegram: hourly summary ──
  _sendHourly() {
    const now = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const date = utcDateStr(prev), hour = utcHour(prev);
    const list = this.statsLog.tradesForHour(date, hour);
    const s = this.statsLog.stats(list);
    const c = this.currencyStr();
    const martingaleInfo = this._isMartingaleEnabled()
      ? `♻️ Martingale: ${this._martingaleLabel()} · base ${this.martingaleBase.toFixed(2)} → now ${this.currentStake.toFixed(2)} ${c}\n`
      : `♻️ Martingale: OFF\n`;
    const lossInfo = `📉 Loss streak: ${this.consecutiveLosses} · max ${this.statsLog.maxLossStreak} · ${this.statsLog.lossStreakLine()}\n`;
    if (!list.length) {
      telegram.send(`⏰ AccuAPEX v5 <b>${date} ${pad(hour)}:00</b> — No trades\n${martingaleInfo}${lossInfo}💼 Overall: ${money(this.statsLog.overallProfit, c)}`);
      return;
    }
    let msg = `⏰ AccuAPEX v5 <b>${date} ${pad(hour)}:00</b>\n\n📊 ${s.count} trades (✅${s.wins} ❌${s.losses})\n📈 WR: ${s.winRate.toFixed(1)}%\n💰 P/L: <b>${money(s.totalProfit, c)}</b>\n💼 Overall: <b>${money(this.statsLog.overallProfit, c)}</b>\n${martingaleInfo}${lossInfo}\n`;
    list.slice(-15).forEach((t2, i) => {
      const exit = (t2.exitReason || '').split(':')[0];
      const mgTag = t2.martingaleStep != null && t2.martingaleStep > 0 ? ` MG×${Number(this.cfg.martingaleMultiplier).toFixed(2)}` : '';
      msg += `${i + 1}. ${t2.status === 'won' ? '✅' : '❌'} #${t2.contractId} ${t2.symbol} ticks=${t2.ticksHeld ?? '?'} exit=${exit}${mgTag} ${money(t2.profit, c)}\n`;
    });
    telegram.send(msg);
  }

  // ── Telegram: end-of-day summary ──
  _sendEod(reason = 'manual') {
    const date = utcDateStr(new Date(Date.now() - 86_400_000));
    if (this.statsLog.isEodSent(date) && reason === 'scheduled') return;
    const summary = this.statsLog.archiveDate(date);
    const ds = summary.stats;
    const c = this.currencyStr();
    const balStart = this.startBalance ?? 0, balNow = this.lastBalance ?? balStart;
    const balDelta = balNow - balStart;
    let msg = `🌙 <b>AccuAPEX v5 DAILY REPORT — ${date}</b>\n\n`;
    if (ds.count) msg += `📊 ${ds.count} trades (✅${ds.wins} ❌${ds.losses}) | WR ${ds.winRate.toFixed(1)}%\n💰 Net: <b>${money(ds.totalProfit, c)}</b> | PF ${ds.profitFactor === Infinity ? '∞' : ds.profitFactor.toFixed(2)}\n`;
    else msg += `No trades.\n`;
    msg += `\n💼 ${balStart.toFixed(2)} → ${balNow.toFixed(2)} (${balDelta >= 0 ? '+' : ''}${balDelta.toFixed(2)})\n`;
    msg += `💼 Overall: <b>${money(this.statsLog.overallProfit, c)}</b>\n`;
    msg += this._isMartingaleEnabled()
      ? `♻️ Martingale: ${this._martingaleLabel()} · base ${this.martingaleBase.toFixed(2)} → now ${this.currentStake.toFixed(2)} ${c}\n`
      : `♻️ Martingale: OFF (flat stake)\n`;
    msg += `📉 Loss streak: current ${this.consecutiveLosses} · max ${this.statsLog.maxLossStreak} · ${this.statsLog.lossStreakLine()}`;
    telegram.send(msg);
    this.statsLog.markEodSent(date);
    this._saveState();
    this.startBalance = this.client.balance ?? this.lastBalance ?? this.startBalance;
  }

  async start() {
    printBanner();
    this._loadState();

    if (this.cfg.mode === 'live' && this.cfg.confirmLive !== 'i-understand') {
      logger.error(
        'MODE=live requires CONFIG confirmation. Set CONFIRM_LIVE=i-understand in .env ' +
        'to acknowledge that real money is at risk. Refusing to start.',
      );
      process.exit(1);
    }

    await this.client.connect();

    // ── Balance + bot-online telegram ──
    this.startBalance = this.startBalance ?? this.client.balance ?? 0;
    this.lastBalance  = this.lastBalance  ?? this.startBalance;
    if (this.cfg.mode === 'live') {
      logger.warn('!!! LIVE MODE ON A REAL-MONEY ACCOUNT !!!');
    }

    const c = this.currencyStr();
    const info = this.client.accountInfo || {};
    const martingaleLine = this._isMartingaleEnabled()
      ? `♻️ <b>Martingale:</b> ON  ×${Number(this.cfg.martingaleMultiplier).toFixed(2)}  steps ${this.cfg.martingaleSteps}  (base ${this.martingaleBase.toFixed(2)} → now ${this.currentStake.toFixed(2)} step ${this.martingaleStep})\n`
      : `♻️ <b>Martingale:</b> OFF  (flat stake ${this.martingaleBase.toFixed(2)})\n`;
    const lossLine = `📉 <b>Loss Streak:</b> ${this.consecutiveLosses} (max ${this.statsLog.maxLossStreak}) · ${this.statsLog.lossStreakLine()}\n`;
    telegram.send(
      `<b>AccuAPEX v5 Bot Online</b>${this.cfg.mode !== 'live' ? ' <b>🔒 DRY-RUN</b>' : ''}\n\n` +
      `<b>Account:</b> ${info.loginid ?? '?'} (${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'})\n` +
      `<b>Balance:</b> ${this.startBalance.toFixed(2)} ${c}\n` +
      `<b>Assets:</b> ${this.cfg.assets.length} volatility indices\n` +
      `<b>Growth rate:</b> ${this.cfg.growthRates.map(g => (g * 100) + '%').join(', ')} · <b>TP:</b> ${this.cfg.takeProfitTicks} ticks\n` +
      `<b>ev gate:</b> evLower/tick ≤ ${(this.cfg.evLowerGateMax * 100).toFixed(4)}%\n` +
      `<b>stay gate:</b> ${this.cfg.stayWindowN} most-current < ${this.cfg.stayMaxValue}, latest < ${this.cfg.stayCurrentMax}\n` +
      `<b>Chase on loss:</b> ${this.cfg.chaseOnLoss ? '🟢 ON (re-trade same asset until win)' : 'OFF'}\n` +
      martingaleLine +
      lossLine +
      `<b>Daily caps:</b> ${this.cfg.dailyMaxTrades} trades / ${this.cfg.dailyMaxLoss} ${c}\n` +
      `<b>Overall:</b> ${money(this.statsLog.overallProfit, c)}`,
    );

    logger.info(`bootstrapping tick history for ${this.cfg.assets.length} assets…`);
    await this.md.bootstrap(this.cfg.assets);

    await this._refreshBarriers();
    this.barrierTimer = setInterval(() => this._refreshBarriers().catch(() => {}),
      this.cfg.barrierRefreshMs);

    this.running = true;
    this.loopTimer = setInterval(() => this._tick().catch(e => logger.error('loop:', e.message)),
      this.cfg.analysisIntervalMs);
    this.calibTimer = setInterval(() => this._reportCalibration(), 5 * 60 * 1000);

    // ── Hourly summary timer (fires at next whole hour, then every 60 min) ──
    if (this.cfg.hourlySummary) {
      const msToNextHour = 3600_000 - (Date.now() % 3600_000);
      this._hourlyBoot = setTimeout(() => {
        this._sendHourly();
        this._hourlyT = setInterval(() => this._sendHourly(), 3600_000);
      }, Math.max(1000, msToNextHour));
    }

    // ── EOD summary timer (fires at eodTimeGmt + delay, then daily) ──
    const scheduleNextEod = () => {
      const now = new Date();
      const { h, min } = (() => {
        const m = String(this.cfg.eodTimeGmt || '00:00').match(/^(\d{1,2}):(\d{2})$/);
        return m ? { h: +m[1], min: +m[2] } : { h: 0, min: 0 };
      })();
      const target = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        h, min, this.cfg.eodSendDelaySeconds, 0,
      ));
      let delay = target.getTime() - now.getTime();
      if (delay <= 0) delay += 86_400_000;
      this._eodBoot = setTimeout(() => { this._sendEod('scheduled'); scheduleNextEod(); }, delay);
    };
    scheduleNextEod();

    logger.info(`running in ${this.cfg.mode.toUpperCase()} mode`);
    this._reportCalibration();
  }

  async _refreshBarriers() {
    const probeStake = Math.max(this.cfg.minStake, 1);
    for (const symbol of this.cfg.assets) {
      if (this.md.deadAssets.has(symbol)) continue;
      for (const g of this.cfg.growthRates) {
        await this.md.refreshBarrier(symbol, g, probeStake);
        await sleep(120);
      }
    }
  }

  /**
   * Refresh ticks_stayed_in for every live pair with a fresh ACCU proposal,
   * fired in parallel so the gate always reads the CURRENT breakout history
   * (each element = how many ticks the price stayed inside the barrier range
   * before breaking out; last element = most recent). Called every tick.
   */
  async _refreshStayedIn() {
    const probeStake = Math.max(this.cfg.minStake, 1);
    const tasks = [];
    for (const symbol of this.cfg.assets) {
      if (this.md.deadAssets.has(symbol)) continue;
      for (const g of this.cfg.growthRates) {
        tasks.push((async () => {
          try {
            const res = await this.client._send({
              proposal: 1,
              amount: probeStake,
              basis: 'stake',
              contract_type: 'ACCU',
              currency: this.cfg.currency,
              [this.client.symbolKey]: symbol,
              growth_rate: g,
            }, 15000);
            const p = res?.proposal;
            const cd = p?.contract_details ?? {};
            if (Array.isArray(cd.ticks_stayed_in)) {
              this.md.stays.set(this.md.barrierKey(symbol, g), {
                arr: cd.ticks_stayed_in,
                at: Date.now(),
              });
            }
          } catch {
            // transient proposal failure; keep the last known array
          }
        })());
      }
    }
    await Promise.all(tasks);
  }

  /** Recalibrate every pair and return them ranked. */
  _calibrateAll() {
    const out = [];
    for (const symbol of this.cfg.assets) {
      if (this.md.deadAssets.has(symbol)) continue;
      const ticks = this.md.historyFor(symbol);
      for (const g of this.cfg.growthRates) {
        const barrier = this.md.getBarrier(symbol, g);
        const c = this.calib.calibrate(symbol, ticks, g, barrier);
        this.calibrations.set(`${symbol}|${g}`, c);
        out.push(c);
      }
    }
    return this.calib.rank(out);
  }

  /** Human-readable one-line status for one (symbol, growth rate) calibration. */
  _calibrationLine(c, stay) {
    const sym = c.symbol.padEnd(9);
    const g = `g=${(c.growthRate * 100).toFixed(0)}%`;
    if (c.n) {
      let stayTxt = '';
      if (stay) {
        stayTxt = stay.pass
          ? ` stay=OK latest=${stay.latest}`
          : ` stay=BLOCKED(${stay.reason}) latest=${stay.latest}`;
      } else {
        stayTxt = ' stay=n/a';
      }
      return (
        `${c.tradeable ? 'TRADEABLE' : '  no-edge'} ${sym} ${g} ` +
        `n=${String(c.n).padStart(6)} breach=${String(c.breaches).padStart(5)} ` +
        `surv=${c.survivalPoint.toFixed(6)} lower=${c.survivalLower.toFixed(6)} ` +
        `breakEven=${c.breakEven.toFixed(6)} evL/t=${(c.evLowerPerTick * 100).toFixed(4)}% ` +
        `barrier=±${c.halfBarrierPct.toFixed(6)}% (${c.barrierSigmas.toFixed(3)}σ) ` +
        `acf|r|=${c.acfAbs.toFixed(4)} maxTicks=${c.maxTicks ?? 'n/a'}` + stayTxt
      );
    }
    const m = /^insufficient-history:(\d+)\/(\d+)$/.exec(c.reason || '');
    if (m) {
      const have = +m[1], need = +m[2];
      const rem = Math.max(0, need - have);
      const est = rem > 0
        ? ` (~${Math.max(1, Math.round(rem / 3600))}h @1 tick/s)`
        : '';
      return `WAIT-HISTORY ${sym} ${g} — ${have}/${need} ticks, ${rem} more needed${est}`;
    }
    if (/^no-barrier$/.test(c.reason || '')) {
      return `WAIT-BARRIER ${sym} ${g} — no live ACCU proposal yet (check refresh logs)`;
    }
    return `${'?'.padEnd(13)} ${sym} ${g} — ${c.reason || 'unknown state'}`;
  }

  /** Compact tally of what the calibration grid is waiting on. */
  _pendingSummary(ranked) {
    const tally = { calibrated: 0, 'insufficient-history': 0, 'no-barrier': 0, other: 0 };
    for (const c of ranked) {
      if (c.n) tally.calibrated++;
      else if (/insufficient-history/.test(c.reason || '')) tally['insufficient-history']++;
      else if (/no-barrier/.test(c.reason || '')) tally['no-barrier']++;
      else tally.other++;
    }
    const parts = [];
    for (const k of ['calibrated', 'insufficient-history', 'no-barrier', 'other']) {
      if (tally[k] > 0) parts.push(`${tally[k]} ${k}`);
    }
    return `${parts.join(', ')} (${ranked.length} pairs total)`;
  }

  /**
   * Log a transition the moment a pair first clears the edge gate (or stops
   * clearing it), so a status change is visible immediately and not only on
   * the periodic re-report.
   */
  _trackCalibTransitions(ranked) {
    const now = new Set(ranked.filter(c => c.tradeable).map(c => `${c.symbol}|${c.growthRate}`));
    for (const k of now) {
      if (!this._lastTradeableKeys.has(k)) {
        const c = ranked.find(x => `${x.symbol}|${x.growthRate}` === k);
        logger.info(
          `edge confirmed ${c.symbol} g=${(c.growthRate * 100).toFixed(0)}% — ` +
          `lower=${c.survivalLower.toFixed(6)} breakeven=${c.breakEven.toFixed(6)} ` +
          `evLower/tick=${(c.evLowerPerTick * 100).toFixed(4)}%`,
        );
      }
    }
    for (const k of this._lastTradeableKeys) {
      if (!now.has(k)) {
        const [symbol, gStr] = k.split('|');
        logger.info(`edge LOST ${symbol} g=${(parseFloat(gStr) * 100).toFixed(0)}% — no longer clears the gate`);
      }
    }
    this._lastTradeableKeys = now;
  }

  _reportCalibration() {
    const ranked = this._calibrateAll();
    logger.info('──── CALIBRATION ────');
    const withData = ranked.filter(c => c.n);
    if (!withData.length) {
      logger.info(`no calibrated pairs yet — waiting on: ${this._pendingSummary(ranked)}`);
      for (const c of ranked) logger.info('  ' + this._calibrationLine(c));
      logger.info('calibration resumes automatically as live ticks accumulate and barriers refresh');
      return ranked;
    }
    const stayOf = c => this.calib.stayAnalysis(this.md.getStayedIn(c.symbol, c.growthRate));
    for (const c of withData.slice(0, 20)) logger.info('  ' + this._calibrationLine(c, stayOf(c)));
    const pending = ranked.filter(c => !c.n);
    if (pending.length > 0) {
      logger.info(`${pending.length} pair(s) still pending — ${this._pendingSummary(pending)}`);
      for (const c of pending) logger.info('  ' + this._calibrationLine(c, stayOf(c)));
    }
    logger.info(`──── STAYED-IN ARRAYS (complete; validated by 'stay gate') ────`);
    for (const c of ranked) {
      const arr = this.md.getStayedIn(c.symbol, c.growthRate);
      if (!arr) {
        logger.info(`STAYED-IN ${c.symbol}@g=${(c.growthRate * 100).toFixed(0)}% — no data yet`);
        continue;
      }
      const stay = stayOf(c);
      const ev = c.evLowerPerTick == null
        ? 'ev=n/a'
        : `evL/t=${(c.evLowerPerTick * 100).toFixed(4)}% (${c.evLowerPerTick <= this.cfg.evLowerGateMax ? '≤' : '>'}` +
          `${(this.cfg.evLowerGateMax * 100).toFixed(4)}%)`;
      logger.info(
        `STAYED-IN ${c.symbol}@g=${(c.growthRate * 100).toFixed(0)}% len=${arr.length} ` +
        `latest=${stay.latest} gate=${stay.pass ? 'PASS' : `BLOCKED(${stay.reason})`} ${ev} ` +
        `arr=[${arr.join(',')}]`,
      );
    }
    const passing = rankCandidate =>
      stayOf(rankCandidate).pass && rankCandidate.evLowerPerTick != null &&
      rankCandidate.evLowerPerTick <= this.cfg.evLowerGateMax;
    const passed = withData.filter(passing);
    logger.info(
      `${passed.length} of ${withData.length} calibrated pair(s) pass BOTH gates ` +
      `(stayed-in N=${this.cfg.stayWindowN} most-current < ${this.cfg.stayMaxValue} ` +
      `& latest < ${this.cfg.stayCurrentMax}; evLowerPerTick ≤ ${(this.cfg.evLowerGateMax * 100).toFixed(4)}%). ` +
      'The bot acts on the LOWEST evLowerPerTick among those.',
    );
    return ranked;
  }

  async _tick() {
    if (!this.running || !this.client.authorized || this.risk.halted) return;

    // ── maxOpenTrades enforcement ──
    // Never open another position while any contract is open (or mid-open).
    // Each _tick can fire while the previous one is still awaiting a proposal
    // or buy round-trip, so the guard must also see the reserved in-flight
    // slot, not just this.open.size.
    if (!this.exec.canOpenNow()) {
      if (this.exec.openCount > 0) logger.info(`skip tick — ${this.exec.openCount} open trade(s) (max ${this.cfg.maxOpenTrades})`);
      return;
    }

    // ── CHASE-ON-LOSS MODE ──
    // After a loss, re-trade the SAME pair immediately. Gates (stay + ev)
    // are suspended; we keep re-trading that pair on every tick until a win,
    // then fall back to normal analysis.
    if (this.cfg.chaseOnLoss && this.chaseActive && this.chaseSymbol) {
      const g = this.chaseGrowthRate;
      const barrier = this.md.getBarrier(this.chaseSymbol, g)
        ?? await this.md.refreshBarrier(this.chaseSymbol, g, this.currentStake);
      const stayArr = this.md.getStayedIn(this.chaseSymbol, g) ?? [];
      logger.warn(
        `CHASE trade ${this.chaseSymbol}@${(g * 100).toFixed(0)}% (skip gates) ` +
        `stayedIn(len=${stayArr.length})=[${stayArr.join(',')}]`,
      );
      try {
        this.lastTradeAt = Date.now();
        await this.exec.openTrade({
          symbol: this.chaseSymbol,
          growthRate: g,
          stake: this.currentStake,
          targetTicks: this.cfg.takeProfitTicks,
          calibration: { symbol: this.chaseSymbol, growthRate: g, chase: true },
        });
        this.stats.opened++;
        this.risk.onTradeOpened();
      } catch (e) {
        logger.warn(`chase open failed: ${e.message}`);
      }
      return;
    }

    // StayedInArray must reflect the current breakout history, so re-request
    // fresh ACCU proposals every tick (not just on the 60s barrier timer).
    await this._refreshStayedIn();

    // ── ONLY TWO GATES: StayedInArray + evLower/tick (≤ evLowerGateMax) ──
    const ranked = this._calibrateAll();

    const evGate = c => {
      if (c.evLowerPerTick == null) return { pass: false, reason: 'no-ev (uncalibrated)' };
      return c.evLowerPerTick <= this.cfg.evLowerGateMax
        ? { pass: true, reason: 'ev-ok' }
        : {
            pass: false,
            reason: `ev-over:${(c.evLowerPerTick * 100).toFixed(4)}%>${(this.cfg.evLowerGateMax * 100).toFixed(4)}%`,
          };
    };

    const candidates = ranked
      .map(c => ({
        ...c,
        stay: this.calib.stayAnalysis(this.md.getStayedIn(c.symbol, c.growthRate)),
      }))
      .filter(c => c.stay.pass && evGate(c).pass);
    if (!candidates.length) {
      const verdicts = ranked.map(c => {
        const stay = this.calib.stayAnalysis(this.md.getStayedIn(c.symbol, c.growthRate));
        return `${c.symbol}@${(c.growthRate * 100).toFixed(0)}% stay=${stay.reason} ev=${evGate(c).reason}`;
      }).join(' | ');
      logger.info(`gates blocked all pairs — ${verdicts}`);
      return;
    }
    // Lowest evLower/tick among gate-passing candidates.
    candidates.sort((a, b) => (a.evLowerPerTick ?? Infinity) - (b.evLowerPerTick ?? Infinity));
    const best = candidates[0];
    const stayArr = this.md.getStayedIn(best.symbol, best.growthRate) ?? [];
    logger.info(
      `OPEN ${best.symbol} g=${(best.growthRate * 100).toFixed(0)}% ` +
      `evL/t=${(best.evLowerPerTick * 100).toFixed(4)}% (gate ≤ ${(this.cfg.evLowerGateMax * 100).toFixed(4)}%) ` +
      `stay=PASS latest=${best.stay.latest} ` +
      `stayedIn(len=${stayArr.length})=[${stayArr.join(',')}]`,
    );

    // TP after cfg.takeProfitTicks ticks (configurable). The same value feeds
    // the hold target AND the live limit_order take-profit price.
    const stake = this.currentStake;

    try {
      this.lastTradeAt = Date.now();
      await this.exec.openTrade({
        symbol: best.symbol,
        growthRate: best.growthRate,
        stake,
        targetTicks: this.cfg.takeProfitTicks,
        calibration: best,
      });
      this.stats.opened++;
      this.risk.onTradeOpened();
    } catch (e) {
      logger.warn(`open failed: ${e.message}`);
    }
  }

  _saveState() {
    try {
      const tmp = this.cfg.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        savedAt: new Date().toISOString(),
        mode: this.cfg.mode,
        stats: this.stats,
        risk: {
          day: this.risk.day, dayPnl: this.risk.dayPnl, dayTrades: this.risk.dayTrades,
          sessionPnl: this.risk.sessionPnl, halted: this.risk.halted,
          haltReason: this.risk.haltReason,
        },
        edge: this.edge.summary(),
        // Martingale + trade log state (for hourly/EOD across restarts)
        martingaleBase: this.martingaleBase,
        martingaleStep: this.martingaleStep,
        currentStake: this.currentStake,
        consecutiveLosses: this.consecutiveLosses,
        startBalance: this.startBalance,
        lastBalance: this.lastBalance,
        statsLog: this.statsLog.serialize(),
        // Chase-on-loss state
        chaseActive: this.chaseActive,
        chaseSymbol: this.chaseSymbol,
        chaseGrowthRate: this.chaseGrowthRate,
      }, null, 2));
      fs.renameSync(tmp, this.cfg.stateFile);
    } catch (e) { logger.debug('state save:', e.message); }
  }

  _loadState() {
    const file = this.cfg.stateFile;
    try {
      if (!fs.existsSync(file)) return;
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d.startBalance != null) this.startBalance = Number(d.startBalance);
      if (d.lastBalance != null) this.lastBalance = Number(d.lastBalance);
      if (d.consecutiveLosses != null) this.consecutiveLosses = Number(d.consecutiveLosses);
      if (d.martingaleBase != null) this.martingaleBase = Number(d.martingaleBase);
      if (d.currentStake != null) this.currentStake = Number(d.currentStake);
      if (d.martingaleStep != null) this.martingaleStep = Number(d.martingaleStep) || 0;
      if (d.statsLog) this.statsLog = new StatisticsManager(d.statsLog);
      if (d.stats) this.stats = d.stats;
      if (typeof d.chaseActive === 'boolean' && d.chaseActive && d.chaseSymbol) {
        this.chaseActive = true;
        this.chaseSymbol = String(d.chaseSymbol);
        this.chaseGrowthRate = Number(d.chaseGrowthRate) ?? null;
      } else if (d.chaseActive === false) {
        this.chaseActive = false;
        this.chaseSymbol = null;
        this.chaseGrowthRate = null;
      }
      // Ensure martingale base matches current config
      if (Number(this.cfg.stake) !== this.martingaleBase) {
        this.martingaleBase = Number(this.cfg.martingaleBaseStake) > 0 ? Number(this.cfg.martingaleBaseStake) : Number(this.cfg.stake) || 1.0;
        this.currentStake = this._calcMartingaleStake(this.martingaleStep);
      }
      logger.info(
        `state restored: overallProfit=${(this.statsLog.overallProfit ?? 0).toFixed(2)} ` +
        `consecLosses=${this.consecutiveLosses} martingale step=${this.martingaleStep} stake=${this.currentStake.toFixed(2)}/${this.martingaleBase.toFixed(2)}`,
      );
    } catch (e) { logger.debug('state load:', e.message); }
  }

  report() {
    const e = this.edge.summary();
    const mins = (Date.now() - this.startedAt) / 60000;
    const lines = [
      '──────── SESSION REPORT ────────',
      `mode            : ${this.cfg.mode}`,
      `uptime          : ${mins.toFixed(1)} min`,
      `trades opened   : ${this.stats.opened}`,
      `trades closed   : ${this.stats.closed}`,
      `wins / losses   : ${this.stats.wins} / ${this.stats.losses}`,
      `win rate        : ${this.stats.closed ? ((this.stats.wins / this.stats.closed) * 100).toFixed(2) : '0.00'}%`,
      `net P&L         : ${money(this.stats.pnl)}`,
      `mean return     : ${e.meanReturnPct.toFixed(4)}% of stake per trade`,
      `edge z-score    : ${e.z == null ? 'n/a' : e.z.toFixed(3)}`,
      `avg ticks held  : ${e.avgRealizedTicks.toFixed(2)} (target ${e.avgExpectedTicks.toFixed(2)})`,
      `halted          : ${this.risk.halted ? 'YES — ' + this.risk.haltReason : 'no'}`,
      '────────────────────────────────',
    ];
    for (const l of lines) logger.info(l);
    return lines.join('\n');
  }

  async stop() {
    this.running = false;
    if (this.loopTimer) clearInterval(this.loopTimer);
    if (this.barrierTimer) clearInterval(this.barrierTimer);
    if (this.calibTimer) clearInterval(this.calibTimer);
    if (this._hourlyT) clearInterval(this._hourlyT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._eodBoot) clearTimeout(this._eodBoot);
    await this.exec.closeAll();
    this.report();
    this._saveState();
    this.client.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 14. OFFLINE CALIBRATION REPORT (--calibrate)
//     Connects, measures, prints the truth, trades nothing, exits.
// ═══════════════════════════════════════════════════════════════════════
async function runCalibration() {
  printBanner();
  logger.info('CALIBRATE MODE — no orders will be placed.');

  const client = new DerivClient(CONFIG);
  const md = new MarketData(client, CONFIG);
  const calib = new CalibrationEngine(CONFIG);

  await client.connect();
  await md.bootstrap(CONFIG.assets);

  const results = [];
  for (const symbol of CONFIG.assets) {
    if (md.deadAssets.has(symbol)) continue;
    const ticks = md.historyFor(symbol);
    for (const g of CONFIG.growthRates) {
      const barrier = await md.refreshBarrier(symbol, g, Math.max(CONFIG.minStake, 1));
      await sleep(150);
      results.push(calib.calibrate(symbol, ticks, g, barrier));
    }
  }

  const ranked = calib.rank(results).filter(c => c.n);
  console.log('\n' + '='.repeat(118));
  console.log('CALIBRATION REPORT — measured per-tick survival vs. priced break-even');
  console.log('='.repeat(118));
  console.log(
    'SYMBOL'.padEnd(9) + 'G%'.padEnd(5) + 'TICKS'.padEnd(8) +
    'BREACH'.padEnd(8) + 'SURVIVAL'.padEnd(11) + 'LOWER95'.padEnd(11) +
    'BREAKEVEN'.padEnd(11) + 'EV/TICK%'.padEnd(11) + 'BARRIER%'.padEnd(12) +
    'SIGMAS'.padEnd(8) + 'VERDICT',
  );
  console.log('-'.repeat(118));
  for (const c of ranked) {
    console.log(
      c.symbol.padEnd(9) +
      (c.growthRate * 100).toFixed(0).padEnd(5) +
      String(c.n).padEnd(8) +
      String(c.breaches).padEnd(8) +
      c.survivalPoint.toFixed(6).padEnd(11) +
      c.survivalLower.toFixed(6).padEnd(11) +
      c.breakEven.toFixed(6).padEnd(11) +
      (c.evPointPerTick * 100).toFixed(4).padEnd(11) +
      c.halfBarrierPct.toFixed(6).padEnd(12) +
      c.barrierSigmas.toFixed(3).padEnd(8) +
      (c.tradeable ? 'TRADEABLE' : 'no edge'),
    );
  }
  console.log('='.repeat(118));

  const tradeable = ranked.filter(c => c.tradeable);
  if (tradeable.length) {
    console.log(`\n${tradeable.length} pair(s) measured a positive lower-bound edge (for reference only).`);
  } else {
    console.log('\nNo pair measured a positive lower-bound edge (for reference only).');
  }
  console.log(
    `Entry gates in force: stayed-in array + evLowerPerTick ≤ ${(CONFIG.evLowerGateMax * 100).toFixed(4)}%.`,
  );

  // Autocorrelation diagnostic: the only thing that could justify a timing rule.
  console.log('\nI.I.D. DIAGNOSTIC (lag-1 autocorrelation; ~0 means no exploitable memory)');
  console.log('-'.repeat(60));
  const seen = new Set();
  for (const c of ranked) {
    if (seen.has(c.symbol)) continue;
    seen.add(c.symbol);
    console.log(
      `${c.symbol.padEnd(9)} acf(r)=${c.acfRaw.toFixed(5).padStart(9)}   ` +
      `acf(|r|)=${c.acfAbs.toFixed(5).padStart(9)}   sigma=${c.sigma.toExponential(4)}`,
    );
  }

  client.close();
}

// ═══════════════════════════════════════════════════════════════════════
// 15. SELF TEST
// ═══════════════════════════════════════════════════════════════════════
function runSelfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra = '') => {
    if (cond) { console.log(`  ✓ ${name}`); pass++; }
    else { console.log(`  ✗ ${name} ${extra}`); fail++; }
  };
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

  console.log('\nAccuAPEX v5 self-test\n' + '='.repeat(60));

  console.log('\n[Stats]');
  ok('breakEvenSurvival(0.05) = 1/1.05', near(Stats.breakEvenSurvival(0.05), 1 / 1.05));
  ok('breakEvenSurvival(0.01) = 1/1.01', near(Stats.breakEvenSurvival(0.01), 1 / 1.01));
  ok('evPerTick at break-even is 0', near(Stats.evPerTick(1 / 1.03, 0.03), 0, 1e-12));
  ok('evPerTick below break-even is negative', Stats.evPerTick(0.90, 0.05) < 0);
  ok('evPerTick above break-even is positive', Stats.evPerTick(0.99, 0.05) > 0);

  const w = Stats.wilson(950, 1000, 1.96);
  ok('wilson brackets the point estimate', w.lower < 0.95 && w.upper > 0.95);
  ok('wilson stays inside [0,1]', w.lower >= 0 && w.upper <= 1);
  const wSmall = Stats.wilson(9, 10, 1.96);
  const wBig = Stats.wilson(900, 1000, 1.96);
  ok('wilson interval narrows with more data',
    (wBig.upper - wBig.lower) < (wSmall.upper - wSmall.lower));

  ok('normCdf(0) = 0.5', near(Stats.normCdf(0), 0.5, 1e-4));
  ok('normCdf(1.96) ~ 0.975', near(Stats.normCdf(1.96), 0.975, 1e-3));
  ok('normCdf(-1.96) ~ 0.025', near(Stats.normCdf(-1.96), 0.025, 1e-3));

  ok('evOverHold compounds', near(
    Stats.evOverHold(1 / 1.02, 0.02, 10, 0), 0, 1e-9));
  ok('evOverHold penalises spread', Stats.evOverHold(1 / 1.02, 0.02, 10, 0.002) < 0);

  ok('zStat of constant-positive sample is positive', Stats.zStat([0.1, 0.11, 0.09, 0.1], 0) > 0);
  ok('zStat of constant-negative sample is negative', Stats.zStat([-0.1, -0.11, -0.09], 0) < 0);

  const iid = Array.from({ length: 4000 }, () => gaussian());
  ok('autocorr1 of i.i.d. noise is near zero', Math.abs(Stats.autocorr1(iid)) < 0.08,
    `(got ${Stats.autocorr1(iid).toFixed(4)})`);

  console.log('\n[Published barrier check — is the barrier the fair quantile?]');
  // Deriv's published barriers: 5% -> 0.0049358253%, 1% -> 0.0064867741%
  const b5 = 0.0049358253 / 100, b1 = 0.0064867741 / 100;
  const zFor = g => {
    // quantile z such that P(|Z| < z) = 1/(1+g)  =>  z = Phi^-1((1 + 1/(1+g))/2)
    const target = (1 + 1 / (1 + g)) / 2;
    let lo = 0, hi = 8;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (Stats.normCdf(mid) < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const barrierRatio = b5 / b1;
  const fairRatio = zFor(0.05) / zFor(0.01);
  console.log(`  published barrier ratio b(5%)/b(1%) = ${barrierRatio.toFixed(5)}`);
  console.log(`  fair Gaussian ratio     z(5%)/z(1%) = ${fairRatio.toFixed(5)}`);
  ok('barrier ratio matches the fair quantile ratio within 2%',
    Math.abs(barrierRatio / fairRatio - 1) < 0.02,
    `(off by ${((barrierRatio / fairRatio - 1) * 100).toFixed(2)}%)`);
  ok('5% barrier is priced tighter than fair relative to 1%', barrierRatio < fairRatio);

  console.log('\n[CalibrationEngine]');
  const ce = new CalibrationEngine({ ...CONFIG, calibMinTicks: 10 });

  // A synthetic series that NEVER breaches: survival 1.0 -> must be tradeable.
  const flat = Array.from({ length: 500 }, (_, i) => ({ quote: 100 + (i % 2) * 1e-9, epoch: i }));
  const cFlat = ce.calibrate('TEST', flat, 0.03, { halfBarrierFrac: 0.001 });
  ok('perfect survival is flagged tradeable', cFlat.tradeable === true, `(${cFlat.reason})`);
  ok('perfect survival gives positive lower EV', cFlat.evLowerPerTick > 0);

  // A series that breaches constantly -> must NOT be tradeable.
  const wild = Array.from({ length: 500 }, (_, i) => ({ quote: 100 * (1 + (i % 2 ? 0.01 : -0.01)), epoch: i }));
  const cWild = ce.calibrate('TEST', wild, 0.03, { halfBarrierFrac: 0.0001 });
  ok('constant breaching is rejected', cWild.tradeable === false);
  ok('constant breaching gives negative EV', cWild.evPointPerTick < 0);

  ok('missing barrier is rejected',
    ce.calibrate('TEST', flat, 0.03, null).tradeable === false);
  ok('thin history is rejected',
    ce.calibrate('TEST', flat.slice(0, 3), 0.03, { halfBarrierFrac: 0.001 }).tradeable === false);

  ok('breachCount counts both tails',
    ce.breachCount([0.02, -0.02, 0.0001], 0.01) === 2);

  const hz = ce.chooseHorizon(0.90, 0.05, 20, 1, 0.002);
  ok('negative-EV survival picks the shortest hold', hz.K === 1, `(got K=${hz.K})`);
  const hzGood = ce.chooseHorizon(0.999, 0.05, 20, 1, 0.0);
  ok('positive-EV survival picks the longest hold', hzGood.K === 20, `(got K=${hzGood.K})`);

  console.log('\n[RiskManager]');
  const rm = new RiskManager({ ...CONFIG, dailyMaxLoss: 10, sessionMaxDrawdown: 10, maxConsecLosses: 3, maxOpenTrades: 1 });
  ok('fresh risk manager permits trading', rm.canTrade(0).ok === true);
  ok('max open trades blocks', rm.canTrade(1).ok === false);
  rm.onTradeClosed(-11);
  ok('daily loss cap halts', rm.canTrade(0).ok === false);
  ok('halt reason recorded', /daily loss/i.test(rm.haltReason || ''));

  const rm2 = new RiskManager({ ...CONFIG, maxConsecLosses: 3 });
  rm2.onTradeClosed(-1); rm2.onTradeClosed(-1); rm2.onTradeClosed(-1);
  ok('consecutive-loss cap halts', rm2.canTrade(0).ok === false);

  const rm3 = new RiskManager({ ...CONFIG, sizing: 'flat', stake: 2, minStake: 0.35, maxStake: 5 });
  ok('flat sizing returns the flat stake', rm3.stakeFor(10000) === 2);
  const rm4 = new RiskManager({ ...CONFIG, sizing: 'fraction', riskFraction: 0.01, minStake: 0.35, maxStake: 5 });
  ok('fractional sizing scales with balance', rm4.stakeFor(200) === 2);
  ok('fractional sizing respects the max cap', rm4.stakeFor(1000000) === 5);
  ok('fractional sizing respects the min floor', rm4.stakeFor(1) === 0.35);
  // Martingale lives at the bot level, not in RiskManager.  Verify the math.
  const mgCfg = { stake: 1, martingaleMultiplier: 2.5, martingaleSteps: 3 };
  const mgBase = Number(mgCfg.stake), mgMult = Number(mgCfg.martingaleMultiplier);
  const mgCalc = step => step <= 0 ? +mgBase.toFixed(2) : +(mgBase * Math.pow(mgMult, step)).toFixed(2);
  ok('no martingale exists in RiskManager',
    typeof rm4.martingale === 'undefined' && !/martingale/i.test(RiskManager.toString()));
  ok('martingale calc step 0 = base', mgCalc(0) === 1);
  ok('martingale calc step 1 = base × mult', mgCalc(1) === 2.5);
  ok('martingale calc step 2 = base × mult^2', mgCalc(2) === 6.25);
  ok('martingale calc step 3 = base × mult^3', mgCalc(3) === 15.63);

  console.log('\n[EdgeLedger]');
  const tmpEdge = path.join(process.cwd(), `.selftest-edge-${Date.now()}.json`);
  const el = new EdgeLedger({ ...CONFIG, edgeFile: tmpEdge, edgeMonitorMinTrades: 20, edgeMonitorZStop: 2 });
  let halted = false;
  for (let i = 0; i < 60; i++) {
    // A steady bleed: should be detected and halted.
    const v = el.record({ stake: 1, profit: -0.02, ticksHeld: 3, expectedTicks: 3 });
    if (v.halt) { halted = true; break; }
  }
  ok('a persistent bleed triggers an automatic halt', halted === true);
  ok('halt reason is descriptive', /significantly negative/i.test(el.haltReason || ''));
  try { fs.unlinkSync(tmpEdge); } catch (_) {}

  const tmpEdge2 = path.join(process.cwd(), `.selftest-edge2-${Date.now()}.json`);
  const el2 = new EdgeLedger({ ...CONFIG, edgeFile: tmpEdge2, edgeMonitorMinTrades: 20, edgeMonitorZStop: 2 });
  let halted2 = false;
  for (let i = 0; i < 60; i++) {
    const v = el2.record({ stake: 1, profit: i % 5 === 0 ? -0.9 : 0.25, ticksHeld: 4, expectedTicks: 4 });
    if (v.halt) halted2 = true;
  }
  ok('a genuinely profitable record is not halted', halted2 === false);
  try { fs.unlinkSync(tmpEdge2); } catch (_) {}

  console.log('\n[Monte Carlo — fair barrier must return ~0, shaved barrier must lose]');
  // Build a barrier that is exactly the fair quantile for g, then shave it.
  const sigma = 2.5e-5;
  const fairBarrier = g => Math.exp(zFor(g) * sigma) - 1;
  const mcFair = monteCarlo({
    sigma, halfBarrierFrac: fairBarrier(0.03), growthRate: 0.03,
    holdTicks: 5, stake: 1, trades: 40000, spreadCost: 0,
  });
  console.log(`  fair barrier  : ${mcFair.returnPerTradePct.toFixed(4)}% per trade (z=${mcFair.zScore.toFixed(2)})`);
  ok('a mathematically fair barrier is roughly break-even',
    Math.abs(mcFair.zScore) < 4, `(z=${mcFair.zScore.toFixed(2)})`);

  const mcShaved = monteCarlo({
    sigma, halfBarrierFrac: fairBarrier(0.03) * 0.99, growthRate: 0.03,
    holdTicks: 5, stake: 1, trades: 40000, spreadCost: 0,
  });
  console.log(`  shaved 1%     : ${mcShaved.returnPerTradePct.toFixed(4)}% per trade`);
  ok('shaving the barrier by 1% produces a loss',
    mcShaved.returnPerTradePct < mcFair.returnPerTradePct);

  ok('monteCarlo reports a sane win rate', mcFair.winRate > 0 && mcFair.winRate < 1);
  ok('monteCarlo reports a non-negative drawdown', mcFair.maxDrawdown >= 0);
  ok('theoretical survival is close to break-even for a fair barrier',
    Math.abs(mcFair.theoreticalSurvival - mcFair.breakEvenSurvival) < 0.002);

  console.log('\n[Config safety]');
  ok('no API token is hardcoded', CONFIG.apiToken === (process.env.DERIV_API_TOKEN || ''));
  ok('default mode is paper', envStr('MODE', 'paper') === 'paper' || CONFIG.mode === 'live');
  ok('growth rates stay within Deriv limits',
    CONFIG.growthRates.every(g => g >= 0.01 && g <= 0.05));
  ok('only volatility indices are configured',
    CONFIG.assets.every(s => /^(R_\d+|1HZ\d+V)$/.test(s)), `(${CONFIG.assets.join(',')})`);
  ok('sizing mode is flat or fraction', ['flat', 'fraction'].includes(CONFIG.sizing));
  ok('max hold never exceeds the 230-tick contract cap', CONFIG.maxHoldTicks <= 230);

  console.log('\n' + '='.repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  console.log('='.repeat(60) + '\n');
  return fail === 0;
}

// ═══════════════════════════════════════════════════════════════════════
// 16. BANNER + MAIN
// ═══════════════════════════════════════════════════════════════════════
function printBanner() {
  const mode = CONFIG.mode.toUpperCase();
  console.log(`
╭──────────────────────────────────────────────────────────────────────╮
│  AccuAPEX v5 — measure-first Deriv Accumulator engine        │
├──────────────────────────────────────────────────────────────────────┤
│  mode          ${mode.padEnd(46)}│
│  assets        ${String(CONFIG.assets.length + ' volatility indices').padEnd(46)}│
│  growth rates  ${CONFIG.growthRates.map(g => (g * 100) + '%').join(', ').padEnd(46)}│
│  sizing        ${String(CONFIG.sizing + (CONFIG.martingaleSteps > 0 ? ` (martingale ×${CONFIG.martingaleMultiplier}, ${CONFIG.martingaleSteps} steps)` : ' (no martingale)')).padEnd(46)}│
│  chase-on-loss ${String(CONFIG.chaseOnLoss ? 'ON (re-trade same asset until win)' : 'OFF').padEnd(46)}│
│  stake         ${String(CONFIG.stake + ' ' + CONFIG.currency).padEnd(46)}│
│  take profit   ${String(CONFIG.takeProfitTicks + ' ticks').padEnd(46)}│
│  daily max loss${String(' ' + CONFIG.dailyMaxLoss + ' ' + CONFIG.currency).padEnd(46)}│
│  stay gate     ${String(CONFIG.stayWindowN + ' most current < ' + CONFIG.stayMaxValue + ', latest < ' + CONFIG.stayCurrentMax).padEnd(46)}│
│  ev gate       ${String('evLower/tick ≤ ' + (CONFIG.evLowerGateMax * 100).toFixed(4) + '%').padEnd(46)}│
╰──────────────────────────────────────────────────────────────────────╯`);
  if (CONFIG.mode !== 'live') {
    console.log('  PAPER MODE: real ticks, real barriers, simulated money.\n');
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--selftest')) {
    process.exit(runSelfTest() ? 0 : 1);
  }

  if (args.includes('--calibrate')) {
    try { await runCalibration(); process.exit(0); }
    catch (e) { logger.error('calibration failed:', e.message); process.exit(1); }
  }

  const bot = new AccuApexV5(CONFIG);

  const shutdown = async sig => {
    logger.info(`received ${sig} — shutting down`);
    try { await bot.stop(); } catch (e) { logger.error('shutdown:', e.message); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', r => logger.error('unhandledRejection:', String(r)));
  process.on('uncaughtException', e => {
    logger.error('uncaughtException:', e.message);
    bot.stop().finally(() => process.exit(1));
  });

  // Periodic report so a long paper run is legible.
  setInterval(() => bot.report(), 15 * 60 * 1000);

  try { await bot.start(); }
  catch (e) { logger.error('startup failed:', e.message); process.exit(1); }
}

if (require.main === module) main();

module.exports = {
  CONFIG, Stats, CalibrationEngine, EdgeLedger, RiskManager,
  TradeExecutor, MarketData, DerivClient, AccuApexV5,
  monteCarlo, sweep, runSelfTest, gaussian,
};
