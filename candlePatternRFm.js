#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════════════════════╗
// ║   MULTI-ASSET STEP INDEX GRID MARTINGALE BOT — Pattern Recognition Edition     ║
// ║   Volatility STEP Index | CALLE/PUTE | Candle Pattern Analysis                 ║
// ║   5000 candle history | Recency-weighted | Confidence-gated trading            ║
// ║   Each asset has independent Stake, martingale, recovery, and settings         ║
// ╚══════════════════════════════════════════════════════════════════════════════════╝

'use strict';

require('dotenv').config();

const WebSocket   = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs          = require('fs');
const path        = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // API Settings
  API_TOKEN: 'Dz2V2KvRf4Uukt3',
  APP_ID:    '1089',
  WS_URL:    'wss://ws.derivws.com/websockets/v3',

  // Capital Settings
  INITIAL_CAPITAL: 500,
  SESSION_PROFIT_TARGET: 50000,
  SESSION_STOP_LOSS: -250,

  // Telegram
  TELEGRAM_ENABLED: true,
  TELEGRAM_BOT_TOKEN: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
  TELEGRAM_CHAT_ID: '752497117',

  // Recovery Strategy Settings
  // When enabled: After a loss, trade immediately on next candle in SAME direction (no analysis)
  // When disabled: After a loss, wait for pattern analysis signal
  USE_RECOVERY_STRATEGY: true,

  // State
  STATE_SAVE_INTERVAL: 5000
};

// Active Assets List
const ACTIVE_ASSETS = [
  'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
  '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V',
  'stpRNG', 'stpRNG2', 'stpRNG3', 'stpRNG4', 'stpRNG5'
];

// ══════════════════════════════════════════════════════════════════════════════
// PER-ASSET CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_ASSET_CONFIG = {
  // Candle Settings
  GRANULARITY: 60,
  TIMEFRAME_LABEL: '1m',
  MAX_CANDLES_STORED: 5000,
  CANDLES_TO_LOAD: 5000,

  // Trade Duration
  DURATION: 54,
  DURATION_UNIT: 's',

  // Stake Settings
  INITIAL_STAKE: 0.35,
  INVESTMENT_AMOUNT: 153,

  // Martingale Settings
  MARTINGALE_MULTIPLIER: 1.48,
  MAX_MARTINGALE_LEVEL: 1,
  AFTER_MAX_LOSS: 'continue',
  CONTINUE_EXTRA_LEVELS: 8,
  EXTRA_LEVEL_MULTIPLIERS: [1.8, 2.1, 2.1, 2.1, 2.1, 2.2, 2.2],

  // Auto-Compounding
  AUTO_COMPOUNDING: true,
  COMPOUND_PERCENTAGE: 0.24,

  // Risk Management
  STOP_LOSS: 153,
  TAKE_PROFIT: 10000,

  // Pattern Analysis Settings
  PATTERN_MIN_CONFIDENCE: 0.60,
  MIN_AGREEMENT_RATIO_CONFIDENCE: 0.80,
  MIN_PATTERN_CONFIDENCE: 0.98,
  MIN_PATTERN_CONFIDENCE_STEP_RNG: 0.97,
  PATTERN_LENGTHS: [7, 8, 9, 10, 11, 12],
  PATTERN_MIN_OCCURRENCES: 5,
  PATTERN_RECENCY_DECAY: 0.9990,
  PATTERN_DOJI_THRESHOLD: 0.00001
};

// Per-asset overrides (individual settings per asset)
const ASSET_CONFIGS = {
  // 'R_10': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // 'R_25': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 150,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // 'R_50': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // 'R_75': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // 'R_100': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // '1HZ10V': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // '1HZ25V': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // '1HZ50V': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // '1HZ75V': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // '1HZ100V': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // 'stpRNG': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // 'stpRNG2': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // 'stpRNG3': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // 'stpRNG4': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // },
  // 'stpRNG5': {
  //   INITIAL_STAKE: 0.35,
  //   INVESTMENT_AMOUNT: 153,
  //   MARTINGALE_MULTIPLIER: 1.48,
  //   MAX_MARTINGALE_LEVEL: 1
  // }
};

