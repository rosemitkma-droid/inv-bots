/**
 * Enhanced Deriv Accumulator Trading Bot
 * Version 2.0 - Advanced AI Learning System
 * 
 * Features:
 * - Kaplan-Meier Survival Analysis
 * - Bayesian Probability Updating
 * - Markov Chain Pattern Recognition
 * - Neural Network Prediction (Simplified MLP)
 * - Ensemble Decision Making
 * - Persistent Learning Memory
 */

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');


// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'nliveMulti5-state01.json');
const STATE_SAVE_INTERVAL = 5000; // Save every 5 seconds

class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                config: bot.config,
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    consecutiveLosses2: bot.consecutiveLosses2,
                    consecutiveLosses3: bot.consecutiveLosses3,
                    consecutiveLosses4: bot.consecutiveLosses4,
                    consecutiveLosses5: bot.consecutiveLosses5,
                    totalProfitLoss: bot.totalProfitLoss,
                    Pause: bot.Pause,
                    sys: bot.sys,
                    sysCount: bot.sysCount,
                    sys2: bot.sys2,
                    sys2WinCount: bot.sys2WinCount,
                    isWinTrade: bot.isWinTrade,
                },
                neuralEngine: bot.neuralEngine.exportWeights(),
                ensembleDecisionMaker: bot.ensembleDecisionMaker.exportState(),
                learningSystem: bot.learningSystem,
                extendedStayedIn: bot.extendedStayedIn,
                previousStayedIn: bot.previousStayedIn,
                assetStates: bot.assetStates,
                subscriptions: {
                    tickSubscriptionIds: { ...bot.tickSubscriptionIds }
                },
                assets: {},
                hourlyStats: bot.hourlyStats,
                observationCount: bot.observationCount,
                learningMode: bot.learningMode
            };

            bot.assets.forEach(asset => {
                persistableState.assets[asset] = {
                    tickHistory: bot.tickHistories[asset] || []
                };
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
            // console.log(`💾 State saved successfully at ${new Date().toLocaleTimeString()}`);
            return true;
        } catch (error) {
            console.error(`❌ Failed to save state: ${error.message}`);
            return false;
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                console.log('📂 No previous state file found, starting fresh');
                return null;
            }

            const fileContent = fs.readFileSync(STATE_FILE, 'utf8');
            const savedData = JSON.parse(fileContent);

            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            if (ageMinutes > 30) {
                console.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                // Optionally backup old state before deleting
                const backupFile = STATE_FILE.replace('.json', `_backup_${Date.now()}.json`);
                fs.renameSync(STATE_FILE, backupFile);
                console.log(`📦 Old state backed up to: ${backupFile}`);
                return null;
            }

            console.log(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);
            return savedData;
        } catch (error) {
            console.error(`❌ Failed to load state: ${error.message}`);
            if (error.code === 'ENOENT') {
                console.log('📂 State file not found, starting fresh');
            } else if (error instanceof SyntaxError) {
                console.error('⚠️ State file corrupted, starting fresh');
                // Backup corrupted file
                try {
                    const backupFile = STATE_FILE.replace('.json', `_corrupted_${Date.now()}.json`);
                    fs.renameSync(STATE_FILE, backupFile);
                    console.log(`📦 Corrupted file backed up to: ${backupFile}`);
                } catch (backupError) {
                    console.error('Failed to backup corrupted file:', backupError.message);
                }
            }
            return null;
        }
    }

    static startAutoSave(bot) {
        // Clear any existing auto-save interval
        if (bot.autoSaveInterval) {
            clearInterval(bot.autoSaveInterval);
        }

        bot.autoSaveInterval = setInterval(() => {
            if (bot.connected && !bot.endOfDay) {
                StatePersistence.saveState(bot);
            }
        }, STATE_SAVE_INTERVAL);

        console.log(`🔄 Auto-save started (every ${STATE_SAVE_INTERVAL / 1000} seconds)`);

        // Save on process exit
        const exitHandler = (options) => {
            console.log('\n🛑 Shutting down, saving final state...');
            StatePersistence.saveState(bot);
            if (options.exit) {
                process.exit();
            }
        };

        // Handle different exit events
        process.on('exit', exitHandler.bind(null, { cleanup: true }));
        process.on('SIGINT', exitHandler.bind(null, { exit: true }));
        process.on('SIGTERM', exitHandler.bind(null, { exit: true }));
        process.on('uncaughtException', (err) => {
            console.error('Uncaught Exception:', err);
            exitHandler({ exit: true });
        });
    }

    static stopAutoSave(bot) {
        if (bot.autoSaveInterval) {
            clearInterval(bot.autoSaveInterval);
            bot.autoSaveInterval = null;
            console.log('🔄 Auto-save stopped');
        }
    }
}

// ============================================================================
// TIER 1: ADVANCED STATISTICAL LEARNING ENGINE
// ============================================================================

class StatisticalEngine {
    constructor() {
        // Survival analysis
        this.survivalData = {};
        this.survivalCurves = {};
        this.cumulativeHazards = {};

        // Bayesian inference
        this.bayesianPriors = {};
        this.bayesianHistory = {};
        this.hierarchicalPriors = {};

        // Hazard rate estimation
        this.hazardRates = {};
        this.kernelHazardCache = {};

        // Entropy and information theory
        this.entropyScores = {};
        this.mutualInformationCache = {};
        this.divergenceCache = {};

        // Kernel density estimation
        this.kdeModels = {};
        this.bandwidthCache = {};

        // Exponentially weighted statistics
        this.ewmStats = {};

        // Bootstrap results
        this.bootstrapCache = {};

        // Extreme value theory
        this.evtModels = {};

        // Mixture models
        this.mixtureModels = {};

        // SPRT state
        this.sprtState = {};

        // Rank correlation cache
        this.rankCorrelations = {};

        // Cox model
        this.coxModels = {};

        // Configuration
        this.config = {
            bootstrapSamples: 200,
            kdeDefaultBandwidth: 'silverman',
            ewmAlpha: 0.05,
            ewmSpan: 20,
            bayesianDecayRate: 0.998,
            bayesianMinAlpha: 1.5,
            bayesianMinBeta: 1.5,
            mixtureMaxComponents: 3,
            mixtureMaxIterations: 50,
            mixtureConvergenceTol: 1e-4,
            sprtAlpha: 0.05,
            sprtBeta: 0.05,
            evtBlockSize: 10,
        };
    }

    // ====================================================================
    // KAPLAN-MEIER SURVIVAL ANALYSIS (ENHANCED)
    // ====================================================================

    /**
     * Full Kaplan-Meier estimator with Greenwood variance,
     * confidence intervals, and median survival
     */
    kaplanMeierEstimate(runLengths, targetLength, options = {}) {
        if (!runLengths || runLengths.length < 10) {
            return {
                survival: 0.5,
                ci_lower: 0.3,
                ci_upper: 0.7,
                variance: 0.1,
                sampleSize: 0,
                medianSurvival: null,
                hazardAtTarget: 0.1,
                conditionalSurvival: 0.5,
            };
        }

        const sorted = [...runLengths].sort((a, b) => a - b);
        const n = sorted.length;
        const timePoints = [...new Set(sorted)].sort((a, b) => a - b);

        // Build full survival curve
        let survival = 1.0;
        let greenwoodVariance = 0;
        const survivalCurve = [{ time: 0, survival: 1.0, variance: 0, atRisk: n, events: 0 }];
        let medianSurvival = null;

        for (const t of timePoints) {
            const atRisk = runLengths.filter(l => l >= t).length;
            const events = runLengths.filter(l => l === t).length;

            if (atRisk > 0 && events > 0) {
                const hazard = events / atRisk;
                survival *= (1 - hazard);

                // Greenwood's formula for variance
                if (atRisk > events) {
                    greenwoodVariance += events / (atRisk * (atRisk - events));
                }

                survivalCurve.push({
                    time: t,
                    survival,
                    variance: greenwoodVariance,
                    atRisk,
                    events,
                    hazard,
                });

                // Track median survival
                if (medianSurvival === null && survival <= 0.5) {
                    medianSurvival = t;
                }
            }
        }

        // Get survival at target length
        let survivalAtTarget = 1.0;
        let varianceAtTarget = 0;

        for (const point of survivalCurve) {
            if (point.time <= targetLength) {
                survivalAtTarget = point.survival;
                varianceAtTarget = point.variance;
            }
        }

        // Standard error and confidence intervals
        const se = survivalAtTarget * Math.sqrt(varianceAtTarget);
        const z = options.z || 1.96; // 95% CI by default

        // Log-log transform for better CI behavior near boundaries
        let ci_lower, ci_upper;
        if (survivalAtTarget > 0 && survivalAtTarget < 1) {
            const logLogS = Math.log(-Math.log(survivalAtTarget));
            const logLogSE = se / (survivalAtTarget * Math.abs(Math.log(survivalAtTarget)));

            ci_lower = Math.exp(-Math.exp(logLogS + z * logLogSE));
            ci_upper = Math.exp(-Math.exp(logLogS - z * logLogSE));
        } else {
            ci_lower = Math.max(0, survivalAtTarget - z * se);
            ci_upper = Math.min(1, survivalAtTarget + z * se);
        }

        // Conditional survival: P(T > targetLength + k | T > targetLength)
        // For k = 1, 2, 3 steps ahead
        const conditionalSurvival = {};
        for (let k = 1; k <= 5; k++) {
            const futureTarget = targetLength + k;
            let futureSurvival = 1.0;
            for (const point of survivalCurve) {
                if (point.time <= futureTarget) {
                    futureSurvival = point.survival;
                }
            }
            conditionalSurvival[k] = survivalAtTarget > 0 ?
                futureSurvival / survivalAtTarget : 0;
        }

        // Hazard at target
        let hazardAtTarget = 0;
        const targetPoint = survivalCurve.find(p => p.time === targetLength);
        if (targetPoint) {
            hazardAtTarget = targetPoint.hazard || 0;
        }

        // Store the full survival curve for this asset
        const cacheKey = `km_${targetLength}`;
        this.survivalCurves[cacheKey] = survivalCurve;

        return {
            survival: Math.max(0, Math.min(1, survivalAtTarget)),
            ci_lower: Math.max(0, ci_lower),
            ci_upper: Math.min(1, ci_upper),
            variance: varianceAtTarget,
            standardError: se,
            sampleSize: n,
            medianSurvival,
            hazardAtTarget,
            conditionalSurvival,
            survivalCurve: survivalCurve.slice(-20), // Keep last 20 points
        };
    }

    /**
     * Log-Rank Test: compare survival between two groups
     * Useful for comparing different market conditions
     */
    logRankTest(group1, group2) {
        if (!group1 || !group2 || group1.length < 10 || group2.length < 10) {
            return { statistic: 0, pValue: 1, significant: false };
        }

        const allTimes = [...new Set([...group1, ...group2])].sort((a, b) => a - b);

        let observedMinusExpected = 0;
        let varianceSum = 0;

        for (const t of allTimes) {
            const d1 = group1.filter(x => x === t).length;
            const d2 = group2.filter(x => x === t).length;
            const d = d1 + d2;

            const n1 = group1.filter(x => x >= t).length;
            const n2 = group2.filter(x => x >= t).length;
            const n = n1 + n2;

            if (n === 0 || d === 0) continue;

            const e1 = (n1 * d) / n;
            observedMinusExpected += d1 - e1;

            if (n > 1) {
                varianceSum += (n1 * n2 * d * (n - d)) / (n * n * (n - 1));
            }
        }

        const statistic = varianceSum > 0 ?
            (observedMinusExpected * observedMinusExpected) / varianceSum : 0;

        // Approximate p-value (chi-squared with 1 df)
        const pValue = 1 - this._chiSquaredCDF(statistic, 1);

        return {
            statistic,
            pValue,
            significant: pValue < 0.05,
            observedMinusExpected,
            interpretation: observedMinusExpected > 0 ?
                'group1_survives_longer' : 'group2_survives_longer',
        };
    }

    /**
     * Stratified Kaplan-Meier: survival estimates conditioned on covariates
     */
    stratifiedKaplanMeier(runLengths, covariates, targetLength) {
        if (!runLengths || !covariates || runLengths.length !== covariates.length) {
            return null;
        }

        // Group by covariate levels
        const groups = {};
        covariates.forEach((cov, i) => {
            const key = typeof cov === 'string' ? cov : this._discretizeContinuous(cov);
            if (!groups[key]) groups[key] = [];
            groups[key].push(runLengths[i]);
        });

        const results = {};
        Object.entries(groups).forEach(([key, lengths]) => {
            if (lengths.length >= 10) {
                results[key] = this.kaplanMeierEstimate(lengths, targetLength);
            }
        });

        return results;
    }

    // ====================================================================
    // NELSON-AALEN CUMULATIVE HAZARD ESTIMATOR (ENHANCED)
    // ====================================================================

    /**
     * Nelson-Aalen estimator with Breslow variance and confidence bands
     */
    nelsonAalenHazard(runLengths, targetLength) {
        if (!runLengths || runLengths.length < 10) {
            return {
                cumulativeHazard: 0.5,
                hazardRate: 0.1,
                survivalFromHazard: 0.6,
                variance: 0.1,
            };
        }

        const sorted = [...runLengths].sort((a, b) => a - b);
        const n = sorted.length;
        const timePoints = [...new Set(sorted)].sort((a, b) => a - b);

        let cumulativeHazard = 0;
        let lastHazard = 0;
        let breslowVariance = 0;

        const hazardCurve = [{ time: 0, cumulativeHazard: 0, variance: 0 }];

        for (const t of timePoints) {
            if (t > targetLength) break;

            const atRisk = runLengths.filter(l => l >= t).length;
            const events = runLengths.filter(l => l === t).length;

            if (atRisk > 0) {
                lastHazard = events / atRisk;
                cumulativeHazard += lastHazard;

                // Breslow variance
                breslowVariance += events / (atRisk * atRisk);

                hazardCurve.push({
                    time: t,
                    cumulativeHazard,
                    hazardRate: lastHazard,
                    variance: breslowVariance,
                    atRisk,
                    events,
                });
            }
        }

        // Confidence bands (EP / Hall-Wellner style approximation)
        const se = Math.sqrt(breslowVariance);
        const z = 1.96;

        // Fleming-Harrington survival estimate (more robust than direct exp)
        const survivalFH = Math.exp(-cumulativeHazard);

        // Smoothed instantaneous hazard rate at target
        const smoothedHazard = this._kernelSmoothedHazardInternal(
            runLengths, targetLength, this._computeOptimalBandwidth(runLengths)
        );

        return {
            cumulativeHazard,
            hazardRate: lastHazard,
            smoothedHazardRate: smoothedHazard,
            survivalFromHazard: survivalFH,
            variance: breslowVariance,
            standardError: se,
            ci_lower_hazard: Math.max(0, cumulativeHazard - z * se),
            ci_upper_hazard: cumulativeHazard + z * se,
            ci_lower_survival: Math.exp(-(cumulativeHazard + z * se)),
            ci_upper_survival: Math.exp(-Math.max(0, cumulativeHazard - z * se)),
            hazardCurve: hazardCurve.slice(-15),
            sampleSize: n,
        };
    }

    // ====================================================================
    // BAYESIAN INFERENCE (ENHANCED)
    // ====================================================================

    /**
     * Initialize Bayesian prior with optional informative prior
     */
    initBayesianPrior(asset, alpha = 2, beta = 2) {
        this.bayesianPriors[asset] = {
            alpha,
            beta,
            observations: 0,
            lastUpdate: Date.now(),
        };

        this.bayesianHistory[asset] = [];

        // Hierarchical prior (hyper-parameters for learning the learning rate)
        this.hierarchicalPriors[asset] = {
            hyperAlpha: 1.0,
            hyperBeta: 1.0,
            effectiveDecay: this.config.bayesianDecayRate,
            adaptiveWeight: 1.0,
        };
    }

    /**
     * Update Bayesian posterior with new observation
     * Includes adaptive decay and hierarchical updating
     */
    updateBayesian(asset, survived, context = {}) {
        if (!this.bayesianPriors[asset]) {
            this.initBayesianPrior(asset);
        }

        const prior = this.bayesianPriors[asset];
        const hierarchical = this.hierarchicalPriors[asset];

        // Context-dependent weighting
        let weight = 1.0;
        if (context.volatility !== undefined) {
            // Weight recent observations less during high volatility
            weight *= (1 - context.volatility * 0.3);
        }
        if (context.regimeConfidence !== undefined) {
            // Weight more when regime is clear
            weight *= (0.7 + 0.3 * context.regimeConfidence);
        }

        weight *= hierarchical.adaptiveWeight;
        weight = Math.max(0.3, Math.min(2.0, weight));

        // Update posterior
        if (survived) {
            prior.alpha += weight;
        } else {
            prior.beta += weight;
        }

        prior.observations++;
        prior.lastUpdate = Date.now();

        // Adaptive decay: decay faster when predictions are poor
        const currentMean = prior.alpha / (prior.alpha + prior.beta);
        const predictionError = Math.abs((survived ? 1 : 0) - currentMean);

        // Adjust hierarchical adaptive weight
        // If prediction errors are high, weight new data more heavily
        hierarchical.adaptiveWeight = 0.95 * hierarchical.adaptiveWeight +
            0.05 * (0.8 + predictionError * 0.4);

        // Apply decay to prevent over-confidence from old data
        const decay = hierarchical.effectiveDecay;
        prior.alpha *= decay;
        prior.beta *= decay;

        // Enforce minimum values
        prior.alpha = Math.max(this.config.bayesianMinAlpha, prior.alpha);
        prior.beta = Math.max(this.config.bayesianMinBeta, prior.beta);

        // Track history for trend analysis
        this.bayesianHistory[asset].push({
            mean: prior.alpha / (prior.alpha + prior.beta),
            alpha: prior.alpha,
            beta: prior.beta,
            survived,
            weight,
            timestamp: Date.now(),
        });

        if (this.bayesianHistory[asset].length > 500) {
            this.bayesianHistory[asset] = this.bayesianHistory[asset].slice(-400);
        }
    }

    /**
     * Get comprehensive Bayesian estimate with credible intervals
     */
    getBayesianEstimate(asset) {
        if (!this.bayesianPriors[asset]) {
            return {
                mean: 0.5,
                variance: 0.25,
                ci_lower: 0.25,
                ci_upper: 0.75,
                confidence: 0,
                mode: 0.5,
                trend: 'stable',
                predictionStrength: 'weak',
            };
        }

        const { alpha, beta, observations } = this.bayesianPriors[asset];
        const totalConcentration = alpha + beta;

        // Beta distribution statistics
        const mean = alpha / totalConcentration;
        const variance = (alpha * beta) / (totalConcentration * totalConcentration * (totalConcentration + 1));
        const std = Math.sqrt(variance);

        // Mode (most probable value)
        let mode = 0.5;
        if (alpha > 1 && beta > 1) {
            mode = (alpha - 1) / (totalConcentration - 2);
        } else if (alpha <= 1 && beta > 1) {
            mode = 0;
        } else if (alpha > 1 && beta <= 1) {
            mode = 1;
        }

        // Credible intervals (using normal approximation to Beta for speed)
        const z95 = 1.96;
        const z90 = 1.645;
        const z99 = 2.576;

        // Highest Density Interval (HDI) approximation
        const ci_90_lower = Math.max(0, mean - z90 * std);
        const ci_90_upper = Math.min(1, mean + z90 * std);
        const ci_95_lower = Math.max(0, mean - z95 * std);
        const ci_95_upper = Math.min(1, mean + z95 * std);
        const ci_99_lower = Math.max(0, mean - z99 * std);
        const ci_99_upper = Math.min(1, mean + z99 * std);

        // Trend analysis from history
        const trend = this._analyzeBayesianTrend(asset);

        // Prediction strength
        const ciWidth = ci_95_upper - ci_95_lower;
        let predictionStrength;
        if (ciWidth < 0.1) predictionStrength = 'very_strong';
        else if (ciWidth < 0.2) predictionStrength = 'strong';
        else if (ciWidth < 0.35) predictionStrength = 'moderate';
        else if (ciWidth < 0.5) predictionStrength = 'weak';
        else predictionStrength = 'very_weak';

        // Bayes factor: evidence ratio for survival vs non-survival
        const bayesFactor = alpha / beta;

        // Probability that true rate exceeds threshold
        const exceedanceProb = this._betaSurvivalFunction(0.5, alpha, beta);

        return {
            mean,
            mode,
            variance,
            standardDeviation: std,
            ci_lower: ci_95_lower,
            ci_upper: ci_95_upper,
            credibleIntervals: {
                ci90: [ci_90_lower, ci_90_upper],
                ci95: [ci_95_lower, ci_95_upper],
                ci99: [ci_99_lower, ci_99_upper],
            },
            confidence: totalConcentration,
            observations,
            bayesFactor,
            exceedanceProb,
            trend,
            predictionStrength,
            ciWidth,
        };
    }

    /**
     * Analyze trend in Bayesian estimates over time
     */
    _analyzeBayesianTrend(asset) {
        const history = this.bayesianHistory[asset];
        if (!history || history.length < 10) return 'stable';

        const recent = history.slice(-20);
        const firstHalf = recent.slice(0, Math.floor(recent.length / 2));
        const secondHalf = recent.slice(Math.floor(recent.length / 2));

        const firstMean = firstHalf.reduce((a, b) => a + b.mean, 0) / firstHalf.length;
        const secondMean = secondHalf.reduce((a, b) => a + b.mean, 0) / secondHalf.length;

        const diff = secondMean - firstMean;

        if (diff > 0.05) return 'improving';
        if (diff < -0.05) return 'deteriorating';
        return 'stable';
    }

    /**
     * Beta survival function approximation: P(X > x) for Beta(alpha, beta)
     */
    _betaSurvivalFunction(x, alpha, beta) {
        // Use normal approximation for speed
        const mean = alpha / (alpha + beta);
        const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
        const z = (x - mean) / Math.sqrt(variance);
        return 1 - this._normalCDF(z);
    }

    /**
     * Bayesian model comparison for two time periods
     */
    compareBayesianPeriods(asset, splitIndex) {
        const history = this.bayesianHistory[asset];
        if (!history || history.length < 20) return null;

        const split = splitIndex || Math.floor(history.length / 2);
        const period1 = history.slice(0, split);
        const period2 = history.slice(split);

        const wins1 = period1.filter(h => h.survived).length;
        const losses1 = period1.length - wins1;
        const wins2 = period2.filter(h => h.survived).length;
        const losses2 = period2.length - wins2;

        const rate1 = wins1 / period1.length;
        const rate2 = wins2 / period2.length;

        // Two-proportion z-test
        const pooledRate = (wins1 + wins2) / (period1.length + period2.length);
        const se = Math.sqrt(pooledRate * (1 - pooledRate) *
            (1 / period1.length + 1 / period2.length));
        const zStat = se > 0 ? (rate1 - rate2) / se : 0;
        const pValue = 2 * (1 - this._normalCDF(Math.abs(zStat)));

        return {
            period1: { rate: rate1, wins: wins1, total: period1.length },
            period2: { rate: rate2, wins: wins2, total: period2.length },
            zStatistic: zStat,
            pValue,
            significantDifference: pValue < 0.05,
            direction: rate2 > rate1 ? 'improving' : 'deteriorating',
        };
    }

    // ====================================================================
    // KERNEL DENSITY ESTIMATION
    // ====================================================================

    /**
     * Gaussian KDE for run length distribution with optimal bandwidth
     */
    kernelDensityEstimate(asset, runLengths, evalPoints = null) {
        if (!runLengths || runLengths.length < 15) return null;

        const n = runLengths.length;
        const bandwidth = this._computeOptimalBandwidth(runLengths);

        // Default evaluation points
        if (!evalPoints) {
            const min = Math.max(0, Math.min(...runLengths) - 2 * bandwidth);
            const max = Math.max(...runLengths) + 2 * bandwidth;
            const step = (max - min) / 100;
            evalPoints = [];
            for (let x = min; x <= max; x += step) {
                evalPoints.push(x);
            }
        }

        // Gaussian kernel
        const gaussKernel = (u) => Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);

        const density = evalPoints.map(x => {
            let sum = 0;
            for (let i = 0; i < n; i++) {
                sum += gaussKernel((x - runLengths[i]) / bandwidth);
            }
            return {
                x,
                density: sum / (n * bandwidth),
            };
        });

        // Find modes (peaks in density)
        const modes = [];
        for (let i = 1; i < density.length - 1; i++) {
            if (density[i].density > density[i - 1].density &&
                density[i].density > density[i + 1].density) {
                modes.push(density[i]);
            }
        }
        modes.sort((a, b) => b.density - a.density);

        // CDF at specific points
        const cdf = (x) => {
            let sum = 0;
            for (let i = 0; i < n; i++) {
                sum += this._normalCDF((x - runLengths[i]) / bandwidth);
            }
            return sum / n;
        };

        this.kdeModels[asset] = {
            bandwidth,
            density,
            modes,
            cdf,
            numModes: modes.length,
            isMultiModal: modes.length > 1,
            primaryMode: modes.length > 0 ? modes[0].x : null,
        };

