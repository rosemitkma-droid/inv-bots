const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'KriseFallM_2b0_01210-state.json');
const HISTORY_FILE = path.join(__dirname, 'KriseFallM_2b0_01210-history.json');
const MAXSTREAK_FILE = path.join(__dirname, 'KriseFallM_2b0_01210-maxstreak.json');
const STATE_SAVE_INTERVAL = 5000;

// ============================================
// LOGGER UTILITY (must be first - used by everything)
// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';
const LOGGER = {
    info:  msg => console.log(`[INFO]  ${getGMTTime()} - ${msg}`),
    trade: msg => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn:  msg => console.warn(`\x1b[33m[WARN]  ${getGMTTime()} - ${msg}\x1b[0m`),
    error: msg => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: msg => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); }
};

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    API_TOKEN: 'rgNedekYXvCaPeP',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',
    INITIAL_CAPITAL: 250,
    STAKE: 0.35,
    SESSION_PROFIT_TARGET: 500000,
    SESSION_STOP_LOSS: -5000,
    GRANULARITY: 60,
    TIMEFRAME_LABEL: '1m',
    MAX_CANDLES_STORED: 60,
    CANDLES_TO_LOAD: 60,
    AUTOCORR_THRESHOLD: -0.40,
    AUTOCORR_THRESHOLD2: -0.99,
    DURATION: 58,
    DURATION_UNIT: 's',
    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    TRADE_DELAY: 1000,
    MARTINGALE_MULTIPLIER: 1.48,
    MARTINGALE_MULTIPLIER2: 1.8,
    MARTINGALE_MULTIPLIER3: 2.1,
    MAX_MARTINGALE_STEPS: 9,
    USE_TRADING_SESSIONS: false,
    TOKYO_START: 2,
    TOKYO_END: 8,
    LONDON_START: 8,
    LONDON_END: 13,
    NEWYORK_START: 15,
    NEWYORK_END: 19,
    SYDNEY_START: 19,
    SYDNEY_END: 23,
    RECOVERY_TRADE_DELAY_MS: 800,
    RECOVERY_TRADE_DELAY_MS2: 1500,
    DEBUG_MODE: true,
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8306232249:AAGMwjFngs68Lcq27oGmqewQgthXTJJRxP0',
    TELEGRAM_CHAT_ID: '752497117',
    ACTIVE_ASSETS: [
        'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
        '1HZ10V', '1HZ25V', '1HZ75V', '1HZ100V',
        'stpRNG', 'stpRNG3', 'stpRNG4', 'stpRNG5'
    ]
};

const ASSET_CONFIGS = {};

function getAssetConfig(symbol) {
    const assetOverrides = ASSET_CONFIGS[symbol] || {};
    return {
        GRANULARITY:       assetOverrides.GRANULARITY       ?? CONFIG.GRANULARITY,
        TIMEFRAME_LABEL:   assetOverrides.TIMEFRAME_LABEL   ?? CONFIG.TIMEFRAME_LABEL,
        MAX_CANDLES_STORED:assetOverrides.MAX_CANDLES_STORED ?? CONFIG.MAX_CANDLES_STORED,
        CANDLES_TO_LOAD:   assetOverrides.CANDLES_TO_LOAD   ?? CONFIG.CANDLES_TO_LOAD,
        DURATION:          assetOverrides.DURATION           ?? CONFIG.DURATION,
        DURATION_UNIT:     assetOverrides.DURATION_UNIT      ?? CONFIG.DURATION_UNIT
    };
}

// ============================================
// STATE MANAGEMENT
// ============================================

/**
 * FIX #2: ACTIVE_ASSETS must NEVER be mutated globally.
 * Use a per-asset lock mechanism instead of filtering ACTIVE_ASSETS.
 * The original code did: ACTIVE_ASSETS = [symbol] which permanently
 * blocked all other assets from trading even after a win.
 */
const state = {
    assets: {},
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    currentTradeDay: null,
    // REMOVED: activeTradeAsset (caused ACTIVE_ASSETS mutation bug)
    lastTradeDirection: null,
    isMaxStreakReady: false,
    session: {
        profit: 0, loss: 0, netPL: 0,
        tradesCount: 0, winsCount: 0, lossesCount: 0,
        x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
        x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0,
        isActive: true,
        startTime: Date.now(),
        startCapital: CONFIG.INITIAL_CAPITAL
    },
    isConnected: false,
    isAuthorized: false,
    portfolio: {
        dailyProfit: 0, dailyLoss: 0, dailyWins: 0, dailyLosses: 0
    },
    hourlyStats: {
        trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours()
    },
    requestId: 1,
    lastSessionLogTime: 0,
    // Watchdog properties
    tradeWatchdogTimer: null,
    tradeWatchdogPollTimer: null,
    pendingTradeInfo: null,
    tradeStartTime: null,
    currentContractId: null
};

let tradeHistory = null;
let assetMaxStreakManager = null;

// ============================================
// ASSET MAX STREAK MANAGER
// ============================================
class AssetMaxStreakManager {
    constructor() {
        this.data = this._load();
        this._updateIntervalMs = 30 * 24 * 60 * 60 * 1000; // 30 days
        this._refreshTimer = null;
        this._isComputing = false; // FIX: prevent concurrent computation
    }

    _load() {
        try {
            if (fs.existsSync(MAXSTREAK_FILE)) {
                const raw = JSON.parse(fs.readFileSync(MAXSTREAK_FILE, 'utf8'));
                LOGGER.info(`📊 AssetMaxStreak file loaded (${Object.keys(raw.assets || {}).length} assets)`);
                return raw;
            }
        } catch (e) {
            LOGGER.error(`AssetMaxStreakManager load error: ${e.message}`);
        }
        return { assets: {}, lastUpdated: null };
    }

    _save() {
        try {
            fs.writeFileSync(MAXSTREAK_FILE, JSON.stringify(this.data, null, 2));
        } catch (e) {
            LOGGER.error(`AssetMaxStreakManager save error: ${e.message}`);
        }
    }

    getMaxStreak(symbol) { return this.data.assets[symbol]?.maxStreak ?? null; }
    isReady(symbol)      { return typeof this.data.assets[symbol]?.maxStreak === 'number'; }
    allReady()           { return CONFIG.ACTIVE_ASSETS.every(s => this.isReady(s)); }

    needsRefresh() {
        if (!this.data.lastUpdated) return true;
        return (Date.now() - this.data.lastUpdated) >= this._updateIntervalMs;
    }

    /**
     * FIX #1: The original fetchMaxStreakForAsset had a critical listener leak.
     * 
     * PROBLEM: `connection.ws.on('message', onMessage)` adds a NEW listener every
     * time fetchBatch() runs. If any batch receives an unrelated message first
     * (balance update, OHLC tick, etc.), the `return` guard works BUT the listener
     * stays registered. Multiple listeners accumulate and fire for every subsequent
     * message, causing:
     *   - Duplicate resolve() calls (Promise already settled = silent)
     *   - Ghost listeners that intercept real candle/trade messages
     *   - Memory leak growing with each maxStreak computation
     * 
     * FIX: Use a dedicated message handler that:
     *   1. Removes itself FIRST before any async work
     *   2. Uses a unique req_id to filter ONLY its own response
     *   3. Wraps everything in a single Promise with guaranteed cleanup
     */
    fetchMaxStreakForAsset(symbol, connection) {
        return new Promise((resolve, reject) => {
            const assetConfig = getAssetConfig(symbol);
            const BATCH_SIZE = 60;
            const MAX_BATCHES = 1;

            let batchesDone = 0;
            let endEpoch = 'latest';
            let overallMaxStreak = 1;
            let crossBatchLastDir = null;
            let currentListener = null;
            let timeoutId = null;
            let isSettled = false;

            const settle = (fn, val) => {
                if (isSettled) return;
                isSettled = true;
                cleanup();
                clearTimeout(timeoutId);
                fn(val);
            };

            const cleanup = () => {
                if (currentListener && connection.ws) {
                    connection.ws.removeListener('message', currentListener);
                    currentListener = null;
                }
            };

            // 2-minute safety timeout for the entire fetch
            timeoutId = setTimeout(() => {
                LOGGER.error(`[${symbol}] MaxStreak fetch timeout — using fallback`);
                settle(resolve, overallMaxStreak || 10);
            }, 120000);

            LOGGER.info(`📡 [${symbol}] Starting maxStreak fetch (${MAX_BATCHES} batch)...`);

            const fetchBatch = () => {
                if (batchesDone >= MAX_BATCHES) {
                    LOGGER.info(`✅ [${symbol}] maxStreak = ${overallMaxStreak} (${batchesDone} batches)`);
                    settle(resolve, overallMaxStreak);
                    return;
                }

                // Verify connection is still valid
                if (!connection.ws || connection.ws.readyState !== WebSocket.OPEN) {
                    LOGGER.error(`[${symbol}] WebSocket closed during maxStreak fetch`);
                    settle(resolve, overallMaxStreak || 10);
                    return;
                }

                // Generate a unique req_id for THIS specific request
                const myReqId = state.requestId++;
                
                const reqPayload = {
                    ticks_history: symbol,
                    adjust_start_time: 1,
                    count: BATCH_SIZE,
                    end: endEpoch,
                    start: 1,
                    style: 'candles',
                    granularity: assetConfig.GRANULARITY,
                    req_id: myReqId  // Use known req_id for precise filtering
                };

                // FIX: Create listener, register it, then send — in that order
                // This prevents a race where the response arrives before listener is set
                const messageHandler = (rawData) => {
                    let response;
                    try { response = JSON.parse(rawData); } catch { return; }

                    // FIX: Filter by BOTH msg_type AND req_id to prevent
                    // interference with other candles responses (e.g., from subscriptions)
                    if (response.msg_type !== 'candles') return;
                    if (response.echo_req?.req_id !== myReqId) return;

                    // Remove listener IMMEDIATELY — this is the critical fix
                    // In original code this happened inside a conditional, causing leaks
                    cleanup();

                    if (response.error) {
                        LOGGER.warn(`⚠️ [${symbol}] Batch error: ${response.error.message}`);
                        settle(resolve, overallMaxStreak);
                        return;
                    }

                    const candles = response.candles;
                    if (!candles || candles.length === 0) {
                        LOGGER.info(`✅ [${symbol}] No more candles`);
                        settle(resolve, overallMaxStreak);
                        return;
                    }

                    LOGGER.info(`📊 [${symbol}] Batch ${batchesDone + 1}: ${candles.length} candles`);

                    // Process streak
                    let currentStreak = 1;
                    let prevDir = crossBatchLastDir;

                    for (let i = 0; i < candles.length; i++) {
                        const c = candles[i];
                        const dir = c.close > c.open ? 1 : 0;
                        if (prevDir === null) { prevDir = dir; continue; }
                        if (dir !== prevDir) {
                            currentStreak++;
                            if (currentStreak > overallMaxStreak) overallMaxStreak = currentStreak;
                        } else {
                            currentStreak = 1;
                        }
                        prevDir = dir;
                    }

                    const lastC = candles[candles.length - 1];
                    crossBatchLastDir = lastC.close > lastC.open ? 1 : 0;
                    endEpoch = candles[0].epoch - 1;
                    batchesDone++;

                    if (candles.length < BATCH_SIZE) {
                        LOGGER.info(`✅ [${symbol}] History exhausted at batch ${batchesDone}`);
                        settle(resolve, overallMaxStreak);
                        return;
                    }

                    // Next batch after brief pause (don't hammer the API)
                    setTimeout(fetchBatch, 400);
                };

                // Register listener BEFORE sending
                currentListener = messageHandler;
                connection.ws.on('message', messageHandler);

                try {
                    connection.ws.send(JSON.stringify(reqPayload));
                } catch (err) {
                    cleanup();
                    LOGGER.error(`[${symbol}] Send failed: ${err.message}`);
                    settle(resolve, overallMaxStreak || 10);
                }
            };

            fetchBatch();
        });
    }

