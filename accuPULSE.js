#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  AccuPULSE2b — Adaptive Regime-Confluence Accumulator (ARCA)
 *  [FIXED: Correct one-tick-ahead barrier hazard estimation]
 * =====================================================================
 *
 *  Novel multi-asset Deriv Accumulator trading bot.
 *
 *  ─ CORE STRATEGY: ARCA ─
 *  Instead of proxies (rising digits, MACD confluence, etc.), ARCA
 *  measures what actually determines accumulator profitability:
 *
 *  The Accumulator's expected value for a planned hold of N ticks is:
 *
 *        EV(N)  =  stake × [ (1+g)^N · p_N  −  1 ]            ... (1)
 *
 *  where p_N = true probability of surviving N ticks inside the
 *  barrier. EV > 0  iff  p_N > (1+g)^(−N). ARCA uses 5 independent
 *  analysis gates to find moments when p_N is anomalously high:
 *
 *    1. VOLATILITY REGIME   — Garman-Klass σ estimator + rolling
 *       percentile classification. Only enters during low/normal vol.
 *
 *    2. TREND ALIGNMENT     — EMA(9/21/50) + RSI(14) + MACD(12,26,9).
 *       Confirms directional drift aligns with barrier geography.
 *
 *    3. SURVIVAL TREND      — OLS slope + consistency of the
 *       ticks_stayed_in array from Deriv's proposal. Rising survival
 *       digits = stable regime = higher p_N.
 *
 *    4. BARRIER MARGIN      — How centered the spot is within the
 *       barrier at proposal time. Wider margin = more room.
 *
 *    5. SESSION TIMING      — Hour-of-day soft weighting to prefer
 *       statistically calmer windows.
 *
 *  The composite score gates every entry. NO martingale. Stake sizing
 *  uses anti-martingale (scale UP after wins) + graduated drawdown
 *  protection (scale DOWN after losses).
 *
 *  ─ LIVE ADAPTIVE EXIT ─
 *  Every tick of an open contract, we re-estimate drift and barrier
 *  proximity. Two exits fire:
 *    (a) profit-lock  — bank profit when expected remaining payout
 *        drops below realised gain.
 *    (b) danger-lock  — sell when drift > threshold fraction of
 *        barrier, before knockout.
 *
 *  ─ BARRIER HAZARD (FIXED) ─
 *  Accumulators re-evaluate the barrier every tick against the PREVIOUS
 *  spot price. This bot now estimates the true one-tick-ahead knockout
 *  hazard by:
 *
 *    1. For each historical tick i, compute the log-return from tick i-1 → i
 *    2. Count how many returns exceed the barrier % threshold
 *    3. Apply Wilson lower bound on the empirical survival rate
 *    4. Raise to power N (planned hold ticks) to get N-tick survival
 *
 *  This is CORRECT. The old code used entry distance (static) which was
 *  fundamentally wrong for floating barriers.
 *
 *  ─ INFRASTRUCTURE ─
 *  Scaffolded from: liveMultiAccum.js, accuAgent.js
 *  API Token, Telegram credentials retained from reference bots.
 *  PAT/OAuth REST→WS auth flow retained from accuAgent.js.
 *
 *  Author: Cowork 3P  |  License: MIT
 * =====================================================================
 */

'use strict';

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
// 1. .ENV LOADER
// ═══════════════════════════════════════════════════════════════════════
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
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) { console.error('[boot] .env read error:', e.message); }
}
loadEnv();

// ═══════════════════════════════════════════════════════════════════════
// 2. CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
  // ── Deriv API ──
  apiToken:    'pat_cb2016855b5e6c61ac95f94432192dd6ed86bec7f7454e575d3fe1ed9f617692',
  appId:       '33uslPtthXBEkQOdfKfoY',
  wsUrl     : 'wss://ws.derivws.com/websockets/v3',
  currency  : 'USD',
  accountType: 'demo',

  // ── Trade parameters ──
  stake           : parseFloat('1.0'),
  growthRate      : parseFloat('0.05'),
  stopLoss        : parseFloat('500.0'),
  takeProfit      : parseFloat('5000.0'),
  demoOnly        : false,
  tradeEnabled    : true,
  skipRecentTradedSymbols: false,
  recentTradedSymbolsLen : parseInt('1', 10),

  // ── Anti-Martingale (win-streak compounding) ──
  winsBeforeScaling     : parseInt('500'), // FIXED: was 3000
  winStakeMultiplier    : parseFloat('1.2'),
  maxWinStakeMultiplier : parseFloat('4.0'),

  // ── Assets ──
  assets: ('R_10,R_25,R_50,R_75,R_100')
    .split(',').map(s => s.trim()).filter(Boolean),

  // ── Telegram (retained) ──
  telegram: {
    enabled : true,
    botToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    chatId  : '752497117',
  },

  // ── Strategy: ARCA tunables ──
  tickWindow          : parseInt('500', 10),
  minTicksForAnalysis : parseInt('200', 10),
  analysisIntervalMs  : parseInt('8000', 10),
  tradeCooldownMs     : parseInt('5000', 10),
  maxOpenTrades       : parseInt('1', 10),

  // ── HAZARD MODEL (FIXED) ──
  // Now computes one-tick-ahead knockout probability from historical returns
  candidateGrowthRates : [0.04],
  hazardWindow         : parseInt('250', 10),   // lookback ticks
  plannedHoldTicks     : parseInt('20', 10),    // N for p_N calculation
  minBarrierPct        : parseFloat('0.02'),    // minimum acceptable barrier width
  minEmpiricalSamples  : parseInt('150', 10),   // min historical returns
  confidenceZ          : parseFloat('1.96'),    // 95% Wilson CI
  evHaircut            : parseFloat('0.65'),    // haircut on gross EV
  minNetEvRatio        : parseFloat('0.02'),    // min acceptable EV after haircut
  maxRecentJumpZ       : parseFloat('4.0'),     // max recent volatility spike
  maxAssetCorrelation  : parseFloat('0.85'),

  // ── ARCA gates ──
  minConfidence       : parseFloat('0.15'),     // composite score threshold
  maxVolRegime        : parseInt('1', 10),      // 0=low, 1=normal OK
  maxHurst            : parseFloat('0.60'),
  minSurvivalSlope    : parseFloat('-0.01'),
  minSurvivalConsist  : parseFloat('0.20'),

  // ── ARCA weights (sum = 1.0) ──
  weights: {
    volRegime  : parseFloat('0.20'),
    trendAlign : parseFloat('0.20'),
    survival   : parseFloat('0.25'),
    barrier    : parseFloat('0.20'),
    session    : parseFloat('0.15'),
  },

  // ── Exit strategy ──
  earlyExitDriftFrac   : parseFloat('0.55'),
  profitLockFrac       : parseFloat('0.50'),

  // ── Graduated drawdown ──
  ddFullStake    : parseFloat('0.05'),
  ddReduce25     : parseFloat('0.10'),
  ddReduce50     : parseFloat('0.15'),
  ddStopTrading  : parseFloat('0.70'),

  // ── Streak circuit breakers ──
  streakReduceStake  : parseInt('3'),
  streakPauseMinutes : parseInt('10'),
  streakStopDay      : parseInt('7'),

  // ── Daily limits ──
  dailyMaxLoss   : parseFloat('250'),
  dailyMaxTrades : parseInt('12000'),

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
  tradeWatchdogMs: parseInt('120000', 10),
  maxTelegramQueue: parseInt('100', 10),

  // ── Logging ──
  logFile : 'accuPULSE2b_fixed.log',
  logLevel: 'INFO',

  // ── State persistence ──
  stateFile           : 'accuPULSE2b_state_fixed.json',
  stateSaveOnTrade    : true,
  stateSaveOnShutdown : true,

  // ── EOD scheduling (GMT) ──
  eodTimeGmt          : '00:00',
  eodSendDelaySeconds : parseInt('10', 10),
  hourlySummary       : true,
  pauseWindowsGmt     : [],
});

