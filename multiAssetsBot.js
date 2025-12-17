#!/usr/bin/env node

/**
 * Deriv.com Multi-Asset AI Trading Bot - Light Version
 * No TensorFlow dependency - uses rule-based AI instead
 * 
 * Features:
 * - Dynamic top-2 asset selection every 5 minutes
 * - Per-asset EMA/RSI strategies
 * - Kelly Criterion stake allocation
 * - Portfolio-wide & per-asset risk controls
 * - Correlation blocking
 * - State persistence
 * - Email notifications
 */

const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const fs = require('fs');

// ==================== LOGGING HELPER ====================

function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const prefix = {
        'INFO': '📋',
        'TRADE': '💰',
        'SIGNAL': '📊',
        'SUCCESS': '✅',
        'ERROR': '❌',
        'WARNING': '⚠️',
        'RISK': '🛡️',
        'EMAIL': '📧'
    }[level] || '•';

    const logMessage = `[${timestamp}] ${prefix} [${level}] ${message}`;
    console.log(logMessage);

    if (data) {
        console.log(`    └─ ${JSON.stringify(data)}`);
    }

    return logMessage;
}

// ==================== CONFIGURATION ====================

const CONFIG = {
    // API Configuration
    appId: 1089,
    apiToken: 'Dz2V2KvRf4Uukt3',
    websocketUrl: 'wss://ws.binaryws.com/websockets/v3',

    // Email Configuration
    email: {
        service: 'gmail',
        user: 'kenzkdp2@gmail.com',
        password: 'jfjhtmussgfpbgpk',
        recipient: 'kenotaru@gmail.com',
        summaryInterval: 1800000 // 30 minutes
    },

    // Trading Configuration
    initialCapital: 500,
    maxDailyLossPercent: 5,
    dailyProfitTargetPercent: 2.5,
    maxRiskPerTradePercent: 2,
    maxOpenPositions: 5,

    // Asset Universe Configuration
    assets: {
        // Synthetic Indices
        'R_10': {
            type: 'synthetic',
            emaShort: 8,
            emaLong: 21,
            rsiPeriod: 14,
            rsiThreshold: 35,
            duration: 15,
            durationUnit: 'm',
            maxDailyTrades: 2,
            granularity: 60,
            correlationGroup: 'volatility'
        },
        'R_25': {
            type: 'synthetic',
            emaShort: 10,
            emaLong: 25,
            rsiPeriod: 14,
            rsiThreshold: 35,
            duration: 20,
            durationUnit: 'm',
            maxDailyTrades: 2,
            granularity: 60,
            correlationGroup: 'volatility'
        },
        'R_75': {
            type: 'synthetic',
            emaShort: 12,
            emaLong: 30,
            rsiPeriod: 21,
            rsiThreshold: 40,
            duration: 30,
            durationUnit: 'm',
            maxDailyTrades: 1,
            granularity: 60,
            correlationGroup: 'volatility_high'
        },
        'BOOM1000': {
            type: 'synthetic',
            emaShort: 5,
            emaLong: 15,
            rsiPeriod: 7,
            rsiThreshold: 30,
            duration: 5,
            durationUnit: 'm',
            maxDailyTrades: 3,
            granularity: 60,
            correlationGroup: 'boom_crash'
        },
        'CRASH1000': {
            type: 'synthetic',
            emaShort: 5,
            emaLong: 15,
            rsiPeriod: 7,
            rsiThreshold: 30,
            duration: 5,
            durationUnit: 'm',
            maxDailyTrades: 3,
            granularity: 60,
            correlationGroup: 'boom_crash'
        },
        // Major Forex
        'frxEURUSD': {
            type: 'forex',
            emaShort: 10,
            emaLong: 25,
            rsiPeriod: 14,
            rsiThreshold: 35,
            duration: 4,
            durationUnit: 'h',
            maxDailyTrades: 1,
            granularity: 300,
            correlationGroup: 'eur_usd'
        },
        'frxGBPUSD': {
            type: 'forex',
            emaShort: 10,
            emaLong: 25,
            rsiPeriod: 14,
            rsiThreshold: 35,
            duration: 4,
            durationUnit: 'h',
            maxDailyTrades: 1,
            granularity: 300,
            correlationGroup: 'gbp_usd'
        },
        'frxUSDJPY': {
            type: 'forex',
            emaShort: 10,
            emaLong: 25,
            rsiPeriod: 14,
            rsiThreshold: 35,
            duration: 4,
            durationUnit: 'h',
            maxDailyTrades: 1,
            granularity: 300,
            correlationGroup: 'usd_jpy'
        },
        // Commodities
        'frxXAUUSD': {
            type: 'commodity',
            emaShort: 15,
            emaLong: 35,
            rsiPeriod: 14,
            rsiThreshold: 35,
            duration: 1,
            durationUnit: 'h',
            maxDailyTrades: 2,
            granularity: 300,
            correlationGroup: 'commodities'
        }
    },

    // AI and Scoring Configuration
    aiConfidenceThreshold: 0.60,
    assetScoringInterval: 300000, // 5 minutes
    portfolioRebalanceInterval: 14400000, // 4 hours
    maxCandleHistory: 200,

    // Scoring Weights
    scoringWeights: {
        recentWinRate: 0.30,
        trendStrength: 0.25,
        volatilityFit: 0.20,
        predictability: 0.25
    }
};

