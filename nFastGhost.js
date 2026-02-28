#!/usr/bin/env node

/**
 * ============================================================================
 * ROMANIAN GHOST - BLACK FIBONACCI 9.1
 * Deriv Digit Differ Trading Bot
 * ============================================================================
 * 
 * Strategy: Identifies overrepresented digits in recent tick history,
 * places "Differs" contracts on the most frequent digit (expecting mean
 * reversion), uses modified Fibonacci stake recovery, and employs
 * ghost (virtual) trades for entry confirmation.
 * 
 * DISCLAIMER: Trading involves substantial risk. This bot is for 
 * educational purposes. Use on demo accounts first. Past performance
 * does not guarantee future results.
 * ============================================================================
 */

const WebSocket = require('ws');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Optional Telegram (set env or in config to enable)
let TelegramBot = null;
try {
    TelegramBot = require('node-telegram-bot-api');
} catch (e) {
    // node-telegram-bot-api not installed
}

const STATE_FILE = path.join(__dirname, 'nFastGhost-state0001.json');

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
    // Deriv API Configuration
    app_id: '1089',  // Default Deriv app_id (register your own at api.deriv.com)
    endpoint: 'wss://ws.derivws.com/websockets/v3',

    // Account
    api_token: '0P94g4WdSrSrzir', // Will be set via CLI or environment variable

    // Market Selection
    // Options: 'R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'
    symbol: 'R_75',

    // Contract Configuration
    contract_type: 'DIGITDIFF',
    duration: 1,
    duration_unit: 't', // ticks
    currency: 'USD',

    // Romanian Ghost Strategy Parameters
    strategy: {
        // Tick analysis window - how many recent ticks to analyze
        analysis_window: 25,
        // Deep history length for repeat-cycle analysis
        history_length: 5000,
        // Short window emphasis (most recent ticks)
        short_window: 50,

        // Minimum ticks to collect before starting analysis
        min_ticks_before_start: 30,

        // Ghost (virtual) trade confirmation
        ghost_trades_required: 3,        // Virtual trades needed before real entry
        ghost_win_rate_threshold: 0.90,  // 60% ghost win rate to confirm entry

        // Digit frequency threshold - digit must appear this % to be considered "hot"
        frequency_threshold: 0.28,  // 28% (7+ out of 25 ticks)

        // Consecutive same-digit threshold for extra confidence
        consecutive_threshold: 2,

        // Cool-down after losses
        cooldown_ticks_after_loss_streak: 10,
        loss_streak_cooldown_trigger: 3,
    },

    // Black Fibonacci 9.1 Stake Management
    fibonacci: {
        base_stake: 0.61,              // Base stake in USD
        sequence: [1, 1, 2, 3, 5, 8, 13, 21, 34, 55],
        multiplier: 0.91,              // The "9.1" ratio (0.91x fibonacci value)
        max_fib_level: 7,              // Max level in fibonacci sequence (0-indexed)
        reset_on_win: true,            // Reset to level 0 on win
        step_back_on_win: 2,           // Alternative: step back N levels on win (if reset_on_win is false)
    },

    // Risk Management
    risk: {
        max_daily_loss: 100.00,         // Stop bot if daily loss exceeds this
        max_daily_trades: 200,         // Maximum trades per day
        max_consecutive_losses: 8,     // Stop bot after this many consecutive losses
        take_profit: 30.00,            // Stop bot after this much profit
        min_balance: 10.00,            // Don't trade if balance below this
        max_stake: 50.00,              // Never stake more than this
    },

    // Logging
    log_level: 'INFO', // DEBUG, INFO, WARN, ERROR
    show_tick_data: true,
    show_digit_analysis: true,

    // Telegram (optional; also set via TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID env)
    telegram_bot_token: '8218636914:AAGvaKFh8MT769-_9eOEiU4XKufL0aHRhZ4',
    telegram_chat_id: '752497117',
};

// ============================================================================
// UTILS
// ============================================================================
function getLastDigitFromQuote(quote, asset) {
    const quoteString = quote.toString();
    const [, fractionalPart = ''] = quoteString.split('.');

    // Match multi-asset logic from nliveMulti.js
    if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
        return fractionalPart.length >= 4 ? parseInt(fractionalPart[3], 10) : 0;
    } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset)) {
        return fractionalPart.length >= 3 ? parseInt(fractionalPart[2], 10) : 0;
    } else {
        return fractionalPart.length >= 2 ? parseInt(fractionalPart[1], 10) : 0;
    }
}

// ============================================================================
// LOGGER
// ============================================================================
class Logger {
    static LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

    static log(level, ...args) {
        if (Logger.LEVELS[level] >= Logger.LEVELS[CONFIG.log_level]) {
            const timestamp = new Date().toISOString().substr(11, 12);
            const prefix = `[${timestamp}] [${level}]`;
            if (level === 'ERROR') {
                console.error(prefix, ...args);
            } else if (level === 'WARN') {
                console.warn(prefix, ...args);
            } else {
                console.log(prefix, ...args);
            }
        }
    }

    static debug(...args) { Logger.log('DEBUG', ...args); }
    static info(...args) { Logger.log('INFO', ...args); }
    static warn(...args) { Logger.log('WARN', ...args); }
    static error(...args) { Logger.log('ERROR', ...args); }
}

// ============================================================================
// DIGIT ANALYZER - Core Romanian Ghost Analysis Engine
// ============================================================================
class DigitAnalyzer {
    constructor(windowSize) {
        this.windowSize = windowSize;
        this.tickHistory = [];
        this.digitHistory = [];
        this.digitFrequency = new Array(10).fill(0);
        this.lastDigitTransitions = {}; // digit -> [next digits]
        this.patterns = [];
    }

    addTick(tick) {
        const asset = tick.symbol || CONFIG.symbol;
        const lastDigit = getLastDigitFromQuote(tick.quote, asset);

        this.tickHistory.push({
            epoch: tick.epoch,
            quote: tick.quote,
            symbol: asset,
            digit: lastDigit,
        });

        this.digitHistory.push(lastDigit);

        // Maintain window size
        if (this.digitHistory.length > this.windowSize * 2) {
            this.digitHistory = this.digitHistory.slice(-this.windowSize * 2);
        }
        if (this.tickHistory.length > this.windowSize * 3) {
            this.tickHistory = this.tickHistory.slice(-this.windowSize * 3);
        }

        this._updateFrequency();
        this._updateTransitions(lastDigit);

        return lastDigit;
    }

    _updateFrequency() {
        this.digitFrequency = new Array(10).fill(0);
        const window = this.getRecentDigits();
        window.forEach(d => this.digitFrequency[d]++);
    }

    _updateTransitions(currentDigit) {
        if (this.digitHistory.length < 2) return;
        const prevDigit = this.digitHistory[this.digitHistory.length - 2];
        if (!this.lastDigitTransitions[prevDigit]) {
            this.lastDigitTransitions[prevDigit] = [];
        }
        this.lastDigitTransitions[prevDigit].push(currentDigit);

        // Keep transitions manageable
        if (this.lastDigitTransitions[prevDigit].length > 100) {
            this.lastDigitTransitions[prevDigit] =
                this.lastDigitTransitions[prevDigit].slice(-50);
        }
    }

    getRecentDigits(n = null) {
        const size = n || this.windowSize;
        return this.digitHistory.slice(-size);
    }

    getLastDigit() {
        return this.digitHistory.length > 0
            ? this.digitHistory[this.digitHistory.length - 1]
            : null;
    }

