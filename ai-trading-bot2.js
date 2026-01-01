/**
 * ============================================================
 * AI-POWERED DERIV DIGIT DIFFER TRADING BOT v4.0
 * Advanced Kelly Criterion & AI Risk Management System
 * ============================================================
 * 
 * NEW FEATURES:
 * - Complete Kelly Criterion implementation with fractional options
 * - AI-controlled stake management
 * - Dynamic recovery strategies
 * - Investment capital management ($500 starting capital)
 * - Drawdown protection and capital preservation
 * - Confidence-weighted position sizing
 * - Market regime-aware risk adjustment
 * 
 * ============================================================
 */
require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
// ============================================================
// KELLY CRITERION RISK MANAGER
// Implements proper Kelly with fractional variants
// ============================================================
class KellyRiskManager {
    constructor(config = {}) {
        // Capital Configuration
        this.initialCapital = config.initialCapital || 500;
        this.currentCapital = this.initialCapital;
        this.peakCapital = this.initialCapital;

        // Kelly Configuration
        this.kellyFraction = config.kellyFraction || 0.25; // Quarter Kelly default (safest)
        this.minKellyFraction = 0.1;  // Minimum 10% of Kelly
        this.maxKellyFraction = 0.5;  // Maximum 50% of Kelly

        // Risk Limits
        this.maxDrawdownPercent = config.maxDrawdownPercent || 20; // 20% max drawdown
        this.maxPositionPercent = config.maxPositionPercent || 5;  // 5% max per trade
        this.minPositionPercent = config.minPositionPercent || 0.5; // 0.5% min per trade
        this.dailyLossLimit = config.dailyLossLimit || 10; // 10% daily loss limit

        // Payout Configuration (Deriv Digit Differ typical payouts)
        this.basePayout = config.basePayout || 0.90; // 90% payout on win

        // Performance Tracking
        this.trades = [];
        this.dailyPnL = 0;
        this.sessionPnL = 0;
        this.maxDrawdown = 0;
        this.currentDrawdown = 0;

        // Recovery State
        this.inRecoveryMode = false;
        this.recoveryStartCapital = 0;
        this.consecutiveLosses = 0;
        this.consecutiveWins = 0;

        // Historical Win Rate Tracking
        this.windowSize = 50; // Rolling window for win rate calculation
        this.recentResults = []; // Array of booleans (true = win)

        console.log('\n📊 Kelly Risk Manager Initialized');
        console.log(`   Initial Capital: $${this.initialCapital}`);
        console.log(`   Kelly Fraction: ${(this.kellyFraction * 100).toFixed(0)}%`);
        console.log(`   Max Drawdown: ${this.maxDrawdownPercent}%`);
        console.log(`   Max Position: ${this.maxPositionPercent}%`);
    }

    /**
     * Core Kelly Criterion Formula
     * f* = (bp - q) / b
     * where:
     *   f* = optimal fraction of capital to bet
     *   b = net odds (payout ratio, e.g., 0.9 for 90% payout)
     *   p = probability of winning
     *   q = probability of losing (1 - p)
     */
    calculateKellyFraction(winProbability, payout = this.basePayout) {
        // Bound probability to reasonable range
        const p = Math.max(0.1, Math.min(0.9, winProbability));
        const q = 1 - p;
        const b = payout;

        // Kelly formula
        const fullKelly = (b * p - q) / b;

        // Return 0 if Kelly is negative (no edge)
        if (fullKelly <= 0) {
            return 0;
        }

        return fullKelly;
    }

    /**
     * Calculate optimal stake using Kelly Criterion
     * Incorporates multiple safety adjustments
     */
    calculateOptimalStake(params = {}) {
        const {
            winProbability = 0.5,
            confidence = 50,
            marketRegime = 'stable',
            volatility = 'medium',
            consecutiveLosses = 0,
            consecutiveWins = 0
        } = params;

        // Step 1: Calculate base Kelly fraction
        const fullKelly = this.calculateKellyFraction(winProbability);

        if (fullKelly <= 0) {
            console.log('   ⚠️ No edge detected - using minimum stake');
            return this.getMinimumStake();
        }

        // Step 2: Apply fractional Kelly (safety margin)
        let adjustedKelly = fullKelly * this.kellyFraction;

        // Step 3: Confidence-based adjustment
        // Lower confidence = lower stake
        const confidenceMultiplier = this.getConfidenceMultiplier(confidence);
        adjustedKelly *= confidenceMultiplier;

        // Step 4: Market regime adjustment
        const regimeMultiplier = this.getRegimeMultiplier(marketRegime);
        adjustedKelly *= regimeMultiplier;

        // Step 5: Volatility adjustment
        const volatilityMultiplier = this.getVolatilityMultiplier(volatility);
        adjustedKelly *= volatilityMultiplier;

        // Step 6: Consecutive loss adjustment (reduce after losses)
        const lossMultiplier = this.getLossAdjustmentMultiplier(consecutiveLosses);
        adjustedKelly *= lossMultiplier;

        // Step 7: Recovery mode adjustment
        if (this.inRecoveryMode) {
            adjustedKelly *= 0.5; // Halve stake in recovery mode
        }

        // Step 8: Drawdown protection
        const drawdownMultiplier = this.getDrawdownMultiplier();
        adjustedKelly *= drawdownMultiplier;

        // Step 9: Calculate actual stake amount
        let stake = this.currentCapital * adjustedKelly;

        // Step 10: Apply hard limits
        const minStake = this.currentCapital * (this.minPositionPercent / 100);
        const maxStake = this.currentCapital * (this.maxPositionPercent / 100);

        stake = Math.max(minStake, Math.min(stake, maxStake));

        // Ensure minimum tradeable amount
        stake = Math.max(0.35, stake);

        // Round to 2 decimal places
        stake = Math.round(stake * 100) / 100;

        // Log calculation details
        this.logStakeCalculation({
            fullKelly,
            adjustedKelly,
            confidenceMultiplier,
            regimeMultiplier,
            volatilityMultiplier,
            lossMultiplier,
            drawdownMultiplier,
            finalStake: stake
        });

        return stake;
    }

    /**
     * Confidence-based multiplier
     * Maps confidence (0-100) to stake multiplier (0.3-1.2)
     */
    getConfidenceMultiplier(confidence) {
        if (confidence >= 90) return 1.2;
        if (confidence >= 85) return 1.1;
        if (confidence >= 80) return 1.0;
        if (confidence >= 75) return 0.85;
        if (confidence >= 70) return 0.7;
        if (confidence >= 65) return 0.55;
        if (confidence >= 60) return 0.4;
        return 0.3;
    }

    /**
     * Market regime multiplier
     */
    getRegimeMultiplier(regime) {
        switch (regime) {
            case 'stable': return 1.0;
            case 'trending': return 0.8;
            case 'ranging': return 0.9;
            case 'volatile': return 0.5;
            case 'random': return 0.4;
            default: return 0.7;
        }
    }

