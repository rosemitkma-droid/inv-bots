const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'ema_riseFallM000000001-state.json');
const HISTORY_FILE = path.join(__dirname, 'ema_riseFallM000000001-history.json');
const STATE_SAVE_INTERVAL = 5000;

// ============================================
// TRADE HISTORY MANAGER
// ============================================
class TradeHistoryManager {
    static getDateKey() {
        const now = new Date();
        return now.toISOString().split('T')[0]; // e.g. "2025-01-15"
    }

    static loadHistory() {
        try {
            if (!fs.existsSync(HISTORY_FILE)) {
                LOGGER.info('📂 No trade history file found, starting fresh history');
                return {
                    overall: {
                        tradesCount: 0,
                        winsCount: 0,
                        lossesCount: 0,
                        profit: 0,
                        loss: 0,
                        netPL: 0,
                        x2Losses: 0,
                        x3Losses: 0,
                        x4Losses: 0,
                        x5Losses: 0,
                        x6Losses: 0,
                        x7Losses: 0,
                        x8Losses: 0,
                        x9Losses: 0,
                        firstTradeDate: null,
                        lastTradeDate: null
                    },
                    overallAssets: {},
                    dailyHistory: {},
                    lastUpdated: Date.now()
                };
            }

            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            LOGGER.info(`📂 Trade history loaded — ${Object.keys(data.dailyHistory || {}).length} days of history`);
            return data;
        } catch (error) {
            LOGGER.error(`Failed to load trade history: ${error.message}`);
            return {
                overall: {
                    tradesCount: 0,
                    winsCount: 0,
                    lossesCount: 0,
                    profit: 0,
                    loss: 0,
                    netPL: 0,
                    x2Losses: 0,
                    x3Losses: 0,
                    x4Losses: 0,
                    x5Losses: 0,
                    x6Losses: 0,
                    x7Losses: 0,
                    x8Losses: 0,
                    x9Losses: 0,
                    firstTradeDate: null,
                    lastTradeDate: null
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
                tradesCount: 0,
                winsCount: 0,
                lossesCount: 0,
                profit: 0,
                loss: 0,
                netPL: 0,
                x2Losses: 0,
                x3Losses: 0,
                x4Losses: 0,
                x5Losses: 0,
                x6Losses: 0,
                x7Losses: 0,
                x8Losses: 0,
                x9Losses: 0,
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
                tradesCount: 0,
                winsCount: 0,
                lossesCount: 0,
                profit: 0,
                loss: 0,
                netPL: 0,
                x2Losses: 0,
                x3Losses: 0,
                x4Losses: 0,
                x5Losses: 0,
                x6Losses: 0,
                x7Losses: 0,
                x8Losses: 0,
                x9Losses: 0
            };
        }
    }

    static ensureOverallAssetEntry(symbol) {
        if (!tradeHistory.overallAssets[symbol]) {
            tradeHistory.overallAssets[symbol] = {
                tradesCount: 0,
                winsCount: 0,
                lossesCount: 0,
                profit: 0,
                loss: 0,
                netPL: 0,
                x2Losses: 0,
                x3Losses: 0,
                x4Losses: 0,
                x5Losses: 0,
                x6Losses: 0,
                x7Losses: 0,
                x8Losses: 0,
                x9Losses: 0,
            };
        }
    }

    /**
     * Record a trade result into daily + overall history
     */
    static recordTrade(symbol, profit, martingaleLevel) {
        const dateKey = this.getDateKey();
        this.ensureAssetDayEntry(dateKey, symbol);
        this.ensureOverallAssetEntry(symbol);

        const dayStats = tradeHistory.dailyHistory[dateKey];
        const dayAssetStats = dayStats.assets[symbol];
        const overall = tradeHistory.overall;
        const overallAsset = tradeHistory.overallAssets[symbol];

        // Update trade counts
        dayStats.tradesCount++;
        dayAssetStats.tradesCount++;
        overall.tradesCount++;
        overallAsset.tradesCount++;

        if (!overall.firstTradeDate) {
            overall.firstTradeDate = dateKey;
        }
        overall.lastTradeDate = dateKey;

        if (profit > 0) {
            // WIN
            dayStats.winsCount++;
            dayStats.profit += profit;
            dayStats.netPL += profit;

            dayAssetStats.winsCount++;
            dayAssetStats.profit += profit;
            dayAssetStats.netPL += profit;

            overall.winsCount++;
            overall.profit += profit;
            overall.netPL += profit;

            overallAsset.winsCount++;
            overallAsset.profit += profit;
            overallAsset.netPL += profit;
        } else {
            // LOSS
            dayStats.lossesCount++;
            dayStats.loss += Math.abs(profit);
            dayStats.netPL += profit;

            dayAssetStats.lossesCount++;
            dayAssetStats.loss += Math.abs(profit);
            dayAssetStats.netPL += profit;

            overall.lossesCount++;
            overall.loss += Math.abs(profit);
            overall.netPL += profit;

            overallAsset.lossesCount++;
            overallAsset.loss += Math.abs(profit);
            overallAsset.netPL += profit;

            // Track consecutive loss stats
            if (martingaleLevel === 2) {
                dayStats.x2Losses++;
                dayAssetStats.x2Losses++;
                overall.x2Losses++;
                overallAsset.x2Losses++;
            }
            if (martingaleLevel === 3) {
                dayStats.x3Losses++;
                dayAssetStats.x3Losses++;
                overall.x3Losses++;
                overallAsset.x3Losses++;
            }
            if (martingaleLevel === 4) {
                dayStats.x4Losses++;
                dayAssetStats.x4Losses++;
                overall.x4Losses++;
                overallAsset.x4Losses++;
            }
            if (martingaleLevel === 5) {
                dayStats.x5Losses++;
                dayAssetStats.x5Losses++;
                overall.x5Losses++;
                overallAsset.x5Losses++;
            }
            if (martingaleLevel === 6) {
                dayStats.x6Losses++;
                dayAssetStats.x6Losses++;
                overall.x6Losses++;
                overallAsset.x6Losses++;
            }
            if (martingaleLevel === 7) {
                dayStats.x7Losses++;
                dayAssetStats.x7Losses++;
                overall.x7Losses++;
                overallAsset.x7Losses++;
            }
            if (martingaleLevel === 8) {
                dayStats.x8Losses++;
                dayAssetStats.x8Losses++;
                overall.x8Losses++;
                overallAsset.x8Losses++;
            }
            if (martingaleLevel === 9) {
                dayStats.x9Losses++;
                dayAssetStats.x9Losses++;
                overall.x9Losses++;
                overallAsset.x9Losses++;
            }
        }

        dayStats.endCapital = state.capital;
        tradeHistory.lastUpdated = Date.now();

        this.saveHistory();
    }

    /**
     * Get today's stats
     */
    static getTodayStats() {
        const dateKey = this.getDateKey();
        this.ensureDayEntry(dateKey);
        return tradeHistory.dailyHistory[dateKey];
    }

    /**
     * Get overall stats
     */
    static getOverallStats() {
        return tradeHistory.overall;
    }

    /**
     * Get stats for a specific date
     */
    static getDayStats(dateKey) {
        return tradeHistory.dailyHistory[dateKey] || null;
    }

    /**
     * Get list of all trading days
     */
    static getAllDays() {
        return Object.keys(tradeHistory.dailyHistory).sort();
    }

    /**
     * Get last N days stats
     */
    static getRecentDays(n = 7) {
        const days = this.getAllDays();
        return days.slice(-n).map(dateKey => ({
            date: dateKey,
            ...tradeHistory.dailyHistory[dateKey]
        }));
    }
}

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
                    // Candle data
                    closedCandles: asset.closedCandles.slice(-assetConfig.MAX_CANDLES_STORED),
                    lastProcessedCandleOpenTime: asset.lastProcessedCandleOpenTime,
                    candlesLoaded: asset.candlesLoaded,
                    // EMA data
                    lastEmaFast: asset.lastEmaFast,
                    lastEmaSlow: asset.lastEmaSlow,
                    prevEmaFast: asset.prevEmaFast,
                    prevEmaSlow: asset.prevEmaSlow,
                    lastEmaSignal: asset.lastEmaSignal,
                    lastEmaIsAbove: asset.lastEmaIsAbove,
                    lastCrossSignalDirection: asset.lastCrossSignalDirection,
                    // Per-asset trade management
                    lastTradeDirection: asset.lastTradeDirection,
                    lastTradeWasWin: asset.lastTradeWasWin,
                    martingaleLevel: asset.martingaleLevel,
                    currentStake: asset.currentStake,
                    canTrade: asset.canTrade,
                    // Per-asset stats (today's session)
                    tradesCount: asset.tradesCount,
                    winsCount: asset.winsCount,
                    lossesCount: asset.lossesCount,
                    profit: asset.profit,
                    loss: asset.loss,
                    netPL: asset.netPL,
                    x2Losses: asset.x2Losses,
                    x3Losses: asset.x3Losses,
                    x4Losses: asset.x4Losses,
                    x5Losses: asset.x5Losses,
                    x6Losses: asset.x6Losses,
                    x7Losses: asset.x7Losses,
                    x8Losses: asset.x8Losses,
                    x9Losses: asset.x9Losses,
                    // Per-asset active positions
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
            if (!fs.existsSync(STATE_FILE)) {
                LOGGER.info('📂 No previous state file found, starting fresh');
                return false;
            }

            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            if (ageMinutes > 30) {
                LOGGER.warn(
                    `⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`
                );
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            LOGGER.info(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);

            state.capital = savedData.capital;
            state.session = {
                ...state.session,
                ...savedData.session,
                startTime: savedData.session.startTime || Date.now(),
                startCapital: savedData.session.startCapital || savedData.capital
            };

            state.portfolio.dailyProfit = savedData.portfolio.dailyProfit;
            state.portfolio.dailyLoss = savedData.portfolio.dailyLoss;
            state.portfolio.dailyWins = savedData.portfolio.dailyWins;
            state.portfolio.dailyLosses = savedData.portfolio.dailyLosses;

            state.currentTradeDay = savedData.currentTradeDay || TradeHistoryManager.getDateKey();

            state.hourlyStats = savedData.hourlyStats || {
                trades: 0,
                wins: 0,
                losses: 0,
                pnl: 0,
                lastHour: new Date().getHours()
            };

            if (savedData.assets) {
                Object.keys(savedData.assets).forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = savedData.assets[symbol];
                        const asset = state.assets[symbol];
                        const assetConfig = getAssetConfig(symbol);

                        // Candle data
                        if (saved.closedCandles && saved.closedCandles.length > 0) {
                            asset.closedCandles = saved.closedCandles;
                            LOGGER.info(
                                `  📊 Restored ${saved.closedCandles.length} closed candles for ${symbol}`
                            );
                        }
                        asset.lastProcessedCandleOpenTime =
                            saved.lastProcessedCandleOpenTime || 0;
                        asset.candlesLoaded = saved.candlesLoaded || false;

                        // EMA data
                        asset.lastEmaFast = saved.lastEmaFast || null;
                        asset.lastEmaSlow = saved.lastEmaSlow || null;
                        asset.prevEmaFast = saved.prevEmaFast || null;
                        asset.prevEmaSlow = saved.prevEmaSlow || null;
                        asset.lastEmaSignal = saved.lastEmaSignal || null;
                        asset.lastEmaIsAbove = saved.lastEmaIsAbove !== undefined ? saved.lastEmaIsAbove : null;
                        asset.lastCrossSignalDirection = saved.lastCrossSignalDirection || null;

                        // Per-asset trade management
                        asset.lastTradeDirection = saved.lastTradeDirection || null;
                        asset.lastTradeWasWin = saved.lastTradeWasWin !== undefined
                            ? saved.lastTradeWasWin : null;
                        asset.martingaleLevel = saved.martingaleLevel || 0;
                        asset.currentStake = saved.currentStake || CONFIG.STAKE;
                        asset.canTrade = saved.canTrade || false;

                        // Per-asset stats
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

                        // Per-asset active positions
                        asset.activePositions = (saved.activePositions || []).map(
                            pos => ({
                                ...pos,
                                entryTime: pos.entryTime || Date.now()
                            })
                        );

                        LOGGER.info(
                            `  🔄 ${symbol}: Martingale=${asset.martingaleLevel}, Stake=$${asset.currentStake.toFixed(2)}, P/L=$${asset.netPL.toFixed(2)}, Positions=${asset.activePositions.length}`
                        );
                    }
                });
            }

            LOGGER.info(`✅ State restored successfully!`);
            LOGGER.info(`   💰 Capital: $${state.capital.toFixed(2)}`);
            LOGGER.info(`   📊 Session P/L: $${state.session.netPL.toFixed(2)}`);
            LOGGER.info(
                `   🎯 Trades: ${state.session.tradesCount} (W:${state.session.winsCount} L:${state.session.lossesCount})`
            );
            LOGGER.info(
                `   📉 Loss Stats: x2:${state.session.x2Losses} x3:${state.session.x3Losses} x4:${state.session.x4Losses} x5:${state.session.x5Losses} x6:${state.session.x6Losses} x7:${state.session.x7Losses} x8:${state.session.x8Losses} x9:${state.session.x9Losses}`
            );

            // Count total active positions across all assets
            let totalActivePositions = 0;
            Object.keys(state.assets).forEach(sym => {
                totalActivePositions += state.assets[sym].activePositions.length;
            });
            LOGGER.info(`   🚀 Total Active Positions: ${totalActivePositions}`);

            return true;
        } catch (error) {
            LOGGER.error(`Failed to load state: ${error.message}`);
            LOGGER.error(`Stack: ${error.stack}`);
            return false;
        }
    }

    static startAutoSave() {
        setInterval(() => {
            if (state.isAuthorized) {
                this.saveState();
            }
        }, STATE_SAVE_INTERVAL);
        LOGGER.info(
            `💾 Auto-save enabled (every ${STATE_SAVE_INTERVAL / 1000}s)`
        );
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
    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED) return;
        try {
            if (!message || message.length === 0) {
                LOGGER.error('[TELEGRAM] ❌ Message is empty! Not sending.');
                console.error('[DEBUG] Empty message received in sendMessage()');
                return;
            }

            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const data = JSON.stringify({
                chat_id: CONFIG.TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            });

            console.log(`[DEBUG] Sending Telegram message (${message.length} chars, ${data.length} bytes)`);
            console.log(`[DEBUG] Message preview: ${message.substring(0, 100)}...`);

            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': data.length
                }
            };

            return new Promise((resolve, reject) => {
                const req = https.request(url, options, res => {
                    let body = '';
                    res.on('data', chunk => (body += chunk));
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            resolve(true);
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
                        }
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
            LOGGER.error(
                `[TELEGRAM] ❌ Failed to send message: ${error.message}`
            );
            console.error('[DEBUG] Exception in sendMessage:', error);
        }
    }

    static async sendTradeAlert(
        type,
        symbol,
        direction,
        stake,
        duration,
        durationUnit,
        details = {}
    ) {
        const emoji =
            type === 'OPEN'
                ? '🚀'
                : type === 'WIN'
                    ? '✅'
                    : '❌';

        const assetState = state.assets[symbol];
        const assetMartingale = assetState ? assetState.martingaleLevel : 0;
        const assetNetPL = assetState ? assetState.netPL : 0;
        const assetWins = assetState ? assetState.winsCount : 0;
        const assetLosses = assetState ? assetState.lossesCount : 0;

        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();

        const message = `
                ${emoji} <b>${type} TRADE ALERT</b>
                Asset: ${symbol}
                Direction: ${direction}
                Stake: $${stake.toFixed(2)}
                Duration: ${duration} (${durationUnit == 't' ? 'Ticks' : durationUnit == 's' ? 'Seconds' : 'Minutes'})
                Martingale Level: ${assetMartingale}
                ${details.profit !== undefined
                                ? `Profit: $${details.profit.toFixed(2)}

                📊 <b>Today's Stats:</b>
                ${symbol} P&L: $${assetNetPL.toFixed(2)}
                ${symbol} W/L: ${assetWins}/${assetLosses}
                Today P&L: $${today.netPL.toFixed(2)}
                Today W/L: ${today.winsCount}/${today.lossesCount}

                📈 <b>Overall Stats:</b>
                Overall P&L: $${overall.netPL.toFixed(2)}
                Overall W/L: ${overall.winsCount}/${overall.lossesCount}
                Total Trades: ${overall.tradesCount}
                Capital: $${state.capital.toFixed(2)}
            `
                : ''
            }`.trim();
        await this.sendMessage(message);
    }

    static async sendSessionSummary() {
        const stats = SessionManager.getSessionStats();
        const today = TradeHistoryManager.getTodayStats();
        const overall = TradeHistoryManager.getOverallStats();

        // Build per-asset breakdown (today)
        let assetBreakdown = '';
        ACTIVE_ASSETS.forEach(symbol => {
            const a = state.assets[symbol];
            if (a && a.tradesCount > 0) {
                const winRate = a.tradesCount > 0
                    ? ((a.winsCount / a.tradesCount) * 100).toFixed(1)
                    : '0.0';
                assetBreakdown += `\n  ${symbol}: ${a.tradesCount} trades, ${a.winsCount}W/${a.lossesCount}L (${winRate}%), P/L: $${a.netPL.toFixed(2)}, Mart: ${a.martingaleLevel}`;
            }
        });

        // Build overall per-asset breakdown
        let overallAssetBreakdown = '';
        ACTIVE_ASSETS.forEach(symbol => {
            const oa = tradeHistory.overallAssets[symbol];
            if (oa && oa.tradesCount > 0) {
                const winRate = oa.tradesCount > 0
                    ? ((oa.winsCount / oa.tradesCount) * 100).toFixed(1)
                    : '0.0';
                overallAssetBreakdown += `\n  ${symbol}: ${oa.tradesCount} trades, ${oa.winsCount}W/${oa.lossesCount}L (${winRate}%), P/L: $${oa.netPL.toFixed(2)}`;
            }
        });

        // Recent days summary
        const recentDays = TradeHistoryManager.getRecentDays(5);
        let recentDaysStr = '';
        recentDays.forEach(day => {
            const wr = day.tradesCount > 0
                ? ((day.winsCount / day.tradesCount) * 100).toFixed(1)
                : '0.0';
            const pnlEmoji = day.netPL >= 0 ? '🟢' : '🔴';
            recentDaysStr += `\n  ${day.date}: ${day.tradesCount}t ${day.winsCount}W/${day.lossesCount}L (${wr}%) ${pnlEmoji} $${day.netPL.toFixed(2)}`;
        });

        const overallWinRate = overall.tradesCount > 0
            ? ((overall.winsCount / overall.tradesCount) * 100).toFixed(1) + '%'
            : '0.0%';

        const message = `
            📊 <b>SESSION SUMMARY</b>

            📅 <b>Today (${TradeHistoryManager.getDateKey()}):</b>
            Duration: ${stats.duration}
            Trades: ${stats.trades}
            Wins: ${stats.wins} | Losses: ${stats.losses}
            Win Rate: ${stats.winRate}
            Loss Stats: x2:${today.x2Losses} | x3:${today.x3Losses} | x4:${today.x4Losses} | x5:${today.x5Losses} | x6:${today.x6Losses} | x7:${today.x7Losses} | x8:${today.x8Losses} | x9:${today.x9Losses}
            Today P/L: $${today.netPL.toFixed(2)}

            📈 <b>Today's Per-Asset:</b>${assetBreakdown || '\n  No trades yet'}

            📊 <b>Overall Stats (${overall.firstTradeDate || 'N/A'} to ${overall.lastTradeDate || 'N/A'}):</b>
            Total Trades: ${overall.tradesCount}
            Total Wins: ${overall.winsCount} | Total Losses: ${overall.lossesCount}
            Overall Win Rate: ${overallWinRate}
            Overall P/L: $${overall.netPL.toFixed(2)}
            Loss Stats: x2:${overall.x2Losses} | x3:${overall.x3Losses} | x4:${overall.x4Losses} | x5:${overall.x5Losses} | x6:${overall.x6Losses} | x7:${overall.x7Losses} | x8:${overall.x8Losses} | x9:${overall.x9Losses}

            📈 <b>Overall Per-Asset:</b>${overallAssetBreakdown || '\n  No trades yet'}

            📆 <b>Recent Days:</b>${recentDaysStr || '\n  No history yet'}

            💰 Current Capital: $${state.capital.toFixed(2)}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendDayEndSummary(dateKey) {
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
                    assetBreakdown += `\n  ${symbol}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L (${wr}%) P/L: $${a.netPL.toFixed(2)}`;
                }
            });
        }

        const pnlEmoji = dayStats.netPL >= 0 ? '🟢' : '🔴';

        const message = `
            🌙 <b>END OF DAY REPORT — ${dateKey}</b>

            ${pnlEmoji} <b>Day Results:</b>
            ├ Trades: ${dayStats.tradesCount}
            ├ Wins: ${dayStats.winsCount} | Losses: ${dayStats.lossesCount}
            ├ Win Rate: ${dayWinRate}
            ├ Profit: $${dayStats.profit.toFixed(2)} | Loss: $${dayStats.loss.toFixed(2)}
            ├ Net P/L: $${dayStats.netPL.toFixed(2)}
            ├ Start Capital: $${dayStats.startCapital.toFixed(2)}
            └ End Capital: $${dayStats.endCapital.toFixed(2)}

            📊 Loss Stats: x2:${dayStats.x2Losses} x3:${dayStats.x3Losses} x4:${dayStats.x4Losses} x5:${dayStats.x5Losses} x6:${dayStats.x6Losses} x7:${dayStats.x7Losses} x8:${dayStats.x8Losses} x9:${dayStats.x9Losses}

            📈 <b>Per-Asset:</b>${assetBreakdown || '\n  No trades'}

            📊 <b>Overall Stats (All Time):</b>
            ├ Total Days: ${TradeHistoryManager.getAllDays().length}
            ├ Total Trades: ${overall.tradesCount}
            ├ Total Wins: ${overall.winsCount} | Total Losses: ${overall.lossesCount}
            ├ Overall Win Rate: ${overallWinRate}
            ├ Overall P/L: $${overall.netPL.toFixed(2)}
            └ Loss Stats: x2:${overall.x2Losses} x3:${overall.x3Losses} x4:${overall.x4Losses} x5:${overall.x5Losses} x6:${overall.x6Losses} x7:${overall.x7Losses} x8:${overall.x8Losses} x9:${overall.x9Losses}

            💰 Current Capital: $${state.capital.toFixed(2)}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendStartupMessage() {
        try {
            const overall = TradeHistoryManager.getOverallStats();
            const totalDays = TradeHistoryManager.getAllDays().length;

            let assetConfigInfo = '';
            ACTIVE_ASSETS.forEach(symbol => {
                const ac = getAssetConfig(symbol);
                assetConfigInfo += `\n  ${symbol}: ${ac.TIMEFRAME_LABEL} candles, Duration: ${ac.DURATION}${ac.DURATION_UNIT}`;
            });

            // Validate CONFIG values before using them
            console.log('[DEBUG] CONFIG Session Values:');
            console.log(`  TOKYO_START: ${CONFIG.TOKYO_START}, TOKYO_END: ${CONFIG.TOKYO_END}`);
            console.log(`  LONDON_START: ${CONFIG.LONDON_START}, LONDON_END: ${CONFIG.LONDON_END}`);
            console.log(`  NEWYORK_START: ${CONFIG.NEWYORK_START}, NEWYORK_END: ${CONFIG.NEWYORK_END}`);
            console.log(`  SYDNEY_START: ${CONFIG.SYDNEY_START}, SYDNEY_END: ${CONFIG.SYDNEY_END}`);

            const message = `
            🤖 <b>DERIV RISE/FALL BOT STARTED</b>
            Strategy: EMA Crossover (EMA${CONFIG.EMA_FAST_PERIOD} / EMA${CONFIG.EMA_SLOW_PERIOD})
            Mode: <b>Independent Per-Asset Management</b>
            Capital: $${state.capital.toFixed(2)}
            Stake: $${CONFIG.STAKE}

            🔧 <b>Asset Configurations:</b>${assetConfigInfo}

            Max Positions Per Asset: ${CONFIG.MAX_OPEN_POSITIONS_PER_ASSET}
            Session Target: $${CONFIG.SESSION_PROFIT_TARGET}
            Stop Loss: $${CONFIG.SESSION_STOP_LOSS}
            Trading Sessions: ${CONFIG.USE_TRADING_SESSIONS ? 'ENABLED' : 'DISABLED (24/7)'}

            📊 <b>Historical Stats:</b>
            ├ Trading Days: ${totalDays}
            ├ Total Trades: ${overall.tradesCount}
            ├ Overall P/L: $${overall.netPL.toFixed(2)}
            └ Period: ${overall.firstTradeDate || 'N/A'} to ${overall.lastTradeDate || 'N/A'}

            🕐 TOKYO Session: ${CONFIG.TOKYO_START || 'UNDEFINED'}:00 - ${CONFIG.TOKYO_END || 'UNDEFINED'}:00 (GMT+1)
            🕐 London Session: ${CONFIG.LONDON_START || 'UNDEFINED'}:00 - ${CONFIG.LONDON_END || 'UNDEFINED'}:00 (GMT+1)
            🕐 New York Session: ${CONFIG.NEWYORK_START || 'UNDEFINED'}:00 - ${CONFIG.NEWYORK_END || 'UNDEFINED'}:00 (GMT+1)
            🕐 SYDNEY Session: ${CONFIG.SYDNEY_START || 'UNDEFINED'}:00 - ${CONFIG.SYDNEY_END || 'UNDEFINED'}:00 (GMT+1)
        `.trim();

            if (!message || message.length === 0) {
                LOGGER.error('[TELEGRAM] ❌ Message is empty before sending!');
                return;
            }

            console.log('[DEBUG] Message preview:');
            console.log(message.substring(0, 200) + '...');
            console.log(`[DEBUG] Message length: ${message.length}`);

            await this.sendMessage(message);
        } catch (error) {
            LOGGER.error(`[TELEGRAM] Failed to send startup message: ${error.message}`);
            console.error('[DEBUG] Full error:', error);
        }
    }

    static async sendHourlySummary() {
        const statsSnapshot = { ...state.hourlyStats };

        if (statsSnapshot.trades === 0) {
            LOGGER.info(
                '📱 Telegram: Skipping hourly summary (no trades this hour)'
            );
            return;
        }

        const totalTrades = statsSnapshot.wins + statsSnapshot.losses;
        const winRate =
            totalTrades > 0
                ? ((statsSnapshot.wins / totalTrades) * 100).toFixed(1)
                : 0;
        const pnlEmoji = statsSnapshot.pnl >= 0 ? '🟢' : '🔴';
        const pnlStr =
            (statsSnapshot.pnl >= 0 ? '+' : '') +
            '$' +
            statsSnapshot.pnl.toFixed(2);

        const today = TradeHistoryManager.getTodayStats();
        const overall = TradeHistoryManager.getOverallStats();

        // Per-asset hourly info
        let assetInfo = '';
        ACTIVE_ASSETS.forEach(symbol => {
            const a = state.assets[symbol];
            if (a) {
                const ac = getAssetConfig(symbol);
                assetInfo += `\n  ${symbol} (${ac.TIMEFRAME_LABEL}/${ac.DURATION}${ac.DURATION_UNIT}): Mart=${a.martingaleLevel}, Stake=$${a.currentStake.toFixed(2)}, P/L=$${a.netPL.toFixed(2)}`;
            }
        });

        const message = `
            ⏰ <b>Rise/Fall Bot Hourly Summary</b>

            📊 <b>Last Hour</b>
            ├ Trades: ${statsSnapshot.trades}
            ├ Wins: ${statsSnapshot.wins} | Losses: ${statsSnapshot.losses}
            ├ Win Rate: ${winRate}%
            └ ${pnlEmoji} <b>P&L:</b> ${pnlStr}

            📅 <b>Today (${TradeHistoryManager.getDateKey()})</b>
            ├ Total Trades: ${today.tradesCount}
            ├ Total W/L: ${today.winsCount}/${today.lossesCount}
            └ Today P&L: ${today.netPL >= 0 ? '+' : ''}$${today.netPL.toFixed(2)}

            📈 <b>Overall (All Time)</b>
            ├ Total Trades: ${overall.tradesCount}
            ├ Total W/L: ${overall.winsCount}/${overall.lossesCount}
            └ Overall P&L: ${overall.netPL >= 0 ? '+' : ''}$${overall.netPL.toFixed(2)}

            💰 Current Capital: $${state.capital.toFixed(2)}

            🔧 <b>Per-Asset Status:</b>${assetInfo}
        `.trim();

        try {
            await this.sendMessage(message);
            LOGGER.info('📱 Telegram: Hourly Summary sent');
            LOGGER.info(
                `   📊 Hour Stats: ${statsSnapshot.trades} trades, ${statsSnapshot.wins}W/${statsSnapshot.losses}L, ${pnlStr}`
            );
        } catch (error) {
            LOGGER.error(
                `❌ Telegram hourly summary failed: ${error.message}`
            );
        }

        state.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };
    }

    static startHourlyTimer() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1);
        nextHour.setMinutes(0);
        nextHour.setSeconds(0);
        nextHour.setMilliseconds(0);

        const timeUntilNextHour = nextHour.getTime() - now.getTime();

        setTimeout(() => {
            this.sendSessionSummary();
            setInterval(() => {
                this.sendSessionSummary();
            }, 60 * 60 * 1000);
        }, timeUntilNextHour);
    }
}