// ==================== EMAIL MANAGER ====================

class EmailManager {
    constructor(config) {
        this.config = config;
        this.transporter = nodemailer.createTransport({
            service: config.service,
            auth: {
                user: config.user,
                pass: config.password
            }
        });
        this.lastSummaryTime = Date.now();
    }

    async sendEmail(subject, text) {
        try {
            await this.transporter.sendMail({
                from: this.config.user,
                to: this.config.recipient,
                subject: `[Multi-Asset Bot] ${subject}`,
                text: text
            });
            log('EMAIL', `Sent: ${subject}`);
        } catch (error) {
            log('ERROR', `Email failed: ${error.message}`);
        }
    }

    async sendStartupEmail(state) {
        const text = `
🚀 MULTI-ASSET BOT STARTED
========================================

Time: ${new Date().toLocaleString()}
Capital: $${state.capital.toFixed(2)}
Assets Monitored: ${Object.keys(CONFIG.assets).length}
Strategy: EMA Crossover + RSI + AI Confidence

Configuration:
- Max Daily Loss: ${CONFIG.maxDailyLossPercent}%
- Profit Target: ${CONFIG.dailyProfitTargetPercent}%
- Max Positions: ${CONFIG.maxOpenPositions}
- AI Threshold: ${CONFIG.aiConfidenceThreshold * 100}%

Bot is now running and monitoring for signals.
        `;
        await this.sendEmail('Bot Started', text);
    }

    async sendTradeEmail(type, trade, state) {
        const text = `
${type === 'OPEN' ? '🎯 TRADE OPENED' : type === 'WIN' ? '✅ TRADE WON' : '❌ TRADE LOST'}
========================================

Asset: ${trade.symbol}
Direction: ${trade.signal}
Stake: $${trade.stake?.toFixed(2) || trade.amount?.toFixed(2)}
${type !== 'OPEN' ? `Profit: $${trade.profit?.toFixed(2) || 0}` : ''}

Portfolio Status:
- Capital: $${state.capital.toFixed(2)}
- Daily P/L: $${(state.portfolio.dailyProfit - state.portfolio.dailyLoss).toFixed(2)}
- Active Positions: ${state.portfolio.activePositions.length}
- Daily Trades: ${state.portfolio.dailyTrades}
        `;
        await this.sendEmail(`${type}: ${trade.symbol} ${trade.signal}`, text);
    }

    async sendSummaryEmail(state) {
        const now = Date.now();
        if (now - this.lastSummaryTime < CONFIG.email.summaryInterval) return;
        this.lastSummaryTime = now;

        const winRate = state.portfolio.dailyTrades > 0
            ? ((state.portfolio.dailyProfit > state.portfolio.dailyLoss ? 1 : 0) * 100).toFixed(1)
            : 'N/A';

        const assetBreakdown = Object.entries(state.assets)
            .filter(([_, a]) => a.dailyTrades > 0)
            .map(([symbol, a]) => `  ${symbol}: ${a.dailyTrades} trades, Win Rate: ${(a.recentWinRate * 100).toFixed(1)}%`)
            .join('\n') || '  No trades yet';

        const text = `
📊 30-MINUTE SUMMARY
========================================

Time: ${new Date().toLocaleString()}

Portfolio:
- Capital: $${state.capital.toFixed(2)}
- Daily Profit: $${state.portfolio.dailyProfit.toFixed(2)}
- Daily Loss: $${state.portfolio.dailyLoss.toFixed(2)}
- Net P/L: $${(state.portfolio.dailyProfit - state.portfolio.dailyLoss).toFixed(2)}

Trading Stats:
- Total Trades: ${state.portfolio.dailyTrades}
- Active Positions: ${state.portfolio.activePositions.length}
- Top Assets: ${state.currentTopAssets.join(', ') || 'None ranked yet'}

Asset Breakdown:
${assetBreakdown}

Risk Status:
- Loss Limit Used: ${((state.portfolio.dailyLoss / (state.capital * CONFIG.maxDailyLossPercent / 100)) * 100).toFixed(1)}%
- Blacklisted: ${Array.from(state.portfolio.blacklistedAssets).join(', ') || 'None'}
        `;
        await this.sendEmail('30-Min Summary', text);
    }

    async sendLossEmail(asset, state) {
        if (asset.consecutiveLosses < 2) return;

        const text = `
⚠️ CONSECUTIVE LOSSES ALERT
========================================

Asset: ${asset.symbol}
Consecutive Losses: ${asset.consecutiveLosses}
Asset P/L: $${(asset.recentWinRate * 100 - 50).toFixed(1)}% win rate

Current Status:
- Capital: $${state.capital.toFixed(2)}
- Daily Loss: $${state.portfolio.dailyLoss.toFixed(2)}

${asset.consecutiveLosses >= 3 ? '⏸️ Asset entering 4-hour cooldown.' : 'Monitoring closely.'}
        `;
        await this.sendEmail(`Loss Alert: ${asset.symbol}`, text);
    }