    /**
     * Get digit frequency analysis for the current window
     */
    getFrequencyAnalysis() {
        const window = this.getRecentDigits();
        const total = window.length;
        if (total === 0) return null;

        const analysis = [];
        for (let d = 0; d < 10; d++) {
            const count = this.digitFrequency[d];
            analysis.push({
                digit: d,
                count: count,
                frequency: count / total,
                deviation: (count / total) - 0.10, // deviation from expected 10%
            });
        }

        // Sort by frequency descending
        analysis.sort((a, b) => b.frequency - a.frequency);
        return analysis;
    }

    /**
     * Find the "hot" digit - the most overrepresented digit
     */
    getHotDigit() {
        const analysis = this.getFrequencyAnalysis();
        if (!analysis) return null;
        return analysis[0]; // Most frequent digit
    }

    /**
     * Find the "ghost" digit - the least appearing or absent digit
     */
    getGhostDigit() {
        const analysis = this.getFrequencyAnalysis();
        if (!analysis) return null;
        return analysis[analysis.length - 1]; // Least frequent
    }

    /**
     * Get consecutive count of the same digit at the end
     */
    getConsecutiveCount(digit = null) {
        const digits = this.getRecentDigits();
        if (digits.length === 0) return 0;

        const targetDigit = digit !== null ? digit : digits[digits.length - 1];
        let count = 0;
        for (let i = digits.length - 1; i >= 0; i--) {
            if (digits[i] === targetDigit) count++;
            else break;
        }
        return count;
    }

    /**
     * Calculate transition probability: given current digit, probability of next digit
     */
    getTransitionProbability(fromDigit, toDigit) {
        const transitions = this.lastDigitTransitions[fromDigit];
        if (!transitions || transitions.length === 0) return 0.1; // default uniform

        const count = transitions.filter(d => d === toDigit).length;
        return count / transitions.length;
    }

    /**
     * Romanian Ghost specific: Calculate "ghost score" for each digit
     * Higher score = better candidate for Differs contract
     */
    getGhostScores() {
        const analysis = this.getFrequencyAnalysis();
        if (!analysis) return null;

        const lastDigit = this.getLastDigit();
        const scores = {};

        for (const entry of analysis) {
            const d = entry.digit;
            let score = 0;

            // Factor 1: Frequency deviation (higher frequency = higher score for differs)
            score += entry.deviation * 100;

            // Factor 2: Consecutive appearance penalty
            const consec = this.getConsecutiveCount(d);
            if (consec >= 2) score += consec * 5;

            // Factor 3: Transition probability from last digit
            if (lastDigit !== null) {
                const tranProb = this.getTransitionProbability(lastDigit, d);
                score += (tranProb - 0.1) * 50; // deviation from uniform
            }

            // Factor 4: Recent recency bonus (appeared in last 3 ticks)
            const recent3 = this.getRecentDigits(3);
            const recentCount = recent3.filter(x => x === d).length;
            score += recentCount * 3;

            // Factor 5: Pattern detection - alternating pattern
            if (this.digitHistory.length >= 4) {
                const last4 = this.getRecentDigits(4);
                if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] === d) {
                    score += 8; // Alternating pattern detected
                }
            }

            scores[d] = {
                digit: d,
                score: parseFloat(score.toFixed(4)),
                frequency: entry.frequency,
                count: entry.count,
                consecutive: consec,
            };
        }

        // Sort by score descending
        const sorted = Object.values(scores).sort((a, b) => b.score - a.score);
        return sorted;
    }

    /**
     * Check if we have enough data for analysis
     */
    hasEnoughData() {
        return this.digitHistory.length >= CONFIG.strategy.min_ticks_before_start;
    }

    getTickCount() {
        return this.digitHistory.length;
    }

    /**
     * Get recent raw ticks (epoch, quote, digit)
     */
    getRecentTicks(n = 10) {
        return this.tickHistory.slice(-n);
    }

    /**
     * Get a formatted summary for logging
     */
    getSummary() {
        const analysis = this.getFrequencyAnalysis();
        if (!analysis) return 'No data';

        const window = this.getRecentDigits();
        const digitDisplay = window.slice(-15).join(',');
        const topDigit = analysis[0];
        const botDigit = analysis[analysis.length - 1];

        return `Last15:[${digitDisplay}] | Hot:${topDigit.digit}(${(topDigit.frequency * 100).toFixed(0)}%) Ghost:${botDigit.digit}(${(botDigit.frequency * 100).toFixed(0)}%)`;
    }
}

// ============================================================================
// REPEAT CYCLE ANALYZER - Short-window (50) saturation learning over 5000 ticks
// Focuses ONLY on short-cycle repetition behaviour, learning a saturation level
// from historical 50-tick batches, then triggering when current short cycle
// peaks near that learned level and starts to exhaust.
// ============================================================================
class RepeatCycleAnalyzer {
    constructor(config) {
        this.maxHistory = config.history_length || 5000; // e.g. 5000 ticks
        this.shortWindow = config.short_window || 50;    // 50-tick short cycle

        // Historical batch learning parameters
        this.nonRepMaxRepeat = 0.15;    // "very low repeat" regime for next batch
        this.minBatchesForLearning = 10;

        this.digits = [];
        this.repeats = []; // 1 when same as previous digit, else 0
        this.tickCount = 0;

        // Learned saturation level from history (short-cycle repeat rate 0–1)
        this.learnedSaturation = null;

        // Track recent short-cycle values to detect peaks / exhaustion
        this.prevShort = null;
        this.currShort = null;

        // Hold the last exhaustion signal for a few ticks so score/active don't reset next tick
        this.signalHoldTicks = 1;
        this.signalHold = null; // { score, details, ticksLeft }
    }

    _pushDigit(digit) {
        if (this.digits.length > 0) {
            const prev = this.digits[this.digits.length - 1];
            const rep = prev === digit ? 1 : 0;
            this.repeats.push(rep);
            if (this.repeats.length > this.maxHistory) {
                this.repeats.shift();
            }
        }

        this.digits.push(digit);
        if (this.digits.length > this.maxHistory) {
            this.digits.shift();
        }

        this.tickCount++;
    }

    _windowMeanFromEnd(arr, n, offsetFromEnd = 0) {
        if (arr.length === 0) return 0;
        const end = arr.length - offsetFromEnd;
        const start = Math.max(0, end - n);
        if (start >= end) return 0;
        let sum = 0;
        for (let i = start; i < end; i++) sum += arr[i];
        return sum / (end - start);
    }