    async computeAllMaxStreaks(connection) {
        if (this._isComputing) {
            LOGGER.warn('⚠️ MaxStreak computation already in progress, skipping duplicate call');
            return;
        }
        this._isComputing = true;

        LOGGER.info('🔄 Starting sequential maxStreak computation for all assets...');
        await TelegramService.sendMessage(
            '🔄 <b>RISEFALL2b MaxStreak Update Started</b>\n' +
            `Computing maxStreak for ${CONFIG.ACTIVE_ASSETS.length} assets sequentially.\n` +
            'Trading is PAUSED until complete.'
        );

        for (const symbol of CONFIG.ACTIVE_ASSETS) {
            if (!state.isConnected || !state.isAuthorized) {
                LOGGER.error('Connection lost during maxStreak computation — aborting');
                break;
            }

            try {
                const maxStreak = await this.fetchMaxStreakForAsset(symbol, connection);
                this.data.assets[symbol] = { maxStreak, computedAt: Date.now() };
                this._save();
                LOGGER.info(`✅ [${symbol}] assetMaxStreak = ${maxStreak}`);

                // Trim closedCandles for this asset
                const assetState = state.assets[symbol];
                if (assetState && assetState.closedCandles.length > 50) {
                    assetState.closedCandles = assetState.closedCandles.slice(-50);
                }

                await new Promise(r => setTimeout(r, 500));
            } catch (err) {
                LOGGER.error(`❌ [${symbol}] maxStreak fetch failed: ${err.message}`);
                if (!this.data.assets[symbol]) {
                    this.data.assets[symbol] = { maxStreak: 10, computedAt: Date.now() };
                    this._save();
                }
            }
        }

        this.data.lastUpdated = Date.now();
        this._save();
        this._isComputing = false;

        const summary = CONFIG.ACTIVE_ASSETS
            .map(s => `  ${s}: maxStreak=${this.data.assets[s]?.maxStreak ?? 'N/A'}`)
            .join('\n');

        LOGGER.info('✅ All asset maxStreaks computed. Trading resuming.');
        await TelegramService.sendMessage(
            '✅ <b>RISEFALL2b MaxStreak Update Complete</b>\n' +
            `${summary}\nTrading has RESUMED.`
        );
    }

    scheduleMonthlyRefresh(connection) {
        if (this._refreshTimer) clearTimeout(this._refreshTimer);

        const msUntilRefresh = this.data.lastUpdated
            ? Math.max(0, this._updateIntervalMs - (Date.now() - this.data.lastUpdated))
            : 0;

        const MAX_TIMEOUT = 2147483647;

        if (msUntilRefresh > MAX_TIMEOUT) {
            this._refreshTimer = setTimeout(() => this.scheduleMonthlyRefresh(connection), MAX_TIMEOUT);
            return;
        }

        LOGGER.info(`🗓️ Next assetMaxStreak refresh in ${(msUntilRefresh / 3600000).toFixed(1)} hours`);

        this._refreshTimer = setTimeout(async () => {
            LOGGER.info('🗓️ Monthly maxStreak refresh triggered — pausing trading...');
            state.isMaxStreakReady = false;

            CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                if (state.assets[symbol]) state.assets[symbol].canTrade = false;
            });

            await this.computeAllMaxStreaks(connection);

            state.isMaxStreakReady = true;

            CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                if (typeof bot !== 'undefined' && bot.subscribeToCandles) {
                    bot.subscribeToCandles(symbol);
                }
            });

            this.scheduleMonthlyRefresh(connection);
        }, msUntilRefresh);
    }
}

// ============================================
// TRADE HISTORY MANAGER
// ============================================
class TradeHistoryManager {
    static getDateKey() {
        return new Date().toISOString().split('T')[0];
    }

    static loadHistory() {
        try {
            if (!fs.existsSync(HISTORY_FILE)) {
                LOGGER.info('📁 No trade history file found, starting fresh');
                return this._emptyHistory();
            }
            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            if (!data.dailyHistory)   data.dailyHistory   = {};
            if (!data.overallAssets)  data.overallAssets  = {};
            if (!data.overall)        data.overall        = this._emptyOverall();
            LOGGER.info(`📁 Trade history loaded — ${Object.keys(data.dailyHistory).length} days`);
            return data;
        } catch (error) {
            LOGGER.error(`Failed to load trade history: ${error.message}`);
            return this._emptyHistory();
        }
    }

    static _emptyOverall() {
        return {
            tradesCount: 0, winsCount: 0, lossesCount: 0,
            profit: 0, loss: 0, netPL: 0,
            x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
            x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0,
            firstTradeDate: null, lastTradeDate: null
        };
    }

    static _emptyHistory() {
        return {
            overall: this._emptyOverall(),
            overallAssets: {},
            dailyHistory: {},
            lastUpdated: Date.now()
        };
    }

    static saveHistory() {
        try {
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
        } catch (error) {
            LOGGER.error(`Failed to save trade history: ${error.message}`);
        }
    }

    static ensureDayEntry(dateKey) {
        if (!tradeHistory.dailyHistory[dateKey]) {
            tradeHistory.dailyHistory[dateKey] = {
                date: dateKey,
                tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0,
                x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
                x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0,
                assets: {},
                startCapital: state.capital,
                endCapital: state.capital
            };
        }
    }

    static ensureAssetDayEntry(dateKey, symbol) {
        this.ensureDayEntry(dateKey);
        if (!tradeHistory.dailyHistory[dateKey].assets[symbol]) {
            tradeHistory.dailyHistory[dateKey].assets[symbol] = {
                tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0,
                x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
                x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0
            };
        }
    }

    static ensureOverallAssetEntry(symbol) {
        if (!tradeHistory.overallAssets[symbol]) {
            tradeHistory.overallAssets[symbol] = {
                tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0,
                x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
                x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0
            };
        }
    }

    static recordTrade(symbol, profit, martingaleLevel) {
        const dateKey = this.getDateKey();
        this.ensureAssetDayEntry(dateKey, symbol);
        this.ensureOverallAssetEntry(symbol);

        const dayStats      = tradeHistory.dailyHistory[dateKey];
        const dayAssetStats = dayStats.assets[symbol];
        const overall       = tradeHistory.overall;
        const overallAsset  = tradeHistory.overallAssets[symbol];

        const targets = [dayStats, dayAssetStats, overall, overallAsset];
        targets.forEach(t => t.tradesCount++);

        if (!overall.firstTradeDate) overall.firstTradeDate = dateKey;
        overall.lastTradeDate = dateKey;

        if (profit > 0) {
            targets.forEach(t => { t.winsCount++; t.profit += profit; t.netPL += profit; });
        } else {
            targets.forEach(t => { t.lossesCount++; t.loss += Math.abs(profit); t.netPL += profit; });
            if (martingaleLevel >= 2 && martingaleLevel <= 9) {
                const key = `x${martingaleLevel}Losses`;
                targets.forEach(t => { if (t[key] !== undefined) t[key]++; });
            }
        }

        dayStats.endCapital      = state.capital;
        tradeHistory.lastUpdated = Date.now();
        this.saveHistory();
    }

    static getTodayStats() {
        const dateKey = this.getDateKey();
        this.ensureDayEntry(dateKey);
        return tradeHistory.dailyHistory[dateKey];
    }

    static getOverallStats() { return tradeHistory.overall; }
    static getDayStats(dateKey) { return tradeHistory.dailyHistory[dateKey] || null; }
    static getAllDays() { return Object.keys(tradeHistory.dailyHistory).sort(); }
    static getRecentDays(n = 7) {
        const days = this.getAllDays();
        return days.slice(-n).map(dateKey => ({ date: dateKey, ...tradeHistory.dailyHistory[dateKey] }));
    }
}

