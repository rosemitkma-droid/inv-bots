const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'KriseFallM_2b0_01209-state.json');
const HISTORY_FILE = path.join(__dirname, 'KriseFallM_2b0_01209-history.json');
const MAXSTREAK_FILE = path.join(__dirname, 'KriseFallM_2b0_01209-maxstreak.json');
const STATE_SAVE_INTERVAL = 5000;

// ============================================
// ASSET MAX STREAK MANAGER
// ============================================
/**
 * Fetches up to 50,000 candles for a single asset by paginating
 * the Deriv ticks_history API (max 5,000 per call) using `end`
 * timestamps to walk backwards in time.
 *
 * Strategy to exceed the 5,000 candle API limit:
 *   - Request 5,000 candles ending at `now`  → get oldest epoch
 *   - Request next 5,000 candles ending at (oldest epoch - 1)
 *   - Repeat up to 10 times (10 × 5,000 = 50,000)
 *   - Process streak inline; never hold more than one batch at a time
 *   - After all batches, trim closedCandles back to 50 candles
 */
class AssetMaxStreakManager {
    constructor() {
        this.data = this._load();
        this._updateIntervalMs = 1 * 24 * 60 * 60 * 1000; // 30 days
        this._refreshTimer = null;
    }

    // ── Persistence ────────────────────────────────────────────────
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

    // ── Public API ─────────────────────────────────────────────────
    getMaxStreak(symbol) {
        return this.data.assets[symbol]?.maxStreak ?? null;
    }

    isReady(symbol) {
        return typeof this.data.assets[symbol]?.maxStreak === 'number';
    }

    allReady() {
        return CONFIG.ACTIVE_ASSETS.every(s => this.isReady(s));
    }

    needsRefresh() {
        if (!this.data.lastUpdated) return true;
        return (Date.now() - this.data.lastUpdated) >= this._updateIntervalMs;
    }

    // ── Core: fetch 50k candles for ONE asset sequentially ─────────
    /**
     * Returns a Promise<number> — the maxStreak for `symbol`.
     * Uses the WebSocket already held by `connection`.
     * Processes one 5,000-candle batch at a time to keep memory low.
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
            let onMessage = null; // Declare outside to ensure cleanup

            LOGGER.info(`📡 [${symbol}] Starting 50k-candle maxStreak fetch...`);

            const cleanup = () => {
                if (onMessage) {
                    connection.ws.removeListener('message', onMessage);
                    onMessage = null;
                }
            };

            const fetchBatch = () => {
                if (batchesDone >= MAX_BATCHES) {
                    cleanup();
                    LOGGER.info(`✅ [${symbol}] maxStreak computation complete: ${overallMaxStreak} (${batchesDone} batches)`);
                    resolve(overallMaxStreak);
                    return;
                }

                const reqPayload = {
                    ticks_history: symbol,
                    adjust_start_time: 1,
                    count: BATCH_SIZE,
                    end: endEpoch,
                    start: 1,
                    style: 'candles',
                    granularity: assetConfig.GRANULARITY
                };

                onMessage = (data) => {
                    let response;
                    try { response = JSON.parse(data); } catch { return; }

                    if (response.msg_type !== 'candles') return;
                    if (response.echo_req?.ticks_history !== symbol) return;

                    cleanup(); // Remove listener immediately

                    if (response.error) {
                        LOGGER.warn(`⚠️ [${symbol}] Batch ${batchesDone + 1} error: ${response.error.message}`);
                        LOGGER.info(`✅ [${symbol}] maxStreak (early stop): ${overallMaxStreak}`);
                        resolve(overallMaxStreak);
                        return;
                    }

                    const candles = response.candles;
                    if (!candles || candles.length === 0) {
                        LOGGER.info(`✅ [${symbol}] maxStreak (no more candles): ${overallMaxStreak}`);
                        resolve(overallMaxStreak);
                        return;
                    }

                    LOGGER.info(`📊 [${symbol}] Batch ${batchesDone + 1}: ${candles.length} candles received`);

                    let currentStreak = 1;
                    let prevDir = crossBatchLastDir;

                    for (let i = 0; i < candles.length; i++) {
                        const c = candles[i];
                        const dir = c.close > c.open ? 1 : 0;

                        if (prevDir === null) {
                            prevDir = dir;
                            continue;
                        }

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

                    const oldestEpoch = candles[0].epoch;
                    endEpoch = oldestEpoch - 1;
                    batchesDone++;

                    if (candles.length < BATCH_SIZE) {
                        LOGGER.info(`✅ [${symbol}] maxStreak (history exhausted at batch ${batchesDone}): ${overallMaxStreak}`);
                        resolve(overallMaxStreak);
                        return;
                    }

                    setTimeout(fetchBatch, 300);
                };

                connection.ws.on('message', onMessage);

                const reqId = state.requestId++;
                reqPayload.req_id = reqId;

                try {
                    connection.ws.send(JSON.stringify(reqPayload));
                } catch (error) {
                    cleanup();
                    LOGGER.error(`[${symbol}] Failed to send request: ${error.message}`);
                    reject(error);
                }
            };

            // Add timeout protection
            const timeoutId = setTimeout(() => {
                cleanup();
                LOGGER.error(`[${symbol}] MaxStreak fetch timeout`);
                reject(new Error('Fetch timeout'));
            }, 120000); // 2 minute timeout

            fetchBatch();

            // Clear timeout on resolve/reject
            const originalResolve = resolve;
            const originalReject = reject;
            resolve = (val) => { clearTimeout(timeoutId); cleanup(); originalResolve(val); };
            reject = (err) => { clearTimeout(timeoutId); cleanup(); originalReject(err); };
        });
    }

    // ── Compute maxStreak for ALL assets sequentially ──────────────
    /**
     * Processes assets one-at-a-time (sequential) to minimise
     * WebSocket message collision and memory pressure.
     * After each asset's maxStreak is found, its closedCandles
     * array is trimmed to 50 entries.
     */
    async computeAllMaxStreaks(connection) {
        LOGGER.info('🔄 Starting sequential maxStreak computation for all assets...');
        await TelegramService.sendMessage(
            '🔄 <b>RISEFALL2b MaxStreak Update Started</b>\n' +
            `Computing 50k-candle maxStreak for ${CONFIG.ACTIVE_ASSETS.length} assets sequentially.\n` +
            'Trading is PAUSED until complete.'
        );

        for (const symbol of CONFIG.ACTIVE_ASSETS) {
            if (!state.isConnected || !state.isAuthorized) {
                LOGGER.error('Connection lost during maxStreak computation — aborting');
                break;
            }

            try {
                const maxStreak = await this.fetchMaxStreakForAsset(symbol, connection);

                this.data.assets[symbol] = {
                    maxStreak,
                    computedAt: Date.now()
                };
                this._save();

                LOGGER.info(`✅ [${symbol}] assetMaxStreak = ${maxStreak}`);

                // Trim closedCandles back to 50 for this asset
                const assetState = state.assets[symbol];
                if (assetState && assetState.closedCandles.length > 50) {
                    assetState.closedCandles = assetState.closedCandles.slice(-50);
                    LOGGER.info(`✂️ [${symbol}] closedCandles trimmed to ${assetState.closedCandles.length}`);
                }

                // Small pause between assets
                await new Promise(r => setTimeout(r, 500));

            } catch (err) {
                LOGGER.error(`❌ [${symbol}] maxStreak fetch failed: ${err.message}`);
                // Use a safe fallback so trading can continue
                if (!this.data.assets[symbol]) {
                    this.data.assets[symbol] = { maxStreak: 10, computedAt: Date.now() };
                    this._save();
                }
            }
        }

        this.data.lastUpdated = Date.now();
        this._save();

        const summary = CONFIG.ACTIVE_ASSETS
            .map(s => `  ${s}: maxStreak=${this.data.assets[s]?.maxStreak ?? 'N/A'}`)
            .join('\n');

        LOGGER.info('✅ All asset maxStreaks computed. Trading resuming.');
        await TelegramService.sendMessage(
            '✅ <b>RISEFALL2b MaxStreak Update Complete</b>\n' +
            `${summary}\n` +
            'Trading has RESUMED.'
        );
    }

    // ── Monthly refresh scheduler ──────────────────────────────────
    scheduleMonthlyRefresh(connection) {
        if (this._refreshTimer) clearTimeout(this._refreshTimer);

        const msUntilRefresh = this.data.lastUpdated
            ? Math.max(0, this._updateIntervalMs - (Date.now() - this.data.lastUpdated))
            : 0;

        // Node.js setTimeout limit is 2^31 - 1 (approx 24.8 days)
        const MAX_TIMEOUT = 2147483647;

        if (msUntilRefresh > MAX_TIMEOUT) {
            LOGGER.info(`🗓️ Next assetMaxStreak refresh in ${(msUntilRefresh / 3600000).toFixed(1)} hours (capping timeout at 24 days)`);
            this._refreshTimer = setTimeout(() => this.scheduleMonthlyRefresh(connection), MAX_TIMEOUT);
            return;
        }

        LOGGER.info(`🗓️ Next assetMaxStreak refresh in ${(msUntilRefresh / 3600000).toFixed(1)} hours`);

        this._refreshTimer = setTimeout(async () => {
            LOGGER.info('🗓️ Monthly maxStreak refresh triggered — pausing trading...');

            // Pause all assets
            CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                if (state.assets[symbol]) state.assets[symbol].canTrade = false;
            });

            await this.computeAllMaxStreaks(connection);

            // Resume trading by re-subscribing candles
            CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                if (typeof bot !== 'undefined' && bot.subscribeToCandles) {
                    bot.subscribeToCandles(symbol);
                }
            });

            // Schedule next refresh
            this.scheduleMonthlyRefresh(connection);

        }, msUntilRefresh);
    }
}

// ============================================
// TRADE HISTORY MANAGER
// ============================================
class TradeHistoryManager {
    static getDateKey() {
        const now = new Date();
        return now.toISOString().split('T')[0];
    }

