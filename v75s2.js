#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════════════════════╗
// ║   V75 GRID MARTINGALE BOT — Headless Terminal Edition                          ║
// ║   Volatility 75 Index (1HZ75V) | CALLE/PUTE | Low-Risk Hybrid                 ║
// ║                                                                                  ║
// ║   Runs entirely from the terminal — no HTTP server, no web UI, no REST API     ║
// ║   Full Telegram notifications, state persistence, heartbeat, reconnect,         ║
// ║   time scheduler, and auto-start from DEFAULT_CONFIG.                           ║
// ╚══════════════════════════════════════════════════════════════════════════════════╝

'use strict';

require('dotenv').config();

const WebSocket   = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs          = require('fs');
const path        = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION  — edit here or override via .env
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  // Deriv API
  apiToken: 'hsj0tA0XJoIzJG5',
  appId:    '1089',

  // Strategy — core
  symbol:        '1HZ75V',// 1HZ75V
  tickDuration:  5,           // 5 ticks per contract
  initialStake:  0.35,        // base stake ($)
  investmentAmount: 100,      // investment pool ($)

  // Martingale
  martingaleMultiplier:  1.48,
  maxMartingaleLevel:    6,
  afterMaxLoss:          'continue',   // 'stop' | 'continue' | 'reset'
  continueExtraLevels:   3,
  extraLevelMultipliers: [2.2, 2.3, 2.5],

  // Auto-compounding
  autoCompounding:    true,
  compoundPercentage: 0.35,   // % of investment pool per base stake

  // Risk management
  stopLoss:   84,             // stop if total P&L <= -$stopLoss
  takeProfit: 10000,          // stop if total P&L >= $takeProfit

  // Telegram — override via .env for security
  telegramToken:   '8343520432:AAGNxzjnljOEhfv_rE-y-F98fUDPmrqZuXc',
  telegramChatId:  '752497117',
  telegramEnabled: true,
};

// ══════════════════════════════════════════════════════════════════════════════
// FILE PATHS
// ══════════════════════════════════════════════════════════════════════════════

const STATE_FILE          = path.join(__dirname, 'v75-grid-state0004.json');
const STATE_SAVE_INTERVAL = 5000;   // 5 s

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
          waitingForCandle:    bot.waitingForCandle,
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
    setInterval(() => {
      if (bot.running || bot.totalTrades > 0) StatePersistence.save(bot);
    }, STATE_SAVE_INTERVAL);
    console.log('[StatePersistence] Auto-save every 5 s ✅');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════

class V75GridBot {
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
    this.tradeWatchdogTimer = null;
    this.tradeWatchdogMs    = 60000;   // 60s — time before considering a trade stuck
    this.tradeStartTime     = null;

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

    // ── Session control ──────────────────────────────────────────────────────
    this.endOfDay         = false;
    this.isWinTrade       = false;
    this.hasStartedOnce   = false;   // true after first successful authorize
    this.autoSaveStarted  = false;
    this.waitingForCandle = false;

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