// ============================================
// LOGGER UTILITY
// ============================================
const getGMTTime = () =>
    new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';

const LOGGER = {
    info: msg => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: msg =>
        console.log(
            `\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`
        ),
    warn: msg =>
        console.warn(
            `\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`
        ),
    error: msg =>
        console.error(
            `\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`
        ),
    debug: msg => {
        if (CONFIG.DEBUG_MODE)
            console.log(
                `\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`
            );
    }
};

// ============================================
// CANDLE ANALYSIS UTILITY
// ============================================
class CandleAnalyzer {
    static isBullish(candle) {
        return candle.close > candle.open;
    }

    static isBearish(candle) {
        return candle.close < candle.open;
    }

    static getLastClosedCandle(symbol) {
        const assetState = state.assets[symbol];
        if (
            !assetState ||
            !assetState.closedCandles ||
            assetState.closedCandles.length === 0
        ) {
            return null;
        }
        return assetState.closedCandles[
            assetState.closedCandles.length - 1
        ];
    }

    static getCandleDirection(candle) {
        if (this.isBullish(candle)) return 'BULLISH';
        if (this.isBearish(candle)) return 'BEARISH';
        return 'DOJI';
    }
}

// ============================================
// TECHNICAL INDICATORS — EMA CROSSOVER
// ============================================
class TechnicalIndicators {
    /**
     * Calculate Exponential Moving Average (EMA) for an array of close prices.
     * Uses the standard EMA formula: EMA = price * k + prevEMA * (1 - k)
     * where k = 2 / (period + 1)
     * Returns array of EMA values aligned to the end of the candles array.
     * Returns null values for indices where not enough data exists.
     * @param {Array} closedCandles - Array of candle objects with .close property
     * @param {number} period - EMA period (e.g. 20 or 50)
     * @returns {Array} Array of EMA values (same length as closedCandles)
     */
    static calculateEMA(closedCandles, period) {
        const result = new Array(closedCandles.length).fill(null);
        if (!closedCandles || closedCandles.length < period) {
            return result; // Not enough data
        }

        const k = 2 / (period + 1);

        // Seed EMA with SMA of first `period` candles
        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += closedCandles[i].close;
        }
        let ema = sum / period;
        result[period - 1] = ema;

