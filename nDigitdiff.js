'use strict';

/**
 * DERIV DIGITDIFF RESEARCH BOT — MERGED VERSION
 *
 * Merges the safer research-grade DIGITDIFF logic into the user's original
 * operational bot structure:
 * - Telegram trade/signal/result reporting
 * - session/hourly/day summaries
 * - auto-save state persistence
 * - reconnect scheduler
 * - multi-asset monitoring
 *
 * Core strategy changes vs the original frequency bot:
 * - flat stake by default (no martingale)
 * - proposal-aware EV gating
 * - conservative Bayesian digit probability estimates
 * - conditional transition stats from current digit -> next digit
 * - one-trade-at-a-time discipline by default
 * - paper/live modes
 *
 * Required env vars:
 *   DERIV_TOKEN=...
 * Optional:
 *   DERIV_APP_ID=1089
 *   TRADE_MODE=paper|live
 *   ASSETS=R_10,R_25,R_50,R_75
 *   STAKE=1
 *   ACCOUNT_CURRENCY=USD
 *   TELEGRAM_TOKEN=...
 *   TELEGRAM_CHAT_ID=...
 */

require('dotenv').config();
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

let TelegramBot = null;
try {
  TelegramBot = require('node-telegram-bot-api');
} catch (_) {
  TelegramBot = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const BOT_CONFIG = {
  appId: Number(1089),
  token: 'rgNedekYXvCaPeP', // process.env.DERIV_TOKEN || 'rg
  tradeMode: ('live').toLowerCase(), // paper | live
  assets: ('R_10,R_25,R_50')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean),

  initialStake: Number(1),
  flatStake: ('true').toLowerCase() !== 'false',
  maxExposure: Number(5),

  stopLoss: Number(25),
  takeProfit: Number(25),
  maxConsecutiveLosses: Number(3),

  contract: {
    type: 'DIGITDIFF',
    duration: Number(1),
    durationUnit: 't',
    currency: 'USD',
  },

  analysis: {
    minHistorySize: Number(3000),
    shortWindow: Number(50),
    mediumWindow: Number(250),
    longWindow: Number(1000),
    transitionLookback: Number(2000),

    priorDigitProbability: 0.10,
    priorStrength: Number(300),
    conservativeZ: Number(1.64),
    minTransitionSamples: Number(80),

    preProposalMaxLoseProb: Number(0.11), //Number(0.0925)
    requiredEdgeMargin: Number(0.0000001),
    minDigitGapVsRunnerUp: Number(0.0015),
  },

  minTimeBetweenTrades: Number(25000),
  cooldownAfterLoss: Number(45000),
  maxTradesPerHour: Number(30),
  maxTradesPerDay: Number(100),
  oneTradeGlobally: ('true').toLowerCase() !== 'false',
  maxProposalAgeMs: Number(4000),

  telegramToken: '8106601008:AAEMyCma6mvPYIHEvw3RHQX2tkD5-wUe1o0',
  telegramChatId: '752497117',

  maxReconnectAttempts: Number(50),
  reconnectDelay: Number(5000),

  scheduler: {
    enableNightShutdown: ('true').toLowerCase() === 'false',
    shutdownHourGMT1: Number(23),
    restartHourGMT1: Number(2),
  },

  files: {
    state: path.join(__dirname, 'digitdiff_merged_state_05.json'),
    signals: path.join(__dirname, 'digitdiff_merged_signals_05.csv'),
    trades: path.join(__dirname, 'digitdiff_merged_trades_05.csv'),
  },
};

const STATE_SAVE_INTERVAL = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function nowMs() {
  return Date.now();
}

