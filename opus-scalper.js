#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DERIV MULTIPLIER GRID SCALPING BOT - Production Ready v1.2.0
 * ═══════════════════════════════════════════════════════════════════════════════
 *  
 *  FIXES IN THIS VERSION:
 *  - Added "basis": "stake" to fix "Please specify either payout or stake" error
 *  - Corrected buy request structure for multiplier contracts
 *  - Implemented proper contract_update for SL/TP after purchase
 *  - Added fallback manual position monitoring
 *  
 *  Author: Trading Bot Developer
 *  Version: 1.2.0
 *  License: MIT
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
    // API Configuration
    API: {
        APP_ID: process.env.DERIV_APP_ID || '1089',
        API_TOKEN: process.env.DERIV_API_TOKEN || 'Dz2V2KvRf4Uukt3',
        ENDPOINT: 'wss://ws.derivws.com/websockets/v3?app_id=',
        RECONNECT_DELAY: 5000,
        MAX_RECONNECT_ATTEMPTS: 10,
        PING_INTERVAL: 30000,
    },

    // Trading Configuration
    TRADING: {
        SYMBOL: 'R_100',                    // Volatility 100 Index
        MULTIPLIER: 100,                    // Multiplier value (20, 40, 60, 100, 200)
        BASE_STAKE: 2,                      // Base stake in USD
        MAX_STAKE: 3,                      // Maximum stake per trade
        MIN_STAKE: 1,                    // Minimum stake for R_100
    },

    // Grid Configuration
    GRID: {
        LEVELS: 5,
        ATR_MULTIPLIER: 0.5,
        DYNAMIC_SPACING: true,
        FIXED_SPACING_PIPS: 10,
    },

    // Risk Management
    RISK: {
        MAX_RISK_PER_TRADE: 0.02,
        MAX_DAILY_LOSS: 0.10,
        MAX_DAILY_TRADES: 50,
        MAX_CONCURRENT_POSITIONS: 3,
        STOP_LOSS_PERCENT: 50,              // 50% of stake
        TAKE_PROFIT_PERCENT: 100,           // 100% of stake (double)
        ENABLE_LIMIT_ORDERS: true,
    },

    // Indicator Settings
    INDICATORS: {
        RSI_PERIOD: 14,
        RSI_OVERBOUGHT: 70,
        RSI_OVERSOLD: 30,
        MACD_FAST: 12,
        MACD_SLOW: 26,
        MACD_SIGNAL: 9,
        BB_PERIOD: 20,
        BB_STD_DEV: 2,
        EMA_FAST: 9,
        EMA_SLOW: 21,
        EMA_TREND: 50,
        ATR_PERIOD: 14,
    },

    // Signal Configuration
    SIGNALS: {
        MIN_CONFLUENCE_SCORE: 3,
        COOLDOWN_SECONDS: 30,
        TREND_FILTER: true,
        VOLATILITY_FILTER: true,
        MIN_ATR_THRESHOLD: 0.0005,
        RSI_OVERSOLD: 30,
        RSI_OVERBOUGHT: 70,
    },

    // Logging
    LOGGING: {
        LEVEL: 'DEBUG',
        SHOW_TICKS: false,
        SHOW_INDICATORS: true,
        PERFORMANCE_INTERVAL: 1800000,
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class Logger {
    static LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

    static formatTime() {
        return new Date().toISOString();
    }

    static getColor(level) {
        const colors = {
            DEBUG: '\x1b[36m',
            INFO: '\x1b[32m',
            WARN: '\x1b[33m',
            ERROR: '\x1b[31m',
            RESET: '\x1b[0m',
            BOLD: '\x1b[1m',
            DIM: '\x1b[2m',
        };
        return colors[level] || colors.RESET;
    }

    static log(level, category, message, data = null) {
        if (this.LEVELS[level] < this.LEVELS[CONFIG.LOGGING.LEVEL]) return;

        const timestamp = this.formatTime();
        const color = this.getColor(level);
        const reset = this.getColor('RESET');
        const dim = this.getColor('DIM');

        console.log(`${dim}[${timestamp}]${reset} ${color}[${level}]${reset} [${category}] ${message}`);

        if (data) {
            console.log(`${dim}    └─ Data:${reset}`, JSON.stringify(data, null, 2));
        }
    }

    static debug(category, message, data) { this.log('DEBUG', category, message, data); }
    static info(category, message, data) { this.log('INFO', category, message, data); }
    static warn(category, message, data) { this.log('WARN', category, message, data); }
    static error(category, message, data) { this.log('ERROR', category, message, data); }

    static banner(text) {
        const line = '═'.repeat(75);
        console.log(`\n\x1b[36m${line}\x1b[0m`);
        console.log(`\x1b[1m\x1b[36m  ${text}\x1b[0m`);
        console.log(`\x1b[36m${line}\x1b[0m\n`);
    }

    static trade(action, details) {
        const emoji = action.includes('BUY') ? '🟢' : action.includes('SELL') ? '🔴' :
            action.includes('OPENED') ? '📈' : action.includes('CLOSED') ? '📉' : '📊';
        console.log(`\n${emoji} ═══════════════════════════════════════════════════════════════`);
        console.log(`   ${action}`);
        console.log(`   ─────────────────────────────────────────────────────────────`);
        Object.entries(details).forEach(([key, value]) => {
            console.log(`   ${key}: ${value}`);
        });
        console.log(`═══════════════════════════════════════════════════════════════════\n`);
    }

    static performance(stats) {
        console.log('\n📈 ═══════════════════════════════════════════════════════════════');
        console.log('   PERFORMANCE SUMMARY');
        console.log('   ─────────────────────────────────────────────────────────────');
        Object.entries(stats).forEach(([key, value]) => {
            console.log(`   ${key}: ${value}`);
        });
        console.log('═══════════════════════════════════════════════════════════════════\n');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════════════════════════════

class TechnicalIndicators {
    static SMA(prices, period) {
        if (prices.length < period) return null;
        const slice = prices.slice(-period);
        return slice.reduce((a, b) => a + b, 0) / period;
    }

    static EMA(prices, period) {
        if (prices.length < period) return null;
        const multiplier = 2 / (period + 1);
        let ema = this.SMA(prices.slice(0, period), period);
        for (let i = period; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }
        return ema;
    }

    static RSI(prices, period = 14) {
        if (prices.length < period + 1) return null;
        let gains = 0, losses = 0;

        for (let i = 1; i <= period; i++) {
            const change = prices[i] - prices[i - 1];
            if (change >= 0) gains += change;
            else losses -= change;
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;

        for (let i = period + 1; i < prices.length; i++) {
            const change = prices[i] - prices[i - 1];
            if (change >= 0) {
                avgGain = (avgGain * (period - 1) + change) / period;
                avgLoss = (avgLoss * (period - 1)) / period;
            } else {
                avgGain = (avgGain * (period - 1)) / period;
                avgLoss = (avgLoss * (period - 1) - change) / period;
            }
        }

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    static MACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        if (prices.length < slowPeriod + signalPeriod) return null;

        const emaFast = this.EMA(prices, fastPeriod);
        const emaSlow = this.EMA(prices, slowPeriod);
        const macdLine = emaFast - emaSlow;

        const macdHistory = [];
        for (let i = slowPeriod; i <= prices.length; i++) {
            const slicedPrices = prices.slice(0, i);
            const fast = this.EMA(slicedPrices, fastPeriod);
            const slow = this.EMA(slicedPrices, slowPeriod);
            if (fast && slow) macdHistory.push(fast - slow);
        }

        const signalLine = macdHistory.length >= signalPeriod
            ? this.EMA(macdHistory, signalPeriod)
            : null;

        const histogram = signalLine !== null ? macdLine - signalLine : null;
        return { macdLine, signalLine, histogram };
    }

    static BollingerBands(prices, period = 20, stdDev = 2) {
        if (prices.length < period) return null;

        const sma = this.SMA(prices, period);
        const slice = prices.slice(-period);
        const squaredDiffs = slice.map(price => Math.pow(price - sma, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
        const standardDeviation = Math.sqrt(variance);

        return {
            upper: sma + (standardDeviation * stdDev),
            middle: sma,
            lower: sma - (standardDeviation * stdDev),
            bandwidth: ((sma + (standardDeviation * stdDev)) - (sma - (standardDeviation * stdDev))) / sma,
            percentB: (prices[prices.length - 1] - (sma - (standardDeviation * stdDev))) /
                ((sma + (standardDeviation * stdDev)) - (sma - (standardDeviation * stdDev)))
        };
    }

    static ATR(highs, lows, closes, period = 14) {
        if (closes.length < period + 1) return null;

        const trueRanges = [];
        for (let i = 1; i < closes.length; i++) {
            const tr = Math.max(
                highs[i] - lows[i],
                Math.abs(highs[i] - closes[i - 1]),
                Math.abs(lows[i] - closes[i - 1])
            );
            trueRanges.push(tr);
        }

        if (trueRanges.length < period) return null;

        let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < trueRanges.length; i++) {
            atr = ((atr * (period - 1)) + trueRanges[i]) / period;
        }
        return atr;
    }

    static Stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
        if (closes.length < kPeriod) return null;

        const kValues = [];
        for (let i = kPeriod - 1; i < closes.length; i++) {
            const highSlice = highs.slice(i - kPeriod + 1, i + 1);
            const lowSlice = lows.slice(i - kPeriod + 1, i + 1);
            const highestHigh = Math.max(...highSlice);
            const lowestLow = Math.min(...lowSlice);
            const k = highestHigh !== lowestLow
                ? ((closes[i] - lowestLow) / (highestHigh - lowestLow)) * 100
                : 50;
            kValues.push(k);
        }

        const k = kValues[kValues.length - 1];
        const d = kValues.length >= dPeriod
            ? kValues.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod
            : null;

        return { k, d };
    }

    static Momentum(prices, period = 10) {
        if (prices.length < period) return null;
        return prices[prices.length - 1] - prices[prices.length - period];
    }

    static ROC(prices, period = 10) {
        if (prices.length < period) return null;
        const currentPrice = prices[prices.length - 1];
        const pastPrice = prices[prices.length - period];
        return pastPrice !== 0 ? ((currentPrice - pastPrice) / pastPrice) * 100 : 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRID STRATEGY
// ═══════════════════════════════════════════════════════════════════════════════

class GridStrategy {
    constructor(config) {
        this.config = config;
        this.gridLevels = [];
        this.basePrice = null;
    }

    calculateGridLevels(currentPrice, atr) {
        const levels = [];
        const spacing = this.config.DYNAMIC_SPACING
            ? atr * this.config.ATR_MULTIPLIER
            : this.config.FIXED_SPACING_PIPS * 0.0001;

        this.basePrice = currentPrice;

        for (let i = 1; i <= this.config.LEVELS; i++) {
            levels.push({
                type: 'BUY',
                level: i,
                price: currentPrice - (spacing * i),
                triggered: false,
                spacing: spacing
            });
            levels.push({
                type: 'SELL',
                level: i,
                price: currentPrice + (spacing * i),
                triggered: false,
                spacing: spacing
            });
        }

        this.gridLevels = levels.sort((a, b) => b.price - a.price);

        Logger.debug('GRID', `Grid levels calculated with spacing: ${(spacing * 10000).toFixed(2)} pips`, {
            basePrice: currentPrice.toFixed(5),
            levels: this.config.LEVELS,
            topLevel: this.gridLevels[0]?.price.toFixed(5),
            bottomLevel: this.gridLevels[this.gridLevels.length - 1]?.price.toFixed(5)
        });

        return this.gridLevels;
    }

    checkGridCrossing(currentPrice, previousPrice) {
        const crossedLevels = [];
        for (const level of this.gridLevels) {
            if (level.triggered) continue;
            const crossedUp = previousPrice < level.price && currentPrice >= level.price;
            const crossedDown = previousPrice > level.price && currentPrice <= level.price;
            if (crossedUp || crossedDown) {
                crossedLevels.push({
                    ...level,
                    direction: crossedUp ? 'UP' : 'DOWN',
                    crossPrice: currentPrice
                });
            }
        }
        return crossedLevels;
    }

    triggerLevel(level) {
        const gridLevel = this.gridLevels.find(
            l => l.type === level.type && l.level === level.level
        );
        if (gridLevel) gridLevel.triggered = true;
    }

    resetGrid() {
        this.gridLevels.forEach(level => level.triggered = false);
    }

    getStatus() {
        const buyLevels = this.gridLevels.filter(l => l.type === 'BUY');
        const sellLevels = this.gridLevels.filter(l => l.type === 'SELL');
        return {
            basePrice: this.basePrice,
            totalLevels: this.gridLevels.length,
            buyLevelsTriggered: buyLevels.filter(l => l.triggered).length,
            sellLevelsTriggered: sellLevels.filter(l => l.triggered).length,
            buyLevelsAvailable: buyLevels.filter(l => !l.triggered).length,
            sellLevelsAvailable: sellLevels.filter(l => !l.triggered).length
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════

class SignalGenerator {
    constructor(config) {
        this.config = config;
        this.lastSignalTime = 0;
    }

    generateSignal(indicators, gridSignal, currentPrice) {
        const signals = {
            rsi: this.analyzeRSI(indicators.rsi),
            macd: this.analyzeMACD(indicators.macd),
            bollingerBands: this.analyzeBollingerBands(indicators.bb, currentPrice),
            ema: this.analyzeEMA(indicators.emaFast, indicators.emaSlow, indicators.emaTrend, currentPrice),
            momentum: this.analyzeMomentum(indicators.momentum, indicators.roc),
            stochastic: this.analyzeStochastic(indicators.stochastic),
            grid: gridSignal
        };

        const { score, direction, breakdown } = this.calculateConfluence(signals);

        const now = Date.now();
        const cooldownPassed = (now - this.lastSignalTime) > (this.config.COOLDOWN_SECONDS * 1000);

        const passesVolatilityFilter = !this.config.VOLATILITY_FILTER ||
            (indicators.atr >= this.config.MIN_ATR_THRESHOLD);

        const passesTrendFilter = !this.config.TREND_FILTER ||
            this.checkTrendAlignment(direction, indicators.emaTrend, currentPrice);

        const isValidSignal =
            Math.abs(score) >= this.config.MIN_CONFLUENCE_SCORE &&
            cooldownPassed &&
            passesVolatilityFilter &&
            passesTrendFilter;

        if (isValidSignal && direction !== 'NEUTRAL') {
            this.lastSignalTime = now;
        }

        return {
            direction: isValidSignal ? direction : 'NEUTRAL',
            score: score,
            confidence: Math.min(Math.abs(score) / 6 * 100, 100),
            signals: breakdown,
            filters: { cooldownPassed, passesVolatilityFilter, passesTrendFilter },
            isValid: isValidSignal
        };
    }

    analyzeRSI(rsi) {
        if (rsi === null) return { signal: 0, reason: 'No data' };
        if (rsi < this.config.RSI_OVERSOLD) return { signal: 1, reason: `Oversold (${rsi.toFixed(2)})` };
        if (rsi > this.config.RSI_OVERBOUGHT) return { signal: -1, reason: `Overbought (${rsi.toFixed(2)})` };
        return { signal: 0, reason: `Neutral (${rsi.toFixed(2)})` };
    }

    analyzeMACD(macd) {
        if (!macd || macd.histogram === null) return { signal: 0, reason: 'No data' };
        if (macd.histogram > 0 && macd.macdLine > macd.signalLine)
            return { signal: 1, reason: `Bullish (Hist: ${macd.histogram.toFixed(5)})` };
        if (macd.histogram < 0 && macd.macdLine < macd.signalLine)
            return { signal: -1, reason: `Bearish (Hist: ${macd.histogram.toFixed(5)})` };
        return { signal: 0, reason: 'Neutral' };
    }

    analyzeBollingerBands(bb, currentPrice) {
        if (!bb) return { signal: 0, reason: 'No data' };
        if (currentPrice <= bb.lower) return { signal: 1, reason: `Below lower band (${bb.percentB.toFixed(2)})` };
        if (currentPrice >= bb.upper) return { signal: -1, reason: `Above upper band (${bb.percentB.toFixed(2)})` };
        return { signal: 0, reason: `Within bands (${bb.percentB.toFixed(2)})` };
    }

    analyzeEMA(fast, slow, trend, currentPrice) {
        if (fast === null || slow === null) return { signal: 0, reason: 'No data' };
        let signal = 0;
        let reasons = [];

        if (fast > slow) { signal += 1; reasons.push('EMA Fast > Slow'); }
        else { signal -= 1; reasons.push('EMA Fast < Slow'); }

        if (trend !== null) {
            if (currentPrice > trend) { signal += 0.5; reasons.push('Above Trend EMA'); }
            else { signal -= 0.5; reasons.push('Below Trend EMA'); }
        }

        return { signal: signal > 0 ? 1 : signal < 0 ? -1 : 0, reason: reasons.join(', ') };
    }

    analyzeMomentum(momentum, roc) {
        if (momentum === null || roc === null) return { signal: 0, reason: 'No data' };
        if (momentum > 0 && roc > 0) return { signal: 1, reason: `Positive (ROC: ${roc.toFixed(2)}%)` };
        if (momentum < 0 && roc < 0) return { signal: -1, reason: `Negative (ROC: ${roc.toFixed(2)}%)` };
        return { signal: 0, reason: 'Neutral' };
    }

    analyzeStochastic(stoch) {
        if (!stoch || stoch.k === null) return { signal: 0, reason: 'No data' };
        if (stoch.k < 20 && (stoch.d === null || stoch.d < 20))
            return { signal: 1, reason: `Oversold (K: ${stoch.k.toFixed(2)})` };
        if (stoch.k > 80 && (stoch.d === null || stoch.d > 80))
            return { signal: -1, reason: `Overbought (K: ${stoch.k.toFixed(2)})` };
        return { signal: 0, reason: `Neutral (K: ${stoch.k.toFixed(2)})` };
    }

    calculateConfluence(signals) {
        let score = 0;
        const breakdown = {};
        for (const [name, data] of Object.entries(signals)) {
            if (data && data.signal !== undefined) {
                score += data.signal;
                breakdown[name] = data;
            }
        }
        let direction = 'NEUTRAL';
        if (score > 0) direction = 'BUY';
        else if (score < 0) direction = 'SELL';
        return { score, direction, breakdown };
    }

    checkTrendAlignment(direction, trendEma, currentPrice) {
        if (trendEma === null) return true;
        if (direction === 'BUY' && currentPrice > trendEma) return true;
        if (direction === 'SELL' && currentPrice < trendEma) return true;
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RISK MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

class RiskManager {
    constructor(config) {
        this.config = config;
        this.dailyPnL = 0;
        this.dailyTrades = 0;
        this.openPositions = [];
        this.tradeHistory = [];
        this.dayStartBalance = 0;
        this.lastDayReset = new Date().toDateString();
    }

    checkDayReset(currentBalance) {
        const today = new Date().toDateString();
        if (today !== this.lastDayReset) {
            this.dailyPnL = 0;
            this.dailyTrades = 0;
            this.dayStartBalance = currentBalance;
            this.lastDayReset = today;
            Logger.info('RISK', 'Daily statistics reset');
        }
    }

    canTrade(balance) {
        this.checkDayReset(balance);
        const checks = {
            dailyLossLimit: this.checkDailyLossLimit(balance),
            dailyTradeLimit: this.dailyTrades < this.config.MAX_DAILY_TRADES,
            positionLimit: this.openPositions.length < this.config.MAX_CONCURRENT_POSITIONS,
        };
        const canTrade = Object.values(checks).every(v => v);
        if (!canTrade) Logger.warn('RISK', 'Trading blocked', checks);
        return { canTrade, checks };
    }

    checkDailyLossLimit(currentBalance) {
        if (this.dayStartBalance === 0) {
            this.dayStartBalance = currentBalance;
            return true;
        }
        const dailyLoss = (this.dayStartBalance - currentBalance) / this.dayStartBalance;
        return dailyLoss < this.config.MAX_DAILY_LOSS;
    }

    calculatePositionSize(balance, winRate, avgWin, avgLoss, confidence) {
        const kellyFraction = avgLoss > 0
            ? winRate - ((1 - winRate) / (avgWin / avgLoss))
            : 0;

        const safeKelly = Math.max(0, kellyFraction * 0.5);
        const adjustedKelly = safeKelly * (confidence / 100);
        const riskFraction = Math.min(adjustedKelly, this.config.MAX_RISK_PER_TRADE);

        let stake = balance * riskFraction;
        stake = Math.max(stake, CONFIG.TRADING.MIN_STAKE);
        stake = Math.min(stake, CONFIG.TRADING.MAX_STAKE);
        stake = Math.min(stake, balance * 0.1);

        return {
            stake: Number(stake.toFixed(2)),
            kellyFraction,
            riskFraction
        };
    }

    calculateSLTP(stake, multiplier, confidence) {
        let stopLossPercent = this.config.STOP_LOSS_PERCENT;
        let takeProfitPercent = this.config.TAKE_PROFIT_PERCENT;

        if (confidence > 80) takeProfitPercent *= 1.2;
        else if (confidence < 50) {
            takeProfitPercent *= 0.8;
            stopLossPercent *= 0.9;
        }

        const stopLossAmount = Number((stake * stopLossPercent / 100).toFixed(2));
        const takeProfitAmount = Number((stake * takeProfitPercent / 100).toFixed(2));

        return {
            stopLoss: Math.max(stopLossAmount, 0.01),
            takeProfit: Math.max(takeProfitAmount, 0.01),
            stopLossPercent,
            takeProfitPercent,
            riskRewardRatio: (takeProfitPercent / stopLossPercent).toFixed(2)
        };
    }

    recordTrade(trade) {
        this.dailyTrades++;
        this.tradeHistory.push({ ...trade, timestamp: Date.now() });
        if (this.tradeHistory.length > 1000) {
            this.tradeHistory = this.tradeHistory.slice(-1000);
        }
    }

    updatePnL(profit) { this.dailyPnL += profit; }
    addPosition(position) { this.openPositions.push(position); }
    removePosition(contractId) {
        this.openPositions = this.openPositions.filter(p => p.contractId !== contractId);
    }

    getStatistics() {
        const wins = this.tradeHistory.filter(t => t.profit > 0);
        const losses = this.tradeHistory.filter(t => t.profit <= 0);

        const winRate = this.tradeHistory.length > 0
            ? (wins.length / this.tradeHistory.length) * 100 : 50;

        const avgWin = wins.length > 0
            ? wins.reduce((a, b) => a + b.profit, 0) / wins.length : 1;

        const avgLoss = losses.length > 0
            ? Math.abs(losses.reduce((a, b) => a + b.profit, 0) / losses.length) : 1;

        const totalProfit = this.tradeHistory.reduce((a, b) => a + b.profit, 0);
        const profitFactor = losses.length > 0 && avgLoss > 0
            ? (wins.length * avgWin) / (losses.length * avgLoss)
            : wins.length > 0 ? Infinity : 0;

        return {
            totalTrades: this.tradeHistory.length,
            wins: wins.length,
            losses: losses.length,
            winRate: winRate.toFixed(2) + '%',
            avgWin: avgWin.toFixed(2),
            avgLoss: avgLoss.toFixed(2),
            totalProfit: totalProfit.toFixed(2),
            profitFactor: profitFactor === Infinity ? '∞' : profitFactor.toFixed(2),
            dailyTrades: this.dailyTrades,
            dailyPnL: this.dailyPnL.toFixed(2),
            openPositions: this.openPositions.length
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DERIV API CLIENT - FIXED v1.2.0
// ═══════════════════════════════════════════════════════════════════════════════

class DerivAPIClient {
    constructor(config, onMessage) {
        this.config = config;
        this.onMessage = onMessage;
        this.ws = null;
        this.isConnected = false;
        this.isAuthorized = false;
        this.reconnectAttempts = 0;
        this.contracts = new Map();
        this.lastTickTime = Date.now();
        this.requestId = 0;
        this.pendingRequests = new Map();

        // Telegram Configuration
        this.telegramToken = process.env.TELEGRAM_BOT_TOKEN5;
        this.telegramChatId = process.env.TELEGRAM_CHAT_ID2;
        this.telegramEnabled = !!(this.telegramToken && this.telegramChatId);

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
            Logger.info('📱 Telegram notifications enabled');
        } else {
            Logger.warn('📱 Telegram notifications disabled (missing API keys)');
        }
        this.pingInterval = null;
        this.subscriptions = new Map();
    }

    connect() {
        return new Promise((resolve, reject) => {
            const url = `${this.config.ENDPOINT}${this.config.APP_ID}`;
            Logger.info('API', `Connecting to ${url}`);

            this.ws = new WebSocket(url);

            this.ws.on('open', () => {
                Logger.info('API', 'WebSocket connected');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.startPing();
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(message);
                } catch (error) {
                    Logger.error('API', 'Failed to parse message', error.message);
                }
            });

            this.ws.on('error', (error) => {
                Logger.error('API', 'WebSocket error', error.message);
                reject(error);
            });

            this.ws.on('close', (code, reason) => {
                Logger.warn('API', `WebSocket closed: ${code} - ${reason}`);
                this.isConnected = false;
                this.isAuthorized = false;
                this.stopPing();
                this.handleReconnect();
            });
        });
    }

    handleMessage(message) {
        const reqId = message.req_id;
        if (message.msg_type === 'ping') return;

        if (message.error) {
            Logger.error('API', `API Error: ${message.error.message}`, message.error);
            if (this.pendingRequests.has(reqId)) {
                const { reject } = this.pendingRequests.get(reqId);
                this.pendingRequests.delete(reqId);
                reject(message.error);
            }
            return;
        }

        if (this.pendingRequests.has(reqId)) {
            const { resolve } = this.pendingRequests.get(reqId);
            this.pendingRequests.delete(reqId);
            resolve(message);
        }

        this.onMessage(message);
    }

    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;

        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
            Logger.debug('TELEGRAM', 'Message sent');
        } catch (error) {
            Logger.error('TELEGRAM', 'Failed to send message', error.message);
        }
    }

    getTelegramSummary() {
        const stats = this.riskManager.getStatistics();
        const duration = Math.floor((Date.now() - this.performance.startTime) / 1000 / 60);

        return `<b>📊 Opus Performance Report</b>
━━━━━━━━━━━━━━━━━━━━━━━━
<b>Asset:</b> <code>${this.config.TRADING.SYMBOL}</code>
<b>Duration:</b> ${duration} minutes
<b>Total Trades:</b> ${stats.totalTrades}
<b>Win Rate:</b> ${stats.winRate}

✅ <b>Wins:</b> ${stats.wins}
❌ <b>Losses:</b> ${stats.losses}

💰 <b>Net P/L:</b> $${stats.totalProfit}
🏁 <b>Profit Factor:</b> ${stats.profitFactor}

🏦 <b>Current Balance:</b> $${this.riskManager.accountBalance.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━━━━━`;
    }

    async sendTelegramTradeExecution(contract, direction) {
        const stake = parseFloat(contract.buy_price || this.config.TRADING.BASE_STAKE);
        const msg = `🚀 <b>TRADE OPENED</b>
━━━━━━━━━━━━━━━━━━━━━━━━
<b>Type:</b> ${direction === 'BUY' ? '⬆️ CALL (Up)' : '⬇️ PUT (Down)'}
<b>Asset:</b> <code>${this.config.TRADING.SYMBOL}</code>
<b>Contract ID:</b> <code>${contract.contract_id}</code>
<b>Stake:</b> $${stake.toFixed(2)}
<b>Multiplier:</b> x${this.config.TRADING.MULTIPLIER}

<b>Balance:</b> $${this.riskManager.accountBalance.toFixed(2)}
<b>Timestamp:</b> ${new Date().toLocaleTimeString()}
━━━━━━━━━━━━━━━━━━━━━━━━`;
        await this.sendTelegramMessage(msg);
    }

    async sendTelegramTradeSettlement(contract, profit, isWinning) {
        const emoji = isWinning ? '✅ WIN' : '❌ LOSS';
        const stake = parseFloat(contract.buy_price || this.config.TRADING.BASE_STAKE);
        const profitPercent = (profit / stake * 100).toFixed(2);

        const msg = `${isWinning ? '💰' : '📉'} <b>TRADE CLOSED: ${emoji}</b>
━━━━━━━━━━━━━━━━━━━━━━━━
<b>Contract ID:</b> <code>${contract.contract_id}</code>
<b>Asset:</b> <code>${this.config.TRADING.SYMBOL}</code>
<b>Profit/Loss:</b> $${profit.toFixed(2)} (${profitPercent}%)
<b>Entry Spot:</b> ${contract.entry_tick || 'N/A'}
<b>Exit Spot:</b> ${contract.exit_tick || 'N/A'}

<b>Total Trades:</b> ${this.riskManager.tradeHistory.length}
<b>Daily P/L:</b> $${this.riskManager.dailyPnL.toFixed(2)}
<b>Win Rate:</b> ${this.riskManager.getStatistics().winRate}
━━━━━━━━━━━━━━━━━━━━━━━━`;
        await this.sendTelegramMessage(msg);
    }

    send(request, timeout = 30000) {
        return new Promise((resolve, reject) => {
            if (!this.isConnected) {
                reject(new Error('Not connected'));
                return;
            }

            const reqId = ++this.requestId;
            request.req_id = reqId;
            this.pendingRequests.set(reqId, { resolve, reject });

            setTimeout(() => {
                if (this.pendingRequests.has(reqId)) {
                    this.pendingRequests.delete(reqId);
                    reject(new Error('Request timeout'));
                }
            }, timeout);

            this.ws.send(JSON.stringify(request));
        });
    }

    async authorize() {
        Logger.info('API', 'Authorizing...');
        const response = await this.send({ authorize: this.config.API_TOKEN });
        if (response.authorize) {
            this.isAuthorized = true;
            Logger.info('API', `Authorized as: ${response.authorize.email}`);
            return response.authorize;
        }
        throw new Error('Authorization failed');
    }

    async getBalance() {
        const response = await this.send({ balance: 1, subscribe: 1 });
        return response.balance;
    }

    async subscribeTicks(symbol) {
        Logger.info('API', `Subscribing to ticks: ${symbol}`);
        const response = await this.send({ ticks: symbol, subscribe: 1 });
        if (response.subscription) {
            this.subscriptions.set('ticks', response.subscription.id);
        }
        return response;
    }

    async subscribeCandles(symbol, granularity = 60) {
        Logger.info('API', `Subscribing to candles: ${symbol} (${granularity}s)`);
        const response = await this.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: 200,
            end: 'latest',
            granularity: granularity,
            style: 'candles',
            subscribe: 1
        });
        if (response.subscription) {
            this.subscriptions.set('candles', response.subscription.id);
        }
        return response;
    }

    /**
     * Buy multiplier contract - FIXED with proper basis field
     * This is the corrected API structure for Deriv multiplier contracts
     */
    async buyMultiplier(symbol, direction, stake, multiplier) {
        const contractType = direction === 'BUY' ? 'MULTUP' : 'MULTDOWN';

        // CORRECT API STRUCTURE FOR MULTIPLIERS
        const request = {
            buy: 1,
            subscribe: 1,
            price: stake,                    // Maximum price to pay
            parameters: {
                contract_type: contractType,
                symbol: symbol,
                currency: 'USD',
                amount: stake,
                basis: 'stake',              // ← THIS WAS MISSING! Tells API that 'amount' is stake
                multiplier: multiplier,
            }
        };

        Logger.info('API', `Buying ${contractType}`, request.parameters);

        return await this.send(request);
    }

    /**
     * Update contract with stop loss and take profit
     * Called after successful purchase
     */
    async updateContractLimits(contractId, stopLoss, takeProfit) {
        const request = {
            contract_update: 1,
            contract_id: contractId,
            limit_order: {}
        };

        if (stopLoss !== null && stopLoss > 0) {
            request.limit_order.stop_loss = stopLoss;
        }
        if (takeProfit !== null && takeProfit > 0) {
            request.limit_order.take_profit = takeProfit;
        }

        Logger.info('API', `Updating contract ${contractId} limits`, request.limit_order);
        return await this.send(request);
    }

    async sellContract(contractId, price = 0) {
        Logger.info('API', `Selling contract ${contractId}`);
        return await this.send({ sell: contractId, price: price });
    }

    async getOpenPositions() {
        return await this.send({ proposal_open_contract: 1, subscribe: 1 });
    }

    startPing() {
        this.pingInterval = setInterval(() => {
            if (this.isConnected) {
                this.ws.send(JSON.stringify({ ping: 1 }));
            }
        }, this.config.PING_INTERVAL);
    }

    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    handleReconnect() {
        if (this.reconnectAttempts >= this.config.MAX_RECONNECT_ATTEMPTS) {
            Logger.error('API', 'Max reconnection attempts reached');
            process.exit(1);
        }
        this.reconnectAttempts++;
        Logger.info('API', `Reconnecting... Attempt ${this.reconnectAttempts}`);
        setTimeout(() => { this.connect().catch(() => { }); }, this.config.RECONNECT_DELAY);
    }

    disconnect() {
        this.stopPing();
        if (this.ws) this.ws.close();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN TRADING BOT
// ═══════════════════════════════════════════════════════════════════════════════

class GridScalpingBot {
    constructor() {
        this.config = CONFIG;
        this.api = null;
        this.grid = new GridStrategy(this.config.GRID);
        this.signalGenerator = new SignalGenerator(this.config.SIGNALS);
        this.riskManager = new RiskManager(this.config.RISK);

        this.ticks = [];
        this.candles = [];
        this.currentPrice = null;
        this.previousPrice = null;
        this.balance = 0;

        this.isRunning = false;
        this.lastTradeTime = 0;
        this.pendingLimitUpdates = new Map();

        this.startTime = Date.now();
        this.performanceInterval = null;
    }

    async initialize() {
        Logger.banner('DERIV MULTIPLIER GRID SCALPING BOT v1.2.0');

        Logger.info('INIT', 'Initializing bot...');
        Logger.info('INIT', 'Configuration:', {
            symbol: this.config.TRADING.SYMBOL,
            multiplier: this.config.TRADING.MULTIPLIER,
            gridLevels: this.config.GRID.LEVELS,
            maxRiskPerTrade: (this.config.RISK.MAX_RISK_PER_TRADE * 100) + '%',
            minConfluence: this.config.SIGNALS.MIN_CONFLUENCE_SCORE,
            stopLossPercent: this.config.RISK.STOP_LOSS_PERCENT + '%',
            takeProfitPercent: this.config.RISK.TAKE_PROFIT_PERCENT + '%'
        });

        this.api = new DerivAPIClient(this.config.API, this.handleMessage.bind(this));

        try {
            await this.api.connect();
            await this.api.authorize();

            const balanceData = await this.api.getBalance();
            this.balance = parseFloat(balanceData.balance);
            this.riskManager.dayStartBalance = this.balance;

            Logger.info('INIT', `Account balance: $${this.balance.toFixed(2)}`);

            await this.api.subscribeTicks(this.config.TRADING.SYMBOL);
            await this.api.subscribeCandles(this.config.TRADING.SYMBOL, 60);
            await this.api.getOpenPositions();

            this.startPerformanceLogging();

            this.isRunning = true;
            Logger.info('INIT', '✅ Bot initialized successfully');
            Logger.info('INIT', '📊 Using basis: "stake" for multiplier contracts');

            if (this.api.telegramEnabled) {
                this.api.sendTelegramMessage(`🚀 <b>Bot Started: Opus Grid Scalper</b>\n\n<b>Asset:</b> ${this.config.TRADING.SYMBOL}\n<b>Stake:</b> $${this.config.TRADING.BASE_STAKE}\n<b>Balance:</b> $${this.balance.toFixed(2)}`);
            }

        } catch (error) {
            Logger.error('INIT', 'Initialization failed', error.message || error);
            throw error;
        }
    }

    handleMessage(message) {
        switch (message.msg_type) {
            case 'tick': this.handleTick(message.tick); break;
            case 'ohlc': this.handleCandle(message.ohlc); break;
            case 'balance': this.handleBalance(message.balance); break;
            case 'buy': this.handleBuyResponse(message); break;
            case 'proposal_open_contract': this.handleContractUpdate(message.proposal_open_contract); break;
            case 'sell': this.handleSellResponse(message); break;
            case 'contract_update': this.handleContractLimitUpdate(message); break;
        }
    }

    handleTick(tick) {
        this.previousPrice = this.currentPrice;
        this.currentPrice = parseFloat(tick.quote);

        this.ticks.push({ time: tick.epoch * 1000, price: this.currentPrice });
        if (this.ticks.length > 500) this.ticks = this.ticks.slice(-500);

        if (this.config.LOGGING.SHOW_TICKS) {
            Logger.debug('TICK', `${this.config.TRADING.SYMBOL}: ${this.currentPrice.toFixed(5)}`);
        }

        if (this.isRunning && this.previousPrice !== null) {
            this.processTrading();
        }
    }

    handleCandle(ohlc) {
        const candle = {
            time: ohlc.epoch * 1000,
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close)
        };

        const lastCandle = this.candles[this.candles.length - 1];
        if (lastCandle && lastCandle.time === candle.time) {
            this.candles[this.candles.length - 1] = candle;
        } else {
            this.candles.push(candle);
        }

        if (this.candles.length > 200) this.candles = this.candles.slice(-200);
        if (!lastCandle || lastCandle.time !== candle.time) this.updateGrid();
    }

    handleBalance(balance) {
        const newBalance = parseFloat(balance.balance);
        const change = newBalance - this.balance;

        if (Math.abs(change) > 0.001) {
            this.riskManager.updatePnL(change);
            const changeStr = change >= 0 ? `+${change.toFixed(2)}` : change.toFixed(2);
            Logger.info('BALANCE', `Balance updated: $${newBalance.toFixed(2)} (${changeStr})`);
        }

        this.balance = newBalance;
    }

    async handleBuyResponse(response) {
        if (response.buy) {
            const contract = response.buy;
            const contractId = contract.contract_id;

            Logger.trade('POSITION OPENED', {
                'Contract ID': contractId,
                'Type': contract.longcode,
                'Stake': `$${contract.buy_price}`,
                'Multiplier': this.config.TRADING.MULTIPLIER
            });

            this.riskManager.addPosition({
                contractId: contractId,
                buyPrice: contract.buy_price,
                openTime: Date.now()
            });

            // Set SL/TP via contract_update
            if (this.pendingLimitUpdates.has('pending') && this.config.RISK.ENABLE_LIMIT_ORDERS) {
                const limits = this.pendingLimitUpdates.get('pending');
                this.pendingLimitUpdates.delete('pending');

                try {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await this.api.updateContractLimits(contractId, limits.stopLoss, limits.takeProfit);
                    Logger.info('TRADE', `✅ Limits set for contract ${contractId}`, {
                        stopLoss: `$${limits.stopLoss}`,
                        takeProfit: `$${limits.takeProfit}`
                    });
                } catch (error) {
                    Logger.warn('TRADE', `⚠️ Failed to set limits: ${error.message}`);
                }
            }
        }
    }

    handleContractUpdate(contract) {
        if (!contract) return;

        const profit = parseFloat(contract.profit || 0);
        const contractId = contract.contract_id;
        const isComplete = contract.is_sold === 1 || contract.status === 'sold';
        const isWinning = profit >= 0;

        if (isComplete) {
            const result = isWinning ? 'WIN ✅' : 'LOSS ❌';
            Logger.trade('CONTRACT SETTLED', {
                'Contract ID': contractId,
                'Result': result,
                'Profit/Loss': `$${profit.toFixed(2)}`,
                'Exit Reason': contract.status || 'Unknown'
            });

            this.riskManager.removePosition(contractId);
            this.riskManager.recordTrade({
                contractId: contractId,
                profit: profit,
                duration: Date.now() - (contract.date_start * 1000)
            });
        }
    }

    handleSellResponse(response) {
        if (response.sell) {
            Logger.info('TRADE', `Contract ${response.sell.contract_id} sold for $${response.sell.sold_for}`);
        }
    }

    handleContractLimitUpdate(response) {
        if (response.contract_update) {
            Logger.debug('API', 'Contract limits updated', response.contract_update);
        }
    }

    updateGrid() {
        if (this.candles.length < this.config.INDICATORS.ATR_PERIOD + 1) return;

        const closes = this.candles.map(c => c.close);
        const highs = this.candles.map(c => c.high);
        const lows = this.candles.map(c => c.low);

        const atr = TechnicalIndicators.ATR(highs, lows, closes, this.config.INDICATORS.ATR_PERIOD);

        if (atr && this.currentPrice) {
            this.grid.calculateGridLevels(this.currentPrice, atr);
        }
    }

    async processTrading() {
        try {
            const { canTrade } = this.riskManager.canTrade(this.balance);
            if (!canTrade) return;

            const indicators = this.calculateIndicators();
            if (!indicators) return;

            const crossedLevels = this.grid.checkGridCrossing(this.currentPrice, this.previousPrice);

            let gridSignal = { signal: 0, reason: 'No grid crossing' };
            if (crossedLevels.length > 0) {
                const level = crossedLevels[0];
                gridSignal = {
                    signal: level.type === 'BUY' ? 1 : -1,
                    reason: `Grid ${level.type} L${level.level} crossed`
                };
            }

            const signal = this.signalGenerator.generateSignal(indicators, gridSignal, this.currentPrice);

            if (this.config.LOGGING.SHOW_INDICATORS && Math.random() < 0.01) {
                this.logIndicators(indicators, signal);
            }

            if (signal.isValid && signal.direction !== 'NEUTRAL') {
                await this.executeTrade(signal, indicators);
                if (crossedLevels.length > 0) this.grid.triggerLevel(crossedLevels[0]);
            }

        } catch (error) {
            Logger.error('TRADING', 'Error processing trading logic', error.message);
        }
    }

    calculateIndicators() {
        if (this.candles.length < 50) return null;

        const closes = this.candles.map(c => c.close);
        const highs = this.candles.map(c => c.high);
        const lows = this.candles.map(c => c.low);

        return {
            rsi: TechnicalIndicators.RSI(closes, this.config.INDICATORS.RSI_PERIOD),
            macd: TechnicalIndicators.MACD(closes, this.config.INDICATORS.MACD_FAST,
                this.config.INDICATORS.MACD_SLOW, this.config.INDICATORS.MACD_SIGNAL),
            bb: TechnicalIndicators.BollingerBands(closes, this.config.INDICATORS.BB_PERIOD,
                this.config.INDICATORS.BB_STD_DEV),
            emaFast: TechnicalIndicators.EMA(closes, this.config.INDICATORS.EMA_FAST),
            emaSlow: TechnicalIndicators.EMA(closes, this.config.INDICATORS.EMA_SLOW),
            emaTrend: TechnicalIndicators.EMA(closes, this.config.INDICATORS.EMA_TREND),
            atr: TechnicalIndicators.ATR(highs, lows, closes, this.config.INDICATORS.ATR_PERIOD),
            stochastic: TechnicalIndicators.Stochastic(highs, lows, closes),
            momentum: TechnicalIndicators.Momentum(closes),
            roc: TechnicalIndicators.ROC(closes)
        };
    }

    logIndicators(indicators, signal) {
        Logger.debug('INDICATORS', 'Current indicator values', {
            price: this.currentPrice?.toFixed(5),
            rsi: indicators.rsi?.toFixed(2),
            macd: indicators.macd?.histogram?.toFixed(6),
            bb_percentB: indicators.bb?.percentB?.toFixed(2),
            atr: indicators.atr?.toFixed(6),
            emaFast: indicators.emaFast?.toFixed(5),
            emaSlow: indicators.emaSlow?.toFixed(5),
            signalDirection: signal.direction,
            signalScore: signal.score,
            confidence: signal.confidence?.toFixed(2) + '%'
        });
    }

    async executeTrade(signal, indicators) {
        try {
            const stats = this.riskManager.getStatistics();
            const winRate = parseFloat(stats.winRate) / 100 || 0.5;
            const avgWin = parseFloat(stats.avgWin) || 1;
            const avgLoss = parseFloat(stats.avgLoss) || 1;

            const position = this.riskManager.calculatePositionSize(
                this.balance, winRate, avgWin, avgLoss, signal.confidence
            );

            const sltp = this.riskManager.calculateSLTP(
                position.stake, this.config.TRADING.MULTIPLIER, signal.confidence
            );

            // Store pending limits
            this.pendingLimitUpdates.set('pending', {
                stopLoss: sltp.stopLoss,
                takeProfit: sltp.takeProfit,
                direction: signal.direction
            });

            Logger.trade(`${signal.direction} SIGNAL DETECTED`, {
                'Price': this.currentPrice?.toFixed(5),
                'Confidence': signal.confidence?.toFixed(2) + '%',
                'Confluence Score': signal.score,
                'Stake': `$${position.stake}`,
                'Multiplier': `${this.config.TRADING.MULTIPLIER}x`,
                'Stop Loss': `$${sltp.stopLoss} (${sltp.stopLossPercent}% of stake)`,
                'Take Profit': `$${sltp.takeProfit} (${sltp.takeProfitPercent}% of stake)`,
                'Risk/Reward': sltp.riskRewardRatio
            });

            // Execute buy with correct API structure
            await this.api.buyMultiplier(
                this.config.TRADING.SYMBOL,
                signal.direction,
                position.stake,
                this.config.TRADING.MULTIPLIER
            );

            this.lastTradeTime = Date.now();

        } catch (error) {
            Logger.error('TRADE', 'Failed to execute trade', error.message || error);
            this.pendingLimitUpdates.delete('pending');
        }
    }

    startPerformanceLogging() {
        this.logPerformance();
        this.performanceInterval = setInterval(() => {
            this.logPerformance();
            if (this.api.telegramEnabled && (this.riskManager.getStatistics().totalTrades > 0 || this.riskManager.dailyPnL !== 0)) {
                // Assuming getTelegramSummary is a method of GridScalpingBot or can be adapted
                // For now, let's create a simple summary for Telegram
                const stats = this.riskManager.getStatistics();
                const runtime = Math.floor((Date.now() - this.startTime) / 1000 / 60);
                const telegramSummary = `<b>📊 Performance Report</b>
━━━━━━━━━━━━━━━━━━━━━━━━
<b>Asset:</b> <code>${this.config.TRADING.SYMBOL}</code>
<b>Duration:</b> ${runtime} minutes
<b>Total Trades:</b> ${stats.totalTrades}
<b>Win Rate:</b> ${stats.winRate}
<b>Net P/L:</b> $${stats.totalProfit}
<b>Current Balance:</b> $${this.balance.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━━━━━`;
                this.api.sendTelegramMessage(telegramSummary);
            }
        }, this.config.LOGGING.PERFORMANCE_INTERVAL);
    }

    logPerformance() {
        const stats = this.riskManager.getStatistics();
        const runtime = Math.floor((Date.now() - this.startTime) / 1000 / 60);
        const gridStatus = this.grid.getStatus();

        Logger.performance({
            'Runtime': `${runtime} minutes`,
            'Balance': `$${this.balance.toFixed(2)}`,
            'Total Trades': stats.totalTrades,
            'Win Rate': stats.winRate,
            'Daily P&L': `$${stats.dailyPnL}`,
            'Profit Factor': stats.profitFactor,
            'Open Positions': stats.openPositions,
            'Grid Levels Active': gridStatus.totalLevels || 0,
            'Buy Levels Available': gridStatus.buyLevelsAvailable || 0,
            'Sell Levels Available': gridStatus.sellLevelsAvailable || 0
        });
    }

    async stop() {
        Logger.info('BOT', 'Stopping bot...');
        this.isRunning = false;

        if (this.performanceInterval) clearInterval(this.performanceInterval);

        for (const position of this.riskManager.openPositions) {
            try {
                await this.api.sellContract(position.contractId);
                Logger.info('BOT', `Closed position ${position.contractId}`);
            } catch (error) {
                Logger.error('BOT', `Failed to close position ${position.contractId}`, error.message);
            }
        }

        if (this.api) this.api.disconnect();

        const stats = this.riskManager.getStatistics();
        Logger.performance({
            'Final Balance': `$${this.balance.toFixed(2)}`,
            'Total Trades': stats.totalTrades,
            'Win Rate': stats.winRate,
            'Total Profit': `$${stats.totalProfit}`,
            'Profit Factor': stats.profitFactor
        });

        Logger.info('BOT', '✅ Bot stopped gracefully');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    const bot = new GridScalpingBot();

    process.on('SIGINT', async () => {
        Logger.warn('SYSTEM', 'Received SIGINT, shutting down...');
        await bot.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        Logger.warn('SYSTEM', 'Received SIGTERM, shutting down...');
        await bot.stop();
        process.exit(0);
    });

    process.on('uncaughtException', async (error) => {
        Logger.error('SYSTEM', 'Uncaught exception', error.message);
        await bot.stop();
        process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
        Logger.error('SYSTEM', 'Unhandled rejection', { reason: String(reason) });
    });

    try {
        await bot.initialize();
        Logger.info('BOT', '🚀 Bot is running. Press Ctrl+C to stop.');
    } catch (error) {
        Logger.error('SYSTEM', 'Failed to start bot', error.message);
        process.exit(1);
    }
}

main().catch(console.error);