        // Walk forward and compute EMA for each subsequent candle
        for (let i = period; i < closedCandles.length; i++) {
            ema = closedCandles[i].close * k + ema * (1 - k);
            result[i] = ema;
        }

        return result;
    }

    /**
     * Compute EMA crossover signal from closed candles.
     * Returns an object with:
     *   - emaFast      {number|null}  Current fast EMA value
     *   - emaSlow      {number|null}  Current slow EMA value
     *   - prevEmaFast  {number|null}  Previous bar fast EMA value
     *   - prevEmaSlow  {number|null}  Previous bar slow EMA value
     *   - signal       {'BULL_CROSS'|'BEAR_CROSS'|null}
     *       BULL_CROSS  → fast crossed ABOVE slow on the just-closed candle (→ RISE / CALLE)
     *       BEAR_CROSS  → fast crossed BELOW slow on the just-closed candle (→ FALL / PUTE)
     *       null        → no crossover on this bar
     *   - isAbove      {boolean|null} Whether fast EMA is currently above slow EMA
     * @param {Array} closedCandles
     * @returns {Object}
     */
    static getEMACrossoverSignal(closedCandles) {
        const fastPeriod = CONFIG.EMA_FAST_PERIOD;
        const slowPeriod = CONFIG.EMA_SLOW_PERIOD;

        const emptyResult = {
            emaFast: null,
            emaSlow: null,
            prevEmaFast: null,
            prevEmaSlow: null,
            signal: null,
            isAbove: null
        };

        if (!closedCandles || closedCandles.length < slowPeriod + 1) {
            return emptyResult; // Need at least slowPeriod+1 bars to detect a cross
        }

        const emaFastArr = this.calculateEMA(closedCandles, fastPeriod);
        const emaSlowArr = this.calculateEMA(closedCandles, slowPeriod);

        const len = closedCandles.length;
        const curFast = emaFastArr[len - 1];
        const curSlow = emaSlowArr[len - 1];
        const prevFast = emaFastArr[len - 2];
        const prevSlow = emaSlowArr[len - 2];

        if (curFast === null || curSlow === null || prevFast === null || prevSlow === null) {
            return emptyResult;
        }

        const isAbove = curFast > curSlow;

        // Bullish crossover: fast was BELOW (or equal) slow, now ABOVE
        if (prevFast <= prevSlow && curFast > curSlow) {
            return { emaFast: curFast, emaSlow: curSlow, prevEmaFast: prevFast, prevEmaSlow: prevSlow, signal: 'BULL_CROSS', isAbove };
        }

        // Bearish crossover: fast was ABOVE (or equal) slow, now BELOW
        if (prevFast >= prevSlow && curFast < curSlow) {
            return { emaFast: curFast, emaSlow: curSlow, prevEmaFast: prevFast, prevEmaSlow: prevSlow, signal: 'BEAR_CROSS', isAbove };
        }

        return { emaFast: curFast, emaSlow: curSlow, prevEmaFast: prevFast, prevEmaSlow: prevSlow, signal: null, isAbove };
    }
}

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // API Settings
    API_TOKEN: '0P94g4WdSrSrzir',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Capital Settings
    INITIAL_CAPITAL: 500,
    STAKE: 0.35,

    // Session Targets
    SESSION_PROFIT_TARGET: 50000,
    SESSION_STOP_LOSS: -250,

    // Default Candle Settings (used if asset has no specific config)
    // NOTE: Must be > EMA_SLOW_PERIOD (50) to allow EMA calculation
    GRANULARITY: 60,
    TIMEFRAME_LABEL: '1m',
    MAX_CANDLES_STORED: 300,
    CANDLES_TO_LOAD: 300,

    // Default Trade Duration Settings (used if asset has no specific config)
    DURATION: 54,
    DURATION_UNIT: 's',

    // Trade Settings — NOW PER ASSET
    MAX_OPEN_POSITIONS_PER_ASSET: 1,
    TRADE_DELAY: 1000,
    MARTINGALE_MULTIPLIER: 1.48,
    MARTINGALE_MULTIPLIER2: 2.0,
    MARTINGALE_MULTIPLIER3: 2.1,
    MARTINGALE_MULTIPLIER4: 2.2,
    MARTINGALE_MULTIPLIER5: 2.3,
    // MARTINGALE_MULTIPLIER6: 3.0,
    MAX_MARTINGALE_STEPS: 9,
    System: 1,
    iDirection: 'RISE',

    // ============================================
    // EMA CROSSOVER SETTINGS
    // ============================================
    EMA_FAST_PERIOD: 20,   // Fast EMA period — adjustable (e.g., 20)
    EMA_SLOW_PERIOD: 50,  // Slow EMA period — adjustable (e.g., 50)

    // ============================================
    // TRADING SESSION TOGGLE
    // true  = only trade during defined session windows below (recovery allowed anytime)
    // false = trade 24/7 (ignore session windows entirely)
    // ============================================
    USE_TRADING_SESSIONS: false,

    // ============================================
    // TRADING SESSION WINDOWS (GMT+1 hours)
    // ============================================
    TOKYO_START: 1,
    TOKYO_END: 2,
    LONDON_START: 8,
    LONDON_END: 9,
    NEWYORK_START: 14,
    NEWYORK_END: 15,
    SYDNEY_START: 22,
    SYDNEY_END: 23,

    // Debug
    DEBUG_MODE: true,

    // Telegram Settings
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '7683695132:AAGA9_4uDcyZWEOAwv1_zj7Nnz5Oy0gVw04',
    TELEGRAM_CHAT_ID: '752497117'
};

