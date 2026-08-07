#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  AccuPULSE2b — Adaptive EV / Barrier-correct Accumulator (AEBA)
 * =====================================================================
 *
 *  Single-file Deriv Accumulator trading bot. v2 (re-engineered).
 *
 *  ─ WHAT CHANGED vs v1 (ARCA) ─
 *  v1 scored entry via a weighted soft "confidence" of proxy indicators
 *  (vol regime, trend, survival-trend, session) and bought at a 5%
 *  growth rate almost continuously. The math did not match reality:
 *    • A 5%-of-spot barrier on R_100 (tick σ ≈ 1.7%) has per-tick
 *      survival p̂ ≈ 0.997 — the contract is a near-guaranteed 5%/tick
 *      compounding machine ONLY if returns are IID and you ignore costs.
 *      It is not a "30–45% knockout" gamble as the v1 header implied.
 *    • Unconditional IID is fair-minus-spread; the ONLY honest edge is
 *      CONDITIONAL: enter when realized/forecast tick hazard is below
 *      the level the chosen growth rate implies (vol-compression), and
 *      stand idle otherwise.
 *    • `ticks_stayed_in` is a STALE proposal-time drift sample, not a
 *      live knockout rate. Treating high survival as "good" inverted the
 *      gate. It is now used only as a classifier cross-check.
 *    • The barrier gate was a constant (barrScore = 0.6). Now the live
 *      barrier % (tick_size_barrier_percentage / barrier_spot_distance)
 *      is the CORE of the model.
 *    • Reliability: reconnect orphaned the open contract and double-
 *      entered; a sell streamed status 'sold' which was never handled, so
 *      the bot deadlocked after the first early exit. Both fixed below.
 *
 *  ─ STRATEGY (AEBA) ─
 *  For each symbol and growth-rate candidate g:
 *      EV(g)  =  (1+g) · p̂_tick  −  1  −  costHaircut
 *      p̂_tick = P(|1-tick log return| < barrier%)  under a heavy-tailed
 *               distribution, with a vol-of-vol (regime) haircut.
 *  Enter only the symbol/rate with max EV(g), and only if:
 *      EV(g) ≥ minEdge                  (hard gate, net of costs)
 *      S(survive K ticks) ≥ survivalFloor  (survival floor)
 *      realized σ in a calm regime      (vol-compression / vol-of-vol)
 *      barrier known from live proposal (never fabricated)
 *  Growth rate is chosen by argmax EV(g), not by a fixed heuristic.
 *  If no asset clears the floor → stand idle (correct behavior).
 *
 *  ─ EXIT POLICY ─
 *  • Hazard/drift exit: sell when spot has drifted a set fraction of the
 *    barrier (risk of imminent knockout).
 *  • Profit-lock: bank when remaining model EV ≤ realized profit (this
 *    makes `profitLockFrac` actually do something).
 *  • TP as growth-multiple target: exit near a target P/L derived from
 *    the model's per-tick edge, not a fixed dollar scalp.
 *  • Watchdog force-settle on stuck open contracts.
 *
 *  ─ RISK ─
 *  • hard session/daily loss, daily max trades (default finite),
 *    drawdown reducers, loss-streak circuit breakers, kill-switch flags
 *  • correlation haircut across the R_* / 1HZ* vol set (they are highly
 *    related; trading them as independent inflates "edge")
 *  • anti-martingale retained but bounded (fractional-Kelly-ish)
 *
 *  ─ OPERATIONS ─
 *  Telegram (bounded queue), GMT pause windows, hourly + EOD summaries,
 *  atomic state save (tmp+rename), reconnect with reconcile-on-resume,
 *  `node accuPULSE2b.js --selftest` (pure math + Monte Carlo, no network).
 *
 *  Author: Cowork 3P  |  License: MIT
 * =====================================================================
 */

// ═══════════════════════════════════════════════════════════════════════
// 0. DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════════
const WebSocket    = require('ws');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { URL }      = require('url');
const EventEmitter = require('events');

// ═══════════════════════════════════════════════════════════════════════
// 1. CONFIGURATION  (credentials retained from reference bots)
// ═══════════════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
  // ── Deriv API ──
  // apiToken  : ('0P94g4WdSrSrzir').trim(),   // retained from reference
  // appId     : '1089',
  apiToken:    'pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee',
  appId:       '33uslPtthXBEkQOdfKfoY',
  wsUrl     : 'wss://ws.derivws.com/websockets/v3',
  currency  : 'USD',
  accountType: 'demo',    // 'demo' | 'real'

  // ── Trade parameters ──
  stake           : parseFloat('5.0'),
  growthRate      : parseFloat('0.05'),    // base growth rate (candidate grid starts here)
  stopLoss        : parseFloat('100.0'),   // hard $ stop per contract (now actually wired)
  takeProfit      : parseFloat('5000.0'),  // hard $ session take-profit (wired as circuit-breaker)

  // ── Anti-Martingale (win-streak compounding) ──
  winsBeforeScaling     : parseInt('3'),
  winStakeMultiplier    : parseFloat('1.5'),
  maxWinStakeMultiplier : parseFloat('4.0'),

  // ── Assets ──
  // assets: ('R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V,BOOM50,BOOM150N,BOOM300N,BOOM500,BOOM600,BOOM900,BOOM1000,CRASH50,CRASH150N,CRASH300N,CRASH500,CRASH600,CRASH900,CRASH1000')
  //   .split(',').map(s => s.trim()).filter(Boolean),

  assets: ('R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V')
    .split(',').map(s => s.trim()).filter(Boolean),

  // ── Telegram (retained) ──
  telegram: {
    enabled : true,
    botToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    chatId  : '752497117',
  },

  // ── Strategy: AEBA tunables ──
  tickWindow          : parseInt('500', 10),
  minTicksForAnalysis : parseInt('200', 10),
  analysisIntervalMs  : parseInt('8000', 10),
  tradeCooldownMs     : parseInt('5000', 10),
  maxOpenTrades       : parseInt('1', 10),

  // ── AEBA edge / survival gates ──
  // Hard gate: EV(g) net of costs must be ≥ minEdge to enter.
  // Growth-grid edge floor, in dollars per stake-dollar (0.005 = 0.5%/tick).
  minEdge            : parseFloat('0.002'),
  // Survival floor: probability of surviving a planned hold of K ticks.
  survivalFloor      : parseFloat('0.55'),
  planHoldTicks      : parseInt('20', 10),
  // Vol-of-vol / regime: only enter when current tick σ is calm relative
  // to its own recent history (compression ⇒ higher p̂).
  volPercentileMax   : parseFloat('0.70'),
  // Spread / cost haircut applied to EV(g) per tick (fraction of stake).
  costHaircutPct     : parseFloat('0.0015'),
  // Heavy-tailed σ multiplier for the knockout-probability model (hazard
  // is fatter than Gaussian; q in [1,∞), higher = fatter).
  heavyTailQ         : parseFloat('1.3'),
  // Growth-rate candidates to evaluate. Selection = argmax EV(g).
  growthRates        : Object.freeze([0.01, 0.02, 0.03, 0.04, 0.05]), //0.01, 0.02, 0.03, 0.04, 0.05

  // ── AEBA weights (informational / diagnostics only; not a soft gate) ──
  weights: {
    volRegime  : parseFloat('0.25'),
    trendAlign : parseFloat('0.20'),
    survival   : parseFloat('0.25'),
    barrier    : parseFloat('0.15'),
    session    : parseFloat('0.15'),
  },

  // ── Exit strategy ──
  earlyExitDriftFrac   : parseFloat('0.55'),   // sell if drift > 55% of barrier
  profitLockFrac       : parseFloat('0.50'),   // bank if realized ≥ 50% of remaining model EV

  // ── Graduated drawdown ──
  ddFullStake    : parseFloat('0.05'),
  ddReduce25     : parseFloat('0.10'),
  ddReduce50     : parseFloat('0.15'),
  ddStopTrading  : parseFloat('0.70'),

  // ── Streak circuit breakers ──
  streakReduceStake  : parseInt('3'),
  streakPauseMinutes : parseInt('10'),
  streakStopDay      : parseInt('7'),

  // ── Daily limits (real caps now) ──
  dailyMaxLoss   : parseFloat('150'),
  dailyMaxTrades : parseInt('40000'),

  // ── Reconnect ──
  reconnect: {
    initialDelayMs: 1000,
    maxDelayMs    : 60000,
    backoffFactor : 2,
    jitterMs      : 750,
  },

  // ── Barrier refresh ──
  barrierRefreshMs: parseInt('45000', 10),

  // ── Trade watchdog ──
  tradeWatchdogMs: parseInt('90000', 10),

  // ── Logging ──
  logFile : 'accuPULSE2bc_004.log',
  logLevel: 'INFO',

  // ── State persistence ──
  stateFile           : 'accuPULSE2bc_state_004.json',
  stateSaveOnTrade    : true,
  stateSaveOnShutdown : true,

  // ── EOD scheduling (GMT) ──
  eodTimeGmt          : '00:00',
  eodSendDelaySeconds : parseInt('10', 10),
  hourlySummary       : true,
});

