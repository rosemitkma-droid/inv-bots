// ============================================================================
// DERIV RISE/FALL TRADING BOT v4.3 — RNG MEAN-REVERSION OPTIMIZED
// Single-position lock. Detailed Telegram. Schedule. Persistent state + reconnect.
// ============================================================================

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const TelegramBot = require('node-telegram-bot-api');
const winston = require('winston');
const { EventEmitter } = require('events');

// ============================================================================
// SECTION 1: CONFIGURATION
// ============================================================================
class ConfigManager {
  constructor() {
    this.config = {
      deriv: {
        apiToken: 'pat_27a3197287bae3ec6c2c9cbdd68fffaa2a524e3b0a6e1ecf298b5ffb338adb10',
        appId: '33uslPtthXBEkQOdfKfoY',
        endpoint: `wss://ws.derivws.com/websockets/v3?app_id=${'33uslPtthXBEkQOdfKfoY'}`,
        accountType: 'DEMO',
      },
      telegram: {
        botToken: '8565754902:AAHS6UQWEgLJ0DO-JTpAGQhZLs-UDVVNAQc',
        chatId: '752497117',
        enabled: true,
      },
      trading: {
        symbol: 'R_100',
        initialStake: 0.35,
        contractDuration: 1,
        contractDurationUnit: 'm',
        riseType: 'CALLE',
        fallType: 'PUTE',
        maxDailyLoss: 2000,
        maxDailyTrades: 250,
        takeProfitTarget: 3000,
        minTimeBetweenTrades: 15000,
      },
      // Daily window in local time. New entries stop at pauseTime; open
      // contracts still settle. /hours off  = 24/7. /hours 08:00 22:00 to set.
      schedule: {
        enabled: true,
        timezone: 'Africa/Lagos',
        resumeTime: '08:00',
        pauseTime: '22:00',
      },
      analysis: {
        bbPeriod: 50,
        bbStdDev: 2.2,
        rsiPeriod: 14,
        rsiOverbought: 75,
        rsiOversold: 25,
        warmupTicks: 100,
      },
      risk: {
        recoveryMultiplier: 2.2,
        maxRecoverySteps: 9,
        drawdownLimit: 200,
      },
      system: {
        tickHistoryCount: 500,
        maxTickBuffer: 1000,
        reconnectDelay: 3000,
        maxReconnectDelay: 60000,
        maxReconnectAttempts: 0, // 0 = unlimited
        heartbeatInterval: 20000,
        requestTimeout: 20000,
        connectTimeout: 45000,
        connectGraceMs: 25000,
        staleTickMs: 20000,
        staleMessageMs: 45000,
        settlementGraceMs: 45000,
        scheduleCheckMs: 15000,
        stateFile: path.join(__dirname, 'newRiseFallState_01.json'),
      },
    };
    this.validate();
  }

  validate() {
    if (!this.config.deriv.apiToken) {
      console.error('❌ DERIV_API_TOKEN is required');
      process.exit(1);
    }
  }
}

// ============================================================================
// SECTION 2: LOGGER
// ============================================================================
class Logger {
  constructor() {
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
      ),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({
          filename: 'newRiseFall_01.log',
          maxsize: 5 * 1024 * 1024,
          maxFiles: 3,
        }),
      ],
    });
  }
  info(msg) { this.logger.info(msg); }
  warn(msg) { this.logger.warn(msg); }
  error(msg) { this.logger.error(msg); }
}

// ============================================================================
// HELPERS
// ============================================================================
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function num(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function money(v, withSign = false) {
  const x = num(v);
  const body = `$${Math.abs(x).toFixed(2)}`;
  if (!withSign) return x < 0 ? `-${body}` : body;
  if (x > 0) return `+${body}`;
  if (x < 0) return `-${body}`;
  return body;
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(num(ms) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function tzNow(timeZone) {
  const tz = timeZone || 'Africa/Lagos';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value || '00';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    timeZone: tz,
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: parseInt(get('minute'), 10),
    second: parseInt(get('second'), 10),
    weekday: get('weekday'),
    hhmm: `${pad(hour)}:${get('minute')}`,
    hhmmss: `${pad(hour)}:${get('minute')}:${get('second')}`,
    stamp: `${get('year')}-${get('month')}-${get('day')} ${pad(hour)}:${get('minute')}:${get('second')}`,
    short: `${pad(hour)}:${get('minute')}:${get('second')}`,
    tzLabel: tz === 'Africa/Lagos' ? 'WAT' : tz,
  };
}

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function hhmmFromMinutes(mins) {
  const n = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function durationToMs(duration, unit) {
  const n = Number(duration) || 1;
  switch (unit) {
    case 't': return n * 2500;
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 3600 * 1000;
    case 'd': return n * 86400 * 1000;
    default: return 60 * 1000;
  }
}

function isContractSold(poc) {
  if (!poc) return false;
  const sold = poc.is_sold;
  if (sold === 1 || sold === true || sold === '1') return true;
  const st = String(poc.status || '').toLowerCase();
  return st === 'sold' || st === 'won' || st === 'lost';
}

function fmtPx(v, digits = 2) {
  const n = num(v, NaN);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

// ============================================================================
// STATE STORE (inlined — single-file, no ./state module)
// ============================================================================
class StateStore {
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.tmpPath = filePath + '.tmp';
    this.bakPath = filePath + '.bak';
    this.logger = logger;
    this.dirty = false;
    this.pending = null;
    this.timer = null;
    this.lastSavedAt = 0;
  }

  load() {
    const candidates = [this.filePath, this.tmpPath, this.bakPath];
    for (const pth of candidates) {
      try {
        if (!fs.existsSync(pth)) continue;
        const raw = fs.readFileSync(pth, 'utf8');
        if (!raw || !raw.trim()) continue;
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          this.lastSavedAt = data.savedAt || fs.statSync(pth).mtimeMs;
          this.logger.info(`State loaded from ${path.basename(pth)} (saved ${new Date(this.lastSavedAt).toISOString()})`);
          return data;
        }
      } catch (e) {
        this.logger.warn(`State read failed (${path.basename(pth)}): ${e.message}`);
      }
    }
    this.logger.info('No usable state file — starting fresh');
    return null;
  }

  queue(payload) {
    this.pending = payload;
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 200);
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || this.pending == null) return true;
    const data = this.pending;
    this.dirty = false;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const json = JSON.stringify(data, null, 2);
      fs.writeFileSync(this.tmpPath, json);
      if (fs.existsSync(this.filePath)) {
        try { fs.copyFileSync(this.filePath, this.bakPath); } catch (_) { /* best-effort */ }
      }
      try {
        fs.renameSync(this.tmpPath, this.filePath);
      } catch (_) {
        fs.copyFileSync(this.tmpPath, this.filePath);
        try { fs.unlinkSync(this.tmpPath); } catch (__) { /* ignore */ }
      }
      this.lastSavedAt = data.savedAt || Date.now();
      return true;
    } catch (e) {
      this.logger.error(`State save failed: ${e.message}`);
      this.dirty = true;
      return false;
    }
  }
}

// ============================================================================
// SECTION 2b: TELEGRAM
// ============================================================================
class TelegramService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.enabled = config.telegram.enabled;
    this.bot = null;
    this.onCommand = null;
    if (this.enabled) {
      try {
        this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
        this._pollRestarting = false;
        this.bot.on('polling_error', (e) => this._onPollError(e));
        this.bot.on('message', (msg) => this._onMessage(msg));
      } catch (e) {
        this.logger.error(`Telegram init failed: ${e.message}`);
        this.enabled = false;
      }
    }
  }

  async _onPollError(e) {
    this.logger.error(`TG poll: ${e.message}`);
    if (this._pollRestarting || !this.bot) return;
    this._pollRestarting = true;
    try { await this.bot.stopPolling(); } catch (_) { /* ignore */ }
    setTimeout(() => {
      if (!this.bot) return;
      this.bot.startPolling()
        .then(() => { this._pollRestarting = false; this.logger.info('Telegram polling restarted'); })
        .catch((err) => {
          this._pollRestarting = false;
          this.logger.error(`TG repoll: ${err.message}`);
        });
    }, 5000);
  }

  _allowed(msg) {
    return msg && String(msg.chat?.id) === String(this.config.telegram.chatId);
  }

  _onMessage(msg) {
    if (!this._allowed(msg) || !msg.text) return;
    const raw = msg.text.trim();
    const key = raw.toLowerCase();
    let cmd = null;
    let args = [];

    if (raw.startsWith('/')) {
      const parts = raw.split(/\s+/);
      cmd = parts[0].split('@')[0].toLowerCase();
      args = parts.slice(1);
    } else if (key.includes('pause')) {
      cmd = '/pause';
    } else if (key.includes('resume')) {
      cmd = '/resume';
    } else if (key.includes('status')) {
      cmd = '/status';
    } else if (key.includes('hour')) {
      cmd = '/hours';
    } else if (key === 'help' || key === 'ℹ️ help') {
      cmd = '/help';
    }

    if (!cmd || typeof this.onCommand !== 'function') return;
    Promise.resolve(this.onCommand(cmd, args, msg)).catch((e) => {
      this.logger.error(`TG cmd ${cmd}: ${e.message}`);
    });
  }

  keyboard() {
    return {
      keyboard: [
        [{ text: '⏸ Pause' }, { text: '▶️ Resume' }],
        [{ text: '📊 Status' }, { text: '🕐 Hours' }, { text: 'ℹ️ Help' }],
      ],
      resize_keyboard: true,
    };
  }

  async send(msg, extra = {}) {
    if (!this.enabled || !this.bot) return;
    try {
      await this.bot.sendMessage(this.config.telegram.chatId, msg, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
      });
    } catch (e) {
      this.logger.error(`TG Error: ${e.message}`);
    }
  }

  async stop() {
    if (!this.bot) return;
    try { await this.bot.stopPolling(); } catch (_) { /* ignore */ }
  }
}