    async sendErrorEmail(error, context) {
        const text = `
❌ BOT ERROR
========================================

Time: ${new Date().toLocaleString()}
Context: ${context}
Error: ${error.message}
Stack: ${error.stack || 'N/A'}

Please check the bot status.
        `;
        await this.sendEmail('ERROR: Bot Issue', text);
    }

    async sendShutdownEmail(state, reason) {
        const text = `
🛑 BOT STOPPED
========================================

Time: ${new Date().toLocaleString()}
Reason: ${reason}

Final Status:
- Capital: $${state.capital.toFixed(2)}
- Daily Profit: $${state.portfolio.dailyProfit.toFixed(2)}
- Daily Loss: $${state.portfolio.dailyLoss.toFixed(2)}
- Net P/L: $${(state.portfolio.dailyProfit - state.portfolio.dailyLoss).toFixed(2)}
- Total Trades: ${state.portfolio.dailyTrades}
        `;
        await this.sendEmail('Bot Stopped', text);
    }
}

// ==================== STATE MANAGEMENT ====================

class StateManager {
    constructor() {
        this.state = {
            capital: CONFIG.initialCapital,
            initialCapital: CONFIG.initialCapital,
            connection: null,
            isRunning: false,
            startTime: Date.now(),
            tickCount: 0,
            signalsDetected: 0,

            assets: {},
            portfolio: {
                dailyLoss: 0,
                dailyProfit: 0,
                activePositions: [],
                dailyTrades: 0,
                lastResetDate: new Date().toDateString(),
                blacklistedAssets: new Set(),
                assetCooldowns: new Map()
            },

            assetRankings: [],
            currentTopAssets: []
        };

        // Initialize asset states
        Object.keys(CONFIG.assets).forEach(symbol => {
            this.state.assets[symbol] = {
                symbol,
                config: CONFIG.assets[symbol],
                candles: [],
                prices: [],
                emaShort: 0,
                emaLong: 0,
                prevEmaShort: 0,
                prevEmaLong: 0,
                rsi: 50,
                dailyTrades: 0,
                totalTrades: 0,
                wins: 0,
                losses: 0,
                recentWinRate: 0.55,
                trendStrength: 0.5,
                volatility: 0,
                predictability: 0.5,
                consecutiveLosses: 0,
                score: 0,
                isSubscribed: false,
                lastTickTime: 0
            };
        });

        this.loadState();
    }

    getState() { return this.state; }

    addPosition(position) {
        this.state.portfolio.activePositions.push(position);
        this.state.portfolio.dailyTrades++;
        this.persistState();
    }

    closePosition(contractId, profit) {
        const position = this.state.portfolio.activePositions.find(p => p.contractId === contractId);
        if (position) {
            const capitalChange = profit;
            this.state.capital += capitalChange;

            const asset = this.state.assets[position.symbol];
            asset.totalTrades++;

            if (capitalChange > 0) {
                this.state.portfolio.dailyProfit += capitalChange;
                asset.wins++;
                asset.consecutiveLosses = 0;
            } else {
                this.state.portfolio.dailyLoss += Math.abs(capitalChange);
                asset.losses++;
                asset.consecutiveLosses++;
            }

            const isWin = capitalChange > 0;
            asset.recentWinRate = asset.recentWinRate * 0.9 + (isWin ? 0.1 : 0);

            this.state.portfolio.activePositions = this.state.portfolio.activePositions.filter(
                p => p.contractId !== contractId
            );

            this.persistState();
            return { capitalChange, asset, isWin };
        }
        return null;
    }

    resetDailyStats() {
        const today = new Date().toDateString();
        if (this.state.portfolio.lastResetDate !== today) {
            log('INFO', 'Resetting daily statistics');
            this.state.portfolio.dailyLoss = 0;
            this.state.portfolio.dailyProfit = 0;
            this.state.portfolio.dailyTrades = 0;
            this.state.portfolio.lastResetDate = today;

            Object.values(this.state.assets).forEach(asset => {
                asset.dailyTrades = 0;
            });

            this.state.portfolio.blacklistedAssets.clear();
            this.state.portfolio.assetCooldowns.clear();
            this.persistState();
        }
    }

    blacklistAsset(symbol, hours = 48) {
        this.state.portfolio.blacklistedAssets.add(symbol);
        log('RISK', `Blacklisted ${symbol} for ${hours} hours`);
        setTimeout(() => this.state.portfolio.blacklistedAssets.delete(symbol), hours * 3600000);
    }

    setCooldown(symbol, hours = 4) {
        this.state.portfolio.assetCooldowns.set(symbol, Date.now() + hours * 3600000);
        log('RISK', `Cooldown set for ${symbol} - ${hours} hours`);
    }