// ═══════════════════════════════════════════════════════════════════════
// 2. LOGGER
// ═══════════════════════════════════════════════════════════════════════
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.INFO;
const pad = n => String(n).padStart(2, '0');
const ts = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
function _writeLog(line) { try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (_) {} }
function log(level, msg, ...rest) {
  if ((LOG_LEVELS[level] ?? 1) > currentLevel) return;
  const extras = rest.map(a => {
    if (a instanceof Error) return a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
  const line = `[${ts()}] [${level}] ${msg}${extras ? ' ' + extras : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  _writeLog(line);
}
const logger = {
  error: (m, ...a) => log('ERROR', m, ...a),
  warn : (m, ...a) => log('WARN',  m, ...a),
  info : (m, ...a) => log('INFO',  m, ...a),
  debug: (m, ...a) => log('DEBUG', m, ...a),
};

// ═══════════════════════════════════════════════════════════════════════
// 3. TELEGRAM NOTIFIER  (bounded queue; flush on shutdown)
// ═══════════════════════════════════════════════════════════════════════
class TelegramNotifier extends EventEmitter {
  constructor(cfg) {
    super();
    this.enabled = cfg.enabled;
    this.botToken = cfg.botToken;
    this.chatId = cfg.chatId;
    this.queue = [];
    this.maxQueue = 60;              // backpressure: drop oldest beyond cap
    this.sending = false;
  }
  _post(text) {
    return new Promise(resolve => {
      if (!this.enabled) return resolve(false);
      try {
        const payload = JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
        const url = new URL(`https://api.telegram.org/bot${this.botToken}/sendMessage`);
        const req = https.request({
          method: 'POST', hostname: url.hostname, path: url.pathname,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, res => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode === 200)); });
        req.on('error', e => { logger.warn('telegram error:', e.message); resolve(false); });
        req.setTimeout(10000, () => { req.destroy(new Error('tg timeout')); });
        req.write(payload);
        req.end();
      } catch (e) { logger.warn('telegram exception:', e.message); resolve(false); }
    });
  }
  async _drain() {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    try { while (this.queue.length) { await this._post(this.queue.shift()); await new Promise(r => setTimeout(r, 1100)); } }
    finally { this.sending = false; }
  }
  send(text) {
    if (!this.enabled) { logger.debug('tg(dry):', text.slice(0, 100)); return; }
    this.queue.push(text);
    if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue);
    this._drain();
  }
  async flush() {
    while (this.queue.length) await this._post(this.queue.shift());
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ═══════════════════════════════════════════════════════════════════════
// 4. DERIV REST CLIENT  (PAT/OAuth)
// ═══════════════════════════════════════════════════════════════════════
class RestClient {
  constructor(baseUrl, appId, token) {
    this.baseUrl = baseUrl || 'https://api.derivws.com';
    this.appId = appId || '1089';
    this.token = token || '';
  }
  static isPat(token) {
    return typeof token === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
  }
  _request(method, reqPath, body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(reqPath, this.baseUrl); } catch (e) { return reject(new Error(`Invalid URL: ${reqPath}`)); }
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : require('http');
      const opts = {
        method, hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Deriv-App-ID': this.appId, 'Authorization': 'Bearer ' + this.token,
          'Accept': 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        timeout: 15000,
      };
      const req = lib.request(opts, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => { let parsed = data; try { parsed = JSON.parse(data); } catch (_) {} resolve({ status: res.statusCode, body: parsed }); });
      });
      req.on('timeout', () => { req.destroy(new Error('REST timeout')); });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
  async get(p) { return this._request('GET', p); }
  async post(p, b) { return this._request('POST', p, b); }
}

// ═══════════════════════════════════════════════════════════════════════
// 5. DERIV WEBSOCKET CLIENT
// ═══════════════════════════════════════════════════════════════════════
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
    this._rest = this._isPat ? new RestClient('https://api.derivws.com', cfg.appId, cfg.apiToken) : null;
    this._otpUrl = null;
    this._targetAccount = null;
  }

  _nextReqId() { return ++this._reqId; }

  _url() {
    const sep = this.cfg.wsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.wsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }

  _redact(url) { return url.replace(/([?&])(otp|app_id|token)=[^&]+/g, '$1$2=***').replace(/wss:\/\/[^/]+/, m => m); }

  _openWs(url) {
    try {
      this.ws = new WebSocket(url, { headers: { 'User-Agent': 'AccuPULSE2b/2.0 (+Node.js)' }, handshakeTimeout: 15000 });
    } catch (e) { logger.error('ws construct failed:', e.message); this._scheduleReconnect(); return false; }
    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', d => this._onMessage(d));
    this.ws.on('error', e => this._onError(e));
    this.ws.on('close', (c, r) => this._onClose(c, r));
    this.ws.on('unexpected-response', (_, res) => {
      logger.error('ws handshake failed:', res.statusCode, res.statusMessage);
      try { res.destroy(); } catch (_) {} this._scheduleReconnect();
    });
    return true;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (!this.cfg.apiToken) { logger.error('API token empty'); this._stopped = true; return; }
    if (this._isPat) {
      logger.info('PAT token detected → new API (OTP flow)');
      this._newApiConnect().catch(e => { logger.error('new API connect failed:', e.message); this._scheduleReconnect(); });
    } else {
      const url = this._url();
      logger.info(`connecting → ${this._redact(url)}`);
      this._openWs(url);
    }
  }

  async _newApiConnect() {
    const desiredType = (this.cfg.accountType || 'demo').toLowerCase();
    const accRes = await this._rest.get('/trading/v1/options/accounts');
    if (accRes.status !== 200) {
      const msg = accRes.body?.errors?.[0]?.message || accRes.body?.message || JSON.stringify(accRes.body);
      throw new Error(`account list failed (${accRes.status}): ${msg}`);
    }
    const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
    if (!accounts.length) throw new Error('no Options accounts found');
    const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desiredType) || accounts[0];
    this._targetAccount = acct;
    this.accountInfo = { loginid: acct.account_id, email: acct.email, isVirtual: (acct.account_type || '').toLowerCase() === 'demo', accountType: acct.account_type, currency: acct.currency, balance: parseFloat(acct.balance), group: acct.group };
    const otpPath = `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`;
    const otpRes = await this._rest.post(otpPath);
    if (otpRes.status !== 200) throw new Error(`OTP failed (${otpRes.status}): ${JSON.stringify(otpRes.body)}`);
    const wsUrl = otpRes.body?.data?.url;
    if (!wsUrl || !/^wss?:/i.test(wsUrl)) throw new Error('OTP missing data.url');
    this._otpUrl = wsUrl;
    logger.info(`connecting OTP → ${this._redact(wsUrl)}`);
    this._openWs(wsUrl);
  }

  _onOpen() {
    logger.info('ws connected');
    this.connected = true;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this.emit('open');
    if (this._isPat) this._newApiMarkAuthorized();
    else this._authorize();
  }

  _newApiMarkAuthorized() {
    if (!this.accountInfo) return;
    this.authorized = true;
    this.balance = this.accountInfo.balance ?? null;
    this.currency = this.accountInfo.currency || this.cfg.currency;
    logger.info(`authorized ${this.accountInfo.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) bal=${this.balance}`);
    this.emit('authorized', this.accountInfo);
  }

  async _authorize() {
    try {
      const res = await this._send({ authorize: this.cfg.apiToken }, 20000);
      this.authorized = true;
      this.balance = parseFloat(res.authorize.balance);
      this.currency = res.authorize.currency || this.cfg.currency;
      this.accountInfo = { loginid: res.authorize.loginid, email: res.authorize.email, isVirtual: !!res.authorize.is_virtual, accountType: res.authorize.account_type };
      logger.info(`authorized ${res.authorize.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) bal=${this.balance}`);
      this.emit('authorized', this.accountInfo);
    } catch (e) { logger.error('auth failed:', e.message); this.authorized = false; this._scheduleReconnect(); }
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.error) {
      const code = msg.error.code;
      const RACE = new Set(['BetExpired','TradingDurationNotAllowed','ContractNotFound','InvalidContract']);
      if (!RACE.has(code)) logger.error(`api error: ${code} – ${msg.error.message}`);
      if (msg.req_id && this._pending.has(msg.req_id)) {
        const p = this._pending.get(msg.req_id); clearTimeout(p.timer); this._pending.delete(msg.req_id);
        p.reject(new Error(msg.error.message || code));
      }
      if (['AuthorizationRequired','InvalidToken','InvalidAppID'].includes(code)) this._closeAndReconnect();
      return;
    }
    if (msg.req_id && this._pending.has(msg.req_id)) {
      const p = this._pending.get(msg.req_id); clearTimeout(p.timer); this._pending.delete(msg.req_id); p.resolve(msg);
      return;
    }
    if (msg.subscription?.id && this._subs.has(msg.subscription.id)) {
      try { this._subs.get(msg.subscription.id)(msg); } catch (e) { logger.error('sub error:', e.message); }
    }
  }

  _onError(err) { logger.error('ws error:', err.message); this.emit('error', err); }

  _onClose(code, reason) {
    const r = (() => { try { return reason?.toString(); } catch { return ''; } })();
    logger.warn(`ws closed code=${code} reason=${r || 'none'}`);
    const wasAuth = this.authorized;
    this.connected = false; this.authorized = false;
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('Connection closed')); }
    this._pending.clear(); this._subs.clear();
    this.emit('close', code, reason, wasAuth);
    if (!this._stopped) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnecting) return;
    this._reconnecting = true; this._reconnectAttempt++;
    const base = Math.min(this.cfg.reconnect.initialDelayMs * Math.pow(this.cfg.reconnect.backoffFactor, this._reconnectAttempt - 1), this.cfg.reconnect.maxDelayMs);
    const delay = base + Math.random() * this.cfg.reconnect.jitterMs;
    logger.info(`reconnect #${this._reconnectAttempt} in ${(delay / 1000).toFixed(1)}s`);
    setTimeout(() => { this._reconnecting = false; this.connect(); }, delay);
  }

  _closeAndReconnect() { try { this.ws?.close(); } catch (_) {} }

  _send(payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = this._nextReqId();
      const text = JSON.stringify({ ...payload, req_id: reqId });
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) { this._pending.delete(reqId); reject(new Error(`Timeout: ${payload.proposal ?? payload.buy ?? 'req'}`)); }
      }, timeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });
      try { this.ws.send(text); } catch (e) { clearTimeout(timer); this._pending.delete(reqId); reject(e); }
    });
  }

  subscribe(payload, callback, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = this._nextReqId();
      const text = JSON.stringify({ ...payload, req_id: reqId, subscribe: 1 });
      const timer = setTimeout(() => { if (this._pending.has(reqId)) { this._pending.delete(reqId); reject(new Error('Sub timeout')); } }, timeoutMs);
      this._pending.set(reqId, {
        resolve: msg => { const subId = msg.subscription?.id; if (subId) { this._subs.set(subId, callback); resolve(subId); } else reject(new Error('No sub id')); },
        reject, timer,
      });
      try { this.ws.send(text); } catch (e) { clearTimeout(timer); this._pending.delete(reqId); reject(e); }
    });
  }

  forget(subId) {
    if (!subId) return Promise.resolve();
    this._subs.delete(subId);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    return this._send({ forget: subId }, 8000).catch(() => {});
  }

  stop() { this._stopped = true; try { this.ws?.close(); } catch (_) {} }
}

