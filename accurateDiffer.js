#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  Deriv Digit Differ Trading Bot (single-file)
 * =====================================================================
 *
 *  Converts the previous Accumulator bot idea into a Digit Differ bot.
 *  It trades DIGITDIFF contracts only when a conservative digit-probability
 *  model plus the live Deriv payout quote shows a positive value gap.
 *
 *  IMPORTANT:
 *    No trading strategy can guarantee consistent profit. Deriv synthetic
 *    ticks are designed to be random/fair after platform pricing margin.
 *    This bot therefore trades selectively and skips whenever the measured
 *    edge is not strong enough.
 *
 *  Core method: DIVER-9
 *    Dynamic Imbalance Value Edge Rejection for Digit Differ.
 *
 *    1. Track last digits per symbol using correct symbol pip_size.
 *    2. Estimate P(final digit == d) with an ensemble of:
 *       - multi-window digit frequencies,
 *       - EWMA recency probabilities,
 *       - current-digit -> expiry-digit transition matrix.
 *    3. For Differ, the selected barrier digit is the digit with the lowest
 *       predicted expiry probability.
 *    4. Pull a live proposal and compute the break-even losing probability:
 *          q_be = 1 - ask_price / payout
 *       A trade is allowed only if:
 *          conservative_upper_bound(P(loss digit)) < q_be - safety_margin
 *    5. Skip if entropy/chi-square/gap/liquidity/sample filters do not agree.
 *
 *  Features requested:
 *    • Digit Differ (DIGITDIFF) trading.
 *    • Overall Profit tracking, storage and display.
 *    • Consecutive Loss tracking/display: current streak + x2, x3, x4 events.
 *    • GMT/UTC day clock and end-of-trade-day notification.
 *    • EOD report includes the just-ended trade day and all previous trade
 *      days by date.
 *    • State persistence to JSON.
 *    • Telegram queue with safe spacing.
 *    • Reconnect with backoff.
 *    • Supports legacy Deriv token authorize flow and PAT/OTP flow.
 *
 *  Install:
 *    npm install ws
 *
 *  Run:
 *    DERIV_API_TOKEN="..." DERIV_APP_ID="..." node deriv_digit_differ_bot.js
 *
 *  If using a new PAT token, set DERIV_ACCOUNT_ID when possible:
 *    DERIV_API_TOKEN="pat_..." DERIV_APP_ID="..." DERIV_ACCOUNT_ID="VRTC..." node deriv_digit_differ_bot.js
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
  // Deriv API
  apiToken : strEnv('DERIV_API_TOKEN', 'pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee'),
  appId    : strEnv('DERIV_APP_ID', '33uslPtthXBEkQOdfKfoY'),//1089
  accountId: strEnv('DERIV_ACCOUNT_ID', ''), // recommended/required for PAT new API
  accountType: strEnv('DERIV_ACCOUNT_TYPE', 'demo').toLowerCase(), // demo | real
  legacyWsUrl: strEnv('DERIV_LEGACY_WS_URL', 'wss://ws.derivws.com/websockets/v3'),
  restBaseUrl: strEnv('DERIV_REST_BASE_URL', 'https://api.derivws.com'),
  currency: strEnv('CURRENCY', 'USD').toUpperCase(),

  // Trade setup
  stake: numEnv('STAKE', 1.00),
  durationTicks: intEnv('DURATION_TICKS', 1), // Digit contracts normally 1-10 ticks
  minStake: numEnv('MIN_STAKE', 0.35),
  maxStake: numEnv('MAX_STAKE', 10.00),
  assets: listEnv('ASSETS', 'R_10,R_25,R_50,R_75,R_100'),

  // Trading frequency / limits
  tickWindow: intEnv('TICK_WINDOW', 1000),
  minTicksForAnalysis: intEnv('MIN_TICKS_ANALYSIS', 300),
  analysisIntervalMs: intEnv('ANALYSIS_INTERVAL_MS', 3000),
  tradeCooldownMs: intEnv('TRADE_COOLDOWN_MS', 2500),
  maxOpenTrades: intEnv('MAX_OPEN_TRADES', 1),
  dailyMaxLoss: numEnv('DAILY_MAX_LOSS', 25),
  dailyMaxProfit: numEnv('DAILY_MAX_PROFIT', 0), // 0 disables profit target stop
  dailyMaxTrades: intEnv('DAILY_MAX_TRADES', 20000),

  // DIVER-9 edge filters
  frequencyWindows: listEnv('FREQUENCY_WINDOWS', '30,60,120,300,600').map(x => parseInt(x, 10)).filter(Number.isFinite),
  transitionLookback: intEnv('TRANSITION_LOOKBACK', 900),
  ewmaAlpha: numEnv('EWMA_ALPHA', 0.045),
  minEdge: numEnv('MIN_EDGE', 0.0040),          // absolute probability gap, e.g. 0.4 percentage point
  safetyMargin: numEnv('SAFETY_MARGIN', 0.0025),
  modelRiskMargin: numEnv('MODEL_RISK_MARGIN', 0.0020),
  zScore: numEnv('EDGE_ZSCORE', 1.15),          // conservative upper bound
  maxLossProb: numEnv('MAX_LOSS_PROB', 0.095),  // never take if model says losing digit > 9.5%
  minProbabilityGap: numEnv('MIN_PROBABILITY_GAP', 0.006),
  minEntropy: numEnv('MIN_ENTROPY', 0.92),      // close to random; avoid broken/tiny samples
  maxEntropy: numEnv('MAX_ENTROPY', 0.9995),    // if perfectly uniform, likely no exploitable imbalance
  minChiSquare: numEnv('MIN_CHISQUARE', 2.0),   // require some measurable imbalance
  maxChiSquare: numEnv('MAX_CHISQUARE', 30.0),  // reject extreme unstable bursts
  maxRecentDigitHits: intEnv('MAX_RECENT_DIGIT_HITS', 2), // selected digit occurrences in last recentLookback
  recentLookback: intEnv('RECENT_LOOKBACK', 15),
  proposalScanTopN: intEnv('PROPOSAL_SCAN_TOP_N', 3),

  // Optional limited loss recovery; disabled by default. Safer than the pasted 10x/100x martingale.
  recoveryEnabled: boolEnv('RECOVERY_ENABLED', true),
  recoveryMultipliers: listEnv('RECOVERY_MULTIPLIERS', '1,1.35,1.8,2.4').map(Number).filter(Number.isFinite),

  // GMT/UTC reporting
  eodTimeGmt: strEnv('TRADE_DAY_END_GMT', '00:00'), // default midnight GMT; report date is previous UTC day
  eodSendDelaySeconds: intEnv('EOD_SEND_DELAY_SECONDS', 10),
  hourlySummary: boolEnv('HOURLY_SUMMARY', true),

  // Persistence/logging
  stateFile: strEnv('STATE_FILE', 'deriv_digit_differ2_state.json'),
  logFile: strEnv('LOG_FILE', 'deriv_digit_differ2_bot.log'),
  logLevel: strEnv('LOG_LEVEL', 'INFO').toUpperCase(),

  // Telegram
  telegram: {
    enabled : true,
    botToken: strEnv('TELEGRAM_BOT_TOKEN', '8218636914:AAGvaKFh8MT769-_9eOEiU4XKufL0aHRhZ4'),
    chatId  : strEnv('TELEGRAM_CHAT_ID', '752497117'),
  },

  reconnect: {
    initialDelayMs: intEnv('RECONNECT_INITIAL_MS', 1000),
    maxDelayMs: intEnv('RECONNECT_MAX_MS', 60000),
    backoffFactor: numEnv('RECONNECT_BACKOFF', 2),
    jitterMs: intEnv('RECONNECT_JITTER_MS', 750),
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
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
  const line = `[${utcTs()}] [${level}] ${msg}${extras ? ' ' + extras : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  _writeLog(line);
}
const logger = {
  error: (m, ...a) => log('ERROR', m, ...a),
  warn : (m, ...a) => log('WARN',  m, ...a),
  info : (m, ...a) => log('INFO',  m, ...a),
  debug: (m, ...a) => log('DEBUG', m, ...a),
};

function money(n, currency = CONFIG.currency) {
  const x = Number(n || 0);
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)} ${currency}`;
}
function pct(n, dp = 2) { return `${(Number(n || 0) * 100).toFixed(dp)}%`; }
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
// 5. REST + WEBSOCKET CLIENT
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
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
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
  }

  _nextReqId() { this._reqId += 1; return this._reqId; }
  _legacyUrl() {
    const sep = this.cfg.legacyWsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.legacyWsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }
  _redact(url) {
    return String(url).replace(/([?&])(otp|app_id|token|auth)=[^&]+/gi, '$1$2=***');
  }
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN is empty.');
      this._stopped = true;
      return;
    }
    if (this._isPat) {
      logger.info('detected PAT token → using Deriv new Options API OTP flow');
      this._connectPat().catch(e => {
        logger.error('PAT connect failed:', e.message);
        this._scheduleReconnect();
      });
    } else {
      logger.info('using legacy Deriv WebSocket authorize flow');
      this._openWs(this._legacyUrl());
    }
  }
  async _connectPat() {
    const accountId = await this._resolvePatAccountId();
    const route = `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`;
    logger.info(`REST POST ${route}`);
    const res = await this._rest.post(route);
    if (res.status !== 200) {
      const msg = res.body?.errors?.[0]?.message || res.body?.message || JSON.stringify(res.body);
      throw new Error(`OTP failed (${res.status}): ${msg}`);
    }
    const wsUrl = res.body?.data?.url;
    if (!wsUrl) throw new Error(`OTP response missing data.url: ${JSON.stringify(res.body)}`);
    this._targetAccountId = accountId;
    this.accountInfo = {
      loginid: accountId,
      accountType: this.cfg.accountType,
      isVirtual: this.cfg.accountType !== 'real',
      currency: this.cfg.currency,
    };
    logger.info(`connecting → ${this._redact(wsUrl)}`);
    this._openWs(wsUrl);
  }
  async _resolvePatAccountId() {
    if (this._targetAccountId) return this._targetAccountId;

    // Best-effort account discovery. Docs recommend passing accountId explicitly;
    // this fallback supports environments where account list is enabled.
    const attempts = [
      ['GET', '/trading/v1/options/accounts', null],
      ['POST', '/trading/v1/options/accounts/list', null],
    ];
    for (const [method, route, body] of attempts) {
      try {
        const res = method === 'GET' ? await this._rest.get(route) : await this._rest.post(route, body);
        if (res.status >= 200 && res.status < 300) {
          const arr = Array.isArray(res.body?.data) ? res.body.data :
                      Array.isArray(res.body?.accounts) ? res.body.accounts : [];
          if (arr.length) {
            const desired = arr.find(a => String(a.account_type || '').toLowerCase() === this.cfg.accountType) || arr[0];
            const id = desired.account_id || desired.loginid || desired.id;
            if (id) {
              this.accountInfo = {
                loginid: id,
                accountType: desired.account_type || this.cfg.accountType,
                isVirtual: String(desired.account_type || this.cfg.accountType).toLowerCase() !== 'real',
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
    throw new Error('DERIV_ACCOUNT_ID is required for PAT tokens. Set it to your demo/real Options account ID, e.g. VRTC...');
  }
  _openWs(url) {
    try {
      this.ws = new WebSocket(url, { handshakeTimeout: 15000, headers: { 'User-Agent': 'DerivDigitDifferBot/1.0 Node.js' } });
    } catch (e) {
      logger.error('WebSocket construct failed:', e.message);
      this._scheduleReconnect();
      return;
    }
    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', d => this._onMessage(d));
    this.ws.on('error', e => this._onError(e));
    this.ws.on('close', (c, r) => this._onClose(c, r));
    this.ws.on('unexpected-response', (_, res) => {
      logger.error('WebSocket handshake failed:', res.statusCode, res.statusMessage);
      try { res.destroy(); } catch (_) {}
      this._scheduleReconnect();
    });
  }
  _onOpen() {
    logger.info('WebSocket connected ✔');
    this.connected = true;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this.emit('open');
    if (this._isPat) this._markPatAuthorized();
    else this._authorizeLegacy();
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
        email: a.email,
        isVirtual: !!a.is_virtual,
        accountType: a.account_type,
        currency: this.currency,
      };
      logger.info(`authorized ${a.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) balance=${this.balance} ${this.currency}`);
      this.emit('authorized', this.accountInfo);
    } catch (e) {
      logger.error('authorize failed:', e.message);
      this.authorized = false;
      this._scheduleReconnect();
    }
  }
  async _markPatAuthorized() {
    this.authorized = true;
    if (this.accountInfo?.balance != null) this.balance = Number(this.accountInfo.balance);
    this.currency = this.accountInfo?.currency || this.cfg.currency;
    // Try to obtain live balance over WS; if unsupported, continue.
    try {
      const b = await this._send({ balance: 1 }, 10000);
      if (b.balance) {
        this.balance = Number(b.balance.balance);
        this.currency = b.balance.currency || this.currency;
      }
    } catch (e) {
      logger.debug('balance check skipped:', e.message);
    }
    logger.info(`authorized ${this.accountInfo?.loginid || this._targetAccountId} via PAT/new API balance=${this.balance ?? '?'} ${this.currency}`);
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

    // Some streams may send msg_type without subscription id in edge cases.
    this.emit('message', msg);
  }
  _onError(err) {
    logger.error('WebSocket error:', err.message, err.code || '');
    this.emit('error', err);
  }
  _onClose(code, reason) {
    const rs = (() => { try { return reason?.toString() || ''; } catch { return ''; } })();
    logger.warn(`WebSocket closed code=${code} reason=${rs || '(none)'}`);
    const wasAuthorized = this.authorized;
    this.connected = false;
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
          reject(new Error(`Request timeout (${payload.proposal ? 'proposal' : payload.buy ? 'buy' : payload.ticks ? 'ticks' : 'req'})`));
        }
      }, timeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ ...payload, req_id: reqId })); }
      catch (e) {
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
          if (!subId) return reject(new Error('No subscription id in response'));
          this._subs.set(subId, callback);
          resolve(subId);
        },
        reject,
        timer,
      });
      try { this.ws.send(JSON.stringify({ ...payload, subscribe: 1, req_id: reqId })); }
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
  symbolField() { return this._isPat ? 'underlying_symbol' : 'symbol'; }
}

