/**
 * Deriv Digit Differ Trading Bot v3.0 - Multi-Asset Concurrent Trading
 * 
 * Features:
 * - Concurrent trading on multiple assets (R_10, R_25, R_50, R_75, R_100)
 * - Independent analysis and stake management per asset
 * - Rigorous statistical analysis on 5000 ticks per asset
 * - Strict trading conditions
 * - Global risk management across all assets
 * 
 * DISCLAIMER: No trading bot can guarantee 100% success.
 */

const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const config = require('./config2');
const StatisticalAnalyzer = require('./StatisticalAnalyzer2');

/**
 * Asset Handler - Manages individual asset state and analysis
 */
class AssetHandler {
    constructor(symbol, bot) {
        this.symbol = symbol;
        this.bot = bot;

        // Tick data
        this.tickHistory = [];
        this.subscriptionId = null;
        this.historyLoaded = false;

        // Trading state for this asset
        this.tradeInProgress = false;
        this.currentContractId = null;
        this.lastPredictedDigit = null;
        this.cooldownUntil = 0;

        // Per-asset stake management (independent Martingale)
        this.currentStake = config.TRADING.initialStake;
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.consecutiveLossesN = 0;

        // Per-asset statistics
        this.totalTrades = 0;
        this.wins = 0;
        this.losses = 0;
        this.profitLoss = 0;

        // Analyzer instance
        this.analyzer = new StatisticalAnalyzer(config.ANALYSIS);

        // Status
        this.isActive = true;
    }

    /**
     * Get decimal position for last digit extraction
     */
    getDecimalPosition() {
        switch (this.symbol) {
            case 'R_75':
            case 'R_50':
            case 'RDBEAR':
            case 'RDBULL':
                return 3; // 4th decimal (index 3)
            case 'R_10':
            case 'R_25':
                return 2; // 3rd decimal (index 2)
            default:
                return 1; // 2nd decimal (index 1)
        }
    }

    /**
     * Extract last digit from price quote
     */
    extractLastDigit(quote) {
        const quoteStr = quote.toString();
        const [, decimal = ''] = quoteStr.split('.');
        const position = this.getDecimalPosition();
        return decimal.length > position ? parseInt(decimal[position], 10) : 0;
    }

    /**
     * Process historical tick data
     */
    handleHistory(prices) {
        this.tickHistory = prices.map(price => this.extractLastDigit(price));
        this.historyLoaded = true;
        console.log(`✅ [${this.symbol}] Loaded ${this.tickHistory.length} historical ticks`);
    }

    /**
     * Process new tick
     */
    handleTick(tick) {
        const lastDigit = this.extractLastDigit(tick.quote);

        // Update history
        this.tickHistory.push(lastDigit);

        // Maintain history length
        if (this.tickHistory.length > config.ANALYSIS.minHistoryLength) {
            this.tickHistory.shift();
        }

        return lastDigit;
    }

    /**
     * Check if asset is ready to trade
     */
    isReadyToTrade() {
        // Check if active
        if (!this.isActive) return false;

        // Check if history is loaded
        if (!this.historyLoaded) return false;

        // Check minimum history
        if (this.tickHistory.length < config.ANALYSIS.minHistoryLength) return false;

        // Check if trade in progress
        if (this.tradeInProgress) return false;

        // Check cooldown
        if (Date.now() < this.cooldownUntil) return false;

        // Check max consecutive losses for this asset
        // if (this.consecutiveLosses >= config.TRADING.maxConsecutiveLosses) {
        //     this.isActive = false;
        //     console.log(`⛔ [${this.symbol}] Deactivated: Max consecutive losses reached`);
        //     return false;
        // }

        // Check if stake exceeds max
        // if (this.currentStake >= config.TRADING.maxStake) {
        //     this.isActive = false;
        //     console.log(`⛔ [${this.symbol}] Deactivated: Max stake reached`);
        //     return false;
        // }

        return true;
    }

