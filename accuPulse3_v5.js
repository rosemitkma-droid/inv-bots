#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  AccuPULSE3 v5.0 — Enhanced Production Build
 *  File: C:\Users\kenot\Desktop\Investment AccumulatorBot\accuPULSE3_v5.js
 * =====================================================================
 *
 *  ✅ All v4.0 fixes applied
 *  ✅ Feature 1: Adaptive Confidence Gates (by vol regime)
 *  ✅ Feature 2: 6-Factor Dynamic Stake Sizing
 *  ✅ Feature 3: 6-Check Entry Confirmation
 *  ✅ Feature 4: 4-Tier Exit Strategy
 *  ✅ Feature 5: Warm-up Mode Lifecycle
 *  ✅ Feature 6: Enhanced Streak Recovery
 *  ✅ Feature 7: Full Metrics Logging
 */

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const EventEmitter = require('events');

// ── Configuration ──────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  apiToken: 'pat_27a3197287bae3ec6c2c9cbdd68fffaa2a524e3b0a6e1ecf298b5ffb338adb10',
  appId: '33uslPtthXBEkQOdfKfoY',
  wsUrl: 'wss://ws.derivws.com/websockets/v3',
  currency: 'USD',
  accountType: 'demo',

  // Trade parameters
  baseStake: parseFloat('1.0'),
  growthRate: parseFloat('0.05'),
  stopLoss: parseFloat('500.0'),
  demoOnly: false,
  tradeEnabled: true,
  skipRecentTradedSymbols: false,
  recentTradedSymbolsLen: parseInt('1', 10),

  // Anti-Martingale
  winsBeforeScaling: parseInt('500'),
  winStakeMultiplier: parseFloat('1.2'),
  maxWinStakeMultiplier: parseFloat('4.0'),

  // Assets
  // assets: ('R_10,R_25,R_50,R_75,R_100').split(',').map(s => s.trim()).filter(Boolean),
  assets: ('R_10,R_25,R_50,R_75,R_100,BOOM500,BOOM600,BOOM900,BOOM1000,CRASH500,CRASH600,CRASH900,CRASH1000')
    .split(',').map(s => s.trim()).filter(Boolean),

  // Telegram
  telegram: {
    enabled: true,
    botToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    chatId: '752497117',
  },

  // Timing & Throttling (v4.0 fixes)
  tickWindow: parseInt('500', 10),
  minTicksForAnalysis: parseInt('200', 10),
  analysisIntervalMs: parseInt('3000', 10),
  tradeCooldownMs: parseInt('500', 10),
  maxOpenTrades: parseInt('3', 10),

  // Hazard Model (v4.0 fixes)
  candidateGrowthRates: [0.05], //[0.05, 0.04, 0.03, 0.02, 0.01]
  hazardWindow: parseInt('600', 10),
  plannedHoldTicks: parseInt('20', 10),
  minBarrierPct: parseFloat('0.015'),
  minEmpiricalSamples: parseInt('150', 10),
  confidenceZ: parseFloat('1.28'),
  evHaircut: parseFloat('0.65'),
  minNetEvRatio: parseFloat('0.001'),
  maxRecentJumpZ: parseFloat('4.0'),

  // ── Feature 1: Adaptive Confidence Gates (by vol regime) ──────────────
  minConfidenceByRegime: {
    0: 0.08,  // low vol: stricter (good conditions, be selective)
    1: 0.05,  // normal vol: balanced
    2: 0.03,  // high vol: looser (risky anyway, take more)
    3: 0.01,  // extreme: only obvious setups
  },

  // ARCA gates (v4.0 relaxations + v5.0 adaptive)
  minConfidence: parseFloat('0.05'),   // fallback if regime lookup fails
  maxVolRegime: parseInt('3', 10),     // ALLOW all regimes (scale stake instead)
  maxHurst: parseFloat('0.70'),
  minSurvivalSlope: parseFloat('-0.01'),
  minSurvivalConsist: parseFloat('0.20'),

  // ARCA weights
  weights: {
    volRegime: parseFloat('0.20'),
    trendAlign: parseFloat('0.20'),
    survival: parseFloat('0.25'),
    barrier: parseFloat('0.20'),
    session: parseFloat('0.15'),
  },

  // Dynamic Sizing (v4.0)
  kellyFraction: parseFloat('0.25'),
  maxStakeMultiplier: parseFloat('3.0'),
  minStakeMultiplier: parseFloat('0.5'),
  volAdjustThreshold: parseFloat('0.65'),

  // Entry/Exit (v4.0)
  microstructWindow: parseInt('5', 10),
  scaleOutLevels: [0.25, 0.50, 0.75],
  scaleOutFractions: [0.30, 0.50, 0.20],

  // Asset Selection
  sharpeWindow: parseInt('100', 10),
  maxAssetCorrelation: parseFloat('0.70'),

  // Time-of-Day
  timeOfDayLimits: {
    0: { maxStake: 0.5, tpMult: 0.8 }, 1: { maxStake: 0.5, tpMult: 0.8 },
    2: { maxStake: 0.5, tpMult: 0.8 }, 3: { maxStake: 0.5, tpMult: 0.8 },
    4: { maxStake: 0.5, tpMult: 0.8 }, 5: { maxStake: 0.5, tpMult: 0.8 },
    6: { maxStake: 0.6, tpMult: 0.9 }, 7: { maxStake: 0.7, tpMult: 0.95 },
    8: { maxStake: 1.0, tpMult: 1.0 }, 9: { maxStake: 1.0, tpMult: 1.0 },
    10: { maxStake: 1.0, tpMult: 1.0 }, 11: { maxStake: 1.0, tpMult: 1.0 },
    12: { maxStake: 1.0, tpMult: 1.0 }, 13: { maxStake: 1.0, tpMult: 1.0 },
    14: { maxStake: 1.0, tpMult: 1.0 }, 15: { maxStake: 1.0, tpMult: 1.0 },
    16: { maxStake: 1.0, tpMult: 1.0 }, 17: { maxStake: 0.8, tpMult: 1.0 },
    18: { maxStake: 0.8, tpMult: 0.95 }, 19: { maxStake: 0.7, tpMult: 0.9 },
    20: { maxStake: 0.6, tpMult: 0.8 }, 21: { maxStake: 0.5, tpMult: 0.8 },
    22: { maxStake: 0.5, tpMult: 0.8 }, 23: { maxStake: 0.5, tpMult: 0.8 },
  },

  // Streak Recovery (v4.0 base)
  streakPauseMinutes: parseInt('20', 10),
  streakReduceStake: parseInt('3', 10),
  streakStopDay: parseInt('7', 10),

  // Daily limits
  dailyMaxLoss: parseFloat('250'),
  dailyMaxTrades: parseInt('12000'),

  // System
  barrierRefreshMs: parseInt('45000', 10),
  tradeWatchdogMs: parseInt('120000', 10),
  maxTelegramQueue: parseInt('100', 10),
  logFile: 'accuPULSE3_v5_07.log',
  logLevel: 'INFO3_v5',
  stateFile: 'accuPULSE3_state_v5_07.json',
  metricsFile: 'metrics_v5_07.json',
  metricsFileV5: 'accuPULSE3_analysis_v5_07.jsonl',  // Feature 7: Full metrics logging
  eodTimeGmt: '00:00',
  eodSendDelaySeconds: parseInt('10', 10),
  hourlySummary: true,
  pauseWindowsGmt: [],

  // ── Feature 5: Warm-up Mode Lifecycle ─────────────────────────────────
  warmupConfig: {
    warmupTrades: 30,        // Trades 0-30
    balancedTrades: 300,     // Trades 30-300
    warmupMaxOpen: 5,        // Max open during warmup
    balancedMaxOpen: 3,      // Max open during balanced
    optimizedMaxOpen: 2,     // Max open during optimized
    warmupAssets: true,      // Use ALL assets during warmup
  },

  // ── Feature 4: 4-Tier Exit Strategy ───────────────────────────────────
  tp_tiers: {
    quick_win:  { ticks: 3,  profit_pct: 0.15, scale_out: 0.30 },
    early_win:  { ticks: 8,  profit_pct: 0.25, scale_out: 0.30 },
    mid_win:    { ticks: 15, profit_pct: 0.35, scale_out: 0.30 },
    full_hold:  { ticks: 20, profit_pct: 0.50, scale_out: 0.00 },
  },

  // ── Feature 6: Enhanced Streak Recovery ────────────────────────────────
  recoveryConfig: {
    triggerLosses: 3,
    recoveryMinStake: 1.00,
    recoveryMaxStake: 20.00,
    recoveryExitWins: 10,
    recoveryExitHours: 2,
    wrThresholdNormal: 0.70,
    wrThresholdMedium: 0.60,
    wrThresholdLow: 0.50,
  },

  // ── Feature 3: 6-Check Entry Confirmation ─────────────────────────────
  entryConfirmation: {
    requiredChecks: 4,              // Need 4/6 to pass
    minVolPercentile: 0.20,         // Vol check: at least 20th percentile
    minBarrierPct: 0.015,           // Barrier check: 1.5% minimum
    minEv: 0.005,                   // EV check: 0.5% net EV
    minMomentum: 0.0001,            // Momentum check: non-flat
    minSurvivalMean: 15,            // Survival check: 15+ ticks
  },

  // Reconnect
  reconnect: {
    initialDelayMs: 1000,
    maxDelayMs    : 60000,
    backoffFactor : 2,
    jitterMs      : 750,
  },
});

// ── Logger ──────────────────────────────────────────────────────────────
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] || LOG_LEVELS.INFO;
const pad = n => String(n).padStart(2, '0');
const ts = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

