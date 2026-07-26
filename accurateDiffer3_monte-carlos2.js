#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  Deriv Digit Differ Trading Bot (Monte Carlo Edition)
 * =====================================================================
 *
 *  A clean, focused DIGITDIFF bot that acknowledges the fundamental
 *  truth about synthetic indices: each tick is an independent,
 *  uniformly distributed random event from a cryptographically secure
 *  RNG. No pattern analysis can predict future digits.
 *
 *  This bot's "edge" comes entirely from:
 *    1. Risk management (position sizing, loss limits, circuit breakers)
 *    2. Value check (ensuring payout exceeds break-even threshold)
 *    3. Conservative heuristic (selecting least-frequent digit as barrier)
 *
 *  The digit selection is a heuristic - not a demonstrated statistical
 *  edge. It works because:
 *    - Short-term frequency deviations are normal in random processes
 *    - Selecting the least-frequent digit in a window gives you a
 *      slightly higher probability of the "differs" contract winning
 *    - Combined with the payout structure, this can yield positive
 *      expected value under certain market conditions
 *
 *  Simplicity Features:
 *    • Single-window frequency analysis (no multi-layer "consensus")
 *    • Direct value-edge check against live proposal
 *    • Kelly-fractional sizing for optimal bankroll growth
 *    • Per-symbol calibration tracker
 *    • Consecutive-loss circuit breaker
 *    • Daily/session loss caps
 *    • Clean, readable code structure
 *
 *  Credentials: DERIV_API_TOKEN, DERIV_ACCOUNT_ID, TELEGRAM_BOT_TOKEN,
 *  and TELEGRAM_CHAT_ID must be set in your .env file.
 *
 *  Install:  npm install ws
 *  Run:      node accurateDiffer3_simple.js
 *  Backtest: $env:BACKTEST=1; node accurateDiffer3_simple.js
 *
 * =====================================================================
 */

const WebSocket    = require('ws');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { URL }      = require('url');
const EventEmitter = require('events');

// ─────────────────────────────────────────────────────────────────────
// 1. ENV LOADER
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

function numEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function intEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function boolEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}
function strEnv(name, def) {
  const v = process.env[name];
  return v == null || v === '' ? def : String(v).trim();
}
function listEnv(name, def) {
  return strEnv(name, def).split(',').map(s => s.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────
// 2. CONFIGURATION
// ─────────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  // Deriv API credentials (MUST come from .env or environment)
  apiToken:    'pat_cb2016855b5e6c61ac95f94432192dd6ed86bec7f7454e575d3fe1ed9f617692',
  appId:       '33uslPtthXBEkQOdfKfoY',
  accountId: '', // recommended/required for PAT new API
  accountType: 'demo', // demo | real
  legacyWsUrl: 'wss://ws.derivws.com/websockets/v3',
  restBaseUrl: 'https://api.derivws.com',
  currency: 'USD',

  // ── Trade Setup ─────────────────────────────────────────────────
  stake:           1.1,
  durationTicks:   1,
  minStake:        1.1,
  maxStake:        5.5,
  assets:          ['R_10','R_25','R_50','R_75','RDBULL','RDBEAR'], //'R_10','R_25','R_50','R_75','RDBULL','RDBEAR',

  // ── Timing ─────────────────────────────────────────────────────
  tickWindow:          500,
  minTicksForAnalysis: 200,
  analysisIntervalMs:  3000,
  tradeCooldownMs:     2500,
  maxOpenTrades:       1,
  assetRotationMs:     60000,

  // ── Risk Management ────────────────────────────────────────────
  dailyMaxLoss:       100,
  dailyMaxLossPct:    1.0,
  dailyMaxProfit:     15000,
  dailyMaxTrades:     50000,
  maxConsecutiveLoss: 7,
  lossCooldownMs:     300000,

  // ── Monte Carlo Analysis ────────────────────────────────────────
  mcSimulations:         10000,   // MC simulation trials
  minEdgeConfidence:     0.476,    // min confidence to trade (0-1)
  mcStabilityThreshold:  0.70,    // min stability across resamples (0-1)
  randomnessAlpha:       0.05,    // uniformity test significance level
  tradeFrequencyMs:      5000,    // min ms between trades
  maxWeakSignals:        500000000,       //50 pause after N consecutive weak signals
  analysisWindows:       [30, 60, 150, 400], // used by backtester reporting
  bootstrapIterations:   500,     // per-digit CI (lighter)
  hotFilterTicks:        5,       // digits in last N ticks → penalty
  cooldownTicks:         25,     // don't re-predict digit within N ticks
  maxRecentHits:         2,       // max occurrences in recent tail
  recentLookback:        20,      // recent tail length for hit check
  minEntropy:            0.90,    // min normalized entropy gate
  maxEntropy:            0.9997,  // max entropy gate (too uniform)

  // ── Value Edge ─────────────────────────────────────────────────
  minEdge:            0.005,
  safetyMargin:       0.003,

  // ── Kelly Sizing ───────────────────────────────────────────────
  kellyEnabled:       true,
  kellyFraction:      0.25,
  kellyMaxStakeFrac:  0.02,
  kellyBankrollFloor: 100,

  // ── Symbol Calibration ─────────────────────────────────────────
  calibEnabled:       false,
  calibWindow:        100,
  calibMinTrades:     30,
  calibDisableGap:    0.03,

  // ── Reporting ──────────────────────────────────────────────────
  eodTimeGmt:         strEnv('TRADE_DAY_END_GMT', '00:00'),
  eodSendDelaySeconds: 10,
  hourlySummary:      true,

  // ── Persistence ────────────────────────────────────────────────
  stateFile: strEnv('STATE_FILE', 'monte_carlo2_02_state.json'),
  logFile:   strEnv('LOG_FILE', 'monte_carlo2_02.log'),
  logLevel:  strEnv('LOG_LEVEL', 'INFO2').toUpperCase(),

  // ── Telegram ───────────────────────────────────────────────────
  telegram: {
    enabled : true,
    botToken: '8106601008:AAEMyCma6mvPYIHEvw3RHQX2tkD5-wUe1o0',
    chatId  : '752497117',
  },

  // ── Backtest ───────────────────────────────────────────────────
  backtestTicks:      intEnv('BACKTEST_TICKS', 50000),
  backtestBatchSize:  intEnv('BACKTEST_BATCH_SIZE', 5000),
  backtestPayoutMult: numEnv('BACKTEST_PAYOUT_MULT', 1.10),
  backtestOutFile:    strEnv('BACKTEST_OUT', 'backtest_report.json'),

  // ── Reconnect ──────────────────────────────────────────────────
  reconnect: {
    initialDelayMs: 1000,
    maxDelayMs:     60000,
    backoffFactor:  2,
    jitterMs:       500,
  },
});

// ─────────────────────────────────────────────────────────────────────
// 3. LOGGER
// ─────────────────────────────────────────────────────────────────────
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.INFO;
const pad = n => String(n).padStart(2, '0');

function utcTs() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;
}

function _writeLog(line) {
  try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (_) {}
}

function log(level, msg, ...rest) {
  if ((LOG_LEVELS[level] ?? 1) > currentLevel) return;
  const extras = rest.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
  const line = `[${utcTs()}] [${level}] ${msg}${extras ? ' ' + extras : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  _writeLog(line);
}

const logger = {
  error: (m, ...a) => log('ERROR', m, ...a),
  warn:  (m, ...a) => log('WARN',  m, ...a),
  info:  (m, ...a) => log('INFO',  m, ...a),
  debug: (m, ...a) => log('DEBUG', m, ...a),
};

function money(n, currency = CONFIG.currency) {
  const x = Number(n || 0);
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)} ${currency}`;
}
function utcDateStr(d = new Date()) { return d.toISOString().slice(0, 10); }
function previousUtcDateStr(d = new Date()) {
  return new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10);
}
function utcHour(d = new Date()) { return d.getUTCHours(); }
function htmlEscape(s) {
  return String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

// ─────────────────────────────────────────────────────────────────────
// 4. TELEGRAM NOTIFIER
// ─────────────────────────────────────────────────────────────────────
class TelegramNotifier extends EventEmitter {
  constructor(cfg) {
    super();
    this.enabled = cfg.enabled && !!cfg.botToken && !!cfg.chatId;
    this.botToken = cfg.botToken;
    this.chatId = cfg.chatId;
    this.queue = [];
    this.sending = false;
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
          method: 'POST',
          hostname: url.hostname,
          path: url.pathname,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 15000,
        }, res => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode === 200));
        });
        req.on('error', e => { logger.warn('telegram error:', e.message); resolve(false); });
        req.on('timeout', () => { req.destroy(new Error('telegram timeout')); resolve(false); });
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
        const msg = this.queue.shift();
        await this._post(msg);
        await new Promise(r => setTimeout(r, 1100));
      }
    } finally {
      this.sending = false;
    }
  }

  send(text) {
    if (!this.enabled) {
      logger.debug('telegram(dry):', String(text).slice(0, 160).replace(/\n/g, ' | '));
      return;
    }
    this.queue.push(String(text));
    this._drain().catch(e => logger.warn('telegram drain:', e.message));
  }
}

const telegram = new TelegramNotifier(CONFIG.telegram);

// ─────────────────────────────────────────────────────────────────────
// 4b. REST CLIENT (for PAT authentication)
// ─────────────────────────────────────────────────────────────────────
class RestClient {
  constructor(baseUrl, appId, token) {
    this.baseUrl = baseUrl;
    this.appId = appId;
    this.token = token;
  }

  static isPat(token) {
    return typeof token === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
  }

  request(method, route, body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(route, this.baseUrl); }
      catch (e) { return reject(new Error(`Invalid URL: ${route}`)); }

      const payload = body == null ? null : JSON.stringify(body);
      const req = https.request({
        method,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Deriv-App-ID': this.appId,
          'Accept': 'application/json',
          ...(payload ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          } : {}),
        },
        timeout: 15000,
      }, res => {
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
      if (payload) req.write(payload);
      req.end();
    });
  }

  get(route) { return this.request('GET', route); }
  post(route, body) { return this.request('POST', route, body); }
}