    static loadHistory() {
        try {
            if (!fs.existsSync(HISTORY_FILE)) {
                LOGGER.info('📁 No trade history file found, starting fresh history');
                return {
                    overall: {
                        tradesCount: 0, winsCount: 0, lossesCount: 0,
                        profit: 0, loss: 0, netPL: 0,
                        x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
                        x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0,
                        firstTradeDate: null, lastTradeDate: null
                    },
                    overallAssets: {},
                    dailyHistory: {},
                    lastUpdated: Date.now()
                };
            }
            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            if (!data.dailyHistory) data.dailyHistory = {};
            if (!data.overallAssets) data.overallAssets = {};
            if (!data.overall) data.overall = {
                tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0,
                x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
                x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0
            };
            LOGGER.info(`📁 Trade history loaded — ${Object.keys(data.dailyHistory).length} days of history`);
            return data;
        } catch (error) {
            LOGGER.error(`Failed to load trade history: ${error.message}`);
            return {
                overall: {
                    tradesCount: 0, winsCount: 0, lossesCount: 0,
                    profit: 0, loss: 0, netPL: 0,
                    x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
                    x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0,
                    firstTradeDate: null, lastTradeDate: null
                },
                overallAssets: {},
                dailyHistory: {},
                lastUpdated: Date.now()
            };
        }
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

        const dayStats = tradeHistory.dailyHistory[dateKey];
        const dayAssetStats = dayStats.assets[symbol];
        const overall = tradeHistory.overall;
        const overallAsset = tradeHistory.overallAssets[symbol];

        dayStats.tradesCount++;
        dayAssetStats.tradesCount++;
        overall.tradesCount++;
        overallAsset.tradesCount++;

        if (!overall.firstTradeDate) overall.firstTradeDate = dateKey;
        overall.lastTradeDate = dateKey;

        if (profit > 0) {
            dayStats.winsCount++; dayStats.profit += profit; dayStats.netPL += profit;
            dayAssetStats.winsCount++; dayAssetStats.profit += profit; dayAssetStats.netPL += profit;
            overall.winsCount++; overall.profit += profit; overall.netPL += profit;
            overallAsset.winsCount++; overallAsset.profit += profit; overallAsset.netPL += profit;
        } else {
            dayStats.lossesCount++; dayStats.loss += Math.abs(profit); dayStats.netPL += profit;
            dayAssetStats.lossesCount++; dayAssetStats.loss += Math.abs(profit); dayAssetStats.netPL += profit;
            overall.lossesCount++; overall.loss += Math.abs(profit); overall.netPL += profit;
            overallAsset.lossesCount++; overallAsset.loss += Math.abs(profit); overallAsset.netPL += profit;

            const lvl = martingaleLevel;
            if (lvl >= 2 && lvl <= 9) {
                const key = `x${lvl}Losses`;
                dayStats[key]++; dayAssetStats[key]++;
                overall[key]++; overallAsset[key]++;
            }
        }

        dayStats.endCapital = state.capital;
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
                    dailyProfit: state.portfolio.dailyProfit,
                    dailyLoss: state.portfolio.dailyLoss,
                    dailyWins: state.portfolio.dailyWins,
                    dailyLosses: state.portfolio.dailyLosses
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
                    candlesLoaded: asset.candlesLoaded,
                    lastTradeDirection: asset.lastTradeDirection,
                    lastTradeWasWin: asset.lastTradeWasWin,
                    martingaleLevel: asset.martingaleLevel,
                    currentStake: asset.currentStake,
                    canTrade: asset.canTrade,
                    lastClosedCandleForRecovery: asset.lastClosedCandleForRecovery || null,
                    tradesCount: asset.tradesCount, winsCount: asset.winsCount,
                    lossesCount: asset.lossesCount, profit: asset.profit,
                    loss: asset.loss, netPL: asset.netPL,
                    x2Losses: asset.x2Losses, x3Losses: asset.x3Losses,
                    x4Losses: asset.x4Losses, x5Losses: asset.x5Losses,
                    x6Losses: asset.x6Losses, x7Losses: asset.x7Losses,
                    x8Losses: asset.x8Losses, x9Losses: asset.x9Losses,
                    activePositions: asset.activePositions.map(pos => ({
                        symbol: pos.symbol, direction: pos.direction,
                        stake: pos.stake, duration: pos.duration,
                        durationUnit: pos.durationUnit, entryTime: pos.entryTime,
                        contractId: pos.contractId, reqId: pos.reqId,
                        buyPrice: pos.buyPrice, currentProfit: pos.currentProfit
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
                startTime: savedData.session.startTime || Date.now(),
                startCapital: savedData.session.startCapital || savedData.capital
            };
            state.portfolio.dailyProfit = savedData.portfolio.dailyProfit;
            state.portfolio.dailyLoss = savedData.portfolio.dailyLoss;
            state.portfolio.dailyWins = savedData.portfolio.dailyWins;
            state.portfolio.dailyLosses = savedData.portfolio.dailyLosses;
            state.currentTradeDay = savedData.currentTradeDay || TradeHistoryManager.getDateKey();
            state.hourlyStats = savedData.hourlyStats || {
                trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours()
            };

            if (savedData.assets) {
                Object.keys(savedData.assets).forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = savedData.assets[symbol];
                        const asset = state.assets[symbol];

                        if (saved.closedCandles && saved.closedCandles.length > 0) {
                            asset.closedCandles = saved.closedCandles;
                            LOGGER.info(`📊 Restored ${saved.closedCandles.length} closed candles for ${symbol}`);
                        }
                        asset.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                        asset.candlesLoaded = saved.candlesLoaded || false;
                        asset.lastTradeDirection = saved.lastTradeDirection || null;
                        asset.lastTradeWasWin = saved.lastTradeWasWin !== undefined ? saved.lastTradeWasWin : null;
                        asset.martingaleLevel = saved.martingaleLevel || 0;
                        asset.currentStake = saved.currentStake || CONFIG.STAKE;
                        asset.canTrade = saved.canTrade || false;
                        asset.lastClosedCandleForRecovery = saved.lastClosedCandleForRecovery || null;
                        asset.tradesCount = saved.tradesCount || 0;
                        asset.winsCount = saved.winsCount || 0;
                        asset.lossesCount = saved.lossesCount || 0;
                        asset.profit = saved.profit || 0;
                        asset.loss = saved.loss || 0;
                        asset.netPL = saved.netPL || 0;
                        asset.x2Losses = saved.x2Losses || 0;
                        asset.x3Losses = saved.x3Losses || 0;
                        asset.x4Losses = saved.x4Losses || 0;
                        asset.x5Losses = saved.x5Losses || 0;
                        asset.x6Losses = saved.x6Losses || 0;
                        asset.x7Losses = saved.x7Losses || 0;
                        asset.x8Losses = saved.x8Losses || 0;
                        asset.x9Losses = saved.x9Losses || 0;
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

            LOGGER.info(`✅ State restored successfully!`);
            LOGGER.info(`💰 Capital: $${state.capital.toFixed(2)}`);
            LOGGER.info(`📊 Session P/L: $${state.session.netPL.toFixed(2)}`);
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
    static dailyTimerStarted = false;
    static hourlyTimerId = null;
    static dailyTimerId = null;
    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED) return;
        try {
            if (!message || message.length === 0) {
                LOGGER.error('[TELEGRAM] ❌ Message is empty! Not sending.');
                return;
            }
            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const data = JSON.stringify({
                chat_id: CONFIG.TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            });
            const byteLength = Buffer.byteLength(data, 'utf8');
            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': byteLength }
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
                LOGGER.info('[TELEGRAM] ✅ Message sent successfully');
            }).catch(error => {
                LOGGER.error(`[TELEGRAM] ❌ Send failed: ${error.message}`);
            });
        } catch (error) {
            LOGGER.error(`[TELEGRAM] ❌ Failed to send message: ${error.message}`);
        }
    }

    static async sendTradeAlert(type, symbol, direction, stake, duration, durationUnit, details = {}) {
        const emoji = type === 'OPEN' ? '🚀' : type === 'WIN' ? '✅' : '❌';
        const assetState = state.assets[symbol];
        const assetMartingale = assetState ? assetState.martingaleLevel : 0;
        const assetNetPL = assetState ? assetState.netPL : 0;
        const assetWins = assetState ? assetState.winsCount : 0;
        const assetLosses = assetState ? assetState.lossesCount : 0;

        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();

        // Live autocorrelation for display
        const regime = assetState
            ? AlternatingRegimeDetector.analyze(assetState.closedCandles)
            : { autocorrelation: 0 };
        const assetMaxStreak = assetMaxStreakManager ? assetMaxStreakManager.getMaxStreak(symbol) : 'N/A';

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
${type !== 'OPEN' ? `Loss Stats: x2:${today.x2Losses || 0} | x3:${today.x3Losses || 0} | x4:${today.x4Losses || 0} | x5:${today.x5Losses || 0} | x6:${today.x6Losses || 0} | x7:${today.x7Losses || 0} | x8:${today.x8Losses || 0} | x9:${today.x9Losses || 0}` : ''}

📋 <b>Overall Stats:</b>
Overall P&amp;L: $${(overall.netPL || 0).toFixed(2)}
Overall W/L: ${overall.winsCount || 0}/${overall.lossesCount || 0}
Total Trades: ${overall.tradesCount || 0}
Capital: $${state.capital.toFixed(2)}
Loss Stats: x2:${overall.x2Losses || 0} | x3:${overall.x3Losses || 0} | x4:${overall.x4Losses || 0} | x5:${overall.x5Losses || 0} | x6:${overall.x6Losses || 0} | x7:${overall.x7Losses || 0} | x8:${overall.x8Losses || 0} | x9:${overall.x9Losses || 0}
`
                : `Signal: autocorrelation(${regime.autocorrelation.toFixed(4)}) &lt; ${CONFIG.AUTOCORR_THRESHOLD}`
            }`.trim();

        await this.sendMessage(message);
    }

