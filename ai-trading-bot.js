/**
 * ============================================================
 * AI-POWERED DERIV DIGIT DIFFER TRADING BOT v4.0
 * Complete Kelly Criterion & AI Risk Management System
 * ============================================================
 * 
 * FEATURES:
 * - Full Kelly Criterion position sizing
 * - AI-controlled stake management
 * - Intelligent recovery strategy (no Martingale)
 * - Dynamic drawdown protection
 * - Regime-adaptive risk management
 * - Investment capital tracking ($500 default)
 * 
 * ============================================================
 */

require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

// ==================== KELLY CRITERION MANAGER ====================

class KellyCriterionManager {
    constructor(config = {}) {
        // Investment capital configuration
        this.investmentCapital = config.investmentCapital || 500;
        this.currentCapital = this.investmentCapital;
        this.peakCapital = this.investmentCapital;

        // Kelly Criterion parameters
        this.kellyFraction = config.kellyFraction || 0.25; // Quarter Kelly (conservative)
        this.minKellyFraction = 0.1;  // Minimum 10% of full Kelly
        this.maxKellyFraction = 0.5;  // Maximum 50% of full Kelly

        // Stake limits
        this.minStake = config.minStake || 0.35;
        this.maxStakePercent = config.maxStakePercent || 5; // Max 5% per trade
        this.absoluteMaxStake = config.absoluteMaxStake || 50;

        // Risk management thresholds
        this.maxDrawdownPercent = config.maxDrawdownPercent || 25;
        this.warningDrawdownPercent = config.warningDrawdownPercent || 15;
        this.dailyLossLimit = config.dailyLossLimit || 50; // $50 daily loss limit
        this.dailyProfitTarget = config.dailyProfitTarget || 100; // $100 daily target

        // Recovery parameters
        this.recoveryMode = false;
        this.recoveryStartCapital = 0;
        this.maxRecoveryMultiplier = 2.0;

        // Performance tracking
        this.tradeHistory = [];
        this.dailyPnL = 0;
        this.sessionPnL = 0;
        this.currentDrawdown = 0;
        this.maxDrawdownReached = 0;

        // Confidence-based adjustments
        this.confidenceThresholds = {
            veryHigh: 90,   // Full Kelly fraction
            high: 80,       // 80% of Kelly fraction
            medium: 70,     // 50% of Kelly fraction
            low: 60         // 25% of Kelly fraction
        };

        // Win rate tracking (rolling window)
        this.recentWins = 0;
        this.recentLosses = 0;
        this.rollingWindowSize = 50;
        this.rollingResults = [];

        console.log('\n💰 Kelly Criterion Manager Initialized');
        console.log(`   Investment Capital: $${this.investmentCapital}`);
        console.log(`   Kelly Fraction: ${this.kellyFraction * 100}%`);
        console.log(`   Max Drawdown Limit: ${this.maxDrawdownPercent}%`);
        console.log(`   Max Stake: ${this.maxStakePercent}% of capital`);
    }

    /**
     * Core Kelly Criterion Formula
     * f* = (bp - q) / b
     * where: b = decimal odds - 1, p = win probability, q = 1 - p
     */
    calculateFullKelly(winProbability, decimalOdds) {
        const p = Math.max(0.01, Math.min(0.99, winProbability));
        const q = 1 - p;
        const b = decimalOdds - 1; // Net odds

        if (b <= 0) return 0;

        const kelly = (b * p - q) / b;
        return Math.max(0, kelly);
    }

    /**
     * Calculate optimal stake using Enhanced Kelly Criterion
     * Considers: confidence, market regime, drawdown, consecutive losses
     */
    calculateOptimalStake(params) {
        const {
            winProbability = 0.5,
            payout = 1.85,          // Typical digit differ payout
            confidence = 70,
            marketRegime = 'stable',
            consecutiveLosses = 0,
            consecutiveWins = 0,
            volatility = 'medium'
        } = params;

        // Step 1: Calculate base Kelly fraction
        const fullKelly = this.calculateFullKelly(winProbability, payout);

        // Step 2: Apply fractional Kelly for safety
        let adjustedKelly = fullKelly * this.kellyFraction;

        // Step 3: Confidence-based adjustment
        const confidenceMultiplier = this.getConfidenceMultiplier(confidence);
        adjustedKelly *= confidenceMultiplier;

        // Step 4: Market regime adjustment
        const regimeMultiplier = this.getRegimeMultiplier(marketRegime);
        adjustedKelly *= regimeMultiplier;

        // Step 5: Volatility adjustment
        const volatilityMultiplier = this.getVolatilityMultiplier(volatility);
        adjustedKelly *= volatilityMultiplier;

        // Step 6: Consecutive losses adjustment (reduce stake after losses)
        const lossAdjustment = this.getLossAdjustment(consecutiveLosses);
        adjustedKelly *= lossAdjustment;

        // Step 7: Consecutive wins bonus (slight increase after wins)
        const winBonus = this.getWinBonus(consecutiveWins);
        adjustedKelly *= winBonus;

        // Step 8: Drawdown protection
        const drawdownMultiplier = this.getDrawdownMultiplier();
        adjustedKelly *= drawdownMultiplier;

        // Step 9: Calculate final stake
        let stake = this.currentCapital * adjustedKelly;

        // Apply hard limits
        stake = Math.max(this.minStake, stake);
        stake = Math.min(stake, this.currentCapital * (this.maxStakePercent / 100));
        stake = Math.min(stake, this.absoluteMaxStake);
        stake = Math.min(stake, this.currentCapital * 0.1); // Never more than 10% of capital

        // Round to 2 decimal places
        stake = Math.round(stake * 100) / 100;

        // Log calculation details
        this.logStakeCalculation({
            fullKelly,
            adjustedKelly,
            confidenceMultiplier,
            regimeMultiplier,
            volatilityMultiplier,
            lossAdjustment,
            winBonus,
            drawdownMultiplier,
            finalStake: stake
        });

        return {
            stake,
            kellyFraction: adjustedKelly,
            riskLevel: this.assessRiskLevel(stake),
            recommendation: this.getStakeRecommendation(stake, confidence)
        };
    }

    /**
     * AI-Driven Recovery Strategy
     * Replaces dangerous Martingale with intelligent recovery
     */
    calculateRecoveryStake(params) {
        const {
            baseStake,
            consecutiveLosses,
            lossAmount,
            winRate,
            confidence
        } = params;

        // Enter recovery mode after 2 consecutive losses
        if (consecutiveLosses >= 2 && !this.recoveryMode) {
            this.recoveryMode = true;
            this.recoveryStartCapital = this.currentCapital;
            console.log('🔄 Entering Recovery Mode');
        }

        // Exit recovery mode if we've recovered losses
        if (this.recoveryMode && this.currentCapital >= this.recoveryStartCapital) {
            this.recoveryMode = false;
            console.log('✅ Exited Recovery Mode - Losses Recovered');
            return baseStake;
        }

        if (!this.recoveryMode) {
            return baseStake;
        }

        // Recovery Strategy: Gradual increase based on win rate and confidence
        let recoveryMultiplier = 1.0;

        // Higher win rate = can be more aggressive in recovery
        if (winRate >= 0.55) {
            recoveryMultiplier = 1.3;
        } else if (winRate >= 0.50) {
            recoveryMultiplier = 1.2;
        } else if (winRate >= 0.45) {
            recoveryMultiplier = 1.1;
        } else {
            // Poor win rate = be conservative
            recoveryMultiplier = 0.8;
        }

        // Confidence adjustment
        if (confidence >= 85) {
            recoveryMultiplier *= 1.2;
        } else if (confidence >= 75) {
            recoveryMultiplier *= 1.1;
        } else if (confidence < 65) {
            recoveryMultiplier *= 0.7;
        }

        // Cap recovery multiplier
        recoveryMultiplier = Math.min(recoveryMultiplier, this.maxRecoveryMultiplier);

        // Calculate recovery stake
        let recoveryStake = baseStake * recoveryMultiplier;

        // Apply maximum limits
        recoveryStake = Math.min(recoveryStake, this.currentCapital * 0.05);
        recoveryStake = Math.min(recoveryStake, this.absoluteMaxStake);

        return Math.round(recoveryStake * 100) / 100;
    }

    /**
     * Confidence Multiplier
     * Higher confidence = can use more of Kelly fraction
     */
    getConfidenceMultiplier(confidence) {
        if (confidence >= this.confidenceThresholds.veryHigh) {
            return 1.0; // Full Kelly fraction
        } else if (confidence >= this.confidenceThresholds.high) {
            return 0.8;
        } else if (confidence >= this.confidenceThresholds.medium) {
            return 0.5;
        } else if (confidence >= this.confidenceThresholds.low) {
            return 0.25;
        } else {
            return 0.1; // Very low confidence = minimal stake
        }
    }

