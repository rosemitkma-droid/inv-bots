#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  AccuPULSE2b — APEX engine  (conditional-volatility bimodal survival)
 * =====================================================================
 *
 *  Multi-asset Deriv Accumulator trading bot.
 *
 *  ─ CORE STRATEGY: APEX (Asymmetric Post-spike EXploit) ─
 *  A Deriv Accumulator's barrier is recomputed EVERY tick around the
 *  PREVIOUS spot, so a knockout happens when a *single* tick's move
 *  exceeds the ± barrier — it is NOT cumulative drift from entry.
 *  Per-tick survival is P(|one-tick return| < barrier), and K-tick
 *  survival is that raised to the K-th power (approx. iid). APEX
 *  exploits two observations:
 *
 *    • BOOM / CRASH indices are bimodal: tiny orderly drift punctuated
 *      by rare large spikes. The ONLY real knockout is a spike, and its
 *      hazard is lowest immediately AFTER a spike fires. APEX enters in
 *      that fresh post-spike low-hazard window and holds a short,
 *      hazard-bounded number of ticks.
 *
 *    • VOLATILITY / JUMP indices (R_*, 1HZ*V) are near-i.i.d. Gaussian.
 *      APEX enters only during transient volatility compression — when
 *      current realised σ sits well below the σ the barrier was priced
 *      against, so the barrier is temporarily loose.
 *
 *  Engine: robust MAD scale + EWMA fast/slow σ, explicit spike
 *  detection, per-asset regime class (BOOM/CRASH/VOL), conditional
 *  forward K-tick survival, EV-optimal compounding horizon net of
 *  spread, and an adaptive exit (hazard / drift / profit-lock).
 *  Stake sizing is adaptive + v3 per-asset risk management.
 *
 *  ─ INFRASTRUCTURE ─
 *  Trading system (analysis + execution) ported from accuAPEX.js into
 *  the AccuPULSE2b framework, which is kept verbatim: WS/REST client,
 *  PAT/OAuth auth, Telegram, stats, state persistence, GMT summaries,
 *  scheduled pause/resume and day-of-week filters.
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
  stake          : parseFloat('5.0'),
  multiplier     : parseFloat('0.04'), // legacy hint
  multiplierStep : parseFloat('0.0'),
  stopLoss       : parseFloat('900.0'),   // hard $ stop per contract
  takeProfit     : parseFloat('10000.0'), // session take-profit

  // ── Martingale (off by default — APEX uses adaptive sizing instead) ──
  martingale:            parseFloat('0'),   // 0 = off
  martingaleStep:        parseFloat('9'),
  lossesBeforeMartingale:parseInt  ('0'),
  maxMartingaleStep:     parseFloat('900'),

  // ── Sizing (legacy 'edge' mode) ──
  sizingMode:        'flat',            // 'flat' | 'edge'
  edgeScaleMax:      parseFloat('2.0'),
  edgeScaleEdgeRef:  parseFloat('0.05'),
  downscaleAfterLoss:false,

  // ── Assets (Deriv synthetic indices) ──
  assets: ('R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V,BOOM500,BOOM600,BOOM900,BOOM1000,CRASH500,CRASH600,CRASH900,CRASH1000')
    .split(',').map(s => s.trim()).filter(Boolean),

  // ── Telegram (retained) ──
  telegram: {
    enabled : true,
    botToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    chatId  : '752497117',
  },

  // ── Strategy timing ──
  tickWindow          : parseInt('200',   10),
  minTicksForAnalysis : parseInt('80',    10),
  analysisIntervalMs  : parseInt('15000', 10),
  tradeCooldownMs     : parseInt('4000',  10),
  maxOpenTrades       : parseInt('1',     10),

  // ── PULSE-COMPAT TUNABLES (shared helpers) ──
  pulseReturnWindow   : parseInt('120',   10),
  pulseHorizon        : parseInt('20',    10),
  pulseTrials         : parseInt('10000', 10),
  pulseMinTrials      : parseInt('4000',  10),

  // ── EV gates ──
  pulseEdgeThreshold  : parseFloat('0.985'), //1.005 //1.015
  pulseMinEV          : parseFloat('0.005'),   //0.015
  pulseMinSurvival    : parseFloat('0.93'),   //0.985
  pulseMaxHorizon     : parseInt  ('6', 10),

  // ── Growth-rate candidates (Deriv supports 0.01-0.05) ──
  pulseGrowthRates    : [0.05, 0.04, 0.03], // eval multiple rates, let EV pick best

  // ── Volatility regime ──
  pulseCalmMaxRatio   : parseFloat('1.05'),
  pulseStormyMinRatio : parseFloat('1.20'),

  // ── Spread model ──
  pulseSpreadCost     : parseFloat('0.002'),

  // ═══════════════════════════════════════════════════════════════════
  // APEX STRATEGY TUNABLES  (engine ported from accuAPEX.js)
  // ═══════════════════════════════════════════════════════════════════
  //   History depth. Spike cadence can only be measured if the analysis
  //   window spans SEVERAL spike intervals. Boom/Crash 1000 spikes every
  //   ~1000 ticks, so we keep ≥6000 ticks so ≥2 spikes are almost always
  //   in view. This is the single most important APEX tunable.
  apexHistoryWindow   : parseInt('6000', 10),

  //   Robust scale + spike model.
  apexScaleWindow     : parseInt('150', 10),   // ticks for MAD robust scale
  apexEwmaFast        : parseFloat('0.30'),     // fast EWMA-σ weight (recent)
  apexEwmaSlow        : parseFloat('0.03'),     // slow EWMA-σ weight (baseline)

  // ── Spike detection ──
  apexSpikeK          : parseFloat('5.0'),
  apexMinSpikesSeen   : parseInt('2', 10),      // need ≥2 spikes to trust cadence

  // ── Post-spike entry window (Boom/Crash) ──
  apexPostSpikeMin        : parseInt('1', 10),
  apexPostSpikeWindowFrac : parseFloat('0.35'), // fraction of mean cadence
  apexMaxHazard           : parseFloat('0.010'), // legacy (superseded by apexMinSpikeSurvival)
  // v3: Hold-period-aware spike survival.
  apexMinSpikeSurvival    : parseFloat('0.80'), //0.50

  // ── Vol-compression entry (Volatility / Jump indices) ──
  apexVolCompressRatio : parseFloat('0.90'),
  apexBarrierSafety    : parseFloat('3.2'),

  // ── Survival / EV requirements (per-class overrides of pulse* gates) ──
  apexMinSurvival     : parseFloat('0.90'),  // forward K-tick survival floor
  apexMinEV           : parseFloat('0.010'), // ≥ +1% net EV to fire
  apexMaxHoldBoom     : parseInt('7',  10),  // Boom/Crash hold cap (ticks)
  apexMaxHoldVol      : parseInt('7',  10),  // Vol/Jump hold cap (ticks)

  // ── Adaptive-exit (APEX) ──
  apexExitHazard      : parseFloat('0.020'),
  apexExitDriftFrac   : parseFloat('0.55'),
  apexProfitLockFrac  : parseFloat('0.60'),  // lock ≥60% of expected remaining
  apexMinProfitLockFrac: parseFloat('0.004'),

  // ── Legacy adaptive early-exit tuning (kept from accuAPEX.js) ──
  pulseExitProfitLockFrac : parseFloat('0.55'),
  pulseExitDriftFrac      : parseFloat('0.50'),
  pulseExitNextTickEdge   : parseFloat('1.00'),
  pulseMinProfitLockFrac  : parseFloat('0.003'),

  // ═══════════════════════════════════════════════════════════════════
  // v3: PER-ASSET RISK MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════
  maxEntriesPerSpikeWindow : parseInt('1', 10),
  assetLossCooldownMs      : parseInt('120000', 10),  // 2 minutes
  assetMaxConsecutiveLosses: parseInt('3', 10),
  assetPauseDurationMs     : parseInt('600000', 10),  // 10 minutes
  minWinRateToTrade        : parseFloat('0.38'),  // 38%
  rollingWindowSize        : parseInt('15', 10),
  sessionMaxDrawdown       : parseFloat('300'),
  maxAssetsTrading         : parseInt('2', 10),
  edgeAfterLossBoost       : parseFloat('0.008'),  // +0.8% edge per loss in streak

  // ═══════════════════════════════════════════════════════════════════
  // v3: DYNAMIC ASSET DISCOVERY
  // ═══════════════════════════════════════════════════════════════════
  autoDiscoverAssets       : true,
  discoveryIntervalMs      : parseInt('3600000', 10),  // re-discover every hour
  assetFamilyFilter        : ['BOOM', 'CRASH'],

  //   Correlated assets to avoid trading simultaneously.
  correlatedGroups         : [
    ['BOOM1000', 'BOOM900', 'BOOM600', 'BOOM500', 'BOOM300N', 'BOOM150N', 'BOOM50'],
    ['CRASH1000', 'CRASH900', 'CRASH600', 'CRASH500', 'CRASH1300N', 'CRASH150N', 'CRASH50'],
  ],

  // ═══════════════════════════════════════════════════════════════════
  // v3: SMART POSITION SIZING (replaces raw martingale)
  // ═══════════════════════════════════════════════════════════════════
  sizingModeV3             : 'adaptive',  // 'flat'|'adaptive'|'kelly'
  lossStakeReduction       : parseFloat('0.70'),  // stake × 0.70 after each loss
  winStakeRecovery         : parseFloat('1.15'),  // stake × 1.15 after each win
  minStakeFraction         : parseFloat('0.25'),  // never go below 25% of base
  maxStakeFraction         : parseFloat('2.50'),  // never exceed 250% of base
  kellyFraction            : parseFloat('0.20'),

  // ── Daily limits ──
  dailyMaxLoss   : parseFloat('500'),
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
  logFile : 'accuPULSE2b_04.log',
  logLevel: 'INFO',

  // ── State persistence ──
  stateFile           : 'accuPULSE2b_state_04.json',
  stateSaveOnTrade    : true,
  stateSaveOnShutdown : true,

  // ── Scheduled pause/resume ──
  pauseEnabled   : true,
  pauseStartGmt  : '23:00',
  pauseEndGmt    : '01:00',

  // ── Day-of-week trading filter ──
  tradeSunday    : true,
  tradeMonday    : true,
  tradeTuesday   : true,
  tradeWednesday : true,
  tradeThursday  : true,
  tradeFriday    : true,
  tradeSaturday  : true,

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

  /**
   * Deep historical backfill for the APEX engine (ported from accuAPEX.js).
   * Deriv `ticks_history` returns up to 5000 ticks per call; chain calls
   * backwards using `end` = earliest epoch − 1. Returns oldest → newest.
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

  /**
   * v3: Dynamic asset discovery (ported from accuAPEX.js) — queries Deriv
   * for all ACCU-capable synthetic indices, filters by configured families,
   * and returns the discovered list.
   */
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
        // APEX needs a deep buffer so spike cadence stays measurable.
        const cap = Math.max(this.cfg.apexHistoryWindow + 500, this.cfg.tickWindow * 8, 2000);
        // Use array replacement instead of splice to avoid O(n) operation every tick
        if (arr.length > cap) {
          const newArr = arr.slice(-cap);
          this.history.set(symbol, newArr);
        }
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
        // APEX needs a deep history so spike cadence is measurable from the first analysis.
        const want = Math.max(this.cfg.apexHistoryWindow || 6000, this.cfg.tickWindow * 5, 1000);
        if (hist.length < want) {
          const fetched = await this.deepBackfill(s, want, 5000);
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
      }));
    } finally { this._bootstrapping = false; }
  }

  historyFor(symbol) { return this.history.get(symbol) || []; }
}

