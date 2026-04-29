const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// FILE PATHS & CONSTANTS
// ============================================
const STATE_FILE = path.join(__dirname, 'KriseFallM_2b_112-state.json');
const HISTORY_FILE = path.join(__dirname, 'KriseFallM_2b_112-history.json');
const MAXSTREAK_FILE = path.join(__dirname, 'KriseFallM_2b_112-maxstreak.json');
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
 *   - Repeat up to 10 times  (10 × 5,000 = 50,000)
 *   - Process streak inline; never hold more than one batch at a time
 *   - After all batches, trim closedCandles back to 50 before trading
 */
class AssetMaxStreakManager {
    constructor() {
        this.data = this._load();
        this._updateIntervalMs = 1 * 24 * 60 * 60 * 1000; // 30 days
        this._refreshTimer = null;
    }

    // ── Persistence ──────────────────────────────────────────────
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

    // ── Public API ────────────────────────────────────────────────
    getMaxStreak(symbol) { return this.data.assets[symbol]?.maxStreak ?? null; }
    isReady(symbol) { return typeof this.data.assets[symbol]?.maxStreak === 'number'; }
    allReady() { return CONFIG.ACTIVE_ASSETS.every(s => this.isReady(s)); }
    needsRefresh() {
        if (!this.data.lastUpdated) return true;
        return (Date.now() - this.data.lastUpdated) >= this._updateIntervalMs;
    }

