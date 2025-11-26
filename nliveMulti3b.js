require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

// Import Enhanced Configuration
const config = require('./config/enhancedConfig');

// Import Advanced Analysis Libraries
const BayesianEngine = require('./lib/bayesianEngine');
const MonteCarloSimulator = require('./lib/monteCarloSimulator');
const SurvivalAnalysis = require('./lib/survivalAnalysis');
const RegimeDetector = require('./lib/regimeDetector');
const CorrelationAnalyzer = require('./lib/correlationAnalyzer');
const KellyCalculator = require('./lib/kellyCalculator');
const PerformanceTracker = require('./analytics/performanceTracker');
const { mean, ema } = require('./utils/statisticalHelpers');

class EnhancedAccumulatorBot {
    constructor() {
        this.config = config;
        this.token = config.token;
        this.assets = config.assets;

        // Connection State
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.reconnectAttempts = 0;
        this.pingInterval = null;

        // Trading State
        this.tradeInProgress = false;
        this.isPaused = false;
        this.endOfDay = false;
        this.activeTrades = new Map(); // contractId -> tradeDetails
        this.pendingProposals = new Map(); // proposalId -> asset

        // Initialize Analysis Engines
        this.bayesian = new BayesianEngine();
        this.monteCarlo = new MonteCarloSimulator(config.analysis.monteCarlo);
        this.regimeDetector = new RegimeDetector();
        this.correlationAnalyzer = new CorrelationAnalyzer(config.riskControl);
        this.kellyCalculator = new KellyCalculator({
            ...config.stakeManagement,
            accountBalance: 1000 // Initial placeholder, will update from API
        });
        this.performanceTracker = new PerformanceTracker();

        // Asset-Specific State
        this.assetState = {};
        this.assets.forEach(asset => {
            this.assetState[asset] = {
                survivalAnalysis: new SurvivalAnalysis(),
                tickHistory: [], // Raw ticks
                multiTimeframeData: {
                    '60': [],   // 1 min
                    '300': [],  // 5 min
                    '900': [],  // 15 min
                    '3600': []  // 1 hour
                },
                lastDigits: [],
                consecutiveLosses: 0,
                currentStreak: 0, // Win streak for anti-martingale
                isSuspended: false,
                suspensionTime: 0,
                lastTradeTime: 0,
                currentProposalId: null
            };
        });

        // Email Timer
        this.startEmailTimer();
    }

    /**
     * Start the bot
     */
    start() {
        console.log('🚀 Starting Enhanced Accumulator Bot (v2.0)');
        console.log('===========================================');
        console.log('Features Enabled:');
        console.log(`✅ Bayesian Inference: ${config.analysis.bayesian.enabled ? 'ON' : 'OFF'}`);
        console.log(`✅ Monte Carlo Sim: ${config.analysis.monteCarlo.enabled ? 'ON' : 'OFF'}`);
        console.log(`✅ Regime Detection: ON`);
        console.log(`✅ Kelly Criterion: ${config.stakeManagement.useKelly ? 'ON' : 'OFF'}`);
        console.log(`✅ Anti-Martingale: ${config.stakeManagement.useAntiMartingale ? 'ON' : 'OFF'}`);
        console.log('===========================================');

        this.connect();
        this.checkTimeForDisconnectReconnect();
    }

