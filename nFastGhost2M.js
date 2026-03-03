#!/usr/bin/env node

/**
 * ============================================================================
 * ROMANIAN GHOST - BLACK FIBONACCI 9.1 MULTI-ASSET
 * Deriv Digit Differ Trading Bot - Multi-Asset Version
 * ============================================================================
 *
 * Strategy: Performs deep saturation learning over 5000 ticks of history
 * using sliding 50-tick short-cycle windows to analyze digit repeat-rate
 * patterns. Builds a histogram of all peak repeat-rate percentages observed
 * immediately before the market transitions into a regime of none or very
 * low digit repetition (≤6%). From this histogram, identifies the highest
 * consistently-occurring peak saturation level — the repeat-rate ceiling
 * that the market reliably hits before exhaustion and regime collapse.
 *
 * Simultaneously identifies the "saturation hot digit" — the specific
 * digit most frequently responsible for driving repeat-rates to their
 * peak across all historical saturation events. This is the digit whose
 * consecutive appearances inflate the repeat-rate to saturation before
 * the pattern breaks.
 *
 * During live trading, monitors the real-time short-cycle repeat-rate.
 * When it reaches the learned peak saturation level and a multi-tick
 * declining exhaustion trend is detected (at least 3 consecutive drops
 * with ≥15% decline from peak, while not yet fully collapsed), the bot
 * executes a DIGITDIFF trade using the saturation hot digit as the
 * barrier — betting that the digit which drove the repeats to exhaustion
 * will now differ from the next tick's outcome as the regime shifts.
 *
 * Multi-Asset: Tracks R_10, R_25, R_50, R_75, RDBULL, and RDBEAR
 * simultaneously, generating independent saturation models per asset
 * and trading on whichever asset presents the strongest exhaustion
 * signal with the highest confidence score.
 *
 * DISCLAIMER: Trading involves substantial risk. This bot is for
 * educational purposes. Use on demo accounts first. Past performance
 * does not guarantee future results.
 * ============================================================================
 */

require('dotenv').config();
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

const STATE_FILE = path.join(__dirname, 'nFastGhostMMulti000003-state.json');
const STATE_SAVE_INTERVAL = 5000;

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
    // Deriv API Configuration
    app_id: '1089',
    endpoint: 'wss://ws.derivws.com/websockets/v3',

    // Account — use environment variables
    api_token: '0P94g4WdSrSrzir',

    // Multi-Asset Configuration
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'RDBULL', 'RDBEAR'],

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

    // Multiplier-based Stake Management
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
        take_profit: 3000.00,
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
// STATE PERSISTENCE MANAGER
// ============================================================================
class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                config: {
                    initial_stake: CONFIG.stake.initial_stake,
                    multiplier: CONFIG.stake.multiplier,
                    max_consecutive_losses: CONFIG.risk.max_consecutive_losses,
                    stop_loss: CONFIG.risk.max_daily_loss,
                    take_profit: CONFIG.risk.take_profit,
                    history_length: CONFIG.strategy.history_length,
                },
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    consecutiveLosses2: bot.consecutiveLosses2,
                    consecutiveLosses3: bot.consecutiveLosses3,
                    consecutiveLosses4: bot.consecutiveLosses4,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    sys: bot.sys,
                    sysCount: bot.sysCount,
                },
                subscriptions: {
                    tickSubscriptionIds: { ...bot.tickSubscriptionIds },
                    activeSubscriptions: Array.from(bot.activeSubscriptions),
                    contractSubscription: bot.contractSubscription,
                },
                assets: {},
            };

            // Save analyzer state for each asset
            CONFIG.assets.forEach(asset => {
                if (bot.analyzers[asset] && bot.cycleAnalyzers[asset]) {
                    persistableState.assets[asset] = {
                        tickHistory: bot.analyzers[asset].digitHistory.slice(-100),
                        cycleDigits: bot.cycleAnalyzers[asset].digits.slice(-100),
                        cycleRepeats: bot.cycleAnalyzers[asset].repeats.slice(-100),
                    };
                }
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
        } catch (error) {
            console.error(`Failed to save state: ${error.message}`);
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                console.log('📂 No previous state file found, starting fresh');
                return false;
            }

            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            // Only restore if state is less than 30 minutes old
            if (ageMinutes > 30) {
                console.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            console.log(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);
            return savedData;
        } catch (error) {
            console.error(`Failed to load state: ${error.message}`);
            return false;
        }
    }

    static startAutoSave(bot) {
        setInterval(() => {
            StatePersistence.saveState(bot);
        }, STATE_SAVE_INTERVAL);
        console.log('🔄 Auto-save started (every 5 seconds)');
    }
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
        const asset = tick.symbol;
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
        const window = this.getRecentDigits();
        if (window.length === 0) return 'No data';

        const digitDisplay = window.slice(-15).join(',');
        const hotDigit = this.getHotDigitInWindow();

        return `Last15:[${digitDisplay}] | Hot:${hotDigit.digit}(${(hotDigit.frequency * 100).toFixed(0)}%)`;
    }
}