// 8. APEX ANALYZER  (Conditional-volatility bimodal survival engine)
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

// 9. TRADE EXECUTOR (Accumulator) — APEX adaptive early-exit
// ─────────────────────────────────────────────────────────────────────
class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client   = client;
    this.cfg      = cfg;
    this.open     = new Map();
    this.analyzer = null;
    this._selling = new Set();
    this._subscriptions = new Map(); // Track subscription IDs for cleanup
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

      const subId = await this.client.subscribe(
        { proposal_open_contract: 1, contract_id: b.contract_id },
        msg => this._onUpdate(msg, info),
      );
      this._subscriptions.set(b.contract_id, subId);
      info._subscriptionId = subId;

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
      const subId = this._subscriptions.get(cid) || msg.subscription?.id;
      if (subId) {
        this._subscriptions.delete(cid);
        await this.client.forget(subId).catch(() => {});
      }
      this.emit('result', finished);
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

  // Cleanup all open subscriptions
  async cleanupAllSubscriptions() {
    const cleanupPromises = [];
    for (const [contractId, subId] of this._subscriptions) {
      cleanupPromises.push(
        this.client.forget(subId).catch(e => logger.debug(`cleanup sub ${contractId}:`, e.message)),
      );
    }
    await Promise.all(cleanupPromises);
    this._subscriptions.clear();
  }

  openTrades() { return Array.from(this.open.values()); }
  count()      { return this.open.size; }
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
// ═══════════════════════════════════════════════════════════════════════
// 11. STATISTICS MANAGER
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
// 12. TRADING BOT  (Main Orchestrator)
// ═══════════════════════════════════════════════════════════════════════
class AccuPULSE2Bot {
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
    this.tradeStartTime = null;