    // ── Core: fetch 50 k candles for ONE asset sequentially ───────
    fetchMaxStreakForAsset(symbol, connection) {
        return new Promise((resolve, reject) => {
            const assetConfig = getAssetConfig(symbol);
            const BATCH_SIZE = 1440;
            const MAX_BATCHES = 1;          // 10 × 5 000 = 50 000

            let batchesDone = 0;
            let endEpoch = 'latest'; // first call uses 'latest'
            let overallMaxStreak = 1;
            let crossBatchLastDir = null;     // direction of last candle in previous batch

            LOGGER.info(`📡 [${symbol}] Starting 50k-candle maxStreak fetch…`);

            const fetchBatch = () => {
                if (batchesDone >= MAX_BATCHES) {
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

                // One-shot listener — waits for THIS specific candles response
                const onMessage = (data) => {
                    let response;
                    try { response = JSON.parse(data); } catch { return; }
                    if (response.msg_type !== 'candles') return;
                    if (response.echo_req?.ticks_history !== symbol) return;

                    connection.ws.removeListener('message', onMessage);

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

                    // Process streak inline — oldest candle first (API returns oldest → newest)
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

                    // Save last candle direction for cross-batch continuity
                    const lastC = candles[candles.length - 1];
                    crossBatchLastDir = lastC.close > lastC.open ? 1 : 0;

                    // Next batch ends just before the oldest candle in this batch
                    endEpoch = candles[0].epoch - 1;
                    batchesDone++;

                    if (candles.length < BATCH_SIZE) {
                        LOGGER.info(`✅ [${symbol}] maxStreak (history exhausted at batch ${batchesDone}): ${overallMaxStreak}`);
                        resolve(overallMaxStreak);
                        return;
                    }

                    setTimeout(fetchBatch, 300); // small delay between batches
                };

                connection.ws.on('message', onMessage);

                const reqId = state.requestId++;
                reqPayload.req_id = reqId;
                connection.ws.send(JSON.stringify(reqPayload));
            };

            fetchBatch();
        });
    }

    // ── Compute maxStreak for ALL assets sequentially ─────────────
    async computeAllMaxStreaks(connection) {
        LOGGER.info('🔄 Starting sequential maxStreak computation for all assets…');
        await TelegramService.sendMessage(
            '🔄 <b>MaxStreak Update Started</b>\n' +
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
                this.data.assets[symbol] = { maxStreak, computedAt: Date.now() };
                this._save();
                LOGGER.info(`✅ [${symbol}] assetMaxStreak = ${maxStreak}`);

                // Trim closedCandles back to 50
                const assetState = state.assets[symbol];
                if (assetState && assetState.closedCandles.length > 50) {
                    assetState.closedCandles = assetState.closedCandles.slice(-50);
                    LOGGER.info(`✂️ [${symbol}] closedCandles trimmed to ${assetState.closedCandles.length}`);
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

        const summary = CONFIG.ACTIVE_ASSETS
            .map(s => `  ${s}: maxStreak=${this.data.assets[s]?.maxStreak ?? 'N/A'}`)
            .join('\n');

        LOGGER.info('✅ All asset maxStreaks computed. Trading resuming.');
        await TelegramService.sendMessage(
            '✅ <b>MaxStreak Update Complete</b>\n' + summary + '\nTrading has RESUMED.'
        );
    }

    // ── Monthly refresh scheduler ─────────────────────────────────
    scheduleMonthlyRefresh(connection) {
        if (this._refreshTimer) clearTimeout(this._refreshTimer);

        const msUntilRefresh = this.data.lastUpdated
            ? Math.max(0, this._updateIntervalMs - (Date.now() - this.data.lastUpdated))
            : 0;

        LOGGER.info(`🗓️ Next assetMaxStreak refresh in ${(msUntilRefresh / 3600000).toFixed(1)} hours`);

        this._refreshTimer = setTimeout(async () => {
            LOGGER.info('🗓️ Monthly maxStreak refresh triggered — pausing trading…');
            CONFIG.ACTIVE_ASSETS.forEach(symbol => {
                if (state.assets[symbol]) state.assets[symbol].canTrade = false;
            });

            await this.computeAllMaxStreaks(connection);

            CONFIG.ACTIVE_ASSETS.forEach(symbol => bot.subscribeToCandles(symbol));
            this.scheduleMonthlyRefresh(connection);
        }, msUntilRefresh);
    }
}

// ============================================
// TRADE HISTORY MANAGER
// ============================================
class TradeHistoryManager {
    static getDateKey() { return new Date().toISOString().split('T')[0]; }

    static loadHistory() {
        try {
            if (!fs.existsSync(HISTORY_FILE)) {
                LOGGER.info('📁 No trade history file found, starting fresh history');
                return this._emptyHistory();
            }
            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            if (!data.dailyHistory) data.dailyHistory = {};
            if (!data.overallAssets) data.overallAssets = {};
            if (!data.overall) data.overall = this._emptyOverall();
            LOGGER.info(`📁 Trade history loaded — ${Object.keys(data.dailyHistory).length} days of history`);
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
        return { overall: this._emptyOverall(), overallAssets: {}, dailyHistory: {}, lastUpdated: Date.now() };
    }

    static saveHistory() {
        try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2)); }
        catch (error) { LOGGER.error(`Failed to save trade history: ${error.message}`); }
    }

    static ensureDayEntry(dateKey) {
        if (!tradeHistory.dailyHistory[dateKey]) {
            tradeHistory.dailyHistory[dateKey] = {
                date: dateKey,
                tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0,
                x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0,
                x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0,
                assets: {}, startCapital: state.capital, endCapital: state.capital
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
        const dayAsset = dayStats.assets[symbol];
        const overall = tradeHistory.overall;
        const overallAsset = tradeHistory.overallAssets[symbol];

        [dayStats, dayAsset, overall, overallAsset].forEach(o => o.tradesCount++);
        if (!overall.firstTradeDate) overall.firstTradeDate = dateKey;
        overall.lastTradeDate = dateKey;

        if (profit > 0) {
            [dayStats, dayAsset, overall, overallAsset].forEach(o => {
                o.winsCount++; o.profit += profit; o.netPL += profit;
            });
        } else {
            [dayStats, dayAsset, overall, overallAsset].forEach(o => {
                o.lossesCount++; o.loss += Math.abs(profit); o.netPL += profit;
            });
            const lvl = martingaleLevel;
            if (lvl >= 2 && lvl <= 9) {
                const key = `x${lvl}Losses`;
                [dayStats, dayAsset, overall, overallAsset].forEach(o => o[key]++);
            }
        }

        dayStats.endCapital = state.capital;
        tradeHistory.lastUpdated = Date.now();
        this.saveHistory();
    }

    static getTodayStats() { const dk = this.getDateKey(); this.ensureDayEntry(dk); return tradeHistory.dailyHistory[dk]; }
    static getOverallStats() { return tradeHistory.overall; }
    static getDayStats(dateKey) { return tradeHistory.dailyHistory[dateKey] || null; }
    static getAllDays() { return Object.keys(tradeHistory.dailyHistory).sort(); }
    static getRecentDays(n = 7) {
        const days = this.getAllDays();
        return days.slice(-n).map(dk => ({ date: dk, ...tradeHistory.dailyHistory[dk] }));
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
                portfolio: { ...state.portfolio },
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
                    tradesCount: asset.tradesCount,
                    winsCount: asset.winsCount,
                    lossesCount: asset.lossesCount,
                    profit: asset.profit,
                    loss: asset.loss,
                    netPL: asset.netPL,
                    x2Losses: asset.x2Losses, x3Losses: asset.x3Losses,
                    x4Losses: asset.x4Losses, x5Losses: asset.x5Losses,
                    x6Losses: asset.x6Losses, x7Losses: asset.x7Losses,
                    x8Losses: asset.x8Losses, x9Losses: asset.x9Losses,
                    activePositions: asset.activePositions.map(pos => ({
                        symbol: pos.symbol,
                        direction: pos.direction,
                        stake: pos.stake,
                        duration: pos.duration,
                        durationUnit: pos.durationUnit,
                        entryTime: pos.entryTime,
                        contractId: pos.contractId,
                        reqId: pos.reqId,
                        buyPrice: pos.buyPrice,
                        currentProfit: pos.currentProfit
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
            if (!fs.existsSync(STATE_FILE)) { LOGGER.info('📁 No previous state file found, starting fresh'); return false; }

            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            if (ageMinutes > 30) {
                LOGGER.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            LOGGER.info(`📁 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);

            state.capital = savedData.capital;
            state.session = { ...state.session, ...savedData.session, startTime: savedData.session.startTime || Date.now(), startCapital: savedData.session.startCapital || savedData.capital };
            state.portfolio = { ...savedData.portfolio };
            state.currentTradeDay = savedData.currentTradeDay || TradeHistoryManager.getDateKey();
            state.hourlyStats = savedData.hourlyStats || { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };

            if (savedData.assets) {
                Object.keys(savedData.assets).forEach(symbol => {
                    if (!state.assets[symbol]) return;
                    const saved = savedData.assets[symbol];
                    const asset = state.assets[symbol];

                    if (saved.closedCandles?.length > 0) {
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
                    asset.activePositions = (saved.activePositions || []).map(pos => ({ ...pos, entryTime: pos.entryTime || Date.now() }));
                    LOGGER.info(`📊 ${symbol}: Martingale=${asset.martingaleLevel}, Stake=$${asset.currentStake.toFixed(2)}, P/L=$${asset.netPL.toFixed(2)}, Positions=${asset.activePositions.length}`);
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
        setInterval(() => { if (state.isAuthorized) this.saveState(); }, STATE_SAVE_INTERVAL);
        LOGGER.info(`💾 Auto-save enabled (every ${STATE_SAVE_INTERVAL / 1000}s)`);
    }

    static clearState() {
        try { if (fs.existsSync(STATE_FILE)) { fs.unlinkSync(STATE_FILE); LOGGER.info('🗑️ State file cleared'); } }
        catch (error) { LOGGER.error(`Failed to clear state: ${error.message}`); }
    }
}

// ============================================
// TELEGRAM SERVICE
// ============================================
class TelegramService {
    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED) return;
        try {
            if (!message || message.length === 0) { LOGGER.error('[TELEGRAM] ❌ Message is empty!'); return; }
            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const data = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
            const byteLength = Buffer.byteLength(data, 'utf8');
            const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': byteLength } };
            return new Promise((resolve, reject) => {
                const req = https.request(url, options, res => {
                    let body = '';
                    res.on('data', chunk => (body += chunk));
                    res.on('end', () => { if (res.statusCode === 200) resolve(true); else reject(new Error(`HTTP ${res.statusCode}: ${body}`)); });
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
        const assetMart = assetState ? assetState.martingaleLevel : 0;
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
Martingale Level: ${assetMart}
Autocorrelation: ${regime.autocorrelation.toFixed(4)} | AssetMaxStreak: ${assetMaxStreak}
${details.profit !== undefined
                ? `Profit: $${details.profit.toFixed(2)}

📊 <b>Today's Stats:</b>
${symbol} P&amp;L: $${assetNetPL.toFixed(2)}
${symbol} W/L: ${assetWins}/${assetLosses}
Today P&amp;L: $${(today.netPL || 0).toFixed(2)}
Today W/L: ${today.winsCount || 0}/${today.lossesCount || 0}

📋 <b>Overall Stats:</b>
Overall P&amp;L: $${(overall.netPL || 0).toFixed(2)}
Overall W/L: ${overall.winsCount || 0}/${overall.lossesCount || 0}
Total Trades: ${overall.tradesCount || 0}
Capital: $${state.capital.toFixed(2)}`
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
                `📊 <b>Overall Stats (${overall.firstTradeDate || 'N/A'} to ${overall.lastTradeDate || 'N/A'}):</b>`,
                `Total Trades: ${overall.tradesCount || 0}`,
                `Total Wins: ${overall.winsCount || 0} | Total Losses: ${overall.lossesCount || 0}`,
                `Overall Win Rate: ${overallWinRate}`,
                `Overall P/L: $${(overall.netPL || 0).toFixed(2)}`,
                `Loss Stats: x2:${overall.x2Losses || 0} | x3:${overall.x3Losses || 0} | x4:${overall.x4Losses || 0} | x5:${overall.x5Losses || 0} | x6:${overall.x6Losses || 0} | x7:${overall.x7Losses || 0} | x8:${overall.x8Losses || 0} | x9:${overall.x9Losses || 0}`, ``,
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

            const dayWinRate = dayStats.tradesCount > 0 ? ((dayStats.winsCount / dayStats.tradesCount) * 100).toFixed(1) + '%' : '0.0%';
            const overallWinRate = overall.tradesCount > 0 ? ((overall.winsCount / overall.tradesCount) * 100).toFixed(1) + '%' : '0.0%';

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
                `├ Profit: $${(dayStats.profit || 0).toFixed(2)} | Loss: $${(dayStats.loss || 0).toFixed(2)}`,
                `├ Net P/L: $${(dayStats.netPL || 0).toFixed(2)}`,
                `├ Start Capital: $${(dayStats.startCapital || 0).toFixed(2)}`,
                `└ End Capital: $${(dayStats.endCapital || 0).toFixed(2)}`, ``,
                `📋 <b>Loss Stats:</b> x2:${dayStats.x2Losses || 0} x3:${dayStats.x3Losses || 0} x4:${dayStats.x4Losses || 0} x5:${dayStats.x5Losses || 0} x6:${dayStats.x6Losses || 0} x7:${dayStats.x7Losses || 0} x8:${dayStats.x8Losses || 0} x9:${dayStats.x9Losses || 0}`, ``,
                `📋 <b>Per-Asset:</b>${assetBreakdown || '\n  No trades'}`, ``,
                `📊 <b>Overall Stats (All Time):</b>`,
                `├ Total Days: ${TradeHistoryManager.getAllDays().length}`,
                `├ Total Trades: ${overall.tradesCount || 0}`,
                `├ Total Wins: ${overall.winsCount || 0} | Total Losses: ${overall.lossesCount || 0}`,
                `├ Overall Win Rate: ${overallWinRate}`,
                `├ Overall P/L: $${(overall.netPL || 0).toFixed(2)}`,
                `└ Loss Stats: x2:${overall.x2Losses || 0} x3:${overall.x3Losses || 0} x4:${overall.x4Losses || 0} x5:${overall.x5Losses || 0} x6:${overall.x6Losses || 0} x7:${overall.x7Losses || 0} x8:${overall.x8Losses || 0} x9:${overall.x9Losses || 0}`, ``,
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
                const ms = assetMaxStreakManager ? assetMaxStreakManager.getMaxStreak(symbol) : 'Computing…';
                assetConfigInfo += `\n  ${symbol}: ${ac.TIMEFRAME_LABEL} candles, Duration: ${ac.DURATION}${ac.DURATION_UNIT}, MaxStreak: ${ms}`;
            });

            const message = [
                `🤖 <b>DERIV RISE/FALL BOT STARTED 2b</b>`,
                `Strategy: Autocorrelation &lt; -0.06 + 50k-candle AssetMaxStreak`,
                `Mode: <b>Independent Per-Asset Management</b>`,
                `Capital: $${state.capital.toFixed(2)}`,
                `Stake: $${CONFIG.STAKE}`, ``,
                `🔧 <b>Asset Configurations:</b>${assetConfigInfo}`, ``,
                `Max Positions Per Asset: ${CONFIG.MAX_OPEN_POSITIONS_PER_ASSET}`,
                `Session Target: $${CONFIG.SESSION_PROFIT_TARGET}`,
                `Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`,
                `Trading Sessions: ${CONFIG.USE_TRADING_SESSIONS ? 'ENABLED' : 'DISABLED (24/7)'}`, ``,
                `📊 <b>Historical Stats:</b>`,
                `├ Trading Days: ${totalDays}`,
                `├ Total Trades: ${overall.tradesCount || 0}`,
                `├ Overall P/L: $${(overall.netPL || 0).toFixed(2)}`,
                `└ Period: ${overall.firstTradeDate || 'N/A'} to ${overall.lastTradeDate || 'N/A'}`, ``,
                `⏰ TOKYO: ${CONFIG.TOKYO_START}:00 - ${CONFIG.TOKYO_END}:00 (GMT+1)`,
                `⏰ London: ${CONFIG.LONDON_START}:00 - ${CONFIG.LONDON_END}:00 (GMT+1)`,
                `⏰ New York: ${CONFIG.NEWYORK_START}:00 - ${CONFIG.NEWYORK_END}:00 (GMT+1)`,
                `⏰ SYDNEY: ${CONFIG.SYDNEY_START}:00 - ${CONFIG.SYDNEY_END}:00 (GMT+1)`
            ].join('\n');

            await this.sendMessage(message);
        } catch (error) {
            LOGGER.error(`[TELEGRAM] Failed to send startup message: ${error.message}`);
        }
    }

    static async sendHourlySummary() {
        try {
            const statsSnapshot = { ...state.hourlyStats };
            if (statsSnapshot.trades === 0) { LOGGER.info('📊 Telegram: Skipping hourly summary (no trades this hour)'); return; }

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
                    assetInfo += `\n  ${symbol} (${ac.TIMEFRAME_LABEL}/${ac.DURATION}${ac.DURATION_UNIT}): Mart=${a.martingaleLevel}, Stake=$${a.currentStake.toFixed(2)}, P/L=$${a.netPL.toFixed(2)}, MaxStreak=${ms}, AutoCorr=${regime.autocorrelation.toFixed(4)}`;
                }
            });

            const message = [
                `⏰ <b>Rise/Fall Bot Hourly Summary 2b</b>`, ``,
                `📊 <b>Last Hour</b>`,
                `├ Trades: ${statsSnapshot.trades}`,
                `├ Wins: ${statsSnapshot.wins} | Losses: ${statsSnapshot.losses}`,
                `├ Win Rate: ${winRate}%`,
                `└ ${pnlEmoji} <b>P&amp;L:</b> ${pnlStr}`, ``,
                `🗓️ <b>Today (${TradeHistoryManager.getDateKey()})</b>`,
                `├ Total Trades: ${today.tradesCount || 0}`,
                `├ Total W/L: ${today.winsCount || 0}/${today.lossesCount || 0}`,
                `└ Today P&amp;L: ${(today.netPL || 0) >= 0 ? '+' : ''}$${(today.netPL || 0).toFixed(2)}`, ``,
                `📋 <b>Overall (All Time)</b>`,
                `├ Total Trades: ${overall.tradesCount || 0}`,
                `├ Total W/L: ${overall.winsCount || 0}/${overall.lossesCount || 0}`,
                `├ x2-x9 Losses: ${overall.x2Losses || 0}/${overall.x3Losses || 0}/${overall.x4Losses || 0}/${overall.x5Losses || 0}/${overall.x6Losses || 0}/${overall.x7Losses || 0}/${overall.x8Losses || 0}/${overall.x9Losses || 0}`,
                `└ Overall P&amp;L: ${(overall.netPL || 0) >= 0 ? '+' : ''}$${(overall.netPL || 0).toFixed(2)}`, ``,
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
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const timeUntilNextHour = nextHour.getTime() - now.getTime();
        LOGGER.info(`⏰ Hourly Telegram timer started (first summary in ${Math.ceil(timeUntilNextHour / 60000)} min)`);
        const self = this;
        setTimeout(() => { self.sendHourlySummary(); setInterval(() => self.sendHourlySummary(), 60 * 60 * 1000); }, timeUntilNextHour);
    }

    static startDailyTimer() {
        const now = new Date();
        const nextDay = new Date(now);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(0, 0, 0, 0);
        const timeUntilNextDay = nextDay.getTime() - now.getTime();
        LOGGER.info(`🗓️ Daily Telegram timer started (first summary in ${Math.ceil(timeUntilNextDay / 60000 / 60)} hours)`);
        setTimeout(() => {
            if (typeof SessionManager !== 'undefined') SessionManager.checkDayChange();
            setInterval(() => {
                if (typeof SessionManager !== 'undefined') SessionManager.checkDayChange();
            }, 24 * 60 * 60 * 1000);
        }, timeUntilNextDay);
    }
}

// ============================================
// LOGGER UTILITY
// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';
const LOGGER = {
    info: msg => console.log(`[INFO]  ${getGMTTime()} - ${msg}`),
    trade: msg => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: msg => console.warn(`\x1b[33m[WARN]  ${getGMTTime()} - ${msg}\x1b[0m`),
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
    API_TOKEN: 'DMylfkyce6VyZt7',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',
    INITIAL_CAPITAL: 250,
    STAKE: 0.35,
    SESSION_PROFIT_TARGET: 500000,
    SESSION_STOP_LOSS: -5000,
    GRANULARITY: 60,
    TIMEFRAME_LABEL: '1m',

    // ── After assetMaxStreak is computed we only keep 50 live candles ──
    MAX_CANDLES_STORED: 60,
    CANDLES_TO_LOAD: 60,

    // ── Autocorrelation trade threshold ──────────────────────────
    // Trade fires when autocorrelation < AUTOCORR_THRESHOLD
    AUTOCORR_THRESHOLD: -0.70,
    AUTOCORR_THRESHOLD2: -0.99,

    DURATION: 58,
    DURATION_UNIT: 's',

    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    TRADE_DELAY: 1000,
    MARTINGALE_MULTIPLIER: 1.48,
    MARTINGALE_MULTIPLIER2: 1.8,
    MARTINGALE_MULTIPLIER3: 2.1,
    MAX_MARTINGALE_STEPS: 9,

    USE_TRADING_SESSIONS: true,
    TOKYO_START: 3,
    TOKYO_END: 8,
    LONDON_START: 8,
    LONDON_END: 12,
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
    const ov = ASSET_CONFIGS[symbol] || {};
    return {
        GRANULARITY: ov.GRANULARITY !== undefined ? ov.GRANULARITY : CONFIG.GRANULARITY,
        TIMEFRAME_LABEL: ov.TIMEFRAME_LABEL !== undefined ? ov.TIMEFRAME_LABEL : CONFIG.TIMEFRAME_LABEL,
        MAX_CANDLES_STORED: ov.MAX_CANDLES_STORED !== undefined ? ov.MAX_CANDLES_STORED : CONFIG.MAX_CANDLES_STORED,
        CANDLES_TO_LOAD: ov.CANDLES_TO_LOAD !== undefined ? ov.CANDLES_TO_LOAD : CONFIG.CANDLES_TO_LOAD,
        DURATION: ov.DURATION !== undefined ? ov.DURATION : CONFIG.DURATION,
        DURATION_UNIT: ov.DURATION_UNIT !== undefined ? ov.DURATION_UNIT : CONFIG.DURATION_UNIT
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
    isMaxStreakReady: false,   // gates trading until assetMaxStreaks are computed
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
    portfolio: { dailyProfit: 0, dailyLoss: 0, dailyWins: 0, dailyLosses: 0 },
    hourlyStats: { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() },
    requestId: 1,
    lastSessionLogTime: 0
};

let tradeHistory = null;
let assetMaxStreakManager = null;  // instantiated after LOGGER is ready

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
        if (!Array.isArray(candleHistory) || candleHistory.length < 4) {
            return { autocorrelation: 0 };
        }

        const seq = candleHistory.map(c => (c.close > c.open ? 1 : 0));
        const autocorrelation = this._autocorrelation(seq);

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
        return new Date(new Date().getTime() + 3600000);
    }

    static isWithinTradingSession() {
        const gmtPlus1 = this.getGMTPlus1Time();
        const currentHour = gmtPlus1.getUTCHours();
        const currentMinute = gmtPlus1.getUTCMinutes();
        const currentTimeDec = currentHour + currentMinute / 60;

        if (currentTimeDec >= CONFIG.TOKYO_START && currentTimeDec < CONFIG.TOKYO_END) return { inSession: true, sessionName: 'TOKYO', nextSession: null, minutesUntilNext: 0 };
        if (currentTimeDec >= CONFIG.LONDON_START && currentTimeDec < CONFIG.LONDON_END) return { inSession: true, sessionName: 'LONDON', nextSession: null, minutesUntilNext: 0 };
        if (currentTimeDec >= CONFIG.NEWYORK_START && currentTimeDec < CONFIG.NEWYORK_END) return { inSession: true, sessionName: 'NEW YORK', nextSession: null, minutesUntilNext: 0 };

        if (CONFIG.SYDNEY_END < CONFIG.SYDNEY_START) {
            if (currentTimeDec >= CONFIG.SYDNEY_START || currentTimeDec < CONFIG.SYDNEY_END) return { inSession: true, sessionName: 'SYDNEY', nextSession: null, minutesUntilNext: 0 };
        } else {
            if (currentTimeDec >= CONFIG.SYDNEY_START && currentTimeDec < CONFIG.SYDNEY_END) return { inSession: true, sessionName: 'SYDNEY', nextSession: null, minutesUntilNext: 0 };
        }

        let nextSession = '', minutesUntilNext = 0;
        if (currentTimeDec < CONFIG.TOKYO_START) { nextSession = 'TOKYO'; minutesUntilNext = (CONFIG.TOKYO_START - currentTimeDec) * 60; }
        else if (currentTimeDec < CONFIG.LONDON_START) { nextSession = 'LONDON'; minutesUntilNext = (CONFIG.LONDON_START - currentTimeDec) * 60; }
        else if (currentTimeDec < CONFIG.NEWYORK_START) { nextSession = 'NEW YORK'; minutesUntilNext = (CONFIG.NEWYORK_START - currentTimeDec) * 60; }
        else if (currentTimeDec < CONFIG.SYDNEY_START) { nextSession = 'SYDNEY'; minutesUntilNext = (CONFIG.SYDNEY_START - currentTimeDec) * 60; }
        else { nextSession = 'TOKYO'; minutesUntilNext = (24 - currentTimeDec + CONFIG.TOKYO_START) * 60; }

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
            this.endSession('PROFIT_TARGET'); return true;
        }
        if (netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.error(`🛑 SESSION STOP LOSS REACHED! Net P/L: $${netPL.toFixed(2)}`);
            this.endSession('STOP_LOSS'); return true;
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
        LOGGER.info('🗓️ Resetting session stats for new trading day…');
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
        LOGGER.info('🗓️ Daily stats reset (martingale state preserved)');
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
            // ── WIN ──────────────────────────────────────────────
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

            // Unlock after win
            state.activeTradeAsset = null;
            ACTIVE_ASSETS = [...CONFIG.ACTIVE_ASSETS];

            TradeHistoryManager.recordTrade(symbol, profit, assetState.martingaleLevel);
            LOGGER.trade(`✅ [${symbol}] WIN: +$${profit.toFixed(2)} | Direction: ${direction} | Martingale Reset | P/L: $${assetState.netPL.toFixed(2)}`);

        } else {
            // ── LOSS ─────────────────────────────────────────────
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

            // Martingale stake
            if (assetState.martingaleLevel === 1) assetState.currentStake = Math.ceil(assetState.currentStake * CONFIG.MARTINGALE_MULTIPLIER * 100) / 100;
            else if (assetState.martingaleLevel === 2) assetState.currentStake = Math.ceil(assetState.currentStake * CONFIG.MARTINGALE_MULTIPLIER2 * 100) / 100;
            else if (assetState.martingaleLevel >= 3) assetState.currentStake = Math.ceil(assetState.currentStake * CONFIG.MARTINGALE_MULTIPLIER3 * 100) / 100;

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
        LOGGER.info('🔌 Connecting to Deriv API…');
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
                    candles: [],
                    closedCandles: [],
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
            } else {
                const ac = getAssetConfig(symbol);
                LOGGER.info(`📊 Asset ${symbol} already initialized — ${ac.TIMEFRAME_LABEL}/${ac.DURATION}${ac.DURATION_UNIT} Mart=${state.assets[symbol].martingaleLevel}, Stake=$${state.assets[symbol].currentStake.toFixed(2)}`);
            }
        });
    }

    restoreSubscriptions() {
        LOGGER.info('📊 Restoring subscriptions after reconnection…');
        ACTIVE_ASSETS.forEach(symbol => {
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
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { LOGGER.debug('WebSocket already closed'); }
            }
            this.ws = null;
        }
    }

    onMessage(data) {
        try { this.handleResponse(JSON.parse(data)); }
        catch (error) { LOGGER.error(`Error parsing message: ${error.message}`); }
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
                LOGGER.info('🔄 Reconnection detected, restoring subscriptions…');
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
            return asset?.activePositions?.length > 0;
        });
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);
            const reqId = response.echo_req?.req_id;
            if (reqId) {
                ACTIVE_ASSETS.forEach(symbol => {
                    const asset = state.assets[symbol];
                    if (asset?.activePositions) {
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
        let foundSymbol = null, position = null;

        for (const symbol of ACTIVE_ASSETS) {
            const asset = state.assets[symbol];
            if (asset?.activePositions) {
                position = asset.activePositions.find(p => p.reqId === reqId);
                if (position) { foundSymbol = symbol; break; }
            }
        }

        if (position && foundSymbol) {
            position.contractId = contract.contract_id;
            position.buyPrice = contract.buy_price;
            TelegramService.sendTradeAlert(
                'OPEN', position.symbol, position.direction,
                position.stake, position.duration, position.durationUnit, {}
            );
        }

        this.send({ proposal_open_contract: 1, contract_id: contract.contract_id, subscribe: 1 });
    }

    handleOpenContract(response) {
        if (response.error) { LOGGER.error(`Contract error: ${response.error.message}`); return; }

        const contract = response.proposal_open_contract;
        const contractId = contract.contract_id;

        let ownerSymbol = null, posIndex = -1;
        for (const symbol of ACTIVE_ASSETS) {
            const asset = state.assets[symbol];
            if (asset?.activePositions) {
                const idx = asset.activePositions.findIndex(p => p.contractId === contractId);
                if (idx >= 0) { ownerSymbol = symbol; posIndex = idx; break; }
            }
        }
        if (posIndex < 0 || !ownerSymbol) return;

        const assetState = state.assets[ownerSymbol];
        const position = assetState.activePositions[posIndex];
        position.currentProfit = contract.profit;

        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
            const profit = contract.profit;
            LOGGER.trade(`[${ownerSymbol}] Contract ${contractId} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`);

            SessionManager.recordTradeResult(ownerSymbol, profit, position.direction);
            TelegramService.sendTradeAlert(
                profit >= 0 ? 'WIN' : 'LOSS',
                ownerSymbol, position.direction,
                position.stake, position.duration, position.durationUnit,
                { profit }
            );

            assetState.activePositions.splice(posIndex, 1);
            if (response.subscription?.id) this.send({ forget: response.subscription.id });
            SessionManager.checkSessionTargets();
            StatePersistence.saveState();

            // Immediate recovery on loss
            // if (profit < 0 && SessionManager.isSessionActive()) {
            //     LOGGER.trade(`🔄 [${ownerSymbol}] Loss confirmed — scheduling immediate recovery trade in ${CONFIG.RECOVERY_TRADE_DELAY_MS}ms`);
            //     setTimeout(() => {
            //         bot.executeRecoveryTrade(ownerSymbol, assetState.lastClosedCandleForRecovery);
            //     }, ['1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'].includes(ownerSymbol)
            //         ? CONFIG.RECOVERY_TRADE_DELAY_MS2
            //         : CONFIG.RECOVERY_TRADE_DELAY_MS
            //     );
            // }
        }
    }

    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        if (!state.assets[symbol]) return;

        const assetState = state.assets[symbol];
        const assetConfig = getAssetConfig(symbol);
        const granularity = assetConfig.GRANULARITY;

        const calculatedOpenTime = ohlc.open_time || Math.floor(ohlc.epoch / granularity) * granularity;
        const incomingCandle = {
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close),
            epoch: ohlc.epoch,
            open_time: calculatedOpenTime
        };

        // Buffer forming candle even before maxStreak is ready
        const currentOpenTime = assetState.currentFormingCandle?.open_time;
        const isNewCandle = currentOpenTime && incomingCandle.open_time !== currentOpenTime;

        if (isNewCandle) {
            const closedCandle = { ...assetState.currentFormingCandle };
            closedCandle.epoch = closedCandle.open_time + granularity;

            if (closedCandle.open_time !== assetState.lastProcessedCandleOpenTime) {
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

                // Display autocorrelation
                const regime = AlternatingRegimeDetector.analyze(assetState.closedCandles);
                const assetMaxStreak = assetMaxStreakManager ? assetMaxStreakManager.getMaxStreak(symbol) : 'N/A';
                LOGGER.info(`${symbol} AutoCorr: ${regime.autocorrelation.toFixed(4)} (threshold: ${CONFIG.AUTOCORR_THRESHOLD}) | AssetMaxStreak: ${assetMaxStreak} | Candles: ${assetState.closedCandles.length}`);

                // Only trigger trades if maxStreak is ready
                // if (!state.isMaxStreakReady) {
                //     LOGGER.debug(`[${symbol}] Candle closed but maxStreak not ready yet — buffering`);
                // } else {
                assetState.canTrade = true;
                // if (assetState.martingaleLevel > 0) {
                //     bot.executeRecoveryTrade(symbol, closedCandle);
                // } else {
                bot.executeNextTrade(symbol, closedCandle);
                // }
                // }
            }
        }

        assetState.currentFormingCandle = incomingCandle;

        const candles = assetState.candles;
        const existingIndex = candles.findIndex(c => c.open_time === incomingCandle.open_time);
        if (existingIndex >= 0) { candles[existingIndex] = incomingCandle; }
        else { candles.push(incomingCandle); }
        if (candles.length > assetConfig.MAX_CANDLES_STORED) {
            assetState.candles = candles.slice(-assetConfig.MAX_CANDLES_STORED);
        }
    }

    handleCandlesHistory(response) {
        if (response.error) { LOGGER.error(`Error fetching candles: ${response.error.message}`); return; }

        // Large batches (count > 100) belong to AssetMaxStreakManager — skip here
        if ((response.echo_req?.count ?? 0) > 100) return;

        const symbol = response.echo_req.ticks_history;
        if (!state.assets[symbol]) return;

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

        LOGGER.info(`📊 Loaded ${candles.length} ${assetConfig.TIMEFRAME_LABEL} candles for ${symbol}`);

        const regime = AlternatingRegimeDetector.analyze(state.assets[symbol].closedCandles);
        LOGGER.info(`  ✅ [${symbol}] Initial AutoCorr: ${regime.autocorrelation.toFixed(4)} | Ready for trade analysis`);
    }

    onError(error) { LOGGER.error(`WebSocket error: ${error.message}`); }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;
        this.stopPing();
        StatePersistence.saveState();

        if (this.isReconnecting) { LOGGER.info('Already handling disconnect, skipping…'); return; }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.isReconnecting = true;
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s… (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            TelegramService.sendMessage(
                `⚠️ <b>CONNECTION LOST - RECONNECTING 2b</b>\n` +
                `Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
                `Retrying in ${(delay / 1000).toFixed(1)}s\n` +
                `State preserved: ${state.session.tradesCount} trades, $${state.session.netPL.toFixed(2)} P&amp;L`
            );
            setTimeout(() => {
                this.isReconnecting = false;
                state.activeTradeAsset = null;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            TelegramService.sendMessage(`🛑 <b>BOT STOPPED 2b</b>\nMax reconnection attempts reached.\nFinal P&amp;L: $${state.session.netPL.toFixed(2)}`);
            process.exit(1);
        }
    }

    startPing() { this.pingInterval = setInterval(() => { if (state.isConnected) this.send({ ping: 1 }); }, 30000); }
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
    constructor() { this.connection = new ConnectionManager(); }

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

        // ── Step 1: assetMaxStreak check ──────────────────────────
        if (assetMaxStreakManager.needsRefresh() || !assetMaxStreakManager.allReady()) {
            LOGGER.info('📊 assetMaxStreak computation required — pausing trading…');
            state.isMaxStreakReady = false;

            // Subscribe candles first (OHLC stream starts, but trades won't fire)
            ACTIVE_ASSETS.forEach(symbol => this.subscribeToCandles(symbol));

            // Compute maxStreak for all assets sequentially
            await assetMaxStreakManager.computeAllMaxStreaks(this.connection);

            state.isMaxStreakReady = true;
            LOGGER.info('✅ assetMaxStreak ready — trading ENABLED');

            // Safety: trim closedCandles to MAX_CANDLES_STORED
            ACTIVE_ASSETS.forEach(symbol => {
                const assetState = state.assets[symbol];
                if (assetState && assetState.closedCandles.length > CONFIG.MAX_CANDLES_STORED) {
                    assetState.closedCandles = assetState.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED);
                }
            });

        } else {
            LOGGER.info('✅ assetMaxStreak loaded from file — trading ENABLED immediately');
            state.isMaxStreakReady = true;
            ACTIVE_ASSETS.forEach(symbol => {
                LOGGER.info(`  [${symbol}] assetMaxStreak = ${assetMaxStreakManager.getMaxStreak(symbol)}`);
            });
            ACTIVE_ASSETS.forEach(symbol => this.subscribeToCandles(symbol));
        }

        // ── Step 2: Monthly refresh scheduler ─────────────────────
        assetMaxStreakManager.scheduleMonthlyRefresh(this.connection);

        // ── Step 3: Timers ─────────────────────────────────────────
        TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();
        TelegramService.startDailyTimer();
        this.startSessionTimeChecker();

        LOGGER.info('✅ Bot started successfully! (Per-Asset Independent + Immediate Recovery Mode)');
    }

    subscribeToCandles(symbol) {
        const assetConfig = getAssetConfig(symbol);
        LOGGER.info(`📊 Subscribing to ${assetConfig.TIMEFRAME_LABEL} candles for ${symbol} (granularity: ${assetConfig.GRANULARITY}s)…`);

        // Load 50 recent candles for autocorrelation analysis
        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: assetConfig.CANDLES_TO_LOAD,  // 50
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: assetConfig.GRANULARITY
        });

        // Live stream
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
    }

    // ═══════════════════════════════════════════════════════════════
    // IMMEDIATE RECOVERY TRADE
    // ═══════════════════════════════════════════════════════════════
    executeRecoveryTrade(symbol, closedCandle) {
        const assetState = state.assets[symbol];
        if (!assetState) return;

        if (!SessionManager.isSessionActive()) {
            LOGGER.info(`[${symbol}] Recovery skipped — session ended`); return;
        }
        if (assetState.lastTradeWasWin !== false || assetState.martingaleLevel === 0) {
            LOGGER.info(`[${symbol}] Recovery skipped — not in loss recovery (mart=${assetState.martingaleLevel})`); return;
        }
        if (assetState.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) {
            LOGGER.warn(`[${symbol}] Recovery skipped — position already open (${assetState.activePositions.length})`); return;
        }

        const stake = assetState.currentStake;
        if (state.capital < stake) {
            LOGGER.error(`[${symbol}] Recovery skipped — insufficient capital $${state.capital.toFixed(2)} (need $${stake.toFixed(2)})`);
            if (assetState.martingaleLevel > 0) { assetState.martingaleLevel = 0; assetState.currentStake = CONFIG.STAKE; }
            return;
        }
        if (!state.isConnected || !state.isAuthorized) {
            LOGGER.warn(`[${symbol}] Recovery skipped — not connected/authorised`); return;
        }
        if (!state.isMaxStreakReady) {
            LOGGER.warn(`[${symbol}] Recovery skipped — maxStreak not yet ready`); return;
        }
        if (!closedCandle) {
            LOGGER.warn(`[${symbol}] Recovery skipped — no reference candle`); return;
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
        LOGGER.trade(`  Reference Candle: ${candleType}`);

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
            buy: 1,
            price: stake.toFixed(2),
            parameters: {
                contract_type: direction, symbol,
                currency: 'USD', amount: stake.toFixed(2),
                duration: assetConfig.DURATION, duration_unit: assetConfig.DURATION_UNIT,
                basis: 'stake'
            }
        };

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;
        LOGGER.trade(`✅ [${symbol}] Recovery trade sent (reqId: ${reqId})`);
    }

    // ═══════════════════════════════════════════════════════════════
    // NORMAL TRADE EXECUTION
    // Trade fires when autocorrelation < CONFIG.AUTOCORR_THRESHOLD
    // ═══════════════════════════════════════════════════════════════
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

        // Skip if another asset is locked
        if (state.activeTradeAsset && state.activeTradeAsset !== symbol) {
            LOGGER.debug(`  [${symbol}] Skipped — [${state.activeTradeAsset}] is already active`);
            return;
        }

        // Skip if position already open
        if (assetState.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS_PER_ASSET) {
            LOGGER.debug(`${symbol} Max positions reached (${assetState.activePositions.length}/${CONFIG.MAX_OPEN_POSITIONS_PER_ASSET})`);
            return;
        }

        // Skip if in martingale recovery — handled by executeRecoveryTrade
        // if (assetState.lastTradeWasWin === false && assetState.martingaleLevel > 0) {
        //     LOGGER.debug(`  [${symbol}] Normal signal skipped — in recovery (mart=${assetState.martingaleLevel})`);
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

                // Lock this asset
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

        // ── Execute normal trade ───────────────────────────────────
        assetState.canTrade = false;
        assetState.lastTradeDirection = direction;

        const sessionLabel = CONFIG.USE_TRADING_SESSIONS
            ? (sessionCheck.inSession ? `[${sessionCheck.sessionName}]` : `[RECOVERY - Outside Session]`)
            : '[24/7]';

        LOGGER.trade(`🎯 ${sessionLabel} [${symbol}] Executing ${direction === 'CALLE' ? 'RISE' : 'FALL'} trade`);
        LOGGER.trade(`  [${symbol}] Stake: $${stake.toFixed(2)} | Duration: ${assetConfig.DURATION} ${assetConfig.DURATION_UNIT} | Martingale Level: ${assetState.martingaleLevel}`);
        LOGGER.trade(`  [${symbol}] Reason: ${signalReason}`);
        LOGGER.trade(`  [${symbol}] Last candle: ${CandleAnalyzer.getCandleDirection(lastClosedCandle)} | Close: ${lastClosedCandle.close.toFixed(5)}`);
        LOGGER.trade(`  [${symbol}] Asset Stats: ${assetState.tradesCount} trades, ${assetState.winsCount}W/${assetState.lossesCount}L, P/L: $${assetState.netPL.toFixed(2)}`);

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
            buy: 1,
            price: stake.toFixed(2),
            parameters: {
                contract_type: direction, symbol,
                currency: 'USD', amount: stake.toFixed(2),
                duration: assetConfig.DURATION, duration_unit: assetConfig.DURATION_UNIT,
                basis: 'stake'
            }
        };

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;
    }

    stop() {
        LOGGER.info('🛑 Stopping bot…');
        ACTIVE_ASSETS.forEach(symbol => { const asset = state.assets[symbol]; if (asset) asset.canTrade = false; });
        StatePersistence.saveState();
        TradeHistoryManager.saveHistory();
        setTimeout(() => { if (this.connection.ws) this.connection.ws.close(); LOGGER.info('👋 Bot stopped'); }, 2000);
    }

    startSessionTimeChecker() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + 3600000);
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
                const lastClosed = a.closedCandles?.length ? a.closedCandles[a.closedCandles.length - 1] : null;
                const lastCandleDir = lastClosed ? CandleAnalyzer.getCandleDirection(lastClosed) : null;
                assetStatuses[symbol] = {
                    martingaleLevel: a.martingaleLevel,
                    currentStake: a.currentStake,
                    lastDirection: a.lastTradeDirection,
                    lastWasWin: a.lastTradeWasWin,
                    activePositions: a.activePositions.length,
                    trades: a.tradesCount,
                    wins: a.winsCount,
                    losses: a.lossesCount,
                    netPL: a.netPL,
                    lastCandleDir,
                    autocorrelation: regime.autocorrelation,
                    assetMaxStreak,
                    threshold: CONFIG.AUTOCORR_THRESHOLD,
                    timeframe: ac.TIMEFRAME_LABEL,
                    duration: `${ac.DURATION}${ac.DURATION_UNIT}`
                };
            }
        });

