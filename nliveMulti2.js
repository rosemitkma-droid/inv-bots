/**
 * Deriv Accumulator Trading Bot v3.0
 * Complete Strategy Rewrite - Evidence-Based Approach
 * 
 * Core Strategy:
 * - Realized Volatility vs Barrier Width analysis
 * - Tick-level survival probability estimation  
 * - Conservative entry with verified edge
 * - Flat staking with controlled recovery
 * - Regime detection to avoid hostile markets
 */

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================
const STATE_FILE = path.join(__dirname, 'accubot-v3-state.json');
const PERFORMANCE_LOG = path.join(__dirname, 'accubot-v3-performance.jsonl');
const STATE_SAVE_INTERVAL = 5000;

// ============================================
// STATE PERSISTENCE
// ============================================
class StatePersistence {
    static saveState(bot) {
        try {
            const state = {
                savedAt: Date.now(),
                version: '3.0',
                config: bot.config,
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    sessionId: bot.sessionId,
                    dailyTradeCount: bot.dailyTradeCount,
                    dailyPnL: bot.dailyPnL,
                },
                analytics: bot.analyticsEngine.exportState(),
                riskManager: bot.riskManager.exportState(),
                assetData: {},
                hourlyStats: bot.hourlyStats,
            };

            bot.assets.forEach(asset => {
                state.assetData[asset] = {
                    priceHistory: (bot.priceHistories[asset] || []).slice(-500),
                    tickTimestamps: (bot.tickTimestamps[asset] || []).slice(-500),
                    stayedInHistory: bot.stayedInHistory[asset] || [],
                    tradeResults: (bot.tradeResults[asset] || []).slice(-200),
                    volatilityHistory: (bot.volatilityHistory[asset] || []).slice(-100),
                };
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
            return true;
        } catch (error) {
            console.error(`❌ State save failed: ${error.message}`);
            return false;
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) return null;
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - data.savedAt) / 60000;
            if (ageMinutes > 60) {
                console.warn(`⚠️ State is ${ageMinutes.toFixed(0)}min old, backing up and starting fresh`);
                const backup = STATE_FILE.replace('.json', `_backup_${Date.now()}.json`);
                fs.renameSync(STATE_FILE, backup);
                return null;
            }
            console.log(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);
            return data;
        } catch (error) {
            console.error(`❌ State load failed: ${error.message}`);
            return null;
        }
    }

    static startAutoSave(bot) {
        if (bot._autoSaveInterval) clearInterval(bot._autoSaveInterval);
        bot._autoSaveInterval = setInterval(() => {
            if (bot.connected) StatePersistence.saveState(bot);
        }, STATE_SAVE_INTERVAL);

        const exitHandler = () => {
            console.log('\n🛑 Saving final state...');
            StatePersistence.saveState(bot);
            process.exit();
        };
        process.on('SIGINT', exitHandler);
        process.on('SIGTERM', exitHandler);
        process.on('uncaughtException', (err) => {
            console.error('Uncaught:', err);
            StatePersistence.saveState(bot);
            process.exit(1);
        });
    }

    static stopAutoSave(bot) {
        if (bot._autoSaveInterval) {
            clearInterval(bot._autoSaveInterval);
            bot._autoSaveInterval = null;
        }
    }

    static appendPerformanceLog(entry) {
        try {
            fs.appendFileSync(PERFORMANCE_LOG, JSON.stringify({
                ...entry,
                timestamp: Date.now(),
                time: new Date().toISOString()
            }) + '\n');
        } catch (e) { /* non-critical */ }
    }
}

// ============================================
// ANALYTICS ENGINE
// Replaces the unreliable Statistical/Pattern/Neural engines
// Focus: Measure what actually matters for accumulator survival
// ============================================
class AnalyticsEngine {
    constructor() {
        // Per-asset volatility tracking
        this.volatilityWindows = {};
        // Per-asset survival statistics  
        this.survivalStats = {};
        // Per-asset regime detection
        this.regimeState = {};
        // Edge tracking - do we actually have an edge?
        this.edgeTracker = {};
        // Tick-level price data for volatility calculation
        this.tickData = {};
    }

    /**
     * Initialize tracking for an asset
     */
    initAsset(asset) {
        this.volatilityWindows[asset] = {
            shortWindow: [],  // Last 20 ticks
            medWindow: [],    // Last 50 ticks  
            longWindow: [],   // Last 200 ticks
        };
        this.survivalStats[asset] = {
            completedRuns: [],     // Array of completed run lengths
            runStartTimes: [],     // When each run started
            totalTicksObserved: 0,
            totalRunsObserved: 0,
        };
        this.regimeState[asset] = {
            currentRegime: 'unknown', // 'low_vol', 'normal', 'high_vol', 'trending', 'choppy'
            regimeConfidence: 0,
            regimeStartTime: Date.now(),
            lastUpdate: 0,
        };
        this.edgeTracker[asset] = {
            predictedSurvival: [],  // What we predicted
            actualSurvival: [],     // What actually happened
            edgeEstimate: 0,        // Running edge estimate
            sampleCount: 0,
            isEdgePositive: false,
        };
        this.tickData[asset] = {
            prices: [],
            timestamps: [],
            returns: [],           // Log returns between ticks
        };
    }

    /**
     * Process a new tick - this is the core data ingestion
     */
    processTick(asset, price, timestamp) {
        if (!this.tickData[asset]) this.initAsset(asset);

        const td = this.tickData[asset];
        td.prices.push(price);
        td.timestamps.push(timestamp);

        // Calculate log return
        if (td.prices.length >= 2) {
            const prev = td.prices[td.prices.length - 2];
            const logReturn = Math.log(price / prev);
            td.returns.push(logReturn);

            // Keep bounded
            if (td.returns.length > 500) td.returns.shift();
        }

        // Keep bounded
        if (td.prices.length > 500) {
            td.prices.shift();
            td.timestamps.shift();
        }

        // Update volatility windows
        this.updateVolatility(asset);

        // Update regime detection every 10 ticks
        if (td.prices.length % 10 === 0 && td.returns.length >= 50) {
            this.detectRegime(asset);
        }
    }

    /**
     * Calculate realized volatility over different windows
     * This is THE critical metric for accumulator trading
     * 
     * Barrier width = spot_price × growth_rate / 100
     * If realized vol per tick << barrier width, survival probability is high
     */
    updateVolatility(asset) {
        const returns = this.tickData[asset].returns;
        if (returns.length < 10) return;

        const vw = this.volatilityWindows[asset];

        // Standard deviation of returns over different windows
        vw.shortWindow = this.calcRealizedVol(returns, 20);
        vw.medWindow = this.calcRealizedVol(returns, 50);
        vw.longWindow = this.calcRealizedVol(returns, 200);
    }