// ============================================================================
// SECTION 3: INDICATORS
// ============================================================================
class Indicators {
  static SMA(data, period) {
    if (data.length < period) return null;
    return data.slice(-period).reduce((s, v) => s + v, 0) / period;
  }

  static BollingerBands(data, period, stdMult) {
    const sma = this.SMA(data, period);
    if (!sma) return null;
    const slice = data.slice(-period);
    const variance = slice.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
      upper: sma + stdMult * stdDev,
      middle: sma,
      lower: sma - stdMult * stdDev,
      stdDev,
      percentB: (data[data.length - 1] - (sma - stdMult * stdDev)) / (2 * stdMult * stdDev),
    };
  }

  static RSI(data, period) {
    if (data.length < period + 1) return null;
    let gains = 0;
    let losses = 0;
    for (let i = data.length - period; i < data.length; i++) {
      const diff = data[i] - data[i - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
  }
}

// ============================================================================
// SECTION 4: PREDICTION ENGINE (Pure Mean Reversion)
// ============================================================================
class PredictionEngine {
  constructor(config) {
    this.config = config.analysis;
    this.riseType = config.trading.riseType;
    this.fallType = config.trading.fallType;
  }

  snapshot(prices) {
    if (!prices || prices.length < 2) return null;
    const bb = Indicators.BollingerBands(prices, this.config.bbPeriod, this.config.bbStdDev);
    const rsi = Indicators.RSI(prices, this.config.rsiPeriod);
    if (!bb || rsi === null) return null;

    const spot = prices[prices.length - 1];
    const prev = prices[prices.length - 2];
    const tickChange = spot - prev;
    const tickDir = tickChange > 0 ? 'UP' : tickChange < 0 ? 'DOWN' : 'FLAT';
    const bandwidth = bb.upper - bb.lower;
    const rsiZone = rsi <= this.config.rsiOversold
      ? 'OVERSOLD'
      : rsi >= this.config.rsiOverbought
        ? 'OVERBOUGHT'
        : 'NEUTRAL';
    const bandPos = spot <= bb.lower
      ? 'BELOW LOWER'
      : spot >= bb.upper
        ? 'ABOVE UPPER'
        : spot < bb.middle
          ? 'LOWER HALF'
          : 'UPPER HALF';

    return {
      spot,
      prev,
      tickChange,
      tickDir,
      bb,
      rsi,
      rsiZone,
      bandPos,
      bandwidth,
      distLower: spot - bb.lower,
      distUpper: bb.upper - spot,
      bbPeriod: this.config.bbPeriod,
      bbStdDev: this.config.bbStdDev,
      rsiPeriod: this.config.rsiPeriod,
      rsiOversold: this.config.rsiOversold,
      rsiOverbought: this.config.rsiOverbought,
      ticks: prices.length,
    };
  }

  predict(prices) {
    if (prices.length < this.config.warmupTicks) {
      return { signal: 'WAIT', reason: 'Warming up...', analysis: this.snapshot(prices) };
    }

    const analysis = this.snapshot(prices);
    if (!analysis) return { signal: 'WAIT', reason: 'Calculating...', analysis: null };

    const { spot, prev, rsi, bb } = analysis;

    if (spot <= bb.lower && rsi < this.config.rsiOversold && spot > prev) {
      return {
        signal: this.riseType,
        direction: 'RISE',
        confidence: Math.min(95, 60 + (this.config.rsiOversold - rsi)),
        reason: `Price below lower BB + RSI oversold + tick UP (mean-reversion long)`,
        analysis,
      };
    }

    if (spot >= bb.upper && rsi > this.config.rsiOverbought && spot < prev) {
      return {
        signal: this.fallType,
        direction: 'FALL',
        confidence: Math.min(95, 60 + (rsi - this.config.rsiOverbought)),
        reason: `Price above upper BB + RSI overbought + tick DOWN (mean-reversion short)`,
        analysis,
      };
    }

    return { signal: 'WAIT', reason: 'No extreme deviation', analysis };
  }
}

// ============================================================================
// SECTION 5: RISK & TRADE MANAGER
// ============================================================================
class RiskAndTradeManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.consecutiveLosses = 0;
    this.dailyPnL = 0;
    this.dailyTrades = 0;
    this.dailyWins = 0;
    this.totalTrades = 0;
    this.wins = 0;
    this.lastResetDate = new Date().toDateString();
  }

  checkDailyReset() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.logger.info('📅 New trading day — resetting daily counters');
      this.dailyPnL = 0;
      this.dailyTrades = 0;
      this.dailyWins = 0;
      this.consecutiveLosses = 0;
      this.lastResetDate = today;
      return true;
    }
    return false;
  }

  calculateStake() {
    const base = this.config.trading.initialStake;
    if (this.consecutiveLosses === 0) return base;
    const step = Math.min(this.consecutiveLosses, this.config.risk.maxRecoverySteps);
    const stake = base * Math.pow(this.config.risk.recoveryMultiplier, step);
    return parseFloat(stake.toFixed(2));
  }

  getStakeInfo() {
    const stake = this.calculateStake();
    const step = Math.min(this.consecutiveLosses, this.config.risk.maxRecoverySteps);
    return {
      stake,
      base: this.config.trading.initialStake,
      recoveryStep: this.consecutiveLosses,
      appliedStep: this.consecutiveLosses === 0 ? 0 : step,
      multiplier: this.consecutiveLosses === 0
        ? 1
        : Number(Math.pow(this.config.risk.recoveryMultiplier, step).toFixed(2)),
      mode: this.consecutiveLosses === 0
        ? 'BASE'
        : `RECOVERY ${Math.min(this.consecutiveLosses, this.config.risk.maxRecoverySteps)}/${this.config.risk.maxRecoverySteps}`,
    };
  }

  recordTrade(profit) {
    this.checkDailyReset();
    const p = Number(profit);
    const safe = Number.isFinite(p) ? p : 0;

    this.totalTrades++;
    this.dailyTrades++;
    this.dailyPnL += safe;

    if (safe > 0) {
      this.wins++;
      this.dailyWins++;
      this.consecutiveLosses = 0;
    } else {
      this.consecutiveLosses++;
    }
  }

  canTrade() {
    this.checkDailyReset();
    const lossCap = Math.min(this.config.trading.maxDailyLoss, this.config.risk.drawdownLimit);
    if (this.dailyPnL <= -lossCap) return { allowed: false, reason: 'Daily Loss Limit Hit' };
    if (this.dailyPnL >= this.config.trading.takeProfitTarget) return { allowed: false, reason: 'Daily Profit Target Hit' };
    if (this.dailyTrades >= this.config.trading.maxDailyTrades) return { allowed: false, reason: 'Max Daily Trades Hit' };
    return { allowed: true };
  }

  getStats() {
    return {
      trades: this.dailyTrades,
      wins: this.dailyWins,
      losses: this.dailyTrades - this.dailyWins,
      winRate: this.dailyTrades > 0 ? ((this.dailyWins / this.dailyTrades) * 100).toFixed(1) : '0.0',
      dailyPnL: this.dailyPnL.toFixed(2),
      dailyPnLNum: this.dailyPnL,
      currentStreak: this.consecutiveLosses > 0 ? `-${this.consecutiveLosses}L` : '0',
      consecutiveLosses: this.consecutiveLosses,
    };
  }

  serialize() {
    return {
      consecutiveLosses: this.consecutiveLosses,
      dailyPnL: this.dailyPnL,
      dailyTrades: this.dailyTrades,
      dailyWins: this.dailyWins,
      totalTrades: this.totalTrades,
      wins: this.wins,
      lastResetDate: this.lastResetDate,
    };
  }

  hydrate(s) {
    if (!s || typeof s !== 'object') return;
    this.consecutiveLosses = num(s.consecutiveLosses, 0);
    this.dailyPnL = num(s.dailyPnL, 0);
    this.dailyTrades = num(s.dailyTrades, 0);
    this.dailyWins = num(s.dailyWins, 0);
    this.totalTrades = num(s.totalTrades, 0);
    this.wins = num(s.wins, 0);
    if (s.lastResetDate) this.lastResetDate = s.lastResetDate;
    this.checkDailyReset();
  }
}

// ============================================================================
// SECTION 5b: PAUSE / RESUME SCHEDULE
// ============================================================================
class ScheduleManager {
  constructor(config, logger) {
    this.cfg = config.schedule;
    this.logger = logger;
  }

  now() {
    return tzNow(this.cfg.timezone || 'Africa/Lagos');
  }

  nowMinutes() {
    const n = this.now();
    return n.hour * 60 + n.minute;
  }

