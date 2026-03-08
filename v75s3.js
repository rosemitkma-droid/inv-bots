#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════════════════════╗
// ║   V75 GRID MARTINGALE BOT — Headless Terminal Edition v2                        ║
// ║   Volatility 75 Index (1HZ75V) | CALLE/PUTE | Candle-Gated Entry               ║
// ║                                                                                  ║
// ║   Trade entry rules:                                                             ║
// ║     • First trade of a session fires on the next candle close after start        ║
// ║     • WIN  → wait for a new candle close before the next trade                  ║
// ║     • LOSS → place next (martingale recovery) trade immediately, no candle wait  ║
// ║                                                                                  ║
// ║   Candle logic ported from fractal-bot OHLC stream (open_time change detection)  ║
// ║   Connection / reconnect modelled on fractal-bot ConnectionManager               ║
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
  symbol:        '1HZ75V',
  tickDuration:  5,           // 5 ticks per contract
  initialStake:  0.35,        // base stake ($)
  investmentAmount: 100,      // investment pool ($)

  // Candle timeframe for trade gating
  granularity:    60,         // candle size in seconds (60 = 1-minute candles)
  candlesHistory: 100,        // how many historical candles to load on startup

  // Martingale
  martingaleMultiplier:  1.48,
  maxMartingaleLevel:    6,
  afterMaxLoss:          'continue',   // 'stop' | 'continue' | 'reset'
  continueExtraLevels:   3,
  extraLevelMultipliers: [2.2, 2.3, 2.5],

  // Auto-compounding
  autoCompounding:    true,
  compoundPercentage: 0.35,   // % of investment pool as base stake

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

const STATE_FILE          = path.join(__dirname, 'v753-grid-state00003.json');
const STATE_SAVE_INTERVAL = 5000;   // ms

// ══════════════════════════════════════════════════════════════════════════════
// LOGGER
// ══════════════════════════════════════════════════════════════════════════════