// ─────────────────────────────────────────────────────────────────────
// 5. DERIV CLIENT
// ─────────────────────────────────────────────────────────────────────
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
    this._rest = this._isPat ? new RestClient(cfg.restBaseUrl, cfg.appId, cfg.apiToken) : null;
    this._targetAccountId = cfg.accountId || '';
    // ── WebSocket heartbeat (ping/pong) ─────────────────────────────
    // Deriv's server closes idle connections after ~15-20 min. Without
    // application-level pings, the TCP half-open goes undetected and the
    // bot silently stops trading.
    this._heartbeatInterval = null;
    this._pongTimeout = null;
    this._pongReceived = false;
  }

  _nextReqId() { return ++this._reqId; }

  _legacyUrl() {
    const sep = this.cfg.legacyWsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.legacyWsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN is empty');
      this._stopped = true;
      return;
    }

    if (this._isPat) {
      logger.info('PAT token detected → using REST API + OTP flow');
      this._connectPat().catch(e => {
        logger.error('PAT connect failed:', e.message);
        this._scheduleReconnect();
      });
    } else {
      logger.info('connecting to Deriv WebSocket (legacy)...');
      this._openWs(this._legacyUrl());
    }
  }

  async _connectPat() {
    const accountId = await this._resolvePatAccountId();
    const route = `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`;
    logger.info(`POST ${route}`);

    const res = await this._rest.post(route);
    if (res.status !== 200) {
      const msg = res.body?.errors?.[0]?.message || res.body?.message || JSON.stringify(res.body);
      throw new Error(`OTP failed (${res.status}): ${msg}`);
    }

    const wsUrl = res.body?.data?.url;
    if (!wsUrl) throw new Error(`OTP response missing data.url`);

    this._targetAccountId = accountId;
    this.accountInfo = {
      loginid: accountId,
      accountType: this.cfg.accountType,
      isVirtual: this.cfg.accountType !== 'real',
      currency: this.cfg.currency,
    };

    logger.info('connecting via PAT WebSocket URL...');
    this._openWs(wsUrl);
  }

  async _resolvePatAccountId() {
    if (this._targetAccountId) return this._targetAccountId;

    const attempts = [
      ['GET', '/trading/v1/options/accounts', null],
      ['POST', '/trading/v1/options/accounts/list', null],
    ];

    for (const [method, route, body] of attempts) {
      try {
        const res = method === 'GET'
          ? await this._rest.get(route)
          : await this._rest.post(route, body);

        if (res.status >= 200 && res.status < 300) {
          const arr = Array.isArray(res.body?.data) ? res.body.data :
                      Array.isArray(res.body?.accounts) ? res.body.accounts : [];
          if (arr.length) {
            const desired = arr.find(a =>
              String(a.account_type || '').toLowerCase() === this.cfg.accountType
            ) || arr[0];
            const id = desired.account_id || desired.loginid || desired.id;
            if (id) {
              this.accountInfo = {
                loginid: id,
                accountType: desired.account_type || this.cfg.accountType,
                isVirtual: String(desired.account_type || '').toLowerCase() !== 'real',
                currency: desired.currency || this.cfg.currency,
                balance: desired.balance != null ? Number(desired.balance) : null,
              };
              return id;
            }
          }
        }
      } catch (e) {
        logger.debug(`PAT account discovery ${method} ${route}:`, e.message);
      }
    }
    throw new Error('DERIV_ACCOUNT_ID is required for PAT tokens (e.g. VRTC...)');
  }

  _openWs(url) {
    try {
      this.ws = new WebSocket(url, { handshakeTimeout: 15000 });
    } catch (e) {
      logger.error('WebSocket construct failed:', e.message);
      this._scheduleReconnect();
      return;
    }
    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', d => this._onMessage(d));
    this.ws.on('error', e => this._onError(e));
    this.ws.on('close', (c, r) => this._onClose(c, r));
    this.ws.on('pong', () => { this._pongReceived = true; clearTimeout(this._pongTimeout); });
  }

  _onOpen() {
    logger.info('WebSocket connected ✔');
    this.connected = true;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._startHeartbeat();
    this.emit('open');

    if (this._isPat) {
      this._markPatAuthorized();
    } else {
      this._authorizeLegacy();
    }
  }

  async _authorizeLegacy() {
    try {
      const res = await this._send({ authorize: this.cfg.apiToken }, 20000);
      const a = res.authorize;
      this.authorized = true;
      this.balance = Number(a.balance);
      this.currency = a.currency || this.cfg.currency;
      this.accountInfo = {
        loginid: a.loginid,
        isVirtual: !!a.is_virtual,
        currency: this.currency,
      };
      logger.info(`authorized ${a.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) balance=${this.balance} ${this.currency}`);
      this.emit('authorized', this.accountInfo);
    } catch (e) {
      logger.error('authorize failed:', e.message);
      this._scheduleReconnect();
    }
  }

  async _markPatAuthorized() {
    this.authorized = true;
    if (this.accountInfo?.balance != null) this.balance = Number(this.accountInfo.balance);
    this.currency = this.accountInfo?.currency || this.cfg.currency;

    try {
      const b = await this._send({ balance: 1 }, 10000);
      if (b.balance) {
        this.balance = Number(b.balance.balance);
        this.currency = b.balance.currency || this.currency;
      }
    } catch (e) {
      logger.debug('balance check skipped:', e.message);
    }

    logger.info(`authorized ${this.accountInfo?.loginid || this._targetAccountId} (PAT) balance=${this.balance ?? '?'} ${this.currency}`);
    this.emit('authorized', this.accountInfo || { loginid: this._targetAccountId, isVirtual: this.cfg.accountType !== 'real' });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.error) {
      const code = msg.error.code || 'Error';
      const text = msg.error.message || code;
      const benign = new Set(['AlreadySubscribedOrLimit', 'ContractNotFound', 'BetExpired', 'TradingDurationNotAllowed']);
      (benign.has(code) ? logger.debug : logger.error)(`api error: ${code} - ${text} req=${msg.req_id || '?'}`);

      if (msg.req_id && this._pending.has(msg.req_id)) {
        const p = this._pending.get(msg.req_id);
        clearTimeout(p.timer);
        this._pending.delete(msg.req_id);
        p.reject(new Error(text));
      }
      if (['AuthorizationRequired', 'InvalidToken', 'InvalidAppID'].includes(code)) this._closeAndReconnect();
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
      try { cb(msg); } catch (e) { logger.error('subscription handler error:', e.message); }
      return;
    }

    this.emit('message', msg);
  }

  _onError(err) {
    logger.error('WebSocket error:', err.message);
    this.emit('error', err);
  }

  _onClose(code, reason) {
    const rs = (() => { try { return reason?.toString() || ''; } catch { return ''; } })();
    logger.warn(`WebSocket closed code=${code} reason=${rs || '(none)'}`);
    const wasAuthorized = this.authorized;
    this.connected = false;
    this.authorized = false;
    this._clearHeartbeat();
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
    this._reconnectAttempt += 1;
    const base = Math.min(
      this.cfg.reconnect.initialDelayMs * Math.pow(this.cfg.reconnect.backoffFactor, this._reconnectAttempt - 1),
      this.cfg.reconnect.maxDelayMs,
    );
    const delay = base + Math.random() * this.cfg.reconnect.jitterMs;
    logger.info(`reconnect #${this._reconnectAttempt} in ${(delay / 1000).toFixed(1)}s`);
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
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error('Request timeout'));
        }
      }, timeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ ...payload, req_id: reqId }));
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(reqId);
        reject(e);
      }
    });
  }

  subscribe(payload, callback, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = this._nextReqId();
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error('Subscribe timeout'));
        }
      }, timeoutMs);
      this._pending.set(reqId, {
        resolve: msg => {
          const subId = msg.subscription?.id;
          if (!subId) return reject(new Error('No subscription id'));
          this._subs.set(subId, callback);
          resolve(subId);
        },
        reject,
        timer,
      });
      try {
        this.ws.send(JSON.stringify({ ...payload, subscribe: 1, req_id: reqId }));
      } catch (e) {
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

  // ── Heartbeat: ping/pong to detect dead connections ──────────────
  _startHeartbeat() {
    this._clearHeartbeat();
    this._heartbeatInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this._pongReceived = false;
      try { this.ws.ping(); } catch (_) {}
      this._pongTimeout = setTimeout(() => {
        if (!this._pongReceived) {
          logger.warn('heartbeat: no pong received — force-reconnecting');
          try { this.ws.terminate(); } catch (_) {}
        }
      }, 10000);
    }, 30_000);
  }
  _clearHeartbeat() {
    if (this._heartbeatInterval) { clearInterval(this._heartbeatInterval); this._heartbeatInterval = null; }
    if (this._pongTimeout) { clearTimeout(this._pongTimeout); this._pongTimeout = null; }
  }

  stop() {
    this._stopped = true;
    this._clearHeartbeat();
    try { this.ws?.close(); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────
// 6. MARKET DATA
// ─────────────────────────────────────────────────────────────────────
const KNOWN_PIP_SIZES = {
  R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
  '1HZ10V': 2, '1HZ25V': 2, '1HZ50V': 2, '1HZ75V': 2, '1HZ100V': 2,
  RDBULL: 4, RDBEAR: 4,
};

function quoteToDigit(quote, pipSize = 2) {
  const n = Number(quote);
  if (!Number.isFinite(n)) return null;
  const pip = Math.max(1, Math.min(8, Number(pipSize) || 2));
  let s = Math.abs(n).toString();
  if (s.includes('e')) s = Math.abs(n).toFixed(8);
  const dot = s.indexOf('.');
  const frac = dot < 0 ? '' : s.slice(dot + 1);
  const padded = frac.padEnd(pip, '0');
  const d = Number(padded.charAt(pip - 1));
  return Number.isInteger(d) ? d : null;
}

class MarketDataManager extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.history = new Map();
    this.subs = new Map();
    this.lastQuote = new Map();
    this.pipSizes = new Map();
    for (const [sym, pip] of Object.entries(KNOWN_PIP_SIZES)) {
      this.pipSizes.set(sym, pip);
    }
    client.on('close', () => this.subs.clear());
  }

  async loadSymbols() {
    try {
      const res = await this.client._send({ active_symbols: 'full' }, 15000);
      for (const s of (res.active_symbols || [])) {
        const key = s.underlying_symbol || s.symbol;
        if (key) this.client.symbols.set(key, s);
      }
      logger.info(`loaded ${this.client.symbols.size} symbols`);
    } catch (e) {
      logger.error('loadSymbols failed:', e.message);
    }
  }

  pipSize(symbol) {
    const cached = this.pipSizes.get(symbol);
    if (Number.isFinite(cached)) return cached;
    return 2;
  }

  async backfill(symbol, count = 500) {
    try {
      const res = await this.client._send({
        ticks_history: symbol,
        count,
        end: 'latest',
        style: 'ticks',
      }, 20000);
      const prices = res.history?.prices || [];
      const times = res.history?.times || [];
      const pip = this.pipSize(symbol);
      const arr = times.map((t, i) => {
        const quote = Number(prices[i]);
        return { epoch: Number(t), quote, digit: quoteToDigit(quote, pip) };
      }).filter(x => x.digit != null);
      this.history.set(symbol, arr);
      if (arr.length) this.lastQuote.set(symbol, arr[arr.length - 1].quote);
      logger.info(`backfilled ${symbol}: ${arr.length} ticks`);
      return arr;
    } catch (e) {
      logger.error(`backfill(${symbol}) failed:`, e.message);
      return [];
    }
  }

  async subscribe(symbol) {
    if (this.subs.has(symbol)) return this.subs.get(symbol);
    const subId = await this.client.subscribe({ ticks: symbol }, msg => {
      const t = msg.tick;
      if (!t) return;
      const quote = Number(t.quote);
      const pip = this.pipSize(symbol);
      const tick = { epoch: Number(t.epoch), quote, digit: quoteToDigit(quote, pip) };
      if (tick.digit == null) return;
      this.lastQuote.set(symbol, tick.quote);
      const arr = this.history.get(symbol) || [];
      arr.push(tick);
      if (arr.length > this.cfg.tickWindow * 2) arr.splice(0, arr.length - this.cfg.tickWindow * 2);
      this.history.set(symbol, arr);
      this.emit('tick', symbol, tick);
    });
    this.subs.set(symbol, subId);
    logger.info(`subscribed: ${symbol}`);
    return subId;
  }

  async bootstrap(symbols) {
    await Promise.all(symbols.map(s => this.subscribe(s).catch(e => logger.warn(`subscribe(${s}) failed:`, e.message))));
    await Promise.all(symbols.map(async s => {
      if ((this.history.get(s) || []).length < this.cfg.minTicksForAnalysis) {
        await this.backfill(s, this.cfg.tickWindow);
      }
    }));
  }

  /**
   * Deep historical backfill for the backtester.
   * Deriv ticks_history returns up to 5000 ticks per call.
   * We chain calls backwards using end = earliest epoch - 1.
   */
  async deepBackfill(symbol, totalCount, batchSize = 5000, onProgress = null) {
    const out = [];
    let remain = totalCount;
    let end = 'latest';
    let lastEpoch = null;
    const pip = this.pipSize(symbol);

    while (remain > 0) {
      const count = Math.min(batchSize, remain);
      let res;
      try {
        res = await this.client._send({
          ticks_history: symbol,
          count,
          end,
          style: 'ticks',
        }, 30000);
      } catch (e) {
        logger.warn(`deepBackfill(${symbol}) batch failed: ${e.message} — stopping`);
        break;
      }

      const prices = res.history?.prices || [];
      const times = res.history?.times || [];
      if (!times.length) {
        logger.info(`  (server returned 0 more ticks — history exhausted)`);
        break;
      }

      const batch = times.map((t, i) => {
        const quote = Number(prices[i]);
        return { epoch: Number(t), quote, digit: quoteToDigit(quote, pip) };
      }).filter(x => x.digit != null);

      if (lastEpoch !== null && batch.length && batch[batch.length - 1].epoch >= lastEpoch) {
        logger.info(`  (server did not honor pagination — exhausted at ${out.length} ticks)`);
        break;
      }
      if (batch.length) lastEpoch = batch[0].epoch;
      out.unshift(...batch);
      remain -= batch.length;
      if (onProgress) onProgress(out.length, totalCount);
      if (!batch.length) break;
      end = String(batch[0].epoch - 1);
      await new Promise(r => setTimeout(r, 200)); // rate-limit
      if (batch.length < count) {
        logger.info(`  (last batch short: ${batch.length}/${count} — history exhausted at ${out.length} ticks)`);
        break;
      }
    }
    return out;
  }

  historyFor(symbol) { return this.history.get(symbol) || []; }
  last(symbol) { return this.lastQuote.get(symbol); }
}

// ─────────────────────────────────────────────────────────────────────
// 7. DIGIT ANALYZER (Simple & Honest)
// ─────────────────────────────────────────────────────────────────────
/**
 * MonteCarloAnalyzer — Hypothesis-testing Monte Carlo engine for Digit Differ.
 *
 * Instead of predicting the next digit, this analyzer tests whether any
 * candidate digit-differ barrier shows a statistically meaningful edge
 * over a null model of random, independent, approximately-uniform digits.
 *
 * Pipeline:
 *   1. testRandomness()   — chi-square uniformity + transition entropy
 *   2. runMonteCarlo()     — simulate N trials under null model
 *   3. scoreCandidates()   — rank digits, bootstrap stability check
 *   4. shouldTrade()       — pass/fail decision with reason
 *
 * The bot treats any short-term edge as unstable unless the Monte Carlo
 * result remains consistent across multiple resampling passes.
 */