    /**
     * Calculate realized volatility (standard deviation of log returns)
     */
    calcRealizedVol(returns, window) {
        const slice = returns.slice(-window);
        if (slice.length < Math.min(window, 10)) return null;

        const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
        const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
        return {
            volatility: Math.sqrt(variance),
            mean: mean,
            maxAbsReturn: Math.max(...slice.map(Math.abs)),
            count: slice.length,
            // What % of ticks had returns exceeding various thresholds
            exceedance: {
                p001: slice.filter(r => Math.abs(r) > 0.001).length / slice.length,
                p0005: slice.filter(r => Math.abs(r) > 0.0005).length / slice.length,
                p0002: slice.filter(r => Math.abs(r) > 0.0002).length / slice.length,
            }
        };
    }

    /**
     * Estimate per-tick survival probability based on volatility vs barrier
     * 
     * For accumulator: barrier = spot × growthRate
     * A tick "survives" if |price_change / spot| < growthRate
     * 
     * Under normal distribution assumption:
     * P(survive) = P(|Z| < barrier/sigma) = 2×Φ(barrier/sigma) - 1
     */
    estimateTickSurvival(asset, growthRate) {
        const vw = this.volatilityWindows[asset];
        if (!vw || !vw.shortWindow) return null;

        const results = {};

        // Calculate for each window
        ['shortWindow', 'medWindow', 'longWindow'].forEach(windowName => {
            const vol = vw[windowName];
            if (!vol || vol.volatility === 0) {
                results[windowName] = null;
                return;
            }

            // barrier in log-return terms ≈ growthRate (for small values)
            const barrier = growthRate;  // e.g., 0.01 for 1% growth rate
            const ratio = barrier / vol.volatility;

            // P(|Z| < ratio) using normal CDF approximation
            const survivalPerTick = this.normalCDF(ratio) - this.normalCDF(-ratio);

            // P(survive N ticks) = P(survive 1 tick)^N (independent assumption)
            // This is optimistic - autocorrelation can make it worse
            results[windowName] = {
                perTickSurvival: survivalPerTick,
                survive5: Math.pow(survivalPerTick, 5),
                survive10: Math.pow(survivalPerTick, 10),
                survive20: Math.pow(survivalPerTick, 20),
                barrierToVolRatio: ratio,
                volatility: vol.volatility,
            };
        });

        return results;
    }

    /**
     * Record a completed accumulator run (from stayedIn data)
     */
    recordCompletedRun(asset, runLength) {
        if (!this.survivalStats[asset]) this.initAsset(asset);

        const ss = this.survivalStats[asset];
        ss.completedRuns.push(runLength);
        ss.totalRunsObserved++;

        // Keep bounded
        if (ss.completedRuns.length > 500) ss.completedRuns.shift();
    }