function log(level, msg, ...rest) {
  if ((LOG_LEVELS[level] || 1) > currentLevel) return;
  const extras = rest.map(a => {
    if (a instanceof Error) return a.message;
    if (typeof a === 'object') return JSON.stringify(a);
    return String(a);
  }).join(' ');
  const line = `[${ts()}] [${level}] ${msg}${extras ? ' ' + extras : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (_) {}
}

// ── Telegram Notifier ────────────────────────────────────────────────────
class TelegramNotifier {
  constructor(cfg) {
    this.enabled = cfg.enabled;
    this.botToken = cfg.botToken;
    this.chatId = cfg.chatId;
    this.queue = [];
    this.sending = false;
  }

  async _post(text) {
    if (!this.enabled) return false;
    try {
      const payload = JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      const url = new URL(`https://api.telegram.org/bot${this.botToken}/sendMessage`);
      const req = https.request({
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 10000
      }, res => {
        res.on('data', () => {});
        res.on('end', () => {});
      });
      req.on('error', e => log('WARN', 'Telegram error:', e.message));
      req.on('timeout', () => req.destroy());
      req.write(payload);
      req.end();
      return true;
    } catch (e) {
      log('WARN', 'Telegram exception:', e.message);
      return false;
    }
  }

  async send(text) {
    if (!this.enabled) {
      log('DEBUG', 'TG(dry):', text.slice(0, 100));
      return;
    }
    if (this.queue.length >= CONFIG.maxTelegramQueue) {
      this.queue.shift();
      log('WARN', 'Telegram queue full; dropped oldest notification');
    }
    this.queue.push(text);
    if (!this.sending) {
      this.sending = true;
      while (this.queue.length) {
        await this._post(this.queue.shift());
        await new Promise(r => setTimeout(r, 1100));
      }
      this.sending = false;
    }
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ── Deriv Client ────────────────────────────────────────────────────────
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
    this._isPat = this._isPatToken(cfg.apiToken);
    this._rest = this._isPat ? new RestClient('https://api.derivws.com', cfg.appId, cfg.apiToken) : null;
    this._otpUrl = null;
    this._targetAccount = null;
  }

  _isPatToken(token) {
    return typeof token === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (!this.cfg.apiToken) {
      log('ERROR', 'API token empty');
      this._stopped = true;
      return;
    }
    if (this._isPat) {
      log('INFO', 'PAT token detected → new API (OTP flow)');
      this._newApiConnect().catch(e => {
        log('ERROR', 'New API connect failed:', e.message);
        this._scheduleReconnect();
      });
    } else {
      const url = this._getWsUrl();
      log('INFO', `Connecting → ${this._redactUrl(url)}`);
      this._openWs(url);
    }
  }

  _getWsUrl() {
    const sep = this.cfg.wsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.wsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }

  _redactUrl(url) {
    return url.replace(/([?&])(otp|app_id|token)=[^&]+/g, '$1$2=***').replace(/wss:\/\/[^/]+/, m => m);
  }

  async _newApiConnect() {
    const desiredType = (this.cfg.accountType || 'demo').toLowerCase();
    const accRes = await this._rest.get('/trading/v1/options/accounts');
    if (accRes.status !== 200) {
      const msg = accRes.body?.errors?.[0]?.message || accRes.body?.message || JSON.stringify(accRes.body);
      throw new Error(`Account list failed (${accRes.status}): ${msg}`);
    }
    const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
    if (!accounts.length) throw new Error('No Options accounts found');
    const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desiredType) || accounts[0];
    this._targetAccount = acct;
    this.accountInfo = {
      loginid: acct.account_id,
      email: acct.email,
      isVirtual: (acct.account_type || '').toLowerCase() === 'demo',
      accountType: acct.account_type,
      currency: acct.currency,
      balance: parseFloat(acct.balance),
      group: acct.group
    };
    const otpPath = `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`;
    const otpRes = await this._rest.post(otpPath);
    if (otpRes.status !== 200) throw new Error(`OTP failed (${otpRes.status}): ${JSON.stringify(otpRes.body)}`);
    const wsUrl = otpRes.body?.data?.url;
    if (!wsUrl || !/^wss?:/i.test(wsUrl)) throw new Error('OTP missing data.url');
    this._otpUrl = wsUrl;
    log('INFO', `Connecting OTP → ${this._redactUrl(wsUrl)}`);
    this._openWs(wsUrl);
  }

  _openWs(url) {
    try {
      this.ws = new WebSocket(url, {
        headers: { 'User-Agent': 'AccuPULSE3/5.0 (+Node.js)' },
        handshakeTimeout: 15000
      });
      this.ws.on('open', () => this._onOpen());
      this.ws.on('message', d => this._onMessage(d));
      this.ws.on('error', e => this._onError(e));
      this.ws.on('close', (c, r) => this._onClose(c, r));
      this.ws.on('unexpected-response', (_, res) => {
        log('ERROR', 'WS handshake failed:', res.statusCode, res.statusMessage);
        try { res.destroy(); } catch (_) {}
        this._scheduleReconnect();
      });
    } catch (e) {
      log('ERROR', 'WS construct failed:', e.message);
      this._scheduleReconnect();
    }
  }

  _onOpen() {
    log('INFO', 'WS connected');
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
    log('INFO', `Authorized ${this.accountInfo.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) bal=${this.balance}`);
    this.emit('authorized', this.accountInfo);
  }

  async _authorize() {
    try {
      const res = await this._send({ authorize: this.cfg.apiToken }, 20000);
      this.authorized = true;
      this.balance = parseFloat(res.authorize.balance);
      this.currency = res.authorize.currency || this.cfg.currency;
      this.accountInfo = {
        loginid: res.authorize.loginid,
        email: res.authorize.email,
        isVirtual: !!res.authorize.is_virtual,
        accountType: res.authorize.account_type
      };
      log('INFO', `Authorized ${res.authorize.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) bal=${this.balance}`);
      this.emit('authorized', this.accountInfo);
    } catch (e) {
      log('ERROR', 'Auth failed:', e.message);
      this.authorized = false;
      this._scheduleReconnect();
    }
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.error) {
      const code = msg.error.code;
      const RACE = new Set(['BetExpired', 'TradingDurationNotAllowed', 'ContractNotFound', 'InvalidContract']);
      if (!RACE.has(code)) log('ERROR', `API error: ${code} - ${msg.error.message}`);
      if (msg.req_id && this._pending.has(msg.req_id)) {
        const p = this._pending.get(msg.req_id);
        clearTimeout(p.timer);
        this._pending.delete(msg.req_id);
        p.reject(new Error(msg.error.message || code));
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
      try { this._subs.get(msg.subscription.id)(msg); } catch (e) { log('ERROR', 'Sub error:', e.message); }
    }
  }

  _onError(err) {
    log('ERROR', 'WS error:', err.message);
    this.emit('error', err);
  }

  _onClose(code, reason) {
    const r = (() => { try { return reason?.toString(); } catch { return ''; } })();
    log('WARN', `WS closed code=${code} reason=${r || 'none'}`);
    const wasAuth = this.authorized;
    this.connected = false;
    this.authorized = false;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection closed'));
    }
    this._pending.clear();
    this._subs.clear();
    this.emit('close', code, reason, wasAuth);
    if (!this._stopped) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnecting) return;
    this._reconnecting = true;
    this._reconnectAttempt++;
    const base = Math.min(
      this.cfg.reconnect.initialDelayMs * Math.pow(this.cfg.reconnect.backoffFactor, this._reconnectAttempt - 1),
      this.cfg.reconnect.maxDelayMs
    );
    const delay = base + Math.random() * this.cfg.reconnect.jitterMs;
    log('INFO', `Reconnect #${this._reconnectAttempt} in ${(delay / 1000).toFixed(1)}s`);
    setTimeout(() => {
      this._reconnecting = false;
      this.connect();
    }, delay);
  }

  _closeAndReconnect() {
    try { this.ws?.close(); } catch (_) {}
  }

  _send(payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected'));
      }
      const reqId = ++this._reqId;
      const text = JSON.stringify({ ...payload, req_id: reqId });
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error(`Timeout: ${payload.proposal || payload.buy || 'req'}`));
        }
      }, timeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });
      try { this.ws.send(text); } catch (e) {
        clearTimeout(timer);
        this._pending.delete(reqId);
        reject(e);
      }
    });
  }

  subscribe(payload, callback, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected'));
      }
      const reqId = ++this._reqId;
      const text = JSON.stringify({ ...payload, req_id: reqId, subscribe: 1 });
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error('Sub timeout'));
        }
      }, timeoutMs);
      this._pending.set(reqId, {
        resolve: msg => {
          const subId = msg.subscription?.id;
          if (subId) {
            this._subs.set(subId, callback);
            resolve(subId);
          } else {
            reject(new Error('No sub id'));
          }
        },
        reject,
        timer
      });
      try { this.ws.send(text); } catch (e) {
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
    return this._send({ forget: subId }, 8000).catch(() => {});
  }

  stop() {
    this._stopped = true;
    try { this.ws?.close(); } catch (_) {}
  }
}

// ── Rest Client ─────────────────────────────────────────────────────────
class RestClient {
  constructor(baseUrl, appId, token) {
    this.baseUrl = baseUrl || 'https://api.derivws.com';
    this.appId = appId || '1089';
    this.token = token || '';
  }

  async _request(method, reqPath, body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(reqPath, this.baseUrl); } catch (e) {
        return reject(new Error(`Invalid URL: ${reqPath}`));
      }
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : require('http');
      const opts = {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Deriv-App-ID': this.appId,
          'Authorization': 'Bearer ' + this.token,
          'Accept': 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        timeout: 15000
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
      req.on('timeout', () => { req.destroy(new Error('REST timeout')); });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async get(p) { return this._request('GET', p); }
  async post(p, b) { return this._request('POST', p, b); }
}

// ── Market Data Manager ─────────────────────────────────────────────────
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
    this.stayCache.get(symbol).set(key, {
      ticks_stayed_in: arr,
      ts: Date.now(),
      barrier: +cd.tick_size_barrier_percentage || 0
    });
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

  getBarrier(symbol, growthRate) {
    return this._barrierCache.get(`${symbol}:${growthRate}`);
  }

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
                const res = await this.client._send({
                  proposal: 1,
                  amount: this.cfg.baseStake,
                  basis: 'stake',
                  contract_type: 'ACCU',
                  currency: this.cfg.currency,
                  [symbolKey]: sym,
                  growth_rate: gr
                }, 8000);
                if (res?.proposal?.contract_details) {
                  this.cacheBarrier(sym, gr, res.proposal.contract_details);
                  this.cacheStays(sym, gr, res.proposal.contract_details);
                }
              } catch (e) {
                log('DEBUG', `refreshBarriers(${sym},${gr}):`, e.message);
              }
            })()
          );
        }
      }
      const results = await Promise.allSettled(promises);
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      log('INFO', `Barrier refresh: ${succeeded}/${promises.length} succeeded`);
    } finally {
      this._refreshInFlight = false;
    }
  }

  async loadSymbols() {
    try {
      const res = await this.client._send({ active_symbols: 'brief' }, 15000);
      for (const s of (res.active_symbols || [])) {
        const k = s.underlying_symbol || s.symbol;
        if (k) this.client.symbols.set(k, s);
      }
      log('INFO', `Loaded ${this.client.symbols.size} symbols`);
    } catch (e) {
      log('ERROR', 'loadSymbols:', e.message);
    }
  }

  async backfill(symbol, count = 1000) {
    try {
      const res = await this.client._send({
        ticks_history: symbol,
        count,
        end: 'latest',
        style: 'ticks'
      }, 20000);
      const prices = res.history?.prices || [];
      const times = res.history?.times || [];
      const arr = times.map((t, i) => ({ epoch: +t, quote: parseFloat(prices[i]) }));
      this.history.set(symbol, arr);
      if (arr.length) this.lastQuote.set(symbol, arr[arr.length - 1].quote);
      log('DEBUG', `Backfilled ${symbol}: ${arr.length} ticks`);
      return arr;
    } catch (e) {
      log('ERROR', `backfill(${symbol}):`, e.message);
      return [];
    }
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
        const cap = Math.max(this.cfg.tickWindow * 8, 2000);
        if (arr.length > cap) arr.splice(0, arr.length - cap);
      } else {
        this.history.set(symbol, [tick]);
      }
    });
    this.subs.set(symbol, subId);
    return subId;
  }

  async bootstrap(symbols) {
    if (this._bootstrapping) return;
    this._bootstrapping = true;
    try {
      await Promise.all(symbols.map(s => this.subscribe(s).catch(e => log('WARN', `sub(${s}):`, e.message))));
      await Promise.all(symbols.map(async s => {
        if ((this.history.get(s) || []).length < this.cfg.minTicksForAnalysis) {
          await this.backfill(s, Math.max(this.cfg.tickWindow * 5, 1000));
        }
      }));
    } finally {
      this._bootstrapping = false;
    }
  }

  historyFor(symbol) {
    return this.history.get(symbol) || [];
  }
}

// ── Enhanced ARCA Analyzer (v4.0 core + v5.0 adaptive confidence) ──────
class EnhancedARCAAnalyzer {
  constructor(cfg) {
    this.cfg = cfg;
    this.w = cfg.weights;
    this.regimeWinRates = new Map();
    this.assetSharpe = new Map();
    this._lastVolRegime = 'normal';
    this._lastTrend = 'neutral';
  }

  // ── Feature 1: Get adaptive confidence threshold ───────────────────────
  getMinConfidence(volRegime) {
    const thresholds = this.cfg.minConfidenceByRegime || {};
    const threshold = thresholds[volRegime] !== undefined
      ? thresholds[volRegime]
      : this.cfg.minConfidence;
    log('DEBUG', `Adaptive confidence: regime=${volRegime} → threshold=${threshold.toFixed(3)}`);
    return threshold;
  }

  // Phase 1: Asymmetric Hazard Analysis
  computeAsymmetricHazard(ticks, growthRate) {
    if (!ticks || ticks.length < 100) return null;
    const returns = [];
    for (let i = 1; i < ticks.length; i++) {
      const prev = Number(ticks[i - 1].quote);
      const next = Number(ticks[i].quote);
      if (prev > 0 && next > 0) {
        const logRet = Math.log(next / prev);
        returns.push(logRet);
      }
    }
    if (returns.length < 50) return null;

    const upReturns = returns.filter(r => r > 0);
    const downReturns = returns.filter(r => r < 0);
    const upMean = upReturns.length ? upReturns.reduce((s, r) => s + Math.abs(r), 0) / upReturns.length : 0;
    const downMean = downReturns.length ? downReturns.reduce((s, r) => s + Math.abs(r), 0) / downReturns.length : 0;

    const upFreq = upReturns.length / returns.length;
    const downFreq = downReturns.length / returns.length;

    return {
      upMean,
      downMean,
      upFreq,
      downFreq,
      asymmetry: (downMean - upMean) / (downMean + upMean + 1e-12),
      bias: downMean > upMean * 1.2 ? 'UP' : upMean > downMean * 1.2 ? 'DOWN' : 'NEUTRAL',
    };
  }

  // Phase 1: Record Trade for Win-Rate Grid
  recordTrade(symbol, growthRate, volRegime, trendDirection, hour, profit, payout) {
    const key = `${volRegime}:${trendDirection}:${hour}`;
    const result = profit > 0 ? 'win' : 'loss';
    const entry = { symbol, growthRate, profit, payout, result };

    if (!this.regimeWinRates.has(key)) {
      this.regimeWinRates.set(key, { wins: 0, losses: 0, trades: [] });
    }
    const cell = this.regimeWinRates.get(key);
    if (result === 'win') cell.wins++;
    else cell.losses++;
    cell.trades.push(entry);
    if (cell.trades.length > 1000) cell.trades.shift();
  }

  // Phase 1: Get Win-Rate for Regime
  getRegimeScore(volRegime, trendDirection, hour) {
    const key = `${volRegime}:${trendDirection}:${hour}`;
    const cell = this.regimeWinRates.get(key);
    if (!cell || cell.wins + cell.losses < 5) return 0.5;
    const wr = cell.wins / (cell.wins + cell.losses);
    return wr > 0.50 ? Math.min(1.0, wr * 1.2) : Math.max(0.0, wr * 0.8);
  }