        return this.kdeModels[asset];
    }

    /**
     * Compute optimal bandwidth using Silverman's rule of thumb
     * with Sheather-Jones improvement
     */
    _computeOptimalBandwidth(data) {
        const n = data.length;
        const mean = data.reduce((a, b) => a + b, 0) / n;
        const std = Math.sqrt(data.reduce((a, b) => a + (b - mean) ** 2, 0) / n);

        // IQR-based estimate (more robust)
        const sorted = [...data].sort((a, b) => a - b);
        const q1 = sorted[Math.floor(n * 0.25)];
        const q3 = sorted[Math.floor(n * 0.75)];
        const iqr = q3 - q1;

        // Silverman's rule with robustification
        const silverman = 0.9 * Math.min(std, iqr / 1.34) * Math.pow(n, -0.2);

        return Math.max(0.5, silverman); // Minimum bandwidth of 0.5
    }

    /**
     * Evaluate density at a single point
     */
    evaluateKDE(asset, point) {
        if (!this.kdeModels[asset]) return null;

        const kde = this.kdeModels[asset];
        // Find nearest density point
        let closestDensity = 0;
        let minDist = Infinity;

        kde.density.forEach(d => {
            const dist = Math.abs(d.x - point);
            if (dist < minDist) {
                minDist = dist;
                closestDensity = d.density;
            }
        });

        const cdfValue = kde.cdf(point);

        return {
            density: closestDensity,
            cdf: cdfValue,
            survivalFunction: 1 - cdfValue,
            percentile: cdfValue * 100,
        };
    }

    // ====================================================================
    // EXPONENTIALLY WEIGHTED MOVING STATISTICS
    // ====================================================================

    /**
     * Initialize EWMA tracking for an asset
     */
    initEWMStats(asset) {
        const alpha = this.config.ewmAlpha;

        this.ewmStats[asset] = {
            mean: null,
            variance: null,
            skewness: null,
            kurtosis: null,
            count: 0,
            alpha,
            history: [],
            // Centered moments
            m2: 0,
            m3: 0,
            m4: 0,
        };
    }

    /**
     * Update EWMA statistics with new observation
     */
    updateEWMStats(asset, value) {
        if (!this.ewmStats[asset]) {
            this.initEWMStats(asset);
        }

        const stats = this.ewmStats[asset];
        const alpha = stats.alpha;

        if (stats.mean === null) {
            stats.mean = value;
            stats.variance = 0;
            stats.m2 = 0;
            stats.m3 = 0;
            stats.m4 = 0;
        } else {
            const diff = value - stats.mean;

            // Update mean
            const newMean = (1 - alpha) * stats.mean + alpha * value;

            // Update centered moments using Welford-like online algorithm
            const delta = value - stats.mean;
            const newDelta = value - newMean;

            stats.m2 = (1 - alpha) * (stats.m2 + alpha * delta * delta);
            stats.m3 = (1 - alpha) * (stats.m3 + alpha * delta * delta * delta * (1 - alpha) -
                3 * alpha * delta * stats.m2 / (1 - alpha));
            stats.m4 = (1 - alpha) * (stats.m4 + alpha * Math.pow(delta, 4) * (1 - alpha) -
                4 * alpha * delta * stats.m3 / (1 - alpha));

            stats.mean = newMean;
            stats.variance = stats.m2;
        }

        stats.count++;

        // Compute derived statistics
        const std = Math.sqrt(Math.max(0, stats.variance));
        stats.skewness = std > 0 ? stats.m3 / Math.pow(std, 3) : 0;
        stats.kurtosis = stats.variance > 0 ? stats.m4 / (stats.variance * stats.variance) - 3 : 0;

        // Track z-score of current observation
        const zScore = std > 0 ? (value - stats.mean) / std : 0;

        // Store in history
        stats.history.push({
            value,
            mean: stats.mean,
            variance: stats.variance,
            zScore,
            timestamp: Date.now(),
        });

        if (stats.history.length > 200) {
            stats.history = stats.history.slice(-150);
        }

        return {
            mean: stats.mean,
            variance: stats.variance,
            std,
            skewness: stats.skewness,
            kurtosis: stats.kurtosis,
            zScore,
            isOutlier: Math.abs(zScore) > 2.5,
            isExtreme: Math.abs(zScore) > 3.5,
        };
    }

    /**
     * Get current EWMA statistics
     */
    getEWMStats(asset) {
        if (!this.ewmStats[asset]) return null;

        const stats = this.ewmStats[asset];
        const std = Math.sqrt(Math.max(0, stats.variance));

        return {
            mean: stats.mean,
            variance: stats.variance,
            std,
            skewness: stats.skewness,
            kurtosis: stats.kurtosis,
            count: stats.count,
            // Bollinger-band-like bounds
            upperBound: stats.mean + 2 * std,
            lowerBound: stats.mean - 2 * std,
        };
    }

    // ====================================================================
    // BOOTSTRAP CONFIDENCE INTERVALS
    // ====================================================================

    /**
     * Bootstrap estimate of survival probability with confidence intervals
     */
    bootstrapSurvival(runLengths, targetLength, numSamples = null) {
        const B = numSamples || this.config.bootstrapSamples;

        if (!runLengths || runLengths.length < 15) {
            return { mean: 0.5, ci_lower: 0.2, ci_upper: 0.8, std: 0.2 };
        }

        const n = runLengths.length;
        const bootstrapEstimates = [];

        for (let b = 0; b < B; b++) {
            // Resample with replacement
            const sample = [];
            for (let i = 0; i < n; i++) {
                sample.push(runLengths[Math.floor(Math.random() * n)]);
            }

            // Compute KM survival on bootstrap sample
            const km = this.kaplanMeierEstimate(sample, targetLength);
            bootstrapEstimates.push(km.survival);
        }

        // Sort for percentile calculation
        bootstrapEstimates.sort((a, b) => a - b);

        const mean = bootstrapEstimates.reduce((a, b) => a + b, 0) / B;
        const std = Math.sqrt(
            bootstrapEstimates.reduce((a, b) => a + (b - mean) ** 2, 0) / B
        );

        // Percentile method CI
        const ci_lower = bootstrapEstimates[Math.floor(B * 0.025)];
        const ci_upper = bootstrapEstimates[Math.floor(B * 0.975)];

        // BCa (Bias-Corrected and accelerated) adjustment
        const biasFactor = bootstrapEstimates.filter(e => e < mean).length / B;
        const z0 = this._normalQuantile(biasFactor);

        return {
            mean,
            std,
            ci_lower: Math.max(0, ci_lower),
            ci_upper: Math.min(1, ci_upper),
            biasFactor: z0,
            percentiles: {
                p5: bootstrapEstimates[Math.floor(B * 0.05)],
                p10: bootstrapEstimates[Math.floor(B * 0.10)],
                p25: bootstrapEstimates[Math.floor(B * 0.25)],
                p50: bootstrapEstimates[Math.floor(B * 0.50)],
                p75: bootstrapEstimates[Math.floor(B * 0.75)],
                p90: bootstrapEstimates[Math.floor(B * 0.90)],
                p95: bootstrapEstimates[Math.floor(B * 0.95)],
            },
            numSamples: B,
        };
    }

    // ====================================================================
    // INFORMATION THEORY
    // ====================================================================

    /**
     * Shannon Entropy (normalized to [0, 1])
     */
    calculateEntropy(sequence) {
        if (!sequence || sequence.length < 10) return 1.0;

        const freq = {};
        sequence.forEach(d => { freq[d] = (freq[d] || 0) + 1; });

        let entropy = 0;
        const n = sequence.length;

        Object.values(freq).forEach(count => {
            const p = count / n;
            if (p > 0) entropy -= p * Math.log2(p);
        });

        const numSymbols = Object.keys(freq).length;
        const maxEntropy = Math.log2(numSymbols);

        return maxEntropy > 0 ? entropy / maxEntropy : 1.0;
    }

    /**
     * Rényi Entropy of order q
     * q=0: Hartley entropy (log of support size)
     * q=1: Shannon entropy (limit)
     * q=2: Collision entropy
     * q→∞: Min-entropy
     */
    renyiEntropy(sequence, q = 2) {
        if (!sequence || sequence.length < 10) return 1.0;

        const freq = {};
        sequence.forEach(d => { freq[d] = (freq[d] || 0) + 1; });

        const n = sequence.length;
        const probs = Object.values(freq).map(c => c / n);

        if (Math.abs(q - 1) < 1e-10) {
            // Limit as q → 1 is Shannon entropy
            return this.calculateEntropy(sequence);
        }

        let sum = 0;
        probs.forEach(p => { sum += Math.pow(p, q); });

        const entropy = (1 / (1 - q)) * Math.log2(sum);
        const maxEntropy = Math.log2(probs.length);

        return maxEntropy > 0 ? entropy / maxEntropy : 1.0;
    }

    /**
     * Conditional Entropy H(Y|X) with configurable order
     */
    calculateConditionalEntropy(sequence, order = 2) {
        if (!sequence || sequence.length < order + 10) return 1.0;

        const contextCounts = {};
        const jointCounts = {};

        for (let i = order; i < sequence.length; i++) {
            const context = sequence.slice(i - order, i).join(',');
            const outcome = sequence[i];
            const joint = `${context}|${outcome}`;

            contextCounts[context] = (contextCounts[context] || 0) + 1;
            jointCounts[joint] = (jointCounts[joint] || 0) + 1;
        }

        let conditionalEntropy = 0;
        const n = sequence.length - order;

        Object.entries(jointCounts).forEach(([joint, count]) => {
            const [context] = joint.split('|');
            const pJoint = count / n;
            const pConditional = count / contextCounts[context];

            if (pConditional > 0) {
                conditionalEntropy -= pJoint * Math.log2(pConditional);
            }
        });

        const numSymbols = new Set(sequence).size;
        const maxEntropy = Math.log2(numSymbols);

        return maxEntropy > 0 ? conditionalEntropy / maxEntropy : 1.0;
    }

    /**
     * Mutual Information I(X; Y) between consecutive segments
     */
    calculateMutualInformation(asset, sequence, segmentLength = 20) {
        if (!sequence || sequence.length < segmentLength * 2 + 10) return null;

        // Split into overlapping segments
        const n = sequence.length;
        const miValues = [];

        for (let start = 0; start <= n - segmentLength * 2; start += segmentLength) {
            const seg1 = sequence.slice(start, start + segmentLength);
            const seg2 = sequence.slice(start + segmentLength, start + segmentLength * 2);

            // Compute distributions
            const dist1 = this._computeDistribution(seg1);
            const dist2 = this._computeDistribution(seg2);

            // Joint distribution
            const jointDist = {};
            for (let i = 0; i < segmentLength; i++) {
                const key = `${seg1[i]},${seg2[i]}`;
                jointDist[key] = (jointDist[key] || 0) + 1 / segmentLength;
            }

            // MI = sum p(x,y) * log(p(x,y) / (p(x) * p(y)))
            let mi = 0;
            Object.entries(jointDist).forEach(([key, pxy]) => {
                const [x, y] = key.split(',');
                const px = dist1[x] || 1e-10;
                const py = dist2[y] || 1e-10;
                if (pxy > 0) {
                    mi += pxy * Math.log2(pxy / (px * py));
                }
            });

            miValues.push(Math.max(0, mi));
        }

        if (miValues.length === 0) return null;

        const meanMI = miValues.reduce((a, b) => a + b, 0) / miValues.length;
        const stdMI = Math.sqrt(
            miValues.reduce((a, b) => a + (b - meanMI) ** 2, 0) / miValues.length
        );

        this.mutualInformationCache[asset] = {
            mean: meanMI,
            std: stdMI,
            values: miValues,
            trend: miValues.length >= 3 ?
                (miValues[miValues.length - 1] > miValues[0] ? 'increasing' : 'decreasing') : 'stable',
            // Higher MI = more predictable relationship between segments
            predictability: Math.min(1, meanMI * 2),
        };

        return this.mutualInformationCache[asset];
    }

    /**
     * KL Divergence D_KL(P || Q) from observed to expected distribution
     */
    klDivergence(observed, expected) {
        let divergence = 0;
        const allKeys = new Set([...Object.keys(observed), ...Object.keys(expected)]);

        allKeys.forEach(key => {
            const p = observed[key] || 1e-10;
            const q = expected[key] || 1e-10;
            if (p > 0) {
                divergence += p * Math.log(p / q);
            }
        });

        return Math.max(0, divergence);
    }

    /**
     * Jensen-Shannon Divergence (symmetric, bounded)
     */
    jsDivergence(dist1, dist2) {
        const allKeys = new Set([...Object.keys(dist1), ...Object.keys(dist2)]);
        const m = {};

        allKeys.forEach(key => {
            m[key] = ((dist1[key] || 0) + (dist2[key] || 0)) / 2;
        });

        return (this.klDivergence(dist1, m) + this.klDivergence(dist2, m)) / 2;
    }

    /**
     * Transfer Entropy: measure of directed information transfer
     * TE(X→Y) measures how much X helps predict Y beyond Y's own past
     */
    transferEntropy(source, target, order = 1) {
        if (!source || !target || source.length < order + 20 ||
            source.length !== target.length) return null;

        const n = source.length;
        const counts = {
            targetGivenBoth: {},
            targetGivenTarget: {},
            both: {},
            target: {},
        };

        for (let i = order; i < n; i++) {
            const targetPast = target.slice(i - order, i).join(',');
            const sourcePast = source.slice(i - order, i).join(',');
            const nextTarget = target[i];

            const bothKey = `${targetPast}|${sourcePast}`;
            const targetNextBothKey = `${nextTarget}|${bothKey}`;
            const targetNextTargetKey = `${nextTarget}|${targetPast}`;

            counts.targetGivenBoth[targetNextBothKey] =
                (counts.targetGivenBoth[targetNextBothKey] || 0) + 1;
            counts.targetGivenTarget[targetNextTargetKey] =
                (counts.targetGivenTarget[targetNextTargetKey] || 0) + 1;
            counts.both[bothKey] = (counts.both[bothKey] || 0) + 1;
            counts.target[targetPast] = (counts.target[targetPast] || 0) + 1;
        }

        // Compute TE
        let te = 0;
        const total = n - order;

        Object.entries(counts.targetGivenBoth).forEach(([key, count]) => {
            const parts = key.split('|');
            const nextTarget = parts[0];
            const bothKey = parts.slice(1).join('|');
            const targetPast = bothKey.split('|')[0];
            const targetNextTargetKey = `${nextTarget}|${targetPast}`;

            const pTargetGivenBoth = count / (counts.both[bothKey] || 1);
            const pTargetGivenTarget = (counts.targetGivenTarget[targetNextTargetKey] || 1) /
                (counts.target[targetPast] || 1);

            const pJoint = count / total;

            if (pTargetGivenBoth > 0 && pTargetGivenTarget > 0) {
                te += pJoint * Math.log2(pTargetGivenBoth / pTargetGivenTarget);
            }
        });

        return {
            transferEntropy: Math.max(0, te),
            normalized: Math.min(1, te / Math.log2(10)),
            interpretation: te > 0.1 ? 'significant_transfer' :
                te > 0.01 ? 'weak_transfer' : 'no_transfer',
        };
    }

    // ====================================================================
    // KERNEL-SMOOTHED HAZARD RATE ESTIMATION
    // ====================================================================

    /**
     * Adaptive bandwidth kernel-smoothed hazard rate estimation
     */
    kernelSmoothedHazard(runLengths, targetLength, bandwidth = null) {
        if (!runLengths || runLengths.length < 20) {
            return 0.1;
        }

        const bw = bandwidth || this._computeOptimalBandwidth(runLengths);
        return this._kernelSmoothedHazardInternal(runLengths, targetLength, bw);
    }

    _kernelSmoothedHazardInternal(runLengths, targetLength, bandwidth) {
        // Epanechnikov kernel (optimal in MSE sense)
        const epanechnikovKernel = (u) => {
            return Math.abs(u) <= 1 ? 0.75 * (1 - u * u) : 0;
        };

        // Gaussian kernel for comparison
        const gaussianKernel = (u) => Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);

        let numerator = 0;
        let denominator = 0;

        runLengths.forEach(l => {
            const u = (targetLength - l) / bandwidth;
            const k = gaussianKernel(u);

            if (l === targetLength || Math.abs(l - targetLength) < 0.5) {
                numerator += k;
            }
            if (l >= targetLength) {
                denominator += k;
            }
        });

        return denominator > 0 ? numerator / denominator : 0.1;
    }

    /**
     * Compute hazard function at multiple points
     */
    computeHazardFunction(asset, runLengths, evalPoints = null) {
        if (!runLengths || runLengths.length < 20) return null;

        const maxRun = Math.max(...runLengths);
        const bandwidth = this._computeOptimalBandwidth(runLengths);

        if (!evalPoints) {
            evalPoints = [];
            for (let t = 1; t <= maxRun; t++) {
                evalPoints.push(t);
            }
        }

        const hazardFunction = evalPoints.map(t => ({
            time: t,
            hazard: this._kernelSmoothedHazardInternal(runLengths, t, bandwidth),
        }));

        // Find increasing/decreasing hazard (IFR/DFR)
        let increasing = 0;
        let decreasing = 0;
        for (let i = 1; i < hazardFunction.length; i++) {
            if (hazardFunction[i].hazard > hazardFunction[i - 1].hazard) increasing++;
            else decreasing++;
        }

        const hazardShape = increasing > decreasing * 1.5 ? 'increasing' :
            decreasing > increasing * 1.5 ? 'decreasing' : 'bathtub_or_flat';

        this.hazardRates[asset] = {
            function: hazardFunction,
            shape: hazardShape,
            bandwidth,
            maxHazard: Math.max(...hazardFunction.map(h => h.hazard)),
            meanHazard: hazardFunction.reduce((a, h) => a + h.hazard, 0) / hazardFunction.length,
        };

        return this.hazardRates[asset];
    }

    // ====================================================================
    // EXTREME VALUE THEORY
    // ====================================================================

    /**
     * Block Maxima approach with GEV distribution fitting
     */
    fitExtremeValueModel(asset, runLengths) {
        if (!runLengths || runLengths.length < 30) return null;

        const blockSize = this.config.evtBlockSize;
        const numBlocks = Math.floor(runLengths.length / blockSize);

        if (numBlocks < 5) return null;

        // Extract block maxima and minima
        const blockMaxima = [];
        const blockMinima = [];

        for (let i = 0; i < numBlocks; i++) {
            const block = runLengths.slice(i * blockSize, (i + 1) * blockSize);
            blockMaxima.push(Math.max(...block));
            blockMinima.push(Math.min(...block));
        }

        // Fit GEV to maxima using method of moments
        const gevMaxima = this._fitGEV(blockMaxima);

        // Fit GEV to minima (reversed)
        const gevMinima = this._fitGEV(blockMinima);

        // Compute return levels
        const returnLevels = {};
        [5, 10, 20, 50, 100].forEach(period => {
            returnLevels[period] = this._gevReturnLevel(gevMaxima, period);
        });

        // Probability of exceeding threshold
        const thresholdProbs = {};
        [5, 10, 20, 30, 50].forEach(threshold => {
            thresholdProbs[threshold] = this._gevExceedanceProb(gevMaxima, threshold);
        });

        this.evtModels[asset] = {
            maxima: {
                params: gevMaxima,
                blockMaxima,
            },
            minima: {
                params: gevMinima,
                blockMinima,
            },
            returnLevels,
            thresholdProbs,
            blockSize,
            numBlocks,
        };

        return this.evtModels[asset];
    }

    /**
     * Fit GEV distribution using probability-weighted moments
     */
    _fitGEV(data) {
        const n = data.length;
        const sorted = [...data].sort((a, b) => a - b);

        // Probability-weighted moments
        let b0 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i < n; i++) {
            const pi = (i + 0.35) / n;
            b0 += sorted[i];
            b1 += pi * sorted[i];
            b2 += pi * (1 - pi) * sorted[i]; // Simplified L-moment estimate
        }
        b0 /= n;
        b1 /= n;
        b2 /= n;

        // L-moments
        const l1 = b0;
        const l2 = 2 * b1 - b0;
        const l3 = 6 * b2 - 6 * b1 + b0; // Approximate

        // Estimate GEV parameters
        const t3 = l2 !== 0 ? l3 / l2 : 0;

        // Shape parameter (xi) estimate
        let xi;
        if (Math.abs(t3) < 0.01) {
            xi = 0; // Gumbel
        } else {
            // Approximate using L-moment ratios
            xi = -t3 * 0.5; // Simplified
            xi = Math.max(-0.5, Math.min(0.5, xi));
        }

        // Scale parameter (sigma)
        let sigma;
        if (Math.abs(xi) < 0.01) {
            sigma = l2 / Math.LN2;
        } else {
            sigma = l2 * Math.abs(xi) / (this._gamma(1 + xi) * (1 - Math.pow(2, -xi)));
            sigma = Math.max(0.1, sigma);
        }

        // Location parameter (mu)
        const mu = l1 - sigma * (this._gamma(1 + xi) - 1) / xi;

        return {
            xi,  // shape
            sigma, // scale
            mu, // location
            type: Math.abs(xi) < 0.05 ? 'Gumbel' :
                xi > 0 ? 'Frechet' : 'Weibull',
        };
    }

    /**
     * GEV return level for a given return period
     */
    _gevReturnLevel(params, period) {
        const { xi, sigma, mu } = params;
        const yp = -Math.log(1 - 1 / period);

        if (Math.abs(xi) < 0.01) {
            // Gumbel
            return mu - sigma * Math.log(yp);
        } else {
            return mu + (sigma / xi) * (Math.pow(yp, -xi) - 1);
        }
    }

    /**
     * GEV exceedance probability P(X > x)
     */
    _gevExceedanceProb(params, x) {
        const { xi, sigma, mu } = params;
        const t = (x - mu) / sigma;

        if (Math.abs(xi) < 0.01) {
            // Gumbel
            return 1 - Math.exp(-Math.exp(-t));
        } else {
            const inner = 1 + xi * t;
            if (inner <= 0) return xi > 0 ? 0 : 1;
            return 1 - Math.exp(-Math.pow(inner, -1 / xi));
        }
    }

    // ====================================================================
    // MIXTURE MODEL (EM ALGORITHM)
    // ====================================================================

    /**
     * Fit Gaussian Mixture Model to run length distribution
     * Useful for identifying distinct regimes in run lengths
     */
    fitMixtureModel(asset, runLengths, numComponents = null) {
        if (!runLengths || runLengths.length < 30) return null;

        const K = numComponents || this._estimateOptimalComponents(runLengths);
        const n = runLengths.length;
        const data = [...runLengths];

        // Initialize parameters using k-means++ inspired approach
        const params = this._initializeMixtureParams(data, K);

        let prevLogLikelihood = -Infinity;
        let converged = false;

        for (let iter = 0; iter < this.config.mixtureMaxIterations; iter++) {
            // E-step: compute responsibilities
            const responsibilities = new Array(n);

            for (let i = 0; i < n; i++) {
                responsibilities[i] = new Array(K);
                let total = 0;

                for (let k = 0; k < K; k++) {
                    const prob = params.weights[k] *
                        this._gaussianPDF(data[i], params.means[k], params.variances[k]);
                    responsibilities[i][k] = prob;
                    total += prob;
                }

                // Normalize
                for (let k = 0; k < K; k++) {
                    responsibilities[i][k] = total > 0 ?
                        responsibilities[i][k] / total : 1 / K;
                }
            }

            // M-step: update parameters
            for (let k = 0; k < K; k++) {
                let nk = 0;
                let sumX = 0;
                let sumX2 = 0;

                for (let i = 0; i < n; i++) {
                    nk += responsibilities[i][k];
                    sumX += responsibilities[i][k] * data[i];
                }

                if (nk > 0.1) {
                    params.means[k] = sumX / nk;

                    for (let i = 0; i < n; i++) {
                        sumX2 += responsibilities[i][k] *
                            Math.pow(data[i] - params.means[k], 2);
                    }

                    params.variances[k] = Math.max(0.5, sumX2 / nk);
                    params.weights[k] = nk / n;
                }
            }

            // Normalize weights
            const weightSum = params.weights.reduce((a, b) => a + b, 0);
            params.weights = params.weights.map(w => w / weightSum);

            // Compute log-likelihood
            let logLikelihood = 0;
            for (let i = 0; i < n; i++) {
                let prob = 0;
                for (let k = 0; k < K; k++) {
                    prob += params.weights[k] *
                        this._gaussianPDF(data[i], params.means[k], params.variances[k]);
                }
                logLikelihood += Math.log(Math.max(1e-300, prob));
            }

            // Check convergence
            if (Math.abs(logLikelihood - prevLogLikelihood) < this.config.mixtureConvergenceTol) {
                converged = true;
                break;
            }
            prevLogLikelihood = logLikelihood;
        }

        // BIC for model selection
        const numParams = K * 3 - 1; // means + variances + weights - 1
        const bic = -2 * prevLogLikelihood + numParams * Math.log(n);

        // Sort components by mean
        const components = [];
        for (let k = 0; k < K; k++) {
            components.push({
                mean: params.means[k],
                variance: params.variances[k],
                std: Math.sqrt(params.variances[k]),
                weight: params.weights[k],
            });
        }
        components.sort((a, b) => a.mean - b.mean);

        // Classify current observation
        const classify = (x) => {
            let bestK = 0;
            let bestProb = 0;
            components.forEach((comp, k) => {
                const prob = comp.weight * this._gaussianPDF(x, comp.mean, comp.variance);
                if (prob > bestProb) {
                    bestProb = prob;
                    bestK = k;
                }
            });
            return { component: bestK, probability: bestProb };
        };

        this.mixtureModels[asset] = {
            components,
            numComponents: K,
            bic,
            logLikelihood: prevLogLikelihood,
            converged,
            classify,
            isMultiModal: K > 1 && components.every(c => c.weight > 0.1),
        };

        return this.mixtureModels[asset];
    }

    _initializeMixtureParams(data, K) {
        const n = data.length;
        const sorted = [...data].sort((a, b) => a - b);

        const means = [];
        const variances = [];
        const weights = [];

        // Initialize means using quantiles
        for (let k = 0; k < K; k++) {
            const idx = Math.floor((k + 0.5) * n / K);
            means.push(sorted[idx]);
            variances.push(
                data.reduce((a, b) => a + (b - sorted[idx]) ** 2, 0) / n / K
            );
            weights.push(1 / K);
        }

        return { means, variances, weights };
    }

    _estimateOptimalComponents(data) {
        // Simple heuristic based on multimodality
        const n = data.length;
        const mean = data.reduce((a, b) => a + b, 0) / n;
        const std = Math.sqrt(data.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
        const cv = std / (mean || 1);
        const skewness = data.reduce((a, b) => a + Math.pow((b - mean) / (std || 1), 3), 0) / n;

        if (cv > 1.5 || Math.abs(skewness) > 2) return 3;
        if (cv > 0.8 || Math.abs(skewness) > 1) return 2;
        return Math.min(this.config.mixtureMaxComponents, 2);
    }

    _gaussianPDF(x, mean, variance) {
        const std = Math.sqrt(Math.max(1e-10, variance));
        const z = (x - mean) / std;
        return Math.exp(-0.5 * z * z) / (std * Math.sqrt(2 * Math.PI));
    }

    // ====================================================================
    // SEQUENTIAL PROBABILITY RATIO TEST (SPRT)
    // ====================================================================

    /**
     * SPRT for detecting if survival probability has shifted
     * Tests H0: p = p0 vs H1: p = p1
     */
    initSPRT(asset, p0 = 0.5, p1 = 0.7) {
        this.sprtState[asset] = {
            p0,
            p1,
            logLikelihoodRatio: 0,
            upperBound: Math.log((1 - this.config.sprtBeta) / this.config.sprtAlpha),
            lowerBound: Math.log(this.config.sprtBeta / (1 - this.config.sprtAlpha)),
            decision: 'continue',
            observations: 0,
            history: [],
        };
    }

    updateSPRT(asset, survived) {
        if (!this.sprtState[asset]) {
            this.initSPRT(asset);
        }

        const state = this.sprtState[asset];
        const { p0, p1 } = state;

        // Log likelihood ratio increment
        const x = survived ? 1 : 0;
        const increment = x * Math.log(p1 / p0) + (1 - x) * Math.log((1 - p1) / (1 - p0));

        state.logLikelihoodRatio += increment;
        state.observations++;

        // Decision
        if (state.logLikelihoodRatio >= state.upperBound) {
            state.decision = 'reject_H0'; // Evidence for H1 (higher survival)
        } else if (state.logLikelihoodRatio <= state.lowerBound) {
            state.decision = 'accept_H0'; // Evidence for H0 (base rate)
        } else {
            state.decision = 'continue';
        }

        state.history.push({
            llr: state.logLikelihoodRatio,
            decision: state.decision,
            survived,
        });

        if (state.history.length > 200) {
            state.history = state.history.slice(-150);
        }

        return {
            decision: state.decision,
            logLikelihoodRatio: state.logLikelihoodRatio,
            upperBound: state.upperBound,
            lowerBound: state.lowerBound,
            observations: state.observations,
            strengthOfEvidence: Math.abs(state.logLikelihoodRatio) /
                Math.max(Math.abs(state.upperBound), Math.abs(state.lowerBound)),
        };
    }

    /**
     * Reset SPRT after a decision is made
     */
    resetSPRT(asset) {
        if (this.sprtState[asset]) {
            const { p0, p1 } = this.sprtState[asset];
            this.initSPRT(asset, p0, p1);
        }
    }

    // ====================================================================
    // RANK CORRELATION ANALYSIS
    // ====================================================================

    /**
     * Spearman Rank Correlation between run lengths and time
     */
    spearmanCorrelation(x, y) {
        if (!x || !y || x.length !== y.length || x.length < 10) {
            return { rho: 0, pValue: 1, significant: false };
        }

        const n = x.length;
        const rankX = this._computeRanks(x);
        const rankY = this._computeRanks(y);

        // Pearson correlation on ranks
        let sumD2 = 0;
        for (let i = 0; i < n; i++) {
            sumD2 += Math.pow(rankX[i] - rankY[i], 2);
        }

        const rho = 1 - (6 * sumD2) / (n * (n * n - 1));

        // Approximate t-test for significance
        const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
        const df = n - 2;
        const pValue = 2 * (1 - this._tDistCDF(Math.abs(t), df));

        return {
            rho,
            pValue,
            significant: pValue < 0.05,
            interpretation: rho > 0.3 ? 'positive_trend' :
                rho < -0.3 ? 'negative_trend' : 'no_trend',
        };
    }

    /**
     * Kendall Tau correlation (more robust than Spearman)
     */
    kendallTau(x, y) {
        if (!x || !y || x.length !== y.length || x.length < 10) {
            return { tau: 0, pValue: 1, significant: false };
        }

        const n = x.length;
        let concordant = 0;
        let discordant = 0;

        for (let i = 0; i < n - 1; i++) {
            for (let j = i + 1; j < n; j++) {
                const xDiff = x[j] - x[i];
                const yDiff = y[j] - y[i];

                if (xDiff * yDiff > 0) concordant++;
                else if (xDiff * yDiff < 0) discordant++;
            }
        }

        const totalPairs = n * (n - 1) / 2;
        const tau = (concordant - discordant) / totalPairs;

        // Significance test
        const variance = (2 * (2 * n + 5)) / (9 * n * (n - 1));
        const z = tau / Math.sqrt(variance);
        const pValue = 2 * (1 - this._normalCDF(Math.abs(z)));

        return {
            tau,
            pValue,
            significant: pValue < 0.05,
            concordant,
            discordant,
            interpretation: tau > 0.2 ? 'positive_association' :
                tau < -0.2 ? 'negative_association' : 'no_association',
        };
    }

    /**
     * Compute run length trend correlation
     */
    computeRunLengthTrend(asset, runLengths) {
        if (!runLengths || runLengths.length < 10) return null;

        const indices = runLengths.map((_, i) => i);

        const spearman = this.spearmanCorrelation(indices, runLengths);
        const kendall = this.kendallTau(indices, runLengths);

        this.rankCorrelations[asset] = {
            spearman,
            kendall,
            overallTrend: (spearman.rho + kendall.tau) / 2 > 0.15 ? 'increasing' :
                (spearman.rho + kendall.tau) / 2 < -0.15 ? 'decreasing' : 'stable',
        };

        return this.rankCorrelations[asset];
    }

    // ====================================================================
    // COX PROPORTIONAL HAZARDS (SIMPLIFIED)
    // ====================================================================

    /**
     * Simplified Cox PH model with a single covariate
     * Estimates how a covariate affects the hazard rate
     */
    fitCoxModel(asset, runLengths, covariates) {
        if (!runLengths || !covariates || runLengths.length < 20 ||
            runLengths.length !== covariates.length) return null;

        const n = runLengths.length;

        // Newton-Raphson for partial likelihood maximization (simplified)
        let beta = 0;
        const maxIter = 20;
        const tol = 1e-6;

        for (let iter = 0; iter < maxIter; iter++) {
            let score = 0;
            let information = 0;

            // Sort by event time
            const sorted = runLengths.map((l, i) => ({ time: l, x: covariates[i] }))
                .sort((a, b) => a.time - b.time);

            for (let i = 0; i < n; i++) {
                const ti = sorted[i].time;
                const xi = sorted[i].x;

                // Risk set at time ti
                let s0 = 0, s1 = 0, s2 = 0;
                for (let j = i; j < n; j++) {
                    const xj = sorted[j].x;
                    const expBX = Math.exp(Math.min(100, beta * xj));
                    s0 += expBX;
                    s1 += xj * expBX;
                    s2 += xj * xj * expBX;
                }

                if (s0 > 0) {
                    score += xi - s1 / s0;
                    information += s2 / s0 - (s1 / s0) * (s1 / s0);
                }
            }

            // Newton-Raphson update
            if (information > 0) {
                const update = score / information;
                beta += update;
                if (Math.abs(update) < tol) break;
            }
        }

        // Hazard ratio
        const hazardRatio = Math.exp(beta);

        // Wald test
        const seBeta = 1 / Math.sqrt(Math.max(0.01, information || 1));
        const zStat = beta / seBeta;
        const pValue = 2 * (1 - this._normalCDF(Math.abs(zStat)));

        this.coxModels[asset] = {
            beta,
            hazardRatio,
            standardError: seBeta,
            zStatistic: zStat,
            pValue,
            significant: pValue < 0.05,
            interpretation: hazardRatio > 1.2 ? 'covariate_increases_hazard' :
                hazardRatio < 0.8 ? 'covariate_decreases_hazard' : 'no_effect',
        };

        return this.coxModels[asset];
    }

    // ====================================================================
    // COMPREHENSIVE STATISTICAL ANALYSIS
    // ====================================================================

    /**
     * Run all statistical analyses and return comprehensive report
     */
    getComprehensiveStatisticalReport(asset, runLengths, tickHistory, targetLength) {
        const report = {
            asset,
            timestamp: Date.now(),
            targetLength,
        };

        // Kaplan-Meier
        if (runLengths && runLengths.length >= 10) {
            report.kaplanMeier = this.kaplanMeierEstimate(runLengths, targetLength);
        }

        // Nelson-Aalen
        if (runLengths && runLengths.length >= 10) {
            report.nelsonAalen = this.nelsonAalenHazard(runLengths, targetLength);
        }

        // Bayesian
        report.bayesian = this.getBayesianEstimate(asset);

        // Bootstrap
        if (runLengths && runLengths.length >= 15) {
            report.bootstrap = this.bootstrapSurvival(runLengths, targetLength, 100);
        }

        // EWMA stats
        report.ewma = this.getEWMStats(asset);

        // Kernel-smoothed hazard
        if (runLengths && runLengths.length >= 20) {
            report.smoothedHazard = this.kernelSmoothedHazard(runLengths, targetLength);
        }

        // KDE
        if (runLengths && runLengths.length >= 15) {
            const kde = this.kernelDensityEstimate(asset, runLengths);
            if (kde) {
                report.kde = {
                    isMultiModal: kde.isMultiModal,
                    numModes: kde.numModes,
                    primaryMode: kde.primaryMode,
                    bandwidth: kde.bandwidth,
                    densityAtTarget: this.evaluateKDE(asset, targetLength),
                };
            }
        }

        // Entropy
        if (tickHistory && tickHistory.length >= 10) {
            report.entropy = {
                shannon: this.calculateEntropy(tickHistory),
                renyi2: this.renyiEntropy(tickHistory, 2),
                conditional: this.calculateConditionalEntropy(tickHistory, 2),
            };
        }

        // SPRT
        if (this.sprtState[asset]) {
            report.sprt = {
                decision: this.sprtState[asset].decision,
                llr: this.sprtState[asset].logLikelihoodRatio,
                observations: this.sprtState[asset].observations,
            };
        }

        // Rank correlations
        if (runLengths && runLengths.length >= 10) {
            report.trend = this.computeRunLengthTrend(asset, runLengths);
        }

        // Mixture model
        if (this.mixtureModels[asset]) {
            const mm = this.mixtureModels[asset];
            report.mixture = {
                numComponents: mm.numComponents,
                isMultiModal: mm.isMultiModal,
                components: mm.components.map(c => ({
                    mean: c.mean.toFixed(1),
                    std: c.std.toFixed(1),
                    weight: (c.weight * 100).toFixed(1) + '%',
                })),
            };
        }

        // Extreme value model
        if (this.evtModels[asset]) {
            report.evt = {
                type: this.evtModels[asset].maxima.params.type,
                returnLevels: this.evtModels[asset].returnLevels,
            };
        }

        // Composite survival score
        report.compositeScore = this._computeCompositeSurvivalScore(report);

        return report;
    }

    /**
     * Compute composite survival score from all statistical analyses
     */
    _computeCompositeSurvivalScore(report) {
        let score = 0;
        let totalWeight = 0;

        // Kaplan-Meier
        if (report.kaplanMeier) {
            const km = report.kaplanMeier;
            const weight = 3.0 * Math.min(1, km.sampleSize / 50);
            score += km.survival * weight;
            totalWeight += weight;
        }

        // Nelson-Aalen
        if (report.nelsonAalen) {
            const na = report.nelsonAalen;
            const weight = 2.5;
            score += na.survivalFromHazard * weight;
            totalWeight += weight;

            // Penalize if smoothed hazard is high
            if (na.smoothedHazardRate > 0.2) {
                score -= (na.smoothedHazardRate - 0.2) * weight * 0.5;
            }
        }

        // Bayesian
        if (report.bayesian) {
            const bay = report.bayesian;
            const weight = 2.0 * Math.min(1, bay.confidence / 30);
            score += bay.mean * weight;
            totalWeight += weight;

            // Bonus for strong predictions
            if (bay.predictionStrength === 'strong' || bay.predictionStrength === 'very_strong') {
                score += 0.1 * weight;
            }
        }

        // Bootstrap
        if (report.bootstrap) {
            const boot = report.bootstrap;
            const weight = 2.0;
            score += boot.mean * weight;
            totalWeight += weight;

            // Penalize wide confidence intervals (high uncertainty)
            const ciWidth = boot.ci_upper - boot.ci_lower;
            if (ciWidth > 0.3) {
                score -= (ciWidth - 0.3) * weight * 0.3;
            }
        }

        // Entropy (lower = more predictable = better)
        if (report.entropy) {
            const ent = report.entropy;
            const predictability = 1 - ent.conditional;
            const weight = 1.0;
            score += predictability * weight * 0.7;
            totalWeight += weight;
        }

        // EWMA (current state relative to average)
        if (report.ewma && report.ewma.mean !== null) {
            const ewma = report.ewma;
            // If current average is healthy (not extreme), that's good
            const zAdjusted = 1 / (1 + Math.exp(-0.5 * (ewma.mean - 5))); // Sigmoid transform
            score += zAdjusted * 1.0;
            totalWeight += 1.0;
        }

        // Smoothed hazard (lower = safer)
        if (report.smoothedHazard !== undefined) {
            const safetyScore = Math.max(0, 1 - report.smoothedHazard * 3);
            score += safetyScore * 1.5;
            totalWeight += 1.5;
        }

        // SPRT
        if (report.sprt && report.sprt.decision !== 'continue') {
            if (report.sprt.decision === 'reject_H0') {
                // Evidence for higher survival
                score += 0.7 * 0.5;
            } else {
                // Evidence for base rate (not great)
                score += 0.4 * 0.5;
            }
            totalWeight += 0.5;
        }

        // Trend (improving is good)
        if (report.trend && report.trend.overallTrend) {
            const trendScore = report.trend.overallTrend === 'increasing' ? 0.7 :
                report.trend.overallTrend === 'decreasing' ? 0.3 : 0.5;
            score += trendScore * 0.8;
            totalWeight += 0.8;
        }

        return totalWeight > 0 ? Math.max(0, Math.min(1, score / totalWeight)) : 0.5;
    }

    // ====================================================================
    // HELPER METHODS
    // ====================================================================

    _computeDistribution(arr) {
        const dist = {};
        arr.forEach(v => { dist[v] = (dist[v] || 0) + 1 / arr.length; });
        return dist;
    }

    _computeRanks(arr) {
        const indexed = arr.map((v, i) => ({ value: v, index: i }));
        indexed.sort((a, b) => a.value - b.value);

        const ranks = new Array(arr.length);
        let i = 0;
        while (i < indexed.length) {
            let j = i;
            while (j < indexed.length - 1 && indexed[j + 1].value === indexed[j].value) {
                j++;
            }
            // Average rank for ties
            const avgRank = (i + j) / 2 + 1;
            for (let k = i; k <= j; k++) {
                ranks[indexed[k].index] = avgRank;
            }
            i = j + 1;
        }

        return ranks;
    }

    _discretizeContinuous(value) {
        if (value < -1) return 'very_low';
        if (value < -0.3) return 'low';
        if (value < 0.3) return 'medium';
        if (value < 1) return 'high';
        return 'very_high';
    }

    _normalCDF(x) {
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const p = 0.3275911;

        const sign = x >= 0 ? 1 : -1;
        x = Math.abs(x) / Math.SQRT2;

        const t = 1.0 / (1.0 + p * x);
        const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

        return 0.5 * (1.0 + sign * y);
    }

    _normalQuantile(p) {
        // Rational approximation for the inverse normal CDF
        if (p <= 0) return -5;
        if (p >= 1) return 5;
        if (p === 0.5) return 0;

        const a = [
            -3.969683028665376e+01, 2.209460984245205e+02,
            -2.759285104469687e+02, 1.383577518672690e+02,
            -3.066479806614716e+01, 2.506628277459239e+00
        ];
        const b = [
            -5.447609879822406e+01, 1.615858368580409e+02,
            -1.556989798598866e+02, 6.680131188771972e+01,
            -1.328068155288572e+01
        ];

        const pLow = 0.02425;
        const pHigh = 1 - pLow;

        let q, r;

        if (p < pLow) {
            q = Math.sqrt(-2 * Math.log(p));
            return (((((a[0] * q + a[1]) * q + a[2]) * q + a[3]) * q + a[4]) * q + a[5]) /
                ((((b[0] * q + b[1]) * q + b[2]) * q + b[3]) * q + b[4] + 1);
        } else if (p <= pHigh) {
            q = p - 0.5;
            r = q * q;
            return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
                (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
        } else {
            q = Math.sqrt(-2 * Math.log(1 - p));
            return -(((((a[0] * q + a[1]) * q + a[2]) * q + a[3]) * q + a[4]) * q + a[5]) /
                ((((b[0] * q + b[1]) * q + b[2]) * q + b[3]) * q + b[4] + 1);
        }
    }

    _chiSquaredCDF(x, k) {
        // Approximation for chi-squared CDF
        if (x <= 0) return 0;
        return this._regularizedGammaP(k / 2, x / 2);
    }

    _regularizedGammaP(a, x) {
        // Series expansion for lower incomplete gamma
        if (x < a + 1) {
            let sum = 1 / a;
            let term = 1 / a;
            for (let n = 1; n < 100; n++) {
                term *= x / (a + n);
                sum += term;
                if (Math.abs(term) < 1e-10) break;
            }
            return sum * Math.exp(-x + a * Math.log(x) - this._logGamma(a));
        } else {
            // Continued fraction
            return 1 - this._regularizedGammaQ(a, x);
        }
    }

    _regularizedGammaQ(a, x) {
        // Continued fraction for upper incomplete gamma
        let f = 1 + x - a;
        let c = 1 / 1e-30;
        let d = 1 / f;
        let h = d;

        for (let n = 1; n < 100; n++) {
            const an = n * (a - n);
            const bn = 2 * n + 1 + x - a;

            d = bn + an * d;
            if (Math.abs(d) < 1e-30) d = 1e-30;
            c = bn + an / c;
            if (Math.abs(c) < 1e-30) c = 1e-30;

            d = 1 / d;
            const delta = d * c;
            h *= delta;

            if (Math.abs(delta - 1) < 1e-10) break;
        }

        return Math.exp(-x + a * Math.log(x) - this._logGamma(a)) * h;
    }

    _logGamma(z) {
        const c = [
            76.18009172947146, -86.50532032941677,
            24.01409824083091, -1.231739572450155,
            0.1208650973866179e-2, -0.5395239384953e-5
        ];

        let x = z;
        let y = z;
        let tmp = x + 5.5;
        tmp -= (x + 0.5) * Math.log(tmp);
        let ser = 1.000000000190015;

        for (let j = 0; j < 6; j++) {
            y++;
            ser += c[j] / y;
        }

        return -tmp + Math.log(2.5066282746310005 * ser / x);
    }

    _gamma(z) {
        return Math.exp(this._logGamma(z));
    }

    _tDistCDF(t, df) {
        // Approximation using normal for large df
        if (df > 30) return this._normalCDF(t);

        const x = df / (df + t * t);
        return 1 - 0.5 * this._regularizedBeta(x, df / 2, 0.5);
    }

    _regularizedBeta(x, a, b) {
        // Simplified incomplete beta using series expansion
        if (x === 0) return 0;
        if (x === 1) return 1;

        const lnBeta = this._logGamma(a) + this._logGamma(b) - this._logGamma(a + b);
        const prefix = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnBeta) / a;

        // Continued fraction
        let sum = 1;
        let term = 1;
        for (let n = 1; n < 100; n++) {
            term *= (n - b) * x / (a + n);
            sum += term;
            if (Math.abs(term) < 1e-10) break;
        }

        return Math.min(1, Math.max(0, prefix * sum));
    }
}

// ============================================================================
// TIER 2: ADVANCED PATTERN RECOGNITION ENGINE
// ============================================================================

class PatternEngine {
    constructor() {
        // N-Gram models with multiple orders
        this.ngramModels = {};
        this.ngramModelStats = {};

        // Markov Chain models
        this.markovChains = {};
        this.markovSteadyStates = {};

        // Run length models
        this.runLengthModels = {};

        // Regime detection
        this.regimeStates = {};
        this.regimeHistory = {};
        this.regimeTransitionMatrix = {};

        // Motif discovery cache
        this.discoveredMotifs = {};
        this.motifOccurrences = {};

        // Change point detection
        this.changePoints = {};
        this.cusumState = {};

        // Autocorrelation cache
        this.autocorrelations = {};

        // Sequential pattern mining
        this.frequentPatterns = {};
        this.patternSupport = {};

        // Fractal analysis
        this.fractalDimensions = {};
        this.hurstExponents = {};

        // Performance tracking
        this.predictionAccuracy = {};
        this.modelConfidence = {};

        // Configuration
        this.config = {
            maxNgramOrder: 6,
            maxMarkovOrder: 4,
            motifMinLength: 3,
            motifMaxLength: 8,
            changePointThreshold: 3.0,
            minPatternSupport: 0.02,
            autocorrMaxLag: 30,
            regimeWindowSize: 25,
            regimeHistorySize: 50,
        };
    }

    // ====================================================================
    // N-GRAM PATTERN ANALYZER (ENHANCED)
    // ====================================================================

    /**
     * Build N-Gram models with multiple orders and track statistics
     * Uses modified Kneser-Ney-inspired smoothing for better probability estimates
     */
    buildNgramModel(asset, sequence, maxOrder = null) {
        const order = maxOrder || this.config.maxNgramOrder;

        if (!sequence || sequence.length < order + 20) return;

        this.ngramModels[asset] = {};
        this.ngramModelStats[asset] = {};

        for (let n = 1; n <= order; n++) {
            this.ngramModels[asset][n] = {};
            let totalContexts = 0;
            let totalUniqueNexts = 0;

            for (let i = n; i < sequence.length; i++) {
                const context = sequence.slice(i - n, i).join(',');
                const next = sequence[i];

                if (!this.ngramModels[asset][n][context]) {
                    this.ngramModels[asset][n][context] = {};
                    totalContexts++;
                }

                if (!this.ngramModels[asset][n][context][next]) {
                    totalUniqueNexts++;
                }

                this.ngramModels[asset][n][context][next] =
                    (this.ngramModels[asset][n][context][next] || 0) + 1;
            }

            // Calculate continuation counts for smoothing
            const continuationCounts = {};
            Object.entries(this.ngramModels[asset][n]).forEach(([context, nexts]) => {
                continuationCounts[context] = Object.keys(nexts).length;
            });

            this.ngramModelStats[asset][n] = {
                totalContexts,
                totalUniqueNexts,
                continuationCounts,
                sequenceLength: sequence.length,
            };
        }
    }

    /**
     * Predict next value using backoff smoothing across N-gram orders
     * Falls back to lower-order models when higher-order contexts are unseen
     */
    predictFromNgram(asset, recentSequence, maxOrder = null) {
        const order = maxOrder || this.config.maxNgramOrder;

        if (!this.ngramModels[asset]) return null;

        // Try from highest order down (backoff strategy)
        const aggregatedProbabilities = {};
        let bestOrder = 0;
        let bestConfidence = 0;
        let totalWeight = 0;

        for (let n = Math.min(order, recentSequence.length); n >= 1; n--) {
            if (!this.ngramModels[asset][n]) continue;

            const context = recentSequence.slice(-n).join(',');
            const predictions = this.ngramModels[asset][n][context];

            if (!predictions) continue;

            const total = Object.values(predictions).reduce((a, b) => a + b, 0);
            if (total < 3) continue; // Minimum sample requirement

            // Weight by order (higher order = more specific = higher weight)
            // But penalize if sample count is low
            const sampleWeight = Math.min(1, total / 20);
            const orderWeight = Math.pow(n, 1.5) * sampleWeight;

            Object.entries(predictions).forEach(([digit, count]) => {
                const prob = count / total;
                if (!aggregatedProbabilities[digit]) {
                    aggregatedProbabilities[digit] = 0;
                }
                aggregatedProbabilities[digit] += prob * orderWeight;
            });

            totalWeight += orderWeight;

            if (orderWeight > bestConfidence) {
                bestConfidence = orderWeight;
                bestOrder = n;
            }
        }

        if (totalWeight === 0) return null;

        // Normalize probabilities
        const normalizedProbs = {};
        Object.entries(aggregatedProbabilities).forEach(([digit, weightedProb]) => {
            normalizedProbs[digit] = weightedProb / totalWeight;
        });

        // Find most likely and compute entropy
        const sortedPredictions = Object.entries(normalizedProbs)
            .sort((a, b) => b[1] - a[1]);

        const topPrediction = sortedPredictions[0];
        const entropy = this._calculateDistributionEntropy(normalizedProbs);

        // Confidence based on: entropy (lower = more confident), sample size, order
        const maxEntropy = Math.log2(Object.keys(normalizedProbs).length || 10);
        const entropyConfidence = 1 - (entropy / maxEntropy);

        const confidence = Math.min(1,
            entropyConfidence * 0.4 +
            (bestOrder / order) * 0.3 +
            Math.min(1, bestConfidence / 5) * 0.3
        );

        return {
            digit: parseInt(topPrediction[0]),
            probability: topPrediction[1],
            distribution: normalizedProbs,
            sortedPredictions: sortedPredictions.slice(0, 5),
            entropy,
            confidence,
            bestOrder,
            confidenceLevel: confidence > 0.7 ? 'high' : confidence > 0.45 ? 'medium' : 'low',
        };
    }