    _fullMean(arr) {
        if (arr.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += arr[i];
        return sum / arr.length;
    }

    /**
     * Learn a typical saturation level from 50-tick batches over history.
     * For each 50-tick batch b, look at the NEXT 50-tick batch b+1. If b+1
     * has very low repeat (< nonRepMaxRepeat), treat batch b's short-rate
     * as a "saturation before non-repeat" sample.
     */
    _updateLearnedSaturation() {
        const w = this.shortWindow;
        if (this.repeats.length < w * 3) return; // need enough data

        const nBatches = Math.floor(this.repeats.length / w);
        if (nBatches < this.minBatchesForLearning) return;

        const samples = [];
        for (let b = 0; b < nBatches - 1; b++) {
            const start = b * w;
            const mid = start + w;
            const end = mid + w;

            let sumCur = 0, sumNext = 0;
            for (let i = start; i < mid; i++) sumCur += this.repeats[i];
            for (let i = mid; i < end; i++) sumNext += this.repeats[i];
            const rateCur = sumCur / w;
            const rateNext = sumNext / w;

            if (rateNext <= this.nonRepMaxRepeat) {
                samples.push(rateCur);
            }
        }

        if (samples.length === 0) return;

        // Use median of saturation samples for robustness
        samples.sort((a, b) => a - b);
        const midIdx = Math.floor(samples.length / 2);
        this.learnedSaturation =
            samples.length % 2 === 1
                ? samples[midIdx]
                : (samples[midIdx - 1] + samples[midIdx]) / 2;
    }

    addDigit(digit) {
        this._pushDigit(digit);

        if (this.repeats.length < this.shortWindow + 5) {
            return;
        }

        // Update learned saturation from history occasionally
        if (this.tickCount % this.shortWindow === 0) {
            this._updateLearnedSaturation();
        }

        // Update short-cycle estimates for peak / exhaustion detection
        const shortNow = this._windowMeanFromEnd(this.repeats, this.shortWindow, 0);
        this.prevShort = this.currShort;
        this.currShort = shortNow;

        // We also keep a snapshot of other context for logging
        const longRepeat = this._fullMean(this.repeats);
        const midRepeat = this._windowMeanFromEnd(this.repeats, this.shortWindow * 2, 0);

        this.lastSnapshot = {
            shortRepeat: this.currShort,
            midRepeat,
            longRepeat,
        };
    }

    /**
     * Get signal based purely on short-cycle saturation and exhaustion.
     * active == true when:
     *  - we have a learned saturation level,
     *  - previous short-cycle was at/above that level,
     *  - current short-cycle has started to fall (exhaustion of repeats).
     */
    getSignal(currentDigit) {
        if (!this.lastSnapshot || this.repeats.length < this.shortWindow + 5) {
            this.signalHold = null;
            return { active: false, score: 0, details: null };
        }

        const { shortRepeat, midRepeat, longRepeat } = this.lastSnapshot;
        const sat = this.learnedSaturation;

        const baseDetails = {
            currentDigit,
            shortRepeat,
            midRepeat,
            longRepeat,
            learnedSaturation: sat != null ? sat : 0,
            // For log compatibility (always numeric)
            lastOversatShortRate: sat != null ? sat : 0,
            lastOversatLongRate: longRepeat,
            ticks_since_oversat: 0,
        };

        // Return held signal so score/active don't reset on the very next tick
        if (this.signalHold && this.signalHold.ticksLeft > 0) {
            this.signalHold.ticksLeft--;
            return {
                active: true,
                score: this.signalHold.score,
                details: { ...this.signalHold.details, ...baseDetails },
            };
        }
        this.signalHold = null;

        if (sat == null || this.prevShort == null) {
            return {
                active: false,
                score: 0,
                details: {
                    ...baseDetails,
                    reason: 'saturation_not_learned_yet',
                },
            };
        }

        const prevAtOrAboveSat = this.prevShort >= sat;
        const nowBelowPrev = shortRepeat < this.prevShort;
        const notTooLow = shortRepeat >= sat * 0.5; // still in elevated zone

        const exhaustion = prevAtOrAboveSat && nowBelowPrev && notTooLow;

        if (!exhaustion) {
            return {
                active: false,
                score: 0,
                details: {
                    ...baseDetails,
                    reason: 'no_exhaustion',
                },
            };
        }

        // Score: how far above saturation the previous peak was, and how gently we're coming down
        const peakExcess = Math.max(0, this.prevShort - sat);      // above saturation
        const drop = Math.max(0, this.prevShort - shortRepeat);    // how much we've fallen

        // Normalize to a 0–1 scale (assume at most 20pp above and 20pp drop)
        const normPeak = Math.min(1, peakExcess / 0.20);
        const normDrop = Math.min(1, drop / 0.20);
        const score = Math.round(((normPeak * 0.6) + (normDrop * 0.4)) * 100);

        // Hold this signal for a few ticks so it doesn't reset to 0 on the next tick
        this.signalHold = {
            score,
            details: { ...baseDetails, reason: 'short_cycle_exhaustion' },
            ticksLeft: this.signalHoldTicks,
        };

        return {
            active: true,
            score,
            details: this.signalHold.details,
        };
    }
}


// ============================================================================
// FIBONACCI STAKE MANAGER - Black Fibonacci 9.1
// ============================================================================
class FibonacciStakeManager {
    constructor() {
        this.currentLevel = 0;
        this.sequence = CONFIG.fibonacci.sequence;
        this.baseStake = CONFIG.fibonacci.base_stake;
        this.multiplier = CONFIG.fibonacci.multiplier;
        this.maxLevel = CONFIG.fibonacci.max_fib_level;
        this.tradeHistory = [];
    }

    /**
     * Get current stake based on Fibonacci level
     */
    getCurrentStake() {
        const fibValue = this.sequence[Math.min(this.currentLevel, this.sequence.length - 1)];
        let stake = this.baseStake * fibValue * this.multiplier;

        // Apply max stake limit
        stake = Math.min(stake, CONFIG.risk.max_stake);

        // Round to 2 decimal places
        return parseFloat(stake.toFixed(2));
    }

    /**
     * Record a win - reset or step back
     */
    onWin(profit) {
        this.tradeHistory.push({ result: 'win', profit, level: this.currentLevel });

        if (CONFIG.fibonacci.reset_on_win) {
            this.currentLevel = 0;
        } else {
            this.currentLevel = Math.max(0, this.currentLevel - CONFIG.fibonacci.step_back_on_win);
        }

        Logger.info(`📈 WIN! Profit: $${profit.toFixed(2)} | Fib reset to level ${this.currentLevel}`);
    }

    /**
     * Record a loss - move up Fibonacci sequence
     */
    onLoss(loss) {
        this.tradeHistory.push({ result: 'loss', loss, level: this.currentLevel });

        if (this.currentLevel < this.maxLevel) {
            this.currentLevel++;
        }

        Logger.info(`📉 LOSS! Loss: $${loss.toFixed(2)} | Fib up to level ${this.currentLevel}`);
    }

    /**
     * Get consecutive losses count
     */
    getConsecutiveLosses() {
        let count = 0;
        for (let i = this.tradeHistory.length - 1; i >= 0; i--) {
            if (this.tradeHistory[i].result === 'loss') count++;
            else break;
        }
        return count;
    }

    /**
     * Check if max consecutive losses reached
     */
    isMaxLossesReached() {
        return this.getConsecutiveLosses() >= CONFIG.risk.max_consecutive_losses;
    }

    reset() {
        this.currentLevel = 0;
    }

    getSummary() {
        const stake = this.getCurrentStake();
        const consLosses = this.getConsecutiveLosses();
        return `Fib Level: ${this.currentLevel}/${this.maxLevel} | Stake: $${stake} | ConsLoss: ${consLosses}`;
    }
}

// ============================================================================
// TRADE TRACKER - Session Statistics
// ============================================================================
class TradeTracker {
    constructor() {
        this.sessionStart = Date.now();
        this.trades = [];
        this.totalProfit = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.maxDrawdown = 0;
        this.peakProfit = 0;
        this.startBalance = 0;
        this.currentBalance = 0;
        this.restoredTradeCount = 0; // set by loadState for persistence
    }