function getAssetConfig(symbol) {
  const overrides = ASSET_CONFIGS[symbol] || {};
  return {
    ...DEFAULT_ASSET_CONFIG,
    ...overrides
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// CANDLE PATTERN ANALYZER CLASS (same as original)
// ══════════════════════════════════════════════════════════════════════════════

class CandlePatternAnalyzer {
  constructor(options = {}) {
    this.minConfidence = options.minConfidence || 0.60;
    this.patternLengths = options.patternLengths || [3, 4, 5, 6, 7, 8];
    this.minOccurrences = options.minOccurrences || 5;
    this.recencyDecay = options.recencyDecay || 0.9990;
    this.dojiThreshold = options.dojiThreshold || 0.00001;
    this.lastAnalysis = null;
    this.lastAnalysisTime = 0;
  }

  classifyCandle(candle) {
    const bodySize = Math.abs(candle.close - candle.open);
    const threshold = candle.open * this.dojiThreshold;
    if (bodySize <= threshold) return 'D';
    if (candle.close > candle.open) return 'B';
    return 'R';
  }

  classifyAll(candles) {
    return candles.map(c => this.classifyCandle(c));
  }

  analyze(closedCandles) {
    const maxPatLen = Math.max(...this.patternLengths);
    if (closedCandles.length < maxPatLen + 20) {
      return {
        shouldTrade: false,
        direction: null,
        confidence: 0,
        reason: `Insufficient candle history: ${closedCandles.length} candles`,
        details: {}
      };
    }

    const types = this.classifyAll(closedCandles);
    const totalCandles = types.length;
    const patternResults = [];

    for (const patLen of this.patternLengths) {
      if (totalCandles < patLen + 1) continue;

      const currentPattern = types.slice(totalCandles - patLen);
      let bullishWeightedSum = 0;
      let bearishWeightedSum = 0;
      let dojiWeightedSum = 0;
      let totalWeight = 0;
      let rawOccurrences = 0;

      const searchEnd = totalCandles - patLen - 1;

      for (let i = 0; i <= searchEnd; i++) {
        let matches = true;
        for (let j = 0; j < patLen; j++) {
          if (types[i + j] !== currentPattern[j]) {
            matches = false;
            break;
          }
        }

        if (matches) {
          const nextType = types[i + patLen];
          const distanceFromPresent = searchEnd - i;
          const weight = Math.pow(this.recencyDecay, distanceFromPresent);

          rawOccurrences++;
          totalWeight += weight;

          if (nextType === 'B') bullishWeightedSum += weight;
          else if (nextType === 'R') bearishWeightedSum += weight;
          else dojiWeightedSum += weight;
        }
      }

      if (rawOccurrences < this.minOccurrences) continue;

      const decisiveWeight = bullishWeightedSum + bearishWeightedSum;
      if (decisiveWeight === 0) continue;

      const bullProb = bullishWeightedSum / decisiveWeight;
      const bearProb = bearishWeightedSum / decisiveWeight;
      const confidence = Math.max(bullProb, bearProb);
      const direction = bullProb > bearProb ? 'CALLE' : 'PUTE';

      patternResults.push({
        patternLength: patLen,
        pattern: currentPattern.join(''),
        direction,
        confidence,
        bullProb,
        bearProb,
        rawOccurrences,
        totalWeight: totalWeight.toFixed(2),
        decisiveWeight: decisiveWeight.toFixed(2)
      });
    }

    if (patternResults.length === 0) {
      return {
        shouldTrade: false,
        direction: null,
        confidence: 0,
        reason: 'No patterns met minimum occurrence threshold',
        details: { patternResults: [] }
      };
    }

    let consensusBullScore = 0;
    let consensusBearScore = 0;
    let totalVoteWeight = 0;

    for (const r of patternResults) {
      const voteWeight = Math.sqrt(r.rawOccurrences) * Math.sqrt(r.patternLength);
      consensusBullScore += voteWeight * r.bullProb;
      consensusBearScore += voteWeight * r.bearProb;
      totalVoteWeight += voteWeight;
    }

    const finalBullProb = consensusBullScore / totalVoteWeight;
    const finalBearProb = consensusBearScore / totalVoteWeight;
    const consensusConfidence = Math.max(finalBullProb, finalBearProb);
    const consensusDirection = finalBullProb > finalBearProb ? 'CALLE' : 'PUTE';

    patternResults.sort((a, b) => b.confidence - a.confidence);
    const bestPattern = patternResults[0];

    const agreeingPatterns = patternResults.filter(r => r.direction === consensusDirection);
    const agreementRatio = agreeingPatterns.length / patternResults.length;

    const finalDirection = consensusDirection;
    const finalConfidence = consensusConfidence;
    const decisionMethod = 'CONSENSUS+BEST_AGREE';

    const shouldTrade = finalConfidence >= this.minConfidence;

    let reason;
    if (shouldTrade) {
      const dirLabel = finalDirection === 'CALLE' ? 'BULLISH' : 'BEARISH';
      reason = `Pattern analysis predicts ${dirLabel} with ${(finalConfidence * 100).toFixed(1)}% confidence`;
    } else {
      reason = `Confidence ${(finalConfidence * 100).toFixed(1)}% below threshold ${(this.minConfidence * 100).toFixed(1)}%`;
    }

    this.lastAnalysis = {
      shouldTrade,
      direction: shouldTrade ? finalDirection : null,
      confidence: finalConfidence,
      reason,
      details: {
        patternResults,
        consensus: {
          direction: consensusDirection,
          confidence: consensusConfidence,
          bullProb: finalBullProb,
          bearProb: finalBearProb,
          agreementRatio
        },
        bestPattern,
        decisionMethod,
        totalCandlesAnalyzed: totalCandles,
        timestamp: Date.now()
      }
    };
    this.lastAnalysisTime = Date.now();

    return this.lastAnalysis;
  }

  getAnalysisSummary(result) {
    if (!result || !result.details || !result.details.patternResults) {
      return 'No analysis available';
    }

    const lines = [];
    lines.push(`📊 Pattern Analysis (${result.details.totalCandlesAnalyzed} candles):`);
    lines.push(`   Decision: ${result.details.decisionMethod}`);

    for (const r of result.details.patternResults) {
      const dirIcon = r.direction === 'CALLE' ? '🟢' : '🔴';
      lines.push(
        `   L${r.patternLength} "${r.pattern}" → ${dirIcon} ${(r.confidence * 100).toFixed(1)}% (${r.rawOccurrences} matches)`
      );
    }

    if (result.shouldTrade) {
      lines.push(`   ✅ SIGNAL: ${result.direction} @ ${(result.confidence * 100).toFixed(1)}%`);
    } else {
      lines.push(`   ⏳ NO TRADE: ${(result.confidence * 100).toFixed(1)}% < ${(this.minConfidence * 100).toFixed(1)}%`);
    }

    return lines.join('\n');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// LOGGER UTILITY
// ══════════════════════════════════════════════════════════════════════════════

const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';

const LOGGER = {
  info: msg => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
  trade: msg => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
  warn: msg => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
  error: msg => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
  debug: msg => console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`)
};

// ══════════════════════════════════════════════════════════════════════════════
// TRADE HISTORY MANAGER
// ══════════════════════════════════════════════════════════════════════════════

const HISTORY_FILE = path.join(__dirname, 'candlePatternRFn-multi-history0001.json');
let tradeHistory = null;

class TradeHistoryManager {
  static getDateKey() {
    return new Date().toISOString().split('T')[0];
  }

  static loadHistory() {
    try {
      if (!fs.existsSync(HISTORY_FILE)) {
        LOGGER.info('📂 No trade history file found, starting fresh');
        return {
          overall: { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0 },
          overallAssets: {},
          dailyHistory: {},
          lastUpdated: Date.now()
        };
      }
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      return data;
    } catch (error) {
      LOGGER.error(`Failed to load history: ${error.message}`);
      return { overall: { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0 }, overallAssets: {}, dailyHistory: {}, lastUpdated: Date.now() };
    }
  }

  static saveHistory() {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
    } catch (error) {
      LOGGER.error(`Failed to save history: ${error.message}`);
    }
  }

  static ensureDayEntry(dateKey) {
    if (!tradeHistory.dailyHistory[dateKey]) {
      tradeHistory.dailyHistory[dateKey] = {
        date: dateKey, tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0, assets: {}, startCapital: state.capital, endCapital: state.capital
      };
    }
  }

  static ensureAssetDayEntry(dateKey, symbol) {
    this.ensureDayEntry(dateKey);
    if (!tradeHistory.dailyHistory[dateKey].assets[symbol]) {
      tradeHistory.dailyHistory[dateKey].assets[symbol] = { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0 };
    }
  }

  static ensureOverallAssetEntry(symbol) {
    if (!tradeHistory.overallAssets[symbol]) {
      tradeHistory.overallAssets[symbol] = { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0 };
    }
  }

  static recordTrade(symbol, profit, martingaleLevel) {
    const dateKey = this.getDateKey();
    this.ensureAssetDayEntry(dateKey, symbol);
    this.ensureOverallAssetEntry(symbol);

    const dayStats = tradeHistory.dailyHistory[dateKey];
    const dayAssetStats = dayStats.assets[symbol];
    const overall = tradeHistory.overall;
    const overallAsset = tradeHistory.overallAssets[symbol];

    dayStats.tradesCount++;
    dayAssetStats.tradesCount++;
    overall.tradesCount++;
    overallAsset.tradesCount++;

    if (profit > 0) {
      dayStats.winsCount++;
      dayStats.profit += profit;
      dayStats.netPL += profit;
      dayAssetStats.winsCount++;
      dayAssetStats.profit += profit;
      dayAssetStats.netPL += profit;
      overall.winsCount++;
      overall.profit += profit;
      overall.netPL += profit;
      overallAsset.winsCount++;
      overallAsset.profit += profit;
      overallAsset.netPL += profit;
    } else {
      dayStats.lossesCount++;
      dayStats.loss += Math.abs(profit);
      dayStats.netPL += profit;
      dayAssetStats.lossesCount++;
      dayAssetStats.loss += Math.abs(profit);
      dayAssetStats.netPL += profit;
      overall.lossesCount++;
      overall.loss += Math.abs(profit);
      overall.netPL += profit;
      overallAsset.lossesCount++;
      overallAsset.loss += Math.abs(profit);
      overallAsset.netPL += profit;
    }

    dayStats.endCapital = state.capital;
    tradeHistory.lastUpdated = Date.now();
    this.saveHistory();
  }

  static getTodayStats() {
    const dateKey = this.getDateKey();
    this.ensureDayEntry(dateKey);
    return tradeHistory.dailyHistory[dateKey];
  }

  static getOverallStats() {
    return tradeHistory.overall;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

const STATE_FILE = path.join(__dirname, 'candlePatternRFn-multi-state0001.json');

const state = {
  assets: {},
  capital: CONFIG.INITIAL_CAPITAL,
  accountBalance: 0,
  currentTradeDay: null,
  session: {
    profit: 0, loss: 0, netPL: 0,
    tradesCount: 0, winsCount: 0, lossesCount: 0,
    isActive: true, startTime: Date.now(), startCapital: CONFIG.INITIAL_CAPITAL
  },
  isConnected: false,
  isAuthorized: false,
  hourlyStats: { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() },
  requestId: 1
};

class StatePersistence {
  static saveState() {
    try {
      const persistableState = {
        savedAt: Date.now(),
        capital: state.capital,
        session: { ...state.session },
        hourlyStats: { ...state.hourlyStats },
        currentTradeDay: state.currentTradeDay,
        assets: {}
      };

      Object.keys(state.assets).forEach(symbol => {
        const asset = state.assets[symbol];
        const assetConfig = getAssetConfig(symbol);
        persistableState.assets[symbol] = {
          closedCandles: asset.closedCandles.slice(-assetConfig.MAX_CANDLES_STORED),
          lastProcessedCandleOpenTime: asset.lastProcessedCandleOpenTime,
          candlesLoaded: asset.candlesLoaded,
          // Trade state
          lastTradeDirection: asset.lastTradeDirection,
          lastTradeWasWin: asset.lastTradeWasWin,
          martingaleLevel: asset.martingaleLevel,
          currentStake: asset.currentStake,
          baseStake: asset.baseStake,
          investmentRemaining: asset.investmentRemaining,
          canTrade: asset.canTrade,
          // Stats
          tradesCount: asset.tradesCount,
          winsCount: asset.winsCount,
          lossesCount: asset.lossesCount,
          profit: asset.profit,
          loss: asset.loss,
          netPL: asset.netPL,
          // Active positions
          activePositions: asset.activePositions.map(pos => ({
            symbol: pos.symbol, direction: pos.direction, stake: pos.stake,
            duration: pos.duration, durationUnit: pos.durationUnit,
            entryTime: pos.entryTime, contractId: pos.contractId,
            reqId: pos.reqId, buyPrice: pos.buyPrice, currentProfit: pos.currentProfit
          }))
        };
      });

      fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
    } catch (error) {
      LOGGER.error(`Failed to save state: ${error.message}`);
    }
  }

  static loadState() {
    try {
      if (!fs.existsSync(STATE_FILE)) {
        LOGGER.info('📂 No previous state file found');
        return false;
      }

      const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

      if (ageMinutes > 30) {
        LOGGER.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
        fs.unlinkSync(STATE_FILE);
        return false;
      }

      LOGGER.info(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);

      state.capital = savedData.capital;
      state.session = { ...state.session, ...savedData.session };
      state.hourlyStats = savedData.hourlyStats || state.hourlyStats;
      state.currentTradeDay = savedData.currentTradeDay || TradeHistoryManager.getDateKey();

      if (savedData.assets) {
        Object.keys(savedData.assets).forEach(symbol => {
          if (state.assets[symbol]) {
            const saved = savedData.assets[symbol];
            const asset = state.assets[symbol];

            if (saved.closedCandles && saved.closedCandles.length > 0) {
              asset.closedCandles = saved.closedCandles;
            }
            asset.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
            asset.candlesLoaded = saved.candlesLoaded || false;
            asset.lastTradeDirection = saved.lastTradeDirection || null;
            asset.lastTradeWasWin = saved.lastTradeWasWin !== undefined ? saved.lastTradeWasWin : null;
            asset.martingaleLevel = saved.martingaleLevel || 0;
            asset.currentStake = saved.currentStake || getAssetConfig(symbol).INITIAL_STAKE;
            asset.baseStake = saved.baseStake || getAssetConfig(symbol).INITIAL_STAKE;
            asset.investmentRemaining = saved.investmentRemaining || getAssetConfig(symbol).INVESTMENT_AMOUNT;
            asset.canTrade = saved.canTrade || false;
            asset.tradesCount = saved.tradesCount || 0;
            asset.winsCount = saved.winsCount || 0;
            asset.lossesCount = saved.lossesCount || 0;
            asset.profit = saved.profit || 0;
            asset.loss = saved.loss || 0;
            asset.netPL = saved.netPL || 0;
            asset.activePositions = (saved.activePositions || []).map(pos => ({ ...pos, entryTime: pos.entryTime || Date.now() }));

            LOGGER.info(`  🔄 ${symbol}: Martingale=${asset.martingaleLevel}, Stake=$${asset.currentStake.toFixed(2)}, P/L=$${asset.netPL.toFixed(2)}, Positions=${asset.activePositions.length}`);
          }
        });
      }

      LOGGER.info(`✅ State restored! Capital: $${state.capital.toFixed(2)}, Session P/L: $${state.session.netPL.toFixed(2)}`);
      return true;
    } catch (error) {
      LOGGER.error(`Failed to load state: ${error.message}`);
      return false;
    }
  }

  static startAutoSave() {
    setInterval(() => {
      if (state.isAuthorized) this.saveState();
    }, CONFIG.STATE_SAVE_INTERVAL);
    LOGGER.info(`💾 Auto-save enabled (every ${CONFIG.STATE_SAVE_INTERVAL / 1000}s)`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TELEGRAM SERVICE
// ══════════════════════════════════════════════════════════════════════════════

class TelegramService {
  static async sendMessage(message) {
    if (!CONFIG.TELEGRAM_ENABLED) return;
    try {
      const TelegramBot = require('node-telegram-bot-api');
      const bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: false });
      await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
    } catch (error) {
      LOGGER.error(`[Telegram] Failed: ${error.message}`);
    }
  }

  static async sendTradeAlert(type, symbol, direction, stake, duration, details = {}) {
    const emoji = type === 'OPEN' ? '🚀' : type === 'WIN' ? '✅' : '❌';
    const asset = state.assets[symbol];
    const today = TradeHistoryManager.getTodayStats();
    const overall = TradeHistoryManager.getOverallStats();

    // Build analysis details for OPEN trades
    let analysisDetails = '';
    if (type === 'OPEN' && details) {
      if (details.isRecovery) {
        analysisDetails = `
        🔄 <b>RECOVERY MODE: YES</b>
        ⚡ Same direction as loss trade (NO pattern analysis)`;
              } else if (details.analysis) {
                const analysis = details.analysis;
                const agreementRatio = analysis.details?.consensus?.agreementRatio 
                  ? (analysis.details.consensus.agreementRatio * 100).toFixed(0) 
                  : 'N/A';
                const bestPattern = analysis.details?.bestPattern;
                analysisDetails = `
        🧠 <b>PATTERN ANALYSIS:</b>
        📊 Confidence: ${(analysis.confidence * 100).toFixed(1)}%
        🤝 Agreement: ${agreementRatio}%
        📈 Best Pattern: L${bestPattern?.patternLength || 'N/A'} "${bestPattern?.pattern || 'N/A'}" (${(bestPattern?.confidence * 100).toFixed(1)}%)`;
      }
    }

    // Profit/Loss details for WIN/LOSS trades
    let resultDetails = '';
    if (details.profit !== undefined) {
      const isWin = details.profit > 0;
      resultDetails = `
      ${isWin ? '🟢' : '🔴'} <b>Profit: $${details.profit.toFixed(2)}</b>

      📊 Today's P/L: $${today.netPL.toFixed(2)}
      📈 Overall P/L: $${overall.netPL.toFixed(2)}
      💰 Capital: $${state.capital.toFixed(2)}`;
    }

    const recoveryStatus = asset?.isRecovery ? '🔄 RECOVERY' : '🎯 NORMAL';

    const msg = `
        ${emoji} <b>${type} TRADE ALERT - ${recoveryStatus}</b>

        📊 Asset: ${symbol}
        📈 Direction: ${direction === 'CALLE' ? 'RISE 📈' : 'FALL 📉'}
        💵 Stake: $${stake.toFixed(2)}
        ⏱ Duration: ${duration}
        🔢 Martingale Level: ${asset ? asset.martingaleLevel : 0}
        ${analysisDetails}${resultDetails}

        ⏰ ${new Date().toLocaleTimeString()}`.trim();

    await this.sendMessage(msg);
  }

  static async sendHourlySummary() {
    const statsSnapshot = { ...state.hourlyStats };

    if (statsSnapshot.trades === 0) {
      LOGGER.info('📱 Telegram: Skipping hourly summary (no trades this hour)');
      return;
    }

    const totalTrades = statsSnapshot.wins + statsSnapshot.losses;
    const winRate = totalTrades > 0 ? ((statsSnapshot.wins / totalTrades) * 100).toFixed(1) : 0;
    const pnlEmoji = statsSnapshot.pnl >= 0 ? '🟢' : '🔴';
    const pnlStr = (statsSnapshot.pnl >= 0 ? '+' : '') + '$' + statsSnapshot.pnl.toFixed(2);

    const today = TradeHistoryManager.getTodayStats();
    const overall = TradeHistoryManager.getOverallStats();

    // Per-asset hourly info
    let assetInfo = '';
    ACTIVE_ASSETS.forEach(symbol => {
      const a = state.assets[symbol];
      if (a && a.tradesCount > 0) {
        const ac = getAssetConfig(symbol);
        const recoveryStatus = a.isRecovery ? '🔄 REC' : '🎯 NORM';
        assetInfo += `\n  ${symbol} ${recoveryStatus}: ${a.tradesCount}t, ${a.winsCount}W/${a.lossesCount}L, P/L:$${a.netPL.toFixed(2)}, M:${a.martingaleLevel}`;
      }
    });

    const msg = `
    ⏰ <b>Pattern Bot Hourly Summary</b>

    📊 <b>Last Hour</b>
    ├ Trades: ${statsSnapshot.trades}
    ├ Wins: ${statsSnapshot.wins} | Losses: ${statsSnapshot.losses}
    ├ Win Rate: ${winRate}%
    └ ${pnlEmoji} <b>P&L:</b> ${pnlStr}

    📅 <b>Today (${TradeHistoryManager.getDateKey()})</b>
    ├ Total Trades: ${today.tradesCount}
    ├ Total W/L: ${today.winsCount}/${today.lossesCount}
    └ Today P/L: ${today.netPL >= 0 ? '+' : ''}$${today.netPL.toFixed(2)}

    📈 <b>Overall (All Time)</b>
    ├ Total Trades: ${overall.tradesCount}
    ├ Total W/L: ${overall.winsCount}/${overall.lossesCount}
    └ Overall P/L: ${overall.netPL >= 0 ? '+' : ''}$${overall.netPL.toFixed(2)}

    💰 Current Capital: $${state.capital.toFixed(2)}

    🔧 <b>Per-Asset Status:</b>${assetInfo || '\n  No trades yet'}

    🔄 Recovery Strategy: ${CONFIG.USE_RECOVERY_STRATEGY ? 'ENABLED' : 'DISABLED'}
    `.trim();

    try {
      await this.sendMessage(msg);
      LOGGER.info('📱 Telegram: Hourly Summary sent');
      LOGGER.info(`   📊 Hour Stats: ${statsSnapshot.trades} trades, ${statsSnapshot.wins}W/${statsSnapshot.losses}L, ${pnlStr}`);
    } catch (error) {
      LOGGER.error(`❌ Telegram hourly summary failed: ${error.message}`);
    }

    // Reset hourly stats
    state.hourlyStats = {
      trades: 0,
      wins: 0,
      losses: 0,
      pnl: 0,
      lastHour: new Date().getHours()
    };
  }

  static startHourlyTimer() {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1);
    nextHour.setMinutes(0);
    nextHour.setSeconds(0);
    nextHour.setMilliseconds(0);

    const timeUntilNextHour = nextHour.getTime() - now.getTime();

    LOGGER.info(`📱 Hourly Telegram timer started (first summary in ${Math.ceil(timeUntilNextHour / 60000)} min)`);

    setTimeout(() => {
      this.sendHourlySummary();
      setInterval(() => {
        this.sendHourlySummary();
      }, 60 * 60 * 1000); // Every hour
    }, timeUntilNextHour);
  }

  static async sendSessionSummary() {
    const stats = state.session;
    const today = TradeHistoryManager.getTodayStats();
    const overall = TradeHistoryManager.getOverallStats();

    let assetBreakdown = '';
    ACTIVE_ASSETS.forEach(symbol => {
      const a = state.assets[symbol];
      if (a && a.tradesCount > 0) {
        assetBreakdown += `\n  ${symbol}: ${a.tradesCount} trades, ${a.winsCount}W/${a.lossesCount}L, P/L: $${a.netPL.toFixed(2)}, Mart: ${a.martingaleLevel}`;
      }
    });

    const msg = `
📊 <b>SESSION SUMMARY</b>

📅 Today: ${stats.tradesCount} trades, ${stats.winsCount}W/${stats.lossesCount}L
P/L: $${stats.netPL.toFixed(2)}

📈 Per-Asset:${assetBreakdown || '\n  No trades yet'}

💰 Capital: $${state.capital.toFixed(2)}
`.trim();
    await this.sendMessage(msg);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CONNECTION MANAGER
// ══════════════════════════════════════════════════════════════════════════════

class ConnectionManager {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.reconnectDelay = 5000;
    this.pingInterval = null;
    this.autoSaveStarted = false;
    this.isReconnecting = false;
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      LOGGER.info('Already connected');
      return;
    }

    LOGGER.info('🔌 Connecting to Deriv API...');
    this.cleanup();

    this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);

    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', data => this.onMessage(data));
    this.ws.on('error', error => this.onError(error));
    this.ws.on('close', () => this.onClose());
  }

  onOpen() {
    LOGGER.info('✅ Connected to Deriv API');
    state.isConnected = true;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;

    this.startPing();

    if (!this.autoSaveStarted) {
      StatePersistence.startAutoSave();
      this.autoSaveStarted = true;
    }

    this.send({ authorize: CONFIG.API_TOKEN });
  }

  initializeAssets() {
    ACTIVE_ASSETS.forEach(symbol => {
      if (!state.assets[symbol]) {
        const assetConfig = getAssetConfig(symbol);
        state.assets[symbol] = {
          // Candle data
          candles: [],
          closedCandles: [],
          currentFormingCandle: null,
          lastProcessedCandleOpenTime: null,
          candlesLoaded: false,
          // Pattern analyzer
          patternAnalyzer: new CandlePatternAnalyzer({
            minConfidence: assetConfig.PATTERN_MIN_CONFIDENCE,
            patternLengths: assetConfig.PATTERN_LENGTHS,
            minOccurrences: assetConfig.PATTERN_MIN_OCCURRENCES,
            recencyDecay: assetConfig.PATTERN_RECENCY_DECAY,
            dojiThreshold: assetConfig.PATTERN_DOJI_THRESHOLD
          }),
          // Trade state
          lastTradeDirection: null,
          lastTradeWasWin: null,
          isRecovery: false,
          martingaleLevel: 0,
          currentStake: assetConfig.INITIAL_STAKE,
          baseStake: assetConfig.INITIAL_STAKE,
          investmentRemaining: assetConfig.INVESTMENT_AMOUNT,
          canTrade: false,
          // Active positions
          activePositions: [],
          // Stats
          tradesCount: 0,
          winsCount: 0,
          lossesCount: 0,
          profit: 0,
          loss: 0,
          netPL: 0,
          // Last analysis for notifications
          lastAnalysis: null
        };
        LOGGER.info(`📊 Initialized asset: ${symbol} (Stake: $${assetConfig.INITIAL_STAKE}, Duration: ${assetConfig.DURATION}${assetConfig.DURATION_UNIT})`);
      } else {
        const assetConfig = getAssetConfig(symbol);
        LOGGER.info(`📊 Asset ${symbol} already initialized — Mart=${state.assets[symbol].martingaleLevel}, Stake=$${state.assets[symbol].currentStake.toFixed(2)}`);
      }
    });
  }

  restoreSubscriptions() {
    LOGGER.info('📊 Restoring subscriptions after reconnection...');
    ACTIVE_ASSETS.forEach(symbol => {
      const asset = state.assets[symbol];
      if (asset && asset.activePositions) {
        asset.activePositions.forEach(pos => {
          if (pos.contractId) {
            LOGGER.info(`  ✅ Re-subscribing to contract ${pos.contractId} (${symbol})`);
            this.send({ proposal_open_contract: 1, contract_id: pos.contractId, subscribe: 1 });
          }
        });
      }
    });
  }

  cleanup() {
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        try { this.ws.close(); } catch (e) {}
      }
      this.ws = null;
    }
  }

  onMessage(data) {
    try {
      const response = JSON.parse(data);
      this.handleResponse(response);
    } catch (error) {
      LOGGER.error(`Error parsing message: ${error.message}`);
    }
  }

  handleResponse(response) {
    if (response.msg_type === 'authorize') {
      if (response.error) {
        LOGGER.error(`Authorization failed: ${response.error.message}`);
        return;
      }
      LOGGER.info('🔐 Authorized successfully');
      LOGGER.info(`👤 Account: ${response.authorize.loginid}`);
      LOGGER.info(`💰 Balance: ${response.authorize.balance} ${response.authorize.currency}`);

      state.isAuthorized = true;
      state.accountBalance = response.authorize.balance;

      if (state.capital === CONFIG.INITIAL_CAPITAL) {
        state.capital = response.authorize.balance;
      }

      this.send({ balance: 1, subscribe: 1 });

      if (this.reconnectAttempts > 0 || this.hasAnyActivePositions()) {
        LOGGER.info('🔄 Reconnection detected, restoring subscriptions...');
        this.restoreSubscriptions();
      }

      bot.start();
    }

    if (response.msg_type === 'balance') {
      state.accountBalance = response.balance.balance;
    }

    if (response.msg_type === 'ohlc') {
      this.handleOHLC(response.ohlc);
    }

    if (response.msg_type === 'candles') {
      this.handleCandlesHistory(response);
    }

    if (response.msg_type === 'buy') {
      this.handleBuyResponse(response);
    }

    if (response.msg_type === 'proposal_open_contract') {
      this.handleOpenContract(response);
    }
  }

  hasAnyActivePositions() {
    return ACTIVE_ASSETS.some(symbol => {
      const asset = state.assets[symbol];
      return asset && asset.activePositions && asset.activePositions.length > 0;
    });
  }

  handleBuyResponse(response) {
    if (response.error) {
      LOGGER.error(`Trade error: ${response.error.message}`);
      const reqId = response.echo_req?.req_id;
      if (reqId) {
        ACTIVE_ASSETS.forEach(symbol => {
          const asset = state.assets[symbol];
          if (asset && asset.activePositions) {
            const posIndex = asset.activePositions.findIndex(p => p.reqId === reqId);
            if (posIndex >= 0) {
              asset.activePositions.splice(posIndex, 1);
              LOGGER.info(`  Removed failed position from ${symbol}`);
            }
          }
        });
      }
      return;
    }

    const contract = response.buy;
    LOGGER.trade(`✅ Position opened: Contract ${contract.contract_id}, Buy Price: $${contract.buy_price}`);

    const reqId = response.echo_req.req_id;
    for (const symbol of ACTIVE_ASSETS) {
      const asset = state.assets[symbol];
      if (asset && asset.activePositions) {
        const position = asset.activePositions.find(p => p.reqId === reqId);
        if (position) {
          position.contractId = contract.contract_id;
          position.buyPrice = contract.buy_price;
          break;
        }
      }
    }

    this.send({ proposal_open_contract: 1, contract_id: contract.contract_id, subscribe: 1 });
  }

  handleOpenContract(response) {
    if (response.error) {
      LOGGER.error(`Contract error: ${response.error.message}`);
      return;
    }

    const contract = response.proposal_open_contract;
    const contractId = contract.contract_id;

    let ownerSymbol = null;
    let posIndex = -1;

    for (const symbol of ACTIVE_ASSETS) {
      const asset = state.assets[symbol];
      if (asset && asset.activePositions) {
        const idx = asset.activePositions.findIndex(p => p.contractId === contractId);
        if (idx >= 0) {
          ownerSymbol = symbol;
          posIndex = idx;
          break;
        }
      }
    }

    if (posIndex < 0 || !ownerSymbol) return;

    const assetState = state.assets[ownerSymbol];
    const position = assetState.activePositions[posIndex];
    position.currentProfit = contract.profit;

    if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
      const profit = contract.profit;
      const isWin = profit > 0;

      LOGGER.trade(`[${ownerSymbol}] Contract ${contractId} closed: ${isWin ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`);

      // Record result
      this.recordTradeResult(ownerSymbol, profit, position.direction);

      TelegramService.sendTradeAlert(isWin ? 'WIN' : 'LOSS', ownerSymbol, position.direction, position.stake, `${position.duration}${position.durationUnit}`, { profit });

      assetState.activePositions.splice(posIndex, 1);

      if (response.subscription?.id) {
        this.send({ forget: response.subscription.id });
      }

      this.checkSessionTargets();
      StatePersistence.saveState();
    }
  }

  recordTradeResult(symbol, profit, direction) {
    const assetState = state.assets[symbol];
    if (!assetState) return;

    const isWin = profit > 0;
    state.capital += profit;

    // Global session
    state.session.tradesCount++;
    if (isWin) {
      state.session.winsCount++;
      state.session.profit += profit;
    } else {
      state.session.lossesCount++;
      state.session.loss += Math.abs(profit);
    }
    state.session.netPL += profit;

    // Hourly stats
    state.hourlyStats.trades++;
    state.hourlyStats.pnl += profit;
    if (isWin) state.hourlyStats.wins++; else state.hourlyStats.losses++;

    // Per-asset
    assetState.tradesCount++;
    if (isWin) {
      assetState.winsCount++;
      assetState.profit += profit;
      assetState.netPL += profit;
      assetState.martingaleLevel = 0;
      assetState.lastTradeWasWin = true;
      assetState.currentStake = assetState.baseStake;
      // Exit recovery mode on win
      if (assetState.isRecovery) {
        assetState.isRecovery = false;
        LOGGER.info(`[${symbol}] Recovery mode EXITED - Win achieved`);
      }
    } else {
      assetState.lossesCount++;
      assetState.loss += Math.abs(profit);
      assetState.netPL += profit;
      assetState.martingaleLevel++;
      assetState.lastTradeWasWin = false;
      // Enter recovery mode on loss (if recovery strategy is enabled)
      if (CONFIG.USE_RECOVERY_STRATEGY) {
        assetState.isRecovery = true;
        LOGGER.info(`[${symbol}] Recovery mode ENTERED - Will trade ${direction} on next candle without analysis`);
      }

      // Calculate next stake
      const cfg = getAssetConfig(symbol);
      if (assetState.martingaleLevel <= cfg.MAX_MARTINGALE_LEVEL) {
        assetState.currentStake = Number((assetState.baseStake * Math.pow(cfg.MARTINGALE_MULTIPLIER, assetState.martingaleLevel)).toFixed(2));
      } else {
        let stake = assetState.baseStake * Math.pow(cfg.MARTINGALE_MULTIPLIER, cfg.MAX_MARTINGALE_LEVEL);
        const extraIdx = assetState.martingaleLevel - cfg.MAX_MARTINGALE_LEVEL - 1;
        for (let i = 0; i <= extraIdx; i++) {
          stake *= (cfg.EXTRA_LEVEL_MULTIPLIERS[i] || cfg.MARTINGALE_MULTIPLIER);
        }
        assetState.currentStake = Number(stake.toFixed(2));
      }

      if (assetState.martingaleLevel >= cfg.MAX_MARTINGALE_LEVEL + cfg.CONTINUE_EXTRA_LEVELS) {
        LOGGER.warn(`⚠️ [${symbol}] Max martingale reached, resetting`);
        assetState.martingaleLevel = 0;
        assetState.currentStake = cfg.INITIAL_STAKE;
        assetState.isRecovery = false;
      }
    }

    TradeHistoryManager.recordTrade(symbol, profit, assetState.martingaleLevel);
  }

  checkSessionTargets() {
    const netPL = state.session.netPL;
    if (netPL >= CONFIG.SESSION_PROFIT_TARGET) {
      LOGGER.trade(`🎯 SESSION PROFIT TARGET REACHED! P/L: $${netPL.toFixed(2)}`);
      TelegramService.sendSessionSummary();
    }
    if (netPL <= CONFIG.SESSION_STOP_LOSS) {
      LOGGER.error(`🛑 SESSION STOP LOSS REACHED! P/L: $${netPL.toFixed(2)}`);
      TelegramService.sendSessionSummary();
    }
  }

  handleOHLC(ohlc) {
    const symbol = ohlc.symbol;
    if (!state.assets[symbol]) return;

    const assetState = state.assets[symbol];
    const assetConfig = getAssetConfig(symbol);
    const granularity = assetConfig.GRANULARITY;

    const calculatedOpenTime = ohlc.open_time || Math.floor(ohlc.epoch / granularity) * granularity;

    const incomingCandle = {
      open: parseFloat(ohlc.open), high: parseFloat(ohlc.high),
      low: parseFloat(ohlc.low), close: parseFloat(ohlc.close),
      epoch: ohlc.epoch, open_time: calculatedOpenTime
    };

    const currentOpenTime = assetState.currentFormingCandle?.open_time;
    const isNewCandle = currentOpenTime && incomingCandle.open_time !== currentOpenTime;

    if (isNewCandle) {
      const closedCandle = { ...assetState.currentFormingCandle };
      closedCandle.epoch = closedCandle.open_time + granularity;

      if (closedCandle.open_time !== assetState.lastProcessedCandleOpenTime) {
        assetState.closedCandles.push(closedCandle);

        if (assetState.closedCandles.length > assetConfig.MAX_CANDLES_STORED) {
          assetState.closedCandles = assetState.closedCandles.slice(-assetConfig.MAX_CANDLES_STORED);
        }

        assetState.lastProcessedCandleOpenTime = closedCandle.open_time;

        const closeTime = new Date(closedCandle.epoch * 1000).toISOString();
        const candleType = closedCandle.close > closedCandle.open ? 'BULLISH' : closedCandle.close < closedCandle.open ? 'BEARISH' : 'DOJI';
        const candleEmoji = candleType === 'BULLISH' ? '🟢' : candleType === 'BEARISH' ? '🔴' : '⚪';

        LOGGER.info(`${symbol} ${candleEmoji} CANDLE [${closeTime}] ${candleType}`);

        // Pattern analysis trigger
        assetState.canTrade = true;
        bot.executeNextTrade(symbol, closedCandle);
      }
    }

    assetState.currentFormingCandle = incomingCandle;

    const candles = assetState.candles;
    const existingIndex = candles.findIndex(c => c.open_time === incomingCandle.open_time);
    if (existingIndex >= 0) {
      candles[existingIndex] = incomingCandle;
    } else {
      candles.push(incomingCandle);
    }

    if (candles.length > assetConfig.MAX_CANDLES_STORED) {
      assetState.candles = candles.slice(-assetConfig.MAX_CANDLES_STORED);
    }
  }

  handleCandlesHistory(response) {
    if (response.error) {
      LOGGER.error(`Error fetching candles: ${response.error.message}`);
      return;
    }

    const symbol = response.echo_req.ticks_history;
    if (!state.assets[symbol]) return;

    const assetConfig = getAssetConfig(symbol);
    const granularity = assetConfig.GRANULARITY;

    const candles = response.candles.map(c => {
      const openTime = Math.floor((c.epoch - granularity) / granularity) * granularity;
      return { open: parseFloat(c.open), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close), epoch: c.epoch, open_time: openTime };
    });

    if (candles.length === 0) {
      LOGGER.warn(`${symbol}: No historical candles received`);
      return;
    }

    state.assets[symbol].candles = [...candles];
    state.assets[symbol].closedCandles = [...candles];

    const lastCandle = candles[candles.length - 1];
    state.assets[symbol].lastProcessedCandleOpenTime = lastCandle.open_time;
    state.assets[symbol].currentFormingCandle = null;
    state.assets[symbol].candlesLoaded = true;

    LOGGER.info(`📊 Loaded ${candles.length} ${assetConfig.TIMEFRAME_LABEL} candles for ${symbol}`);
  }

  onError(error) {
    LOGGER.error(`WebSocket error: ${error.message}`);
  }

  onClose() {
    LOGGER.warn('🔌 Disconnected from Deriv API');
    state.isConnected = false;
    state.isAuthorized = false;

    this.stopPing();
    StatePersistence.saveState();

    if (this.isReconnecting) return;

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.isReconnecting = true;
      this.reconnectAttempts++;
      const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

      LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

      TelegramService.sendMessage(`⚠️ <b>CONNECTION LOST - RECONNECTING</b>\nAttempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);

      setTimeout(() => {
        this.isReconnecting = false;
        this.connect();
      }, delay);
    } else {
      LOGGER.error('Max reconnection attempts reached.');
      TelegramService.sendMessage(`🛑 <b>BOT STOPPED</b>\nMax reconnection attempts reached.`);
      process.exit(1);
    }
  }

  startPing() {
    this.pingInterval = setInterval(() => {
      if (state.isConnected) this.send({ ping: 1 });
    }, 30000);
  }

  stopPing() {
    if (this.pingInterval) clearInterval(this.pingInterval);
  }

  send(data) {
    if (!state.isConnected) {
      LOGGER.error('Cannot send: Not connected');
      return null;
    }
    data.req_id = state.requestId++;
    this.ws.send(JSON.stringify(data));
    return data.req_id;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════

class DerivPatternBot {
  constructor() {
    this.connection = new ConnectionManager();
  }

  async start() {
    console.log('\n' + '═'.repeat(80));
    console.log(' MULTI-ASSET PATTERN RECOGNITION BOT - Grid Martingale');
    console.log('═'.repeat(80));
    console.log(`💰 Initial Capital: $${state.capital}`);
    console.log(`📊 Active Assets: ${ACTIVE_ASSETS.length}`);
    console.log(`🎯 Session Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`);
    console.log('═'.repeat(80) + '\n');

    state.currentTradeDay = TradeHistoryManager.getDateKey();

    this.connection.initializeAssets();

    ACTIVE_ASSETS.forEach(symbol => {
      this.subscribeToCandles(symbol);
    });

    // Start hourly Telegram timer
    TelegramService.startHourlyTimer();

    TelegramService.sendMessage(`🤖 <b>MULTI-ASSET PATTERN BOT STARTED</b>\nAssets: ${ACTIVE_ASSETS.length}\nCapital: $${state.capital}\n🔄 Recovery Strategy: ${CONFIG.USE_RECOVERY_STRATEGY ? 'ENABLED' : 'DISABLED'}`);
  }

  subscribeToCandles(symbol) {
    const assetConfig = getAssetConfig(symbol);
    LOGGER.info(`📊 Subscribing to ${assetConfig.TIMEFRAME_LABEL} candles for ${symbol}...`);

    this.connection.send({
      ticks_history: symbol, adjust_start_time: 1, count: assetConfig.CANDLES_TO_LOAD,
      end: 'latest', start: 1, style: 'candles', granularity: assetConfig.GRANULARITY
    });

    this.connection.send({
      ticks_history: symbol, adjust_start_time: 1, count: 1,
      end: 'latest', start: 1, style: 'candles', granularity: assetConfig.GRANULARITY, subscribe: 1
    });
  }

  executeNextTrade(symbol, lastClosedCandle) {
    const assetState = state.assets[symbol];
    if (!assetState) return;
    if (!assetState.canTrade) return;
    if (!state.session.isActive) return;

    const assetConfig = getAssetConfig(symbol);

    // Check position limit
    if (assetState.activePositions.length >= 1) {
      return;
    }

    // Capital check
    if (state.capital < assetState.currentStake) {
      LOGGER.warn(`[${symbol}] Insufficient capital`);
      return;
    }

    let direction;
    let analysis = null;
    let isRecovery = assetState.isRecovery;

    // Check if in recovery mode and recovery strategy is enabled
    if (CONFIG.USE_RECOVERY_STRATEGY && assetState.isRecovery && assetState.lastTradeDirection) {
      // Recovery mode: trade SAME direction as losing trade, NO pattern analysis
      direction = assetState.lastTradeDirection;
      LOGGER.trade(`🔄 [${symbol}] RECOVERY TRADE - Same direction: ${direction} (NO analysis)`);
    } else {
      // Normal mode: run pattern analysis
      analysis = assetState.patternAnalyzer.analyze(assetState.closedCandles);
      assetState.lastAnalysis = analysis;

      const bestPatternConfidence = analysis.details?.bestPattern.confidence;

      if (!analysis.shouldTrade) {
        LOGGER.info(`[${symbol}] No trade signal - Confidence too low)`);
        assetState.canTrade = false;
        return;
      }

      if ((symbol === 'stpRNG' || symbol === 'stpRNG2' || symbol === 'stpRNG3' || symbol === 'stpRNG4' || symbol === 'stpRNG5')) {
        if (bestPatternConfidence < DEFAULT_ASSET_CONFIG.MIN_PATTERN_CONFIDENCE_STEP_RNG) {
          LOGGER.info(`[${symbol}] Low Pattern Confidence (Confidence: ${bestPatternConfidence ? (bestPatternConfidence * 100).toFixed(0) + '%' : 'N/A'})`);
          assetState.canTrade = false;
          return;
        }
      } else {
        if (bestPatternConfidence < DEFAULT_ASSET_CONFIG.MIN_PATTERN_CONFIDENCE) {
          LOGGER.info(`[${symbol}] Low Pattern Confidence (Confidence: ${bestPatternConfidence ? (bestPatternConfidence * 100).toFixed(0) + '%' : 'N/A'})`);
          assetState.canTrade = false;
          return;
        }
      }

      direction = analysis.direction;
      isRecovery = false;
      LOGGER.trade(`🎯 [${symbol}] PATTERN TRADE - Direction: ${direction} | Confidence: ${(analysis.confidence * 100).toFixed(1)}%`);
    }

    const stake = assetState.currentStake;
    const duration = assetConfig.DURATION;
    const durationUnit = assetConfig.DURATION_UNIT;

    // Log trade details
    if (isRecovery) {
      LOGGER.trade(`   Recovery Mode: ${isRecovery ? 'YES' : 'NO'} | Same direction as loss | Stake: $${stake.toFixed(2)} | Martingale: L${assetState.martingaleLevel}`);
    } else {
      const agreementRatio = analysis?.details?.consensus?.agreementRatio ? (analysis.details.consensus.agreementRatio * 100).toFixed(0) : 'N/A';
      LOGGER.trade(`   Recovery Mode: NO | Confidence: ${(analysis.confidence * 100).toFixed(1)}% | Agreement: ${agreementRatio}% | Stake: $${stake.toFixed(2)} | Martingale: L${assetState.martingaleLevel}`);
    }

    // Execute trade
    assetState.canTrade = false;
    assetState.lastTradeDirection = direction;

    const position = {
      symbol, direction, stake, duration, durationUnit,
      entryTime: Date.now(), contractId: null, reqId: null, currentProfit: 0, buyPrice: 0
    };

    assetState.activePositions.push(position);

    // Send enhanced Telegram notification
    TelegramService.sendTradeAlert('OPEN', symbol, direction, stake, `${duration}${durationUnit}`, {
      isRecovery,
      analysis: isRecovery ? null : analysis
    });

    const tradeRequest = {
      buy: 1, subscribe: 1, price: stake.toFixed(2),
      parameters: {
        contract_type: direction, symbol, currency: 'USD',
        amount: stake.toFixed(2), duration, duration_unit: durationUnit, basis: 'stake'
      }
    };

    const reqId = this.connection.send(tradeRequest);
    position.reqId = reqId;
  }

  stop() {
    LOGGER.info('🛑 Stopping bot...');
    ACTIVE_ASSETS.forEach(symbol => {
      if (state.assets[symbol]) {
        state.assets[symbol].canTrade = false;
      }
    });
    StatePersistence.saveState();
    TradeHistoryManager.saveHistory();
    setTimeout(() => {
      if (this.connection.ws) this.connection.ws.close();
      LOGGER.info('👋 Bot stopped');
    }, 2000);
  }

  getStatus() {
    let assetLines = '';
    ACTIVE_ASSETS.forEach(symbol => {
      const a = state.assets[symbol];
      if (a) {
        assetLines += `\n   ${symbol}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L $${a.netPL.toFixed(2)} M${a.martingaleLevel}`;
      }
    });

    return {
      capital: state.capital,
      session: state.session,
      assets: assetLines
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════════════════════════════════════════

tradeHistory = TradeHistoryManager.loadHistory();
const bot = new DerivPatternBot();

process.on('SIGINT', () => {
  console.log('\n\n⚠️ Shutdown signal received...');
  bot.stop();
  setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
  bot.stop();
  setTimeout(() => process.exit(0), 3000);
});

const stateLoaded = StatePersistence.loadState();
if (stateLoaded) {
  LOGGER.info('🔄 Bot will resume from saved state after connection');
} else {
  LOGGER.info('🆕 Bot will start with fresh state');
}

console.log('═'.repeat(80));
console.log(' MULTI-ASSET PATTERN RECOGNITION BOT');
console.log(` Active Assets: ${ACTIVE_ASSETS.join(', ')}`);
console.log('═'.repeat(80));
console.log('\n🚀 Initializing Multi-Asset Pattern Bot...\n');

bot.connection.connect();

// Status display every 60 seconds
setInterval(() => {
  if (state.isAuthorized) {
    const status = bot.getStatus();
    console.log(`\n📊 ${getGMTTime()} | Capital: $${status.capital.toFixed(2)} | Session: ${status.session.tradesCount}t $${status.session.netPL.toFixed(2)}`);
    console.log(`📈 Per-Asset:${status.assets}`);
  }
}, 60000);
