#!/usr/bin/env node

/**
 * ============================================================================
 * ROMANIAN GHOST - BLACK FIBONACCI 9.1
 * Deriv Digit Differ Trading Bot
 * ============================================================================
 *
 * Strategy: Uses short-cycle (50-tick) repeat-rate saturation learning over
 * 5000 ticks of history. Identifies the most consistent repetition saturation
 * percentage before ticks go to a regime of none/very low repeat. When the
 * short cycle repeat percentage reaches the identified level and observed
 * exhaustion (multi-tick declining trend) occurs, executes a DIGITDIFF trade
 * on the hot digit that drove the repeats.
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

const STATE_FILE = path.join(__dirname, 'nFastGhost-state000004.json');

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
    // Deriv API Configuration
    app_id: '1089',
    endpoint: 'wss://ws.derivws.com/websockets/v3',

    // Account — use environment variables
    api_token: '0P94g4WdSrSrzir',

    // Market Selection
    symbol: 'R_75',

    // Contract Configuration
    contract_type: 'DIGITDIFF',
    duration: 1,
    duration_unit: 't',
    currency: 'USD',

    // Strategy Parameters
    strategy: {
        // Deep history length for repeat-cycle analysis
        history_length: 5000,
        // Short window emphasis (most recent ticks for cycle analysis)
        short_window: 50,

        // Minimum ticks to collect before starting analysis
        min_ticks_before_start: 60,

        // Cool-down after losses
        cooldown_ticks_after_loss_streak: 10,
        loss_streak_cooldown_trigger: 3,
    },

    // Multiplier-based Stake Management (from liveMultiAccumNew.js)
    stake: {
        initial_stake: 1.1,
        multiplier: 11.3,
        multiplier2: 11.3,
        multiplier3: 100,
        max_stake: 500.00,
    },

    // Risk Management
    risk: {
        max_daily_loss: 100.00,
        max_daily_trades: 2000000000000000,
        max_consecutive_losses: 3,
        take_profit: 30000.00,
        min_balance: 10.00,
        max_stake: 500.00,
    },

    // Logging
    log_level: 'INFO',
    show_tick_data: true,

    // Telegram (use environment variables)
    telegram_bot_token: '8218636914:AAGvaKFh8MT769-_9eOEiU4XKufL0aHRhZ4',
    telegram_chat_id: '752497117',
};

// ============================================================================
// UTILS
// ============================================================================
function getLastDigitFromQuote(quote, asset) {
    // Ensure proper string representation with sufficient decimal places
    const quoteString = typeof quote === 'number' ? quote.toFixed(5) : quote.toString();
    const [, fractionalPart = ''] = quoteString.split('.');

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
// DIGIT ANALYZER - Tracks digit history and finds hot digits
// ============================================================================
class DigitAnalyzer {
    constructor(shortWindow) {
        this.shortWindow = shortWindow;
        this.tickHistory = [];
        this.digitHistory = [];
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

        // Keep enough history for short window analysis plus buffer
        const maxKeep = this.shortWindow * 4;
        if (this.digitHistory.length > maxKeep) {
            this.digitHistory = this.digitHistory.slice(-maxKeep);
        }
        if (this.tickHistory.length > maxKeep) {
            this.tickHistory = this.tickHistory.slice(-maxKeep);
        }

        return lastDigit;
    }

    getRecentDigits(n = null) {
        const size = n || this.shortWindow;
        return this.digitHistory.slice(-size);
    }

    getLastDigit() {
        return this.digitHistory.length > 0
            ? this.digitHistory[this.digitHistory.length - 1]
            : null;
    }

    /**
     * Find the most frequent (hot) digit in the short window.
     * This is the digit that drove repeats and is expected to exhaust.
     */
    getHotDigitInWindow(windowSize = null) {
        const w = windowSize || this.shortWindow;
        const recent = this.getRecentDigits(w);
        if (recent.length === 0) return { digit: 0, count: 0, frequency: 0 };

        const freq = new Array(10).fill(0);
        recent.forEach(d => freq[d]++);

        let hotDigit = 0;
        let maxCount = 0;
        for (let d = 0; d < 10; d++) {
            if (freq[d] > maxCount) {
                maxCount = freq[d];
                hotDigit = d;
            }
        }

        return {
            digit: hotDigit,
            count: maxCount,
            frequency: maxCount / recent.length,
        };
    }

    /**
     * Get frequency analysis for logging
     */
    getFrequencyAnalysis() {
        const window = this.getRecentDigits();
        const total = window.length;
        if (total === 0) return null;

        const freq = new Array(10).fill(0);
        window.forEach(d => freq[d]++);

        const analysis = [];
        for (let d = 0; d < 10; d++) {
            analysis.push({
                digit: d,
                count: freq[d],
                frequency: freq[d] / total,
            });
        }

        analysis.sort((a, b) => b.frequency - a.frequency);
        return analysis;
    }

    hasEnoughData() {
        return this.digitHistory.length >= CONFIG.strategy.min_ticks_before_start;
    }

    getTickCount() {
        return this.digitHistory.length;
    }

    getRecentTicks(n = 10) {
        return this.tickHistory.slice(-n);
    }

    getSummary() {
        const analysis = this.getFrequencyAnalysis();
        if (!analysis) return 'No data';

        const window = this.getRecentDigits();
        const digitDisplay = window.slice(-15).join(',');
        const topDigit = analysis[0];

        return `Last15:[${digitDisplay}] | Hot:${topDigit.digit}(${(topDigit.frequency * 100).toFixed(0)}%)`;
    }
}