    recordTrade(trade) {
        this.trades.push({
            ...trade,
            timestamp: Date.now(),
            runningProfit: this.totalProfit,
        });

        if (trade.win) {
            this.totalWins++;
            this.totalProfit += trade.profit;
        } else {
            this.totalLosses++;
            this.totalProfit -= trade.loss;
        }

        // Track drawdown
        if (this.totalProfit > this.peakProfit) {
            this.peakProfit = this.totalProfit;
        }
        const drawdown = this.peakProfit - this.totalProfit;
        if (drawdown > this.maxDrawdown) {
            this.maxDrawdown = drawdown;
        }
    }

    getDailyLoss() {
        return Math.abs(Math.min(0, this.totalProfit));
    }

    getTradeCount() {
        return this.trades.length + (this.restoredTradeCount || 0);
    }

    getWinRate() {
        const total = this.totalWins + this.totalLosses;
        if (total === 0) return 0;
        return this.totalWins / total;
    }

    shouldStopTrading() {
        // Check daily loss limit
        if (this.getDailyLoss() >= CONFIG.risk.max_daily_loss) {
            Logger.warn(`🛑 Daily loss limit reached: $${this.getDailyLoss().toFixed(2)}`);
            return 'DAILY_LOSS_LIMIT';
        }

        // Check daily trade limit
        if (this.getTradeCount() >= CONFIG.risk.max_daily_trades) {
            Logger.warn(`🛑 Daily trade limit reached: ${this.getTradeCount()}`);
            return 'DAILY_TRADE_LIMIT';
        }

        // Check take profit
        if (this.totalProfit >= CONFIG.risk.take_profit) {
            Logger.info(`🎯 Take profit reached: $${this.totalProfit.toFixed(2)}`);
            return 'TAKE_PROFIT';
        }

        // Check min balance
        if (this.currentBalance > 0 && this.currentBalance < CONFIG.risk.min_balance) {
            Logger.warn(`🛑 Balance too low: $${this.currentBalance.toFixed(2)}`);
            return 'MIN_BALANCE';
        }

        return null;
    }

    printSummary() {
        const runtime = ((Date.now() - this.sessionStart) / 1000 / 60).toFixed(1);
        console.log('\n' + '='.repeat(60));
        console.log('📊 SESSION SUMMARY - Romanian Ghost Black Fibonacci 9.1');
        console.log('='.repeat(60));
        console.log(`Runtime:          ${runtime} minutes`);
        console.log(`Total Trades:     ${this.getTradeCount()}`);
        console.log(`Wins:             ${this.totalWins}`);
        console.log(`Losses:           ${this.totalLosses}`);
        console.log(`Win Rate:         ${(this.getWinRate() * 100).toFixed(1)}%`);
        console.log(`Total Profit:     $${this.totalProfit.toFixed(2)}`);
        console.log(`Max Drawdown:     $${this.maxDrawdown.toFixed(2)}`);
        console.log(`Start Balance:    $${this.startBalance.toFixed(2)}`);
        console.log(`Current Balance:  $${this.currentBalance.toFixed(2)}`);
        console.log('='.repeat(60) + '\n');
    }
}

// ============================================================================
// MAIN BOT - Romanian Ghost Black Fibonacci 9.1
// ============================================================================
class RomanianGhostBot {
    constructor(apiToken) {
        this.apiToken = apiToken;
        this.ws = null;
        this.isConnected = false;
        this.isAuthorized = false;
        this.isRunning = false;

        // Core components
        this.analyzer = new DigitAnalyzer(CONFIG.strategy.analysis_window);
        this.repeatCycleAnalyzer = new RepeatCycleAnalyzer(CONFIG.strategy);
        this.stakeManager = new FibonacciStakeManager();
        this.tracker = new TradeTracker();

        // State management
        this.state = 'INITIALIZING'; // INITIALIZING, COLLECTING, TRADING, COOLDOWN, STOPPED
        this.historyLoaded = false;
        this.cooldownTicksRemaining = 0;
        this.pendingContract = null;
        this.contractInProgress = false;
        this.tickSubscriptionId = null;
        this.requestId = 1;

        // Rate limiting
        this.lastTradeTime = 0;
        this.minTradeCooldown = 1500; // ms between trades

        // Tick logging
        this.lastTickLogTime = 0;

        // Hourly stats for Telegram
        this.hourly = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        this.sessionStartTime = Date.now();

        // Telegram (optional)
        this.telegramBot = null;
        if (TelegramBot && CONFIG.telegram_bot_token && CONFIG.telegram_chat_id) {
            this.telegramBot = new TelegramBot(CONFIG.telegram_bot_token, { polling: false });
        }

        this._setupSignalHandlers();
        this.loadState();
    }

    sendTelegram(text) {
        if (this.telegramBot && CONFIG.telegram_chat_id) {
            this.telegramBot.sendMessage(CONFIG.telegram_chat_id, text, { parse_mode: 'HTML' }).catch(() => {});
        }
    }

    saveState() {
        try {
            const stateData = {
                savedAt: Date.now(),
                totalProfit: this.tracker.totalProfit,
                totalWins: this.tracker.totalWins,
                totalLosses: this.tracker.totalLosses,
                tradeCount: this.tracker.getTradeCount(),
                startBalance: this.tracker.startBalance,
                currentBalance: this.tracker.currentBalance,
                currentLevel: this.stakeManager.currentLevel,
                sessionStartTime: this.sessionStartTime,
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2));
        } catch (e) {
            Logger.error('Error saving state:', e.message);
        }
    }

    loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) return;
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (Date.now() - data.savedAt > 30 * 60 * 1000) return;

            this.tracker.totalProfit = data.totalProfit ?? 0;
            this.tracker.totalWins = data.totalWins ?? 0;
            this.tracker.totalLosses = data.totalLosses ?? 0;
            this.tracker.restoredTradeCount = data.tradeCount ?? 0;
            if (data.startBalance != null) this.tracker.startBalance = data.startBalance;
            if (data.currentBalance != null) this.tracker.currentBalance = data.currentBalance;
            if (data.currentLevel != null) this.stakeManager.currentLevel = data.currentLevel;
            if (data.sessionStartTime != null) this.sessionStartTime = data.sessionStartTime;

            Logger.info('✅ State restored from ' + new Date(data.savedAt).toLocaleString());
        } catch (e) {
            Logger.error('Error loading state:', e.message);
        }
    }

    startAutoSave() {
        setInterval(() => this.saveState(), 5000);
    }

    startHourlySummary() {
        setInterval(() => {
            if (this.hourly.trades === 0) return;
            const winRate = ((this.hourly.wins / this.hourly.trades) * 100).toFixed(1);
            this.sendTelegram(`
                ⏰ <b>HOURLY — nFastGhost Repeat-Cycle Bot</b>

                📊 <b>This hour</b>
                ├ Trades: ${this.hourly.trades}
                ├ ✅ Wins: ${this.hourly.wins} | ❌ Losses: ${this.hourly.losses}
                ├ Win Rate: ${winRate}%
                └ P&L: ${this.hourly.pnl >= 0 ? '+' : ''}$${this.hourly.pnl.toFixed(2)}

                📊 <b>Session</b>
                ├ Symbol: ${CONFIG.symbol}
                ├ Total Trades: ${this.tracker.getTradeCount()}
                ├ W/L: ${this.tracker.totalWins}/${this.tracker.totalLosses}
                ├ Win Rate: ${(this.tracker.getWinRate() * 100).toFixed(1)}%
                ├ Total P&L: $${this.tracker.totalProfit.toFixed(2)}
                ├ Balance: $${this.tracker.currentBalance.toFixed(2)}
                ├ Fib Level: ${this.stakeManager.currentLevel}
                └ Runtime: ${((Date.now() - this.sessionStartTime) / 3600000).toFixed(1)}h
            `.trim());
            this.hourly = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        }, 3600000);
    }

    _setupSignalHandlers() {
        const shutdown = async () => {
            Logger.info('\n🛑 Shutting down bot...');
            this.isRunning = false;
            this.state = 'STOPPED';
            this.saveState();
            this.tracker.printSummary();
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.close();
            }
            process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    }

    /**
     * Start the bot
     */
    async start() {
        this._printBanner();

        Logger.info('🚀 Starting Romanian Ghost Bot...');
        Logger.info(`📈 Symbol: ${CONFIG.symbol}`);
        Logger.info(`💰 Base Stake: $${CONFIG.fibonacci.base_stake}`);
        Logger.info(`🎯 Take Profit: $${CONFIG.risk.take_profit}`);
        Logger.info(`🛑 Max Daily Loss: $${CONFIG.risk.max_daily_loss}`);

        this.isRunning = true;
        this.startAutoSave();
        this.startHourlySummary();
        await this._connect();
    }

    _printBanner() {
        console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║       🏴 ROMANIAN GHOST - BLACK FIBONACCI 9.1 🏴          ║
║                                                           ║
║          Deriv Digit Differ Trading Bot                    ║
║                                                           ║
║   Strategy: Ghost Digit Detection + Modified Fibonacci    ║
║   Contract: DIGITDIFF (Digit Differs)                     ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
        `);
    }

    /**
     * Connect to Deriv WebSocket API
     */
    async _connect() {
        return new Promise((resolve, reject) => {
            const url = `${CONFIG.endpoint}?app_id=${CONFIG.app_id}`;
            Logger.info(`🔌 Connecting to ${url}...`);

            this.ws = new WebSocket(url);

            this.ws.on('open', () => {
                Logger.info('✅ WebSocket connected');
                this.isConnected = true;
                this._authorize();
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data.toString());
                    this._handleMessage(response);
                } catch (err) {
                    Logger.error('Failed to parse message:', err.message);
                }
            });

            this.ws.on('error', (error) => {
                Logger.error('WebSocket error:', error.message);
                this.isConnected = false;
            });

            this.ws.on('close', (code, reason) => {
                Logger.warn(`WebSocket closed: ${code} - ${reason || 'No reason'}`);
                this.isConnected = false;
                this.isAuthorized = false;

                // Auto-reconnect if still running
                if (this.isRunning) {
                    Logger.info('🔄 Reconnecting in 5 seconds...');
                    setTimeout(() => this._connect(), 5000);
                }
            });

            // Timeout
            setTimeout(() => {
                if (!this.isConnected) {
                    reject(new Error('Connection timeout'));
                }
            }, 15000);
        });
    }

    /**
     * Send message to API
     */
    _send(data) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            Logger.error('Cannot send - WebSocket not connected');
            return;
        }

        const reqId = this.requestId++;
        data.req_id = reqId;

        Logger.debug(`📤 Sending:`, JSON.stringify(data).substring(0, 200));
        this.ws.send(JSON.stringify(data));
        return reqId;
    }

    /**
     * Authorize with API token
     */
    _authorize() {
        Logger.info('🔑 Authorizing...');
        this._send({
            authorize: this.apiToken,
        });
    }

    /**
     * Handle incoming WebSocket messages
     */
    _handleMessage(response) {
        if (response.error) {
            this._handleError(response);
            return;
        }

        switch (response.msg_type) {
            case 'authorize':
                this._onAuthorized(response);
                break;
            case 'balance':
                this._onBalance(response);
                break;
            case 'tick':
                this._onTick(response);
                break;
            case 'history':
                this._onTickHistory(response);
                break;
            case 'buy':
                this._onBuyResponse(response);
                break;
            case 'proposal_open_contract':
                this._onContractUpdate(response);
                break;
            case 'transaction':
                this._onTransaction(response);
                break;
            default:
                Logger.debug(`Received: ${response.msg_type}`);
        }
    }

    /**
     * Handle authorization response
     */
    _onAuthorized(response) {
        const auth = response.authorize;
        Logger.info(`✅ Authorized as: ${auth.fullname || auth.loginid}`);
        Logger.info(`💰 Balance: $${auth.balance} ${auth.currency}`);
        Logger.info(`📋 Account Type: ${auth.is_virtual ? 'DEMO' : 'REAL'}`);

        if (!auth.is_virtual) {
            Logger.warn('⚠️  WARNING: You are using a REAL account! Be cautious!');
        }

        this.isAuthorized = true;
        this.tracker.startBalance = parseFloat(auth.balance);
        this.tracker.currentBalance = parseFloat(auth.balance);

        // Subscribe to balance updates
        this._send({ balance: 1, subscribe: 1 });

        // Subscribe to transaction updates
        this._send({ transaction: 1, subscribe: 1 });

        // Warm-up with historical ticks, then subscribe to live ticks
        this._requestTickHistory();

        // Start tick subscription
        this._subscribeTicks();

        this.state = 'COLLECTING';
        Logger.info(`📊 State: COLLECTING (need ${CONFIG.strategy.min_ticks_before_start} ticks)`);
    }

    /**
     * Handle balance updates
     */
    _onBalance(response) {
        if (response.balance) {
            this.tracker.currentBalance = parseFloat(response.balance.balance);
            Logger.debug(`💰 Balance updated: $${this.tracker.currentBalance.toFixed(2)}`);
        }
    }

    /**
     * Request historical ticks for warm-up
     */
    _requestTickHistory() {
        Logger.info(`📚 Requesting tick history for ${CONFIG.symbol}...`);
        this._send({
            ticks_history: CONFIG.symbol,
            adjust_start_time: 1,
            // Request deep history for repeat-cycle analysis (e.g. 5000 ticks)
            count: CONFIG.strategy.history_length || 5000,
            end: 'latest',
            start: 1,
            style: 'ticks',
        });
    }

    /**
     * Subscribe to tick stream
     */
    _subscribeTicks() {
        Logger.info(`📊 Subscribing to ${CONFIG.symbol} ticks...`);
        this._send({
            ticks: CONFIG.symbol,
            subscribe: 1,
        });
    }

    /**
     * Handle historical tick data response
     */
    _onTickHistory(response) {
        if (!response.history || !response.history.prices) return;

        const prices = response.history.prices;
        const times = response.history.times || [];

        Logger.info(`📚 Received ${prices.length} historical ticks for ${CONFIG.symbol}`);

        for (let i = 0; i < prices.length; i++) {
            const tick = {
                quote: prices[i].toString(),
                epoch: times[i] || null,
                symbol: CONFIG.symbol,
            };
            const digit = this.analyzer.addTick(tick);
            this.repeatCycleAnalyzer.addDigit(digit);
        }

        this.historyLoaded = true;

        Logger.info(`📊 History warm-up complete. Tick count: ${this.analyzer.getTickCount()}`);

        // if (CONFIG.show_digit_analysis) {
            this._printDigitAnalysis();
        // }

        if (this.state === 'INITIALIZING') {
            this.state = 'COLLECTING';
            Logger.info(`📊 State: COLLECTING (need ${CONFIG.strategy.min_ticks_before_start} ticks)`);
        }
    }

    /**
     * Handle incoming tick data - CORE LOGIC
     */
    _onTick(response) {
        if (!response.tick) return;

        const tick = response.tick;
        const digit = this.analyzer.addTick(tick);
        this.repeatCycleAnalyzer.addDigit(digit);
        const tickCount = this.analyzer.getTickCount();

         // Periodically log last 10 digits for visibility
         const now = Date.now();
         // if (now - this.lastTickLogTime >= 30000) {
             const recentTicks = this.analyzer.getRecentTicks(10);
             const digitsStr = recentTicks.map(t => t.digit).join(',');
             Logger.info(`🔢 Last 10 digits: [${digitsStr}]`);
             this.lastTickLogTime = now;
         // }

        // Per-tick repeat-cycle stats for visibility
        const cycleSignal = this.repeatCycleAnalyzer.getSignal(digit);
        if (cycleSignal && cycleSignal.details) {
            const d = cycleSignal.details;
            const thresholdPct = (d.learnedSaturation * 100).toFixed(1);
            Logger.info(
                `🔬 REPEAT-CYCLE ANALYSIS: ` +
                `short=${(d.shortRepeat * 100).toFixed(1)}% ` +
                `threshold=${thresholdPct}% ` +
                `mid=${(d.midRepeat * 100).toFixed(1)}% ` +
                `long=${(d.longRepeat * 100).toFixed(1)}% ` +
                `lastOversatShort=${(d.lastOversatShortRate * 100).toFixed(1)}% ` +
                `lastOversatLong=${(d.lastOversatLongRate * 100).toFixed(1)}% ` +
                `ticksSinceOversat=${d.ticks_since_oversat} ` +
                `score=${cycleSignal.score} ` +
                `active=${cycleSignal.active}`
            );
        }

        if (CONFIG.show_tick_data && tickCount % 5 === 0) {
            Logger.debug(`📊 Tick #${tickCount}: ${tick.quote} | Digit: ${digit} | ${this.analyzer.getSummary()}`);
        }

        // State machine
        switch (this.state) {
            case 'COLLECTING':
                this._handleCollectingState(tickCount);
                break;

            case 'TRADING':
                this._handleTradingState(digit);
                break;

            case 'COOLDOWN':
                this._handleCooldownState();
                break;

            case 'STOPPED':
                break;
        }
    }

    /**
     * COLLECTING state - gathering initial tick data
     */
    _handleCollectingState(tickCount) {
        if (tickCount >= CONFIG.strategy.min_ticks_before_start) {
            Logger.info('✅ Enough tick data collected. Moving to TRADING (repeat-cycle mode)...');
            this.state = 'TRADING';

            // if (CONFIG.show_digit_analysis) {
                this._printDigitAnalysis();
            // }
        } else {
            if (tickCount % 10 === 0) {
                Logger.info(`📊 Collecting ticks: ${tickCount}/${CONFIG.strategy.min_ticks_before_start}`);
            }
        }
    }

    _stopTrading(reason) {
        this.state = 'STOPPED';
        this.saveState();
        this.tracker.printSummary();
        const runtimeMin = ((Date.now() - this.sessionStartTime) / 60000).toFixed(1);
        this.sendTelegram(`
            🛑 <b>BOT STOPPED — nFastGhost</b>

            Reason: ${reason}

            📊 <b>Session summary</b>
            ├ Trades: ${this.tracker.getTradeCount()}
            ├ W/L: ${this.tracker.totalWins}/${this.tracker.totalLosses}
            ├ Win rate: ${(this.tracker.getWinRate() * 100).toFixed(1)}%
            ├ Total P&L: $${this.tracker.totalProfit.toFixed(2)}
            ├ Balance: $${this.tracker.currentBalance.toFixed(2)}
            └ Runtime: ${runtimeMin} min
        `.trim());
    }

    /**
     * TRADING state - placing real trades
     */
    _handleTradingState(lastDigit) {
        // Check risk management
        const stopReason = this.tracker.shouldStopTrading();
        if (stopReason) {
            Logger.warn(`🛑 Stopping: ${stopReason}`);
            this._stopTrading(stopReason);
            return;
        }

        // Check max consecutive losses
        if (this.stakeManager.isMaxLossesReached()) {
            Logger.warn(`🛑 Max consecutive losses (${CONFIG.risk.max_consecutive_losses}) reached!`);
            this._stopTrading('MAX_CONSECUTIVE_LOSSES');
            return;
        }

        // Check cooldown
        if (this.stakeManager.getConsecutiveLosses() >= CONFIG.strategy.loss_streak_cooldown_trigger) {
            Logger.warn(`❄️  Entering cooldown after ${this.stakeManager.getConsecutiveLosses()} losses`);
            this.cooldownTicksRemaining = CONFIG.strategy.cooldown_ticks_after_loss_streak;
            this.state = 'COOLDOWN';
            return;
        }

        // Don't place if contract in progress
        if (this.contractInProgress) {
            return;
        }

        // Rate limiting
        if (Date.now() - this.lastTradeTime < this.minTradeCooldown) {
            return;
        }

        // Trade only when RepeatCycleAnalyzer detects exhaustion (short reached threshold then started to fall)
        const signal = this._generateSignal();
        console.log('Confidence:', signal.confidence);
        if (signal && signal.confidence < 0.10) {
            this._placeTrade(signal);
        }
    }

    /**
     * COOLDOWN state - waiting after loss streak
     */
    _handleCooldownState() {
        this.cooldownTicksRemaining--;

        if (this.cooldownTicksRemaining % 5 === 0) {
            Logger.info(`❄️  Cooldown: ${this.cooldownTicksRemaining} ticks remaining`);
        }

        if (this.cooldownTicksRemaining <= 0) {
            Logger.info('✅ Cooldown complete. Re-entering TRADING...');
            this.state = 'TRADING';

            // Step back fibonacci level during cooldown
            this.stakeManager.currentLevel = Math.max(0, this.stakeManager.currentLevel - 2);
        }
    }

    /**
     * Generate trading signal - RepeatCycleAnalyzer only.
     * A trade is taken only when the short repeat rate has reached the learned threshold
     * and then starts to fall (exhaustion). No other logic is used.
     */
    _generateSignal() {
        if (!this.analyzer.hasEnoughData()) return null;

        const lastDigit = this.analyzer.getLastDigit();
        const cycleSignal = this.repeatCycleAnalyzer.getSignal(lastDigit);

        if (!cycleSignal.active) {
            return null;
        }

        // Exhaustion detected: short reached threshold and started to fall → execute trade
        const confidence = Math.min(cycleSignal.score / 100, 1.0);
        const fibLevel = this.stakeManager.currentLevel;

        return {
            digit: lastDigit,
            confidence,
            cycleScore: cycleSignal.score,
            cycleDetails: cycleSignal.details,
            frequency: cycleSignal.details ? cycleSignal.details.shortRepeat : 0,
            consecutive: 0,
            fibLevel,
            stake: this.stakeManager.getCurrentStake(),
        };
    }

    /**
     * Place actual trade on Deriv
     */
    _placeTrade(signal) {
        const stake = signal.stake;

        // Final stake validation
        if (stake > this.tracker.currentBalance * 0.5) {
            Logger.warn(`⚠️  Stake $${stake} exceeds 50% of balance. Skipping.`);
            return;
        }

        Logger.info('');
        Logger.info('═'.repeat(50));
        Logger.info(`🎲 PLACING TRADE: Digit Differs from ${signal.digit}`);
        Logger.info(`💰 Stake: $${stake} | Confidence: ${(signal.confidence * 100).toFixed(0)}%`);
        Logger.info(`📊 ${this.stakeManager.getSummary()}`);
        Logger.info(`📈 Repeat-cycle score: ${signal.cycleScore} | Freq: ${(signal.frequency * 100).toFixed(0)}%`);

        if (signal.cycleDetails) {
            const d = signal.cycleDetails;
            Logger.info(
                `🔬 Repeat-cycle stats ` +
                `short=${(d.shortRepeat * 100).toFixed(1)}% ` +
                `threshold=${(d.learnedSaturation * 100).toFixed(1)}% ` +
                `mid=${(d.midRepeat * 100).toFixed(1)}% ` +
                `long=${(d.longRepeat * 100).toFixed(1)}% ` +
                `lastOversatShort=${(d.lastOversatShortRate * 100).toFixed(1)}% ` +
                `lastOversatLong=${(d.lastOversatLongRate * 100).toFixed(1)}% ` +
                `ticksSinceOversat=${d.ticks_since_oversat}`
            );
        }

        const recentTicks = this.analyzer.getRecentTicks(10);
        const quotesStr = recentTicks.map(t => t.quote).join(',');
        const digitsStr = recentTicks.map(t => t.digit).join(',');
        // Logger.info(`📈 Last 10 ticks before trade: [${quotesStr}]`);
        Logger.info(`🔢 Last 10 digits before trade: [${digitsStr}]`);

        Logger.info('═'.repeat(50));

        const d = signal.cycleDetails || {};
        const th = (d.learnedSaturation != null ? d.learnedSaturation * 100 : 0).toFixed(1);
        const sh = (d.shortRepeat != null ? d.shortRepeat * 100 : 0).toFixed(1);
        this.sendTelegram(`
            🎯 <b>TRADE OPENED — nFastGhost Repeat-Cycle</b>

            📊 Symbol: ${CONFIG.symbol}
            🔢 Digit Differs: ${signal.digit}
            📈 Last 10 digits: ${recentTicks.map(t => t.digit).join(',')}

            🔬 <b>Repeat-Cycle</b>
            ├ Short: ${sh}% | Threshold: ${th}%
            ├ Score: ${signal.cycleScore}
            └ Exhaustion (short reached threshold then fell)

            💰 Stake: $${stake.toFixed(2)}
            📊 Fib Level: ${this.stakeManager.currentLevel} | Consec losses: ${this.stakeManager.getConsecutiveLosses()}
        `.trim());

        this.contractInProgress = true;
        this.lastTradeTime = Date.now();

        this.pendingContract = {
            signal: signal,
            sentAt: Date.now(),
        };

        this._send({
            buy: 1,
            price: stake,
            parameters: {
                contract_type: CONFIG.contract_type,
                symbol: CONFIG.symbol,
                duration: CONFIG.duration,
                duration_unit: CONFIG.duration_unit,
                currency: CONFIG.currency,
                amount: stake,
                basis: 'stake',
                barrier: signal.digit.toString(),
            },
        });
    }

    /**
     * Handle buy response
     */
    _onBuyResponse(response) {
        if (response.error) {
            Logger.error('❌ Buy failed:', response.error.message);
            this.contractInProgress = false;
            this.pendingContract = null;
            return;
        }

        const buy = response.buy;
        Logger.info(`✅ Contract purchased: ID ${buy.contract_id}`);
        Logger.info(`   Buy Price: $${buy.buy_price} | Potential Payout: $${buy.payout || 'N/A'}`);

        // Subscribe to contract updates
        this._send({
            proposal_open_contract: 1,
            contract_id: buy.contract_id,
            subscribe: 1,
        });
    }

    /**
     * Handle contract status updates
     */
    _onContractUpdate(response) {
        if (!response.proposal_open_contract) return;

        const contract = response.proposal_open_contract;

        if (contract.is_sold || contract.status === 'sold') {
            this._onContractSettled(contract);
        }
    }

    /**
     * Handle contract settlement (win/loss)
     */
    _onContractSettled(contract) {
        this.contractInProgress = false;

        const buyPrice = parseFloat(contract.buy_price);
        const sellPrice = parseFloat(contract.sell_price || 0);
        const profit = sellPrice - buyPrice;
        const isWin = profit > 0;

        const signal = this.pendingContract ? this.pendingContract.signal : null;

        this.hourly.trades++;
        this.hourly.pnl += profit;
        if (isWin) this.hourly.wins++; else this.hourly.losses++;

        Logger.info('');
        if (isWin) {
            Logger.info(`🎉 ${'═'.repeat(20)} WIN ${'═'.repeat(20)} 🎉`);
            Logger.info(`   Profit: +$${profit.toFixed(2)}`);
            this.stakeManager.onWin(profit);
            this.tracker.recordTrade({
                win: true,
                profit: profit,
                digit: signal ? signal.digit : '?',
                stake: buyPrice,
                contract_id: contract.contract_id,
            });
        } else {
            Logger.info(`😤 ${'═'.repeat(20)} LOSS ${'═'.repeat(19)} 😤`);
            Logger.info(`   Loss: -$${Math.abs(profit).toFixed(2)}`);
            this.stakeManager.onLoss(Math.abs(profit));
            this.tracker.recordTrade({
                win: false,
                loss: Math.abs(profit),
                digit: signal ? signal.digit : '?',
                stake: buyPrice,
                contract_id: contract.contract_id,
            });
        }

        const exitQuote = contract.exit_tick_display_value != null ? contract.exit_tick_display_value : (contract.sell_price || '');
        const exitDigit = exitQuote !== '' ? getLastDigitFromQuote(exitQuote, CONFIG.symbol) : '—';
        const last10 = this.analyzer.getRecentTicks(10).map(t => t.digit).join(',');
        this.sendTelegram(`
            ${isWin ? '✅ <b>WIN</b>' : '❌ <b>LOSS</b>'} — nFastGhost

            📊 Symbol: ${CONFIG.symbol}
            🎯 Target digit: ${signal ? signal.digit : '?'}
            🔢 Exit digit: ${exitDigit}
            📈 Last 10: ${last10}

            💰 P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}
            💵 Session P&L: $${this.tracker.totalProfit.toFixed(2)}
            📊 Balance: $${this.tracker.currentBalance.toFixed(2)}
            📊 Record: ${this.tracker.totalWins}W/${this.tracker.totalLosses}L | Win rate: ${(this.tracker.getWinRate() * 100).toFixed(1)}%
            💲 Next stake: $${this.stakeManager.getCurrentStake().toFixed(2)} | Fib level: ${this.stakeManager.currentLevel}
        `.trim());

        const recentTicks = this.analyzer.getRecentTicks(10);
        const quotesStr = recentTicks.map(t => t.quote).join(',');
        const digitsStr = recentTicks.map(t => t.digit).join(',');
        Logger.info(`🔢 Last 10 digits at settlement: [${digitsStr}]`);

        if (signal && signal.cycleDetails) {
            const d = signal.cycleDetails;
            Logger.info(
                `🔬 Last trade repeat-cycle ` +
                `short=${(d.shortRepeat * 100).toFixed(1)}% ` +
                `threshold=${(d.learnedSaturation * 100).toFixed(1)}% ` +
                `mid=${(d.midRepeat * 100).toFixed(1)}% ` +
                `long=${(d.longRepeat * 100).toFixed(1)}% ` +
                `lastOversatShort=${(d.lastOversatShortRate * 100).toFixed(1)}% ` +
                `lastOversatLong=${(d.lastOversatLongRate * 100).toFixed(1)}% ` +
                `ticksSinceOversat=${d.ticks_since_oversat} ` +
                `cycleScore=${signal.cycleScore}`
            );
        }

        Logger.info(`   Total P/L: $${this.tracker.totalProfit.toFixed(2)} | ` +
            `Trades: ${this.tracker.getTradeCount()} | ` +
            `Win Rate: ${(this.tracker.getWinRate() * 100).toFixed(1)}% | ` +
            `Balance: $${this.tracker.currentBalance.toFixed(2)}`);
        Logger.info('');

        this.pendingContract = null;

        // Unsubscribe from this contract
        if (contract.id) {
            this._send({ forget: contract.id });
        }
    }

    /**
     * Handle transaction events
     */
    _onTransaction(response) {
        if (response.transaction) {
            const tx = response.transaction;
            Logger.debug(`💳 Transaction: ${tx.action} | Amount: ${tx.amount} | Balance: ${tx.balance}`);

            if (tx.balance) {
                this.tracker.currentBalance = parseFloat(tx.balance);
            }
        }
    }

    /**
     * Handle API errors
     */
    _handleError(response) {
        const error = response.error;
        Logger.error(`API Error [${error.code}]: ${error.message}`);

        // Handle specific errors
        switch (error.code) {
            case 'AuthorizationRequired':
            case 'InvalidToken':
                Logger.error('❌ Authentication failed. Please check your API token.');
                this.state = 'STOPPED';
                break;

            case 'RateLimit':
                Logger.warn('⚠️  Rate limited. Waiting 10 seconds...');
                this.contractInProgress = false;
                setTimeout(() => {}, 10000);
                break;

            case 'ContractBuyValidationError':
            case 'InvalidContractProposal':
                Logger.error('❌ Contract validation error. Check parameters.');
                this.contractInProgress = false;
                break;

            case 'InsufficientBalance':
                Logger.error('❌ Insufficient balance!');
                this.state = 'STOPPED';
                break;

            default:
                // For buy errors, reset contract state
                if (response.msg_type === 'buy') {
                    this.contractInProgress = false;
                    this.pendingContract = null;
                }
        }
    }

    /**
     * Print detailed digit analysis
     */
    _printDigitAnalysis() {
        const analysis = this.analyzer.getFrequencyAnalysis();
        if (!analysis) return;

        // console.log('\n📊 DIGIT FREQUENCY ANALYSIS:');
        // console.log('─'.repeat(50));
        // console.log('Digit | Count | Freq    | Bar');
        // console.log('─'.repeat(50));

        // for (const entry of analysis) {
        //     const bar = '█'.repeat(Math.round(entry.frequency * 50));
        //     const marker = entry.frequency >= CONFIG.strategy.frequency_threshold ? ' ← HOT' : '';
        //     console.log(
        //         `  ${entry.digit}   |   ${entry.count.toString().padStart(2)}  | ` +
        //         `${(entry.frequency * 100).toFixed(1).padStart(5)}%  | ${bar}${marker}`
        //     );
        // }
        // console.log('─'.repeat(50));

        const lastDigit = this.analyzer.getLastDigit();
        const cycleSignal = this.repeatCycleAnalyzer.getSignal(lastDigit);
        if (cycleSignal && cycleSignal.details) {
            const d = cycleSignal.details;
            console.log('\n🔬 REPEAT-CYCLE ANALYSIS:');
            const thresholdPct = (d.learnedSaturation * 100).toFixed(1);
            console.log(
                `  short=${(d.shortRepeat * 100).toFixed(1)}% ` +
                `threshold=${thresholdPct}% (short must reach then exhaust to trade) ` +
                `mid=${(d.midRepeat * 100).toFixed(1)}% ` +
                `long=${(d.longRepeat * 100).toFixed(1)}% ` +
                `lastOversatShort=${(d.lastOversatShortRate * 100).toFixed(1)}% ` +
                `lastOversatLong=${(d.lastOversatLongRate * 100).toFixed(1)}% ` +
                `ticksSinceOversat=${d.ticks_since_oversat} ` +
                `score=${cycleSignal.score}`
            );
            console.log('');
        }
    }
}

