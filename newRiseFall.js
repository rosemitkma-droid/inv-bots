// ============================================================================
// DERIV RISE/FALL TRADING BOT v4.0 — RNG MEAN-REVERSION OPTIMIZED
// Stripped of TA noise. Focused on Statistical Extremes & Recovery Management.
// ============================================================================

'use strict';

require('dotenv').config();
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
        symbol: 'R_75',
        initialStake: 0.35,
        contractDuration: 1, // CHANGED: 1 Minute instead of 5 ticks
        contractDurationUnit: 'm', // CHANGED: Minutes
        maxDailyLoss: 20,
        maxDailyTrades: 150,
        takeProfitTarget: 30,
        minTimeBetweenTrades: 15000, // 15s cooldown
      },
      analysis: {
        bbPeriod: 50,
        bbStdDev: 2.2, // Wider bands for RNG
        rsiPeriod: 14,
        rsiOverbought: 75,
        rsiOversold: 25,
        warmupTicks: 100,
      },
      risk: {
        // Capped Recovery System (Replaces Martingale/Kelly)
        recoveryMultiplier: 2.1,
        maxRecoverySteps: 3,
        drawdownLimit: 20,
      },
      system: {
        tickHistoryCount: 500,
        maxTickBuffer: 1000,
        reconnectDelay: 5000,
        maxReconnectAttempts: 15,
        heartbeatInterval: 30000,
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
// SECTION 2: LOGGER & TELEGRAM (Condensed for brevity, same as v3)
// ============================================================================
class Logger {
  constructor() {
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
      ),
      transports: [new winston.transports.Console(), new winston.transports.File({ filename: 'bot.log' })],
    });
  }
  info(msg) { this.logger.info(msg); }
  warn(msg) { this.logger.warn(msg); }
  error(msg) { this.logger.error(msg); }
}

class TelegramService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.enabled = config.telegram.enabled;
    if (this.enabled) this.bot = new TelegramBot(config.telegram.botToken, { polling: false });
  }
  async send(msg) {
    if (!this.enabled) return;
    try { await this.bot.sendMessage(this.config.telegram.chatId, msg, { parse_mode: 'HTML' }); } 
    catch (e) { this.logger.error(`TG Error: ${e.message}`); }
  }
}

// ============================================================================
// SECTION 3: INDICATORS (Stripped to only what works on RNG)
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
      percentB: (data[data.length - 1] - (sma - stdMult * stdDev)) / (2 * stdMult * stdDev)
    };
  }

  static RSI(data, period) {
    if (data.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = data.length - period; i < data.length; i++) {
      const diff = data[i] - data[i - 1];
      if (diff > 0) gains += diff; else losses -= diff;
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
  }

  predict(prices) {
    if (prices.length < this.config.warmupTicks) {
      return { signal: 'WAIT', reason: 'Warming up...' };
    }

    const bb = Indicators.BollingerBands(prices, this.config.bbPeriod, this.config.bbStdDev);
    const rsi = Indicators.RSI(prices, this.config.rsiPeriod);

    if (!bb || rsi === null) return { signal: 'WAIT', reason: 'Calculating...' };

    const currentPrice = prices[prices.length - 1];
    const prevPrice = prices[prices.length - 2];

    // 1. Extreme Oversold + Price starting to tick UP = CALLE
    if (currentPrice <= bb.lower && rsi < this.config.rsiOversold && currentPrice > prevPrice) {
      return {
        signal: 'CALLE',
        confidence: Math.min(95, 60 + (this.config.rsiOversold - rsi)),
        reason: `Price < Lower BB | RSI: ${rsi.toFixed(1)} | Tick UP confirmed`
      };
    }

    // 2. Extreme Overbought + Price starting to tick DOWN = PUTE
    if (currentPrice >= bb.upper && rsi > this.config.rsiOverbought && currentPrice < prevPrice) {
      return {
        signal: 'PUTE',
        confidence: Math.min(95, 60 + (rsi - this.config.rsiOverbought)),
        reason: `Price > Upper BB | RSI: ${rsi.toFixed(1)} | Tick DOWN confirmed`
      };
    }

    return { signal: 'WAIT', reason: 'No extreme deviation' };
  }
}

