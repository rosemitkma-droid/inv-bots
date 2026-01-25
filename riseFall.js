const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'risefall-state0001.json');
const STATE_SAVE_INTERVAL = 5000; // Save every 5 seconds

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
                    dailyLosses: state.portfolio.dailyLosses,
                    activePositions: state.portfolio.activePositions.map(pos => ({
                        symbol: pos.symbol,
                        direction: pos.direction,
                        stake: pos.stake,
                        duration: pos.duration,
                        durationUnit: pos.durationUnit,
                        entryTime: pos.entryTime,
                        contractId: pos.contractId,
                        buyPrice: pos.buyPrice,
                        currentProfit: pos.currentProfit
                    }))
                },
                lastTradeDirection: state.lastTradeDirection,
                martingaleLevel: state.martingaleLevel,
                hourlyStats: { ...state.hourlyStats }
            };

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

            // Only restore if state is less than 30 minutes old
            if (ageMinutes > 30) {
                LOGGER.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            LOGGER.info(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);

            // Restore capital and session
            state.capital = savedData.capital;
            state.session = {
                ...state.session,
                ...savedData.session,
                startTime: savedData.session.startTime || Date.now(),
                startCapital: savedData.session.startCapital || savedData.capital
            };

            // Restore portfolio
            state.portfolio.dailyProfit = savedData.portfolio.dailyProfit;
            state.portfolio.dailyLoss = savedData.portfolio.dailyLoss;
            state.portfolio.dailyWins = savedData.portfolio.dailyWins;
            state.portfolio.dailyLosses = savedData.portfolio.dailyLosses;

            // Restore active positions
            state.portfolio.activePositions = (savedData.portfolio.activePositions || []).map(pos => ({
                ...pos,
                entryTime: pos.entryTime || Date.now()
            }));

            // Restore last trade direction
            state.lastTradeDirection = savedData.lastTradeDirection || null;
            state.martingaleLevel = savedData.martingaleLevel || 0;
            state.hourlyStats = savedData.hourlyStats || {
                trades: 0,
                wins: 0,
                losses: 0,
                pnl: 0,
                lastHour: new Date().getHours()
            };

            LOGGER.info(`✅ State restored successfully!`);
            LOGGER.info(`   🎯 Trades: ${state.session.tradesCount} (W:${state.session.winsCount} L:${state.session.lossesCount})`);
            LOGGER.info(`   � Loss Stats: x2:${state.session.x2Losses} x3:${state.session.x3Losses} x4:${state.session.x4Losses} x5:${state.session.x5Losses} x6:${state.session.x6Losses} x7:${state.session.x7Losses}`);
            LOGGER.info(`   🚀 Active Positions: ${state.portfolio.activePositions.length}`);
            LOGGER.info(`   🔄 Last Direction: ${state.lastTradeDirection || 'None'}`);
            LOGGER.info(`   📈 Martingale Level: ${state.martingaleLevel}`);

            return true;
        } catch (error) {
            LOGGER.error(`Failed to load state: ${error.message}`);
            return false;
        }
    }

    static startAutoSave() {
        setInterval(() => {
            if (state.isAuthorized) {
                this.saveState();
            }
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
    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED) return;
        try {
            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const data = JSON.stringify({
                chat_id: CONFIG.TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            });

            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': data.length
                }
            };

            return new Promise((resolve, reject) => {
                const req = https.request(url, options, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            resolve(true);
                        } else {
                            reject(new Error(body));
                        }
                    });
                });
                req.on('error', (error) => {
                    reject(error);
                });
                req.write(data);
                req.end();
            });
        } catch (error) {
            LOGGER.error(`Failed to send Telegram message: ${error.message}`);
        }
    }

    static async sendTradeAlert(type, symbol, direction, stake, duration, durationUnit, details = {}) {
        const emoji = type === 'OPEN' ? '🚀' : (type === 'WIN' ? '✅' : '❌');
        const stats = SessionManager.getSessionStats();
        const message = `
            ${emoji} <b>${type} TRADE ALERT</b>
            Asset: ${symbol}
            Direction: ${direction}
            Stake: $${stake.toFixed(2)}
            Duration: ${duration} (${durationUnit == 't' ? 'Ticks' : durationUnit == 's' ? 'Seconds' : 'Minutes'})
            Martingale Level: ${state.martingaleLevel}
            ${details.profit !== undefined ? `Profit: $${details.profit.toFixed(2)}
            Total P&L: $${state.session.netPL.toFixed(2)}
            Wins: ${state.session.winsCount}/${state.session.lossesCount}
            Win Rate: ${stats.winRate}%
            ` : ''}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendSessionSummary() {
        const stats = SessionManager.getSessionStats();
        const message = `
            📊 <b>SESSION SUMMARY</b>
            Duration: ${stats.duration}
            Trades: ${stats.trades}
            Wins: ${stats.wins} | Losses: ${stats.losses}
            Win Rate: ${stats.winRate}
            Loss Stats: x2:${stats.x2Losses} | x3:${stats.x3Losses} | x4:${stats.x4Losses} | x5:${stats.x5Losses} | x6:${stats.x6Losses} | x7:${stats.x7Losses}
            Net P/L: $${stats.netPL.toFixed(2)}
            Current Capital: $${state.capital.toFixed(2)}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendStartupMessage() {
        const message = `
            🤖 <b>DERIV RISE/FALL BOT STARTED</b>
            Strategy: Alternating Rise/Fall
            Capital: $${CONFIG.INITIAL_CAPITAL}
            Stake: $${CONFIG.STAKE}
            Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT}
            Assets: ${ACTIVE_ASSETS.join(', ')}
            Session Target: $${CONFIG.SESSION_PROFIT_TARGET}
            Stop Loss: $${CONFIG.SESSION_STOP_LOSS}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendHourlySummary() {
        // FIX #1: Capture stats snapshot BEFORE resetting
        const statsSnapshot = { ...state.hourlyStats };

        // FIX #2: Only send if there are trades to report
        if (statsSnapshot.trades === 0) {
            LOGGER.info('📱 Telegram: Skipping hourly summary (no trades this hour)');
            return;
        }

        const totalTrades = statsSnapshot.wins + statsSnapshot.losses;
        const winRate = totalTrades > 0
            ? ((statsSnapshot.wins / totalTrades) * 100).toFixed(1)
            : 0;
        const pnlEmoji = statsSnapshot.pnl >= 0 ? '🟢' : '🔴';
        const pnlStr = (statsSnapshot.pnl >= 0 ? '+' : '') + '$' + statsSnapshot.pnl.toFixed(2);

        const message = `
            ⏰ <b>Rise/Fall Bot Hourly Summary</b>

            📊 <b>Last Hour</b>
            ├ Trades: ${statsSnapshot.trades}
            ├ Wins: ${statsSnapshot.wins} | Losses: ${statsSnapshot.losses}
            ├ Win Rate: ${winRate}%
            └ ${pnlEmoji} <b>P&L:</b> ${pnlStr}

            📈 <b>Daily Totals</b>
            ├ Total Trades: ${state.session.tradesCount}
            ├ Total W/L: ${state.session.winsCount}/${state.session.lossesCount}
            ├ Daily P&L: ${(state.session.netPL >= 0 ? '+' : '')}$${state.session.netPL.toFixed(2)}
            └ Current Capital: $${state.capital.toFixed(2)}

            ⏰ ${new Date().toLocaleString()}
        `.trim();

        try {
            await this.sendMessage(message);
            LOGGER.info('📱 Telegram: Hourly Summary sent');
            LOGGER.info(`   📊 Hour Stats: ${statsSnapshot.trades} trades, ${statsSnapshot.wins}W/${statsSnapshot.losses}L, ${pnlStr}`);
        } catch (error) {
            LOGGER.error(`❌ Telegram hourly summary failed: ${error.message}`);
        }

        // FIX #3: Reset stats AFTER successful send
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
            }, 60 * 60 * 1000); // Every hour
        }, timeUntilNextHour);
    }
}

// ============================================
// LOGGER UTILITY
// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';

const LOGGER = {
    info: (msg) => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: (msg) => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: (msg) => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); }
};

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // API Settings
    API_TOKEN: '0P94g4WdSrSrzir',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Capital Settings
    INITIAL_CAPITAL: 100,
    STAKE: 0.35,

    // Session Targets
    SESSION_PROFIT_TARGET: 10000,
    SESSION_STOP_LOSS: -85,

    // Trade Duration Settings
    DURATION: 5,
    DURATION_UNIT: 'm', // t=ticks, s=seconds, m=minutes

    // Trade Settings
    MAX_OPEN_POSITIONS: 1, // One at a time for alternating strategy
    TRADE_DELAY: 1000, // 2 seconds delay between trades
    MARTINGALE_MULTIPLIER: 2,
    MAX_MARTINGALE_STEPS: 8,

    // Debug
    DEBUG_MODE: true,

    // Telegram Settings
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8591937854:AAESyF-8b17sRK-xdQXzrHfALnKA1sAR3CI',
    TELEGRAM_CHAT_ID: '752497117',
};


let ACTIVE_ASSETS = ['R_100'];

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
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
        dailyLosses: 0,
        activePositions: []
    },
    lastTradeDirection: null, // 'CALL' or 'PUT'
    martingaleLevel: 0,
    hourlyStats: {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        lastHour: new Date().getHours()
    },
    requestId: 1,
    canTrade: false
};

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
            LOGGER.trade(`🎯 SESSION PROFIT TARGET REACHED! Net P/L: $${netPL.toFixed(2)}`);
            this.endSession('PROFIT_TARGET');
            return true;
        }

        if (netPL <= CONFIG.SESSION_STOP_LOSS || state.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS) {
            LOGGER.error(`🛑 SESSION STOP LOSS REACHED! Net P/L: $${netPL.toFixed(2)}`);
            this.endSession('STOP_LOSS');
            return true;
        }

        return false;
    }

    static async endSession(reason) {
        state.session.isActive = false;
        LOGGER.info(`⏸️ Session ended (${reason}).`);
        TelegramService.sendSessionSummary();
        state.canTrade = false;
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
            x2Losses: state.session.x2Losses,
            x3Losses: state.session.x3Losses,
            x4Losses: state.session.x4Losses,
            x5Losses: state.session.x5Losses,
            x6Losses: state.session.x6Losses,
            x7Losses: state.session.x7Losses,
            netPL: state.session.netPL
        };
    }

    static recordTradeResult(profit, direction) {
        // FIX #6: Check if hour has changed (in case timer missed)
        const currentHour = new Date().getHours();
        if (currentHour !== state.hourlyStats.lastHour) {
            LOGGER.warn(`⏰ Hour changed detected (${state.hourlyStats.lastHour} → ${currentHour}), resetting hourly stats`);
            state.hourlyStats = {
                trades: 0,
                wins: 0,
                losses: 0,
                pnl: 0,
                lastHour: currentHour
            };
        }

        state.session.tradesCount++;
        state.capital += profit;

        // Update hourly stats
        state.hourlyStats.trades++;
        state.hourlyStats.pnl += profit;

        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            state.martingaleLevel = 0;
            state.hourlyStats.wins++;

            LOGGER.trade(`✅ WIN: +$${profit.toFixed(2)} | Direction: ${direction} | Martingale Reset`);
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            state.hourlyStats.losses++;
            state.martingaleLevel++;

            if (state.martingaleLevel === 2) state.session.x2Losses++;
            if (state.martingaleLevel === 3) state.session.x3Losses++;
            if (state.martingaleLevel === 4) state.session.x4Losses++;
            if (state.martingaleLevel === 5) state.session.x5Losses++;
            if (state.martingaleLevel === 6) state.session.x6Losses++;
            if (state.martingaleLevel === 7) state.session.x7Losses++;

            if (state.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS) {
                LOGGER.warn(`⚠️ Maximum Martingale step reached (${CONFIG.MAX_MARTINGALE_STEPS}), resetting level to 0`);
                state.martingaleLevel = 0;
            } else {
                LOGGER.trade(`❌ LOSS: -$${Math.abs(profit).toFixed(2)} | Direction: ${direction} | Next Martingale Level: ${state.martingaleLevel}`);
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
    }

    connect() {
        LOGGER.info('🔌 Connecting to Deriv API...');
        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);

        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', (data) => this.onMessage(data));
        this.ws.on('error', (error) => this.onError(error));
        this.ws.on('close', () => this.onClose());

        return this.ws;
    }

    onOpen() {
        LOGGER.info('✅ Connected to Deriv API');
        state.isConnected = true;
        this.reconnectAttempts = 0;

        this.startPing();

        if (!this.autoSaveStarted) {
            // StatePersistence.startAutoSave();
            // this.autoSaveStarted = true;
        }

        this.send({ authorize: CONFIG.API_TOKEN });
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
                LOGGER.error(`Authorization failed: ${response.error.message}`);
                return;
            }
            LOGGER.info('🔐 Authorized successfully');
            LOGGER.info(`👤 Account: ${response.authorize.loginid}`);
            LOGGER.info(`💰 Balance: ${response.authorize.balance} ${response.authorize.currency}`);

            state.isAuthorized = true;
            state.accountBalance = response.authorize.balance;

            if (state.capital === CONFIG.INITIAL_CAPITAL) {
                state.capital = response.authorize.balance;
            }

            this.send({ balance: 1, subscribe: 1 });

            bot.start();
        }

        if (response.msg_type === 'balance') {
            state.accountBalance = response.balance.balance;
        }

        if (response.msg_type === 'buy') {
            this.handleBuyResponse(response);
        }

        if (response.msg_type === 'proposal_open_contract') {
            this.handleOpenContract(response);
        }
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);

            // Remove failed position
            const reqId = response.echo_req?.req_id;
            if (reqId) {
                const posIndex = state.portfolio.activePositions.findIndex(p => p.reqId === reqId);
                if (posIndex >= 0) {
                    state.portfolio.activePositions.splice(posIndex, 1);
                }
            }

            // Allow next trade after delay
            setTimeout(() => {
                state.canTrade = true;
                bot.executeNextTrade();
            }, CONFIG.TRADE_DELAY);

            return;
        }

        const contract = response.buy;
        LOGGER.trade(`✅ Position opened: Contract ${contract.contract_id}, Buy Price: $${contract.buy_price}`);

        const reqId = response.echo_req.req_id;
        const position = state.portfolio.activePositions.find(p => p.reqId === reqId);

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

        // Subscribe to contract updates
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
        const posIndex = state.portfolio.activePositions.findIndex(
            p => p.contractId === contractId
        );

        if (posIndex < 0) return;

        const position = state.portfolio.activePositions[posIndex];
        position.currentProfit = contract.profit;

        // Contract closed
        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
            const profit = contract.profit;

            LOGGER.trade(`Contract ${contractId} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`);

            SessionManager.recordTradeResult(profit, position.direction);

            TelegramService.sendTradeAlert(
                profit >= 0 ? 'WIN' : 'LOSS',
                position.symbol,
                position.direction,
                position.stake,
                position.duration,
                position.durationUnit,
                { profit }
            );

            state.portfolio.activePositions.splice(posIndex, 1);

            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }

            SessionManager.checkSessionTargets();
            // StatePersistence.saveState();

            // Schedule next trade
            setTimeout(() => {
                state.canTrade = true;
                bot.executeNextTrade();
            }, CONFIG.TRADE_DELAY);
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
        // StatePersistence.saveState();

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

            TelegramService.sendMessage(`⚠️ <b>CONNECTION LOST</b>\nReconnecting... (attempt ${this.reconnectAttempts})`);

            setTimeout(() => this.connect(), delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            TelegramService.sendMessage(`🛑 <b>BOT STOPPED</b>\nMax reconnection attempts reached.`);
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
        console.log(' DERIV RISE/FALL ALTERNATING BOT');
        console.log('═'.repeat(80));
        console.log(`💰 Initial Capital: $${state.capital}`);
        console.log(`📊 Active Assets: ${ACTIVE_ASSETS.join(', ')}`);
        console.log(`💵 Stake: $${CONFIG.STAKE}`);
        console.log(`⏱️ Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT}`);
        console.log(`🎯 Session Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`);
        console.log(`📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ENABLED' : 'DISABLED'}`);
        console.log('═'.repeat(80));
        console.log('📋 Strategy: Alternating Rise/Fall trades');
        console.log('═'.repeat(80) + '\n');

        TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();

        // Wait a bit then start trading
        setTimeout(() => {
            state.canTrade = true;
            this.executeNextTrade();
        }, 1000);

        LOGGER.info('✅ Bot started successfully!');
    }

    executeNextTrade() {
        if (!state.canTrade) return;
        if (!SessionManager.isSessionActive()) return;
        if (state.portfolio.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) return;

        const stake = CONFIG.STAKE * Math.pow(CONFIG.MARTINGALE_MULTIPLIER, state.martingaleLevel);
        const symbol = ACTIVE_ASSETS[0];

        if (state.capital < stake) {
            LOGGER.error(`Insufficient capital for stake: $${state.capital.toFixed(2)} (Needed: $${stake.toFixed(2)})`);
            if (state.martingaleLevel > 0) {
                LOGGER.info('Resetting Martingale level due to insufficient capital.');
                state.martingaleLevel = 0;
            }
            return;
        }

        // Determine next direction (alternate)
        let direction;
        if (state.lastTradeDirection === null) {
            // First trade - start with CALL (Rise)
            direction = 'CALL';
        } else if (state.lastTradeDirection === 'CALL') {
            direction = 'PUT';
        } else {
            direction = 'CALL';
        }

        state.canTrade = false; // Prevent multiple trades
        state.lastTradeDirection = direction;

        LOGGER.trade(`🎯 Executing ${direction === 'CALL' ? 'RISE' : 'FALL'} trade on ${symbol}`);
        LOGGER.trade(` Stake: $${stake.toFixed(2)} | Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT}`);

        const position = {
            symbol,
            direction,
            stake,
            duration: CONFIG.DURATION,
            durationUnit: CONFIG.DURATION_UNIT,
            entryTime: Date.now(),
            contractId: null,
            reqId: null,
            currentProfit: 0,
            buyPrice: 0
        };

        state.portfolio.activePositions.push(position);

        const tradeRequest = {
            buy: 1,
            subscribe: 1,
            price: stake,
            parameters: {
                contract_type: direction,
                symbol: symbol,
                currency: 'USD',
                amount: stake,
                duration: CONFIG.DURATION,
                duration_unit: CONFIG.DURATION_UNIT,
                basis: 'stake'
            }
        };

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;
    }

    stop() {
        LOGGER.info('🛑 Stopping bot...');
        state.canTrade = false;

        setTimeout(() => {
            if (this.connection.ws) this.connection.ws.close();
            LOGGER.info('👋 Bot stopped');
        }, 2000);
    }

    getStatus() {
        const sessionStats = SessionManager.getSessionStats();

        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            accountBalance: state.accountBalance,
            session: sessionStats,
            lastDirection: state.lastTradeDirection,
            nextDirection: state.lastTradeDirection === 'CALL' ? 'PUT' : 'CALL',
            activePositionsCount: state.portfolio.activePositions.length,
            activePositions: state.portfolio.activePositions.map(pos => ({
                symbol: pos.symbol,
                direction: pos.direction,
                stake: pos.stake,
                duration: `${pos.duration} ${pos.durationUnit}`,
                profit: pos.currentProfit,
                contractId: pos.contractId
            }))
        };
    }
}