// ============================================================================
// CLI INTERFACE
// ============================================================================
async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    let apiToken = CONFIG.api_token || process.env.DERIV_API_TOKEN;

    // Parse CLI arguments
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--token':
            case '-t':
                apiToken = args[++i];
                break;
            case '--symbol':
            case '-s':
                CONFIG.symbol = args[++i];
                break;
            case '--stake':
                CONFIG.fibonacci.base_stake = parseFloat(args[++i]);
                break;
            case '--take-profit':
            case '--tp':
                CONFIG.risk.take_profit = parseFloat(args[++i]);
                break;
            case '--stop-loss':
            case '--sl':
                CONFIG.risk.max_daily_loss = parseFloat(args[++i]);
                break;
            case '--debug':
                CONFIG.log_level = 'DEBUG';
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
        }
    }

    // If no token, prompt for it
    if (!apiToken) {
        apiToken = await promptToken();
    }

    if (!apiToken) {
        console.error('❌ API token is required. Use --token <token> or set DERIV_API_TOKEN env variable.');
        process.exit(1);
    }

    // Validate token format
    if (apiToken.length < 10) {
        console.error('❌ Invalid API token format.');
        process.exit(1);
    }

    // Create and start bot
    const bot = new RomanianGhostBot(apiToken);

    try {
        await bot.start();
    } catch (error) {
        Logger.error('Fatal error:', error.message);
        bot.tracker.printSummary();
        process.exit(1);
    }
}