// ─────────────────────────────────────────────────────────────────────
// 6. MARKET DATA MANAGER
// ─────────────────────────────────────────────────────────────────────
function quoteToDigit(quote, pipSize = 2) {
  const n = Number(quote);
  if (!Number.isFinite(n)) return null;
  const decimals = Number.isInteger(pipSize) && pipSize >= 0 && pipSize <= 8 ? pipSize : 2;
  const s = n.toFixed(decimals).replace('.', '').replace('-', '');
  const ch = s[s.length - 1];
  const d = Number(ch);
  return Number.isInteger(d) ? d : null;
}

class MarketDataManager extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.history = new Map(); // symbol -> [{epoch, quote, digit}]
    this.subs = new Map();
    this.lastQuote = new Map();
    this.pipSizes = new Map();
    client.on('close', () => this.subs.clear());
  }
  async loadSymbols() {
    try {
      const res = await this.client._send({ active_symbols: 'brief' }, 15000);
      const list = res.active_symbols || [];
      for (const s of list) {
        const key = s.underlying_symbol || s.symbol;
        if (!key) continue;
        this.client.symbols.set(key, s);
        const pip = Number.isFinite(Number(s.pip_size)) ? Number(s.pip_size) : undefined;
        if (pip != null) this.pipSizes.set(key, pip);
      }
      logger.info(`loaded ${this.client.symbols.size} active symbols`);
    } catch (e) {
      logger.error('loadSymbols failed:', e.message);
    }
  }
  pipSize(symbol) {
    return this.pipSizes.get(symbol) ?? Number(this.client.symbols.get(symbol)?.pip_size) ?? 2;
  }
  async backfill(symbol, count = 1000) {
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
      logger.info(`backfilled ${symbol}: ${arr.length} ticks (pip_size=${pip})`);
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
      const cap = Math.max(this.cfg.tickWindow * 2, 2000);
      if (arr.length > cap) arr.splice(0, arr.length - cap);
      this.history.set(symbol, arr);
      this.emit('tick', symbol, tick);
    });
    this.subs.set(symbol, subId);
    logger.info(`subscribed ticks: ${symbol} (sub=${subId})`);
    return subId;
  }
  async bootstrap(symbols) {
    await Promise.all(symbols.map(s => this.subscribe(s).catch(e => logger.warn(`subscribe(${s}) failed:`, e.message))));
    await Promise.all(symbols.map(async s => {
      const hist = this.history.get(s) || [];
      if (hist.length < this.cfg.minTicksForAnalysis) {
        await this.backfill(s, Math.max(this.cfg.tickWindow, this.cfg.minTicksForAnalysis + 100));
      }
    }));
  }
  historyFor(symbol) { return this.history.get(symbol) || []; }
  last(symbol) { return this.lastQuote.get(symbol); }
}