    /**
     * Compute conditional surprise: how unexpected is the current observation?
     */
    computeSurprise(asset, recentSequence, observedDigit) {
        const prediction = this.predictFromNgram(asset, recentSequence.slice(0, -1));
        if (!prediction || !prediction.distribution) return 0.5;

        const expectedProb = prediction.distribution[observedDigit] || 0.01;
        const surprise = -Math.log2(Math.max(1e-10, expectedProb));

        // Normalize: max surprise for 10 digits is -log2(0.01) ≈ 6.64
        return Math.min(1, surprise / 7);
    }

    // ====================================================================
    // MARKOV CHAIN ANALYZER (ENHANCED)
    // ====================================================================

    /**
     * Build multi-order Markov chains with state discretization options
     */
    buildMarkovChain(asset, runLengths, maxOrder = null) {
        const order = maxOrder || this.config.maxMarkovOrder;

        if (!runLengths || runLengths.length < 25) return;

        this.markovChains[asset] = {};

        // Discretize run lengths into states
        const states = runLengths.map(l => this.discretizeRunLength(l));

        for (let n = 1; n <= order; n++) {
            this.markovChains[asset][n] = {
                transitions: {},
                stateCounts: {},
                totalTransitions: 0,
            };

            for (let i = n; i < states.length; i++) {
                const context = states.slice(i - n, i).join(',');
                const next = states[i];

                if (!this.markovChains[asset][n].transitions[context]) {
                    this.markovChains[asset][n].transitions[context] = {};
                }

                this.markovChains[asset][n].transitions[context][next] =
                    (this.markovChains[asset][n].transitions[context][next] || 0) + 1;

                this.markovChains[asset][n].stateCounts[context] =
                    (this.markovChains[asset][n].stateCounts[context] || 0) + 1;

                this.markovChains[asset][n].totalTransitions++;
            }
        }

        // Compute steady-state distribution for order 1
        this._computeSteadyState(asset);
    }

    /**
     * Finer-grained run length discretization
     */
    discretizeRunLength(length) {
        if (length <= 1) return 'micro';
        if (length <= 3) return 'very_short';
        if (length <= 6) return 'short';
        if (length <= 10) return 'medium_short';
        if (length <= 15) return 'medium';
        if (length <= 25) return 'medium_long';
        if (length <= 40) return 'long';
        if (length <= 60) return 'very_long';
        return 'extreme';
    }

    /**
     * Get numeric midpoint for a state (for scoring)
     */
    _stateToNumericMidpoint(state) {
        const midpoints = {
            'micro': 1,
            'very_short': 2,
            'short': 4.5,
            'medium_short': 8,
            'medium': 12.5,
            'medium_long': 20,
            'long': 32,
            'very_long': 50,
            'extreme': 70,
        };
        return midpoints[state] || 5;
    }

    /**
     * Predict next run state with confidence and expected duration
     */
    predictNextRunState(asset, recentRuns, order = null) {
        const maxOrder = order || this.config.maxMarkovOrder;

        if (!this.markovChains[asset]) return null;

        // Try multiple orders with backoff
        const aggregatedPredictions = {};
        let totalWeight = 0;

        for (let n = Math.min(maxOrder, recentRuns.length); n >= 1; n--) {
            if (!this.markovChains[asset][n]) continue;

            const recentStates = recentRuns.slice(-n).map(l => this.discretizeRunLength(l));
            const context = recentStates.join(',');
            const transitions = this.markovChains[asset][n].transitions[context];

            if (!transitions) continue;

            const contextCount = this.markovChains[asset][n].stateCounts[context];
            if (contextCount < 3) continue;

            const total = Object.values(transitions).reduce((a, b) => a + b, 0);
            const weight = Math.pow(n, 1.5) * Math.min(1, contextCount / 15);

            Object.entries(transitions).forEach(([state, count]) => {
                const prob = count / total;
                aggregatedPredictions[state] = (aggregatedPredictions[state] || 0) + prob * weight;
            });

            totalWeight += weight;
        }

        if (totalWeight === 0) return null;

        // Normalize
        const probabilities = {};
        Object.entries(aggregatedPredictions).forEach(([state, weightedProb]) => {
            probabilities[state] = weightedProb / totalWeight;
        });

        const sortedPredictions = Object.entries(probabilities)
            .sort((a, b) => b[1] - a[1]);

        // Calculate expected run length from distribution
        let expectedRunLength = 0;
        Object.entries(probabilities).forEach(([state, prob]) => {
            expectedRunLength += this._stateToNumericMidpoint(state) * prob;
        });

        // Calculate variance of prediction
        let varianceRunLength = 0;
        Object.entries(probabilities).forEach(([state, prob]) => {
            varianceRunLength += Math.pow(this._stateToNumericMidpoint(state) - expectedRunLength, 2) * prob;
        });

        return {
            predictions: probabilities,
            mostLikely: sortedPredictions[0],
            sortedPredictions,
            expectedRunLength,
            stdRunLength: Math.sqrt(varianceRunLength),
            confidence: totalWeight,
            entropy: this._calculateDistributionEntropy(probabilities),
        };
    }