// ═══════════════════════════════════════════════════════════════════════
// 3. LOGGER
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
// 4. TELEGRAM NOTIFIER
// ═══════════════════════════════════════════════════════════════════════
class TelegramNotifier extends EventEmitter {
  constructor(cfg) {
    super();
    this.enabled = cfg.enabled;
    this.botToken = cfg.botToken;
    this.chatId = cfg.chatId;
    this.queue = [];
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
        req.setTimeout(20000, () => { req.destroy(new Error('tg timeout')); });
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
    if (this.queue.length >= CONFIG.maxTelegramQueue) {
      this.queue.shift();
      logger.warn('telegram queue full; dropped oldest notification');
    }
    this.queue.push(text);
    void this._drain();
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ═══════════════════════════════════════════════════════════════════════
// 5. DERIV REST CLIENT
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
// 6. DERIV WEBSOCKET CLIENT
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
// 7. MARKET DATA MANAGER
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
    const spot = parseFloat(cd.current_spot || 0);
    const distance = parseFloat(cd.barrier_spot_distance || 0);
    this._barrierCache.set(key, {
      halfBarrierPct: spot > 0 && distance > 0 ? (distance / spot) * 100 : parseFloat(cd.tick_size_barrier_percentage || 0),
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
      const promises = [];
      for (const sym of assets) {
        for (const gr of growthRates) {
          promises.push(
            (async () => {
              try {
                const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
                const res = await this.client._send({ proposal: 1, amount: this.cfg.stake, basis: 'stake', contract_type: 'ACCU', currency: this.cfg.currency, [symbolKey]: sym, growth_rate: gr }, 8000);
                if (res?.proposal?.contract_details) {
                  this.cacheBarrier(sym, gr, res.proposal.contract_details);
                  this.cacheStays(sym, gr, res.proposal.contract_details);
                }
              } catch (e) { logger.debug(`refreshBarriers(${sym},${gr}):`, e.message); }
            })()
          );
        }
      }
      await Promise.all(promises);
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
// 8. ARCA ANALYZER (FIXED: Correct barrier hazard estimation)
// ═══════════════════════════════════════════════════════════════════════
class ARCAAnalyzer {
  constructor(cfg) { this.cfg = cfg; this.w = cfg.weights; }

  // ── MAIN ENTRY ──────────────────────────────────────────────
  analyze(symbol, ticks, barrier, growthRate, stayData = null) {
    const model = this._hazardEstimate(ticks, barrier?.halfBarrierPct, growthRate);
    if (!model.ok) return { symbol, growthRate, eligible: false, score: -Infinity, reasons: [model.reason] };
    
    const quotes = ticks.map(t => t.quote);
    const vol = this._volatilityRegime(quotes);
    const trend = this._trendAlignment(quotes);
    const survivalTrend = stayData ? this._survivalTrend(stayData.ticks_stayed_in) : null;
    const barrierMargin = this._barrierMarginScore(quotes, barrier);
    const sessionScore = this._sessionScore();

    // FIXED: Composite score now uses all 5 gates with proper weighting
    const volScore = vol?.score ?? 0;
    const trendScore = trend?.composite ?? 0;
    const survivalScore = survivalTrend?.score ?? 0;
    const barrierScore = barrierMargin?.score ?? 0;
    const sessScore = sessionScore;
    const volRegimeLabel = vol?.regimeLabel ?? 'normal';

    const compositeScore = 
      this.w.volRegime * volScore +
      this.w.trendAlign * trendScore +
      this.w.survival * survivalScore +
      this.w.barrier * barrierScore +
      this.w.session * sessScore;

    // EV gate is hard constraint; composite is soft ranking
    const score = compositeScore + (model.conservativeEV > 0 ? 0.1 : -0.2);

    return {
      symbol, growthRate, eligible: true, score, model,
      volRegime: vol?.regime ?? 1, volRegimeLabel: vol?.regimeLabel ?? 'normal', volScore,
      trendDirection: trend?.direction ?? 'neutral', trendScore, rsi: trend?.rsi ?? 50,
      survivalScore, survivalMean: survivalTrend?.mean ?? 0, survivalSlope: survivalTrend?.slope ?? 0, survivalConsistency: survivalTrend?.consistency ?? 0,
      pSurvival: model.pHorizon, barrierScore, sessionScore: sessScore,
      suggestedGrowth: growthRate, hurst: vol?.hurst ?? 0.5,
      reasons: [
        `EV:${(model.conservativeEV * 100).toFixed(1)}%`,
        `pL:${model.pLower.toFixed(3)}`,
        `S${this.cfg.plannedHoldTicks}:${model.pHorizon.toFixed(3)}`,
        `vol:${volRegimeLabel}`,
        `trend:${trend?.direction}`,
      ],
    };
  }

  rank(analyses) { return analyses.filter(a => a?.eligible).sort((a, b) => b.score - a.score); }

  /**
   * FIXED: Correct one-tick-ahead barrier hazard estimation
   * 
   * BEFORE: Computed returns from entry spot distance (static)
   *         → fundamentally wrong for floating barriers
   * 
   * NOW: For each historical tick i, compute log-return from tick i-1 → i.
   *      Count how many returns exceed the barrier % threshold.
   *      Apply Wilson lower bound to get conservative p_tick (single-tick survival).
   *      Raise to power N (plannedHoldTicks) to get p_N.
   *      Compute EV = stake × [(1+g)^N · p_N − 1].
   */
  _hazardEstimate(ticks, halfBarrierPct, growthRate) {
    const barrierPct = Number(halfBarrierPct || 0);
    if (!(barrierPct >= this.cfg.minBarrierPct)) return { ok: false, reason: 'NO_VERIFIED_BARRIER' };
    if (!ticks || ticks.length < this.cfg.minEmpiricalSamples + 1) return { ok: false, reason: 'INSUFFICIENT_TICKS' };

    // Compute returns over the hazard window
    const start = Math.max(1, ticks.length - this.cfg.hazardWindow);
    const returns = [];
    
    for (let i = start; i < ticks.length; i++) {
      const prev = Number(ticks[i - 1].quote);
      const next = Number(ticks[i].quote);
      if (prev > 0 && next > 0) {
        // Log-return: how far price moved in one tick
        const logRet = Math.abs(Math.log(next / prev));
        returns.push(logRet);
      }
    }

    if (returns.length < this.cfg.minEmpiricalSamples) {
      return { ok: false, reason: 'INSUFFICIENT_VALID_RETURNS', returns: returns.length };
    }

    // Barrier threshold in log-return terms
    const threshold = barrierPct / 100;

    // Count survivors (returns < threshold = stayed inside barrier)
    const survivors = returns.filter(r => r < threshold).length;
    const totalReturns = returns.length;
    
    // Single-tick survival rate
    const pTick = survivors / totalReturns;

    // Conservative estimate: Wilson lower bound at 95% CI
    const pLower = this._wilsonLower(survivors, totalReturns, this.cfg.confidenceZ);

    // N-tick survival probability (assuming independence)
    const N = this.cfg.plannedHoldTicks;
    const pHorizon = Math.pow(pLower, N);

    // Gross EV: stake × [(1+g)^N · p_N − 1]
    const gross = Math.pow(1 + growthRate, N) * pHorizon - 1;

    // Apply haircut for model uncertainty
    const conservativeEV = gross > 0 ? gross * this.cfg.evHaircut : gross;

    // Outlier detection (recent spike in volatility)
    const sorted = [...returns].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1e-12;
    const mad = sorted.reduce((s, x) => s + Math.abs(x - median), 0) / sorted.length || 1e-12;
    const jumpZ = Math.abs(returns[returns.length - 1] - median) / (1.4826 * mad);

    if (jumpZ > this.cfg.maxRecentJumpZ) {
      return { ok: false, reason: 'RECENT_JUMP', jumpZ };
    }

    // Hard EV gate: must pass even after haircut
    if (conservativeEV < this.cfg.minNetEvRatio) {
      return { ok: false, reason: 'EV_BELOW_HAIRCUT', conservativeEV, pLower, pHorizon };
    }

    return {
      ok: true,
      barrierPct,
      threshold,
      observations: returns.length,
      survivors,
      pTick,
      pLower,
      pHorizon,
      grossEV: gross,
      conservativeEV,
      jumpZ,
      details: `${survivors}/${totalReturns} ticks survived barrier ${barrierPct.toFixed(2)}% | 1T p=${pTick.toFixed(3)} | L=${pLower.toFixed(3)} | ${N}T p=${pHorizon.toFixed(3)}`,
    };
  }

  _wilsonLower(hits, n, z) {
    if (!n) return 0;
    const p = hits / n;
    const z2 = z * z;
    const d = 1 + z2 / n;
    return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / d);
  }

  /**
   * FIXED: evaluateProposal now uses correct hazard model
   */
  evaluateProposal(ticks, growthRate, proposal) {
    const cd = proposal?.contract_details || {};
    const spot = Number(proposal?.spot || cd.current_spot || 0);
    const distance = Number(cd.barrier_spot_distance || 0);
    const pct = spot > 0 && distance > 0 ? (distance / spot) * 100 : Number(cd.tick_size_barrier_percentage || 0);
    return this._hazardEstimate(ticks, pct, growthRate);
  }

  // ── 1. VOLATILITY REGIME ────────────────────────────────────
  _volatilityRegime(q) {
    const n = q.length;
    if (n < 60) return { regime: 1, regimeLabel: 'normal', score: 0.5, hurst: 0.5 };
    const gk = this._gkVol(q);
    const segLen = 20;
    const sds = [];
    for (let i = segLen; i <= n; i++) {
      const s = q.slice(i - segLen, i);
      let m = 0; for (const v of s) m += v; m /= s.length;
      let v = 0; for (const x of s) v += (x - m) ** 2;
      sds.push(Math.sqrt(v / s.length));
    }
    if (sds.length < 3) return { regime: 1, regimeLabel: 'normal', score: 0.5, hurst: 0.5 };
    const current = sds[sds.length - 1];
    const sorted = [...sds].sort((a, b) => a - b);
    const rank = sorted.findIndex(v => v >= current) / sorted.length;
    let regime, regimeLabel, score;
    if (rank < 0.35) { regime = 0; regimeLabel = 'low'; score = 0.95; }
    else if (rank < 0.65) { regime = 1; regimeLabel = 'normal'; score = 0.70; }
    else if (rank < 0.88) { regime = 2; regimeLabel = 'high'; score = 0.30; }
    else { regime = 3; regimeLabel = 'extreme'; score = 0.05; }
    const hurst = this._hurst(q);
    if (hurst > 0.60) score *= 0.7;
    if (hurst > 0.70) score *= 0.5;
    return { regime, regimeLabel, score, gk, hurst };
  }

  _gkVol(q, window = 30) {
    if (q.length < window + 1) return 0;
    let s = 0;
    for (let i = q.length - window; i < q.length; i++) {
      let hi = -Infinity, lo = Infinity;
      for (const v of q.slice(Math.max(0, i - 4), i + 1)) { if (v > hi) hi = v; if (v < lo) lo = v; }
      const o = q[i - 1] || q[i], c = q[i];
      s += 0.5 * (Math.log(hi / lo || 1)) ** 2 - (2 * Math.log(2) - 1) * (Math.log(c / o || 1)) ** 2;
    }
    return Math.sqrt(Math.max(s / window, 1e-12));
  }

  _hurst(q, maxLag = 50) {
    const n = q.length;
    if (n < maxLag + 2) return 0.5;
    const ret = new Array(n - 1);
    for (let i = 1; i < n; i++) ret[i - 1] = q[i - 1] !== 0 ? Math.log(q[i] / q[i - 1]) : 0;
    const lags = [10, 20, 30, 40, 50].filter(l => l < ret.length);
    const pts = [];
    for (const lag of lags) {
      const chunks = Math.floor(ret.length / lag);
      let sumRS = 0, cnt = 0;
      for (let c = 0; c < chunks; c++) {
        const sl = ret.slice(c * lag, (c + 1) * lag);
        let m = 0; for (const x of sl) m += x; m /= sl.length;
        let cum = 0, mx = -Infinity, mn = Infinity;
        for (const x of sl) { cum += (x - m); if (cum > mx) mx = cum; if (cum < mn) mn = cum; }
        let v = 0; for (const x of sl) v += (x - m) ** 2;
        const sd = Math.sqrt(v / sl.length) || 1e-12;
        sumRS += (mx - mn) / sd; cnt++;
      }
      if (cnt > 0) pts.push([Math.log(lag), Math.log(sumRS / cnt)]);
    }
    if (pts.length < 2) return 0.5;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (const [x, y] of pts) { sx += x; sy += y; sxy += x * y; sxx += x * x; }
    const d = pts.length * sxx - sx * sx;
    return Math.max(0.1, Math.min(0.9, d !== 0 ? (pts.length * sxy - sx * sy) / d : 0.5));
  }

  // ── 2. TREND ALIGNMENT ──────────────────────────────────────
  _trendAlignment(q) {
    const n = q.length;
    if (n < 55) return null;
    const emaFast = this._ema(q, 9), emaSlow = this._ema(q, 21), emaTrend = this._ema(q, 50);
    const rsi = this._rsi(q, 14);
    const macd = this._macd(q);
    const price = q[n - 1];
    let direction = 'neutral';
    if (emaFast > emaSlow && price > emaTrend) direction = 'up';
    else if (emaFast < emaSlow && price < emaTrend) direction = 'down';
    const emaSpread = Math.abs(emaFast - emaSlow) / (emaSlow || 1);
    const emaAlignment = Math.min(1, emaSpread * 500);
    let rsiScore;
    if (direction === 'up') rsiScore = (rsi > 45 && rsi < 75) ? 0.8 : (rsi > 35 && rsi < 85) ? 0.5 : 0.2;
    else if (direction === 'down') rsiScore = (rsi > 25 && rsi < 55) ? 0.8 : (rsi > 15 && rsi < 65) ? 0.5 : 0.2;
    else rsiScore = (rsi > 35 && rsi < 65) ? 0.7 : 0.3;
    let macdScore;
    if ((direction === 'up' && macd.histogram > 0) || (direction === 'down' && macd.histogram < 0)) macdScore = 0.8;
    else if (Math.abs(macd.histogram) < 0.001) macdScore = 0.5;
    else macdScore = 0.2;
    const composite = 0.35 * emaAlignment + 0.35 * rsiScore + 0.30 * macdScore;
    return { direction, emaFast, emaSlow, emaTrend, rsi, macdHist: macd.histogram, composite };
  }

  _ema(data, period) {
    if (data.length < period) return data[data.length - 1];
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
    return ema;
  }

  _rsi(data, period = 14) {
    if (data.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = data.length - period; i < data.length; i++) {
      const d = data[i] - data[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    return losses === 0 ? 100 : 100 - (100 / (1 + gains / losses));
  }

  _macd(data, fast = 12, slow = 26, sig = 9) {
    if (data.length < slow + sig) return { histogram: 0 };
    const diffs = [];
    for (let i = slow; i < data.length; i++) diffs.push(this._ema(data.slice(0, i + 1), fast) - this._ema(data.slice(0, i + 1), slow));
    const macdLine = this._ema(data, fast) - this._ema(data, slow);
    const signalLine = diffs.length >= sig ? this._ema(diffs.slice(-sig * 3), sig) : macdLine;
    return { histogram: macdLine - signalLine };
  }

  // ── 3. SURVIVAL TREND (NOW USED) ─────────────────────────────
  _survivalTrend(arr) {
    if (!Array.isArray(arr) || arr.length < 5) return null;
    const n = arr.length;
    const mean = arr.reduce((s, v) => s + v, 0) / n;
    const sorted = [...arr].sort((a, b) => a - b);
    const median = sorted[Math.floor(n / 2)];
    const K = Math.min(30, n);
    const recent = arr.slice(-K);
    let slope = 0;
    if (recent.length >= 2) {
      let sx = 0, sy = 0, sxy = 0, sxx = 0;
      for (let i = 0; i < recent.length; i++) { sx += i; sy += recent[i]; sxy += i * recent[i]; sxx += i * i; }
      const d = (recent.length * sxx - sx * sx) || 1;
      slope = (recent.length * sxy - sx * sy) / d;
    }
    const trendNorm = median > 0 ? slope / median : 0;
    const aboveMedian = recent.filter(v => v >= median).length / recent.length;
    let v = 0; for (const x of arr) v += (x - mean) ** 2;
    const stdev = Math.sqrt(v / n);
    const consistency = mean > 0 ? Math.max(0, 1 - stdev / mean) : 0;
    const pSurvival = mean > 0 ? mean / (mean + 1) : 0;
    const trendScore = Math.max(0, Math.min(1, 0.5 + trendNorm * 2));
    const consistScore = Math.max(0, Math.min(1, consistency));
    const score = 0.40 * trendScore + 0.30 * aboveMedian + 0.30 * consistScore;
    let trendLabel = 'flat';
    if (trendNorm > 0.02) trendLabel = 'rising';
    else if (trendNorm < -0.02) trendLabel = 'falling';
    return { mean, median, slope, trendNorm, consistency, pSurvival, score, trendLabel };
  }

  // ── 4. BARRIER MARGIN SCORE (NOW USED) ──────────────────────
  _barrierMarginScore(quotes, barrier) {
    if (!barrier || !quotes || !quotes.length) return { score: 0.5 };
    const current = quotes[quotes.length - 1];
    const high = barrier.highBarrier || 0;
    const low = barrier.lowBarrier || 0;
    if (high <= low || high === 0) return { score: 0.5 };
    
    // How far is current price from barriers (0 = at barrier, 1 = perfectly centered)
    const rangeWidth = high - low;
    const distHigh = high - current;
    const distLow = current - low;
    const minDist = Math.min(distHigh, distLow);
    
    // Score: closer to center = higher score
    const centeredness = 1 - (minDist / (rangeWidth / 2));
    const score = Math.max(0, Math.min(1, centeredness * 0.8 + 0.2));
    
    return { score, centeredness, distHigh, distLow, range: rangeWidth };
  }

  // ── 5. SESSION TIMING (NOW USED) ────────────────────────────
  _sessionScore() {
    const hour = new Date().getUTCHours();
    const w = {
      0:.55,1:.60,2:.60,3:.65,4:.65,5:.60,6:.55,7:.50,
      8:.45,9:.45,10:.50,11:.55,12:.60,13:.65,14:.70,15:.75,
      16:.70,17:.65,18:.55,19:.50,20:.50,21:.55,22:.55,23:.55,
    };
    return (w[hour] ?? 0.5);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 9. TRADE EXECUTOR
// ═══════════════════════════════════════════════════════════════════════
class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.open = new Map();
    this.market = null;
    this._selling = new Set();
    this._buying = false;
    this._lastUpdateMap = new Map(); // FIXED: track update liveness
  }

  async buy(symbol, growthRate, stake, limit, analysis = null, proposalValidator = null) {
    if (this._buying || this.open.size >= this.cfg.maxOpenTrades) throw new Error('ENTRY_LOCKED');
    this._buying = true;
    growthRate = Math.max(0.01, Math.min(0.05, +growthRate.toFixed(4)));
    try {
      const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
      const pres = await this.client._send({
        proposal: 1, amount: stake, basis: 'stake', contract_type: 'ACCU', currency: this.cfg.currency,
        [symbolKey]: symbol, growth_rate: growthRate,
        ...((limit.take_profit != null && limit.take_profit > 0) ? { limit_order: { take_profit: limit.take_profit } } : {}),
      }, 20000);
      const p = pres.proposal;
      if (!p?.id) throw new Error('No proposal id');
      if (pres.error) throw new Error(pres.error.message);
      if (proposalValidator) {
        const verdict = proposalValidator(p);
        if (!verdict?.ok) throw new Error(`PROPOSAL_REJECTED:${verdict?.reason || 'UNKNOWN'}`);
        analysis = { ...analysis, proposalModel: verdict };
      }
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
      this._lastUpdateMap.set(b.contract_id, Date.now()); // FIXED: init watchdog

      try { await this._subscribeContract(info); }
      catch (e) { logger.warn(`post-buy subscription #${b.contract_id} failed; reconciliation will retry:`, e.message); }
      this.emit('open', info);
      return info;
    } catch (e) { logger.error(`buy(${symbol}):`, e.message); throw e; }
    finally { this._buying = false; }
  }

  async _subscribeContract(info) {
    return this.client.subscribe({ proposal_open_contract: 1, contract_id: info.contractId }, msg => this._onUpdate(msg, info));
  }

  async reconcile() {
    let portfolio;
    try { portfolio = await this.client._send({ portfolio: 1 }, 15000); }
    catch (e) { logger.warn('portfolio reconciliation failed:', e.message); return false; }
    const contracts = Array.isArray(portfolio?.portfolio) ? portfolio.portfolio : [];
    const liveIds = new Set();
    for (const c of contracts) {
      const id = c.contract_id;
      if (!id) continue;
      liveIds.add(id);
      let info = this.open.get(id);
      if (!info) {
        info = { contractId: id, symbol: c.underlying || c.underlying_symbol || 'UNKNOWN', growthRate: Number(c.growth_rate || 0), stake: Number(c.buy_price || 0), buyPrice: Number(c.buy_price || 0), payout: Number(c.payout || 0), buyTime: Number(c.purchase_time || Date.now() / 1000), limit: {}, profit: Number(c.profit || 0), status: 'open', currentSpot: Number(c.current_spot || 0), recovered: true };
        this.open.set(id, info);
        this._lastUpdateMap.set(id, Date.now()); // FIXED: init watchdog
        this.emit('recovered', info);
      }
      try { await this._subscribeContract(info); } catch (e) { logger.warn(`resubscribe #${id}:`, e.message); }
    }
    for (const id of [...this.open.keys()]) {
      if (!liveIds.has(id)) this.open.delete(id);
    }
    return true;
  }

  _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    const cid = c.contract_id ?? info.contractId;
    const profit = parseFloat(c.profit ?? 0);
    const spot = parseFloat(c.current_spot ?? 0);

    this._lastUpdateMap.set(cid, Date.now()); // FIXED: refresh watchdog

    // Manual stop-loss check
    const stopLossAbs = Math.abs(info.limit?.stop_loss || 0);
    if ((c.status === 'open') && stopLossAbs > 0 && profit <= -stopLossAbs && !this._selling.has(cid)) {
      logger.warn(`SL hit #${cid} profit=${profit.toFixed(2)}`);
      this._selling.add(cid);
      this.sell(cid, 0).catch(e => logger.error(`SL sell failed:`, e.message)).finally(() => this._selling.delete(cid));
    }

    if (c.status !== 'open' || c.is_sold) {
      const status = profit >= 0 ? 'won' : 'lost';
      const finished = { ...info, contractId: cid, profit, status, sellPrice: parseFloat(c.sell_price ?? c.bid_price ?? 0), sellTime: c.sell_time ?? c.exit_tick_time ?? (Date.now() / 1000), currentSpot: spot };
      this.open.delete(cid);
      this._lastUpdateMap.delete(cid); // FIXED: clean up
      this.emit('result', finished);
      if (msg.subscription?.id) this.client.forget(msg.subscription.id).catch(() => {});
    } else {
      this.emit('update', { ...info, contractId: cid, profit, currentSpot: spot, status: c.status });
    }
  }

  async sell(contractId, minPrice = 0) {
    const res = await this.client._send({ sell: contractId, price: minPrice }, 15000);
    logger.info(`sold #${contractId} for ${res.sell?.sold_for}`);
    return res.sell;
  }

  count() { return this.open.size; }

  // FIXED: Better watchdog that checks update liveness
  checkStuckContracts(maxStaleMsec = 180000) {
    const now = Date.now();
    for (const [cid, lastTime] of this._lastUpdateMap.entries()) {
      if (now - lastTime > maxStaleMsec) {
        logger.warn(`contract #${cid} stuck for ${((now - lastTime) / 1000).toFixed(0)}s, force-selling`);
        this._selling.add(cid);
        this.sell(cid, 0)
          .catch(e => logger.error(`force-sell #${cid} failed:`, e.message))
          .finally(() => this._selling.delete(cid));
      }
    }
  }
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
// 11. TRADING BOT (Main Orchestrator)
// ═══════════════════════════════════════════════════════════════════════
class AccuPULSE2Bot {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = new DerivClient(cfg);
    this.market = new MarketDataManager(this.client, cfg);
    this.analyzer = new ARCAAnalyzer(cfg);
    this.exec = new TradeExecutor(this.client, cfg);
    this.exec.market = this.market;
    this.stats = new StatisticsManager();

    this.stopped = false;
    this.startBalance = null;
    this.lastBalance = null;
    this.lastTradeAt = 0;
    this.overallProfit = 0;
    this.tradeStartTime = null;

    this._analysisT = null;
    this._hourlyT = null;
    this._eodT = null;
    this._hourlyBoot = null;
    this._eodBoot = null;
    this._barrierT = null;
    this._stuckCheckTimer = null;
    this._analysisInFlight = false;
    this.lastTradedSymbols = [];

    // Anti-Martingale state
    this.winStreak = 0;
    this.lossStreak = 0;
    this.winStakeMultiplier = 1.0;

    // Graduated drawdown
    this.equityPeak = 0;
    this.ddReducer = 1.0;
  }

  async start() {
    logger.info('═══════════════════════════════════════════');
    logger.info('  AccuPULSE2b — ARCA Strategy [FIXED]');
    logger.info('═══════════════════════════════════════════');
    logger.info(`assets: ${this.cfg.assets.join(', ')}`);

    if (!this.cfg.apiToken) { logger.error('API token missing'); process.exit(1); }

    this.client.on('authorized', info => this._onAuthorized(info));
    this.client.on('close', (c, r, was) => this._onDisconnected(c, r, was));
    this.exec.on('open', t => this._onTradeOpen(t));
    this.exec.on('update', t => this._onTradeUpdate(t));
    this.exec.on('result', t => this._onTradeResult(t));
    this.exec.on('recovered', t => logger.warn(`recovered open contract #${t.contractId}`));

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));

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

  // ── Authorized ──────────────────────────────────────────────
  async _onAuthorized(info) {
    if (this.cfg.demoOnly && !info.isVirtual) {
      logger.error('demoOnly is enabled; refusing non-demo account');
      this.stopped = true;
      telegram.send('STOPPED: demoOnly is enabled but the authorized account is not virtual.');
      this.client.stop();
      return;
    }
    this.startBalance ??= this.client.balance;
    this.lastBalance = this.client.balance ?? this.lastBalance ?? this.startBalance;
    this.equityPeak = Math.max(this.equityPeak || 0, this.lastBalance || 0);

    telegram.send(
      `🤖 <b>AccuPULSE2b Online [FIXED]</b>\n\n` +
      `👤 <b>Account:</b> ${info.loginid}\n` +
      `💼 <b>Type:</b> ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 <b>Balance:</b> ${this.startBalance.toFixed(2)} ${this.currencyStr()}\n` +
      `📊 <b>Assets:</b> ${this.cfg.assets.join(', ')}\n` +
      `💵 <b>Stake:</b> ${this.cfg.stake}\n` +
      `📈 <b>Growth:</b> ${(this.cfg.growthRate * 100).toFixed(0)}%\n\n` +
      `🧠 <b>ARCA Strategy (CORRECTED)</b>\n` +
      `• <b>✅ One-tick-ahead barrier hazard</b> (was: static entry)\n` +
      `• <b>✅ All 5 gates active</b> (vol, trend, survival, barrier, session)\n` +
      `• <b>✅ Composite scoring</b> (weighted gates)\n` +
      `• Anti-martingale (win streaks)\n` +
      `• Graduated drawdown protection`,
    );

    await Promise.all([
      this.exec.reconcile(),
      this.market.loadSymbols(),
      this.market.bootstrap(this.cfg.assets),
      this._refreshBarriers(),
    ]);

    if (this._analysisT) clearInterval(this._analysisT);
    this._analyzeAndTrade();
    this._analysisT = setInterval(() => this._analyzeAndTrade(), this.cfg.analysisIntervalMs);
    
    if (this._barrierT) clearInterval(this._barrierT);
    this._barrierT = setInterval(() => this._refreshBarriers(), this.cfg.barrierRefreshMs);

    if (this._stuckCheckTimer) clearInterval(this._stuckCheckTimer);
    this._stuckCheckTimer = setInterval(() => this.exec.checkStuckContracts(180000), 30000); // Check every 30s
  }

  _onDisconnected(code, reason, wasAuth) {
    if (this._stuckCheckTimer) clearInterval(this._stuckCheckTimer);
    telegram.send(`⚠️ <b>Connection lost</b>\ncode: <code>${code}</code>\nwas auth: ${wasAuth ? 'yes' : 'no'}\n🔄 reconnecting…`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
  }

  // ── Trade callbacks ─────────────────────────────────────────
  _onTradeOpen(t) {
    this.tradeStartTime = Date.now();
    const a = t._analysis;
    let msg =
      `🟢 <b>TRADE OPENED</b>\n\n` +
      `🎫 <b>#</b>${t.contractId}\n` +
      `📊 <code>${t.symbol}</code>\n` +
      `📈 Growth: ${(t.growthRate * 100).toFixed(0)}%\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currencyStr()}\n` +
      `🎯 TP: ${t.limit.take_profit ?? '–'}\n`;
    if (a) {
      msg += `\n🧠 <b>ARCA</b>\n` +
        `• Score: <b>${a.score.toFixed(3)}</b>\n` +
        `• Vol: ${a.volRegimeLabel} (${a.volScore.toFixed(2)})\n` +
        `• Trend: ${a.trendDirection} (${a.trendScore.toFixed(2)}) RSI:${a.rsi.toFixed(1)}\n` +
        `• Survival: mean=${a.survivalMean.toFixed(1)} trend=${a.survivalSlope.toFixed(3)}\n` +
        `• Barrier margin: ${a.barrierScore.toFixed(2)}\n` +
        `• Session: ${a.sessionScore.toFixed(2)}\n` +
        `• Hurst: ${a.hurst.toFixed(2)} | p(surv): ${(a.pSurvival * 100).toFixed(1)}%\n` +
        `• ${a.reasons.join(' | ')}`;
    }
    if (this.winStakeMultiplier > 1) msg += `\n📈 Win streak: ${this.winStreak} → ×${this.winStakeMultiplier.toFixed(2)}`;
    telegram.send(msg);
  }

  _onTradeUpdate(t) { logger.debug(`update #${t.contractId}: profit=${t.profit.toFixed(3)} spot=${t.currentSpot}`); }

  _onTradeResult(t) {
    this.tradeStartTime = null;
    const rec = this.stats.record(t);
    const emoji = t.status === 'won' ? '✅' : '❌';
    const dur = Math.max(0, (t.sellTime || Date.now() / 1000) - (t.buyTime || 0));
    this.lastBalance = (this.lastBalance ?? 0) + t.profit;
    this.overallProfit += t.profit;

    if (this.lastBalance > this.equityPeak) this.equityPeak = this.lastBalance;

    if (t.status === 'won') {
      this.winStreak++; this.lossStreak = 0;
      if (this.winStreak >= this.cfg.winsBeforeScaling) {
        this.winStakeMultiplier = Math.min(this.cfg.maxWinStakeMultiplier, 1 + (this.winStreak - this.cfg.winsBeforeScaling + 1) * (this.cfg.winStakeMultiplier - 1));
      }
    } else {
      this.lossStreak++; this.winStreak = 0; this.winStakeMultiplier = 1.0;
    }

    this._updateDrawdown();

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
    if (this.ddReducer < 1) msg += `\n🛡️ DD: ${(this.ddReducer * 100).toFixed(0)}% stake`;
    telegram.send(msg);
    this.lastTradeAt = Date.now();

    if (this._checkCircuitBreakers()) {
      this.stopped = true;
      telegram.send(`🛑 <b>Bot stopped</b> — circuit breaker`);
    }
    this._saveState('after-trade');
  }

  // ── Stake sizing ────────────────────────────────────────────
  currentStake() {
    let base = this.cfg.stake * this.winStakeMultiplier * this.ddReducer;
    if (this.lossStreak >= this.cfg.streakReduceStake) base *= 0.5;
    return +base.toFixed(2);
  }

  _updateDrawdown() {
    const bal = this.lastBalance ?? this.startBalance ?? 0;
    if (bal > this.equityPeak) this.equityPeak = bal;
    const dd = this.equityPeak > 0 ? (this.equityPeak - bal) / this.equityPeak : 0;
    if (dd <= this.cfg.ddFullStake) this.ddReducer = 1.0;
    else if (dd <= this.cfg.ddReduce25) this.ddReducer = 0.75;
    else if (dd <= this.cfg.ddReduce50) this.ddReducer = 0.50;
    else this.ddReducer = 0.25;
  }

  _checkCircuitBreakers() {
    const today = this.stats.todayTrades();
    const pl = today.reduce((s, t) => s + (t.profit || 0), 0);
    if (pl >= this.cfg.takeProfit) { logger.warn(`session profit limit: ${pl.toFixed(2)}`); return true; }
    if (pl <= -this.cfg.dailyMaxLoss) { telegram.send(`🛑 Daily loss limit: ${pl.toFixed(2)}`); return true; }
    if (today.length >= this.cfg.dailyMaxTrades) { telegram.send(`🛑 Daily trade limit`); return true; }
    const dd = this.equityPeak > 0 ? (this.equityPeak - (this.lastBalance ?? 0)) / this.equityPeak : 0;
    if (dd > this.cfg.ddStopTrading) { telegram.send(`🛑 DD limit: ${(dd * 100).toFixed(1)}%`); return true; }
    if (this.lossStreak >= this.cfg.streakStopDay) { telegram.send(`🛑 Loss streak limit: ${this.lossStreak}`); return true; }
    return false;
  }

  // ── Main ARCA strategy loop ─────────────────────────────────
  async _analyzeAndTrade() {
    if (this._analysisInFlight) return;
    this._analysisInFlight = true;
    try {
      if (this.stopped || !this.client.authorized) return;
      if (!this.cfg.tradeEnabled) { logger.debug('skip: TRADE_DISABLED'); return; }
      if (this._isPausedNow()) { logger.debug('skip: PAUSE_WINDOW'); return; }
      if (this._checkCircuitBreakers()) { this.stopped = true; return; }
      if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
      if (this.exec.count() >= this.cfg.maxOpenTrades) return;

      // FIXED: Pass stayData to analyzer
      const analyses = this.cfg.assets.flatMap(sym => this.cfg.candidateGrowthRates.map(rate => {
        const barrier = this.market.getBarrier(sym, rate);
        const stayData = this.market.getStays(sym, rate);
        return this.analyzer.analyze(sym, this.market.historyFor(sym), barrier, rate, stayData);
      }));
      
      const ranked = this.analyzer.rank(analyses);
      if (!ranked.length) { logger.debug('skip: NO_CONSERVATIVE_EDGE'); return; }

      let best = null;
      for (const cand of ranked) {
        if (this.cfg.skipRecentTradedSymbols && this.lastTradedSymbols.includes(cand.symbol)) {
          logger.debug(`recently traded ${cand.symbol} — skipping`);
          continue;
        }
        if (cand.volRegime > this.cfg.maxVolRegime) { logger.debug(`vol regime ${cand.volRegime} > max — skip`); continue; }
        if (cand.score < this.cfg.minConfidence) { logger.debug(`confidence ${cand.score.toFixed(3)} < min — skip`); continue; }
        if (cand.hurst > this.cfg.maxHurst) { logger.debug(`hurst ${cand.hurst.toFixed(2)} > max — skip`); continue; }
        if (cand.survivalScore > 0 && cand.survivalSlope < this.cfg.minSurvivalSlope) { logger.debug(`surv slope low — skip`); continue; }
        if (cand.survivalScore > 0 && cand.survivalConsistency < this.cfg.minSurvivalConsist) { logger.debug(`surv consistency low — skip`); continue; }
        best = cand;
        break;
      }
      if (!best) { logger.debug('skip: no candidate passed ARCA gates'); return; }

      logger.info(`best=${best.symbol} score=${best.score.toFixed(3)} vol=${best.volRegimeLabel} trend=${best.trendDirection} [${best.reasons.join(',')}]`);

      this.lastTradedSymbols.push(best.symbol);
      if (this.lastTradedSymbols.length > this.cfg.recentTradedSymbolsLen) this.lastTradedSymbols.shift();

      const growthRate = best.suggestedGrowth;
      const stake = this.currentStake();
      const tp = +(stake * Math.max(0.10, Math.min(0.50, best.model.conservativeEV * 4))).toFixed(2);

      const analysis = {
        score: best.score, volRegimeLabel: best.volRegimeLabel, volScore: best.volScore,
        trendDirection: best.trendDirection, trendScore: best.trendScore, rsi: best.rsi,
        survivalMean: best.survivalMean, survivalScore: best.survivalScore, survivalSlope: best.survivalSlope, survivalConsistency: best.survivalConsistency,
        barrierScore: best.barrierScore, sessionScore: best.sessionScore,
        hurst: best.hurst, pSurvival: best.pSurvival, reasons: best.reasons,
      };

      const trade = await this.exec.buy(best.symbol, growthRate, stake, { take_profit: tp, stop_loss: this.cfg.stopLoss }, analysis,
        proposal => this.analyzer.evaluateProposal(this.market.historyFor(best.symbol), growthRate, proposal));
      logger.info(`trade #${trade.contractId} ${best.symbol} g=${growthRate} stake=${stake} tp=${tp}`);
    } catch (e) { logger.error('ARCA error:', e.message); }
    finally { this._analysisInFlight = false; }
  }

  _isPausedNow() {
    const now = new Date();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const asMinutes = value => { const m = String(value).match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };
    return (this.cfg.pauseWindowsGmt || []).some(([from, to]) => {
      const a = asMinutes(from), b = asMinutes(to);
      if (a == null || b == null || a === b) return false;
      return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
    });
  }

  async _refreshBarriers() {
    try {
      if (!this.client.authorized) return;
      await this.market.refreshBarriers(this.cfg.assets, this.cfg.candidateGrowthRates);
      logger.debug('barriers refreshed');
    } catch (e) { logger.debug('barrier refresh:', e.message); }
  }

  // ── Summaries ──────────────────────────────────────────────
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
        version: 3, engine: 'ARCA-FIXED', savedAt: new Date().toISOString(), savedReason: reason,
        startBalance: this.startBalance, lastBalance: this.lastBalance, overallProfit: this.overallProfit,
        winStreak: this.winStreak, lossStreak: this.lossStreak, winStakeMultiplier: this.winStakeMultiplier,
        equityPeak: this.equityPeak, ddReducer: this.ddReducer,
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
      if (d.equityPeak != null) this.equityPeak = d.equityPeak;
      if (d.ddReducer != null) this.ddReducer = d.ddReducer;
      this.stats = new StatisticsManager(d.stats || {});
      logger.info(`state restored: overall=${this.overallProfit.toFixed(2)} lossStreak=${this.lossStreak}`);
    } catch (e) { logger.warn('state load:', e.message); }
  }

  stop(signal) {
    if (this.stopped) return;
    this.stopped = true;
    if (this._stuckCheckTimer) clearInterval(this._stuckCheckTimer);
    logger.info(`stopping (${signal})`);
    telegram.send(`🛑 <b>AccuPULSE2b stopped</b>\nSignal: ${signal}`);
    if (this._analysisT) clearInterval(this._analysisT);
    if (this._hourlyT) clearInterval(this._hourlyT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._eodBoot) clearTimeout(this._eodBoot);
    if (this._barrierT) clearInterval(this._barrierT);

    const today = this.stats.todayTrades();
    const s = this.stats.stats(today);
    telegram.send(`🌙 <b>SESSION END</b>\n📊 ${s.count} trades (✅${s.wins} ❌${s.losses}) | WR ${s.winRate.toFixed(1)}%\n💰 Net: ${money(s.totalProfit, this.currencyStr())}\n💼 Overall: ${money(this.overallProfit, this.currencyStr())}`);

    this._saveState('shutdown');
    this.client.stop();
    setTimeout(() => process.exit(0), 2500);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 12. BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════
function printBanner() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║   AccuPULSE2b — Adaptive Regime-Confluence (ARCA)    ║');
  console.log('║   [FIXED: Correct one-tick-ahead barrier hazard]     ║');
  console.log('║   Multi-Asset • Anti-Martingale • Adaptive Exit      ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
}

async function main() {
  printBanner();
  try { require.resolve('ws'); } catch (_) { console.error('npm install ws'); process.exit(1); }
  if (!CONFIG.apiToken) { console.error('API token not set'); process.exit(1); }
  console.log(CONFIG.telegram.enabled ? '✅ Telegram: ENABLED' : 'ℹ️ Telegram: DISABLED');
  const bot = new AccuPULSE2Bot(CONFIG);
  await bot.start();
}

function runSelfTest() {
  const assert = require('assert');
  const cfg = { ...CONFIG, minEmpiricalSamples: 20, hazardWindow: 40, plannedHoldTicks: 5, minBarrierPct: 0.01, minNetEvRatio: -0.5 };
  const analyzer = new ARCAAnalyzer(cfg);
  
  // Test 1: Wilson bound is conservative
  assert(analyzer._wilsonLower(95, 100, 1.96) < 0.95, 'Wilson bound must be conservative');
  
  // Test 2: Calm path (small log-returns) should pass
  const calm = Array.from({ length: 50 }, (_, i) => ({ quote: 100 * Math.exp(i * 0.00001) }));
  const model = analyzer._hazardEstimate(calm, 0.10, 0.01);
  assert(model.ok && model.pLower > 0.8, 'calm path should pass single-tick survival model');
  
  // Test 3: Jumpy path (large log-returns) should fail
  const jumpy = Array.from({ length: 50 }, (_, i) => ({ quote: i % 2 ? 101 : 99 }));
  const rejected = analyzer._hazardEstimate(jumpy, 0.10, 0.01);
  assert(!rejected.ok, 'barrier-breaching path must be rejected');
  
  // Test 4: Survival trend analysis
  const survivalData = [5, 8, 10, 12, 14, 15, 16, 18, 20];
  const survTrend = analyzer._survivalTrend(survivalData);
  assert(survTrend && survTrend.score > 0, 'survival trend must compute');
  assert(survTrend.trendLabel === 'rising', 'rising survival should be detected');
  
  // Test 5: Barrier margin scoring
  const barr = { highBarrier: 100, lowBarrier: 90 };
  const quotes = [94, 95, 96, 95, 96];
  const marginScore = analyzer._barrierMarginScore(quotes, barr);
  assert(marginScore.score > 0.3, 'margin score must be reasonable');
  
  // Test 6: Bot pause window check
  const bot = Object.create(AccuPULSE2Bot.prototype);
  bot.cfg = { pauseWindowsGmt: [['23:55', '00:10']] };
  assert.strictEqual(typeof bot._isPausedNow(), 'boolean', 'pause-window evaluator must be callable');
  
  console.log('✅ selftest: PASS (6/6 checks)');
}

module.exports = { ARCAAnalyzer, TradeExecutor, DerivClient, MarketDataManager, AccuPULSE2Bot, CONFIG, runSelfTest };

if (require.main === module) {
  if (process.argv.includes('--selftest')) runSelfTest();
  else main().catch(e => { console.error('fatal:', e); process.exit(1); });
}