    static async sendSessionSummary() {
        try {
            const stats = SessionManager.getSessionStats();
            const today = TradeHistoryManager.getTodayStats();
            const overall = TradeHistoryManager.getOverallStats();

            let assetBreakdown = '';
            ACTIVE_ASSETS.forEach(symbol => {
                const a = state.assets[symbol];
                if (a && a.tradesCount > 0) {
                    const winRate = a.tradesCount > 0 ? ((a.winsCount / a.tradesCount) * 100).toFixed(1) : '0.0';
                    const ms = assetMaxStreakManager ? assetMaxStreakManager.getMaxStreak(symbol) : 'N/A';
                    const regime = AlternatingRegimeDetector.analyze(a.closedCandles);
                    assetBreakdown += `\n  ${symbol}: ${a.tradesCount} trades, ${a.winsCount}W/${a.lossesCount}L (${winRate}%), P/L: $${a.netPL.toFixed(2)}, Mart: ${a.martingaleLevel}, MaxStreak: ${ms}, AutoCorr: ${regime.autocorrelation.toFixed(4)}`;
                }
            });

            let overallAssetBreakdown = '';
            if (tradeHistory.overallAssets) {
                ACTIVE_ASSETS.forEach(symbol => {
                    const oa = tradeHistory.overallAssets[symbol];
                    if (oa && oa.tradesCount > 0) {
                        const winRate = oa.tradesCount > 0 ? ((oa.winsCount / oa.tradesCount) * 100).toFixed(1) : '0.0';
                        overallAssetBreakdown += `\n  ${symbol}: ${oa.tradesCount} trades, ${oa.winsCount}W/${oa.lossesCount}L (${winRate}%), P/L: $${oa.netPL.toFixed(2)}`;
                    }
                });
            }

            const recentDays = TradeHistoryManager.getRecentDays(5);
            let recentDaysStr = '';
            recentDays.forEach(day => {
                const wr = day.tradesCount > 0 ? ((day.winsCount / day.tradesCount) * 100).toFixed(1) : '0.0';
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
                `Loss Stats: x2:${today.x2Losses || 0} | x3:${today.x3Losses || 0} | x4:${today.x4Losses || 0} | x5:${today.x5Losses || 0} | x6:${today.x6Losses || 0} | x7:${today.x7Losses || 0} | x8:${today.x8Losses || 0} | x9:${today.x9Losses || 0}`,
                `Today P/L: $${(today.netPL || 0).toFixed(2)}`, ``,
                `📋 <b>Today's Per-Asset:</b>${assetBreakdown || '\n  No trades yet'}`, ``,
                `📊 <b>Overall Stats:</b>`,
                `Total Trades: ${overall.tradesCount || 0}`,
                `Overall Win Rate: ${overallWinRate}`,
                `Overall P/L: $${(overall.netPL || 0).toFixed(2)}`, ``,
                `Loss Stats: x2:${overall.x2Losses || 0} | x3:${overall.x3Losses || 0} | x4:${overall.x4Losses || 0} | x5:${overall.x5Losses || 0} | x6:${overall.x6Losses || 0} | x7:${overall.x7Losses || 0} | x8:${overall.x8Losses || 0} | x9:${overall.x9Losses || 0}`,
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
            const overall = TradeHistoryManager.getOverallStats();
            if (!dayStats || dayStats.tradesCount === 0) return;

            const dayWinRate = dayStats.tradesCount > 0
                ? ((dayStats.winsCount / dayStats.tradesCount) * 100).toFixed(1) + '%'
                : '0.0%';
            const overallWinRate = overall.tradesCount > 0
                ? ((overall.winsCount / overall.tradesCount) * 100).toFixed(1) + '%'
                : '0.0%';

            let assetBreakdown = '';
            if (dayStats.assets) {
                Object.keys(dayStats.assets).forEach(symbol => {
                    const a = dayStats.assets[symbol];
                    if (a && a.tradesCount > 0) {
                        const wr = ((a.winsCount / a.tradesCount) * 100).toFixed(1);
                        assetBreakdown += `\n  ${symbol}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L (${wr}%) P/L: $${(a.netPL || 0).toFixed(2)}`;
                    }
                });
            }

            const pnlEmoji = (dayStats.netPL || 0) >= 0 ? '🟢' : '🔴';
            const message = [
                `🌙 <b>END OF DAY REPORT 2b - ${dateKey}</b>`, ``,
                `${pnlEmoji} <b>Day Results:</b>`,
                `├ Trades: ${dayStats.tradesCount}`,
                `├ Wins: ${dayStats.winsCount} | Losses: ${dayStats.lossesCount}`,
                `├ Win Rate: ${dayWinRate}`,
                `├ Net P/L: $${(dayStats.netPL || 0).toFixed(2)}`,
                `├ Start Capital: $${(dayStats.startCapital || 0).toFixed(2)}`,
                `└ End Capital: $${(dayStats.endCapital || 0).toFixed(2)}`, ``,
                `📋 <b>Per-Asset:</b>${assetBreakdown || '\n  No trades'}`, ``,
                `📊 <b>Overall Stats (All Time):</b>`,
                `├ Total Trades: ${overall.tradesCount || 0}`,
                `├ Overall Win Rate: ${overallWinRate}`,
                `└ Overall P/L: $${(overall.netPL || 0).toFixed(2)}`, ``,
                `📊 <b>Overall Stats (All Time):</b>`,
                `├ Total Trades: ${overall.tradesCount || 0}`,
                `├ Overall Win Rate: ${overallWinRate}`,
                `├ Overall P/L: $${(overall.netPL || 0).toFixed(2)}`,
                `└ Loss Stats: x2:${overall.x2Losses || 0} x3:${overall.x3Losses || 0} x4:${overall.x4Losses || 0} x5:${overall.x5Losses || 0} x6:${overall.x6Losses || 0} x7:${overall.x7Losses || 0} x8:${overall.x8Losses || 0} x9:${overall.x9Losses || 0}`,
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
            const overall = TradeHistoryManager.getOverallStats();
            const totalDays = TradeHistoryManager.getAllDays().length;

            let assetConfigInfo = '';
            ACTIVE_ASSETS.forEach(symbol => {
                const ac = getAssetConfig(symbol);
                const ms = assetMaxStreakManager ? assetMaxStreakManager.getMaxStreak(symbol) : 'Computing...';
                assetConfigInfo += `\n  ${symbol}: ${ac.TIMEFRAME_LABEL} candles, Duration: ${ac.DURATION}${ac.DURATION_UNIT}, MaxStreak: ${ms}`;
            });

            const message = [
                `🤖 <b>DERIV RISE/FALL BOT STARTED 2b</b>`,
                `Strategy: 50k-candle assetMaxStreak detection`,
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
            const winRate = totalTrades > 0 ? ((statsSnapshot.wins / totalTrades) * 100).toFixed(1) : '0.0';
            const pnlEmoji = statsSnapshot.pnl >= 0 ? '🟢' : '🔴';
            const pnlStr = (statsSnapshot.pnl >= 0 ? '+' : '') + '$' + statsSnapshot.pnl.toFixed(2);

            const today = TradeHistoryManager.getTodayStats();
            const overall = TradeHistoryManager.getOverallStats();

            let assetInfo = '';
            ACTIVE_ASSETS.forEach(symbol => {
                const a = state.assets[symbol];
                if (a) {
                    const ac = getAssetConfig(symbol);
                    const ms = assetMaxStreakManager ? assetMaxStreakManager.getMaxStreak(symbol) : 'N/A';
                    const regime = AlternatingRegimeDetector.analyze(a.closedCandles);
                    assetInfo += `\n  ${symbol} (${ac.TIMEFRAME_LABEL}/${ac.DURATION}${ac.DURATION_UNIT}): Mart=${a.martingaleLevel}, Stake=$${a.currentStake.toFixed(2)}, P/L=$${a.netPL.toFixed(2)}, MaxStreak=${ms}, AutoCorr: ${regime.autocorrelation.toFixed(4)}`;
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
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const timeUntilNextHour = nextHour.getTime() - now.getTime();
        LOGGER.info(`⏰ Hourly Telegram timer started (first summary in ${Math.ceil(timeUntilNextHour / 60000)} min)`);
        const self = this;
        setTimeout(() => {
            self.sendHourlySummary();
            // Store the interval ID so it can be cleared later
            self.hourlyTimerId = setInterval(() => self.sendHourlySummary(), 60 * 60 * 1000);
        }, timeUntilNextHour);
    }

    static startDailyTimer() {
        if (this.dailyTimerStarted) {
            LOGGER.debug('🗓️ Daily timer already started, skipping');
            return;
        }
        this.dailyTimerStarted = true;
        const now = new Date();
        const nextDay = new Date(now);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(0, 0, 0, 0);
        const timeUntilNextDay = nextDay.getTime() - now.getTime();
        LOGGER.info(`🗓️ Daily Telegram timer started (first summary in ${Math.ceil(timeUntilNextDay / 60000 / 60)} hours)`);
        setTimeout(() => {
            if (typeof SessionManager !== 'undefined') SessionManager.checkDayChange();
            // Store the interval ID so it can be cleared later
            this.dailyTimerId = setInterval(() => {
                if (typeof SessionManager !== 'undefined') SessionManager.checkDayChange();
            }, 24 * 60 * 60 * 1000);
        }, timeUntilNextDay);
    }
    
    static clearTimers() {
        if (this.hourlyTimerId) {
            clearInterval(this.hourlyTimerId);
            this.hourlyTimerId = null;
            this.hourlyTimerStarted = false;
        }
        if (this.dailyTimerId) {
            clearInterval(this.dailyTimerId);
            this.dailyTimerId = null;
            this.dailyTimerStarted = false;
        }
        LOGGER.info('🧹 Telegram timers cleared');
    }
}

// ============================================
// LOGGER UTILITY
// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';
const LOGGER = {
    info: msg => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: msg => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: msg => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
    error: msg => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: msg => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); }
};

// ============================================
// CANDLE ANALYSIS UTILITY
// ============================================
class CandleAnalyzer {
    static isBullish(candle) { return candle.close > candle.open; }
    static isBearish(candle) { return candle.close < candle.open; }
    static getLastClosedCandle(symbol) {
        const assetState = state.assets[symbol];
        if (!assetState || !assetState.closedCandles || assetState.closedCandles.length === 0) return null;
        return assetState.closedCandles[assetState.closedCandles.length - 1];
    }
    static getCandleDirection(candle) {
        if (this.isBullish(candle)) return 'BULLISH';
        if (this.isBearish(candle)) return 'BEARISH';
        return 'DOJI';
    }
}

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
    // ── After assetMaxStreak is computed we only keep 1440 live candles ──
    MAX_CANDLES_STORED: 60,
    CANDLES_TO_LOAD: 60,

    // ── Autocorrelation trade threshold ──────────────────────────
    // Trade fires when autocorrelation < AUTOCORR_THRESHOLD
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
        GRANULARITY: assetOverrides.GRANULARITY !== undefined ? assetOverrides.GRANULARITY : CONFIG.GRANULARITY,
        TIMEFRAME_LABEL: assetOverrides.TIMEFRAME_LABEL !== undefined ? assetOverrides.TIMEFRAME_LABEL : CONFIG.TIMEFRAME_LABEL,
        MAX_CANDLES_STORED: assetOverrides.MAX_CANDLES_STORED !== undefined ? assetOverrides.MAX_CANDLES_STORED : CONFIG.MAX_CANDLES_STORED,
        CANDLES_TO_LOAD: assetOverrides.CANDLES_TO_LOAD !== undefined ? assetOverrides.CANDLES_TO_LOAD : CONFIG.CANDLES_TO_LOAD,
        DURATION: assetOverrides.DURATION !== undefined ? assetOverrides.DURATION : CONFIG.DURATION,
        DURATION_UNIT: assetOverrides.DURATION_UNIT !== undefined ? assetOverrides.DURATION_UNIT : CONFIG.DURATION_UNIT
    };
}

let ACTIVE_ASSETS = [...CONFIG.ACTIVE_ASSETS];

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    assets: {},
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    currentTradeDay: null,
    activeTradeAsset: null,
    lastTradeDirection: null,
    isMaxStreakReady: false, // NEW: gates trading until assetMaxStreaks are computed
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
    tradeInProgress: false,
    pendingTradeInfo: null,
    tradeStartTime: null,
    currentContractId: null
};

let tradeHistory = null;
let assetMaxStreakManager = null; // instantiated after LOGGER is ready


// ============================================
// ALTERNATING REGIME DETECTOR
// ============================================
/**
 * SIMPLIFIED — only computes and returns the lag-1 autocorrelation
 * of the candle direction sequence (1 = bullish, 0 = bearish).
 *
 * autocorrelation < -0.06  →  mild mean-reversion regime → trade signal
 *
 * The full 50 k-candle assetMaxStreak is managed by AssetMaxStreakManager;
 * this class works purely on the live 50-candle closedCandles window.
 */
class AlternatingRegimeDetector {

    /**
     * Main entry-point.
     * @param  {Array}  candleHistory  Array of {open, close} candle objects
     * @returns {{ autocorrelation: number }}
     */
    static analyze(candleHistory) {
        // Validate input
        if (!Array.isArray(candleHistory) || candleHistory.length < 4) {
            LOGGER.warn('AlternatingRegimeDetector: Invalid candle history');
            return { autocorrelation: 0 };
        }

        // Filter out invalid candles
        const validCandles = candleHistory.filter(c =>
            c && typeof c.open === 'number' && typeof c.close === 'number' &&
            !isNaN(c.open) && !isNaN(c.close)
        );

        if (validCandles.length < 4) {
            LOGGER.warn('AlternatingRegimeDetector: Insufficient valid candles');
            return { autocorrelation: 0 };
        }

        const seq = validCandles.map(c => (c.close > c.open ? 1 : 0));
        const autocorrelation = this._autocorrelation(seq);

        // Validate output
        if (isNaN(autocorrelation) || !isFinite(autocorrelation)) {
            LOGGER.error('AlternatingRegimeDetector: Invalid autocorrelation result');
            return { autocorrelation: 0 };
        }

        return { autocorrelation };
    }

    // ── Internal: lag-1 Pearson autocorrelation ───────────────────
    static _autocorrelation(seq) {
        const n = seq.length;
        if (n < 4) return 0;

        const x = seq.slice(0, n - 1);
        const y = seq.slice(1);
        const meanX = x.reduce((a, b) => a + b, 0) / x.length;
        const meanY = y.reduce((a, b) => a + b, 0) / y.length;

        let num = 0, dX = 0, dY = 0;
        for (let i = 0; i < x.length; i++) {
            const dx = x[i] - meanX;
            const dy = y[i] - meanY;
            num += dx * dy;
            dX += dx * dx;
            dY += dy * dy;
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
        const now = new Date();
        return new Date(now.getTime() + (1 * 60 * 60 * 1000));
    }

    static isWithinTradingSession() {
        const gmtPlus1 = this.getGMTPlus1Time();
        const currentHour = gmtPlus1.getUTCHours();
        const currentMinute = gmtPlus1.getUTCMinutes();
        const currentTimeDecimal = currentHour + (currentMinute / 60);

        if (currentTimeDecimal >= CONFIG.TOKYO_START && currentTimeDecimal < CONFIG.TOKYO_END)
            return { inSession: true, sessionName: 'TOKYO', nextSession: null, minutesUntilNext: 0 };
        if (currentTimeDecimal >= CONFIG.LONDON_START && currentTimeDecimal < CONFIG.LONDON_END)
            return { inSession: true, sessionName: 'LONDON', nextSession: null, minutesUntilNext: 0 };
        if (currentTimeDecimal >= CONFIG.NEWYORK_START && currentTimeDecimal < CONFIG.NEWYORK_END)
            return { inSession: true, sessionName: 'NEW YORK', nextSession: null, minutesUntilNext: 0 };
        if (CONFIG.SYDNEY_END < CONFIG.SYDNEY_START) {
            if (currentTimeDecimal >= CONFIG.SYDNEY_START || currentTimeDecimal < CONFIG.SYDNEY_END)
                return { inSession: true, sessionName: 'SYDNEY', nextSession: null, minutesUntilNext: 0 };
        } else {
            if (currentTimeDecimal >= CONFIG.SYDNEY_START && currentTimeDecimal < CONFIG.SYDNEY_END)
                return { inSession: true, sessionName: 'SYDNEY', nextSession: null, minutesUntilNext: 0 };
        }

        let nextSession = '';
        let minutesUntilNext = 0;
        if (currentTimeDecimal < CONFIG.TOKYO_START) {
            nextSession = 'TOKYO'; minutesUntilNext = (CONFIG.TOKYO_START - currentTimeDecimal) * 60;
        } else if (currentTimeDecimal < CONFIG.LONDON_START) {
            nextSession = 'LONDON'; minutesUntilNext = (CONFIG.LONDON_START - currentTimeDecimal) * 60;
        } else if (currentTimeDecimal < CONFIG.NEWYORK_START) {
            nextSession = 'NEW YORK'; minutesUntilNext = (CONFIG.NEWYORK_START - currentTimeDecimal) * 60;
        } else if (currentTimeDecimal < CONFIG.SYDNEY_START) {
            nextSession = 'SYDNEY'; minutesUntilNext = (CONFIG.SYDNEY_START - currentTimeDecimal) * 60;
        } else {
            nextSession = 'TOKYO'; minutesUntilNext = ((24 - currentTimeDecimal) + CONFIG.TOKYO_START) * 60;
        }
        return { inSession: false, sessionName: null, nextSession, minutesUntilNext: Math.round(minutesUntilNext) };
    }

    static getSessionStatusString() {
        const sessionInfo = this.isWithinTradingSession();
        const gmtPlus1 = this.getGMTPlus1Time();
        const timeStr = `${String(gmtPlus1.getUTCHours()).padStart(2, '0')}:${String(gmtPlus1.getUTCMinutes()).padStart(2, '0')} GMT+1`;
        if (sessionInfo.inSession) return `🟢 IN SESSION: ${sessionInfo.sessionName} (${timeStr})`;
        return `🔴 OUTSIDE SESSION (${timeStr}) — Next: ${sessionInfo.nextSession} in ${sessionInfo.minutesUntilNext}min`;
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
        const hours = Math.floor(duration / 3600000);
        const minutes = Math.floor((duration % 3600000) / 60000);
        return {
            duration: `${hours}h ${minutes}m`,
            trades: state.session.tradesCount,
            wins: state.session.winsCount,
            losses: state.session.lossesCount,
            winRate: state.session.tradesCount > 0
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
            LOGGER.info(`🗓️ Day changed from ${state.currentTradeDay} to ${currentDay}`);
            TelegramService.sendDayEndSummary(state.currentTradeDay);
            this.resetSessionForNewDay();
        }
        state.currentTradeDay = currentDay;
    }

    static resetSessionForNewDay() {
        LOGGER.info('🗓️ Resetting session stats for new trading day...');
        state.session.tradesCount = 0; state.session.winsCount = 0; state.session.lossesCount = 0;
        state.session.profit = 0; state.session.loss = 0; state.session.netPL = 0;
        state.session.x2Losses = 0; state.session.x3Losses = 0; state.session.x4Losses = 0;
        state.session.x5Losses = 0; state.session.x6Losses = 0; state.session.x7Losses = 0;
        state.session.x8Losses = 0; state.session.x9Losses = 0;
        state.session.startTime = Date.now();
        state.session.startCapital = state.capital;
        state.lastSessionLogTime = 0;

        ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset) {
                asset.tradesCount = 0; asset.winsCount = 0; asset.lossesCount = 0;
                asset.profit = 0; asset.loss = 0; asset.netPL = 0;
                asset.lastCrossSignalDirection = null;
            }
        });

        state.portfolio.dailyProfit = 0; state.portfolio.dailyLoss = 0;
        state.portfolio.dailyWins = 0; state.portfolio.dailyLosses = 0;
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };

        TradeHistoryManager.ensureDayEntry(TradeHistoryManager.getDateKey());
        tradeHistory.dailyHistory[TradeHistoryManager.getDateKey()].startCapital = state.capital;
        TradeHistoryManager.saveHistory();

        // Reset watchdog fields
        state.tradeInProgress = false;
        state.currentContractId = null;
        state.tradeStartTime = null;
        state.pendingTradeInfo = null;

        LOGGER.info('🗓️ Daily stats reset for new day (martingale state preserved)');
    }

