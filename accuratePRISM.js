#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  Deriv Digit Differ Trading Bot (single-file)
 * =====================================================================
 *
 *  Trades DIGITDIFF contracts only when a calibrated digit-probability
 *  model plus the live Deriv payout quote shows a positive value gap.
 *
 *  IMPORTANT:
 *    No trading strategy can guarantee consistent profit. Deriv synthetic
 *    ticks are designed to be random/fair after platform pricing margin.
 *    This bot therefore trades selectively and skips whenever the measured
 *    edge is not strong enough. Past performance does not imply future
 *    results. Use a DEMO account first.
 *
 *  Core method: PRISM-Δ
 *    Probability Recalibration via Imbalance & Serial Momentum for Differ.
 *
 *    A novel, principled edge detector for Digit Differ. For each symbol it:
 *
 *    1. Builds a Bayesian posterior over the 10 digits using Dirichlet(α0)
 *       shrinkage on multi-window counts — a proper posterior rather than
 *       an ad-hoc frequency/EWMA blend.
 *
 *    2. Detects the current MARKET REGIME on the price series using a
 *       variance-ratio test plus lag-1 and Δ-digit autocorrelation, then
 *       classifies the digit stream as NEUTRAL / TRENDING / MEAN-REVERTING.
 *       The regime modulates model weights and the confidence margin —
 *       trades are taken only when there is measurable non-random
 *       structure, and the model trusts the right evidence per regime.
 *
 *    3. Blends three evidence sources, regime-aware:
 *         - Dirichlet posterior (long-run imbalance),
 *         - k-step Markov transition from the current digit,
 *         - local momentum (very short EWMA).
 *
 *    4. Derives conservative Beta-posterior upper bounds (proper) for the
 *       per-digit expiry probability and selects the barrier digit with
 *       the lowest predicted expiry probability (best Differ candidate).
 *
 *    5. Pulls a live proposal and computes the break-even losing prob:
 *          q_be = 1 - ask_price / payout
 *       A trade is allowed only if:
 *          P(loss digit upper bound)  <  q_be - safety_margin(regime)
 *
 *    6. Requires cross-signal agreement (Dirichlet, Markov, momentum must
 *       co-rank the chosen digit among the least likely), ranks across
 *       assets by standardized edge, and only fires if the standardized
 *       edge clears a regime-aware threshold. Stake is scaled by the
 *       confidence in the edge (layered on top of the recovery table).
 *
 *  Features:
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
  apiToken : '0P94g4WdSrSrzir',
  appId    : '1089',//1089
  accountId: '', // recommended/required for PAT new API
  accountType: 'demo', // demo | real
  legacyWsUrl: 'wss://ws.derivws.com/websockets/v3',
  restBaseUrl: 'https://api.derivws.com',
  currency: 'USD',

  // Trade setup
  stake: numEnv('STAKE', 1.00),
  durationTicks: intEnv('DURATION_TICKS', 1), // Digit contracts normally 1-10 ticks
  minStake: numEnv('MIN_STAKE', 0.35),
  maxStake: numEnv('MAX_STAKE', 550.00),
  assets: listEnv('ASSETS', 'R_10,R_25,R_50,R_75,R_100'),

  // Trading frequency / limits
  tickWindow: intEnv('TICK_WINDOW', 1000),
  minTicksForAnalysis: intEnv('MIN_TICKS_ANALYSIS', 300),
  analysisIntervalMs: intEnv('ANALYSIS_INTERVAL_MS', 3000),
  tradeCooldownMs: intEnv('TRADE_COOLDOWN_MS', 2500),
  maxOpenTrades: intEnv('MAX_OPEN_TRADES', 1),
  dailyMaxLoss: numEnv('DAILY_MAX_LOSS', 550),
  dailyMaxProfit: numEnv('DAILY_MAX_PROFIT', 0), // 0 disables profit target stop
  dailyMaxTrades: intEnv('DAILY_MAX_TRADES', 20000),

  // PRISM-Δ model parameters
  // Dirichlet shrinkage prior strength (total pseudo-count spread over 10 digits).
  // Smaller α => posterior trusts the data more; larger α => pulls toward uniform 0.1.
  dirichletAlpha: numEnv('DIRICHLET_ALPHA', 0.5),
  // Multi-window count weights (windows in ticks). Longer windows dominate long-run view.
  frequencyWindows: listEnv('FREQUENCY_WINDOWS', '60,150,400,1000').map(x => parseInt(x, 10)).filter(Number.isFinite),
  // Markov transition lookback and step (step should match durationTicks in practice).
  transitionLookback: intEnv('TRANSITION_LOOKBACK', 900),
  transitionStep: intEnv('TRANSITION_STEP', 1),
  // Local momentum EWMA half-life in ticks.
  momentumHalfLife: numEnv('MOMENTUM_HALF_LIFE', 9),
  // Regime detection windows.
  vrWindowShort: intEnv('VR_WINDOW_SHORT', 16),
  vrWindowLong: intEnv('VR_WINDOW_LONG', 64),

  // PRISM-Δ edge / value filters
  zScore: numEnv('EDGE_ZSCORE', 1.15),               // Beta posterior upper-bound z
  baseSafetyMargin: numEnv('SAFETY_MARGIN', 0.0030), // base break-even margin (regime-scaled)
  minEdge: numEnv('MIN_EDGE', 0.0045),               // min raw value edge (probability points)
  minStandardizedEdge: numEnv('MIN_STD_EDGE', 0.30), // min cross-asset z edge
  maxLossProb: numEnv('MAX_LOSS_PROB', 0.092),       // never take if upper-bound loss digit > 9.2%
  minProbabilityGap: numEnv('MIN_PROBABILITY_GAP', 0.0050), // gap between best & 2nd best
  minEntropy: numEnv('MIN_ENTROPY', 0.985),          // require near-uniform long-run (sanity)
  // Statistical-significance gate on the chosen digit's deviation from 0.1.
  minDigitAbsZ: numEnv('MIN_DIGIT_ABS_Z', 1.4),
  // Cross-signal agreement: how many of {dirichlet, markov, momentum} must co-rank the
  // chosen digit in their respective bottom-K least-likely set.
  agreementK: intEnv('AGREEMENT_K', 2),
  agreementRequired: intEnv('AGREEMENT_REQUIRED', 2),
  proposalScanTopN: intEnv('PROPOSAL_SCAN_TOP_N', 3),
  // Confidence-scaled fractional staking (layered on recovery multiplier).
  confidenceStakeMin: numEnv('CONF_STAKE_MIN', 0.6),
  confidenceStakeMax: numEnv('CONF_STAKE_MAX', 1.0),

  // Optional limited loss recovery; disabled by default. Safer than 10x/100x martingale.
  recoveryEnabled: boolEnv('RECOVERY_ENABLED', true),
  recoveryMultipliers: listEnv('RECOVERY_MULTIPLIERS', '1,5.5,11.3,11.3').map(Number).filter(Number.isFinite),

  // GMT/UTC reporting
  eodTimeGmt: strEnv('TRADE_DAY_END_GMT', '00:00'), // default midnight GMT; report date is previous UTC day
  eodSendDelaySeconds: intEnv('EOD_SEND_DELAY_SECONDS', 10),
  hourlySummary: boolEnv('HOURLY_SUMMARY', true),

  // Persistence/logging
  stateFile: strEnv('STATE_FILE', 'deriv_prism_differ_state.json'),
  logFile: strEnv('LOG_FILE', 'deriv_rism_differ_bot.log'),
  logLevel: strEnv('LOG_LEVEL', 'INFO').toUpperCase(),

  // Telegram
  telegram: {
    enabled : true,
    botToken: '8106601008:AAEMyCma6mvPYIHEvw3RHQX2tkD5-wUe1o0',
    chatId  : '752497117',
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
// 7. PRISM-Δ DIGIT ANALYZER  (novel method)
//
//  Probability Recalibration via Imbalance & Serial Momentum for Differ.
//  Core ideas:
//    • Dirichlet(α0) Bayesian posterior over the 10 digits from a
//      variance-weighted blend of multi-window counts.
//    • Market-regime detection (variance-ratio on price + digit ACF) that
//      decides how much to trust the Markov / momentum evidence and sets a
//      regime-dependent safety margin.
//    • Regime-aware blend of posterior × k-step Markov × local momentum.
//    • Proper Beta-posterior upper confidence bound per digit.
//    • Cross-signal agreement test + statistical-significance gate.
// ─────────────────────────────────────────────────────────────────────
class DigitAnalyzer {
  constructor(cfg) { this.cfg = cfg; }

  // ---- small statistical helpers ---------------------------------
  _lnGamma(x) {
    // Lanczos approximation (good enough for our z/α values).
    const g = 7;
    const c = [
      0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - this._lnGamma(1 - x);
    x -= 1;
    let a = c[0];
    const t = x + g + 0.5;
    for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  _lnBeta(a, b) { return this._lnGamma(a) + this._lnGamma(b) - this._lnGamma(a + b); }

  // Inverse of the standard normal CDF (Acklam's approximation).
  _invNorm(p) {
    const a = [-3.969683028665376e+1, 2.209460984245205e+2, -2.759285104469687e+2,
               1.383577518672690e+2, -3.066479806614716e+1, 2.506628277459239e+0];
    const b = [-5.447609879822406e+1, 1.615858368580409e+2, -1.556989798598866e+2,
               6.680131188771972e+1, -1.328068155288572e+1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e+0,
               -2.549732539343734e+0, 4.374664141464968e+0, 2.938163982698783e+0];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e+0,
               3.754408661907416e+0];
    const plow = 0.02425, phigh = 1 - plow;
    let q, r;
    if (p < plow) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
             ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= phigh) {
      q = p - 0.5; r = q * q;
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
             (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
              ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
  }

  // Beta(a, b) CDF at x via regularized incomplete beta (continued fraction).
  _betaCdf(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lbeta = this._lnBeta(a, b);
    const bt = Math.exp(this._lnGamma(a + b) - this._lnGamma(a) - this._lnGamma(b) +
                        a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) {
      return bt * this._betacf(x, a, b) / a;
    }
    return 1 - bt * this._betacf(1 - x, b, a) / b;
  }
  _betacf(x, a, b) {
    const fpmin = 1e-30;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < fpmin) d = fpmin;
    d = 1 / d; let h = d;
    for (let m = 1; m <= 200; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < fpmin) d = fpmin;
      c = 1 + aa / c; if (Math.abs(c) < fpmin) c = fpmin;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < fpmin) d = fpmin;
      c = 1 + aa / c; if (Math.abs(c) < fpmin) c = fpmin;
      d = 1 / d; const del = d * c; h *= del;
      if (Math.abs(del - 1) < 3e-7) break;
    }
    return h;
  }

  // Upper-bound for a Bernoulli proportion given count c of n (z-sigma), via
  // the joint Beta posterior of a multinomial cell = Beta(c+α, n−c+(K−1)α).
  betaUpper(c, n, z) {
    const K = 10;
    const a0 = this.cfg.dirichletAlpha / K;
    const a = c + a0;
    const b = (n - c) + (K - 1) * a0;
    // MAP-based shortcut that stays conservative but is monotone & cheap:
    const mean = a / (a + b);
    const sd = Math.sqrt((a * b) / ((a + b) * (a + b) * (a + b + 1)));
    const approx = mean + z * sd;
    // If the cheap approximation is far in the tail, use the exact Beta CDF
    // to keep the bound correct (rare path; bounded iterations).
    if (approx <= 0.0 || approx >= 0.6) {
      const p = 0.5 + 0.5 * this._erf(z / Math.SQRT2);
      return this._betaInv(p, a, b);
    }
    return Math.max(0, Math.min(1, approx));
  }
  // Inverse Beta CDF via bisection on _betaCdf (robust; rarely taken).
  _betaInv(targetP, a, b) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      const v = this._betaCdf(mid, a, b);
      if (v < targetP) lo = mid; else hi = mid;
      if (hi - lo < 1e-5) break;
    }
    return 0.5 * (lo + hi);
  }
  _erf(x) {
    // Abramowitz & Stegun 7.1.26
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  }

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

  // Dirichlet posterior mean from variance-weighted multi-window counts.
  // Returns {probs[10], effectiveN} where probs is the posterior mean.
  dirichletPosterior(digits) {
    const K = 10;
    const a0 = this.cfg.dirichletAlpha / K;          // per-cell pseudo-count
    const windows = this.cfg.frequencyWindows.length ? this.cfg.frequencyWindows : [60, 150, 400, 1000];
    const acc = Array(K).fill(0);
    let weightSum = 0;
    let effN = 0;
    for (const w of windows) {
      const usable = Math.min(w, digits.length);
      if (usable < Math.max(30, Math.floor(w * 0.5))) continue;
      const { counts, n } = this.countsFor(digits, w);
      // Weight longer windows more, but down-weight if thinly populated.
      const weight = Math.sqrt(usable) * Math.min(1, n / w);
      weightSum += weight;
      effN += n;
      for (let d = 0; d < K; d++) acc[d] += weight * counts[d] / n;
    }
    if (!weightSum) {
      return { probs: Array(K).fill(0.1), effectiveN: 0 };
    }
    // Normalize weighted frequencies into pseudo-counts (scaled so total n* reflects
    // confidence), then apply Dirichlet prior.
    const freq = acc.map(x => x / weightSum);          // long-run frequency estimate
    // Map to pseudo-counts: use a moderate effective count so prior still matters.
    const pseudoN = Math.min(effN, Math.max(...windows));
    const counts = freq.map(f => f * pseudoN);
    const total = counts.reduce((s, c) => s + c, 0) || 1;
    const probs = counts.map((c, d) => (c + a0) / (total + this.cfg.dirichletAlpha));
    return { probs, effectiveN: Math.round(pseudoN), counts, freq };
  }

  // k-step Markov transition probabilities from the current digit.
  markovProbabilities(digits, step) {
    const k = Math.max(1, Math.min(10, step | 0));
    const look = Math.min(this.cfg.transitionLookback, digits.length - k - 1);
    const currentDigit = digits[digits.length - 1];
    if (look < 50 || currentDigit == null) {
      return { probs: Array(10).fill(0.1), n: 0, currentDigit };
    }
    const counts = Array(10).fill(0);          // Laplace smoothing handled at caller
    let n = 0;
    const start = Math.max(0, digits.length - k - look);
    for (let i = start; i + k < digits.length; i++) {
      if (digits[i] === currentDigit) {
        counts[digits[i + k]] += 1;
        n += 1;
      }
    }
    if (!n) return { probs: Array(10).fill(0.1), n: 0, currentDigit };
    return { probs: counts.map(c => c / n), n, currentDigit };
  }

  // Local momentum: EWMA of digit occurrences with given half-life.
  momentumProbabilities(digits, halfLife) {
    const hl = Math.max(2, halfLife);
    const alpha = 1 - Math.exp(-Math.LN2 / hl);   // decay to match half-life
    const p = Array(10).fill(0.1);
    for (let i = 0; i < 10; i++) p[i] = 0.1 * (1 - alpha);
    p[digits[digits.length - 1]] += alpha;        // init with last observed bias
    for (const d of digits.slice(-Math.min(digits.length, hl * 8))) {
      for (let i = 0; i < 10; i++) p[i] *= (1 - alpha);
      p[d] += alpha;
    }
    const sum = p.reduce((s, x) => s + x, 0) || 1;
    return p.map(x => x / sum);
  }

  // ----- Regime detection -----------------------------------------
  // Variance-ratio statistic on price returns + digit autocorrelations.
  // Returns { regime, vrStat, acf1, dAcf1, structure, confidence }
  detectRegime(ticks) {
    const n = ticks.length;
    const L = this.cfg.vrWindowLong;
    const S = this.cfg.vrWindowShort;
    const prices = ticks.slice(-Math.min(n, L * 4)).map(t => t.quote);
    const m = prices.length;
    // Variance ratio VR(q) = Var(q-period returns) / (q * Var(1-period)).
    let vrStat = 1;
    if (m > S + 4) {
      const rets1 = [];
      for (let i = 1; i < m; i++) rets1.push(Math.log(prices[i] / prices[i - 1] || 1));
      const var1 = this._variance(rets1);
      const q = Math.max(2, Math.min(S, 8));
      const retsQ = [];
      for (let i = q; i < rets1.length; i++) retsQ.push(rets1[i] - rets1[i - q]);
      const varQ = this._variance(retsQ);
      vrStat = var1 > 0 ? (varQ / var1) / q : 1;
    }
    // Digit autocorrelations on the digit stream.
    const digits = ticks.map(t => t.digit);
    const acf1 = this._acf(digits, 1);
    const ddigits = digits.map((d, i) => (i === 0 ? 0 : (d - digits[i - 1] + 10) % 10));
    const dAcf1 = this._acf(ddigits, 1);

    // Classify. VR<1 with +acf ⇒ mean-reverting; VR>1 ⇒ trending; else neutral.
    let regime = 'neutral';
    let structure = 0;
    if (vrStat < 0.82) { regime = 'mean-reverting'; structure = Math.min(1, (1 - vrStat) * 2.2); }
    else if (vrStat > 1.18) { regime = 'trending'; structure = Math.min(1, (vrStat - 1) * 1.6); }
    structure = Math.max(structure, Math.min(1, Math.abs(acf1) * 6 + Math.abs(dAcf1) * 5));
    const confidence = Math.max(0, Math.min(1, structure));
    return { regime, vrStat, acf1, dAcf1, structure, confidence };
  }
  _variance(arr) {
    const n = arr.length;
    if (!n) return 0;
    const mean = arr.reduce((s, x) => s + x, 0) / n;
    return arr.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  }
  _acf(arr, lag) {
    const n = arr.length - lag;
    if (n < 20) return 0;
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    let cov0 = 0, covL = 0;
    for (let i = 0; i + lag < arr.length; i++) {
      cov0 += (arr[i] - mean) ** 2;
      covL += (arr[i] - mean) * (arr[i + lag] - mean);
    }
    return cov0 > 0 ? covL / cov0 : 0;
  }

  // Regime-dependent blend weights {posterior, markov, momentum} and margin.
  _regimeWeights(regime, markovN) {
    // How much to trust Markov evidence: needs same-current-digit samples.
    const mStrength = Math.max(0, Math.min(1, (markovN - 25) / 150));
    switch (regime) {
      case 'trending':
        // Momentum and Markov dominate when price/structure is directional.
        return { posterior: 0.45, markov: 0.20 + 0.25 * mStrength, momentum: 0.35 - 0.20 * mStrength };
      case 'mean-reverting':
        // Long-run posterior is most informative; some Markov persistence.
        return { posterior: 0.65, markov: 0.20 + 0.15 * mStrength, momentum: 0.15 - 0.10 * mStrength };
      case 'neutral':
      default:
        return { posterior: 0.60, markov: 0.20 + 0.15 * mStrength, momentum: 0.20 - 0.10 * mStrength };
    }
  }
  _regimeMarginScale(regime) {
    // Larger safety margin when structure is weak/noisy.
    switch (regime) {
      case 'trending':      return 1.15;
      case 'mean-reverting':return 0.85;
      case 'neutral':
      default:              return 1.0;
    }
  }

  // ----- Main per-symbol analysis ---------------------------------
  analyze(symbol, ticks) {
    const cfg = this.cfg;
    if (!ticks || ticks.length < cfg.minTicksForAnalysis) return null;
    const digits = ticks.map(t => t.digit).filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
    if (digits.length < cfg.minTicksForAnalysis) return null;

    const window = Math.min(cfg.tickWindow, digits.length);
    const recentDigits = digits.slice(-window);
    const lastDigit = recentDigits[recentDigits.length - 1];

    const { counts, n } = this.countsFor(recentDigits, window);
    const entropy = this.entropy(counts);
    const chiSquare = this.chiSquare(counts);

    const post = this.dirichletPosterior(recentDigits);
    const markov = this.markovProbabilities(recentDigits, cfg.transitionStep || cfg.durationTicks);
    const momentum = this.momentumProbabilities(recentDigits, cfg.momentumHalfLife);
    const regime = this.detectRegime(ticks);

    const w = this._regimeWeights(regime.regime, markov.n);

    // Normalize weights to sum to 1 (in case mStrength collapsed a term).
    const wsum = w.posterior + w.markov + w.momentum || 1;
    const wPost = w.posterior / wsum;
    const wMark = w.markov / wsum;
    const wMom  = w.momentum / wsum;

    // Per-digit rankings from each evidence source (rank 0 = least likely).
    const rankOf = arr => {
      const order = arr.map((v, d) => ({ v, d })).sort((a, b) => a.v - b.v);
      const r = Array(10).fill(0);
      order.forEach((o, i) => { r[o.d] = i; });
      return r;
    };
    const rankPost = rankOf(post.probs);
    const rankMark = rankOf(markov.probs);
    const rankMom  = rankOf(momentum);

    const candidates = [];
    const K = cfg.agreementK; // bottom-K "least likely" set per source
    for (let d = 0; d < 10; d++) {
      const blended = wPost * post.probs[d] + wMark * markov.probs[d] + wMom * momentum[d];

      // Effective sample for the upper bound: blend long-run effectiveN and Markov n.
      const nEff = Math.max(40, Math.min(post.effectiveN, Math.max(post.effectiveN, markov.n || post.effectiveN)));

      // Use Beta posterior bound on the *blended* probability using effective count.
      // We map blended probability to a pseudo-count over nEff cells.
      const pseudoCount = blended * nEff;
      const upper = this.betaUpper(pseudoCount, nEff, cfg.zScore);

      // Statistical significance of this digit's deviation from 0.1 (long-run).
      const freqP = post.freq[d];
      const seFreq = Math.sqrt(0.1 * 0.9 / Math.max(1, post.effectiveN));
      const digitZ = seFreq > 0 ? (freqP - 0.1) / seFreq : 0;

      const agreementVotes =
        (rankPost[d] < K ? 1 : 0) +
        (rankMark[d] < K ? 1 : 0) +
        (rankMom[d]  < K ? 1 : 0);

      candidates.push({
        symbol,
        digit: d,
        pLoss: blended,
        pLossUpper: upper,
        posteriorP: post.probs[d],
        markovP: markov.probs[d],
        momentumP: momentum[d],
        freqP,
        digitZ,
        agreementVotes,
        transitionN: markov.n,
        currentDigit: markov.currentDigit,
      });
    }

    // Rank candidates: prefer low upper bound, then agreement votes, then low blended prob.
    candidates.sort((a, b) =>
      a.pLossUpper - b.pLossUpper ||
      b.agreementVotes - a.agreementVotes ||
      a.pLoss - b.pLoss);

    const best = candidates[0];
    const second = candidates[1];
    const probabilityGap = second ? (second.pLossUpper - best.pLossUpper) : 0;

    // ----- gates --------------------------------------------------
    const gates = [];
    // Long-run digit distribution should be near uniform (sanity / fairness check).
    if (entropy < cfg.minEntropy) gates.push(`entropy-low:${entropy.toFixed(3)}`);
    // Need measurable imbalance on the chosen digit specifically.
    if (Math.abs(best.digitZ) < cfg.minDigitAbsZ) gates.push(`digitZ-weak:${best.digitZ.toFixed(2)}`);
    // Cross-signal agreement on the chosen digit.
    if (best.agreementVotes < cfg.agreementRequired) gates.push(`no-agreement:${best.agreementVotes}`);
    // Separation from the 2nd-best candidate.
    if (probabilityGap < cfg.minProbabilityGap) gates.push(`gap-low:${probabilityGap.toFixed(4)}`);
    // Absolute conservatism: never trade if the loss digit isn't predicted safely below ~9%.
    if (best.pLossUpper > cfg.maxLossProb) gates.push(`loss-prob-high:${best.pLossUpper.toFixed(4)}`);
    // Regime must show *some* structure; pure noise → skip.
    if (regime.confidence <= 0.02) gates.push(`no-structure:${regime.confidence.toFixed(3)}`);

    // Confidence / score used for staking and cross-asset ranking.
    // Edge (pp) below the platform break-even point is the core signal.
    const score = Math.max(0, Math.min(1,
      0.45 * Math.max(0, (0.095 - best.pLossUpper) / 0.03) +
      0.25 * Math.max(0, Math.min(1, probabilityGap / 0.02)) +
      0.20 * Math.max(0, Math.min(1, Math.abs(best.digitZ) / 3)) +
      0.10 * Math.max(0, Math.min(1, regime.confidence))
    ));

    return {
      symbol,
      ticks: recentDigits.length,
      lastDigit,
      lastQuote: ticks[ticks.length - 1]?.quote,
      entropy,
      chiSquare,
      probabilityGap,
      score,
      candidates,
      best,
      gates,
      allowedByModel: gates.length === 0,
      weights: { posterior: wPost, markov: wMark, momentum: wMom },
      regime,
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
// 10. TRADING BOT ORCHESTRATOR  (PRISM-Δ decision core)
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
    logger.info('===== Deriv PRISM Differ Bot starting =====');
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
      `🤖 <b>PRISM-Δ Differ Bot Online</b>\n\n` +
      `👤 Account: <code>${htmlEscape(info.loginid || '?')}</code>\n` +
      `💼 Type: ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 Balance: ${(this.client.balance ?? 0).toFixed(2)} ${this.currency()}\n` +
      `📊 Assets: ${this.cfg.assets.join(', ')}\n` +
      `🎯 Contract: <b>DIGITDIFF</b>, duration <b>${this.cfg.durationTicks} tick(s)</b>\n` +
      `💵 Stake: ${this.cfg.stake.toFixed(2)} ${this.currency()}\n` +
      `🧠 Method: <b>PRISM-Δ</b> (regime-aware Bayesian value edge)\n` +
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

  // PRISM-Δ staking: recovery multiplier × confidence-scaled fraction.
  currentStake(confidence = 0.5) {
    let mult = 1;
    if (this.cfg.recoveryEnabled) {
      const idx = Math.min(this.stats.currentLossStreak, this.cfg.recoveryMultipliers.length - 1);
      mult = this.cfg.recoveryMultipliers[idx] || 1;
    }
    const c = Math.max(0, Math.min(1, confidence));
    const cf = this.cfg.confidenceStakeMin + c * (this.cfg.confidenceStakeMax - this.cfg.confidenceStakeMin);
    return Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, +(this.cfg.stake * mult * cf).toFixed(2)));
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

    const topLog = ranked.slice(0, 3).map(a =>
      `${a.symbol}:d${a.best.digit} u=${a.best.pLossUpper.toFixed(4)} z=${a.best.digitZ.toFixed(1)} vote=${a.best.agreementVotes} ${a.regime.regime} ${a.gates.length ? 'skip(' + a.gates[0] + ')' : 'ok'}`
    ).join(' | ');
    logger.info(`PRISM-Δ scan ${topLog}`);

    // ---- build value-ranked proposal candidates ------------------
    const baseStake = this.cfg.stake; // use base stake for proposals (stake scale applied at buy)
    const proposalCandidates = [];

    for (const a of ranked.slice(0, Math.max(1, this.cfg.proposalScanTopN))) {
      if (!a.allowedByModel) continue;
      const candidateDigits = a.candidates.slice(0, Math.max(1, Math.min(3, this.cfg.proposalScanTopN)));
      for (const c of candidateDigits) {
        if (c.agreementVotes < this.cfg.agreementRequired) continue;
        if (c.pLossUpper > this.cfg.maxLossProb) continue;
        try {
          const pres = await this.exec.proposal(a.symbol, c.digit, baseStake);
          const p = pres.proposal;
          if (!p?.id) continue;
          const ask = Number(p.ask_price || baseStake);
          const payout = Number(p.payout || 0);
          if (!(payout > ask)) continue;
          const breakEvenLossProb = 1 - ask / payout;
          // Regime-aware safety margin.
          const margin = this.cfg.baseSafetyMargin * this.analyzer._regimeMarginScale(a.regime.regime);
          const valueEdge = breakEvenLossProb - c.pLossUpper - margin;
          proposalCandidates.push({
            analysis: a,
            candidate: c,
            proposal: p,
            ask,
            payout,
            breakEvenLossProb,
            valueEdge,
            margin,
          });
        } catch (e) {
          logger.debug(`proposal ${a.symbol} d${c.digit}:`, e.message);
        }
      }
    }

    if (!proposalCandidates.length) {
      logger.debug('no proposal candidates after model gates');
      return;
    }

    // Cross-asset standardization of the raw value edge (z-score across candidates).
    const edges = proposalCandidates.map(x => x.valueEdge);
    const mu = edges.reduce((s, x) => s + x, 0) / edges.length;
    const sd = Math.sqrt(edges.reduce((s, x) => s + (x - mu) ** 2, 0) / edges.length) || 1e-9;
    for (const x of proposalCandidates) x.stdEdge = sd > 0 ? (x.valueEdge - mu) / sd : 0;

    proposalCandidates.sort((a, b) => b.valueEdge - a.valueEdge || b.stdEdge - a.stdEdge);
    const best = proposalCandidates[0];

    if (best.valueEdge < this.cfg.minEdge) {
      logger.info(`skip: edge ${best.valueEdge.toFixed(4)} < minEdge ${this.cfg.minEdge} (${best.analysis.symbol} d${best.candidate.digit})`);
      return;
    }
    if (best.stdEdge < this.cfg.minStandardizedEdge) {
      logger.info(`skip: stdEdge ${best.stdEdge.toFixed(2)} < ${this.cfg.minStandardizedEdge} (${best.analysis.symbol} d${best.candidate.digit})`);
      return;
    }

    const a = best.analysis;
    const c = best.candidate;

    // Confidence in [0,1] used for fractional staking.
    const confidence = Math.max(0, Math.min(1,
      0.5 * Math.max(0, (0.095 - c.pLossUpper) / 0.025) +
      0.3  * Math.max(0, Math.min(1, best.valueEdge / 0.02)) +
      0.2  * a.regime.confidence
    ));
    const stake = this.currentStake(confidence);

    const payload = {
      method: 'PRISM-Δ',
      regime: a.regime.regime,
      digit: c.digit,
      pLoss: c.pLoss,
      pLossUpper: c.pLossUpper,
      posteriorP: c.posteriorP,
      markovP: c.markovP,
      momentumP: c.momentumP,
      digitZ: c.digitZ,
      agreementVotes: c.agreementVotes,
      breakEvenLossProb: best.breakEvenLossProb,
      valueEdge: best.valueEdge,
      stdEdge: best.stdEdge,
      margin: best.margin,
      entropy: a.entropy,
      chiSquare: a.chiSquare,
      probabilityGap: a.probabilityGap,
      lastDigit: a.lastDigit,
      confidence,
      score: a.score,
      weights: a.weights,
      regimeConfidence: a.regime.confidence,
      vrStat: a.regime.vrStat,
      stakeScale: +(stake / this.cfg.stake).toFixed(2),
      recoveryStakeMultiplier: +(stake / (this.cfg.stake * (this.cfg.recoveryEnabled ? (this.cfg.recoveryMultipliers[Math.min(this.stats.currentLossStreak, this.cfg.recoveryMultipliers.length - 1)] || 1) : 1))).toFixed(2),
      currentLossStreak: this.stats.currentLossStreak,
    };

    const trade = await this.exec.buy(a.symbol, c.digit, stake, payload);
    this.lastTradeAt = Date.now();
    logger.info(`trade placed #${trade.contractId} ${a.symbol} DIGITDIFF differs ${c.digit} edge=${best.valueEdge.toFixed(4)} stdEdge=${best.stdEdge.toFixed(2)} pLossU=${c.pLossUpper.toFixed(4)} qBE=${best.breakEvenLossProb.toFixed(4)} regime=${a.regime.regime} stake=${stake}`);
  }

  _onTradeOpen(t) {
    const a = t.analysis || {};
    telegram.send(
      `🟢 <b>TRADE OPENED — PRISM-Δ DIFFER</b>\n\n` +
      `🎫 Contract: <code>#${t.contractId}</code>\n` +
      `📊 Symbol: <code>${t.symbol}</code>\n` +
      `🔢 Prediction/barrier: final digit <b>DIFFERS from ${t.digit}</b>\n` +
      `⏱️ Duration: ${t.durationTicks} tick(s)\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currency()}\n` +
      `🎁 Payout: ${t.payout.toFixed(2)} ${this.currency()}\n\n` +
      `🧠 <b>PRISM-Δ edge</b>\n` +
      `• Regime: <b>${htmlEscape(a.regime || '?')}</b> (conf ${(Number(a.regimeConfidence || 0) * 100).toFixed(0)}%)\n` +
      `• Blended P(loss digit ${t.digit}): ${(a.pLoss * 100).toFixed(2)}%\n` +
      `• Conservative upper bound: <b>${(a.pLossUpper * 100).toFixed(2)}%</b>\n` +
      `• Sources — post ${(Number(a.posteriorP||0)*100).toFixed(1)}% | markov ${(Number(a.markovP||0)*100).toFixed(1)}% | mom ${(Number(a.momentumP||0)*100).toFixed(1)}%\n` +
      `• digit z=${Number(a.digitZ||0).toFixed(2)} | agreement ${a.agreementVotes}/3 | gap ${Number(a.probabilityGap||0).toFixed(4)}\n` +
      `• Break-even loss prob: ${(a.breakEvenLossProb * 100).toFixed(2)}%\n` +
      `• Value edge: <b>${(a.valueEdge * 100).toFixed(2)}pp</b> (std ${Number(a.stdEdge||0).toFixed(2)})\n` +
      `• Stake scale: ×${Number(a.stakeScale||1).toFixed(2)} (conf ${(Number(a.confidence||0)*100).toFixed(0)}%)\n` +
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
      `${emoji} <b>TRADE ${label} — PRISM-Δ DIFFER</b>\n\n` +
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
      telegram.send(`⏰ <b>PRISM-Δ Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\nNo trades this hour.\n\n💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}`);
      return;
    }
    let msg = `⏰ <b>PRISM-Δ Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\n` +
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

    let msg = `🌙 <b>PRISM-Δ END OF TRADE DAY — GMT</b>\n` +
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

    msg += `<b>PRISM-Δ ── Overall / Stored Stats ──</b>\n` +
           `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
           `❌ Consecutive losses: current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
           `   x2=${this.stats.lossStreakEvents.x2}  x3=${this.stats.lossStreakEvents.x3}  x4=${this.stats.lossStreakEvents.x4}\n\n`;

    const rows = this.stats.allDailyRows(date);
    if (rows.length) {
      msg += `<b>PRISM-Δ ── All Trade Days By Date ──</b>\n`;
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
      method: 'PRISM-Δ',
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
    telegram.send(`🛑 <b>PRISM-Δ Differ Bot stopped</b>\nSignal: ${htmlEscape(signal)}\n💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}`);
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
  console.log('║   Deriv PRISM-Δ Differ Trading Bot v2.0             ║');
  console.log('║   DIGITDIFF • PRISM-Δ • GMT EOD • Stateful Stats  ║');
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