// ═══════════════════════════════════════════════════════════════════════
// 6. MARKET DATA MANAGER
// ═══════════════════════════════════════════════════════════════════════
class MarketDataManager extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.history = new Map();
    this.subs = new Map();
    this.lastQuote = new Map();
    this.stayCache = new Map();
    this._barrierCache = new Map();
    this._refreshInFlight = false;
    this._bootstrapping = false;
    client.on('close', () => this.subs.clear());
  }

  cacheStays(symbol, growthRate, cd) {
    if (!cd) return;
    const arr = cd.ticks_stayed_in;
    if (!Array.isArray(arr) || !arr.length) return;
    const key = +(+growthRate).toFixed(4);
    if (!this.stayCache.has(symbol)) this.stayCache.set(symbol, new Map());
    this.stayCache.get(symbol).set(key, { ticks_stayed_in: arr, ts: Date.now(), barrier: +cd.tick_size_barrier_percentage || 0 });
  }

  getStays(symbol, growthRate) {
    const sub = this.stayCache.get(symbol);
    return sub ? sub.get(+(+growthRate).toFixed(4)) || null : null;
  }

  cacheBarrier(symbol, growthRate, cd) {
    if (!cd) return;
    const key = `${symbol}:${growthRate}`;
    this._barrierCache.set(key, {
      halfBarrierPct: parseFloat(cd.tick_size_barrier_percentage || 0),
      highBarrier: parseFloat(cd.high_barrier || 0),
      lowBarrier: parseFloat(cd.low_barrier || 0),
      maxPayout: parseFloat(cd.maximum_payout || 0),
      spotDistance: parseFloat(cd.barrier_spot_distance || 0),
    });
  }

  getBarrier(symbol, growthRate) { return this._barrierCache.get(`${symbol}:${growthRate}`); }

  async refreshBarriers(assets, growthRates) {
    if (this._refreshInFlight || !this.client.authorized) return;
    this._refreshInFlight = true;
    try {
      for (const sym of assets) {
        for (const gr of growthRates) {
          try {
            const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
            const res = await this.client._send({ proposal: 1, amount: this.cfg.stake, basis: 'stake', contract_type: 'ACCU', currency: this.cfg.currency, [symbolKey]: sym, growth_rate: gr }, 8000);
            if (res?.proposal?.contract_details) {
              this.cacheBarrier(sym, gr, res.proposal.contract_details);
              this.cacheStays(sym, gr, res.proposal.contract_details);
            }
          } catch (e) { logger.debug(`refreshBarriers(${sym},${gr}):`, e.message); }
        }
      }
    } finally { this._refreshInFlight = false; }
  }

  async loadSymbols() {
    try {
      const res = await this.client._send({ active_symbols: 'brief' }, 15000);
      for (const s of (res.active_symbols || [])) { const k = s.underlying_symbol || s.symbol; if (k) this.client.symbols.set(k, s); }
      logger.info(`loaded ${this.client.symbols.size} symbols`);
    } catch (e) { logger.error('loadSymbols:', e.message); }
  }

  async backfill(symbol, count = 1000) {
    try {
      const res = await this.client._send({ ticks_history: symbol, count, end: 'latest', style: 'ticks' }, 20000);
      const prices = res.history?.prices || [];
      const times = res.history?.times || [];
      const arr = times.map((t, i) => ({ epoch: +t, quote: parseFloat(prices[i]) }));
      this.history.set(symbol, arr);
      if (arr.length) this.lastQuote.set(symbol, arr[arr.length - 1].quote);
      logger.debug(`backfilled ${symbol}: ${arr.length} ticks`);
      return arr;
    } catch (e) { logger.error(`backfill(${symbol}):`, e.message); return []; }
  }

  async subscribe(symbol) {
    if (this.subs.has(symbol)) return this.subs.get(symbol);
    const subId = await this.client.subscribe({ ticks: symbol }, msg => {
      const t = msg.tick;
      if (!t) return;
      const tick = { epoch: +t.epoch, quote: parseFloat(t.quote) };
      this.lastQuote.set(symbol, tick.quote);
      const arr = this.history.get(symbol);
      if (arr) { arr.push(tick); const cap = Math.max(this.cfg.tickWindow * 8, 2000); if (arr.length > cap) arr.splice(0, arr.length - cap); }
      else this.history.set(symbol, [tick]);
    });
    this.subs.set(symbol, subId);
    return subId;
  }

  async bootstrap(symbols) {
    if (this._bootstrapping) return;
    this._bootstrapping = true;
    try {
      await Promise.all(symbols.map(s => this.subscribe(s).catch(e => logger.warn(`sub(${s}):`, e.message))));
      await Promise.all(symbols.map(async s => { if ((this.history.get(s) || []).length < this.cfg.minTicksForAnalysis) await this.backfill(s, Math.max(this.cfg.tickWindow * 5, 1000)); }));
    } finally { this._bootstrapping = false; }
  }

  historyFor(symbol) { return this.history.get(symbol) || []; }
}

// ═══════════════════════════════════════════════════════════════════════
// 7. AEBA MODEL  (Replaces ARCAAnalyzer)
// ═══════════════════════════════════════════════════════════════════════
// Pure helpers are exported for --selftest.
const PURE = {
  // 1-tick log return series.
  logReturns(q) {
    const out = new Array(Math.max(0, q.length - 1));
    for (let i = 1; i < q.length; i++) out[i - 1] = q[i - 1] > 0 ? Math.log(q[i] / q[i - 1]) : 0;
    return out;
  },

  // Robust scale: 1.4826 * MAD (per-tick), plus EWMA smoothing.
  robustSigma(ret, emaPrev = null, alpha = 0.08) {
    if (!ret.length) return { sigma: 0, ema: emaPrev, n: 0 };
    const med = _median(ret.map(Math.abs));
    const mad = med > 0 ? 1.4826 * med : 0;
    // Normalized MAD with a small guard against zero-spread (flat ticks).
    const s = Math.max(mad, 1e-9);
    const ema = emaPrev == null ? s : alpha * s + (1 - alpha) * emaPrev;
    return { sigma: ema, ema, n: ret.length };
  },

  // t-distributed-like survival via a heavy-tail multiplier q ≥ 1.
  // p(|x| < b) under fat tails ≈ erf-normalized with effective σ = σ·q.
  perTickSurvival(barrierPct, sigma, q = 1.3) {
    if (!(barrierPct > 0) || !(sigma > 0)) return null;
    const b = barrierPct / 100;         // fraction of spot
    const sEff = sigma * q;              // fat-tail haircut
    return _erf(b / (sEff * Math.SQRT2));
  },

  // EV per tick for growth rate g:  (1+g)·p − 1 − cost.
  perTickEV(g, p, cost) {
    return (1 + g) * p - 1 - cost;
  },

  // Probability of surviving K consecutive ticks under IID p.
  surviveK(p, K) { return Math.pow(Math.max(0, Math.min(1, p)), K); },

  // Pick growth rate maximizing EV subject to survival floor.
  // barrierForGrowth is a per-growth-rate barrier % (function) or a flat %.
  // The barrier is NOT growth-rate-independent on Deriv — each g has its own.
  bestGrowth(barrierForGrowth, sigma, candidates, q, cost, floor, K) {
    let best = null;
    for (const g of candidates) {
      const bp = typeof barrierForGrowth === 'function' ? barrierForGrowth(g) : barrierForGrowth;
      if (!(bp > 0)) continue;           // barrier unknown for this g → skip
      const p = PURE.perTickSurvival(bp, sigma, q);
      if (p == null) continue;
      const ev = PURE.perTickEV(g, p, cost);
      const sK = PURE.surviveK(p, K);
      if (sK < floor) continue;          // survival floor not met
      if (ev < 0) continue;              // never negative-EV
      if (!best || ev > best.ev) best = { g, p, ev, sK, barrierPct: bp };
    }
    return best;
  },

  // Vol-of-vol percentile of current σ within its own recent history.
  // Rank-normalized: min→0, max→1. (index/(length-1), not index/length.)
  volPercentile(sigmas) {
    if (!sigmas || sigmas.length < 2) return 0.5;
    const cur = sigmas[sigmas.length - 1];
    const sorted = [...sigmas].sort((a, b) => a - b);
    const idx = sorted.findIndex(v => v >= cur);
    return idx / (sorted.length - 1);
  },

  // Per-symbol rolling σ history window for regime percentile.
  pushSigmaHist(hist, sigma) {
    hist.push(sigma);
    if (hist.length > 240) hist.splice(0, hist.length - 240);
    return hist;
  },
};