    /**
     * Connect to Deriv API
     */
    connect() {
        if (this.isPaused) return;

        console.log('Connecting to Deriv API...');
        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=' + this.config.appId);

        this.ws.on('open', () => {
            console.log('Connected to Deriv API');
            this.connected = true;
            this.wsReady = true;
            this.reconnectAttempts = 0;
            this.authenticate();
            this.startPing();
        });

        this.ws.on('message', (data) => this.handleMessage(JSON.parse(data)));

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            this.handleDisconnect();
        });

        this.ws.on('close', () => {
            console.log('Disconnected from Deriv API');
            this.connected = false;
            this.handleDisconnect();
        });
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        clearInterval(this.pingInterval);

        if (!this.isPaused && this.reconnectAttempts < 100) {
            this.reconnectAttempts++;
            const delay = Math.min(30000, this.reconnectAttempts * 2000);
            console.log(`Reconnecting in ${delay / 1000}s...`);
            setTimeout(() => this.connect(), delay);
        }
    }

    startPing() {
        clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
            if (this.connected) this.ws.send(JSON.stringify({ ping: 1 }));
        }, 30000);
    }

    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        }
    }

    /**
     * Handle incoming WebSocket messages
     */
    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                this.handleAuth(message);
                break;
            case 'balance':
                this.handleBalance(message);
                break;
            case 'history':
                this.handleHistory(message);
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
            case 'error':
                console.error('API Error:', message.error.message);
                break;
        }
    }

    authenticate() {
        console.log('Attempting to authenticate...');
        this.sendRequest({ authorize: this.config.token });
    }

    subscribeToBalance() {
        this.sendRequest({ balance: 1, subscribe: 1 });
    }

    subscribeToHistory() {
        this.sendRequest({ history: 1, subscribe: 1 });
    }

    subscribeToTicks() {
        this.sendRequest({ tick: 1, subscribe: 1 });
    }

    handleAuth(message) {
        if (message.error) {
            console.error('Auth failed:', message.error.message);
            return;
        }
        console.log('Authentication successful');

        // Subscribe to balance updates
        this.sendRequest({ balance: 1, subscribe: 1 });

        // Initialize assets
        this.initializeAssets();
    }

    handleBalance(message) {
        if (message.balance) {
            const balance = parseFloat(message.balance.balance);
            this.kellyCalculator.updateBalance(balance);
            this.performanceTracker.currentBalance = balance;

            if (this.performanceTracker.initialBalance === 0) {
                this.performanceTracker.initialize(balance);
            }

            // Check stop loss / take profit
            const profit = balance - this.performanceTracker.initialBalance;

            if (profit <= -this.config.riskControl.stopLoss) {
                console.log('🛑 STOP LOSS REACHED. Stopping trading.');
                this.stopTrading();
            } else if (profit >= this.config.riskControl.takeProfit) {
                console.log('🎉 TAKE PROFIT REACHED. Stopping trading.');
                this.stopTrading();
            }

            // Check drawdown
            const maxDrawdown = this.performanceTracker.metrics.maxDrawdownPercent;
            if (maxDrawdown >= this.config.riskControl.maxDrawdownPercent) {
                console.log('🛑 MAX DRAWDOWN REACHED. Stopping trading.');
                this.stopTrading();
            }
        }
    }

    initializeAssets() {
        console.log('Initializing assets...');
        this.assets.forEach(asset => {
            // Get history
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.trading.requiredHistoryLength,
                end: 'latest',
                style: 'ticks'
            });

            // Subscribe to ticks
            this.sendRequest({ ticks: asset, subscribe: 1 });
        });
    }

    handleHistory(message) {
        const asset = message.echo_req.ticks_history;
        const prices = message.history.prices;
        const times = message.history.times;

        if (this.assetState[asset]) {
            // Process historical ticks
            prices.forEach((price, i) => {
                this.processTick(asset, price, times[i]);
            });
            console.log(`Loaded ${prices.length} historical ticks for ${asset}`);
        }
    }

    handleTick(message) {
        const asset = message.tick.symbol;
        const price = message.tick.quote;
        const time = message.tick.epoch;

        this.processTick(asset, price, time);

        // Check for trading opportunity
        this.analyzeAndTrade(asset);
    }

    processTick(asset, price, time) {
        const state = this.assetState[asset];
        if (!state) return;

        // Update raw history
        state.tickHistory.push(price);
        if (state.tickHistory.length > 2000) state.tickHistory.shift();

        // Update multi-timeframe data
        // We simulate OHLC data from ticks for simplicity
        this.updateTimeframeData(state, price, time);

        // Feed analyzers
        this.regimeDetector.detectRegime(state.tickHistory, asset);
        this.correlationAnalyzer.addTick(asset, price);

        // Extract last digit
        const digit = this.getLastDigit(price, asset);
        state.lastDigits.push(digit);
        if (state.lastDigits.length > 1000) state.lastDigits.shift();
    }

    updateTimeframeData(state, price, time) {
        // Simple aggregation for 1m, 5m, 15m, 1h
        // In a real app, we'd build proper OHLC candles
        // Here we just store samples for trend/volatility analysis

        const timeframes = [60, 300, 900, 3600];

        timeframes.forEach(tf => {
            // Only add if enough time passed (simple sampling)
            const last = state.multiTimeframeData[tf].slice(-1)[0];
            if (!last || time - last.time >= tf) {
                state.multiTimeframeData[tf].push({ time, price });
                if (state.multiTimeframeData[tf].length > 100) {
                    state.multiTimeframeData[tf].shift();
                }
            }
        });
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

    /**
     * Core Analysis & Trading Logic
     */
    analyzeAndTrade(asset) {
        if (this.tradeInProgress || this.isPaused || this.endOfDay) return;

        const state = this.assetState[asset];

        // Check suspension
        if (state.isSuspended) {
            if (Date.now() > state.suspensionTime) {
                state.isSuspended = false;
                console.log(`[${asset}] Suspension lifted`);
            } else {
                return;
            }
        }

        // Check cooldown
        if (Date.now() - state.lastTradeTime < this.config.trading.minWaitTime) return;

        // 1. Check Market Regime
        const regime = this.regimeDetector.currentRegime;
        const regimeParams = this.regimeDetector.getRegimeParams();

        if (!this.regimeDetector.shouldTradeInRegime()) {
            console.log(`[${asset}] Skipping due to regime: ${regime}`);
            return;
        }

        // 2. Check Correlation Exposure
        const correlatedAssets = this.correlationAnalyzer.getCorrelatedAssets(asset);
        const activeCorrelated = correlatedAssets.filter(c =>
            this.activeTrades.has(c.asset)
        );

        if (activeCorrelated.length > 0) {
            console.log(`[${asset}] Skipping due to correlated active trades`);
            return;
        }

        // 3. Request Proposal (to get latest stats)
        this.requestProposal(asset, regimeParams);
    }

    requestProposal(asset, regimeParams) {
        // Calculate dynamic growth rate
        let growthRate = this.config.trading.baseGrowthRate;

        if (this.config.trading.dynamicGrowthRate) {
            // Adjust based on regime
            growthRate = regimeParams.growthRate;

            // Adjust based on recent win rate
            const winRate = this.bayesian.getAssetWinProb(asset);
            if (winRate > 0.6) growthRate += 0.01;
            if (winRate < 0.4) growthRate -= 0.01;

            // Clamp
            growthRate = Math.max(this.config.trading.minGrowthRate,
                Math.min(this.config.trading.maxGrowthRate, growthRate));
        }

        const proposal = {
            proposal: 1,
            amount: 10, // Placeholder, will calculate actual stake later
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: growthRate
        };

        this.sendRequest(proposal);
    }

    handleProposal(message) {
        if (message.error) return;

        const proposal = message.proposal;
        const asset = message.echo_req.symbol;
        const state = this.assetState[asset];

        // Store proposal ID
        state.currentProposalId = proposal.id;
        this.pendingProposals.set(proposal.id, asset);

        // Get current tick count (ticks stayed in)
        const ticksStayedIn = proposal.contract_details.ticks_stayed_in;
        const currentTickCount = ticksStayedIn ? ticksStayedIn.length : 0;

        // 4. Survival Analysis
        // We want to enter when survival probability is high
        // For accumulators, we are betting it survives N more ticks
        const survivalProb = state.survivalAnalysis.predictSurvivalForNextTicks(currentTickCount, 10);

        // 5. Bayesian Probability
        const bayesianEst = this.bayesian.estimateWinProbability({
            asset,
            growthRate: message.echo_req.growth_rate,
            regime: this.regimeDetector.currentRegime
        });

        // 6. Monte Carlo Simulation
        // Validate the trade with simulations
        // We need to calculate optimal stake first to simulate properly

        // Calculate Stake using Kelly
        const winProb = bayesianEst.combined;
        const payoutRatio = this.kellyCalculator.estimatePayoutRatio(message.echo_req.growth_rate);

        let stake = this.kellyCalculator.calculateStakeSize(winProb, payoutRatio);

        // Apply Anti-Martingale if enabled
        if (this.config.stakeManagement.useAntiMartingale && state.currentStreak > 0) {
            const multiplier = Math.min(
                this.config.stakeManagement.maxStreakMultiplier,
                Math.pow(this.config.stakeManagement.winStreakMultiplier, state.currentStreak)
            );
            stake *= multiplier;
        }

        // Correlation adjustment
        stake = this.correlationAnalyzer.adjustPositionForCorrelation(stake, asset, []);

        // Run Monte Carlo with calculated stake
        const mcResult = this.monteCarlo.simulateTradeOutcomes({
            stake,
            growthRate: message.echo_req.growth_rate,
            winProbability: winProb,
            estimatedTicks: 10
        });

        // Final Decision
        const regimeParams = this.regimeDetector.getRegimeParams();
        const minSurvival = this.config.riskControl.minSurvivalProbability;

        const isSurvivalGood = survivalProb.conditionalSurvival > minSurvival;
        const isBayesianGood = bayesianEst.combined > 0.55; // Edge required
        const isMCGood = mcResult.isPositiveEV && mcResult.isAcceptableRisk;

        if (isSurvivalGood && isBayesianGood && isMCGood) {
            console.log(`[${asset}] ✅ TRADE SIGNAL | Stake: $${stake.toFixed(2)} | WinProb: ${(winProb * 100).toFixed(1)}% | Survival: ${(survivalProb.conditionalSurvival * 100).toFixed(1)}% | Regime: ${regimeParams.growthRate}`);
            this.placeTrade(proposal.id, stake);
        } else {
            console.log(`[${asset}] ❌ SKIP | S:${isSurvivalGood} B:${isBayesianGood} MC:${isMCGood} | Regime: ${regimeParams.growthRate}`);
        }
    }

    placeTrade(proposalId, stake) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.sendRequest({
            buy: proposalId,
            price: stake // Buy at calculated stake
        });
    }

    handleBuy(message) {
        if (message.error) {
            console.error('Buy error:', message.error.message);
            this.tradeInProgress = false;
            return;
        }

        const contractId = message.buy.contract_id;
        const asset = this.pendingProposals.get(message.buy.buy_price); // Approximate mapping

        console.log(`Trade placed! ID: ${contractId}`);

        // Subscribe to contract updates
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });

        // Record active trade
        this.activeTrades.set(contractId, {
            startTime: Date.now(),
            asset: asset // Note: might need better asset tracking if proposal mapping fails
        });
    }

    handleContractUpdate(message) {
        const contract = message.proposal_open_contract;

        if (contract.is_sold) {
            this.handleTradeResult(contract);
        }
    }

    handleTradeResult(contract) {
        const asset = contract.underlying;
        const profit = parseFloat(contract.profit);
        const won = profit > 0;
        const state = this.assetState[asset];

        console.log(`[${asset}] Trade ${won ? 'WON 🟢' : 'LOST 🔴'} | Profit: $${profit.toFixed(2)}`);

        // Update State
        this.tradeInProgress = false;
        state.lastTradeTime = Date.now();

        if (won) {
            state.consecutiveLosses = 0;
            state.currentStreak++;
            this.bayesian.updateAssetWinProb(asset, true);
        } else {
            state.consecutiveLosses++;
            state.currentStreak = 0;
            this.bayesian.updateAssetWinProb(asset, false);

            // Suspend asset if too many losses
            if (state.consecutiveLosses >= this.config.riskControl.maxConsecutiveLosses) {
                state.isSuspended = true;
                state.suspensionTime = Date.now() + this.config.riskControl.cooldownAfterLoss;
                console.log(`[${asset}] 🚫 Suspended for ${this.config.riskControl.cooldownAfterLoss / 1000}s`);
            }
        }

        // Update Learning Systems
        this.performanceTracker.recordTrade({
            asset,
            stake: parseFloat(contract.buy_price),
            growthRate: 0.03, // Need to track this better
            outcome: won ? 'win' : 'loss',
            profit,
            duration: 10, // Placeholder
            regime: this.regimeDetector.currentRegime
        });

        // Update Survival Analysis Data
        // We need to know how many ticks it survived. 
        // Contract details usually have tick count.
        if (contract.tick_count) {
            state.survivalAnalysis.addDataPoint(contract.tick_count, !won); // Event = loss (knockout)
        }

        this.activeTrades.delete(contract.contract_id);
    }

    stopTrading() {
        this.isPaused = true;
        this.endOfDay = true;
        this.sendEmailSummary();
        this.ws.close();
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            if (!this.config.trading.tradingHours.enabled) return;

            const now = new Date();
            // GMT+1 adjustment
            const hour = (now.getUTCHours() + 1) % 24;

            const start = this.config.trading.tradingHours.start;
            const end = this.config.trading.tradingHours.end;

            if (hour >= start && hour < end) {
                if (this.endOfDay) {
                    console.log('Starting trading day...');
                    this.endOfDay = false;
                    this.isPaused = false;
                    this.connect();
                }
            } else {
                if (!this.endOfDay) {
                    console.log('Ending trading day...');
                    this.stopTrading();
                }
            }
        }, 60000);
    }

    startEmailTimer() {
        setInterval(() => this.sendEmailSummary(), this.config.notifications.summaryInterval);
    }

    async sendEmailSummary() {
        if (!this.config.notifications.enabled) return;

        const summary = this.performanceTracker.getSummary();
        const text = `
            Enhanced Bot Performance Summary
            ================================
            Total Trades: ${summary.overview.totalTrades}
            Win Rate: ${(summary.overview.winRate * 100).toFixed(1)}%
            Total Profit: $${summary.financial.totalProfit.toFixed(2)}
            
            Current Balance: $${summary.financial.currentBalance.toFixed(2)}
            Max Drawdown: ${summary.risk.maxDrawdownPercent.toFixed(1)}%
            
            Regime: ${this.regimeDetector.currentRegime}
        `;

        const transporter = nodemailer.createTransport(this.config.notifications.emailConfig);
        try {
            await transporter.sendMail({
                from: this.config.notifications.emailConfig.auth.user,
                to: this.config.notifications.recipient,
                subject: 'Bot Performance Update',
                text: text
            });
        } catch (e) {
            console.error('Email error:', e);
        }
    }
}

// Start the bot
const bot = new EnhancedAccumulatorBot();
bot.start();