    /**
     * Volatility multiplier
     */
    getVolatilityMultiplier(volatility) {
        switch (volatility) {
            case 'low': return 1.2;
            case 'medium': return 1.0;
            case 'high': return 0.6;
            case 'extreme': return 0.3;
            default: return 0.8;
        }
    }

    /**
     * Loss adjustment multiplier
     * Progressively reduce stake after consecutive losses
     */
    getLossAdjustmentMultiplier(consecutiveLosses) {
        if (consecutiveLosses === 0) return 1.0;
        if (consecutiveLosses === 1) return 0.8;
        if (consecutiveLosses === 2) return 0.6;
        if (consecutiveLosses === 3) return 0.4;
        if (consecutiveLosses === 4) return 0.3;
        return 0.2; // 5+ consecutive losses
    }

    /**
     * Drawdown protection multiplier
     * Reduces stake as drawdown increases
     */
    getDrawdownMultiplier() {
        const drawdownPercent = (this.currentDrawdown / this.peakCapital) * 100;

        if (drawdownPercent <= 5) return 1.0;
        if (drawdownPercent <= 10) return 0.8;
        if (drawdownPercent <= 15) return 0.6;
        if (drawdownPercent <= 20) return 0.4;
        return 0.2; // Severe drawdown
    }

    /**
     * Get minimum stake
     */
    getMinimumStake() {
        return Math.max(0.35, this.currentCapital * (this.minPositionPercent / 100));
    }

    /**
     * Update capital and performance metrics after trade
     */
    updateAfterTrade(result) {
        const { won, profit, stake } = result;

        // Update capital
        this.currentCapital += profit;
        this.sessionPnL += profit;
        this.dailyPnL += profit;

        // Update peak and drawdown
        if (this.currentCapital > this.peakCapital) {
            this.peakCapital = this.currentCapital;
            this.currentDrawdown = 0;
        } else {
            this.currentDrawdown = this.peakCapital - this.currentCapital;
            this.maxDrawdown = Math.max(this.maxDrawdown, this.currentDrawdown);
        }

        // Update win/loss streaks
        if (won) {
            this.consecutiveWins++;
            this.consecutiveLosses = 0;
        } else {
            this.consecutiveLosses++;
            this.consecutiveWins = 0;
        }

        // Update rolling win rate
        this.recentResults.push(won);
        if (this.recentResults.length > this.windowSize) {
            this.recentResults.shift();
        }

        // Track trade
        this.trades.push({
            timestamp: Date.now(),
            won,
            profit,
            stake,
            capitalAfter: this.currentCapital,
            drawdown: this.currentDrawdown
        });

        // Check/update recovery mode
        this.updateRecoveryMode();

        return {
            currentCapital: this.currentCapital,
            drawdownPercent: (this.currentDrawdown / this.peakCapital) * 100,
            inRecoveryMode: this.inRecoveryMode,
            rollingWinRate: this.getRollingWinRate()
        };
    }

    /**
     * Get rolling win rate from recent trades
     */
    getRollingWinRate() {
        if (this.recentResults.length === 0) return 0.5; // Default 50%
        const wins = this.recentResults.filter(r => r).length;
        return wins / this.recentResults.length;
    }

    /**
     * Update recovery mode status
     */
    updateRecoveryMode() {
        const drawdownPercent = (this.currentDrawdown / this.peakCapital) * 100;

        // Enter recovery mode if drawdown exceeds 10%
        if (!this.inRecoveryMode && drawdownPercent >= 10) {
            this.inRecoveryMode = true;
            this.recoveryStartCapital = this.currentCapital;
            console.log('\n🔄 ENTERING RECOVERY MODE');
            console.log(`   Drawdown: ${drawdownPercent.toFixed(1)}%`);
            console.log(`   Recovery Target: $${this.peakCapital.toFixed(2)}`);
        }

        // Exit recovery mode if we recover to 95% of peak
        if (this.inRecoveryMode && this.currentCapital >= this.peakCapital * 0.95) {
            this.inRecoveryMode = false;
            console.log('\n✅ EXITING RECOVERY MODE - Capital Recovered!');
        }
    }

    /**
     * Check if trading should be stopped
     */
    shouldStopTrading() {
        const reasons = [];

        // Max drawdown reached
        const drawdownPercent = (this.currentDrawdown / this.initialCapital) * 100;
        if (drawdownPercent >= this.maxDrawdownPercent) {
            reasons.push(`Max drawdown reached: ${drawdownPercent.toFixed(1)}%`);
        }

        // Daily loss limit
        const dailyLossPercent = Math.abs(Math.min(0, this.dailyPnL)) / this.initialCapital * 100;
        if (dailyLossPercent >= this.dailyLossLimit) {
            reasons.push(`Daily loss limit reached: ${dailyLossPercent.toFixed(1)}%`);
        }

        // Capital too low
        if (this.currentCapital < this.initialCapital * 0.5) {
            reasons.push(`Capital below 50%: $${this.currentCapital.toFixed(2)}`);
        }

        return {
            shouldStop: reasons.length > 0,
            reasons
        };
    }

    /**
     * Get current risk metrics
     */
    getRiskMetrics() {
        return {
            currentCapital: this.currentCapital,
            initialCapital: this.initialCapital,
            peakCapital: this.peakCapital,
            currentDrawdown: this.currentDrawdown,
            maxDrawdown: this.maxDrawdown,
            drawdownPercent: (this.currentDrawdown / this.peakCapital) * 100,
            sessionPnL: this.sessionPnL,
            sessionPnLPercent: (this.sessionPnL / this.initialCapital) * 100,
            dailyPnL: this.dailyPnL,
            rollingWinRate: this.getRollingWinRate(),
            consecutiveWins: this.consecutiveWins,
            consecutiveLosses: this.consecutiveLosses,
            inRecoveryMode: this.inRecoveryMode,
            totalTrades: this.trades.length
        };
    }

    /**
     * Log stake calculation details
     */
    logStakeCalculation(details) {
        console.log('\n📊 Kelly Stake Calculation:');
        console.log(`   Full Kelly: ${(details.fullKelly * 100).toFixed(2)}%`);
        console.log(`   Adjusted Kelly: ${(details.adjustedKelly * 100).toFixed(3)}%`);
        console.log(`   Confidence Mult: ${details.confidenceMultiplier.toFixed(2)}x`);
        console.log(`   Regime Mult: ${details.regimeMultiplier.toFixed(2)}x`);
        console.log(`   Volatility Mult: ${details.volatilityMultiplier.toFixed(2)}x`);
        console.log(`   Loss Adj Mult: ${details.lossMultiplier.toFixed(2)}x`);
        console.log(`   Drawdown Mult: ${details.drawdownMultiplier.toFixed(2)}x`);
        console.log(`   Final Stake: $${details.finalStake.toFixed(2)}`);
    }

    /**
     * Reset daily metrics (call at start of each day)
     */
    resetDailyMetrics() {
        this.dailyPnL = 0;
        console.log('📅 Daily metrics reset');
    }