  // Phase 4: Compute Sharpe Ratio
  computeSharpe(trades, window = 100) {
    if (!trades || trades.length < 5) return 0;
    const recent = trades.slice(-window);
    const profits = recent.map(t => t.profit || 0);
    const mean = profits.reduce((s, p) => s + p, 0) / profits.length;
    let variance = 0;
    for (const p of profits) variance += (p - mean) ** 2;
    const std = Math.sqrt(variance / profits.length) || 1e-12;
    return std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  }

  // Phase 4: Update Asset Sharpe
  updateAssetSharpe(symbol, trades) {
    const sharpe = this.computeSharpe(trades.filter(t => t.symbol === symbol));
    this.assetSharpe.set(symbol, sharpe);
  }

  // Main Analysis
  analyze(symbol, ticks, barrier, growthRate, stayData = null) {
    const model = this._hazardEstimate(ticks, barrier?.halfBarrierPct, growthRate);
    if (!model.ok) {
      return {
        symbol,
        growthRate,
        eligible: false,
        score: -Infinity,
        reasons: [model.reason]
      };
    }

    const quotes = ticks.map(t => t.quote);
    const vol = this._volatilityRegime(quotes);
    const trend = this._trendAlignment(quotes);
    const survivalTrend = stayData ? this._survivalTrend(stayData.ticks_stayed_in) : null;
    const barrierMargin = this._barrierMarginScore(quotes, barrier);
    const sessionScore = this._sessionScore();
    const asymmetry = this.computeAsymmetricHazard(ticks, growthRate);

    // Update last regime for recording
    this._lastVolRegime = vol?.regimeLabel || 'normal';
    this._lastTrend = trend?.direction || 'neutral';

    // Phase 1: Regime score
    const regimeScore = this.getRegimeScore(
      vol?.regime || 1,
      trend?.direction || 'neutral',
      new Date().getUTCHours()
    );

    // Composite scoring
    const volScore = vol?.score ?? 0;
    const trendScore = trend?.composite ?? 0;
    const survivalScore = survivalTrend?.score ?? 0;
    const barrierScore = barrierMargin?.score ?? 0;
    const sessScore = sessionScore;

    const compositeScore =
      this.w.volRegime * volScore +
      this.w.trendAlign * trendScore +
      this.w.survival * survivalScore +
      this.w.barrier * barrierScore +
      this.w.session * sessScore;

    // Phase 1: Asymmetry boost
    const asymmetryBoost = asymmetry?.bias === 'UP' ? 0.1 :
                          asymmetry?.bias === 'DOWN' ? -0.1 : 0;

    const score = compositeScore + regimeScore * 0.05 + asymmetryBoost + (model.conservativeEV > 0 ? 0.1 : -0.2);

    return {
      symbol,
      growthRate,
      eligible: true,
      score,
      model,
      volRegime: vol?.regime ?? 1,
      volRegimeLabel: vol?.regimeLabel ?? 'normal',
      volScore,
      trendDirection: trend?.direction ?? 'neutral',
      trendScore,
      rsi: trend?.rsi ?? 50,
      survivalScore,
      survivalMean: survivalTrend?.mean ?? 0,
      survivalSlope: survivalTrend?.slope ?? 0,
      survivalConsistency: survivalTrend?.consistency ?? 0,
      pSurvival: model.pHorizon,
      barrierScore,
      sessionScore: sessScore,
      regimeScore,
      asymmetry: asymmetry?.bias ?? 'NEUTRAL',
      asymmetryScore: asymmetry?.asymmetry ?? 0,
      suggestedGrowth: growthRate,
      hurst: vol?.hurst ?? 0.5,
      reasons: [
        `EV:${(model.conservativeEV * 100).toFixed(1)}%`,
        `pL:${model.pLower.toFixed(3)}`,
        `regime:${regimeScore.toFixed(2)}`,
        `asymm:${asymmetry?.bias}`
      ],
    };
  }

  rank(analyses) {
    return analyses.filter(a => a?.eligible).sort((a, b) => b.score - a.score);
  }

  _hazardEstimate(ticks, halfBarrierPct, growthRate) {
    const barrierPct = Number(halfBarrierPct || 0);
    if (!(barrierPct >= this.cfg.minBarrierPct)) {
      return { ok: false, reason: 'NO_VERIFIED_BARRIER' };
    }
    if (!ticks || ticks.length < this.cfg.minEmpiricalSamples + 1) {
      return { ok: false, reason: 'INSUFFICIENT_TICKS' };
    }

    const start = Math.max(1, ticks.length - this.cfg.hazardWindow);
    const returns = [];

    for (let i = start; i < ticks.length; i++) {
      const prev = Number(ticks[i - 1].quote);
      const next = Number(ticks[i].quote);
      if (prev > 0 && next > 0) {
        const logRet = Math.abs(Math.log(next / prev));
        returns.push(logRet);
      }
    }

    if (returns.length < this.cfg.minEmpiricalSamples) {
      return {
        ok: false,
        reason: 'INSUFFICIENT_VALID_RETURNS',
        returns: returns.length
      };
    }

    const threshold = barrierPct / 100;
    const survivors = returns.filter(r => r < threshold).length;
    const totalReturns = returns.length;
    const pTick = survivors / totalReturns;
    const pLower = this._wilsonLower(survivors, totalReturns, this.cfg.confidenceZ);
    const N = this.cfg.plannedHoldTicks;
    const pHorizon = Math.pow(pLower, N);
    const gross = Math.pow(1 + growthRate, N) * pHorizon - 1;
    const conservativeEV = gross > 0 ? gross * this.cfg.evHaircut : gross;

    const sorted = [...returns].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1e-12;
    const mad = sorted.reduce((s, x) => s + Math.abs(x - median), 0) / sorted.length || 1e-12;
    const jumpZ = Math.abs(returns[returns.length - 1] - median) / (1.4826 * mad);

    if (jumpZ > this.cfg.maxRecentJumpZ) {
      return { ok: false, reason: 'RECENT_JUMP', jumpZ };
    }

    if (conservativeEV < this.cfg.minNetEvRatio) {
      return {
        ok: false,
        reason: 'EV_BELOW_HAIRCUT',
        conservativeEV,
        pLower,
        pHorizon
      };
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
    };
  }

  _wilsonLower(hits, n, z) {
    if (!n) return 0;
    const p = hits / n;
    const z2 = z * z;
    const d = 1 + z2 / n;
    return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / d);
  }

  // Phase 3: Evaluate Proposal
  evaluateProposal(ticks, growthRate, proposal) {
    const cd = proposal?.contract_details || {};
    const spot = Number(proposal?.spot || cd.current_spot || 0);
    const distance = Number(cd.barrier_spot_distance || 0);
    const pct = spot > 0 && distance > 0 ? (distance / spot) * 100 : Number(cd.tick_size_barrier_percentage || 0);
    return this._hazardEstimate(ticks, pct, growthRate);
  }

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
      for (const v of q.slice(Math.max(0, i - 4), i + 1)) {
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
      const o = q[i - 1] || q[i], c = q[i];
      s += 0.5 * (Math.log(hi / lo || 1)) ** 2 - (2 * Math.log(2) - 1) * (Math.log(c / o || 1)) ** 2;
    }
    return Math.sqrt(Math.max(s / window, 1e-12));
  }

  _hurst(q, maxLag = 50) {
    const n = q.length;
    if (n < maxLag + 2) return 0.5;
    const ret = new Array(n - 1);
    for (let i = 1; i < n; i++) {
      ret[i - 1] = q[i - 1] !== 0 ? Math.log(q[i] / q[i - 1]) : 0;
    }
    const lags = [10, 20, 30, 40, 50].filter(l => l < ret.length);
    const pts = [];
    for (const lag of lags) {
      const chunks = Math.floor(ret.length / lag);
      let sumRS = 0, cnt = 0;
      for (let c = 0; c < chunks; c++) {
        const sl = ret.slice(c * lag, (c + 1) * lag);
        let m = 0; for (const x of sl) m += x; m /= sl.length;
        let cum = 0, mx = -Infinity, mn = Infinity;
        for (const x of sl) {
          cum += (x - m);
          if (cum > mx) mx = cum;
          if (cum < mn) mn = cum;
        }
        let v = 0; for (const x of sl) v += (x - m) ** 2;
        const sd = Math.sqrt(v / sl.length) || 1e-12;
        sumRS += (mx - mn) / sd;
        cnt++;
      }
      if (cnt > 0) pts.push([Math.log(lag), Math.log(sumRS / cnt)]);
    }
    if (pts.length < 2) return 0.5;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (const [x, y] of pts) {
      sx += x;
      sy += y;
      sxy += x * y;
      sxx += x * x;
    }
    const d = pts.length * sxx - sx * sx;
    return Math.max(0.1, Math.min(0.9, d !== 0 ? (pts.length * sxy - sx * sy) / d : 0.5));
  }

  _trendAlignment(q) {
    const n = q.length;
    if (n < 55) return null;
    const emaFast = this._ema(q, 9);
    const emaSlow = this._ema(q, 21);
    const emaTrend = this._ema(q, 50);
    const rsi = this._rsi(q, 14);
    const macd = this._macd(q);
    const price = q[n - 1];
    let direction = 'neutral';
    if (emaFast > emaSlow && price > emaTrend) direction = 'up';
    else if (emaFast < emaSlow && price < emaTrend) direction = 'down';
    const emaSpread = Math.abs(emaFast - emaSlow) / (emaSlow || 1);
    const emaAlignment = Math.min(1, emaSpread * 500);
    let rsiScore;
    if (direction === 'up') {
      rsiScore = (rsi > 45 && rsi < 75) ? 0.8 : (rsi > 35 && rsi < 85) ? 0.5 : 0.2;
    } else if (direction === 'down') {
      rsiScore = (rsi > 25 && rsi < 55) ? 0.8 : (rsi > 15 && rsi < 65) ? 0.5 : 0.2;
    } else {
      rsiScore = (rsi > 35 && rsi < 65) ? 0.7 : 0.3;
    }
    let macdScore;
    if ((direction === 'up' && macd.histogram > 0) || (direction === 'down' && macd.histogram < 0)) {
      macdScore = 0.8;
    } else if (Math.abs(macd.histogram) < 0.001) {
      macdScore = 0.5;
    } else {
      macdScore = 0.2;
    }
    const composite = 0.35 * emaAlignment + 0.35 * rsiScore + 0.30 * macdScore;
    return {
      direction,
      emaFast,
      emaSlow,
      emaTrend,
      rsi,
      macdHist: macd.histogram,
      composite
    };
  }

  _ema(data, period) {
    if (data.length < period) return data[data.length - 1];
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  }

  _rsi(data, period = 14) {
    if (data.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = data.length - period; i < data.length; i++) {
      const d = data[i] - data[i - 1];
      if (d > 0) gains += d;
      else losses -= d;
    }
    return losses === 0 ? 100 : 100 - (100 / (1 + gains / losses));
  }

  _macd(data, fast = 12, slow = 26, sig = 9) {
    if (data.length < slow + sig) return { histogram: 0 };
    const diffs = [];
    for (let i = slow; i < data.length; i++) {
      diffs.push(this._ema(data.slice(0, i + 1), fast) - this._ema(data.slice(0, i + 1), slow));
    }
    const macdLine = this._ema(data, fast) - this._ema(data, slow);
    const signalLine = diffs.length >= sig ? this._ema(diffs.slice(-sig * 3), sig) : macdLine;
    return { histogram: macdLine - signalLine };
  }

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
      for (let i = 0; i < recent.length; i++) {
        sx += i;
        sy += recent[i];
        sxy += i * recent[i];
        sxx += i * i;
      }
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
    return {
      mean,
      median,
      slope,
      trendNorm,
      consistency,
      pSurvival,
      score,
      trendLabel
    };
  }

  _barrierMarginScore(quotes, barrier) {
    if (!barrier || !quotes || !quotes.length) return { score: 0.5 };
    const current = quotes[quotes.length - 1];
    const high = barrier.highBarrier || 0;
    const low = barrier.lowBarrier || 0;
    if (high <= low || high === 0) return { score: 0.5 };
    const rangeWidth = high - low;
    const distHigh = high - current;
    const distLow = current - low;
    const minDist = Math.min(distHigh, distLow);
    const centeredness = 1 - (minDist / (rangeWidth / 2));
    const score = Math.max(0, Math.min(1, centeredness * 0.8 + 0.2));
    return { score, centeredness, distHigh, distLow, range: rangeWidth };
  }

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