// ============================================
// ASSET-SPECIFIC CONFIGURATIONS
// ============================================
// Override default candle/duration settings per asset.
// Any setting not specified here will fall back to CONFIG defaults.
const ASSET_CONFIGS = {
    R_10: {
        GRANULARITY: 60,
        TIMEFRAME_LABEL: '1m',
        MAX_CANDLES_STORED: 300,
        CANDLES_TO_LOAD: 300,
        DURATION: 54,
        DURATION_UNIT: 's'
    },
    R_25: {
        GRANULARITY: 60,
        TIMEFRAME_LABEL: '1m',
        MAX_CANDLES_STORED: 300,
        CANDLES_TO_LOAD: 300,
        DURATION: 54,
        DURATION_UNIT: 's'
    },
    R_50: {
        GRANULARITY: 60,        
        TIMEFRAME_LABEL: '1m',
        MAX_CANDLES_STORED: 300,
        CANDLES_TO_LOAD: 300,
        DURATION: 54,           
        DURATION_UNIT: 's'
    },
    R_75: {
        GRANULARITY: 60,
        TIMEFRAME_LABEL: '1m',
        MAX_CANDLES_STORED: 300,
        CANDLES_TO_LOAD: 300,
        DURATION: 54,
        DURATION_UNIT: 's'
    },
    R_100: {
        GRANULARITY: 60,        
        TIMEFRAME_LABEL: '1m',
        MAX_CANDLES_STORED: 300,
        CANDLES_TO_LOAD: 300,
        DURATION: 54,             
        DURATION_UNIT: 's'      
    }
};

/**
 * Get the merged configuration for a specific asset.
 * Falls back to CONFIG defaults for any missing keys.
 */
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

let ACTIVE_ASSETS = ['R_10', 'R_75', 'R_100', '1HZ50V', 'stpRNG', 'stpRNG2'];
// let ACTIVE_ASSETS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V', 'stpRNG', 'stpRNG2', 'stpRNG3', 'stpRNG4', 'stpRNG5'];

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    assets: {},
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    currentTradeDay: null, // Track current trading day for day-change detection
    session: {
        profit: 0,
        loss: 0,
        netPL: 0,
        tradesCount: 0,
        winsCount: 0,
        lossesCount: 0,
        x2Losses: 0,
        x3Losses: 0,
        x4Losses: 0,
        x5Losses: 0,
        x6Losses: 0,
        x7Losses: 0,
        x8Losses: 0,
        x9Losses: 0,
        isActive: true,
        startTime: Date.now(),
        startCapital: CONFIG.INITIAL_CAPITAL
    },
    isConnected: false,
    isAuthorized: false,
    portfolio: {
        dailyProfit: 0,
        dailyLoss: 0,
        dailyWins: 0,
        dailyLosses: 0
    },
    hourlyStats: {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        lastHour: new Date().getHours()
    },
    requestId: 1,
    // Track whether we've logged "outside session" to avoid log spam
    lastSessionLogTime: 0
};

// ============================================
// TRADE HISTORY (loaded at startup)
// ============================================
let tradeHistory = null; // Will be initialized after LOGGER is available

// ============================================
// TRADING SESSION HELPER
// ============================================
class TradingSessionManager {
    static getGMTPlus1Time() {
        const now = new Date();
        const gmtPlus1 = new Date(now.getTime() + (1 * 60 * 60 * 1000));
        return gmtPlus1;
    }

    static isWithinTradingSession() {
        const gmtPlus1 = this.getGMTPlus1Time();
        const currentHour = gmtPlus1.getUTCHours();
        const currentMinute = gmtPlus1.getUTCMinutes();
        const currentTimeDecimal = currentHour + (currentMinute / 60);

        if (currentTimeDecimal >= CONFIG.TOKYO_START && currentTimeDecimal < CONFIG.TOKYO_END) {
            return {
                inSession: true,
                sessionName: 'TOKYO',
                nextSession: null,
                minutesUntilNext: 0
            };
        }

        if (currentTimeDecimal >= CONFIG.LONDON_START && currentTimeDecimal < CONFIG.LONDON_END) {
            return {
                inSession: true,
                sessionName: 'LONDON',
                nextSession: null,
                minutesUntilNext: 0
            };
        }

        if (currentTimeDecimal >= CONFIG.NEWYORK_START && currentTimeDecimal < CONFIG.NEWYORK_END) {
            return {
                inSession: true,
                sessionName: 'NEW YORK',
                nextSession: null,
                minutesUntilNext: 0
            };
        }

        // SYDNEY session check (handles both normal and overnight sessions)
        // If END < START, it's an overnight session (e.g., 23:00-00:00)
        if (CONFIG.SYDNEY_END < CONFIG.SYDNEY_START) {
            // Overnight session: >= START OR < END
            if (currentTimeDecimal >= CONFIG.SYDNEY_START || currentTimeDecimal < CONFIG.SYDNEY_END) {
                return {
                    inSession: true,
                    sessionName: 'SYDNEY',
                    nextSession: null,
                    minutesUntilNext: 0
                };
            }
        } else {
            // Normal session: START <= time < END
            if (currentTimeDecimal >= CONFIG.SYDNEY_START && currentTimeDecimal < CONFIG.SYDNEY_END) {
                return {
                    inSession: true,
                    sessionName: 'SYDNEY',
                    nextSession: null,
                    minutesUntilNext: 0
                };
            }
        }


        let nextSession = '';
        let minutesUntilNext = 0;

        if (currentTimeDecimal < CONFIG.TOKYO_START) {
            nextSession = 'TOKYO';
            minutesUntilNext = (CONFIG.TOKYO_START - currentTimeDecimal) * 60;
        } else if (currentTimeDecimal < CONFIG.LONDON_START) {
            nextSession = 'LONDON';
            minutesUntilNext = (CONFIG.LONDON_START - currentTimeDecimal) * 60;
        } else if (currentTimeDecimal < CONFIG.NEWYORK_START) {
            nextSession = 'NEW YORK';
            minutesUntilNext = (CONFIG.NEWYORK_START - currentTimeDecimal) * 60;
        } else if (currentTimeDecimal < CONFIG.SYDNEY_START) {
            nextSession = 'SYDNEY';
            minutesUntilNext = (CONFIG.SYDNEY_START - currentTimeDecimal) * 60;
        } else {
            nextSession = 'TOKYO';
            minutesUntilNext = ((24 - currentTimeDecimal) + CONFIG.TOKYO_START) * 60;
        }

        return {
            inSession: false,
            sessionName: null,
            nextSession: nextSession,
            minutesUntilNext: Math.round(minutesUntilNext)
        };
    }

    static getSessionStatusString() {
        const sessionInfo = this.isWithinTradingSession();
        const gmtPlus1 = this.getGMTPlus1Time();
        const timeStr = `${String(gmtPlus1.getUTCHours()).padStart(2, '0')}:${String(gmtPlus1.getUTCMinutes()).padStart(2, '0')} GMT+1`;

        if (sessionInfo.inSession) {
            return `🟢 IN SESSION: ${sessionInfo.sessionName} (${timeStr})`;
        } else {
            return `🔴 OUTSIDE SESSION (${timeStr}) — Next: ${sessionInfo.nextSession} in ${sessionInfo.minutesUntilNext}min`;
        }
    }
}

// ============================================
// SESSION MANAGER
// ============================================
class SessionManager {
    static isSessionActive() {
        return state.session.isActive;
    }