// ─────────────────────────────────────────────────────────────────────
// 7. DIVER-9 DIGIT ANALYZER
// ─────────────────────────────────────────────────────────────────────
class DigitAnalyzer {
  constructor(cfg) { this.cfg = cfg; }

  entropy(counts) {
    const n = counts.reduce((s, x) => s + x, 0);
    if (!n) return 0;
    let h = 0;
    for (const c of counts) {
      if (!c) continue;
      const p = c / n;
      h -= p * Math.log(p);
    }
    return h / Math.log(10); // normalized 0..1
  }
  chiSquare(counts) {
    const n = counts.reduce((s, x) => s + x, 0);
    if (!n) return 0;
    const expected = n / 10;
    return counts.reduce((s, c) => s + ((c - expected) ** 2) / expected, 0);
  }
  countsFor(digits, window) {
    const slice = digits.slice(-Math.min(window, digits.length));
    const counts = Array(10).fill(0);
    for (const d of slice) counts[d] += 1;
    return { counts, n: slice.length };
  }
  rollingProbabilities(digits) {
    const windows = this.cfg.frequencyWindows.length ? this.cfg.frequencyWindows : [30, 60, 120, 300, 600];
    const probs = Array(10).fill(0);
    let wSum = 0;
    for (const w of windows) {
      if (digits.length < Math.max(20, Math.floor(w * 0.6))) continue;
      const { counts, n } = this.countsFor(digits, w);
      const weight = Math.sqrt(Math.min(w, n));
      wSum += weight;
      for (let d = 0; d < 10; d++) probs[d] += weight * (counts[d] / n);
    }
    if (!wSum) return Array(10).fill(0.1);
    return probs.map(x => x / wSum);
  }
  ewmaProbabilities(digits) {
    const alpha = Math.max(0.001, Math.min(0.5, this.cfg.ewmaAlpha));
    const p = Array(10).fill(0.1);
    for (const d of digits.slice(-this.cfg.tickWindow)) {
      for (let i = 0; i < 10; i++) p[i] *= (1 - alpha);
      p[d] += alpha;
    }
    const sum = p.reduce((s, x) => s + x, 0) || 1;
    return p.map(x => x / sum);
  }
  transitionProbabilities(digits, duration) {
    const dTicks = Math.max(1, Math.min(10, duration));
    const look = Math.min(this.cfg.transitionLookback, digits.length - dTicks - 1);
    if (look < 50) return { probs: Array(10).fill(0.1), n: 0, currentDigit: digits[digits.length - 1] };
    const currentDigit = digits[digits.length - 1];
    const counts = Array(10).fill(1); // Laplace smoothing
    let n = 10;
    const start = Math.max(0, digits.length - dTicks - look);
    for (let i = start; i + dTicks < digits.length; i++) {
      if (digits[i] === currentDigit) {
        counts[digits[i + dTicks]] += 1;
        n += 1;
      }
    }
    return { probs: counts.map(c => c / n), n, currentDigit };
  }
  gapSinceLast(digits, d) {
    for (let i = digits.length - 1, gap = 0; i >= 0; i--, gap++) {
      if (digits[i] === d) return gap;
    }
    return digits.length;
  }
  wilsonUpper(phat, n, z) {
    n = Math.max(1, n);
    phat = Math.max(0, Math.min(1, phat));
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = phat + z2 / (2 * n);
    const spread = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
    return Math.min(1, (center + spread) / denom);
  }
  analyze(symbol, ticks) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;
    const digits = ticks.map(t => t.digit).filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
    if (digits.length < this.cfg.minTicksForAnalysis) return null;