// ── Enhanced Trade Executor (v5.0: 6-factor sizing + 6-check entry) ────
class EnhancedTradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.open = new Map();
    this.market = null;
    this.analyzer = null;
    this._selling = new Set();
    this._scalingOut = new Set();
    this._buying = false;
    this._lastUpdateMap = new Map();
    this._settledIds = new Set();
    this.positionHistory = [];
    this._lastVolRegime = 'normal';
    this._lastTrend = 'neutral';
  }

  // ── Feature 2: 6-Factor Dynamic Stake Sizing (computeStakeV2) ──────────
  computeStakeV2(balance, equityPeak, baseStake, confidence, volRegime, winRate, lossStreak, kellyEdge) {
    // 1. KELLY EDGE
    const kellyMult = 1 + (this.cfg.kellyFraction * (kellyEdge || 0));

    // 2. CONFIDENCE BOOST (square root scaling)
    const confidenceMult = Math.pow(Math.max(0.01, confidence) / 0.10, 0.5);

    // 3. VOL REGIME MULTIPLIER
    const volMult = {
      0: 1.2,    // Low vol: predictable, scale UP
      1: 1.0,    // Normal: baseline
      2: 0.8,    // High vol: scale DOWN
      3: 0.4     // Extreme: very defensive
    }[volRegime] ?? 1.0;

    // 4. WIN-RATE MULTIPLIER (recent performance)
    let wrMult = 1.0;
    if (winRate > 0.55) {
      wrMult = Math.min(1.8, 1.0 + (winRate - 0.50) * 1.6);
    } else if (winRate < 0.45) {
      wrMult = Math.max(0.4, 1.0 - (0.50 - winRate) * 1.2);
    }

    // 5. DRAWDOWN BRAKE
    const dd = equityPeak > 0 ? (equityPeak - balance) / equityPeak : 0;
    let ddMult = 1.0;
    if (dd > 0.30) ddMult = 0.1;
    else if (dd > 0.20) ddMult = 0.4;
    else if (dd > 0.10) ddMult = 0.7;

    // 6. STREAK MULTIPLIER
    let streakMult = 1.0;
    if (lossStreak >= 5) streakMult = 0.2;
    else if (lossStreak >= 3) streakMult = 0.5;

    // FINAL STAKE
    let stake = baseStake * kellyMult * confidenceMult * volMult * wrMult * ddMult * streakMult;

    // Hard caps
    return Math.max(
      baseStake * 0.3,           // Min: 30% base
      Math.min(baseStake * 3.0, stake)  // Max: 300% base
    );
  }

  // ── Feature 3: 6-Check Entry Confirmation ─────────────────────────────
  confirmEntry(symbol, analysis, ticks, proposal) {
    const cfg = this.cfg.entryConfirmation || {};
    const checks = {
      // 1. Volatility regime check
      vol_check: () => {
        const recentVol = this._computeRecentVol(ticks, 20);
        const volPercentile = this._getVolPercentile(ticks, recentVol);
        const result = volPercentile > (cfg.minVolPercentile || 0.20);
        log('DEBUG', `EntryCheck vol: ${volPercentile.toFixed(3)} > ${cfg.minVolPercentile || 0.20} = ${result}`);
        return result;
      },

      // 2. Barrier sufficiency
      barrier_check: () => {
        const barrierPct = proposal?.contract_details?.tick_size_barrier_percentage
          || proposal?.contract_details?.barrier_spot_distance
          ? (proposal.contract_details.barrier_spot_distance / (proposal.spot || 1)) * 100
          : 0;
        const result = barrierPct >= (cfg.minBarrierPct || 0.015);
        log('DEBUG', `EntryCheck barrier: ${barrierPct.toFixed(3)}% >= ${(cfg.minBarrierPct || 0.015) * 100}% = ${result}`);
        return result;
      },

      // 3. EV sufficiency
      ev_check: () => {
        const ev = analysis?.model?.conservativeEV || 0;
        const result = ev >= (cfg.minEv || 0.005);
        log('DEBUG', `EntryCheck EV: ${(ev * 100).toFixed(2)}% >= ${(cfg.minEv || 0.005) * 100}% = ${result}`);
        return result;
      },

      // 4. Trend alignment
      trend_check: () => {
        const direction = analysis?.trendDirection || 'neutral';
        const score = analysis?.trendScore || 0;
        const result = direction !== 'neutral' || score > 0.5;
        log('DEBUG', `EntryCheck trend: dir=${direction} score=${score.toFixed(3)} = ${result}`);
        return result;
      },

      // 5. Recent momentum
      momentum_check: () => {
        if (!ticks || ticks.length < 10) return false;
        const recent = ticks.slice(-10);
        const returns = recent.map((t, i) =>
          i === 0 ? 0 : Math.log(t.quote / recent[i - 1].quote)
        );
        const momentum = returns.reduce((a, b) => a + b, 0);
        const result = Math.abs(momentum) > (cfg.minMomentum || 0.0001);
        log('DEBUG', `EntryCheck momentum: ${momentum.toFixed(6)} > ${cfg.minMomentum || 0.0001} = ${result}`);
        return result;
      },

      // 6. Survival pattern
      survival_check: () => {
        const survivalMean = analysis?.survivalMean || 0;
        const result = survivalMean > (cfg.minSurvivalMean || 15);
        log('DEBUG', `EntryCheck survival: ${survivalMean.toFixed(1)} > ${cfg.minSurvivalMean || 15} = ${result}`);
        return result;
      },
    };

    const passed = Object.values(checks).filter(f => f()).length;
    const required = cfg.requiredChecks || 4;

    const details = Object.entries(checks).map(([name, fn]) => {
      try { return { check: name, result: fn() }; } catch (e) {
        return { check: name, result: false, error: e.message };
      }
    });

    return {
      approved: passed >= required,
      passed,
      required,
      details
    };
  }

  _computeRecentVol(ticks, window = 20) {
    if (!ticks || ticks.length < window + 1) return 0;
    const slice = ticks.slice(-window);
    const returns = [];
    for (let i = 1; i < slice.length; i++) {
      const prev = slice[i - 1].quote;
      const curr = slice[i].quote;
      if (prev > 0 && curr > 0) {
        returns.push(Math.log(curr / prev));
      }
    }
    if (returns.length < 2) return 0;
    const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
    let variance = 0;
    for (const r of returns) variance += (r - mean) ** 2;
    return Math.sqrt(variance / returns.length);
  }

  _getVolPercentile(ticks, currentVol) {
    if (!ticks || ticks.length < 100) return 0.5;
    const window = 20;
    const vols = [];
    for (let i = window + 1; i < ticks.length; i++) {
      const slice = ticks.slice(i - window, i);
      const returns = [];
      for (let j = 1; j < slice.length; j++) {
        const prev = slice[j - 1].quote;
        const curr = slice[j].quote;
        if (prev > 0 && curr > 0) {
          returns.push(Math.log(curr / prev));
        }
      }
      if (returns.length >= 2) {
        const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
        let v = 0;
        for (const r of returns) v += (r - mean) ** 2;
        vols.push(Math.sqrt(v / returns.length));
      }
    }
    if (vols.length < 2) return 0.5;
    const sorted = [...vols].sort((a, b) => a - b);
    const idx = sorted.findIndex(v => v >= currentVol);
    return idx < 0 ? 1.0 : idx / sorted.length;
  }

  // Phase 2: Dynamic Stake Sizing (v4.0 fallback)
  computeStake(baseStake, compositeScore, volHurst, recentWinRate, kellyEdge) {
    const confidenceMultiplier = Math.sqrt(Math.max(0, compositeScore / (this.cfg.minConfidence || 0.05)));
    const kellyMult = 1 + (this.cfg.kellyFraction * kellyEdge);
    let volMult = 1.0;
    if (volHurst > this.cfg.volAdjustThreshold) {
      volMult = 0.6;
      log('WARN', `Volatility spike detected: Hurst=${volHurst.toFixed(2)} → reducing stake 40%`);
      telegram.send(`⚠️ <b>AccuPULSE3_v5 Volatility spike detected</b>\nHurst: ${volHurst.toFixed(2)}\nStake: -40%`);
    }
    let wrMult = 1.0;
    if (recentWinRate > 0.55) {
      wrMult = Math.min(1.5, 1.0 + (recentWinRate - 0.50) * 2);
    } else if (recentWinRate < 0.45) {
      wrMult = Math.max(0.5, 1.0 - (0.50 - recentWinRate) * 2);
    }
    let stake = baseStake * confidenceMultiplier * kellyMult * volMult * wrMult;
    stake = Math.max(baseStake * this.cfg.minStakeMultiplier, Math.min(baseStake * this.cfg.maxStakeMultiplier, stake));
    return +stake.toFixed(2);
  }

  // Phase 2: Compute Kelly Edge
  computeKellyEdge(trades) {
    if (!trades || trades.length < 10) return 0;
    const recent = trades.slice(-100);
    const wins = recent.filter(t => t.profit > 0);
    const losses = recent.filter(t => t.profit <= 0);
    if (!wins.length || !losses.length) return 0;
    const avgWin = wins.reduce((s, t) => s + t.profit, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, t) => s + t.profit, 0) / losses.length);
    const wr = wins.length / recent.length;
    const edge = (wr * avgWin - (1 - wr) * avgLoss) / (avgWin || 1);
    return Math.max(-0.5, Math.min(0.5, edge));
  }

  // Phase 3: Micro-Structure Confirmation (v4.0)
  checkMicroStructureConfirmation(symbol, ticks) {
    if (!ticks || ticks.length < this.cfg.microstructWindow) {
      return { pass: true, score: 0.5 };
    }
    const recent = ticks.slice(-this.cfg.microstructWindow);
    const quotes = recent.map(t => t.quote);
    const start = quotes[0];
    const end = quotes[quotes.length - 1];
    const direction = end > start ? 'UP' : 'DOWN';
    const moveSize = Math.abs(end - start) / start;
    let confirmationScore = 0.5;
    if (moveSize > 0.001) {
      confirmationScore = 0.7;
    } else if (moveSize < 0.0001) {
      confirmationScore = 0.4;
    }
    return { pass: true, score: confirmationScore, direction, moveSize };
  }

  // Phase 4: Correlation Hedging
  checkCorrelationWithOpen(symbol) {
    if (this.open.size === 0) return true;
    const openSymbols = [...this.open.values()].map(t => t.symbol);
    const getAssetFamily = (sym) => sym.split('_')[0];
    const family = getAssetFamily(symbol);
    const openFamilies = openSymbols.map(getAssetFamily);
    const sameFamilyCount = openFamilies.filter(f => f === family).length;
    if (sameFamilyCount > 0) {
      log('DEBUG', `Correlation check failed: same family ${family} already open`);
      return false;
    }
    return true;
  }

  // Phase 3: Scale-Out Exit (v4.0)
  async attemptScaleOut(contractId, info, currentProfit, expectedPayout) {
    if (this._scalingOut.has(contractId)) return false;
    const scaleOutLevels = this.cfg.scaleOutLevels || [0.25, 0.50, 0.75];
    for (let i = 0; i < scaleOutLevels.length; i++) {
      const threshold = expectedPayout * scaleOutLevels[i];
      if (currentProfit >= threshold && currentProfit > 0) {
        log('INFO', `Scale-out opportunity #${contractId} at ${currentProfit.toFixed(2)} (${threshold.toFixed(2)} threshold)`);
        this._scalingOut.add(contractId);
        return true;
      }
    }
    return false;
  }

  async buy(symbol, growthRate, stake, limit, analysis = null, proposalValidator = null) {
    if (this._buying || this.open.size >= this.cfg.maxOpenTrades) {
      throw new Error('ENTRY_LOCKED');
    }
    this._buying = true;
    growthRate = Math.max(0.01, Math.min(0.05, +growthRate.toFixed(4)));
    try {
      const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
      const pres = await this.client._send({
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: 'ACCU',
        currency: this.cfg.currency,
        [symbolKey]: symbol,
        growth_rate: growthRate,
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
      log('INFO', `Proposal id=${p.id} ask=${p.ask_price} payout=${p.payout} spot=${p.spot}`);

      if (this.market && p.contract_details) {
        this.market.cacheStays(symbol, growthRate, p.contract_details);
        this.market.cacheBarrier(symbol, growthRate, p.contract_details);
      }

      const bres = await this.client._send({ buy: p.id, price: p.ask_price }, 20000);
      const b = bres.buy;
      if (!b?.contract_id) throw new Error('No contract_id');

      log('INFO', `Bought ACCU #${b.contract_id} for ${b.buy_price}`);

      const cd = p.contract_details || {};
      const entrySpot = parseFloat(p.spot ?? cd.current_spot ?? 0);
      const halfBarrierPct = entrySpot ? (parseFloat(cd.barrier_spot_distance ?? 0) / entrySpot) * 100 : 0;

      const info = {
        contractId: b.contract_id,
        symbol,
        growthRate,
        stake,
        buyPrice: parseFloat(b.buy_price),
        payout: parseFloat(p.payout),
        buyTime: b.purchase_time || (Date.now() / 1000),
        limit: {
          stop_loss: limit.stop_loss ?? null,
          take_profit: limit.take_profit ?? null
        },
        contractDetails: cd,
        entrySpot,
        halfBarrierPct,
        highBarrier: parseFloat(cd.high_barrier ?? 0),
        lowBarrier: parseFloat(cd.low_barrier ?? 0),
        _entrySpot: entrySpot,
        _analysis: analysis,
        profit: 0,
        status: 'open',
        currentSpot: entrySpot,
      };
      this.open.set(b.contract_id, info);
      this._lastUpdateMap.set(b.contract_id, Date.now());

      try {
        await this._subscribeContract(info);
      } catch (e) {
        log('WARN', `Post-buy subscription #${b.contract_id} failed; reconciliation will retry:`, e.message);
      }
      this.emit('open', info);
      return info;
    } catch (e) {
      log('ERROR', `buy(${symbol}):`, e.message);
      throw e;
    } finally {
      this._buying = false;
    }
  }

  async _subscribeContract(info) {
    return this.client.subscribe(
      { proposal_open_contract: 1, contract_id: info.contractId },
      msg => this._onUpdate(msg, info)
    );
  }

  async reconcile() {
    let portfolio;
    try {
      portfolio = await this.client._send({ portfolio: 1 }, 15000);
    } catch (e) {
      log('WARN', 'Portfolio reconciliation failed:', e.message);
      return false;
    }
    const contracts = Array.isArray(portfolio?.portfolio) ? portfolio.portfolio : [];
    const liveIds = new Set();
    for (const c of contracts) {
      const id = c.contract_id;
      if (!id) continue;
      liveIds.add(id);
      let info = this.open.get(id);
      if (!info) {
        info = {
          contractId: id,
          symbol: c.underlying || c.underlying_symbol || 'UNKNOWN',
          growthRate: Number(c.growth_rate || 0),
          stake: Number(c.buy_price || 0),
          buyPrice: Number(c.buy_price || 0),
          payout: Number(c.payout || 0),
          buyTime: Number(c.purchase_time || Date.now() / 1000),
          limit: {},
          profit: Number(c.profit || 0),
          status: 'open',
          currentSpot: Number(c.current_spot || 0),
          recovered: true
        };
        this.open.set(id, info);
        this._lastUpdateMap.set(id, Date.now());
        this.emit('recovered', info);
      }
      try {
        await this._subscribeContract(info);
      } catch (e) {
        log('WARN', `Resubscribe #${id}:`, e.message);
      }
    }
    for (const id of [...this.open.keys()]) {
      if (!liveIds.has(id)) {
        this.open.delete(id);
        this._lastUpdateMap.delete(id);
        // Server no longer lists it as open → it settled while we weren't
        // subscribed. Mark settled so a stray echo can't re-settle it.
        this._settledIds.add(id);
      }
    }
    return true;
  }

  _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    const cid = c.contract_id ?? info.contractId;
    const profit = parseFloat(c.profit ?? 0);
    const spot = parseFloat(c.current_spot ?? 0);

    this._lastUpdateMap.set(cid, Date.now());

    // Phase 3: Attempt scale-out (v4.0)
    if (c.status === 'open' && profit > 0 && !this._scalingOut.has(cid)) {
      this.attemptScaleOut(cid, info, profit, info.payout).catch(() => {});
    }

    // Manual stop-loss check
    const stopLossAbs = Math.abs(info.limit?.stop_loss || 0);
    if ((c.status === 'open') && stopLossAbs > 0 && profit <= -stopLossAbs && !this._selling.has(cid)) {
      log('WARN', `SL hit #${cid} profit=${profit.toFixed(2)}`);
      this._selling.add(cid);
      this.sell(cid, 0)
        .catch(e => log('ERROR', `SL sell failed:`, e.message))
        .finally(() => this._selling.delete(cid));
    }

    if (c.status !== 'open' || c.is_sold) {
      // Idempotent settlement: ignore late/duplicate settlement echoes for a
      // contract we already finalized (force-sold or previously settled).
      if (this._settledIds.has(cid)) {
        this.open.delete(cid);
        this._lastUpdateMap.delete(cid);
        return;
      }
      this._settledIds.add(cid);
      const status = profit >= 0 ? 'won' : 'lost';
      const finished = {
        ...info,
        contractId: cid,
        profit,
        status,
        sellPrice: parseFloat(c.sell_price ?? c.bid_price ?? 0),
        sellTime: c.sell_time ?? c.exit_tick_time ?? (Date.now() / 1000),
        currentSpot: spot
      };
      this.open.delete(cid);
      this._lastUpdateMap.delete(cid);
      this.positionHistory.push(finished);
      this.emit('result', finished);
      if (msg.subscription?.id) {
        this.client.forget(msg.subscription.id).catch(() => {});
      }
    } else {
      this.emit('update', {
        ...info,
        contractId: cid,
        profit,
        currentSpot: spot,
        status: c.status
      });
    }
  }

  async sell(contractId, minPrice = 0) {
    const res = await this.client._send({ sell: contractId, price: minPrice }, 15000);
    log('INFO', `Sold #${contractId} for ${res.sell?.sold_for}`);
    return res.sell;
  }

  count() {
    return this.open.size;
  }

  checkStuckContracts(maxStaleMsec = 180000) {
    const now = Date.now();
    for (const [cid, lastTime] of this._lastUpdateMap.entries()) {
      if (now - lastTime > maxStaleMsec) {
        const staleSec = ((now - lastTime) / 1000).toFixed(0);
        const info = this.open.get(cid);
        log('WARN', `Contract #${cid} stuck for ${staleSec}s, force-selling`);
        // Idempotency guard: never re-settle a contract we already finalized.
        if (this._settledIds.has(cid)) {
          this.open.delete(cid);
          this._lastUpdateMap.delete(cid);
          continue;
        }
        this._selling.add(cid);
        this.sell(cid, 0)
          .catch(e => {
            const msg = String(e?.message || e);
            // "not found among your open positions" = contract already closed
            // server-side (subscription died before settlement echoed). The
            // local entry is stale; drop it so the stuck-check loop ends.
            const alreadyClosed = /not found among your open positions/i.test(msg);
            if (alreadyClosed) {
              log('WARN', `Force-sell #${cid} missed: contract already closed on server — dropping stale local entry`);
              if (info) {
                info.status = 'unknown';
                info.profit = 0;
                info.sellTime = Date.now() / 1000;
                info.currentSpot = info.currentSpot || 0;
                // Record as explicit 'unknown' so it is excluded from WR/streaks
                // (never fabricate a win/loss for an unconfirmable contract).
                this.positionHistory.push(info);
                this.emit('result', info);
              }
            } else {
              log('ERROR', `Force-sell #${cid} failed:`, msg);
            }
            // In both cases the local entry is gone; never retry forever.
            this._settledIds.add(cid);
            this.open.delete(cid);
            this._lastUpdateMap.delete(cid);
          })
          .finally(() => this._selling.delete(cid));
      }
    }
  }
}