function _median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _erf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return z >= 0 ? y : -y;
}

class AccumulatorEdgeModel {
  constructor(cfg) {
    this.cfg = cfg;
    this.sigmaHist = new Map();   // symbol -> rolling σ history (for percentile)
    this.emaSigma = new Map();    // symbol -> EWMA σ
  }

  // Per-symbol, per-growth-rate decision. Returns null when it can't know
  // the barrier (never fabricate) or data is insufficient.
  // barrierByGrowth: Map(g -> { halfBarrierPct, ... }) from the live cache.
  analyze(symbol, ticks, barrierByGrowth, stays) {
    const n = ticks && ticks.length;
    if (!n || n < this.cfg.minTicksForAnalysis) return null;
    const quotes = ticks.map(t => t.quote);
    const ret = PURE.logReturns(quotes);
    const est = PURE.robustSigma(ret, this.emaSigma.get(symbol));
    this.emaSigma.set(symbol, est.ema);
    const sigma = est.sigma;

    const hist = this.sigmaHist.get(symbol) || [];
    PURE.pushSigmaHist(hist, sigma);
    this.sigmaHist.set(symbol, hist);
    const pct = PURE.volPercentile(hist);

    // Barrier from live cache per growth rate; if none, cannot price EV.
    const barrierForGrowth = g => {
      const b = barrierByGrowth && barrierByGrowth.get(g);
      return b && b.halfBarrierPct > 0 ? b.halfBarrierPct : null;
    };
    // Representative barrier for messaging (cfg growth rate's, if known).
    const brRep = barrierByGrowth && barrierByGrowth.get(this.cfg.growthRate);
    const repPct = brRep && brRep.halfBarrierPct > 0 ? brRep.halfBarrierPct : 0;

    const best = PURE.bestGrowth(
      barrierForGrowth, sigma,
      this.cfg.growthRates, this.cfg.heavyTailQ,
      this.cfg.costHaircutPct, this.cfg.survivalFloor, this.cfg.planHoldTicks,
    );
    if (!best) return { symbol, ready: false, reason: repPct > 0 ? 'no-positive-ev' : 'barrier-unknown', barrierPct: repPct, sigma, volPct: pct };

    // Vol-regime compression gate (vol-of-vol): avoid entering into
    // elevated/churning σ where the fat-tail haircut is most unreliable.
    if (pct > this.cfg.volPercentileMax) {
      return { symbol, ready: false, reason: `vol-${pct.toFixed(2)}`, barrierPct: best.barrierPct, sigma, volPct: pct };
    }

    // Hard edge gate (net of costs).
    if (best.ev < this.cfg.minEdge) {
      return { symbol, ready: false, reason: `ev-${best.ev.toFixed(4)}`, barrierPct: best.barrierPct, sigma, volPct: pct, best };
    }

    // Soft diagnostic score (informational, NOT the gate).
    const volScore = pct < 0.35 ? 0.95 : pct < 0.65 ? 0.70 : pct < 0.88 ? 0.30 : 0.05;
    const survScore = stays ? _survivalDiagnostic(stays.ticks_stayed_in).score : 0.5;
    const session = _sessionScore();
    const composite =
      this.cfg.weights.volRegime * volScore +
      this.cfg.weights.survival  * survScore +
      this.cfg.weights.barrier   * 0.8 +
      this.cfg.weights.session   * session +
      this.cfg.weights.trendAlign * 0.5;

    return {
      symbol, ready: true,
      score: composite,
      barrierPct: best.barrierPct,
      sigma, volPct: pct,
      g: best.g, p: best.p, ev: best.ev, sK: best.sK,
      survMean: stays ? _survivalDiagnostic(stays.ticks_stayed_in).mean : 0,
      survScore, session,
      reason: 'ok',
    };
  }

  rank(readyAnalyses) { return readyAnalyses.filter(a => a && a.ready).sort((a, b) => b.ev - a.ev); }
}

// Survival diagnostic from ticks_stayed_in — classifier cross-check only.
// It does NOT gate entry. (High mean survival is normal for a low knockout
// contract; it is not itself evidence of edge.)
function _survivalDiagnostic(arr) {
  if (!Array.isArray(arr) || arr.length < 5) return { score: 0.5, mean: 0, consistency: 0 };
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  let v = 0; for (const x of arr) v += (x - mean) ** 2;
  const stdev = Math.sqrt(v / arr.length);
  const consistency = mean > 0 ? Math.max(0, 1 - stdev / mean) : 0;
  return { score: Math.max(0, Math.min(1, consistency)), mean, consistency };
}

function _sessionScore() {
  const hour = new Date().getUTCHours();
  const w = { 0:.55,1:.60,2:.60,3:.65,4:.65,5:.60,6:.55,7:.50,8:.45,9:.45,10:.50,11:.55,12:.60,13:.65,14:.70,15:.75,16:.70,17:.65,18:.55,19:.50,20:.50,21:.55,22:.55,23:.55 };
  return w[hour] ?? 0.5;
}

// ═══════════════════════════════════════════════════════════════════════
// 8. RISK & SIZING
// ═══════════════════════════════════════════════════════════════════════
class RiskManager {
  constructor(cfg, stats) {
    this.cfg = cfg;
    this.stats = stats;
    this.equityPeak = 0;
    this.ddReducer = 1.0;
    this.sessionMaxLoss = cfg.dailyMaxLoss;   // per-session cap (demo-friendly)
    this.sessionStartBal = null;
    this.sessionProfit = 0;
  }

  init(balance) {
    if (this.sessionStartBal == null) {
      this.sessionStartBal = balance;
      this.equityPeak = balance;
    }
  }

  // Update peak and reducer from live balance.
  update(balance) {
    if (balance > this.equityPeak) this.equityPeak = balance;
    const dd = this.equityPeak > 0 ? (this.equityPeak - balance) / this.equityPeak : 0;
    if (dd <= this.cfg.ddFullStake) this.ddReducer = 1.0;
    else if (dd <= this.cfg.ddReduce25) this.ddReducer = 0.75;
    else if (dd <= this.cfg.ddReduce50) this.ddReducer = 0.50;
    else this.ddReducer = 0.25;
    return dd;
  }

  sessionLossBreached(balance) {
    if (this.sessionStartBal == null) return false;
    return (this.sessionStartBal - balance) >= this.sessionMaxLoss;
  }

  // Hard caps (real, finite now).
  checkHardCaps(balance, todayTrades) {
    const today = todayTrades;
    const pl = today.reduce((s, t) => s + (t.profit || 0), 0);
    if (pl <= -this.cfg.dailyMaxLoss) return 'daily-loss';
    if (today.length >= this.cfg.dailyMaxTrades) return 'daily-trades';
    if (this.sessionLossBreached(balance)) return 'session-loss';
    if (this.cfg.takeProfit && pl >= this.cfg.takeProfit) return 'take-profit';
    return null;
  }

  // Fractional-Kelly-ish bound on stake as a fraction of equity.
  // f = max(0, (p̂−q̂)/g) capped at kellyCap (default 0.02 = 2% equity).
  kellyStake(equity, p, g) {
    if (!(equity > 0) || !(p > 0) || !(g > 0)) return this.cfg.stake;
    const q = 1 - p;
    const f = Math.max(0, (p - q) / g);
    return Math.max(this.cfg.stake, Math.min(this.cfg.stake * this.cfg.maxWinStakeMultiplier, equity * Math.min(f, 0.02)));
  }

  // Correlation haircut: the vol set (R_* / 1HZ*V) is highly correlated.
  // When we can only run one position, treat "top-1 EV" as representative
  // and haircut EV by a correlation factor so we don't over-state edge.
  haircutEV(ev, basketSize) {
    const rho = Math.min(1, 0.5 + 0.1 * basketSize); // 0.6 for 1 asset → 0.5+0.1
    return ev * (1 - rho * 0.5);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 9. TRADE EXECUTOR  (single writer; 'sold' handled; reconcile-aware)
// ═══════════════════════════════════════════════════════════════════════
class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.open = new Map();
    this.market = null;
    this._selling = new Set();
    this._buyLock = false;   // serialize buy so two interval ticks can't double-enter
  }