  isInsideWindow(nowMin = this.nowMinutes()) {
    if (!this.cfg.enabled) return true;
    const start = parseHHMM(this.cfg.resumeTime);
    const end = parseHHMM(this.cfg.pauseTime);
    if (start == null || end == null) return true;
    if (start === end) return true;
    if (start < end) return nowMin >= start && nowMin < end;
    return nowMin >= start || nowMin < end;
  }

  nextTransition() {
    const nowMin = this.nowMinutes();
    const start = parseHHMM(this.cfg.resumeTime);
    const end = parseHHMM(this.cfg.pauseTime);
    const tz = this.now();

    if (!this.cfg.enabled || start == null || end == null || start === end) {
      return { action: null, at: null, inMin: null, label: '24/7 (schedule off)' };
    }

    const inside = this.isInsideWindow(nowMin);
    const target = inside ? end : start;
    const action = inside ? 'pause' : 'resume';
    let delta = target - nowMin;
    if (delta <= 0) delta += 1440;

    return {
      action,
      at: hhmmFromMinutes(target),
      inMin: delta,
      inLabel: fmtDuration(delta * 60 * 1000),
      label: `${action === 'pause' ? 'Pauses' : 'Resumes'} ${hhmmFromMinutes(target)} ${tz.tzLabel} (in ${fmtDuration(delta * 60 * 1000)})`,
    };
  }

  setHours(resumeTime, pauseTime) {
    const a = parseHHMM(resumeTime);
    const b = parseHHMM(pauseTime);
    if (a == null || b == null) return false;
    this.cfg.resumeTime = hhmmFromMinutes(a);
    this.cfg.pauseTime = hhmmFromMinutes(b);
    this.cfg.enabled = true;
    return true;
  }

  describe() {
    const n = this.now();
    const next = this.nextTransition();
    return {
      enabled: !!this.cfg.enabled,
      timezone: this.cfg.timezone,
      tzLabel: n.tzLabel,
      resumeTime: this.cfg.resumeTime,
      pauseTime: this.cfg.pauseTime,
      inside: this.isInsideWindow(),
      now: n,
      next,
    };
  }
}

// ============================================================================
// TELEGRAM MESSAGE BUILDERS
// ============================================================================
function analysisBlock(a, title = 'Analysis') {
  if (!a) return `<b>📊 ${title}</b>\n<i>Indicators unavailable</i>`;
  const bb = a.bb || {};
  const tick = `${a.tickDir} ${a.tickChange >= 0 ? '+' : ''}${fmtPx(a.tickChange, 2)}`;
  const pctB = Number.isFinite(bb.percentB) ? bb.percentB.toFixed(3) : '—';
  return [
    `<b>📊 ${title}</b>`,
    `Spot: <code>${fmtPx(a.spot, 2)}</code>  prev <code>${fmtPx(a.prev, 2)}</code>  tick <b>${escapeHtml(tick)}</b>`,
    `BB(${a.bbPeriod}, ${a.bbStdDev}):`,
    `  Upper <code>${fmtPx(bb.upper, 2)}</code>`,
    `  Mid   <code>${fmtPx(bb.middle, 2)}</code>`,
    `  Lower <code>${fmtPx(bb.lower, 2)}</code>`,
    `  Width <code>${fmtPx(a.bandwidth, 2)}</code>  %B <code>${pctB}</code>`,
    `  Position: <b>${escapeHtml(a.bandPos)}</b>`,
    `RSI(${a.rsiPeriod}): <b>${fmtPx(a.rsi, 1)}</b>  ${escapeHtml(a.rsiZone)}`,
    `  OS ${a.rsiOversold} / OB ${a.rsiOverbought}`,
    `Buffer: ${a.ticks} ticks`,
  ].join('\n');
}

function statsBlock(stats, balance) {
  return [
    `<b>💰 Account</b>`,
    `Balance: ${money(balance)}`,
    `Daily P/L: <b>${money(stats.dailyPnLNum, true)}</b>`,
    `Today: ${stats.wins}W / ${stats.losses}L  WR ${stats.winRate}%  (${stats.trades} trades)`,
    `Streak: ${escapeHtml(stats.currentStreak)}`,
  ].join('\n');
}

// ============================================================================
// SECTION 6: DERIV REST CLIENT
// ============================================================================
class RestClient {
  constructor(baseUrl, appId, token) {
    this.baseUrl = baseUrl || 'https://api.derivws.com';
    this.appId = appId || '1089';
    this.token = token || '';
  }

  static isPat(token) {
    return typeof token === 'string'
      && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
  }

  _request(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(urlPath, this.baseUrl); }
      catch (e) { return reject(new Error(`Invalid URL: ${urlPath}`)); }

      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const opts = {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
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
          try { parsed = JSON.parse(data); } catch (_) { /* raw */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      });

      req.on('timeout', () => { req.destroy(new Error('REST request timeout')); });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  get(p) { return this._request('GET', p); }
  post(p, b) { return this._request('POST', p, b); }
  delete(p) { return this._request('DELETE', p); }
}

