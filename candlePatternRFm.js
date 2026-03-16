#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════════════════════╗
// ║   MULTI-ASSET GRID MARTINGALE BOT — Pattern Recognition Edition v3.0          ║
// ║   15 Assets | CALLE/PUTE | Candle Pattern Analysis                             ║
// ║   Per-asset isolated state, config, stake & risk management                    ║
// ╚══════════════════════════════════════════════════════════════════════════════════╝

'use strict';

require('dotenv').config();

const WebSocket   = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs          = require('fs');
const path        = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// CANDLE PATTERN ANALYZER CLASS  (unchanged — shared, stateless per call)
// ══════════════════════════════════════════════════════════════════════════════

class CandlePatternAnalyzer {
  constructor(options = {}) {
    this.minConfidence  = options.minConfidence  || 0.60;
    this.patternLengths = options.patternLengths || [3, 4, 5, 6, 7, 8];
    this.minOccurrences = options.minOccurrences || 5;
    this.recencyDecay   = options.recencyDecay   || 0.9990;
    this.dojiThreshold  = options.dojiThreshold  || 0.00001;
    this.lastAnalysis   = null;
    this.lastAnalysisTime = 0;
  }

  classifyCandle(candle) {
    const bodySize  = Math.abs(candle.close - candle.open);
    const threshold = candle.open * this.dojiThreshold;
    if (bodySize <= threshold) return 'D';
    if (candle.close > candle.open) return 'B';
    return 'R';
  }

  classifyAll(candles) { return candles.map(c => this.classifyCandle(c)); }

  analyze(closedCandles) {
    const maxPatLen = Math.max(...this.patternLengths);
    if (closedCandles.length < maxPatLen + 20) {
      return {
        shouldTrade: false, direction: null, confidence: 0,
        reason: `Insufficient candle history: ${closedCandles.length} candles`,
        details: {}
      };
    }

    const types        = this.classifyAll(closedCandles);
    const totalCandles = types.length;
    const patternResults = [];

    for (const patLen of this.patternLengths) {
      if (totalCandles < patLen + 1) continue;
      const currentPattern     = types.slice(totalCandles - patLen);
      let bullishWeightedSum   = 0;
      let bearishWeightedSum   = 0;
      let dojiWeightedSum      = 0;
      let totalWeight          = 0;
      let rawOccurrences       = 0;
      const searchEnd          = totalCandles - patLen - 1;

      for (let i = 0; i <= searchEnd; i++) {
        let matches = true;
        for (let j = 0; j < patLen; j++) {
          if (types[i + j] !== currentPattern[j]) { matches = false; break; }
        }
        if (matches) {
          const nextType          = types[i + patLen];
          const distanceFromPresent = searchEnd - i;
          const weight            = Math.pow(this.recencyDecay, distanceFromPresent);
          rawOccurrences++;
          totalWeight += weight;
          if (nextType === 'B')      bullishWeightedSum += weight;
          else if (nextType === 'R') bearishWeightedSum += weight;
          else                       dojiWeightedSum    += weight;
        }
      }

      if (rawOccurrences < this.minOccurrences) continue;
      const decisiveWeight = bullishWeightedSum + bearishWeightedSum;
      if (decisiveWeight === 0) continue;

      const bullProb   = bullishWeightedSum / decisiveWeight;
      const bearProb   = bearishWeightedSum / decisiveWeight;
      const confidence = Math.max(bullProb, bearProb);
      const direction  = bullProb > bearProb ? 'CALLE' : 'PUTE';

      patternResults.push({
        patternLength: patLen, pattern: currentPattern.join(''),
        direction, confidence, bullProb, bearProb,
        rawOccurrences,
        totalWeight:    totalWeight.toFixed(2),
        decisiveWeight: decisiveWeight.toFixed(2)
      });
    }

    if (patternResults.length === 0) {
      return {
        shouldTrade: false, direction: null, confidence: 0,
        reason: `No patterns met minimum occurrence threshold (need >= ${this.minOccurrences})`,
        details: { patternResults: [] }
      };
    }

    let consensusBullScore = 0, consensusBearScore = 0, totalVoteWeight = 0;
    for (const r of patternResults) {
      const voteWeight = Math.sqrt(r.rawOccurrences) * Math.sqrt(r.patternLength);
      consensusBullScore += voteWeight * r.bullProb;
      consensusBearScore += voteWeight * r.bearProb;
      totalVoteWeight    += voteWeight;
    }

    const finalBullProb       = consensusBullScore / totalVoteWeight;
    const finalBearProb       = consensusBearScore / totalVoteWeight;
    const consensusConfidence = Math.max(finalBullProb, finalBearProb);
    const consensusDirection  = finalBullProb > finalBearProb ? 'CALLE' : 'PUTE';

    patternResults.sort((a, b) => b.confidence - a.confidence);
    const bestPattern = patternResults[0];

    let finalDirection, finalConfidence, decisionMethod;
    const agreeingPatterns = patternResults.filter(r => r.direction === consensusDirection);
    const agreementRatio   = agreeingPatterns.length / patternResults.length;

    if (bestPattern.direction === consensusDirection) {
      finalDirection   = consensusDirection;
      finalConfidence  = consensusConfidence;
      decisionMethod   = 'CONSENSUS+BEST_AGREE';
    } else {
      // Conflicting — no trade
      finalDirection  = consensusDirection;
      finalConfidence = 0;
      decisionMethod  = 'CONFLICT_NO_TRADE';
    }

    const shouldTrade = finalConfidence >= this.minConfidence;

    let reason;
    if (shouldTrade) {
      const dirLabel = finalDirection === 'CALLE' ? 'BULLISH' : 'BEARISH';
      reason = `Pattern: ${dirLabel} @ ${(finalConfidence * 100).toFixed(1)}% | ` +
               `Method: ${decisionMethod} | ${agreeingPatterns.length}/${patternResults.length} agree | ` +
               `Best: L${bestPattern.patternLength} "${bestPattern.pattern}" ` +
               `(${(bestPattern.confidence * 100).toFixed(1)}%, ${bestPattern.rawOccurrences} matches)`;
    } else {
      reason = `Confidence ${(finalConfidence * 100).toFixed(1)}% below threshold ` +
               `${(this.minConfidence * 100).toFixed(1)}% | Method: ${decisionMethod} | ` +
               `${agreeingPatterns.length}/${patternResults.length} agree`;
    }

    this.lastAnalysis = {
      shouldTrade,
      direction: shouldTrade ? finalDirection : null,
      confidence: finalConfidence,
      reason,
      details: {
        patternResults,
        consensus: {
          direction: consensusDirection, confidence: consensusConfidence,
          bullProb: finalBullProb, bearProb: finalBearProb, agreementRatio
        },
        bestPattern, decisionMethod, totalCandlesAnalyzed: totalCandles,
        timestamp: Date.now()
      }
    };
    this.lastAnalysisTime = Date.now();
    return this.lastAnalysis;
  }

