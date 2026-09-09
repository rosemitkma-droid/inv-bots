#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  accuHOLD — memoryless BOOM/CRASH ACCU bot (v1)
 * =====================================================================
 *
 *  Single-file Deriv Accumulator (ACCU) trading bot — TEST/DEMO ONLY.
 *  Boilerplate (DerivClient, MarketDataManager, TradeExecutor, Telegram,
 *  persistence, pause/DOW, reconcile, watchdog) is ported from
 *  accuAPEX.js; the strategy itself is intentionally NOT timing-based.
 *
 *  ─ HONESTY (load-bearing — read before changing the strategy) ─────
 *  Rigorous statistical testing of BOOM/CRASH spike timing (chi-square
 *  goodness-of-fit and Kolmogorov–Smirnov tests against a shifted
 *  geometric distribution, plus hazard-rate tables) found NO evidence
 *  of non-memoryless structure. p-values 0.28–0.77 on both symbols; CV
 *  matched the theoretical memoryless value. An earlier "hit" was two
 *  bugs in the analysis script — once fixed, the effect vanished.
 *
 *  ⇒ "Ticks since the last spike" tells you nothing about when the
 *    next one is coming. There is no timing signal to trade on.
 *
 *  What IS true and useful:
 *    • ≥2% growth → ~100% of detected spikes breach the barrier.
 *    • 1% growth (widest available) → ~80% of spikes still breach it.
 *    • `ticks_stayed_in` (Deriv's reported survival durations) tracks
 *      measured mean spike intervals at low growth rates — so spikes,
 *      not ordinary noise, are what usually ends a low-growth-rate
 *      ACCU contract.
 *    • ⇒ growth rate is a dial on how much ordinary-noise risk you
 *      accept in exchange for how long you're exposed to the next
 *      (unpredictable) spike — NOT a timing lever.
 *
 *  ─ STRATEGY (this build) ─────────────────────────────────────────
 *  No timing/hazard/pattern entry. Rate-limited entries on BOOM/CRASH
 *  with a per-symbol cooldown and a max-concurrent cap. On buy, two
 *  exits armed on every `proposal_open_contract` tick:
 *    1. Take-profit: current payout reaches `takeProfitMultiple` × stake.
 *    2. Tick cap:    ticks held ≥ `tickCapFraction` × median of the
 *                     LIVE-FETCHED `ticks_stayed_in` for that trade's
 *                     (symbol, growth_rate) bucket. Median, not mean
 *                     (right-skewed survival distribution).
 *  Martingale (optional): base stake × (multiplier ^ step).
 *    • On LOSS: step +=1, next stake = base × multiplier^step (capped by martingaleSteps).
 *    • On WIN:  step =0, next stake = base.
 *    • If max steps hit and another loss occurs → reset to base (cycle).
 *    • Disabled when martingaleMultiplier ≤1 or martingaleSteps =0.
 *  If neither exit fires and the contract is knocked out, it's a loss —
 *  logged plainly, never dressed up as a "signal failure".
 *
 *  ─ RISK CONTROLS ─────────────────────────────────────────────────
 *  Martingale-aware stake, per-symbol cooldown, max consecutive losses (pause +
 *  require manual restart), small daily loss cap, max concurrent open
 *  trades. Loss histogram tracks max streak + x2-x7 events. Telegram
 *  (queue-bounded) reports each open/close with martingale & streak
 *  info, every risk-control pause, and EOD / hourly summaries.
 *
 *  ─ DO NOT ADD ────────────────────────────────────────────────────
 *  Hazard, timing, or pattern-based entry logic — even if it looks
 *  like a reasonable addition. The absence of a signal was established
 *  by testing, not assumed.
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
// 1. .ENV LOADER  (credentials stay hardcoded in CONFIG; .env is opt-in)
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
// 2. CONFIGURATION  (hardcoded TEST credentials retained per user pattern)
// ═══════════════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
  // ── Deriv API ──
  apiToken   : 'pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee',
  appId      : '33uslPtthXBEkQOdfKfoY',
  wsUrl      : 'wss://ws.derivws.com/websockets/v3',
  currency   : 'USD',
  accountType: 'demo',   // 'demo' | 'real' — keep demo for testing

  // ── Trade parameters (memoryless, non-signal) ──
  stake              : parseFloat('1.00'),   // base stake per trade (reset value for martingale)
  takeProfitMultiple : parseFloat('1.50'),   // sell when payout ≥ stake × this
  tickCapFraction    : parseFloat('1.20'),   //0.55 tick-cap = frac × live ticks_stayed_in median
  growthRate         : parseFloat('0.01'),   // one of {0.01, 0.02, 0.03, 0.04, 0.05}

  // ── Martingale ──────────────────────────────────────────────────
  // On every loss: next stake = base stake × (multiplier ^ step).
  // On win: reset to base stake (step = 0).
  // User-configurable multiplier and max steps.
  // Set steps = 0 or multiplier <= 1.0 to disable martingale (flat stake).
  martingaleMultiplier : parseFloat('2.10'), // e.g. 2.10 means stake ×2.10 after each loss
  martingaleSteps      : parseInt('8', 10),  // max consecutive martingale multiplications (0 = disabled)

  // ── Rate-limited entry ──
  perSymbolCooldownMs : parseInt('8000',  10),   // between trades on the same symbol
  perSymbolEntryGapMs : parseInt('30000', 10),   // min gap between any two new entries (global)
  maxOpenTrades       : parseInt('1',     10),   // concurrent open contracts across the bot

  // ── Risk controls ──
  maxConsecutiveLosses : parseInt('8', 10),      // pause + require manual restart
  dailyMaxLoss        : parseFloat('150'),         // demo-appropriate cap
  dailyMaxTrades      : parseInt('120000', 10),      // daily cap
  stopLossPerContract : parseFloat('0'),         // 0 = disabled (rely on knockout)

  // ── Instruments (BOOM + CRASH families, run both) ──
  assets: ('BOOM500,BOOM600,BOOM900,BOOM1000,CRASH500,CRASH600,CRASH900,CRASH1000')
    .split(',').map(s => s.trim()).filter(Boolean),

  // ── Telegram (existing hardcoded values) ──
  telegram: {
    enabled : true,
    botToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    chatId  : '752497117',
    maxQueue: parseInt('200', 10),
  },

  // ── Reconnect ──
  reconnect: { initialDelayMs: 1000, maxDelayMs: 60000, backoffFactor: 2, jitterMs: 750 },

  // ── Open-contract stream watchdog ──
  tradeWatchdogMs  : parseInt('90000', 10),
  proposalRefreshMs: parseInt('60000', 10),   // refresh barrier + ticks_stayed_in cache

  // ── Scheduled pause/resume (GMT) ──
  pauseEnabled : false,
  pauseStartGmt: '23:00',
  pauseEndGmt  : '1:00',

  // ── Day-of-week filter (GMT) ──
  tradeSunday: true, tradeMonday: true, tradeTuesday: true,
  tradeWednesday: true, tradeThursday: true, tradeFriday: true, tradeSaturday: true,

  // ── EOD / hourly summaries (GMT) ──
  eodTimeGmt         : '00:00',
  eodSendDelaySeconds: parseInt('10', 10),
  hourlySummary      : true,

  // ── Logging / state ──
  logFile           : 'accuHOLD2_01.log',
  logLevel          : 'INFO',
  stateFile         : 'accuHOLD2_state_01.json',
  stateSaveOnTrade  : true,
  stateSaveOnShutdown: true,
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
// 4. TELEGRAM NOTIFIER  (bounded queue, serial drain)
// ═══════════════════════════════════════════════════════════════════════
class TelegramNotifier extends EventEmitter {
  constructor(cfg) {
    super();
    this.enabled = cfg.enabled;
    this.botToken = cfg.botToken;
    this.chatId = cfg.chatId;
    this.maxQueue = cfg.maxQueue || 200;
    this.queue = [];
    this.dropped = 0;
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
    try {
      while (this.queue.length) {
        await this._post(this.queue.shift());
        await new Promise(r => setTimeout(r, 1100));
      }
      if (this.dropped > 0) { logger.warn(`telegram: dropped ${this.dropped} queued messages (overflow)`); this.dropped = 0; }
    } finally { this.sending = false; }
  }
  send(text) {
    if (!this.enabled) { logger.debug('tg(dry):', text.slice(0, 100)); return; }
    if (this.queue.length >= this.maxQueue) { this.queue.shift(); this.dropped++; }
    this.queue.push(text);
    this._drain();
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ═══════════════════════════════════════════════════════════════════════
// 5. DERIV REST CLIENT  (PAT/OAuth)  — ported from accuAPEX
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
// 6. DERIV WEBSOCKET CLIENT  (reconnect, PAT/OAuth, subs, portfolio)
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
    this._keepAliveSubId = null;
    this._keepAliveTimer = null;
  }

  _nextReqId() { return ++this._reqId; }

  _url() {
    const sep = this.cfg.wsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.wsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }

  _redact(url) { return url.replace(/([?&])(otp|app_id|token)=[^&]+/g, '$1$2=***').replace(/wss:\/\/[^/]+/, m => m); }

  _openWs(url) {
    try {
      this.ws = new WebSocket(url, { headers: { 'User-Agent': 'accuHOLD/1.0 (+Node.js)' }, handshakeTimeout: 15000 });
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

  // The new-API (OTP) WebSocket drops idle connections after ~60s if there
  // is no active subscription. With no contract open yet, the bot has no
  // proposal_open_contract stream, so we keep ONE ticks subscription alive
  // for the lifetime of the socket and refresh it on every (re)connect.
  async _startKeepAlive() {
    if (this._keepAliveSubId) return;
    const assets = (this.cfg && Array.isArray(this.cfg.assets) && this.cfg.assets.length) ? this.cfg.assets : ['BOOM1000'];
    const symbol = assets[0];
    try {
      const subId = await this.subscribe({ ticks: symbol }, () => { /* noop — just keeps the socket warm */ });
      this._keepAliveSubId = subId;
      logger.info(`keep-alive: subscribed ticks:${symbol} (subId=${subId})`);
    } catch (e) {
      logger.warn(`keep-alive subscribe failed (${symbol}):`, e.message);
    }
  }
  _stopKeepAlive() {
    if (this._keepAliveSubId) { try { this.forget(this._keepAliveSubId); } catch (_) {} this._keepAliveSubId = null; }
    if (this._keepAliveTimer) { clearInterval(this._keepAliveTimer); this._keepAliveTimer = null; }
  }
  // Belt-and-braces ping: if we ever lose the keep-alive sub for any
  // reason, an app-level ping every 25s prevents the OTP socket from
  // sitting idle for the full 60s timeout window.
  _startPing() {
    this._stopPing();
    this._keepAliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.ping(); } catch (_) {}
      }
    }, 25000);
  }
  _stopPing() { if (this._keepAliveTimer) { clearInterval(this._keepAliveTimer); this._keepAliveTimer = null; } }

  _newApiMarkAuthorized() {
    if (!this.accountInfo) return;
    this.authorized = true;
    this.balance = this.accountInfo.balance ?? null;
    this.currency = this.accountInfo.currency || this.cfg.currency;
    logger.info(`authorized ${this.accountInfo.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) bal=${this.balance}`);
    this._startPing();
    this._startKeepAlive().catch(e => logger.debug('keep-alive start:', e.message));
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
      this._startPing();
      this._startKeepAlive().catch(e => logger.debug('keep-alive start:', e.message));
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
    this._stopKeepAlive();
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

  async portfolio() {
    const res = await this._send({ portfolio: 1 }, 15000);
    return Array.isArray(res.portfolio?.contracts) ? res.portfolio.contracts : [];
  }

  stop() { this._stopped = true; this._stopKeepAlive(); try { this.ws?.close(); } catch (_) {} }
}