// ============================================================================
// SECTION 6b: DERIV API CLIENT
// ============================================================================
class DerivAPI extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.ws = null;
    this.reqId = 0;
    this.pending = new Map();
    this.balance = 0;
    this.accountInfo = null;
    this.reconnectAttempts = 0;
    this.totalReconnects = 0;
    this.maxReconnectAttempts = config.system.maxReconnectAttempts || 0;
    this.reconnectDelay = config.system.reconnectDelay;
    this.maxReconnectDelay = config.system.maxReconnectDelay || 60000;
    this.isReconnecting = false;
    this.isConnecting = false;
    this.isShuttingDown = false;
    this.intentionalClose = false;
    this.connectGeneration = 0;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.healthTimer = null;
    this.lastMessageAt = 0;
    this.lastTickAt = 0;
    this.connectedAt = 0;
    this.lastDisconnectReason = '';

    this._isPat = RestClient.isPat(config.deriv.apiToken);
    this._rest = this._isPat
      ? new RestClient('https://api.derivws.com', config.deriv.appId, config.deriv.apiToken)
      : null;
    this._otpUrl = null;
    this._targetAccount = null;
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    if (this.isShuttingDown) return;
    if (this.isConnecting) {
      this.logger.info('Connect already in progress');
      return;
    }
    if (this.isOpen()) {
      this.logger.info('Already connected');
      return;
    }
    if (!this.config.deriv.apiToken) {
      this.logger.error('API_TOKEN is empty — aborting');
      return;
    }

    this.isConnecting = true;
    const gen = ++this.connectGeneration;
    this.logger.info(`Connecting to Deriv API... (gen ${gen})`);
    this._teardownSocket();

    if (this._isPat) {
      this.logger.info('PAT token detected -> using NEW Deriv API (OTP flow)');
      this._newApiConnect().catch(err => {
        if (gen !== this.connectGeneration) return;
        this.isConnecting = false;
        this.logger.error(`New API connect failed: ${err.message}`);
        this._scheduleReconnect(err.message);
      });
    } else {
      this.logger.info('Using legacy Deriv API (token authorize flow)');
      this._openWs(`${this.config.deriv.endpoint}`, gen);
    }
  }

  forceReconnect(reason) {
    if (this.isShuttingDown) return;
    this.logger.warn(`Force reconnect: ${reason}`);
    this.lastDisconnectReason = reason;
    this.connectGeneration++;
    this.isConnecting = false;
    this._teardownSocket();
    this._scheduleReconnect(reason);
  }

  _openWs(url, gen) {
    try {
      this.ws = new WebSocket(url, {
        headers: { 'User-Agent': 'Bot/1.0 (+Node.js)' },
        handshakeTimeout: 15000,
      });
    } catch (e) {
      this.logger.error(`WS construct failed: ${e.message}`);
      this.isConnecting = false;
      this._scheduleReconnect(e.message);
      return;
    }

    this.ws.on('open', () => {
      if (gen && gen !== this.connectGeneration) return;
      this.onOpen();
    });
    this.ws.on('message', data => this._onMessage(data));
    this.ws.on('error', err => this._onError(err));
    this.ws.on('close', (code, reason) => {
      if (gen && gen !== this.connectGeneration) return;
      this.onClose(code, reason);
    });
    this.ws.on('unexpected-response', (_req, res) => {
      this.logger.error(`WS handshake failed: ${res.statusCode} ${res.statusMessage}`);
      try { res.destroy(); } catch (_) { /* ignore */ }
      this.isConnecting = false;
      this._scheduleReconnect(`handshake ${res.statusCode}`);
    });
  }

  async _newApiConnect() {
    const gen = this.connectGeneration;
    this.logger.info('REST: GET /trading/v1/options/accounts');
    const accRes = await this._rest.get('/trading/v1/options/accounts');

    if (accRes.status !== 200) {
      const msg = accRes.body?.errors?.[0]?.message || accRes.body?.message || JSON.stringify(accRes.body);
      let hint = '';
      if (accRes.status === 401) hint = ' — check PAT validity and APP_ID registration';
      else if (accRes.status === 403) hint = ' — PAT may lack "trade" scope';
      throw new Error(`Account list failed (${accRes.status}): ${msg}${hint}`);
    }

    const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
    if (!accounts.length) throw new Error('No Options accounts found for this token');

    const desiredType = (this.config.deriv.accountType || 'demo').toLowerCase();
    const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desiredType) || accounts[0];

    this._targetAccount = acct;
    this.accountInfo = {
      loginid: acct.account_id, email: acct.email,
      isVirtual: (acct.account_type || '').toLowerCase() === 'demo',
      accountType: acct.account_type, currency: acct.currency,
      balance: parseFloat(acct.balance), group: acct.group,
    };

    this.logger.info(`Selected account ${acct.account_id} (${acct.account_type}, ${acct.currency}, balance=${acct.balance})`);

    const otpPath = `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`;
    const otpRes = await this._rest.post(otpPath);

    if (otpRes.status !== 200) {
      const msg = otpRes.body?.errors?.[0]?.message || JSON.stringify(otpRes.body);
      throw new Error(`OTP request failed (${otpRes.status}): ${msg}`);
    }

    const wsUrl = otpRes.body?.data?.url;
    if (!wsUrl || !/^wss?:/i.test(wsUrl)) {
      throw new Error(`OTP response missing .data.url: ${JSON.stringify(otpRes.body)}`);
    }

    if (gen !== this.connectGeneration) {
      this.logger.info('OTP connect aborted — newer generation');
      return;
    }
    this._otpUrl = wsUrl;
    this._openWs(wsUrl, gen);
  }

  _markAuthorized() {
    if (!this.accountInfo) return;

    this.logger.info(
      `Authorized ${this.accountInfo.loginid}` +
      `(${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'})` +
      ` balance=${this.accountInfo.balance} ${this.accountInfo.currency} via PAT/new-API`
    );

    this.balance = this.accountInfo.balance;
    this.send({ balance: 1, subscribe: 1 }).catch(e => this.logger.warn(`Balance sub: ${e.message}`));
    this.send({ transaction: 1, subscribe: 1 }).catch(e => this.logger.warn(`Tx sub: ${e.message}`));
    this.emit('connected', this.accountInfo);
  }

  onOpen() {
    this.logger.info('WS Connected');
    this.isConnecting = false;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.connectedAt = Date.now();
    this.lastMessageAt = Date.now();
    this.lastTickAt = 0;
    this.startPing();
    this.startHealth();

    if (this._isPat) {
      this._markAuthorized();
    } else {
      this.send({ authorize: this.config.deriv.apiToken }).catch(e => {
        this.logger.error(`Authorize send failed: ${e.message}`);
      });
    }
  }

  _onMessage(data) {
    this.lastMessageAt = Date.now();
    let res;
    try { res = JSON.parse(data); }
    catch (e) { this.logger.error(`Parse error: ${e.message}`); return; }
    if (res.msg_type === 'tick') this.lastTickAt = Date.now();
    this._handle(res);
  }

  _handle(res) {
    if (res.error) {
      this.logger.error(`API error [${res.msg_type || '?'}]: ${res.error.message}`);
      if (res.req_id && this.pending.has(res.req_id)) {
        const { reject } = this.pending.get(res.req_id);
        this.pending.delete(res.req_id);
        reject(new Error(res.error.message));
      }
      return;
    }

    if (res.msg_type === 'tick' && res.tick && typeof res.tick.quote !== 'undefined') {
      this.emit('tick', res.tick);
    }

    if (res.msg_type === 'proposal_open_contract' && res.proposal_open_contract) {
      const poc = res.proposal_open_contract;
      if (isContractSold(poc)) {
        this.emit('contract_sold', poc);
      }
    }

    if (res.msg_type === 'transaction' && res.transaction) {
      const tx = res.transaction;
      const action = String(tx.action || '').toLowerCase();
      if (action === 'sell' && tx.contract_id != null) {
        this.emit('contract_sold', {
          contract_id: tx.contract_id,
          sell_price: tx.amount,
          _fromTransaction: true,
          status: 'sold',
          is_sold: 1,
        });
      }
    }

    if (res.msg_type === 'balance' && res.balance) {
      this.balance = num(res.balance.balance, this.balance);
    }

    if (res.msg_type === 'authorize' && !this._isPat) {
      this.balance = num(res.authorize.balance);
      this.accountInfo = res.authorize;
      this.send({ balance: 1, subscribe: 1 }).catch(() => {});
      this.send({ transaction: 1, subscribe: 1 }).catch(() => {});
      this.emit('connected', res.authorize);
    }

    if (res.req_id && this.pending.has(res.req_id)) {
      const { resolve } = this.pending.get(res.req_id);
      this.pending.delete(res.req_id);
      resolve(res);
    }
  }

  async getTickHistory(symbol, count = 500) {
    try {
      const res = await this.send({ ticks_history: symbol, count, end: 'latest', style: 'ticks' });
      if (!res.history || !Array.isArray(res.history.prices)) return [];
      return res.history.prices.map(p => parseFloat(p)).filter(n => Number.isFinite(n));
    } catch (e) {
      this.logger.error(`Tick history failed: ${e.message}`);
      return [];
    }
  }

  send(req, timeoutMs) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket not open'));
    }
    const wait = timeoutMs || this.config.system.requestTimeout || 20000;
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      req.req_id = id;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Request timeout (${wait}ms) req_id=${id}`));
      }, wait);
      this.pending.set(id, {
        resolve: (res) => { clearTimeout(timer); resolve(res); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      try {
        this.ws.send(JSON.stringify(req));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  _rejectAllPending(reason) {
    for (const [, handlers] of this.pending) {
      try { handlers.reject(new Error(reason)); } catch (_) { /* ignore */ }
    }
    this.pending.clear();
  }

  async buy(params) {
    const symbolKey = this._isPat ? 'underlying_symbol' : 'symbol';
    const currency = params.currency
      || this.accountInfo?.currency
      || 'USD';
    const res = await this.send({
      buy: 1,
      subscribe: 1,
      price: params.amount,
      parameters: {
        contract_type: params.type,
        [symbolKey]: params.symbol,
        duration: params.duration,
        duration_unit: params.unit,
        basis: 'stake',
        amount: params.amount,
        currency,
      },
    });
    if (!res.buy || !res.buy.contract_id) {
      throw new Error(`Buy response missing contract_id: ${JSON.stringify(res).slice(0, 300)}`);
    }
    return res.buy;
  }

  async subscribeOpenContract(contractId) {
    if (!contractId) return;
    try {
      await this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
    } catch (e) {
      this.logger.warn(`POC subscribe failed for ${contractId}: ${e.message}`);
    }
  }

  async getOpenContract(contractId) {
    const res = await this.send({ proposal_open_contract: 1, contract_id: contractId });
    return res.proposal_open_contract || null;
  }

  _onError(err) { this.logger.error(`WebSocket error: ${err.message}`); }

  onClose(code, reason) {
    const why = this.lastDisconnectReason
      || `socket closed ${code || ''} ${reason || ''}`.trim();
    this.logger.warn(`Disconnected from Deriv API (${why})`);
    this.stopPing();
    this.stopHealth();
    this._rejectAllPending('WebSocket disconnected');
    this.isConnecting = false;
    this.emit('disconnect', { reason: why });

    if (this.isShuttingDown) return;
    this._scheduleReconnect(why);
  }

  _scheduleReconnect(reason) {
    if (this.isShuttingDown) return;
    if (this.reconnectTimer) return;

    const cap = this.maxReconnectAttempts;
    if (cap > 0 && this.reconnectAttempts >= cap) {
      this.logger.error(`Max reconnection attempts (${cap}) reached — backing off 2 minutes then retrying`);
      this.reconnectAttempts = Math.max(0, cap - 3);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.isShuttingDown) return;
        this.connect();
      }, 120000);
      this.emit('reconnecting', { attempt: this.reconnectAttempts, delay: 120000, reason });
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    this.totalReconnects++;
    this.lastDisconnectReason = reason || this.lastDisconnectReason;
    const exp = Math.min(
      this.reconnectDelay * Math.pow(1.6, Math.min(this.reconnectAttempts - 1, 12)),
      this.maxReconnectDelay
    );
    const delay = Math.round(exp + Math.random() * 1000);
    this.logger.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}) — ${reason || ''}`.trim());
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay, reason });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isShuttingDown) return;
      this.isReconnecting = false;
      this.isConnecting = false;
      this.connect();
    }, delay);
  }

  startPing() {
    this.stopPing();
    const interval = this.config.system.heartbeatInterval || 20000;
    this.pingInterval = setInterval(() => {
      if (!this.isOpen()) return;
      try { this.ws.send(JSON.stringify({ ping: 1 })); } catch (_) { /* ignore */ }
    }, interval);
  }

  stopPing() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

  startHealth() {
    this.stopHealth();
    const staleTick = this.config.system.staleTickMs || 20000;
    const staleMsg = this.config.system.staleMessageMs || 45000;
    const grace = this.config.system.connectGraceMs || 25000;
    this.healthTimer = setInterval(() => {
      if (this.isShuttingDown || this.isConnecting || this.isReconnecting) return;
      if (!this.isOpen()) {
        this._scheduleReconnect('socket not open');
        return;
      }
      const now = Date.now();
      if (now - this.connectedAt < grace) return;
      if (this.lastMessageAt && now - this.lastMessageAt > staleMsg) {
        this.forceReconnect(`no messages for ${Math.round((now - this.lastMessageAt) / 1000)}s`);
        return;
      }
      if (this.lastTickAt && now - this.lastTickAt > staleTick) {
        this.forceReconnect(`no ticks for ${Math.round((now - this.lastTickAt) / 1000)}s`);
      }
    }, 5000);
  }

  stopHealth() {
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
  }

  _teardownSocket() {
    this.stopPing();
    this.stopHealth();
    this._rejectAllPending('Connection cleaned up');
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch { /* ignore */ }
      this.ws = null;
    }
  }

  cleanup() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._teardownSocket();
  }

  shutdown() {
    this.isShuttingDown = true;
    this.isReconnecting = false;
    this.isConnecting = false;
    this.connectGeneration++;
    this.cleanup();
  }
}

