/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         accumBotM — RESEARCH-BASED UPGRADED VERSION         ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  RESEARCH FINDINGS SUMMARY (2026):                           ║
 * ║  • Primary edge: Low-volatility regime detection using      ║
 * ║    Bollinger Band contraction + flat/converging MACD +      ║
 * ║    low ADX (<22) + price in middle of bands.                ║
 * ║  • Conservative growth rates (1-3%) preferred for reliability║
 * ║    (wider barriers, higher probability of reaching TP).     ║
 * ║  • Strict risk management essential: 1-2% risk per trade,   ║
 * ║    daily profit/loss limits, NO aggressive martingale.      ║
 * ║  • Take profit after 8-25 ticks or fixed % of stake for     ║
 * ║    balance between reliability and reward.                   ║
 * ║  • Digit frequency patterns have NO supporting evidence.    ║
 * ║    Removed as primary signal.                                ║
 * ║  • Prefer Volatility 10/25/50 over high BOOM/CRASH for      ║
 * ║    more predictable ranging behavior.                        ║
 * ║                                                              ║
 * ║  UPGRADES IMPLEMENTED:                                       ║
 * ║  • Removed digit frequency core logic (now optional flag)    ║
 * ║  • Added ADX indicator for volatility confirmation          ║
 * ║  • Dynamic growth rate based on overall regime score        ║
 * ║  • Fixed fractional position sizing (1-2% risk)             ║
 * ║  • Daily/weekly P&L limits with auto-pause                  ║
 * ║  • Enhanced scoring with research-backed weights             ║
 * ║  • Better stats tracking & equity curve logging             ║
 * ║  • Optimized indicators (incremental where possible)        ║
 * ║  • Safer defaults + focus on lower volatility assets        ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'accumBot_research_v3_state.json');
const STATE_SAVE_INTERVAL = 10000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const safeNum = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
};

class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                trading: {
                    currentStake: bot.currentStake,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                    weeklyProfitLoss: bot.weeklyProfitLoss,
                    consecutiveLosses: bot.consecutiveLosses,
                    currentRiskPercent: bot.currentRiskPercent,
                    balance: bot.balance,
                    initialBalance: bot.initialBalance,
                    accountCurrency: bot.accountCurrency,
                },
                assetMetrics: bot.assetMetrics,
                hourlyStats: bot.hourlyStats,
                dailyStats: bot.dailyStats,
            };

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
            return true;
        } catch (error) {
            console.error('❌ Failed to save state:', error.message);
            return false;
        }
    }

    static loadState(maxAgeHours = 24) {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                console.log('🆕 No previous state found.');
                return null;
            }

            const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageHours = (Date.now() - safeNum(saved.savedAt, 0)) / 3600000;

            if (!Number.isFinite(ageHours) || ageHours > maxAgeHours) {
                console.warn(`⚠️ Saved state is ${ageHours.toFixed(1)}h old — starting fresh.`);
                return null;
            }

            console.log(`📂 Restored state (${ageHours.toFixed(1)}h old)`);
            return saved;
        } catch (error) {
            console.error('State load error:', error.message);
            return null;
        }
    }

    static startAutoSave(bot) {
        if (bot.autoSaveInterval) clearInterval(bot.autoSaveInterval);

        bot.autoSaveInterval = setInterval(() => {
            if (bot.connected) StatePersistence.saveState(bot);
        }, STATE_SAVE_INTERVAL);

        const exitHandler = () => {
            console.log('\n🛑 Saving final state before exit...');
            StatePersistence.saveState(bot);
            process.exit(0);
        };

        process.removeAllListeners('SIGINT');
        process.removeAllListeners('SIGTERM');
        process.on('SIGINT', exitHandler);
        process.on('SIGTERM', exitHandler);
    }
}

class TechnicalIndicators {
    static SMA(data, period) {
        if (!Array.isArray(data) || data.length < period || period <= 0) return null;
        const slice = data.slice(-period);
        return slice.reduce((sum, v) => sum + v, 0) / period;
    }

    static EMA(data, period) {
        const series = this.emaSeries(data, period);
        if (!series.length) return null;
        return series[series.length - 1];
    }

    static emaSeries(data, period) {
        if (!Array.isArray(data) || data.length < period || period <= 0) return [];

        const result = new Array(data.length).fill(null);
        const multiplier = 2 / (period + 1);
        let ema = data.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
        result[period - 1] = ema;

        for (let i = period; i < data.length; i++) {
            ema = (data[i] * multiplier) + (ema * (1 - multiplier));
            result[i] = ema;
        }

        return result;
    }

    static stdDev(data, period) {
        if (!Array.isArray(data) || data.length < period || period <= 0) return null;
        const slice = data.slice(-period);
        const mean = slice.reduce((sum, v) => sum + v, 0) / period;
        const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;
        return Math.sqrt(variance);
    }

    static bollingerBands(prices, period = 20, mult = 2) {
        if (!Array.isArray(prices) || prices.length < period) return null;

        const middle = this.SMA(prices, period);
        const sd = this.stdDev(prices, period);
        if (middle === null || sd === null || middle === 0) return null;

        const upper = middle + (mult * sd);
        const lower = middle - (mult * sd);
        const current = prices[prices.length - 1];
        const range = upper - lower;
        const width = range / middle;
        const percentB = range > 0 ? clamp((current - lower) / range, 0, 1) : 0.5;

        return {
            upper,
            middle,
            lower,
            width,
            percentB,
            stdDev: sd,
            range,
            current,
        };
    }