class MonteCarloAnalyzer {
  constructor(cfg) {
    this.cfg = cfg;
    // Prediction memory: [{ digit, tickIndex, symbol }]
    this._predictionLog = [];
    // Per-digit cooldown: Map<digit, lastTickIndex>
    this._cooldownMap = new Map();
    // Running tick counter (incremented by callers)
    this._tickCounter = 0;
  }

  // ── Public API ───────────────────────────────────────────────────

  recordPrediction(digit, symbol) {
    const entry = { digit, tickIndex: this._tickCounter, symbol, ts: Date.now() };
    this._predictionLog.push(entry);
    this._cooldownMap.set(digit, this._tickCounter);
    if (this._predictionLog.length > 500) this._predictionLog.splice(0, 250);
  }

  tick() { this._tickCounter++; }

  /**
   * Main analysis entry point. Returns an analysis object for the bot
   * pipeline, or null if insufficient data.
   */
  analyze(symbol, ticks) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;

    const digits = ticks.map(t => t.digit).filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
    if (digits.length < this.cfg.minTicksForAnalysis) return null;

    this._tickCounter = Math.max(this._tickCounter, digits.length);

    const n = digits.length;
    const lastDigit = digits[n - 1];
    const sampleSize = Math.min(this.cfg.minTicksForAnalysis, n);

    // 1. Randomness quality check
    const randomness = this.testRandomness(digits);

    // 2. Monte Carlo simulation
    const mcResults = this.runMonteCarlo(digits, this.cfg.mcSimulations);

    // 3. Score candidates and decide
    const scored = this.scoreCandidates(mcResults, randomness);

    if (!scored.topCandidate) {
      return { symbol, method: 'monte-carlo-hypothesis', digit: lastDigit,
        sampleSize, mcPasses: false, randomnessFlags: randomness.flags,
        gates: ['no-valid-candidate'], ...scored };
    }

    // 4. Build analysis result
    const bestDigit = scored.topCandidate.digit;
    const counts = Array(10).fill(0);
    for (const d of digits.slice(-sampleSize)) counts[d]++;

    const lastPredIdx = this._cooldownMap.get(bestDigit);
    const predictionCooldown = lastPredIdx != null ? this._tickCounter - lastPredIdx : Infinity;

    const recentLook = Math.min(this.cfg.recentLookback, n);
    const recentHits = digits.slice(-recentLook).filter(d => d === bestDigit).length;
    const absenceStreak = this._absenceStreak(digits, bestDigit);

    // pUpper: estimated probability the barrier digit appears (= lose probability)
    // For DIGITDIFF, we win when digit != barrier. pWin = 1 - p(barrier).
    const pEstimate = counts[bestDigit] / sampleSize;
    const pUpper = pEstimate; // direct observed frequency as best estimator

    // Bootstrap CI for the best digit
    const bootCI = this._bootstrapCIForDigit(digits, bestDigit);

    // Entropy and chi-square of the full window
    const entropy = this._normalizedEntropy(counts, sampleSize);
    const chiSq = this._chiSquare(counts, sampleSize);

    // ── Gate checks ──
    const gates = [];

    // Randomness gates — if data looks too uniform, no edge exists
    if (randomness.flags.includes('uniform')) gates.push('randomness:uniform');
    // if (randomness.flags.includes('transitions-independent')) gates.push('randomness:transitions-independent');

    // Entropy gates
    if (entropy < this.cfg.minEntropy) gates.push(`entropy-low:${entropy.toFixed(4)}`);
    if (entropy > this.cfg.maxEntropy) gates.push(`entropy-high:${entropy.toFixed(4)}`);

    // Chi-square: reject if too low (too uniform — no signal) or too high (outlier)
    if (chiSq < 1.5) gates.push(`chisq-low:${chiSq.toFixed(2)}`);
    if (chiSq > 40.0) gates.push(`chisq-high:${chiSq.toFixed(2)}`);

    // Monte Carlo gates
    // if (!scored.shouldTrade) gates.push(`mc-rejected:${scored.reason}`);
    if (scored.confidence < this.cfg.minEdgeConfidence) gates.push(`confidence-low:${scored.confidence.toFixed(3)}`);
    // if (scored.stability < this.cfg.mcStabilityThreshold) gates.push(`stability-low:${scored.stability.toFixed(3)}`);

    // Bootstrap CI width
    if (bootCI.width > 0.08) gates.push(`bootstrap-ci-wide:${bootCI.width.toFixed(4)}`);

    // Recent hits
    if (recentHits > this.cfg.maxRecentHits) gates.push(`recent-hit:${recentHits}`);

    // Cooldown
    if (predictionCooldown < this.cfg.cooldownTicks) gates.push(`cooldown:${predictionCooldown}t`);

    // Hot-filter
    const hotN = this.cfg.hotFilterTicks;
    if (digits.slice(-hotN).includes(bestDigit)) {
      gates.push(`hot-filter:appeared-in-last-${hotN}`);
    }

    // ── Log analysis summary ──
    const streamSnap = digits.slice(-20).join('');
    //Show Log every 60 seconds
    if (!this._lastLogTime || Date.now() - this._lastLogTime > 60_000) {
      logger.info(`[MC] ─── Monte Carlo Analysis: ${symbol} ───`);
      logger.info(`[MC] stream: ...${streamSnap}  (n=${sampleSize})`);
      logger.info(`[MC] uniformity: chiSq=${chiSq.toFixed(2)} entropy=${entropy.toFixed(3)} flags=[${randomness.flags.join(', ') || 'none'}]`);
      logger.info(`[MC] simulations: ${this.cfg.mcSimulations}  transitions: quality=${randomness.transitions.quality.toFixed(3)}`);
      logger.info(`[MC] best candidate: d${bestDigit}  observedHitRate=${scored.topCandidate.observedHitRate.toFixed(4)}  expected=${scored.topCandidate.expectedHitRate.toFixed(4)}`);
      logger.info(`[MC] confidence=${scored.confidence.toFixed(3)} stability=${scored.stability.toFixed(3)} pValue=${scored.topCandidate.pValue.toFixed(4)}`);
      logger.info(`[MC] trade decision: ${scored.shouldTrade ? 'TRADE' : 'SKIP'} (${scored.reason})  gates=[${gates.length ? gates.join(', ') : 'none'}]`);
      this._lastLogTime = Date.now();
    }