// ============================================================================
// REPEAT CYCLE ANALYZER
// ============================================================================
class RepeatCycleAnalyzer {
    constructor(config) {
        this.maxHistory = config.history_length || 5000;
        this.shortWindow = config.short_window || 50;
        this.nonRepMaxRepeat = 0.06;
        this.minSamplesForLearning = 10;

        this.digits = [];
        this.repeats = [];
        this.tickCount = 0;

        this.learnedSaturation = null;
        this.shortHistory = [];
        this.exhaustionLookback = 6;
        this.signalHoldTicks = 3;
        this.signalHold = null;
        this.lastSnapshot = null;

        // New: track the hot digit that drove the saturation peak
        this.saturationHotDigit = null;
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

    _updateLearnedSaturation() {
        const w = this.shortWindow;
        if (this.repeats.length < w * 3) return;

        // Phase 1: Collect all peak repeat-rates that precede a collapse
        // to none/very-low-repeat regime
        const peakSamples = [];
        const step = Math.max(1, Math.floor(w / 4));
        const maxStart = this.repeats.length - (2 * w);

        for (let i = 0; i <= maxStart; i += step) {
            // Compute repeat-rate in current window [i, i+w)
            let sumCur = 0;
            for (let j = i; j < i + w; j++) sumCur += this.repeats[j];
            const rateCur = sumCur / w;

            // Compute repeat-rate in the next window [i+w, i+2w)
            let sumNext = 0;
            for (let j = i + w; j < i + 2 * w; j++) sumNext += this.repeats[j];
            const rateNext = sumNext / w;

            // Only consider windows where the next period collapses
            // to none/very low repeat regime
            if (rateNext <= this.nonRepMaxRepeat && rateCur > this.nonRepMaxRepeat) {
                peakSamples.push({ rate: rateCur, windowStart: i });
            }
        }

        if (peakSamples.length < this.minSamplesForLearning) {
            return;
        }

        // Phase 2: Find the most consistent HIGH saturation level
        // We look for the peak repeat-rate that appears most frequently
        // before collapse events.

        // Sort by rate descending to focus on highest peaks
        peakSamples.sort((a, b) => b.rate - a.rate);

        // Build a histogram with bins to find the most common peak level
        // Bin size of 2% (0.02) for repeat-rate granularity
        const binSize = 0.02;
        const histogram = new Map();

        for (const sample of peakSamples) {
            const binKey = Math.round(sample.rate / binSize) * binSize;
            const binKeyStr = binKey.toFixed(4);
            if (!histogram.has(binKeyStr)) {
                histogram.set(binKeyStr, { count: 0, totalRate: 0, samples: [] });
            }
            const bin = histogram.get(binKeyStr);
            bin.count++;
            bin.totalRate += sample.rate;
            bin.samples.push(sample);
        }

        // Find the highest bin that has meaningful frequency
        // "Meaningful" = at least 15% of total samples or minimum 3 occurrences
        const minBinCount = Math.max(4, Math.floor(peakSamples.length * 0.10));

        let bestBin = null;
        let bestBinRate = 0;

        // Sort bins by their rate value (descending) - pick highest that qualifies
        const sortedBins = Array.from(histogram.entries())
            .map(([key, val]) => ({
                binRate: parseFloat(key),
                count: val.count,
                avgRate: val.totalRate / val.count,
                samples: val.samples,
            }))
            .sort((a, b) => b.binRate - a.binRate);

        // First pass: find highest bin with sufficient frequency
        for (const bin of sortedBins) {
            if (bin.count >= minBinCount) {
                bestBin = bin;
                bestBinRate = bin.avgRate;
                break;
            }
        }

        // Fallback: if no single bin qualifies, merge adjacent top bins
        if (!bestBin) {
            // Try merging top 2-3 adjacent bins
            for (let i = 0; i < sortedBins.length - 1; i++) {
                const merged = sortedBins[i].count + sortedBins[i + 1].count;
                if (merged >= minBinCount) {
                    // Use the higher bin's average rate
                    bestBin = sortedBins[i];
                    bestBinRate = sortedBins[i].avgRate;
                    break;
                }
            }
        }

        // Final fallback: use the top 25% percentile (highest peaks)
        if (!bestBin) {
            const topQuartileIdx = Math.floor(peakSamples.length * 0.25);
            const topQuartile = peakSamples.slice(0, Math.max(1, topQuartileIdx));
            let sum = 0;
            for (const s of topQuartile) sum += s.rate;
            bestBinRate = sum / topQuartile.length;
            bestBin = { samples: topQuartile, avgRate: bestBinRate };
        }

        // Set the learned saturation to the identified peak level
        this.learnedSaturation = bestBinRate;

        // Phase 3: Identify the hot digit that drove repeats at peak saturation
        // Look at the digit windows corresponding to peak saturation moments
        this._identifyPeakHotDigit(bestBin.samples);
    }

    /**
     * Identifies which digit was most responsible for driving the
     * repeat-rate to saturation level in the peak windows.
     * This digit will be used for the DIGITDIFF trade.
     */
    _identifyPeakHotDigit(peakWindowSamples) {
        if (!peakWindowSamples || peakWindowSamples.length === 0) return;

        const w = this.shortWindow;
        const digitFreqTotal = new Array(10).fill(0);

        for (const sample of peakWindowSamples) {
            const windowStart = sample.windowStart;
            // Map repeat index back to digit index (repeats[i] corresponds
            // to transition between digits[i] and digits[i+1])
            const digitStart = windowStart;
            const digitEnd = Math.min(digitStart + w + 1, this.digits.length);

            // Count consecutive repeats per digit in this window
            const digitRepeatCount = new Array(10).fill(0);
            for (let j = digitStart; j < digitEnd - 1; j++) {
                if (j < this.repeats.length && this.repeats[j] === 1) {
                    // The digit that repeated
                    if (j + 1 < this.digits.length) {
                        digitRepeatCount[this.digits[j + 1]]++;
                    }
                }
            }

            // Find the digit with most repeats in this peak window
            let maxRepeats = 0;
            let hotDigit = 0;
            for (let d = 0; d < 10; d++) {
                if (digitRepeatCount[d] > maxRepeats) {
                    maxRepeats = digitRepeatCount[d];
                    hotDigit = d;
                }
            }

            digitFreqTotal[hotDigit]++;
        }

        // The digit most frequently identified as "hot" across peak windows
        let overallHotDigit = 0;
        let maxFreq = 0;
        for (let d = 0; d < 10; d++) {
            if (digitFreqTotal[d] > maxFreq) {
                maxFreq = digitFreqTotal[d];
                overallHotDigit = d;
            }
        }

        this.saturationHotDigit = overallHotDigit;
    }

    forceLearn() {
        this._updateLearnedSaturation();
    }

    addDigit(digit) {
        this._pushDigit(digit);

        if (this.repeats.length < this.shortWindow + 5) return;

        if (this.tickCount % Math.floor(this.shortWindow / 2) === 0) {
            this._updateLearnedSaturation();
        }

        const shortNow = this._windowMeanFromEnd(this.repeats, this.shortWindow);
        this.shortHistory.push(shortNow);
        if (this.shortHistory.length > 30) this.shortHistory.shift();

        const midRepeat = this._windowMeanFromEnd(this.repeats, this.shortWindow * 2);
        const longRepeat = this._fullMean(this.repeats);

        this.lastSnapshot = { shortRepeat: shortNow, midRepeat, longRepeat };
    }

    /**
     * getSignal() - Enhanced to use the hot digit from saturation analysis
     * and execute DIGITDIFF on that specific digit when exhaustion is detected.
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
            saturationHotDigit: this.saturationHotDigit,
        };

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

        const recent = this.shortHistory.slice(-this.exhaustionLookback);
        const peakInWindow = Math.max(...recent);
        const currentVal = recent[recent.length - 1];

        const peakReachedSat = peakInWindow >= sat;
        const declineFraction = peakInWindow > 0
            ? (peakInWindow - currentVal) / peakInWindow
            : 0;
        const meaningfulDecline = declineFraction >= 0.15;
        const notCollapsed = currentVal >= this.nonRepMaxRepeat;
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
                saturationHotDigit: this.saturationHotDigit,
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
// MAIN BOT - Multi-Asset Romanian Ghost
// ============================================================================
class MultiAssetGhostBot {
    constructor(apiToken, config = {}) {
        this.apiToken = apiToken;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.isAuthorized = false;

        // Multi-asset configuration
        this.assets = CONFIG.assets;

        // Per-asset components
        this.analyzers = {};
        this.cycleAnalyzers = {};
        this.historyLoaded = {};
        this.lastTickLogTime = {};

        // Initialize per-asset components
        this.assets.forEach(asset => {
            this.analyzers[asset] = new DigitAnalyzer(CONFIG.strategy.short_window);
            this.cycleAnalyzers[asset] = new RepeatCycleAnalyzer(CONFIG.strategy);
            this.historyLoaded[asset] = false;
            this.lastTickLogTime[asset] = 0;
        });

        // Trading state
        this.currentStake = config.initialStake || CONFIG.stake.initial_stake;
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.suspendedAssets = new Set();
        this.sys = 1;
        this.sysCount = 0;

        // Contract tracking
        this.contractSubscription = null;
        this.pendingContract = null;
        this.currentAsset = null;

        // Reconnection logic
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 5000;
        this.reconnectTimer = null;
        this.isReconnecting = false;

        // Heartbeat/Ping
        this.pingInterval = null;
        this.checkDataInterval = null;
        this.pongTimeout = null;
        this.lastPongTime = Date.now();
        this.lastDataTime = Date.now();
        this.pingIntervalMs = 20000;
        this.pongTimeoutMs = 10000;
        this.dataTimeoutMs = 60000;

        // Message queue
        this.messageQueue = [];
        this.maxQueueSize = 50;

        // Subscriptions
        this.activeSubscriptions = new Set();
        this.tickSubscriptionIds = {};

        // Rate limiting
        this.lastTradeTime = 0;
        this.minTradeCooldown = 1500;

        // Cooldown
        this.cooldownTicksRemaining = 0;
        this.state = 'INITIALIZING';

        // Stats
        this.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };
        this.sessionStartTime = Date.now();

        // Telegram
        this.telegramBot = null;
        this.telegramEnabled = !!(TelegramBot && CONFIG.telegram_bot_token && CONFIG.telegram_chat_id);
        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(CONFIG.telegram_bot_token, { polling: false });
            this.startTelegramTimer();
        }

        // End of day flag
        this.endOfDay = false;

        this._setupSignalHandlers();
        this.loadSavedState();
    }

    loadSavedState() {
        const savedState = StatePersistence.loadState();
        if (!savedState) return;

        try {
            const trading = savedState.trading;
            this.currentStake = trading.currentStake || CONFIG.stake.initial_stake;
            this.consecutiveLosses = trading.consecutiveLosses || 0;
            this.consecutiveLosses2 = trading.consecutiveLosses2 || 0;
            this.consecutiveLosses3 = trading.consecutiveLosses3 || 0;
            this.consecutiveLosses4 = trading.consecutiveLosses4 || 0;
            this.totalTrades = trading.totalTrades || 0;
            this.totalWins = trading.totalWins || 0;
            this.totalLosses = trading.totalLosses || 0;
            this.totalProfitLoss = trading.totalProfitLoss || 0;
            this.sys = trading.sys || 1;
            this.sysCount = trading.sysCount || 0;

            // Restore asset histories
            if (savedState.assets) {
                Object.keys(savedState.assets).forEach(asset => {
                    if (this.analyzers[asset] && savedState.assets[asset].tickHistory) {
                        this.analyzers[asset].digitHistory = savedState.assets[asset].tickHistory || [];
                    }
                    if (this.cycleAnalyzers[asset]) {
                        this.cycleAnalyzers[asset].digits = savedState.assets[asset].cycleDigits || [];
                        this.cycleAnalyzers[asset].repeats = savedState.assets[asset].cycleRepeats || [];
                    }
                });
            }

            console.log('✅ State restored successfully');
            console.log(`   Trades: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalLosses}`);
            console.log(`   P&L: $${this.totalProfitLoss.toFixed(2)} | Current Stake: $${this.currentStake.toFixed(2)}`);
        } catch (error) {
            console.error(`Error restoring state: ${error.message}`);
        }
    }

    // ============================================================================
    // WEBSOCKET & CONNECTION
    // ============================================================================
    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('Already connected');
            return;
        }

        console.log('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket(`${CONFIG.endpoint}?app_id=${CONFIG.app_id}`);

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.wsReady = false;
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            this.lastPongTime = Date.now();
            this.lastDataTime = Date.now();

            this.startMonitor();
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            this.lastPongTime = Date.now();
            this.lastDataTime = Date.now();
            try {
                const message = JSON.parse(data);
                this.handleMessage(message);
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error.message);
        });

        this.ws.on('close', (code, reason) => {
            console.log(`Disconnected from Deriv API (Code: ${code}, Reason: ${reason || 'None'})`);
            this.handleDisconnect();
        });

        this.ws.on('pong', () => {
            this.lastPongTime = Date.now();
        });
    }

    startMonitor() {
        this.stopMonitor();

        this.pingInterval = setInterval(() => {
            if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();

                this.pongTimeout = setTimeout(() => {
                    const timeSinceLastPong = Date.now() - this.lastPongTime;
                    if (timeSinceLastPong > this.pongTimeoutMs) {
                        console.warn('⚠️ No pong received, connection may be dead');
                    }
                }, this.pongTimeoutMs);
            }
        }, this.pingIntervalMs);

        this.checkDataInterval = setInterval(() => {
            if (!this.connected) return;

            const silenceDuration = Date.now() - this.lastDataTime;
            if (silenceDuration > this.dataTimeoutMs) {
                console.error(`⚠️ No data for ${Math.round(silenceDuration / 1000)}s - Forcing reconnection...`);
                StatePersistence.saveState(this);
                if (this.ws) this.ws.terminate();
            }
        }, 10000);

        console.log('🔄 Connection monitoring started');
    }

    stopMonitor() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.checkDataInterval) {
            clearInterval(this.checkDataInterval);
            this.checkDataInterval = null;
        }
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    sendRequest(request) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('Cannot send request: WebSocket not ready');
            if (this.messageQueue.length < this.maxQueueSize) {
                this.messageQueue.push(request);
            }
            return false;
        }

        try {
            this.ws.send(JSON.stringify(request));
            return true;
        } catch (error) {
            console.error('Error sending request:', error.message);
            if (this.messageQueue.length < this.maxQueueSize) {
                this.messageQueue.push(request);
            }
            return false;
        }
    }

    processMessageQueue() {
        if (this.messageQueue.length === 0) return;

        console.log(`Processing ${this.messageQueue.length} queued messages...`);
        const queue = [...this.messageQueue];
        this.messageQueue = [];

        queue.forEach(message => {
            this.sendRequest(message);
        });
    }

    authenticate() {
        this.sendRequest({ authorize: this.apiToken });
    }

    // ============================================================================
    // MESSAGE HANDLING
    // ============================================================================
    handleMessage(message) {
        if (message.msg_type === 'ping') {
            this.sendRequest({ ping: 1 });
            return;
        }

        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                this.sendTelegramMessage(`❌ <b>Authentication Failed:</b> ${message.error.message}`);
                return;
            }
            console.log('✅ Authenticated successfully');
            const auth = message.authorize;
            console.log(`   Account: ${auth.fullname || auth.loginid} | Balance: $${auth.balance} ${auth.currency}`);
            
            if (!auth.is_virtual) {
                console.warn('⚠️  WARNING: You are using a REAL account! Be cautious!');
            }
            
            this.wsReady = true;
            this.processMessageQueue();
            this.initializeSubscriptions();

        } else if (message.msg_type === 'history') {
            const asset = message.echo_req.ticks_history;
            this.handleTickHistory(asset, message.history);
        } else if (message.msg_type === 'tick') {
            if (message.subscription) {
                const asset = message.tick.symbol;
                this.tickSubscriptionIds[asset] = message.subscription.id;
                this.activeSubscriptions.add(message.subscription.id);
            }
            this.handleTickUpdate(message.tick);
        } else if (message.msg_type === 'buy') {
            if (message.error) {
                console.error('Error placing trade:', message.error.message);
                this.sendTelegramMessage(`❌ <b>Trade Error:</b> ${message.error.message}`);
                this.tradeInProgress = false;
                return;
            }
            console.log('✅ Trade placed successfully');
            this.subscribeToOpenContract(message.buy.contract_id);
        } else if (message.msg_type === 'proposal_open_contract') {
            if (message.proposal_open_contract.is_sold) {
                this.handleTradeResult(message.proposal_open_contract);
            }
        } else if (message.error) {
            console.error('API Error:', message.error.message);
            if (message.error.code === 'AuthorizationRequired' ||
                message.error.code === 'InvalidToken') {
                console.log('Auth error detected, triggering reconnection...');
                this.handleDisconnect();
            }
        }
    }

    initializeSubscriptions() {
        console.log('📊 Initializing/restoring subscriptions...');
        this.assets.forEach(asset => {
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: CONFIG.strategy.history_length,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });

            this.sendRequest({
                ticks: asset,
                subscribe: 1
            });
        });
        
        this.state = 'COLLECTING';
        console.log(`📊 State: COLLECTING (need ${CONFIG.strategy.min_ticks_before_start} ticks per asset)`);
    }

    // ============================================================================
    // TICK HANDLING
    // ============================================================================
    handleTickHistory(asset, history) {
        if (!this.analyzers[asset] || !history || !history.prices) return;

        const prices = history.prices;
        const times = history.times || [];

        for (let i = 0; i < prices.length; i++) {
            const tick = {
                quote: prices[i],
                epoch: times[i] || null,
                symbol: asset,
            };
            const digit = this.analyzers[asset].addTick(tick);
            this.cycleAnalyzers[asset].addDigit(digit);
        }

        this.historyLoaded[asset] = true;
        this.cycleAnalyzers[asset].forceLearn();

        const sat = this.cycleAnalyzers[asset].learnedSaturation;
        const hotD = this.cycleAnalyzers[asset].saturationHotDigit;
        console.log(
            `📚 Loaded ${prices.length} ticks for ${asset}` +
            ` | Peak Saturation: ${sat != null ? (sat * 100).toFixed(1) + '%' : 'learning...'}` +
            ` | Hot Digit: ${hotD != null ? hotD : '---'}`
        );
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;

        if (!this.analyzers[asset]) return;

        const digit = this.analyzers[asset].addTick(tick);
        this.cycleAnalyzers[asset].addDigit(digit);

        const analyzer = this.analyzers[asset];
        const cycleAnalyzer = this.cycleAnalyzers[asset];
        const recent = analyzer.getRecentDigits(5);
        const sat = cycleAnalyzer.learnedSaturation;
        const satHotDigit = cycleAnalyzer.saturationHotDigit;
        const snapshot = cycleAnalyzer.lastSnapshot;
        const shortRepeat = snapshot ? (snapshot.shortRepeat * 100).toFixed(1) : '---';

        const now = Date.now();
        if (!this.tradeInProgress && now - (this.lastTickLogTime[asset] || 0) >= 30000) {
            console.log(
                `[${asset}] ${tick.quote}: ${recent.join(',')}` +
                ` | ShortR: ${shortRepeat}%` +
                ` | PeakSat: ${sat != null ? (sat * 100).toFixed(1) + '%' : '---'}` +
                ` | SatHot: ${satHotDigit != null ? satHotDigit : '---'}`
            );
            this.lastTickLogTime[asset] = now;
        } else if (this.tradeInProgress) {
            console.log(
                `[${asset}] ${tick.quote}: ${recent.join(',')}` +
                ` | ShortR: ${shortRepeat}%` +
                ` | PeakSat: ${sat != null ? (sat * 100).toFixed(1) + '%' : '---'}` +
                ` | SatHot: ${satHotDigit != null ? satHotDigit : '---'}`
            );
        }

        // State machine
        if (!this.tradeInProgress && this.wsReady) {
            switch (this.state) {
                case 'COLLECTING':
                    this.handleCollectingState();
                    break;
                case 'TRADING':
                    this.handleTradingState(asset);
                    break;
                case 'COOLDOWN':
                    this.handleCooldownState();
                    break;
            }
        }
    }

    handleCollectingState() {
        const allReady = this.assets.every(asset => 
            this.analyzers[asset].hasEnoughData()
        );
        
        if (allReady) {
            console.log('✅ All assets have enough data. Moving to TRADING...');
            this.state = 'TRADING';
        }
    }

    handleTradingState(asset) {
        // Skip if asset is suspended or trade in progress
        if (this.tradeInProgress || this.suspendedAssets.has(asset)) return;

        // Check cooldown trigger
        if (this.consecutiveLosses >= CONFIG.strategy.loss_streak_cooldown_trigger) {
            Logger.warn(`❄️  Entering cooldown after ${this.consecutiveLosses} losses`);
            this.cooldownTicksRemaining = CONFIG.strategy.cooldown_ticks_after_loss_streak;
            this.state = 'COOLDOWN';
            return;
        }

        // Rate limiting
        if (Date.now() - this.lastTradeTime < this.minTradeCooldown) return;

        // Generate signal for this asset
        const signal = this.generateSignal(asset);

        if (signal && signal.tradeSignal && signal.confidence > 0.5) {
            const sat = this.cycleAnalyzers[asset].learnedSaturation;
            const satHotDigit = this.cycleAnalyzers[asset].saturationHotDigit;

            const analyzer = this.analyzers[asset];
            const recentTicks = analyzer.getRecentTicks(10);
            const last10 = recentTicks.map(t => t.digit).join(',');

            console.log(
                `🎯 Trade Signal [${asset}]:` +
                ` SatHotDigit: ${satHotDigit != null ? satHotDigit : '?'}` +
                ` | WindowHot: ${signal.windowHotDigit}` +
                ` | TradeDigit: ${signal.digit}` +
                ` | Conf: ${(signal.confidence * 100).toFixed(0)}%` +
                ` | ShortR: ${(signal.shortRepeat * 100).toFixed(1)}%` +
                ` | PeakSat: ${sat != null ? (sat * 100).toFixed(1) + '%' : '---'}`
            );

            // Only trade when saturation has been learned and is meaningful
            if (sat && sat > 0.1 && sat > signal.shortRepeat && satHotDigit != null && satHotDigit !== signal.windowHotDigit) {
                this.placeTrade(asset, signal);
            } else {
                console.log(
                    `[${asset}] Waiting for saturation learning...` +
                    ` Last10: ${last10}` +
                    ` | Sat: ${sat != null ? (sat * 100).toFixed(1) + '%' : 'not learned'}` +
                    ` | SatHot: ${satHotDigit != null ? satHotDigit : 'not identified'}`
                );
            }
        }
    }

    handleCooldownState() {
        this.cooldownTicksRemaining--;

        if (this.cooldownTicksRemaining % 5 === 0) {
            Logger.info(`❄️  Cooldown: ${this.cooldownTicksRemaining} ticks remaining`);
        }

        if (this.cooldownTicksRemaining <= 0) {
            Logger.info('✅ Cooldown complete. Re-entering TRADING...');
            this.state = 'TRADING';
            this.currentStake = CONFIG.stake.initial_stake;
        }
    }

    // ============================================================================
    // SIGNAL GENERATION
    // ============================================================================
    generateSignal(asset) {
        const analyzer = this.analyzers[asset];
        const cycleAnalyzer = this.cycleAnalyzers[asset];

        if (!analyzer.hasEnoughData()) return null;

        const lastDigit = analyzer.getLastDigit();
        const cycleSignal = cycleAnalyzer.getSignal(lastDigit);

        if (!cycleSignal.active) return null;

        // Use the saturation hot digit (the digit that drove the peak repeats)
        // as the primary trade digit for DIGITDIFF
        const saturationHotDigit = cycleAnalyzer.saturationHotDigit;
        const hotDigitInfo = analyzer.getHotDigitInWindow(CONFIG.strategy.short_window);

        // Determine the trade digit: prefer the saturation-identified hot digit
        // Fall back to the window hot digit if saturation digit isn't available
        // const tradeDigit = saturationHotDigit != null ? saturationHotDigit : hotDigitInfo.digit;
        const tradeDigit = hotDigitInfo.digit;

        const confidence = Math.min(cycleSignal.score / 100, 1.0);

        // Signal is active when the current last digit matches the hot digit
        // that drove the saturation (indicating it's still repeating and
        // about to exhaust)
        const tradeSignal = lastDigit === tradeDigit;

        return {
            asset,
            digit: tradeDigit,
            digitFrequency: hotDigitInfo.frequency,
            digitCount: hotDigitInfo.count,
            confidence,
            cycleScore: cycleSignal.score,
            cycleDetails: cycleSignal.details,
            shortRepeat: cycleSignal.details ? cycleSignal.details.shortRepeat : 0,
            tradeSignal,
            hotDigit: tradeDigit,
            saturationHotDigit,
            windowHotDigit: hotDigitInfo.digit,
        };
    }

    // ============================================================================
    // TRADE EXECUTION
    // ============================================================================
    placeTrade(asset, signal) {
        if (this.tradeInProgress || !this.wsReady) return;

        // Check max consecutive losses
        if (this.consecutiveLosses >= CONFIG.risk.max_consecutive_losses) {
            Logger.warn(`🛑 Max consecutive losses reached! Stopping.`);
            this.disconnect();
            return;
        }

        // Check daily limits
        if (this.totalProfitLoss <= -CONFIG.risk.max_daily_loss) {
            Logger.warn(`🛑 Daily loss limit reached! Stopping.`);
            this.sendTelegramMessage(
                `🛑 <b>Stop Loss Reached!</b>\nFinal P&L: $${this.totalProfitLoss.toFixed(2)}`
            );
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= CONFIG.risk.take_profit) {
            Logger.info(`🎯 Take profit reached! Stopping.`);
            this.sendTelegramMessage(
                `🎉 <b>Take Profit Reached!</b>\nFinal P&L: $${this.totalProfitLoss.toFixed(2)}`
            );
            this.disconnect();
            return;
        }

        this.tradeInProgress = true;
        this.currentAsset = asset;
        this.lastTradeTime = Date.now();

        // The trade digit comes from the saturation hot digit analysis
        const tradeDigit = signal.digit;
        const satHotDigit = signal.saturationHotDigit;
        const windowHotDigit = signal.windowHotDigit;

        console.log(
            `🔔 Placing DIGITDIFF Trade:` +
            ` [${asset}]` +
            ` Barrier: ${tradeDigit}` +
            ` (SatHot: ${satHotDigit != null ? satHotDigit : '?'}` +
            ` | WinHot: ${windowHotDigit != null ? windowHotDigit : '?'})` +
            ` | Stake: $${this.currentStake.toFixed(2)}`
        );

        const analyzer = this.analyzers[asset];
        const recentTicks = analyzer.getRecentTicks(10);
        const last10 = recentTicks.map(t => t.digit).join(',');

        const d = signal.cycleDetails || {};
        const th = (d.learnedSaturation != null ? d.learnedSaturation * 100 : 0).toFixed(1);
        const sh = (d.shortRepeat != null ? d.shortRepeat * 100 : 0).toFixed(1);
        const peakWindow = d.peakInWindow || '---';
        const declineFrac = d.declineFraction || '---';

        const message = `
            🔔 <b>Trade Opened (nFastGhostHHF Multi-Asset)</b>

            📊 <b>${asset}</b>
            🎯 <b>DIGITDIFF Barrier:</b> ${tradeDigit}
            🔥 <b>Saturation Hot Digit:</b> ${satHotDigit != null ? satHotDigit : '---'}
            📈 <b>Window Hot Digit:</b> ${windowHotDigit != null ? windowHotDigit : '---'}
            🔢 <b>Last10:</b> ${last10}
            📈 <b>Confidence:</b> ${(signal.confidence * 100).toFixed(0)}%
            💰 <b>Stake:</b> $${this.currentStake.toFixed(2)}

            🔬 <b>Repeat-Cycle Analysis</b>
            ├ Short Repeat: ${sh}%
            ├ Peak Saturation: ${th}%
            ├ Peak in Window: ${peakWindow}
            ├ Decline Fraction: ${declineFrac}
            └ Score: ${signal.cycleScore}
        `.trim();
        this.sendTelegramMessage(message);

        this.pendingContract = {
            asset,
            signal,
            tradeDigit,
            satHotDigit,
            windowHotDigit,
            sentAt: Date.now(),
        };

        const success = this.sendRequest({
            buy: 1,
            price: this.currentStake,
            parameters: {
                amount: this.currentStake,
                basis: 'stake',
                contract_type: CONFIG.contract_type,
                currency: CONFIG.currency,
                duration: CONFIG.duration,
                duration_unit: CONFIG.duration_unit,
                symbol: asset,
                barrier: tradeDigit.toString(),
            }
        });

        if (!success) {
            console.error('Failed to send trade request');
            this.tradeInProgress = false;
            this.pendingContract = null;
        }
    }

    subscribeToOpenContract(contractId) {
        this.contractSubscription = contractId;
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });
    }

    // ============================================================================
    // TRADE RESULT HANDLING
    // ============================================================================
    handleTradeResult(contract) {
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const buyPrice = parseFloat(contract.buy_price);
        const exitSpot = contract.exit_tick_display_value;
        const exitDigit = exitSpot ? getLastDigitFromQuote(exitSpot, asset) : '—';

        // Retrieve pending contract info
        const pending = this.pendingContract || {};
        const tradeDigit = pending.tradeDigit != null ? pending.tradeDigit : '?';
        const satHotDigit = pending.satHotDigit != null ? pending.satHotDigit : '?';
        const windowHotDigit = pending.windowHotDigit != null ? pending.windowHotDigit : '?';

        console.log(
            `[${asset}] ${won ? '✅ WON' : '❌ LOST'}` +
            ` | Profit: $${profit.toFixed(2)}` +
            ` | Barrier: ${tradeDigit}` +
            ` | ExitDigit: ${exitDigit}` +
            ` | SatHot: ${satHotDigit}`
        );

        this.totalTrades++;
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;

        if (won) {
            this.totalWins++;
            this.hourlyStats.wins++;
            this.consecutiveLosses = 0;

            // System progression reset
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

            this.currentStake = CONFIG.stake.initial_stake;
        } else {
            this.totalLosses++;
            this.hourlyStats.losses++;
            this.consecutiveLosses++;

            // Track consecutive loss counters
            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;

            // Apply multiplier
            this.currentStake = Math.ceil(this.currentStake * CONFIG.stake.multiplier * 100) / 100;

            // Cap stake at maximum
            if (this.currentStake > CONFIG.stake.max_stake) {
                this.currentStake = CONFIG.stake.max_stake;
                console.warn(`⚠️ Stake capped at max: $${CONFIG.stake.max_stake}`);
            }

            // System progression
            if (this.consecutiveLosses >= 2) {
                if (this.sys === 1) {
                    this.sys = 2;
                } else if (this.sys === 2) {
                    this.sys = 3;
                }
                this.sysCount = 0;
            }

            // Suspend asset after loss
            this.suspendAsset(asset);
        }

        this.totalProfitLoss += profit;

        // Telegram notification
        const resultEmoji = won ? '✅ WIN' : '❌ LOSS';
        const pnlStr = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(2);
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;

        const analyzer = this.analyzers[asset];
        const last10 = analyzer
            ? analyzer.getRecentDigits(10).join(',')
            : '---';

        const cycleAnalyzer = this.cycleAnalyzers[asset];
        const currentSat = cycleAnalyzer
            ? cycleAnalyzer.learnedSaturation
            : null;
        const currentSatHot = cycleAnalyzer
            ? cycleAnalyzer.saturationHotDigit
            : null;

        const telegramMsg = `
            ${resultEmoji} <b>(nFastGhostHF Multi-Asset)</b>

            📊 <b>${asset}</b>
            ${won ? '🟢' : '🔴'} <b>P&L:</b> ${pnlStr}
            🎯 <b>DIGITDIFF Barrier:</b> ${tradeDigit}
            🔥 <b>Sat Hot Digit:</b> ${satHotDigit}
            📈 <b>Window Hot Digit:</b> ${windowHotDigit}
            🔢 <b>Exit Digit:</b> ${exitDigit}
            🔢 <b>Last10:</b> ${last10}

            🔬 <b>Current Saturation State</b>
            ├ Peak Sat: ${currentSat != null ? (currentSat * 100).toFixed(1) + '%' : '---'}
            └ Current Sat Hot: ${currentSatHot != null ? currentSatHot : '---'}

            📊 <b>Session Stats</b>
            ├ Trades: ${this.totalTrades}
            ├ Wins/Losses: ${this.totalWins}/${this.totalLosses}
            ├ Consec Losses: ${this.consecutiveLosses}
            ├ x2/x3/x4: ${this.consecutiveLosses2}/${this.consecutiveLosses3}/${this.consecutiveLosses4}
            ├ Win Rate: ${winRate}%
            ├ Daily P&L: ${(this.totalProfitLoss >= 0 ? '+' : '')}$${this.totalProfitLoss.toFixed(2)}
            └ Next Stake: $${this.currentStake.toFixed(2)}
        `.trim();
        this.sendTelegramMessage(telegramMsg);

        this.logSummary();

        // Check stop conditions
        if (this.consecutiveLosses >= CONFIG.risk.max_consecutive_losses ||
            this.totalProfitLoss <= -CONFIG.risk.max_daily_loss) {
            console.log('🛑 Stop loss reached');
            this.sendTelegramMessage(
                `🛑 <b>Stop Loss Reached!</b>\n` +
                `Final P&L: $${this.totalProfitLoss.toFixed(2)}\n` +
                `Total Trades: ${this.totalTrades}\n` +
                `Win Rate: ${winRate}%`
            );
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= CONFIG.risk.take_profit) {
            console.log('🎉 Take profit reached');
            this.sendTelegramMessage(
                `🎉 <b>Take Profit Reached!</b>\n` +
                `Final P&L: $${this.totalProfitLoss.toFixed(2)}\n` +
                `Total Trades: ${this.totalTrades}\n` +
                `Win Rate: ${winRate}%`
            );
            this.disconnect();
            return;
        }

        this.tradeInProgress = false;
        this.contractSubscription = null;
        this.pendingContract = null;
    }

    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
        console.log(`🚫 Suspended: ${asset}`);

        // Keep max 1 suspended asset (reactive approach)
        if (this.suspendedAssets.size > 1) {
            const first = Array.from(this.suspendedAssets)[0];
            this.suspendedAssets.delete(first);
            console.log(`✅ Reactivated: ${first}`);
        }
    }

    // ============================================================================
    // TELEGRAM
    // ============================================================================
    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;
        try {
            await this.telegramBot.sendMessage(CONFIG.telegram_chat_id, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error(`❌ Failed to send Telegram message: ${error.message}`);
        }
    }

    async sendHourlySummary() {
        const stats = this.hourlyStats;
        const winRate = stats.wins + stats.losses > 0
            ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1)
            : 0;
        const pnlEmoji = stats.pnl >= 0 ? '🟢' : '🔴';
        const pnlStr = (stats.pnl >= 0 ? '+' : '') + '$' + stats.pnl.toFixed(2);

        const message = `
            ⏰ <b>nFastGhostHF Multi-Asset Hourly Summary</b>

            📊 <b>Last Hour</b>
            ├ Trades: ${stats.trades}
            ├ Wins: ${stats.wins} | Losses: ${stats.losses}
            ├ Win Rate: ${winRate}%
            └ ${pnlEmoji} <b>P&L:</b> ${pnlStr}

            📈 <b>Daily Totals</b>
            ├ Total Trades: ${this.totalTrades}
            ├ Total W/L: ${this.totalWins}/${this.totalLosses}
            ├ x2 Losses: ${this.consecutiveLosses2}
            ├ x3 Losses: ${this.consecutiveLosses3}
            ├ x4 Losses: ${this.consecutiveLosses4}
            ├ Daily P&L: ${(this.totalProfitLoss >= 0 ? '+' : '')}$${this.totalProfitLoss.toFixed(2)}
            └ Current Stake: $${this.currentStake.toFixed(2)}
        `.trim();

        try {
            await this.sendTelegramMessage(message);
            console.log('📱 Telegram: Hourly Summary sent');
        } catch (error) {
            console.error(`❌ Telegram hourly summary failed: ${error.message}`);
        }

        this.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };
    }

    startTelegramTimer() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1);
        nextHour.setMinutes(0);
        nextHour.setSeconds(0);
        nextHour.setMilliseconds(0);

        const timeUntilNextHour = nextHour.getTime() - now.getTime();

        setTimeout(() => {
            this.sendHourlySummary();
            setInterval(() => {
                this.sendHourlySummary();
            }, 60 * 60 * 1000);
        }, timeUntilNextHour);

        console.log(`📱 Hourly summaries scheduled. First in ${Math.ceil(timeUntilNextHour / 60000)} minutes.`);
    }

    // ============================================================================
    // RECONNECTION & CLEANUP
    // ============================================================================
    handleDisconnect() {
        if (this.endOfDay) {
            console.log('Planned shutdown, not reconnecting.');
            this.cleanup();
            return;
        }

        if (this.isReconnecting) {
            console.log('Already handling disconnect, skipping...');
            return;
        }

        this.connected = false;
        this.wsReady = false;
        this.stopMonitor();

        StatePersistence.saveState(this);

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            this.sendTelegramMessage(
                `❌ <b>Max Reconnection Attempts Reached</b>\n` +
                `Please restart the bot manually.\n` +
                `Final P&L: $${this.totalProfitLoss.toFixed(2)}`
            );
            this.isReconnecting = false;
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        const delay = Math.min(
            this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1),
            30000
        );

        console.log(
            `🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... ` +
            `(Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
        );
        console.log(
            `📊 Preserved state - Trades: ${this.totalTrades}, ` +
            `P&L: $${this.totalProfitLoss.toFixed(2)}`
        );

        this.sendTelegramMessage(
            `⚠️ <b>CONNECTION LOST - RECONNECTING</b>\n` +
            `📊 Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
            `⏱️ Retrying in ${(delay / 1000).toFixed(1)}s\n` +
            `💾 State preserved: ${this.totalTrades} trades, $${this.totalProfitLoss.toFixed(2)} P&L`
        );

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(() => {
            console.log('🔄 Attempting reconnection...');
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    cleanup() {
        this.stopMonitor();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN ||
                this.ws.readyState === WebSocket.CONNECTING) {
                try {
                    this.ws.close();
                } catch (e) {
                    console.log('WebSocket already closed');
                }
            }
            this.ws = null;
        }

        if (this.endOfDay) {
            this.activeSubscriptions.clear();
        }

        this.connected = false;
        this.wsReady = false;
    }

    disconnect() {
        console.log('🛑 Disconnecting bot...');
        StatePersistence.saveState(this);
        this.endOfDay = true;
        this.cleanup();
        console.log('✅ Bot disconnected successfully');
    }

    _setupSignalHandlers() {
        process.on('SIGINT', () => {
            console.log('\n⚠️ Received SIGINT, shutting down gracefully...');
            this.disconnect();
            setTimeout(() => process.exit(0), 2000);
        });

        process.on('SIGTERM', () => {
            console.log('\n⚠️ Received SIGTERM, shutting down gracefully...');
            this.disconnect();
            setTimeout(() => process.exit(0), 2000);
        });
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay(); // 0: Sunday, 1: Monday, ..., 6: Saturday
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Weekend logic: Saturday 11pm to Monday 2am GMT+1 -> Disconnect and stay disconnected
            const isWeekend = (currentDay === 0) || // Sunday
                (currentDay === 6 && currentHours >= 23) || // Saturday after 11pm
                (currentDay === 1 && currentHours < 8);    // Monday before 8am

            if (isWeekend) {
                if (!this.endOfDay) {
                    console.log("Weekend trading suspension (Saturday 11pm - Monday 8am). Disconnecting...");
                    this.sendHourlySummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
                return; // Prevent any reconnection logic during the weekend
            }

            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM GMT+1, reconnecting the bot.");
                this.resetDailyStats();
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendHourlySummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    resetDailyStats() {
        this.tradeInProgress = false;
        this.suspendedAssets.clear();
        this.isWinTrade = false;
    }

    // ============================================================================
    // SUMMARY
    // ============================================================================
    logSummary() {
        console.log('\n📊 TRADING SUMMARY');
        console.log(`Trades: ${this.totalTrades}`);
        console.log(`Wins: ${this.totalWins}`);
        console.log(`Losses: ${this.totalLosses}`);
        console.log(`x2/x3/x4 Losses: ${this.consecutiveLosses2}/${this.consecutiveLosses3}/${this.consecutiveLosses4}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`P&L: $${this.totalProfitLoss.toFixed(2)} | Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%`);
        console.log(`Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
    }

    // ============================================================================
    // START
    // ============================================================================
    start() {
        console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║  🏴 ROMANIAN GHOST - BLACK FIBONACCI 9.1 MULTI-ASSET 🏴   ║
║                                                           ║
║       Deriv Digit Differ Trading Bot - Multi-Asset        ║
║                                                           ║
║  Assets: ${this.assets.join(', ').padEnd(45)} ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
        `);

        console.log('🚀 Starting Multi-Asset Ghost Bot...');
        console.log(`📊 Assets: ${this.assets.join(', ')}`);
        console.log(`💰 Initial Stake: $${CONFIG.stake.initial_stake}`);
        console.log(`📊 Multiplier: ${CONFIG.stake.multiplier}x`);
        console.log(`🎯 Take Profit: $${CONFIG.risk.take_profit}`);
        console.log(`🛑 Max Daily Loss: $${CONFIG.risk.max_daily_loss}`);

        StatePersistence.startAutoSave(this);
        this.connect();
        this.checkTimeForDisconnectReconnect();
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

    const bot = new MultiAssetGhostBot(apiToken);
    bot.start();
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
🏴 Romanian Ghost - Black Fibonacci 9.1 Multi-Asset
Deriv Digit Differ Trading Bot - Multi-Asset Version

USAGE:
    node nFastGhostMMulti.js [options]

OPTIONS:
    --token, -t <token>     Deriv API token (or set DERIV_API_TOKEN env var)
    --stake <amount>        Base stake in USD (default: 1.1)
    --take-profit, --tp     Take profit target (default: 3000.00)
    --stop-loss, --sl       Max daily loss limit (default: 100.00)
    --debug                 Enable debug logging
    --help, -h              Show this help message

ASSETS TRADED:
    R_10, R_25, R_50, R_75, R_100, RDBULL, RDBEAR

EXAMPLES:
    node nFastGhostMMulti.js --token YOUR_TOKEN_HERE
    node nFastGhostMMulti.js -t YOUR_TOKEN --stake 0.50 --tp 20
    DERIV_API_TOKEN=xxx node nFastGhostMMulti.js --debug

ENVIRONMENT VARIABLES:
    DERIV_API_TOKEN         Deriv API token
    DERIV_APP_ID            Deriv app ID (default: 1089)
    TELEGRAM_BOT_TOKEN      Telegram bot token for notifications
    TELEGRAM_CHAT_ID        Telegram chat ID for notifications
`);
}

main().catch(error => {
    console.error('Fatal error:', error.message);
    process.exit(1);
});