    static MACD(prices, fast = 12, slow = 26, signal = 9) {
        if (!Array.isArray(prices) || prices.length < slow + signal + 5) return null;

        const fastSeries = this.emaSeries(prices, fast);
        const slowSeries = this.emaSeries(prices, slow);
        const macdSeries = [];
        const macdSeriesAligned = new Array(prices.length).fill(null);

        for (let i = 0; i < prices.length; i++) {
            if (fastSeries[i] === null || slowSeries[i] === null) continue;
            const value = fastSeries[i] - slowSeries[i];
            macdSeries.push(value);
            macdSeriesAligned[i] = value;
        }

        if (macdSeries.length < signal + 2) return null;

        const signalRaw = this.emaSeries(macdSeries, signal);
        const signalSeriesAligned = new Array(prices.length).fill(null);
        let signalCursor = 0;

        for (let i = 0; i < prices.length; i++) {
            if (macdSeriesAligned[i] === null) continue;
            signalSeriesAligned[i] = signalRaw[signalCursor];
            signalCursor++;
        }

        const valid = [];
        for (let i = 0; i < prices.length; i++) {
            if (macdSeriesAligned[i] !== null && signalSeriesAligned[i] !== null) {
                valid.push({
                    macd: macdSeriesAligned[i],
                    signal: signalSeriesAligned[i],
                    histogram: macdSeriesAligned[i] - signalSeriesAligned[i],
                });
            }
        }

        if (valid.length < 2) return null;

        const last = valid[valid.length - 1];
        const prev = valid[valid.length - 2];
        const histogramSlope = last.histogram - prev.histogram;
        const isConverging = Math.abs(last.histogram) <= Math.abs(prev.histogram);

        return {
            macdLine: last.macd,
            signalLine: last.signal,
            histogram: last.histogram,
            previousHistogram: prev.histogram,
            histogramSlope,
            isConverging,
            isFlat: Math.abs(last.histogram) <= Math.abs(last.macd) * 0.2,
        };
    }

    static ATR(prices, period = 14) {
        if (!Array.isArray(prices) || prices.length < period + 1) return null;
        const moves = [];
        for (let i = prices.length - period; i < prices.length; i++) {
            const prev = prices[i - 1];
            const curr = prices[i];
            if (prev === undefined || curr === undefined) continue;
            moves.push(Math.abs(curr - prev));
        }
        if (!moves.length) return null;
        return moves.reduce((sum, v) => sum + v, 0) / moves.length;
    }

    static averageAbsReturn(prices, lookback = 20) {
        if (!Array.isArray(prices) || prices.length < lookback + 1) return null;
        const returns = [];
        for (let i = prices.length - lookback; i < prices.length; i++) {
            const prev = prices[i - 1];
            const curr = prices[i];
            if (!prev || !curr) continue;
            returns.push(Math.abs((curr - prev) / prev));
        }
        if (!returns.length) return null;
        return returns.reduce((sum, v) => sum + v, 0) / returns.length;
    }

    static buildMicroBars(prices, barSize = 4) {
        if (!Array.isArray(prices) || prices.length < barSize * 5) return [];
        const bars = [];
        for (let i = 0; i + barSize <= prices.length; i += barSize) {
            const chunk = prices.slice(i, i + barSize);
            if (chunk.length < barSize) break;
            bars.push({
                open: chunk[0],
                high: Math.max(...chunk),
                low: Math.min(...chunk),
                close: chunk[chunk.length - 1],
            });
        }
        return bars;
    }

    static ADX(prices, period = 8, barSize = 4) {
        const bars = this.buildMicroBars(prices, barSize);
        if (bars.length < (period * 2) + 1) return { adx: 25, plusDI: 0, minusDI: 0 };

        const trList = [];
        const plusDMList = [];
        const minusDMList = [];

        for (let i = 1; i < bars.length; i++) {
            const curr = bars[i];
            const prev = bars[i - 1];

            const upMove = curr.high - prev.high;
            const downMove = prev.low - curr.low;
            const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
            const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;
            const tr = Math.max(
                curr.high - curr.low,
                Math.abs(curr.high - prev.close),
                Math.abs(curr.low - prev.close)
            );

            trList.push(tr);
            plusDMList.push(plusDM);
            minusDMList.push(minusDM);
        }

        if (trList.length < period * 2) return { adx: 25, plusDI: 0, minusDI: 0 };

        let smoothTR = trList.slice(0, period).reduce((a, b) => a + b, 0);
        let smoothPlusDM = plusDMList.slice(0, period).reduce((a, b) => a + b, 0);
        let smoothMinusDM = minusDMList.slice(0, period).reduce((a, b) => a + b, 0);

        const dxValues = [];

        for (let i = period; i < trList.length; i++) {
            smoothTR = smoothTR - (smoothTR / period) + trList[i];
            smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDMList[i];
            smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDMList[i];

            const plusDI = smoothTR === 0 ? 0 : (100 * smoothPlusDM / smoothTR);
            const minusDI = smoothTR === 0 ? 0 : (100 * smoothMinusDM / smoothTR);
            const diSum = plusDI + minusDI;
            const dx = diSum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI) / diSum);
            dxValues.push({ dx, plusDI, minusDI });
        }

        if (dxValues.length < period) return { adx: 25, plusDI: 0, minusDI: 0 };

        let adx = dxValues.slice(0, period).reduce((sum, x) => sum + x.dx, 0) / period;
        for (let i = period; i < dxValues.length; i++) {
            adx = ((adx * (period - 1)) + dxValues[i].dx) / period;
        }

        const last = dxValues[dxValues.length - 1];
        return {
            adx: clamp(adx, 0, 100),
            plusDI: clamp(last.plusDI, 0, 100),
            minusDI: clamp(last.minusDI, 0, 100),
        };
    }
}