    const mainWindow = Math.min(this.cfg.tickWindow, digits.length);
    const recentDigits = digits.slice(-mainWindow);
    const { counts, n } = this.countsFor(recentDigits, mainWindow);
    const entropy = this.entropy(counts);
    const chiSquare = this.chiSquare(counts);
    const rolling = this.rollingProbabilities(recentDigits);
    const ewma = this.ewmaProbabilities(recentDigits);
    const trans = this.transitionProbabilities(recentDigits, this.cfg.durationTicks);

    // Dynamic weights: transition is useful only if enough same-current-digit samples exist.
    const transStrength = Math.max(0, Math.min(1, (trans.n - 20) / 120));
    const wTrans = 0.20 + 0.30 * transStrength;
    const wRoll = 0.55 - 0.20 * transStrength;
    const wEwma = 1 - wTrans - wRoll;

    const candidates = [];
    const recentLook = Math.min(this.cfg.recentLookback, recentDigits.length);
    const recentTail = recentDigits.slice(-recentLook);
    for (let d = 0; d < 10; d++) {
      const phat = wRoll * rolling[d] + wEwma * ewma[d] + wTrans * trans.probs[d];
      const recentHits = recentTail.filter(x => x === d).length;
      const freqWindow = Math.min(300, recentDigits.length);
      const { counts: fc, n: fn } = this.countsFor(recentDigits, freqWindow);
      const freqP = fc[d] / Math.max(1, fn);
      const nEff = Math.max(30, Math.min(fn, trans.n || fn));
      const ucb = Math.min(1, Math.max(
        this.wilsonUpper(phat, nEff, this.cfg.zScore),
        this.wilsonUpper(freqP, fn, this.cfg.zScore) * 0.75 + phat * 0.25,
      ) + this.cfg.modelRiskMargin);
      candidates.push({
        symbol,
        digit: d,
        pLoss: phat,
        pLossUpper: ucb,
        rollingP: rolling[d],
        ewmaP: ewma[d],
        transitionP: trans.probs[d],
        transitionN: trans.n,
        gap: this.gapSinceLast(recentDigits, d),
        recentHits,
      });
    }