    /**
     * Market Regime Multiplier
     * Adjust stake based on market conditions
     */
    getRegimeMultiplier(regime) {
        const multipliers = {
            'stable': 1.0,
            'trending': 0.8,
            'ranging': 0.9,
            'volatile': 0.5,
            'random': 0.4,
            'unknown': 0.6
        };
        return multipliers[regime] || 0.6;
    }

    /**
     * Volatility Multiplier
     * Higher volatility = lower stake
     */
    getVolatilityMultiplier(volatility) {
        const multipliers = {
            'low': 1.2,
            'medium': 1.0,
            'high': 0.6,
            'extreme': 0.3
        };
        return multipliers[volatility] || 1.0;
    }

    /**
     * Consecutive Loss Adjustment
     * Reduce stake after consecutive losses
     */
    getLossAdjustment(consecutiveLosses) {
        if (consecutiveLosses === 0) return 1.0;
        if (consecutiveLosses === 1) return 0.9;
        if (consecutiveLosses === 2) return 0.7;
        if (consecutiveLosses === 3) return 0.5;
        if (consecutiveLosses === 4) return 0.3;
        return 0.2; // 5+ consecutive losses = very small stake
    }

    /**
     * Consecutive Win Bonus
     * Slight increase after wins (Anti-Martingale concept)
     */
    getWinBonus(consecutiveWins) {
        if (consecutiveWins === 0) return 1.0;
        if (consecutiveWins === 1) return 1.1;
        if (consecutiveWins === 2) return 1.2;
        if (consecutiveWins === 3) return 1.3;
        return 1.4; // Cap at 40% bonus
    }

    /**
     * Drawdown Protection Multiplier
     * Reduce stake as drawdown increases
     */
    getDrawdownMultiplier() {
        const drawdownPercent = this.calculateCurrentDrawdown();

        if (drawdownPercent < 5) return 1.0;
        if (drawdownPercent < 10) return 0.8;
        if (drawdownPercent < 15) return 0.6;
        if (drawdownPercent < 20) return 0.4;
        if (drawdownPercent < 25) return 0.2;
        return 0.1; // Critical drawdown
    }

    /**
     * Calculate Current Drawdown
     */
    calculateCurrentDrawdown() {
        if (this.peakCapital <= 0) return 0;
        const drawdown = ((this.peakCapital - this.currentCapital) / this.peakCapital) * 100;
        this.currentDrawdown = Math.max(0, drawdown);
        this.maxDrawdownReached = Math.max(this.maxDrawdownReached, this.currentDrawdown);
        return this.currentDrawdown;
    }

    /**
     * Check if trading should continue
     */
    shouldContinueTrading() {
        const drawdown = this.calculateCurrentDrawdown();
        const reasons = [];

        // Check drawdown limit
        if (drawdown >= this.maxDrawdownPercent) {
            reasons.push(`Max drawdown ${drawdown.toFixed(1)}% reached (limit: ${this.maxDrawdownPercent}%)`);
        }

        // Check daily loss limit
        if (this.dailyPnL <= -this.dailyLossLimit) {
            reasons.push(`Daily loss limit $${this.dailyLossLimit} reached`);
        }

        // Check minimum capital
        if (this.currentCapital < this.investmentCapital * 0.5) {
            reasons.push(`Capital below 50% of initial investment`);
        }

        // Check if daily profit target reached (optional stop)
        const reachedDailyTarget = this.dailyPnL >= this.dailyProfitTarget;

        return {
            canTrade: reasons.length === 0,
            reasons,
            warning: drawdown >= this.warningDrawdownPercent,
            reachedDailyTarget,
            currentDrawdown: drawdown,
            dailyPnL: this.dailyPnL
        };
    }

    /**
     * Update capital after trade
     */
    updateAfterTrade(profit, isWin) {
        this.currentCapital += profit;
        this.dailyPnL += profit;
        this.sessionPnL += profit;

        // Update peak capital
        if (this.currentCapital > this.peakCapital) {
            this.peakCapital = this.currentCapital;
        }

        // Update rolling window
        this.rollingResults.push(isWin ? 1 : 0);
        if (this.rollingResults.length > this.rollingWindowSize) {
            this.rollingResults.shift();
        }

        // Recalculate rolling win rate
        if (this.rollingResults.length > 0) {
            this.recentWins = this.rollingResults.filter(r => r === 1).length;
            this.recentLosses = this.rollingResults.filter(r => r === 0).length;
        }

        // Track trade
        this.tradeHistory.push({
            timestamp: Date.now(),
            profit,
            isWin,
            capital: this.currentCapital,
            drawdown: this.calculateCurrentDrawdown()
        });
    }

    /**
     * Get current win rate from rolling window
     */
    getRollingWinRate() {
        if (this.rollingResults.length < 5) {
            return 0.5; // Default to 50% if not enough data
        }
        return this.recentWins / this.rollingResults.length;
    }

    /**
     * Get suggested payout based on asset
     */
    getPayoutForAsset(asset) {
        // Typical payouts for Digit Differ (adjust based on actual values)
        const payouts = {
            'R_10': 1.85,
            'R_25': 1.85,
            'R_50': 1.85,
            'R_75': 1.85,
            'R_100': 1.85,
            'RDBULL': 1.80,
            'RDBEAR': 1.80
        };
        return payouts[asset] || 1.85;
    }

    /**
     * Assess risk level of stake
     */
    assessRiskLevel(stake) {
        const percentOfCapital = (stake / this.currentCapital) * 100;

        if (percentOfCapital <= 1) return 'very_low';
        if (percentOfCapital <= 2) return 'low';
        if (percentOfCapital <= 3) return 'medium';
        if (percentOfCapital <= 5) return 'high';
        return 'very_high';
    }

    /**
     * Get stake recommendation
     */
    getStakeRecommendation(stake, confidence) {
        if (confidence < 60) {
            return 'SKIP - Confidence too low';
        }
        if (stake < this.minStake) {
            return 'SKIP - Stake below minimum';
        }
        if (this.calculateCurrentDrawdown() > 20) {
            return 'CAUTION - High drawdown';
        }
        return 'TRADE';
    }

    /**
     * Log stake calculation details
     */
    logStakeCalculation(details) {
        console.log('\n📊 Kelly Stake Calculation:');
        console.log(`   Full Kelly: ${(details.fullKelly * 100).toFixed(2)}%`);
        console.log(`   Adjusted Kelly: ${(details.adjustedKelly * 100).toFixed(4)}%`);
        console.log(`   Multipliers: Conf=${details.confidenceMultiplier.toFixed(2)}, ` +
            `Regime=${details.regimeMultiplier.toFixed(2)}, ` +
            `Vol=${details.volatilityMultiplier.toFixed(2)}`);
        console.log(`   Loss Adj: ${details.lossAdjustment.toFixed(2)}, Win Bonus: ${details.winBonus.toFixed(2)}`);
        console.log(`   Drawdown Mult: ${details.drawdownMultiplier.toFixed(2)}`);
        console.log(`   Final Stake: $${details.finalStake.toFixed(2)}`);
    }

    /**
     * Get current status summary
     */
    getStatus() {
        return {
            investmentCapital: this.investmentCapital,
            currentCapital: this.currentCapital,
            peakCapital: this.peakCapital,
            currentDrawdown: this.calculateCurrentDrawdown(),
            maxDrawdownReached: this.maxDrawdownReached,
            dailyPnL: this.dailyPnL,
            sessionPnL: this.sessionPnL,
            rollingWinRate: this.getRollingWinRate(),
            recoveryMode: this.recoveryMode,
            tradesCount: this.tradeHistory.length
        };
    }

    /**
     * Reset daily stats (call at start of new trading day)
     */
    resetDailyStats() {
        this.dailyPnL = 0;
        console.log('📅 Daily stats reset');
    }
}

// ==================== ENHANCED AI PROMPT ====================

class EnhancedAIPrompt {