  async buy(symbol, growthRate, stake, limit, analysis = null) {
    if (this._buyLock) { logger.warn('buy: already in-flight — skip'); return null; }
    this._buyLock = true;
    try {
      growthRate = Math.max(0.01, Math.min(0.05, +growthRate.toFixed(4)));
      const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
      const pres = await this.client._send({
        proposal: 1, amount: stake, basis: 'stake', contract_type: 'ACCU', currency: this.cfg.currency,
        [symbolKey]: symbol, growth_rate: growthRate,
        ...((limit.take_profit != null && limit.take_profit > 0) ? { limit_order: { take_profit: limit.take_profit } } : {}),
      }, 20000);
      const p = pres.proposal;
      if (!p?.id) throw new Error('No proposal id');
      if (pres.error) throw new Error(pres.error.message);
      logger.info(`proposal id=${p.id} ask=${p.ask_price} payout=${p.payout} spot=${p.spot}`);

      if (this.market && p.contract_details) {
        this.market.cacheStays(symbol, growthRate, p.contract_details);
        this.market.cacheBarrier(symbol, growthRate, p.contract_details);
      }

      const bres = await this.client._send({ buy: p.id, price: p.ask_price }, 20000);
      const b = bres.buy;
      if (!b?.contract_id) throw new Error('No contract_id');
      logger.info(`bought ACCU #${b.contract_id} for ${b.buy_price}`);

      const cd = p.contract_details || {};
      const entrySpot = parseFloat(p.spot ?? cd.current_spot ?? 0);
      const halfBarrierPct = entrySpot ? (parseFloat(cd.barrier_spot_distance ?? 0) / entrySpot) * 100 : 0;

      const info = {
        contractId: b.contract_id, symbol, growthRate, stake,
        buyPrice: parseFloat(b.buy_price), payout: parseFloat(p.payout),
        buyTime: b.purchase_time || (Date.now() / 1000),
        limit: { stop_loss: limit.stop_loss ?? null, take_profit: limit.take_profit ?? null },
        contractDetails: cd, entrySpot, halfBarrierPct,
        highBarrier: parseFloat(cd.high_barrier ?? 0),
        lowBarrier: parseFloat(cd.low_barrier ?? 0),
        _entrySpot: entrySpot, _analysis: analysis,
        profit: 0, status: 'open', currentSpot: entrySpot,
      };
      this.open.set(b.contract_id, info);

      await this.client.subscribe({ proposal_open_contract: 1, contract_id: b.contract_id },
        msg => this._onUpdate(msg, info));
      this.emit('open', info);
      return info;
    } catch (e) { logger.error(`buy(${symbol}):`, e.message); throw e; }
    finally { this._buyLock = false; }
  }

  _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    const cid = c.contract_id ?? info.contractId;
    const profit = parseFloat(c.profit ?? 0);
    const spot = parseFloat(c.current_spot ?? 0);

    // Terminal states: won / lost / sold / is_sold → reconcile open.
    // Emit `result` exactly once per contract (idempotent via the open map).
    if (c.status === 'won' || c.status === 'lost' || c.status === 'sold' || c.is_sold) {
      const wasTracked = this.open.has(cid);
      if (!wasTracked) {   // already resolved → drop duplicate terminal update
        if (msg.subscription?.id) this.client.forget(msg.subscription.id).catch(() => {});
        return;
      }
      const finished = {
        ...info, contractId: cid, profit,
        status: (c.status === 'sold' || c.is_sold) ? 'sold' : c.status,
        sellPrice: parseFloat(c.sell_price ?? 0),
        sellTime: c.sell_time ?? (Date.now() / 1000),
        currentSpot: spot,
      };
      this.open.delete(cid);
      this.emit('result', finished);
      if (msg.subscription?.id) this.client.forget(msg.subscription.id).catch(() => {});
      return;
    }

    // Manual stop-loss check (Deriv ACCU doesn't support stop_loss param).
    const stopLossAbs = Math.abs(info.limit?.stop_loss || 0);
    if (stopLossAbs > 0 && profit <= -stopLossAbs && !this._selling.has(cid)) {
      logger.warn(`SL hit #${cid} profit=${profit.toFixed(2)}`);
      this._selling.add(cid);
      this.sell(cid, 0).catch(e => logger.error(`SL sell failed:`, e.message)).finally(() => this._selling.delete(cid));
      return;
    }

    // Early exit: barrier drift danger.
    if (info.halfBarrierPct > 0 && spot > 0 && info._entrySpot > 0) {
      const driftFrac = Math.abs(spot - info._entrySpot) / info._entrySpot / (info.halfBarrierPct / 100);
      if (driftFrac > this.cfg.earlyExitDriftFrac && !this._selling.has(cid)) {
        logger.info(`drift exit #${cid}: ${(driftFrac * 100).toFixed(1)}% of barrier`);
        this._selling.add(cid);
        this.sell(cid, 0).catch(e => logger.error(`drift exit failed:`, e.message)).finally(() => this._selling.delete(cid));
        return;
      }
    }

    // Profit-lock: bank when realized profit ≥ fraction of the remaining
    // model EV for the planned hold, measured in dollars on this stake.
    // remaining is per stake-dollar; multiply by stake to compare to $profit.
    if (info._analysis && info._analysis.g && info._analysis.p && profit > 0) {
      const remaining = info._analysis.ev * this.cfg.planHoldTicks * info.stake;
      if (remaining > 0 && profit >= this.cfg.profitLockFrac * remaining) {
        logger.info(`profit-lock #${cid}: profit=${profit.toFixed(2)} >= ${(this.cfg.profitLockFrac * remaining).toFixed(2)}`);
        this._selling.add(cid);
        this.sell(cid, 0).catch(e => logger.error(`profit-lock sell failed:`, e.message)).finally(() => this._selling.delete(cid));
        return;
      }
    }

    this.emit('update', { ...info, contractId: cid, profit, currentSpot: spot, status: c.status });
  }

  async sell(contractId, minPrice = 0) {
    const res = await this.client._send({ sell: contractId, price: minPrice }, 15000);
    logger.info(`sold #${contractId} for ${res.sell?.sold_for}`);
    return res.sell;
  }

  // Best-effort reconcile of open contracts against the server.
  async reconcile() {
    const ids = [...this.open.keys()];
    if (!ids.length) return;
    logger.info(`reconcile: ${ids.length} open contract(s) → checking`);
    for (const id of ids) {
      try {
        const res = await this.client._send({ proposal_open_contract: 1, contract_id: id }, 15000);
        const c = res?.proposal_open_contract;
        if (!c) continue;
        if (c.status === 'won' || c.status === 'lost' || c.status === 'sold' || c.is_sold) {
          // already finished server-side — emit result and forget.
          const info = this.open.get(id);
          this._onUpdate({ proposal_open_contract: c }, info);
        } else {
          // still open → leave it tracked; it will stream updates after
          // we re-subscribe. Re-subscribe to be safe.
          await this.client.subscribe({ proposal_open_contract: 1, contract_id: id },
            msg => this._onUpdate(msg, info)).catch(() => {});
        }
      } catch (e) { logger.warn(`reconcile #${id}:`, e.message); }
    }
  }

  count() { return this.open.size; }
}

// ═══════════════════════════════════════════════════════════════════════
// 10. STATISTICS MANAGER
// ═══════════════════════════════════════════════════════════════════════
const utcDateStr = (d = new Date()) => d.toISOString().slice(0, 10);
const utcHour = (d = new Date()) => d.getUTCHours();
const money = (n, c = CONFIG.currency) => `${n >= 0 ? '+' : ''}${Number(n || 0).toFixed(2)} ${c}`;