    static recordTradeResult(symbol, profit, direction) {
        const assetState = state.assets[symbol];
        if (!assetState) { LOGGER.error(`recordTradeResult: Unknown symbol ${symbol}`); return; }

        this.checkDayChange();

        const currentHour = new Date().getHours();
        if (currentHour !== state.hourlyStats.lastHour) {
            state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: currentHour };
        }

        state.session.tradesCount++;
        state.capital += profit;
        state.hourlyStats.trades++;
        state.hourlyStats.pnl += profit;
        assetState.tradesCount++;

        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            state.hourlyStats.wins++;
            assetState.winsCount++;
            assetState.profit += profit;
            assetState.netPL += profit;
            assetState.martingaleLevel = 0;
            assetState.lastTradeWasWin = true;
            assetState.currentStake = CONFIG.STAKE;
            state.activeTradeAsset = null;
            ACTIVE_ASSETS = [...CONFIG.ACTIVE_ASSETS];
            TradeHistoryManager.recordTrade(symbol, profit, assetState.martingaleLevel);
            LOGGER.trade(`✅ [${symbol}] WIN: +$${profit.toFixed(2)} | Direction: ${direction} | Martingale Reset | P/L: $${assetState.netPL.toFixed(2)}`);
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            state.hourlyStats.losses++;
            assetState.lossesCount++;
            assetState.loss += Math.abs(profit);
            assetState.netPL += profit;
            assetState.martingaleLevel++;
            assetState.lastTradeWasWin = false;

            if (assetState.martingaleLevel >= 2 && assetState.martingaleLevel <= 9) {
                const key = `x${assetState.martingaleLevel}Losses`;
                if (assetState[key] !== undefined) assetState[key]++;
                if (state.session[key] !== undefined) state.session[key]++;
            }

            TradeHistoryManager.recordTrade(symbol, profit, assetState.martingaleLevel);

            if (assetState.martingaleLevel === 1) {
                assetState.currentStake = Math.ceil(assetState.currentStake * CONFIG.MARTINGALE_MULTIPLIER * 100) / 100;
            } else if (assetState.martingaleLevel === 2) {
                assetState.currentStake = Math.ceil(assetState.currentStake * CONFIG.MARTINGALE_MULTIPLIER2 * 100) / 100;
            } else if (assetState.martingaleLevel >= 3) {
                assetState.currentStake = Math.ceil(assetState.currentStake * CONFIG.MARTINGALE_MULTIPLIER3 * 100) / 100;
            }