// ═══════════════════════════════════════════════════════════════════════
// 7. MARKET DATA — barrier + ticks_stayed_in cache
//    (no analyzer; we only need the live median for the tick-cap)
// ═══════════════════════════════════════════════════════════════════════
class MarketDataManager extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.stayCache = new Map();      // symbol -> Map(growthRate -> { ticks_stayed_in, ts, barrier })
    this._unsupportedSymbols = new Set();
    this._refreshInFlight = false;
    client.on('close', () => { this.stayCache.clear(); });
  }

  cacheStays(symbol, growthRate, cd) {
    if (!cd) return;
    const arr = cd.ticks_stayed_in;
    if (!Array.isArray(arr) || !arr.length) return;
    const key = +(+growthRate).toFixed(4);
    if (!this.stayCache.has(symbol)) this.stayCache.set(symbol, new Map());
    this.stayCache.get(symbol).set(key, { ticks_stayed_in: arr.slice(), ts: Date.now(), barrier: +cd.tick_size_barrier_percentage || 0 });
  }

  getStays(symbol, growthRate) {
    const sub = this.stayCache.get(symbol);
    return sub ? sub.get(+(+growthRate).toFixed(4)) || null : null;
  }

  // Live median of ticks_stayed_in for the (symbol, growth_rate) bucket,
  // or null if we don't have a sample yet. Median (not mean) — the
  // survival distribution is right-skewed and the mean is pulled up by
  // a few long-surviving contracts.
  getMedianStay(symbol, growthRate) {
    const rec = this.getStays(symbol, growthRate);
    if (!rec || !rec.ticks_stayed_in.length) return null;
    const arr = rec.ticks_stayed_in.slice().sort((a, b) => a - b);
    const m = arr.length >> 1;
    return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
  }

  static PERMANENT_ERRORS = new Set([
    'TradingDurationNotAllowed', 'InvalidContractType', 'InvalidSymbol',
    'UnsupportedContract', 'InvalidContract', 'BlockedCurrency',
  ]);

  async refreshStays(assets, growthRate) {
    if (this._refreshInFlight || !this.client.authorized) return;
    this._refreshInFlight = true;
    const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      for (const sym of assets) {
        if (this._unsupportedSymbols.has(sym)) continue;
        try {
          const res = await this.client._send({
            proposal: 1, amount: this.cfg.stake, basis: 'stake',
            contract_type: 'ACCU', currency: this.cfg.currency,
            [symbolKey]: sym, growth_rate: growthRate,
          }, 8000);
          const cd = res?.proposal?.contract_details;
          if (cd) {
            this.cacheStays(sym, growthRate, cd);
          } else if (res?.error) {
            const code = res.error.code || '';
            const msg  = res.error.message || '';
            if (MarketDataManager.PERMANENT_ERRORS.has(code) || /not offered|does not offer|not available|not supported/i.test(msg)) {
              this._unsupportedSymbols.add(sym);
              logger.info(`refreshStays: ${sym} ACCU rejected (${code || msg}) — excluded`);
            } else {
              logger.debug(`refreshStays(${sym}) transient: ${code || msg}`);
            }
          }
        } catch (e) { logger.debug(`refreshStays(${sym}):`, e.message); }
        await sleep(50);
      }
    } finally { this._refreshInFlight = false; }
  }

  stop() { this.stayCache.clear(); }
}

// ═══════════════════════════════════════════════════════════════════════
// 8. TRADE EXECUTOR  (buy, stream update, idempotent settle, reconcile)
// ═══════════════════════════════════════════════════════════════════════
const TERMINAL_STATUSES = new Set(['won', 'lost', 'sold', 'cancelled', 'expired', 'refunded']);

