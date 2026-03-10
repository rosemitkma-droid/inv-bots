#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════════════════════╗
// ║   V75 GRID MARTINGALE BOT — Headless Terminal Edition (FIXED)                  ║
// ║   Volatility 75 Index (1HZ75V) | CALLE/PUTE | Low-Risk Hybrid                 ║
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
  tickDuration:  1,
  initialStake:  0.35,
  investmentAmount: 100,

  martingaleMultiplier:  1.48,
  maxMartingaleLevel:    3,//6
  afterMaxLoss:          'continue',
  continueExtraLevels:   6,//3
  extraLevelMultipliers: [2.0, 2.0, 2.1, 2.1, 2.2, 2.3], //  [2.2, 2.3, 2.5] used only if afterMaxLoss is 'continue'

  autoCompounding:    true,
  compoundPercentage: 0.35,

  stopLoss:   100,
  takeProfit: 10000,

  telegramToken:   '8343520432:AAGNxzjnljOEhfv_rE-y-F98fUDPmrqZuXc',
  telegramChatId:  '752497117',
  telegramEnabled: true,
};

// ══════════════════════════════════════════════════════════════════════════════
// FILE PATHS
// ══════════════════════════════════════════════════════════════════════════════

const STATE_FILE          = path.join(__dirname, 'ST5-grid-state00012.json');
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
          // FIX #1: removed waitingForCandle from persistence — it's transient
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

  // FIX #5: Accept the interval ID back so we don't double-start
  static startAutoSave(bot) {
    if (bot._autoSaveInterval) return; // already running
    bot._autoSaveInterval = setInterval(() => {
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
    this.tradeWatchdogTimer    = null;
    this.tradeWatchdogPollTimer = null;  // FIX #7: track the inner poll timeout
    this.tradeWatchdogMs       = 60000;
    this.tradeStartTime        = null;

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
    this.hasStartedOnce   = false;
    this._autoSaveInterval = null;  // FIX #5: track auto-save interval

    // FIX #6: Track processed contract IDs to prevent double-processing
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
    // FIX #1: Do NOT restore waitingForCandle — always start fresh
    this.hasStartedOnce      = true;
    this.log(
      `State restored | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `P&L: $${this.totalProfit.toFixed(2)} | Level: ${this.currentGridLevel}`,
      'success'
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LOGGING
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

  _onOpen() {
    this.log('WebSocket connected ✅', 'success');
    this.isConnected       = true;
    this.reconnectAttempts = 0;
    this.isReconnecting    = false;

    this._startPing();

    // FIX #5: use the guarded version
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
    // FIX: clear ALL watchdog timers on disconnect
    this._clearAllWatchdogTimers();

    // Clear stale trade lock
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
      this._sendTelegram(`❌ <b>STEP INDEX Max reconnect attempts reached</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

    this.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})…`);
    this.log(`State preserved — Trades: ${this.totalTrades} | P&L: $${this.totalProfit.toFixed(2)} | Level: ${this.currentGridLevel}`);

    this._sendTelegram(
      `⚠️ <b>STEP INDEX CONNECTION LOST — RECONNECTING</b>\n` +
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
      case 'ping':                   break;
    }
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

      // FIX #1: Instead of setting waitingForCandle (which never clears),
      // schedule a concrete retry with a delay
      if (this.running) {
        setTimeout(() => {
          if (this.running && !this.tradeInProgress) {
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
      this._sendTelegram(`❌ <b>STEP INDEX Authentication Failed:</b> ${msg.error.message}`);
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

    if (!this.hasStartedOnce) {
      // ── FIRST connection ────────────────────────────────────────────────
      this._sendTelegram(
        `✅ <b>STEP INDEX Grid Bot Connected</b>\n` +
        `Account: ${this.accountId}\n` +
        `Balance: ${this.currency} ${this.balance.toFixed(2)}`
      );
      setTimeout(() => { if (!this.running) this.start(); }, 300);

    } else {
      this.tradeInProgress = false; // clear any stale trade lock on reconnect
      // ── RECONNECTION ────────────────────────────────────────────────────
      this.log(
        `🔄 Reconnected — resuming | L${this.currentGridLevel} | ` +
        `${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} | ` +
        `Investment: $${this.investmentRemaining.toFixed(2)}`,
        'success'
      );
      this._sendTelegram(
        `🔄 <b>STEP INDEX Reconnected — Resuming</b>\n` +
        `Account: ${this.accountId} | Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
        `Grid Level: ${this.currentGridLevel} | ` +
        `Next: ${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)}\n` +
        `Investment: $${this.investmentRemaining.toFixed(2)}`
      );

      // FIX #3: If we had a contract open when we disconnected, try to
      // check its status. But also set a fallback to just place a new trade.
      if (this.currentContractId) {
        this.log(`Re-subscribing to open contract ${this.currentContractId}…`);
        this.tradeInProgress = true; // mark as in-progress while we check
        this._send({ proposal_open_contract: 1, contract_id: this.currentContractId, subscribe: 1 });

        // FIX: If re-subscribe doesn't yield a result in 150s, force-recover
        this._startTradeWatchdog(this.currentContractId, 150000);
      } else {
        // FIX #1: No open contract — just resume trading immediately
        if (this.running && !this.tradeInProgress) {
          this.log('No open contract — placing next trade in 2s', 'success');
          setTimeout(() => {
            if (this.running && !this.tradeInProgress) this._placeTrade();
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

  // ── contract result ───────────────────────────────────────────────────────
  _onContract(msg) {
    const c = msg.proposal_open_contract;
    if (!c.is_sold) return;

    // FIX #4: Verify this contract belongs to the current trade
    const contractId = String(c.contract_id);
    if (this.currentContractId && contractId !== String(this.currentContractId)) {
      this.log(
        `⚠️ Ignoring stale contract result: ${contractId} (current: ${this.currentContractId})`,
        'warning'
      );
      return;
    }

    // FIX #6: Deduplicate — don't process the same sold contract twice
    if (this._processedContracts.has(contractId)) {
      this.log(`⚠️ Duplicate contract result ignored: ${contractId}`, 'warning');
      return;
    }
    this._processedContracts.add(contractId);
    // Trim the cache so it doesn't grow forever
    if (this._processedContracts.size > this._maxProcessedCache) {
      const first = this._processedContracts.values().next().value;
      this._processedContracts.delete(first);
    }

    // Clear ALL watchdog timers — trade has settled
    this._clearAllWatchdogTimers();

    const profit = parseFloat(c.profit);
    const payout = parseFloat(c.payout || 0);
    const isWin  = profit > 0;

    this.tradeInProgress   = false;
    this.pendingTradeInfo  = null;
    this.currentContractId = null;  // FIX: clear immediately after processing
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
      this._sendTelegram(`🛑 <b>STEP INDEX STOP LOSS REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      return;
    }
    if (this.totalProfit >= this.config.takeProfit) {
      this.log(`🎉 TAKE PROFIT hit! P&L: $${this.totalProfit.toFixed(2)}`, 'success');
      this._sendTelegram(`🎉 <b>STEP INDEX TAKE PROFIT REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      return;
    }

    let shouldContinue = true;
    const cfg          = this.config;

    if (isWin) {
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
      // this.currentDirection = 'CALLE';
      // const nextDir     = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';
      this._sendTelegramTradeResult(isWin, profit);

    } else {
      const nextLevel   = this.currentGridLevel + 1;
      // const nextDir     = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';
      const absoluteMax = cfg.afterMaxLoss === 'continue'
        ? cfg.maxMartingaleLevel + cfg.continueExtraLevels
        : cfg.maxMartingaleLevel;

      this.currentGridLevel = nextLevel;
      // this.currentDirection = nextDir;

      let nextDir = null;
      this.currentGridLevel > 3 ? nextDir = this.currentDirection === 'CALLE' ? 'CALLE' : 'PUTE' : nextDir = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';
      this.currentDirection = nextDir;

      if (nextLevel > absoluteMax) {
        this.log(`🛑 ABSOLUTE CEILING L${absoluteMax} reached — stopping to protect investment`, 'error');
        this._sendTelegram(
          `🛑 <b>STEP INDEX ABSOLUTE MAX LEVEL REACHED (L${absoluteMax})</b>\n` +
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
      setTimeout(() => { if (this.running && !this.tradeInProgress) this._placeTrade(); }, 1000);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TRADE WATCHDOG — DETECT STUCK CONTRACTS
  // ══════════════════════════════════════════════════════════════════════════

  // FIX #7: Accept optional custom timeout (used for reconnect re-subscribe)
  _startTradeWatchdog(contractId, customTimeoutMs) {
    this._clearAllWatchdogTimers();

    const timeoutMs = customTimeoutMs || this.tradeWatchdogMs;

    this.tradeWatchdogTimer = setTimeout(() => {
      if (!this.tradeInProgress) return;

      this.log(
        `⏰ WATCHDOG FIRED — Contract ${contractId} has been open for ` +
        `${(timeoutMs / 1000)}s with no settlement`,
        'warning'
      );

      // Step 1: try to poll the contract
      if (contractId && this.isConnected && this.isAuthorized) {
        this.log(`🔍 Polling contract ${contractId} for current status…`);
        this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });

        // FIX #7: Store the poll timeout so it can be cancelled
        this.tradeWatchdogPollTimer = setTimeout(() => {
          if (!this.tradeInProgress) return;
          this.log(
            `🚨 WATCHDOG: Poll timed out — contract ${contractId} still unresolved ` +
            `after ${((timeoutMs + 30000) / 1000)}s — force-releasing lock`,
            'error'
          );
          this._recoverStuckTrade('watchdog-force');
        }, 30000);

      } else {
        this._recoverStuckTrade('watchdog-offline');
      }
    }, timeoutMs);
  }

  // FIX #7: Clear BOTH timers
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

  // ══════════════════════════════════════════════════════════════════════════
  // RECOVER FROM STUCK TRADE
  // FIX #1: After recovery, schedule a concrete retry instead of setting
  //         the dead-end waitingForCandle flag
  // ══════════════════════════════════════════════════════════════════════════

  _recoverStuckTrade(reason) {
    this._clearAllWatchdogTimers();

    const contractId  = this.currentContractId;
    const stakeInfo   = this.pendingTradeInfo;
    const openSeconds = this.tradeStartTime ? Math.round((Date.now() - this.tradeStartTime) / 1000) : '?';

    this.log(
      `🚨 STUCK TRADE RECOVERY [${reason}] | Contract: ${contractId} | ` +
      `Open for: ${openSeconds}s | Level: ${this.currentGridLevel}`,
      'error'
    );

    // Refund the stake to investmentRemaining
    if (stakeInfo && stakeInfo.stake > 0) {
      this.investmentRemaining = Number((this.investmentRemaining + stakeInfo.stake).toFixed(2));
      this.log(
        `💰 Stake $${stakeInfo.stake.toFixed(2)} returned to pool (unknown outcome) → ` +
        `pool: $${this.investmentRemaining.toFixed(2)}`,
        'warning'
      );
    }

    // Add to processed set so if the result arrives late, we ignore it
    if (contractId) {
      this._processedContracts.add(String(contractId));
    }

    // Release the lock
    this.tradeInProgress   = false;
    this.pendingTradeInfo  = null;
    this.currentContractId = null;
    this.tradeStartTime    = null;

    // FIX #1 (THE KEY FIX): Schedule a concrete retry instead of
    // setting waitingForCandle = true (which was never cleared)
    this.log(`🔄 Will retry trade in 3 seconds…`, 'warning');

    this._sendTelegram(
      `⚠️ <b>STEP INDEX STUCK TRADE RECOVERED [${reason}]</b>\n` +
      `Contract: ${contractId || 'unknown'}\n` +
      `Open for: ${openSeconds}s\n` +
      `Grid Level: ${this.currentGridLevel}\n` +
      `Action: stake returned, retrying in 3s\n` +
      `⚠️ Please verify outcome on Deriv — P&L not updated\n` +
      `Investment pool: $${this.investmentRemaining.toFixed(2)}\n` +
      `Session P&L: $${this.totalProfit.toFixed(2)}`
    );

    StatePersistence.save(this);

    // FIX #1: Actually resume trading after a short delay
    if (this.running) {
      setTimeout(() => {
        if (this.running && !this.tradeInProgress && this.isAuthorized) {
          this.log('🔄 Resuming trading after stuck trade recovery…', 'success');
          this._placeTrade();
        } else if (this.running && !this.isAuthorized) {
          this.log('⏳ Not authorized yet — trade will resume after reconnect', 'warning');
        }
      }, 3000);
    }
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
    this.reconnectAttempts     = 0;
    this.hasStartedOnce        = true;  // Mark so reconnects use resume path

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
      `🚀 <b>STEP INDEX Grid Bot STARTED</b>\n` +
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
    this._clearAllWatchdogTimers();
    this.log('🛑 Bot stopped', 'warning');
    this._sendTelegram(`🛑 <b>STEP INDEX Bot stopped</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`);
    this._logSummary();
  }

  emergencyStop() {
    this.running         = false;
    this.tradeInProgress = false;
    this._clearAllWatchdogTimers();
    this.log('🚨 EMERGENCY STOP — All activity halted!', 'error');
    this._sendTelegram(`🚨 <b>STEP INDEX EMERGENCY STOP TRIGGERED</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`);
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
      `${isWin ? '✅ WIN' : '❌ LOSS'} <b>— STEP INDEX Grid Bot</b>\n\n` +
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
      `⏰ <b>STEP INDEX Grid Bot — Hourly Summary</b>\n\n` +
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
  // TIME SCHEDULER
  // ══════════════════════════════════════════════════════════════════════════

  startTimeScheduler() {
    setInterval(() => {
      const now = new Date();
      // compute UTC ms then add 1 hour for GMT+1 reliably
      const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
      const gmt1 = new Date(utcMs + (1 * 60 * 60 * 1000));
      const day = gmt1.getDay();
      const hours = gmt1.getHours();
      const minutes = gmt1.getMinutes();

      const isWeekend =
        day === 0 ||
        (day === 6 && hours >= 23) ||
        (day === 1 && hours < 8);

      if (isWeekend) {
        if (!this.endOfDay) {
          this.log('📅 Weekend trading pause (Sat 23:00 – Mon 07:00 GMT+1) — disconnecting', 'warning');
          this._sendHourlySummary();
          this.stop();
          this.disconnect();
          this.endOfDay = true;
        }
        return;
      }

      // Reconnect at 08:00 GMT+1 when endOfDay is set
      if (this.endOfDay && hours === 8 && minutes >= 0) {
        this.log('📅 08:00 GMT+1 — reconnecting bot', 'success');
        this._resetDailyStats();
        this.endOfDay = false;
        this.connect();
        return;
      }

      // Disconnect at or after 17:00 GMT+1 regardless of last trade result
      if (!this.endOfDay && this.isWinTrade && hours >= 19) {
        this.log('📅 Past 17:00 GMT+1 — end-of-day stop', 'info');
        this._sendHourlySummary();
        this.stop();
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
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TERMINAL BANNER
// ══════════════════════════════════════════════════════════════════════════════

function printBanner() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   V75 GRID MARTINGALE BOT — Headless Terminal Edition (FIXED)       ║');
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

  // FIX #5: Only call once — the guarded version prevents duplicates
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
