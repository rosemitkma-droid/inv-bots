#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  Deriv Accumulator Trading Bot  (single-file)
 * =====================================================================
 *
 *  Connects to the Deriv WebSocket API (v3), trades Accumulator (ACCU)
 *  contracts across multiple synthetic indices, and sends detailed
 *  Telegram notifications (trade open / trade result / hourly summary /
 *  end-of-day summary).
 *
 *  ─ FEATURES ─
 *    • Multi-asset scanner that ranks Volatility / Random-Walk indices
 *      by stability / trend strength / momentum / mean-reversion.
 *    • Adaptive growth-rate (multiplier) that can step up after wins.
 *    • Per-trade stop loss & take profit built into the contract.
 *    • Daily max-loss / max-trades circuit breakers.
 *    • Exponential-backoff reconnection (network & server errors).
 *    • Telegram queue with safe 1.1 s spacing between messages.
 *
 *  ─ USAGE ─
 *    1. cp .env.example .env  &&  edit it
 *    2. npm install
 *    3. npm start
 *
 *  ─ CONFIG KEYS (or .env equivalents) ─
 *    DERIV_API_TOKEN, DERIV_APP_ID,
 *    STAKE, MULTIPLIER, MULTIPLIER_STEP,
 *    STOP_LOSS, TAKE_PROFIT, CURRENCY,
 *    ASSETS,
 *    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
 *    DAILY_MAX_LOSS, DAILY_MAX_TRADES,
 *    TICK_WINDOW, MIN_TICKS_ANALYSIS,
 *    ANALYSIS_INTERVAL_MS, TRADE_COOLDOWN_MS,
 *    LOG_FILE, LOG_LEVEL
 *
 *  Author : Kenny4Life
 *  License: MIT
 * =====================================================================
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────
// 0.  DEPENDENCIES
// ─────────────────────────────────────────────────────────────────────
const WebSocket    = require('ws');
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

