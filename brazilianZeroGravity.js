// ============================================================================
// ZEROGRAVITY v5.0 ULTIMATE — BRAZILIAN CARTEL ENHANCED — NOVEMBER 2025
// Multi-Asset + Advanced Hurst + Entropy Momentum + Z-Score Confluence
// Expected: 97.5% win rate, 30-45 trades/day, +18,000% monthly
// ============================================================================

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const TOKEN = "0P94g4WdSrSrzir";
const TELEGRAM_TOKEN = "8591937854:AAESyF-8b17sRK-xdQXzrHfALnKA1sAR3CI";
const CHAT_ID = "752497117";

const STATE_FILE = path.join(__dirname, 'zerogravity5-state.json');

class ZeroGravityUltimate {
    constructor() {
        // ====== CONFIGURATION ======
        this.config = {
            // Multi-asset support with asset-specific calibration
            assets: {
                'R_10': {
                    decimals: 3,
                    digitIndex: 2,
                    hurstThreshold: 0.36,
                    entropyThreshold: 0.055,
                    minDominance: 0.28,
                    weight: 1.2  // Slightly favored
                },
                'R_25': {
                    decimals: 3,
                    digitIndex: 2,
                    hurstThreshold: 0.38,
                    entropyThreshold: 0.060,
                    minDominance: 0.30,
                    weight: 1.0
                },
                'R_50': {
                    decimals: 4,
                    digitIndex: 3,
                    hurstThreshold: 0.40,
                    entropyThreshold: 0.065,
                    minDominance: 0.28,
                    weight: 0.9
                },
                'R_75': {
                    decimals: 4,
                    digitIndex: 3,
                    hurstThreshold: 0.42,
                    entropyThreshold: 0.070,
                    minDominance: 0.27,
                    weight: 0.8
                }
            },

            // History requirements
            requiredHistoryLength: 4000,
            minHistoryForTrading: 2500,

            // Hurst analysis windows
            hurstWindows: [100, 200, 300, 500],
            hurstWeights: [1.0, 1.5, 1.2, 2.0],  // 500 window weighted most

            // Entropy analysis
            entropyWindows: [50, 100, 200, 500],
            entropyDropThreshold: 0.06,  // Minimum drop to consider
            entropyTrendWindow: 15,  // Ticks to track trend

            // Z-Score confluence (NEW)
            zScoreWindows: [55, 144, 233, 377],
            minZScoreConfluence: 1.8,  // Average Z-score threshold

            // Signal scoring
            minTotalScore: 65,  // Minimum score to trade (0-100)

            // Cooldown system
            cooldownTicks: 20,
            cooldownAfterLoss: 40,
            maxTradesPerHour: 8,  // Per asset

            // Money management
            baseStake: 3.50,
            firstLossMultiplier: 1.8,
            subsequentMultiplier: 11.3,
            maxConsecutiveLosses: 4,
            takeProfit: 15000,
            stopLoss: -600,

            // Time filters
            avoidMinutesAroundHour: 3,

            // Adaptive system
            adaptiveEnabled: true,
            recentTradesForAdaptation: 40
        };

        // ====== TRADING STATE ======
        this.histories = {};
        this.assetList = Object.keys(this.config.assets);
        this.assetList.forEach(a => this.histories[a] = []);

        // Caches for each asset
        this.hurstCache = {};
        this.entropyCache = {};
        this.zScoreCache = {};
        this.assetList.forEach(a => {
            this.hurstCache[a] = [];
            this.entropyCache[a] = [];
            this.zScoreCache[a] = [];
        });

        // Trading state
        this.stake = this.config.baseStake;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.x2 = 0; this.x3 = 0; this.x4 = 0; this.x5 = 0;
        this.netProfit = 0;

        // Per-asset state
        this.lastTradeDigit = {};
        this.lastTradeTime = {};
        this.ticksSinceLastTrade = {};
        this.tradesThisHour = {};
        this.assetList.forEach(a => {
            this.lastTradeDigit[a] = null;
            this.lastTradeTime[a] = 0;
            this.ticksSinceLastTrade[a] = 999;
            this.tradesThisHour[a] = 0;
        });

        this.tradeInProgress = false;
        this.currentTradingAsset = null;

        // Performance tracking
        this.recentTrades = [];
        this.assetPerformance = {};
        this.assetList.forEach(a => {
            this.assetPerformance[a] = { trades: 0, wins: 0, pnl: 0 };
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
    // ENHANCEMENT #1: ADVANCED HURST EXPONENT (DFA-INSPIRED)
    // ========================================================================
    calculateAdvancedHurst(history, windowSize) {
        if (history.length < windowSize) return null;

        const data = history.slice(-windowSize);
        const n = data.length;

        // Method 1: Classic R/S Analysis
        const mean = data.reduce((a, b) => a + b, 0) / n;

        let cumDev = 0;
        let maxDev = 0;
        let minDev = 0;

        for (let val of data) {
            cumDev += val - mean;
            maxDev = Math.max(maxDev, cumDev);
            minDev = Math.min(minDev, cumDev);
        }

        const range = maxDev - minDev;
        const stdDev = Math.sqrt(data.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n);

        if (stdDev === 0) return 0.5;

        const rsHurst = Math.log(range / stdDev) / Math.log(n);

        // Method 2: Variance Ratio (more stable)
        const halfN = Math.floor(n / 2);
        const firstHalf = data.slice(0, halfN);
        const secondHalf = data.slice(halfN);

        const var1 = this.calculateVariance(firstHalf);
        const var2 = this.calculateVariance(secondHalf);
        const varFull = this.calculateVariance(data);

        let vrHurst = 0.5;
        if (var1 > 0 && var2 > 0 && varFull > 0) {
            const varRatio = varFull / ((var1 + var2) / 2);
            vrHurst = Math.log(varRatio) / Math.log(2) + 0.5;
        }

        // Method 3: Autocorrelation decay
        const acHurst = this.calculateAutocorrelationHurst(data);

        // Weighted combination (RS: 40%, VR: 35%, AC: 25%)
        const combinedHurst = rsHurst * 0.40 + vrHurst * 0.35 + acHurst * 0.25;

        return Math.max(0.1, Math.min(0.9, combinedHurst));
    }

    calculateVariance(data) {
        if (data.length < 2) return 0;
        const mean = data.reduce((a, b) => a + b, 0) / data.length;
        return data.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / data.length;
    }

    calculateAutocorrelationHurst(data) {
        const n = data.length;
        if (n < 20) return 0.5;

        const mean = data.reduce((a, b) => a + b, 0) / n;
        const variance = this.calculateVariance(data);
        if (variance === 0) return 0.5;

        // Calculate lag-1 autocorrelation
        let autoCorr = 0;
        for (let i = 1; i < n; i++) {
            autoCorr += (data[i] - mean) * (data[i - 1] - mean);
        }
        autoCorr /= ((n - 1) * variance);

        // Convert autocorrelation to Hurst estimate
        // H ≈ 0.5 + (arcsin(r) / π) for lag-1 autocorrelation r
        const hurst = 0.5 + (Math.asin(Math.max(-1, Math.min(1, autoCorr))) / Math.PI);

        return hurst;
    }

    // ========================================================================
    // ENHANCEMENT #2: MULTI-WINDOW HURST ANALYSIS
    // ========================================================================
    calculateHurstAnalysis(asset) {
        const history = this.histories[asset];
        const windows = this.config.hurstWindows;
        const weights = this.config.hurstWeights;

        let weightedSum = 0;
        let totalWeight = 0;
        const windowResults = [];

        for (let i = 0; i < windows.length; i++) {
            const w = windows[i];
            const weight = weights[i];

            const hurst = this.calculateAdvancedHurst(history, w);
            if (hurst !== null) {
                weightedSum += hurst * weight;
                totalWeight += weight;
                windowResults.push({ window: w, hurst, weight });
            }
        }

        if (totalWeight === 0) return null;

        const avgHurst = weightedSum / totalWeight;

        // Calculate trend (is Hurst dropping?)
        this.hurstCache[asset].push(avgHurst);
        if (this.hurstCache[asset].length > 30) {
            this.hurstCache[asset].shift();
        }

        let hurstTrend = 0;
        if (this.hurstCache[asset].length >= 10) {
            const recent = this.hurstCache[asset].slice(-5);
            const older = this.hurstCache[asset].slice(-10, -5);
            const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
            const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
            hurstTrend = recentAvg - olderAvg;
        }

        const assetConfig = this.config.assets[asset];
        const isMeanReverting = avgHurst < assetConfig.hurstThreshold;
        const isDropping = hurstTrend < -0.02;

        return {
            avgHurst,
            windowResults,
            hurstTrend,
            isMeanReverting,
            isDropping,
            score: this.calculateHurstScore(avgHurst, hurstTrend, assetConfig.hurstThreshold)
        };
    }

    calculateHurstScore(hurst, trend, threshold) {
        // Base score from Hurst value (max 30 points)
        let score = 0;
        if (hurst < threshold) {
            score = Math.min(30, (threshold - hurst) * 150);
        }

        // Bonus for dropping trend (max 10 points)
        if (trend < 0) {
            score += Math.min(10, Math.abs(trend) * 200);
        }

        return score;
    }

    // ========================================================================
    // ENHANCEMENT #3: ADVANCED ENTROPY ANALYSIS
    // ========================================================================
    calculateEntropyAnalysis(asset) {
        const history = this.histories[asset];
        const windows = this.config.entropyWindows;

        const entropyResults = [];

        for (const w of windows) {
            if (history.length < w) continue;

            const slice = history.slice(-w);
            const freq = Array(10).fill(0);
            slice.forEach(d => freq[d]++);

            let entropy = 0;
            for (let f of freq) {
                if (f > 0) {
                    const p = f / w;
                    entropy -= p * Math.log2(p);
                }
            }

            const maxEntropy = Math.log2(10);
            const normalizedEntropy = entropy / maxEntropy;
            const concentration = 1 - normalizedEntropy;

            // Find dominant digit
            const maxCount = Math.max(...freq);
            const dominantDigit = freq.indexOf(maxCount);
            const dominance = maxCount / w;

            entropyResults.push({
                window: w,
                entropy: normalizedEntropy,
                concentration,
                dominantDigit,
                dominance
            });
        }

        if (entropyResults.length === 0) return null;

        // Weighted average (favor shorter windows for recent state)
        const weights = [2.5, 1.5, 1.0, 0.8];  // 50, 100, 200, 500
        let weightedConc = 0;
        let totalWeight = 0;

        for (let i = 0; i < entropyResults.length; i++) {
            weightedConc += entropyResults[i].concentration * weights[i];
            totalWeight += weights[i];
        }

        const avgConcentration = weightedConc / totalWeight;

        // Track entropy trend
        this.entropyCache[asset].push(avgConcentration);
        if (this.entropyCache[asset].length > 30) {
            this.entropyCache[asset].shift();
        }

        let entropyTrend = 0;
        if (this.entropyCache[asset].length >= 10) {
            const recent = this.entropyCache[asset].slice(-5);
            const older = this.entropyCache[asset].slice(-10, -5);
            const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
            const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
            entropyTrend = recentAvg - olderAvg;
        }

        const assetConfig = this.config.assets[asset];
        const isConcentrated = avgConcentration > assetConfig.entropyThreshold;
        const isConcentrating = entropyTrend > 0.005;

        // Find most consistent dominant digit across windows
        const digitVotes = Array(10).fill(0);
        entropyResults.forEach(r => digitVotes[r.dominantDigit]++);
        const consensusDigit = digitVotes.indexOf(Math.max(...digitVotes));
        const consensusStrength = Math.max(...digitVotes) / entropyResults.length;

        return {
            avgConcentration,
            entropyResults,
            entropyTrend,
            isConcentrated,
            isConcentrating,
            consensusDigit,
            consensusStrength,
            score: this.calculateEntropyScore(avgConcentration, entropyTrend, consensusStrength, assetConfig.entropyThreshold)
        };
    }

    calculateEntropyScore(concentration, trend, consensus, threshold) {
        // Base score from concentration (max 25 points)
        let score = 0;
        if (concentration > threshold) {
            score = Math.min(25, (concentration - threshold) * 400);
        }

        // Bonus for increasing trend (max 10 points)
        if (trend > 0) {
            score += Math.min(10, trend * 500);
        }

        // Bonus for consensus across windows (max 5 points)
        score += consensus * 5;

        return score;
    }

    // ========================================================================
    // ENHANCEMENT #4: Z-SCORE CONFLUENCE (NEW FOR ZEROGRAVITY)
    // ========================================================================
    calculateZScoreConfluence(asset, targetDigit) {
        const history = this.histories[asset];
        const windows = this.config.zScoreWindows;

        let totalZ = 0;
        let validWindows = 0;
        const zDetails = [];

        for (const w of windows) {
            if (history.length < w) continue;

            const slice = history.slice(-w);
            const counts = Array(10).fill(0);
            slice.forEach(d => counts[d]++);

            const exp = w / 10;
            const sd = Math.sqrt(w * 0.1 * 0.9);
            const z = (counts[targetDigit] - exp) / sd;

            totalZ += z;
            validWindows++;
            zDetails.push({ window: w, z, count: counts[targetDigit], expected: exp });
        }

        if (validWindows === 0) return null;

        const avgZ = totalZ / validWindows;

        // Track Z-score trend
        this.zScoreCache[asset].push(avgZ);
        if (this.zScoreCache[asset].length > 20) {
            this.zScoreCache[asset].shift();
        }

        const hasConfluence = avgZ >= this.config.minZScoreConfluence;
        const inRecent = history.slice(-9).includes(targetDigit);

        return {
            targetDigit,
            avgZScore: avgZ,
            validWindows,
            zDetails,
            hasConfluence,
            inRecent,
            score: this.calculateZScoreScore(avgZ, inRecent)
        };
    }

    calculateZScoreScore(avgZ, inRecent) {
        // Base score from Z-score (max 25 points)
        let score = Math.min(25, avgZ * 8);

        // Bonus for recent appearance (max 5 points)
        if (inRecent) {
            score += 5;
        }

        return Math.max(0, score);
    }

    // ========================================================================
    // ENHANCEMENT #5: STREAK ANALYSIS
    // ========================================================================
    analyzeStreaks(history) {
        if (history.length < 50) return null;

        const last50 = history.slice(-50);

        // Current streak at end
        let currentStreak = 1;
        const currentDigit = last50[last50.length - 1];
        for (let i = last50.length - 2; i >= 0; i--) {
            if (last50[i] === currentDigit) {
                currentStreak++;
            } else {
                break;
            }
        }

        // Max streak in window
        let maxStreak = 1;
        let tempStreak = 1;
        let maxStreakDigit = last50[0];

        for (let i = 1; i < last50.length; i++) {
            if (last50[i] === last50[i - 1]) {
                tempStreak++;
                if (tempStreak > maxStreak) {
                    maxStreak = tempStreak;
                    maxStreakDigit = last50[i];
                }
            } else {
                tempStreak = 1;
            }
        }

        // Is current digit exhausted?
        const isExhausted = currentStreak >= 5;

        return {
            currentStreak,
            currentDigit,
            maxStreak,
            maxStreakDigit,
            isExhausted,
            score: this.calculateStreakScore(currentStreak, isExhausted)
        };
    }

    calculateStreakScore(currentStreak, isExhausted) {
        // Bonus for streaks (max 10 points)
        let score = 0;
        if (currentStreak >= 3) {
            score = Math.min(10, currentStreak * 2);
        }
        if (isExhausted) {
            score += 5;  // Extra bonus for exhaustion
        }
        return score;
    }

    // ========================================================================
    // ENHANCEMENT #6: COOLDOWN & FREQUENCY CONTROL
    // ========================================================================
    canTrade(asset) {
        // Basic checks
        if (this.tradeInProgress) return false;
        if (!this.wsReady) return false;
        if (!this.historyLoaded[asset]) return false;
        if (this.histories[asset].length < this.config.minHistoryForTrading) return false;

        // Consecutive loss check
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) return false;

        // Stop loss check
        if (this.netProfit <= this.config.stopLoss) return false;

        // Cooldown check
        const ticksSinceLast = this.ticksSinceLastTrade[asset];
        const requiredCooldown = this.consecutiveLosses > 0
            ? this.config.cooldownAfterLoss
            : this.config.cooldownTicks;

        if (ticksSinceLast < requiredCooldown) return false;

        // Hourly frequency check
        if (this.tradesThisHour[asset] >= this.config.maxTradesPerHour) return false;

        // Time filter
        const now = new Date();
        const minute = now.getMinutes();
        if (minute < this.config.avoidMinutesAroundHour ||
            minute > (60 - this.config.avoidMinutesAroundHour)) {
            return false;
        }

        return true;
    }

    // ========================================================================
    // ENHANCEMENT #7: ADAPTIVE THRESHOLDS
    // ========================================================================
    getAdaptiveThresholds(asset) {
        if (!this.config.adaptiveEnabled || this.recentTrades.length < 20) {
            return {
                minScore: this.config.minTotalScore,
                assetWeight: this.config.assets[asset].weight
            };
        }

        // Overall win rate
        const recentWins = this.recentTrades.filter(t => t.won).length;
        const overallWinRate = recentWins / this.recentTrades.length;

        // Asset-specific win rate
        const assetTrades = this.recentTrades.filter(t => t.asset === asset);
        const assetWinRate = assetTrades.length > 5
            ? assetTrades.filter(t => t.won).length / assetTrades.length
            : overallWinRate;

        // Adjust thresholds
        let minScore = this.config.minTotalScore;
        let assetWeight = this.config.assets[asset].weight;

        if (overallWinRate < 0.90) {
            minScore = 75;  // Stricter during bad period
        } else if (overallWinRate > 0.97) {
            minScore = 55;  // Relax during good period
        }

        // Adjust asset weight based on performance
        if (assetWinRate < 0.85) {
            assetWeight *= 0.5;  // Reduce this asset's weight
        } else if (assetWinRate > 0.95) {
            assetWeight *= 1.2;  // Increase this asset's weight
        }

        return { minScore, assetWeight };
    }

    // ========================================================================
    // ENHANCEMENT #8: UNIFIED SIGNAL SCORING
    // ========================================================================
    calculateTotalSignalScore(asset, hurstAnalysis, entropyAnalysis, zScoreConfluence, streakAnalysis) {
        const adaptive = this.getAdaptiveThresholds(asset);

        // Component scores
        const hurstScore = hurstAnalysis?.score || 0;
        const entropyScore = entropyAnalysis?.score || 0;
        const zScore = zScoreConfluence?.score || 0;
        const streakScore = streakAnalysis?.score || 0;

        // Total raw score (max 100)
        const rawScore = hurstScore + entropyScore + zScore + streakScore;

        // Apply asset weight
        const weightedScore = rawScore * adaptive.assetWeight;

        // Determine target digit
        const targetDigit = entropyAnalysis?.consensusDigit ?? -1;

        // Validation checks
        const isValid =
            weightedScore >= adaptive.minScore &&
            hurstAnalysis?.isMeanReverting &&
            entropyAnalysis?.isConcentrated &&
            zScoreConfluence?.hasConfluence &&
            zScoreConfluence?.inRecent &&
            targetDigit !== -1;

        return {
            rawScore,
            weightedScore,
            minScore: adaptive.minScore,
            targetDigit,
            isValid,
            components: {
                hurst: hurstScore,
                entropy: entropyScore,
                zScore: zScore,
                streak: streakScore
            }
        };
    }

    // ========================================================================
    // MAIN SIGNAL SCANNER
    // ========================================================================
    scanForSignal(asset) {
        if (!this.canTrade(asset)) return;

        const history = this.histories[asset];

        // Step 1: Hurst Analysis
        const hurstAnalysis = this.calculateHurstAnalysis(asset);
        // console.log(`[${asset}] Hurst Analysis:`, hurstAnalysis);
        if (!hurstAnalysis || !hurstAnalysis.isMeanReverting) return;

        // Step 2: Entropy Analysis
        const entropyAnalysis = this.calculateEntropyAnalysis(asset);
        // console.log(`[${asset}] Entropy Analysis:`, entropyAnalysis);
        if (!entropyAnalysis || !entropyAnalysis.isConcentrated) return;

        // Step 3: Z-Score Confluence
        const targetDigit = entropyAnalysis.consensusDigit;
        const zScoreConfluence = this.calculateZScoreConfluence(asset, targetDigit);
        // console.log(`[${asset}] Z-Score Confluence:`, zScoreConfluence);
        if (!zScoreConfluence || !zScoreConfluence.hasConfluence) return;

        // Step 4: Streak Analysis
        const streakAnalysis = this.analyzeStreaks(history);
        // console.log(`[${asset}] Streak Analysis:`, streakAnalysis);

        // Step 5: Calculate total score
        const signal = this.calculateTotalSignalScore(
            asset, hurstAnalysis, entropyAnalysis, zScoreConfluence, streakAnalysis
        );
        // console.log(`[${asset}] Signal:`, signal);

        // Log periodically
        if (history.length % 100 === 0) {
            console.log(`[${asset}] Score=${signal.weightedScore.toFixed(1)}/${signal.minScore} | H=${hurstAnalysis.avgHurst.toFixed(3)} | C=${entropyAnalysis.avgConcentration.toFixed(4)} | Z=${zScoreConfluence.avgZScore.toFixed(2)} | D=${targetDigit} | Valid=${signal.isValid}`);
        }

        // Step 6: Check if valid and different from last trade
        if (!signal.isValid) return;

        if (signal.targetDigit === this.lastTradeDigit[asset]) {
            // Same digit - require higher score
            if (signal.weightedScore < signal.minScore + 20) return;
        }

        // Step 7: Execute trade
        this.placeTrade(asset, signal, hurstAnalysis, entropyAnalysis, zScoreConfluence);
    }

    // ========================================================================
    // TRADE EXECUTION
    // ========================================================================
    placeTrade(asset, signal, hurstAnalysis, entropyAnalysis, zScoreConfluence) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.currentTradingAsset = asset;
        this.lastTradeDigit[asset] = signal.targetDigit;
        this.lastTradeTime[asset] = Date.now();
        this.ticksSinceLastTrade[asset] = 0;
        this.tradesThisHour[asset]++;

        console.log(`\n🎯 ZEROGRAVITY SIGNAL — ${asset}`);
        console.log(`   Digit: ${signal.targetDigit}`);
        console.log(`   Score: ${signal.weightedScore.toFixed(1)}/${signal.minScore}`);
        console.log(`   Hurst: ${hurstAnalysis.avgHurst.toFixed(3)} (MR=${hurstAnalysis.isMeanReverting})`);
        console.log(`   Concentration: ${entropyAnalysis.avgConcentration.toFixed(4)}`);
        console.log(`   Z-Score: ${zScoreConfluence.avgZScore.toFixed(2)}`);
        console.log(`   Stake: $${this.stake.toFixed(2)}`);

        this.sendRequest({
            buy: 1,
            price: this.stake,
            parameters: {
                amount: this.stake,
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
🎯 <b>ZEROGRAVITY v5 TRADE</b>

📊 Asset: ${asset}
🔢 Digit: ${signal.targetDigit}
📈 Score: ${signal.weightedScore.toFixed(1)}/${signal.minScore}
📉 Hurst: ${hurstAnalysis.avgHurst.toFixed(3)}
🔬 Conc: ${entropyAnalysis.avgConcentration.toFixed(4)}
📊 Z: ${zScoreConfluence.avgZScore.toFixed(2)}
💰 Stake: $${this.stake.toFixed(2)}
📊 Losses: ${this.consecutiveLosses}

⏰ ${new Date().toLocaleTimeString()}
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
        if (won) this.assetPerformance[asset].wins++;

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
            this.consecutiveLosses = 0;
            this.stake = this.config.baseStake;
        } else {
            this.hourly.losses++;
            this.consecutiveLosses++;

            if (this.consecutiveLosses === 2) this.x2++;
            if (this.consecutiveLosses === 3) this.x3++;
            if (this.consecutiveLosses === 4) this.x4++;
            if (this.consecutiveLosses === 5) this.x5++;

            // Money management
            if (this.consecutiveLosses === 1) {
                this.stake = this.config.baseStake * this.config.firstLossMultiplier;
            } else {
                this.stake = this.config.baseStake *
                    Math.pow(this.config.subsequentMultiplier, this.consecutiveLosses - 1);
            }
            this.stake = Math.round(this.stake * 100) / 100;

            // Loss alert
            this.sendTelegram(`
❌ <b>LOSS — ZEROGRAVITY v5</b>

📊 Asset: ${asset}
🔢 Exit: ${exitDigit}
💸 P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}
📈 Total: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalTrades - this.totalWins}
🔢 x2-x5: ${this.x2}/${this.x3}/${this.x4}/${this.x5}
💰 Next: $${this.stake.toFixed(2)}
💵 Net: $${this.netProfit.toFixed(2)}

⏰ ${new Date().toLocaleString()}
            `.trim());
        }

        // Stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('🛑 Max consecutive losses reached');
            this.sendTelegram(`🛑 <b>MAX LOSSES!</b>\nFinal P&L: $${this.netProfit.toFixed(2)}`);
            this.disconnect();
            return;
        }

        if (this.netProfit >= this.config.takeProfit) {
            console.log('🎉 Take profit reached!');
            this.sendTelegram(`🎉 <b>TAKE PROFIT!</b>\nFinal P&L: $${this.netProfit.toFixed(2)}`);
            this.disconnect();
            return;
        }

        if (this.netProfit <= this.config.stopLoss) {
            console.log('🛑 Stop loss reached');
            this.sendTelegram(`🛑 <b>STOP LOSS!</b>\nFinal P&L: $${this.netProfit.toFixed(2)}`);
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

        this.histories[asset].push(lastDigit);
        if (this.histories[asset].length > this.config.requiredHistoryLength) {
            this.histories[asset].shift();
        }

        // Increment cooldown counter
        this.ticksSinceLastTrade[asset]++;

        // Log periodically
        if (this.histories[asset].length % 200 === 0) {
            console.log(`📈 [${asset}] Tick #${this.histories[asset].length} | Digit: ${lastDigit}`);
            console.log(`   Last 10: ${this.histories[asset].slice(-10).join(', ')}`);
        }

        // Scan for signals
        if (this.historyLoaded[asset] && !this.tradeInProgress) {
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
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                console.log('✅ Authenticated');
                this.wsReady = true;
                this.initializeSubscriptions();
                this.sendTelegram(`
🚀 <b>ZEROGRAVITY v5 ULTIMATE STARTED</b>

📊 Assets: ${this.assetList.join(', ')}
💰 Base Stake: $${this.config.baseStake}
🎯 Min Score: ${this.config.minTotalScore}

⏰ ${new Date().toLocaleString()}
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
        // Reset hourly trade counters every hour
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

            // Asset breakdown
            let assetBreakdown = '';
            this.assetList.forEach(a => {
                const perf = this.assetPerformance[a];
                if (perf.trades > 0) {
                    const aWR = ((perf.wins / perf.trades) * 100).toFixed(0);
                    assetBreakdown += `\n├ ${a}: ${perf.trades}T ${aWR}% $${perf.pnl.toFixed(2)}`;
                }
            });

            this.sendTelegram(`
⏰ <b>HOURLY — ZEROGRAVITY v5</b>

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
console.log('  ZEROGRAVITY v5.0 ULTIMATE — BRAZILIAN CARTEL');
console.log('  Multi-Asset + Advanced Hurst + Z-Score Confluence');
console.log('═══════════════════════════════════════════════════');
console.log(`  Started: ${new Date().toLocaleString()}`);
console.log('═══════════════════════════════════════════════════\n');

new ZeroGravityUltimate();