// ============================================================================
// REPEAT CYCLE ANALYZER
// Short-window (50) saturation learning over 5000 ticks.
// Uses sliding window to learn saturation level, multi-tick exhaustion detection.
// ============================================================================
class RepeatCycleAnalyzer {
    constructor(config) {
        this.maxHistory = config.history_length || 5000;
        this.shortWindow = config.short_window || 50;

        // "Very low repeat" threshold — BELOW baseline (~10% for 10 digits)
        this.nonRepMaxRepeat = 0.06;
        this.minSamplesForLearning = 10;

        this.digits = [];
        this.repeats = []; // 1 when same as previous digit, else 0
        this.tickCount = 0;

        // Learned saturation level from history
        this.learnedSaturation = null;
        this.learnedSaturation2 = null;

        // Multi-tick tracking for robust exhaustion detection
        this.shortHistory = [];
        this.exhaustionLookback = 6;

        // Hold signal for a few ticks so it doesn't reset immediately
        this.signalHoldTicks = 2;
        this.signalHold = null;

        this.lastSnapshot = null;
    }

    _pushDigit(digit) {
        if (this.digits.length > 0) {
            const prev = this.digits[this.digits.length - 1];
            this.repeats.push(prev === digit ? 1 : 0);
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

    _windowMean(arr, start, end) {
        if (start >= end || arr.length === 0) return 0;
        let sum = 0;
        for (let i = start; i < end; i++) sum += arr[i];
        return sum / (end - start);
    }

    _windowMeanFromEnd(arr, n) {
        const end = arr.length;
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
     * Sliding-window saturation learning.
     * Slides by quarter-window steps across entire history.
     * For each position, if the NEXT window has very low repeat rate (<6%),
     * the CURRENT window's rate is a "saturation before collapse" sample.
     * Uses median of all such samples for robustness.
     */
    _updateLearnedSaturation() {
        const w = this.shortWindow;
        if (this.repeats.length < w * 3) return;

        const samples = [];
        const step = Math.max(1, Math.floor(w / 4)); // slide by quarter-window
        const maxStart = this.repeats.length - (2 * w);

        for (let i = 0; i <= maxStart; i += step) {
            let sumCur = 0, sumNext = 0;
            for (let j = i; j < i + w; j++) sumCur += this.repeats[j];
            for (let j = i + w; j < i + 2 * w; j++) sumNext += this.repeats[j];

            const rateCur = sumCur / w;
            const rateNext = sumNext / w;

            // Next window must be genuinely low-repeat (below baseline)
            if (rateNext <= this.nonRepMaxRepeat) {
                samples.push(rateCur);
            }
        }

        if (samples.length < this.minSamplesForLearning) {
            Logger.debug(`Saturation learning: only ${samples.length} samples (need ${this.minSamplesForLearning})`);
            return;
        }

        // Use median for robustness
        samples.sort((a, b) => a - b);
        const midIdx = Math.floor(samples.length / 2);
        this.learnedSaturation = samples.length % 2 === 1
            ? samples[midIdx]
            : (samples[midIdx - 1] + samples[midIdx]) / 2;

            this.learnedSaturation2 = (this.learnedSaturation * 100).toFixed(1);
        Logger.debug(`Saturation learning: ${samples.length} samples, median=${(this.learnedSaturation * 100).toFixed(1)}%`);
    }

    /**
     * Force learning — call after loading tick history
     */
    forceLearn() {
        this._updateLearnedSaturation();
    }

    addDigit(digit) {
        this._pushDigit(digit);

        if (this.repeats.length < this.shortWindow + 5) return;

        // Update learned saturation periodically (every half-window)
        if (this.tickCount % Math.floor(this.shortWindow / 2) === 0) {
            this._updateLearnedSaturation();
        }

        const shortNow = this._windowMeanFromEnd(this.repeats, this.shortWindow);

        // Track short history for multi-tick exhaustion detection
        this.shortHistory.push(shortNow);
        if (this.shortHistory.length > 30) this.shortHistory.shift();

        const longRepeat = this._fullMean(this.repeats);
        const midRepeat = this._windowMeanFromEnd(this.repeats, this.shortWindow * 2);

        this.lastSnapshot = { shortRepeat: shortNow, midRepeat, longRepeat };
    }

    /**
     * Signal based ONLY on short-cycle saturation → exhaustion.
     * Requires multi-tick declining trend from a peak at/above learned saturation.
     *
     * active == true when:
     *  - we have a learned saturation level
     *  - peak in recent lookback window reached saturation
     *  - current short rate has declined meaningfully from peak
     *  - decline is confirmed by monotonic 3-tick downtrend
     *  - current rate hasn't already collapsed below baseline
     */
    getSignal(currentDigit) {
        if (!this.lastSnapshot || this.shortHistory.length < this.exhaustionLookback) {
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

        if (sat == null) {
            return {
                active: false,
                score: 0,
                details: { ...baseDetails, reason: 'saturation_not_learned_yet' },
            };
        }

        // Multi-tick exhaustion detection
        const recent = this.shortHistory.slice(-this.exhaustionLookback);
        const peakInWindow = Math.max(...recent);
        const currentVal = recent[recent.length - 1];

        // 1. Peak must have reached saturation level
        const peakReachedSat = peakInWindow >= sat;

        // 2. Current must have declined meaningfully from peak (15%+ relative decline)
        const declineFraction = peakInWindow > 0
            ? (peakInWindow - currentVal) / peakInWindow
            : 0;
        const meaningfulDecline = declineFraction >= 0.15;

        // 3. Must still be above very-low territory (not already collapsed)
        const notCollapsed = currentVal >= this.nonRepMaxRepeat;

        // 4. Monotonically declining over last 3 data points
        const last3 = recent.slice(-3);
        const declining = last3.length >= 3
            && last3[0] > last3[1]
            && last3[1] > last3[2];

        const exhaustion = peakReachedSat && meaningfulDecline && notCollapsed && declining;

        if (!exhaustion) {
            return {
                active: false,
                score: 0,
                details: {
                    ...baseDetails,
                    reason: 'no_exhaustion',
                    peakInWindow: peakInWindow.toFixed(4),
                    declineFraction: declineFraction.toFixed(3),
                    declining,
                },
            };
        }

        // Score: how far above saturation the peak was + how clear the decline
        const peakExcess = Math.max(0, peakInWindow - sat);
        const normPeak = Math.min(1, peakExcess / 0.15);
        const normDecline = Math.min(1, declineFraction / 0.30);
        const score = Math.round(((normPeak * 0.5) + (normDecline * 0.3) + (declining ? 0.2 : 0)) * 100);

        this.signalHold = {
            score,
            details: {
                ...baseDetails,
                reason: 'short_cycle_exhaustion',
                peakInWindow: peakInWindow.toFixed(4),
                declineFraction: declineFraction.toFixed(3),
            },
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
// STAKE MANAGER - Multiplier-based with Consecutive Loss Tracking
// ============================================================================
class StakeManager {
    constructor() {
        this.currentStake = CONFIG.stake.initial_stake;
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.tradeHistory = [];
        this.sys = 1;  // System state for stake progression
        this.sysCount = 0;
    }

    getCurrentStake() {
        // Apply max stake limit
        return Math.min(parseFloat(this.currentStake.toFixed(2)), CONFIG.stake.max_stake);
    }

    onWin(profit) {
        this.tradeHistory.push({ result: 'win', profit, stake: this.currentStake });
        if (this.tradeHistory.length > 500) {
            this.tradeHistory = this.tradeHistory.slice(-250);
        }

        // Reset consecutive losses
        this.consecutiveLosses = 0;
        
        // Reset system state on win
        if (this.sys === 2) {
            if (this.sysCount >= 5) {
                this.sys = 1;
                this.sysCount = 0;
            }
        } else if (this.sys === 3) {
            if (this.sysCount >= 2) {
                this.sys = 1;
                this.sysCount = 0;
            }
        }
        
        // Reset to initial stake
        this.currentStake = CONFIG.stake.initial_stake;

        Logger.info(`📈 WIN! Profit: $${profit.toFixed(2)} | Stake reset to $${this.currentStake.toFixed(2)}`);
    }

    onLoss(loss) {
        this.tradeHistory.push({ result: 'loss', loss, stake: this.currentStake });
        if (this.tradeHistory.length > 500) {
            this.tradeHistory = this.tradeHistory.slice(-250);
        }

        this.consecutiveLosses++;
        
        // Track consecutive loss counters (x2, x3, x4 losses)
        if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
        else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
        else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;

        // Apply multiplier to calculate next stake
        this.currentStake = Math.ceil(this.currentStake * CONFIG.stake.multiplier * 100) / 100;
        
        // System progression logic from liveMultiAccumNew
        if (this.consecutiveLosses >= 2) {
            if (this.sys === 1) {
                this.sys = 2;
            } else if (this.sys === 2) {
                this.sys = 3;
            }
            this.sysCount = 0;
        }

        Logger.info(`📉 LOSS! Loss: $${loss.toFixed(2)} | Next stake: $${this.currentStake.toFixed(2)} | Consecutive: ${this.consecutiveLosses}`);
    }

    getConsecutiveLosses() {
        return this.consecutiveLosses;
    }

    isMaxLossesReached() {
        return this.consecutiveLosses >= CONFIG.risk.max_consecutive_losses;
    }

    reset() {
        this.currentStake = CONFIG.stake.initial_stake;
        this.consecutiveLosses = 0;
        this.sys = 1;
        this.sysCount = 0;
    }

    getSummary() {
        const stake = this.getCurrentStake();
        return `Stake: $${stake} | ConsLoss: ${this.consecutiveLosses} | x2:${this.consecutiveLosses2} x3:${this.consecutiveLosses3} x4:${this.consecutiveLosses4}`;
    }

    getLossCounters() {
        return {
            consecutiveLosses: this.consecutiveLosses,
            consecutiveLosses2: this.consecutiveLosses2,
            consecutiveLosses3: this.consecutiveLosses3,
            consecutiveLosses4: this.consecutiveLosses4
        };
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
        this.restoredTradeCount = 0;
    }

    recordTrade(trade) {
        this.trades.push({
            ...trade,
            timestamp: Date.now(),
            runningProfit: this.totalProfit,
        });

        // Trim trade history to prevent unbounded growth
        if (this.trades.length > 1000) {
            this.trades = this.trades.slice(-500);
        }

        if (trade.win) {
            this.totalWins++;
            this.totalProfit += trade.profit;
        } else {
            this.totalLosses++;
            this.totalProfit -= trade.loss;
        }

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
        if (this.getDailyLoss() >= CONFIG.risk.max_daily_loss) {
            Logger.warn(`🛑 Daily loss limit reached: $${this.getDailyLoss().toFixed(2)}`);
            return 'DAILY_LOSS_LIMIT';
        }

        if (this.getTradeCount() >= CONFIG.risk.max_daily_trades) {
            Logger.warn(`🛑 Daily trade limit reached: ${this.getTradeCount()}`);
            return 'DAILY_TRADE_LIMIT';
        }

        if (this.totalProfit >= CONFIG.risk.take_profit) {
            Logger.info(`🎯 Take profit reached: $${this.totalProfit.toFixed(2)}`);
            return 'TAKE_PROFIT';
        }

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

        // Core components — both use short_window from strategy config
        this.analyzer = new DigitAnalyzer(CONFIG.strategy.short_window);
        this.repeatCycleAnalyzer = new RepeatCycleAnalyzer(CONFIG.strategy);
        this.stakeManager = new StakeManager();
        this.tracker = new TradeTracker();

        // State management
        this.state = 'INITIALIZING';
        this.historyLoaded = false;
        this.cooldownTicksRemaining = 0;
        this.pendingContract = null;
        this.contractInProgress = false;
        this.tickSubscriptionId = null;
        this.requestId = 1;

        // Rate limiting
        this.lastTradeTime = 0;
        this.minTradeCooldown = 1500;

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
            const lossCounters = this.stakeManager.getLossCounters();
            const stateData = {
                savedAt: Date.now(),
                totalProfit: this.tracker.totalProfit,
                totalWins: this.tracker.totalWins,
                totalLosses: this.tracker.totalLosses,
                tradeCount: this.tracker.getTradeCount(),
                startBalance: this.tracker.startBalance,
                currentBalance: this.tracker.currentBalance,
                currentStake: this.stakeManager.currentStake,
                consecutiveLosses: this.stakeManager.consecutiveLosses,
                consecutiveLosses2: this.stakeManager.consecutiveLosses2,
                consecutiveLosses3: this.stakeManager.consecutiveLosses3,
                consecutiveLosses4: this.stakeManager.consecutiveLosses4,
                sys: this.stakeManager.sys,
                sysCount: this.stakeManager.sysCount,
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
            if (data.currentStake != null) this.stakeManager.currentStake = data.currentStake;
            if (data.consecutiveLosses != null) this.stakeManager.consecutiveLosses = data.consecutiveLosses;
            if (data.consecutiveLosses2 != null) this.stakeManager.consecutiveLosses2 = data.consecutiveLosses2;
            if (data.consecutiveLosses3 != null) this.stakeManager.consecutiveLosses3 = data.consecutiveLosses3;
            if (data.consecutiveLosses4 != null) this.stakeManager.consecutiveLosses4 = data.consecutiveLosses4;
            if (data.sys != null) this.stakeManager.sys = data.sys;
            if (data.sysCount != null) this.stakeManager.sysCount = data.sysCount;
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
            const lossCounters = this.stakeManager.getLossCounters();
            this.sendTelegram(`
                ⏰ <b>HOURLY — nFastGhost2 Repeat-Cycle Bot</b>

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
                ├ Stake: $${this.stakeManager.getCurrentStake().toFixed(2)}
                ├ Consecutive Losses: ${lossCounters.consecutiveLosses}
                ├ x2 Losses: ${lossCounters.consecutiveLosses2}
                ├ x3 Losses: ${lossCounters.consecutiveLosses3}
                ├ x4 Losses: ${lossCounters.consecutiveLosses4}
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

    async start() {
        this._printBanner();

        Logger.info('🚀 Starting Romanian Ghost Bot...');
        Logger.info(`📈 Symbol: ${CONFIG.symbol}`);
        Logger.info(`💰 Initial Stake: $${CONFIG.stake.initial_stake}`);
        Logger.info(`📊 Multiplier: ${CONFIG.stake.multiplier}x`);
        Logger.info(`🎯 Take Profit: $${CONFIG.risk.take_profit}`);
        Logger.info(`🛑 Max Daily Loss: $${CONFIG.risk.max_daily_loss}`);
        Logger.info(`📊 Short Window: ${CONFIG.strategy.short_window} ticks`);
        Logger.info(`📚 History Length: ${CONFIG.strategy.history_length} ticks`);

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
║   Strategy: Short-Cycle Repeat Saturation + Exhaustion    ║
║   Contract: DIGITDIFF (Digit Differs)                     ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
        `);
    }

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

                if (this.isRunning) {
                    Logger.info('🔄 Reconnecting in 5 seconds...');
                    setTimeout(() => this._connect(), 5000);
                }
            });

            setTimeout(() => {
                if (!this.isConnected) {
                    reject(new Error('Connection timeout'));
                }
            }, 15000);
        });
    }

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

    _authorize() {
        Logger.info('🔑 Authorizing...');
        this._send({
            authorize: this.apiToken,
        });
    }

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

    _onBalance(response) {
        if (response.balance) {
            this.tracker.currentBalance = parseFloat(response.balance.balance);
            Logger.debug(`💰 Balance updated: $${this.tracker.currentBalance.toFixed(2)}`);
        }
    }

    _requestTickHistory() {
        Logger.info(`📚 Requesting ${CONFIG.strategy.history_length} tick history for ${CONFIG.symbol}...`);
        this._send({
            ticks_history: CONFIG.symbol,
            adjust_start_time: 1,
            count: CONFIG.strategy.history_length,
            end: 'latest',
            start: 1,
            style: 'ticks',
        });
    }

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
                quote: prices[i],
                epoch: times[i] || null,
                symbol: CONFIG.symbol,
            };
            const digit = this.analyzer.addTick(tick);
            this.repeatCycleAnalyzer.addDigit(digit);
        }

        this.historyLoaded = true;

        // Force saturation learning after history load
        this.repeatCycleAnalyzer.forceLearn();
        const sat = this.repeatCycleAnalyzer.learnedSaturation;
        Logger.info(`📊 History warm-up complete. Tick count: ${this.analyzer.getTickCount()}`);
        Logger.info(`📊 Learned saturation threshold: ${sat != null ? (sat * 100).toFixed(1) + '%' : 'insufficient data — need more history'}`);

        this._printCycleAnalysis();

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

        // Log last 10 digits for visibility
        const recentTicks = this.analyzer.getRecentTicks(10);
        const digitsStr = recentTicks.map(t => t.digit).join(',');
        Logger.info(`🔢 Last 10 digits: [${digitsStr}]`);

        // Per-tick repeat-cycle stats for visibility
        const lastDigit = this.analyzer.getLastDigit();
        const cycleSignal = this.repeatCycleAnalyzer.getSignal(lastDigit);
        if (cycleSignal && cycleSignal.details) {
            const d = cycleSignal.details;
            const thresholdPct = (d.learnedSaturation * 100).toFixed(1);
            Logger.info(
                `🔬 REPEAT-CYCLE: ` +
                `short=${(d.shortRepeat * 100).toFixed(1)}% ` +
                `threshold=${thresholdPct}% ` +
                `mid=${(d.midRepeat * 100).toFixed(1)}% ` +
                `long=${(d.longRepeat * 100).toFixed(1)}% ` +
                `score=${cycleSignal.score} ` +
                `active=${cycleSignal.active}` +
                (d.peakInWindow ? ` peak=${(parseFloat(d.peakInWindow) * 100).toFixed(1)}%` : '') +
                (d.declineFraction ? ` decline=${(parseFloat(d.declineFraction) * 100).toFixed(1)}%` : '') +
                (d.declining !== undefined ? ` declining=${d.declining}` : '')
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
                this._handleTradingState();
                break;
            case 'COOLDOWN':
                this._handleCooldownState();
                break;
            case 'STOPPED':
                break;
        }
    }

    _handleCollectingState(tickCount) {
        if (tickCount >= CONFIG.strategy.min_ticks_before_start) {
            Logger.info('✅ Enough tick data collected. Moving to TRADING (repeat-cycle mode)...');
            this.state = 'TRADING';
            this._printCycleAnalysis();
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
        const lossCounters = this.stakeManager.getLossCounters();
        this.sendTelegram(`
            🛑 <b>BOT STOPPED — nFastGhost2</b>

            Reason: ${reason}

            📊 <b>Session summary nFastGhost2</b>
            ├ Trades: ${this.tracker.getTradeCount()}
            ├ W/L: ${this.tracker.totalWins}/${this.tracker.totalLosses}
            ├ Win rate: ${(this.tracker.getWinRate() * 100).toFixed(1)}%
            ├ Total P&L: $${this.tracker.totalProfit.toFixed(2)}
            ├ Balance: $${this.tracker.currentBalance.toFixed(2)}
            ├ x2 Losses: ${lossCounters.consecutiveLosses2}
            ├ x3 Losses: ${lossCounters.consecutiveLosses3}
            ├ x4 Losses: ${lossCounters.consecutiveLosses4}
            └ Runtime: ${runtimeMin} min
        `.trim());
    }

    /**
     * TRADING state - placing real trades based on short-cycle exhaustion only
     */
    _handleTradingState() {
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

        // Check cooldown trigger
        if (this.stakeManager.getConsecutiveLosses() >= CONFIG.strategy.loss_streak_cooldown_trigger) {
            Logger.warn(`❄️  Entering cooldown after ${this.stakeManager.getConsecutiveLosses()} losses`);
            this.cooldownTicksRemaining = CONFIG.strategy.cooldown_ticks_after_loss_streak;
            this.state = 'COOLDOWN';
            return;
        }

        // Don't place if contract in progress
        if (this.contractInProgress) return;

        // Rate limiting
        if (Date.now() - this.lastTradeTime < this.minTradeCooldown) return;

        // Generate signal — only fires on short-cycle exhaustion
        const signal = this._generateSignal();

        if(signal) console.log(`Confidence: ${(signal.confidence * 100).toFixed(0)}%`);

        if (signal.confidence > 0.75 && this.learnedSaturation2 < 50) {
            Logger.info(`Confidence: ${(signal.confidence * 100).toFixed(0)}%`);
            this._placeTrade(signal);
        }
    }

    _handleCooldownState() {
        this.cooldownTicksRemaining--;

        if (this.cooldownTicksRemaining % 5 === 0) {
            Logger.info(`❄️  Cooldown: ${this.cooldownTicksRemaining} ticks remaining`);
        }

        if (this.cooldownTicksRemaining <= 0) {
            Logger.info('✅ Cooldown complete. Re-entering TRADING...');
            this.state = 'TRADING';
            // Reset stake on cooldown completion
            this.stakeManager.currentStake = CONFIG.stake.initial_stake;
        }
    }

    /**
     * Generate trading signal.
     * Trade is taken ONLY when RepeatCycleAnalyzer detects short-cycle exhaustion.
     * The target digit is the HOT digit from the short window (the one that drove
     * repeats and is expected to stop appearing — DIFFERS from that digit).
     */
    _generateSignal() {
        if (!this.analyzer.hasEnoughData()) return null;

        const lastDigit = this.analyzer.getLastDigit();
        const cycleSignal = this.repeatCycleAnalyzer.getSignal(lastDigit);

        if (!cycleSignal.active) return null;

        // Use the hot digit from the short window as the DIFFERS target.
        // This is the digit that was most frequent during the saturation phase
        // and is now expected to exhaust (stop appearing as much).
        const hotDigitInfo = this.analyzer.getHotDigitInWindow(CONFIG.strategy.short_window);

        const confidence = Math.min(cycleSignal.score / 100, 1.0);

        return {
            digit: lastDigit,
            digitFrequency: hotDigitInfo.frequency,
            digitCount: hotDigitInfo.count,
            confidence,
            cycleScore: cycleSignal.score,
            cycleDetails: cycleSignal.details,
            shortRepeat: cycleSignal.details ? cycleSignal.details.shortRepeat : 0,
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
        Logger.info('═'.repeat(55));
        Logger.info(`🎲 PLACING TRADE: Digit Differs from ${signal.digit} (hot digit)`);
        Logger.info(`💰 Stake: $${stake} | Confidence: ${(signal.confidence * 100).toFixed(0)}%`);
        Logger.info(`📊 ${this.stakeManager.getSummary()}`);
        Logger.info(`🔥 Hot digit ${signal.digit}: appeared ${signal.digitCount} times (${(signal.digitFrequency * 100).toFixed(0)}%) in last ${CONFIG.strategy.short_window} ticks`);
        Logger.info(`📈 Repeat-cycle score: ${signal.cycleScore} | Short repeat: ${(signal.shortRepeat * 100).toFixed(1)}%`);

        if (signal.cycleDetails) {
            const d = signal.cycleDetails;
            Logger.info(
                `🔬 Cycle detail: ` +
                `short=${(d.shortRepeat * 100).toFixed(1)}% ` +
                `threshold=${(d.learnedSaturation * 100).toFixed(1)}% ` +
                `mid=${(d.midRepeat * 100).toFixed(1)}% ` +
                `long=${(d.longRepeat * 100).toFixed(1)}%` +
                (d.peakInWindow ? ` peak=${(parseFloat(d.peakInWindow) * 100).toFixed(1)}%` : '') +
                (d.declineFraction ? ` decline=${(parseFloat(d.declineFraction) * 100).toFixed(1)}%` : '')
            );
        }

        const recentTicks = this.analyzer.getRecentTicks(10);
        const digitsStr = recentTicks.map(t => t.digit).join(',');
        Logger.info(`🔢 Last 10 digits before trade: [${digitsStr}]`);
        Logger.info('═'.repeat(55));

        const d = signal.cycleDetails || {};
        const th = (d.learnedSaturation != null ? d.learnedSaturation * 100 : 0).toFixed(1);
        const sh = (d.shortRepeat != null ? d.shortRepeat * 100 : 0).toFixed(1);
        const lossCounters = this.stakeManager.getLossCounters();
        this.sendTelegram(`
            🎯 <b>TRADE OPENED — nFastGhost2 Repeat-Cycle</b>

            📊 Symbol: ${CONFIG.symbol}
            🔢 Digit Differs: ${signal.digit} (hot digit, ${(signal.digitFrequency * 100).toFixed(0)}% in window)
            📈 Last 10 digits: ${recentTicks.map(t => t.digit).join(',')}

            🔬 <b>Repeat-Cycle</b>
            ├ Short: ${sh}% | Threshold: ${th}%
            ├ Score: ${signal.cycleScore}
            └ Exhaustion detected (multi-tick decline from peak)

            💰 Stake: $${stake.toFixed(2)}
            📊 ConsLoss: ${lossCounters.consecutiveLosses} | x2:${lossCounters.consecutiveLosses2} x3:${lossCounters.consecutiveLosses3} x4:${lossCounters.consecutiveLosses4}
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

        this._send({
            proposal_open_contract: 1,
            contract_id: buy.contract_id,
            subscribe: 1,
        });
    }

    _onContractUpdate(response) {
        if (!response.proposal_open_contract) return;

        const contract = response.proposal_open_contract;

        if (contract.is_sold || contract.status === 'sold') {
            this._onContractSettled(contract);
        }
    }

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

        const exitQuote = contract.exit_tick_display_value != null
            ? contract.exit_tick_display_value
            : (contract.sell_price || '');
        const exitDigit = exitQuote !== ''
            ? getLastDigitFromQuote(exitQuote, CONFIG.symbol)
            : '—';
        const last10 = this.analyzer.getRecentTicks(10).map(t => t.digit).join(',');

        const lossCounters = this.stakeManager.getLossCounters();
        this.sendTelegram(`
            ${isWin ? '✅ <b>WIN</b>' : '❌ <b>LOSS</b>'} — nFastGhost2

            📊 Symbol: ${CONFIG.symbol}
            🎯 Differs target: ${signal ? signal.digit : '?'}
            🔢 Exit digit: ${exitDigit}
            📈 Last 10: ${last10}

            💰 P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}
            💵 Session P&L: $${this.tracker.totalProfit.toFixed(2)}
            📊 Balance: $${this.tracker.currentBalance.toFixed(2)}
            📊 Record: ${this.tracker.totalWins}W/${this.tracker.totalLosses}L | Win rate: ${(this.tracker.getWinRate() * 100).toFixed(1)}%
            💲 Next stake: $${this.stakeManager.getCurrentStake().toFixed(2)}
            📉 ConsLoss: ${lossCounters.consecutiveLosses} | x2:${lossCounters.consecutiveLosses2} x3:${lossCounters.consecutiveLosses3} x4:${lossCounters.consecutiveLosses4}
        `.trim());

        const digitsStr = this.analyzer.getRecentTicks(10).map(t => t.digit).join(',');
        Logger.info(`🔢 Last 10 digits at settlement: [${digitsStr}]`);

        if (signal && signal.cycleDetails) {
            const d = signal.cycleDetails;
            Logger.info(
                `🔬 Trade cycle context: ` +
                `short=${(d.shortRepeat * 100).toFixed(1)}% ` +
                `threshold=${(d.learnedSaturation * 100).toFixed(1)}% ` +
                `mid=${(d.midRepeat * 100).toFixed(1)}% ` +
                `long=${(d.longRepeat * 100).toFixed(1)}% ` +
                `score=${signal.cycleScore}`
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

    _onTransaction(response) {
        if (response.transaction) {
            const tx = response.transaction;
            Logger.debug(`💳 Transaction: ${tx.action} | Amount: ${tx.amount} | Balance: ${tx.balance}`);

            if (tx.balance) {
                this.tracker.currentBalance = parseFloat(tx.balance);
            }
        }
    }

    _handleError(response) {
        const error = response.error;
        Logger.error(`API Error [${error.code}]: ${error.message}`);

        switch (error.code) {
            case 'AuthorizationRequired':
            case 'InvalidToken':
                Logger.error('❌ Authentication failed. Please check your API token.');
                this.state = 'STOPPED';
                break;

            case 'RateLimit':
                Logger.warn('⚠️  Rate limited. Waiting 10 seconds...');
                this.contractInProgress = false;
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
                if (response.msg_type === 'buy') {
                    this.contractInProgress = false;
                    this.pendingContract = null;
                }
        }
    }

    /**
     * Print repeat-cycle analysis summary
     */
    _printCycleAnalysis() {
        const lastDigit = this.analyzer.getLastDigit();
        const cycleSignal = this.repeatCycleAnalyzer.getSignal(lastDigit);

        console.log('\n🔬 REPEAT-CYCLE ANALYSIS:');
        console.log('─'.repeat(60));

        const sat = this.repeatCycleAnalyzer.learnedSaturation;
        console.log(`  Learned saturation: ${sat != null ? (sat * 100).toFixed(1) + '%' : 'not yet learned'}`);
        console.log(`  History ticks: ${this.repeatCycleAnalyzer.digits.length}`);
        console.log(`  Repeats tracked: ${this.repeatCycleAnalyzer.repeats.length}`);
        console.log(`  Short window: ${CONFIG.strategy.short_window} ticks`);

        if (cycleSignal && cycleSignal.details) {
            const d = cycleSignal.details;
            console.log(`  Current short repeat: ${(d.shortRepeat * 100).toFixed(1)}%`);
            console.log(`  Mid repeat: ${(d.midRepeat * 100).toFixed(1)}%`);
            console.log(`  Long repeat: ${(d.longRepeat * 100).toFixed(1)}%`);
            console.log(`  Score: ${cycleSignal.score} | Active: ${cycleSignal.active}`);
            if (d.peakInWindow) console.log(`  Peak in lookback: ${(parseFloat(d.peakInWindow) * 100).toFixed(1)}%`);
            if (d.declineFraction) console.log(`  Decline from peak: ${(parseFloat(d.declineFraction) * 100).toFixed(1)}%`);
            if (d.declining !== undefined) console.log(`  Declining trend: ${d.declining}`);
            if (d.reason) console.log(`  Reason: ${d.reason}`);
        }

        const hotDigit = this.analyzer.getHotDigitInWindow(CONFIG.strategy.short_window);
        console.log(`  Hot digit: ${hotDigit.digit} (${(hotDigit.frequency * 100).toFixed(1)}%, count=${hotDigit.count}/${CONFIG.strategy.short_window})`);
        console.log('─'.repeat(60) + '\n');
    }
}

// ============================================================================
// CLI INTERFACE
// ============================================================================
async function main() {
    const args = process.argv.slice(2);
    let apiToken = CONFIG.api_token || process.env.DERIV_API_TOKEN;

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
                CONFIG.stake.initial_stake = parseFloat(args[++i]);
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

    if (!apiToken) {
        apiToken = await promptToken();
    }

    if (!apiToken) {
        console.error('❌ API token is required. Use --token <token> or set DERIV_API_TOKEN env variable.');
        process.exit(1);
    }

    if (apiToken.length < 10) {
        console.error('❌ Invalid API token format.');
        process.exit(1);
    }

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
    --symbol, -s <symbol>   Trading symbol (default: R_75)
                            Options: R_10, R_25, R_50, R_75, R_100
                                     1HZ10V, 1HZ25V, 1HZ50V, 1HZ75V, 1HZ100V
    --stake <amount>        Base stake in USD (default: 0.61)
    --take-profit, --tp     Take profit target (default: 30.00)
    --stop-loss, --sl       Max daily loss limit (default: 100.00)
    --debug                 Enable debug logging
    --help, -h              Show this help message

EXAMPLES:
    node bot.js --token YOUR_TOKEN_HERE
    node bot.js -t YOUR_TOKEN -s R_50 --stake 0.50 --tp 20
    DERIV_API_TOKEN=xxx node bot.js --debug

ENVIRONMENT VARIABLES:
    DERIV_API_TOKEN         Deriv API token
    DERIV_APP_ID            Deriv app ID (default: 1089)
    TELEGRAM_BOT_TOKEN      Telegram bot token for notifications
    TELEGRAM_CHAT_ID        Telegram chat ID for notifications

STRATEGY:
    1. Loads 5000 ticks of history and learns repeat-rate saturation threshold
    2. Divides history into sliding 50-tick short-cycle windows
    3. Identifies saturation level: the repeat rate before ticks drop to very low repeat
    4. Monitors live short-cycle repeat rate in real time
    5. When short repeat reaches learned saturation and starts declining (exhaustion):
       - Identifies the hot digit (most frequent in short window)
       - Places "Digit Differs" contract on that hot digit
    6. Uses modified Fibonacci (0.91x multiplier) for stake recovery
    7. Implements cooldown periods after loss streaks
    8. Comprehensive risk management with stop-loss and take-profit

NOTES:
    - Get your API token at: https://app.deriv.com/account/api-token
    - Required token scopes: Read, Trade
    - Start with a DEMO account
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