    static generatePrompt(marketData, modelPerformance, kellyStatus) {
        const {
            currentAsset,
            tickHistory,
            lastPrediction,
            lastOutcome,
            consecutiveLosses,
            recentMethods,
            volatility,
            marketRegime,
            comprehensiveAnalysis
        } = marketData;

        const recentDigits = tickHistory.slice(-100);
        const last50 = tickHistory.slice(-50);
        const last20 = tickHistory.slice(-20);
        const last500 = tickHistory.slice(-500);

        let freqStats, gapAnalysis, serialCorrelation, entropyValue, uniformityTest;

        if (comprehensiveAnalysis && !comprehensiveAnalysis.error) {
            freqStats = comprehensiveAnalysis.frequencyAnalysis;
            gapAnalysis = comprehensiveAnalysis.gapAnalysis.absentDigits || [];
            serialCorrelation = comprehensiveAnalysis.serialCorrelation;
            entropyValue = comprehensiveAnalysis.entropy;
            uniformityTest = comprehensiveAnalysis.uniformityTest;
        } else {
            freqStats = this.calculateFrequencyStats(last500);
            gapAnalysis = this.analyzeGaps(tickHistory);
            serialCorrelation = this.calculateSerialCorrelation(tickHistory);
            entropyValue = null;
            uniformityTest = null;
        }

        const volatilityAssessment = this.assessVolatility(tickHistory);

        let comprehensiveSection = '';
        if (comprehensiveAnalysis && !comprehensiveAnalysis.error) {
            comprehensiveSection = `
            === COMPREHENSIVE STATISTICAL ANALYSIS ===
            Sample Size: ${comprehensiveAnalysis.sampleSize} ticks
            Market Regime: ${comprehensiveAnalysis.regime}
            Entropy: ${entropyValue ? entropyValue.toFixed(4) : 'N/A'} (${entropyValue > 0.95 ? 'High randomness' : 'Potential patterns'})
            
            Chi-Square Test: ${uniformityTest ? uniformityTest.interpretation : 'N/A'}
            ${uniformityTest ? `- Chi-Square: ${uniformityTest.chiSquare}, p-value: ${uniformityTest.pValue}` : ''}
            
            Gap Analysis:
            ${comprehensiveAnalysis.gapAnalysis.gaps.slice(0, 5).map(g =>
                `- Digit ${g.digit}: Absent for ${g.gapLength} ticks`
            ).join('\n            ')}
            `;
        }

        // Add Kelly Criterion context
        let kellySection = '';
        if (kellyStatus) {
            kellySection = `
            === CAPITAL & RISK STATUS ===
            Current Capital: $${kellyStatus.currentCapital.toFixed(2)}
            Drawdown: ${kellyStatus.currentDrawdown.toFixed(1)}%
            Session P/L: $${kellyStatus.sessionPnL.toFixed(2)}
            Rolling Win Rate: ${(kellyStatus.rollingWinRate * 100).toFixed(1)}%
            Recovery Mode: ${kellyStatus.recoveryMode ? 'ACTIVE' : 'Inactive'}
            
            RISK GUIDANCE:
            ${kellyStatus.currentDrawdown > 15 ? '⚠️ HIGH DRAWDOWN - Be conservative' : '✅ Drawdown acceptable'}
            ${kellyStatus.rollingWinRate < 0.45 ? '⚠️ LOW WIN RATE - Increase confidence threshold' : '✅ Win rate healthy'}
            `;
        }

        return `You are an elite statistical arbitrage AI specializing in Deriv Digit Differ prediction with Kelly Criterion risk management.

            === KELLY CRITERION INTEGRATION ===
            You are part of an AI-managed trading system that uses Kelly Criterion for position sizing.
            Your confidence score DIRECTLY affects stake size:
            - 90%+ confidence = Full position
            - 80-89% = 80% position
            - 70-79% = 50% position
            - 60-69% = 25% position
            - Below 60% = Trade should be SKIPPED
            
            BE ACCURATE with confidence - overconfidence leads to overleveraging!
            ${kellySection}

            === ADVERSARIAL REALITY ===
            The Deriv platform is an intelligent opponent that:
            - Observes and adapts to successful prediction patterns
            - Actively counters strategies showing consistent profitability
            - Exploits predictable behavioral patterns

            === CURRENT MARKET CONTEXT ===
            Asset: ${currentAsset}
            Market Regime: ${marketRegime || 'Detecting...'}
            Volatility Level: ${volatilityAssessment.level} (${volatilityAssessment.value.toFixed(3)})
            Last Prediction: ${lastPrediction || 'None'} → ${lastOutcome || 'N/A'}
            Consecutive Losses: ${consecutiveLosses}
            Recent Methods: ${recentMethods || 'None'}
            ${comprehensiveSection}

            === FREQUENCY ANALYSIS (Last 500 Ticks) ===
            ${Array.isArray(freqStats) ? this.formatFrequencyStats(freqStats) : 'Calculating...'}

            Gap Analysis (Digits absent in last 25 ticks): ${Array.isArray(gapAnalysis) ? gapAnalysis.join(', ') : 'None'}
            Serial Correlation: ${serialCorrelation ? serialCorrelation.toFixed(4) : '0.0000'}

            === PREDICTION TASK ===
            Predict the digit (0-9) that will NOT appear in the next tick (Digit Differ).
            
            CRITICAL: Your confidence score is used for Kelly Criterion stake sizing!
            - If uncertain, give LOWER confidence (50-70%)
            - Only give 85%+ if statistical evidence is STRONG
            - Consider recommending SKIP if evidence is weak

            === OUTPUT FORMAT (STRICT JSON) ===
            {
                "predictedDigit": X,
                "confidence": XX,
                "primaryStrategy": "Method-Name",
                "marketRegime": "trending/ranging/volatile/stable/random",
                "riskAssessment": "low/medium/high",
                "recommendedAction": "TRADE/SKIP/WAIT",
                "kellyAdjustment": "full/reduced/minimal",
                "statisticalEvidence": {
                    "frequencyDeviation": X.X,
                    "gapLength": X,
                    "entropyLevel": "high/medium/low",
                    "confidenceInterval": "XX-XX%"
                },
                "methodRationale": "Detailed explanation",
                "alternativeCandidates": [X, Y],
                "skipReason": "reason or null"
            }

            Generate your prediction with accurate confidence scoring for Kelly Criterion integration.
        `;
    }

    static calculateFrequencyStats(digits) {
        const counts = Array(10).fill(0);
        digits.forEach(d => counts[d]++);
        const total = digits.length;
        return counts.map((count, digit) => ({
            digit,
            count,
            frequency: (count / total * 100).toFixed(1),
            deviation: ((count / total - 0.1) * 100).toFixed(1)
        }));
    }

    static analyzeGaps(tickHistory) {
        const last25 = new Set(tickHistory.slice(-25));
        const gaps = [];
        for (let i = 0; i < 10; i++) {
            if (!last25.has(i)) gaps.push(i);
        }
        return gaps;
    }

    static assessVolatility(tickHistory) {
        if (tickHistory.length < 50) {
            return { level: 'Unknown', value: 0 };
        }
        const recent = tickHistory.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        const stdDev = Math.sqrt(variance);
        let level = 'Low';
        if (stdDev > 3) level = 'High';
        else if (stdDev > 2) level = 'Medium';
        return { level, value: stdDev };
    }

    static calculateSerialCorrelation(tickHistory) {
        if (tickHistory.length < 50) return 0;
        const recent = tickHistory.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        let numerator = 0;
        let denominator = 0;
        for (let i = 0; i < recent.length - 1; i++) {
            numerator += (recent[i] - mean) * (recent[i + 1] - mean);
            denominator += Math.pow(recent[i] - mean, 2);
        }
        return denominator > 0 ? numerator / denominator : 0;
    }

    static formatFrequencyStats(stats) {
        return stats
            .sort((a, b) => parseFloat(a.frequency) - parseFloat(b.frequency))
            .map(s => `Digit ${s.digit}: ${s.frequency}% | Deviation: ${s.deviation}%`)
            .join('\n');
    }
}

// ==================== MAIN BOT CLASS ====================