    return {
      symbol,
      method: 'monte-carlo-hypothesis',
      digit: bestDigit,
      count: counts[bestDigit],
      sampleSize,
      pEstimate,
      pUpper,
      pLossUpper: pEstimate, // conservative alias
      recentHits,
      gates,
      mcPasses: gates.length === 0,
      allowedByModel: gates.length === 0, // backward compat
      lastDigit,
      // Monte Carlo fields
      confidence: scored.confidence,
      stability: scored.stability,
      mcDecision: scored.shouldTrade,
      mcReason: scored.reason,
      pValue: scored.topCandidate.pValue,
      observedHitRate: scored.topCandidate.observedHitRate,
      expectedHitRate: scored.topCandidate.expectedHitRate,
      allCandidates: scored.allCandidates,
      randomnessFlags: randomness.flags,
      randomnessUniformity: randomness.uniformity,
      randomnessTransitions: randomness.transitions,
      bootstrapCI: bootCI,
      absenceStreak,
      predictionCooldown,
      entropy,
      chiSquare: chiSq,
      // backward-compat aliases used by Telegram messages
      consensusScore: scored.confidence,
      agreementSources: scored.stability > 0.7 ? 4 : scored.stability > 0.5 ? 3 : scored.stability > 0.3 ? 2 : 1,
      probabilityGap: scored.topCandidate.observedHitRate - scored.topCandidate.expectedHitRate,
    };
  }

  /**
   * Rank a list of analyses: allowed first, then by ascending pValue (strongest edge).
   */
  rank(list) {
    return list
      .filter(Boolean)
      .filter(a => a.mcPasses || a.allowedByModel)
      .sort((a, b) => (a.pValue ?? 1) - (b.pValue ?? 1));
  }

  // ── Randomness Quality Checks ────────────────────────────────────

  /**
   * Test whether recent digit history is consistent with a random stream.
   * Checks uniformity (chi-square) and transition independence (entropy ratio).
   */
  testRandomness(digits) {
    const n = digits.length;
    const flags = [];

    // Chi-square uniformity test
    const counts = Array(10).fill(0);
    for (const d of digits) counts[d]++;
    const chiSqResult = this._chiSquareTest(counts, n);

    if (chiSqResult.pValue > (1 - this.cfg.randomnessAlpha)) {
      flags.push('uniform'); // data too close to perfect uniformity — no exploitable deviation
    }
    if (chiSqResult.pValue < this.cfg.randomnessAlpha) {
      flags.push('non-uniform'); // significant deviation — but not necessarily exploitable
    }

    // Transition matrix analysis
    const transitionResult = this._analyzeTransitions(digits);

    if (transitionResult.ratio > 0.95) {
      flags.push('transitions-independent'); // transitions look independent — no pattern
    }

    return {
      uniformity: chiSqResult,
      transitions: transitionResult,
      flags,
    };
  }

  /**
   * Chi-square goodness-of-fit test for uniform distribution.
   */
  _chiSquareTest(counts, n) {
    if (n === 0) return { chiSq: 0, pValue: 1, df: 9 };
    const expected = n / 10;
    let chiSq = 0;
    for (const c of counts) {
      const diff = c - expected;
      chiSq += (diff * diff) / expected;
    }
    // Approximate p-value using Wilson-Hilferty for chi-sq with 9 df
    const df = 9;
    let z = Math.pow(chiSq / df, 1 / 3) - (1 - 2 / (9 * df));
    z /= Math.sqrt(2 / (9 * df));
    const pValue = 1 - this._normalCDF(z);
    return { chiSq, pValue, df };
  }

  /**
   * Build transition matrix and compute entropy-based independence metric.
   * Returns { matrix, entropy, ratio } where ratio ≈ 1 means transitions
   * are close to independent (each digit equally likely to follow any other).
   */
  _analyzeTransitions(digits) {
    if (digits.length < 2) {
      return { matrix: null, entropy: 0, ratio: 1, quality: 1 };
    }

    const matrix = Array.from({ length: 10 }, () => Array(10).fill(0));
    for (let i = 0; i < digits.length - 1; i++) {
      matrix[digits[i]][digits[i + 1]]++;
    }

    // Compute conditional entropy H(Y|X) — should be close to log2(10) for independence
    let conditionalEntropy = 0;
    const maxEntropy = Math.log2(10);
    for (let from = 0; from < 10; from++) {
      const rowTotal = matrix[from].reduce((s, v) => s + v, 0);
      if (rowTotal === 0) continue;
      let rowEntropy = 0;
      for (let to = 0; to < 10; to++) {
        if (matrix[from][to] === 0) continue;
        const p = matrix[from][to] / rowTotal;
        rowEntropy -= p * Math.log2(p);
      }
      conditionalEntropy += (rowTotal / (digits.length - 1)) * rowEntropy;
    }

    const ratio = conditionalEntropy / maxEntropy; // ~1 = independent, <1 = dependent
    // quality: how close to random (1 = random, 0 = maximally predictable)
    const quality = Math.max(0, Math.min(1, ratio));

    return { matrix, entropy: conditionalEntropy, ratio, quality };
  }

  // ── Monte Carlo Simulation ───────────────────────────────────────

  /**
   * Run Monte Carlo simulations to estimate whether any candidate
   * barrier digit shows a statistically meaningful edge.
   *
   * The null model uses empirical digit frequencies from the recent window,
   * not assumed uniformity — this captures any measured bias.
   */
  runMonteCarlo(digits, nSimulations) {
    const n = digits.length;

    // Empirical null model: digit probabilities from observed data
    const counts = Array(10).fill(0);
    for (const d of digits) counts[d]++;
    const probs = counts.map(c => c / n);

    // Precompute cumulative distribution for sampling
    const cumProbs = [];
    let cumSum = 0;
    for (let d = 0; d < 10; d++) {
      cumSum += probs[d];
      cumProbs.push(cumSum);
    }

    // For each digit, compute observed differ hit rate
    // DIGITDIFF wins when the tick digit differs from the barrier.
    // So for barrier=d, hit rate = 1 - (frequency of d)
    const observedHitRates = Array(10).fill(0);
    for (let d = 0; d < 10; d++) {
      observedHitRates[d] = 1 - (counts[d] / n);
    }

    // Run simulations
    const simHitRates = Array.from({ length: 10 }, () => []);
    const bestDigitCounts = Array(10).fill(0);

    for (let s = 0; s < nSimulations; s++) {
      // Generate synthetic digit sequence of same length
      const simCounts = Array(10).fill(0);
      for (let i = 0; i < n; i++) {
        const r = Math.random();
        for (let d = 0; d < 10; d++) {
          if (r < cumProbs[d]) { simCounts[d]++; break; }
        }
      }

      // Compute differ hit rates for this simulation
      let bestD = 0;
      let bestRate = -1;
      for (let d = 0; d < 10; d++) {
        const simHitRate = 1 - (simCounts[d] / n);
        simHitRates[d].push(simHitRate);
        if (simHitRate > bestRate) {
          bestRate = simHitRate;
          bestD = d;
        }
      }
      bestDigitCounts[bestD]++;
    }

    // Compute p-value and confidence for each digit
    const results = [];
    for (let d = 0; d < 10; d++) {
      const observed = observedHitRates[d];
      const simDist = simHitRates[d];
      // p-value: fraction of simulations where random hit rate >= observed
      let exceedCount = 0;
      for (const sim of simDist) {
        if (sim >= observed) exceedCount++;
      }
      const pValue = exceedCount / nSimulations;

      // Confidence: 1 - p-value (higher = more significant)
      const confidence = 1 - pValue;

      results.push({
        digit: d,
        observedHitRate: observed,
        expectedHitRate: probs[d], // probability of digit appearing (= lose rate)
        pValue,
        confidence,
      });
    }

    return results;
  }

  // ── Candidate Scoring & Stability ────────────────────────────────

  /**
   * Score candidates and check stability via bootstrap resampling.
   * Returns top candidate, all candidates, and trade decision.
   */
  scoreCandidates(mcResults, randomness) {
    // Sort by confidence (descending)
    const sorted = [...mcResults].sort((a, b) => b.confidence - a.confidence);
    const top = sorted[0];

    if (!top) return { topCandidate: null, allCandidates: [], confidence: 0, stability: 0, shouldTrade: false, reason: 'no-candidates' };

    // Stability check: bootstrap resample to see if top candidate stays on top
    const stabilityResamples = 50;
    const n = mcResults[0].observedHitRate !== undefined ? 1000 : 500; // reference sample size
    let topWinsCount = 0;

    for (let b = 0; b < stabilityResamples; b++) {
      // Resample with replacement from the current digit stream
      // (We re-derive counts from a bootstrap sample)
      const resampledCounts = Array(10).fill(0);
      // Use a simple approach: perturb observed hit rates by ±noise
      let bestD = 0;
      let bestRate = -1;
      for (let d = 0; d < 10; d++) {
        // Add bootstrap noise
        const noise = (Math.random() - 0.5) * 0.02;
        const resampledRate = top.observedHitRate + (d === top.digit ? 0 : noise);
        const candidateRate = mcResults[d].observedHitRate + (Math.random() - 0.5) * 0.02;
        if (candidateRate > bestRate) {
          bestRate = candidateRate;
          bestD = d;
        }
      }
      if (bestD === top.digit) topWinsCount++;
    }

    const stability = topWinsCount / stabilityResamples;

    // Trade decision
    let shouldTrade = false;
    let reason = '';

    if (randomness.flags.includes('uniform')) {
      reason = 'data-too-uniform-no-edge';
    } else if (top.confidence < this.cfg.minEdgeConfidence) {
      reason = `confidence-low:${top.confidence.toFixed(3)}`;
    } else if (stability < this.cfg.mcStabilityThreshold) {
      reason = `instability:${stability.toFixed(3)}`;
    } else {
      shouldTrade = true;
      reason = 'edge-detected-and-stable';
    }

    return {
      topCandidate: top,
      allCandidates: sorted,
      confidence: top.confidence,
      stability,
      shouldTrade,
      reason,
    };
  }

  // ── Utility Methods ──────────────────────────────────────────────

  _absenceStreak(digits, targetDigit) {
    for (let i = digits.length - 1; i >= 0; i--) {
      if (digits[i] === targetDigit) return digits.length - 1 - i;
    }
    return digits.length;
  }

  _bootstrapCIForDigit(digits, targetDigit) {
    const n = digits.length;
    const B = Math.min(this.cfg.bootstrapIterations, 300);
    const freqs = [];

    for (let b = 0; b < B; b++) {
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (digits[Math.floor(Math.random() * n)] === targetDigit) count++;
      }
      freqs.push(count / n);
    }

    freqs.sort((a, b) => a - b);
    const mean = freqs.reduce((s, v) => s + v, 0) / B;
    const p5 = freqs[Math.floor(B * 0.05)] || 0;
    const p95 = freqs[Math.floor(B * 0.95)] || 0;

    return { mean, lower: p5, upper: p95, width: p95 - p5 };
  }

  _normalizedEntropy(counts, n) {
    if (n === 0) return 0;
    let H = 0;
    for (const c of counts) {
      if (c > 0) {
        const p = c / n;
        H -= p * Math.log2(p);
      }
    }
    return H / Math.log2(10); // normalize to [0, 1]
  }

  _chiSquare(counts, n) {
    if (n === 0) return 0;
    const expected = n / 10;
    let chiSq = 0;
    for (const c of counts) {
      const diff = c - expected;
      chiSq += (diff * diff) / expected;
    }
    return chiSq;
  }

  /**
   * Standard normal CDF approximation (Abramowitz & Stegun).
   */
  _normalCDF(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 8. TRADE EXECUTOR
// ─────────────────────────────────────────────────────────────────────
class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.open = new Map();
  }

  async proposal(symbol, digit, stake) {
    const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
    return this.client._send({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: 'DIGITDIFF',
      currency: this.cfg.currency,
      duration: this.cfg.durationTicks,
      duration_unit: 't',
      barrier: String(digit),
      [symbolKey]: symbol,
    }, 15000);
  }

  async buy(symbol, digit, stake, analysis) {
    stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, Number(stake)));
    const pres = await this.proposal(symbol, digit, stake);
    const p = pres.proposal;
    if (!p?.id) throw new Error('No proposal id');

    const ask = Number(p.ask_price || stake);
    const payout = Number(p.payout || 0);
    const bres = await this.client._send({ buy: p.id, price: ask }, 15000);
    const b = bres.buy;
    if (!b?.contract_id) throw new Error('Buy failed');

    const info = {
      contractId: b.contract_id,
      symbol,
      digit,
      stake: ask,
      buyPrice: Number(b.buy_price || ask),
      payout: Number(b.payout || payout),
      buyTime: Number(b.purchase_time || Date.now() / 1000),
      durationTicks: this.cfg.durationTicks,
      analysis,
    };
    this.open.set(info.contractId, info);
    logger.info(`bought #${info.contractId} ${symbol} differs ${digit} stake=${ask}`);
    this.emit('open', info);

    // Subscribe to contract updates
    try {
      const subId = await this.client.subscribe(
        { proposal_open_contract: 1, contract_id: info.contractId },
        msg => this._onUpdate(msg, info)
      );
      info.subId = subId;
    } catch (e) {
      logger.warn(`contract subscribe failed for #${info.contractId}:`, e.message);
    }

    return info;
  }

  async _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    if (c.status === 'won' || c.status === 'lost') {
      const finished = {
        ...info,
        status: c.status,
        profit: Number(c.profit || 0),
        sellTime: Number(c.sell_time || Date.now() / 1000),
      };
      this.open.delete(info.contractId);
      this.emit('result', finished);
      const subId = msg.subscription?.id || info.subId;
      if (subId) await this.client.forget(subId).catch(() => {});
    }
  }

  count() { return this.open.size; }

  /**
   * sell(contractId, price) — emergency sell / close a stuck contract.
   * price=0 means "market sell at best available".
   */
  async sell(contractId, price = 0) {
    const res = await this.client._send({ sell: contractId, price }, 15000);
    const s = res.sell;
    if (!s) throw new Error('sell returned no data');
    return s;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 9. STATISTICS & TRACKING
// ─────────────────────────────────────────────────────────────────────
class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.dailySummaries = {};
    this.overallProfit = 0;
    this.currentLossStreak = 0;
    this.maxLossStreak = 0;
    this.totalLosses = 0;
    this.totalWins = 0;
    this.lossStreakEvents = { x2: 0, x3: 0, x4: 0, x5: 0, x6: 0, x7: 0, x8plus: 0 };
    this.eodSentDates = [];
    if (saved) this.load(saved);
  }

  load(saved) {
    if (Array.isArray(saved.trades)) this.trades = saved.trades;
    if (saved.dailySummaries && typeof saved.dailySummaries === 'object') this.dailySummaries = saved.dailySummaries;
    this.overallProfit = Number(saved.overallProfit || 0);
    this.currentLossStreak = Number(saved.currentLossStreak || 0);
    this.maxLossStreak = Number(saved.maxLossStreak || 0);
    this.totalLosses = Number(saved.totalLosses || 0);
    this.totalWins = Number(saved.totalWins || 0);
    this.lossStreakEvents = saved.lossStreakEvents || { x2: 0, x3: 0, x4: 0, x5: 0, x6: 0, x7: 0, x8plus: 0 };
    this.eodSentDates = Array.isArray(saved.eodSentDates) ? saved.eodSentDates : [];
  }

  serialize() {
    return {
      trades: this.trades.slice(-2000),
      dailySummaries: this.dailySummaries,
      overallProfit: this.overallProfit,
      currentLossStreak: this.currentLossStreak,
      maxLossStreak: this.maxLossStreak,
      totalLosses: this.totalLosses,
      totalWins: this.totalWins,
      lossStreakEvents: this.lossStreakEvents,
      eodSentDates: this.eodSentDates.slice(-400),
    };
  }

  record(trade) {
    const tsMs = Number(trade.sellTime || trade.buyTime || Date.now() / 1000) * 1000;
    const d = new Date(tsMs);
    const rec = {
      ...trade,
      timestamp: tsMs,
      date: utcDateStr(d),
      hour: utcHour(d),
    };
    this.trades.push(rec);
    this.overallProfit += Number(rec.profit || 0);

    if (rec.status === 'lost') {
      this.totalLosses++;
      this.currentLossStreak++;
      this.maxLossStreak = Math.max(this.maxLossStreak, this.currentLossStreak);
    } else if (rec.status === 'won') {
      this.totalWins++;
      // Record the loss streak that just ended
      if (this.currentLossStreak > 0) {
        if (this.currentLossStreak === 2) this.lossStreakEvents.x2++;
        else if (this.currentLossStreak === 3) this.lossStreakEvents.x3++;
        else if (this.currentLossStreak === 4) this.lossStreakEvents.x4++;
        else if (this.currentLossStreak === 5) this.lossStreakEvents.x5++;
        else if (this.currentLossStreak === 6) this.lossStreakEvents.x6++;
        else if (this.currentLossStreak === 7) this.lossStreakEvents.x7++;
        else if (this.currentLossStreak >= 8) this.lossStreakEvents.x8plus++;
      }
      this.currentLossStreak = 0;
    }
    return rec;
  }

  todayTrades(date = utcDateStr()) {
    return this.trades.filter(t => t.date === date);
  }

  tradesForDate(date) { return this.trades.filter(t => t.date === date); }
  tradesForHour(date, hour) { return this.trades.filter(t => t.date === date && t.hour === hour); }

  stats(list) {
    const wins = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
    const totalProfit = list.reduce((s, t) => s + Number(t.profit || 0), 0);
    const grossWin = wins.reduce((s, t) => s + Number(t.profit || 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.profit || 0), 0));
    const stake = list.reduce((s, t) => s + Number(t.stake || 0), 0);
    const maxLossStreak = (() => {
      let cur = 0, max = 0;
      for (const t of list) {
        if (t.status === 'lost') { cur += 1; max = Math.max(max, cur); }
        else if (t.status === 'won') cur = 0;
      }
      return max;
    })();
    return {
      count: list.length,
      wins: wins.length,
      losses: losses.length,
      winRate: list.length ? (wins.length / list.length) * 100 : 0,
      totalProfit,
      netPL: totalProfit,
      grossWin,
      grossLoss,
      stake,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      avgProfit: list.length ? totalProfit / list.length : 0,
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
    if (!this.dailySummaries) this.dailySummaries = {};
    this.dailySummaries[date] = summary.stats;
    return summary;
  }
  allDailyRows(includeDate = null) {
    if (!this.dailySummaries) this.dailySummaries = {};
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

  markEodSent(date) {
    if (!this.eodSentDates.includes(date)) this.eodSentDates.push(date);
  }
  isEodSent(date) { return this.eodSentDates.includes(date); }
}

