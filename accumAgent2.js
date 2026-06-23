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
 *  Author : Arena.ai
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
  apiToken: ('pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee').trim(),
  appId   : '33uslPtthXBEkQOdfKfoY', //1089
  wsUrl   : 'wss://ws.derivws.com/websockets/v3',
  currency: ('USD').toUpperCase(),
  accountType: ('demo').toLowerCase(),  // 'demo' | 'real'

  // ─ Trade parameters ─
  stake          : parseFloat('1.0'),
  multiplier     : parseFloat('0.05'),  // 2 % growth rate
  multiplierStep : parseFloat('0.0'),   // grow after wins
  stopLoss       : parseFloat('100.0'),
  takeProfit     : parseFloat('500.0'),

  // ── Martingale (loss-recovery stake multiplier) ──
  // Set MARTINGALE=0 to disable. After `lossesBeforeMartingale` consecutive
  // losses the next stake is multiplied by `martingale`. Each subsequent
  // loss adds `martingaleStep` to the multiplier. A win resets to 1.0.
  martingale          : parseFloat('10'),    // base multiplier when active (0 = off)
  martingaleStep      : parseFloat('100'),  // added per extra consecutive loss
  lossesBeforeMartingale: parseInt('0'),  // N losses before martingale kicks in
  maxMartingaleStep   : parseFloat('110'),    // HARD CAP on the multiplier (e.g. 5 = never stake more than 5x base)

  // ─ Assets (Deriv synthetic indices) ─
  // assets: ('1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V,BOOM500,BOOM600,BOOM900,BOOM1000,CRASH500,CRASH600,CRASH900,CRASH1000')
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
  dailyMaxLoss  : parseFloat('110'),
  dailyMaxTrades: parseInt  ('2000000000'),

  // ─ Reconnect ─
  reconnect: {
    initialDelayMs: 1000,
    maxDelayMs    : 60000,
    backoffFactor : 2,
    jitterMs      : 750,
  },

  // ─ Logging ─
  logFile : 'deriv_bot1b1_01.log',
  logLevel: ('INFO').toUpperCase(),

  // ── VATP (Volatility-Adjusted Trend Persistence) strategy tunables ──
  // 4-factor composite score, normalized to [0,1]. The bot enters a trade
  // iff score >= minConfidence AND hurst <= maxHurst AND volRegime <= maxVolRegime.
  minConfidence: parseFloat('0.75'),
  maxHurst     : parseFloat('0.58'),  // 0.5 = random; >0.65 = strong trend (risky)
  maxVolRegime : parseInt  ('0',    10), // 0=low 1=normal 2=high 3=extreme
  sessionWeighting: true,

  // Weights for the 4 VATP factors + CWMRAS components.
  // Sum should be ~1.0; tune per asset class.
  weights: {
    dps     : parseFloat('0.20'),   // Directional Persistence (Hurst)
    vrf     : parseFloat('0.30'),   // Volatility Regime (low-vol preferred)
    mqi     : parseFloat('0.15'),   // Momentum Quality (smoothness)
    bb      : parseFloat('0.15'),   // BB middle proximity
    rsi     : parseFloat('0.10'),   // RSI neutrality
    session : parseFloat('0.10'),   // Hour-of-day soft preference
  },

  // ── SRAS: Stay-Regime Accumulator Strategy tunables ──
  // The user's key insight: consecutive ticks_stayed_in values that TREND
  // UP indicate a stable market regime. We formalise this into a gate.
  srasMin       : parseFloat('0.40'),  // min SRAS score to enter
  stayRefreshMs : parseInt  ('60000',10), // how often to refresh stay cache
  minRisingStreak: parseInt('2',   10), // require N consecutive rising stays

  // ── State persistence ──
  stateFile           : 'accuAgentBotb1_state.json',  // path to JSON state file
  stateSaveOnTrade    : true,
  stateSaveOnShutdown : true,


  // ── Growth-rate filter (barrierByGrowth analysis gate) ──
  // Only trade when the analyzer's suggestedGrowth falls inside this range.
  // The analyzer maps per-tick σ to the smallest growth_rate whose barrier
  // still covers ≥ 2σ of recent moves. Restricting to a narrow band means:
  // we only enter when the market is calm enough to safely use higher rates.
  minGrowth : parseFloat('0.01'),
  maxGrowth : parseFloat('0.05'),
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
// 5a. DERIV REST CLIENT  (for new PAT/OAuth OTP-based auth)
// ─────────────────────────────────────────────────────────────────────
//
//  The new Deriv API (per https://developers.deriv.com/docs/intro/api-overview/)
//  uses two complementary components:
//
//    • REST API  (https://api.derivws.com)
//        - Account management
//        - OTP generation for WebSocket authentication
//        - Auth via "Authorization: Bearer <PAT_or_JWT>" + "Deriv-App-ID" header
//
//    • WebSocket API  (wss://api.derivws.com/trading/v1/options/ws/...)
//        - Real-time trading, market data, subscriptions
//        - Auth via OTP embedded in the WebSocket URL (no authorize message needed)
//
//  Personal Access Tokens (PAT) start with "pat_".
//
class RestClient {
  constructor(baseUrl, appId, token) {
    this.baseUrl = baseUrl || 'https://api.derivws.com';
    this.appId   = appId   || '1089';
    this.token   = token   || '';
  }

