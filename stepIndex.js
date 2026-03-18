#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════════════════════╗
// ║   STEP INDEX GRID MARTINGALE BOT — Headless Terminal Edition (FIXED)           ║
// ║   Volatility STEP Index | CALLE/PUTE | Low-Risk Hybrid                        ║
// ║   NEW: Trade on new candle, recovery trades until win, then wait for candle    ║
// ║   ENHANCED: Stuck trade recovery with pause and reset                          ║
// ╚══════════════════════════════════════════════════════════════════════════════════╝

'use strict';

require('dotenv').config();

const WebSocket   = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs          = require('fs');
const path        = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  apiToken: 'Dz2V2KvRf4Uukt3',
  appId:    '1089',

  symbol:        'stpRNG',
  tickDuration:  3,
  initialStake:  0.35,
  investmentAmount: 153,

  martingaleMultiplier:  1.48,
  maxMartingaleLevel:    1,
  afterMaxLoss:          'continue',
  continueExtraLevels:   8,
  extraLevelMultipliers: [1.8, 2.1, 2.1, 2.1, 2.1, 2.1, 2.1],

  autoCompounding:    true,
  compoundPercentage: 0.24,

  stopLoss:   153,
  takeProfit: 10000,

  // Stuck trade recovery settings - USER ADJUSTABLE
  // Default: 5 minutes (5 * 60 * 1000 = 300000ms)
  // To change: set stuckTradePauseDuration to desired milliseconds
  // Example: 3 minutes = 3 * 60 * 1000 = 180000
  //          10 minutes = 10 * 60 * 1000 = 600000
  stuckTradePauseDuration: 5 * 60 * 1000,

  telegramToken:   '8343520432:AAGNxzjnljOEhfv_rE-y-F98fUDPmrqZuXc',
  telegramChatId:  '752497117',
  telegramEnabled: true,
};

// ══════════════════════════════════════════════════════════════════════════════
// FILE PATHS
// ══════════════════════════════════════════════════════════════════════════════