    /**
     * Compute steady-state distribution of Markov chain
     * Uses power iteration method
     */
    _computeSteadyState(asset) {
        if (!this.markovChains[asset] || !this.markovChains[asset][1]) return;

        const transitions = this.markovChains[asset][1].transitions;
        const states = [...new Set([
            ...Object.keys(transitions),
            ...Object.values(transitions).flatMap(t => Object.keys(t))
        ])];

        if (states.length === 0) return;

        const n = states.length;
        const stateIndex = {};
        states.forEach((s, i) => stateIndex[s] = i);

        // Build transition matrix
        const matrix = Array.from({ length: n }, () => new Array(n).fill(0));

        Object.entries(transitions).forEach(([from, tos]) => {
            const fromIdx = stateIndex[from];
            const total = Object.values(tos).reduce((a, b) => a + b, 0);
            Object.entries(tos).forEach(([to, count]) => {
                if (stateIndex[to] !== undefined) {
                    matrix[fromIdx][stateIndex[to]] = count / total;
                }
            });
        });

        // Power iteration (50 iterations)
        let distribution = new Array(n).fill(1 / n);

        for (let iter = 0; iter < 50; iter++) {
            const newDist = new Array(n).fill(0);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    newDist[j] += distribution[i] * matrix[i][j];
                }
            }
            // Normalize
            const sum = newDist.reduce((a, b) => a + b, 0);
            if (sum > 0) {
                for (let i = 0; i < n; i++) newDist[i] /= sum;
            }
            distribution = newDist;
        }

        this.markovSteadyStates[asset] = {};
        states.forEach((s, i) => {
            this.markovSteadyStates[asset][s] = distribution[i];
        });
    }

    /**
     * Detect if current state deviates from steady state
     * Returns deviation score (higher = more anomalous)
     */
    getSteadyStateDeviation(asset, recentRuns, windowSize = 20) {
        if (!this.markovSteadyStates[asset] || !recentRuns || recentRuns.length < windowSize) {
            return { deviation: 0, details: {} };
        }

        const recent = recentRuns.slice(-windowSize);
        const states = recent.map(l => this.discretizeRunLength(l));

        // Observed state frequency
        const observed = {};
        states.forEach(s => { observed[s] = (observed[s] || 0) + 1; });
        Object.keys(observed).forEach(s => { observed[s] /= states.length; });

        // Chi-squared-like deviation
        let totalDeviation = 0;
        const details = {};

        Object.entries(this.markovSteadyStates[asset]).forEach(([state, expected]) => {
            const obs = observed[state] || 0;
            if (expected > 0.01) {
                const deviation = Math.pow(obs - expected, 2) / expected;
                totalDeviation += deviation;
                details[state] = {
                    observed: obs.toFixed(3),
                    expected: expected.toFixed(3),
                    deviation: deviation.toFixed(3),
                };
            }
        });

        return { deviation: totalDeviation, details };
    }

    // ====================================================================
    // MOTIF DISCOVERY ENGINE
    // ====================================================================

    /**
     * Discover recurring motifs (subsequences) in the data
     * Uses frequency counting with sliding window
     */
    discoverMotifs(asset, sequence, minLength = null, maxLength = null) {
        const minLen = minLength || this.config.motifMinLength;
        const maxLen = maxLength || this.config.motifMaxLength;

        if (!sequence || sequence.length < maxLen + 20) return;

        this.discoveredMotifs[asset] = {};
        this.motifOccurrences[asset] = {};

        const seqLength = sequence.length;
        const minCount = Math.max(3, Math.floor(seqLength * this.config.minPatternSupport));

        for (let len = minLen; len <= maxLen; len++) {
            const patternCounts = {};
            const patternPositions = {};

            for (let i = 0; i <= seqLength - len; i++) {
                const pattern = sequence.slice(i, i + len).join(',');

                patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;

                if (!patternPositions[pattern]) patternPositions[pattern] = [];
                patternPositions[pattern].push(i);
            }

            // Filter by minimum support
            Object.entries(patternCounts).forEach(([pattern, count]) => {
                if (count >= minCount) {
                    const support = count / (seqLength - len + 1);
                    const positions = patternPositions[pattern];

                    // Calculate average gap between occurrences
                    let avgGap = 0;
                    if (positions.length > 1) {
                        for (let i = 1; i < positions.length; i++) {
                            avgGap += positions[i] - positions[i - 1];
                        }
                        avgGap /= (positions.length - 1);
                    }

                    // Check if pattern appeared recently (within last 20% of sequence)
                    const recentThreshold = Math.floor(seqLength * 0.8);
                    const recentOccurrences = positions.filter(p => p >= recentThreshold).length;
                    const isRecent = recentOccurrences > 0;

                    this.discoveredMotifs[asset][pattern] = {
                        count,
                        support,
                        length: len,
                        avgGap,
                        isRecent,
                        recentOccurrences,
                        lastPosition: positions[positions.length - 1],
                    };

                    this.motifOccurrences[asset][pattern] = positions;
                }
            });
        }

        return this.discoveredMotifs[asset];
    }

    /**
     * Check if current sequence matches any discovered motifs
     * and predict what typically follows the motif
     */
    matchMotifAndPredict(asset, sequence, recentWindow) {
        if (!this.discoveredMotifs[asset] || !sequence || !recentWindow) return null;

        const matches = [];
        const recent = recentWindow;

        Object.entries(this.discoveredMotifs[asset]).forEach(([patternStr, motifInfo]) => {
            const pattern = patternStr.split(',').map(Number);
            const patternLen = pattern.length;

            // Check if the end of recent window matches this motif
            if (recent.length >= patternLen) {
                const tail = recent.slice(-patternLen);
                let isMatch = true;
                for (let i = 0; i < patternLen; i++) {
                    if (tail[i] !== pattern[i]) {
                        isMatch = false;
                        break;
                    }
                }

                if (isMatch) {
                    // Find what typically follows this motif
                    const positions = this.motifOccurrences[asset][patternStr] || [];
                    const followers = {};
                    let followerCount = 0;

                    positions.forEach(pos => {
                        const nextIdx = pos + patternLen;
                        if (nextIdx < sequence.length) {
                            const next = sequence[nextIdx];
                            followers[next] = (followers[next] || 0) + 1;
                            followerCount++;
                        }
                    });

                    if (followerCount > 0) {
                        const followerProbs = {};
                        Object.entries(followers).forEach(([digit, count]) => {
                            followerProbs[digit] = count / followerCount;
                        });

                        matches.push({
                            pattern: patternStr,
                            motifInfo,
                            followerDistribution: followerProbs,
                            followerCount,
                            confidence: Math.min(1, followerCount / 15) *
                                Math.min(1, motifInfo.support * 50),
                        });
                    }
                }
            }
        });

        if (matches.length === 0) return null;

        // Sort by confidence
        matches.sort((a, b) => b.confidence - a.confidence);

        // Aggregate predictions from top motif matches
        const aggregated = {};
        let totalWeight = 0;

        matches.slice(0, 5).forEach(match => {
            const weight = match.confidence;
            Object.entries(match.followerDistribution).forEach(([digit, prob]) => {
                aggregated[digit] = (aggregated[digit] || 0) + prob * weight;
            });
            totalWeight += weight;
        });

        if (totalWeight === 0) return null;

        // Normalize
        Object.keys(aggregated).forEach(k => {
            aggregated[k] /= totalWeight;
        });

        return {
            matches: matches.slice(0, 5),
            aggregatedPrediction: aggregated,
            topMatch: matches[0],
            numMatches: matches.length,
            confidence: matches[0].confidence,
        };
    }

    // ====================================================================
    // CHANGE POINT DETECTION (CUSUM)
    // ====================================================================

    /**
     * CUSUM (Cumulative Sum) change point detection
     * Detects shifts in mean of run lengths
     */
    detectChangePoints(asset, runLengths) {
        if (!runLengths || runLengths.length < 20) {
            return { changePoints: [], currentTrend: 'stable' };
        }

        // Initialize CUSUM state
        if (!this.cusumState[asset]) {
            this.cusumState[asset] = {
                sPlus: 0,
                sMinus: 0,
                lastReset: 0,
                detectedChanges: [],
            };
        }

        const n = runLengths.length;
        const overallMean = runLengths.reduce((a, b) => a + b, 0) / n;
        const overallStd = Math.sqrt(
            runLengths.reduce((a, b) => a + Math.pow(b - overallMean, 2), 0) / n
        );

        const threshold = this.config.changePointThreshold * (overallStd || 1);
        const drift = 0.5 * (overallStd || 1);

        const changePoints = [];
        let sPlus = 0;
        let sMinus = 0;

        for (let i = 0; i < n; i++) {
            const deviation = runLengths[i] - overallMean;

            // Positive CUSUM (detect upward shift)
            sPlus = Math.max(0, sPlus + deviation - drift);
            // Negative CUSUM (detect downward shift)
            sMinus = Math.max(0, sMinus - deviation - drift);

            if (sPlus > threshold) {
                changePoints.push({
                    index: i,
                    type: 'increase',
                    magnitude: sPlus,
                    value: runLengths[i],
                });
                sPlus = 0;
            }

            if (sMinus > threshold) {
                changePoints.push({
                    index: i,
                    type: 'decrease',
                    magnitude: sMinus,
                    value: runLengths[i],
                });
                sMinus = 0;
            }
        }

        // Update state
        this.cusumState[asset].sPlus = sPlus;
        this.cusumState[asset].sMinus = sMinus;
        this.cusumState[asset].detectedChanges = changePoints;

        // Determine current trend
        let currentTrend = 'stable';
        if (sPlus > threshold * 0.5) currentTrend = 'increasing';
        else if (sMinus > threshold * 0.5) currentTrend = 'decreasing';

        // Check recent change proximity
        const recentChanges = changePoints.filter(cp => cp.index > n - 10);
        const isNearChangePoint = recentChanges.length > 0;

        this.changePoints[asset] = {
            changePoints,
            recentChanges,
            currentTrend,
            isNearChangePoint,
            cusumPlus: sPlus,
            cusumMinus: sMinus,
            threshold,
        };

        return this.changePoints[asset];
    }

    // ====================================================================
    // AUTOCORRELATION ANALYSIS
    // ====================================================================

    /**
     * Compute autocorrelation function for multiple lags
     */
    computeAutocorrelation(asset, sequence, maxLag = null) {
        const lag = maxLag || this.config.autocorrMaxLag;

        if (!sequence || sequence.length < lag + 10) return null;

        const n = sequence.length;
        const mean = sequence.reduce((a, b) => a + b, 0) / n;
        const variance = sequence.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;

        if (variance === 0) {
            this.autocorrelations[asset] = {
                values: new Array(lag).fill(0),
                significantLags: [],
                isRandom: true,
            };
            return this.autocorrelations[asset];
        }

        const acf = [];
        const significantLags = [];
        const significanceThreshold = 1.96 / Math.sqrt(n); // 95% CI for white noise

        for (let k = 1; k <= lag; k++) {
            let autoCorr = 0;
            for (let i = k; i < n; i++) {
                autoCorr += (sequence[i] - mean) * (sequence[i - k] - mean);
            }
            autoCorr /= (n * variance);
            acf.push(autoCorr);

            if (Math.abs(autoCorr) > significanceThreshold) {
                significantLags.push({
                    lag: k,
                    value: autoCorr,
                    direction: autoCorr > 0 ? 'positive' : 'negative',
                });
            }
        }

        // Ljung-Box test statistic (portmanteau test for randomness)
        let ljungBox = 0;
        const testLags = Math.min(10, acf.length);
        for (let k = 0; k < testLags; k++) {
            ljungBox += (acf[k] * acf[k]) / (n - k - 1);
        }
        ljungBox *= n * (n + 2);

        // Approximate p-value (chi-squared with testLags degrees of freedom)
        // Simplified: compare to critical value
        const criticalValue = testLags + 2 * Math.sqrt(2 * testLags); // Approx 95% critical
        const isRandom = ljungBox < criticalValue;

        // Dominant period detection (find lag with highest positive autocorrelation)
        let dominantPeriod = null;
        let maxPositiveAcf = 0;
        for (let k = 2; k < acf.length; k++) {
            if (acf[k] > maxPositiveAcf && acf[k] > significanceThreshold) {
                maxPositiveAcf = acf[k];
                dominantPeriod = k + 1;
            }
        }

        this.autocorrelations[asset] = {
            values: acf,
            significantLags,
            isRandom,
            ljungBoxStatistic: ljungBox,
            dominantPeriod,
            significanceThreshold,
        };

        return this.autocorrelations[asset];
    }

    // ====================================================================
    // RUNS TEST FOR RANDOMNESS (Wald-Wolfowitz)
    // ====================================================================

    /**
     * Wald-Wolfowitz runs test
     * Tests whether a sequence of observations is random
     */
    waldsWolfowitzRunsTest(sequence) {
        if (!sequence || sequence.length < 20) {
            return { isRandom: true, zScore: 0, pValue: 0.5 };
        }

        const n = sequence.length;
        const median = this._median(sequence);

        // Convert to binary (above/below median)
        const binary = sequence.map(x => x >= median ? 1 : 0);

        // Count runs
        let numRuns = 1;
        for (let i = 1; i < n; i++) {
            if (binary[i] !== binary[i - 1]) numRuns++;
        }

        // Count n1 (above median) and n2 (below median)
        const n1 = binary.filter(x => x === 1).length;
        const n2 = binary.filter(x => x === 0).length;

        if (n1 === 0 || n2 === 0) {
            return { isRandom: false, zScore: 0, pValue: 0, numRuns, n1, n2 };
        }

        // Expected number of runs
        const expectedRuns = (2 * n1 * n2) / (n1 + n2) + 1;

        // Standard deviation of runs
        const varRuns = (2 * n1 * n2 * (2 * n1 * n2 - n1 - n2)) /
            ((n1 + n2) * (n1 + n2) * (n1 + n2 - 1));
        const stdRuns = Math.sqrt(varRuns);

        // Z-score
        const zScore = stdRuns > 0 ? (numRuns - expectedRuns) / stdRuns : 0;

        // Approximate p-value (two-tailed)
        const pValue = 2 * (1 - this._normalCDF(Math.abs(zScore)));

        return {
            isRandom: Math.abs(zScore) < 1.96, // 95% confidence
            zScore,
            pValue,
            numRuns,
            expectedRuns,
            n1,
            n2,
            interpretation: zScore > 1.96 ? 'too_many_alternations' :
                zScore < -1.96 ? 'too_few_alternations' : 'random',
        };
    }

    // ====================================================================
    // FRACTAL DIMENSION (Higuchi Method)
    // ====================================================================

    /**
     * Estimate fractal dimension using Higuchi's method
     * Higher values (~1.5-2.0) indicate more complex/random patterns
     * Lower values (~1.0-1.3) indicate more structured/predictable patterns
     */
    computeHiguchiFractalDimension(asset, sequence, kMax = 10) {
        if (!sequence || sequence.length < kMax * 4) {
            return { dimension: 1.5, confidence: 0 };
        }

        const n = sequence.length;
        const logK = [];
        const logL = [];

        for (let k = 1; k <= kMax; k++) {
            let lk = 0;

            for (let m = 1; m <= k; m++) {
                let lm = 0;
                const upperBound = Math.floor((n - m) / k);

                for (let i = 1; i <= upperBound; i++) {
                    lm += Math.abs(sequence[m - 1 + i * k] - sequence[m - 1 + (i - 1) * k]);
                }

                lm = (lm * (n - 1)) / (Math.floor((n - m) / k) * k * k);
                lk += lm;
            }

            lk /= k;

            if (lk > 0) {
                logK.push(Math.log(1 / k));
                logL.push(Math.log(lk));
            }
        }

        if (logK.length < 3) {
            return { dimension: 1.5, confidence: 0 };
        }

        // Linear regression to find slope (fractal dimension)
        const regression = this._linearRegression(logK, logL);

        this.fractalDimensions[asset] = {
            dimension: Math.max(1, Math.min(2, regression.slope)),
            rSquared: regression.rSquared,
            confidence: regression.rSquared,
            interpretation: regression.slope < 1.3 ? 'structured' :
                regression.slope < 1.6 ? 'mixed' : 'complex',
        };

        return this.fractalDimensions[asset];
    }

    // ====================================================================
    // HURST EXPONENT ESTIMATION
    // ====================================================================

    /**
     * Estimate Hurst exponent using rescaled range (R/S) analysis
     * H < 0.5: mean-reverting (anti-persistent)
     * H = 0.5: random walk
     * H > 0.5: trending (persistent)
     */
    computeHurstExponent(asset, sequence) {
        if (!sequence || sequence.length < 40) {
            return { hurst: 0.5, interpretation: 'insufficient_data', confidence: 0 };
        }

        const n = sequence.length;
        const logN = [];
        const logRS = [];

        // Try different subdivision sizes
        const sizes = [];
        for (let s = 8; s <= Math.floor(n / 2); s = Math.floor(s * 1.5)) {
            sizes.push(s);
        }

        sizes.forEach(size => {
            const numBlocks = Math.floor(n / size);
            if (numBlocks < 2) return;

            let totalRS = 0;
            let validBlocks = 0;

            for (let b = 0; b < numBlocks; b++) {
                const block = sequence.slice(b * size, (b + 1) * size);
                const mean = block.reduce((a, c) => a + c, 0) / block.length;

                // Cumulative deviation from mean
                const cumDev = [];
                let sum = 0;
                for (let i = 0; i < block.length; i++) {
                    sum += block[i] - mean;
                    cumDev.push(sum);
                }

                const range = Math.max(...cumDev) - Math.min(...cumDev);
                const std = Math.sqrt(
                    block.reduce((a, c) => a + Math.pow(c - mean, 2), 0) / block.length
                );

                if (std > 0) {
                    totalRS += range / std;
                    validBlocks++;
                }
            }

            if (validBlocks > 0) {
                logN.push(Math.log(size));
                logRS.push(Math.log(totalRS / validBlocks));
            }
        });

        if (logN.length < 3) {
            return { hurst: 0.5, interpretation: 'insufficient_data', confidence: 0 };
        }

        const regression = this._linearRegression(logN, logRS);
        const hurst = Math.max(0, Math.min(1, regression.slope));

        let interpretation;
        if (hurst < 0.4) interpretation = 'strongly_mean_reverting';
        else if (hurst < 0.48) interpretation = 'mean_reverting';
        else if (hurst < 0.52) interpretation = 'random_walk';
        else if (hurst < 0.6) interpretation = 'mildly_trending';
        else interpretation = 'strongly_trending';

        this.hurstExponents[asset] = {
            hurst,
            interpretation,
            rSquared: regression.rSquared,
            confidence: regression.rSquared,
        };

        return this.hurstExponents[asset];
    }

    // ====================================================================
    // REGIME DETECTION (ENHANCED)
    // ====================================================================

    /**
     * Multi-feature regime detection with transition tracking
     */
    detectRegime(asset, recentRuns, windowSize = null) {
        const window = windowSize || this.config.regimeWindowSize;

        if (!recentRuns || recentRuns.length < window) {
            return { regime: 'unknown', confidence: 0, features: {} };
        }

        const recent = recentRuns.slice(-window);

        // Feature extraction
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        const std = Math.sqrt(variance);
        const cv = mean > 0 ? std / mean : 0;

        const shortRuns = recent.filter(l => l <= 3).length;
        const mediumRuns = recent.filter(l => l > 3 && l <= 10).length;
        const longRuns = recent.filter(l => l > 10).length;

        const shortRunRatio = shortRuns / recent.length;
        const mediumRunRatio = mediumRuns / recent.length;
        const longRunRatio = longRuns / recent.length;

        // Trend detection
        const halfPoint = Math.floor(recent.length / 2);
        const firstHalfMean = recent.slice(0, halfPoint).reduce((a, b) => a + b, 0) / halfPoint;
        const secondHalfMean = recent.slice(halfPoint).reduce((a, b) => a + b, 0) / (recent.length - halfPoint);
        const trendSlope = (secondHalfMean - firstHalfMean) / firstHalfMean;

        // Consecutive short run detection
        let maxConsecutiveShort = 0;
        let currentConsecutiveShort = 0;
        recent.forEach(r => {
            if (r <= 3) {
                currentConsecutiveShort++;
                maxConsecutiveShort = Math.max(maxConsecutiveShort, currentConsecutiveShort);
            } else {
                currentConsecutiveShort = 0;
            }
        });

        // Run length entropy
        const runBins = {};
        recent.forEach(r => {
            const bin = this.discretizeRunLength(r);
            runBins[bin] = (runBins[bin] || 0) + 1;
        });
        const runEntropy = this._calculateDistributionEntropy(
            Object.fromEntries(Object.entries(runBins).map(([k, v]) => [k, v / recent.length]))
        );

        // Regime classification using multi-feature scoring
        const scores = {
            volatile: 0,
            choppy: 0,
            stable: 0,
            trending_up: 0,
            trending_down: 0,
            normal: 0,
            unpredictable: 0,
        };

        // Volatile: many short runs, high variance
        scores.volatile += shortRunRatio > 0.5 ? 2 : shortRunRatio > 0.35 ? 1 : 0;
        scores.volatile += cv > 1.2 ? 1.5 : cv > 0.8 ? 0.5 : 0;
        scores.volatile += maxConsecutiveShort > 4 ? 1.5 : maxConsecutiveShort > 3 ? 0.5 : 0;

        // Choppy: alternating short and medium, no clear trend
        scores.choppy += (shortRunRatio > 0.3 && mediumRunRatio > 0.3) ? 1.5 : 0;
        scores.choppy += Math.abs(trendSlope) < 0.1 ? 1 : 0;
        scores.choppy += cv > 0.7 && cv < 1.3 ? 0.5 : 0;

        // Stable: many long runs, low variance
        scores.stable += longRunRatio > 0.3 ? 2 : longRunRatio > 0.2 ? 1 : 0;
        scores.stable += cv < 0.6 ? 1.5 : cv < 0.8 ? 0.5 : 0;
        scores.stable += mean > 10 ? 1 : mean > 7 ? 0.5 : 0;

        // Trending up: increasing run lengths
        scores.trending_up += trendSlope > 0.2 ? 2 : trendSlope > 0.1 ? 1 : 0;
        scores.trending_up += secondHalfMean > firstHalfMean * 1.2 ? 1 : 0;

        // Trending down: decreasing run lengths
        scores.trending_down += trendSlope < -0.2 ? 2 : trendSlope < -0.1 ? 1 : 0;
        scores.trending_down += secondHalfMean < firstHalfMean * 0.8 ? 1 : 0;

        // Normal: balanced distribution
        scores.normal += (shortRunRatio < 0.4 && longRunRatio < 0.4) ? 1 : 0;
        scores.normal += cv > 0.5 && cv < 1.0 ? 1 : 0;
        scores.normal += runEntropy > 0.6 ? 0.5 : 0;

        // Unpredictable: high entropy, no clear pattern
        scores.unpredictable += runEntropy > 0.85 ? 1.5 : 0;
        scores.unpredictable += cv > 1.5 ? 1.5 : 0;

        // Select regime with highest score
        const sortedRegimes = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        const topRegime = sortedRegimes[0];
        const secondRegime = sortedRegimes[1];

        const regime = topRegime[0];
        const confidence = topRegime[1] > 0 ?
            (topRegime[1] - secondRegime[1]) / topRegime[1] : 0;

        // Track regime transitions
        if (!this.regimeHistory[asset]) {
            this.regimeHistory[asset] = [];
        }

        const prevRegime = this.regimeHistory[asset].length > 0 ?
            this.regimeHistory[asset][this.regimeHistory[asset].length - 1].regime : null;

        this.regimeHistory[asset].push({
            regime,
            confidence,
            timestamp: Date.now(),
            features: { mean, std, cv, shortRunRatio, longRunRatio, trendSlope },
        });

        if (this.regimeHistory[asset].length > this.config.regimeHistorySize) {
            this.regimeHistory[asset].shift();
        }

        // Track regime transitions
        if (prevRegime && prevRegime !== regime) {
            if (!this.regimeTransitionMatrix[asset]) {
                this.regimeTransitionMatrix[asset] = {};
            }
            const transKey = `${prevRegime}->${regime}`;
            this.regimeTransitionMatrix[asset][transKey] =
                (this.regimeTransitionMatrix[asset][transKey] || 0) + 1;
        }

        const result = {
            regime,
            confidence,
            scores,
            sortedRegimes,
            features: {
                mean, std, cv, variance,
                shortRunRatio, mediumRunRatio, longRunRatio,
                trendSlope,
                maxConsecutiveShort,
                runEntropy,
            },
            prevRegime,
            isTransition: prevRegime !== null && prevRegime !== regime,
            shortRuns,
            longRuns,
        };

        this.regimeStates[asset] = result;
        return result;
    }

    /**
     * Get regime stability (how long current regime has lasted)
     */
    getRegimeStability(asset) {
        if (!this.regimeHistory[asset] || this.regimeHistory[asset].length < 2) {
            return { stability: 0, currentDuration: 0 };
        }

        const history = this.regimeHistory[asset];
        const currentRegime = history[history.length - 1].regime;

        let duration = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].regime === currentRegime) {
                duration++;
            } else {
                break;
            }
        }

        // Count total regime changes
        let changes = 0;
        for (let i = 1; i < history.length; i++) {
            if (history[i].regime !== history[i - 1].regime) changes++;
        }

        const stability = 1 - (changes / (history.length - 1));

        return {
            stability,
            currentDuration: duration,
            totalChanges: changes,
            currentRegime,
        };
    }

    // ====================================================================
    // PATTERN SIMILARITY (DYNAMIC TIME WARPING)
    // ====================================================================

    /**
     * Dynamic Time Warping distance between two sequences
     * More robust than Euclidean distance for time series comparison
     */
    dtwDistance(seq1, seq2) {
        const n = seq1.length;
        const m = seq2.length;

        if (n === 0 || m === 0) return Infinity;

        // Cost matrix
        const dtw = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
        dtw[0][0] = 0;

        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                const cost = Math.abs(seq1[i - 1] - seq2[j - 1]);
                dtw[i][j] = cost + Math.min(
                    dtw[i - 1][j],     // insertion
                    dtw[i][j - 1],     // deletion
                    dtw[i - 1][j - 1]  // match
                );
            }
        }

        return dtw[n][m] / Math.max(n, m); // Normalize by length
    }

    /**
     * Find similar historical patterns using DTW
     */
    findSimilarPatterns(sequence, pattern, maxResults = 5, maxDistance = null) {
        if (!sequence || !pattern || sequence.length < pattern.length + 5) {
            return [];
        }

        const patternLength = pattern.length;
        const matches = [];

        // Sliding window comparison
        for (let i = 0; i <= sequence.length - patternLength - 1; i++) {
            const candidate = sequence.slice(i, i + patternLength);
            const distance = this.dtwDistance(candidate, pattern);

            const nextValue = sequence[i + patternLength];

            matches.push({
                index: i,
                distance,
                pattern: candidate,
                nextValue,
            });
        }

        // Sort by distance and filter
        matches.sort((a, b) => a.distance - b.distance);

        const threshold = maxDistance || (matches.length > 0 ?
            matches[Math.floor(matches.length * 0.1)].distance * 1.5 : Infinity);

        const filtered = matches
            .filter(m => m.distance <= threshold && m.nextValue !== undefined)
            .slice(0, maxResults);

        // Aggregate predictions from similar patterns
        if (filtered.length > 0) {
            const nextValueDist = {};
            let totalWeight = 0;

            filtered.forEach(match => {
                const weight = 1 / (match.distance + 0.01); // Inverse distance weighting
                nextValueDist[match.nextValue] = (nextValueDist[match.nextValue] || 0) + weight;
                totalWeight += weight;
            });

            // Normalize
            Object.keys(nextValueDist).forEach(k => {
                nextValueDist[k] /= totalWeight;
            });

            return {
                matches: filtered,
                prediction: nextValueDist,
                confidence: filtered.length >= 3 ? Math.min(1, 1 / (filtered[0].distance + 0.1)) : 0,
            };
        }

        return { matches: filtered, prediction: null, confidence: 0 };
    }

    // ====================================================================
    // MOMENTUM AND MEAN REVERSION INDICATORS
    // ====================================================================

    /**
     * Calculate momentum indicators for run lengths
     */
    calculateMomentumIndicators(asset, runLengths) {
        if (!runLengths || runLengths.length < 20) {
            return null;
        }

        const n = runLengths.length;

        // Simple Moving Averages
        const sma5 = this._sma(runLengths, 5);
        const sma10 = this._sma(runLengths, 10);
        const sma20 = this._sma(runLengths, 20);

        // Exponential Moving Average
        const ema5 = this._ema(runLengths, 5);
        const ema10 = this._ema(runLengths, 10);

        // Rate of Change (ROC)
        const roc5 = n >= 6 ? (runLengths[n - 1] - runLengths[n - 6]) / (runLengths[n - 6] || 1) : 0;
        const roc10 = n >= 11 ? (runLengths[n - 1] - runLengths[n - 11]) / (runLengths[n - 11] || 1) : 0;

        // Relative Strength Index (RSI) - adapted for run lengths
        const rsi = this._computeRSI(runLengths, 14);

        // Bollinger Band position
        const bbPosition = this._bollingerBandPosition(runLengths, 20, 2);

        // MACD-like indicator
        const macdLine = ema5 - ema10;
        const signalStrength = Math.abs(macdLine) / (sma10 || 1);

        // Mean reversion score
        // How far current is from long-term average relative to std
        const longMean = runLengths.reduce((a, b) => a + b, 0) / n;
        const longStd = Math.sqrt(runLengths.reduce((a, b) => a + Math.pow(b - longMean, 2), 0) / n);
        const currentZScore = longStd > 0 ? (runLengths[n - 1] - longMean) / longStd : 0;
        const meanReversionProbability = this.sigmoid(-currentZScore); // Higher when below mean

        return {
            sma: { sma5, sma10, sma20 },
            ema: { ema5, ema10 },
            roc: { roc5, roc10 },
            rsi,
            bollingerPosition: bbPosition,
            macd: { line: macdLine, signalStrength },
            zScore: currentZScore,
            meanReversionProbability,
            momentum: {
                shortTerm: sma5 > sma10 ? 'bullish' : 'bearish',
                mediumTerm: sma10 > sma20 ? 'bullish' : 'bearish',
                strength: signalStrength,
            },
        };
    }

    sigmoid(x) {
        return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
    }

    _sma(arr, period) {
        if (arr.length < period) return arr.reduce((a, b) => a + b, 0) / arr.length;
        return arr.slice(-period).reduce((a, b) => a + b, 0) / period;
    }

    _ema(arr, period) {
        if (arr.length === 0) return 0;
        const k = 2 / (period + 1);
        let ema = arr[0];
        for (let i = 1; i < arr.length; i++) {
            ema = arr[i] * k + ema * (1 - k);
        }
        return ema;
    }

    _computeRSI(arr, period) {
        if (arr.length < period + 1) return 50;

        const recent = arr.slice(-(period + 1));
        let gains = 0;
        let losses = 0;

        for (let i = 1; i < recent.length; i++) {
            const change = recent[i] - recent[i - 1];
            if (change > 0) gains += change;
            else losses -= change;
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    _bollingerBandPosition(arr, period, numStd) {
        if (arr.length < period) return 0.5;

        const recent = arr.slice(-period);
        const mean = recent.reduce((a, b) => a + b, 0) / period;
        const std = Math.sqrt(recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period);

        const upper = mean + numStd * std;
        const lower = mean - numStd * std;
        const current = arr[arr.length - 1];

        if (upper === lower) return 0.5;
        return (current - lower) / (upper - lower);
    }

    // ====================================================================
    // SEQUENTIAL PATTERN MINING
    // ====================================================================

    /**
     * Mine frequent sequential patterns from run length states
     * Returns patterns that occur more frequently than random chance
     */
    mineSequentialPatterns(asset, runLengths, minSupport = null) {
        const support = minSupport || this.config.minPatternSupport;

        if (!runLengths || runLengths.length < 30) return;

        const states = runLengths.map(l => this.discretizeRunLength(l));
        const n = states.length;
        const minCount = Math.max(3, Math.floor(n * support));

        this.frequentPatterns[asset] = {};
        this.patternSupport[asset] = {};

        // Mine patterns of length 2 to 5
        for (let len = 2; len <= 5; len++) {
            const patternCounts = {};

            for (let i = 0; i <= n - len; i++) {
                const pattern = states.slice(i, i + len).join('→');
                patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
            }

            Object.entries(patternCounts).forEach(([pattern, count]) => {
                if (count >= minCount) {
                    const patternSupport = count / (n - len + 1);

                    // Check if pattern is significantly more frequent than expected
                    // by comparing to product of individual state probabilities
                    const parts = pattern.split('→');
                    const expectedProb = parts.reduce((prob, state) => {
                        const stateCount = states.filter(s => s === state).length;
                        return prob * (stateCount / n);
                    }, 1);

                    const lift = patternSupport / (expectedProb || 0.001);

                    if (lift > 1.5) { // Pattern is at least 1.5x more frequent than expected
                        this.frequentPatterns[asset][pattern] = {
                            count,
                            support: patternSupport,
                            lift,
                            length: len,
                        };
                    }
                }
            });
        }

        // Find what follows each frequent pattern
        Object.keys(this.frequentPatterns[asset]).forEach(pattern => {
            const parts = pattern.split('→');
            const followers = {};
            let followerTotal = 0;

            for (let i = 0; i <= n - parts.length - 1; i++) {
                const candidate = states.slice(i, i + parts.length).join('→');
                if (candidate === pattern) {
                    const next = states[i + parts.length];
                    followers[next] = (followers[next] || 0) + 1;
                    followerTotal++;
                }
            }

            if (followerTotal > 0) {
                this.frequentPatterns[asset][pattern].followers = {};
                Object.entries(followers).forEach(([state, count]) => {
                    this.frequentPatterns[asset][pattern].followers[state] = count / followerTotal;
                });
                this.frequentPatterns[asset][pattern].followerCount = followerTotal;
            }
        });

        return this.frequentPatterns[asset];
    }

    /**
     * Match current state sequence against mined patterns and predict
     */
    predictFromSequentialPatterns(asset, recentRuns) {
        if (!this.frequentPatterns[asset] || !recentRuns || recentRuns.length < 2) {
            return null;
        }

        const states = recentRuns.slice(-5).map(l => this.discretizeRunLength(l));
        const matches = [];

        Object.entries(this.frequentPatterns[asset]).forEach(([pattern, info]) => {
            if (!info.followers) return;

            const parts = pattern.split('→');
            const patternLen = parts.length;

            if (states.length >= patternLen) {
                const tail = states.slice(-patternLen).join('→');
                if (tail === pattern) {
                    matches.push({
                        pattern,
                        info,
                        confidence: Math.min(1,
                            (info.lift / 5) * 0.4 +
                            Math.min(1, info.followerCount / 10) * 0.3 +
                            Math.min(1, info.support * 20) * 0.3
                        ),
                    });
                }
            }
        });

        if (matches.length === 0) return null;

        matches.sort((a, b) => b.confidence - a.confidence);

        // Aggregate follower predictions
        const aggregated = {};
        let totalWeight = 0;

        matches.forEach(match => {
            const weight = match.confidence;
            Object.entries(match.info.followers).forEach(([state, prob]) => {
                aggregated[state] = (aggregated[state] || 0) + prob * weight;
            });
            totalWeight += weight;
        });

        if (totalWeight > 0) {
            Object.keys(aggregated).forEach(k => { aggregated[k] /= totalWeight; });
        }

        // Convert state predictions to favorable/unfavorable probability
        const favorableStates = ['medium', 'medium_long', 'long', 'very_long', 'extreme'];
        const favorableProb = favorableStates.reduce((sum, state) =>
            sum + (aggregated[state] || 0), 0);

        return {
            matches,
            statePrediction: aggregated,
            favorableProb,
            confidence: matches[0].confidence,
            numMatches: matches.length,
        };
    }

    // ====================================================================
    // COMPREHENSIVE ANALYSIS
    // ====================================================================

    /**
     * Run all analyses and return comprehensive pattern report
     */
    getComprehensiveAnalysis(asset, tickHistory, runLengths) {
        const report = {
            asset,
            timestamp: Date.now(),
        };

        // N-gram analysis
        if (tickHistory && tickHistory.length > 20) {
            report.ngram = this.predictFromNgram(asset, tickHistory.slice(-6));
        }

        // Markov chain analysis
        if (runLengths && runLengths.length > 10) {
            report.markov = this.predictNextRunState(asset, runLengths);
        }

        // Regime detection
        if (runLengths && runLengths.length > 20) {
            report.regime = this.detectRegime(asset, runLengths);
            report.regimeStability = this.getRegimeStability(asset);
        }

        // Change point detection
        if (runLengths && runLengths.length > 20) {
            report.changePoints = this.detectChangePoints(asset, runLengths);
        }

        // Autocorrelation
        if (runLengths && runLengths.length > 30) {
            report.autocorrelation = this.computeAutocorrelation(asset, runLengths);
        }

        // Fractal dimension
        if (runLengths && runLengths.length > 40) {
            report.fractal = this.computeHiguchiFractalDimension(asset, runLengths);
        }

        // Hurst exponent
        if (runLengths && runLengths.length > 40) {
            report.hurst = this.computeHurstExponent(asset, runLengths);
        }

        // Momentum indicators
        if (runLengths && runLengths.length > 20) {
            report.momentum = this.calculateMomentumIndicators(asset, runLengths);
        }

        // Runs test
        if (runLengths && runLengths.length > 20) {
            report.runsTest = this.waldsWolfowitzRunsTest(runLengths);
        }

        // Sequential pattern mining
        if (runLengths && runLengths.length > 30) {
            report.sequentialPatterns = this.predictFromSequentialPatterns(asset, runLengths);
        }

        // Steady state deviation
        if (runLengths && runLengths.length > 20) {
            report.steadyStateDeviation = this.getSteadyStateDeviation(asset, runLengths);
        }

        // Motif matching
        if (tickHistory && tickHistory.length > 30) {
            report.motifMatch = this.matchMotifAndPredict(
                asset, tickHistory, tickHistory.slice(-8)
            );
        }

        // Composite pattern score
        report.compositeScore = this._computeCompositePatternScore(report);

        return report;
    }

    /**
     * Compute a composite pattern favorability score from all analyses
     */
    _computeCompositePatternScore(report) {
        let score = 0;
        let totalWeight = 0;

        // Regime favorability
        if (report.regime) {
            const regimeScores = {
                'stable': 0.85,
                'normal': 0.65,
                'trending_up': 0.7,
                'trending_down': 0.4,
                'choppy': 0.35,
                'volatile': 0.2,
                'unpredictable': 0.25,
            };
            const regimeScore = regimeScores[report.regime.regime] || 0.5;
            const weight = 2.0 * (report.regime.confidence || 0.5);
            score += regimeScore * weight;
            totalWeight += weight;
        }

        // Hurst exponent favorability
        if (report.hurst && report.hurst.confidence > 0.3) {
            // Trending (H > 0.5) is good for survival continuation
            const hurstScore = report.hurst.hurst > 0.5 ? 0.7 : 0.35;
            const weight = 1.5 * report.hurst.confidence;
            score += hurstScore * weight;
            totalWeight += weight;
        }

        // Change point proximity (near change point = risky)
        if (report.changePoints) {
            const cpScore = report.changePoints.isNearChangePoint ? 0.25 : 0.7;
            score += cpScore * 1.0;
            totalWeight += 1.0;
        }

        // Autocorrelation (non-random = more predictable = better)
        if (report.autocorrelation) {
            const acScore = report.autocorrelation.isRandom ? 0.4 : 0.65;
            score += acScore * 1.0;
            totalWeight += 1.0;
        }

        // Momentum indicators
        if (report.momentum) {
            const momScore = report.momentum.meanReversionProbability;
            const rsiScore = report.momentum.rsi > 30 && report.momentum.rsi < 70 ? 0.65 : 0.35;
            score += ((momScore + rsiScore) / 2) * 1.5;
            totalWeight += 1.5;
        }

        // Fractal dimension (lower = more structured = better)
        if (report.fractal && report.fractal.confidence > 0.3) {
            const fractalScore = report.fractal.dimension < 1.4 ? 0.7 :
                report.fractal.dimension < 1.6 ? 0.5 : 0.3;
            score += fractalScore * report.fractal.confidence;
            totalWeight += report.fractal.confidence;
        }

        // Sequential pattern prediction
        if (report.sequentialPatterns && report.sequentialPatterns.confidence > 0.3) {
            score += report.sequentialPatterns.favorableProb * 1.5 * report.sequentialPatterns.confidence;
            totalWeight += 1.5 * report.sequentialPatterns.confidence;
        }

        // Markov prediction
        if (report.markov) {
            const favorableStates = ['medium', 'medium_long', 'long', 'very_long', 'extreme'];
            let markovFavorable = 0;
            Object.entries(report.markov.predictions).forEach(([state, prob]) => {
                if (favorableStates.includes(state)) markovFavorable += prob;
            });
            const weight = 1.5 * Math.min(1, report.markov.confidence / 10);
            score += markovFavorable * weight;
            totalWeight += weight;
        }

        // Steady state deviation
        if (report.steadyStateDeviation) {
            // High deviation = anomalous = risky
            const devScore = report.steadyStateDeviation.deviation < 0.5 ? 0.7 :
                report.steadyStateDeviation.deviation < 1.0 ? 0.5 : 0.25;
            score += devScore * 0.8;
            totalWeight += 0.8;
        }

        // Runs test
        if (report.runsTest) {
            // Non-random patterns can be exploited
            const runsScore = report.runsTest.isRandom ? 0.45 : 0.6;
            score += runsScore * 0.5;
            totalWeight += 0.5;
        }

        return totalWeight > 0 ? score / totalWeight : 0.5;
    }

    // ====================================================================
    // RUN LENGTH DISTRIBUTION FITTING
    // ====================================================================

    /**
     * Fit run length distribution (Weibull/Exponential)
     */
    fitRunLengthDistribution(runLengths) {
        if (!runLengths || runLengths.length < 20) {
            return { type: 'unknown', params: {} };
        }

        const mean = runLengths.reduce((a, b) => a + b, 0) / runLengths.length;
        const variance = runLengths.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / runLengths.length;
        const std = Math.sqrt(variance);
        const cv = std / (mean || 1);

        if (cv > 0.9 && cv < 1.1) {
            return {
                type: 'exponential',
                params: { lambda: 1 / mean },
                survivalProb: (t) => Math.exp(-t / mean),
                mean,
                std,
                cv,
            };
        } else {
            const shape = Math.pow(1.2 / cv, 1.1);
            const scale = mean / this._gamma(1 + 1 / shape);

            return {
                type: 'weibull',
                params: { shape, scale },
                survivalProb: (t) => Math.exp(-Math.pow(t / scale, shape)),
                mean,
                std,
                cv,
                hazardIncreasing: shape > 1,
            };
        }
    }

    // ====================================================================
    // HELPER METHODS
    // ====================================================================

    _calculateDistributionEntropy(distribution) {
        let entropy = 0;
        Object.values(distribution).forEach(p => {
            if (p > 0) {
                entropy -= p * Math.log2(p);
            }
        });
        return entropy;
    }

    _median(arr) {
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    _normalCDF(x) {
        // Approximation of the standard normal CDF
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const p = 0.3275911;

        const sign = x >= 0 ? 1 : -1;
        x = Math.abs(x) / Math.SQRT2;

        const t = 1.0 / (1.0 + p * x);
        const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

        return 0.5 * (1.0 + sign * y);
    }

    _linearRegression(x, y) {
        const n = Math.min(x.length, y.length);
        if (n < 2) return { slope: 0, intercept: 0, rSquared: 0 };

        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0, sumYY = 0;

        for (let i = 0; i < n; i++) {
            sumX += x[i];
            sumY += y[i];
            sumXY += x[i] * y[i];
            sumXX += x[i] * x[i];
            sumYY += y[i] * y[i];
        }

        const denom = n * sumXX - sumX * sumX;
        if (Math.abs(denom) < 1e-10) return { slope: 0, intercept: 0, rSquared: 0 };

        const slope = (n * sumXY - sumX * sumY) / denom;
        const intercept = (sumY - slope * sumX) / n;

        // R-squared
        const ssRes = y.reduce((sum, yi, i) => {
            const predicted = slope * x[i] + intercept;
            return sum + Math.pow(yi - predicted, 2);
        }, 0);

        const meanY = sumY / n;
        const ssTot = y.reduce((sum, yi) => sum + Math.pow(yi - meanY, 2), 0);

        const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

        return { slope, intercept, rSquared };
    }

    _gamma(z) {
        if (z < 0.5) {
            return Math.PI / (Math.sin(Math.PI * z) * this._gamma(1 - z));
        }
        z -= 1;
        const g = 7;
        const c = [
            0.99999999999980993, 676.5203681218851, -1259.1392167224028,
            771.32342877765313, -176.61502916214059, 12.507343278686905,
            -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
        ];
        let x = c[0];
        for (let i = 1; i < g + 2; i++) {
            x += c[i] / (z + i);
        }
        const t = z + g + 0.5;
        return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
    }
}

// ============================================================================
// TIER 3: ADVANCED NEURAL NETWORK PREDICTOR
// ============================================================================

class NeuralEngine {
    constructor(inputSize = 90, hiddenSizes = [128, 64, 32], outputSize = 3) {
        this.inputSize = inputSize;
        this.hiddenSizes = hiddenSizes;
        this.outputSize = outputSize; // [survivalProb, confidence, regimeScore]

        // Adam optimizer parameters
        this.learningRate = 0.001;
        this.beta1 = 0.9;
        this.beta2 = 0.999;
        this.epsilon = 1e-8;
        this.timestep = 0;
        this.lrSchedule = { warmup: 100, decay: 0.9999, minLr: 0.0001 };

        // Regularization
        this.dropoutRate = 0.2;
        this.l2Lambda = 0.0001;
        this.maxGradNorm = 5.0;

        // Network layers
        this.layers = [];
        this.gatingLayers = [];     // LSTM-like gates
        this.attentionWeights = {}; // Attention mechanism
        this.batchNormParams = {};  // Batch normalization

        // Adam state
        this.mWeights = {};
        this.vWeights = {};

        // Training
        this.trainingHistory = [];
        this.replayBuffer = [];
        this.replayBufferSize = 2000;
        this.miniBatchSize = 32;
        this.trainingEpochsPerUpdate = 3;

        // Performance tracking
        this.predictionLog = [];
        this.rollingAccuracy = [];
        this.bestAccuracy = 0;
        this.epochsSinceImprovement = 0;
        this.earlyStoppingPatience = 500;

        // Feature engineering state
        this.featureStats = { means: null, stds: null, count: 0 };
        this.sequenceMemory = {};  // Per-asset LSTM-like hidden state

        this.initialized = false;
        this.initializeNetwork();
    }

    // ====================================================================
    // NETWORK INITIALIZATION
    // ====================================================================

    initializeNetwork() {
        const allSizes = [this.inputSize, ...this.hiddenSizes, this.outputSize];

        for (let i = 0; i < allSizes.length - 1; i++) {
            const fanIn = allSizes[i];
            const fanOut = allSizes[i + 1];
            const layerKey = `layer_${i}`;

            // He initialization for ReLU variants
            const scale = Math.sqrt(2.0 / fanIn);

            // Main weights
            this.layers.push({
                weights: this._createMatrix(fanOut, fanIn, scale),
                biases: new Array(fanOut).fill(0),
            });

            // Gating layer (input gate + forget gate for LSTM-like behavior)
            if (i < allSizes.length - 2) { // Not for output layer
                this.gatingLayers.push({
                    inputGate: {
                        weights: this._createMatrix(fanOut, fanIn, scale * 0.5),
                        biases: new Array(fanOut).fill(1.0), // Bias toward keeping
                    },
                    forgetGate: {
                        weights: this._createMatrix(fanOut, fanOut, scale * 0.5),
                        biases: new Array(fanOut).fill(1.0),
                    },
                    cellState: new Array(fanOut).fill(0),
                });

                // Batch normalization parameters
                this.batchNormParams[layerKey] = {
                    gamma: new Array(fanOut).fill(1.0),
                    beta: new Array(fanOut).fill(0.0),
                    runningMean: new Array(fanOut).fill(0.0),
                    runningVar: new Array(fanOut).fill(1.0),
                    momentum: 0.1,
                };
            }

            // Initialize Adam states
            this.mWeights[`w_${i}`] = this._createMatrix(fanOut, fanIn, 0);
            this.vWeights[`w_${i}`] = this._createMatrix(fanOut, fanIn, 0);
            this.mWeights[`b_${i}`] = new Array(fanOut).fill(0);
            this.vWeights[`b_${i}`] = new Array(fanOut).fill(0);

            if (i < allSizes.length - 2) {
                // Gate Adam states
                this.mWeights[`ig_w_${i}`] = this._createMatrix(fanOut, fanIn, 0);
                this.vWeights[`ig_w_${i}`] = this._createMatrix(fanOut, fanIn, 0);
                this.mWeights[`ig_b_${i}`] = new Array(fanOut).fill(0);
                this.vWeights[`ig_b_${i}`] = new Array(fanOut).fill(0);

                this.mWeights[`fg_w_${i}`] = this._createMatrix(fanOut, fanOut, 0);
                this.vWeights[`fg_w_${i}`] = this._createMatrix(fanOut, fanOut, 0);
                this.mWeights[`fg_b_${i}`] = new Array(fanOut).fill(0);
                this.vWeights[`fg_b_${i}`] = new Array(fanOut).fill(0);

                // Batch norm Adam states
                this.mWeights[`bn_g_${i}`] = new Array(fanOut).fill(0);
                this.vWeights[`bn_g_${i}`] = new Array(fanOut).fill(0);
                this.mWeights[`bn_b_${i}`] = new Array(fanOut).fill(0);
                this.vWeights[`bn_b_${i}`] = new Array(fanOut).fill(0);
            }
        }

        // Attention mechanism weights (self-attention over hidden features)
        const attentionDim = this.hiddenSizes[0];
        this.attentionWeights = {
            query: this._createMatrix(attentionDim, attentionDim, Math.sqrt(2.0 / attentionDim)),
            key: this._createMatrix(attentionDim, attentionDim, Math.sqrt(2.0 / attentionDim)),
            value: this._createMatrix(attentionDim, attentionDim, Math.sqrt(2.0 / attentionDim)),
            outputProj: this._createMatrix(attentionDim, attentionDim, Math.sqrt(2.0 / attentionDim)),
        };

        // Attention Adam states
        ['query', 'key', 'value', 'outputProj'].forEach(key => {
            this.mWeights[`att_${key}`] = this._createMatrix(attentionDim, attentionDim, 0);
            this.vWeights[`att_${key}`] = this._createMatrix(attentionDim, attentionDim, 0);
        });

        // Residual projection layers (for dimension mismatches)
        this.residualProjections = {};
        for (let i = 0; i < this.hiddenSizes.length - 1; i++) {
            if (this.hiddenSizes[i] !== this.hiddenSizes[i + 1]) {
                this.residualProjections[i] = {
                    weights: this._createMatrix(
                        this.hiddenSizes[i + 1],
                        this.hiddenSizes[i],
                        Math.sqrt(2.0 / this.hiddenSizes[i])
                    ),
                };
                this.mWeights[`res_${i}`] = this._createMatrix(this.hiddenSizes[i + 1], this.hiddenSizes[i], 0);
                this.vWeights[`res_${i}`] = this._createMatrix(this.hiddenSizes[i + 1], this.hiddenSizes[i], 0);
            }
        }

        this.initialized = true;
        console.log(`🧠 Advanced Neural Network initialized: [${allSizes.join(' → ')}]`);
        console.log(`   Total parameters: ~${this._countParameters()}`);
    }

    _createMatrix(rows, cols, scale) {
        const matrix = [];
        for (let i = 0; i < rows; i++) {
            matrix[i] = [];
            for (let j = 0; j < cols; j++) {
                matrix[i][j] = scale === 0 ? 0 : (Math.random() * 2 - 1) * scale;
            }
        }
        return matrix;
    }

    _countParameters() {
        let count = 0;
        this.layers.forEach((layer, i) => {
            count += layer.weights.length * layer.weights[0].length;
            count += layer.biases.length;
        });
        this.gatingLayers.forEach(gate => {
            count += gate.inputGate.weights.length * gate.inputGate.weights[0].length * 2;
            count += gate.inputGate.biases.length * 2;
        });
        const attDim = this.hiddenSizes[0];
        count += attDim * attDim * 4; // Q, K, V, Output
        return count;
    }

    // ====================================================================
    // ACTIVATION FUNCTIONS
    // ====================================================================

    leakyRelu(x, alpha = 0.01) {
        return x > 0 ? x : alpha * x;
    }

    leakyReluDerivative(x, alpha = 0.01) {
        return x > 0 ? 1 : alpha;
    }

    swish(x) {
        const sig = this.sigmoid(x);
        return x * sig;
    }

    swishDerivative(x) {
        const sig = this.sigmoid(x);
        return sig + x * sig * (1 - sig);
    }

    gelu(x) {
        // Approximation: 0.5 * x * (1 + tanh(sqrt(2/pi) * (x + 0.044715 * x^3)))
        const c = Math.sqrt(2 / Math.PI);
        const inner = c * (x + 0.044715 * x * x * x);
        return 0.5 * x * (1 + Math.tanh(inner));
    }

    geluDerivative(x) {
        const c = Math.sqrt(2 / Math.PI);
        const x3 = x * x * x;
        const inner = c * (x + 0.044715 * x3);
        const tanhInner = Math.tanh(inner);
        const sech2 = 1 - tanhInner * tanhInner;
        const dinnerDx = c * (1 + 3 * 0.044715 * x * x);
        return 0.5 * (1 + tanhInner) + 0.5 * x * sech2 * dinnerDx;
    }

    sigmoid(x) {
        const clipped = Math.max(-500, Math.min(500, x));
        return 1 / (1 + Math.exp(-clipped));
    }

    sigmoidDerivative(output) {
        return output * (1 - output);
    }

    softmax(arr) {
        const max = Math.max(...arr);
        const exps = arr.map(x => Math.exp(Math.min(x - max, 500)));
        const sum = exps.reduce((a, b) => a + b, 0);
        return exps.map(e => e / sum);
    }

    // ====================================================================
    // BATCH NORMALIZATION
    // ====================================================================

    batchNorm(values, layerKey, isTraining = true) {
        const params = this.batchNormParams[layerKey];
        if (!params) return values;

        const n = values.length;
        const result = new Array(n);

        if (isTraining) {
            // Compute batch statistics (single sample approximation)
            const mean = values.reduce((a, b) => a + b, 0) / n;
            const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n + this.epsilon;

            // Update running statistics
            for (let i = 0; i < n; i++) {
                params.runningMean[i] = (1 - params.momentum) * params.runningMean[i] +
                    params.momentum * values[i];
                params.runningVar[i] = (1 - params.momentum) * params.runningVar[i] +
                    params.momentum * ((values[i] - mean) ** 2);
            }

            // Normalize
            const std = Math.sqrt(variance);
            for (let i = 0; i < n; i++) {
                const normalized = (values[i] - mean) / std;
                result[i] = params.gamma[i] * normalized + params.beta[i];
            }
        } else {
            // Use running statistics for inference
            for (let i = 0; i < n; i++) {
                const normalized = (values[i] - params.runningMean[i]) /
                    Math.sqrt(params.runningVar[i] + this.epsilon);
                result[i] = params.gamma[i] * normalized + params.beta[i];
            }
        }

        return result;
    }

    // ====================================================================
    // ATTENTION MECHANISM
    // ====================================================================

    selfAttention(features) {
        const dim = features.length;
        const attDim = this.attentionWeights.query.length;

        // Ensure dimension compatibility
        if (dim !== attDim) return features;

        // Compute Q, K, V
        const Q = this._matVecMul(this.attentionWeights.query, features);
        const K = this._matVecMul(this.attentionWeights.key, features);
        const V = this._matVecMul(this.attentionWeights.value, features);

        // Scaled dot-product attention (self-attention with single vector)
        // We create a simple attention over feature dimensions
        const scaleFactor = Math.sqrt(dim);

        // Compute attention scores
        const attentionScores = new Array(dim);
        for (let i = 0; i < dim; i++) {
            attentionScores[i] = Q[i] * K[i] / scaleFactor;
        }

        // Softmax
        const attentionWeights = this.softmax(attentionScores);

        // Apply attention to values
        const attended = new Array(dim);
        for (let i = 0; i < dim; i++) {
            attended[i] = attentionWeights[i] * V[i];
        }

        // Output projection
        const output = this._matVecMul(this.attentionWeights.outputProj, attended);

        // Residual connection
        const result = new Array(dim);
        for (let i = 0; i < dim; i++) {
            result[i] = features[i] + output[i];
        }

        return { output: result, attentionWeights };
    }

    // ====================================================================
    // GATING MECHANISM (LSTM-INSPIRED)
    // ====================================================================

    applyGating(input, layerIdx, prevHidden) {
        const gate = this.gatingLayers[layerIdx];
        if (!gate) return input;

        const size = input.length;

        // Input gate: controls how much new information to let in
        const inputGateRaw = this._matVecMul(gate.inputGate.weights, input.length <= gate.inputGate.weights[0].length ? input : input.slice(0, gate.inputGate.weights[0].length));
        const inputGateVals = new Array(size);
        for (let i = 0; i < size; i++) {
            inputGateVals[i] = this.sigmoid(
                (i < inputGateRaw.length ? inputGateRaw[i] : 0) + gate.inputGate.biases[i]
            );
        }

        // Forget gate: controls how much of previous cell state to keep
        const prevState = gate.cellState;
        const forgetGateRaw = this._matVecMul(gate.forgetGate.weights, prevState);
        const forgetGateVals = new Array(size);
        for (let i = 0; i < size; i++) {
            forgetGateVals[i] = this.sigmoid(
                (i < forgetGateRaw.length ? forgetGateRaw[i] : 0) + gate.forgetGate.biases[i]
            );
        }

        // Update cell state
        const newCellState = new Array(size);
        for (let i = 0; i < size; i++) {
            newCellState[i] = forgetGateVals[i] * prevState[i] + inputGateVals[i] * input[i];
        }
        gate.cellState = newCellState;

        // Output: tanh(cell state) gated by input gate
        const output = new Array(size);
        for (let i = 0; i < size; i++) {
            output[i] = Math.tanh(newCellState[i]) * inputGateVals[i];
        }

        return output;
    }

    // ====================================================================
    // DROPOUT
    // ====================================================================

    applyDropout(values, isTraining = true) {
        if (!isTraining || this.dropoutRate === 0) return { values, mask: null };

        const mask = values.map(() => Math.random() > this.dropoutRate ? 1 : 0);
        const scale = 1 / (1 - this.dropoutRate);
        const dropped = values.map((v, i) => v * mask[i] * scale);

        return { values: dropped, mask };
    }

    // ====================================================================
    // FORWARD PASS
    // ====================================================================

    forward(input, isTraining = true) {
        if (input.length !== this.inputSize) {
            // Pad or truncate
            const adjusted = new Array(this.inputSize).fill(0);
            for (let i = 0; i < Math.min(input.length, this.inputSize); i++) {
                adjusted[i] = input[i];
            }
            input = adjusted;
        }

        const cache = {
            activations: [input],
            preActivations: [],
            gateValues: [],
            dropoutMasks: [],
            attentionCache: null,
            batchNormCache: [],
            residualInputs: [],
        };

        let current = input;
        const numLayers = this.layers.length;

        for (let i = 0; i < numLayers; i++) {
            const layer = this.layers[i];
            const isOutputLayer = i === numLayers - 1;
            const isFirstHidden = i === 0;

            // Linear transformation
            const preActivation = new Array(layer.weights.length);
            for (let j = 0; j < layer.weights.length; j++) {
                let sum = layer.biases[j];
                const weights_j = layer.weights[j];
                const inputLen = Math.min(current.length, weights_j.length);
                for (let k = 0; k < inputLen; k++) {
                    sum += current[k] * weights_j[k];
                }
                preActivation[j] = sum;
            }

            cache.preActivations.push(preActivation);

            let activated;

            if (isOutputLayer) {
                // Output layer: sigmoid for each output
                activated = preActivation.map(x => this.sigmoid(x));
            } else {
                // Hidden layers: Batch Norm → GELU → Gating → Dropout

                // Batch normalization
                const layerKey = `layer_${i}`;
                let normalized = this.batchNorm(preActivation, layerKey, isTraining);
                cache.batchNormCache.push(normalized);

                // GELU activation
                activated = normalized.map(x => this.gelu(x));

                // Apply gating mechanism
                if (i < this.gatingLayers.length) {
                    const gated = this.applyGating(activated, i, current);
                    cache.gateValues.push(gated);
                    activated = gated;
                }

                // Self-attention after first hidden layer
                if (isFirstHidden && activated.length === this.attentionWeights.query.length) {
                    const { output: attendedOutput, attentionWeights: attWeights } =
                        this.selfAttention(activated);
                    cache.attentionCache = attWeights;
                    activated = attendedOutput;
                }

                // Residual connection (if dimensions match or we have projection)
                if (i > 0 && i < numLayers - 1) {
                    const prevActivation = cache.activations[cache.activations.length - 1];
                    cache.residualInputs.push(prevActivation);

                    if (prevActivation.length === activated.length) {
                        // Direct residual
                        activated = activated.map((v, idx) => v + prevActivation[idx]);
                    } else if (this.residualProjections[i - 1]) {
                        // Projected residual
                        const projected = this._matVecMul(
                            this.residualProjections[i - 1].weights,
                            prevActivation
                        );
                        activated = activated.map((v, idx) =>
                            v + (idx < projected.length ? projected[idx] : 0)
                        );
                    }
                }

                // Dropout
                const { values: droppedOut, mask } = this.applyDropout(activated, isTraining);
                cache.dropoutMasks.push(mask);
                activated = droppedOut;
            }

            current = activated;
            cache.activations.push(current);
        }

        // Parse multi-head output
        const output = {
            survivalProb: current[0] || 0.5,
            confidence: current.length > 1 ? current[1] : 0.5,
            regimeScore: current.length > 2 ? current[2] : 0.5,
        };

        return { output, rawOutput: current, cache };
    }

    // ====================================================================
    // BACKWARD PASS WITH GRADIENT COMPUTATION
    // ====================================================================

    backward(cache, target) {
        const numLayers = this.layers.length;
        const gradients = {};

        // Target is [survivalTarget, confidenceTarget, regimeTarget]
        const targetArr = Array.isArray(target) ? target : [target, 0.5, 0.5];
        const outputActivation = cache.activations[cache.activations.length - 1];

        // Output layer gradient (BCE loss derivative)
        let delta = new Array(this.outputSize);
        for (let i = 0; i < this.outputSize; i++) {
            const output = outputActivation[i] || 0.5;
            const t = targetArr[i] || 0.5;
            // Clamp to prevent log(0)
            const clampedOutput = Math.max(1e-7, Math.min(1 - 1e-7, output));
            delta[i] = (clampedOutput - t); // BCE gradient
        }

        // Backpropagate through layers
        for (let i = numLayers - 1; i >= 0; i--) {
            const layer = this.layers[i];
            const prevActivation = cache.activations[i];
            const isOutputLayer = i === numLayers - 1;

            // Weight gradients
            gradients[`w_${i}`] = [];
            gradients[`b_${i}`] = [...delta];

            for (let j = 0; j < layer.weights.length; j++) {
                gradients[`w_${i}`][j] = [];
                for (let k = 0; k < layer.weights[j].length; k++) {
                    const grad = delta[j] * (k < prevActivation.length ? prevActivation[k] : 0);
                    // L2 regularization
                    gradients[`w_${i}`][j][k] = grad + this.l2Lambda * layer.weights[j][k];
                }
            }

            // Propagate gradient to previous layer
            if (i > 0) {
                const newDelta = new Array(prevActivation.length).fill(0);

                for (let k = 0; k < prevActivation.length; k++) {
                    let sum = 0;
                    for (let j = 0; j < delta.length; j++) {
                        if (k < layer.weights[j].length) {
                            sum += delta[j] * layer.weights[j][k];
                        }
                    }

                    // Apply activation derivative (GELU for hidden layers)
                    if (!isOutputLayer) {
                        const preAct = cache.preActivations[i - 1];
                        const preActVal = k < preAct.length ? preAct[k] : 0;
                        sum *= this.geluDerivative(preActVal);
                    }

                    // Apply dropout mask
                    const mask = cache.dropoutMasks[i - 1];
                    if (mask && k < mask.length) {
                        sum *= mask[k] ? (1 / (1 - this.dropoutRate)) : 0;
                    }

                    newDelta[k] = sum;
                }

                delta = newDelta;
            }

            // Batch norm gradients (simplified)
            if (!isOutputLayer && this.batchNormParams[`layer_${i}`]) {
                const bnParams = this.batchNormParams[`layer_${i}`];
                gradients[`bn_g_${i}`] = delta.map((d, idx) =>
                    idx < bnParams.gamma.length ? d * (cache.batchNormCache[i]?.[idx] || 0) : 0
                );
                gradients[`bn_b_${i}`] = delta.slice(0, bnParams.beta.length);
            }
        }

        // Gradient clipping
        this._clipGradients(gradients);

        return gradients;
    }

    // ====================================================================
    // ADAM OPTIMIZER UPDATE
    // ====================================================================

    updateWeightsAdam(gradients) {
        this.timestep++;

        // Learning rate schedule with warmup and decay
        let lr = this.learningRate;
        if (this.timestep < this.lrSchedule.warmup) {
            lr *= this.timestep / this.lrSchedule.warmup;
        } else {
            lr *= Math.pow(this.lrSchedule.decay, this.timestep - this.lrSchedule.warmup);
        }
        lr = Math.max(lr, this.lrSchedule.minLr);

        const bc1 = 1 - Math.pow(this.beta1, this.timestep);
        const bc2 = 1 - Math.pow(this.beta2, this.timestep);

        // Update main layer weights
        for (let i = 0; i < this.layers.length; i++) {
            const wKey = `w_${i}`;
            const bKey = `b_${i}`;

            if (gradients[wKey]) {
                for (let j = 0; j < this.layers[i].weights.length; j++) {
                    for (let k = 0; k < this.layers[i].weights[j].length; k++) {
                        if (gradients[wKey][j] && gradients[wKey][j][k] !== undefined) {
                            const g = gradients[wKey][j][k];

                            // Adam update
                            this.mWeights[wKey][j][k] = this.beta1 * this.mWeights[wKey][j][k] + (1 - this.beta1) * g;
                            this.vWeights[wKey][j][k] = this.beta2 * this.vWeights[wKey][j][k] + (1 - this.beta2) * g * g;

                            const mHat = this.mWeights[wKey][j][k] / bc1;
                            const vHat = this.vWeights[wKey][j][k] / bc2;

                            this.layers[i].weights[j][k] -= lr * mHat / (Math.sqrt(vHat) + this.epsilon);
                        }
                    }
                }
            }

            if (gradients[bKey]) {
                for (let j = 0; j < this.layers[i].biases.length; j++) {
                    if (gradients[bKey][j] !== undefined) {
                        const g = gradients[bKey][j];

                        this.mWeights[bKey][j] = this.beta1 * this.mWeights[bKey][j] + (1 - this.beta1) * g;
                        this.vWeights[bKey][j] = this.beta2 * this.vWeights[bKey][j] + (1 - this.beta2) * g * g;

                        const mHat = this.mWeights[bKey][j] / bc1;
                        const vHat = this.vWeights[bKey][j] / bc2;

                        this.layers[i].biases[j] -= lr * mHat / (Math.sqrt(vHat) + this.epsilon);
                    }
                }
            }

            // Update batch norm parameters
            const bnGKey = `bn_g_${i}`;
            const bnBKey = `bn_b_${i}`;
            if (gradients[bnGKey] && this.batchNormParams[`layer_${i}`]) {
                const bnParams = this.batchNormParams[`layer_${i}`];
                for (let j = 0; j < bnParams.gamma.length; j++) {
                    if (gradients[bnGKey][j] !== undefined) {
                        this.mWeights[bnGKey][j] = this.beta1 * (this.mWeights[bnGKey][j] || 0) + (1 - this.beta1) * gradients[bnGKey][j];
                        this.vWeights[bnGKey][j] = this.beta2 * (this.vWeights[bnGKey][j] || 0) + (1 - this.beta2) * gradients[bnGKey][j] ** 2;
                        const mH = this.mWeights[bnGKey][j] / bc1;
                        const vH = this.vWeights[bnGKey][j] / bc2;
                        bnParams.gamma[j] -= lr * mH / (Math.sqrt(vH) + this.epsilon);
                    }
                }
                for (let j = 0; j < bnParams.beta.length; j++) {
                    if (gradients[bnBKey] && gradients[bnBKey][j] !== undefined) {
                        this.mWeights[bnBKey][j] = this.beta1 * (this.mWeights[bnBKey][j] || 0) + (1 - this.beta1) * gradients[bnBKey][j];
                        this.vWeights[bnBKey][j] = this.beta2 * (this.vWeights[bnBKey][j] || 0) + (1 - this.beta2) * gradients[bnBKey][j] ** 2;
                        const mH = this.mWeights[bnBKey][j] / bc1;
                        const vH = this.vWeights[bnBKey][j] / bc2;
                        bnParams.beta[j] -= lr * mH / (Math.sqrt(vH) + this.epsilon);
                    }
                }
            }
        }
    }

    // ====================================================================
    // GRADIENT CLIPPING
    // ====================================================================

    _clipGradients(gradients) {
        let totalNorm = 0;

        // Compute total gradient norm
        Object.values(gradients).forEach(grad => {
            if (Array.isArray(grad)) {
                grad.forEach(row => {
                    if (Array.isArray(row)) {
                        row.forEach(val => { totalNorm += val * val; });
                    } else if (typeof row === 'number') {
                        totalNorm += row * row;
                    }
                });
            }
        });

        totalNorm = Math.sqrt(totalNorm);

        if (totalNorm > this.maxGradNorm) {
            const clipCoeff = this.maxGradNorm / totalNorm;

            Object.keys(gradients).forEach(key => {
                if (Array.isArray(gradients[key])) {
                    gradients[key] = gradients[key].map(row => {
                        if (Array.isArray(row)) {
                            return row.map(val => val * clipCoeff);
                        } else if (typeof row === 'number') {
                            return row * clipCoeff;
                        }
                        return row;
                    });
                }
            });
        }
    }

    // ====================================================================
    // MATRIX-VECTOR MULTIPLICATION
    // ====================================================================

    _matVecMul(matrix, vector) {
        const result = new Array(matrix.length);
        for (let i = 0; i < matrix.length; i++) {
            let sum = 0;
            const row = matrix[i];
            const len = Math.min(row.length, vector.length);
            for (let j = 0; j < len; j++) {
                sum += row[j] * vector[j];
            }
            result[i] = sum;
        }
        return result;
    }

    // ====================================================================
    // EXPERIENCE REPLAY
    // ====================================================================

    addToReplayBuffer(input, target) {
        this.replayBuffer.push({ input, target, timestamp: Date.now() });

        if (this.replayBuffer.length > this.replayBufferSize) {
            // Remove oldest experiences, but keep some for diversity
            this.replayBuffer.splice(0, Math.floor(this.replayBufferSize * 0.1));
        }
    }

    trainFromReplay() {
        if (this.replayBuffer.length < this.miniBatchSize) return;

        let totalLoss = 0;
        const batchSize = Math.min(this.miniBatchSize, this.replayBuffer.length);

        for (let epoch = 0; epoch < this.trainingEpochsPerUpdate; epoch++) {
            // Sample random mini-batch with prioritized recent samples
            const batch = this._samplePrioritizedBatch(batchSize);

            batch.forEach(sample => {
                const { output, rawOutput, cache } = this.forward(sample.input, true);
                const gradients = this.backward(cache, sample.target);
                this.updateWeightsAdam(gradients);

                // Calculate loss
                const targetArr = Array.isArray(sample.target) ? sample.target : [sample.target, 0.5, 0.5];
                let loss = 0;
                for (let i = 0; i < rawOutput.length; i++) {
                    const o = Math.max(1e-7, Math.min(1 - 1e-7, rawOutput[i]));
                    const t = targetArr[i] || 0.5;
                    loss -= t * Math.log(o) + (1 - t) * Math.log(1 - o);
                }
                totalLoss += loss;
            });
        }

        return totalLoss / (batchSize * this.trainingEpochsPerUpdate);
    }

    _samplePrioritizedBatch(batchSize) {
        const buffer = this.replayBuffer;
        const n = buffer.length;
        const batch = [];

        // 70% recent, 30% random for diversity
        const recentCount = Math.floor(batchSize * 0.7);
        const randomCount = batchSize - recentCount;

        // Recent samples
        const recentStart = Math.max(0, n - Math.floor(n * 0.3));
        for (let i = 0; i < recentCount; i++) {
            const idx = recentStart + Math.floor(Math.random() * (n - recentStart));
            batch.push(buffer[idx]);
        }

        // Random samples for diversity
        for (let i = 0; i < randomCount; i++) {
            const idx = Math.floor(Math.random() * n);
            batch.push(buffer[idx]);
        }

        return batch;
    }

    // ====================================================================
    // TRAINING INTERFACE
    // ====================================================================

    trainOnSample(input, target) {
        // Forward pass
        const { output, rawOutput, cache } = this.forward(input, true);

        // Backward pass
        const targetArr = Array.isArray(target) ? target : [target, 0.5, 0.5];
        const gradients = this.backward(cache, targetArr);

        // Update weights
        this.updateWeightsAdam(gradients);

        // Calculate BCE loss
        let loss = 0;
        for (let i = 0; i < rawOutput.length; i++) {
            const o = Math.max(1e-7, Math.min(1 - 1e-7, rawOutput[i]));
            const t = targetArr[i] || 0.5;
            loss -= t * Math.log(o) + (1 - t) * Math.log(1 - o);
        }
        loss /= rawOutput.length;

        // Add to replay buffer
        this.addToReplayBuffer(input, targetArr);

        // Periodically train from replay buffer
        if (this.timestep % 10 === 0) {
            this.trainFromReplay();
        }

        // Track training history
        this.trainingHistory.push({
            loss,
            prediction: output.survivalProb,
            target: targetArr[0],
            timestamp: Date.now()
        });

        if (this.trainingHistory.length > 2000) {
            this.trainingHistory = this.trainingHistory.slice(-1500);
        }

        // Track rolling accuracy
        const correct = (output.survivalProb >= 0.5) === (targetArr[0] >= 0.5);
        this.rollingAccuracy.push(correct ? 1 : 0);
        if (this.rollingAccuracy.length > 200) {
            this.rollingAccuracy.shift();
        }

        // Early stopping check
        if (this.rollingAccuracy.length >= 100) {
            const currentAccuracy = this.rollingAccuracy.slice(-100).reduce((a, b) => a + b, 0) / 100;
            if (currentAccuracy > this.bestAccuracy) {
                this.bestAccuracy = currentAccuracy;
                this.epochsSinceImprovement = 0;
            } else {
                this.epochsSinceImprovement++;
            }

            // If no improvement, reduce learning rate
            if (this.epochsSinceImprovement > this.earlyStoppingPatience) {
                this.learningRate *= 0.5;
                this.learningRate = Math.max(this.learningRate, this.lrSchedule.minLr);
                this.epochsSinceImprovement = 0;
                console.log(`🧠 Learning rate reduced to ${this.learningRate.toFixed(6)}`);
            }
        }

        return { loss, prediction: output.survivalProb };
    }

    // ====================================================================
    // PREDICTION INTERFACE
    // ====================================================================

    predict(input) {
        const { output } = this.forward(input, false); // isTraining = false
        return output.survivalProb;
    }

    predictFull(input) {
        const { output } = this.forward(input, false);
        return output;
    }

    predictWithUncertainty(input, numSamples = 20) {
        const predictions = [];
        const confidences = [];
        const regimes = [];

        for (let i = 0; i < numSamples; i++) {
            // Monte Carlo Dropout: keep isTraining = true for dropout
            const { output } = this.forward(input, true);
            predictions.push(output.survivalProb);
            confidences.push(output.confidence);
            regimes.push(output.regimeScore);
        }

        const mean = predictions.reduce((a, b) => a + b, 0) / numSamples;
        const variance = predictions.reduce((a, b) => a + (b - mean) ** 2, 0) / numSamples;
        const std = Math.sqrt(variance);

        const meanConfidence = confidences.reduce((a, b) => a + b, 0) / numSamples;
        const meanRegime = regimes.reduce((a, b) => a + b, 0) / numSamples;

        // Predictive entropy (measure of total uncertainty)
        const predictiveEntropy = -(
            mean * Math.log(Math.max(1e-7, mean)) +
            (1 - mean) * Math.log(Math.max(1e-7, 1 - mean))
        );

        // Epistemic uncertainty (model uncertainty from MC Dropout)
        const epistemicUncertainty = variance;

        // Aleatoric uncertainty (inherent data noise)
        const aleatoricUncertainty = Math.max(0, predictiveEntropy - epistemicUncertainty);

        return {
            prediction: mean,
            uncertainty: std,
            confidence: Math.max(0, 1 - std * 3), // Scale to [0, 1]
            epistemicUncertainty,
            aleatoricUncertainty,
            predictiveEntropy,
            modelConfidence: meanConfidence,
            regimeScore: meanRegime,
            numSamples,
            percentiles: {
                p5: this._percentile(predictions, 5),
                p25: this._percentile(predictions, 25),
                p50: this._percentile(predictions, 50),
                p75: this._percentile(predictions, 75),
                p95: this._percentile(predictions, 95),
            }
        };
    }

    _percentile(arr, p) {
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, idx)];
    }

    // ====================================================================
    // ADVANCED FEATURE ENGINEERING
    // ====================================================================

    prepareFeatures(tickHistory, runLengths, currentRunLength, volatility) {
        const features = [];

        // === Section 1: Last 30 digits (normalized) [30 features] ===
        const recentDigits = tickHistory.slice(-30);
        while (recentDigits.length < 30) recentDigits.unshift(5);
        recentDigits.forEach(d => features.push(d / 9));

        // === Section 2: Digit frequency distribution [10 features] ===
        const digitFreq = new Array(10).fill(0);
        const last100 = tickHistory.slice(-100);
        last100.forEach(d => digitFreq[d]++);
        const total = Math.max(1, last100.length);
        digitFreq.forEach(f => features.push(f / total));

        // === Section 3: Run length statistics [12 features] ===
        const recentRuns = runLengths.slice(-30);
        while (recentRuns.length < 30) recentRuns.unshift(5);

        const runMean = recentRuns.reduce((a, b) => a + b, 0) / recentRuns.length;
        const runStd = Math.sqrt(recentRuns.reduce((a, b) => a + (b - runMean) ** 2, 0) / recentRuns.length);
        const runMin = Math.min(...recentRuns);
        const runMax = Math.max(...recentRuns);
        const runMedian = this._percentile(recentRuns, 50);
        const runSkewness = recentRuns.reduce((a, b) => a + Math.pow((b - runMean) / (runStd || 1), 3), 0) / recentRuns.length;
        const runKurtosis = recentRuns.reduce((a, b) => a + Math.pow((b - runMean) / (runStd || 1), 4), 0) / recentRuns.length - 3;

        features.push(runMean / 50);
        features.push(runStd / 20);
        features.push(runMin / 50);
        features.push(runMax / 50);
        features.push(runMedian / 50);
        features.push(Math.tanh(runSkewness / 3)); // Normalize skewness
        features.push(Math.tanh(runKurtosis / 10)); // Normalize kurtosis
        features.push(currentRunLength / 50);
        features.push(Math.min(1, currentRunLength / (runMean || 1))); // Relative to mean

        // Coefficient of variation
        features.push(runStd / (runMean || 1));

        // Percentiles of run lengths
        features.push(this._percentile(recentRuns, 25) / 50);
        features.push(this._percentile(recentRuns, 75) / 50);

        // === Section 4: Trend features [8 features] ===
        const shortWindow = recentRuns.slice(-5);
        const medWindow = recentRuns.slice(-10);
        const longWindow = recentRuns.slice(-20);

        const shortMean = shortWindow.reduce((a, b) => a + b, 0) / shortWindow.length;
        const medMean = medWindow.reduce((a, b) => a + b, 0) / medWindow.length;
        const longMean = longWindow.reduce((a, b) => a + b, 0) / longWindow.length;

        // Moving average crossovers
        features.push(Math.tanh((shortMean - medMean) / 10));
        features.push(Math.tanh((shortMean - longMean) / 10));
        features.push(Math.tanh((medMean - longMean) / 10));

        // Rate of change
        if (recentRuns.length >= 2) {
            features.push(Math.tanh((recentRuns[recentRuns.length - 1] - recentRuns[recentRuns.length - 2]) / 10));
        } else {
            features.push(0);
        }

        // Acceleration
        if (recentRuns.length >= 3) {
            const vel1 = recentRuns[recentRuns.length - 1] - recentRuns[recentRuns.length - 2];
            const vel2 = recentRuns[recentRuns.length - 2] - recentRuns[recentRuns.length - 3];
            features.push(Math.tanh((vel1 - vel2) / 10));
        } else {
            features.push(0);
        }

        // Streak detection
        let currentStreak = 0;
        let streakDirection = 0; // 1 = increasing, -1 = decreasing
        for (let i = recentRuns.length - 1; i > 0; i--) {
            if (recentRuns[i] > recentRuns[i - 1]) {
                if (streakDirection === 1 || streakDirection === 0) {
                    currentStreak++;
                    streakDirection = 1;
                } else break;
            } else if (recentRuns[i] < recentRuns[i - 1]) {
                if (streakDirection === -1 || streakDirection === 0) {
                    currentStreak++;
                    streakDirection = -1;
                } else break;
            } else break;
        }
        features.push(currentStreak / 10);
        features.push(streakDirection * 0.5 + 0.5); // Normalize to [0, 1]

        // Volatility of volatility (stability of run length distribution)
        const runVolatilities = [];
        for (let i = 5; i < recentRuns.length; i++) {
            const window = recentRuns.slice(i - 5, i);
            const wMean = window.reduce((a, b) => a + b, 0) / window.length;
            const wStd = Math.sqrt(window.reduce((a, b) => a + (b - wMean) ** 2, 0) / window.length);
            runVolatilities.push(wStd);
        }
        if (runVolatilities.length > 0) {
            const volOfVol = Math.sqrt(
                runVolatilities.reduce((a, b) => a + (b - runVolatilities.reduce((x, y) => x + y, 0) / runVolatilities.length) ** 2, 0) /
                runVolatilities.length
            );
            features.push(Math.min(1, volOfVol / 10));
        } else {
            features.push(0.5);
        }

        // === Section 5: Volatility and entropy [5 features] ===
        features.push(typeof volatility === 'object' ? volatility.combined || 0.5 : volatility);

        // Digit transition entropy
        const transitionCounts = {};
        for (let i = 1; i < last100.length; i++) {
            const key = `${last100[i - 1]}_${last100[i]}`;
            transitionCounts[key] = (transitionCounts[key] || 0) + 1;
        }
        const transTotal = Math.max(1, last100.length - 1);
        let transEntropy = 0;
        Object.values(transitionCounts).forEach(c => {
            const p = c / transTotal;
            if (p > 0) transEntropy -= p * Math.log2(p);
        });
        features.push(transEntropy / Math.log2(100)); // Normalize

        // Auto-correlation at lag 1
        const meanDigit = last100.reduce((a, b) => a + b, 0) / last100.length;
        let autoCorr = 0;
        let variance2 = 0;
        for (let i = 1; i < last100.length; i++) {
            autoCorr += (last100[i] - meanDigit) * (last100[i - 1] - meanDigit);
            variance2 += (last100[i] - meanDigit) ** 2;
        }
        features.push(variance2 > 0 ? Math.tanh(autoCorr / variance2) : 0);

        // Recent short run ratio
        const shortRunCount = recentRuns.filter(r => r <= 3).length;
        features.push(shortRunCount / recentRuns.length);

        // Recent long run ratio
        const longRunCount = recentRuns.filter(r => r >= 10).length;
        features.push(longRunCount / recentRuns.length);

        // === Section 6: Time-based features [5 features] ===
        const now = new Date();
        features.push(now.getHours() / 23); // Hour of day
        features.push(now.getMinutes() / 59); // Minute
        features.push(now.getDay() / 6); // Day of week
        features.push(Math.sin(2 * Math.PI * now.getHours() / 24)); // Cyclic hour
        features.push(Math.cos(2 * Math.PI * now.getHours() / 24)); // Cyclic hour

        // === Normalize features ===
        this._updateFeatureStats(features);

        const normalizedFeatures = this._normalizeFeatures(features);

        // Pad or truncate to input size
        while (normalizedFeatures.length < this.inputSize) {
            normalizedFeatures.push(0);
        }

        return normalizedFeatures.slice(0, this.inputSize);
    }

    _updateFeatureStats(features) {
        if (!this.featureStats.means) {
            this.featureStats.means = [...features];
            this.featureStats.stds = features.map(() => 1);
            this.featureStats.count = 1;
            return;
        }

        const alpha = 0.01; // Exponential moving average factor
        for (let i = 0; i < features.length && i < this.featureStats.means.length; i++) {
            this.featureStats.means[i] = (1 - alpha) * this.featureStats.means[i] + alpha * features[i];
            const diff = features[i] - this.featureStats.means[i];
            this.featureStats.stds[i] = Math.sqrt(
                (1 - alpha) * (this.featureStats.stds[i] ** 2) + alpha * diff * diff
            );
        }
        this.featureStats.count++;
    }

    _normalizeFeatures(features) {
        if (!this.featureStats.means || this.featureStats.count < 10) {
            return features; // Not enough data for reliable normalization
        }

        return features.map((f, i) => {
            if (i < this.featureStats.means.length) {
                const std = Math.max(this.featureStats.stds[i], 1e-7);
                return (f - this.featureStats.means[i]) / std;
            }
            return f;
        });
    }

    // ====================================================================
    // PERFORMANCE METRICS
    // ====================================================================

    getPerformanceMetrics() {
        if (this.trainingHistory.length < 10) {
            return {
                accuracy: 0,
                recentLoss: 1,
                trend: 'insufficient_data',
                learningRate: this.learningRate,
                bestAccuracy: this.bestAccuracy,
                replayBufferSize: this.replayBuffer.length,
            };
        }

        const recent = this.trainingHistory.slice(-200);
        const avgLoss = recent.reduce((a, b) => a + b.loss, 0) / recent.length;

        // Binary accuracy
        const correct = recent.filter(h =>
            (h.prediction >= 0.5 && h.target >= 0.5) ||
            (h.prediction < 0.5 && h.target < 0.5)
        ).length;
        const accuracy = correct / recent.length;

        // Trend analysis
        const firstHalf = recent.slice(0, Math.floor(recent.length / 2));
        const secondHalf = recent.slice(Math.floor(recent.length / 2));
        const firstLoss = firstHalf.reduce((a, b) => a + b.loss, 0) / firstHalf.length;
        const secondLoss = secondHalf.reduce((a, b) => a + b.loss, 0) / secondHalf.length;

        const trend = secondLoss < firstLoss * 0.9 ? 'improving' :
            secondLoss > firstLoss * 1.1 ? 'degrading' : 'stable';

        // Calibration (how well probabilities match outcomes)
        const calibrationBins = {};
        recent.forEach(h => {
            const bin = Math.floor(h.prediction * 10) / 10;
            if (!calibrationBins[bin]) calibrationBins[bin] = { count: 0, positive: 0 };
            calibrationBins[bin].count++;
            if (h.target >= 0.5) calibrationBins[bin].positive++;
        });

        let calibrationError = 0;
        let calibrationCount = 0;
        Object.entries(calibrationBins).forEach(([bin, stats]) => {
            if (stats.count >= 5) {
                const expectedProb = parseFloat(bin) + 0.05;
                const actualProb = stats.positive / stats.count;
                calibrationError += Math.abs(expectedProb - actualProb);
                calibrationCount++;
            }
        });
        const avgCalibrationError = calibrationCount > 0 ? calibrationError / calibrationCount : 0.5;

        return {
            accuracy,
            recentLoss: avgLoss,
            trend,
            learningRate: this.learningRate,
            bestAccuracy: this.bestAccuracy,
            replayBufferSize: this.replayBuffer.length,
            totalTrainingSamples: this.timestep,
            calibrationError: avgCalibrationError,
            epochsSinceImprovement: this.epochsSinceImprovement,
        };
    }

    // ====================================================================
    // STATE PERSISTENCE
    // ====================================================================

    exportWeights() {
        return {
            layers: this.layers.map(l => ({
                weights: l.weights,
                biases: l.biases,
            })),
            gatingLayers: this.gatingLayers.map(g => ({
                inputGate: { weights: g.inputGate.weights, biases: g.inputGate.biases },
                forgetGate: { weights: g.forgetGate.weights, biases: g.forgetGate.biases },
                cellState: g.cellState,
            })),
            attentionWeights: this.attentionWeights,
            batchNormParams: this.batchNormParams,
            residualProjections: this.residualProjections,
            mWeights: this.mWeights,
            vWeights: this.vWeights,
            timestep: this.timestep,
            learningRate: this.learningRate,
            bestAccuracy: this.bestAccuracy,
            epochsSinceImprovement: this.epochsSinceImprovement,
            featureStats: this.featureStats,
            trainingHistory: this.trainingHistory.slice(-500),
            rollingAccuracy: this.rollingAccuracy.slice(-200),
            // Don't export full replay buffer to save space - keep last 500
            replayBuffer: this.replayBuffer.slice(-500),
        };
    }

    importWeights(state) {
        try {
            if (state.layers) {
                state.layers.forEach((savedLayer, i) => {
                    if (this.layers[i]) {
                        this.layers[i].weights = savedLayer.weights;
                        this.layers[i].biases = savedLayer.biases;
                    }
                });
            }

            if (state.gatingLayers) {
                state.gatingLayers.forEach((savedGate, i) => {
                    if (this.gatingLayers[i]) {
                        this.gatingLayers[i].inputGate.weights = savedGate.inputGate.weights;
                        this.gatingLayers[i].inputGate.biases = savedGate.inputGate.biases;
                        this.gatingLayers[i].forgetGate.weights = savedGate.forgetGate.weights;
                        this.gatingLayers[i].forgetGate.biases = savedGate.forgetGate.biases;
                        this.gatingLayers[i].cellState = savedGate.cellState;
                    }
                });
            }

            if (state.attentionWeights) this.attentionWeights = state.attentionWeights;
            if (state.batchNormParams) this.batchNormParams = state.batchNormParams;
            if (state.residualProjections) this.residualProjections = state.residualProjections;
            if (state.mWeights) this.mWeights = state.mWeights;
            if (state.vWeights) this.vWeights = state.vWeights;
            if (state.timestep) this.timestep = state.timestep;
            if (state.learningRate) this.learningRate = state.learningRate;
            if (state.bestAccuracy) this.bestAccuracy = state.bestAccuracy;
            if (state.epochsSinceImprovement) this.epochsSinceImprovement = state.epochsSinceImprovement;
            if (state.featureStats) this.featureStats = state.featureStats;
            if (state.trainingHistory) this.trainingHistory = state.trainingHistory;
            if (state.rollingAccuracy) this.rollingAccuracy = state.rollingAccuracy;
            if (state.replayBuffer) this.replayBuffer = state.replayBuffer;

            this.initialized = true;
            console.log(`  ✓ Advanced neural network restored (${this.timestep} training steps, best accuracy: ${(this.bestAccuracy * 100).toFixed(1)}%)`);
        } catch (error) {
            console.error(`  ✗ Error importing neural network state: ${error.message}`);
            console.log('  ↻ Re-initializing network...');
            this.initializeNetwork();
        }
    }
}