class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.open = new Map();           // contractId -> info  (survives reconnects)
    this._selling = new Set();
    this._subscriptions = new Map(); // contractId -> subId
    this._settledIds = new Set();    // idempotency
  }

  // ── Entry ─────────────────────────────────────────────────────────
  async buy(symbol, growthRate, stake, ctx) {
    growthRate = Math.max(0.01, Math.min(0.05, +growthRate.toFixed(4)));
    try {
      const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
      const pres = await this.client._send({
        proposal: 1, amount: stake, basis: 'stake', contract_type: 'ACCU',
        currency: this.cfg.currency, [symbolKey]: symbol, growth_rate: growthRate,
      }, 20000);
      const p = pres.proposal;
      if (!p?.id) throw new Error('No proposal id returned');
      logger.info(`proposal id=${p.id} ask=${p.ask_price} payout=${p.payout} spot=${p.spot}`);

      const bres = await this.client._send({ buy: p.id, price: p.ask_price }, 20000);
      const b = bres.buy;
      if (!b?.contract_id) throw new Error('Buy did not return contract_id');
      logger.info(`bought ACCU #${b.contract_id} for ${b.buy_price}`);

      const cd = p.contract_details || {};
      const entrySpot = parseFloat(p.spot ?? cd.current_spot ?? 0);

      // Live-fetch the ticks_stayed_in for THIS trade's exact (symbol, growth_rate)
      // bucket. This is what was actually known at entry time — never used a
      // pre-computed global or synthesized number.
      const liveStays = Array.isArray(cd.ticks_stayed_in) ? cd.ticks_stayed_in : null;
      const liveMedian = liveStays && liveStays.length
        ? (() => { const s = liveStays.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; })()
        : null;
      const liveCap = liveMedian ? Math.max(1, Math.floor(liveMedian * this.cfg.tickCapFraction)) : null;

      const info = {
        contractId: b.contract_id, symbol, growthRate, stake,
        buyPrice: parseFloat(b.buy_price),
        buyTime: b.purchase_time || (Date.now() / 1000),
        takeProfitMultiple: this.cfg.takeProfitMultiple,
        tickCapFraction:    this.cfg.tickCapFraction,
        ticksStayedInMedian: liveMedian,
        tickCapTicks:       liveCap,
        contractDetails: cd,
        entrySpot,
        highBarrier: parseFloat(cd.high_barrier ?? 0), lowBarrier: parseFloat(cd.low_barrier ?? 0),
        maxPayout:  parseFloat(cd.maximum_payout ?? 0),
        proposalId: p.id,
        balanceAfter: parseFloat(b.balance_after ?? this.client.balance),
        ticksHeld: 0, peakProfit: 0, lastBid: null,
        // Tick-anchor: `c.tick_count` on the proposal_open_contract stream
        // reports the SERVER's counter from the moment of purchase, which
        // can be a huge number by the time our subscription actually
        // attaches (the first message we see is often "tick 250+"). The
        // tick-cap exit is meant to fire after WE have observed N ticks,
        // so we anchor to the first tick_count we see on the stream and
        // count up from there.
        _tickAnchor: null,
        lastUpdateAt: Date.now(),
        _exitReason: null,
      };

      // Cache live ticks_stayed_in for this (symbol, growth_rate) so
      // future trades + the hourly/EOD summaries can report the same bucket.
      if (this.bot?.market?.cacheStays) this.bot.market.cacheStays(symbol, growthRate, cd);

      this.open.set(b.contract_id, info);
      logger.info(
        `bought #${b.contract_id} ${symbol} g=${growthRate} stake=${stake} ` +
        `tick-cap=${info.tickCapTicks ?? 'n/a'} ticks (median=${info.ticksStayedInMedian ?? 'n/a'})`,
      );

      await this._attachContractStream(info);
      this.emit('open', info);
      return info;
    } catch (e) {
      logger.error(`buy(${symbol}) failed:`, e.message);
      throw e;
    }
  }

  async _attachContractStream(info) {
    if (this._subscriptions.has(info.contractId)) return;
    try {
      const subId = await this.client.subscribe(
        { proposal_open_contract: 1, contract_id: info.contractId },
        msg => this._onUpdate(msg, info),
      );
      this._subscriptions.set(info.contractId, subId);
      info._subscriptionId = subId;
    } catch (e) {
      logger.warn(`attach stream #${info.contractId}:`, e.message);
    }
  }

  // ── Reconciliation after reconnect ────────────────────────────────
  async reconcileOpenContracts() {
    const tracked = Array.from(this.open.values());
    if (!tracked.length) return;
    let list = [];
    try { list = await this.client.portfolio(); }
    catch (e) { logger.warn('reconcile portfolio:', e.message); return; }
    const serverIds = new Set(list.map(c => String(c.contract_id)));

    // 1) adopt server-side contracts we don't track (e.g. bought by a prior run)
    for (const c of list) {
      if (String(c.contract_type).toUpperCase() === 'ACCU' && !this.open.has(c.contract_id)) {
        this._adoptServerContract(c);
      }
    }
    // 2) hydrate details + re-attach streams for contracts still open
    for (const c of list) {
      const info = this.open.get(c.contract_id);
      if (!info) continue;
      try {
        const res = await this.client._send({ proposal_open_contract: 1, contract_id: c.contract_id }, 12000);
        const oc = res.proposal_open_contract;
        if (!oc) { this.forceSettle(c.contract_id, 'reconcile-missing'); continue; }
        if (oc.status === 'open') {
          this._hydrateInfo(info, oc);
          info.lastUpdateAt = Date.now();
          await this._attachContractStream(info);
        } else {
          this._onUpdate({ proposal_open_contract: oc }, info);
        }
      } catch (e) { logger.warn(`reconcile #${c.contract_id}:`, e.message); }
    }
    // 3) tracked but no longer on server → settled while offline; read once then book conservatively
    for (const info of tracked) {
      if (serverIds.has(String(info.contractId))) continue;
      if (!this.open.has(info.contractId)) continue;
      try {
        const res = await this.client._send({ proposal_open_contract: 1, contract_id: info.contractId }, 12000);
        const oc = res.proposal_open_contract;
        if (oc && oc.status !== 'open') this._onUpdate({ proposal_open_contract: oc }, info);
        else this.forceSettle(info.contractId, 'reconcile-gone');
      } catch { this.forceSettle(info.contractId, 'reconcile-gone'); }
    }
    logger.info(`reconcile: ${this.count()} open contract(s) tracked after reconnect`);
  }

  _adoptServerContract(c) {
    const cid = c.contract_id;
    const buyPrice = parseFloat(c.buy_price ?? 0);
    const info = {
      contractId: cid,
      symbol: c.symbol || c.underlying || '',
      growthRate: c.growth_rate != null ? parseFloat(c.growth_rate) : this.cfg.growthRate,
      stake: buyPrice > 0 ? buyPrice : this.cfg.stake,
      buyPrice,
      takeProfitMultiple: this.cfg.takeProfitMultiple,
      tickCapFraction:    this.cfg.tickCapFraction,
      ticksStayedInMedian: null, tickCapTicks: null,
      contractDetails: {},
      entrySpot: parseFloat(c.entry_spot ?? 0),
      highBarrier: 0, lowBarrier: 0, maxPayout: 0,
      ticksHeld: 0, peakProfit: 0, lastBid: null,
      lastUpdateAt: Date.now(), _exitReason: 'reconciled', _adopted: true,
    };
    this.open.set(cid, info);
    logger.info(`reconcile: adopted open contract #${cid} ${info.symbol}`);
    return info;
  }

  _hydrateInfo(info, oc) {
    if (oc.growth_rate != null) info.growthRate = parseFloat(oc.growth_rate);
    if (oc.symbol || oc.underlying) info.symbol = oc.symbol || oc.underlying;
    if (oc.purchase_time) info.buyTime = oc.purchase_time;
    if (oc.buy_price != null) info.buyPrice = parseFloat(oc.buy_price);
  }

  // ── Stream updates ────────────────────────────────────────────────
  _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    const cid = c.contract_id ?? info.contractId;
    const profit = parseFloat(c.profit ?? 0);
    const currentSpot = parseFloat(c.current_spot ?? 0);
    const status = c.status;

    if (status === 'open') {
      // ticksHeld: count ticks observed by OUR subscription, starting at 1
      // on the first message we see. The server's `tick_count` is anchored
      // to purchase time, so reading it raw makes the tick-cap fire on the
      // entry tick (and Deriv rejects sells at the entry tick with
      // `InvalidtoSell – Contract cannot be sold at entry tick`).
      if (c.tick_count != null && c.tick_count > 0) {
        if (info._tickAnchor == null) info._tickAnchor = c.tick_count;
        info.ticksHeld = Math.max(0, c.tick_count - info._tickAnchor) + 1;
      } else if (Array.isArray(c.ticks_stayed_in) && c.ticks_stayed_in.length) {
        // Fallback when the stream doesn't expose tick_count: use the
        // survival array length, also anchored to its first observed size.
        if (info._tickAnchor == null) info._tickAnchor = c.ticks_stayed_in.length;
        info.ticksHeld = Math.max(0, c.ticks_stayed_in.length - info._tickAnchor) + 1;
      }
      info.peakProfit = Math.max(info.peakProfit ?? 0, profit);
      info.lastUpdateAt = Date.now();
    }
    if (c.bid_price != null) info.lastBid = parseFloat(c.bid_price);

    // Stop-loss (per-contract), if configured.
    const stopLossAbs = Math.abs(this.cfg.stopLossPerContract || 0);
    if (status === 'open' && stopLossAbs > 0 && profit <= -stopLossAbs && !this._selling.has(cid)) {
      info._exitReason = 'stop-loss';
      logger.warn(`contract #${cid} hit stop-loss @ profit=${profit.toFixed(2)} ≤ -${stopLossAbs} — selling`);
      this._selling.add(cid);
      this.sell(cid, 0, info).catch(e => logger.error(`emergency sell #${cid} failed:`, e.message))
        .finally(() => this._selling.delete(cid));
      return;
    }

    if (status === 'open' && !this._selling.has(cid)) {
      // A) Take-profit: payout ≥ stake × takeProfitMultiple.
      //    Use `c.profit` (Deriv-computed: payout − buy_price), NOT
      //    `c.bid_price`. The bid_price field is the spot-multiplied-by-
      //    growth_price, which is NOT the same as the multiplier-grown
      //    payout value you receive on sell, and exits the trade after
      //    a single tick on wide-barrier symbols. `profit` is the field
      //    the server keeps aligned with `bid_price` on `sell_price`, so
      //    checking `profit ≥ stake × (multiple − 1)` is the right rule.
      const tpMult = info.takeProfitMultiple ?? this.cfg.takeProfitMultiple;
      const tpProfitFloor = +(info.stake * (tpMult - 1)).toFixed(2);
      if (tpMult > 1 && profit >= tpProfitFloor) {
        info._exitReason = `take-profit: profit ${profit.toFixed(2)} ≥ ${tpProfitFloor.toFixed(2)} (×${tpMult} of ${info.stake.toFixed(2)})`;
        logger.info(`exit #${cid}: ${info._exitReason}`);
        this._selling.add(cid);
        this.sell(cid, 0, info).catch(e => logger.error(`tp sell #${cid} failed:`, e.message))
          .finally(() => this._selling.delete(cid));
        return;
      }
      // B) Tick cap: ticks held ≥ tickCapFraction × LIVE ticks_stayed_in median.
      const cap = info.tickCapTicks;
      if (cap && info.ticksHeld >= cap) {
        info._exitReason = `tick-cap: held ${info.ticksHeld} ≥ ${cap} (${this.cfg.tickCapFraction}× live median ${info.ticksStayedInMedian})`;
        logger.info(`exit #${cid}: ${info._exitReason}`);
        this._selling.add(cid);
        this.sell(cid, 0, info).catch(e => logger.error(`tick-cap sell #${cid} failed:`, e.message))
          .finally(() => this._selling.delete(cid));
        return;
      }
      this.emit('update', { ...info, contractId: cid, profit, currentSpot, status });
      return;
    }

    if (TERMINAL_STATUSES.has(status)) {
      const soldFor = parseFloat(c.sell_price ?? 0);
      const terminalProfit = (status === 'sold' && soldFor > 0 && info.buyPrice > 0)
        ? soldFor - parseFloat(info.buyPrice)
        : profit;
      const finalStatus = status === 'sold' ? (terminalProfit >= 0 ? 'won' : 'lost') : status;
      // ticksHeld at the moment of settlement: server's tick_count is
      // anchored to purchase time and is the authoritative duration. We
      // also keep the open-time-anchored value in `_ticksHeldOpen` for
      // logging; users care about "how long did this trade run" and the
      // terminal tick_count is exactly that.
      const terminalTicks = (c.tick_count != null && c.tick_count > 0)
        ? c.tick_count
        : (info.ticksHeld ?? 0);
      this._finalizeContract(cid, {
        profit: terminalProfit, status: finalStatus, sellPrice: soldFor,
        sellTime: c.sell_time ?? (Date.now() / 1000), currentSpot,
        ticksHeld: terminalTicks,
        ticksHeldOpen: info.ticksHeld ?? 0,
        exitReason: info._exitReason ?? (status === 'lost' ? 'knockout' : status),
      });
    }
  }

  async sell(contractId, minPrice = 0, info = null) {
    try {
      let floor = Number(minPrice) || 0;
      if (info && info.lastBid && info.lastBid > 0 && floor === 0) {
        floor = +(info.lastBid * 0.95).toFixed(2);
      }
      let sold;
      try {
        const res = await this.client._send({ sell: contractId, price: floor }, 15000);
        sold = res.sell || {};
      } catch (e) {
        if (minPrice !== 0 || !/price/i.test(e.message || '')) throw e;
        logger.warn(`sell fallback (price:0) #${contractId}: ${e.message}`);
        const res = await this.client._send({ sell: contractId, price: 0 }, 15000);
        sold = res.sell || {};
      }
      const soldFor = parseFloat(sold.sold_for ?? sold.sell_price ?? 0);
      logger.info(`sold #${contractId} for ${soldFor} (floor=${floor})`);
      // Free the slot immediately (do not wait for the 'sold' stream message).
      this._finalizeContract(contractId, {
        profit: soldFor > 0 && info?.buyPrice > 0 ? soldFor - info.buyPrice : 0,
        status: soldFor > 0 && info?.buyPrice > 0 && soldFor >= info.buyPrice ? 'won' : 'lost',
        sellPrice: soldFor, sellTime: Date.now() / 1000,
        currentSpot: info?.entrySpot ?? 0,
        ticksHeld: info?.ticksHeld ?? 0,
        exitReason: info?._exitReason ?? 'manual-sell',
      });
      return sold;
    } catch (e) {
      // "not found among your open positions" = already closed server-side.
      // Free the local slot so the watchdog doesn't keep retrying forever.
      const msg = String(e.message || e);
      if (/not found among your open positions/i.test(msg) && this.open.has(contractId)) {
        logger.warn(`sell #${contractId} missed: already closed on server — dropping stale local entry`);
        this._finalizeContract(contractId, {
          profit: 0, status: 'unknown', sellPrice: 0,
          sellTime: Date.now() / 1000, currentSpot: info?.entrySpot ?? 0,
          exitReason: 'already-closed-on-server',
        });
        return null;
      }
      // Deriv rejects sells on the entry tick (the very first message after
      // buy). If the caller's exit was tick-cap / take-profit, the next
      // stream tick will re-trigger the same exit; if it was a manual or
      // emergency sell, rethrow so the caller knows.
      if (/cannot be sold at entry tick/i.test(msg)) {
        logger.info(`sell #${contractId} deferred (entry-tick) — will retry on next stream tick`);
        // Caller is the one-and-done exit path; let the next _onUpdate re-fire
        // the exit logic. The _selling guard prevents a thundering herd.
        return null;
      }
      logger.error(`sell(${contractId}) failed:`, e.message);
      throw e;
    }
  }

  // ── Idempotent settlement (single `result` per contract id) ─────────
  _finalizeContract(cid, fields) {
    if (this._settledIds.has(cid)) return null;
    const info = this.open.get(cid);
    if (!info) return null;
    this._settledIds.add(cid);
    const finished = { ...info, contractId: cid, ...fields };
    this.open.delete(cid);
    const subId = this._subscriptions.get(cid);
    if (subId) { this._subscriptions.delete(cid); this.client.forget(subId).catch(() => {}); }
    logger.info(`settled #${cid} status=${finished.status} profit=${finished.profit.toFixed(2)} [${finished.exitReason || 'unknown'}]`);
    this.emit('result', finished);
    return finished;
  }

  forceSettle(contractId, reason = 'force') {
    const info = this.open.get(contractId);
    if (!info) return null;
    const stake = parseFloat(info.stake ?? 0);
    return this._finalizeContract(contractId, {
      profit: -stake, status: 'lost', sellPrice: 0,
      sellTime: Date.now() / 1000, currentSpot: info.entrySpot ?? 0, exitReason: reason,
    });
  }

  // ── Stuck-contract recovery (sweeps stale stream subscriptions) ───
  checkStuckContracts(maxStaleMs = 180000) {
    const now = Date.now();
    for (const [cid, info] of this.open.entries()) {
      if (now - (info.lastUpdateAt ?? 0) <= maxStaleMs) continue;
      if (this._selling.has(cid)) continue;
      const staleSec = ((now - info.lastUpdateAt) / 1000).toFixed(0);
      logger.warn(`stuck #${cid} — no update for ${staleSec}s, reconciling`);
      this._reconcileStuck(cid, info).catch(e => logger.error(`stuck reconcile #${cid} failed:`, e.message));
    }
  }

  async _reconcileStuck(cid, info) {
    this._selling.add(cid);
    try {
      // Ask the server for the authoritative state first; if it's already
      // settled, route through the normal update path (idempotent).
      try {
        const res = await this.client._send({ proposal_open_contract: 1, contract_id: cid }, 12000);
        const oc = res?.proposal_open_contract;
        if (oc && (oc.status !== 'open' || oc.is_sold)) {
          this._onUpdate({ proposal_open_contract: oc }, info);
          return;
        }
      } catch (e) { logger.debug(`stuck POC fetch #${cid}:`, e.message); }

      await this.sell(cid, 0, info);
    } finally {
      this._selling.delete(cid);
    }
  }

  async cleanupAllSubscriptions() {
    const promises = [];
    for (const [contractId, subId] of this._subscriptions) {
      promises.push(this.client.forget(subId).catch(e => logger.debug(`cleanup sub ${contractId}:`, e.message)));
    }
    await Promise.all(promises);
    this._subscriptions.clear();
  }

  openTrades() { return Array.from(this.open.values()); }
  count() { return this.open.size; }
}