class StatisticsManager {
  constructor(saved = null) {
    this.trades = []; this.dailySummaries = {}; this.overallProfit = 0;
    this.currentLossStreak = 0; this.maxLossStreak = 0;
    this.lossStreakEvents = { x2: 0, x3: 0, x4: 0 };
    this.eodSentDates = [];
    if (saved) this.load(saved);
  }
  load(s) {
    if (Array.isArray(s.trades)) this.trades = s.trades;
    if (s.dailySummaries) this.dailySummaries = s.dailySummaries;
    this.overallProfit = Number(s.overallProfit || 0);
    this.currentLossStreak = Number(s.currentLossStreak || 0);
    this.maxLossStreak = Number(s.maxLossStreak || 0);
    if (s.lossStreakEvents) this.lossStreakEvents = { x2: Number(s.lossStreakEvents.x2 || 0), x3: Number(s.lossStreakEvents.x3 || 0), x4: Number(s.lossStreakEvents.x4 || 0) };
    this.eodSentDates = Array.isArray(s.eodSentDates) ? s.eodSentDates : [];
  }
  serialize() {
    return { trades: this.trades.slice(-5000), dailySummaries: this.dailySummaries, overallProfit: this.overallProfit, currentLossStreak: this.currentLossStreak, maxLossStreak: this.maxLossStreak, lossStreakEvents: this.lossStreakEvents, eodSentDates: this.eodSentDates.slice(-400) };
  }
  record(trade) {
    const tsMs = Number(trade.sellTime || trade.buyTime || Date.now() / 1000) * 1000;
    const d = new Date(tsMs);
    const rec = { ...trade, timestamp: tsMs, date: utcDateStr(d), hour: utcHour(d) };
    this.trades.push(rec);
    this.overallProfit += Number(rec.profit || 0);
    if (rec.status === 'lost') {
      this.currentLossStreak += 1;
      if (this.currentLossStreak === 2) this.lossStreakEvents.x2 += 1;
      if (this.currentLossStreak === 3) this.lossStreakEvents.x3 += 1;
      if (this.currentLossStreak === 4) this.lossStreakEvents.x4 += 1;
      this.maxLossStreak = Math.max(this.maxLossStreak, this.currentLossStreak);
    } else if (rec.status === 'won') { this.currentLossStreak = 0; }
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
    return { count: list.length, wins: wins.length, losses: losses.length, winRate: list.length ? wins.length / list.length * 100 : 0, grossWin: gw, grossLoss: gl, totalProfit: total, profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0), stake: list.reduce((s, t) => s + Number(t.stake || 0), 0) };
  }
  archiveDate(date) {
    const list = this.trades.filter(t => t.date === date);
    const s = this.stats(list);
    this.dailySummaries[date] = s;
    return { date, trades: list, stats: s };
  }
  markEodSent(date) { if (!this.eodSentDates.includes(date)) this.eodSentDates.push(date); this.eodSentDates = this.eodSentDates.slice(-400); }
  isEodSent(date) { return this.eodSentDates.includes(date); }
  allDailyRows(includeDate = null) {
    const rows = []; const dates = new Set(Object.keys(this.dailySummaries));
    for (const t of this.trades) dates.add(t.date);
    if (includeDate) dates.add(includeDate);
    [...dates].sort().forEach(date => {
      let s = this.dailySummaries[date];
      const live = this.trades.filter(t => t.date === date);
      if (live.length) s = this.stats(live);
      if (s && s.count > 0) rows.push({ date, stats: s });
    });
    return rows;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 11. TRADING BOT  (Main Orchestrator)
// ═══════════════════════════════════════════════════════════════════════
class AccuPULSE2Bot {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = new DerivClient(cfg);
    this.market = new MarketDataManager(this.client, cfg);
    this.model = new AccumulatorEdgeModel(cfg);
    this.exec = new TradeExecutor(this.client, cfg);
    this.exec.market = this.market;
    this.stats = new StatisticsManager();
    this.risk = new RiskManager(cfg, this.stats);

    this.stopped = false;
    this.paused = false;
    this.reconciled = false;
    this.startBalance = null;
    this.lastBalance = null;
    this.lastTradeAt = 0;
    this.overallProfit = 0;
    this.tradeStartTime = null;
    this.gmtPause = null;   // { fromHour, toHour } in GMT

    this._analysisT = null;
    this._hourlyT = null;
    this._eodT = null;
    this._hourlyBoot = null;
    this._eodBoot = null;
    this._barrierT = null;
    this._tradeWatchdogTimer = null;

    // Anti-Martingale state
    this.winStreak = 0;
    this.lossStreak = 0;
    this.winStakeMultiplier = 1.0;
  }

  async start() {
    logger.info('═══════════════════════════════════════════');
    logger.info('  AccuPULSE2b — AEBA Strategy');
    logger.info('═══════════════════════════════════════════');
    logger.info(`assets: ${this.cfg.assets.join(', ')}`);

    if (!this.cfg.apiToken) { logger.error('API token missing'); process.exit(1); }

    this.client.on('authorized', info => this._onAuthorized(info));
    this.client.on('close', (c, r, was) => this._onDisconnected(c, r, was));
    this.exec.on('open', t => this._onTradeOpen(t));
    this.exec.on('update', t => this._onTradeUpdate(t));
    this.exec.on('result', t => this._onTradeResult(t));

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
    process.on('unhandledRejection', (reason) => { logger.error('unhandledRejection:', reason instanceof Error ? reason.message : String(reason)); });
    process.on('uncaughtException', (err) => { logger.error('uncaughtException:', err.message); });

    this._loadState();
    this._scheduleSummaries();
    this.client.connect();
  }

  _scheduleSummaries() {
    const now = new Date();
    const msToNextHour = ((59 - now.getUTCMinutes()) * 60_000) + ((60 - now.getUTCSeconds()) * 1000) + 50;
    if (this.cfg.hourlySummary) {
      this._hourlyBoot = setTimeout(() => { this._sendHourly(); this._hourlyT = setInterval(() => this._sendHourly(), 3600_000); }, Math.max(1000, msToNextHour));
    }
    const scheduleNextEod = () => {
      const { h, min } = (() => { const m = String(this.cfg.eodTimeGmt || '00:00').match(/^(\d{1,2}):(\d{2})$/); return m ? { h: +m[1], min: +m[2] } : { h: 0, min: 0 }; })();
      const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, min, this.cfg.eodSendDelaySeconds, 0));
      if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
      const delay = target.getTime() - now.getTime();
      this._eodBoot = setTimeout(() => { this._sendEod('scheduled'); scheduleNextEod(); }, delay);
    };
    scheduleNextEod();
  }

  // ── Authorised ──────────────────────────────────────────────
  async _onAuthorized(info) {
    // Initialize session baseline only once (don't corrupt on reconnect).
    if (this.startBalance == null) {
      this.startBalance = this.balance ?? this.client.balance;
      this.lastBalance = this.startBalance;
      this.equityPeak = this.startBalance;
      this.risk.init(this.startBalance);
    }
    if (this.lastBalance == null) this.lastBalance = this.balance ?? this.client.balance;

    telegram.send(
      `🤖 <b>AccuPULSE2b Online</b>\n\n` +
      `👤 <b>Account:</b> ${info.loginid}\n` +
      `💼 <b>Type:</b> ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 <b>Balance:</b> ${(this.lastBalance ?? 0).toFixed(2)} ${this.currencyStr()}\n` +
      `📊 <b>Assets:</b> ${this.cfg.assets.join(', ')}\n` +
      `💵 <b>Stake:</b> ${this.cfg.stake}\n` +
      `📈 <b>Growth grid:</b> ${this.cfg.growthRates.join(',')}\n\n` +
      `🧠 <b>AEBA Strategy Active</b>\n` +
      `• Live-barrier EV gate (net of costs)\n• Growth by argmax EV\n` +
      `• Vol-compression / vol-of-vol\n• Survival floor\n` +
      `• Anti-martingale + graduated drawdown\n` +
      `• Reconcile-on-reconnect · live adaptive exit`,
    );

    await Promise.all([
      this.market.loadSymbols(),
      this.market.bootstrap(this.cfg.assets),
      this._refreshBarriers(),
    ]);

    // Reconcile any contract that was open when we disconnected.
    await this.exec.reconcile();
    this.reconciled = true;

    if (this._analysisT) clearInterval(this._analysisT);
    this._analyzeAndTrade();
    this._analysisT = setInterval(() => this._analyzeAndTrade(), this.cfg.analysisIntervalMs);
    if (this._barrierT) clearInterval(this._barrierT);
    this._barrierT = setInterval(() => this._refreshBarriers(), this.cfg.barrierRefreshMs);
  }

  _onDisconnected(code, reason, wasAuth) {
    this._clearWatchdog();
    this.reconciled = false;
    const intentional = this.stopped;
    if (!intentional) telegram.send(`⚠️ <b>Connection lost</b>\ncode: <code>${code}</code>\nwas auth: ${wasAuth ? 'yes' : 'no'}\n🔄 reconnecting…`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    // Do NOT clear exec.open here — it is reconciled on re-auth (P0 fix).
  }

  // ── Trade callbacks ─────────────────────────────────────────
  _onTradeOpen(t) {
    this.tradeStartTime = Date.now();
    this._startWatchdog(t.contractId);
    const a = t._analysis;
    let msg =
      `🟢 <b>TRADE OPENED</b>\n\n` +
      `🎫 <b>#</b>${t.contractId}\n` +
      `📊 <code>${t.symbol}</code>\n` +
      `📈 Growth: ${(t.growthRate * 100).toFixed(0)}%\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currencyStr()}\n` +
      `🎯 TP: ${t.limit.take_profit ?? '–'}\n`;
    if (a) {
      msg += `\n🧠 <b>AEBA</b>\n` +
        `• p̂/tick: <b>${(a.p * 100).toFixed(2)}%</b> | EV/tick: <b>${(a.ev * 100).toFixed(2)}%</b>\n` +
        `• Barrier: ${a.barrierPct.toFixed(2)}% | σ: ${(a.sigma * 100).toFixed(2)}%\n` +
        `• S(surv ${this.cfg.planHoldTicks}): ${(a.sK * 100).toFixed(1)}% | vol%: ${(a.volPct * 100).toFixed(0)}%\n` +
        `• Score: ${a.score.toFixed(3)} | reason: ${a.reason}`;
    }
    if (this.winStakeMultiplier > 1) msg += `\n📈 Win streak: ${this.winStreak} → ×${this.winStakeMultiplier.toFixed(2)}`;
    telegram.send(msg);
  }

  _onTradeUpdate(t) { logger.debug(`update #${t.contractId}: profit=${t.profit.toFixed(3)} spot=${t.currentSpot}`); }

  _onTradeResult(t) {
    this._clearWatchdog();
    this.tradeStartTime = null;
    const rec = this.stats.record(t);
    const emoji = t.status === 'won' ? '✅' : '❌';
    const dur = Math.max(0, (t.sellTime || Date.now() / 1000) - (t.buyTime || 0));
    this.lastBalance = (this.lastBalance ?? 0) + t.profit;
    this.overallProfit += t.profit;

    // Update equity peak + drawdown reducer
    this.risk.update(this.lastBalance);

    // Anti-Martingale state
    if (t.status === 'won') {
      this.winStreak++; this.lossStreak = 0;
      if (this.winStreak >= this.cfg.winsBeforeScaling) {
        this.winStakeMultiplier = Math.min(this.cfg.maxWinStakeMultiplier, 1 + (this.winStreak - this.cfg.winsBeforeScaling + 1) * (this.cfg.winStakeMultiplier - 1));
      }
    } else {
      this.lossStreak++; this.winStreak = 0; this.winStakeMultiplier = 1.0;
    }

    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));
    let msg =
      `${emoji} <b>TRADE ${t.status === 'won' ? 'WON' : 'LOST'}</b>\n\n` +
      `🎫 <b>#</b>${t.contractId}\n` +
      `📊 <code>${t.symbol}</code>\n` +
      `📈 Growth: ${(t.growthRate * 100).toFixed(0)}%\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currencyStr()}\n` +
      `💰 Sell: ${(t.sellPrice ?? 0).toFixed(2)}\n` +
      `${t.profit >= 0 ? '📈' : '📉'} Profit: ${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)} ${this.currencyStr()}\n` +
      `⏱️ Duration: ${dur.toFixed(1)}s\n` +
      `💼 Balance: ${this.lastBalance.toFixed(2)} ${this.currencyStr()}\n\n` +
      `📅 <b>Today (${rec.date})</b>\n` +
      `• ${todayStats.count} trades (✅${todayStats.wins} ❌${todayStats.losses})\n` +
      `• WR: ${todayStats.winRate.toFixed(1)}% | P/L: ${money(todayStats.totalProfit, this.currencyStr())}\n` +
      `• PF: ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n` +
      `💼 Overall: ${money(this.overallProfit, this.currencyStr())}\n` +
      `❌ Streak: ${this.stats.currentLossStreak} (x2=${this.stats.lossStreakEvents.x2} x3=${this.stats.lossStreakEvents.x3})`;
    if (this.winStakeMultiplier > 1) msg += `\n📈 Win streak ×${this.winStakeMultiplier.toFixed(2)}`;
    if (this.risk.ddReducer < 1) msg += `\n🛡️ DD: ${(this.risk.ddReducer * 100).toFixed(0)}% stake`;
    telegram.send(msg);
    this.lastTradeAt = Date.now();

    // Circuit breakers
    if (this._checkCircuitBreakers()) {
      this.stopped = true;
      telegram.send(`🛑 <b>Bot stopped</b> — circuit breaker`);
    }
    this._saveState('after-trade');
  }

  // ── Stake sizing (anti-martingale + graduated DD) ───────────
  currentStake(p) {
    let base = this.cfg.stake * this.winStakeMultiplier * this.risk.ddReducer;
    if (this.lossStreak >= this.cfg.streakReduceStake) base *= 0.5;
    // Fractional-Kelly bound: cap stake at a small fraction of equity.
    const equity = this.lastBalance ?? this.cfg.stake * 100;
    const g = p ? Math.max(0.01, Math.min(0.05, p)) : this.cfg.growthRate;
    const kelly = this.risk.kellyStake(equity, p || 0.95, g);
    const stake = Math.max(this.cfg.stake * 0.5, Math.min(base, kelly));
    return +stake.toFixed(2);
  }

  _checkCircuitBreakers() {
    const today = this.stats.todayTrades();
    const pl = today.reduce((s, t) => s + (t.profit || 0), 0);
    if (pl <= -this.cfg.dailyMaxLoss) { telegram.send(`🛑 Daily loss limit: ${pl.toFixed(2)}`); return true; }
    if (today.length >= this.cfg.dailyMaxTrades) { telegram.send(`🛑 Daily trade limit: ${this.cfg.dailyMaxTrades}`); return true; }
    if (this.cfg.takeProfit && pl >= this.cfg.takeProfit) { telegram.send(`🛑 Take-profit: ${pl.toFixed(2)}`); return true; }
    const dd = this.equityPeak > 0 ? (this.equityPeak - (this.lastBalance ?? 0)) / this.equityPeak : 0;
    if (dd > this.cfg.ddStopTrading) { telegram.send(`🛑 DD limit: ${(dd * 100).toFixed(1)}%`); return true; }
    if (this.lossStreak >= this.cfg.streakStopDay) { telegram.send(`🛑 Loss streak limit: ${this.lossStreak}`); return true; }
    return false;
  }

  // ── Main AEBA strategy loop ────────────────────────────────
  async _analyzeAndTrade() {
    try {
      if (this.stopped || !this.client.authorized) return;
      if (!this.reconciled) { logger.debug('skipping: awaiting reconcile'); return; }
      if (this.paused) { logger.debug('skipping: paused'); return; }
      if (this._inGmtPause()) { logger.debug('skipping: GMT pause window'); return; }
      if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
      if (this.exec.count() >= this.cfg.maxOpenTrades) return;

      // Hard caps (real now) — gate before any analysis spend.
      const cap = this.risk.checkHardCaps(this.lastBalance ?? 0, this.stats.todayTrades());
      if (cap) { logger.info(`hard cap: ${cap} — idle`); return; }

      // Per-symbol AEBA decision. Barrier is looked up per growth rate
      // because Deriv's accumulator barrier depends on g.
      const decisions = [];
      for (const sym of this.cfg.assets) {
        const ticks = this.market.historyFor(sym);
        const barrierByGrowth = new Map();
        for (const g of this.cfg.growthRates) {
          const b = this.market.getBarrier(sym, g);
          if (b) barrierByGrowth.set(g, b);
        }
        const stays = this.market.getStays(sym, this.cfg.growthRate);
        const d = this.model.analyze(sym, ticks, barrierByGrowth, stays);
        if (d) decisions.push(d);
      }

      const ready = decisions.filter(d => d.ready);
      if (!ready.length) {
        // Log a compact "why idle" line with distinct reasons (not a spam).
        const reasons = decisions.map(d => d.reason || '?' );
        const uniq = [...new Set(reasons)];
        logger.info(`idle: no ready edge (${uniq.join(',')})`);
        return;
      }

      const ranked = this.model.rank(ready);
      const best = ranked[0];

      // Correlation haircut: vol set is highly related.
      const haircutEv = this.risk.haircutEV(best.ev, this.cfg.assets.length);
      logger.info(`best=${best.symbol} g=${best.g} p=${best.p.toFixed(4)} ev=${(best.ev*100).toFixed(2)}% haircutEv=${(haircutEv*100).toFixed(2)}% barrier=${best.barrierPct.toFixed(2)}% σ=${(best.sigma*100).toFixed(2)}% vol%=${(best.volPct*100).toFixed(0)}`);

      // Re-check edge net of correlation haircut (hard gate).
      if (haircutEv < this.cfg.minEdge) { logger.info(`idle: haircut EV below minEdge (${(haircutEv*100).toFixed(2)}% < ${(this.cfg.minEdge*100).toFixed(2)}%)`); return; }

      const growthRate = best.g;
      const stake = this.currentStake(best.p);
      // TP as a growth-multiple target: bank a fraction of the model's
      // expected edge over the plan hold, in $.
      const tp = +(stake * Math.max(0.3, Math.min(3.0, best.sK * best.ev * this.cfg.planHoldTicks))).toFixed(2);

      const analysis = {
        score: best.score, g: best.g, p: best.p, ev: best.ev, sK: best.sK,
        barrierPct: best.barrierPct, sigma: best.sigma, volPct: best.volPct,
        survMean: best.survMean, reason: best.reason,
      };

      const trade = await this.exec.buy(best.symbol, growthRate, stake, { stop_loss: this.cfg.stopLoss, take_profit: tp }, analysis);
      if (trade) logger.info(`trade #${trade.contractId} ${best.symbol} g=${growthRate} stake=${stake} tp=${tp}`);
    } catch (e) { logger.error('AEBA loop error:', e.message); }
  }

  _inGmtPause() {
    const p = this.gmtPause;
    if (!p) return false;
    const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    const from = p.fromHour * 60 + (p.fromMin || 0);
    const to = p.toHour * 60 + (p.toMin || 0);
    if (from <= to) return nowMin >= from && nowMin <= to;
    return nowMin >= from || nowMin <= to; // overnight window
  }

  async _refreshBarriers() {
    try {
      if (!this.client.authorized) return;
      await this.market.refreshBarriers(this.cfg.assets, this.cfg.growthRates);
      logger.debug('barriers refreshed');
    } catch (e) { logger.debug('barrier refresh:', e.message); }
  }

  // ── Watchdog ────────────────────────────────────────────────
  _startWatchdog(contractId) {
    this._clearWatchdog();
    this._tradeWatchdogTimer = setTimeout(() => {
      if (this.exec.count() === 0) { this._clearWatchdog(); return; }
      logger.warn(`watchdog: #${contractId} stuck for ${this.cfg.tradeWatchdogMs / 1000}s`);
      if (contractId && this.client.authorized) {
        this.exec.sell(contractId, 0).catch(e => logger.error(`watchdog sell failed:`, e.message));
      }
      this._clearWatchdog();
    }, this.cfg.tradeWatchdogMs);
  }

  _clearWatchdog() { if (this._tradeWatchdogTimer) { clearTimeout(this._tradeWatchdogTimer); this._tradeWatchdogTimer = null; } }

  // ── Summaries ───────────────────────────────────────────────
  _sendHourly() {
    const now = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const date = utcDateStr(prev), hour = utcHour(prev);
    const list = this.stats.tradesForHour(date, hour);
    const s = this.stats.stats(list);
    if (!list.length) { telegram.send(`⏰ <b>${date} ${pad(hour)}:00</b> — No trades\n💼 Overall: ${money(this.stats.overallProfit, this.currencyStr())}`); return; }
    let msg = `⏰ <b>${date} ${pad(hour)}:00</b>\n\n📊 ${s.count} trades (✅${s.wins} ❌${s.losses})\n📈 WR: ${s.winRate.toFixed(1)}%\n💰 P/L: <b>${money(s.totalProfit, this.currencyStr())}</b>\n💼 Overall: <b>${money(this.stats.overallProfit, this.currencyStr())}</b>\n`;
    list.slice(-15).forEach((t, i) => { msg += `${i + 1}. ${t.status === 'won' ? '✅' : '❌'} #${t.contractId} ${t.symbol} ${money(t.profit, this.currencyStr())}\n`; });
    telegram.send(msg);
  }

  _sendEod(reason = 'manual') {
    const date = utcDateStr(new Date(Date.now() - 86_400_000));
    if (this.stats.isEodSent(date) && reason === 'scheduled') return;
    const summary = this.stats.archiveDate(date);
    const ds = summary.stats;
    const balStart = this.startBalance ?? 0, balNow = this.lastBalance ?? balStart;
    const balDelta = balNow - balStart;
    let msg = `🌙 <b>DAILY REPORT — ${date}</b>\n\n`;
    if (ds.count) msg += `📊 ${ds.count} trades (✅${ds.wins} ❌${ds.losses}) | WR ${ds.winRate.toFixed(1)}%\n💰 Net: <b>${money(ds.totalProfit, this.currencyStr())}</b> | PF ${ds.profitFactor === Infinity ? '∞' : ds.profitFactor.toFixed(2)}\n`;
    else msg += `No trades.\n`;
    msg += `\n💼 ${balStart.toFixed(2)} → ${balNow.toFixed(2)} (${balDelta >= 0 ? '+' : ''}${balDelta.toFixed(2)})\n`;
    msg += `💼 Overall: <b>${money(this.stats.overallProfit, this.currencyStr())}</b>\n`;
    msg += `❌ Loss streak: ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}`;
    telegram.send(msg);
    this.stats.markEodSent(date);
    this._saveState(`eod-${reason}`);
    this.startBalance = this.client.balance ?? this.lastBalance ?? this.startBalance;
  }

  currencyStr() { return this.client.currency || this.cfg.currency; }

  // ── State persistence ──────────────────────────────────────
  _saveState(reason = 'checkpoint') {
    try {
      const payload = {
        version: 3, engine: 'AEBA', savedAt: new Date().toISOString(), savedReason: reason,
        startBalance: this.startBalance, lastBalance: this.lastBalance, overallProfit: this.overallProfit,
        winStreak: this.winStreak, lossStreak: this.lossStreak, winStakeMultiplier: this.winStakeMultiplier,
        equityPeak: this.risk.equityPeak, ddReducer: this.risk.ddReducer,
        stats: this.stats.serialize(),
      };
      const tmp = this.cfg.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.cfg.stateFile);
    } catch (e) { logger.warn('state save:', e.message); }
  }

  _loadState() {
    const file = this.cfg.stateFile;
    if (!fs.existsSync(file)) return;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d.startBalance != null) this.startBalance = d.startBalance;
      if (d.lastBalance != null) this.lastBalance = d.lastBalance;
      if (d.overallProfit != null) this.overallProfit = d.overallProfit;
      if (d.winStreak != null) this.winStreak = d.winStreak;
      if (d.lossStreak != null) this.lossStreak = d.lossStreak;
      if (d.winStakeMultiplier != null) this.winStakeMultiplier = d.winStakeMultiplier;
      if (d.equityPeak != null) this.risk.equityPeak = d.equityPeak;
      if (d.ddReducer != null) this.risk.ddReducer = d.ddReducer;
      this.stats = new StatisticsManager(d.stats || {});
      logger.info(`state restored: overall=${this.overallProfit.toFixed(2)} lossStreak=${this.lossStreak}`);
    } catch (e) { logger.warn('state load:', e.message); }
  }

  stop(signal) {
    if (this.stopped) return;
    this.stopped = true;
    this._clearWatchdog();
    logger.info(`stopping (${signal})`);
    telegram.send(`🛑 <b>AccuPULSE2b stopped</b>\nSignal: ${signal}`);
    if (this._analysisT) clearInterval(this._analysisT);
    if (this._hourlyT) clearInterval(this._hourlyT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._eodBoot) clearTimeout(this._eodBoot);
    if (this._barrierT) clearInterval(this._barrierT);

    // Final summary
    const today = this.stats.todayTrades();
    const s = this.stats.stats(today);
    telegram.send(`🌙 <b>SESSION END</b>\n📊 ${s.count} trades (✅${s.wins} ❌${s.losses}) | WR ${s.winRate.toFixed(1)}%\n💰 Net: ${money(s.totalProfit, this.currencyStr())}\n💼 Overall: ${money(this.overallProfit, this.currencyStr())}`);

    this._saveState('shutdown');
    this.client.stop();
    // Flush Telegram before exit.
    telegram.flush().finally(() => setTimeout(() => process.exit(0), 300));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 12. BOOTSTRAP + SELFTEST
// ═══════════════════════════════════════════════════════════════════════
function printBanner() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║   AccuPULSE2b — Adaptive EV/Barrier (AEBA)          ║');
  console.log('║   Multi-Asset • Barrier-Correct • Adaptive Exit     ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');
}