    /**
     * Analyze and determine if should trade
     */
    analyze() {
        if (!this.isReadyToTrade()) return null;

        const analysis = this.analyzer.analyze(this.tickHistory);

        // console.log(`[${this.symbol}] Analyzed: ${analysis.predictedDigit} | ${analysis.confidence.toFixed(2)}% | ${analysis.repetitionRate.toFixed(2)}% | ${analysis.streak.toFixed(2)}% | ${analysis.streakDirection}| ${analysis.streakDirection}`);
        console.log(`[${this.symbol}] Analyzed: ${analysis.predictedDigit} | ${analysis.confidence.toFixed(2)}%`);

        if (!analysis.shouldTrade) return null;

        // Additional check: Don't trade same digit consecutively
        if (analysis.predictedDigit === this.lastPredictedDigit) {
            return null;
        }

        return analysis;
    }

    /**
     * Mark trade as started
     */
    startTrade(analysis) {
        this.tradeInProgress = true;
        this.lastPredictedDigit = analysis.predictedDigit;
    }

    /**
     * Process trade result
     */
    processResult(won, profit) {
        this.totalTrades++;
        this.profitLoss += profit;

        if (won) {
            this.wins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            // this.consecutiveLossesN = 0;
            this.currentStake = config.TRADING.initialStake;
        } else {
            this.losses++;
            this.isWinTrade = false;
            this.consecutiveLosses++;
            // this.consecutiveLossesN++;

            // Update global consecutive loss counters
            // if (this.consecutiveLossesN === 2) this.consecutiveLosses2++;
            // else if (this.consecutiveLossesN === 3) this.consecutiveLosses3++;
            // else if (this.consecutiveLossesN === 4) this.consecutiveLosses4++;
            // else if (this.consecutiveLossesN === 5) this.consecutiveLosses5++;

            // Apply Martingale
            this.currentStake = Math.ceil(this.currentStake * config.TRADING.multiplier * 100) / 100;
            // this.shouldStopGlobal();
        }

        // Set cooldown
        this.cooldownUntil = Date.now() + config.TIMING.tradeCooldown;

        // Reset trade state
        this.tradeInProgress = false;
        this.currentContractId = null;
    }

    /**
     * Get status summary
     */
    getStatus() {
        const winRate = this.totalTrades > 0
            ? ((this.wins / this.totalTrades) * 100).toFixed(1)
            : '0.0';

        return {
            symbol: this.symbol,
            active: this.isActive,
            historyLoaded: this.historyLoaded,
            historyLength: this.tickHistory.length,
            tradeInProgress: this.tradeInProgress,
            totalTrades: this.totalTrades,
            wins: this.wins,
            losses: this.losses,
            winRate: `${winRate}%`,
            profitLoss: this.profitLoss.toFixed(2),
            currentStake: this.currentStake.toFixed(2),
            consecutiveLosses: this.consecutiveLosses
        };
    }
}

/**
 * Main Multi-Asset Trading Bot
 */
class MultiAssetDerivBot {
    constructor() {
        // WebSocket
        this.ws = null;
        this.connected = false;
        this.authorized = false;

        // Asset handlers - one per asset
        this.assets = new Map();

        // Contract tracking - maps contract ID to asset symbol
        this.activeContracts = new Map();

        // Global statistics
        this.globalStats = {
            totalTrades: 0,
            totalWins: 0,
            totalLosses: 0,
            totalProfitLoss: 0,
            startTime: null
        };

        // Global consecutive loss counters
        this.consecutiveLossesN = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.maxConsecutiveLosses = 0;
        this.endOfDay = false;
        this.isWinTrade = false;

        // Connection management
        this.reconnectAttempts = 0;
        this.isRunning = false;

        // Initialize asset handlers
        this.initializeAssets();

        // Start email timer
        this.startSummaryEmailTimer();
    }

    /**
     * Initialize asset handlers for all configured assets
     */
    initializeAssets() {
        for (const symbol of config.ASSETS) {
            this.assets.set(symbol, new AssetHandler(symbol, this));
        }
        console.log(`📊 Initialized ${this.assets.size} asset handlers: ${config.ASSETS.join(', ')}`);
    }

    /**
     * Start the bot
     */
    start() {
        this.printBanner();
        this.globalStats.startTime = new Date();
        this.isRunning = true;
        this.connect();
        // this.checkTimeForDisconnectReconnect();
    }

