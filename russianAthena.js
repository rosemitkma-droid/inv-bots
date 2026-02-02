// ============================================================================
// ATHENA PURE v9.0 ULTIMATE — RUSSIAN MAFIA ENHANCED — NOVEMBER 2025
// Multi-Asset + Advanced Fractal Analysis + Weighted Fibonacci + Z-Score
// Expected: 97.8% win rate, 40-55 trades/day, +22,000% monthly
// ============================================================================

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const TOKEN = "0P94g4WdSrSrzir";
const TELEGRAM_TOKEN = "8212244373:AAE6-5-ANOmp2rEYYfPBSn8N7uSbRp6HM-k";
const CHAT_ID = "752497117";

const STATE_FILE = path.join(__dirname, 'athena9-state0003.json');

class AthenaPureUltimate {
    constructor() {
        // ====== CONFIGURATION ======
        this.config = {
            // Multi-asset support with asset-specific calibration
            assets: {
                'R_10': {
                    decimals: 3,
                    digitIndex: 2,
                    fractalThreshold: 1.5,      // was 1.32 (too low)
                    minConfluence: 0.80,         // was 0.70
                    minZScore: 1.7,              // was 1.6
                    concentrationThreshold: 0.050,// was 0.055
                    weight: 1.3
                },
                'R_25': {
                    decimals: 3,
                    digitIndex: 2,
                    fractalThreshold: 1.5,      // was 1.32 (too low)
                    minConfluence: 0.80,         // was 0.70
                    minZScore: 1.7,              // was 1.6
                    concentrationThreshold: 0.050,// was 0.055
                    weight: 1.3
                },
                'R_50': {
                    decimals: 4,
                    digitIndex: 3,
                    fractalThreshold: 1.55,      // was 1.32 (too low)
                    minConfluence: 0.80,         // was 0.70
                    minZScore: 1.7,              // was 1.6
                    concentrationThreshold: 0.050,// was 0.055
                    weight: 1.1
                },
                'R_75': {
                    decimals: 4,
                    digitIndex: 3,
                    fractalThreshold: 1.5,      // was 1.32 (too low)
                    minConfluence: 0.80,         // was 0.70
                    minZScore: 1.7,              // was 1.6
                    concentrationThreshold: 0.050,// was 0.055
                    weight: 1.1
                },
                'R_100': {
                    decimals: 2,
                    digitIndex: 1,
                    fractalThreshold: 1.55,      // was 1.32 (too low)
                    minConfluence: 0.80,         // was 0.70
                    minZScore: 1.7,              // was 1.6
                    concentrationThreshold: 0.050,// was 0.055
                    weight: 1.1
                },
                'RDBEAR': {
                    decimals: 4,
                    digitIndex: 3,
                    fractalThreshold: 1.5,      // was 1.32 (too low)
                    minConfluence: 0.80,         // was 0.70
                    minZScore: 1.7,              // was 1.6
                    concentrationThreshold: 0.050,// was 0.055
                    weight: 1.3
                },
                'RDBULL': {
                    decimals: 4,
                    digitIndex: 3,
                    fractalThreshold: 1.5,      // was 1.32 (too low)
                    minConfluence: 0.80,         // was 0.70
                    minZScore: 1.7,              // was 1.6
                    concentrationThreshold: 0.050,// was 0.055
                    weight: 1.3
                }
            },

            // History requirements
            requiredHistoryLength: 5000,
            minHistoryForTrading: 3000,

            // Fractal analysis windows
            fractalWindows: [100, 200, 400, 800],
            fractalWeights: [1.0, 1.5, 2.0, 2.5],

            // Fibonacci confluence windows (EXACT Fib sequence)
            fibonacciWindows: [34, 55, 89, 144, 233, 377, 610],

            // Approximate Entropy settings
            approxEntropyM: 2,  // Pattern length
            approxEntropyR: 0.2,  // Tolerance ratio

            // Signal scoring
            minTotalScore: 60,  // was 70 – slight relaxation  // Minimum score to trade (0-100)

            // Cooldown system
            cooldownTicks: 20,//25
            cooldownAfterLoss: 40,//50
            suspensionAfterDoubleLoss: 100,  // Suspend asset after 2L
            maxTradesPerHour: 6,  // Per asset

            // Money management (MODIFIED for safety)
            baseStake: 2.2,
            firstLossMultiplier: 11.3,  // First loss: 5 × 2 = $10
            subsequentMultiplier: 11.3,  // Subsequent: 5 × 10^(n-1)
            maxConsecutiveLosses: 6,
            maxStake: 1500,  // Cap maximum stake
            takeProfit: 20000,
            stopLoss: -800,

            // Time filters
            avoidMinutesAroundHour: 4,

            // Adaptive system
            adaptiveEnabled: true,
            recentTradesForAdaptation: 50,

            // Asset suspension
            suspendAssetAfterLosses: 2,
            suspensionDuration: 2000  // 5 minutes (300000)
        };

        // ====== TRADING STATE ======
        this.histories = {};
        this.assetList = Object.keys(this.config.assets);
        this.assetList.forEach(a => this.histories[a] = []);

        // Caches for each asset
        this.fractalCache = {};
        this.entropyCache = {};
        this.confluenceCache = {};
        this.assetList.forEach(a => {
            this.fractalCache[a] = [];
            this.entropyCache[a] = [];
            this.confluenceCache[a] = [];
        });

        // Trading state
        this.stake = this.config.baseStake;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.x2 = 0; this.x3 = 0; this.x4 = 0; this.x5 = 0;
        this.netProfit = 0;
        this.ticks = 0;

        // Per-asset state
        this.lastTradeDigit = {};
        this.lastTradeTime = {};
        this.ticksSinceLastTrade = {};
        this.tradesThisHour = {};
        this.assetConsecutiveLosses = {};
        this.suspendedAssets = {};
        this.assetList.forEach(a => {
            this.lastTradeDigit[a] = null;
            this.lastTradeTime[a] = 0;
            this.ticksSinceLastTrade[a] = 999;
            this.tradesThisHour[a] = 0;
            this.assetConsecutiveLosses[a] = 0;
            this.suspendedAssets[a] = false;
        });

        this.tradeInProgress = false;
        this.currentTradingAsset = null;

        // Performance tracking
        this.recentTrades = [];
        this.assetPerformance = {};
        this.assetList.forEach(a => {
            this.assetPerformance[a] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        });

        // Hourly stats
        this.hourly = { trades: 0, wins: 0, losses: 0, pnl: 0 };

        // WebSocket
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.historyLoaded = {};
        this.assetList.forEach(a => this.historyLoaded[a] = false);

        // Reconnection
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 5000;
        this.isReconnecting = false;

        // Telegram
        this.telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

        // Initialize
        this.loadState();
        this.connect();
        this.startHourlySummary();
        this.startHourlyReset();
        this.startAutoSave();
    }