class AIDigitDifferBot {
    constructor(config = {}) {
        // Deriv Configuration
        this.token = config.derivToken || process.env.DERIV_TOKEN;

        // Initialize Kelly Criterion Manager with investment capital
        this.kellyManager = new KellyCriterionManager({
            investmentCapital: config.investmentCapital || 500,
            kellyFraction: config.kellyFraction || 0.25,
            minStake: config.minStake || 0.35,
            maxStakePercent: config.maxStakePercent || 5,
            maxDrawdownPercent: config.maxDrawdownPercent || 25,
            dailyLossLimit: config.dailyLossLimit || 50,
            dailyProfitTarget: config.dailyProfitTarget || 100
        });

        // AI Model API Keys
        this.aiModels = {
            gemini: {
                keys: this.parseGeminiKeys(process.env.GEMINI_API_nKEYS),
                currentIndex: 0,
                enabled: false,
                name: 'Gemini',
                weight: 1.2
            },
            groq: {
                key: (process.env.GROQ_API_KEY || '').trim(),
                enabled: false,
                name: 'Groq',
                weight: 1.1
            },
            openrouter: {
                key: (process.env.OPENROUTER_API_KEY || '').trim(),
                enabled: false,
                name: 'OpenRouter',
                weight: 1.0
            },
            mistral: {
                key: (process.env.MISTRAL_API_KEY || '').trim(),
                enabled: false,
                name: 'Mistral',
                weight: 1.0
            },
            cerebras: {
                key: (process.env.CEREBRAS_API_KEY || '').trim(),
                enabled: false,
                name: 'Cerebras',
                weight: 1.1
            },
            sambanova: {
                key: (process.env.SAMBANOVA_API_KEY || '').trim(),
                enabled: false,
                name: 'SambaNova',
                weight: 1.0
            },
            moonshot: {
                key: (process.env.MOONSHOT_API_KEY || '').trim(),
                enabled: false,
                name: 'Moonshot',
                weight: 1.0
            },

        };

        this.initializeAIModels();

        // WebSocket
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // Assets
        this.assets = config.assets || [
            'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'
        ];

        // Trading Configuration
        this.config = {
            requiredHistoryLength: config.requiredHistoryLength || 500,
            minConfidence: config.minConfidence || 70,
            minModelsAgreement: config.minModelsAgreement || 2,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 6,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            tradeCooldown: config.tradeCooldown || 5000,
            minWaitTime: config.minWaitTime || 15000,
            maxWaitTime: config.maxWaitTime || 90000,
        };

        // Trading State
        this.currentAsset = null;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.consecutiveWins = 0;
        this.currentTradeId = null;
        this.tickSubscriptionId = null;
        this.tradingHistory = [];
        this.lastTradeResult = null;

        // Statistics
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.balance = 0;
        this.sessionStartBalance = 0;

        // Tick Data
        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);

        // Prediction Tracking
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.lastPrediction = null;
        this.lastConfidence = 0;
        this.previousPredictions = [];
        this.predictionOutcomes = [];
        this.tradeMethod = [];
        this.currentPrediction = null;
        this.RestartTrading = true;

        // Model Performance Tracking
        this.modelPerformance = {};
        for (const key in this.aiModels) {
            this.modelPerformance[key] = {
                wins: 0,
                losses: 0,
                predictions: [],
                lastPrediction: 'None',
                lastOutcome: 'None',
                currentPrediction: null
            };
        }

        // Connection State
        this.reconnectAttempts = 0;
        this.isPaused = false;
        this.isShuttingDown = false;
        this.isReconnecting = false;

