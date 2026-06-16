/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         accumBotM — Enhanced Multi-Asset Accumulator Bot    ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  ORIGINAL STRATEGY (preserved):                              ║
 * ║  • Digit-frequency analysis on StayIN sequence               ║
 * ║  • Filters digits that appeared exactly filterNum times      ║
 * ║  • Entry when current digit count matches filtered array     ║
 * ║  • Martingale recovery with multiplier                       ║
 * ║                                                              ║
 * ║  UPGRADES:                                                   ║
 * ║  • Multi-asset concurrent trading (one contract per asset)   ║
 * ║  • Telegram notifications (replaces Gmail)                   ║
 * ║  • State persistence with auto-save                          ║
 * ║  • Trade watchdog for stuck contract recovery                ║
 * ║  • Robust reconnection with exponential backoff              ║
 * ║  • WebSocket ping keep-alive                                 ║
 * ║  • INTELLIGENT ASSET FILTERING (NEW):                        ║
 * ║    - Active Assets: stayedInArray < 1600 (ready to trade)   ║
 * ║    - Pending Assets: stayedInArray >= 1600 (waiting)         ║
 * ║    - Dynamic asset management between lists                  ║
 * ║    - Periodic scanning of pending assets (30s interval)      ║
 * ║    - Optimized performance by analyzing only active assets   ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// STATE PERSISTENCE MANAGER