// ============================================================================
// SECTION 7: MAIN BOT ORCHESTRATOR
// ============================================================================
class DerivBot {
  constructor() {
    this.config = new ConfigManager().config;
    this.logger = new Logger();
    this.tg = new TelegramService(this.config, this.logger);
    this.api = new DerivAPI(this.config, this.logger);
    this.predictor = new PredictionEngine(this.config);
    this.risk = new RiskAndTradeManager(this.config, this.logger);
    this.schedule = new ScheduleManager(this.config, this.logger);

    this.prices = [];
    this.lastTickEpoch = null;

    this.sessionOver = false;
    this.sessionOverReason = '';
    this.manualPaused = false;
    this.manualPausedAt = null;
    this.isConnected = false;
    this.lastScheduleInside = null;
    this.scheduleTimer = null;

    this.busy = false;
    this.openContractId = null;
    this.currentTrade = null;
    this.pendingBuy = null;
    this.lastTradeTime = 0;
    this.settlementTimer = null;
    this.processedIds = new Set();
    this.processedQueue = [];

    this.state = new StateStore(this.config.system.stateFile, this.logger);
    this._disconnectSince = 0;
    this._notifiedDisconnect = false;
    this.restoredFromDisk = false;
  }

  snapshotState() {
    return {
      version: 1,
      savedAt: Date.now(),
      risk: this.risk.serialize(),
      session: {
        sessionOver: this.sessionOver,
        sessionOverReason: this.sessionOverReason,
        manualPaused: this.manualPaused,
        manualPausedAt: this.manualPausedAt,
        lastTradeTime: this.lastTradeTime,
        lastScheduleInside: this.lastScheduleInside,
      },
      schedule: {
        enabled: this.schedule.cfg.enabled,
        timezone: this.schedule.cfg.timezone,
        resumeTime: this.schedule.cfg.resumeTime,
        pauseTime: this.schedule.cfg.pauseTime,
      },
      trade: {
        busy: this.busy,
        openContractId: this.openContractId,
        currentTrade: this.currentTrade,
        pendingBuy: this.pendingBuy,
      },
      processedIds: this.processedQueue.slice(-200),
    };
  }

  persist(sync = false) {
    this.state.queue(this.snapshotState());
    if (sync) this.state.flush();
  }

  hydrateFromDisk() {
    const s = this.state.load();
    if (!s) return false;
    try {
      if (s.risk) this.risk.hydrate(s.risk);
      if (s.session) {
        this.sessionOver = !!s.session.sessionOver;
        this.sessionOverReason = s.session.sessionOverReason || '';
        this.manualPaused = !!s.session.manualPaused;
        this.manualPausedAt = s.session.manualPausedAt || null;
        this.lastTradeTime = num(s.session.lastTradeTime, 0);
        if (s.session.lastScheduleInside != null) this.lastScheduleInside = s.session.lastScheduleInside;
      }
      if (s.schedule) {
        if (typeof s.schedule.enabled === 'boolean') this.schedule.cfg.enabled = s.schedule.enabled;
        if (s.schedule.timezone) this.schedule.cfg.timezone = s.schedule.timezone;
        if (s.schedule.resumeTime) this.schedule.cfg.resumeTime = s.schedule.resumeTime;
        if (s.schedule.pauseTime) this.schedule.cfg.pauseTime = s.schedule.pauseTime;
      }
      if (s.trade) {
        this.openContractId = s.trade.openContractId || null;
        this.currentTrade = s.trade.currentTrade || null;
        this.pendingBuy = s.trade.pendingBuy || null;
        this.busy = !!(this.openContractId || this.pendingBuy || s.trade.busy);
      }
      if (Array.isArray(s.processedIds)) {
        this.processedQueue = s.processedIds.map(String);
        this.processedIds = new Set(this.processedQueue);
      }
      this.restoredFromDisk = true;
      this.logger.info(
        `State restored — daily ${this.risk.dailyTrades} trades / ${money(this.risk.dailyPnL, true)} ` +
        `| open=${this.openContractId || 'none'} | paused=${this.manualPaused}`
      );
      return true;
    } catch (e) {
      this.logger.error(`State hydrate failed: ${e.message}`);
      return false;
    }
  }

  _isNetworkError(err) {
    const m = String(err && err.message || err || '').toLowerCase();
    return /websocket|disconnect|not open|timeout|econn|enotfound|eai_again|socket|network|cleaned up/i.test(m);
  }

  _clock() {
    return this.schedule.now();
  }

  _entryGate() {
    if (!this.isConnected) return { ok: false, reason: 'Disconnected' };
    if (this.sessionOver) return { ok: false, reason: this.sessionOverReason || 'Session over' };
    if (this.manualPaused) return { ok: false, reason: 'Manual pause' };
    if (!this.schedule.isInsideWindow()) {
      const next = this.schedule.nextTransition();
      return { ok: false, reason: `Outside schedule (resumes ${next.at} ${this._clock().tzLabel})` };
    }
    const risk = this.risk.canTrade();
    if (!risk.allowed) return { ok: false, reason: risk.reason };
    return { ok: true };
  }

  async start() {
    this.logger.info('🚀 Starting Deriv Bot v4.3...');
    this.hydrateFromDisk();
    this.tg.onCommand = (cmd, args) => this.handleTelegramCommand(cmd, args);

    this.api.on('tick', (t) => {
      this.onTick(t).catch(e => this.logger.error(`onTick: ${e.message}`));
    });
    this.api.on('contract_sold', (c) => {
      this.onContractSold(c).catch(e => this.logger.error(`onContractSold: ${e.message}`));
    });
    this.api.on('disconnect', (info) => {
      this.isConnected = false;
      if (!this._disconnectSince) this._disconnectSince = Date.now();
      this.logger.warn(`Feed paused — waiting for reconnect (${info?.reason || ''})`);
      this._maybeNotifyDisconnect(info?.reason);
    });
    this.api.on('reconnecting', ({ attempt, delay, reason }) => {
      this.logger.info(`Reconnect scheduled #${attempt} in ${(delay / 1000).toFixed(1)}s (${reason || ''})`);
    });
    this.api.on('connected', async () => {
      const downtime = this._disconnectSince ? Date.now() - this._disconnectSince : 0;
      this.isConnected = true;
      this.logger.info('Authorized — restoring subscriptions');
      try {
        await this._onRestoredConnection(downtime);
      } catch (e) {
        this.logger.error(`Post-reconnect restore failed: ${e.message}`);
      }
    });

    const account = await this._connectWithRetry();
    this.isConnected = true;
    this.logger.info(`✅ Authorized: ${account.loginid} | Balance: $${this.api.balance}`);

    await this._refreshTickHistory();
    try {
      await this.api.send({ ticks: this.config.trading.symbol, subscribe: 1 });
      this.logger.info('📡 Listening to ticks...');
    } catch (e) {
      this.logger.error(`Tick subscribe failed: ${e.message}`);
    }

    await this.restoreOpenPosition();
    this.persist();
    await this._notifyStartup();
    this._startScheduleLoop();
    await this._applySchedule(true);
  }