    /**
     * Empirical survival function from observed run lengths
     * More reliable than parametric models with enough data
     */
    empiricalSurvival(asset, targetLength) {
        const runs = this.survivalStats[asset]?.completedRuns;
        if (!runs || runs.length < 30) return null;

        const total = runs.length;
        const survived = runs.filter(r => r >= targetLength).length;
        const probability = survived / total;

        // Wilson score confidence interval (better than normal approx for small p)
        const z = 1.96;
        const n = total;
        const p = probability;
        const denominator = 1 + z * z / n;
        const center = (p + z * z / (2 * n)) / denominator;
        const halfWidth = (z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / denominator;

        return {
            probability,
            ci_lower: Math.max(0, center - halfWidth),
            ci_upper: Math.min(1, center + halfWidth),
            sampleSize: total,
            survived,
        };
    }

    /**
     * Conditional survival: P(survive to T+1 | already survived to T)
     * This is what actually matters for deciding whether to enter NOW
     */
    conditionalSurvival(asset, currentLength) {
        const runs = this.survivalStats[asset]?.completedRuns;
        if (!runs || runs.length < 30) return null;

        // Count runs that reached currentLength
        const reachedCurrent = runs.filter(r => r >= currentLength).length;
        if (reachedCurrent < 10) return null; // Not enough data

        // Count runs that reached currentLength + 1
        const reachedNext = runs.filter(r => r >= currentLength + 1).length;

        const conditionalProb = reachedNext / reachedCurrent;

        return {
            probability: conditionalProb,
            hazardRate: 1 - conditionalProb,
            sampleSize: reachedCurrent,
        };
    }

    /**
     * Detect market regime using multiple indicators
     */
    detectRegime(asset) {
        const vw = this.volatilityWindows[asset];
        if (!vw || !vw.shortWindow || !vw.medWindow || !vw.longWindow) return;

        const shortVol = vw.shortWindow?.volatility;
        const medVol = vw.medWindow?.volatility;
        const longVol = vw.longWindow?.volatility;

        if (!shortVol || !medVol || !longVol) return;

        const returns = this.tickData[asset].returns;
        if (returns.length < 50) return;

        // Volatility ratio: short/long
        const volRatio = shortVol / longVol;

        // Autocorrelation at lag 1 (trending vs mean-reverting)
        const recentReturns = returns.slice(-50);
        const autocorr = this.autocorrelation(recentReturns, 1);

        // Determine regime
        let regime, confidence;

        if (volRatio > 1.5) {
            regime = 'high_vol';
            confidence = Math.min(1, (volRatio - 1) / 2);
        } else if (volRatio < 0.7) {
            regime = 'low_vol';
            confidence = Math.min(1, (1 - volRatio) / 0.5);
        } else if (autocorr > 0.15) {
            regime = 'trending';
            confidence = Math.min(1, autocorr / 0.3);
        } else if (autocorr < -0.15) {
            regime = 'mean_reverting';
            confidence = Math.min(1, Math.abs(autocorr) / 0.3);
        } else {
            regime = 'normal';
            confidence = 0.5;
        }

        this.regimeState[asset] = {
            currentRegime: regime,
            regimeConfidence: confidence,
            volRatio,
            autocorrelation: autocorr,
            shortVol,
            medVol,
            longVol,
            lastUpdate: Date.now(),
        };
    }

    /**
     * Get trade signal strength
     * Returns a score from -1 (strong no-trade) to +1 (strong trade)
     * 
     * Core logic:
     * - High barrier-to-vol ratio = favorable
     * - Low volatility regime = favorable  
     * - Positive edge from historical trades = favorable
     * - Recent short runs = unfavorable
     */
    getTradeSignal(asset, growthRate, currentRunLength) {
        const signals = [];
        const details = {};

        // Signal 1: Volatility-based survival estimate
        const survival = this.estimateTickSurvival(asset, growthRate);
        if (survival) {
            const windows = ['shortWindow', 'medWindow', 'longWindow'];
            const weights = [0.5, 0.3, 0.2]; // Weight recent vol more

            let weightedSurvival = 0;
            let totalWeight = 0;

            windows.forEach((w, i) => {
                if (survival[w]) {
                    // We need at least survive5 to be profitable at 1% growth
                    // (need ~5 ticks to cover the spread/commission)
                    const score = survival[w].survive5;
                    weightedSurvival += score * weights[i];
                    totalWeight += weights[i];
                }
            });

            if (totalWeight > 0) {
                const volScore = weightedSurvival / totalWeight;
                // Map to [-1, 1]: below 0.8 is bad, above 0.95 is good
                const mapped = (volScore - 0.85) / 0.15; // -1 at 0.7, 0 at 0.85, +1 at 1.0
                signals.push({ name: 'volatility', score: Math.max(-1, Math.min(1, mapped)), weight: 0.35 });
                details.volatility = {
                    score: volScore,
                    mapped,
                    shortSurvive5: survival.shortWindow?.survive5,
                    barrierRatio: survival.shortWindow?.barrierToVolRatio,
                };
            }
        }

        // Signal 2: Empirical conditional survival
        const condSurv = this.conditionalSurvival(asset, currentRunLength);
        if (condSurv && condSurv.sampleSize >= 20) {
            // Conditional hazard: if > 0.1, it means 10%+ chance of dying next tick
            const mapped = (condSurv.probability - 0.85) / 0.15;
            signals.push({ name: 'empirical', score: Math.max(-1, Math.min(1, mapped)), weight: 0.25 });
            details.empirical = {
                conditionalProb: condSurv.probability,
                hazardRate: condSurv.hazardRate,
                sampleSize: condSurv.sampleSize,
            };
        }

        // Signal 3: Regime favorability
        const regime = this.regimeState[asset];
        if (regime && regime.currentRegime !== 'unknown') {
            let regimeScore;
            switch (regime.currentRegime) {
                case 'low_vol': regimeScore = 0.8; break;
                case 'mean_reverting': regimeScore = 0.5; break;
                case 'normal': regimeScore = 0.2; break;
                case 'trending': regimeScore = -0.5; break;
                case 'high_vol': regimeScore = -1.0; break;
                default: regimeScore = 0;
            }
            regimeScore *= regime.regimeConfidence;
            signals.push({ name: 'regime', score: regimeScore, weight: 0.20 });
            details.regime = {
                regime: regime.currentRegime,
                confidence: regime.regimeConfidence,
                volRatio: regime.volRatio,
                autocorrelation: regime.autocorrelation,
            };
        }

        // Signal 4: Recent run length pattern
        const runs = this.survivalStats[asset]?.completedRuns;
        if (runs && runs.length >= 10) {
            const recent10 = runs.slice(-10);
            const avgRecentRun = recent10.reduce((a, b) => a + b, 0) / recent10.length;
            const shortRunCount = recent10.filter(r => r <= 2).length;

            // Too many short runs = dangerous
            let runPatternScore;
            if (shortRunCount >= 5) {
                runPatternScore = -0.8;
            } else if (shortRunCount >= 3) {
                runPatternScore = -0.3;
            } else if (avgRecentRun > 10) {
                runPatternScore = 0.5;
            } else {
                runPatternScore = 0.1;
            }

            signals.push({ name: 'runPattern', score: runPatternScore, weight: 0.10 });
            details.runPattern = {
                avgRecentRun,
                shortRunCount,
                recent10,
            };
        }

        // Signal 5: Edge tracker - are we actually profitable?
        const edge = this.edgeTracker[asset];
        if (edge && edge.sampleCount >= 10) {
            const edgeScore = edge.edgeEstimate > 0 ? 0.3 : -0.5;
            signals.push({ name: 'edge', score: edgeScore, weight: 0.10 });
            details.edge = {
                estimate: edge.edgeEstimate,
                sampleCount: edge.sampleCount,
                isPositive: edge.isEdgePositive,
            };
        }

        // Combine weighted signals
        if (signals.length === 0) {
            return { score: 0, shouldTrade: false, reason: 'insufficient_data', details };
        }

        let weightedSum = 0;
        let totalWeight = 0;
        signals.forEach(s => {
            weightedSum += s.score * s.weight;
            totalWeight += s.weight;
        });

        const finalScore = weightedSum / totalWeight;

        // Agreement: how many signals are positive?
        const positiveSignals = signals.filter(s => s.score > 0).length;
        const agreement = positiveSignals / signals.length;

        return {
            score: finalScore,
            shouldTrade: finalScore > 0.3 && agreement >= 0.6,
            positiveSignals,
            totalSignals: signals.length,
            agreement,
            signals: signals.map(s => ({ name: s.name, score: s.score.toFixed(3) })),
            details,
        };
    }

    /**
     * Record trade outcome for edge tracking
     */
    recordTradeOutcome(asset, won, profit, stake) {
        if (!this.edgeTracker[asset]) this.initAsset(asset);

        const et = this.edgeTracker[asset];
        const returnOnStake = profit / stake;

        et.sampleCount++;

        // Exponential moving average of return
        const alpha = Math.min(0.1, 2 / (et.sampleCount + 1));
        et.edgeEstimate = (1 - alpha) * et.edgeEstimate + alpha * returnOnStake;
        et.isEdgePositive = et.edgeEstimate > 0;
    }

    // ---- Utility functions ----

    normalCDF(x) {
        // Abramowitz and Stegun approximation
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const p = 0.3275911;

        const sign = x < 0 ? -1 : 1;
        x = Math.abs(x) / Math.sqrt(2);

        const t = 1.0 / (1.0 + p * x);
        const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

        return 0.5 * (1.0 + sign * y);
    }

    autocorrelation(data, lag) {
        if (data.length < lag + 10) return 0;
        const n = data.length;
        const mean = data.reduce((a, b) => a + b, 0) / n;
        let numerator = 0;
        let denominator = 0;

        for (let i = 0; i < n - lag; i++) {
            numerator += (data[i] - mean) * (data[i + lag] - mean);
        }
        for (let i = 0; i < n; i++) {
            denominator += (data[i] - mean) ** 2;
        }

        return denominator === 0 ? 0 : numerator / denominator;
    }

    exportState() {
        return {
            survivalStats: this.survivalStats,
            regimeState: this.regimeState,
            edgeTracker: this.edgeTracker,
            // Don't save tickData - too large and will be rebuilt
        };
    }

    importState(state) {
        if (state.survivalStats) this.survivalStats = state.survivalStats;
        if (state.regimeState) this.regimeState = state.regimeState;
        if (state.edgeTracker) this.edgeTracker = state.edgeTracker;
    }
}

// ============================================
// RISK MANAGER
// Replaces the broken martingale system
// ============================================
class RiskManager {
    constructor(config) {
        this.config = config;
        this.state = {
            consecutiveLosses: 0,
            maxConsecutiveLosses: 0,
            sessionPnL: 0,
            peakPnL: 0,
            drawdown: 0,
            maxDrawdown: 0,
            tradeCount: 0,
            lastTradeTime: 0,
            cooldownUntil: 0,
            assetCooldowns: {},     // Per-asset cooldown timers
            dailyLossCount: 0,
            dailyWinCount: 0,
        };
    }