  getAnalysisSummary(result) {
    if (!result || !result.details || !result.details.patternResults) return 'No analysis available';
    const lines = [];
    lines.push(`📊 Pattern Analysis (${result.details.totalCandlesAnalyzed} candles):`);
    lines.push(`   Decision: ${result.details.decisionMethod}`);
    for (const r of result.details.patternResults) {
      const dirIcon  = r.direction === 'CALLE' ? '🟢' : '🔴';
      const dirLabel = r.direction === 'CALLE' ? 'BULL' : 'BEAR';
      lines.push(
        `   L${r.patternLength} "${r.pattern}" → ${dirIcon} ${dirLabel} ` +
        `${(r.confidence * 100).toFixed(1)}% (${r.rawOccurrences} matches)`
      );
    }
    const cons    = result.details.consensus;
    const consDir = cons.direction === 'CALLE' ? 'BULL' : 'BEAR';
    lines.push(`   Consensus: ${consDir} ${(cons.confidence * 100).toFixed(1)}% (${(cons.agreementRatio * 100).toFixed(0)}% agreement)`);
    if (result.shouldTrade) {
      const finalDir = result.direction === 'CALLE' ? 'HIGHER 🟢' : 'LOWER 🔴';
      lines.push(`   ✅ SIGNAL: ${finalDir} @ ${(result.confidence * 100).toFixed(1)}%`);
    } else {
      lines.push(`   ⏳ NO TRADE: ${(result.confidence * 100).toFixed(1)}% < ${(this.minConfidence * 100).toFixed(1)}% threshold`);
    }
    return lines.join('\n');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PER-ASSET CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════
//
// Each asset has its own independent configuration block.
// All trading parameters are isolated per asset.
// Shared settings (apiToken, appId, telegram, candle, pattern) are in GLOBAL_CONFIG.
//
// ══════════════════════════════════════════════════════════════════════════════

const GLOBAL_CONFIG = {
  apiToken: 'Dz2V2KvRf4Uukt3' || process.env.DERIV_API_TOKEN,
  appId:    '1089' || process.env.DERIV_APP_ID,

  telegramToken:   '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ' || process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId:  '752497117' || process.env.TELEGRAM_CHAT_ID,
  telegramEnabled: true,

  // ── Candle History (shared across all assets) ──────────────────────────
  candle: {
    maxCandles:  5000,
    loadCount:   5000,
    granularity: 60,   // seconds
  },

  // ── Pattern Analysis defaults (can be overridden per asset) ───────────
  pattern: {
    minConfidence:  0.60,
    patternLengths: [3, 4, 5, 6, 7, 8],
    minOccurrences: 5,
    recencyDecay:   0.9990,
    dojiThreshold:  0.00001,
  },
};

// ── Per-Asset Config ────────────────────────────────────────────────────────
// Each entry maps: symbol → individual trading parameters
// ──────────────────────────────────────────────────────────────────────────
const ASSET_CONFIGS = {
  'R_10': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',   // 'continue' | 'reset' | 'stop'
    continueExtraLevels:   6,
    extraLevelMultipliers: [2.0, 2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  'R_25': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   6,
    extraLevelMultipliers: [2.0, 2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  'R_50': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   6,
    extraLevelMultipliers: [2.0, 2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  'R_75': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   5,
    extraLevelMultipliers: [2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  'R_100': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   5,
    extraLevelMultipliers: [2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  '1HZ10V': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   6,
    extraLevelMultipliers: [2.0, 2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  '1HZ25V': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   6,
    extraLevelMultipliers: [2.0, 2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  '1HZ50V': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   6,
    extraLevelMultipliers: [2.0, 2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  '1HZ75V': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   5,
    extraLevelMultipliers: [2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  '1HZ100V': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   5,
    extraLevelMultipliers: [2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  'stpRNG': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   6,
    extraLevelMultipliers: [2.0, 2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  'stpRNG2': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   6,
    extraLevelMultipliers: [2.0, 2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  'stpRNG3': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   6,
    extraLevelMultipliers: [2.0, 2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  'stpRNG4': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   6,
    extraLevelMultipliers: [2.0, 2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
  'stpRNG5': {
    enabled:               true,
    tickDuration:          54,
    initialStake:          0.35,
    investmentAmount:      100,
    martingaleMultiplier:  1.48,
    maxMartingaleLevel:    3,
    afterMaxLoss:          'continue',
    continueExtraLevels:   6,
    extraLevelMultipliers: [2.0, 2.0, 2.1, 2.1, 2.2, 2.3],
    autoCompounding:       true,
    compoundPercentage:    0.35,
    stopLoss:              100,
    takeProfit:            10000,
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// FILE PATHS
// ══════════════════════════════════════════════════════════════════════════════

const STATE_FILE          = path.join(__dirname, 'multi-asset-bot-state001.json');
const STATE_SAVE_INTERVAL = 5000;

// ══════════════════════════════════════════════════════════════════════════════
// STATE PERSISTENCE  (multi-asset aware)
// ══════════════════════════════════════════════════════════════════════════════

class StatePersistence {
  static save(orchestrator) {
    try {
      const perAsset = {};
      for (const [symbol, engine] of Object.entries(orchestrator.engines)) {
        perAsset[symbol] = {
          totalProfit:         engine.totalProfit,
          totalTrades:         engine.totalTrades,
          wins:                engine.wins,
          losses:              engine.losses,
          currentGridLevel:    engine.currentGridLevel,
          currentDirection:    engine.currentDirection,
          baseStake:           engine.baseStake,
          chainBaseStake:      engine.chainBaseStake,
          investmentRemaining: engine.investmentRemaining,
          totalRecovered:      engine.totalRecovered,
          maxWinStreak:        engine.maxWinStreak,
          maxLossStreak:       engine.maxLossStreak,
          currentStreak:       engine.currentStreak,
          inRecoveryMode:      engine.inRecoveryMode,
          skippedCandles:      engine.skippedCandles,
        };
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify({ savedAt: Date.now(), perAsset }, null, 2), 'utf8');
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

  static startAutoSave(orchestrator) {
    if (orchestrator._autoSaveInterval) return;
    orchestrator._autoSaveInterval = setInterval(() => {
      StatePersistence.save(orchestrator);
    }, STATE_SAVE_INTERVAL);
    console.log('[StatePersistence] Auto-save every 5 s ✅');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ASSET ENGINE  — Encapsulates all trading state for a single symbol
// ══════════════════════════════════════════════════════════════════════════════

class AssetEngine {
  constructor(symbol, assetCfg, globalCfg) {
    this.symbol = symbol;
    this.cfg    = assetCfg;   // per-asset config
    this.gcfg   = globalCfg;  // global (candle, pattern, account)

    // Merge pattern config from global (can later be overridden per asset if needed)
    this.patternAnalyzer = new CandlePatternAnalyzer({
      minConfidence:  (assetCfg.pattern || globalCfg.pattern).minConfidence,
      patternLengths: (assetCfg.pattern || globalCfg.pattern).patternLengths,
      minOccurrences: (assetCfg.pattern || globalCfg.pattern).minOccurrences,
      recencyDecay:   (assetCfg.pattern || globalCfg.pattern).recencyDecay,
      dojiThreshold:  (assetCfg.pattern || globalCfg.pattern).dojiThreshold,
    });

    this.GRANULARITY      = globalCfg.candle.granularity;
    this.MAX_CANDLES      = globalCfg.candle.maxCandles;
    this.CANDLES_TO_LOAD  = globalCfg.candle.loadCount;

    // ── Candle state ──────────────────────────────────────────────────────
    this.candles                     = [];
    this.closedCandles               = [];
    this.currentFormingCandle        = null;
    this.lastProcessedCandleOpenTime = null;
    this.candlesLoaded               = false;

    // ── Trade state ───────────────────────────────────────────────────────
    this.running               = false;
    this.tradeInProgress       = false;
    this.currentContractId     = null;
    this.pendingTradeInfo      = null;
    this.tradeStartTime        = null;

    this.currentGridLevel      = 0;
    this.currentDirection      = 'CALLE';
    this.baseStake             = assetCfg.initialStake;
    this.chainBaseStake        = assetCfg.initialStake;
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

    this.canTrade       = false;
    this.inRecoveryMode = false;
    this.skippedCandles = 0;
    this.isWinTrade     = false;
    this.hasStartedOnce = false;

    // ── Watchdog ──────────────────────────────────────────────────────────
    this.tradeWatchdogTimer     = null;
    this.tradeWatchdogPollTimer = null;
    this.tradeWatchdogMs        = 900000;

    // ── Dedup ──────────────────────────────────────────────────────────────
    this._processedContracts = new Set();
    this._maxProcessedCache  = 200;

    // ── Hourly stats ──────────────────────────────────────────────────────
    this.hourlyStats = {
      trades: 0, wins: 0, losses: 0, pnl: 0,
      skippedCandles: 0, lastHour: new Date().getHours()
    };
  }

  // ── Restore state from saved snapshot ─────────────────────────────────
  restoreFrom(saved) {
    if (!saved) return;
    this.totalProfit         = saved.totalProfit         || 0;
    this.totalTrades         = saved.totalTrades         || 0;
    this.wins                = saved.wins                || 0;
    this.losses              = saved.losses              || 0;
    this.currentGridLevel    = saved.currentGridLevel    || 0;
    this.currentDirection    = saved.currentDirection    || 'CALLE';
    this.baseStake           = saved.baseStake           || this.cfg.initialStake;
    this.chainBaseStake      = saved.chainBaseStake      || this.baseStake;
    this.investmentRemaining = saved.investmentRemaining || 0;
    this.totalRecovered      = saved.totalRecovered      || 0;
    this.maxWinStreak        = saved.maxWinStreak        || 0;
    this.maxLossStreak       = saved.maxLossStreak       || 0;
    this.currentStreak       = saved.currentStreak       || 0;
    this.inRecoveryMode      = saved.inRecoveryMode      || false;
    this.skippedCandles      = saved.skippedCandles      || 0;
    this.canTrade            = false;   // Always wait for fresh pattern
    this.hasStartedOnce      = true;
    this.log(
      `State restored | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `P&L: $${this.totalProfit.toFixed(2)} | Level: L${this.currentGridLevel} | ` +
      `Recovery: ${this.inRecoveryMode ? 'YES' : 'NO'}`,
      'success'
    );
  }

  // ── Logging (prefixed with symbol) ─────────────────────────────────────
  log(message, type = 'info') {
    const ts    = new Date().toISOString();
    const emoji = { error: '❌', success: '✅', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
    console.log(`[${ts}] [${this.symbol}] ${emoji} ${message}`);
  }

  // ── Stake calculator ────────────────────────────────────────────────────
  calculateStake(level) {
    const cfg = this.cfg;
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

  // ── Pattern analysis ─────────────────────────────────────────────────────
  runPatternAnalysis() {
    if (!this.candlesLoaded) {
      return { shouldTrade: false, direction: null, confidence: 0, reason: 'Candles not loaded', details: {} };
    }
    if (this.closedCandles.length < 30) {
      return { shouldTrade: false, direction: null, confidence: 0, reason: 'Not enough candles', details: {} };
    }

    const startTime = Date.now();
    const result    = this.patternAnalyzer.analyze(this.closedCandles);
    const elapsed   = Date.now() - startTime;
    const summary   = this.patternAnalyzer.getAnalysisSummary(result);
    console.log(summary);
    this.log(`Analysis done in ${elapsed}ms`, 'info');
    return result;
  }

  // ── Watchdog helpers ────────────────────────────────────────────────────
  clearWatchdog() {
    if (this.tradeWatchdogTimer)     { clearTimeout(this.tradeWatchdogTimer);     this.tradeWatchdogTimer     = null; }
    if (this.tradeWatchdogPollTimer) { clearTimeout(this.tradeWatchdogPollTimer); this.tradeWatchdogPollTimer = null; }
  }

  // ── Start / stop ────────────────────────────────────────────────────────
  start(balance, currency, sendFn) {
    if (this.running)                                         { this.log('Already running', 'warning'); return false; }
    if (this.cfg.investmentAmount <= 0)                       { this.log('Invalid investment', 'error'); return false; }
    if (this.cfg.investmentAmount > balance)                  {
      this.log(`Investment $${this.cfg.investmentAmount} > balance $${balance.toFixed(2)}`, 'error');
      return false;
    }

    const cfg = this.cfg;

    if (cfg.autoCompounding) {
      this.baseStake = Math.max(cfg.investmentAmount * cfg.compoundPercentage / 100, 0.35);
      this.log(`💰 Auto-compound ON: ${cfg.compoundPercentage}% of $${cfg.investmentAmount} = $${this.baseStake.toFixed(2)}`);
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
    this.hasStartedOnce        = true;
    this.skippedCandles        = 0;
    this.inRecoveryMode        = false;
    this.canTrade              = false;

    this.log(`🚀 STARTED | Investment: $${cfg.investmentAmount} | Stake: $${this.baseStake.toFixed(2)} | Mult: ${cfg.martingaleMultiplier}x | Max: L${cfg.maxMartingaleLevel} | ${cfg.tickDuration}s`, 'success');
    return true;
  }

  stop(reason = '') {
    this.running         = false;
    this.tradeInProgress = false;
    this.inRecoveryMode  = false;
    this.canTrade        = false;
    this.clearWatchdog();
    this.log(`🛑 STOPPED ${reason ? `(${reason})` : ''} | P&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`, 'warning');
  }

  logSummary() {
    const wr = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0';
    this.log(
      `📊 SUMMARY | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `WR: ${wr}% | P&L: $${this.totalProfit.toFixed(2)} | ` +
      `Recovered: $${this.totalRecovered.toFixed(2)} | Skipped: ${this.skippedCandles}`
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MULTI-ASSET ORCHESTRATOR
// ══════════════════════════════════════════════════════════════════════════════
//
// One WebSocket connection handles ALL assets.
// Each asset's candle stream, trades, and state are isolated in AssetEngine.
// OHLC messages are routed by symbol to the correct engine.
// Trades are placed sequentially per-asset (no cross-asset locking needed
// because each asset's own tradeInProgress flag guards it).
//
// ══════════════════════════════════════════════════════════════════════════════

class MultiAssetOrchestrator {
  constructor() {
    this.gcfg = GLOBAL_CONFIG;

    // Build engines only for enabled assets
    this.engines = {};
    for (const [symbol, assetCfg] of Object.entries(ASSET_CONFIGS)) {
      if (assetCfg.enabled) {
        this.engines[symbol] = new AssetEngine(symbol, assetCfg, this.gcfg);
      }
    }

    this.symbols = Object.keys(this.engines);
    this.log(`Loaded ${this.symbols.length} assets: ${this.symbols.join(', ')}`);

    // ── WebSocket ─────────────────────────────────────────────────────────
    this.ws             = null;
    this.isConnected    = false;
    this.isAuthorized   = false;
    this.reqId          = 1;

    // ── Account ───────────────────────────────────────────────────────────
    this.balance   = 0;
    this.currency  = 'USD';
    this.accountId = '';

    // ── Reconnection ──────────────────────────────────────────────────────
    this.reconnectAttempts    = 0;
    this.maxReconnectAttempts = 50;
    this.reconnectDelay       = 5000;
    this.reconnectTimer       = null;
    this.isReconnecting       = false;

    // ── Ping ──────────────────────────────────────────────────────────────
    this.pingInterval = null;

    // ── Session ───────────────────────────────────────────────────────────
    this.hasStartedOnce    = false;
    this.endOfDay          = false;
    this._autoSaveInterval = null;

    // ── Telegram ──────────────────────────────────────────────────────────
    this.telegramBot = null;
    if (this.gcfg.telegramEnabled && this.gcfg.telegramToken && this.gcfg.telegramChatId) {
      try {
        this.telegramBot = new TelegramBot(this.gcfg.telegramToken, { polling: false });
        this.log('Telegram notifications enabled ✅');
      } catch (e) {
        this.log(`Telegram init error: ${e.message}`, 'warning');
      }
    }

    // ── Hourly stats (global aggregate) ───────────────────────────────────
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, skippedCandles: 0, lastHour: new Date().getHours() };

    // ── Restore saved state ───────────────────────────────────────────────
    this._restoreState();
  }

  // ── Global logging ───────────────────────────────────────────────────────
  log(message, type = 'info') {
    const ts    = new Date().toISOString();
    const emoji = { error: '❌', success: '✅', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
    console.log(`[${ts}] [ORCHESTRATOR] ${emoji} ${message}`);
  }

  // ── State restore ────────────────────────────────────────────────────────
  _restoreState() {
    const saved = StatePersistence.load();
    if (!saved || !saved.perAsset) return;
    for (const [symbol, engine] of Object.entries(this.engines)) {
      if (saved.perAsset[symbol]) {
        engine.restoreFrom(saved.perAsset[symbol]);
      }
    }
    this.hasStartedOnce = true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET
  // ══════════════════════════════════════════════════════════════════════════

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.log('Already connected', 'warning'); return; }
    this._cleanupWs();
    const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.gcfg.appId}`;
    this.log(`Connecting to Deriv WebSocket… (attempt ${this.reconnectAttempts + 1})`);
    this.ws = new WebSocket(wsUrl);
    this.ws.on('open',    ()   => this._onOpen());
    this.ws.on('message', data => this._onRawMessage(data));
    this.ws.on('error',   err  => this._onError(err));
    this.ws.on('close',   code => this._onClose(code));
  }

  _onOpen() {
    this.log('WebSocket connected ✅', 'success');
    this.isConnected       = true;
    this.reconnectAttempts = 0;
    this.isReconnecting    = false;
    this._startPing();
    StatePersistence.startAutoSave(this);
    this._send({ authorize: this.gcfg.apiToken });
  }

  _onError(err) { this.log(`WebSocket error: ${err.message}`, 'error'); }

  _onClose(code) {
    this.log(`WebSocket closed (code: ${code})`, 'warning');
    this.isConnected  = false;
    this.isAuthorized = false;
    this._stopPing();

    // Release all trade locks
    for (const engine of Object.values(this.engines)) {
      engine.clearWatchdog();
      engine.tradeInProgress  = false;
      engine.pendingTradeInfo = null;
    }

    StatePersistence.save(this);

    if (this.endOfDay) { this.log('Planned disconnect — not reconnecting'); return; }
    if (this.isReconnecting) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('Max reconnect attempts reached', 'error');
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
    this.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})…`);

    this._sendTelegram(
      `⚠️ <b>MULTI-ASSET BOT — CONNECTION LOST</b>\n` +
      `Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}`
    );

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.isReconnecting = false; this.connect(); }, delay);
  }

  _cleanupWs() {
    this._stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.isConnected  = false;
    this.isAuthorized = false;
  }

  disconnect() {
    this.endOfDay = true;
    StatePersistence.save(this);
    this._cleanupWs();
    this.log('Disconnected ✅', 'success');
  }

  _send(request) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this.log('Cannot send — not connected', 'warning'); return null; }
    request.req_id = this.reqId++;
    try { this.ws.send(JSON.stringify(request)); return request.req_id; } catch (e) { this.log(`Send error: ${e.message}`, 'error'); return null; }
  }

  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) this._send({ ping: 1 });
    }, 5000);
  }

  _stopPing() { if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; } }

  // ══════════════════════════════════════════════════════════════════════════
  // MESSAGE ROUTER
  // ══════════════════════════════════════════════════════════════════════════

  _onRawMessage(data) {
    try { this._handleMessage(JSON.parse(data)); } catch (e) { this.log(`Parse error: ${e.message}`, 'error'); }
  }

  _handleMessage(msg) {
    if (msg.error) { this._handleApiError(msg); return; }
    switch (msg.msg_type) {
      case 'authorize':              this._onAuthorize(msg);          break;
      case 'balance':                this._onBalance(msg);            break;
      case 'proposal':               this._onProposal(msg);           break;
      case 'buy':                    this._onBuy(msg);                break;
      case 'proposal_open_contract': this._onContract(msg);           break;
      case 'ohlc':                   this._handleOHLC(msg.ohlc);     break;
      case 'candles':                this._handleCandlesHistory(msg); break;
      case 'ping':                                                     break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AUTHORIZE
  // ══════════════════════════════════════════════════════════════════════════

  _onAuthorize(msg) {
    if (msg.error) {
      this.log(`Authentication failed: ${msg.error.message}`, 'error');
      return;
    }
    this.isAuthorized = true;
    this.accountId    = msg.authorize.loginid;
    this.balance      = msg.authorize.balance;
    this.currency     = msg.authorize.currency;

    this.log(`Authorized ✅ | Account: ${this.accountId} | Balance: ${this.currency} ${this.balance.toFixed(2)}`, 'success');

    this._send({ balance: 1, subscribe: 1 });

    // Subscribe to candles for ALL assets
    for (const symbol of this.symbols) {
      this._subscribeToCandles(symbol);
    }

    if (!this.hasStartedOnce) {
      this._sendTelegram(
        `✅ <b>Multi-Asset Pattern Bot Connected</b>\n` +
        `Account: ${this.accountId}\n` +
        `Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
        `Assets: ${this.symbols.join(', ')}\n` +
        `Pattern Confidence: ≥${(this.gcfg.pattern.minConfidence * 100).toFixed(0)}%\n` +
        `Candle History: ${this.gcfg.candle.loadCount} candles/asset`
      );
      setTimeout(() => { this._startAllEngines(); }, 300);
    } else {
      // Reconnect — reset trade locks, reload candles
      for (const engine of Object.values(this.engines)) {
        engine.tradeInProgress = false;
        engine.canTrade        = false;
        this.log(`[${engine.symbol}] Reconnected — waiting for candle data + pattern analysis`, 'success');

        // Re-subscribe to open contracts
        if (engine.currentContractId) {
          engine.tradeInProgress = true;
          this._send({ proposal_open_contract: 1, contract_id: engine.currentContractId, subscribe: 1 });
          this._startTradeWatchdog(engine, engine.currentContractId);
        }
      }
      this._sendTelegram(
        `🔄 <b>Multi-Asset Bot Reconnected</b>\n` +
        `Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
        `Assets: ${this.symbols.length}`
      );
    }
  }

  _onBalance(msg) { this.balance = msg.balance.balance; }

  // ══════════════════════════════════════════════════════════════════════════
  // START ALL ENGINES
  // ══════════════════════════════════════════════════════════════════════════

  _startAllEngines() {
    let started = 0;
    for (const engine of Object.values(this.engines)) {
      if (engine.start(this.balance, this.currency, this._send.bind(this))) {
        started++;
        this._sendTelegram(
          `🚀 <b>${engine.symbol} Engine STARTED</b>\n` +
          `Investment: $${engine.cfg.investmentAmount}\n` +
          `Base Stake: $${engine.baseStake.toFixed(2)}\n` +
          `Multiplier: ${engine.cfg.martingaleMultiplier}x | Max Level: L${engine.cfg.maxMartingaleLevel}\n` +
          `Duration: ${engine.cfg.tickDuration}s\n` +
          `StopLoss: $${engine.cfg.stopLoss} | TakeProfit: $${engine.cfg.takeProfit}\n` +
          `AutoCompound: ${engine.cfg.autoCompounding ? `ON (${engine.cfg.compoundPercentage}%)` : 'OFF'}`
        );
      }
    }
    this.hasStartedOnce = true;
    this.log(`${started}/${this.symbols.length} asset engines started`, 'success');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CANDLE SUBSCRIPTION (per asset)
  // ══════════════════════════════════════════════════════════════════════════

  _subscribeToCandles(symbol) {
    const cfg = this.gcfg.candle;
    this.log(`Subscribing to ${cfg.granularity}s candles for ${symbol} (${cfg.loadCount} candles)…`);

    // Load historical
    this._send({
      ticks_history: symbol, adjust_start_time: 1,
      count: cfg.loadCount, end: 'latest', start: 1,
      style: 'candles', granularity: cfg.granularity
    });

    // Subscribe live
    this._send({
      ticks_history: symbol, adjust_start_time: 1,
      count: 1, end: 'latest', start: 1,
      style: 'candles', granularity: cfg.granularity, subscribe: 1
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CANDLE HISTORY HANDLER
  // ══════════════════════════════════════════════════════════════════════════

  _handleCandlesHistory(response) {
    if (response.error) { this.log(`Error fetching candles: ${response.error.message}`, 'error'); return; }

    const symbol = response.echo_req.ticks_history;
    const engine = this.engines[symbol];
    if (!engine) return;

    const GRAN = engine.GRANULARITY;
    const candles = response.candles.map(c => {
      const openTime = Math.floor((c.epoch - GRAN) / GRAN) * GRAN;
      return { open: parseFloat(c.open), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close), epoch: c.epoch, open_time: openTime };
    });

    if (candles.length === 0) { engine.log('No historical candles received', 'warning'); return; }

    engine.candles       = [...candles];
    engine.closedCandles = candles.slice(0, -1);

    const lastCandle = candles[candles.length - 1];
    engine.lastProcessedCandleOpenTime = lastCandle.open_time;
    engine.currentFormingCandle        = null;
    engine.candlesLoaded               = true;

    engine.log(`Loaded ${candles.length} historical candles`, 'success');

    const initialAnalysis = engine.runPatternAnalysis();
    engine.log(
      `Initial analysis: ${initialAnalysis.shouldTrade ? 
        `Would trade ${initialAnalysis.direction} @ ${(initialAnalysis.confidence * 100).toFixed(1)}%` :
        `No confident signal (${(initialAnalysis.confidence * 100).toFixed(1)}%)`
      } — waiting for next candle`,
      'info'
    );
    engine.canTrade = false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LIVE OHLC HANDLER (routes by symbol)
  // ══════════════════════════════════════════════════════════════════════════

  _handleOHLC(ohlc) {
    const symbol = ohlc.symbol;
    const engine = this.engines[symbol];
    if (!engine || !engine.candlesLoaded) return;

    const GRAN              = engine.GRANULARITY;
    const calculatedOpenTime = ohlc.open_time || Math.floor(ohlc.epoch / GRAN) * GRAN;
    const incomingCandle    = {
      open: parseFloat(ohlc.open), high: parseFloat(ohlc.high),
      low: parseFloat(ohlc.low), close: parseFloat(ohlc.close),
      epoch: ohlc.epoch, open_time: calculatedOpenTime
    };

    const currentOpenTime = engine.currentFormingCandle?.open_time;
    const isNewCandle     = currentOpenTime && incomingCandle.open_time !== currentOpenTime;

    if (isNewCandle) {
      const closedCandle = { ...engine.currentFormingCandle };
      closedCandle.epoch = closedCandle.open_time + GRAN;

      if (closedCandle.open_time !== engine.lastProcessedCandleOpenTime) {
        engine.closedCandles.push(closedCandle);
        if (engine.closedCandles.length > engine.MAX_CANDLES) {
          engine.closedCandles = engine.closedCandles.slice(-engine.MAX_CANDLES);
        }
        engine.lastProcessedCandleOpenTime = closedCandle.open_time;

        const candleType  = closedCandle.close > closedCandle.open ? 'BULLISH' : closedCandle.close < closedCandle.open ? 'BEARISH' : 'DOJI';
        const candleEmoji = candleType === 'BULLISH' ? '🟢' : candleType === 'BEARISH' ? '🔴' : '⚪';
        engine.log(`${candleEmoji} NEW CANDLE ${candleType} | History: ${engine.closedCandles.length}`);

        // ── Pattern-gated trade trigger ──────────────────────────────────
        if (engine.running && !engine.tradeInProgress) {
          const analysis = engine.runPatternAnalysis();

          if (analysis.shouldTrade) {
            engine.currentDirection = analysis.direction;
            engine.canTrade         = true;
            engine.skippedCandles   = 0;

            const modeLabel = engine.inRecoveryMode
              ? `⚡ RECOVERY L${engine.currentGridLevel}`
              : '🕯️ FRESH TRADE';

            engine.log(
              `${modeLabel} | Pattern: ${analysis.direction === 'CALLE' ? 'HIGHER 🟢' : 'LOWER 🔴'} ` +
              `@ ${(analysis.confidence * 100).toFixed(1)}% | Stake: $${engine.calculateStake(engine.currentGridLevel).toFixed(2)}`,
              'success'
            );

            const consensusAgreement = analysis.details.consensus
              ? (analysis.details.consensus.agreementRatio * 100)
              : 100;

            this._placeTrade(engine, analysis.direction, analysis, consensusAgreement);

          } else {
            engine.canTrade = false;
            engine.skippedCandles++;
            engine.hourlyStats.skippedCandles++;

            const skipMsg = engine.inRecoveryMode
              ? `⏳ RECOVERY WAITING — Confidence ${(analysis.confidence * 100).toFixed(1)}% < ` +
                `${(engine.gcfg.pattern.minConfidence * 100).toFixed(1)}% | L${engine.currentGridLevel} | ` +
                `Skipped: ${engine.skippedCandles} | Next stake: $${engine.calculateStake(engine.currentGridLevel).toFixed(2)}`
              : `⏳ SKIPPED — Confidence ${(analysis.confidence * 100).toFixed(1)}% < ` +
                `${(engine.gcfg.pattern.minConfidence * 100).toFixed(1)}% | Skipped: ${engine.skippedCandles}`;

            engine.log(skipMsg, 'warning');

            if (engine.inRecoveryMode && engine.skippedCandles % 10 === 0) {
              this._sendTelegram(
                `⏳ <b>${symbol} Recovery Waiting</b>\n` +
                `Skipped ${engine.skippedCandles} candles — no confident pattern\n` +
                `Grid Level: L${engine.currentGridLevel}\n` +
                `Next stake: $${engine.calculateStake(engine.currentGridLevel).toFixed(2)}\n` +
                `Last confidence: ${(analysis.confidence * 100).toFixed(1)}%`
              );
            }
          }
        } else if (engine.tradeInProgress) {
          engine.log('Trade in progress — will analyze on next candle', 'info');
        }
      }
    }

    // Update forming candle
    engine.currentFormingCandle = incomingCandle;
    const candles = engine.candles;
    const existingIdx = candles.findIndex(c => c.open_time === incomingCandle.open_time);
    if (existingIdx >= 0) candles[existingIdx] = incomingCandle;
    else candles.push(incomingCandle);
    if (candles.length > engine.MAX_CANDLES) engine.candles = candles.slice(-engine.MAX_CANDLES);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PLACE TRADE (per engine)
  // ══════════════════════════════════════════════════════════════════════════

  _placeTrade(engine, direction, analysis, consensusAgreement) {
    if (!this.isAuthorized)       return;
    if (!engine.running)          return;
    if (engine.tradeInProgress)   { engine.log('Trade already in progress', 'warning'); return; }
    if (!engine.canTrade)         { engine.log('Pattern gate — waiting for next candle', 'info'); return; }

    const stake = engine.calculateStake(engine.currentGridLevel);
    const label = direction === 'CALLE' ? 'HIGHER' : 'LOWER';
    const tradeType = engine.inRecoveryMode ? `⚡ RECOVERY L${engine.currentGridLevel}` : '🕯️ PATTERN TRADE';
    const confStr   = `${(analysis.confidence * 100).toFixed(1)}%`;

    if (stake > engine.investmentRemaining) {
      engine.log(`Insufficient investment: $${stake} > $${engine.investmentRemaining.toFixed(2)}`, 'error');
      engine.running      = false;
      engine.inRecoveryMode = false;
      engine.canTrade     = false;
      this._sendTelegram(`🛑 <b>${engine.symbol} INSUFFICIENT INVESTMENT</b>\nNext stake: $${stake}\nRemaining: $${engine.investmentRemaining.toFixed(2)}`);
      return;
    }
    if (stake > this.balance) {
      engine.log(`Insufficient balance: $${stake} > $${this.balance.toFixed(2)}`, 'error');
      engine.running      = false;
      engine.inRecoveryMode = false;
      engine.canTrade     = false;
      return;
    }

    engine.investmentRemaining = Number((engine.investmentRemaining - stake).toFixed(2));
    engine.log(`${tradeType} | ${label} | Stake: $${stake} | Confidence: ${confStr} | Investment left: $${engine.investmentRemaining.toFixed(2)}`);

    this._sendTelegram(
      `📊 <b>${engine.symbol} Trade Open</b>\n` +
      `Signal: ${direction === 'CALLE' ? 'HIGHER 🟢' : 'LOWER 🔴'}\n` +
      `Confidence: ${confStr} | Agreement: ${consensusAgreement.toFixed(1)}%\n` +
      `Stake: $${stake.toFixed(2)} | Duration: ${engine.cfg.tickDuration}s\n` +
      `Investment left: $${engine.investmentRemaining.toFixed(2)}`
    );

    engine.canTrade        = false;
    engine.tradeInProgress = true;
    engine.pendingTradeInfo = {
      id: Date.now(), time: new Date().toISOString(),
      direction, stake, gridLevel: engine.currentGridLevel,
      confidence: confStr, symbol: engine.symbol
    };

    this._send({
      proposal:      1,
      amount:        stake,
      basis:         'stake',
      contract_type: direction,
      currency:      this.currency,
      duration:      engine.cfg.tickDuration,
      duration_unit: 's',
      symbol:        engine.symbol,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PROPOSAL → BUY
  // ══════════════════════════════════════════════════════════════════════════

  _onProposal(msg) {
    if (!msg.proposal) return;

    // Find which engine is waiting for a proposal
    // We use pendingTradeInfo.symbol to match
    const engine = this._findEngineWithPendingTrade();
    if (!engine) return;

    this._send({ buy: msg.proposal.id, price: msg.proposal.ask_price });
  }

  _findEngineWithPendingTrade() {
    for (const engine of Object.values(this.engines)) {
      if (engine.tradeInProgress && engine.pendingTradeInfo && !engine.currentContractId) {
        return engine;
      }
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BUY CONFIRMATION
  // ══════════════════════════════════════════════════════════════════════════

  _onBuy(msg) {
    const b      = msg.buy;
    // Match to the engine whose pendingTradeInfo is active
    const engine = this._findEngineWithPendingTrade();
    if (!engine) {
      this.log(`Buy confirmation for unknown engine: ${b.contract_id}`, 'warning');
      return;
    }

    engine.currentContractId   = b.contract_id;
    engine.tradeStartTime      = Date.now();
    // Investment was already deducted in _placeTrade — no double-deduction
    engine.log(`Contract opened: ${b.contract_id} | Stake: $${b.buy_price.toFixed(2)} | Investment left: $${engine.investmentRemaining.toFixed(2)}`);

    this._startTradeWatchdog(engine, b.contract_id);
    this._send({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT RESULT
  // ══════════════════════════════════════════════════════════════════════════

  _onContract(msg) {
    const c = msg.proposal_open_contract;
    if (!c.is_sold) return;

    const contractId = String(c.contract_id);

    // Find the engine that owns this contract
    const engine = Object.values(this.engines).find(
      e => e.currentContractId && String(e.currentContractId) === contractId
    );
    if (!engine) { this.log(`Contract ${contractId} not owned by any engine`, 'warning'); return; }

    if (engine._processedContracts.has(contractId)) {
      engine.log(`Duplicate contract result ignored: ${contractId}`, 'warning');
      return;
    }
    engine._processedContracts.add(contractId);
    if (engine._processedContracts.size > engine._maxProcessedCache) {
      const first = engine._processedContracts.values().next().value;
      engine._processedContracts.delete(first);
    }

    engine.clearWatchdog();

    const profit = parseFloat(c.profit);
    const payout = parseFloat(c.payout || 0);
    const isWin  = profit > 0;

    engine.tradeInProgress   = false;
    engine.pendingTradeInfo  = null;
    engine.currentContractId = null;
    engine.tradeStartTime    = null;

    // ── Counters ──────────────────────────────────────────────────────────
    engine.totalTrades += 1;
    engine.totalProfit  = Number((engine.totalProfit + profit).toFixed(2));
    if (isWin) { engine.wins++; engine.isWinTrade = true; }
    else        { engine.losses++; engine.isWinTrade = false; }

    engine.currentStreak = isWin
      ? (engine.currentStreak > 0 ? engine.currentStreak + 1 : 1)
      : (engine.currentStreak < 0 ? engine.currentStreak - 1 : -1);
    if (isWin)  engine.maxWinStreak  = Math.max(engine.currentStreak, engine.maxWinStreak);
    if (!isWin) engine.maxLossStreak = Math.min(engine.currentStreak, engine.maxLossStreak);

    engine.hourlyStats.trades++;
    engine.hourlyStats.pnl += profit;
    this.hourlyStats.trades++;
    this.hourlyStats.pnl += profit;
    if (isWin) { engine.hourlyStats.wins++; this.hourlyStats.wins++; }
    else        { engine.hourlyStats.losses++; this.hourlyStats.losses++; }

    // ── Per-asset risk management ─────────────────────────────────────────
    if (engine.totalProfit <= -engine.cfg.stopLoss) {
      engine.log(`🛑 STOP LOSS hit! P&L: $${engine.totalProfit.toFixed(2)}`, 'error');
      this._sendTelegram(`🛑 <b>${engine.symbol} STOP LOSS REACHED</b>\nP&L: $${engine.totalProfit.toFixed(2)}`);
      engine.stop('STOP_LOSS');
      return;
    }
    if (engine.totalProfit >= engine.cfg.takeProfit) {
      engine.log(`🎉 TAKE PROFIT hit! P&L: $${engine.totalProfit.toFixed(2)}`, 'success');
      this._sendTelegram(`🎉 <b>${engine.symbol} TAKE PROFIT REACHED</b>\nP&L: $${engine.totalProfit.toFixed(2)}`);
      engine.stop('TAKE_PROFIT');
      return;
    }

    let shouldContinue = true;
    const cfg          = engine.cfg;

    // ── WIN ───────────────────────────────────────────────────────────────
    if (isWin) {
      if (engine.currentGridLevel > 0) engine.totalRecovered += profit;
      engine.investmentRemaining = Number((engine.investmentRemaining + payout).toFixed(2));

      const wasRecovery = engine.inRecoveryMode;

      if (cfg.autoCompounding) {
        engine.baseStake = Math.max(engine.investmentRemaining * cfg.compoundPercentage / 100, 0.35);
        engine.log(
          `🎯 WIN +$${profit.toFixed(2)}${wasRecovery ? ' | RECOVERY COMPLETE! 🎉' : ''} | ` +
          `L${engine.currentGridLevel} → RESET | Investment: $${engine.investmentRemaining.toFixed(2)} | ` +
          `New base: $${engine.baseStake.toFixed(2)}`,
          'success'
        );
      } else {
        engine.log(`🎯 WIN +$${profit.toFixed(2)}${wasRecovery ? ' | FULL RECOVERY! 🎉' : ''} | Reset → L0`, 'success');
      }

      engine.currentGridLevel = 0;
      engine.inRecoveryMode   = false;
      engine.canTrade         = false;
      engine.skippedCandles   = 0;

      this._sendTelegramTradeResult(engine, isWin, profit);

    // ── LOSS ──────────────────────────────────────────────────────────────
    } else {
      const nextLevel    = engine.currentGridLevel + 1;
      const absoluteMax  = cfg.afterMaxLoss === 'continue'
        ? cfg.maxMartingaleLevel + cfg.continueExtraLevels
        : cfg.maxMartingaleLevel;

      engine.currentGridLevel = nextLevel;
      engine.inRecoveryMode   = true;
      engine.canTrade         = false;

      if (nextLevel > absoluteMax) {
        engine.log(`🛑 ABSOLUTE CEILING L${absoluteMax} reached`, 'error');
        this._sendTelegram(
          `🛑 <b>${engine.symbol} ABSOLUTE MAX LEVEL (L${absoluteMax}) REACHED</b>\n` +
          `Investment remaining: $${engine.investmentRemaining.toFixed(2)}\n` +
          `P&L: $${engine.totalProfit.toFixed(2)}`
        );
        shouldContinue        = false;
        engine.inRecoveryMode = false;
        engine.canTrade       = false;

      } else if (nextLevel > cfg.maxMartingaleLevel && cfg.afterMaxLoss === 'reset') {
        engine.currentGridLevel = 0;
        engine.inRecoveryMode   = false;
        engine.canTrade         = false;
        engine.log('🔄 MAX LEVEL — Resetting to L0 (reset mode) — waiting for pattern signal', 'warning');

      } else {
        const nextStake = engine.calculateStake(engine.currentGridLevel);
        engine.log(
          `📉 LOSS -$${Math.abs(profit).toFixed(2)} | L${engine.currentGridLevel}/${absoluteMax} | ` +
          `Next stake: $${nextStake.toFixed(2)} | ⏳ Waiting for next candle + pattern re-analysis`,
          'warning'
        );
      }

      this._sendTelegramTradeResult(engine, isWin, profit);

      if (shouldContinue) {
        const nextStake = engine.calculateStake(engine.currentGridLevel);
        if (nextStake > engine.investmentRemaining) {
          engine.log(`🛑 INSUFFICIENT INVESTMENT: $${nextStake.toFixed(2)} > $${engine.investmentRemaining.toFixed(2)}`, 'error');
          shouldContinue = false; engine.inRecoveryMode = false; engine.canTrade = false;
        } else if (nextStake > this.balance) {
          engine.log(`🛑 INSUFFICIENT BALANCE: $${nextStake.toFixed(2)} > $${this.balance.toFixed(2)}`, 'error');
          shouldContinue = false; engine.inRecoveryMode = false; engine.canTrade = false;
        }
      }
    }

    if (!shouldContinue) {
      engine.running        = false;
      engine.inRecoveryMode = false;
      engine.canTrade       = false;
      engine.logSummary();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // API ERROR HANDLER
  // ══════════════════════════════════════════════════════════════════════════

  _handleApiError(msg) {
    this.log(`API Error [${msg.error.code}]: ${msg.error.message} (msg_type: ${msg.msg_type})`, 'error');

    const code = msg.error.code;
    if (code === 'AuthorizationRequired' || code === 'InvalidToken') {
      this.isAuthorized = false;
      this._onClose(4001);
      return;
    }

    if (msg.msg_type === 'buy' || msg.msg_type === 'proposal') {
      // Release trade lock for whichever engine was mid-trade
      for (const engine of Object.values(this.engines)) {
        if (engine.tradeInProgress) {
          engine.log('Trade error — releasing lock, retrying on next candle', 'warning');
          engine.clearWatchdog();
          engine.tradeInProgress  = false;
          engine.pendingTradeInfo = null;
          engine.currentContractId = null;
          engine.canTrade         = false;
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TRADE WATCHDOG (per engine)
  // ══════════════════════════════════════════════════════════════════════════

  _startTradeWatchdog(engine, contractId) {
    engine.clearWatchdog();
    const timeoutMs = engine.tradeWatchdogMs;

    engine.tradeWatchdogTimer = setTimeout(() => {
      if (!engine.tradeInProgress) return;
      engine.log(`⏰ WATCHDOG FIRED — Contract ${contractId} open for ${timeoutMs / 1000}s`, 'warning');

      if (contractId && this.isConnected && this.isAuthorized) {
        this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });

        engine.tradeWatchdogPollTimer = setTimeout(() => {
          if (!engine.tradeInProgress) return;
          engine.log(`🚨 WATCHDOG POLL TIMEOUT — force-releasing lock for ${contractId}`, 'error');
          this._recoverStuckTrade(engine, 'watchdog-force');
        }, timeoutMs);
      } else {
        this._recoverStuckTrade(engine, 'watchdog-offline');
      }
    }, timeoutMs);
  }

  _recoverStuckTrade(engine, reason) {
    engine.clearWatchdog();
    const contractId = engine.currentContractId;
    engine.log(`🚨 STUCK TRADE RECOVERY [${reason}] | Contract: ${contractId}`, 'error');

    if (engine.pendingTradeInfo && engine.pendingTradeInfo.stake > 0) {
      engine.investmentRemaining = Number((engine.investmentRemaining + engine.pendingTradeInfo.stake).toFixed(2));
      engine.log(`💰 Stake $${engine.pendingTradeInfo.stake.toFixed(2)} returned → pool: $${engine.investmentRemaining.toFixed(2)}`, 'warning');
    }

    if (contractId) engine._processedContracts.add(String(contractId));
    engine.tradeInProgress   = false;
    engine.pendingTradeInfo  = null;
    engine.currentContractId = null;
    engine.tradeStartTime    = null;
    engine.canTrade          = false;

    this._sendTelegram(
      `⚠️ <b>${engine.symbol} STUCK TRADE RECOVERED [${reason}]</b>\n` +
      `Contract: ${contractId || 'unknown'}\n` +
      `Level: L${engine.currentGridLevel} | Recovery: ${engine.inRecoveryMode ? 'YES' : 'NO'}\n` +
      `Action: waiting for next candle + pattern analysis`
    );
    StatePersistence.save(this);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TELEGRAM
  // ══════════════════════════════════════════════════════════════════════════

  async _sendTelegram(message) {
    if (!this.telegramBot || !this.gcfg.telegramEnabled) return;
    try {
      await this.telegramBot.sendMessage(this.gcfg.telegramChatId, message, { parse_mode: 'HTML' });
    } catch (e) {
      this.log(`Telegram send failed: ${e.message}`, 'warning');
    }
  }

  _sendTelegramTradeResult(engine, isWin, profit) {
    const wr       = engine.totalTrades > 0 ? ((engine.wins / engine.totalTrades) * 100).toFixed(1) : '0.0';
    const pnlStr   = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(2);
    const lastAnalysis = engine.patternAnalyzer.lastAnalysis;
    const confStr  = lastAnalysis ? `${(lastAnalysis.confidence * 100).toFixed(1)}%` : 'N/A';
    const method   = lastAnalysis?.details?.decisionMethod || 'N/A';

    this._sendTelegram(
      `${isWin ? '✅ WIN' : '❌ LOSS'} <b>— ${engine.symbol}</b>\n\n` +
      `${isWin ? '🟢' : '🔴'} <b>P&L:</b> ${pnlStr}\n` +
      `🧠 <b>Confidence:</b> ${confStr} (${method})\n` +
      `📊 <b>Grid Level:</b> ${isWin ? 'RESET → L0' : `L${engine.currentGridLevel}`}\n\n` +
      `📈 <b>Session Stats:</b>\n` +
      `  Trades: ${engine.totalTrades} | W/L: ${engine.wins}/${engine.losses}\n` +
      `  Win Rate: ${wr}%\n` +
      `  Daily P&L: ${(engine.totalProfit >= 0 ? '+' : '')}$${engine.totalProfit.toFixed(2)}\n` +
      `  Investment: $${engine.investmentRemaining.toFixed(2)}\n` +
      `  Skipped: ${engine.skippedCandles}\n\n` +
      `⏰ ${new Date().toLocaleTimeString()}`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HOURLY SUMMARY
  // ══════════════════════════════════════════════════════════════════════════

  async _sendHourlySummary() {
    const s   = this.hourlyStats;
    const wr  = (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0';
    const pnl = (s.pnl >= 0 ? '+' : '') + '$' + s.pnl.toFixed(2);

    let assetLines = '';
    for (const [sym, engine] of Object.entries(this.engines)) {
      const ewr = engine.totalTrades > 0 ? ((engine.wins / engine.totalTrades) * 100).toFixed(1) : '0.0';
      assetLines += `  ${sym}: P&L ${(engine.totalProfit >= 0 ? '+' : '')}$${engine.totalProfit.toFixed(2)} | ${engine.totalTrades} trades | WR ${ewr}% | L${engine.currentGridLevel}\n`;
    }

    await this._sendTelegram(
      `⏰ <b>Multi-Asset Bot — Hourly Summary</b>\n\n` +
      `📊 <b>Last Hour (all assets):</b>\n` +
      `  Trades: ${s.trades} | Wins: ${s.wins} | Losses: ${s.losses}\n` +
      `  Win Rate: ${wr}% | P&L: ${pnl}\n\n` +
      `📈 <b>Per-Asset Status:</b>\n${assetLines}\n` +
      `⏰ ${new Date().toLocaleString()}`
    );

    this.log('📱 Hourly summary sent');
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, skippedCandles: 0, lastHour: new Date().getHours() };
  }

  startTelegramTimer() {
    const now      = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const delay    = nextHour.getTime() - now.getTime();
    setTimeout(() => {
      this._sendHourlySummary();
      setInterval(() => this._sendHourlySummary(), 60 * 60 * 1000);
    }, delay);
    this.log(`📱 Hourly Telegram scheduled (first in ${Math.ceil(delay / 60000)} min)`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STOP ALL
  // ══════════════════════════════════════════════════════════════════════════

  stop() {
    for (const engine of Object.values(this.engines)) engine.stop();
    StatePersistence.save(this);
    this.log('All engines stopped', 'warning');
  }

  emergencyStop() {
    this.log('🚨 EMERGENCY STOP', 'error');
    for (const engine of Object.values(this.engines)) {
      engine.running = false; engine.tradeInProgress = false;
      engine.inRecoveryMode = false; engine.canTrade = false;
      engine.clearWatchdog();
    }
    this._sendTelegram(`🚨 <b>MULTI-ASSET EMERGENCY STOP TRIGGERED</b>`);
    StatePersistence.save(this);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TERMINAL BANNER
// ══════════════════════════════════════════════════════════════════════════════

function printBanner() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║   MULTI-ASSET GRID MARTINGALE BOT — Pattern Recognition Edition v3.0      ║');
  console.log('║   15 Assets | CALLE/PUTE | 5000-candle pattern analysis per asset        ║');
  console.log('║   Per-asset: Stake · Investment · Martingale · StopLoss · TakeProfit     ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝\n');

  const symbols = Object.keys(ASSET_CONFIGS).filter(s => ASSET_CONFIGS[s].enabled);
  console.log(`Active assets (${symbols.length}): ${symbols.join(', ')}\n`);
  for (const sym of symbols) {
    const c = ASSET_CONFIGS[sym];
    console.log(
      `  ${sym.padEnd(10)} | Inv: $${c.investmentAmount} | Stake: $${c.initialStake} | ` +
      `Mult: ${c.martingaleMultiplier}x | MaxL: ${c.maxMartingaleLevel} | ` +
      `SL: $${c.stopLoss} | TP: $${c.takeProfit}`
    );
  }
  console.log('\nFlow per asset:');
  console.log('  New Candle → Pattern Analysis → Confident? → Trade');
  console.log('  Loss → Wait for Next Candle → Re-analyze → Confident? → Recovery Trade');
  console.log('  Win  → Reset Level → Wait for Next Candle + Pattern\n');
  console.log('Signals: SIGINT / SIGTERM for graceful shutdown\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

function main() {
  printBanner();

  const orchestrator = new MultiAssetOrchestrator();

  StatePersistence.startAutoSave(orchestrator);

  if (orchestrator.telegramBot) orchestrator.startTelegramTimer();

  orchestrator.connect();

  const shutdown = (sig) => {
    console.log(`\n[${sig}] Shutting down gracefully…`);
    orchestrator.stop();
    orchestrator.disconnect();
    StatePersistence.save(orchestrator);
    setTimeout(() => process.exit(0), 2000);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]', reason));
  process.on('uncaughtException',  (err)    => console.error('[UncaughtException]', err));
}

main();