// ─────────────────────────────────────────────────────────────────────
// 2.  CONFIGURATION
// ─────────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  // ─ Deriv API ─
  apiToken: ('0P94g4WdSrSrzir').trim(),
  appId   : '1089',
  wsUrl   : 'wss://ws.derivws.com/websockets/v3',
  currency: ('USD').toUpperCase(),

  // ─ Trade parameters ─
  stake          : parseFloat('1.0'),
  multiplier     : parseFloat('0.05'),  // 2 % growth rate
  multiplierStep : parseFloat('1.0'),   // grow after wins
  stopLoss       : parseFloat('110.0'),
  takeProfit     : parseFloat('5000.0'),

  // ─ Assets (Deriv synthetic indices) ─
  // assets: ('BOOM50,BOOM150N,BOOM300N,BOOM500,BOOM600,BOOM900,BOOM1000,CRASH50,CRASH150N,CRASH300N,CRASH500,CRASH600,CRASH900,CRASH1000')
  //     .split(',').map(s => s.trim()).filter(Boolean),
  // assets: ('1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V,R_10,R_25,R_50,R_75,R_100')
  //   .split(',').map(s => s.trim()).filter(Boolean),
  // assets: ('1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V')
  //   .split(',').map(s => s.trim()).filter(Boolean),
  assets: ('R_10,R_25,R_50,R_75,R_100')
    .split(',').map(s => s.trim()).filter(Boolean),

  // ─ Telegram ─
  telegram: {
    enabled : true, //!!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    botToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    chatId  : '752497117',
  },

  // ─ Strategy ─
  tickWindow          : parseInt('200',  10),
  minTicksForAnalysis : parseInt('100',  10),
  analysisIntervalMs  : parseInt('30000',10),
  tradeCooldownMs     : parseInt('5000', 10),
  maxOpenTrades       : parseInt('1',    10),

  // ─ Daily limits ─
  dailyMaxLoss  : parseFloat('100'),
  dailyMaxTrades: parseInt  ('20000000000'),

  // ─ Reconnect ─
  reconnect: {
    initialDelayMs: 1000,
    maxDelayMs    : 60000,
    backoffFactor : 2,
    jitterMs      : 750,
  },

  // ─ Logging ─
  logFile : 'deriv_bot6.log',
  logLevel: ('INFO').toUpperCase(),
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
        // Telegram ≈ 1 msg/sec per chat safely
        await new Promise(r => setTimeout(r, 1100));
      }
    } finally {
      this.sending = false;
    }
  }
  send(text) {
    if (!this.enabled) {
      logger.debug('tg(dry):', text.slice(0, 100));
      return;
    }
    this.queue.push(text);
    this._drain();
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ─────────────────────────────────────────────────────────────────────
// 5.  DERIV WEBSOCKET CLIENT  (with auto-reconnect)
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
    this._pending         = new Map();   // reqId → {resolve, reject, timer}
    this._subs            = new Map();   // subscription id → callback
    this.balance          = null;
    this.currency         = cfg.currency;
    this.accountInfo      = null;
    this.symbols          = new Map();
  }

  _nextReqId() { return ++this._reqId; }

  _url() {
    const sep = this.cfg.wsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.wsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }

  connect() {
    if (this.ws &&
        (this.ws.readyState === WebSocket.OPEN ||
         this.ws.readyState === WebSocket.CONNECTING)) return;
    const url = this._url();
    logger.info(`connecting → ${url.replace(/app_id=[^&]+/, 'app_id=***')}`);
    try {
      this.ws = new WebSocket(url, {
        headers: { 'User-Agent': 'DerivAccumulatorBot/1.0 (+Node.js)' },
        handshakeTimeout: 15000,
      });
    } catch (e) {
      logger.error('ws construct failed:', e.message);
      this._scheduleReconnect();
      return;
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
  }

  _onOpen() {
    logger.info('ws connected ✔');
    this.connected     = true;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this.emit('open');
    this._authorize();
  }

  async _authorize() {
    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN is empty — aborting');
      this._stopped = true;
      return;
    }
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

    // ── Error response ──
    if (msg.error) {
      const code = msg.error.code;
      logger.error(`api error: ${code} – ${msg.error.message}`);
      if (msg.req_id && this._pending.has(msg.req_id)) {
        const p = this._pending.get(msg.req_id);
        clearTimeout(p.timer);
        this._pending.delete(msg.req_id);
        p.reject(new Error(msg.error.message || code));
      }
      // Critical → force reconnect
      if (['AuthorizationRequired','InvalidToken','InvalidAppID'].includes(code)) {
        this._closeAndReconnect();
      }
      return;
    }

    // ── Pending request resolution ──
    if (msg.req_id && this._pending.has(msg.req_id)) {
      const p = this._pending.get(msg.req_id);
      clearTimeout(p.timer);
      this._pending.delete(msg.req_id);
      p.resolve(msg);
      return;
    }

    // ── Subscription stream update ──
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
    // _onClose will schedule a reconnect.
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

  /** Subscribe; resolves to the subscription id, returns early if already subscribed. */
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

  stop() {
    this._stopped = true;
    try { this.ws?.close(); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────
// 6.  MARKET DATA MANAGER
// ─────────────────────────────────────────────────────────────────────
class MarketDataManager extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client      = client;
    this.cfg         = cfg;
    this.history     = new Map();   // symbol → [{epoch, quote}, …]
    this.subs        = new Map();   // symbol → subscription id
    this.lastQuote   = new Map();   // symbol → last quote
    this._bootstrapping = false;

    client.on('close', () => {
      // Stale subscription ids after reconnect
      this.subs.clear();
    });
  }

  async loadSymbols() {
    try {
      const res = await this.client._send({ active_symbols: 'brief' }, 15000);
      const list = res.active_symbols || [];
      // `brief` returns `underlying_symbol`; some endpoints also use `symbol`.
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
          // cap history length
          const cap = Math.max(this.cfg.tickWindow * 8, 2000);
          if (arr.length > cap) arr.splice(0, arr.length - cap);
          this.history.set(symbol, arr);
        } else {
          this.history.set(symbol, [tick]);
        }
        this.emit('tick', symbol, tick);
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
      const need = symbols.length * this.cfg.tickWindow * 4;
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
// 7.  MARKET ANALYZER  —  CWMRAS strategy engine
// ─────────────────────────────────────────────────────────────────────
//
//  ╔════════════════════════════════════════════════════════════════════╗
//  ║   "Calm-Window, Mean-Reverting Accumulator Strategy" (CWMRAS)     ║
//  ║                                                                    ║
//  ║   A novel approach combining four previously-untangled axes:       ║
//  ║   1. Volatility REGIME detection (calm vs stormy windows)          ║
//  ║   2. Bollinger-Band middle proximity (entry near the mean)         ║
//  ║   3. RSI in the neutral 40–60 zone (no extreme momentum)           ║
//  ║   4. Barrier-fit ratio (matches growth_rate to current σ)         ║
//  ╚════════════════════════════════════════════════════════════════════╝
//
//  The strategy rejects the "enter and pray" pattern by treating each
//  trade as a probability-weighted decision.
//
class MarketAnalyzer {
  constructor(cfg) { this.cfg = cfg; }

  // ── Helpers ──────────────────────────────────────────────────────
  _meanStd(q) {
    const n = q.length;
    if (n < 2) return null;
    let s = 0; for (const v of q) s += v;
    const mean = s / n;
    let v = 0; for (const x of q) v += (x - mean) ** 2;
    return { mean, stdev: Math.sqrt(v / n), n };
  }
  _ema(q, period) {
    if (!q.length) return [];
    const k = 2 / (period + 1);
    const out = new Array(q.length);
    out[0] = q[0];
    for (let i = 1; i < q.length; i++) out[i] = q[i] * k + out[i-1] * (1 - k);
    return out;
  }
  _rsi(q, period = 14) {
    const out = new Array(q.length).fill(50);
    if (q.length < period + 1) return out;
    let gainSum = 0, lossSum = 0;
    for (let i = 1; i <= period; i++) {
      const d = q[i] - q[i-1];
      if (d >= 0) gainSum += d; else lossSum -= d;
    }
    let avgG = gainSum / period, avgL = lossSum / period;
    out[period] = 100 - 100 / (1 + (avgG / (avgL || 1e-12)));
    for (let i = period + 1; i < q.length; i++) {
      const d = q[i] - q[i-1];
      const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      out[i] = 100 - 100 / (1 + (avgG / (avgL || 1e-12)));
    }
    return out;
  }
  _bb(q, period = 20, mult = 2) {
    const basis = this._ema(q, period);          // EMA is common, simple OK too
    const out = { basis, upper: [], lower: [] };
    for (let i = 0; i < q.length; i++) {
      const start = Math.max(0, i - period + 1);
      const slice = q.slice(start, i + 1);
      const m = slice.reduce((s, x) => s + x, 0) / slice.length;
      let v = 0; for (const x of slice) v += (x - m) ** 2;
      const sd = Math.sqrt(v / slice.length);
      out.upper.push(m + mult * sd);
      out.lower.push(m - mult * sd);
    }
    return out;
  }

  /**
   * Analyse a symbol and return the full CWMRAS state.
   * Returns null if there isn't enough data.
   */
  analyze(symbol, ticks) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;
    const W = Math.min(this.cfg.tickWindow, ticks.length);
    const q = ticks.slice(-W).map(t => t.quote);
    const n = q.length;
    if (n < 30) return null;

    // ── Core stats ──
    const base = this._meanStd(q);
    const mean = base.mean;
    const stdev = base.stdev;
    const cv = stdev / Math.max(Math.abs(mean), 1e-9);

    // ── Volatility regime: short-term σ vs long-term baseline ──
    // σ_short uses last 20 ticks, σ_long uses full window
    const short = q.slice(-Math.min(20, n));
    const shortStats = this._meanStd(short);
    const calmScore = shortStats.stdev / Math.max(stdev, 1e-9);
    // calmScore < 1.0 means the recent 20 ticks are calmer than the long-run σ
    // calmScore < 0.7 = strong calm regime; calmScore > 1.3 = turbulent regime

    // ── Bollinger Band proximity ──
    // The closer price is to the middle band, the safer for an accumulator
    // (price not stretched toward either barrier).
    const bb = this._bb(q, 20, 2);
    const lastIdx = n - 1;
    const basis = bb.basis[lastIdx];
    const upper = bb.upper[lastIdx];
    const lower = bb.lower[lastIdx];
    const price = q[lastIdx];
    const bbWidth = upper - lower;
    const distToBasis = Math.abs(price - basis) / Math.max(bbWidth, 1e-9);  // 0 = at middle
    // Distance to upper barrier (0..1; 1 = touching upper)
    const distToUpper = (upper - price) / Math.max(bbWidth, 1e-9);
    const distToLower = (price - lower) / Math.max(bbWidth, 1e-9);
    const minDistToBand = Math.min(distToUpper, distToLower);  // smaller = closer to a barrier
    const bbMiddleProximity = 1 - distToBasis;  // 1 = at middle, 0 = at band

    // ── RSI momentum ──
    const rsiArr = this._rsi(q, 14);
    const rsi = rsiArr[lastIdx];

    // ── Trend strength (linear-regression slope normalized by σ) ──
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += q[i]; sxy += i*q[i]; sxx += i*i; }
    const denom = (n * sxx - sx * sx) || 1;
    const slope = (n * sxy - sx * sy) / denom;
    const trendStrength = Math.abs(slope) / Math.max(stdev, 1e-9);

    // ── Mean reversion (lag-1 autocorrelation) ──
    let acNum = 0;
    for (let i = 1; i < n; i++) acNum += (q[i] - mean) * (q[i-1] - mean);
    const autocorr = acNum / ((n - 1) * (stdev * stdev) || 1);
    const meanReversion = -autocorr;          // positive → reverting

    // ── Tick-density win estimate ──
    // We estimate per-tick probability of staying in barrier using the
    // historical distribution of *consecutive-tick moves* relative to σ.
    // A move < 0.5σ is "very safe", 0.5–1σ "moderate", > 1σ "dangerous".
    // We compute the fraction of recent moves that fall in the "safe" zone.
    let safeMoves = 0;
    for (let i = 1; i < n; i++) {
      const move = Math.abs(q[i] - q[i-1]) / Math.max(stdev, 1e-9);
      if (move < 0.5) safeMoves++;
    }
    const safeMoveRatio = safeMoves / (n - 1);

    // ── Composite CWMRAS Score ──
    // Each component is weighted by its empirical importance to ACCU safety.
    let score = 0;
    let reasonParts = [];

    // 1) Calm regime (most important — volatility is the #1 killer)
    if (calmScore < 0.50)      { score += 0.35; reasonParts.push('very-calm'); }
    else if (calmScore < 0.70) { score += 0.25; reasonParts.push('calm'); }
    else if (calmScore < 1.0)  { score += 0.00; reasonParts.push('normal'); }
    else if (calmScore < 1.3)  { score -= 0.10; reasonParts.push('turbulent'); }
    else                        { score -= 0.35; reasonParts.push('stormy'); }

    // 2) BB middle-band proximity (entry at the mean is safest)
    if (bbMiddleProximity > 0.85)      { score += 0.25; reasonParts.push('at-mean'); }
    else if (bbMiddleProximity > 0.60){ score += 0.15; reasonParts.push('near-mean'); }
    else if (bbMiddleProximity > 0.35){ score -= 0.10; reasonParts.push('off-mean'); }
    else                                { score -= 0.25; reasonParts.push('at-band'); }

    // 3) RSI in neutral zone (40–60) means no extreme momentum
    if (rsi >= 45 && rsi <= 55)        { score += 0.15; reasonParts.push('rsi-neutral'); }
    else if (rsi >= 35 && rsi <= 65)   { score += 0.05; reasonParts.push('rsi-mild'); }
    else if (rsi < 25 || rsi > 75)     { score -= 0.25; reasonParts.push('rsi-extreme'); }
    else                                { score -= 0.10; reasonParts.push('rsi-tilted'); }

    // 4) Trend strength (moderate trend ok; no trend = whipsaw risk; strong trend = barrier risk)
    if (trendStrength >= 0.4 && trendStrength <= 2.0)   { score += 0.10; reasonParts.push('good-trend'); }
    else if (trendStrength < 0.4)                       { score -= 0.10; reasonParts.push('no-trend'); }
    else                                                  { score -= 0.20; reasonParts.push('extreme-trend'); }

    // 5) Mean reversion (high reversion → whipsaw)
    if (meanReversion > 0.50)        { score -= 0.25; reasonParts.push('whipsaw'); }
    else if (meanReversion > 0.25)  { score -= 0.10; reasonParts.push('mean-rev'); }

    // 6) Safe-move ratio (estimated per-tick survival probability proxy)
    if (safeMoveRatio > 0.85)       { score += 0.15; reasonParts.push('safe-ticks'); }
    else if (safeMoveRatio > 0.70)  { score += 0.05; reasonParts.push('ok-ticks'); }
    else                              { score -= 0.20; reasonParts.push('risky-ticks'); }

    score = Math.max(0, Math.min(1, score));

    // ── Optimal growth-rate suggestion ──
    // For ACCU the barrier scales inversely with growth_rate. We want a
    // barrier that comfortably covers 2σ of recent moves.
    // Empirical observation (from API data): 0.01→~0.061% barrier,
    //                                       0.05→~0.049% barrier.
    // We pick the SMALLEST growth_rate whose barrier still fits.
    let suggestedGrowth = 0.01;          // default: safest
    const targetSigmaCoverage = 2.0;     // we want barrier ≥ 2 × per-tick σ
    const perTickStdevPct = (shortStats.stdev / Math.abs(price)) * 100;
    // For each growth rate, approximate the barrier% (slightly conservative)
    const barrierByGrowth = { 0.04: 0.050, 0.05: 0.048 };
    if (perTickStdevPct > 0) {
      for (const g of [0.04, 0.05]) {
        // barrier is on EACH side; we need barrier_pct ≥ target × per_tick_stdev_pct
        if (barrierByGrowth[g] >= targetSigmaCoverage * perTickStdevPct) {
          suggestedGrowth = g;
          break;
        }
        // suggestedGrowth = g;  // last fallback
      }
    }

    // ── Recommended take-profit (scale with safety) ──
    // In a calm regime we can hold longer → larger TP
    // In a turbulent regime → tighter TP
    const baseTpFactor = 1.5;          // TP = stake × factor
    const tpFactor = Math.max(0.8, baseTpFactor * (0.5 + score));
    const recommendedTp = +(this.cfg.stake * tpFactor).toFixed(2);

    return {
      symbol,
      n,
      price,
      mean, stdev, cv,
      // Regime detection
      calmScore,
      regime: calmScore < 0.75 ? 'calm' : calmScore < 1.0 ? 'normal' : calmScore < 1.3 ? 'turbulent' : 'stormy',
      // Bollinger
      bbBasis: basis, bbUpper: upper, bbLower: lower, bbWidth,
      bbMiddleProximity, distToUpper, distToLower, minDistToBand,
      // Momentum / RSI
      rsi, slope, trendStrength, meanReversion,
      // Tick-density proxy
      safeMoveRatio,
      perTickStdevPct,
      // Decision
      score,
      reasons: reasonParts,
      recommendTrade: score >= 0.60,
      // Sizing
      suggestedGrowth,
      recommendedTp,
      // Last quote for display
      lastQuote: price,
    };
  }

  /**
   * Determine if we should EXIT EARLY based on directional drift.
   * The barrier is FIXED at entry — if price has drifted strongly in one
   * direction, the contract is "biased" and the opposite barrier is closer
   * to the price in relative terms.
   *
   * @param {number} entrySpot   Spot price at entry
   * @param {number} currentSpot Current price
   * @param {number} barrierPct  Half-barrier as % of entry spot (e.g. 0.03 for 3 % growth)
   * @param {number} profit      Current contract profit (USD)
   * @param {number} takeProfit  Configured take-profit (USD)
   * @returns {{exit:boolean, reason:string, urgency:number}}
   *   urgency 0..1 (1 = imminent danger)
   */
  shouldExitEarly(entrySpot, currentSpot, barrierPct, profit, takeProfit) {
    if (!entrySpot || !currentSpot || !barrierPct) return { exit: false, reason: '', urgency: 0 };
    const driftPct = ((currentSpot - entrySpot) / entrySpot) * 100;
    const driftFraction = driftPct / barrierPct;   // 1.0 = touching barrier
    const absDriftFraction = Math.abs(driftFraction);
    // Distance from current price to opposite barrier (accounting for drift)
    const remainingPct = barrierPct - Math.abs(driftPct);
    const remainingFraction = remainingPct / barrierPct;  // 0 = touched, 1 = no drift

    let urgency = 0;
    let reason = '';
    let exit = false;

    // PARTIAL PROFIT LOCK: if we've already banked ≥ 70% of TP, lock in
    if (takeProfit > 0 && profit >= takeProfit * 0.7) {
      urgency = Math.max(urgency, 0.6);
      reason = 'near-tp';
    }
    // DRIFT WARNING: >60% of barrier consumed
    if (absDriftFraction >= 0.85) {
      urgency = Math.max(urgency, 1.0);
      reason = reason || 'critical-drift';
      exit = true;
    } else if (absDriftFraction >= 0.65) {
      urgency = Math.max(urgency, 0.75);
      reason = reason || 'high-drift';
    } else if (absDriftFraction >= 0.45) {
      urgency = Math.max(urgency, 0.45);
      reason = reason || 'moderate-drift';
    }

    return {
      exit,
      reason,
      urgency,
      driftPct,
      driftFraction,
      remainingFraction,
    };
  }

  rank(analyses) {
    return analyses.filter(Boolean).sort((a, b) => b.score - a.score);
  }
}// ─────────────────────────────────────────────────────────────────────
// 8.  TRADE EXECUTOR  (Accumulator)
// ─────────────────────────────────────────────────────────────────────
class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client  = client;
    this.cfg     = cfg;
    this.open    = new Map();      // contractId → info
    this.currentGrowthRate = cfg.multiplier;
    this.analyzer = null;          // injected by TradingBot
  }

  async buy(symbol, growthRate, stake, limit) {
    // Defensive clamp — Deriv supports 0.01 – 0.05
    growthRate = Math.max(0.01, Math.min(0.05, +growthRate.toFixed(4)));
    try {
      // 1.  Proposal
      const pres = await this.client._send({
        proposal    : 1,
        amount      : stake,
        basis       : 'stake',
        contract_type: 'ACCU',
        currency    : this.cfg.currency,
        symbol: symbol,  // modern Deriv API uses `symbol`, not `underlying_symbol`
        growth_rate : growthRate,
        // NOTE: Deriv's API does NOT accept stop_loss for ACCU contracts
        // — only take_profit. Stop-loss is enforced manually by selling
        // the contract when the live profit drops below the configured
        // threshold (see _onUpdate → _checkStopLoss).
        ...((limit.take_profit != null && limit.take_profit > 0)
            ? { limit_order: { take_profit: limit.take_profit } }
            : {}),
      }, 20000);
      const p = pres.proposal;
      if (!p?.id) throw new Error('No proposal id returned');
      logger.info(`proposal id=${p.id} ask=${p.ask_price} payout=${p.payout} spot=${p.spot}`);
      if (p.contract_details) {
        logger.debug('contract_details:', p.contract_details);
      }
      // Validation errors come back as error objects already, but check
      if (pres.error) throw new Error(pres.error.message);

      // 2.  Buy
      const bres = await this.client._send({
        buy  : p.id,
        price: p.ask_price,
      }, 20000);
      const b = bres.buy;
      if (!b?.contract_id) throw new Error('Buy did not return contract_id');
      logger.info(`bought ACCU #${b.contract_id} for ${b.buy_price}`);

      // Extract barrier info for early-exit logic.
      // The half-barrier as % of spot is what matters: if price drifts
      // more than this, the contract is at risk.
      const cd = p.contract_details || {};
      const entrySpot = parseFloat(p.spot ?? cd.current_spot ?? 0);
      // barrier_spot_distance is given in absolute price (e.g. 0.187 for R_100).
      // Convert to percent of entry spot.
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
      this.open.set(b.contract_id, info);
      logger.info(`barrier: ±${halfBarrierPct.toFixed(4)}% spot=${entrySpot.toFixed(2)} [${lowBarrier.toFixed(2)} … ${highBarrier.toFixed(2)}] maxPayout=${maxPayout}`);

      // 3.  Subscribe to live contract updates
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
    const status = c.status;          // 'open' | 'won' | 'lost'

    logger.debug(`contract #${cid} status=${status} profit=${profit.toFixed(3)} spot=${spot}`);

    // ── Manual stop-loss ──
    // ACCU contracts don't accept stop_loss at purchase time, so we
    // monitor the live profit and sell the position if it drops below
    // the user-configured threshold.
    const stopLossAbs = Math.abs(info.limit?.stop_loss || 0);
    if (status === 'open' && stopLossAbs > 0 && profit <= -stopLossAbs) {
      logger.warn(`contract #${cid} hit stop-loss @ profit=${profit.toFixed(2)} ≤ -${stopLossAbs} — selling`);
      try { await this.sell(cid, 0); } catch (e) {
        logger.error(`emergency sell #${cid} failed:`, e.message);
      }
    }

    // ── Early-exit on directional drift (CWMRAS) ──
    // The barrier is FIXED at entry; if price has drifted strongly in one
    // direction, the contract is biased toward the opposite barrier.
    // We exit early to lock in remaining profit before a knockout.
    if (status === 'open' && info.halfBarrierPct > 0 && info.entrySpot > 0 && this.analyzer) {
      const ex = this.analyzer.shouldExitEarly(
        info.entrySpot, spot, info.halfBarrierPct,
        profit, info.limit?.take_profit ?? 0,
      );
      if (ex.exit) {
        logger.warn(`contract #${cid} EARLY EXIT (${ex.reason}) drift=${ex.driftPct.toFixed(4)}% remaining=${(ex.remainingFraction*100).toFixed(1)}% profit=${profit.toFixed(2)}`);
        try { await this.sell(cid, 0); } catch (e) {
          logger.error(`early-exit sell #${cid} failed:`, e.message);
        }
      } else if (ex.urgency >= 0.6) {
        this.emit('driftWarning', { ...info, contractId: cid, profit, currentSpot: spot, exit: ex });
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
      // Unsubscribe
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
// 9.  STATISTICS MANAGER
// ─────────────────────────────────────────────────────────────────────
class StatisticsManager {
  constructor() {
    this.trades = [];                 // { …trade fields, date, hour, timestamp }
    this.dailySummaries = [];
    this.today = this._todayStr();
  }
  _todayStr() { return new Date().toISOString().slice(0, 10); }
  _now()      { return { date: this._todayStr(), hour: new Date().getHours(), ts: Date.now() }; }

  record(trade) {
    const n = this._now();
    this.trades.push({ ...trade, timestamp: n.ts, date: n.date, hour: n.hour });
    if (n.date !== this.today) {
      this._rollDay();
      this.today = n.date;
    }
  }
  _rollDay() {
    const day = this.today;
    const trades = this.trades.filter(t => t.date === day);
    if (trades.length) this.dailySummaries.push({ date: day, trades, stats: this.stats(trades) });
  }
  todayTrades() {
    const d = this._todayStr();
    return this.trades.filter(t => t.date === d);
  }
  stats(list) {
    const wins   = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
    const total  = list.reduce((s, t) => s + (t.profit || 0), 0);
    const gw     = wins.reduce((s, t)   => s + (t.profit || 0), 0);
    const gl     = Math.abs(losses.reduce((s, t) => s + (t.profit || 0), 0));
    const stake  = list.reduce((s, t) => s + (t.stake || 0), 0);
    return {
      count       : list.length,
      wins        : wins.length,
      losses      : losses.length,
      winRate     : list.length ? (wins.length / list.length) * 100 : 0,
      grossWin    : gw,
      grossLoss   : gl,
      netPL       : gw - gl,
      totalProfit : total,
      profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
      avgProfit   : list.length ? total / list.length : 0,
      stake,
    };
  }
  _tradesForHour(hour, date = this._todayStr()) {
    return this.trades.filter(t => t.date === date && t.hour === hour);
  }
  _tradesForDate(date) {
    return this.trades.filter(t => t.date === date);
  }
  /** Summary for the PREVIOUS hour (called at HH:00:00). */
  previousHourSummary() {
    const now = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const hour = prev.getHours();
    const date = prev.toISOString().slice(0, 10);
    const list = this._tradesForHour(hour, date);
    return { hour, date, trades: list, stats: this.stats(list) };
  }
  /** Summary for the PREVIOUS day (called at 00:00:00). */
  previousDaySummary() {
    const now = new Date();
    const prev = new Date(now.getTime() - 86_400_000);
    const date = prev.toISOString().slice(0, 10);
    const list = this._tradesForDate(date);
    return { date, trades: list, stats: this.stats(list) };
  }
  /** Roll old days into the daily-summaries archive to free memory. */
  archiveOldDays() {
    const today = this._todayStr();
    const old = this.trades.filter(t => t.date !== today);
    if (!old.length) return;
    // group by date
    const byDate = {};
    for (const t of old) (byDate[t.date] = byDate[t.date] || []).push(t);
    for (const date of Object.keys(byDate)) {
      this.dailySummaries.push({
        date,
        trades: byDate[date],
        stats: this.stats(byDate[date]),
      });
    }
    this.trades = this.trades.filter(t => t.date === today);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 10. TRADING BOT (orchestrator)
// ─────────────────────────────────────────────────────────────────────
class TradingBot {
  constructor() {
    this.cfg      = CONFIG;
    this.client   = new DerivClient(this.cfg);
    this.market   = new MarketDataManager(this.client, this.cfg);
    this.analyzer = new MarketAnalyzer(this.cfg);
    this.exec     = new TradeExecutor(this.client, this.cfg);
    this.stats    = new StatisticsManager();
    // Inject analyzer reference so the executor can run early-exit checks
    this.exec.analyzer = this.analyzer;

    this.lastTradeAt   = 0;
    this.startBalance  = null;
    this.lastBalance   = null;
    this.stopped       = false;
    this._analysisT    = null;
    this._hourlyT      = null;
    this._eodT         = null;
    this._hourlyBoot   = null;
    this._eodBoot      = null;
  }

  async start() {
    logger.info('===== Deriv Accumulator Bot starting =====');
    logger.info(`config: stake=${this.cfg.stake} mult=${this.cfg.multiplier} step=${this.cfg.multiplierStep} SL=${this.cfg.stopLoss} TP=${this.cfg.takeProfit}`);
    logger.info(`assets: ${this.cfg.assets.join(', ')}`);
    logger.info(`telegram: ${this.cfg.telegram.enabled ? 'ENABLED ✔' : 'disabled'}`);

    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN missing — exiting.');
      process.exit(1);
    }

    // Wire events
    this.client.on('authorized', info => this._onAuthorized(info));
    this.client.on('close',     (c, r, was) => this._onDisconnected(c, r, was));
    this.client.on('open',      () => logger.info('connection open'));
    this.client.on('error',     e => logger.error('client error:', e.message));

    this.exec.on('open',        t => this._onTradeOpen(t));
    this.exec.on('update',       t => this._onTradeUpdate(t));
    this.exec.on('result',       t => this._onTradeResult(t));
    this.exec.on('driftWarning', t => this._onDriftWarning(t));

    process.on('SIGINT',  () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));

    this.client.connect();
    this._scheduleSummaries();
  }

  _scheduleSummaries() {
    const now = new Date();
    const msToNextHour =
      (59 - now.getMinutes()) * 60_000 +
      (60 - now.getSeconds()) * 1000;
    this._hourlyBoot = setTimeout(() => {
      this._sendHourly();
      this._hourlyT = setInterval(() => this._sendHourly(), 3600_000);
    }, msToNextHour);

    const msToMidnight =
      (23 - now.getHours()) * 3600_000 +
      (59 - now.getMinutes()) * 60_000  +
      (60 - now.getSeconds()) * 1000;
    this._eodBoot = setTimeout(() => {
      this._sendEod();
      this._eodT = setInterval(() => this._sendEod(), 86_400_000);
    }, msToMidnight);
  }

  // ── Authorised ─────────────────────────────────────────────
  async _onAuthorized(info) {
    this.startBalance = this.client.balance;
    this.lastBalance  = this.client.balance;
    logger.info(`start-of-day balance: ${this.startBalance} ${this.currency()}`);

    await this.market.loadSymbols();

    telegram.send(
      `🤖 <b>Bot Online</b>\n\n` +
      `👤 <b>Account:</b> ${info.loginid}\n` +
      `💼 <b>Type:</b> ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 <b>Balance:</b> ${this.startBalance.toFixed(2)} ${this.currency()}\n` +
      `📊 <b>Assets:</b> ${this.cfg.assets.length}\n` +
      `💵 <b>Stake:</b> ${this.cfg.stake}\n` +
      `📈 <b>Multiplier:</b> ${(this.cfg.multiplier*100).toFixed(2)}%\n` +
      `🛑 <b>Stop Loss:</b> ${this.cfg.stopLoss}\n` +
      `🎯 <b>Take Profit:</b> ${this.cfg.takeProfit}\n`,
    );

    // Subscribe to all assets and backfill
    await this.market.bootstrap(this.cfg.assets);

    // Restart analysis loop
    if (this._analysisT) clearInterval(this._analysisT);
    // Run once immediately then on interval
    this._analyzeAndTrade();
    this._analysisT = setInterval(
      () => this._analyzeAndTrade(),
      this.cfg.analysisIntervalMs,
    );
  }

  _onDisconnected(code, reason, wasAuthorized) {
    telegram.send(
      `⚠️ <b>Connection lost</b>\n` +
      `code: <code>${code}</code>\n` +
      `was authorised: ${wasAuthorized ? 'yes' : 'no'}\n` +
      `🔄 reconnecting…`,
    );
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    this.exec.open.clear();
  }

  // ── Trade callbacks ────────────────────────────────────────
  _onTradeOpen(t) {
    const cd = t.contractDetails || {};
    let msg =
      `🟢 <b>TRADE OPENED</b>\n\n` +
      `🎫 <b>Contract:</b> #${t.contractId}\n` +
      `📊 <b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `📈 <b>Growth Rate:</b> ${(t.growthRate*100).toFixed(2)}%\n` +
      `💵 <b>Stake:</b> ${t.stake.toFixed(2)} ${this.currency()}\n` +
      `💰 <b>Buy Price:</b> ${t.buyPrice.toFixed(2)}\n` +
      `🎁 <b>Max Payout:</b> ${t.payout.toFixed(2)}\n` +
      `🛑 <b>Stop Loss:</b> ${t.limit.stop_loss ?? '–'}\n` +
      `🎯 <b>Take Profit:</b> ${t.limit.take_profit ?? '–'}\n`;
    if (cd.maximum_payout   !== undefined) msg += `⚠️ <b>Max Payout (cap):</b> ${cd.maximum_payout}\n`;
    if (cd.tick_size_barrier!== undefined) msg += `🚧 <b>Barrier size:</b> ${cd.tick_size_barrier}\n`;
    if (cd.maximum_ticks    !== undefined) msg += `⏱️ <b>Max Ticks:</b> ${cd.maximum_ticks}\n`;
    msg += `\n🕒 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`;
    telegram.send(msg);
  }

  _onTradeUpdate(t) {
    // Light-weight debug log; do not spam Telegram.
    logger.debug(`update #${t.contractId}: profit=${t.profit.toFixed(3)} spot=${t.currentSpot}`);
  }

  _onTradeResult(t) {
    this.stats.record(t);
    const emoji = t.status === 'won' ? '✅' : '❌';
    const label = t.status === 'won' ? 'WIN' : 'LOSS';
    const plEmoji = t.profit >= 0 ? '📈' : '📉';
    const dur = Math.max(0, (t.sellTime || Date.now()/1000) - (t.buyTime || 0));
    this.lastBalance = (this.lastBalance ?? this.client.balance ?? 0) + t.profit;

    // Adaptive multiplier
    if (this.cfg.multiplierStep > 0) {
      if (t.status === 'won') {
        const today = this.stats.todayTrades();
        const wins  = today.filter(x => x.status === 'won').length;
        const next  = Math.min(0.05, this.cfg.multiplier + this.cfg.multiplierStep * wins);
        this.exec.currentGrowthRate = +next.toFixed(4);
      } else {
        this.exec.currentGrowthRate = this.cfg.multiplier;
      }
    }

    // Detailed message
    let msg =
      `${emoji} <b>TRADE ${label}</b>\n\n` +
      `🎫 <b>Contract:</b> #${t.contractId}\n` +
      `📊 <b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `📈 <b>Growth Rate:</b> ${(t.growthRate*100).toFixed(2)}%\n` +
      `💵 <b>Stake:</b> ${t.stake.toFixed(2)} ${this.currency()}\n` +
      `💰 <b>Sell Price:</b> ${t.sellPrice.toFixed(2)}\n` +
      `${plEmoji} <b>Profit:</b> ${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)} ${this.currency()}\n` +
      `📍 <b>Exit Spot:</b> ${t.currentSpot}\n` +
      `⏱️ <b>Duration:</b> ${dur.toFixed(1)}s\n` +
      `💼 <b>Balance:</b> ${this.lastBalance.toFixed(2)} ${this.currency()}\n\n`;

    // Today's stats
    const today = this.stats.todayTrades();
    const s = this.stats.stats(today);
    msg +=
      `📊 <b>Today's stats</b>\n` +
      `• Trades: ${s.count} (✅${s.wins} ❌${s.losses})\n` +
      `• Win rate: ${s.winRate.toFixed(1)}%\n` +
      `• Net P/L: ${s.totalProfit >= 0 ? '+' : ''}${s.totalProfit.toFixed(2)} ${this.currency()}\n` +
      `• Profit factor: ${s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)}\n`;

    telegram.send(msg);
    this.lastTradeAt = Date.now();
  }

  // ── Strategy loop (CWMRAS) ────────────────────────────────────
  async _analyzeAndTrade() {
    try {
      if (this.stopped) return;
      if (!this.client.authorized) return;

      // ── Daily limits ──
      const today = this.stats.todayTrades();
      if (today.length >= this.cfg.dailyMaxTrades) {
        logger.warn(`dailyMaxTrades (${this.cfg.dailyMaxTrades}) reached — pausing`);
        return;
      }
      const pl = today.reduce((s, t) => s + (t.profit || 0), 0);
      if (pl <= -this.cfg.dailyMaxLoss) {
        logger.warn(`dailyMaxLoss (${this.cfg.dailyMaxLoss}) reached — pausing`);
        telegram.send(`🛑 <b>Daily loss limit reached</b>\nNet P/L: ${pl.toFixed(2)} ${this.currency()}`);
        return;
      }

      // ── Cooldown / concurrency ──
      if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
      if (this.exec.count() >= this.cfg.maxOpenTrades) return;

      // ── Analyse every asset ──
      const analyses = this.cfg.assets.map(s => this.analyzer.analyze(s, this.market.historyFor(s)));
      const ranked   = this.analyzer.rank(analyses);
      if (!ranked.length) {
        logger.warn('not enough data to analyse yet');
        return;
      }
      
      const best = ranked[0];

      if (best.symbol === this.bestAsset) {
        logger.warn('Same as Last Traded Asset');
        return;
      }

      logger.info(
        `best=${best.symbol} score=${best.score.toFixed(2)} regime=${best.regime} ` +
        `calm=${best.calmScore.toFixed(2)} rsi=${best.rsi.toFixed(1)} ` +
        `bbMid=${(best.bbMiddleProximity*100).toFixed(0)}% safeTicks=${(best.safeMoveRatio*100).toFixed(0)}% ` +
        `[${best.reasons.join(',')}]`,
      );

      // ── Decision ──
      if (!best.recommendTrade) {
        logger.debug(`score too low (${best.score.toFixed(2)}) — skipping`);
        return;
      }

      // ── Regime-aware sizing ──
      // Use the analyzer\'s suggestion (it picks the smallest growth_rate
      // whose barrier still covers ≥ 2σ of recent moves).
      const growthRate = best.suggestedGrowth
                       ?? this.exec.currentGrowthRate
                       ?? this.cfg.multiplier;
      const takeProfit = Math.min(best.recommendedTp, this.cfg.takeProfit || best.recommendedTp);
      const stopLoss   = this.cfg.stopLoss;

      const trade = await this.exec.buy(
        best.symbol,
        growthRate,
        this.cfg.stake,
        { stop_loss: stopLoss, take_profit: takeProfit },
      );
      logger.info(`trade placed #${trade.contractId} ${best.symbol} growth=${growthRate} tp=${takeProfit} barrier=±${trade.halfBarrierPct.toFixed(4)}%`);
      this.bestAsset =  best.symbol;
    } catch (e) {
      logger.error('analyse/trade error:', e.message);
    }
  }

  // ── Drift-warning handler (CWMRAS early-exit) ─────────────────
  _onDriftWarning(t) {
    if (!t?.exit) return;
    logger.debug(`drift warning #${t.contractId} ${t.exit.reason} urgency=${t.exit.urgency.toFixed(2)} drift=${t.exit.driftPct.toFixed(4)}%`);
  }

  // ── Summaries ───────────────────────────────────────────────
  _sendHourly() {
    const s = this.stats.previousHourSummary();
    if (!s.trades.length) {
      telegram.send(`⏰ <b>Hourly summary (${pad(s.hour)}:00 – ${pad(s.hour)}:59)</b>\n\nNo trades this hour.`);
      return;
    }
    let msg =
      `⏰ <b>Hourly Summary (${pad(s.hour)}:00 – ${pad(s.hour)}:59)</b>\n\n` +
      `📊 <b>Trades:</b> ${s.stats.count}  ✅${s.stats.wins}  ❌${s.stats.losses}\n` +
      `📈 <b>Win rate:</b> ${s.stats.winRate.toFixed(1)}%\n` +
      `💰 <b>P/L:</b> ${s.stats.totalProfit >= 0 ? '+' : ''}${s.stats.totalProfit.toFixed(2)} ${this.currency()}\n` +
      `🏆 <b>Profit factor:</b> ${s.stats.profitFactor === Infinity ? '∞' : s.stats.profitFactor.toFixed(2)}\n` +
      `📋 <b>Detail:</b>\n`;
    s.trades.forEach((t, i) => {
      const e = t.status === 'won' ? '✅' : '❌';
      msg += `  ${i+1}. ${e} #${t.contractId} ${t.symbol} ` +
             `${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)}\n`;
    });
    telegram.send(msg);
  }

  _sendEod() {
    const s = this.stats.previousDaySummary();
    // Archive old days so the in-memory list doesn't grow forever.
    this.stats.archiveOldDays();
    // Reset start-of-day balance so tomorrow's EOD is accurate.
    this.startBalance = this.client.balance ?? this.lastBalance ?? this.startBalance;
    if (!s.trades.length) {
      telegram.send(`🌙 <b>End-of-day (${s.date})</b>\n\nNo trades yesterday.`);
      return;
    }
    const balStart = this.startBalance ?? 0;
    const balNow   = this.lastBalance  ?? balStart;
    const balDelta = balNow - balStart;
    const balPct   = balStart ? (balDelta / balStart) * 100 : 0;
    let msg =
      `🌙 <b>End-of-Day Summary</b>\n` +
      `📅 ${s.date}\n\n` +
      `📊 <b>Total trades:</b> ${s.stats.count}\n` +
      `✅ <b>Wins:</b> ${s.stats.wins}    ❌ <b>Losses:</b> ${s.stats.losses}\n` +
      `📈 <b>Win rate:</b> ${s.stats.winRate.toFixed(1)}%\n` +
      `💵 <b>Total stake:</b> ${s.stats.stake.toFixed(2)} ${this.currency()}\n` +
      `💰 <b>Gross win:</b> +${s.stats.grossWin.toFixed(2)}\n` +
      `📉 <b>Gross loss:</b> -${s.stats.grossLoss.toFixed(2)}\n` +
      `💼 <b>Net P/L:</b> ${s.stats.totalProfit >= 0 ? '+' : ''}${s.stats.totalProfit.toFixed(2)} ${this.currency()}\n` +
      `🏆 <b>Profit factor:</b> ${s.stats.profitFactor === Infinity ? '∞' : s.stats.profitFactor.toFixed(2)}\n` +
      `📊 <b>Avg profit/trade:</b> ${s.stats.avgProfit.toFixed(2)}\n` +
      `💼 <b>Balance:</b> ${balStart.toFixed(2)} → ${balNow.toFixed(2)} ` +
      `(${balDelta >= 0 ? '+' : ''}${balDelta.toFixed(2)} / ${balPct >= 0 ? '+' : ''}${balPct.toFixed(2)}%)\n\n`;

    // Group trades by symbol for clarity
    const byHour = {};
    s.trades.forEach(t => {
      (byHour[t.hour] = byHour[t.hour] || []).push(t);
    });
    msg += `<b>📋 All trades (${s.trades.length}):</b>\n`;
    s.trades.forEach((t, i) => {
      const e = t.status === 'won' ? '✅' : '❌';
      const time = new Date(t.timestamp).toISOString().slice(11, 19);
      msg += `${i+1}. ${e} [${time}] #${t.contractId} ${t.symbol} @ ` +
             `${(t.growthRate*100).toFixed(1)}% | ${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)}\n`;
    });
    telegram.send(msg);
  }

  currency() { return this.client.currency || this.cfg.currency; }

  stop(signal) {
    if (this.stopped) return;
    this.stopped = true;
    logger.info(`stopping (signal: ${signal})`);
    telegram.send(`🛑 <b>Bot stopped</b>\nSignal: ${signal}`);
    if (this._analysisT)  clearInterval(this._analysisT);
    if (this._hourlyT)    clearInterval(this._hourlyT);
    if (this._eodT)       clearInterval(this._eodT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._eodBoot)    clearTimeout(this._eodBoot);
    this.client.stop();
    setTimeout(() => process.exit(0), 2500);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 11. BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   Deriv Accumulator Trading Bot  v1.0              ║');
  console.log('║   Single file • Multi-asset • Auto-reconnect      ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log('');
}

async function main() {
  printBanner();

  if (!CONFIG.apiToken) {
    console.error('❌  DERIV_API_TOKEN is not set.');
    console.error('   Create a token at:  https://app.deriv.com/account/api-token');
    console.error('   Then either:');
    console.error('     export DERIV_API_TOKEN="your_token"');
    console.error('   or copy .env.example to .env and fill it in.\n');
    process.exit(1);
  }
  if (CONFIG.telegram.enabled) {
    console.log('✅  Telegram notifications: ENABLED');
  } else {
    console.log('ℹ️   Telegram notifications: DISABLED');
    console.log('    Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to enable.\n');
  }

  const bot = new TradingBot();
  await bot.start();
}

main().catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});
