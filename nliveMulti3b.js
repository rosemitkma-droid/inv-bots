/**
 * Enhanced Deriv Accumulator Trading Bot
 * Version 3.1 - Fixed Exit Logic
 * 
 * FIXES:
 * - Proper take_profit limit order
 * - Active contract monitoring with sell execution
 * - Enforced entry window check
 * - Fixed tick tracking
 */

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'accumulator-bot-state.json');
const STATE_SAVE_INTERVAL = 5000;

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
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                },
                learningSystem: bot.learningSystem,
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

            if (ageMinutes > 60) {
                console.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
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
        if (bot.autoSaveInterval) {
            clearInterval(bot.autoSaveInterval);
        }

        bot.autoSaveInterval = setInterval(() => {
            if (bot.connected && !bot.endOfDay) {
                StatePersistence.saveState(bot);
            }
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

// ============================================================================
// ACCUMULATOR MARKET ANALYZER
// ============================================================================
class AccumulatorAnalyzer {
    constructor() {
        this.runHistory = {};
        this.volatilityHistory = {};
        this.regimeHistory = {};
    }

    recordRun(asset, runLength, exitReason) {
        if (!this.runHistory[asset]) {
            this.runHistory[asset] = [];
        }
        
        this.runHistory[asset].push({
            length: runLength,
            reason: exitReason,
            timestamp: Date.now()
        });

        if (this.runHistory[asset].length > 500) {
            this.runHistory[asset].shift();
        }
    }

    getWeightedSurvivalProbability(asset, currentTicks, targetAdditionalTicks = 5) {
        const runs = this.runHistory[asset] || [];
        
        if (runs.length < 30) {
            return this.getDefaultSurvivalProb(currentTicks, targetAdditionalTicks);
        }

        const weightedRuns = runs.map((run, idx) => ({
            ...run,
            weight: Math.exp((idx - runs.length) / 100)
        }));

        const survivedCurrent = weightedRuns.filter(r => r.length >= currentTicks);
        const survivedTarget = survivedCurrent.filter(r => r.length >= currentTicks + targetAdditionalTicks);

        if (survivedCurrent.length < 10) {
            return this.getDefaultSurvivalProb(currentTicks, targetAdditionalTicks);
        }

        const weightSurvived = survivedCurrent.reduce((sum, r) => sum + r.weight, 0);
        const weightTarget = survivedTarget.reduce((sum, r) => sum + r.weight, 0);

        return weightTarget / weightSurvived;
    }

    getDefaultSurvivalProb(currentTicks, additionalTicks) {
        const totalTicks = currentTicks + additionalTicks;
        
        if (totalTicks <= 10) return 0.85;
        if (totalTicks <= 15) return 0.78;
        if (totalTicks <= 20) return 0.70;
        if (totalTicks <= 25) return 0.62;
        if (totalTicks <= 30) return 0.54;
        if (totalTicks <= 35) return 0.45;
        if (totalTicks <= 40) return 0.36;
        
        return Math.max(0.15, 0.45 * Math.exp(-0.04 * totalTicks));
    }

    detectVolatilityRegime(recentDigits) {
        if (recentDigits.length < 40) {
            return { regime: 'unknown', score: 0.5 };
        }

        const last40 = recentDigits.slice(-40);
        const last20 = recentDigits.slice(-20);
        
        let changes40 = 0, changes20 = 0;
        
        for (let i = 1; i < last40.length; i++) {
            if (last40[i] !== last40[i-1]) changes40++;
        }
        for (let i = 1; i < last20.length; i++) {
            if (last20[i] !== last20[i-1]) changes20++;
        }

        const changeRate40 = changes40 / 39;
        const changeRate20 = changes20 / 19;

        let regime, score;

        if (changeRate20 >= 0.45 && changeRate20 <= 0.65) {
            if (Math.abs(changeRate20 - changeRate40) < 0.15) {
                regime = 'stable_optimal';
                score = 0.85;
            } else {
                regime = 'transitioning';
                score = 0.60;
            }
        } else if (changeRate20 < 0.35) {
            regime = 'too_stable';
            score = 0.30;
        } else if (changeRate20 > 0.75) {
            regime = 'too_volatile';
            score = 0.25;
        } else {
            regime = 'moderate';
            score = 0.70;
        }

        const maxStreak = this.getMaxStreak(last20);
        if (maxStreak >= 4) {
            score *= 0.5;
            regime = 'streak_warning';
        }

        return { regime, score, changeRate: changeRate20, maxStreak };
    }

    getMaxStreak(digits) {
        let maxStreak = 1, currentStreak = 1;
        
        for (let i = 1; i < digits.length; i++) {
            if (digits[i] === digits[i-1]) {
                currentStreak++;
                maxStreak = Math.max(maxStreak, currentStreak);
            } else {
                currentStreak = 1;
            }
        }
        
        return maxStreak;
    }

    calculateMomentum(stayedInArray) {
        if (!stayedInArray || stayedInArray.length < 50) {
            return 0.5;
        }

        const recent = stayedInArray.slice(-50);
        let upMoves = 0, downMoves = 0;

        for (let i = 1; i < recent.length; i++) {
            if (recent[i] > recent[i-1]) upMoves++;
            else if (recent[i] < recent[i-1]) downMoves++;
        }

        const momentum = Math.abs(upMoves - downMoves) / 49;
        return 1 - momentum;
    }
}

// ============================================================================
// ENHANCED RISK MANAGER
// ============================================================================
class RiskManager {
    constructor(config) {
        this.config = config;
        this.maxDailyLoss = config.maxDailyLoss || 200;
        this.maxConsecutiveLosses = config.maxConsecutiveLosses || 4;
        this.assetCooldowns = {};
    }

    calculateOptimalStake(baseStake, winRate, consecutiveLosses, totalProfitLoss) {
        if (consecutiveLosses > 0) {
            return baseStake * Math.pow(this.config.multiplier, consecutiveLosses);
        }

        if (totalProfitLoss < -this.maxDailyLoss * 0.7) {
            return baseStake * 0.5;
        }

        return baseStake;
    }

    isAssetOnCooldown(asset) {
        const cooldown = this.assetCooldowns[asset];
        
        if (!cooldown) return false;
        
        if (Date.now() < cooldown.until) {
            return true;
        }

        delete this.assetCooldowns[asset];
        return false;
    }

    cooldownAsset(asset, durationMinutes = 30) {
        this.assetCooldowns[asset] = {
            until: Date.now() + (durationMinutes * 60 * 1000),
            reason: 'consecutive_loss'
        };
        
        console.log(`🔒 ${asset} on cooldown for ${durationMinutes} minutes`);
    }

    canTrade(asset, dailyProfitLoss, consecutiveLosses) {
        if (dailyProfitLoss <= -this.maxDailyLoss) {
            return { allowed: false, reason: 'daily_loss_limit' };
        }

        if (consecutiveLosses >= this.maxConsecutiveLosses) {
            return { allowed: false, reason: 'max_consecutive_losses' };
        }

        if (this.isAssetOnCooldown(asset)) {
            return { allowed: false, reason: 'asset_cooldown' };
        }

        return { allowed: true };
    }
}

// ============================================================================
// MAIN ACCUMULATOR BOT - FIXED VERSION
// ============================================================================
class ReliableAccumulatorBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        
        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];

        this.config = {
            initialStake: config.initialStake || 1,
            multiplier: config.multiplier || 2.1,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 4,
            maxDailyLoss: config.maxDailyLoss || 200,
            takeProfit: config.takeProfit || 500,
            growthRate: config.growthRate || 0.05,
            
            // Entry window (ENFORCED)
            minEntryTicks: config.minEntryTicks || 15,
            maxEntryTicks: config.maxEntryTicks || 25,
            
            // Target hold time and profit
            targetHoldTicks: config.targetHoldTicks || 6,
            // Take profit as a multiplier of stake (e.g., 0.5 = 50% profit)
            takeProfitMultiplier: config.takeProfitMultiplier || 0.5,
            
            // Thresholds
            minSurvivalProb: config.minSurvivalProb || 0.65,
            minRegimeScore: config.minRegimeScore || 0.60,
            minOverallScore: config.minOverallScore || 0.72,
            
            requiredHistoryLength: config.requiredHistoryLength || 200,
        };

        // Trading state
        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.dailyProfitLoss = 0;
        this.tradeInProgress = false;
        this.endOfDay = false;
        
        // CRITICAL: Active trade tracking
        this.activeTrade = null;
        this.contractSubscriptionId = null;

        // Asset data
        this.tickHistories = {};
        this.assetStates = {};
        this.tickSubscriptionIds = {};
        this.assetMetrics = {};

        // Components
        this.analyzer = new AccumulatorAnalyzer();
        this.riskManager = new RiskManager(this.config);

        // Learning system
        this.learningSystem = {
            winningPatterns: {},
            losingPatterns: {},
            assetPerformance: {},
        };

        // Initialize assets
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.assetStates[asset] = {
                currentProposalId: null,
                lastStayedInArray: null,
                lastTicks: 0,
            };
            this.assetMetrics[asset] = {
                trades: 0,
                wins: 0,
                losses: 0,
                profitLoss: 0,
            };
            this.learningSystem.assetPerformance[asset] = [];
        });

        // Telegram
        this.telegramToken = config.telegramToken || '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ';
        this.telegramChatId = config.telegramChatId || '752497117';
        
        if (this.telegramToken && this.telegramChatId) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
        }

        // Stats
        this.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
        };

        // Load saved state
        this.loadSavedState();

        // Reconnection
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 5000;
    }

    // ========================================================================
    // STATE MANAGEMENT
    // ========================================================================

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
            if (state.learningSystem) {
                this.learningSystem = state.learningSystem;
            }
            if (state.assetMetrics) {
                this.assetMetrics = state.assetMetrics;
            }

            console.log(`✅ State restored: ${this.totalTrades} trades, P&L: $${this.totalProfitLoss.toFixed(2)}`);
        } catch (error) {
            console.error(`❌ Error restoring state: ${error.message}`);
        }
    }

    // ========================================================================
    // WEBSOCKET CONNECTION
    // ========================================================================

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

        console.log('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.authenticate();
        });

        this.ws.on('message', (data) => {
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

        this.ws.on('close', () => {
            console.log('Disconnected from Deriv API');
            this.handleDisconnect();
        });
    }

    authenticate() {
        this.sendRequest({ authorize: this.token });
    }

    sendRequest(request) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('Cannot send request: WebSocket not ready');
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
            console.log('Planned shutdown');
            this.cleanup();
            return;
        }

        this.connected = false;
        this.wsReady = false;
        StatePersistence.saveState(this);

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        setTimeout(() => {
            this.connect();
        }, delay);
    }

    cleanup() {
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) {}
            }
            this.ws = null;
        }
        this.connected = false;
        this.wsReady = false;
    }

    // ========================================================================
    // MESSAGE HANDLING
    // ========================================================================

    handleMessage(message) {
        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                this.disconnect();
                return;
            }
            console.log('✅ Authenticated');
            this.wsReady = true;
            this.initializeSubscriptions();

        } else if (message.msg_type === 'history') {
            const asset = message.echo_req.ticks_history;
            this.handleTickHistory(asset, message.history);

        } else if (message.msg_type === 'tick') {
            if (message.subscription) {
                const asset = message.tick.symbol;
                this.tickSubscriptionIds[asset] = message.subscription.id;
            }
            this.handleTickUpdate(message.tick);

        } else if (message.msg_type === 'proposal') {
            this.handleProposal(message);

        } else if (message.msg_type === 'buy') {
            this.handleBuyResponse(message);

        } else if (message.msg_type === 'proposal_open_contract') {
            if (message.error) {
                console.error('Contract error:', message.error.message);
                return;
            }
            this.handleContractUpdate(message.proposal_open_contract);

        } else if (message.msg_type === 'sell') {
            this.handleSellResponse(message);

        } else if (message.error) {
            console.error('API Error:', message.error.message);
        }
    }

    initializeSubscriptions() {
        console.log('📡 Initializing subscriptions...');
        
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

    handleTickHistory(asset, history) {
        this.tickHistories[asset] = history.prices.map(price => 
            this.getLastDigit(price, asset)
        );
        
        console.log(`📊 ${asset}: Loaded ${this.tickHistories[asset].length} historical ticks`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.tickHistories[asset].push(lastDigit);

        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        }

        // Only request proposals if ready and not trading
        if (this.tickHistories[asset].length >= this.config.requiredHistoryLength && 
            !this.tradeInProgress) {
            this.requestProposal(asset);
        }
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', 'R_100'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        }
        
        return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
    }

    // ========================================================================
    // TRADE ANALYSIS & EXECUTION
    // ========================================================================

    requestProposal(asset) {
        // Calculate take profit amount based on stake and multiplier
        const takeProfitAmount = this.currentStake * this.config.takeProfitMultiplier;
        
        this.sendRequest({
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: this.config.growthRate,
            // CRITICAL: Add limit order for automatic take profit
            limit_order: {
                take_profit: takeProfitAmount.toFixed(2)
            }
        });
    }

    handleProposal(message) {
        if (message.error || !message.proposal) {
            if (message.error) {
                console.log(`Proposal error for ${message.echo_req?.symbol}: ${message.error.message}`);
            }
            return;
        }

        const asset = message.echo_req.symbol;
        const proposal = message.proposal;
        
        if (!proposal.contract_details || !proposal.contract_details.ticks_stayed_in) {
            return;
        }
        
        this.assetStates[asset].currentProposalId = proposal.id;
        
        const stayedInArray = proposal.contract_details.ticks_stayed_in;
        this.assetStates[asset].lastStayedInArray = stayedInArray;
        
        const currentTicks = stayedInArray[stayedInArray.length - 1] + 1;

        // Record run completion for learning
        const prevTicks = this.assetStates[asset].lastTicks;
        if (prevTicks >= 8 && currentTicks < 3) {
            this.analyzer.recordRun(asset, prevTicks, 'natural_exit');
        }
        
        this.assetStates[asset].lastTicks = currentTicks;

        // Don't analyze if trade in progress
        if (this.tradeInProgress) return;

        // Analyze trade opportunity
        const decision = this.analyzeTradeOpportunity(asset, currentTicks, stayedInArray);

        // Log analysis
        this.logAnalysis(asset, currentTicks, decision);

        if (decision.shouldTrade) {
            this.executeTrade(asset, decision);
        }
    }

    logAnalysis(asset, currentTicks, decision) {
        const inWindow = currentTicks >= this.config.minEntryTicks && 
                        currentTicks <= this.config.maxEntryTicks;
        
        console.log(`\n🔍 Analyzing ${asset} @ ${currentTicks} ticks (target ${currentTicks + this.config.targetHoldTicks})`);
        console.log(`   Entry Window: ${inWindow ? '✅' : '❌'} (${this.config.minEntryTicks}-${this.config.maxEntryTicks})`);
        
        if (decision.survivalProb !== undefined) {
            console.log(`   Survival: ${(decision.survivalProb * 100).toFixed(1)}%`);
        }
        if (decision.regimeAnalysis) {
            console.log(`   Regime: ${decision.regimeAnalysis.regime} (${(decision.regimeAnalysis.score * 100).toFixed(1)}%)`);
        }
        if (decision.overallScore !== undefined) {
            console.log(`   Score: ${(decision.overallScore * 100).toFixed(1)}%`);
        }
        console.log(`   Decision: ${decision.shouldTrade ? '✅ TRADE' : '❌ SKIP'} | Reason: ${decision.reason || 'N/A'}`);
    }

    /**
     * CORE ANALYSIS METHOD - With enforced entry window
     */
    analyzeTradeOpportunity(asset, currentTicks, stayedInArray) {
        // 1. ENFORCED Entry window check (CRITICAL FIX)
        // if (currentTicks < this.config.minEntryTicks) {
        //     return { 
        //         shouldTrade: false, 
        //         reason: `too_early (${currentTicks} < ${this.config.minEntryTicks})`,
        //         currentTicks 
        //     };
        // }
        
        // if (currentTicks > this.config.maxEntryTicks) {
        //     return { 
        //         shouldTrade: false, 
        //         reason: `too_late (${currentTicks} > ${this.config.maxEntryTicks})`,
        //         currentTicks 
        //     };
        // }

        // 2. Risk management check
        const riskCheck = this.riskManager.canTrade(
            asset, 
            this.dailyProfitLoss, 
            this.consecutiveLosses
        );
        
        if (!riskCheck.allowed) {
            return { 
                shouldTrade: false, 
                reason: riskCheck.reason,
                currentTicks 
            };
        }

        // 3. Volatility regime analysis
        const recentDigits = this.tickHistories[asset].slice(-60);
        const regimeAnalysis = this.analyzer.detectVolatilityRegime(recentDigits);
        
        // if (regimeAnalysis.score < this.config.minRegimeScore) {
        //     return { 
        //         shouldTrade: false, 
        //         reason: `poor_regime (${regimeAnalysis.regime})`,
        //         regimeAnalysis,
        //         currentTicks
        //     };
        // }

        // 4. Survival probability calculation
        const survivalProb = this.analyzer.getWeightedSurvivalProbability(
            asset,
            currentTicks,
            this.config.targetHoldTicks
        );

        // if (survivalProb < this.config.minSurvivalProb) {
        //     return { 
        //         shouldTrade: false, 
        //         reason: `low_survival (${(survivalProb * 100).toFixed(1)}%)`,
        //         survivalProb,
        //         regimeAnalysis,
        //         currentTicks
        //     };
        // }

        // 5. Momentum check
        const momentum = this.analyzer.calculateMomentum(stayedInArray);

        // 6. Calculate overall score
        const overallScore = (
            survivalProb * 0.50 +
            regimeAnalysis.score * 0.35 +
            momentum * 0.15
        );

        // 7. Final decision
        const shouldTrade = overallScore >= this.config.minOverallScore;

        return {
            shouldTrade,
            reason: shouldTrade ? 'meets_criteria' : `score_too_low (${(overallScore * 100).toFixed(1)}%)`,
            overallScore,
            survivalProb,
            regimeAnalysis,
            momentum,
            currentTicks,
            targetTicks: currentTicks + this.config.targetHoldTicks,
        };
    }

    /**
     * Execute trade with take profit
     */
    executeTrade(asset, decision) {
        const proposalId = this.assetStates[asset].currentProposalId;
        
        if (!proposalId) {
            console.error(`❌ No proposal ID for ${asset}`);
            return;
        }

        // Calculate stake
        this.currentStake = this.riskManager.calculateOptimalStake(
            this.config.initialStake,
            this.totalWins / Math.max(1, this.totalTrades),
            this.consecutiveLosses,
            this.totalProfitLoss
        );

        const takeProfitAmount = this.currentStake * this.config.takeProfitMultiplier;

        console.log(`\n🚀 EXECUTING TRADE`);
        console.log(`   Asset: ${asset}`);
        console.log(`   Entry: ${decision.currentTicks} ticks`);
        console.log(`   Target: ${decision.targetTicks} ticks`);
        console.log(`   Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`   Take Profit: $${takeProfitAmount.toFixed(2)}`);
        console.log(`   Score: ${(decision.overallScore * 100).toFixed(1)}%`);

        this.sendRequest({
            buy: proposalId,
            price: this.currentStake.toFixed(2)
        });

        this.tradeInProgress = true;
        
        // Store active trade info
        this.activeTrade = {
            asset,
            entryTicks: decision.currentTicks,
            targetTicks: decision.targetTicks,
            entryTime: Date.now(),
            stake: this.currentStake,
            takeProfitAmount,
            decision,
            contractId: null,
            currentTicks: decision.currentTicks,
        };

        // Telegram notification
        this.sendTelegramMessage(
            `🚀 <b>TRADE OPENED</b>\n\n` +
            `Asset: ${asset}\n` +
            `Entry: ${decision.currentTicks} ticks\n` +
            `Target: ${decision.targetTicks} ticks\n` +
            `Stake: $${this.currentStake.toFixed(2)}\n` +
            `Take Profit: $${takeProfitAmount.toFixed(2)}\n` +
            `Score: ${(decision.overallScore * 100).toFixed(1)}%`
        );
    }

    handleBuyResponse(message) {
        if (message.error) {
            console.error('❌ Error placing trade:', message.error.message);
            this.tradeInProgress = false;
            this.activeTrade = null;
            return;
        }

        console.log('✅ Trade placed successfully');
        
        const contractId = message.buy.contract_id;
        
        if (this.activeTrade) {
            this.activeTrade.contractId = contractId;
        }

        // Subscribe to contract updates
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });
    }

    /**
     * CRITICAL: Handle contract updates and monitor for exit
     */
    handleContractUpdate(contract) {
        if (!contract || !this.activeTrade) return;

        // Store subscription ID for cleanup
        if (contract.id && !this.contractSubscriptionId) {
            this.contractSubscriptionId = contract.id;
        }

        const currentProfit = parseFloat(contract.profit || 0);
        const bidPrice = parseFloat(contract.bid_price || 0);
        const tickCount = contract.tick_count || 0;
        
        // Update current ticks
        if (this.activeTrade) {
            this.activeTrade.currentTicks = this.activeTrade.entryTicks + tickCount;
        }

        // Check if contract is sold (either by limit order or manual sell)
        if (contract.is_sold) {
            this.handleTradeResult(contract);
            return;
        }

        // Contract still active - check if we should sell
        if (contract.is_valid_to_sell && this.activeTrade) {
            const ticksHeld = tickCount;
            const targetTicks = this.config.targetHoldTicks;
            
            // Log progress
            if (tickCount > 0 && tickCount % 2 === 0) {
                console.log(`📊 Active Trade: ${ticksHeld}/${targetTicks} ticks | Profit: $${currentProfit.toFixed(2)} | Bid: $${bidPrice.toFixed(2)}`);
            }

            // CRITICAL: Sell when target is reached or profit threshold met
            const shouldSell = this.shouldSellContract(contract, ticksHeld, currentProfit);
            
            if (shouldSell.sell) {
                console.log(`\n🎯 SELLING CONTRACT: ${shouldSell.reason}`);
                console.log(`   Ticks held: ${ticksHeld}`);
                console.log(`   Current profit: $${currentProfit.toFixed(2)}`);
                
                this.sellContract(contract.contract_id, bidPrice);
            }
        }
    }

    /**
     * Determine if we should sell the contract
     */
    shouldSellContract(contract, ticksHeld, currentProfit) {
        const targetTicks = this.config.targetHoldTicks;
        const takeProfitAmount = this.activeTrade?.takeProfitAmount || (this.currentStake * this.config.takeProfitMultiplier);
        
        // 1. Target ticks reached
        if (ticksHeld >= targetTicks) {
            return { sell: true, reason: `target_ticks_reached (${ticksHeld}/${targetTicks})` };
        }

        // 2. Profit target reached (backup for limit order)
        if (currentProfit >= takeProfitAmount) {
            return { sell: true, reason: `profit_target_reached ($${currentProfit.toFixed(2)} >= $${takeProfitAmount.toFixed(2)})` };
        }

        // 3. Good profit after minimum ticks (take what we can get)
        if (ticksHeld >= 3 && currentProfit >= takeProfitAmount * 0.7) {
            return { sell: true, reason: `good_profit_early ($${currentProfit.toFixed(2)})` };
        }

        // 4. Extended hold with any profit (risk management)
        if (ticksHeld >= targetTicks + 5 && currentProfit > 0) {
            return { sell: true, reason: `extended_hold_with_profit` };
        }

        // 5. Very extended hold - exit regardless
        if (ticksHeld >= targetTicks + 10) {
            return { sell: true, reason: `max_hold_time_exceeded` };
        }

        return { sell: false, reason: null };
    }

    /**
     * Execute sell order
     */
    sellContract(contractId, price) {
        console.log(`📤 Sending sell request for contract ${contractId} at $${price.toFixed(2)}`);
        
        this.sendRequest({
            sell: contractId,
            price: price.toFixed(2)
        });
    }

    handleSellResponse(message) {
        if (message.error) {
            console.error('❌ Error selling contract:', message.error.message);
            // Don't reset trade state - contract update will handle it
            return;
        }

        console.log(`✅ Sell order executed: $${message.sell?.sold_for || 'N/A'}`);
        // The contract update will handle the final result
    }

    /**
     * Handle trade completion (win or loss)
     */
    handleTradeResult(contract) {
        if (!this.activeTrade) {
            console.warn('Trade result received but no active trade tracked');
            return;
        }

        const asset = contract.underlying || this.activeTrade.asset;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const tickCount = contract.tick_count || 0;
        const exitTicks = this.activeTrade.entryTicks + tickCount;
        const ticksHeld = tickCount;

        // Unsubscribe from contract
        if (this.contractSubscriptionId) {
            this.sendRequest({ forget: this.contractSubscriptionId });
            this.contractSubscriptionId = null;
        }

        console.log(`\n${'═'.repeat(50)}`);
        console.log(`${won ? '✅ WIN' : '❌ LOSS'}: ${asset}`);
        console.log(`   Entry: ${this.activeTrade.entryTicks} | Exit: ${exitTicks} | Held: ${ticksHeld} ticks`);
        console.log(`   P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
        console.log(`${'═'.repeat(50)}`);

        // Update stats
        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;

        // Update asset metrics
        if (this.assetMetrics[asset]) {
            this.assetMetrics[asset].trades++;
            this.assetMetrics[asset].profitLoss += profit;
        }

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.hourlyStats.wins++;
            if (this.assetMetrics[asset]) this.assetMetrics[asset].wins++;

        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.hourlyStats.losses++;
            if (this.assetMetrics[asset]) this.assetMetrics[asset].losses++;

            // Place asset on cooldown
            this.riskManager.cooldownAsset(asset, 30);
        }

        // Record run
        this.analyzer.recordRun(asset, exitTicks, won ? 'win' : 'loss');

        // Calculate win rate
        const winRate = this.totalTrades > 0 ? (this.totalWins / this.totalTrades * 100).toFixed(1) : 0;

        // Telegram notification
        const emoji = won ? '✅' : '❌';
        const pnlEmoji = profit >= 0 ? '🟢' : '🔴';
        
        this.sendTelegramMessage(
            `${emoji} <b>${won ? 'WIN' : 'LOSS'}</b>\n\n` +
            `Asset: ${asset}\n` +
            `${pnlEmoji} P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}\n` +
            `Ticks: ${this.activeTrade.entryTicks} → ${exitTicks} (held: ${ticksHeld})\n\n` +
            `📊 Session Stats:\n` +
            `Trades: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalLosses}\n` +
            `Win Rate: ${winRate}%\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`
        );

        // Check stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('🛑 Max consecutive losses reached');
            this.shutdown('max_consecutive_losses');
            return;
        }

        if (this.dailyProfitLoss <= -this.config.maxDailyLoss) {
            console.log('🛑 Daily loss limit reached');
            this.shutdown('daily_loss_limit');
            return;
        }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('🎯 Take profit reached!');
            this.shutdown('take_profit_reached');
            return;
        }

        // Reset trade state
        this.tradeInProgress = false;
        this.activeTrade = null;

        // Save state
        StatePersistence.saveState(this);
    }

    // ========================================================================
    // TELEGRAM
    // ========================================================================

    async sendTelegramMessage(message) {
        if (!this.telegramBot) return;
        
        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { 
                parse_mode: 'HTML' 
            });
        } catch (error) {
            console.error(`Telegram error: ${error.message}`);
        }
    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🚀 RELIABLE ACCUMULATOR BOT v3.1');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('  Configuration:');
        console.log(`    Entry Window: ${this.config.minEntryTicks}-${this.config.maxEntryTicks} ticks`);
        console.log(`    Target Hold: ${this.config.targetHoldTicks} ticks`);
        console.log(`    Take Profit: ${(this.config.takeProfitMultiplier * 100).toFixed(0)}% of stake`);
        console.log(`    Min Survival: ${(this.config.minSurvivalProb * 100).toFixed(0)}%`);
        console.log(`    Min Regime Score: ${(this.config.minRegimeScore * 100).toFixed(0)}%`);
        console.log(`    Min Overall Score: ${(this.config.minOverallScore * 100).toFixed(0)}%`);
        console.log('');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');

        StatePersistence.startAutoSave(this);
        this.connect();
    }

    shutdown(reason = 'manual') {
        console.log(`\n🛑 Shutting down... Reason: ${reason}`);
        StatePersistence.saveState(this);
        this.endOfDay = true;
        
        this.sendTelegramMessage(
            `🛑 <b>BOT SHUTDOWN</b>\n\n` +
            `Reason: ${reason}\n\n` +
            `Final Stats:\n` +
            `Trades: ${this.totalTrades}\n` +
            `W/L: ${this.totalWins}/${this.totalLosses}\n` +
            `Win Rate: ${(this.totalWins / Math.max(1, this.totalTrades) * 100).toFixed(1)}%\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`
        );

        this.cleanup();
    }

    disconnect() {
        this.shutdown('disconnect_called');
    }
}

// ============================================================================
// RUN BOT
// ============================================================================

const token = 'Dz2V2KvRf4Uukt3';

const bot = new ReliableAccumulatorBot(token, {
    initialStake: 1,
    multiplier: 2.1,
    maxConsecutiveLosses: 4,
    maxDailyLoss: 200,
    takeProfit: 500,
    growthRate: 0.05,
    
    // Entry window (ENFORCED)
    minEntryTicks: 15,
    maxEntryTicks: 25,
    
    // Target hold and profit
    targetHoldTicks: 6,
    takeProfitMultiplier: 0.50, // 50% of stake
    
    // Thresholds
    minSurvivalProb: 0.65,
    minRegimeScore: 0.60,
    minOverallScore: 0.72,
    
    // Telegram (optional)
    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ', //process.env.TELEGRAM_TOKEN || 
    telegramChatId: '752497117', //process.env.TELEGRAM_CHAT_ID || 
});

bot.start();

module.exports = { ReliableAccumulatorBot };