function dateKey() {
  return new Date().toISOString().split('T')[0];
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function ensureCsv(filePath, headerLine) {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, headerLine + '\n', 'utf8');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function appendCsv(filePath, row) {
  fs.appendFileSync(filePath, row.map(csvEscape).join(',') + '\n', 'utf8');
}

function breakEvenWinRate(askPrice, payout) {
  if (askPrice <= 0 || payout <= 0) return 1;
  return askPrice / payout;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
class StatePersistence {
  static save(bot) {
    try {
      const payload = {
        savedAt: nowMs(),
        stats: {
          currentStake: bot.currentStake,
          consecutiveLosses: bot.consecutiveLosses,
          totalTrades: bot.totalTrades,
          totalWins: bot.totalWins,
          totalLosses: bot.totalLosses,
          totalProfitLoss: bot.totalProfitLoss,
          dailyProfitLoss: bot.dailyProfitLoss,
          dayTrades: bot.dayTrades,
          endOfDay: bot.endOfDay,
          currentTradeDay: bot.currentTradeDay,
        },
        session: bot.session,
        assetMetrics: bot.assetMetrics,
        hourlyStats: bot.hourlyStats,
      };
      fs.writeFileSync(bot.cfg.files.state, JSON.stringify(payload, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('❌ Save failed:', error.message);
      return false;
    }
  }

  static load(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      console.error('❌ Load failed:', error.message);
      return null;
    }
  }

  static startAutoSave(bot) {
    if (bot._autoSaveTimer) clearInterval(bot._autoSaveTimer);
    bot._autoSaveTimer = setInterval(() => {
      if (bot.connected) StatePersistence.save(bot);
    }, STATE_SAVE_INTERVAL);

    const shutdown = () => {
      console.log('\n🛑 Saving state before exit…');
      StatePersistence.save(bot);
      process.exit();
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('uncaughtException', error => {
      console.error(error);
      shutdown();
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYZER
// ─────────────────────────────────────────────────────────────────────────────
class DigitDiffResearchAnalyzer {
  constructor(config) {
    this.cfg = config.analysis;
  }

  _countDigit(digits, targetDigit, windowSize) {
    const window = windowSize ? digits.slice(-windowSize) : digits;
    let count = 0;
    for (const d of window) if (d === targetDigit) count++;
    return { count, n: window.length };
  }

  _transitionStats(digits, currentDigit) {
    const lookback = this.cfg.transitionLookback;
    const start = Math.max(0, digits.length - lookback - 1);
    const nextCounts = Array(10).fill(0);
    let total = 0;

    for (let i = start; i < digits.length - 1; i++) {
      if (digits[i] === currentDigit) {
        total++;
        const next = digits[i + 1];
        if (next >= 0 && next <= 9) nextCounts[next]++;
      }
    }

    return { total, nextCounts };
  }

  _betaPosterior(count, n) {
    const priorMean = this.cfg.priorDigitProbability;
    const priorStrength = this.cfg.priorStrength;
    const alpha = priorMean * priorStrength + count;
    const beta = (1 - priorMean) * priorStrength + (n - count);
    const mean = alpha / (alpha + beta);
    const variance = (alpha * beta) / (((alpha + beta) ** 2) * (alpha + beta + 1));
    const std = Math.sqrt(Math.max(variance, 0));
    const upper = clamp(mean + this.cfg.conservativeZ * std, 0, 1);
    return { mean, upper, alpha, beta, std };
  }

  _streakInfo(digits) {
    const last = digits[digits.length - 1];
    let streak = 1;
    for (let i = digits.length - 2; i >= 0; i--) {
      if (digits[i] !== last) break;
      streak++;
    }
    return { digit: last, streak };
  }

  _buildCandidate(digits, currentDigit, targetDigit) {
    const short = this._countDigit(digits, targetDigit, this.cfg.shortWindow);
    const medium = this._countDigit(digits, targetDigit, this.cfg.mediumWindow);
    const long = this._countDigit(digits, targetDigit, this.cfg.longWindow);
    const transition = this._transitionStats(digits, currentDigit);

    const shortPost = this._betaPosterior(short.count, short.n);
    const mediumPost = this._betaPosterior(medium.count, medium.n);
    const longPost = this._betaPosterior(long.count, long.n);

    let transitionPost = null;
    let transitionWeight = 0;
    if (transition.total >= this.cfg.minTransitionSamples) {
      transitionPost = this._betaPosterior(transition.nextCounts[targetDigit], transition.total);
      transitionWeight = 0.35;
    }

    const baseWeight = (1 - transitionWeight) / 3;
    const weights = {
      short: baseWeight,
      medium: baseWeight,
      long: baseWeight,
      transition: transitionWeight,
    };

    const loseProbMean =
      shortPost.mean * weights.short +
      mediumPost.mean * weights.medium +
      longPost.mean * weights.long +
      (transitionPost ? transitionPost.mean * weights.transition : 0);

    const loseProbUpper =
      shortPost.upper * weights.short +
      mediumPost.upper * weights.medium +
      longPost.upper * weights.long +
      (transitionPost ? transitionPost.upper * weights.transition : 0);

    const signalScore = clamp((0.12 - loseProbUpper) * 8 + 0.2, 0, 1);

    return {
      digit: targetDigit,
      loseProbMean,
      loseProbUpper,
      winProbMean: 1 - loseProbMean,
      winProbLower: 1 - loseProbUpper,
      signalScore,
      weights,
      stats: {
        short: { ...short, mean: shortPost.mean, upper: shortPost.upper },
        medium: { ...medium, mean: mediumPost.mean, upper: mediumPost.upper },
        long: { ...long, mean: longPost.mean, upper: longPost.upper },
        transition: transitionPost
          ? {
              total: transition.total,
              count: transition.nextCounts[targetDigit],
              mean: transitionPost.mean,
              upper: transitionPost.upper,
              conditionedOnCurrentDigit: currentDigit,
            }
          : {
              total: transition.total,
              count: transition.nextCounts[targetDigit],
              unavailable: true,
              conditionedOnCurrentDigit: currentDigit,
            },
      },
    };
  }

  analyze(digitArray) {
    if (!Array.isArray(digitArray) || digitArray.length < this.cfg.minHistorySize) {
      return {
        shouldRequestProposal: false,
        reason: 'insufficient_history',
        currentHistory: Array.isArray(digitArray) ? digitArray.length : 0,
        requiredHistory: this.cfg.minHistorySize,
      };
    }

    const currentDigit = digitArray[digitArray.length - 1];
    const streak = this._streakInfo(digitArray);
    const candidates = [];

    for (let digit = 0; digit <= 9; digit++) {
      candidates.push(this._buildCandidate(digitArray, currentDigit, digit));
    }

    candidates.sort((a, b) => a.loseProbMean - b.loseProbMean);

    const best = candidates[0];
    const runnerUp = candidates[1] || null;
    const gapVsRunnerUp = runnerUp ? (runnerUp.loseProbMean - best.loseProbMean) : 0;

    const shouldRequestProposal =
      best.loseProbUpper <= this.cfg.preProposalMaxLoseProb &&
      gapVsRunnerUp >= this.cfg.minDigitGapVsRunnerUp;

    return {
      shouldRequestProposal,
      reason: shouldRequestProposal ? 'pre_proposal_signal' : 'no_statistical_edge',
      currentDigit,
      predictedDigit: best.digit,
      contractType: 'DIGITDIFF',
      signalScore: best.signalScore,
      estimatedLoseProb: best.loseProbMean,
      conservativeLoseProb: best.loseProbUpper,
      estimatedWinProb: best.winProbMean,
      conservativeWinProb: best.winProbLower,
      gapVsRunnerUp,
      streak,
      analysis: best,
      allCandidates: candidates.slice(0, 3),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN BOT
// ─────────────────────────────────────────────────────────────────────────────
class DerivDigitDiffMergedBot {
  constructor(config) {
    this.cfg = config;
    this.analyzer = new DigitDiffResearchAnalyzer(config);

    this.ws = null;
    this.connected = false;
    this.wsReady = false;
    this.reconnectAttempts = 0;
    this.pingInterval = null;

    this.activeTrades = {};      // asset -> trade
    this.pendingProposals = {};  // asset -> { analysis, requestedAt }
    this.contractSubs = {};      // asset -> subscription id
    this.watchdogs = {};         // asset -> timeout

    this.currentStake = config.initialStake;
    this.consecutiveLosses = 0;
    this.totalTrades = 0;
    this.totalWins = 0;
    this.totalLosses = 0;
    this.totalProfitLoss = 0;
    this.dailyProfitLoss = 0;
    this.dayTrades = 0;
    this.endOfDay = false;
    this.currentTradeDay = dateKey();

    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
    this.session = {
      startTime: nowMs(),
      startCapital: 0,
      tradesCount: 0,
      winsCount: 0,
      lossesCount: 0,
      netPL: 0,
      mode: this.cfg.tradeMode,
    };

    this.hourlyTrades = [];
    this.lastTradeTime = {};
    this.lastLossTime = {};

    this.priceHistories = {};
    this.digitHistories = {};
    this.historyLoaded = {};
    this.pipSizes = {};
    this.assetMetrics = {};

    for (const asset of config.assets) {
      this.priceHistories[asset] = [];
      this.digitHistories[asset] = [];
      this.historyLoaded[asset] = false;
      this.pipSizes[asset] = null;
      this.lastTradeTime[asset] = 0;
      this.lastLossTime[asset] = 0;
      this.assetMetrics[asset] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
      this.pendingProposals[asset] = null;
    }

    this.telegram = null;
    if (TelegramBot && config.telegramToken && config.telegramChatId) {
      this.telegram = new TelegramBot(config.telegramToken, { polling: false });
    }

    ensureCsv(this.cfg.files.signals,
      'timestamp,asset,mode,current_digit,target_digit,estimated_lose_prob,conservative_lose_prob,estimated_win_prob,conservative_win_prob,gap_vs_runner_up,reason,short_count,short_n,medium_count,medium_n,long_count,long_n,transition_count,transition_n,ask_price,payout,break_even_win_rate,required_max_lose_prob,decision');
    ensureCsv(this.cfg.files.trades,
      'timestamp,asset,mode,barrier_digit,entry_digit,exit_digit,won,stake,payout,profit,estimated_lose_prob,conservative_lose_prob,break_even_win_rate,day_pnl,total_pnl');

    this._loadState();
  }

  _loadState() {
    const state = StatePersistence.load(this.cfg.files.state);
    if (!state) return;
    try {
      if (state.stats) {
        if (state.stats.currentTradeDay === dateKey()) {
          this.currentStake = state.stats.currentStake || this.cfg.initialStake;
          this.consecutiveLosses = state.stats.consecutiveLosses || 0;
          this.totalTrades = state.stats.totalTrades || 0;
          this.totalWins = state.stats.totalWins || 0;
          this.totalLosses = state.stats.totalLosses || 0;
          this.totalProfitLoss = state.stats.totalProfitLoss || 0;
          this.dailyProfitLoss = state.stats.dailyProfitLoss || 0;
          this.dayTrades = state.stats.dayTrades || 0;
          this.endOfDay = state.stats.endOfDay || false;
          this.currentTradeDay = state.stats.currentTradeDay || dateKey();
        } else {
          this.totalTrades = state.stats.totalTrades || 0;
          this.totalWins = state.stats.totalWins || 0;
          this.totalLosses = state.stats.totalLosses || 0;
          this.totalProfitLoss = state.stats.totalProfitLoss || 0;
        }
      }

      if (state.assetMetrics) this.assetMetrics = state.assetMetrics;
      if (state.session) this.session = { ...this.session, ...state.session };
      if (state.hourlyStats) this.hourlyStats = state.hourlyStats;

      console.log(`✅ State restored — ${this.totalTrades} trades, P&L $${this.totalProfitLoss.toFixed(2)}`);
    } catch (error) {
      console.error('❌ State restore error:', error.message);
    }
  }

  _anyActiveTrade() {
    return Object.values(this.activeTrades).find(Boolean) || null;
  }

  _canTrade(asset) {
    const now = nowMs();

    if (this.endOfDay) return { can: false, reason: 'end_of_day' };
    if (this.cfg.flatStake && this.cfg.initialStake > this.cfg.maxExposure) {
      return { can: false, reason: 'stake_above_max_exposure' };
    }
    if (this.cfg.oneTradeGlobally && this._anyActiveTrade()) {
      return { can: false, reason: 'global_trade_in_progress' };
    }
    if (this.activeTrades[asset]) return { can: false, reason: 'trade_in_progress' };
    if (this.pendingProposals[asset]) return { can: false, reason: 'proposal_pending' };
    if (now - this.lastTradeTime[asset] < this.cfg.minTimeBetweenTrades) {
      return { can: false, reason: 'asset_cooldown' };
    }
    if (now - this.lastLossTime[asset] < this.cfg.cooldownAfterLoss) {
      return { can: false, reason: 'loss_cooldown' };
    }

    this.hourlyTrades = this.hourlyTrades.filter(t => now - t < 3600000);
    if (this.hourlyTrades.length >= this.cfg.maxTradesPerHour) {
      return { can: false, reason: 'hourly_limit' };
    }
    if (this.dayTrades >= this.cfg.maxTradesPerDay) {
      return { can: false, reason: 'daily_trade_limit' };
    }
    if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
      return { can: false, reason: 'consecutive_loss_limit' };
    }
    if (this.totalProfitLoss <= -Math.abs(this.cfg.stopLoss)) {
      return { can: false, reason: 'stop_loss_hit' };
    }
    if (this.totalProfitLoss >= Math.abs(this.cfg.takeProfit)) {
      return { can: false, reason: 'take_profit_hit' };
    }

    return { can: true };
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const url = `wss://ws.derivws.com/websockets/v3?app_id=${this.cfg.appId}`;
    console.log('🔌 Connecting to Deriv API…');
    this._cleanupWs();
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('✅ WebSocket connected');
      this.connected = true;
      this.reconnectAttempts = 0;
      this._startPing();
      this._send({ authorize: this.cfg.token });
    });

    this.ws.on('message', data => {
      try {
        this._handleMessage(JSON.parse(data));
      } catch (error) {
        console.error('Parse error:', error.message);
      }
    });

    this.ws.on('error', error => console.error('WS error:', error.message));

    this.ws.on('close', () => {
      console.log('⚡ WebSocket closed');
      this._stopPing();
      this._onDisconnect();
    });
  }

  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      if (this.connected) this._send({ ping: 1 });
    }, 25000);
  }

  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  _send(request) {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(request));
      return true;
    } catch (error) {
      console.error('Send error:', error.message);
      return false;
    }
  }

  _onDisconnect() {
    if (this.endOfDay) {
      this._cleanupWs();
      return;
    }

    this.connected = false;
    this.wsReady = false;
    StatePersistence.save(this);

    if (this.reconnectAttempts >= this.cfg.maxReconnectAttempts) {
      console.error('❌ Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.cfg.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
    console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s…`);
    setTimeout(() => this.connect(), delay);
  }

  _cleanupWs() {
    this._stopPing();
    Object.keys(this.watchdogs).forEach(asset => this._clearWatchdog(asset));

    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) this.ws.close();
      } catch (_) {}
      this.ws = null;
    }

    this.connected = false;
    this.wsReady = false;
  }

  _handleMessage(msg) {
    if (msg.error) {
      console.error('API error:', msg.error.message);
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':
        this._onAuth(msg);
        break;
      case 'history':
        this._onHistory(msg);
        break;
      case 'tick':
        this._onTick(msg.tick);
        break;
      case 'proposal':
        this._onProposal(msg);
        break;
      case 'buy':
        this._onBuy(msg);
        break;
      case 'proposal_open_contract':
        this._onContractUpdate(msg);
        break;
      case 'ping':
        break;
      default:
        break;
    }
  }

  _onAuth(msg) {
    if (msg.error) {
      console.error('Auth failed:', msg.error.message);
      this._cleanupWs();
      return;
    }

    console.log(`✅ Auth OK — Balance: $${msg.authorize.balance}`);
    this.wsReady = true;
    if (this.session.startCapital === 0) this.session.startCapital = toNum(msg.authorize.balance, 0);

    for (const asset of this.cfg.assets) {
      this._send({
        ticks_history: asset,
        adjust_start_time: 1,
        count: Math.max(this.cfg.analysis.minHistorySize + 500, 3500),
        end: 'latest',
        start: 1,
        style: 'ticks',
      });
      this._send({ ticks: asset, subscribe: 1 });
    }
  }

  _lastDigit(quote, pipSize) {
    const precision = Number.isInteger(pipSize) ? pipSize : 2;
    const formatted = Number(quote).toFixed(precision);
    const fraction = formatted.split('.')[1] || '';
    return Number(fraction[fraction.length - 1] || 0);
  }

  _inferPipSizeFromPrices(prices) {
    return prices.reduce((max, price) => {
      const parts = String(price).split('.');
      const len = parts[1] ? parts[1].length : 0;
      return Math.max(max, len);
    }, 2);
  }

  _onHistory(msg) {
    const asset = msg.echo_req?.ticks_history;
    if (!asset || !msg.history?.prices) return;

    const prices = msg.history.prices.map(Number);
    this.priceHistories[asset] = prices;
    if (!this.pipSizes[asset]) this.pipSizes[asset] = this._inferPipSizeFromPrices(prices);
    this.digitHistories[asset] = prices.map(p => this._lastDigit(p, this.pipSizes[asset]));
    this.historyLoaded[asset] = true;

    console.log(`📊 ${asset}: loaded ${prices.length} ticks (pip_size=${this.pipSizes[asset]})`);
  }

  async _onTick(tick) {
    const asset = tick?.symbol;
    if (!asset || !(asset in this.priceHistories)) return;

    if (Number.isInteger(tick.pip_size)) this.pipSizes[asset] = tick.pip_size;

    const price = Number(tick.quote);
    const digit = this._lastDigit(price, this.pipSizes[asset]);

    this.priceHistories[asset].push(price);
    this.digitHistories[asset].push(digit);

    const keep = this.cfg.analysis.minHistorySize + 1000;
    if (this.priceHistories[asset].length > keep) this.priceHistories[asset].shift();
    if (this.digitHistories[asset].length > keep) this.digitHistories[asset].shift();

    if (this.activeTrades[asset]?.status === 'paper_active') {
      this._resolvePaperTrade(asset, digit);
      return;
    }

    if (!this.wsReady || !this.historyLoaded[asset]) return;
    if (this.digitHistories[asset].length < this.cfg.analysis.minHistorySize) return;

    this._evaluateAsset(asset);
  }

  _evaluateAsset(asset) {
    const canTrade = this._canTrade(asset);
    if (!canTrade.can) return;

    const analysis = this.analyzer.analyze(this.digitHistories[asset]);
    console.log(`asset: ${asset} 
      Analysis:
      shouldRequestProposal: ${analysis.shouldRequestProposal}
      Reason: ${analysis.reason}
      Current Digit: ${analysis.currentDigit}
      Predicted Digit: ${analysis.predictedDigit}
      Signal Score: ${(analysis.signalScore * 100).toFixed(2)}%
      Est. Lose Prob: ${(analysis.estimatedLoseProb * 100).toFixed(2)}%
      Cons. Lose Prob: ${analysis.conservativeLoseProb.toFixed(2)} <= ${BOT_CONFIG.analysis.preProposalMaxLoseProb}
      Est. Win Prob: ${(analysis.estimatedWinProb * 100).toFixed(2)}%
      Cons. Win Prob: ${(analysis.conservativeWinProb * 100).toFixed(2)}%
      Gap vs Runner-Up: ${analysis.gapVsRunnerUp.toFixed(4)} >= ${BOT_CONFIG.analysis.minDigitGapVsRunnerUp}
      Streak: Digit ${analysis.streak.digit} for ${analysis.streak.streak} ticks
      `);
    
    if (!analysis.shouldRequestProposal) return;

    this.pendingProposals[asset] = { analysis, requestedAt: nowMs() };

    this._send({
      proposal: 1,
      amount: this.currentStake.toFixed(2),
      basis: 'stake',
      contract_type: this.cfg.contract.type,
      currency: this.cfg.contract.currency,
      symbol: asset,
      duration: this.cfg.contract.duration,
      duration_unit: this.cfg.contract.durationUnit,
      barrier: String(analysis.predictedDigit),
      passthrough: {
        asset,
        requestedAt: this.pendingProposals[asset].requestedAt,
        predictedDigit: analysis.predictedDigit,
      },
    });
  }

  _logSignal(asset, analysis, proposalInfo, decision) {
    appendCsv(this.cfg.files.signals, [
      new Date().toISOString(),
      asset,
      this.cfg.tradeMode,
      analysis.currentDigit,
      analysis.predictedDigit,
      round(analysis.estimatedLoseProb, 6),
      round(analysis.conservativeLoseProb, 6),
      round(analysis.estimatedWinProb, 6),
      round(analysis.conservativeWinProb, 6),
      round(analysis.gapVsRunnerUp, 6),
      analysis.reason,
      analysis.analysis.stats.short.count,
      analysis.analysis.stats.short.n,
      analysis.analysis.stats.medium.count,
      analysis.analysis.stats.medium.n,
      analysis.analysis.stats.long.count,
      analysis.analysis.stats.long.n,
      analysis.analysis.stats.transition.count,
      analysis.analysis.stats.transition.total,
      proposalInfo?.askPrice ?? '',
      proposalInfo?.payout ?? '',
      proposalInfo?.breakEvenWinRate ?? '',
      proposalInfo?.requiredMaxLoseProb ?? '',
      decision,
    ]);
  }

  _onProposal(msg) {
    const asset = msg.echo_req?.symbol;
    if (!asset || !this.pendingProposals[asset]) return;

    const stored = this.pendingProposals[asset];
    this.pendingProposals[asset] = null;

    if (this.activeTrades[asset]) return;

    if (nowMs() - stored.requestedAt > this.cfg.maxProposalAgeMs) {
      this._logSignal(asset, stored.analysis, null, 'skip_stale_proposal');
      console.log(`⚠️ Stale proposal for ${asset} — skipping`);
      return;
    }

    const proposal = msg.proposal;
    const askPrice = toNum(proposal?.ask_price, this.currentStake);
    const payout = toNum(proposal?.payout, 0);
    if (askPrice <= 0 || payout <= 0) {
      this._logSignal(asset, stored.analysis, null, 'skip_invalid_proposal');
      return;
    }

    const breakeven = breakEvenWinRate(askPrice, payout);
    const requiredMaxLoseProb = 1 - breakeven - this.cfg.analysis.requiredEdgeMargin;
    const conservativeEV = (stored.analysis.conservativeWinProb * (payout - askPrice))
      - ((1 - stored.analysis.conservativeWinProb) * askPrice);

    const proposalInfo = {
      askPrice: round(askPrice, 4),
      payout: round(payout, 4),
      breakEvenWinRate: round(breakeven, 6),
      requiredMaxLoseProb: round(requiredMaxLoseProb, 6),
      conservativeEV: round(conservativeEV, 6),
    };

    const conservativeProb = (stored.analysis.conservativeLoseProb).toFixed(3)
    
    const signalScore = (stored.analysis.signalScore * 100).toFixed(2); 
    const approved = signalScore >= 35
    //stored.analysis.conservativeLoseProb < requiredMaxLoseProb 
      // &&
      // conservativeEV > 0;
    
    if (!approved) {
      this._logSignal(asset, stored.analysis, proposalInfo, 'skip_no_ev');
        console.log(`
          Decision: ${approved ? 'APPROVED' : 'REJECTED'}
          breakEvenWinRate: ${(breakeven * 100).toFixed(2)}%
          Proposal for: ${asset}: ask $${askPrice.toFixed(2)} 
          Payout: $${payout.toFixed(2)}, break-even WR ${(breakeven * 100).toFixed(2)}% 
          Required max lose prob: ${(stored.analysis.conservativeLoseProb).toFixed(3)}% < ${requiredMaxLoseProb.toFixed(3)}%
          Conservative EV: $${conservativeEV.toFixed(4)}
        `);
      return;
    }

    this._logSignal(asset, stored.analysis, proposalInfo, this.cfg.tradeMode === 'live' ? 'buy_live' : 'buy_paper');

    console.log(`\n${'═'.repeat(72)}`);
    console.log(`💼 ${this.cfg.tradeMode.toUpperCase()} TRADE APPROVED — ${asset}`);
    console.log(`${'═'.repeat(72)}`);
    console.log(`Predicted Digit   : ${stored.analysis.predictedDigit}`);
    console.log(`Current Digit     : ${stored.analysis.currentDigit}`);
    console.log(`Signal Score      : ${(stored.analysis.signalScore * 100).toFixed(2)}%`);
    console.log(`Est. Lose Prob    : ${(stored.analysis.estimatedLoseProb * 100).toFixed(2)}%`);
    console.log(`Cons. Lose Prob   : ${(stored.analysis.conservativeLoseProb * 100).toFixed(2)}%`);
    console.log(`Break-even WR     : ${(breakeven * 100).toFixed(2)}%`);
    console.log(`Stake             : $${askPrice.toFixed(2)}`);
    console.log(`Payout            : $${payout.toFixed(2)}`);
    console.log(`Conservative EV   : $${conservativeEV.toFixed(4)}`);
    console.log(`${'═'.repeat(72)}\n`);

    this._placeTrade(asset, stored.analysis, proposal, proposalInfo);
  }

  _placeTrade(asset, analysis, proposal, proposalInfo) {
    if (this.activeTrades[asset]) return;
    const trade = {
      status: this.cfg.tradeMode === 'live' ? 'buying' : 'paper_active',
      mode: this.cfg.tradeMode,
      proposalId: proposal.id,
      stake: toNum(proposal.ask_price, this.currentStake),
      payout: toNum(proposal.payout, 0),
      analysis,
      proposalInfo,
      entryTime: nowMs(),
      entryDigit: analysis.currentDigit,
      predictedDigit: analysis.predictedDigit,
    };

    this.activeTrades[asset] = trade;
    this.hourlyTrades.push(nowMs());
    this.lastTradeTime[asset] = nowMs();

    if (this.cfg.tradeMode === 'live') {
      this._send({ buy: proposal.id, price: trade.stake.toFixed(2) });
      this._startWatchdog(asset);
    }

    this._sendTelegram(
      `💼 <b>${this.cfg.tradeMode.toUpperCase()} DigitDiff Signal</b>\n\n` +
      `Asset: <b>${asset}</b>\n` +
      `Predicted Digit: <b>${analysis.predictedDigit}</b>\n` +
      `Current Digit: ${analysis.currentDigit}\n` +
      `Streak: ${analysis.streak.digit} × ${analysis.streak.streak}\n` +
      `Signal Score: ${(analysis.signalScore * 100).toFixed(2)}%\n\n` +
      `<b>Probability Model</b>\n` +
      `Estimated lose probability: ${(analysis.estimatedLoseProb * 100).toFixed(2)}%\n` +
      `Conservative lose probability: ${(analysis.conservativeLoseProb * 100).toFixed(2)}%\n` +
      `Estimated win probability: ${(analysis.estimatedWinProb * 100).toFixed(2)}%\n` +
      `Conservative win probability: ${(analysis.conservativeWinProb * 100).toFixed(2)}%\n` +
      `Gap vs runner-up: ${(analysis.gapVsRunnerUp * 100).toFixed(3)}%\n\n` +
      `<b>Proposal Check</b>\n` +
      `Stake: $${trade.stake.toFixed(2)}\n` +
      `Payout: $${trade.payout.toFixed(2)}\n` +
      `Break-even WR: ${(proposalInfo.breakEvenWinRate * 100).toFixed(2)}%\n` +
      `Required max lose prob: ${(proposalInfo.requiredMaxLoseProb * 100).toFixed(2)}%\n` +
      `Conservative EV: $${proposalInfo.conservativeEV.toFixed(4)}\n\n` +
      `Mode: <b>${this.cfg.tradeMode.toUpperCase()}</b>`
    );
  }

  _onBuy(msg) {
    const proposalId = msg.echo_req?.buy;
    const asset = proposalId
      ? Object.keys(this.activeTrades).find(a => this.activeTrades[a]?.proposalId === proposalId)
      : Object.keys(this.activeTrades).find(a => this.activeTrades[a]?.status === 'buying');

    if (!asset) return;

    if (msg.error) {
      console.error('❌ Buy error:', msg.error.message);
      delete this.activeTrades[asset];
      this._clearWatchdog(asset);
      return;
    }

    const contractId = msg.buy?.contract_id;
    if (!contractId) return;

    console.log(`✅ Contract ${contractId} (${asset})`);
    this.activeTrades[asset].status = 'active';
    this.activeTrades[asset].contractId = contractId;
    this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
  }

  _onContractUpdate(msg) {
    const contract = msg.proposal_open_contract;
    if (!contract) return;

    const asset = contract.underlying ||
      Object.keys(this.activeTrades).find(a => this.activeTrades[a]?.contractId === contract.contract_id);

    if (!asset || !this.activeTrades[asset]) return;

    if (msg.subscription?.id) this.contractSubs[asset] = msg.subscription.id;
    if (contract.is_sold) this._onTradeResult(asset, contract);
  }

  _resolvePaperTrade(asset, exitDigit) {
    const trade = this.activeTrades[asset];
    if (!trade) return;

    const won = exitDigit !== trade.predictedDigit;
    const profit = won ? (trade.payout - trade.stake) : -trade.stake;

    const paperContract = {
      status: won ? 'won' : 'lost',
      profit,
      is_paper: true,
      exit_digit: exitDigit,
    };

    this._onTradeResult(asset, paperContract);
  }

  _onTradeResult(asset, contract) {
    const trade = this.activeTrades[asset];
    if (!trade) return;

    this._clearWatchdog(asset);
    if (this.contractSubs[asset]) {
      this._send({ forget: this.contractSubs[asset] });
      delete this.contractSubs[asset];
    }

    const won = contract.status === 'won';
    const profit = toNum(contract.profit, 0);
    let exitDigit = contract.exit_digit;

    if (exitDigit === undefined || exitDigit === null) {
      const exitSpot = toNum(contract.exit_tick || contract.exit_spot || contract.sell_spot, NaN);
      if (Number.isFinite(exitSpot)) exitDigit = this._lastDigit(exitSpot, this.pipSizes[asset]);
      else exitDigit = '';
    }

    console.log(`\n${'═'.repeat(72)}`);
    console.log(`${won ? '✅ WIN' : '❌ LOSS'}: ${asset} (${trade.mode.toUpperCase()})`);
    console.log(`Predicted Digit: ${trade.predictedDigit}`);
    console.log(`Exit Digit     : ${exitDigit}`);
    console.log(`P&L            : ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
    console.log(`${'═'.repeat(72)}`);

    this.totalTrades++;
    this.dayTrades++;
    this.totalProfitLoss += profit;
    this.dailyProfitLoss += profit;
    this.assetMetrics[asset].trades++;
    this.assetMetrics[asset].profitLoss += profit;

    this._checkDayChange();

    const currentHour = new Date().getHours();
    if (currentHour !== this.hourlyStats.lastHour) {
      this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: currentHour };
    }

    this.hourlyStats.trades++;
    this.hourlyStats.pnl += profit;
    this.session.tradesCount++;
    this.session.netPL += profit;

    if (won) {
      this.hourlyStats.wins++;
      this.totalWins++;
      this.consecutiveLosses = 0;
      this.currentStake = this.cfg.initialStake;
      this.assetMetrics[asset].wins++;
      this.session.winsCount++;
    } else {
      this.hourlyStats.losses++;
      this.totalLosses++;
      this.consecutiveLosses++;
      this.lastLossTime[asset] = nowMs();
      this.currentStake = this.cfg.initialStake; // flat stake, no martingale
      this.assetMetrics[asset].losses++;
      this.session.lossesCount++;
    }

    appendCsv(this.cfg.files.trades, [
      new Date().toISOString(),
      asset,
      trade.mode,
      trade.predictedDigit,
      trade.entryDigit,
      exitDigit,
      won ? 1 : 0,
      round(trade.stake, 4),
      round(trade.payout, 4),
      round(profit, 4),
      round(trade.analysis.estimatedLoseProb, 6),
      round(trade.analysis.conservativeLoseProb, 6),
      round(trade.proposalInfo.breakEvenWinRate, 6),
      round(this.dailyProfitLoss, 4),
      round(this.totalProfitLoss, 4),
    ]);

    delete this.activeTrades[asset];

    const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';

    this._sendTelegram(
      `${won ? '✅' : '❌'} <b>${trade.mode.toUpperCase()} Result</b>\n\n` +
      `Asset: ${asset}\n` +
      `Predicted Digit: ${trade.predictedDigit}\n` +
      `Entry Digit: ${trade.entryDigit}\n` +
      `Exit Digit: ${exitDigit}\n` +
      `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
      `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
      `Win Rate: ${wr}%\n` +
      `Consecutive Losses: ${this.consecutiveLosses}\n` +
      `Next Stake: $${this.currentStake.toFixed(2)}\n` +
      `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}\n\n` +
      `<b>Signal Context</b>\n` +
      `Signal Score: ${(trade.analysis.signalScore * 100).toFixed(2)}%\n` +
      `Estimated lose probability: ${(trade.analysis.estimatedLoseProb * 100).toFixed(2)}%\n` +
      `Conservative lose probability: ${(trade.analysis.conservativeLoseProb * 100).toFixed(2)}%\n` +
      `Break-even WR: ${(trade.proposalInfo.breakEvenWinRate * 100).toFixed(2)}%`
    );

    this._logSummary(asset);
    StatePersistence.save(this);

    if (this.totalProfitLoss >= this.cfg.takeProfit) {
      this.endOfDay = true;
      this._sendTelegram(`🎯 <b>Take Profit Hit</b>\nTotal P&L: +$${this.totalProfitLoss.toFixed(2)}`);
      this._sendSessionSummary();
      this._cleanupWs();
    } else if (
      this.consecutiveLosses >= this.cfg.maxConsecutiveLosses ||
      this.totalProfitLoss <= -Math.abs(this.cfg.stopLoss)
    ) {
      this.currentStake = this.cfg.initialStake;
      this.endOfDay = true;
      this._sendTelegram(
        `🛑 <b>Risk Stop Triggered</b>\n` +
        `Consecutive losses: ${this.consecutiveLosses}\n` +
        `Total P&L: $${this.totalProfitLoss.toFixed(2)}`
      );
      this._sendSessionSummary();
      this._cleanupWs();
    }
  }

  // ── Summaries & Timers ────────────────────────────────────────────────────
  async _sendHourlySummary() {
    try {
      const stats = { ...this.hourlyStats };
      if (stats.trades === 0) return;

      const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0.0';
      const pnlEmoji = stats.pnl >= 0 ? '🟢' : '🔴';
      const pnlStr = (stats.pnl >= 0 ? '+' : '') + '$' + stats.pnl.toFixed(2);

      const message = [
        `⏰ <b>DigitDiff Research Bot - Hourly Summary</b>`, '',
        `📊 <b>Last Hour</b>`,
        `├ Trades: ${stats.trades}`,
        `├ Wins: ${stats.wins} | Losses: ${stats.losses}`,
        `├ Win Rate: ${winRate}%`,
        `└ ${pnlEmoji} <b>P&L:</b> ${pnlStr}`,
        '',
        `🗓️ <b>Today</b>`,
        `├ Total Trades: ${this.dayTrades}`,
        `└ Today P&L: ${this.dailyProfitLoss >= 0 ? '+' : ''}$${this.dailyProfitLoss.toFixed(2)}`,
      ].join('\n');

      await this._sendTelegram(message);
      this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
    } catch (error) {
      console.error('❌ _sendHourlySummary:', error.message);
    }
  }

  async _sendSessionSummary() {
    try {
      const durationMs = nowMs() - this.session.startTime;
      const hours = Math.floor(durationMs / 3600000);
      const minutes = Math.floor((durationMs % 3600000) / 60000);
      const winRate = this.session.tradesCount > 0
        ? ((this.session.winsCount / this.session.tradesCount) * 100).toFixed(1) + '%'
        : '0%';

      const message = [
        `📊 <b>SESSION SUMMARY — DigitDiff Research Bot</b>`, '',
        `🧪 Mode: ${this.cfg.tradeMode.toUpperCase()}`,
        `⏱️ Duration: ${hours}h ${minutes}m`,
        `🔢 Trades: ${this.session.tradesCount}`,
        `✅ Wins: ${this.session.winsCount} | ❌ Losses: ${this.session.lossesCount}`,
        `📈 Win Rate: ${winRate}`,
        `💰 Session P/L: ${this.session.netPL >= 0 ? '+' : ''}$${this.session.netPL.toFixed(2)}`,
        `💵 Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`,
      ].join('\n');

      await this._sendTelegram(message);
    } catch (error) {
      console.error('❌ _sendSessionSummary:', error.message);
    }
  }

  async _sendDayEndSummary(day) {
    try {
      const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) + '%' : '0%';
      const message = [
        `🌙 <b>END OF DAY — ${day}</b>`, '',
        `${this.dailyProfitLoss >= 0 ? '🟢' : '🔴'} <b>Day Results</b>`,
        `├ Trades: ${this.dayTrades}`,
        `├ Wins: ${this.totalWins} | Losses: ${this.totalLosses}`,
        `├ Win Rate: ${wr}`,
        `└ Net P/L: $${this.dailyProfitLoss.toFixed(2)}`,
        '',
        `📊 <b>Overall</b>`,
        `└ Total P&L: $${this.totalProfitLoss.toFixed(2)}`,
      ].join('\n');

      await this._sendTelegram(message);
    } catch (error) {
      console.error('❌ _sendDayEndSummary:', error.message);
    }
  }

  _startHourlyTimer() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(next.getHours() + 1, 0, 0, 0);
    const wait = next.getTime() - now.getTime();
    console.log(`⏰ Hourly summary in ${Math.ceil(wait / 60000)} min`);

    setTimeout(() => {
      this._sendHourlySummary();
      setInterval(() => this._sendHourlySummary(), 60 * 60 * 1000);
    }, wait);
  }

  _startWatchdog(asset) {
    this._clearWatchdog(asset);
    this.watchdogs[asset] = setTimeout(() => {
      const contractId = this.activeTrades[asset]?.contractId;
      if (!contractId) return this._clearWatchdog(asset);
      console.warn(`⏰ WATCHDOG — re-subscribing for ${asset}`);
      if (this.connected) this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
    }, 30000);
  }

  _clearWatchdog(asset) {
    if (this.watchdogs[asset]) {
      clearTimeout(this.watchdogs[asset]);
      delete this.watchdogs[asset];
    }
  }

  async _sendTelegram(text) {
    console.log(text.replace(/<[^>]+>/g, ''));
    if (!this.telegram) return;
    try {
      await this.telegram.sendMessage(this.cfg.telegramChatId, text, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Telegram:', error.message);
    }
  }

  _checkDayChange() {
    const today = dateKey();
    if (this.currentTradeDay && this.currentTradeDay !== today) {
      console.log(`🗓️ Day change: ${this.currentTradeDay} → ${today}`);
      this._sendDayEndSummary(this.currentTradeDay);
      this.dailyProfitLoss = 0;
      this.dayTrades = 0;
      this.currentTradeDay = today;
      StatePersistence.save(this);
    }
  }

  _startTimeScheduler() {
    if (!this.cfg.scheduler.enableNightShutdown) return;

    setInterval(() => {
      const gmt1 = new Date(nowMs() + 3600000);
      const hour = gmt1.getUTCHours();

      if (this.endOfDay && hour === this.cfg.scheduler.restartHourGMT1) {
        console.log(`⏰ ${this.cfg.scheduler.restartHourGMT1}:00 AM GMT+1 — reconnecting`);
        this.endOfDay = false;
        this.activeTrades = {};
        this.connect();
      }

      if (!this.endOfDay && hour === this.cfg.scheduler.shutdownHourGMT1) {
        if (!this._anyActiveTrade()) {
          console.log(`🌙 ${this.cfg.scheduler.shutdownHourGMT1}:00 PM/Hour GMT+1 — nightly shutdown`);
          this.endOfDay = true;
          this._sendTelegram(
            `🌙 <b>Nightly Shutdown</b>\n` +
            `Bot will restart at ${this.cfg.scheduler.restartHourGMT1}:00 GMT+1.`
          );
          this._sendSessionSummary();
          this._cleanupWs();
        }
      }
    }, 20000);
  }

  _logSummary(asset) {
    const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';
    console.log('\n📊 SUMMARY');
    console.log(`Trades: ${this.totalTrades} | W: ${this.totalWins} | L: ${this.totalLosses} | WR: ${wr}%`);
    console.log(`Last 20 digits (${asset}): [ ${this.digitHistories[asset].slice(-20).join(' ')} ]`);
    console.log(`Today P&L: $${this.dailyProfitLoss.toFixed(2)}`);
    console.log(`Total P&L: $${this.totalProfitLoss.toFixed(2)}`);
    console.log(`Stake Mode: ${this.cfg.flatStake ? 'FLAT' : 'CUSTOM'} | Next stake: $${this.currentStake.toFixed(2)}`);
  }

  start() {
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log('  🧠 DERIV DIGITDIFF RESEARCH BOT — MERGED STRUCTURE');
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log(`  ✓ Mode: ${this.cfg.tradeMode.toUpperCase()}`);
    console.log('  ✓ Telegram/Session reporting style preserved');
    console.log('  ✓ Proposal-aware EV filtering');
    console.log('  ✓ Bayesian multi-window + transition analysis');
    console.log('  ✓ Flat stake risk model (no martingale)');
    console.log(`  ✓ Assets: ${this.cfg.assets.join(', ')}`);
    console.log(`  ✓ Windows: Short(${this.cfg.analysis.shortWindow}) | Medium(${this.cfg.analysis.mediumWindow}) | Long(${this.cfg.analysis.longWindow})`);
    console.log(`  ✓ Transition Lookback: ${this.cfg.analysis.transitionLookback}`);
    console.log(`  ✓ Stake: $${this.cfg.initialStake.toFixed(2)} | StopLoss: $${this.cfg.stopLoss} | TakeProfit: $${this.cfg.takeProfit}`);
    console.log('══════════════════════════════════════════════════════════════════════\n');

    if (!this.cfg.token) {
      console.error('❌ DERIV_TOKEN not set — aborting');
      process.exit(1);
    }

    this.connect();
    this._startTimeScheduler();
    this._startHourlyTimer();
    StatePersistence.startAutoSave(this);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
const bot = new DerivDigitDiffMergedBot(BOT_CONFIG);
bot.start();