// Pure-math selftest — no network. Run:  node accuPULSE2b.js --selftest
function runSelfTest() {
  let pass = 0, fail = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name} ${detail}`); }
  };
  console.log('\n── AEBA pure-math selftest ──');

  // 1. per-tick survival at a 5% barrier, R_100-ish σ (≈1.7%) should be high.
  const p100 = PURE.perTickSurvival(5, 0.017, 1.3);
  check('R_100 σ=1.7% barrier=5% ⇒ p̂>0.95', p100 > 0.95, `got ${p100}`);

  // 2. Higher σ ⇒ lower survival.
  const pLow = PURE.perTickSurvival(5, 0.005, 1.3);
  const pHi = PURE.perTickSurvival(5, 0.05, 1.3);
  check('survival monotonic decreasing in σ', pLow > pHi, `${pLow} vs ${pHi}`);

  // 3. Higher growth ⇒ higher EV at same p.
  const ev5 = PURE.perTickEV(0.05, 0.99, 0.001);
  const ev1 = PURE.perTickEV(0.01, 0.99, 0.001);
  check('EV increases with g at same p', ev5 > ev1, `${ev5} vs ${ev1}`);

  // 4. Negative-EV candidate is never selected.
  const best = PURE.bestGrowth(5, 0.03, [0.01, 0.02, 0.03, 0.04, 0.05], 1.3, 0.001, 0.5, 20);
  check('bestGrowth returns a candidate or null (never negative EV)', best === null || best.ev > 0, best ? `ev=${best.ev}` : 'null');

  // 5. bestGrowth respects survival floor (low p ⇒ blocked).
  const bestLow = PURE.bestGrowth(5, 0.12, [0.01, 0.02, 0.03, 0.04, 0.05], 1.3, 0.001, 0.6, 20);
  check('survival floor blocks high-σ', bestLow === null, bestLow ? `g=${bestLow.g}` : 'null');

  // 6. surviveK behaves.
  const s = PURE.surviveK(0.99, 20);
  check('surviveK(0.99,20)≈0.82', Math.abs(s - Math.pow(0.99, 20)) < 1e-12, `${s}`);

  // 7. volPercentile of an increasing series ranks last ≈ 1.
  const vp = PURE.volPercentile([0.1, 0.2, 0.3, 0.4, 0.5]);
  check('volPercentile ranks current high', Math.abs(vp - 1) < 1e-9, `${vp}`);

  // 8. Robust sigma on a known series.
  const sig = PURE.robustSigma([0.01, -0.01, 0.01, -0.01, 0.01, -0.01]);
  check('robustSigma on alternating ±0.01', sig.sigma > 0.01 && sig.sigma < 0.03, `${sig.sigma}`);

  console.log(`\n  Result: ${pass} passed, ${fail} failed\n`);
  return fail === 0;
}

async function main() {
  printBanner();
  if (process.argv.includes('--selftest')) {
    const ok = runSelfTest();
    process.exit(ok ? 0 : 1);
  }
  try { require.resolve('ws'); } catch (_) { console.error('npm install ws'); process.exit(1); }
  if (!CONFIG.apiToken) { console.error('API token not set'); process.exit(1); }
  console.log(CONFIG.telegram.enabled ? '✅ Telegram: ENABLED' : 'ℹ️ Telegram: DISABLED');
  const bot = new AccuPULSE2Bot(CONFIG);
  await bot.start();
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