// ============================================================================
// SECTION 5: RISK & TRADE MANAGER (Capped Recovery System)
// ============================================================================
class RiskAndTradeManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.consecutiveLosses = 0;
    this.dailyPnL = 0;
    this.totalTrades = 0;
    this.wins = 0;
    this.lastResetDate = new Date().toDateString();
  }

  checkDailyReset() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyPnL = 0;
      this.lastResetDate = today;
    }
  }

  // The ONLY way to beat the 95% payout math is a capped recovery system
  calculateStake() {
    const base = this.config.trading.initialStake;
    if (this.consecutiveLosses === 0) return base;
    
    const step = Math.min(this.consecutiveLosses, this.config.risk.maxRecoverySteps);
    // Multiplier is 2.1 to cover the 95% payout loss and make a tiny profit
    const stake = base * Math.pow(this.config.risk.recoveryMultiplier, step); 
    return parseFloat(stake.toFixed(2));
  }

  recordTrade(profit) {
    this.totalTrades++;
    this.dailyPnL += profit;
    
    if (profit > 0) {
      this.wins++;
      this.consecutiveLosses = 0; // Reset on win
    } else {
      this.consecutiveLosses++;
    }
  }

  canTrade() {
    this.checkDailyReset();
    if (this.dailyPnL <= -this.config.trading.maxDailyLoss) return { allowed: false, reason: 'Daily Loss Limit Hit' };
    if (this.dailyPnL >= this.config.trading.takeProfitTarget) return { allowed: false, reason: 'Daily Profit Target Hit' };
    if (this.totalTrades >= this.config.trading.maxDailyTrades) return { allowed: false, reason: 'Max Trades Hit' };
    return { allowed: true };
  }

  getStats() {
    return {
      trades: this.totalTrades,
      wins: this.wins,
      winRate: this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0',
      dailyPnL: this.dailyPnL.toFixed(2),
      currentStreak: this.consecutiveLosses > 0 ? `-${this.consecutiveLosses}L` : '0'
    };
  }
}