// ============================================
// STATE PERSISTENCE
// ============================================
class StatePersistence {
    static saveState() {
        try {
            const persistableState = {
                savedAt: Date.now(),
                capital: state.capital,
                session: { ...state.session },
                portfolio: {
                    dailyProfit:  state.portfolio.dailyProfit,
                    dailyLoss:    state.portfolio.dailyLoss,
                    dailyWins:    state.portfolio.dailyWins,
                    dailyLosses:  state.portfolio.dailyLosses
                },
                hourlyStats: { ...state.hourlyStats },
                currentTradeDay: state.currentTradeDay,
                assets: {}
            };

            Object.keys(state.assets).forEach(symbol => {
                const asset = state.assets[symbol];
                const assetConfig = getAssetConfig(symbol);
                persistableState.assets[symbol] = {
                    closedCandles: asset.closedCandles.slice(-assetConfig.MAX_CANDLES_STORED),
                    lastProcessedCandleOpenTime: asset.lastProcessedCandleOpenTime,
                    candlesLoaded:               asset.candlesLoaded,
                    lastTradeDirection:          asset.lastTradeDirection,
                    lastTradeWasWin:             asset.lastTradeWasWin,
                    martingaleLevel:             asset.martingaleLevel,
                    currentStake:                asset.currentStake,
                    canTrade:                    asset.canTrade,
                    lastClosedCandleForRecovery: asset.lastClosedCandleForRecovery || null,
                    tradesCount: asset.tradesCount, winsCount:  asset.winsCount,
                    lossesCount: asset.lossesCount, profit:     asset.profit,
                    loss:        asset.loss,         netPL:      asset.netPL,
                    x2Losses:    asset.x2Losses,    x3Losses:   asset.x3Losses,
                    x4Losses:    asset.x4Losses,    x5Losses:   asset.x5Losses,
                    x6Losses:    asset.x6Losses,    x7Losses:   asset.x7Losses,
                    x8Losses:    asset.x8Losses,    x9Losses:   asset.x9Losses,
                    activePositions: asset.activePositions.map(pos => ({
                        symbol:       pos.symbol,    direction:    pos.direction,
                        stake:        pos.stake,     duration:     pos.duration,
                        durationUnit: pos.durationUnit, entryTime: pos.entryTime,
                        contractId:   pos.contractId,   reqId:     pos.reqId,
                        buyPrice:     pos.buyPrice,  currentProfit: pos.currentProfit
                    }))
                };
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
        } catch (error) {
            LOGGER.error(`Failed to save state: ${error.message}`);
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                LOGGER.info('📁 No previous state file found, starting fresh');
                return false;
            }

            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            if (ageMinutes > 30) {
                LOGGER.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            LOGGER.info(`📁 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);

            state.capital = savedData.capital;
            state.session = {
                ...state.session, ...savedData.session,
                startTime:    savedData.session.startTime    || Date.now(),
                startCapital: savedData.session.startCapital || savedData.capital
            };
            state.portfolio.dailyProfit  = savedData.portfolio.dailyProfit;
            state.portfolio.dailyLoss    = savedData.portfolio.dailyLoss;
            state.portfolio.dailyWins    = savedData.portfolio.dailyWins;
            state.portfolio.dailyLosses  = savedData.portfolio.dailyLosses;
            state.currentTradeDay        = savedData.currentTradeDay || TradeHistoryManager.getDateKey();
            state.hourlyStats            = savedData.hourlyStats || {
                trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours()
            };

            if (savedData.assets) {
                Object.keys(savedData.assets).forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = savedData.assets[symbol];
                        const asset = state.assets[symbol];

                        if (saved.closedCandles?.length > 0) {
                            asset.closedCandles = saved.closedCandles;
                            LOGGER.info(`📊 Restored ${saved.closedCandles.length} closed candles for ${symbol}`);
                        }
                        asset.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                        asset.candlesLoaded               = saved.candlesLoaded   || false;
                        asset.lastTradeDirection          = saved.lastTradeDirection || null;
                        asset.lastTradeWasWin             = saved.lastTradeWasWin  ?? null;
                        asset.martingaleLevel             = saved.martingaleLevel  || 0;
                        asset.currentStake                = saved.currentStake     || CONFIG.STAKE;
                        asset.canTrade                    = false; // Always start as false; re-enabled on next candle
                        asset.lastClosedCandleForRecovery = saved.lastClosedCandleForRecovery || null;
                        asset.tradesCount = saved.tradesCount || 0;
                        asset.winsCount   = saved.winsCount   || 0;
                        asset.lossesCount = saved.lossesCount || 0;
                        asset.profit      = saved.profit      || 0;
                        asset.loss        = saved.loss        || 0;
                        asset.netPL       = saved.netPL       || 0;
                        asset.x2Losses    = saved.x2Losses   || 0;
                        asset.x3Losses    = saved.x3Losses   || 0;
                        asset.x4Losses    = saved.x4Losses   || 0;
                        asset.x5Losses    = saved.x5Losses   || 0;
                        asset.x6Losses    = saved.x6Losses   || 0;
                        asset.x7Losses    = saved.x7Losses   || 0;
                        asset.x8Losses    = saved.x8Losses   || 0;
                        asset.x9Losses    = saved.x9Losses   || 0;
                        // Restore active positions but they'll need to be re-verified
                        asset.activePositions = (saved.activePositions || []).map(
                            pos => ({ ...pos, entryTime: pos.entryTime || Date.now() })
                        );

                        LOGGER.info(
                            `📊 ${symbol}: Martingale=${asset.martingaleLevel}, ` +
                            `Stake=$${asset.currentStake.toFixed(2)}, P/L=$${asset.netPL.toFixed(2)}, ` +
                            `Positions=${asset.activePositions.length}`
                        );
                    }
                });
            }

            LOGGER.info(`✅ State restored! Capital: $${state.capital.toFixed(2)} | Session P/L: $${state.session.netPL.toFixed(2)}`);
            return true;
        } catch (error) {
            LOGGER.error(`Failed to load state: ${error.message}`);
            return false;
        }
    }

    static startAutoSave() {
        setInterval(() => {
            if (state.isAuthorized) this.saveState();
        }, STATE_SAVE_INTERVAL);
        LOGGER.info(`💾 Auto-save enabled (every ${STATE_SAVE_INTERVAL / 1000}s)`);
    }

    static clearState() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                fs.unlinkSync(STATE_FILE);
                LOGGER.info('🗑️ State file cleared');
            }
        } catch (error) {
            LOGGER.error(`Failed to clear state: ${error.message}`);
        }
    }
}

// ============================================
// TELEGRAM SERVICE
// ============================================
class TelegramService {
    static hourlyTimerStarted = false;
    static dailyTimerStarted  = false;
    static hourlyTimerId      = null;
    static dailyTimerId       = null;

    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED) return;
        if (!message || message.length === 0) {
            LOGGER.error('[TELEGRAM] ❌ Empty message, not sending');
            return;
        }
        try {
            const url  = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const data = JSON.stringify({
                chat_id: CONFIG.TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            });
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(data, 'utf8')
                }
            };
            return new Promise((resolve, reject) => {
                const req = https.request(url, options, res => {
                    let body = '';
                    res.on('data', chunk => (body += chunk));
                    res.on('end', () => {
                        if (res.statusCode === 200) resolve(true);
                        else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
                    });
                });
                req.on('error', reject);
                req.write(data);
                req.end();
            }).then(() => {
                LOGGER.info('[TELEGRAM] ✅ Message sent');
            }).catch(error => {
                LOGGER.error(`[TELEGRAM] ❌ Send failed: ${error.message}`);
            });
        } catch (error) {
            LOGGER.error(`[TELEGRAM] ❌ Exception: ${error.message}`);
        }
    }

    static async sendTradeAlert(type, symbol, direction, stake, duration, durationUnit, details = {}) {
        const emoji      = type === 'OPEN' ? '🚀' : type === 'WIN' ? '✅' : '❌';
        const assetState = state.assets[symbol];
        const assetMartingale = assetState?.martingaleLevel ?? 0;
        const assetNetPL      = assetState?.netPL ?? 0;
        const assetWins       = assetState?.winsCount ?? 0;
        const assetLosses     = assetState?.lossesCount ?? 0;

        const overall   = TradeHistoryManager.getOverallStats();
        const today     = TradeHistoryManager.getTodayStats();
        const regime    = assetState ? AlternatingRegimeDetector.analyze(assetState.closedCandles) : { autocorrelation: 0 };
        const assetMaxStreak = assetMaxStreakManager?.getMaxStreak(symbol) ?? 'N/A';

        const message = `
${emoji} <b>${type} TRADE ALERT 2b</b>
Asset: ${symbol}
Direction: ${direction}
Stake: $${stake.toFixed(2)}
Duration: ${duration} (${durationUnit === 't' ? 'Ticks' : durationUnit === 's' ? 'Seconds' : 'Minutes'})
Martingale Level: ${assetMartingale}
Autocorrelation: ${regime.autocorrelation.toFixed(4)} | AssetMaxStreak: ${assetMaxStreak}
${details.profit !== undefined
    ? `Profit: $${details.profit.toFixed(2)}

📊 <b>Today's Stats:</b>
${symbol} P&amp;L: $${assetNetPL.toFixed(2)}
${symbol} W/L: ${assetWins}/${assetLosses}
Today P&amp;L: $${(today.netPL || 0).toFixed(2)}
Today W/L: ${today.winsCount || 0}/${today.lossesCount || 0}
${type !== 'OPEN' ? `Loss Stats: x2:${today.x2Losses||0} | x3:${today.x3Losses||0} | x4:${today.x4Losses||0} | x5:${today.x5Losses||0} | x6:${today.x6Losses||0} | x7:${today.x7Losses||0} | x8:${today.x8Losses||0} | x9:${today.x9Losses||0}` : ''}

📋 <b>Overall Stats:</b>
Overall P&amp;L: $${(overall.netPL || 0).toFixed(2)}
Overall W/L: ${overall.winsCount || 0}/${overall.lossesCount || 0}
Total Trades: ${overall.tradesCount || 0}
Capital: $${state.capital.toFixed(2)}
Loss Stats: x2:${overall.x2Losses||0} | x3:${overall.x3Losses||0} | x4:${overall.x4Losses||0} | x5:${overall.x5Losses||0} | x6:${overall.x6Losses||0} | x7:${overall.x7Losses||0} | x8:${overall.x8Losses||0} | x9:${overall.x9Losses||0}
`
    : `Signal: autocorrelation(${regime.autocorrelation.toFixed(4)}) &lt; ${CONFIG.AUTOCORR_THRESHOLD}`
}`.trim();

        await this.sendMessage(message);
    }

    static async sendSessionSummary() {
        try {
            const stats   = SessionManager.getSessionStats();
            const today   = TradeHistoryManager.getTodayStats();
            const overall = TradeHistoryManager.getOverallStats();

            let assetBreakdown = '';
            CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                const a = state.assets[symbol];
                if (a && a.tradesCount > 0) {
                    const winRate    = ((a.winsCount / a.tradesCount) * 100).toFixed(1);
                    const ms         = assetMaxStreakManager?.getMaxStreak(symbol) ?? 'N/A';
                    const regime     = AlternatingRegimeDetector.analyze(a.closedCandles);
                    assetBreakdown += `\n  ${symbol}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L (${winRate}%), P/L: $${a.netPL.toFixed(2)}, Mart: ${a.martingaleLevel}, MaxStreak: ${ms}, AutoCorr: ${regime.autocorrelation.toFixed(4)}`;
                }
            });

            let overallAssetBreakdown = '';
            if (tradeHistory.overallAssets) {
                CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                    const oa = tradeHistory.overallAssets[symbol];
                    if (oa && oa.tradesCount > 0) {
                        const winRate = ((oa.winsCount / oa.tradesCount) * 100).toFixed(1);
                        overallAssetBreakdown += `\n  ${symbol}: ${oa.tradesCount}t ${oa.winsCount}W/${oa.lossesCount}L (${winRate}%), P/L: $${oa.netPL.toFixed(2)}`;
                    }
                });
            }

            const recentDays = TradeHistoryManager.getRecentDays(5);
            let recentDaysStr = '';
            recentDays.forEach(day => {
                const wr       = day.tradesCount > 0 ? ((day.winsCount / day.tradesCount) * 100).toFixed(1) : '0.0';
                const pnlEmoji = day.netPL >= 0 ? '🟢' : '🔴';
                recentDaysStr += `\n  ${day.date}: ${day.tradesCount}t ${day.winsCount}W/${day.lossesCount}L (${wr}%) ${pnlEmoji} $${(day.netPL || 0).toFixed(2)}`;
            });

            const overallWinRate = overall.tradesCount > 0
                ? ((overall.winsCount / overall.tradesCount) * 100).toFixed(1) + '%'
                : '0.0%';

            const message = [
                `📊 <b>SESSION SUMMARY 2b</b>`, ``,
                `🗓️ <b>Today (${TradeHistoryManager.getDateKey()}):</b>`,
                `Duration: ${stats.duration}`, `Trades: ${stats.trades}`,
                `Wins: ${stats.wins} | Losses: ${stats.losses}`,
                `Win Rate: ${stats.winRate}`,
                `Loss Stats: x2:${today.x2Losses||0} | x3:${today.x3Losses||0} | x4:${today.x4Losses||0} | x5:${today.x5Losses||0} | x6:${today.x6Losses||0} | x7:${today.x7Losses||0} | x8:${today.x8Losses||0} | x9:${today.x9Losses||0}`,
                `Today P/L: $${(today.netPL || 0).toFixed(2)}`, ``,
                `📋 <b>Today's Per-Asset:</b>${assetBreakdown || '\n  No trades yet'}`, ``,
                `📊 <b>Overall Stats:</b>`,
                `Total Trades: ${overall.tradesCount || 0}`,
                `Overall Win Rate: ${overallWinRate}`,
                `Overall P/L: $${(overall.netPL || 0).toFixed(2)}`,
                `Loss Stats: x2:${overall.x2Losses||0} | x3:${overall.x3Losses||0} | x4:${overall.x4Losses||0} | x5:${overall.x5Losses||0} | x6:${overall.x6Losses||0} | x7:${overall.x7Losses||0} | x8:${overall.x8Losses||0} | x9:${overall.x9Losses||0}`,
                `📋 <b>Overall Per-Asset:</b>${overallAssetBreakdown || '\n  No trades yet'}`, ``,
                `🗓️ <b>Recent Days:</b>${recentDaysStr || '\n  No history yet'}`, ``,
                `💰 Current Capital: $${state.capital.toFixed(2)}`
            ].join('\n');

            await this.sendMessage(message);
        } catch (err) {
            LOGGER.error(`❌ sendSessionSummary crashed: ${err.message}`);
        }
    }

    static async sendDayEndSummary(dateKey) {
        try {
            const dayStats = TradeHistoryManager.getDayStats(dateKey);
            const overall  = TradeHistoryManager.getOverallStats();
            if (!dayStats || dayStats.tradesCount === 0) return;

            const dayWinRate     = dayStats.tradesCount > 0 ? ((dayStats.winsCount / dayStats.tradesCount) * 100).toFixed(1) + '%' : '0.0%';
            const overallWinRate = overall.tradesCount  > 0 ? ((overall.winsCount  / overall.tradesCount)  * 100).toFixed(1) + '%' : '0.0%';

            let assetBreakdown = '';
            if (dayStats.assets) {
                Object.keys(dayStats.assets).forEach(symbol => {
                    const a = dayStats.assets[symbol];
                    if (a && a.tradesCount > 0) {
                        const wr = ((a.winsCount / a.tradesCount) * 100).toFixed(1);
                        assetBreakdown += `\n  ${symbol}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L (${wr}%) P/L: $${(a.netPL||0).toFixed(2)}`;
                    }
                });
            }

            const pnlEmoji = (dayStats.netPL || 0) >= 0 ? '🟢' : '🔴';
            const message  = [
                `🌙 <b>END OF DAY REPORT 2b - ${dateKey}</b>`, ``,
                `${pnlEmoji} <b>Day Results:</b>`,
                `├ Trades: ${dayStats.tradesCount}`,
                `├ Wins: ${dayStats.winsCount} | Losses: ${dayStats.lossesCount}`,
                `├ Win Rate: ${dayWinRate}`,
                `├ Net P/L: $${(dayStats.netPL||0).toFixed(2)}`,
                `├ Start Capital: $${(dayStats.startCapital||0).toFixed(2)}`,
                `└ End Capital: $${(dayStats.endCapital||0).toFixed(2)}`, ``,
                `📋 <b>Per-Asset:</b>${assetBreakdown || '\n  No trades'}`, ``,
                `📊 <b>Overall Stats (All Time):</b>`,
                `├ Total Trades: ${overall.tradesCount || 0}`,
                `├ Overall Win Rate: ${overallWinRate}`,
                `├ Overall P/L: $${(overall.netPL || 0).toFixed(2)}`,
                `└ Loss Stats: x2:${overall.x2Losses||0} x3:${overall.x3Losses||0} x4:${overall.x4Losses||0} x5:${overall.x5Losses||0} x6:${overall.x6Losses||0} x7:${overall.x7Losses||0} x8:${overall.x8Losses||0} x9:${overall.x9Losses||0}`,
                ``,
                `💰 Current Capital: $${state.capital.toFixed(2)}`
            ].join('\n');

            await this.sendMessage(message);
        } catch (err) {
            LOGGER.error(`❌ sendDayEndSummary crashed: ${err.message}`);
        }
    }

    static async sendStartupMessage() {
        try {
            const overall    = TradeHistoryManager.getOverallStats();
            const totalDays  = TradeHistoryManager.getAllDays().length;

            let assetConfigInfo = '';
            CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                const ac = getAssetConfig(symbol);
                const ms = assetMaxStreakManager?.getMaxStreak(symbol) ?? 'Computing...';
                assetConfigInfo += `\n  ${symbol}: ${ac.TIMEFRAME_LABEL} candles, Duration: ${ac.DURATION}${ac.DURATION_UNIT}, MaxStreak: ${ms}`;
            });

            const message = [
                `🤖 <b>DERIV RISE/FALL BOT STARTED 2b</b>`,
                `Strategy: assetMaxStreak detection`,
                `Mode: <b>Independent Per-Asset Management</b>`,
                `Capital: $${state.capital.toFixed(2)}`,
                `Stake: $${CONFIG.STAKE}`, ``,
                `🔧 <b>Asset Configurations:</b>${assetConfigInfo}`, ``,
                `📊 <b>Historical Stats:</b>`,
                `├ Trading Days: ${totalDays}`,
                `├ Total Trades: ${overall.tradesCount || 0}`,
                `└ Overall P/L: $${(overall.netPL || 0).toFixed(2)}`
            ].join('\n');

            await this.sendMessage(message);
        } catch (error) {
            LOGGER.error(`[TELEGRAM] Failed to send startup message: ${error.message}`);
        }
    }