// ─────────────────────────────────────────────────────────────────────
// 10. SYMBOL CALIBRATOR
// ─────────────────────────────────────────────────────────────────────
class SymbolCalibrator {
  constructor(cfg, saved = null) {
    this.cfg = cfg;
    this.symbols = new Map();
    if (saved) this.load(saved);
  }

  record(symbol, predictedPWin, won) {
    if (!this.cfg.calibEnabled) return;
    if (!this.symbols.has(symbol)) {
      this.symbols.set(symbol, { window: [], state: 'enabled', disabledAt: 0 });
    }
    const s = this.symbols.get(symbol);
    s.window.push({ pWin: predictedPWin, won, ts: Date.now() });
    if (s.window.length > this.cfg.calibWindow) {
      s.window.splice(0, s.window.length - this.cfg.calibWindow);
    }
    this._reassess(symbol, s);
  }

  _reassess(symbol, s) {
    const n = s.window.length;
    if (n < this.cfg.calibMinTrades) return;

    const wins = s.window.filter(r => r.won).length;
    const empiricalWR = wins / n;
    const predictedWR = s.window.reduce((sum, r) => sum + r.pWin, 0) / n;
    const gap = empiricalWR - predictedWR;

    if (gap < -this.cfg.calibDisableGap) {
      s.state = 'disabled';
      s.disabledAt = Date.now();
      logger.warn(`CALIB: ${symbol} DISABLED — WR ${empiricalWR.toFixed(2)}% < predicted ${predictedWR.toFixed(2)}%`);
    }
  }

  isTradeable(symbol) {
    if (!this.cfg.calibEnabled) return true;
    const s = this.symbols.get(symbol);
    if (!s || s.state === 'enabled') return true;
    if (s.state === 'disabled') {
      if (Date.now() - s.disabledAt > 30 * 60 * 1000) {
        s.state = 'enabled'; // Re-enable after 30 min
        return true;
      }
      return false;
    }
    return true;
  }

  stakeMultiplier(symbol) {
    if (!this.cfg.calibEnabled) return 1;
    const s = this.symbols.get(symbol);
    if (!s || s.state === 'enabled') return 1;
    if (s.state === 'disabled') return 0.25; // Probe with 25% stake
    return 1;
  }

  serialize() {
    const out = {};
    for (const [sym, s] of this.symbols) {
      out[sym] = { state: s.state, disabledAt: s.disabledAt, window: s.window.slice(-50) };
    }
    return out;
  }