// ============================================================================
// SECTION 6: DERIV REST CLIENT (PAT / OAuth OTP auth flow — same as reference)
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
          try { parsed = JSON.parse(data); } catch (_) { }
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
// SECTION 6b: DERIV API CLIENT (PAT / OTP flow — same method as reference bot)
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
    this.maxReconnectAttempts = config.system.maxReconnectAttempts;
    this.reconnectDelay = config.system.reconnectDelay;
    this.isReconnecting = false;
    this.isShuttingDown = false;
    this.reconnectTimer = null;
    this.pingInterval = null;

    this._isPat = RestClient.isPat(config.deriv.apiToken);
    this._rest = this._isPat
      ? new RestClient('https://api.derivws.com', config.deriv.appId, config.deriv.apiToken)
      : null;
    this._otpUrl = null;
    this._targetAccount = null;
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) { this.logger.info('Already connected'); return; }
    if (!this.config.deriv.apiToken) { this.logger.error('API_TOKEN is empty — aborting'); return; }
    this.logger.info('Connecting to Deriv API...');
    this.cleanup();
    this.isShuttingDown = false;

    if (this._isPat) {
      this.logger.info('PAT token detected -> using NEW Deriv API (OTP flow)');
      this._newApiConnect().catch(err => {
        this.logger.error(`New API connect failed: ${err.message}`);
        this.onClose();
      });
    } else {
      this.logger.info('Using legacy Deriv API (token authorize flow)');
      this._openWs(`${this.config.deriv.endpoint}`);
    }
  }

  _openWs(url) {
    try {
      this.ws = new WebSocket(url, {
        headers: { 'User-Agent': 'Bot/1.0 (+Node.js)' },
        handshakeTimeout: 15000,
      });
    } catch (e) {
      this.logger.error(`WS construct failed: ${e.message}`);
      this.onClose();
      return;
    }

    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', data => this._onMessage(data));
    this.ws.on('error', err => this._onError(err));
    this.ws.on('close', () => this.onClose());
    this.ws.on('unexpected-response', (_req, res) => {
      this.logger.error(`WS handshake failed: ${res.statusCode} ${res.statusMessage}`);
      try { res.destroy(); } catch (_) { }
      this.onClose();
    });
  }

  async _newApiConnect() {
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

    this._otpUrl = wsUrl;
    this._openWs(wsUrl);
  }

  _markAuthorized() {
    if (!this.accountInfo) return;

    this.logger.info(
      `Authorized ${this.accountInfo.loginid}` +
      `(${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'})` +
      `balance=${this.accountInfo.balance} ${this.accountInfo.currency} via PAT/new-API`
    );

    this.balance = this.accountInfo.balance;
    this.send({ balance: 1, subscribe: 1 });
    this.emit('connected', this.accountInfo);
  }

  onOpen() {
    this.logger.info('WS Connected');
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this.startPing();

    if (this._isPat) {
      this._markAuthorized();
    } else {
      this.send({ authorize: this.config.deriv.apiToken });
    }
  }

  _onMessage(data) {
    let res;
    try { res = JSON.parse(data); }
    catch (e) { this.logger.error(`Parse error: ${e.message}`); return; }
    this._handle(res);
  }

  _handle(res) {
    if (res.msg_type === 'tick' && res.tick && typeof res.tick.quote !== 'undefined') {
      this.emit('tick', res.tick);
    }
    if (res.msg_type === 'proposal_open_contract' && res.proposal_open_contract && res.proposal_open_contract.is_sold) {
      this.emit('contract_sold', res.proposal_open_contract);
    }
    if (res.msg_type === 'balance') this.balance = parseFloat(res.balance.balance);
    if (res.msg_type === 'authorize' && !this._isPat) {
      if (res.error) { this.logger.error(`Auth failed: ${res.error.message}`); return; }
      this.balance = parseFloat(res.authorize.balance);
      this.accountInfo = res.authorize;
      this.send({ balance: 1, subscribe: 1 });
      this.emit('connected', res.authorize);
    }

    if (res.req_id && this.pending.has(res.req_id)) {
      const { resolve, reject } = this.pending.get(res.req_id);
      this.pending.delete(res.req_id);
      res.error ? reject(new Error(res.error.message)) : resolve(res);
    }
  }

  async getTickHistory(symbol, count = 500) {
    const res = await this.send({ ticks_history: symbol, count, end: 'latest', style: 'ticks' });
    if (res.error || !res.history) return [];
    const { times, prices } = res.history;
    return times.map((t, i) => parseFloat(prices[i]));
  }

  send(req) {
    if (this.ws?.readyState !== WebSocket.OPEN) { this.logger.error('Cannot send: WebSocket not open'); return Promise.reject(new Error('WebSocket not open')); }
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      req.req_id = id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(req));
    });
  }

  async buy(params) {
    const symbolKey = this._isPat ? 'underlying_symbol' : 'symbol';
    const res = await this.send({
      buy: 1, subscribe: 1, price: params.amount,
      parameters: {
        contract_type: params.type, [symbolKey]: params.symbol,
        duration: params.duration, duration_unit: params.unit,
        basis: 'stake', amount: params.amount, currency: 'USD'
      }
    });
    return res.buy;
  }

  _onError(err) { this.logger.error(`WebSocket error: ${err.message}`); }

  onClose() {
    this.logger.warn('Disconnected from Deriv API');
    this.stopPing();
    this.emit('disconnect');

    if (this.isShuttingDown) return;
    if (this.isReconnecting) return;

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.isReconnecting = true;
      this.reconnectAttempts++;
      const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
      this.logger.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})`);

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.isShuttingDown) return;
        this.isReconnecting = false;
        this.connect();
      }, delay);
    } else {
      this.logger.error('Max reconnection attempts reached — giving up');
      process.exit(1);
    }
  }

  startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 30000);
  }

  stopPing() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

  cleanup() {
    this.stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.ws.removeAllListeners();
      try { if (this.ws.readyState <= 1) this.ws.close(); } catch { }
      this.ws = null;
    }
  }

  shutdown() {
    this.isShuttingDown = true;
    this.isReconnecting = false;
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
    
    this.prices = [];
    this.isTrading = true;
    this.lastTradeTime = 0;
  }

  async start() {
    this.logger.info('🚀 Starting Deriv Bot v4.0 (RNG Optimized)...');

    const connected = new Promise((resolve) => {
      this.api.once('connected', (account) => resolve(account));
    });
    this.api.connect();
    const account = await connected;

    this.logger.info(`✅ Authorized: ${account.loginid} | Balance: $${this.api.balance}`);

    await this.tg.send(`🤖 <b>Bot v4.0 Started</b>\nBalance: $${this.api.balance}\nSymbol: ${this.config.trading.symbol}\nDuration: ${this.config.trading.contractDuration}m`);

    this.api.on('tick', (t) => this.onTick(t));
    this.api.on('contract_sold', (c) => this.onContractSold(c));
    this.api.on('disconnect', () => { this.isTrading = false; });
    this.api.on('connected', async () => {
      this.isTrading = true;
      await this.api.send({ ticks: this.config.trading.symbol, subscribe: 1 });
    });

    // Backfill price history so indicators have data immediately (like bizarbitrage.js)
    this.prices = await this.api.getTickHistory(this.config.trading.symbol, this.config.system.tickHistoryCount);
    this.logger.info(`📊 Backfilled ${this.prices.length} ticks from history`);

    // Subscribe to live ticks
    await this.api.send({ ticks: this.config.trading.symbol, subscribe: 1 });
    this.logger.info('📡 Listening to ticks...');
  }

  async onTick(tick) {
    if (!this.isTrading) return;
    if (!tick || typeof tick.quote === 'undefined') return;

    const price = parseFloat(tick.quote);
    if (isNaN(price)) return;
    this.prices.push(price);
    if (this.prices.length > this.config.system.maxTickBuffer) {
      this.prices = this.prices.slice(-500);
    }

    // Cooldown check
    if (Date.now() - this.lastTradeTime < this.config.trading.minTimeBetweenTrades) return;

    // Predict
    const prediction = this.predictor.predict(this.prices);
    if (prediction.signal === 'WAIT') return;

    // Risk Check
    const canTrade = this.risk.canTrade();
    if (!canTrade.allowed) {
      this.logger.warn(`Trading paused: ${canTrade.reason}`);
      this.isTrading = false;
      await this.tg.send(`⛔ <b>Paused:</b> ${canTrade.reason}`);
      return;
    }

    await this.executeTrade(prediction, price);
  }

  async executeTrade(prediction, price) {
    const stake = this.risk.calculateStake();
    
    if (stake > this.api.balance) {
      this.logger.error('Insufficient balance for recovery stake!');
      this.isTrading = false;
      await this.tg.send('⛔ <b>Stopped:</b> Insufficient balance for recovery stake.');
      return;
    }

    this.logger.info(`🎯 SIGNAL: ${prediction.signal} | Stake: $${stake} | ${prediction.reason}`);

    try {
      const contract = await this.api.buy({
        type: prediction.signal,
        symbol: this.config.trading.symbol,
        duration: this.config.trading.contractDuration,
        unit: this.config.trading.contractDurationUnit,
        amount: stake
      });

      this.lastTradeTime = Date.now();
      this.logger.info(`✅ Opened Contract: ${contract.contract_id}`);
      
      await this.tg.send(`📈 <b>TRADE OPENED</b>\nDir: ${prediction.signal}\nStake: $${stake}\nReason: ${prediction.reason}`);
    } catch (e) {
      this.logger.error(`Trade failed: ${e.message}`);
    }
  }

  async onContractSold(contract) {
    const profit = parseFloat(contract.profit);
    this.risk.recordTrade(profit);
    const stats = this.risk.getStats();

    const emoji = profit > 0 ? '✅' : '❌';
    this.logger.info(`${emoji} ${profit > 0 ? 'WIN' : 'LOSS'} | P/L: ${profit > 0 ? '+' : ''}$${profit.toFixed(2)} | Daily: $${stats.dailyPnL} | WR: ${stats.winRate}%`);
    
    await this.tg.send(`${emoji} <b>${profit > 0 ? 'WIN' : 'LOSS'}</b>\nP/L: ${profit > 0 ? '+' : ''}$${profit.toFixed(2)}\nDaily: $${stats.dailyPnL}\nWin Rate: ${stats.winRate}%`);

    // Check daily limits after trade
    const canTrade = this.risk.canTrade();
    if (!canTrade.allowed) {
      this.isTrading = false;
      await this.tg.send(`🛑 <b>Session Over:</b> ${canTrade.reason}`);
    }
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================
(async () => {
  const bot = new DerivBot();
  await bot.start();
})();