    isInCooldown(symbol) {
        const cooldownTime = this.state.portfolio.assetCooldowns.get(symbol);
        if (!cooldownTime) return false;
        if (Date.now() > cooldownTime) {
            this.state.portfolio.assetCooldowns.delete(symbol);
            return false;
        }
        return true;
    }

    persistState() {
        try {
            const serialized = JSON.stringify(this.state, (key, value) => {
                if (value instanceof Set) return Array.from(value);
                if (value instanceof Map) return Object.fromEntries(value);
                return value;
            });
            fs.writeFileSync('bot-state.json', serialized);
        } catch (error) {
            log('ERROR', `Failed to persist state: ${error.message}`);
        }
    }

    loadState() {
        try {
            if (fs.existsSync('bot-state.json')) {
                const data = fs.readFileSync('bot-state.json', 'utf8');
                const loaded = JSON.parse(data);
                loaded.portfolio.blacklistedAssets = new Set(loaded.portfolio.blacklistedAssets || []);
                loaded.portfolio.assetCooldowns = new Map(Object.entries(loaded.portfolio.assetCooldowns || {}));
                this.state = { ...this.state, ...loaded };
                log('INFO', 'Loaded previous state from file');
            }
        } catch (error) {
            log('WARNING', `Failed to load state: ${error.message}`);
        }
    }

    getUptimeString() {
        const uptime = Date.now() - this.state.startTime;
        const hours = Math.floor(uptime / 3600000);
        const minutes = Math.floor((uptime % 3600000) / 60000);
        return `${hours}h ${minutes}m`;
    }
}

// ==================== TECHNICAL INDICATORS ====================