// ═══════════════════════════════════════════════════════════════════════
// 9. STATISTICS  (trade log, streaks, daily summaries)
// ═══════════════════════════════════════════════════════════════════════
const utcDateStr = (d = new Date()) => d.toISOString().slice(0, 10);
const utcHour    = (d = new Date()) => d.getUTCHours();
const money = (n, c = CONFIG.currency) => `${n >= 0 ? '+' : ''}${Number(n || 0).toFixed(2)} ${c}`;

// Human-readable duration formatter for trade-held time. Uses the largest
// unit that's ≥ 1, with up to one level of sub-unit precision so
// "1m 23s" wins over "83s" but "23s" doesn't get padded to "0m 23s".
function formatDuration(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec < 0) return 'n/a';
  const s = Math.floor(totalSec);
  if (s < 1)    return '<1s';
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.dailySummaries = {};
    this.overallProfit = 0;
    this.currentLossStreak = 0;
    this.maxLossStreak = 0;
    // Histogram of consecutive-loss events: increments each time streak reaches N.
    // e.g. a 5-loss streak increments x2,x3,x4,x5 (one event per threshold).
    this.lossStreakEvents = { x2: 0, x3: 0, x4: 0, x5: 0, x6: 0, x7: 0 };
    this.eodSentDates = [];
    this.dailyState = {};   // date -> { trades, pnl, lossStreak, settledIds, ... }  for cap math
    if (saved) this.load(saved);
  }
  load(s) {
    if (Array.isArray(s.trades)) this.trades = s.trades;
    if (s.dailySummaries) this.dailySummaries = s.dailySummaries;
    this.overallProfit = Number(s.overallProfit || 0);
    this.currentLossStreak = Number(s.currentLossStreak || 0);
    this.maxLossStreak = Number(s.maxLossStreak || 0);
    // backwards-compat: older state may have only x2-x4 or no histogram at all
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
  // Human-readable loss-streak breakdown: "x2=3 x3=1 x4=0 ..."
  lossStreakLine() {
    const e = this.lossStreakEvents;
    return `x2=${e.x2} x3=${e.x3} x4=${e.x4} x5=${e.x5} x6=${e.x6} x7=${e.x7}`;
  }
  record(trade) {
    const tsMs = Number(trade.sellTime || trade.buyTime || Date.now() / 1000) * 1000;
    const d = new Date(tsMs);
    const rec = { ...trade, timestamp: tsMs, date: utcDateStr(d), hour: utcHour(d) };
    this.trades.push(rec);
    // 'unknown' results do not contribute to P&L or streak (we never confirmed them).
    if (rec.status === 'unknown') return rec;
    this.overallProfit += Number(rec.profit || 0);
    if (rec.status === 'lost') {
      this.currentLossStreak += 1;
      this.maxLossStreak = Math.max(this.maxLossStreak, this.currentLossStreak);
      // increment histogram exactly when streak hits threshold (cumulative)
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
// 10. BOT  (orchestrator: rate-limited entry, TP+cap exits, summaries)
// ═══════════════════════════════════════════════════════════════════════
class AccuHoldBot {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = new DerivClient(cfg);
    this.market = new MarketDataManager(this.client, cfg);
    this.exec = new TradeExecutor(this.client, cfg);
    this.exec.bot = this;
    this.exec.market = this.market;
    this.stats = new StatisticsManager();

    this.stopped = false;
    this.manualRestartRequired = false;
    this.manualRestartReason = '';
    this.startBalance = null;
    this.lastBalance = null;
    this.lastTradeAt = 0;
    this.lastEntryAt = 0;
    this.lastEntryBySymbol = new Map();
    this.consecutiveLosses = 0;
    this.overallProfit = 0;
    this.dryRun = false;
    this._bootedOnce = false;
    this._tradeInFlight = false;
    this._dailyStopUntil = 0;
    this._dailyStopNotified = false;
    this._lastDayISODate = null;
    this._analysisT = null;
    this._hourlyBoot = null;
    this._hourlyT = null;
    this._eodBoot = null;
    this._proposalT = null;
    this._watchdogT = null;
    this._stuckT = null;
    this.paused = false;
    this._pauseStartTimer = null;
    this._pauseEndTimer = null;
    // ── Martingale state ──────────────────────────────────
    this.baseStake = Number(cfg.stake) || 1.0;
    this.currentStake = this.baseStake;
    this.martingaleStep = 0; // 0 = base, 1..martingaleSteps
  }

  // ── Martingale helpers ──────────────────────────────────
  _isMartingaleEnabled() {
    return Number(this.cfg.martingaleMultiplier) > 1.0 && parseInt(this.cfg.martingaleSteps, 10) > 0;
  }
  _martingaleLabel() {
    if (!this._isMartingaleEnabled()) return 'OFF';
    return `×${Number(this.cfg.martingaleMultiplier).toFixed(2)} (step ${this.martingaleStep}/${this.cfg.martingaleSteps})`;
  }
  _calcMartingaleStake(step) {
    const base = this.baseStake;
    const mult = Number(this.cfg.martingaleMultiplier) || 1;
    if (step <= 0 || mult <= 1) return +base.toFixed(2);
    // stake = base × multiplier^step, rounded to 2dp, capped at 2dp precision
    return +(base * Math.pow(mult, step)).toFixed(2);
  }
  _updateMartingaleOnResult(status) {
    if (!this._isMartingaleEnabled()) {
      this.martingaleStep = 0;
      this.currentStake = this.baseStake;
      return { changed: false, reason: 'disabled' };
    }
    const maxSteps = parseInt(this.cfg.martingaleSteps, 10);
    if (status === 'won') {
      if (this.martingaleStep > 0) {
        logger.info(`martingale RESET: win after ${this.martingaleStep} steps → stake ${this.currentStake.toFixed(2)} → ${this.baseStake.toFixed(2)}`);
        this.martingaleStep = 0;
        this.currentStake = this.baseStake;
        return { changed: true, reason: 'win-reset' };
      }
      this.martingaleStep = 0;
      this.currentStake = this.baseStake;
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
      // reached max steps → reset to base (classic martingale cycle)
      logger.warn(`martingale MAX STEPS hit (${this.martingaleStep}/${maxSteps}) on loss — resetting to base stake ${this.baseStake.toFixed(2)}`);
      telegram.send(`⚠️ <b>Martingale Max Steps Reached</b>\nStep ${this.martingaleStep}/${maxSteps} lost. Resetting stake to base <b>${this.baseStake.toFixed(2)} ${this.currencyStr()}</b>.`);
      this.martingaleStep = 0;
      this.currentStake = this.baseStake;
      return { changed: true, reason: 'max-reset' };
    }
    return { changed: false, reason: 'no-op' };
  }

  async start() {
    logger.info('═══════════════════════════════════════════');
    logger.info('  accuHOLD v1 — memoryless BOOM/CRASH ACCU  ');
    logger.info('═══════════════════════════════════════════');
    logger.info(`assets: ${this.cfg.assets.join(', ')}`);
    logger.info(`growth rate: ${(this.cfg.growthRate*100).toFixed(0)}%  TP ×${this.cfg.takeProfitMultiple}  tick-cap ${(this.cfg.tickCapFraction*100).toFixed(0)}% of live median`);
    if (this._isMartingaleEnabled()) {
      logger.info(`martingale: ON  multiplier ×${this.cfg.martingaleMultiplier}  steps ${this.cfg.martingaleSteps}  base stake ${this.baseStake.toFixed(2)}`);
    } else {
      logger.info(`martingale: OFF (flat stake ${this.baseStake.toFixed(2)})`);
    }

    if (!this.cfg.apiToken) { logger.error('API token missing'); process.exit(1); }

    this.client.on('authorized', info => this._onAuthorized(info));
    this.client.on('close', () => this._onDisconnected());
    this.exec.on('open', t => this._onTradeOpen(t));
    this.exec.on('result', t => this._onTradeResult(t));

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
    process.on('uncaughtException', e => {
      logger.error('uncaughtException:', e);
      this._saveState('fatal');
      try { this.client.stop(); } catch (_) {}
      process.exit(1);
    });
    process.on('unhandledRejection', e => {
      logger.error('unhandledRejection:', e);
      this._saveState('fatal');
      try { this.client.stop(); } catch (_) {}
      process.exit(1);
    });

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

  _nextUtcMidnight() {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).getTime();
  }

  // ── Pause helpers (ported from accuAPEX) ─────────────────────────
  _parsePauseTime(str) {
    const m = String(str || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return { h: Math.max(0, Math.min(23, Number(m[1]))), min: Math.max(0, Math.min(59, Number(m[2]))) };
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
    if (this._pauseEndTimer) { clearTimeout(this._pauseEndTimer); this._pauseEndTimer = null; }
  }
  _schedulePause() {
    this._clearPauseTimers();
    if (!this.cfg.pauseEnabled) return;
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const start = this._parsePauseTime(this.cfg.pauseStartGmt);
    const end   = this._parsePauseTime(this.cfg.pauseEndGmt);
    if (!start || !end) { logger.warn('pause schedule: invalid pauseStartGmt or pauseEndGmt'); return; }
    const startMin = start.h * 60 + start.min;
    const endMin   = end.h   * 60 + end.min;
    const currentlyPaused = startMin > endMin
      ? (nowMin >= startMin || nowMin < endMin)
      : (nowMin >= startMin && nowMin < endMin);
    if (currentlyPaused) {
      this.paused = true;
      const delay = this._msToTarget(end.h, end.min);
      this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
      logger.info(`pause: currently active, resumes in ${(delay/60000).toFixed(1)}m`);
    } else {
      this.paused = false;
      const delay = this._msToTarget(start.h, start.min);
      this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), delay);
      logger.info(`pause: scheduled, pauses in ${(delay/60000).toFixed(1)}m at ${this.cfg.pauseStartGmt} GMT`);
    }
  }
  _onPauseResume(action) {
    this._clearPauseTimers();
    if (action === 'pause') {
      this.paused = true;
      logger.info(`TRADING PAUSED at ${this.cfg.pauseStartGmt} GMT until ${this.cfg.pauseEndGmt} GMT`);
      telegram.send(`⏸️ <b>TRADING PAUSED</b>\nPaused from <b>${this.cfg.pauseStartGmt}</b> to <b>${this.cfg.pauseEndGmt}</b> GMT.`);
      const end = this._parsePauseTime(this.cfg.pauseEndGmt);
      if (end) this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), this._msToTarget(end.h, end.min));
    } else {
      this.paused = false;
      logger.info(`TRADING RESUMED at ${this.cfg.pauseEndGmt} GMT`);
      telegram.send(`▶️ <b>TRADING RESUMED</b>\nOverall: ${money(this.overallProfit, this.currencyStr())}`);
      const start = this._parsePauseTime(this.cfg.pauseStartGmt);
      if (start) this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), this._msToTarget(start.h, start.min));
    }
  }
  _isTradingAllowedToday() {
    const dayOfWeek = new Date().getUTCDay();
    const daySettings = [this.cfg.tradeSunday, this.cfg.tradeMonday, this.cfg.tradeTuesday, this.cfg.tradeWednesday, this.cfg.tradeThursday, this.cfg.tradeFriday, this.cfg.tradeSaturday];
    return !!daySettings[dayOfWeek];
  }
  _checkDayChange() {
    const today = utcDateStr();
    if (this._lastDayISODate && this._lastDayISODate !== today) {
      logger.info(`new day detected: ${this._lastDayISODate} → ${today}`);
      this.consecutiveLosses = 0;
      // Note: martingale state is NOT auto-reset on day change; stake cycle continues.
      // Uncomment next two lines if you want day-bound reset:
      // this.martingaleStep = 0;
      // this.currentStake = this.baseStake;
      this._dailyStopUntil = 0;
      this._dailyStopNotified = false;
      telegram.send(`📅 <b>New trade day: ${today}</b>\nOverall: ${money(this.overallProfit, this.currencyStr())}\n♻️ Martingale: ${this._martingaleLabel()} · Stake ${this.currentStake.toFixed(2)} ${this.currencyStr()}`);
    }
    this._lastDayISODate = today;
  }

  // ── Authorised ──────────────────────────────────────────────────
  async _onAuthorized(info) {
    if (this.startBalance == null) this.startBalance = this.balance ?? this.client.balance;
    this.lastBalance = this.startBalance;

    const martingaleLine = this._isMartingaleEnabled()
      ? `♻️ <b>Martingale:</b> ON  ×${Number(this.cfg.martingaleMultiplier).toFixed(2)}  steps ${this.cfg.martingaleSteps}  (base ${this.baseStake.toFixed(2)} → now ${this.currentStake.toFixed(2)} step ${this.martingaleStep})\n`
      : `♻️ <b>Martingale:</b> OFF  (flat stake ${this.baseStake.toFixed(2)})\n`;
    const lossLine = `📉 <b>Loss Streak:</b> ${this.consecutiveLosses} (max ${this.stats.maxLossStreak}) · ${this.stats.lossStreakLine()}\n`;
    if (!this._bootedOnce) {
      this._bootedOnce = true;
      telegram.send(
        `<b>accuHOLD v1 Bot Online</b>${this.dryRun ? ' <b>🔒 DRY-RUN</b>' : ''}\n\n` +
        `<b>Account:</b> ${info.loginid} (${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'})\n` +
        `<b>Balance:</b> ${(this.startBalance ?? 0).toFixed(2)} ${this.currencyStr()}\n` +
        `<b>Assets:</b> ${this.cfg.assets.length} (BOOM + CRASH)\n` +
        `<b>Growth rate:</b> ${(this.cfg.growthRate*100).toFixed(0)}% · <b>TP:</b> ×${this.cfg.takeProfitMultiple} · <b>tick-cap:</b> ${(this.cfg.tickCapFraction*100).toFixed(0)}% of live median\n` +
        martingaleLine +
        lossLine +
        `<b>Cooldown:</b> ${this.cfg.perSymbolCooldownMs/1000}s/symbol\n` +
        `<b>Daily caps:</b> ${this.cfg.dailyMaxTrades} trades / ${this.cfg.dailyMaxLoss} ${this.currencyStr()}\n` +
        `<b>Overall:</b> ${money(this.overallProfit, this.currencyStr())}`,
      );
    } else {
      telegram.send(`🔄 <b>Reconnected</b> (${info.loginid}, ${info.isVirtual ? 'DEMO' : 'REAL'})\n${martingaleLine.trim()}\n${lossLine.trim()}`);
    }

    // Load symbols + fetch the live ticks_stayed_in for the configured
    // (symbol, growth_rate) buckets BEFORE we ever consider an entry.
    try {
      await this.market.refreshStays(this.cfg.assets, this.cfg.growthRate);
    } catch (e) { logger.warn('post-auth refreshStays:', e.message); }

    // Reconcile any contracts that were open across the disconnect.
    try { await this.exec.reconcileOpenContracts(); }
    catch (e) { logger.warn('reconcile:', e.message); }

    this._schedulePause();
    if (this._analysisT) clearInterval(this._analysisT);
    this._analysisT = setInterval(() => this._maybeEnter(), 3000);
    if (this._proposalT) clearInterval(this._proposalT);
    this._proposalT = setInterval(() => this.market.refreshStays(this.cfg.assets, this.cfg.growthRate), this.cfg.proposalRefreshMs);
    this._startWatchdog();
    this._startStuckSweep();
    this._maybeEnter();
  }

  async _onDisconnected() {
    this._clearWatchdog();
    this._clearStuckSweep();
    this._clearPauseTimers();
    telegram.send(`⚠️ <b>Connection lost</b> — reconnecting…`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    if (this._proposalT) { clearInterval(this._proposalT); this._proposalT = null; }
    // exec.open is intentionally KEPT — contracts are still live server-side.
    // reconcileOpenContracts() re-attaches them after re-auth.
    this.exec._subscriptions.clear();
  }

  // ── Trade callbacks ─────────────────────────────────────────────
  _onTradeOpen(t) {
    const martingaleNote = this._isMartingaleEnabled()
      ? `♻️ <b>Martingale:</b> ${this._martingaleLabel()} · base ${this.baseStake.toFixed(2)} → <b>${t.stake.toFixed(2)} ${this.currencyStr()}</b>${this.martingaleStep > 0 ? ` (step ${this.martingaleStep}/${this.cfg.martingaleSteps})` : ' (base)'}\n`
      : '';
    const lossNote = `📉 <b>Loss Streak:</b> ${this.consecutiveLosses} · max ${this.stats.maxLossStreak} · ${this.stats.lossStreakLine()}\n`;
    const nextStakeNote = this._isMartingaleEnabled()
      ? `➡️ <b>Next stake (if loss):</b> ${this._calcMartingaleStake(Math.min(this.martingaleStep + 1, this.cfg.martingaleSteps)).toFixed(2)} ${this.currencyStr()}${this.martingaleStep + 1 > this.cfg.martingaleSteps ? ' (would reset to base)' : ''}\n`
      : '';
    const msg =
      `🟢 <b>TRADE OPENED</b>\n\n` +
      `<b>Contract:</b> #${t.contractId}\n` +
      `<b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth Rate:</b> ${(t.growthRate*100).toFixed(2)}%\n` +
      `<b>Stake:</b> ${t.stake.toFixed(2)} ${this.currencyStr()}${this.martingaleStep > 0 ? ` <i>(martingale ×${Math.pow(this.cfg.martingaleMultiplier, this.martingaleStep).toFixed(2)})</i>` : ''}\n` +
      martingaleNote +
      `<b>Take-Profit floor:</b> ${(t.stake * (t.takeProfitMultiple ?? this.cfg.takeProfitMultiple)).toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Tick-cap:</b> ${t.tickCapTicks ?? 'n/a'} ticks (${(this.cfg.tickCapFraction*100).toFixed(0)}% × live median <code>${t.ticksStayedInMedian ?? 'n/a'}</code>)\n` +
      lossNote +
      nextStakeNote +
      `<b>Overall:</b> ${money(this.overallProfit, this.currencyStr())}\n\n` +
      `<i>No timing signal — entry is rate-limited only. Exits arm immediately on every tick.</i>`;
    telegram.send(msg);
  }

  _onTradeResult(t) {
    const rec = this.stats.record(t);
    if (t.status === 'unknown') {
      // Booked as unknown so it cannot corrupt P&L or streaks.
      logger.warn(`trade #${t.contractId} unconfirmable — recorded as 'unknown', excluded from P&L/streaks`);
      telegram.send(`⚠️ <b>UNCONFIRMABLE CONTRACT</b> #${t.contractId} ${t.symbol}\nRecorded as 'unknown' — excluded from P&L and streaks.`);
      this._saveState('after-trade');
      return;
    }
    this.lastBalance = (this.lastBalance ?? this.balance ?? 0) + t.profit;
    this.overallProfit += t.profit;
    if (t.status === 'lost') this.consecutiveLosses += 1;
    else if (t.status === 'won') this.consecutiveLosses = 0;

    // ── Martingale update (stake for NEXT trade) ──────────
    const prevStake = this.currentStake;
    const prevStep = this.martingaleStep;
    const mg = this._updateMartingaleOnResult(t.status);

    // Risk halt: max consecutive losses → require manual restart.
    if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses && !this.manualRestartRequired) {
      this.manualRestartRequired = true;
      this.manualRestartReason = `${this.consecutiveLosses} consecutive losses (cap ${this.cfg.maxConsecutiveLosses})`;
      logger.error(`RISK HALT: ${this.manualRestartReason} — manual restart required`);
      telegram.send(
        `⛔ <b>RISK HALT</b>\n${this.manualRestartReason}.\n` +
        `Trading is paused. Restart the bot to clear the halt.`,
      );
    }

    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));
    const emoji = t.status === 'won' ? '✅' : '❌';
    const label = t.status === 'won' ? 'WIN' : 'LOSS';
    const exit = t.exitReason || 'n/a';
    const exitLine = exit.startsWith('take-profit') ? '🎯 take-profit'
                  : exit.startsWith('tick-cap')     ? '⏱️ tick-cap'
                  : exit.startsWith('knockout')     ? '💥 knockout'
                  : exit;
    // Duration = sell_time − buy_time. `sellTime` and `buyTime` are
    // populated by every finalize path (terminal status, voluntary sell,
    // already-closed-on-server) so this is the canonical "how long was
    // the trade held" number — independent of how many proposal_open_
    // contract updates arrived in the meantime.
    const buyTs  = Number(t.buyTime  || 0);
    const sellTs = Number(t.sellTime || 0);
    const durationSec = (buyTs > 0 && sellTs > 0 && sellTs >= buyTs) ? (sellTs - buyTs) : null;
    const durationLine = durationSec != null
      ? `⏱️ <b>Duration:</b> ${formatDuration(durationSec)}\n`
      : `⏱️ <b>Duration:</b> n/a\n`;
    // Martingale display for this result
    let martingaleLine = '';
    if (this._isMartingaleEnabled()) {
      if (t.status === 'lost') {
        if (mg.reason === 'loss-step-up') {
          martingaleLine = `♻️ <b>Martingale:</b> STEP UP  ${prevStep}/${this.cfg.martingaleSteps} → ${this.martingaleStep}/${this.cfg.martingaleSteps}  stake ${prevStake.toFixed(2)} → <b>${this.currentStake.toFixed(2)} ${this.currencyStr()}</b> (×${this.cfg.martingaleMultiplier})\n`;
        } else if (mg.reason === 'max-reset') {
          martingaleLine = `♻️ <b>Martingale:</b> MAX STEPS hit → RESET to base <b>${this.currentStake.toFixed(2)} ${this.currencyStr()}</b>\n`;
        } else {
          martingaleLine = `♻️ <b>Martingale:</b> ${this._martingaleLabel()}  stake now ${this.currentStake.toFixed(2)} ${this.currencyStr()}\n`;
        }
      } else {
        if (mg.reason === 'win-reset') {
          martingaleLine = `♻️ <b>Martingale:</b> WIN → RESET  ${prevStake.toFixed(2)} → <b>${this.currentStake.toFixed(2)} ${this.currencyStr()}</b> (base)\n`;
        } else {
          martingaleLine = `♻️ <b>Martingale:</b> WIN at base — stake stays <b>${this.currentStake.toFixed(2)} ${this.currencyStr()}</b>\n`;
        }
      }
    } else {
      martingaleLine = `♻️ <b>Martingale:</b> OFF  (flat stake)\n`;
    }
    const lossBreakdown = `📉 <b>Loss Streak:</b> ${this.consecutiveLosses} · max ${this.stats.maxLossStreak}\n` +
                          `   ${this.stats.lossStreakLine()}\n`;
    const msg =
      `${emoji} <b>TRADE ${label}</b>\n\n` +
      `<b>Contract:</b> #${t.contractId} · <b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth:</b> ${(t.growthRate*100).toFixed(0)}% · <b>Stake:</b> ${Number(t.stake).toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Sell:</b> ${Number(t.sellPrice ?? 0).toFixed(2)} ${this.currencyStr()}\n` +
      `${t.profit >= 0 ? '💚' : '💔'} <b>Profit:</b> ${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Exit:</b> ${exitLine}\n` +
      durationLine +
      `<b>Ticks held:</b> ${t.ticksHeld ?? '?'} (tick-cap was ${t.tickCapTicks ?? '?'})` +
      (t.ticksHeldOpen != null && t.ticksHeld !== t.ticksHeldOpen ? ` · since-sub: ${t.ticksHeldOpen}` : '') +
      `\n` +
      martingaleLine +
      lossBreakdown +
      `<b>Balance:</b> ${(this.lastBalance ?? 0).toFixed(2)} ${this.currencyStr()}\n\n` +
      `<b>GMT Day (${rec.date})</b>\n` +
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses}) | WR ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net: ${money(todayStats.totalProfit, this.currencyStr())} | PF ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n` +
      `<b>Overall:</b> ${money(this.overallProfit, this.currencyStr())}`;
    telegram.send(msg);
    this.lastTradeAt = Date.now();
    this._saveState('after-trade');
  }

  // ── Entry decision: rate-limited, NO timing/hazard/pattern logic ─
  // The bot has NO entry signal. It enters on a simple rate-limited basis:
  //   • Cooldown between trades on the same symbol.
  //   • A global entry gap between any two new entries.
  //   • A max-concurrent-open cap.
  //   • Round-robin across eligible symbols (longest-since-touched first).
  // All exit logic is armed inside `exec.buy()` against the live
  // `ticks_stayed_in` median that came back with the proposal.
  async _maybeEnter() {
    if (this._tradeInFlight) return;
    this._tradeInFlight = true;
    try {
      if (this.stopped) return;
      if (!this.client.authorized) return;
      if (this.paused) { logger.debug('paused — skipping'); return; }
      if (!this._isTradingAllowedToday()) return;
      this._checkDayChange();
      if (this.manualRestartRequired) return;

      const now = Date.now();
      if (this._dailyStopUntil && now < this._dailyStopUntil) return;
      const today = this.stats.todayTrades();
      if (today.length >= this.cfg.dailyMaxTrades || today.reduce((s, t) => s + (t.profit || 0), 0) <= -this.cfg.dailyMaxLoss) {
        if (!this._dailyStopNotified) {
          this._dailyStopNotified = true;
          this._dailyStopUntil = this._nextUtcMidnight();
          const pl = today.reduce((s, t) => s + (t.profit || 0), 0);
          logger.warn(`daily hard stop: ${today.length} trades / P/L ${pl.toFixed(2)} — paused until next UTC day`);
          telegram.send(`⛔ <b>Daily hard stop</b>\n${today.length} trades, net ${money(pl, this.currencyStr())}.\nPaused until next UTC day.`);
        }
        return;
      }

      if (now - this.lastTradeAt < this.cfg.perSymbolEntryGapMs) return;
      if (this.exec.count() >= this.cfg.maxOpenTrades) return;

      // Pick a symbol that passes its per-symbol cooldown and has a live
      // ticks_stayed_in median (the tick-cap exit needs it). We accept
      // a NULL median (logged) only as a fallback — the bot still trades,
      // it just can't apply the tick-cap and the contract runs to KO/TP.
      const candidates = [];
      for (const sym of this.cfg.assets) {
        if (this.market._unsupportedSymbols.has(sym)) continue;
        const last = this.lastEntryBySymbol.get(sym) || 0;
        if (now - last < this.cfg.perSymbolCooldownMs) continue;
        const median = this.market.getMedianStay(sym, this.cfg.growthRate);
        candidates.push({ sym, median });
      }
      if (!candidates.length) return;

      // Round-robin: trade the symbol that hasn't been touched the longest.
      candidates.sort((a, b) => (this.lastEntryBySymbol.get(a.sym) || 0) - (this.lastEntryBySymbol.get(b.sym) || 0));
      const sym = candidates[0].sym;

      const entryStake = this.currentStake;
      logger.info(
        `ENTRY ${sym} g=${this.cfg.growthRate} stake=${entryStake.toFixed(2)} (base ${this.baseStake.toFixed(2)} martingale ${this._martingaleLabel()}) ` +
        `tp=×${this.cfg.takeProfitMultiple} (tick-cap and median will be live-fetched from the proposal)`,
      );

      if (this.dryRun) {
        logger.info(`DRY-RUN would buy ${sym} stake=${entryStake.toFixed(2)}`);
        return;
      }

      const trade = await this.exec.buy(sym, this.cfg.growthRate, entryStake, {});
      this.lastEntryAt = Date.now();
      this.lastEntryBySymbol.set(sym, this.lastEntryAt);
    } catch (e) {
      logger.error('entry error:', e.message);
    } finally {
      this._tradeInFlight = false;
    }
  }

  // ── Watchdog (sweeps ALL stale open contracts) ──────────────────
  // The watch policy is "re-subscribe first, then force-sell":
  //   • If the proposal_open_contract stream just went quiet (subscription
  //     dropped server-side), re-attach it and let normal exit logic run.
  //   • Only sell/force-settle when the server itself says the contract is
  //     no longer open OR the re-subscribe path is exhausted.
  _startWatchdog() {
    this._clearWatchdog();
    this._watchdogT = setInterval(() => {
      const now = Date.now();
      for (const info of this.exec.openTrades()) {
        if (now - info.lastUpdateAt > this.cfg.tradeWatchdogMs) {
          const staleSec = ((now - info.lastUpdateAt) / 1000).toFixed(0);
          logger.warn(`watchdog: #${info.contractId} stream quiet ${staleSec}s — re-subscribing`);
          this.exec._attachContractStream(info)
            .then(() => info.lastUpdateAt = Date.now())
            .catch(() => this.exec._reconcileStuck(info.contractId, info)
              .catch(e => logger.error(`watchdog reconcile #${info.contractId} failed:`, e.message)));
        }
      }
    }, this.cfg.tradeWatchdogMs / 2);
  }
  _clearWatchdog() { if (this._watchdogT) { clearInterval(this._watchdogT); this._watchdogT = null; } }

  // ── Stuck-contract sweep (separate, longer cadence) ──────────────
  _startStuckSweep() {
    this._clearStuckSweep();
    this._stuckT = setInterval(() => this.exec.checkStuckContracts(180000), 30000);
  }
  _clearStuckSweep() { if (this._stuckT) { clearInterval(this._stuckT); this._stuckT = null; } }

  // ── Summaries ───────────────────────────────────────────────────
  _sendHourly() {
    const now = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const date = utcDateStr(prev), hour = utcHour(prev);
    const list = this.stats.tradesForHour(date, hour);
    const s = this.stats.stats(list);
    const martingaleInfo = this._isMartingaleEnabled()
      ? `♻️ Martingale: ${this._martingaleLabel()} · base ${this.baseStake.toFixed(2)} → now ${this.currentStake.toFixed(2)} ${this.currencyStr()}\n`
      : `♻️ Martingale: OFF\n`;
    const lossInfo = `📉 Loss streak: ${this.consecutiveLosses} · max ${this.stats.maxLossStreak} · ${this.stats.lossStreakLine()}\n`;
    if (!list.length) {
      telegram.send(`⏰ <b>${date} ${pad(hour)}:00</b> — No trades\n${martingaleInfo}${lossInfo}💼 Overall: ${money(this.overallProfit, this.currencyStr())}`);
      return;
    }
    let msg = `⏰ <b>${date} ${pad(hour)}:00</b>\n\n📊 ${s.count} trades (✅${s.wins} ❌${s.losses})\n📈 WR: ${s.winRate.toFixed(1)}%\n💰 P/L: <b>${money(s.totalProfit, this.currencyStr())}</b>\n💼 Overall: <b>${money(this.overallProfit, this.currencyStr())}</b>\n${martingaleInfo}${lossInfo}\n`;
    list.slice(-15).forEach((t, i) => {
      const exit = (t.exitReason || '').split(':')[0];
      const mgTag = t.martingaleStep != null && t.martingaleStep > 0 ? ` MG×${Number(t.martingaleMultiplier || 1).toFixed(2)}` : '';
      msg += `${i + 1}. ${t.status === 'won' ? '✅' : '❌'} #${t.contractId} ${t.symbol} ticks=${t.ticksHeld ?? '?'} exit=${exit}${mgTag} ${money(t.profit, this.currencyStr())}\n`;
    });
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
    msg += `💼 Overall: <b>${money(this.overallProfit, this.currencyStr())}</b>\n`;
    if (this._isMartingaleEnabled()) {
      msg += `♻️ Martingale: ${this._martingaleLabel()} · base ${this.baseStake.toFixed(2)} → now ${this.currentStake.toFixed(2)} ${this.currencyStr()}\n`;
    } else {
      msg += `♻️ Martingale: OFF (flat stake)\n`;
    }
    msg += `📉 Loss streak: current ${this.consecutiveLosses} · max ${this.stats.maxLossStreak} · ${this.stats.lossStreakLine()}`;
    telegram.send(msg);
    this.stats.markEodSent(date);
    this._saveState(`eod-${reason}`);
    this.startBalance = this.client.balance ?? this.lastBalance ?? this.startBalance;
  }

  currencyStr() { return this.client.currency || this.cfg.currency; }

  // ── State persistence (atomic write) ────────────────────────────
  _saveState(reason = 'checkpoint') {
    if (!this.cfg.stateSaveOnTrade && reason === 'after-trade') return;
    if (!this.cfg.stateSaveOnShutdown && reason === 'shutdown') return;
    try {
      const payload = {
        version: 2, engine: 'accuHOLD v1', savedAt: new Date().toISOString(), savedReason: reason,
        startBalance: this.startBalance, lastBalance: this.lastBalance, overallProfit: this.overallProfit,
        consecutiveLosses: this.consecutiveLosses,
        manualRestartRequired: this.manualRestartRequired,
        manualRestartReason: this.manualRestartReason,
        lastEntryBySymbol: Array.from(this.lastEntryBySymbol.entries()),
        // Martingale persistence
        baseStake: this.baseStake,
        currentStake: this.currentStake,
        martingaleStep: this.martingaleStep,
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
      if (d.consecutiveLosses != null) this.consecutiveLosses = d.consecutiveLosses;
      if (d.manualRestartRequired) { this.manualRestartRequired = true; this.manualRestartReason = d.manualRestartReason || ''; }
      if (Array.isArray(d.lastEntryBySymbol)) this.lastEntryBySymbol = new Map(d.lastEntryBySymbol);
      // Martingale restore
      if (d.baseStake != null) this.baseStake = Number(d.baseStake);
      if (d.currentStake != null) this.currentStake = Number(d.currentStake);
      else this.currentStake = this.baseStake;
      if (d.martingaleStep != null) this.martingaleStep = Number(d.martingaleStep) || 0;
      // reconcile with current config if base stake changed
      if (Number(this.cfg.stake) !== this.baseStake) {
        // keep persisted cycle but ensure base matches config
        this.baseStake = Number(this.cfg.stake);
        this.currentStake = this._calcMartingaleStake(this.martingaleStep);
      }
      this.stats = new StatisticsManager(d.stats || {});
      logger.info(
        `state restored: overallProfit=${this.stats.overallProfit.toFixed(2)} ` +
        `consecLosses=${this.consecutiveLosses} halt=${this.manualRestartRequired} ` +
        `martingale step=${this.martingaleStep} stake=${this.currentStake.toFixed(2)}/${this.baseStake.toFixed(2)} ` +
        `maxStreak=${this.stats.maxLossStreak} ${this.stats.lossStreakLine()}`,
      );
    } catch (e) { logger.warn('state load:', e.message); }
  }

  stop(signal) {
    if (this.stopped) return;
    this.stopped = true;
    this._clearWatchdog();
    this._clearStuckSweep();
    this._clearPauseTimers();
    logger.info(`stopping (${signal})`);
    telegram.send(`<b>accuHOLD Bot stopped</b>\nSignal: ${signal}`);
    if (this._analysisT) clearInterval(this._analysisT);
    if (this._proposalT) clearInterval(this._proposalT);
    if (this._hourlyT) clearInterval(this._hourlyT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._eodBoot) clearTimeout(this._eodBoot);

    this.exec.cleanupAllSubscriptions().catch(e => logger.warn('cleanup failed:', e.message)).finally(() => {
      const today = this.stats.todayTrades();
      const s = this.stats.stats(today);
      const mgLine = this._isMartingaleEnabled()
        ? `♻️ Martingale: ${this._martingaleLabel()} · base ${this.baseStake.toFixed(2)} → now ${this.currentStake.toFixed(2)}\n`
        : `♻️ Martingale: OFF\n`;
      const lossLine = `📉 Loss streak: ${this.consecutiveLosses} · max ${this.stats.maxLossStreak} · ${this.stats.lossStreakLine()}\n`;
      const msg = `🌙 <b>SESSION END</b>\n📊 ${s.count} trades (✅${s.wins} ❌${s.losses}) | WR ${s.winRate.toFixed(1)}%\n💰 Net: ${money(s.totalProfit, this.currencyStr())}\n💼 Overall: ${money(this.overallProfit, this.currencyStr())}\n${mgLine}${lossLine}`;
      telegram.send(msg);
      this._saveState('shutdown');
      this.client.stop();
      setTimeout(() => process.exit(0), 2500);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 11. SELF-TEST  (pure math; no network)
// ═══════════════════════════════════════════════════════════════════════
async function runSelfTest() {
  const results = [];
  const test = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond, detail });
    if (!cond) console.log(`  ✗ ${name} ${detail}`);
  };

  // 1. Median of ticks_stayed_in (right-skewed -> mean pulled up, median = typical).
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
  const sortedMid = sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2;
  // 10 elements => index 5 (5+1)/2. Average of idx 4 (5) and 5 (6) = 5.5
  test('median stay (even length)', sortedMid === 5.5, `mid=${sortedMid}`);

  // 2. Median helper on a skewed sample.
  const arr = [50, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const sorted2 = arr.slice().sort((a, b) => a - b);
  const med = sorted2.length % 2 ? sorted2[sorted2.length >> 1] : (sorted2[(sorted2.length >> 1) - 1] + sorted2[sorted2.length >> 1]) / 2;
  test('median (even length)', med === 6, `med=${med}`);

  // 3. Tick-cap formula: cap = max(1, floor(median × fraction)).
  const fraction = 0.55, median = 30;
  const cap = Math.max(1, Math.floor(median * fraction));
  test('tick cap = 0.55 × 30 = 16', cap === 16, `cap=${cap}`);

  // 4. Config sanity: growth rate is one of the allowed values.
  test('growthRate in {0.01..0.05}', [0.01, 0.02, 0.03, 0.04, 0.05].includes(CONFIG.growthRate), `growthRate=${CONFIG.growthRate}`);

  // 5. Config: cooldown ≤ entry gap (otherwise gap is redundant).
  test('cooldown ≤ entry gap', CONFIG.perSymbolCooldownMs <= CONFIG.perSymbolEntryGapMs, `${CONFIG.perSymbolCooldownMs} vs ${CONFIG.perSymbolEntryGapMs}`);

  // 6. Assets list is non-empty and contains only BOOM/CRASH.
  const onlyBc = CONFIG.assets.length > 0 && CONFIG.assets.every(s => /BOOM|CRASH/i.test(s));
  test('assets are BOOM/CRASH only', onlyBc, CONFIG.assets.join(','));

  // 7. idem settlement: second finalize returns null.
  const fakeClient = { forget: () => Promise.resolve(), _isPat: false };
  const ex = new TradeExecutor(fakeClient, CONFIG);
  ex.bot = { market: { cacheStays: () => {} } };
  ex.open.set(777, { contractId: 777, symbol: 'BOOM1000', growthRate: 0.02, stake: 1, buyPrice: 1, ticksHeld: 0, _exitReason: 'test' });
  let emitted = 0;
  ex.on('result', () => emitted++);
  const first  = ex._finalizeContract(777, { profit: 0.5, status: 'won',  sellPrice: 1.5, sellTime: 1 });
  const second = ex._finalizeContract(777, { profit: 99,  status: 'won',  sellPrice: 99 });
  test('settle returns info once', !!first && second === null);
  test('settle emits result once', emitted === 1, `emitted=${emitted}`);
  test('settle frees slot', ex.count() === 0);

  // 8. already-closed sell path → 'unknown' finalize (excluded from P&L/streaks).
  const stuckClient = {
    forget: () => Promise.resolve(),
    _send: () => Promise.reject(new Error('not found among your open positions')),
    _isPat: false,
  };
  const ex2 = new TradeExecutor(stuckClient, CONFIG);
  ex2.bot = { market: { cacheStays: () => {} } };
  ex2.open.set(888, { contractId: 888, symbol: 'CRASH1000', growthRate: 0.02, stake: 1, buyPrice: 1, ticksHeld: 0, _exitReason: 'stuck' });
  let uEmitted = 0, uInfo = null;
  ex2.on('result', (t) => { uEmitted++; uInfo = t; });
  await ex2.sell(888, 0, ex2.open.get(888));
  test('already-closed → unknown emitted', uEmitted === 1 && uInfo && uInfo.status === 'unknown', `emitted=${uEmitted} status=${uInfo?.status}`);
  test('already-closed → local slot freed', ex2.count() === 0);

  // 9. unknown results are excluded from overall P&L.
  const s = new StatisticsManager();
  s.record({ contractId: 1, status: 'won',  profit:  2.0, sellTime: Date.now() / 1000 });
  s.record({ contractId: 2, status: 'lost', profit: -1.0, sellTime: Date.now() / 1000 });
  s.record({ contractId: 3, status: 'unknown', profit: 0, sellTime: Date.now() / 1000 });
  test('unknown excluded from P&L', Math.abs(s.overallProfit - 1.0) < 1e-9, `overallProfit=${s.overallProfit}`);

  // 10. live median from a fake proposal (simulates the buy() path).
  const fakeMarket = new MarketDataManager(new EventEmitter(), CONFIG);
  fakeMarket.cacheStays('BOOM1000', 0.02, { ticks_stayed_in: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] });
  const liveMed = fakeMarket.getMedianStay('BOOM1000', 0.02);
  test('live median from proposal', liveMed === 12.5, `liveMed=${liveMed}`);
  const liveCap = Math.max(1, Math.floor(liveMed * 0.55));
  test('live tick-cap = floor(0.55 × 12.5)', liveCap === 6, `liveCap=${liveCap}`);

  // 11. Martingale stake progression: base × multiplier^step
  {
    const cfg = { stake: 1.00, martingaleMultiplier: 2.10, martingaleSteps: 4 };
    const bot = new AccuHoldBot(cfg);
    bot.baseStake = cfg.stake; bot.currentStake = cfg.stake; bot.martingaleStep = 0;
    test('martingale off at step 0 → base', bot._calcMartingaleStake(0) === 1.00);
    test('martingale step 1 → 2.10', bot._calcMartingaleStake(1) === 2.10);
    test('martingale step 2 → 4.41', bot._calcMartingaleStake(2) === 4.41);
    test('martingale step 3 → 9.26', bot._calcMartingaleStake(3) === 9.26, `got ${bot._calcMartingaleStake(3)}`);
    // Simulate 3 losses then win
    bot._updateMartingaleOnResult('lost'); // step1
    test('mg after 1st loss step=1 stake=2.10', bot.martingaleStep === 1 && bot.currentStake === 2.10, `step=${bot.martingaleStep} stake=${bot.currentStake}`);
    bot._updateMartingaleOnResult('lost'); // step2
    test('mg after 2nd loss step=2 stake=4.41', bot.martingaleStep === 2 && bot.currentStake === 4.41);
    bot._updateMartingaleOnResult('lost'); // step3
    bot._updateMartingaleOnResult('won');  // reset
    test('mg after win resets to base', bot.martingaleStep === 0 && bot.currentStake === 1.00, `step=${bot.martingaleStep} stake=${bot.currentStake}`);
    // Max steps reset
    bot.martingaleStep = 4; bot.currentStake = bot._calcMartingaleStake(4);
    bot._updateMartingaleOnResult('lost'); // should reset
    test('mg max steps → reset to base', bot.martingaleStep === 0 && bot.currentStake === 1.00);
    // Disabled when multiplier <=1
    const botOff = new AccuHoldBot({ stake: 1, martingaleMultiplier: 1.0, martingaleSteps: 4 });
    botOff.baseStake = 1; botOff.currentStake = 1;
    test('martingale disabled when multiplier=1', botOff._isMartingaleEnabled() === false);
    const botOff2 = new AccuHoldBot({ stake: 1, martingaleMultiplier: 2.1, martingaleSteps: 0 });
    botOff2.baseStake = 1; botOff2.currentStake = 1;
    test('martingale disabled when steps=0', botOff2._isMartingaleEnabled() === false);
  }

  // 12. Loss streak histogram x2-x7 and max streak
  {
    const sm = new StatisticsManager();
    // Simulate: win, loss, loss (x2), loss (x3), win, loss, loss (x2), loss (x3), loss (x4), loss (x5), loss (x6), loss (x7), loss (x7 again)
    const seq = ['lost','lost','lost','won','lost','lost','lost','lost','lost','lost','lost','lost'];
    // 8 consecutive losses after the win: streak reaches 2,3,4,5,6,7,7,7...
    seq.forEach((st, i) => sm.record({ contractId: 100+i, status: st, profit: st==='won'?1:-1, sellTime: Date.now()/1000 }));
    test('histogram max streak is 8', sm.maxLossStreak === 8, `max=${sm.maxLossStreak}`);
    test('histogram x2 increments', sm.lossStreakEvents.x2 === 2, `x2=${sm.lossStreakEvents.x2}`);
    test('histogram x3 increments', sm.lossStreakEvents.x3 === 2, `x3=${sm.lossStreakEvents.x3}`);
    test('histogram x7 increments for >=7', sm.lossStreakEvents.x7 === 2, `x7=${sm.lossStreakEvents.x7}`);
    // Serialize round-trip preserves histogram
    const ser = sm.serialize();
    const sm2 = new StatisticsManager(ser);
    test('histogram persists after serialize/load', sm2.lossStreakEvents.x2===2 && sm2.lossStreakEvents.x7===2 && sm2.maxLossStreak===8);
  }

  const passed = results.filter(r => r.pass).length;
  console.log(`\nSelf-test: ${passed}/${results.length} passed`);
  return passed === results.length;
}

// ═══════════════════════════════════════════════════════════════════════
// 12. BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════
function printBanner() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   accuHOLD — memoryless BOOM/CRASH ACCU (v1, DEMO)  ║');
  console.log('║   rate-limited entry · TP + ticks_stayed_in tick-cap ║');
  console.log('║   no timing signal — risk-management default only    ║');
  console.log('║   flags: --selftest  --dry-run                       ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

async function main() {
  printBanner();
  if (process.argv.includes('--selftest')) {
    const ok = await runSelfTest();
    process.exitCode = ok ? 0 : 1;
    return;
  }
  try { require.resolve('ws'); } catch (_) { console.error('npm install ws'); process.exit(1); }
  if (!CONFIG.apiToken) { console.error('API token not set'); process.exit(1); }
  const dry = process.argv.includes('--dry-run');
  if (dry) console.log('🔒 DRY-RUN MODE — would-buy entries logged, no trades placed');
  console.log(CONFIG.telegram.enabled ? '✅ Telegram: ENABLED' : 'ℹ️ Telegram: DISABLED');
  const bot = new AccuHoldBot(CONFIG);
  bot.dryRun = dry;
  await bot.start();
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