  async _waitConnected(timeoutMs) {
    if (this.api.isOpen() && this.api.accountInfo) return this.api.accountInfo;
    return new Promise((resolve, reject) => {
      const onOk = (account) => { done(); resolve(account); };
      const timer = setTimeout(() => {
        done();
        reject(new Error('Connection timeout'));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        this.api.off('connected', onOk);
      };
      this.api.on('connected', onOk);
    });
  }

  async _connectWithRetry() {
    this.api.connect();
    for (;;) {
      try {
        return await this._waitConnected(this.config.system.connectTimeout);
      } catch (e) {
        this.logger.error(`Connect attempt failed: ${e.message} — keeping retry loop`);
        await this.tg.send(
          `🔌 <b>Connect failed</b>\n${escapeHtml(e.message)}\nRetrying automatically…`
        );
      }
    }
  }

  async _refreshTickHistory() {
    try {
      const hist = await this.api.getTickHistory(
        this.config.trading.symbol,
        this.config.system.tickHistoryCount
      );
      if (hist.length) {
        this.prices = hist;
        this.logger.info(`📊 Backfilled ${this.prices.length} ticks from history`);
      }
    } catch (e) {
      this.logger.warn(`Tick history refresh failed: ${e.message}`);
    }
  }

  async _onRestoredConnection(downtimeMs) {
    await this._refreshTickHistory();
    try {
      await this.api.send({ ticks: this.config.trading.symbol, subscribe: 1 });
    } catch (e) {
      this.logger.error(`Tick resubscribe failed: ${e.message}`);
    }
    await this.restoreOpenPosition();
    this.persist();

    if (this._notifiedDisconnect || downtimeMs > 15000) {
      const clock = this._clock();
      await this.tg.send([
        `🔌 <b>RECONNECTED</b>`,
        `Time: <code>${clock.stamp} ${clock.tzLabel}</code>`,
        downtimeMs ? `Downtime: ${fmtDuration(downtimeMs)}` : null,
        `Attempts this outage: ${this.api.reconnectAttempts === 0 ? 'recovered' : this.api.reconnectAttempts}`,
        `Total reconnects: ${this.api.totalReconnects}`,
        `Open contract: ${this.openContractId || 'none'}`,
        `Balance: ${money(this.api.balance)}`,
      ].filter(Boolean).join('\n'));
    }
    this._disconnectSince = 0;
    this._notifiedDisconnect = false;
  }

  _maybeNotifyDisconnect(reason) {
    if (this._notifiedDisconnect) return;
    setTimeout(() => {
      if (this.isConnected || this._notifiedDisconnect) return;
      this._notifiedDisconnect = true;
      const clock = this._clock();
      this.tg.send([
        `🔌 <b>DISCONNECTED</b>`,
        `Time: <code>${clock.stamp} ${clock.tzLabel}</code>`,
        reason ? `Reason: ${escapeHtml(String(reason))}` : null,
        `Bot will keep retrying (unlimited). Open-contract state is on disk.`,
      ].filter(Boolean).join('\n')).catch(() => {});
    }, 12000);
  }

  async _notifyStartup() {
    const sch = this.schedule.describe();
    const clock = sch.now;
    const lines = [
      `🤖 <b>Bot v4.3 Started</b>`,
      `Time: <code>${clock.stamp} ${clock.tzLabel}</code>`,
      `Balance: ${money(this.api.balance)}`,
      this.restoredFromDisk
        ? `State: restored from disk (${this.risk.dailyTrades} trades today, open ${this.openContractId || 'none'})`
        : `State: fresh session`,
      `Symbol: ${this.config.trading.symbol}  ·  ${this.config.trading.contractDuration}${this.config.trading.contractDurationUnit} Rise/Fall`,
      `Mode: single open contract`,
      ``,
      `<b>🕐 Schedule</b>`,
    ];
    if (sch.enabled) {
      lines.push(`Resume: <b>${sch.resumeTime}</b> ${sch.tzLabel}`);
      lines.push(`Pause:  <b>${sch.pauseTime}</b> ${sch.tzLabel}`);
      lines.push(`Now: ${sch.inside ? '🟢 INSIDE window' : '🔴 OUTSIDE window'}`);
      lines.push(sch.next.label);
    } else {
      lines.push(`24/7 (schedule off)`);
    }
    lines.push(``);
    lines.push(`Commands: /pause  /resume  /status  /hours  /help`);
    await this.tg.send(lines.join('\n'), { reply_markup: this.tg.keyboard() });
  }

  _startScheduleLoop() {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = setInterval(() => {
      this._applySchedule(false).catch(e => this.logger.error(`schedule: ${e.message}`));
    }, this.config.system.scheduleCheckMs || 15000);
  }

  async _applySchedule(isStartup) {
    if (this.risk.checkDailyReset() && this.sessionOver) {
      const risk = this.risk.canTrade();
      if (risk.allowed) {
        this.sessionOver = false;
        this.sessionOverReason = '';
        this.logger.info('Daily counters reset — session limit cleared');
        this.persist();
      }
    }

    if (this.manualPaused || !this.schedule.cfg.enabled) {
      this.lastScheduleInside = this.schedule.isInsideWindow();
      return;
    }

    const inside = this.schedule.isInsideWindow();
    const changed = this.lastScheduleInside !== null && this.lastScheduleInside !== inside;
    this.lastScheduleInside = inside;

    if (!changed && !isStartup) return;

    const clock = this._clock();
    const next = this.schedule.nextTransition();

    if (!inside && (changed || isStartup)) {
      this.logger.warn(`Schedule pause at ${clock.stamp} ${clock.tzLabel} — resumes ${next.at}`);
      this.persist();
      await this.tg.send([
        `⏸ <b>TRADING PAUSED</b>`,
        `Time: <code>${clock.stamp} ${clock.tzLabel}</code>`,
        `Reason: Daily schedule (pause ${this.schedule.cfg.pauseTime})`,
        `▶️ Resumes: <b>${next.at} ${clock.tzLabel}</b>  (${next.inLabel})`,
        this.openContractId
          ? `Open contract ${this.openContractId} will settle — no new entries.`
          : `No open contract.`,
      ].join('\n'));
    }

    if (inside && changed) {
      this.logger.info(`Schedule resume at ${clock.stamp} ${clock.tzLabel} — pauses ${next.at}`);
      this.persist();
      await this.tg.send([
        `▶️ <b>TRADING RESUMED</b>`,
        `Time: <code>${clock.stamp} ${clock.tzLabel}</code>`,
        `Reason: Daily schedule (resume ${this.schedule.cfg.resumeTime})`,
        `⏸ Pauses: <b>${next.at} ${clock.tzLabel}</b>  (${next.inLabel})`,
        `Balance: ${money(this.api.balance)}`,
      ].join('\n'));
    }
  }

  async handleTelegramCommand(cmd, args) {
    switch (cmd) {
      case '/pause':
        return this._cmdPause();
      case '/resume':
        return this._cmdResume();
      case '/status':
        return this._cmdStatus();
      case '/hours':
        return this._cmdHours(args);
      case '/help':
        return this._cmdHelp();
      default:
        return;
    }
  }

  async _cmdPause() {
    if (this.manualPaused) {
      await this.tg.send(
        `⏸ Already paused manually since <code>${this.manualPausedAt || '—'}</code>.\nUse /resume to start again.`
      );
      return;
    }
    this.manualPaused = true;
    const clock = this._clock();
    this.manualPausedAt = `${clock.stamp} ${clock.tzLabel}`;
    this.persist();
    this.logger.warn(`Manual pause at ${this.manualPausedAt}`);
    await this.tg.send([
      `⏸ <b>TRADING PAUSED</b>`,
      `Time: <code>${this.manualPausedAt}</code>`,
      `Reason: Manual /pause`,
      `Open contracts still settle. No new entries until /resume.`,
      this.schedule.cfg.enabled
        ? `Schedule will not auto-resume (manual pause overrides ${this.schedule.cfg.resumeTime}).`
        : ``,
    ].filter(Boolean).join('\n'));
  }

  async _cmdResume() {
    const clock = this._clock();
    if (!this.manualPaused && this.schedule.isInsideWindow() && !this.sessionOver) {
      await this.tg.send(`▶️ Already running. ${this.schedule.nextTransition().label}`);
      return;
    }
    this.manualPaused = false;
    this.manualPausedAt = null;
    this.persist();

    if (this.sessionOver) {
      await this.tg.send(
        `▶️ Manual pause cleared at <code>${clock.stamp} ${clock.tzLabel}</code>\n` +
        `⛔ Session still stopped: ${escapeHtml(this.sessionOverReason || 'daily limit')}`
      );
      return;
    }

    if (!this.schedule.isInsideWindow() && this.schedule.cfg.enabled) {
      const next = this.schedule.nextTransition();
      await this.tg.send([
        `▶️ Manual pause cleared at <code>${clock.stamp} ${clock.tzLabel}</code>`,
        `⏸ Still outside the daily window.`,
        `Resumes automatically at <b>${next.at} ${clock.tzLabel}</b> (${next.inLabel}).`,
        `Window: ${this.schedule.cfg.resumeTime} → ${this.schedule.cfg.pauseTime} ${clock.tzLabel}`,
      ].join('\n'));
      return;
    }

    this.logger.info(`Manual resume at ${clock.stamp} ${clock.tzLabel}`);
    await this.tg.send([
      `▶️ <b>TRADING RESUMED</b>`,
      `Time: <code>${clock.stamp} ${clock.tzLabel}</code>`,
      `Reason: Manual /resume`,
      this.schedule.cfg.enabled
        ? `⏸ Next pause: <b>${this.schedule.cfg.pauseTime} ${clock.tzLabel}</b> (${this.schedule.nextTransition().inLabel})`
        : `Schedule off — 24/7`,
      `Balance: ${money(this.api.balance)}`,
    ].join('\n'));
  }

  async _cmdStatus() {
    const clock = this._clock();
    const sch = this.schedule.describe();
    const stats = this.risk.getStats();
    const gate = this._entryGate();
    const lines = [
      `📊 <b>STATUS</b>`,
      `Time: <code>${clock.stamp} ${clock.tzLabel}</code>`,
      `Feed: ${this.isConnected ? '🟢 connected' : '🔴 disconnected'}`,
      `Entries: ${gate.ok ? '🟢 allowed' : `🔴 blocked — ${escapeHtml(gate.reason)}`}`,
      `Manual: ${this.manualPaused ? `⏸ paused since ${this.manualPausedAt}` : '▶️ not paused'}`,
      `Open: ${this.openContractId || 'none'}`,
      `Reconnects: ${this.api.totalReconnects}  ·  ${this.isConnected ? 'live' : `retry #${this.api.reconnectAttempts}`}`,
      this.state.lastSavedAt ? `State saved: ${fmtDuration(Date.now() - this.state.lastSavedAt)} ago` : null,
      ``,
      `<b>🕐 Schedule</b>`,
      sch.enabled
        ? `Window ${sch.resumeTime} → ${sch.pauseTime} ${sch.tzLabel}\nNow: ${sch.inside ? 'inside' : 'outside'}\n${sch.next.label}`
        : `Off (24/7)`,
      ``,
      statsBlock(stats, this.api.balance),
    ].filter(v => v !== null);
    await this.tg.send(lines.join('\n'));
  }

  async _cmdHours(args) {
    const clock = this._clock();
    const a0 = (args[0] || '').toLowerCase();

    if (!args.length) {
      const sch = this.schedule.describe();
      await this.tg.send([
        `🕐 <b>Schedule</b>`,
        `Timezone: ${sch.timezone} (${sch.tzLabel})`,
        `Now: <code>${clock.stamp}</code>`,
        sch.enabled
          ? `Resume ${sch.resumeTime}  ·  Pause ${sch.pauseTime}\n${sch.inside ? '🟢 inside window' : '🔴 outside window'}\n${sch.next.label}`
          : `Off — trading 24/7`,
        ``,
        `Set: <code>/hours 08:00 22:00</code>`,
        `Off: <code>/hours off</code>   On: <code>/hours on</code>`,
      ].join('\n'));
      return;
    }

    if (a0 === 'off' || a0 === '24/7' || a0 === '24h') {
      this.schedule.cfg.enabled = false;
      this.lastScheduleInside = true;
      this.persist();
      await this.tg.send(`🕐 Schedule <b>OFF</b> — trading 24/7.\nTime: <code>${clock.stamp} ${clock.tzLabel}</code>`);
      return;
    }

    if (a0 === 'on') {
      this.schedule.cfg.enabled = true;
      this.lastScheduleInside = null;
      this.persist();
      await this.tg.send(
        `🕐 Schedule <b>ON</b>\nResume ${this.schedule.cfg.resumeTime}  ·  Pause ${this.schedule.cfg.pauseTime} ${clock.tzLabel}`
      );
      await this._applySchedule(true);
      return;
    }

    if (args.length >= 2 && this.schedule.setHours(args[0], args[1])) {
      this.lastScheduleInside = null;
      this.persist();
      await this.tg.send(
        `🕐 Schedule updated\n▶️ Resume <b>${this.schedule.cfg.resumeTime}</b>\n⏸ Pause <b>${this.schedule.cfg.pauseTime}</b>\nTZ: ${clock.tzLabel}`
      );
      await this._applySchedule(true);
      return;
    }

    await this.tg.send('Usage: <code>/hours 08:00 22:00</code>  or  <code>/hours off</code>');
  }

  async _cmdHelp() {
    await this.tg.send([
      `<b>Commands</b>`,
      `/pause — stop new trades now`,
      `/resume — allow new trades (still respects hours)`,
      `/status — position, schedule, P/L`,
      `/hours — show window`,
      `/hours 08:00 22:00 — set daily resume/pause (WAT)`,
      `/hours off — 24/7`,
      `/hours on — re-enable window`,
      ``,
      `State survives restart (daily P/L, open contract, pause, hours).`,
      `Network drops auto-reconnect; no need to restart the process.`,
    ].join('\n'));
  }

  async restoreOpenPosition() {
    try {
      const res = await this.api.send({ portfolio: 1 });
      const contracts = Array.isArray(res.portfolio?.contracts) ? res.portfolio.contracts : [];

      if (!contracts.length) {
        if (this.openContractId) {
          try {
            const poc = await this.api.getOpenContract(this.openContractId);
            if (poc && isContractSold(poc)) {
              await this.onContractSold(poc);
              return;
            }
          } catch (_) { /* fall through */ }
          this.logger.warn('Portfolio empty — releasing stale lock');
          this._releaseLock();
          this.persist();
          return;
        }
        if (this.pendingBuy) {
          const age = Date.now() - num(this.pendingBuy.startedAt, Date.now());
          if (age > 30000) {
            this.logger.warn(`Pending buy (${fmtDuration(age)}) not on portfolio — dropping`);
            this.pendingBuy = null;
            this._releaseLock();
            this.persist();
          } else {
            this.logger.warn('Pending buy still unconfirmed — will recheck next restore');
          }
        }
        return;
      }

      let ours = null;
      if (this.openContractId) {
        ours = contracts.find(c => String(c.contract_id) === String(this.openContractId));
      }
      if (!ours && this.pendingBuy) {
        ours = contracts[0];
        this.logger.warn(`Adopting portfolio contract ${ours.contract_id} for interrupted buy`);
      }
      if (!ours) ours = contracts[0];

      this.busy = true;
      this.openContractId = ours.contract_id;
      if (!this.currentTrade || String(this.currentTrade.contractId) !== String(ours.contract_id)) {
        const pb = this.pendingBuy || {};
        this.currentTrade = {
          contractId: ours.contract_id,
          stake: num(ours.buy_price, pb.stake),
          buyPrice: num(ours.buy_price, pb.stake),
          type: ours.contract_type || pb.type,
          direction: pb.direction || ours.contract_type,
          confidence: pb.confidence,
          reason: pb.reason,
          analysis: pb.analysis,
          stakeInfo: pb.stakeInfo,
          openedAt: pb.startedAt || Date.now(),
          openedStamp: pb.openedStamp || this._clock().stamp,
          spot: pb.spot,
        };
      }
      this.pendingBuy = null;
      this.persist();
      this.logger.warn(`Holding lock for existing contract ${ours.contract_id} (portfolio)`);
      await this.api.subscribeOpenContract(ours.contract_id);
      this._armSettlementWatchdog(ours.contract_id);
    } catch (e) {
      this.logger.warn(`Portfolio restore failed: ${e.message}`);
      if (this.openContractId) {
        await this.api.subscribeOpenContract(this.openContractId);
      }
    }
  }

  _markProcessed(id) {
    if (id == null) return false;
    const key = String(id);
    if (this.processedIds.has(key)) return true;
    this.processedIds.add(key);
    this.processedQueue.push(key);
    if (this.processedQueue.length > 300) {
      const old = this.processedQueue.shift();
      this.processedIds.delete(old);
    }
    return false;
  }

  _clearSettlementTimer() {
    if (this.settlementTimer) {
      clearTimeout(this.settlementTimer);
      this.settlementTimer = null;
    }
  }

  _armSettlementWatchdog(contractId) {
    this._clearSettlementTimer();
    const life = durationToMs(
      this.config.trading.contractDuration,
      this.config.trading.contractDurationUnit
    );
    const wait = life + this.config.system.settlementGraceMs;
    this.settlementTimer = setTimeout(() => {
      this._onSettlementWatchdog(contractId).catch(e => {
        this.logger.error(`Watchdog: ${e.message}`);
      });
    }, wait);
  }

  async _onSettlementWatchdog(contractId) {
    if (!this.openContractId || String(this.openContractId) !== String(contractId)) return;
    this.logger.warn(`⏱ Settlement watchdog — querying contract ${contractId}`);
    if (!this.isConnected) {
      this._armSettlementWatchdog(contractId);
      return;
    }
    try {
      const poc = await this.api.getOpenContract(contractId);
      if (poc && isContractSold(poc)) {
        await this.onContractSold(poc);
        return;
      }
      if (poc && !isContractSold(poc)) {
        this.logger.info('Contract still open — watchdog re-armed');
        await this.api.subscribeOpenContract(contractId);
        this._armSettlementWatchdog(contractId);
        return;
      }
    } catch (e) {
      this.logger.warn(`Watchdog query failed: ${e.message}`);
    }
    this.logger.error(`Releasing lock for ${contractId} after watchdog (status unknown)`);
    this._releaseLock();
    this.persist();
  }

  _releaseLock() {
    this._clearSettlementTimer();
    this.busy = false;
    this.openContractId = null;
    this.currentTrade = null;
    this.pendingBuy = null;
  }

  async onTick(tick) {
    if (!tick || typeof tick.quote === 'undefined') return;

    const price = parseFloat(tick.quote);
    if (!Number.isFinite(price)) return;

    if (tick.epoch && tick.epoch === this.lastTickEpoch) return;
    if (tick.epoch) this.lastTickEpoch = tick.epoch;

    this.prices.push(price);
    if (this.prices.length > this.config.system.maxTickBuffer) {
      this.prices = this.prices.slice(-this.config.system.maxTickBuffer);
    }

    if (this.busy || this.openContractId) return;
    if (Date.now() - this.lastTradeTime < this.config.trading.minTimeBetweenTrades) return;

    const gate = this._entryGate();
    if (!gate.ok) {
      if (gate.reason.includes('Daily') || gate.reason.includes('Max Daily') || gate.reason.includes('Profit Target')) {
        if (!this.sessionOver) {
          this.sessionOver = true;
          this.sessionOverReason = gate.reason;
          this.persist();
          this.logger.warn(`Trading paused: ${gate.reason}`);
          await this.tg.send(`⛔ <b>Paused:</b> ${escapeHtml(gate.reason)}\nTime: <code>${this._clock().stamp} ${this._clock().tzLabel}</code>`);
        }
      }
      return;
    }

    const prediction = this.predictor.predict(this.prices);
    if (prediction.signal === 'WAIT') return;

    this.busy = true;
    this.lastTradeTime = Date.now();
    this.persist();

    try {
      await this.executeTrade(prediction, price);
    } catch (e) {
      this.logger.error(`Trade failed: ${e.message}`);
      if (this._isNetworkError(e) && !this.openContractId) {
        this.logger.warn('Buy interrupted by network — lock held until portfolio confirm');
        this.persist();
        return;
      }
      this._releaseLock();
      this.persist();
    }
  }

  async executeTrade(prediction, price) {
    const stakeInfo = this.risk.getStakeInfo();
    const stake = stakeInfo.stake;

    if (stake > this.api.balance) {
      this.logger.error('Insufficient balance for recovery stake!');
      this.sessionOver = true;
      this.sessionOverReason = 'Insufficient balance';
      this._releaseLock();
      this.persist();
      await this.tg.send('⛔ <b>Stopped:</b> Insufficient balance for recovery stake.');
      return;
    }

    const dir = prediction.direction || prediction.signal;
    this.logger.info(`🎯 SIGNAL: ${dir} (${prediction.signal}) | Stake: $${stake} | ${prediction.reason}`);

    this.pendingBuy = {
      startedAt: Date.now(),
      openedStamp: `${this._clock().stamp} ${this._clock().tzLabel}`,
      type: prediction.signal,
      direction: dir,
      stake,
      stakeInfo,
      confidence: prediction.confidence,
      reason: prediction.reason,
      analysis: prediction.analysis,
      spot: price,
    };
    this.persist();

    const contract = await this.api.buy({
      type: prediction.signal,
      symbol: this.config.trading.symbol,
      duration: this.config.trading.contractDuration,
      unit: this.config.trading.contractDurationUnit,
      amount: stake,
      currency: this.api.accountInfo?.currency || 'USD',
    });

    const clock = this._clock();
    this.openContractId = contract.contract_id;
    this.currentTrade = {
      contractId: contract.contract_id,
      stake,
      buyPrice: num(contract.buy_price, stake),
      payout: num(contract.payout, NaN),
      type: prediction.signal,
      direction: dir,
      confidence: prediction.confidence,
      reason: prediction.reason,
      analysis: prediction.analysis,
      stakeInfo,
      openedAt: Date.now(),
      openedStamp: `${clock.stamp} ${clock.tzLabel}`,
      spot: price,
    };
    this.pendingBuy = null;
    this.persist();
    this._armSettlementWatchdog(contract.contract_id);
    this.api.subscribeOpenContract(contract.contract_id).catch(() => {});

    this.logger.info(`✅ Opened Contract: ${contract.contract_id} — lock held until settlement`);

    try {
      await this.tg.send(this._formatExecuteMessage(this.currentTrade, contract));
    } catch (e) {
      this.logger.error(`TG open notify: ${e.message}`);
    }
  }

  _formatExecuteMessage(trade, contract) {
    const a = trade.analysis;
    const next = this.schedule.nextTransition();
    const conf = trade.confidence != null ? `${num(trade.confidence).toFixed(0)}%` : '—';
    const payout = Number.isFinite(trade.payout) ? money(trade.payout) : '—';
    return [
      `📈 <b>TRADE EXECUTED</b>`,
      `━━━━━━━━━━━━━━━━`,
      `Dir: <b>${escapeHtml(trade.direction)}</b>  (${escapeHtml(trade.type)})`,
      `Symbol: ${this.config.trading.symbol}  ·  ${this.config.trading.contractDuration}${this.config.trading.contractDurationUnit}`,
      `Stake: <b>${money(trade.stake)}</b>  [${escapeHtml(trade.stakeInfo.mode)}]`,
      Number.isFinite(trade.payout) ? `Quoted payout: ${payout}` : null,
      `Confidence: <b>${conf}</b>`,
      `Contract: <code>${trade.contractId}</code>`,
      ``,
      analysisBlock(a, 'Entry analysis'),
      ``,
      `<b>Why</b>`,
      escapeHtml(trade.reason || '—'),
      ``,
      statsBlock(this.risk.getStats(), this.api.balance),
      ``,
      `<b>🕐 Timing</b>`,
      `Executed: <code>${trade.openedStamp}</code>`,
      this.schedule.cfg.enabled ? next.label : 'Schedule off (24/7)',
    ].filter(v => v !== null).join('\n');
  }

  async onContractSold(contract) {
    if (!contract) return;
    const id = contract.contract_id;

    if (this.busy && !this.openContractId && !this.currentTrade) return;

    const expectedId = this.currentTrade?.contractId || this.openContractId;
    if (!expectedId) return;
    if (id != null && String(id) !== String(expectedId)) return;
    if (id != null && this._markProcessed(id)) return;

    const trade = this.currentTrade;
    let profit;
    if (contract._fromTransaction) {
      if (!trade) return;
      profit = num(contract.sell_price) - trade.buyPrice;
    } else {
      profit = num(contract.profit, NaN);
      if (!Number.isFinite(profit) && trade) {
        profit = -trade.buyPrice;
      }
      if (!Number.isFinite(profit)) profit = 0;
    }

    const exitAnalysis = this.predictor.snapshot(this.prices);
    const exitSpot = exitAnalysis?.spot ?? this.prices[this.prices.length - 1];
    const closedAt = Date.now();
    const clock = this._clock();

    this.risk.recordTrade(profit);
    const stats = this.risk.getStats();
    this._releaseLock();
    this.lastTradeTime = Date.now();
    this.persist();

    const won = profit > 0;
    const emoji = won ? '✅' : '❌';
    this.logger.info(
      `${emoji} ${won ? 'WIN' : 'LOSS'} | P/L: ${profit > 0 ? '+' : ''}$${profit.toFixed(2)} ` +
      `| Daily: $${stats.dailyPnL} | WR: ${stats.winRate}% | Trades: ${stats.trades}`
    );

    await this.tg.send(this._formatCompleteMessage({
      trade,
      contract,
      profit,
      won,
      stats,
      exitAnalysis,
      exitSpot,
      closedAt,
      closedStamp: `${clock.stamp} ${clock.tzLabel}`,
    }));

    const canTrade = this.risk.canTrade();
    if (!canTrade.allowed) {
      this.sessionOver = true;
      this.sessionOverReason = canTrade.reason;
      this.persist();
      await this.tg.send(
        `🛑 <b>Session Over:</b> ${escapeHtml(canTrade.reason)}\n` +
        `Time: <code>${clock.stamp} ${clock.tzLabel}</code>`
      );
    }
  }

  _formatCompleteMessage({ trade, contract, profit, won, stats, exitAnalysis, exitSpot, closedAt, closedStamp }) {
    const dur = trade?.openedAt ? fmtDuration(closedAt - trade.openedAt) : '—';
    const entrySpot = trade?.analysis?.spot ?? trade?.spot;
    const move = (Number.isFinite(num(exitSpot, NaN)) && Number.isFinite(num(entrySpot, NaN)))
      ? num(exitSpot) - num(entrySpot)
      : NaN;
    const moveStr = Number.isFinite(move)
      ? `${move >= 0 ? '+' : ''}${fmtPx(move, 2)}`
      : '—';
    const aligned = Number.isFinite(move) && trade?.direction
      ? (trade.direction === 'RISE' ? move > 0 : move < 0)
      : null;
    const status = String(contract?.status || (won ? 'won' : 'lost'));
    const conf = trade?.confidence != null ? `${num(trade.confidence).toFixed(0)}%` : '—';

    return [
      `${won ? '✅' : '❌'} <b>TRADE COMPLETED — ${won ? 'WIN' : 'LOSS'}</b>`,
      `━━━━━━━━━━━━━━━━`,
      `Dir: <b>${escapeHtml(trade?.direction || '—')}</b>  (${escapeHtml(trade?.type || '—')})`,
      `Result: <b>${escapeHtml(status.toUpperCase())}</b>`,
      `P/L: <b>${money(profit, true)}</b>   stake ${money(trade?.stake || 0)}`,
      `Entry → Exit: <code>${fmtPx(entrySpot, 2)}</code> → <code>${fmtPx(exitSpot, 2)}</code>  (${moveStr})`,
      aligned == null ? null : `Price move vs call: ${aligned ? '✔ agreed' : '✘ opposed'}`,
      `Contract: <code>${trade?.contractId || contract?.contract_id || '—'}</code>`,
      ``,
      analysisBlock(trade?.analysis, 'Entry analysis'),
      trade?.reason ? `Why: <i>${escapeHtml(trade.reason)}</i>` : null,
      `Confidence at entry: ${conf}`,
      ``,
      analysisBlock(exitAnalysis, 'Exit snapshot'),
      ``,
      `<b>🕐 Timing</b>`,
      `Executed:  <code>${trade?.openedStamp || '—'}</code>`,
      `Completed: <code>${closedStamp}</code>`,
      `Duration:  <b>${dur}</b>`,
      this.schedule.cfg.enabled ? this.schedule.nextTransition().label : 'Schedule off (24/7)',
      ``,
      statsBlock(stats, this.api.balance),
    ].filter(v => v !== null).join('\n');
  }

  async shutdown() {
    this.logger.info('Shutting down — flushing state (open contract kept)');
    if (this.scheduleTimer) { clearInterval(this.scheduleTimer); this.scheduleTimer = null; }
    this.persist(true);
    this.api.shutdown();
    await this.tg.stop();
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================
let bot = null;

(async () => {
  bot = new DerivBot();
  await bot.start();
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

function handleExit(signal) {
  console.log(`\n${signal} received`);
  if (!bot) process.exit(0);
  bot.shutdown().finally(() => process.exit(0));
}

process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
});