    static async sendHourlySummary() {
        try {
            const statsSnapshot = { ...state.hourlyStats };
            if (statsSnapshot.trades === 0) {
                LOGGER.info('📊 Telegram: Skipping hourly summary (no trades this hour)');
                return;
            }

            const totalTrades = statsSnapshot.wins + statsSnapshot.losses;
            const winRate     = totalTrades > 0 ? ((statsSnapshot.wins / totalTrades) * 100).toFixed(1) : '0.0';
            const pnlEmoji    = statsSnapshot.pnl >= 0 ? '🟢' : '🔴';
            const pnlStr      = (statsSnapshot.pnl >= 0 ? '+' : '') + '$' + statsSnapshot.pnl.toFixed(2);
            const today       = TradeHistoryManager.getTodayStats();

            let assetInfo = '';
            CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                const a = state.assets[symbol];
                if (a) {
                    const ac     = getAssetConfig(symbol);
                    const ms     = assetMaxStreakManager?.getMaxStreak(symbol) ?? 'N/A';
                    const regime = AlternatingRegimeDetector.analyze(a.closedCandles);
                    assetInfo   += `\n  ${symbol} (${ac.TIMEFRAME_LABEL}/${ac.DURATION}${ac.DURATION_UNIT}): Mart=${a.martingaleLevel}, Stake=$${a.currentStake.toFixed(2)}, P/L=$${a.netPL.toFixed(2)}, MaxStreak=${ms}, AutoCorr: ${regime.autocorrelation.toFixed(4)}`;
                }
            });

            const message = [
                `⏰ <b>Rise/Fall Bot Hourly Summary 2b</b>`, ``,
                `📊 <b>Last Hour</b>`,
                `├ Trades: ${statsSnapshot.trades}`,
                `├ Wins: ${statsSnapshot.wins} | Losses: ${statsSnapshot.losses}`,
                `├ Win Rate: ${winRate}%`,
                `└ ${pnlEmoji} <b>P&amp;L:</b> ${pnlStr}`, ``,
                `🗓️ <b>Today</b>`,
                `├ Total Trades: ${today.tradesCount || 0}`,
                `└ Today P&amp;L: ${(today.netPL || 0) >= 0 ? '+' : ''}$${(today.netPL || 0).toFixed(2)}`, ``,
                `💰 Current Capital: $${state.capital.toFixed(2)}`, ``,
                `🔧 <b>Per-Asset Status:</b>${assetInfo}`
            ].join('\n');

            await this.sendMessage(message);
            LOGGER.info('📊 Telegram: Hourly Summary sent');
            // Reset hourly stats after sending
            state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
        } catch (err) {
            LOGGER.error(`❌ sendHourlySummary crashed: ${err.message}`);
        }
    }

    static startHourlyTimer() {
        if (this.hourlyTimerStarted) {
            LOGGER.debug('⏰ Hourly timer already started, skipping');
            return;
        }
        this.hourlyTimerStarted = true;

        const now             = new Date();
        const nextHour        = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const timeUntilNext   = nextHour.getTime() - now.getTime();

        LOGGER.info(`⏰ Hourly timer started (first in ${Math.ceil(timeUntilNext / 60000)} min)`);

        setTimeout(() => {
            this.sendHourlySummary();
            this.hourlyTimerId = setInterval(() => this.sendHourlySummary(), 60 * 60 * 1000);
        }, timeUntilNext);
    }

    static startDailyTimer() {
        if (this.dailyTimerStarted) {
            LOGGER.debug('🗓️ Daily timer already started, skipping');
            return;
        }
        this.dailyTimerStarted = true;

        const now           = new Date();
        const nextDay       = new Date(now);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(0, 0, 0, 0);
        const timeUntilNext = nextDay.getTime() - now.getTime();

        LOGGER.info(`🗓️ Daily timer started (first in ${Math.ceil(timeUntilNext / 60000 / 60)} hours)`);

        setTimeout(() => {
            if (typeof SessionManager !== 'undefined') SessionManager.checkDayChange();
            this.dailyTimerId = setInterval(() => {
                if (typeof SessionManager !== 'undefined') SessionManager.checkDayChange();
            }, 24 * 60 * 60 * 1000);
        }, timeUntilNext);
    }

    static clearTimers() {
        if (this.hourlyTimerId) {
            clearInterval(this.hourlyTimerId);
            this.hourlyTimerId    = null;
            this.hourlyTimerStarted = false;
        }
        if (this.dailyTimerId) {
            clearInterval(this.dailyTimerId);
            this.dailyTimerId    = null;
            this.dailyTimerStarted = false;
        }
        LOGGER.info('🧹 Telegram timers cleared');
    }
}

// ============================================
// CANDLE ANALYSIS UTILITY
// ============================================
class CandleAnalyzer {
    static isBullish(candle)  { return candle.close > candle.open; }
    static isBearish(candle)  { return candle.close < candle.open; }

    static getLastClosedCandle(symbol) {
        const assetState = state.assets[symbol];
        if (!assetState?.closedCandles?.length) return null;
        return assetState.closedCandles[assetState.closedCandles.length - 1];
    }

    static getCandleDirection(candle) {
        if (this.isBullish(candle)) return 'BULLISH';
        if (this.isBearish(candle)) return 'BEARISH';
        return 'DOJI';
    }
}

// ============================================
// ALTERNATING REGIME DETECTOR
// ============================================
class AlternatingRegimeDetector {
    static analyze(candleHistory) {
        if (!Array.isArray(candleHistory) || candleHistory.length < 4) {
            return { autocorrelation: 0 };
        }

        const validCandles = candleHistory.filter(c =>
            c && typeof c.open === 'number' && typeof c.close === 'number' &&
            !isNaN(c.open) && !isNaN(c.close)
        );

        if (validCandles.length < 4) return { autocorrelation: 0 };

        const seq             = validCandles.map(c => (c.close > c.open ? 1 : 0));
        const autocorrelation = this._autocorrelation(seq);

        if (isNaN(autocorrelation) || !isFinite(autocorrelation)) return { autocorrelation: 0 };

        return { autocorrelation };
    }

    static _autocorrelation(seq) {
        const n = seq.length;
        if (n < 4) return 0;

        const x     = seq.slice(0, n - 1);
        const y     = seq.slice(1);
        const meanX = x.reduce((a, b) => a + b, 0) / x.length;
        const meanY = y.reduce((a, b) => a + b, 0) / y.length;

        let num = 0, dX = 0, dY = 0;
        for (let i = 0; i < x.length; i++) {
            const dx = x[i] - meanX;
            const dy = y[i] - meanY;
            num += dx * dy;
            dX  += dx * dx;
            dY  += dy * dy;
        }

        const denom = Math.sqrt(dX * dY);
        return denom === 0 ? 0 : num / denom;
    }
}

// ============================================
// TRADING SESSION HELPER
// ============================================
class TradingSessionManager {
    static getGMTPlus1Time() {
        return new Date(Date.now() + 3600000);
    }

    static isWithinTradingSession() {
        const gmt1    = this.getGMTPlus1Time();
        const decimal = gmt1.getUTCHours() + gmt1.getUTCMinutes() / 60;

        const sessions = [
            { name: 'TOKYO',    start: CONFIG.TOKYO_START,    end: CONFIG.TOKYO_END },
            { name: 'LONDON',   start: CONFIG.LONDON_START,   end: CONFIG.LONDON_END },
            { name: 'NEW YORK', start: CONFIG.NEWYORK_START,  end: CONFIG.NEWYORK_END },
            { name: 'SYDNEY',   start: CONFIG.SYDNEY_START,   end: CONFIG.SYDNEY_END }
        ];

        for (const session of sessions) {
            let inSession = false;
            if (session.end < session.start) {
                // Overnight session (e.g. SYDNEY wraps midnight)
                inSession = decimal >= session.start || decimal < session.end;
            } else {
                inSession = decimal >= session.start && decimal < session.end;
            }
            if (inSession) return { inSession: true, sessionName: session.name, nextSession: null, minutesUntilNext: 0 };
        }

        // Find next session
        const sorted = [...sessions].sort((a, b) => a.start - b.start);
        const next   = sorted.find(s => s.start > decimal) || sorted[0];
        const minutesUntilNext = next.start > decimal
            ? (next.start - decimal) * 60
            : ((24 - decimal) + next.start) * 60;

        return { inSession: false, sessionName: null, nextSession: next.name, minutesUntilNext: Math.round(minutesUntilNext) };
    }

    static getSessionStatusString() {
        const info  = this.isWithinTradingSession();
        const gmt1  = this.getGMTPlus1Time();
        const time  = `${String(gmt1.getUTCHours()).padStart(2,'0')}:${String(gmt1.getUTCMinutes()).padStart(2,'0')} GMT+1`;
        if (info.inSession) return `🟢 IN SESSION: ${info.sessionName} (${time})`;
        return `🔴 OUTSIDE SESSION (${time}) — Next: ${info.nextSession} in ${info.minutesUntilNext}min`;
    }
}

// ============================================
// SESSION MANAGER
// ============================================
class SessionManager {
    static isSessionActive() { return state.session.isActive; }

    static checkSessionTargets() {
        const netPL = state.session.netPL;
        if (netPL >= CONFIG.SESSION_PROFIT_TARGET) {
            LOGGER.trade(`🎯 SESSION PROFIT TARGET REACHED! Net P/L: $${netPL.toFixed(2)}`);
            this.endSession('PROFIT_TARGET');
            return true;
        }
        if (netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.error(`🛑 SESSION STOP LOSS REACHED! Net P/L: $${netPL.toFixed(2)}`);
            this.endSession('STOP_LOSS');
            return true;
        }
        return false;
    }

    static async endSession(reason) {
        state.session.isActive = false;
        LOGGER.info(`🛑 Session ended (${reason}).`);
        TelegramService.sendSessionSummary();
    }

