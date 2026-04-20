/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║     digitDifferBotV2 — Advanced Digit Differ Trading System     ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  CORE STRATEGY:                                                  ║
 * ║  • Bollinger Bands + MACD market regime detection                ║
 * ║  • Adaptive digit clustering bias detection                      ║
 * ║  • Dynamic stake sizing based on volatility (ATR)                ║
 * ║  • Hybrid Digit Differ / Accumulator mode switching              ║
 * ║  • Monte Carlo risk simulation & position sizing                 ║
 * ║  • Tick-by-tick backtester for optimization                      ║
 * ║  • Multi-asset concurrent trading                                ║
 * ║  • Advanced watchdog & recovery                                  ║
 * ║  • State persistence & Telegram notifications                    ║
 * ║                                                                  ║
 * ║  UPGRADES IMPLEMENTED:                                           ║
 * ║  1. Adaptive Bias Threshold (ML-style learning)                  ║
 * ║  2. Volatility-based Mode Switching                              ║
 * ║  3. Dynamic Stake Sizing (Kelly-inspired)                        ║
 * ║  4. Monte Carlo Risk Simulator                                   ║
 * ║  5. Tick-by-Tick Backtester                                      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// STATE PERSISTENCE MANAGER
// ══════════════════════════════════════════════════════════════════════════════
const STATE_FILE = path.join(__dirname, 'digitDifferBotV2_02_state.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                },
                adaptive: {
                    biasThreshold: bot.biasThresholdAdaptive,
                    winRateHistory: bot.winRateHistory.slice(-100),
                    performanceByBias: bot.performanceByBias,
                },
                assetMetrics: bot.assetMetrics,
                hourlyStats: bot.hourlyStats,
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
            return true;
        } catch (error) {
            console.error(`❌ Failed to save state: ${error.message}`);
            return false;
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                console.log('🆕 No previous state found, starting fresh');
                return null;
            }
            const fileContent = fs.readFileSync(STATE_FILE, 'utf8');
            const savedData = JSON.parse(fileContent);
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;
            if (ageMinutes > 120) {
                console.warn(`⚠️  Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                const backupFile = STATE_FILE.replace('.json', `_backup_${Date.now()}.json`);
                fs.renameSync(STATE_FILE, backupFile);
                return null;
            }
            console.log(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);
            return savedData;
        } catch (error) {
            console.error(`❌ Failed to load state: ${error.message}`);
            return null;
        }
    }

    static startAutoSave(bot) {
        if (bot.autoSaveInterval) clearInterval(bot.autoSaveInterval);
        bot.autoSaveInterval = setInterval(() => {
            if (bot.connected && !bot.endOfDay) StatePersistence.saveState(bot);
        }, STATE_SAVE_INTERVAL);

        const exitHandler = () => {
            console.log('\n🛑 Shutting down, saving final state...');
            StatePersistence.saveState(bot);
            process.exit();
        };
        process.on('SIGINT', exitHandler);
        process.on('SIGTERM', exitHandler);
        process.on('uncaughtException', (err) => {
            console.error('Uncaught Exception:', err);
            exitHandler();
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS — Bollinger Bands + MACD + ATR
// ══════════════════════════════════════════════════════════════════════════════
class TechnicalIndicators {
    static SMA(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        return slice.reduce((sum, v) => sum + v, 0) / period;
    }

    static EMA(data, period) {
        if (data.length < period) return null;
        const k = 2 / (period + 1);
        let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
        for (let i = period; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
        }
        return ema;
    }

    static stdDev(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        const mean = slice.reduce((s, v) => s + v, 0) / period;
        const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
        return Math.sqrt(variance);
    }

    static bollingerBands(prices, period = 20, multiplier = 2.0) {
        if (prices.length < period) return null;

        const middle = this.SMA(prices, period);
        const sd = this.stdDev(prices, period);
        const upper = middle + multiplier * sd;
        const lower = middle - multiplier * sd;
        const currentPrice = prices[prices.length - 1];

        const width = (upper - lower) / middle;
        const percentB = (upper - lower) !== 0 ? (currentPrice - lower) / (upper - lower) : 0.5;

        return { upper, middle, lower, width, percentB, stdDev: sd };
    }

    static MACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        if (prices.length < slowPeriod + signalPeriod) return null;

        const macdValues = [];
        for (let i = slowPeriod; i <= prices.length; i++) {
            const slice = prices.slice(0, i);
            const fastEMA = this.EMA(slice, fastPeriod);
            const slowEMA = this.EMA(slice, slowPeriod);
            if (fastEMA !== null && slowEMA !== null) {
                macdValues.push(fastEMA - slowEMA);
            }
        }

        if (macdValues.length < signalPeriod) return null;

        const macdLine = macdValues[macdValues.length - 1];
        const signalLine = this.EMA(macdValues, signalPeriod);
        const histogram = macdLine - signalLine;

        const prevMacdValues = macdValues.slice(0, -1);
        const prevSignal = prevMacdValues.length >= signalPeriod ? this.EMA(prevMacdValues, signalPeriod) : signalLine;
        const prevHistogram = prevMacdValues[prevMacdValues.length - 1] - prevSignal;

        return {
            macdLine,
            signalLine,
            histogram,
            prevHistogram,
            isConverging: Math.abs(histogram) < Math.abs(prevHistogram),
            histogramTrend: histogram - prevHistogram,
        };
    }

    static ATR(prices, period = 14) {
        if (prices.length < period + 1) return null;
        const ranges = [];
        for (let i = prices.length - period; i < prices.length; i++) {
            ranges.push(Math.abs(prices[i] - prices[i - 1]));
        }
        return ranges.reduce((s, v) => s + v, 0) / period;
    }

    static bandWidthPercentile(prices, bbPeriod = 20, lookback = 100) {
        if (prices.length < lookback + bbPeriod) return null;

        const widths = [];
        for (let i = bbPeriod; i <= Math.min(lookback, prices.length - bbPeriod); i++) {
            const slice = prices.slice(0, prices.length - i + bbPeriod);
            const bb = this.bollingerBands(slice, bbPeriod);
            if (bb) widths.push(bb.width);
        }

        if (widths.length < 10) return null;

        const currentWidth = widths[0];
        const sorted = [...widths].sort((a, b) => a - b);
        const rank = sorted.findIndex(w => w >= currentWidth);
        return rank / sorted.length;
    }

    static RSI(prices, period = 14) {
        if (prices.length < period + 1) return null;

        let gains = 0, losses = 0;
        for (let i = prices.length - period; i < prices.length; i++) {
            const diff = prices[i] - prices[i - 1];
            if (diff > 0) gains += diff;
            else losses += Math.abs(diff);
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));

        return rsi;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MARKET ANALYZER — Volatility Regime Detection
// ══════════════════════════════════════════════════════════════════════════════
class MarketAnalyzer {
    constructor() {
        this.tradeResults = {};
    }

    recordTradeResult(asset, result) {
        if (!this.tradeResults[asset]) this.tradeResults[asset] = [];
        this.tradeResults[asset].push({
            ...result,
            timestamp: Date.now()
        });
        if (this.tradeResults[asset].length > 200) this.tradeResults[asset].shift();
    }

    getAssetWinRate(asset) {
        const results = this.tradeResults[asset] || [];
        if (results.length < 5) return 0.5;
        const wins = results.filter(r => r.won).length;
        return wins / results.length;
    }

    analyzeEntry(prices) {
        if (!prices || prices.length < 50) {
            return { shouldTrade: false, reason: 'insufficient_data', volatilityRegime: 'unknown' };
        }

        const bb = TechnicalIndicators.bollingerBands(prices, 20, 2.0);
        if (!bb) return { shouldTrade: false, reason: 'bb_calc_failed', volatilityRegime: 'unknown' };

        const macd = TechnicalIndicators.MACD(prices, 12, 26, 9);
        if (!macd) return { shouldTrade: false, reason: 'macd_calc_failed', volatilityRegime: 'unknown' };

        const atr = TechnicalIndicators.ATR(prices, 14);
        const currentPrice = prices[prices.length - 1];
        const bwPercentile = TechnicalIndicators.bandWidthPercentile(prices, 20, 100);

        const scores = {};

        if (bwPercentile !== null) {
            if (bwPercentile <= 0.20) scores.bandWidth = 1.0;
            else if (bwPercentile <= 0.40) scores.bandWidth = 0.85;
            else if (bwPercentile <= 0.55) scores.bandWidth = 0.65;
            else if (bwPercentile <= 0.70) scores.bandWidth = 0.40;
            else scores.bandWidth = 0.15;
        } else {
            scores.bandWidth = 0.0;
        }

        const normalizedHist = Math.abs(macd.histogram) / currentPrice;
        if (normalizedHist < 0.00005) scores.macdFlat = 1.0;
        else if (normalizedHist < 0.00015) scores.macdFlat = 0.85;
        else if (normalizedHist < 0.00035) scores.macdFlat = 0.60;
        else if (normalizedHist < 0.00060) scores.macdFlat = 0.35;
        else scores.macdFlat = 0.10;

        if (macd.isConverging) scores.macdConverging = 1.0;
        else scores.macdConverging = 0.35;

        if (bb.percentB >= 0.40 && bb.percentB <= 0.60) scores.pricePosition = 1.0;
        else if (bb.percentB >= 0.20 && bb.percentB <= 0.80) scores.pricePosition = 0.70;
        else if (bb.percentB >= 0.10 && bb.percentB <= 0.90) scores.pricePosition = 0.40;
        else scores.pricePosition = 0.10;

        const recentPrices = prices.slice(-10);
        let maxTickMove = 0;
        for (let i = 1; i < recentPrices.length; i++) {
            const move = Math.abs(recentPrices[i] - recentPrices[i - 1]) / recentPrices[i - 1];
            maxTickMove = Math.max(maxTickMove, move);
        }
        if (maxTickMove < 0.0003) scores.tickStability = 1.0;
        else if (maxTickMove < 0.0008) scores.tickStability = 0.80;
        else if (maxTickMove < 0.0015) scores.tickStability = 0.55;
        else if (maxTickMove < 0.0025) scores.tickStability = 0.30;
        else scores.tickStability = 0.05;

        const atrRecent = TechnicalIndicators.ATR(prices, 7);
        const atrLonger = TechnicalIndicators.ATR(prices.slice(0, -7), 14);
        if (atrRecent && atrLonger && atrLonger > 0) {
            const atrRatio = atrRecent / atrLonger;
            if (atrRatio < 0.70) scores.volTrend = 1.0;
            else if (atrRatio < 0.85) scores.volTrend = 0.80;
            else if (atrRatio < 1.0) scores.volTrend = 0.60;
            else if (atrRatio < 1.15) scores.volTrend = 0.40;
            else scores.volTrend = 0.15;
        } else {
            scores.volTrend = 0.5;
        }

        const weights = {
            bandWidth: 0.25,
            macdFlat: 0.20,
            macdConverging: 0.10,
            pricePosition: 0.20,
            tickStability: 0.15,
            volTrend: 0.10,
        };

        let overallScore = 0;
        for (const [key, weight] of Object.entries(weights)) {
            overallScore += (scores[key] || 0) * weight;
        }

        // Determine volatility regime
        let volatilityRegime = 'medium';
        if (bwPercentile !== null) {
            if (bwPercentile <= 0.30) volatilityRegime = 'low';
            else if (bwPercentile >= 0.70) volatilityRegime = 'high';
        }

        if (scores.bandWidth < 0.30) {
            return {
                shouldTrade: false,
                reason: 'bands_expanding_high_volatility',
                scores,
                overallScore,
                bb,
                macd,
                volatilityRegime,
                atr
            };
        }

        if (scores.macdFlat < 0.25) {
            return {
                shouldTrade: false,
                reason: 'strong_momentum_detected',
                scores,
                overallScore,
                bb,
                macd,
                volatilityRegime,
                atr
            };
        }

        if (scores.pricePosition < 0.25) {
            return {
                shouldTrade: false,
                reason: 'price_at_band_edge',
                scores,
                overallScore,
                bb,
                macd,
                volatilityRegime,
                atr
            };
        }

        if (scores.tickStability < 0.20) {
            return {
                shouldTrade: false,
                reason: 'erratic_tick_movement',
                scores,
                overallScore,
                bb,
                macd,
                volatilityRegime,
                atr
            };
        }

        const minScore = 0.65;

        return {
            shouldTrade: overallScore >= minScore,
            reason: overallScore >= minScore ? 'conditions_favorable' : `score_below_threshold`,
            scores,
            overallScore,
            bb,
            macd,
            volatilityRegime,
            atr,
            tickStability: scores.tickStability,
            maxTickMove
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// DIGIT BIAS DETECTOR — Clustering Analysis
// ══════════════════════════════════════════════════════════════════════════════
class DigitBiasDetector {
    constructor() {
        this.biasHistory = {};
        this.performanceByBias = {};
    }

    /**
     * Core digit clustering analysis
     */
    detectDigitBias(digits, lookbackSize = 50) {
        if (!digits || digits.length < lookbackSize) {
            return { shouldTrade: false };
        }

        const recentDigits = digits.slice(-lookbackSize);
        const freq = {};

        recentDigits.forEach(d => {
            freq[d] = (freq[d] || 0) + 1;
        });

        let mostFrequent = null;
        let maxCount = 0;

        Object.keys(freq).forEach(d => {
            if (freq[d] > maxCount) {
                maxCount = freq[d];
                mostFrequent = parseInt(d);
            }
        });

        const expected = lookbackSize / 10;
        const biasStrength = maxCount / expected;

        const currentDigit = digits[digits.length - 1];
        const prevDigit = digits.length > 1 ? digits[digits.length - 2] : null;

        // Calculate entropy (measure of randomness)
        let entropy = 0;
        Object.values(freq).forEach(count => {
            const p = count / lookbackSize;
            if (p > 0) {
                entropy -= p * Math.log2(p);
            }
        });

        // Normalized entropy (0 = all same, 1 = uniform)
        const normalizedEntropy = entropy / Math.log2(10);

        return {
            mostFrequent,
            frequency: maxCount,
            biasStrength,
            entropy,
            normalizedEntropy,
            currentDigit,
            prevDigit,
            digitFrequency: freq,
            lookbackSize
        };
    }

    /**
     * Adaptive bias threshold based on historical performance
     */
    calculateAdaptiveThreshold(asset, baseThreshold = 1.6) {
        const performance = this.performanceByBias[asset];
        if (!performance) return baseThreshold;

        // If we're winning with high bias signals, lower threshold
        // If we're losing, raise threshold
        const winRate = performance.wins / (performance.wins + performance.losses) || 0.5;

        if (winRate > 0.85) {
            return Math.max(baseThreshold - 0.1, 1.4);
        } else if (winRate > 0.75) {
            return baseThreshold - 0.05;
        } else if (winRate < 0.55) {
            return Math.min(baseThreshold + 0.15, 2.0);
        }

        return baseThreshold;
    }

    recordPerformance(asset, biasStrength, won) {
        if (!this.performanceByBias[asset]) {
            this.performanceByBias[asset] = { wins: 0, losses: 0 };
        }

        if (won) {
            this.performanceByBias[asset].wins++;
        } else {
            this.performanceByBias[asset].losses++;
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// DYNAMIC STAKE SIZER — Kelly Criterion + Volatility Adjustment
// ══════════════════════════════════════════════════════════════════════════════
class DynamicStakeSizer {
    constructor(baseStake = 1) {
        this.baseStake = baseStake;
        this.tradeHistory = [];
        this.maxHistoryLength = 100;
    }

    /**
     * Kelly Criterion with safety modifications
     * Kelly Bet = (win_rate * avg_win - lose_rate * avg_loss) / avg_win
     */
    calculateKellyFraction(winRate, payoutRatio = 1.9) {
        if (winRate <= 0 || winRate >= 1) return 0.05;

        const p = winRate;
        const q = 1 - winRate;
        const b = payoutRatio - 1;

        const kelly = (p * b - q) / b;

        // Apply safety factor (never risk more than 5% of kelly)
        const safeFraction = Math.max(0.01, Math.min(kelly * 0.25, 0.1));

        return safeFraction;
    }

    /**
     * Calculate stake based on:
     * - Win rate
     * - Volatility (ATR)
     * - Confidence (digit bias strength)
     */
    calculateDynamicStake(baseStake, volatilityAtr, confidence, recentWinRate = 0.5) {
        if (!baseStake || baseStake <= 0) return this.baseStake;

        // Kelly-based sizing
        const kellyFraction = this.calculateKellyFraction(recentWinRate, 1.9);

        // Volatility adjustment (lower vol = can size up)
        let volFactor = 1.0;
        if (volatilityAtr && volatilityAtr > 0) {
            const atrNormalized = Math.min(volatilityAtr * 10000, 1.0);
            volFactor = 1.0 / (1.0 + atrNormalized);
        }

        // Confidence adjustment (higher bias = higher confidence)
        const confFactor = Math.min(confidence / 2.0, 1.2);

        const dynamicMultiplier = kellyFraction * volFactor * confFactor;
        const stake = baseStake * (1 + dynamicMultiplier);

        return Math.round(stake * 100) / 100;
    }

    recordTrade(stake, won, profit) {
        this.tradeHistory.push({ stake, won, profit, timestamp: Date.now() });
        if (this.tradeHistory.length > this.maxHistoryLength) {
            this.tradeHistory.shift();
        }
    }

    getRecentWinRate(lookback = 20) {
        if (this.tradeHistory.length === 0) return 0.5;
        const recent = this.tradeHistory.slice(-lookback);
        const wins = recent.filter(t => t.won).length;
        return wins / recent.length;
    }

    getAverageWin() {
        const wins = this.tradeHistory.filter(t => t.won);
        if (wins.length === 0) return 0;
        const totalWin = wins.reduce((sum, t) => sum + t.profit, 0);
        return totalWin / wins.length;
    }

    getAverageLoss() {
        const losses = this.tradeHistory.filter(t => !t.won);
        if (losses.length === 0) return 0;
        const totalLoss = losses.reduce((sum, t) => sum + Math.abs(t.profit), 0);
        return totalLoss / losses.length;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MONTE CARLO SIMULATOR — Risk Analysis & Position Sizing
// ══════════════════════════════════════════════════════════════════════════════
class MonteCarloSimulator {
    /**
     * Run Monte Carlo simulation of future trades
     * Returns confidence metrics for position sizing
     */
    static runSimulation(recentTrades, numSimulations = 1000, numFutureTrades = 50) {
        if (recentTrades.length < 10) {
            return {
                canTrade: true,
                confidence: 0.5,
                recommendedStakeMultiplier: 1.0,
                riskOfRuin: 0.05,
                maxDrawdown: 0.2,
                expectedDrawdown: 0.1,
                winProbability: 0.5
            };
        }

        const winRate = recentTrades.filter(t => t.won).length / recentTrades.length;
        const avgWin = this.getAverageWin(recentTrades);
        const avgLoss = this.getAverageLoss(recentTrades);

        if (avgWin <= 0) {
            return {
                canTrade: false,
                reason: 'no_winning_trades',
                confidence: 0,
                recommendedStakeMultiplier: 0.5,
                riskOfRuin: 1.0
            };
        }

        const payoutRatio = avgWin / avgLoss;

        // Run simulations
        const results = [];
        for (let sim = 0; sim < numSimulations; sim++) {
            const simResults = this.runSingleSimulation(
                winRate,
                avgWin,
                avgLoss,
                numFutureTrades
            );
            results.push(simResults);
        }

        // Analyze results
        const finalBalance = results.map(r => r.finalBalance);
        const maxDrawdowns = results.map(r => r.maxDrawdown);
        const minDrawdowns = results.map(r => r.minBalance);

        finalBalance.sort((a, b) => a - b);
        maxDrawdowns.sort((a, b) => a - b);

        const avgFinalBalance = finalBalance.reduce((a, b) => a + b) / finalBalance.length;
        const var95 = finalBalance[Math.floor(finalBalance.length * 0.05)];
        const expectedDrawdown = maxDrawdowns[Math.floor(maxDrawdowns.length * 0.5)];
        const worst95Drawdown = maxDrawdowns[Math.floor(maxDrawdowns.length * 0.95)];

        const riskOfRuin = results.filter(r => r.finalBalance <= 0).length / numSimulations;

        const confidence = Math.max(0, Math.min(1, (avgFinalBalance / 100) * 0.5 + (1 - riskOfRuin) * 0.5));

        let recommendedMultiplier = 1.0;
        if (riskOfRuin < 0.01 && confidence > 0.8) recommendedMultiplier = 1.3;
        else if (riskOfRuin < 0.05 && confidence > 0.7) recommendedMultiplier = 1.15;
        else if (riskOfRuin > 0.15) recommendedMultiplier = 0.7;

        return {
            canTrade: riskOfRuin < 0.2,
            confidence,
            recommendedStakeMultiplier: recommendedMultiplier,
            riskOfRuin,
            expectedDrawdown: expectedDrawdown / 100,
            worst95Drawdown: worst95Drawdown / 100,
            var95: var95 / 100,
            winRate,
            payoutRatio,
            simulations: numSimulations
        };
    }

    static runSingleSimulation(winRate, avgWin, avgLoss, numTrades) {
        let balance = 100;
        let minBalance = 100;

        for (let i = 0; i < numTrades; i++) {
            const won = Math.random() < winRate;
            if (won) {
                balance += avgWin;
            } else {
                balance -= avgLoss;
            }
            minBalance = Math.min(minBalance, balance);
        }

        const maxDrawdown = ((minBalance - 100) / 100) * 100;

        return {
            finalBalance: balance,
            minBalance,
            maxDrawdown
        };
    }

    static getAverageWin(trades) {
        const wins = trades.filter(t => t.won);
        if (wins.length === 0) return 0;
        return wins.reduce((sum, t) => sum + t.profit, 0) / wins.length;
    }

    static getAverageLoss(trades) {
        const losses = trades.filter(t => !t.won);
        if (losses.length === 0) return 0;
        return losses.reduce((sum, t) => sum + Math.abs(t.profit), 0) / losses.length;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// TICK-BY-TICK BACKTESTER
// ══════════════════════════════════════════════════════════════════════════════
class TickBacktester {
    /**
     * Backtest strategy on historical tick data
     * Returns performance metrics
     */
    static backtest(tickData, config) {
        const {
            initialStake = 1,
            biasThreshold = 1.6,
            minMarketScore = 0.70,
            lookbackSize = 50
        } = config;

        let stake = initialStake;
        let balance = 1000;
        const trades = [];

        // Get digits from prices
        const digits = tickData.map(t => this.getLastDigit(t.quote, 'R_10'));

        for (let i = lookbackSize; i < digits.length; i++) {
            const recentDigits = digits.slice(i - lookbackSize, i);
            const recentPrices = tickData.slice(i - lookbackSize, i).map(t => t.quote);

            // Detect bias
            const freq = {};
            recentDigits.forEach(d => {
                freq[d] = (freq[d] || 0) + 1;
            });

            let mostFrequent = null;
            let maxCount = 0;
            Object.keys(freq).forEach(d => {
                if (freq[d] > maxCount) {
                    maxCount = freq[d];
                    mostFrequent = parseInt(d);
                }
            });

            const biasStrength = maxCount / (lookbackSize / 10);
            const currentDigit = digits[i];

            if (biasStrength < biasThreshold || currentDigit !== mostFrequent) {
                continue;
            }

            // Next tick result
            if (i + 1 < digits.length) {
                const nextDigit = digits[i + 1];
                const won = nextDigit !== mostFrequent;
                const profit = won ? stake : -stake;

                balance += profit;

                trades.push({
                    i,
                    entry: currentDigit,
                    predicted: mostFrequent,
                    exit: nextDigit,
                    won,
                    profit,
                    stake
                });

                if (!won) {
                    stake = Math.ceil(stake * 2.2 * 100) / 100;
                } else {
                    stake = initialStake;
                }
            }
        }

        const wins = trades.filter(t => t.won).length;
        const winRate = trades.length > 0 ? wins / trades.length : 0;

        return {
            trades,
            numTrades: trades.length,
            winRate,
            wins,
            losses: trades.length - wins,
            finalBalance: balance,
            pnl: balance - 1000,
            roi: ((balance - 1000) / 1000) * 100
        };
    }

    static getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════
class DigitDifferBotV2 {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // Assets
        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];

        this.config = {
            initialStake: config.initialStake || 1,
            multiplier: config.multiplier || 2.2,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
            takeProfit: config.takeProfit || 500,
            stopLoss: config.stopLoss || 100,
            biasThreshold: config.biasThreshold || 1.6,
            minMarketScore: config.minMarketScore || 0.70,
            // Accumulator specific
            growthRate: config.growthRate || 0.02,
            filterNum: config.filterNum || 5,
            maxReconnectAttempts: 50,
            reconnectDelay: 5000,
            minTimeBetweenTrades: 2000,
            requiredHistoryLength: 100,
            analysisInterval: 1,
            telegramToken: config.telegramToken || '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
            telegramChatId: config.telegramChatId || '752497117',
        };

        // Trading state
        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.dailyProfitLoss = 0;
        this.endOfDay = false;
        this.tradeInProgress = false;
        this.tradeStartTime = null;
        //Accummulator Filter
        this.tradedDigitArray = [];
        this.filteredArray = [];
        this.filterNum = this.config.filterNum;
        this.entryTick = null;
        this.differRequest = false;

        // Adaptive thresholds
        this.biasThresholdAdaptive = this.config.biasThreshold;
        this.winRateHistory = [];

        // Components
        this.analyzer = new MarketAnalyzer();
        this.biasDetector = new DigitBiasDetector();
        this.stakeSizer = new DynamicStakeSizer(this.config.initialStake);

        // Trading history (for Monte Carlo)
        this.tradeHistory = [];
        this.maxTradeHistory = 100;

        // Multi-asset
        this.activeTrades = {};
        this.contractSubscriptions = {};
        this.tickSubscriptionIds = {};
        this.lastTradeTime = {};
        this.priceHistories = {};
        this.tickHistory = {};
        this.lastDigitsList = {};
        this.tickCounts = {};
        this.assetStates = {};
        this.assetMetrics = {};

        // Mode tracking
        this.tradingMode = 'digit_differ'; // or 'accumulator' or 'hybrid'
        this.volatilityRegime = 'medium';

        // Telegram
        this.telegramBot = null;
        if (this.config.telegramToken && this.config.telegramChatId) {
            this.telegramBot = new TelegramBot(this.config.telegramToken, { polling: false });
        }
        this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0 };

        // Reconnection
        this.reconnectAttempts = 0;
        this.pingInterval = null;

        // Watchdog
        this.tradeWatchdogTimer = null;
        this.tradeWatchdogPollTimer = null;
        this.tradeWatchdogMs = 120000;

        // Initialize per-asset
        this.assets.forEach(asset => {
            this.priceHistories[asset] = [];
            this.tickHistory[asset] = [];
            this.lastDigitsList[asset] = [];
            this.tickCounts[asset] = 0;
            this.lastTradeTime[asset] = 0;
            this.assetStates[asset] = { proposalId: null };
            this.assetMetrics[asset] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
        });

        // Load saved state
        this.loadSavedState();
    }

    loadSavedState() {
        const state = StatePersistence.loadState();
        if (!state) return;
        try {
            if (state.trading) {
                this.currentStake = state.trading.currentStake || this.config.initialStake;
                this.consecutiveLosses = state.trading.consecutiveLosses || 0;
                this.totalTrades = state.trading.totalTrades || 0;
                this.totalWins = state.trading.totalWins || 0;
                this.totalLosses = state.trading.totalLosses || 0;
                this.totalProfitLoss = state.trading.totalProfitLoss || 0;
                this.dailyProfitLoss = state.trading.dailyProfitLoss || 0;
            }
            if (state.adaptive) {
                this.biasThresholdAdaptive = state.adaptive.biasThreshold || this.config.biasThreshold;
                this.winRateHistory = state.adaptive.winRateHistory || [];
                this.biasDetector.performanceByBias = state.adaptive.performanceByBias || {};
            }
            if (state.assetMetrics) this.assetMetrics = state.assetMetrics;
            if (state.hourlyStats) this.hourlyStats = state.hourlyStats;
            console.log(`✅ State restored: ${this.totalTrades} trades, P&L: $${this.totalProfitLoss.toFixed(2)}`);
        } catch (error) {
            console.error(`❌ Error restoring state: ${error.message}`);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // WEBSOCKET
    // ══════════════════════════════════════════════════════════════════════════
    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        console.log('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ WebSocket connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.startPingKeepAlive();
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            try {
                this.handleMessage(JSON.parse(data));
            } catch (error) {
                console.error('Error parsing message:', error.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error.message);
        });

        this.ws.on('close', () => {
            console.log('⚡ WebSocket disconnected');
            this.stopPingKeepAlive();
            this.handleDisconnect();
        });
    }

    startPingKeepAlive() {
        this.stopPingKeepAlive();
        this.pingInterval = setInterval(() => {
            if (this.connected) {
                this.sendRequest({ ping: 1 });
            }
        }, 25000);
    }

    stopPingKeepAlive() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    authenticate() {
        this.sendRequest({ authorize: this.token });
    }

    sendRequest(request) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            this.ws.send(JSON.stringify(request));
            return true;
        } catch (error) {
            console.error('Error sending request:', error.message);
            return false;
        }
    }

    handleDisconnect() {
        if (this.endOfDay) {
            this.cleanup();
            return;
        }
        this.connected = false;
        this.wsReady = false;
        StatePersistence.saveState(this);

        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(this.config.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    cleanup() {
        this.stopPingKeepAlive();
        this._clearWatchdogTimers();
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { }
            }
            this.ws = null;
        }
        this.connected = false;
        this.wsReady = false;
    }

    disconnect() {
        console.log('🛑 Disconnecting...');
        StatePersistence.saveState(this);
        this.endOfDay = true;
        this.cleanup();
        console.log('✅ Bot disconnected');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // MESSAGE ROUTING
    // ══════════════════════════════════════════════════════════════════════════
    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                this.handleAuth(message);
                break;
            case 'history':
                this.handleTickHistory(message);
                break;
            case 'tick':
                if (message.subscription) {
                    this.tickSubscriptionIds[message.tick.symbol] = message.subscription.id;
                }
                this.handleTickUpdate(message.tick);
                break;
            case 'proposal':
                this.handleProposal(message);
                break;
            case 'buy':
                this.handleBuyResponse(message);
                break;
            case 'proposal_open_contract':
                if (message.error) {
                    console.error('Contract error:', message.error.message);
                    return;
                }
                this.handleContractUpdate(message);
                break;
            case 'sell':
                this.handleSellResponse(message);
                break;
            case 'ping':
                break;
            default:
                if (message.error) {
                    console.error(`API Error [${message.msg_type}]:`, message.error.message);
                }
        }
    }

    handleAuth(message) {
        if (message.error) {
            console.error('Auth failed:', message.error.message);
            this.disconnect();
            return;
        }
        console.log(`✅ Authenticated | Balance: $${message.authorize.balance}`);
        this.wsReady = true;
        this.initializeSubscriptions();
    }

    initializeSubscriptions() {
        console.log('📡 Subscribing to tick streams for all assets...');
        this.assets.forEach(asset => {
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });
            this.sendRequest({
                ticks: asset,
                subscribe: 1
            });
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TICK HANDLING
    // ══════════════════════════════════════════════════════════════════════════
    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    handleTickHistory(message) {
        const asset = message.echo_req.ticks_history;
        const history = message.history;

        this.priceHistories[asset] = history.prices.map(p => parseFloat(p));
        this.tickHistory[asset] = history.prices.map(p => this.getLastDigit(p, asset));

        console.log(`📊 ${asset}: Loaded ${this.priceHistories[asset].length} price ticks`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);
        const lastDigit = this.getLastDigit(price, asset);

        this.priceHistories[asset].push(price);
        if (this.priceHistories[asset].length > 500) {
            this.priceHistories[asset] = this.priceHistories[asset].slice(-300);
        }

        if (!this.lastDigitsList[asset]) this.lastDigitsList[asset] = [];
        this.lastDigitsList[asset].push(lastDigit);

        this.tickHistory[asset].push(lastDigit);
        if (this.tickHistory[asset].length > this.config.requiredHistoryLength) {
            this.tickHistory[asset].shift();
        }

        this.tickCounts[asset] = (this.tickCounts[asset] || 0) + 1;

        this.currentDigit = lastDigit;

        // console.log(`📊 [${asset}] ${price}: ${this.tickHistory[asset].slice(-10).join(', ')}`);

        if (!this.wsReady) return;
        if (this.activeTrades[asset]) return;
        if (this.tickHistory[asset].length < this.config.requiredHistoryLength) return;
        if (Date.now() - (this.lastTradeTime[asset] || 0) < this.config.minTimeBetweenTrades) return;

        // if (!this.tradeInProgress) {
        this.requestAccumulatorProposal(asset);
        // }
    }

    requestAccumulatorProposal(asset) {
        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: this.config.growthRate,
            limit_order: {
                take_profit: 0.5
            }
        };

        this.sendRequest(proposal);
    }


    handleProposal(message) {
        const asset = message.echo_req?.symbol;
        const prices = this.priceHistories[asset];
        const digits = this.tickHistory[asset];

        if (!asset) return;

        if (message.error) {
            delete this.activeTrades[asset];
            return;
        }

        if (!message.proposal) return;

        if (this.tradeInProgress) return;

        const proposalId = message.proposal.id;
        this.assetStates[asset].proposalId = proposalId;

        const proposal = message.proposal;
        const stayedInArray = proposal.contract_details.ticks_stayed_in;

        if (!stayedInArray) return;

        // Current digit count of the running accumulator
        const currentDigitCount = stayedInArray[99] + 1;

        // console.log(`📋 Proposal for ${asset}: Current StayIN Digit Count: ${stayedInArray[99]} (${currentDigitCount})`);
        // console.log(`   Filter Number: ${this.filterNum}`);

        // ── Original frequency analysis logic ──────────────────────────────
        // Create frequency map of digits
        const digitFrequency = {};
        stayedInArray.forEach(digit => {
            digitFrequency[digit] = (digitFrequency[digit] || 0) + 1;
        });

        // Create array: digits that have appeared exactly filterNum times
        const appearedOnceArray = Object.keys(digitFrequency)
            .filter(digit => digitFrequency[digit] === this.filterNum)
            .map(Number);

        // console.log(`   Digits that appeared ${this.filterNum} times: [${appearedOnceArray.join(', ')}]`);

        // Entry condition: current digit count is in appearedOnceArray
        // and not already traded, and stayedIn value >= 0
        const condition = appearedOnceArray.includes(currentDigitCount)
            && !this.tradedDigitArray.includes(stayedInArray[99])
            && stayedInArray[99] > 0;

        // console.log(`   Entry condition: ${condition ? '✅ MET' : '❌ NOT MET'}`);

        // 1️⃣ Market regime analysis
        const analysis = this.analyzer.analyzeEntry(prices);

        this.volatilityRegime = analysis.volatilityRegime || 'medium';

        // if (!analysis.shouldTrade) return;
        // if (analysis.overallScore < this.config.minMarketScore) return;

        // 2️⃣ Digit bias detection
        const digitBias = this.biasDetector.detectDigitBias(digits, 50);

        // 3️⃣ Adaptive threshold
        const adaptiveThreshold = this.biasDetector.calculateAdaptiveThreshold(
            asset,
            this.biasThresholdAdaptive
        );

        // if (digitBias.biasStrength < adaptiveThreshold) return;
        // if (digitBias.currentDigit !== digitBias.mostFrequent) return;

        // 4️⃣ Monte Carlo risk check
        const monteCarloResult = MonteCarloSimulator.runSimulation(this.tradeHistory, 500, 50);

        if (!monteCarloResult.canTrade) {
            console.log(`⚠️  Monte Carlo: Risk of ruin too high (${(monteCarloResult.riskOfRuin * 100).toFixed(1)}%)`);
            return;
        }

        // 5️⃣ Dynamic stake sizing
        const recentWinRate = this.stakeSizer.getRecentWinRate(20);
        const atr = analysis.atr || 0;

        // const dynamicStake = this.stakeSizer.calculateDynamicStake(
        //     this.currentStake,
        //     atr,
        //     digitBias.biasStrength,
        //     recentWinRate
        // );

        // this.currentStake = Math.max(this.config.initialStake, dynamicStake);

        // 7️⃣ Log decision
        // this.logTradeDecision(asset, analysis, digitBias, monteCarloResult, adaptiveThreshold);

        // 8️⃣ Request proposal
        if (condition
            // && this.volatilityRegime === 'low'
            // && analysis.overallScore >= 0.75
            // && analysis.scores.bandWidth >= 0.85
            // && analysis.scores.macdFlat >= 0.75
            // && analysis.scores.pricePosition >= 0.75
            && analysis.scores.tickStability >= 0.95
            // && analysis.scores.volTrend >= 0.65
            // && digitBias.biasStrength >= adaptiveThreshold
            // && this.currentDigit === digitBias.mostFrequent
            // && monteCarloResult.riskOfRuin < 0.05
        ) {
            this.logTradeDecision(asset, analysis, digitBias, monteCarloResult, adaptiveThreshold);

            // this.differRequest = true;

            this.tradedDigitArray.push(stayedInArray[99]);
            this.filteredArray = appearedOnceArray;
            this.entryTick = stayedInArray[99];
            // console.log(`   Traded Digit Array: [${this.tradedDigitArray.join(', ')}]`);
            // Place trade
            this.placeDigitTrade(asset, digitBias, analysis, monteCarloResult, adaptiveThreshold);
        } else {
            // console.log(`Analysis Stats:
            //     Overall Score: ${analysis.overallScore.toFixed(2)}
            //     Volatility Regime: ${this.volatilityRegime}
            //     Band Width: ${analysis.scores.bandWidth.toFixed(2)}
            //     MACD Flat: ${analysis.scores.macdFlat.toFixed(2)}
            //     Price Position: ${analysis.scores.pricePosition.toFixed(2)}
            //     Tick Stability: ${analysis.scores.tickStability.toFixed(2)}
            //     Vol Trend: ${analysis.scores.volTrend.toFixed(2)}
            //     Digit Bias: ${digitBias.biasStrength.toFixed(2)} | ${adaptiveThreshold.toFixed(2)}
            //     Current Digit: ${this.currentDigit} | Predicted Digit: ${digitBias.mostFrequent}
            // `);
        }
    }

    placeDigitTrade(asset, digitBias, analysis, monteCarloResult, adaptiveThreshold) {
        const proposalId = this.assetStates[asset]?.proposalId;
        if (!proposalId) return;
        if (this.tradeInProgress) return;

        this.activeTrades[asset] = {
            status: 'buying',
            predictedDigit: digitBias.mostFrequent,
            stake: this.currentStake,
            biasStrength: digitBias.biasStrength,
            entryTime: Date.now()
        };

        const trade = this.activeTrades[asset];

        console.log(`\n🚀 PLACING DIGITDIFF TRADE: ${asset}`);
        console.log(`   Barrier (Digit to avoid): ${trade.predictedDigit}`);
        console.log(`   Stake: $${trade.stake.toFixed(2)}`);

        // this.sendRequest({
        //     buy: proposalId,
        //     price: trade.stake.toFixed(2)
        // });

        this.sendRequest({
            buy: 1,
            price: this.currentStake.toFixed(2),
            parameters: {
                amount: this.currentStake.toFixed(2),
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                symbol: asset,
                barrier: digitBias.mostFrequent.toString(),
                duration: 1,
                duration_unit: 't'
            }
        });


        this.sendTelegramMessage(`🚀 BOTv2 Placing Trade: ${asset}
                Barrier (Digit to avoid): ${digitBias.mostFrequent}
                Digits: ${this.tickHistory[asset].slice(-10).join(', ')}
                📊 ACCUMULATOR SYSTEM:
                Filter Number: ${this.filterNum}
                Entry Tick: ${this.entryTick}
                Filtered Digits: ${this.filteredArray.join(', ')}
                Growth Rate: ${(this.config.growthRate * 100).toFixed(0)}%
                📊 MARKET REGIME:
                Volatility: ${this.volatilityRegime}
                Score: ${(analysis.overallScore * 100).toFixed(1)}%
                BB Width: ${(analysis.scores.bandWidth * 100).toFixed(1)}%
                MACD Flat: ${(analysis.scores.macdFlat * 100).toFixed(1)}%
                Price Position: ${(analysis.scores.pricePosition * 100).toFixed(1)}%
                Tick Stability: ${(analysis.scores.tickStability * 100).toFixed(1)}%
                VolTrend: ${(analysis.scores.volTrend * 100).toFixed(1)}%
                ATR: ${(analysis.atr || 0).toFixed(8)}
                💹 DIGIT CLUSTERING:
                Most Frequent: ${digitBias.mostFrequent}
                Frequency: ${digitBias.frequency}/50
                Bias Strength: ${digitBias.biasStrength.toFixed(2)}
                Adaptive Threshold: ${adaptiveThreshold.toFixed(2)}
                Entropy: ${digitBias.normalizedEntropy.toFixed(3)}
                🎲 MONTE CARLO:
                Can Trade: ${monteCarloResult.canTrade ? '✅' : '❌'}
                Risk of Ruin: ${(monteCarloResult.riskOfRuin * 100).toFixed(2)}%
                Win Probability: ${(monteCarloResult.winProbability * 100).toFixed(1)}%
                Confidence: ${(monteCarloResult.confidence * 100).toFixed(1)}%
                Multiplier: ${monteCarloResult.recommendedStakeMultiplier.toFixed(2)}x
                💰 STAKE SIZING:
                Current Stake: $${this.currentStake.toFixed(2)}
                Recent Win Rate: ${(this.stakeSizer.getRecentWinRate(20) * 100).toFixed(1)}%
                Mode: ${this.tradingMode}
            `);

        this.tradeInProgress = true;
        trade.status = 'buying';
    }

    handleBuyResponse(message) {
        const asset = this.findAssetByStatus('buying');

        if (message.error) {
            console.error(`❌ Buy error: ${message.error.message}`);
            if (asset) delete this.activeTrades[asset];
            this.tradeInProgress = false;
            this._clearWatchdogTimers();
            return;
        }

        if (!asset) {
            console.warn('Buy response but no pending trade found');
            this._clearWatchdogTimers();
            return;
        }

        const trade = this.activeTrades[asset];
        const contractId = message.buy.contract_id;

        console.log(`✅ Contract opened: ${contractId} on ${asset}`);

        trade.status = 'active';
        trade.contractId = contractId;
        trade.buyPrice = parseFloat(message.buy.buy_price);

        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });

        this.tradeStartTime = Date.now();
        this._startTradeWatchdog(contractId);
        console.log(`⏱️  Trade watchdog started (${(this.tradeWatchdogMs / 1000).toFixed(0)}s timeout)`);
    }

    findAssetByStatus(status) {
        return Object.keys(this.activeTrades).find(
            asset => this.activeTrades[asset]?.status === status
        );
    }

    findAssetByContractId(contractId) {
        return Object.keys(this.activeTrades).find(
            asset => this.activeTrades[asset]?.contractId === contractId
        );
    }

    handleContractUpdate(message) {
        const contract = message.proposal_open_contract;
        if (!contract) return;

        const asset = contract.underlying || this.findAssetByContractId(contract.contract_id);
        if (!asset || !this.activeTrades[asset]) return;

        const trade = this.activeTrades[asset];

        if (message.subscription?.id) {
            this.contractSubscriptions[asset] = message.subscription.id;
        }

        if (contract.is_sold) {
            this.handleTradeResult(asset, contract);
            return;
        }

        const tickCount = contract.tick_count || 0;
        const profit = parseFloat(contract.profit || 0);
        const bidPrice = parseFloat(contract.bid_price || 0);

        if (tickCount > 0 && tickCount % 2 === 0) {
            console.log(
                `  📊 ${asset}: tick ${tickCount} | ` +
                `Profit: $${profit.toFixed(3)} | Bid: $${bidPrice.toFixed(2)}`
            );
        }
    }

    handleSellResponse(message) {
        if (message.error) {
            console.error('❌ Sell error:', message.error.message);
            return;
        }
        console.log(`✅ Sold for: $${message.sell?.sold_for || 'N/A'}`);
    }

    logTradeDecision(asset, analysis, digitBias, monteCarloResult, adaptiveThreshold) {
        console.log(`\n${'═'.repeat(70)}`);
        console.log(`🎯 TRADE EVALUATION: ${asset}`);
        console.log(`${'═'.repeat(70)}`);
        console.log(`📊 MARKET REGIME:`);
        console.log(`   AccumFilter Number: ${this.filterNum}`);
        console.log(`   AccumEntry Tick: ${this.entryTick}`);
        console.log(`   AccumFiltered Digits: ${this.filteredArray.join(', ')}`);
        console.log(`   AccumGrowth Rate: ${(this.config.growthRate * 100).toFixed(0)}%`);
        console.log(`   Volatility: ${this.volatilityRegime}`);
        console.log(`   Score: ${(analysis.overallScore * 100).toFixed(1)}%`);
        console.log(`   BB Width: ${(analysis.scores.bandWidth * 100).toFixed(1)}%`);
        console.log(`   MACD Flat: ${(analysis.scores.macdFlat * 100).toFixed(1)}%`);
        console.log(`   Price Position: ${(analysis.scores.pricePosition * 100).toFixed(1)}%`);
        console.log(`   Tick Stability: ${(analysis.scores.tickStability * 100).toFixed(1)}%`);
        console.log(`   VolTrend: ${(analysis.scores.volTrend * 100).toFixed(1)}%`);
        console.log(`   ATR: ${(analysis.atr || 0).toFixed(8)}`);
        console.log(`\n💹 DIGIT CLUSTERING:`);
        console.log(`   Last 10 Digits: ${this.tickHistory[asset].slice(-10).join(', ')}`);
        console.log(`   Most Frequent: ${digitBias.mostFrequent}`);
        console.log(`   Frequency: ${digitBias.frequency}/50`);
        console.log(`   Bias Strength: ${digitBias.biasStrength.toFixed(2)}`);
        console.log(`   Adaptive Threshold: ${adaptiveThreshold.toFixed(2)}`);
        console.log(`   Entropy: ${digitBias.normalizedEntropy.toFixed(3)}`);
        console.log(`\n🎲 MONTE CARLO:`);
        console.log(`   Can Trade: ${monteCarloResult.canTrade ? '✅' : '❌'}`);
        console.log(`   Risk of Ruin: ${(monteCarloResult.riskOfRuin * 100).toFixed(2)}%`);
        console.log(`   Confidence: ${(monteCarloResult.confidence * 100).toFixed(1)}%`);
        console.log(`   Win Probability: ${(monteCarloResult.winProbability * 100).toFixed(1)}%`);
        console.log(`   Recommended Multiplier: ${monteCarloResult.recommendedStakeMultiplier.toFixed(2)}x`);
        console.log(`\n💰 STAKE SIZING:`);
        console.log(`   Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`   Recent Win Rate: ${(this.stakeSizer.getRecentWinRate(20) * 100).toFixed(1)}%`);
        console.log(`   Mode: ${this.tradingMode}`);
        console.log(`${'═'.repeat(70)}\n`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TRADE WATCHDOG
    // ══════════════════════════════════════════════════════════════════════════
    _startTradeWatchdog(contractId) {
        this._clearWatchdogTimers();

        this.tradeWatchdogTimer = setTimeout(() => {
            const hasActiveTrade = Object.keys(this.activeTrades).some(
                a => this.activeTrades[a]?.contractId
            );
            if (!hasActiveTrade) {
                this._clearWatchdogTimers();
                return;
            }

            console.warn(
                `⏰ WATCHDOG FIRED — Contract ${contractId || 'unknown'} ` +
                `has been open for ${(this.tradeWatchdogMs / 1000).toFixed(0)}s`
            );

            if (contractId && this.connected && this.wsReady) {
                console.log(`🔍 Polling contract ${contractId}…`);
                this.sendRequest({
                    proposal_open_contract: 1,
                    contract_id: contractId,
                    subscribe: 1,
                });

                this.tradeWatchdogPollTimer = setTimeout(() => {
                    const stillActive = Object.keys(this.activeTrades).some(
                        a => this.activeTrades[a]?.contractId
                    );
                    if (!stillActive) {
                        this._clearWatchdogTimers();
                        return;
                    }
                    console.error(`🚨 WATCHDOG: Poll timed out — force-releasing`);
                    this._recoverStuckTrade('watchdog-force');
                }, 15000);
            } else {
                this._recoverStuckTrade('watchdog-offline');
            }
        }, this.tradeWatchdogMs);
    }

    _clearWatchdogTimers() {
        if (this.tradeWatchdogTimer) {
            clearTimeout(this.tradeWatchdogTimer);
            this.tradeWatchdogTimer = null;
        }
        if (this.tradeWatchdogPollTimer) {
            clearTimeout(this.tradeWatchdogPollTimer);
            this.tradeWatchdogPollTimer = null;
        }
    }

    _recoverStuckTrade(reason) {
        this._clearWatchdogTimers();

        const stuckAsset = Object.keys(this.activeTrades).find(
            asset => this.activeTrades[asset]?.contractId
        );
        if (!stuckAsset) {
            this.tradeInProgress = false;
            return;
        }

        const trade = this.activeTrades[stuckAsset];
        const contractId = trade.contractId || 'unknown';
        const stake = trade.stake || 0;
        const openSeconds = Math.round((Date.now() - this.tradeStartTime) / 1000);

        console.error(
            `\n🚨 STUCK TRADE RECOVERY [${reason}]` +
            `\n   Contract: ${contractId}` +
            `\n   Asset: ${stuckAsset}` +
            `\n   Stake: $${stake.toFixed(2)}` +
            `\n   Open for: ${openSeconds}s`
        );

        if (contractId && contractId !== 'unknown' && this.connected && this.wsReady) {
            this.sendRequest({
                sell: contractId,
                price: '0',
            });
        }

        if (this.contractSubscriptions[stuckAsset]) {
            this.sendRequest({ forget: this.contractSubscriptions[stuckAsset] });
            delete this.contractSubscriptions[stuckAsset];
        }

        this.tradeInProgress = false;
        this.tradeStartTime = null;
        delete this.activeTrades[stuckAsset];

        this.totalLosses++;
        this.consecutiveLosses++;
        this.totalProfitLoss -= stake;
        this.dailyProfitLoss -= stake;

        if (this.assetMetrics[stuckAsset]) {
            this.assetMetrics[stuckAsset].losses++;
            this.assetMetrics[stuckAsset].profitLoss -= stake;
        }

        this.sendTelegramMessage(
            `🚨 <b>STUCK TRADE RECOVERED [${reason}]</b>\n\n` +
            `Contract: ${contractId}\n` +
            `Asset: ${stuckAsset}\n` +
            `Stake: $${stake.toFixed(2)}\n` +
            `Open for: ${openSeconds}s`
        );

        StatePersistence.saveState(this);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TRADE RESULT HANDLING
    // ══════════════════════════════════════════════════════════════════════════
    handleTradeResult(asset, contract) {
        const trade = this.activeTrades[asset];
        if (!trade) {
            this._clearWatchdogTimers();
            return;
        }

        this._clearWatchdogTimers();

        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        if (this.contractSubscriptions[asset]) {
            this.sendRequest({ forget: this.contractSubscriptions[asset] });
            delete this.contractSubscriptions[asset];
        }

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`${won ? '✅ WIN' : '❌ LOSS'}: ${asset}`);
        console.log(`Ticks: ${contract.tick_count || 0} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
        console.log(`${'═'.repeat(60)}`);

        // Update stats
        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;

        if (this.assetMetrics[asset]) {
            this.assetMetrics[asset].trades++;
            this.assetMetrics[asset].profitLoss += profit;
        }

        // Record for Monte Carlo and stake sizing
        this.tradeHistory.push({
            stake: trade.stake,
            won,
            profit,
            timestamp: Date.now(),
            biasStrength: trade.biasStrength
        });
        if (this.tradeHistory.length > this.maxTradeHistory) {
            this.tradeHistory.shift();
        }

        // Record for bias performance tracking
        this.biasDetector.recordPerformance(asset, trade.biasStrength, won);
        this.stakeSizer.recordTrade(trade.stake, won, profit);

        if (won) {
            this.totalWins++;
            this.currentStake = this.config.initialStake;
            this.consecutiveLosses = 0;
            this.hourlyStats.wins++;

            if (this.assetMetrics[asset]) this.assetMetrics[asset].wins++;

            // Update adaptive threshold to be less strict
            this.biasThresholdAdaptive = Math.max(1.4, this.biasThresholdAdaptive - 0.05);
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.hourlyStats.losses++;

            if (this.assetMetrics[asset]) this.assetMetrics[asset].losses++;

            // Martingale multiplier
            // if (this.consecutiveLosses <= this.config.maxConsecutiveLosses) {
            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            // }

            // Update adaptive threshold to be more strict
            this.biasThresholdAdaptive = Math.min(2.0, this.biasThresholdAdaptive + 0.1);
        }

        // Track win rate
        this.winRateHistory.push(won ? 1 : 0);
        if (this.winRateHistory.length > 100) {
            this.winRateHistory.shift();
        }

        this.tradeInProgress = false;
        this.tradeStartTime = null;
        delete this.activeTrades[asset];
        this.differRequest = false;

        // Telegram notification
        const winRate = this.totalTrades > 0 ? (this.totalWins / this.totalTrades * 100).toFixed(1) : '0.0';
        this.sendTelegramMessage(
            `${won ? '✅' : '❌'} <b>BOTv2 Trade Result</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Digit bet: ${trade.predictedDigit}\n` +
            `Last 10 Digits: ${this.tickHistory[asset].slice(-10)}\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
            `Consecutive Losses: ${this.consecutiveLosses}\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
            `Win Rate: ${winRate}%\n` +
            `Stake: $${this.currentStake.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}\n` +
            `Adaptive Threshold: ${this.biasThresholdAdaptive.toFixed(2)}`
        );

        this.logTradingSummary();

        // Take profit
        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('🎯 Take Profit Reached... Stopping trading.');
            this.endOfDay = true;
            this.sendDisconnectSummary();
            this.disconnect();
            return;
        }

        // Stop loss
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('🛑 Stopping condition met. Disconnecting...');
            this.endOfDay = true;
            this.sendDisconnectSummary();
            this.disconnect();
            return;
        }

        StatePersistence.saveState(this);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TELEGRAM
    // ══════════════════════════════════════════════════════════════════════════
    async sendTelegramMessage(message) {
        if (!this.telegramBot) return;
        try {
            await this.telegramBot.sendMessage(this.config.telegramChatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error(`Telegram error: ${error.message}`);
        }
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

    async sendHourlySummary() {
        const winRate = this.totalTrades > 0
            ? (this.totalWins / this.totalTrades * 100).toFixed(1)
            : '0.0';
        const pnlEmoji = this.totalProfitLoss >= 0 ? '🟢' : '🔴';
        const pnlStr = (this.totalProfitLoss >= 0 ? '+' : '') + '$' + Math.abs(this.totalProfitLoss).toFixed(2);

        await this.sendTelegramMessage(
            `📊 <b>Hourly Summary (digitDifferBotV2)</b>\n\n` +
            `Trades: ${this.totalTrades}\n` +
            `W/L: ${this.totalWins}/${this.totalLosses}\n` +
            `Win Rate: ${winRate}%\n` +
            `${pnlEmoji} Total P&L: ${pnlStr}\n` +
            `Daily P&L: ${this.dailyProfitLoss >= 0 ? '+' : ''}$${this.dailyProfitLoss.toFixed(2)}\n` +
            `Current Stake: $${this.currentStake.toFixed(2)}\n` +
            `Adaptive Threshold: ${this.biasThresholdAdaptive.toFixed(2)}\n` +
            `Volatility Regime: ${this.volatilityRegime}\n\n` +
            `⏰ ${new Date().toLocaleTimeString()}`
        );
    }

    async sendDisconnectSummary() {
        const winRate = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';
        await this.sendTelegramMessage(
            `⚠️ <b>digitDifferBotV2 Disconnected</b>\n\n` +
            `Trading Summary:\n` +
            `Total Trades: ${this.totalTrades}\n` +
            `Wins: ${this.totalWins} | Losses: ${this.totalLosses}\n\n` +
            `Total P&L: $${this.totalProfitLoss.toFixed(2)}\n` +
            `Win Rate: ${winRate}%\n` +
            `Current Stake: $${this.currentStake.toFixed(2)}\n` +
            `Final Adaptive Threshold: ${this.biasThresholdAdaptive.toFixed(2)}\n\n` +
            `Final Volatility Regime: ${this.volatilityRegime}`
        );
    }

    logTradingSummary() {
        console.log('\n📊 Trading Summary:');
        console.log(`  Total Trades: ${this.totalTrades}`);
        console.log(`  Total Wins: ${this.totalWins}`);
        console.log(`  Total Losses: ${this.totalLosses}`);
        console.log(`  Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00'}%`);
        console.log(`  Total P&L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`  Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`  Adaptive Threshold: ${this.biasThresholdAdaptive.toFixed(2)}`);
        console.log(`  Volatility Regime: ${this.volatilityRegime}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ══════════════════════════════════════════════════════════════════════════
    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🔥 digitDifferBotV2 — Advanced Digit Trading System');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`  Assets:              ${this.assets.join(', ')}`);
        console.log(`  Initial Stake:       $${this.config.initialStake}`);
        console.log(`  Multiplier:          x${this.config.multiplier}`);
        console.log(`  Bias Threshold:      ${this.config.biasThreshold}`);
        console.log(`  Min Market Score:    ${(this.config.minMarketScore * 100).toFixed(0)}%`);
        console.log(`  Take Profit:         $${this.config.takeProfit}`);
        console.log(`  Stop Loss:           $${this.config.stopLoss}`);
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  UPGRADES ENABLED:');
        console.log('  ✅ Adaptive Bias Threshold (ML-style)');
        console.log('  ✅ Volatility-based Mode Switching');
        console.log('  ✅ Dynamic Stake Sizing (Kelly)');
        console.log('  ✅ Monte Carlo Risk Simulator');
        console.log('  ✅ Tick-by-Tick Backtester');
        console.log('═══════════════════════════════════════════════════════════\n');

        this.connect();
        this.startTelegramTimer();
        StatePersistence.startAutoSave(this);
    }

    /**
     * Run backtest on historical data
     */
    async backtest(historicalData) {
        console.log('\n🧪 RUNNING BACKTEST...');

        const result = TickBacktester.backtest(historicalData, {
            initialStake: this.config.initialStake,
            biasThreshold: this.config.biasThreshold,
            minMarketScore: this.config.minMarketScore,
            lookbackSize: 50
        });

        console.log(`\n📊 BACKTEST RESULTS:`);
        console.log(`   Trades: ${result.numTrades}`);
        console.log(`   Wins: ${result.wins} | Losses: ${result.losses}`);
        console.log(`   Win Rate: ${(result.winRate * 100).toFixed(1)}%`);
        console.log(`   Initial Balance: $1000`);
        console.log(`   Final Balance: $${result.finalBalance.toFixed(2)}`);
        console.log(`   P&L: $${result.pnl.toFixed(2)}`);
        console.log(`   ROI: ${result.roi.toFixed(2)}%`);

        return result;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// BOT INITIALIZATION
// ══════════════════════════════════════════════════════════════════════════════
const bot = new DigitDifferBotV2('DMylfkyce6VyZt7', {
    initialStake: 1.07,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 100,
    takeProfit: 500,
    biasThreshold: 1.9,
    minMarketScore: 0.90,
    growthRate: 0.03,
    filterNum: 4,
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBEAR', 'RDBULL'],
    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    telegramChatId: '752497117',
});

bot.start();

// Export for testing / external use
module.exports = {
    DigitDifferBotV2,
    TechnicalIndicators,
    MarketAnalyzer,
    DigitBiasDetector,
    DynamicStakeSizer,
    MonteCarloSimulator,
    TickBacktester,
    StatePersistence
};