// ── Helper functions ────────────────────────────────────────────────────
const utcDateStr = (d = new Date()) => d.toISOString().slice(0, 10);
const utcHour = (d = new Date()) => d.getUTCHours();
const money = (n, c = CONFIG.currency) => `${n >= 0 ? '+' : ''}${Number(n || 0).toFixed(2)} ${c}`;

// ── Enhanced Statistics Manager ─────────────────────────────────────────
class EnhancedStatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.dailySummaries = {};
    this.overallProfit = 0;
    this.currentLossStreak = 0;
    this.maxLossStreak = 0;
    this.lossStreakEvents = { x2: 0, x3: 0, x4: 0 };
    this.eodSentDates = [];
    this.assetStats = new Map();
    if (saved) this.load(saved);
  }

  load(s) {
    if (Array.isArray(s.trades)) this.trades = s.trades;
    if (s.dailySummaries) this.dailySummaries = s.dailySummaries;
    this.overallProfit = Number(s.overallProfit || 0);
    this.currentLossStreak = Number(s.currentLossStreak || 0);
    this.maxLossStreak = Number(s.maxLossStreak || 0);
    if (s.lossStreakEvents) {
      this.lossStreakEvents = {
        x2: Number(s.lossStreakEvents.x2 || 0),
        x3: Number(s.lossStreakEvents.x3 || 0),
        x4: Number(s.lossStreakEvents.x4 || 0)
      };
    }
    this.eodSentDates = Array.isArray(s.eodSentDates) ? s.eodSentDates : [];
    if (s.assetStats) {
      for (const [sym, data] of Object.entries(s.assetStats)) {
        this.assetStats.set(sym, data);
      }
    }
  }

  serialize() {
    const assetStats = {};
    for (const [sym, data] of this.assetStats.entries()) {
      assetStats[sym] = data;
    }
    return {
      trades: this.trades.slice(-5000),
      dailySummaries: this.dailySummaries,
      overallProfit: this.overallProfit,
      currentLossStreak: this.currentLossStreak,
      maxLossStreak: this.maxLossStreak,
      lossStreakEvents: this.lossStreakEvents,
      eodSentDates: this.eodSentDates.slice(-400),
      assetStats,
    };
  }

  record(trade) {
    const tsMs = Number(trade.sellTime || trade.buyTime || Date.now() / 1000) * 1000;
    const d = new Date(tsMs);
    const rec = {
      ...trade,
      timestamp: tsMs,
      date: utcDateStr(d),
      hour: utcHour(d)
    };
    this.trades.push(rec);
    this.overallProfit += Number(rec.profit || 0);

    // Phase 4: Track per-asset
    if (!this.assetStats.has(rec.symbol)) {
      this.assetStats.set(rec.symbol, { wins: 0, losses: 0, profit: 0, trades: [] });
    }
    const stats = this.assetStats.get(rec.symbol);
    if (rec.status === 'won') stats.wins++;
    else if (rec.status === 'lost') stats.losses++;
    // 'unknown' (unconfirmable) settlements are excluded from win/loss tallies.
    stats.profit += Number(rec.profit || 0);
    stats.trades.push(rec);
    if (stats.trades.length > 500) stats.trades.shift();

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

  todayTrades(date = utcDateStr()) {
    return this.trades.filter(t => t.date === date);
  }

  tradesForHour(date, hour) {
    return this.trades.filter(t => t.date === date && t.hour === hour);
  }

  stats(list) {
    const wins = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
    const decided = list.filter(t => t.status === 'won' || t.status === 'lost');
    const total = list.reduce((s, t) => s + Number(t.profit || 0), 0);
    const gw = wins.reduce((s, t) => s + Number(t.profit || 0), 0);
    const gl = Math.abs(losses.reduce((s, t) => s + Number(t.profit || 0), 0));
    return {
      count: list.length,
      wins: wins.length,
      losses: losses.length,
      winRate: decided.length ? wins.length / decided.length * 100 : 0,
      grossWin: gw,
      grossLoss: gl,
      totalProfit: total,
      profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
      stake: list.reduce((s, t) => s + Number(t.stake || 0), 0),
    };
  }

  // Phase 4: Get Sharpe-ranked assets
  getRankedAssets() {
    const assets = [];
    for (const [sym, data] of this.assetStats.entries()) {
      const sharpe = data.trades.length >= 5
        ? this._computeSharpe(data.trades)
        : 0;
      assets.push({
        symbol: sym,
        sharpe,
        winRate: data.wins / (data.wins + data.losses || 1) * 100,
        profit: data.profit
      });
    }
    return assets.sort((a, b) => b.sharpe - a.sharpe);
  }

  _computeSharpe(trades) {
    if (trades.length < 5) return 0;
    const profits = trades.map(t => t.profit || 0);
    const mean = profits.reduce((s, p) => s + p, 0) / profits.length;
    let variance = 0;
    for (const p of profits) variance += (p - mean) ** 2;
    const std = Math.sqrt(variance / profits.length) || 1e-12;
    return std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  }

  archiveDate(date) {
    const list = this.trades.filter(t => t.date === date);
    const s = this.stats(list);
    this.dailySummaries[date] = s;
    return { date, trades: list, stats: s };
  }

  markEodSent(date) {
    if (!this.eodSentDates.includes(date)) this.eodSentDates.push(date);
    this.eodSentDates = this.eodSentDates.slice(-400);
  }

  isEodSent(date) {
    return this.eodSentDates.includes(date);
  }
}

// ── Main Bot v5.0 ───────────────────────────────────────────────────────
class AccuPULSE3BotV5 {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = new DerivClient(cfg);
    this.market = new MarketDataManager(this.client, cfg);
    this.analyzer = new EnhancedARCAAnalyzer(cfg);
    this.exec = new EnhancedTradeExecutor(this.client, cfg);
    this.exec.market = this.market;
    this.exec.analyzer = this.analyzer;
    this.stats = new EnhancedStatisticsManager();

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
    this._metricsTimer = null;
    this._analysisInFlight = false;
    this.lastTradedSymbols = [];
    this._prevTopAsset = null;