async function promptToken() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        rl.question('🔑 Enter your Deriv API Token: ', (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function printHelp() {
    console.log(`
🏴 Romanian Ghost - Black Fibonacci 9.1
Deriv Digit Differ Trading Bot

USAGE:
    node bot.js [options]

OPTIONS:
    --token, -t <token>     Deriv API token (or set DERIV_API_TOKEN env var)
    --symbol, -s <symbol>   Trading symbol (default: R_25)
                            Options: R_10, R_25, R_50, R_75, R_100
                                     1HZ10V, 1HZ25V, 1HZ50V, 1HZ75V, 1HZ100V
    --stake <amount>        Base stake in USD (default: 0.35)
    --take-profit, --tp     Take profit target (default: 30.00)
    --stop-loss, --sl       Max daily loss limit (default: 50.00)
    --debug                 Enable debug logging
    --help, -h              Show this help message

EXAMPLES:
    node bot.js --token YOUR_TOKEN_HERE
    node bot.js -t YOUR_TOKEN -s R_50 --stake 0.50 --tp 20
    DERIV_API_TOKEN=xxx node bot.js --debug

STRATEGY:
    1. Collects 30+ ticks to build digit frequency profile
    2. Runs 3+ ghost (virtual) trades to confirm strategy validity
    3. Identifies overrepresented digits using Romanian Ghost algorithm
    4. Places "Digit Differs" contracts on hot digits
    5. Uses modified Fibonacci (9.1x multiplier) for stake recovery
    6. Implements cooldown periods after loss streaks
    7. Comprehensive risk management with stop-loss and take-profit

NOTES:
    - Get your API token at: https://app.deriv.com/account/api-token
    - Required token scopes: Read, Trade
    - Start with a DEMO account
    - Telegram: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for trade/hourly/stop notifications
    - State is saved to nFastGhost-state.json every 5s and restored on start (if < 30 min old)
    - Install dependency: npm install ws
    `);
}

// ============================================================================
// ENTRY POINT
// ============================================================================
main().catch((err) => {
    console.error('❌ Unhandled error:', err);
    process.exit(1);
});