// ============================================================================
// TIER 4: ADVANCED ENSEMBLE DECISION MAKER
// ============================================================================

class EnsembleDecisionMaker {
    constructor() {
        // ================================================================
        // MODEL REGISTRY
        // ================================================================
        this.registeredModels = [
            'kaplanMeier', 'bayesian', 'markov', 'neural', 'pattern'
        ];

        // ================================================================
        // DYNAMIC WEIGHTS
        // ================================================================
        this.modelWeights = {};
        this.registeredModels.forEach(m => { this.modelWeights[m] = 1 / this.registeredModels.length; });

        // Per-model performance tracking with recency weighting
        this.modelPerformance = {};
        this.registeredModels.forEach(m => {
            this.modelPerformance[m] = {
                correct: 0,
                total: 0,
                recentCorrect: [],    // sliding window of booleans
                recentPredictions: [], // sliding window of {prediction, actual, timestamp}
                calibration: {        // calibration bins
                    bins: {},
                    totalSamples: 0,
                },
                streaks: {
                    currentCorrect: 0,
                    currentWrong: 0,
                    maxCorrect: 0,
                    maxWrong: 0,
                },
                regimePerformance: {},    // performance per market regime
                timeOfDayPerformance: {}, // performance per hour
                confidencePerformance: {  // performance at different confidence levels
                    high: { correct: 0, total: 0 },
                    medium: { correct: 0, total: 0 },
                    low: { correct: 0, total: 0 },
                },
            };
        });

        // ================================================================
        // STACKING META-LEARNER
        // ================================================================
        this.stackingWeights = null;
        this.stackingBias = 0;
        this.stackingHistory = [];
        this.stackingLearningRate = 0.01;
        this.stackingMomentum = 0.9;
        this.stackingVelocity = null;

        // ================================================================
        // CONTEXTUAL BANDIT
        // ================================================================
        this.banditState = {};
        this.registeredModels.forEach(m => {
            this.banditState[m] = {
                alpha: 1,  // successes
                beta: 1,   // failures
                pulls: 0,
            };
        });
        this.banditExplorationRate = 0.15;
        this.banditDecayRate = 0.995;

        // ================================================================
        // CONFIDENCE CALIBRATION (Platt Scaling)
        // ================================================================
        this.calibrationParams = {};
        this.registeredModels.forEach(m => {
            this.calibrationParams[m] = { a: 1, b: 0 }; // sigmoid: 1/(1+exp(a*x+b))
        });
        this.calibrationHistory = {};
        this.registeredModels.forEach(m => {
            this.calibrationHistory[m] = [];
        });

        // ================================================================
        // MODEL CORRELATION TRACKING
        // ================================================================
        this.modelPredictionHistory = {};
        this.registeredModels.forEach(m => {
            this.modelPredictionHistory[m] = [];
        });
        this.correlationMatrix = {};

        // ================================================================
        // DECISION HISTORY & JOURNALING
        // ================================================================
        this.recentDecisions = [];
        this.decisionJournal = [];
        this.counterfactualLog = [];

        // ================================================================
        // THRESHOLD MANAGEMENT
        // ================================================================
        this.adaptiveThreshold = 0.7;
        this.thresholdHistory = [];
        this.thresholdOptimizer = {
            candidates: [0.55, 0.60, 0.625, 0.65, 0.675, 0.70, 0.725, 0.75, 0.775, 0.80, 0.825, 0.85],
            performance: {},
            bayesianParams: {},
        };
        this.thresholdOptimizer.candidates.forEach(t => {
            this.thresholdOptimizer.performance[t] = { wins: 0, losses: 0, trades: 0, pnl: 0 };
            this.thresholdOptimizer.bayesianParams[t] = { alpha: 1, beta: 1 };
        });

        // ================================================================
        // MULTI-TIMEFRAME STATE
        // ================================================================
        this.timeframeWindows = {
            short: 30,
            medium: 100,
            long: 300,
        };
        this.timeframePerformance = {};
        Object.keys(this.timeframeWindows).forEach(tf => {
            this.timeframePerformance[tf] = {
                decisions: [],
                winRate: 0.5,
                avgScore: 0.5,
            };
        });

        // ================================================================
        // CASCADING PIPELINE
        // ================================================================
        this.cascadeStages = [
            { name: 'safety_check', threshold: 0.30, action: 'reject' },
            { name: 'minimum_agreement', minAgreement: 0.25, action: 'reject' },
            { name: 'confidence_gate', minConfidence: 0.35, action: 'reject' },
            { name: 'regime_filter', blockedRegimes: ['volatile', 'unpredictable'], action: 'reject' },
            { name: 'final_decision', threshold: null, action: 'evaluate' }, // uses adaptive
        ];

        // ================================================================
        // RISK MANAGEMENT
        // ================================================================
        this.riskMetrics = {
            kellyFraction: 0,
            sharpeRatio: 0,
            maxDrawdown: 0,
            currentDrawdown: 0,
            peakPnL: 0,
            volatilityOfReturns: 0,
            winStreak: 0,
            lossStreak: 0,
            returnsHistory: [],
        };

        // ================================================================
        // CONFIGURATION
        // ================================================================
        this.config = {
            recentWindowSize: 100,
            minSamplesForWeightUpdate: 15,
            weightUpdateInterval: 5,
            correlationWindowSize: 50,
            calibrationInterval: 25,
            stackingMinSamples: 30,
            maxDecisionHistory: 1000,
            maxJournalSize: 500,
            kellyFractionalMultiplier: 0.25, // Quarter-Kelly for safety
            thresholdSmoothingFactor: 0.15,
            minModelsForDecision: 2,
            diversityBonus: 0.05,
        };
    }

    // ====================================================================
    // MAIN DECISION PIPELINE
    // ====================================================================

    /**
     * Primary entry point: combine predictions through cascading pipeline
     */
    combinePredicitions(predictions, context = {}) {
        const startTime = Date.now();

        // Step 0: Validate and filter predictions
        const validPredictions = this._validatePredictions(predictions);
        const numValidModels = Object.keys(validPredictions).length;

        if (numValidModels < this.config.minModelsForDecision) {
            return this._createDecisionResult(0.5, 0, false, 'insufficient_models', {}, context);
        }

        // Step 1: Calibrate raw predictions
        const calibratedPredictions = this._calibratePredictions(validPredictions);

        // Step 2: Run cascading pipeline
        const cascadeResult = this._runCascadePipeline(calibratedPredictions, context);
        if (cascadeResult.rejected) {
            return this._createDecisionResult(
                cascadeResult.score, cascadeResult.agreement, false,
                `cascade_rejected:${cascadeResult.stage}`, cascadeResult.details, context
            );
        }

        // Step 3: Compute ensemble score using multiple combination methods
        const weightedScore = this._weightedAverageScore(calibratedPredictions);
        const stackingScore = this._stackingScore(calibratedPredictions);
        const banditScore = this._banditWeightedScore(calibratedPredictions);
        const rankScore = this._rankBasedScore(calibratedPredictions);

        // Step 4: Combine combination methods (meta-ensemble)
        const metaWeights = this._getMetaCombinationWeights();
        const ensembleScore =
            metaWeights.weighted * weightedScore.score +
            metaWeights.stacking * stackingScore.score +
            metaWeights.bandit * banditScore.score +
            metaWeights.rank * rankScore.score;

        // Step 5: Compute agreement and diversity metrics
        const agreementMetrics = this._computeAgreementMetrics(calibratedPredictions);

        // Step 6: Multi-timeframe consensus
        const timeframeConsensus = this._multiTimeframeConsensus(ensembleScore, context);

        // Step 7: Risk-adjusted decision
        const riskAdjustedScore = this._applyRiskAdjustment(ensembleScore, agreementMetrics);

        // Step 8: Final threshold comparison
        const effectiveThreshold = this._getEffectiveThreshold(context);
        const shouldTrade =
            riskAdjustedScore >= effectiveThreshold &&
            agreementMetrics.calibratedAgreement > 0.35 &&
            timeframeConsensus.consensus >= 0.5;

        // Build detailed decision breakdown
        const details = {
            rawScores: {},
            calibratedScores: {},
            combinationMethods: {
                weighted: weightedScore,
                stacking: stackingScore,
                bandit: banditScore,
                rank: rankScore,
            },
            metaWeights,
            agreementMetrics,
            timeframeConsensus,
            riskAdjustedScore,
            effectiveThreshold,
            cascadeResult,
            processingTimeMs: Date.now() - startTime,
        };

        Object.entries(validPredictions).forEach(([model, pred]) => {
            details.rawScores[model] = pred.value;
        });
        Object.entries(calibratedPredictions).forEach(([model, pred]) => {
            details.calibratedScores[model] = pred.calibratedValue;
        });

        return this._createDecisionResult(
            riskAdjustedScore, agreementMetrics.calibratedAgreement,
            shouldTrade, shouldTrade ? 'approved' : 'below_threshold',
            details, context
        );
    }

    // ====================================================================
    // PREDICTION VALIDATION & CALIBRATION
    // ====================================================================

    _validatePredictions(predictions) {
        const valid = {};

        Object.entries(predictions).forEach(([model, pred]) => {
            if (pred !== null && pred !== undefined &&
                typeof pred === 'object' &&
                typeof pred.value === 'number' &&
                !isNaN(pred.value) &&
                pred.value >= 0 && pred.value <= 1) {

                valid[model] = {
                    ...pred,
                    confidence: Math.max(0, Math.min(1, pred.confidence || 0.5)),
                };
            }
        });

        return valid;
    }