    // Anti-Martingale
    this.winStreak = 0;
    this.lossStreak = 0;
    this.winStakeMultiplier = 1.0;

    // Drawdown
    this.equityPeak = 0;
    this.ddReducer = 1.0;

    // ── Feature 5: Warm-up Mode Lifecycle ──────────────────────────────
    this.tradeCount = 0;
    this.currentMode = 'WARMUP';
    this._modeChanged = false;

    // ── Feature 6: Enhanced Streak Recovery ─────────────────────────────
    this.recoveryMode = false;
    this.recoveryStartTime = 0;
    this.recoveryWins = 0;

    // ── Feature 7: Metrics Logging ──────────────────────────────────────
    this._metricsCycleCount = 0;
    this._metricsBuffer = [];
  }

  // ── Feature 5: Get current mode and its parameters ─────────────────────
  getMode() {
    const wc = this.cfg.warmupConfig || {};
    if (this.tradeCount < wc.warmupTrades) return 'WARMUP';
    if (this.tradeCount < wc.balancedTrades) return 'BALANCED';
    return 'OPTIMIZED';
  }

  getModeConfig() {
    const mode = this.currentMode;
    const wc = this.cfg.warmupConfig || {};
    switch (mode) {
      case 'WARMUP':
        return {
          minConfidence: 0.01,
          maxVolRegime: 3,
          maxOpen: wc.warmupMaxOpen || 5,
          useAllAssets: true,
          label: '🔥 WARMUP (0-30 trades)',
        };
      case 'BALANCED':
        return {
          minConfidence: 0.05,
          maxVolRegime: 2,
          maxOpen: wc.balancedMaxOpen || 3,
          useAllAssets: false,
          label: '⚖️ BALANCED (30-300 trades)',
        };
      case 'OPTIMIZED':
        return {
          minConfidence: 0.08,
          maxVolRegime: 1,
          maxOpen: wc.optimizedMaxOpen || 2,
          useAllAssets: false,
          label: '🎯 OPTIMIZED (300+ trades)',
        };
    }
  }

  // ── Feature 1: Get adaptive confidence threshold ───────────────────────
  getMinConfidence(volRegime) {
    const thresholds = this.cfg.minConfidenceByRegime || {};
    const threshold = thresholds[volRegime] !== undefined
      ? thresholds[volRegime]
      : this.cfg.minConfidence;
    return threshold;
  }

  // ── Feature 6: Enhanced Streak Recovery ────────────────────────────────
  updateRecovery() {
    const rc = this.cfg.recoveryConfig || {};

    if (this.lossStreak >= rc.triggerLosses && !this.recoveryMode) {
      this.recoveryMode = true;
      this.recoveryStartTime = Date.now();
      this.recoveryWins = 0;
      log('WARN', `🔄 Recovery mode activated: loss streak ${this.lossStreak}`);
      telegram.send(
        `🔄 <b>AccuPULSE3_v5 Recovery mode activated</b>\n` +
        `Loss streak: ${this.lossStreak}\n` +
        `Stake: ${((rc.recoveryMinStake || 0.40) * 100).toFixed(0)}% of base\n` +
        `Graduated return based on win rate`
      );
    }

    if (this.recoveryMode) {
      // Exit conditions
      if (this.recoveryWins >= (rc.recoveryExitWins || 10)) {
        this.recoveryMode = false;
        log('INFO', '✅ Recovery mode exited: 10 wins achieved');
        telegram.send('✅ <b>AccuPULSE3_v5 Recovery mode exited</b>\n10 wins achieved');
        return;
      }
      if (Date.now() - this.recoveryStartTime > (rc.recoveryExitHours || 2) * 3600_000) {
        this.recoveryMode = false;
        log('INFO', '✅ Recovery mode exited: time limit reached');
        telegram.send('✅ <b>AccuPULSE3_v5 Recovery mode exited</b>\nTime limit reached');
        return;
      }
    }
  }

  getRecoveryStakeMultiplier() {
    if (!this.recoveryMode) return 1.0;
    const rc = this.cfg.recoveryConfig || {};

    // Calculate recent win rate
    const recentTrades = this.stats.trades.slice(-20);
    if (recentTrades.length < 5) return rc.recoveryMinStake || 0.40;

    const wins = recentTrades.filter(t => t.status === 'won').length;
    const decidedCount = recentTrades.filter(t => t.status === 'won' || t.status === 'lost').length;
    const wr = decidedCount > 0 ? wins / decidedCount : 0;

    let mult = rc.recoveryMinStake || 0.40;
    if (wr > (rc.wrThresholdNormal || 0.70)) mult = rc.recoveryMaxStake || 1.00;
    else if (wr > (rc.wrThresholdMedium || 0.60)) mult = 0.80;
    else if (wr > (rc.wrThresholdLow || 0.50)) mult = 0.60;

    return mult;
  }

  // ── Feature 4: 4-Tier Exit Strategy ────────────────────────────────────
  getTieredTargets(stake, analysis) {
    const tiers = this.cfg.tp_tiers || {};
    const baseTP = analysis?.model?.conservativeEV
      ? stake * Math.max(0.10, Math.min(0.50, analysis.model.conservativeEV * 4))
      : stake * 0.20;

    return {
      quick_win:  { ticks: tiers.quick_win?.ticks || 3,  profit_target: baseTP * (tiers.quick_win?.profit_pct || 0.15) * 4, scale_out: tiers.quick_win?.scale_out || 0.30 },
      early_win:  { ticks: tiers.early_win?.ticks || 8,  profit_target: baseTP * (tiers.early_win?.profit_pct || 0.25) * 4, scale_out: tiers.early_win?.scale_out || 0.30 },
      mid_win:    { ticks: tiers.mid_win?.ticks || 15,   profit_target: baseTP * (tiers.mid_win?.profit_pct || 0.35) * 4, scale_out: tiers.mid_win?.scale_out || 0.30 },
      full_hold:  { ticks: tiers.full_hold?.ticks || 20, profit_target: baseTP * (tiers.full_hold?.profit_pct || 0.50) * 4, scale_out: tiers.full_hold?.scale_out || 0.00 },
    };
  }

  // ── Feature 7: Log metrics to JSONL file ───────────────────────────────
  logMetrics(cycleData) {
    try {
      const line = JSON.stringify(cycleData) + '\n';
      fs.appendFileSync(CONFIG.metricsFileV5, line);
    } catch (e) {
      log('WARN', 'Metrics log failed:', e.message);
    }
  }

  // ── Bot Lifecycle ──────────────────────────────────────────────────────
  async start() {
    log('INFO', '═══════════════════════════════════════════');
    log('INFO', '  AccuPULSE3 v5.0 — Enhanced Production Build');
    log('INFO', '═══════════════════════════════════════════');
    log('INFO', `Assets: ${this.cfg.assets.join(', ')}`);
    log('INFO', `Features: 1-AdaptiveGates 2-6FactorSizing 3-6CheckEntry 4-4TierExit 5-WarmupMode 6-StreakRecovery 7-MetricsLogging`);

    if (!this.cfg.apiToken) {
      log('ERROR', 'API token missing');
      process.exit(1);
    }

    this.client.on('authorized', info => this._onAuthorized(info));
    this.client.on('close', (c, r, was) => this._onDisconnected(c, r, was));
    this.exec.on('open', t => this._onTradeOpen(t));
    this.exec.on('update', t => this._onTradeUpdate(t));
    this.exec.on('result', t => this._onTradeResult(t));
    this.exec.on('recovered', t => log('WARN', `Recovered open contract #${t.contractId}`));

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
      this._hourlyBoot = setTimeout(() => {
        this._sendHourly();
        this._hourlyT = setInterval(() => this._sendHourly(), 3600_000);
      }, Math.max(1000, msToNextHour));
    }
    const scheduleNextEod = () => {
      const { h, min } = (() => {
        const m = String(this.cfg.eodTimeGmt || '00:00').match(/^(\d{1,2}):(\d{2})$/);
        return m ? { h: +m[1], min: +m[2] } : { h: 0, min: 0 };
      })();
      const target = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        h, min,
        this.cfg.eodSendDelaySeconds, 0
      ));
      if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
      const delay = target.getTime() - now.getTime();
      this._eodBoot = setTimeout(() => {
        this._sendEod('scheduled');
        scheduleNextEod();
      }, delay);
    };
    scheduleNextEod();
  }

  async _onAuthorized(info) {
    if (this.cfg.demoOnly && !info.isVirtual) {
      log('ERROR', 'demoOnly is enabled; refusing non-demo account');
      this.stopped = true;
      telegram.send('AccuPULSE3_v5 STOPPED: demoOnly is enabled but the authorized account is not virtual.');
      this.client.stop();
      return;
    }
    this.startBalance ??= this.client.balance;
    this.lastBalance = this.client.balance ?? this.lastBalance ?? this.startBalance;
    this.equityPeak = Math.max(this.equityPeak || 0, this.lastBalance || 0);

    telegram.send(
      `🤖 <b>AccuPULSE3 v5.0 Online</b>\n\n` +
      `👤 <b>Account:</b> ${info.loginid}\n` +
      `💼 <b>Type:</b> ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 <b>Balance:</b> ${this.startBalance.toFixed(2)} ${this.currencyStr()}\n` +
      `📊 <b>Assets:</b> ${this.cfg.assets.join(', ')}\n` +
      `💵 <b>Base Stake:</b> ${this.cfg.baseStake}\n` +
      `📈 <b>Growth:</b> ${(this.cfg.growthRate * 100).toFixed(0)}%\n\n` +
      `✨ <b>v5.0 Enhanced Features</b>\n` +
      `• <b>✅ Adaptive Confidence Gates</b> (by vol regime)\n` +
      `• <b>✅ 6-Factor Dynamic Stake Sizing</b>\n` +
      `• <b>✅ 6-Check Entry Confirmation</b>\n` +
      `• <b>✅ 4-Tier Exit Strategy</b>\n` +
      `• <b>✅ Warm-up Mode Lifecycle</b>\n` +
      `• <b>✅ Enhanced Streak Recovery</b>\n` +
      `• <b>✅ Full Metrics Logging</b>\n` +
      `• <b>✅ Asymmetric hazard analysis</b>\n` +
      `• <b>✅ Asset Sharpe ranking</b>`
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
    this._stuckCheckTimer = setInterval(() => this.exec.checkStuckContracts(180000), 30000);

    if (this._metricsTimer) clearInterval(this._metricsTimer);
    this._metricsTimer = setInterval(() => this._updateMetrics(), 60000);
  }

  _onDisconnected(code, reason, wasAuth) {
    if (this._stuckCheckTimer) clearInterval(this._stuckCheckTimer);
    if (this._metricsTimer) clearInterval(this._metricsTimer);
    telegram.send(`⚠️ <b>AccuPULSE3_v5 Connection lost</b>\ncode: <code>${code}</code>\nwas auth: ${wasAuth ? 'yes' : 'no'}\n🔄 reconnecting…`);
    if (this._analysisT) {
      clearInterval(this._analysisT);
      this._analysisT = null;
    }
  }

  _onTradeOpen(t) {
    this.tradeStartTime = Date.now();
    const a = t._analysis;
    let msg =
      `🟢 <b>AccuPULSE3_v5 TRADE OPENED</b>\n\n` +
      `🎫 <b>#</b>${t.contractId}\n` +
      `📊 <code>${t.symbol}</code>\n` +
      `📈 Growth: ${(t.growthRate * 100).toFixed(0)}%\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currencyStr()}\n` +
      `🎯 TP: ${t.limit.take_profit ?? '–'}\n` +
      `🏷️ Mode: ${this.currentMode}\n`;
    if (a) {
      msg += `\n🧠 <b>Analysis</b>\n` +
        `• Score: <b>${a.score.toFixed(3)}</b>\n` +
        `• Vol: ${a.volRegimeLabel}\n` +
        `• Trend: ${a.trendDirection}\n` +
        `• Regime Score: ${a.regimeScore.toFixed(2)}\n` +
        `• Asymmetry: ${a.asymmetry}\n` +
        `• Hurst: ${a.hurst.toFixed(2)}`;
    }
    if (this.winStakeMultiplier > 1) {
      msg += `\n📈 Win streak ×${this.winStakeMultiplier.toFixed(2)}`;
    }
    if (this.recoveryMode) {
      msg += `\n🔄 Recovery mode: ${(this.getRecoveryStakeMultiplier() * 100).toFixed(0)}% stake`;
    }
    telegram.send(msg);
  }

  _onTradeUpdate(t) {
    log('DEBUG', `Update #${t.contractId}: profit=${t.profit.toFixed(3)} spot=${t.currentSpot}`);
  }

  _onTradeResult(t) {
    this.tradeStartTime = null;
    // Unknown (unconfirmable) settlements don't advance the warm-up lifecycle.
    if (t.status !== 'unknown') this.tradeCount++;
    const rec = this.stats.record(t);

    // ── Feature 5: Check mode transition ──────────────────────────────
    const newMode = this.getMode();
    if (newMode !== this.currentMode) {
      this._modeChanged = true;
      const oldMode = this.currentMode;
      this.currentMode = newMode;
      const modeConfig = this.getModeConfig();
      log('INFO', `🏷️ Mode transition: ${oldMode} → ${newMode}`);
      telegram.send(`🏷️ <b>Mode transition</b>\n${oldMode} → ${newMode}\n${modeConfig.label}`);
    }

    // ── Feature 6: Track recovery wins ─────────────────────────────────
    if (this.recoveryMode && t.status === 'won') {
      this.recoveryWins++;
    }

    // Phase 1: Record trade for win-rate grid
    const volRegime = this.exec._lastVolRegime || 'normal';
    const trendDirection = this.exec._lastTrend || 'neutral';
    const hour = new Date(t.sellTime * 1000).getUTCHours();
    this.analyzer.recordTrade(
      t.symbol, t.growthRate, volRegime, trendDirection, hour, t.profit, t.payout
    );

    // Phase 4: Update asset Sharpe
    this.analyzer.updateAssetSharpe(t.symbol, this.stats.trades);

    const emoji = t.status === 'won' ? '✅' : (t.status === 'unknown' ? '❓' : '❌');
    const dur = Math.max(0, (t.sellTime || Date.now() / 1000) - (t.buyTime || 0));
    this.lastBalance = (this.lastBalance ?? 0) + t.profit;
    this.overallProfit += t.profit;

    if (this.lastBalance > this.equityPeak) this.equityPeak = this.lastBalance;

    if (t.status === 'unknown') {
      // Unconfirmable settlement (e.g. subscription died before server echoed
      // close). Excluded from win/loss streaks — never fabricate a result.
      log('WARN', `Trade #${t.contractId} settled as UNKNOWN — excluded from WR/streaks`);
    } else if (t.status === 'won') {
      this.winStreak++;
      this.lossStreak = 0;
      if (this.winStreak >= this.cfg.winsBeforeScaling) {
        this.winStakeMultiplier = Math.min(
          this.cfg.maxWinStakeMultiplier,
          1 + (this.winStreak - this.cfg.winsBeforeScaling + 1) * (this.cfg.winStakeMultiplier - 1)
        );
      }
    } else {
      this.lossStreak++;
      this.winStreak = 0;
      this.winStakeMultiplier = 1.0;
    }

    this._updateDrawdown();
    // ── Feature 6: Update recovery mode ────────────────────────────────
    this.updateRecovery();

    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));
    let msg =
      ` AccuPULSE3_v5 ${emoji} <b>TRADE ${t.status === 'won' ? 'WON' : (t.status === 'unknown' ? 'UNKNOWN' : 'LOST')}</b>\n\n` +
      `🎫 #${t.contractId} | ${t.symbol}\n` +
      `💵 Stake: ${t.stake.toFixed(2)} | P/L: ${money(t.profit, this.currencyStr())}\n` +
      `⏱️ Duration: ${dur.toFixed(1)}s\n` +
      `💼 Balance: ${this.lastBalance.toFixed(2)} ${this.currencyStr()}\n` +
      `🏷️ Mode: ${this.currentMode}\n\n` +
      `📅 <b>Today</b> (${rec.date})\n` +
      `• ${todayStats.count} trades | WR: ${todayStats.winRate.toFixed(1)}%\n` +
      `• P/L: ${money(todayStats.totalProfit, this.currencyStr())} | PF: ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n` +
      `💼 Overall: ${money(this.overallProfit, this.currencyStr())}`;
    if (this.lossStreak > 0) msg += `\n❌ Loss streak: ${this.lossStreak}`;
    if (this.recoveryMode) msg += `\n🔄 Recovery: ${this.recoveryWins}/${this.cfg.recoveryConfig?.recoveryExitWins || 10} wins`;
    telegram.send(msg);
    this.lastTradeAt = Date.now();

    if (this._checkCircuitBreakers()) {
      this.stopped = true;
      telegram.send(`🛑 <b>AccuPULSE3_v5 Bot stopped</b> — circuit breaker`);
    }
    this._saveState('after-trade');
  }

  // ── Feature 6: Enhanced Streak Recovery (replaces v4.0 hard pause) ────
  _updateStreakRecovery() {
    // v5.0 uses the graduated recovery system instead of hard pause
    // This is a no-op - the recovery logic is in updateRecovery() and getRecoveryStakeMultiplier()
  }

  _isPausedByStreak() {
    // v5.0: No hard pause - graduated recovery instead
    return false;
  }

  // Time-of-Day Limits
  _getTimeOfDayLimit(hour) {
    return this.cfg.timeOfDayLimits[hour] || { maxStake: 1.0, tpMult: 1.0 };
  }

  // ── Feature 2 + 6: Current stake with v5.0 multi-factor sizing ────────
  currentStake(compositeScore, volRegime, volHurst, recentWinRate = 0.5) {
    let base = this.cfg.baseStake * this.winStakeMultiplier * this.ddReducer;

    // Mode-based max open trades override
    const modeConfig = this.getModeConfig();
    this.cfg = Object.assign({}, this.cfg, { maxOpenTrades: modeConfig.maxOpen });

    // v5.0: 6-factor dynamic sizing
    const kellyEdge = this.exec.computeKellyEdge(this.exec.positionHistory);
    const balance = this.lastBalance ?? this.startBalance ?? 0;
    const dynamicStake = this.exec.computeStakeV2(
      balance,
      this.equityPeak,
      base,
      compositeScore,
      volRegime,
      recentWinRate,
      this.lossStreak,
      kellyEdge
    );

    // ── Feature 6: Apply recovery stake multiplier ─────────────────────
    const recoveryMult = this.getRecoveryStakeMultiplier();
    let stake = dynamicStake * recoveryMult;

    // Time-of-day limit
    const hour = new Date().getUTCHours();
    const timeLimits = this._getTimeOfDayLimit(hour);
    const finalStake = Math.min(stake, this.cfg.baseStake * timeLimits.maxStake);

    return +finalStake.toFixed(2);
  }

  _updateDrawdown() {
    const bal = this.lastBalance ?? this.startBalance ?? 0;
    if (bal > this.equityPeak) this.equityPeak = bal;
    const dd = this.equityPeak > 0 ? (this.equityPeak - bal) / this.equityPeak : 0;
    // v5.0: Enhanced DD brake levels matching the 6-factor sizing
    if (dd <= 0.05) this.ddReducer = 1.0;
    else if (dd <= 0.10) this.ddReducer = 0.75;
    else if (dd <= 0.20) this.ddReducer = 0.50;
    else this.ddReducer = 0.25;
  }

  _checkCircuitBreakers() {
    const today = this.stats.todayTrades();
    const pl = today.reduce((s, t) => s + (t.profit || 0), 0);
    if (pl >= 5000) { log('WARN', `AccuPULSE3_v5 Session profit limit`); return true; }
    if (pl <= -this.cfg.dailyMaxLoss) { telegram.send(`🛑 AccuPULSE3_v5 Daily loss limit`); return true; }
    if (today.length >= this.cfg.dailyMaxTrades) { telegram.send(`🛑 AccuPULSE3_v5 Daily trade limit`); return true; }
    const dd = this.equityPeak > 0 ? (this.equityPeak - (this.lastBalance ?? 0)) / this.equityPeak : 0;
    if (dd > 0.50) { telegram.send(`🛑 AccuPULSE3_v5 DD limit (50%)`); return true; }
    if (this.lossStreak >= this.cfg.streakStopDay) { telegram.send(`🛑 AccuPULSE3_v5 Loss streak limit`); return true; }
    return false;
  }

  async _analyzeAndTrade() {
    if (this._analysisInFlight) return;
    this._analysisInFlight = true;
    try {
      if (this.stopped || !this.client.authorized) return;
      if (!this.cfg.tradeEnabled) return;
      if (this._checkCircuitBreakers()) { this.stopped = true; return; }

      // ── Feature 5: Update mode ───────────────────────────────────────
      this.currentMode = this.getMode();
      const modeConfig = this.getModeConfig();

      const timeSinceLastTrade = Date.now() - this.lastTradeAt;
      if (timeSinceLastTrade < this.cfg.tradeCooldownMs) {
        log('DEBUG', `Cooldown active: ${(this.cfg.tradeCooldownMs - timeSinceLastTrade).toFixed(0)}ms remaining`);
        return;
      }

      if (this.exec.count() >= modeConfig.maxOpen) return;

      // Phase 4: Rank assets by Sharpe
      const rankedAssets = this.stats.getRankedAssets();
      const topAssets = rankedAssets.slice(0, 3).map(a => a.symbol);

      const analyses = this.cfg.assets.flatMap(sym => {
        // ── Feature 5: During warmup, use ALL assets ────────────────────
        if (!modeConfig.useAllAssets && topAssets.length > 0 && !topAssets.includes(sym) && this.stats.trades.length > 50) {
          return [];
        }

        return this.cfg.candidateGrowthRates.map(rate => {
          const barrier = this.market.getBarrier(sym, rate);
          const stayData = this.market.getStays(sym, rate);
          const ticks = this.market.historyFor(sym);
          return this.analyzer.analyze(sym, ticks, barrier, rate, stayData);
        });
      });

      const ranked = this.analyzer.rank(analyses);
      if (!ranked.length) {
        let rejectionReasons = { ev_fail: 0, barrier_fail: 0, ticks_fail: 0, jump_fail: 0, other_fail: 0 };
        for (const a of analyses) {
          if (!a.eligible) {
            const reason = a.reasons?.[0] || 'UNKNOWN';
            if (reason.includes('EV_BELOW_HAIRCUT')) rejectionReasons.ev_fail++;
            else if (reason.includes('NO_VERIFIED_BARRIER')) rejectionReasons.barrier_fail++;
            else if (reason.includes('INSUFFICIENT_TICKS')) rejectionReasons.ticks_fail++;
            else if (reason.includes('RECENT_JUMP')) rejectionReasons.jump_fail++;
            else rejectionReasons.other_fail++;
          }
        }
        log('WARN', `ZERO candidates passed. Funnel: analyzed=${analyses.length} ev=${rejectionReasons.ev_fail} barrier=${rejectionReasons.barrier_fail} ticks=${rejectionReasons.ticks_fail} jump=${rejectionReasons.jump_fail} other=${rejectionReasons.other_fail}`);

        // ── Feature 7: Log metrics even when no candidates ──────────────
        this._metricsCycleCount++;
        this.logMetrics({
          cycle: this._metricsCycleCount,
          timestamp: Date.now(),
          total_candidates: analyses.length,
          passed_ev_gate: 0,
          passed_confidence_gate: 0,
          passed_vol_gate: 0,
          passed_hurst_gate: 0,
          best_symbol: null,
          best_score: null,
          best_ev: null,
          best_vol_regime: null,
          decision: 'SKIP',
          open_trades: this.exec.count(),
          balance: this.lastBalance,
          win_streak: this.winStreak,
          loss_streak: this.lossStreak,
          mode: this.currentMode,
          recovery_active: this.recoveryMode,
          skip_reason: 'NO_CANDIDATES',
          funnel: rejectionReasons,
        });
        return;
      }

      let best = null;
      for (const cand of ranked) {
        if (this.cfg.skipRecentTradedSymbols && this.lastTradedSymbols.includes(cand.symbol)) {
          log('DEBUG', `Recently traded ${cand.symbol} — skipping`);
          continue;
        }

        // ── Feature 1: Adaptive confidence gate ─────────────────────────
        const adaptiveMinConfidence = this.getMinConfidence(cand.volRegime);
        if (cand.score < adaptiveMinConfidence) {
          log('DEBUG', `Confidence ${cand.score.toFixed(3)} < adaptive min ${adaptiveMinConfidence.toFixed(3)} (regime ${cand.volRegime}) — skip`);
          continue;
        }

        // ── Feature 5: Mode-based vol regime gate ───────────────────────
        if (cand.volRegime > modeConfig.maxVolRegime) {
          log('DEBUG', `Vol regime ${cand.volRegime} > mode max ${modeConfig.maxVolRegime} — skip`);
          continue;
        }

        if (cand.hurst > this.cfg.maxHurst) {
          log('DEBUG', `Hurst ${cand.hurst.toFixed(2)} > max — skip`);
          continue;
        }

        // Phase 4: Correlation check
        if (!this.exec.checkCorrelationWithOpen(cand.symbol)) {
          log('DEBUG', `Correlation check failed for ${cand.symbol}`);
          continue;
        }

        best = cand;
        break;
      }
      if (!best) {
        log('DEBUG', 'No candidate passed all gates');
        return;
      }

      log('INFO', `Best candidate: ${best.symbol} score=${best.score.toFixed(3)} [${best.reasons.join(', ')}]`);

      this.lastTradedSymbols.push(best.symbol);
      if (this.lastTradedSymbols.length > this.cfg.recentTradedSymbolsLen) {
        this.lastTradedSymbols.shift();
      }

      const growthRate = best.suggestedGrowth;
      const recentWinRate = this.stats.trades.length >= 10
        ? this.stats.trades.slice(-50).filter(t => t.status === 'won').length /
          Math.max(1, this.stats.trades.slice(-50).filter(t => t.status === 'won' || t.status === 'lost').length)
        : 0.5;

      // ── Feature 2 + 6: Dynamic stake with recovery ───────────────────
      const stake = this.currentStake(best.score, best.volRegime, best.hurst, recentWinRate);

      // ── Feature 4: 4-tier exit targets ───────────────────────────────
      const tiers = this.getTieredTargets(stake, best);
      const hour = new Date().getUTCHours();
      const timeLimits = this._getTimeOfDayLimit(hour);
      const tp = +(stake * Math.max(0.10, Math.min(0.50, best.model.conservativeEV * 4)) * timeLimits.tpMult).toFixed(2);

      // ── Feature 3: 6-check entry confirmation ─────────────────────────
      const ticks = this.market.historyFor(best.symbol);
      const entryCheck = this.exec.confirmEntry(best.symbol, best, ticks, { contract_details: { tick_size_barrier_percentage: best.model?.barrierPct } });

      if (!entryCheck.approved) {
        log('WARN', `Entry confirmation FAILED for ${best.symbol}: ${entryCheck.passed}/${entryCheck.required} checks passed`);
        // Log rejected entry to metrics
        this._metricsCycleCount++;
        this.logMetrics({
          cycle: this._metricsCycleCount,
          timestamp: Date.now(),
          total_candidates: analyses.length,
          passed_ev_gate: analyses.filter(a => a?.model?.conservativeEV >= this.cfg.minNetEvRatio).length,
          passed_confidence_gate: analyses.filter(a => a?.score >= this.getMinConfidence(a?.volRegime)).length,
          passed_vol_gate: analyses.filter(a => a?.volRegime <= modeConfig.maxVolRegime).length,
          passed_hurst_gate: analyses.filter(a => a?.hurst <= this.cfg.maxHurst).length,
          best_symbol: best.symbol,
          best_score: best.score,
          best_ev: best.model?.conservativeEV,
          best_vol_regime: best.volRegimeLabel,
          decision: 'SKIP',
          open_trades: this.exec.count(),
          balance: this.lastBalance,
          win_streak: this.winStreak,
          loss_streak: this.lossStreak,
          mode: this.currentMode,
          recovery_active: this.recoveryMode,
          skip_reason: 'ENTRY_CONFIRMATION_FAILED',
          entry_checks: entryCheck.details,
        });
        return;
      }

      log('INFO', `Entry confirmation PASSED for ${best.symbol}: ${entryCheck.passed}/${entryCheck.required} checks`);

      const analysis = {
        score: best.score,
        volRegimeLabel: best.volRegimeLabel,
        trendDirection: best.trendDirection,
        regimeScore: best.regimeScore,
        asymmetry: best.asymmetry,
        hurst: best.hurst,
        pSurvival: best.pSurvival,
        reasons: best.reasons,
        tiers,
      };

      const trade = await this.exec.buy(
        best.symbol,
        growthRate,
        stake,
        { take_profit: tp, stop_loss: this.cfg.stopLoss },
        analysis,
        proposal => this.analyzer.evaluateProposal(this.market.historyFor(best.symbol), growthRate, proposal)
      );
      log('INFO', `Trade #${trade.contractId} ${best.symbol} stake=${stake} tp=${tp}`);

      // ── Feature 7: Log metrics for successful trade ───────────────────
      this._metricsCycleCount++;
      this.logMetrics({
        cycle: this._metricsCycleCount,
        timestamp: Date.now(),
        total_candidates: analyses.length,
        passed_ev_gate: analyses.filter(a => a?.model?.conservativeEV >= this.cfg.minNetEvRatio).length,
        passed_confidence_gate: analyses.filter(a => a?.score >= this.getMinConfidence(a?.volRegime)).length,
        passed_vol_gate: analyses.filter(a => a?.volRegime <= modeConfig.maxVolRegime).length,
        passed_hurst_gate: analyses.filter(a => a?.hurst <= this.cfg.maxHurst).length,
        best_symbol: best.symbol,
        best_score: best.score,
        best_ev: best.model?.conservativeEV,
        best_vol_regime: best.volRegimeLabel,
        decision: 'TRADE',
        open_trades: this.exec.count(),
        balance: this.lastBalance,
        win_streak: this.winStreak,
        loss_streak: this.lossStreak,
        mode: this.currentMode,
        recovery_active: this.recoveryMode,
        entry_checks: entryCheck.details,
        contract_id: trade.contractId,
        stake: stake,
        take_profit: tp,
        tiers: tiers,
      });

      log('INFO', `Analysis funnel: candidates=${analyses.length} → ranked=${ranked.length} → best=${best.symbol} score=${best.score.toFixed(3)}`);

      // Phase 4: Alert on asset rotation
      const newTopAsset = rankedAssets[0]?.symbol;
      if (this._prevTopAsset !== newTopAsset) {
        telegram.send(`📊 <b>AccuPULSE3_v5 Asset Rotation</b>\n${this._prevTopAsset || '—'} → ${newTopAsset}`);
        this._prevTopAsset = newTopAsset;
      }
    } catch (e) {
      log('ERROR', 'ARCA error:', e.message);
    } finally {
      this._analysisInFlight = false;
    }
  }

  _isPausedNow() {
    const now = new Date();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const asMinutes = value => {
      const m = String(value).match(/^(\d{1,2}):(\d{2})$/);
      return m ? +m[1] * 60 + +m[2] : null;
    };
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
      log('DEBUG', 'Barriers refreshed');
    } catch (e) {
      log('DEBUG', 'Barrier refresh:', e.message);
    }
  }

  _sendHourly() {
    const now = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const date = utcDateStr(prev), hour = utcHour(prev);
    const list = this.stats.tradesForHour(date, hour);
    const s = this.stats.stats(list);
    if (!list.length) {
      telegram.send(`⏰ <b>AccuPULSE3_v5 ${date} ${pad(hour)}:00</b> — No trades`);
      return;
    }
    let msg = `⏰ <b>AccuPULSE3_v5 ${date} ${pad(hour)}:00</b>\n📊 ${s.count} trades | WR ${s.winRate.toFixed(1)}%\n💰 ${money(s.totalProfit, this.currencyStr())}\n`;
    list.slice(-10).forEach((t, i) => {
      msg += `${i + 1}. ${t.status === 'won' ? '✅' : '❌'} ${t.symbol} ${money(t.profit, this.currencyStr())}\n`;
    });
    telegram.send(msg);
  }

  _sendEod(reason = 'manual') {
    const date = utcDateStr(new Date(Date.now() - 86_400_000));
    if (this.stats.isEodSent(date) && reason === 'scheduled') return;
    const summary = this.stats.archiveDate(date);
    const ds = summary.stats;
    const rankedAssets = this.stats.getRankedAssets();
    let msg = `🌙 <b>AccuPULSE3_v5 DAILY REPORT — ${date}</b>\n\n`;
    if (ds.count) {
      msg += `📊 ${ds.count} trades | WR ${ds.winRate.toFixed(1)}% | PF ${ds.profitFactor.toFixed(2)}\n💰 Net: ${money(ds.totalProfit, this.currencyStr())}\n`;
    } else {
      msg += `No trades.\n`;
    }
    msg += `\n💼 Overall: ${money(this.overallProfit, this.currencyStr())}\n`;
    msg += `🏷️ Mode: ${this.currentMode} (${this.tradeCount} trades)\n`;
    if (this.recoveryMode) msg += `🔄 Recovery active: ${this.recoveryWins} wins\n`;
    msg += `\n📈 <b>Top Assets (Sharpe)</b>\n`;
    rankedAssets.slice(0, 3).forEach((a, i) => {
      msg += `${i + 1}. ${a.symbol} (Sharpe: ${a.sharpe.toFixed(2)}) WR: ${a.winRate.toFixed(1)}%\n`;
    });
    telegram.send(msg);
    this.stats.markEodSent(date);
    this._saveState(`eod-${reason}`);
  }

  // Metrics Dashboard
  _updateMetrics() {
    try {
      const metrics = {
        timestamp: Date.now(),
        balance: this.lastBalance,
        openTrades: this.exec.count(),
        todayP_L: this.stats.todayTrades().reduce((s, t) => s + t.profit, 0),
        winStreak: this.winStreak,
        lossStreak: this.lossStreak,
        sharpeTop3: this.stats.getRankedAssets().slice(0, 3),
        ddReducer: this.ddReducer,
        paused: false,
        equityPeak: this.equityPeak,
        drawdown: this.equityPeak > 0 ? (this.equityPeak - (this.lastBalance || 0)) / this.equityPeak : 0,
        lastTradeAt: this.lastTradeAt,
        overallProfit: this.overallProfit,
        // v5.0 additions
        mode: this.currentMode,
        tradeCount: this.tradeCount,
        recoveryActive: this.recoveryMode,
        recoveryWins: this.recoveryWins,
      };
      fs.writeFileSync(CONFIG.metricsFile, JSON.stringify(metrics, null, 2));
    } catch (e) {
      log('WARN', 'Metrics update failed:', e.message);
    }
  }

  currencyStr() {
    return this.client.currency || this.cfg.currency;
  }

  _saveState(reason = 'checkpoint') {
    try {
      const payload = {
        version: 5.0,
        engine: 'ARCA-V5-ENHANCED',
        savedAt: new Date().toISOString(),
        savedReason: reason,
        startBalance: this.startBalance,
        lastBalance: this.lastBalance,
        overallProfit: this.overallProfit,
        winStreak: this.winStreak,
        lossStreak: this.lossStreak,
        winStakeMultiplier: this.winStakeMultiplier,
        equityPeak: this.equityPeak,
        ddReducer: this.ddReducer,
        stats: this.stats.serialize(),
        // v5.0 additions
        tradeCount: this.tradeCount,
        currentMode: this.currentMode,
        recoveryMode: this.recoveryMode,
        recoveryStartTime: this.recoveryStartTime,
        recoveryWins: this.recoveryWins,
      };
      const tmp = this.cfg.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.cfg.stateFile);
    } catch (e) {
      log('WARN', 'State save failed:', e.message);
    }
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
      // v5.0 state restoration
      if (d.tradeCount != null) this.tradeCount = d.tradeCount;
      if (d.currentMode != null) this.currentMode = d.currentMode;
      if (d.recoveryMode != null) this.recoveryMode = d.recoveryMode;
      if (d.recoveryStartTime != null) this.recoveryStartTime = d.recoveryStartTime;
      if (d.recoveryWins != null) this.recoveryWins = d.recoveryWins;
      this.stats = new EnhancedStatisticsManager(d.stats || {});
      log('INFO', `State restored: overall=${this.overallProfit.toFixed(2)} mode=${this.currentMode} trades=${this.tradeCount}`);
    } catch (e) {
      log('WARN', 'State load failed:', e.message);
    }
  }

  stop(signal) {
    if (this.stopped) return;
    this.stopped = true;
    if (this._stuckCheckTimer) clearInterval(this._stuckCheckTimer);
    if (this._metricsTimer) clearInterval(this._metricsTimer);
    log('INFO', `Stopping (${signal})`);
    telegram.send(`🛑 <b>AccuPULSE3_v5 stopped</b>\nSignal: ${signal}`);
    if (this._analysisT) clearInterval(this._analysisT);
    if (this._hourlyT) clearInterval(this._hourlyT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._eodBoot) clearTimeout(this._eodBoot);
    if (this._barrierT) clearInterval(this._barrierT);

    const today = this.stats.todayTrades();
    const s = this.stats.stats(today);
    telegram.send(
      `🌙 <b>AccuPULSE3_v5 SESSION END</b>\n` +
      `📊 ${s.count} trades | WR ${s.winRate.toFixed(1)}%\n` +
      `💰 ${money(s.totalProfit, this.currencyStr())}\n` +
      `🏷️ Mode: ${this.currentMode} (${this.tradeCount} trades)\n` +
      `💼 Overall: ${money(this.overallProfit, this.currencyStr())}`
    );

    this._saveState('shutdown');
    this.client.stop();
    setTimeout(() => process.exit(0), 2500);
  }
}

// ── Main ────────────────────────────────────────────────────────────────
function main() {
  const bot = new AccuPULSE3BotV5(CONFIG);
  bot.start().catch(e => {
    log('ERROR', 'Fatal error:', e);
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  AccuPULSE3BotV5,
  EnhancedARCAAnalyzer,
  EnhancedTradeExecutor,
  CONFIG
};
