#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════════════════════╗
// ║   STEP INDEX GRID MARTINGALE BOT — Pattern Recognition Edition                ║
// ║   Volatility STEP Index | CALLE/PUTE | Candle Pattern Analysis                ║
// ║   5000 candle history | Recency-weighted | Confidence-gated trading           ║
// ╚══════════════════════════════════════════════════════════════════════════════════╝

'use strict';

require('dotenv').config();

const WebSocket   = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs          = require('fs');
const path        = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// CANDLE PATTERN ANALYZER CLASS
// ══════════════════════════════════════════════════════════════════════════════
//
// This class analyzes historical candle sequences to find repeating patterns
// and predict the next candle's direction with a confidence score.
//
// How it works:
//   1. Each closed candle is classified as 'B' (Bullish) or 'R' (Bearish)
//   2. For pattern lengths 3 through 8 (configurable), extract the most
//      recent N candles as the "current pattern"
//   3. Search the entire 5000-candle history for every occurrence of that
//      same pattern, and record what candle came NEXT after each match
//   4. Weight each historical match by recency — recent matches count more
//      than ancient ones, allowing the bot to adapt to changing trends
//   5. Calculate weighted probability of Bullish vs Bearish for each length
//   6. Combine all pattern lengths via weighted consensus voting
//   7. Only signal a trade if final confidence >= threshold (default 60%)
//
// Recency weighting uses exponential decay:
//   weight = decayFactor ^ distanceFromPresent
//   With decay=0.9990, a match 1000 candles ago has ~37% weight
//   With decay=0.9990, a match 4000 candles ago has ~2% weight
//   This naturally emphasizes recent market behavior
//
// Consensus voting weights each pattern length by:
//   sqrt(occurrences) * sqrt(patternLength) * confidence
//   This balances statistical significance, pattern specificity,
//   and predictive strength
// ══════════════════════════════════════════════════════════════════════════════

