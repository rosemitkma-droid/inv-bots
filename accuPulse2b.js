#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  AccuPULSE2b — Adaptive Regime-Confluence Accumulator (ARCA)
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
// 2. CONFIGURATION  (credentials retained from reference bots)
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
  growthRate      : parseFloat('0.05'),    // 5% base growth rate
  stopLoss        : parseFloat('100.0'),   // hard $ stop per contract
  takeProfit      : parseFloat('5000.0'),   // session take-profit

  // ── Anti-Martingale (win-streak compounding) ──
  winsBeforeScaling     : parseInt('3'),
  winStakeMultiplier    : parseFloat('1.5'),
  maxWinStakeMultiplier : parseFloat('4.0'),

  // ── Assets ──
  // assets: ('R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V,BOOM50,BOOM150N,BOOM300N,BOOM500,BOOM600,BOOM900,BOOM1000,CRASH50,CRASH150N,CRASH300N,CRASH500,CRASH600,CRASH900,CRASH1000')
  //   .split(',').map(s => s.trim()).filter(Boolean),

  assets: ('R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V,BOOM500,BOOM600,BOOM900,BOOM1000,CRASH500,CRASH600,CRASH900,CRASH1000')
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

  // ── ARCA gates ──
  minConfidence       : parseFloat('0.60'), //0.072
  maxVolRegime        : parseInt('1', 10),     // 0=low,1=normal OK
  maxHurst            : parseFloat('0.60'),
  minSurvivalSlope    : parseFloat('-0.01'),    // allow slight negative
  minSurvivalConsist  : parseFloat('0.20'),

  // ── ARCA weights (sum ≈ 1.0) ──
  weights: {
    volRegime  : parseFloat('0.25'),
    trendAlign : parseFloat('0.20'),
    survival   : parseFloat('0.25'),
    barrier    : parseFloat('0.15'),
    session    : parseFloat('0.15'),
  },

  // ── Exit strategy ──
  earlyExitDriftFrac   : parseFloat('0.55'),   // sell if drift > 55% of barrier
  profitLockFrac       : parseFloat('0.50'),   // bank if profit > 50% best expected

  // ── Graduated drawdown ──
  ddFullStake    : parseFloat('0.05'),
  ddReduce25     : parseFloat('0.10'),
  ddReduce50     : parseFloat('0.15'),
  ddStopTrading  : parseFloat('0.20'),

  // ── Streak circuit breakers ──
  streakReduceStake  : parseInt('3'),
  streakPauseMinutes : parseInt('10'),
  streakStopDay      : parseInt('7'),

  // ── Daily limits ──
  dailyMaxLoss   : parseFloat('110'),
  dailyMaxTrades : parseInt('2000000000'),

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
  logFile : 'accuPULSE2b_01.log',
  logLevel: 'INFO',

  // ── State persistence ──
  stateFile           : 'accuPULSE2b_state_01.json',
  stateSaveOnTrade    : true,
  stateSaveOnShutdown : true,

  // ── EOD scheduling (GMT) ──
  eodTimeGmt          : '00:00',
  eodSendDelaySeconds : parseInt('10', 10),
  hourlySummary       : true,
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
    this._drain();
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ═══════════════════════════════════════════════════════════════════════
// 5. DERIV REST CLIENT  (PAT/OAuth)
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
// 8. ARCA ANALYZER  (Novel Strategy Engine)
// ═══════════════════════════════════════════════════════════════════════
class ARCAAnalyzer {
  constructor(cfg) { this.cfg = cfg; this.w = cfg.weights; }

  // ── MAIN ENTRY ──────────────────────────────────────────────
  analyze(symbol, ticks, stays) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;
    const quotes = ticks.map(t => t.quote);
    const n = quotes.length;

    const vol = this._volatilityRegime(quotes);
    const trend = this._trendAlignment(quotes);
    const surv = stays ? this._survivalTrend(stays.ticks_stayed_in) : null;
    const session = this._sessionScore();