class TechnicalIndicators {
    static calculateEMA(prices, period) {
        if (prices.length < period) return null;
        const k = 2 / (period + 1);
        let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < prices.length; i++) {
            ema = (prices[i] - ema) * k + ema;
        }
        return ema;
    }

    static calculateRSI(prices, period = 14) {
        if (prices.length < period + 1) return 50;
        const changes = [];
        for (let i = 1; i < prices.length; i++) {
            changes.push(prices[i] - prices[i - 1]);
        }
        const recentChanges = changes.slice(-period);
        let gains = 0, losses = 0;
        for (const change of recentChanges) {
            if (change > 0) gains += change;
            else losses += Math.abs(change);
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    static detectCrossover(currentShort, currentLong, prevShort, prevLong) {
        const crossUp = prevShort <= prevLong && currentShort > currentLong;
        const crossDown = prevShort >= prevLong && currentShort < currentLong;
        return { crossUp, crossDown };
    }
}

// ==================== AI ENGINE (RULE-BASED) ====================

class AIEngine {
    constructor(stateManager) {
        this.state = stateManager.getState();
    }

    predict(symbol, signal) {
        const asset = this.state.assets[symbol];
        if (!asset.candles || asset.candles.length < 10) return 0.5;

        let confidence = 0.5;

        // Trend alignment
        const trendScore = this.calculateTrendAlignment(asset, signal);
        confidence += trendScore * 0.3;

        // Volatility fit
        const volScore = this.calculateVolatilityFit(asset);
        confidence += volScore * 0.25;

        // Recent win rate
        confidence += asset.recentWinRate * 0.25;

        // RSI score
        const rsiScore = this.calculateRSIScore(asset);
        confidence += rsiScore * 0.2;

        asset.predictability = confidence;
        return Math.max(0, Math.min(1, confidence));
    }

    calculateTrendAlignment(asset, signal) {
        const trendStrength = asset.trendStrength;
        if (signal === 'CALL') {
            return asset.emaShort > asset.emaLong ? trendStrength : 0.3;
        } else {
            return asset.emaShort < asset.emaLong ? trendStrength : 0.3;
        }
    }

    calculateVolatilityFit(asset) {
        const vol = asset.volatility || 0.01;
        const optimalVol = { 'synthetic': 0.02, 'forex': 0.01, 'commodity': 0.015 };
        const targetVol = optimalVol[asset.config.type] || 0.015;
        const distance = Math.abs(vol - targetVol);
        return Math.max(0, 1 - distance * 50);
    }

    calculateRSIScore(asset) {
        const rsi = asset.rsi;
        const threshold = asset.config.rsiThreshold;
        if (rsi < threshold * 0.7 || rsi > (100 - threshold * 0.7)) return 1.0;
        if (rsi < threshold || rsi > (100 - threshold)) return 0.7;
        return 0.4;
    }
}

// ==================== PORTFOLIO MANAGER ====================

class PortfolioManager {
    constructor(stateManager, apiClient) {
        this.stateManager = stateManager;
        this.state = stateManager.getState();
        this.apiClient = apiClient;
    }

    scoreAssets() {
        log('INFO', 'Scoring assets for ranking...');

        let scoredCount = 0;
        Object.values(this.state.assets).forEach(asset => {
            if (!asset.prices || asset.prices.length < 30) {
                asset.score = 0;
                return;
            }

            scoredCount++;
            const recentWinRate = asset.recentWinRate;
            const trendStrength = asset.trendStrength;
            const volatilityFit = this.calculateVolatilityFit(asset);
            const predictability = asset.predictability || 0.5;

            asset.score =
                recentWinRate * CONFIG.scoringWeights.recentWinRate +
                trendStrength * CONFIG.scoringWeights.trendStrength +
                volatilityFit * CONFIG.scoringWeights.volatilityFit +
                predictability * CONFIG.scoringWeights.predictability;
        });

        this.state.assetRankings = Object.values(this.state.assets)
            .filter(asset => !this.state.portfolio.blacklistedAssets.has(asset.symbol))
            .sort((a, b) => b.score - a.score)
            .map(asset => asset.symbol);

        this.state.currentTopAssets = this.state.assetRankings.slice(0, 2);

        log('SUCCESS', `Scoring complete. Top assets: ${this.state.currentTopAssets.join(', ')}`, {
            scored: scoredCount,
            rankings: this.state.assetRankings.slice(0, 4).map(s => `${s}:${this.state.assets[s].score.toFixed(2)}`)
        });
    }

    calculateVolatilityFit(asset) {
        const optimalVolatility = asset.config.type === 'synthetic' ? 0.02 : 0.01;
        const vol = asset.volatility || 0.01;
        const distance = Math.abs(vol - optimalVolatility);
        return Math.max(0, 1 - distance * 50);
    }

    isTopRanked(symbol) {
        return this.state.currentTopAssets.includes(symbol);
    }

    canTradeAsset(symbol) {
        const asset = this.state.assets[symbol];
        const activePositions = this.state.portfolio.activePositions;
        const correlationGroup = asset.config.correlationGroup;

        const sameGroupPositions = activePositions.filter(
            p => this.state.assets[p.symbol]?.config.correlationGroup === correlationGroup
        );

        if (['volatility', 'volatility_high', 'boom_crash'].includes(correlationGroup) && sameGroupPositions.length > 0) {
            return false;
        }

        if (['eur_usd', 'gbp_usd'].includes(correlationGroup)) {
            const forexPositions = activePositions.filter(
                p => this.state.assets[p.symbol]?.config.type === 'forex'
            );
            if (forexPositions.length > 0) return false;
        }

        return true;
    }

    calculateStake(symbol) {
        const asset = this.state.assets[symbol];
        const rankIndex = this.state.assetRankings.indexOf(symbol);
        const totalRiskAmount = this.state.capital * (CONFIG.maxRiskPerTradePercent / 100);
        const allocationRatio = rankIndex === 0 ? 0.6 : 0.4;
        const stake = totalRiskAmount * allocationRatio;

        // Kelly Criterion
        const winRate = asset.recentWinRate;
        const kelly = Math.max(0.1, Math.min((winRate * 0.8 - (1 - winRate)) / 0.8 * 0.5, 0.25));

        return Math.max(0.35, Math.min(stake * kelly, this.state.capital * 0.05));
    }

    evaluateTradeSignal(symbol, signal) {
        if (this.state.portfolio.activePositions.length >= CONFIG.maxOpenPositions) {
            log('RISK', `Max open positions (${CONFIG.maxOpenPositions}) reached`);
            return;
        }

        if (!global.riskManager.canOpenNewTrade()) {
            log('RISK', 'Daily risk limits reached');
            return;
        }

        const asset = this.state.assets[symbol];
        if (asset.dailyTrades >= asset.config.maxDailyTrades) {
            log('RISK', `${symbol} daily trade limit (${asset.config.maxDailyTrades}) reached`);
            return;
        }

        this.apiClient.sendProposal(symbol, signal);
    }
}

// ==================== RISK MANAGER ====================

class RiskManager {
    constructor(stateManager) {
        this.stateManager = stateManager;
        this.state = stateManager.getState();
    }

    canOpenNewTrade() {
        const dailyLoss = this.state.portfolio.dailyLoss;
        const capital = this.state.capital;
        const maxDailyLoss = capital * (CONFIG.maxDailyLossPercent / 100);

        if (dailyLoss >= maxDailyLoss) {
            log('RISK', `Daily loss limit reached: $${dailyLoss.toFixed(2)} / $${maxDailyLoss.toFixed(2)}`);
            return false;
        }

        const profitTarget = capital * (CONFIG.dailyProfitTargetPercent / 100);
        if (this.state.portfolio.dailyProfit >= profitTarget) {
            log('RISK', `Daily profit target reached: $${this.state.portfolio.dailyProfit.toFixed(2)}`);
            return false;
        }

        return true;
    }

    checkLimits() {
        const maxDailyLoss = this.state.initialCapital * (CONFIG.maxDailyLossPercent / 100);
        if (this.state.portfolio.dailyLoss >= maxDailyLoss) {
            log('RISK', 'DAILY LOSS LIMIT REACHED - STOPPING TRADING');
            this.state.isRunning = false;
            return 'LOSS_LIMIT';
        }

        Object.values(this.state.assets).forEach(asset => {
            if (asset.dailyTrades >= 20 && asset.recentWinRate < 0.5) {
                log('WARNING', `Blacklisting ${asset.symbol} - win rate ${(asset.recentWinRate * 100).toFixed(1)}%`);
                this.stateManager.blacklistAsset(asset.symbol);
            }

            if (asset.consecutiveLosses >= 3) {
                log('WARNING', `Cooldown for ${asset.symbol} - ${asset.consecutiveLosses} consecutive losses`);
                this.stateManager.setCooldown(asset.symbol);
                asset.consecutiveLosses = 0;
            }
        });

        return null;
    }
}

// ==================== DERIV API CLIENT ====================

class DerivAPI {
    constructor(stateManager, emailManager) {
        this.ws = null;
        this.stateManager = stateManager;
        this.emailManager = emailManager;
        this.state = stateManager.getState();
        this.requestId = 1;
        this.pendingRequests = new Map();
    }

    async connect() {
        return new Promise((resolve, reject) => {
            log('INFO', 'Connecting to Deriv API...');
            this.ws = new WebSocket(`${CONFIG.websocketUrl}?app_id=${CONFIG.appId}`);

            this.ws.on('open', () => {
                log('SUCCESS', 'Connected to Deriv WebSocket');
                this.authenticate();
            });

            this.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data);
                    this.handleMessage(response);
                } catch (e) {
                    log('ERROR', `Message parse error: ${e.message}`);
                }
            });

            this.ws.on('close', () => {
                log('WARNING', 'WebSocket disconnected');
                if (this.state.isRunning) this.reconnect();
            });

            this.ws.on('error', (error) => {
                log('ERROR', `WebSocket error: ${error.message}`);
                this.emailManager.sendErrorEmail(error, 'WebSocket connection');
                reject(error);
            });

            const checkAuth = setInterval(() => {
                if (this.state.connection?.authorized) {
                    clearInterval(checkAuth);
                    resolve();
                }
            }, 1000);

            setTimeout(() => {
                clearInterval(checkAuth);
                reject(new Error('Authentication timeout'));
            }, 30000);
        });
    }

    authenticate() {
        log('INFO', 'Authenticating...');
        this.send({ authorize: CONFIG.apiToken });
    }

    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const reqId = message.req_id || this.requestId++;
            message.req_id = reqId;
            this.ws.send(JSON.stringify(message));
            return reqId;
        }
        return null;
    }

    handleMessage(response) {
        const { msg_type, error } = response;

        if (error) {
            log('ERROR', `API Error: ${error.message}`);
            return;
        }

        switch (msg_type) {
            case 'authorize':
                this.state.connection = { authorized: true };
                log('SUCCESS', 'Authorization successful');
                this.subscribeToAllAssets();
                break;

            case 'candles':
                this.handleCandles(response);
                break;

            case 'ohlc':
                this.handleOHLC(response);
                break;

            case 'tick':
                this.handleTick(response);
                break;

            case 'proposal':
                this.handleProposal(response);
                break;

            case 'buy':
                this.handleBuy(response);
                break;

            case 'proposal_open_contract':
                this.handleContractUpdate(response);
                break;
        }
    }

    subscribeToAllAssets() {
        log('INFO', 'Subscribing to market data...');
        let count = 0;
        Object.keys(CONFIG.assets).forEach(symbol => {
            this.subscribeToAsset(symbol);
            count++;
        });
        log('SUCCESS', `Subscribed to ${count} assets`);
    }

    subscribeToAsset(symbol) {
        const config = CONFIG.assets[symbol];
        this.send({
            ticks_history: symbol,
            count: CONFIG.maxCandleHistory,
            end: 'latest',
            style: 'candles',
            granularity: config.granularity,
            subscribe: 1
        });

        this.send({ ticks: symbol, subscribe: 1 });
    }

    handleCandles(response) {
        const symbol = response.echo_req?.ticks_history;
        if (!symbol) return;

        const asset = this.state.assets[symbol];
        if (!asset) return;

        asset.candles = response.candles || [];
        asset.prices = asset.candles.map(c => parseFloat(c.close));
        asset.isSubscribed = true;
        this.updateIndicators(symbol);

        log('INFO', `Loaded ${asset.candles.length} candles for ${symbol}`);
    }

    handleOHLC(response) {
        const ohlc = response.ohlc;
        if (!ohlc) return;

        const symbol = ohlc.symbol;
        const asset = this.state.assets[symbol];
        if (!asset) return;

        asset.candles.push(ohlc);
        if (asset.candles.length > CONFIG.maxCandleHistory) {
            asset.candles.shift();
        }
        asset.prices = asset.candles.map(c => parseFloat(c.close));
        this.updateIndicators(symbol);
    }

    handleTick(response) {
        const tick = response.tick;
        if (!tick) return;

        const symbol = tick.symbol;
        const asset = this.state.assets[symbol];
        if (!asset) return;

        this.state.tickCount++;
        asset.lastTickTime = Date.now();

        const price = parseFloat(tick.quote);
        if (asset.prices.length > 0) {
            asset.prices[asset.prices.length - 1] = price;
        }

        this.checkSignal(symbol);
    }

    updateIndicators(symbol) {
        const asset = this.state.assets[symbol];
        const prices = asset.prices;
        const config = asset.config;

        if (prices.length < config.emaLong + 5) return;

        asset.prevEmaShort = asset.emaShort;
        asset.prevEmaLong = asset.emaLong;

        asset.emaShort = TechnicalIndicators.calculateEMA(prices, config.emaShort);
        asset.emaLong = TechnicalIndicators.calculateEMA(prices, config.emaLong);
        asset.rsi = TechnicalIndicators.calculateRSI(prices, config.rsiPeriod);

        // Volatility
        if (prices.length > 20) {
            const returns = [];
            for (let i = 1; i < prices.length; i++) {
                returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
            }
            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
            asset.volatility = Math.sqrt(variance);
        }

        // Trend strength
        if (asset.emaLong !== 0) {
            asset.trendStrength = Math.min(Math.abs(asset.emaShort - asset.emaLong) / asset.emaLong * 100, 1);
        }
    }

    checkSignal(symbol) {
        const asset = this.state.assets[symbol];
        const config = asset.config;
        const portfolioManager = global.portfolioManager;

        if (!portfolioManager || !portfolioManager.isTopRanked(symbol)) return;
        if (asset.dailyTrades >= config.maxDailyTrades) return;
        if (this.stateManager.isInCooldown(symbol)) return;
        if (this.state.portfolio.blacklistedAssets.has(symbol)) return;
        if (!portfolioManager.canTradeAsset(symbol)) return;

        const { crossUp, crossDown } = TechnicalIndicators.detectCrossover(
            asset.emaShort, asset.emaLong, asset.prevEmaShort, asset.prevEmaLong
        );

        let signal = null;
        if (crossUp && asset.rsi < config.rsiThreshold) signal = 'CALL';
        if (crossDown && asset.rsi > (100 - config.rsiThreshold)) signal = 'PUT';

        if (signal) {
            this.state.signalsDetected++;
            log('SIGNAL', `${symbol} ${signal}`, {
                rsi: asset.rsi.toFixed(1),
                emaShort: asset.emaShort.toFixed(4),
                emaLong: asset.emaLong.toFixed(4),
                trendStrength: asset.trendStrength.toFixed(2)
            });
            portfolioManager.evaluateTradeSignal(symbol, signal);
        }
    }

    sendProposal(symbol, signal) {
        const stake = global.portfolioManager.calculateStake(symbol);
        const config = CONFIG.assets[symbol];

        const confidence = global.aiEngine.predict(symbol, signal);
        if (confidence < CONFIG.aiConfidenceThreshold) {
            log('RISK', `AI rejected ${symbol} ${signal}: confidence ${(confidence * 100).toFixed(1)}% < ${CONFIG.aiConfidenceThreshold * 100}%`);
            return;
        }

        log('TRADE', `Requesting proposal for ${symbol} ${signal}`, {
            stake: `$${stake.toFixed(2)}`,
            confidence: `${(confidence * 100).toFixed(1)}%`
        });

        const reqId = this.send({
            proposal: 1,
            amount: stake,
            basis: 'stake',
            contract_type: signal,
            currency: 'USD',
            duration: config.duration,
            duration_unit: config.durationUnit,
            symbol: symbol
        });

        if (reqId) {
            this.pendingRequests.set(reqId, { symbol, signal, stake });
        }
    }

    handleProposal(response) {
        const reqId = response.echo_req?.req_id;
        const request = this.pendingRequests.get(reqId);
        if (!request) return;

        if (response.proposal) {
            log('TRADE', `Proposal received for ${request.symbol}, executing buy...`);
            this.send({
                buy: response.proposal.id,
                price: request.stake
            });
            this.pendingRequests.set(response.echo_req.req_id + 1, request);
        }
        this.pendingRequests.delete(reqId);
    }

    handleBuy(response) {
        if (response.buy) {
            const reqId = response.echo_req?.req_id;
            const request = this.pendingRequests.get(reqId - 1) || {};

            const position = {
                contractId: response.buy.contract_id,
                symbol: request.symbol,
                signal: request.signal,
                amount: request.stake,
                entryTime: Date.now()
            };

            this.stateManager.addPosition(position);
            this.state.assets[request.symbol].dailyTrades++;

            log('SUCCESS', `Trade executed: ${request.symbol} ${request.signal}`, {
                contractId: response.buy.contract_id,
                stake: `$${request.stake.toFixed(2)}`,
                positions: this.state.portfolio.activePositions.length
            });

            // Send trade email
            this.emailManager.sendTradeEmail('OPEN', { ...request, contractId: response.buy.contract_id }, this.state);

            this.send({
                proposal_open_contract: 1,
                contract_id: response.buy.contract_id,
                subscribe: 1
            });
        }
    }

    handleContractUpdate(response) {
        const contract = response.proposal_open_contract;
        if (!contract || !contract.is_sold) return;

        const profit = parseFloat(contract.profit);
        const result = this.stateManager.closePosition(contract.contract_id, profit);

        if (result) {
            const { capitalChange, asset, isWin } = result;

            log(isWin ? 'SUCCESS' : 'WARNING', `Contract closed: ${asset.symbol} ${isWin ? 'WON' : 'LOST'}`, {
                profit: `$${capitalChange.toFixed(2)}`,
                capital: `$${this.state.capital.toFixed(2)}`,
                dailyPnL: `$${(this.state.portfolio.dailyProfit - this.state.portfolio.dailyLoss).toFixed(2)}`
            });

            // Send trade result email
            this.emailManager.sendTradeEmail(isWin ? 'WIN' : 'LOSS', {
                symbol: asset.symbol,
                profit: capitalChange
            }, this.state);

            if (!isWin) {
                this.emailManager.sendLossEmail(asset, this.state);
            }

            const limitHit = global.riskManager.checkLimits();
            if (limitHit) {
                this.emailManager.sendShutdownEmail(this.state, limitHit);
            }
        }
    }

    reconnect() {
        log('INFO', 'Attempting reconnection in 5 seconds...');
        this.emailManager.sendEmail('Reconnecting', 'Bot disconnected, attempting to reconnect...');
        setTimeout(() => this.connect().catch(e => {
            log('ERROR', `Reconnect failed: ${e.message}`);
            this.emailManager.sendErrorEmail(e, 'Reconnection attempt');
        }), 5000);
    }
}