    static getSessionStats() {
        const duration = Date.now() - state.session.startTime;
        const hours    = Math.floor(duration / 3600000);
        const minutes  = Math.floor((duration % 3600000) / 60000);
        return {
            duration: `${hours}h ${minutes}m`,
            trades:   state.session.tradesCount,
            wins:     state.session.winsCount,
            losses:   state.session.lossesCount,
            winRate:  state.session.tradesCount > 0
                ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1) + '%'
                : '0%',
            x2Losses: state.session.x2Losses, x3Losses: state.session.x3Losses,
            x4Losses: state.session.x4Losses, x5Losses: state.session.x5Losses,
            x6Losses: state.session.x6Losses, x7Losses: state.session.x7Losses,
            x8Losses: state.session.x8Losses, x9Losses: state.session.x9Losses,
            netPL: state.session.netPL
        };
    }

    static checkDayChange() {
        const currentDay = TradeHistoryManager.getDateKey();
        if (state.currentTradeDay && state.currentTradeDay !== currentDay) {
            LOGGER.info(`🗓️ Day changed: ${state.currentTradeDay} → ${currentDay}`);
            TelegramService.sendDayEndSummary(state.currentTradeDay);
            this.resetSessionForNewDay();
        }
        state.currentTradeDay = currentDay;
    }

    static resetSessionForNewDay() {
        LOGGER.info('🗓️ Resetting session stats for new trading day...');
        const s = state.session;
        s.tradesCount = 0; s.winsCount = 0; s.lossesCount = 0;
        s.profit = 0; s.loss = 0; s.netPL = 0;
        s.x2Losses = 0; s.x3Losses = 0; s.x4Losses = 0;
        s.x5Losses = 0; s.x6Losses = 0; s.x7Losses = 0;
        s.x8Losses = 0; s.x9Losses = 0;
        s.startTime    = Date.now();
        s.startCapital = state.capital;
        state.lastSessionLogTime = 0;

        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset) {
                asset.tradesCount = 0; asset.winsCount = 0; asset.lossesCount = 0;
                asset.profit = 0; asset.loss = 0; asset.netPL = 0;
            }
        });

        state.portfolio.dailyProfit  = 0; state.portfolio.dailyLoss    = 0;
        state.portfolio.dailyWins    = 0; state.portfolio.dailyLosses  = 0;
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };

        // Reset watchdog fields
        state.pendingTradeInfo  = null;
        state.currentContractId = null;
        state.tradeStartTime    = null;

        TradeHistoryManager.ensureDayEntry(TradeHistoryManager.getDateKey());
        tradeHistory.dailyHistory[TradeHistoryManager.getDateKey()].startCapital = state.capital;
        TradeHistoryManager.saveHistory();
        LOGGER.info('🗓️ Daily stats reset (martingale state preserved)');
    }

    /**
     * FIX #2 (continued): recordTradeResult no longer mutates ACTIVE_ASSETS.
     * Asset locking is now purely per-asset via activePositions count.
     */
    static recordTradeResult(symbol, profit, direction) {
        const assetState = state.assets[symbol];
        if (!assetState) { LOGGER.error(`recordTradeResult: Unknown symbol ${symbol}`); return; }

        this.checkDayChange();

        const currentHour = new Date().getHours();
        if (currentHour !== state.hourlyStats.lastHour) {
            state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: currentHour };
        }

        state.session.tradesCount++;
        state.capital           += profit;
        state.hourlyStats.trades++;
        state.hourlyStats.pnl   += profit;
        assetState.tradesCount++;

        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit   += profit;
            state.session.netPL    += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            state.hourlyStats.wins++;
            assetState.winsCount++;
            assetState.profit  += profit;
            assetState.netPL   += profit;
            assetState.martingaleLevel = 0;
            assetState.lastTradeWasWin = true;
            assetState.currentStake    = CONFIG.STAKE;

            // FIX #2: Do NOT mutate ACTIVE_ASSETS here
            // The original code set ACTIVE_ASSETS = [symbol] then reset to CONFIG.ACTIVE_ASSETS on win
            // but this caused all other assets to be excluded when win happened during their candle cycle

            TradeHistoryManager.recordTrade(symbol, profit, 0);
            LOGGER.trade(`✅ [${symbol}] WIN: +$${profit.toFixed(2)} | Direction: ${direction} | Martingale Reset | P/L: $${assetState.netPL.toFixed(2)}`);

        } else {
            state.session.lossesCount++;
            state.session.loss     += Math.abs(profit);
            state.session.netPL    += profit;
            state.portfolio.dailyLoss    += Math.abs(profit);
            state.portfolio.dailyLosses++;
            state.hourlyStats.losses++;
            assetState.lossesCount++;
            assetState.loss   += Math.abs(profit);
            assetState.netPL  += profit;
            assetState.martingaleLevel++;
            assetState.lastTradeWasWin = false;

            if (assetState.martingaleLevel >= 2 && assetState.martingaleLevel <= 9) {
                const key = `x${assetState.martingaleLevel}Losses`;
                if (assetState[key]    !== undefined) assetState[key]++;
                if (state.session[key] !== undefined) state.session[key]++;
            }

            TradeHistoryManager.recordTrade(symbol, profit, assetState.martingaleLevel);

            // Apply martingale multiplier
            if (assetState.martingaleLevel === 1) {
                assetState.currentStake = Math.ceil(assetState.currentStake * CONFIG.MARTINGALE_MULTIPLIER * 100) / 100;
            } else if (assetState.martingaleLevel === 2) {
                assetState.currentStake = Math.ceil(assetState.currentStake * CONFIG.MARTINGALE_MULTIPLIER2 * 100) / 100;
            } else if (assetState.martingaleLevel >= 3) {
                assetState.currentStake = Math.ceil(assetState.currentStake * CONFIG.MARTINGALE_MULTIPLIER3 * 100) / 100;
            }

            if (assetState.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS) {
                LOGGER.warn(`⚠️ [${symbol}] Max Martingale reached, resetting`);
                assetState.martingaleLevel = 0;
                assetState.currentStake    = CONFIG.STAKE;
            } else {
                LOGGER.trade(`❌ [${symbol}] LOSS: -$${Math.abs(profit).toFixed(2)} | Direction: ${direction} | Next Martingale: ${assetState.martingaleLevel} | Next Stake: $${assetState.currentStake.toFixed(2)} | P/L: $${assetState.netPL.toFixed(2)}`);
            }
        }
    }
}

// ============================================
// CONNECTION MANAGER
// ============================================
class ConnectionManager {
    constructor() {
        this.ws                  = null;
        this.reconnectAttempts   = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay      = 5000;
        this.pingInterval        = null;
        this.autoSaveStarted     = false;
        this.isReconnecting      = false;
        this.activeSubscriptions = new Set(); // tracks subscribed symbols
        this._subscriptionIds    = new Map(); // symbol → subscription stream id
    }