    static checkSessionTargets() {
        const netPL = state.session.netPL;

        if (netPL >= CONFIG.SESSION_PROFIT_TARGET) {
            LOGGER.trade(
                `🎯 SESSION PROFIT TARGET REACHED! Net P/L: $${netPL.toFixed(2)}`
            );
            this.endSession('PROFIT_TARGET');
            return true;
        }

        if (netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.error(
                `🛑 SESSION STOP LOSS REACHED! Net P/L: $${netPL.toFixed(2)}`
            );
            this.endSession('STOP_LOSS');
            return true;
        }

        // Check if ANY asset has hit max martingale
        let anyMaxMartingale = false;
        ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset && asset.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS) {
                LOGGER.warn(
                    `⚠️ ${symbol} hit max martingale level (${CONFIG.MAX_MARTINGALE_STEPS}), resetting that asset's martingale`
                );
                // asset.martingaleLevel = 0;
                // asset.currentStake = CONFIG.STAKE;
            }
        });

        if (anyMaxMartingale) {
            this.endSession('MAX_MARTINGALE');
            return true;
        }

        return false;
    }

    static async endSession(reason) {
        state.session.isActive = false;
        LOGGER.info(`⏸️ Session ended (${reason}).`);
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
            winRate:
                state.session.tradesCount > 0
                    ? (
                        (state.session.winsCount /
                            state.session.tradesCount) *
                        100
                    ).toFixed(1) + '%'
                    : '0%',
            x2Losses: state.session.x2Losses,
            x3Losses: state.session.x3Losses,
            x4Losses: state.session.x4Losses,
            x5Losses: state.session.x5Losses,
            x6Losses: state.session.x6Losses,
            x7Losses: state.session.x7Losses,
            x8Losses: state.session.x8Losses,
            x9Losses: state.session.x9Losses,
            netPL: state.session.netPL
        };
    }

    /**
     * Check if the trading day has changed. If so, archive today's session stats
     * and start fresh session stats for the new day.
     */
    static checkDayChange() {
        const currentDay = TradeHistoryManager.getDateKey();

        if (state.currentTradeDay && state.currentTradeDay !== currentDay) {
            LOGGER.info(`📅 Day changed from ${state.currentTradeDay} to ${currentDay}`);

            // Send end-of-day summary for the previous day
            TelegramService.sendDayEndSummary(state.currentTradeDay);

            // Reset session stats for the new day
            this.resetSessionForNewDay();
        }

        state.currentTradeDay = currentDay;
    }

    static resetSessionForNewDay() {
        LOGGER.info('📅 Resetting session stats for new trading day...');

        // Reset global session stats (daily counters)
        state.session.tradesCount = 0;
        state.session.winsCount = 0;
        state.session.lossesCount = 0;
        state.session.profit = 0;
        state.session.loss = 0;
        state.session.netPL = 0;
        state.session.x2Losses = 0;
        state.session.x3Losses = 0;
        state.session.x4Losses = 0;
        state.session.x5Losses = 0;
        state.session.x6Losses = 0;
        state.session.x7Losses = 0;
        state.session.x8Losses = 0;
        state.session.x9Losses = 0;
        state.session.startTime = Date.now();
        state.session.startCapital = state.capital;
        state.lastSessionLogTime = 0;

        // Reset per-asset daily stats BUT preserve martingale state
        ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset) {
                // Reset daily counters
                asset.tradesCount = 0;
                asset.winsCount = 0;
                asset.lossesCount = 0;
                asset.profit = 0;
                asset.loss = 0;
                asset.netPL = 0;
                asset.x2Losses = 0;
                asset.x3Losses = 0;
                asset.x4Losses = 0;
                asset.x5Losses = 0;
                asset.x6Losses = 0;
                asset.x7Losses = 0;
                asset.x8Losses = 0;
                asset.x9Losses = 0;
                // Reset last-traded cross signal so EMA signal can re-fire on new day
                asset.lastCrossSignalDirection = null;

                // NOTE: We do NOT reset martingaleLevel, currentStake,
                // lastTradeWasWin, lastTradeDirection, lastEmaFast, lastEmaSlow here
                // so recovery chains and EMA state carry over between days if needed
            }
        });

        // Reset portfolio daily stats
        state.portfolio.dailyProfit = 0;
        state.portfolio.dailyLoss = 0;
        state.portfolio.dailyWins = 0;
        state.portfolio.dailyLosses = 0;

        // Reset hourly stats
        state.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            lastHour: new Date().getHours()
        };

        // Update today entry in history with start capital
        TradeHistoryManager.ensureDayEntry(TradeHistoryManager.getDateKey());
        tradeHistory.dailyHistory[TradeHistoryManager.getDateKey()].startCapital = state.capital;
        TradeHistoryManager.saveHistory();

        LOGGER.info('📊 Daily stats reset for new day (martingale state preserved)');
    }

    /**
     * Record trade result FOR A SPECIFIC ASSET
     * Updates both the per-asset stats AND the global session stats,
     * AND records into persistent trade history
     */
    static recordTradeResult(symbol, profit, direction) {
        const assetState = state.assets[symbol];
        if (!assetState) {
            LOGGER.error(`recordTradeResult: Unknown symbol ${symbol}`);
            return;
        }

        // Check for day change before recording
        this.checkDayChange();

        // ---- Hourly stats (global) ----
        const currentHour = new Date().getHours();
        if (currentHour !== state.hourlyStats.lastHour) {
            LOGGER.warn(
                `⏰ Hour changed detected (${state.hourlyStats.lastHour} → ${currentHour}), resetting hourly stats`
            );
            state.hourlyStats = {
                trades: 0,
                wins: 0,
                losses: 0,
                pnl: 0,
                lastHour: currentHour
            };
        }

        // ---- Global session stats ----
        state.session.tradesCount++;
        state.capital += profit;
        state.hourlyStats.trades++;
        state.hourlyStats.pnl += profit;

        // ---- Per-asset stats ----
        assetState.tradesCount++;

        if (profit > 0) {
            // === WIN ===
            // Global
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            state.hourlyStats.wins++;

            // Per-asset
            assetState.winsCount++;
            assetState.profit += profit;
            assetState.netPL += profit;
            assetState.martingaleLevel = 0;
            assetState.lastTradeWasWin = true;
            assetState.currentStake = CONFIG.STAKE;

            // Record in persistent history
            TradeHistoryManager.recordTrade(symbol, profit, assetState.martingaleLevel);

            LOGGER.trade(
                `✅ [${symbol}] WIN: +$${profit.toFixed(2)} | Direction: ${direction} | ${symbol} Martingale Reset | ${symbol} P/L: $${assetState.netPL.toFixed(2)}`
            );
        } else {
            // === LOSS ===
            // Global
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            state.hourlyStats.losses++;

            // Per-asset
            assetState.lossesCount++;
            assetState.loss += Math.abs(profit);
            assetState.netPL += profit;
            assetState.martingaleLevel++;
            assetState.lastTradeWasWin = false;

            // Track consecutive loss stats (per-asset session)
            if (assetState.martingaleLevel === 2) assetState.x2Losses++;
            if (assetState.martingaleLevel === 3) assetState.x3Losses++;
            if (assetState.martingaleLevel === 4) assetState.x4Losses++;
            if (assetState.martingaleLevel === 5) assetState.x5Losses++;
            if (assetState.martingaleLevel === 6) assetState.x6Losses++;
            if (assetState.martingaleLevel === 7) assetState.x7Losses++;
            if (assetState.martingaleLevel === 8) assetState.x8Losses++;
            if (assetState.martingaleLevel === 9) assetState.x9Losses++;

            // Also track in global session
            if (assetState.martingaleLevel === 2) state.session.x2Losses++;
            if (assetState.martingaleLevel === 3) state.session.x3Losses++;
            if (assetState.martingaleLevel === 4) state.session.x4Losses++;
            if (assetState.martingaleLevel === 5) state.session.x5Losses++;
            if (assetState.martingaleLevel === 6) state.session.x6Losses++;
            if (assetState.martingaleLevel === 7) state.session.x7Losses++;
            if (assetState.martingaleLevel === 8) state.session.x8Losses++;
            if (assetState.martingaleLevel === 9) state.session.x9Losses++;

            // Record in persistent history (pass martingale level for loss tracking)
            TradeHistoryManager.recordTrade(symbol, profit, assetState.martingaleLevel);

            // Martingale stake calculation (per-asset)
            if (assetState.martingaleLevel <= 3) {
                assetState.currentStake =
                    Math.ceil(
                        assetState.currentStake *
                        CONFIG.MARTINGALE_MULTIPLIER *
                        100
                    ) / 100;
            } else if (assetState.martingaleLevel >= 4 && assetState.martingaleLevel <= 5) {
                assetState.currentStake =
                    Math.ceil(
                        assetState.currentStake *
                        CONFIG.MARTINGALE_MULTIPLIER2 *
                        100
                    ) / 100;
            } else if (assetState.martingaleLevel >= 6 && assetState.martingaleLevel <= 7) {
                assetState.currentStake =
                    Math.ceil(
                        assetState.currentStake *
                        CONFIG.MARTINGALE_MULTIPLIER3 *
                        100
                    ) / 100;
            } else if (assetState.martingaleLevel === 8) {
                assetState.currentStake =
                    Math.ceil(
                        assetState.currentStake *
                        CONFIG.MARTINGALE_MULTIPLIER4 *
                        100
                    ) / 100;
            } else if (assetState.martingaleLevel === 9) {
                assetState.currentStake =
                    Math.ceil(
                        assetState.currentStake *
                        CONFIG.MARTINGALE_MULTIPLIER5 *
                        100
                    ) / 100;
            } 
            // else if (assetState.martingaleLevel === 6) {
            //     assetState.currentStake =
            //         Math.ceil(
            //             assetState.currentStake *
            //             CONFIG.MARTINGALE_MULTIPLIER6 *
            //             100
            //         ) / 100;
            // }

            if (assetState.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS) {
                LOGGER.warn(
                    `⚠️ [${symbol}] Maximum Martingale step reached (${CONFIG.MAX_MARTINGALE_STEPS}), resetting ${symbol} martingale to 0`
                );
                assetState.martingaleLevel = 0;
                assetState.currentStake = CONFIG.STAKE;
            } else {
                LOGGER.trade(
                    `❌ [${symbol}] LOSS: -$${Math.abs(profit).toFixed(2)} | Direction: ${direction} | ${symbol} Next Martingale Level: ${assetState.martingaleLevel} | ${symbol} Next Stake: $${assetState.currentStake.toFixed(2)} | ${symbol} P/L: $${assetState.netPL.toFixed(2)}`
                );
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
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            LOGGER.info('Already connected');
            return;
        }

        LOGGER.info('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket(
            `${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`
        );

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

        if (!this.autoSaveStarted) {
            StatePersistence.startAutoSave();
            this.autoSaveStarted = true;
        }

        this.send({ authorize: CONFIG.API_TOKEN });
    }

    initializeAssets() {
        ACTIVE_ASSETS.forEach(symbol => {
            if (!state.assets[symbol]) {
                state.assets[symbol] = {
                    // Candle data
                    candles: [],
                    closedCandles: [],
                    currentFormingCandle: null,
                    lastProcessedCandleOpenTime: null,
                    candlesLoaded: false,
                    // EMA data
                    lastEmaFast: null,          // Most recent fast EMA value
                    lastEmaSlow: null,          // Most recent slow EMA value
                    prevEmaFast: null,          // Previous bar fast EMA value
                    prevEmaSlow: null,          // Previous bar slow EMA value
                    lastEmaSignal: null,        // 'BULL_CROSS' | 'BEAR_CROSS' | null
                    lastEmaIsAbove: null,       // Is fast EMA currently above slow EMA?
                    lastCrossSignalDirection: null, // Direction of last crossover that was traded ('CALLE'|'PUTE')
                    // === PER-ASSET TRADE MANAGEMENT ===
                    lastTradeDirection: null,
                    lastTradeWasWin: null,
                    martingaleLevel: 0,
                    currentStake: CONFIG.STAKE,
                    canTrade: false,
                    // === PER-ASSET POSITIONS ===
                    activePositions: [],
                    // === PER-ASSET STATS (today's session) ===
                    tradesCount: 0,
                    winsCount: 0,
                    lossesCount: 0,
                    profit: 0,
                    loss: 0,
                    netPL: 0,
                    x2Losses: 0,
                    x3Losses: 0,
                    x4Losses: 0,
                    x5Losses: 0,
                    x6Losses: 0,
                    x7Losses: 0,
                    x8Losses: 0,
                    x9Losses: 0
                };
                const ac = getAssetConfig(symbol);
                LOGGER.info(`📊 Initialized asset: ${symbol} (${ac.TIMEFRAME_LABEL} candles, Duration: ${ac.DURATION}${ac.DURATION_UNIT})`);
            } else {
                const ac = getAssetConfig(symbol);
                LOGGER.info(
                    `📊 Asset ${symbol} already initialized (state restored) — ${ac.TIMEFRAME_LABEL}/${ac.DURATION}${ac.DURATION_UNIT} Mart=${state.assets[symbol].martingaleLevel}, Stake=$${state.assets[symbol].currentStake.toFixed(2)}`
                );
            }
        });
    }

    restoreSubscriptions() {
        LOGGER.info('📊 Restoring subscriptions after reconnection...');
        ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset && asset.activePositions) {
                asset.activePositions.forEach(pos => {
                    if (pos.contractId) {
                        LOGGER.info(
                            `  ✅ Re-subscribing to contract ${pos.contractId} (${symbol})`
                        );
                        this.send({
                            proposal_open_contract: 1,
                            contract_id: pos.contractId,
                            subscribe: 1
                        });
                    }
                });
            }
        });
    }

    cleanup() {
        if (this.ws) {
            this.ws.removeAllListeners();
            if (
                this.ws.readyState === WebSocket.OPEN ||
                this.ws.readyState === WebSocket.CONNECTING
            ) {
                try {
                    this.ws.close();
                } catch (e) {
                    LOGGER.debug('WebSocket already closed');
                }
            }
            this.ws = null;
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
            if (response.error) {
                LOGGER.error(
                    `Authorization failed: ${response.error.message}`
                );
                return;
            }
            LOGGER.info('🔐 Authorized successfully');
            LOGGER.info(`👤 Account: ${response.authorize.loginid}`);
            LOGGER.info(
                `💰 Balance: ${response.authorize.balance} ${response.authorize.currency}`
            );

            state.isAuthorized = true;
            state.accountBalance = response.authorize.balance;

            if (state.capital === CONFIG.INITIAL_CAPITAL) {
                state.capital = response.authorize.balance;
            }

            this.send({ balance: 1, subscribe: 1 });

            if (this.reconnectAttempts > 0 || this.hasAnyActivePositions()) {
                LOGGER.info('🔄 Reconnection detected, restoring subscriptions...');
                this.restoreSubscriptions();
            }

            bot.start();
        }

        if (response.msg_type === 'balance') {
            state.accountBalance = response.balance.balance;
        }

        if (response.msg_type === 'ohlc') {
            this.handleOHLC(response.ohlc);
        }

        if (response.msg_type === 'candles') {
            this.handleCandlesHistory(response);
        }

        if (response.msg_type === 'buy') {
            this.handleBuyResponse(response);
        }

        if (response.msg_type === 'proposal_open_contract') {
            this.handleOpenContract(response);
        }
    }

    /**
     * Check if any asset has active positions
     */
    hasAnyActivePositions() {
        return ACTIVE_ASSETS.some(symbol => {
            const asset = state.assets[symbol];
            return asset && asset.activePositions && asset.activePositions.length > 0;
        });
    }

    /**
     * Get total active positions count across all assets
     */
    getTotalActivePositions() {
        let total = 0;
        ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset && asset.activePositions) {
                total += asset.activePositions.length;
            }
        });
        return total;
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);

            const reqId = response.echo_req?.req_id;
            if (reqId) {
                // Find and remove the position from the correct asset
                ACTIVE_ASSETS.forEach(symbol => {
                    const asset = state.assets[symbol];
                    if (asset && asset.activePositions) {
                        const posIndex = asset.activePositions.findIndex(
                            p => p.reqId === reqId
                        );
                        if (posIndex >= 0) {
                            asset.activePositions.splice(posIndex, 1);
                            LOGGER.info(`  Removed failed position from ${symbol}`);
                        }
                    }
                });
            }
            return;
        }

        const contract = response.buy;
        LOGGER.trade(
            `✅ Position opened: Contract ${contract.contract_id}, Buy Price: $${contract.buy_price}`
        );

        const reqId = response.echo_req.req_id;

        // Find the position in the correct asset
        let foundSymbol = null;
        let position = null;

        for (const symbol of ACTIVE_ASSETS) {
            const asset = state.assets[symbol];
            if (asset && asset.activePositions) {
                position = asset.activePositions.find(p => p.reqId === reqId);
                if (position) {
                    foundSymbol = symbol;
                    break;
                }
            }
        }

        if (position) {
            position.contractId = contract.contract_id;
            position.buyPrice = contract.buy_price;

            TelegramService.sendTradeAlert(
                'OPEN',
                position.symbol,
                position.direction,
                position.stake,
                position.duration,
                position.durationUnit
            );
        }

        this.send({
            proposal_open_contract: 1,
            contract_id: contract.contract_id,
            subscribe: 1
        });
    }

    handleOpenContract(response) {
        if (response.error) {
            LOGGER.error(`Contract error: ${response.error.message}`);
            return;
        }

        const contract = response.proposal_open_contract;
        const contractId = contract.contract_id;

        // Find which asset owns this contract
        let ownerSymbol = null;
        let posIndex = -1;

        for (const symbol of ACTIVE_ASSETS) {
            const asset = state.assets[symbol];
            if (asset && asset.activePositions) {
                const idx = asset.activePositions.findIndex(
                    p => p.contractId === contractId
                );
                if (idx >= 0) {
                    ownerSymbol = symbol;
                    posIndex = idx;
                    break;
                }
            }
        }

        if (posIndex < 0 || !ownerSymbol) return;

        const assetState = state.assets[ownerSymbol];
        const position = assetState.activePositions[posIndex];
        position.currentProfit = contract.profit;

        if (
            contract.is_sold ||
            contract.is_expired ||
            contract.status === 'sold'
        ) {
            const profit = contract.profit;

            LOGGER.trade(
                `[${ownerSymbol}] Contract ${contractId} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`
            );

            // Record result for THIS SPECIFIC ASSET
            SessionManager.recordTradeResult(
                ownerSymbol,
                profit,
                position.direction
            );

            TelegramService.sendTradeAlert(
                profit >= 0 ? 'WIN' : 'LOSS',
                ownerSymbol,
                position.direction,
                position.stake,
                position.duration,
                position.durationUnit,
                { profit }
            );

            // Remove position from THIS asset
            assetState.activePositions.splice(posIndex, 1);

            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }

            SessionManager.checkSessionTargets();
            StatePersistence.saveState();
        }
    }

    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        if (!state.assets[symbol]) return;

        const assetState = state.assets[symbol];
        const assetConfig = getAssetConfig(symbol);
        const granularity = assetConfig.GRANULARITY;

        const calculatedOpenTime =
            ohlc.open_time ||
            Math.floor(ohlc.epoch / granularity) * granularity;

        const incomingCandle = {
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close),
            epoch: ohlc.epoch,
            open_time: calculatedOpenTime
        };

        const currentOpenTime =
            assetState.currentFormingCandle?.open_time;
        const isNewCandle =
            currentOpenTime &&
            incomingCandle.open_time !== currentOpenTime;

        if (isNewCandle) {
            const closedCandle = {
                ...assetState.currentFormingCandle
            };
            closedCandle.epoch =
                closedCandle.open_time + granularity;

            if (
                closedCandle.open_time !==
                assetState.lastProcessedCandleOpenTime
            ) {
                assetState.closedCandles.push(closedCandle);

                if (
                    assetState.closedCandles.length >
                    assetConfig.MAX_CANDLES_STORED
                ) {
                    assetState.closedCandles =
                        assetState.closedCandles.slice(
                            -assetConfig.MAX_CANDLES_STORED
                        );
                }

                assetState.lastProcessedCandleOpenTime =
                    closedCandle.open_time;

                const closeTime = new Date(
                    closedCandle.epoch * 1000
                ).toISOString();
                const candleType =
                    CandleAnalyzer.getCandleDirection(closedCandle);
                const candleEmoji =
                    candleType === 'BULLISH'
                        ? '🟢'
                        : candleType === 'BEARISH'
                            ? '🔴'
                            : '⚪';

                LOGGER.info(
                    `${symbol} ${candleEmoji} CANDLE CLOSED [${closeTime}] ${candleType}: O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)}`
                );

                // ── Update EMA values on every closed candle ─────────────────
                const emaResult = TechnicalIndicators.getEMACrossoverSignal(assetState.closedCandles);

                assetState.prevEmaFast = assetState.lastEmaFast;
                assetState.prevEmaSlow = assetState.lastEmaSlow;
                assetState.lastEmaFast = emaResult.emaFast;
                assetState.lastEmaSlow = emaResult.emaSlow;
                assetState.lastEmaSignal = emaResult.signal;
                assetState.lastEmaIsAbove = emaResult.isAbove;

                if (emaResult.emaFast !== null && emaResult.emaSlow !== null) {
                    const crossTag = emaResult.signal
                        ? (emaResult.signal === 'BULL_CROSS' ? ' 🔔 BULL CROSS' : ' 🔔 BEAR CROSS')
                        : '';
                    LOGGER.info(
                        `${symbol} 📈 EMA(${CONFIG.EMA_FAST_PERIOD}): ${emaResult.emaFast.toFixed(5)} | EMA(${CONFIG.EMA_SLOW_PERIOD}): ${emaResult.emaSlow.toFixed(5)} | Fast ${emaResult.isAbove ? 'ABOVE ▲' : 'BELOW ▼'} Slow${crossTag}`
                    );
                } else {
                    const needed = CONFIG.EMA_SLOW_PERIOD + 1;
                    LOGGER.debug(
                        `${symbol} ⏳ EMA not ready — ${assetState.closedCandles.length}/${needed} candles`
                    );
                }

                // TRIGGER TRADE ANALYSIS FOR THIS SPECIFIC ASSET
                assetState.canTrade = true;
                bot.executeNextTrade(symbol, closedCandle);
            }
        }

        assetState.currentFormingCandle = incomingCandle;

        const candles = assetState.candles;
        const existingIndex = candles.findIndex(
            c => c.open_time === incomingCandle.open_time
        );
        if (existingIndex >= 0) {
            candles[existingIndex] = incomingCandle;
        } else {
            candles.push(incomingCandle);
        }

        if (candles.length > assetConfig.MAX_CANDLES_STORED) {
            assetState.candles = candles.slice(
                -assetConfig.MAX_CANDLES_STORED
            );
        }
    }

    handleCandlesHistory(response) {
        if (response.error) {
            LOGGER.error(
                `Error fetching candles: ${response.error.message}`
            );
            return;
        }

        const symbol = response.echo_req.ticks_history;
        if (!state.assets[symbol]) return;

        const assetConfig = getAssetConfig(symbol);
        const granularity = assetConfig.GRANULARITY;

        const candles = response.candles.map(c => {
            const openTime =
                Math.floor(
                    (c.epoch - granularity) / granularity
                ) * granularity;
            return {
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close),
                epoch: c.epoch,
                open_time: openTime
            };
        });

        if (candles.length === 0) {
            LOGGER.warn(`${symbol}: No historical candles received`);
            return;
        }

        state.assets[symbol].candles = [...candles];
        state.assets[symbol].closedCandles = [...candles];

        const lastCandle = candles[candles.length - 1];
        state.assets[symbol].lastProcessedCandleOpenTime =
            lastCandle.open_time;
        state.assets[symbol].currentFormingCandle = null;

        // Calculate initial EMA values from historical candles
        const emaResult = TechnicalIndicators.getEMACrossoverSignal(candles);
        state.assets[symbol].lastEmaFast = emaResult.emaFast;
        state.assets[symbol].lastEmaSlow = emaResult.emaSlow;
        state.assets[symbol].prevEmaFast = emaResult.prevEmaFast;
        state.assets[symbol].prevEmaSlow = emaResult.prevEmaSlow;
        state.assets[symbol].lastEmaSignal = emaResult.signal;
        state.assets[symbol].lastEmaIsAbove = emaResult.isAbove;

        LOGGER.info(
            `📊 Loaded ${candles.length} ${assetConfig.TIMEFRAME_LABEL} candles for ${symbol}`
        );

        if (emaResult.emaFast !== null && emaResult.emaSlow !== null) {
            const crossLabel = emaResult.signal ? ` ← ${emaResult.signal}` : '';
            LOGGER.info(
                `   📈 EMA(${CONFIG.EMA_FAST_PERIOD}): ${emaResult.emaFast.toFixed(5)} | EMA(${CONFIG.EMA_SLOW_PERIOD}): ${emaResult.emaSlow.toFixed(5)} | Fast ${emaResult.isAbove ? 'ABOVE' : 'BELOW'} Slow${crossLabel}`
            );
        } else {
            const needed = CONFIG.EMA_SLOW_PERIOD + 1;
            LOGGER.warn(
                `   ⏳ Insufficient candles for EMA(${CONFIG.EMA_SLOW_PERIOD}) — have ${candles.length}, need ≥ ${needed}. Waiting for more data...`
            );
        }
    }

    onError(error) {
        LOGGER.error(`WebSocket error: ${error.message}`);
    }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;

        this.stopPing();
        StatePersistence.saveState();

        if (this.isReconnecting) {
            LOGGER.info('Already handling disconnect, skipping...');
            return;
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.isReconnecting = true;
            this.reconnectAttempts++;
            const delay = Math.min(
                this.reconnectDelay *
                Math.pow(1.5, this.reconnectAttempts - 1),
                30000
            );

            LOGGER.info(
                `🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
            );
            LOGGER.info(
                `📊 Preserved state - Trades: ${state.session.tradesCount}, P&L: $${state.session.netPL.toFixed(2)}`
            );

            TelegramService.sendMessage(
                `⚠️ <b>CONNECTION LOST - RECONNECTING</b>\n📊 Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n⏱️ Retrying in ${(delay / 1000).toFixed(1)}s\n💾 State preserved: ${state.session.tradesCount} trades, $${state.session.netPL.toFixed(2)} P&L`
            );

            setTimeout(() => {
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            TelegramService.sendMessage(
                `🛑 <b>BOT STOPPED</b>\nMax reconnection attempts reached.\nFinal P&L: $${state.session.netPL.toFixed(2)}`
            );
            process.exit(1);
        }
    }

    startPing() {
        this.pingInterval = setInterval(() => {
            if (state.isConnected) {
                this.send({ ping: 1 });
            }
        }, 30000);
    }

    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
    }

    send(data) {
        if (!state.isConnected) {
            LOGGER.error('Cannot send: Not connected');
            return null;
        }

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
    }

    async start() {
        console.log('\n' + '═'.repeat(80));
        console.log(
            ' DERIV RISE/FALL EMA CROSSOVER BOT (Per-Asset Independent Management)'
        );
        console.log('═'.repeat(80));
        console.log(`💰 Initial Capital: $${state.capital}`);
        console.log(`📊 Active Assets: ${ACTIVE_ASSETS.join(', ')}`);
        console.log(`💵 Base Stake: $${CONFIG.STAKE} (per asset)`);
        console.log(`🕯️ Asset Configurations:`);
        ACTIVE_ASSETS.forEach(symbol => {
            const ac = getAssetConfig(symbol);
            console.log(`   ${symbol}: ${ac.TIMEFRAME_LABEL} candles (${ac.GRANULARITY}s), Duration: ${ac.DURATION}${ac.DURATION_UNIT}, Max Candles: ${ac.MAX_CANDLES_STORED}`);
        });
        console.log(
            `🎯 Session Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`
        );
        console.log(
            `📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ENABLED' : 'DISABLED'}`
        );
        console.log(
            `🔄 Max Positions Per Asset: ${CONFIG.MAX_OPEN_POSITIONS_PER_ASSET}`
        );
        console.log(
            `📈 EMA Fast Period: ${CONFIG.EMA_FAST_PERIOD} | EMA Slow Period: ${CONFIG.EMA_SLOW_PERIOD}`
        );
        console.log(
            `🕐 Trading Sessions: ${CONFIG.USE_TRADING_SESSIONS ? 'ENABLED (session windows apply)' : 'DISABLED (trading 24/7)'}`
        );

        // Display trade history info
        const overall = TradeHistoryManager.getOverallStats();
        const totalDays = TradeHistoryManager.getAllDays().length;
        console.log('─'.repeat(80));
        console.log(`📚 TRADE HISTORY:`);
        console.log(`   Trading Days: ${totalDays}`);
        console.log(`   Total Trades: ${overall.tradesCount}`);
        console.log(`   Overall P/L: $${overall.netPL.toFixed(2)}`);
        console.log(`   Period: ${overall.firstTradeDate || 'N/A'} to ${overall.lastTradeDate || 'N/A'}`);

        console.log('─'.repeat(80));
        console.log(`🕐 TRADING WINDOWS (GMT+1):`);
        console.log(
            `   JY TOKYO Session:   ${String(CONFIG.TOKYO_START).padStart(2, '0')}:00 - ${String(CONFIG.TOKYO_END).padStart(2, '0')}:00`
        );
        console.log(
            `   🇬🇧 London Session:   ${String(CONFIG.LONDON_START).padStart(2, '0')}:00 - ${String(CONFIG.LONDON_END).padStart(2, '0')}:00`
        );
        console.log(
            `   🇺🇸 New York Session: ${String(CONFIG.NEWYORK_START).padStart(2, '0')}:00 - ${String(CONFIG.NEWYORK_END).padStart(2, '0')}:00`
        );
        console.log(
            `   AU Sedney Session: ${String(CONFIG.SYDNEY_START).padStart(2, '0')}:00 - ${String(CONFIG.SYDNEY_END).padStart(2, '0')}:00`
        );
        console.log(
            `   📊 Current Status: ${TradingSessionManager.getSessionStatusString()}`
        );
        console.log('═'.repeat(80));
        console.log(
            '📋 Strategy: EMA Crossover + Per-Asset Recovery System'
        );
        console.log(
            `    📈 EMA Fast (${CONFIG.EMA_FAST_PERIOD}) crosses ABOVE EMA Slow (${CONFIG.EMA_SLOW_PERIOD}) → RISE`
        );
        console.log(
            `    📉 EMA Fast (${CONFIG.EMA_FAST_PERIOD}) crosses BELOW EMA Slow (${CONFIG.EMA_SLOW_PERIOD}) → FALL`
        );
        console.log(
            '    🔄 Recovery: Each asset has its own martingale chain'
        );
        console.log(
            '    🕐 Signal detected on every candle close (EMA recalculated)'
        );
        console.log(
            '    🎯 Each asset manages its own stake, direction & recovery independently'
        );
        console.log(
            '    📚 Trade history persisted across days'
        );
        console.log('═'.repeat(80) + '\n');

        // Initialize current trade day
        state.currentTradeDay = TradeHistoryManager.getDateKey();
        TradeHistoryManager.ensureDayEntry(state.currentTradeDay);
        if (!tradeHistory.dailyHistory[state.currentTradeDay].startCapital ||
            tradeHistory.dailyHistory[state.currentTradeDay].startCapital === 0) {
            tradeHistory.dailyHistory[state.currentTradeDay].startCapital = state.capital;
        }

        this.connection.initializeAssets();

        ACTIVE_ASSETS.forEach(symbol => {
            this.subscribeToCandles(symbol);
        });

        TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();

        this.startSessionTimeChecker();

        LOGGER.info('✅ Bot started successfully! (Per-Asset Independent Mode)');
    }

    subscribeToCandles(symbol) {
        const assetConfig = getAssetConfig(symbol);
        LOGGER.info(
            `📊 Subscribing to ${assetConfig.TIMEFRAME_LABEL} candles for ${symbol} (granularity: ${assetConfig.GRANULARITY}s)...`
        );

        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: assetConfig.CANDLES_TO_LOAD,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: assetConfig.GRANULARITY
        });

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

    /**
     * =========================================================
     * TRADE EXECUTION — PER-ASSET EMA CROSSOVER LOGIC
     * =========================================================
     */
    executeNextTrade(symbol, lastClosedCandle) {
        const assetState = state.assets[symbol];
        if (!assetState) return;
        if (!assetState.canTrade) return;
        if (!SessionManager.isSessionActive()) return;

        const assetConfig = getAssetConfig(symbol);

        // Check per-asset position limit
        if (
            assetState.activePositions.length >=
            CONFIG.MAX_OPEN_POSITIONS_PER_ASSET
        ) {
            LOGGER.debug(
                `${symbol} ⏳ Max positions reached (${assetState.activePositions.length}/${CONFIG.MAX_OPEN_POSITIONS_PER_ASSET})`
            );
            return;
        }

        // =============================================
        // TRADING SESSION TIME CHECK
        // Only enforced for new signals, never for recovery
        // Skipped entirely when USE_TRADING_SESSIONS is false
        // =============================================
        const isInMartingaleRecovery = assetState.martingaleLevel > 0;
        let sessionCheck = { inSession: true, sessionName: '24/7', nextSession: null, minutesUntilNext: 0 };

        if (CONFIG.USE_TRADING_SESSIONS) {
            sessionCheck = TradingSessionManager.isWithinTradingSession();

            if (!sessionCheck.inSession && !isInMartingaleRecovery) {
                const now = Date.now();
                if (now - state.lastSessionLogTime > 300000) {
                    LOGGER.info(
                        `🕐 OUTSIDE TRADING SESSION — ${TradingSessionManager.getSessionStatusString()} | Skipping new EMA signals`
                    );
                    state.lastSessionLogTime = now;
                }
                return;
            }

            if (!sessionCheck.inSession && isInMartingaleRecovery) {
                LOGGER.info(
                    `🔄 [${symbol}] Outside session but IN RECOVERY (Martingale Level: ${assetState.martingaleLevel}) — continuing recovery trade`
                );
            }
        }

        const stake = assetState.currentStake;

        // Capital sufficiency check
        if (state.capital < stake) {
            LOGGER.error(
                `[${symbol}] Insufficient capital for stake: $${state.capital.toFixed(2)} (Needed: $${stake.toFixed(2)})`
            );
            if (assetState.martingaleLevel > 0) {
                LOGGER.info(
                    `[${symbol}] Resetting Martingale level due to insufficient capital.`
                );
                assetState.martingaleLevel = 0;
                assetState.currentStake = CONFIG.STAKE;
            }
            return;
        }

        // =============================================
        // DETERMINE TRADE DIRECTION (per-asset logic)
        // =============================================
        let direction = null;
        let signalReason = '';

        const isRecoveryMode = assetState.lastTradeWasWin === false;

        if (isRecoveryMode) {
            // ── RECOVERY MODE: alternate direction from the previous losing trade ──
            if (assetState.lastTradeDirection === 'CALLE') {
                direction = 'PUTE';
                signalReason = `Recovery (${symbol} Prev LOSS on RISE → now FALL)`;
            } else {
                direction = 'CALLE';
                signalReason = `Recovery (${symbol} Prev LOSS on FALL → now RISE)`;
            }
            LOGGER.trade(`🔄 [${symbol}] RECOVERY MODE: ${signalReason}`);

        } else {
            // ── NORMAL MODE: EMA crossover signal ─────────────────────────────
            const emaFast = assetState.lastEmaFast;
            const emaSlow = assetState.lastEmaSlow;
            const emaSignal = assetState.lastEmaSignal;

            // Guard: wait until we have enough candles for EMA calculation
            if (emaFast === null || emaSlow === null) {
                const needed = CONFIG.EMA_SLOW_PERIOD + 1;
                LOGGER.info(
                    `${symbol} ⏳ Waiting for EMA data — ${assetState.closedCandles.length}/${needed} candles loaded`
                );
                return;
            }

            if (emaSignal === 'BULL_CROSS') {
                // Fast EMA crossed ABOVE slow EMA → RISE signal
                // Guard: don't re-trade the same cross that was already acted on
                if (assetState.lastCrossSignalDirection === 'CALLE') {
                    LOGGER.debug(
                        `${symbol} ⏭️ BULL CROSS already traded — waiting for the next cross`
                    );
                } else {
                    direction = 'CALLE';
                    signalReason = `BULL CROSS — EMA(${CONFIG.EMA_FAST_PERIOD}) ${emaFast.toFixed(5)} crossed ABOVE EMA(${CONFIG.EMA_SLOW_PERIOD}) ${emaSlow.toFixed(5)}`;
                }
            } else if (emaSignal === 'BEAR_CROSS') {
                // Fast EMA crossed BELOW slow EMA → FALL signal
                if (assetState.lastCrossSignalDirection === 'PUTE') {
                    LOGGER.debug(
                        `${symbol} ⏭️ BEAR CROSS already traded — waiting for the next cross`
                    );
                } else {
                    direction = 'PUTE';
                    signalReason = `BEAR CROSS — EMA(${CONFIG.EMA_FAST_PERIOD}) ${emaFast.toFixed(5)} crossed BELOW EMA(${CONFIG.EMA_SLOW_PERIOD}) ${emaSlow.toFixed(5)}`;
                }
            } else {
                LOGGER.info(
                    `${symbol} ⏸️ No EMA cross — EMA(${CONFIG.EMA_FAST_PERIOD}): ${emaFast.toFixed(5)} | EMA(${CONFIG.EMA_SLOW_PERIOD}): ${emaSlow.toFixed(5)} | Fast ${assetState.lastEmaIsAbove ? 'ABOVE ▲' : 'BELOW ▼'} Slow`
                );
            }

            if (direction) {
                LOGGER.trade(`⚡ [${symbol}] EMA SIGNAL: ${signalReason}`);
            }
        }

        StatePersistence.saveState();

        if (!direction) {
            return;
        }

        // =============================================
        // EXECUTE TRADE FOR THIS ASSET
        // =============================================
        assetState.canTrade = false;
        assetState.lastTradeDirection = direction;

        const sessionLabel = CONFIG.USE_TRADING_SESSIONS
            ? (sessionCheck.inSession
                ? `[${sessionCheck.sessionName}]`
                : `[RECOVERY - Outside Session]`)
            : '[24/7]';

        LOGGER.trade(
            `🎯 ${sessionLabel} [${symbol}] Executing ${direction === 'CALLE' ? 'RISE' : 'FALL'} trade`
        );
        LOGGER.trade(
            `   [${symbol}] Stake: $${stake.toFixed(2)} | Duration: ${assetConfig.DURATION} ${assetConfig.DURATION_UNIT} | Martingale Level: ${assetState.martingaleLevel}`
        );
        LOGGER.trade(`   [${symbol}] Reason: ${signalReason}`);
        LOGGER.trade(
            `   [${symbol}] EMA(${CONFIG.EMA_FAST_PERIOD}): ${assetState.lastEmaFast !== null ? assetState.lastEmaFast.toFixed(5) : 'N/A'} | EMA(${CONFIG.EMA_SLOW_PERIOD}): ${assetState.lastEmaSlow !== null ? assetState.lastEmaSlow.toFixed(5) : 'N/A'} | Close: ${lastClosedCandle.close.toFixed(5)}`
        );
        LOGGER.trade(
            `   [${symbol}] Asset Stats: ${assetState.tradesCount} trades, ${assetState.winsCount}W/${assetState.lossesCount}L, P/L: $${assetState.netPL.toFixed(2)}`
        );

        const position = {
            symbol: symbol,
            direction,
            stake,
            duration: assetConfig.DURATION,
            durationUnit: assetConfig.DURATION_UNIT,
            entryTime: Date.now(),
            contractId: null,
            reqId: null,
            currentProfit: 0,
            buyPrice: 0
        };

        // Add position to THIS asset's positions
        assetState.activePositions.push(position);

        const tradeRequest = {
            buy: 1,
            subscribe: 1,
            price: stake.toFixed(2),
            parameters: {
                contract_type: direction,
                symbol: symbol,
                currency: 'USD',
                amount: stake.toFixed(2),
                duration: assetConfig.DURATION,
                duration_unit: assetConfig.DURATION_UNIT,
                basis: 'stake'
            }
        };

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;

        // Mark this cross direction as traded (prevents re-trading on the same cross)
        if (!isRecoveryMode) {
            assetState.lastCrossSignalDirection = direction;
            LOGGER.info(
                `${symbol} ✅ EMA cross direction '${direction}' marked as traded — will not re-trade until next cross`
            );
        }
    }

    stop() {
        LOGGER.info('🛑 Stopping bot...');
        // Disable trading on all assets
        ACTIVE_ASSETS.forEach(symbol => {
            const asset = state.assets[symbol];
            if (asset) {
                asset.canTrade = false;
            }
        });

        // Save final state and history
        StatePersistence.saveState();
        TradeHistoryManager.saveHistory();

        setTimeout(() => {
            if (this.connection.ws) this.connection.ws.close();
            LOGGER.info('👋 Bot stopped');
        }, 2000);
    }

    /**
     * Session time checker
     */
    startSessionTimeChecker() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(
                now.getTime() + 1 * 60 * 60 * 1000
            );
            const currentDay = gmtPlus1Time.getUTCDay();
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Check for day change
            SessionManager.checkDayChange();

            // Weekend check
            // const isWeekend =
            //     currentDay === 0 ||
            //     (currentDay === 6 && currentHours >= 23) ||
            //     (currentDay === 1 && currentHours < 2);

            // if (isWeekend) {
            //     if (state.session.isActive) {
            //         LOGGER.info(
            //             'Weekend trading suspension. Disconnecting...'
            //         );
            //         TelegramService.sendHourlySummary();
            //         if (this.connection.ws)
            //             this.connection.ws.close();
            //         state.session.isActive = false;
            //     }
            //     return;
            // }

            // Daily reconnection at 1:00 AM GMT+1 (to catch TOKYO session start)
            if (
                !state.session.isActive &&
                currentHours === 1 &&
                currentMinutes >= 0
            ) {
                LOGGER.info(
                    "It's 1:00 AM GMT+1, reconnecting the bot and resetting daily session stats."
                );
                // No longer call resetDailyStats — day change is handled by checkDayChange
                state.session.isActive = true;
                this.connection.connect();
            }

            // End-of-day disconnect: After New York session ends,
            // only if ALL assets have their last trade as a win (no recovery needed)
            if (state.session.isActive) {
                const allAssetsRecovered = ACTIVE_ASSETS.every(symbol => {
                    const asset = state.assets[symbol];
                    return asset && asset.martingaleLevel === 0;
                });

                const anyAssetTradedWin = ACTIVE_ASSETS.some(symbol => {
                    const asset = state.assets[symbol];
                    return asset && asset.lastTradeWasWin === true;
                });

                if (
                    allAssetsRecovered &&
                    anyAssetTradedWin &&
                    currentHours >= CONFIG.SYDNEY_END &&
                    currentMinutes >= 30
                ) {
                    LOGGER.info(
                        `It's past ${CONFIG.SYDNEY_END}:30 GMT+1, all assets recovered, disconnecting.`
                    );
                    // Send end-of-day summary
                    TelegramService.sendDayEndSummary(TradeHistoryManager.getDateKey());
                    // TelegramService.sendHourlySummary();
                    if (this.connection.ws)
                        this.connection.ws.close();
                    state.session.isActive = false;
                }
            }
        }, 20000);
    }

    checkTimeForDisconnectReconnect() {
        this.startSessionTimeChecker();
    }

    resetDailyStats() {
        // This method now delegates to SessionManager for new-day reset
        SessionManager.resetSessionForNewDay();
    }

    getStatus() {
        const sessionStats = SessionManager.getSessionStats();
        const tradingSession = TradingSessionManager.getSessionStatusString();
        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();

        // Build per-asset status
        const assetStatuses = {};
        ACTIVE_ASSETS.forEach(symbol => {
            const a = state.assets[symbol];
            const ac = getAssetConfig(symbol);
            if (a) {
                const nextDir =
                    a.lastTradeWasWin === null
                        ? 'Waiting for EMA cross signal'
                        : a.lastTradeWasWin
                            ? 'Waiting for EMA crossover'
                            : a.lastTradeDirection === 'CALLE'
                                ? 'PUTE (Recovery)'
                                : 'CALLE (Recovery)';

                assetStatuses[symbol] = {
                    martingaleLevel: a.martingaleLevel,
                    currentStake: a.currentStake,
                    lastDirection: a.lastTradeDirection,
                    lastWasWin: a.lastTradeWasWin,
                    nextDirection: nextDir,
                    activePositions: a.activePositions.length,
                    trades: a.tradesCount,
                    wins: a.winsCount,
                    losses: a.lossesCount,
                    netPL: a.netPL,
                    emaFast: a.lastEmaFast,
                    emaSlow: a.lastEmaSlow,
                    emaIsAbove: a.lastEmaIsAbove,
                    emaSignal: a.lastEmaSignal,
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
            capital: state.capital,
            accountBalance: state.accountBalance,
            session: sessionStats,
            tradingSession: tradingSession,
            totalActivePositions: totalActivePositions,
            assets: assetStatuses,
            overall: overall,
            today: today
        };
    }
}

// ============================================
// INITIALIZATION
// ============================================

// Load trade history first (before bot initialization)
tradeHistory = TradeHistoryManager.loadHistory();

const bot = new DerivBot();

process.on('SIGINT', () => {
    console.log('\n\n⚠️ Shutdown signal received...');
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

const stateLoaded = StatePersistence.loadState();

if (stateLoaded) {
    LOGGER.info('🔄 Bot will resume from saved state after connection');
} else {
    LOGGER.info('🆕 Bot will start with fresh state');
}

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═'.repeat(80));
    console.log(
        ' DERIV RISE/FALL EMA CROSSOVER BOT (Per-Asset Independent)'
    );
    console.log('═'.repeat(80));
    console.log('\n⚠️ API Token not configured!\n');
    console.log('Usage:');
    console.log(
        ' API_TOKEN=xxx DURATION=5 DURATION_UNIT=t node risefall-bot.js'
    );
    console.log('\nEnvironment Variables:');
    console.log(' API_TOKEN - Deriv API token (required)');
    console.log(' CAPITAL - Initial capital (default: 1000)');
    console.log(' STAKE - Stake per trade (default: 1)');
    console.log(' DURATION - Contract duration (default: 1)');
    console.log(
        ' DURATION_UNIT - t=ticks, s=seconds, m=minutes (default: t)'
    );
    console.log(' PROFIT_TARGET - Session profit target (default: 1000)');
    console.log(' STOP_LOSS - Session stop loss (default: -500)');
    console.log(' TELEGRAM_ENABLED - Enable Telegram (default: false)');
    console.log(' TELEGRAM_BOT_TOKEN - Telegram bot token');
    console.log(' TELEGRAM_CHAT_ID - Telegram chat ID');
    console.log('═'.repeat(80));
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(
    ' DERIV RISE/FALL EMA CROSSOVER BOT (Per-Asset Independent)'
);
console.log(
    ` Base Stake: $${CONFIG.STAKE} | EMA(${CONFIG.EMA_FAST_PERIOD}) / EMA(${CONFIG.EMA_SLOW_PERIOD}) | Sessions: ${CONFIG.USE_TRADING_SESSIONS ? 'ON' : 'OFF (24/7)'}`
);
// console.log(
//     ` 🕐 London: ${CONFIG.LONDON_START}:00-${CONFIG.LONDON_END}:00 | New York: ${CONFIG.NEWYORK_START}:00-${CONFIG.NEWYORK_END}:00 (GMT+1)`
// );
console.log('═'.repeat(80));
console.log('\n🚀 Initializing EMA Crossover Bot (Per-Asset Independent Mode)...\n');

bot.connection.connect();

// Status display every 30 seconds
setInterval(() => {
    if (state.isAuthorized) {
        const status = bot.getStatus();
        const s = state.session;
        const overall = status.overall;

        // Per-asset status line
        let assetLines = '';
        ACTIVE_ASSETS.forEach(sym => {
            const a = status.assets[sym];
            if (a) {
                const dir = a.lastDirection
                    ? (a.lastDirection === 'CALLE' ? 'R' : 'F')
                    : '-';
                const winLoss = a.lastWasWin === null
                    ? '-'
                    : a.lastWasWin ? 'W' : 'L';
                assetLines += `\n   ${sym} (${a.timeframe}/${a.duration}): M${a.martingaleLevel} $${a.currentStake.toFixed(2)} | ${a.trades}t ${a.wins}W/${a.losses}L | P/L:$${a.netPL.toFixed(2)} | Last:${dir}(${winLoss}) | Pos:${a.activePositions} | EMA${CONFIG.EMA_FAST_PERIOD}:${a.emaFast !== null ? a.emaFast.toFixed(4) : '---'} ${a.emaIsAbove ? '▲' : a.emaIsAbove === false ? '▼' : '-'} EMA${CONFIG.EMA_SLOW_PERIOD}:${a.emaSlow !== null ? a.emaSlow.toFixed(4) : '---'}`;
            }
        });

        console.log(
            `\n📊 ${getGMTTime()} | Today: ${status.session.trades} trades | ${status.session.winRate} | $${status.session.netPL.toFixed(2)} | ${status.totalActivePositions} active`
        );
        console.log(
            `📈 Overall: ${overall.tradesCount} trades | ${overall.winsCount}W/${overall.lossesCount}L | P/L: $${overall.netPL.toFixed(2)} | Days: ${TradeHistoryManager.getAllDays().length}`
        );
        console.log(
            `📉 Today Loss Stats: x2:${s.x2Losses} x3:${s.x3Losses} x4:${s.x4Losses} x5:${s.x5Losses} x6:${s.x6Losses} x7:${s.x7Losses} x8:${s.x8Losses} x9:${s.x9Losses}`
        );
        console.log(`🔧 Per-Asset Status:${assetLines}`);
        console.log(`🕐 ${status.tradingSession}`);
    }
}, 30000);