// ============================================
// INITIALIZATION
// ============================================
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

// Load saved state
const stateLoaded = StatePersistence.loadState();

if (stateLoaded) {
    LOGGER.info('🔄 Bot will resume from saved state after connection');
} else {
    LOGGER.info('🆕 Bot will start with fresh state');
}

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═'.repeat(80));
    console.log(' DERIV RISE/FALL ALTERNATING BOT');
    console.log('═'.repeat(80));
    console.log('\n⚠️ API Token not configured!\n');
    console.log('Usage:');
    console.log(' API_TOKEN=xxx DURATION=5 DURATION_UNIT=t node risefall-bot.js');
    console.log('\nEnvironment Variables:');
    console.log(' API_TOKEN - Deriv API token (required)');
    console.log(' CAPITAL - Initial capital (default: 1000)');
    console.log(' STAKE - Stake per trade (default: 1)');
    console.log(' DURATION - Contract duration (default: 1)');
    console.log(' DURATION_UNIT - t=ticks, s=seconds, m=minutes (default: t)');
    console.log(' PROFIT_TARGET - Session profit target (default: 1000)');
    console.log(' STOP_LOSS - Session stop loss (default: -500)');
    console.log(' TELEGRAM_ENABLED - Enable Telegram (default: false)');
    console.log(' TELEGRAM_BOT_TOKEN - Telegram bot token');
    console.log(' TELEGRAM_CHAT_ID - Telegram chat ID');
    console.log('═'.repeat(80));
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(' DERIV RISE/FALL ALTERNATING BOT');
console.log(` Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT} | Stake: $${CONFIG.STAKE}`);
console.log('═'.repeat(80));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

// Status display every 30 seconds
setInterval(() => {
    if (state.isAuthorized) {
        const status = bot.getStatus();
        const s = state.session;
        console.log(`\n📊 ${getGMTTime()} | ${status.session.trades} trades | ${status.session.winRate} | $${status.session.netPL.toFixed(2)} | ${status.activePositions.length} active`);
        console.log(`📉 Loss Stats: x2:${s.x2Losses} x3:${s.x3Losses} x4:${s.x4Losses} x5:${s.x5Losses} x6:${s.x6Losses} x7:${s.x7Losses} | Level: ${state.martingaleLevel}`);
    }
}, 30000);