  // ══════════════════════════════════════════════════════════════════════════
  // STATE RESTORE
  // ══════════════════════════════════════════════════════════════════════════

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
    this.waitingForCandle    = t.waitingForCandle    || false;
    this.hasStartedOnce      = true;  // mark that we've restored state from a prior session
    this.log(
      `State restored | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `P&L: $${this.totalProfit.toFixed(2)} | Level: ${this.currentGridLevel}`,
      'success'
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LOGGING  (terminal only — clean, timestamped, coloured)
  // ══════════════════════════════════════════════════════════════════════════

  log(message, type = 'info') {
    const ts    = new Date().toISOString();
    const emoji = { error: '❌', success: '✅', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
    console.log(`[${ts}] ${emoji} ${message}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STAKE CALCULATOR
  // ══════════════════════════════════════════════════════════════════════════

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

    // Extra levels beyond maxMartingaleLevel
    let stake    = base * Math.pow(cfg.martingaleMultiplier, cfg.maxMartingaleLevel);
    const extraIdx = level - cfg.maxMartingaleLevel - 1;
    const mults  = cfg.extraLevelMultipliers || [];
    for (let i = 0; i <= extraIdx; i++) {
      stake *= (mults[i] > 0 ? mults[i] : cfg.martingaleMultiplier);
    }
    return Number(stake.toFixed(2));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET — CONNECT
  // ══════════════════════════════════════════════════════════════════════════

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

  // ── called when TCP connection is established ─────────────────────────────
  _onOpen() {
    this.log('WebSocket connected ✅', 'success');
    this.isConnected       = true;
    this.reconnectAttempts = 0;
    this.isReconnecting    = false;

    this._startPing();

    if (!this.autoSaveStarted) {
      StatePersistence.startAutoSave(this);
      this.autoSaveStarted = true;
    }

    // Authenticate immediately
    this._send({ authorize: this.config.apiToken });
  }

  // ── WebSocket error ───────────────────────────────────────────────────────
  _onError(err) {
    this.log(`WebSocket error: ${err.message}`, 'error');
  }

  // ── WebSocket close — drives all reconnect logic ──────────────────────────
  _onClose(code) {
    this.log(`WebSocket closed (code: ${code})`, 'warning');
    this.isConnected  = false;
    this.isAuthorized = false;

    this._stopPing();

    // Clear stale trade lock — contract gone with dead connection
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
      this._sendTelegram(`❌ <b>Max reconnect attempts reached</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

    this.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})…`);
    this.log(`State preserved — Trades: ${this.totalTrades} | P&L: $${this.totalProfit.toFixed(2)} | Level: ${this.currentGridLevel}`);

    this._sendTelegram(
      `⚠️ <b>CONNECTION LOST — RECONNECTING</b>\n` +
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

  // ── Clean up the old WebSocket object ────────────────────────────────────
  _cleanupWs() {
    this._stopPing();
    this._clearTradeWatchdog();
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

  // ── Intentional disconnect (stop/EOD) ────────────────────────────────────
  disconnect() {
    this.log('Disconnecting…');
    StatePersistence.save(this);
    this.endOfDay = true;
    this._cleanupWs();
    this.log('Disconnected ✅', 'success');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET — SEND
  // ══════════════════════════════════════════════════════════════════════════

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

  // ══════════════════════════════════════════════════════════════════════════
  // PING / KEEPALIVE
  // ══════════════════════════════════════════════════════════════════════════

  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this._send({ ping: 1 });
      }
    }, 30000);
  }

  _stopPing() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MESSAGE ROUTER
  // ══════════════════════════════════════════════════════════════════════════

  _onRawMessage(data) {
    try {
      this._handleMessage(JSON.parse(data));
    } catch (e) {
      this.log(`Parse error: ${e.message}`, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MESSAGE HANDLER
  // ══════════════════════════════════════════════════════════════════════════

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
      case 'ping':                   /* server-side ping — ignore */ break;
    }
  }

  _handleApiError(msg) {
    this.log(`API Error [${msg.error.code}]: ${msg.error.message} (msg_type: ${msg.msg_type})`, 'error');

    const code = msg.error.code;
    if (code === 'AuthorizationRequired' || code === 'InvalidToken') {
      this.isAuthorized = false;
      this._onClose(4001);   // treat as connection drop → reconnect
      return;
    }

    // Trade errors: release the trade lock and retry on next candle close
    if (msg.msg_type === 'buy' || msg.msg_type === 'proposal') {
      this.tradeInProgress  = false;
      this.pendingTradeInfo = null;
      if (this.running) {
        this.log('Trade error — will retry on next candle close', 'warning');
        // Force wait-for-candle so we don't spam retries
        this.waitingForCandle = true;
      }
    }
  }

  // ── authorize ─────────────────────────────────────────────────────────────
  _onAuthorize(msg) {
    if (msg.error) {
      this.log(`Authentication failed: ${msg.error.message}`, 'error');
      this._sendTelegram(`❌ <b>Authentication Failed:</b> ${msg.error.message}`);
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

    // Always subscribe to balance updates
    this._send({ balance: 1, subscribe: 1 });

    if (!this.hasStartedOnce) {
      // ── FIRST EVER connection — fresh start ─────────────────────────────
      this._sendTelegram(
        `✅ <b>V75 Grid Bot Connected</b>\n` +
        `Account: ${this.accountId}\n` +
        `Balance: ${this.currency} ${this.balance.toFixed(2)}`
      );
      // start() will set running = true and place first trade
      setTimeout(() => { if (!this.running) this.start(); }, 300);

    } else {
      // ── RECONNECTION — resume from preserved state ───────────────────────
      this.log(
        `🔄 Reconnected — resuming | L${this.currentGridLevel} | ` +
        `${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} | ` +
        `Investment: $${this.investmentRemaining.toFixed(2)} | ` +
        `WaitingForCandle: ${this.waitingForCandle}`,
        'success'
      );
      this._sendTelegram(
        `🔄 <b>Reconnected — Resuming</b>\n` +
        `Account: ${this.accountId} | Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
        `Grid Level: ${this.currentGridLevel} | ` +
        `Next: ${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)}\n` +
        `Investment: $${this.investmentRemaining.toFixed(2)}\n` +
        `WaitingForCandle: ${this.waitingForCandle}`
      );

      // Re-subscribe to any open contract (if mid-trade when we dropped)
      if (this.currentContractId) {
        this.log(`Re-subscribing to open contract ${this.currentContractId}…`);
        this._send({ proposal_open_contract: 1, contract_id: this.currentContractId, subscribe: 1 });
      }

      // If not mid-trade and not waiting for candle → recovery trade fires on next demand
      if (!this.tradeInProgress && !this.waitingForCandle && this.running) {
        this.log('Mid-streak recovery — trade will fire when ready ✅');
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

    // Start the trade watchdog to detect stuck trades
    this._startTradeWatchdog(b.contract_id);

    this._send({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 });
  }

  // ── contract result ───────────────────────────────────────────────────────
  _onContract(msg) {
    const c = msg.proposal_open_contract;
    if (!c.is_sold) return;

    // Clear the watchdog — trade has settled
    this._clearTradeWatchdog();

    const profit = parseFloat(c.profit);
    const payout = parseFloat(c.payout || 0);
    const isWin  = profit > 0;

    this.tradeInProgress  = false;
    this.pendingTradeInfo = null;

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
      this._sendTelegram(`🛑 <b>STOP LOSS REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      return;
    }
    if (this.totalProfit >= this.config.takeProfit) {
      this.log(`🎉 TAKE PROFIT hit! P&L: $${this.totalProfit.toFixed(2)}`, 'success');
      this._sendTelegram(`🎉 <b>TAKE PROFIT REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      return;
    }

    let shouldContinue = true;
    const cfg          = this.config;

    if (isWin) {
      // ── WIN — reset to Level 0 + CALLE ───────────────────────────────────
      if (this.currentGridLevel > 0) this.totalRecovered += profit;
      this.investmentRemaining = Number((this.investmentRemaining + payout).toFixed(2));

      if (cfg.autoCompounding) {
        this.baseStake = Math.max(this.investmentRemaining * cfg.compoundPercentage / 100, 0.35);
        this.log(
          `🎯 WIN +$${profit.toFixed(2)} | RECOVERY L${this.currentGridLevel} → RESET | ` +
          `Investment: $${this.investmentRemaining.toFixed(2)} | New base: $${this.baseStake.toFixed(2)} | Next: L0 HIGHER`,
          'success'
        );
      } else {
        this.log(
          `🎯 WIN +$${profit.toFixed(2)}${this.currentGridLevel > 0 ? ' | FULL RECOVERY!' : ''} | ` +
          `Investment: $${this.investmentRemaining.toFixed(2)} | Reset → L0 HIGHER`,
          'success'
        );
      }

      this.currentGridLevel = 0;
      this.currentDirection = 'CALLE';
      this._sendTelegramTradeResult(isWin, profit);

    } else {
      // ── LOSS — increase level + switch direction ──────────────────────────
      const nextLevel   = this.currentGridLevel + 1;
      const nextDir     = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';
      const absoluteMax = cfg.afterMaxLoss === 'continue'
        ? cfg.maxMartingaleLevel + cfg.continueExtraLevels
        : cfg.maxMartingaleLevel;

      this.currentGridLevel = nextLevel;
      this.currentDirection = nextDir;

      if (nextLevel > absoluteMax) {
        this.log(`🛑 ABSOLUTE CEILING L${absoluteMax} reached — stopping to protect investment`, 'error');
        this._sendTelegram(
          `🛑 <b>ABSOLUTE MAX LEVEL REACHED (L${absoluteMax})</b>\n` +
          `Investment remaining: $${this.investmentRemaining.toFixed(2)}\n` +
          `Total P&L: $${this.totalProfit.toFixed(2)}`
        );
        shouldContinue = false;

      } else if (nextLevel > cfg.maxMartingaleLevel) {
        const extraIdx  = nextLevel - cfg.maxMartingaleLevel - 1;
        const extraMult = (cfg.extraLevelMultipliers && cfg.extraLevelMultipliers[extraIdx] > 0)
          ? cfg.extraLevelMultipliers[extraIdx]
          : cfg.martingaleMultiplier;
        const nextStake = this.calculateStake(nextLevel);
        this.log(
          `🔴 EXTENDED RECOVERY L${nextLevel}/${absoluteMax} | Mult: ${extraMult}x | ` +
          `${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake}`,
          'warning'
        );

      } else if (nextLevel === cfg.maxMartingaleLevel) {
        if (cfg.afterMaxLoss === 'stop') {
          const nextStake = this.calculateStake(nextLevel);
          this.log(`⚠️ FINAL attempt (L${cfg.maxMartingaleLevel}) | ${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake}`, 'warning');
        } else if (cfg.afterMaxLoss === 'continue') {
          const nextStake = this.calculateStake(nextLevel);
          this.log(`⚠️ MAX L${cfg.maxMartingaleLevel} — extending to L${absoluteMax} | Next: ${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake}`, 'warning');
        } else if (cfg.afterMaxLoss === 'reset') {
          this.currentGridLevel = 0;
          this.currentDirection = 'CALLE';
          this.log(`🔄 MAX LEVEL — Resetting to L0 HIGHER (reset mode)`, 'warning');
        }
      } else {
        const nextStake = this.calculateStake(this.currentGridLevel);
        this.log(
          `📉 LOSS -$${Math.abs(profit).toFixed(2)} | Grid L${this.currentGridLevel} | ` +
          `${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake}`,
          'warning'
        );
      }

      this._sendTelegramTradeResult(isWin, profit);

      if (shouldContinue) {
        const nextStake = this.calculateStake(this.currentGridLevel);
        if (nextStake > this.investmentRemaining) {
          this.log(`🛑 INSUFFICIENT INVESTMENT: next $${nextStake} > remaining $${this.investmentRemaining.toFixed(2)}`, 'error');
          shouldContinue = false;
        } else if (nextStake > this.balance) {
          this.log(`🛑 INSUFFICIENT BALANCE: next $${nextStake} > balance $${this.balance.toFixed(2)}`, 'error');
          shouldContinue = false;
        }
      }
    }

    if (!shouldContinue) {
      this.running = false;
      this._logSummary();
      return;
    }

    if (this.running) {
      setTimeout(() => { if (this.running) this._placeTrade(); }, 1000);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TRADE WATCHDOG — DETECT STUCK CONTRACTS
  // ══════════════════════════════════════════════════════════════════════════

  _startTradeWatchdog(contractId) {
    this._clearTradeWatchdog();

    this.tradeWatchdogTimer = setTimeout(() => {
      if (!this.tradeInProgress) return;  // already settled — race condition guard

      this.log(
        `⏰ WATCHDOG FIRED — Contract ${contractId} has been open for ` +
        `${(this.tradeWatchdogMs / 1000)}s with no settlement`,
        'warning'
      );

      // Step 1: try to poll the contract — maybe the subscription was lost
      if (contractId && this.isConnected && this.isAuthorized) {
        this.log(`🔍 Polling contract ${contractId} for current status…`);
        this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });

        // Step 2: give the poll 30 s to deliver a result; if still stuck, force-release
        setTimeout(() => {
          if (!this.tradeInProgress) return;  // poll worked — already resolved
          this.log(
            `🚨 WATCHDOG: Poll timed out — contract ${contractId} still unresolved after ` +
            `${((this.tradeWatchdogMs + 30000) / 1000)}s — force-releasing lock`,
            'error'
          );
          this._recoverStuckTrade('watchdog-force');
        }, 30000);

      } else {
        // Not connected — just release the lock; reconnect will re-subscribe
        this._recoverStuckTrade('watchdog-offline');
      }
    }, this.tradeWatchdogMs);
  }

  _clearTradeWatchdog() {
    if (this.tradeWatchdogTimer) {
      clearTimeout(this.tradeWatchdogTimer);
      this.tradeWatchdogTimer = null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RECOVER FROM STUCK TRADE
  //   We don't know if the contract was a win or loss since the result was
  //   never delivered. Safest approach:
  //     • Release the lock so the bot can continue trading
  //     • Treat as a neutral event (no P&L change, no martingale escalation)
  //     • Add the stake back to investmentRemaining (stake was debited in _onBuy)
  //     • Wait for next trade opportunity before retrying (conservative)
  //     • Alert via Telegram so the user can manually verify on Deriv
  // ══════════════════════════════════════════════════════════════════════════

  _recoverStuckTrade(reason) {
    this._clearTradeWatchdog();

    const contractId  = this.currentContractId;
    const stakeInfo   = this.pendingTradeInfo;
    const openSeconds = this.tradeStartTime ? Math.round((Date.now() - this.tradeStartTime) / 1000) : '?';

    this.log(
      `🚨 STUCK TRADE RECOVERY [${reason}] | Contract: ${contractId} | ` +
      `Open for: ${openSeconds}s | Level: ${this.currentGridLevel}`,
      'error'
    );

    // Refund the stake to investmentRemaining (it was debited on _onBuy;
    // we don't know the true outcome so we return the stake to avoid
    // permanently bleeding the pool on phantom losses)
    if (stakeInfo && stakeInfo.stake > 0) {
      this.investmentRemaining = Number((this.investmentRemaining + stakeInfo.stake).toFixed(2));
      this.log(
        `💰 Stake $${stakeInfo.stake.toFixed(2)} returned to pool (unknown outcome) → ` +
        `pool: $${this.investmentRemaining.toFixed(2)}`,
        'warning'
      );
    }

    // Release the lock
    this.tradeInProgress   = false;
    this.pendingTradeInfo  = null;
    this.currentContractId = null;
    this.tradeStartTime    = null;

    // Wait for next trade before retrying (conservative — same as post-win)
    this.waitingForCandle = true;

    this.log(`⏳ Stuck trade cleared — waiting for next trade attempt`, 'warning');

    this._sendTelegram(
      `⚠️ <b>STUCK TRADE RECOVERED [${reason}]</b>\n` +
      `Contract: ${contractId || 'unknown'}\n` +
      `Open for: ${openSeconds}s\n` +
      `Grid Level: ${this.currentGridLevel}\n` +
      `Action: stake returned to pool, waiting for next trade\n` +
      `⚠️ Please verify outcome on Deriv — P&L not updated\n` +
      `Investment pool: $${this.investmentRemaining.toFixed(2)}\n` +
      `Session P&L: $${this.totalProfit.toFixed(2)}`
    );

    StatePersistence.save(this);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PLACE TRADE
  // ══════════════════════════════════════════════════════════════════════════

  _placeTrade() {
    if (!this.isAuthorized)   { this.log('Not authorized — cannot trade', 'error');  return; }
    if (!this.running)        { return; }
    if (this.tradeInProgress) { this.log('Trade already in progress…', 'warning');  return; }

    const stake     = this.calculateStake(this.currentGridLevel);
    const direction = this.currentDirection;
    const label     = direction === 'CALLE' ? 'HIGHER' : 'LOWER';

    if (stake > this.investmentRemaining) {
      this.log(`Insufficient investment: stake $${stake} > remaining $${this.investmentRemaining.toFixed(2)}`, 'error');
      this.running = false; return;
    }
    if (stake > this.balance) {
      this.log(`Insufficient balance: stake $${stake} > balance $${this.balance.toFixed(2)}`, 'error');
      this.running = false; return;
    }

    this.log(
      `📊 Placing ${label} | L${this.currentGridLevel} | Stake: $${stake} | ` +
      `Investment left: $${this.investmentRemaining.toFixed(2)}`
    );

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
      duration:      this.config.tickDuration,
      duration_unit: 't',
      symbol:        this.config.symbol,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // START / STOP
  // ══════════════════════════════════════════════════════════════════════════

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
    this.reconnectAttempts     = 0;   // fresh reconnect budget for this session

    this.log('🚀 V75 Grid Martingale Bot STARTED!', 'success');
    this.log(
      `💵 Investment: $${cfg.investmentAmount} | Base: $${this.baseStake.toFixed(2)} | ` +
      `Mult: ${cfg.martingaleMultiplier}x | Max: L${cfg.maxMartingaleLevel} | ${cfg.tickDuration}t`
    );
    if (cfg.afterMaxLoss === 'continue') {
      this.log(`🔄 Extended recovery: up to L${cfg.maxMartingaleLevel + cfg.continueExtraLevels} with custom multipliers`);
    }
    this.log(`📈 First trade: HIGHER (CALLE) — exploiting V75 mean-reversion`);

    this._sendTelegram(
      `🚀 <b>V75 Grid Bot STARTED</b>\n` +
      `💵 Investment: $${cfg.investmentAmount}\n` +
      `📊 Base Stake: $${this.baseStake.toFixed(2)}\n` +
      `🔢 Multiplier: ${cfg.martingaleMultiplier}x | Max Level: ${cfg.maxMartingaleLevel}\n` +
      `⏱ Duration: ${cfg.tickDuration} ticks\n` +
      `💰 Balance: ${this.currency} ${this.balance.toFixed(2)}`
    );

    setTimeout(() => { if (this.running) this._placeTrade(); }, 500);
    return true;
  }

  stop() {
    this.running         = false;
    this.tradeInProgress = false;
    this.log('🛑 Bot stopped', 'warning');
    this._sendTelegram(`🛑 <b>Bot stopped</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`);
    this._logSummary();
  }

  emergencyStop() {
    this.running         = false;
    this.tradeInProgress = false;
    this.log('🚨 EMERGENCY STOP — All activity halted!', 'error');
    this._sendTelegram(`🚨 <b>EMERGENCY STOP TRIGGERED</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`);
    this._logSummary();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARY LOG
  // ══════════════════════════════════════════════════════════════════════════

  _logSummary() {
    const wr = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0';
    this.log(
      `📊 SUMMARY | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `Win rate: ${wr}% | P&L: $${this.totalProfit.toFixed(2)} | Recovered: $${this.totalRecovered.toFixed(2)}`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TELEGRAM
  // ══════════════════════════════════════════════════════════════════════════

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

    this._sendTelegram(
      `${isWin ? '✅ WIN' : '❌ LOSS'} <b>— V75 Grid Bot</b>\n\n` +
      `${isWin ? '🟢' : '🔴'} <b>P&L:</b> ${pnlStr}\n` +
      `📊 <b>Grid Level:</b> ${this.currentGridLevel} → ${isWin ? 'RESET L0' : `L${this.currentGridLevel}`}\n` +
      `🎯 <b>Next:</b> ${dirLabel} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)}\n\n` +
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
      `⏰ <b>V75 Grid Bot — Hourly Summary</b>\n\n` +
      `📊 <b>Last Hour:</b>\n` +
      `  Trades: ${s.trades} | Wins: ${s.wins} | Losses: ${s.losses}\n` +
      `  Win Rate: ${wr}%\n` +
      `  ${s.pnl >= 0 ? '🟢' : '🔴'} P&L: ${pnlStr}\n\n` +
      `📈 <b>Session Totals:</b>\n` +
      `  Total Trades: ${this.totalTrades}\n` +
      `  W/L: ${this.wins}/${this.losses}\n` +
      `  Session P&L: ${(this.totalProfit >= 0 ? '+' : '')}$${this.totalProfit.toFixed(2)}\n` +
      `  Investment: $${this.investmentRemaining.toFixed(2)} / $${this.investmentStartAmount.toFixed(2)}\n` +
      `  Grid Level: ${this.currentGridLevel}\n\n` +
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

  // ══════════════════════════════════════════════════════════════════════════
  // TIME SCHEDULER — weekend pause + end-of-day logic (GMT+1)
  // ══════════════════════════════════════════════════════════════════════════

  startTimeScheduler() {
    setInterval(() => {
      const now     = new Date();
      const gmt1    = new Date(now.getTime() + 60 * 60 * 1000);
      const day     = gmt1.getUTCDay();
      const hours   = gmt1.getUTCHours();
      const minutes = gmt1.getUTCMinutes();

      // Weekend: Sat 23:00 → Mon 08:00 GMT+1
      const isWeekend =
        day === 0 ||
        (day === 6 && hours >= 23) ||
        (day === 1 && hours < 8);

      if (isWeekend) {
        if (!this.endOfDay) {
          this.log('📅 Weekend trading pause (Sat 23:00 – Mon 08:00 GMT+1) — disconnecting', 'warning');
          this._sendHourlySummary();
          this.stop();
          this.disconnect();
          this.endOfDay = true;
        }
        return;
      }

      // Resume Monday 08:00
      if (this.endOfDay && day === 1 && hours === 8 && minutes === 0) {
        this.log('📅 Monday 08:00 GMT+1 — reconnecting bot', 'success');
        this._resetDailyStats();
        this.endOfDay = false;
        this.connect();
      }

      // End-of-day: stop after a win past 17:00
      if (this.isWinTrade && !this.endOfDay && hours >= 17) {
        this.log('📅 Past 17:00 GMT+1 after a win — end-of-day stop', 'info');
        this._sendHourlySummary();
        this.stop();
        this.disconnect();
        this.endOfDay = true;
      }
    }, 20000);

    this.log('📅 Time scheduler started (weekend pause + EOD logic)');
  }

  _resetDailyStats() {
    this.tradeInProgress = false;
    this.isWinTrade      = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TERMINAL BANNER
// ══════════════════════════════════════════════════════════════════════════════

function printBanner() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   V75 GRID MARTINGALE BOT — Headless Terminal Edition               ║');
  console.log('║   Strategy: CALLE/PUTE | 1HZ75V | 5 ticks | 1.48x Martingale       ║');
  console.log('║   No HTTP server | No web UI | Runs entirely from terminal           ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');
  console.log('Signals: SIGINT / SIGTERM for graceful shutdown\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

function main() {
  printBanner();

  const bot = new V75GridBot(DEFAULT_CONFIG);

  // ── State persistence ──────────────────────────────────────────────────────
  StatePersistence.startAutoSave(bot);

  // ── Telegram hourly summaries ──────────────────────────────────────────────
  if (bot.telegramBot) bot.startTelegramTimer();

  // ── Time-based scheduler ──────────────────────────────────────────────────
  // bot.startTimeScheduler();

  // ── Connect & auto-start ───────────────────────────────────────────────────
  // Trading begins automatically inside _onAuthorize() once the socket is ready.
  bot.connect();

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = (sig) => {
    console.log(`\n[${sig}] Shutting down gracefully…`);
    bot.stop();
    bot.disconnect();
    StatePersistence.save(bot);
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── Unhandled rejection safety net ────────────────────────────────────────
  process.on('unhandledRejection', (reason) => {
    console.error('[UnhandledRejection]', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[UncaughtException]', err);
    // Don't exit — let the reconnect logic handle it
  });
}

main();
