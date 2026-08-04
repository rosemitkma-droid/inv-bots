#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  AccuAPEXnew — APEX engine v4  (conditional-volatility survival)
 * =====================================================================
 *
 *  Single-file Deriv Accumulator (ACCU) trading bot — TEST/DEMO ONLY.
 *
 *  ─ CORE MODEL ─────────────────────────────────────────────────────────
 *  A Deriv Accumulator's barrier is recomputed EVERY tick around the
 *  PREVIOUS spot, so a knockout happens when a *single* tick's move
 *  exceeds the ± barrier. It is NOT cumulative drift from entry.
 *  Per-tick survival is P(|one-tick return| < barrier), and K-tick
 *  survival is that raised to the K-th power (approx. i.i.d.).
 *
 *  Two regime classes:
 *    • BOOM/CRASH — bimodal. The only knockout is a spike; hazard is
 *      lowest just after a spike fires. Enter in the fresh post-spike
 *      window and hold a short, hazard-bounded number of ticks.
 *    • VOL (R_*, 1HZ*V) — near-i.i.d. Enter only during real volatility
 *      compression (current realized σ below the baseline σ the barrier
 *      was priced against), when conditional per-tick survival is
 *      genuinely higher than the price implies.
 *
 *  ─ v4 CHANGES (this file) ────────────────────────────────────────────
 *  Reliability:
 *    • Reconcile open contracts after re-connect (portfolio + detail
 *      reads) so reconnects never orphan a live contract.
 *    • Idempotent settlement (single `result` per contract id) so a
 *      watchdog + stream settling the same contract can't double-count.
 *    • Single-flight entry latch — analysis/buy can't re-enter and
 *      double-buy.
 *    • Hard daily caps (dailyMaxTrades, dailyMaxLoss) that STOP the bot
 *      until next UTC day instead of silently warning.
 *    • Permanent-vs-transient proposal errors: only hard-exclude assets
 *      the API rejects forever; rate-limit/transient errors retry.
 *    • Crash-fast on uncaughtException / unhandledRejection (save state,
 *      then exit so a supervisor can restart cleanly).
 *  Strategy honesty:
 *    • VOL entry gate fixed: compression = σfast/σslow must be ≤
 *      apexVolCompressRatio AND barrier ≥ apexBarrierMinSigma·σfast.
 *      (Old gate compared barrier (a log-price fraction) to σ (a log-
 *      return), a dimensionally dead ratio that left VOL untradeable.)
 *    • Spike hazard gets a conservative upper-confidence haircut; and the
 *      EV/survival floors are no longer loosened for fast-cadence assets
 *      (the noisiest estimates used to get the loosest gates).
 *    • ticksHeld is derived from server tick_count / time, not stream
 *      message count — exits no longer fire early.
 *    • Growth-rate grid now includes 0.01/0.02 (lower rates are the only
 *      credible positive-EV rates on the most volatile R_* indices).
 *    • Expected-vs-realized per-tick survival tally (edgeTally) so the
 *      model is measurable against outcomes in demo.
 *  Operations preserved: Telegram (bounded queue), GMT pause windows,
 *  day-of-week filter, EOD/hourly summaries, atomic state persistence,
 *  reconnect backoff, watchdog, adaptive/kelly sizing.
 *
 *  ─ HONESTY ───────────────────────────────────────────────────────────
 *  Nothing here guarantees profit. The model can be wrong in three ways
 *  the demo run must check: (1) spike gaps may be memoryless (Poisson),
 *  killing the post-spike edge; (2) volatility compression may be priced
 *  correctly, killing the VOL edge; (3) sell-side spread may exceed
 *  pulseSpreadCost. The bot is designed to STAND ASIDE when no edge
 *  clears the gates. Losing is always possible.
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
// 1. .ENV LOADER  (optional; credentials below stay hardcoded per user)
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
// 2. CONFIGURATION  (hardcoded TEST credentials retained per user)
// ═══════════════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
  // ── Deriv API (existing hardcoded CONFIG values — kept in-file) ──
  apiToken:    'pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee',
  appId:       '33uslPtthXBEkQOdfKfoY',
  wsUrl     : 'wss://ws.derivws.com/websockets/v3',
  currency  : 'USD',
  accountType: 'demo',    // 'demo' | 'real'  — keep demo for testing

  // ── Trade parameters ──
  stake          : parseFloat('5.0'),
  stopLoss       : parseFloat('900.0'),   // catastrophic per-contract stop ($)
  dailyMaxLoss   : parseFloat('500'),     // hard daily loss → stop until next UTC day
  dailyMaxTrades : parseInt('6000', 10),    // hard daily trade cap → stop until next UTC day

  // ── Sizing ──
  //   'flat'    — always base stake
  //   'adaptive'— anti-martingale: stake ×0.70 after a loss, ×1.15 after a win,
  //              clamped to [minStakeFraction, maxStakeFraction] × base.
  //   'kelly'   — fractional Kelly from the model EV (fraction of the
  //              gross multiple), clamped to the same bounds.
  sizingModeV3        : 'adaptive',  // 'flat' | 'adaptive' | 'kelly'
  lossStakeReduction  : parseFloat('0.70'),
  winStakeRecovery    : parseFloat('1.15'),
  minStakeFraction    : parseFloat('0.25'),
  maxStakeFraction    : parseFloat('1.50'),
  kellyFraction       : parseFloat('0.20'),

  // ── Assets (Deriv synthetic indices) ──
  assets: ('R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V')
    .split(',').map(s => s.trim()).filter(Boolean),

  // ── Telegram (existing hardcoded CONFIG values — kept in-file) ──
  telegram: {
    enabled : true,
    botToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    chatId  : '752497117',
    maxQueue: parseInt('200', 10),      // drop-oldest bound so a Telegram outage can't OOM
  },

  // ── Strategy timing ──
  tickWindow          : parseInt('200',   10),
  minTicksForAnalysis : parseInt('80',    10),
  analysisIntervalMs  : parseInt('15000', 10),
  tradeCooldownMs     : parseInt('4000',  10),
  maxOpenTrades       : parseInt('1',     10),
  skipRecentTradedSymbols: true,        // don't re-enter the same symbol back-to-back
  recentTradedSymbolsLen : parseInt('2', 10),

  // ── EV / survival gates (per-trade floors; NOT loosened by cadence) ──
  apexMinEV       : parseFloat('0.010'),   // ≥ +1% net EV to fire
  apexMinSurvival : parseFloat('0.95'),    // forward K-tick survival floor
  pulseSpreadCost : parseFloat('0.002'),   // flat spread model (low; see honesty note)
  pulseGrowthRates: [0.05, 0.04, 0.03, 0.02, 0.01], // grid searched by EV (lower rates = looser barrier)

  // ── APEX strategy tunables ──
  // History depth: spike cadence needs ≥2 spike intervals in view.
  apexHistoryWindow    : parseInt('6000', 10),
  apexScaleWindow      : parseInt('150',  10),   // recent window for breach-rate estimate
  apexEwmaFast         : parseFloat('0.30'),
  apexEwmaSlow         : parseFloat('0.03'),
  apexSpikeK           : parseFloat('5.0'),
  apexMinSpikesSeen    : parseInt('2', 10),
  hazardCiZ            : parseFloat('1.28'),    // 80% upper CI on hazard (conservative)

  // ── Post-spike entry (BOOM/CRASH) ──
  apexPostSpikeMin        : parseInt('1', 10),
  apexPostSpikeWindowFrac : parseFloat('0.35'),
  apexMinSpikeSurvival    : parseFloat('0.90'), // (1-hazard)^maxHold floor
  apexMaxHoldBoom         : parseInt('7', 10),

  // ── Vol-compression entry (VOL) ──
  // compression = σfast/σslow must be ≤ apexVolCompressRatio (real compression),
  // AND the barrier must be ≥ apexBarrierMinSigma × σfast (wide enough to matter).
  apexVolCompressRatio : parseFloat('0.90'),
  apexBarrierMinSigma  : parseFloat('2.0'),
  apexCompressionWindow: parseInt('150', 10),   // recent returns used for the breach-rate estimate
  apexMaxHoldVol       : parseInt('10', 10),

  // ── Adaptive exit ──
  apexExitHazard        : parseFloat('0.050'),
  apexExitDriftFrac     : parseFloat('0.75'),
  apexProfitLockFrac    : parseFloat('0.90'),
  apexMinProfitLockFrac : parseFloat('0.025'),

  // ── Per-asset risk (v3) ──
  maxEntriesPerSpikeWindow : parseInt('1', 10),
  assetLossCooldownMs      : parseInt('120000', 10),
  assetMaxConsecutiveLosses: parseInt('3', 10),
  assetPauseDurationMs     : parseInt('600000', 10),
  minWinRateToTrade        : parseFloat('0.38'),
  rollingWindowSize        : parseInt('15', 10),
  sessionMaxDrawdown       : parseFloat('300'),
  maxAssetsTrading         : parseInt('2', 10),
  edgeAfterLossBoost       : parseFloat('0.008'), // EV penalty per consecutive loss

  // ── Correlation haircut ──
  // VOL assets (R_*, 1HZ*V) are near-perfectly correlated; never run two at once.
  volFamilyGroup   : true,
  correlatedGroups : [
    ['BOOM1000', 'BOOM900', 'BOOM600', 'BOOM500', 'BOOM300N', 'BOOM150N', 'BOOM50'],
    ['CRASH1000', 'CRASH900', 'CRASH600', 'CRASH500', 'CRASH1300N', 'CRASH150N', 'CRASH50'],
  ],

  // ── Dynamic asset discovery (off; behind flag) ──
  autoDiscoverAssets  : false,
  discoveryIntervalMs : parseInt('3600000', 10),
  assetFamilyFilter   : ['BOOM', 'CRASH'],

  // ── Reconnect ──
  reconnect: { initialDelayMs: 1000, maxDelayMs: 60000, backoffFactor: 2, jitterMs: 750 },

  // ── Barrier refresh ──
  barrierRefreshMs: parseInt('45000', 10),

  // ── Trade watchdog (sweeps ALL stale open contracts) ──
  tradeWatchdogMs: parseInt('90000', 10),

  // ── Logging / state ──
  logFile           : 'accuAPEXnew_001.log',
  logLevel          : 'INFO',
  stateFile         : 'accuAPEXnew_state_001.json',
  stateSaveOnTrade  : true,
  stateSaveOnShutdown: true,

  // ── Edge measurement (expected vs realized survival) ──
  edgeTallyEnabled : true,

  // ── Scheduled pause/resume (GMT) ──
  pauseEnabled : true,
  pauseStartGmt: '23:00',
  pauseEndGmt  : '01:00',

  // ── Day-of-week filter ──
  tradeSunday: true, tradeMonday: true, tradeTuesday: true,
  tradeWednesday: true, tradeThursday: true, tradeFriday: true, tradeSaturday: true,

  // ── EOD / hourly summaries (GMT) ──
  eodTimeGmt         : '00:00',
  eodSendDelaySeconds: parseInt('10', 10),
  hourlySummary      : true,
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
  }

  _nextReqId() { return ++this._reqId; }

  _url() {
    const sep = this.cfg.wsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.wsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }

  _redact(url) { return url.replace(/([?&])(otp|app_id|token)=[^&]+/g, '$1$2=***').replace(/wss:\/\/[^/]+/, m => m); }

  _openWs(url) {
    try {
      this.ws = new WebSocket(url, { headers: { 'User-Agent': 'AccuAPEXnew/4.0 (+Node.js)' }, handshakeTimeout: 15000 });
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

  async portfolio() {
    const res = await this._send({ portfolio: 1 }, 15000);
    return Array.isArray(res.portfolio?.contracts) ? res.portfolio.contracts : [];
  }

  stop() { this._stopped = true; try { this.ws?.close(); } catch (_) {} }
}

// ═══════════════════════════════════════════════════════════════════════
// 7. MARKET DATA MANAGER  (ticks, history, barriers, stays)
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
    this._unsupportedSymbols = new Set();
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

  cacheBarrier(symbol, growthRate, cd, spot = 0) {
    if (!cd) return;
    const key = `${symbol}:${growthRate}`;
    const spotNum = parseFloat(spot ?? 0);
    // Prefer the exact per-tick barrier % from Deriv; fall back to deriving
    // the ±% from the spot distance, then from the high/low barrier band.
    let halfBarrierPct = parseFloat(cd.tick_size_barrier_percentage || 0);
    if (!halfBarrierPct && spotNum > 0) {
      halfBarrierPct = (parseFloat(cd.barrier_spot_distance || 0) / spotNum) * 100;
    }
    if (!halfBarrierPct && spotNum > 0 && cd.high_barrier && cd.low_barrier) {
      halfBarrierPct = ((parseFloat(cd.high_barrier) - parseFloat(cd.low_barrier)) / 2) / spotNum * 100;
    }
    this._barrierCache.set(key, {
      halfBarrierPct: +halfBarrierPct.toFixed(6),
      highBarrier: parseFloat(cd.high_barrier || 0),
      lowBarrier: parseFloat(cd.low_barrier || 0),
      maxPayout: parseFloat(cd.maximum_payout || 0),
      spotDistance: parseFloat(cd.barrier_spot_distance || 0),
    });
  }

  getBarrier(symbol, growthRate) { return this._barrierCache.get(`${symbol}:${growthRate}`); }

  // Errors that will never resolve on this account — exclude the asset permanently.
  static PERMANENT_ERRORS = new Set([
    'TradingDurationNotAllowed', 'InvalidContractType', 'InvalidSymbol',
    'UnsupportedContract', 'InvalidContract', 'BlockedCurrency',
  ]);

  async refreshBarriers(assets, growthRates) {
    if (this._refreshInFlight || !this.client.authorized) return;
    this._refreshInFlight = true;
    const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
    const fetchOne = async (sym, gr) => {
      const res = await this.client._send({
        proposal: 1, amount: this.cfg.stake, basis: 'stake',
        contract_type: 'ACCU', currency: this.cfg.currency,
        [symbolKey]: sym, growth_rate: gr,
      }, 8000);
      if (res?.proposal?.contract_details) {
        this.cacheBarrier(sym, gr, res.proposal.contract_details, res.proposal.spot);
        this.cacheStays(sym, gr, res.proposal.contract_details);
        return true;
      }
      if (res?.error) {
        const code = res.error.code || '';
        const msg = res.error.message || '';
        if (MarketDataManager.PERMANENT_ERRORS.has(code) || /not offered|does not offer|not available|not supported/i.test(msg)) {
          this._unsupportedSymbols.add(sym);
          logger.info(`refreshBarriers: ${sym} ACCU rejected (${code || msg}) — excluded from this account`);
        } else {
          // transient (rate limit / server hiccup) — will retry on next refresh
          logger.debug(`refreshBarriers(${sym},${gr}) transient: ${code || msg}`);
        }
      }
      return false;
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      const eligible = assets.filter(s => !this._unsupportedSymbols.has(s));
      for (const sym of eligible) {
        for (const gr of growthRates) {
          try { await fetchOne(sym, gr); }
          catch (e) { logger.debug(`refreshBarriers(${sym},${gr}):`, e.message); }
          await sleep(50);
        }
      }
      const hasBarrier = sym => growthRates.some(gr =>
        this._barrierCache.get(`${sym}:${gr}`)?.halfBarrierPct > 0);
      const missing = eligible.filter(sym => !hasBarrier(sym));
      for (const sym of missing) {
        for (const gr of growthRates) {
          if (this._barrierCache.get(`${sym}:${gr}`)?.halfBarrierPct > 0) continue;
          try { await fetchOne(sym, gr); }
          catch (e) { logger.debug(`refreshBarriers retry(${sym},${gr}):`, e.message); }
          await sleep(150);
        }
      }
      const stillMissing = eligible.filter(sym => !hasBarrier(sym));
      if (stillMissing.length) {
        logger.warn(`refreshBarriers: NO usable barrier for ${stillMissing.join(', ')} — those assets will not trade`);
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

  async deepBackfill(symbol, totalCount, batchSize = 5000) {
    const out = [];
    let remain = totalCount;
    let end = 'latest';
    let lastEpoch = null;
    while (remain > 0) {
      const count = Math.min(batchSize, remain);
      let res;
      try {
        res = await this.client._send({ ticks_history: symbol, count, end, style: 'ticks' }, 30000);
      } catch (e) { logger.warn(`deepBackfill(${symbol}) batch failed: ${e.message} — stopping`); break; }
      const prices = res.history?.prices || [];
      const times = res.history?.times || [];
      if (!times.length) { logger.info(`  (server returned 0 more ticks — Deriv history exhausted)`); break; }
      const batch = times.map((t, i) => ({ epoch: +t, quote: parseFloat(prices[i]) }));
      if (lastEpoch !== null && batch[batch.length - 1].epoch >= lastEpoch) {
        logger.info(`  (server did not honor pagination — history exhausted at ${out.length} ticks)`);
        break;
      }
      lastEpoch = batch[0].epoch;
      out.unshift(...batch);
      remain -= batch.length;
      end = String(batch[0].epoch - 1);
      await new Promise(r => setTimeout(r, 200));
      if (batch.length < count) {
        logger.info(`  (last batch short: ${batch.length}/${count} — Deriv history exhausted at ${out.length} ticks)`);
        break;
      }
    }
    return out;
  }

  async discoverAccuAssets() {
    const discovered = [];
    try {
      const res = await this.client._send({ active_symbols: 'full' }, 20000);
      const list = res.active_symbols || [];
      const families = (this.cfg.assetFamilyFilter || []).map(f => f.toUpperCase());
      for (const s of list) {
        const key = (s.underlying_symbol || s.symbol || '').toUpperCase();
        if (!key) continue;
        const market = (s.market || '').toLowerCase();
        const symbolType = (s.symbol_type || '').toLowerCase();
        const isSynth = market === 'synthetic_index' || symbolType === 'synthetic_index';
        if (!isSynth) continue;
        if (families.length > 0) {
          const matchesFamily = families.some(f => key.includes(f));
          if (!matchesFamily) continue;
        }
        discovered.push(key);
      }
      discovered.sort((a, b) => {
        const aBoom = a.includes('BOOM') || a.includes('CRASH') ? 0 : 1;
        const bBoom = b.includes('BOOM') || b.includes('CRASH') ? 0 : 1;
        return aBoom - bBoom || a.localeCompare(b);
      });
      logger.info(`v3: discovered ${discovered.length} ACCU-capable assets: ${discovered.join(', ')}`);
    } catch (e) {
      logger.warn(`v3: asset discovery failed: ${e.message} — using configured list`);
      return this.cfg.assets.slice();
    }
    const merged = new Set([...this.cfg.assets, ...discovered]);
    return [...merged];
  }

  async subscribe(symbol) {
    if (this.subs.has(symbol)) return this.subs.get(symbol);
    const subId = await this.client.subscribe({ ticks: symbol }, msg => {
      const t = msg.tick;
      if (!t) return;
      const tick = { epoch: +t.epoch, quote: parseFloat(t.quote) };
      this.lastQuote.set(symbol, tick.quote);
      const arr = this.history.get(symbol);
      if (arr) {
        arr.push(tick);
        const cap = Math.max(this.cfg.apexHistoryWindow + 500, this.cfg.tickWindow * 8, 2000);
        if (arr.length > cap) this.history.set(symbol, arr.slice(-cap));
      } else this.history.set(symbol, [tick]);
    });
    this.subs.set(symbol, subId);
    return subId;
  }

  async bootstrap(symbols) {
    if (this._bootstrapping) return;
    this._bootstrapping = true;
    try {
      await Promise.all(symbols.map(s => this.subscribe(s).catch(e => logger.warn(`sub(${s}):`, e.message))));
      await Promise.all(symbols.map(async s => {
        const hist = this.history.get(s) || [];
        const want = Math.max(this.cfg.apexHistoryWindow || 6000, this.cfg.tickWindow * 5, 1000);
        if (hist.length < want) {
          const fetched = await this.deepBackfill(s, want, 5000);
          if (fetched && fetched.length) {
            const live = this.history.get(s) || [];
            const lastEpoch = fetched[fetched.length - 1].epoch;
            const tail = live.filter(t => t.epoch > lastEpoch);
            const merged = fetched.concat(tail);
            this.history.set(s, merged);
            if (merged.length) this.lastQuote.set(s, merged[merged.length - 1].quote);
          }
        }
      }));
    } finally { this._bootstrapping = false; }
  }

  historyFor(symbol) { return this.history.get(symbol) || []; }
}

// ═══════════════════════════════════════════════════════════════════════
// 8. SHARED SMALL HELPERS  (pure, testable)
// ═══════════════════════════════════════════════════════════════════════
function regimeClassOf(symbol) {
  const u = String(symbol).toUpperCase();
  if (u.includes('BOOM'))  return 'BOOM';
  if (u.includes('CRASH')) return 'CRASH';
  return 'VOL';
}

// Fractional Kelly stake multiplier for an accumulator entry.
//   netReturnPerStake = expected net return per $1 staked (edge − 1)
//   grossMultiple     = (1+g)^N, the multiple you collect if you survive to N
//   full Kelly = netReturn / (grossMultiple − 1); we take `fraction` of it.
function kellyMultiplier(netReturnPerStake, grossMultiple, fraction) {
  const profitOnWin = grossMultiple - 1;
  if (profitOnWin <= 0 || netReturnPerStake <= 0) return 0;
  return Math.max(0, Math.min(fraction, netReturnPerStake / profitOnWin));
}

// VOL entry gate (pure): real compression AND a barrier wide enough to matter.
function isVolEntryAllowed(compression, barrierSigma, estimated, cfg) {
  if (estimated) return { ok: false, reason: 'no-barrier' };   // never trade a fabricated barrier
  if (!(compression <= cfg.apexVolCompressRatio)) return { ok: false, reason: 'compression-not-low' };
  if (!(barrierSigma >= cfg.apexBarrierMinSigma)) return { ok: false, reason: 'barrier-thin' };
  return { ok: true, reason: 'vol-compressed' };
}

// ═══════════════════════════════════════════════════════════════════════
// 9. APEX ANALYZER  (conditional-volatility survival engine)
// ═══════════════════════════════════════════════════════════════════════
class ApexAnalyzer {
  constructor(cfg) { this.cfg = cfg; }

  // ── pure math helpers (called directly by --selftest) ────────────────
  _logReturns(q) {
    const out = [];
    for (let i = 1; i < q.length; i++) out.push(Math.log(q[i] / q[i - 1]));
    return out;
  }
  _median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  _madScale(returns) {
    const absR = returns.map(Math.abs);
    return Math.max(1.4826 * this._median(absR), 1e-12);
  }
  _ewmaVars(returns, af, as) {
    let fastVar = returns[0] * returns[0];
    let slowVar = fastVar;
    for (let i = 1; i < returns.length; i++) {
      const r2 = returns[i] * returns[i];
      fastVar = af * r2 + (1 - af) * fastVar;
      slowVar = as * r2 + (1 - as) * slowVar;
    }
    return { fastVar, slowVar };
  }
  _spikeStats(returns, spikeThresh, regime) {
    const spikeIdx = [];
    for (let i = 0; i < returns.length; i++) {
      const r = returns[i];
      if (Math.abs(r) < spikeThresh) continue;
      if (regime === 'BOOM'  && r > 0) spikeIdx.push(i);
      else if (regime === 'CRASH' && r < 0) spikeIdx.push(i);
      else if (regime === 'VOL') spikeIdx.push(i);
    }
    let cadence = 0;
    if (spikeIdx.length >= 2) {
      let s = 0;
      for (let k = 1; k < spikeIdx.length; k++) s += spikeIdx[k] - spikeIdx[k - 1];
      cadence = s / (spikeIdx.length - 1);
    }
    const ticksSinceSpike = spikeIdx.length ? (returns.length - 1) - spikeIdx[spikeIdx.length - 1] : Infinity;
    const calmReturns = returns.filter(r => Math.abs(r) <= spikeThresh);
    return { spikesSeen: spikeIdx.length, cadence, ticksSinceSpike, calmReturns };
  }
  // Conservative upper 80% CI on the per-tick spike rate (Poisson-ish).
  _hazardUpperBound(spikesSeen, cadence, nTicks, z = 1.28) {
    if (spikesSeen < this.cfg.apexMinSpikesSeen || cadence <= 0 || nTicks <= 0) return 1;
    const lambda = 1 / cadence;
    const se = Math.sqrt(lambda / nTicks);
    return Math.min(1, lambda + z * se);
  }
  // Choose the compounding horizon K maximizing EV subject to floors.
  _chooseHorizon(growthRate, perTickSurv, spread, maxHold, minSurvival, minEV) {
    let best = { K: 0, ev: -Infinity, edge: -Infinity, surv: 0 };
    let raw = { K: 1, ev: -Infinity, edge: -Infinity, surv: perTickSurv };
    for (let K = 1; K <= maxHold; K++) {
      const surv = Math.pow(perTickSurv, K);
      const edge = Math.pow(1 + growthRate, K) * surv - spread;
      const ev = edge - 1;
      if (edge > raw.edge) raw = { K, ev, edge, surv };
      if (surv >= minSurvival && ev >= minEV && ev > best.ev) best = { K, ev, edge, surv };
    }
    return { best, raw };
  }

  // Barrier per rate: prefer exact; else scale from the reference rate and
  // mark ESTIMATED (never traded on). If neither exists → null (never fabricate).
  _barrierFor(symbol, growthRate, market, refGr) {
    const grBarrier = market ? market.getBarrier(symbol, growthRate) : null;
    if (grBarrier && grBarrier.halfBarrierPct > 0) {
      return { barrierFrac: grBarrier.halfBarrierPct / 100, estimated: false };
    }
    const ref = market ? market.getBarrier(symbol, refGr) : null;
    if (ref && ref.halfBarrierPct > 0) {
      return { barrierFrac: (ref.halfBarrierPct / 100) * (refGr / growthRate), estimated: true };
    }
    return null;
  }

  analyze(symbol, ticks, market, currentSpot = null) {
    return this._analyzeWithRates(symbol, ticks, market, currentSpot, this.cfg.pulseGrowthRates);
  }

  // Live re-analysis during an open trade (single growth rate).
  reanalyze(symbol, ticks, market, currentSpot, growthRate) {
    return this._analyzeWithRates(symbol, ticks, market, currentSpot, [growthRate]);
  }

  _analyzeWithRates(symbol, ticks, market, currentSpot, growthRates) {
    const cfg = this.cfg;
    if (!ticks || ticks.length < cfg.minTicksForAnalysis) return null;
    const q = ticks.map(t => t.quote).filter(v => v > 0);
    if (q.length < 20) return null;
    const returns = this._logReturns(q);
    if (returns.length < 15) return null;

    const price = currentSpot != null && currentSpot > 0 ? currentSpot : q[q.length - 1];
    const regime = regimeClassOf(symbol);

    const scale = this._madScale(returns);
    const spikeThresh = cfg.apexSpikeK * scale;
    const { fastVar, slowVar } = this._ewmaVars(returns, cfg.apexEwmaFast, cfg.apexEwmaSlow);
    const sigmaFast = Math.sqrt(Math.max(fastVar, 1e-24));
    const sigmaSlow = Math.sqrt(Math.max(slowVar, 1e-24));
    const mu = returns.reduce((s, v) => s + v, 0) / returns.length;

    // Volatility compression for the VOL gate: recent realized σ vs the
    // long-horizon baseline σ. Both are robust MAD scales (spike-resistant).
    // An EWMA pair would decay to the CURRENT regime within ~1/α ticks (both
    // fast and slow), making the ratio ~1.0 in steady state and never firing —
    // the old "stops trading" bug. A long-window baseline stays storm-dominated
    // while recent σ drops, so compression < 1 is a genuine signal.
    const sigmaRecent = this._madScale(returns.slice(-cfg.apexCompressionWindow));
    const compression = sigmaRecent / Math.max(scale, 1e-12);

    const sp = this._spikeStats(returns, spikeThresh, regime);
    const hazardRaw = (sp.spikesSeen >= cfg.apexMinSpikesSeen && sp.cadence > 0) ? 1 / sp.cadence : 1;
    const hazardUpper = this._hazardUpperBound(sp.spikesSeen, sp.cadence, returns.length, cfg.hazardCiZ);

    const refGr = cfg.pulseGrowthRates[0] || 0.03;
    const spread = cfg.pulseSpreadCost;
    const minSurvival = cfg.apexMinSurvival;   // fixed floors — not loosened by cadence
    const minEV = cfg.apexMinEV;

    let best = null;
    for (const growthRate of growthRates) {
      const b = this._barrierFor(symbol, growthRate, market, refGr);
      if (!b) continue;                              // no known barrier → skip (never fabricate)
      const { barrierFrac, estimated } = b;
      const logBarrierHalf = Math.log(1 + barrierFrac);
      if (logBarrierHalf <= 0) continue;

      // Per-tick survival = (1 − hazard)·(1 − P(calm breach)).
      // The calm-breach probability is measured over the RECENT window so the
      // survival estimate is conditional on the current regime (compression),
      // which is the whole VOL thesis.
      const recentWindow = Math.max(cfg.apexCompressionWindow, 30);
      const recentReturns = returns.slice(-recentWindow);
      const recentCalm = recentReturns.filter(r => Math.abs(r) <= spikeThresh);
      const breaches = recentCalm.reduce((c, r) => c + (Math.abs(r) >= logBarrierHalf ? 1 : 0), 0);
      const pBreachCalm = recentCalm.length ? breaches / recentCalm.length : 1;

      const hazard = regime === 'VOL' ? 0 : hazardUpper;
      const perTickSurv = Math.max(0, (1 - hazard) * (1 - pBreachCalm));
      if (perTickSurv <= 0) continue;

      // Entry-window + class parameters.
      let maxHold, windowFrac, entryOK = false, entryReason = '';
      if (regime === 'VOL') {
        maxHold = cfg.apexMaxHoldVol;
        windowFrac = 1.0;
        const barrierSigma = barrierFrac / Math.max(sigmaRecent, 1e-12);
        const gate = isVolEntryAllowed(compression, barrierSigma, estimated, cfg);
        if (estimated) { entryOK = false; entryReason = 'no-barrier'; }
        else if (!gate.ok) { entryOK = false; entryReason = gate.reason; }
        else { entryOK = true; entryReason = 'vol-compressed'; }
      } else {
        if (sp.cadence > 0) {
          maxHold = Math.min(cfg.apexMaxHoldBoom, Math.max(3, Math.floor(sp.cadence * 0.12)));
          windowFrac = Math.min(0.50, cfg.apexPostSpikeWindowFrac + (500 / Math.max(sp.cadence, 50)) * 0.05);
        } else {
          maxHold = cfg.apexMaxHoldBoom;
          windowFrac = cfg.apexPostSpikeWindowFrac;
        }
        const cadenceKnown = sp.spikesSeen >= cfg.apexMinSpikesSeen && sp.cadence > 0;
        const freshWindow = sp.ticksSinceSpike >= cfg.apexPostSpikeMin &&
                            sp.ticksSinceSpike <= windowFrac * sp.cadence;
        const spikeSurvivalHold = Math.pow(Math.max(0, 1 - hazard), maxHold);
        const hazardOK = spikeSurvivalHold >= cfg.apexMinSpikeSurvival;
        entryOK = cadenceKnown && freshWindow && hazardOK && !estimated;
        entryReason = estimated       ? 'no-barrier'
                    : !cadenceKnown   ? 'cadence-unknown'
                    : !freshWindow    ? 'not-post-spike'
                    : !hazardOK       ? `hazard-low-surv:${(spikeSurvivalHold*100).toFixed(0)}%`
                    : 'post-spike';
      }

      // EV-optimal horizon.
      const { best: hBest, raw: hRaw } = this._chooseHorizon(growthRate, perTickSurv, spread, maxHold, minSurvival, minEV);
      const chosen = hBest.K > 0;
      const N    = chosen ? hBest.K     : hRaw.K;
      const ev   = chosen ? hBest.ev    : hRaw.ev;
      const edge = chosen ? hBest.edge  : (hRaw.edge === -Infinity ? 0 : hRaw.edge);
      const pN   = chosen ? hBest.surv  : hRaw.surv;

      const evOK   = ev >= minEV;
      const survOK = pN >= minSurvival;
      const candidate = {
        symbol, growthRate, regime: regime.toLowerCase(), regimeClass: regime,
        edge, ev, bestN: N, pN, p1: perTickSurv, perTickSurv,
        hazard: hazardUpper, hazardRaw, pBreachCalm, barrierEstimated: estimated,
        ticksSinceSpike: Number.isFinite(sp.ticksSinceSpike) ? sp.ticksSinceSpike : -1,
        spikeCadence: +sp.cadence.toFixed(1), spikesSeen: sp.spikesSeen,
        sigma: sigmaFast, sigmaFast, sigmaSlow, volRatio: compression, vrRatio: compression, compression,
        barrierSigma: regime === 'VOL' ? barrierFrac / Math.max(sigmaRecent, 1e-12) : 0,
        scale, mu, barrierFrac, logBarrierHalf, price,
        suggestedTakeProfit: Math.max(Math.pow(1 + growthRate, N) - 1, 0.005),
        spreadCost: spread,
        adaptiveMaxHold: maxHold, adaptiveWindowFrac: +windowFrac.toFixed(4),
        spikeSurvivalHold: regime !== 'VOL' ? +Math.pow(Math.max(0, 1 - hazard), maxHold).toFixed(4) : 1,
        entryReason, evOK, survOK, entryOK,
        recommend: chosen && evOK && survOK && entryOK,
      };
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

// ═══════════════════════════════════════════════════════════════════════
// 10. TRADE EXECUTOR  (single writer, idempotent settle, reconciliation)
// ═══════════════════════════════════════════════════════════════════════
const TERMINAL_STATUSES = new Set(['won', 'lost', 'sold', 'cancelled', 'expired', 'refunded']);

class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.open = new Map();            // contractId -> info  (survives reconnects)
    this.analyzer = null;
    this._selling = new Set();
    this._subscriptions = new Map();  // contractId -> subId
    this._settledIds = new Set();     // ids already finalized (idempotency)
  }

  // ── Entry ──────────────────────────────────────────────────────────
  async buy(symbol, growthRate, stake, limit, analysis = null) {
    growthRate = Math.max(0.01, Math.min(0.05, +growthRate.toFixed(4)));
    try {
      const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
      const pres = await this.client._send({
        proposal: 1, amount: stake, basis: 'stake', contract_type: 'ACCU',
        currency: this.cfg.currency, [symbolKey]: symbol, growth_rate: growthRate,
        ...((limit.take_profit != null && limit.take_profit > 0)
          ? { limit_order: { take_profit: limit.take_profit } } : {}),
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
      const halfBarrierPct = entrySpot
        ? (parseFloat(cd.barrier_spot_distance ?? 0) / entrySpot) * 100
        : 0;

      const info = {
        contractId: b.contract_id, symbol, growthRate, stake,
        buyPrice: parseFloat(b.buy_price), payout: parseFloat(b.payout),
        buyTime: b.purchase_time || (Date.now() / 1000),
        limit: { stop_loss: limit.stop_loss ?? null, take_profit: limit.take_profit ?? null },
        contractDetails: cd,
        entrySpot, halfBarrierPct,
        highBarrier: parseFloat(cd.high_barrier ?? 0), lowBarrier: parseFloat(cd.low_barrier ?? 0),
        maxPayout: parseFloat(cd.maximum_payout ?? 0),
        proposalId: p.id,
        balanceAfter: parseFloat(b.balance_after ?? this.client.balance),
        ticksHeld: 0, peakProfit: 0, lastBid: null,
        lastUpdateAt: Date.now(), _exitReason: null,
        _ticksPerSec: this._measureTicksPerSec(symbol),
      };
      if (analysis && typeof analysis === 'object') info._analysis = analysis;

      this.open.set(b.contract_id, info);
      logger.info(
        `barrier: ±${halfBarrierPct.toFixed(4)}% spot=${entrySpot.toFixed(2)} ` +
        `[${(info.lowBarrier).toFixed(2)} … ${(info.highBarrier).toFixed(2)}] maxPayout=${info.maxPayout}`,
      );

      if (this.bot?.market?.cacheStays) {
        this.bot.market.cacheStays(symbol, growthRate, cd);
        if (this.bot.market.cacheBarrier) this.bot.market.cacheBarrier(symbol, growthRate, cd, p.spot);
      }

      await this._attachContractStream(info);
      this.emit('open', info);
      return info;
    } catch (e) {
      logger.error(`buy(${symbol}) failed:`, e.message);
      throw e;
    }
  }

  _measureTicksPerSec(symbol) {
    const hist = this.bot?.market?.historyFor(symbol) || [];
    if (hist.length < 10) return null;
    const window = hist.slice(-50);
    const diffs = [];
    for (let i = 1; i < window.length; i++) {
      const d = window[i].epoch - window[i - 1].epoch;
      if (d > 0 && d < 5000) diffs.push(d);
    }
    if (!diffs.length) return null;
    diffs.sort((a, b) => a - b);
    const med = diffs[diffs.length >> 1];
    return med > 0 ? 1 / med : null;
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
  // Keeps every live contract tracked so a reconnect never orphans one.
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
      growthRate: c.growth_rate != null ? parseFloat(c.growth_rate) : 0.03,
      growthRateEstimated: c.growth_rate == null,
      stake: buyPrice > 0 ? buyPrice : this.cfg.stake,
      buyPrice,
      payout: parseFloat(c.payout ?? 0),
      buyTime: c.purchase_time || c.date_start || (Date.now() / 1000),
      limit: { stop_loss: this.cfg.stopLoss, take_profit: null },
      contractDetails: {},
      entrySpot: parseFloat(c.entry_spot ?? 0), halfBarrierPct: 0,
      highBarrier: 0, lowBarrier: 0, maxPayout: 0,
      ticksHeld: 0, peakProfit: 0, lastBid: null,
      lastUpdateAt: Date.now(), _exitReason: 'reconciled', _analysis: null, _adopted: true,
    };
    this.open.set(cid, info);
    logger.info(`reconcile: adopted open contract #${cid} ${info.symbol}`);
    return info;
  }

  _hydrateInfo(info, oc) {
    if (oc.growth_rate != null) { info.growthRate = parseFloat(oc.growth_rate); info.growthRateEstimated = false; }
    if (oc.symbol || oc.underlying) info.symbol = oc.symbol || oc.underlying;
    if (oc.purchase_time) info.buyTime = oc.purchase_time;
    if (oc.buy_price != null) info.buyPrice = parseFloat(oc.buy_price);
    const cd = oc.contract_details || {};
    const spot = parseFloat(oc.entry_spot ?? cd.current_spot ?? info.entrySpot ?? 0);
    if (spot > 0) info.entrySpot = spot;
    if (oc.tick_size_barrier_percentage != null) info.halfBarrierPct = parseFloat(oc.tick_size_barrier_percentage);
    if (oc.barrier_spot_distance != null && spot > 0) info.halfBarrierPct = (parseFloat(oc.barrier_spot_distance) / spot) * 100;
    if (cd.high_barrier != null) info.highBarrier = parseFloat(cd.high_barrier);
    if (cd.low_barrier != null) info.lowBarrier = parseFloat(cd.low_barrier);
  }

  // ── Adaptive early-exit ────────────────────────────────────────────
  _adaptiveExitDecision(info, currentProfit, currentSpot) {
    const cfg = this.cfg;
    const analysis = info._analysis;
    if (!analysis) return { exit: false, reason: 'no-analysis', urgency: 0 };

    const analyzer = this.bot?.analyzer ?? this.analyzer;
    const market = this.bot?.market ?? null;
    const ticks = market?.historyFor(info.symbol) ?? [];

    let perTickSurv = analysis.perTickSurv ?? analysis.p1 ?? 0.99;
    let hazardLive = analysis.hazard ?? 0;
    let bestEVLive = analysis.ev ?? 0;
    let bestNLive = analysis.bestN ?? 1;

    // Throttle live re-analysis: full 6000-tick MAD/EWMA on every stream
    // update is wasteful; once per second is plenty for an exit decision.
    if (analyzer && ticks.length >= cfg.minTicksForAnalysis && currentSpot > 0 &&
        (Date.now() - (info._lastReanalyzeAt || 0)) >= 1000) {
      info._lastReanalyzeAt = Date.now();
      try {
        const live = analyzer.reanalyze(info.symbol, ticks, market, currentSpot, info.growthRate);
        if (live) {
          perTickSurv = live.perTickSurv ?? perTickSurv;
          hazardLive = live.hazard ?? hazardLive;
          bestEVLive = live.ev ?? bestEVLive;
          bestNLive = live.bestN ?? bestNLive;
        }
      } catch (e) { logger.debug(`reanalyze error #${info.contractId}: ${e.message}`); }
    }

    const ticksHeld = info.ticksHeld ?? 0;
    const stake = info.stake;

    // A: EV-optimal horizon reached.
    const targetReached = ticksHeld >= (analysis.bestN ?? bestNLive);

    // B: profit-lock — absolute floor AND a fraction of expected remaining.
    const lockFrac = cfg.apexProfitLockFrac;
    const expectedRemaining = stake * Math.max(bestEVLive, 0);
    const profitLockThreshold = lockFrac * expectedRemaining;
    const minProfitToLock = stake * cfg.apexMinProfitLockFrac;
    const profitLock = currentProfit >= minProfitToLock && currentProfit >= profitLockThreshold;

    // C: rising spike hazard (Boom/Crash core exit).
    const hazardExit = hazardLive >= cfg.apexExitHazard;

    // D: holding is now EV-negative.
    const nextTickEdge = (1 + info.growthRate) * perTickSurv - cfg.pulseSpreadCost;
    const nextTickExit = nextTickEdge < 1.0;

    // E: near-miss big tick (drift danger).
    let driftExit = false, driftFrac = 0;
    if (ticks.length >= 2) {
      const a = ticks[ticks.length - 2].quote, b = ticks[ticks.length - 1].quote;
      if (a > 0 && b > 0) {
        const step = Math.abs(Math.log(b / a));
        const logBarrierHalf = analysis.logBarrierHalf ?? Math.log(1 + (info.halfBarrierPct ?? 0.05) / 100);
        driftFrac = step / Math.max(logBarrierHalf, 1e-12);
        driftExit = driftFrac >= cfg.apexExitDriftFrac;
      }
    }

    const urgency = Math.max(
      targetReached ? 1 : 0,
      profitLock ? lockFrac : 0,
      hazardExit ? hazardLive * 50 : 0,
      nextTickExit ? 1 - nextTickEdge : 0,
      driftExit ? driftFrac : 0,
    );

    if (targetReached) return { exit: true, reason: `target-reached: held ${ticksHeld} ≥ N*=${analysis.bestN ?? bestNLive}`, urgency };
    if (driftExit) return { exit: true, reason: `drift-danger: last tick used ${(driftFrac*100).toFixed(1)}% of barrier`, urgency };
    if (hazardExit) return { exit: true, reason: `spike-hazard: live hazard ${(hazardLive*100).toFixed(2)}% ≥ ${(cfg.apexExitHazard*100).toFixed(2)}%`, urgency };
    if (profitLock) return { exit: true, reason: `profit-lock: realised ${currentProfit.toFixed(3)} ≥ max(${minProfitToLock.toFixed(3)}, ${lockFrac}×${expectedRemaining.toFixed(3)})`, urgency };
    if (nextTickExit) return { exit: true, reason: `next-tick-edge: (1+g)·surv−spread=${nextTickEdge.toFixed(4)} < 1.0`, urgency };
    return { exit: false, reason: 'hold', urgency };
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
      // ticksHeld: derive from server tick count / time, NOT stream message count
      // (message frequency ≠ tick frequency, and duplicates would over-count).
      const fromServer = (c.tick_count != null && c.tick_count > 0) ? c.tick_count
        : (Array.isArray(c.ticks_stayed_in) ? c.ticks_stayed_in.length : 0);
      const fromTime = (info._ticksPerSec && info.buyTime) ? Math.round((Date.now() / 1000 - info.buyTime) * info._ticksPerSec) : 0;
      info.ticksHeld = Math.max(info.ticksHeld ?? 0, fromServer, fromTime);
      info.peakProfit = Math.max(info.peakProfit ?? 0, profit);
      info.lastUpdateAt = Date.now();
    }
    if (c.bid_price != null) info.lastBid = parseFloat(c.bid_price);

    // Hard stop-loss.
    const stopLossAbs = Math.abs(info.limit?.stop_loss || 0);
    if (status === 'open' && stopLossAbs > 0 && profit <= -stopLossAbs && !this._selling.has(cid)) {
      info._exitReason = 'stop-loss';
      logger.warn(`contract #${cid} hit stop-loss @ profit=${profit.toFixed(2)} ≤ -${stopLossAbs} — selling`);
      this._selling.add(cid);
      this.sell(cid, 0, info).catch(e => logger.error(`emergency sell #${cid} failed:`, e.message))
        .finally(() => this._selling.delete(cid));
      return;
    }

    // Adaptive early-exit.
    if (status === 'open' && !this._selling.has(cid)) {
      const dec = this._adaptiveExitDecision(info, profit, currentSpot);
      if (dec.exit) {
        info._exitReason = dec.reason;
        logger.info(`APEX adaptive exit #${cid}: ${dec.reason} urgency=${dec.urgency.toFixed(3)}`);
        this.emit('driftWarning', { ...info, contractId: cid, profit, currentSpot, dec });
        this._selling.add(cid);
        this.sell(cid, 0, info).catch(e => logger.error(`adaptive sell #${cid} failed:`, e.message))
          .finally(() => this._selling.delete(cid));
        return;
      }
      this.emit('update', { ...info, contractId: cid, profit, currentSpot, status, dec });
      return;
    }

    // Terminal.
    if (TERMINAL_STATUSES.has(status)) {
      const soldFor = parseFloat(c.sell_price ?? 0);
      const terminalProfit = (status === 'sold' && soldFor > 0 && info.buyPrice > 0)
        ? soldFor - parseFloat(info.buyPrice)
        : profit;
      const finalStatus = status === 'sold' ? (terminalProfit >= 0 ? 'won' : 'lost') : status;
      this._finalizeContract(cid, {
        profit: terminalProfit, status: finalStatus, sellPrice: soldFor,
        sellTime: c.sell_time ?? (Date.now() / 1000), currentSpot,
        exitReason: info._exitReason ?? (status === 'lost' ? 'knockout' : status),
      });
    }
  }

  async sell(contractId, minPrice = 0, info = null) {
    try {
      let floor = Number(minPrice) || 0;
      if (info && info.lastBid && info.lastBid > 0 && floor === 0) {
        floor = +(info.lastBid * 0.95).toFixed(2);   // floor = 95% of last live bid
      }
      let sold;
      try {
        const res = await this.client._send({ sell: contractId, price: floor }, 15000);
        sold = res.sell || {};
      } catch (e) {
        // If the floor was rejected, retry with price:0 once as a safety net.
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
        exitReason: info?._exitReason ?? 'manual-sell',
      });
      return sold;
    } catch (e) {
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
// 11. PER-ASSET RISK TRACKER
// ═══════════════════════════════════════════════════════════════════════
class PerAssetTracker {
  constructor(cfg) {
    this.cfg = cfg;
    this.assets = new Map();
    this.sessionPnl = 0;
    this.sessionPeakPnl = 0;
    this.sessionHalted = false;
    this.sessionHaltReason = '';
    this.activeAssets = new Set();
  }

  _getAsset(symbol) {
    if (!this.assets.has(symbol)) {
      this.assets.set(symbol, {
        symbol,
        lastSpikeEpoch: 0, entriesInWindow: 0,
        consecutiveLosses: 0, cooldownUntil: 0, pausedUntil: 0,
        recentResults: [], rollingWins: 0, rollingLosses: 0, rollingWinRate: 0.5,
        totalTrades: 0, totalPnl: 0, adaptiveStake: null,
      });
    }
    return this.assets.get(symbol);
  }

  // Called every analysis cycle. Returns { allowed, reason, adjustedEv }.
  checkEntry(symbol, rawEv, currentSpikeEpoch) {
    const a = this._getAsset(symbol);
    const now = Date.now();

    if (this.sessionHalted) {
      return { allowed: false, reason: `session-halted: ${this.sessionHaltReason}`, adjustedEv: rawEv };
    }
    if (a.pausedUntil > now) {
      const s = ((a.pausedUntil - now) / 1000).toFixed(0);
      return { allowed: false, reason: `asset-paused: ${s}s left (${a.consecutiveLosses} consecutive losses)`, adjustedEv: rawEv };
    }
    if (a.cooldownUntil > now) {
      const s = ((a.cooldownUntil - now) / 1000).toFixed(0);
      return { allowed: false, reason: `loss-cooldown: ${s}s left`, adjustedEv: rawEv };
    }

    // Spike-window entry limit (spike-driven assets only; VOL passes -1 and is exempt).
    if (currentSpikeEpoch > 0) {
      if (a.lastSpikeEpoch > 0 && currentSpikeEpoch > a.lastSpikeEpoch) {
        a.lastSpikeEpoch = currentSpikeEpoch;
        a.entriesInWindow = 0;
      }
      if (a.lastSpikeEpoch === 0) a.lastSpikeEpoch = currentSpikeEpoch;
      if (a.entriesInWindow >= this.cfg.maxEntriesPerSpikeWindow) {
        return { allowed: false, reason: `window-limit: ${a.entriesInWindow}/${this.cfg.maxEntriesPerSpikeWindow} entries in current window`, adjustedEv: rawEv };
      }
    }

    if (a.totalTrades >= this.cfg.rollingWindowSize && a.rollingWinRate < this.cfg.minWinRateToTrade) {
      return { allowed: false, reason: `low-winrate: ${(a.rollingWinRate*100).toFixed(1)}% < ${(this.cfg.minWinRateToTrade*100).toFixed(0)}%`, adjustedEv: rawEv };
    }

    // EV penalty after consecutive losses (require higher EV to re-enter).
    let adjustedEv = rawEv;
    if (a.consecutiveLosses > 0) {
      const penalty = a.consecutiveLosses * this.cfg.edgeAfterLossBoost;
      adjustedEv = rawEv - penalty;
      if (adjustedEv < this.cfg.apexMinEV) {
        return { allowed: false, reason: `edge-reduced: ${(rawEv*100).toFixed(2)}% - ${(penalty*100).toFixed(2)}% = ${(adjustedEv*100).toFixed(2)}% < ${(this.cfg.apexMinEV*100).toFixed(2)}%`, adjustedEv };
      }
    }

    this._updateSessionDrawdown();
    if (this.sessionHalted) {
      return { allowed: false, reason: `session-halt: drawdown ${(this.sessionPnl - this.sessionPeakPnl).toFixed(2)} exceeded limit`, adjustedEv: rawEv };
    }
    return { allowed: true, reason: 'ok', adjustedEv };
  }

  onTradeOpen(symbol) {
    const a = this._getAsset(symbol);
    a.entriesInWindow++;
    a.totalTrades++;
    this.activeAssets.add(symbol);
  }

  onTradeResult(symbol, won, pnl) {
    const a = this._getAsset(symbol);
    const now = Date.now();
    this.activeAssets.delete(symbol);
    this.sessionPnl += pnl;
    if (this.sessionPnl > this.sessionPeakPnl) this.sessionPeakPnl = this.sessionPnl;
    a.totalPnl += pnl;
    a.recentResults.push({ won, pnl, ts: now });
    if (a.recentResults.length > this.cfg.rollingWindowSize) a.recentResults.shift();
    a.rollingWins = a.recentResults.filter(r => r.won).length;
    a.rollingLosses = a.recentResults.length - a.rollingWins;
    a.rollingWinRate = a.recentResults.length > 0 ? a.rollingWins / a.recentResults.length : 0.5;

    if (won) {
      a.consecutiveLosses = 0;
      a.cooldownUntil = 0;
    } else {
      a.consecutiveLosses++;
      a.cooldownUntil = now + this.cfg.assetLossCooldownMs;
      if (a.consecutiveLosses >= this.cfg.assetMaxConsecutiveLosses) {
        a.pausedUntil = now + this.cfg.assetPauseDurationMs;
        logger.warn(
          `PerAsset: ${symbol} PAUSED for ${(this.cfg.assetPauseDurationMs/1000).toFixed(0)}s ` +
          `after ${a.consecutiveLosses} consecutive losses (WR: ${(a.rollingWinRate*100).toFixed(1)}%)`,
        );
      }
    }
  }

  getAdaptiveStake(symbol, baseStake) {
    const a = this._getAsset(symbol);
    const floor = baseStake * this.cfg.minStakeFraction;
    const ceiling = baseStake * this.cfg.maxStakeFraction;
    let stake = a.adaptiveStake ?? baseStake;
    return +Math.max(floor, Math.min(ceiling, stake)).toFixed(2);
  }

  updateStakeAfterResult(symbol, won, currentStake, baseStake) {
    const a = this._getAsset(symbol);
    const newStake = won
      ? currentStake * this.cfg.winStakeRecovery
      : currentStake * this.cfg.lossStakeReduction;
    const floor = baseStake * this.cfg.minStakeFraction;
    const ceiling = baseStake * this.cfg.maxStakeFraction;
    a.adaptiveStake = Math.max(floor, Math.min(ceiling, newStake));
  }

  _updateSessionDrawdown() {
    const dd = this.sessionPeakPnl - this.sessionPnl;
    if (dd >= this.cfg.sessionMaxDrawdown && !this.sessionHalted) {
      this.sessionHalted = true;
      this.sessionHaltReason = `drawdown ${dd.toFixed(2)} >= ${this.cfg.sessionMaxDrawdown}`;
      logger.error(`SESSION HALTED: ${this.sessionHaltReason}`);
    }
  }

  isCorrelated(symbol) {
    const groups = this.cfg.correlatedGroups || [];
    const actives = Array.from(this.activeAssets);
    const upper = symbol.toUpperCase();
    for (const group of groups) {
      const g = group.map(s => s.toUpperCase());
      if (!g.includes(upper)) continue;
      if (actives.some(a => a !== symbol && g.includes(a.toUpperCase()))) return true;
    }
    // The whole VOL family (R_*, 1HZ*V) is near-perfectly correlated — at most one open.
    if (this.cfg.volFamilyGroup && regimeClassOf(symbol) === 'VOL') {
      if (actives.some(a => a !== symbol && regimeClassOf(a) === 'VOL')) return true;
    }
    return false;
  }

  activeCount() { return this.activeAssets.size; }

  resetSession() {
    this.sessionPnl = 0;
    this.sessionPeakPnl = 0;
    this.sessionHalted = false;
    this.sessionHaltReason = '';
    this.activeAssets.clear();
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

// ═══════════════════════════════════════════════════════════════════════
// 12. STATISTICS MANAGER  (+ expected-vs-realized edge tally)
// ═══════════════════════════════════════════════════════════════════════
const utcDateStr = (d = new Date()) => d.toISOString().slice(0, 10);
const utcHour = (d = new Date()) => d.getUTCHours();
const money = (n, c = CONFIG.currency) => `${n >= 0 ? '+' : ''}${Number(n || 0).toFixed(2)} ${c}`;

class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.dailySummaries = {};
    this.overallProfit = 0;
    this.currentLossStreak = 0;
    this.maxLossStreak = 0;
    this.lossStreakEvents = { x2: 0, x3: 0, x4: 0 };
    this.eodSentDates = [];
    this.edgeTally = { entries: 0, modelP1Sum: 0, heldSum: 0, survivedSum: 0, losses: 0, knockouts: 0, earlyExits: 0 };
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
    if (s.edgeTally) this.edgeTally = { ...this.edgeTally, ...s.edgeTally };
  }

  serialize() {
    return {
      trades: this.trades.slice(-5000), dailySummaries: this.dailySummaries,
      overallProfit: this.overallProfit, currentLossStreak: this.currentLossStreak,
      maxLossStreak: this.maxLossStreak, lossStreakEvents: this.lossStreakEvents,
      eodSentDates: this.eodSentDates.slice(-400), edgeTally: this.edgeTally,
    };
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
    } else if (rec.status === 'won') {
      this.currentLossStreak = 0;
    }
    return rec;
  }

  // Expected-vs-realized per-tick survival. If realized < model p1 on a
  // meaningful sample, the model is overstating survival → edge is illusory.
  recordEdge(trade) {
    const a = trade._analysis;
    if (!a || !CONFIG.edgeTallyEnabled) return;
    this.edgeTally.entries++;
    this.edgeTally.modelP1Sum += (a.perTickSurv ?? a.p1 ?? 0);
    const held = trade.ticksHeld ?? 0;
    this.edgeTally.heldSum += held;
    this.edgeTally.survivedSum += held - (trade.status === 'lost' ? 1 : 0);
    if (trade.status === 'lost') this.edgeTally.losses++;
    const r = (trade.exitReason || '').toLowerCase();
    if (r.startsWith('knockout')) this.edgeTally.knockouts++;
    else if (r && r !== 'unknown' && r !== 'manual-sell') this.edgeTally.earlyExits++;
  }

  edgeTallyLine() {
    const t = this.edgeTally;
    if (!t.entries) return null;
    const modelP1 = t.entries ? (t.modelP1Sum / t.entries) : 0;
    const realized = t.heldSum ? (t.survivedSum / t.heldSum) : 0;
    return `Model p1 avg ${(modelP1*100).toFixed(2)}% vs realized per-tick survival ${(realized*100).toFixed(2)}% ` +
           `over ${t.entries} trades (${t.heldSum} ticks held; ${t.knockouts} knockouts, ${t.earlyExits} early exits)`;
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
// 13. TRADING BOT  (orchestrator)
// ═══════════════════════════════════════════════════════════════════════
class AccuAPEXnewBot {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = new DerivClient(cfg);
    this.market = new MarketDataManager(this.client, cfg);
    this.analyzer = new ApexAnalyzer(cfg);
    this.exec = new TradeExecutor(this.client, cfg);
    this.exec.bot = this;
    this.exec.market = this.market;
    this.stats = new StatisticsManager();
    this.assetTracker = new PerAssetTracker(cfg);

    this.stopped = false;
    this.startBalance = null;
    this.lastBalance = null;
    this.lastTradeAt = 0;
    this.overallProfit = 0;
    this.dryRun = false;
    this._bootedOnce = false;
    this._tradeInFlight = false;
    this._dailyStopUntil = 0;
    this._dailyStopNotified = false;
    this._lastDayISODate = null;

    this._analysisT = null;
    this._hourlyT = null;
    this._eodBoot = null;
    this._barrierT = null;
    this._watchdogT = null;
    this._discoveryT = null;
    this.paused = false;
    this._pauseStartTimer = null;
    this._pauseEndTimer = null;
    this.lastTradedSymbols = [];
  }

  async start() {
    logger.info('═══════════════════════════════════════════');
    logger.info('  AccuAPEXnew v4 — APEX Strategy (TEST/DEMO)');
    logger.info('═══════════════════════════════════════════');
    logger.info(`assets: ${this.cfg.assets.join(', ')}`);

    if (!this.cfg.apiToken) { logger.error('API token missing'); process.exit(1); }

    this.client.on('authorized', info => this._onAuthorized(info));
    this.client.on('close', () => this._onDisconnected());
    this.exec.on('open', t => this._onTradeOpen(t));
    this.exec.on('result', t => this._onTradeResult(t));

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
    // Crash-fast: save state, then exit so a supervisor can restart cleanly.
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

  // ── Pause helpers ───────────────────────────────────────────────
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
    const end = this._parsePauseTime(this.cfg.pauseEndGmt);
    if (!start || !end) { logger.warn('pause schedule: invalid pauseStartGmt or pauseEndGmt format'); return; }
    const startMin = start.h * 60 + start.min;
    const endMin = end.h * 60 + end.min;

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
      telegram.send(`▶️ <b>TRADING RESUMED</b>\nOverall Profit: ${money(this.overallProfit, this.currencyStr())}`);
      const start = this._parsePauseTime(this.cfg.pauseStartGmt);
      if (start) this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), this._msToTarget(start.h, start.min));
    }
  }
  _isTradingAllowedToday() {
    const dayOfWeek = new Date().getUTCDay();
    const daySettings = [this.cfg.tradeSunday, this.cfg.tradeMonday, this.cfg.tradeTuesday, this.cfg.tradeWednesday, this.cfg.tradeThursday, this.cfg.tradeFriday, this.cfg.tradeSaturday];
    if (!daySettings[dayOfWeek]) return false;
    return true;
  }
  _checkDayChange() {
    const today = utcDateStr();
    if (this._lastDayISODate && this._lastDayISODate !== today) {
      logger.info(`new day detected: ${this._lastDayISODate} → ${today}`);
      this.assetTracker.resetSession();
      this._dailyStopUntil = 0;
      this._dailyStopNotified = false;
      telegram.send(`📅 <b>New trade day: ${today}</b>\nOverall Profit: ${money(this.overallProfit, this.currencyStr())}`);
    }
    this._lastDayISODate = today;
  }

  // ── Authorised ──────────────────────────────────────────────────
  async _onAuthorized(info) {
    // Only set startBalance once (a reconnect must not reset the EOD delta).
    if (this.startBalance == null) this.startBalance = this.balance ?? this.client.balance;
    this.lastBalance = this.startBalance;

    if (!this._bootedOnce) {
      this._bootedOnce = true;
      telegram.send(
        `<b>APEX v4 Bot Online</b>${this.dryRun ? ' <b>🔒 DRY-RUN</b>' : ''}\n\n` +
        `<b>Account:</b> ${info.loginid}\n` +
        `<b>Type:</b> ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
        `<b>Balance:</b> ${(this.startBalance ?? 0).toFixed(2)} ${this.currencyStr()}\n` +
        `<b>Assets:</b> ${this.cfg.assets.length}\n` +
        `<b>Stake:</b> ${this.cfg.stake} · Sizing: ${this.cfg.sizingModeV3}\n` +
        `<b>Growth rates:</b> ${this.cfg.pulseGrowthRates.map(g => (g*100).toFixed(0)+'%').join(', ')}\n` +
        `<b>Min EV:</b> ${(this.cfg.apexMinEV*100).toFixed(1)}% · Min survival: ${(this.cfg.apexMinSurvival*100).toFixed(1)}%\n` +
        `<b>Daily caps:</b> ${this.cfg.dailyMaxTrades} trades / ${this.cfg.dailyMaxLoss} ${this.currencyStr()}\n` +
        `<b>Overall Profit:</b> ${money(this.overallProfit, this.currencyStr())}`,
      );
    } else {
      telegram.send(`🔄 <b>Reconnected</b> (${info.loginid}, ${info.isVirtual ? 'DEMO' : 'REAL'})`);
    }

    try {
      await Promise.all([
        this.market.loadSymbols(),
        this.market.bootstrap(this.cfg.assets),
        this._refreshBarriers(),
      ]);
    } catch (e) {
      logger.warn('post-auth init:', e.message);
    }

    if (this.cfg.autoDiscoverAssets) {
      try {
        const discovered = await this.market.discoverAccuAssets();
        const newAssets = discovered.filter(a => !this.cfg.assets.includes(a));
        if (newAssets.length) {
          for (const a of newAssets) this.cfg.assets.push(a);
          await this.market.bootstrap(newAssets);
          await this._refreshBarriers();
          telegram.send(`<b>v3: New Assets Discovered</b>\nAdded: ${newAssets.join(', ')}`);
        }
      } catch (e) { logger.warn(`v3: asset discovery error: ${e.message}`); }
      if (this._discoveryT) clearInterval(this._discoveryT);
      this._discoveryT = setInterval(async () => {
        try {
          const discovered = await this.market.discoverAccuAssets();
          const newAssets = discovered.filter(a => !this.cfg.assets.includes(a));
          if (newAssets.length) {
            for (const a of newAssets) this.cfg.assets.push(a);
            await this.market.bootstrap(newAssets);
            await this._refreshBarriers();
          }
        } catch (e) { logger.debug(`v3: periodic discovery error: ${e.message}`); }
      }, this.cfg.discoveryIntervalMs);
    }

    // Reconcile any contracts that were open across the disconnect, then
    // start the timers. Idempotent: safe to run on every re-auth.
    try { await this.exec.reconcileOpenContracts(); }
    catch (e) { logger.warn('reconcile:', e.message); }

    this._schedulePause();
    if (this._analysisT) clearInterval(this._analysisT);
    this._analysisT = setInterval(() => this._analyzeAndTrade(), this.cfg.analysisIntervalMs);
    if (this._barrierT) clearInterval(this._barrierT);
    this._barrierT = setInterval(() => this._refreshBarriers(), this.cfg.barrierRefreshMs);
    this._startWatchdog();
    this._analyzeAndTrade();
  }

  async _onDisconnected() {
    this._clearWatchdog();
    this._clearPauseTimers();
    telegram.send(`⚠️ <b>Connection lost</b> — reconnecting…`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    // NOTE: this.exec.open is intentionally KEPT — contracts are still live
    // server-side. reconcileOpenContracts() re-attaches them after re-auth.
    // Sub bookkeeping dies with the socket; clear it so no stale forgets.
    this.exec._subscriptions.clear();
    this.market.subs.clear();
  }

  // ── Trade callbacks ─────────────────────────────────────────────
  _onTradeOpen(t) {
    const a = t._analysis || {};
    const sizingLine = a.sizingMode === 'adaptive'
      ? `<b>Sizing:</b> Adaptive (${t.stake.toFixed(2)} ${this.currencyStr()}) | Base: ${(a.baseStake ?? this.cfg.stake).toFixed(2)}\n`
      : a.sizingMode === 'kelly'
        ? `<b>Sizing:</b> Kelly (${t.stake.toFixed(2)} ${this.currencyStr()}) | Base: ${(a.baseStake ?? this.cfg.stake).toFixed(2)}\n`
        : '';
    const msg =
      `<b>APEX v4 TRADE OPENED</b>\n\n` +
      `<b>Contract:</b> #${t.contractId}\n` +
      `<b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth Rate:</b> ${(t.growthRate*100).toFixed(2)}%\n` +
      `<b>Stake:</b> ${t.stake.toFixed(2)} ${this.currencyStr()}\n` +
      sizingLine +
      `<b>Take Profit:</b> ${t.limit?.take_profit ?? '–'}\n` +
      `<b>Overall Profit:</b> ${money(this.overallProfit, this.currencyStr())}\n\n` +
      `<b>APEX Analysis</b>\n` +
      `• Regime: ${a.regimeClass ?? '?'} (${a.entryReason ?? '?'})\n` +
      `• EV: ${((a.ev ?? 0)*100).toFixed(2)}% · N*: ${a.bestN ?? '?'} ticks\n` +
      `• Survival pN: ${((a.pN ?? 0)*100).toFixed(2)}%  (per-tick ${((a.perTickSurv ?? 0)*100).toFixed(2)}%)\n` +
      `• Spike hazard: ${((a.hazard ?? 0)*100).toFixed(2)}%  cadence≈${a.spikeCadence ?? '?'}  since=${a.ticksSinceSpike ?? '?'}\n` +
      `• Compression σf/σs: ${(a.volRatio ?? 0).toFixed(2)}  barrier=±${((a.barrierFrac ?? 0)*100).toFixed(4)}%`;
    telegram.send(msg);
  }

  _onTradeResult(t) {
    this.tradeStartTime = null;
    const rec = this.stats.record(t);
    if (CONFIG.edgeTallyEnabled) this.stats.recordEdge(t);
    const emoji = t.status === 'won' ? '✅' : '❌';
    const label = t.status === 'won' ? 'WIN' : 'LOSS';
    this.lastBalance = (this.lastBalance ?? this.balance ?? 0) + t.profit;
    this.overallProfit += t.profit;

    const won = t.status === 'won';
    this.assetTracker.onTradeResult(t.symbol, won, t.profit);
    if (this.cfg.sizingModeV3 === 'adaptive') {
      this.assetTracker.updateStakeAfterResult(t.symbol, won, this.assetTracker.getAdaptiveStake(t.symbol, this.cfg.stake), this.cfg.stake);
    }

    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));
    const assetState = this.assetTracker._getAsset(t.symbol);
    const msg =
      `${emoji} <b>APEX TRADE ${label}</b>\n\n` +
      `<b>Contract:</b> #${t.contractId} · <b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth:</b> ${(t.growthRate*100).toFixed(0)}% · <b>Stake:</b> ${Number(t.stake).toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Sell:</b> ${Number(t.sellPrice ?? 0).toFixed(2)} ${this.currencyStr()}\n` +
      `${t.profit >= 0 ? '💚' : '💔'} <b>Profit:</b> ${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Exit:</b> ${t.exitReason || 'n/a'}\n` +
      `<b>Balance:</b> ${(this.lastBalance ?? 0).toFixed(2)} ${this.currencyStr()}\n\n` +
      `<b>Asset (${t.symbol}):</b> WR=${(assetState.rollingWinRate*100).toFixed(0)}% (${assetState.recentResults.length}) | Losses: ${assetState.consecutiveLosses}\n` +
      `<b>Session P/L:</b> ${money(this.assetTracker.sessionPnl, this.currencyStr())}\n\n` +
      `<b>GMT Day Stats (${rec.date})</b>\n` +
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses}) | WR ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net P/L: ${money(todayStats.totalProfit, this.currencyStr())} | PF ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n` +
      `<b>Overall:</b> ${money(this.overallProfit, this.currencyStr())}\n` +
      `<b>Consecutive Losses:</b> ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}`;
    telegram.send(msg);
    this.lastTradeAt = Date.now();
    this._saveState('after-trade');
  }

  // ── Main strategy loop ──────────────────────────────────────────
  _computeStake(symbol, analysis) {
    const base = this.cfg.stake;
    const lo = base * this.cfg.minStakeFraction;
    const hi = base * this.cfg.maxStakeFraction;
    if (this.cfg.sizingModeV3 === 'kelly') {
      const gross = Math.pow(1 + analysis.growthRate, analysis.bestN);
      const mult = kellyMultiplier((analysis.edge ?? 1) - 1, gross, this.cfg.kellyFraction);
      return +Math.max(lo, Math.min(hi, base * mult)).toFixed(2);
    }
    if (this.cfg.sizingModeV3 === 'flat') return +base.toFixed(2);
    return this.assetTracker.getAdaptiveStake(symbol, base);   // adaptive
  }

  async _analyzeAndTrade() {
    if (this._tradeInFlight) return;                 // single-flight: never double-buy
    this._tradeInFlight = true;
    try {
      if (this.stopped) return;
      if (!this.client.authorized) return;
      if (this.paused) { logger.debug('trading paused — skipping analysis cycle'); return; }
      if (!this._isTradingAllowedToday()) return;
      this._checkDayChange();

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

      if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
      if (this.exec.count() >= this.cfg.maxOpenTrades) return;
      if (this.assetTracker.sessionHalted) return;
      if (this.assetTracker.activeCount() >= this.cfg.maxAssetsTrading) return;

      const tradeable = this.cfg.assets.filter(
        s => !(this.market._unsupportedSymbols && this.market._unsupportedSymbols.has(s)),
      );
      const analyses = tradeable.map(s => this.analyzer.analyze(s, this.market.historyFor(s), this.market));
      const ranked = this.analyzer.rank(analyses);
      const candidates = ranked.filter(a => a.recommend);

      if (!candidates.length) {
        if (ranked.length) {
          const b = ranked[0];
          const fails = [
            b.evOK ? '' : `ev<${(this.cfg.apexMinEV*100).toFixed(1)}%`,
            b.survOK ? '' : `surv<${(this.cfg.apexMinSurvival*100).toFixed(1)}%`,
            b.entryOK ? '' : `window:${b.entryReason}`,
          ].filter(Boolean).join(',');
          logger.info(
            `scan: best=${b.symbol} [${b.regimeClass}] g=${(b.growthRate*100).toFixed(0)}% ` +
            `ev=${(b.ev*100).toFixed(2)}% N*=${b.bestN} pN=${(b.pN*100).toFixed(1)}% — [${fails}] no trade`,
          );
        }
        return;
      }

      // Try each recommendable candidate in rank order through the risk gates.
      let chosen = null;
      for (const cand of candidates) {
        if (this.cfg.skipRecentTradedSymbols && this.lastTradedSymbols.includes(cand.symbol)) {
          logger.debug(`recently traded ${cand.symbol} — skipping`);
          continue;
        }
        if (this.assetTracker.isCorrelated(cand.symbol)) {
          logger.debug(`v3: skipping ${cand.symbol} — correlated with active asset`);
          continue;
        }
        const check = this.assetTracker.checkEntry(cand.symbol, cand.ev, cand.ticksSinceSpike);
        if (!check.allowed) {
          logger.info(`v3: ${cand.symbol} BLOCKED — ${check.reason}`);
          continue;
        }
        chosen = cand;
        break;
      }
      if (!chosen) { logger.debug('v3: no candidate passed per-asset risk gates'); return; }

      this.lastTradedSymbols.push(chosen.symbol);
      if (this.lastTradedSymbols.length > this.cfg.recentTradedSymbolsLen) this.lastTradedSymbols.shift();

      logger.info(
        `APEX ENTER ${chosen.symbol} [${chosen.regimeClass}:${chosen.entryReason}] g=${(chosen.growthRate*100).toFixed(0)}% ` +
        `ev=${(chosen.ev*100).toFixed(2)}% N*=${chosen.bestN} pN=${(chosen.pN*100).toFixed(1)}% ` +
        `hazard=${(chosen.hazard*100).toFixed(2)}% sinceSpike=${chosen.ticksSinceSpike} cadence=${chosen.spikeCadence} ` +
        `compression=${chosen.compression.toFixed(3)}`,
      );

      const baseStake = this.cfg.stake;
      const stake = this._computeStake(chosen.symbol, chosen);
      const takeProfit = +(stake * chosen.suggestedTakeProfit).toFixed(2);
      const stopLoss = this.cfg.stopLoss;

      const analysis = {
        edge: chosen.edge, ev: chosen.ev, bestN: chosen.bestN,
        pN: chosen.pN, p1: chosen.p1, regime: chosen.regime, regimeClass: chosen.regimeClass,
        entryReason: chosen.entryReason, perTickSurv: chosen.perTickSurv,
        hazard: chosen.hazard, ticksSinceSpike: chosen.ticksSinceSpike,
        spikeCadence: chosen.spikeCadence, volRatio: chosen.compression,
        barrierFrac: chosen.barrierFrac, logBarrierHalf: chosen.logBarrierHalf,
        growthRate: chosen.growthRate,
        sizingMode: this.cfg.sizingModeV3,
        adaptiveStake: stake, baseStake,
        rollingWinRate: this.assetTracker._getAsset(chosen.symbol).rollingWinRate,
        assetLosses: this.assetTracker._getAsset(chosen.symbol).consecutiveLosses,
        sessionPnl: this.assetTracker.sessionPnl,
      };

      // DRY-RUN: log the would-be entry and stand aside. Validates the full
      // live pipeline (auth, backfill, barriers, analyzer, risk gates) with
      // zero market exposure — the recommended first test.
      if (this.dryRun) {
        logger.info(
          `DRY-RUN WOULD ENTER ${chosen.symbol} [${chosen.regimeClass}:${chosen.entryReason}] ` +
          `g=${chosen.growthRate} stake=${stake} tp=${takeProfit} ev=${(analysis.ev*100).toFixed(2)}% N*=${analysis.bestN}`,
        );
        return;
      }

      const trade = await this.exec.buy(
        chosen.symbol, chosen.growthRate, stake,
        { stop_loss: stopLoss, take_profit: takeProfit }, analysis,
      );

      // Only count the entry AFTER the buy succeeds (bookkeeping matches reality).
      this.assetTracker.onTradeOpen(chosen.symbol);
      logger.info(
        `trade placed #${trade.contractId} ${chosen.symbol} g=${chosen.growthRate} ` +
        `stake=${stake} (${this.cfg.sizingModeV3}) tp=${takeProfit} barrier=±${trade.halfBarrierPct.toFixed(4)}%`,
      );
    } catch (e) {
      logger.error('APEX analyse/trade error:', e.message);
    } finally {
      this._tradeInFlight = false;
    }
  }

  async _refreshBarriers() {
    try {
      if (!this.client.authorized) return;
      await this.market.refreshBarriers(this.cfg.assets, this.cfg.pulseGrowthRates);
      logger.debug('barrier cache refreshed');
    } catch (e) {
      logger.debug('barrier refresh error:', e.message);
    }
  }

  // ── Watchdog (sweeps ALL stale open contracts) ──────────────────
  _startWatchdog() {
    this._clearWatchdog();
    this._watchdogT = setInterval(() => {
      const now = Date.now();
      for (const info of this.exec.openTrades()) {
        if (now - info.lastUpdateAt > this.cfg.tradeWatchdogMs) {
          logger.warn(`watchdog: #${info.contractId} stale ${((now - info.lastUpdateAt)/1000).toFixed(0)}s`);
          // Sell if we can; ALWAYS free the slot via forceSettle if not.
          this.exec.sell(info.contractId, 0, info).catch(
            () => this.exec.forceSettle(info.contractId, 'watchdog-sell-failed'),
          );
        }
      }
    }, this.cfg.tradeWatchdogMs / 2);
  }
  _clearWatchdog() { if (this._watchdogT) { clearInterval(this._watchdogT); this._watchdogT = null; } }

  // ── Summaries ───────────────────────────────────────────────────
  _sendHourly() {
    const now = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const date = utcDateStr(prev), hour = utcHour(prev);
    const list = this.stats.tradesForHour(date, hour);
    const s = this.stats.stats(list);
    const tally = this.stats.edgeTallyLine();
    if (!list.length) {
      telegram.send(`⏰ <b>${date} ${pad(hour)}:00</b> — No trades\n💼 Overall: ${money(this.stats.overallProfit, this.currencyStr())}`);
      return;
    }
    let msg = `⏰ <b>${date} ${pad(hour)}:00</b>\n\n📊 ${s.count} trades (✅${s.wins} ❌${s.losses})\n📈 WR: ${s.winRate.toFixed(1)}%\n💰 P/L: <b>${money(s.totalProfit, this.currencyStr())}</b>\n💼 Overall: <b>${money(this.stats.overallProfit, this.currencyStr())}</b>\n`;
    if (tally) msg += `\n🧪 ${tally}\n`;
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
    const tally = this.stats.edgeTallyLine();
    let msg = `🌙 <b>DAILY REPORT — ${date}</b>\n\n`;
    if (ds.count) msg += `📊 ${ds.count} trades (✅${ds.wins} ❌${ds.losses}) | WR ${ds.winRate.toFixed(1)}%\n💰 Net: <b>${money(ds.totalProfit, this.currencyStr())}</b> | PF ${ds.profitFactor === Infinity ? '∞' : ds.profitFactor.toFixed(2)}\n`;
    else msg += `No trades.\n`;
    if (tally) msg += `\n🧪 ${tally}\n`;
    msg += `\n💼 ${balStart.toFixed(2)} → ${balNow.toFixed(2)} (${balDelta >= 0 ? '+' : ''}${balDelta.toFixed(2)})\n`;
    msg += `💼 Overall: <b>${money(this.stats.overallProfit, this.currencyStr())}</b>\n`;
    msg += `❌ Loss streak: ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}`;
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
        version: 5, engine: 'APEX v4', savedAt: new Date().toISOString(), savedReason: reason,
        startBalance: this.startBalance, lastBalance: this.lastBalance, overallProfit: this.overallProfit,
        stats: this.stats.serialize(),
        assetTracker: this.assetTracker.serialize(),
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
      this.stats = new StatisticsManager(d.stats || {});
      if (d.assetTracker) this.assetTracker.loadSaved(d.assetTracker);
      logger.info(
        `state restored (APEX v4): overallProfit=${this.stats.overallProfit.toFixed(2)} ` +
        `lossStreak=${this.stats.currentLossStreak} sessionPnl=${this.assetTracker.sessionPnl.toFixed(2)}`,
      );
    } catch (e) { logger.warn('state load:', e.message); }
  }

  stop(signal) {
    if (this.stopped) return;
    this.stopped = true;
    this._clearWatchdog();
    this._clearPauseTimers();
    logger.info(`stopping (${signal})`);
    telegram.send(`<b>APEX Bot stopped</b>\nSignal: ${signal}`);
    if (this._analysisT) clearInterval(this._analysisT);
    if (this._hourlyT) clearInterval(this._hourlyT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._eodBoot) clearTimeout(this._eodBoot);
    if (this._barrierT) clearInterval(this._barrierT);
    if (this._discoveryT) clearInterval(this._discoveryT);

    this.exec.cleanupAllSubscriptions().catch(e => logger.warn('cleanup failed:', e.message)).finally(() => {
      const today = this.stats.todayTrades();
      const s = this.stats.stats(today);
      const tally = this.stats.edgeTallyLine();
      let msg = `🌙 <b>SESSION END</b>\n📊 ${s.count} trades (✅${s.wins} ❌${s.losses}) | WR ${s.winRate.toFixed(1)}%\n💰 Net: ${money(s.totalProfit, this.currencyStr())}\n💼 Overall: ${money(this.overallProfit, this.currencyStr())}`;
      if (tally) msg += `\n🧪 ${tally}`;
      telegram.send(msg);
      this._saveState('shutdown');
      this.client.stop();
      setTimeout(() => process.exit(0), 2500);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 14. SELF-TEST  (pure math + invariants; no network)
// ═══════════════════════════════════════════════════════════════════════
function runSelfTest() {
  const results = [];
  const test = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond, detail });
    if (!cond) console.log(`  ✗ ${name} ${detail}`);
  };
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

  const an = new ApexAnalyzer(CONFIG);

  // 1. Log returns.
  const q = [100, 101, 99, 100];
  const lr = an._logReturns(q);
  test('log returns count', lr.length === 3, `got ${lr.length}`);
  test('log returns values', near(lr[0], Math.log(101 / 100)) && near(lr[1], Math.log(99 / 101)), `[${lr.map(v => v.toFixed(5))}]`);

  // 2. MAD scale on symmetric data.
  const s = an._madScale([0.01, -0.01, 0.012, -0.011, 0.009]);
  test('mad scale positive', s > 0 && s < 0.02, `scale=${s.toFixed(5)}`);

  // 3. EWMA vars: heavy recent return lifts fast above slow.
  const vs = an._ewmaVars([0.0001, 0.0001, 0.0001, 0.01, 0.01], 0.3, 0.03);
  test('ewma fast>slow after burst', Math.sqrt(vs.fastVar) > Math.sqrt(vs.slowVar));

  // 4. EV horizon: highest EV at the K that balances (1+g)^K vs p1^K.
  const h = an._chooseHorizon(0.05, 0.98, 0.002, 10, 0.5, 0);
  test('horizon chooses K>=1', h.best.K >= 1, `K=${h.best.K}`);
  test('horizon edge formula', near(h.raw.edge, Math.pow(1.05, h.raw.K) * Math.pow(0.98, h.raw.K) - 0.002, 1e-9), `edge=${h.raw.edge}`);

  // 5. Hazard haircut is conservative (upper >= raw) and rejects unknown cadence.
  const hzRaw = 1 / 500;
  const hzUp = an._hazardUpperBound(10, 500, 6000, 1.28);
  test('hazard upper >= raw', hzUp >= hzRaw, `${hzUp} vs ${hzRaw}`);
  test('hazard unknown → 1', an._hazardUpperBound(1, 0, 6000, 1.28) === 1);

  // 6. Kelly bounds.
  test('kelly caps at fraction', kellyMultiplier(0.02, 1.4, 0.2) <= 0.2 + 1e-12);
  test('kelly zero for negative EV', kellyMultiplier(-0.01, 1.4, 0.2) === 0);
  test('kelly full formula', near(kellyMultiplier(0.04, 1.5, 0.5), 0.04 / 0.5, 1e-9));

  // 7. VOL gate: needs compression + wide barrier + real barrier.
  test('vol gate blocked without compression', isVolEntryAllowed(1.05, 3.0, false, CONFIG).ok === false);
  test('vol gate blocked with thin barrier', isVolEntryAllowed(0.85, 1.0, false, CONFIG).ok === false);
  test('vol gate blocked on estimated barrier', isVolEntryAllowed(0.85, 3.0, true, CONFIG).ok === false);
  test('vol gate allows compressed + wide + real', isVolEntryAllowed(0.85, 3.0, false, CONFIG).ok === true);

  // 8. regimeClassOf.
  test('regime BOOM', regimeClassOf('BOOM1000') === 'BOOM');
  test('regime CRASH', regimeClassOf('CRASH500') === 'CRASH');
  test('regime VOL', regimeClassOf('R_100') === 'VOL' && regimeClassOf('1HZ100V') === 'VOL');

  // 9. Analyzer on synthetic data: no barrier → null (never fabricate).
  const emptyMarket = { getBarrier: () => null };
  const ticks = [];
  let px = 100;
  for (let i = 0; i < 500; i++) { ticks.push({ epoch: i, quote: px }); px *= 1 + (Math.random() - 0.5) * 0.002; }
  const noBarrier = an.analyze('R_100', ticks, emptyMarket);
  test('analyzer null without barrier (no fabrication)', noBarrier === null, noBarrier ? `returned ${JSON.stringify(noBarrier)}` : '');

  // 10. Idempotent settlement.
  const fakeClient = { forget: () => Promise.resolve(), _isPat: false };
  const ex = new TradeExecutor(fakeClient, CONFIG);
  let resultsEmitted = 0;
  ex.on('result', () => resultsEmitted++);
  ex.open.set(777, { contractId: 777, symbol: 'R_100', stake: 5, buyPrice: 5, profit: 0, ticksHeld: 0, _exitReason: 'test' });
  const first = ex._finalizeContract(777, { profit: 0.5, status: 'won', sellPrice: 5.5, sellTime: 1 });
  const second = ex._finalizeContract(777, { profit: 99, status: 'won', sellPrice: 99 });
  test('settle returns info once', !!first && second === null);
  test('settle emits result once', resultsEmitted === 1, `emitted ${resultsEmitted}`);
  test('settle frees slot', ex.count() === 0);

  // 11. Synthetic VOL compression: high-variance past, calm recent → recommendable VOL entry.
  const fakeVolMarket = {
    getBarrier: sym => {
      if (sym === 'R_100') return { halfBarrierPct: 0.25 };   // ±0.25% per tick
      return null;
    },
  };
  const volTicks = [];
  let vpx = 10000;
  for (let i = 0; i < 600; i++) {
    // First half: volatile (σ≈0.5%/tick); last 150: compressed (σ≈0.05%/tick).
    const sig = i < 450 ? 0.005 : 0.0005;
    vpx *= 1 + (Math.random() - 0.5) * 2 * sig;
    volTicks.push({ epoch: i, quote: vpx });
  }
  const volResult = an.analyze('R_100', volTicks, fakeVolMarket);
  test('vol-compression produces a candidate', !!volResult, volResult ? `regime=${volResult.regimeClass} reason=${volResult.entryReason}` : 'null');
  if (volResult) test('vol candidate entry reason', volResult.entryReason === 'vol-compressed', volResult.entryReason);

  const passed = results.filter(r => r.pass).length;
  console.log(`\nSelf-test: ${passed}/${results.length} passed`);
  return passed === results.length;
}

// ═══════════════════════════════════════════════════════════════════════
// 15. BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════
function printBanner() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   AccuAPEXnew — APEX engine (v4, TEST/DEMO)          ║');
  console.log('║   post-spike exploit • vol-compression • EV-optimal  ║');
  console.log('║   v4: reconcile • idempotent settle • hard caps      ║');
  console.log('║   flags: --selftest  --dry-run                       ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

async function main() {
  printBanner();
  if (process.argv.includes('--selftest')) {
    process.exitCode = runSelfTest() ? 0 : 1;
    return;
  }
  try { require.resolve('ws'); } catch (_) { console.error('npm install ws'); process.exit(1); }
  if (!CONFIG.apiToken) { console.error('API token not set'); process.exit(1); }
  const dry = process.argv.includes('--dry-run');
  if (dry) console.log('🔒 DRY-RUN MODE — will analyze and log would-be entries, but place NO trades');
  console.log(CONFIG.telegram.enabled ? '✅ Telegram: ENABLED' : 'ℹ️ Telegram: DISABLED');
  const bot = new AccuAPEXnewBot(CONFIG);
  bot.dryRun = dry;
  await bot.start();
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