    connect() {
        if (this.ws?.readyState === WebSocket.OPEN) { LOGGER.info('Already connected'); return; }
        LOGGER.info('🔌 Connecting to Deriv API...');
        this.cleanup();
        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);
        this.ws.on('open',    ()      => this.onOpen());
        this.ws.on('message', data   => this.onMessage(data));
        this.ws.on('error',   error  => this.onError(error));
        this.ws.on('close',   ()     => this.onClose());
        return this.ws;
    }

    onOpen() {
        LOGGER.info('✅ Connected to Deriv API');
        state.isConnected      = true;
        this.reconnectAttempts = 0;
        this.isReconnecting    = false;
        this.startPing();
        if (!this.autoSaveStarted) {
            StatePersistence.startAutoSave();
            this.autoSaveStarted = true;
        }
        this.send({ authorize: CONFIG.API_TOKEN });
    }

    initializeAssets() {
        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            if (!state.assets[symbol]) {
                state.assets[symbol] = {
                    candles: [], closedCandles: [],
                    currentFormingCandle:       null,
                    lastProcessedCandleOpenTime: null,
                    candlesLoaded:              false,
                    lastTradeDirection:         null,
                    lastTradeWasWin:            null,
                    martingaleLevel:            0,
                    currentStake:               CONFIG.STAKE,
                    canTrade:                   false,
                    lastClosedCandleForRecovery: null,
                    activePositions:            [],
                    tradesCount: 0, winsCount: 0, lossesCount: 0,
                    profit: 0, loss: 0, netPL: 0,
                    x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
                    x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0
                };
                const ac = getAssetConfig(symbol);
                LOGGER.info(`📊 Initialized asset: ${symbol} (${ac.TIMEFRAME_LABEL}, Duration: ${ac.DURATION}${ac.DURATION_UNIT})`);
            }
        });
    }

    restoreSubscriptions() {
        LOGGER.info('📊 Restoring subscriptions after reconnection...');
        this.activeSubscriptions.clear();
        this._subscriptionIds.clear();

        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset?.activePositions) {
                asset.activePositions.forEach(pos => {
                    if (pos.contractId) {
                        LOGGER.info(`  ✅ Re-subscribing to contract ${pos.contractId} (${symbol})`);
                        this.send({ proposal_open_contract: 1, contract_id: pos.contractId, subscribe: 1 });
                    }
                });
            }
        });
    }

    cleanup() {
        // Stop ping first
        this.stopPing();

        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { LOGGER.debug('WebSocket already closed'); }
            }
            this.ws = null;
        }

        // Reset subscription tracking
        this.activeSubscriptions.clear();
        this._subscriptionIds.clear();
    }

    onMessage(data) {
        try {
            const response = JSON.parse(data);
            this.handleResponse(response);
        } catch (error) {
            LOGGER.error(`Error parsing message: ${error.message}`);
        }
    }

    handleResponse(response) {
        switch (response.msg_type) {
            case 'authorize':            this.handleAuthorize(response);        break;
            case 'balance':              state.accountBalance = response.balance.balance; break;
            case 'ohlc':                 this.handleOHLC(response.ohlc);        break;
            case 'candles':              this.handleCandlesHistory(response);   break;
            case 'buy':                  this.handleBuyResponse(response);      break;
            case 'proposal_open_contract': this.handleOpenContract(response);   break;
            case 'ping':                 /* ignore */ break;
            default:
                if (response.error && response.msg_type !== 'candles') {
                    LOGGER.debug(`API error for ${response.msg_type}: ${response.error?.message}`);
                }
        }
    }

    handleAuthorize(response) {
        if (response.error) {
            LOGGER.error(`Authorization failed: ${response.error.message}`);
            return;
        }
        LOGGER.info(`🔑 Authorized: ${response.authorize.loginid} | Balance: ${response.authorize.balance} ${response.authorize.currency}`);
        state.isAuthorized  = true;
        state.accountBalance = response.authorize.balance;
        if (state.capital === CONFIG.INITIAL_CAPITAL) state.capital = response.authorize.balance;
        this.send({ balance: 1, subscribe: 1 });

        if (this.reconnectAttempts > 0 || this.hasAnyActivePositions()) {
            LOGGER.info('🔄 Reconnection detected, restoring subscriptions...');
            this.restoreSubscriptions();
        }
        bot.start();
    }

    hasAnyActivePositions() {
        return CONFIG.ACTIVE_ASSETS.some(symbol => {
            const asset = state.assets[symbol];
            return asset?.activePositions?.length > 0;
        });
    }

    getTotalActivePositions() {
        let total = 0;
        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            total += state.assets[symbol]?.activePositions?.length ?? 0;
        });
        return total;
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);
            const reqId = response.echo_req?.req_id;
            if (reqId) {
                CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                    const asset = state.assets[symbol];
                    if (asset?.activePositions) {
                        const idx = asset.activePositions.findIndex(p => p.reqId === reqId);
                        if (idx >= 0) {
                            asset.activePositions.splice(idx, 1);
                            LOGGER.info(`  Removed failed position from ${symbol}`);
                        }
                    }
                });
            }
            // FIX: Always release watchdog state on buy error
            if (bot) bot._forceReleaseTradeLock();
            return;
        }

        const contract = response.buy;
        LOGGER.trade(`✅ Position opened: Contract ${contract.contract_id}, Buy Price: $${contract.buy_price}`);

        const reqId = response.echo_req.req_id;
        let foundSymbol = null;
        let position    = null;

        for (const symbol of CONFIG.ACTIVE_ASSETS) {
            const asset = state.assets[symbol];
            if (asset?.activePositions) {
                position = asset.activePositions.find(p => p.reqId === reqId);
                if (position) { foundSymbol = symbol; break; }
            }
        }

        if (position && foundSymbol) {
            position.contractId = contract.contract_id;
            position.buyPrice   = contract.buy_price;

            // Set watchdog tracking
            state.currentContractId = contract.contract_id;
            state.tradeStartTime    = Date.now();
            state.pendingTradeInfo  = {
                stake:     position.stake,
                direction: position.direction,
                symbol:    position.symbol
            };

            bot._startTradeWatchdog(contract.contract_id);

            TelegramService.sendTradeAlert(
                'OPEN', position.symbol, position.direction,
                position.stake, position.duration, position.durationUnit, {}
            );
        } else {
            LOGGER.warn(`⚠️ Could not find position for reqId ${reqId} — contract ${contract.contract_id}`);
        }

        // Subscribe to contract updates
        this.send({ proposal_open_contract: 1, contract_id: contract.contract_id, subscribe: 1 });
    }

    /**
     * FIX #3: handleOpenContract race condition.
     * 
     * PROBLEM: In rare cases the proposal_open_contract with is_sold=true arrives
     * BEFORE the buy response (both come through same WebSocket pipe). When this
     * happens, ownerSymbol is null (position not yet in activePositions), the
     * early return fires, and the contract result is never recorded. The watchdog
     * then fires 75s later and force-releases. Martingale is not correctly updated.
     * 
     * FIX: If contract not found in activePositions but is_sold, search by 
     * contractId in pendingTradeInfo as fallback and queue a delayed retry.
     */
    handleOpenContract(response) {
        if (response.error) {
            LOGGER.error(`Contract error: ${response.error.message}`);
            if (bot) bot._forceReleaseTradeLock();
            return;
        }

        const contract      = response.proposal_open_contract;
        const contractId    = contract.contract_id;
        const contractIdStr = String(contractId);

        // Track subscription ID for cleanup
        if (response.subscription?.id) {
            // Map from contractId to subscription id
            this._subscriptionIds.set(contractIdStr, response.subscription.id);
        }

        // Already processed — unsubscribe and ignore
        if (bot._processedContracts.has(contractIdStr)) {
            LOGGER.debug(`⚠️ Contract ${contractId} already processed, ignoring duplicate`);
            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }
            return;
        }

        // Update profit tracking for any matching position (live P&L)
        if (!contract.is_sold && !contract.is_expired && contract.status !== 'sold') {
            // Live update — just track profit
            for (const symbol of CONFIG.ACTIVE_ASSETS) {
                const asset = state.assets[symbol];
                if (asset?.activePositions) {
                    const pos = asset.activePositions.find(p => p.contractId === contractId);
                    if (pos) { pos.currentProfit = contract.profit; break; }
                }
            }
            return; // Not settled yet
        }

        // === Contract is SETTLED ===
        // Find owner
        let ownerSymbol = null;
        let posIndex    = -1;

        for (const symbol of CONFIG.ACTIVE_ASSETS) {
            const asset = state.assets[symbol];
            if (asset?.activePositions) {
                const idx = asset.activePositions.findIndex(p => p.contractId === contractId);
                if (idx >= 0) { ownerSymbol = symbol; posIndex = idx; break; }
            }
        }

        // FIX #3: Handle race condition where buy response hasn't arrived yet
        if (posIndex < 0 || !ownerSymbol) {
            LOGGER.warn(`⚠️ Contract ${contractId} settled but not in activePositions yet — retrying in 500ms`);
            setTimeout(() => this.handleOpenContract(response), 500);
            return;
        }

        // Mark as processed IMMEDIATELY
        bot._processedContracts.add(contractIdStr);

        // Clear watchdog
        bot._clearAllWatchdogTimers();

        const assetState = state.assets[ownerSymbol];
        const position   = assetState.activePositions[posIndex];
        const profit     = contract.profit;

        LOGGER.trade(`[${ownerSymbol}] Contract ${contractId} settled: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`);

        // Record result
        SessionManager.recordTradeResult(ownerSymbol, profit, position.direction);

        // Telegram alert
        TelegramService.sendTradeAlert(
            profit >= 0 ? 'WIN' : 'LOSS',
            ownerSymbol, position.direction,
            position.stake, position.duration, position.durationUnit,
            { profit }
        );

        // Remove position
        assetState.activePositions.splice(posIndex, 1);

        // Release lock
        state.currentContractId = null;
        state.tradeStartTime    = null;
        state.pendingTradeInfo  = null;

        // Unsubscribe
        if (response.subscription?.id) {
            this.send({ forget: response.subscription.id });
        }

        SessionManager.checkSessionTargets();
        StatePersistence.saveState();
        LOGGER.info(`✅ Contract ${contractId} completed`);
    }

    /**
     * FIX #4: handleOHLC deduplication and subscription tracking.
     * 
     * PROBLEM: After reconnection, subscribeToCandles is called again while
     * activeSubscriptions tracking may be stale, causing double OHLC events
     * per candle. Two OHLC events for the same new candle_open_time → first
     * correctly closes the previous candle, second incorrectly tries to close
     * the current forming candle early.
     * 
     * FIX: Track subscriptions by symbol AND enforce lastProcessedCandleOpenTime
     * strictly so duplicate closings are impossible regardless of stream count.
     */
    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        if (!state.assets[symbol]) return;

        const assetState  = state.assets[symbol];
        const assetConfig = getAssetConfig(symbol);
        const granularity = assetConfig.GRANULARITY;
        const calcOpenTime = ohlc.open_time || Math.floor(ohlc.epoch / granularity) * granularity;

        const incomingCandle = {
            open:      parseFloat(ohlc.open),
            high:      parseFloat(ohlc.high),
            low:       parseFloat(ohlc.low),
            close:     parseFloat(ohlc.close),
            epoch:     ohlc.epoch,
            open_time: calcOpenTime
        };

        if (isNaN(incomingCandle.open) || isNaN(incomingCandle.close) ||
            isNaN(incomingCandle.high) || isNaN(incomingCandle.low)) {
            LOGGER.error(`[${symbol}] Invalid OHLC data, skipping`);
            return;
        }

        // Buffer-only mode during maxStreak computation
        if (!state.isMaxStreakReady) {
            assetState.currentFormingCandle = incomingCandle;
            return;
        }

        const currentOpenTime = assetState.currentFormingCandle?.open_time;
        const isNewCandle     = currentOpenTime !== undefined &&
                                currentOpenTime !== null &&
                                incomingCandle.open_time !== currentOpenTime;

        if (isNewCandle) {
            const closedCandle     = { ...assetState.currentFormingCandle };
            closedCandle.epoch     = closedCandle.open_time + granularity;

            // FIX #4: Strict duplicate guard using lastProcessedCandleOpenTime
            if (closedCandle.open_time === assetState.lastProcessedCandleOpenTime) {
                LOGGER.debug(`[${symbol}] Duplicate candle close prevented (open_time: ${closedCandle.open_time})`);
            } else {
                // Check array-level duplicate as secondary guard
                const alreadyExists = assetState.closedCandles.some(c => c.open_time === closedCandle.open_time);
                
                if (!alreadyExists) {
                    assetState.closedCandles.push(closedCandle);
                    assetState.lastClosedCandleForRecovery = closedCandle;
                    assetState.lastProcessedCandleOpenTime  = closedCandle.open_time;

                    // Trim to max stored
                    if (assetState.closedCandles.length > assetConfig.MAX_CANDLES_STORED) {
                        assetState.closedCandles = assetState.closedCandles.slice(-assetConfig.MAX_CANDLES_STORED);
                    }

                    const closeTime  = new Date(closedCandle.epoch * 1000).toISOString();
                    const candleType = CandleAnalyzer.getCandleDirection(closedCandle);
                    const emoji      = candleType === 'BULLISH' ? '🟢' : candleType === 'BEARISH' ? '🔴' : '⚪';

                    LOGGER.info(
                        `${symbol} ${emoji} CANDLE CLOSED [${closeTime}] ${candleType}: ` +
                        `O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} ` +
                        `L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)}`
                    );

                    const regime        = AlternatingRegimeDetector.analyze(assetState.closedCandles);
                    const assetMaxStreak = assetMaxStreakManager?.getMaxStreak(symbol) ?? 'N/A';
                    LOGGER.info(`${symbol} AutoCorr: ${regime.autocorrelation.toFixed(4)} (threshold: ${CONFIG.AUTOCORR_THRESHOLD}) | MaxStreak: ${assetMaxStreak} | Candles: ${assetState.closedCandles.length}`);

                    assetState.canTrade = true;

                    try {
                        if (assetState.martingaleLevel > 0) {
                            bot.executeRecoveryTrade(symbol, closedCandle);
                        } else {
                            bot.executeNextTrade(symbol, closedCandle);
                        }
                    } catch (error) {
                        LOGGER.error(`[${symbol}] Trade execution error: ${error.message}`);
                        bot._forceReleaseTradeLock();
                    }
                } else {
                    LOGGER.debug(`[${symbol}] Skipped array-duplicate candle at ${closedCandle.open_time}`);
                }
            }
        }

        // Always update forming candle
        assetState.currentFormingCandle = incomingCandle;

        // Maintain live candles array
        const candles = assetState.candles;
        const idx     = candles.findIndex(c => c.open_time === incomingCandle.open_time);
        if (idx >= 0) candles[idx] = incomingCandle;
        else          candles.push(incomingCandle);

        if (candles.length > assetConfig.MAX_CANDLES_STORED) {
            assetState.candles = candles.slice(-assetConfig.MAX_CANDLES_STORED);
        }
    }

    /**
     * FIX #5: handleCandlesHistory wrong count filter.
     * 
     * PROBLEM: Original checked `response.echo_req.count > 100` to skip
     * maxStreak batches. But CANDLES_TO_LOAD is 60, and maxStreak BATCH_SIZE
     * is also 60 — so the filter never worked and both were processed here,
     * causing closedCandles to be overwritten mid-computation.
     * 
     * FIX: Use req_id range tracking to know which responses belong to 
     * maxStreak computation vs subscription history load.
     * Simpler approach: only process if it's a subscribe=1 response 
     * (has subscription field) or if it matches the initial load req pattern.
     */
    handleCandlesHistory(response) {
        if (response.error) {
            LOGGER.error(`Error fetching candles: ${response.error.message}`);
            return;
        }

        // Skip maxStreak batch responses — they have no subscribe field
        // and their listeners are handled inside fetchMaxStreakForAsset
        // The initial subscription load comes WITHOUT subscribe in echo_req
        // but we can distinguish by checking if a subscription was requested
        const symbol = response.echo_req?.ticks_history;
        if (!symbol || !state.assets[symbol]) return;

        // FIX #5: If this req_id belongs to maxStreak computation,
        // the dedicated listener in fetchMaxStreakForAsset handles it.
        // We detect this by checking if echo_req has no subscribe=1
        // AND was NOT sent from subscribeToCandles (which sends count=CANDLES_TO_LOAD).
        // 
        // The cleanest guard: maxStreak requests use a specific req_id range
        // tracked in the manager. Here we use a simpler heuristic:
        // if there's no 'subscribe' key in echo_req AND candles count matches
        // BATCH_SIZE (60), it's likely a maxStreak batch — skip it since the
        // dedicated listener will handle it. If the listener already resolved,
        // ignore silently.
        if (!response.echo_req?.subscribe && response.echo_req?.count === 60 && 
            assetMaxStreakManager?._isComputing) {
            LOGGER.debug(`[${symbol}] Skipping candles response during maxStreak computation`);
            return;
        }

        const assetConfig  = getAssetConfig(symbol);
        const granularity  = assetConfig.GRANULARITY;

        const candles = response.candles.map(c => {
            const openTime = Math.floor((c.epoch - granularity) / granularity) * granularity;
            return {
                open:      parseFloat(c.open),
                high:      parseFloat(c.high),
                low:       parseFloat(c.low),
                close:     parseFloat(c.close),
                epoch:     c.epoch,
                open_time: openTime
            };
        });

        if (candles.length === 0) {
            LOGGER.warn(`${symbol}: No historical candles received`);
            return;
        }

        state.assets[symbol].candles                      = [...candles];
        state.assets[symbol].closedCandles                = [...candles];
        state.assets[symbol].lastClosedCandleForRecovery  = candles[candles.length - 1];
        state.assets[symbol].lastProcessedCandleOpenTime  = candles[candles.length - 1].open_time;
        state.assets[symbol].currentFormingCandle         = null;
        state.assets[symbol].candlesLoaded                = true;

        const regime = AlternatingRegimeDetector.analyze(state.assets[symbol].closedCandles);
        LOGGER.info(`📊 Loaded ${candles.length} ${assetConfig.TIMEFRAME_LABEL} candles for ${symbol} | AutoCorr: ${regime.autocorrelation.toFixed(4)} | Ready`);
    }

    onError(error) {
        LOGGER.error(`WebSocket error: ${error.message}`);
    }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected  = false;
        state.isAuthorized = false;
        this.stopPing();
        StatePersistence.saveState();

        if (this.isReconnecting) { LOGGER.info('Already handling disconnect, skipping...'); return; }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.isReconnecting = true;
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

            TelegramService.sendMessage(
                `⚠️ <b>CONNECTION LOST - RECONNECTING 2b</b>\n` +
                `Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
                `Retrying in ${(delay / 1000).toFixed(1)}s\n` +
                `State preserved: ${state.session.tradesCount} trades, $${state.session.netPL.toFixed(2)} P&L`
            );

            setTimeout(() => {
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            TelegramService.sendMessage(`🛑 <b>BOT STOPPED 2b</b>\nMax reconnection attempts reached.\nFinal P&L: $${state.session.netPL.toFixed(2)}`);
            process.exit(1);
        }
    }

    startPing() {
        this.stopPing(); // Ensure no duplicate ping intervals
        this.pingInterval = setInterval(() => {
            if (state.isConnected && this.ws?.readyState === WebSocket.OPEN) {
                this.send({ ping: 1 });
            }
        }, 30000);
    }

    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    send(data) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            LOGGER.error('Cannot send: WebSocket not open');
            return null;
        }
        data.req_id = state.requestId++;
        try {
            this.ws.send(JSON.stringify(data));
        } catch (err) {
            LOGGER.error(`Send error: ${err.message}`);
            return null;
        }
        return data.req_id;
    }
}

// ============================================
// MAIN BOT CLASS
// ============================================
class DerivBot {
    constructor() {
        this.connection = new ConnectionManager();
        this._processedContracts     = new Set();
        this.tradeWatchdogMs         = 75000;
        this.timeCheckStarted        = false;
        this.sessionTimeCheckerId    = null;
        this.statusDisplayIntervalId = null;
        this.contractCleanupIntervalId = null;

        // FIX #6: Reduce contract cleanup to prevent memory issues
        // Also reset the set rather than clear when >500 to avoid clearing
        // contracts that are still in-flight
        this.contractCleanupIntervalId = setInterval(() => {
            const size = this._processedContracts.size;
            if (size > 1000) {
                // Keep only recent 100 to prevent clearing contracts still being tracked
                const entries = [...this._processedContracts];
                this._processedContracts = new Set(entries.slice(-100));
                LOGGER.info(`♻️ Trimmed processed contracts: ${size} → ${this._processedContracts.size}`);
            }
        }, 1800000); // Every 30 minutes
    }

    async start() {
        console.log('\n' + '═'.repeat(80));
        console.log(' DERIV RISE/FALL CANDLE PATTERN BOT (Per-Asset Independent Management)');
        console.log('═'.repeat(80));
        console.log(`  Initial Capital : $${state.capital}`);
        console.log(`  Active Assets   : ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        console.log(`  Base Stake      : $${CONFIG.STAKE} (per asset)`);
        console.log(`  Strategy        : autocorrelation < ${CONFIG.AUTOCORR_THRESHOLD} to trigger trade`);
        console.log('═'.repeat(80) + '\n');

        state.currentTradeDay = TradeHistoryManager.getDateKey();
        TradeHistoryManager.ensureDayEntry(state.currentTradeDay);

        if (!tradeHistory.dailyHistory[state.currentTradeDay].startCapital ||
             tradeHistory.dailyHistory[state.currentTradeDay].startCapital === 0) {
            tradeHistory.dailyHistory[state.currentTradeDay].startCapital = state.capital;
        }

        this.connection.initializeAssets();

        // ── Compute or load assetMaxStreak ─────────────────────────
        if (assetMaxStreakManager.needsRefresh() || !assetMaxStreakManager.allReady()) {
            LOGGER.info('📊 assetMaxStreak computation required — pausing trading...');
            state.isMaxStreakReady = false;

            // Subscribe candles first for OHLC stream (buffering during computation)
            CONFIG.ACTIVE_ASSETS.forEach(symbol => this.subscribeToCandles(symbol));

            await assetMaxStreakManager.computeAllMaxStreaks(this.connection);

            state.isMaxStreakReady = true;
            LOGGER.info('✅ assetMaxStreak ready — trading ENABLED');

            // Trim closedCandles
            CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                const assetState = state.assets[symbol];
                if (assetState?.closedCandles.length > CONFIG.MAX_CANDLES_STORED) {
                    assetState.closedCandles = assetState.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED);
                }
            });
        } else {
            LOGGER.info('✅ assetMaxStreak loaded from file — trading ENABLED immediately');
            state.isMaxStreakReady = true;

            CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                LOGGER.info(`  [${symbol}] assetMaxStreak = ${assetMaxStreakManager.getMaxStreak(symbol)}`);
            });

            CONFIG.ACTIVE_ASSETS.forEach(symbol => this.subscribeToCandles(symbol));
        }

        // Schedule monthly refresh
        assetMaxStreakManager.scheduleMonthlyRefresh(this.connection);

        // Start timers (guard prevents double-start on reconnect)
        TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();
        TelegramService.startDailyTimer();
        this.startSessionTimeChecker();

        LOGGER.info('✅ Bot started! (Per-Asset Independent + Immediate Recovery Mode)');
    }

    /**
     * FIX #4 continued: subscribeToCandles now properly guards against
     * duplicate subscriptions and clears old subscriptions on reconnect.
     */
    subscribeToCandles(symbol) {
        const assetConfig = getAssetConfig(symbol);

        if (this.connection.activeSubscriptions.has(symbol)) {
            LOGGER.debug(`📊 Already subscribed to ${symbol}, skipping`);
            return;
        }

        LOGGER.info(`📊 Subscribing to ${assetConfig.TIMEFRAME_LABEL} candles for ${symbol}...`);

        // Load initial history
        this.connection.send({
            ticks_history:    symbol,
            adjust_start_time: 1,
            count:            assetConfig.CANDLES_TO_LOAD,
            end:              'latest',
            start:            1,
            style:            'candles',
            granularity:      assetConfig.GRANULARITY
        });

        // Subscribe to live stream
        this.connection.send({
            ticks_history:    symbol,
            adjust_start_time: 1,
            count:            1,
            end:              'latest',
            start:            1,
            style:            'candles',
            granularity:      assetConfig.GRANULARITY,
            subscribe:        1
        });

        this.connection.activeSubscriptions.add(symbol);
    }

    // ── IMMEDIATE RECOVERY TRADE ──────────────────────────────────
    executeRecoveryTrade(symbol, closedCandle) {
        const assetState = state.assets[symbol];
        if (!assetState) return;

        if (!SessionManager.isSessionActive()) {
            LOGGER.info(`[${symbol}] Recovery skipped — session ended`);
            return;
        }
        if (assetState.martingaleLevel === 0) {
            LOGGER.info(`[${symbol}] Recovery skipped — not in loss recovery`);
            return;
        }
        if (assetState.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) {
            LOGGER.warn(`[${symbol}] Recovery skipped — position already open`);
            return;
        }
        if (!state.isMaxStreakReady) {
            LOGGER.warn(`[${symbol}] Recovery skipped — maxStreak not ready`);
            return;
        }
        if (!state.isConnected || !state.isAuthorized) {
            LOGGER.warn(`[${symbol}] Recovery skipped — not connected/authorized`);
            return;
        }

        const stake = assetState.currentStake;
        if (state.capital < stake) {
            LOGGER.error(`[${symbol}] Recovery skipped — insufficient capital $${state.capital.toFixed(2)} (need $${stake.toFixed(2)})`);
            assetState.martingaleLevel = 0;
            assetState.currentStake    = CONFIG.STAKE;
            return;
        }

        if (CONFIG.USE_TRADING_SESSIONS) {
            const sessionCheck = TradingSessionManager.isWithinTradingSession();
            if (!sessionCheck.inSession) {
                LOGGER.info(`🔄 [${symbol}] Recovery outside session — proceeding (Mart: ${assetState.martingaleLevel})`);
            }
        }

        const assetConfig = getAssetConfig(symbol);
        const candleType  = CandleAnalyzer.getCandleDirection(closedCandle);
        const direction   = candleType === 'BULLISH' ? 'CALLE' : 'PUTE';

        LOGGER.trade(`⚡ [${symbol}] IMMEDIATE RECOVERY | Direction: ${direction === 'CALLE' ? 'RISE' : 'FALL'} | Stake: $${stake.toFixed(2)} | Mart: ${assetState.martingaleLevel}`);

        TelegramService.sendMessage(
            `⚡ <b>kRISE/FALL2b IMMEDIATE RECOVERY</b>\n` +
            `[${symbol}] Martingale Level: ${assetState.martingaleLevel}\n` +
            `Direction: ${direction === 'CALLE' ? 'RISE ↑' : 'FALL ↓'}\n` +
            `Stake: $${stake.toFixed(2)} | Capital: $${state.capital.toFixed(2)}\n` +
            `Asset P/L: $${assetState.netPL.toFixed(2)}`
        );

        const position = {
            symbol, direction, stake,
            duration:     assetConfig.DURATION,
            durationUnit: assetConfig.DURATION_UNIT,
            entryTime:    Date.now(),
            contractId:   null, reqId: null,
            currentProfit: 0, buyPrice: 0
        };

        assetState.activePositions.push(position);
        assetState.canTrade = false;

        const tradeRequest = {
            buy: 1, subscribe: 1,
            price: stake.toFixed(2),
            parameters: {
                contract_type: direction,
                symbol, currency: 'USD',
                amount:        stake.toFixed(2),
                duration:      assetConfig.DURATION,
                duration_unit: assetConfig.DURATION_UNIT,
                basis:         'stake'
            }
        };

        const reqId   = this.connection.send(tradeRequest);
        position.reqId = reqId;
        LOGGER.trade(`✅ [${symbol}] Recovery trade sent (reqId: ${reqId})`);
    }

    // ── NORMAL TRADE EXECUTION ─────────────────────────────────────
    executeNextTrade(symbol, lastClosedCandle) {
        const assetState = state.assets[symbol];
        if (!assetState)                          return;
        if (!assetState.canTrade)                 return;
        if (!SessionManager.isSessionActive())    return;
        if (!state.isMaxStreakReady) {
            LOGGER.debug(`[${symbol}] Trade skipped — maxStreak not ready`);
            return;
        }

        const assetMaxStreak = assetMaxStreakManager.getMaxStreak(symbol);
        if (assetMaxStreak === null) {
            LOGGER.warn(`[${symbol}] Trade skipped — assetMaxStreak not available`);
            return;
        }

        if (assetState.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) {
            LOGGER.debug(`${symbol} Max positions reached`);
            return;
        }

        // FIX #2: Removed state.activeTradeAsset check entirely.
        // Each asset is independently managed via its own activePositions array.
        // The original `state.activeTradeAsset = symbol; ACTIVE_ASSETS = [symbol]`
        // pattern was the root cause of other assets being locked out permanently.

        // Session window check
        if (CONFIG.USE_TRADING_SESSIONS) {
            const sessionCheck = TradingSessionManager.isWithinTradingSession();
            if (!sessionCheck.inSession) {
                const now = Date.now();
                if (now - state.lastSessionLogTime > 300000) {
                    LOGGER.info(`⏰ OUTSIDE SESSION — ${TradingSessionManager.getSessionStatusString()}`);
                    state.lastSessionLogTime = now;
                }
                return;
            }
        }

        const stake = assetState.currentStake;
        if (state.capital < stake) {
            LOGGER.error(`[${symbol}] Insufficient capital: $${state.capital.toFixed(2)} (need $${stake.toFixed(2)})`);
            if (assetState.martingaleLevel > 0) {
                assetState.martingaleLevel = 0;
                assetState.currentStake    = CONFIG.STAKE;
            }
            return;
        }

        // ── Autocorrelation signal ───────────────────────────────
        const regime = AlternatingRegimeDetector.analyze(assetState.closedCandles);

        LOGGER.info(
            `  [${symbol}] AutoCorr: ${regime.autocorrelation.toFixed(4)} ` +
            `(threshold: ${CONFIG.AUTOCORR_THRESHOLD}) | MaxStreak: ${assetMaxStreak} | Candles: ${assetState.closedCandles.length}`
        );

        let direction    = null;
        let signalReason = '';

        if (regime.autocorrelation < CONFIG.AUTOCORR_THRESHOLD &&
            regime.autocorrelation > CONFIG.AUTOCORR_THRESHOLD2) {

            const candleType = CandleAnalyzer.getCandleDirection(lastClosedCandle);
            if (candleType === 'BULLISH') {
                direction    = 'CALLE';
                signalReason = `AutoCorr signal (${symbol})`;
            } else if (candleType === 'BEARISH') {
                direction    = 'PUTE';
                signalReason = `AutoCorr signal (${symbol})`;
            } else {
                LOGGER.info(`  [${symbol}] DOJI candle — no trade despite autocorr signal`);
            }
        } else {
            LOGGER.trade(
                `🔄 [${symbol}] No Trade: autocorrelation=${regime.autocorrelation.toFixed(4)} ` +
                `outside range [${CONFIG.AUTOCORR_THRESHOLD2}, ${CONFIG.AUTOCORR_THRESHOLD}]`
            );
        }

        StatePersistence.saveState();
        if (!direction) return;

        // ── Execute trade ────────────────────────────────────────
        assetState.canTrade          = false;
        assetState.lastTradeDirection = direction;

        LOGGER.trade(`🎯 [${symbol}] Executing ${direction === 'CALLE' ? 'RISE' : 'FALL'} | Stake: $${stake.toFixed(2)} | Mart: ${assetState.martingaleLevel}`);
        LOGGER.trade(`  Reason: ${signalReason}`);

        const assetConfig = getAssetConfig(symbol);
        const position    = {
            symbol, direction, stake,
            duration:     assetConfig.DURATION,
            durationUnit: assetConfig.DURATION_UNIT,
            entryTime:    Date.now(),
            contractId:   null, reqId: null,
            currentProfit: 0, buyPrice: 0
        };

        assetState.activePositions.push(position);

        const tradeRequest = {
            buy: 1, subscribe: 1,
            price: stake.toFixed(2),
            parameters: {
                contract_type: direction,
                symbol, currency: 'USD',
                amount:        stake.toFixed(2),
                duration:      assetConfig.DURATION,
                duration_unit: assetConfig.DURATION_UNIT,
                basis:         'stake'
            }
        };

        const reqId    = this.connection.send(tradeRequest);
        position.reqId = reqId;
    }

    _forceReleaseTradeLock() {
        try {
            this._clearAllWatchdogTimers();
            state.currentContractId = null;
            state.tradeStartTime    = null;
            state.pendingTradeInfo  = null;
            LOGGER.warn('⚠️ Trade lock force-released');
        } catch (error) {
            LOGGER.error(`Error releasing lock: ${error.message}`);
        }
    }

    // ── TRADE WATCHDOG ────────────────────────────────────────────
    _startTradeWatchdog(contractId) {
        // Clear any existing watchdog first
        this._clearAllWatchdogTimers();

        state.tradeWatchdogTimer = setTimeout(() => {
            if (!state.currentContractId) {
                LOGGER.debug('Watchdog fired but trade already completed');
                return;
            }

            LOGGER.warn(`⏰ WATCHDOG FIRED — Contract ${contractId} open for ${this.tradeWatchdogMs / 1000}s`);

            if (contractId && state.isConnected && state.isAuthorized) {
                LOGGER.info(`🔍 Polling contract ${contractId}...`);
                this.connection.send({ forget_all: 'proposal_open_contract' });
                this.connection.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });

                state.tradeWatchdogPollTimer = setTimeout(() => {
                    if (!state.currentContractId) {
                        LOGGER.debug('Poll timer fired but trade already completed');
                        return;
                    }
                    LOGGER.error(`🚨 WATCHDOG: Poll timed out for contract ${contractId} — forcing recovery`);
                    this._recoverStuckTrade('watchdog-force');
                }, 15000);
            } else {
                LOGGER.error('Cannot poll — not connected');
                this._recoverStuckTrade('watchdog-offline');
            }
        }, this.tradeWatchdogMs);

        LOGGER.debug(`Watchdog started for contract ${contractId} (${this.tradeWatchdogMs}ms)`);
    }

    _clearAllWatchdogTimers() {
        if (state.tradeWatchdogTimer) {
            clearTimeout(state.tradeWatchdogTimer);
            state.tradeWatchdogTimer = null;
        }
        if (state.tradeWatchdogPollTimer) {
            clearTimeout(state.tradeWatchdogPollTimer);
            state.tradeWatchdogPollTimer = null;
        }
    }

    _recoverStuckTrade(reason) {
        LOGGER.warn(`🔄 Stuck trade recovery: ${reason}`);
        this._clearAllWatchdogTimers();

        const contractId  = state.currentContractId;
        const openSeconds = state.tradeStartTime ? Math.round((Date.now() - state.tradeStartTime) / 1000) : '?';

        LOGGER.error(`🚨 STUCK TRADE [${reason}] | Contract: ${contractId} | Open: ${openSeconds}s`);

        if (contractId) this._processedContracts.add(String(contractId));

        // Remove stuck position
        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset?.activePositions) {
                const idx = asset.activePositions.findIndex(p => p.contractId === contractId);
                if (idx >= 0) {
                    asset.activePositions.splice(idx, 1);
                    LOGGER.info(`Removed stuck position from ${symbol}`);
                }
            }
        });

        // Release lock
        state.currentContractId = null;
        state.pendingTradeInfo  = null;
        state.tradeStartTime    = null;

        LOGGER.warn('🔄 Trade lock released. Resuming on next candle...');

        TelegramService.sendMessage(
            `⚠️ <b>kRISE/FALL2b STUCK TRADE RECOVERED [${reason}]</b>\n` +
            `Contract: ${contractId || 'unknown'}\n` +
            `Open for: ${openSeconds}s\n` +
            `Action: lock released, retrying on next candle\n` +
            `⚠️ IMPORTANT: Manually verify outcome on Deriv\n` +
            `Session P&L: $${state.session.netPL.toFixed(2)}`
        );

        StatePersistence.saveState();
    }

    stop() {
        LOGGER.info('🛑 Stopping bot...');

        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset) asset.canTrade = false;
        });

        TelegramService.clearTimers();
        this._clearAllWatchdogTimers();

        if (this.statusDisplayIntervalId) {
            clearInterval(this.statusDisplayIntervalId);
            this.statusDisplayIntervalId = null;
        }
        if (this.sessionTimeCheckerId) {
            clearInterval(this.sessionTimeCheckerId);
            this.sessionTimeCheckerId = null;
        }
        if (this.contractCleanupIntervalId) {
            clearInterval(this.contractCleanupIntervalId);
            this.contractCleanupIntervalId = null;
        }

        // Cancel monthly refresh timer
        if (assetMaxStreakManager?._refreshTimer) {
            clearTimeout(assetMaxStreakManager._refreshTimer);
        }

        StatePersistence.saveState();
        TradeHistoryManager.saveHistory();

        setTimeout(() => {
            if (this.connection) this.connection.cleanup();
            LOGGER.info('👋 Bot stopped cleanly');
        }, 2000);
    }

    startSessionTimeChecker() {
        if (this.timeCheckStarted) return;
        this.timeCheckStarted = true;

        this.sessionTimeCheckerId = setInterval(() => {
            const now        = new Date();
            const gmt1Time   = new Date(now.getTime() + 3600000);
            const hours      = gmt1Time.getUTCHours();
            const minutes    = gmt1Time.getUTCMinutes();

            SessionManager.checkDayChange();

            if (!state.session.isActive && hours === CONFIG.TOKYO_START && minutes >= 0) {
                LOGGER.info("Tokyo session starting — reconnecting");
                state.session.isActive = true;
                this.connection.connect();
            }

            if (state.session.isActive) {
                const allRecovered = CONFIG.ACTIVE_ASSETS.every(symbol => {
                    const asset = state.assets[symbol];
                    return asset && asset.martingaleLevel === 0;
                });
                const anyWin = CONFIG.ACTIVE_ASSETS.some(symbol => {
                    const asset = state.assets[symbol];
                    return asset && asset.lastTradeWasWin === true;
                });

                if (allRecovered && anyWin && hours >= CONFIG.SYDNEY_END) {
                    LOGGER.info(`Past ${CONFIG.SYDNEY_END}:00 GMT+1, all recovered — disconnecting`);
                    TelegramService.sendDayEndSummary(TradeHistoryManager.getDateKey());
                    TelegramService.sendSessionSummary();
                    if (this.connection.ws) this.connection.ws.close();
                    state.session.isActive = false;
                }
            }
        }, 20000);
    }

    getStatus() {
        const sessionStats   = SessionManager.getSessionStats();
        const tradingSession = TradingSessionManager.getSessionStatusString();
        const overall        = TradeHistoryManager.getOverallStats();
        const today          = TradeHistoryManager.getTodayStats();
        const assetStatuses  = {};

        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            const a  = state.assets[symbol];
            const ac = getAssetConfig(symbol);
            if (a) {
                const regime         = AlternatingRegimeDetector.analyze(a.closedCandles);
                const assetMaxStreak = assetMaxStreakManager?.getMaxStreak(symbol) ?? null;
                const lastClosed     = a.closedCandles?.length ? a.closedCandles[a.closedCandles.length - 1] : null;
                assetStatuses[symbol] = {
                    martingaleLevel:  a.martingaleLevel,
                    currentStake:     a.currentStake,
                    lastDirection:    a.lastTradeDirection,
                    lastWasWin:       a.lastTradeWasWin,
                    activePositions:  a.activePositions.length,
                    trades:           a.tradesCount,
                    wins:             a.winsCount,
                    losses:           a.lossesCount,
                    netPL:            a.netPL,
                    lastCandleDirection: lastClosed ? CandleAnalyzer.getCandleDirection(lastClosed) : null,
                    autocorrelation:  regime.autocorrelation,
                    assetMaxStreak,
                    threshold:        CONFIG.AUTOCORR_THRESHOLD,
                    timeframe:        ac.TIMEFRAME_LABEL,
                    duration:         `${ac.DURATION}${ac.DURATION_UNIT}`
                };
            }
        });

        let totalActivePositions = 0;
        CONFIG.ACTIVE_ASSETS.forEach(sym => {
            totalActivePositions += state.assets[sym]?.activePositions?.length ?? 0;
        });

        return {
            connected:        state.isConnected,
            authorized:       state.isAuthorized,
            isMaxStreakReady: state.isMaxStreakReady,
            capital:          state.capital,
            accountBalance:   state.accountBalance,
            session:          sessionStats,
            tradingSession,
            totalActivePositions,
            assets:           assetStatuses,
            overall,
            today
        };
    }
}