// ══════════════════════════════════════════════════════════════════════════════
const STATE_FILE = path.join(__dirname, 'accumBC1_09_state.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                    consecutiveLosses2: bot.consecutiveLosses2,
                    consecutiveLosses3: bot.consecutiveLosses3,
                    consecutiveLosses4: bot.consecutiveLosses4,
                    consecutiveLosses5: bot.consecutiveLosses5,
                    consecutiveLosses6: bot.consecutiveLosses6,
                    kCountNum: bot.kCountNum,
                    tradedDigitArray: bot.tradedDigitArray,
                    tradedDigitArray2: bot.tradedDigitArray2,
                    Sys1: bot.Sys1,
                    Sys2: bot.Sys2,
                    kCountNum: bot.kCountNum,
                    filterNum: bot.filterNum,
                },
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
                console.warn(`⚠️  Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
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
        if (bot.autoSaveInterval) clearInterval(bot.autoSaveInterval);
        bot.autoSaveInterval = setInterval(() => {
            if (bot.connected && !bot.endOfDay) StatePersistence.saveState(bot);
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

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════
class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // ── Multi-asset support ──────────────────────────────────────────────
        this.assets = config.assets;

        // ── Asset Filtering System ───────────────────────────────────────────
        this.activeAssets = new Set();      // Assets ready for trading (stayedInArray < 1600)
        this.pendingAssets = new Set();     // Assets waiting (stayedInArray >= 1600)
        this.assetStayedInValues = {};      // Track current stayedInArray total for each asset
        this.pendingScanInterval = null;    // Timer for periodic pending asset scan

        this.config = {
            initialStake: config.initialStake || 1,
            initialStake2: config.initialStake2 || 1,
            multiplier: config.multiplier || 6,
            multiplier2: config.multiplier2 || 6,
            recoveryWinNum: config.recoveryWinNum || 8,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            takeProfit: config.takeProfit || 100,
            stopLoss: config.stopLoss || 100,
            // Accumulator specific
            growthRate: config.growthRate || 0.02,
            takeProfitMultiplier: config.takeProfitMultiplier || 0.20,
            takeProfitMultiplier2: config.takeProfitMultiplier2 || 0.20,
            filterNum: config.filterNum || 5,
            scanTimer: config.scanTimer || 60000,
            STAYED_IN_THRESHOLD: config.STAYED_IN_THRESHOLD, 

            // Reconnection
            maxReconnectAttempts: 50,
            reconnectDelay: 5000,

            // Trade throttle per asset
            minTimeBetweenTrades: 5000,

            // History
            requiredHistoryLength: 100,
            analysisInterval: 1,

            // Telegram
            telegramToken: '8218636914:AAGvaKFh8MT769-_9eOEiU4XKufL0aHRhZ4',
            telegramChatId: '752497117',
        };

        // ── Trading state (original logic preserved) ─────────────────────────
        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.consecutiveLosses6 = 0;
        this.consecutiveLosses7 = 0;
        this.consecutiveLosses8 = 0;
        this.consecutiveLosses9 = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.dailyProfitLoss = 0;
        this.Pause = false;
        this.endOfDay = false;
        this.kCount = false;
        this.kCountNum = 0;
        this.kLoss = 0.01;
        this.confidenceThreshold = 0.5;
        this.kTradeCount = 0;
        this.isWinTrade = false;
        this.waitTime = 150000;
        this.LossDigitsList = [];
        this.threeConsecutiveDigits = 0;
        this.predictedType = '';
        this.Sys1 = 0;
        this.tradedDigitArray = [];
        this.tradedDigitArray2 = [];
        this.filteredArray = [];
        this.tradeNum = Math.floor(Math.random() * (40 - 21 + 1)) + 21;
        this.filterNum = this.config.filterNum;
        this.Percentage = 0;
        this.predictedDigit = null;
        this.currentTick = 0;
        this.Sys2 = false;
        this.TP_SL = false;
        this.scanningTimer = this.config.scanTimer;

        // ── Multi-asset active trades ────────────────────────────────────────
        this.activeTrades = {};          // { asset: { contractId, status, ... } }
        this.contractSubscriptions = {}; // { asset: subscriptionId }
        this.tickSubscriptionIds = {};
        this.lastTradeTime = {};

        // ── Per-asset price/digit histories ──────────────────────────────────
        this.priceHistories = {};        // raw prices (not digits, for context)
        this.tickHistory = {};           // digit sequences per asset
        this.lastDigitsList = {};        // recent digits per asset
        this.tickCounts = {};            // tick counter per asset
        this.assetStates = {};           // { asset: { proposalId, ... } }

        // ── Asset metrics ────────────────────────────────────────────────────
        this.assetMetrics = {};

        // ── Asset suspension (focus on loss asset) ───────────────────────────
        this.suspendedAssets = new Set();
        this.focusAsset = null;

        // ── Telegram ─────────────────────────────────────────────────────────
        this.telegramBot = null;
        if (this.config.telegramToken && this.config.telegramChatId) {
            this.telegramBot = new TelegramBot(this.config.telegramToken, { polling: false });
        }
        this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0 };

        // ── Reconnection ─────────────────────────────────────────────────────
        this.reconnectAttempts = 0;
        this.pingInterval = null;

        // ── Trade Watchdog ───────────────────────────────────────────────────
        this.tradeWatchdogTimer = null;
        this.tradeWatchdogPollTimer = null;
        this.tradeWatchdogMs = 120000;
        this.tradeStartTime = null;

        // ── Initialize per-asset structures ──────────────────────────────────
        this.assets.forEach(asset => {
            this.priceHistories[asset] = [];
            this.tickHistory[asset] = [];
            this.lastDigitsList[asset] = [];
            this.tickCounts[asset] = 0;
            this.lastTradeTime[asset] = 0;
            this.assetStates[asset] = { proposalId: null, lastProposalAt: 0 };
            this.assetMetrics[asset] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
            
            // Initialize all assets as pending until we get their stayedInArray values
            this.pendingAssets.add(asset);
            this.assetStayedInValues[asset] = null;
        });

        // ── Load saved state ─────────────────────────────────────────────────
        this.loadSavedState();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // UTILITY FUNCTIONS
    // ══════════════════════════════════════════════════════════════════════════
    /**
     * Calculate the total sum of all values in stayedInArray (indices 0-99)
     * @param {Array} stayedInArray - Array of stayed-in values
     * @returns {number} Total sum of all array elements
     */
    calculateTotalStayedIn(stayedInArray) {
        if (!stayedInArray || !Array.isArray(stayedInArray)) {
            return 0;
        }
        return stayedInArray.reduce((sum, value) => sum + (value || 0), 0);
    }

    /**
     * Check if trading conditions are met based on stayedInArray values
     * @param {Array} stayedInArray - Array of stayed-in values
     * @param {number} consecutiveLosses - Current consecutive losses count
     * @param {number} maxTotalStayedIn - Maximum allowed total sum (default: 600)
     * @returns {boolean} True if conditions are met for trading
     */
    checkTradeCondition(stayedInArray, consecutiveLosses, maxTotalStayedIn, asset) {
        // Calculate total sum of all stayedInArray values
        const totalStayedInArray = this.calculateTotalStayedIn(stayedInArray);
        
        // Log the calculation for debugging
        console.log(`   📊 ${asset} | Total StayedIn Sum: ${stayedInArray[99]} (${totalStayedInArray}/${maxTotalStayedIn})`);
        this.totalStayedInArray = totalStayedInArray;
        this.maxTotalStayedIn = maxTotalStayedIn;
        
        // Check individual thresholds for recent values
        const recentThresholds = (
            stayedInArray[99] < 3 &&
            stayedInArray[98] < 100 
            &&
            stayedInArray[97] < 100 
            &&
            stayedInArray[96] < 100 
            &&
            stayedInArray[95] < 100 
            &&
            stayedInArray[94] < 100
        );
        
        // Check if total sum is within acceptable range
        const totalWithinRange = totalStayedInArray > maxTotalStayedIn;
        
        // Check if we have consecutive losses (recovery mode)
        const inRecoveryMode = consecutiveLosses > 0;
        
        // Return true if: (recent thresholds AND total within range) OR in recovery mode
        return (recentThresholds && totalWithinRange);
    }

    checkTradeCondition2(stayedInArray, consecutiveLosses, maxTotalStayedIn, asset) {
        // Calculate total sum of all stayedInArray values
        const totalStayedInArray = this.calculateTotalStayedIn(stayedInArray);
        
        // Log the calculation for debugging
        // console.log(`   📊 ${asset} Total StayedIn2 Sum: ${totalStayedInArray} (Max: ${maxTotalStayedIn})`);
        this.totalStayedInArray2 = totalStayedInArray;
        this.maxTotalStayedIn2 = maxTotalStayedIn;

        // Check individual thresholds for recent values
        const recentThresholds = (
           stayedInArray[5] < 10
           && stayedInArray[4] < 10
        );

        const recentThreshold2s = (
            stayedInArray[5] < 10 
        );
        
        // Check if total sum is within acceptable range
        const totalWithinRange = totalStayedInArray < maxTotalStayedIn;
        
        // Check if we have consecutive losses (recovery mode)
        const inRecoveryMode = consecutiveLosses > 0;
        
        // Return true if: (recent thresholds AND total within range) OR in recovery mode
        // return inRecoveryMode ? (recentThreshold2s) : (recentThresholds);
        //  return this.consecutiveLosses > 0 ? (recentThreshold2s) : (recentThresholds && totalWithinRange);
        return (totalWithinRange);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTELLIGENT ASSET FILTERING SYSTEM
    // ══════════════════════════════════════════════════════════════════════════
    /**
     * Update asset's stayedInArray value and manage its active/pending status
     * @param {string} asset - Asset symbol
     * @param {Array} stayedInArray - Current stayedInArray from proposal
     */
    updateAssetStatus(asset, stayedInArray) {
        const totalStayedIn = this.calculateTotalStayedIn(stayedInArray);
        this.assetStayedInValues[asset] = totalStayedIn;

        const wasActive = this.activeAssets.has(asset);
        const wasPending = this.pendingAssets.has(asset);

        if (totalStayedIn > this.config.STAYED_IN_THRESHOLD) {
            // Asset is ready for trading
            if (!wasActive) {
                this.activeAssets.add(asset);
                this.pendingAssets.delete(asset);
                console.log(`✅ ${asset} moved to ACTIVE list (stayedIn: ${totalStayedIn})`);
            }
        } else {
            // Asset needs to wait
            if (!wasPending) {
                this.pendingAssets.add(asset);
                this.activeAssets.delete(asset);
                console.log(`⏸️  ${asset} moved to PENDING list (stayedIn: ${totalStayedIn})`);
            }
        }
    }

    /**
     * Check if an asset is ready for analysis and trading
     * @param {string} asset - Asset symbol
     * @returns {boolean} True if asset is in active list
     */
    isAssetReady(asset) {
        return this.activeAssets.has(asset);
    }

    /**
     * Periodically scan pending assets to check if they're ready to become active
     */
    startPendingAssetScan() {
    if (this.pendingScanInterval) {
        clearInterval(this.pendingScanInterval);
    }

    const scanningTimer = this.scanningTimer;

    this.pendingScanInterval = setInterval(() => {
        if (!this.wsReady || this.pendingAssets.size === 0) return;

        // ✅ FIX 5: Skip scan entirely during recovery — only the focus asset
        //    matters and it doesn't need a scan proposal to re-enter.
        //    Without this, the scanner floods the API with proposals for
        //    suspended assets that then race against recovery logic.
        if (this.focusAsset) {
            console.log(`⏸️  Pending scan skipped — recovery mode (focus: ${this.focusAsset})`);
            return;
        }

        console.log(`\n🔍 Scanning ${this.pendingAssets.size} pending assets...`);

        this.pendingAssets.forEach(asset => {
            if (this.activeTrades[asset]) return;
            this.requestProposalForScan(asset);
        });

    }, scanningTimer);

    console.log('🔄 Pending asset scanner started (scan interval: ' + scanningTimer / 1000 + 's)');
}

    /**
     * Request a proposal specifically for scanning (not for trading)
     * @param {string} asset - Asset symbol to scan
     */
    requestProposalForScan(asset) {
        if (!this.wsReady) return;

        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: this.config.growthRate,
            limit_order: {
                take_profit: (this.currentStake * this.config.takeProfitMultiplier).toFixed(2)
            },
            passthrough: {
                action: 'scan_only',
                asset: asset,
                timestamp: Date.now()
            }
        };

        this.sendRequest(proposal);
    }

    /**
     * Get a summary of active and pending assets
     * @returns {string} Formatted summary
     */
    getAssetFilteringSummary() {
        const activeList = Array.from(this.activeAssets).map(asset => {
            const value = this.assetStayedInValues[asset];
            return `${asset}(${value !== null ? value : '?'})`;
        }).join(', ');

        const pendingList = Array.from(this.pendingAssets).map(asset => {
            const value = this.assetStayedInValues[asset];
            return `${asset}(${value !== null ? value : '?'})`;
        }).join(', ');

        return `\n📊 Asset Status:\n` +
               `   ✅ Active (${this.activeAssets.size}): ${activeList || 'None'}\n` +
               `   ⏸️  Pending (${this.pendingAssets.size}): ${pendingList || 'None'}`;
    }

    /**
     * Stop the pending asset scanner
     */
    stopPendingAssetScan() {
        if (this.pendingScanInterval) {
            clearInterval(this.pendingScanInterval);
            this.pendingScanInterval = null;
            console.log('🛑 Pending asset scanner stopped');
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ASSET SUSPENSION LOGIC
    // ══════════════════════════════════════════════════════════════════════════
    suspendOtherAssets(lossAsset) {
        this.focusAsset = lossAsset;
        this.assets.forEach(asset => {
            if (asset !== lossAsset) {
                this.suspendedAssets.add(asset);
            }
        });
        console.log(`🔒 SUSPENDED: All assets except ${lossAsset}. Focusing on loss asset.`);
        // this.sendTelegramMessage(
        //     `🔒 <b>Asset Suspension (Accum VolatiliyIndices)</b>\n\n` +
        //     `Loss on: <b>${lossAsset}</b>\n` +
        //     `Suspended: ${this.assets.filter(a => a !== lossAsset).join(', ')}\n` +
        //     `Focusing on ${lossAsset} until win`
        // );
    }

    resumeAllAssets() {
        const prevFocus = this.focusAsset;
        this.suspendedAssets.clear();
        this.focusAsset = null;
        console.log(`✅ RESUMED: All assets active again (was focused on ${prevFocus})`);
        // this.sendTelegramMessage(
        //     `✅ <b>All Assets Resumed (Accum VolatiliyIndices)</b>\n\n` +
        //     `Won on: <b>${prevFocus}</b>\n` +
        //     `All assets now active for trading`
        // );
    }

    isAssetAllowed(asset) {
        if (!this.focusAsset) return true;
        return asset === this.focusAsset;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STATE MANAGEMENT
    // ══════════════════════════════════════════════════════════════════════════
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
                this.consecutiveLosses2 = state.trading.consecutiveLosses2 || 0;
                this.consecutiveLosses3 = state.trading.consecutiveLosses3 || 0;
                this.consecutiveLosses4 = state.trading.consecutiveLosses4 || 0;
                this.consecutiveLosses5 = state.trading.consecutiveLosses5 || 0;
                this.consecutiveLosses6 = state.trading.consecutiveLosses6 || 0;
                this.kCountNum = state.trading.kCountNum || 0;
                this.tradedDigitArray = state.trading.tradedDigitArray || [];
                this.tradedDigitArray2 = state.trading.tradedDigitArray2 || [];
                this.Sys1 = state.trading.Sys1 || 0;
                this.Sys2 = state.trading.Sys2 || 0;
                this.kCountNum = state.trading.kCountNum || 0;
                this.filterNum = state.trading.filterNum || 0;
            }
            if (state.assetMetrics) this.assetMetrics = state.assetMetrics;
            if (state.hourlyStats) this.hourlyStats = state.hourlyStats;
            console.log(`✅ State restored: ${this.totalTrades} trades, P&L: $${this.totalProfitLoss.toFixed(2)}`);
        } catch (error) {
            console.error(`❌ Error restoring state: ${error.message}`);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // WEBSOCKET CONNECTION + PING KEEP-ALIVE
    // ══════════════════════════════════════════════════════════════════════════
    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        console.log('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ WebSocket connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.startPingKeepAlive();
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            try {
                this.handleMessage(JSON.parse(data));
            } catch (error) {
                console.error('Error parsing message:', error.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error.message);
        });

        this.ws.on('close', () => {
            console.log('⚡ WebSocket disconnected');
            this.stopPingKeepAlive();
            this.handleDisconnect();
        });
    }

    startPingKeepAlive() {
        this.stopPingKeepAlive();
        this.pingInterval = setInterval(() => {
            if (this.connected) {
                this.sendRequest({ ping: 1 });
            }
        }, 25000);
    }

    stopPingKeepAlive() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    authenticate() {
        this.sendRequest({ authorize: this.token });
    }

    sendRequest(request) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
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
            this.cleanup();
            return;
        }
        this.connected = false;
        this.wsReady = false;
        StatePersistence.saveState(this);

        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(this.config.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    cleanup() {
        this.stopPingKeepAlive();
        this.stopPendingAssetScan();
        this._clearWatchdogTimers();
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

    disconnect() {
        console.log('🛑 Disconnecting...');
        StatePersistence.saveState(this);
        this.cleanup();
        console.log('✅ Bot disconnected');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // MESSAGE ROUTING
    // ══════════════════════════════════════════════════════════════════════════
    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                this.handleAuth(message);
                break;
            case 'history':
                this.handleTickHistory(message);
                break;
            case 'tick':
                if (message.subscription) {
                    this.tickSubscriptionIds[message.tick.symbol] = message.subscription.id;
                }
                this.handleTickUpdate(message.tick);
                break;
            case 'proposal':
                this.handleProposal(message);
                break;
            case 'buy':
                this.handleBuyResponse(message);
                break;
            case 'proposal_open_contract':
                if (message.error) {
                    console.error('Contract error:', message.error.message);
                    return;
                }
                this.handleContractUpdate(message);
                break;
            case 'sell':
                this.handleSellResponse(message);
                break;
            case 'ping':
                break;
            default:
                if (message.error) {
                    console.error(`API Error [${message.msg_type}]:`, message.error.message);
                }
        }
    }

    handleAuth(message) {
        if (message.error) {
            console.error('Auth failed:', message.error.message);
            this.disconnect();
            return;
        }
        console.log(`✅ Authenticated | Balance: $${message.authorize.balance}`);
        this.wsReady = true;
        this.initializeSubscriptions();
    }

    initializeSubscriptions() {
        console.log('📡 Subscribing to tick streams for all assets...');
        this.assets.forEach(asset => {
            // Historical prices
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });
            // Live tick subscription
            this.sendRequest({
                ticks: asset,
                subscribe: 1
            });
        });

        // Start the pending asset scanner
        this.startPendingAssetScan();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TELEGRAM
    // ══════════════════════════════════════════════════════════════════════════
    async sendTelegramMessage(message) {
        if (!this.telegramBot) return;
        try {
            await this.telegramBot.sendMessage(this.config.telegramChatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error(`Telegram error: ${error.message}`);
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

    async sendHourlySummary() {
        const winRate = this.totalTrades > 0
            ? (this.totalWins / this.totalTrades * 100).toFixed(1)
            : '0.0';
        const pnlEmoji = this.totalProfitLoss >= 0 ? '🟢' : '🔴';
        const pnlStr = (this.totalProfitLoss >= 0 ? '+' : '') + '$' + Math.abs(this.totalProfitLoss).toFixed(2);

        await this.sendTelegramMessage(
            `📊 <b>Session Summary Accum VolatiliyIndices</b>\n\n` +
            `Trades: ${this.totalTrades}\n` +
            `W/L: ${this.totalWins}/${this.totalLosses}\n` +
            `Losses x2-x6: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4} | ${this.consecutiveLosses5} | ${this.consecutiveLosses6}\n` +
            `Win Rate: ${winRate}%\n` +
            `${pnlEmoji} Total P&L: ${pnlStr}\n` +
            `Daily P&L: ${this.dailyProfitLoss >= 0 ? '+' : ''}$${this.dailyProfitLoss.toFixed(2)}\n` +
            `Current Stake: $${this.currentStake.toFixed(2)}\n\n` +
            `⏰ ${new Date().toLocaleTimeString()}`
        );
    }

    async sendDisconnectSummary() {
        await this.sendTelegramMessage(
            `⚠️ <b>Accum VolatiliyIndices Disconnected</b>\n\n` +
            `Trading Summary:\n` +
            `Total Trades: ${this.totalTrades}\n` +
            `Wins: ${this.totalWins} | Losses: ${this.totalLosses}\n` +
            `x2-x6 Losses: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4} | ${this.consecutiveLosses5} | ${this.consecutiveLosses6}\n\n` +
            `Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00'}%\n` +
            `Total P&L: $${this.totalProfitLoss.toFixed(2)}\n\n
            `
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TICK HISTORY & LIVE TICK HANDLING
    // ══════════════════════════════════════════════════════════════════════════
    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['BOOM150N', 'CRASH150N'].includes(asset)) {
            return fractionalPart.length >= 5 ? parseInt(fractionalPart[4]) : 0;
        } else if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', 'BOOM50',
            'BOOM300N',  'BOOM500',   'BOOM600',   'BOOM900',
            'BOOM1000',  'CRASH50',   'CRASH300N',
            'CRASH500',  'CRASH600',  'CRASH900',  'CRASH1000'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    handleTickHistory(message) {
        const asset = message.echo_req.ticks_history;
        const history = message.history;

        // Store raw prices
        this.priceHistories[asset] = history.prices.map(p => parseFloat(p));

        // Build digit history from raw prices
        this.tickHistory[asset] = history.prices.map(p => this.getLastDigit(p, asset));

        console.log(`📊 ${asset}: Loaded ${this.priceHistories[asset].length} price ticks | ${this.tickHistory[asset].length} digits`);
    }

    handleTickUpdate(tick) {
    const asset = tick.symbol;
    const price = parseFloat(tick.quote);
    const lastDigit = this.getLastDigit(price, asset);

    // Store raw price
    this.priceHistories[asset].push(price);
    if (this.priceHistories[asset].length > 500) {
        this.priceHistories[asset] = this.priceHistories[asset].slice(-300);
    }

    // Store digit
    if (!this.lastDigitsList[asset]) this.lastDigitsList[asset] = [];
    this.lastDigitsList[asset].push(lastDigit);

    this.tickHistory[asset].push(lastDigit);
    if (this.tickHistory[asset].length > this.config.requiredHistoryLength) {
        this.tickHistory[asset].shift();
    }

    this.tickCounts[asset] = (this.tickCounts[asset] || 0) + 1;

    if (!this.wsReady) return;
    if (this.activeTrades[asset]) return;
    if (this.tickHistory[asset].length < this.config.requiredHistoryLength) return;

    // ✅ FIX 1a: Hard gate — drop suspended assets before any further work
    if (!this.isAssetAllowed(asset)) return;

    // ✅ FIX 1b: Allow the focus asset through even if it's been moved to
    //    pendingAssets (its stayedInArray resets low after a loss, so
    //    isAssetReady() would wrongly block its own recovery trade)
    if (!this.isAssetReady(asset) && asset !== this.focusAsset) return;

    // Minimum time between trades
    if (Date.now() - (this.lastTradeTime[asset] || 0) < this.config.minTimeBetweenTrades) return;

    // Run analysis and maybe trade
    this.evaluateAndTrade(asset);
}

    // ========================================================================
    // TRADE ANALYSIS & EXECUTION — Bollinger + MACD Strategy
    // ========================================================================
    evaluateAndTrade(asset) {
        // Check if asset is suspended
        if (!this.isAssetAllowed(asset)) return;

        // Run original analyzeTicks logic — request proposal
        this.requestProposal(asset);
    }

    requestProposal(asset) {
    if (this.tradeInProgress) return;
    if (!this.wsReady) return;

    // ✅ FIX 4: Belt-and-suspenders — never send a proposal for a suspended asset
    if (!this.isAssetAllowed(asset)) return;

    this.takeProfitAmount = this.consecutiveLosses < 1
        ? this.currentStake * this.config.takeProfitMultiplier
        : this.currentStake * this.config.takeProfitMultiplier2;

    const proposal = {
        proposal: 1,
        amount: this.currentStake.toFixed(2),
        basis: 'stake',
        contract_type: 'ACCU',
        currency: 'USD',
        symbol: asset,
        growth_rate: this.config.growthRate,
        limit_order: {
            take_profit: this.takeProfitAmount.toFixed(2)
        }
    };

    this.sendRequest(proposal);
}

    handleProposal(message) {
    const asset = message.echo_req?.symbol;

    if (message.error) {
        if (asset && this.activeTrades[asset]?.status === 'requesting_proposal') {
            console.log(`❌ Proposal rejected for ${asset}: ${message.error.message}`);
            delete this.activeTrades[asset];
            this.tradeInProgress = false;
        }
        return;
    }

    if (!message.proposal) return;
    if (!asset) return;

    const proposal = message.proposal;
    const stayedInArray = proposal.contract_details.ticks_stayed_in;

    if (!stayedInArray) return;

    // ✅ FIX 2: Passthrough actions handled FIRST — unconditionally, before
    //    any consecutiveLosses branching.  Previously these were inside the
    //    (consecutiveLosses <= 0) block so they were silently skipped during
    //    recovery, causing scan_only proposals to fall through to trade logic
    //    and get_final_stayed_in to never reach its handler.
    const passthrough = message.echo_req?.passthrough;

    if (passthrough?.action === 'scan_only') {
        if (this.consecutiveLosses <= 0) {
            this.updateAssetStatus(asset, stayedInArray);
        }
        const totalStayedIn = this.calculateTotalStayedIn(stayedInArray);
        console.log(`   🔍 Scan result for ${asset}: stayedIn=${totalStayedIn} (${totalStayedIn > this.config.STAYED_IN_THRESHOLD ? 'READY' : 'WAITING'})`);
        return;
    }

    if (passthrough?.action === 'get_final_stayed_in') {
        console.log(`✅ Final stayedInArray received for ${asset}: [${stayedInArray.slice(-6).join('|')}]`);

        if (!this.assetStayedInArrays) this.assetStayedInArrays = {};
        this.assetStayedInArrays[asset] = stayedInArray;
        this.stayedInArray = stayedInArray;

        const trade = this.activeTrades[asset];
        if (trade && trade.awaitingFinalStayedIn && trade.settledContract) {
            trade.awaitingFinalStayedIn = false;
            this.handleTradeResult(asset, trade.settledContract);
        }
        return;
    }

    // ✅ FIX 3: Hard gate for suspended assets — catches every in-flight
    //    proposal response that arrived after suspension was set.
    //    This is the primary fix for wrong-asset recovery trades.
    if (!this.isAssetAllowed(asset)) {
        console.log(`⏸️  ${asset} is suspended — ignoring proposal`);
        return;
    }

    // Update asset status only in normal (non-recovery) mode
    if (this.consecutiveLosses <= 0) {
        this.updateAssetStatus(asset, stayedInArray);
    }

    // ── Regular proposal handling (for new trades) ──────────────────────────
    this.stayedInArray = stayedInArray;
    const stayedInArray2 = stayedInArray.slice(-6);

    if (!this.assetStayedInArrays) this.assetStayedInArrays = {};
    this.assetStayedInArrays[asset] = stayedInArray;

    if (this.tradeInProgress) return;

    // Enforce active/pending filter only outside recovery mode.
    // In recovery the focus asset must be allowed through regardless of
    // its current stayedInArray total.
    if (!this.isAssetReady(asset) && this.consecutiveLosses <= 0) {
        console.log(`⏸️  ${asset} is in pending list, skipping trade analysis`);
        return;
    }

    const currentDigitCount = stayedInArray[99] + 1;
    this.currentTick = stayedInArray[99];

    this.assetStates[asset].proposalId = proposal.id;

    // ── Original frequency analysis ──────────────────────────────────────────
    const digitFrequency = {};
    stayedInArray.forEach(digit => {
        digitFrequency[digit] = (digitFrequency[digit] || 0) + 1;
    });

    const appearedOnceArray = Object.keys(digitFrequency)
        .filter(digit => digitFrequency[digit] === this.filterNum)
        .map(Number);

    const condition  = this.checkTradeCondition(stayedInArray, this.consecutiveLosses, this.config.STAYED_IN_THRESHOLD, asset);
    const condition2 = this.checkTradeCondition2(stayedInArray2, this.consecutiveLosses, 20, asset);

    if (condition || this.consecutiveLosses > 0) {
        console.log(`   Entry condition: ${condition ? '✅ MET' : '❌ NOT MET'}`);

        this.tradedDigitArray.push(this.stayedInArray[99]);
        this.filteredArray = appearedOnceArray;

        console.log(`   Traded Digit Array: [${this.tradedDigitArray.join(', ')}]`);

        const growthRate = this.config.growthRate;
        console.log(`\n🎯 ENTRY SIGNAL: ${asset}`);
        console.log(`   Growth Rate: ${(growthRate * 100).toFixed(0)}% | Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`   Take Profit: $${this.takeProfitAmount.toFixed(2)}`);

        this.placeTrade(asset);
    }
}

    placeTrade(asset) {
        if (this.tradeInProgress) return;

        const proposalId = this.assetStates[asset]?.proposalId;
        if (!proposalId) {
            console.error(`❌ No valid proposal ID for ${asset}`);
            return;
        }

        console.log(`\n🚀 PLACING TRADE: ${asset}`);
        console.log(`   Proposal ID: ${proposalId}`);
        console.log(`   Stake: $${this.currentStake.toFixed(2)}`);

        this.sendRequest({
            buy: proposalId,
            price: this.currentStake.toFixed(2)
        });

        this.tradeInProgress = true;
        this.activeTrades[asset] = {
            status: 'buying',
            proposalId,
            stake: this.currentStake,
            entryTime: Date.now(),
        };

        // ✅ Suspend all other assets immediately on trade open
        this.suspendOtherAssets(asset);

        const trade = this.activeTrades[asset];

        // Telegram notification
        this.sendTelegramMessage(
            `🚀 <b>TRADE OPENED (Accum VolatiliyIndices)</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `stayedInArray: <b>[${this.stayedInArray[99]}|${this.stayedInArray[98]}|${this.stayedInArray[97]}|${this.stayedInArray[96]}|${this.stayedInArray[95]}|${this.stayedInArray[94]}]</b>\n` +
            `totalStayedInArray: ${this.totalStayedInArray}/${this.maxTotalStayedIn} (${this.totalStayedInArray2}/${this.maxTotalStayedIn2})\n` +
            `Stake: $${trade.stake.toFixed(2)}\n` +
            `Growth Rate: ${(this.config.growthRate * 100).toFixed(0)}%\n` +
            `Take Profit: $${this.takeProfitAmount.toFixed(2)}`
        );

        this.lastTradeTime[asset] = Date.now();
    }

    handleBuyResponse(message) {
        const asset = this.findAssetByStatus('buying');

        if (message.error) {
            console.error(`❌ Buy error: ${message.error.message}`);
            if (asset) {
                delete this.activeTrades[asset];
            }
            this.tradeInProgress = false;
            this._clearWatchdogTimers();
            return;
        }

        if (!asset) {
            console.warn('Buy response but no pending trade found');
            this._clearWatchdogTimers();
            return;
        }

        const trade = this.activeTrades[asset];
        const contractId = message.buy.contract_id;

        console.log(`✅ Contract opened: ${contractId} on ${asset}`);

        trade.status = 'active';
        trade.contractId = contractId;
        trade.buyPrice = parseFloat(message.buy.buy_price);

        // Subscribe to contract updates
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });

        // Record trade start time and start watchdog
        this.tradeStartTime = Date.now();
        this._startTradeWatchdog(contractId);
        console.log(`⏱️  Trade watchdog started (${(this.tradeWatchdogMs / 1000).toFixed(0)}s timeout)`);
    }

    findAssetByStatus(status) {
        return Object.keys(this.activeTrades).find(
            asset => this.activeTrades[asset]?.status === status
        );
    }

    findAssetByContractId(contractId) {
        return Object.keys(this.activeTrades).find(
            asset => this.activeTrades[asset]?.contractId === contractId
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CONTRACT MONITORING & EXIT LOGIC
    // ══════════════════════════════════════════════════════════════════════════
    handleContractUpdate(message) {
        const contract = message.proposal_open_contract;
        if (!contract) return;

        const asset = contract.underlying || this.findAssetByContractId(contract.contract_id);
        if (!asset || !this.activeTrades[asset]) return;

        const trade = this.activeTrades[asset];

        // Store subscription ID
        if (message.subscription?.id) {
            this.contractSubscriptions[asset] = message.subscription.id;
        }

        // Contract settled?
        if (contract.is_sold) {
            // ✅ Store the settled contract data
            trade.settledContract = contract;

            this.tickPassed = contract.tick_passed;
            
            // ✅ Request a fresh proposal to get the CURRENT ticks_stayed_in
            this.requestFinalStayedInArray(asset);
            return;
        }

        // Log progress
        const tickCount = contract.tick_count || 0;
        const profit = parseFloat(contract.profit || 0);
        const bidPrice = parseFloat(contract.bid_price || 0);

        if (tickCount > 0 && tickCount % 2 === 0) {
            console.log(
                `  📊 ${asset}: tick ${tickCount} | ` +
                `Profit: $${profit.toFixed(3)} | Bid: $${bidPrice.toFixed(2)} | ` +
                `Ticks Passed: ${contract.tick_passed || 0}`
            );
        }
    }

    requestFinalStayedInArray(asset) {
        const trade = this.activeTrades[asset];
        if (!trade) return;

        // Mark that we're waiting for final data
        trade.awaitingFinalStayedIn = true;

        console.log(`🔍 Requesting final stayedInArray for ${asset}...`);

        // Request a fresh proposal to get the current ticks_stayed_in
        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: this.config.growthRate,
            limit_order: {
                take_profit: this.takeProfitAmount.toFixed(2)
            },
            passthrough: {
                action: 'get_final_stayed_in',
                asset: asset,
                timestamp: Date.now()
            }
        };

        this.sendRequest(proposal);

        // Safety timeout: if no response in 3 seconds, proceed with empty array
        setTimeout(() => {
            const currentTrade = this.activeTrades[asset];
            if (currentTrade && currentTrade.awaitingFinalStayedIn) {
                console.warn(`⚠️ Timeout waiting for final stayedInArray for ${asset}`);
                currentTrade.awaitingFinalStayedIn = false;
                this.handleTradeResult(asset, currentTrade.settledContract);
            }
        }, 3000);
    }

    handleSellResponse(message) {
        if (message.error) {
            console.error('❌ Sell error:', message.error.message);
            return;
        }
        console.log(`✅ Sold for: $${message.sell?.sold_for || 'N/A'}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TRADE WATCHDOG
    // ══════════════════════════════════════════════════════════════════════════
    _startTradeWatchdog(contractId) {
        this._clearWatchdogTimers();

        const timeoutMs = this.tradeWatchdogMs;

        this.tradeWatchdogTimer = setTimeout(() => {
            const hasActiveTrade = Object.keys(this.activeTrades).some(
                a => this.activeTrades[a]?.contractId
            );
            if (!hasActiveTrade) {
                this._clearWatchdogTimers();
                return;
            }

            console.warn(
                `⏰ WATCHDOG FIRED — Contract ${contractId || 'unknown'} has been open for ` +
                `${(timeoutMs / 1000).toFixed(0)}s with no settlement`
            );

            if (contractId && this.connected && this.wsReady) {
                console.log(`🔍 Polling contract ${contractId} for current status…`);
                this.sendRequest({
                    proposal_open_contract: 1,
                    contract_id: contractId,
                    subscribe: 1,
                });

                this.tradeWatchdogPollTimer = setTimeout(() => {
                    const stillActive = Object.keys(this.activeTrades).some(
                        a => this.activeTrades[a]?.contractId
                    );
                    if (!stillActive) {
                        this._clearWatchdogTimers();
                        return;
                    }
                    console.error(
                        `🚨 WATCHDOG: Poll timed out — contract ${contractId} still unresolved, ` +
                        `force-releasing lock`
                    );
                    this._recoverStuckTrade('watchdog-force');
                }, 15000);

            } else {
                this._recoverStuckTrade('watchdog-offline');
            }
        }, timeoutMs);
    }

    _clearWatchdogTimers() {
        if (this.tradeWatchdogTimer) {
            clearTimeout(this.tradeWatchdogTimer);
            this.tradeWatchdogTimer = null;
        }
        if (this.tradeWatchdogPollTimer) {
            clearTimeout(this.tradeWatchdogPollTimer);
            this.tradeWatchdogPollTimer = null;
        }
    }

    _recoverStuckTrade(reason) {
        this._clearWatchdogTimers();

        const stuckAsset = Object.keys(this.activeTrades).find(
            asset => this.activeTrades[asset]?.contractId
        );
        if (!stuckAsset) {
            console.warn('⚠️  No active trade found for stuck trade recovery');
            this.tradeInProgress = false;
            return;
        }

        const trade = this.activeTrades[stuckAsset];
        const contractId = trade.contractId || 'unknown';
        const stake = trade.stake || 0;
        const entryTime = this.tradeStartTime || Date.now();
        const openSeconds = Math.round((Date.now() - entryTime) / 1000);

        console.error(
            `\n🚨 STUCK TRADE RECOVERY [${reason}]` +
            `\n   Contract: ${contractId}` +
            `\n   Asset: ${stuckAsset}` +
            `\n   Stake: $${stake.toFixed(2)}` +
            `\n   Open for: ${openSeconds}s`
        );

        // Emergency sell attempt
        if (contractId && contractId !== 'unknown' && this.connected && this.wsReady) {
            console.log(`🔄 Attempting emergency sell of contract ${contractId}…`);
            this.sendRequest({
                sell: contractId,
                price: '0',
            });
        }

        // Forget subscription
        if (this.contractSubscriptions[stuckAsset]) {
            this.sendRequest({ forget: this.contractSubscriptions[stuckAsset] });
            delete this.contractSubscriptions[stuckAsset];
        }

        // Clear trade state
        this.tradeInProgress = false;
        this.tradeStartTime = null;
        delete this.activeTrades[stuckAsset];

        // Record as loss
        this.totalLosses++;
        this.consecutiveLosses++;
        this.consecutiveLosses2++;

        if (this.assetMetrics[stuckAsset]) {
            this.assetMetrics[stuckAsset].losses++;
            this.assetMetrics[stuckAsset].profitLoss -= stake;
        }

        this.totalProfitLoss -= stake;
        this.dailyProfitLoss -= stake;

        // this.suspendOtherAssets(stuckAsset);

        console.log(
            `\n   Trade lock released — bot can now trade again` +
            `\n   Stake $${stake.toFixed(2)} recorded as loss`
        );

        this.sendTelegramMessage(
            `🚨 <b>STUCK TRADE RECOVERED Accum VolatiliyIndices[${reason}]</b>\n\n` +
            `Contract: ${contractId}\n` +
            `Asset: ${stuckAsset}\n` +
            `Stake: $${stake.toFixed(2)}\n` +
            `Open for: ${openSeconds}s\n` +
            `Action: Emergency sell attempted, trade lock released`
        );

        StatePersistence.saveState(this);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TRADE RESULT HANDLING (original logic preserved)
    // ══════════════════════════════════════════════════════════════════════════
    handleTradeResult(asset, contract) {
        const trade = this.activeTrades[asset];
        if (!trade) {
            this._clearWatchdogTimers();
            return;
        }

        // Clear watchdog
        this._clearWatchdogTimers();

        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        // Get the final stayedInArray for this asset (updated continuously via proposal stream)
        const finalStayedInArray = this.assetStayedInArrays?.[asset] || [];

        // Unsubscribe from contract
        if (this.contractSubscriptions[asset]) {
            this.sendRequest({ forget: this.contractSubscriptions[asset] });
            delete this.contractSubscriptions[asset];
        }

        console.log(`\n${'═'.repeat(55)}`);
        console.log(`  ${won ? '✅ WIN' : '❌ LOSS'}: ${asset}`);
        console.log(`  Ticks: ${contract.tick_count || 0} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
        console.log(`  Final StayedIn: [${finalStayedInArray[99]}|${finalStayedInArray[98]}|${finalStayedInArray[97]}|${finalStayedInArray[96]}|${finalStayedInArray[95]}|${finalStayedInArray[94]}]`);
        console.log(`${'═'.repeat(55)}`);

        // Update stats
        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;

        if (this.assetMetrics[asset]) {
            this.assetMetrics[asset].trades++;
            this.assetMetrics[asset].profitLoss += profit;
        }

        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            // this.currentStake = this.Sys2 ? this.config.initialStake2 : this.config.initialStake;
            this.currentStake = this.config.initialStake;
            this.consecutiveLosses = 0;
            this.filterNum = this.config.filterNum;
            // if (this.Sys2) {
            //     this.kCountNum++;
            //     if (this.kCountNum >= this.config.recoveryWinNum) {
            //         this.kCountNum = 0;
            //         this.Sys2 = false;
            //     }
            // }

            if (this.assetMetrics[asset]) this.assetMetrics[asset].wins++;
            this.hourlyStats.wins++;

            // Resume all assets after win
            if (this.focusAsset) {
                this.resumeAllAssets();
            }
            
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;
            this.hourlyStats.losses++;

            this.filterNum++;

            if (this.assetMetrics[asset]) this.assetMetrics[asset].losses++;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;
            else if (this.consecutiveLosses === 6) this.consecutiveLosses6++;

            // Original martingale
            // if (this.consecutiveLosses === 2) {
            //     this.currentStake = this.config.initialStake2;
            //     if (!this.Sys2) {
            //         this.Sys2 = true;
            //     } else {
            //         this.consecutiveLosses = 4;
            //     }
            // }
            // else {
                // this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            // }

            if (this.consecutiveLosses >= 2) {
                this.currentStake = Math.ceil(this.currentStake * this.config.multiplier2 * 100) / 100;
            } else {
                this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            }
        }

        // Keep traded digit array trimmed
        if (this.tradedDigitArray.length > 3) {
            this.tradedDigitArray.shift();
        }

        this.Sys1 = 0;
        this.currentTick = null;

        this.tradeInProgress = false;
        this.tradeStartTime = null;
        delete this.activeTrades[asset];

        // Send Trade result notification with final stayedInArray
        this.sendTelegramMessage(
            `<b>Accum VolatiliyIndices</b>\n` +
            `${won ? '✅ WON' : '❌ LOSS'}\n` +
            `Asset: <b>${asset}</b>\n` +
            `Tick Passed: <b>${this.tickPassed}</b>\n` +
            `Final stayedInArray: [${finalStayedInArray[99]}|${finalStayedInArray[98]}|${finalStayedInArray[97]}|${finalStayedInArray[96]}|${finalStayedInArray[95]}|${finalStayedInArray[94]}]\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
            `Consecutive Losses: ${this.consecutiveLosses}\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
            `Losses x2-x6: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4} | ${this.consecutiveLosses5} | ${this.consecutiveLosses6}\n` +
            `Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00'}%\n` +
            `Stake: $${this.currentStake.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`
        );

        // Log summary
        this.logTradingSummary();

        // Take profit condition
        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('🎯 Take Profit Reached... Stopping trading.');
            this.endOfDay = true;
            this.TP_SL = true;
            this.sendDisconnectSummary();
            this.disconnect();
            return;
        }

        // Stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('🛑 Stopping condition met. Disconnecting...');
            this.endOfDay = true;
            this.TP_SL = true;
            this.sendDisconnectSummary();
            this.disconnect();
            return;
        }

        //Disconnect and Reconnect after WaitTime
        // if(won && !this.endOfDay) {
        //     this.disconnect();
        //     console.log("Bot Disconnected, will Restart in", (this.waitTime / 1000).toFixed(0), 'Seconds' );
            
        //     setTimeout(() => {
        //         this.connect();
        //     }, this.waitTime);
        // }

        StatePersistence.saveState(this);

        // ═══════════════════════════════════════════════════════════════════
        // IMMEDIATE RE-EVALUATION — Don't wait for the next tick
        // ═══════════════════════════════════════════════════════════════════
        // this._evaluateAllAssetsImmediately();
    }

    /**
     * Immediately evaluate all assets for a new trade opportunity
     * after a trade closes.
     */
    _evaluateAllAssetsImmediately() {
        this.assets.forEach(a => {
            this.tickCounts[a] = 0;
        });

        for (const asset of this.assets) {
            if (!this.isAssetAllowed(asset)) continue;

            // ✅ FIX 6: Same as handleTickUpdate — allow focus asset through
            //    even if its stayedInArray is low post-loss
            if (!this.isAssetReady(asset) && asset !== this.focusAsset) continue;

            if (this.tradeInProgress) break;
            if (this.activeTrades[asset]) continue;
            if (!this.tickHistory[asset] || this.tickHistory[asset].length < this.config.requiredHistoryLength) continue;
            if (Date.now() - (this.lastTradeTime[asset] || 0) < this.config.minTimeBetweenTrades) continue;

            console.log(`\n⚡ IMMEDIATE RE-ENTRY: ${asset} (post-trade evaluation)`);
            this.requestProposal(asset);
            break;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TIME-BASED DISCONNECT / RECONNECT (original logic preserved)
    // ══════════════════════════════════════════════════════════════════════════
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay(); // 0: Sunday, 1: Monday, ..., 6: Saturday
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Weekend logic: Saturday 11pm to Monday 2am GMT+1 -> Disconnect and stay disconnected
            // const isWeekend = (currentDay === 0) || // Sunday
            //     (currentDay === 6 && currentHours >= 23) || // Saturday after 11pm
            //     (currentDay === 1 && currentHours < 8);    // Monday before 8am

            // Afternoon stop: after 1:00 PM following a win
            // if (this.isWinTrade && !this.endOfDay) {
            //     if (currentHours === 13 && currentMinutes >= 0 && currentMinutes < 1) {
            //         console.log("It's past 1:00 PM after a win trade, disconnecting.");
            //         this.sendDisconnectSummary();
            //         this.Pause = true;
            //         this.disconnect();
            //         this.endOfDay = true;
            //     }
            // }

            // Afternoon resume: 3:00 PM
            // if (this.endOfDay && currentHours === 15 && currentMinutes >= 0) {
            //     console.log("It's 3:00 PM, reconnecting the bot.");
            //     this.endOfDay = false;
            //     this.Pause = false;
            //     this.tradeInProgress = false;
            //     this.tradedDigitArray = [];
            //     this.tradedDigitArray2 = [];
            //     this.tradeNum = Math.floor(Math.random() * (40 - 21 + 1)) + 21;
            //     this.connect();
            // }

            // Evening stop: after 11:00 PM following a win
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 23 && currentMinutes >= 0) {
                    console.log("It's past 11:00 PM after a win trade, disconnecting.");
                    this.sendDisconnectSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }

            // Morning Resumption: 2:00 AM
            if (!this.TP_SL && this.endOfDay && currentHours === 2 && currentMinutes >= 0) {
                console.log("It's 2:00 AM, reconnecting the bot.");
                this.endOfDay = false;
                this.Pause = false;
                this.tradeInProgress = false;
                this.tradedDigitArray = [];
                this.tradedDigitArray2 = [];
                this.tradeNum = Math.floor(Math.random() * (40 - 21 + 1)) + 21;
                this.connect();
            }

        }, 20000);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TRADING SUMMARY
    // ══════════════════════════════════════════════════════════════════════════
    logTradingSummary() {
        console.log('\n📊 Trading Summary:');
        console.log(`  Total Trades: ${this.totalTrades}`);
        console.log(`  Total Trades Won: ${this.totalWins}`);
        console.log(`  Total Trades Lost: ${this.totalLosses}`);
        console.log(`  x2 Losses: ${this.consecutiveLosses2}`);
        console.log(`  x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`  x4 Losses: ${this.consecutiveLosses4}`);
        console.log(`  x5 Losses: ${this.consecutiveLosses5}`);
        console.log(`  x6 Losses: ${this.consecutiveLosses6}`);
        console.log(`  Total Profit/Loss: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`  Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00'}%`);
        console.log(`  Current Stake: $${this.currentStake.toFixed(2)}`);
        
        // ✅ NEW: Show asset filtering status
        console.log(this.getAssetFilteringSummary());
    }

    // ══════════════════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ══════════════════════════════════════════════════════════════════════════
    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🚀 accumBotM — Enhanced Multi-Asset Accumulator Bot');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`  Assets:        ${this.assets.join(', ')}`);
        console.log(`  Initial Stake: $${this.config.initialStake}`);
        console.log(`  Multiplier:    x${this.config.multiplier}`);
        console.log(`  Growth Rate:   ${(this.config.growthRate * 100)}%`);
        console.log(`  Take Profit:   $${this.config.takeProfit}`);
        console.log(`  Stop Loss:     $${this.config.stopLoss}`);
        console.log('═══════════════════════════════════════════════════════════\n');

        this.connect();
        this.checkTimeForDisconnectReconnect();
        this.startTelegramTimer();
        StatePersistence.startAutoSave(this);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// BOT INITIALIZATION
// ══════════════════════════════════════════════════════════════════════════════
const bot = new EnhancedDerivTradingBot('0P94g4WdSrSrzir', {
    initialStake: 1,
    initialStake2: 25,
    multiplier: 10,
    multiplier2: 10,
    recoveryWinNum: 100,
    maxConsecutiveLosses: 3,
    stopLoss: 127,
    takeProfit: 2500,
    growthRate: 0.01,
    takeProfitMultiplier: 0.25, //50% of Stake Amount
    takeProfitMultiplier2: 0.15, //15% of Stake Amount
    filterNum: 4,
    STAYED_IN_THRESHOLD: 7300, // Threshold for asset filtering
    scanTimer: 60000, //Set Timer for Bot to Re-scan for Assets that are ready for Trade execution.
    assets: [
        // 'BOOM50','BOOM150N', 'BOOM300N', 'BOOM500', 'BOOM600', 'BOOM900', 'BOOM1000',
        // 'CRASH50', 'CRASH150N', 'CRASH300N', 'CRASH500', 'CRASH600', 'CRASH900', 'CRASH1000',
        'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
        // '1HZ10V', '1HZ25V', '1HZ75V', '1HZ100V',
    ],
    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    telegramChatId: '752497117',
});

bot.start();
