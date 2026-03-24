#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════════════════════╗
// ║   STEP INDEX GRID MARTINGALE BOT — Headless Terminal Edition (FIXED v2)       ║
// ║   Volatility STEP Index | CALLE/PUTE | Low-Risk Hybrid                        ║
// ║   NEW: Trade on new candle, recovery trades until win, then wait for candle    ║
// ║   ENHANCED: Stuck trade recovery with pause and reset                          ║
// ║   FIXED: Network recovery, daily stats, auto-compounding                      ║
// ╚══════════════════════════════════════════════════════════════════════════════════╝

'use strict';

require('dotenv').config();

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  apiToken: 'Dz2V2KvRf4Uukt3',
  appId: '1089',

  symbol: 'stpRNG',
  tickDuration: 5,
  initialStake: 0.35,
  investmentAmount: 153,

  martingaleMultiplier: 1.48,
  maxMartingaleLevel: 1,
  afterMaxLoss: 'continue',
  continueExtraLevels: 8,
  extraLevelMultipliers: [1.8, 2.1, 2.1, 2.1, 2.1, 2.1, 2.1],

  autoCompounding: true,
  compoundPercentage: 0.20,

  // Auto-compounding step config:
  // baseStake increases by compoundStakeStep for every compoundInvestmentStep increase in investmentAmount
  compoundInvestmentStep: 153,  // every 153 increase in investment
  compoundStakeStep: 0.35,  // increases baseStake by 0.5

  stopLoss: 5000,
  takeProfit: 10000,

  // Stuck trade recovery settings
  stuckTradePauseDuration: 5 * 60 * 1000,

  telegramToken: '8343520432:AAGNxzjnljOEhfv_rE-y-F98fUDPmrqZuXc',
  telegramChatId: '752497117',
  telegramEnabled: true,
};

// ══════════════════════════════════════════════════════════════════════════════
// FILE PATHS
// ══════════════════════════════════════════════════════════════════════════════

const STATE_FILE = path.join(__dirname, 'ST1n-grid-state000000001.json');
const DAILY_STATS_FILE = path.join(__dirname, 'ST1n-daily-stats0001.json');
const STATE_SAVE_INTERVAL = 5000;

// ══════════════════════════════════════════════════════════════════════════════
// STATE PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════

class StatePersistence {
  static save(bot) {
    try {
      const payload = {
        savedAt: Date.now(),
        trading: {
          running: bot.running,
          totalProfit: bot.totalProfit,
          totalTrades: bot.totalTrades,
          wins: bot.wins,
          losses: bot.losses,
          currentGridLevel: bot.currentGridLevel,
          currentDirection: bot.currentDirection,
          baseStake: bot.baseStake,
          chainBaseStake: bot.chainBaseStake,
          investmentRemaining: bot.investmentRemaining,
          investmentStartAmount: bot.investmentStartAmount,
          totalRecovered: bot.totalRecovered,
          maxWinStreak: bot.maxWinStreak,
          maxLossStreak: bot.maxLossStreak,
          currentStreak: bot.currentStreak,
          inRecoveryMode: bot.inRecoveryMode,
          currentContractId: bot.currentContractId,
          isPausedDueToStuckTrade: bot.isPausedDueToStuckTrade,
          stuckTradePauseEnd: bot.stuckTradePauseEnd || null,
          stuckTradeCount: bot.stuckTradeCount,
        },
        dailyStats: bot.dailyStats || null,
        hourlyStats: bot.hourlyStats || null,
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      console.error(`[StatePersistence] save error: ${e.message}`);
    }
  }

  static load() {
    try {
      if (!fs.existsSync(STATE_FILE)) return null;
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const ageMin = (Date.now() - data.savedAt) / 60000;
      // Extended to 120 minutes to handle longer outages
      if (ageMin > 120) {
        console.warn(`[StatePersistence] State is ${ageMin.toFixed(1)} min old — discarding`);
        fs.unlinkSync(STATE_FILE);
        return null;
      }
      console.log(`[StatePersistence] Restoring state from ${ageMin.toFixed(1)} min ago`);
      return data;
    } catch (e) {
      console.error(`[StatePersistence] load error: ${e.message}`);
      return null;
    }
  }

  static startAutoSave(bot) {
    if (bot._autoSaveInterval) return;
    bot._autoSaveInterval = setInterval(() => {
      if (bot.running || bot.totalTrades > 0) StatePersistence.save(bot);
    }, STATE_SAVE_INTERVAL);
    console.log('[StatePersistence] Auto-save every 5 s ✅');
  }

  // ── Daily Stats Persistence ─────────────────────────────────────────────
  static saveDailyStats(stats) {
    try {
      let allStats = {};
      if (fs.existsSync(DAILY_STATS_FILE)) {
        allStats = JSON.parse(fs.readFileSync(DAILY_STATS_FILE, 'utf8'));
      }
      const dateKey = stats.date;
      allStats[dateKey] = stats;

      // Keep last 30 days only
      const keys = Object.keys(allStats).sort();
      if (keys.length > 30) {
        keys.slice(0, keys.length - 30).forEach(k => delete allStats[k]);
      }

      fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(allStats, null, 2), 'utf8');
    } catch (e) {
      console.error(`[StatePersistence] saveDailyStats error: ${e.message}`);
    }
  }

  static loadDailyStats(dateKey) {
    try {
      if (!fs.existsSync(DAILY_STATS_FILE)) return null;
      const allStats = JSON.parse(fs.readFileSync(DAILY_STATS_FILE, 'utf8'));
      return allStats[dateKey] || null;
    } catch (e) {
      console.error(`[StatePersistence] loadDailyStats error: ${e.message}`);
      return null;
    }
  }