// ============================================
// INITIALIZATION
// ============================================
tradeHistory         = TradeHistoryManager.loadHistory();
assetMaxStreakManager = new AssetMaxStreakManager();
const bot            = new DerivBot();

process.on('SIGINT',  () => { console.log('\n⚠️ Shutdown signal received...'); bot.stop(); setTimeout(() => process.exit(0), 3000); });
process.on('SIGTERM', () => { bot.stop(); setTimeout(() => process.exit(0), 3000); });
process.on('uncaughtException', (err) => {
    LOGGER.error(`💥 UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
    // Don't exit — let the bot continue if possible
    // But save state immediately
    try { StatePersistence.saveState(); } catch(e) {}
});
process.on('unhandledRejection', (reason) => {
    LOGGER.error(`💥 UNHANDLED REJECTION: ${reason}`);
    try { StatePersistence.saveState(); } catch(e) {}
});

const stateLoaded = StatePersistence.loadState();
if (stateLoaded) LOGGER.info('🔄 Bot will resume from saved state after connection');
else             LOGGER.info('🆕 Bot will start with fresh state');

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('⚠️ API Token not configured!');
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(' DERIV RISE/FALL CANDLE PATTERN BOT (Per-Asset Independent)');
console.log(`  Immediate Recovery Mode ENABLED — delay: ${CONFIG.RECOVERY_TRADE_DELAY_MS}ms`);
console.log('═'.repeat(80));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

// Status display every 30 seconds
const statusDisplayIntervalId = setInterval(() => {
    if (!state.isAuthorized) return;

    const status  = bot.getStatus();
    const s       = state.session;
    const overall = status.overall;

    // Safety: if trade stuck > 2 min, force recovery
    if (state.currentContractId && state.tradeStartTime) {
        const elapsed = Date.now() - state.tradeStartTime;
        if (elapsed > 120000) {
            LOGGER.error(`🚨 SAFETY: Trade stuck for ${Math.round(elapsed / 1000)}s — forcing recovery`);
            bot._recoverStuckTrade('safety-timeout');
        }
    }

    let assetLines = '';
    CONFIG.ACTIVE_ASSETS.forEach(sym => {
        const a = status.assets[sym];
        if (a) {
            const dir    = a.lastDirection ? (a.lastDirection === 'CALLE' ? 'R' : 'F') : '-';
            const wl     = a.lastWasWin === null ? '-' : a.lastWasWin ? 'W' : 'L';
            const signal = a.autocorrelation < CONFIG.AUTOCORR_THRESHOLD ? '✅SIGNAL' : '❌NO SIG';
            assetLines  += `\n  ${sym} (${a.timeframe}/${a.duration}): M${a.martingaleLevel} $${a.currentStake.toFixed(2)} | ${a.trades}t ${a.wins}W/${a.losses}L | P/L:$${a.netPL.toFixed(2)} | Last:${dir}(${wl}) | Pos:${a.activePositions} | AutoCorr:${a.autocorrelation.toFixed(4)} ${signal} | MaxStreak:${a.assetMaxStreak}`;
        }
    });

    console.log(`\n📊 ${getGMTTime()} | Today: ${status.session.trades}t | ${status.session.winRate} | $${status.session.netPL.toFixed(2)} | ${status.totalActivePositions} active | MaxStreakReady:${status.isMaxStreakReady}`);
    console.log(`📋 Overall: ${overall.tradesCount}t | ${overall.winsCount}W/${overall.lossesCount}L | P/L: $${overall.netPL.toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
    console.log(`📉 Today Loss Stats: x2:${s.x2Losses} x3:${s.x3Losses} x4:${s.x4Losses} x5:${s.x5Losses} x6:${s.x6Losses} x7:${s.x7Losses} x8:${s.x8Losses} x9:${s.x9Losses}`);
    console.log(`🔧 Per-Asset:${assetLines}`);
    console.log(`  ${status.tradingSession}`);
}, 30000);

bot.statusDisplayIntervalId = statusDisplayIntervalId;