    /**
     * Dynamically adjust Kelly fraction based on performance
     */
    adjustKellyFraction() {
        const winRate = this.getRollingWinRate();

        // If win rate is high and no recent losses, slightly increase Kelly
        if (winRate >= 0.6 && this.consecutiveLosses === 0) {
            this.kellyFraction = Math.min(this.maxKellyFraction, this.kellyFraction * 1.1);
        }
        // If win rate is low or consecutive losses, reduce Kelly
        else if (winRate < 0.45 || this.consecutiveLosses >= 2) {
            this.kellyFraction = Math.max(this.minKellyFraction, this.kellyFraction * 0.8);
        }

        console.log(`   Kelly Fraction adjusted to: ${(this.kellyFraction * 100).toFixed(1)}%`);
    }
}
// ============================================================
// AI RISK CONTROLLER
// AI-driven risk management decisions
// ============================================================
class AIRiskController {
    constructor(kellyManager) {
        this.kellyManager = kellyManager;
        this.riskHistory = [];
        this.marketConditions = {};
    }

    /**
     * Generate AI risk assessment prompt
     */
    generateRiskPrompt(marketData, performanceData) {
        return `You are an expert trading risk manager AI. Analyze the following data and provide risk management recommendations.
            === CURRENT PORTFOLIO STATE ===
            Initial Capital: $${this.kellyManager.initialCapital}
            Current Capital: $${this.kellyManager.currentCapital.toFixed(2)}
            Session P/L: $${this.kellyManager.sessionPnL.toFixed(2)} (${((this.kellyManager.sessionPnL / this.kellyManager.initialCapital) * 100).toFixed(1)}%)
            Current Drawdown: ${((this.kellyManager.currentDrawdown / this.kellyManager.peakCapital) * 100).toFixed(1)}%
            Max Drawdown: ${((this.kellyManager.maxDrawdown / this.kellyManager.peakCapital) * 100).toFixed(1)}%
            Recovery Mode: ${this.kellyManager.inRecoveryMode ? 'YES' : 'NO'}
            === PERFORMANCE METRICS ===
            Total Trades: ${this.kellyManager.trades.length}
            Rolling Win Rate: ${(this.kellyManager.getRollingWinRate() * 100).toFixed(1)}%
            Consecutive Wins: ${this.kellyManager.consecutiveWins}
            Consecutive Losses: ${this.kellyManager.consecutiveLosses}
            === MARKET DATA ===
            Asset: ${marketData.asset}
            Market Regime: ${marketData.regime}
            Volatility: ${marketData.volatility}
            Recent Digit Frequency: ${marketData.recentFrequency || 'N/A'}
            === AI PREDICTION ===
            Predicted Digit: ${marketData.predictedDigit}
            Confidence: ${marketData.confidence}%
            Models Agreeing: ${marketData.agreement}
            Based on this data, provide your risk management recommendation in the following JSON format:
            {
                "riskLevel": "low/medium/high/extreme",
                "shouldTrade": true/false,
                "recommendedKellyFraction": 0.1-0.5,
                "recommendedStakePercent": 0.5-5.0,
                "confidenceAdjustment": 0.5-1.5,
                "reasoning": "Brief explanation",
                "warnings": ["Any critical warnings"],
                "opportunityScore": 1-10
            }
            Focus on capital preservation while allowing calculated risks when the edge is clear.
        `;
    }

    /**
     * Get AI risk recommendation
     */
    async getAIRiskRecommendation(marketData, aiClient) {
        try {
            const prompt = this.generateRiskPrompt(marketData, this.kellyManager.getRiskMetrics());

            // Use one of the AI models to get risk assessment
            const response = await aiClient.getRiskAssessment(prompt);

            if (response && response.riskLevel) {
                this.riskHistory.push({
                    timestamp: Date.now(),
                    recommendation: response
                });
                return response;
            }
        } catch (error) {
            console.log(`   ⚠️ AI Risk Assessment failed: ${error.message}`);
        }

        // Fallback to rule-based assessment
        return this.getRuleBasedRiskAssessment(marketData);
    }

    /**
     * Rule-based risk assessment fallback
     */
    getRuleBasedRiskAssessment(marketData) {
        const metrics = this.kellyManager.getRiskMetrics();

        let riskLevel = 'medium';
        let shouldTrade = true;
        let recommendedKellyFraction = 0.25;
        const warnings = [];

        // Assess risk level
        if (metrics.drawdownPercent > 15) {
            riskLevel = 'high';
            recommendedKellyFraction = 0.1;
            console.log(`   ⚠️ High drawdown detected: ${metrics.drawdownPercent.toFixed(1)}%`);
            warnings.push('High drawdown - reduce position size');
        }

        if (metrics.consecutiveLosses >= 3) {
            riskLevel = 'high';
            recommendedKellyFraction = 0.1;
            warnings.push('Loss streak detected');
        }

        // if (marketData.confidence < 70) {
        //     riskLevel = 'high';
        //     recommendedKellyFraction = 0.15;
        //     console.log(`   ⚠️ Low prediction confidence detected: ${marketData.confidence.toFixed(1)}%`);
        //     warnings.push('Low prediction confidence');
        // }

        if (marketData.regime === 'volatile' || marketData.regime === 'random') {
            riskLevel = riskLevel === 'high' ? 'extreme' : 'high';
            recommendedKellyFraction *= 0.5;
            console.log(`   ⚠️ Unfavorable market conditions detected: ${marketData.regime}`);
            warnings.push('Unfavorable market conditions');
        }

        // Determine if should trade
        if (riskLevel === 'extreme' || metrics.drawdownPercent > 20) {
            shouldTrade = false;
            warnings.push('Trading paused due to extreme risk');
        }

        // Calculate opportunity score
        let opportunityScore = 5;
        if (marketData.confidence >= 85) opportunityScore += 2;
        if (marketData.agreement >= 3) opportunityScore += 2;
        if (metrics.rollingWinRate >= 0.55) opportunityScore += 1;
        if (riskLevel === 'high') opportunityScore -= 2;
        if (riskLevel === 'extreme') opportunityScore -= 4;

        opportunityScore = Math.max(1, Math.min(10, opportunityScore));

        return {
            riskLevel,
            shouldTrade,
            recommendedKellyFraction,
            recommendedStakePercent: recommendedKellyFraction * 10,
            confidenceAdjustment: riskLevel === 'low' ? 1.1 : riskLevel === 'high' ? 0.8 : 1.0,
            reasoning: `Risk level: ${riskLevel}. ${warnings.length} warning(s).`,
            warnings,
            opportunityScore
        };
    }
}
// ============================================================
// RECOVERY STRATEGY MANAGER
// Handles recovery after losses
// ============================================================
class RecoveryStrategyManager {
    constructor(kellyManager) {
        this.kellyManager = kellyManager;
        this.recoveryPhase = 0; // 0 = normal, 1-3 = recovery phases
        this.targetRecoveryTrades = 0;
        this.recoveryTradesCompleted = 0;
    }