        let totalActivePositions = 0;
        ACTIVE_ASSETS.forEach(sym => { const a = state.assets[sym]; if (a) totalActivePositions += a.activePositions.length; });

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
assetMaxStreakManager = new AssetMaxStreakManager();  // instantiated after LOGGER is ready

const bot = new DerivBot();

process.on('SIGINT', () => { console.log('\n\n⚠️ Shutdown signal received…'); bot.stop(); setTimeout(() => process.exit(0), 3000); });
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
console.log(` 📊 Strategy: autocorrelation < ${CONFIG.AUTOCORR_THRESHOLD}`);
console.log(` 📊 MaxStreak Source: 50,000 candles (10 × 5,000 API batches)`);
console.log('═'.repeat(80));
console.log('\n🚀 Initializing…\n');

bot.connection.connect();

// Status display every 60 seconds
setInterval(() => {
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

        console.log(`\n📊 ${getGMTTime()} | Today: ${status.session.trades} trades | ${status.session.winRate} | $${status.session.netPL.toFixed(2)} | ${status.totalActivePositions} active | MaxStreakReady:${status.isMaxStreakReady}`);
        console.log(`📋 Overall: ${overall.tradesCount} trades | ${overall.winsCount}W/${overall.lossesCount}L | P/L: $${overall.netPL.toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`);
        console.log(`📉 Today Loss Stats: x2:${s.x2Losses} x3:${s.x3Losses} x4:${s.x4Losses} x5:${s.x5Losses} x6:${s.x6Losses} x7:${s.x7Losses} x8:${s.x8Losses} x9:${s.x9Losses}`);
        console.log(`🔧 Per-Asset Status:${assetLines}`);
        console.log(`  ${status.tradingSession}`);
    }
}, 60000);