        // Telegram Configuration
        this.telegramToken = process.env.TELEGRAM_BOT_TOKEN;
        this.telegramChatId = process.env.TELEGRAM_CHAT_ID;
        this.telegramEnabled = !!(this.telegramToken && this.telegramChatId);

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
        }

        this.sessionStartTime = new Date();

        console.log('\n' + '='.repeat(60));
        console.log('🤖 AI DIGIT DIFFER TRADING BOT v4.0');
        console.log('   Kelly Criterion Risk Management System');
        console.log('='.repeat(60));
        this.logActiveModels();

        if (this.telegramEnabled) {
            this.startTelegramTimer();
        }
    }

    // ==================== INITIALIZATION ====================

    parseGeminiKeys(keysString) {
        if (!keysString || typeof keysString !== 'string') return [];
        const cleaned = keysString.replace(/["'\r\n]/g, ' ').trim();
        if (!cleaned) return [];
        if (cleaned.includes(',')) {
            return cleaned.split(',').map(k => k.trim()).filter(k => k.length > 20);
        }
        return cleaned.split(/\s+/).filter(k => k.length > 20);
    }

    initializeAIModels() {
        if (this.aiModels.gemini.keys.length > 0) {
            this.aiModels.gemini.enabled = true;
        }
        for (const key of ['groq', 'openrouter', 'mistral', 'cerebras', 'sambanova']) {
            const apiKey = this.aiModels[key].key;
            if (apiKey && apiKey.length > 10) {
                this.aiModels[key].enabled = true;
            }
        }
    }

    logActiveModels() {
        console.log('\n📊 Active AI Models:');
        let activeCount = 0;
        for (const [key, model] of Object.entries(this.aiModels)) {
            const status = model.enabled ? '✅' : '❌';
            let extra = '';
            if (key === 'gemini' && model.enabled) {
                extra = `(${model.keys.length} key${model.keys.length > 1 ? 's' : ''})`;
            }
            console.log(`   ${status} ${model.name} ${extra}`);
            if (model.enabled) activeCount++;
        }
        console.log(`\n   Total Active: ${activeCount} models`);
        if (activeCount === 0) {
            console.log('\n⚠️  WARNING: No AI models configured!');
        }
        console.log('='.repeat(60) + '\n');
    }

    // ==================== WEBSOCKET CONNECTION ====================

    connect() {
        if (this.isShuttingDown || this.connected) return;

        console.log('🔌 Connecting to Deriv API...');

        try {
            this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            this.ws.on('open', () => {
                console.log('✅ Connected to Deriv API');
                this.connected = true;
                this.wsReady = true;
                this.reconnectAttempts = 0;
                this.isReconnecting = false;
                this.authenticate();
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Error parsing message:', error.message);
                }
            });

            this.ws.on('error', (error) => {
                console.error('❌ WebSocket error:', error.message);
            });

            this.ws.on('close', (code) => {
                console.log(`🔌 Disconnected (code: ${code})`);
                this.connected = false;
                this.wsReady = false;
                this.ws = null;
                if (!this.isPaused && !this.isShuttingDown) {
                    this.handleDisconnect();
                }
            });

        } catch (error) {
            console.error('Error creating WebSocket:', error.message);
            this.handleDisconnect();
        }
    }

    sendRequest(request) {
        if (this.connected && this.wsReady && this.ws) {
            try {
                this.ws.send(JSON.stringify(request));
                return true;
            } catch (error) {
                console.error('Error sending request:', error.message);
                return false;
            }
        }
        return false;
    }

    handleDisconnect() {
        if (this.isReconnecting || this.isShuttingDown) return;

        this.connected = false;
        this.wsReady = false;
        this.isReconnecting = true;

        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.terminate();
            } catch (e) { }
            this.ws = null;
        }

        this.reconnectAttempts++;
        const delay = Math.min(this.config.reconnectInterval * (this.reconnectAttempts + 1), 30000);
        console.log(`🔄 Reconnecting in ${delay / 1000}s...`);

        setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    authenticate() {
        console.log('🔐 Authenticating...');
        this.sendRequest({ authorize: this.token });
    }

    disconnect() {
        this.connected = false;
        this.wsReady = false;
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close();
            } catch (e) { }
            this.ws = null;
        }
    }

    shutdown() {
        console.log('\n🛑 Shutting down...');
        this.isShuttingDown = true;
        this.isPaused = true;
        this.logFinalSummary();
        this.disconnect();
        console.log('💤 Bot stopped.');
        setInterval(() => { }, 1000 * 60 * 60);
    }

    // ==================== MESSAGE HANDLING ====================

    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                this.handleAuthorize(message);
                break;
            case 'balance':
                // this.handleBalance(message);
                break;
            case 'history':
                this.handleTickHistory(message.history);
                break;
            case 'tick':
                this.handleTickUpdate(message.tick);
                break;
            case 'buy':
                this.handleBuyResponse(message);
                break;
            case 'proposal_open_contract':
                if (message.proposal_open_contract?.is_sold) {
                    this.handleTradeResult(message.proposal_open_contract);
                }
                break;
            default:
                if (message.error) {
                    this.handleError(message.error);
                }
        }
    }

    handleAuthorize(message) {
        if (message.error) {
            console.error('❌ Authentication failed:', message.error.message);
            this.scheduleReconnect(5000);
            return;
        }

        console.log('✅ Authentication successful');
        console.log(`👤 Account: ${message.authorize.loginid}`);
        this.balance = this.kellyManager.investmentCapital;
        // this.sessionStartBalance = this.balance;

        // Sync Kelly Manager with actual balance
        // this.kellyManager.currentCapital = this.balance;
        // this.kellyManager.investmentCapital = this.balance;
        // this.kellyManager.peakCapital = this.balance;

        console.log(`💰 Balance: $${this.balance.toFixed(2)}`);

        this.sendRequest({ balance: 1, subscribe: 1 });
        this.resetTradingState();
        this.startTrading();
    }

    resetTradingState() {
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);
        this.tickSubscriptionId = null;
    }

    // handleBalance(message) {
    //     if (message.balance) {
    //         this.balance = message.balance.balance;
    //         this.kellyManager.currentCapital = this.balance;
    //     }
    // }

    handleBuyResponse(message) {
        if (message.error) {
            console.error('❌ Trade error:', message.error.message);
            this.tradeInProgress = false;
            this.predictionInProgress = false;
            this.scheduleNextTrade2();
            return;
        }

        console.log('✅ Trade placed successfully');
        this.currentTradeId = message.buy.contract_id;
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: this.currentTradeId,
            subscribe: 1
        });
    }

    handleError(error) {
        console.error('❌ API Error:', error.message, `(Code: ${error.code})`);

        switch (error.code) {
            case 'InvalidToken':
                this.shutdown();
                break;
            case 'RateLimit':
                this.scheduleReconnect(60000);
                break;
            case 'MarketIsClosed':
                this.scheduleReconnect(300000);
                break;
            default:
                if (!this.tradeInProgress) {
                    this.scheduleNextTrade();
                }
        }
    }

    // ==================== TRADING LOGIC ====================

    startTrading() {
        console.log('\n📈 Starting trading session...');
        console.log(`💰 Investment Capital: $${this.kellyManager.investmentCapital.toFixed(2)}`);
        this.selectNextAsset();
    }

    selectNextAsset() {
        if (this.usedAssets.size >= this.assets.length) {
            this.usedAssets.clear();
        }

        if (this.RestartTrading) {
            const availableAssets = this.assets.filter(a => !this.usedAssets.has(a));
            this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
            this.usedAssets.add(this.currentAsset);
        }

        // this.RestartTrading = false;
        console.log(`\n🎯 Selected asset: ${this.currentAsset}`);

        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);

        if (this.tickSubscriptionId) {
            this.sendRequest({ forget: this.tickSubscriptionId });
        }

        setTimeout(() => {
            this.sendRequest({
                ticks_history: this.currentAsset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });

            this.sendRequest({
                ticks: this.currentAsset,
                subscribe: 1
            });
        }, 500);
    }

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

    handleTickHistory(history) {
        if (!history || !history.prices) {
            console.log('⚠️ Invalid tick history received');
            return;
        }
        this.tickHistory = history.prices.map(price => this.getLastDigit(price, this.currentAsset));
        console.log(`📊 Received ${this.tickHistory.length} ticks of history`);
    }

    handleTickUpdate(tick) {
        if (!tick || !tick.quote) return;

        const lastDigit = this.getLastDigit(tick.quote, this.currentAsset);
        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.config.requiredHistoryLength) {
            this.tickHistory.shift();
        }
        this.digitCounts[lastDigit]++;

        console.log(`📍 Last 5 digits: ${this.tickHistory.slice(-5).join(', ')} | History: ${this.tickHistory.length}`);

        if (this.tickHistory.length >= this.config.requiredHistoryLength &&
            !this.tradeInProgress && !this.predictionInProgress) {
            this.analyzeTicks();
        }
    }

    // ==================== AI PREDICTION ENGINE ====================

    async analyzeTicks() {
        if (this.tradeInProgress || this.predictionInProgress) return;

        // Check if we should continue trading
        const tradingStatus = this.kellyManager.shouldContinueTrading();
        if (!tradingStatus.canTrade) {
            console.log('\n🛑 Trading stopped by Kelly Manager:');
            tradingStatus.reasons.forEach(r => console.log(`   - ${r}`));
            this.shutdown();
            return;
        }

        if (tradingStatus.warning) {
            console.log(`\n⚠️ WARNING: Drawdown at ${tradingStatus.currentDrawdown.toFixed(1)}%`);
        }

        this.predictionInProgress = false;
        console.log('\n🧠 Starting AI ensemble prediction...');

        const startTime = Date.now();

        try {
            const predictions = await this.getEnsemblePredictions();
            const processingTime = (Date.now() - startTime) / 1000;

            console.log(`⏱️  AI processing time: ${processingTime.toFixed(2)}s`);

            if (predictions.length === 0) {
                console.log('⚠️  No valid predictions received');
                this.predictionInProgress = false;
                this.scheduleNextTrade2();
                return;
            }

            const ensemble = this.calculateEnsembleResult(predictions);

            console.log('\n📊 Ensemble Result:');
            console.log(`   Predicted Digit: ${ensemble.digit}`);
            console.log(`   Confidence: ${ensemble.confidence}%`);
            console.log(`   Models Agree: ${ensemble.agreement}/${predictions.length}`);
            console.log(`   Risk Level: ${ensemble.risk}`);

            this.lastPrediction = ensemble.digit;
            this.lastConfidence = ensemble.confidence;

            // Get market analysis
            const marketRegime = this.detectMarketRegime(this.tickHistory);
            const volatility = this.getVolatilityLevel(this.tickHistory);

            // Calculate optimal stake using Kelly Criterion
            const winRate = this.kellyManager.getRollingWinRate();
            const payout = this.kellyManager.getPayoutForAsset(this.currentAsset);

            const kellyResult = this.kellyManager.calculateOptimalStake({
                winProbability: Math.max(0.4, Math.min(0.7, winRate + (ensemble.confidence - 50) / 200)),
                payout: payout,
                confidence: ensemble.confidence,
                marketRegime: marketRegime,
                consecutiveLosses: this.consecutiveLosses,
                consecutiveWins: this.consecutiveWins,
                volatility: volatility
            });

            console.log(`\n💰 Kelly Criterion Result:`);
            console.log(`   Optimal Stake: $${kellyResult.stake.toFixed(2)}`);
            console.log(`   Risk Level: ${kellyResult.riskLevel}`);
            console.log(`   Recommendation: ${kellyResult.recommendation}`);

            // Decide whether to trade
            const tradeDecision = this.shouldExecuteTrade(ensemble, marketRegime, kellyResult);

            if (tradeDecision.execute && processingTime < 3) {
                this.placeTrade(ensemble.digit, ensemble.confidence, kellyResult.stake);
            } else {
                console.log(`⏭️ Skipping trade: ${tradeDecision.reason}`);
                this.predictionInProgress = false;
                this.scheduleNextTrade2();
            }

        } catch (error) {
            console.error('❌ Prediction error:', error.message);
            this.predictionInProgress = false;
            this.scheduleNextTrade2();
        }
    }

    shouldExecuteTrade(ensemble, marketRegime, kellyResult) {
        const reasons = [];
        let execute = true;

        if (ensemble.confidence < this.config.minConfidence) {
            execute = false;
            reasons.push(`Low confidence: ${ensemble.confidence}%`);
        }

        if (kellyResult.recommendation === 'SKIP - Confidence too low') {
            execute = false;
            reasons.push('Kelly recommends skip');
        }

        if (ensemble.risk === 'high') {
            execute = false;
            reasons.push('High risk assessment');
        }

        if (marketRegime === 'volatile' && ensemble.confidence < 80) {
            execute = false;
            reasons.push('Volatile market needs 80%+ confidence');
        }

        if (marketRegime === 'random' && ensemble.confidence < 85) {
            execute = false;
            reasons.push('Random market needs 85%+ confidence');
        }

        const lastTickDigit = this.tickHistory[this.tickHistory.length - 1];
        if (ensemble.digit === lastTickDigit) {
            execute = false;
            reasons.push(`Digit ${ensemble.digit} just appeared`);
        }

        if (this.consecutiveLosses >= 4 && ensemble.confidence < 85) {
            execute = false;
            reasons.push('4+ losses need 85%+ confidence');
        }

        return {
            execute,
            reason: execute ? 'All checks passed' : reasons.join(' | ')
        };
    }

    getVolatilityLevel(tickHistory) {
        if (tickHistory.length < 50) return 'medium';
        const recent = tickHistory.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        const stdDev = Math.sqrt(variance);

        if (stdDev > 3.5) return 'extreme';
        if (stdDev > 2.8) return 'high';
        if (stdDev > 2.0) return 'medium';
        return 'low';
    }

    async getEnsemblePredictions() {
        const predictions = [];
        const promises = [];

        if (this.aiModels.gemini.enabled) {
            promises.push(
                this.predictWithGemini()
                    .then(r => { r.model = 'gemini'; return r; })
                    .catch(e => ({ error: e.message, model: 'gemini' }))
            );
        }
        if (this.aiModels.groq.enabled) {
            promises.push(
                this.predictWithGroq()
                    .then(r => { r.model = 'groq'; return r; })
                    .catch(e => ({ error: e.message, model: 'groq' }))
            );
        }
        if (this.aiModels.openrouter.enabled) {
            promises.push(
                this.predictWithOpenRouter()
                    .then(r => { r.model = 'openrouter'; return r; })
                    .catch(e => ({ error: e.message, model: 'openrouter' }))
            );
        }
        if (this.aiModels.mistral.enabled) {
            promises.push(
                this.predictWithMistral()
                    .then(r => { r.model = 'mistral'; return r; })
                    .catch(e => ({ error: e.message, model: 'mistral' }))
            );
        }
        if (this.aiModels.cerebras.enabled) {
            promises.push(
                this.predictWithCerebras()
                    .then(r => { r.model = 'cerebras'; return r; })
                    .catch(e => ({ error: e.message, model: 'cerebras' }))
            );
        }
        if (this.aiModels.sambanova.enabled) {
            promises.push(
                this.predictWithSambaNova()
                    .then(r => { r.model = 'sambanova'; return r; })
                    .catch(e => ({ error: e.message, model: 'sambanova' }))
            );
        }

        const results = await Promise.race([
            Promise.all(promises),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 45000))
        ]).catch(() => []);

        for (const result of results) {
            if (result && !result.error && typeof result.predictedDigit === 'number') {
                predictions.push(result);
                if (this.modelPerformance[result.model]) {
                    this.modelPerformance[result.model].currentPrediction = result.predictedDigit;
                }
                console.log(`   ✅ ${result.model}: digit=${result.predictedDigit}, conf=${result.confidence}%`);
            } else if (result && result.error) {
                console.log(`   ❌ ${result.model}: ${result.error}`);
            }
        }

        const statPrediction = this.statisticalPrediction();
        predictions.push(statPrediction);
        console.log(`   📈 Statistical: digit=${statPrediction.predictedDigit}, conf=${statPrediction.confidence}%`);

        return predictions;
    }

    calculateEnsembleResult(predictions) {
        const votes = Array(10).fill(0);
        const confidences = Array(10).fill().map(() => []);
        let totalRisk = 0;
        let regime = null;

        for (const pred of predictions) {
            const digit = pred.predictedDigit;
            const weight = this.aiModels[pred.model]?.weight || 1.0;

            const perf = this.modelPerformance[pred.model];
            let performanceMultiplier = 1.0;
            if (perf && (perf.wins + perf.losses) >= 5) {
                const winRate = perf.wins / (perf.wins + perf.losses);
                performanceMultiplier = 0.5 + winRate;
            }

            votes[digit] += weight * performanceMultiplier;
            confidences[digit].push(pred.confidence);

            if (pred.riskAssessment) {
                totalRisk += pred.riskAssessment === 'high' ? 3 : pred.riskAssessment === 'medium' ? 2 : 1;
            }
            if (pred.marketRegime && !regime) regime = pred.marketRegime;
        }

        let maxVotes = 0;
        let winningDigit = 0;
        for (let i = 0; i < 10; i++) {
            if (votes[i] > maxVotes) {
                maxVotes = votes[i];
                winningDigit = i;
            }
        }

        const rawVotes = Array(10).fill(0);
        predictions.forEach(p => rawVotes[p.predictedDigit]++);
        const agreement = rawVotes[winningDigit];

        const avgConfidence = confidences[winningDigit].length > 0
            ? Math.round(confidences[winningDigit].reduce((a, b) => a + b, 0) / confidences[winningDigit].length)
            : 50;

        const avgRisk = totalRisk / predictions.length;
        const risk = avgRisk >= 2.5 ? 'high' : avgRisk >= 1.5 ? 'medium' : 'low';

        return {
            digit: winningDigit,
            confidence: avgConfidence,
            agreement,
            risk,
            regime,
            totalModels: predictions.length
        };
    }

    detectMarketRegime(tickHistory) {
        if (tickHistory.length < 100) return 'unknown';

        const recent = tickHistory.slice(-100);
        const volatility = this.calculateVolatility(recent);
        const entropy = this.calculateEntropy(recent);

        if (volatility > 2.8) return 'volatile';
        if (entropy > 0.97) return 'random';
        if (volatility < 2.0) return 'stable';
        return 'ranging';
    }

    calculateVolatility(digits) {
        if (digits.length < 20) return 0;
        const mean = digits.reduce((a, b) => a + b, 0) / digits.length;
        const variance = digits.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / digits.length;
        return Math.sqrt(variance);
    }

    calculateEntropy(digits) {
        const counts = Array(10).fill(0);
        digits.forEach(d => counts[d]++);
        const total = digits.length;
        let entropy = 0;
        for (const count of counts) {
            if (count > 0) {
                const p = count / total;
                entropy -= p * Math.log2(p);
            }
        }
        return entropy / Math.log2(10);
    }

    performComprehensiveAnalysis(tickHistory, minSampleSize = 100) {
        if (tickHistory.length < minSampleSize) {
            return { error: 'Insufficient data' };
        }

        const sample = tickHistory.slice(-minSampleSize);
        const counts = Array(10).fill(0);
        sample.forEach(d => counts[d]++);

        const last25 = new Set(sample.slice(-25));
        const gaps = [];
        for (let i = 0; i < 10; i++) {
            if (!last25.has(i)) {
                let gapLength = 0;
                for (let j = sample.length - 1; j >= 0; j--) {
                    if (sample[j] === i) break;
                    gapLength++;
                }
                gaps.push({ digit: i, gapLength });
            }
        }

        return {
            sampleSize: sample.length,
            frequencyAnalysis: counts.map((count, digit) => ({
                digit,
                count,
                frequency: count / sample.length
            })),
            gapAnalysis: {
                gaps: gaps.sort((a, b) => b.gapLength - a.gapLength),
                absentDigits: gaps.map(g => g.digit)
            },
            entropy: this.calculateEntropy(sample),
            serialCorrelation: this.calculateSerialCorrelation(sample),
            uniformityTest: this.performChiSquareTest(sample),
            regime: this.detectMarketRegime(sample)
        };
    }

    calculateSerialCorrelation(digits) {
        if (digits.length < 50) return 0;
        const mean = digits.reduce((a, b) => a + b, 0) / digits.length;
        let numerator = 0, denominator = 0;
        for (let i = 0; i < digits.length - 1; i++) {
            numerator += (digits[i] - mean) * (digits[i + 1] - mean);
            denominator += Math.pow(digits[i] - mean, 2);
        }
        return denominator > 0 ? numerator / denominator : 0;
    }

    performChiSquareTest(digits) {
        if (digits.length < 100) return { chiSquare: 0, pValue: 1, isUniform: true };

        const counts = Array(10).fill(0);
        digits.forEach(d => counts[d]++);
        const expected = digits.length / 10;
        let chiSquare = 0;

        for (const count of counts) {
            chiSquare += Math.pow(count - expected, 2) / expected;
        }

        const isUniform = chiSquare < 16.919;
        return {
            chiSquare: chiSquare.toFixed(3),
            pValue: isUniform ? '> 0.05' : '< 0.05',
            isUniform,
            interpretation: isUniform ? 'Uniform (random)' : 'Non-uniform (pattern)'
        };
    }

    getPrompt(modelName = 'unknown') {
        const modelStats = this.modelPerformance[modelName] || {};
        const lastPred = modelStats.lastPrediction !== undefined ? modelStats.lastPrediction : 'None';
        const lastOutcome = modelStats.lastOutcome !== undefined ? modelStats.lastOutcome : 'None';
        const recentMethods = this.tradeMethod.slice(-5).join(', ');
        const marketRegime = this.detectMarketRegime(this.tickHistory);
        const volatility = this.calculateVolatility(this.tickHistory);
        const comprehensiveAnalysis = this.tickHistory.length >= 100
            ? this.performComprehensiveAnalysis(this.tickHistory, 100)
            : null;

        const marketData = {
            currentAsset: this.currentAsset,
            tickHistory: this.tickHistory,
            lastPrediction: lastPred,
            lastOutcome: lastOutcome,
            consecutiveLosses: this.consecutiveLosses,
            recentMethods: recentMethods,
            volatility: volatility,
            marketRegime: marketRegime,
            comprehensiveAnalysis: comprehensiveAnalysis
        };

        return EnhancedAIPrompt.generatePrompt(
            marketData,
            this.modelPerformance,
            this.kellyManager.getStatus()
        );
    }

    parseAIResponse(text, modelName = 'unknown') {
        if (!text) throw new Error('Empty response');

        try {
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');

            if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
                throw new Error('No JSON found');
            }

            const jsonStr = text.substring(firstBrace, lastBrace + 1);
            const prediction = JSON.parse(jsonStr);

            if (typeof prediction.predictedDigit !== 'number' ||
                prediction.predictedDigit < 0 ||
                prediction.predictedDigit > 9) {
                throw new Error(`Invalid predictedDigit: ${prediction.predictedDigit}`);
            }

            if (typeof prediction.confidence !== 'number') {
                prediction.confidence = 60;
            }

            return prediction;
        } catch (e) {
            throw e;
        }
    }

    // ==================== AI MODEL INTEGRATIONS ====================

    async predictWithGemini() {
        const keys = this.aiModels.gemini.keys;
        if (!keys || keys.length === 0) throw new Error('No Gemini API keys');

        const key = keys[this.aiModels.gemini.currentIndex % keys.length];
        this.aiModels.gemini.currentIndex++;

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${key}`,
            {
                contents: [{ parts: [{ text: this.getPrompt('gemini') }] }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 512,
                    response_mime_type: "application/json"
                }
            },
            { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
        );

        const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
        return this.parseAIResponse(text, 'gemini');
    }

    async predictWithGroq() {
        const key = this.aiModels.groq.key;
        if (!key) throw new Error('No Groq API key');

        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: 'You are a trading AI that outputs JSON only.' },
                    { role: 'user', content: this.getPrompt('groq') }
                ],
                temperature: 0.1,
                max_tokens: 512,
                response_format: { type: "json_object" }
            },
            {
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'groq');
    }

    async predictWithOpenRouter() {
        const key = this.aiModels.openrouter.key;
        if (!key) throw new Error('No OpenRouter API key');

        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'meta-llama/llama-3.2-3b-instruct:free',
                messages: [
                    { role: 'system', content: 'You are a trading AI that outputs JSON only.' },
                    { role: 'user', content: this.getPrompt('openrouter') }
                ],
                temperature: 0.1,
                max_tokens: 512
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`,
                    'HTTP-Referer': 'https://github.com/digit-differ-bot'
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'openrouter');
    }

    async predictWithMistral() {
        const key = this.aiModels.mistral.key;
        if (!key) throw new Error('No Mistral API key');

        const response = await axios.post(
            'https://api.mistral.ai/v1/chat/completions',
            {
                model: 'mistral-small-latest',
                messages: [
                    { role: 'system', content: 'You are a trading AI that outputs JSON only.' },
                    { role: 'user', content: this.getPrompt('mistral') }
                ],
                temperature: 0.1,
                max_tokens: 512
            },
            {
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'mistral');
    }

    async predictWithCerebras() {
        const key = this.aiModels.cerebras.key;
        if (!key) throw new Error('No Cerebras API key');

        const response = await axios.post(
            'https://api.cerebras.ai/v1/chat/completions',
            {
                model: 'llama-3.3-70b',
                messages: [
                    { role: 'system', content: 'You are a trading AI that outputs JSON only.' },
                    { role: 'user', content: this.getPrompt('cerebras') }
                ],
                temperature: 0.1,
                max_tokens: 512
            },
            {
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'cerebras');
    }

    async predictWithSambaNova() {
        const key = this.aiModels.sambanova.key;
        if (!key) throw new Error('No SambaNova API key');

        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',//'https://gen.pollinations.ai/v1/chat/completions',//'https://openrouter.ai/api/v1/chat/completions',//'https://api.moonshot.cn/v1/chat/completions',
            {
                model: 'llama-3.3-70b-versatile',//'moonshotai/kimi-k2-instruct-0905',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt('SambaNova') }
                ],
                temperature: 0.1,
                max_tokens: 256,
                response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'sambanova');
    }

    // ==================== STATISTICAL PREDICTION ====================

    statisticalPrediction() {
        const last100 = this.tickHistory.slice(-300);
        const last20 = this.tickHistory.slice(-20);

        const counts = Array(10).fill(0);
        last100.forEach(d => counts[d]++);

        const last15Set = new Set(this.tickHistory.slice(-15));
        const gaps = [];
        for (let i = 0; i < 10; i++) {
            if (!last15Set.has(i)) gaps.push(i);
        }

        const lastDigit = this.tickHistory[this.tickHistory.length - 1];
        const transitions = Array(10).fill(0);
        for (let i = 1; i < last100.length; i++) {
            if (last100[i - 1] === lastDigit) {
                transitions[last100[i]]++;
            }
        }

        const scores = Array(10).fill(0);

        for (let i = 0; i < 10; i++) {
            scores[i] += (10 - counts[i]) * 2;
            if (gaps.includes(i)) scores[i] -= 7;
            scores[i] -= transitions[i];

            const recentCount = last20.filter(d => d === i).length;
            if (recentCount === 0) scores[i] -= 2;
            else if (recentCount >= 4) scores[i] += 3;
        }

        let maxScore = -Infinity;
        let predictedDigit = 0;

        for (let i = 0; i < 10; i++) {
            if (scores[i] > maxScore) {
                maxScore = scores[i];
                predictedDigit = i;
            }
        }

        const avgScore = scores.reduce((a, b) => a + b, 0) / 10;
        const scoreDiff = maxScore - avgScore;
        const confidence = Math.min(85, Math.max(50, Math.round(50 + scoreDiff * 5)));

        return {
            predictedDigit,
            confidence,
            primaryStrategy: 'Statistical Analysis',
            marketRegime: 'ranging',
            riskAssessment: confidence >= 70 ? 'low' : 'medium',
            model: 'statistical'
        };
    }

    // ==================== TRADE EXECUTION ====================

    placeTrade(digit, confidence, stake) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.predictionInProgress = true;

        // Ensure stake is valid
        stake = Math.max(0.35, Math.min(stake, this.balance * 0.1));
        stake = Math.round(stake * 100) / 100;

        console.log(`\n💰 Placing trade: DIFFER ${digit} @ $${stake.toFixed(2)} (${confidence}% confidence)`);

        this.sendRequest({
            buy: 1,
            price: stake,
            parameters: {
                amount: stake,
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: this.currentAsset,
                barrier: digit
            }
        });

        this.currentPrediction = { digit, confidence, stake };
    }

    handleTradeResult(contract) {
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const exitSpot = contract.exit_tick_display_value;
        const actualDigit = this.getLastDigit(exitSpot, this.currentAsset);

        console.log('\n' + '='.repeat(40));
        console.log(won ? '🎉 TRADE WON!' : '😔 TRADE LOST');
        console.log(`   Predicted: ${this.lastPrediction} | Actual: ${actualDigit}`);
        console.log(`   Profit: ${won ? '+' : ''}$${profit.toFixed(2)}`);
        console.log('='.repeat(40));

        // Update statistics
        this.totalTrades++;

        // Update Kelly Manager
        this.kellyManager.updateAfterTrade(profit, won);

        // Update model performance
        for (const key in this.modelPerformance) {
            const stats = this.modelPerformance[key];
            const currentPred = stats.currentPrediction;

            if (currentPred !== null && currentPred !== undefined) {
                const modelWon = currentPred !== actualDigit;
                stats.lastPrediction = currentPred;
                stats.lastOutcome = modelWon ? 'WON' : 'LOST';
                if (modelWon) stats.wins++;
                else stats.losses++;
                stats.currentPrediction = null;
            }
        }

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.consecutiveWins++;
            this.lastTradeResult = 'won';
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.consecutiveWins = 0;
            this.lastTradeResult = 'lost';
        }

        this.balance = this.kellyManager.currentCapital;

        // Log Kelly status
        const kellyStatus = this.kellyManager.getStatus();
        console.log(`\n📊 Kelly Status:`);
        console.log(`   Capital: $${kellyStatus.currentCapital.toFixed(2)} (Peak: $${kellyStatus.peakCapital.toFixed(2)})`);
        console.log(`   Drawdown: ${kellyStatus.currentDrawdown.toFixed(1)}%`);
        console.log(`   Session P/L: $${kellyStatus.sessionPnL.toFixed(2)}`);
        console.log(`   Win Rate: ${(kellyStatus.rollingWinRate * 100).toFixed(1)}%`);

        this.logTradingSummary();

        // Check stop conditions
        if (this.checkStopConditions()) {
            return;
        }

        // Send Telegram notification for loss
        if (!won && this.telegramEnabled) {
            this.sendTelegramLossAlert(actualDigit, profit);
        }

        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.scheduleNextTrade();
    }

    checkStopConditions() {
        const kellyStatus = this.kellyManager.shouldContinueTrading();

        if (!kellyStatus.canTrade) {
            console.log('\n🛑 Kelly Manager stopping trading:');
            kellyStatus.reasons.forEach(r => console.log(`   - ${r}`));
            this.shutdown();
            return true;
        }

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('\n🛑 Max consecutive losses reached.');
            this.shutdown();
            return true;
        }

        if (kellyStatus.reachedDailyTarget) {
            console.log('\n🎉 Daily profit target reached!');
            this.shutdown();
            return true;
        }

        return false;
    }

    scheduleNextTrade() {
        if (this.aiModels.gemini.enabled && this.aiModels.gemini.keys.length > 1) {
            this.aiModels.gemini.currentIndex =
                (this.aiModels.gemini.currentIndex + 1) % this.aiModels.gemini.keys.length;
        }

        const waitTime = Math.floor(
            Math.random() * (this.config.maxWaitTime - this.config.minWaitTime) +
            this.config.minWaitTime
        );

        console.log(`\n⏳ Waiting ${Math.round(waitTime / 1000)}s before next trade...`);

        this.isPaused = true;
        this.disconnect();

        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.isPaused = false;
                this.reconnectAttempts = 0;
                this.connect();
            }
        }, waitTime);
    }

    scheduleNextTrade2() {
        if (this.aiModels.gemini.enabled && this.aiModels.gemini.keys.length > 1) {
            this.aiModels.gemini.currentIndex =
                (this.aiModels.gemini.currentIndex + 1) % this.aiModels.gemini.keys.length;
        }

        const waitTime = Math.floor(
            Math.random() * (30000 - 15000) +
            15000
        );

        console.log(`\n⏳ Waiting ${Math.round(waitTime / 1000)}s before next trade...`);

        this.isPaused = true;
        this.disconnect();

        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.isPaused = false;
                this.reconnectAttempts = 0;
                this.connect();
            }
        }, waitTime);
    }

    scheduleReconnect(delay) {
        this.isPaused = true;
        this.disconnect();

        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.isPaused = false;
                this.reconnectAttempts = 0;
                this.connect();
            }
        }, delay);
    }

    // ==================== LOGGING & NOTIFICATIONS ====================

    logTradingSummary() {
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;

        const kellyStatus = this.kellyManager.getStatus();

        console.log('\n📊 Trading Summary:');
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins/Losses: ${this.totalWins}/${this.totalLosses}`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Session P/L: $${kellyStatus.sessionPnL.toFixed(2)}`);
        console.log(`   Balance: $${kellyStatus.currentCapital.toFixed(2)}`);
        console.log(`   Max Drawdown: ${kellyStatus.maxDrawdownReached.toFixed(1)}%`);
    }

    logFinalSummary() {
        const duration = this.getSessionDuration();
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;
        const kellyStatus = this.kellyManager.getStatus();

        console.log('\n' + '='.repeat(60));
        console.log('📊 FINAL TRADING SUMMARY');
        console.log('='.repeat(60));
        console.log(`   Session Duration: ${duration}`);
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins: ${this.totalWins}`);
        console.log(`   Losses: ${this.totalLosses}`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Session P/L: $${kellyStatus.sessionPnL.toFixed(2)}`);
        console.log(`   Starting Capital: $${kellyStatus.investmentCapital.toFixed(2)}`);
        console.log(`   Final Capital: $${kellyStatus.currentCapital.toFixed(2)}`);
        console.log(`   Max Drawdown: ${kellyStatus.maxDrawdownReached.toFixed(1)}%`);
        console.log(`   ROI: ${((kellyStatus.currentCapital - kellyStatus.investmentCapital) / kellyStatus.investmentCapital * 100).toFixed(2)}%`);
        console.log('='.repeat(60) + '\n');

        if (this.telegramEnabled) {
            this.sendTelegramMessage(`<b>⏹ Bot Stopped</b>\n\n${this.getTelegramSummary()}`);
        }
    }

    getSessionDuration() {
        const now = new Date();
        const diff = now - this.sessionStartTime;
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        return `${hours}h ${minutes}m`;
    }

    getTelegramSummary() {
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;
        const kellyStatus = this.kellyManager.getStatus();

        return `<b>Kelly Criterion Trading Summary</b>
━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Total Trades:</b> ${this.totalTrades}
✅ <b>Wins:</b> ${this.totalWins}
❌ <b>Losses:</b> ${this.totalLosses}
📈 <b>Win Rate:</b> ${winRate}%

💰 <b>Investment:</b> $${kellyStatus.investmentCapital.toFixed(2)}
💵 <b>Current Capital:</b> $${kellyStatus.currentCapital.toFixed(2)}
📉 <b>Max Drawdown:</b> ${kellyStatus.maxDrawdownReached.toFixed(1)}%
📊 <b>Session P/L:</b> $${kellyStatus.sessionPnL.toFixed(2)}
📈 <b>ROI:</b> ${((kellyStatus.currentCapital - kellyStatus.investmentCapital) / kellyStatus.investmentCapital * 100).toFixed(2)}%`;
    }

    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;

        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error('❌ Telegram error:', error.message);
        }
    }

    startTelegramTimer() {
        setInterval(() => {
            if (this.totalTrades > 0 && !this.isShuttingDown) {
                this.sendTelegramMessage(`📊 <b>Performance Update</b>\n\n${this.getTelegramSummary()}`);
            }
        }, 30 * 60 * 1000);
    }

    async sendTelegramLossAlert(actualDigit, profit) {
        const kellyStatus = this.kellyManager.getStatus();

        const body = `🚨 <b>TRADE LOSS</b>
━━━━━━━━━━━━━━━━━━━━
<b>Asset:</b> ${this.currentAsset}
<b>Predicted:</b> ${this.lastPrediction} | <b>Actual:</b> ${actualDigit}
<b>Loss:</b> -$${Math.abs(profit).toFixed(2)}

<b>Consecutive Losses:</b> ${this.consecutiveLosses}/${this.config.maxConsecutiveLosses}
<b>Drawdown:</b> ${kellyStatus.currentDrawdown.toFixed(1)}%
<b>Capital:</b> $${kellyStatus.currentCapital.toFixed(2)}`;

        await this.sendTelegramMessage(body);
    }

    // ==================== START BOT ====================

    start() {
        console.log('🚀 Starting AI Digit Differ Bot v4.0...');
        console.log('   Kelly Criterion Risk Management Active\n');

        if (!this.token) {
            console.error('❌ Error: DERIV_TOKEN is required');
            process.exit(1);
        }

        process.on('uncaughtException', (error) => {
            console.error('Uncaught Exception:', error.message);
        });

        process.on('unhandledRejection', (reason) => {
            console.error('Unhandled Rejection:', reason);
        });

        this.connect();
    }
}