const STATE_FILE          = path.join(__dirname, 'ST1-grid-state000001.json');
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
          totalProfit:         bot.totalProfit,
          totalTrades:         bot.totalTrades,
          wins:                bot.wins,
          losses:              bot.losses,
          currentGridLevel:    bot.currentGridLevel,
          currentDirection:    bot.currentDirection,
          baseStake:           bot.baseStake,
          chainBaseStake:      bot.chainBaseStake,
          investmentRemaining: bot.investmentRemaining,
          totalRecovered:      bot.totalRecovered,
          maxWinStreak:        bot.maxWinStreak,
          maxLossStreak:       bot.maxLossStreak,
          currentStreak:       bot.currentStreak,
          inRecoveryMode:      bot.inRecoveryMode,
        },
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      console.error(`[StatePersistence] save error: ${e.message}`);
    }
  }

  static load() {
    try {
      if (!fs.existsSync(STATE_FILE)) return null;
      const data   = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const ageMin = (Date.now() - data.savedAt) / 60000;
      if (ageMin > 30) {
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
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════

class STEPINDEXGridBot {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // ── WebSocket ───────────────────────────────────────────────────────────
    this.ws            = null;
    this.isConnected   = false;
    this.isAuthorized  = false;
    this.reqId         = 1;

    // ── Reconnection ────────────────────────────────────────────────────────
    this.reconnectAttempts    = 0;
    this.maxReconnectAttempts = 50;
    this.reconnectDelay       = 5000;
    this.reconnectTimer       = null;
    this.isReconnecting       = false;

    // ── Ping / Keepalive ────────────────────────────────────────────────────
    this.pingInterval = null;

    // ── Trade Watchdog ───────────────────────────────────────────────────────
    this.tradeWatchdogTimer    = null;
    this.tradeWatchdogPollTimer = null;
    this.tradeWatchdogMs       = 5000;
    this.tradeStartTime        = null;

    // ── Stuck Trade Pause State ──────────────────────────────────────────────
    this.isPausedDueToStuckTrade = false;
    this.stuckTradePauseTimer    = null;
    this.stuckTradeCount         = 0;

    // ── Message queue ────────────────────────────────────────────────────────
    this.messageQueue = [];
    this.maxQueueSize = 50;

    // ── Account ──────────────────────────────────────────────────────────────
    this.balance   = 0;
    this.currency  = 'USD';
    this.accountId = '';

    // ── Session trading state ────────────────────────────────────────────────
    this.running               = false;
    this.tradeInProgress       = false;
    this.currentContractId     = null;
    this.pendingTradeInfo      = null;

    this.currentGridLevel      = 0;
    this.currentDirection      = 'CALLE';
    this.baseStake             = this.config.initialStake;
    this.chainBaseStake        = this.config.initialStake;
    this.investmentRemaining   = 0;
    this.investmentStartAmount = 0;
    this.totalProfit           = 0;
    this.totalTrades           = 0;
    this.wins                  = 0;
    this.losses                = 0;
    this.currentStreak         = 0;
    this.maxWinStreak          = 0;
    this.maxLossStreak         = 0;
    this.totalRecovered        = 0;

    // ── Candle tracking ─────────────────────────────────────────────────────
    this.assetState = {
      candles: [],
      closedCandles: [],
      currentFormingCandle: null,
      lastProcessedCandleOpenTime: null,
      candlesLoaded: false
    };
    this.candleConfig = {
      GRANULARITY: 60,
      MAX_CANDLES_STORED: 100,
      CANDLES_TO_LOAD: 50
    };

    // ══════════════════════════════════════════════════════════════════════
    // NEW CANDLE-GATED TRADING + RECOVERY LOGIC
    // ══════════════════════════════════════════════════════════════════════
    this.canTrade       = false;
    this.inRecoveryMode = false;

    // ── Session control ──────────────────────────────────────────────────────
    this.endOfDay         = false;
    this.isWinTrade       = false;
    this.hasStartedOnce   = false;
    this._autoSaveInterval = null;

    this._processedContracts = new Set();
    this._maxProcessedCache  = 200;

    // ── Hourly Telegram stats ─────────────────────────────────────────────────
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };

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
  // STATE RESTORE
  // ══════════════════════════════════════════════════════════════════════════════

  _restoreState() {
    const saved = StatePersistence.load();
    if (!saved) return;
    const t = saved.trading;
    this.totalProfit         = t.totalProfit         || 0;
    this.totalTrades         = t.totalTrades         || 0;
    this.wins                = t.wins                || 0;
    this.losses              = t.losses              || 0;
    this.currentGridLevel    = t.currentGridLevel    || 0;
    this.currentDirection    = t.currentDirection    || 'CALLE';
    this.baseStake           = t.baseStake           || this.config.initialStake;
    this.chainBaseStake      = t.chainBaseStake      || this.baseStake;
    this.investmentRemaining = t.investmentRemaining || 0;
    this.totalRecovered      = t.totalRecovered      || 0;
    this.maxWinStreak        = t.maxWinStreak        || 0;
    this.maxLossStreak       = t.maxLossStreak       || 0;
    this.currentStreak       = t.currentStreak       || 0;
    this.inRecoveryMode      = t.inRecoveryMode      || false;
    this.canTrade            = this.inRecoveryMode;
    this.hasStartedOnce      = true;
    this.log(
      `State restored | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `P&L: $${this.totalProfit.toFixed(2)} | Level: ${this.currentGridLevel} | ` +
      `Recovery: ${this.inRecoveryMode ? 'YES' : 'NO'}`,
      'success'
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // LOGGING
  // ══════════════════════════════════════════════════════════════════════════════

  log(message, type = 'info') {
    const ts    = new Date().toISOString();
    const emoji = { error: '❌', success: '✅', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
    console.log(`[${ts}] ${emoji} ${message}`);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // STAKE CALCULATOR
  // ══════════════════════════════════════════════════════════════════════════════

  calculateStake(level) {
    const cfg = this.config;
    let base  = this.baseStake;

    if (cfg.autoCompounding && this.investmentRemaining > 0) {
      base = Math.max(this.investmentRemaining * cfg.compoundPercentage / 100, 0.35);
    }
    base = Math.max(base, 0.35);

    if (level <= cfg.maxMartingaleLevel) {
      return Number((base * Math.pow(cfg.martingaleMultiplier, level)).toFixed(2));
    }

    let stake    = base * Math.pow(cfg.martingaleMultiplier, cfg.maxMartingaleLevel);
    const extraIdx = level - cfg.maxMartingaleLevel - 1;
    const mults  = cfg.extraLevelMultipliers || [];
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

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open',    ()     => this._onOpen());
    this.ws.on('message', data   => this._onRawMessage(data));
    this.ws.on('error',   err    => this._onError(err));
    this.ws.on('close',   (code) => this._onClose(code));
  }

  _onOpen() {
    this.log('WebSocket connected ✅', 'success');
    this.isConnected       = true;
    this.reconnectAttempts = 0;
    this.isReconnecting    = false;

    this._startPing();

    StatePersistence.startAutoSave(this);

    this._send({ authorize: this.config.apiToken });
  }

  _onError(err) {
    this.log(`WebSocket error: ${err.message}`, 'error');
  }

  _onClose(code) {
    this.log(`WebSocket closed (code: ${code})`, 'warning');
    this.isConnected  = false;
    this.isAuthorized = false;

    this._stopPing();
    this._clearAllWatchdogTimers();

    this.tradeInProgress  = false;
    this.pendingTradeInfo = null;

    StatePersistence.save(this);

    if (this.endOfDay) {
      this.log('Planned disconnect — not reconnecting');
      return;
    }

    if (this.isReconnecting) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('Max reconnect attempts reached — please restart the process', 'error');
      this._sendTelegram(`❌ <b>${DEFAULT_CONFIG.symbol} Max reconnect attempts reached</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

    this.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})…`);
    this.log(`State preserved — Trades: ${this.totalTrades} | P&L: $${this.totalProfit.toFixed(2)} | Level: ${this.currentGridLevel}`);

    this._sendTelegram(
      `⚠️ <b>${DEFAULT_CONFIG.symbol} CONNECTION LOST — RECONNECTING</b>\n` +
      `Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
      `Retrying in ${(delay / 1000).toFixed(1)}s\n` +
      `State preserved: ${this.totalTrades} trades | $${this.totalProfit.toFixed(2)} P&L`
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
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch (_) {}
      this.ws = null;
    }
    this.isConnected  = false;
    this.isAuthorized = false;
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
  // PING / KEEPALIVE
  // ══════════════════════════════════════════════════════════════════════════════

  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
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
    if (msg.error) {
      this._handleApiError(msg);
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':              this._onAuthorize(msg);  break;
      case 'balance':                this._onBalance(msg);    break;
      case 'proposal':               this._onProposal(msg);   break;
      case 'buy':                    this._onBuy(msg);        break;
      case 'proposal_open_contract': this._onContract(msg);   break;
      case 'ohlc':                   this._handleOHLC(msg.ohlc);  break;
      case 'candles':                this._handleCandlesHistory(msg);  break;
      case 'ping':                   break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // CANDLE HANDLER — NEW CANDLE DETECTION
  // ══════════════════════════════════════════════════════════════════════════════

  _handleOHLC(ohlc) {
    const symbol = ohlc.symbol;
    const calculatedOpenTime = ohlc.open_time ||
      Math.floor(ohlc.epoch / this.candleConfig.GRANULARITY) * this.candleConfig.GRANULARITY;

    const incomingCandle = {
      open: parseFloat(ohlc.open),
      high: parseFloat(ohlc.high),
      low: parseFloat(ohlc.low),
      close: parseFloat(ohlc.close),
      epoch: ohlc.epoch,
      open_time: calculatedOpenTime
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
          this.assetState.closedCandles = this.assetState.closedCandles.slice(-this.candleConfig.MAX_CANDLES_STORED);
        }

        this.assetState.lastProcessedCandleOpenTime = closedCandle.open_time;

        const closeTime = new Date(closedCandle.epoch * 1000).toISOString();
        const candleType = closedCandle.close > closedCandle.open ? 'BULLISH' : closedCandle.close < closedCandle.open ? 'BEARISH' : 'DOJI';
        const candleEmoji = candleType === 'BULLISH' ? '🟢' : candleType === 'BEARISH' ? '🔴' : '⚪';

        this.log(
          `${symbol} ${candleEmoji} NEW CANDLE [${closeTime}] ${candleType}: O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)}`
        );

        // ════════════════════════════════════════════════════════════════════════
        // CANDLE-GATED TRADE TRIGGER
        // ════════════════════════════════════════════════════════════════════════
        if (this.inRecoveryMode) {
          this.log(`📊 NEW CANDLE — but in RECOVERY mode (L${this.currentGridLevel}), recovery trades continue independently`, 'info');
        } else {
          this.log(`📊 NEW CANDLE — Ready for fresh trade 🚀`, 'success');
          this.canTrade = true;

          if (this.running && !this.tradeInProgress && this.canTrade) {
            this._placeTrade();
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

    const candles = response.candles.map(c => {
      const openTime = Math.floor((c.epoch - this.candleConfig.GRANULARITY) / this.candleConfig.GRANULARITY) * this.candleConfig.GRANULARITY;
      return {
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        epoch: c.epoch,
        open_time: openTime
      };
    });

    if (candles.length === 0) {
      this.log(`${symbol}: No historical candles received`, 'warning');
      return;
    }

    this.assetState.candles = [...candles];
    this.assetState.closedCandles = [...candles];

    const lastCandle = candles[candles.length - 1];
    this.assetState.lastProcessedCandleOpenTime = lastCandle.open_time;
    this.assetState.currentFormingCandle = null;

    this.log(`📊 Loaded ${candles.length} historical candles for ${symbol}`);

    if (this.inRecoveryMode) {
      this.log(`📊 In recovery mode — canTrade stays true for recovery trades`, 'warning');
      this.canTrade = true;
    } else {
      this.log(`📊 Waiting for next new candle to start trading…`, 'info');
      this.canTrade = false;
    }

    this.assetState.candlesLoaded = true;
  }

  _handleApiError(msg) {
    this.log(`API Error [${msg.error.code}]: ${msg.error.message} (msg_type: ${msg.msg_type})`, 'error');

    const code = msg.error.code;
    if (code === 'AuthorizationRequired' || code === 'InvalidToken') {
      this.isAuthorized = false;
      this._onClose(4001);
      return;
    }

    if (msg.msg_type === 'buy' || msg.msg_type === 'proposal') {
      this.log('Trade error — releasing lock and retrying in 3s', 'warning');
      this._clearAllWatchdogTimers();
      this.tradeInProgress  = false;
      this.pendingTradeInfo = null;
      this.currentContractId = null;

      if (this.running) {
        if (this.running && !this.tradeInProgress) {
          this.log('Retrying trade after API error…');
          this._placeTrade();
        }
      }
    }
  }

  // ── authorize ─────────────────────────────────────────────────────────────
  _onAuthorize(msg) {
    if (msg.error) {
      this.log(`Authentication failed: ${msg.error.message}`, 'error');
      this._sendTelegram(`❌ <b>${DEFAULT_CONFIG.symbol} Authentication Failed:</b> ${msg.error.message}`);
      return;
    }

    this.isAuthorized = true;
    this.accountId    = msg.authorize.loginid;
    this.balance      = msg.authorize.balance;
    this.currency     = msg.authorize.currency;

    this.log(
      `Authorized ✅ | Account: ${this.accountId} | Balance: ${this.currency} ${this.balance.toFixed(2)}`,
      'success'
    );

    this._send({ balance: 1, subscribe: 1 });

    this._subscribeToCandles(this.config.symbol);

    if (!this.hasStartedOnce) {
      this._sendTelegram(
        `✅ <b>${DEFAULT_CONFIG.symbol} Grid Bot Connected</b>\n` +
        `Account: ${this.accountId}\n` +
        `Balance: ${this.currency} ${this.balance.toFixed(2)}`
      );
      setTimeout(() => { if (!this.running) this.start(); }, 300);

    } else {
      this.tradeInProgress = false;
      this.log(
        `🔄 Reconnected — resuming | L${this.currentGridLevel} | ` +
        `${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} | ` +
        `Investment: $${this.investmentRemaining.toFixed(2)} | ` +
        `Recovery: ${this.inRecoveryMode ? 'YES' : 'NO'}`,
        'success'
      );
      this._sendTelegram(
        `🔄 <b>${DEFAULT_CONFIG.symbol} Reconnected — Resuming</b>\n` +
        `Account: ${this.accountId} | Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
        `Grid Level: ${this.currentGridLevel} | ` +
        `Next: ${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)}\n` +
        `Investment: $${this.investmentRemaining.toFixed(2)}\n` +
        `Recovery Mode: ${this.inRecoveryMode ? 'YES ⚡' : 'NO — waiting for candle'}`
      );

      if (this.currentContractId) {
        this.currentGridLevel = 0;
        this.log(`Re-subscribing to open contract ${this.currentContractId}…`);
        this.tradeInProgress = true;
        this._send({ proposal_open_contract: 1, contract_id: this.currentContractId, subscribe: 1 });
        this._startTradeWatchdog(this.currentContractId, 5000);
      } else {
        this.currentGridLevel = 0;
        if (this.inRecoveryMode) {
          this.canTrade = true;
          this.log('In recovery mode — will trade immediately after candle data loads', 'warning');
        }
        if (this.running && !this.tradeInProgress) {
          this.log('No open contract — will trade when candle signals (or immediately if in recovery)', 'success');
          setTimeout(() => {
            if (this.running && !this.tradeInProgress && this.canTrade) this._placeTrade();
          }, 2000);
        }
      }
    }
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
    this.currentContractId   = b.contract_id;
    this.tradeStartTime      = Date.now();
    this.investmentRemaining = Math.max(0, Number((this.investmentRemaining - b.buy_price).toFixed(2)));

    this.log(
      `Contract opened: ${b.contract_id} | Stake: $${b.buy_price.toFixed(2)} | ` +
      `Investment left: $${this.investmentRemaining.toFixed(2)}`
    );

    this._startTradeWatchdog(b.contract_id);

    this._send({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 });
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
    const isWin  = profit > 0;

    this.tradeInProgress   = false;
    this.pendingTradeInfo  = null;
    this.currentContractId = null;
    this.tradeStartTime    = null;

    // ── Update counters ───────────────────────────────────────────────────
    this.totalTrades += 1;
    this.totalProfit  = Number((this.totalProfit + profit).toFixed(2));
    if (isWin) { this.wins++;   this.isWinTrade = true;  }
    else       { this.losses++; this.isWinTrade = false; }

    this.currentStreak = isWin
      ? (this.currentStreak > 0 ? this.currentStreak + 1 : 1)
      : (this.currentStreak < 0 ? this.currentStreak - 1 : -1);
    if (isWin)  this.maxWinStreak  = Math.max(this.currentStreak, this.maxWinStreak);
    if (!isWin) this.maxLossStreak = Math.min(this.currentStreak, this.maxLossStreak);

    this.hourlyStats.trades++;
    this.hourlyStats.pnl += profit;
    if (isWin) this.hourlyStats.wins++; else this.hourlyStats.losses++;

    // ── Risk management ───────────────────────────────────────────────────
    if (this.totalProfit <= -this.config.stopLoss) {
      this.log(`🛑 STOP LOSS hit! P&L: $${this.totalProfit.toFixed(2)}`, 'error');
      this._sendTelegram(`🛑 <b>${DEFAULT_CONFIG.symbol} STOP LOSS REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }
    if (this.totalProfit >= this.config.takeProfit) {
      this.log(`🎉 TAKE PROFIT hit! P&L: $${this.totalProfit.toFixed(2)}`, 'success');
      this._sendTelegram(`🎉 <b>${DEFAULT_CONFIG.symbol} TAKE PROFIT REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }

    let shouldContinue = true;
    const cfg          = this.config;

    // ══════════════════════════════════════════════════════════════════════
    // WIN HANDLING
    // ══════════════════════════════════════════════════════════════════════
    if (isWin) {
      if (this.currentGridLevel > 0) this.totalRecovered += profit;
      this.investmentRemaining = Number((this.investmentRemaining + payout).toFixed(2));

      const wasRecovery = this.inRecoveryMode;

      if (cfg.autoCompounding) {
        this.baseStake = Math.max(this.investmentRemaining * cfg.compoundPercentage / 100, 0.35);
        this.log(
          `🎯 WIN +$${profit.toFixed(2)}${wasRecovery ? ' | RECOVERY COMPLETE! 🎉' : ''} | ` +
          `L${this.currentGridLevel} → RESET | ` +
          `Investment: $${this.investmentRemaining.toFixed(2)} | New base: $${this.baseStake.toFixed(2)}`,
          'success'
        );
      } else {
        this.log(
          `🎯 WIN +$${profit.toFixed(2)}${wasRecovery ? ' | FULL RECOVERY! 🎉' : ''} | ` +
          `Investment: $${this.investmentRemaining.toFixed(2)} | Reset → L0`,
          'success'
        );
      }

      this.currentGridLevel = 0;
      this.inRecoveryMode   = false;
      this.canTrade         = false;

      this.log(`⏳ Waiting for next new candle before placing new trade…`, 'info');

      this._sendTelegramTradeResult(isWin, profit);

    // ══════════════════════════════════════════════════════════════════════
    // LOSS HANDLING
    // ══════════════════════════════════════════════════════════════════════
    } else {
      const nextLevel   = this.currentGridLevel + 1;
      const absoluteMax = cfg.afterMaxLoss === 'continue'
        ? cfg.maxMartingaleLevel + cfg.continueExtraLevels
        : cfg.maxMartingaleLevel;

      // === BEST RECOVERY STRATEGY FOR stpRNG ===
      let nextDir;

      if (this.currentGridLevel <= 3) {
          // Strong mean reversion in early levels
          nextDir = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';
      } 
      else if (this.currentGridLevel % 3 === 0) {
          // Every 3rd level (6,9,12...) we continue direction (expecting breakout)
          nextDir = this.currentDirection;
      } 
      else {
          // Levels 4,5,7,8,10,11... → reverse
          nextDir = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';
      }

      this.currentDirection = nextDir;
      
      this.currentGridLevel = nextLevel;
      this.inRecoveryMode = true;
      this.canTrade       = true;

      if (nextLevel > absoluteMax) {
        this.log(`🛑 ABSOLUTE CEILING L${absoluteMax} reached — stopping to protect investment`, 'error');
        this._sendTelegram(
          `🛑 <b>${DEFAULT_CONFIG.symbol} ABSOLUTE MAX LEVEL REACHED (L${absoluteMax})</b>\n` +
          `Investment remaining: $${this.investmentRemaining.toFixed(2)}\n` +
          `Total P&L: $${this.totalProfit.toFixed(2)}`
        );
        shouldContinue      = false;
        this.inRecoveryMode = false;
        this.canTrade       = false;

      } else if (nextLevel > cfg.maxMartingaleLevel) {
        const extraIdx  = nextLevel - cfg.maxMartingaleLevel - 1;
        const extraMult = (cfg.extraLevelMultipliers && cfg.extraLevelMultipliers[extraIdx] > 0)
          ? cfg.extraLevelMultipliers[extraIdx]
          : cfg.martingaleMultiplier;
        const nextStake = this.calculateStake(nextLevel);
        this.log(
          `🔴 LOSS -$${Math.abs(profit).toFixed(2)} | EXTENDED RECOVERY L${nextLevel}/${absoluteMax} | Mult: ${extraMult}x | ` +
          `${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake} | ⚡ IMMEDIATE RECOVERY`,
          'warning'
        );

      } else if (nextLevel === cfg.maxMartingaleLevel) {
        if (cfg.afterMaxLoss === 'stop') {
          const nextStake = this.calculateStake(nextLevel);
          this.log(`⚠️ FINAL attempt (L${cfg.maxMartingaleLevel}) | ${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake} | ⚡ IMMEDIATE RECOVERY`, 'warning');
        } else if (cfg.afterMaxLoss === 'continue') {
          const nextStake = this.calculateStake(nextLevel);
          this.log(`⚠️ MAX L${cfg.maxMartingaleLevel} — extending to L${absoluteMax} | Next: ${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake} | ⚡ IMMEDIATE RECOVERY`, 'warning');
        } else if (cfg.afterMaxLoss === 'reset') {
          this.currentGridLevel = 0;
          this.currentDirection = 'CALLE';
          this.inRecoveryMode   = false;
          this.canTrade         = false;
          this.log(`🔄 MAX LEVEL — Resetting to L0 (reset mode) — waiting for new candle`, 'warning');
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
          this.log(`🛑 INSUFFICIENT INVESTMENT: next $${nextStake} > remaining $${this.investmentRemaining.toFixed(2)}`, 'error');
          shouldContinue      = false;
          this.inRecoveryMode = false;
          this.canTrade       = false;
        } else if (nextStake > this.balance) {
          this.log(`🛑 INSUFFICIENT BALANCE: next $${nextStake} > balance $${this.balance.toFixed(2)}`, 'error');
          shouldContinue      = false;
          this.inRecoveryMode = false;
          this.canTrade       = false;
        }
      }
    }

    if (!shouldContinue) {
      this.running        = false;
      this.inRecoveryMode = false;
      this.canTrade       = false;
      this._logSummary();
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // NEXT TRADE SCHEDULING
    // ══════════════════════════════════════════════════════════════════════
    if (this.running && this.inRecoveryMode && this.canTrade) {
      this.log(`⚡ Recovery trade scheduled in 1s (L${this.currentGridLevel})…`, 'warning');
      setTimeout(() => {
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

  _startTradeWatchdog(contractId, customTimeoutMs) {
    this._clearAllWatchdogTimers();

    const timeoutMs = this.tradeWatchdogMs;

    this.tradeWatchdogTimer = setTimeout(() => {
      if (!this.tradeInProgress) return;

      this.log(
        `⏰ WATCHDOG FIRED — Contract ${contractId} has been open for ` +
        `${(timeoutMs / 1000)}s with no settlement`,
        'warning'
      );

      if (contractId && this.isConnected && this.isAuthorized) {
        this.log(`🔍 Polling contract ${contractId} for current status…`);
        this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });

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

    this._send({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: this.candleConfig.CANDLES_TO_LOAD,
      end: 'latest',
      start: 1,
      style: 'candles',
      granularity: this.candleConfig.GRANULARITY
    });

    this._send({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: 1,
      end: 'latest',
      start: 1,
      style: 'candles',
      granularity: this.candleConfig.GRANULARITY,
      subscribe: 1
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // RECOVER FROM STUCK TRADE - ENHANCED WITH PAUSE AND RESET
  // ══════════════════════════════════════════════════════════════════════════════

  _recoverStuckTrade(reason) {
    const contractId  = this.currentContractId;
    const stakeInfo   = this.pendingTradeInfo;
    const openSeconds = this.tradeStartTime ? Math.round((Date.now() - this.tradeStartTime) / 1000) : '?';

    this.log(
      `🚨 STUCK TRADE RECOVERY [${reason}] | Contract: ${contractId} | ` +
      `Open for: ${openSeconds}s | Level: ${this.currentGridLevel}`,
      'error'
    );

    // Increment stuck trade count
    this.stuckTradeCount++;

    if (stakeInfo && stakeInfo.stake > 0) {
      this.investmentRemaining = Number((this.investmentRemaining + stakeInfo.stake).toFixed(2));
      this.log(
        `💰 Stake $${stakeInfo.stake.toFixed(2)} returned to pool (unknown outcome) → ` +
        `pool: $${this.investmentRemaining.toFixed(2)}`,
        'warning'
      );
    }

    if (contractId) {
      this._processedContracts.add(String(contractId));
    }

    this.tradeInProgress   = false;
    this.pendingTradeInfo  = null;
    this.currentContractId = null;
    this.tradeStartTime    = null;

    this._clearAllWatchdogTimers();

    // ─────────────────────────────────────────────────────────────────────────
    // NEW: Pause trading, reset values, then resume after configured duration
    // ─────────────────────────────────────────────────────────────────────────
    
    const pauseDurationMs = this.config.stuckTradePauseDuration || (5 * 60 * 1000);
    const pauseDurationMin = Math.round(pauseDurationMs / 60000);

    // Set pause state
    this.isPausedDueToStuckTrade = true;
    this.canTrade = false;
    this.inRecoveryMode = false;

    // Reset Stake, Multiplier (grid level), and Martingale step count to default
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
      `⏰ <b>Trading will resume at:</b> ${new Date(Date.now() + pauseDurationMs).toLocaleTimeString()}\n\n` +
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

    // Set timer to resume trading after the configured pause duration
    this.stuckTradePauseTimer = setTimeout(() => {
      this._resumeTradingAfterStuckTradePause();
    }, pauseDurationMs);

    this.log(
      `⏳ Stuck trade pause active — trading will resume in ${pauseDurationMin} minute(s) at ${new Date(Date.now() + pauseDurationMs).toLocaleTimeString()}`,
      'info'
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // RESUME TRADING AFTER STUCK TRADE PAUSE
  // ══════════════════════════════════════════════════════════════════════════════

  _resumeTradingAfterStuckTradePause() {
    // if (!this.running) {
    //   this.log('Bot stopped during stuck trade pause — not resuming', 'info');
    //   this.isPausedDueToStuckTrade = false;
    //   return;
    // }

    this.isPausedDueToStuckTrade = false;
    this.canTrade = true;

    this.log(
      `✅ STUCK TRADE PAUSE COMPLETE | Trading resumed | ` +
      `Grid Level: L${this.currentGridLevel} | Base Stake: $${this.baseStake.toFixed(2)}`,
      'success'
    );

    this._sendTelegram(
      `✅ <b>${DEFAULT_CONFIG.symbol} TRADING RESUMED</b>\n\n` +
      `⏰ <b>Pause duration completed:</b> ${(this.config.stuckTradePauseDuration || 300000) / 60000} minute(s)\n\n` +
      `📊 <b>Current State:</b>\n` +
      `  Grid Level: L${this.currentGridLevel}\n` +
      `  Base Stake: $${this.baseStake.toFixed(2)}\n` +
      `  Direction: ${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'}\n` +
      `  Investment pool: $${this.investmentRemaining.toFixed(2)}\n` +
      `  Session P&L: $${this.totalProfit.toFixed(2)}\n\n` +
      `🚀 Ready for new trade on next candle signal!`
    );

    this.log('⏳ Waiting for next new candle to place trade…', 'info');
  }

  // Replace this.config.tickDuration with this method
  getTickDuration(level) {
      if (level === 0) return 3;           // Fresh trade
      if (level <= 2) return 3;            // Early recovery
      if (level <= 5) return 5;
      return 5;                            // Deep recovery - more breathing room
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PLACE TRADE
  // ══════════════════════════════════════════════════════════════════════════════

  _placeTrade() {
    if (!this.isAuthorized)   { this.log('Not authorized — cannot trade', 'error');  return; }
    if (!this.running)        { return; }
    if (this.tradeInProgress) { this.log('Trade already in progress…', 'warning');  return; }

    // ── CHECK IF PAUSED DUE TO STUCK TRADE ─────────────────────────────────
    if (this.isPausedDueToStuckTrade) {
      const remainingMs = this.stuckTradePauseTimer ? 
        Math.max(0, this.stuckTradePauseTimer._idleTimeout - Date.now()) : 0;
      const remainingMin = Math.ceil(remainingMs / 60000);
      this.log(`⏸️ Cannot place trade - paused due to stuck trade. Will resume in ${remainingMin} minute(s)`, 'warning');
      return;
    }

    // ── CANDLE GATE CHECK ─────────────────────────────────────────────────
    if (!this.canTrade) {
      if (this.inRecoveryMode) {
        this.log('⚡ Recovery mode but canTrade=false — this shouldn\'t happen, forcing canTrade=true', 'warning');
        this.canTrade = true;
      } else {
        this.log('⏳ Waiting for new candle before trading… (canTrade=false)', 'info');
        return;
      }
    }

    const stake     = this.calculateStake(this.currentGridLevel);
    const direction = this.currentDirection;
    const label     = direction === 'CALLE' ? 'HIGHER' : 'LOWER';
    const tradeType = this.inRecoveryMode ? '⚡ RECOVERY' : '🕯️ NEW CANDLE';

    if (stake > this.investmentRemaining) {
      this.log(`Insufficient investment: stake $${stake} > remaining $${this.investmentRemaining.toFixed(2)}`, 'error');
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }
    if (stake > this.balance) {
      this.log(`Insufficient balance: stake $${stake} > balance $${this.balance.toFixed(2)}`, 'error');
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }

    const duration = this.getTickDuration(this.currentGridLevel);

    this.log(
      `📊 ${tradeType} TRADE | ${label} | L${this.currentGridLevel} | Stake: $${stake} | ` +
      `Investment left: $${this.investmentRemaining.toFixed(2)}`
    );

    this._sendTelegram(
      `🚀 <b>${DEFAULT_CONFIG.symbol}: TRADE OPEN</b>\n` +
      `🕯️ Type: ${tradeType}\n` +
      `📊 Direction: ${label}\n` +
      `💰 Stake: $${stake}\n` +
      `⏱ Duration: ${duration} ticks\n` +
      `📊 <b>Grid Level:</b> ${this.currentGridLevel}\n` +
      `💵 <b>Investment left:</b> $${this.investmentRemaining.toFixed(2)}\n`
    );

    if (!this.inRecoveryMode) {
      this.canTrade = false;
    }

    this.tradeInProgress  = true;
    this.pendingTradeInfo = {
      id:        Date.now(),
      time:      new Date().toISOString(),
      direction,
      stake,
      gridLevel: this.currentGridLevel,
    };

    this._send({
      proposal:      1,
      amount:        stake,
      basis:         'stake',
      contract_type: direction,
      currency:      this.currency,
      duration:      duration, // this.config.tickDuration,
      duration_unit: 't',
      symbol:        this.config.symbol,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // START / STOP
  // ══════════════════════════════════════════════════════════════════════════════

  start() {
    if (!this.isAuthorized)    { this.log('Not authorized — connect first', 'error');     return false; }
    if (this.running)     { this.log('Bot already running', 'warning');              return false; }
    if (this.config.investmentAmount <= 0) { this.log('Invalid investment amount', 'error'); return false; }
    if (this.config.investmentAmount > this.balance) {
      this.log(`Investment $${this.config.investmentAmount} exceeds balance $${this.balance.toFixed(2)}`, 'error');
      return false;
    }

    const cfg = this.config;

    if (cfg.autoCompounding) {
      this.baseStake = Math.max(cfg.investmentAmount * cfg.compoundPercentage / 100, 0.35);
      this.log(`💰 Auto-compounding ON: ${cfg.compoundPercentage}% of $${cfg.investmentAmount} = $${this.baseStake.toFixed(2)} base stake`);
    } else {
      this.baseStake = cfg.initialStake;
      this.log(`💰 Fixed stake: $${this.baseStake.toFixed(2)}`);
    }

    this.running               = true;
    this.currentGridLevel      = 0;
    this.currentDirection      = 'CALLE';
    this.totalProfit           = 0;
    this.totalTrades           = 0;
    this.wins                  = 0;
    this.losses                = 0;
    this.currentStreak         = 0;
    this.maxWinStreak          = 0;
    this.maxLossStreak         = 0;
    this.totalRecovered        = 0;
    this.investmentRemaining   = cfg.investmentAmount;
    this.investmentStartAmount = cfg.investmentAmount;
    this.tradeInProgress       = false;
    this.pendingTradeInfo      = null;
    this.currentContractId     = null;
    this.isWinTrade            = false;
    this.reconnectAttempts     = 0;
    this.hasStartedOnce        = true;

    // ── Initialize candle-gated trading ──────────────────────────────────
    this.inRecoveryMode        = false;
    this.canTrade              = false;
    this.isPausedDueToStuckTrade = false;

    this.log(`🚀 ${DEFAULT_CONFIG.symbol} Grid Martingale Bot STARTED!`, 'success');
    this.log(
      `💵 Investment: $${cfg.investmentAmount} | Base: $${this.baseStake.toFixed(2)} | ` +
      `Mult: ${cfg.martingaleMultiplier}x | Max: L${cfg.maxMartingaleLevel} | ${cfg.tickDuration}t`
    );
    if (cfg.afterMaxLoss === 'continue') {
      this.log(`🔄 Extended recovery: up to L${cfg.maxMartingaleLevel + cfg.continueExtraLevels} with custom multipliers`);
    }
    this.log(`📈 Trading mode: NEW CANDLE → trade | LOSS → recovery until WIN → wait for new candle`);
    this.log(`⏳ Waiting for first new candle to start trading…`);
    
    // Log stuck trade pause settings
    const pauseMin = Math.round((cfg.stuckTradePauseDuration || 300000) / 60000);
    this.log(`🛡️ Stuck trade pause duration: ${pauseMin} minute(s)`);

    this._sendTelegram(
      `🚀 <b>${DEFAULT_CONFIG.symbol} Grid Bot STARTED</b>\n` +
      `💵 Investment: $${cfg.investmentAmount}\n` +
      `📊 Base Stake: $${this.baseStake.toFixed(2)}\n` +
      `🔢 Multiplier: ${cfg.martingaleMultiplier}x | Max Level: ${cfg.maxMartingaleLevel}\n` +
      `⏱ Duration: {cfg.tickDuration} ticks\n` +
      `💰 Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
      `🕯️ Mode: Trade on new candle | Recovery until win\n` +
      `⏸️ Stuck trade pause: ${pauseMin} minute(s)`
    );

    return true;
  }

  stop() {
    this.running         = false;
    this.tradeInProgress = false;
    this.inRecoveryMode  = false;
    this.canTrade        = false;
    this._clearAllWatchdogTimers();
    this.log('🛑 Bot stopped', 'warning');
    this._sendTelegram(`🛑 <b>${DEFAULT_CONFIG.symbol} Bot stopped</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`);
    this._logSummary();
  }

  emergencyStop() {
    this.running         = false;
    this.tradeInProgress = false;
    this.inRecoveryMode  = false;
    this.canTrade        = false;
    this._clearAllWatchdogTimers();
    this.log('🚨 EMERGENCY STOP — All activity halted!', 'error');
    this._sendTelegram(`🚨 <b>${DEFAULT_CONFIG.symbol} EMERGENCY STOP TRIGGERED</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`);
    this._logSummary();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // SUMMARY LOG
  // ══════════════════════════════════════════════════════════════════════════════

  _logSummary() {
    const wr = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0';
    this.log(
      `📊 SUMMARY | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `Win rate: ${wr}% | P&L: $${this.totalProfit.toFixed(2)} | Recovered: $${this.totalRecovered.toFixed(2)}`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // TELEGRAM
  // ══════════════════════════════════════════════════════════════════════════════

  async _sendTelegram(message) {
    if (!this.telegramBot || !this.config.telegramEnabled) return;
    try {
      await this.telegramBot.sendMessage(this.config.telegramChatId, message, { parse_mode: 'HTML' });
    } catch (e) {
      console.error(`[Telegram] send failed: ${e.message}`);
    }
  }

  _sendTelegramTradeResult(isWin, profit) {
    const wr       = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0';
    const pnlStr   = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(2);
    const dirLabel = this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER';
    const modeStr  = this.inRecoveryMode ? '⚡ RECOVERY MODE' : '🕯️ CANDLE MODE';

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
      `  Investment: $${this.investmentRemaining.toFixed(2)}\n\n` +
      `⏰ ${new Date().toLocaleTimeString()}`
    );
  }

  async _sendHourlySummary() {
    const s      = this.hourlyStats;
    const wr     = (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0';
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
      `  Recovery Mode: ${this.inRecoveryMode ? 'YES ⚡' : 'NO'}\n\n` +
      `⏰ ${new Date().toLocaleString()}`
    );

    this.log('📱 Telegram hourly summary sent');
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
  }

  startTelegramTimer() {
    const now         = new Date();
    const nextHour    = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const msUntilNext = nextHour.getTime() - now.getTime();

    setTimeout(() => {
      this._sendHourlySummary();
      setInterval(() => this._sendHourlySummary(), 60 * 60 * 1000);
    }, msUntilNext);

    this.log(`📱 Hourly Telegram summaries scheduled (first in ${Math.ceil(msUntilNext / 60000)} min)`);
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

      const isWeekend =
        day === 0 ||
        (day === 6 && hours >= 23) ||
        (day === 1 && hours < 2);

      // if (isWeekend) {
      //   if (!this.endOfDay) {
      //     this.log('📅 Weekend trading pause (Sat 23:00 – Mon 07:00 GMT+1) — disconnecting', 'warning');
      //     this._sendHourlySummary();
      //     this.stop();
      //     this.disconnect();
      //     this.endOfDay = true;
      //   }
      //   return;
      // }

      if (this.endOfDay && hours === 2 && minutes >= 0) {
        this.log('📅 02:00 GMT+1 — reconnecting bot', 'success');
        this._resetDailyStats();
        this.endOfDay = false;
        this.connect();
        return;
      }

      if (!this.endOfDay && this.isWinTrade && hours >= 18) {
        this.log('📅 Past 18:00 GMT+1 — end-of-day stop', 'info');
        this._sendHourlySummary();
        this.disconnect();
        this.endOfDay = true;
        return;
      }
    }, 10000);

    this.log('📅 Time scheduler started (weekend pause + EOD logic)');
  }

  _resetDailyStats() {
    this.tradeInProgress = false;
    this.isWinTrade      = false;
    this.inRecoveryMode  = false;
    this.canTrade        = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TERMINAL BANNER
// ══════════════════════════════════════════════════════════════════════════════

function printBanner() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   GRID MARTINGALE BOT — Candle-Gated + Recovery Edition        ║');
  console.log('║   Strategy: Trade on NEW CANDLE | Recovery until WIN               ║');
  console.log('║   CALLE/PUTE | Martingale Recovery                    ║');
  console.log('║   ENHANCED: Stuck trade recovery with pause and reset            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');
  console.log('Flow: New Candle → Trade → WIN → Wait for Candle');
  console.log('      New Candle → Trade → LOSS → Recovery → Recovery → WIN → Wait for Candle');
  console.log('      STUCK TRADE → Pause 5min → Reset → Wait for Candle → Resume\n');
  console.log('To adjust stuck trade pause duration, edit:');
  console.log('  stuckTradePauseDuration: 5 * 60 * 1000  // milliseconds\n');
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

  // bot.startTimeScheduler();

  bot.connect();

  const shutdown = (sig) => {
    console.log(`\n[${sig}] Shutting down gracefully…`);
    bot.stop();
    bot.disconnect();
    StatePersistence.save(bot);
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('[UnhandledRejection]', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[UncaughtException]', err);
  });
}

main();