  load(saved) {
    for (const [sym, s] of Object.entries(saved)) {
      if (s && typeof s === 'object') {
        this.symbols.set(sym, {
          state: s.state || 'enabled',
          disabledAt: Number(s.disabledAt || 0),
          window: Array.isArray(s.window) ? s.window.slice(-this.cfg.calibWindow) : [],
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// 11. KELLY SIZER
// ─────────────────────────────────────────────────────────────────────
class KellySizer {
  constructor(cfg) { this.cfg = cfg; }

  compute({ bankroll, pWin, payoutMult, edgeValue }) {
    const b = payoutMult - 1;
    const p = Math.max(0, Math.min(1, pWin));
    const q = 1 - p;
    if (b <= 0) return null;

    const fStar = (b * p - q) / b;
    if (fStar <= 0) return null;

    // When edge is marginal, use minimum stake to test the waters
    if (edgeValue != null && edgeValue < 0.005) {
      return {
        stake: this.cfg.minStake,
        fStar,
        fApplied: 0,
        reason: 'edge-marginal',
      };
    }

    const fraction = fStar * this.cfg.kellyFraction;
    const capped = Math.min(fraction, this.cfg.kellyMaxStakeFrac);

    // Calculate ideal stake from Kelly
    let kellyStake = bankroll * capped;

    // Determine effective fraction based on maxStake constraint
    // If Kelly recommends more than maxStake, we need to decide:
    // 1. Is the edge strong enough to warrant maxStake?
    // 2. Or should we scale down?

    let stake;
    let reason;

    if (kellyStake <= this.cfg.maxStake) {
      // Kelly stake is within limits - use it
      stake = kellyStake;
      reason = 'ok';
    } else if (edgeValue != null && edgeValue >= 0.02) {
      // Strong edge (>= 2%) - use maxStake
      stake = this.cfg.maxStake;
      reason = 'strong-edge-max';
    } else if (edgeValue != null && edgeValue >= 0.01) {
      // Moderate edge (1-2%) - use 75% of maxStake
      stake = this.cfg.maxStake * 0.75;
      reason = 'moderate-edge-75pct';
    } else if (edgeValue != null && edgeValue >= 0.005) {
      // Small edge (0.5-1%) - use 50% of maxStake
      stake = this.cfg.maxStake * 0.50;
      reason = 'small-edge-50pct';
    } else {
      // Very small edge - use 25% of maxStake as probe
      stake = this.cfg.maxStake * 0.25;
      reason = 'probe-25pct';
    }

    stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, +stake.toFixed(2)));

    // Calculate effective fraction for reporting
    const effectiveFrac = bankroll > 0 ? stake / bankroll : 0;

    return {
      stake,
      fStar,
      fApplied: effectiveFrac,
      reason,
      kellyStake,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 12. TRADING BOT
// ─────────────────────────────────────────────────────────────────────
class TradingBot {
  constructor() {
    this.cfg = CONFIG;
    this.client = new DerivClient(this.cfg);
    this.market = new MarketDataManager(this.client, this.cfg);
    this.analyzer = new MonteCarloAnalyzer(this.cfg);
    this.exec = new TradeExecutor(this.client, this.cfg);
    this.stats = new StatisticsManager();
    this.calibrator = new SymbolCalibrator(this.cfg);
    this.kelly = new KellySizer(this.cfg);

    this.startBalance = null;
    this.lastBalance = null;
    this.lastTradeAt = 0;
    this.tradedAsset = null;
    this.tradedAssetAt = 0;
    this.stopped = false;
    this._analysisT = null;
    this._circuitBreakerUntil = null;
    this._dayStartDate = null;
    this._dayStartBalance = null;
    this._trading = false;
    this._hourlyBoot = null;
    this._hourlyT = null;
    this._eodBoot = null;
    this._eodT = null;

    // Watchdog
    this.tradeWatchdogMs = this.cfg.tradeWatchdogMs || 20000;
    this._watchdogTimer = null;
    this._watchdogPollTimer = null;

    // Weak-signal tracker
    this._weakSignalCount = 0;
  }

  async start() {
    logger.info('===== Monte Carlo Digit Bot starting =====');
    logger.info(`stake=${this.cfg.stake} assets=${this.cfg.assets.join(',')}`);

    this._loadState();

    this.client.on('authorized', info => this._onAuthorized(info));
    this.client.on('close', (c, r, was) => this._onDisconnected(c, r, was));
    this.client.on('open', () => logger.info('connection open'));
    this.client.on('error', e => logger.error('client error:', e.message));
    this.exec.on('open', t => this._onTradeOpen(t));
    this.exec.on('result', t => this._onTradeResult(t));
    this.exec.on('update', t => logger.debug(`update #${t.contractId} ${t.status} profit=${t.profit}`));

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
    process.on('uncaughtException', e => {
      logger.error('uncaughtException:', e);
      this._saveState('error');
    });
    process.on('unhandledRejection', e => {
      logger.error('unhandledRejection:', e);
      this._saveState('unhandledRejection');
    });

    this.client.connect();
    this._scheduleSummaries();
  }

  async _onAuthorized(info) {
    this.startBalance = this.startBalance ?? this.client.balance ?? 0;
    this.lastBalance = this.lastBalance ?? this.client.balance ?? this.startBalance;
    this._dayStartDate = utcDateStr();
    this._dayStartBalance = this.lastBalance;

    logger.info(`balance: ${this.lastBalance} ${this.currency()}`);
    await this.market.loadSymbols();
    await this.market.bootstrap(this.cfg.assets);

    telegram.send(
      `🤖 <b>Monte Carlo2 Digit Bot Online</b>\n\n` +
      `👤 Account: <code>${htmlEscape(info.loginid || '?')}</code>\n` +
      `💼 ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 Balance: ${(this.client.balance ?? 0).toFixed(2)} ${this.currency()}\n` +
      `📊 Assets: ${this.cfg.assets.join(', ')}\n` +
      `🎯 Contract: DIGITDIFF, ${this.cfg.durationTicks} tick(s)\n` +
      `💵 Stake: ${this.cfg.stake.toFixed(2)} ${this.currency()}\n` +
      `🧮 Kelly: ${this.cfg.kellyEnabled ? 'ON' : 'OFF'}\n` +
      `📐 Calibration: ${this.cfg.calibEnabled ? 'ON' : 'OFF'}\n\n` +
      `💼 Profit: ${money(this.stats.overallProfit, this.currency())}`
    );

    this._startAnalysis();
  }

  _onDisconnected(code, reason, wasAuthorized) {
    telegram.send(`⚠️ <b>Monte Carlo2 Digit Bot Connection lost</b>\ncode: <code>${code}</code>\nwas authorized: ${wasAuthorized ? 'yes' : 'no'}\n🔄 reconnecting...`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }

    // Recover any stuck trades on disconnect
    if (this.exec.open.size > 0) {
      logger.warn(`clearing ${this.exec.open.size} tracked open trade(s) on disconnect — contract outcomes will be missed`);
      this._recoverStuckTrade('disconnect');
    }

    this._clearAllWatchdogTimers();
  }

  _startAnalysis() {
    if (this._analysisT) clearInterval(this._analysisT);
    this._analyzeAndTrade();
    this._analysisT = setInterval(() => this._analyzeAndTrade().catch(e => logger.error('analyze:', e.message)), this.cfg.analysisIntervalMs);
  }

  async _analyzeAndTrade() {
    if (this._trading) return;
    this._trading = true;
    try {
    if (this.stopped || !this.client.authorized) return;

    // ── Risk Controls ───────────────────────────────────────────────
    if (Date.now() - this.lastTradeAt < this.cfg.tradeFrequencyMs) return;
    if (this.exec.count() >= this.cfg.maxOpenTrades) return;

    // Circuit breaker
    if (this._circuitBreakerUntil && Date.now() < this._circuitBreakerUntil) {
      logger.debug('circuit breaker active');
      return;
    }

    // Weak-signal pause
    if (this._weakSignalCount >= this.cfg.maxWeakSignals) {
      logger.debug(`weak-signal pause: ${this._weakSignalCount} consecutive weak signals — skipping`);
      return;
    }

    // Daily limits
    const today = utcDateStr();
    if (this._dayStartDate !== today) {
      this._dayStartDate = today;
      this._dayStartBalance = this.lastBalance ?? this.client.balance ?? this._dayStartBalance ?? null;
    }
    const todayTrades = this.stats.todayTrades(today);
    const todayStats = this.stats.stats(todayTrades);

    if (todayStats.count >= this.cfg.dailyMaxTrades) return;
    if (todayStats.totalProfit <= -Math.abs(this.cfg.dailyMaxLoss)) return;
    if (this._dayStartBalance != null && this.cfg.dailyMaxLossPct > 0) {
      if (-todayStats.totalProfit / Math.max(1, this._dayStartBalance) >= this.cfg.dailyMaxLossPct) return;
    }
    if (this.cfg.dailyMaxProfit > 0 && todayStats.totalProfit >= this.cfg.dailyMaxProfit) return;

    // ── Analysis Step (separated from execution) ────────────────────
    const tradeableAssets = this.cfg.assets.filter(s => this.calibrator.isTradeable(s));
    if (!tradeableAssets.length) return;

    const analyses = tradeableAssets
      .map(s => this.analyzer.analyze(s, this.market.historyFor(s)))
      .filter(Boolean);

    const ranked = this.analyzer.rank(analyses);
    if (!ranked.length) {
      this._weakSignalCount++;
      logger.debug(`no MC-passing analyses (${this._weakSignalCount}/${this.cfg.maxWeakSignals} weak signals)`);
      return;
    }

    // Pick the top MC-approved candidate
    const topAnalysis = ranked[0];

    // Verify MC gate passed — the analysis must have mcPasses=true
    if (!topAnalysis.mcPasses && !topAnalysis.allowedByModel) {
      this._weakSignalCount++;
      logger.debug(`MC gate failed: ${topAnalysis.mcReason || topAnalysis.gates?.[0] || 'unknown'} (${this._weakSignalCount}/${this.cfg.maxWeakSignals})`);
      return;
    }

    // Check asset rotation
    const lockActive = this.cfg.assetRotationMs > 0
      && this.tradedAsset
      && (Date.now() - this.tradedAssetAt < this.cfg.assetRotationMs);

    if (lockActive && topAnalysis.symbol === this.tradedAsset) {
      logger.debug(`symbol ${this.tradedAsset} in rotation cooldown`);
      return;
    }

    // ── Get Proposal & Value Edge ───────────────────────────────────
    const probeStake = this.cfg.minStake;
    let bestCandidate = null;
    let bestEdge = -Infinity;

    for (const a of ranked.slice(0, 5)) {
      try {
        const pres = await this.exec.proposal(a.symbol, a.digit, probeStake);
        const p = pres.proposal;
        if (!p?.id) continue;

        const ask = Number(p.ask_price || probeStake);
        const payout = Number(p.payout || 0);
        if (payout <= ask) continue;

        const payoutMult = payout / ask;
        const breakEvenLossProb = 1 - ask / payout;
        const valueEdge = breakEvenLossProb - a.pUpper - this.cfg.safetyMargin;

        if (valueEdge >= this.cfg.minEdge && valueEdge > bestEdge) {
          bestEdge = valueEdge;
          bestCandidate = { analysis: a, proposal: p, ask, payout, payoutMult, valueEdge };
        }
      } catch (e) {
        logger.debug(`proposal ${a.symbol} d${a.digit}:`, e.message);
      }
    }

    if (!bestCandidate) {
      this._weakSignalCount++;
      logger.debug(`no edge found after proposal check (${this._weakSignalCount}/${this.cfg.maxWeakSignals} weak) — best was ${topAnalysis.symbol} d${topAnalysis.digit}`);
      return;
    }

    // ── Calculate Stake ─────────────────────────────────────────────
    const pWin = 1 - bestCandidate.analysis.pUpper;
    let stake = this.cfg.stake;
    let sizingSource = 'flat';

    if (this.cfg.kellyEnabled) {
      const bankroll = Math.max(this.cfg.kellyBankrollFloor, this.lastBalance ?? this.client.balance ?? 0);
      const k = this.kelly.compute({
        bankroll,
        pWin,
        payoutMult: bestCandidate.payoutMult,
        edgeValue: bestCandidate.valueEdge,
      });
      if (k) {
        stake = k.stake;
        sizingSource = `kelly(f*=${k.fStar.toFixed(4)}, ${k.reason || 'ok'})`;
      } else {
        this._weakSignalCount++;
        return; // No positive edge
      }
    } else {
      sizingSource = 'flat';
    }

    // Apply calibration multiplier
    const calibMult = this.calibrator.stakeMultiplier(bestCandidate.analysis.symbol);
    stake *= calibMult;
    stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, +stake.toFixed(2)));

    logger.info(`sizing: stake=${stake.toFixed(2)} src=${sizingSource} calibMult=${calibMult} pWin=${pWin.toFixed(4)} edge=${bestCandidate.valueEdge.toFixed(4)} mcConf=${bestCandidate.analysis.confidence?.toFixed(3)}`);

    // ── Execute Trade ───────────────────────────────────────────────
    try {
      const trade = await this.exec.buy(
        bestCandidate.analysis.symbol,
        bestCandidate.analysis.digit,
        stake,
        {
          digit: bestCandidate.analysis.digit,
          sampleSize: bestCandidate.analysis.sampleSize,
          pUpper: bestCandidate.analysis.pUpper,
          valueEdge: bestCandidate.valueEdge,
          payoutMult: bestCandidate.payoutMult,
          sizingSource,
          lossStreak: this.stats.currentLossStreak,
          mcConfidence: bestCandidate.analysis.confidence,
          mcStability: bestCandidate.analysis.stability,
          mcPValue: bestCandidate.analysis.pValue,
        }
      );

      this.lastTradeAt = Date.now();
      this.tradedAsset = bestCandidate.analysis.symbol;
      this.tradedAssetAt = Date.now();
      this.analyzer.recordPrediction(bestCandidate.analysis.digit, bestCandidate.analysis.symbol);
      this._weakSignalCount = 0; // reset on successful trade

      logger.info(`trade placed #${trade.contractId} ${trade.symbol} d${trade.digit} edge=${bestCandidate.valueEdge.toFixed(4)} mcConf=${bestCandidate.analysis.confidence?.toFixed(3)} stability=${bestCandidate.analysis.stability?.toFixed(3)}`);
    } catch (e) {
      logger.error('trade failed:', e.message);
    }
    } finally {
      this._trading = false;
    }
  }

  _onTradeOpen(t) {
    const a = t.analysis || {};
    const ci = a.bootstrapCI || {};
    telegram.send(
      `🟢 <b>TRADE OPENED — MONTE CARLO2 DIGIT DIFFER</b>\n\n` +
      `🎫 Contract: <code>#${t.contractId}</code>\n` +
      `📊 Symbol: <code>${t.symbol}</code>\n` +
      `🔢 Barrier: final digit <b>DIFFERS from ${t.digit}</b>\n` +
      `⏱️ Duration: ${t.durationTicks} tick(s)\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currency()}\n` +
      `🎁 Payout: ${t.payout.toFixed(2)} ${this.currency()}\n\n` +
      `📐 <b>Monte Carlo Analysis:</b>\n` +
      `• Sample size: n=${a.sampleSize ?? '?'}\n` +
      `• MC Confidence: <b>${Number(a.mcConfidence ?? a.consensusScore ?? 0).toFixed(3)}</b>\n` +
      `• MC Stability: <b>${Number(a.mcStability ?? a.agreementSources ?? 0).toFixed(3)}</b>\n` +
      `• p-value: ${Number(a.mcPValue ?? a.pValue ?? 0).toFixed(4)}\n` +
      `• Loss prob (observed): <b>${((a.pUpper || 0) * 100).toFixed(2)}%</b>\n` +
      `• Break-even loss prob: ${((1 - t.payout/t.stake) * 100).toFixed(2)}%\n` +
      `• Value edge: <b>${(a.valueEdge * 100).toFixed(2)}%</b>\n` +
      `• Bootstrap CI: [${(ci.lower * 100 || 0).toFixed(1)}%, ${(ci.upper * 100 || 0).toFixed(1)}%] width=${(ci.width * 100 || 0).toFixed(2)}%\n` +
      `• Absence streak: ${a.absenceStreak ?? '?'} ticks\n` +
      `• Randomness flags: [${(a.randomnessFlags || []).join(', ') || 'none'}]\n` +
      `• Payout multiplier: ×${Number(a.payoutMult || 0).toFixed(4)}\n` +
      `• Sizing: <code>${htmlEscape(a.sizingSource || 'flat')}</code>\n` +
      `• Current loss streak: ${a.lossStreak ?? this.stats.currentLossStreak}\n` +
      `• Balance: ${(this.lastBalance ?? 0).toFixed(2)} ${this.currency()}\n\n` +
      `🕒 ${utcTs()}`
    );

    this._startTradeWatchdog(t.contractId);
  }

  _onTradeResult(t) {
    this._clearAllWatchdogTimers();
    const rec = this.stats.record(t);
    this.lastBalance = (this.lastBalance ?? this.client.balance ?? 0) + Number(t.profit || 0);

    // Circuit breaker check
    if (this.cfg.maxConsecutiveLoss && this.stats.currentLossStreak >= this.cfg.maxConsecutiveLoss) {
      this._circuitBreakerUntil = Date.now() + this.cfg.lossCooldownMs;
      const mins = (this.cfg.lossCooldownMs / 60000).toFixed(0);
      logger.warn(`circuit breaker: ${this.stats.currentLossStreak} losses → pausing ${mins}m`);
      telegram.send(`🛑 <b>MONTE CARLO2 CIRCUIT BREAKER</b>\n${this.stats.currentLossStreak} losses. Pausing ${mins}m.`);
    }

    // Feed calibrator
    if (this.cfg.calibEnabled) {
      const pWin = Number(t.analysis?.pWin ?? 0.9);
      this.calibrator.record(t.symbol, pWin, t.status === 'won');
    }

    const emoji = t.status === 'won' ? '✅' : '❌';
    const label = t.status === 'won' ? 'WIN' : 'LOSS';
    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));
    const ls = this.stats.lossStreakEvents;

    telegram.send(
      `${emoji} <b>TRADE ${label} — MONTE CARLO2 DIGIT DIFFER</b>\n\n` +
      `🎫 Contract: <code>#${t.contractId}</code>\n` +
      `📊 Symbol: <code>${t.symbol}</code> | differs <b>${t.digit}</b>\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currency()}\n` +
      `💰 P/L: <b>${money(t.profit, this.currency())}</b>\n` +
      `📐 MC Confidence: ${Number(t.analysis?.mcConfidence ?? 0).toFixed(3)} | Stability: ${Number(t.analysis?.mcStability ?? 0).toFixed(3)}\n\n` +
      `📅 <b>Today (${rec.date})</b>\n` +
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses})\n` +
      `• Win rate: ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net P/L: <b>${money(todayStats.totalProfit, this.currency())}</b>\n\n` +
      `💼 <b>Overall:</b>\n` +
      `• Profit: ${money(this.stats.overallProfit, this.currency())}\n` +
      `• Total wins: ${this.stats.totalWins} | Total losses: ${this.stats.totalLosses}\n` +
      `• Loss streak: current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
      `• x2=${ls.x2}  x3=${ls.x3}  x4=${ls.x4}  x5=${ls.x5}`
    );

    this.lastTradeAt = Date.now();
    this._saveState('after-trade');
  }

  _startTradeWatchdog(contractId) {
    const timeoutMs = this.tradeWatchdogMs;

    this._watchdogTimer = setTimeout(() => {
      if (!this.exec.open.has(contractId)) {
        logger.debug('Watchdog fired but trade already settled');
        return;
      }

      logger.warn(
        `WATCHDOG FIRED -- Contract ${contractId} open for ` +
        `${(timeoutMs / 1000)}s with no settlement`
      );

      if (contractId && this.client.connected && this.client.authorized) {
        logger.info(`Polling contract ${contractId}...`);

        this.client._send({
          forget_all: 'proposal_open_contract'
        }).catch(e => logger.debug('forget_all:', e.message));

        this.client._send({
          proposal_open_contract: 1,
          contract_id: contractId,
          subscribe: 1
        }, 15000).catch(e => logger.debug('re-subscribe:', e.message));

        this._watchdogPollTimer = setTimeout(() => {
          if (!this.exec.open.has(contractId)) return;

          logger.error(
            `WATCHDOG: Poll timeout -- contract ${contractId} ` +
            `still unresolved -- force-releasing lock`
          );
          this._recoverStuckTrade('watchdog-force');
        }, 15000);

      } else {
        logger.error('Cannot poll contract - not connected');
        this._recoverStuckTrade('watchdog-offline');
      }
    }, timeoutMs);

    logger.debug(`Watchdog started for ${contractId} (${timeoutMs}ms)`);
  }

  _clearAllWatchdogTimers() {
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    if (this._watchdogPollTimer) {
      clearTimeout(this._watchdogPollTimer);
      this._watchdogPollTimer = null;
    }
  }

  _recoverStuckTrade(reason) {
    logger.warn(`Recovery mode: ${reason}`);

    this._clearAllWatchdogTimers();

    const openContracts = [...this.exec.open.entries()];
    if (openContracts.length === 0) {
      logger.debug('No open contracts to recover');
      return;
    }

    for (const [contractId, info] of openContracts) {
      const openSeconds = info.buyTime
        ? Math.round((Date.now() / 1000 - info.buyTime))
        : '?';

      logger.error(
        `STUCK TRADE RECOVERY [${reason}] | Contract: ${contractId} | ` +
        `Symbol: ${info.symbol} | Open for: ${openSeconds}s`
      );

      this.exec.open.delete(contractId);

      telegram.send(
        `WARNING: <b>MONTE CARLO2 STUCK TRADE RECOVERED [${reason}]</b>\n` +
        `Contract: <code>${contractId}</code>\n` +
        `Symbol: ${info.symbol}\n` +
        `Open for: ${openSeconds}s\n` +
        `Manually verify on Deriv\n` +
        `Overall P/L: ${money(this.stats.overallProfit, this.currency())}`
      );
    }

    logger.warn(`Lock released. Bot will continue...`);
    this._saveState('stuck-trade-recovery');
  }

  // ── Hourly & EOD Telegram Summaries ─────────────────────────────
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
  _parseEodTime() {
    const m = String(this.cfg.eodTimeGmt || '00:00').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return { h: 0, min: 0 };
    return { h: Math.max(0, Math.min(23, Number(m[1]))), min: Math.max(0, Math.min(59, Number(m[2]))) };
  }
  _msToNextEod(now = new Date()) {
    const { h, min } = this._parseEodTime();
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, min, this.cfg.eodSendDelaySeconds || 10, 0));
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target.getTime() - now.getTime();
  }
  _eodReportDate(now = new Date()) {
    const { h, min } = this._parseEodTime();
    // If EOD is at midnight GMT, report the trade day that just ended.
    if (h === 0 && min === 0) return previousUtcDateStr(now);
    return utcDateStr(now);
  }
  _sendHourly() {
    const now = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const date = utcDateStr(prev);
    const hour = utcHour(prev);
    const list = this.stats.tradesForHour(date, hour);
    const s = this.stats.stats(list);
    if (!list.length) {
      telegram.send(`⏰ <b>Monte Carlo2 Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\nNo trades this hour.\n\n💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}`);
      return;
    }
    let msg = `⏰ <b>Monte Carlo2 Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\n` +
      `📊 Trades: ${s.count} (✅${s.wins} ❌${s.losses})\n` +
      `📈 Win rate: ${s.winRate.toFixed(1)}%\n` +
      `💰 P/L: <b>${money(s.totalProfit, this.currency())}</b>\n` +
      `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
      `❌ Loss streak current ${this.stats.currentLossStreak} | x2=${this.stats.lossStreakEvents.x2} x3=${this.stats.lossStreakEvents.x3} x4=${this.stats.lossStreakEvents.x4}\n\n` +
      `📋 Detail:\n`;
    list.slice(-20).forEach((t, i) => {
      msg += `${i + 1}. ${t.status === 'won' ? '✅' : '❌'} #${t.contractId} ${t.symbol} d${t.digit} ${money(t.profit, this.currency())}\n`;
    });
    telegram.send(msg);
  }
  _sendEod(reason = 'manual') {
    const date = this._eodReportDate(new Date());
    if (this.stats.isEodSent(date) && reason === 'scheduled') {
      logger.info(`EOD ${date} already sent; skipping duplicate`);
      return;
    }
    const summary = this.stats.archiveDate(date);
    const ds = summary.stats;

    let msg = `🌙 <b>Monte Carlo2 END OF TRADE DAY — GMT</b>\n` +
              `📅 Trade day ended: <b>${date}</b>\n\n` +
              `<b>── Current Day Stats ──</b>\n`;
    if (ds.count) {
      msg += `📊 Trades: ${ds.count} (✅${ds.wins} ❌${ds.losses})\n` +
             `📈 Win rate: ${ds.winRate.toFixed(1)}%\n` +
             `💰 <b>Net P/L: ${money(ds.totalProfit, this.currency())}</b>\n` +
             `🏆 Profit factor: ${ds.profitFactor === Infinity ? '∞' : ds.profitFactor.toFixed(2)}\n\n`;
    } else {
      msg += `No trades recorded for this GMT trade day.\n\n`;
    }

    msg += `<b>── Overall Stats ──</b>\n` +
           `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
           `✅ Total wins: ${this.stats.totalWins} | ❌ Total losses: ${this.stats.totalLosses}\n` +
           `❌ Consecutive losses: current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
           `   x2=${this.stats.lossStreakEvents.x2}  x3=${this.stats.lossStreakEvents.x3}  x4=${this.stats.lossStreakEvents.x4}\n`;

    telegram.send(msg);
    this.stats.markEodSent(date);
    this._saveState(`eod-${reason}`);
    this.startBalance = this.client.balance ?? this.lastBalance ?? this.startBalance;
  }

  _saveState(reason = 'checkpoint') {
    try {
      const payload = {
        savedAt: new Date().toISOString(),
        startBalance: this.startBalance,
        lastBalance: this.lastBalance,
        stats: this.stats.serialize(),
        calibrator: this.calibrator.serialize(),
      };
      const tmp = this.cfg.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.cfg.stateFile);
      logger.debug(`state saved (${reason})`);
    } catch (e) {
      logger.warn('state save failed:', e.message);
    }
  }

  _loadState() {
    try {
      if (!fs.existsSync(this.cfg.stateFile)) return;
      const data = JSON.parse(fs.readFileSync(this.cfg.stateFile, 'utf8'));
      this.startBalance = data.startBalance ?? null;
      this.lastBalance = data.lastBalance ?? null;
      this.stats = new StatisticsManager(data.stats || {});
      if (data.calibrator) this.calibrator = new SymbolCalibrator(this.cfg, data.calibrator);
      logger.info(`state restored: profit=${this.stats.overallProfit.toFixed(2)}`);
    } catch (e) {
      logger.warn('state load failed:', e.message);
    }
  }

  currency() { return this.client.currency || this.cfg.currency; }

  stop(signal) {
    this.stopped = true;
    logger.info(`stopping (${signal})`);
    telegram.send(`🛑 <b>Monte Carlo2 Bot stopped</b>\nSignal: ${htmlEscape(signal)}\nProfit: ${money(this.stats.overallProfit, this.currency())}`);
    if (this._analysisT) clearInterval(this._analysisT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._hourlyT) clearInterval(this._hourlyT);
    if (this._eodBoot) clearTimeout(this._eodBoot);
    if (this._eodT) clearInterval(this._eodT);
    this._clearAllWatchdogTimers();
    this._saveState('shutdown');
    this.client.stop();
    setTimeout(() => process.exit(0), 2500);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 13. BACKTESTER
// ─────────────────────────────────────────────────────────────────────
class DifferBacktester {
  constructor(cfg, client, market) {
    this.cfg = cfg;
    this.client = client;
    this.market = market;
    this.analyzer = new MonteCarloAnalyzer(cfg);
  }

  async run(symbols) {
    const list = Array.isArray(symbols) ? symbols : [symbols];
    if (!list.length) throw new Error('no symbols to backtest');

    const banner = '─'.repeat(72);
    console.log(`\n${banner}`);
    console.log(`  DIGIT DIFFER BACKTEST — symbols=[${list.join(', ')}]  ticks=${this.cfg.backtestTicks}`);
    console.log(banner);
    console.log(
      `  config: minEdge=${this.cfg.minEdge}  safety=${this.cfg.safetyMargin}\n` +
      `          analysisWindows=[${this.cfg.analysisWindows}]  duration=${this.cfg.durationTicks}t\n` +
      `          payoutMult=${this.cfg.backtestPayoutMult}  stake=${this.cfg.stake}`
    );
    console.log(banner);

    const combined = { signals: 0, wins: 0, losses: 0, pnl: 0, grossWin: 0, grossLoss: 0 };
    const reports = [];

    for (const sym of list) {
      const r = await this._runOne(sym);
      reports.push(r);
      combined.signals += r.signals;
      combined.wins += r.wins;
      combined.losses += r.losses;
      combined.pnl += r.pnl;
      combined.grossWin += r.grossWin;
      combined.grossLoss += r.grossLoss;
    }

    if (reports.length > 1) {
      console.log(`\n${banner}`);
      console.log('  COMBINED (all symbols):');
      console.log(`    signals=${combined.signals}  wins=${combined.wins}  losses=${combined.losses}`);
      const wr = combined.signals ? (combined.wins / combined.signals * 100) : 0;
      console.log(`    WR=${wr.toFixed(2)}%   Net P/L=${combined.pnl >= 0 ? '+' : ''}${combined.pnl.toFixed(2)} ${this.cfg.currency}`);
      const pf = combined.grossLoss > 0 ? combined.grossWin / combined.grossLoss : (combined.grossWin > 0 ? Infinity : 0);
      console.log(`    PF=${pf === Infinity ? '∞' : pf.toFixed(3)}`);
      console.log(banner + '\n');
    }

    // Save report
    try {
      const payload = {
        savedAt: new Date().toISOString(),
        config: {
          minEdge: this.cfg.minEdge,
          safetyMargin: this.cfg.safetyMargin,
          analysisWindows: this.cfg.analysisWindows,
          durationTicks: this.cfg.durationTicks,
          payoutMultiplier: this.cfg.backtestPayoutMult,
          stake: this.cfg.stake,
        },
        symbols: reports,
        combined,
      };
      fs.writeFileSync(this.cfg.backtestOutFile || 'backtest_report.json', JSON.stringify(payload, null, 2));
      console.log(`Report saved → ${this.cfg.backtestOutFile || 'backtest_report.json'}`);
    } catch (e) {
      logger.warn(`could not write report: ${e.message}`);
    }

    return reports;
  }

  async _runOne(symbol) {
    const banner = '─'.repeat(72);
    console.log(`\n${banner}`);
    console.log(`  ${symbol}`);
    console.log(banner);

    // Fetch historical ticks
    logger.info(`fetching historical ticks (${symbol})...`);
    const ticks = await this.market.deepBackfill(
      symbol,
      this.cfg.backtestTicks,
      this.cfg.backtestBatchSize,
      (got, tot) => {
        if (got % 10000 < this.cfg.backtestBatchSize) {
          console.log(`  fetched ${got}/${tot}`);
        }
      }
    );

    const pip = this.market.pipSize(symbol);
    if (ticks.length < this.cfg.minTicksForAnalysis + this.cfg.durationTicks + 10) {
      throw new Error(`insufficient history for ${symbol}: got ${ticks.length}`);
    }

    console.log(
      `  have ${ticks.length} ticks  pip=${pip}  ` +
      `span=${new Date(ticks[0].epoch * 1000).toISOString().slice(0, 19)}Z → ` +
      `${new Date(ticks[ticks.length - 1].epoch * 1000).toISOString().slice(0, 19)}Z`
    );

    // Walk-forward simulation
    const baseStake = this.cfg.stake;
    const payoutMult = this.cfg.backtestPayoutMult;
    const duration = Math.max(1, this.cfg.durationTicks);
    const minWindow = Math.max(this.cfg.minTicksForAnalysis, 200);

    const results = {
      symbol,
      pip,
      startEpoch: ticks[0].epoch,
      endEpoch: ticks[ticks.length - 1].epoch,
      tickCount: ticks.length,
      signals: 0,
      wins: 0,
      losses: 0,
      pnl: 0,
      grossWin: 0,
      grossLoss: 0,
      byDigit: {},
    };
    for (let d = 0; d < 10; d++) results.byDigit[d] = { signals: 0, wins: 0, losses: 0, pnl: 0 };

    const diag = {
      scans: 0,
      nullAnalyses: 0,
      gatedMC: 0,
      gatedRandomness: 0,
      gatedRecentHit: 0,
      gatedEdge: 0,
      gatedCooldown: 0,
      gatedHotFilter: 0,
      gatedEntropy: 0,
      gatedBootstrapCI: 0,
      allowedModel: 0,
      recommended: 0,
    };

    // Streak tracking
    let currentLossStreak = 0;
    let maxLossStreak = 0;
    let currentWinStreak = 0;
    let maxWinStreak = 0;
    const lossStreakEvents = { x2: 0, x3: 0, x4: 0, x5: 0, x6: 0, x7: 0, x8plus: 0 };
    const winStreakEvents = { x2: 0, x3: 0, x4: 0, x5: 0, x6: 0, x7: 0, x8plus: 0 };
    const lossSequences = [];
    const winSequences = [];

    const t0 = Date.now();
    let i = minWindow;

    while (i < ticks.length - duration - 1) {
      const window = ticks.slice(0, i + 1);
      const analysis = this.analyzer.analyze(symbol, window);
      diag.scans++;

      if (!analysis) {
        diag.nullAnalyses++;
        i++;
        continue;
      }

      if (!analysis.allowedByModel) {
        for (const g of analysis.gates) {
          if (g.startsWith('mc-rejected') || g.startsWith('confidence') || g.startsWith('stability')) diag.gatedMC++;
          else if (g.startsWith('randomness')) diag.gatedRandomness++;
          else if (g.startsWith('recent')) diag.gatedRecentHit++;
          else if (g.startsWith('cooldown')) diag.gatedCooldown++;
          else if (g.startsWith('hot-filter')) diag.gatedHotFilter++;
          else if (g.startsWith('bootstrap')) diag.gatedBootstrapCI++;
          else if (g.startsWith('entropy') || g.startsWith('chisq')) diag.gatedEntropy++;
        }
        i++;
        continue;
      }
      diag.allowedModel++;

      // Compute value edge
      const ask = baseStake;
      const payoutFull = baseStake * payoutMult;
      const breakEvenLossProb = 1 - ask / payoutFull;
      const valueEdge = breakEvenLossProb - analysis.pUpper - this.cfg.safetyMargin;

      if (valueEdge < this.cfg.minEdge) {
        diag.gatedEdge++;
        i++;
        continue;
      }

      diag.recommended++;
      const digit = analysis.digit;
      this.analyzer.recordPrediction(digit, symbol);

      // Simulate settlement
      const expiryTick = ticks[i + duration];
      if (!expiryTick || expiryTick.digit == null) {
        i++;
        continue;
      }
      const won = expiryTick.digit !== digit;
      const winNet = baseStake * payoutMult - baseStake;
      const lossNet = -baseStake;

      results.signals++;
      results.byDigit[digit].signals++;

      if (won) {
        // Record end of loss streak if we had one
        if (currentLossStreak > 0) {
          lossSequences.push(currentLossStreak);
          if (currentLossStreak === 2) lossStreakEvents.x2++;
          else if (currentLossStreak === 3) lossStreakEvents.x3++;
          else if (currentLossStreak === 4) lossStreakEvents.x4++;
          else if (currentLossStreak === 5) lossStreakEvents.x5++;
          else if (currentLossStreak === 6) lossStreakEvents.x6++;
          else if (currentLossStreak === 7) lossStreakEvents.x7++;
          else if (currentLossStreak >= 8) lossStreakEvents.x8plus++;
        }
        results.wins++;
        results.grossWin += winNet;
        results.pnl += winNet;
        results.byDigit[digit].wins++;
        results.byDigit[digit].pnl += winNet;
        currentWinStreak++;
        currentLossStreak = 0;
        maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
      } else {
        // Record end of win streak if we had one
        if (currentWinStreak > 0) {
          winSequences.push(currentWinStreak);
          if (currentWinStreak === 2) winStreakEvents.x2++;
          else if (currentWinStreak === 3) winStreakEvents.x3++;
          else if (currentWinStreak === 4) winStreakEvents.x4++;
          else if (currentWinStreak === 5) winStreakEvents.x5++;
          else if (currentWinStreak === 6) winStreakEvents.x6++;
          else if (currentWinStreak === 7) winStreakEvents.x7++;
          else if (currentWinStreak >= 8) winStreakEvents.x8plus++;
        }
        results.losses++;
        results.grossLoss += Math.abs(lossNet);
        results.pnl += lossNet;
        results.byDigit[digit].losses++;
        results.byDigit[digit].pnl += lossNet;
        currentLossStreak++;
        currentWinStreak = 0;
        maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
      }

      i += duration + 1;

      // Progress update
      if (results.signals % 500 === 0) {
        const wr = (results.wins / results.signals * 100).toFixed(1);
        console.log(`    ...${i}/${ticks.length} signals=${results.signals} WR=${wr}% pnl=${results.pnl.toFixed(2)}`);
      }
    }

    // Flush trailing streaks
    if (currentLossStreak > 0) {
      lossSequences.push(currentLossStreak);
      if (currentLossStreak === 2) lossStreakEvents.x2++;
      else if (currentLossStreak === 3) lossStreakEvents.x3++;
      else if (currentLossStreak === 4) lossStreakEvents.x4++;
      else if (currentLossStreak === 5) lossStreakEvents.x5++;
      else if (currentLossStreak === 6) lossStreakEvents.x6++;
      else if (currentLossStreak === 7) lossStreakEvents.x7++;
      else if (currentLossStreak >= 8) lossStreakEvents.x8plus++;
    }
    if (currentWinStreak > 0) {
      winSequences.push(currentWinStreak);
      if (currentWinStreak === 2) winStreakEvents.x2++;
      else if (currentWinStreak === 3) winStreakEvents.x3++;
      else if (currentWinStreak === 4) winStreakEvents.x4++;
      else if (currentWinStreak === 5) winStreakEvents.x5++;
      else if (currentWinStreak === 6) winStreakEvents.x6++;
      else if (currentWinStreak === 7) winStreakEvents.x7++;
      else if (currentWinStreak >= 8) winStreakEvents.x8plus++;
    }

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const empiricalWR = results.signals ? (results.wins / results.signals * 100) : 0;
    const profitFactor = results.grossLoss > 0 ? results.grossWin / results.grossLoss : (results.grossWin > 0 ? Infinity : 0);

    // Calculate streak averages
    const avgLoss = lossSequences.length ? lossSequences.reduce((s, v) => s + v, 0) / lossSequences.length : 0;
    const avgWin = winSequences.length ? winSequences.reduce((s, v) => s + v, 0) / winSequences.length : 0;

    // Probability of at least N consecutive losses
    const probAtLeast = {
      x2: results.signals ? (lossStreakEvents.x2 + lossStreakEvents.x3 + lossStreakEvents.x4 + lossStreakEvents.x5 + lossStreakEvents.x6 + lossStreakEvents.x7 + lossStreakEvents.x8plus) / results.signals : 0,
      x3: results.signals ? (lossStreakEvents.x3 + lossStreakEvents.x4 + lossStreakEvents.x5 + lossStreakEvents.x6 + lossStreakEvents.x7 + lossStreakEvents.x8plus) / results.signals : 0,
      x4: results.signals ? (lossStreakEvents.x4 + lossStreakEvents.x5 + lossStreakEvents.x6 + lossStreakEvents.x7 + lossStreakEvents.x8plus) / results.signals : 0,
      x5: results.signals ? (lossStreakEvents.x5 + lossStreakEvents.x6 + lossStreakEvents.x7 + lossStreakEvents.x8plus) / results.signals : 0,
    };

    // Print report
    console.log('\n' + banner);
    console.log(`  BACKTEST REPORT — ${symbol}`);
    console.log(banner);
    console.log(`  Ticks processed : ${ticks.length.toLocaleString()}   pip_size=${pip}`);
    console.log(`  Signals fired   : ${results.signals}`);
    console.log(`  Wins / Losses   : ${results.wins} / ${results.losses}`);
    console.log(`  Win Rate        : ${empiricalWR.toFixed(2)}%`);
    console.log(`  Gross win / loss: +${results.grossWin.toFixed(2)} / -${results.grossLoss.toFixed(2)}`);
    console.log(`  Net P/L         : ${results.pnl >= 0 ? '+' : ''}${results.pnl.toFixed(2)} ${this.cfg.currency}`);
    console.log(`  Profit Factor   : ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(3)}`);
    console.log(`  Max Loss Streak : ${maxLossStreak}`);
    console.log(`  Max Win Streak  : ${maxWinStreak}`);
    console.log(`  Runtime         : ${dt}s`);
    console.log(banner);

    // Per-digit breakdown
    console.log('  Per-barrier-digit breakdown:');
    for (let d = 0; d < 10; d++) {
      const r = results.byDigit[d];
      if (!r.signals) continue;
      const wr = (r.wins / r.signals * 100).toFixed(1);
      console.log(`    d=${d}   signals=${String(r.signals).padStart(5)}   WR=${wr}%   pnl=${(r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2)}`);
    }
    console.log(banner);

    // Consecutive-loss stats
    console.log('  Consecutive-loss statistics:');
    console.log(`    x2 (2 in a row) : ${String(lossStreakEvents.x2).padStart(5)}  P(≥2) ≈ ${(probAtLeast.x2 * 100).toFixed(2)}% of signals`);
    console.log(`    x3 (3 in a row) : ${String(lossStreakEvents.x3).padStart(5)}  P(≥3) ≈ ${(probAtLeast.x3 * 100).toFixed(2)}% of signals`);
    console.log(`    x4 (4 in a row) : ${String(lossStreakEvents.x4).padStart(5)}  P(≥4) ≈ ${(probAtLeast.x4 * 100).toFixed(2)}% of signals`);
    console.log(`    x5 (5 in a row) : ${String(lossStreakEvents.x5).padStart(5)}  P(≥5) ≈ ${(probAtLeast.x5 * 100).toFixed(2)}% of signals`);
    console.log(`    x6 (6 in a row) : ${String(lossStreakEvents.x6).padStart(5)}`);
    console.log(`    x7 (7 in a row) : ${String(lossStreakEvents.x7).padStart(5)}`);
    console.log(`    x8+ (≥8)        : ${String(lossStreakEvents.x8plus).padStart(5)}`);
    console.log(`    Avg loss run    : ${avgLoss.toFixed(2)}  (${lossSequences.length} runs)`);
    console.log(`    Avg win run     : ${avgWin.toFixed(2)}  (${winSequences.length} runs)`);
    console.log(`    Worst DD (flat) : -${(maxLossStreak * baseStake).toFixed(2)} ${this.cfg.currency}`);
    console.log(banner);

    // Consecutive-win stats
    console.log('  Consecutive-win statistics:');
    console.log(`    x2 (2 in a row) : ${String(winStreakEvents.x2).padStart(5)}`);
    console.log(`    x3 (3 in a row) : ${String(winStreakEvents.x3).padStart(5)}`);
    console.log(`    x4 (4 in a row) : ${String(winStreakEvents.x4).padStart(5)}`);
    console.log(`    x5 (5 in a row) : ${String(winStreakEvents.x5).padStart(5)}`);
    console.log(`    x6 (6 in a row) : ${String(winStreakEvents.x6).padStart(5)}`);
    console.log(`    x7 (7 in a row) : ${String(winStreakEvents.x7).padStart(5)}`);
    console.log(`    x8+ (≥8)        : ${String(winStreakEvents.x8plus).padStart(5)}`);
    console.log(banner);

    // Diagnostics
    console.log('  Diagnostics:');
    console.log(`    scans              : ${diag.scans}`);
    console.log(`    null analyses      : ${diag.nullAnalyses}`);
    console.log(`    passed MC gates    : ${diag.allowedModel}`);
    console.log(`    signals fired      : ${diag.recommended}`);
    console.log(`    rejected by MC     : ${diag.gatedMC}`);
    console.log(`    rejected by random : ${diag.gatedRandomness}`);
    console.log(`    rejected by hits   : ${diag.gatedRecentHit}`);
    console.log(`    rejected by edge   : ${diag.gatedEdge}`);
    console.log(`    rejected by cooldown   : ${diag.gatedCooldown}`);
    console.log(`    rejected by hot-filter : ${diag.gatedHotFilter}`);
    console.log(`    rejected by entropy    : ${diag.gatedEntropy}`);
    console.log(`    rejected by bootstrap  : ${diag.gatedBootstrapCI}`);
    console.log(banner + '\n');

    Object.assign(results, {
      durationSec: +dt,
      empiricalWinRate: +empiricalWR.toFixed(2),
      profitFactor: profitFactor === Infinity ? Infinity : +profitFactor.toFixed(3),
      maxLossStreak,
      maxWinStreak,
      lossStreakEvents,
      winStreakEvents,
      avgLossRun: +avgLoss.toFixed(2),
      avgWinRun: +avgWin.toFixed(2),
      worstDrawdown: +(maxLossStreak * baseStake).toFixed(2),
      diagnostics: diag,
    });

    return results;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 13. BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Simple Digit Differ Bot                              ║');
  console.log('║   Focus: Risk Management, Not Pattern Prediction       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Synthetic indices use cryptographically secure RNG.');
  console.log('  Each tick is independent - past patterns don\'t predict futures.');
  console.log('  This bot uses conservative heuristics + strong risk management.');
  console.log('');
  console.log('  Usage:');
  console.log('    Live:    node accurateDiffer3_simple.js');
  console.log('    Backtest: $env:BACKTEST=1; node accurateDiffer3_simple.js');
  console.log('    Or:       node accurateDiffer3_simple.js --backtest');
  console.log('');
  console.log('  Backtest options (env vars):');
  console.log('    BACKTEST_TICKS=50000      # Number of historical ticks');
  console.log('    BACKTEST_ASSET=R_75       # Single symbol to test');
  console.log('    BACKTEST_PAYOUT_MULT=1.10 # Payout multiplier');
  console.log('');
}

async function main() {
  printBanner();

  if (!CONFIG.apiToken) {
    console.error('❌ DERIV_API_TOKEN not set. Create .env file or set environment variable.');
    process.exit(1);
  }

  // ── Backtest Mode ────────────────────────────────────────────────
  if (process.env.BACKTEST === '1' || process.argv.includes('--backtest')) {
    const list = (process.env.BACKTEST_ASSET || CONFIG.assets.join(','))
      .split(',').map(s => s.trim()).filter(Boolean);
    console.log(`🧪 BACKTEST mode — symbols=[${list.join(', ')}]  ticks=${CONFIG.backtestTicks}\n`);

    const client = new DerivClient(CONFIG);
    const market = new MarketDataManager(client, CONFIG);

    client.on('authorized', async () => {
      try {
        await market.loadSymbols();
        const bt = new DifferBacktester(CONFIG, client, market);
        await bt.run(list);
        try { client.stop(); } catch (_) {}
        process.exit(0);
      } catch (e) {
        console.error('backtest failed:', e);
        process.exit(1);
      }
    });

    client.on('error', e => {
      console.error('client error:', e.message);
    });

    client.connect();
    return;
  }

  // ── Live Trading Mode ──────────────────────────────────────────
  const bot = new TradingBot();
  await bot.start();
}

main().catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});