    candidates.sort((a, b) => a.pLossUpper - b.pLossUpper || a.pLoss - b.pLoss);
    const best = candidates[0];
    const second = candidates[1];
    const probabilityGap = second ? (second.pLossUpper - best.pLossUpper) : 0;

    const gates = [];
    if (entropy < this.cfg.minEntropy) gates.push(`entropy-low:${entropy.toFixed(3)}`);
    if (entropy > this.cfg.maxEntropy) gates.push(`entropy-too-uniform:${entropy.toFixed(3)}`);
    if (chiSquare < this.cfg.minChiSquare) gates.push(`chisq-low:${chiSquare.toFixed(2)}`);
    if (chiSquare > this.cfg.maxChiSquare) gates.push(`chisq-high:${chiSquare.toFixed(2)}`);
    if (probabilityGap < this.cfg.minProbabilityGap) gates.push(`gap-low:${probabilityGap.toFixed(4)}`);
    if (best.recentHits > this.cfg.maxRecentDigitHits) gates.push(`recent-hit:${best.recentHits}`);
    if (best.pLossUpper > this.cfg.maxLossProb) gates.push(`loss-prob-high:${best.pLossUpper.toFixed(4)}`);

    const score = Math.max(0, Math.min(1,
      0.40 * Math.max(0, (0.10 - best.pLossUpper) / 0.03) +
      0.25 * Math.max(0, Math.min(1, probabilityGap / 0.025)) +
      0.20 * Math.max(0, Math.min(1, (chiSquare - this.cfg.minChiSquare) / 10)) +
      0.15 * Math.max(0, Math.min(1, best.gap / 30))
    ));

    return {
      symbol,
      ticks: recentDigits.length,
      lastDigit: recentDigits[recentDigits.length - 1],
      lastQuote: ticks[ticks.length - 1]?.quote,
      entropy,
      chiSquare,
      probabilityGap,
      score,
      candidates,
      best,
      gates,
      allowedByModel: gates.length === 0,
      weights: { rolling: wRoll, ewma: wEwma, transition: wTrans },
    };
  }
  rank(list) {
    return list.filter(Boolean).sort((a, b) => {
      const au = a.best?.pLossUpper ?? 1;
      const bu = b.best?.pLossUpper ?? 1;
      return au - bu || b.score - a.score;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// 8. TRADE EXECUTOR — DIGITDIFF
// ─────────────────────────────────────────────────────────────────────
class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.open = new Map();
  }
  async proposal(symbol, digit, stake) {
    const symbolKey = this.client.symbolField();
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
    if (!p?.id) throw new Error('No proposal id returned');
    const ask = Number(p.ask_price || stake);
    const payout = Number(p.payout || 0);
    const bres = await this.client._send({ buy: p.id, price: ask }, 15000);
    const b = bres.buy;
    if (!b?.contract_id) throw new Error('Buy did not return contract_id');

    const info = {
      contractId: b.contract_id,
      symbol,
      contractType: 'DIGITDIFF',
      digit,
      stake: ask,
      buyPrice: Number(b.buy_price || ask),
      payout: Number(b.payout || payout),
      buyTime: Number(b.purchase_time || Date.now() / 1000),
      durationTicks: this.cfg.durationTicks,
      proposalId: p.id,
      longcode: p.longcode || '',
      balanceAfter: b.balance_after != null ? Number(b.balance_after) : null,
      analysis,
    };
    this.open.set(info.contractId, info);
    logger.info(`bought DIGITDIFF #${info.contractId} ${symbol} differs ${digit} stake=${ask} payout=${info.payout}`);

    const subId = await this.client.subscribe({ proposal_open_contract: 1, contract_id: info.contractId }, msg => this._onUpdate(msg, info));
    info.subId = subId;
    this.emit('open', info);
    return info;
  }
  async _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    const cid = c.contract_id || info.contractId;
    const status = c.status;
    const profit = Number(c.profit || 0);
    if (status === 'won' || status === 'lost') {
      const finished = {
        ...info,
        contractId: cid,
        status,
        profit,
        sellPrice: Number(c.sell_price || 0),
        sellTime: Number(c.sell_time || Date.now() / 1000),
        entryTick: c.entry_tick,
        exitTick: c.exit_tick,
        currentSpot: c.current_spot,
        shortcode: c.shortcode,
      };
      this.open.delete(cid);
      this.emit('result', finished);
      const subId = msg.subscription?.id || info.subId;
      if (subId) await this.client.forget(subId).catch(() => {});
    } else {
      this.emit('update', { ...info, contractId: cid, status, profit });
    }
  }
  count() { return this.open.size; }
  openTrades() { return [...this.open.values()]; }
}