  /**
   * Detect if the token is a Personal Access Token (PAT).
   * PATs always start with "pat_" and are followed by a long
   * alphanumeric string. We accept any alphanumeric content after
   * the prefix (length ≥ 20) so that placeholder/dev tokens are
   * also routed through the new API.
   */
  static isPat(token) {
    return typeof token === 'string'
        && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
  }

  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(path, this.baseUrl); }
      catch (e) { return reject(new Error(`Invalid URL: ${path}`)); }
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;
      const opts = {
        method,
        hostname: url.hostname,
        port     : url.port || (isHttps ? 443 : 80),
        path     : url.pathname + url.search,
        headers  : {
          'Deriv-App-ID': this.appId,
          'Authorization': 'Bearer ' + this.token,
          'Accept': 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        timeout: 15000,
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
      req.on('timeout', () => { req.destroy(new Error('REST request timeout')); });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async get(path)      { return this._request('GET',  path); }
  async post(path, b)  { return this._request('POST', path, b); }
  async delete(path)   { return this._request('DELETE', path); }
}

// ─────────────────────────────────────────────────────────────────────
// 5.  DERIV WEBSOCKET CLIENT  (with auto-reconnect, PAT-aware)
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
    // ── New API (PAT/OAuth) detection ──
    this._isPat           = RestClient.isPat(cfg.apiToken);
    this._rest            = this._isPat
                            ? new RestClient('https://api.derivws.com', cfg.appId, cfg.apiToken)
                            : null;
    this._otpUrl          = null;        // set after OTP request
    this._targetAccount   = null;        // set after account lookup
  }

  _nextReqId() { return ++this._reqId; }

  /** Build WebSocket URL for the LEGACY api.derivws.com v3 endpoint. */
  _url() {
    const sep = this.cfg.wsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.wsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }

  /** Redact a WebSocket URL of any sensitive query params (otp=, app_id=, token=). */
  _redact(url) {
    return url
      .replace(/([?&])(otp|app_id|token)=[^&]+/g, '$1$2=***')
      .replace(/wss:\/\/[^/]+/, m => m);   // keep host
  }

  /** Open a WebSocket to an arbitrary URL (used for OTP-pre-authenticated endpoints). */
  _openWs(url) {
    try {
      this.ws = new WebSocket(url, {
        headers: { 'User-Agent': 'DerivAccumulatorBot/2.0 (+Node.js)' },
        handshakeTimeout: 15000,
      });
    } catch (e) {
      logger.error('ws construct failed:', e.message);
      this._scheduleReconnect();
      return false;
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
    return true;
  }

  connect() {
    if (this.ws &&
        (this.ws.readyState === WebSocket.OPEN ||
         this.ws.readyState === WebSocket.CONNECTING)) return;

    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN is empty — aborting');
      this._stopped = true;
      return;
    }

    // Branch by token format.
    if (this._isPat) {
      logger.info('detected PAT token → using NEW Deriv API (OTP flow)');
      this._newApiConnect().catch(e => {
        logger.error('new API connect failed:', e.message);
        this._scheduleReconnect();
      });
    } else {
      logger.info('using legacy Deriv API (token authorize flow)');
      const url = this._url();
      logger.info(`connecting → ${this._redact(url)}`);
      this._openWs(url);
    }
  }

  /**
   * NEW API flow:
   *   1. REST GET  /trading/v1/options/accounts   → list accounts
   *   2. REST POST /trading/v1/options/accounts/{id}/otp → get WS URL
   *   3. Connect WebSocket to returned URL (pre-authenticated via OTP)
   *   4. No authorize message needed — the URL itself authenticates
   */
  async _newApiConnect() {
    const desiredType = (this.cfg.accountType || 'demo').toLowerCase();
    // ── Step 1: List accounts ──
    logger.info('REST: GET /trading/v1/options/accounts');
    const accRes = await this._rest.get('/trading/v1/options/accounts');
    if (accRes.status !== 200) {
      const msg = accRes.body?.errors?.[0]?.message
        || accRes.body?.message
        || JSON.stringify(accRes.body);
      let hint = '';
      if (accRes.status === 401) {
        hint = ' — check that (1) your PAT is valid and not expired, and (2) DERIV_APP_ID matches a registered app at https://developers.deriv.com/';
      } else if (accRes.status === 403) {
        hint = ' — your PAT may lack the required "trade" scope; regenerate at https://app.deriv.com/account/api-token';
      } else if (accRes.status === 404) {
        hint = ' — account endpoint not found; you may be using a legacy token with the new API';
      }
      throw new Error(`account list failed (${accRes.status}): ${msg}${hint}`);
    }
    const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
    if (!accounts.length) throw new Error('no Options accounts found for this token');

    // Prefer requested type; otherwise fall back to first available.
    const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desiredType)
              || accounts[0];
    this._targetAccount = acct;
    this.accountInfo = {
      loginid    : acct.account_id,
      email      : acct.email,
      isVirtual  : (acct.account_type || '').toLowerCase() === 'demo',
      accountType: acct.account_type,
      currency   : acct.currency,
      balance    : parseFloat(acct.balance),
      group      : acct.group,
    };
    logger.info(`selected account ${acct.account_id} (${acct.account_type}, ${acct.currency}, balance=${acct.balance})`);

    // ── Step 2: Get OTP for that account ──
    const otpPath = `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`;
    logger.info(`REST: POST ${otpPath}`);
    const otpRes = await this._rest.post(otpPath);
    if (otpRes.status !== 200) {
      const msg = otpRes.body?.errors?.[0]?.message
        || JSON.stringify(otpRes.body);
      throw new Error(`OTP request failed (${otpRes.status}): ${msg}`);
    }
    const wsUrl = otpRes.body?.data?.url;
    if (!wsUrl || !/^wss?:/i.test(wsUrl)) {
      throw new Error(`OTP response missing .data.url: ${JSON.stringify(otpRes.body)}`);
    }
    this._otpUrl = wsUrl;
    logger.info(`connecting → ${this._redact(wsUrl)}`);
    this._openWs(wsUrl);
    // Authorization happens in _onOpen via _newApiMarkAuthorized()
  }

  _onOpen() {
    logger.info('ws connected ✔');
    this.connected     = true;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this.emit('open');

    // For PAT flow, the WS URL is already authenticated — no authorize message.
    if (this._isPat) {
      this._newApiMarkAuthorized();
    } else {
      this._authorize();
    }
  }

  /** Finalise PAT auth: mark authorized and emit event. */
  _newApiMarkAuthorized() {
    if (!this.accountInfo) return;
    this.authorized = true;
    this.balance    = this.accountInfo.balance ?? null;
    this.currency   = this.accountInfo.currency || this.cfg.currency;
    logger.info(
      `authorized ${this.accountInfo.loginid} ` +
      `(${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) ` +
      `balance=${this.balance} ${this.currency} ` +
      `via PAT/new-API`,
    );
    this.emit('authorized', this.accountInfo);
  }

  async _authorize() {
    // Legacy authorize flow (old API only — not used for PAT).
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
      // Some error codes are EXPECTED race conditions after a successful
      // sell() (multiple POC updates arriving simultaneously trigger
      // concurrent sell attempts; the contract has already ended so the
      // second attempt is rejected). Demote them to DEBUG.
      const RACE_CONDITION_CODES = new Set([
        'BetExpired',          // contract already ended by previous sell
        'TradingDurationNotAllowed',  // same — legacy alias on some apps
        'ContractNotFound',    // contract ID no longer valid
        'InvalidContract',     // ditto
      ]);
      if (RACE_CONDITION_CODES.has(code)) {
        logger.debug(`(race) api error: ${code} – ${msg.error.message} req=${msg.req_id || '?'}`);
      } else {
        logger.error(`api error: ${code} – ${msg.error.message} (req=${msg.req_id || '?'})`);
      }
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
    // ── SRAS stay cache: symbol → growth_rate → { ticks_stayed_in, ts, maxTicks, maxPayout } ──
    this.stayCache   = new Map();
    this._refreshInFlight = false;

    client.on('close', () => {
      // Stale subscription ids after reconnect
      this.subs.clear();
      // Keep stay cache (it's symbol-level, not subscription-level)
    });
  }

  /**
   * Cache the ticks_stayed_in array returned by a proposal response.
   * Called by the TradeExecutor after every buy.
   */
  cacheStays(symbol, growthRate, contractDetails) {
    if (!contractDetails) return;
    const arr = contractDetails.ticks_stayed_in;
    if (!Array.isArray(arr) || !arr.length) return;
    const key = +(+growthRate).toFixed(4);
    if (!this.stayCache.has(symbol)) this.stayCache.set(symbol, new Map());
    const sub = this.stayCache.get(symbol);
    sub.set(key, {
      ticks_stayed_in: arr,
      maxTicks : +contractDetails.maximum_ticks || 0,
      maxPayout: +contractDetails.maximum_payout || 0,
      barrier  : +contractDetails.tick_size_barrier_percentage || 0,
      ts       : Date.now(),
    });
    logger.debug(`cached stays ${symbol} g=${key} n=${arr.length} mean=${(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1)}`);
  }

  /** Get cached stays for a (symbol, growth_rate). */
  getStays(symbol, growthRate) {
    const sub = this.stayCache.get(symbol);
    if (!sub) return null;
    const key = +(+growthRate).toFixed(4);
    return sub.get(key) || null;
  }

  /**
   * Refresh stay stats for all assets by sending cheap proposal requests
   * (no buy required). Runs every STAY_REFRESH_MS.
   */
  async refreshStays(assets, growthRate) {
    if (this._refreshInFlight) return;
    if (!this.client.authorized) return;
    this._refreshInFlight = true;
    try {
      for (const sym of assets) {
        try {
          // SRAS: cheap proposal requests to harvest ticks_stayed_in.
          // The new API expects `underlying_symbol`, the legacy API `symbol`.
          const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
          const res = await this.client._send({
            proposal: 1,
            amount  : this.cfg.stake,
            basis   : 'stake',
            contract_type: 'ACCU',
            currency: this.cfg.currency,
            [symbolKey]: sym,
            growth_rate: growthRate,
          }, 8000);
          if (res?.proposal?.contract_details) {
            this.cacheStays(sym, growthRate, res.proposal.contract_details);
          }
        } catch (e) {
          logger.debug(`refreshStays(${sym}) failed:`, e.message);
        }
      }
    } finally {
      this._refreshInFlight = false;
    }
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

    // ── VATP four-factor analysis ──
    // Each factor is normalised to [0,1]. Weights from this.cfg.weights.
    const w = this.cfg.weights || {
      dps: 0.15, vrf: 0.30, mqi: 0.20, bb: 0.15, rsi: 0.10, session: 0.10,
    };

    // Factor 1: Directional Persistence Score (DPS) → Hurst
    // For ACCU, persistence is RISKY (barriers are fixed). We INVERT the
    // typical "trade the trend" logic. Ideal Hurst ∈ [0.45, 0.58].
    const hurst = this._hurst(q);
    let dpsNorm;
    if (hurst >= 0.45 && hurst <= 0.58)      dpsNorm = 1.0;          // sweet spot
    else if (hurst < 0.45)                   dpsNorm = 0.05;          // mean-reverting (whipsaw risk)
    else if (hurst <= 0.65)                  dpsNorm = 0.07;          // mildly trending
    else                                      dpsNorm = 0.2;          // strong trend (barrier risk)
    const dpsLabel = hurst < 0.45 ? 'mean-reverting' :
                     hurst <= 0.58 ? 'calm-persistent' :
                     hurst <= 0.65 ? 'trending' : 'strong-trend';

    // Factor 2: Volatility Regime Filter (VRF)
    // Only trade in low/normal regime (skip high/extreme).
    const volRegime = this._volRegime(q);                       // 0..3
    const vrfNorm = volRegime === 0 ? 1.0 :
                    volRegime === 1 ? 0.7 :
                    volRegime === 2 ? 0.2 : 0.0;
    const vrfLabel = ['low', 'normal', 'high', 'extreme'][volRegime];

    // Factor 3: Momentum Quality Index (MQI)
    // Confirms that any momentum is smooth, not choppy.
    const mqi = this._mqi(q, 20);
    const mqiNorm = mqi;                                        // already 0..1

    // Factor 4: Session & Time-of-Day (soft)
    const session = this._sessionScore();

    // ── Composite CWMRAS+VATP Score ──
    let score = 0;
    let reasonParts = [];

    // 1) Calm regime (most important — volatility is the #1 killer)
    if (calmScore < 0.55)      { score += 0.35; reasonParts.push('very-calm'); }
    else if (calmScore < 0.75) { score += 0.25; reasonParts.push('calm'); }
    else if (calmScore < 1.0)  { score += 0.00; reasonParts.push('normal'); }
    else if (calmScore < 1.3)  { score -= 0.25; reasonParts.push('turbulent'); }
    else                        { score -= 0.35; reasonParts.push('stormy'); }

    // 2) BB middle-band proximity (entry at the mean is safest)
    if (bbMiddleProximity > 0.85)      { score += 0.25; reasonParts.push('at-mean'); }
    else if (bbMiddleProximity > 0.60){ score -= 0.15; reasonParts.push('near-mean'); }
    else if (bbMiddleProximity > 0.35){ score -= 0.25; reasonParts.push('off-mean'); }
    else                                { score -= 0.35; reasonParts.push('at-band'); }

    // 3) RSI in neutral zone (40–60) means no extreme momentum
    if (rsi >= 45 && rsi <= 55)        { score += 0.15; reasonParts.push('rsi-neutral'); }
    else if (rsi >= 35 && rsi <= 65)   { score -= 0.10; reasonParts.push('rsi-mild'); }
    else if (rsi < 25 || rsi > 75)     { score -= 0.25; reasonParts.push('rsi-extreme'); }
    else                                { score -= 0.15; reasonParts.push('rsi-tilted'); }

    // 4) Trend strength (moderate trend ok; no trend = whipsaw risk; strong trend = barrier risk)
    if (trendStrength >= 0.4 && trendStrength <= 2.0)   { score += 0.10; reasonParts.push('good-trend'); }
    else if (trendStrength < 0.4)                       { score -= 0.10; reasonParts.push('no-trend'); }
    else                                                  { score -= 0.20; reasonParts.push('extreme-trend'); }

    // 5) Mean reversion (high reversion → whipsaw)
    if (meanReversion > 0.45)        { score -= 0.30; reasonParts.push('whipsaw'); }
    else if (meanReversion > 0.15)  { score -= 0.15; reasonParts.push('mean-rev'); }

    // 6) Safe-move ratio (estimated per-tick survival probability proxy)
    if (safeMoveRatio > 0.85)       { score += 0.15; reasonParts.push('safe-ticks'); }
    else if (safeMoveRatio > 0.70)  { score -= 0.15; reasonParts.push('ok-ticks'); }
    else                              { score -= 0.25; reasonParts.push('risky-ticks'); }

    // VATP factor contributions (added on top of CWMRAS components)
    score += w.dps     * dpsNorm;
    score += w.vrf     * vrfNorm;
    score += w.mqi     * mqiNorm;
    score += w.session * session;

    // Hard gates: ANY of these → score = 0
    if (hurst > (this.cfg.maxHurst ?? 0.70)) {
      score = 0;
      reasonParts.push('hurst-too-high');
    }
    if (volRegime > (this.cfg.maxVolRegime ?? 1)) {
      score = 0;
      reasonParts.push('vol-regime-skip');
    }

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
    // const barrierByGrowth = { 0.01: 0.061, 0.02: 0.056, 0.03: 0.053, 0.04: 0.050, 0.05: 0.048 };
    // if (perTickStdevPct > 0) {
    //   for (const g of [0.01, 0.02, 0.03, 0.04, 0.05]) {
    //     // barrier is on EACH side; we need barrier_pct ≥ target × per_tick_stdev_pct
    //     if (barrierByGrowth[g] >= targetSigmaCoverage * perTickStdevPct) {
    //       suggestedGrowth = g;
    //       break;
    //     }
    //     suggestedGrowth = g;  // last fallback
    //   }
    // }

    const barrierByGrowth = { 0.04: 0.050, 0.05: 0.048 };
    if (perTickStdevPct > 0) {
      for (const g of [0.04, 0.05]) {
        // barrier is on EACH side; we need barrier_pct ≥ target × per_tick_stdev_pct
        if (barrierByGrowth[g] >= targetSigmaCoverage * perTickStdevPct) {
          suggestedGrowth = g;
          break;
        }
        suggestedGrowth = g;  // last fallback
      }
    }

    // ── Recommended take-profit (scale with safety) ──
    // In a calm regime we can hold longer → larger TP
    // In a turbulent regime → tighter TP
    const baseTpFactor = 0.10;          // TP = stake × factor
    const tpFactor = Math.max(0.8, baseTpFactor * (0.5 + score));
    const recommendedTp = +(this.cfg.stake * tpFactor).toFixed(2);
    // const recommendedTp = baseTpFactor;

    return {
      symbol,
      n,
      price,
      mean, stdev, cv,
      // Regime detection (CWMRAS)
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
      // ── VATP four factors ──
      // Factor 1: Directional Persistence (Hurst-based)
      hurst, dpsNorm, dpsLabel,
      // Factor 2: Volatility Regime Filter
      volRegime, vrfNorm, vrfLabel,
      gkVol: this._gkVol(q),
      // Factor 3: Momentum Quality Index
      mqi, mqiNorm,
      // Factor 4: Session/timing (soft)
      session,
      // Decision
      score,
      reasons: reasonParts,
      recommendTrade:
        score >= (this.cfg.minConfidence ?? 0.55) &&
        hurst <= (this.cfg.maxHurst ?? 0.70) &&
        volRegime <= (this.cfg.maxVolRegime ?? 1) &&
        bbMiddleProximity > 0.85,
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

  // ────────────────────────────────────────────────────────────────
  // VATP additions: Hurst / Vol-regime / MQI / session weighting
  // ────────────────────────────────────────────────────────────────

  /**
   * Hurst exponent via Rescaled Range (R/S) analysis.
   * Returns a value ≈ 0.5 for random walk, > 0.5 for persistent (trending),
   * < 0.5 for anti-persistent (mean-reverting).
   *
   * NOTE for ACCU: persistent trending (high Hurst) is RISKY because the
   * barrier is fixed at entry. We use H to FILTER OUT trending markets.
   * The ideal regime for ACCU is H ≈ 0.50–0.58 (mild persistence / calm drift).
   */
  _hurst(q, maxLag = 50) {
    const n = q.length;
    if (n < maxLag + 2) return 0.5;        // not enough data → assume random
    // Compute log returns
    const returns = new Array(n - 1);
    for (let i = 1; i < n; i++) {
      const a = q[i - 1], b = q[i];
      returns[i - 1] = (a !== 0) ? Math.log(b / a) : 0;
    }
    // R/S for several lags, then slope of log(R/S) vs log(lag) gives Hurst
    const lags = [10, 20, 30, 40, 50].filter(l => l < returns.length);
    const points = [];
    for (const lag of lags) {
      const chunks = Math.floor(returns.length / lag);
      let sumRS = 0, count = 0;
      for (let c = 0; c < chunks; c++) {
        const start = c * lag;
        const slice = returns.slice(start, start + lag);
        // mean-adjusted cumulative deviation
        let m = 0; for (const x of slice) m += x;
        m /= slice.length;
        let cum = 0, maxC = -Infinity, minC = Infinity;
        for (const x of slice) {
          cum += (x - m);
          if (cum > maxC) maxC = cum;
          if (cum < minC) minC = cum;
        }
        const range = maxC - minC;
        // standard deviation of the slice
        let v = 0; for (const x of slice) v += (x - m) ** 2;
        const sd = Math.sqrt(v / slice.length) || 1e-12;
        sumRS += range / sd;
        count++;
      }
      if (count > 0) points.push([Math.log(lag), Math.log(sumRS / count)]);
    }
    if (points.length < 2) return 0.5;
    // Linear regression slope in log-log space
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (const [x, y] of points) { sx += x; sy += y; sxy += x * y; sxx += x * x; }
    const denom = points.length * sxx - sx * sx;
    const slope = denom !== 0 ? (points.length * sxy - sx * sy) / denom : 0;
    // Clamp to a reasonable range
    return Math.max(0.1, Math.min(0.9, slope));
  }

  /**
   * Garman-Klass volatility estimator.
   * For tick data we don't have OHLC, so we approximate with
   * (high-low)/close + log(close/open) terms using a small rolling window.
   * Returns an annualized-style estimator (we just use the raw scale for ranking).
   */
  _gkVol(q, window = 20) {
    if (q.length < window + 1) return 0;
    const start = q.length - window;
    let s = 0;
    for (let i = start; i < q.length; i++) {
      // Approximate high/low using rolling max/min
      let hi = -Infinity, lo = Infinity;
      const lookback = q.slice(Math.max(0, i - 4), i + 1);
      for (const v of lookback) { if (v > hi) hi = v; if (v < lo) lo = v; }
      const o = q[i - 1] || q[i];
      const c = q[i];
      const hl = (Math.log(hi / lo)) ** 2;
      const co = (Math.log(c / o)) ** 2;
      s += 0.5 * hl - (2 * Math.log(2) - 1) * co;
    }
    return Math.sqrt(Math.max(s / window, 1e-12));
  }

  /**
   * Volatility Regime Classifier (VRF).
   * Compares current σ to a rolling distribution and assigns a regime:
   *   0 = low (calm), 1 = normal, 2 = high, 3 = extreme
   */
  _volRegime(q) {
    if (q.length < 60) return 1;
    // Use a rolling window of recent std devs
    const seg = 20;             // segment length
    const sds = [];
    for (let i = seg; i <= q.length; i++) {
      const slice = q.slice(i - seg, i);
      let m = 0; for (const v of slice) m += v;
      m /= slice.length;
      let v = 0; for (const x of slice) v += (x - m) ** 2;
      sds.push(Math.sqrt(v / slice.length));
    }
    if (sds.length < 3) return 1;
    // Current σ is the last segment
    const current = sds[sds.length - 1];
    // Percentile rank of current within the rolling distribution
    const sorted = [...sds].sort((a, b) => a - b);
    const rank = sorted.findIndex(v => v >= current) / sorted.length;
    if (rank < 0.4)  return 0;        // low regime
    if (rank < 0.7)  return 1;        // normal
    if (rank < 0.9)  return 2;        // high
    return 3;                          // extreme
  }

  /**
   * Momentum Quality Index (MQI).
   * Rate-of-change of the last K ticks, weighted by consistency (low std of returns).
   * High MQI = strong, smooth momentum. Low MQI = choppy / weak.
   */
  _mqi(q, k = 20) {
    if (q.length < k + 1) return 0;
    const slice = q.slice(-k);
    const ret = [];
    for (let i = 1; i < slice.length; i++) {
      ret.push((slice[i] - slice[i-1]) / slice[i-1]);
    }
    if (!ret.length) return 0;
    // Direction-weighted return: positive returns contribute +1, negative -1
    let signed = 0;
    for (const r of ret) signed += Math.sign(r) * Math.abs(r);
    const consistency = ret.filter(r => r > 0).length / ret.length;     // 0..1
    const mag = Math.abs(signed);
    // MQI ∈ [0, 1+]: high when consistent and high magnitude
    return Math.min(1, consistency * Math.tanh(mag * 100));
  }

  /**
   * Session/timing soft-weight in [0, 1].
   * NOTE: synthetic indices have *constant* volatility by design, but retail
   * trading activity does cluster by hour-of-day, which can create *perceived*
   * trends. We treat this as a soft tie-breaker, NOT a hard filter.
   *
   * The hour weights below were derived from observed tick-density patterns
   * and are intentionally mild. Users can disable them by setting
   * CONFIG.sessionWeighting = false.
   */
  _sessionScore() {
    if (!this.cfg.sessionWeighting) return 0.5;
    const hour = new Date().getUTCHours();
    // Mild preference for the London/NY overlap (13–17 UTC) and quiet Asian morning (1–6 UTC).
    // All hours are eligible; weights just nudge the score.
    const w = {
      0: 0.55,  1: 0.60,  2: 0.60,  3: 0.65,  4: 0.65,  5: 0.60,  6: 0.55,
      7: 0.50,  8: 0.45,  9: 0.45, 10: 0.50, 11: 0.55, 12: 0.60,
     13: 0.65, 14: 0.70, 15: 0.75, 16: 0.70, 17: 0.65, 18: 0.55,
     19: 0.50, 20: 0.50, 21: 0.55, 22: 0.55, 23: 0.55,
    };
    return w[hour] ?? 0.5;
  }

  // ────────────────────────────────────────────────────────────────
  // SRAS: Stay-Regime Accumulator Strategy
  // ────────────────────────────────────────────────────────────────
  //
  //  The user's key observation: when consecutive `ticks_stayed_in`
  //  digits (the per-trade tick-survival counts from Deriv's proposal
  //  response) TREND UPWARD after successive resets, the market is in
  //  a stable regime — the per-tick survival probability is rising.
  //
  //  We formalise this as 5 sub-metrics on the ticks_stayed_in array:
  //
  //    1. Stay Mean         — average survival in ticks (high = stable)
  //    2. Stay Median       — robust central tendency
  //    3. Stay Trend        — OLS slope of last K stays (positive = rising)
  //    4. Above-Median Count— fraction of last K stays ≥ historical median
  //    5. Stay Consistency  — 1 − (stdev / mean) of stays
  //
  //  The strategy prefers entries when ALL of these are favourable.

  /**
   * Compute SRAS metrics from a ticks_stayed_in array.
   * @param {number[]} arr  ticks_stayed_in from the API
   * @returns {object|null}
   */
  analyzeStays(arr) {
    if (!Array.isArray(arr) || arr.length < 5) return null;
    const n = arr.length;
    const mean = arr.reduce((s, v) => s + v, 0) / n;
    const sorted = [...arr].sort((a, b) => a - b);
    const median = sorted[Math.floor(n / 2)];

    // Stay Trend: OLS slope on last K stays (rising-digits signal).
    // We split into "older" (first half of array) and "recent" (last K).
    const K = Math.min(30, n);
    const recent = arr.slice(-K);
    const older  = arr.slice(0, Math.max(5, n - K));

    // Slope of recent stays (per index). Positive = rising digits.
    let slope = 0;
    if (recent.length >= 2) {
      let sx = 0, sy = 0, sxy = 0, sxx = 0;
      for (let i = 0; i < recent.length; i++) {
        sx += i; sy += recent[i]; sxy += i * recent[i]; sxx += i * i;
      }
      const d = (recent.length * sxx - sx * sx) || 1;
      slope = (recent.length * sxy - sx * sy) / d;
    }
    // Normalise slope relative to median (per-step fraction).
    const trendNorm = median > 0 ? slope / median : 0;

    // Above-Median Count: fraction of recent stays above historical median.
    const aboveMedian = recent.filter(v => v >= median).length / recent.length;

    // Stay Consistency (lower variance → more predictable regime).
    let v = 0;
    for (const x of arr) v += (x - mean) ** 2;
    const stdev = Math.sqrt(v / n);
    const consistency = mean > 0 ? Math.max(0, 1 - stdev / mean) : 0;

    // Mean comparison: recent mean vs older mean.
    const recentMean = recent.reduce((s, v) => s + v, 0) / recent.length;
    const olderMean  = older.reduce((s, v) => s + v, 0) / older.length;
    const improvement = olderMean > 0 ? (recentMean - olderMean) / olderMean : 0;

    // Per-tick survival probability estimate (geometric)
    // E[N] = p/(1-p) => p = E[N]/(E[N]+1) where E[N] is the mean stay.
    const pSurvival = mean > 0 ? mean / (mean + 1) : 0;

    return {
      n, mean, median, stdev,
      recentMean, olderMean,
      slope, trendNorm, improvement,
      aboveMedian,
      consistency,
      pSurvival,
      max: Math.max(...arr),
      min: Math.min(...arr),
      // Composite SRAS score: high when trending up, above-median, consistent
      score: this._srasScore({ trendNorm, aboveMedian, consistency, improvement }),
    };
  }

  /** Composite SRAS score normalised to [0, 1]. */
  _srasScore({ trendNorm, aboveMedian, consistency, improvement }) {
    // 4 components, each normalised to [0,1] then averaged
    const trendScore    = Math.max(0, Math.min(1, 0.5 + trendNorm * 2));       // slope > 0 → rising
    const aboveMedScore = Math.max(0, Math.min(1, aboveMedian));                // 0..1 directly
    const consistScore  = Math.max(0, Math.min(1, consistency));               // 0..1 directly
    const improveScore  = Math.max(0, Math.min(1, 0.5 + improvement));         // recent > older
    return 0.30 * trendScore + 0.30 * aboveMedScore + 0.20 * consistScore + 0.20 * improveScore;
  }

  /**
   * Detect a "rising digits" streak in the ticks_stayed_in array.
   * Returns the length of the most recent strictly-increasing run.
   */
  risingDigitStreak(arr) {
    if (!Array.isArray(arr) || arr.length < 2) return 0;
    let streak = 1;
    for (let i = arr.length - 1; i > 0; i--) {
      if (arr[i] > arr[i - 1]) streak++;
      else break;
    }
    return streak;
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
    this._selling = new Set();     // contractIds currently being sold (prevents concurrent sell attempts)
  }

  async buy(symbol, growthRate, stake, limit, analysis = null) {
    // Defensive clamp — Deriv supports 0.01 – 0.05
    growthRate = Math.max(0.01, Math.min(0.05, +growthRate.toFixed(4)));
    try {
      // 1.  Proposal
      // ── Field-name compatibility for legacy + new APIs ──
      // The legacy v3 endpoint expects `symbol`, but the new PAT endpoint
      // (api.derivws.com) expects `underlying_symbol` — and rejects the
      // other field with InputValidationFailed.
      const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
      const pres = await this.client._send({
        proposal    : 1,
        amount      : stake,
        basis       : 'stake',
        contract_type: 'ACCU',
        currency    : this.cfg.currency,
        [symbolKey] : symbol,
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
      // ── Attach the analysis BEFORE emitting 'open' so listeners can see it ──
      // The bot passes `analysis` (VATP-CW-SRAS confluence data) so the
      // Telegram notification has full transparency data.
      if (analysis && typeof analysis === 'object') {
        info._analysis = analysis;
      }
      this.open.set(b.contract_id, info);
      logger.info(`barrier: ±${halfBarrierPct.toFixed(4)}% spot=${entrySpot.toFixed(2)} [${lowBarrier.toFixed(2)} … ${highBarrier.toFixed(2)}] maxPayout=${maxPayout}`);

      // 3a. Cache the ticks_stayed_in stats (SRAS) for later analysis.
      if (this.bot?.market?.cacheStays) {
        this.bot.market.cacheStays(symbol, growthRate, cd);
      }

      // 3b. Subscribe to live contract updates
      await this.client.subscribe(
        { proposal_open_contract: 1, contract_id: b.contract_id },
        msg => this._onUpdate(msg, info),
      );
      // Emit AFTER everything (including _analysis) is attached.
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
    if (status === 'open' && stopLossAbs > 0 && profit <= -stopLossAbs && !this._selling.has(cid)) {
      logger.warn(`contract #${cid} hit stop-loss @ profit=${profit.toFixed(2)} ≤ -${stopLossAbs} — selling`);
      this._selling.add(cid);
      try { await this.sell(cid, 0); } catch (e) {
        logger.error(`emergency sell #${cid} failed:`, e.message);
      } finally {
        this._selling.delete(cid);
      }
    }

    // ── Early-exit on directional drift (CWMRAS) ──
    // The barrier is FIXED at entry; if price has drifted strongly in one
    // direction, the contract is biased toward the opposite barrier.
    // We exit early to lock in remaining profit before a knockout.
    // The _selling Set prevents concurrent sell attempts — multiple POC
    // updates arriving in quick succession would otherwise spam sell()
    // and cause a flood of `BetExpired` / `TradingDurationNotAllowed`
    // errors after the first sell succeeds and ends the contract.
    if (status === 'open' && info.halfBarrierPct > 0 && info.entrySpot > 0
        && this.analyzer && !this._selling.has(cid)) {
      const ex = this.analyzer.shouldExitEarly(
        info.entrySpot, spot, info.halfBarrierPct,
        profit, info.limit?.take_profit ?? 0,
      );
      if (ex.exit) {
        logger.warn(`contract #${cid} EARLY EXIT (${ex.reason}) drift=${ex.driftPct.toFixed(4)}% remaining=${(ex.remainingFraction*100).toFixed(1)}% profit=${profit.toFixed(2)}`);
        this._selling.add(cid);
        try { await this.sell(cid, 0); } catch (e) {
          logger.error(`early-exit sell #${cid} failed:`, e.message);
        } finally {
          this._selling.delete(cid);
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
    // Inject bot reference so the executor can cache stays into the market
    this.exec.bot = this;
    // SRAS stay-stats refresh timer
    this._stayRefreshT = null;

    this.lastTradeAt   = 0;
    this.startBalance  = null;
    this.lastBalance   = null;
    this.stopped       = false;
    this._analysisT    = null;
    this._hourlyT      = null;
    this._eodT         = null;
    this._hourlyBoot   = null;
    this._eodBoot      = null;

    // ── Martingale state ──
    // lossesStreak counts consecutive losses; martingaleMultiplier is the
    // current stake multiplier (1.0 = no martingale). Updated in
    // _onTradeResult; consumed by currentStake() before each buy.
    this.lossesStreak = 0;
    this.martingaleMultiplier = 1.0;
    this._lastTradeWon = true;   // start in a "fresh" state
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

    // ── State persistence: restore previous session ──
    this._loadState();

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

    const martingaleLine = (this.cfg.martingale && this.cfg.martingale > 0)
      ? `♻️ <b>Martingale:</b> ×${this.cfg.martingale} (after ${this.cfg.lossesBeforeMartingale} losses, +${this.cfg.martingaleStep}/loss)\n`
      : '';
    telegram.send(
      `🤖 <b>Bot Online</b>\n\n` +
      `👤 <b>Account:</b> ${info.loginid}\n` +
      `💼 <b>Type:</b> ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 <b>Balance:</b> ${this.startBalance.toFixed(2)} ${this.currency()}\n` +
      `📊 <b>Assets:</b> ${this.cfg.assets.length}\n` +
      `💵 <b>Stake:</b> ${this.cfg.stake}\n` +
      `📈 <b>Multiplier (base):</b> ${(this.cfg.multiplier*100).toFixed(2)}%\n` +
      `🛑 <b>Stop Loss:</b> ${this.cfg.stopLoss}\n` +
      `🎯 <b>Take Profit:</b> ${this.cfg.takeProfit}\n` +
      `📏 <b>Growth range:</b> ${(this.cfg.minGrowth*100).toFixed(0)}%–${(this.cfg.maxGrowth*100).toFixed(0)}%\n` +
      `📈 <b>Min rising streak:</b> ${this.cfg.minRisingStreak}\n` +
      martingaleLine,
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
    // Martingale annotation in the trade message
    const mFactor = (t._analysis && t._analysis.martingaleMultiplier) || 1;
    const lossesStreak = (t._analysis && t._analysis.lossesStreak) || 0;
    const stakeNote = mFactor > 1
      ? `${t.stake.toFixed(2)} (base ${t._analysis.baseStake} × ${mFactor.toFixed(2)})`
      : `${t.stake.toFixed(2)}`;
    const martingaleNote = mFactor > 1
      ? `\n♻️ <b>Martingale:</b> ×${mFactor.toFixed(2)} (${lossesStreak} consecutive losses)` : '';
    let msg =
      `🟢 <b>TRADE OPENED</b>\n\n` +
      `🎫 <b>Contract:</b> #${t.contractId}\n` +
      `📊 <b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `📈 <b>Growth Rate:</b> ${(t.growthRate*100).toFixed(2)}%\n` +
      `💵 <b>Stake:</b> ${stakeNote} ${this.currency()}\n` +
      `💰 <b>Buy Price:</b> ${t.buyPrice.toFixed(2)}\n` +
      `🎁 <b>Max Payout:</b> ${t.payout.toFixed(2)}\n` +
      `🛑 <b>Stop Loss:</b> ${t.limit.stop_loss ?? '–'}\n` +
      `🎯 <b>Take Profit:</b> ${t.limit.take_profit ?? '–'}\n` + martingaleNote;
    if (cd.maximum_payout   !== undefined) msg += `⚠️ <b>Max Payout (cap):</b> ${cd.maximum_payout}\n`;
    if (cd.tick_size_barrier!== undefined) msg += `🚧 <b>Barrier size:</b> ${cd.tick_size_barrier}\n`;
    if (cd.maximum_ticks    !== undefined) msg += `⏱️ <b>Max Ticks:</b> ${cd.maximum_ticks}\n`;
    msg += `\n🕒 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`;
    telegram.send(msg);

    // Optionally notify a separate strategy-confluence summary (for transparency)
    if (t._analysis) {
      const a = t._analysis;
      const sm = `🧠 <b>VATP-CW-SRAS Confluence</b>\n\n` +
        `Composite score: <b>${a.score.toFixed(3)}</b> / ${this.cfg.minConfidence}\n` +
        `\n<b>── VATP ──</b>\n` +
        `• DPS (Hurst ${a.hurst.toFixed(2)} → ${a.dpsLabel}): <b>${a.dpsNorm.toFixed(2)}</b>\n` +
        `• VRF (${a.vrfLabel} vol-regime): <b>${a.vrfNorm.toFixed(2)}</b>\n` +
        `• MQI (smoothness): <b>${a.mqi.toFixed(2)}</b>\n` +
        `• Session score: <b>${a.session.toFixed(2)}</b>\n` +
        `\n<b>── CWMRAS ──</b>\n` +
        `• BB mid proximity: <b>${(a.bbMiddleProximity*100).toFixed(0)}%</b>\n` +
        `• RSI: <b>${a.rsi.toFixed(1)}</b>\n` +
        `\n<b>── SRAS (rising digits) ──</b>\n` +
        `• SRAS score: <b>${(a.srasScore ?? 0).toFixed(3)}</b> / ${this.cfg.srasMin}\n` +
        `• Rising-digit streak: <b>${a.srasRisingStreak ?? 0}</b> consecutive\n` +
        `• Mean stay (ticks): <b>${(a.srasMean ?? 0).toFixed(1)}</b>`;
      telegram.send(sm);
    }
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
    this._updateMartingale(t.status);
    this.lastTradeAt = Date.now();
    // Persist state so a crash/restart/network-drop preserves the
    // martingale streak and balance tracking across days.
    this._saveState('after-trade');
  }

  // ── Martingale helpers ─────────────────────────────────────────
  /**
   * Compute the stake to use on the next trade. Applies the current
   * martingale multiplier (1.0 if no martingale is active).
   * Returns the BASE stake when martingale is disabled
   * (martingale==0 OR lossesStreak <= threshold).
   */
  currentStake() {
    const base = this.cfg.stake;
    const m    = this.cfg.martingale || 0;
    if (m <= 0) return base;
    // Martingale is only active if losses exceed the threshold
    if (this.lossesStreak <= (this.cfg.lossesBeforeMartingale || 0)) return base;
    return +(base * this.martingaleMultiplier).toFixed(2);
  }

  /**
   * Update martingale state after a trade closes.
   * A win resets the multiplier to 1.0; each consecutive loss
   * increases the multiplier by `martingaleStep` (once the threshold
   * has been exceeded). The multiplier is HARD-CAPPED at
   * `cfg.maxMartingaleStep` so a long losing streak cannot blow up
   * the stake to absurd levels.
   */
  _updateMartingale(tradeResult) {
    if (!this.cfg.martingale || this.cfg.martingale <= 0) {
      // Martingale disabled — keep state pristine
      this.lossesStreak = 0;
      this.martingaleMultiplier = 1.0;
      this._lastTradeWon = tradeResult === 'won';
      return;
    }
    const threshold = this.cfg.lossesBeforeMartingale || 0;
    const cap = this.cfg.maxMartingaleStep || Infinity;
    if (tradeResult === 'won') {
      this.lossesStreak = 0;
      this.martingaleMultiplier = 1.0;
    } else {
      this.lossesStreak++;
      if (this.lossesStreak > threshold) {
        const stepNum = this.lossesStreak - threshold - 1;
        const raw = this.cfg.martingale + this.cfg.martingaleStep * stepNum;
        const capped = Math.min(raw, cap);
        if (capped !== this.martingaleMultiplier) {
          this.martingaleMultiplier = capped;
          const note = raw > cap ? ` (raw ×${raw.toFixed(2)} capped at ×${cap})` : '';
          logger.info(
            `martingale: ${this.lossesStreak} losses streak → ` +
            `stake × ${this.martingaleMultiplier.toFixed(2)}${note}`,
          );
        }
      }
    }
    this._lastTradeWon = tradeResult === 'won';
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

      logger.info(
        `best=${best.symbol} score=${best.score.toFixed(2)} | ` +
        `VATP[hurst=${best.hurst.toFixed(2)}(${best.dpsLabel}) ` +
        `vol=${best.vrfLabel} mqi=${best.mqi.toFixed(2)} sess=${best.session.toFixed(2)}] | ` +
        `CW[calm=${best.calmScore.toFixed(2)} rsi=${best.rsi.toFixed(1)} ` +
        `bbMid=${(best.bbMiddleProximity*100).toFixed(0)}% safeTicks=${(best.safeMoveRatio*100).toFixed(0)}%] ` +
        `[${best.reasons.join(',')}]`,
      );

      // ── Decision (VATP gates) ──
      // Hard gates: reject if any factor is outside the configured envelope.
      if (best.hurst > this.cfg.maxHurst) {
        logger.debug(`hurst too high (${best.hurst.toFixed(2)} > ${this.cfg.maxHurst}) — skipping`);
        return;
      }
      if (best.volRegime > this.cfg.maxVolRegime) {
        logger.debug(`vol regime too high (${best.vrfLabel} > ${this.cfg.maxVolRegime}) — skipping`);
        return;
      }
      if (best.score < this.cfg.minConfidence) {
        logger.debug(`score below MIN_CONFIDENCE (${best.score.toFixed(2)} < ${this.cfg.minConfidence}) — skipping`);
        return;
      }

      // ── SRAS: Stay-Regime gate ──
      // Exploit the user's observed "rising digits" pattern: if recent
      // ticks_stayed_in values trend UP, the per-tick survival probability
      // is rising — a stable regime. We use this as an additional gate
      // (and as a bonus confluence factor).
      const cachedStays = this.market.getStays(best.symbol, this.exec.currentGrowthRate ?? this.cfg.multiplier)
                        ?? this.market.getStays(best.symbol, this.cfg.multiplier);
      let srasScore = 0;
      let srasRisingStreak = 0;
      let srasMean = 0;
      if (cachedStays?.ticks_stayed_in) {
        const stays = this.analyzer.analyzeStays(cachedStays.ticks_stayed_in);
        if (stays) {
          srasScore = stays.score;
          srasRisingStreak = this.analyzer.risingDigitStreak(cachedStays.ticks_stayed_in);
          srasMean = stays.mean;
          // SRAS gate #1: composite score must meet minimum
          const srasMin = this.cfg.srasMin ?? 0.40;
          if (srasScore < srasMin) {
            logger.debug(`SRAS score too low (${srasScore.toFixed(2)} < ${srasMin}) — skipping`);
            return;
          }
          // SRAS gate #2: rising-digit streak must meet minimum (the
          // "rising digits" guard the user requested). The streak is the
          // length of the strictly-rising tail at the end of the recent
          // ticks_stayed_in history.
          const minStreak = this.cfg.minRisingStreak || 0;
          if (minStreak > 0 && srasRisingStreak < minStreak) {
            logger.debug(`SRAS rising streak too low (${srasRisingStreak} < ${minStreak}) — skipping`);
            return;
          }
          logger.debug(`SRAS ok: score=${srasScore.toFixed(2)} mean=${srasMean.toFixed(1)} rising-streak=${srasRisingStreak}/${minStreak} trend=${stays.trendNorm.toFixed(3)} above-med=${(stays.aboveMedian*100).toFixed(0)}%`);
        } else {
          // No stay data yet — soft pass (don't block; just lower confidence)
          logger.debug('SRAS: no cached stays yet — soft pass');
        }
      } else {
        // If we have NO stay data, fetch fresh proposals to populate the cache.
        // Throttled: every STAY_REFRESH_MS or on first run.
        if (!this._stayRefreshT) {
          this._refreshStays();
          this._stayRefreshT = setInterval(() => this._refreshStays(),
                                           this.cfg.stayRefreshMs ?? 60_000);
        }
        // Soft pass for now (first trades won't have stay data)
      }

      // ── Regime-aware sizing ──
      // Use the analyzer\'s suggestion (it picks the smallest growth_rate
      // whose barrier still covers ≥ 2σ of recent moves).
      const growthRate = best.suggestedGrowth
                       ?? this.exec.currentGrowthRate
                       ?? this.cfg.multiplier;

      // ── Growth-rate range gate (barrierByGrowth filter) ──
      // Only enter when the analyzer's suggested growth_rate falls inside
      // [MIN_GROWTH, MAX_GROWTH] (defaults 0.04..0.05). This effectively
      // requires the market to be calm enough to safely use the higher
      // rates — narrower barriers, faster compounding — and SKIPS trades
      // when conditions only permit the slower rates (0.01..0.03).
      if (growthRate < this.cfg.minGrowth || growthRate > this.cfg.maxGrowth) {
        logger.debug(
          `growth rate ${growthRate} outside [${this.cfg.minGrowth}, ${this.cfg.maxGrowth}] — ` +
          `skipping (regime not calm enough)`,
        );
        return;
      }

      const takeProfit = Math.max(best.recommendedTp, this.cfg.takeProfit || best.recommendedTp);
      const stopLoss   = this.cfg.stopLoss;

      // ── Martingale-aware stake ──
      // currentStake() returns base stake when martingale is inactive,
      // and base × martingaleMultiplier after the loss threshold.
      const stake = this.currentStake();

      // Build the analysis payload NOW and pass it into buy() so the
      // executor can attach it to `info` BEFORE emitting 'open'.
      const analysis = {
        score: best.score, hurst: best.hurst, dpsLabel: best.dpsLabel, dpsNorm: best.dpsNorm,
        vrfLabel: best.vrfLabel, vrfNorm: best.vrfNorm, volRegime: best.volRegime,
        mqi: best.mqi, session: best.session,
        bbMiddleProximity: best.bbMiddleProximity, rsi: best.rsi,
        // SRAS additions
        srasScore, srasRisingStreak, srasMean,
        // Martingale state for transparency in the Telegram message
        martingaleMultiplier: this.martingaleMultiplier,
        lossesStreak: this.lossesStreak,
        baseStake: this.cfg.stake,
      };
      const trade = await this.exec.buy(
        best.symbol,
        growthRate,
        stake,
        { stop_loss: stopLoss, take_profit: takeProfit },
        analysis,                                  // 5th arg: pre-built analysis
      );
      const martingaleNote = this.martingaleMultiplier > 1
        ? ` martingale × ${this.martingaleMultiplier.toFixed(2)} (${this.lossesStreak} losses)`
        : '';
      logger.info(
        `trade placed #${trade.contractId} ${best.symbol} growth=${growthRate} ` +
        `stake=${stake}${martingaleNote} tp=${takeProfit} barrier=±${trade.halfBarrierPct.toFixed(4)}%`,
      );
    } catch (e) {
      logger.error('analyse/trade error:', e.message);
    }
  }

  // ── Drift-warning handler (CWMRAS early-exit) ─────────────────
  _onDriftWarning(t) {
    if (!t?.exit) return;
    logger.debug(`drift warning #${t.contractId} ${t.exit.reason} urgency=${t.exit.urgency.toFixed(2)} drift=${t.exit.driftPct.toFixed(4)}%`);
  }

  // ── SRAS: refresh ticks_stayed_in for all assets ─────────────
  async _refreshStays() {
    try {
      if (!this.client.authorized) return;
      // Use the current growth rate (or default multiplier)
      const gr = this.exec.currentGrowthRate ?? this.cfg.multiplier;
      await this.market.refreshStays(this.cfg.assets, gr);
      logger.debug('SRAS: stay cache refreshed for all assets');
    } catch (e) {
      logger.debug('SRAS refresh error:', e.message);
    }
  }

  // ── State persistence (save/load) ──────────────────────────
  /**
   * Persist the trading state to a JSON file. We save:
   *   - loss streak / martingale multiplier (so we resume cleanly after
   *     network drops or restarts)
   *   - daily summaries (so previous days' reports survive restart)
   *   - start-of-day balance + last-known balance (so the daily P/L
   *     report is accurate even after a restart)
   *   - last shutdown timestamp (for diagnostics)
   *
   * Writes are atomic (write to .tmp then rename) so a crash mid-write
   * can't corrupt the file.
   */
  _saveState(reason = 'checkpoint') {
    if (!this.cfg.stateSaveOnTrade && reason === 'after-trade') return;
    if (!this.cfg.stateSaveOnShutdown && reason === 'shutdown') return;
    try {
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        savedReason: reason,
        lossesStreak:        this.lossesStreak        ?? 0,
        martingaleMultiplier: this.martingaleMultiplier ?? 1.0,
        startBalance:        this.startBalance,
        lastBalance:         this.lastBalance,
        lastDayISODate:      this._lastDayISODate || this._todayISO(),
        dailySummaries:      this.stats.dailySummaries || [],
        // Persist today's open trades too in case of mid-trade restart
        todayOpenTrades:     (this.stats.todayTrades() || []),
      };
      const file = this.cfg.stateFile;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, file);
      logger.debug(`state saved (${reason}) → ${file}`);
    } catch (e) {
      logger.warn('state save failed:', e.message);
    }
  }

  /**
   * Restore persisted state on startup. Silently no-op if the file
   * doesn't exist (fresh install) or is corrupt (logs a warning).
   */
  _loadState() {
    const file = this.cfg.stateFile;
    if (!fs.existsSync(file)) {
      logger.debug(`no state file at ${file} (fresh start)`);
      return;
    }
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      if (data.lossesStreak != null)        this.lossesStreak = data.lossesStreak;
      if (data.martingaleMultiplier != null) this.martingaleMultiplier = data.martingaleMultiplier;
      if (data.startBalance  != null) this.startBalance  = data.startBalance;
      if (data.lastBalance   != null) this.lastBalance   = data.lastBalance;
      if (data.lastDayISODate)            this._lastDayISODate = data.lastDayISODate;
      if (Array.isArray(data.dailySummaries)) this.stats.dailySummaries = data.dailySummaries;
      logger.info(
        `state restored from ${file} (saved ${data.savedAt}, reason: ${data.savedReason || '?'}): ` +
        `lossesStreak=${this.lossesStreak} mult=${this.martingaleMultiplier.toFixed(2)} ` +
        `dailySummaries=${this.stats.dailySummaries.length}`,
      );
    } catch (e) {
      logger.warn(`state load failed (${file}):`, e.message);
    }
  }

  _todayISO() { return new Date().toISOString().slice(0, 10); }

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
    // ── Archive yesterday into dailySummaries before reporting today ──
    // previousDaySummary() returns yesterday's trades (UTC date).
    const yesterday = this.stats.previousDaySummary();
    if (yesterday.trades.length) {
      this.stats.dailySummaries.push(yesterday);
    }
    // archiveOldDays keeps the in-memory list bounded.
    this.stats.archiveOldDays();

    // ── Build today's report ──
    const todayList = this.stats.todayTrades();
    const todayStats = this.stats.stats(todayList);
    const balStart   = this.startBalance ?? 0;
    const balNow     = this.lastBalance  ?? balStart;
    const balDelta   = balNow - balStart;
    const balPct     = balStart ? (balDelta / balStart) * 100 : 0;

    let msg = `🌙 <b>DAILY REPORT</b>\n` +
              `📅 Today: <b>${this._todayISO()}</b>\n\n`;

    if (todayList.length) {
      msg += `<b>── Today's trading ──</b>\n` +
             `📊 Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses})\n` +
             `📈 Win rate: ${todayStats.winRate.toFixed(1)}%\n` +
             `💵 Total stake: ${todayStats.stake.toFixed(2)} ${this.currency()}\n` +
             `💰 Gross win: +${todayStats.grossWin.toFixed(2)}\n` +
             `📉 Gross loss: -${todayStats.grossLoss.toFixed(2)}\n` +
             `💼 <b>Today's Net P/L: ${todayStats.totalProfit >= 0 ? '+' : ''}${todayStats.totalProfit.toFixed(2)} ${this.currency()}</b>\n` +
             `🏆 Profit factor: ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n`;
    } else {
      msg += `<b>── Today's trading ──</b>\n` +
             `No trades today.\n\n`;
    }

    // Balance summary (today's change)
    msg += `<b>── Balance ──</b>\n` +
           `💼 ${balStart.toFixed(2)} → ${balNow.toFixed(2)} ${this.currency()} ` +
           `(${balDelta >= 0 ? '+' : ''}${balDelta.toFixed(2)} / ${balPct >= 0 ? '+' : ''}${balPct.toFixed(2)}%)\n\n`;

    // ── Yesterday's summary (if any) ──
    if (yesterday.trades.length) {
      const ys = yesterday.stats;
      msg += `<b>── Yesterday (${yesterday.date}) ──</b>\n` +
             `📊 Trades: ${ys.count} (✅${ys.wins} ❌${ys.losses})\n` +
             `📈 Win rate: ${ys.winRate.toFixed(1)}%\n` +
             `💼 <b>Net P/L: ${ys.totalProfit >= 0 ? '+' : ''}${ys.totalProfit.toFixed(2)} ${this.currency()}</b>\n\n`;
    }

    // ── Last 7-day roll-up ──
    const recent = (this.stats.dailySummaries || []).slice(-7);
    if (recent.length > 0) {
      const totalPL = recent.reduce((s, d) => s + (d.stats?.totalProfit || 0), 0);
      const totalTrades = recent.reduce((s, d) => s + (d.stats?.count || 0), 0);
      const totalWins = recent.reduce((s, d) => s + (d.stats?.wins || 0), 0);
      msg += `<b>── Last ${recent.length} day(s) ──</b>\n` +
             `📊 Trades: ${totalTrades} (✅${totalWins} ❌${totalTrades - totalWins})\n` +
             `💼 <b>Net P/L: ${totalPL >= 0 ? '+' : ''}${totalPL.toFixed(2)} ${this.currency()}</b>\n\n`;
    }

    // ── Today's trade details ──
    if (todayList.length) {
      msg += `<b>📋 Today's trades (${todayList.length}):</b>\n`;
      todayList.forEach((t, i) => {
        const e = t.status === 'won' ? '✅' : '❌';
        const time = new Date(t.timestamp).toISOString().slice(11, 19);
        const mFactor = (t.martingaleMultiplier || 1).toFixed(2);
        const stakeNote = (t.martingaleMultiplier || 1) > 1 ? ` ×${mFactor}` : '';
        msg += `${i+1}. ${e} [${time}] #${t.contractId} ${t.symbol} @ ` +
               `${(t.growthRate*100).toFixed(1)}% | stake ${t.stake.toFixed(2)}${stakeNote} | ` +
               `${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)}\n`;
      });
    }

    telegram.send(msg);
    // Persist updated dailySummaries (we just appended yesterday)
    this._saveState('eod-archive');

    // Reset start-of-day balance for tomorrow's EOD math.
    this.startBalance = this.client.balance ?? this.lastBalance ?? this.startBalance;
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
    // Persist state on graceful shutdown so the next session resumes
    // from exactly where we left off.
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