    /**
     * Calculate stake for next trade
     * Uses a controlled recovery system instead of martingale
     * 
     * Strategy:
     * - Base stake after a win
     * - After 1 loss: 2x base (recover previous loss)
     * - After 2 losses: 3x base (recover two losses)
     * - After 3+ losses: STOP trading, cooldown
     * - Never exceed maxStake
     */
    calculateStake() {
        const base = this.config.initialStake;
        const maxStake = this.config.maxStake || base * 5;
        const losses = this.state.consecutiveLosses;

        if (losses === 0) return base;
        if (losses === 1) return Math.min(base * 2, maxStake);
        if (losses === 2) return Math.min(base * 3, maxStake);

        // After 3+ losses, we should be in cooldown but just in case:
        return base;
    }

    /**
     * Check if trading is allowed right now
     */
    canTrade(asset) {
        const now = Date.now();
        const reasons = [];

        // Global cooldown
        if (now < this.state.cooldownUntil) {
            const remaining = Math.ceil((this.state.cooldownUntil - now) / 1000);
            reasons.push(`Global cooldown: ${remaining}s remaining`);
        }

        // Per-asset cooldown
        const assetCooldown = this.state.assetCooldowns[asset];
        if (assetCooldown && now < assetCooldown) {
            const remaining = Math.ceil((assetCooldown - now) / 1000);
            reasons.push(`Asset cooldown: ${remaining}s remaining`);
        }

        // Max consecutive losses
        if (this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            reasons.push(`Max consecutive losses reached: ${this.state.consecutiveLosses}`);
        }

        // Daily stop loss
        if (this.state.sessionPnL <= -this.config.stopLoss) {
            reasons.push(`Daily stop loss hit: $${this.state.sessionPnL.toFixed(2)}`);
        }

        // Max drawdown
        if (this.state.drawdown >= this.config.maxDrawdownPercent) {
            reasons.push(`Max drawdown: ${(this.state.drawdown * 100).toFixed(1)}%`);
        }

        // Daily take profit
        if (this.state.sessionPnL >= this.config.takeProfit) {
            reasons.push(`Take profit reached: $${this.state.sessionPnL.toFixed(2)}`);
        }

        // Minimum time between trades (prevent rapid-fire)
        const timeSinceLastTrade = now - this.state.lastTradeTime;
        if (timeSinceLastTrade < this.config.minTimeBetweenTrades) {
            const remaining = Math.ceil((this.config.minTimeBetweenTrades - timeSinceLastTrade) / 1000);
            reasons.push(`Min time between trades: ${remaining}s remaining`);
        }

        return {
            allowed: reasons.length === 0,
            reasons,
        };
    }

    /**
     * Record a trade result and update risk state
     */
    recordResult(asset, won, profit, stake) {
        this.state.tradeCount++;
        this.state.lastTradeTime = Date.now();
        this.state.sessionPnL += profit;

        if (won) {
            this.state.consecutiveLosses = 0;
            this.state.dailyWinCount++;

            // Update peak P&L
            if (this.state.sessionPnL > this.state.peakPnL) {
                this.state.peakPnL = this.state.sessionPnL;
            }
        } else {
            this.state.consecutiveLosses++;
            this.state.dailyLossCount++;

            if (this.state.consecutiveLosses > this.state.maxConsecutiveLosses) {
                this.state.maxConsecutiveLosses = this.state.consecutiveLosses;
            }

            // Calculate drawdown from peak
            if (this.state.peakPnL > 0) {
                this.state.drawdown = (this.state.peakPnL - this.state.sessionPnL) / this.state.peakPnL;
                if (this.state.drawdown > this.state.maxDrawdown) {
                    this.state.maxDrawdown = this.state.drawdown;
                }
            }

            // Apply cooldowns after losses
            this.applyCooldown(asset);
        }
    }

    /**
     * Apply cooldown after a loss
     * Cooldown increases with consecutive losses
     */
    applyCooldown(asset) {
        const now = Date.now();
        const losses = this.state.consecutiveLosses;

        // Per-asset cooldown: longer after more losses
        const assetCooldownMs = Math.min(
            this.config.baseCooldownMs * Math.pow(2, losses - 1),
            this.config.maxCooldownMs
        );
        this.state.assetCooldowns[asset] = now + assetCooldownMs;

        // Global cooldown after 2+ consecutive losses
        if (losses >= 2) {
            const globalCooldownMs = Math.min(
                this.config.baseCooldownMs * Math.pow(2, losses),
                this.config.maxCooldownMs
            );
            this.state.cooldownUntil = now + globalCooldownMs;
        }

        // After 3+ losses, enforce long global cooldown
        if (losses >= this.config.maxConsecutiveLosses) {
            this.state.cooldownUntil = now + this.config.maxCooldownMs;
        }
    }

    exportState() {
        return { ...this.state };
    }

    importState(state) {
        if (state) {
            this.state = { ...this.state, ...state };
        }
    }

    resetDaily() {
        this.state.dailyLossCount = 0;
        this.state.dailyWinCount = 0;
        this.state.sessionPnL = 0;
        this.state.peakPnL = 0;
        this.state.drawdown = 0;
        this.state.consecutiveLosses = 0;
        this.state.cooldownUntil = 0;
        this.state.assetCooldowns = {};
    }
}

// ============================================
// MAIN TRADING BOT v3.0
// ============================================
class AccumulatorBotV3 {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.sessionId = `session_${Date.now()}`;

        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];

        this.config = {
            // Stake management
            initialStake: config.initialStake || 1,
            maxStake: config.maxStake || 5,

            // Growth rate - ALWAYS use lowest for highest survival probability
            growthRate: config.growthRate || 0.01,

            // Take profit per contract
            accuTakeProfit: config.accuTakeProfit || 0.01,

            // Risk management
            stopLoss: config.stopLoss || 50,
            takeProfit: config.takeProfit || 100,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            maxDrawdownPercent: config.maxDrawdownPercent || 0.3,

            // Timing
            baseCooldownMs: config.baseCooldownMs || 30000,      // 30s base cooldown
            maxCooldownMs: config.maxCooldownMs || 300000,       // 5min max cooldown
            minTimeBetweenTrades: config.minTimeBetweenTrades || 10000, // 10s min between trades

            // Data requirements
            requiredHistoryLength: config.requiredHistoryLength || 200,
            minRunsForSignal: config.minRunsForSignal || 30,

            // Signal thresholds
            minSignalScore: config.minSignalScore || 0.3,
            minAgreement: config.minAgreement || 0.6,

            // Connection
            maxReconnectAttempts: config.maxReconnectAttempts || 100,
            reconnectInterval: config.reconnectInterval || 5000,
        };