// ─────────────────────────────────────────────────────────────────────
// 9. STATISTICS MANAGER
// ─────────────────────────────────────────────────────────────────────
class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.dailySummaries = {}; // date -> stats summary
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
    const wins = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
    const total = list.reduce((s, t) => s + Number(t.profit || 0), 0);
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
      winRate: list.length ? wins.length / list.length * 100 : 0,
      grossWin,
      grossLoss,
      totalProfit: total,
      netPL: total,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      avgProfit: list.length ? total / list.length : 0,
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
// 10. TRADING BOT ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────
class TradingBot {
  constructor() {
    this.cfg = CONFIG;
    this.client = new DerivClient(this.cfg);
    this.market = new MarketDataManager(this.client, this.cfg);
    this.analyzer = new DigitAnalyzer(this.cfg);
    this.exec = new TradeExecutor(this.client, this.cfg);
    this.stats = new StatisticsManager();

    this.startBalance = null;
    this.lastBalance = null;
    this.lastTradeAt = 0;
    this.stopped = false;
    this._analysisT = null;
    this._hourlyBoot = null;
    this._hourlyT = null;
    this._eodBoot = null;
    this._eodT = null;
  }

  async start() {
    logger.info('===== Deriv Digit Differ Bot starting =====');
    logger.info(`config: stake=${this.cfg.stake} duration=${this.cfg.durationTicks}t assets=${this.cfg.assets.join(',')}`);
    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN missing. Put it in .env or environment.');
      process.exit(1);
    }
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
    process.on('uncaughtException', e => { logger.error('uncaughtException:', e); this._saveState('uncaughtException'); });
    process.on('unhandledRejection', e => { logger.error('unhandledRejection:', e); this._saveState('unhandledRejection'); });