// ==================== STARTUP ====================

if (!process.env.DERIV_TOKEN) {
    console.error('❌ Error: DERIV_TOKEN is required in .env file');
    process.exit(1);
}

const bot = new AIDigitDifferBot({
    derivToken: process.env.DERIV_TOKEN,

    // Investment Capital (default $500)
    investmentCapital: parseFloat(process.env.INVESTMENT_CAPITAL) || 500,

    // Kelly Criterion Settings
    kellyFraction: parseFloat(process.env.KELLY_FRACTION) || 0.25, // Quarter Kelly (conservative)
    minStake: parseFloat(process.env.MIN_STAKE) || 0.35,
    maxStakePercent: parseFloat(process.env.MAX_STAKE_PERCENT) || 5, // Max 5% per trade

    // Risk Management
    maxDrawdownPercent: parseFloat(process.env.MAX_DRAWDOWN_PERCENT) || 25,
    dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT) || 50,
    dailyProfitTarget: parseFloat(process.env.DAILY_PROFIT_TARGET) || 100,
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES) || 6,

    // Trading Configuration
    minConfidence: parseInt(process.env.MIN_CONFIDENCE) || 70,
    minModelsAgreement: parseInt(process.env.MIN_MODELS_AGREEMENT) || 2,
    requiredHistoryLength: parseInt(process.env.REQUIRED_HISTORY_LENGTH) || 500,
    minWaitTime: parseInt(process.env.MIN_WAIT_TIME) || 15000,
    maxWaitTime: parseInt(process.env.MAX_WAIT_TIME) || 90000,

    // Assets
    assets: process.env.ASSETS ? process.env.ASSETS.split(',').map(a => a.trim()) : undefined
});

bot.start();