// ==================== MAIN BOT ====================

class DerivMultiAssetBot {
    constructor() {
        this.stateManager = new StateManager();
        this.state = this.stateManager.getState();
        this.emailManager = new EmailManager(CONFIG.email);
        this.apiClient = new DerivAPI(this.stateManager, this.emailManager);
        this.aiEngine = new AIEngine(this.stateManager);
        this.portfolioManager = new PortfolioManager(this.stateManager, this.apiClient);
        this.riskManager = new RiskManager(this.stateManager);

        global.portfolioManager = this.portfolioManager;
        global.riskManager = this.riskManager;
        global.aiEngine = this.aiEngine;
    }

    async start() {
        console.log(`
╔════════════════════════════════════════════════════════════╗
║   🚀 MULTI-ASSET TRADING BOT (Light Version)              ║
╟────────────────────────────────────────────────────────────╢
║ Capital: $${this.state.capital.toFixed(2).padEnd(47)}║
║ Assets: ${Object.keys(CONFIG.assets).length} configured                                   ║
║ Strategy: EMA Crossover + RSI + AI Confidence Filter      ║
║ Max Daily Loss: ${CONFIG.maxDailyLossPercent}% | Profit Target: ${CONFIG.dailyProfitTargetPercent}%            ║
║ Email Notifications: ENABLED                              ║
╚════════════════════════════════════════════════════════════╝
        `);

        try {
            await this.apiClient.connect();
            this.portfolioManager.scoreAssets();

            // Send startup email
            await this.emailManager.sendStartupEmail(this.state);

            // Asset scoring interval
            setInterval(() => {
                if (this.state.isRunning) {
                    this.portfolioManager.scoreAssets();
                    this.logStatus();
                }
            }, CONFIG.assetScoringInterval);

            // Email summary interval
            setInterval(() => {
                if (this.state.isRunning) {
                    this.emailManager.sendSummaryEmail(this.state);
                }
            }, CONFIG.email.summaryInterval);

            // Daily reset check
            setInterval(() => this.stateManager.resetDailyStats(), 3600000);

            this.state.isRunning = true;
            log('SUCCESS', 'Bot is now running and monitoring for signals');

            process.on('SIGINT', async () => {
                log('INFO', 'Shutdown signal received...');
                await this.stop('User requested shutdown');
                process.exit(0);
            });

        } catch (error) {
            log('ERROR', `Failed to start: ${error.message}`);
            await this.emailManager.sendErrorEmail(error, 'Bot startup');
            process.exit(1);
        }
    }

    logStatus() {
        const activeAssets = Object.values(this.state.assets).filter(a => a.isSubscribed).length;
        const uptime = this.stateManager.getUptimeString();

        log('INFO', 'Status update', {
            uptime,
            capital: `$${this.state.capital.toFixed(2)}`,
            dailyPnL: `$${(this.state.portfolio.dailyProfit - this.state.portfolio.dailyLoss).toFixed(2)}`,
            trades: this.state.portfolio.dailyTrades,
            signals: this.state.signalsDetected,
            positions: this.state.portfolio.activePositions.length,
            activeAssets,
            topAssets: this.state.currentTopAssets.join(', ')
        });
    }

    async stop(reason = 'Unknown') {
        log('INFO', `Stopping bot: ${reason}`);
        this.state.isRunning = false;

        await this.emailManager.sendShutdownEmail(this.state, reason);

        if (this.apiClient.ws) this.apiClient.ws.close();
        this.stateManager.persistState();

        log('SUCCESS', 'Bot stopped successfully');
    }
}

// ==================== START ====================

const bot = new DerivMultiAssetBot();
bot.start().catch(async error => {
    log('ERROR', `Fatal error: ${error.message}`);
    process.exit(1);
});

module.exports = DerivMultiAssetBot;