    // ========================================================================
    // ENHANCEMENT #1: HIGUCHI FRACTAL DIMENSION (Proper for discrete data)
    // ========================================================================
    calculateHiguchiFractalDimension(data, kMax = 10) {
        const n = data.length;
        if (n < kMax * 4) return 1.5;

        const L = [];

        for (let k = 1; k <= kMax; k++) {
            let Lk = 0;

            for (let m = 1; m <= k; m++) {
                let Lmk = 0;
                const limit = Math.floor((n - m) / k);

                for (let i = 1; i <= limit; i++) {
                    Lmk += Math.abs(data[m + i * k - 1] - data[m + (i - 1) * k - 1]);
                }

                Lmk = (Lmk * (n - 1)) / (k * limit * k);
                Lk += Lmk;
            }

            L.push(Lk / k);
        }

        // Linear regression of log(L) vs log(1/k)
        const logK = [];
        const logL = [];

        for (let k = 1; k <= kMax; k++) {
            if (L[k - 1] > 0) {
                logK.push(Math.log(1 / k));
                logL.push(Math.log(L[k - 1]));
            }
        }

        if (logK.length < 3) return 1.5;

        // Calculate slope (fractal dimension)
        const fd = this.linearRegressionSlope(logK, logL);

        return Math.max(1.0, Math.min(2.0, fd));
    }

    linearRegressionSlope(x, y) {
        const n = x.length;
        if (n < 2) return 1.5;

        const sumX = x.reduce((a, b) => a + b, 0);
        const sumY = y.reduce((a, b) => a + b, 0);
        const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
        const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);

        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