            if (assetState.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS) {
                LOGGER.warn(`⚠️ [${symbol}] Max Martingale reached (${CONFIG.MAX_MARTINGALE_STEPS}), resetting`);
                assetState.martingaleLevel = 0;
                assetState.currentStake = CONFIG.STAKE;
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
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 5000;
        this.pingInterval = null;
        this.autoSaveStarted = false;
        this.isReconnecting = false;
        this.activeSubscriptions = new Set();
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) { LOGGER.info('Already connected'); return; }
        LOGGER.info('🔌 Connecting to Deriv API...');
        this.cleanup();
        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);
        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', data => this.onMessage(data));
        this.ws.on('error', error => this.onError(error));
        this.ws.on('close', () => this.onClose());
        return this.ws;
    }

    onOpen() {
        LOGGER.info('✅ Connected to Deriv API');
        state.isConnected = true;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.startPing();
        if (!this.autoSaveStarted) { StatePersistence.startAutoSave(); this.autoSaveStarted = true; }
        this.send({ authorize: CONFIG.API_TOKEN });
    }

    initializeAssets() {
        ACTIVE_ASSETS.forEach(symbol => {
            if (!state.assets[symbol]) {
                state.assets[symbol] = {
                    candles: [], closedCandles: [],
                    currentFormingCandle: null,
                    lastProcessedCandleOpenTime: null,
                    candlesLoaded: false,
                    lastTradeDirection: null,
                    lastTradeWasWin: null,
                    martingaleLevel: 0,
                    currentStake: CONFIG.STAKE,
                    canTrade: false,
                    lastClosedCandleForRecovery: null,
                    activePositions: [],
                    tradesCount: 0, winsCount: 0, lossesCount: 0,
                    profit: 0, loss: 0, netPL: 0,
                    x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
                    x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0
                };
                const ac = getAssetConfig(symbol);
                LOGGER.info(`📊 Initialized asset: ${symbol} (${ac.TIMEFRAME_LABEL} candles, Duration: ${ac.DURATION}${ac.DURATION_UNIT})`);
            }
        });
    }

    restoreSubscriptions() {
        LOGGER.info('📊 Restoring subscriptions after reconnection...');
        
        // Clear the subscription tracking set since we're reconnecting
        this.activeSubscriptions.clear();
        
        ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset && asset.activePositions) {
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
        if (this.ws) {
            // Unsubscribe from all active candle subscriptions
            if (this.activeSubscriptions.size > 0) {
                LOGGER.info(`🧹 Cleaning up ${this.activeSubscriptions.size} active subscriptions`);
                this.send({ forget_all: 'candles' });
                this.activeSubscriptions.clear();
            }
            
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { LOGGER.debug('WebSocket already closed'); }
            }
            this.ws = null;
        }
        
        // Clear ping interval
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
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
        if (response.msg_type === 'authorize') {
            if (response.error) { LOGGER.error(`Authorization failed: ${response.error.message}`); return; }
            LOGGER.info('🔑 Authorized successfully');
            LOGGER.info(`  Account: ${response.authorize.loginid}`);
            LOGGER.info(`  Balance: ${response.authorize.balance} ${response.authorize.currency}`);
            state.isAuthorized = true;
            state.accountBalance = response.authorize.balance;
            if (state.capital === CONFIG.INITIAL_CAPITAL) state.capital = response.authorize.balance;
            this.send({ balance: 1, subscribe: 1 });
            if (this.reconnectAttempts > 0 || this.hasAnyActivePositions()) {
                LOGGER.info('🔄 Reconnection detected, restoring subscriptions...');
                this.restoreSubscriptions();
            }
            bot.start();
        }
        if (response.msg_type === 'balance') state.accountBalance = response.balance.balance;
        if (response.msg_type === 'ohlc') this.handleOHLC(response.ohlc);
        if (response.msg_type === 'candles') this.handleCandlesHistory(response);
        if (response.msg_type === 'buy') this.handleBuyResponse(response);
        if (response.msg_type === 'proposal_open_contract') this.handleOpenContract(response);
    }

    hasAnyActivePositions() {
        return ACTIVE_ASSETS.some(symbol => {
            const asset = state.assets[symbol];
            return asset && asset.activePositions && asset.activePositions.length > 0;
        });
    }

    getTotalActivePositions() {
        let total = 0;
        ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset && asset.activePositions) total += asset.activePositions.length;
        });
        return total;
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);
            const reqId = response.echo_req?.req_id;
            if (reqId) {
                ACTIVE_ASSETS.forEach(symbol => {
                    const asset = state.assets[symbol];
                    if (asset && asset.activePositions) {
                        const posIndex = asset.activePositions.findIndex(p => p.reqId === reqId);
                        if (posIndex >= 0) { asset.activePositions.splice(posIndex, 1); LOGGER.info(`  Removed failed position from ${symbol}`); }
                    }
                });
            }
            return;
        }

        const contract = response.buy;
        LOGGER.trade(`✅ Position opened: Contract ${contract.contract_id}, Buy Price: $${contract.buy_price}`);

        const reqId = response.echo_req.req_id;
        let foundSymbol = null;
        let position = null;

        for (const symbol of ACTIVE_ASSETS) {
            const asset = state.assets[symbol];
            if (asset && asset.activePositions) {
                position = asset.activePositions.find(p => p.reqId === reqId);
                if (position) { foundSymbol = symbol; break; }
            }
        }

        if (position && foundSymbol) {
            position.contractId = contract.contract_id;
            position.buyPrice = contract.buy_price;

            // Set watchdog tracking fields
            state.tradeInProgress = true;
            state.currentContractId = contract.contract_id;
            state.tradeStartTime = Date.now();
            state.pendingTradeInfo = {
                stake: position.stake,
                direction: position.direction,
                symbol: position.symbol
            };

            // Start the watchdog timer
            bot._startTradeWatchdog(contract.contract_id);

            TelegramService.sendTradeAlert(
                'OPEN', position.symbol, position.direction,
                position.stake, position.duration, position.durationUnit, {}
            );
        }

        this.send({ proposal_open_contract: 1, contract_id: contract.contract_id, subscribe: 1 });
    }

    handleOpenContract(response) {
        if (response.error) {
            LOGGER.error(`Contract error: ${response.error.message}`);
            // Force release lock on error
            if (bot) bot._forceReleaseTradeLock();
            return;
        }

        const contract = response.proposal_open_contract;
        const contractId = contract.contract_id;

        // ═══════════════════════════════════════════════════════════════
        // FIX: Mark as processed IMMEDIATELY (before any other logic)
        // ═══════════════════════════════════════════════════════════════
        const contractIdStr = String(contractId);

        if (bot._processedContracts.has(contractIdStr)) {
            LOGGER.debug(`⚠️ Contract ${contractId} already processed, ignoring duplicate`);

            // Unsubscribe to prevent further duplicates
            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }
            return;
        }

        // Find owner symbol
        let ownerSymbol = null;
        let posIndex = -1;

        for (const symbol of ACTIVE_ASSETS) {
            const asset = state.assets[symbol];
            if (asset && asset.activePositions) {
                const idx = asset.activePositions.findIndex(p => p.contractId === contractId);
                if (idx >= 0) {
                    ownerSymbol = symbol;
                    posIndex = idx;
                    break;
                }
            }
        }

        if (posIndex < 0 || !ownerSymbol) {
            LOGGER.debug(`Contract ${contractId} not found in active positions`);
            return;
        }

        const assetState = state.assets[ownerSymbol];
        const position = assetState.activePositions[posIndex];

        // Update profit tracking
        position.currentProfit = contract.profit;

        // Only process settlement (sold/expired)
        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {

            // ═══════════════════════════════════════════════════════════
            // CRITICAL: Mark as processed BEFORE any processing starts
            // ═══════════════════════════════════════════════════════════
            bot._processedContracts.add(contractIdStr);

            // Clear watchdog
            bot._clearAllWatchdogTimers();

            const profit = contract.profit;

            LOGGER.trade(
                `[${ownerSymbol}] Contract ${contractId} closed: ` +
                `${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`
            );

            // Record result
            SessionManager.recordTradeResult(ownerSymbol, profit, position.direction);

            // Send Telegram alert
            TelegramService.sendTradeAlert(
                profit >= 0 ? 'WIN' : 'LOSS',
                ownerSymbol,
                position.direction,
                position.stake,
                position.duration,
                position.durationUnit,
                { profit }
            );

            // Remove position from array
            assetState.activePositions.splice(posIndex, 1);

            // Release lock
            state.tradeInProgress = false;
            state.currentContractId = null;
            state.tradeStartTime = null;
            state.pendingTradeInfo = null;

            // Unsubscribe
            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }

            // Check session targets
            SessionManager.checkSessionTargets();

            // Save state
            StatePersistence.saveState();

            LOGGER.info(`✅ Contract ${contractId} safely completed`);
        }
    }

    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        if (!state.assets[symbol]) return;

        if (!state.isMaxStreakReady) {
            LOGGER.debug(`[${symbol}] OHLC received but maxStreak not ready yet — buffering candle only`);
            const assetState = state.assets[symbol];
            const assetConfig = getAssetConfig(symbol);
            const granularity = assetConfig.GRANULARITY;
            const calculatedOpenTime = ohlc.open_time || Math.floor(ohlc.epoch / granularity) * granularity;
            assetState.currentFormingCandle = {
                open: parseFloat(ohlc.open), high: parseFloat(ohlc.high),
                low: parseFloat(ohlc.low), close: parseFloat(ohlc.close),
                epoch: ohlc.epoch, open_time: calculatedOpenTime
            };
            return;
        }

        const assetState = state.assets[symbol];
        const assetConfig = getAssetConfig(symbol);
        const granularity = assetConfig.GRANULARITY;
        const calculatedOpenTime = ohlc.open_time || Math.floor(ohlc.epoch / granularity) * granularity;

        const incomingCandle = {
            open: parseFloat(ohlc.open), high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low), close: parseFloat(ohlc.close),
            epoch: ohlc.epoch, open_time: calculatedOpenTime
        };

        // VALIDATION: Check for invalid candle data
        if (isNaN(incomingCandle.open) || isNaN(incomingCandle.close) ||
            isNaN(incomingCandle.high) || isNaN(incomingCandle.low)) {
            LOGGER.error(`[${symbol}] Invalid candle data received, skipping`);
            return;
        }

        const currentOpenTime = assetState.currentFormingCandle?.open_time;
        const isNewCandle = currentOpenTime && incomingCandle.open_time !== currentOpenTime;

        if (isNewCandle) {
            const closedCandle = { ...assetState.currentFormingCandle };
            closedCandle.epoch = closedCandle.open_time + granularity;

            // PREVENT DUPLICATES: Check if this exact candle was already processed
            const isDuplicate = assetState.closedCandles.some(
                c => c.open_time === closedCandle.open_time
            );

            if (!isDuplicate && closedCandle.open_time !== assetState.lastProcessedCandleOpenTime) {
                assetState.closedCandles.push(closedCandle);
                assetState.lastClosedCandleForRecovery = closedCandle;

                if (assetState.closedCandles.length > assetConfig.MAX_CANDLES_STORED) {
                    assetState.closedCandles = assetState.closedCandles.slice(-assetConfig.MAX_CANDLES_STORED);
                }

                assetState.lastProcessedCandleOpenTime = closedCandle.open_time;

                const closeTime = new Date(closedCandle.epoch * 1000).toISOString();
                const candleType = CandleAnalyzer.getCandleDirection(closedCandle);
                const candleEmoji = candleType === 'BULLISH' ? '🟢' : candleType === 'BEARISH' ? '🔴' : '⚪';

                LOGGER.info(
                    `${symbol} ${candleEmoji} CANDLE CLOSED [${closeTime}] ${candleType}: ` +
                    `O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} ` +
                    `L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)}`
                );

                const regime = AlternatingRegimeDetector.analyze(assetState.closedCandles);
                const assetMaxStreak = assetMaxStreakManager ? assetMaxStreakManager.getMaxStreak(symbol) : 'N/A';
                LOGGER.info(`${symbol} AutoCorr: ${regime.autocorrelation.toFixed(4)} (threshold: ${CONFIG.AUTOCORR_THRESHOLD}) | AssetMaxStreak: ${assetMaxStreak} | Candles: ${assetState.closedCandles.length}`);

                assetState.canTrade = true;

                // Execute trades with error handling
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
                LOGGER.debug(`[${symbol}] Skipped duplicate candle at ${closedCandle.open_time}`);
            }
        }

        assetState.currentFormingCandle = incomingCandle;

        // Update candles array safely
        const candles = assetState.candles;
        const existingIndex = candles.findIndex(c => c.open_time === incomingCandle.open_time);
        if (existingIndex >= 0) {
            candles[existingIndex] = incomingCandle;
        } else {
            candles.push(incomingCandle);
        }
        if (candles.length > assetConfig.MAX_CANDLES_STORED) {
            assetState.candles = candles.slice(-assetConfig.MAX_CANDLES_STORED);
        }
    }

    handleCandlesHistory(response) {
        if (response.error) { LOGGER.error(`Error fetching candles: ${response.error.message}`); return; }
        // Note: candles responses during maxStreak computation are handled
        // by AssetMaxStreakManager's one-shot listener, NOT here.
        // This handler only processes the initial subscription load.

        const symbol = response.echo_req.ticks_history;
        if (!state.assets[symbol]) return;

        // Skip if this looks like a large historical batch (count > 100)
        // — those are consumed by AssetMaxStreakManager
        if (response.echo_req.count > 100) return;

        const assetConfig = getAssetConfig(symbol);
        const granularity = assetConfig.GRANULARITY;

        const candles = response.candles.map(c => {
            const openTime = Math.floor((c.epoch - granularity) / granularity) * granularity;
            return {
                open: parseFloat(c.open), high: parseFloat(c.high),
                low: parseFloat(c.low), close: parseFloat(c.close),
                epoch: c.epoch, open_time: openTime
            };
        });

        if (candles.length === 0) { LOGGER.warn(`${symbol}: No historical candles received`); return; }

        state.assets[symbol].candles = [...candles];
        state.assets[symbol].closedCandles = [...candles];
        state.assets[symbol].lastClosedCandleForRecovery = candles[candles.length - 1];
        state.assets[symbol].lastProcessedCandleOpenTime = candles[candles.length - 1].open_time;
        state.assets[symbol].currentFormingCandle = null;

        const regime = AlternatingRegimeDetector.analyze(state.assets[symbol].closedCandles);
        LOGGER.info(`📊 Loaded ${candles.length} ${assetConfig.TIMEFRAME_LABEL} candles for ${symbol} | AutoCorr: ${regime.autocorrelation.toFixed(4)} | Ready for trade analysis`);
    }

    onError(error) { LOGGER.error(`WebSocket error: ${error.message}`); }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;
        this.stopPing();
        StatePersistence.saveState();

        if (this.isReconnecting) { LOGGER.info('Already handling disconnect, skipping...'); return; }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.isReconnecting = true;
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

            TelegramService.sendMessage(
                `⚠️ <b>CONNECTION LOST - RECONNECTING 2b</b>\n` +
                `Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
                `Retrying in ${(delay / 1000).toFixed(1)}s\n` +
                `State preserved: ${state.session.tradesCount} trades, $${state.session.netPL.toFixed(2)} P&L`
            );

            setTimeout(() => {
                this.isReconnecting = false;
                state.activeTradeAsset = null;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            TelegramService.sendMessage(`🛑 <b>BOT STOPPED 2b</b>\nMax reconnection attempts reached.\nFinal P&L: $${state.session.netPL.toFixed(2)}`);
            process.exit(1);
        }
    }

    startPing() {
        this.pingInterval = setInterval(() => { if (state.isConnected) this.send({ ping: 1 }); }, 30000);
    }
    stopPing() { if (this.pingInterval) clearInterval(this.pingInterval); }

    send(data) {
        if (!state.isConnected) { LOGGER.error('Cannot send: Not connected'); return null; }
        data.req_id = state.requestId++;
        this.ws.send(JSON.stringify(data));
        return data.req_id;
    }
}

// ============================================
// MAIN BOT CLASS
// ============================================
class DerivBot {
    constructor() {
        this.connection = new ConnectionManager();
        this._processedContracts = new Set();
        this.tradeWatchdogMs = 75000;
        this.timeCheckStarted = false;
        this.sessionTimeCheckerId = null;
        this.statusDisplayIntervalId = null;
        this.contractCleanupIntervalId = null;

        // ✅ Clear old contract IDs periodically and store interval ID
        this.contractCleanupIntervalId = setInterval(() => {
            const size = this._processedContracts.size;
            if (size > 500) {
                LOGGER.info(`Clearing ${size} processed contracts from memory`);
                this._processedContracts.clear();
            }
        }, 3600000); // Every hour
    }

    async start() {
        console.log('\n' + '═'.repeat(80));
        console.log(' DERIV RISE/FALL CANDLE PATTERN BOT (Per-Asset Independent Management)');
        console.log('═'.repeat(80));
        console.log(`  Initial Capital : $${state.capital}`);
        console.log(`  Active Assets   : ${ACTIVE_ASSETS.join(', ')}`);
        console.log(`  Base Stake      : $${CONFIG.STAKE} (per asset)`);
        console.log(`  Strategy        : autocorrelation < ${CONFIG.AUTOCORR_THRESHOLD} to trigger trade`);
        console.log(`  MaxStreak Source: 50,000 candles (10 × 5,000 API batches)`);
        console.log(`  MaxStreak Status: ${assetMaxStreakManager.allReady() ? 'LOADED FROM FILE' : 'NEEDS COMPUTATION'}`);
        console.log('═'.repeat(80) + '\n');

        state.currentTradeDay = TradeHistoryManager.getDateKey();
        TradeHistoryManager.ensureDayEntry(state.currentTradeDay);
        if (!tradeHistory.dailyHistory[state.currentTradeDay].startCapital ||
            tradeHistory.dailyHistory[state.currentTradeDay].startCapital === 0) {
            tradeHistory.dailyHistory[state.currentTradeDay].startCapital = state.capital;
        }

        this.connection.initializeAssets();

        // ── Step 1: Check if assetMaxStreak needs computation ─────────
        if (assetMaxStreakManager.needsRefresh() || !assetMaxStreakManager.allReady()) {
            LOGGER.info('📊 assetMaxStreak computation required — pausing trading...');
            state.isMaxStreakReady = false;

            // Subscribe candles first (needed for OHLC stream, but trades won't fire)
            ACTIVE_ASSETS.forEach(symbol => this.subscribeToCandles(symbol));

            // Compute maxStreak for all assets sequentially
            await assetMaxStreakManager.computeAllMaxStreaks(this.connection);

            state.isMaxStreakReady = true;
            LOGGER.info('✅ assetMaxStreak ready — trading ENABLED');

            // Trim all closedCandles to 50 (done inside computeAllMaxStreaks but safety net)
            ACTIVE_ASSETS.forEach(symbol => {
                const assetState = state.assets[symbol];
                if (assetState && assetState.closedCandles.length > CONFIG.MAX_CANDLES_STORED) {
                    assetState.closedCandles = assetState.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED);
                }
            });

        } else {
            LOGGER.info('✅ assetMaxStreak loaded from file — trading ENABLED immediately');
            state.isMaxStreakReady = true;

            // Log loaded maxStreaks
            ACTIVE_ASSETS.forEach(symbol => {
                LOGGER.info(`  [${symbol}] assetMaxStreak = ${assetMaxStreakManager.getMaxStreak(symbol)}`);
            });

            // Subscribe to live candles
            ACTIVE_ASSETS.forEach(symbol => this.subscribeToCandles(symbol));
        }

        // ── Step 2: Schedule monthly refresh ──────────────────────────
        assetMaxStreakManager.scheduleMonthlyRefresh(this.connection);

        // ── Step 3: Start timers ───────────────────────────────────────
        TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();
        TelegramService.startDailyTimer();
        this.startSessionTimeChecker();

        LOGGER.info('✅ Bot started successfully! (Per-Asset Independent + Immediate Recovery Mode)');
    }

    subscribeToCandles(symbol) {
        const assetConfig = getAssetConfig(symbol);
        
        // Check if already subscribed to prevent duplicate subscriptions
        if (this.connection.activeSubscriptions.has(symbol)) {
            LOGGER.debug(`📊 Already subscribed to ${symbol}, skipping duplicate subscription`);
            return;
        }
        
        LOGGER.info(`📊 Subscribing to ${assetConfig.TIMEFRAME_LABEL} candles for ${symbol} (granularity: ${assetConfig.GRANULARITY}s)...`);

        // Load only 50 recent candles for trade analysis
        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: assetConfig.CANDLES_TO_LOAD, // 50
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: assetConfig.GRANULARITY
        });

        // Subscribe to live stream
        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: 1,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: assetConfig.GRANULARITY,
            subscribe: 1
        });
        
        // Track this subscription
        this.connection.activeSubscriptions.add(symbol);
    }

    // ── IMMEDIATE RECOVERY TRADE ───────────────────────────────────
    executeRecoveryTrade(symbol, closedCandle) {
        const assetState = state.assets[symbol];
        if (!assetState) return;

        if (!SessionManager.isSessionActive()) {
            LOGGER.info(`[${symbol}] Recovery skipped — session ended`);
            return;
        }
        if (assetState.martingaleLevel === 0) {
            LOGGER.info(`[${symbol}] Recovery skipped — not in loss recovery (mart=${assetState.martingaleLevel})`);
            return;
        }
        if (assetState.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) {
            LOGGER.warn(`[${symbol}] Recovery skipped — position already open (${assetState.activePositions.length})`);
            return;
        }

        const stake = assetState.currentStake;
        if (state.capital < stake) {
            LOGGER.error(`[${symbol}] Recovery skipped — insufficient capital $${state.capital.toFixed(2)} (need $${stake.toFixed(2)})`);
            if (assetState.martingaleLevel > 0) { assetState.martingaleLevel = 0; assetState.currentStake = CONFIG.STAKE; }
            return;
        }
        if (!state.isConnected || !state.isAuthorized) {
            LOGGER.warn(`[${symbol}] Recovery skipped — not connected/authorised`);
            return;
        }
        if (!state.isMaxStreakReady) {
            LOGGER.warn(`[${symbol}] Recovery skipped — maxStreak not yet ready`);
            return;
        }

        if (CONFIG.USE_TRADING_SESSIONS) {
            const sessionCheck = TradingSessionManager.isWithinTradingSession();
            if (!sessionCheck.inSession) {
                LOGGER.info(`🔄 [${symbol}] Recovery outside session — proceeding (Martingale Level: ${assetState.martingaleLevel})`);
            }
        }

        const assetConfig = getAssetConfig(symbol);
        const candleType = CandleAnalyzer.getCandleDirection(closedCandle);
        const direction = candleType === 'BULLISH' ? 'CALLE' : 'PUTE';

        LOGGER.trade(`⚡ [${symbol}] IMMEDIATE RECOVERY TRADE`);
        LOGGER.trade(`  Direction: ${direction === 'CALLE' ? 'RISE' : 'FALL'} | Stake: $${stake.toFixed(2)} | Martingale Level: ${assetState.martingaleLevel}`);

        TelegramService.sendMessage(
            `⚡ <b>kRISE/FALL2b IMMEDIATE RECOVERY</b>\n` +
            `[${symbol}] Martingale Level: ${assetState.martingaleLevel}\n` +
            `Direction: ${direction === 'CALLE' ? 'RISE ↑' : 'FALL ↓'}\n` +
            `Stake: $${stake.toFixed(2)} | Capital: $${state.capital.toFixed(2)}\n` +
            `Asset P/L: $${assetState.netPL.toFixed(2)}`
        );

        const position = {
            symbol, direction, stake,
            duration: assetConfig.DURATION,
            durationUnit: assetConfig.DURATION_UNIT,
            entryTime: Date.now(),
            contractId: null, reqId: null,
            currentProfit: 0, buyPrice: 0
        };

        assetState.activePositions.push(position);
        assetState.canTrade = false;
        state.lastTradeDirection = direction;

        const tradeRequest = {
            buy: 1, subscribe: 1,
            price: stake.toFixed(2),
            parameters: {
                contract_type: direction,
                symbol, currency: 'USD',
                amount: stake.toFixed(2),
                duration: assetConfig.DURATION,
                duration_unit: assetConfig.DURATION_UNIT,
                basis: 'stake'
            }
        };

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;
        LOGGER.trade(`✅ [${symbol}] Recovery trade sent (reqId: ${reqId})`);
    }

    // ── NORMAL TRADE EXECUTION ────────────────────────────────────
    executeNextTrade(symbol, lastClosedCandle) {
        const assetState = state.assets[symbol];
        if (!assetState) return;
        if (!assetState.canTrade) return;
        if (!SessionManager.isSessionActive()) return;

        // Gate: assetMaxStreak must be ready
        if (!state.isMaxStreakReady) {
            LOGGER.debug(`[${symbol}] Trade skipped — maxStreak not ready`);
            return;
        }

        const assetMaxStreak = assetMaxStreakManager.getMaxStreak(symbol);
        if (assetMaxStreak === null) {
            LOGGER.warn(`[${symbol}] Trade skipped — assetMaxStreak not available`);
            return;
        }

        const assetConfig = getAssetConfig(symbol);

        if (state.activeTradeAsset && state.activeTradeAsset !== symbol) {
            LOGGER.debug(`  [${symbol}] Skipped — [${state.activeTradeAsset}] is already active`);
            return;
        }
        if (assetState.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) {
            LOGGER.debug(`${symbol} Max positions reached (${assetState.activePositions.length}/${CONFIG.MAX_OPEN_POSITIONS_PER_ASSET})`);
            return;
        }

        // Skip if in martingale recovery
        // if (assetState.lastTradeWasWin === false && assetState.martingaleLevel > 0) {
        //     LOGGER.debug(`  [${symbol}] Normal signal skipped — in recovery (mart=${assetState.martingaleLevel}), handled by immediate recovery path`);
        //     return;
        // }

        // Session window check
        let sessionCheck = { inSession: true, sessionName: '24/7', nextSession: null, minutesUntilNext: 0 };
        if (CONFIG.USE_TRADING_SESSIONS) {
            sessionCheck = TradingSessionManager.isWithinTradingSession();
            if (!sessionCheck.inSession) {
                const now = Date.now();
                if (now - state.lastSessionLogTime > 300000) {
                    LOGGER.info(`⏰ OUTSIDE TRADING SESSION — ${TradingSessionManager.getSessionStatusString()} | Skipping new pattern signals`);
                    state.lastSessionLogTime = now;
                }
                state.activeTradeAsset = null;
                return;
            }
        }

        const stake = assetState.currentStake;
        if (state.capital < stake) {
            LOGGER.error(`[${symbol}] Insufficient capital: $${state.capital.toFixed(2)} (Needed: $${stake.toFixed(2)})`);
            if (assetState.martingaleLevel > 0) { assetState.martingaleLevel = 0; assetState.currentStake = CONFIG.STAKE; }
            return;
        }

        // ── CORE STRATEGY: Autocorrelation signal ─────────────────
        const regime = AlternatingRegimeDetector.analyze(assetState.closedCandles);

        LOGGER.info(
            `  [${symbol}] Autocorrelation Check: ${regime.autocorrelation.toFixed(4)} ` +
            `(threshold: ${CONFIG.AUTOCORR_THRESHOLD}) | AssetMaxStreak: ${assetMaxStreak} | Candles: ${assetState.closedCandles.length}`
        );

        let direction = null;
        let signalReason = '';

        if (regime.autocorrelation < CONFIG.AUTOCORR_THRESHOLD && regime.autocorrelation > CONFIG.AUTOCORR_THRESHOLD2) {
            const candleType = CandleAnalyzer.getCandleDirection(lastClosedCandle);
            if (candleType === 'BULLISH') {
                direction = 'CALLE';
                signalReason = `Filtered Pattern Trade: (${symbol})`;
            } else if (candleType === 'BEARISH') {
                direction = 'PUTE';
                signalReason = `Filtered Pattern Trade: (${symbol})`;
            } else {
                LOGGER.info(`  [${symbol}] DOJI candle — no trade despite autocorr signal`);
            }

            if (direction) {
                LOGGER.trade(`🔄 [${symbol}] NORMAL MODE Trade: ${signalReason}`);
                LOGGER.trade(`  [${symbol}] autocorrelation=${regime.autocorrelation.toFixed(4)} < threshold=${CONFIG.AUTOCORR_THRESHOLD} | assetMaxStreak=${assetMaxStreak}`);
                if (!state.activeTradeAsset) {
                    state.activeTradeAsset = symbol;
                    ACTIVE_ASSETS = [symbol];
                    LOGGER.info(`🔒 [${symbol}] Asset locked as active trade asset`);
                }
            }
        } else {
            LOGGER.trade(
                `🔄 [${symbol}] NORMAL MODE No Trade: ` +
                `autocorrelation=${regime.autocorrelation.toFixed(4)} >= threshold=${CONFIG.AUTOCORR_THRESHOLD}`
            );
        }

        StatePersistence.saveState();
        if (!direction) return;

        // ── Execute normal trade ──────────────────────────────────────
        assetState.canTrade = false;
        assetState.lastTradeDirection = direction;

        const sessionLabel = CONFIG.USE_TRADING_SESSIONS
            ? (sessionCheck.inSession ? `[${sessionCheck.sessionName}]` : `[RECOVERY - Outside Session]`)
            : '[24/7]';

        LOGGER.trade(`🎯 ${sessionLabel} [${symbol}] Executing ${direction === 'CALLE' ? 'RISE' : 'FALL'} trade`);
        LOGGER.trade(`  [${symbol}] Stake: $${stake.toFixed(2)} | Duration: ${assetConfig.DURATION} ${assetConfig.DURATION_UNIT} | Martingale Level: ${assetState.martingaleLevel}`);
        LOGGER.trade(`  [${symbol}] Reason: ${signalReason}`);

        const position = {
            symbol, direction, stake,
            duration: assetConfig.DURATION,
            durationUnit: assetConfig.DURATION_UNIT,
            entryTime: Date.now(),
            contractId: null, reqId: null,
            currentProfit: 0, buyPrice: 0
        };

        assetState.activePositions.push(position);

        const tradeRequest = {
            buy: 1, subscribe: 1,
            price: stake.toFixed(2),
            parameters: {
                contract_type: direction,
                symbol, currency: 'USD',
                amount: stake.toFixed(2),
                duration: assetConfig.DURATION,
                duration_unit: assetConfig.DURATION_UNIT,
                basis: 'stake'
            }
        };

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;
    }

    _safelyCompleteContract(contractId, symbol, profit, position) {
        try {
            // Clear watchdog FIRST - critical!
            this._clearAllWatchdogTimers();

            // Mark as processed
            this._processedContracts.add(String(contractId));

            // Record result
            if (symbol && typeof profit === 'number') {
                SessionManager.recordTradeResult(symbol, profit, position.direction);

                TelegramService.sendTradeAlert(
                    profit >= 0 ? 'WIN' : 'LOSS',
                    symbol, position.direction,
                    position.stake, position.duration, position.durationUnit,
                    { profit }
                );
            }

            // Remove position
            const assetState = state.assets[symbol];
            if (assetState && assetState.activePositions) {
                const posIndex = assetState.activePositions.findIndex(
                    p => p.contractId === contractId
                );
                if (posIndex >= 0) {
                    assetState.activePositions.splice(posIndex, 1);
                }
            }

            // Release lock
            state.tradeInProgress = false;
            state.currentContractId = null;
            state.tradeStartTime = null;
            state.pendingTradeInfo = null;

            LOGGER.info(`✅ Contract ${contractId} safely completed`);

        } catch (error) {
            LOGGER.error(`❌ Error in _safelyCompleteContract: ${error.message}`);
            // Force release lock even on error
            this._forceReleaseTradeLock();
        }
    }

    _forceReleaseTradeLock() {
        try {
            this._clearAllWatchdogTimers();
            state.tradeInProgress = false;
            state.currentContractId = null;
            state.tradeStartTime = null;
            state.pendingTradeInfo = null;
            LOGGER.warn('⚠️ Trade lock force-released');
        } catch (error) {
            LOGGER.error(`Error releasing lock: ${error.message}`);
        }
    }

    // ============================================
    // TRADE WATCHDOG MANAGER
    // ============================================

    _startTradeWatchdog(contractId) {
        const timeoutMs = this.tradeWatchdogMs;

        state.tradeWatchdogTimer = setTimeout(() => {
            if (!state.tradeInProgress) {
                LOGGER.debug('Watchdog fired but trade already completed');
                return;
            }

            LOGGER.warn(
                `⏰ WATCHDOG FIRED — Contract ${contractId} has been open for ` +
                `${(timeoutMs / 1000)}s with no settlement`
            );

            // Step 1: try to poll the contract
            if (contractId && state.isConnected && state.isAuthorized) {
                LOGGER.info(`🔍 Polling contract ${contractId} for current status…`);

                // Unsubscribe from old subscription if exists
                this.connection.send({
                    forget_all: 'proposal_open_contract'
                });

                // Subscribe fresh
                this.connection.send({
                    proposal_open_contract: 1,
                    contract_id: contractId,
                    subscribe: 1
                });

                // Give the poll 15 seconds before force recovery
                state.tradeWatchdogPollTimer = setTimeout(() => {
                    if (!state.tradeInProgress) {
                        LOGGER.debug('Poll timer fired but trade already completed');
                        return;
                    }
                    LOGGER.error(
                        `🚨 WATCHDOG: Poll timed out — contract ${contractId} still unresolved ` +
                        `after ${(timeoutMs / 1000)}s — force-releasing lock`
                    );
                    this._recoverStuckTrade('watchdog-force');
                }, 15000);

            } else {
                LOGGER.error('Cannot poll contract - not connected or authorized');
                this._recoverStuckTrade('watchdog-offline');
            }
        }, timeoutMs);

        LOGGER.debug(`Watchdog started for contract ${contractId} (${timeoutMs}ms)`);
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

    // ============================================
    // RECOVER FROM STUCK TRADE
    // ============================================

    _recoverStuckTrade(reason) {
        LOGGER.warn(`🔄 Entering recovery mode: ${reason}`);

        this._clearAllWatchdogTimers();

        const contractId = state.currentContractId;
        const stakeInfo = state.pendingTradeInfo;
        const openSeconds = state.tradeStartTime ? Math.round((Date.now() - state.tradeStartTime) / 1000) : '?';

        LOGGER.error(
            `🚨 STUCK TRADE RECOVERY [${reason}] | Contract: ${contractId} | ` +
            `Open for: ${openSeconds}s`
        );

        // Mark contract as processed to prevent duplicate handling
        if (contractId) {
            this._processedContracts.add(String(contractId));
        }

        // Remove the stuck position from activePositions
        ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset && asset.activePositions) {
                const posIndex = asset.activePositions.findIndex(p => p.contractId === contractId);
                if (posIndex >= 0) {
                    asset.activePositions.splice(posIndex, 1);
                    LOGGER.info(`Removed stuck position from ${symbol} activePositions`);
                }
            }
        });

        // Release the lock
        state.tradeInProgress = false;
        state.pendingTradeInfo = null;
        state.currentContractId = null;
        state.tradeStartTime = null;
        state.activeTradeAsset = null;
        ACTIVE_ASSETS = [...CONFIG.ACTIVE_ASSETS];

        LOGGER.warn(`🔄 Trade lock released. Bot will continue trading on next candle…`);

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
        
        // Disable trading for all assets
        ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset) asset.canTrade = false;
        });
        
        // ✅ Clear all timers
        TelegramService.clearTimers();
        
        // ✅ Clear status display interval
        if (this.statusDisplayIntervalId) {
            clearInterval(this.statusDisplayIntervalId);
            this.statusDisplayIntervalId = null;
            LOGGER.info('🧹 Status display interval cleared');
        }
        
        // ✅ Clear session time checker interval
        if (this.sessionTimeCheckerId) {
            clearInterval(this.sessionTimeCheckerId);
            this.sessionTimeCheckerId = null;
            LOGGER.info('🧹 Session time checker cleared');
        }
        
        // ✅ Clear processed contracts cleanup interval
        if (this.contractCleanupIntervalId) {
            clearInterval(this.contractCleanupIntervalId);
            this.contractCleanupIntervalId = null;
            LOGGER.info('🧹 Contract cleanup interval cleared');
        }
        
        // Save state
        StatePersistence.saveState();
        TradeHistoryManager.saveHistory();
        
        // Close connection with cleanup
        setTimeout(() => {
            if (this.connection) {
                this.connection.cleanup();
            }
            LOGGER.info('👋 Bot stopped cleanly');
        }, 2000);
    }

    startSessionTimeChecker() {
        if (this.timeCheckStarted) return;
        this.timeCheckStarted = true;
        
        // ✅ Store interval ID for cleanup
        this.sessionTimeCheckerId = setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + 1 * 60 * 60 * 1000);
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            SessionManager.checkDayChange();

            if (!state.session.isActive && currentHours === CONFIG.TOKYO_START && currentMinutes >= 0) {
                LOGGER.info("It's TOKYO start time GMT+1, reconnecting the bot.");
                state.session.isActive = true;
                this.connection.connect();
            }

            if (state.session.isActive) {
                const allAssetsRecovered = ACTIVE_ASSETS.every(symbol => {
                    const asset = state.assets[symbol];
                    return asset && asset.martingaleLevel === 0;
                });
                const anyAssetTradedWin = ACTIVE_ASSETS.some(symbol => {
                    const asset = state.assets[symbol];
                    return asset && asset.lastTradeWasWin === true;
                });

                if (allAssetsRecovered && anyAssetTradedWin && currentHours >= CONFIG.SYDNEY_END && currentMinutes >= 0) {
                    LOGGER.info(`It's past ${CONFIG.SYDNEY_END}:00 GMT+1, all assets recovered, disconnecting.`);
                    TelegramService.sendDayEndSummary(TradeHistoryManager.getDateKey());
                    TelegramService.sendSessionSummary();
                    state.activeTradeAsset = null;
                    if (this.connection.ws) this.connection.ws.close();
                    state.session.isActive = false;
                }
            }
        }, 20000);
    }

    getStatus() {
        const sessionStats = SessionManager.getSessionStats();
        const tradingSession = TradingSessionManager.getSessionStatusString();
        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();
        const assetStatuses = {};

        ACTIVE_ASSETS.forEach(symbol => {
            const a = state.assets[symbol];
            const ac = getAssetConfig(symbol);
            if (a) {
                const regime = AlternatingRegimeDetector.analyze(a.closedCandles);
                const assetMaxStreak = assetMaxStreakManager ? assetMaxStreakManager.getMaxStreak(symbol) : null;
                const lastClosed = a.closedCandles && a.closedCandles.length ? a.closedCandles[a.closedCandles.length - 1] : null;
                const lastCandleDirection = lastClosed ? CandleAnalyzer.getCandleDirection(lastClosed) : null;
                assetStatuses[symbol] = {
                    martingaleLevel: a.martingaleLevel,
                    currentStake: a.currentStake,
                    lastDirection: a.lastTradeDirection,
                    lastWasWin: a.lastTradeWasWin,
                    activePositions: a.activePositions.length,
                    trades: a.tradesCount, wins: a.winsCount, losses: a.lossesCount,
                    netPL: a.netPL,
                    lastCandleDirection,
                    autocorrelation: regime.autocorrelation,
                    assetMaxStreak,
                    threshold: CONFIG.AUTOCORR_THRESHOLD,
                    timeframe: ac.TIMEFRAME_LABEL,
                    duration: `${ac.DURATION}${ac.DURATION_UNIT}`
                };
            }
        });

        let totalActivePositions = 0;
        ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) totalActivePositions += a.activePositions.length;
        });

        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            isMaxStreakReady: state.isMaxStreakReady,
            capital: state.capital,
            accountBalance: state.accountBalance,
            session: sessionStats,
            tradingSession,
            totalActivePositions,
            assets: assetStatuses,
            overall,
            today
        };
    }
}