        // Core engines
        this.analyticsEngine = new AnalyticsEngine();
        this.riskManager = new RiskManager(this.config);

        // Trading state
        this.currentStake = this.config.initialStake;
        this.tradeInProgress = false;
        this.currentTradeId = null;
        this.currentTradeAsset = null;
        this.endOfDay = false;

        // Tracking
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.consecutiveLosses = 0;
        this.dailyTradeCount = 0;
        this.dailyPnL = 0;

        // Per-asset data
        this.priceHistories = {};
        this.tickTimestamps = {};
        this.tickSubscriptionIds = {};
        this.stayedInHistory = {};  // Historical completed run lengths
        this.tradeResults = {};
        this.volatilityHistory = {};
        this.assetStates = {};
        this.previousStayedIn = {};
        this.pendingProposals = new Map();

        // Initialize per-asset
        this.assets.forEach(asset => {
            this.priceHistories[asset] = [];
            this.tickTimestamps[asset] = [];
            this.stayedInHistory[asset] = [];
            this.tradeResults[asset] = [];
            this.volatilityHistory[asset] = [];
            this.assetStates[asset] = {
                currentProposalId: null,
                tradeInProgress: false,
                lastStayedIn: null,
                currentRunLength: 0,
                dataReady: false,
            };
            this.previousStayedIn[asset] = null;
            this.analyticsEngine.initAsset(asset);
        });