    /**
     * Get recovery strategy parameters
     */
    getRecoveryStrategy() {
        const metrics = this.kellyManager.getRiskMetrics();
        const lossPercent = Math.abs(Math.min(0, metrics.sessionPnL)) / metrics.initialCapital * 100;

        // Phase 1: Minor loss (< 5%)
        if (lossPercent < 5) {
            return {
                phase: 1,
                strategy: 'conservative',
                kellyMultiplier: 0.8,
                minConfidence: 75,
                description: 'Conservative trading - slightly reduced stakes'
            };
        }

        // Phase 2: Moderate loss (5-10%)
        if (lossPercent < 10) {
            return {
                phase: 2,
                strategy: 'cautious',
                kellyMultiplier: 0.5,
                minConfidence: 80,
                description: 'Cautious trading - halved stakes, higher confidence required'
            };
        }

        // Phase 3: Significant loss (10-15%)
        if (lossPercent < 15) {
            return {
                phase: 3,
                strategy: 'defensive',
                kellyMultiplier: 0.3,
                minConfidence: 85,
                description: 'Defensive trading - minimal stakes, only high-confidence trades'
            };
        }

        // Phase 4: Severe loss (> 15%)
        return {
            phase: 4,
            strategy: 'preservation',
            kellyMultiplier: 0.2,
            minConfidence: 90,
            description: 'Capital preservation - minimum stakes, exceptional trades only'
        };
    }