// ============================================
// INITIALIZATION
// ============================================
tradeHistory = TradeHistoryManager.loadHistory();

// Instantiate after LOGGER is ready
assetMaxStreakManager = new AssetMaxStreakManager();

const bot = new DerivBot();

process.on('SIGINT', () => {
    console.log('\n\n⚠️ Shutdown signal received...');
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});
process.on('SIGTERM', () => { bot.stop(); setTimeout(() => process.exit(0), 3000); });

const stateLoaded = StatePersistence.loadState();
if (stateLoaded) LOGGER.info('🔄 Bot will resume from saved state after connection');
else LOGGER.info('🆕 Bot will start with fresh state');

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('⚠️ API Token not configured! Set CONFIG.API_TOKEN');
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(' DERIV RISE/FALL CANDLE PATTERN BOT (Per-Asset Independent)');
console.log(` ⚡ Immediate Recovery Mode ENABLED — delay: ${CONFIG.RECOVERY_TRADE_DELAY_MS}ms`);
console.log(` 📊 MaxStreak Mode: 50,000 candles per asset (10 × 5,000 API batches)`);
console.log('═'.repeat(80));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

// Status display every 30 seconds
// ✅ Store interval ID for proper cleanup
let statusDisplayIntervalId = setInterval(() => {
    if (state.isAuthorized) {
        const status = bot.getStatus();
        const s = state.session;
        const overall = status.overall;

        let assetLines = '';
        ACTIVE_ASSETS.forEach(sym => {
            const a = status.assets[sym];
            if (a) {
                const dir = a.lastDirection ? (a.lastDirection === 'CALLE' ? 'R' : 'F') : '-';
                const winLoss = a.lastWasWin === null ? '-' : a.lastWasWin ? 'W' : 'L';
                const signal = a.autocorrelation < CONFIG.AUTOCORR_THRESHOLD ? '✅SIGNAL' : '❌NO SIG';
                assetLines += `\n  ${sym} (${a.timeframe}/${a.duration}): M${a.martingaleLevel} $${a.currentStake.toFixed(2)} | ${a.trades}t ${a.wins}W/${a.losses}L | P/L:$${a.netPL.toFixed(2)} | Last:${dir}(${winLoss}) | Pos:${a.activePositions} | AutoCorr:${a.autocorrelation.toFixed(4)} ${signal} | MaxStreak:${a.assetMaxStreak}`;
            }
        });

        // Safety check: if trade has been in progress for > 2 minutes, force recovery
        if (state.tradeInProgress && state.tradeStartTime) {
            const elapsed = Date.now() - state.tradeStartTime;
            if (elapsed > 120000) { // 2 minutes
                LOGGER.error(`🚨 SAFETY: Trade stuck for ${Math.round(elapsed / 1000)}s - forcing recovery`);
                bot._recoverStuckTrade('safety-timeout');
            }
        }

        console.log(`\n📊 ${getGMTTime()} | Today: ${status.session.trades} trades | ${status.session.winRate} | $${status.session.netPL.toFixed(2)} | ${status.totalActivePositions} active | MaxStreakReady:${status.isMaxStreakReady}`);
        console.log(`📋 Overall: ${overall.tradesCount} trades | ${overall.winsCount}W/${overall.lossesCount}L | P/L: $${overall.netPL.toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
        console.log(`📉 Today Loss Stats: x2:${s.x2Losses} x3:${s.x3Losses} x4:${s.x4Losses} x5:${s.x5Losses} x6:${s.x6Losses} x7:${s.x7Losses} x8:${s.x8Losses} x9:${s.x9Losses}`);
        console.log(`🔧 Per-Asset Status:${assetLines}`);
        console.log(`  ${status.tradingSession}`);
    }
}, 30000);

// ✅ Export for cleanup in stop() method
if (typeof bot !== 'undefined') {
    bot.statusDisplayIntervalId = statusDisplayIntervalId;
}