const LOGGER = {
  info:    msg => console.log(`[${new Date().toISOString()}] ℹ️  ${msg}`),
  trade:   msg => console.log(`[${new Date().toISOString()}] 📊 ${msg}`),
  success: msg => console.log(`[${new Date().toISOString()}] ✅ ${msg}`),
  warn:    msg => console.log(`[${new Date().toISOString()}] ⚠️  ${msg}`),
  error:   msg => console.log(`[${new Date().toISOString()}] ❌ ${msg}`),
  candle:  msg => console.log(`[${new Date().toISOString()}] 🕯️  ${msg}`),
};

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
      LOGGER.error(`StatePersistence.save: ${e.message}`);
    }
  }

  static load() {
    try {
      if (!fs.existsSync(STATE_FILE)) return null;
      const data   = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const ageMin = (Date.now() - data.savedAt) / 60000;
      if (ageMin > 30) {
        LOGGER.warn(`Saved state is ${ageMin.toFixed(1)} min old — discarding`);
        fs.unlinkSync(STATE_FILE);
        return null;
      }
      LOGGER.info(`Restoring state from ${ageMin.toFixed(1)} min ago`);
      return data;
    } catch (e) {
      LOGGER.error(`StatePersistence.load: ${e.message}`);
      return null;
    }
  }

  static startAutoSave(bot) {
    setInterval(() => {
      if (bot.running || bot.totalTrades > 0) StatePersistence.save(bot);
    }, STATE_SAVE_INTERVAL);
    LOGGER.info('Auto-save every 5 s ✅');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════

class V75GridBot {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // ── WebSocket / connection ────────────────────────────────────────────────
    this.ws                   = null;
    this.isConnected          = false;  // TCP open
    this.isAuthorized         = false;  // API authorized
    this.reconnectAttempts    = 0;
    this.maxReconnectAttempts = 50;
    this.reconnectDelay       = 5000;
    this.isReconnecting       = false;
    this.reconnectTimer       = null;
    this.pingInterval         = null;
    this.autoSaveStarted      = false;
    this.hasStartedOnce       = false;  // true after first successful start()

    // ── Message ID counter (mirrors fractal bot req_id pattern) ──────────────
    this.reqId = 1;

    // ── Candle state ─────────────────────────────────────────────────────────
    //   Mirrors fractal bot: track forming candle by open_time;
    //   when open_time changes → previous candle closed.
    this.currentFormingCandle         = null;
    this.lastProcessedCandleOpenTime  = null;
    this.candlesLoaded                = false;
    this.closedCandles                = [];   // rolling history (last N)

    // ── Trade gate flag ───────────────────────────────────────────────────────
    //   true  → waiting for the next candle close before placing a trade
    //   false → place trade immediately (recovery / first trade)
    this.waitingForCandle = true;   // always wait for first candle on fresh start

    // ── Account ───────────────────────────────────────────────────────────────
    this.balance   = 0;
    this.currency  = 'USD';
    this.accountId = '';

    // ── Trading state ─────────────────────────────────────────────────────────
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

    // ── Session control ───────────────────────────────────────────────────────
    this.endOfDay   = false;
    this.isWinTrade = false;

    // ── Hourly Telegram stats ─────────────────────────────────────────────────
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };

    // ── Telegram ──────────────────────────────────────────────────────────────
    this.telegramBot = null;
    if (this.config.telegramEnabled && this.config.telegramToken && this.config.telegramChatId) {
      try {
        this.telegramBot = new TelegramBot(this.config.telegramToken, { polling: false });
        LOGGER.info('Telegram notifications enabled ✅');
      } catch (e) {
        LOGGER.warn(`Telegram init error: ${e.message}`);
      }
    } else {
      LOGGER.warn('Telegram disabled — no token/chat-id configured');
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
    this.totalProfit         = t.totalProfit         ?? 0;
    this.totalTrades         = t.totalTrades         ?? 0;
    this.wins                = t.wins                ?? 0;
    this.losses              = t.losses              ?? 0;
    this.currentGridLevel    = t.currentGridLevel    ?? 0;
    this.currentDirection    = t.currentDirection    ?? 'CALLE';
    this.baseStake           = t.baseStake           ?? this.config.initialStake;
    this.chainBaseStake      = t.chainBaseStake      ?? t.baseStake ?? this.config.initialStake;
    this.investmentRemaining = t.investmentRemaining ?? 0;
    this.totalRecovered      = t.totalRecovered      ?? 0;
    this.maxWinStreak        = t.maxWinStreak        ?? 0;
    this.maxLossStreak       = t.maxLossStreak       ?? 0;
    this.currentStreak       = t.currentStreak       ?? 0;
    // On restore: if we were waiting for a candle, keep waiting.
    // If we were mid-loss-streak (waitingForCandle=false), resume immediately on next candle.
    this.waitingForCandle    = t.waitingForCandle    ?? true;
    this.hasStartedOnce      = true;   // we have prior state — treat as resumed session
    LOGGER.success(
      `State restored | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `P&L: $${this.totalProfit.toFixed(2)} | Level: ${this.currentGridLevel} | ` +
      `WaitingForCandle: ${this.waitingForCandle}`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STAKE CALCULATOR
  // ══════════════════════════════════════════════════════════════════════════

  calculateStake(level) {
    const cfg = this.config;
    let base;

    if (level === 0) {
      // Live compounded base — will be frozen into chainBaseStake when placed
      base = this.baseStake;
      if (cfg.autoCompounding && this.investmentRemaining > 0) {
        base = Math.max(this.investmentRemaining * cfg.compoundPercentage / 100, 0.35);
      }
      base = Math.max(base, 0.35);
    } else {
      // Must use the frozen chain base so recovery maths hold
      base = Math.max(this.chainBaseStake, 0.35);
    }

    if (level <= cfg.maxMartingaleLevel) {
      return Number((base * Math.pow(cfg.martingaleMultiplier, level)).toFixed(2));
    }

    // Extra levels beyond maxMartingaleLevel
    let stake      = base * Math.pow(cfg.martingaleMultiplier, cfg.maxMartingaleLevel);
    const extraIdx = level - cfg.maxMartingaleLevel - 1;
    const mults    = cfg.extraLevelMultipliers || [];
    for (let i = 0; i <= extraIdx; i++) {
      stake *= (mults[i] > 0 ? mults[i] : cfg.martingaleMultiplier);
    }
    return Number(stake.toFixed(2));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET — CONNECT  (modelled on fractal bot ConnectionManager)
  // ══════════════════════════════════════════════════════════════════════════

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      LOGGER.warn('Already connected');
      return;
    }

    this._cleanupWs();

    const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.config.appId}`;
    LOGGER.info(`Connecting to Deriv WebSocket… (attempt ${this.reconnectAttempts + 1})`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open',    ()     => this._onOpen());
    this.ws.on('message', data   => this._onRawMessage(data));
    this.ws.on('error',   err    => this._onError(err));
    this.ws.on('close',   (code) => this._onClose(code));
  }

  // ── called when TCP connection is established ─────────────────────────────
  _onOpen() {
    LOGGER.success('WebSocket connected ✅');
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
    LOGGER.error(`WebSocket error: ${err.message}`);
  }

  // ── WebSocket close — drives all reconnect logic ──────────────────────────
  _onClose(code) {
    LOGGER.warn(`WebSocket closed (code: ${code})`);
    this.isConnected  = false;
    this.isAuthorized = false;

    this._stopPing();

    // Clear stale trade lock — contract gone with dead connection
    this.tradeInProgress  = false;
    this.pendingTradeInfo = null;

    StatePersistence.save(this);

    if (this.endOfDay) {
      LOGGER.info('Planned disconnect — not reconnecting');
      return;
    }

    if (this.isReconnecting) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      LOGGER.error('Max reconnect attempts reached — please restart the process');
      this._sendTelegram(`❌ <b>Max reconnect attempts reached</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

    LOGGER.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})…`);
    LOGGER.info(`State preserved — Trades: ${this.totalTrades} | P&L: $${this.totalProfit.toFixed(2)} | Level: ${this.currentGridLevel}`);

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
    LOGGER.info('Disconnecting…');
    StatePersistence.save(this);
    this.endOfDay = true;
    this._cleanupWs();
    LOGGER.success('Disconnected ✅');
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
  // SEND
  // ══════════════════════════════════════════════════════════════════════════

  _send(request) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      LOGGER.warn(`Cannot send (not connected): ${JSON.stringify(request).substring(0, 80)}`);
      return null;
    }
    request.req_id = this.reqId++;
    try {
      this.ws.send(JSON.stringify(request));
      return request.req_id;
    } catch (e) {
      LOGGER.error(`Send error: ${e.message}`);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MESSAGE ROUTER
  // ══════════════════════════════════════════════════════════════════════════

  _onRawMessage(data) {
    try {
      this._handleMessage(JSON.parse(data));
    } catch (e) {
      LOGGER.error(`Parse error: ${e.message}`);
    }
  }

  _handleMessage(msg) {
    if (msg.error) {
      this._handleApiError(msg);
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':              this._onAuthorize(msg);  break;
      case 'balance':                this._onBalance(msg);    break;
      case 'candles':                this._onCandlesHistory(msg); break;
      case 'ohlc':                   this._onOHLC(msg);       break;
      case 'proposal':               this._onProposal(msg);   break;
      case 'buy':                    this._onBuy(msg);        break;
      case 'proposal_open_contract': this._onContract(msg);   break;
      case 'ping':                   /* server-side ping — ignore */ break;
    }
  }

  _handleApiError(msg) {
    LOGGER.error(`API Error [${msg.error.code}]: ${msg.error.message} (msg_type: ${msg.msg_type})`);

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
        LOGGER.warn('Trade error — will retry on next candle close');
        // Force wait-for-candle so we don't spam retries
        this.waitingForCandle = true;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AUTHORIZE
  // ══════════════════════════════════════════════════════════════════════════

  _onAuthorize(msg) {
    if (msg.error) {
      LOGGER.error(`Authentication failed: ${msg.error.message}`);
      this._sendTelegram(`❌ <b>Authentication Failed:</b> ${msg.error.message}`);
      return;
    }

    this.isAuthorized = true;
    this.accountId    = msg.authorize.loginid;
    this.balance      = msg.authorize.balance;
    this.currency     = msg.authorize.currency;

    LOGGER.success(`Authorized ✅ | Account: ${this.accountId} | Balance: ${this.currency} ${this.balance.toFixed(2)}`);

    // Always subscribe to balance updates
    this._send({ balance: 1, subscribe: 1 });

    if (!this.hasStartedOnce) {
      // ── FIRST EVER connection — fresh start ─────────────────────────────
      this._sendTelegram(
        `✅ <b>V75 Grid Bot Connected</b>\n` +
        `Account: ${this.accountId}\n` +
        `Balance: ${this.currency} ${this.balance.toFixed(2)}`
      );
      // start() will subscribe to candles and set running = true
      setTimeout(() => { if (!this.running) this.start(); }, 300);

    } else {
      // ── RECONNECTION — resume from preserved state ───────────────────────
      LOGGER.info(
        `🔄 Reconnected — resuming | L${this.currentGridLevel} | ` +
        `${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} | ` +
        `Investment: $${this.investmentRemaining.toFixed(2)} | ` +
        `WaitingForCandle: ${this.waitingForCandle}`
      );
      this._sendTelegram(
        `🔄 <b>Reconnected — Resuming</b>\n` +
        `Account: ${this.accountId} | Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
        `Grid Level: ${this.currentGridLevel} | ` +
        `Next: ${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)}\n` +
        `Investment: $${this.investmentRemaining.toFixed(2)}\n` +
        `WaitingForCandle: ${this.waitingForCandle}`
      );

      // Re-subscribe to candles so OHLC stream resumes
      this._subscribeToCandles();

      // Re-subscribe to any open contract (if mid-trade when we dropped)
      if (this.currentContractId) {
        LOGGER.info(`Re-subscribing to open contract ${this.currentContractId}…`);
        this._send({ proposal_open_contract: 1, contract_id: this.currentContractId, subscribe: 1 });
      }

      // If not mid-trade and not waiting for candle → recovery trade fires
      // on next candle close (candle subscription above will deliver it)
      if (!this.tradeInProgress && !this.waitingForCandle && this.running) {
        LOGGER.info('Mid-streak recovery — trade will fire on next candle close ✅');
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BALANCE
  // ══════════════════════════════════════════════════════════════════════════

  _onBalance(msg) {
    this.balance = msg.balance.balance;
    LOGGER.info(`Balance: ${this.currency} ${this.balance.toFixed(2)}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CANDLE SUBSCRIPTION
  // ══════════════════════════════════════════════════════════════════════════

  _subscribeToCandles() {
    const { symbol, granularity, candlesHistory } = this.config;

    LOGGER.info(`Subscribing to ${granularity}s candles for ${symbol}…`);

    // 1) Load historical candles (gives us closed candle history)
    this._send({
      ticks_history:    symbol,
      adjust_start_time: 1,
      count:             candlesHistory,
      end:               'latest',
      start:             1,
      style:             'candles',
      granularity,
    });

    // 2) Live OHLC subscription
    this._send({
      ticks_history:    symbol,
      adjust_start_time: 1,
      count:             1,
      end:               'latest',
      start:             1,
      style:             'candles',
      granularity,
      subscribe:         1,
    });
  }

  // ── Historical candle load ────────────────────────────────────────────────
  _onCandlesHistory(msg) {
    if (msg.error) {
      LOGGER.error(`Candle history error: ${msg.error.message}`);
      return;
    }

    const symbol      = msg.echo_req.ticks_history;
    const granularity = this.config.granularity;

    const candles = (msg.candles || []).map(c => {
      const openTime = Math.floor((c.epoch - granularity) / granularity) * granularity;
      return {
        open:      parseFloat(c.open),
        high:      parseFloat(c.high),
        low:       parseFloat(c.low),
        close:     parseFloat(c.close),
        epoch:     c.epoch,
        open_time: openTime,
      };
    });

    if (candles.length === 0) {
      LOGGER.warn(`No historical candles received for ${symbol}`);
      return;
    }

    this.closedCandles                = [...candles];
    this.lastProcessedCandleOpenTime  = candles[candles.length - 1].open_time;
    this.currentFormingCandle         = null;   // will be set by first OHLC tick
    this.candlesLoaded                = true;

    LOGGER.success(`Loaded ${candles.length} historical candles for ${symbol} ✅`);
  }

  // ── Live OHLC tick — NEW CANDLE CLOSE DETECTION ──────────────────────────
  //   Identical logic to fractal bot handleOHLC:
  //   open_time changes → previous forming candle just closed.
  _onOHLC(msg) {
    if (msg.error) {
      LOGGER.error(`OHLC error: ${msg.error.message}`);
      return;
    }

    const ohlc        = msg.ohlc;
    const granularity = this.config.granularity;

    // Calculate the candle's open_time (same formula as fractal bot)
    const openTime = ohlc.open_time
      ? Number(ohlc.open_time)
      : Math.floor(ohlc.epoch / granularity) * granularity;

    const incomingCandle = {
      open:      parseFloat(ohlc.open),
      high:      parseFloat(ohlc.high),
      low:       parseFloat(ohlc.low),
      close:     parseFloat(ohlc.close),
      epoch:     ohlc.epoch,
      open_time: openTime,
    };

    const prevOpenTime = this.currentFormingCandle?.open_time;
    const isNewCandle  = prevOpenTime !== undefined && prevOpenTime !== null
      && incomingCandle.open_time !== prevOpenTime;

    if (isNewCandle) {
      // The previously forming candle is now closed
      const closedCandle = {
        ...this.currentFormingCandle,
        epoch: prevOpenTime + granularity,   // close epoch = open_time + granularity
      };

      // Only process each candle once (guard against duplicate ticks)
      if (closedCandle.open_time !== this.lastProcessedCandleOpenTime) {
        this.lastProcessedCandleOpenTime = closedCandle.open_time;

        // Add to rolling history
        this.closedCandles.push(closedCandle);
        if (this.closedCandles.length > this.config.candlesHistory) {
          this.closedCandles = this.closedCandles.slice(-this.config.candlesHistory);
        }

        const candleType  = closedCandle.close > closedCandle.open ? 'BULLISH 🟢'
          : closedCandle.close < closedCandle.open ? 'BEARISH 🔴' : 'DOJI ⚪';
        const closeTime   = new Date(closedCandle.epoch * 1000).toISOString();

        LOGGER.candle(
          `CANDLE CLOSED [${closeTime}] ${candleType} ` +
          `O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} ` +
          `L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)}`
        );

        // ── TRADE GATE: new candle closed → check if we should trade ────────
        this._onCandleClose(closedCandle);
      }
    }

    // Always update the forming candle
    this.currentFormingCandle = incomingCandle;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CANDLE CLOSE HANDLER — the central trade gate
  //
  // Rules:
  //   • waitingForCandle = true  → trade NOW (candle we were waiting for arrived)
  //   • waitingForCandle = false → we are mid-streak recovery; trade immediately
  //     (recovery trades do NOT wait for candle — they fire right after result)
  //     But we still arrive here on candle close; only the post-result path fires
  //     recovery trades directly.  The candle close path covers the case where
  //     a reconnect happened and we need to fire a recovery trade on next candle.
  // ══════════════════════════════════════════════════════════════════════════

  _onCandleClose(closedCandle) {
    if (!this.running) return;
    if (this.tradeInProgress) {
      LOGGER.info(`Candle closed — trade already in progress, skipping gate`);
      return;
    }

    if (this.waitingForCandle) {
      LOGGER.info(`🎯 Candle gate opened — placing trade now`);
      this.waitingForCandle = false;
      this._placeTrade();
    } else {
      // Not waiting — this candle close is irrelevant (recovery fires immediately
      // after trade result via _onContract → _scheduleNextTrade)
      LOGGER.info(`Candle closed — not waiting for candle (recovery fires immediately after result)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PROPOSAL → BUY
  // ══════════════════════════════════════════════════════════════════════════

  _onProposal(msg) {
    if (!this.running || !this.tradeInProgress) return;
    if (msg.proposal) {
      this._send({ buy: msg.proposal.id, price: msg.proposal.ask_price });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BUY CONFIRMATION
  // ══════════════════════════════════════════════════════════════════════════

  _onBuy(msg) {
    if (msg.error) {
      LOGGER.error(`Buy error: ${msg.error.message}`);
      this.tradeInProgress  = false;
      this.pendingTradeInfo = null;
      if (this.running) {
        LOGGER.warn('Buy failed — waiting for next candle to retry');
        this.waitingForCandle = true;
      }
      return;
    }

    const b = msg.buy;
    this.currentContractId   = b.contract_id;
    this.investmentRemaining = Math.max(0, Number((this.investmentRemaining - b.buy_price).toFixed(2)));

    LOGGER.trade(
      `Contract opened: ${b.contract_id} | Stake: $${b.buy_price.toFixed(2)} | ` +
      `Investment left: $${this.investmentRemaining.toFixed(2)}`
    );

    this._send({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT RESULT
  // ══════════════════════════════════════════════════════════════════════════

  _onContract(msg) {
    const c = msg.proposal_open_contract;
    if (!c.is_sold) return;

    const profit = parseFloat(c.profit);
    const isWin  = profit > 0;

    this.tradeInProgress   = false;
    this.pendingTradeInfo  = null;
    this.currentContractId = null;

    // ── Update counters ─────────────────────────────────────────────────────
    this.totalTrades += 1;
    this.totalProfit  = Number((this.totalProfit + profit).toFixed(2));
    if (isWin) { this.wins++;   this.isWinTrade = true;  }
    else       { this.losses++; this.isWinTrade = false; }

    this.currentStreak = isWin
      ? (this.currentStreak > 0 ? this.currentStreak + 1 : 1)
      : (this.currentStreak < 0 ? this.currentStreak - 1 : -1);
    if (isWin)  this.maxWinStreak  = Math.max(this.currentStreak,  this.maxWinStreak);
    if (!isWin) this.maxLossStreak = Math.min(this.currentStreak,  this.maxLossStreak);

    this.hourlyStats.trades++;
    this.hourlyStats.pnl += profit;
    if (isWin) this.hourlyStats.wins++; else this.hourlyStats.losses++;

    // ── Risk management ─────────────────────────────────────────────────────
    if (this.totalProfit <= -this.config.stopLoss) {
      LOGGER.error(`🛑 STOP LOSS hit! P&L: $${this.totalProfit.toFixed(2)}`);
      this._sendTelegram(`🛑 <b>STOP LOSS REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      this._logSummary();
      return;
    }
    if (this.totalProfit >= this.config.takeProfit) {
      LOGGER.success(`🎉 TAKE PROFIT hit! P&L: $${this.totalProfit.toFixed(2)}`);
      this._sendTelegram(`🎉 <b>TAKE PROFIT REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      this._logSummary();
      return;
    }

    let shouldContinue = true;
    const cfg          = this.config;

    if (isWin) {
      // ── WIN — reset to L0, flip direction (mean-reversion), WAIT for candle
      if (this.currentGridLevel > 0) this.totalRecovered += profit;
      this.investmentRemaining = Number((this.investmentRemaining + profit).toFixed(2));

      if (cfg.autoCompounding) {
        this.baseStake = Math.max(this.investmentRemaining * cfg.compoundPercentage / 100, 0.35);
      }

      const nextDir = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';

      LOGGER.success(
        `🎯 WIN +$${profit.toFixed(2)} | RECOVERY L${this.currentGridLevel} → RESET | ` +
        `Investment: $${this.investmentRemaining.toFixed(2)}${cfg.autoCompounding ? ` | New base: $${this.baseStake.toFixed(2)}` : ''} | ` +
        `Next: L0 ${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} ⏳ waiting for candle`
      );

      this.currentDirection = nextDir;
      this.currentGridLevel = 0;

      // ── TRADE GATE: WIN → wait for next candle ────────────────────────────
      this.waitingForCandle = true;
      LOGGER.info(`⏳ WIN detected — waiting for next candle close before next trade`);

      this._sendTelegramTradeResult(isWin, profit);

    } else {
      // ── LOSS — escalate martingale, switch direction, fire IMMEDIATELY ─────
      const nextLevel   = this.currentGridLevel + 1;
      const nextDir     = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';
      const absoluteMax = cfg.afterMaxLoss === 'continue'
        ? cfg.maxMartingaleLevel + cfg.continueExtraLevels
        : cfg.maxMartingaleLevel;

      this.currentGridLevel = nextLevel;
      this.currentDirection = nextDir;

      if (nextLevel > absoluteMax) {
        LOGGER.error(`🛑 ABSOLUTE CEILING L${absoluteMax} reached — stopping`);
        this._sendTelegram(
          `🛑 <b>ABSOLUTE MAX LEVEL REACHED (L${absoluteMax})</b>\n` +
          `Investment: $${this.investmentRemaining.toFixed(2)}\n` +
          `Total P&L: $${this.totalProfit.toFixed(2)}`
        );
        shouldContinue = false;

      } else if (nextLevel > cfg.maxMartingaleLevel) {
        const extraIdx  = nextLevel - cfg.maxMartingaleLevel - 1;
        const extraMult = (cfg.extraLevelMultipliers?.[extraIdx] > 0)
          ? cfg.extraLevelMultipliers[extraIdx]
          : cfg.martingaleMultiplier;
        LOGGER.warn(
          `🔴 EXTENDED RECOVERY L${nextLevel}/${absoluteMax} | Mult: ${extraMult}x | ` +
          `${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${this.calculateStake(nextLevel).toFixed(2)} (IMMEDIATE)`
        );

      } else if (nextLevel === cfg.maxMartingaleLevel) {
        if (cfg.afterMaxLoss === 'continue') {
          LOGGER.warn(`⚠️ MAX L${cfg.maxMartingaleLevel} — extending to L${absoluteMax} | Next: ${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${this.calculateStake(nextLevel).toFixed(2)} (IMMEDIATE)`);
        } else if (cfg.afterMaxLoss === 'stop') {
          LOGGER.warn(`⚠️ FINAL attempt L${cfg.maxMartingaleLevel} | ${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${this.calculateStake(nextLevel).toFixed(2)} (IMMEDIATE)`);
        } else if (cfg.afterMaxLoss === 'reset') {
          this.currentGridLevel = 0;
          this.currentDirection = 'CALLE';
          LOGGER.warn(`🔄 MAX LEVEL — Reset to L0 HIGHER (reset mode)`);
        }
      } else {
        LOGGER.warn(
          `📉 LOSS -$${Math.abs(profit).toFixed(2)} | → Grid L${this.currentGridLevel} | ` +
          `${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)} (IMMEDIATE)`
        );
      }

      this._sendTelegramTradeResult(isWin, profit);

      if (shouldContinue) {
        const nextStake = this.calculateStake(this.currentGridLevel);
        if (nextStake > this.investmentRemaining) {
          LOGGER.error(`🛑 INSUFFICIENT INVESTMENT: next $${nextStake} > remaining $${this.investmentRemaining.toFixed(2)}`);
          shouldContinue = false;
        } else if (nextStake > this.balance) {
          LOGGER.error(`🛑 INSUFFICIENT BALANCE: next $${nextStake} > balance $${this.balance.toFixed(2)}`);
          shouldContinue = false;
        }
      }

      // ── TRADE GATE: LOSS → NO candle wait — fire recovery immediately ──────
      this.waitingForCandle = false;
    }

    if (!shouldContinue) {
      this.running = false;
      this._logSummary();
      return;
    }

    if (this.running) {
      this._scheduleNextTrade(isWin);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCHEDULE NEXT TRADE
  //   WIN  → do nothing; _onCandleClose() will fire when next candle arrives
  //   LOSS → place next trade immediately (short delay for API breathing room)
  // ══════════════════════════════════════════════════════════════════════════

  _scheduleNextTrade(isWin) {
    if (isWin) {
      LOGGER.info(`⏳ Next trade gated — waiting for candle close…`);
      // _onCandleClose will call _placeTrade when waitingForCandle=true
    } else {
      LOGGER.info(`⚡ Recovery — placing next trade immediately (1 s delay)…`);
      setTimeout(() => {
        if (this.running && !this.tradeInProgress) this._placeTrade();
      }, 1000);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PLACE TRADE
  // ══════════════════════════════════════════════════════════════════════════

  _placeTrade() {
    if (!this.isAuthorized) { LOGGER.error('Not authorized — cannot trade');  return; }
    if (!this.running)      { return; }
    if (this.tradeInProgress) {
      LOGGER.warn('Trade already in progress — skipping');
      return;
    }

    const stake     = this.calculateStake(this.currentGridLevel);
    const direction = this.currentDirection;
    const label     = direction === 'CALLE' ? 'HIGHER' : 'LOWER';

    if (stake > this.investmentRemaining) {
      LOGGER.error(`Insufficient investment: stake $${stake} > remaining $${this.investmentRemaining.toFixed(2)}`);
      this.running = false;
      return;
    }
    if (stake > this.balance) {
      LOGGER.error(`Insufficient balance: stake $${stake} > balance $${this.balance.toFixed(2)}`);
      this.running = false;
      return;
    }

    LOGGER.trade(
      `Placing ${label} | L${this.currentGridLevel} | Stake: $${stake} | ` +
      `Investment left: $${this.investmentRemaining.toFixed(2)}`
    );

    // Freeze chain base at L0 for recovery math consistency
    if (this.currentGridLevel === 0) {
      this.chainBaseStake = stake;  // stake at L0 already = calculateStake(0)
    }

    this.tradeInProgress  = true;
    this.waitingForCandle = false;   // clear gate — trade is in flight
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
  // START
  // ══════════════════════════════════════════════════════════════════════════

  start() {
    if (!this.isAuthorized) { LOGGER.error('Not authorized — connect first'); return false; }
    if (this.running)       { LOGGER.warn('Bot already running');              return false; }

    const cfg = this.config;

    if (cfg.investmentAmount <= 0) {
      LOGGER.error('Invalid investment amount');
      return false;
    }
    if (cfg.investmentAmount > this.balance) {
      LOGGER.error(`Investment $${cfg.investmentAmount} exceeds balance $${this.balance.toFixed(2)}`);
      return false;
    }

    // Compute base stake
    this.baseStake = cfg.autoCompounding
      ? Math.max(cfg.investmentAmount * cfg.compoundPercentage / 100, 0.35)
      : cfg.initialStake;
    this.chainBaseStake = this.baseStake;

    if (cfg.autoCompounding) {
      LOGGER.info(`💰 Auto-compounding ON: ${cfg.compoundPercentage}% of $${cfg.investmentAmount} = $${this.baseStake.toFixed(2)} base stake`);
    } else {
      LOGGER.info(`💰 Fixed stake: $${this.baseStake.toFixed(2)}`);
    }

    this.running               = true;
    this.hasStartedOnce        = true;
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

    // Always wait for first candle on fresh start
    this.waitingForCandle = true;

    LOGGER.success('🚀 V75 Grid Martingale Bot STARTED!');
    LOGGER.info(
      `💵 Investment: $${cfg.investmentAmount} | Base: $${this.baseStake.toFixed(2)} | ` +
      `Mult: ${cfg.martingaleMultiplier}x | Max: L${cfg.maxMartingaleLevel} | ${cfg.tickDuration}t`
    );
    LOGGER.info(`⏳ Waiting for first candle close before first trade…`);

    if (cfg.afterMaxLoss === 'continue') {
      LOGGER.info(`🔄 Extended recovery: up to L${cfg.maxMartingaleLevel + cfg.continueExtraLevels}`);
    }

    this._sendTelegram(
      `🚀 <b>V75 Grid Bot STARTED</b>\n` +
      `💵 Investment: $${cfg.investmentAmount}\n` +
      `📊 Base Stake: $${this.baseStake.toFixed(2)}\n` +
      `🔢 Multiplier: ${cfg.martingaleMultiplier}x | Max Level: ${cfg.maxMartingaleLevel}\n` +
      `⏱ Duration: ${cfg.tickDuration} ticks\n` +
      `🕯️ Candle: ${cfg.granularity}s | Waiting for first candle close…\n` +
      `💰 Balance: ${this.currency} ${this.balance.toFixed(2)}`
    );

    // Start candle subscription
    this._subscribeToCandles();

    return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STOP
  // ══════════════════════════════════════════════════════════════════════════

  stop() {
    this.running         = false;
    this.tradeInProgress = false;
    LOGGER.warn('🛑 Bot stopped');
    this._sendTelegram(`🛑 <b>Bot stopped</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`);
    this._logSummary();
  }

  emergencyStop() {
    this.running         = false;
    this.tradeInProgress = false;
    LOGGER.error('🚨 EMERGENCY STOP — All activity halted!');
    this._sendTelegram(`🚨 <b>EMERGENCY STOP TRIGGERED</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`);
    this._logSummary();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARY LOG
  // ══════════════════════════════════════════════════════════════════════════

  _logSummary() {
    const wr = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0';
    LOGGER.info(
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
      LOGGER.error(`Telegram send failed: ${e.message}`);
    }
  }

  _sendTelegramTradeResult(isWin, profit) {
    const wr       = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0';
    const pnlStr   = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(2);
    const dirLabel = this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER';
    const nextInfo = isWin
      ? `⏳ Waiting for next candle before L0 ${dirLabel}`
      : `⚡ Recovery L${this.currentGridLevel} ${dirLabel} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)} (IMMEDIATE)`;

    this._sendTelegram(
      `${isWin ? '✅ WIN' : '❌ LOSS'} <b>— V75 Grid Bot</b>\n\n` +
      `${isWin ? '🟢' : '🔴'} <b>P&L:</b> ${pnlStr}\n` +
      `📊 <b>Grid Level:</b> ${isWin ? `L${this.currentGridLevel + 1} → RESET L0` : `L${this.currentGridLevel}`}\n` +
      `🎯 <b>Next:</b> ${nextInfo}\n\n` +
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
      `  Grid Level: ${this.currentGridLevel}\n` +
      `  Waiting for candle: ${this.waitingForCandle}\n\n` +
      `⏰ ${new Date().toLocaleString()}`
    );

    LOGGER.info('📱 Telegram hourly summary sent');
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

    LOGGER.info(`📱 Hourly Telegram summaries scheduled (first in ${Math.ceil(msUntilNext / 60000)} min)`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TIME SCHEDULER — weekend pause + end-of-day logic (GMT+1)
  // ══════════════════════════════════════════════════════════════════════════

  startTimeScheduler() {
    setInterval(() => {
      const gmt1    = new Date(Date.now() + 60 * 60 * 1000);
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
          LOGGER.warn('📅 Weekend trading pause (Sat 23:00 – Mon 08:00 GMT+1) — disconnecting');
          this._sendHourlySummary();
          this.stop();
          this.disconnect();
          this.endOfDay = true;
        }
        return;
      }

      // Resume Monday 08:00
      if (this.endOfDay && day === 1 && hours === 8 && minutes === 0) {
        LOGGER.success('📅 Monday 08:00 GMT+1 — reconnecting bot');
        this._resetDailyStats();
        this.endOfDay = false;
        this.connect();
      }

      // End-of-day: stop after a win past 17:00
      if (this.isWinTrade && !this.endOfDay && hours >= 17) {
        LOGGER.info('📅 Past 17:00 GMT+1 after a win — end-of-day stop');
        this._sendHourlySummary();
        this.stop();
        this.disconnect();
        this.endOfDay = true;
      }
    }, 20000);

    LOGGER.info('📅 Time scheduler started (weekend pause + EOD logic)');
  }

  _resetDailyStats() {
    this.tradeInProgress  = false;
    this.isWinTrade       = false;
    this.waitingForCandle = true;   // fresh day → wait for candle before first trade
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TERMINAL BANNER
// ══════════════════════════════════════════════════════════════════════════════

function printBanner() {
  const cfg = DEFAULT_CONFIG;
  console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║   V75 GRID MARTINGALE BOT — Headless Terminal Edition v2               ║');
  console.log('║   Volatility 75 Index (1HZ75V) | CALLE/PUTE | Candle-Gated Entry       ║');
  console.log('║                                                                          ║');
  console.log('║   Trade gate:                                                            ║');
  console.log('║     WIN  → wait for next candle close before next trade                 ║');
  console.log('║     LOSS → place recovery trade IMMEDIATELY (no candle wait)            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝\n');
  console.log(`  Symbol:      ${cfg.symbol}`);
  console.log(`  Granularity: ${cfg.granularity}s candles`);
  console.log(`  Tick dur:    ${cfg.tickDuration} ticks`);
  console.log(`  Martingale:  ${cfg.martingaleMultiplier}x | Max L${cfg.maxMartingaleLevel} (${cfg.afterMaxLoss})`);
  console.log(`  Investment:  $${cfg.investmentAmount} | StopLoss: $${cfg.stopLoss} | TP: $${cfg.takeProfit}`);
  console.log('\n  Signals: SIGINT / SIGTERM for graceful shutdown\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

function main() {
  printBanner();

  const bot = new V75GridBot(DEFAULT_CONFIG);

  // ── State persistence ────────────────────────────────────────────────────
  StatePersistence.startAutoSave(bot);

  // ── Telegram hourly summaries ────────────────────────────────────────────
  if (bot.telegramBot) bot.startTelegramTimer();

  // ── Time-based scheduler ─────────────────────────────────────────────────
  // bot.startTimeScheduler();

  // ── Connect — auth → start() fires inside _onAuthorize ──────────────────
  bot.connect();

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = (sig) => {
    console.log(`\n[${sig}] Shutting down gracefully…`);
    bot.stop();
    bot.disconnect();
    StatePersistence.save(bot);
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── Safety net ───────────────────────────────────────────────────────────
  process.on('unhandledRejection', (reason) => {
    LOGGER.error(`[UnhandledRejection] ${reason}`);
  });
  process.on('uncaughtException', (err) => {
    LOGGER.error(`[UncaughtException] ${err.message}`);
    // Don't exit — reconnect loop handles recovery
  });
}

main();