        // Telegram
        this.telegramToken = config.telegramToken || process.env.TELEGRAM_TOKEN;
        this.telegramChatId = config.telegramChatId || process.env.TELEGRAM_CHAT_ID;
        this.telegramEnabled = !!(this.telegramToken && this.telegramChatId);

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
        }

        // Stats
        this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };

        // Connection management
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.reconnectTimer = null;
        this.pingInterval = null;
        this.checkDataInterval = null;
        this.lastPongTime = Date.now();
        this.lastDataTime = Date.now();

        // Message queue
        this.messageQueue = [];

        // Load saved state
        this.loadSavedState();
    }

    // ========================================================================
    // STATE RESTORATION
    // ========================================================================
    loadSavedState() {
        const state = StatePersistence.loadState();
        if (!state) return;

        try {
            if (state.trading) {
                Object.assign(this, {
                    currentStake: state.trading.currentStake || this.config.initialStake,
                    consecutiveLosses: state.trading.consecutiveLosses || 0,
                    totalTrades: state.trading.totalTrades || 0,
                    totalWins: state.trading.totalWins || 0,
                    totalLosses: state.trading.totalLosses || 0,
                    totalProfitLoss: state.trading.totalProfitLoss || 0,
                    dailyTradeCount: state.trading.dailyTradeCount || 0,
                    dailyPnL: state.trading.dailyPnL || 0,
                });
            }

            if (state.analytics) {
                this.analyticsEngine.importState(state.analytics);
                console.log('  ✓ Analytics engine restored');
            }

            if (state.riskManager) {
                this.riskManager.importState(state.riskManager);
                console.log('  ✓ Risk manager restored');
            }

            if (state.assetData) {
                Object.keys(state.assetData).forEach(asset => {
                    const ad = state.assetData[asset];
                    if (ad.priceHistory) this.priceHistories[asset] = ad.priceHistory;
                    if (ad.tickTimestamps) this.tickTimestamps[asset] = ad.tickTimestamps;
                    if (ad.stayedInHistory) this.stayedInHistory[asset] = ad.stayedInHistory;
                    if (ad.tradeResults) this.tradeResults[asset] = ad.tradeResults;
                    if (ad.volatilityHistory) this.volatilityHistory[asset] = ad.volatilityHistory;
                });
                console.log('  ✓ Asset data restored');
            }

            if (state.hourlyStats) this.hourlyStats = state.hourlyStats;

            console.log(`✅ State restored: ${this.totalTrades} trades, P&L: $${this.totalProfitLoss.toFixed(2)}`);
        } catch (error) {
            console.error(`❌ State restore error: ${error.message}`);
        }
    }

    // ========================================================================
    // WEBSOCKET
    // ========================================================================
    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        console.log('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ WebSocket connected');
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
                this.handleMessage(JSON.parse(data));
            } catch (error) {
                console.error('Message parse error:', error.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error.message);
        });

        this.ws.on('close', (code, reason) => {
            console.log(`WebSocket closed (${code}: ${reason || 'none'})`);
            this.handleDisconnect();
        });

        this.ws.on('pong', () => {
            this.lastPongTime = Date.now();
        });
    }

    startMonitor() {
        this.stopMonitor();

        this.pingInterval = setInterval(() => {
            if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, 20000);

        this.checkDataInterval = setInterval(() => {
            if (!this.connected) return;
            if (Date.now() - this.lastDataTime > 60000) {
                console.error('⚠️ No data for 60s, forcing reconnect');
                StatePersistence.saveState(this);
                this.ws?.terminate();
            }
        }, 10000);
    }

    stopMonitor() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.checkDataInterval) clearInterval(this.checkDataInterval);
        this.pingInterval = null;
        this.checkDataInterval = null;
    }

    sendRequest(request) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            if (this.messageQueue.length < 50) this.messageQueue.push(request);
            return false;
        }
        try {
            this.ws.send(JSON.stringify(request));
            return true;
        } catch (error) {
            console.error('Send error:', error.message);
            return false;
        }
    }

    handleDisconnect() {
        if (this.endOfDay || this.isReconnecting) return;

        this.connected = false;
        this.wsReady = false;
        this.stopMonitor();
        StatePersistence.saveState(this);

        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            console.error('❌ Max reconnect attempts reached');
            this.sendTelegramMessage(`❌ Max reconnect attempts. P&L: $${this.totalProfitLoss.toFixed(2)}`);
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        const delay = Math.min(this.config.reconnectInterval * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})`);

        this.reconnectTimer = setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    cleanup() {
        this.stopMonitor();
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.ws) {
            this.ws.removeAllListeners();
            try { this.ws.close(); } catch (e) { }
            this.ws = null;
        }
        this.connected = false;
        this.wsReady = false;
    }

    authenticate() {
        this.sendRequest({ authorize: this.token });
    }

    // ========================================================================
    // MESSAGE HANDLING
    // ========================================================================
    handleMessage(message) {
        if (message.msg_type === 'ping') {
            this.sendRequest({ ping: 1 });
            return;
        }

        switch (message.msg_type) {
            case 'authorize':
                this.handleAuth(message);
                break;
            case 'history':
                this.handleTickHistory(message);
                break;
            case 'tick':
                this.handleTick(message);
                break;
            case 'proposal':
                this.handleProposal(message);
                break;
            case 'buy':
                this.handleBuy(message);
                break;
            case 'proposal_open_contract':
                this.handleContractUpdate(message);
                break;
            default:
                if (message.error) {
                    console.error(`API error [${message.msg_type}]: ${message.error.message}`);
                    if (message.error.code === 'InvalidToken') {
                        this.disconnect();
                    }
                }
        }
    }

    handleAuth(message) {
        if (message.error) {
            console.error('Auth failed:', message.error.message);
            this.disconnect();
            return;
        }
        console.log('✅ Authenticated');
        this.wsReady = true;
        this.tradeInProgress = false;

        // Process queued messages
        const queue = [...this.messageQueue];
        this.messageQueue = [];
        queue.forEach(m => this.sendRequest(m));

        // Subscribe to all assets
        this.assets.forEach(asset => {
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });
            this.sendRequest({ ticks: asset, subscribe: 1 });
        });
    }

    handleTickHistory(message) {
        const asset = message.echo_req.ticks_history;
        if (!asset) return;

        const prices = message.history.prices.map(Number);
        const times = message.history.times.map(Number);

        this.priceHistories[asset] = prices;
        this.tickTimestamps[asset] = times;

        // Feed to analytics engine
        prices.forEach((price, i) => {
            this.analyticsEngine.processTick(asset, price, times[i]);
        });

        console.log(`📊 [${asset}] Loaded ${prices.length} historical ticks`);
    }

    handleTick(message) {
        const tick = message.tick;
        if (!tick) return;

        const asset = tick.symbol;
        const price = parseFloat(tick.quote);
        const timestamp = tick.epoch;

        if (message.subscription) {
            this.tickSubscriptionIds[asset] = message.subscription.id;
        }

        // Store price
        this.priceHistories[asset].push(price);
        this.tickTimestamps[asset].push(timestamp);
        if (this.priceHistories[asset].length > 500) {
            this.priceHistories[asset].shift();
            this.tickTimestamps[asset].shift();
        }

        // Feed to analytics
        this.analyticsEngine.processTick(asset, price, timestamp);

        // Check data readiness
        if (this.priceHistories[asset].length >= this.config.requiredHistoryLength) {
            this.assetStates[asset].dataReady = true;
        }

        // Try to trade if not already in a trade
        if (!this.tradeInProgress && this.assetStates[asset].dataReady) {
            this.evaluateTradeOpportunity(asset);
        }
    }

    // ========================================================================
    // TRADE EVALUATION - THE CORE LOGIC
    // ========================================================================
    evaluateTradeOpportunity(asset) {
        if (this.tradeInProgress) return;
        if (this.endOfDay) return;

        // Check risk manager
        const riskCheck = this.riskManager.canTrade(asset);
        if (!riskCheck.allowed) {
            // Only log occasionally to avoid spam
            if (Math.random() < 0.01) {
                console.log(`[${asset}] ⛔ Risk block: ${riskCheck.reasons[0]}`);
            }
            return;
        }

        // Get current run length from proposal (we need to request one)
        // Request a proposal to get current stayedIn data
        const stake = this.riskManager.calculateStake();
        this.currentStake = stake;

        this.sendRequest({
            proposal: 1,
            amount: stake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: this.config.growthRate,
            limit_order: {
                take_profit: this.config.accuTakeProfit
            }
        });
    }

    handleProposal(message) {
        if (message.error) {
            console.error('Proposal error:', message.error.message);
            return;
        }

        const asset = message.echo_req?.symbol;
        if (!asset || !this.assets.includes(asset)) return;

        const proposal = message.proposal;
        if (!proposal) return;

        const stayedInArray = proposal.contract_details?.ticks_stayed_in;
        if (!stayedInArray || stayedInArray.length < 100) return;

        const assetState = this.assetStates[asset];
        assetState.currentProposalId = proposal.id;
        this.pendingProposals.set(proposal.id, asset);

        // Track completed runs from stayedIn transitions
        const prev = this.previousStayedIn[asset];
        if (prev !== null) {
            // Detect if a new run started (stayedIn[99] reset or changed pattern)
            let isIncreased = true;
            for (let i = 0; i < 99; i++) {
                if (stayedInArray[i] !== prev[i]) {
                    isIncreased = false;
                    break;
                }
            }

            if (!(isIncreased && stayedInArray[99] === prev[99] + 1)) {
                // A run completed! Record it
                const completedRunLength = prev[99] + 1;
                this.stayedInHistory[asset].push(completedRunLength);
                if (this.stayedInHistory[asset].length > 500) {
                    this.stayedInHistory[asset].shift();
                }
                this.analyticsEngine.recordCompletedRun(asset, completedRunLength);
            }
        }
        this.previousStayedIn[asset] = stayedInArray.slice();

        const currentRunLength = stayedInArray[99] + 1;
        assetState.currentRunLength = currentRunLength;

        // ---- TRADE DECISION ----
        if (this.tradeInProgress) return;

        // Re-check risk (may have changed since proposal request)
        const riskCheck = this.riskManager.canTrade(asset);
        if (!riskCheck.allowed) return;

        // Get trade signal from analytics engine
        const signal = this.analyticsEngine.getTradeSignal(
            asset,
            this.config.growthRate,
            currentRunLength
        );

        // Log signal details periodically
        if (Math.random() < 0.05) { // 5% of the time
            console.log(`[${asset}] Signal: score=${signal.score.toFixed(3)}, ` +
                `agree=${signal.agreement.toFixed(2)}, ` +
                `signals=[${signal.signals?.map(s => `${s.name}:${s.score}`).join(', ')}]`);
        }

        if (!signal.shouldTrade) return;

        // Additional safety checks
        if (!this.additionalSafetyChecks(asset, currentRunLength, stayedInArray)) return;

        // ---- EXECUTE TRADE ----
        console.log(`\n[${asset}] 🎯 TRADE SIGNAL TRIGGERED`);
        console.log(`  Score: ${signal.score.toFixed(3)} | Agreement: ${signal.agreement.toFixed(2)}`);
        console.log(`  Run Length: ${currentRunLength} | Stake: $${this.currentStake.toFixed(2)}`);
        signal.signals?.forEach(s => {
            console.log(`  ${s.name}: ${s.score}`);
        });

        this.executeTrade(asset, signal);
    }

    /**
     * Additional safety checks beyond the signal
     */
    additionalSafetyChecks(asset, currentRunLength, stayedInArray) {
        // 1. Don't trade if we don't have enough run history
        if (this.stayedInHistory[asset].length < this.config.minRunsForSignal) {
            return false;
        }

        // 2. Don't trade if last 5 runs were all very short (< 3 ticks)
        const recentRuns = this.stayedInHistory[asset].slice(-5);
        if (recentRuns.length >= 5 && recentRuns.every(r => r < 3)) {
            console.log(`[${asset}] ⚠️ Last 5 runs all < 3 ticks, skipping`);
            return false;
        }

        // 3. Don't trade if current run is at a historically dangerous length
        const allRuns = this.stayedInHistory[asset];
        const runsEndingAtThisLength = allRuns.filter(r => r === currentRunLength).length;
        const runsReachingThisLength = allRuns.filter(r => r >= currentRunLength).length;

        if (runsReachingThisLength > 0) {
            const instantHazard = runsEndingAtThisLength / runsReachingThisLength;
            if (instantHazard > 0.3 && runsReachingThisLength >= 15) {
                console.log(`[${asset}] ⚠️ High instant hazard at length ${currentRunLength}: ${(instantHazard * 100).toFixed(1)}%`);
                return false;
            }
        }

        // 4. Check volatility isn't spiking
        const volData = this.analyticsEngine.volatilityWindows[asset];
        if (volData?.shortWindow && volData?.longWindow) {
            const shortVol = volData.shortWindow.volatility;
            const longVol = volData.longWindow.volatility;
            if (shortVol > 0 && longVol > 0 && shortVol / longVol > 2.0) {
                console.log(`[${asset}] ⚠️ Volatility spike detected (ratio: ${(shortVol / longVol).toFixed(2)})`);
                return false;
            }
        }

        return true;
    }

    /**
     * Execute the trade
     */
    executeTrade(asset, signal) {
        const assetState = this.assetStates[asset];
        if (!assetState.currentProposalId) {
            console.log(`[${asset}] No proposal ID available`);
            return;
        }

        this.tradeInProgress = true;
        assetState.tradeInProgress = true;
        this.currentTradeAsset = asset;

        // Store signal for post-trade analysis
        this._lastSignal = signal;

        this.sendRequest({
            buy: assetState.currentProposalId,
            price: this.currentStake.toFixed(2)
        });

        console.log(`🚀 Trade placed: [${asset}] Stake: $${this.currentStake.toFixed(2)}`);

        this.sendTelegramMessage(
            `🚀 <b>TRADE PLACED</b>\n` +
            `Asset: ${asset}\n` +
            `Stake: $${this.currentStake.toFixed(2)}\n` +
            `Signal Score: ${signal.score.toFixed(3)}\n` +
            `Agreement: ${signal.agreement.toFixed(2)}\n` +
            `Run Length: ${assetState.currentRunLength}\n` +
            `Signals: ${signal.signals?.map(s => `${s.name}:${s.score}`).join(', ')}`
        );
    }

    handleBuy(message) {
        if (message.error) {
            console.error('Buy error:', message.error.message);
            this.tradeInProgress = false;
            if (this.currentTradeAsset) {
                this.assetStates[this.currentTradeAsset].tradeInProgress = false;
            }

            // If error is about invalid proposal, that's OK - try again next tick
            if (message.error.code === 'InvalidContractProposal') {
                console.log('Proposal expired, will retry on next tick');
            }
            return;
        }

        this.currentTradeId = message.buy.contract_id;
        console.log(`📝 Contract purchased: ${this.currentTradeId}`);

        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: this.currentTradeId,
            subscribe: 1
        });
    }

    handleContractUpdate(message) {
        const contract = message.proposal_open_contract;
        if (!contract) return;

        if (contract.is_sold) {
            this.handleTradeResult(contract);
        }
    }

    // ========================================================================
    // TRADE RESULT HANDLING
    // ========================================================================
    handleTradeResult(contract) {
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const stake = parseFloat(contract.buy_price);

        // Update counters
        this.totalTrades++;
        this.dailyTradeCount++;
        this.totalProfitLoss += profit;
        this.dailyPnL += profit;

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
        }

        // Update hourly stats
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;
        if (won) this.hourlyStats.wins++;
        else this.hourlyStats.losses++;

        // Record in risk manager
        this.riskManager.recordResult(asset, won, profit, stake);

        // Record in analytics engine for edge tracking
        this.analyticsEngine.recordTradeOutcome(asset, won, profit, stake);

        // Store trade result
        if (!this.tradeResults[asset]) this.tradeResults[asset] = [];
        this.tradeResults[asset].push({
            won,
            profit,
            stake,
            timestamp: Date.now(),
            signal: this._lastSignal ? {
                score: this._lastSignal.score,
                agreement: this._lastSignal.agreement,
            } : null,
        });
        if (this.tradeResults[asset].length > 200) this.tradeResults[asset].shift();

        // Log performance
        StatePersistence.appendPerformanceLog({
            asset,
            won,
            profit,
            stake,
            totalPnL: this.totalProfitLoss,
            consecutiveLosses: this.consecutiveLosses,
            totalTrades: this.totalTrades,
            winRate: this.totalWins / this.totalTrades,
        });

        // Calculate next stake
        this.currentStake = this.riskManager.calculateStake();

        // Reset trade state
        this.tradeInProgress = false;
        this.currentTradeId = null;
        if (this.assetStates[asset]) {
            this.assetStates[asset].tradeInProgress = false;
        }
        this.currentTradeAsset = null;

        // Log
        const resultEmoji = won ? '✅ WIN' : '❌ LOSS';
        const pnlStr = (profit >= 0 ? '+' : '') + '$' + Math.abs(profit).toFixed(2);
        const winRate = ((this.totalWins / this.totalTrades) * 100).toFixed(1);

        console.log(`\n${resultEmoji} [${asset}] ${pnlStr}`);
        console.log(`  Trades: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalLosses} | WR: ${winRate}%`);
        console.log(`  Total P&L: $${this.totalProfitLoss.toFixed(2)} | Next Stake: $${this.currentStake.toFixed(2)}`);

        // Telegram
        this.sendTelegramMessage(
            `${resultEmoji} <b>${asset}</b>\n` +
            `P&L: ${pnlStr}\n` +
            `Trades: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalLosses}\n` +
            `Win Rate: ${winRate}%\n` +
            `Total P&L: $${this.totalProfitLoss.toFixed(2)}\n` +
            `Next Stake: $${this.currentStake.toFixed(2)}\n` +
            `Consec. Losses: ${this.consecutiveLosses}`
        );

        // Check stop conditions
        if (this.riskManager.state.sessionPnL <= -this.config.stopLoss) {
            console.log('🛑 STOP LOSS reached');
            this.sendTelegramMessage(`🛑 <b>STOP LOSS</b>\nP&L: $${this.totalProfitLoss.toFixed(2)}`);
            this.endOfDay = true;
            this.disconnect();
            return;
        }

        if (this.riskManager.state.sessionPnL >= this.config.takeProfit) {
            console.log('🎯 TAKE PROFIT reached');
            this.sendTelegramMessage(`🎯 <b>TAKE PROFIT</b>\nP&L: $${this.totalProfitLoss.toFixed(2)}`);
            this.endOfDay = true;
            this.disconnect();
            return;
        }

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log(`⚠️ Max consecutive losses (${this.consecutiveLosses}), entering cooldown`);
        }

        // Save state
        StatePersistence.saveState(this);
    }

    // ========================================================================
    // TELEGRAM
    // ========================================================================
    async sendTelegramMessage(message) {
        if (!this.telegramEnabled) return;
        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error(`Telegram error: ${error.message}`);
        }
    }

    startTelegramTimer() {
        if (!this.telegramEnabled) return;

        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const timeUntil = nextHour.getTime() - now.getTime();

        setTimeout(() => {
            this.sendHourlySummary();
            setInterval(() => this.sendHourlySummary(), 3600000);
        }, timeUntil);

        console.log(`📱 Hourly summaries start in ${Math.ceil(timeUntil / 60000)} minutes`);
    }

    async sendHourlySummary() {
        const s = this.hourlyStats;
        const winRate = (s.wins + s.losses) > 0
            ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0';

        const edgeSummary = this.assets.map(asset => {
            const edge = this.analyticsEngine.edgeTracker[asset];
            if (!edge || edge.sampleCount < 5) return `${asset}: N/A`;
            return `${asset}: ${edge.isEdgePositive ? '✅' : '❌'} (${(edge.edgeEstimate * 100).toFixed(2)}%)`;
        }).join('\n├ ');

        const regimeSummary = this.assets.map(asset => {
            const regime = this.analyticsEngine.regimeState[asset];
            if (!regime || regime.currentRegime === 'unknown') return `${asset}: unknown`;
            return `${asset}: ${regime.currentRegime} (${(regime.regimeConfidence * 100).toFixed(0)}%)`;
        }).join('\n├ ');

        const msg = `