    /**
     * Print startup banner
     */
    printBanner() {
        console.log('\n');
        console.log('╔══════════════════════════════════════════════════════════════════╗');
        console.log('║       DERIV DIGIT DIFFER BOT v3.0 - MULTI-ASSET                 ║');
        console.log('║       Concurrent Trading on Multiple Synthetic Indices          ║');
        console.log('╠══════════════════════════════════════════════════════════════════╣');
        console.log(`║  Assets:              ${config.ASSETS.join(', ').padEnd(43)}║`);
        console.log(`║  Min History:         ${config.ANALYSIS.minHistoryLength} ticks per asset                      ║`);
        console.log(`║  Min Confidence:      ${(config.ANALYSIS.minConfidence * 100).toFixed(0)}%                                          ║`);
        console.log(`║  Max Repetition Rate: ${(config.ANALYSIS.maxRepetitionRate * 100).toFixed(0)}%                                           ║`);
        console.log(`║  Initial Stake:       $${config.TRADING.initialStake.toFixed(2)} per asset                         ║`);
        console.log(`║  Max Concurrent:      ${config.TRADING.maxConcurrentTrades} trades                                   ║`);
        console.log('╚══════════════════════════════════════════════════════════════════╝');
        console.log('\n');
    }

    /**
     * Connect to Deriv WebSocket API
     */
    connect() {
        if (!this.endOfDay) {
            console.log('🔌 Connecting to Deriv API...');

            this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            this.ws.on('open', () => {
                console.log('✅ WebSocket connected');
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
                console.error('❌ WebSocket error:', error.message);
            });

            this.ws.on('close', () => {
                console.log('🔌 WebSocket disconnected');
                this.connected = false;
                this.authorized = false;

                if (this.isRunning) {
                    this.handleReconnect();
                }
            });
        }
    }

    /**
     * Handle reconnection
     */
    handleReconnect() {
        if (!this.endOfDay) {
            if (this.reconnectAttempts >= config.TIMING.maxReconnectAttempts) {
                console.error('❌ Max reconnection attempts reached. Stopping bot.');
                this.stop();
                return;
            }

            this.reconnectAttempts++;
            console.log(`🔄 Reconnecting in ${config.TIMING.reconnectInterval / 1000}s... (Attempt ${this.reconnectAttempts})`);

            setTimeout(() => {
                if (this.isRunning) {
                    this.connect();
                }
            }, config.TIMING.reconnectInterval);
        }
    }