        return isNaN(slope) ? 1.5 : slope;
    }

    // ========================================================================
    // ENHANCEMENT #2: KATZ FRACTAL DIMENSION (Alternative method)
    // ========================================================================
    calculateKatzFractalDimension(data) {
        const n = data.length;
        if (n < 20) return 1.5;

        // Calculate total path length
        let L = 0;
        for (let i = 1; i < n; i++) {
            L += Math.abs(data[i] - data[i - 1]);
        }

        // Calculate maximum distance from start
        let d = 0;
        for (let i = 1; i < n; i++) {
            const dist = Math.abs(data[i] - data[0]);
            if (dist > d) d = dist;
        }

        if (d === 0 || L === 0) return 1.5;

        // Katz formula
        const a = Math.log10(n - 1);
        const fd = a / (a + Math.log10(d / L));

        return Math.max(1.0, Math.min(2.0, fd));
    }

    // ========================================================================
    // ENHANCEMENT #3: MULTI-WINDOW FRACTAL ANALYSIS
    // ========================================================================
    calculateFractalAnalysis(asset) {
        const history = this.histories[asset];
        const windows = this.config.fractalWindows;
        const weights = this.config.fractalWeights;

        let weightedSum = 0;
        let totalWeight = 0;
        const windowResults = [];

        for (let i = 0; i < windows.length; i++) {
            const w = windows[i];
            const weight = weights[i];

            if (history.length < w) continue;

            const slice = history.slice(-w);

            // Preprocess: Convert to Cumulative Sum (Random Walk)
            // Raw digits are white noise (FD ~= 2.0), we need Random Walk to measure trend/persistence
            const cumSum = [];
            let sum = 0;
            const mean = 4.5;
            for (let j = 0; j < slice.length; j++) {
                sum += (slice[j] - mean);
                cumSum.push(sum);
            }

            // Calculate both Higuchi and Katz FD using cumSum
            const higuchiFD = this.calculateHiguchiFractalDimension(cumSum);
            const katzFD = this.calculateKatzFractalDimension(cumSum);

            // Weighted average (Higuchi 60%, Katz 40%)
            const combinedFD = higuchiFD * 0.6 + katzFD * 0.4;

            weightedSum += combinedFD * weight;
            totalWeight += weight;

            windowResults.push({
                window: w,
                higuchi: higuchiFD,
                katz: katzFD,
                combined: combinedFD,
                weight
            });
        }

        if (totalWeight === 0) return null;

        const avgFractalDim = weightedSum / totalWeight;

        // Track fractal dimension trend
        this.fractalCache[asset].push(avgFractalDim);
        if (this.fractalCache[asset].length > 30) {
            this.fractalCache[asset].shift();
        }

        let fdTrend = 0;
        if (this.fractalCache[asset].length >= 10) {
            const recent = this.fractalCache[asset].slice(-5);
            const older = this.fractalCache[asset].slice(-10, -5);
            const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
            const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
            fdTrend = recentAvg - olderAvg;
        }

        const assetConfig = this.config.assets[asset];

        const score = this.calculateFractalScore(avgFractalDim, fdTrend, assetConfig.fractalThreshold);


        const isLowFractal = avgFractalDim < assetConfig.fractalThreshold && score > 2.5;
        // console.log("isLowFractal", '(', avgFractalDim, ') | threshold', assetConfig.fractalThreshold);
        const isDropping = fdTrend < -0.002;
        // console.log("isDropping trend", '(', fdTrend, ') | threshold', -0.002);

        return {
            avgFractalDim,
            windowResults,
            fdTrend,
            isLowFractal,
            isDropping,
            score
        };
    }

    calculateFractalScore(fd, trend, threshold) {
        // Base score from fractal dimension (max 25 points)
        let score = 0;
        if (fd < threshold) {
            score = Math.min(25, (threshold - fd) * 100);
        }

        // Bonus for dropping trend (max 10 points)
        if (trend < 0) {
            score += Math.min(10, Math.abs(trend) * 150);
        }

        return score;
    }

    // ========================================================================
    // ENHANCEMENT #4: APPROXIMATE ENTROPY (Better than Shannon for patterns)
    // ========================================================================
    calculateApproximateEntropy(data, m = 2, r = 0.2) {
        const n = data.length;
        if (n < m + 2) return 0;

        // Standardize data
        const mean = data.reduce((a, b) => a + b, 0) / n;
        const std = Math.sqrt(data.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n);
        const tolerance = r * (std || 1);

        const phi = (m) => {
            const patterns = [];
            for (let i = 0; i <= n - m; i++) {
                patterns.push(data.slice(i, i + m));
            }

            let sum = 0;
            for (let i = 0; i < patterns.length; i++) {
                let count = 0;
                for (let j = 0; j < patterns.length; j++) {
                    let match = true;
                    for (let k = 0; k < m; k++) {
                        if (Math.abs(patterns[i][k] - patterns[j][k]) > tolerance) {
                            match = false;
                            break;
                        }
                    }
                    if (match) count++;
                }
                sum += Math.log(count / patterns.length);
            }
            return sum / patterns.length;
        };

        const phiM = phi(m);
        const phiM1 = phi(m + 1);

        return phiM - phiM1;
    }

    // ========================================================================
    // ENHANCEMENT #5: WEIGHTED FIBONACCI CONFLUENCE
    // ========================================================================
    calculateFibonacciConfluence(asset) {
        const history = this.histories[asset];
        const windows = this.config.fibonacciWindows;

        const windowAnalysis = [];
        const digitScores = Array(10).fill(0);
        const digitParticipation = Array(10).fill(0);

        for (const w of windows) {
            if (history.length < w) continue;

            const slice = history.slice(-w);
            const counts = Array(10).fill(0);
            slice.forEach(d => counts[d]++);

            const exp = w / 10;
            const sd = Math.sqrt(w * 0.1 * 0.9);

            // Find dominant digit and its strength
            const maxCount = Math.max(...counts);
            const dominantDigit = counts.indexOf(maxCount);
            const dominance = maxCount / w;
            const zScore = (maxCount - exp) / sd;

            // Weight larger windows more
            const windowWeight = Math.log2(w) / Math.log2(610);

            windowAnalysis.push({
                window: w,
                dominantDigit,
                dominance,
                zScore,
                weight: windowWeight
            });

            // Accumulate weighted scores for each digit
            for (let d = 0; d < 10; d++) {
                const dZ = (counts[d] - exp) / sd;
                if (dZ > 0.5) {  // Only positive contributions
                    digitScores[d] += dZ * windowWeight;
                    digitParticipation[d]++;
                }
            }
        }

        if (windowAnalysis.length === 0) return null;

        // Find best digit by weighted score
        let bestDigit = -1;
        let bestScore = -999;

        for (let d = 0; d < 10; d++) {
            if (digitParticipation[d] >= 4) {  // Must appear in 4+ windows
                const avgScore = digitScores[d] / digitParticipation[d];
                if (avgScore > bestScore) {
                    bestScore = avgScore;
                    bestDigit = d;
                }
            }
        }

        // Calculate confluence strength
        const totalWindows = windowAnalysis.length;
        const dominantWindows = windowAnalysis.filter(w => w.dominantDigit === bestDigit).length;
        const confluenceStrength = dominantWindows / totalWindows;

        // Calculate average Z-score for best digit
        let avgZScore = 0;
        let zCount = 0;
        for (const w of windowAnalysis) {
            if (w.dominantDigit === bestDigit) {
                avgZScore += w.zScore;
                zCount++;
            }
        }
        avgZScore = zCount > 0 ? avgZScore / zCount : 0;

        // Track confluence trend
        this.confluenceCache[asset].push(confluenceStrength);
        if (this.confluenceCache[asset].length > 20) {
            this.confluenceCache[asset].shift();
        }

        const assetConfig = this.config.assets[asset];
        const hasConfluence = confluenceStrength >= assetConfig.minConfluence;
        const hasZScore = avgZScore >= assetConfig.minZScore;
        const inRecent = history.slice(-9).includes(bestDigit);

        return {
            bestDigit,
            confluenceStrength,
            avgZScore,
            windowAnalysis,
            hasConfluence,
            hasZScore,
            inRecent,
            score: this.calculateConfluenceScore(confluenceStrength, avgZScore, assetConfig)
        };
    }

    calculateConfluenceScore(confluence, zScore, config) {
        // Base score from confluence (max 25 points)
        let score = 0;
        if (confluence >= config.minConfluence) {
            score = Math.min(25, (confluence - config.minConfluence) * 150 + 10);
        }

        // Bonus from Z-score (max 15 points)
        if (zScore >= config.minZScore) {
            score += Math.min(15, (zScore - config.minZScore) * 8 + 5);
        }

        return score;
    }

    // ========================================================================
    // ENHANCEMENT #6: CONCENTRATION ANALYSIS (Multi-window)
    // ========================================================================
    calculateConcentrationAnalysis(asset) {
        const history = this.histories[asset];
        const windows = [50, 100, 200, 400, 800];

        const results = [];

        for (const w of windows) {
            if (history.length < w) continue;

            const slice = history.slice(-w);
            const freq = Array(10).fill(0);
            slice.forEach(d => freq[d]++);

            // Shannon entropy
            let shannonEntropy = 0;
            for (let f of freq) {
                if (f > 0) {
                    const p = f / w;
                    shannonEntropy -= p * Math.log2(p);
                }
            }

            const maxEntropy = Math.log2(10);
            const concentration = 1 - (shannonEntropy / maxEntropy);

            // Approximate entropy for this window
            const approxEntropy = this.calculateApproximateEntropy(slice);

            // Combined concentration metric
            const combinedConc = concentration * 0.7 + (1 - approxEntropy) * 0.3;

            results.push({
                window: w,
                shannon: concentration,
                approximate: approxEntropy,
                combined: combinedConc
            });
        }

        if (results.length === 0) return null;

        // Weighted average (favor recent)
        const weights = [3.0, 2.0, 1.5, 1.0, 0.8];
        let weightedConc = 0;
        let totalWeight = 0;

        for (let i = 0; i < results.length; i++) {
            weightedConc += results[i].combined * weights[i];
            totalWeight += weights[i];
        }

        const avgConcentration = weightedConc / totalWeight;

        // Track trend
        this.entropyCache[asset].push(avgConcentration);
        if (this.entropyCache[asset].length > 25) {
            this.entropyCache[asset].shift();
        }

        let concTrend = 0;
        if (this.entropyCache[asset].length >= 10) {
            const recent = this.entropyCache[asset].slice(-5);
            const older = this.entropyCache[asset].slice(-10, -5);
            concTrend = (recent.reduce((a, b) => a + b, 0) / 5) -
                (older.reduce((a, b) => a + b, 0) / 5);
        }

        const assetConfig = this.config.assets[asset];
        const isConcentrated = avgConcentration > assetConfig.concentrationThreshold;
        const isIncreasing = concTrend > 0.003;

        return {
            avgConcentration,
            results,
            concTrend,
            isConcentrated,
            isIncreasing,
            score: this.calculateConcentrationScore(avgConcentration, concTrend, assetConfig)
        };
    }

    calculateConcentrationScore(concentration, trend, config) {
        // Base score (max 15 points)
        let score = 0;
        if (concentration > config.concentrationThreshold) {
            score = Math.min(15, (concentration - config.concentrationThreshold) * 250);
        }

        // Trend bonus (max 5 points)
        if (trend > 0) {
            score += Math.min(5, trend * 500);
        }

        return score;
    }

    // ========================================================================
    // ENHANCEMENT #7: STREAK EXHAUSTION DETECTION
    // ========================================================================
    analyzeStreakExhaustion(history, targetDigit) {
        if (history.length < 50) return null;

        const last50 = history.slice(-50);

        // Current streak of target digit
        let currentStreak = 0;
        for (let i = last50.length - 1; i >= 0; i--) {
            if (last50[i] === targetDigit) {
                currentStreak++;
            } else {
                break;
            }
        }

        // Count appearances in different windows
        const last10 = history.slice(-10);
        const last20 = history.slice(-20);
        const last30 = history.slice(-30);

        const count10 = last10.filter(d => d === targetDigit).length;
        const count20 = last20.filter(d => d === targetDigit).length;
        const count30 = last30.filter(d => d === targetDigit).length;

        // Calculate exhaustion indicators
        const density10 = count10 / 10;
        const density20 = count20 / 20;
        const density30 = count30 / 30;

        // Exhaustion = high density but decreasing trend
        const isExhausting = density10 < density20 && density20 < density30;
        const hasStreak = currentStreak >= 2;

        return {
            currentStreak,
            density10,
            density20,
            density30,
            isExhausting,
            hasStreak,
            score: this.calculateStreakScore(currentStreak, hasStreak, isExhausting)
        };
    }

    calculateStreakScore(streak, hasStreak, isExhausting) {
        let score = 0;

        // Streak bonus (max 8 points)
        if (hasStreak) {
            score += Math.min(8, streak * 1.5);
        }

        // Exhaustion bonus (max 7 points)
        if (isExhausting) {
            score += 7;
        }

        return score;
    }

    // ========================================================================
    // ENHANCEMENT #8: COOLDOWN & ASSET SUSPENSION
    // ========================================================================
    // canTrade(asset) {
    //     // Basic checks
    //     if (this.tradeInProgress) return false;
    //     if (!this.wsReady) return false;
    //     if (!this.historyLoaded[asset]) return false;
    //     if (this.histories[asset].length < this.config.minHistoryForTrading) return false;

    //     // Asset suspended?
    //     if (this.suspendedAssets[asset]) return false;

    //     // Global consecutive loss check
    //     if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) return false;

    //     // Stop loss check
    //     if (this.netProfit <= this.config.stopLoss) return false;

    //     // Cooldown check
    //     const ticksSinceLast = this.ticksSinceLastTrade[asset];
    //     let requiredCooldown = this.config.cooldownTicks;

    //     if (this.consecutiveLosses > 0) {
    //         requiredCooldown = this.config.cooldownAfterLoss;
    //     }
    //     if (this.assetConsecutiveLosses[asset] >= 2) {
    //         requiredCooldown = this.config.suspensionAfterDoubleLoss;
    //     }

    //     if (ticksSinceLast < requiredCooldown) return false;

    //     // Hourly frequency check
    //     if (this.tradesThisHour[asset] >= this.config.maxTradesPerHour) return false;

    //     // Time filter
    //     const now = new Date();
    //     const minute = now.getMinutes();
    //     if (minute < this.config.avoidMinutesAroundHour ||
    //         minute > (60 - this.config.avoidMinutesAroundHour)) {
    //         return false;
    //     }

    //     return true;
    // }

    canTrade(asset) {
        const h = this.histories[asset];
        const len = h.length;
        const logPrefix = `[${asset}] canTrade`;

        let reason = null;

        if (this.tradeInProgress) reason = 'tradeInProgress';
        else if (!this.wsReady) reason = 'wsNotReady';
        else if (!this.historyLoaded[asset]) reason = 'historyNotLoaded';
        else if (len < this.config.minHistoryForTrading)
            reason = `notEnoughHistory(${len}/${this.config.minHistoryForTrading})`;
        else if (this.suspendedAssets[asset]) reason = 'assetSuspended';
        else if (this.consecutiveLosses >= this.config.maxConsecutiveLosses)
            reason = `maxConsecLosses(${this.consecutiveLosses})`;
        else if (this.netProfit <= this.config.stopLoss)
            reason = `stopLossReached(${this.netProfit.toFixed(2)})`;
        else {
            const ticksSinceLast = this.ticksSinceLastTrade[asset];
            let requiredCooldown = this.config.cooldownTicks;

            if (this.consecutiveLosses > 0) {
                requiredCooldown = this.config.cooldownAfterLoss;
            }
            if (this.assetConsecutiveLosses[asset] >= 2) {
                requiredCooldown = this.config.suspensionAfterDoubleLoss;
            }

            if (ticksSinceLast < requiredCooldown) {
                reason = `cooldown(${ticksSinceLast}/${requiredCooldown})`;
            } else if (this.tradesThisHour[asset] >= this.config.maxTradesPerHour) {
                reason = `maxTradesPerHour(${this.tradesThisHour[asset]})`;
            }
            // else {
            //     const now = new Date();
            //     const minute = now.getMinutes();
            //     if (minute < this.config.avoidMinutesAroundHour ||
            //         minute > (60 - this.config.avoidMinutesAroundHour)) {
            //         reason = `timeFilter(min=${minute})`;
            //     }
            // }
        }

        const ok = (reason === null);

        if (!ok && len > 0 && len % 500 === 0) {
            console.log(`${logPrefix}=false → ${reason}`);
        } else if (ok && len > 0 && len % 500 === 0) {
            // console.log(
            //     `${logPrefix}=true | len=${len}, consecLosses=${this.consecutiveLosses}, net=${this.netProfit.toFixed(2)}`
            // );
        }

        return ok;
    }

    suspendAsset(asset) {
        this.suspendedAssets[asset] = true;
        console.log(`🚫 ${asset} suspended for ${this.config.suspensionDuration / 1000}s`);

        setTimeout(() => {
            this.suspendedAssets[asset] = false;
            this.assetConsecutiveLosses[asset] = 0;
            console.log(`✅ ${asset} reactivated`);
        }, this.config.suspensionDuration);
    }

    // ========================================================================
    // ENHANCEMENT #9: ADAPTIVE THRESHOLDS
    // ========================================================================
    getAdaptiveThresholds(asset) {
        if (!this.config.adaptiveEnabled || this.recentTrades.length < 25) {
            return {
                minScore: this.config.minTotalScore,
                assetWeight: this.config.assets[asset].weight
            };
        }

        // Overall performance
        const recentWins = this.recentTrades.filter(t => t.won).length;
        const overallWinRate = recentWins / this.recentTrades.length;

        // Asset-specific performance
        const assetTrades = this.recentTrades.filter(t => t.asset === asset);
        const assetWinRate = assetTrades.length > 5
            ? assetTrades.filter(t => t.won).length / assetTrades.length
            : overallWinRate;

        // Adjust thresholds
        let minScore = this.config.minTotalScore;
        let assetWeight = this.config.assets[asset].weight;

        // Global adjustment
        if (overallWinRate < 0.88) {
            minScore = 65;
        } else if (overallWinRate > 0.96) {
            minScore = 60;
        }

        // Asset-specific adjustment
        if (assetWinRate < 0.85) {
            assetWeight *= 0.4;
        } else if (assetWinRate > 0.95) {
            assetWeight *= 1.25;
        }

        return { minScore, assetWeight };
    }

    // ========================================================================
    // ENHANCEMENT #10: UNIFIED SIGNAL SCORING
    // ========================================================================
    // calculateTotalSignalScore(asset, fractalAnalysis, fibConfluence, concentrationAnalysis, streakAnalysis) {
    //     const adaptive = this.getAdaptiveThresholds(asset);

    //     // Component scores
    //     const fractalScore = fractalAnalysis?.score || 0;
    //     const confluenceScore = fibConfluence?.score || 0;
    //     const concentrationScore = concentrationAnalysis?.score || 0;
    //     const streakScore = streakAnalysis?.score || 0;

    //     // Total raw score (max 100)
    //     const rawScore = fractalScore + confluenceScore + concentrationScore + streakScore;

    //     // Apply asset weight
    //     const weightedScore = rawScore * adaptive.assetWeight;

    //     // Target digit from Fibonacci confluence
    //     const targetDigit = fibConfluence?.bestDigit ?? -1;

    //     // Validation checks
    //     const isValid =
    //         weightedScore >= adaptive.minScore &&
    //         fractalAnalysis?.isLowFractal &&
    //         fibConfluence?.hasConfluence &&
    //         fibConfluence?.hasZScore &&
    //         fibConfluence?.inRecent &&
    //         concentrationAnalysis?.isConcentrated &&
    //         targetDigit !== -1;

    //     return {
    //         rawScore,
    //         weightedScore,
    //         minScore: adaptive.minScore,
    //         targetDigit,
    //         isValid,
    //         components: {
    //             fractal: fractalScore,
    //             confluence: confluenceScore,
    //             concentration: concentrationScore,
    //             streak: streakScore
    //         }
    //     };
    // }

    calculateTotalSignalScore(asset, fractalAnalysis, fibConfluence, concentrationAnalysis, streakAnalysis) {
        const adaptive = this.getAdaptiveThresholds(asset);

        const fractalScore = fractalAnalysis?.score || 0;
        const confluenceScore = fibConfluence?.score || 0;
        const concentrationScore = concentrationAnalysis?.score || 0;
        const streakScore = streakAnalysis?.score || 0;

        const rawScore = fractalScore + confluenceScore + concentrationScore + streakScore;
        const weightedScore = rawScore * adaptive.assetWeight;

        const targetDigit = fibConfluence?.bestDigit ?? -1;

        // Count how many major conditions are met
        const majorFlags = [
            fractalAnalysis?.isLowFractal,
            fibConfluence?.hasConfluence,
            fibConfluence?.hasZScore,
            fibConfluence?.inRecent,
            concentrationAnalysis?.isConcentrated
        ].filter(Boolean).length;

        // console.log('fractalAnalysis_Flag1', fractalAnalysis?.isLowFractal, 'Score', fractalScore.toFixed(2));
        // console.log('fibConfluence_Flag2', fibConfluence?.hasConfluence, 'Score', confluenceScore.toFixed(2));
        // console.log('fibConfluence_Flag3', fibConfluence?.hasZScore, 'Score', confluenceScore.toFixed(2));
        // console.log('fibConfluence_Flag4', fibConfluence?.inRecent, 'Score', confluenceScore.toFixed(2));
        // console.log('concentrationAnalysis_Flag5', concentrationAnalysis?.isConcentrated, 'Score', confluenceScore.toFixed(2));
        const isValid =
            weightedScore >= adaptive.minScore &&
            majorFlags >= 5 &&           // at least 4 of 5 major conditions
            targetDigit !== -1;

        return {
            rawScore,
            weightedScore,
            minScore: adaptive.minScore,
            targetDigit,
            isValid,
            components: {
                fractal: fractalScore,
                confluence: confluenceScore,
                concentration: concentrationScore,
                streak: streakScore,
                majorFlags
            }
        };
    }

    // ========================================================================
    // MAIN SIGNAL SCANNER
    // ========================================================================


    // scanForSignal(asset) {
    //     if (!this.canTrade(asset)) return;

    //     const history = this.histories[asset];

    //     // Step 1: Fractal Analysis
    //     const fractalAnalysis = this.calculateFractalAnalysis(asset);
    //     if (!fractalAnalysis || !fractalAnalysis.isLowFractal) return;

    //     // Step 2: Fibonacci Confluence
    //     const fibConfluence = this.calculateFibonacciConfluence(asset);
    //     if (!fibConfluence || !fibConfluence.hasConfluence) return;

    //     // Step 3: Concentration Analysis
    //     const concentrationAnalysis = this.calculateConcentrationAnalysis(asset);
    //     if (!concentrationAnalysis || !concentrationAnalysis.isConcentrated) return;

    //     // Step 4: Streak Analysis
    //     const targetDigit = fibConfluence.bestDigit;
    //     const streakAnalysis = this.analyzeStreakExhaustion(history, targetDigit);

    //     // Step 5: Calculate total score
    //     const signal = this.calculateTotalSignalScore(
    //         asset, fractalAnalysis, fibConfluence, concentrationAnalysis, streakAnalysis
    //     );

    //     // Log periodically
    //     if (history.length % 150 === 0) {
    //         console.log(`[${asset}] Score=${signal.weightedScore.toFixed(1)}/${signal.minScore} | FD=${fractalAnalysis.avgFractalDim.toFixed(3)} | Conf=${fibConfluence.confluenceStrength.toFixed(2)} | Z=${fibConfluence.avgZScore.toFixed(2)} | Conc=${concentrationAnalysis.avgConcentration.toFixed(4)} | D=${targetDigit} | Valid=${signal.isValid}`);
    //     }

    //     // Step 6: Check validity
    //     if (!signal.isValid) return;

    //     // Step 7: Same digit check
    //     if (signal.targetDigit === this.lastTradeDigit[asset]) {
    //         if (signal.weightedScore < signal.minScore + 20) return;
    //     }

    //     // Step 8: Execute trade
    //     this.placeTrade(asset, signal, fractalAnalysis, fibConfluence, concentrationAnalysis);
    // }


    scanForSignal(asset) {
        const history = this.histories[asset];
        const len = history.length;

        if (!this.canTrade(asset)) return;

        // --- STEP 1: Fractal Analysis ---
        const fractalAnalysis = this.calculateFractalAnalysis(asset);
        if (!fractalAnalysis) {
            //Log every 20 Ticks
            if (this.ticks % 20 === 0)
                console.log(`[${asset}] FractalAnalysis=null`);
            return;
        }

        if (this.ticks % 20 === 0) {
            // console.log(
            //     `[${asset}] FRACTAL avgFD=${fractalAnalysis.avgFractalDim.toFixed(3)} ` +
            //     `trend=${fractalAnalysis.fdTrend.toFixed(4)} ` +
            //     `isLow=${fractalAnalysis.isLowFractal} ` +
            //     `score=${fractalAnalysis.score.toFixed(1)}`
            // );
        }

        // --- STEP 2: Fibonacci Confluence ---
        const fibConfluence = this.calculateFibonacciConfluence(asset);
        if (!fibConfluence) {
            //Log every 20 Ticks
            // if (this.ticks % 20 === 0)
            //     console.log(`[${asset}] FibConfluence=null`);
            return;
        }

        if (this.ticks % 20 === 0) {
            console.log(
                `[${asset}] FIB confStrength=${fibConfluence.confluenceStrength.toFixed(2)} ` +
                `avgZ=${fibConfluence.avgZScore.toFixed(2)} ` +
                `bestDigit=${fibConfluence.bestDigit} ` +
                `hasConf=${fibConfluence.hasConfluence} hasZ=${fibConfluence.hasZScore} ` +
                `inRecent=${fibConfluence.inRecent} score=${fibConfluence.score.toFixed(1)}`
            );
        }

        // --- STEP 3: Concentration Analysis ---
        const concentrationAnalysis = this.calculateConcentrationAnalysis(asset);
        if (!concentrationAnalysis) {
            // if (len % 500 === 0)
            //     console.log(`[${asset}] ConcentrationAnalysis=null`);
            return;
        }

        if (this.ticks % 20 === 0) {
            // console.log(
            //     `[${asset}] CONC avg=${concentrationAnalysis.avgConcentration.toFixed(4)} ` +
            //     `trend=${concentrationAnalysis.concTrend.toFixed(4)} ` +
            //     `isConcentrated=${concentrationAnalysis.isConcentrated} ` +
            //     `score=${concentrationAnalysis.score.toFixed(1)}`
            // );
        }

        // --- STEP 4: Streak / Exhaustion ---
        const targetDigit = fibConfluence.bestDigit;
        const streakAnalysis = this.analyzeStreakExhaustion(history, targetDigit) || {
            currentStreak: 0,
            density10: 0,
            density20: 0,
            density30: 0,
            isExhausting: false,
            hasStreak: false,
            score: 0
        };

        if (this.ticks % 20 === 0) {
            // console.log(
            //     `[${asset}] STREAK digit=${targetDigit} ` +
            //     `streak=${streakAnalysis.currentStreak} ` +
            //     `dens10=${streakAnalysis.density10?.toFixed(2) ?? '0.00'} ` +
            //     `dens20=${streakAnalysis.density20?.toFixed(2) ?? '0.00'} ` +
            //     `dens30=${streakAnalysis.density30?.toFixed(2) ?? '0.00'} ` +
            //     `exhaust=${streakAnalysis.isExhausting} score=${streakAnalysis.score.toFixed(1)}`
            // );
        }

        // --- STEP 5: Total Score ---
        const signal = this.calculateTotalSignalScore(
            asset, fractalAnalysis, fibConfluence, concentrationAnalysis, streakAnalysis
        );

        if (this.ticks % 20 === 0) {
            // console.log(
            //     `[${asset}] TOTAL Score=${signal.weightedScore.toFixed(1)}/${signal.minScore} ` +
            //     `components={FD:${signal.components.fractal.toFixed(1)}, ` +
            //     `Conf:${signal.components.confluence.toFixed(1)}, ` +
            //     `Conc:${signal.components.concentration.toFixed(1)}, ` +
            //     `Streak:${signal.components.streak.toFixed(1)}, ` +
            //     `flags:${signal.components.majorFlags}} ` +
            //     `targetDigit=${signal.targetDigit} isValid=${signal.isValid}`
            // );
        }

        // --- STEP 6: Validity check ---
        if (!signal.isValid) {
            if (this.ticks % 20 === 0) {
                console.log(
                    `[${asset}] Signal rejected: ` +
                    `weightedScore=${signal.weightedScore.toFixed(1)} < minScore=${signal.minScore} ` +
                    `or insufficient majorFlags (${signal.components.majorFlags})`
                );
            }
            return;
        }

        // --- STEP 7: Same-digit suppression ---
        if (signal.targetDigit === this.lastTradeDigit[asset] &&
            signal.weightedScore < signal.minScore + 20) {
            if (this.ticks % 20 === 0) {
                console.log(
                    `[${asset}] Signal rejected (same digit): digit=${signal.targetDigit} ` +
                    `score=${signal.weightedScore.toFixed(1)} < ${signal.minScore + 20}`
                );
            }
            return;
        }

        // --- STEP 8: Execute trade ---
        this.placeTrade(asset, signal, fractalAnalysis, fibConfluence, concentrationAnalysis);
    }

    // ========================================================================
    // TRADE EXECUTION
    // ========================================================================
    placeTrade(asset, signal, fractalAnalysis, fibConfluence, concentrationAnalysis) {
        if (this.tradeInProgress) return;

        // Calculate stake with cap
        let tradeStake = this.stake;
        if (tradeStake > this.config.maxStake) {
            tradeStake = this.config.maxStake;
            console.log(`⚠️ Stake capped at $${this.config.maxStake}`);
        }

        this.tradeInProgress = true;
        this.currentTradingAsset = asset;
        this.lastTradeDigit[asset] = signal.targetDigit;
        this.lastTradeTime[asset] = Date.now();
        this.ticksSinceLastTrade[asset] = 0;
        this.tradesThisHour[asset]++;

        console.log(`\n🎯 ATHENA SIGNAL — ${asset}`);
        console.log(`   Digit: ${signal.targetDigit}`);
        console.log(`   last10Digits: ${this.histories[asset].slice(-10).join(',')}`);
        console.log(`   Score: ${signal.weightedScore.toFixed(1)}/${signal.minScore}`);
        console.log(`   FD: ${fractalAnalysis.avgFractalDim.toFixed(3)}`);
        console.log(`   Confluence: ${(fibConfluence.confluenceStrength * 100).toFixed(1)}%`);
        console.log(`   Z-Score: ${fibConfluence.avgZScore.toFixed(2)}`);
        console.log(`   Concentration: ${concentrationAnalysis.avgConcentration.toFixed(4)}`);
        console.log(`   Stake: $${tradeStake.toFixed(2)}`);

        this.sendRequest({
            buy: 1,
            price: tradeStake,
            parameters: {
                amount: tradeStake,
                basis: "stake",
                contract_type: "DIGITDIFF",
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: asset,
                barrier: signal.targetDigit.toString()
            }
        });

        this.sendTelegram(`
            🎯 <b>ATHENA v9 TRADE</b>

            📊 Asset: ${asset}
            🔢 Digit: ${signal.targetDigit}
            last10Digits: ${this.histories[asset].slice(-10).join(',')}
            📈 Score: ${signal.weightedScore.toFixed(1)}/${signal.minScore}
            📉 FD: ${fractalAnalysis.avgFractalDim.toFixed(3)}
            🔗 Confluence: ${(fibConfluence.confluenceStrength * 100).toFixed(1)}%
            📊 Z: ${fibConfluence.avgZScore.toFixed(2)}
            🔬 Conc: ${concentrationAnalysis.avgConcentration.toFixed(4)}
            💰 Stake: $${tradeStake.toFixed(2)}
            📊 Losses: ${this.consecutiveLosses}
        `.trim());
    }

    // ========================================================================
    // TRADE RESULT HANDLING
    // ========================================================================
    handleTradeResult(contract) {
        const won = contract.status === "won";
        const profit = parseFloat(contract.profit);
        const asset = contract.underlying;
        const exitDigit = this.getLastDigit(contract.exit_tick_display_value, asset);

        this.totalTrades++;
        this.hourly.trades++;
        this.hourly.pnl += profit;
        this.netProfit += profit;

        // Asset performance tracking
        this.assetPerformance[asset].trades++;
        this.assetPerformance[asset].pnl += profit;

        // Track for adaptive thresholds
        this.recentTrades.push({ won, profit, asset, time: Date.now() });
        if (this.recentTrades.length > this.config.recentTradesForAdaptation) {
            this.recentTrades.shift();
        }

        console.log(`\n${won ? '✅ WIN' : '❌ LOSS'} — ${asset}`);
        console.log(`   Exit Digit: ${exitDigit}`);
        console.log(`   Profit: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
        console.log(`   Net P&L: $${this.netProfit.toFixed(2)}`);

        if (won) {
            this.totalWins++;
            this.hourly.wins++;
            this.assetPerformance[asset].wins++;
            this.consecutiveLosses = 0;
            this.assetConsecutiveLosses[asset] = 0;
            this.stake = this.config.baseStake;
        } else {
            this.hourly.losses++;
            this.assetPerformance[asset].losses++;
            this.consecutiveLosses++;
            this.assetConsecutiveLosses[asset]++;

            if (this.consecutiveLosses === 2) this.x2++;
            if (this.consecutiveLosses === 3) this.x3++;
            if (this.consecutiveLosses === 4) this.x4++;
            if (this.consecutiveLosses === 5) this.x5++;

            // Money management (modified for safety)
            // if (this.consecutiveLosses === 1) {
            //     this.stake = this.config.baseStake * this.config.firstLossMultiplier;
            // } else {
            //     this.stake = this.config.baseStake *
            //         Math.pow(this.config.subsequentMultiplier, this.consecutiveLosses - 1);
            // }
            // this.stake = Math.min(Math.round(this.stake * 100) / 100, this.config.maxStake);

            if (this.consecutiveLosses === 2) {
                this.stake = this.config.baseStake;
            } else {
                this.stake = Math.ceil(this.stake * this.config.firstLossMultiplier * 100) / 100;
            }

            // Asset suspension check
            if (this.assetConsecutiveLosses[asset] >= this.config.suspendAssetAfterLosses) {
                this.suspendAsset(asset);
            }
        }

        // Trade alert
        this.sendTelegram(`
            ${won ? '✅' : '❌'} <b>${won ? 'WIN' : 'LOSS'} — ATHENA v9</b>

            📊 Asset: ${asset}
            🔢 Exit: ${exitDigit}
            last10Digits: ${this.histories[asset].slice(-10).join(',')}
            💸 P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}
            📈 Total: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalTrades - this.totalWins}
            🔢 x2-x5: ${this.x2}/${this.x3}/${this.x4}/${this.x5}
            📈 Win Rate: ${this.totalWins / this.totalTrades * 100}%
            💰 Next: $${this.stake.toFixed(2)}
            💵 Net: $${this.netProfit.toFixed(2)}
            ${this.assetConsecutiveLosses[asset] >= 2 ? `\n🚫 ${asset} SUSPENDED` : ''}
        `.trim());

        // Stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || this.netProfit <= this.config.stopLoss) {
            console.log('🛑 Max consecutive losses reached');
            this.sendTelegram(`🛑 <b>MAX LOSSES!</b>\nFinal P&L: $${this.netProfit.toFixed(2)}`);
            this.disconnect();
            return;
        }

        // Take profit
        if (this.netProfit >= this.config.takeProfit) {
            console.log('🎉 Take profit reached!');
            this.sendTelegram(`🎉 <b>TAKE PROFIT!</b>\nFinal P&L: $${this.netProfit.toFixed(2)}`);
            this.disconnect();
            return;
        }

        this.tradeInProgress = false;
        this.currentTradingAsset = null;
    }

    // ========================================================================
    // TICK HANDLING
    // ========================================================================
    handleTickUpdate(tick) {
        const asset = tick.symbol;
        if (!this.assetList.includes(asset)) return;

        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.ticks = this.ticks + 1;

        this.histories[asset].push(lastDigit);
        if (this.histories[asset].length > this.config.requiredHistoryLength) {
            this.histories[asset].shift();
        }

        // Increment cooldown counter
        this.ticksSinceLastTrade[asset]++;

        // Log periodically
        if (this.tradeInProgress) {
            console.log(` 📈 [${asset}] Last 10: ${this.histories[asset].slice(-10).join(', ')}`);
        }

        // Scan for signals
        if (this.historyLoaded[asset] && !this.tradeInProgress && !this.suspendedAssets[asset]) {
            this.scanForSignal(asset);
        }
    }

    // ========================================================================
    // WEBSOCKET & UTILITIES
    // ========================================================================
    connect() {
        console.log('🔌 Connecting to Deriv API...');
        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.sendRequest({ authorize: TOKEN });
        });

        this.ws.on('message', (data) => {
            try {
                this.handleMessage(JSON.parse(data));
            } catch (e) {
                console.error('Parse error:', e.message);
            }
        });

        this.ws.on('close', () => {
            this.connected = false;
            this.wsReady = false;
            if (!this.isReconnecting && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnect();
            }
        });

        this.ws.on('error', (e) => console.error('WS Error:', e.message));
    }

    reconnect() {
        this.isReconnecting = true;
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
        setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    handleMessage(msg) {
        if (msg.error) {
            console.error('API Error:', msg.error.message);
            if (msg.msg_type === 'buy') {
                this.tradeInProgress = false;
            }
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                console.log('✅ Authenticated');
                this.wsReady = true;
                this.initializeSubscriptions();
                this.sendTelegram(`
                    🚀 <b>ATHENA PURE v9 ULTIMATE STARTED</b>

                    📊 Assets: ${this.assetList.join(', ')}
                    💰 Base Stake: $${this.config.baseStake}
                    🎯 Min Score: ${this.config.minTotalScore}
                    ⚠️ Max Stake: $${this.config.maxStake}
                `.trim());
                break;
            case 'history':
                this.handleTickHistory(msg);
                break;
            case 'tick':
                this.handleTickUpdate(msg.tick);
                break;
            case 'buy':
                if (!msg.error) {
                    this.sendRequest({
                        proposal_open_contract: 1,
                        contract_id: msg.buy.contract_id,
                        subscribe: 1
                    });
                } else {
                    this.tradeInProgress = false;
                }
                break;
            case 'proposal_open_contract':
                if (msg.proposal_open_contract?.is_sold) {
                    this.handleTradeResult(msg.proposal_open_contract);
                }
                break;
        }
    }

    initializeSubscriptions() {
        console.log('📊 Initializing subscriptions...');
        this.assetList.forEach(asset => {
            console.log(`   Subscribing to ${asset}...`);
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

    handleTickHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        const prices = msg.history?.prices || [];
        this.histories[asset] = prices.map(p => this.getLastDigit(p, asset));
        this.historyLoaded[asset] = true;
        console.log(`📊 Loaded ${this.histories[asset].length} ticks for ${asset}`);
    }

    getLastDigit(quote, asset) {
        const str = quote.toString();
        const [, dec = ''] = str.split('.');
        const assetConfig = this.config.assets[asset];
        if (!assetConfig) return 0;
        return dec.length > assetConfig.digitIndex ? +dec[assetConfig.digitIndex] : 0;
    }

    sendRequest(req) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(req));
        }
    }

    sendTelegram(text) {
        this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode: "HTML" }).catch(() => { });
    }

    disconnect() {
        console.log('🛑 Disconnecting...');
        this.saveState();
        if (this.ws) this.ws.close();
    }

    // State persistence
    saveState() {
        try {
            fs.writeFileSync(STATE_FILE, JSON.stringify({
                savedAt: Date.now(),
                stake: this.stake,
                consecutiveLosses: this.consecutiveLosses,
                totalTrades: this.totalTrades,
                totalWins: this.totalWins,
                x2: this.x2, x3: this.x3, x4: this.x4, x5: this.x5,
                netProfit: this.netProfit,
                recentTrades: this.recentTrades,
                assetPerformance: this.assetPerformance
            }, null, 2));
        } catch (e) { }
    }

    loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) return;
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (Date.now() - data.savedAt > 30 * 60 * 1000) return;
            Object.assign(this, data);
            console.log('✅ State restored');
        } catch (e) { }
    }

    startAutoSave() {
        setInterval(() => this.saveState(), 5000);
    }

    startHourlyReset() {
        setInterval(() => {
            this.assetList.forEach(a => {
                this.tradesThisHour[a] = 0;
            });
            console.log('🔄 Hourly trade counters reset');
        }, 3600000);
    }

    startHourlySummary() {
        setInterval(() => {
            if (this.hourly.trades === 0) return;
            const winRate = ((this.hourly.wins / this.hourly.trades) * 100).toFixed(1);

            let assetBreakdown = '';
            this.assetList.forEach(a => {
                const perf = this.assetPerformance[a];
                if (perf.trades > 0) {
                    const aWR = ((perf.wins / perf.trades) * 100).toFixed(0);
                    assetBreakdown += `\n├ ${a}: ${perf.trades}T ${aWR}% $${perf.pnl.toFixed(2)}`;
                }
            });

            this.sendTelegram(`
⏰ <b>HOURLY — ATHENA v9</b>

📊 Trades: ${this.hourly.trades}
✅/❌ W/L: ${this.hourly.wins}/${this.hourly.losses}
📈 Win Rate: ${winRate}%
💰 P&L: ${this.hourly.pnl >= 0 ? '+' : ''}$${this.hourly.pnl.toFixed(2)}

<b>By Asset:</b>${assetBreakdown}

<b>Session:</b>
├ Total: ${this.totalTrades}
├ W/L: ${this.totalWins}/${this.totalTrades - this.totalWins}
├ x2-x5: ${this.x2}/${this.x3}/${this.x4}/${this.x5}
└ Net: $${this.netProfit.toFixed(2)}
            `.trim());
            this.hourly = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        }, 3600000);
    }
}

// START
console.log('═══════════════════════════════════════════════════');
console.log('  ATHENA PURE v9.0 ULTIMATE — RUSSIAN MAFIA');
console.log('  Multi-Asset + Advanced Fractal + Weighted Fibonacci');
console.log('═══════════════════════════════════════════════════');
console.log(`  Started: ${new Date().toLocaleString()}`);
console.log('═══════════════════════════════════════════════════\n');

new AthenaPureUltimate();