class CandlePatternAnalyzer {
  constructor(options = {}) {
    // Minimum confidence required to generate a trade signal (0.0 to 1.0)
    // User can adjust this — higher = more selective, fewer trades
    this.minConfidence = options.minConfidence || 0.60;

    // Pattern lengths to analyze — shorter patterns have more data,
    // longer patterns are more specific but rarer
    this.patternLengths = options.patternLengths || [3, 4, 5, 6, 7, 8];

    // Minimum number of historical occurrences required before trusting
    // a pattern — prevents acting on patterns seen only 1-2 times
    this.minOccurrences = options.minOccurrences || 5;

    // Exponential decay factor for recency weighting
    // 0.9990 = moderate decay, good balance of recency vs history
    // 0.9995 = slower decay, more weight to older data
    // 0.9980 = faster decay, strongly favors recent patterns
    this.recencyDecay = options.recencyDecay || 0.9990;

    // Body size threshold for Doji detection (as fraction of open price)
    // Candles with body smaller than this are classified as Doji
    this.dojiThreshold = options.dojiThreshold || 0.00001;

    // Cache for last analysis result
    this.lastAnalysis = null;
    this.lastAnalysisTime = 0;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Classify a single candle as Bullish, Bearish, or Doji
  // ────────────────────────────────────────────────────────────────────────
  classifyCandle(candle) {
    const bodySize = Math.abs(candle.close - candle.open);
    const threshold = candle.open * this.dojiThreshold;

    if (bodySize <= threshold) return 'D'; // Doji
    if (candle.close > candle.open) return 'B'; // Bullish
    return 'R'; // Bearish
  }

  // ────────────────────────────────────────────────────────────────────────
  // Convert candle array to type string array ['B', 'R', 'B', 'B', ...]
  // ────────────────────────────────────────────────────────────────────────
  classifyAll(candles) {
    return candles.map(c => this.classifyCandle(c));
  }

  // ────────────────────────────────────────────────────────────────────────
  // Main analysis method
  //
  // Input:  Array of closed candles (up to 5000, most recent last)
  // Output: {
  //   shouldTrade:  boolean  — true if confidence meets threshold
  //   direction:    'CALLE' | 'PUTE' | null
  //   confidence:   number   — 0.0 to 1.0
  //   reason:       string   — human-readable explanation
  //   details:      object   — per-pattern-length breakdown
  // }
  // ────────────────────────────────────────────────────────────────────────
  analyze(closedCandles) {
    // Validate minimum data requirement
    const maxPatLen = Math.max(...this.patternLengths);
    if (closedCandles.length < maxPatLen + 20) {
      return {
        shouldTrade: false,
        direction: null,
        confidence: 0,
        reason: `Insufficient candle history: ${closedCandles.length} candles ` +
                `(need at least ${maxPatLen + 20} for reliable analysis)`,
        details: {}
      };
    }

    // Classify all candles into types
    const types = this.classifyAll(closedCandles);
    const totalCandles = types.length;

    // Analyze each pattern length
    const patternResults = [];

    for (const patLen of this.patternLengths) {
      // Skip if not enough data for this pattern length
      if (totalCandles < patLen + 1) continue;

      // Extract the current pattern (most recent patLen candles)
      const currentPattern = types.slice(totalCandles - patLen);

      // Search history for matching patterns and record what followed
      let bullishWeightedSum = 0;
      let bearishWeightedSum = 0;
      let dojiWeightedSum = 0;
      let totalWeight = 0;
      let rawOccurrences = 0;

      // Search from the beginning up to (but not including) the current
      // pattern position. The last valid start index is
      // totalCandles - patLen - 1, because we need patLen chars for the
      // pattern plus 1 char for the "next candle" that followed it.
      const searchEnd = totalCandles - patLen - 1;

      for (let i = 0; i <= searchEnd; i++) {
        // Check if pattern at position i matches current pattern
        let matches = true;
        for (let j = 0; j < patLen; j++) {
          if (types[i + j] !== currentPattern[j]) {
            matches = false;
            break;
          }
        }

        if (matches) {
          // Pattern matched — what candle came next?
          const nextType = types[i + patLen];

          // Calculate recency weight
          // Distance = how far back from the most recent searchable position
          const distanceFromPresent = searchEnd - i;
          const weight = Math.pow(this.recencyDecay, distanceFromPresent);

          rawOccurrences++;
          totalWeight += weight;

          if (nextType === 'B') {
            bullishWeightedSum += weight;
          } else if (nextType === 'R') {
            bearishWeightedSum += weight;
          } else {
            dojiWeightedSum += weight;
          }
        }
      }

      // Skip patterns with insufficient occurrences
      if (rawOccurrences < this.minOccurrences) continue;

      // Calculate weighted probabilities (excluding Doji from decision)
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

    // No qualifying patterns found
    if (patternResults.length === 0) {
      return {
        shouldTrade: false,
        direction: null,
        confidence: 0,
        reason: 'No patterns met minimum occurrence threshold ' +
                `(need >= ${this.minOccurrences} matches per pattern)`,
        details: { patternResults: [] }
      };
    }

    // ──────────────────────────────────────────────────────────────────────
    // WEIGHTED CONSENSUS VOTING
    //
    // Each qualifying pattern casts a vote weighted by:
    //   sqrt(occurrences) — statistical significance (diminishing returns)
    //   sqrt(patternLength) — longer = more specific
    //
    // The vote is distributed proportionally between bullish and bearish
    // based on the pattern's probability
    // ──────────────────────────────────────────────────────────────────────

    let consensusBullScore = 0;
    let consensusBearScore = 0;
    let totalVoteWeight = 0;

    for (const r of patternResults) {
      const voteWeight = Math.sqrt(r.rawOccurrences) * Math.sqrt(r.patternLength);
      consensusBullScore += voteWeight * r.bullProb;
      consensusBearScore += voteWeight * r.bearProb;
      totalVoteWeight += voteWeight;
    }

    // Normalize to get final probabilities
    const finalBullProb = consensusBullScore / totalVoteWeight;
    const finalBearProb = consensusBearScore / totalVoteWeight;
    const consensusConfidence = Math.max(finalBullProb, finalBearProb);
    const consensusDirection = finalBullProb > finalBearProb ? 'CALLE' : 'PUTE';

    // ──────────────────────────────────────────────────────────────────────
    // BEST INDIVIDUAL PATTERN
    // Sort by confidence to find the single strongest pattern
    // ──────────────────────────────────────────────────────────────────────

    patternResults.sort((a, b) => b.confidence - a.confidence);
    const bestPattern = patternResults[0];

    // ──────────────────────────────────────────────────────────────────────
    // FINAL DECISION LOGIC
    //
    // Strategy: Use consensus direction, but require that the best
    // individual pattern also agrees. If they disagree, use the higher
    // confidence of the two only if it meets threshold.
    //
    // This prevents scenarios where weak scattered signals create a
    // consensus that contradicts a strong specific pattern.
    // ──────────────────────────────────────────────────────────────────────

    let finalDirection;
    let finalConfidence;
    let decisionMethod;

    // Count how many patterns agree with consensus direction
    const agreeingPatterns = patternResults.filter(
      r => r.direction === consensusDirection
    );
    const agreementRatio = agreeingPatterns.length / patternResults.length;

    if (bestPattern.direction === consensusDirection) {
      // Best pattern and consensus agree — strong signal
      // Use the higher of consensus confidence and best pattern confidence
      finalDirection = consensusDirection;
      finalConfidence = Math.max(consensusConfidence, bestPattern.confidence);
      decisionMethod = 'CONSENSUS+BEST_AGREE';
    } else if (bestPattern.confidence >= this.minConfidence &&
               bestPattern.confidence > consensusConfidence + 0.05) {
      // Best pattern disagrees but is significantly stronger — follow best
      finalDirection = bestPattern.direction;
      finalConfidence = bestPattern.confidence;
      decisionMethod = 'BEST_OVERRIDES_CONSENSUS';
    } else if (consensusConfidence >= this.minConfidence &&
               agreementRatio >= 0.5) {
      // Consensus has enough agreement and confidence — follow consensus
      finalDirection = consensusDirection;
      finalConfidence = consensusConfidence;
      decisionMethod = 'CONSENSUS_MAJORITY';
    } else {
      // Conflicting signals — use whichever has higher confidence
      if (bestPattern.confidence > consensusConfidence) {
        finalDirection = bestPattern.direction;
        finalConfidence = bestPattern.confidence;
        decisionMethod = 'BEST_PATTERN_FALLBACK';
      } else {
        finalDirection = consensusDirection;
        finalConfidence = consensusConfidence;
        decisionMethod = 'CONSENSUS_FALLBACK';
      }
    }

    const shouldTrade = finalConfidence >= this.minConfidence;

    // Build reason string
    let reason;
    if (shouldTrade) {
      const dirLabel = finalDirection === 'CALLE' ? 'BULLISH' : 'BEARISH';
      reason = `Pattern analysis predicts ${dirLabel} with ` +
               `${(finalConfidence * 100).toFixed(1)}% confidence ` +
               `(threshold: ${(this.minConfidence * 100).toFixed(1)}%) | ` +
               `Method: ${decisionMethod} | ` +
               `${agreeingPatterns.length}/${patternResults.length} patterns agree | ` +
               `Best: L${bestPattern.patternLength} "${bestPattern.pattern}" ` +
               `(${(bestPattern.confidence * 100).toFixed(1)}%, ${bestPattern.rawOccurrences} matches)`;
    } else {
      reason = `Confidence ${(finalConfidence * 100).toFixed(1)}% below threshold ` +
               `${(this.minConfidence * 100).toFixed(1)}% | ` +
               `Method: ${decisionMethod} | ` +
               `${agreeingPatterns.length}/${patternResults.length} patterns agree | ` +
               `Best: L${bestPattern.patternLength} "${bestPattern.pattern}" ` +
               `(${(bestPattern.confidence * 100).toFixed(1)}%, ${bestPattern.rawOccurrences} matches)`;
    }

    // Cache result
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

  // ────────────────────────────────────────────────────────────────────────
  // Get a compact summary string for logging
  // ────────────────────────────────────────────────────────────────────────
  getAnalysisSummary(result) {
    if (!result || !result.details || !result.details.patternResults) {
      return 'No analysis available';
    }

    const lines = [];
    lines.push(`📊 Pattern Analysis Summary (${result.details.totalCandlesAnalyzed} candles):`);
    lines.push(`   Decision: ${result.details.decisionMethod}`);

    for (const r of result.details.patternResults) {
      const dirIcon = r.direction === 'CALLE' ? '🟢' : '🔴';
      const dirLabel = r.direction === 'CALLE' ? 'BULL' : 'BEAR';
      lines.push(
        `   L${r.patternLength} "${r.pattern}" → ${dirIcon} ${dirLabel} ` +
        `${(r.confidence * 100).toFixed(1)}% ` +
        `(${r.rawOccurrences} matches, wt: ${r.decisiveWeight})`
      );
    }

    const cons = result.details.consensus;
    const consDir = cons.direction === 'CALLE' ? 'BULL' : 'BEAR';
    lines.push(
      `   Consensus: ${consDir} ${(cons.confidence * 100).toFixed(1)}% ` +
      `(${(cons.agreementRatio * 100).toFixed(0)}% agreement)`
    );

    if (result.shouldTrade) {
      const finalDir = result.direction === 'CALLE' ? 'HIGHER 🟢' : 'LOWER 🔴';
      lines.push(
        `   ✅ SIGNAL: ${finalDir} @ ${(result.confidence * 100).toFixed(1)}% confidence`
      );
    } else {
      lines.push(
        `   ⏳ NO TRADE: ${(result.confidence * 100).toFixed(1)}% < ` +
        `${(this.minConfidence * 100).toFixed(1)}% threshold`
      );
    }

    return lines.join('\n');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  apiToken: 'Dz2V2KvRf4Uukt3',
  appId:    '1089',

  symbol:        'stpRNG',
  tickDuration:  54, // seconds (trade duration)
  initialStake:  0.35,
  investmentAmount: 100,

  martingaleMultiplier:  1.48,
  maxMartingaleLevel:    3,
  afterMaxLoss:          'continue',
  continueExtraLevels:   6,
  extraLevelMultipliers: [2.0, 2.0, 2.1, 2.1, 2.2, 2.3],

  autoCompounding:    true,
  compoundPercentage: 0.35,

  stopLoss:   100,
  takeProfit: 10000,

  // ── Pattern Analysis Configuration ──────────────────────────────────────
  // Adjust these to tune the pattern recognition system
  pattern: {
    // Minimum confidence to place a trade (0.0 to 1.0)
    // 0.60 = 60% — the bot will only trade when it's at least 60% sure
    // Increase for fewer but higher-quality trades
    // Decrease for more frequent trading with lower accuracy
    minConfidence: 0.65,

    // Pattern lengths to analyze
    // Shorter (3-4): more matches, less specific
    // Longer (7-8): fewer matches, more specific
    patternLengths: [2, 3, 4, 5, 6, 7],  //[3, 4, 5, 6, 7, 8]

    // Minimum historical occurrences of a pattern before trusting it
    minOccurrences: 5,

    // Recency decay factor — how much to weight recent vs old patterns
    // 0.9990 = moderate (recommended for Step Index)
    // 0.9995 = slower decay, more historical weight
    // 0.9980 = faster decay, strongly favors recent data
    recencyDecay: 0.9990,

    // Doji threshold as fraction of open price
    dojiThreshold: 0.00001,
  },

  // ── Candle History Configuration ────────────────────────────────────────
  candle: {
    // Number of historical candles to maintain in memory
    maxCandles: 5000,

    // Number of candles to load on startup
    // Set to 5000 to get full history for pattern analysis
    loadCount: 5000,

    // Candle granularity in seconds (60 = 1-minute candles)
    granularity: 60,
  },

  telegramToken:   '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
  telegramChatId:  '752497117',
  telegramEnabled: true,
};

// ══════════════════════════════════════════════════════════════════════════════
// FILE PATHS
// ══════════════════════════════════════════════════════════════════════════════

const STATE_FILE          = path.join(__dirname, 'ST-grid-state-pattern-v200001.json');
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
          skippedCandles:      bot.skippedCandles,
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
    // Merge nested pattern config
    this.config.pattern = { ...DEFAULT_CONFIG.pattern, ...(config.pattern || {}) };
    this.config.candle = { ...DEFAULT_CONFIG.candle, ...(config.candle || {}) };

    // ── Pattern Analyzer ────────────────────────────────────────────────────
    this.patternAnalyzer = new CandlePatternAnalyzer({
      minConfidence:  this.config.pattern.minConfidence,
      patternLengths: this.config.pattern.patternLengths,
      minOccurrences: this.config.pattern.minOccurrences,
      recencyDecay:   this.config.pattern.recencyDecay,
      dojiThreshold:  this.config.pattern.dojiThreshold,
    });

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

    // ── Candle tracking (upgraded to 5000) ──────────────────────────────────
    this.assetState = {
      candles: [],
      closedCandles: [],
      currentFormingCandle: null,
      lastProcessedCandleOpenTime: null,
      candlesLoaded: false
    };
    this.candleConfig = {
      GRANULARITY: this.config.candle.granularity,
      MAX_CANDLES_STORED: this.config.candle.maxCandles,
      CANDLES_TO_LOAD: this.config.candle.loadCount
    };

    // ── Pattern-gated trading + recovery logic ──────────────────────────────
    // canTrade:       true = bot is allowed to place a trade right now
    // inRecoveryMode: true = we're in a loss recovery chain (martingale)
    //
    // Flow (UPGRADED with pattern analysis):
    //   1. New candle detected → run pattern analysis on 5000 candle history
    //   2. If confidence >= threshold → set direction from analysis, canTrade = true
    //   3. If confidence < threshold → skip this candle, canTrade = false
    //   4. Trade placed → canTrade = false
    //   5. WIN  → reset level, inRecoveryMode = false, wait for new candle
    //   6. LOSS → increment level, inRecoveryMode = true, wait for NEW candle,
    //            then re-analyze before placing recovery trade
    //            (recovery trades MUST also pass pattern confidence check)
    this.canTrade       = false;
    this.inRecoveryMode = false;

    // Track consecutive skipped candles for monitoring
    this.skippedCandles = 0;

    // ── Session control ──────────────────────────────────────────────────────
    this.endOfDay         = false;
    this.isWinTrade       = false;
    this.hasStartedOnce   = false;
    this._autoSaveInterval = null;

    this._processedContracts = new Set();
    this._maxProcessedCache  = 200;

    // ── Hourly Telegram stats ─────────────────────────────────────────────────
    this.hourlyStats = {
      trades: 0, wins: 0, losses: 0, pnl: 0,
      skippedCandles: 0,
      lastHour: new Date().getHours()
    };

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
    this.skippedCandles      = t.skippedCandles      || 0;
    this.inRecoveryMode      = t.inRecoveryMode      || false;
    // Always wait for pattern analysis — don't auto-trade on restore
    this.canTrade            = false;
    this.hasStartedOnce      = true;
    this.log(
      `State restored | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `P&L: $${this.totalProfit.toFixed(2)} | Level: ${this.currentGridLevel} | ` +
      `Recovery: ${this.inRecoveryMode ? 'YES' : 'NO'} | ` +
      `Skipped: ${this.skippedCandles}`,
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
  // PATTERN ANALYSIS — Centralized method
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Runs pattern analysis on the current closed candle history.
  // Called whenever a new candle closes, for both fresh trades and recovery.
  //
  // Returns the analysis result object from CandlePatternAnalyzer.analyze()
  // ══════════════════════════════════════════════════════════════════════════

  _runPatternAnalysis() {
    if (!this.assetState.candlesLoaded) {
      this.log('⏳ Candle history not loaded yet — cannot analyze patterns', 'warning');
      return {
        shouldTrade: false,
        direction: null,
        confidence: 0,
        reason: 'Candle history not loaded yet',
        details: {}
      };
    }

    const closedCandles = this.assetState.closedCandles;

    if (closedCandles.length < 30) {
      this.log(`⏳ Only ${closedCandles.length} closed candles — need more data`, 'warning');
      return {
        shouldTrade: false,
        direction: null,
        confidence: 0,
        reason: `Only ${closedCandles.length} closed candles available`,
        details: {}
      };
    }

    const startTime = Date.now();
    const result = this.patternAnalyzer.analyze(closedCandles);
    const elapsed = Date.now() - startTime;

    // Log the analysis summary
    const summary = this.patternAnalyzer.getAnalysisSummary(result);
    console.log(summary);
    this.log(`Analysis completed in ${elapsed}ms`, 'info');

    return result;
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
      this._sendTelegram(
        `❌ <b>${this.config.symbol} Max reconnect attempts reached</b>\n` +
        `Final P&L: $${this.totalProfit.toFixed(2)}`
      );
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1),
      30000
    );

    this.log(
      `Reconnecting in ${(delay / 1000).toFixed(1)}s ` +
      `(attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})…`
    );

    this._sendTelegram(
      `⚠️ <b>${this.config.symbol} CONNECTION LOST — RECONNECTING</b>\n` +
      `Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
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
        if (this.ws.readyState === WebSocket.OPEN ||
            this.ws.readyState === WebSocket.CONNECTING) {
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
      this.log(
        `Cannot send (not connected): ${JSON.stringify(request).substring(0, 80)}`,
        'warning'
      );
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
    }, 5000);
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

  _handleMessage(msg) {
    if (msg.error) {
      this._handleApiError(msg);
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':              this._onAuthorize(msg);           break;
      case 'balance':                this._onBalance(msg);             break;
      case 'proposal':               this._onProposal(msg);           break;
      case 'buy':                    this._onBuy(msg);                 break;
      case 'proposal_open_contract': this._onContract(msg);           break;
      case 'ohlc':                   this._handleOHLC(msg.ohlc);      break;
      case 'candles':                this._handleCandlesHistory(msg);  break;
      case 'ping':                   break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CANDLE HANDLER — PATTERN-BASED NEW CANDLE DETECTION
  // ══════════════════════════════════════════════════════════════════════════
  //
  // KEY UPGRADE: Instead of trading based on the previous candle's direction,
  // the bot now runs full pattern analysis on every new candle and only
  // trades when confidence exceeds the threshold.
  //
  // For RECOVERY trades: the bot waits for the NEXT candle to close,
  // re-analyzes patterns with fresh data, and only places the recovery
  // trade if the pattern still shows high confidence. This means recovery
  // trades are also pattern-gated — the bot won't blindly martingale into
  // uncertain conditions.
  //
  // If confidence is too low, the candle is skipped. The martingale level
  // is preserved so when a confident signal finally appears, the recovery
  // stake is correct.
  // ══════════════════════════════════════════════════════════════════════════

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
        // Add to closed candles history
        this.assetState.closedCandles.push(closedCandle);

        // Trim to max candles (5000)
        if (this.assetState.closedCandles.length > this.candleConfig.MAX_CANDLES_STORED) {
          this.assetState.closedCandles = this.assetState.closedCandles.slice(
            -this.candleConfig.MAX_CANDLES_STORED
          );
        }

        this.assetState.lastProcessedCandleOpenTime = closedCandle.open_time;

        const closeTime = new Date(closedCandle.epoch * 1000).toISOString();
        const candleType = closedCandle.close > closedCandle.open
          ? 'BULLISH' : closedCandle.close < closedCandle.open
          ? 'BEARISH' : 'DOJI';
        const candleEmoji = candleType === 'BULLISH' ? '🟢'
          : candleType === 'BEARISH' ? '🔴' : '⚪';

        this.log(
          `${symbol} ${candleEmoji} NEW CANDLE [${closeTime}] ${candleType}: ` +
          `O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} ` +
          `L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)} | ` +
          `History: ${this.assetState.closedCandles.length} candles`
        );

        // ════════════════════════════════════════════════════════════════
        // PATTERN-BASED TRADE TRIGGER (replaces simple candle direction)
        // ════════════════════════════════════════════════════════════════
        // On every new candle:
        //   1. Run pattern analysis on full 5000-candle history
        //   2. If confidence >= threshold AND bot is not mid-trade:
        //      - Set direction from pattern analysis
        //      - Set canTrade = true
        //      - Place trade
        //   3. If confidence < threshold:
        //      - Skip this candle
        //      - Increment skippedCandles counter
        //      - If in recovery, log warning about waiting
        // ════════════════════════════════════════════════════════════════

        if (this.running && !this.tradeInProgress) {
          const analysis = this._runPatternAnalysis();

          if (analysis.shouldTrade) {
            // Pattern has high confidence — execute trade
            this.currentDirection = analysis.direction;
            this.canTrade = true;
            this.skippedCandles = 0;

            const modeLabel = this.inRecoveryMode
              ? `⚡ RECOVERY L${this.currentGridLevel}`
              : '🕯️ FRESH TRADE';

            this.log(
              `${modeLabel} | Pattern says ` +
              `${analysis.direction === 'PUTE' ? 'HIGHER 🟢' : 'LOWER 🔴'} ` +
              `@ ${(analysis.confidence * 100).toFixed(1)}% confidence | ` +
              `Stake: $${this.calculateStake(this.currentGridLevel).toFixed(2)}`,
              'success'
            );

            if (analysis.details.consensus.agreementRatio < 0.99) {
              this.log(
                `   ⚠️ Consensus agreement at ${analysis.details.consensus.agreementRatio}` +
                `${(analysis.details.consensus.agreementRatio * 100).toFixed(0)}% — ` +
                `trade signal is less certain`
              );
              return;
            }

            this._sendTelegram(
              `${DEFAULT_CONFIG.symbol} Trade Open\n` +
              `Pattern signal: ${analysis.direction === 'PUTE' ? 'HIGHER 🟢' : 'LOWER 🔴'}\n` +
                `Confidence: ${(analysis.confidence * 100).toFixed(1)}%\n` +
                `Stake: $${this.calculateStake(this.currentGridLevel).toFixed(2)}\n` +
                `Duration: ${DEFAULT_CONFIG.tickDuration}\n` +
                `Investment: $${this.investmentRemaining.toFixed(2)}`
            );

            // Place trade
            this._placeTrade(analysis.direction);

          } else {
            // Confidence too low — skip this candle
            this.canTrade = false;
            this.skippedCandles++;
            this.hourlyStats.skippedCandles++;

            const skipMsg = this.inRecoveryMode
              ? `⏳ RECOVERY WAITING — Pattern confidence too low ` +
                `(${(analysis.confidence * 100).toFixed(1)}% < ` +
                `${(this.config.pattern.minConfidence * 100).toFixed(1)}%) | ` +
                `L${this.currentGridLevel} | Skipped: ${this.skippedCandles} candles | ` +
                `Next stake: $${this.calculateStake(this.currentGridLevel).toFixed(2)}`
              : `⏳ SKIPPED — Pattern confidence too low ` +
                `(${(analysis.confidence * 100).toFixed(1)}% < ` +
                `${(this.config.pattern.minConfidence * 100).toFixed(1)}%) | ` +
                `Skipped: ${this.skippedCandles} candles`;

            this.log(skipMsg, 'warning');

            // Alert via Telegram if skipping too many candles during recovery
            if (this.inRecoveryMode && this.skippedCandles % 10 === 0) {
              this._sendTelegram(
                `⏳ <b>${this.config.symbol} Recovery Waiting</b>\n` +
                `Skipped ${this.skippedCandles} candles — no confident pattern\n` +
                `Grid Level: L${this.currentGridLevel}\n` +
                `Next stake: $${this.calculateStake(this.currentGridLevel).toFixed(2)}\n` +
                `Last confidence: ${(analysis.confidence * 100).toFixed(1)}%\n` +
                `Threshold: ${(this.config.pattern.minConfidence * 100).toFixed(1)}%`
              );
            }
          }
        } else if (this.tradeInProgress) {
          this.log(
            `📊 NEW CANDLE — trade in progress, will analyze on next candle`,
            'info'
          );
        }
      }
    }

    // Update the forming candle
    this.assetState.currentFormingCandle = incomingCandle;

    // Update candles array
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
      const openTime = Math.floor(
        (c.epoch - this.candleConfig.GRANULARITY) / this.candleConfig.GRANULARITY
      ) * this.candleConfig.GRANULARITY;
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
    this.assetState.candlesLoaded = true;

    this.log(
      `📊 Loaded ${candles.length} historical candles for ${symbol} ` +
      `(target: ${this.candleConfig.CANDLES_TO_LOAD})`,
      'success'
    );

    // Run initial pattern analysis to log market state
    const initialAnalysis = this._runPatternAnalysis();
    if (initialAnalysis.shouldTrade) {
      this.log(
        `📊 Initial analysis: Would trade ` +
        `${initialAnalysis.direction === 'CALLE' ? 'HIGHER' : 'LOWER'} ` +
        `@ ${(initialAnalysis.confidence * 100).toFixed(1)}% — ` +
        `waiting for next new candle to confirm`,
        'info'
      );
    } else {
      this.log(
        `📊 Initial analysis: No confident signal yet ` +
        `(${(initialAnalysis.confidence * 100).toFixed(1)}%) — ` +
        `waiting for new candle`,
        'info'
      );
    }

    // Always wait for the next new candle to start trading
    // This ensures we trade on fresh data, not stale history
    this.canTrade = false;
    this.log(`⏳ Waiting for next new candle to start pattern-based trading…`, 'info');
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

    if (msg.msg_type === 'buy' || msg.msg_type === 'proposal') {
      this.log('Trade error — releasing lock and retrying on next candle', 'warning');
      this._clearAllWatchdogTimers();
      this.tradeInProgress  = false;
      this.pendingTradeInfo = null;
      this.currentContractId = null;

      // Don't retry immediately — wait for next candle and re-analyze
      // The pattern might have changed or the error could recur
      this.canTrade = false;
      this.log(
        '⏳ Will re-analyze and retry on next new candle',
        'info'
      );
    }
  }

  // ── authorize ─────────────────────────────────────────────────────────────
  _onAuthorize(msg) {
    if (msg.error) {
      this.log(`Authentication failed: ${msg.error.message}`, 'error');
      this._sendTelegram(
        `❌ <b>${this.config.symbol} Authentication Failed:</b> ${msg.error.message}`
      );
      return;
    }

    this.isAuthorized = true;
    this.accountId    = msg.authorize.loginid;
    this.balance      = msg.authorize.balance;
    this.currency     = msg.authorize.currency;

    this.log(
      `Authorized ✅ | Account: ${this.accountId} | ` +
      `Balance: ${this.currency} ${this.balance.toFixed(2)}`,
      'success'
    );

    this._send({ balance: 1, subscribe: 1 });

    // Subscribe to candles — this loads 5000 candles + live OHLC stream
    this._subscribeToCandles(this.config.symbol);

    if (!this.hasStartedOnce) {
      this._sendTelegram(
        `✅ <b>${this.config.symbol} Pattern Bot Connected</b>\n` +
        `Account: ${this.accountId}\n` +
        `Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
        `Pattern Confidence Threshold: ${(this.config.pattern.minConfidence * 100).toFixed(0)}%\n` +
        `Candle History: ${this.config.candle.loadCount} candles\n` +
        `Recency Decay: ${this.config.pattern.recencyDecay}`
      );
      setTimeout(() => { if (!this.running) this.start(); }, 300);

    } else {
      this.tradeInProgress = false;
      this.log(
        `🔄 Reconnected — resuming | L${this.currentGridLevel} | ` +
        `Recovery: ${this.inRecoveryMode ? 'YES' : 'NO'} | ` +
        `Waiting for candle data + pattern analysis`,
        'success'
      );

      this._sendTelegram(
        `🔄 <b>${this.config.symbol} Reconnected — Resuming</b>\n` +
        `Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
        `Grid Level: ${this.currentGridLevel}\n` +
        `Recovery Mode: ${this.inRecoveryMode ? 'YES ⚡' : 'NO'}\n` +
        `Loading ${this.config.candle.loadCount} candles for pattern analysis…`
      );

      if (this.currentContractId) {
        this.log(`Re-subscribing to open contract ${this.currentContractId}…`);
        this.tradeInProgress = true;
        this._send({
          proposal_open_contract: 1,
          contract_id: this.currentContractId,
          subscribe: 1
        });
        this._startTradeWatchdog(this.currentContractId, 5000);
      } else {
        // Wait for candle data to load, then pattern analysis on next candle
        this.canTrade = false;
        this.log(
          'No open contract — waiting for candle history + pattern signal',
          'success'
        );
      }
    }
  }

  // ── balance ───────────────────────────────────────────────────────────────
  _onBalance(msg) {
    this.balance = msg.balance.balance;
    // this.log(`Balance updated: ${this.currency} ${this.balance.toFixed(2)}`);
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
    this.investmentRemaining = Math.max(
      0,
      Number((this.investmentRemaining - b.buy_price).toFixed(2))
    );

    this.log(
      `Contract opened: ${b.contract_id} | Stake: $${b.buy_price.toFixed(2)} | ` +
      `Investment left: $${this.investmentRemaining.toFixed(2)}`
    );

    this._startTradeWatchdog(b.contract_id);
    this._send({
      proposal_open_contract: 1,
      contract_id: b.contract_id,
      subscribe: 1
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONTRACT RESULT — WIN/LOSS HANDLER
  // ══════════════════════════════════════════════════════════════════════════
  //
  // KEY UPGRADE FOR PATTERN-BASED TRADING:
  //
  // ON WIN:
  //   - Reset grid level to 0
  //   - Set inRecoveryMode = false
  //   - Set canTrade = false → wait for next candle + pattern analysis
  //
  // ON LOSS:
  //   - Increment grid level (martingale)
  //   - Set inRecoveryMode = true
  //   - Set canTrade = false → wait for NEXT CANDLE to close
  //   - When next candle closes, _handleOHLC runs pattern analysis
  //   - Only place recovery trade if pattern confidence >= threshold
  //   - Direction comes from pattern analysis, NOT from alternation
  //
  // This is the key difference from the original bot: recovery trades
  // are NOT placed immediately after a loss. Instead, the bot waits for
  // the next candle, re-analyzes patterns with fresh data, and only
  // trades if the pattern is confident. This prevents blind martingale
  // into uncertain market conditions.
  // ══════════════════════════════════════════════════════════════════════════

  _onContract(msg) {
    const c = msg.proposal_open_contract;
    if (!c.is_sold) return;

    const contractId = String(c.contract_id);
    if (this.currentContractId && contractId !== String(this.currentContractId)) {
      this.log(
        `⚠️ Ignoring stale contract result: ${contractId} ` +
        `(current: ${this.currentContractId})`,
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
      this._sendTelegram(
        `🛑 <b>${this.config.symbol} STOP LOSS REACHED</b>\n` +
        `Final P&L: $${this.totalProfit.toFixed(2)}`
      );
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }
    if (this.totalProfit >= this.config.takeProfit) {
      this.log(`🎉 TAKE PROFIT hit! P&L: $${this.totalProfit.toFixed(2)}`, 'success');
      this._sendTelegram(
        `🎉 <b>${this.config.symbol} TAKE PROFIT REACHED</b>\n` +
        `Final P&L: $${this.totalProfit.toFixed(2)}`
      );
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
      this.investmentRemaining = Number(
        (this.investmentRemaining + payout).toFixed(2)
      );

      const wasRecovery = this.inRecoveryMode;

      if (cfg.autoCompounding) {
        this.baseStake = Math.max(
          this.investmentRemaining * cfg.compoundPercentage / 100,
          0.35
        );
        this.log(
          `🎯 WIN +$${profit.toFixed(2)}` +
          `${wasRecovery ? ' | RECOVERY COMPLETE! 🎉' : ''} | ` +
          `L${this.currentGridLevel} → RESET | ` +
          `Investment: $${this.investmentRemaining.toFixed(2)} | ` +
          `New base: $${this.baseStake.toFixed(2)}`,
          'success'
        );
      } else {
        this.log(
          `🎯 WIN +$${profit.toFixed(2)}` +
          `${wasRecovery ? ' | FULL RECOVERY! 🎉' : ''} | ` +
          `Investment: $${this.investmentRemaining.toFixed(2)} | Reset → L0`,
          'success'
        );
      }

      // ── RESET after win ─────────────────────────────────────────────
      this.currentGridLevel = 0;
      this.inRecoveryMode   = false;
      this.canTrade         = false;  // WAIT for next candle + pattern
      this.skippedCandles   = 0;

      this.log(
        `⏳ Waiting for next new candle + pattern analysis before trading…`,
        'info'
      );

      this._sendTelegramTradeResult(isWin, profit);

    // ══════════════════════════════════════════════════════════════════════
    // LOSS HANDLING — PATTERN-AWARE RECOVERY
    // ══════════════════════════════════════════════════════════════════════
    } else {
      const nextLevel = this.currentGridLevel + 1;
      const absoluteMax = cfg.afterMaxLoss === 'continue'
        ? cfg.maxMartingaleLevel + cfg.continueExtraLevels
        : cfg.maxMartingaleLevel;

      this.currentGridLevel = nextLevel;

      // ── ENTER recovery mode ─────────────────────────────────────────
      // KEY: canTrade = false — we do NOT trade immediately
      // Instead we wait for the next candle to close, then re-analyze
      this.inRecoveryMode = true;
      this.canTrade       = false;  // Wait for next candle + re-analysis

      if (nextLevel > absoluteMax) {
        this.log(
          `🛑 ABSOLUTE CEILING L${absoluteMax} reached — stopping`,
          'error'
        );
        this._sendTelegram(
          `🛑 <b>${this.config.symbol} ABSOLUTE MAX LEVEL REACHED (L${absoluteMax})</b>\n` +
          `Investment remaining: $${this.investmentRemaining.toFixed(2)}\n` +
          `Total P&L: $${this.totalProfit.toFixed(2)}`
        );
        shouldContinue      = false;
        this.inRecoveryMode = false;
        this.canTrade       = false;

      } else if (nextLevel > cfg.maxMartingaleLevel && cfg.afterMaxLoss === 'reset') {
        this.currentGridLevel = 0;
        this.inRecoveryMode   = false;
        this.canTrade         = false;
        this.log(
          `🔄 MAX LEVEL — Resetting to L0 (reset mode) — ` +
          `waiting for pattern signal`,
          'warning'
        );

      } else {
        const nextStake = this.calculateStake(this.currentGridLevel);
        this.log(
          `📉 LOSS -$${Math.abs(profit).toFixed(2)} | ` +
          `Grid L${this.currentGridLevel}/${absoluteMax} | ` +
          `Next stake: $${nextStake.toFixed(2)} | ` +
          `⏳ Waiting for next candle + pattern re-analysis`,
          'warning'
        );
      }

      this._sendTelegramTradeResult(isWin, profit);

      if (shouldContinue) {
        const nextStake = this.calculateStake(this.currentGridLevel);
        if (nextStake > this.investmentRemaining) {
          this.log(
            `🛑 INSUFFICIENT INVESTMENT: next $${nextStake.toFixed(2)} > ` +
            `remaining $${this.investmentRemaining.toFixed(2)}`,
            'error'
          );
          shouldContinue      = false;
          this.inRecoveryMode = false;
          this.canTrade       = false;
        } else if (nextStake > this.balance) {
          this.log(
            `🛑 INSUFFICIENT BALANCE: next $${nextStake.toFixed(2)} > ` +
            `balance $${this.balance.toFixed(2)}`,
            'error'
          );
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
    // NEXT TRADE SCHEDULING — ALL TRADES WAIT FOR PATTERN ANALYSIS
    // ══════════════════════════════════════════════════════════════════════
    // Unlike the original bot, we do NOT schedule an immediate recovery
    // trade after a loss. Instead:
    //   - canTrade = false (set above for both win and loss)
    //   - _handleOHLC will detect the next new candle
    //   - _runPatternAnalysis will analyze with fresh data
    //   - Only if confidence >= threshold will the trade be placed
    //   - Direction comes from the pattern, not from alternation logic
    //
    // This means during a martingale recovery, the bot might skip several
    // candles waiting for a confident pattern. The grid level is preserved
    // so the recovery stake is correct when a signal finally appears.
    // ══════════════════════════════════════════════════════════════════════

    if (this.running) {
      if (isWin) {
        this.log(
          `⏳ WIN — Next trade on next candle with confident pattern`,
          'success'
        );
      } else {
        this.log(
          `⏳ LOSS — Recovery L${this.currentGridLevel} waiting for next candle ` +
          `+ pattern re-analysis (confidence must be ≥ ` +
          `${(this.config.pattern.minConfidence * 100).toFixed(0)}%)`,
          'warning'
        );
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TRADE WATCHDOG — DETECT STUCK CONTRACTS
  // ══════════════════════════════════════════════════════════════════════════

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

      if (contractId && this.isConnected && this.isAuthorized) {
        this.log(`🔍 Polling contract ${contractId} for current status…`);
        this._send({
          proposal_open_contract: 1,
          contract_id: contractId,
          subscribe: 1
        });

        this.tradeWatchdogPollTimer = setTimeout(() => {
          if (!this.tradeInProgress) return;
          this.log(
            `🚨 WATCHDOG: Poll timed out — contract ${contractId} still unresolved ` +
            `— force-releasing lock`,
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

  // ══════════════════════════════════════════════════════════════════════════
  // SUBSCRIBE TO CANDLES (5000 history)
  // ══════════════════════════════════════════════════════════════════════════

  _subscribeToCandles(symbol) {
    this.log(
      `📊 Subscribing to ${this.candleConfig.GRANULARITY}s candles for ${symbol} ` +
      `(loading ${this.candleConfig.CANDLES_TO_LOAD} candles)...`
    );

    // Load historical candles (up to 5000)
    this._send({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: this.candleConfig.CANDLES_TO_LOAD,
      end: 'latest',
      start: 1,
      style: 'candles',
      granularity: this.candleConfig.GRANULARITY
    });

    // Subscribe to live OHLC updates
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

  // ══════════════════════════════════════════════════════════════════════════
  // RECOVER FROM STUCK TRADE
  // ══════════════════════════════════════════════════════════════════════════

  _recoverStuckTrade(reason) {
    this._clearAllWatchdogTimers();

    const contractId  = this.currentContractId;
    const stakeInfo   = this.pendingTradeInfo;
    const openSeconds = this.tradeStartTime
      ? Math.round((Date.now() - this.tradeStartTime) / 1000)
      : '?';

    this.log(
      `🚨 STUCK TRADE RECOVERY [${reason}] | Contract: ${contractId} | ` +
      `Open for: ${openSeconds}s | Level: ${this.currentGridLevel}`,
      'error'
    );

    if (stakeInfo && stakeInfo.stake > 0) {
      this.investmentRemaining = Number(
        (this.investmentRemaining + stakeInfo.stake).toFixed(2)
      );
      this.log(
        `💰 Stake $${stakeInfo.stake.toFixed(2)} returned to pool → ` +
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

    // Wait for next candle + pattern analysis (don't retry immediately)
    this.canTrade = false;

    this.log(
      `⏳ Will re-analyze and retry on next new candle`,
      'warning'
    );

    this._sendTelegram(
      `⚠️ <b>${this.config.symbol} STUCK TRADE RECOVERED [${reason}]</b>\n` +
      `Contract: ${contractId || 'unknown'}\n` +
      `Grid Level: ${this.currentGridLevel}\n` +
      `Recovery Mode: ${this.inRecoveryMode ? 'YES' : 'NO'}\n` +
      `Action: waiting for next candle + pattern analysis`
    );

    StatePersistence.save(this);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PLACE TRADE
  // ══════════════════════════════════════════════════════════════════════════

  _placeTrade(directions) {
    if (!this.isAuthorized) {
      this.log('Not authorized — cannot trade', 'error');
      return;
    }
    if (!this.running)        return;
    if (this.tradeInProgress) {
      this.log('Trade already in progress…', 'warning');
      return;
    }

    // ── PATTERN GATE CHECK ────────────────────────────────────────────────
    if (!this.canTrade) {
      this.log(
        '⏳ Pattern analysis has not signaled — waiting for next candle…',
        'info'
      );
      return;
    }

    const stake     = this.calculateStake(this.currentGridLevel);

    // const direction = this.currentDirection;
    const direction = directions === 'CALLE' ? 'PUTE' : 'CALLE';
    const label     = direction === 'CALLE' ? 'HIGHER' : 'LOWER';
    const tradeType = this.inRecoveryMode
      ? `⚡ RECOVERY L${this.currentGridLevel}`
      : '🕯️ PATTERN TRADE';

    // Get confidence info from last analysis
    const lastAnalysis = this.patternAnalyzer.lastAnalysis;
    const confidenceStr = lastAnalysis
      ? `${(lastAnalysis.confidence * 100).toFixed(1)}%`
      : 'N/A';

    if (stake > this.investmentRemaining) {
      this.log(
        `Insufficient investment: stake $${stake} > ` +
        `remaining $${this.investmentRemaining.toFixed(2)}`,
        'error'
      );
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }
    if (stake > this.balance) {
      this.log(
        `Insufficient balance: stake $${stake} > ` +
        `balance $${this.balance.toFixed(2)}`,
        'error'
      );
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }

    this.log(
      `📊 ${tradeType} | ${label} | Stake: $${stake} | ` +
      `Confidence: ${confidenceStr} | ` +
      `Investment left: $${this.investmentRemaining.toFixed(2)}`
    );

    // After placing, prevent double-trading until next candle
    this.canTrade = false;

    this.tradeInProgress  = true;
    this.pendingTradeInfo = {
      id:         Date.now(),
      time:       new Date().toISOString(),
      direction,
      stake,
      gridLevel:  this.currentGridLevel,
      confidence: confidenceStr,
    };

    this._send({
      proposal:      1,
      amount:        stake,
      basis:         'stake',
      contract_type: direction,
      currency:      this.currency,
      duration:      this.config.tickDuration,
      duration_unit: 's', //t=ticks, s=seconds, m=minutes, h=hours 
      symbol:        this.config.symbol,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // START / STOP
  // ══════════════════════════════════════════════════════════════════════════

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
        `Investment $${this.config.investmentAmount} exceeds ` +
        `balance $${this.balance.toFixed(2)}`,
        'error'
      );
      return false;
    }

    const cfg = this.config;

    if (cfg.autoCompounding) {
      this.baseStake = Math.max(
        cfg.investmentAmount * cfg.compoundPercentage / 100,
        0.35
      );
      this.log(
        `💰 Auto-compounding ON: ${cfg.compoundPercentage}% of ` +
        `$${cfg.investmentAmount} = $${this.baseStake.toFixed(2)} base stake`
      );
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
    this.skippedCandles        = 0;

    // Initialize pattern-gated trading
    this.inRecoveryMode = false;
    this.canTrade       = false;  // Wait for first candle + pattern analysis

    this.log(
      `🚀 ${this.config.symbol} Pattern Recognition Bot STARTED!`,
      'success'
    );
    this.log(
      `💵 Investment: $${cfg.investmentAmount} | Base: $${this.baseStake.toFixed(2)} | ` +
      `Mult: ${cfg.martingaleMultiplier}x | Max: L${cfg.maxMartingaleLevel} | ` +
      `${cfg.tickDuration}s`
    );
    this.log(
      `🧠 Pattern Settings: Confidence ≥ ${(cfg.pattern.minConfidence * 100).toFixed(0)}% | ` +
      `Lengths: [${cfg.pattern.patternLengths.join(',')}] | ` +
      `Min Occurrences: ${cfg.pattern.minOccurrences} | ` +
      `Recency Decay: ${cfg.pattern.recencyDecay}`
    );
    this.log(
      `📊 Candle History: ${cfg.candle.maxCandles} candles | ` +
      `Granularity: ${cfg.candle.granularity}s`
    );
    if (cfg.afterMaxLoss === 'continue') {
      this.log(
        `🔄 Extended recovery: up to ` +
        `L${cfg.maxMartingaleLevel + cfg.continueExtraLevels} with custom multipliers`
      );
    }
    this.log(
      `📈 Trading mode: New Candle → Pattern Analysis → ` +
      `Trade if confident (≥${(cfg.pattern.minConfidence * 100).toFixed(0)}%)`
    );
    this.log(
      `🔄 Recovery mode: Loss → Wait for candle → Re-analyze → ` +
      `Trade only if confident`
    );
    this.log(`⏳ Waiting for first new candle to start trading…`);

    this._sendTelegram(
      `🚀 <b>${this.config.symbol} Pattern Bot STARTED</b>\n` +
      `💵 Investment: $${cfg.investmentAmount}\n` +
      `📊 Base Stake: $${this.baseStake.toFixed(2)}\n` +
      `🔢 Multiplier: ${cfg.martingaleMultiplier}x | Max Level: ${cfg.maxMartingaleLevel}\n` +
      `⏱ Duration: ${cfg.tickDuration} seconds\n` +
      `💰 Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
      `🧠 Pattern Confidence: ≥${(cfg.pattern.minConfidence * 100).toFixed(0)}%\n` +
      `📊 History: ${cfg.candle.maxCandles} candles\n` +
      `⚡ Recency Decay: ${cfg.pattern.recencyDecay}\n` +
      `🕯️ Mode: Pattern-gated trading + pattern-gated recovery`
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
    this._sendTelegram(
      `🛑 <b>${this.config.symbol} Bot stopped</b>\n` +
      `P&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades} | ` +
      `Skipped candles: ${this.skippedCandles}`
    );
    this._logSummary();
  }

  emergencyStop() {
    this.running         = false;
    this.tradeInProgress = false;
    this.inRecoveryMode  = false;
    this.canTrade        = false;
    this._clearAllWatchdogTimers();
    this.log('🚨 EMERGENCY STOP — All activity halted!', 'error');
    this._sendTelegram(
      `🚨 <b>${this.config.symbol} EMERGENCY STOP TRIGGERED</b>\n` +
      `P&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`
    );
    this._logSummary();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARY LOG
  // ══════════════════════════════════════════════════════════════════════════

  _logSummary() {
    const wr = this.totalTrades > 0
      ? ((this.wins / this.totalTrades) * 100).toFixed(1)
      : '0.0';
    this.log(
      `📊 SUMMARY | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `Win rate: ${wr}% | P&L: $${this.totalProfit.toFixed(2)} | ` +
      `Recovered: $${this.totalRecovered.toFixed(2)} | ` +
      `Skipped candles: ${this.skippedCandles}`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TELEGRAM
  // ══════════════════════════════════════════════════════════════════════════

  async _sendTelegram(message) {
    if (!this.telegramBot || !this.config.telegramEnabled) return;
    try {
      await this.telegramBot.sendMessage(
        this.config.telegramChatId, message, { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error(`[Telegram] send failed: ${e.message}`);
    }
  }

  _sendTelegramTradeResult(isWin, profit) {
    const wr      = this.totalTrades > 0
      ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0';
    const pnlStr  = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(2);

    const lastAnalysis = this.patternAnalyzer.lastAnalysis;
    const confStr = lastAnalysis
      ? `${(lastAnalysis.confidence * 100).toFixed(1)}%`
      : 'N/A';
    const methodStr = lastAnalysis?.details?.decisionMethod || 'N/A';

    let nextAction;
    if (isWin) {
      nextAction = '⏳ Waiting for candle + pattern analysis';
    } else {
      nextAction =
        `⏳ Recovery L${this.currentGridLevel} — waiting for candle + re-analysis\n` +
        `  Next stake: $${this.calculateStake(this.currentGridLevel).toFixed(2)}\n` +
        `  Required confidence: ≥${(this.config.pattern.minConfidence * 100).toFixed(0)}%`;
    }

    this._sendTelegram(
      `${isWin ? '✅ WIN' : '❌ LOSS'} <b>— ${this.config.symbol} Pattern Bot</b>\n\n` +
      `${isWin ? '🟢' : '🔴'} <b>P&L:</b> ${pnlStr}\n` +
      `🧠 <b>Pattern Confidence:</b> ${confStr} (${methodStr})\n` +
      `📊 <b>Grid Level:</b> ${isWin ? 'RESET → L0' : `L${this.currentGridLevel}`}\n` +
      `🎯 <b>Next:</b> ${nextAction}\n\n` +
      `📈 <b>Session Stats:</b>\n` +
      `  Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses}\n` +
      `  Win Rate: ${wr}%\n` +
      `  Daily P&L: ${(this.totalProfit >= 0 ? '+' : '')}$${this.totalProfit.toFixed(2)}\n` +
      `  Investment: $${this.investmentRemaining.toFixed(2)}\n` +
      `  Skipped candles: ${this.skippedCandles}\n\n` +
      `⏰ ${new Date().toLocaleTimeString()}`
    );
  }

  async _sendHourlySummary() {
    const s      = this.hourlyStats;
    const wr     = (s.wins + s.losses) > 0
      ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0';
    const pnlStr = (s.pnl >= 0 ? '+' : '') + '$' + s.pnl.toFixed(2);

    await this._sendTelegram(
      `⏰ <b>${this.config.symbol} Pattern Bot — Hourly Summary</b>\n\n` +
      `📊 <b>Last Hour:</b>\n` +
      `  Trades: ${s.trades} | Wins: ${s.wins} | Losses: ${s.losses}\n` +
      `  Win Rate: ${wr}%\n` +
      `  ${s.pnl >= 0 ? '🟢' : '🔴'} P&L: ${pnlStr}\n` +
      `  Skipped candles: ${s.skippedCandles}\n\n` +
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
      `  Total Skipped Candles: ${this.skippedCandles}\n\n` +
      `🧠 <b>Pattern Config:</b>\n` +
      `  Confidence Threshold: ${(this.config.pattern.minConfidence * 100).toFixed(0)}%\n` +
      `  Recency Decay: ${this.config.pattern.recencyDecay}\n` +
      `  History Size: ${this.assetState.closedCandles.length} candles\n\n` +
      `⏰ ${new Date().toLocaleString()}`
    );

    this.log('📱 Telegram hourly summary sent');
    this.hourlyStats = {
      trades: 0, wins: 0, losses: 0, pnl: 0,
      skippedCandles: 0,
      lastHour: new Date().getHours()
    };
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

    this.log(
      `📱 Hourly Telegram summaries scheduled ` +
      `(first in ${Math.ceil(msUntilNext / 60000)} min)`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TIME SCHEDULER
  // ══════════════════════════════════════════════════════════════════════════

  startTimeScheduler() {
    setInterval(() => {
      const now = new Date();
      const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
      const gmt1 = new Date(utcMs + (1 * 60 * 60 * 1000));
      const hours = gmt1.getHours();
      const minutes = gmt1.getMinutes();

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

    this.log('📅 Time scheduler started');
  }

  _resetDailyStats() {
    this.tradeInProgress = false;
    this.isWinTrade      = false;
    this.inRecoveryMode  = false;
    this.canTrade        = false;
    this.skippedCandles  = 0;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TERMINAL BANNER
// ══════════════════════════════════════════════════════════════════════════════

function printBanner() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║   GRID MARTINGALE BOT — Pattern Recognition Edition v2.0              ║');
  console.log('║   Strategy: 5000-candle pattern analysis + recency-weighted voting    ║');
  console.log('║   CALLE/PUTE | Confidence-gated | Pattern-gated recovery              ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝\n');
  console.log('Flow:');
  console.log('  New Candle → Pattern Analysis (5000 candles) → Confident? → Trade');
  console.log('  New Candle → Pattern Analysis → Not confident? → Skip & Wait');
  console.log('  Loss → Wait for Next Candle → Re-analyze → Confident? → Recovery Trade');
  console.log('  Loss → Wait for Next Candle → Re-analyze → Not confident? → Keep Waiting');
  console.log('  Win → Reset Level → Wait for Next Candle + Pattern\n');
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