  static loadAllDailyStats() {
    try {
      if (!fs.existsSync(DAILY_STATS_FILE)) return {};
      return JSON.parse(fs.readFileSync(DAILY_STATS_FILE, 'utf8'));
    } catch (e) {
      console.error(`[StatePersistence] loadAllDailyStats error: ${e.message}`);
      return {};
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════

class STEPINDEXGridBot {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // ── WebSocket ───────────────────────────────────────────────────────────
    this.ws = null;
    this.isConnected = false;
    this.isAuthorized = false;
    this.reqId = 1;

    // ── Reconnection ────────────────────────────────────────────────────────
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.reconnectDelay = 5000;
    this.reconnectTimer = null;
    this.isReconnecting = false;

    // ── Ping / Keepalive ────────────────────────────────────────────────────
    this.pingInterval = null;
    this.lastPongTime = Date.now();

    // ── Trade Watchdog ───────────────────────────────────────────────────────
    this.tradeWatchdogTimer = null;
    this.tradeWatchdogPollTimer = null;
    this.tradeWatchdogMs = 10000;
    this.tradeStartTime = null;

    // ── Stuck Trade Pause State ──────────────────────────────────────────────
    this.isPausedDueToStuckTrade = false;
    this.stuckTradePauseTimer = null;
    this.stuckTradePauseEnd = null;   // absolute timestamp when pause ends
    this.stuckTradeCount = 0;

    // ── Message queue ────────────────────────────────────────────────────────
    this.messageQueue = [];
    this.maxQueueSize = 50;

    // ── Account ──────────────────────────────────────────────────────────────
    this.balance = 0;
    this.currency = 'USD';
    this.accountId = '';

    // ── Session trading state ────────────────────────────────────────────────
    this.running = false;
    this.tradeInProgress = false;
    this.currentContractId = null;
    this.pendingTradeInfo = null;

    this.currentGridLevel = 0;
    this.currentDirection = 'CALLE';
    this.baseStake = this.config.initialStake;
    this.chainBaseStake = this.config.initialStake;
    this.investmentRemaining = 0;
    this.investmentStartAmount = 0;
    this.totalProfit = 0;
    this.totalTrades = 0;
    this.wins = 0;
    this.losses = 0;
    this.currentStreak = 0;
    this.maxWinStreak = 0;
    this.maxLossStreak = 0;
    this.totalRecovered = 0;

    // ── Candle tracking ─────────────────────────────────────────────────────
    this.assetState = {
      candles: [],
      closedCandles: [],
      currentFormingCandle: null,
      lastProcessedCandleOpenTime: null,
      candlesLoaded: false,
    };
    this.candleConfig = {
      GRANULARITY: 60,
      MAX_CANDLES_STORED: 100,
      CANDLES_TO_LOAD: 50,
    };

    // ── Candle subscription tracking ────────────────────────────────────────
    this._candleSubId = null;    // subscription id returned by Deriv

    // ══════════════════════════════════════════════════════════════════════
    // CANDLE-GATED TRADING + RECOVERY LOGIC
    // ══════════════════════════════════════════════════════════════════════
    this.canTrade = false;
    this.inRecoveryMode = false;

    // ── Session control ──────────────────────────────────────────────────────
    this.endOfDay = false;
    this.isWinTrade = false;
    this.hasStartedOnce = false;
    this._autoSaveInterval = null;

    this._processedContracts = new Set();
    this._maxProcessedCache = 200;

    // ── Retry scheduling guard ───────────────────────────────────────────────
    this._retryTimer = null;

    // ── Hourly Telegram stats ─────────────────────────────────────────────────
    this.hourlyStats = {
      trades: 0, wins: 0, losses: 0, pnl: 0,
      lastHour: new Date().getHours(),
    };

    // ── Daily Stats ───────────────────────────────────────────────────────────
    this._initDailyStats();

    // ── Telegram ─────────────────────────────────────────────────────────────
    this.telegramBot = null;
    if (this.config.telegramEnabled && this.config.telegramToken && this.config.telegramChatId) {
      try {
        this.telegramBot = new TelegramBot(this.config.telegramToken, { polling: false });
        this.log('Telegram notifications enabled ✅');
      } catch (e) {
        this.log(`Telegram init error: ${e.message}`, 'warning');
      }
    } else {
      this.log('Telegram disabled — no token/chat-id configured', 'warning');
    }

    // ── Restore saved state ───────────────────────────────────────────────────
    this._restoreState();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // DAILY STATS MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════════

  _getTodayKey() {
    // Always use GMT+1 (UTC+1) for the daily key so stats align to the
    // Lagos / West Africa / Central European Standard Time calendar day.
    const gmt1 = new Date(Date.now() + 60 * 60 * 1000); // shift UTC → GMT+1
    const yyyy = gmt1.getUTCFullYear();
    const mm = String(gmt1.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(gmt1.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  _initDailyStats() {
    const today = this._getTodayKey();

    // Try to load existing daily stats for today
    const saved = StatePersistence.loadDailyStats(today);
    if (saved) {
      this.dailyStats = saved;
      this.log(`📊 Loaded existing daily stats for ${today}`, 'success');
    } else {
      this.dailyStats = {
        date: today,
        startTime: new Date().toISOString(),
        endTime: null,
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        peakPnl: 0,
        worstPnl: 0,
        startBalance: 0,
        endBalance: 0,
        startInvestment: 0,
        endInvestment: 0,
        maxGridLevel: 0,
        recoveryCount: 0,
        totalRecovered: 0,
        maxWinStreak: 0,
        maxLossStreak: 0,
        stuckTradeCount: 0,
        largestWin: 0,
        largestLoss: 0,
        tradeLog: [],  // last N trade results
      };
    }
  }

  _updateDailyStats(isWin, profit) {
    const today = this._getTodayKey();

    // Check if day has changed
    if (this.dailyStats.date !== today) {
      // Send summary for previous day before resetting
      this._sendDailySummary();
      this._initDailyStats();
      this.dailyStats.startBalance = this.balance;
      this.dailyStats.startInvestment = this.investmentRemaining;
    }

    this.dailyStats.trades++;
    if (isWin) this.dailyStats.wins++;
    else this.dailyStats.losses++;

    this.dailyStats.pnl = Number((this.dailyStats.pnl + profit).toFixed(2));
    this.dailyStats.peakPnl = Math.max(this.dailyStats.peakPnl, this.dailyStats.pnl);
    this.dailyStats.worstPnl = Math.min(this.dailyStats.worstPnl, this.dailyStats.pnl);

    if (isWin) this.dailyStats.largestWin = Math.max(this.dailyStats.largestWin, profit);
    if (!isWin) this.dailyStats.largestLoss = Math.min(this.dailyStats.largestLoss, profit);

    this.dailyStats.maxGridLevel = Math.max(this.dailyStats.maxGridLevel, this.currentGridLevel);
    this.dailyStats.endBalance = this.balance;
    this.dailyStats.endInvestment = this.investmentRemaining;
    this.dailyStats.endTime = new Date().toISOString();
    this.dailyStats.stuckTradeCount = this.stuckTradeCount;

    // Compute streaks for daily stats
    if (isWin) {
      this.dailyStats.maxWinStreak = Math.max(
        this.dailyStats.maxWinStreak,
        this.currentStreak > 0 ? this.currentStreak : 0
      );
    } else {
      this.dailyStats.maxLossStreak = Math.max(
        this.dailyStats.maxLossStreak,
        this.currentStreak < 0 ? Math.abs(this.currentStreak) : 0
      );
    }

    if (this.inRecoveryMode && isWin) {
      this.dailyStats.recoveryCount++;
      this.dailyStats.totalRecovered = Number(
        (this.dailyStats.totalRecovered + profit).toFixed(2)
      );
    }

    // Keep last 50 trade results for reference
    this.dailyStats.tradeLog.push({
      time: new Date().toISOString(),
      result: isWin ? 'WIN' : 'LOSS',
      profit: profit,
      level: this.currentGridLevel,
      direction: this.currentDirection,
      stake: this.pendingTradeInfo?.stake || 0,
    });
    if (this.dailyStats.tradeLog.length > 50) {
      this.dailyStats.tradeLog = this.dailyStats.tradeLog.slice(-50);
    }

    // Persist daily stats
    StatePersistence.saveDailyStats(this.dailyStats);
  }

  async _sendDailySummary() {
    const s = this.dailyStats;
    const wr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0.0';

    const message =
      `📅 <b>${DEFAULT_CONFIG.symbol} — DAILY SUMMARY</b>\n` +
      `📆 Date: ${s.date}\n` +
      `⏰ ${s.startTime} → ${s.endTime || new Date().toISOString()}\n\n` +
      `📊 <b>Trading Results:</b>\n` +
      `  Total Trades: ${s.trades}\n` +
      `  Wins: ${s.wins} | Losses: ${s.losses}\n` +
      `  Win Rate: ${wr}%\n\n` +
      `💰 <b>P&L:</b>\n` +
      `  ${s.pnl >= 0 ? '🟢' : '🔴'} Day P&L: ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}\n` +
      `  📈 Peak P&L: +$${s.peakPnl.toFixed(2)}\n` +
      `  📉 Worst P&L: $${s.worstPnl.toFixed(2)}\n` +
      `  🏆 Largest Win: +$${s.largestWin.toFixed(2)}\n` +
      `  💀 Largest Loss: $${s.largestLoss.toFixed(2)}\n\n` +
      `💵 <b>Balance:</b>\n` +
      `  Start: $${s.startBalance.toFixed(2)}\n` +
      `  End: $${(s.endBalance || this.balance).toFixed(2)}\n` +
      `  Change: ${((s.endBalance || this.balance) - s.startBalance) >= 0 ? '+' : ''}$${((s.endBalance || this.balance) - s.startBalance).toFixed(2)}\n\n` +
      `📊 <b>Investment Pool:</b>\n` +
      `  Start: $${s.startInvestment.toFixed(2)}\n` +
      `  End: $${(s.endInvestment || this.investmentRemaining).toFixed(2)}\n\n` +
      `🔄 <b>Recovery Stats:</b>\n` +
      `  Recoveries: ${s.recoveryCount}\n` +
      `  Total Recovered: $${s.totalRecovered.toFixed(2)}\n` +
      `  Max Grid Level: L${s.maxGridLevel}\n` +
      `  Max Win Streak: ${s.maxWinStreak}\n` +
      `  Max Loss Streak: ${s.maxLossStreak}\n` +
      `  Stuck Trades: ${s.stuckTradeCount}\n`;

    await this._sendTelegram(message);
    this.log(`📅 Daily summary sent for ${s.date}`, 'success');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // STATE RESTORE - ENHANCED
  // ══════════════════════════════════════════════════════════════════════════════

  _restoreState() {
    const saved = StatePersistence.load();
    if (!saved) return;
    const t = saved.trading;
    this.running = t.running || false;
    this.totalProfit = t.totalProfit || 0;
    this.totalTrades = t.totalTrades || 0;
    this.wins = t.wins || 0;
    this.losses = t.losses || 0;
    this.currentGridLevel = t.currentGridLevel || 0;
    this.currentDirection = t.currentDirection || 'CALLE';
    this.baseStake = t.baseStake || this.config.initialStake;
    this.chainBaseStake = t.chainBaseStake || this.baseStake;
    this.investmentRemaining = t.investmentRemaining || 0;
    this.investmentStartAmount = t.investmentStartAmount || this.config.investmentAmount;
    this.totalRecovered = t.totalRecovered || 0;
    this.maxWinStreak = t.maxWinStreak || 0;
    this.maxLossStreak = t.maxLossStreak || 0;
    this.currentStreak = t.currentStreak || 0;
    this.inRecoveryMode = t.inRecoveryMode || false;
    this.currentContractId = t.currentContractId || null;
    this.stuckTradeCount = t.stuckTradeCount || 0;

    // Restore paused state
    this.isPausedDueToStuckTrade = t.isPausedDueToStuckTrade || false;
    this.stuckTradePauseEnd = t.stuckTradePauseEnd || null;

    // Restore hourly stats
    if (saved.hourlyStats) {
      this.hourlyStats = saved.hourlyStats;
    }

    // Restore daily stats
    if (saved.dailyStats && saved.dailyStats.date === this._getTodayKey()) {
      this.dailyStats = saved.dailyStats;
    }

    // Determine canTrade based on restored state
    if (this.isPausedDueToStuckTrade && this.stuckTradePauseEnd) {
      const remaining = this.stuckTradePauseEnd - Date.now();
      if (remaining > 0) {
        this.canTrade = false;
        this.log(`⏸️ Restoring stuck trade pause — ${Math.ceil(remaining / 60000)} min remaining`, 'warning');
        // Re-set the timer for remaining duration
        this.stuckTradePauseTimer = setTimeout(() => {
          this._resumeTradingAfterStuckTradePause();
        }, remaining);
      } else {
        // Pause has expired while we were down
        this.isPausedDueToStuckTrade = false;
        this.stuckTradePauseEnd = null;
        this.canTrade = !this.inRecoveryMode ? false : true;
        this.log('⏸️ Stuck trade pause expired during downtime — resuming normally', 'info');
      }
    } else {
      this.canTrade = this.inRecoveryMode;
    }

    this.hasStartedOnce = true;

    this.log(
      `State restored | Running: ${this.running} | Trades: ${this.totalTrades} | ` +
      `W/L: ${this.wins}/${this.losses} | P&L: $${this.totalProfit.toFixed(2)} | ` +
      `Level: ${this.currentGridLevel} | Recovery: ${this.inRecoveryMode ? 'YES' : 'NO'} | ` +
      `Paused: ${this.isPausedDueToStuckTrade ? 'YES' : 'NO'} | ` +
      `Contract: ${this.currentContractId || 'none'}`,
      'success'
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // LOGGING
  // ══════════════════════════════════════════════════════════════════════════════

  log(message, type = 'info') {
    const ts = new Date().toISOString();
    const emoji = { error: '❌', success: '✅', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
    console.log(`[${ts}] ${emoji} ${message}`);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // AUTO-COMPOUNDING — INTELLIGENT STEP SYSTEM
  // ══════════════════════════════════════════════════════════════════════════════

  _calculateCompoundedBaseStake() {
    const cfg = this.config;
    if (!cfg.autoCompounding) return cfg.initialStake;

    const baseInvestment = cfg.investmentAmount;           // starting reference (153)
    const currentPool = this.investmentRemaining;
    const investmentStep = cfg.compoundInvestmentStep;     // 153
    const stakeStep = cfg.compoundStakeStep;          // 0.5

    // How much has the investment grown above the base?
    const growth = currentPool - baseInvestment;

    if (growth <= 0) {
      // Pool hasn't grown — use initial stake
      return cfg.initialStake;
    }

    // Number of full steps completed
    const steps = Math.floor(growth / investmentStep);

    // New base stake = initial + (steps × stakeStep)
    const newBase = cfg.initialStake + (steps * stakeStep);

    return Math.max(newBase, cfg.initialStake);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // STAKE CALCULATOR - UPDATED FOR INTELLIGENT COMPOUNDING
  // ══════════════════════════════════════════════════════════════════════════════

  calculateStake(level) {
    const cfg = this.config;

    // Use the intelligent compounding system
    let base = this._calculateCompoundedBaseStake();
    base = Math.max(base, 0.35);

    // Store the computed base for logging
    this.baseStake = base;

    if (level <= cfg.maxMartingaleLevel) {
      return Number((base * Math.pow(cfg.martingaleMultiplier, level)).toFixed(2));
    }

    let stake = base * Math.pow(cfg.martingaleMultiplier, cfg.maxMartingaleLevel);
    const extraIdx = level - cfg.maxMartingaleLevel - 1;
    const mults = cfg.extraLevelMultipliers || [];
    for (let i = 0; i <= extraIdx; i++) {
      stake *= (mults[i] > 0 ? mults[i] : cfg.martingaleMultiplier);
    }
    return Number(stake.toFixed(2));
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // WEBSOCKET — CONNECT
  // ══════════════════════════════════════════════════════════════════════════════

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.log('Already connected', 'warning');
      return;
    }

    this._cleanupWs();

    const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.config.appId}`;
    this.log(`Connecting to Deriv WebSocket… (attempt ${this.reconnectAttempts + 1})`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => this._onOpen());
      this.ws.on('message', data => this._onRawMessage(data));
      this.ws.on('error', err => this._onError(err));
      this.ws.on('close', (code) => this._onClose(code));
    } catch (err) {
      this.log(`WebSocket creation error: ${err.message}`, 'error');
      this._scheduleReconnect();
    }
  }

  _onOpen() {
    this.log('WebSocket connected ✅', 'success');
    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this.lastPongTime = Date.now();

    this._startPing();

    StatePersistence.startAutoSave(this);

    this._send({ authorize: this.config.apiToken });
  }

  _onError(err) {
    this.log(`WebSocket error: ${err.message}`, 'error');
  }

  _onClose(code) {
    this.log(`WebSocket closed (code: ${code})`, 'warning');
    this.isConnected = false;
    this.isAuthorized = false;

    this._stopPing();
    this._clearAllWatchdogTimers();
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }

    // DON'T clear tradeInProgress here — we want to know on reconnect
    // whether we need to check for an open contract
    this.pendingTradeInfo = null;

    StatePersistence.save(this);

    if (this.endOfDay) {
      this.log('Planned disconnect — not reconnecting');
      return;
    }

    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.isReconnecting) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('Max reconnect attempts reached — will keep trying every 60s', 'error');
      this._sendTelegram(
        `❌ <b>${DEFAULT_CONFIG.symbol} Max reconnect attempts reached</b>\n` +
        `Will keep trying every 60s…\n` +
        `Final P&L: $${this.totalProfit.toFixed(2)}`
      );
      // Don't give up entirely — keep trying with a longer delay
      this.isReconnecting = true;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.isReconnecting = false;
        this.reconnectAttempts = Math.floor(this.maxReconnectAttempts / 2); // reset partially
        this.connect();
      }, 60000);
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

    this.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})…`);
    this.log(
      `State preserved — Trades: ${this.totalTrades} | P&L: $${this.totalProfit.toFixed(2)} | ` +
      `Level: ${this.currentGridLevel} | Recovery: ${this.inRecoveryMode}`
    );

    this._sendTelegram(
      `⚠️ <b>${DEFAULT_CONFIG.symbol} CONNECTION LOST — RECONNECTING</b>\n` +
      `Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
      `Retrying in ${(delay / 1000).toFixed(1)}s\n` +
      `State preserved: ${this.totalTrades} trades | $${this.totalProfit.toFixed(2)} P&L | ` +
      `Level: ${this.currentGridLevel}`
    );

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.isReconnecting = false;
      this.connect();
    }, delay);
  }

  _cleanupWs() {
    this._stopPing();
    this._clearAllWatchdogTimers();
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch (_) { }
      this.ws = null;
    }
    this.isConnected = false;
    this.isAuthorized = false;
    this._candleSubId = null;
  }

  disconnect() {
    this.log('Disconnecting…');
    StatePersistence.save(this);
    this.endOfDay = true;
    this._cleanupWs();
    this.log('Disconnected ✅', 'success');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // WEBSOCKET — SEND
  // ══════════════════════════════════════════════════════════════════════════════

  _send(request) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log(`Cannot send (not connected): ${JSON.stringify(request).substring(0, 80)}`, 'warning');
      return null;
    }
    request.req_id = this.reqId++;
    try {
      this.ws.send(JSON.stringify(request));
      return request.req_id;
    } catch (e) {
      this.log(`Send error: ${e.message}`, 'error');
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PING / KEEPALIVE — ENHANCED WITH PONG MONITORING
  // ══════════════════════════════════════════════════════════════════════════════

  _startPing() {
    this._stopPing();
    this.lastPongTime = Date.now();

    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Check if we've received a pong recently (within 15s)
        const timeSinceLastPong = Date.now() - this.lastPongTime;
        if (timeSinceLastPong > 15000) {
          this.log(`⚠️ No pong received for ${(timeSinceLastPong / 1000).toFixed(0)}s — connection may be dead`, 'warning');
          // Force close and reconnect
          try { this.ws.close(4000, 'ping_timeout'); } catch (_) { }
          return;
        }
        this._send({ ping: 1 });
      }
    }, 5000);
  }

  _stopPing() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // MESSAGE ROUTER
  // ══════════════════════════════════════════════════════════════════════════════

  _onRawMessage(data) {
    try {
      this._handleMessage(JSON.parse(data));
    } catch (e) {
      this.log(`Parse error: ${e.message}`, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // MESSAGE HANDLER
  // ══════════════════════════════════════════════════════════════════════════════

  _handleMessage(msg) {
    // Track pong responses
    if (msg.msg_type === 'ping' || msg.ping) {
      this.lastPongTime = Date.now();
      return;
    }

    if (msg.error) {
      this._handleApiError(msg);
      return;
    }

    switch (msg.msg_type) {
      case 'authorize': this._onAuthorize(msg); break;
      case 'balance': this._onBalance(msg); break;
      case 'proposal': this._onProposal(msg); break;
      case 'buy': this._onBuy(msg); break;
      case 'proposal_open_contract': this._onContract(msg); break;
      case 'ohlc': this._handleOHLC(msg.ohlc); break;
      case 'candles': this._handleCandlesHistory(msg); break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // CANDLE HANDLER — NEW CANDLE DETECTION
  // ══════════════════════════════════════════════════════════════════════════════

  _handleOHLC(ohlc) {
    // Track subscription id
    if (ohlc.id) this._candleSubId = ohlc.id;

    const symbol = ohlc.symbol;
    const calculatedOpenTime = ohlc.open_time ||
      Math.floor(ohlc.epoch / this.candleConfig.GRANULARITY) * this.candleConfig.GRANULARITY;

    const incomingCandle = {
      open: parseFloat(ohlc.open),
      high: parseFloat(ohlc.high),
      low: parseFloat(ohlc.low),
      close: parseFloat(ohlc.close),
      epoch: ohlc.epoch,
      open_time: calculatedOpenTime,
    };

    const currentOpenTime = this.assetState.currentFormingCandle?.open_time;
    const isNewCandle = currentOpenTime && incomingCandle.open_time !== currentOpenTime;

    // ── NEW CANDLE DETECTED ───────────────────────────────────────────────
    if (isNewCandle) {
      const closedCandle = { ...this.assetState.currentFormingCandle };
      closedCandle.epoch = closedCandle.open_time + this.candleConfig.GRANULARITY;

      if (closedCandle.open_time !== this.assetState.lastProcessedCandleOpenTime) {
        this.assetState.closedCandles.push(closedCandle);

        if (this.assetState.closedCandles.length > this.candleConfig.MAX_CANDLES_STORED) {
          this.assetState.closedCandles = this.assetState.closedCandles.slice(
            -this.candleConfig.MAX_CANDLES_STORED
          );
        }

        this.assetState.lastProcessedCandleOpenTime = closedCandle.open_time;

        const closeTime = new Date(closedCandle.epoch * 1000).toISOString();
        const candleType = closedCandle.close > closedCandle.open
          ? 'BULLISH'
          : closedCandle.close < closedCandle.open
            ? 'BEARISH'
            : 'DOJI';
        const candleEmoji = candleType === 'BULLISH' ? '🟢' : candleType === 'BEARISH' ? '🔴' : '⚪';

        this.log(
          `${symbol} ${candleEmoji} NEW CANDLE [${closeTime}] ${candleType}: ` +
          `O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} ` +
          `L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)}`
        );

        // ════════════════════════════════════════════════════════════════════
        // CANDLE-GATED TRADE TRIGGER
        // ════════════════════════════════════════════════════════════════════
        if (this.isPausedDueToStuckTrade) {
          this.log(`📊 NEW CANDLE — but trading is paused (stuck trade recovery)`, 'warning');
        } else if (this.inRecoveryMode) {
          this.log(
            `📊 NEW CANDLE — in RECOVERY mode (L${this.currentGridLevel}), ` +
            `recovery trades continue independently`,
            'info'
          );
        } else {
          this.log(`📊 NEW CANDLE — Ready for fresh trade 🚀`, 'success');
          this.canTrade = true;

          if (this.running && !this.tradeInProgress && this.canTrade) {
            this._placeTrade(candleType, candleEmoji);
          }
        }
      }
    }

    this.assetState.currentFormingCandle = incomingCandle;

    const candles = this.assetState.candles;
    const existingIndex = candles.findIndex(c => c.open_time === incomingCandle.open_time);
    if (existingIndex >= 0) {
      candles[existingIndex] = incomingCandle;
    } else {
      candles.push(incomingCandle);
    }

    if (candles.length > this.candleConfig.MAX_CANDLES_STORED) {
      this.assetState.candles = candles.slice(-this.candleConfig.MAX_CANDLES_STORED);
    }
  }

  _handleCandlesHistory(response) {
    if (response.error) {
      this.log(`Error fetching candles: ${response.error.message}`, 'error');
      return;
    }

    const symbol = response.echo_req.ticks_history;
    if (!symbol) return;

    if (!response.candles || response.candles.length === 0) {
      this.log(`${symbol}: No historical candles received`, 'warning');
      return;
    }

    const candles = response.candles.map(c => {
      const openTime = Math.floor(
        (c.epoch - this.candleConfig.GRANULARITY) / this.candleConfig.GRANULARITY
      ) * this.candleConfig.GRANULARITY;
      return {
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        epoch: c.epoch,
        open_time: openTime,
      };
    });

    this.assetState.candles = [...candles];
    this.assetState.closedCandles = [...candles];

    const lastCandle = candles[candles.length - 1];
    this.assetState.lastProcessedCandleOpenTime = lastCandle.open_time;
    this.assetState.currentFormingCandle = null;

    this.log(`📊 Loaded ${candles.length} historical candles for ${symbol}`);

    if (this.isPausedDueToStuckTrade) {
      this.log(`📊 Paused due to stuck trade — waiting for pause to end`, 'warning');
      this.canTrade = false;
    } else if (this.inRecoveryMode) {
      this.log(`📊 In recovery mode — canTrade stays true for recovery trades`, 'warning');
      this.canTrade = true;
    } else {
      this.log(`📊 Waiting for next new candle to start trading…`, 'info');
      this.canTrade = false;
    }

    this.assetState.candlesLoaded = true;
  }

  _handleApiError(msg) {
    this.log(
      `API Error [${msg.error.code}]: ${msg.error.message} (msg_type: ${msg.msg_type})`,
      'error'
    );

    const code = msg.error.code;
    if (code === 'AuthorizationRequired' || code === 'InvalidToken') {
      this.isAuthorized = false;
      this._onClose(4001);
      return;
    }

    // Rate limit — back off
    if (code === 'RateLimit' || code === 'TooManyRequests') {
      this.log('Rate limited — backing off for 10s', 'warning');
      this.tradeInProgress = false;
      this.pendingTradeInfo = null;
      this.currentContractId = null;
      this._clearAllWatchdogTimers();

      if (this._retryTimer) clearTimeout(this._retryTimer);
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        if (this.running && !this.tradeInProgress && this.canTrade) {
          this._placeTrade();
        }
      }, 10000);
      return;
    }

    if (msg.msg_type === 'buy' || msg.msg_type === 'proposal') {
      this.log('Trade error — releasing lock and retrying in 3s', 'warning');
      this._clearAllWatchdogTimers();
      this.tradeInProgress = false;
      this.pendingTradeInfo = null;
      this.currentContractId = null;

      if (this.running) {
        // Use a guarded retry with a timer to prevent rapid looping
        if (this._retryTimer) clearTimeout(this._retryTimer);
        this._retryTimer = setTimeout(() => {
          this._retryTimer = null;
          if (this.running && !this.tradeInProgress && this.canTrade) {
            this.log('Retrying trade after API error…');
            this._placeTrade();
          }
        }, 3000);
      }
    }
  }

  // ── authorize ─────────────────────────────────────────────────────────────
  _onAuthorize(msg) {
    if (msg.error) {
      this.log(`Authentication failed: ${msg.error.message}`, 'error');
      this._sendTelegram(
        `❌ <b>${DEFAULT_CONFIG.symbol} Authentication Failed:</b> ${msg.error.message}`
      );
      return;
    }

    this.isAuthorized = true;
    this.accountId = msg.authorize.loginid;
    this.balance = msg.authorize.balance;
    this.currency = msg.authorize.currency;

    this.log(
      `Authorized ✅ | Account: ${this.accountId} | Balance: ${this.currency} ${this.balance.toFixed(2)}`,
      'success'
    );

    this._send({ balance: 1, subscribe: 1 });

    // Subscribe to candles (fresh subscription after reconnect)
    this._subscribeToCandles(this.config.symbol);

    if (!this.hasStartedOnce) {
      // First-time connection
      this._sendTelegram(
        `✅ <b>${DEFAULT_CONFIG.symbol} Grid Bot Connected</b>\n` +
        `Account: ${this.accountId}\n` +
        `Balance: ${this.currency} ${this.balance.toFixed(2)}`
      );
      setTimeout(() => { if (!this.running) this.start(); }, 300);

    } else {
      // ── RECONNECT LOGIC — ENHANCED ─────────────────────────────────────
      // Don't reset tradeInProgress here; we need to determine the correct state

      this.log(
        `🔄 Reconnected — resuming | L${this.currentGridLevel} | ` +
        `${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} | ` +
        `Investment: $${this.investmentRemaining.toFixed(2)} | ` +
        `Recovery: ${this.inRecoveryMode ? 'YES' : 'NO'} | ` +
        `Paused: ${this.isPausedDueToStuckTrade ? 'YES' : 'NO'}`,
        'success'
      );

      this._sendTelegram(
        `🔄 <b>${DEFAULT_CONFIG.symbol} Reconnected — Resuming</b>\n` +
        `Account: ${this.accountId} | Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
        `Grid Level: ${this.currentGridLevel} | ` +
        `Next: ${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)}\n` +
        `Investment: $${this.investmentRemaining.toFixed(2)}\n` +
        `Recovery Mode: ${this.inRecoveryMode ? 'YES ⚡' : 'NO'}\n` +
        `Paused: ${this.isPausedDueToStuckTrade ? 'YES ⏸️' : 'NO'}`
      );

      // If we had an open contract, try to check its status
      if (this.currentContractId) {
        this.log(`Re-subscribing to open contract ${this.currentContractId}…`);
        this.tradeInProgress = true;
        this._send({
          proposal_open_contract: 1,
          contract_id: this.currentContractId,
          subscribe: 1,
        });
        this._startTradeWatchdog(this.currentContractId);
      } else {
        // No open contract — set tradeInProgress to false
        this.tradeInProgress = false;

        if (this.isPausedDueToStuckTrade) {
          this.log('⏸️ Still paused from stuck trade — waiting for pause to expire', 'info');
        } else if (this.inRecoveryMode) {
          this.canTrade = true;
          this.log('In recovery mode — will trade after candle data loads', 'warning');
          // Wait for candle data to load, then try trading
          this._waitForCandlesAndTrade();
        } else if (this.running) {
          this.log(
            'No open contract — will trade when next candle signal arrives',
            'success'
          );
        }
      }
    }
  }

  /**
   * Wait for candle data to load, then attempt to place a trade
   * Used after reconnection when in recovery mode
   */
  _waitForCandlesAndTrade() {
    let attempts = 0;
    const maxAttempts = 20; // 20 × 500ms = 10s max wait
    const checker = setInterval(() => {
      attempts++;
      if (this.assetState.candlesLoaded) {
        clearInterval(checker);
        if (this.running && !this.tradeInProgress && this.canTrade) {
          this.log('📊 Candles loaded — placing recovery trade', 'success');
          this._placeTrade();
        }
        return;
      }
      if (attempts >= maxAttempts) {
        clearInterval(checker);
        // Candles still not loaded — trade anyway if in recovery
        if (this.running && !this.tradeInProgress && this.canTrade) {
          this.log('📊 Candles not loaded within timeout — placing recovery trade anyway', 'warning');
          this._placeTrade();
        }
      }
    }, 500);
  }

  // ── balance ───────────────────────────────────────────────────────────────
  _onBalance(msg) {
    this.balance = msg.balance.balance;
    this.log(`Balance updated: ${this.currency} ${this.balance.toFixed(2)}`);
  }

  // ── proposal → buy ────────────────────────────────────────────────────────
  _onProposal(msg) {
    if (!this.running || !this.tradeInProgress) return;
    if (msg.proposal) {
      this._send({ buy: msg.proposal.id, price: msg.proposal.ask_price });
    }
  }

  // ── buy confirmation ──────────────────────────────────────────────────────
  _onBuy(msg) {
    const b = msg.buy;
    this.currentContractId = b.contract_id;
    this.tradeStartTime = Date.now();
    this.investmentRemaining = Math.max(
      0,
      Number((this.investmentRemaining - b.buy_price).toFixed(2))
    );

    this.log(
      `Contract opened: ${b.contract_id} | Stake: $${b.buy_price.toFixed(2)} | ` +
      `Investment left: $${this.investmentRemaining.toFixed(2)}`
    );

    // Save state immediately after buying so we have the contract ID
    StatePersistence.save(this);

    this._startTradeWatchdog(b.contract_id);

    this._send({
      proposal_open_contract: 1,
      contract_id: b.contract_id,
      subscribe: 1,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // CONTRACT RESULT — WIN/LOSS HANDLER
  // ══════════════════════════════════════════════════════════════════════════════

  _onContract(msg) {
    const c = msg.proposal_open_contract;
    if (!c.is_sold) return;

    const contractId = String(c.contract_id);
    if (this.currentContractId && contractId !== String(this.currentContractId)) {
      this.log(
        `⚠️ Ignoring stale contract result: ${contractId} (current: ${this.currentContractId})`,
        'warning'
      );
      return;
    }

    if (this._processedContracts.has(contractId)) {
      this.log(`⚠️ Duplicate contract result ignored: ${contractId}`, 'warning');
      return;
    }
    this._processedContracts.add(contractId);
    if (this._processedContracts.size > this._maxProcessedCache) {
      const first = this._processedContracts.values().next().value;
      this._processedContracts.delete(first);
    }

    this._clearAllWatchdogTimers();

    const profit = parseFloat(c.profit);
    const payout = parseFloat(c.payout || 0);
    const isWin = profit > 0;

    this.tradeInProgress = false;
    this.pendingTradeInfo = null;
    this.currentContractId = null;
    this.tradeStartTime = null;

    // ── Update counters ───────────────────────────────────────────────────
    this.totalTrades += 1;
    this.totalProfit = Number((this.totalProfit + profit).toFixed(2));
    if (isWin) { this.wins++; this.isWinTrade = true; }
    else { this.losses++; this.isWinTrade = false; }

    this.currentStreak = isWin
      ? (this.currentStreak > 0 ? this.currentStreak + 1 : 1)
      : (this.currentStreak < 0 ? this.currentStreak - 1 : -1);
    if (isWin) this.maxWinStreak = Math.max(this.currentStreak, this.maxWinStreak);
    if (!isWin) this.maxLossStreak = Math.min(this.currentStreak, this.maxLossStreak);

    this.hourlyStats.trades++;
    this.hourlyStats.pnl += profit;
    if (isWin) this.hourlyStats.wins++; else this.hourlyStats.losses++;

    // ── Update daily stats ───────────────────────────────────────────────
    this._updateDailyStats(isWin, profit);

    // ── Risk management ───────────────────────────────────────────────────
    if (this.totalProfit <= -this.config.stopLoss) {
      this.log(`🛑 STOP LOSS hit! P&L: $${this.totalProfit.toFixed(2)}`, 'error');
      this._sendTelegram(
        `🛑 <b>${DEFAULT_CONFIG.symbol} STOP LOSS REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`
      );
      this._sendDailySummary();
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }
    if (this.totalProfit >= this.config.takeProfit) {
      this.log(`🎉 TAKE PROFIT hit! P&L: $${this.totalProfit.toFixed(2)}`, 'success');
      this._sendTelegram(
        `🎉 <b>${DEFAULT_CONFIG.symbol} TAKE PROFIT REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`
      );
      this._sendDailySummary();
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }

    let shouldContinue = true;
    const cfg = this.config;

    // ══════════════════════════════════════════════════════════════════════
    // WIN HANDLING
    // ══════════════════════════════════════════════════════════════════════
    if (isWin) {
      if (this.currentGridLevel > 0) this.totalRecovered += profit;
      this.investmentRemaining = Number((this.investmentRemaining + payout).toFixed(2));

      const wasRecovery = this.inRecoveryMode;

      // Use intelligent compounding
      const newBase = this._calculateCompoundedBaseStake();
      this.baseStake = Math.max(newBase, 0.35);

      this.log(
        `🎯 WIN +$${profit.toFixed(2)}${wasRecovery ? ' | RECOVERY COMPLETE! 🎉' : ''} | ` +
        `L${this.currentGridLevel} → RESET | ` +
        `Investment: $${this.investmentRemaining.toFixed(2)} | ` +
        `Base stake: $${this.baseStake.toFixed(2)} (step-compounded)`,
        'success'
      );

      this.currentGridLevel = 0;
      this.inRecoveryMode = false;
      this.canTrade = false;

      this.log(`⏳ Waiting for next new candle before placing new trade…`, 'info');

      this._sendTelegramTradeResult(isWin, profit);

      // ══════════════════════════════════════════════════════════════════════
      // LOSS HANDLING
      // ══════════════════════════════════════════════════════════════════════
    } else {
      const nextLevel = this.currentGridLevel + 1;
      const absoluteMax = cfg.afterMaxLoss === 'continue'
        ? cfg.maxMartingaleLevel + cfg.continueExtraLevels
        : cfg.maxMartingaleLevel;

      // === RECOVERY STRATEGY FOR stpRNG ===
      let nextDir;
      if (this.currentGridLevel <= 3) {
        nextDir = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';
      } else if (this.currentGridLevel % 3 === 0) {
        nextDir = this.currentDirection;
      } else {
        nextDir = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';
      }

      this.currentDirection = nextDir;
      this.currentGridLevel = nextLevel;
      this.inRecoveryMode = true;
      this.canTrade = true;

      if (nextLevel > absoluteMax) {
        this.log(
          `🛑 ABSOLUTE CEILING L${absoluteMax} reached — stopping to protect investment`,
          'error'
        );
        this._sendTelegram(
          `🛑 <b>${DEFAULT_CONFIG.symbol} ABSOLUTE MAX LEVEL REACHED (L${absoluteMax})</b>\n` +
          `Investment remaining: $${this.investmentRemaining.toFixed(2)}\n` +
          `Total P&L: $${this.totalProfit.toFixed(2)}`
        );
        shouldContinue = false;
        this.inRecoveryMode = false;
        this.canTrade = false;

      } else if (nextLevel > cfg.maxMartingaleLevel) {
        const extraIdx = nextLevel - cfg.maxMartingaleLevel - 1;
        const extraMult = (cfg.extraLevelMultipliers && cfg.extraLevelMultipliers[extraIdx] > 0)
          ? cfg.extraLevelMultipliers[extraIdx]
          : cfg.martingaleMultiplier;
        const nextStake = this.calculateStake(nextLevel);
        this.log(
          `🔴 LOSS -$${Math.abs(profit).toFixed(2)} | EXTENDED RECOVERY L${nextLevel}/${absoluteMax} | ` +
          `Mult: ${extraMult}x | ${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake} | ⚡ IMMEDIATE RECOVERY`,
          'warning'
        );

      } else if (nextLevel === cfg.maxMartingaleLevel) {
        if (cfg.afterMaxLoss === 'stop') {
          const nextStake = this.calculateStake(nextLevel);
          this.log(
            `⚠️ FINAL attempt (L${cfg.maxMartingaleLevel}) | ` +
            `${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake} | ⚡ IMMEDIATE RECOVERY`,
            'warning'
          );
        } else if (cfg.afterMaxLoss === 'continue') {
          const nextStake = this.calculateStake(nextLevel);
          this.log(
            `⚠️ MAX L${cfg.maxMartingaleLevel} — extending to L${absoluteMax} | ` +
            `Next: ${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake} | ⚡ IMMEDIATE RECOVERY`,
            'warning'
          );
        } else if (cfg.afterMaxLoss === 'reset') {
          this.currentGridLevel = 0;
          this.currentDirection = 'CALLE';
          this.inRecoveryMode = false;
          this.canTrade = false;
          this.log(
            `🔄 MAX LEVEL — Resetting to L0 (reset mode) — waiting for new candle`,
            'warning'
          );
        }
      } else {
        const nextStake = this.calculateStake(this.currentGridLevel);
        this.log(
          `📉 LOSS -$${Math.abs(profit).toFixed(2)} | Grid L${this.currentGridLevel} | ` +
          `${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake} | ⚡ RECOVERY TRADE NEXT`,
          'warning'
        );
      }

      this._sendTelegramTradeResult(isWin, profit);

      if (shouldContinue) {
        const nextStake = this.calculateStake(this.currentGridLevel);
        if (nextStake > this.investmentRemaining) {
          this.log(
            `🛑 INSUFFICIENT INVESTMENT: next $${nextStake} > remaining $${this.investmentRemaining.toFixed(2)}`,
            'error'
          );
          shouldContinue = false;
          this.inRecoveryMode = false;
          this.canTrade = false;
        } else if (nextStake > this.balance) {
          this.log(
            `🛑 INSUFFICIENT BALANCE: next $${nextStake} > balance $${this.balance.toFixed(2)}`,
            'error'
          );
          shouldContinue = false;
          this.inRecoveryMode = false;
          this.canTrade = false;
        }
      }
    }

    // Save state after every trade result
    StatePersistence.save(this);

    if (!shouldContinue) {
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      this._logSummary();
      this._sendDailySummary();
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // NEXT TRADE SCHEDULING
    // ══════════════════════════════════════════════════════════════════════
    if (this.running && this.inRecoveryMode && this.canTrade) {
      this.log(`⚡ Recovery trade scheduled in 1s (L${this.currentGridLevel})…`, 'warning');
      if (this._retryTimer) clearTimeout(this._retryTimer);
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        if (this.running && !this.tradeInProgress && this.canTrade) {
          this._placeTrade();
        }
      }, 1000);
    } else if (this.running && !this.inRecoveryMode) {
      this.log(`⏳ WIN — Next trade will be placed on next new candle`, 'success');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // TRADE WATCHDOG — DETECT STUCK CONTRACTS
  // ══════════════════════════════════════════════════════════════════════════════

  _startTradeWatchdog(contractId) {
    this._clearAllWatchdogTimers();

    const duration = this.getTickDuration(this.currentGridLevel);
    const timeoutMs = duration > 3 ? (this.tradeWatchdogMs + 5000) : this.tradeWatchdogMs;

    this.tradeWatchdogTimer = setTimeout(() => {
      if (!this.tradeInProgress) return;

      this.log(
        `⏰ WATCHDOG FIRED — Contract ${contractId} has been open for ` +
        `${(timeoutMs / 1000)}s with no settlement`,
        'warning'
      );

      if (contractId && this.isConnected && this.isAuthorized) {
        this.log(`🔍 Polling contract ${contractId} for current status…`);
        this._send({
          proposal_open_contract: 1,
          contract_id: contractId,
          subscribe: 1,
        });

        this.tradeWatchdogPollTimer = setTimeout(() => {
          if (!this.tradeInProgress) return;
          this.log(
            `🚨 WATCHDOG: Poll timed out — contract ${contractId} still unresolved ` +
            `after ${(timeoutMs / 1000)}s — force-releasing lock`,
            'error'
          );
          this._recoverStuckTrade('watchdog-force');
        }, timeoutMs);

      } else {
        this._recoverStuckTrade('watchdog-offline');
      }
    }, timeoutMs);
  }

  _clearAllWatchdogTimers() {
    if (this.tradeWatchdogTimer) {
      clearTimeout(this.tradeWatchdogTimer);
      this.tradeWatchdogTimer = null;
    }
    if (this.tradeWatchdogPollTimer) {
      clearTimeout(this.tradeWatchdogPollTimer);
      this.tradeWatchdogPollTimer = null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // SUBSCRIBE TO CANDLES
  // ══════════════════════════════════════════════════════════════════════════════

  _subscribeToCandles(symbol) {
    this.log(`📊 Subscribing to ${this.candleConfig.GRANULARITY}s candles for ${symbol}...`);

    // Forget previous subscription if any
    if (this._candleSubId) {
      this._send({ forget: this._candleSubId });
      this._candleSubId = null;
    }

    // Reset candle loaded state for fresh load
    this.assetState.candlesLoaded = false;

    // Load historical candles
    this._send({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: this.candleConfig.CANDLES_TO_LOAD,
      end: 'latest',
      start: 1,
      style: 'candles',
      granularity: this.candleConfig.GRANULARITY,
    });

    // Subscribe to live candle updates
    this._send({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: 1,
      end: 'latest',
      start: 1,
      style: 'candles',
      granularity: this.candleConfig.GRANULARITY,
      subscribe: 1,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // RECOVER FROM STUCK TRADE - ENHANCED WITH PAUSE AND RESET
  // ══════════════════════════════════════════════════════════════════════════════

  _recoverStuckTrade(reason) {
    const contractId = this.currentContractId;
    const stakeInfo = this.pendingTradeInfo;
    const openSeconds = this.tradeStartTime
      ? Math.round((Date.now() - this.tradeStartTime) / 1000)
      : '?';

    this.log(
      `🚨 STUCK TRADE RECOVERY [${reason}] | Contract: ${contractId} | ` +
      `Open for: ${openSeconds}s | Level: ${this.currentGridLevel}`,
      'error'
    );

    this.stuckTradeCount++;

    if (stakeInfo && stakeInfo.stake > 0) {
      this.investmentRemaining = Number(
        (this.investmentRemaining + stakeInfo.stake).toFixed(2)
      );
      this.log(
        `💰 Stake $${stakeInfo.stake.toFixed(2)} returned to pool (unknown outcome) → ` +
        `pool: $${this.investmentRemaining.toFixed(2)}`,
        'warning'
      );
    }

    if (contractId) {
      this._processedContracts.add(String(contractId));
    }

    this.tradeInProgress = false;
    this.pendingTradeInfo = null;
    this.currentContractId = null;
    this.tradeStartTime = null;

    this._clearAllWatchdogTimers();
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }

    // ─────────────────────────────────────────────────────────────────────────
    // Pause trading, reset values, then resume after configured duration
    // ─────────────────────────────────────────────────────────────────────────

    const pauseDurationMs = this.config.stuckTradePauseDuration || (5 * 60 * 1000);
    const pauseDurationMin = Math.round(pauseDurationMs / 60000);

    // Set pause state
    this.isPausedDueToStuckTrade = true;
    this.stuckTradePauseEnd = Date.now() + pauseDurationMs;  // absolute timestamp
    this.canTrade = false;
    this.inRecoveryMode = false;

    // Reset to defaults
    const previousGridLevel = this.currentGridLevel;
    const previousBaseStake = this.baseStake;
    this.currentGridLevel = 0;
    this.currentDirection = 'CALLE';
    this.baseStake = this.config.initialStake;

    this.log(
      `⏸️ PAUSING TRADING for ${pauseDurationMin} minute(s) due to stuck trade | ` +
      `Grid Level: L${previousGridLevel} → L0 | ` +
      `Base Stake: $${previousBaseStake.toFixed(2)} → $${this.baseStake.toFixed(2)}`,
      'warning'
    );

    this._sendTelegram(
      `🛑 <b>${DEFAULT_CONFIG.symbol} STUCK TRADE DETECTED — PAUSING TRADING</b>\n\n` +
      `⚠️ <b>Reason:</b> ${reason}\n` +
      `⏱️ <b>Contract was open for:</b> ${openSeconds}s\n` +
      `📊 <b>Stuck trade count:</b> ${this.stuckTradeCount}\n\n` +
      `🔄 <b>Actions Taken:</b>\n` +
      `  • Stake $${stakeInfo?.stake?.toFixed(2) || '0.00'} returned to pool\n` +
      `  • Trading paused for ${pauseDurationMin} minute(s)\n` +
      `  • Grid Level reset: L${previousGridLevel} → L0\n` +
      `  • Base Stake reset: $${previousBaseStake.toFixed(2)} → $${this.baseStake.toFixed(2)}\n` +
      `  • Direction reset to HIGHER (CALLE)\n\n` +
      `⏰ <b>Trading will resume at:</b> ${new Date(this.stuckTradePauseEnd).toLocaleTimeString()}\n\n` +
      `⚠️ Please verify the trade outcome on Deriv manually!\n\n` +
      `📊 <b>Current State:</b>\n` +
      `  Investment pool: $${this.investmentRemaining.toFixed(2)}\n` +
      `  Session P&L: $${this.totalProfit.toFixed(2)}`
    );

    StatePersistence.save(this);

    // Clear any existing pause timer
    if (this.stuckTradePauseTimer) {
      clearTimeout(this.stuckTradePauseTimer);
      this.stuckTradePauseTimer = null;
    }

    // Set timer to resume trading
    this.stuckTradePauseTimer = setTimeout(() => {
      this._resumeTradingAfterStuckTradePause();
    }, pauseDurationMs);

    this.log(
      `⏳ Stuck trade pause active — trading will resume in ${pauseDurationMin} minute(s) ` +
      `at ${new Date(this.stuckTradePauseEnd).toLocaleTimeString()}`,
      'info'
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // RESUME TRADING AFTER STUCK TRADE PAUSE
  // ══════════════════════════════════════════════════════════════════════════════

  _resumeTradingAfterStuckTradePause() {
    this.isPausedDueToStuckTrade = false;
    this.stuckTradePauseEnd = null;
    this.stuckTradePauseTimer = null;

    // Don't set canTrade=true here — wait for next candle
    this.canTrade = false;

    this.log(
      `✅ STUCK TRADE PAUSE COMPLETE | Trading resumed | ` +
      `Grid Level: L${this.currentGridLevel} | Base Stake: $${this.baseStake.toFixed(2)}`,
      'success'
    );

    this._sendTelegram(
      `✅ <b>${DEFAULT_CONFIG.symbol} TRADING RESUMED</b>\n\n` +
      `⏰ <b>Pause duration completed</b>\n\n` +
      `📊 <b>Current State:</b>\n` +
      `  Grid Level: L${this.currentGridLevel}\n` +
      `  Base Stake: $${this.baseStake.toFixed(2)}\n` +
      `  Direction: ${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'}\n` +
      `  Investment pool: $${this.investmentRemaining.toFixed(2)}\n` +
      `  Session P&L: $${this.totalProfit.toFixed(2)}\n\n` +
      `🚀 Waiting for next candle to resume trading!`
    );

    StatePersistence.save(this);

    this.log('⏳ Waiting for next new candle to place trade…', 'info');
  }

  // Replace this.config.tickDuration with this method
  getTickDuration(level) {
    if (level === 0) return DEFAULT_CONFIG.tickDuration;
    if (level <= 2) return DEFAULT_CONFIG.tickDuration;
    if (level <= 5) return DEFAULT_CONFIG.tickDuration + 2;
    return 5;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PLACE TRADE
  // ══════════════════════════════════════════════════════════════════════════════

  _placeTrade(candleType, candleEmoji) {
    if (!this.isAuthorized) { this.log('Not authorized — cannot trade', 'error'); return; }
    if (!this.running) { return; }
    if (this.tradeInProgress) { this.log('Trade already in progress…', 'warning'); return; }

    // ── CHECK IF PAUSED DUE TO STUCK TRADE ─────────────────────────────────
    if (this.isPausedDueToStuckTrade) {
      const remainingMs = this.stuckTradePauseEnd ? Math.max(0, this.stuckTradePauseEnd - Date.now()) : 0;
      const remainingMin = Math.ceil(remainingMs / 60000);
      this.log(
        `⏸️ Cannot place trade - paused due to stuck trade. ` +
        `Will resume in ~${remainingMin} minute(s)`,
        'warning'
      );
      return;
    }

    // ── CANDLE GATE CHECK ─────────────────────────────────────────────────
    if (!this.canTrade) {
      if (this.inRecoveryMode) {
        this.log(
          '⚡ Recovery mode but canTrade=false — forcing canTrade=true',
          'warning'
        );
        this.canTrade = true;
      } else {
        this.log(
          '⏳ Waiting for new candle before trading… (canTrade=false)',
          'info'
        );
        return;
      }
    }

    // Determine direction for fresh trades
    if (!this.inRecoveryMode) {
      if (!candleType) {
        this.log('⏳ No candle type info — waiting for next candle', 'info');
        this.canTrade = false;
        return;
      }
      this.currentDirection = candleType === 'BULLISH' ? 'CALLE' : 'PUTE';
      if (candleType === 'DOJI') {
        this.log('Last Candle was a Doji — skipping', 'warning');
        this.canTrade = false;
        return;
      }
    }

    const stake = this.calculateStake(this.currentGridLevel);
    const direction = this.currentDirection;
    const label = direction === 'CALLE' ? 'HIGHER' : 'LOWER';
    const tradeType = this.inRecoveryMode ? '⚡ RECOVERY' : '🕯️ NEW CANDLE';

    if (stake > this.investmentRemaining) {
      this.log(
        `Insufficient investment: stake $${stake} > remaining $${this.investmentRemaining.toFixed(2)}`,
        'error'
      );
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }
    if (stake > this.balance) {
      this.log(
        `Insufficient balance: stake $${stake} > balance $${this.balance.toFixed(2)}`,
        'error'
      );
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }

    const duration = this.getTickDuration(this.currentGridLevel);

    // Log compounding info
    const compoundInfo = this.config.autoCompounding
      ? `(step-compound: base $${this.config.investmentAmount} → pool $${this.investmentRemaining.toFixed(2)}, ` +
      `steps: ${Math.floor(Math.max(0, this.investmentRemaining - this.config.investmentAmount) / this.config.compoundInvestmentStep)})`
      : '';

    this.log(
      `📊 ${tradeType} TRADE | ${label} | L${this.currentGridLevel} | Stake: $${stake} | ` +
      `Investment left: $${this.investmentRemaining.toFixed(2)} ${compoundInfo}`
    );

    this._sendTelegram(
      `🚀 <b>${DEFAULT_CONFIG.symbol}: TRADE OPEN</b>\n` +
      `Type: ${tradeType}\n` +
      `${candleEmoji ? `📊 Last Candle: ${candleEmoji} ${candleType}\n` : ''}` +
      `📊 Direction: ${label}\n` +
      `💰 Stake: $${stake}\n` +
      `⏱ Duration: ${duration} ticks\n` +
      `📊 <b>Grid Level:</b> ${this.currentGridLevel}\n` +
      `💵 <b>Investment left:</b> $${this.investmentRemaining.toFixed(2)}\n` +
      `📈 <b>Base Stake:</b> $${this.baseStake.toFixed(2)}\n`
    );

    if (!this.inRecoveryMode) {
      this.canTrade = false;
    }

    this.tradeInProgress = true;
    this.pendingTradeInfo = {
      id: Date.now(),
      time: new Date().toISOString(),
      direction,
      stake,
      gridLevel: this.currentGridLevel,
    };

    this._send({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: direction,
      currency: this.currency,
      duration: duration,
      duration_unit: 't',
      symbol: this.config.symbol,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // START / STOP
  // ══════════════════════════════════════════════════════════════════════════════

  start() {
    if (!this.isAuthorized) {
      this.log('Not authorized — connect first', 'error');
      return false;
    }
    if (this.running) {
      this.log('Bot already running', 'warning');
      return false;
    }
    if (this.config.investmentAmount <= 0) {
      this.log('Invalid investment amount', 'error');
      return false;
    }
    if (this.config.investmentAmount > this.balance) {
      this.log(
        `Investment $${this.config.investmentAmount} exceeds balance $${this.balance.toFixed(2)}`,
        'error'
      );
      return false;
    }

    const cfg = this.config;

    // Calculate initial base stake using intelligent compounding
    if (cfg.autoCompounding) {
      this.baseStake = Math.max(cfg.initialStake, 0.35);
      this.log(
        `💰 Auto-compounding ON (step mode): base stake $${this.baseStake.toFixed(2)} | ` +
        `+$${cfg.compoundStakeStep} per $${cfg.compoundInvestmentStep} investment growth`
      );
    } else {
      this.baseStake = cfg.initialStake;
      this.log(`💰 Fixed stake: $${this.baseStake.toFixed(2)}`);
    }

    this.running = true;
    this.currentGridLevel = 0;
    this.currentDirection = 'CALLE';
    this.totalProfit = 0;
    this.totalTrades = 0;
    this.wins = 0;
    this.losses = 0;
    this.currentStreak = 0;
    this.maxWinStreak = 0;
    this.maxLossStreak = 0;
    this.totalRecovered = 0;
    this.investmentRemaining = cfg.investmentAmount;
    this.investmentStartAmount = cfg.investmentAmount;
    this.tradeInProgress = false;
    this.pendingTradeInfo = null;
    this.currentContractId = null;
    this.isWinTrade = false;
    this.reconnectAttempts = 0;
    this.hasStartedOnce = true;
    this.stuckTradeCount = 0;

    // ── Initialize candle-gated trading ──────────────────────────────────
    this.inRecoveryMode = false;
    this.canTrade = false;
    this.isPausedDueToStuckTrade = false;
    this.stuckTradePauseEnd = null;

    // ── Initialize daily stats ────────────────────────────────────────────
    this._initDailyStats();
    this.dailyStats.startBalance = this.balance;
    this.dailyStats.startInvestment = cfg.investmentAmount;

    this.log(`🚀 ${DEFAULT_CONFIG.symbol} Grid Martingale Bot STARTED!`, 'success');
    this.log(
      `💵 Investment: $${cfg.investmentAmount} | Base: $${this.baseStake.toFixed(2)} | ` +
      `Mult: ${cfg.martingaleMultiplier}x | Max: L${cfg.maxMartingaleLevel} | ${cfg.tickDuration}t`
    );
    if (cfg.afterMaxLoss === 'continue') {
      this.log(
        `🔄 Extended recovery: up to L${cfg.maxMartingaleLevel + cfg.continueExtraLevels} with custom multipliers`
      );
    }
    this.log(
      `📈 Trading mode: NEW CANDLE → trade | LOSS → recovery until WIN → wait for new candle`
    );
    this.log(`⏳ Waiting for first new candle to start trading…`);

    // Log compounding and stuck trade settings
    if (cfg.autoCompounding) {
      this.log(
        `📊 Compounding: +$${cfg.compoundStakeStep} base stake per $${cfg.compoundInvestmentStep} investment growth`
      );
    }
    const pauseMin = Math.round((cfg.stuckTradePauseDuration || 300000) / 60000);
    this.log(`🛡️ Stuck trade pause duration: ${pauseMin} minute(s)`);

    this._sendTelegram(
      `🚀 <b>${DEFAULT_CONFIG.symbol} Grid Bot STARTED</b>\n` +
      `💵 Investment: $${cfg.investmentAmount}\n` +
      `📊 Base Stake: $${this.baseStake.toFixed(2)}\n` +
      `🔢 Multiplier: ${cfg.martingaleMultiplier}x | Max Level: ${cfg.maxMartingaleLevel}\n` +
      `⏱ Duration: ${cfg.tickDuration} ticks\n` +
      `💰 Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
      `🕯️ Mode: Trade on new candle | Recovery until win\n` +
      `📈 Compounding: +$${cfg.compoundStakeStep} / $${cfg.compoundInvestmentStep} growth\n` +
      `⏸️ Stuck trade pause: ${pauseMin} minute(s)`
    );

    StatePersistence.save(this);

    return true;
  }

  stop() {
    this.running = false;
    this.tradeInProgress = false;
    this.inRecoveryMode = false;
    this.canTrade = false;
    this._clearAllWatchdogTimers();
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this.log('🛑 Bot stopped', 'warning');
    this._sendDailySummary();
    this._sendTelegram(
      `🛑 <b>${DEFAULT_CONFIG.symbol} Bot stopped</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`
    );
    this._logSummary();
    StatePersistence.save(this);
  }

  emergencyStop() {
    this.running = false;
    this.tradeInProgress = false;
    this.inRecoveryMode = false;
    this.canTrade = false;
    this._clearAllWatchdogTimers();
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this.log('🚨 EMERGENCY STOP — All activity halted!', 'error');
    this._sendDailySummary();
    this._sendTelegram(
      `🚨 <b>${DEFAULT_CONFIG.symbol} EMERGENCY STOP TRIGGERED</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`
    );
    this._logSummary();
    StatePersistence.save(this);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // SUMMARY LOG
  // ══════════════════════════════════════════════════════════════════════════════

  _logSummary() {
    const wr = this.totalTrades > 0
      ? ((this.wins / this.totalTrades) * 100).toFixed(1)
      : '0.0';
    this.log(
      `📊 SUMMARY | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `Win rate: ${wr}% | P&L: $${this.totalProfit.toFixed(2)} | ` +
      `Recovered: $${this.totalRecovered.toFixed(2)}`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // TELEGRAM
  // ══════════════════════════════════════════════════════════════════════════════

  async _sendTelegram(message) {
    if (!this.telegramBot || !this.config.telegramEnabled) return;
    try {
      await this.telegramBot.sendMessage(this.config.telegramChatId, message, {
        parse_mode: 'HTML',
      });
    } catch (e) {
      console.error(`[Telegram] send failed: ${e.message}`);
    }
  }

  _sendTelegramTradeResult(isWin, profit) {
    const wr = this.totalTrades > 0
      ? ((this.wins / this.totalTrades) * 100).toFixed(1)
      : '0.0';
    const pnlStr = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(2);
    const dirLabel = this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER';
    const modeStr = this.inRecoveryMode ? '⚡ RECOVERY MODE' : '🕯️ CANDLE MODE';

    // Compounding info
    const steps = Math.floor(
      Math.max(0, this.investmentRemaining - this.config.investmentAmount) /
      this.config.compoundInvestmentStep
    );
    const compoundLine = this.config.autoCompounding
      ? `  Base Stake: $${this.baseStake.toFixed(2)} (compound steps: ${steps})\n`
      : '';

    this._sendTelegram(
      `${isWin ? '✅ WIN' : '❌ LOSS'} <b>— ${DEFAULT_CONFIG.symbol} Grid Bot</b>\n\n` +
      `${isWin ? '🟢' : '🔴'} <b>P&L:</b> ${pnlStr}\n` +
      `📊 <b>Grid Level:</b> ${this.currentGridLevel} → ${isWin ? 'RESET L0' : `L${this.currentGridLevel}`}\n` +
      `🎯 <b>Next:</b> ${isWin ? '⏳ Waiting for new candle' : `${dirLabel} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)} ⚡`}\n` +
      `🔄 <b>Mode:</b> ${isWin ? '🕯️ Wait for candle' : modeStr}\n\n` +
      `📈 <b>Session Stats:</b>\n` +
      `  Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses}\n` +
      `  Win Rate: ${wr}%\n` +
      `  Daily P&L: ${(this.totalProfit >= 0 ? '+' : '')}$${this.totalProfit.toFixed(2)}\n` +
      `  Investment: $${this.investmentRemaining.toFixed(2)}\n` +
      compoundLine +
      `\n⏰ ${new Date().toLocaleTimeString()}`
    );
  }

  async _sendHourlySummary() {
    const s = this.hourlyStats;
    const wr = (s.wins + s.losses) > 0
      ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1)
      : '0.0';
    const pnlStr = (s.pnl >= 0 ? '+' : '') + '$' + s.pnl.toFixed(2);

    await this._sendTelegram(
      `⏰ <b>${DEFAULT_CONFIG.symbol} Grid Bot — Hourly Summary</b>\n\n` +
      `📊 <b>Last Hour:</b>\n` +
      `  Trades: ${s.trades} | Wins: ${s.wins} | Losses: ${s.losses}\n` +
      `  Win Rate: ${wr}%\n` +
      `  ${s.pnl >= 0 ? '🟢' : '🔴'} P&L: ${pnlStr}\n\n` +
      `📈 <b>Session Totals:</b>\n` +
      `  Total Trades: ${this.totalTrades}\n` +
      `  W/L: ${this.wins}/${this.losses}\n` +
      `  Session P&L: ${(this.totalProfit >= 0 ? '+' : '')}$${this.totalProfit.toFixed(2)}\n` +
      `  Investment: $${this.investmentRemaining.toFixed(2)} / $${this.investmentStartAmount.toFixed(2)}\n` +
      `  Total Recovered: $${this.totalRecovered.toFixed(2)}\n` +
      `  Max Win Streak: ${this.maxWinStreak}\n` +
      `  Max Loss Streak: ${this.maxLossStreak}\n` +
      `  Grid Level: ${this.currentGridLevel}\n` +
      `  Recovery Mode: ${this.inRecoveryMode ? 'YES ⚡' : 'NO'}\n` +
      `  Base Stake: $${this.baseStake.toFixed(2)}\n\n` +
      `⏰ ${new Date().toLocaleString()}`
    );

    this.log('📱 Telegram hourly summary sent');
    this.hourlyStats = {
      trades: 0, wins: 0, losses: 0, pnl: 0,
      lastHour: new Date().getHours(),
    };
  }

  startTelegramTimer() {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const msUntilNext = nextHour.getTime() - now.getTime();

    setTimeout(() => {
      this._sendHourlySummary();
      setInterval(() => this._sendHourlySummary(), 60 * 60 * 1000);
    }, msUntilNext);

    this.log(
      `📱 Hourly Telegram summaries scheduled (first in ${Math.ceil(msUntilNext / 60000)} min)`
    );

    // ── Daily summary at midnight ───────────────────────────────────────────
    this._scheduleDailySummary();
  }

  _scheduleDailySummary() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 5, 0);  // 00:00:05 next day
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    setTimeout(() => {
      this._sendDailySummary();
      // Re-schedule for next day
      setInterval(() => {
        this._sendDailySummary();
        this._initDailyStats();
        this.dailyStats.startBalance = this.balance;
        this.dailyStats.startInvestment = this.investmentRemaining;
      }, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);

    this.log(
      `📅 Daily summary scheduled (first in ${Math.ceil(msUntilMidnight / 3600000)} hours)`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // TIME SCHEDULER
  // ══════════════════════════════════════════════════════════════════════════════

  startTimeScheduler() {
    setInterval(() => {
      const now = new Date();
      const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
      const gmt1 = new Date(utcMs + (1 * 60 * 60 * 1000));
      const day = gmt1.getDay();
      const hours = gmt1.getHours();
      const minutes = gmt1.getMinutes();

      // Check for day rollover in daily stats
      const today = this._getTodayKey();
      if (this.dailyStats.date !== today) {
        this.log(`📅 Day changed from ${this.dailyStats.date} to ${today}`, 'info');
        this._sendDailySummary();
        this._initDailyStats();
        this.dailyStats.startBalance = this.balance;
        this.dailyStats.startInvestment = this.investmentRemaining;
      }

      //New Day Trade Resumption
      if (this.endOfDay && hours === 3 && minutes >= 0) {
        this.log('📅 03:00 GMT+1 — reconnecting bot', 'success');
        this._resetDailyState();
        this.endOfDay = false;
        this.connect();
        return;
      }

      //Mid Day Trade Resumption
      if (this.endOfDay && hours === 15 && minutes >= 0) {
        this.log('📅 15:00 GMT+1 — reconnecting bot', 'success');
        this._resetDailyState();
        this.endOfDay = false;
        this.connect();
        return;
      }

      //New York Open Trade Pause
      if (!this.endOfDay && this.isWinTrade && hours >= 12 && minutes >= 50) {
        this.log('📅 Past 13:50 GMT+1 — end-of-day stop', 'info');
        this._sendHourlySummary();
        this._sendDailySummary();
        this.disconnect();
        this.endOfDay = true;
        return;
      }

      //END of Day Trade Pause
      if (!this.endOfDay && this.isWinTrade && hours >= 23 && minutes >= 50) {
        this.log('📅 Past 23:50 GMT+1 — end-of-day stop', 'info');
        this._sendHourlySummary();
        this._sendDailySummary();
        this.disconnect();
        this.endOfDay = true;
        return;
      }
    }, 10000);

    this.log('📅 Time scheduler started (weekend pause + EOD logic)');
  }

  _resetDailyState() {
    this.tradeInProgress = false;
    this.isWinTrade = false;
    this.inRecoveryMode = false;
    this.canTrade = false;
    this.currentGridLevel = 0;
    this.currentDirection = 'CALLE';
    this.stuckTradeCount = 0;

    // Initialize fresh daily stats
    this._initDailyStats();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TERMINAL BANNER
// ══════════════════════════════════════════════════════════════════════════════

function printBanner() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   GRID MARTINGALE BOT — Candle-Gated + Recovery Edition v2       ║');
  console.log('║   Strategy: Trade on NEW CANDLE | Recovery until WIN              ║');
  console.log('║   CALLE/PUTE | Martingale Recovery                                ║');
  console.log('║   ENHANCED: Network recovery, daily stats, step-compounding       ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');
  console.log('Flow: New Candle → Trade → WIN → Wait for Candle');
  console.log('      New Candle → Trade → LOSS → Recovery → Recovery → WIN → Wait for Candle');
  console.log('      STUCK TRADE → Pause 5min → Reset → Wait for Candle → Resume\n');
  console.log('Compounding: Base stake increases by $0.50 for every $153 investment growth\n');
  console.log('Signals: SIGINT / SIGTERM for graceful shutdown\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

function main() {
  printBanner();

  const bot = new STEPINDEXGridBot(DEFAULT_CONFIG);

  StatePersistence.startAutoSave(bot);

  if (bot.telegramBot) bot.startTelegramTimer();

  bot.startTimeScheduler();

  bot.connect();

  const shutdown = (sig) => {
    console.log(`\n[${sig}] Shutting down gracefully…`);
    bot.stop();
    bot.disconnect();
    StatePersistence.save(bot);
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('[UnhandledRejection]', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[UncaughtException]', err);
    // Don't crash — log and continue
    if (bot.telegramBot) {
      bot._sendTelegram(
        `🚨 <b>${DEFAULT_CONFIG.symbol} Uncaught Exception</b>\n${err.message}\nBot is still running.`
      );
    }
  });
}

main();