    /**
     * Send request to API
     */
    send(request) {
        if (this.connected && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(request));
        } else {
            console.warn('⚠️ Cannot send request - not connected');
        }
    }

    /**
     * Authenticate with API token
     */
    authenticate() {
        console.log('🔐 Authenticating...');
        this.send({ authorize: config.API_TOKEN });
    }

    /**
     * Handle incoming messages
     */
    handleMessage(message) {
        const { msg_type, error } = message;

        if (error) {
            this.handleError(error, message);
            return;
        }

        switch (msg_type) {
            case 'authorize':
                this.handleAuthorize(message);
                break;
            case 'history':
                this.handleHistory(message);
                break;
            case 'tick':
                this.handleTick(message);
                break;
            case 'buy':
                this.handleBuy(message);
                break;
            case 'proposal_open_contract':
                this.handleContractUpdate(message);
                break;
            default:
                break;
        }
    }

    /**
     * Handle authorization
     */
    handleAuthorize(message) {
        if (message.authorize) {
            console.log('✅ Authentication successful');
            console.log(`   Account: ${message.authorize.loginid}`);
            console.log(`   Balance: $${parseFloat(message.authorize.balance).toFixed(2)}`);
            this.authorized = true;
            this.subscribeToAllAssets();
        }
    }

    /**
     * Handle errors
     */
    handleError(error, message) {
        console.error(`❌ API Error: ${error.message} (${error.code})`);

        switch (error.code) {
            case 'InvalidToken':
                console.error('   Please check your API token in config.js');
                this.stop();
                break;
            case 'RateLimit':
                console.log('   Rate limited. Waiting 60 seconds...');
                setTimeout(() => this.subscribeToAllAssets(), 60000);
                break;
            case 'ContractBuyValidationError':
                // Find the asset and reset its trade state
                if (message.echo_req && message.echo_req.parameters) {
                    const symbol = message.echo_req.parameters.symbol;
                    const asset = this.assets.get(symbol);
                    if (asset) {
                        asset.tradeInProgress = false;
                        console.log(`   [${symbol}] Trade failed, resetting state`);
                    }
                }
                break;
            default:
                break;
        }
    }

    /**
     * Subscribe to all assets
     */
    subscribeToAllAssets() {
        console.log('\n📡 Subscribing to all assets...\n');

        for (const symbol of config.ASSETS) {
            // Request history
            this.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: config.ANALYSIS.minHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });

            // Subscribe to live ticks
            this.send({
                ticks: symbol,
                subscribe: 1
            });
        }
    }

    /**
     * Handle historical data
     */
    handleHistory(message) {
        const { history, echo_req } = message;

        if (!history || !history.prices || !echo_req) return;

        const symbol = echo_req.ticks_history;
        const asset = this.assets.get(symbol);

        if (asset) {
            asset.handleHistory(history.prices);
        }
    }

    /**
     * Handle live tick
     */
    handleTick(message) {
        const { tick, subscription } = message;

        if (!tick) return;

        const symbol = tick.symbol;
        const asset = this.assets.get(symbol);

        if (!asset) return;

        // Store subscription ID
        if (subscription) {
            asset.subscriptionId = subscription.id;
        }

        // Process tick
        const lastDigit = asset.handleTick(tick);

        // Keep history at required length
        if (asset.tickHistory.length > config.ANALYSIS.minHistoryLength) {
            asset.tickHistory.shift();
        }

        // Log progress if still loading
        if (!asset.historyLoaded || asset.tickHistory.length < config.ANALYSIS.minHistoryLength) {
            const progress = ((asset.tickHistory.length / config.ANALYSIS.minHistoryLength) * 100).toFixed(1);
            process.stdout.write(`\r⏳ [${symbol}] Loading: ${asset.tickHistory.length}/${config.ANALYSIS.minHistoryLength} (${progress}%)    `);
            return;
        }

        // Analyze and potentially trade
        this.analyzeAndTrade(asset);
    }

    /**
     * Analyze asset and execute trade if conditions met
     */
    analyzeAndTrade(asset) {
        // Check global stop conditions first
        // if (this.shouldStopGlobal()) {
        //     this.stop();
        //     return;
        // }

        // Check concurrent trade limit
        const currentActiveTradesCount = this.getActiveTradesCount();
        if (currentActiveTradesCount >= config.TRADING.maxConcurrentTrades) {
            return;
        }

        // Analyze
        const analysis = asset.analyze();

        if (!analysis) return;

        // Execute trade
        this.executeTrade(asset, analysis);
    }

    /**
     * Get count of currently active trades
     */
    getActiveTradesCount() {
        let count = 0;
        for (const [, asset] of this.assets) {
            if (asset.tradeInProgress) count++;
        }
        return count;
    }

    /**
     * Execute a trade
     */
    executeTrade(asset, analysis) {
        asset.startTrade(analysis);

        console.log('\n');
        console.log('╔════════════════════════════════════════════════════════════════╗');
        console.log('║                      🎯 PLACING TRADE 🎯                        ║');
        console.log('╠════════════════════════════════════════════════════════════════╣');
        console.log(`║  Asset:       ${asset.symbol.padEnd(49)}║`);
        console.log(`║  Contract:    DIGIT DIFFER                                     ║`);
        console.log(`║  Barrier:     ${analysis.predictedDigit} (betting this digit WON'T repeat)           ║`);
        console.log(`║  Stake:       $${asset.currentStake.toFixed(2).padEnd(47)}║`);
        console.log(`║  Confidence:  ${(analysis.confidence * 100).toFixed(1)}%                                           ║`);
        console.log('╚════════════════════════════════════════════════════════════════╝');

        this.send({
            buy: 1,
            price: asset.currentStake.toFixed(2),
            parameters: {
                amount: asset.currentStake.toFixed(2),
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: asset.symbol,
                barrier: analysis.predictedDigit
            }
        });
    }

    /**
     * Handle buy response
     */
    handleBuy(message) {
        if (message.buy) {
            const contractId = message.buy.contract_id;
            const symbol = message.echo_req?.parameters?.symbol;

            if (symbol) {
                // Map contract to asset
                this.activeContracts.set(contractId, symbol);

                const asset = this.assets.get(symbol);
                if (asset) {
                    asset.currentContractId = contractId;
                }

                console.log(`✅ [${symbol}] Trade placed - Contract ID: ${contractId}`);
            }

            // Subscribe to contract updates
            this.send({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1
            });
        }
    }

    /**
     * Handle contract update
     */
    handleContractUpdate(message) {
        const contract = message.proposal_open_contract;

        if (!contract || !contract.is_sold) return;

        const contractId = contract.contract_id;
        const symbol = this.activeContracts.get(contractId);

        if (!symbol) return;

        const asset = this.assets.get(symbol);
        if (!asset) return;

        this.processTradeResult(asset, contract);

        // Clean up contract mapping
        this.activeContracts.delete(contractId);
    }

    /**
     * Process trade result
     */
    processTradeResult(asset, contract) {
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        // Update asset stats
        asset.processResult(won, profit);

        // Update global stats
        this.globalStats.totalTrades++;
        this.globalStats.totalProfitLoss += profit;

        if (won) {
            this.globalStats.totalWins++;
            this.consecutiveLossesN = 0;

            console.log('\n');
            console.log('╔════════════════════════════════════════════════════════════════╗');
            console.log(`║                     ✅ [${asset.symbol}] TRADE WON ✅                      ║`);
            console.log(`║  Profit: +$${profit.toFixed(2).padEnd(52)}║`);
            console.log('╚════════════════════════════════════════════════════════════════╝');
        } else {
            this.globalStats.totalLosses++;
            this.consecutiveLossesN++;


            console.log('\n');
            console.log('╔════════════════════════════════════════════════════════════════╗');
            console.log(`║                     ❌ [${asset.symbol}] TRADE LOST ❌                     ║`);
            console.log(`║  Loss: -$${Math.abs(profit).toFixed(2).padEnd(54)}║`);
            console.log(`║  Consecutive Losses: ${this.consecutiveLossesN.toString().padEnd(42)}║`);
            console.log(`║  Next Stake: $${asset.currentStake.toFixed(2).padEnd(48)}║`);
            console.log('╚════════════════════════════════════════════════════════════════╝');

            // Send notification on loss
            if (config.EMAIL.enabled) {
                this.sendLossNotification(asset, contract);
            }

            this.shouldStopGlobal();

            // Update global consecutive loss counters
            if (this.consecutiveLossesN === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLossesN === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLossesN === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLossesN === 5) this.consecutiveLosses5++;
        }

        // Log summaries
        this.logAssetSummary(asset);
        this.logGlobalSummary();
    }

    /**
     * Log individual asset summary
     */
    logAssetSummary(asset) {
        const status = asset.getStatus();

        console.log(`\n┌─────── ${asset.symbol} Summary ───────┐`);
        console.log(`│  Trades: ${status.totalTrades} | W/L: ${status.wins}/${status.losses} (${status.winRate})`);
        console.log(`│  P/L: $${status.profitLoss} | Stake: $${status.currentStake}`);
        console.log(`│  Status: ${status.active ? '🟢 Active' : '🔴 Inactive'}`);
        console.log(`└${'─'.repeat(35)}┘`);
    }

    /**
     * Log global summary
     */
    logGlobalSummary() {
        const winRate = this.globalStats.totalTrades > 0
            ? ((this.globalStats.totalWins / this.globalStats.totalTrades) * 100).toFixed(1)
            : '0.0';

        const activeAssets = Array.from(this.assets.values()).filter(a => a.isActive).length;

        console.log('\n');
        console.log('┌══════════════════════════════════════════════════════════════════┐');
        console.log('│                      GLOBAL SESSION SUMMARY                      │');
        console.log('├══════════════════════════════════════════════════════════════════┤');
        console.log(`│  Active Assets:     ${activeAssets}/${this.assets.size}`.padEnd(67) + '│');
        console.log(`│  Total Trades:      ${this.globalStats.totalTrades}`.padEnd(67) + '│');
        console.log(`│  Wins / Losses:     ${this.globalStats.totalWins} / ${this.globalStats.totalLosses}`.padEnd(67) + '│');
        console.log(`│  Win Rate:          ${winRate}%`.padEnd(67) + '│');
        console.log(`│  Total P/L:         $${this.globalStats.totalProfitLoss.toFixed(2)}`.padEnd(67) + '│');
        console.log('└══════════════════════════════════════════════════════════════════┘');
    }

    /**
     * Check global stop conditions
     */
    shouldStopGlobal() {
        // Check global stop loss
        if (this.globalStats.totalProfitLoss <= -config.TRADING.stopLoss || this.consecutiveLossesN >= config.TRADING.maxConsecutiveLosses) {
            console.log('\n⛔ STOPPING: Global stop loss reached');
            this.sendFinalSummary();
            this.stop();
            this.endOfDay = true;
        }

        // Check global take profit
        if (this.globalStats.totalProfitLoss >= config.TRADING.takeProfit) {
            console.log('\n🎉 STOPPING: Global take profit reached!');
            this.sendFinalSummary();
            this.stop();
            this.endOfDay = true;
            // return true;
        }

        // Check if all assets are inactive
        const activeAssets = Array.from(this.assets.values()).filter(a => a.isActive).length;
        if (activeAssets === 0) {
            console.log('\n⛔ STOPPING: All assets inactive');
            return true;
        }

        return false;
    }

    /**
     * Check if it's time to disconnect or reconnect
     */
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM GMT+1, reconnecting the bot.");
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendFinalSummary();
                    this.endOfDay = true;
                    this.stop();
                }
            }
        }, 5000);
    }

    /**
     * Start summary email timer
     */
    startSummaryEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendSummary();
            }
        }, 1800000);
    }

    /**
     * Send loss notification
     */
    async sendLossNotification(asset, contract) {
        if (!config.EMAIL.enabled) return;

        try {
            const transporter = nodemailer.createTransport({
                service: config.EMAIL.service,
                auth: {
                    user: config.EMAIL.user,
                    pass: config.EMAIL.pass
                }
            });

            const recentDigits = asset.tickHistory.slice(-10).join(', ');

            await transporter.sendMail({
                from: config.EMAIL.user,
                to: config.EMAIL.recipient,
                subject: `Multix2Bot - [${asset.symbol}] Trade Lost`,
                text: `
                    TRADE LOSS NOTIFICATION
                    =======================

                    Asset: ${asset.symbol}
                     Global Stats:
                    - Total Trades: ${this.globalStats.totalTrades}
                    - Total P/L: $${this.globalStats.totalProfitLoss.toFixed(2)}
                    Loss Amount: $${Math.abs(parseFloat(contract.profit)).toFixed(2)}
                    - Losses: ${this.globalStats.totalLosses}
                    x2: ${this.consecutiveLosses2}
                    x3: ${this.consecutiveLosses3}
                    x4: ${this.consecutiveLosses4}
                    x5: ${this.consecutiveLosses5}

                    Asset P/L: $${asset.profitLoss.toFixed(2)}
                    Next Stake: $${asset.currentStake.toFixed(2)}

                    Recent Digits: ${recentDigits} 
                `
            });
        } catch (error) {
            console.error('Email error:', error.message);
        }
    }

    /**
     * Stop the bot
     */
    stop() {
        console.log('\n');
        console.log('╔════════════════════════════════════════════════════════════════╗');
        console.log('║                        BOT STOPPED                             ║');
        console.log('╚════════════════════════════════════════════════════════════════╝');

        // Log final summaries for each asset
        console.log('\n═══════════════ FINAL ASSET SUMMARIES ═══════════════\n');
        for (const [symbol, asset] of this.assets) {
            const status = asset.getStatus();
            console.log(`${symbol}: Trades=${status.totalTrades}, W/L=${status.wins}/${status.losses}, P/L=$${status.profitLoss}`);
        }

        this.logGlobalSummary();

        this.isRunning = false;

        // Unsubscribe from all
        for (const [, asset] of this.assets) {
            if (asset.subscriptionId) {
                this.send({ forget: asset.subscriptionId });
            }
        }

        if (this.ws) {
            this.ws.close();
        }

        // Send final summary email
        if (config.EMAIL.enabled) {
            this.sendFinalSummary();
        }
    }

    /**
     * Send final summary email
     */
    async sendFinalSummary() {
        if (!config.EMAIL.enabled) return;

        try {
            const transporter = nodemailer.createTransport({
                service: config.EMAIL.service,
                auth: {
                    user: config.EMAIL.user,
                    pass: config.EMAIL.pass
                }
            });

            const duration = ((Date.now() - this.globalStats.startTime.getTime()) / 60000).toFixed(1);
            const winRate = this.globalStats.totalTrades > 0
                ? ((this.globalStats.totalWins / this.globalStats.totalTrades) * 100).toFixed(1)
                : '0.0';

            let assetSummary = '';
            for (const [symbol, asset] of this.assets) {
                const status = asset.getStatus();
                assetSummary += `\n${symbol}: Trades=${status.totalTrades}, W/L=${status.wins}/${status.losses}, P/L=$${status.profitLoss}`;
            }

            await transporter.sendMail({
                from: config.EMAIL.user,
                to: config.EMAIL.recipient,
                subject: `Multix2Bot - Session Complete`,
                text: `
                    SESSION COMPLETE - MULTI-ASSET BOT
                    ==================================

                    Duration: ${duration} minutes
                    Assets Traded: ${config.ASSETS.join(', ')}

                    Global Stats:
                    - Total Trades: ${this.globalStats.totalTrades}
                    - Win Rate: ${winRate}%
                    - Total P/L: $${this.globalStats.totalProfitLoss.toFixed(2)}
                    - Wins: ${this.globalStats.totalWins}
                    - Losses: ${this.globalStats.totalLosses}
                    - x2: ${this.consecutiveLosses2}
                    - x3: ${this.consecutiveLosses3}
                    - x4: ${this.consecutiveLosses4}
                    - x5: ${this.consecutiveLosses5}

                    Per-Asset Summary:
                    ${assetSummary}
                `
            });
        } catch (error) {
            console.error('Email error:', error.message);
        }
    }

    /**
     * Send summary email
     */
    async sendSummary() {
        if (!config.EMAIL.enabled) return;

        try {
            const transporter = nodemailer.createTransport({
                service: config.EMAIL.service,
                auth: {
                    user: config.EMAIL.user,
                    pass: config.EMAIL.pass
                }
            });

            const duration = ((Date.now() - this.globalStats.startTime.getTime()) / 60000).toFixed(1);
            const winRate = this.globalStats.totalTrades > 0
                ? ((this.globalStats.totalWins / this.globalStats.totalTrades) * 100).toFixed(1)
                : '0.0';

            let assetSummary = '';
            for (const [symbol, asset] of this.assets) {
                const status = asset.getStatus();
                assetSummary += `\n${symbol}: Trades=${status.totalTrades}, W/L=${status.wins}/${status.losses}, P/L=$${status.profitLoss}`;
            }

            await transporter.sendMail({
                from: config.EMAIL.user,
                to: config.EMAIL.recipient,
                subject: `Multix2Bot - Trade Summary`,
                text: `
                    TRADE SUMMARY - MULTI-ASSET BOT
                    ==================================

                    Duration: ${duration} minutes
                    Assets Traded: ${config.ASSETS.join(', ')}

                    Global Stats:
                    - Total Trades: ${this.globalStats.totalTrades}
                    - Win Rate: ${winRate}%
                    - Total P/L: $${this.globalStats.totalProfitLoss.toFixed(2)}
                    - Wins: ${this.globalStats.totalWins}
                    - Losses: ${this.globalStats.totalLosses}
                    - x2: ${this.consecutiveLosses2}
                    - x3: ${this.consecutiveLosses3}
                    - x4: ${this.consecutiveLosses4}
                    - x5: ${this.consecutiveLosses5}

                    Per-Asset Summary:
                    ${assetSummary}
                `
            });
        } catch (error) {
            console.error('Email error:', error.message);
        }
    }

    /**
     * Display real-time status dashboard
     */
    displayDashboard() {
        console.clear();
        console.log('\n═══════════════ LIVE DASHBOARD ═══════════════\n');

        for (const [symbol, asset] of this.assets) {
            const status = asset.getStatus();
            const indicator = status.active ? '🟢' : '🔴';
            const tradeStatus = status.tradeInProgress ? '⏳' : '✓';

            console.log(`${indicator} ${symbol.padEnd(8)} | H:${status.historyLength.toString().padStart(5)} | T:${status.totalTrades} W:${status.wins} L:${status.losses} | P/L:$${status.profitLoss.padStart(8)} | S:$${status.currentStake} ${tradeStatus}`);
        }

        console.log(`\n📊 Global P/L: $${this.globalStats.totalProfitLoss.toFixed(2)} | Trades: ${this.globalStats.totalTrades}`);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n🛑 Received shutdown signal...');
    bot.stop();
    setTimeout(() => process.exit(0), 2000);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

// Start the bot
const bot = new MultiAssetDerivBot();
bot.start();

module.exports = MultiAssetDerivBot;