    _calibratePredictions(predictions) {
        const calibrated = {};

        Object.entries(predictions).forEach(([model, pred]) => {
            const params = this.calibrationParams[model] || { a: 1, b: 0 };
            const rawValue = pred.value;

            // Platt scaling: calibrated = sigmoid(a * raw + b)
            const logit = params.a * rawValue + params.b;
            const calibratedValue = 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, logit))));

            calibrated[model] = {
                ...pred,
                rawValue,
                calibratedValue,
                calibratedConfidence: Math.max(0, Math.min(1,
                    pred.confidence * (1 - this._getCalibrationError(model))
                )),
            };
        });

        return calibrated;
    }

    _getCalibrationError(model) {
        const history = this.calibrationHistory[model];
        if (!history || history.length < 20) return 0.3;

        // Expected Calibration Error (ECE)
        const bins = {};
        history.slice(-100).forEach(h => {
            const bin = Math.floor(h.prediction * 10) / 10;
            if (!bins[bin]) bins[bin] = { predicted: 0, actual: 0, count: 0 };
            bins[bin].predicted += h.prediction;
            bins[bin].actual += h.actual ? 1 : 0;
            bins[bin].count++;
        });

        let ece = 0;
        let totalCount = 0;
        Object.values(bins).forEach(bin => {
            if (bin.count >= 3) {
                const avgPred = bin.predicted / bin.count;
                const avgActual = bin.actual / bin.count;
                ece += Math.abs(avgPred - avgActual) * bin.count;
                totalCount += bin.count;
            }
        });

        return totalCount > 0 ? ece / totalCount : 0.3;
    }

    // ====================================================================
    // CASCADING DECISION PIPELINE
    // ====================================================================

    _runCascadePipeline(predictions, context) {
        const values = Object.values(predictions).map(p => p.calibratedValue);
        const meanScore = values.reduce((a, b) => a + b, 0) / values.length;

        // Stage 1: Safety check - reject if average score too low
        if (meanScore < this.cascadeStages[0].threshold) {
            return {
                rejected: true,
                stage: 'safety_check',
                score: meanScore,
                agreement: 0,
                details: { meanScore, threshold: this.cascadeStages[0].threshold },
            };
        }

        // Stage 2: Minimum agreement
        const range = Math.max(...values) - Math.min(...values);
        const agreement = 1 - range;
        if (agreement < this.cascadeStages[1].minAgreement) {
            return {
                rejected: true,
                stage: 'minimum_agreement',
                score: meanScore,
                agreement,
                details: { range, agreement, minRequired: this.cascadeStages[1].minAgreement },
            };
        }

        // Stage 3: Confidence gate
        const avgConfidence = Object.values(predictions)
            .reduce((a, p) => a + p.calibratedConfidence, 0) / Object.keys(predictions).length;
        if (avgConfidence < this.cascadeStages[2].minConfidence) {
            return {
                rejected: true,
                stage: 'confidence_gate',
                score: meanScore,
                agreement,
                details: { avgConfidence, minRequired: this.cascadeStages[2].minConfidence },
            };
        }

        // Stage 4: Regime filter
        if (context.regime && this.cascadeStages[3].blockedRegimes.includes(context.regime)) {
            const regimeConfidence = context.regimeConfidence || 0;
            if (regimeConfidence > 0.5) {
                return {
                    rejected: true,
                    stage: 'regime_filter',
                    score: meanScore,
                    agreement,
                    details: { regime: context.regime, regimeConfidence },
                };
            }
        }

        return {
            rejected: false,
            score: meanScore,
            agreement,
            details: { passedAllStages: true, avgConfidence },
        };
    }

    // ====================================================================
    // COMBINATION METHODS
    // ====================================================================

    /**
     * Method 1: Dynamic Weighted Average with recency-aware weights
     */
    _weightedAverageScore(predictions) {
        let weightedSum = 0;
        let totalWeight = 0;
        const contributions = {};

        Object.entries(predictions).forEach(([model, pred]) => {
            const baseWeight = this.modelWeights[model] || (1 / this.registeredModels.length);
            const confidenceMultiplier = 0.5 + 0.5 * pred.calibratedConfidence;

            // Recency-adjusted accuracy
            const recentAccuracy = this._getRecentAccuracy(model, 50);
            const accuracyMultiplier = 0.3 + 0.7 * recentAccuracy;

            const effectiveWeight = baseWeight * confidenceMultiplier * accuracyMultiplier;

            weightedSum += pred.calibratedValue * effectiveWeight;
            totalWeight += effectiveWeight;

            contributions[model] = {
                value: pred.calibratedValue,
                weight: effectiveWeight,
                contribution: pred.calibratedValue * effectiveWeight,
                recentAccuracy,
            };
        });

        const score = totalWeight > 0 ? weightedSum / totalWeight : 0.5;

        return { score, contributions, totalWeight };
    }

    /**
     * Method 2: Stacking Meta-Learner (logistic regression on model outputs)
     */
    _stackingScore(predictions) {
        const modelKeys = this.registeredModels;
        const numModels = modelKeys.length;

        // Initialize stacking weights if needed
        if (!this.stackingWeights) {
            this.stackingWeights = new Array(numModels).fill(1 / numModels);
            this.stackingVelocity = new Array(numModels).fill(0);
        }

        // Build input vector from predictions
        const inputVector = modelKeys.map(model => {
            const pred = predictions[model];
            return pred ? pred.calibratedValue : 0.5;
        });

        // Linear combination + sigmoid
        let logit = this.stackingBias;
        for (let i = 0; i < numModels; i++) {
            logit += this.stackingWeights[i] * inputVector[i];
        }

        const score = 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, logit))));

        return {
            score,
            logit,
            weights: [...this.stackingWeights],
            bias: this.stackingBias,
            hasSufficientData: this.stackingHistory.length >= this.config.stackingMinSamples,
        };
    }

    /**
     * Method 3: Contextual Bandit Weighted Score (Thompson Sampling)
     */
    _banditWeightedScore(predictions) {
        const sampledWeights = {};
        let totalSampled = 0;

        // Thompson Sampling: draw from Beta posteriors
        Object.entries(this.banditState).forEach(([model, state]) => {
            const sample = this._betaSample(state.alpha, state.beta);
            sampledWeights[model] = sample;
            totalSampled += sample;
        });

        // Normalize
        if (totalSampled > 0) {
            Object.keys(sampledWeights).forEach(m => {
                sampledWeights[m] /= totalSampled;
            });
        }

        let score = 0;
        Object.entries(predictions).forEach(([model, pred]) => {
            const weight = sampledWeights[model] || (1 / this.registeredModels.length);
            score += pred.calibratedValue * weight;
        });

        return {
            score,
            sampledWeights,
            explorationRate: this.banditExplorationRate,
        };
    }

    /**
     * Method 4: Rank-Based Aggregation (Borda Count inspired)
     */
    _rankBasedScore(predictions) {
        const models = Object.keys(predictions);
        const n = models.length;

        if (n === 0) return { score: 0.5 };

        // Rank predictions
        const sorted = models
            .map(m => ({ model: m, value: predictions[m].calibratedValue }))
            .sort((a, b) => b.value - a.value);

        // Assign ranks (higher prediction = higher rank)
        const ranks = {};
        sorted.forEach((item, idx) => {
            ranks[item.model] = (n - idx) / n; // Normalized to [0, 1]
        });

        // Weight by model reliability
        let weightedRankSum = 0;
        let totalWeight = 0;

        Object.entries(ranks).forEach(([model, rank]) => {
            const reliability = this._getRecentAccuracy(model, 30);
            const weight = 0.3 + 0.7 * reliability;
            weightedRankSum += rank * weight;
            totalWeight += weight;
        });

        // Combine rank score with mean prediction
        const rankScore = totalWeight > 0 ? weightedRankSum / totalWeight : 0.5;
        const meanPred = Object.values(predictions)
            .reduce((a, p) => a + p.calibratedValue, 0) / n;

        // Blend rank score with mean (rank provides ordering, mean provides scale)
        const score = 0.4 * rankScore + 0.6 * meanPred;

        return { score, ranks, meanPrediction: meanPred };
    }

    /**
     * Get meta-combination weights (how much to trust each combination method)
     */
    _getMetaCombinationWeights() {
        // Start with equal weights and adjust based on stacking availability
        const weights = {
            weighted: 0.35,
            stacking: 0.25,
            bandit: 0.20,
            rank: 0.20,
        };

        // Reduce stacking weight if insufficient training data
        if (this.stackingHistory.length < this.config.stackingMinSamples) {
            const deficit = weights.stacking * 0.6;
            weights.stacking *= 0.4;
            weights.weighted += deficit * 0.5;
            weights.bandit += deficit * 0.3;
            weights.rank += deficit * 0.2;
        }

        // Normalize
        const sum = Object.values(weights).reduce((a, b) => a + b, 0);
        Object.keys(weights).forEach(k => { weights[k] /= sum; });

        return weights;
    }

    // ====================================================================
    // AGREEMENT & DIVERSITY METRICS
    // ====================================================================

    _computeAgreementMetrics(predictions) {
        const values = Object.values(predictions).map(p => p.calibratedValue);
        const confidences = Object.values(predictions).map(p => p.calibratedConfidence);
        const n = values.length;

        if (n < 2) {
            return {
                rawAgreement: 0,
                calibratedAgreement: 0,
                diversity: 0,
                unanimity: false,
                splitDecision: false,
            };
        }

        // Range-based agreement
        const range = Math.max(...values) - Math.min(...values);
        const rawAgreement = 1 - range;

        // Standard deviation-based agreement
        const mean = values.reduce((a, b) => a + b, 0) / n;
        const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
        const stdAgreement = Math.max(0, 1 - std * 3); // Scale so std=0.33 → agreement=0

        // Confidence-weighted agreement
        let confWeightedMean = 0;
        let confTotalWeight = 0;
        values.forEach((v, i) => {
            confWeightedMean += v * confidences[i];
            confTotalWeight += confidences[i];
        });
        confWeightedMean = confTotalWeight > 0 ? confWeightedMean / confTotalWeight : mean;

        let confWeightedVar = 0;
        values.forEach((v, i) => {
            confWeightedVar += confidences[i] * (v - confWeightedMean) ** 2;
        });
        confWeightedVar = confTotalWeight > 0 ? confWeightedVar / confTotalWeight : std * std;
        const calibratedAgreement = Math.max(0, 1 - Math.sqrt(confWeightedVar) * 3);

        // Direction agreement: how many models agree on trade/no-trade
        const threshold = 0.5;
        const bullish = values.filter(v => v >= threshold).length;
        const bearish = values.filter(v => v < threshold).length;
        const directionAgreement = Math.max(bullish, bearish) / n;

        // Check unanimity (all models agree on direction)
        const unanimity = bullish === n || bearish === n;

        // Split decision (close to 50/50)
        const splitDecision = Math.abs(bullish - bearish) <= 1 && n > 2;

        // Diversity score (model correlation-based)
        const diversity = this._computePredictionDiversity(predictions);

        // Effective number of independent models
        // (accounts for correlation between models)
        const effectiveModels = diversity > 0 ? n * diversity : 1;

        return {
            rawAgreement,
            stdAgreement,
            calibratedAgreement,
            directionAgreement,
            unanimity,
            splitDecision,
            diversity,
            effectiveModels,
            mean,
            std,
            range,
            bullishCount: bullish,
            bearishCount: bearish,
        };
    }

    /**
     * Compute prediction diversity using pairwise correlation analysis
     */
    _computePredictionDiversity(predictions) {
        const models = Object.keys(predictions);
        const n = models.length;

        if (n < 2) return 0;

        // Check historical correlation
        let totalCorrelation = 0;
        let pairCount = 0;

        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const m1 = models[i];
                const m2 = models[j];
                const key = `${m1}_${m2}`;

                if (this.correlationMatrix[key] !== undefined) {
                    totalCorrelation += Math.abs(this.correlationMatrix[key]);
                    pairCount++;
                } else {
                    // Use current prediction similarity as proxy
                    const v1 = predictions[m1].calibratedValue;
                    const v2 = predictions[m2].calibratedValue;
                    totalCorrelation += 1 - Math.abs(v1 - v2);
                    pairCount++;
                }
            }
        }

        const avgCorrelation = pairCount > 0 ? totalCorrelation / pairCount : 0.5;
        const diversity = 1 - avgCorrelation; // Higher = more diverse

        return Math.max(0, Math.min(1, diversity));
    }

    /**
     * Update model correlation matrix
     */
    _updateCorrelationMatrix() {
        const windowSize = this.config.correlationWindowSize;
        const models = this.registeredModels;

        for (let i = 0; i < models.length; i++) {
            for (let j = i + 1; j < models.length; j++) {
                const m1 = models[i];
                const m2 = models[j];
                const key = `${m1}_${m2}`;

                const history1 = this.modelPredictionHistory[m1] || [];
                const history2 = this.modelPredictionHistory[m2] || [];

                const len = Math.min(history1.length, history2.length, windowSize);
                if (len < 10) continue;

                const recent1 = history1.slice(-len);
                const recent2 = history2.slice(-len);

                // Pearson correlation
                const mean1 = recent1.reduce((a, b) => a + b, 0) / len;
                const mean2 = recent2.reduce((a, b) => a + b, 0) / len;

                let cov = 0, var1 = 0, var2 = 0;
                for (let k = 0; k < len; k++) {
                    const d1 = recent1[k] - mean1;
                    const d2 = recent2[k] - mean2;
                    cov += d1 * d2;
                    var1 += d1 * d1;
                    var2 += d2 * d2;
                }

                const denom = Math.sqrt(var1 * var2);
                this.correlationMatrix[key] = denom > 0 ? cov / denom : 0;
            }
        }
    }

    // ====================================================================
    // MULTI-TIMEFRAME CONSENSUS
    // ====================================================================

    _multiTimeframeConsensus(currentScore, context) {
        const result = {};
        let consensusScore = 0;
        let totalWeight = 0;

        Object.entries(this.timeframeWindows).forEach(([tf, windowSize]) => {
            const tfData = this.timeframePerformance[tf];
            const recent = tfData.decisions.slice(-windowSize);

            if (recent.length >= 5) {
                const avgScore = recent.reduce((a, d) => a + d.score, 0) / recent.length;
                const wins = recent.filter(d => d.outcome === true).length;
                const total = recent.filter(d => d.outcome !== undefined).length;
                const winRate = total > 0 ? wins / total : 0.5;

                // Weight by recency and number of samples
                const weight = Math.min(1, recent.length / windowSize) *
                    (tf === 'short' ? 1.5 : tf === 'medium' ? 1.0 : 0.7);

                result[tf] = {
                    avgScore,
                    winRate,
                    sampleSize: recent.length,
                    weight,
                };

                consensusScore += winRate * weight;
                totalWeight += weight;
            } else {
                result[tf] = { avgScore: 0.5, winRate: 0.5, sampleSize: 0, weight: 0 };
            }
        });

        const consensus = totalWeight > 0 ? consensusScore / totalWeight : 0.5;

        // Check for timeframe disagreement
        const tfValues = Object.values(result).filter(r => r.sampleSize >= 5);
        const tfDisagreement = tfValues.length >= 2 ?
            Math.max(...tfValues.map(r => r.winRate)) - Math.min(...tfValues.map(r => r.winRate)) : 0;

        return {
            consensus,
            timeframes: result,
            hasDisagreement: tfDisagreement > 0.2,
            disagreementMagnitude: tfDisagreement,
        };
    }

    // ====================================================================
    // RISK-ADJUSTED SCORING
    // ====================================================================

    _applyRiskAdjustment(score, agreementMetrics) {
        let adjusted = score;

        // 1. Diversity bonus: reward decisions where diverse models agree
        if (agreementMetrics.diversity > 0.3 && agreementMetrics.calibratedAgreement > 0.5) {
            adjusted += this.config.diversityBonus * agreementMetrics.diversity;
        }

        // 2. Drawdown penalty: reduce score during drawdowns
        if (this.riskMetrics.currentDrawdown > 0.1) {
            const drawdownPenalty = Math.min(0.15,
                this.riskMetrics.currentDrawdown * 0.3);
            adjusted -= drawdownPenalty;
        }

        // 3. Loss streak penalty
        if (this.riskMetrics.lossStreak >= 2) {
            adjusted -= 0.03 * this.riskMetrics.lossStreak;
        }

        // 4. Win streak dampening (regression to mean)
        if (this.riskMetrics.winStreak >= 5) {
            adjusted -= 0.02 * (this.riskMetrics.winStreak - 4);
        }

        // 5. Volatility of returns adjustment
        if (this.riskMetrics.volatilityOfReturns > 0.5) {
            adjusted -= (this.riskMetrics.volatilityOfReturns - 0.5) * 0.1;
        }

        // 6. Split decision penalty
        if (agreementMetrics.splitDecision) {
            adjusted -= 0.05;
        }

        // 7. Unanimity bonus
        if (agreementMetrics.unanimity && agreementMetrics.calibratedAgreement > 0.7) {
            adjusted += 0.03;
        }

        return Math.max(0, Math.min(1, adjusted));
    }

    /**
     * Compute Kelly Criterion fraction for position sizing
     */
    computeKellyFraction() {
        const recent = this.recentDecisions.slice(-100)
            .filter(d => d.outcome !== undefined);

        if (recent.length < 20) return 0.02;

        const wins = recent.filter(d => d.outcome === true).length;
        const losses = recent.length - wins;
        const winRate = wins / recent.length;
        const avgWinSize = 0.01; // Accumulator typical win
        const avgLossSize = 1.0; // Full stake loss

        // Kelly formula: f = (bp - q) / b
        // where b = avgWin/avgLoss, p = winRate, q = 1-p
        const b = avgWinSize / avgLossSize;
        const kelly = (b * winRate - (1 - winRate)) / b;

        // Apply fractional Kelly for safety
        const fractionalKelly = Math.max(0, kelly * this.config.kellyFractionalMultiplier);

        this.riskMetrics.kellyFraction = fractionalKelly;

        return fractionalKelly;
    }

    // ====================================================================
    // THRESHOLD MANAGEMENT
    // ====================================================================

    _getEffectiveThreshold(context) {
        let threshold = this.adaptiveThreshold;

        // Context-based adjustments
        if (context.consecutiveLosses >= 2) {
            threshold += 0.03 * context.consecutiveLosses;
        }

        if (context.regime === 'volatile' || context.regime === 'choppy') {
            threshold += 0.05;
        } else if (context.regime === 'stable') {
            threshold -= 0.02;
        }

        // Time-of-day adjustment
        const hour = new Date().getHours();
        if (hour >= 22 || hour <= 4) {
            threshold += 0.02; // Slightly more conservative at night
        }

        // Drawdown adjustment
        if (this.riskMetrics.currentDrawdown > 0.15) {
            threshold += 0.05;
        }

        return Math.max(0.5, Math.min(0.95, threshold));
    }

    /**
     * Optimize threshold using Bayesian optimization approach
     */
    optimizeThreshold() {
        if (this.recentDecisions.length < 30) return;

        // Update performance for each candidate threshold
        this.thresholdOptimizer.candidates.forEach(threshold => {
            let wins = 0, losses = 0, trades = 0;

            this.recentDecisions.slice(-200).forEach(decision => {
                if (decision.score >= threshold && decision.outcome !== undefined) {
                    trades++;
                    if (decision.outcome) wins++;
                    else losses++;
                }
            });

            this.thresholdOptimizer.performance[threshold] = {
                wins, losses, trades,
                winRate: trades > 0 ? wins / trades : 0,
                frequency: trades / Math.max(1, this.recentDecisions.slice(-200).length),
            };

            // Update Bayesian parameters
            this.thresholdOptimizer.bayesianParams[threshold] = {
                alpha: 1 + wins,
                beta: 1 + losses,
            };
        });

        // Find optimal threshold using expected improvement
        let bestThreshold = this.adaptiveThreshold;
        let bestEI = -Infinity;

        this.thresholdOptimizer.candidates.forEach(threshold => {
            const params = this.thresholdOptimizer.bayesianParams[threshold];
            const perf = this.thresholdOptimizer.performance[threshold];

            if (perf.trades < 5) return;

            // Expected value: mean of Beta distribution
            const expectedWinRate = params.alpha / (params.alpha + params.beta);

            // Confidence: concentration parameter
            const concentration = params.alpha + params.beta;
            const confidenceFactor = Math.min(1, concentration / 50);

            // Trade frequency penalty (too selective = fewer trades = less learning)
            const frequencyFactor = Math.sqrt(Math.min(1, perf.frequency * 5));

            // Expected improvement score
            const ei = expectedWinRate * confidenceFactor * frequencyFactor;

            if (ei > bestEI) {
                bestEI = ei;
                bestThreshold = threshold;
            }
        });

        // Smooth transition
        this.adaptiveThreshold = (1 - this.config.thresholdSmoothingFactor) * this.adaptiveThreshold +
            this.config.thresholdSmoothingFactor * bestThreshold;

        this.thresholdHistory.push({
            threshold: this.adaptiveThreshold,
            bestCandidate: bestThreshold,
            bestEI,
            timestamp: Date.now(),
        });

        if (this.thresholdHistory.length > 200) {
            this.thresholdHistory = this.thresholdHistory.slice(-150);
        }
    }

    // ====================================================================
    // OUTCOME RECORDING & LEARNING
    // ====================================================================

    /**
     * Record outcome and update all learning components
     */
    recordOutcome(predictions, actualOutcome, context = {}) {
        const validPredictions = this._validatePredictions(predictions);

        // 1. Update per-model performance
        this._updateModelPerformance(validPredictions, actualOutcome, context);

        // 2. Update model weights
        if (this._shouldUpdateWeights()) {
            this._updateDynamicWeights();
        }

        // 3. Update stacking meta-learner
        this._updateStackingLearner(validPredictions, actualOutcome);

        // 4. Update contextual bandit
        this._updateBandit(validPredictions, actualOutcome);

        // 5. Update calibration
        this._updateCalibration(validPredictions, actualOutcome);

        // 6. Update correlation matrix periodically
        if (this.recentDecisions.length % 10 === 0) {
            this._updateCorrelationMatrix();
        }

        // 7. Record prediction history for correlation tracking
        Object.entries(validPredictions).forEach(([model, pred]) => {
            if (!this.modelPredictionHistory[model]) {
                this.modelPredictionHistory[model] = [];
            }
            this.modelPredictionHistory[model].push(pred.value);
            if (this.modelPredictionHistory[model].length > 200) {
                this.modelPredictionHistory[model] = this.modelPredictionHistory[model].slice(-150);
            }
        });

        // 8. Update risk metrics
        this._updateRiskMetrics(actualOutcome, context);

        // 9. Update multi-timeframe data
        this._updateTimeframeData(validPredictions, actualOutcome);

        // 10. Decision journaling with counterfactual
        this._journalDecision(validPredictions, actualOutcome, context);

        // 11. Optimize threshold periodically
        if (this.recentDecisions.length % this.config.weightUpdateInterval === 0) {
            this.optimizeThreshold();
        }

        // 12. Record in decision history
        const calibrated = this._calibratePredictions(validPredictions);
        const values = Object.values(calibrated).map(p => p.calibratedValue);
        const score = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0.5;

        this.recentDecisions.push({
            predictions: validPredictions,
            outcome: actualOutcome,
            score,
            timestamp: Date.now(),
            context,
        });

        if (this.recentDecisions.length > this.config.maxDecisionHistory) {
            this.recentDecisions = this.recentDecisions.slice(
                -Math.floor(this.config.maxDecisionHistory * 0.8)
            );
        }
    }

    // ====================================================================
    // MODEL PERFORMANCE TRACKING
    // ====================================================================

    _updateModelPerformance(predictions, outcome, context) {
        Object.entries(predictions).forEach(([model, pred]) => {
            if (!this.modelPerformance[model]) {
                this.modelPerformance[model] = this._createDefaultModelPerf();
            }

            const perf = this.modelPerformance[model];
            const predicted = pred.value >= 0.5;
            const correct = predicted === outcome;

            // Overall stats
            perf.total++;
            if (correct) perf.correct++;

            // Recent sliding window
            perf.recentCorrect.push(correct ? 1 : 0);
            if (perf.recentCorrect.length > this.config.recentWindowSize) {
                perf.recentCorrect.shift();
            }

            perf.recentPredictions.push({
                prediction: pred.value,
                actual: outcome,
                correct,
                confidence: pred.confidence,
                timestamp: Date.now(),
            });
            if (perf.recentPredictions.length > this.config.recentWindowSize) {
                perf.recentPredictions.shift();
            }

            // Streaks
            if (correct) {
                perf.streaks.currentCorrect++;
                perf.streaks.currentWrong = 0;
                perf.streaks.maxCorrect = Math.max(perf.streaks.maxCorrect, perf.streaks.currentCorrect);
            } else {
                perf.streaks.currentWrong++;
                perf.streaks.currentCorrect = 0;
                perf.streaks.maxWrong = Math.max(perf.streaks.maxWrong, perf.streaks.currentWrong);
            }

            // Regime-specific performance
            if (context.regime) {
                if (!perf.regimePerformance[context.regime]) {
                    perf.regimePerformance[context.regime] = { correct: 0, total: 0 };
                }
                perf.regimePerformance[context.regime].total++;
                if (correct) perf.regimePerformance[context.regime].correct++;
            }

            // Time-of-day performance
            const hour = new Date().getHours();
            const hourKey = `h${hour}`;
            if (!perf.timeOfDayPerformance[hourKey]) {
                perf.timeOfDayPerformance[hourKey] = { correct: 0, total: 0 };
            }
            perf.timeOfDayPerformance[hourKey].total++;
            if (correct) perf.timeOfDayPerformance[hourKey].correct++;

            // Confidence-bucketed performance
            const confBucket = pred.confidence > 0.7 ? 'high' :
                pred.confidence > 0.4 ? 'medium' : 'low';
            perf.confidencePerformance[confBucket].total++;
            if (correct) perf.confidencePerformance[confBucket].correct++;
        });
    }

    _createDefaultModelPerf() {
        return {
            correct: 0,
            total: 0,
            recentCorrect: [],
            recentPredictions: [],
            calibration: { bins: {}, totalSamples: 0 },
            streaks: { currentCorrect: 0, currentWrong: 0, maxCorrect: 0, maxWrong: 0 },
            regimePerformance: {},
            timeOfDayPerformance: {},
            confidencePerformance: {
                high: { correct: 0, total: 0 },
                medium: { correct: 0, total: 0 },
                low: { correct: 0, total: 0 },
            },
        };
    }

    _getRecentAccuracy(model, window = 50) {
        const perf = this.modelPerformance[model];
        if (!perf || perf.recentCorrect.length < 5) return 0.5;

        const recent = perf.recentCorrect.slice(-window);
        return recent.reduce((a, b) => a + b, 0) / recent.length;
    }

    _shouldUpdateWeights() {
        const totalSamples = Object.values(this.modelPerformance)
            .reduce((a, p) => a + p.total, 0);
        return totalSamples >= this.config.minSamplesForWeightUpdate &&
            totalSamples % this.config.weightUpdateInterval === 0;
    }

    // ====================================================================
    // DYNAMIC WEIGHT UPDATES
    // ====================================================================

    _updateDynamicWeights() {
        const accuracies = {};
        let totalScore = 0;

        this.registeredModels.forEach(model => {
            const perf = this.modelPerformance[model];
            if (!perf || perf.total < 10) {
                accuracies[model] = 0.5;
            } else {
                // Blend overall and recent accuracy
                const overallAcc = perf.correct / perf.total;
                const recentAcc = this._getRecentAccuracy(model, 30);

                // Recency-weighted blend
                const blendedAcc = 0.3 * overallAcc + 0.7 * recentAcc;

                // Bonus for consistent performance (low streak variance)
                const consistencyBonus = perf.streaks.maxWrong <= 3 ? 0.05 : 0;

                accuracies[model] = Math.max(0.01, blendedAcc + consistencyBonus);
            }

            // Softmax-like exponential weighting (sharper differentiation)
            const temperature = 2.0; // Higher = more differentiation
            totalScore += Math.pow(accuracies[model], temperature);
        });

        // Normalize
        if (totalScore > 0) {
            this.registeredModels.forEach(model => {
                const temperature = 2.0;
                this.modelWeights[model] = Math.pow(accuracies[model], temperature) / totalScore;
            });
        }
    }

    // ====================================================================
    // STACKING META-LEARNER UPDATE
    // ====================================================================

    _updateStackingLearner(predictions, outcome) {
        const modelKeys = this.registeredModels;
        const numModels = modelKeys.length;

        if (!this.stackingWeights) {
            this.stackingWeights = new Array(numModels).fill(1 / numModels);
            this.stackingVelocity = new Array(numModels).fill(0);
        }

        // Build input vector
        const inputVector = modelKeys.map(model => {
            const pred = predictions[model];
            return pred ? pred.value : 0.5;
        });

        // Forward pass
        let logit = this.stackingBias;
        for (let i = 0; i < numModels; i++) {
            logit += this.stackingWeights[i] * inputVector[i];
        }
        const predicted = 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, logit))));

        // Gradient (BCE loss derivative)
        const target = outcome ? 1 : 0;
        const error = predicted - target;

        // Update weights with momentum
        for (let i = 0; i < numModels; i++) {
            const gradient = error * inputVector[i];

            this.stackingVelocity[i] = this.stackingMomentum * this.stackingVelocity[i] -
                this.stackingLearningRate * gradient;

            this.stackingWeights[i] += this.stackingVelocity[i];

            // Clamp weights
            this.stackingWeights[i] = Math.max(-5, Math.min(5, this.stackingWeights[i]));
        }

        // Update bias
        this.stackingBias -= this.stackingLearningRate * error;
        this.stackingBias = Math.max(-3, Math.min(3, this.stackingBias));

        // Track history
        this.stackingHistory.push({
            input: inputVector,
            prediction: predicted,
            target,
            loss: -target * Math.log(Math.max(1e-7, predicted)) -
                (1 - target) * Math.log(Math.max(1e-7, 1 - predicted)),
        });

        if (this.stackingHistory.length > 500) {
            this.stackingHistory = this.stackingHistory.slice(-400);
        }
    }

    // ====================================================================
    // CONTEXTUAL BANDIT UPDATE
    // ====================================================================

    _updateBandit(predictions, outcome) {
        Object.entries(predictions).forEach(([model, pred]) => {
            if (!this.banditState[model]) {
                this.banditState[model] = { alpha: 1, beta: 1, pulls: 0 };
            }

            const predicted = pred.value >= 0.5;
            const correct = predicted === outcome;

            this.banditState[model].pulls++;

            if (correct) {
                this.banditState[model].alpha += 1;
            } else {
                this.banditState[model].beta += 1;
            }

            // Decay to prevent over-confidence from old data
            this.banditState[model].alpha *= this.banditDecayRate;
            this.banditState[model].beta *= this.banditDecayRate;

            // Enforce minimums
            this.banditState[model].alpha = Math.max(1, this.banditState[model].alpha);
            this.banditState[model].beta = Math.max(1, this.banditState[model].beta);
        });

        // Decay exploration rate
        this.banditExplorationRate = Math.max(0.05,
            this.banditExplorationRate * 0.999);
    }

    // ====================================================================
    // CALIBRATION UPDATE
    // ====================================================================

    _updateCalibration(predictions, outcome) {
        Object.entries(predictions).forEach(([model, pred]) => {
            if (!this.calibrationHistory[model]) {
                this.calibrationHistory[model] = [];
            }

            this.calibrationHistory[model].push({
                prediction: pred.value,
                actual: outcome,
            });

            if (this.calibrationHistory[model].length > 300) {
                this.calibrationHistory[model] = this.calibrationHistory[model].slice(-250);
            }

            // Refit Platt scaling periodically
            if (this.calibrationHistory[model].length % this.config.calibrationInterval === 0 &&
                this.calibrationHistory[model].length >= 30) {
                this._fitPlattScaling(model);
            }
        });
    }

    /**
     * Fit Platt scaling parameters using gradient descent
     */
    _fitPlattScaling(model) {
        const history = this.calibrationHistory[model];
        if (!history || history.length < 20) return;

        let a = this.calibrationParams[model].a;
        let b = this.calibrationParams[model].b;
        const lr = 0.01;

        // Mini-batch gradient descent
        for (let epoch = 0; epoch < 30; epoch++) {
            let gradA = 0, gradB = 0;

            const batch = history.slice(-100);
            batch.forEach(sample => {
                const logit = a * sample.prediction + b;
                const calibrated = 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, logit))));
                const target = sample.actual ? 1 : 0;
                const error = calibrated - target;

                gradA += error * sample.prediction;
                gradB += error;
            });

            gradA /= batch.length;
            gradB /= batch.length;

            a -= lr * gradA;
            b -= lr * gradB;

            // Clamp
            a = Math.max(0.1, Math.min(5, a));
            b = Math.max(-3, Math.min(3, b));
        }

        this.calibrationParams[model] = { a, b };
    }

    // ====================================================================
    // RISK METRICS UPDATE
    // ====================================================================

    _updateRiskMetrics(outcome, context) {
        const pnl = outcome ? (context.stake || 1) * 0.01 : -(context.stake || 1);

        // Returns history
        this.riskMetrics.returnsHistory.push(pnl);
        if (this.riskMetrics.returnsHistory.length > 500) {
            this.riskMetrics.returnsHistory = this.riskMetrics.returnsHistory.slice(-400);
        }

        // Cumulative PnL
        const cumPnL = this.riskMetrics.returnsHistory.reduce((a, b) => a + b, 0);

        // Update peak and drawdown
        if (cumPnL > this.riskMetrics.peakPnL) {
            this.riskMetrics.peakPnL = cumPnL;
        }
        this.riskMetrics.currentDrawdown = this.riskMetrics.peakPnL > 0 ?
            (this.riskMetrics.peakPnL - cumPnL) / this.riskMetrics.peakPnL : 0;
        this.riskMetrics.maxDrawdown = Math.max(
            this.riskMetrics.maxDrawdown,
            this.riskMetrics.currentDrawdown
        );

        // Streaks
        if (outcome) {
            this.riskMetrics.winStreak++;
            this.riskMetrics.lossStreak = 0;
        } else {
            this.riskMetrics.lossStreak++;
            this.riskMetrics.winStreak = 0;
        }

        // Volatility of returns
        if (this.riskMetrics.returnsHistory.length >= 10) {
            const returns = this.riskMetrics.returnsHistory.slice(-50);
            const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / returns.length;
            this.riskMetrics.volatilityOfReturns = Math.sqrt(variance);

            // Sharpe ratio (annualized approximation)
            const riskFreeRate = 0;
            this.riskMetrics.sharpeRatio = this.riskMetrics.volatilityOfReturns > 0 ?
                (meanReturn - riskFreeRate) / this.riskMetrics.volatilityOfReturns : 0;
        }

        // Update Kelly
        this.computeKellyFraction();
    }

    // ====================================================================
    // MULTI-TIMEFRAME UPDATE
    // ====================================================================

    _updateTimeframeData(predictions, outcome) {
        const values = Object.values(predictions).map(p => p.value);
        const score = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0.5;

        Object.keys(this.timeframeWindows).forEach(tf => {
            this.timeframePerformance[tf].decisions.push({
                score,
                outcome,
                timestamp: Date.now(),
            });

            const maxSize = this.timeframeWindows[tf] * 2;
            if (this.timeframePerformance[tf].decisions.length > maxSize) {
                this.timeframePerformance[tf].decisions =
                    this.timeframePerformance[tf].decisions.slice(-this.timeframeWindows[tf]);
            }
        });
    }

    // ====================================================================
    // DECISION JOURNALING
    // ====================================================================

    _journalDecision(predictions, outcome, context) {
        const calibrated = this._calibratePredictions(predictions);
        const values = Object.values(calibrated).map(p => p.calibratedValue);
        const score = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0.5;

        const entry = {
            timestamp: Date.now(),
            predictions: {},
            outcome,
            score,
            threshold: this.adaptiveThreshold,
            wouldHaveTraded: score >= this.adaptiveThreshold,
            actuallyTraded: context.traded || false,
            context: {
                regime: context.regime,
                consecutiveLosses: context.consecutiveLosses,
            },
        };

        Object.entries(predictions).forEach(([model, pred]) => {
            entry.predictions[model] = {
                raw: pred.value,
                calibrated: calibrated[model] ? calibrated[model].calibratedValue : pred.value,
                confidence: pred.confidence,
                correct: (pred.value >= 0.5) === outcome,
            };
        });

        // Counterfactual analysis: what if we used a different threshold?
        const counterfactual = {};
        [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85].forEach(t => {
            const wouldTrade = score >= t;
            counterfactual[t] = {
                wouldTrade,
                correctDecision: (wouldTrade && outcome) || (!wouldTrade && !outcome),
            };
        });
        entry.counterfactual = counterfactual;

        this.decisionJournal.push(entry);
        if (this.decisionJournal.length > this.config.maxJournalSize) {
            this.decisionJournal = this.decisionJournal.slice(
                -Math.floor(this.config.maxJournalSize * 0.8)
            );
        }

        // Aggregate counterfactual log
        this.counterfactualLog.push(counterfactual);
        if (this.counterfactualLog.length > 500) {
            this.counterfactualLog = this.counterfactualLog.slice(-400);
        }
    }

    // ====================================================================
    // RESULT CONSTRUCTION
    // ====================================================================

    _createDecisionResult(score, agreement, shouldTrade, reason, details, context) {
        return {
            score,
            agreement,
            shouldTrade,
            reason,
            details,
            threshold: this.adaptiveThreshold,
            riskMetrics: {
                kellyFraction: this.riskMetrics.kellyFraction,
                currentDrawdown: this.riskMetrics.currentDrawdown,
                sharpeRatio: this.riskMetrics.sharpeRatio,
                winStreak: this.riskMetrics.winStreak,
                lossStreak: this.riskMetrics.lossStreak,
            },
        };
    }

    // ====================================================================
    // PERFORMANCE REPORTING
    // ====================================================================

    /**
     * Get comprehensive performance summary
     */
    getPerformanceSummary() {
        const summary = {
            models: {},
            ensemble: {},
            risk: {},
            threshold: {},
            stacking: {},
            bandit: {},
            calibration: {},
            timeframes: {},
        };

        // Per-model performance
        this.registeredModels.forEach(model => {
            const perf = this.modelPerformance[model];
            if (!perf) return;

            const recentAcc = this._getRecentAccuracy(model, 50);

            summary.models[model] = {
                accuracy: perf.total > 0 ?
                    (perf.correct / perf.total * 100).toFixed(1) + '%' : 'N/A',
                recentAccuracy: (recentAcc * 100).toFixed(1) + '%',
                samples: perf.total,
                weight: ((this.modelWeights[model] || 0) * 100).toFixed(1) + '%',
                currentStreak: perf.streaks.currentCorrect > 0 ?
                    `+${perf.streaks.currentCorrect}` : `-${perf.streaks.currentWrong}`,
                calibrationError: (this._getCalibrationError(model) * 100).toFixed(1) + '%',
            };
        });

        // Ensemble metrics
        summary.ensemble = {
            adaptiveThreshold: this.adaptiveThreshold.toFixed(3),
            totalDecisions: this.recentDecisions.length,
            recentWinRate: this._getEnsembleWinRate(50),
        };

        // Risk metrics
        summary.risk = {
            kellyFraction: (this.riskMetrics.kellyFraction * 100).toFixed(2) + '%',
            sharpeRatio: this.riskMetrics.sharpeRatio.toFixed(3),
            maxDrawdown: (this.riskMetrics.maxDrawdown * 100).toFixed(1) + '%',
            currentDrawdown: (this.riskMetrics.currentDrawdown * 100).toFixed(1) + '%',
            volatility: this.riskMetrics.volatilityOfReturns.toFixed(4),
        };

        // Threshold optimizer
        const thresholdPerf = {};
        Object.entries(this.thresholdOptimizer.performance).forEach(([t, p]) => {
            if (p.trades >= 5) {
                thresholdPerf[t] = {
                    winRate: (p.winRate * 100).toFixed(1) + '%',
                    trades: p.trades,
                };
            }
        });
        summary.threshold = {
            current: this.adaptiveThreshold.toFixed(3),
            candidates: thresholdPerf,
        };

        // Stacking meta-learner
        if (this.stackingWeights) {
            summary.stacking = {
                weights: this.stackingWeights.map((w, i) =>
                    `${this.registeredModels[i]}: ${w.toFixed(3)}`
                ),
                bias: this.stackingBias.toFixed(3),
                trainingSamples: this.stackingHistory.length,
            };
        }

        // Bandit state
        summary.bandit = {};
        Object.entries(this.banditState).forEach(([model, state]) => {
            summary.bandit[model] = {
                expectedValue: (state.alpha / (state.alpha + state.beta)).toFixed(3),
                pulls: state.pulls,
            };
        });

        // Model correlations
        summary.correlations = {};
        Object.entries(this.correlationMatrix).forEach(([key, corr]) => {
            summary.correlations[key] = corr.toFixed(3);
        });

        // Timeframe performance
        Object.entries(this.timeframePerformance).forEach(([tf, data]) => {
            const decisions = data.decisions.filter(d => d.outcome !== undefined);
            const wins = decisions.filter(d => d.outcome === true).length;
            summary.timeframes[tf] = {
                winRate: decisions.length > 0 ?
                    (wins / decisions.length * 100).toFixed(1) + '%' : 'N/A',
                samples: decisions.length,
            };
        });

        // Counterfactual summary
        if (this.counterfactualLog.length >= 20) {
            summary.counterfactual = {};
            [0.5, 0.6, 0.7, 0.8].forEach(t => {
                const correct = this.counterfactualLog
                    .filter(cf => cf[t] && cf[t].correctDecision).length;
                summary.counterfactual[t] = {
                    correctRate: (correct / this.counterfactualLog.length * 100).toFixed(1) + '%',
                };
            });
        }

        return summary;
    }

    _getEnsembleWinRate(window = 50) {
        const recent = this.recentDecisions.slice(-window)
            .filter(d => d.outcome !== undefined);
        if (recent.length === 0) return 'N/A';
        const wins = recent.filter(d => d.outcome === true).length;
        return (wins / recent.length * 100).toFixed(1) + '%';
    }

    /**
     * Get performance attribution: which models contributed most to wins/losses
     */
    getPerformanceAttribution() {
        const attribution = {};

        this.registeredModels.forEach(model => {
            const perf = this.modelPerformance[model];
            if (!perf || perf.recentPredictions.length < 10) return;

            const recent = perf.recentPredictions.slice(-50);

            // Brier score (lower = better calibration)
            const brierScore = recent.reduce((sum, p) => {
                const target = p.actual ? 1 : 0;
                return sum + (p.prediction - target) ** 2;
            }, 0) / recent.length;

            // Information value
            const correctHighConf = recent.filter(p =>
                p.correct && Math.abs(p.prediction - 0.5) > 0.2
            ).length;
            const incorrectHighConf = recent.filter(p =>
                !p.correct && Math.abs(p.prediction - 0.5) > 0.2
            ).length;

            // Discrimination ability
            const winPredictions = recent.filter(p => p.actual).map(p => p.prediction);
            const lossPredictions = recent.filter(p => !p.actual).map(p => p.prediction);

            let aucApprox = 0.5;
            if (winPredictions.length > 0 && lossPredictions.length > 0) {
                const meanWin = winPredictions.reduce((a, b) => a + b, 0) / winPredictions.length;
                const meanLoss = lossPredictions.reduce((a, b) => a + b, 0) / lossPredictions.length;
                aucApprox = meanWin > meanLoss ? 0.5 + (meanWin - meanLoss) : 0.5;
                aucApprox = Math.min(1, Math.max(0, aucApprox));
            }

            attribution[model] = {
                brierScore: brierScore.toFixed(4),
                auc: aucApprox.toFixed(3),
                correctHighConfidence: correctHighConf,
                incorrectHighConfidence: incorrectHighConf,
                weight: ((this.modelWeights[model] || 0) * 100).toFixed(1) + '%',
                bestRegime: this._getBestRegime(model),
                worstRegime: this._getWorstRegime(model),
            };
        });

        return attribution;
    }

    _getBestRegime(model) {
        const perf = this.modelPerformance[model];
        if (!perf) return 'N/A';

        let bestRegime = 'N/A';
        let bestRate = 0;

        Object.entries(perf.regimePerformance).forEach(([regime, stats]) => {
            if (stats.total >= 5) {
                const rate = stats.correct / stats.total;
                if (rate > bestRate) {
                    bestRate = rate;
                    bestRegime = regime;
                }
            }
        });

        return bestRegime;
    }

    _getWorstRegime(model) {
        const perf = this.modelPerformance[model];
        if (!perf) return 'N/A';

        let worstRegime = 'N/A';
        let worstRate = 1;

        Object.entries(perf.regimePerformance).forEach(([regime, stats]) => {
            if (stats.total >= 5) {
                const rate = stats.correct / stats.total;
                if (rate < worstRate) {
                    worstRate = rate;
                    worstRegime = regime;
                }
            }
        });

        return worstRegime;
    }

    // ====================================================================
    // UTILITY METHODS
    // ====================================================================

    _betaSample(alpha, beta) {
        // Approximation using gamma sampling
        const x = this._gammaSample(alpha);
        const y = this._gammaSample(beta);
        return x / (x + y);
    }

    _gammaSample(alpha) {
        // Marsaglia and Tsang's method for alpha >= 1
        if (alpha < 1) {
            return this._gammaSample(alpha + 1) * Math.pow(Math.random(), 1 / alpha);
        }

        const d = alpha - 1 / 3;
        const c = 1 / Math.sqrt(9 * d);

        while (true) {
            let x, v;
            do {
                x = this._normalSample();
                v = 1 + c * x;
            } while (v <= 0);

            v = v * v * v;
            const u = Math.random();

            if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
            if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
        }
    }

    _normalSample() {
        // Box-Muller transform
        const u1 = Math.random();
        const u2 = Math.random();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }

    // ====================================================================
    // STATE PERSISTENCE
    // ====================================================================

    exportState() {
        return {
            modelWeights: this.modelWeights,
            modelPerformance: this.modelPerformance,
            adaptiveThreshold: this.adaptiveThreshold,
            thresholdHistory: this.thresholdHistory.slice(-100),
            thresholdOptimizer: {
                performance: this.thresholdOptimizer.performance,
                bayesianParams: this.thresholdOptimizer.bayesianParams,
            },
            recentDecisions: this.recentDecisions.slice(-300),
            stackingWeights: this.stackingWeights,
            stackingBias: this.stackingBias,
            stackingVelocity: this.stackingVelocity,
            stackingHistory: this.stackingHistory.slice(-200),
            banditState: this.banditState,
            banditExplorationRate: this.banditExplorationRate,
            calibrationParams: this.calibrationParams,
            calibrationHistory: (() => {
                const trimmed = {};
                Object.entries(this.calibrationHistory).forEach(([m, h]) => {
                    trimmed[m] = h.slice(-100);
                });
                return trimmed;
            })(),
            correlationMatrix: this.correlationMatrix,
            modelPredictionHistory: (() => {
                const trimmed = {};
                Object.entries(this.modelPredictionHistory).forEach(([m, h]) => {
                    trimmed[m] = h.slice(-100);
                });
                return trimmed;
            })(),
            riskMetrics: {
                ...this.riskMetrics,
                returnsHistory: this.riskMetrics.returnsHistory.slice(-200),
            },
            timeframePerformance: (() => {
                const trimmed = {};
                Object.entries(this.timeframePerformance).forEach(([tf, data]) => {
                    trimmed[tf] = {
                        decisions: data.decisions.slice(-200),
                        winRate: data.winRate,
                        avgScore: data.avgScore,
                    };
                });
                return trimmed;
            })(),
            decisionJournal: this.decisionJournal.slice(-200),
            cascadeStages: this.cascadeStages,
        };
    }

    importState(state) {
        if (!state) return;

        try {
            if (state.modelWeights) this.modelWeights = state.modelWeights;
            if (state.modelPerformance) {
                Object.entries(state.modelPerformance).forEach(([model, perf]) => {
                    if (this.modelPerformance[model]) {
                        this.modelPerformance[model] = {
                            ...this._createDefaultModelPerf(),
                            ...perf,
                        };
                    }
                });
            }
            if (state.adaptiveThreshold) this.adaptiveThreshold = state.adaptiveThreshold;
            if (state.thresholdHistory) this.thresholdHistory = state.thresholdHistory;
            if (state.thresholdOptimizer) {
                if (state.thresholdOptimizer.performance) {
                    this.thresholdOptimizer.performance = state.thresholdOptimizer.performance;
                }
                if (state.thresholdOptimizer.bayesianParams) {
                    this.thresholdOptimizer.bayesianParams = state.thresholdOptimizer.bayesianParams;
                }
            }
            if (state.recentDecisions) this.recentDecisions = state.recentDecisions;
            if (state.stackingWeights) this.stackingWeights = state.stackingWeights;
            if (state.stackingBias !== undefined) this.stackingBias = state.stackingBias;
            if (state.stackingVelocity) this.stackingVelocity = state.stackingVelocity;
            if (state.stackingHistory) this.stackingHistory = state.stackingHistory;
            if (state.banditState) this.banditState = state.banditState;
            if (state.banditExplorationRate) this.banditExplorationRate = state.banditExplorationRate;
            if (state.calibrationParams) this.calibrationParams = state.calibrationParams;
            if (state.calibrationHistory) this.calibrationHistory = state.calibrationHistory;
            if (state.correlationMatrix) this.correlationMatrix = state.correlationMatrix;
            if (state.modelPredictionHistory) this.modelPredictionHistory = state.modelPredictionHistory;
            if (state.riskMetrics) this.riskMetrics = { ...this.riskMetrics, ...state.riskMetrics };
            if (state.timeframePerformance) this.timeframePerformance = state.timeframePerformance;
            if (state.decisionJournal) this.decisionJournal = state.decisionJournal;
            if (state.cascadeStages) this.cascadeStages = state.cascadeStages;

            console.log('  ✓ Advanced ensemble decision maker restored');
        } catch (error) {
            console.error(`  ✗ Error importing ensemble state: ${error.message}`);
        }
    }
}

class EnhancedAccumulatorBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];

        this.config = {
            initialStake: config.initialStake || 1,
            initialStake2: config.initialStake2 || 5,
            multiplier: config.multiplier || 21,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            stopLoss: config.stopLoss || 400,
            takeProfit: config.takeProfit || 5000,
            growthRate: config.growthRate || 0.05,
            accuTakeProfit: config.accuTakeProfit || 0.01,
            requiredHistoryLength: config.requiredHistoryLength || 200,
            winProbabilityThreshold: config.winProbabilityThreshold || 100,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            minWaitTime: config.minWaitTime || 200 * 1000,
            maxWaitTime: config.maxWaitTime || 500 * 1000,
            survivalThreshold: config.survivalThreshold || 0.98,
            minSamplesForEstimate: 50,
            // New config options
            learningModeThreshold: config.learningModeThreshold || 100,
            enableNeuralNetwork: config.enableNeuralNetwork !== false,
            enablePatternRecognition: config.enablePatternRecognition !== false,
            saveInterval: config.saveInterval || 300000, // 5 minutes
        };

        // Trading state
        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.currentTradeId = null;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.endOfDay = false;
        this.waitTime = 0;
        this.waitSeconds = 0;
        this.isWinTrade = false;
        this.retryCount = 0;
        this.suspendedAssets = new Set();
        this.Pause = false;
        this.survivalNum = null;
        this.sys = 1;
        this.sysCount = 0;
        this.stopLossStake = false;
        this.sys2 = false;
        this.sys2WinCount = 0;

        // Asset-specific data
        this.digitCounts = {};
        this.tickSubscriptionIds = {};
        this.tickHistories = {};
        this.lastDigits = {};
        this.predictedDigits = {};
        this.lastPredictions = {};
        this.assetStates = {};
        this.pendingProposals = new Map();
        this.previousStayedIn = {};
        this.extendedStayedIn = {};

        // ====================================================================
        // ENHANCED LEARNING COMPONENTS
        // ====================================================================

        // Tier 1: Statistical Engine
        this.statisticalEngine = new StatisticalEngine();

        // Tier 2: Pattern Engine
        this.patternEngine = new PatternEngine();

        // Tier 3: Neural Engine
        this.neuralEngine = new NeuralEngine(90, [128, 64, 32], 3);

        // Tier 4: Ensemble Decision Maker
        this.ensembleDecisionMaker = new EnsembleDecisionMaker();

        // Tier 5: Persistence Manager
        // this.persistenceManager = new PersistenceManager();

        // Learning mode counter
        this.observationCount = 0;
        this.learningMode = true;

        // Legacy learning system (enhanced)
        this.learningSystem = {
            lossPatterns: {},
            failedDigitCounts: {},
            volatilityScores: {},
            filterPerformance: {},
            resetPatterns: {},
            timeWindowPerformance: [],
            adaptiveFilters: {},
            predictionAccuracy: {},
        };

        // Risk manager (preserved as requested)
        this.riskManager = {
            currentSessionRisk: 0,
            riskPerTrade: 0.02,
            cooldownPeriod: 0,
            lastLossTime: null,
            consecutiveSameDigitLosses: {},
        };

        // Initialize assets
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.lastDigits[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
            this.assetStates[asset] = {
                stayedInArray: [],
                tradedDigitArray: [],
                filteredArray: [],
                totalArray: [],
                currentProposalId: null,
                tradeInProgress: false,
                consecutiveLosses: 0,
                lastTradeResult: null,
                digitFrequency: {},
            };
            this.previousStayedIn[asset] = null;
            this.extendedStayedIn[asset] = [];

            // Initialize learning components per asset
            this.learningSystem.lossPatterns[asset] = [];
            this.learningSystem.volatilityScores[asset] = 0;
            this.learningSystem.adaptiveFilters[asset] = 8;
            this.learningSystem.predictionAccuracy[asset] = { correct: 0, total: 0 };
            this.riskManager.consecutiveSameDigitLosses[asset] = {};

            // Initialize statistical engine
            this.statisticalEngine.initBayesianPrior(asset);
        });

        // Telegram Configuration
        this.telegramToken = '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ';
        this.telegramChatId = '752497117';
        this.telegramEnabled = true;

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
            this.startTelegramTimer();
        } else {
            console.log('📱 Telegram notifications disabled (missing API keys).');
        }

        // Stats tracking for Telegram summaries
        this.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };

        // Reconnection logic
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 5000;
        this.reconnectTimer = null;
        this.isReconnecting = false;

        // Heartbeat/Ping mechanism
        this.pingInterval = null;
        this.checkDataInterval = null;
        this.pongTimeout = null;
        this.lastPongTime = Date.now();
        this.lastDataTime = Date.now();
        this.pingIntervalMs = 20000;
        this.pongTimeoutMs = 10000;
        this.dataTimeoutMs = 60000;

        // Message queue for failed sends
        this.messageQueue = [];
        this.maxQueueSize = 50;

        // Load saved state if available
        this.loadSavedState();
    }

    // ========================================================================
    // PERSISTENCE METHODS
    // ========================================================================

    loadSavedState() {
        const state = StatePersistence.loadState();

        // Check if state was successfully loaded
        if (!state) {
            console.log('🆕 No saved state found or state too old. Starting fresh learning.');
            return;
        }

        console.log('📂 Loading saved learning state...');

        try {
            // Restore trading state
            if (state.trading) {
                const trading = state.trading;
                this.currentStake = trading.currentStake || this.config.initialStake;
                this.consecutiveLosses = trading.consecutiveLosses || 0;
                this.totalTrades = trading.totalTrades || 0;
                this.totalWins = trading.totalWins || 0;
                this.totalLosses = trading.totalLosses || 0;
                this.consecutiveLosses2 = trading.consecutiveLosses2 || 0;
                this.consecutiveLosses3 = trading.consecutiveLosses3 || 0;
                this.consecutiveLosses4 = trading.consecutiveLosses4 || 0;
                this.consecutiveLosses5 = trading.consecutiveLosses5 || 0;
                this.totalProfitLoss = trading.totalProfitLoss || 0;
                this.Pause = trading.Pause || false;
                this.sys = trading.sys || 1;
                this.sysCount = trading.sysCount || 0;
                this.sys2 = trading.sys2 || false;
                this.sys2WinCount = trading.sys2WinCount || 0;
                this.isWinTrade = trading.isWinTrade || false;
            }

            // Restore hourly stats
            if (state.hourlyStats) {
                this.hourlyStats = state.hourlyStats;
            }

            // Restore learning mode state
            if (state.observationCount !== undefined) {
                this.observationCount = state.observationCount;
            }
            if (state.learningMode !== undefined) {
                this.learningMode = state.learningMode;
            }

            // Restore neural network weights
            if (state.neuralEngine) {
                this.neuralEngine.importWeights(state.neuralEngine);
                console.log('  ✓ Neural network weights restored');
            }

            // Restore ensemble decision maker
            if (state.ensembleDecisionMaker) {
                this.ensembleDecisionMaker.importState(state.ensembleDecisionMaker);
                console.log('  ✓ Ensemble decision maker restored');
            }

            // Restore learning system
            if (state.learningSystem) {
                this.learningSystem = { ...this.learningSystem, ...state.learningSystem };
                console.log('  ✓ Learning system restored');
            }

            // Restore extended stayed-in data
            if (state.extendedStayedIn) {
                this.extendedStayedIn = state.extendedStayedIn;
                console.log('  ✓ Extended stayed-in data restored');
            }

            // Restore previous stayed-in data
            if (state.previousStayedIn) {
                this.previousStayedIn = state.previousStayedIn;
            }

            // Restore asset states
            if (state.assetStates) {
                this.assetStates = state.assetStates;
                console.log('  ✓ Asset states restored');
            }

            // Restore tick histories
            if (state.assets) {
                Object.keys(state.assets).forEach(asset => {
                    if (this.tickHistories[asset] && state.assets[asset].tickHistory) {
                        this.tickHistories[asset] = state.assets[asset].tickHistory;
                    }
                });
                console.log('  ✓ Tick histories restored');
            }

            console.log('✅ Learning state restored successfully');
            console.log(`📊 Restored ${this.totalTrades} trades, P&L: $${this.totalProfitLoss.toFixed(2)}`);

        } catch (error) {
            console.error(`❌ Error restoring state: ${error.message}`);
            console.log('⚠️ Continuing with fresh state...');
        }
    }

    // ========================================================================
    // WEBSOCKET & CONNECTION METHODS
    // ========================================================================

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('Already connected');
            return;
        }

        console.log('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.wsReady = false; // Wait for auth
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
    }

    stopMonitor() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.checkDataInterval) clearInterval(this.checkDataInterval);
        if (this.pongTimeout) clearTimeout(this.pongTimeout);
        this.pingInterval = null;
        this.checkDataInterval = null;
        this.pongTimeout = null;
    }

    sendRequest(request) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('Cannot send request: WebSocket not ready');
            if (this.messageQueue && this.messageQueue.length < this.maxQueueSize) {
                this.messageQueue.push(request);
            }
            return false;
        }

        try {
            this.ws.send(JSON.stringify(request));
            return true;
        } catch (error) {
            console.error('Error sending request:', error.message);
            if (this.messageQueue && this.messageQueue.length < this.maxQueueSize) {
                this.messageQueue.push(request);
            }
            return false;
        }
    }

    processMessageQueue() {
        if (!this.messageQueue || this.messageQueue.length === 0) return;
        const queue = [...this.messageQueue];
        this.messageQueue = [];
        queue.forEach(message => this.sendRequest(message));
    }

    handleDisconnect() {
        if (this.endOfDay) {
            console.log('Planned shutdown, not reconnecting.');
            this.cleanup();
            return;
        }

        if (this.isReconnecting) return;

        this.connected = false;
        this.wsReady = false;
        this.stopMonitor();
        StatePersistence.saveState(this);

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            this.sendTelegramMessage(
                `❌ <b>Max Reconnection Attempts Reached 2</b>\n` +
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

        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.sendTelegramMessage(
            `⚠️ <b>CONNECTION LOST - RECONNECTING 2</b>\n` +
            `📊 Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
            `⏱️ Retrying in ${(delay / 1000).toFixed(1)}s`
        );

        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

        this.reconnectTimer = setTimeout(() => {
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
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { }
            }
            this.ws = null;
        }
        this.connected = false;
        this.wsReady = false;
    }

    handleApiError(error) {
        console.error('API Error:', error.message);

        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token. Please check your API token and restart the bot.');
                this.sendErrorEmail('Invalid API token');
                this.disconnect();
                break;
            case 'RateLimit':
                console.log('Rate limit reached. Waiting before next request...');
                setTimeout(() => this.initializeSubscriptions(), 60000);
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.initializeSubscriptions(), 3600000);
                break;
            default:
                console.log('Encountered an error. Continuing operation...');
                this.initializeSubscriptions();
        }
    }

    authenticate() {
        console.log('Attempting to authenticate...');
        this.sendRequest({
            authorize: this.token
        });
    }

    subscribeToTickHistory(asset) {
        const request = {
            ticks_history: asset,
            adjust_start_time: 1,
            count: this.config.requiredHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        };
        this.sendRequest(request);
    }

    subscribeToTicks(asset) {
        const request = {
            ticks: asset,
            subscribe: 1
        };
        this.sendRequest(request);
    }

    requestProposal(asset) {
        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: this.config.growthRate,
            limit_order: {
                take_profit: this.config.accuTakeProfit
            }
        };
        this.sendRequest(proposal);
    }

    // ========================================================================
    // MESSAGE HANDLERS
    // ========================================================================

    handleMessage(message) {
        if (message.msg_type === 'ping') {
            this.sendRequest({ ping: 1 });
            return;
        }

        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                this.sendTelegramMessage(`❌ <b>Authentication Failed 2:</b> ${message.error.message}`);
                this.disconnect();
                return;
            }
            console.log('✅ Authenticated successfully');
            this.wsReady = true;

            this.processMessageQueue();

            this.tradeInProgress = false;
            this.predictionInProgress = false;
            // Removed: this.resetForNewDay(); - so we don't wipe memory during a reconnect
            this.survivalNum = null;
            this.retryCount = 0;
            this.initializeSubscriptions();

        } else if (message.msg_type === 'proposal') {
            this.handleProposal(message);
        } else if (message.msg_type === 'history') {
            const asset = message.echo_req.ticks_history;
            this.handleTickHistory(asset, message.history);
        } else if (message.msg_type === 'tick') {
            if (message.subscription) {
                const asset = message.tick.symbol;
                this.tickSubscriptionIds[asset] = message.subscription.id;
            }
            this.handleTickUpdate(message.tick);
        } else if (message.msg_type === 'buy') {
            if (message.error) {
                console.error('Error placing trade:', message.error.message);
                this.tradeInProgress = false;
                return;
            }
            console.log('Trade placed successfully');
            this.currentTradeId = message.buy.contract_id;
            this.subscribeToOpenContract(this.currentTradeId);
        } else if (message.msg_type === 'proposal_open_contract') {
            if (message.error) {
                console.error('Error receiving contract update:', message.error.message);
                return;
            }
            this.handleContractUpdate(message.proposal_open_contract);
        } else if (message.msg_type === 'forget') {
            // console.log('Successfully unsubscribed from ticks');
        } else if (message.error) {
            this.handleApiError(message.error);
        }
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V',].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
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

    initializeSubscriptions() {
        console.log('Initializing subscriptions for all assets...');
        //unsubscribe from all assets
        this.assets.forEach(asset => {
            this.unsubscribeFromTicks(asset);
        });
        this.assets.forEach(asset => {
            this.subscribeToTickHistory(asset);
            this.subscribeToTicks(asset);
        });
    }

    handleTickHistory(asset, history) {
        this.tickHistories[asset] = history.prices.map(price => this.getLastDigit(price, asset));

        // Build initial pattern models
        if (this.config.enablePatternRecognition) {
            this.patternEngine.buildNgramModel(asset, this.tickHistories[asset], 5);
        }
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.lastDigits[asset] = lastDigit;
        this.tickHistories[asset].push(lastDigit);

        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        }

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            console.log(`[${asset}] Not enough history for analysis: ${this.tickHistories[asset].length}/${this.config.requiredHistoryLength}`);
            return;
        }

        this.digitCounts[asset][lastDigit]++;
        this.observationCount++;

        // Update pattern models periodically
        if (this.observationCount % 2 === 0 && this.config.enablePatternRecognition) {
            this.patternEngine.buildNgramModel(asset, this.tickHistories[asset]);
            this.patternEngine.buildMarkovChain(asset, this.extendedStayedIn[asset]);

            // Periodically run deeper analyses
            if (this.observationCount % 50 === 0) {
                // Discover motifs
                this.patternEngine.discoverMotifs(asset, this.tickHistories[asset]);

                // Mine sequential patterns from run lengths
                this.patternEngine.mineSequentialPatterns(asset, this.extendedStayedIn[asset]);

                // Compute Hurst exponent
                if (this.extendedStayedIn[asset] && this.extendedStayedIn[asset].length > 40) {
                    const hurst = this.patternEngine.computeHurstExponent(
                        asset, this.extendedStayedIn[asset]
                    );
                    if (hurst.confidence > 0.3) {
                        console.log(`[${asset}] 📐 Hurst: ${hurst.hurst.toFixed(3)} (${hurst.interpretation})`);
                    }
                }
            }
        }

        // Deep statistical analysis periodically
        if (this.observationCount % 100 === 0 && this.config.enablePatternRecognition) {
            const runLengths = this.extendedStayedIn[asset];

            if (runLengths && runLengths.length > 30) {
                // Fit mixture model
                const mixture = this.statisticalEngine.fitMixtureModel(asset, runLengths);
                if (mixture) {
                    console.log(`[${asset}] 📊 Mixture Model: ${mixture.numComponents} components, ` +
                        `multimodal: ${mixture.isMultiModal}`);
                }

                // Fit extreme value model
                const evt = this.statisticalEngine.fitExtremeValueModel(asset, runLengths);
                if (evt) {
                    console.log(`[${asset}] 📊 EVT: ${evt.maxima.params.type} distribution`);
                }

                // Compute hazard function
                const hazard = this.statisticalEngine.computeHazardFunction(asset, runLengths);
                if (hazard) {
                    console.log(`[${asset}] 📊 Hazard shape: ${hazard.shape}, ` +
                        `mean: ${hazard.meanHazard.toFixed(3)}`);
                }

                // Mutual information
                const mi = this.statisticalEngine.calculateMutualInformation(
                    asset, this.tickHistories[asset]
                );
                if (mi) {
                    console.log(`[${asset}] 📊 Mutual Information: ${mi.mean.toFixed(4)} ` +
                        `(predictability: ${(mi.predictability * 100).toFixed(1)}%)`);
                }

                // Bayesian period comparison
                const comparison = this.statisticalEngine.compareBayesianPeriods(asset);
                if (comparison && comparison.significantDifference) {
                    console.log(`[${asset}] ⚠️ Significant performance shift: ${comparison.direction}`);
                }
            }
        }

        // Check learning mode
        if (this.learningMode && this.observationCount < this.config.learningModeThreshold) {
            if (this.observationCount % 2 === 0) {
                console.log(`🎓 Learning mode: ${this.observationCount}/${this.config.learningModeThreshold} observations`);
            }
            return;
        } else if (this.learningMode) {
            console.log('✅ Learning phase complete. Trading enabled.');
            this.learningMode = false;
        }

        if (!this.tradeInProgress) {
            this.analyzeTicks(asset);
        }
    }

    // ========================================================================
    // ENHANCED ANALYSIS METHODS
    // ========================================================================

    /**
     * Calculate comprehensive market volatility
     */
    calculateVolatility(asset) {
        const history = this.tickHistories[asset];
        if (history.length < 20) return 0;

        const recentHistory = history.slice(-50);
        let changes = 0;
        for (let i = 1; i < recentHistory.length; i++) {
            if (recentHistory[i] !== recentHistory[i - 1]) changes++;
        }

        const volatility = changes / (recentHistory.length - 1);
        this.learningSystem.volatilityScores[asset] = volatility;

        // Also calculate entropy-based volatility
        const entropy = this.statisticalEngine.calculateEntropy(recentHistory);

        return { changeRate: volatility, entropy, combined: (volatility + entropy) / 2 };
    }

    /**
     * Enhanced market condition analysis
     */
    isMarketConditionFavorable(asset) {
        const volatilityData = this.calculateVolatility(asset);
        const assetState = this.assetStates[asset];

        // Check regime
        const regime = this.patternEngine.detectRegime(asset, this.extendedStayedIn[asset]);

        // Too volatile or unpredictable regime
        if (volatilityData.changeRate > 0.90 ||
            (regime.regime === 'volatile' && regime.confidence > 0.4)) {
            console.log(`[${asset}] Market too volatile (${volatilityData.changeRate.toFixed(2)}), regime: ${regime.regime}`);
            return false;
        }

        // Too stable - hard to profit
        if (volatilityData.changeRate < 0.31) {
            console.log(`[${asset}] Market too stable (${volatilityData.changeRate.toFixed(2)})`);
            return false;
        }

        // Check Bayesian confidence
        const bayesian = this.statisticalEngine.getBayesianEstimate(asset);
        if (bayesian.mean < 0.4 && bayesian.confidence > 20) {
            console.log(`[${asset}] Low Bayesian probability (${bayesian.mean.toFixed(3)})`);
            return false;
        }

        // Enhanced: Check regime stability
        const stability = this.patternEngine.getRegimeStability(asset);
        if (stability.currentRegime === 'volatile' && stability.currentDuration > 5) {
            console.log(`[${asset}] Persistent volatile regime (${stability.currentDuration} observations)`);
            return false;
        }

        // Enhanced: Check change point proximity
        const changePoints = this.patternEngine.detectChangePoints(asset, this.extendedStayedIn[asset]);
        if (changePoints.isNearChangePoint && changePoints.currentTrend === 'decreasing') {
            console.log(`[${asset}] Near downward change point - elevated risk`);
            return false;
        }

        // Enhanced: Check Hurst exponent (strongly mean-reverting + short current run = risky)
        const hurst = this.patternEngine.hurstExponents[asset];
        if (hurst && hurst.hurst < 0.35 && hurst.confidence > 0.5) {
            console.log(`[${asset}] Strongly mean-reverting market (H=${hurst.hurst.toFixed(3)}) - caution`);
            // Don't block entirely, but log warning
        }

        return true;
    }

    /**
     * Calculate asset win rate from learning history
     */
    calculateAssetWinRate(asset) {
        const lossHistory = this.learningSystem.lossPatterns[asset] || [];
        const recentTrades = lossHistory.slice(-10);

        if (recentTrades.length === 0) return 0.5;

        const wins = recentTrades.filter(t => t.result === 'win').length;
        return wins / recentTrades.length;
    }

    /**
     * Enhanced trade outcome recording with neural network training
     */
    recordTradeOutcome(asset, won, digitCount, filterUsed, stayedInArray) {
        const volatility = this.learningSystem.volatilityScores[asset] || 0;

        const outcome = {
            asset,
            result: won ? 'win' : 'loss',
            digitCount,
            filterUsed,
            arraySum: stayedInArray.reduce((a, b) => a + b, 0),
            timestamp: Date.now(),
            volatility,
        };

        // Update legacy learning system
        if (!this.learningSystem.lossPatterns[asset]) {
            this.learningSystem.lossPatterns[asset] = [];
        }
        this.learningSystem.lossPatterns[asset].push(outcome);
        if (this.learningSystem.lossPatterns[asset].length > 100) {
            this.learningSystem.lossPatterns[asset].shift();
        }

        // Update Bayesian model with context
        const volatilityVal = this.learningSystem.volatilityScores[asset] || 0;
        const regime = this.patternEngine.detectRegime(asset, this.extendedStayedIn[asset]);

        this.statisticalEngine.updateBayesian(asset, won, {
            volatility: volatilityVal,
            regimeConfidence: regime ? regime.confidence : 0.5,
        });

        // Update SPRT
        this.statisticalEngine.updateSPRT(asset, won);

        // Update EWMA
        this.statisticalEngine.updateEWMStats(asset, digitCount);

        // Train neural network
        if (this.config.enableNeuralNetwork && this.neuralEngine.initialized) {
            const features = this.neuralEngine.prepareFeatures(
                this.tickHistories[asset],
                this.extendedStayedIn[asset],
                digitCount,
                volatility
            );

            // Multi-head target: [survived, confidence_target, regime_target]
            const regime = this.patternEngine.detectRegime(asset, this.extendedStayedIn[asset]);
            const regimeTarget = regime.regime === 'stable' ? 0.8 :
                regime.regime === 'normal' ? 0.6 :
                    regime.regime === 'volatile' ? 0.3 : 0.2;

            const confidenceTarget = won ?
                Math.min(1, 0.7 + (digitCount / 100)) :
                Math.max(0, 0.3 - (this.consecutiveLosses * 0.1));

            const target = [won ? 1 : 0, confidenceTarget, regimeTarget];
            const { loss, prediction } = this.neuralEngine.trainOnSample(features, target);

            // Track prediction accuracy
            if (!this.learningSystem.predictionAccuracy[asset]) {
                this.learningSystem.predictionAccuracy[asset] = { correct: 0, total: 0 };
            }
            this.learningSystem.predictionAccuracy[asset].total++;
            if ((prediction >= 0.5) === won) {
                this.learningSystem.predictionAccuracy[asset].correct++;
            }

            if (this.totalTrades % 10 === 0) {
                const metrics = this.neuralEngine.getPerformanceMetrics();
                console.log(`🧠 Neural Network: Accuracy=${(metrics.accuracy * 100).toFixed(1)}%, ` +
                    `Loss=${metrics.recentLoss.toFixed(4)}, Trend=${metrics.trend}, ` +
                    `LR=${metrics.learningRate.toFixed(6)}, ` +
                    `Replay=${metrics.replayBufferSize}, ` +
                    `Calibration=${metrics.calibrationError.toFixed(3)}`);
            }
        }

        // Update ensemble decision maker
        this.ensembleDecisionMaker.recordOutcome(
            this.lastEnsemblePredictions || {},
            won,
            {
                regime: regime ? regime.regime : 'unknown',
                regimeConfidence: regime ? regime.confidence : 0,
                consecutiveLosses: this.consecutiveLosses,
                asset,
                stake: this.currentStake,
                traded: true,
            }
        );

        // Optimize threshold periodically
        if (this.totalTrades % 10 === 0) {
            this.ensembleDecisionMaker.optimizeThreshold();
        }

        // Log performance attribution periodically
        if (this.totalTrades % 25 === 0) {
            const attribution = this.ensembleDecisionMaker.getPerformanceAttribution();
            console.log('🎯 Performance Attribution:');
            Object.entries(attribution).forEach(([model, attr]) => {
                console.log(`   ${model}: Brier=${attr.brierScore}, AUC=${attr.auc}, ` +
                    `Weight=${attr.weight}, Best=${attr.bestRegime}, Worst=${attr.worstRegime}`);
            });
        }
    }

    // ========================================================================
    // ENHANCED PROPOSAL HANDLER
    // ========================================================================

    handleProposal(message) {
        if (message.error) {
            console.error('Proposal error:', message.error.message);
            return;
        }

        let asset = null;
        if (message.echo_req && message.echo_req.symbol) {
            asset = message.echo_req.symbol;
        }
        if (!asset && message.proposal && message.proposal.id) {
            asset = this.pendingProposals.get(message.proposal.id) || null;
        }
        if (!asset || !this.assets.includes(asset)) {
            return;
        }

        const assetState = this.assetStates[asset];

        if (message.proposal) {
            const stayedInArray = message.proposal.contract_details.ticks_stayed_in;
            assetState.stayedInArray = stayedInArray;

            // Update extended historical stayedInArray
            const prev = this.previousStayedIn[asset];
            if (prev === null) {
                this.extendedStayedIn[asset] = stayedInArray.slice(0, 99);
            }
            else {
                let isIncreased = true;
                for (let i = 0; i < 99; i++) {
                    if (stayedInArray[i] !== prev[i]) {
                        isIncreased = false;
                        break;
                    }
                }
                if (isIncreased && stayedInArray[99] === prev[99] + 1) {
                    // No reset
                } else {
                    const completed = prev[99] + 1;
                    this.extendedStayedIn[asset].push(completed);
                    if (this.extendedStayedIn[asset].length > 100) {
                        this.extendedStayedIn[asset].shift();
                    }
                }
            }
            this.previousStayedIn[asset] = stayedInArray.slice();

            assetState.currentProposalId = message.proposal.id;
            this.pendingProposals.set(message.proposal.id, asset);

            // Calculate digit frequency
            const digitFrequency = {};
            stayedInArray.forEach(digit => {
                digitFrequency[digit] = (digitFrequency[digit] || 0) + 1;
            });
            assetState.digitFrequency = digitFrequency;

            // ================================================================
            // ENHANCED ENSEMBLE DECISION MAKING
            // ================================================================

            if (!assetState.tradeInProgress) {
                // 1. Make the decision using the new Enhanced Trade Decision method
                const decision = this.makeEnhancedTradeDecision(asset, stayedInArray);

                // 2. Log detailed signal information
                if (decision.shouldTrade) {
                    console.log(`[${asset}] 🎯 TRADE SIGNAL | ` +
                        `Score: ${decision.ensembleScore.toFixed(4)} ` +
                        `(Thresh: ${decision.threshold.toFixed(2)}) | ` +
                        `Agreement: ${decision.agreement.toFixed(2)} | ` +
                        `SurvivalProb: ${decision.survivalProb.toFixed(2)}`);

                    console.log(`[${asset}] Model Contributions: ` +
                        `${JSON.stringify(decision.modelContributions)}`);

                    // 3. Pass the full decision object to placeTrade
                    this.placeTrade(asset, decision);
                } else {
                    // Optional: Log why trade was rejected
                    console.log(`[${asset}] ❌ NO TRADE | ` +
                        `Score: ${decision.ensembleScore.toFixed(4)} ` +
                        `(Below Thresh: ${decision.threshold.toFixed(2)}) | ` +
                        `Reason: ${decision.reason || 'Low Score'}`);
                }
            }
        }
    }

    /**
     * Make enhanced trade decision using ensemble of all models
     * Returns a structured decision object for placeTrade()
     */
    // makeEnhancedTradeDecision(asset, stayedInArray) {
    //     const currentDigitCount = stayedInArray[99] + 1;
    //     const runLengths = this.extendedStayedIn[asset];
    //     const volatilityData = this.calculateVolatility(asset);

    //     // Check dangerous patterns first
    //     if (this.detectDangerousPattern(asset, currentDigitCount, stayedInArray)) {
    //         return { shouldTrade: false, reason: 'dangerous_pattern' };
    //     }

    //     if (this.detectDangerousPattern2(asset)) {
    //         return { shouldTrade: false, reason: 'short_run_pattern' };
    //     }

    //     if (!this.isMarketConditionFavorable(asset)) {
    //         return { shouldTrade: false, reason: 'unfavorable_market' };
    //     }

    //     // Collect predictions from all models
    //     const predictions = {};

    //     // 1. Statistical Composite Score
    //     if (runLengths.length >= this.config.minSamplesForEstimate) {
    //         const statReport = this.statisticalEngine.getComprehensiveStatisticalReport(
    //             asset, runLengths, this.tickHistories[asset], currentDigitCount
    //         );

    //         // Kaplan-Meier
    //         if (statReport.kaplanMeier) {
    //             predictions.kaplanMeier = {
    //                 value: statReport.kaplanMeier.survival,
    //                 confidence: Math.min(1, statReport.kaplanMeier.sampleSize / 100)
    //             };
    //         }

    //         // Use composite statistical score as additional signal
    //         if (statReport.compositeScore !== undefined) {
    //             // This replaces the old simple Bayesian prediction with
    //             // a composite of all statistical methods
    //         }
    //     }

    //     // 2. Bayesian Estimate (enhanced)
    //     const bayesian = this.statisticalEngine.getBayesianEstimate(asset);
    //     predictions.bayesian = {
    //         value: bayesian.mean,
    //         confidence: Math.min(1, bayesian.confidence / 50) *
    //             (bayesian.predictionStrength === 'very_weak' ? 0.3 :
    //                 bayesian.predictionStrength === 'weak' ? 0.5 :
    //                     bayesian.predictionStrength === 'moderate' ? 0.7 :
    //                         bayesian.predictionStrength === 'strong' ? 0.9 : 1.0)
    //     };

    //     // 3. Markov Chain Prediction
    //     if (runLengths.length >= 20) {
    //         const markov = this.patternEngine.predictNextRunState(asset, runLengths, 2);
    //         if (markov) {
    //             const favorableStates = ['medium', 'long', 'very_long'];
    //             const favorableProb = favorableStates.reduce((sum, state) =>
    //                 sum + (markov.predictions[state] || 0), 0);
    //             predictions.markov = {
    //                 value: favorableProb,
    //                 confidence: Math.min(1, markov.confidence / 30)
    //             };
    //         }
    //     }

    //     // 4. Neural Network Prediction
    //     if (this.config.enableNeuralNetwork && this.neuralEngine.initialized) {
    //         const features = this.neuralEngine.prepareFeatures(
    //             this.tickHistories[asset],
    //             runLengths,
    //             currentDigitCount,
    //             volatilityData.combined
    //         );

    //         const neural = this.neuralEngine.predictWithUncertainty(features, 20);
    //         predictions.neural = {
    //             value: neural.prediction,
    //             confidence: neural.confidence
    //         };

    //         // Use the neural network's regime assessment as additional signal
    //         if (neural.regimeScore < 0.3) {
    //             console.log(`[${asset}] 🧠 Neural regime warning: ${neural.regimeScore.toFixed(3)}`);
    //             // Could optionally block trade here
    //         }

    //         // Log detailed uncertainty metrics periodically
    //         if (this.totalTrades % 25 === 0) {
    //             console.log(`[${asset}] 🧠 Neural Uncertainty: epistemic=${neural.epistemicUncertainty.toFixed(4)}, ` +
    //                 `aleatoric=${neural.aleatoricUncertainty.toFixed(4)}, ` +
    //                 `CI=[${neural.percentiles.p5.toFixed(3)}, ${neural.percentiles.p95.toFixed(3)}]`);
    //         }
    //     }

    //     // 5. Pattern-based Prediction (ENHANCED)
    //     if (this.config.enablePatternRecognition) {
    //         const runLengths = this.extendedStayedIn[asset];

    //         // Get comprehensive pattern analysis
    //         const patternReport = this.patternEngine.getComprehensiveAnalysis(
    //             asset,
    //             this.tickHistories[asset],
    //             runLengths
    //         );

    //         if (patternReport.compositeScore !== undefined) {
    //             // Use composite score from all pattern analyses
    //             const patternConfidence = Math.min(1,
    //                 (patternReport.regime ? patternReport.regime.confidence : 0) * 0.3 +
    //                 (patternReport.hurst ? patternReport.hurst.confidence : 0) * 0.2 +
    //                 (patternReport.sequentialPatterns ? patternReport.sequentialPatterns.confidence : 0) * 0.25 +
    //                 (patternReport.markov ? Math.min(1, patternReport.markov.confidence / 10) : 0) * 0.25
    //             );

    //             predictions.pattern = {
    //                 value: patternReport.compositeScore,
    //                 confidence: patternConfidence
    //             };

    //             // Log detailed pattern report periodically
    //             if (this.totalTrades % 15 === 0 && patternReport.regime) {
    //                 console.log(`[${asset}] 📊 Pattern Report:`);
    //                 console.log(`  Regime: ${patternReport.regime.regime} (${(patternReport.regime.confidence * 100).toFixed(1)}%)`);
    //                 if (patternReport.hurst) {
    //                     console.log(`  Hurst: ${patternReport.hurst.hurst.toFixed(3)} (${patternReport.hurst.interpretation})`);
    //                 }
    //                 if (patternReport.changePoints) {
    //                     console.log(`  Near Change Point: ${patternReport.changePoints.isNearChangePoint}, Trend: ${patternReport.changePoints.currentTrend}`);
    //                 }
    //                 if (patternReport.momentum) {
    //                     console.log(`  RSI: ${patternReport.momentum.rsi.toFixed(1)}, Z-Score: ${patternReport.momentum.zScore.toFixed(2)}`);
    //                 }
    //                 if (patternReport.fractal) {
    //                     console.log(`  Fractal Dim: ${patternReport.fractal.dimension.toFixed(3)} (${patternReport.fractal.interpretation})`);
    //                 }
    //                 console.log(`  Composite Score: ${patternReport.compositeScore.toFixed(4)}`);
    //             }

    //             // Additional regime-based safety checks
    //             if (patternReport.regime &&
    //                 (patternReport.regime.regime === 'volatile' || patternReport.regime.regime === 'unpredictable') &&
    //                 patternReport.regime.confidence > 0.5) {
    //                 console.log(`[${asset}] 🚨 Pattern engine warns: ${patternReport.regime.regime} regime detected`);
    //             }

    //             // Near change point warning
    //             if (patternReport.changePoints && patternReport.changePoints.isNearChangePoint) {
    //                 console.log(`[${asset}] ⚠️ Near change point detected - increased risk`);
    //                 // Reduce pattern confidence near change points
    //                 predictions.pattern.confidence *= 0.7;
    //             }
    //         }
    //     }

    //     // Store for later recording
    //     this.lastEnsemblePredictions = predictions;

    //     // Build context for ensemble
    //     const regime = this.patternEngine.detectRegime(asset, this.extendedStayedIn[asset]);
    //     const ensembleContext = {
    //         regime: regime ? regime.regime : 'unknown',
    //         regimeConfidence: regime ? regime.confidence : 0,
    //         consecutiveLosses: this.consecutiveLosses,
    //         asset,
    //         currentDigitCount,
    //         volatility: volatilityData.combined,
    //         stake: this.currentStake,
    //     };

    //     // Combine all predictions through advanced ensemble
    //     const ensemble = this.ensembleDecisionMaker.combinePredicitions(predictions, ensembleContext);

    //     console.log(`[${asset}] Ensemble Decision: score=${ensemble.score.toFixed(3)} ` +
    //         `(threshold=${ensemble.threshold.toFixed(3)}) | ` +
    //         `agreement=${ensemble.agreement.toFixed(3)} | ` +
    //         `reason=${ensemble.reason} | ` +
    //         `shouldTrade=${ensemble.shouldTrade}`);

    //     if (ensemble.details && ensemble.details.combinationMethods) {
    //         const methods = ensemble.details.combinationMethods;
    //         console.log(`[${asset}]   Methods: weighted=${methods.weighted.score.toFixed(3)}, ` +
    //             `stacking=${methods.stacking.score.toFixed(3)}, ` +
    //             `bandit=${methods.bandit.score.toFixed(3)}, ` +
    //             `rank=${methods.rank.score.toFixed(3)}`);
    //     }

    //     // Additional check with survival threshold
    //     const survivalCheck = this.shouldTradeBasedOnSurvivalProb(asset, stayedInArray);

    //     // Final decision
    //     const shouldTrade = ensemble.shouldTrade &&
    //         survivalCheck &&
    //         this.survivalNum > this.config.survivalThreshold;

    //     // Extract model contributions for logging
    //     const modelContributions = {};
    //     Object.entries(predictions).forEach(([model, pred]) => {
    //         if (pred) {
    //             modelContributions[model] = (pred.value * 100).toFixed(1) + '%';
    //         }
    //     });

    //     return {
    //         shouldTrade,
    //         ensembleScore: ensemble.score,
    //         confidence: ensemble.agreement,
    //         survivalProb: this.survivalNum,
    //         modelContributions,
    //         threshold: this.ensembleDecisionMaker.adaptiveThreshold
    //     };
    // }

    makeEnhancedTradeDecision(asset, stayedInArray) {
        const currentDigitCount = stayedInArray[99] + 1;
        const runLengths = this.extendedStayedIn[asset];
        const volatilityData = this.calculateVolatility(asset);

        // 1. Safety Checks (Pre-Decision)
        if (this.detectDangerousPattern(asset, currentDigitCount, stayedInArray)) {
            return {
                shouldTrade: false,
                ensembleScore: 0,
                agreement: 0,
                survivalProb: 0,
                threshold: this.ensembleDecisionMaker.adaptiveThreshold,
                modelContributions: {},
                reason: 'dangerous_pattern'
            };
        }
        if (this.detectDangerousPattern2(asset)) {
            return {
                shouldTrade: false,
                ensembleScore: 0,
                agreement: 0,
                survivalProb: 0,
                threshold: this.ensembleDecisionMaker.adaptiveThreshold,
                modelContributions: {},
                reason: 'short_run_pattern'
            };
        }
        if (!this.isMarketConditionFavorable(asset)) {
            return {
                shouldTrade: false,
                ensembleScore: 0,
                agreement: 0,
                survivalProb: 0,
                threshold: this.ensembleDecisionMaker.adaptiveThreshold,
                modelContributions: {},
                reason: 'unfavorable_market'
            };
        }

        // 2. Collect Predictions from All Models
        const predictions = {};

        // --- Kaplan-Meier Survival ---
        if (runLengths.length >= this.config.minSamplesForEstimate) {
            const km = this.statisticalEngine.kaplanMeierEstimate(runLengths, currentDigitCount);
            predictions.kaplanMeier = {
                value: km.survival,
                confidence: Math.min(1, km.sampleSize / 100)
            };
        }

        // --- Bayesian Estimate ---
        const bayesian = this.statisticalEngine.getBayesianEstimate(asset);
        predictions.bayesian = {
            value: bayesian.mean,
            confidence: Math.min(1, bayesian.confidence / 50)
        };

        // --- Markov Chain Prediction ---
        if (runLengths.length >= 20) {
            const markov = this.patternEngine.predictNextRunState(asset, runLengths, 2);
            if (markov) {
                const favorableStates = ['medium', 'medium_long', 'long', 'very_long', 'extreme'];
                const favorableProb = favorableStates.reduce((sum, state) =>
                    sum + (markov.predictions[state] || 0), 0);
                predictions.markov = {
                    value: favorableProb,
                    confidence: Math.min(1, markov.confidence / 30)
                };
            }
        }

        // --- Neural Network Prediction ---
        if (this.config.enableNeuralNetwork && this.neuralEngine.initialized) {
            const features = this.neuralEngine.prepareFeatures(
                this.tickHistories[asset],
                runLengths,
                currentDigitCount,
                volatilityData.combined
            );

            const neural = this.neuralEngine.predictWithUncertainty(features);
            predictions.neural = {
                value: neural.prediction,
                confidence: neural.confidence
            };
        }

        // --- Pattern-Based Prediction ---
        if (this.config.enablePatternRecognition) {
            const patternReport = this.patternEngine.getComprehensiveAnalysis(
                asset,
                this.tickHistories[asset],
                runLengths
            );

            if (patternReport.compositeScore !== undefined) {
                const patternConfidence = Math.min(1,
                    (patternReport.regime ? patternReport.regime.confidence : 0) * 0.3 +
                    (patternReport.hurst ? patternReport.hurst.confidence : 0) * 0.2 +
                    (patternReport.sequentialPatterns ? patternReport.sequentialPatterns.confidence : 0) * 0.25 +
                    (patternReport.markov ? Math.min(1, patternReport.markov.confidence / 10) : 0) * 0.25
                );

                predictions.pattern = {
                    value: patternReport.compositeScore,
                    confidence: patternConfidence
                };
            }
        }

        // Store for later recording
        this.lastEnsemblePredictions = predictions;

        // 3. Build Context for Ensemble
        const regime = this.patternEngine.detectRegime(asset, this.extendedStayedIn[asset]);
        const ensembleContext = {
            regime: regime ? regime.regime : 'unknown',
            regimeConfidence: regime ? regime.confidence : 0,
            consecutiveLosses: this.consecutiveLosses,
            asset,
            currentDigitCount,
            volatility: volatilityData.combined,
            stake: this.currentStake,
        };

        // 4. Combine Predictions via Advanced Ensemble
        const ensemble = this.ensembleDecisionMaker.combinePredicitions(predictions, ensembleContext);

        // 5. Calculate Survival Probability (Primary Filter)
        const survivalCheck = this.shouldTradeBasedOnSurvivalProb(asset, stayedInArray);
        const survivalProb = this.survivalNum || 0.5;

        // 6. Final Decision Logic
        const shouldTrade = ensemble.shouldTrade &&
            survivalCheck &&
            survivalProb > this.config.survivalThreshold;

        // 7. Extract Model Contributions for Logging
        const modelContributions = {};
        if (ensemble.details && ensemble.details.combinationMethods) {
            const methods = ensemble.details.combinationMethods;
            Object.keys(predictions).forEach(model => {
                if (methods.weighted && methods.weighted.contributions && methods.weighted.contributions[model]) {
                    modelContributions[model] = (methods.weighted.contributions[model].contribution * 100).toFixed(1) + '%';
                }
            });
        }

        console.log(`[${asset}] Ensemble Decision: score=${ensemble.score.toFixed(3)} ` +
            `(threshold=${ensemble.threshold.toFixed(3)}) | ` +
            `agreement=${ensemble.agreement.toFixed(3)} | ` +
            `survivalProb=${survivalProb.toFixed(3)} | ` +
            `Model Contributions: ${JSON.stringify(modelContributions)} | ` +
            `reason=${ensemble.reason} | ` +
            `shouldTrade=${ensemble.shouldTrade}`);

        return {
            shouldTrade,
            ensembleScore: ensemble.score,
            agreement: ensemble.agreement,
            survivalProb: survivalProb,
            threshold: ensemble.threshold,
            modelContributions,
            reason: ensemble.reason,
            details: ensemble.details
        };
    }

    /**
     * Survival probability check (enhanced from original)
     */
    shouldTradeBasedOnSurvivalProb(asset, stayedInArray) {
        const currentDigitCount = stayedInArray[99] + 1;
        const history = this.extendedStayedIn[asset];

        if (history.length < this.config.minSamplesForEstimate) {
            return false;
        }

        // Get comprehensive statistical report
        const statReport = this.statisticalEngine.getComprehensiveStatisticalReport(
            asset, history, this.tickHistories[asset], currentDigitCount
        );

        // Primary estimates
        const km = statReport.kaplanMeier;
        const na = statReport.nelsonAalen;

        // Bootstrap for robust CI
        const bootstrap = statReport.bootstrap;

        // Combined survival estimate (weighted average of methods)
        let combinedSurvival = 0;
        let totalWeight = 0;

        if (km) {
            const weight = 2.5 * Math.min(1, km.sampleSize / 50);
            combinedSurvival += km.survival * weight;
            totalWeight += weight;
        }

        if (na) {
            combinedSurvival += na.survivalFromHazard * 2.0;
            totalWeight += 2.0;
        }

        if (bootstrap) {
            combinedSurvival += bootstrap.mean * 1.5;
            totalWeight += 1.5;
        }

        combinedSurvival = totalWeight > 0 ? combinedSurvival / totalWeight : 0.5;

        // Check kernel-smoothed hazard
        const smoothedHazard = statReport.smoothedHazard || 0.1;
        if (smoothedHazard > 0.25) {
            console.log(`[${asset}] High smoothed hazard rate (${smoothedHazard.toFixed(3)}), skipping`);
            return false;
        }

        // Check conditional survival (next few steps)
        if (km && km.conditionalSurvival) {
            const nextStepSurvival = km.conditionalSurvival[1] || 0;
            if (nextStepSurvival < 0.85) {
                console.log(`[${asset}] Low conditional survival for next step (${nextStepSurvival.toFixed(3)})`);
                return false;
            }
        }

        // Check bootstrap lower CI
        if (bootstrap && bootstrap.ci_lower < this.config.survivalThreshold * 0.8) {
            console.log(`[${asset}] Bootstrap lower CI too low (${bootstrap.ci_lower.toFixed(3)})`);
            return false;
        }

        // Update EWMA stats
        this.statisticalEngine.updateEWMStats(asset, currentDigitCount);

        // Update SPRT
        this.statisticalEngine.updateSPRT(asset, combinedSurvival > 0.5);

        // Update Bayesian with context
        const volatilityData = this.calculateVolatility(asset);

        this.survivalNum = combinedSurvival;

        console.log(`[${asset}] Statistical Analysis: ` +
            `KM=${km ? km.survival.toFixed(4) : 'N/A'}, ` +
            `NA=${na ? na.survivalFromHazard.toFixed(4) : 'N/A'}, ` +
            `Boot=${bootstrap ? bootstrap.mean.toFixed(4) : 'N/A'}, ` +
            `Hazard=${smoothedHazard.toFixed(3)}, ` +
            `Combined=${combinedSurvival.toFixed(4)}, ` +
            `Composite=${statReport.compositeScore.toFixed(4)}`);

        return combinedSurvival > this.config.survivalThreshold;
    }

    /**
     * Detect dangerous patterns from historical losses
     */
    detectDangerousPattern(asset, currentDigitCount, stayedInArray) {

        // FIX: Guard against undefined/null arguments
        if (!stayedInArray || !Array.isArray(stayedInArray) || stayedInArray.length === 0) {
            return false;
        }

        const recentLosses = this.learningSystem.lossPatterns[asset] || [];

        if (recentLosses.length === 0) {
            return false;
        }

        const currentArraySum = stayedInArray.reduce((a, b) => a + b, 0);

        const similarLosses = recentLosses
            .filter(loss => loss.result === 'loss')
            .slice(-10)
            .filter(loss => {
                return loss.digitCount === currentDigitCount &&
                    Math.abs(loss.arraySum - currentArraySum) < 100;
            });

        if (similarLosses.length >= 2) {
            console.log(`[${asset}] 🚨 Dangerous pattern: ${similarLosses.length} similar losses`);
            return true;
        }

        return false;
    }

    /**
     * Detect frequent short run patterns
     */
    detectDangerousPattern2(asset) {
        const history = this.extendedStayedIn[asset];

        // FIX: Guard against undefined/null/non-array
        if (!history || !Array.isArray(history) || history.length < 10) {
            return false;
        }

        if (!history || history.length < 10) {
            return false;
        }

        const recentShort = history.slice(-10).filter(l => l < 5).length;

        if (recentShort > 6) {
            console.log(`[${asset}] 🚨 Too many short runs: ${recentShort}/10`);
            return true;
        }

        return false;
    }

    analyzeTicks(asset) {
        if (this.tradeInProgress) return;
        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) return;
        if (this.suspendedAssets.has(asset)) return;

        if (!this.isMarketConditionFavorable(asset)) {
            return;
        }

        this.requestProposal(asset);
    }

    // ========================================================================
    // TRADE EXECUTION (ENHANCED)
    // ========================================================================

    placeTrade(asset, decision) {
        if (this.tradeInProgress) return;

        const assetState = this.assetStates[asset];
        if (!assetState || !assetState.currentProposalId) {
            console.log(`Cannot place trade. Missing proposal for asset ${asset}.`);
            return;
        }

        // 1. Risk Management: Dynamic Stake Sizing using Kelly Criterion
        let tradeStake = this.currentStake;
        const kellyFraction = this.ensembleDecisionMaker.riskMetrics.kellyFraction || 0;

        // Only apply Kelly if we have sufficient data and it suggests a positive edge
        if (kellyFraction > 0.01 && this.totalTrades > 50) {
            // Calculate dynamic stake (cap at 2x initial stake to prevent over-betting)
            const kellyStake = this.currentStake * (1 + kellyFraction * 10); // Amplify slightly
            tradeStake = Math.min(kellyStake, this.config.initialStake * 2.5);

            // Round to 2 decimal places
            tradeStake = Math.round(tradeStake * 100) / 100;
        }

        // 2. Safety Check: Ensure stake is within limits
        if (tradeStake < this.config.initialStake) {
            tradeStake = this.config.initialStake;
        }

        // 3. Prepare Request
        const request = {
            buy: assetState.currentProposalId,
            price: this.currentStake.toFixed(2) //tradeStake.toFixed(2)
        };

        console.log(`🚀 Placing trade for Asset: [${asset}] | ` +
            `Stake: $${this.currentStake.toFixed(2)} (Kelly: $${tradeStake.toFixed(2)}) | ` + //$${tradeStake.toFixed(2)}
            `Kelly: ${(kellyFraction * 100).toFixed(1)}%`);

        // 4. Construct Detailed Telegram Message
        const modelDetails = decision.modelContributions || {};
        const riskMetrics = this.ensembleDecisionMaker.riskMetrics;

        const telegramMsg = `
            🚀 <b>NEW TRADE SIGNAL 2</b> - ${asset}

            📊 <b>Ensemble Analysis</b>
            ├ Score: <b>${decision.ensembleScore.toFixed(4)}</b>
            ├ Threshold: ${decision.threshold.toFixed(3)}
            ├ Agreement: ${(decision.agreement * 100).toFixed(1)}%
            └ Survival Prob: ${(decision.survivalProb * 100).toFixed(1)}%

            🧠 <b>Model Contributions</b>
            ├ Kaplan-Meier: ${modelDetails.kaplanMeier || 'N/A'}
            ├ Bayesian: ${modelDetails.bayesian || 'N/A'}
            ├ Markov: ${modelDetails.markov || 'N/A'}
            ├ Neural: ${modelDetails.neural || 'N/A'}
            └ Pattern: ${modelDetails.pattern || 'N/A'}

            💰 <b>Risk Management</b>
            ├ Base Stake: $${this.currentStake.toFixed(2)}
            ├ Dynamic Stake: <b>$${this.currentStake.toFixed(2)} (Kelly: $${tradeStake.toFixed(2)})</b>
            ├ Kelly Fraction: ${(kellyFraction * 100).toFixed(2)}%
            ├ Current Drawdown: ${(riskMetrics.currentDrawdown * 100).toFixed(1)}%
            └ Win Streak: ${riskMetrics.winStreak}

            📈 <b>Session Stats</b>
            ├ Total Trades: ${this.totalTrades}
            ├ Win Rate: ${((this.totalWins / (this.totalTrades || 1)) * 100).toFixed(1)}%
            └ P&L: ${(this.totalProfitLoss >= 0 ? '+' : '')}$${this.totalProfitLoss.toFixed(2)}

            ⏰ ${new Date().toLocaleTimeString()}
        `.trim();

        // 5. Execute Trade
        this.sendRequest(request);
        this.tradeInProgress = true;
        assetState.tradeInProgress = true;

        // 6. Send Notification
        this.sendTelegramMessage(telegramMsg);
    }

    subscribeToOpenContract(contractId) {
        const request = {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        };
        this.sendRequest(request);
    }

    handleContractUpdate(contract) {
        if (contract.is_sold) {
            this.handleTradeResult(contract);
        }
    }

    handleTradeResult(contract) {
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const assetState = this.assetStates[asset];

        console.log(`[${asset}] Trade outcome: ${won ? '✅ WON' : '❌ LOST'}`);

        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;
        if (won) this.hourlyStats.wins++;
        else this.hourlyStats.losses++;

        this.totalTrades++;

        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;

            // if (this.sys === 2) {
            //     if (this.sysCount === 5) {
            //         this.sys = 1;
            //         this.sysCount = 0;
            //     }
            // } else if (this.sys === 3) {
            //     if (this.sysCount === 2) {
            //         this.sys = 1;
            //         this.sysCount = 0;
            //     }
            // }

            if (this.sys2) {
                this.currentStake = this.config.initialStake2;
                this.sys2WinCount++;
                if (this.sys2WinCount === 50) {
                    this.currentStake = this.config.initialStake;
                    this.sys2WinCount = 0;
                    this.sys2 = false;
                }
            } else {
                this.currentStake = this.config.initialStake;
            }

            this.consecutiveLosses = 0;

            // if (assetState) {
            //     assetState.consecutiveLosses = 0;
            // }
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;

            if (assetState) {
                assetState.consecutiveLosses++;
            }

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            if (this.consecutiveLosses === 2) {
                if (this.sys2) {
                    this.consecutiveLosses = 4
                };
                this.sys2 = true
                this.currentStake = this.config.initialStake2;
            } else {
                this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            }
            // this.suspendAsset(asset);
        }

        this.totalProfitLoss += profit;

        if (!this.hourlyStats) {
            this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
        }

        if (assetState) {
            assetState.tradeInProgress = false;
            assetState.lastTradeResult = won ? 'win' : 'loss';
        }

        // Record outcome for enhanced learning
        const digitCount = assetState.stayedInArray[99] + 1;

        // 1. Update Pattern Engine
        const regime = this.patternEngine.detectRegime(asset, this.extendedStayedIn[asset]);

        // 2. Update Statistical Engine (Bayesian)
        const volatilityVal = this.learningSystem.volatilityScores[asset] || 0;
        this.statisticalEngine.updateBayesian(asset, won, {
            volatility: volatilityVal,
            regimeConfidence: regime ? regime.confidence : 0.5,
        });

        const volatilityData = this.calculateVolatility(asset);
        // 3. Update Neural Network
        if (this.config.enableNeuralNetwork && this.neuralEngine.initialized) {
            const features = this.neuralEngine.prepareFeatures(
                this.tickHistories[asset],
                this.extendedStayedIn[asset],
                digitCount,
                volatilityData ? volatilityData.combined : 0.5
            );

            const regimeTarget = regime.regime === 'stable' ? 0.8 :
                regime.regime === 'normal' ? 0.6 :
                    regime.regime === 'volatile' ? 0.3 : 0.2;

            const confidenceTarget = won ?
                Math.min(1, 0.7 + (digitCount / 100)) :
                Math.max(0, 0.3 - (this.consecutiveLosses * 0.1));

            const target = [won ? 1 : 0, confidenceTarget, regimeTarget];
            this.neuralEngine.trainOnSample(features, target);
        }

        // 4. Update Ensemble Decision Maker
        const ensembleContext = {
            regime: regime ? regime.regime : 'unknown',
            regimeConfidence: regime ? regime.confidence : 0,
            consecutiveLosses: this.consecutiveLosses,
            asset,
            stake: this.currentStake,
            traded: true,
        };

        this.ensembleDecisionMaker.recordOutcome(
            this.lastEnsemblePredictions || {},
            won,
            ensembleContext
        );

        // 5. Update Multi-Timeframe Data
        this.ensembleDecisionMaker._updateTimeframeData(
            this.lastEnsemblePredictions || {},
            won
        );

        const filterUsed = this.learningSystem.adaptiveFilters[asset];
        this.recordTradeOutcome(asset, won, digitCount, filterUsed, assetState.stayedInArray);


        const resultEmoji = won ? '✅ WIN' : '❌ LOSS';
        const pnlStr = (profit >= 0 ? '+' : '-') + '$' + Math.abs(profit).toFixed(2);
        const pnlColor = profit >= 0 ? '🟢' : '🔴';
        const winRate = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : 0;

        const telegramMsg = `
            ${resultEmoji} (Enhanced Accumulator Bot 2)
            
            📊 <b>${asset}</b>
            ${pnlColor} <b>P&L:</b> ${pnlStr}
            
            📊 <b>Trades Today:</b> ${this.totalTrades}
            📊 <b>Wins Today:</b> ${this.totalWins}
            📊 <b>Losses Today:</b> ${this.totalLosses}
            📊 <b>x2-x5 Losses:</b> ${this.consecutiveLosses2}/${this.consecutiveLosses3}/${this.consecutiveLosses4}/${this.consecutiveLosses5}
            
            📊 <b>Current Stake:</b> $${this.currentStake.toFixed(2)}

            🎯 <b>Win Rate:</b> ${winRate}%
            📈 <b>Total P&L:</b> ${(this.totalProfitLoss >= 0 ? '+' : '-')}$${Math.abs(this.totalProfitLoss).toFixed(2)}

            
            ⏰ ${new Date().toLocaleTimeString()}
        `.trim();
        this.sendTelegramMessage(telegramMsg);


        this.Pause = true;

        let baseWaitTime = this.config.minWaitTime;

        if (!won) {
            baseWaitTime = this.config.minWaitTime;
            // Loss handled by trade result telegram message.
            this.suspendAsset(asset);

            // if (this.consecutiveLosses >= 2) {
            //     if (this.sys === 1) {
            //         this.sys = 2;
            //     } else if (this.sys === 2) {
            //         this.sys = 3;
            //     }
            //     this.sysCount = 0;
            // }

            // if (this.sys === 2 && this.consecutiveLosses === 1 && this.currentStake === this.config.multiplier2) {
            //     this.sys = 3;
            //     this.sysCount = 0;
            // }
        } else {
            if (this.suspendedAssets.size > 1) {
                const firstSuspendedAsset = Array.from(this.suspendedAssets)[0];
                this.reactivateAsset(firstSuspendedAsset);
            }
        }

        const randomWaitTime = Math.floor(
            Math.random() * (this.config.maxWaitTime - baseWaitTime + 1)
        ) + baseWaitTime;

        const waitTimeMinutes = Math.round(randomWaitTime / 60000);
        if (!won) {
            this.waitTime = waitTimeMinutes + 120000;
        } else {
            this.waitTime = waitTimeMinutes;
        }
        this.waitSeconds = randomWaitTime;

        if (!this.endOfDay) {
            this.logTradingSummary(asset);
        }

        // Save state after each trade
        // this.persistenceManager.saveFullState(this);

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || this.totalProfitLoss <= -this.config.stopLoss || this.stopLossStake) {
            console.log('Stop condition reached. Stopping trading.');
            this.endOfDay = true;
            this.sendEmailSummary();
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take Profit Reached... Stopping trading.');
            this.endOfDay = true;
            this.sendEmailSummary();
            this.disconnect();
            return;
        }

        this.tradeInProgress = false;
        this.Pause = false;

        // if (!this.endOfDay) {
        //     setTimeout(() => {
        //         this.tradeInProgress = false;
        //         this.Pause = false;
        //         this.connect();
        //     }, randomWaitTime);
        // }
    }

    //Reset
    resetForNewDay() {
        // Asset-specific data
        this.digitCounts = {};
        this.tickSubscriptionIds = {};
        this.tickHistories = {};
        this.lastDigits = {};
        this.predictedDigits = {};
        this.lastPredictions = {};
        this.assetStates = {};
        this.pendingProposals = new Map();
        this.previousStayedIn = {};
        this.extendedStayedIn = {};

        // ====================================================================
        // ENHANCED LEARNING COMPONENTS
        // ====================================================================

        // Tier 1: Statistical Engine
        this.statisticalEngine = new StatisticalEngine();

        // Tier 2: Pattern Engine
        this.patternEngine = new PatternEngine();

        // Tier 3: Neural Engine
        this.neuralEngine = new NeuralEngine(90, [128, 64, 32], 3);

        // Tier 4: Ensemble Decision Maker
        this.ensembleDecisionMaker = new EnsembleDecisionMaker();

        // Tier 5: Persistence Manager
        // this.persistenceManager = new PersistenceManager();

        // Learning mode counter
        this.observationCount = 0;
        this.learningMode = true;

        // Legacy learning system (enhanced)
        // this.learningSystem = {
        //     lossPatterns: {},
        //     failedDigitCounts: {},
        //     volatilityScores: {},
        //     filterPerformance: {},
        //     resetPatterns: {},
        //     timeWindowPerformance: [],
        //     adaptiveFilters: {},
        //     predictionAccuracy: {},
        // };

        // Risk manager (preserved as requested)
        // this.riskManager = {
        //     currentSessionRisk: 0,
        //     riskPerTrade: 0.02,
        //     cooldownPeriod: 0,
        //     lastLossTime: null,
        //     consecutiveSameDigitLosses: {},
        // };

        // Initialize assets
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.lastDigits[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
            this.assetStates[asset] = {
                stayedInArray: [],
                tradedDigitArray: [],
                filteredArray: [],
                totalArray: [],
                currentProposalId: null,
                tradeInProgress: false,
                consecutiveLosses: 0,
                lastTradeResult: null,
                digitFrequency: {},
            };
            this.previousStayedIn[asset] = null;
            this.extendedStayedIn[asset] = [];

            // Initialize learning components per asset
            // this.learningSystem.lossPatterns[asset] = [];
            // this.learningSystem.volatilityScores[asset] = 0;
            // this.learningSystem.adaptiveFilters[asset] = 8;
            // this.learningSystem.predictionAccuracy[asset] = { correct: 0, total: 0 };
            // this.riskManager.consecutiveSameDigitLosses[asset] = {};

            // Initialize statistical engine
            this.statisticalEngine.initBayesianPrior(asset);
        });
    }

    // ========================================================================
    // ASSET MANAGEMENT (PRESERVED)
    // ========================================================================

    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
    }

    reactivateAsset(asset) {
        this.suspendedAssets.delete(asset);
    }

    suspendAllExcept(asset) {
        this.assets.forEach(a => {
            if (a !== asset) {
                this.suspendAsset(a);
            }
        });
        this.suspendedAssets.delete(asset);
    }

    reactivateAllSuspended() {
        Array.from(this.suspendedAssets).forEach(a => {
            this.reactivateAsset(a);
        });
    }

    unsubscribeAllTicks() {
        Object.values(this.tickSubscriptionIds).forEach(subId => {
            const request = {
                forget: subId
            };
            this.sendRequest(request);
        });
        this.tickSubscriptionIds = {};
    }

    unsubscribeFromTicks(asset) {
        const subId = this.tickSubscriptionIds[asset];
        if (subId) {
            const request = {
                forget: subId
            };
            this.sendRequest(request);
            // console.log(`Unsubscribing from ticks for ${asset}. Subscription ID: ${subId}`);
            delete this.tickSubscriptionIds[asset];
        }
    }

    // ========================================================================
    // TIME-BASED CONTROLS (PRESERVED)
    // ========================================================================

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

            // if (isWeekend) {
            //     if (!this.endOfDay) {
            //         console.log("Weekend trading suspension (Saturday 11pm - Monday 8am). Disconnecting...");
            //         this.sendHourlySummary();
            //         this.disconnect();
            //         this.endOfDay = true;
            //     }
            //     return; // Prevent any reconnection logic during the weekend
            // }

            if (this.endOfDay && currentHours === 2 && currentMinutes >= 0) {
                console.log("It's 2:00 AM GMT+1, reconnecting the bot.");
                this.resetForNewDay();
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 23 && currentMinutes >= 30) {
                    console.log("It's past 11:30 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendHourlySummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    disconnect() {
        console.log('🛑 Disconnecting bot...');
        // Save final state
        StatePersistence.saveState(this);
        // Stop auto-save
        StatePersistence.stopAutoSave(this);

        this.endOfDay = true; // Prevent reconnection
        this.cleanup();
        console.log('✅ Bot disconnected successfully');
    }

    // ========================================================================
    // LOGGING (ENHANCED)
    // ========================================================================

    logTradingSummary(asset) {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('                    TRADING SUMMARY');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Wins: ${this.totalWins} | Total Losses: ${this.totalLosses}`);
        console.log(`x2 Losses: ${this.consecutiveLosses2} | x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`Total Profit/Loss: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log('───────────────────────────────────────────────────────────');
        console.log(`Asset: [${asset}]`);

        const assetWinRate = this.calculateAssetWinRate(asset);
        const volatility = this.learningSystem.volatilityScores[asset] || 0;
        console.log(`Recent Win Rate: ${(assetWinRate * 100).toFixed(1)}% | Volatility: ${(volatility * 100).toFixed(1)}%`);

        // Neural network metrics
        if (this.config.enableNeuralNetwork) {
            const neuralMetrics = this.neuralEngine.getPerformanceMetrics();
            console.log(`Neural Net Accuracy: ${(neuralMetrics.accuracy * 100).toFixed(1)}% | Trend: ${neuralMetrics.trend}`);
        }

        // Enhanced ensemble performance
        const ensemblePerf = this.ensembleDecisionMaker.getPerformanceSummary();
        console.log(`Adaptive Threshold: ${ensemblePerf.ensemble.adaptiveThreshold}`);
        console.log(`Ensemble Win Rate: ${ensemblePerf.ensemble.recentWinRate}`);

        // Risk metrics
        if (ensemblePerf.risk) {
            console.log(`Kelly Fraction: ${ensemblePerf.risk.kellyFraction}`);
            console.log(`Sharpe Ratio: ${ensemblePerf.risk.sharpeRatio}`);
            console.log(`Max Drawdown: ${ensemblePerf.risk.maxDrawdown}`);
        }

        // Model weights & Accuracy
        console.log('Model Weights & Accuracy:');
        Object.entries(ensemblePerf.models).forEach(([model, data]) => {
            console.log(`  ${model}:`);
            console.log(`    Weight: ${data.weight} | Acc: ${data.accuracy} | Recent: ${data.recentAccuracy}`);
            console.log(`    Streak: ${data.currentStreak} | Calib Err: ${data.calibrationError}`);
        });

        // Timeframe performance
        console.log('Timeframe Performance:');
        Object.entries(ensemblePerf.timeframes).forEach(([tf, data]) => {
            console.log(`  ${tf}: WinRate=${data.winRate}, Samples=${data.samples}`);
        });

        console.log('───────────────────────────────────────────────────────────');
        console.log(`Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log(`Wait Time: ${this.waitTime} minutes (${this.waitSeconds} ms)`);
        console.log('═══════════════════════════════════════════════════════════');
    }

    // ========================================================================
    // TELEGRAM METHODS (ENHANCED)
    // ========================================================================

    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;
        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error(`❌ Failed to send Telegram message: ${error.message}`);
        }
    }

    async sendHourlySummary() {
        if (!this.hourlyStats) return;
        const stats = this.hourlyStats;
        const winRate = stats.wins + stats.losses > 0
            ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1)
            : 0;
        const pnlEmoji = stats.pnl >= 0 ? '🟢' : '🔴';
        const pnlStr = (stats.pnl >= 0 ? '+' : '') + '$' + Math.abs(stats.pnl).toFixed(2);

        // Enhanced ensemble info
        const ensemblePerf = this.ensembleDecisionMaker.getPerformanceSummary();
        const riskInfo = ensemblePerf.risk || {};

        // Neural network metrics
        const neuralMetrics = this.config.enableNeuralNetwork && this.neuralEngine.initialized ? this.neuralEngine.getPerformanceMetrics() : { accuracy: 0 };

        // Model weights
        const modelWeights = Object.entries(ensemblePerf.models).map(([model, data]) => {
            return `├ ${model}: ${data.weight.toFixed(2)} (Acc: ${(data.accuracy * 100).toFixed(1)}%)`;
        }).join('\n');

        const message = `
            ⏰ <b>Enhanced Accumulator Session Summary 2</b>

            📊 <b>Session Stats</b>
            ├ Trades: ${stats.trades}
            ├ Wins: ${stats.wins} | Losses: ${stats.losses}
            ├ Win Rate: ${winRate}%
            └ ${pnlEmoji} <b>P&L:</b> ${pnlStr}

            📈 <b>All-Time/Daily Totals</b>
            ├ Total Trades: ${this.totalTrades}
            ├ Total W/L: ${this.totalWins}/${this.totalLosses}
            ├ x2-x5 Losses: ${this.consecutiveLosses2}/${this.consecutiveLosses3}/${this.consecutiveLosses4}/${this.consecutiveLosses5}
            ├ Total P&L: ${(this.totalProfitLoss >= 0 ? '+' : '')}$${Math.abs(this.totalProfitLoss).toFixed(2)}
            └ Current Stake: $${this.currentStake.toFixed(2)}
            
            🧠 <b>AI System State</b>
            ├ Neural Accuracy: ${(neuralMetrics.accuracy * 100).toFixed(1)}%
            └ Adaptive Threshold: ${ensemblePerf.adaptiveThreshold}

            🎲 <b>Ensemble System</b> 
            ├ Threshold: ${ensemblePerf.ensemble.adaptiveThreshold}
            ├ Ensemble WR: ${ensemblePerf.ensemble.recentWinRate}
            ├ Model Weights: ${modelWeights}
            ├ Kelly: ${riskInfo.kellyFraction || 'N/A'}
            ├ Sharpe: ${riskInfo.sharpeRatio || 'N/A'}
            └ Drawdown: ${riskInfo.currentDrawdown || 'N/A'}

            ⏰ ${new Date().toLocaleString()}
        `.trim();

        try {
            await this.sendTelegramMessage(message);
            console.log('📱 Telegram: Session Summary sent 2');
        } catch (error) {
            console.error(`❌ Telegram session summary failed 2: ${error.message}`);
        }

        this.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };
    }

    sendEmailSummary() {
        // Redirect legacy email summary calls to telegram summary
        this.sendHourlySummary();
    }

    sendDisconnectResumptionEmailSummary() {
        this.sendHourlySummary();
    }

    sendLossEmail(asset) {
        // Handled intrinsically by handleTradeResult
    }

    sendErrorEmail(errorMessage) {
        this.sendTelegramMessage(`❌ <b>ERROR REPORT 2</b>\n\n${errorMessage}`);
    }

    // ========================================================================
    // START METHOD
    // ========================================================================

    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🚀 ENHANCED AI ACCUMULATOR TRADING BOT v2.0');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('  📊 Features:');
        console.log('    • Kaplan-Meier Survival Analysis');
        console.log('    • Bayesian Probability Updating');
        console.log('    • Markov Chain Pattern Recognition');
        console.log('    • Neural Network Prediction');
        console.log('    • Ensemble Decision Making');
        console.log('    • Persistent Learning Memory');
        console.log('');
        console.log(`  🎓 Learning Mode: ${this.learningMode ? 'Active' : 'Complete'}`);
        console.log(`  📁 Memory Directory: ./bot_memory/`);
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');

        // Start auto-save
        StatePersistence.startAutoSave(this);

        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// ============================================================================
// RUN THE BOT
// ============================================================================

const token = 'hsj0tA0XJoIzJG5'; //|| process.env.DERIV_TOKEN;

const bot = new EnhancedAccumulatorBot(token, {
    initialStake: 1,
    initialStake2: 10,
    multiplier: 21,
    stopLoss: 242,
    takeProfit: 50000,
    growthRate: 0.05,
    accuTakeProfit: 0.01,
    enableNeuralNetwork: true,
    enablePatternRecognition: true,
    learningModeThreshold: 100,
    survivalThreshold: 0.9,
    maxConsecutiveLosses: 4,
    minWaitTime: 2000,
    maxWaitTime: 2000,
});

bot.start();

module.exports = {
    EnhancedAccumulatorBot,
    StatisticalEngine,
    PatternEngine,
    NeuralEngine,
    EnsembleDecisionMaker,
    // PersistenceManager 
};