⏰ <b>Hourly Summary (v3.0)</b>

📊 <b>This Hour</b>
├ Trades: ${s.trades} | W/L: ${s.wins}/${s.losses}
├ Win Rate: ${winRate}%
└ P&L: ${s.pnl >= 0 ? '+' : ''}$${Math.abs(s.pnl).toFixed(2)}

📈 <b>Session Totals</b>
├ Trades: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalLosses}
├ Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : 0}%
├ P&L: $${this.totalProfitLoss.toFixed(2)}
└ Stake: $${this.currentStake.toFixed(2)}

📊 <b>Edge Estimates</b>
├ ${edgeSummary}

🌡️ <b>Regimes</b>
├ ${regimeSummary}

⏰ ${new Date().toLocaleString()}
        `.trim();

        await this.sendTelegramMessage(msg);

        this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
    }

    // ========================================================================
    // TIME MANAGEMENT
    // ========================================================================
    startTimeManager() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1 = new Date(now.getTime() + 3600000);
            const hour = gmtPlus1.getUTCHours();
            const day = gmtPlus1.getUTCDay();

            // Daily reset at 2 AM
            if (this.endOfDay && hour === 2) {
                console.log('🔄 New day, resetting...');
                this.riskManager.resetDaily();
                this.dailyTradeCount = 0;
                this.dailyPnL = 0;
                this.endOfDay = false;
                this.connect();
            }

            // End of day at 11:30 PM
            if (!this.endOfDay && hour >= 23 && this.totalTrades > 0) {
                console.log('🌙 End of day shutdown');
                this.sendHourlySummary();
                this.endOfDay = true;
                this.disconnect();
            }
        }, 20000);
    }

    disconnect() {
        console.log('🛑 Disconnecting...');
        StatePersistence.saveState(this);
        StatePersistence.stopAutoSave(this);
        this.endOfDay = true;
        this.cleanup();
    }

    // ========================================================================
    // START
    // ========================================================================
    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🚀 ACCUMULATOR TRADING BOT v3.0');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('  📊 Strategy: Volatility-Based Survival Analysis');
        console.log('  🎯 Growth Rate:', this.config.growthRate);
        console.log('  💰 Base Stake:', this.config.initialStake);
        console.log('  📉 Stop Loss:', this.config.stopLoss);
        console.log('  📈 Take Profit:', this.config.takeProfit);
        console.log('  🎰 Assets:', this.assets.join(', '));
        console.log('');
        console.log('  Key Improvements over v2:');
        console.log('    • Realized volatility vs barrier width analysis');
        console.log('    • Empirical conditional survival estimation');
        console.log('    • Regime detection (vol/trend/mean-revert)');
        console.log('    • Edge tracking - measures if strategy actually works');
        console.log('    • Controlled recovery instead of martingale');
        console.log('    • Per-asset cooldowns after losses');
        console.log('═══════════════════════════════════════════════════════════');

        StatePersistence.startAutoSave(this);
        this.startTelegramTimer();
        this.startTimeManager();
        this.connect();
    }
}

// ============================================================================
// RUN
// ============================================================================
const token = 'Dz2V2KvRf4Uukt3'; //|| process.env.DERIV_TOKEN;

const bot = new AccumulatorBotV3(token, {
    // Stake management
    initialStake: 5,     // Starting stake
    maxStake: 55,           // Max 5x base, NOT 21x

    // Accumulator settings
    growthRate: 0.01,       // 1% - lowest = safest
    accuTakeProfit: 0.01,

    // Risk management  
    stopLoss: 150,           // Realistic daily stop loss
    takeProfit: 10000,        // Realistic daily target
    maxConsecutiveLosses: 3,
    maxDrawdownPercent: 0.3,

    // Cooldowns
    baseCooldownMs: 30000,           // 30s after 1st loss
    maxCooldownMs: 300000,           // 5 min max cooldown
    minTimeBetweenTrades: 10000,     // 10s between trades

    // Data requirements
    requiredHistoryLength: 200,
    minRunsForSignal: 30,

    // Signal thresholds  
    minSignalScore: 0.3,
    minAgreement: 0.6,

    // Telegram (use environment variables)
    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ', //process.env.TELEGRAM_TOKEN,
    telegramChatId: '752497117', //process.env.TELEGRAM_CHAT_ID,

    // Assets
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
});

bot.start();

module.exports = { AccumulatorBotV3, AnalyticsEngine, RiskManager };