    /**
     * Calculate recovery target
     */
    calculateRecoveryTarget() {
        const metrics = this.kellyManager.getRiskMetrics();
        const lossAmount = this.kellyManager.peakCapital - this.kellyManager.currentCapital;

        // Estimate trades needed to recover based on average win
        const avgWinRate = metrics.rollingWinRate || 0.5;
        const avgPayout = 0.9; // 90% typical payout
        const avgStakePercent = 2; // 2% average stake
        const avgWinAmount = this.kellyManager.currentCapital * (avgStakePercent / 100) * avgPayout;
        const avgLossAmount = this.kellyManager.currentCapital * (avgStakePercent / 100);

        // Expected profit per trade
        const expectedProfitPerTrade = (avgWinRate * avgWinAmount) - ((1 - avgWinRate) * avgLossAmount);

        if (expectedProfitPerTrade <= 0) {
            return { tradesNeeded: Infinity, confidence: 0 };
        }

        const tradesNeeded = Math.ceil(lossAmount / expectedProfitPerTrade);

        return {
            lossAmount,
            tradesNeeded,
            expectedProfitPerTrade,
            estimatedRecoveryTime: tradesNeeded * 2 // Assuming 2 minutes per trade
        };
    }
}
// ============================================================
// ENHANCED AI PROMPT GENERATOR
// ============================================================
class EnhancedAIPrompt {
    static generatePrompt(marketData, modelPerformance, riskMetrics) {
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
            ).join('\n')}
            `;
        }
        let riskSection = '';
        if (riskMetrics) {
            riskSection = `
            === CAPITAL & RISK STATUS ===
            Current Capital: $${riskMetrics.currentCapital.toFixed(2)}
            Session P/L: $${riskMetrics.sessionPnL.toFixed(2)} (${riskMetrics.sessionPnLPercent.toFixed(1)}%)
            Current Drawdown: ${riskMetrics.drawdownPercent.toFixed(1)}%
            Rolling Win Rate: ${(riskMetrics.rollingWinRate * 100).toFixed(1)}%
            Recovery Mode: ${riskMetrics.inRecoveryMode ? 'ACTIVE - Trade conservatively' : 'Normal'}
            Consecutive Losses: ${riskMetrics.consecutiveLosses}
            `;
        }
        return `You are an elite statistical arbitrage AI specializing in Deriv Digit Differ prediction with integrated risk management.
            === ADVERSARIAL REALITY ===
            The platform is an intelligent opponent that adapts to successful strategies.
            Your survival depends on:
            1. Statistical rigor over pattern chasing
            2. Continuous strategy evolution
            3. Regime-aware adaptation
            4. Capital preservation priority
            === CURRENT MARKET CONTEXT ===
            Asset: ${currentAsset}
            Market Regime: ${marketRegime || 'Detecting...'}
            Volatility Level: ${volatilityAssessment.level} (${volatilityAssessment.value.toFixed(3)})
            Last Prediction: ${lastPrediction || 'None'} → ${lastOutcome || 'N/A'}
            Consecutive Losses: ${consecutiveLosses}
            Recent Methods: ${recentMethods || 'None'}
            ${comprehensiveSection}
            ${riskSection}
            === FREQUENCY ANALYSIS (Last 500 Ticks) ===
            ${Array.isArray(freqStats) ? this.formatFrequencyStats(freqStats) : 'Calculating...'}
            Gap Analysis (Digits absent in last 25 ticks): ${Array.isArray(gapAnalysis) ? gapAnalysis.join(', ') : 'None'}
            Serial Correlation: ${serialCorrelation ? serialCorrelation.toFixed(4) : '0.0000'} (${Math.abs(serialCorrelation) > 0.1 ? 'Significant' : 'Negligible'})
            === PREDICTION PRINCIPLES ===
            Predict the digit that will NOT appear (Digit Differ).
            APPROVED METHODS:
            1. FREQUENCY DEVIATION ANALYSIS - Target underrepresented digits
            2. ENTROPY ANALYSIS - Identify non-random patterns
            3. REGIME-AWARE DETECTION - Adapt to market conditions
            4. VOLATILITY-ADJUSTED FORECASTING - Reduce confidence in uncertainty
            === RISK-ADJUSTED CONFIDENCE ===
            ${riskMetrics && riskMetrics.inRecoveryMode ?
                '⚠️ RECOVERY MODE ACTIVE: Only recommend trades with 85%+ confidence' :
                riskMetrics && riskMetrics.consecutiveLosses >= 2 ?
                    '⚠️ LOSS STREAK: Require 80%+ confidence for trade recommendation' :
                    'Normal operation: Standard confidence thresholds apply'}
            === OUTPUT FORMAT (STRICT JSON) ===
            {
                "predictedDigit": X,
                "confidence": XX,
                "primaryStrategy": "Strategy-Name",
                "marketRegime": "trending/ranging/volatile/stable/random",
                "riskAssessment": "low/medium/high",
                "statisticalEvidence": {
                    "frequencyAnalysis": { "digitFrequency": X.X%, "deviation": X.X%, "significance": "p=X.XXX" },
                    "gapAnalysis": { "absentForTicks": X, "maxHistoricalGap": X },
                    "sampleSize": XXX
                },
                "methodRationale": "Detailed reasoning",
                "alternativeCandidates": [X, Y, Z],
                "riskRecommendation": {
                    "suggestedStakePercent": X.X,
                    "capitalRiskLevel": "conservative/moderate/aggressive"
                },
                "skipRecommendation": "reason or null"
            }
            Generate prediction optimizing for capital growth while preserving the investment.
        `;
    }
    static calculateFrequencyStats(digits) {
        const counts = Array(10).fill(0);
        digits.forEach(d => counts[d]++);
        const total = digits.length;
        return counts.map((count, digit) => ({
            digit, count,
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
        if (tickHistory.length < 50) return { level: 'Unknown', value: 0 };
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
        let numerator = 0, denominator = 0;
        for (let i = 0; i < recent.length - 1; i++) {
            numerator += (recent[i] - mean) * (recent[i + 1] - mean);
            denominator += Math.pow(recent[i] - mean, 2);
        }
        return denominator > 0 ? numerator / denominator : 0;
    }
    static formatFrequencyStats(stats) {
        return stats
            .sort((a, b) => parseFloat(a.frequency) - parseFloat(b.frequency))
            .map(s => `Digit ${s.digit}: ${s.frequency}% (${s.count}/500) | Deviation: ${s.deviation}%`)
            .join('\n');
    }
}
// ============================================================
// MAIN TRADING BOT CLASS
// ============================================================
class AIDigitDifferBot {
    constructor(config = {}) {
        // Deriv Configuration
        this.token = config.derivToken || process.env.DERIV_TOKEN;
        // Investment Capital Configuration
        this.investmentCapital = config.investmentCapital || 500;

        // Initialize Kelly Risk Manager
        this.kellyManager = new KellyRiskManager({
            initialCapital: this.investmentCapital,
            kellyFraction: config.kellyFraction || 0.25,
            maxDrawdownPercent: config.maxDrawdownPercent || 20,
            maxPositionPercent: config.maxPositionPercent || 5,
            minPositionPercent: config.minPositionPercent || 0.5,
            dailyLossLimit: config.dailyLossLimit || 10,
            basePayout: config.basePayout || 0.90
        });

        // Initialize AI Risk Controller
        this.aiRiskController = new AIRiskController(this.kellyManager);

        // Initialize Recovery Strategy Manager
        this.recoveryManager = new RecoveryStrategyManager(this.kellyManager);
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
                key: (process.env.GROQ_API_KEY2 || '').trim(),
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
                key: (process.env.SAMBANOVA_API_KEY2 || '').trim(),
                enabled: false,
                name: 'SambaNova',
                weight: 1.0
            }
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
            baseStake: config.baseStake || 5,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
            stopLossPercent: config.stopLossPercent || 20,
            takeProfitPercent: config.takeProfitPercent || 50,
            requiredHistoryLength: config.requiredHistoryLength || 500,
            minConfidence: config.minConfidence || 75,
            minModelsAgreement: config.minModelsAgreement || 2,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            tradeCooldown: config.tradeCooldown || 5000,
            minWaitTime: config.minWaitTime || 15000,
            maxWaitTime: config.maxWaitTime || 90000,
        };
        // Trading State
        this.currentStake = 0; // Will be calculated by Kelly
        this.currentAsset = null;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.currentTradeId = null;
        this.tickSubscriptionId = null;
        this.tradingHistory = [];
        this.lastTradeResult = null;
        // Statistics
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.totalPnL = 0;
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
        this.winningPatterns = new Map();
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
        this.telegramToken = process.env.TELEGRAM_BOT_TOKENb;
        this.telegramChatId = process.env.TELEGRAM_CHAT_ID;
        this.telegramEnabled = !!(this.telegramToken && this.telegramChatId);
        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
        }
        this.sessionStartTime = new Date();
        console.log('\n' + '='.repeat(60));
        console.log('🤖 AI DIGIT DIFFER TRADING BOT v4.0');
        console.log('   With Kelly Criterion Risk Management');
        console.log('='.repeat(60));
        console.log(`💰 Investment Capital: $${this.investmentCapital}`);
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
        if (this.isShuttingDown) return;
        if (this.connected) return;
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
            this.ws.on('close', (code, reason) => {
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
        console.log('\n🛑 Bot shutting down...');
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
            case 'forget':
                this.tickSubscriptionId = null;
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
        this.balance = this.kellyManager.investmentCapital; //message.authorize.balance;
        // this.sessionStartBalance = this.balance;

        // Sync Kelly manager with actual balance
        // this.kellyManager.currentCapital = this.balance;
        // this.kellyManager.initialCapital = this.investmentCapital;

        console.log(`💰 Account Balance: $${message.authorize.balance.toFixed(2)}`);
        console.log(`📊 Investment Capital: $${this.investmentCapital}`);
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
            this.scheduleNextTrade();
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
        console.error('❌ API Error:', error.message);
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
        console.log(`💰 Starting Capital: $${this.kellyManager.currentCapital.toFixed(2)}`);
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
        if (!history || !history.prices) return;
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
        console.log(`📍 Last 5: ${this.tickHistory.slice(-5).join(', ')} | Total: ${this.tickHistory.length}`);
        if (this.tickHistory.length >= this.config.requiredHistoryLength &&
            !this.tradeInProgress && !this.predictionInProgress) {
            this.analyzeTicks();
        }
    }
    // ==================== AI PREDICTION & RISK MANAGEMENT ====================
    async analyzeTicks() {
        if (this.tradeInProgress || this.predictionInProgress) return;
        this.predictionInProgress = true;
        console.log('\n🧠 Starting AI ensemble prediction with risk analysis...');
        // Check if we should stop trading
        const stopCheck = this.kellyManager.shouldStopTrading();
        if (stopCheck.shouldStop) {
            console.log('\n🛑 TRADING STOPPED:');
            stopCheck.reasons.forEach(r => console.log(`   - ${r}`));
            this.shutdown();
            return;
        }
        const startTime = Date.now();
        try {
            const predictions = await this.getEnsemblePredictions();
            const processingTime = (Date.now() - startTime) / 1000;
            console.log(`⏱️ AI processing time: ${processingTime.toFixed(2)}s`);
            if (predictions.length === 0) {
                console.log('⚠️ No valid predictions');
                this.predictionInProgress = false;
                this.scheduleNextTrade();
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
            // Get AI risk assessment
            const marketData = {
                asset: this.currentAsset,
                regime: ensemble.regime || this.detectMarketRegime(this.tickHistory),
                volatility: this.getVolatilityLevel(this.tickHistory),
                predictedDigit: ensemble.digit,
                confidence: ensemble.confidence,
                agreement: ensemble.agreement
            };
            const riskAssessment = this.aiRiskController.getRuleBasedRiskAssessment(marketData);

            console.log('\n📊 Risk Assessment:');
            console.log(`   Risk Level: ${riskAssessment.riskLevel}`);
            console.log(`   Should Trade: ${riskAssessment.shouldTrade}`);
            console.log(`   Opportunity Score: ${riskAssessment.opportunityScore}/10`);
            if (riskAssessment.warnings.length > 0) {
                console.log(`   Warnings: ${riskAssessment.warnings.join(', ')}`);
            }
            // Get recovery strategy if in recovery mode
            const recoveryStrategy = this.recoveryManager.getRecoveryStrategy();
            let effectiveMinConfidence = this.config.minConfidence;

            if (recoveryStrategy.phase > 1) {
                console.log(`\n🔄 Recovery Phase ${recoveryStrategy.phase}: ${recoveryStrategy.description}`);
                effectiveMinConfidence = recoveryStrategy.minConfidence;
            }
            // Decision to trade
            const tradeDecision = this.shouldExecuteTrade(
                ensemble,
                riskAssessment,
                recoveryStrategy,
                effectiveMinConfidence,
                processingTime
            );
            if (tradeDecision.execute) {
                // Calculate optimal stake using Kelly Criterion
                const winProbability = this.estimateWinProbability(ensemble);
                const optimalStake = this.kellyManager.calculateOptimalStake({
                    winProbability,
                    confidence: ensemble.confidence,
                    marketRegime: marketData.regime,
                    volatility: marketData.volatility,
                    consecutiveLosses: this.consecutiveLosses,
                    consecutiveWins: this.kellyManager.consecutiveWins
                });
                // Apply recovery multiplier if needed
                const finalStake = optimalStake * (recoveryStrategy.kellyMultiplier || 1);

                this.placeTrade(ensemble.digit, ensemble.confidence, finalStake);
            } else {
                console.log(`\n⏭️ Skipping trade: ${tradeDecision.reason}`);
                this.predictionInProgress = false;
                this.scheduleNextTrade();
            }
        } catch (error) {
            console.error('❌ Analysis error:', error.message);
            this.predictionInProgress = false;
            this.scheduleNextTrade();
        }
    }
    /**
     * Estimate win probability based on ensemble prediction
     */
    estimateWinProbability(ensemble) {
        // Base probability for differ trade (any 9 of 10 digits)
        let baseProbability = 0.9;

        // Adjust based on confidence
        const confidenceBonus = (ensemble.confidence - 50) / 100 * 0.1;

        // Adjust based on model agreement
        const agreementBonus = (ensemble.agreement - 1) * 0.02;

        // Adjust based on risk level
        const riskPenalty = ensemble.risk === 'high' ? 0.1 : ensemble.risk === 'medium' ? 0.05 : 0;

        // Calculate final probability
        let probability = baseProbability + confidenceBonus + agreementBonus - riskPenalty;

        // Bound between 0.3 and 0.95
        return Math.max(0.3, Math.min(0.95, probability));
    }
    /**
     * Get volatility level string
     */
    getVolatilityLevel(tickHistory) {
        if (tickHistory.length < 50) return 'medium';
        const volatility = this.calculateVolatility(tickHistory.slice(-50));
        if (volatility < 2) return 'low';
        if (volatility < 3) return 'medium';
        if (volatility < 4) return 'high';
        return 'extreme';
    }
    shouldExecuteTrade(ensemble, riskAssessment, recoveryStrategy, minConfidence, processingTime) {
        const reasons = [];
        let execute = true;
        // Risk controller says no
        if (!riskAssessment.shouldTrade) {
            execute = false;
            reasons.push('Risk assessment recommends skip');
        }
        // Confidence too low
        // if (ensemble.confidence < minConfidence) {
        //     execute = false;
        //     reasons.push(`Confidence ${ensemble.confidence}% < ${minConfidence}%`);
        // }
        // Processing too slow
        if (processingTime > 3) {
            execute = false;
            reasons.push(`Processing time ${processingTime.toFixed(2)}s too slow`);
        }
        // Model agreement too low
        if (ensemble.agreement < this.config.minModelsAgreement) {
            execute = false;
            reasons.push(`Agreement ${ensemble.agreement} < ${this.config.minModelsAgreement}`);
        }
        // Risk level too high
        // if (riskAssessment.riskLevel === 'extreme') {
        //     execute = false;
        //     reasons.push('Extreme risk level');
        // }
        // Opportunity score too low
        if (riskAssessment.opportunityScore < 4) {
            execute = false;
            reasons.push(`Opportunity score ${riskAssessment.opportunityScore}/10 too low`);
        }
        // Don't predict digit that just appeared
        if (ensemble.digit === this.tickHistory[this.tickHistory.length - 1]) {
            execute = false;
            reasons.push('Predicted digit just appeared');
        }
        return {
            execute,
            reason: execute ? 'All checks passed' : reasons.join(' | ')
        };
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
        ]).catch(e => {
            console.log(`⚠️ Prediction timeout: ${e.message}`);
            return [];
        });
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
        let strategy = null;
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
            if (pred.primaryStrategy && !strategy) strategy = pred.primaryStrategy;
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
            strategy
        };
    }

    // ==================== STATISTICAL ANALYSIS ====================
    performComprehensiveAnalysis(tickHistory, minSampleSize = 100) {
        if (tickHistory.length < minSampleSize) {
            return { error: 'Insufficient data' };
        }
        const sample = tickHistory.slice(-minSampleSize);
        return {
            frequencyAnalysis: this.analyzeDigitFrequency(sample),
            gapAnalysis: this.analyzeDigitGaps(sample),
            serialCorrelation: this.calculateSerialCorrelation(sample),
            entropy: this.calculateEntropy(sample),
            uniformityTest: this.performChiSquareTest(sample),
            volatility: this.calculateVolatility(sample),
            regime: this.detectMarketRegime(sample),
            sampleSize: sample.length
        };
    }
    analyzeDigitFrequency(digits) {
        const counts = Array(10).fill(0);
        digits.forEach(d => counts[d]++);
        const total = digits.length;
        return counts.map((count, digit) => ({
            digit, count,
            frequency: count / total,
            deviation: (count / total - 0.1) * 100,
            zScore: (count / total - 0.1) / Math.sqrt(0.1 * 0.9 / total)
        }));
    }
    analyzeDigitGaps(digits) {
        if (digits.length < 25) return { gaps: [], maxGap: 0, absentDigits: [] };
        const last25 = new Set(digits.slice(-25));
        const gaps = [];
        for (let i = 0; i < 10; i++) {
            if (!last25.has(i)) {
                let gapLength = 0;
                for (let j = digits.length - 1; j >= 0; j--) {
                    if (digits[j] === i) break;
                    gapLength++;
                }
                gaps.push({ digit: i, gapLength });
            }
        }
        return {
            gaps: gaps.sort((a, b) => b.gapLength - a.gapLength),
            maxGap: gaps.length > 0 ? Math.max(...gaps.map(g => g.gapLength)) : 0,
            absentDigits: gaps.map(g => g.digit)
        };
    }
    performChiSquareTest(digits) {
        if (digits.length < 100) {
            return { chiSquare: 0, pValue: 1, isUniform: true };
        }
        const counts = Array(10).fill(0);
        digits.forEach(d => counts[d]++);
        const expected = digits.length / 10;
        let chiSquare = 0;
        for (const count of counts) {
            chiSquare += Math.pow(count - expected, 2) / expected;
        }
        const criticalValue = 16.919;
        const isUniform = chiSquare < criticalValue;
        return {
            chiSquare: chiSquare.toFixed(3),
            pValue: isUniform ? '> 0.05' : '< 0.05',
            isUniform,
            interpretation: isUniform ? 'Uniform (random)' : 'Non-uniform (pattern)'
        };
    }
    calculateSerialCorrelation(digits) {
        if (digits.length < 50) return 0;
        const recent = digits.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        let numerator = 0, denominator = 0;
        for (let i = 0; i < recent.length - 1; i++) {
            numerator += (recent[i] - mean) * (recent[i + 1] - mean);
            denominator += Math.pow(recent[i] - mean, 2);
        }
        return denominator > 0 ? numerator / denominator : 0;
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
    detectMarketRegime(tickHistory) {
        if (tickHistory.length < 100) return 'insufficient_data';
        const recent = tickHistory.slice(-100);
        const volatility = this.calculateVolatility(recent);
        const entropy = this.calculateEntropy(recent);

        if (volatility > 2.5) return 'volatile';
        if (entropy > 0.95) return 'random';
        if (volatility < 1.5) return 'stable';
        return 'ranging';
    }
    // ==================== PROMPT & AI MODELS ====================
    getPrompt(modelName = 'unknown') {
        const modelStats = this.modelPerformance[modelName] || {};
        const recentMethods = this.tradeMethod.slice(-5).join(', ');
        const marketRegime = this.detectMarketRegime(this.tickHistory);
        const volatility = this.calculateVolatility(this.tickHistory);
        const comprehensiveAnalysis = this.tickHistory.length >= 100
            ? this.performComprehensiveAnalysis(this.tickHistory, 100)
            : null;
        const marketData = {
            currentAsset: this.currentAsset,
            tickHistory: this.tickHistory,
            lastPrediction: modelStats.lastPrediction,
            lastOutcome: modelStats.lastOutcome,
            consecutiveLosses: this.consecutiveLosses,
            recentMethods,
            volatility,
            marketRegime,
            comprehensiveAnalysis
        };
        const riskMetrics = this.kellyManager.getRiskMetrics();
        return EnhancedAIPrompt.generatePrompt(marketData, this.modelPerformance, riskMetrics);
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
                    responseMimeType: "application/json"
                }
            },
            { timeout: 30000 }
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
                    { role: 'system', content: 'You are a trading bot. Output only valid JSON.' },
                    { role: 'user', content: this.getPrompt('groq') }
                ],
                temperature: 0.1,
                max_tokens: 512,
                response_format: { type: "json_object" }
            },
            {
                headers: { 'Authorization': `Bearer ${key}` },
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
                    { role: 'system', content: 'You are a trading bot. Output only valid JSON.' },
                    { role: 'user', content: this.getPrompt('openrouter') }
                ],
                temperature: 0.1,
                max_tokens: 512
            },
            {
                headers: {
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
                    { role: 'system', content: 'You are a trading bot. Output only valid JSON.' },
                    { role: 'user', content: this.getPrompt('mistral') }
                ],
                temperature: 0.1,
                max_tokens: 512
            },
            {
                headers: { 'Authorization': `Bearer ${key}` },
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
                    { role: 'system', content: 'You are a trading bot. Output only valid JSON.' },
                    { role: 'user', content: this.getPrompt('cerebras') }
                ],
                temperature: 0.1,
                max_tokens: 512
            },
            {
                headers: { 'Authorization': `Bearer ${key}` },
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
            'https://api.groq.com/openai/v1/chat/completions',
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
        const last100 = this.tickHistory.slice(-100);
        const last50 = this.tickHistory.slice(-50);
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
        this.currentStake = stake;
        console.log(`\n💰 PLACING TRADE`);
        console.log(`   Asset: ${this.currentAsset}`);
        console.log(`   Digit: ${digit} (DIFFER)`);
        console.log(`   Stake: $${stake.toFixed(2)}`);
        console.log(`   Confidence: ${confidence}%`);
        console.log(`   Capital: $${this.kellyManager.currentCapital.toFixed(2)}`);
        console.log(`   Position Size: ${((stake / this.kellyManager.currentCapital) * 100).toFixed(2)}%`);
        this.sendRequest({
            buy: 1,
            price: stake.toFixed(2),
            parameters: {
                amount: stake.toFixed(2),
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: this.currentAsset,
                barrier: digit
            }
        });
        this.currentPrediction = { digit, confidence };
    }
    handleTradeResult(contract) {
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const exitSpot = contract.exit_tick_display_value;
        const actualDigit = this.getLastDigit(exitSpot, this.currentAsset);
        console.log('\n' + '='.repeat(50));
        console.log(won ? '🎉 TRADE WON!' : '😔 TRADE LOST');
        console.log(`   Predicted: ${this.lastPrediction} | Actual: ${actualDigit}`);
        console.log(`   Profit: ${won ? '+' : ''}$${profit.toFixed(2)}`);
        console.log('='.repeat(50));
        // Update statistics
        this.totalTrades++;
        this.totalPnL += profit;
        // Update Kelly Manager
        const kellyResult = this.kellyManager.updateAfterTrade({
            won,
            profit,
            stake: this.currentStake
        });
        console.log('\n📊 Post-Trade Risk Metrics:');
        console.log(`   Capital: $${kellyResult.currentCapital.toFixed(2)}`);
        console.log(`   Drawdown: ${kellyResult.drawdownPercent.toFixed(1)}%`);
        console.log(`   Rolling Win Rate: ${(kellyResult.rollingWinRate * 100).toFixed(1)}%`);
        if (kellyResult.inRecoveryMode) {
            console.log(`   ⚠️ RECOVERY MODE ACTIVE`);
        }
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
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;
        }
        // Dynamically adjust Kelly fraction based on performance
        this.kellyManager.adjustKellyFraction();

        this.balance = this.kellyManager.currentCapital;

        // Track trade
        this.tradingHistory.push({
            timestamp: Date.now(),
            asset: this.currentAsset,
            predicted: this.lastPrediction,
            actual: actualDigit,
            result: won ? 'won' : 'lost',
            profit,
            stake: this.currentStake,
            confidence: this.lastConfidence,
            capitalAfter: this.kellyManager.currentCapital
        });
        // Send loss notification
        if (!won && this.telegramEnabled) {
            this.sendTelegramLossAlert(actualDigit, profit);
        }
        this.logTradingSummary();
        // Check stop conditions
        if (this.checkStopConditions()) {
            return;
        }
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.scheduleNextTrade2();
    }
    checkStopConditions() {
        // Use Kelly manager's stop check
        const stopCheck = this.kellyManager.shouldStopTrading();
        if (stopCheck.shouldStop) {
            console.log('\n🛑 STOP CONDITIONS MET:');
            stopCheck.reasons.forEach(r => console.log(`   - ${r}`));
            this.shutdown();
            return true;
        }
        // Take profit check
        const profitPercent = (this.kellyManager.sessionPnL / this.kellyManager.initialCapital) * 100;
        if (profitPercent >= this.config.takeProfitPercent) {
            console.log(`\n🎉 TAKE PROFIT REACHED: ${profitPercent.toFixed(1)}%`);
            this.shutdown();
            return true;
        }
        // Consecutive losses check
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log(`\n🛑 MAX CONSECUTIVE LOSSES: ${this.consecutiveLosses}`);
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
            Math.random() * (30000 - 15000) +
            15000
        );

        console.log(`\n⏳ Next trade in ${Math.round(waitTime / 1000)}s...`);
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
            Math.random() * (this.config.maxWaitTime - this.config.minWaitTime) +
            this.config.minWaitTime
        );

        console.log(`\n⏳ Next trade in ${Math.round(waitTime / 1000)}s...`);
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
        const metrics = this.kellyManager.getRiskMetrics();
        console.log('\n📊 Session Summary:');
        console.log(`   Trades: ${this.totalTrades} (W: ${this.totalWins} / L: ${this.totalLosses})`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Session P/L: $${metrics.sessionPnL.toFixed(2)} (${metrics.sessionPnLPercent.toFixed(1)}%)`);
        console.log(`   Capital: $${metrics.currentCapital.toFixed(2)}`);
        console.log(`   Drawdown: ${metrics.drawdownPercent.toFixed(1)}% (Max: ${((metrics.maxDrawdown / metrics.peakCapital) * 100).toFixed(1)}%)`);
        console.log(`   Consecutive Losses: ${this.consecutiveLosses}`);
    }
    logFinalSummary() {
        const duration = this.getSessionDuration();
        const metrics = this.kellyManager.getRiskMetrics();
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;
        console.log('\n' + '='.repeat(60));
        console.log('📊 FINAL TRADING SESSION SUMMARY');
        console.log('='.repeat(60));
        console.log(`   Duration: ${duration}`);
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins: ${this.totalWins} | Losses: ${this.totalLosses}`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Initial Capital: $${this.kellyManager.initialCapital.toFixed(2)}`);
        console.log(`   Final Capital: $${metrics.currentCapital.toFixed(2)}`);
        console.log(`   Session P/L: $${metrics.sessionPnL.toFixed(2)} (${metrics.sessionPnLPercent.toFixed(1)}%)`);
        console.log(`   Peak Capital: $${metrics.peakCapital.toFixed(2)}`);
        console.log(`   Max Drawdown: ${((metrics.maxDrawdown / metrics.peakCapital) * 100).toFixed(1)}%`);
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
        const metrics = this.kellyManager.getRiskMetrics();
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;
        return `<b>📊 Trading Session Summary</b>
        ━━━━━━━━━━━━━━━━━━━━━━━━
        📈 <b>Trades:</b> ${this.totalTrades}
        ✅ <b>Wins:</b> ${this.totalWins}
        ❌ <b>Losses:</b> ${this.totalLosses}
        📊 <b>Win Rate:</b> ${winRate}%
        💰 <b>Initial Capital:</b> $${this.kellyManager.initialCapital.toFixed(2)}
        💵 <b>Final Capital:</b> $${metrics.currentCapital.toFixed(2)}
        📈 <b>Session P/L:</b> $${metrics.sessionPnL.toFixed(2)} (${metrics.sessionPnLPercent.toFixed(1)}%)
        📉 <b>Max Drawdown:</b> ${((metrics.maxDrawdown / metrics.peakCapital) * 100).toFixed(1)}%
        <b>Consecutive Loss Streaks:</b>
        x2: ${this.consecutiveLosses2} | x3: ${this.consecutiveLosses3} | x4: ${this.consecutiveLosses4} | x5: ${this.consecutiveLosses5}`;
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
                this.sendTelegramMessage(`📊 <b>Periodic Update</b>\n\n${this.getTelegramSummary()}`);
            }
        }, 30 * 60 * 1000);
    }
    async sendTelegramLossAlert(actualDigit, profit) {
        const metrics = this.kellyManager.getRiskMetrics();

        let riskWarning = '';
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses - 1) {
            riskWarning = `\n⚠️ <b>CRITICAL:</b> ${this.consecutiveLosses} consecutive losses!`;
        }
        const body = `🚨 <b>TRADE LOSS</b>
            ━━━━━━━━━━━━━━━━━━━━━━━━
            <b>Asset:</b> <code>${this.currentAsset}</code>
            <b>Predicted:</b> ${this.lastPrediction} | <b>Actual:</b> ${actualDigit}
            <b>Loss:</b> -$${Math.abs(profit).toFixed(2)}
            <b>Stake:</b> $${this.currentStake.toFixed(2)}
            <b>Capital:</b> $${metrics.currentCapital.toFixed(2)}
            <b>Drawdown:</b> ${metrics.drawdownPercent.toFixed(1)}%
            <b>Recovery Mode:</b> ${metrics.inRecoveryMode ? 'ACTIVE' : 'No'}${riskWarning}`;
        await this.sendTelegramMessage(body);
    }
    // ==================== START ====================
    start() {
        console.log('🚀 Starting AI Digit Differ Trading Bot v4.0...\n');
        console.log('💡 Kelly Criterion Risk Management ENABLED');
        console.log(`💰 Investment Capital: $${this.investmentCapital}\n`);
        if (!this.token) {
            console.error('❌ Error: DERIV_TOKEN is required');
            process.exit(1);
        }
        process.on('uncaughtException', (error) => {
            console.error('Uncaught Exception:', error.message);
        });
        process.on('unhandledRejection', (reason, promise) => {
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
    investmentCapital: parseFloat(process.env.INVESTMENT_CAPITAL) || 500,
    kellyFraction: parseFloat(process.env.KELLY_FRACTION) || 0.25,
    maxDrawdownPercent: parseFloat(process.env.MAX_DRAWDOWN_PERCENT) || 20,
    maxPositionPercent: parseFloat(process.env.MAX_POSITION_PERCENT) || 5,
    minPositionPercent: parseFloat(process.env.MIN_POSITION_PERCENT) || 0.5,
    dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT) || 10,
    basePayout: parseFloat(process.env.BASE_PAYOUT) || 0.90,
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES) || 5,
    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT) || 20,
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) || 50,
    minConfidence: parseInt(process.env.MIN_CONFIDENCE) || 75,
    minModelsAgreement: parseInt(process.env.MIN_MODELS_AGREEMENT) || 2,
    requiredHistoryLength: parseInt(process.env.REQUIRED_HISTORY_LENGTH) || 500,
    minWaitTime: parseInt(process.env.MIN_WAIT_TIME) || 15000,
    maxWaitTime: parseInt(process.env.MAX_WAIT_TIME) || 90000,
    assets: process.env.ASSETS ? process.env.ASSETS.split(',').map(a => a.trim()) : undefined
});
bot.start();