    this.client.connect();
    this._scheduleSummaries();
  }

  async _onAuthorized(info) {
    this.startBalance = this.startBalance ?? this.client.balance ?? 0;
    this.lastBalance = this.lastBalance ?? this.client.balance ?? this.startBalance;
    logger.info(`start balance: ${this.startBalance} ${this.currency()}`);
    await this.market.loadSymbols();

    telegram.send(
      `🤖 <b>Digit Differ Bot Online</b>\n\n` +
      `👤 Account: <code>${htmlEscape(info.loginid || '?')}</code>\n` +
      `💼 Type: ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 Balance: ${(this.client.balance ?? 0).toFixed(2)} ${this.currency()}\n` +
      `📊 Assets: ${this.cfg.assets.join(', ')}\n` +
      `🎯 Contract: <b>DIGITDIFF</b>, duration <b>${this.cfg.durationTicks} tick(s)</b>\n` +
      `💵 Stake: ${this.cfg.stake.toFixed(2)} ${this.currency()}\n` +
      `🧠 Method: <b>DIVER-9</b> conservative value-edge filter\n` +
      `🕒 Trade day clock: <b>GMT/UTC</b> | EOD: ${this.cfg.eodTimeGmt} GMT\n\n` +
      `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
      `❌ Loss streak: current ${this.stats.currentLossStreak}, x2=${this.stats.lossStreakEvents.x2}, x3=${this.stats.lossStreakEvents.x3}, x4=${this.stats.lossStreakEvents.x4}`
    );

    await this.market.bootstrap(this.cfg.assets);
    if (this._analysisT) clearInterval(this._analysisT);
    this._analyzeAndTrade().catch(e => logger.error('initial analyze:', e.message));
    this._analysisT = setInterval(() => this._analyzeAndTrade().catch(e => logger.error('analyze:', e.message)), this.cfg.analysisIntervalMs);
  }

  _onDisconnected(code, reason, wasAuthorized) {
    telegram.send(`⚠️ <b>Connection lost</b>\ncode: <code>${code}</code>\nwas authorized: ${wasAuthorized ? 'yes' : 'no'}\n🔄 reconnecting...`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    this.exec.open.clear();
  }

  currentStake() {
    let mult = 1;
    if (this.cfg.recoveryEnabled) {
      const idx = Math.min(this.stats.currentLossStreak, this.cfg.recoveryMultipliers.length - 1);
      mult = this.cfg.recoveryMultipliers[idx] || 1;
    }
    return Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, +(this.cfg.stake * mult).toFixed(2)));
  }

  async _analyzeAndTrade() {
    if (this.stopped || !this.client.authorized) return;
    if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
    if (this.exec.count() >= this.cfg.maxOpenTrades) return;

    const today = utcDateStr();
    const todayTrades = this.stats.todayTrades(today);
    const todayStats = this.stats.stats(todayTrades);
    if (todayStats.count >= this.cfg.dailyMaxTrades) {
      logger.warn(`dailyMaxTrades reached (${todayStats.count}/${this.cfg.dailyMaxTrades})`);
      return;
    }
    if (todayStats.totalProfit <= -Math.abs(this.cfg.dailyMaxLoss)) {
      logger.warn(`dailyMaxLoss reached (${todayStats.totalProfit.toFixed(2)})`);
      return;
    }
    if (this.cfg.dailyMaxProfit > 0 && todayStats.totalProfit >= this.cfg.dailyMaxProfit) {
      logger.info(`dailyMaxProfit reached (${todayStats.totalProfit.toFixed(2)})`);
      return;
    }

    const analyses = this.cfg.assets.map(s => this.analyzer.analyze(s, this.market.historyFor(s)));
    const ranked = this.analyzer.rank(analyses);
    if (!ranked.length) {
      logger.debug('not enough digit data yet');
      return;
    }

    const topLog = ranked.slice(0, 3).map(a => `${a.symbol}:d${a.best.digit} u=${a.best.pLossUpper.toFixed(4)} H=${a.entropy.toFixed(3)} X2=${a.chiSquare.toFixed(1)} ${a.gates.length ? 'skip(' + a.gates[0] + ')' : 'ok'}`).join(' | ');
    logger.info(`DIVER-9 scan ${topLog}`);

    const stake = this.currentStake();
    const proposalCandidates = [];

    for (const a of ranked.slice(0, Math.max(1, this.cfg.proposalScanTopN))) {
      if (!a.allowedByModel) continue;
      const candidateDigits = a.candidates.slice(0, Math.max(1, Math.min(3, this.cfg.proposalScanTopN)));
      for (const c of candidateDigits) {
        if (c.recentHits > this.cfg.maxRecentDigitHits) continue;
        if (c.pLossUpper > this.cfg.maxLossProb) continue;
        try {
          const pres = await this.exec.proposal(a.symbol, c.digit, stake);
          const p = pres.proposal;
          if (!p?.id) continue;
          const ask = Number(p.ask_price || stake);
          const payout = Number(p.payout || 0);
          if (!(payout > ask)) continue;
          const breakEvenLossProb = 1 - ask / payout;
          const valueEdge = breakEvenLossProb - c.pLossUpper - this.cfg.safetyMargin;
          proposalCandidates.push({
            analysis: a,
            candidate: c,
            proposal: p,
            ask,
            payout,
            breakEvenLossProb,
            valueEdge,
          });
        } catch (e) {
          logger.debug(`proposal ${a.symbol} d${c.digit}:`, e.message);
        }
      }
    }

    proposalCandidates.sort((a, b) => b.valueEdge - a.valueEdge || a.candidate.pLossUpper - b.candidate.pLossUpper);
    const best = proposalCandidates[0];
    if (!best) {
      logger.debug('no proposal candidates after model gates');
      return;
    }
    if (best.valueEdge < this.cfg.minEdge) {
      logger.info(`skip: best edge ${best.valueEdge.toFixed(4)} < minEdge ${this.cfg.minEdge} (${best.analysis.symbol} d${best.candidate.digit})`);
      return;
    }

    const a = best.analysis;
    const c = best.candidate;
    const payload = {
      method: 'DIVER-9',
      digit: c.digit,
      pLoss: c.pLoss,
      pLossUpper: c.pLossUpper,
      breakEvenLossProb: best.breakEvenLossProb,
      valueEdge: best.valueEdge,
      entropy: a.entropy,
      chiSquare: a.chiSquare,
      probabilityGap: a.probabilityGap,
      lastDigit: a.lastDigit,
      recentHits: c.recentHits,
      gap: c.gap,
      score: a.score,
      weights: a.weights,
      recoveryStakeMultiplier: +(stake / this.cfg.stake).toFixed(2),
      currentLossStreak: this.stats.currentLossStreak,
    };

    const trade = await this.exec.buy(a.symbol, c.digit, stake, payload);
    this.lastTradeAt = Date.now();
    logger.info(`trade placed #${trade.contractId} ${a.symbol} DIGITDIFF differs ${c.digit} edge=${best.valueEdge.toFixed(4)} pLossU=${c.pLossUpper.toFixed(4)} qBE=${best.breakEvenLossProb.toFixed(4)}`);
  }

  _onTradeOpen(t) {
    const a = t.analysis || {};
    telegram.send(
      `🟢 <b>TRADE OPENED — DIGIT DIFFER</b>\n\n` +
      `🎫 Contract: <code>#${t.contractId}</code>\n` +
      `📊 Symbol: <code>${t.symbol}</code>\n` +
      `🔢 Prediction/barrier: final digit <b>DIFFERS from ${t.digit}</b>\n` +
      `⏱️ Duration: ${t.durationTicks} tick(s)\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currency()}\n` +
      `🎁 Payout: ${t.payout.toFixed(2)} ${this.currency()}\n\n` +
      `🧠 <b>DIVER-9 edge</b>\n` +
      `• Model P(loss digit ${t.digit}): ${(a.pLoss * 100).toFixed(2)}%\n` +
      `• Conservative upper bound: <b>${(a.pLossUpper * 100).toFixed(2)}%</b>\n` +
      `• Break-even loss prob: ${(a.breakEvenLossProb * 100).toFixed(2)}%\n` +
      `• Value edge: <b>${(a.valueEdge * 100).toFixed(2)}pp</b>\n` +
      `• Entropy: ${Number(a.entropy || 0).toFixed(3)} | χ²: ${Number(a.chiSquare || 0).toFixed(2)} | gap: ${Number(a.probabilityGap || 0).toFixed(4)}\n` +
      `• Current loss streak: ${a.currentLossStreak || 0}\n\n` +
      `🕒 ${utcTs()}`
    );
  }

  _onTradeResult(t) {
    const rec = this.stats.record(t);
    this.lastBalance = (this.lastBalance ?? this.client.balance ?? 0) + Number(t.profit || 0);
    if (t.balanceAfter != null) this.lastBalance = Number(t.balanceAfter) + Number(t.profit || 0);

    const emoji = t.status === 'won' ? '✅' : '❌';
    const label = t.status === 'won' ? 'WIN' : 'LOSS';
    const dur = Math.max(0, Number(t.sellTime || Date.now() / 1000) - Number(t.buyTime || 0));
    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));

    telegram.send(
      `${emoji} <b>TRADE ${label} — DIGIT DIFFER</b>\n\n` +
      `🎫 Contract: <code>#${t.contractId}</code>\n` +
      `📊 Symbol: <code>${t.symbol}</code> | differs <b>${t.digit}</b> | ${t.durationTicks}t\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currency()}\n` +
      `💰 P/L: <b>${money(t.profit, this.currency())}</b>\n` +
      `⏱️ Duration: ${dur.toFixed(1)}s\n\n` +
      `📅 <b>GMT Day Stats (${rec.date})</b>\n` +
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses})\n` +
      `• Win rate: ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net P/L: <b>${money(todayStats.totalProfit, this.currency())}</b>\n` +
      `• Profit factor: ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n` +
      `💼 <b>Overall Profit:</b> ${money(this.stats.overallProfit, this.currency())}\n` +
      `❌ <b>Consecutive Losses:</b> current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
      `   x2=${this.stats.lossStreakEvents.x2}  x3=${this.stats.lossStreakEvents.x3}  x4=${this.stats.lossStreakEvents.x4}`
    );

    this.lastTradeAt = Date.now();
    this._saveState('after-trade');
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
      telegram.send(`⏰ <b>Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\nNo trades this hour.\n\n💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}`);
      return;
    }
    let msg = `⏰ <b>Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\n` +
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

    let msg = `🌙 <b>END OF TRADE DAY — GMT</b>\n` +
              `📅 Trade day ended: <b>${date}</b>\n\n` +
              `<b>── Current Day Stats ──</b>\n`;
    if (ds.count) {
      msg += `📊 Trades: ${ds.count} (✅${ds.wins} ❌${ds.losses})\n` +
             `📈 Win rate: ${ds.winRate.toFixed(1)}%\n` +
             `💵 Total stake: ${ds.stake.toFixed(2)} ${this.currency()}\n` +
             `💰 Gross win: +${ds.grossWin.toFixed(2)}\n` +
             `📉 Gross loss: -${ds.grossLoss.toFixed(2)}\n` +
             `💼 <b>Net P/L: ${money(ds.totalProfit, this.currency())}</b>\n` +
             `🏆 Profit factor: ${ds.profitFactor === Infinity ? '∞' : ds.profitFactor.toFixed(2)}\n` +
             `❌ Max loss streak today: ${ds.maxLossStreak}\n\n`;
    } else {
      msg += `No trades recorded for this GMT trade day.\n\n`;
    }

    msg += `<b>── Overall / Stored Stats ──</b>\n` +
           `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
           `❌ Consecutive losses: current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
           `   x2=${this.stats.lossStreakEvents.x2}  x3=${this.stats.lossStreakEvents.x3}  x4=${this.stats.lossStreakEvents.x4}\n\n`;

    const rows = this.stats.allDailyRows(date);
    if (rows.length) {
      msg += `<b>── All Trade Days By Date ──</b>\n`;
      for (const row of rows.slice(-60)) {
        const s = row.stats;
        msg += `${row.date}: ${s.count} trades (✅${s.wins}/❌${s.losses}) | WR ${s.winRate.toFixed(1)}% | P/L ${money(s.totalProfit, this.currency())}\n`;
      }
      if (rows.length > 60) msg += `…showing last 60 of ${rows.length} stored trade days.\n`;
    }

    telegram.send(msg);
    this.stats.markEodSent(date);
    this._saveState(`eod-${reason}`);
    this.startBalance = this.client.balance ?? this.lastBalance ?? this.startBalance;
  }

  _statePayload(reason) {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      savedReason: reason,
      startBalance: this.startBalance,
      lastBalance: this.lastBalance,
      stats: this.stats.serialize(),
    };
  }
  _saveState(reason = 'checkpoint') {
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
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.startBalance = data.startBalance ?? null;
      this.lastBalance = data.lastBalance ?? null;
      this.stats = new StatisticsManager(data.stats || data);
      logger.info(`state restored from ${file}: overallProfit=${this.stats.overallProfit.toFixed(2)} lossStreak=${this.stats.currentLossStreak}`);
    } catch (e) {
      logger.warn(`state load failed (${file}):`, e.message);
    }
  }
  currency() { return this.client.currency || this.cfg.currency; }
  stop(signal) {
    if (this.stopped) return;
    this.stopped = true;
    logger.info(`stopping (${signal})`);
    telegram.send(`🛑 <b>Digit Differ Bot stopped</b>\nSignal: ${htmlEscape(signal)}\n💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}`);
    if (this._analysisT) clearInterval(this._analysisT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._hourlyT) clearInterval(this._hourlyT);
    if (this._eodBoot) clearTimeout(this._eodBoot);
    if (this._eodT) clearInterval(this._eodT);
    this._saveState('shutdown');
    this.client.stop();
    setTimeout(() => process.exit(0), 2500);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 11. BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   Deriv Digit Differ Trading Bot v1.0             ║');
  console.log('║   DIGITDIFF • DIVER-9 • GMT EOD • Stateful Stats  ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log('');
}
async function main() {
  printBanner();
  if (!CONFIG.apiToken) {
    console.error('❌ DERIV_API_TOKEN is not set. Create a .env file or export it.');
    process.exit(1);
  }
  if (RestClient.isPat(CONFIG.apiToken) && !CONFIG.accountId) {
    console.warn('⚠️  PAT token detected. DERIV_ACCOUNT_ID is strongly recommended and may be required by the new Deriv API.');
  }
  console.log(CONFIG.telegram.enabled ? '✅ Telegram notifications: ENABLED' : 'ℹ️  Telegram notifications: DISABLED');
  const bot = new TradingBot();
  await bot.start();
}

main().catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});