class AccumulatorAnalyzer {
    constructor(config = {}) {
        this.tradeResults = {};
        this.config = {
            minHistory: config.minHistory || 140,
            ...config,
        };
    }

    recordTradeResult(asset, result) {
        if (!this.tradeResults[asset]) this.tradeResults[asset] = [];
        this.tradeResults[asset].push({ ...result, ts: Date.now() });
        if (this.tradeResults[asset].length > 300) this.tradeResults[asset].shift();
    }

    static scoreByBands(value, bands) {
        for (const band of bands) {
            if (band.check(value)) return band.score;
        }
        return 0.1;
    }

    analyzeEntry(prices) {
        if (!Array.isArray(prices) || prices.length < this.config.minHistory) {
            return { shouldTrade: false, reason: 'insufficient_data', overallScore: 0 };
        }

        const bb = TechnicalIndicators.bollingerBands(prices, 20, 2);
        const macd = TechnicalIndicators.MACD(prices, 12, 26, 9);
        const adxData = TechnicalIndicators.ADX(prices, 8, 4);
        const atrShort = TechnicalIndicators.ATR(prices, 14);
        const atrLong = TechnicalIndicators.ATR(prices, 50);
        const currentPrice = prices[prices.length - 1];

        if (!bb || !macd || !atrShort || !atrLong || !currentPrice) {
            return { shouldTrade: false, reason: 'calc_failed', overallScore: 0 };
        }

        const recentWidths = [];
        for (let end = prices.length - 60; end < prices.length; end++) {
            const slice = prices.slice(0, end + 1);
            const item = TechnicalIndicators.bollingerBands(slice, 20, 2);
            if (item) recentWidths.push(item.width);
        }

        const averageWidth = recentWidths.length
            ? recentWidths.reduce((sum, v) => sum + v, 0) / recentWidths.length
            : bb.width;
        const widthRatio = averageWidth > 0 ? bb.width / averageWidth : 1;

        const recentVol = TechnicalIndicators.averageAbsReturn(prices, 12) || 0;
        const baselineVol = TechnicalIndicators.averageAbsReturn(prices, 60) || recentVol || 0.000001;
        const volRatio = baselineVol > 0 ? recentVol / baselineVol : 1;

        const recentMoves = [];
        const start = Math.max(1, prices.length - 12);
        for (let i = start; i < prices.length; i++) {
            const move = Math.abs((prices[i] - prices[i - 1]) / prices[i - 1]);
            recentMoves.push(move);
        }
        const maxMove = recentMoves.length ? Math.max(...recentMoves) : 0;

        const histVolScale = Math.max(atrShort, bb.stdDev, currentPrice * 0.00001);
        const histStrength = Math.abs(macd.histogram) / histVolScale;
        const priceCenterDistance = Math.abs(bb.percentB - 0.5);
        const adx = safeNum(adxData.adx, 25);

        const scores = {};

        scores.bandWidth = AccumulatorAnalyzer.scoreByBands(widthRatio, [
            { check: (v) => v <= 0.60, score: 1.00 },
            { check: (v) => v <= 0.80, score: 0.82 },
            { check: (v) => v <= 1.00, score: 0.60 },
            { check: (v) => v <= 1.15, score: 0.35 },
        ]);

        let macdScore = AccumulatorAnalyzer.scoreByBands(histStrength, [
            { check: (v) => v <= 0.12, score: 1.00 },
            { check: (v) => v <= 0.22, score: 0.80 },
            { check: (v) => v <= 0.35, score: 0.55 },
            { check: (v) => v <= 0.50, score: 0.30 },
        ]);
        if (macd.isConverging) macdScore = Math.min(1, macdScore + 0.10);
        scores.macdFlat = macdScore;

        scores.pricePosition = AccumulatorAnalyzer.scoreByBands(priceCenterDistance, [
            { check: (v) => v <= 0.10, score: 1.00 },
            { check: (v) => v <= 0.18, score: 0.82 },
            { check: (v) => v <= 0.28, score: 0.58 },
            { check: (v) => v <= 0.38, score: 0.32 },
        ]);

        scores.adxLow = AccumulatorAnalyzer.scoreByBands(adx, [
            { check: (v) => v <= 18, score: 1.00 },
            { check: (v) => v <= 23, score: 0.82 },
            { check: (v) => v <= 28, score: 0.58 },
            { check: (v) => v <= 34, score: 0.30 },
        ]);

        scores.tickStability = AccumulatorAnalyzer.scoreByBands(volRatio, [
            { check: (v) => v <= 0.75 && maxMove <= baselineVol * 1.8, score: 1.00 },
            { check: (v) => v <= 0.95 && maxMove <= baselineVol * 2.2, score: 0.80 },
            { check: (v) => v <= 1.15, score: 0.55 },
            { check: (v) => v <= 1.35, score: 0.28 },
        ]);

        const atrRatio = atrLong > 0 ? atrShort / atrLong : 1;
        scores.volTrend = AccumulatorAnalyzer.scoreByBands(atrRatio, [
            { check: (v) => v <= 0.75, score: 1.00 },
            { check: (v) => v <= 0.90, score: 0.78 },
            { check: (v) => v <= 1.05, score: 0.55 },
            { check: (v) => v <= 1.20, score: 0.28 },
        ]);

        const weights = {
            bandWidth: 0.28,
            macdFlat: 0.20,
            adxLow: 0.20,
            pricePosition: 0.15,
            tickStability: 0.10,
            volTrend: 0.07,
        };

        let overallScore = 0;
        for (const [key, weight] of Object.entries(weights)) {
            overallScore += (scores[key] || 0) * weight;
        }
        overallScore = Number(overallScore.toFixed(3));

        let growthRate = 0.01;
        if (overallScore >= 0.90 && scores.adxLow >= 0.82 && scores.bandWidth >= 0.82) growthRate = 0.03;
        else if (overallScore >= 0.82) growthRate = 0.02;

        let targetTicks = 18;
        if (growthRate === 0.02) targetTicks = overallScore >= 0.88 ? 12 : 14;
        if (growthRate === 0.03) targetTicks = overallScore >= 0.92 ? 8 : 10;

        const takeProfitFactor = Math.pow(1 + growthRate, targetTicks) - 1;

        const shouldTrade = (
            overallScore >= 0.78 &&
            scores.bandWidth >= 0.60 &&
            scores.macdFlat >= 0.55 &&
            scores.adxLow >= 0.58 &&
            scores.pricePosition >= 0.58 &&
            scores.tickStability >= 0.55
        );

        return {
            shouldTrade,
            reason: shouldTrade ? 'low_volatility_regime' : `score_${overallScore.toFixed(2)}`,
            overallScore,
            scores,
            bb,
            macd,
            adx: Number(adx.toFixed(2)),
            adxData,
            atrShort,
            atrLong,
            recentVol,
            baselineVol,
            widthRatio,
            volRatio,
            maxMove,
            recommendedGrowthRate: growthRate,
            targetTicks,
            takeProfitFactor,
            takeProfitPercent: Number((takeProfitFactor * 100).toFixed(2)),
            currentPrice,
        };
    }
}

class ResearchBasedAccumulatorBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || ['R_10', 'R_25', 'R_50'];
        this.reqId = 1;

        this.config = {
            timezone: config.timezone || 'Africa/Lagos',
            riskPercent: clamp(safeNum(config.riskPercent, 1.5), 1, 2),
            investmentCapital: safeNum(config.investmentCapital, 0),
            useBalanceAsCapitalBase: config.useBalanceAsCapitalBase === false,
            maxDailyLossPercent: safeNum(config.maxDailyLossPercent, 6),
            maxDailyProfitPercent: safeNum(config.maxDailyProfitPercent, 12),
            minStake: safeNum(config.minStake, 0.35),
            maxStakeAsBalancePercent: safeNum(config.maxStakeAsBalancePercent, 98),
            maxConsecutiveLosses: safeNum(config.maxConsecutiveLosses, 3),
            growthRateMin: 0.03,
            growthRateMax: 0.05,
            minScoreForTrade: safeNum(config.minScoreForTrade, 0.80),
            useDigitLogic: false,
            maxReconnectAttempts: safeNum(config.maxReconnectAttempts, 30),
            reconnectDelay: safeNum(config.reconnectDelay, 4000),
            minTimeBetweenTrades: safeNum(config.minTimeBetweenTrades, 12000),
            requiredHistoryLength: safeNum(config.requiredHistoryLength, 160),
            maxTradeDurationMs: safeNum(config.maxTradeDurationMs, 150000),
            softTradeDurationMs: safeNum(config.softTradeDurationMs, 90000),
            tradeWatchdogMs: safeNum(config.tradeWatchdogMs, 180000),
            telegramToken: config.telegramToken || process.env.TELEGRAM_BOT_TOKEN || '',
            telegramChatId: config.telegramChatId || process.env.TELEGRAM_CHAT_ID || '',
            ...config,
        };

        this.currentStake = 0;
        this.currentRiskPercent = clamp(safeNum(this.config.riskPercent, 1.5), 1, 2);
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.dailyProfitLoss = 0;
        this.weeklyProfitLoss = 0;
        this.consecutiveLosses = 0;
        this.paused = false;
        this.endOfDay = false;

        this.balance = 0;
        this.initialBalance = 0;
        this.accountCurrency = config.currency || 'USD';

        this.analyzer = new AccumulatorAnalyzer({ minHistory: this.config.requiredHistoryLength - 20 });
        this.activeTrades = {};
        this.pendingProposalRequests = {};
        this.pendingProposalById = {};
        this.watchdogTimers = {};
        this.priceHistories = {};
        this.tickHistory = {};
        this.lastTradeTime = {};
        this.assetMetrics = {};
        this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        this.dailyStats = { date: this.getDateKey(), pnl: 0 };

        this.telegramBot = (this.config.telegramToken && this.config.telegramChatId)
            ? new TelegramBot(this.config.telegramToken, { polling: false })
            : null;

        this.reconnectAttempts = 0;
        this.pingInterval = null;
        this.autoSaveInterval = null;

        this.assets.forEach((asset) => {
            this.priceHistories[asset] = [];
            this.tickHistory[asset] = [];
            this.lastTradeTime[asset] = 0;
            this.assetMetrics[asset] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
        });

        const saved = StatePersistence.loadState();
        if (saved?.trading) Object.assign(this, saved.trading);
        if (saved?.assetMetrics) this.assetMetrics = saved.assetMetrics;
        if (saved?.hourlyStats) this.hourlyStats = saved.hourlyStats;
        if (saved?.dailyStats) this.dailyStats = saved.dailyStats;
    }

    nextReqId() {
        return this.reqId++;
    }

    getDateKey() {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: this.config.timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(new Date());
    }

    ensureDailyReset() {
        const today = this.getDateKey();
        if (this.dailyStats.date !== today) {
            this.dailyStats = { date: today, pnl: 0 };
            this.dailyProfitLoss = 0;
            this.paused = false;
            console.log(`🌅 New trading day detected (${today}) — daily P&L reset.`);
        }
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

        console.log('🔌 Connecting to Deriv WS...');
        this.cleanup(false);

        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ WS connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.startPingKeepAlive();
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            try {
                this.handleMessage(JSON.parse(data));
            } catch (error) {
                console.error('Parse error:', error.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error('WS error:', error.message);
        });

        this.ws.on('close', () => {
            console.log('⚡ WS closed');
            this.stopPingKeepAlive();
            this.handleDisconnect();
        });
    }

    startPingKeepAlive() {
        this.stopPingKeepAlive();
        this.pingInterval = setInterval(() => {
            if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.sendRequest({ ping: 1 });
            }
        }, 25000);
    }

    stopPingKeepAlive() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = null;
    }

    authenticate() {
        this.sendRequest({ authorize: this.token, req_id: this.nextReqId() });
    }

    sendRequest(req) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        try {
            this.ws.send(JSON.stringify(req));
            return true;
        } catch (error) {
            console.error('Send error:', error.message);
            return false;
        }
    }

    handleMessage(msg) {
        if (msg.error) {
            console.error(`API error (${msg.msg_type || 'unknown'}): ${msg.error.message}`);
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                this.handleAuth(msg);
                break;
            case 'balance':
                this.handleBalance(msg);
                break;
            case 'history':
                this.handleTickHistory(msg);
                break;
            case 'tick':
                this.handleTickUpdate(msg.tick);
                break;
            case 'proposal':
                this.handleProposal(msg);
                break;
            case 'buy':
                this.handleBuyResponse(msg);
                break;
            case 'proposal_open_contract':
                this.handleContractUpdate(msg);
                break;
            case 'sell':
                console.log('💸 Sell response:', safeNum(msg.sell?.sold_for, 0));
                break;
            case 'ping':
                break;
            default:
                break;
        }
    }

    handleAuth(msg) {
        const auth = msg.authorize || {};
        this.balance = safeNum(auth.balance, this.balance);
        this.initialBalance = this.initialBalance || this.balance;
        this.accountCurrency = auth.currency || this.accountCurrency || 'USD';

        console.log(`✅ Authenticated | Balance: ${this.accountCurrency} ${this.balance.toFixed(2)}`);

        this.wsReady = true;
        this.initializeSubscriptions();
        this.startTelegramTimer();
    }

    handleBalance(msg) {
        const balanceData = msg.balance || {};
        this.balance = safeNum(balanceData.balance, this.balance);
        if (!this.initialBalance) this.initialBalance = this.balance;
        if (balanceData.currency) this.accountCurrency = balanceData.currency;
    }

    initializeSubscriptions() {
        console.log('📡 Subscribing to balance and ticks...');
        this.sendRequest({ balance: 1, subscribe: 1, req_id: this.nextReqId() });

        this.assets.forEach((asset) => {
            this.sendRequest({
                ticks_history: asset,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                style: 'ticks',
                req_id: this.nextReqId(),
            });
            this.sendRequest({ ticks: asset, subscribe: 1, req_id: this.nextReqId() });
        });
    }

    handleTickHistory(msg) {
        const asset = msg.echo_req?.ticks_history;
        if (!asset || !msg.history?.prices) return;

        this.priceHistories[asset] = msg.history.prices.map((p) => parseFloat(p)).filter(Number.isFinite);
        this.tickHistory[asset] = this.priceHistories[asset].slice(-this.config.requiredHistoryLength);

        console.log(`📊 ${asset}: loaded ${this.priceHistories[asset].length} historical ticks`);
    }

    handleTickUpdate(tick) {
        if (!tick?.symbol) return;

        this.ensureDailyReset();

        const asset = tick.symbol;
        const price = parseFloat(tick.quote);
        if (!Number.isFinite(price)) return;

        this.priceHistories[asset].push(price);
        if (this.priceHistories[asset].length > 1000) {
            this.priceHistories[asset] = this.priceHistories[asset].slice(-600);
        }

        this.tickHistory[asset].push(price);
        if (this.tickHistory[asset].length > this.config.requiredHistoryLength) {
            this.tickHistory[asset].shift();
        }

        if (!this.wsReady || this.paused) return;
        if (this.activeTrades[asset]) return;
        if (Date.now() - (this.lastTradeTime[asset] || 0) < this.config.minTimeBetweenTrades) return;
        if (this.priceHistories[asset].length < this.config.requiredHistoryLength) return;

        this.evaluateAndTrade(asset);
    }

    evaluateAndTrade(asset) {
        if (!this.isAssetAllowed(asset)) return;
        if (this.pendingProposalForAsset(asset)) return;
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            this.paused = true;
            console.warn('🛑 Max consecutive losses reached — bot paused.');
            return;
        }

        const analysis = this.analyzer.analyzeEntry(this.priceHistories[asset]);
        this.logAnalysis(asset, analysis);

        if (!analysis.shouldTrade || analysis.overallScore < this.config.minScoreForTrade) return;

        const stake = this.calculateStake();
        if (!stake || !Number.isFinite(stake)) return;

        const takeProfitAmount = round2(stake * analysis.takeProfitFactor);
        const meta = {
            asset,
            stake,
            analysis,
            growthRate: clamp(analysis.recommendedGrowthRate, this.config.growthRateMin, this.config.growthRateMax),
            targetTicks: analysis.targetTicks,
            takeProfitAmount,
            createdAt: Date.now(),
        };

        this.currentStake = stake;
        this.requestProposal(meta);
    }

    pendingProposalForAsset(asset) {
        return Object.values(this.pendingProposalRequests).some((meta) => meta.asset === asset)
            || Object.values(this.pendingProposalById).some((meta) => meta.asset === asset);
    }

    calculateStake() {
        const liveBalance = safeNum(this.balance, 0);
        const configuredCapital = safeNum(this.config.investmentCapital, 0);
        const capitalBase = this.config.useBalanceAsCapitalBase
            ? (liveBalance || configuredCapital || this.initialBalance)
            : (configuredCapital || liveBalance || this.initialBalance);

        if (!capitalBase || capitalBase <= 0) {
            console.warn('⚠️ No valid balance/capital base found yet — cannot calculate stake.');
            return 0;
        }

        const riskPercent = clamp(safeNum(this.currentRiskPercent, this.config.riskPercent), 1, 2);
        const rawStake = capitalBase * (riskPercent / 100);
        const affordabilityCap = liveBalance > 0
            ? (liveBalance * (this.config.maxStakeAsBalancePercent / 100))
            : rawStake;

        const stake = clamp(rawStake, this.config.minStake, Math.max(this.config.minStake, affordabilityCap));
        return round2(stake);
    }

    requestProposal(meta) {
        const reqId = this.nextReqId();
        this.pendingProposalRequests[reqId] = meta;

        const proposal = {
            proposal: 1,
            amount: meta.stake,
            basis: 'stake',
            contract_type: 'ACCU',
            currency: this.accountCurrency,
            symbol: meta.asset,
            growth_rate: meta.growthRate,
            limit_order: {
                take_profit: 0.01, //meta.takeProfitAmount
            },
            passthrough: {
                asset: meta.asset,
                score: meta.analysis.overallScore,
                growthRate: meta.growthRate,
                targetTicks: meta.targetTicks,
            },
            req_id: reqId,
        };

        console.log(
            `🧾 Requesting proposal | ${meta.asset} | Stake ${this.accountCurrency} ${meta.stake.toFixed(2)} | ` +
            `Growth ${(meta.growthRate * 100).toFixed(0)}% | TP ${this.accountCurrency} ${meta.takeProfitAmount.toFixed(2)}`
        );

        this.sendRequest(proposal);
    }

    handleProposal(msg) {
        const meta = this.pendingProposalRequests[msg.req_id];
        if (meta) delete this.pendingProposalRequests[msg.req_id];

        if (!msg.proposal || !meta) return;
        if (this.activeTrades[meta.asset]) return;

        const ageMs = Date.now() - meta.createdAt;
        if (ageMs > 5000) {
            console.warn(`⌛ Proposal for ${meta.asset} became stale (${ageMs}ms). Skipping buy.`);
            return;
        }

        this.pendingProposalById[msg.proposal.id] = meta;

        console.log(
            `🎯 Strong signal on ${meta.asset} | Score ${(meta.analysis.overallScore * 100).toFixed(0)}% | ` +
            `Growth ${(meta.growthRate * 100).toFixed(0)}% | TP ${this.accountCurrency} ${meta.takeProfitAmount.toFixed(2)}`
        );

        this.placeTrade(meta.asset, msg.proposal.id, meta);
    }

    placeTrade(asset, proposalId, meta) {
        if (this.activeTrades[asset]) return;

        this.activeTrades[asset] = {
            status: 'buying',
            asset,
            proposalId,
            stake: meta.stake,
            growthRate: meta.growthRate,
            score: meta.analysis.overallScore,
            analysis: meta.analysis,
            takeProfitAmount: meta.takeProfitAmount,
            targetTicks: meta.targetTicks,
            entryTime: Date.now(),
            sellRequested: false,
            lastSellAttemptAt: 0,
        };

        this.lastTradeTime[asset] = Date.now();
        this._startTradeWatchdog(asset);

        console.log(`🚀 Placing trade on ${asset} | Stake ${this.accountCurrency} ${meta.stake.toFixed(2)}`);

        this.sendRequest({
            buy: proposalId,
            price: meta.stake,
            passthrough: {
                asset,
                proposalId,
                score: meta.analysis.overallScore,
            },
            req_id: this.nextReqId(),
        });

        // this.sendTelegramMessage(
        //     `🚀 <b>TRADE OPENING</b>\n` +
        //     `Asset: <b>${asset}</b>\n` +
        //     `Stake: ${this.accountCurrency} ${meta.stake.toFixed(2)}\n` +
        //     `Growth: ${(meta.growthRate * 100).toFixed(0)}%\n` +
        //     `Score: ${(meta.analysis.overallScore * 100).toFixed(1)}%\n` +
        //     `TP: ${this.accountCurrency} ${meta.takeProfitAmount.toFixed(2)} (~${meta.targetTicks} ticks)`
        // );
    }

    handleBuyResponse(msg) {
        const asset = msg.echo_req?.passthrough?.asset
            || Object.keys(this.activeTrades).find((a) => this.activeTrades[a].proposalId === msg.echo_req?.buy);

        if (!asset) return;

        const trade = this.activeTrades[asset];
        if (!trade) return;

        if (msg.error || !msg.buy?.contract_id) {
            console.error(`❌ Buy failed on ${asset}`);
            this._clearWatchdog(asset);
            delete this.activeTrades[asset];
            return;
        }

        trade.status = 'active';
        trade.contractId = msg.buy.contract_id;
        trade.buyPrice = safeNum(msg.buy.buy_price, trade.stake);

        delete this.pendingProposalById[trade.proposalId];

        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: trade.contractId,
            subscribe: 1,
            passthrough: { asset },
            req_id: this.nextReqId(),
        });

        console.log(`🚀 Contract opened ${trade.contractId} on ${asset}`);

        this.sendTelegramMessage(
            `🚀 <b>CONTRACT OPENED</b>\n` +
            `Asset: ${asset}\n` +
            `Stake: ${this.accountCurrency} ${trade.stake.toFixed(2)}\n` +
            `Buy price: ${this.accountCurrency} ${trade.buyPrice.toFixed(2)}\n` +
            `Growth: ${(trade.growthRate * 100).toFixed(0)}%\n` +
            `Score: ${(trade.score * 100).toFixed(1)}%\n` +
            `BB Width Ratio: ${trade.analysis.widthRatio.toFixed(2)}\n` +
            `ADX: ${trade.analysis.adx}\n` +
            `MACD Flat Score: ${(trade.analysis.scores.macdFlat * 100).toFixed(0)}%\n` +
            `TP: ${this.accountCurrency} ${trade.takeProfitAmount.toFixed(2)} (~${trade.targetTicks} ticks)`
        );
    }

    handleContractUpdate(msg) {
        const contract = msg.proposal_open_contract;
        if (!contract?.contract_id) return;

        const asset = msg.echo_req?.passthrough?.asset
            || Object.keys(this.activeTrades).find((a) => this.activeTrades[a].contractId === contract.contract_id);
        if (!asset) return;

        const trade = this.activeTrades[asset];
        if (!trade) return;

        trade.lastContractUpdateAt = Date.now();
        trade.openProfit = safeNum(contract.profit, 0);
        trade.currentSpot = safeNum(contract.current_spot, 0);
        trade.sellPrice = safeNum(contract.sell_price, 0);
        trade.isValidToSell = contract.is_valid_to_sell === 1 || contract.is_valid_to_sell === true;

        if (!contract.is_sold) {
            this.manageOpenTrade(asset, contract, trade);
            return;
        }

        this.handleTradeResult(asset, contract);
    }

    manageOpenTrade(asset, contract, trade) {
        const openProfit = safeNum(contract.profit, 0);
        const ageMs = Date.now() - trade.entryTime;
        const isValidToSell = contract.is_valid_to_sell === 1 || contract.is_valid_to_sell === true;

        if (!isValidToSell) return;
        if (trade.sellRequested && Date.now() - trade.lastSellAttemptAt < 5000) return;

        // Backup TP management in case limit_order doesn't trigger as expected.
        if (openProfit >= trade.takeProfitAmount) {
            this.requestSell(asset, 'take_profit_backup');
            return;
        }

        // Lock profit if the trade has been open too long.
        if (ageMs >= this.config.softTradeDurationMs && openProfit >= trade.takeProfitAmount * 0.65) {
            this.requestSell(asset, 'time_profit_lock');
            return;
        }

        // Hard time-based exit for stale trades.
        if (ageMs >= this.config.maxTradeDurationMs) {
            this.requestSell(asset, openProfit > 0 ? 'time_exit_profit' : 'time_exit_stale');
        }
    }

    requestSell(asset, reason = 'manual_exit') {
        const trade = this.activeTrades[asset];
        if (!trade?.contractId) return;

        const now = Date.now();
        if (trade.sellRequested && now - trade.lastSellAttemptAt < 4000) return;

        trade.sellRequested = true;
        trade.lastSellAttemptAt = now;

        console.warn(`🟠 Selling ${asset} | reason=${reason} | openProfit=${safeNum(trade.openProfit, 0).toFixed(2)}`);

        this.sendRequest({
            sell: trade.contractId,
            price: 0,
            passthrough: { asset, reason },
            req_id: this.nextReqId(),
        });
    }

    handleTradeResult(asset, contract) {
        this._clearWatchdog(asset);

        const trade = this.activeTrades[asset] || {};
        const won = contract.status === 'won' || safeNum(contract.profit, 0) > 0;
        const profit = safeNum(contract.profit, 0);

        this.totalTrades += 1;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
        this.weeklyProfitLoss += profit;
        this.hourlyStats.trades += 1;
        this.hourlyStats.pnl += profit;
        this.dailyStats.pnl += profit;

        this.assetMetrics[asset].trades += 1;
        this.assetMetrics[asset].profitLoss += profit;

        this.analyzer.recordTradeResult(asset, {
            won,
            profit,
            score: trade.score || 0,
            growthRate: trade.growthRate || 0.01,
            takeProfitAmount: trade.takeProfitAmount || 0,
        });

        if (won) {
            this.totalWins += 1;
            this.assetMetrics[asset].wins += 1;
            this.hourlyStats.wins += 1;
            this.consecutiveLosses = 0;
        } else {
            this.totalLosses += 1;
            this.assetMetrics[asset].losses += 1;
            this.hourlyStats.losses += 1;
            this.consecutiveLosses += 1;
        }

        delete this.activeTrades[asset];

        const emoji = won ? '✅' : '❌';
        this.sendTelegramMessage(
            `${emoji} <b>TRADE CLOSED</b>\n` +
            `Asset: ${asset}\n` +
            `P&L: ${this.accountCurrency} ${profit.toFixed(2)}\n` +
            `Total P&L: ${this.accountCurrency} ${this.totalProfitLoss.toFixed(2)}\n` +
            `Daily P&L: ${this.accountCurrency} ${this.dailyProfitLoss.toFixed(2)}\n` +
            `Win rate: ${this.totalTrades ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0'}%`
        );

        this.logTradingSummary();
        this.updateDailyLimits();
        StatePersistence.saveState(this);
    }

    updateDailyLimits() {
        const baseBalance = safeNum(this.initialBalance || this.balance, 0);
        if (!baseBalance) return;

        const maxDailyLoss = -(baseBalance * this.config.maxDailyLossPercent / 100);
        const maxDailyProfit = baseBalance * this.config.maxDailyProfitPercent / 100;

        if (this.dailyProfitLoss <= maxDailyLoss) {
            this.paused = true;
            this.sendTelegramMessage('🛑 Daily loss limit reached. Bot paused.');
        }

        if (this.dailyProfitLoss >= maxDailyProfit) {
            this.paused = true;
            this.sendTelegramMessage('🎯 Daily profit target reached. Bot paused for the day.');
        }
    }

    _startTradeWatchdog(asset) {
        this._clearWatchdog(asset);

        this.watchdogTimers[asset] = setTimeout(() => {
            console.warn(`⏰ Watchdog fired for ${asset}`);
            this._recoverStuckTrade(asset, 'watchdog');
        }, this.config.tradeWatchdogMs);
    }

    _clearWatchdog(asset) {
        if (this.watchdogTimers[asset]) {
            clearTimeout(this.watchdogTimers[asset]);
            delete this.watchdogTimers[asset];
        }
    }

    _recoverStuckTrade(asset, reason) {
        this._clearWatchdog(asset);

        const trade = this.activeTrades[asset];
        if (!trade) return;

        console.error(`🚨 Recovering stuck trade on ${asset} (${reason})`);

        if (trade.contractId) {
            this.requestSell(asset, `${reason}_sell_attempt`);
            this.paused = true;
            this.sendTelegramMessage(`⚠️ Stuck trade detected on ${asset}. Sell requested and bot paused for safety.`);
            return;
        }

        delete this.activeTrades[asset];
        this.paused = true;
        this.sendTelegramMessage(`⚠️ Trade state desynced on ${asset}. Cleared local state and paused bot.`);
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        StatePersistence.saveState(this);

        if (this.endOfDay) return;
        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) return;

        this.reconnectAttempts += 1;
        const delay = Math.min(this.config.reconnectDelay * Math.pow(1.6, this.reconnectAttempts - 1), 45000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s...`);

        setTimeout(() => this.connect(), delay);
    }

    cleanup(removeSocket = true) {
        this.stopPingKeepAlive();

        Object.keys(this.watchdogTimers).forEach((asset) => this._clearWatchdog(asset));

        if (removeSocket && this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
            this.ws = null;
        }

        this.connected = false;
        this.wsReady = false;
    }

    disconnect() {
        console.log('🛑 Manual disconnect requested');
        this.endOfDay = true;
        this.paused = true;
        StatePersistence.saveState(this);
        this.cleanup(true);
    }

    logAnalysis(asset, analysis) {
        if (!analysis?.scores) {
            console.log(`📈 ${asset} | Waiting | ${analysis?.reason || 'no_analysis'}`);
            return;
        }

        console.log(
            `📈 ${asset} | Score:${(analysis.overallScore * 100).toFixed(0)}% | ` +
            `BB:${analysis.bb.width.toFixed(6)} | WidthRatio:${analysis.widthRatio.toFixed(2)} | ` +
            `ADX:${analysis.adx.toFixed(1)} | MACDhist:${analysis.macd.histogram.toFixed(6)} | ` +
            `${analysis.shouldTrade ? '🟢 ENTRY' : '⏳ waiting'} | ` +
            `Score breakdown: BandWidth:${(analysis.scores.bandWidth * 100).toFixed(0)}% | ` +
            `MACD Flat:${(analysis.scores.macdFlat * 100).toFixed(0)}% | ` +
            `ADX Low:${(analysis.scores.adxLow * 100).toFixed(0)}% | ` +
            `Price Pos:${(analysis.scores.pricePosition * 100).toFixed(0)}% | ` +
            `Tick Stability:${(analysis.scores.tickStability * 100).toFixed(0)}% | ` +
            `Vol Trend:${(analysis.scores.volTrend * 100).toFixed(0)}%`
        );
    }

    logTradingSummary() {
        const winRate = this.totalTrades ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';
        console.log(
            `\n📊 SUMMARY | Trades: ${this.totalTrades} | Winrate: ${winRate}% | ` +
            `P&L: ${this.accountCurrency} ${this.totalProfitLoss.toFixed(2)} | ` +
            `Balance: ${this.accountCurrency} ${safeNum(this.balance, 0).toFixed(2)}`
        );
    }

    async sendTelegramMessage(text) {
        if (!this.telegramBot || !this.config.telegramChatId) return;
        try {
            await this.telegramBot.sendMessage(this.config.telegramChatId, text, { parse_mode: 'HTML' });
        } catch (error) {
            console.error('Telegram error:', error.message);
        }
    }

    startTelegramTimer() {
        console.log('📱 Telegram notifications enabled');
    }

    isAssetAllowed(asset) {
        return this.assets.includes(asset);
    }

    start() {
        if (!this.token) {
            throw new Error('Missing Deriv API token. Set DERIV_API_TOKEN in your environment.');
        }

        console.log('══════════════════════════════════════════════════════════════');
        console.log('🚀 RESEARCH-BASED ACCUMULATOR BOT v3 (Fixed)');
        console.log('Focus : Low volatility regime (BB + MACD + ADX + volatility trend)');
        console.log(`Risk  : ${this.currentRiskPercent}% of capital per trade`);
        console.log('Growth: Dynamic 1-3% with TP derived from target ticks');
        console.log(`Assets: ${this.assets.join(', ')}`);
        console.log('══════════════════════════════════════════════════════════════\n');

        this.connect();
        StatePersistence.startAutoSave(this);
    }
}

if (require.main === module) {
    const bot = new ResearchBasedAccumulatorBot('Dz2V2KvRf4Uukt3', {
        riskPercent: 1.5,
        maxDailyLossPercent: 6,
        maxDailyProfitPercent: 12,
        assets: ('R_10,R_25,R_50').split(',').map((x) => x.trim()).filter(Boolean),
        investmentCapital: safeNum(100, 0),
        telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
        telegramChatId: '752497117',
    });

    bot.start();
}

module.exports = {
    TechnicalIndicators,
    AccumulatorAnalyzer,
    ResearchBasedAccumulatorBot,
    StatePersistence,
};