    const volScore = vol ? vol.score : 0.5;
    const trendScore = trend ? trend.composite : 0.5;
    const survScore = surv ? surv.score : 0.5;
    const barrScore = 0.6;  // default: assume OK at entry

    const composite =
      this.w.volRegime  * volScore +
      this.w.trendAlign * trendScore +
      this.w.survival   * survScore +
      this.w.barrier    * barrScore +
      this.w.session    * session;

    const suggestedGrowth = vol
      ? (vol.regime === 0 ? 0.05 : vol.regime === 1 ? 0.03 : 0.01)
      : this.cfg.growthRate;

    const reasons = [];
    if (vol) reasons.push(`vol:${vol.regimeLabel}`);
    if (trend) reasons.push(`trend:${trend.direction}`);
    if (surv) reasons.push(`surv:${surv.trendLabel}`);
    reasons.push(`sess:${session.toFixed(2)}`);

    return {
      symbol, score: composite,
      volRegime: vol?.regime ?? 1, volRegimeLabel: vol?.regimeLabel ?? 'normal', volScore,
      trendDirection: trend?.direction ?? 'neutral', trendScore, rsi: trend?.rsi ?? 50,
      survivalScore: survScore, survivalMean: surv?.mean ?? 0, survivalSlope: surv?.slope ?? 0,
      survivalConsistency: surv?.consistency ?? 0, pSurvival: surv?.pSurvival ?? 0.5,
      sessionScore: session, suggestedGrowth,
      hurst: vol?.hurst ?? 0.5, reasons,
    };
  }

  rank(analyses) { return analyses.filter(Boolean).sort((a, b) => b.score - a.score); }

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

  // ── 3. SURVIVAL TREND ──────────────────────────────────────
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
    const score = 0.40 * trendScore + 0.30 * (aboveMedian) + 0.30 * consistScore;
    let trendLabel = 'flat';
    if (trendNorm > 0.02) trendLabel = 'rising';
    else if (trendNorm < -0.02) trendLabel = 'falling';
    return { mean, median, slope, trendNorm, consistency, pSurvival, score, trendLabel };
  }

  // ── 4. SESSION TIMING ───────────────────────────────────────
  _sessionScore() {
    const hour = new Date().getUTCHours();
    const w = { 0:.55,1:.60,2:.60,3:.65,4:.65,5:.60,6:.55,7:.50,8:.45,9:.45,10:.50,11:.55,12:.60,13:.65,14:.70,15:.75,16:.70,17:.65,18:.55,19:.50,20:.50,21:.55,22:.55,23:.55 };
    return w[hour] ?? 0.5;
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
  }

  async buy(symbol, growthRate, stake, limit, analysis = null) {
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
  }

  _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    const cid = c.contract_id ?? info.contractId;
    const profit = parseFloat(c.profit ?? 0);
    const spot = parseFloat(c.current_spot ?? 0);

    // Manual stop-loss check (Deriv ACCU doesn't support stop_loss param)
    const stopLossAbs = Math.abs(info.limit?.stop_loss || 0);
    if ((c.status === 'open') && stopLossAbs > 0 && profit <= -stopLossAbs && !this._selling.has(cid)) {
      logger.warn(`SL hit #${cid} profit=${profit.toFixed(2)}`);
      this._selling.add(cid);
      this.sell(cid, 0).catch(e => logger.error(`SL sell failed:`, e.message)).finally(() => this._selling.delete(cid));
    }

    // Early exit: barrier drift danger
    if (info.halfBarrierPct > 0 && spot > 0 && info._entrySpot > 0) {
      const driftFrac = Math.abs(spot - info._entrySpot) / info._entrySpot / (info.halfBarrierPct / 100);
      if (driftFrac > this.cfg.earlyExitDriftFrac && !this._selling.has(cid)) {
        logger.info(`drift exit #${cid}: ${(driftFrac * 100).toFixed(1)}% of barrier`);
        this._selling.add(cid);
        this.sell(cid, 0).catch(() => {}).finally(() => this._selling.delete(cid));
      }
    }

    if (c.status === 'won' || c.status === 'lost') {
      const finished = { ...info, contractId: cid, profit, status: c.status, sellPrice: parseFloat(c.sell_price ?? 0), sellTime: c.sell_time ?? (Date.now() / 1000), currentSpot: spot };
      this.open.delete(cid);
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
    this._tradeWatchdogTimer = null;

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
    logger.info('  AccuPULSE2b — ARCA Strategy');
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
    this.startBalance = this.balance ?? this.client.balance;
    this.lastBalance = this.startBalance;
    this.equityPeak = this.startBalance;

    telegram.send(
      `🤖 <b>AccuPULSE2b Online</b>\n\n` +
      `👤 <b>Account:</b> ${info.loginid}\n` +
      `💼 <b>Type:</b> ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 <b>Balance:</b> ${this.startBalance.toFixed(2)} ${this.currencyStr()}\n` +
      `📊 <b>Assets:</b> ${this.cfg.assets.join(', ')}\n` +
      `💵 <b>Stake:</b> ${this.cfg.stake}\n` +
      `📈 <b>Growth:</b> ${(this.cfg.growthRate * 100).toFixed(0)}%\n\n` +
      `🧠 <b>ARCA Strategy Active</b>\n` +
      `• Volatility regime gate\n• Trend alignment (EMA/RSI/MACD)\n` +
      `• Survival trend (ticks_stayed_in)\n• Session timing\n` +
      `• Anti-martingale + graduated drawdown\n` +
      `• Live adaptive early-exit`,
    );

    await Promise.all([
      this.market.loadSymbols(),
      this.market.bootstrap(this.cfg.assets),
      this._refreshBarriers(),
    ]);

    if (this._analysisT) clearInterval(this._analysisT);
    this._analyzeAndTrade();
    this._analysisT = setInterval(() => this._analyzeAndTrade(), this.cfg.analysisIntervalMs);
    if (this._barrierT) clearInterval(this._barrierT);
    this._barrierT = setInterval(() => this._refreshBarriers(), this.cfg.barrierRefreshMs);
  }

  _onDisconnected(code, reason, wasAuth) {
    this._clearWatchdog();
    telegram.send(`⚠️ <b>Connection lost</b>\ncode: <code>${code}</code>\nwas auth: ${wasAuth ? 'yes' : 'no'}\n🔄 reconnecting…`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    if (this.exec) this.exec.open.clear();
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
      msg += `\n🧠 <b>ARCA</b>\n` +
        `• Score: <b>${a.score.toFixed(3)}</b> / ${this.cfg.minConfidence}\n` +
        `• Vol: ${a.volRegimeLabel} (${a.volScore.toFixed(2)})\n` +
        `• Trend: ${a.trendDirection} (${a.trendScore.toFixed(2)}) RSI:${a.rsi.toFixed(1)}\n` +
        `• Survival: ${a.survivalMean.toFixed(1)} ticks (${a.survivalScore.toFixed(2)})\n` +
        `• Hurst: ${a.hurst.toFixed(2)} P(surv): ${(a.pSurvival * 100).toFixed(1)}%\n` +
        `• ${a.reasons.join(' | ')}`;
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

    // Update equity peak
    if (this.lastBalance > this.equityPeak) this.equityPeak = this.lastBalance;

    // Anti-Martingale state
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

    // Circuit breakers
    if (this._checkCircuitBreakers()) {
      this.stopped = true;
      telegram.send(`🛑 <b>Bot stopped</b> — circuit breaker`);
    }
    this._saveState('after-trade');
  }

  // ── Stake sizing (anti-martingale + graduated DD) ───────────
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
    if (pl <= -this.cfg.dailyMaxLoss) { telegram.send(`🛑 Daily loss limit: ${pl.toFixed(2)}`); return true; }
    if (today.length >= this.cfg.dailyMaxTrades) { telegram.send(`🛑 Daily trade limit`); return true; }
    const dd = this.equityPeak > 0 ? (this.equityPeak - (this.lastBalance ?? 0)) / this.equityPeak : 0;
    if (dd > this.cfg.ddStopTrading) { telegram.send(`🛑 DD limit: ${(dd * 100).toFixed(1)}%`); return true; }
    if (this.lossStreak >= this.cfg.streakStopDay) { telegram.send(`🛑 Loss streak limit: ${this.lossStreak}`); return true; }
    return false;
  }

  // ── Main ARCA strategy loop ─────────────────────────────────
  async _analyzeAndTrade() {
    try {
      if (this.stopped || !this.client.authorized) return;
      if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
      if (this.exec.count() >= this.cfg.maxOpenTrades) return;

      const analyses = this.cfg.assets.map(sym => {
        const ticks = this.market.historyFor(sym);
        const stays = this.market.getStays(sym, this.cfg.growthRate);
        return this.analyzer.analyze(sym, ticks, stays);
      });
      const ranked = this.analyzer.rank(analyses);
      if (!ranked.length) return;

      const best = ranked[0];
      logger.info(`best=${best.symbol} score=${best.score.toFixed(3)} vol=${best.volRegimeLabel} trend=${best.trendDirection} [${best.reasons.join(',')}]`);

      // ARCA gates
      if (best.score < this.cfg.minConfidence) { logger.debug(`score ${best.score.toFixed(3)} < min — skip`); return; }
      if (best.volRegime > this.cfg.maxVolRegime) { logger.debug(`vol regime ${best.volRegime} > max — skip`); return; }
      if (best.hurst > this.cfg.maxHurst) { logger.debug(`hurst ${best.hurst.toFixed(2)} > max — skip`); return; }
      if (best.survivalScore > 0 && best.survivalSlope < this.cfg.minSurvivalSlope) { logger.debug(`surv slope low — skip`); return; }
      if (best.survivalScore > 0 && best.survivalConsistency < this.cfg.minSurvivalConsist) { logger.debug(`surv consistency low — skip`); return; }

      const growthRate = best.suggestedGrowth;
      const stake = this.currentStake();
      const tp = +(stake * Math.max(0.3, Math.min(1.5, best.pSurvival * 2))).toFixed(2);

      const analysis = {
        score: best.score, volRegimeLabel: best.volRegimeLabel, volScore: best.volScore,
        trendDirection: best.trendDirection, trendScore: best.trendScore, rsi: best.rsi,
        survivalMean: best.survivalMean, survivalScore: best.survivalScore,
        hurst: best.hurst, pSurvival: best.pSurvival, reasons: best.reasons,
      };

      const trade = await this.exec.buy(best.symbol, growthRate, stake, { take_profit: tp }, analysis);
      logger.info(`trade #${trade.contractId} ${best.symbol} g=${growthRate} stake=${stake} tp=${tp}`);
    } catch (e) { logger.error('ARCA error:', e.message); }
  }

  async _refreshBarriers() {
    try {
      if (!this.client.authorized) return;
      const rates = [0.01, 0.02, 0.03, 0.04, 0.05];
      await this.market.refreshBarriers(this.cfg.assets, rates);
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
        this.exec.sell(contractId, 0).catch(() => {});
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
        version: 2, engine: 'ARCA', savedAt: new Date().toISOString(), savedReason: reason,
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
    setTimeout(() => process.exit(0), 2500);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 12. BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════
function printBanner() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║   AccuPULSE2b — Adaptive Regime-Confluence (ARCA)   ║');
  console.log('║   Multi-Asset • Anti-Martingale • Adaptive Exit     ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');
}

async function main() {
  printBanner();
  try { require.resolve('ws'); } catch (_) { console.error('npm install ws'); process.exit(1); }
  if (!CONFIG.apiToken) { console.error('API token not set'); process.exit(1); }
  console.log(CONFIG.telegram.enabled ? '✅ Telegram: ENABLED' : 'ℹ️ Telegram: DISABLED');
  const bot = new AccuPULSE2Bot(CONFIG);
  await bot.start();
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