    this._analysisT = null;
    this._hourlyT = null;
    this._eodT = null;
    this._hourlyBoot = null;
    this._eodBoot = null;
    this._barrierT = null;
    this._tradeWatchdogTimer = null;
    this._discoveryT = null;
    this.paused = false;
    this._pauseStartTimer = null;
    this._pauseEndTimer   = null;
    this._lastDayISODate  = null;

    // ── Legacy martingale state (martingale off by default; kept for
    //    the APEX v3Note / currentStake() fallback paths) ──
    this.lossesStreak = 0;
    this.martingaleMultiplier = 1.0;
    this.currentStake2 = this.cfg.stake;
  }

  async start() {
    logger.info('═══════════════════════════════════════════');
    logger.info('  AccuPULSE2b — APEX Strategy');
    logger.info('═══════════════════════════════════════════');
    logger.info(`assets: ${this.cfg.assets.join(', ')}`);

    if (!this.cfg.apiToken) { logger.error('API token missing'); process.exit(1); }

    this.client.on('authorized', info => this._onAuthorized(info));
    this.client.on('close', (c, r, was) => this._onDisconnected(c, r, was));
    this.exec.on('open', t => this._onTradeOpen(t));
    this.exec.on('update', t => this._onTradeUpdate(t));
    this.exec.on('result', t => this._onTradeResult(t));
    this.exec.on('driftWarning', t => this._onDriftWarning(t));

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
    process.on('uncaughtException', e => { logger.error('uncaughtException:', e); this._saveState('uncaughtException'); });
    process.on('unhandledRejection', e => { logger.error('unhandledRejection:', e); this._saveState('unhandledRejection'); });

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

  // ── Scheduled pause helpers ─────────────────────────────────
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
    if (this._pauseEndTimer)   { clearTimeout(this._pauseEndTimer);   this._pauseEndTimer = null; }
  }
  _schedulePause() {
    this._clearPauseTimers();
    if (!this.cfg.pauseEnabled) return;
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const start = this._parsePauseTime(this.cfg.pauseStartGmt);
    const end   = this._parsePauseTime(this.cfg.pauseEndGmt);
    if (!start || !end) { logger.warn('pause schedule: invalid pauseStartGmt or pauseEndGmt format'); return; }
    const startMin = start.h * 60 + start.min;
    const endMin   = end.h   * 60 + end.min;

    if (startMin > endMin) {
      if (nowMin >= startMin || nowMin < endMin) {
        this.paused = true;
        const delay = this._msToTarget(end.h, end.min);
        this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
        logger.info(`pause: currently active (overnight), resumes in ${(delay/60000).toFixed(1)}m`);
      } else {
        this.paused = false;
        const delay = this._msToTarget(start.h, start.min);
        this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), delay);
        logger.info(`pause: scheduled, pauses in ${(delay/60000).toFixed(1)}m at ${this.cfg.pauseStartGmt} GMT`);
      }
    } else {
      if (nowMin >= startMin && nowMin < endMin) {
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
  }
  _onPauseResume(action) {
    this._clearPauseTimers();
    if (action === 'pause') {
      this.paused = true;
      logger.info(`TRADING PAUSED at ${this.cfg.pauseStartGmt} GMT until ${this.cfg.pauseEndGmt} GMT`);
      telegram.send(`⏸️ <b>TRADING PAUSED</b>\nPaused from <b>${this.cfg.pauseStartGmt}</b> to <b>${this.cfg.pauseEndGmt}</b> GMT.\nNo new trades until resume.`);
      const end = this._parsePauseTime(this.cfg.pauseEndGmt);
      if (end) {
        const delay = this._msToTarget(end.h, end.min);
        this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
      }
    } else {
      this.paused = false;
      logger.info(`TRADING RESUMED at ${this.cfg.pauseEndGmt} GMT`);
      telegram.send(`▶️ <b>TRADING RESUMED</b>\nScanning for trades again.\nOverall Profit: ${money(this.overallProfit, this.currencyStr())}`);
      const start = this._parsePauseTime(this.cfg.pauseStartGmt);
      if (start) {
        const delay = this._msToTarget(start.h, start.min);
        this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), delay);
      }
    }
  }
  _isTradingAllowedToday() {
    const dayOfWeek = new Date().getUTCDay();
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const daySettings = [this.cfg.tradeSunday, this.cfg.tradeMonday, this.cfg.tradeTuesday, this.cfg.tradeWednesday, this.cfg.tradeThursday, this.cfg.tradeFriday, this.cfg.tradeSaturday];
    if (!daySettings[dayOfWeek]) {
      logger.debug(`trading disabled for ${dayNames[dayOfWeek]} (GMT)`);
      return false;
    }
    return true;
  }
  _checkDayChange() {
    const today = utcDateStr();
    if (this._lastDayISODate && this._lastDayISODate !== today) {
      logger.info(`new day detected: ${this._lastDayISODate} → ${today}`);
      if (this.assetTracker) this.assetTracker.resetSession();
      telegram.send(`📅 <b>New trade day: ${today}</b>\nOverall Profit: ${money(this.overallProfit, this.currencyStr())}`);
      // Reset circuit breakers for the new day
      this.stopped = false;
      this._lastDayISODate = today;
    } else if (!this._lastDayISODate) {
      this._lastDayISODate = today;
    }
  }

  // ── Authorised ──────────────────────────────────────────────
  async _onAuthorized(info) {
    this.startBalance = this.balance ?? this.client.balance;
    this.lastBalance = this.startBalance;

    telegram.send(
      `<b>APEX v3 Bot Online</b>\n\n` +
      `<b>Account:</b> ${info.loginid}\n` +
      `<b>Type:</b> ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `<b>Balance:</b> ${this.startBalance.toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Assets:</b> ${this.cfg.assets.length} ${this.cfg.autoDiscoverAssets ? '(auto-discover ON)' : ''}\n` +
      `<b>Stake:</b> ${this.cfg.stake}\n` +
      `<b>Growth rates:</b> ${this.cfg.pulseGrowthRates.map(g => (g*100).toFixed(0)+'%').join(', ')}\n` +
      `<b>Sizing:</b> ${this.cfg.sizingModeV3} ` +
        `(loss×${this.cfg.lossStakeReduction}, win×${this.cfg.winStakeRecovery})\n` +
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
      `<b>Overall Profit:</b> ${money(this.overallProfit, this.currencyStr())}\n` +
      `Loss streak: current ${this.stats.currentLossStreak}, x2=${this.stats.lossStreakEvents.x2}, x3=${this.stats.lossStreakEvents.x3}, x4=${this.stats.lossStreakEvents.x4}`,
    );

    await Promise.all([
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
              for (const a of newAssets) {
                if (!this.cfg.assets.includes(a)) this.cfg.assets.push(a);
              }
              await this.market.bootstrap(newAssets);
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
    this._schedulePause();
  }

  async _onDisconnected(code, reason, wasAuth) {
    this._clearWatchdog();
    this._clearPauseTimers();
    telegram.send(`⚠️ <b>Connection lost</b>\ncode: <code>${code}</code>\nwas auth: ${wasAuth ? 'yes' : 'no'}\n🔄 reconnecting…`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    if (this.exec) {
      this.exec.open.clear();
      // Cleanup all subscriptions on disconnect
      await this.exec.cleanupAllSubscriptions().catch(() => {});
    }
    // Clear market data subscriptions
    this.market.subs.clear();
  }

  // ── Trade callbacks ─────────────────────────────────────────
  _onTradeOpen(t) {
    this.tradeStartTime = Date.now();
    this._startWatchdog(t.contractId);

    const a = t._analysis || {};
    const sizingMode = a.sizingMode || 'legacy';
    let sizingLine;
    if (sizingMode === 'adaptive') {
      const assetState = this.assetTracker._getAsset(t.symbol);
      sizingLine = `<b>Sizing:</b> Adaptive (${t.stake.toFixed(2)} ${this.currencyStr()})\n` +
        `• Base: ${(a.baseStake ?? this.cfg.stake).toFixed(2)} | WR: ${(assetState.rollingWinRate*100).toFixed(0)}% | Asset losses: ${assetState.consecutiveLosses}\n`;
    } else {
      sizingLine = '';
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

  _onTradeUpdate(t) { logger.debug(`update #${t.contractId}: profit=${t.profit.toFixed(3)} spot=${t.currentSpot}`); }

  _onDriftWarning(t) {
    logger.debug(`apex-exit #${t.contractId} urg=${t.dec.urgency.toFixed(2)} ${t.dec.reason}`);
  }

  _onTradeResult(t) {
    this._clearWatchdog();
    this.tradeStartTime = null;
    const rec = this.stats.record(t);
    const emoji = t.status === 'won' ? '✅' : '❌';
    const label = t.status === 'won' ? 'WIN' : 'LOSS';
    const dur = Math.max(0, (t.sellTime || Date.now() / 1000) - (t.buyTime || 0));
    this.lastBalance = (this.lastBalance ?? this.balance ?? 0) + t.profit;
    this.overallProfit += t.profit;

    // v3: Update per-asset tracker
    const won = t.status === 'won';
    this.assetTracker.onTradeResult(t.symbol, won, t.profit);

    // v3: Update adaptive stake for this asset
    if (this.cfg.sizingModeV3 === 'adaptive') {
      const currentStake = this.assetTracker.getAdaptiveStake(t.symbol, this.cfg.stake);
      this.assetTracker.updateStakeAfterResult(t.symbol, won, currentStake, this.cfg.stake);
    }

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
      `<b>Consecutive Losses:</b> current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
      ` x2=${this.stats.lossStreakEvents.x2} x3=${this.stats.lossStreakEvents.x3} x4=${this.stats.lossStreakEvents.x4}`;
    telegram.send(msg);
    this.lastTradeAt = Date.now();
    this._saveState('after-trade');
  }

  // ── Main APEX strategy loop ────────────────────────────────
  async _analyzeAndTrade() {
    try {
      if (this.stopped) return;
      if (!this.client.authorized) return;
      if (this.paused) {
        logger.debug('trading paused — skipping analysis cycle');
        return;
      }
      if (!this._isTradingAllowedToday()) return;
      this._checkDayChange();

      // Daily limits
      const today = this.stats.todayTrades();
      if (today.length >= this.cfg.dailyMaxTrades) {
        logger.warn(`dailyMaxTrades reached — pausing`); return;
      }
      const pl = today.reduce((s, t) => s + (t.profit || 0), 0);
      if (pl <= -this.cfg.dailyMaxLoss) {
        logger.warn(`dailyMaxLoss reached — pausing`);
        telegram.send(`<b>Daily loss limit</b>\nNet P/L: ${pl.toFixed(2)} ${this.currencyStr()}`);
        return;
      }
      if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
      if (this.exec.count() >= this.cfg.maxOpenTrades) return;

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
      const analyses = this.cfg.assets.map(s =>
        this.analyzer.analyze(s, this.market.historyFor(s), this.market));
      const ranked = this.analyzer.rank(analyses);
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
          logger.info(`v3: ${cand.symbol} BLOCKED — ${check.reason}`);
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

  // ── Stake sizing (v3 adaptive / legacy edge) ───────────────
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

  async _refreshBarriers() {
    try {
      if (!this.client.authorized) return;
      await this.market.refreshBarriers(this.cfg.assets, this.cfg.pulseGrowthRates);
      logger.debug('barrier cache refreshed');
    } catch (e) {
      logger.debug('barrier refresh error:', e.message);
    }
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
    if (!this.cfg.stateSaveOnTrade    && reason === 'after-trade') return;
    if (!this.cfg.stateSaveOnShutdown && reason === 'shutdown')    return;
    try {
      const payload = {
        version: 4, engine: 'APEX v3', savedAt: new Date().toISOString(), savedReason: reason,
        startBalance: this.startBalance, lastBalance: this.lastBalance, overallProfit: this.overallProfit,
        stats: this.stats.serialize(),
        // v3: per-asset tracker state
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
      // v3: restore per-asset tracker state
      if (d.assetTracker) this.assetTracker.loadSaved(d.assetTracker);
      logger.info(
        `state restored (APEX v3): overallProfit=${this.stats.overallProfit.toFixed(2)} ` +
        `lossStreak=${this.stats.currentLossStreak} ` +
        `sessionPnl=${this.assetTracker.sessionPnl.toFixed(2)} ` +
        `trackedAssets=${this.assetTracker.assets.size}`,
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
    if (this._eodBoot) clearTimeout(this._eodBoot);
    if (this._barrierT) clearInterval(this._barrierT);
    if (this._discoveryT) clearInterval(this._discoveryT);

    // Cleanup subscriptions
    this.exec.cleanupAllSubscriptions().catch(e => logger.warn('cleanup failed:', e.message)).finally(() => {
      // Final summary
      const today = this.stats.todayTrades();
      const s = this.stats.stats(today);
      telegram.send(`🌙 <b>SESSION END</b>\n📊 ${s.count} trades (✅${s.wins} ❌${s.losses}) | WR ${s.winRate.toFixed(1)}%\n💰 Net: ${money(s.totalProfit, this.currencyStr())}\n💼 Overall: ${money(this.overallProfit, this.currencyStr())}`);

      this._saveState('shutdown');
      this.client.stop();
      setTimeout(() => process.exit(0), 2500);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 13. BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════
function printBanner() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   AccuPULSE2b — APEX engine (v3)                    ║');
  console.log('║   post-spike exploit • conditional-vol • EV-optimal  ║');
  console.log('║   v3: adaptive sizing • per-asset risk • auto-discover║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
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
